// Typed lifecycle hook bus (R2/R3 plugins).
//
// WHY A SEPARATE BUS INSTEAD OF `report.progress`
// ------------------------------------------------
// `report.progress` is an OUTPUT mirror: one callback that sees every event frame and
// must not change anything. A plugin hook is an INPUT: it can rewrite the request
// about to leave the harness (`turn.before`), decide what happens to the run
// (`HarnessTurnDecision`), and it runs at a point where the run is parked and waiting.
// Those need different failure rules, so they live in different places:
//
//   - progress: a throwing reporter FAILS the run (harness.ts `emit`), because a live
//     consumer that lost sync must be visible;
//   - a hook: a throwing handler is SKIPPED and the run continues (fail-open, below),
//     because an optional extension must never be able to break a conversation.
//
// THE RULES
// ---------
//   1. SEQUENTIAL. Handlers run one at a time, awaited, in dispatch order: the
//      `priority` of the registration (higher first, default 0), then REGISTRATION
//      ORDER within one priority. A compaction hook and a logging hook interleaving
//      would make the request nondeterministic, and `turn.before` overrides are LAST
//      NON-EMPTY WINS, which only means something with a defined order (R2: an
//      operator reordering `configuration.plugins` must not silently change which
//      policy wins — that is what `priority` is for).
//   2. FAIL-OPEN. A handler that throws (sync or async), rejects, outlives its
//      `timeoutMs` budget, or returns a decision this contract cannot parse is DROPPED;
//      the remaining handlers still run and the round still resolves. This is the whole
//      reason `emit` never rejects — and why every drop is REPORTED through
//      `onHandlerError` (rule 8), because fail-open without a reporter is a silent
//      policy failure.
//   3. SNAPSHOT ITERATION. `emit` walks a copy, so a handler that subscribes or
//      unsubscribes during an emit cannot mutate the loop it is part of (and cannot
//      make a later handler skip).
//   4. SYNC POINTS EXIST. Thread create/delete/stop/pause happen inside synchronous
//      handle methods that a caller cannot await. `fire()` covers those: it starts the
//      handlers in order and swallows everything, including a rejected promise a
//      handler returned anyway. A sync emitter that awaited would have turned
//      `harness.createThread(...)` into a promise, which is exactly the shape change
//      the plugin host has always refused.
//   5. EMPTY IS FREE — AND THE EMITTER MUST PROVE IT. `has(event)` lets a call site
//      skip the emit entirely, which matters beyond cost: `await`ing a resolved promise
//      still yields a microtask, and the harness interleaves a delegated child's run
//      with its parent's event frames on exactly those boundaries. An unguarded
//      `await emit(...)` therefore changes OBSERVABLE event order even with zero plugins
//      installed (the server's delegation-order test caught this). Every harness emit
//      site is written `if (bus.has(event)) await bus.emit(...)`, and the factory payload
//      form keeps the argument construction behind the same check.
//   6. SUBSCRIBED-YET-INERT IS ALSO FREE — `emitMaybeSync`. Rule 5 stops covering cost
//      as soon as a hook becomes PERMANENT: the shipped `context-compaction` plugin
//      always registers `turn.before`, and on an under-limit turn (i.e. almost every
//      turn in production) its handler returns synchronously. `has()` is then true, so
//      the await happens anyway and the ordering loss returns. `emitMaybeSync` is the
//      answer: it runs the same sequential, fail-open round and returns
//      `{ sync: true, value }` while every handler stayed synchronous, switching to
//      `{ sync: false, promise }` only at the FIRST handler that produced a thenable.
//      A call site can therefore apply the result with no `await` on the hot path —
//      which is exactly the pre-plugin boundary `src/server/queue.test.ts` pins.
//      Rule 6 is also why the T1 additions are shaped the way they are: the priority
//      sort is SKIPPED entirely when nothing in this bus uses a priority or a wildcard
//      (`orderedDispatch`), a timeout timer is armed ONLY for a handler that returned a
//      thenable, and a decision costs one property read. None of the three may put an
//      `await` on the sync branch.
//   7. A WILDCARD IS AN OBSERVER, NOT A PARTY. `on('*')` receives every event the
//      catalogue marks deliverable, as the `{ event, payload }` discriminated union
//      (../types `HarnessWildcardEventContext`), and its result is DISCARDED — an audit
//      plugin must not rewrite a request by accident. `live()` reports a wildcard as the
//      exact set of events it will be delivered, so the Plugins pane's live-vs-declared
//      comparison keeps telling the truth (T1.2).
//   8. EVERY DROP IS REPORTED. `onHandlerError` fires once per handler that was
//      dropped, with a `kind` when the reason was NOT a throw (`'timed-out'`,
//      `'invalid-decision'`). Absent a reporter the drop is still silent — but
//      harness.ts always installs one and routes it to `report.diagnostic` (T1.5), so
//      in production a broken plugin is never invisible.
//
// Cross-references:
//   - ../types               — HarnessLifecycleEvent / Payloads / Handler, HarnessHookResult,
//                              HarnessTurnDecision, HarnessHookOptions, HarnessHookSubscribe
//   - ./host.ts              — wraps `on` per plugin and owns this bus's lifetime
//   - ../harness.ts          — the only emitter (createThreadState, runAgent, requestTurn
//                              (`turn.before` via `emitMaybeSync`), launchToolCall,
//                              launchThreadFork, launchActionRequest, deliverTask,
//                              scheduler onWake, notifyStateChange (`host.state_change`
//                              via `fire`), dispose (`harness.dispose`))

