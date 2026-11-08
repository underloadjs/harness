// Context Compaction — the shipped preset plugin (R3).
//
// WHAT THIS FILE DOES NOW
// -----------------------
// The TRIGGER, the PAUSE lifecycle, and the PRUNING POLICY. Every conversation has a
// context limit; when one reaches it, this plugin parks the thread at the turn boundary,
// runs the compaction action, and un-parks it. The action is no longer blank: it prunes
// superseded tool failures — a `failed`/`rejected` unit that a LATER unit already answered
// (same tool, same canonical argument fingerprint, answered `completed`) stops being sent,
// through the shipped `setIncluded` flag, so the transcript keeps it and a host can switch
// it back. Nothing is deleted, nothing is summarized, and the summarize-and-reinitialize
// checkpoint stays T6 of ../docs/tasks/2026-11-09-progressive-compaction.md.
//
// THE POLICY LIVES ELSEWHERE ON PURPOSE
// -------------------------------------
// `executeCompaction` below is the WRITER. The decision is a pure function in
// ../core/context-pruning.ts (`planContextPruning`), so the rule can be pinned by a table
// without a harness, a transport or a clock, and so a future `annotate` mode (T0 Q1) is a
// second writer over the SAME plan rather than a second policy. The order of the action is
// therefore fixed: read settings → build the plan → write the flags → report. A plan that
// clears none of its guards writes NOTHING, which also means no persistence notification and
// no save.
//
// PRE-OUTCOME TRANSCRIPTS: a conversation saved before the tool outcome was persisted
// (compaction T1 — `outcome` on a tool message, core/tool-outcome.ts) reads as all
// `completed`, because nothing re-derives an outcome from the result text.
//
// WHY A BRANCH ROUND IS SKIPPED ENTIRELY (ratified 2026-11-09)
// ------------------------------------------------------------
// A fork/autoanswer round has no persistent conversation: its transcript is an ephemeral
// copy that snapshot v1 excludes and that is INCORPORATED into the owner as text. A flag
// written there is therefore thrown away at incorporation, the owner re-derives the same
// decision on its own next round, and the only durable effect was a cooldown entry keyed by
// the branch's scheduling actor key (`branch:<id>`), which one turn later is a dead key in a
// map nothing prunes (see "WHY THE COOLDOWN MAP IS NEVER PRUNED" below). So the guard
// refuses to trigger on `context.branchId`, the action returns for one too (a host calling
// it directly must not prune an ephemeral copy), and the pollution stops. Recorded against
// F11/T8 of ../docs/tasks/2026-11-09-context-inclusion-followups.md, which is where the
// discriminator (`branchId`) was specified.
//
// THE TRIGGER RULES (each one exists for a concrete failure mode)
// ---------------------------------------------------------------
//   0. `enabled = false` turns the whole plugin off, before any other rule, so an operator
//      can stop compaction without removing the built-in (and the UI can offer that).
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
// turn. One case leaves a stale entry behind, bounded and harmless:
//   - a thread deleted while still over the limit (so the map is bounded by the number of
//     threads a harness ever had).
//
// A BRANCH run used to be a second case: it reports its scheduling actor key `branch:<id>`
// as `threadId` (src/harness.ts `emitTurnBefore`), so every fork of an over-limit
// conversation added a key nothing could ever clear. It is not one any more — the guard
// refuses to trigger on `context.branchId` (see "WHY A BRANCH ROUND IS SKIPPED ENTIRELY"),
// which is also why its documented no-op `pause()`/`resume()` are no longer paid for.
// Neither case is worth a `thread.deleted` subscription, which would also make the live hook
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
//   - ../core/context-pruning.ts    — THE POLICY (`planContextPruning`), pure and table-tested
//   - ../core/argument-fingerprint.ts — the work identity the policy matches on
//   - ../core/tool-outcome.ts       — the persisted `outcome` it reads (absent ⇒ completed)
//   - ../core/context-estimate.ts   — the estimator feeding `estimatedTokens`: ~4 chars/token
//                                     for the text, anchored on the provider's reported
//                                     `usage.input` for the prefix as soon as a request
//                                     reports it (T5.4). Also the `minTokens` floor's measure.
//   - ../harness.ts                 — the `turn.before` emission (requestTurn → emitTurnBefore),
//                                     the pause/resume implementations (pauseThreadState),
//                                     `setIncluded` (the flag write) and the coalesced
//                                     per-round `agent_message` report (closeRoundObservations)
//   - ../plugin/hooks.ts            — sequential, fail-open dispatch of hook handlers
//   - ../plugin/host.ts             — how this built-in is applied (and replaced by a host),
//                                     and where `api.report.diagnostic` gets its `owner`
//   - ../plugin/manifest.ts         — GENERATED wiring: this file is auto-discovered
// The policy itself, as a pure function (../core/context-pruning.ts). Imported from the
// module, not from the barrel: this file is auto-discovered by the manifest scanner and
// stays a leaf that depends on nothing but core + types.
import { planContextPruning } from '../core/context-pruning';
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
        'Watches each agent conversation against a context limit and, when the limit is reached, prunes the tool units a later success already answered at the turn boundary before the next model request is sent. Nothing is deleted: a pruned unit keeps its place in history and can be switched back on.',
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
                'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost.'
        },
        {
            key: 'enabled',
            label: 'Compact conversations',
            type: 'boolean',
            default: true,
            description:
                'Runs the pruning pass on or off. Off changes nothing else: the limit is still read, the context bar still measures, and no other plugin is affected. It is the switch an operator expects when they want the behaviour gone without removing the built-in.'
        },
        {
            key: 'minTokens',
            label: 'Minimum saving per pass (tokens)',
            type: 'number',
            default: 200,
            min: 0,
            step: 50,
            description:
                'A pass must withhold at least this many estimated tokens, or it does nothing at all — no flag write, no persistence notification, no save. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes running on every turn cheap. Measured as a difference of the same estimate, so any provider anchor cancels out of it and only the withheld characters count.'
        },
        {
            key: 'safetyTurns',
            label: 'Recent units to protect',
            type: 'number',
            default: 6,
            min: 0,
            step: 1,
            description:
                'How many units at the END of the conversation no pass may touch. A unit is one assistant tool-call block plus its results, or one standalone message. The horizon counts UNITS from the end, never the per-run turn counter: a failure the model has not moved past yet is the highest-signal thing in the window, and pruning it is how an agent repeats the call it just watched fail. 0 removes the horizon.'
        },
        {
            key: 'mode',
            label: 'Compaction mode',
            type: 'string',
            default: 'exclude',
            description:
                'What a compaction does with a unit it removes. Only "exclude" is implemented today: the unit keeps its place in canonical history and simply stops being sent, which is the reversible option the evidence favours. "annotate" — replace the result with a one-line handle back to the full text — is the planned SECOND WRITER over the same candidate list the policy already computes before writing anything, and any value other than "exclude" (including that one) behaves as "exclude" until it lands. The value actually used is reported in the pass diagnostic.'
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

// The same duplication rule for the four policy settings T4.6 declares: each constant here
// is the `default:` of the descriptor above it, written out because the scanner cannot read
// a computed literal. `MIN_TOKENS_DEFAULT`/`SAFETY_TURNS_DEFAULT` are reasoned from the
// estimator (~4 chars/token), so 200 tokens is roughly one medium tool result — enough to
// beat the cache cost of touching the middle of a conversation, small enough that a real
// prune is never refused. `SAFETY_TURNS_DEFAULT` is 6 units because a unit is coarse: that
// is roughly a failure, its retry, the retry's answer and the turn after, which is exactly
// the window the retry-loop evidence says must stay visible.
const ENABLED_DEFAULT = true;
const MIN_TOKENS_DEFAULT = 200;
const SAFETY_TURNS_DEFAULT = 6;
const MODE_DEFAULT = 'exclude';

// Every `mode` value this build implements. `annotate` is deliberately NOT listed: an
// operator who stores it today gets `exclude` (the candidate list is already computed
// before any write, which is the seam T0 Q1 asked to keep), and the pass diagnostic reports
// both the value stored and the value used. Exported so a future writer and the UI extend
// ONE list rather than re-spelling the union.
export const COMPACTION_MODES: readonly string[] = [MODE_DEFAULT];

// Not a setting (T4.6 declares exactly the four above, and a knob nobody asked for is a knob
// nobody reads): the bound on how many units ONE pass may disable, so the first pass over an
// old conversation cannot silently empty it (T4.3). Oldest eligible units are taken first, so
// the bound also decides WHAT survives: the recent tail, and one cache invalidation instead
// of a rolling series of them.
const MAX_UNITS_PER_PASS = 8;

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

// THE ACTION — the writer, not the decision (see "THE POLICY LIVES ELSEWHERE ON PURPOSE"
// above). Three steps, in this order, each of which is a guard against a specific failure:
//
//   1. read the settings (re-read every pass, because `api.settings` is live by contract),
//   2. compute the WHOLE candidate list against `context.entries` — the canonical transcript
//      including disabled entries — and write only if it clears `minTokens`,
//   3. report what happened on the diagnostic channel.
//
// Writing NOTHING is the common case and it is free: no flag write means no
// `agent_message` notification, which means no whole-document save (T4.4).
//
// Every write goes through `context.setIncluded(entry, false)`, which cascades the unit:
// the assistant message that asked for the calls, every result of that block, and its
// request-only placeholders (../types `HarnessContextEntry.included`). That is why pruning
// can never leave the provider with a half-answered `tool_calls[]` (T3.4), and why this
// action never has to think about pairing — the projection oracle in
// src/harness.inclusion.test.ts is what pins it.
//
// An implementation that later calls `replaceHistory()` must re-state the newest turn:
// `replaceHistory` replaces the WHOLE committed transcript, including the prompt this run
// just appended (src/harness.plugin.test.ts pins that behaviour). That is T6's problem, and
// this stage deliberately stays inside `setIncluded`.
export async function executeCompaction(
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): Promise<void> {
    // A branch round prunes nothing (see the header): the flag would land on a transcript
    // that is about to be incorporated as text, and the owner re-derives the same decision on
    // its own round. Checked here as well as in the guard because a host may call this action
    // directly — the guard's skip is a trigger policy, this one is a correctness rule.
    if (context.branchId !== undefined) return;

    // Rule 0, re-read per pass like every other setting.
    if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return;

    const minTokens = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);
    const safetyTurns = api.settings.number('safetyTurns', SAFETY_TURNS_DEFAULT);
    const requestedMode = api.settings.string('mode', MODE_DEFAULT);

    // `annotate` is accepted by the UI and not implemented, so it degrades to the one writer
    // that exists rather than failing the turn. Both values are reported below, so the
    // fallback is never invisible to the operator who set it.
    const mode = COMPACTION_MODES.indexOf(requestedMode) === -1 ? MODE_DEFAULT : requestedMode;

    // ONE read of the canonical list. `entries` is built on first access and cached for this
    // handler, and the entry objects stay valid across flag writes (only a `replaceHistory()`
    // invalidates them), so the writes below address exactly what the plan matched.
    const entries = context.entries;

    const plan = planContextPruning(entries, {
        safetyUnits: safetyTurns,
        maxUnits: MAX_UNITS_PER_PASS,
        minTokens
    });

    if (plan.candidates.length === 0) {
        // The one case worth a line even though nothing changed: units WERE superseded, but
        // the saving did not clear the floor. Without it, "compaction is doing nothing" and
        // "compaction is refusing a 60-token prune" look identical from outside (T4.7's whole
        // point), and an operator raising `contextLimit` would be chasing the wrong knob.
        if (plan.belowFloor) {
            api.report.diagnostic({
                message:
                    `context-compaction considered ${plan.consideredUnits} unit(s) and withheld nothing: ` +
                    `~${plan.withheldTokens} estimated tokens is under the ${minTokens} minTokens floor.`,
                data: { mode, minTokens, withheldTokens: plan.withheldTokens, consideredUnits: plan.consideredUnits }
            });
        }

        return;
    }

    const units = plan.candidates.map((candidate) => ({
        index: candidate.leaderIndex,
        ...(candidate.leaderMessageId === undefined
            ? {}
            : { messageId: candidate.leaderMessageId }),
        outcomes: candidate.outcomes,
        tokens: candidate.tokens,
        // WHAT ANSWERED IT (T4.5). The superseding unit's stable address when it has one, so
        // the operator can go read the retry; the transcript index otherwise. Naming only the
        // pruned unit would leave "and therefore what?" unanswered, which is the failure mode
        // the changelog history in F5 is about.
        supersededBy: candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`
    }));

    for (const candidate of plan.candidates) {
        // Located by index rather than reused from the plan, so a `replaceHistory()` from a
        // LATER handler in this same round cannot make this write address a stale entry: if
        // the unit the plan named is no longer in the transcript, the entry is absent and the
        // write is skipped. (An entry from an EARLIER handler is still refused by
        // `setIncluded` itself; this is the mirror-image hazard.)
        const entry = entries.find((candidate2) => candidate2.index === candidate.leaderIndex);

        if (entry === undefined) continue;

        // One write per unit; the cascade does the rest. `false` is the only stored spelling
        // of "withheld", so a second pass over the same transcript changes nothing at all.
        context.setIncluded(entry, false);
    }

    // T4.5 — the pass report. One line per pruned unit inside ONE diagnostic, because a
    // multi-unit pass is one logical decision and an operator reads it as such. The text is
    // self-contained on purpose: a host with no structured sink still learns what left the
    // context and what replaced it.
    api.report.diagnostic({
        message:
            `context-compaction withheld ${units.length} superseded tool unit(s), ` +
            `~${plan.withheldTokens} estimated tokens (mode ${mode}${
                requestedMode === mode ? '' : `, setting mode ${requestedMode}`
            }): ${units
                .map(
                    (unit) =>
                        `#${unit.index}${
                            'messageId' in unit ? ` ${String(unit.messageId)}` : ''
                        } [${unit.outcomes.join('/')}] answered by ${unit.supersededBy}`
                )
                .join('; ')}`,
        data: {
            mode,
            ...(requestedMode === mode ? {} : { requestedMode }),
            minTokens,
            safetyTurns,
            maxUnits: MAX_UNITS_PER_PASS,
            withheldTokens: plan.withheldTokens,
            consideredUnits: plan.consideredUnits,
            units
        }
    });
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
        // Rule 0 — the whole-plugin switch, read first so a disabled plugin costs one setting
        // read and no transcript work at all. It is re-read every turn like the rest
        // (`api.settings` is live by contract), which is what lets an operator flip it from
        // the UI mid-session.
        if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return undefined;

        const limit = api.settings.number('contextLimit', CONTEXT_LIMIT_DEFAULT);

        // Rule 1: a non-positive limit is "off". `Number.isFinite` also refuses NaN, so
        // a corrupt stored value can never make every turn look over the limit.
        if (!Number.isFinite(limit) || limit <= 0) return undefined;

        // Rule 4: never compact the compactor's own agents.
        if (isInternalAgent(context.agent)) return undefined;

        // Rule 5 (ratified 2026-11-09): a BRANCH round never triggers a pass at all. Its
        // `pause()`/`resume()` are no-ops, its transcript is ephemeral, and its cooldown key
        // (`branch:<id>`, one per fork) could never be cleared — so the trigger bought nothing
        // and left a dead entry behind. See the header section on the branch skip, and the
        // matching correctness check in `executeCompaction`.
        if (context.branchId !== undefined) return undefined;

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
