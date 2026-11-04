// The authority: the coordinator-side half of the lane-worker contract.
//
// WHAT THIS MODULE OWNS
// ---------------------
// One instance per SESSION, holding the single canonical harness plus the three
// authority ledgers:
//
//   - `IdentityLedger`  (./lane-identity.ts)  - every id a replica would otherwise mint
//   - `WriterLeaseLedger` (./lane-commit.ts)   - one writer per shared conversation
//   - `CommitJournal`   (./lane-commit.ts)     - ordering, receipts, and the terminal gate
//
// It answers the two kinds of frame a lane sends:
//
//   1. `answer(request)` - a session-shared OPERATION. The canonical harness performs it
//      and the answer comes back as data. Every shared-state runtime method is routed here
//      (./capability.ts `AUTHORITY_RUNTIME_METHODS`), so a lane never writes a record,
//      a registry entry, a discovery grant, an agent-result read, or a cross-thread
//      message against its private copy of the session.
//   2. `commit(group)`  - the state only a RUN produces: the conversation transcript it
//      appended, the terminal invocations it archived, its own thread's roster state, and
//      its declared memory writes. The group is folded against a canonical view (so
//      bounds, leases, prefixes and digests are checked BEFORE anything moves), then each
//      accepted op is applied through ONE targeted harness call.
//
// WHY THE FOLD-THEN-APPLY SHAPE, AND WHY IT IS NOT A MERGE
// -------------------------------------------------------
// The retired design diffed a replica's whole state document and merged it (last writer
// wins) - which is what lost concurrent work in the T3 review. Here the lane sends
// INTENTS with the facts they depend on (the prefix length it saw, the digest it read, the
// id it leased), and the authority decides. The fold gives atomicity (a half-applied group
// can never land in a live store); the replay gives the live object the final word. When
// the two disagree - only possible if something wrote the canonical harness outside this
// authority between the fold and the replay - the LIVE answer wins and the receipt says so.
// Nothing is silently dropped: every op ends with a receipt naming what happened.
//
// WHY `harness.snapshot()` PER GROUP IS ACCEPTABLE
// ------------------------------------------------
// `snapshot()` builds the fold view. The inline path already pays a full `snapshot()` plus
// a durable write on EVERY state change (../sessions.ts `noteStateChange`), and a lane
// commits at turn boundaries rather than per tool call, so this is at or below the cost the
// coordinator was already paying - without restore()'s rebuild of tools and thread agents
// (T3 finding F10), which is the part that actually mattered.
//
// Cross-references:
//   - ./lane-host.ts     - spawns lanes and routes their frames into this authority
//   - ./lane-worker.ts   - the worker side that raises the requests
//   - ./protocol.ts      - the frames and the epoch / seq / callId rules
//   - ../../harness.ts   - the targeted seams used below: appendThreadMessages,
//                          setThreadStatus, archiveInvocation, reserveIdentity
//   - ../sessions.ts     - noteStateChange (the inline snapshot this matches), action
//                          broker, and the session that owns one authority per session id

import type {
    Agent,
    Harness,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessIdentityReservation,
    HarnessMessage,
    HarnessSnapshot,
    HarnessThreadStatus,
    ToolContext,
    ToolCreation
} from '../../types';
import type { RecordStoreName } from './lane-commit';
import {
    DEFAULT_BOUNDS,
    applyMutationGroup,
    applySharedMutation,
    archiveDigestOf,
    createCommitJournal,
    createWriterLeaseLedger,
    expectsDigestOf,
    replaceLaneEpoch,
    rolledBackReceipts
} from './lane-commit';
import type { CanonicalBounds, CanonicalView, GroupOutcome, MutationGroup, MutationReceipt, MutationRejectionCode } from './lane-commit';
import { ID_SPACES, createIdentityLedger, seedFromCounter } from './lane-identity';
import type { IdSpace, IdentityLease } from './lane-identity';
import { ABSENT_DIGEST, applyMemoryWrite, assessMemoryAccess, captureMemoryWindow, digestMemoryValue } from './lane-memory';
import type { MemoryWindow } from './lane-memory';
// T10 findings M5/S2: the created-tool revision is scanned with the SAME lens the hello
// report uses, before the canonical harness installs it, so a lane never runs a body whose
// shared reach the plan could not bound.
import { assessWorkerToolSurface, toolScanTextOf } from './capability';

// The record-store tool names the authority can execute. Matches the core's own union
// (`HarnessToolRuntime['executeRecordTool']`), stated here so the wire type is explicit.
export const RECORD_TOOL_NAMES = ['task', 'profileManage', 'chapterManage', 'locationManage'] as const;

export type RecordToolName = (typeof RECORD_TOOL_NAMES)[number];

// The caller identity a lane carries with every shared call. It is DATA (names, not live
// Agents), and the authority resolves it against its OWN registry - which is what keeps a
// spoofed or forgotten sender from becoming a model argument (the same rule
// src/tools/runtime/threadSend.tool.ts:65 follows inline).
export type LaneCallIdentity = {
    agent?: string;
    threadId?: string;
    runDepth?: number;
};

