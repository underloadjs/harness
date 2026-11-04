// Authority-owned identity: every mutable id in a session is minted or LEASED by the
// coordinator, never by a lane replica.
//
// WHY THIS MODULE REPLACED THE ALLOCATION-BLOCK MERGE (T3 findings F1/F2/F3)
// -------------------------------------------------------------------------
// A lane worker holds a harness replica so its agent loop can run synchronously, but
// a replica MINTS FROM ITS OWN COUNTERS: `threadSequence`/`threadIdSequence`
// (harness.ts ~3264), each record store's `nextId` (core/snapshot-validation.ts ~173
// requires `nextId > largest id`), the invocation `sequence` and `completedOrder`
// (harness.ts ~2563), and the lifetime `createdToolCount` budget. Two replicas
// restored from one snapshot therefore mint the SAME id for different content. A
// fixed block start does not fix that, and the reviewer proved it: a block-rebased
// replica minted ids 10001-10003, the fold published `nextId: 10001` (the block start,
// not one past the largest), and the real core validator REJECTED the snapshot -
// `todo state.nextId must be greater than the largest id (10003); received 10001`.
// Two lanes also both archived `invocationId: "1"`, so one terminal result simply
// disappeared, and two created tools merged to `createdToolCount: 1` - a lifetime
// budget that quietly refunded itself.
//
// THE UNITS, STATED EXACTLY (the off-by-one here is a correctness bug, not style)
// ------------------------------------------------------------------------------
//   - the ledger's WATERMARK is always "the highest id already handed out in this
//     space"; 0 means nothing has been minted;
//   - the CORE stores different units per space, so publishing back is explicit:
//       * a record store's `nextId` is the NEXT id to mint  -> `publishCounter` = watermark + 1
//         (which is exactly the validator's `nextId > largest id` rule);
//       * `threadSequence` / an invocation `sequence` / a `completedOrder` are the LAST
//         used value (the core does `++sequence` before use)  -> `publishCounter` = watermark.
//     Seeding therefore converts too: `seedFromCanonical({nextId})` = nextId - 1, and a
//     thread/invocation seed is the snapshot value itself.
//   - ids are never reused and never lowered, so gaps are acceptable (decision D5)
//     while a collision is not.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
//   - id FORMATS per space are `idOf`, which mirrors core/thread.ts (`thread-N`) and
//     the decimal ids the record stores use; the prefixes stay owned by the core.
//   - no collision bookkeeping: leases make collisions impossible by construction, so
//     there is nothing to merge and nothing to resolve.
//
// Cross-references:
//   - ./lane-commit.ts  - the ops that consume these ids and publish the counters
//   - ./protocol.ts     - `lease:request` / `lease.grant` frames
//   - ../../core/thread.ts - THREAD_HOST_PREFIX, MAX_THREAD_RECORDS (256)
//   - ../../core/snapshot-validation.ts ~173 - the `nextId > largest id` rule
//   - ../../core/agent-limits.ts - AGENT_RESULT_RETENTION (64)
//   - ../../core/creation.ts - DEFAULT_CREATED_TOOLS_LIMIT (32)

import { AGENT_RESULT_RETENTION, DEFAULT_CREATED_TOOLS_LIMIT, MAX_THREAD_RECORDS } from '../../core';

// Every id space whose counter otherwise lives inside a harness replica.
// `record:<store>` exists because a model mints records from inside a lane; the rest
// are minted by the run loop itself (a delegation child, a fork, a terminal result).
export const ID_SPACES = [
    'thread',
    'invocation',
    'resultSequence',
    'completedOrder',
    'createdToolCount',
    'record:todos',
    'record:profiles',
    'record:chapters',
    'record:locations'
] as const;

export type IdSpace = (typeof ID_SPACES)[number];

export const isIdSpace = (value: unknown): value is IdSpace =>
    typeof value === 'string' && (ID_SPACES as readonly string[]).includes(value);

