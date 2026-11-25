// Result references shared by the server and the browser client.
//
// A "block" is ONE agent invocation inside a submitted turn: the turn's root
// invocation (the ENTRY agent's flow — routing, not authority) or a nested invocation
// identified by the runtime's `HarnessThread.id`, whatever RANK that agent holds. Blocks
// are structural: every rank — 'A' through 'Z' — produces them exactly the same way, so
// nothing in this module branches on authority (the label rules below are rank-blind).
// The UI renders each block with a compact label
// (`IT1`, `RH2`, … — first+last letter of the agent id plus its occurrence, see
// ui/agent-label.ts). Occurrence numbering is CONVERSATION-scoped: it continues
// across the session's turns in recorded order, so two distinct invocations of the
// same agent never share a label (`RR1`/`RR2`), even across turns.
//
// ONE SEQUENCE (T14/R8-R10): a PERSISTENT conversation has a stable label of its
// own (`RR4`, `IT1`) that every run/continuation in it repeats, and that number is
// RESERVED in this same per-code sequence when the block is projected (see
// `createBlock`). A legacy `/messages` turn (no conversation) and a threadless
// nested block draw from that sequence too, so a conversation label, a legacy root
// and a nested child can never share one text label.
//
// ONLY OWNERS DRAW (F6, 2026-11-25): a block whose run can never BE a durable
// conversation — a threadFork branch, or a `delegate` placeholder whose child never
// started — consumes NOTHING from that sequence and displays `UNADDRESSABLE_BLOCK_LABEL`
// (`T?`) instead of an ordinal, because a label is an ADDRESS
// (../core/thread.ts `resolveThreadAddressOf`) and a minted number no conversation
// answers to both leaves a gap the user reads as a broken label and can collide with a
// real name. A minted number is additionally skipped when this SAME record already
// shows it for a conversation, so one turn can never print one address twice.
//
// A user can type `#IT1` in a NEW prompt to reference the completed result of a
// prior block. The reference is resolved against the SERVER's recorded turns (not
// the live agent transcript), and the completed `done` content is appended to the
// run prompt inside a clearly delimited section. This module is the one definition
// of:
//   - the label allocator (same deterministic rules the UI uses),
//   - the block projection from recorded `HarnessEvent`s,
//   - label-token parsing from a typed prompt,
//   - structural validation of a persisted/submitted reference list,
//   - the delimited prompt composition.
//
// It is isomorphic (types only + pure functions), so `src/shared/index.ts` can
// re-export it to both the Node server and the browser frontend. The frontend's
// existing `ui/agent-label.ts` still owns its DOM allocation; it can adopt
// `createAgentLabels` from here without changing its public behaviour.
//
// Cross-references:
//   - ../server/protocol.ts        — SessionTurn.references / SubmitTaskRequest
//   - ../server/sessions.ts        — binds references at enqueue, expands at execution
//   - ../server/persistence.ts     — validates persisted references through here
//   - ../frontend/ui/agent-label.ts — the UI allocator whose rules this mirrors
//   - ../frontend/ui/turns.ts      — the block projection this mirrors

import type { HarnessEvent } from '../harness';
// (T3, the lone-surrogate defect) The pair-safe clip, from the leaf both the tools and
// the transport use, so one pairing rule governs every cut in the package. This module
// is isomorphic (server, UI, and a worker can all load it), and `../util` is the leaf
// that survives all three.
import { clipPrefix } from '../util';
// The invocation-RUN key (W19, 2026-11-17). A block is ONE invocation RUN: the id the runtime stamps on
// `thread.id` is a per-process counter, so two runs in one recorded turn can legitimately share it, and a
// block keyed by the bare id merges them and labels the pair with one conversation's name. The key rule is
// the store's own (`../server/sessions.ts` builds the label join with it), and this module is isomorphic,
// so the leaf import below is the only form all three layers can share.
import { invocationRunKeyOf } from './run-identity';

// One reference a client submits with a task (or the server derives from a typed
// `#LABEL`). `threadId` omitted means the ROOT block of `turnId`; a nested block
// names the runtime thread id recorded on its events.
export type AgentResultReference = {
    turnId: string;
    threadId?: string;
    // Normalised display label, e.g. `IT1`. Uppercase two letters (the fallback
    // `AG`) followed by the occurrence; occurrences are conversation-scoped (they
    // continue across the session's turns), so a label identifies one block.
    label: string;
};

// Status of one block. `queued` is included because a turn can be recorded before
// execution (the queue) and the UI may want to list it; a block only exists once
// the turn has events, which normally means it is running or terminal.
export type AgentResultStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

// One listable block. This is the descriptor the frontend/UI needs for a result
// picker, and the shape the server resolves a reference against.
export type AgentResultBlock = {
    turnId: string;
    // Absent for the root invocation. A nested invocation carries its CURRENT
    // identity: the runtime `thread.id` once known, otherwise the UI's stable
    // synthetic key (`call:<callId>` for a pending delegation, `inline:<agent>`
    // for a threadless legacy stream). Lookups also accept aliases the block used
    // earlier (e.g. `call:<callId>` after adoption).
    threadId?: string;
    // The block's compact display label (`IT1`), or `UNADDRESSABLE_BLOCK_LABEL` (`T?`) when
    // the run owns no addressable identity (a threadFork branch, a delegation whose child
    // never started). Only a label matching `AGENT_REFERENCE_LABEL_PATTERN` can be bound as a
    // reference or resolved by `findAgentResultBlock`; the fallback is display-only, and the
    // run's real id stays on `threadId`.
    label: string;
    // The agent id that produced the block (never displayed raw by the UI).
    agent: string;
    status: AgentResultStatus;
    // The terminal `done` assistant content, present only for a `done` block that
    // actually recorded one. A failed/cancelled block has no usable content.
    content?: string;
};

// The minimal turn shape the helpers need. `SessionTurn` is structurally
// assignable, so the server and frontend can pass their recorded turns directly.
export type AgentResultTurn = {
    id: string;
    status: AgentResultStatus;
    events: readonly HarnessEvent[];
    // R6 deletion: the conversation-scoped label counters AT THE START of this
    // turn (code -> last occurrence), as recorded when the turn was created (see
    // `collectAgentLabelCounters`). Optional because a legacy turn (and every
    // record persisted before threads) has none; such a turn simply continues the
    // chained allocator, which is the pre-deletion behaviour.
    //
    // WHY: occurrence numbering normally continues from every EARLIER turn, so
    // deleting a thread (and its turns) would renumber the surviving blocks
    // (`RR2` becoming `RR1`) and break a typed `#LABEL`. Seeding the allocator from
    // the recorded start state keeps a surviving turn's labels stable, and
    // `seed()` never lowers a counter, so a normal (undeleted) prefix is unaffected.
    labels?: Readonly<Record<string, number>>;
    // R8: the stable display label of the PERSISTENT conversation this turn ran
    // in (`RR2`, `IT1`). The root block adopts it instead of minting a new
    // occurrence, so a continuation turn repeats the conversation's label instead
    // of consuming another number; the adopted number is still RESERVED in the
    // per-code sequence (T14), so no nested block can be minted with it. Optional:
    // a legacy turn has none and falls back to the conversation-scoped allocator.
    threadLabel?: string;
    // R8: runtime invocation id → its conversation's display label, for nested
    // blocks. A delegated child's events carry an invocation id; a reference must
    // name the CHILD CONVERSATION (`RR5`), not a fresh per-run number. Optional
    // because a legacy record carries no roster join.
    //
    // W19 (2026-11-17): the map is keyed by INVOCATION RUN (`id\0epoch`, or the bare id when the record
    // names no epoch) — ../server/sessions.ts `invocationThreadLabels` hands out exactly that view, the
    // same key space the display fold uses. A consumer resolves the frame's own run key first and only
    // then the bare id, so a pre-epoch entry stays reachable while two runs of one recycled id can no
    // longer claim each other's label.
    threadLabels?: Readonly<Record<string, string>>;
};