// One routed `harness.runtime` call, as it crosses the boundary.
export type LaneRuntimeCall =
    | { op: 'runtime'; method: 'executeRecordTool'; name: RecordToolName; parameters: unknown; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'manageTool'; parameters: unknown; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'createToolForAgent'; creation: unknown; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'requestTools'; parameters: unknown; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'listTools'; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'agentManage'; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'agentResult'; parameters: Record<string, unknown>; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'threadSend'; threadId?: string; parameters: Record<string, unknown>; identity: LaneCallIdentity }
    | { op: 'runtime'; method: 'threadList'; identity: LaneCallIdentity }
    // T10 finding S1: a cross-thread READ. The lane replica cannot answer it truthfully -
    // its roster and transcripts are a hello snapshot plus its own work - so the canonical
    // harness resolves the identity and returns the transcript. The pure paging/filtering
    // half of `threadRead` still runs on the LANE (that is the CPU isolation), so only the
    // state read crosses.
    | { op: 'thread:read'; threadId: string; identity: LaneCallIdentity };

// Everything else the authority answers for a lane.
export type LaneAuthorityRequest =
    | LaneRuntimeCall
    | { op: 'lease'; space: IdSpace; count: number }
    | { op: 'memory:window'; keys: string[] }
    // T10 finding M4: the lane asks for the canonical transcript tail it has not adopted.
    // `haveLength` is the prefix THIS replica already holds (and has published), so the
    // answer is exactly what moved - a sibling `threadSend`, or another lane's append.
    | { op: 'transcript:sync'; threadId: string; haveLength: number }
    | { op: 'brain:claim'; agent: string }
    | { op: 'brain:release'; agent: string }
    | { op: 'action:request'; requestId: string; agent: string; threadId?: string; request: HarnessActionRequest }
    // A harness body that is NOT a conversation turn: the operator's direct tool call or
    // slash command (decision D1). It runs on the lane's CPU, and every shared operation it
    // performs comes back through `op:'runtime'` like any other lane work.
    //
    // T10 finding S8: these two are `invoke` FRAME payloads, never requests. The worker
    // executes them on its own CPU (./lane-worker-loop.ts `case 'invoke'`); an `answer`
    // branch for them would have run coordinator CPU for work the lane owns, so it is gone
    // and a lane that raised one gets a named refusal instead.
    | { op: 'execute:tool'; name: string; parameters: unknown }
    | { op: 'execute:command'; line: string };

// The answer envelope. `sync` is the canonical follow-up state a replica must adopt: the
// enabled tool set after a discovery grant, the registry revision after a tool change, and
// the memory digests after a read. Without it a lane would keep declaring tools the
// authority already moved (T3 finding F9/F10).
export type LaneAuthorityAnswer = {
    value?: unknown;
    sync?: {
        enabled?: string[];
        registry?: { name: string; source: string; revision: string; removed: boolean }[];
        identities?: Partial<Record<IdSpace, number>>;
        // T10 finding M5: memory keys the SESSION gained because a tool revision was just
        // installed (the authority scanned that text itself). Every live lane extends its
        // declared window with these and pulls the digests, so a model-created tool's memory
        // write is committed instead of silently dropped by the derivation.
        memoryKeys?: string[];
    };
};

export type LaneAuthorityOptions = {
    // The session's canonical harness. Every write below goes through it.
    harness: Harness;
    // Commit bounds, defaulting to the core's own retention numbers.
    bounds?: Partial<CanonicalBounds>;
    // The memory keys this session's tools may touch (./capability.ts plan).
    memoryKeys?: string[];
    // Broker an owner question: the session store owns the pending map, the view, and the
    // client answer. The authority only awaits the promise and reports the outcome.
    ask?: (request: { requestId: string; agent: string; threadId?: string; request: HarnessActionRequest }) => Promise<HarnessActionChoice>;
    // Called after a registry change is applied, so the host can broadcast it. The metadata
    // is included because a created tool's source is a function body, and a replica needs
    // description/tags/parameters to install the same revision. `memoryKeys` carries the keys
    // the SESSION gained from that revision (T10 finding M5), so every live lane can widen its
    // declared window and fetch the digests instead of dropping the tool's memory writes.
    onRegistryChange?: (change: {
        name: string;
        description?: string;
        tags?: string[];
        parameters?: Record<string, unknown>;
        source: string;
        revision: string;
        removed: boolean;
        memoryKeys?: string[];
    }) => void;
    // Called when the identity ledger moved, so a NEW lane's blueprint inherits it.
    onIdentityChange?: (watermarks: Partial<Record<IdSpace, number>>) => void;
};

export type LaneAuthority = {
    harness: Harness;
    ledger: ReturnType<typeof createIdentityLedger>;
    leases: ReturnType<typeof createWriterLeaseLedger>;
    journal: ReturnType<typeof createCommitJournal>;
    // A lane started at this epoch: open its ordering, and retire an older epoch so a late
    // frame from a dead lane can never move state again.
    openLane: (laneEpoch: number, previousEpoch?: number) => void;
    closeLane: (laneEpoch: number) => void;
    // The blueprint pieces, taken from the CANONICAL harness at hello.
    blueprintIdentities: () => Partial<Record<IdSpace, number>>;
    blueprintSnapshot: () => HarnessSnapshot;
    memoryWindow: (laneEpoch: number, keys?: string[]) => MemoryWindow;
    // Everything the authority does on behalf of one lane.
    answer: (laneEpoch: number, request: LaneAuthorityRequest) => Promise<LaneAuthorityAnswer>;
    commit: (laneEpoch: number, group: MutationGroup) => GroupOutcome;
    // The committed state the lane must adopt: canonical transcript length after an append.
    // Defensive by design: a conversation deleted mid-turn reads as 0 here, and the append
    // that follows is refused with a name rather than throwing inside the dispatch.
    canonicalLengthOf: (threadId: string) => number;
    // T10 finding M4: the canonical transcript itself, in canonical order. Length alone is
    // not a sync primitive - a replica can be behind by N messages it never saw, and the
    // only honest fix is to ship those messages. Throws for an id this harness never had
    // (the routed request surfaces that as a named refusal).
    canonicalTranscriptOf: (threadId: string) => HarnessMessage[];
};