import type {
    HarnessLifecycleEvent,
    HarnessLifecycleHandler,
    HarnessLifecyclePayloads,
    HarnessMessage,
    HarnessPluginApi,
    HarnessTurnDecision,
    HarnessWildcardEventContext,
    HarnessWildcardHandler
} from '../types';

// Diagnostics for a handler that was dropped. The harness does not fail a run for this,
// so without a reporter the failure would be invisible; the option exists so a host (or
// a test) can observe it.
export type HarnessHookErrorContext = {
    event: HarnessLifecycleEvent;
    owner: string;
    error: unknown;
    // Absent = the handler threw or rejected (the historical shape of this context, and
    // the common case). Present = the bus itself dropped the handler for a contract
    // reason, and `error` is the synthetic Error describing it:
    //   'timed-out'        — it outlived `timeoutMs` (rule 2 / rule 6).
    //   'invalid-decision' — it returned a `decision` the T2 contract cannot parse.
    kind?: 'timed-out' | 'invalid-decision';
};

// The wildcard key. NOT a member of HarnessLifecycleEvent (it is a subscription form,
// not an event), so the registrations map holds it as a sibling key and every dispatch
// path decides separately whether it joins.
const WILDCARD = '*';

// Which events a `'*'` subscription is DELIVERED. Keyed exhaustively by the union, so
// adding an event to `HarnessLifecycleEvent` breaks typecheck HERE until its author
// decides — the F3 complaint ("an audit plugin learns nothing about events added
// later") cannot come back silently.
//
// `host.state_change` is the one `false`: the host's persistence plane fires on every
// transcript/tool/thread mutation, so putting it on the default fan-out would hand an
// audit plugin a handler on every tool execution (T1.7). Subscribe to it by name.
const WILDCARD_DELIVERABLE: Record<HarnessLifecycleEvent, boolean> = {
    'thread.created': true,
    'thread.started': true,
    'thread.paused': true,
    'thread.resumed': true,
    'thread.stopped': true,
    'thread.idle': true,
    'thread.deleted': true,
    'run.started': true,
    'run.finished': true,
    'run.failed': true,
    'turn.before': true,
    'turn.after': true,
    'tool.before': true,
    'tool.after': true,
    'async.pending': true,
    'async.drained': true,
    'host.state_change': false,
    'harness.dispose': true
};

// One subscription. `owner` is the plugin name (diagnostics only) and `api` is the
// per-plugin api handed back inside `turn.before`, so a handler sees ITS OWN scoped
// settings rather than another plugin's.
type HookEntry = {
    owner: string;
    api?: HarnessPluginApi;
    // T1.3 — higher runs first; default 0. `seq` is the monotonic registration stamp
    // that makes "stable within a priority" mean something across the whole bus.
    priority: number;
    // T1.4 — per-handler budget; undefined = unbounded (the historical behaviour).
    timeoutMs?: number;
    seq: number;
    // True for a `'*'` registration: it receives the `{ event, payload }` envelope and
    // its result is ignored (rule 7).
    wildcard: boolean;
    // Stored type-erased: the map keys the event, and the ONLY way a caller reaches a
    // handler is through the typed `on`/`emit` pair above, which cannot mix them.
    handler: (payload: never) => unknown;
};

