// sleep — standalone source entry for a wall-clock pause that WAKES the agent when it ends.
//
// WHY THIS ENTRY EXISTS (2026-11-19)
// ----------------------------------------------------------------
// A Manager that spawns agents in async mode can fan out work and then wants to give
// those children time to land before it reads them. Until now a run had NO way to
// spend time on purpose: `delegate`/`threadFork` bound a CHILD's clock, the retry
// ladders (`core/agent-limits.ts`) bound the transport's, and every one of those
// bounds is host-set or internal — nothing inside a conversation could say "wait 30
// seconds and then carry on". The only move was to answer early or to burn a turn on
// an unrelated call.
//
// WHAT MAKES THIS A WAKE AND NOT JUST A WAIT
// ----------------------------------------------------------------
// `mode: 'sync'` (stated in the registration literal below, and the value
// `DEFAULT_TOOL_MODE` already applies — `core/tool.ts:85`). A sync call's completion
// joins its assistant message's sync group: the run is parked, and the settled pending
// call is what re-enters it (`harness.ts:1924-1928` resolves the mode, and the mailbox
// delivery of a settled call is what dirties a parked run again). So the timer expiring
// IS the wake — no core change, no new event, and no reliance on the liveness
// heartbeat. That matters, because the heartbeat deliberately does not ping a
// sync-parked run: a tool that parked the run with nothing settling in it would sleep
// until the next ping, and this one never parks without a promise that settles.
//
// WHY 'sync' AND NOT 'async'
// ----------------------------------------------------------------
// The user's ruling, and the behaviour backs it: the caller is asking for a pause in
// ITS OWN turn, and the answer ("how long it actually slept, and whether something cut
// it short") belongs in the tool message of that same turn. An async tool would release
// the run into another model request while the wait was still open, which is the
// opposite of a pause.
//
// The wait itself is abort-aware and copies the one-shot structure of
// `core/agent.ts:771-794` (`waitForRetry`): an already-aborted signal arms nothing, the
// abort listener clears the timer, and each path removes the other's resource.
//
// DELIBERATE DIVERGENCE FROM THE UNREF HOUSE RULE (2026-11-19 review, M1)
// ----------------------------------------------------------------
// Every other timer this runtime arms is `unref()`-ed, because every other timer is
// BACKGROUND work the host is not waiting on: the wall-clock bounds (`harness.ts:911-941`
// `armWallClock` — "Node keeps the process alive for a pending timer; a bound must not")
// and the liveness heartbeat (`plugins/async-ping.plugin.ts:355-359`, filed under "TIMERS
// MUST NEVER HOLD THE PROCESS OPEN" — a heartbeat that held the loop would hang a CLI
// after the caller stopped caring). Neither rule reaches this entry: for a sleep the WAIT
// IS THE AWAITED WORK, so while it is in flight there is nothing else pending, and an
// unref-ed handle lets an otherwise idle host exit in the middle of the pause. Measured
// on the tree before the fix: a top-level `await executeTool('sleep', { seconds: 4 })`
// printed the line before the call and the process exited 0 — no result, no warning
// (`Temp/review-sleep/probe21.ts`), and the same silent exit when the run was not awaited
// (`probe6.ts`); the identical shape with ONE plain ref-ed `setInterval` alongside woke on
// schedule (`probe7.ts`), which is what pins `unref()` — not the harness — as the cause.
//
// So this handle stays REF-ED for the length of the wait, and that never holds a process
// open longer than the wait it was asked for: the one-shot is consumed by the fire, and
// the abort path clears it (both below), so no handle outlives the sleep. `sleep.test.ts`
// pins it from both sides — `hasRef()` is `true` on the real handle mid-wait, and a
// cancelled sleep leaves `vi.getTimerCount() === 0`.
//
// CANCELLATION RETURNS — AND ITS PAYLOAD IS NOT A PROMISE TO THE MODEL (M2)
// ----------------------------------------------------------------
// `context.signal` is the per-call controller (`types/index.ts:3104-3119`, linked per call
// in `core/scheduler.ts:183-192`), so both a `toolCancel` of this call and a run-level
// abort land here. A throw would report the pause as a failure, so the entry RETURNS data:
// how long it really slept, and that the timer was cleared. What the MODEL of a parked run
// actually reads is narrower, measured on the live doors (`Temp/review-sleep/probe20.ts`
// re-run after the fix, and `Temp/sleep-c1/probe-transcript.ts`, both reading the transcript
// rather than the tool's own return value): a `toolCancel` releases the run at once and the
// transcript's tool message
// is the harness's own `Tool call "sleep" (s1) was cancelled before it completed; no result
// is available.` (`harness.ts:10305`) — `toolCancel` ignores a result that arrives
// afterwards, so this entry's `{ sleptMs, cancelled: true, … }` is DISCARDED on that door;
// and a `stopThread` rejects the run with `Thread "agent:main" was stopped.` and leaves the
// tool message generic — `Tool execution was cancelled or interrupted before it produced a
// result, so this call has no recorded outcome. …` (`Temp/sleep-c1/probe-stop.ts`) — so
// nothing of this entry's payload is delivered there either. The payload does reach a direct
// caller (`executeTool`, the standalone callable) and the model on the NORMAL door (timer
// expiry, measured in `Temp/sleep-c1/probe-transcript.ts`), which is why it is built — but
// the published description promises only what is true on every door: the wait ends early
// and this entry never reports the pause itself as a failure.
//
// PURE LITERAL (T19 / R9). No computation, no interpolation, no call and no captured
// local dependency in `metadata` / `registration`: `core/tool-scan.ts` reads both
// through the TypeScript AST without executing this file, and
// `scripts/check-package-tools.ts` asserts `dependencies: []` for this entry's startup
// source record. That is why the ceiling appears TWICE below — as the published schema
// bound and as the enforced constant — and why `MODEL_TIMEOUT_MAX_MS`
// (`core/agent-limits.ts:81`) is restated as `3600` rather than imported. The pin in
// `sleep.test.ts` asserts the two are equal, so the published bound, the enforced bound
// and the shared model ceiling cannot drift apart separately.
import type { CoreToolMetadata } from '../../core';
import { tool } from '../../core';
import type { ToolContext } from '../../types';