// ---------------------------------------------------------------------------
// Canonical view (the fold target). Rebuilt from a snapshot per group, so a
// rejected op can never be validated against a stale projection.
// ---------------------------------------------------------------------------

const asRecords = (value: unknown): { items: { id: string }[]; nextId: number } => {
    const source = (value ?? { items: [], nextId: 1 }) as { items: { id: string }[]; nextId: number };

    return {
        // Detached: the fold mutates its copy, never the snapshot's arrays.
        items: structuredClone(source.items ?? []),
        nextId: source.nextId ?? 1
    };
};

// The snapshot shape (src/types/index.ts HarnessSnapshot) uses `stores` for the record
// stores and `records` for the todo list; both spellings are read here so a view is total
// whatever the shipped snapshot version names, and a missing section is an empty store
// rather than a crash.
const storesOf = (snapshot: HarnessSnapshot): CanonicalView['stores'] => {
    const section = (snapshot as unknown as { stores?: Record<string, unknown>; records?: Record<string, unknown> });
    const source = { ...(section.records ?? {}), ...(section.stores ?? {}) } as Record<string, unknown>;
    const stores = {} as CanonicalView['stores'];

    for (const name of ['todos', 'profiles', 'chapters', 'locations'] as const) {
        stores[name] = asRecords(source[name]) as CanonicalView['stores'][typeof name];
    }

    return stores;
};

// Threads the authority can address. A HOST thread is a snapshot record; an agent's DEFAULT
// conversation (`agent:<name>`) is derived state whose transcript lives in `agents.<name>`,
// so both are folded into one view: `transcript:append` and `thread:status` need to see the
// same id space the lane sees.
const threadsOf = (snapshot: HarnessSnapshot): CanonicalView['threads'] => {
    const threads: CanonicalView['threads'] = {};
    const source = snapshot as unknown as {
        threads?: { id: string; agent: string; status?: HarnessThreadStatus; sequence?: number; label?: string; ownerThreadId?: string; messages?: HarnessMessage[] }[];
        agents?: Record<string, { messages: HarnessMessage[] }>;
    };

    for (const [name, brain] of Object.entries(source.agents ?? {})) {
        threads[`agent:${name}`] = {
            id: `agent:${name}`,
            agent: name,
            status: 'idle',
            sequence: 0,
            messages: structuredClone(brain.messages ?? [])
        };
    }

    for (const thread of source.threads ?? []) {
        threads[thread.id] = {
            id: thread.id,
            agent: thread.agent,
            status: thread.status ?? 'idle',
            sequence: thread.sequence ?? 0,
            ...(thread.label === undefined ? {} : { label: thread.label }),
            ...(thread.ownerThreadId === undefined ? {} : { ownerThreadId: thread.ownerThreadId }),
            messages: structuredClone(thread.messages ?? [])
        };
    }

    return threads;
};

// The fold view for one commit group.
//
// `resultOwners` (T10 finding M3) is the authority's live "which lane epoch archived this
// invocation" map, copied into the view so the fold can tell a writer updating its own slot
// from a lane colliding into somebody else's. It is authority-owned state: the view gets a
// copy, and only a replayed-and-applied archive writes the live map (see `commit`).
export const canonicalViewOf = (
    harness: Harness,
    memory: Record<string, unknown>,
    resultOwners: ReadonlyMap<string, number> = new Map()
): CanonicalView => {
    const snapshot = harness.snapshot();
    const results: CanonicalView['results'] = {};

    for (const record of (snapshot as unknown as { agentResults?: CanonicalView['results'][string][] }).agentResults ?? []) {
        results[record.invocationId] = record;
    }

    const tools: CanonicalView['tools'] = {};

    for (const created of (snapshot as unknown as { createdTools?: { name: string; source?: string; description?: string }[] }).createdTools ?? []) {
        tools[created.name] = {
            name: created.name,
            source: created.source ?? '',
            // The revision is the digest of the installed source, so a lane's CAS expectation
            // is comparable across processes without shipping a second copy of the text.
            revision: digestMemoryValue(created.source ?? ''),
            replaced: false
        };
    }

    return {
        threads: threadsOf(snapshot),
        stores: storesOf(snapshot),
        results,
        resultOwners: Object.fromEntries(resultOwners.entries()),
        tools,
        createdToolCount: (snapshot as unknown as { createdToolCount?: number }).createdToolCount ?? 0,
        // LIVE map: memory is deliberately not part of a snapshot, so the authority's CAS
        // target is the harness's own object, not a copy of one.
        memory,
        discovery: {
            enabled: [...((harness as unknown as { discoveredTools?: string[] }).discoveredTools ?? [])]
        }
    };
};