// One block plus the content to inject, as composed into a run prompt.
export type AgentResultContentEntry = {
    block: AgentResultBlock;
    content: string;
};

// A reference whose target produced NOTHING to reuse: it ended non-`done` (a stop,
// a cancel, a failure), or its turn/conversation disappeared while the requesting
// turn waited for it. The composer injects this NOTE as the section body instead of
// result content, in the same delimited block, so the run keeps the full reference
// context it was accepted with and the assistant can tell the user what happened AND
// still answer. The server never fails the requesting turn over a dead target: only
// the target is gone, not the request.
export type AgentResultNoteEntry = {
    // The label the user typed / the reference bound — always present, even when the
    // target block itself is gone (a deleted conversation has no block left to name).
    label: string;
    note: string;
};

// Either kind of section the composer can emit.
export type AgentResultSection = AgentResultContentEntry | AgentResultNoteEntry;

// Section header marker for a note: it replaces the `agent … | turn …` locator, which
// is meaningless once there is no block to locate. Exported so tests pin the exact
// wire prompt without re-typing the literal.
export const REFERENCED_RESULTS_NO_RESULT_MARKER = 'no result available';

// The note text for a target that reached a terminal status without a result
// (`cancelled` from a stop, `error` from a failure). `status` is the SERVER's own
// word for how that turn ended, so the model repeats the truth rather than a guess.
export const referencedResultUnavailableNote = (label: string, status: string): string =>
    `#${label} ended as ${status} and left no result to reuse. That part of the request cannot be answered from it: tell the user what happened to #${label}, then answer the rest of the request as normal.`;

// The note text for a target that is simply GONE: its conversation was deleted while
// this request waited for it (or before it could read the recorded block).
export const referencedResultDeletedNote = (label: string): string =>
    `#${label} is gone: its conversation was deleted before it produced a result, so there is no result to reuse. Tell the user that #${label} was deleted, then answer the rest of the request as normal.`;

// Bounds. A submission may reference at most this many blocks; each block's
// injected content is truncated to the per-block bound; and the WHOLE composed
// run prompt (raw prompt + wrappers + content + truncation notices) is capped at
// MAX_REFERENCE_TOTAL_CHARS, the same ceiling as a raw prompt. Truncation is
// EXPLICIT (a visible marker), never a silent loss of text.
export const MAX_AGENT_REFERENCES = 16;
export const MAX_REFERENCE_CONTENT_CHARS = 100_000;
export const MAX_REFERENCE_TOTAL_CHARS = 200_000;

// A valid block label: exactly two ASCII LETTERS (the allocator's first+last
// letter, or `AG` for a name with no ASCII letters) plus the conversation-scoped
// occurrence count. Digits inside an agent id are ignored by the allocator, so
// every emitted label satisfies this grammar; it also keeps a typed issue number
// (`#1234`) from looking like a reference.
export const AGENT_REFERENCE_LABEL_PATTERN = /^[A-Z]{2}\d+$/;

// Delimiters of the injected context. Exported so tests and clients can assert
// the exact wire prompt without re-typing the literal.
export const REFERENCED_RESULTS_HEADER = '[referenced results - read-only context for this request]';
export const REFERENCED_RESULTS_FOOTER = '[end referenced results]';

// Exact rejection text when the raw prompt + section wrappers + content cannot be
// made to fit the combined budget. The composer never truncates the USER prompt.
export const REFERENCED_RESULTS_BUDGET_MESSAGE = `The referenced results cannot fit within the ${MAX_REFERENCE_TOTAL_CHARS}-character combined prompt limit.`;

// Normalise one typed/persisted label. Returns undefined when it is not a label
// this system can produce, so callers reject rather than "guess" a near match.
export const normalizeAgentLabel = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    // Accept the composer's typed spelling (`#it1`) as well as a bare label.
    const label = value.trim().replace(/^#/, '').trim().toUpperCase();
    return AGENT_REFERENCE_LABEL_PATTERN.test(label) ? label : undefined;
};

// A parsed compact label: the normalised text, its two-letter code, and its
// occurrence ordinal. `AGENT_REFERENCE_LABEL_PATTERN` alone accepts `RR0`; an
// ordinal is a COUNT, so it is validated as a POSITIVE integer here. Callers use
// this both to validate a persisted/authoritative label (persistence) and to
// reserve its number in an allocator (the block projection), which is why the
// canonical text is returned with the parts.
export type AgentLabelParts = {
    label: string;
    code: string;
    ordinal: number;
};

export const agentLabelParts = (value: unknown): AgentLabelParts | undefined => {
    const label = normalizeAgentLabel(value);
    if (label === undefined) return undefined;

    // `normalizeAgentLabel` guarantees two letters followed by at least one digit.
    const ordinal = Number(label.slice(2));
    if (!Number.isInteger(ordinal) || ordinal < 1) return undefined;

    return { label, code: label.slice(0, 2), ordinal };
};

// F6 (2026-11-25) — the honest identity of a block that owns NO addressable label.
//
// A block label is an ADDRESS, not a caption. `../core/thread.ts` `resolveThreadAddressOf`
// matches a `<CODE><ordinal>` exactly and REFUSES an ambiguous one, and every door that
// resolves a typed `#LABEL` (`normalizeAgentLabel` → `AGENT_REFERENCE_LABEL_PATTERN`,
// `findAgentResultBlock`, `findLatestAgentResultBlock`, `readAgentResultReferenceList`)
// accepts that grammar and nothing else. So a run that can never become a durable
// conversation must not be shown a fabricated ordinal:
//   - a threadFork BRANCH run (`../core/branch.ts` `createBranchId` mints `branch-N`, no
//     conversation record is persisted for it, and the store's run→conversation join never
//     holds it — ../../server/sessions.ts `liveThreadLabel`: "A branch invocation is never
//     in the join map");
//   - a `delegate` PLACEHOLDER whose child never started (the parent made the call and the
//     record holds no child frames at all).
// Measured on the operator's own session (Temp/fix-f3/replay-after.out, session
// e513eed7): the block projection minted `IT13 IT14 IT15 IT16 IT17 IT18 IT19 WE12` for
// exactly those runs, plus a SECOND `RR9` for a threadless block while `thread-57` owns
// `RR9`, and the durable `IT` high-water sat at 20 with only IT1-IT8, IT12 and IT20 owned.
// Those are the user's "IT13, IT15 … have no label, some are empty in total".
//
// WHY THIS TEXT: `T?` is the codebase's declared token for "identity not known" — the
// frontend's `ui/threads.ts` `UNKNOWN_THREAD_LABEL` retires a thread row for the same
// reason stated there (../frontend/ui/threads.ts:395, the loadscript client's roster strip):
// "a retired id consumes NO per-agent ordinal and
// cannot renumber a live conversation's name". Reusing the existing token keeps ONE unknown
// shape across the roster strip, the transcript badge and the block descriptor instead of
// inventing a second one. It deliberately fails `[A-Z]{2}\d+`, so it can never be parsed into
// `AgentLabelParts`, never be bound as a reference, and never collide with a real name; the
// block still carries its real id (`branch-N`, `call:<callId>`, `inline:<agent>`) for the UI
// and for the engine's id-addressed doors (`threadRead`/`agentResult` take the id).
export const UNADDRESSABLE_BLOCK_LABEL = 'T?';

