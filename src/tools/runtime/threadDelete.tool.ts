// threadDelete — standalone source entry for releasing one terminal thread.
//
// WHY THIS ENTRY EXISTS (issue 0027, closed)
// ----------------------------------------------------------------
// Every delegation from a host-thread parent mints its OWN host conversation
// (src/harness.ts ~14589, `createThreadState(brain.name, { ownerThreadId }, true)`) so
// concurrent siblings never mix and each child stays addressable. That is
// the design, and this entry does not change it. What was missing is the release side:
// the purge existed only as the HOST operation `deleteThread`, so a session that
// fanned out nineteen times kept nineteen settled threads on the roster it had no
// way to close — and the cap is not passive. `createThreadState` THROWS once the
// host-thread count reaches MAX_THREAD_RECORDS (src/core/thread.ts:46) with the
// message "…delete a terminal one before creating another (maximum 256)"
// (src/harness.ts:5085). The 257th delegation fails outright, and until now nothing
// inside a session could free a slot. This entry is that half of the design: the
// model-facing close, scoped to the caller's own descendants.
//
// The issue deliberately rejects AUTO-DELETE on completion (a settled child must stay
// readable with `threadRead`, and the evidence a post-mortem needs must survive), so this
// tool is EXPLICIT and MANUAL: nothing here is automatic.
//
// WHAT "PERMANENT" MEANT CHANGED (IT19 R2, 2026-11-15 — issue 0036, closed). This entry
// shipped promising "Deletion is PERMANENT — the transcript, its invocation record and
// its branch lookups all go with it", and the runtime answered that by destroying the
// lookups. `deleteThread` is a SOFT delete now: `purgeThread` marks the record `inactive`
// (+ `inactiveAt`), the row stays in the thread table, its transcript and its invocation
// rows survive, and the doors change shape accordingly — the roster and `actOn` stop
// naming it, `threadSend`/`steerThread`/`sendThreadInput` refuse it with their own
// sentence, `threadRead` refuses it for a CALLER that is itself a conversation (a host
// read still resolves the retained transcript), and `deleteThread` on an already-released
// descendant is IDEMPOTENT — it restates the first receipt without re-marking, without a
// fresh `inactiveAt`, and without a second `thread.deleted` hook. So the description says
// MARK, names what survives, and states the one deletion that is real: deleting the
// session — QUALIFIED BY THE SAME-DAY HONESTY PASS, because "the only thing that destroys one" is
// true of what an AGENT can do, not of the document. The session holds a bounded number of thread
// records (`MAX_THREAD_RECORDS`, 256 — src/core/thread.ts:46), and past that bound
// `capThreadRecords` (src/server/sessions.ts:4787, mirrored kernel-side by
// `capRetiredThreadRecords`, src/harness.ts:762) retires the OLDEST `inactive` rows, transcripts
// included. That retirement is the one remaining case in which a retained conversation really is
// dropped, and the description now says so instead of implying unbounded retention.
// `removedInvocationIds` kept its name and changed meaning ("no longer listed",
// not "destroyed"); `removedBranchIds` is the one set genuinely removed.
//
// THE RUNNING REFUSAL IS ACTIONABLE NOW (independent review, 2026-11-15). "stop it
// first" on its own named no door: there is NO thread-stop tool, and the only stop an
// agent can perform is `toolCancel` on a call ITS OWN run started — which does end a
// delegated child's run, because that child's signal is linked to the call's controller
// (`scheduler.cancel` → the per-call AbortController → the child's linked signal), and the
// child then lands `stopped` + `stopReason: 'caller-released'` with its turns retained. An
// arbitrary running thread owned by somebody else cannot be stopped from a tool call, and
// the description says so instead of implying a door that does not exist.
//
// PURE LITERAL (T19 / R9). No computation, no interpolation, no call, and no
// value-import of `../../core` — that would close a cycle through core/metadata.ts,
// and a runtime entry must keep zero captured local dependencies
// (scripts/check-package-tools.ts). The AST reader in ../../core/tool-discovery.ts
// extracts `metadata` and `registration` from this file without executing it, so the
// shape below is also what drives registration.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const THREAD_DELETE_NAME = 'threadDelete';

