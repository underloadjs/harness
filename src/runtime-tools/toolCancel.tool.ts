// toolCancel — standalone baseline entry for the pending-call control.
//
// The real dispatch needs the owning RunState, so the harness marks the resolved
// baseline definition with a runtime-control marker. A replacement drops that
// marker and executes this/normal code through the registry instead.
import type { CoreToolMetadata } from '../core';

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
export const TOOL_CANCEL_METADATA: CoreToolMetadata = {
    name: TOOL_CANCEL_NAME,
    description:
        'Cancel one background tool call you started. Pass the callId shown in the pending list (tool_result.pending, a wakeup, or the tool_call event of a call still running). The harness releases the call immediately and ignores any later result, so you can continue without waiting for it. Cancelling a call that already completed, failed, or was already cancelled succeeds without changing anything, so you never need to check first. A tool that watches its abort signal also stops its own work; JavaScript cannot be preempted, so a tool that ignores the signal may still finish in the background. An id this run never started is an error.',
    tags: ['tool', 'tools', 'cancel', 'background', 'abort'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            callId: {
                type: 'string',
                minLength: 1,
                description: 'The callId of the tool call to cancel (pending or already settled).'
            }
        },
        required: ['callId'],
        additionalProperties: false
    }
};

export const metadata = TOOL_CANCEL_METADATA;

export const execute = () => {
    throw new Error(
        'toolCancel requires the harness run that owns the pending call; call it from a model tool call.'
    );
};