// What a caller passes to `on`. The two T1 options ride the SAME object as the
// historical `owner`/`api` so there is one registration form.
export type HarnessHookRegistration = {
    owner: string;
    api?: HarnessPluginApi;
    priority?: number;
    timeoutMs?: number;
};

// Merged result of one emit. Only `turn.before` can produce a transcript or a decision;
// every other event's result is an empty object, which callers ignore.
//
// T2.2 — the ONE reducer for a round. `transcript` is the request the round decided
// (last non-empty wins) and `decision` is the run-level action the round decided
// (last wins, `continue` included, so a later plugin can clear an earlier park/stop).
// They are independent by rule 3 of the precedence list: a `pause`/`stop` composes
// WITH a transcript override rather than replacing it.
export type HarnessMergedHookResult = {
    transcript?: readonly HarnessMessage[];
    decision?: HarnessTurnDecision;
};

// One round's outcome, told apart by a discriminant instead of by `await`: a caller
// that gets `{ sync: true }` applies the value on the SAME tick, with no microtask
// boundary, while `{ sync: false }` means a handler did real work and the boundary is
// the point. This is the mechanic behind rule 6 — a permanent hook that is currently
// inert costs exactly nothing, which `await`-only dispatch cannot promise.
export type HarnessMaybeAsync<T> =
    | { sync: true; value: T }
    | { sync: false; promise: Promise<T> };

// A payload may be given outright or as a factory. The factory form exists for two
// reasons that both matter at `turn.before`:
//   - it is only called when the event actually HAS listeners (rule 5: an unused hook
//     costs nothing), and
//   - it is called ONCE PER HANDLER, so a handler that runs after another handler has
//     already rewritten something observes the CURRENT value instead of a snapshot
//     taken before the round. Hook order is only observable if later handlers can see
//     what earlier ones did.
// The factory receives the owning plugin's api (when the bus has one) so a context
// object can be built with the right api baked in, rather than patched afterwards.
export type HarnessHookPayloadFactory<E extends HarnessLifecycleEvent> = (context: {
    api?: HarnessPluginApi;
}) => HarnessLifecyclePayloads[E];

export type HarnessHookBus = {
    // Subscribe. Returns an idempotent unsubscribe bound to THIS registration, so two
    // identical handlers from two plugins are independent. Overloaded (not widened) so
    // a named subscription keeps its exact per-event payload typing (T1.1).
    on: HarnessHookSubscribeType<HarnessHookRegistration>;
    // Awaited, sequential, fail-open. Resolves with the merged override (if any).
    // Hop count: this is the shape for a call site that is going to `await` regardless
    // (an optional hook with no permanent subscriber). A hook that is ALWAYS subscribed
    // and usually inert wants `emitMaybeSync` instead — see rule 6.
    emit: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => Promise<HarnessMergedHookResult>;
    // Same sequential, fail-open round as `emit`, but it stays on the caller's tick
    // while no handler returns a promise. `turn.before` uses it because the shipped
    // `context-compaction` plugin subscribes permanently and returns synchronously
    // under the limit; awaiting that every turn moved observable event order.
    emitMaybeSync: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => HarnessMaybeAsync<HarnessMergedHookResult>;
    // Synchronous fire-and-forget for a lifecycle point inside a sync handle method.
    // A `timeoutMs` budget means nothing here: `fire` never waits, so there is no wait
    // to bound (a rejected async handler is still reported, as before).
    fire: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => void;
    // True when at least one handler is registered — the emitter's cheap skip test.
    // Allocation-free by contract (rule 5): a wildcard registration makes every
    // deliverable event true, which is exactly the audit-plugin case.
    has: (event: HarnessLifecycleEvent) => boolean;
    // Handler count for one event, wildcard registrations included (they DO run).
    count: (event: HarnessLifecycleEvent) => number;
    // Every event that currently has listeners, plus the owners per event. This is
    // what the server reports as the LIVE hook surface of a plugin (declared
    // `metadata.hooks` is the intent; this is the fact). A `'*'` registration is
    // expanded into the events it will actually receive (rule 7), because this
    // accessor's return type is keyed by HarnessLifecycleEvent and cannot carry a
    // wildcard key.
    live: () => Partial<Record<HarnessLifecycleEvent, string[]>>;
    // Drop every subscription (harness teardown / tests).
    clear: () => void;
};