// The watermark seeds, taken from the canonical counters. Units are converted
// (`seedFromCounter`) because a store's `nextId` and the run/thread counters mean different
// things - the off-by-one that made the retired merge produce a snapshot the core rejected.
const seedsOf = (view: CanonicalView, harness: Harness): Partial<Record<IdSpace, number>> => {
    const counts = (harness as unknown as { threads?: () => { sequence: number }[] }).threads?.() ?? [];
    const snapshot = harness.snapshot() as unknown as { threadSequence?: number; threadIdSequence?: number };
    const identities: Partial<Record<IdSpace, number>> = {};

    for (const space of ID_SPACES) {
        if (space.startsWith('record:')) {
            const store = view.stores[space.slice(7) as RecordStoreName];

            identities[space] = seedFromCounter(space, store?.nextId ?? 1);
            continue;
        }

        if (space === 'thread') {
            const highest = Math.max(
                snapshot.threadIdSequence ?? 0,
                snapshot.threadSequence ?? 0,
                ...counts.map((thread) => thread.sequence),
                ...Object.keys(view.threads)
                    .filter((id) => id.startsWith('thread-'))
                    .map((id) => Number(id.slice(7)) || 0)
            );

            identities.thread = highest;
            continue;
        }

        if (space === 'createdToolCount') {
            identities.createdToolCount = view.createdToolCount;
            continue;
        }

        const orders = Object.values(view.results);

        identities[space === 'completedOrder' ? 'completedOrder' : 'invocation'] = Math.max(
            0,
            ...orders.map((record) => (space === 'completedOrder' ? record.completedOrder : record.sequence))
        );

        if (space === 'resultSequence') {
            identities.resultSequence = identities.invocation ?? 0;
        }
    }

    return identities;
};

/**
 * Create the authority for one session.
 *
 * `harness.memory.data` is used as the canonical memory map: `HarnessMemory` exposes the
 * live record (src/harness.ts ~1150), which is exactly the object the tools read, so a
 * committed write lands where an inline write would have.
 */
