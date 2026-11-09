// Lane-worker wire protocol: the frames the coordinator and ONE lane worker
// exchange, and the identity rules that make a late or abandoned reply harmless.
//
// WHY THIS MODULE EXISTS
// ----------------------
// In `worker` thread execution a persistent thread (a `ThreadLane`, ../sessions.ts
// ~352) runs its ENTIRE turn - the agent loop, the provider stream handling, and
// every synchronous tool body - on its own OS thread. Nothing crosses as a live
// object, so every frame is structured-cloneable data, and every SHARED mutation is
// a request that the authority answers with a receipt (./lane-commit.ts). The
// worker's replica is therefore a read-mostly context, not a writer of shared state.
//
// IDENTITY RULES
// --------------
//   - `laneEpoch`   - minted by the coordinator every time a lane worker starts
//     serving a thread. Every frame carries it; a frame for a superseded epoch is
//     refused by the journal, which is what makes "the old worker answered anyway"
//     and "the worker crashed mid-frame" safe instead of merely likely-to-be-fine.
//     An `interrupt` ALSO rejects every unanswered `request` of that epoch: the run
//     must not sit waiting for a reply that will never matter.
//   - `turnId`      - the SessionTurn id the coordinator assigned. One worker has at
//     most ONE live turn (a lane is FIFO), so a mismatch is a protocol error.
//   - `seq`         - monotonic per lane for mutation groups. The journal refuses a
//     gap, a duplicate, or a late group, and a lane advances its committed base ONLY
//     from an applied receipt. The terminal `turn-done` carries the `seq` whose state
//     must be durable before the turn may be published as done (T3 finding F8: a
//     `tool_result` event, and the success frame, must never outrun the state that
//     produced them).
//   - `streamSeq` + `ack` - progress events are credit-windowed: the worker's
//     progress hook awaits the coordinator's ack, so a slow SSE consumer paces the
//     run exactly like the inline `await progress(event)` contract instead of
//     buffering a transcript in a worker.
//   - `callId`      - one per worker-initiated request (lease, authority read,
//     owner question). The reply names it; nothing is matched by arrival order.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
//   - No live handles: an AbortSignal or a command `context` object cannot cross, so
//     `action:request` carries the DATA (`requestId`, `request`, the owning ids) and
//     the cancellation is an `interrupt`/epoch event instead (T3 finding F9).
//   - No wholesale state frames: there is no `sync{snapshot}`. A lane receives targeted
//     registry broadcasts, bounded memory windows, id grants, and the DELTA of one
//     conversation's canonical transcript (`sync.transcript` -> a `transcript:sync` request
//     answered with the messages it has not adopted). `hello` is still the ONLY place a full
//     snapshot is shipped, because that is the one moment a rebuild is legitimate.
//   - No leniency for unknown frames: `describeEnvelope` names the offender, since a
//     silently ignored frame shows up later as a mysteriously stuck turn.
//
// Cross-references:
//   - ./lane-commit.ts   - MutationGroup / MutationReceipt and their semantics
//   - ./lane-identity.ts - IdentityLease and the id spaces
//   - ./lane-memory.ts   - MemoryWindow and the CAS digests
//   - ./lane-host.ts     - the coordinator side: spawn, hello, relay, receipts, teardown
//   - ./lane-authority.ts- answers a `request` and commits a `mutation` on the canonical harness
//   - ./lane-worker-loop.ts - the worker side: the message loop and its commit boundaries

import type { HarnessActionRequest, HarnessAttachment, HarnessEvent, HarnessStateChangeEvent } from '../../types';
import type { HarnessPluginSettingsRecord, HarnessPresetRecord } from '../persistence';
import type { RunnerSettings } from '../harnesses/types';
import type { IdentityLease, IdSpace } from './lane-identity';
import type { MemoryWindow } from './lane-memory';
// Type-only: the request union the authority answers (./lane-authority.ts). This module
// must not import a VALUE from it, or the two files would form a runtime cycle.
import type { LaneAuthorityAnswer, LaneAuthorityRequest } from './lane-authority';
import type { GroupOutcome, MutationGroup, MutationReceipt, SharedMutation } from './lane-commit';

