// toolCancel — standalone baseline entry for the pending-call control.
//
// The real dispatch needs the owning RunState, so the harness marks the resolved
// baseline definition with a runtime-control marker. A replacement drops that
// marker and executes this/normal code through the registry instead.
import type { CoreToolMetadata } from '../../core';

// Targeted cancellation for background tool calls (T3/R4). Not part of
// coreToolMetadata(): it is declared to the model ONLY while that agent actually
// has calls in flight, so it costs no context on ordinary requests and a server
// catalogue that lists standing capabilities does not advertise a control that
// has nothing to cancel.
export const TOOL_CANCEL_NAME = 'toolCancel';

// Targeted cancellation (T3/R4). The harness declares this ONLY while the calling
// agent has a background call pending, which is exactly when it can succeed, so
// the description is written for that moment: it explains that the call keeps
// running unless it observes its abort signal, and that the harness stops waiting
// either way. `callId` is the id from the pending list / `tool_call` event.
//
// R2: cancellation is IDEMPOTENT. The text says so explicitly, because a model
// that expects an "already completed/cancelled" error would waste a turn avoiding
// it; reaching the settled state again is success. Only an id this run never
// started is an error, and the description says that too so the model knows the
// difference.
//
// F1 (2026-11-26, independent audit of the 0032 pass) — the enumeration of what a cancelled
// `delegate` call still delivers now names `toolActivity` too, with its cap. The shipped abandoned-
// call envelope DOES carry the tally — ../../harness.delegation.test.ts
// (`delivers the child forensics when toolCancel releases the delegation`) pins
// `{calls: 1, settled: 0, byName: […], truncated: false}` on exactly that door — and `delegate`'s own
// abandon sentence already lists all four forensic fields; this row named three, so a caller reading
// ONLY this control's description was told a smaller contract than the one delivered — 0032 AC7's
// rule is that a description names the field and its bound. The bound is stated BY REFERENCE to the
// row that owns it: `TOOL_ACTIVITY_NAME_CAP` (../../core/agent-limits.ts) is what caps the name list,
// and the `delegate`/`agentResult` descriptions spell "up-to-8" against that constant
// (../../core/metadata.ownership.test.ts pins it), so this row repeats the number and points at the
// row that defines the field. This entry is `visibility: 'core'`, so the extra words are
// never scored by discovery (../../core/discovery.ts ranks only `searchable` rows); they do move
// the two byte pins that carry this description — ../../harness.tool-list.test.ts re-measures them.
export const TOOL_CANCEL_METADATA: CoreToolMetadata = {
    name: TOOL_CANCEL_NAME,
    description:
        'Cancel one background tool call you started. Pass the callId shown in the pending list (tool_result.pending, a wakeup, or the tool_call event of a call still running). The harness releases the call immediately and ignores any later result, so you can continue without waiting for it - except a delegate call: its terminal envelope is still delivered, as that call\'s own tool message, carrying `status`, any `partialContent`/`cancelledAtMessage`/`toolActivity` (the up-to-8 name tally the `delegate` row describes), and `callCancelled: true` to mark that you released the call rather than the child finishing on its own. Cancelling a call that already completed, failed, or was already cancelled succeeds without changing anything - the receipt then reports `cancelled: true` together with `alreadySettled: true`, the flag that says the call had already reached a terminal state before you asked, so that pair is a success you can act on and not a second cancellation - so you never need to check first. A tool that watches its abort signal also stops its own work; JavaScript cannot be preempted, so a tool that ignores the signal may still finish in the background. An id this run never started is an error. A background threadFork is the one call you may name TWO ways: the callId from its pending placeholder, or the branch-N id its result reported - they address the same call, and a receipt for released fork work echoes `branchId`, `invocationId` and `threadId` beside `callId`, which are the ids threadRead and agentResult take.',
    tags: ['tool', 'tools', 'cancel', 'background', 'abort'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            callId: {
                type: 'string',
                minLength: 1,
                description:
                    // F1-C3 (2026-11-27) — the one argument now names a call two ways. A
                    // `threadFork` answer hands the caller `{ branchId, threadId, content }`, where
                    // both ids are the generated `branch-N` string (and that string is also the
                    // `invocationId` `agentResult` pages with), while the pending placeholder hands
                    // it a callId. Until now only the second one worked here, so the id the fork
                    // told the model to keep was the id this control could not resolve.
                    'The callId of the tool call to cancel (pending or already settled). A background threadFork may also be named by the branch-N id its result reported - that id and its callId address the same call, and the receipt echoes the branch id back.'
            }
        },
        required: ['callId'],
        additionalProperties: false
    }
};

export const metadata = TOOL_CANCEL_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    // T2/R2: no mode is declared. toolCancel is answered INLINE by the owning run
    // (immediateResult), so it never becomes a background task and has no completion to
    // group; the documented 'sync' default is both its effective value and a no-op.
    order: 150,
    sessionBound: true,
    alwaysDeclared: false,
    listed: false,
    pendingOnly: true,
    control: 'cancel'
} as const;

export const execute = () => {
    throw new Error(
        'toolCancel requires the harness run that owns the pending call; call it from a model tool call.'
    );
};