export const SLEEP_NAME = 'sleep';

// The bounds, as the IMPLEMENTATION enforces them. Must equal
// `metadata.parameters.properties.seconds.minimum` / `.maximum` — the published schema
// is the door a model walks through, and a bound that admits a call the entry then
// refuses is a late, confusing refusal (docs/runtime-tools.md:206-222).
//
// The ceiling is 3600 seconds because that is one hour, the same wall-clock ceiling
// every other model-settable bound shares (`MODEL_TIMEOUT_MAX_MS = 3600000` ms,
// core/agent-limits.ts:81, which `delegate`'s and `threadFork`'s `timeoutMs` publish).
// The floor is 0, not 1: `sleep 0` is a legitimate request to yield the rest of the
// turn's batch to the event loop, and a schema that refused it would push the model
// into `sleep 1` for a wait it did not want.
export const SLEEP_MIN_SECONDS = 0;
export const SLEEP_MAX_SECONDS = 3600;

// One second, in the unit `setTimeout` speaks. A local constant rather than an inline
// `1000` so the two multiplications below name the unit they convert.
const MILLISECONDS_PER_SECOND = 1000;

// What one call reports. `sleptMs`/`sleptSeconds` are what ACTUALLY elapsed — equal to
// the request when the timer fires, shorter when something cancelled — so a cancelled
// pause is still a truthful number rather than the number that was asked for.
//
// WHO ACTUALLY READS IT (M2): a direct caller (`executeTool`, the standalone callable)
// gets this object whole. A MODEL does not, on the doors that shorten a wait — the
// harness substitutes its own cancellation notice there and drops the payload
// (`harness.ts:10305`; see the header). So the fields are honest, and the claim that the
// model sees them is not: the published description says nothing about them.
export type SleepResult = {
    sleptMs: number;
    sleptSeconds: number;
    requestedSeconds: number;
    cancelled: boolean;
    reason?: string;
    message: string;
};