// Bumped whenever a frame changes incompatibly. A worker refuses a `hello` whose
// version differs, so a stale `dist/` bundle against a fresh coordinator fails at
// startup with a readable reason instead of mis-parsing frames.
//
// v3 (T10): the receipt contract changed shape (a partial group now rolls EVERY op back),
// `transcript:sync` / `thread:read` requests were added, a transcript delta may be pushed
// to a live lane, a steering refusal is its own non-terminal reply, and a registry
// broadcast carries the installed revision in its own format (`moduleText`) instead of
// pretending every tool is a legacy function body. A v2 worker cannot answer for any of
// that, so it must fail here rather than run a turn whose frames it half-understands.
export const LANE_PROTOCOL_VERSION = 3;

// Un-acked `event` frames a worker may have in flight. Small on purpose: one model
// request's worth of deltas, so a stalled client is felt as backpressure (the inline
// behaviour) rather than as unbounded worker memory.
export const LANE_EVENT_WINDOW = 32;

// Reclaim a lane worker after this much idle time. Always safe: the next turn
// rebuilds the replica from the authority's committed state.
export const LANE_IDLE_MS = 120_000;

// Upper bound on concurrently live lane workers per store (each holds a harness
// replica, so this is the memory guard). Config defaults match these values; the
// cross-layer equality is asserted in ./protocol.test.ts.
export const LANE_MAX_WORKERS = 16;

// Bounded wait for `hello` (import + build + capability report). A worker that never
// answers is a FAILURE, never a silent inline fallback.
export const LANE_HANDSHAKE_MS = 60_000;

// The largest single frame payload we will accept. A tool result is capped at 64 KiB
// by the core (core/result-budget.ts), so a frame carrying one plus its envelope
// stays far below this; the bound exists to fail a runaway payload before it
// exhausts the receiving thread.
export const LANE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