// Local alias of `HarnessHookSubscribe<Options>` from ../types, kept so the bus's own
// declaration stays readable and the same overload pair is shared with `api.on`.
type HarnessHookSubscribeType<Options> = {
    <E extends HarnessLifecycleEvent>(
        event: E,
        handler: HarnessLifecycleHandler<E>,
        options?: Options
    ): () => void;
    (event: '*', handler: HarnessWildcardHandler, options?: Options): () => void;
};

// A thenable, recognised structurally (a hand-rolled promise-like from a host plugin
// must be treated as async just like a native one). `fire` and `emitMaybeSync` both
// need this test, and neither may throw while performing it.
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function';

// An event name is only ever a plain string here, but a caller could pass anything,
// so the map is guarded on read rather than trusted. `'*'` is NOT an event name: it is
// a subscription form and can only ever be reached through `on`.
const isEventName = (value: unknown): value is HarnessLifecycleEvent =>
    typeof value === 'string' && value.length > 0 && value !== WILDCARD;

// Whether one event reaches a `'*'` subscriber. An unknown runtime name is NOT
// deliverable: a wildcard covers the catalogue, not whatever a caller invented, and the
// exhaustive map above is what keeps the catalogue current.
const isWildcardDeliverable = (event: HarnessLifecycleEvent): boolean =>
    WILDCARD_DELIVERABLE[event] === true;

// A rejected budget, recognised structurally so it survives a round trip through the
// promise machinery untouched (and cannot be confused with a handler's own rejection).
type HookBudgetSignal = { hookBudgetMs: number };

const isBudgetSignal = (value: unknown): value is HookBudgetSignal =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HookBudgetSignal).hookBudgetMs === 'number';

// The message for a dropped handler. Written out in full because it IS the diagnostic
// a host sees (`report.diagnostic`), so it has to name the plugin, the event, the
// budget, and the fact that the run went on without it.
const budgetErrorOf = (event: HarnessLifecycleEvent, owner: string, timeoutMs: number): Error =>
    new Error(
        `A "${owner}" handler for "${event}" timed out after ${String(timeoutMs)}ms and was dropped (fail-open).`
    );

// The message for a decision the contract cannot parse. Fail-OPEN (rule 2): the
// handler's transcript override, if it also returned one, still applies.
const decisionErrorOf = (event: HarnessLifecycleEvent, owner: string, received: unknown): Error => {
    let shown: string;

    try {
        shown = String(JSON.stringify(received) ?? received);
    } catch {
        // A hostile value (a throwing getter, a BigInt) must not break the report path.
        shown = typeof received;
    }

    return new Error(
        `A "${owner}" handler for "${event}" returned a decision this contract cannot parse and it was ignored: ${shown}.`
    );
};

// Normalize ONE handler result into what it contributes to the round.
//
// Transcript: a non-object, an object without a usable `transcript`, and an EMPTY array
// all mean "no override" — an empty transcript is never a meaningful request body, and
// a hook that returns [] is almost certainly signalling "nothing to say" rather than
// "send no messages".
//
// Decision: validated against the closed `HarnessTurnDecision` union here, in ONE place
// (T2.2 rule 5). Anything unrecognised is reported and ignored rather than thrown into
// the run: a plugin typo must not be able to fail a conversation, and a partially
// understood decision must not be guessed at.
const contributionOf = (result: unknown): HarnessMergedHookResult & { invalidDecision?: unknown } => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return {};

    const raw = result as { transcript?: unknown; decision?: unknown };
    const contribution: HarnessMergedHookResult & { invalidDecision?: unknown } = {};

    const transcript = raw.transcript;
    if (Array.isArray(transcript) && transcript.length > 0) {
        contribution.transcript = transcript as readonly HarnessMessage[];
    }

    // `decision: undefined` is an ABSENT decision (a plugin building its result
    // conditionally), not a malformed one — only a present value gets parsed.
    if ('decision' in raw && raw.decision !== undefined) {
        const decision = parseDecision(raw.decision);

        if (decision === undefined) contribution.invalidDecision = raw.decision;
        else {
            contribution.decision = decision;

            // T2.1 — `{ transcript }` and `{ decision: { action: 'replace' } }` are the
            // same statement. Normalize here so `requestOf` downstream has exactly one
            // channel to read and the two spellings can never disagree.
            if (decision.action === 'replace') contribution.transcript = decision.transcript;
        }
    }

    return contribution;
};