// The shape mirrors the other single-argument runtime entries (`threadDelete`,
// `timeNow`): ONE required property, `additionalProperties: false`, and the bound
// stated in the schema because it is the door, not a hint.
//
// WHY THE WORDING IS PART OF THE CONTRACT: `core/discovery.ts:128-141` scores a
// DESCRIPTION SUBSTRING hit at 1 point (`scoreTool`), so every word in this string is
// also a discovery needle. The description therefore deliberately avoids `cancel`
// (a "cancel" query belongs to `toolCancel`, which is a declared core row and is
// answered as `alreadyAvailable`, not enabled) and `delegate`/`delegation` (the same
// argument for `delegate`), which is how a pause stays out of both queries' result sets
// while still being findable through its own tags. Pinned behaviour of that rule lives
// in `src/harness.already-available.test.ts`, and `sleep.test.ts:260-271` pins the two
// forbidden substrings.
//
// THE LAST SENTENCE IS ALSO A CONTRACT, AND M2 NARROWED IT. It used to promise that a
// shortened wait "reports the seconds actually slept and says the timer was cleared".
// That is only true of the payload this entry RETURNS; on the two doors that actually
// shorten a wait the harness answers the model with its OWN cancellation notice and
// throws the payload away (`harness.ts:10305`, and `toolCancel` ignoring a result that
// arrives afterwards), so the model learns only THAT the wait ended. The wording below
// therefore states the behaviour the entry can guarantee — the wait ends early and
// nothing waits out the rest of the delay — and makes no claim about what the
// transcript says.
export const metadata: CoreToolMetadata = {
    name: SLEEP_NAME,
    description:
        'Pause this agent for a wall-clock delay and resume it when the timer expires. Pass `seconds`: how long to wait, from 0 to 3600 (one hour) — 0 yields the rest of the turn without waiting, and a fraction is honoured (0.5 waits half a second). The sleep is not a background task: this tool call stays open for exactly that long, and the timer expiring is what wakes the run and lets it continue, so use it when the wait itself is the work (let a child you spawned land, space out polls) rather than something to fill a turn with. A stop of the run, or a request to abandon this call, ends the wait early rather than failing it: the timer is cleared and nothing waits out the rest of the delay. Out-of-range or non-numeric values are refused before anything is waited.',
    // Tags are the ONLY discovery path for a searchable row (`toolRequest` matches a
    // query against these words), so they cover the vocabulary a model reaches for
    // when it wants time to pass, in either direction.
    tags: ['sleep', 'wait', 'delay', 'timer', 'pause', 'seconds', 'time'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            seconds: {
                type: 'number',
                // Equal to SLEEP_MIN_SECONDS / SLEEP_MAX_SECONDS above. `number`, not
                // `integer`: a sub-second pause is a real request and rounding it up to
                // a whole second would be a lie about what the agent asked for.
                minimum: 0,
                maximum: 3600,
                description:
                    'How long to wait, in seconds: 0 to 3600 (one hour). A fraction is honoured (0.5 waits half a second); 0 returns without waiting. Values outside that range, and anything that is not a number, are refused and nothing is slept.'
            }
        },
        required: ['seconds'],
        additionalProperties: false
    }
};

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. `core/tool-discovery.ts` READS this literal through
// the TypeScript AST (it never executes the module), so the activation/order/flags
// here are what actually drive registration.
//
// `group: 'runtime'` + `activation: 'always'`: this is harness-owned, not a preset,
// and it registers on every harness construction — a library `harness({})` AND a
// server session. The server's `presets: false` filter drops only the `preset` group,
// so an `always` runtime row survives it; nothing needs to opt into a pause.
//
// `mode: 'sync'` is STATED rather than defaulted (the value `DEFAULT_TOOL_MODE`
// already applies) and the behaviour needs it: the settled call is what re-enters the
// parked run, which is the whole wake, and naming the mode keeps the descriptor honest
// instead of relying on an absent key.
//
// `order: 145` slots into the deliberate gap between `actionRequest` (140) and
// `toolCancel` (150), which puts it at the end of the run-control block — a pause sits
// next to the other things a run does to itself, and both neighbours are the
// same-family controls. It registers BEFORE `toolCancel`, which is also the order a
// caller wants: the pause is declared, then the thing that can cut it short.
//
// `alwaysDeclared: false` + `visibility: 'searchable'`: the house posture for
// harness-owned runtime rows (knowledge.md:1509-1523 — `toolList`, `records`,
// `knowledge`, `agentManage`, …). A pause is not needed on every request, so its
// description and schema stay out of every prompt until `toolRequest` asks for it.
//
// `listed: true`: unlike `toolCancel`/`threadDelete`, a sleep has no caller lineage and
// no session state to scope, so the server's direct-call catalogue can run it as a
// plain timed wait — which is why `sessionBound` is omitted (no live session needed).
export const registration = {
    group: 'runtime',
    activation: 'always',
    mode: 'sync',
    order: 145,
    alwaysDeclared: false,
    listed: true
} as const;

