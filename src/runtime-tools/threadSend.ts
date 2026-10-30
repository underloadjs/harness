// threadSend — standalone source entry; sender identity is runtime-derived.
import { THREAD_SEND_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = THREAD_SEND_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadSend requires the live harness reference.');
    }

    return context.harness.runtime.threadSend(
        context.agent,
        context.threadId,
        (context.parameters ?? {}) as Record<string, unknown>
    );
};