// The closed parser for `HarnessTurnDecision`. Returns undefined for anything the
// contract does not define, including a `replace` without a usable transcript (an
// empty array means "nothing to say" for a request body, exactly as above).
const parseDecision = (value: unknown): HarnessTurnDecision | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const decision = value as { action?: unknown; transcript?: unknown; reason?: unknown };

    switch (decision.action) {
        case 'continue':
            return { action: 'continue' };

        case 'replace': {
            const transcript = decision.transcript;
            if (!Array.isArray(transcript) || transcript.length === 0) return undefined;

            return { action: 'replace', transcript: transcript as readonly HarnessMessage[] };
        }

        case 'pause':
        case 'stop': {
            // A non-string reason is dropped rather than stringified: the reason reaches
            // the run record and the UI, and `String({})` would put "[object Object]"
            // in front of a human reading "why did this stop?".
            const reason = typeof decision.reason === 'string' ? decision.reason : undefined;

            return reason === undefined
                ? { action: decision.action }
                : { action: decision.action, reason };
        }

        default:
            return undefined;
    }
};

// Merge one handler's contribution into the round. LAST wins for each channel
// independently (rule 1's "last non-empty wins" extended to the decision), which is
// what makes a later `continue` able to clear an earlier `stop`.
const mergeContribution = (round: HarnessMergedHookResult, contribution: HarnessMergedHookResult): void => {
    if (contribution.transcript !== undefined) round.transcript = contribution.transcript;
    if (contribution.decision !== undefined) round.decision = contribution.decision;
};

export type HarnessHookBusOptions = {
    // Called once per handler that was dropped. Absent = silent (still skipped).
    onHandlerError?: (context: HarnessHookErrorContext) => void;
};