// Canonical identity used by the allocator: trimmed + lower-cased (identical to
// `agentKeyOf` in ../frontend/ui/agent-color.ts).
const agentKeyOf = (agent: string | undefined): string => (agent ?? '').trim().toLowerCase();

// First + last ASCII LETTER of the normalised id, uppercased. Digits and all other
// glyphs are ignored, so a digit in a name can never break the `[A-Z]{2}\d+` label
// grammar. A one-letter id yields the same letter twice (`a` → `AA`); an id with
// no ASCII letters falls back to `AG`. This is intentionally ASCII-only: a
// non-Latin name cannot produce a stable two-letter code, so it shares the
// neutral fallback sequence (the real agent id stays available on the block).
const FALLBACK_CODE = 'AG';
const ASCII_LETTER = /[a-z]/;
const codeOf = (key: string): string => {
    const letters = Array.from(key).filter((glyph) => ASCII_LETTER.test(glyph));
    if (letters.length === 0) return FALLBACK_CODE;

    return `${letters[0]}${letters[letters.length - 1]}`.toUpperCase();
};

// The bare two-letter code WITHOUT the occurrence number. The compact agent
// selector uses this in its small-width label, so the display title `Researcher`
// reads `RR`. It applies the SAME first+last-ASCII-letter convention as the thread
// badges, but it is NOT the same input: transcript labels key on the agent ID, so
// the built-in `research` profile's badge is `RH1` (research -> RH), not `RR1`.
// Passing the title here is deliberate: the user-facing abbreviation follows the
// name they see. Same normalization and fallback (`AG`) as `codeOf`.
export const agentCodeOf = (agent: string | undefined): string => codeOf(agentKeyOf(agent));

export type AgentLabels = {
    next: (agent: string | undefined) => string;
    reset: () => void;
    // Continue an EXISTING sequence: raise every per-code occurrence to at least
    // the seeded value. Seeding never lowers a counter, so a late seed cannot
    // renumber a label an allocator already minted. Used to continue numbering
    // across turns (a new tile seeds from the previous tiles' allocations).
    seed: (counters: ReadonlyMap<string, number>) => void;
    // Snapshot of the per-code occurrence counters (code -> last used number),
    // detached so a caller can seed a later allocator without aliasing this one.
    counters: () => Map<string, number>;
};

// Shared label allocator. SEMANTICS (conversation-scoped as of the duplicate-label
// fix; the per-code rules are frozen from T7):
//   - the code is the first+last ASCII LETTER (or `AG`);
//   - occurrence numbering is keyed by that TWO-LETTER CODE, not by the full agent
//     name, so id collisions share one sequence (`research` → `RH1`, `rhesearch`
//     → `RH2`) instead of silently producing duplicate labels;
//   - `next()` is called once per invocation (never per event) and `reset()` starts
//     a fresh sequence. An explicit conversation label does not call `next()` but
//     still reserves its ordinal (see `blocksOfTurn`'s `createBlock`);
//   - `seed()` CONTINUES a sequence. The reference namespace is the whole
//     conversation (typed `#LABEL` resolves across turns), so the UI seeds each
//     turn's allocator from the turns before it and the projection chains one
//     allocator over the turn list. Two distinct threads of one agent therefore
//     read `RR1`/`RR2` instead of both restarting at `RR1`.
export const createAgentLabels = (initial?: ReadonlyMap<string, number>): AgentLabels => {
    const occurrences = new Map<string, number>();

    const adopt = (counters: ReadonlyMap<string, number>): void => {
        for (const [code, used] of counters) {
            if (used > (occurrences.get(code) ?? 0)) occurrences.set(code, used);
        }
    };

    if (initial !== undefined) adopt(initial);

    return {
        next(agent: string | undefined): string {
            const code = codeOf(agentKeyOf(agent));
            const occurrence = (occurrences.get(code) ?? 0) + 1;
            occurrences.set(code, occurrence);

            return `${code}${occurrence}`;
        },

        reset(): void {
            occurrences.clear();
        },

        seed(counters: ReadonlyMap<string, number>): void {
            adopt(counters);
        },

        counters(): Map<string, number> {
            return new Map(occurrences);
        }
    };
};

// One invocation while a turn is being replayed. The mutable fields mirror what
// the UI derives from the same events; the exported block is a detached copy.
type ReplayBlock = {
    agent: string;
    label: string;
    // The identity a UI descriptor would carry RIGHT NOW: the runtime `thread.id`
    // once known, otherwise the stable synthetic key (`call:<callId>` for a
    // pending delegation, `inline:<agent>` for a threadless legacy block).
    threadId: string | undefined;
    // Set only when the runtime actually named this invocation. Adoption tests
    // this (not `threadId`, which already holds the synthetic alias).
    runtimeThreadId: string | undefined;
    callId: string | undefined;
    // Every identity this block has ever had. A reference bound while the block
    // was pending (`call:<callId>`) still resolves after adoption to `thread.id`.
    aliases: string[];
    started: boolean;
    status: AgentResultStatus;
    terminal: boolean;
    content: string | undefined;
    lastDone: string | undefined;
    // F10 (R10.3): whether `label` is a conversation's OWN address (see `ProjectedBlock`).
    // Set where the label is TAKEN (a join entry, `turn.threadLabel`), never where it is
    // MINTED, so a minted ordinal cannot be mistaken for an owned address later.
    ownsConversation: boolean;
};

// A projected block plus its non-wire fields. Public helpers strip `aliases` and
// `ownsConversation`, but lookups use the aliases so an old stable binding keeps working.
//
// F10 (R10.3) `ownsConversation` is the PROVENANCE of the block's label, not another
// display figure: true only when the label is an ADDRESS a persistent conversation owns
// (the store's run→conversation join named it, or it is the turn's own `threadLabel`).
// `collectAgentLabelCounters` is the one consumer — a label this projection MINTED for a
// run the join never names is an ordinal no conversation answers to, and feeding it into
// the durable per-code high-water is what inflated `WE:12 → WE:16` on the operator's
// session (../server/sessions.ts `mergeLabelHighWater` is raise-only, so every inflated
// number outlives the turn that minted it).
type ProjectedBlock = AgentResultBlock & { aliases: string[]; ownsConversation: boolean };

// Parse `delegate` arguments for the legacy placeholder: a delegation's
// spawning call is the only evidence of the child block when its `thread` metadata
// is absent. Only a complete `{agent, input}` pair is usable.
const delegateOf = (rawArguments: string): { agent: string; input: string } | undefined => {
    try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

        const agent = (parsed as { agent?: unknown }).agent;
        const input = (parsed as { input?: unknown }).input;
        if (typeof agent !== 'string' || agent.length === 0) return undefined;
        if (typeof input !== 'string') return undefined;

        return { agent, input };
    } catch {
        return undefined;
    }
};