export const createLaneAuthority = (options: LaneAuthorityOptions): LaneAuthority => {
    const { harness } = options;
    const bounds: CanonicalBounds = { ...DEFAULT_BOUNDS, ...(options.bounds ?? {}) };
    const memory = (harness.memory as unknown as { data: Record<string, unknown> }).data;
    // Mutable, and deliberately so: installing a tool revision whose (authority-scanned)
    // text names new memory keys WIDENS the session window, because the scan of the text is
    // the authority's own decision, not a lane's claim. T10 finding M5.
    const declared = new Set(options.memoryKeys ?? []);

    // Which lane epoch archived each invocation id (T10 finding M3). Authority-owned: a
    // fold view gets a copy, and only a replay that LANDED writes this map, so a rolled-
    // back group can never make a lane the owner of a record canonical never received.
    const archiveOwners = new Map<string, number>();

    const view = () => canonicalViewOf(harness, memory, archiveOwners);
    const identities = seedsOf(view(), harness);
    const ledger = createIdentityLedger(identities);
    const leases = createWriterLeaseLedger();
    const journal = createCommitJournal();

    const notifyIdentity = (): void => {
        options.onIdentityChange?.(ledger.watermarks());
    };

    const openLane = (laneEpoch: number, previousEpoch?: number): void => {
        if (previousEpoch !== undefined && previousEpoch !== laneEpoch) {
            leases.dropLane(previousEpoch);
            replaceLaneEpoch(journal, previousEpoch, laneEpoch);
            return;
        }

        journal.open(laneEpoch);
    };

    const closeLane = (laneEpoch: number): void => {
        leases.dropLane(laneEpoch);
        journal.supersede(laneEpoch);

        // T10 finding M3: a retired lane's archived slots become claimable again, so the
        // reborn lane for the SAME conversation (a reclaim, or an authority replacement) may
        // update its own invocation instead of being refused by an epoch that no longer
        // exists. Nothing about the canonical record changes - only who may write it next.
        for (const [invocationId, owner] of [...archiveOwners.entries()]) {
            if (owner === laneEpoch) archiveOwners.delete(invocationId);
        }
    };

    // Which identity space each record tool's store draws from. The mapping is explicit
    // because the tool names and the store names differ (`task` owns `todos`).
    const RECORD_SPACE: Record<RecordToolName, IdSpace> = {
        task: 'record:todos',
        profileManage: 'record:profiles',
        chapterManage: 'record:chapters',
        locationManage: 'record:locations'
    };

    // Fold the canonical store's `nextId` into the ledger after a routed record operation.
    // Units are converted with `seedFromCounter`, since a store counts the NEXT id while the
    // ledger counts the highest ISSUED one.
    const adoptStoreCounter = (name: RecordToolName): void => {
        const space = RECORD_SPACE[name];
        const store = view().stores[space.slice(7) as RecordStoreName];

        if (store === undefined) return;

        ledger.observe(space, seedFromCounter(space, store.nextId));
    };

    // Resolve the caller's Agent from the NAME the lane reported, against the canonical
    // registry. An unknown name resolves to `undefined`, which is what a manual call looks
    // like to the core - the honest reading of "a call whose caller is not in this session".
    const callerFor = (identity: LaneCallIdentity): Agent | undefined => {
        if (identity.agent === undefined) return undefined;

        const agents = (harness as unknown as { agents?: Record<string, Agent> }).agents;

        return agents?.[identity.agent];
    };

    // A fabricated ToolContext for the record stores' `execute(context)`. Only the fields a
    // record tool can read are supplied; the LIVE canonical handle is what `context.harness`
    // must be, because a tool that reaches for the handle must see the session, not a mirror.
    const contextFor = (parameters: unknown, identity: LaneCallIdentity): ToolContext => {
        const agents = (harness as unknown as { agents?: Record<string, unknown> }).agents ?? {};

        return {
            parameters,
            agent: callerFor(identity),
            agents,
            harness,
            threadId: identity.threadId,
            runDepth: identity.runDepth ?? 1
        } as unknown as ToolContext;
    };

    // The enabled tool set the replica must declare on its next model request. Read after a
    // discovery or registry change so the lane and the authority agree without a re-hello.
    const enabledNow = (): string[] => [...((harness as unknown as { discoveredTools?: string[] }).discoveredTools ?? [])];

    // The canonical transcript of one conversation, in canonical order. `threadMessages`
    // resolves BOTH ids a lane uses - a host thread AND an agent's default conversation
    // (`agent:<name>` is a real thread record with the registry agent attached) - so there is
    // no second spelling of "the transcript" for a lane and the coordinator to disagree about.
    const canonicalTranscriptOf = (threadId: string): HarnessMessage[] => harness.threadMessages(threadId);

    // The defensive read the host uses at dispatch. A conversation deleted mid-turn reads 0
    // here rather than throwing, and the append that follows is refused with a name.
    const canonicalLengthOf = (threadId: string): number => {
        try {
            return canonicalTranscriptOf(threadId).length;
        } catch {
            return 0;
        }
    };

    // T10 finding S6: the memory window handed to the fold. An EMPTY session window means
    // "this session declares no keys at all" (the same unrestricted reading `memory:window`
    // already uses), so `undefined` is passed and nothing is refused on that axis; a
    // non-empty window is enforced op-by-op in ./lane-commit.ts.
    const declaredKeysForFold = (): readonly string[] | undefined => (declared.size === 0 ? undefined : [...declared]);

    const answer = async (laneEpoch: number, request: LaneAuthorityRequest): Promise<LaneAuthorityAnswer> => {
        // A retired epoch gets NO answer: its work belongs to a lane that is gone, and an
        // answer would only invite the dead lane to keep writing (T3 finding F9).
        const alive = journal.accepts(laneEpoch, journal.appliedThrough(laneEpoch) + 1);

        if (!alive.ok && alive.code === 'epoch-superseded') {
            throw new Error(`Lane epoch ${laneEpoch} is retired; its requests are no longer answered.`);
        }

        switch (request.op) {
            case 'runtime': {
                // Every method here mutates or reads SESSION-SHARED state, so the canonical
                // harness performs it. `executeRecordTool` needs a context (the core record
                // tools take one), which is why it is fabricated below rather than shipped
                // across the boundary as an argument.
                const runtime = harness.runtime;

                switch (request.method) {
                    case 'executeRecordTool': {
                        const value = await runtime.executeRecordTool(request.name as RecordToolName, contextFor(request.parameters, request.identity));

                        // The core minted the id inside ITS store, so the ledger must adopt
                        // that counter: without this a later lane lease could hand out an id
                        // the authority already used, which is exactly the invalid-snapshot
                        // failure T3 finding F1 reported.
                        adoptStoreCounter(request.name as RecordToolName);

                        return { value, sync: { identities: ledger.watermarks() } };
                    }
                    case 'manageTool': {
                        const value = await runtime.manageTool(callerFor(request.identity), request.parameters);

                        return { value, sync: { enabled: enabledNow() } };
                    }
                    case 'createToolForAgent': {
                        // T10 findings M5/S2: scan the CANDIDATE text before the canonical
                        // install, so a lane cannot put a body into the session that the plan
                        // would have refused at hello. `toolScanTextOf` is the field-correct
                        // reader: a shipped tool is `format: 'module'`, whose text lives in
                        // `moduleText` (the retired code read `.source`, which that format
                        // leaves empty, so every scan in the pipeline was vacuous).
                        const creation = request.creation as ToolCreation;
                        const creationText = toolScanTextOf(creation as unknown as Parameters<typeof toolScanTextOf>[0]);
                        const candidate = assessWorkerToolSurface({
                            name: creation?.name ?? 'created tool',
                            source: creationText
                        });

                        if (candidate.reasons.length > 0) {
                            // An explicit refusal, naming the code and the fix: a silent
                            // install would leave the model's tool unable to run anywhere.
                            throw new Error(
                                `This session cannot create the tool "${String(creation?.name)}" while threadExecution is "worker": ${candidate.reasons
                                    .map((surface) => surface.message)
                                    .join(' ')}`
                            );
                        }

                        // `creation` crossed a boundary as data, so it is asserted against the
                        // core's own shape here; the canonical call validates it for real.
                        const value = (await runtime.createToolForAgent(
                            callerFor(request.identity),
                            creation
                        )) as unknown;
                        const created = value as { name?: string; revision?: string };
                        // The installed text comes from the canonical registry, which is the
                        // only place the compiled revision is known.
                        const installed = created?.name === undefined ? undefined : (harness.toolSource(created.name) as unknown as Parameters<typeof toolScanTextOf>[0] | undefined);
                        const installedText = toolScanTextOf(installed ?? {});
                        // `source` stays the legacy function-body spelling, and `moduleText` is
                        // only set for a module revision: the replica installs whichever one the
                        // canonical harness compiled, never module text handed to the body path.
                        const source = installed?.source ?? '';

                        if (created?.name !== undefined) {
                            // The canonical registry is the only place the installed revision
                            // is fully known: the compiled definition carries the description,
                            // tags and schema, and `toolSource` carries the text.
                            const definition = (harness.tools as Record<string, { description?: string; tags?: readonly string[]; parameters?: Record<string, unknown> } | undefined>)[created.name];
                            // T10 finding M5: the window is recomputed from the revision that is
                            // NOW installed, so a model-created tool's literal memory keys become
                            // committable state instead of a write nobody derives. The candidate
                            // text is the fallback for a registration that captures no revision
                            // (a host-supplied definition), which is the unscannable case the
                            // hello report already keeps as a warning.
                            const scanned = assessMemoryAccess(installedText ?? creationText ?? '');
                            const gained: string[] = [];

                            for (const key of scanned?.keys ?? []) {
                                if (declared.has(key)) continue;

                                declared.add(key);
                                gained.push(key);
                            }

                            const change = {
                                name: created.name,
                                ...(definition?.description === undefined ? {} : { description: definition.description }),
                                ...(definition?.tags === undefined ? {} : { tags: [...definition.tags] }),
                                ...(definition?.parameters === undefined ? {} : { parameters: structuredClone(definition.parameters) }),
                                source,
                                ...(installed?.moduleText === undefined ? {} : { moduleText: installed.moduleText }),
                                ...(installed?.dependencies === undefined || installed.dependencies.length === 0 ? {} : { dependencies: structuredClone(installed.dependencies) }),
                                ...(gained.length === 0 ? {} : { memoryKeys: gained }),
                                revision: created.revision ?? digestMemoryValue(installedText ?? source),
                                removed: false
                            };

                            // The canonical harness charged its own lifetime budget, so the
                            // ledger must adopt that count: without this a lane could lease ids
                            // past a budget the authority already spent (T3 finding F3).
                            ledger.observe('createdToolCount', view().createdToolCount);
                            options.onRegistryChange?.(change);

                            return {
                                value,
                                sync: {
                                    registry: [change],
                                    enabled: enabledNow(),
                                    identities: ledger.watermarks(),
                                    ...(gained.length === 0 ? {} : { memoryKeys: gained })
                                }
                            };
                        }

                        return { value, sync: { enabled: enabledNow() } };
                    }
                    case 'requestTools': {
                        const value = await runtime.requestTools(callerFor(request.identity), request.parameters);

                        return { value, sync: { enabled: enabledNow() } };
                    }
                    case 'listTools':
                        return { value: runtime.listTools() };
                    case 'agentManage':
                        return { value: runtime.agentManage() };
                    case 'agentResult':
                        return { value: runtime.agentResult(request.parameters) };
                    case 'threadSend':
                        return { value: runtime.threadSend(callerFor(request.identity) as never, request.threadId, request.parameters) };
                    case 'threadList':
                        return { value: runtime.threadList(request.identity.threadId) };
                    default:
                        throw new Error(`Unknown routed runtime method: ${JSON.stringify((request as { method?: string }).method)}.`);
                }
            }

            case 'lease': {
                const allocated = ledger.allocate(request.space, request.count, laneEpoch);

                if (!allocated.ok) throw new Error(allocated.fault.message);

                notifyIdentity();

                return { value: allocated.lease satisfies IdentityLease, sync: { identities: ledger.watermarks() } };
            }

            case 'memory:window': {
                const keys = request.keys.filter((key) => declared.size === 0 || declared.has(key));

                return { value: captureMemoryWindow(memory, keys, laneEpoch) };
            }

            case 'brain:claim': {
                const claimed = leases.claim({ kind: 'agent', name: request.agent }, laneEpoch);

                return { value: claimed };
            }

            case 'brain:release':
                return { value: leases.release({ kind: 'agent', name: request.agent }, laneEpoch) };

            // T10 finding S1: one canonical conversation, as data. The identity block and the
            // transcript come from the CANONICAL harness, so a lane reading a sibling thread -
            // or one another lane created - sees the session, not its private replica. The
            // paging, regex filtering and byte budgeting stay on the lane (the CPU work
            // isolation exists for), so the coordinator only answers the read.
            case 'thread:read': {
                const record = harness.thread(request.threadId);

                if (record === undefined) {
                    throw new Error(`Thread "${request.threadId}" has no record in this session; it was never created, or it was deleted.`);
                }

                const messages = harness.threadMessages(request.threadId);

                return { value: { threadId: request.threadId, record, messages, length: messages.length } };
            }

            // T10 finding M4: the transcript delta a replica is missing. `haveLength` is the
            // canonical prefix this lane already adopted (and published), so the answer is
            // exactly what moved since: a sibling `threadSend`, another lane's append, or a
            // coordinator transcript edit. When canonical got SHORTER than the lane's base
            // (a rewrite/reset), the lane cannot append a delta honestly, so the answer carries
            // the whole transcript plus `rebased` and the replica replaces itself.
            case 'transcript:sync': {
                const messages = canonicalTranscriptOf(request.threadId);
                const have = Math.max(0, Math.trunc(request.haveLength));

                if (have > messages.length) {
                    return {
                        value: {
                            threadId: request.threadId,
                            fromLength: 0,
                            length: messages.length,
                            rebased: true,
                            messages
                        }
                    };
                }

                return {
                    value: {
                        threadId: request.threadId,
                        fromLength: have,
                        length: messages.length,
                        messages: messages.slice(have)
                    }
                };
            }

            case 'action:request': {
                if (options.ask === undefined) {
                    throw new Error(
                        `This session has no owner-question answerer, so the actionRequest tool cannot be used from a lane worker (threadExecution "inline" for a session whose questions are answered in-process).`
                    );
                }

                const choice = await options.ask({
                    requestId: request.requestId,
                    agent: request.agent,
                    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
                    request: request.request
                });

                return { value: choice };
            }

            // T10 finding S8: no answer branch. The worker executes an operator action on its
            // OWN CPU (decision D1), so these two arrive as `invoke` frames, never as requests.
            // Answering them here would have run a harness body on the coordinator - the exact
            // work isolation the mode promises - so a lane that raises one gets a named refusal.
            case 'execute:tool':
            case 'execute:command':
                throw new Error(
                    `"${request.op}" is an operator invocation frame, not a request: a lane worker executes it on its own CPU, and the authority answers only the shared operation it raises.`
                );

            default:
                throw new Error(`Unknown lane authority request: ${JSON.stringify((request as { op?: string }).op)}.`);
        }
    };

    // Replay ONE applied op onto the canonical harness. `effect` is what the receipt
    // reported; a divergence between the fold and the live object is reported, not hidden.
    const replay = (
        laneEpoch: number,
        mutation: Parameters<typeof applySharedMutation>[1],
        receiptStatus: string
    ): { ok: boolean; digest?: string; length?: number; reason?: string } => {
        if (receiptStatus !== 'applied') return { ok: true };

        switch (mutation.kind) {
            case 'transcript:append': {
                try {
                    const messages = harness.appendThreadMessages(mutation.threadId, mutation.messages, mutation.fromLength);

                    return { ok: true, length: messages.length, digest: digestMemoryValue(messages) };
                } catch (error) {
                    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
                }
            }

            case 'thread:status': {
                try {
                    const record = harness.setThreadStatus(mutation.threadId, mutation.status);

                    return { ok: true, digest: expectsDigestOf({ status: record.status, label: record.label }) };
                } catch (error) {
                    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
                }
            }

            case 'result:archive': {
                try {
                    // The authority assigns the real completion order (leased ids only have to
                    // be unique; ordering is decided where the ordering counter lives).
                    const archived = harness.archiveInvocation({
                        invocationId: mutation.invocationId,
                        sequence: mutation.sequence,
                        agent: mutation.agent,
                        role: mutation.role,
                        kind: mutation.runKind,
                        status: mutation.status,
                        ...(mutation.content === undefined ? {} : { content: mutation.content }),
                        ...(mutation.error === undefined ? {} : { error: mutation.error })
                    });

                    // The digest the lane compares against is `archiveDigestOf`, the projection
                    // over the fields a WRITER owns: the authority reassigned `completedOrder`
                    // just above, and a digest of the whole stored record would never match the
                    // lane's own view of its result (T10 finding M3).
                    return { ok: true, digest: archiveDigestOf(archived.record) };
                } catch (error) {
                    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
                }
            }

            case 'memory:set': {
                const outcome = applyMemoryWrite(memory, { key: mutation.key, expected: mutation.expects, value: mutation.value });

                return outcome.applied
                    ? { ok: true, digest: outcome.digest }
                    : { ok: false, digest: outcome.digest, reason: outcome.reason ?? 'the canonical value moved' };
            }

            case 'memory:delete': {
                const outcome = applyMemoryWrite(memory, { key: mutation.key, expected: mutation.expects, remove: true });

                return outcome.applied
                    ? { ok: true, digest: outcome.digest }
                    : { ok: false, digest: outcome.digest, reason: outcome.reason ?? 'the canonical value moved' };
            }

            default:
                // Registry, record-store and discovery changes are already applied by the
                // routed request that produced them; there is nothing to replay.
                return { ok: true };
        }
    };

    // The code a LIVE write refuses with, per op kind (T10 finding S5's sibling: a receipt
    // whose code names the wrong conflict sends the lane to the wrong fix).
    const liveRejectionCodeOf = (mutation: Parameters<typeof applySharedMutation>[1]): MutationRejectionCode => {
        if (mutation.kind === 'memory:set' || mutation.kind === 'memory:delete') return 'stale-memory';
        if (mutation.kind === 'transcript:append') return 'prefix-moved';
        if (mutation.kind === 'thread:status' || mutation.kind === 'result:archive') return 'stale-record';

        return 'invalid-mutation';
    };

    const commit = (laneEpoch: number, group: MutationGroup): GroupOutcome => {
        const acceptance = journal.accepts(laneEpoch, group.seq);

        if (!acceptance.ok) {
            // T10 finding S5: pass the journal's actual reason through. A duplicate send, a
            // group behind this lane's own watermark, and a retired epoch are three different
            // situations - the first two are recoverable by the lane, and the message the
            // retired code produced told it its epoch was dead either way.
            const code: MutationRejectionCode = acceptance.code ?? 'epoch-superseded';
            const message =
                code === 'seq-duplicate'
                    ? `Commit ${group.seq} was already settled for lane ${laneEpoch}; the reply is the earlier receipt, and the base behind it already moved.`
                    : code === 'seq-behind'
                      ? `Commit ${group.seq} is behind lane ${laneEpoch}'s applied watermark at ${journal.appliedThrough(laneEpoch)}; a lane never rewinds canonical state, so advance the seq.`
                      : `Lane ${laneEpoch} is retired; its commits are no longer applied.`;

            return {
                seq: group.seq,
                status: 'rejected',
                complete: false,
                receipts: group.ops.map((_, index) => ({
                    opId: index,
                    seq: group.seq,
                    laneEpoch,
                    status: 'rejected',
                    rejection: { code, message }
                }))
            };
        }

        const folded = applyMutationGroup(view(), group, {
            laneEpoch,
            leases,
            identity: ledger,
            bounds,
            declaredKeys: declaredKeysForFold()
        });
        const outcome = folded.outcome;

        // T10 finding M2, step 1: a group the FOLD could not complete moves nothing live. The
        // staged view was thrown away, so replaying the individually-applied receipts onto the
        // canonical harness would half-apply a group whose lane has been told (by `complete:
        // false`) to adopt nothing - the live object and every later base then disagree
        // permanently, which is the divergence and the livelock the review measured.
        if (!outcome.complete) {
            const receipts = rolledBackReceipts(outcome.receipts, group.ops, laneEpoch, group.seq);

            journal.settle(laneEpoch, group.seq, false);
            notifyIdentity();

            return { ...outcome, receipts, complete: false };
        }

        // T10 finding M2, step 2: the fold accepted everything, so replay in order and stop at
        // the first op the LIVE object disagrees with. Nothing after that op is written, so the
        // half-write is bounded to a prefix, and every receipt names what really happened:
        //   - ops before the break landed -> `applied`, with the canonical digest/length, so the
        //     lane adopts them and its base matches the live object;
        //   - the breaking op -> refused with its real code and the canonical fact in `effect`;
        //   - everything after it -> `group-rolled-back`, with no effect, because it never landed.
        const receipts: MutationReceipt[] = [];
        let brokeAt = -1;

        outcome.receipts.forEach((receipt, index) => {
            const mutation = group.ops[index];

            if (brokeAt >= 0) {
                receipts.push({
                    opId: receipt.opId,
                    seq: group.seq,
                    laneEpoch,
                    status: 'rejected',
                    rejection: {
                        code: 'group-rolled-back',
                        message: `Commit ${group.seq} stopped at operation ${brokeAt}; operation ${receipt.opId} was never written.`,
                        }
                });

                return;
            }

            const applied = replay(laneEpoch, mutation, receipt.status);

            if (applied.ok) {
                // The archive landed on the canonical harness, so THIS epoch owns that slot from
                // now on - the rule the fold needs to allow its next turn to replace it (M3).
                if (mutation.kind === 'result:archive') archiveOwners.set(mutation.invocationId, laneEpoch);

                receipts.push({
                    ...receipt,
                    effect: {
                        ...receipt.effect,
                        ...(applied.digest === undefined ? {} : { digest: applied.digest }),
                        ...(applied.length === undefined ? {} : { length: applied.length })
                    }
                });

                return;
            }

            brokeAt = index;

            receipts.push({
                ...receipt,
                status: 'rejected' as const,
                rejection: {
                    code: liveRejectionCodeOf(mutation),
                    message: applied.reason ?? 'the canonical state moved between the fold and the write'
                },
                effect: { ...receipt.effect, ...(applied.digest === undefined ? {} : { digest: applied.digest }) }
            });
        });

        const complete = brokeAt === -1;

        // Only a wholly landed group moves the applied watermark, which is what the terminal
        // gate (journal.mayPublishSuccess) reads; a partial group leaves it where it was (F7)
        // and the lane re-derives against the canonical facts the receipts just carried.
        journal.settle(laneEpoch, group.seq, complete);
        notifyIdentity();

        return { ...outcome, receipts, complete };
    };

    return {
        harness,
        ledger,
        leases,
        journal,
        openLane,
        closeLane,
        blueprintIdentities: () => ledger.published(),
        blueprintSnapshot: () => harness.snapshot(),
        memoryWindow: (laneEpoch, keys) => captureMemoryWindow(memory, keys ?? [...declared], laneEpoch),
        answer,
        commit,
        canonicalLengthOf,
        canonicalTranscriptOf
    };
};

// The identity block a lane's hello carries: the PUBLISHED counters (core units), which the
// replica feeds straight into `harness.reserveIdentity`.
export const blueprintIdentitiesOf = (authority: LaneAuthority): Partial<Record<IdSpace, number>> =>
    authority.blueprintIdentities();

// The reservation a worker applies BEFORE it restores, derived from the blueprint's
// identities. A store's `nextId` is not here: `restore()` raises it from the snapshot, and
// the snapshot's own ids already satisfy the core validator (./lane-identity.ts units).
export const reservationOf = (identities: Partial<Record<IdSpace, number>>): HarnessIdentityReservation => ({
    ...(identities.invocation === undefined && identities.resultSequence === undefined
        ? {}
        : { runSequence: Math.max(identities.invocation ?? 0, identities.resultSequence ?? 0) }),
    ...(identities.thread === undefined ? {} : { threadSequence: identities.thread, threadIdSequence: identities.thread }),
    ...(identities.completedOrder === undefined ? {} : { invocationCompletionSequence: identities.completedOrder })
});