// Everything the worker needs to rebuild THIS session's harness, and nothing else.
// `record` is the durable preset projection; `presetFromRecord` turns it back into the
// executable factory (harnesses/registry.ts ~638), which is the restart path the
// persistence layer already trusts. `snapshot` is the committed core state AT HELLO
// ONLY: it seeds the replica, and it is never re-shipped per commit (T3 finding F10 -
// a `restore()` per commit rebuilds tools and thread agents and zeroes the run
// generation, which is both slow and wrong).
export type LaneBlueprint = {
    record: HarnessPresetRecord;
    settings: RunnerSettings;
    snapshot: unknown;
    // Provider credential for THIS session, sent to the worker process only. The
    // server keeps it off the wire to clients (../config.ts credential rule).
    apiKey?: string;
    // The id-space watermarks at hello, so a replica's counters cannot collide with
    // anything the authority has already used.
    identities: Partial<Record<IdSpace, number>>;
    // The keys this lane's tools may reach into shared memory for (./lane-memory.ts).
    memoryKeys: string[];
    // R3 (the GLOBAL tool switch): the deployment's deny list AS THIS LANE WAS CREATED -
    // the sorted tool names ../tool-settings.ts has switched off for every session.
    //
    // WHY A SNAPSHOT AND NOT A LIVE ANSWER: the coordinator's provider is a closure over
    // the live store, and a closure cannot cross `worker_threads`, so the replica would
    // otherwise declare and launch tools the operator has already switched off (the gap
    // the `plugins.ts` / `tool-settings.ts` "WORKER MODE" headers used to document as a
    // limit). Serialising the SET at lane creation is the same mechanism every other
    // lane-creation value uses (`record`, `settings`, `apiKey`, `memoryKeys` above), and
    // it matches the documented lane semantics: an already-running lane keeps the state it
    // was built with and "picks the new value up the next time its lane is created"
    // (../harness.swagger.yaml, `PATCH /v1/harness/plugins/{plugin_id}`), while a NEW lane
    // - an idle reclaim, a new conversation, an authority rebuild - states the CURRENT set.
    //
    // A disabled name is never UNREGISTERED here: the provider only hides it from a
    // request's tool list, refuses it at the launch gate, and answers discovery with
    // `forbidden` (../harness.ts), exactly as it does inline.
    //
    // ADDITIVE and OPTIONAL: `undefined` means "the coordinator shipped no deny list" (an
    // older blueprint, or a host that never built one), which the worker reads as nothing
    // disabled - the pre-R3 behaviour, byte for byte. That tolerance is why
    // `LANE_PROTOCOL_VERSION` stays where it is: a v3 worker that predates this field simply
    // ignores it, and a v3 coordinator talking to an older bundle gets the older behaviour.
    // Neither side can mis-parse a frame, which is what the version bump exists to catch.
    disabledTools?: string[];
    // R3 (the PLUGIN switches): the operator's per-plugin setting OVERRIDES as of lane
    // creation, in the SAME shape `state.json` stores them (`HarnessPluginSettingsRecord`,
    // plugin name -> key -> JSON scalar; ../persistence.ts). It joins the blueprint for the
    // one reason every other field is here: the store's provider is a closure over a live
    // Map, and a closure cannot cross `worker_threads`.
    //
    // WHAT IT CHANGES: the framework gates every plugin's HOOKS on
    // `settings.boolean('enabled', true)` (src/plugin/host.ts, src/plugin/hooks.ts), and the
    // settings view resolves stored override -> declared default (src/plugin/settings.ts
    // `resolve`). Without the override a replica answers the DECLARED default, so a plugin an
    // operator switched OFF kept running its hooks on every lane - and every numeric/string
    // knob (`contextLimit`, `minTokens`, `intervalMs`, ...) kept its declared default rather
    // than the operator's value. With it, a lane replica sees exactly what the host sees.
    //
    // A SNAPSHOT, with the same documented consequence as `disabledTools`: a lane that is
    // already running keeps the values it was built with, and "picks the new value up the
    // next time its lane is created" (../harness.swagger.yaml, PATCH /v1/harness/plugins/{plugin_id} - the wording this
    // field is what makes true for worker lanes).
    //
    // ADDITIVE and OPTIONAL, same tolerance rule as above: `undefined` or `{}` ("no plugin
    // setting has ever been changed", the pre-R3 document) means the worker installs no
    // provider and the library's declared-default provider answers, byte for byte as before.
    pluginSettings?: HarnessPluginSettingsRecord;
};

// What the worker could actually do once built. A non-empty `unsupported` list makes
// the coordinator fail the HELLO rather than run a turn that would silently lose
// behaviour.
export type LaneCapabilityReport = {
    ok: boolean;
    agents: string[];
    tools: string[];
    unsupported: { code: string; message: string }[];
    // T12 (S7): a feature this replica REFUSES rather than running privately (the nested-run
    // tools). Non-blocking by definition - `ok` stays true - because the refusal is the
    // supported behaviour: the tool is absent from the replica instead of producing a child
    // conversation only that lane could see.
    limitations?: { code: string; message: string }[];
};

// The requests a worker may raise are the authority's own request union
// (./lane-authority.ts `LaneAuthorityRequest`): routed `harness.runtime` operations, id
// leases, memory windows, the one-writer brain claim, an owner question, and the two
// operator invocations (a direct tool call, a slash command). It is a UNION rather than a
// string map so a typo is a compile error here instead of a runtime hang on a request
// nobody answers. Consumers import the union from ./lane-authority.ts; this module only
// embeds it in the frames below.

// What an answered request carries back to the lane: the value the tool returns, plus the
// canonical follow-up state this replica must adopt (the enabled tool set after a discovery
// grant, the registry revision after a create, the identity high-water marks after a lease).
export type LaneRequestReplyValue = {
    value?: unknown;
    sync?: LaneAuthorityAnswer['sync'];
};