// Project ONE recorded turn into its listable blocks.
//
// `labels` is passed in so a caller can CHAIN the allocator across turns: the
// reference namespace is the whole conversation, so occurrence numbers continue
// from the previous turn rather than restarting at 1. A single-turn caller gets a
// fresh allocator (its labels start at 1).
//
// The replay follows the event order the UI uses, because labels depend on it:
//   - the root block is created by the first event routed to it and consumes the
//     first occurrence of the entry agent;
//   - an `delegate` tool_call creates its child placeholder IMMEDIATELY (the
//     label is allocated when the call is seen), and the child `start` ADOPTS that
//     placeholder when it carries the same `callId`;
//   - an explicit `thread` start without a placeholder allocates a block then;
//   - legacy events without `thread` metadata keep one flat `inline:<agent>`
//     block per agent, exactly like the UI's fallback.
//
// Status rules: a `done` with no pending work is terminal; an `error` is terminal;
// a `branch_end` maps completed/failed/cancelled; the parent's `tool_result` for a
// spawning call completes an unstarted/queued child. At the end the TURN status is
// authoritative for the root (and closes children the record left running).
const blocksOfTurn = (
    turn: AgentResultTurn,
    labels: AgentLabels = createAgentLabels()
): ProjectedBlock[] => {
    // Deletion-safe numbering (R6): continue from THIS turn's recorded start
    // counters. `seed` only raises a counter, so a live/undeleted prefix (whose
    // chained allocator is already at or above this state) is unchanged, while a
    // surviving turn whose earlier turns were deleted keeps its original labels.
    if (turn.labels !== undefined) labels.seed(new Map(Object.entries(turn.labels)));

    const blocks: ReplayBlock[] = [];
    const byThread = new Map<string, ReplayBlock>();
    const byCall = new Map<string, ReplayBlock>();
    const byInline = new Map<string, ReplayBlock>();

    let root: ReplayBlock | undefined;
    // The agent recognised as the turn's ENTRY/ROOT flow. Named for ROUTING, not authority:
    // any rank can be the entry, and this value only decides which block is the root one.
    let entryAgent: string | undefined;

    // F6: the conversation labels THIS record shows — the turn's own conversation label plus
    // every join entry one of its own frames can reach. A per-run number minted in this turn
    // may never land on one of those, or the same address prints twice in one turn (the
    // second `RR9` measured beside `thread-57`'s real one). Only this record's labels are
    // claimed: `turn.threadLabels` is a session-wide view, and claiming a name belonging to a
    // conversation of another turn would renumber a block that is already on screen.
    const claimed = new Set<string>();

    const claim = (value: string | undefined): void => {
        const parts = agentLabelParts(value);
        if (parts !== undefined) claimed.add(parts.label);
    };

    claim(turn.threadLabel);

    const join = turn.threadLabels;

    if (join !== undefined) {
        for (const event of turn.events) {
            const frame = (event as { thread?: { id: string; epoch?: string } }).thread;
            if (frame === undefined) continue;

            // The SAME run-then-bare resolution `blockForThread` performs, so the claimed set
            // is exactly the set of labels this projection can actually adopt — no more.
            const runKey = invocationRunKeyOf(frame.id, frame.epoch);

            claim(join[runKey] ?? (runKey === frame.id ? undefined : join[frame.id]));
        }
    }

    // T14: an explicit CONVERSATION label always RESERVES its ordinal in the one per-code
    // sequence, so a nested block of the same code can never be minted the number the
    // conversation already shows. Extracted from `createBlock` because the ADOPTION path needs
    // it too: a placeholder no longer carries a tentative mint of its own, so the reservation
    // cannot piggyback on it any more.
    const reserveConversationLabel = (label: string | undefined): void => {
        if (label === undefined) return;

        const parts = agentLabelParts(label);
        if (parts === undefined) return;

        labels.seed(new Map([[parts.code, parts.ordinal]]));
    };

    // Mint the next ordinal of this agent's code.
    //
    // `provisional` mints are EXEMPT from the collision skip on purpose: a `delegate`
    // placeholder takes a number at the CALL frame (the order the UI allocates in, which is
    // what keeps a chip and the wire prompt agreeing), and hands it back to the join the
    // moment the child's own frame names its conversation. Skipping for a number that is about
    // to be handed back would push the NEXT block's label up one for nothing.
    const mintLabel = (agent: string | undefined, provisional: boolean): string => {
        let label = labels.next(agent);

        if (!provisional) {
            // Bounded by construction: `next` strictly raises this code's ordinal, so the loop
            // can only walk past the at-most-`claimed.size` names that are taken. The guard
            // keeps that argument explicit rather than implicit.
            for (let guard = claimed.size + 1; claimed.has(label) && guard > 0; guard--) {
                label = labels.next(agent);
            }
        }

        return label;
    };

    const createBlock = (
        agent: string,
        threadId: string | undefined,
        callId: string | undefined,
        aliases: string[] = [],
        // R8: an explicit CONVERSATION label. When present it is authoritative and
        // the allocator does not MINT a number for this block (a run, continuation
        // or nested invocation inside one conversation repeats the same label).
        label?: string,
        // F6: how this block gets its identity when no conversation label is recorded.
        options: {
            // false = this run can never own a durable conversation (a threadFork branch),
            // so it consumes NO per-agent ordinal and reads `UNADDRESSABLE_BLOCK_LABEL`.
            reserveLabel?: boolean;
            // true = a `delegate` placeholder's TENTATIVE number, re-named by the join when
            // the child starts (see `mintLabel`).
            provisional?: boolean;
        } = {}
    ): ReplayBlock => {
        // T14: an explicit label still RESERVES its number in the sequence. The
        // projector chains one allocator across the conversation, and a nested
        // block of the same agent code would otherwise be minted the very number
        // the conversation already shows (`RR1` root + `RR1` child). Raising the
        // counter also makes `collectAgentLabelCounters` report conversation labels,
        // so the server's durable counters and this sequence cannot diverge.
        reserveConversationLabel(label);

        const block: ReplayBlock = {
            agent,
            label:
                label ??
                (options.reserveLabel === false
                    ? UNADDRESSABLE_BLOCK_LABEL
                    : mintLabel(agent, options.provisional === true)),
            threadId,
            runtimeThreadId: undefined,
            callId,
            aliases: [...aliases],
            started: threadId !== undefined,
            status: 'running',
            terminal: false,
            content: undefined,
            lastDone: undefined,
            // F10 (R10.3): ONLY an explicit conversation label is an owned address. A number
            // this allocator minted — for a threadless legacy run, a pending `delegate`
            // placeholder, or any run the join never named — is a locally-consistent
            // occurrence, not a conversation's name, and must not raise the durable water.
            ownsConversation: label !== undefined
        };

        blocks.push(block);
        return block;
    };

    const rootBlock = (agent: string): ReplayBlock => {
        if (root !== undefined) return root;

        entryAgent = agent;
        // R8: the root block IS the turn's persistent conversation, so it shows
        // that conversation's label (`RR4`) for every run/continuation in it.
        root = createBlock(agent, undefined, undefined, [], turn.threadLabel);
        root.started = true;
        return root;
    };

    const inlineBlock = (agent: string): ReplayBlock => {
        const existing = byInline.get(agent);
        if (existing !== undefined) return existing;

        // The first flat agent of an unknown stream with no root yet IS the entry
        // agent (the pre-thread UI behaviour).
        if (root === undefined && entryAgent === undefined) return rootBlock(agent);

        // A threadless legacy block keeps the UI's synthetic key, so a descriptor
        // captured from the transcript is a valid reference identity.
        const key = `inline:${agent}`;
        const block = createBlock(agent, key, undefined, [key]);
        block.started = true;
        byInline.set(agent, block);
        return block;
    };

    // Explicit `thread` metadata is authoritative.
    const blockForThread = (event: HarnessEvent): ReplayBlock => {
        const thread = event.thread;
        if (thread === undefined) throw new Error('unreachable: event has no thread');

        // W19 (2026-11-17) — A BLOCK IS ONE RUN, so it is keyed by the run, not by the bare
        // invocation id. The id is a per-process counter (`../shared/run-identity.ts`), and this record
        // can hold two runs wearing it: a child that died before the restart, and the run a restarted
        // process minted the id for afterwards. Keyed by `thread.id`, both folded into ONE block, and the
        // block printed the label of whichever entry the store's join reached first — measured on the
        // operator's document, the block for `15` showed `WE6` (the dead child's conversation) while the
        // post-restart run wearing `15` belongs to `IT4`.
        //
        // The one-sided case merges, never splits, exactly like `../server/turn-projector.ts`
        // `isEpochBoundary` and `../frontend/ui/turns.ts` `runKeyOf` state it: a frame that names no
        // epoch has nothing to discriminate WITH, so it keeps the block the epoch-less frames of the same
        // record already opened. Two KNOWN epochs are the only thing that separates two runs, and a run
        // whose early frames predate the field continues in the block those frames opened.
        const runKey = invocationRunKeyOf(thread.id, thread.epoch);
        const known = byThread.get(runKey) ?? (runKey === thread.id ? undefined : byThread.get(thread.id));

        if (known !== undefined) return known;

        // Adopt a delegation placeholder created by the spawning tool call. The
        // placeholder was visible as `call:<callId>`; after adoption its CURRENT
        // identity is the runtime id, while the call key stays an alias.
        //
        // W19: the conversation label resolves through the SAME run key, with the same bare fallback —
        // `turn.threadLabels` is keyed by run (../server/sessions.ts `invocationThreadLabels`), and the
        // fallback is the door a pre-epoch join entry is reached through.
        const conversationLabel =
            turn.threadLabels?.[runKey] ?? (runKey === thread.id ? undefined : turn.threadLabels?.[thread.id]);

        // F6: a threadFork BRANCH run owns no conversation, so it gets no ordinal. The frame
        // says so directly — `kind: 'fork' | 'autoanswer'` and/or `branchId`
        // (../types/index.ts `HarnessThread`) — and every record that predates those fields
        // still carries the generated `branch-N` invocation id itself
        // (../core/branch.ts:142 `createBranchId`). No conversation record is persisted for a
        // branch and the store's join never names one, so an ordinal minted here is a number
        // NO block ever answers to.
        const isBranchRun =
            thread.branchId !== undefined ||
            thread.kind === 'fork' ||
            thread.kind === 'autoanswer' ||
            thread.id.startsWith('branch-');

        const placeholder = thread.callId === undefined ? undefined : byCall.get(thread.callId);
        if (placeholder !== undefined && placeholder.runtimeThreadId === undefined) {
            placeholder.threadId = thread.id;
            placeholder.runtimeThreadId = thread.id;
            // R8: the child's CONVERSATION label replaces the provisional
            // per-invocation number the spawning call minted.
            if (conversationLabel !== undefined) {
                placeholder.label = conversationLabel;
                // F10 (R10.3): this label is now the CONVERSATION's own address (the store
                // named it), so it is exactly the kind of number the durable high-water must
                // keep. A block that only ever holds a minted number stays `false`.
                placeholder.ownsConversation = true;
                // T14 (F6): the ADOPTING path reserves the number it takes over. It used to be
                // reserved implicitly by the placeholder's own tentative mint landing on the same
                // value; with branch runs and never-started children no longer burning numbers,
                // the seed has to be explicit or a later block could be minted `RR5` twice.
                reserveConversationLabel(conversationLabel);
            } else if (isBranchRun) {
                // A branch frame that adopted a placeholder is the same live-only run: the
                // tentative number goes back.
                placeholder.label = UNADDRESSABLE_BLOCK_LABEL;
            }
            byThread.set(runKey, placeholder);
            placeholder.started = true;
            return placeholder;
        }

        const block = createBlock(event.agent, thread.id, thread.callId, [], conversationLabel, {
            reserveLabel: !isBranchRun
        });
        block.runtimeThreadId = thread.id;
        byThread.set(runKey, block);
        return block;
    };

    // Legacy routing (no `thread` metadata), mirroring ui/turns.ts entryForLegacy.
    const blockForLegacy = (event: HarnessEvent): ReplayBlock => {
        if (root !== undefined && event.agent === root.agent) return root;

        if (event.type === 'start') {
            // Oldest unstarted delegation placeholder for this agent is adopted by
            // a threadless child start (the UI keeps its call key in that case).
            for (const block of blocks) {
                if (block.started || block.callId === undefined) continue;
                if (block.runtimeThreadId !== undefined) continue;
                if (block.agent !== event.agent) continue;
                block.started = true;
                return block;
            }

            return inlineBlock(event.agent);
        }

        let found: ReplayBlock | undefined;
        let count = 0;
        for (const block of blocks) {
            if (block === root || !block.started) continue;
            if (block.agent !== event.agent) continue;
            if (block.terminal) continue;
            found = block;
            count += 1;
        }

        if (count === 1 && found !== undefined) return found;

        return inlineBlock(event.agent);
    };

    const route = (event: HarnessEvent): ReplayBlock => {
        // A `thread` field is present only for non-root INVOCATIONS, but TypeScript
        // knows the union variant; a plain property read keeps this simple and
        // honest.
        const thread = (
            event as {
                thread?: {
                    id: string;
                    parentId?: string;
                    callId?: string;
                    kind?: string;
                    branchId?: string;
                };
            }
        ).thread;
        if (thread === undefined) return blockForLegacy(event);

        // R1-R6: a HOST-thread run carries its invocation identity on EVERY frame
        // (that id maps the persistent thread to its events), but it is still the
        // turn's own ROOT conversation — not a nested child. Such an identity has
        // no parent, no spawning call, and no branch marker, so it routes to the
        // root block exactly like a threadless root event. Without this, the root
        // would never be allocated and the entry agent's answer would appear as a
        // child block under an id no reference uses.
        if (
            thread.parentId === undefined &&
            thread.callId === undefined &&
            thread.kind === undefined &&
            thread.branchId === undefined
        ) {
            return rootBlock(event.agent);
        }

        return blockForThread(event);
    };

    const complete = (block: ReplayBlock, status: AgentResultStatus, content?: string): void => {
        block.status = status;
        if (status === 'done') {
            if (content !== undefined) block.content = content;
        } else {
            block.content = undefined;
        }
        block.terminal = true;
    };

    for (const event of turn.events) {
        const block = route(event);

        switch (event.type) {
            case 'start':
                block.started = true;
                break;

            case 'tool_call': {
                // Queue a delegation placeholder when the call is made, so its
                // label is allocated in the same order the UI allocates it.
                if (event.call.name === 'delegate') {
                    const delegate = delegateOf(event.call.arguments);
                    if (delegate !== undefined && !byCall.has(event.call.id)) {
                        // The pending descriptor identity is `call:<callId>` (what
                        // the UI shows); the same string is kept as an alias after
                        // adoption so a reference bound now still resolves.
                        const key = `call:${event.call.id}`;

                        // F6: `provisional` — this number belongs to a run that has not happened
                        // yet. It keeps the allocation ORDER the UI allocates in (a chip and the
                        // wire prompt must agree about a pending delegation, which is what
                        // ./agent-results.test.ts and the frontend's blocks.test.ts pin), and it
                        // is handed back at the end of the turn if the child never started
                        // (see the `UNADDRESSABLE_BLOCK_LABEL` pass below) or re-named by the
                        // join when it does.
                        const placeholder = createBlock(delegate.agent, key, event.call.id, [key], undefined, {
                            provisional: true
                        });

                        placeholder.started = false;
                        byCall.set(event.call.id, placeholder);
                    }
                }
                break;
            }

            case 'done': {
                const pending = event.pending;
                if (pending === undefined || pending.length === 0) {
                    complete(block, 'done', event.message.content);
                } else {
                    // Paused response: the run continues, so this is NOT terminal.
                    block.lastDone = event.message.content;
                }
                break;
            }

            case 'error':
                complete(block, 'error');
                break;

            case 'branch_end': {
                const status: AgentResultStatus =
                    event.status === 'completed' ? 'done' : event.status === 'failed' ? 'error' : 'cancelled';
                complete(block, status);
                break;
            }

            case 'tool_result': {
                // The parent's result for the spawning call is the authoritative
                // outcome of a child that never reported its own terminal event.
                if (event.callId === undefined) break;
                const child = byCall.get(event.callId);
                if (child === undefined) break;
                if (child.terminal) break;

                complete(child, event.isError ? 'error' : 'done');
                break;
            }

            default:
                break;
        }
    }

    // Turn status is authoritative for the root and closes an unfinished child.
    if (root !== undefined) {
        const status = turn.status;
        root.status = status;
        root.terminal = status !== 'queued' && status !== 'running';
        if (status !== 'done') root.content = undefined;
        else if (root.content === undefined && root.lastDone !== undefined) root.content = root.lastDone;
    }

    for (const block of blocks) {
        if (block === root || block.terminal) continue;
        if (turn.status === 'queued' || turn.status === 'running') {
            block.status = turn.status;
            continue;
        }

        block.status = turn.status;
        block.content = undefined;
    }

    // F6 (the operator's `IT13`/`IT18`/`IT19`/`WE12` rows): a `delegate` placeholder whose
    // child NEVER STARTED is not a run at all. The parent made the call, the record holds no
    // child frames, and the only thing that settled the call is the parent's own
    // `tool_result` (or the turn ending) — every such block in the measured session had ZERO
    // characters. It keeps the honest unknown identity, so the phantom row cannot be typed as
    // `#IT13` and cannot shadow a conversation's name, and
    // `collectAgentLabelCounters` ignores the number it tentatively took.
    //
    // WHY ONLY A SETTLED TURN: while the turn is `running`/`queued` the child may still start
    // and adopt a conversation label, and a chip can legitimately bind the pending block by its
    // tentative number — that is exactly the state ./agent-results.test.ts ("resolves the
    // stable call alias before AND after delegation adoption") and the frontend's
    // blocks.test.ts pin, so a live pending delegation keeps showing its number.
    //
    // WHY `started === false` AND NOT `runtimeThreadId === undefined`: a LEGACY threadless
    // child adopts its placeholder through `blockForLegacy` (started, no runtime id) and IS a
    // real run with real content; it keeps its number. A placeholder that was blanked here has
    // no run behind it to reference.
    const turnSettled = turn.status !== 'queued' && turn.status !== 'running';

    if (turnSettled) {
        for (const block of blocks) {
            if (block.started || block.callId === undefined) continue;

            block.label = UNADDRESSABLE_BLOCK_LABEL;
            // F10 (R10.3): a retired placeholder owns no address, and it is the ONE case where
            // a label is TAKEN away after the mint, so the provenance flag is re-stamped here
            // rather than trusted from creation.
            block.ownsConversation = false;
        }
    }

    return blocks.map((block) => ({
        turnId: turn.id,
        ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
        label: block.label,
        agent: block.agent,
        status: block.status,
        ...(block.status === 'done' && block.content !== undefined ? { content: block.content } : {}),
        aliases: [...block.aliases],
        ownsConversation: block.ownsConversation
    }));
};

