// Context Compaction — the shipped preset plugin (R3).
//
// WHAT THIS FILE DOES NOW
// -----------------------
// The TRIGGER and the PAUSE lifecycle. Every conversation has a context limit; when one
// reaches it, this plugin parks the thread at the turn boundary, runs the compaction
// action, and un-parks it. The action is INTENTIONALLY BLANK (`executeCompaction` below)
// — no summarization, no truncation — but it already receives the full plugin api plus
// the turn context, which is everything a real compactor needs to spawn a summarizer
// thread, rewrite history, or disable tools.
//
// THE TRIGGER RULES (each one exists for a concrete failure mode)
// ---------------------------------------------------------------
//   1. `contextLimit <= 0` turns the plugin off for every thread. A host that wants no
//      compaction sets 0 rather than removing the built-in (and the UI can offer that).
//   2. Below the limit: do nothing AND forget this thread's last trigger. A compaction
//      that worked has to be able to fire again the next time the limit is crossed.
//   3. At/above the limit: fire on a FRESH crossing, or once the estimate has grown by
//      at least 5% of the limit past the value that last fired (see `REGROWTH_RATIO`).
//      Without that margin a blank (or failing) action would pause the same conversation
//      on every single turn; with a strict "only once per crossing" rule a conversation
//      that keeps growing while compaction does nothing would never be looked at again.
//   4. Never act on an internal compaction agent (`summarizer`, see `isInternalAgent`).
//      A real compactor will hand the summary to a summarizer thread; if this plugin
//      then compacted THAT conversation, the summarizer would re-trigger itself.
//
// WHY PAUSE/RESUME AROUND THE ACTION
// ----------------------------------
// Compaction is slow (an LLM call) and rewrites the conversation, so the roster a host
// reads should say 'paused' while it happens — the same signal the UI acts on. `resume()`
// is in a `finally`: a compaction that threw must not strand the conversation in
// 'paused'. The error itself is deliberately NOT swallowed here — the hook bus is
// already the single fail-open authority (plugin/hooks.ts rule 2), so the plugin decides
// only about the thread's state and leaves the run's decision to the framework.
//
// WHY THE FAST PATH IS SYNCHRONOUS (no `async` keyword on the handler)
// -------------------------------------------------------------------
// The bus runs `await handler(payload)`. A plain function that returns `undefined` costs
// ONE microtask; an `async` function adds its own promise on top of that await. Nearly
// every turn is under the limit, and the harness interleaves a delegated child's event
// frames with its parent's on exactly those boundaries (plugin/hooks.ts rule 5: the
// reason every emit site is guarded by `has()`), so the path that runs most often is
// written to yield as little as the contract allows. Only a real trigger returns a
// promise, and that is the turn where the delay is the whole point.
//
// WHY THE HANDLER LIVES IN A FACTORY (`createContextCompactionHandler`)
// --------------------------------------------------------------------
// `setup` stays a two-line wiring function, and the per-thread cooldown map plus the
// action become injectable: a test (or a host that swaps the action but wants the same
// lifecycle) builds the same guard with its own action without re-implementing the
// rules. The shipped plugin always uses `executeCompaction`.
//
// WHY THE COOLDOWN MAP IS NEVER PRUNED
// -----------------------------------
// One number per conversation that crossed the limit, cleared on the next under-limit
// turn. Two cases leave a stale entry behind, both bounded and both harmless:
//   - a thread deleted while still over the limit (so the map is bounded by the number of
//     threads a harness ever had);
//   - a BRANCH run (fork/autoanswer), which reports its scheduling actor key
//     `branch:<id>` as `threadId` because it has no persistent conversation
//     (src/harness.ts `emitTurnBefore`). Its `pause()`/`resume()` are documented no-ops —
//     nothing can address a branch — so the pass costs one number and changes nothing;
//     the parent conversation still gets the real pass on its own next turn.
// Neither is worth a `thread.deleted` subscription, which would also make the live hook
// surface disagree with the declared `metadata.hooks` (the server reports the declared
// list to the UI).
//
// STATE
// -----
// The plugin is per-harness: `setup` runs once, so the cooldown map dies with the
// harness. Nothing is persisted — a restarted process re-triggers on the next crossing,
// which is correct because the context limit is a runtime fact, not durable state.
//
// Cross-references:
//   - ../core/context-estimate.ts — the estimator feeding `estimatedTokens` (~4 chars/token)
//   - ../harness.ts               — the `turn.before` emission (requestTurn → emitTurnBefore)
//                                   and the pause/resume implementations (pauseThreadState)
//   - ../plugin/hooks.ts          — sequential, fail-open dispatch of hook handlers
//   - ../plugin/host.ts           — how this built-in is applied (and replaced by a host)
//   - ../plugin/manifest.ts       — GENERATED wiring: this file is auto-discovered
import type {
    HarnessLifecycleHandler,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    HarnessTurnBeforeContext
} from '../types';

