// threadList — standalone source entry for the live conversation roster.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const THREAD_LIST_NAME = 'threadList';

// R4 thread roster. Its whole point is that ids are OBSERVED, not invented: the
// model reads the live conversations of its own session (default conversations
// included) and can then address one with `threadSend`. The current thread is
// supplied by the runtime, never by the model. Deleted threads are absent by
// construction, and nothing outside this session is reachable.
//
// SCOPE (2026-11-13). The roster used to be every host thread in the session, which
// advertised doors the caller could not walk through: `threadSend`/`threadRead`/
// `threadDelete` only accept a caller's own lineage, and 0027's fan-out callers were
// reading dozens of settled siblings. The list is now the caller's THREAD FAMILY —
// own thread, ancestors, descendants, and the same-agent defaults — while a caller
// with no thread at all (a host view outside any conversation) still sees everything,
// because a host is the one party that may address any conversation. Deleted threads
// are gone from it, and since 0027 that is actionable rather than a fact of life:
// `threadDelete` is the model-facing release.
export const THREAD_LIST_METADATA: CoreToolMetadata = {
    name: THREAD_LIST_NAME,
    description:
        'List the conversations (threads) you can address: id, owning agent, origin, status, and owner/thread link. The roster is scoped to YOUR THREAD FAMILY - your own thread, the threads above it (the ancestors that own it), the threads below it (the ones you created, including a delegated child conversation for every delegation), and the default conversations (agent:<name>) of the agents in that family - because threadSend, threadRead and threadDelete only accept what is in it. Your OWN thread is reported as currentThreadId. A caller with no thread of its own, such as a host view outside any conversation, sees every thread in the session; nothing outside this session is ever visible. Deleted threads are gone and cannot be addressed - you release a finished child conversation with threadDelete once you have read its answer, which is also how a session frees a thread slot. A thread whose status is stopped cannot run or receive messages until a HOST takes it up again - a host sendThreadInput revives it and a host deleteThread releases it; nothing an agent does resumes one.',
    tags: ['thread', 'threads', 'list', 'roster', 'conversation', 'agent', 'chat'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

export const metadata = THREAD_LIST_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'threads',
    order: 270,
    sessionBound: true,
    alwaysDeclared: false,
    listed: false
} as const;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadList requires the live harness reference.');
    }

    return context.harness.runtime.threadList(context.threadId);
};