// Renders the offending value in a refusal so a direct caller sees what it actually
// sent: a hand-built `{ seconds: 'soon' }` must name `'soon'`, not `[object Object]`.
const receivedLabel = (parameters: unknown): string => {
    if (typeof parameters === 'string') return JSON.stringify(parameters);
    if (parameters === null || typeof parameters !== 'object') return String(parameters);

    const wrapped = (parameters as Record<string, unknown>).seconds;

    return typeof wrapped === 'string'
        ? JSON.stringify(wrapped)
        : wrapped === undefined
            ? `an object with no "seconds" (${JSON.stringify(parameters)})`
            : String(wrapped);
};

// Reads `seconds` out of the TWO shapes both of which are correct.
//
// A tool that declares EXACTLY ONE property has its arguments UNWRAPPED to that
// property's value by `resolveToolParameters` (core/schema-validation.ts, driven by
// `toolParameterKey` in core/tool.ts) on the model path AND on the direct
// `executeTool` path, so the live call hands over a bare NUMBER. The wrapper object is
// still read for a hand-built context, and stays the shape the schema advertises (the
// same dual read as `tools/runtime/threadDelete.tool.ts:141-153`).
//
// Nothing is coerced: a string, a boolean, NaN, ±Infinity and an out-of-range number
// are refused with a readable message, exactly as `timeNow` refuses a non-string label
// (core/tool.ts has no argument validation of its own, and a direct caller skips JSON
// Schema entirely — this function IS the door for that caller).
const resolveSeconds = (parameters: unknown): number => {
    const wrapped =
        parameters !== null && typeof parameters === 'object'
            ? (parameters as Record<string, unknown>).seconds
            : undefined;

    // Bare number first, then the wrapper's value. Everything else becomes NaN, which
    // the `isFinite` gate below rejects with the message that names what arrived.
    const value =
        typeof parameters === 'number'
            ? parameters
            : typeof wrapped === 'number'
                ? wrapped
                : Number.NaN;

    if (!Number.isFinite(value)) {
        throw new Error(
            `sleep needs "seconds" as a number between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS}. Received ${receivedLabel(parameters)}.`
        );
    }

    if (value < SLEEP_MIN_SECONDS || value > SLEEP_MAX_SECONDS) {
        throw new Error(
            `sleep "seconds" must be between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS}. Received ${value}.`
        );
    }

    return value;
};

// The reason a cancellation carries, as TEXT the model can read. `signal.reason` is
// whatever aborted the call: a string, a `DOMException` for a bare `abort()`, the
// `HarnessError` a run stop stamps (`harness.ts` arms bounds that way), or nothing.
// Only a human-readable reason is reported — an unrepresentable one is dropped rather
// than emitted as `[object Object]` in a tool result.
const cancelReasonOf = (signal: AbortSignal | undefined): string | undefined => {
    const reason: unknown = signal?.reason;

    if (typeof reason === 'string' && reason.length > 0) return reason;
    if (reason instanceof Error && reason.message.length > 0) return reason.message;

    return undefined;
};

// Formats a duration for the message in the unit the tool speaks: SECONDS, with at
// most millisecond precision. `sleptMs: 2500` and "2.5 seconds" are the same fact, and
// the second one is the number a model quotes back — a "2500 milliseconds" label would
// be the odd one out next to a `seconds` argument. `Number(…toFixed(3))` drops trailing
// zeros, so 2000 ms reads as "2 seconds", not "2.000 seconds".
const durationLabel = (ms: number): string => {
    const seconds = Number((ms / MILLISECONDS_PER_SECOND).toFixed(3));

    return `${seconds} second${seconds === 1 ? '' : 's'}`;
};

// One settled sleep, on both paths.
//
// The cancelled sentence is scoped to what this entry KNOWS: the duration it really
// waited, and that its own timer was cleared. It deliberately does not claim that
// nothing else in the process is pending (other calls may well be), and it is not the
// sentence a model sees on a `toolCancel`/`stopThread` door — see the header.
const settle = (
    startedAt: number,
    requestedSeconds: number,
    cancelled: boolean,
    signal: AbortSignal | undefined
): SleepResult => {
    const sleptMs = Date.now() - startedAt;
    const reason = cancelled ? cancelReasonOf(signal) : undefined;
    const waited = durationLabel(sleptMs);
    const asked = durationLabel(Math.round(requestedSeconds * MILLISECONDS_PER_SECOND));

    const message = cancelled
        ? `Sleep cancelled after ${waited} of the ${asked} requested; the timer was cleared and nothing waits out the rest of the delay.`
        : `Slept for ${waited}. The timer expired and the run is awake again.`;

    return {
        sleptMs,
        sleptSeconds: sleptMs / MILLISECONDS_PER_SECOND,
        requestedSeconds,
        cancelled,
        ...(reason === undefined ? {} : { reason }),
        message
    };
};