// A static literal: scripts/generate-plugin-manifest.mjs refuses a `metadata` export
// that is not written as an object literal, because the manifest has to describe this
// plugin without executing it.
export const metadata = {
    name: 'context-compaction',
    title: 'Context Compaction',
    description:
        'Watches each agent conversation against a context limit and, when the limit is reached, compacts the transcript at the turn boundary before the next model request is sent.',
    version: '1.0.0',
    tags: ['context', 'compaction', 'lifecycle'],
    builtin: true,
    hooks: ['turn.before'],
    settings: [
        {
            key: 'contextLimit',
            label: 'Context limit (tokens)',
            type: 'number',
            default: 100000,
            min: 1000,
            step: 1000,
            description:
                'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the same ~4 characters/token estimate the UI context bar uses.'
        }
    ]
} satisfies HarnessPluginMetadata;

// Fallback when the host stores nothing for `contextLimit`. It has to equal
// `metadata.settings[0].default` (100000): the metadata must stay a plain object literal
// for the manifest scanner, so the number is written twice and BOTH places move together.
// The fallback only matters for a host plugin that reuses the guard without declaring the
// setting, because a declared default always outranks this argument (plugin/settings.ts
// `resolve`: stored value -> declared default -> argument fallback).
const CONTEXT_LIMIT_DEFAULT = 100000;

// Re-trigger margin, as a fraction of the limit. 5% is deliberately coarse: the estimate
// itself is the ~4 chars/token rule of thumb, so a margin measured in single tokens would
// just be noise from the estimator rather than real growth.
const REGROWTH_RATIO = 0.05;

// Agents this plugin never compacts. `summarizer` is the delegated condenser the shipped
// profiles already use (src/agents/summarizer.ts) — i.e. the agent a future compactor is
// most likely to spawn for its summary.
const INTERNAL_AGENT_NAMES: readonly string[] = ['summarizer'];

// Name fragments treated as compaction plumbing rather than a user conversation, so a
// host that registers its own condenser as `summarize-notes` or `compact-worker` is
// skipped too without having to be listed above.
const INTERNAL_AGENT_MARKERS: readonly string[] = ['summariz', 'compact'];

// Reserved namespaces for plugin-created internal agents (`underload:compaction`). A
// display name is normally a plain identifier, so a prefix is an unambiguous opt-out.
const INTERNAL_AGENT_PREFIXES: readonly string[] = ['underload:', 'plugin:'];

// True when a turn belongs to compaction's own machinery and must not be compacted.
// The check is case-insensitive because agent names come from user configuration.
export const isInternalAgent = (agent: string): boolean => {
    const name = String(agent ?? '')
        .trim()
        .toLowerCase();

    if (name.length === 0) return false;

    if (INTERNAL_AGENT_NAMES.includes(name)) return true;
    if (INTERNAL_AGENT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;

    return INTERNAL_AGENT_MARKERS.some((marker) => name.includes(marker));
};

// The compaction action's shape: the harness control surface plus the parked turn. It is
// the same signature a tool function has, which is the point — "a plugin can trigger
// anything within the server" means the action gets the api, not a curated subset.
export type HarnessCompactionAction = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
) => Promise<void>;