// Strip the internal fields from a projected block before it leaves this
// module. The wire/UI descriptor shape stays exactly {turnId, threadId?, label,
// agent, status, content?}.
const publicBlock = (block: ProjectedBlock): AgentResultBlock => {
    const { aliases: _aliases, ownsConversation: _ownsConversation, ...descriptor } = block;
    return descriptor;
};

// The allocator counters AFTER replaying every given turn, chained in recorded
// order — i.e. the state the NEXT turn starts from. The server records this as a
// turn's `labels` at creation, which is what lets a later deletion keep the
// surviving turns' labels stable (see AgentResultTurn.labels).
//
// Pass the conversation PREFIX up to (not including) the turn being created. The
// caller must supply turns in recorded order; `turns.labels` values already on the
// list are honoured, so computing a seed over a history that already carries seeds
// yields the same counters a live replay would.
//
// F6 (2026-11-25): the water is the set of labels the projection ENDS UP SHOWING, plus
// every start-counter a turn already records — NOT the end state of the allocator that
// walked the events. The two differ for exactly the numbers that must NOT become durable:
//   - a `delegate` placeholder's TENTATIVE mint, handed back to the join when the child's
//     own frame named its conversation (or retired because the child never started);
//   - a number a branch run or any other non-addressable block never displayed.
// Feeding those back is how the operator's session reached `IT` high-water 20 with IT9-IT11
// and IT13-IT19 owned by nothing: ../../server/sessions.ts `labelSeedOf` merges THIS map
// into `labelHighWater`, so every mint was re-hydrated into the next turn's seed and every
// later conversation. The chained allocator still mints the display numbers (it must stay
// identical to `listAgentResultBlocks`, or a chip and the wire prompt disagree), and
// `seed`-only-raises semantics are unchanged.
//
// F10 (R10.3, 2026-11-26) — the same rule, applied to the numbers a NON-owner displays.
// F6 retired the phantoms that show `UNADDRESSABLE_BLOCK_LABEL`, but a run that keeps a
// minted number while owning no conversation (`inline:<agent>`, a `call:<id>` child the join
// never claimed) still pushed the durable water above every ordinal the join knows: measured
// over all 10 turns of the operator's session, the join's `WE` water is 11, its persisted
// `labelHighWater` reads 12, and this function returned 16 (WE13-WE16 owned by nothing).
// So a MINTED label raises the counters only while it is at or below the highest ordinal the
// supplied join names for that code; an owned conversation label and a recorded seed raise it
// unconditionally, and a turn with NO join view (a legacy `/messages` record, where the
// minted occurrence is the whole reference namespace) behaves exactly as it always did.
export const collectAgentLabelCounters = (
    turns: readonly AgentResultTurn[]
): Map<string, number> => {
    const labels = createAgentLabels();
    const counters = new Map<string, number>();

    const raise = (code: string, used: number): void => {
        if (used > (counters.get(code) ?? 0)) counters.set(code, used);
    };

    // F10 (R10.3) — THE OWNER WATER of one record: the highest ordinal the store's join
    // itself NAMES for each code. `AgentResultTurn.threadLabels` is handed out only when the
    // session actually has labelled conversations (../server/sessions.ts:8501-8517
    // `hasThreadLabels`), so an absent view is the legacy `/messages` shape, where a minted
    // occurrence is the ONLY reference namespace there is and keeps raising the water exactly
    // as it always did.
    const ownerWaterOf = (join: Readonly<Record<string, string>> | undefined): Map<string, number> | undefined => {
        if (join === undefined) return undefined;

        const water = new Map<string, number>();

        for (const value of Object.values(join)) {
            const parts = agentLabelParts(value);
            if (parts === undefined || parts.ordinal <= (water.get(parts.code) ?? 0)) continue;

            water.set(parts.code, parts.ordinal);
        }

        return water;
    };

    for (const turn of turns) {
        // A turn's RECORDED start counters are durable state the next turn continues from even
        // when the turn itself displays nothing (a queued turn, or one whose every block reads
        // `UNADDRESSABLE_BLOCK_LABEL`). Dropping them would let a deleted conversation's
        // ordinal come back into use.
        if (turn.labels !== undefined) {
            for (const [code, used] of Object.entries(turn.labels)) raise(code, used);
        }

        const ownerWater = ownerWaterOf(turn.threadLabels);

        for (const block of blocksOfTurn(turn, labels)) {
            // `UNADDRESSABLE_BLOCK_LABEL` (and any other non-grammar text) parses to nothing,
            // which is precisely why it reserves nothing.
            const parts = agentLabelParts(block.label);
            if (parts === undefined) continue;

            // F10 (R10.3) — THE ONE RULE: a number this projection MINTED for a run the join
            // never names belongs to NO conversation, so it may never become durable. Measured
            // on the operator's session, exactly those numbers are `WE13`-`WE16` (a threadless
            // `inline:<agent>` stream and a `call:<id>` child that never earned a conversation
            // row), and they are the reason `labelHighWater.WE` read 12 while the join only
            // ever named WE11: ../server/sessions.ts `mergeLabelHighWater` only ever RAISES,
            // so a minted orphan is immortal. The display keeps minting them (a run still needs
            // SOME local identity to be citable within its own turn), and an owned conversation
            // label — `block.ownsConversation`, i.e. a label the join or `turn.threadLabel`
            // handed over — still raises, as does every recorded seed above.
            if (
                !block.ownsConversation &&
                ownerWater !== undefined &&
                parts.ordinal > (ownerWater.get(parts.code) ?? 0)
            )
                continue;

            raise(parts.code, parts.ordinal);
        }
    }

    return counters;
};