// Build one bus. A harness owns exactly one, so subscriptions die with it and a test
// harness never inherits another test's hooks.
export const createHookBus = (options: HarnessHookBusOptions = {}): HarnessHookBus => {
    // Keyed by event name, plus the `'*'` sibling key for wildcard registrations.
    const registrations = new Map<string, HookEntry[]>();

    // Monotonic registration stamp (rule 1's tie-break). Bus-scoped, not module-scoped:
    // one bus's order is all that ever matters.
    let sequence = 0;

    // Sticky once ANY registration carries a non-zero priority or a wildcard exists.
    // It only ever makes dispatch do MORE work than the fast path, never less, and it
    // cannot change an order: sorting a list whose priorities are all 0 by (priority,
    // seq) reproduces registration order exactly, because `seq` is monotonic. Keeping
    // it sticky also avoids a rescan on every unsubscribe.
    let orderedDispatch = false;

    const report = (
        event: HarnessLifecycleEvent,
        entry: HookEntry,
        error: unknown,
        kind?: HarnessHookErrorContext['kind']
    ): void => {
        try {
            options.onHandlerError?.({
                event,
                owner: entry.owner,
                error,
                ...(kind === undefined ? {} : { kind })
            });
        } catch {
            // A diagnostics reporter must never become the failure it reports.
        }
    };

    // Priority order, then registration order. Higher priority FIRST (T1.3).
    const byPriority = (list: HookEntry[]): HookEntry[] =>
        list.sort((left, right) => right.priority - left.priority || left.seq - right.seq);

    // The dispatch list for one event: the named registrations plus, when the event is
    // deliverable, every wildcard handler (rule 7).
    //
    // FAST PATH: with no priority and no wildcard anywhere on this bus — every harness
    // that ships today, and every test that does not exercise T1 — the stored array IS
    // the dispatch order, so this is one copy and no sort (rule 6).
    const listenersOf = (event: HarnessLifecycleEvent): HookEntry[] => {
        if (!isEventName(event)) return [];

        const named = registrations.get(event);

        if (!isWildcardDeliverable(event)) {
            if (named === undefined || named.length === 0) return [];
            return orderedDispatch ? byPriority([...named]) : [...named];
        }

        const wild = registrations.get(WILDCARD);

        if (named === undefined || named.length === 0) {
            if (wild === undefined || wild.length === 0) return [];
            return byPriority([...wild]);
        }

        if (wild === undefined || wild.length === 0) {
            return orderedDispatch ? byPriority([...named]) : [...named];
        }

        return byPriority([...named, ...wild]);
    };

    // Named-only check, allocation-free: `has()` is the hot-path guard every harness
    // emit site runs, and an array copy there is paid for on every emit.
    const namedListOf = (event: HarnessLifecycleEvent): HookEntry[] | undefined =>
        isEventName(event) ? registrations.get(event) : undefined;

    const on = (
        event: HarnessLifecycleEvent | typeof WILDCARD,
        handler: HarnessLifecycleHandler<HarnessLifecycleEvent> | HarnessWildcardHandler,
        registration?: HarnessHookRegistration
    ): (() => void) => {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError(`Unknown lifecycle event: ${String(event)}.`);
        }

        if (typeof handler !== 'function') {
            throw new TypeError(`A "${event}" handler must be a function.`);
        }

        // Strict argument checks, in the house style: a priority that is not a number
        // would silently sort into the wrong place, which is the one thing this option
        // exists to prevent.
        const priority = registration?.priority;

        if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
            throw new TypeError(`A "${event}" priority must be a finite number.`);
        }

        const timeoutMs = registration?.timeoutMs;

        if (
            timeoutMs !== undefined &&
            (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
        ) {
            throw new TypeError(`A "${event}" timeoutMs must be a finite number >= 0.`);
        }

        const wildcard = event === WILDCARD;

        const entry: HookEntry = {
            owner: registration?.owner ?? '',
            ...(registration?.api === undefined ? {} : { api: registration.api }),
            priority: priority ?? 0,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            seq: ++sequence,
            wildcard,
            handler: handler as unknown as (payload: never) => unknown
        };

        if (wildcard || (priority !== undefined && priority !== 0)) orderedDispatch = true;

        const key = event as string;
        const list = registrations.get(key);
        if (list === undefined) registrations.set(key, [entry]);
        else list.push(entry);

        // Identity removal: `filter` keeps every OTHER entry, so a duplicate handler
        // registered twice still runs twice until each registration is removed.
        return (): void => {
            const current = registrations.get(key);
            if (current === undefined) return;

            const index = current.indexOf(entry);
            if (index < 0) return;

            current.splice(index, 1);
            if (current.length === 0) registrations.delete(key);
        };
    };

    // Resolve one handler's payload. A plain payload is handed over unchanged (no
    // copy): a record the emitter already detached is safe to share.
    //
    // A wildcard handler gets the ENVELOPE instead (rule 7): the factory still runs
    // once per handler, so a wildcard observer of `turn.before` sees the same current
    // projection a named subscriber would — inside `{ event, payload }`.
    const payloadFor = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>,
        entry: HookEntry
    ): unknown => {
        const resolved =
            typeof payload === 'function'
                ? (payload as HarnessHookPayloadFactory<E>)(
                      { ...(entry.api === undefined ? {} : { api: entry.api }) }
                  )
                : payload;

        return entry.wildcard
            ? ({ event, payload: resolved } as unknown as HarnessWildcardEventContext)
            : resolved;
    };

    // Arm the per-handler budget (T1.4). Only ever called with a THENABLE, so a
    // synchronous handler costs no timer at all (rule 6).
    //
    // Fail-OPEN, not fail-closed: losing the race drops the handler's contribution to
    // this round and reports it; the round continues with the next handler, and the
    // late result is ignored whenever it arrives. A side effect the handler already
    // made (a flag write, an api call) is NOT undone — a budget bounds the WAIT, it is
    // not a rollback.
    const withBudget = (entry: HookEntry, value: PromiseLike<unknown>): Promise<unknown> => {
        const timeoutMs = entry.timeoutMs;

        // The unbounded case, exactly as before: no wrapper, no timer.
        if (timeoutMs === undefined) return Promise.resolve(value);

        return new Promise<unknown>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;

            try {
                timer = setTimeout(() => reject({ hookBudgetMs: timeoutMs } satisfies HookBudgetSignal), timeoutMs);
            } catch {
                // A runtime that cannot arm a timer (a frozen fake-timer clock) must not
                // turn a budget into a crash: run unbounded, as if absent.
                return void Promise.resolve(value).then(resolve, reject);
            }

            // A budget must never hold the process open — the same rule the shipped
            // async-ping timer follows. Node has `unref`; a browser does not.
            const unref = (timer as unknown as { unref?: () => void }).unref;
            if (typeof unref === 'function') unref.call(timer);

            const disarm = (apply: () => void): void => {
                try {
                    clearTimeout(timer);
                } catch {
                    // Nothing to release; the outcome is already decided.
                }
                apply();
            };

            void Promise.resolve(value).then(
                (result) => disarm(() => resolve(result)),
                (error) => disarm(() => reject(error))
            );
        });
    };

    // One handler's awaited step: INVOCATION plus settlement, so a synchronous throw
    // from a later handler is caught here exactly like a rejection (rule 2 — the
    // original round wrapped both in one try, and that must not regress on the tail).
    //
    // The budget applies only to a thenable, and every way a handler can be dropped —
    // throw, reject, timeout — becomes a reported no-value here, never a rethrow: the
    // round always finishes for the handlers that survived.
    const runBounded = async (
        event: HarnessLifecycleEvent,
        entry: HookEntry,
        invoke: () => unknown
    ): Promise<unknown> => {
        try {
            const value = invoke();

            return await (isThenable(value) && entry.timeoutMs !== undefined
                ? withBudget(entry, value)
                : value);
        } catch (error) {
            if (isBudgetSignal(error)) {
                report(event, entry, budgetErrorOf(event, entry.owner, error.hookBudgetMs), 'timed-out');
            } else {
                report(event, entry, error);
            }

            // A drop is not a value: the caller sees `undefined`, which contributes
            // nothing to the round.
            return undefined;
        }
    };

    // The async tail of one round. `firstResult` is the promise returned by the handler
    // at `startIndex`; from that index on everything is awaited. Handler order, the
    // per-handler payload factory and fail-open are unchanged from the synchronous
    // prefix — the only difference is that the round is already on a microtask.
    const finishRound = async <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>,
        snapshot: HookEntry[],
        startIndex: number,
        firstResult: PromiseLike<unknown>,
        round: HarnessMergedHookResult
    ): Promise<HarnessMergedHookResult> => {
        for (let index = startIndex; index < snapshot.length; index += 1) {
            const entry = snapshot[index];

            // The handler at `startIndex` already RAN; only its result is still
            // outstanding. Later handlers are invoked one at a time, each with a
            // freshly resolved payload, so a later hook still sees what an earlier
            // one rewrote (rule 1). The thunk form is what keeps that invocation inside
            // the fail-open guard above.
            const result = await runBounded(
                event,
                entry,
                index === startIndex
                    ? () => firstResult
                    : () => (entry.handler as (p: unknown) => unknown)(payloadFor(event, payload, entry))
            );

            // `runBounded` already reported (and swallowed) every failure, so a drop
            // arrives here as `undefined` and the round simply continues (rule 2).
            const contribution = contributionOf(result);

            if (contribution.invalidDecision !== undefined) {
                report(event, entry, decisionErrorOf(event, entry.owner, contribution.invalidDecision), 'invalid-decision');
            }

            mergeContribution(round, contribution);
        }

        return round;
    };

    const emitMaybeSync = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): HarnessMaybeAsync<HarnessMergedHookResult> => {
        // Snapshot up front (rule 3): a handler may (un)subscribe during this round, and
        // that must never change which handlers THIS round visits.
        const snapshot = listenersOf(event);
        if (snapshot.length === 0) return { sync: true, value: {} };

        // One object per round, mutated in place by the reducer, so the sync and async
        // branches return the SAME merged value by construction (T2.2's "one place").
        const round: HarnessMergedHookResult = {};

        for (let index = 0; index < snapshot.length; index += 1) {
            const entry = snapshot[index];

            let result: unknown;

            try {
                result = (entry.handler as (p: unknown) => unknown)(payloadFor(event, payload, entry));
            } catch (error) {
                report(event, entry, error);
                continue;
            }

            // THE boundary: the first handler that produced a promise hands the rest of
            // the round to `finishRound`. Nothing before this line yielded. This is also
            // the only moment a timeout timer may be armed (T1.4).
            if (isThenable(result)) {
                return {
                    sync: false,
                    promise: finishRound(event, payload, snapshot, index, result, round)
                };
            }

            const contribution = contributionOf(result);

            if (contribution.invalidDecision !== undefined) {
                report(event, entry, decisionErrorOf(event, entry.owner, contribution.invalidDecision), 'invalid-decision');
            }

            mergeContribution(round, contribution);
        }

        return { sync: true, value: round };
    };

    // `emit` is the round with the await the caller asked for. The sync branch returns
    // an already-resolved promise instead of running through an `async` wrapper, so the
    // no-listener case costs one microtask rather than two — and every harness site has
    // already skipped it behind `has()`.
    const emit = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): Promise<HarnessMergedHookResult> => {
        const round = emitMaybeSync(event, payload);
        return round.sync ? Promise.resolve(round.value) : round.promise;
    };

    const fire = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): void => {
        for (const entry of listenersOf(event)) {
            try {
                const result = (entry.handler as (p: unknown) => unknown)(payloadFor(event, payload, entry));

                // A sync emitter cannot await, so an async handler's rejection is
                // observed (and reported) but never changes the caller's path.
                if (isThenable(result)) {
                    result.then(undefined, (error: unknown) => {
                        report(event, entry, error);
                    });
                }
            } catch (error) {
                report(event, entry, error);
            }
        }
    };

    return {
        on: on as HarnessHookBus['on'],
        emit,
        emitMaybeSync,
        fire,
        has: (event: HarnessLifecycleEvent) => {
            const named = namedListOf(event);
            if (named !== undefined && named.length > 0) return true;

            // A wildcard registration makes every deliverable event live (rule 7). The
            // whole point of `has()` is that an audit plugin paying for no payload
            // construction is still reached, so this cannot be omitted.
            if (!isWildcardDeliverable(event)) return false;

            const wild = registrations.get(WILDCARD);
            return wild !== undefined && wild.length > 0;
        },
        count: (event: HarnessLifecycleEvent) => listenersOf(event).length,
        live: () => {
            const result: Partial<Record<HarnessLifecycleEvent, string[]>> = {};

            // Named registrations, owners in dispatch order.
            for (const [event, list] of registrations) {
                if (event === WILDCARD || list.length === 0) continue;
                result[event as HarnessLifecycleEvent] = list.map((entry) => entry.owner);
            }

            // T1.2 — a wildcard registration is reported as the events it will ACTUALLY
            // receive: every catalogue entry marked deliverable, which is all of them
            // except the host-only `host.state_change` plane. That keeps this accessor's
            // return type keyed by HarnessLifecycleEvent (no invented `'*'` pseudo-event)
            // while the Plugins pane's live-vs-declared comparison stays honest.
            const wild = registrations.get(WILDCARD);

            if (wild !== undefined && wild.length > 0) {
                for (const [event, deliverable] of Object.entries(WILDCARD_DELIVERABLE)) {
                    if (deliverable !== true) continue;

                    const key = event as HarnessLifecycleEvent;
                    const owners = result[key] ?? [];

                    for (const entry of wild) {
                        // A plugin that subscribed BOTH by name and by wildcard still
                        // owns one row of this report.
                        if (!owners.includes(entry.owner)) owners.push(entry.owner);
                    }

                    result[key] = owners;
                }
            }

            return result;
        },
        clear: () => {
            registrations.clear();
        }
    };
};