// One registry revision, as the authority installed it. The metadata travels with the text
// because a created tool's source is a compiled body: `registerTool` needs
// name/description/tags/parameters to install the same revision at all.
//
// T10 finding M5: `moduleText` and `dependencies` are here because the shipped registration
// format is a MODULE (`HarnessToolSource.format === 'module'`), whose text lives in
// `moduleText`. Broadcasting that text through `source` alone pushed module code into the
// legacy function-body path, and left `source` empty for everything the core itself installed.
// A replica installs whichever form the canonical harness actually compiled.
export type LaneRegistryChange = {
    name: string;
    description?: string;
    tags?: string[];
    parameters?: Record<string, unknown>;
    // The legacy async function-body revision (empty when the tool is a module).
    source: string;
    // The module revision, when the installed tool is one.
    moduleText?: string;
    // Local helper modules captured with the module revision.
    dependencies?: { path: string; text: string }[];
    // Memory keys this revision added to the session window (T10 finding M5): every live
    // lane joins them to its declared set and pulls the digests, so the new tool's memory
    // writes are committable state rather than a silent no-op.
    memoryKeys?: string[];
    revision: string;
    removed: boolean;
};

// ---------------------------------------------------------------------------
// Coordinator -> worker
// ---------------------------------------------------------------------------

export type LaneCommand =
    // First frame: blueprint + capabilities probe. Answered by `hello`.
    | { kind: 'hello'; laneEpoch: number; blueprint: LaneBlueprint }
    // Run one turn in `threadId`. `target` names the conversation the lane owns; the
    // legacy root run passes `{ kind: 'root', agent }` so it isolates the same way
    // (decision D1: worker mode never executes a turn on the coordinator).
    //
    // `reset` mirrors the inline `freshBlock` rule (../sessions.ts ~5696): the coordinator
    // has ALREADY reset its own conversations before shipping this frame, so the replica
    // must reset identically or the two transcripts would diverge at the first append.
    | {
          kind: 'turn';
          laneEpoch: number;
          turnId: string;
          target: { kind: 'thread'; threadId: string } | { kind: 'root'; agent: string };
          prompt: string;
          attachments?: HarnessAttachment[];
          reset?: boolean;
          // The canonical transcript length for THIS conversation at dispatch. The lane
          // appends against the prefix IT has adopted and pulls whatever moved with a
          // `transcript:sync` request; this value is the cross-check that proves the two
          // sides may disagree (a sibling `threadSend` landed between hello and here), which
          // is exactly why length alone was never a sync primitive (T10 finding M4).
          fromLength: number;
          // pipeline T4.1: the digest of that same canonical transcript, so the lane can tell
          // "canonical moved IN PLACE" from "canonical did not move" at the same length — a host
          // transcript edit, or another lane's committed `transcript:patch`, changes the bytes at
          // positions this lane already holds and changes no length, so the check above would
          // call it "nothing moved" and the model would run on a stale context.
          //
          // OPTIONAL in both directions: a worker that predates T4 ignores it, and a worker newer
          // than its coordinator falls back to the length rule (an absent digest is never
          // compared, never guessed). It is the digest of the WHOLE canonical transcript, which is
          // the only scope that is meaningful: the lane compares it exactly when
          // `committedLength === fromLength`, and then the whole transcript IS its prefix.
          fromDigest?: string;
      }
    // One operator action, executed on this lane's CPU (decision D1): a session-bound
    // direct tool call or a slash command. Answered by `invoke.done`. Its shared-state
    // effects still travel as `request` frames, so the canonical harness performs them.
    | { kind: 'invoke'; laneEpoch: number; callId: number; request: LaneAuthorityRequest }
    // Queue guidance for the live run's next safe model boundary. Steering has to go
    // to the thread that OWNS the live run - the replica - because the authority's
    // own copy is never running (T3 finding F9).
    | { kind: 'steer'; laneEpoch: number; turnId: string; input: string }
    // Stop the turn and reject every unanswered request of this epoch.
    | { kind: 'interrupt'; laneEpoch: number; turnId?: string; reason?: string }
    // Answer a `lease:request`.
    | { kind: 'lease.grant'; laneEpoch: number; callId: number; lease?: IdentityLease; error?: string }
    // Answer any other worker request. `sync` carries the canonical follow-up state the
    // replica must adopt (see LaneRequestReplyValue).
    | { kind: 'request.reply'; laneEpoch: number; callId: number; ok: boolean; value?: unknown; sync?: LaneAuthorityAnswer['sync']; error?: string }
    // Result of a mutation group. `outcome.receipts` is what advances the worker's
    // committed base, and only for applied ops.
    | { kind: 'mutation.receipt'; laneEpoch: number; seq: number; outcome: GroupOutcome }
    // Release event credit.
    | { kind: 'event.ack'; laneEpoch: number; streamSeq: number }
    // A tool registered/replaced/removed ANYWHERE in the session (another lane, the
    // operator, a model). Installed in this replica so the next call sees the same
    // definition the authority runs.
    | { kind: 'broadcast.registry'; laneEpoch: number; change: LaneRegistryChange }
    // Refresh of this lane's declared memory window, with digests.
    | { kind: 'sync.memory'; laneEpoch: number; window: MemoryWindow }
    // T10 finding M4: canonical conversation state moved under this lane - a sibling
    // `threadSend` landed in the conversation this lane owns, or another lane appended to it.
    // The frame carries NO payload: the replica's adopted prefix is its own knowledge, so it
    // pulls exactly the delta it is missing with a `transcript:sync` request. A lane that is
    // mid-run may not be able to insert the delta yet (its harness refuses a wholesale
    // transcript write while a run is attached); it then retries at the next commit boundary,
    // which is the safe point. This push is the responsiveness half; the boundary retry is the
    // correctness half.
    | { kind: 'sync.transcript'; laneEpoch: number; threadId: string }
    // Final frame.
    | { kind: 'dispose'; laneEpoch: number; reason?: string };

