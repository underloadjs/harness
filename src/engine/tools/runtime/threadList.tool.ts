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
// SCOPE (2026-11-15). The list is SESSION-WIDE again, and the reason is a name, not a
// policy: a prompt quotes a conversation by the label the UI shows (`IT14`), and the
// conversation a user names is usually a SIBLING - the one row the old family-scoped
// roster deliberately hid, so the model was told to review a thread its own address
// book refused to list. The narrowing was only ever justified because all three thread
// doors refused everything outside the family (issue 0027); reads are session-wide now,
// so the roster states the remaining difference instead of hiding rows: every row is
// READABLE with `threadRead`, and `actOn` lists the ids whose LINEAGE the two write doors
// accept. A caller with no thread at all (a host view outside any conversation)
// omits `actOn`, because for a host the two sets are the same set. Deleted threads are
// gone from it, and since 0027 that is actionable rather than a fact of life:
// `threadDelete` is the model-facing release.
//
// DEFECT F1-3 (2026-11-25) — `actOn` was sold as "the ids threadSend and threadDelete
// ACCEPT", and it is the set only the doors' LINEAGE gate admits; each door still applies
// its own state rules on top (src/harness.ts `threadSend` refuses the caller's own IDLE
// thread / own idle default, ~:7267, and a `stopped` row with an unrecoverable stopReason,
// ~:7236; `threadDelete` walks DESCENDANTS only, :8277, and refuses every `agent:` default
// outright, :7997). The emitted set is unchanged — it was already correct — the sentence
// about it was not, so an id in `actOn` that the door then refused read like a contradiction
// rather than a second, stated rule. The description now names both doors' rules.
//
// DEFECT F1-2 (2026-11-25) — `ownerThreadId` is stripped from an `origin: 'agent'` row of the
// MODEL page (src/harness.ts `modelThreadRosterOf`). The link is a store fact the lineage walk
// needs (`threadFamilyOf` step 4) and the model has no door for it (`threadDelete` refuses
// every default), so advertising it made "absent for a top-level thread" false for exactly the
// top-level kind a model meets most often. The RECORD and the host seam (`harness.threads()`)
// keep it.
//
// IT19 R2/R3 (2026-11-15). A row is a detached `HarnessThreadRecord`, so the roster also
// carries `stopReason` — the cause of the conversation's LAST run that ended short of its
// conclusion — and `inactive`/`inactiveAt` for a released row (filtered OUT of this list,
// though `harness.threads()` for a host still names them). `threadSend` reads `stopReason`
// to decide whether a `stopped` conversation is one it may continue
// (`isResumableStopReason`, `../../harness.ts`), which is why the description states that
// split instead of the old blanket "nothing an agent does resumes one". The STATUS
// vocabulary itself is unchanged: `'idle' | 'running' | 'paused' | 'stopped'`.
export const THREAD_LIST_METADATA: CoreToolMetadata = {
    name: THREAD_LIST_NAME,
    description:
        'List the conversations (threads) of this session: id, owning agent, origin, status, sequence, and owner/thread link. `origin` says what kind of address an id is: "agent" is that agent\'s OWN default conversation, shared by everyone who talks to that agent, and "host" is a conversation running ON TOP of an agent - which includes EVERY delegated child, so a child you minted is a host thread, not an agent default. `ownerThreadId` is the field that identifies a child as delegated: it names the conversation that created it, and it is ABSENT ON THIS PAGE for both kinds of top-level thread - a host conversation no one created, and an "agent" default conversation (a default does carry an owner link in the ledger once a family adopts it, but that link is a fact about the ledger\'s lineage bookkeeping, not an address you can act on, so the page never carries it). `sequence` is a monotonic per-harness number in creation order, never reused, and it is the order this roster is sorted in (oldest first). The roster is a LIVE snapshot taken FOR YOU: it grows as you delegate and shrinks as you delete, and two callers in the same session see different lists. The LIST is session-wide - your own thread, the threads above and below it, your SIBLINGS, and every default conversation (agent:<name>) - because a READ reaches any conversation in this session, and a prompt that names a thread ("review IT14") must be able to find it. What stays lineage-scoped is WRITING: `actOn` lists the ids the two writing doors\' LINEAGE GATE admits from you (your own thread, the ancestors that own it, the descendants you created, and the default conversations of the agents in that family) - it is the set that passes the lineage test, NOT a promise that a call succeeds, because each door then applies its own STATE rules and can still refuse an id it advertises. Those rules, named: `threadDelete` acts on DESCENDANTS only - never your own thread, never an ancestor or a sibling, and never an "agent" default conversation, which is permanent and released only with the session - and it refuses one that is running. `threadSend` refuses your own IDLE thread and this agent\'s IDLE default (posting into your own RUNNING thread is mid-run steering and answers "queued"), and refuses a "stopped" row whose `stopReason` cannot be continued - a host stop, a plugin park, or no recorded cause; see the stopped-thread rule below. A row outside `actOn` is still readable with threadRead, and `actOn` is absent for a caller with no thread of its own, for which every row is actable. Every row carries the conversation\'s `label` when its host has minted one - that label (IT14, RR3) is the name the UI shows and an ADDRESS like the id: threadRead, threadSend and threadDelete take either, an id wins when they collide, and a label is matched exactly after trimming. A fork\'s `branch-N` records are NOT roster entries either - a branch is an address, not a conversation: it is readable with threadRead, pageable with agentResult, released with the conversation that forked it, and the branch ledger keeps only its newest 64 records (that is the default; a host may configure fewer). Because the defaults in `actOn` are the ones whose agents your family spans, deleting your LAST thread of agent X also takes `agent:X` out of what you can send to; delegate to X again and the conversation it mints re-admits that address. While a run is attached to a default conversation, that conversation also transiently includes the thread that sent the message which started it, so the turn someone woke up can reply to the sender - for the life of that run only. Your OWN thread is reported as currentThreadId. A caller with no thread of its own, such as a host view outside any conversation, sees every thread in the session; nothing outside this session is ever visible. Deleted threads are no longer listed and no agent door addresses them - releasing one MARKS it inactive rather than destroying it, so its record, its transcript and its result rows are retained and a host can still read it by id - and you release a finished child conversation with threadDelete once you have read its answer, which is also how a session frees a thread slot. A row also carries `stopReason` when its last run ended before it answered, and that field says whether a stopped conversation is reachable: threadSend continues one whose run was cut short (caller-released, timeout, turn-cap, budget-exhausted, api-error, retries-exhausted, provider-network, parent-closed), while a thread the host stopped (user-stopped), one a plugin parked (plugin-parked), and one stopped with no recorded cause wait for a host - a host sendThreadInput revives those and a host deleteThread releases them.',
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
