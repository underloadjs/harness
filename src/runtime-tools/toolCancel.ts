// toolCancel — standalone baseline entry for the pending-call control.
//
// The real dispatch needs the owning RunState, so the harness marks the resolved
// baseline definition with a runtime-control marker. A replacement drops that
// marker and executes this/normal code through the registry instead.
import { TOOL_CANCEL_METADATA } from '../core/metadata';

export const metadata = TOOL_CANCEL_METADATA;

export const execute = () => {
    throw new Error(
        'toolCancel requires the harness run that owns the pending call; call it from a model tool call.'
    );
};