// ---------------------------------------------------------------------------
// Worker -> coordinator
// ---------------------------------------------------------------------------

export type LaneReply =
    // Handshake result.
    | { kind: 'hello'; laneEpoch: number; version: number; capabilities: LaneCapabilityReport }
    // One progress event, in `streamSeq` order.
    | { kind: 'event'; laneEpoch: number; turnId: string; streamSeq: number; event: HarnessEvent }
    // One mutation group at a commit boundary. `reason` is core's own
    // HarnessStateChangeEvent reason, so the coordinator persists the same boundaries
    // the inline path persisted.
    | {
          kind: 'mutation';
          laneEpoch: number;
          turnId?: string;
          reason: HarnessStateChangeEvent['reason'];
          group: MutationGroup;
      }
    // A request the authority must answer, answered by `request.reply`. Every shared-state
    // operation a lane performs is one of these, so the canonical harness - not the
    // replica - is what changes (./lane-authority.ts).
    | {
          kind: 'request';
          laneEpoch: number;
          callId: number;
          request: LaneAuthorityRequest;
      }
    // The answer to an `invoke` command: a direct tool call or a slash command that this
    // lane executed. `ok: false` carries the readable failure, exactly like the inline
    // path surfaces a tool error to the caller.
    | {
          kind: 'invoke.done';
          laneEpoch: number;
          callId: number;
          ok: boolean;
          value?: unknown;
          error?: string;
      }
    // The turn settled. `terminalSeq` is the last mutation group whose state must be
    // durable before this turn may be published as done (F8).
    | {
          kind: 'turn-done';
          laneEpoch: number;
          turnId: string;
          answer?: string;
          failure?: string;
          cancelled?: boolean;
          invocationId?: string;
          terminalSeq: number;
          // Commits this lane could not get accepted. A turn that produced state the
          // authority refused must never be published as a clean success (T3 finding F8).
          commitFaults?: string[];
      }
    // Confirmation that an interrupt landed.
    | { kind: 'aborted'; laneEpoch: number; turnId?: string }
    // T10 finding M6: the answer to a `steer` frame, and deliberately NOT a fault. A run
    // that is not at a steerable point refused the guidance while the turn itself keeps
    // executing; the retired path sent a `fault`, which the host consumed as the turn's
    // terminal frame, killing a live turn over a piece of advice that did not fit.
    | { kind: 'steer.result'; laneEpoch: number; turnId: string; queued: boolean; reason?: string }
    // A worker-side fault that is not a turn failure (a bad frame, a lost realm).
    | { kind: 'fault'; laneEpoch: number; turnId?: string; message: string };