// List every block across turns, oldest turn first and each turn's blocks in
// creation (label-allocation) order. ONE allocator is chained across the turns, so
// the labels are the conversation-scoped ones the UI shows (`RR1`, then `RR2` in a
// later turn) rather than each turn restarting at 1.
export const listAgentResultBlocks = (turns: readonly AgentResultTurn[]): AgentResultBlock[] => {
    const labels = createAgentLabels();

    return turns.flatMap((turn) => blocksOfTurn(turn, labels).map(publicBlock));
};

// Exact lookup for a submitted reference: `turnId` + `threadId` (or root) + label.
// `threadId` may be the block's CURRENT identity OR any stable alias it carried
// (`call:<callId>` for a delegation that has since adopted a runtime id,
// `inline:<agent>` for a threadless legacy block). A genuinely wrong id matches
// nothing and the caller rejects it.
//
// `turns` MUST be the conversation prefix in recorded order (all turns up to and
// including the target): occurrence numbering is conversation-scoped, so a block's
// label depends on the turns BEFORE it. Passing only the target turn numbers it as
// if it were the first turn and would resolve the wrong block (or none).
//
// A reference with NO threadId is the root signal. For compatibility with
// descriptors produced before aliases existed, a threadless reference whose label
// matches exactly ONE nested block resolves to that block; it never guesses when
// several match. The label must always match exactly.
export const findAgentResultBlock = (
    turns: readonly AgentResultTurn[],
    reference: Pick<AgentResultReference, 'turnId' | 'threadId' | 'label'>
): AgentResultBlock | undefined => {
    // Project the ordered prefix through the target: later turns cannot change an
    // earlier turn's labels, so they are not needed (and may be absent).
    const targetIndex = turns.findIndex((candidate) => candidate.id === reference.turnId);
    if (targetIndex === -1) return undefined;

    const label = normalizeAgentLabel(reference.label);
    if (label === undefined) return undefined;

    // One chained allocator across the prefix, exactly like listAgentResultBlocks.
    const labels = createAgentLabels();
    let blocks: ProjectedBlock[] = [];
    for (let index = 0; index <= targetIndex; index++) {
        blocks = blocksOfTurn(turns[index], labels);
    }

    const labelled = blocks.filter((block) => block.label === label);

    if (reference.threadId === undefined) {
        const root = labelled.find((block) => block.threadId === undefined);
        if (root !== undefined) return publicBlock(root);

        // Legacy/threadless fallback: only an unambiguous single match.
        if (labelled.length === 1) return publicBlock(labelled[0]);
        return undefined;
    }

    const wanted = reference.threadId;
    const match = labelled.find(
        (block) => block.threadId === wanted || block.aliases.includes(wanted)
    );

    return match === undefined ? undefined : publicBlock(match);
};