// THE ACTION. Intentionally blank for now: the trigger/pause lifecycle around it is what
// this change ships, so the compaction itself stays an explicit, documented TODO rather
// than a guessed summarization policy. `api` is the full harness control surface
// (create/delete/stop threads, send a turn, read/replace history, enable/disable tools,
// wake async work) and `context` is the parked turn (`messages`, `estimatedTokens`,
// `setTranscript`, `replaceHistory`, `pause`, `resume`, `signal`).
//
// A future implementation that calls `replaceHistory()` must re-state the newest turn:
// `replaceHistory` replaces the WHOLE committed transcript, including the prompt this run
// just appended (src/harness.plugin.test.ts pins that behaviour).
export async function executeCompaction(
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): Promise<void> {
    // Intentionally blank for now. This is the plugin's action function.
    // `api` is the full harness control surface (spawn/delete threads,
    // disable tools, read/replace history, wake async work, etc.).
    // TODO: implement context compaction here.
    void api;
    void context;
}

// Builds the `turn.before` handler: the limit check, the per-thread cooldown, and the
// pause/action/resume sequence.
//
// The limit is read INSIDE the handler, not once at setup, because `api.settings` is
// re-read on every access by contract (plugin/settings.ts): an operator changing the
// value from the UI takes effect on the next turn, with no restart.
export const createContextCompactionHandler = (
    api: HarnessPluginApi,
    action: HarnessCompactionAction = executeCompaction
): HarnessLifecycleHandler<'turn.before'> => {
    // threadId -> the estimate that last fired for it. The per-thread key matters: two
    // long-running conversations must not share one cooldown.
    const triggered = new Map<string, number>();

    // The park/act/unpark pass. Extracted so the fast path below can stay synchronous.
    const pass = async (context: HarnessTurnBeforeContext): Promise<void> => {
        // Park, act, always unpark. `pause()` is outside the try because a pause that
        // failed has nothing to undo; the throw itself is left to the bus (fail-open),
        // which keeps "what a broken plugin does to a run" a framework decision.
        await context.pause();

        try {
            await action(api, context);
        } finally {
            await context.resume();
        }
    };

    // SYNC fast path, deliberately not an `async` function: the bus does
    // `await handler(payload)`, so returning `undefined` costs one microtask, while an
    // `async` handler layers its own promise on top of that await. Almost every turn is
    // under the limit, and the harness interleaves a delegated child's event frames with
    // its parent's on exactly those boundaries (plugin/hooks.ts rule 5) — so the path that
    // runs most often yields as little as the contract allows, and only a real trigger
    // returns a promise.
    return (context) => {
        const limit = api.settings.number('contextLimit', CONTEXT_LIMIT_DEFAULT);

        // Rule 1: a non-positive limit is "off". `Number.isFinite` also refuses NaN, so
        // a corrupt stored value can never make every turn look over the limit.
        if (!Number.isFinite(limit) || limit <= 0) return undefined;

        // Rule 4: never compact the compactor's own agents.
        if (isInternalAgent(context.agent)) return undefined;

        // Rule 2: under the limit — clear the cooldown so the next crossing is fresh, and
        // return without touching the thread.
        if (context.estimatedTokens < limit) {
            triggered.delete(context.threadId);
            return undefined;
        }

        // Rule 3: over the limit. Fire on a fresh crossing, or once the conversation has
        // grown by at least REGROWTH_RATIO of the limit since the last fire. `max(1, ...)`
        // keeps a margin for a limit so small that 5% rounds to 0 — otherwise an
        // unchanged estimate would fire on every turn again.
        const previous = triggered.get(context.threadId);
        const margin = Math.max(1, Math.floor(limit * REGROWTH_RATIO));

        if (previous !== undefined && context.estimatedTokens < previous + margin) {
            return undefined;
        }

        // Recorded BEFORE the action: a failing action must not be retried on the very
        // next turn, and the value stored is the size this pass was asked about.
        triggered.set(context.threadId, context.estimatedTokens);

        return pass(context);
    };
};

// Wiring only: the framework hands the scoped api, the guard owns the behaviour. The
// arrow form (not a reference) is what the manifest scanner's `setup` regex requires.
export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    api.on('turn.before', createContextCompactionHandler(api));
};