// How the core counts this space, i.e. what the authority must publish after a lane
// used ids. Getting this wrong by one is what produced F1's rejected snapshot.
export type CounterSemantics = 'next-id' | 'last-used';

const COUNTER_SEMANTICS: Record<IdSpace, CounterSemantics> = {
    // A store's `nextId` is the value the NEXT add will use.
    'record:todos': 'next-id',
    'record:profiles': 'next-id',
    'record:chapters': 'next-id',
    'record:locations': 'next-id',
    // The core increments before use, so the persisted field is the last used value.
    thread: 'last-used',
    invocation: 'last-used',
    resultSequence: 'last-used',
    completedOrder: 'last-used',
    // A spent-tool count is a count of consumed creations, i.e. also "last used".
    createdToolCount: 'last-used'
};

export const counterSemanticsOf = (space: IdSpace): CounterSemantics => COUNTER_SEMANTICS[space];

// The value the authority writes into the canonical state for this space.
export const publishCounter = (space: IdSpace, watermark: number): number =>
    COUNTER_SEMANTICS[space] === 'next-id' ? watermark + 1 : watermark;

// The watermark that corresponds to a counter read out of a snapshot.
export const seedFromCounter = (space: IdSpace, counter: number): number =>
    COUNTER_SEMANTICS[space] === 'next-id' ? Math.max(0, counter - 1) : counter;

// Bounds that exist in the core and must be refused BEFORE a lane mints past them.
export const ID_SPACE_CAPS: Partial<Record<IdSpace, number>> = {
    thread: MAX_THREAD_RECORDS,
    completedOrder: AGENT_RESULT_RETENTION,
    resultSequence: AGENT_RESULT_RETENTION,
    createdToolCount: DEFAULT_CREATED_TOOLS_LIMIT
};

// The largest id the ledger will ever hand out: past it `+ 1` stops being exact, so
// the ledger refuses rather than minting a possibly-duplicate float.
const ID_LIMIT = Number.MAX_SAFE_INTEGER;

// One contiguous grant: the ids are `start .. start + count - 1`.
export type IdentityLease = {
    space: IdSpace;
    start: number;
    count: number;
    // The epoch of the lane holding it. A lease's unused tail is simply lost when the
    // lane dies (ids are never reused), which is the safe direction.
    laneEpoch: number;
};

export type IdentityFault = {
    code: 'unknown-space' | 'exhausted' | 'invalid-count' | 'stale-observe';
    message: string;
};

export type IdentityAllocation =
    | { ok: true; lease: IdentityLease; watermark: number; published: number }
    | { ok: false; fault: IdentityFault };

export type IdentityLedger = {
    /** Mint `count` ids for `space`. */
    allocate: (space: IdSpace, count: number, laneEpoch: number) => IdentityAllocation;
    /** Fold in an id the AUTHORITY itself minted, so a lane is never handed it. */
    observe: (space: IdSpace, value: number) => IdentityFault | undefined;
    /** The highest id already issued in this space. */
    watermarkOf: (space: IdSpace) => number;
    /** What the canonical counter for this space must now hold. */
    publishedOf: (space: IdSpace) => number;
    watermarks: () => Partial<Record<IdSpace, number>>;
    published: () => Partial<Record<IdSpace, number>>;
    capOf: (space: IdSpace) => number | undefined;
    withCap: (space: IdSpace, cap: number) => void;
};

/**
 * Create the coordinator's identity ledger.
 *
 * `observed` holds WATERMARKS (highest id already issued), not core counters - use
 * `seedFromCounter` when reading a snapshot, which is what the session layer does at
 * `hello` and after every applied receipt.
 */