// The shape mirrors `threadSend` exactly: same activation group, same visibility
// (registered with the thread trio, then declared for every agent in the session),
// same "ids come from threadList" premise, and a `required` single string argument
// with `minLength: 1` so an empty id is a schema rejection rather than a delete of
// "whatever the runtime defaults to".
export const THREAD_DELETE_METADATA: CoreToolMetadata = {
    name: THREAD_DELETE_NAME,
    description:
        'Release one FINISHED conversation from this session\'s roster, from the conversation that owns it. A delegation FROM A CONVERSATION mints its own thread, and a session holds only a bounded number of them, so a one-shot child is work you reclaim yourself (issue 0027): read what you still need with threadRead or agentResult first, then delete it. (A delegation that comes from the host rather than a conversation reuses that agent\'s default conversation (agent:<name>) instead of minting one - and this tool will not release a default, so that child has no slot for you to free.) Releasing is a MARK, not an erasure: the conversation leaves threadList and every agent-facing door, while its transcript and its result records are RETAINED - `removedInvocationIds` names the result rows that stopped being LISTED with it, and `agentResult` still answers an `invocationId` you already hold by that id. `agentManage` no longer counts its run, so read the answer BEFORE you release the thread. Nothing an agent does destroys a conversation: re-deleting a descendant you have already released is not an error - it restates the same receipt and changes nothing - and the only thing that destroys one is deleting the session itself - which keeps a bounded roster of 256 thread records, and past that bound the OLDEST released rows are retired with their transcripts. Pass `thread` for one of YOUR DESCENDANTS that is no longer running: a thread you created, or one created underneath you. Six things are refused: a thread that is RUNNING (stop it first) - the only stop an agent has is `toolCancel` on the call that started that work, a call that must be one YOUR run started, because no thread tool stops a conversation somebody else owns, a finished target that still has a RUNNING descendant (the refusal names the running child, and nothing is half-deleted), this agent\'s default conversation (agent:<name>), a thread outside your lineage (an ancestor, a sibling, or another agent\'s conversation is not yours to delete), a fork\'s `branch-N` id (a branch is an address, not a conversation: it holds no thread slot, so there is nothing to release - it goes when the conversation that forked it is deleted, and the branch ledger keeps only its newest 64 records by default), and any id this session does not have. Deleting cascades, so the finished threads that thread created are removed with it. The receipt reports `deleted` (the id you named), `removedThreadIds` (every id that actually went, the cascaded ones included), `removedInvocationIds` (the result records that went with them, which `agentManage` no longer lists) and `removedBranchIds` (the fork branches released the same way) - an empty array means none went, not that the receipt is silent. Those two id sets mean HID BEHIND the conversation you named, not destroyed: on the first release that is exactly what this call took out of discovery, and a re-delete restates the same two sets, because those conversations and result rows are still hidden. `removedBranchIds` is the one set that means NEWLY UNLISTED BY THIS CALL - a branch lives in a bounded ledger rather than in a conversation, its rows really do go with the first release, so a re-delete honestly reports an empty one.',
    tags: ['thread', 'threads', 'delete', 'remove', 'release', 'cleanup', 'roster'],
    // Same visibility as the rest of the thread group: registered with the first
    // independent thread, then declared for every agent in the session (not
    // searchable — a model cannot discover a tool whose ids it needs in order to use
    // it, and this one names ids from threadList).
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            thread: {
                type: 'string',
                minLength: 1,
                description:
                    'Id of the finished thread to release, as reported by threadList - one of YOUR descendants. A running thread, a finished target with a running descendant, this agent\'s default conversation (agent:<name>), a thread outside your lineage, a fork\'s branch-N id, and an unknown id all fail; re-deleting a descendant you have already released instead restates its receipt, because a released thread is inactive rather than destroyed. There is no default: your own current thread is never the target.'
            }
        },
        required: ['thread'],
        additionalProperties: false
    }
};

export const metadata = THREAD_DELETE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
//
// `activation: 'threads'` joins the cross-thread group: it registers on the FIRST
// createThread (or when a restore carries host threads), which is exactly when a
// caller can first own a child thread worth releasing.
//
// `order: 255` is BELOW the other three thread entries (threadList 270, threadRead
// 265, threadSend 260) on purpose: that group registers in DESCENDING order
// (src/harness.ts ~1157-1168), so the declarations stay roster-first —
// threadList, threadRead, threadSend, threadDelete. An id is therefore always
// discoverable before the tool that addresses it, including this one.
//
// `mode: 'sync'` is STATED rather than defaulted. The value equals DEFAULT_TOOL_MODE,
// and the behaviour needs it: the caller is asking for a state change whose outcome
// (which ids actually went) must be in the tool message of the same turn, and a
// routed/worker-mode read of that result is a promise the dispatcher awaits. Naming
// it keeps the descriptor honest instead of relying on the absent-key default.
//
// `listed: false` mirrors threadSend/threadList: not a server direct-call catalogue
// row, because a manual delete outside a session has no caller lineage to scope.
export const registration = {
    group: 'runtime',
    activation: 'threads',
    mode: 'sync',
    order: 255,
    sessionBound: true,
    alwaysDeclared: false,
    listed: false
} as const;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadDelete requires the live harness reference.');
    }

    // `thread` is the model's ONLY argument, and unlike threadRead there is no honest
    // fallback: defaulting to `context.threadId` would aim the delete at the conversation
    // the caller is running in, which the runtime refuses anyway. An absent, blank or
    // whitespace-only id is therefore a clear entry-side error — the schema's
    // `minLength: 1` gates a model call, but a manual `executeTool` reaches this function
    // with whatever the host passed.
    //
    // The value arrives in TWO shapes, and both are correct: a tool that declares EXACTLY
    // ONE property has its arguments UNWRAPPED to that property's value by
    // `resolveToolParameters` (core/schema-validation.ts, driven by `toolParameterKey` in
    // core/tool.ts) on BOTH the model path and the direct `executeTool` path, so the live
    // call hands over the bare id string. The wrapper object is still read for a
    // hand-built context (and stays the shape the schema advertises to the model).
    const raw = context.parameters;
    const wrapped = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).thread : undefined;
    const thread = (typeof raw === 'string' ? raw : typeof wrapped === 'string' ? wrapped : '').trim();

    if (thread.length === 0) {
        throw new Error('threadDelete needs a thread: pass "thread" (see threadList).');
    }

    // The CALLER's persistent thread, supplied by the runtime from RunState and never
    // by the model, so a caller cannot name itself out of the descendant check. It is
    // undefined for a manual `executeTool` call outside any conversation, which the
    // runtime reads as "the host view" and leaves unscoped. The cascade, the
    // running-thread refusal and the `agent:<name>` refusal all live in
    // `runtime.threadDelete`; this entry only resolves the identity and forwards.
    return context.harness.runtime.threadDelete(context.threadId, thread);
};
