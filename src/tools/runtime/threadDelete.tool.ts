// threadDelete — standalone source entry for releasing one terminal thread.
//
// WHY THIS ENTRY EXISTS (issue 0027 —
// docs/issues/minor-one-shot-child-threads-stay-on-the-roster.md)
// ----------------------------------------------------------------
// Every delegation from a host-thread parent mints its OWN host conversation
// (src/harness.ts ~10263-10267, `createThreadState(brain.name, { ownerThreadId },
// true)`) so concurrent siblings never mix and each child stays addressable. That is
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
// readable with `threadRead`, and the evidence a post-mortem needs must survive), so
// this tool is EXPLICIT and PERMANENT: nothing here is automatic, and nothing here is
// recoverable. The description carries both facts because a model reads the
// description, not this file.
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
        'Release one FINISHED conversation for good, from the conversation that owns it. A delegation FROM A CONVERSATION mints its own thread, and a session holds only a bounded number of them, so a one-shot child is work you reclaim yourself (issue 0027): read what you still need with threadRead or agentResult first, then delete it. (A delegation that comes from the host rather than a conversation reuses that subagent\'s default conversation instead of minting one - and this tool will not release a default, so that child has no slot for you to free.) Deletion is PERMANENT - the transcript, its invocation record and its branch lookups all go with it, and a deleted id becomes unknown to threadList, threadRead, threadSend and this tool. Pass `thread` for one of YOUR DESCENDANTS that is no longer running: a thread you created, or one created underneath you. Five things are refused: a thread that is RUNNING (stop it first), a finished target that still has a RUNNING descendant (the refusal names the running child, and nothing is half-deleted), this agent\'s default conversation (agent:<name>), a thread outside your lineage (an ancestor, a sibling, or another agent\'s conversation is not yours to delete), and any id this session does not have. Deleting cascades, so the finished threads that thread created are removed with it. The receipt reports `deleted` (the id you named) and `removedThreadIds` (every id that actually went, the cascaded ones included), so the state you caused is the state you can see.',
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
                    'Id of the finished thread to release, as reported by threadList - one of YOUR descendants. A running thread, this agent\'s default conversation (agent:<name>), a thread outside your lineage, and a deleted or unknown id all fail. There is no default: your own current thread is never the target.'
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