// Latest block with this label across the given turns. Typed `#LABEL` resolves to
// the newest matching prior block ("latest wins"). With conversation-scoped
// numbering a label identifies exactly ONE block in the given list, so this is an
// exact lookup in practice; the newest-first scan is kept as the defensive rule for
// a record whose history was rewritten. There is deliberately NO fallback to an
// older block when the latest one failed — the caller rejects instead of silently
// injecting an outdated result.
//
// `turns` must be the conversation prefix in recorded order (same reason as
// findAgentResultBlock): the allocator is chained over the whole list.
export const findLatestAgentResultBlock = (
    turns: readonly AgentResultTurn[],
    label: string
): AgentResultBlock | undefined => {
    const wanted = normalizeAgentLabel(label);
    if (wanted === undefined) return undefined;

    // Project every turn with ONE allocator so the labels are the conversation's.
    const labels = createAgentLabels();
    const projected = turns.map((turn) => blocksOfTurn(turn, labels));

    for (let index = projected.length - 1; index >= 0; index--) {
        const match = projected[index].find((block) => block.label === wanted);
        if (match !== undefined) return publicBlock(match);
    }

    return undefined;
};

// Typed `#LABEL` tokens in a prompt, unique and in occurrence order. Requires a
// boundary before `#` and after the digits, so a markdown heading (`#Intro`) or an
// issue number (`#123`) is not treated as a reference.
const REFERENCE_TOKEN = /(?:^|[\s([{<])#([A-Za-z]{2}\d+)(?=$|[\s)\]}>.,;:!?])/gm;

export const parseAgentReferenceLabels = (prompt: string): string[] => {
    const labels: string[] = [];
    // A fresh RegExp keeps the shared constant's `lastIndex` untouched across
    // calls (a global regex is stateful).
    const pattern = new RegExp(REFERENCE_TOKEN.source, REFERENCE_TOKEN.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(prompt)) !== null) {
        const label = normalizeAgentLabel(match[1]);
        if (label === undefined) continue;
        if (!labels.includes(label)) labels.push(label);

        // Defensive: an empty match would loop forever with a global regex.
        if (match[0].length === 0) pattern.lastIndex += 1;
    }

    return labels;
};

// Structural validation for a persisted/submitted reference list. Returns detached
// copies with normalised labels; `undefined` means the key was absent (the exact
// pre-reference shape). Throws TypeError for a malformed payload so persistence can
// fail the load and the server can map it to a 400 before mutating anything.
export const readAgentResultReferenceList = (
    value: unknown,
    label = 'references'
): AgentResultReference[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
    if (value.length > MAX_AGENT_REFERENCES) {
        throw new TypeError(`${label} cannot contain more than ${MAX_AGENT_REFERENCES} entries.`);
    }

    const references: AgentResultReference[] = [];
    const keys = new Set<string>();

    for (let index = 0; index < value.length; index++) {
        const entry = value[index];
        const at = `${label}[${index}]`;

        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new TypeError(`${at} must be an object.`);
        }

        const record = entry as Record<string, unknown>;
        const turnId = record.turnId;
        if (typeof turnId !== 'string' || turnId.trim().length === 0) {
            throw new TypeError(`${at}.turnId must be a non-empty string.`);
        }

        const threadId = record.threadId;
        if (threadId !== undefined && (typeof threadId !== 'string' || threadId.trim().length === 0)) {
            throw new TypeError(`${at}.threadId must be a non-empty string when present.`);
        }

        const normalised = normalizeAgentLabel(record.label);
        if (normalised === undefined) {
            throw new TypeError(`${at}.label must be a block label such as "IT1".`);
        }

        const canonicalTurn = turnId.trim();
        const canonicalThread = typeof threadId === 'string' ? threadId.trim() : undefined;
        const key = `${canonicalTurn}\u0000${canonicalThread ?? ''}`;
        if (keys.has(key)) {
            throw new TypeError(`${at} duplicates turn "${canonicalTurn}" with the same thread.`);
        }
        keys.add(key);

        references.push({
            turnId: canonicalTurn,
            ...(canonicalThread === undefined ? {} : { threadId: canonicalThread }),
            label: normalised
        });
    }

    return references;
};

// The explicit notice appended when content is truncated. Its length is part of
// the budget, so `boundAgentResultContent` reserves room for it.
const truncationMarker = (removed: number): string => `\n...[truncated ${removed} characters]`;

// Bound one block's content to AT MOST `limit` characters INCLUDING the explicit
// truncation marker. Keeping the marker inside the bound is what lets the combined
// composer treat `limit` as a hard budget rather than an approximate one. When
// `limit` is too small for even the marker, it returns an empty string; the
// composer then rejects instead of emitting unmarked content.
export const boundAgentResultContent = (
    content: string,
    limit: number = MAX_REFERENCE_CONTENT_CHARS
): string => {
    if (content.length <= limit) return content;

    // Solve keep = limit - markerLength(content.length - keep). The marker's digit
    // count can change once, so iterate to a fixed point (bounded, no loops).
    let keep = Math.max(0, limit - truncationMarker(content.length).length);
    for (let pass = 0; pass < 6; pass++) {
        const marker = truncationMarker(content.length - keep);
        const next = Math.max(0, limit - marker.length);
        if (next === keep) break;
        keep = next;
    }

    const marker = truncationMarker(content.length - keep);
    if (marker.length > limit) return '';

    // PAIR-SAFE (T3, the lone-surrogate defect): `keep` is a code-unit figure, so the cut
    // may land inside a surrogate pair and leave the block ending on half of an emoji —
    // which then reaches the provider inside the delegated prompt. Backing off one unit
    // keeps the bound honest (the result is at most one character UNDER `limit`, never over
    // it) and never emits an orphan half. The one cosmetic cost, stated because the marker
    // is a character count a reader may diff against the source: `removed` is still computed
    // from `keep`, so a backed-off block reports one character fewer removed than it
    // actually dropped — an under-report of exactly the unit the pair cost, never an
    // over-report, and never a silent loss.
    return `${clipPrefix(content, keep)}${marker}`;
};

// The locator line above one block's content. Extracted from the composer loop so a
// note section (which has no locator) and a content section are built in one place.
const blockSectionStart = (block: AgentResultBlock): string => {
    const location = block.threadId === undefined ? '' : ` | thread ${block.threadId}`;
    return `--- #${block.label} | agent ${block.agent} | turn ${block.turnId}${location} ---`;
};

// Compose the run prompt. The user-facing `prompt` is preserved verbatim at the
// start; referenced content follows inside delimiters. The TOTAL string is capped
// at MAX_REFERENCE_TOTAL_CHARS (the same 200k ceiling as a raw prompt), counting
// the raw prompt, wrappers, separators, content, and truncation notices.
//
// A section is either result CONTENT (a `done` block) or a NOTE (a target that ended
// without a result, or disappeared). Both occupy the same delimited slot and count
// against the same budget, so a dead reference costs the note's few hundred chars and
// nothing else changes — the run still sees exactly which `#LABEL` it was asked about.
//
// Policy: the user prompt is never trimmed. Reference content is truncated to the
// remaining budget; when even an empty/truncated section cannot fit, this throws
// REFERENCED_RESULTS_BUDGET_MESSAGE so the server fails the turn readably instead
// of sending an over-budget prompt or silently dropping a reference.
export const composeAgentResultPrompt = (
    prompt: string,
    entries: readonly AgentResultSection[]
): string => {
    if (entries.length === 0) return prompt;

    // Layout: `${prompt}\n\n${HEADER}\n${section}\n${section}...\n${FOOTER}`.
    const prefix = `${prompt}\n\n${REFERENCED_RESULTS_HEADER}`;
    const footer = `\n${REFERENCED_RESULTS_FOOTER}`;
    let remaining = MAX_REFERENCE_TOTAL_CHARS - prefix.length - footer.length;

    if (remaining < 0) throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);

    const sections: string[] = [];

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];

        // A note entry has no block, so its header carries the label plus the
        // explicit "no result available" marker; a content entry keeps the full
        // locator so the model can attribute the text it is reading.
        const isNote = 'note' in entry;
        const label = isNote ? entry.label : entry.block.label;
        const body = isNote ? entry.note : entry.content;
        const start = isNote
            ? `--- #${label} | ${REFERENCED_RESULTS_NO_RESULT_MARKER} ---`
            : blockSectionStart(entry.block);
        const end = `--- end #${label} ---`;

        // Separator before this section (header newline for the first) plus the
        // two newlines that wrap the content and the closing line.
        const separator = 1;
        const fixed = separator + start.length + 1 + 1 + end.length;

        if (remaining - fixed < 0) throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);

        const contentBudget = remaining - fixed;
        const bounded =
            contentBudget <= 0
                ? ''
                : boundAgentResultContent(body, Math.min(contentBudget, MAX_REFERENCE_CONTENT_CHARS));

        // A non-empty block that cannot even carry its truncation notice has no
        // capacity: reject rather than claim a reference that contributed nothing.
        if (body.length > 0 && bounded.length === 0) {
            throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);
        }

        sections.push(`${start}\n${bounded}\n${end}`);
        remaining -= fixed + bounded.length;
    }

    const result = `${prefix}\n${sections.join('\n')}${footer}`;

    // Defensive invariant: the accounting above must never overrun. Keeping this
    // check makes a future layout change fail loudly instead of silently sending
    // a prompt larger than the documented ceiling.
    if (result.length > MAX_REFERENCE_TOTAL_CHARS) {
        throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);
    }

    return result;
};
