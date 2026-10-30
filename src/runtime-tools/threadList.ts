// threadList — standalone source entry for the live conversation roster.
import { THREAD_LIST_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = THREAD_LIST_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadList requires the live harness reference.');
    }

    return context.harness.runtime.threadList(context.threadId);
};