export type LaneEnvelope = LaneCommand | LaneReply;

// The frame kinds this protocol accepts, in one place so both boundaries validate
// against the same list.
const COMMAND_KINDS = new Set([
    'hello',
    'turn',
    'invoke',
    'steer',
    'interrupt',
    'lease.grant',
    'request.reply',
    'mutation.receipt',
    'event.ack',
    'broadcast.registry',
    'sync.memory',
    'sync.transcript',
    'dispose'
]);

const REPLY_KINDS = new Set([
    'hello',
    'event',
    'mutation',
    'request',
    'invoke.done',
    'turn-done',
    'aborted',
    'steer.result',
    'fault'
]);

export const isLaneCommandKind = (value: unknown): boolean =>
    typeof value === 'string' && COMMAND_KINDS.has(value);

export const isLaneReplyKind = (value: unknown): boolean =>
    typeof value === 'string' && REPLY_KINDS.has(value);

// True for any structurally-plausible frame, checked at BOTH boundaries so a
// hand-edited or mixed-version bundle fails with a named reason.
export const isLaneEnvelope = (value: unknown): value is LaneEnvelope => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { kind?: unknown; laneEpoch?: unknown };

    if (typeof candidate.kind !== 'string') return false;
    if (typeof candidate.laneEpoch !== 'number' || !Number.isInteger(candidate.laneEpoch) || candidate.laneEpoch < 0) return false;

    return isLaneCommandKind(candidate.kind) || isLaneReplyKind(candidate.kind);
};

// The human-readable offender for a rejected frame. Never echoes a whole payload: a
// frame can carry a 64 KiB tool result.
export const describeEnvelope = (value: unknown): string => {
    if (typeof value !== 'object' || value === null) return typeof value;

    const candidate = value as { kind?: unknown; laneEpoch?: unknown };

    return `kind=${JSON.stringify(candidate.kind)} laneEpoch=${JSON.stringify(candidate.laneEpoch)}`;
};

// Monotonic counter factory: `callId`, `streamSeq` and mutation `seq` all start at 1
// so `0` unambiguously means "nothing has been sent yet".
export const createSequence = (from = 1): (() => number) => {
    let current = from - 1;

    return () => {
        current += 1;
        return current;
    };
};

// A frame must survive `postMessage`. Checked on the two frames a worker builds from
// model/tool data (event, mutation) so an unserializable value fails as a named
// protocol fault instead of a silent drop or a structured-clone TypeError deep in the
// event loop.
export const isTransferableFrame = (value: unknown): boolean => {
    try {
        structuredClone(value);

        return true;
    } catch {
        return false;
    }
};

// Byte size of a frame, used only to refuse a runaway payload. `byteLength` returns
// undefined for an un-clonable value, which the caller treats as "reject".
export const frameByteLength = (value: unknown): number | undefined => {
    try {
        return structuredClone(value) === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
        return undefined;
    }
};

// The owner-question payload: DATA only. The runtime's `context` carries live
// references and the run's signal, neither of which crosses, so the request is
// narrowed to what a client can answer (F9).
export type LaneActionRequestFrame = {
    callId: number;
    laneEpoch: number;
    requestId: string;
    threadId?: string;
    agent: string;
    request: HarnessActionRequest;
};

// Identity, memory, and commit types are imported above for the frames and are NOT
// re-exported here: ./index.ts star-exports their declaring modules, and a second spelling
// of the same name through two barrels is what makes an import ambiguous to resolve.