// The framework entry point. It returns a PROMISE that settles when the timer expires
// or the call is cancelled — the settled call is the wake (see the header).
//
// Validation happens BEFORE the promise is created, so a bad argument THROWS from
// `execute` synchronously rather than arriving as a rejection: that is the house shape
// (`threadDelete`, `timeNow`), and the harness reports a thrown sync refusal as a
// readable tool error either way.
export const execute = (context: ToolContext): Promise<SleepResult> => {
    const seconds = resolveSeconds(context.parameters);

    // `Math.round` is a float guard, not a rounding policy: 0.1 * 1000 is
    // 100.00000000000001 in IEEE-754, and a timer armed at that delay can never be
    // asserted as "exactly 100 ms". A sub-millisecond request collapses to 0 and
    // resumes on the next event-loop tick, which is the finest wait the platform has.
    const delayMs = Math.round(seconds * MILLISECONDS_PER_SECOND);
    const signal = context.signal;

    return new Promise<SleepResult>((resolve) => {
        // Already cancelled (the model cancelled the call before the runtime got here,
        // or the run stopped while this call was queued): NO timer is armed at all, and
        // the result says so with a real elapsed time of 0.
        if (signal?.aborted === true) {
            resolve(settle(Date.now(), seconds, true, signal));
            return;
        }

        // Captured at arm time, so `sleptMs` measures the wait itself rather than the
        // microseconds spent building this promise.
        const startedAt = Date.now();

        let timer: ReturnType<typeof setTimeout> | undefined;

        // The abort path: clear the armed timer, drop the handle, and settle as a
        // cancellation. `once: true` below plus this explicit clear mean neither path
        // can fire twice and neither leaks a listener into the next run.
        const onAbort = (): void => {
            if (timer === undefined) return;

            clearTimeout(timer);
            timer = undefined;
            signal?.removeEventListener('abort', onAbort);
            resolve(settle(startedAt, seconds, true, signal));
        };

        timer = setTimeout(() => {
            // The handle is consumed by the fire, so a later abort finds `undefined` and
            // the guard above makes it a no-op.
            timer = undefined;
            signal?.removeEventListener('abort', onAbort);
            resolve(settle(startedAt, seconds, false, signal));
        }, delayMs);

        // NO `unref()` HERE — the one deliberate exception in this runtime (M1; see the
        // header's "DELIBERATE DIVERGENCE FROM THE UNREF HOUSE RULE"). `armWallClock`
        // (harness.ts:911-941) and the heartbeat (plugins/async-ping.plugin.ts:355-359)
        // unref because the work they bound carries on without them; this timer IS the
        // awaited work, so an otherwise-idle host must stay open until the wait is spent —
        // and before the fix it was not: an awaited `sleep` silently ended the process with
        // exit 0 (Temp/review-sleep/probe21.ts, probe6.ts; probe7.ts proved the same shape
        // wakes when one ref-ed handle exists). Neither settle path leaks the hold: the fire
        // consumes the one-shot and `onAbort` clears it, so the process is held exactly as
        // long as the sleep is in flight.
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};

// The callable form. A standalone/host registration and the generated browser
// catalogue resolve THIS export (`tools/descriptors.ts:472` prefers `module[name]`,
// then `default`, then `tool`), which is why the entry carries a `tool()` build
// alongside its `metadata` + `registration` + `execute` exports.
//
// One caveat the callable carries, like every other one: the builder's callable takes
// the PARAMETER VALUE ONLY and builds its own context, `{ parameters: value }`
// (core/tool.ts:152-157). A direct `sleep(2)` therefore has no `signal` to read, so it
// can only ever run the full duration — cancellation needs the harness path, which is
// the only one that hands `execute` a real ToolContext.
export const sleep = tool<number, SleepResult>({
    ...metadata,
    mode: registration.mode,
    execute
});

export default sleep;
