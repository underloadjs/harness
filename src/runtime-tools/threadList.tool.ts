// threadList — standalone source entry for the live conversation roster.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

export const THREAD_LIST_NAME = 'threadList';

// R4 thread roster. Its whole point is that ids are OBSERVED, not invented: the
// model reads the live conversations of its own session (default conversations
// included) and can then address one with `threadSend`. The current thread is
// supplied by the runtime, never by the model. Deleted threads are absent by
// construction, and nothing outside this session is reachable.
export const THREAD_LIST_METADATA: CoreToolMetadata = {
    name: THREAD_LIST_NAME,
    description:
        'List the live conversations (threads) of this session: id, owning agent, origin, status, and owner/thread link. Use the returned ids with threadSend. Your OWN thread is reported as currentThreadId. Only this session is visible; deleted threads are gone and cannot be addressed. A thread whose status is stopped cannot run or receive messages until its owner resumes or deletes it.',
    tags: ['thread', 'threads', 'list', 'roster', 'conversation', 'agent', 'chat'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

export const metadata = THREAD_LIST_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadList requires the live harness reference.');
    }

    return context.harness.runtime.threadList(context.threadId);
};
