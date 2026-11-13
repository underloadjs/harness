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
        'List the conversations (threads) you can address: id, owning agent, origin, status, sequence, and owner/thread link. `origin` says what kind of address an id is: "agent" is that agent\'s OWN default conversation, shared by everyone who talks to that agent, and "host" is a conversation running ON TOP of an agent - which includes EVERY delegated child, so a child you minted is a host thread, not an agent default. `ownerThreadId` is the field that identifies a child as delegated: it names the conversation that created it, and it is absent for a top-level thread. `sequence` is a monotonic per-harness number in creation order, never reused, and it is the order this roster is sorted in (oldest first). The roster is a LIVE snapshot taken FOR YOU: it grows as you delegate and shrinks as you delete, and two callers in the same session see different lists. The scope is YOUR THREAD FAMILY - your own thread, the threads above it (the ancestors that own it), the threads below it (the ones you created, including a delegated child conversation for every delegation), and the default conversations (agent:<name>) of the agents in that family - because threadSend, threadRead and threadDelete only accept what is in it. SIBLINGS are deliberately excluded: a thread that shares your ancestor but was not created by you is not listed and not reachable. A fork\'s `branch-N` records are NOT roster entries either - a branch is an address, not a conversation: it is readable with threadRead, pageable with agentResult, released with the conversation that forked it, and the branch ledger keeps only its newest 64 records (that is the default; a host may configure fewer). Because the defaults listed are the ones whose agents your family spans, deleting your LAST thread of agent X also takes `agent:X` out of what you can address; delegate to X again and the conversation it mints re-admits that address. While a run is attached to a default conversation, that conversation also transiently includes the thread that sent the message which started it, so the turn someone woke up can reply to the sender - for the life of that run only. Your OWN thread is reported as currentThreadId. A caller with no thread of its own, such as a host view outside any conversation, sees every thread in the session; nothing outside this session is ever visible. Deleted threads are gone and cannot be addressed - you release a finished child conversation with threadDelete once you have read its answer, which is also how a session frees a thread slot. A thread whose status is stopped cannot run or receive messages until a HOST takes it up again - a host sendThreadInput revives it and a host deleteThread releases it; nothing an agent does resumes one.',
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