export const createIdentityLedger = (
    observed: Partial<Record<IdSpace, number>> = {},
    caps: Partial<Record<IdSpace, number>> = ID_SPACE_CAPS
): IdentityLedger => {
    const watermarks = new Map<IdSpace, number>();
    const spaceCaps = new Map<IdSpace, number | undefined>(Object.entries(caps) as [IdSpace, number | undefined][]);

    const currentOf = (space: IdSpace): number => watermarks.get(space) ?? 0;

    for (const [space, value] of Object.entries(observed)) {
        if (isIdSpace(space) && Number.isFinite(value)) watermarks.set(space, Math.max(0, Math.trunc(value)));
    }

    const allocate = (space: IdSpace, count: number, laneEpoch: number): IdentityAllocation => {
        if (!isIdSpace(space)) {
            return {
                ok: false,
                fault: {
                    code: 'unknown-space',
                    message: `Unknown identity space "${String(space)}"; mint ids through one of: ${ID_SPACES.join(', ')}.`
                }
            };
        }

        if (!Number.isInteger(count) || count < 1) {
            return {
                ok: false,
                fault: {
                    code: 'invalid-count',
                    message: `An identity lease must request at least one id; ${space} requested ${JSON.stringify(count)}.`
                }
            };
        }

        const issued = currentOf(space);
        const highest = issued + count;
        const cap = spaceCaps.get(space);

        if (highest > ID_LIMIT) {
            return {
                ok: false,
                fault: { code: 'exhausted', message: `The ${space} identity space is exhausted at ${issued}.` }
            };
        }

        if (cap !== undefined && highest > cap) {
            return {
                ok: false,
                fault: {
                    code: 'exhausted',
                    message: `The ${space} identity space holds at most ${cap} ids; ${issued} are already used and ${count} were requested.`
                }
            };
        }

        // The watermark moves by what was TAKEN. A store's published counter is one
        // past it, which is the invariant the core validates (F1).
        watermarks.set(space, highest);

        return {
            ok: true,
            lease: { space, start: issued + 1, count, laneEpoch },
            watermark: highest,
            published: publishCounter(space, highest)
        };
    };

    const observe = (space: IdSpace, value: number): IdentityFault | undefined => {
        if (!isIdSpace(space)) {
            return { code: 'unknown-space', message: `Unknown identity space "${String(space)}".` };
        }

        if (!Number.isInteger(value) || value < 0) {
            return {
                code: 'stale-observe',
                message: `Observed ${space} watermark must be a non-negative integer; received ${JSON.stringify(value)}.`
            };
        }

        const current = currentOf(space);

        // A LOWER value never lowers the watermark: the ledger does not reuse ids, so
        // an old observation cannot hand out an id somebody already holds.
        if (value < current) {
            return {
                code: 'stale-observe',
                message: `Observed ${space} watermark ${value} is behind the ledger at ${current}; the ledger stays at ${current} so no id is reused.`
            };
        }

        watermarks.set(space, value);

        return undefined;
    };

    return {
        allocate,
        observe,
        watermarkOf: currentOf,
        publishedOf: (space) => publishCounter(space, currentOf(space)),
        watermarks: () => Object.fromEntries([...watermarks.entries()]) as Partial<Record<IdSpace, number>>,
        published: () =>
            Object.fromEntries([...watermarks.entries()].map(([space, value]) => [space, publishCounter(space, value)])) as Partial<
                Record<IdSpace, number>
            >,
        capOf: (space) => spaceCaps.get(space),
        withCap: (space, cap) => {
            spaceCaps.set(space, cap);
        }
    };
};

// Spell an id the way the core does, so a lane and the authority can never disagree
// about identity strings (core/thread.ts owns the prefixes; this mirrors them).
export const idOf = (space: IdSpace, value: number): string =>
    space === 'thread' ? `thread-${value}` : String(value);

// The counter patch an applier publishes after a lane touched these spaces. Passing
// THIS (never a block start) is what keeps every core snapshot validator true.
export const publishedPatchOf = (ledger: IdentityLedger, touched: readonly IdSpace[]): Partial<Record<IdSpace, number>> =>
    Object.fromEntries(touched.map((space) => [space, ledger.publishedOf(space)])) as Partial<Record<IdSpace, number>>;
