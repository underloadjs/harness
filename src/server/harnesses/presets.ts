// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// TWO KINDS OF PRESET (T5: only the first kind SHIPS)
// ---------------------------------------------------
//   live  — general, instruct, research, workspace, reviewer, planner, debugger. All
//           built from TRUSTED agent profiles in src/agents through `createProfiledHarness`
//           (./toolbox.ts), so they register the SAME toolbox: package coding
//           tools, the app tools, environment-backed search, and the harness core
//           tools. Only the agents differ: names, instructions, guidelines,
//           primary, and subagents. These seven are `presets`, the default
//           catalogue every registry and every `GET /harnesses` listing starts from.
//   fixture — demo (a scripted offline run with timeNow only) and flaky (the
//           recoverable-failure example with `testFlaky`). They are NOT in
//           `presets`: a user opening the product must not be offered a scripted
//           card or a card whose tool throws two calls in three. They stay exported
//           as `FIXTURE_PRESETS` because they are still load-bearing:
//             - a host or a test that wants an offline loop injects them explicitly
//               (`createHarnessRegistry(ALL_PRESET_TEMPLATES)`);
//             - a session saved on an older build when demo/flaky WERE shipped must
//               still restore, and a 'scripted' record rebuilds its factory by name
//               from `ALL_PRESET_TEMPLATES` (see ./registry.ts presetFromRecord).
//           Deleting a shipped harness is therefore not the same as un-shipping a
//           fixture: a deletion is a durable operator decision (a tombstone in the
//           database), while un-shipping is this module no longer listing a row.
//
// THE SEVEN REAL ROLES
// --------------------
//   general   — DEFAULT. Does the whole task alone; `subagents: []`, so `delegate` is
//               never even registered for it (src/harness.ts `activation: 'subagents'`).
//   instruct  — a worker that delegates ONLY the steps that would burn its context
//               (research, a long read, a review) and keeps every step it must build.
//   research  — read-only investigator (visible title "Explore").
//   workspace — the implementor (visible title "Analyst"; the id is legacy for compatibility).
//   reviewer  — strict independent judge of plans, code, documents, and claims.
//   planner   — the orchestrator (visible title "Manager"): delegates every step and
//               independently reviews each result before accepting it.
//   debugger  — stress-tests the whole system; widest allowlist, nothing off-limits.
//
// HOW A TEAM IS DERIVED, AND THE ONE EXCEPTION. `teamOf()` builds every live preset's
// allowlist from ONE list, so the presets cannot drift. Two ids are excluded: the primary
// (a harness has exactly one primary and the registry rejects a subagent that names it) and
// `planner`/Manager, because a Manager refuses to run as a delegate (src/agents/planner.ts
// states the refusal) — offering a member that answers "I do not run as a subagent" is a
// wasted run. A USER-created team may still select the Manager; the refusal is what makes
// that honest. `summarizer` stays everywhere so the `textSummarize` delegated path keeps
// working (it condenses locally when absent).
//
// The one-level delegation rule is a harness property (a subagent never receives delegate,
// src/harness.ts `primaryOnlyDefinitions`), so none of these prompts may ask a subagent to
// delegate again.
//
// EDITABLE TEMPLATES (R20.1)
// --------------------------
// Every entry here is a TEMPLATE. The registry copies it into an independent
// application entry, so a PATCH never mutates this module (and a later session
// keeps the factory it captured). `editable: true` is a compatibility wire field
// only; there is no read-only category, no categorization UI, and the registry
// does not gate a PATCH on it. `template` (not on the wire) tells the registry
// what a metadata-only patch must preserve:
//   - 'scripted' — demo keeps its offline script and timeNow registry;
//   - 'flaky'    — the example keeps testFlaky and its shared toolbox;
//   - 'live'     — rebuilt from the selected agents/models.
// An executable change (primary/subagents/agentModels) on demo upgrades it to a
// live profiled harness; on flaky it rebuilds the live toolbox and retains
// testFlaky. See ./registry.ts update().
//
// Instructions live in src/agents, not here
// -----------------------------------------
// The words a model is seeded with are trusted catalogue data (AgentProfile), so a
// harness definition and a user-created harness build an agent from the same
// profile. This file only maps a harness onto agent ids: `agents` order is
// [primary, ...subagents].
//
// The preset name is the harness's name and, by convention, its entry agent's
// name. The server's registry keys by preset name; the agent registry key inside
// the harness is the agent id.
//
// Backward compatibility: `writer` and `assistant` are aliases of `instruct`,
// and `researcher` is an alias of `research` (see ./registry.ts PRESET_ALIASES +
// findPreset). They resolve to the canonical preset, so an old CLI invocation or
// bookmarked session request still runs; they are not listed a second time. No alias
// was added for a visible title ("Coder"/"Researcher"/"Planner" and their successors
// "Analyst"/"Explore"/"Manager" are TITLES, not names): the harness and agent ids stay
// `workspace`, `research` and `planner`, and a new reserved name could collide with an
// existing user-created harness on restore. The harness ids themselves are unchanged by
// the roster change — only titles, descriptions and subagent allowlists moved, so a
// saved session keeps restoring. Renaming an AGENT id is a different matter entirely: an
// id is persisted in every record and there is no agent-level alias, so it is not done
// here (see the matching note in ../../agents/index.ts).
// `LEGACY_PRESET_DEFINITIONS` below records the previous shipped executable
// definitions so ./registry.ts can refresh a built-in row that was never
// customised.
//
// Cross-references:
//   - ../src/agents     — AgentProfile registry (instruction + guidelines)
//   - ./toolbox.ts      — createProfiledHarness / createToolboxHarness
//   - ./types.ts        — HarnessPreset metadata (primary/subagents/tools/builtin)
//   - ./registry.ts     — restore policy, aliases, validation
//   - ../api.ts  — descriptors resolved from this metadata

import { agent, harness } from '../../harness';
import { agentInstruction, AGENT_PROFILES } from '../../agents';
import type { HarnessPreset, RunnerSettings } from './types';
import { scriptedDemo } from './demo';
import {
    EXAMPLE_APP_TOOL_SOURCES,
    PRESET_MAX_ITERATIONS,
    SHARED_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createProfiledHarness,
    createToolboxHarness,
    providerOf
} from './toolbox';

// Re-exported for callers that imported the app-wide tool-loop budget from here
// (the CLI and server tests did); the value now lives with the shared factory.
export { PRESET_MAX_ITERATIONS };

// The example-only app tools, in registration order. T25: derived from the discovered
// `server/tools/examples` folder instead of the literal 'testFlaky', so a second
// example entry joins this preset with no edit here (and still no name filter in the
// shared toolbox).
const EXAMPLE_TOOL_NAMES: readonly string[] = Object.keys(EXAMPLE_APP_TOOL_SOURCES);

// The real roles, in catalogue/descriptor order, DEFAULT FIRST. This is the ONE list
// the teams and the delegate enums are derived from: adding a role here adds it to every
// built-in team (except where `teamOf` excludes it) with no other edit here.
export const SPECIALIST_AGENT_NAMES = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger'
] as const;

// `summarizer` stays a subagent everywhere so the `textSummarize` delegated path
// keeps working in the real presets (it condenses locally when absent).
const SUMMARIZER_AGENT_NAME = 'summarizer';

// The Manager id, named here because it is excluded from every built-in team.
// A Manager refuses to run as a delegate (../../agents/planner.ts states the rule), so
// offering it as a target would only burn a child run. The refusal still applies to a
// user-created team that selects it — this exclusion just keeps the shipped teams honest.
const MANAGER_AGENT_NAME = 'planner';

// The subagent allowlist for one primary: every OTHER real role except the Manager, then
// the summarizer. The primary is excluded because a harness has exactly one primary and the
// registry rejects a subagent that names it.
//
// The `general` role is a legal target for the other primaries (it takes a whole
// self-contained job), but its OWN preset passes `subagents: []` rather than this list, so
// it never receives `delegate` at all — that is the contract of the default card, and the
// runtime enforces it by not registering the tool (src/harness.ts `activation: 'subagents'`).
export const teamOf = (primary: string): string[] => [
    ...SPECIALIST_AGENT_NAMES.filter((name) => name !== primary && name !== MANAGER_AGENT_NAME),
    SUMMARIZER_AGENT_NAME
];

// ---------------------------------------------------------------------------
// Live harnesses: same toolbox, different selected agents
// ---------------------------------------------------------------------------

// General: THE DEFAULT CARD, and the only live preset with no team. `subagents: []` is a
// deliberate, load-bearing choice rather than an omission: `delegate` registers only when
// the allowlist is non-empty (src/harness.ts `activation: 'subagents'`), so this harness
// never declares the tool and `toolRequest` cannot surface it. The agent therefore cannot
// split work out even by accident, which is exactly the contract of the default role.
// Its `environmentTools` line is the same reasoning as every other live preset below: the
// shared factory opts into `websearch` AND `webfetch`, `search` appears only when a key
// resolves, and `fetch` registers either way because its native provider needs no key.
const general: HarnessPreset = {
    name: 'general',
    title: 'General',
    description:
        'The default general-purpose agent, with the full shared toolbox and NO subagents: it does every step itself, so `delegate` is not registered and cannot be enabled. File read/write/edit/glob and a configured search are always available; call toolRequest for files, commands, diffs, syntax checks, time, text, or notes.',
    requiresEndpoint: true,
    primary: 'general',
    // Empty on purpose — see the note above. `teamOf('general')` is what a delegating
    // variant would use; this card must not.
    subagents: [],
    agents: ['general'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('general', [])
};

// Instruct: the worker posture between General and the Manager. Same toolbox; the profile
// decides WHO does each step — it keeps anything it would have to write or run afterwards
// and delegates only context-burning reading (an investigation, a long document, a review).
const instructTeam = teamOf('instruct');

const instruct: HarnessPreset = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'General worker with the full shared toolbox and the other roles as direct subagents. It does its own building and editing, and delegates only the steps that would burn its context: research, exploration, a long read, a review. Unlike the Manager, it never hands out work it must still finish itself.',
    requiresEndpoint: true,
    primary: 'instruct',
    subagents: instructTeam,
    agents: ['instruct', ...instructTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('instruct', instructTeam)
};

// Research (visible title "Explore"): the read-only investigator. Same toolbox as every
// live harness — nothing can deny it `write`/`edit`, so the read-only contract lives in the
// profile. Its team is the ordinary one so a standalone Explore card can still ask the
// Analyst to run something or the Reviewer to challenge a conclusion.
const researchTeam = teamOf('research');

const research: HarnessPreset = {
    name: 'research',
    title: 'Explore',
    description:
        'Read-only investigator with the same full toolbox as every live harness and the other roles as direct subagents. Maps files, symbols, configuration and the web, cross-checks what decides the answer, and cites file, line, tool, or URL. Changes nothing on disk unless the brief authorises a change.',
    requiresEndpoint: true,
    primary: 'research',
    subagents: researchTeam,
    agents: ['research', ...researchTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('research', researchTeam)
};

// Workspace (visible title "Analyst"): the implementor. The id stays `workspace` for every
// saved session, bookmark and script; only the title moved. Same toolbox as every live
// harness — the profile is what makes it an engineering role, which is exactly the product
// rule ("the only difference is the agents configuration").
const workspaceTeam = teamOf('workspace');

const workspace: HarnessPreset = {
    name: 'workspace',
    title: 'Analyst',
    description:
        'The implementor, with the full shared toolbox and the other roles as direct subagents: file read/write/edit/glob are always available, and files, syntax checks, diffs, and commands are discovered by tag. Writes the change in the existing style of the codebase, keeps it minimal and efficient, and verifies it with a real check.',
    requiresEndpoint: true,
    primary: 'workspace',
    subagents: workspaceTeam,
    agents: ['workspace', ...workspaceTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('workspace', workspaceTeam)
};

// Reviewer: a strict pass over a change, a plan, a document, or a claim. Its team is the
// ordinary one, so it can ask the Analyst to verify a code path or Explore to confirm a
// fact, but its own default is read-only — the Manager depends on that when it sends work
// here for an independent check.
const reviewerTeam = teamOf('reviewer');

const reviewer: HarnessPreset = {
    name: 'reviewer',
    title: 'Reviewer',
    description:
        'Strict, independent reviewer with the full shared toolbox and the other roles as direct subagents. Judges plans, code, documents, and claims against their own acceptance criteria, reports each finding with file/line or quote evidence plus the smallest fix, and says plainly when there is nothing to find. Reads and verifies by default; edits only when asked.',
    requiresEndpoint: true,
    primary: 'reviewer',
    subagents: reviewerTeam,
    agents: ['reviewer', ...reviewerTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('reviewer', reviewerTeam)
};

// Planner (visible title "Manager"): the orchestrator, the preset that exists FOR
// delegation. Its team deliberately contains every other role by id (the Manager itself is
// excluded from every OTHER team, because it refuses to be a delegate), so `delegate`
// targets really exist — and it accepts no step on its author's word without a reviewer's
// independent check.
const plannerTeam = teamOf('planner');

const planner: HarnessPreset = {
    name: 'planner',
    title: 'Manager',
    description:
        'Planning and orchestration lead with the full shared toolbox and every other role as a direct subagent. Holds the whole goal, writes an explicit plan, delegates every step (research, workspace, reviewer, debugger, general, instruct), and accepts each result only after an independent review. It never executes a step itself, and refuses to run as a delegate.',
    requiresEndpoint: true,
    primary: 'planner',
    subagents: plannerTeam,
    agents: ['planner', ...plannerTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('planner', plannerTeam)
};

// Debugger: the stress-test harness. Same toolbox as every live preset (no profile can add
// a tool), so "access to everything" is expressed as the widest TEAM plus a profile that
// tells it nothing is off-limits — it is expected to unlock the searchable half itself and
// to drive the system into a failure rather than route around one.
const debuggerTeam = teamOf('debugger');

const debuggerPreset: HarnessPreset = {
    name: 'debugger',
    title: 'Debugger',
    description:
        'Stress-test harness with the full shared toolbox and every other role as a direct subagent. Nothing is off-limits: it enables any searchable tool, runs any command, exercises each capability at its edges, reproduces what breaks, and reports the exact input and error.',
    requiresEndpoint: true,
    primary: 'debugger',
    subagents: debuggerTeam,
    agents: ['debugger', ...debuggerTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('debugger', debuggerTeam)
};

// ---------------------------------------------------------------------------
// Examples and fixtures
// ---------------------------------------------------------------------------

// The offline demo is a scripted transport, not a live harness: it demonstrates
// the loop (reasoning, toolRequest discovery, one tool call, answer) with no
// endpoint. Its timeNow-only registry is intentional and pinned by its script, so
// it is exempt from the shared-toolbox rule. It is still an EDITABLE template
// (R20.1): a metadata-only PATCH (title/description) keeps the script; an
// executable PATCH (primary/subagents/agentModels) upgrades it to an honest live
// profiled harness (shared toolbox, requiresEndpoint, no script). `template` is
// the registry's signal for that distinction — see ./registry.ts.
const demo: HarnessPreset = {
    name: 'demo',
    title: 'Scripted demo',
    description:
        'Runs a scripted transport: a reasoning stream, a toolRequest discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to the real presets.',
    requiresEndpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['demo'],
    tools: ['timeNow'],
    builtin: true,
    editable: true,
    template: 'scripted',
    // Adopted by the registry only when an executable PATCH upgrades this template
    // and the operator has not edited the shipped title/description (R20.1): the
    // card must stop claiming "scripted, no endpoint" once it runs live turns.
    live: {
        title: 'Live demo',
        description:
            'A live harness built from the selected agents with the shared toolbox, running against the session provider. This entry started as the scripted demo and no longer uses the offline script.'
    },
    create: (settings, progress, report) =>
        harness({
            agents: {
                demo: agent({
                    model: settings.model.trim().length > 0 ? settings.model : 'scripted/demo',
                    // The trusted profile's instruction + guidelines, same
                    // composition every live agent uses. The scripted transport
                    // ignores them; keeping the path identical proves the profile
                    // is the single source of the prompt.
                    instruction: agentInstruction(AGENT_PROFILES.demo),
                    stream: scriptedDemo()
                })
            },
            // T19/F1: the scripted fixture is still a shipped exception in its
            // TOOL SET, but not in how that tool is registered. Compile its one
            // editable source entry through the same startup kernel instead of
            // passing a prebuilt definition through `tools`.
            // T25: the path is the DISCOVERED one (server/tools/shared/timeNow.tool.ts),
            // so moving/renaming the entry cannot leave a stale literal behind.
            toolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow },
            presets: false,
            // Explicit entry point, even with one agent: the documented style,
            // and it keeps the harness name independent of key order.
            primary: 'demo',
            // The optional third argument is the server's persistence observer
            // (R3b). A scripted harness mutates the todo/record stores too, so its
            // notifications matter exactly like a live harness's.
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange }),
                // T1.5 last mile: the host's plugin-diagnostic sink, forwarded exactly like the
                // observer above. The scripted transport still runs the SAME built-in plugins a
                // live harness does (src/plugin/manifest.ts), so a hook failure here is a real
                // failure the host has to be able to see; ignoring this member would leave the
                // shipped fixture blind while every live preset reported.
                ...(report?.diagnostic === undefined ? {} : { diagnostic: report.diagnostic })
            },
            // N4: the same owner-interaction hook every live factory gets. The
            // scripted transport never calls actionRequest, but forwarding it keeps
            // "a preset choice changes agents, not host capabilities". It must be a
            // TOP-LEVEL configuration field: presence registers the tool.
            ...(report?.interaction === undefined ? {} : { interaction: report.interaction }),
            // R2/R3: the two DEPLOYMENT-WIDE switches, forwarded on the same top-level rule
            // the live toolbox already honours (../harnesses/toolbox.ts). Before this line the
            // scripted fixture was the one preset that IGNORED them: `PATCH
            // /v1/harness/tools/{tool_id}` left `timeNow` declared, callable and "enabled" to a
            // demo model, and `PATCH /v1/harness/plugins/{plugin_id}` left the built-in plugins'
            // hooks running with their shipped knobs - inline AND on a lane, because the lane
            // hands this same report to the same factory (../workers/lane-worker-loop.ts
            // `sayHello`). The scripted transport changes nothing about that: the switches gate
            // the runtime's tool decisions and the framework's hook delivery, not the stream.
            //
            // Absence keeps the historical behaviour byte for byte: no provider means nothing
            // disabled and the library's declared-default plugin settings (src/harness.ts:1395).
            ...(report?.pluginSettings === undefined ? {} : { pluginSettings: report.pluginSettings }),
            ...(report?.toolSettings === undefined ? {} : { toolSettings: report.toolSettings })
        })
};

// Recoverable failures is a live example, so it gets the shared toolbox too and
// adds the example tools. Those stay out of the shared table on purpose: `testFlaky`
// throws two calls out of three and keeps its attempt count per AGENT (a WeakMap
// keyed by the requesting agent, so two sessions never share a count), which must
// never be part of what the real presets can call. The example's failure behaviour is
// its point, so its template is `flaky`: a metadata-only PATCH keeps this factory and
// its extra tools, while an executable PATCH rebuilds the live toolbox with them
// retained. The harness id stays `flaky`.
//
// T25: the tool SET is `[...SHARED_TOOL_NAMES, ...EXAMPLE_TOOL_NAMES]` and the
// sources are the discovered example map — both derived from the folders, so no name
// is hardcoded here.
const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures (example)',
    description:
        'The shared toolbox plus a tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying. An example of the failure path, not a general-purpose agent.',
    requiresEndpoint: true,
    primary: 'flaky',
    subagents: [],
    agents: ['flaky'],
    tools: [...SHARED_TOOL_NAMES, ...EXAMPLE_TOOL_NAMES],
    // R18: the factory below uses createToolboxHarness, which opts into search
    // exactly like the live presets. Declaring it here keeps descriptor.tools and
    // descriptor.coreTools equal to what the session actually registers.
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'flaky',
    create: (settings: RunnerSettings, progress, report) =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles(['flaky'], settings),
                primary: 'flaky',
                subagents: [],
                // The example tools; excluded from the shared set but still compiled
                // from their editable source entries (T19/F1, T25).
                extraToolSources: { ...EXAMPLE_APP_TOOL_SOURCES }
            },
            settings,
            progress,
            report
        )
};

// ---------------------------------------------------------------------------
// Catalogue exports (T5)
// ---------------------------------------------------------------------------

// The PRODUCTION catalogue, in UI/CLI order (general is the default/first card, which is
// also what `DEFAULT_CLI_PRESET` in ../cli/options.ts selects). Every entry is a real,
// usable configuration: a live agent team on the shared toolbox that runs against the
// configured provider. The scripted demo and the failure example are deliberately absent —
// a catalogue a user picks from should not contain a card that never calls a model, or one
// whose tool throws on purpose.
//
// ORDER IS A CONTRACT, NOT A PREFERENCE: it is the order `GET /harnesses` returns, the order
// a picker renders, and the order the frontend palette assigns tones by. A new role is added
// here on purpose, and it must match `AGENT_PROFILE_NAMES` in ../../agents/index.ts.
export const presets: readonly HarnessPreset[] = [
    general,
    instruct,
    research,
    workspace,
    reviewer,
    planner,
    debuggerPreset
];

// The offline/example fixtures, kept as first-class presets so a host or a test
// can inject them explicitly (`createHarnessRegistry(FIXTURE_PRESETS)` or
// `[...presets, ...FIXTURE_PRESETS]`). They are no longer part of `presets`, so
// `GET /harnesses` and a new session cannot reach them by accident, but their
// factories are unchanged: demo still scripts a full loop with no endpoint, and
// flaky still registers `testFlaky`.
export const FIXTURE_PRESETS: readonly HarnessPreset[] = [demo, failure];

// Every template this build can rebuild a factory from: the shipped catalogue
// PLUS the fixtures. Two consumers need the superset:
//   - ./registry.ts `presetFromRecord`, whose 'scripted' branch resolves a frozen
//     session's factory BY NAME, so a session created on an older build when demo
//     shipped still restores (a legacy flaky record rebuilds from its `flaky`
//     template and never needs this list);
//   - a test/host that wants the old offline-capable registry in one call.
// Order is catalogue-first, so an injected registry lists the real presets before
// the fixtures, exactly as the UI used to.
export const ALL_PRESET_TEMPLATES: readonly HarnessPreset[] = [...presets, ...FIXTURE_PRESETS];

// Previous shipped EXECUTABLE definitions, keyed by preset id, for the restore
// policy in ./registry.ts.
//
// WHY: a persisted registry row is a copy of what shipped at the time. Replaying it
// verbatim would pin an old build's defaults forever, so an improved roster would
// never reach an existing installation. These entries are the exact fields that
// T3 changed, which makes "the operator never customised this row" provable: a
// saved record whose executable fields still match the table is a SHIPPED default,
// not a decision, so the current template wins. A record that differs in any
// executable field is treated as a real customisation and is replayed unchanged.
//
// Only the presets whose defaults moved need an entry; a record whose fields equal
// the CURRENT template is already skipped by `presetRecordEquals` in restore.
// Title/description are recorded too, only so an operator's prose edit can be
// identified and preserved across the refresh.
//
// WHY THIS TABLE WAS NOT EXTENDED BY THE ROSTER/ROLE-CONTRACT PASS. The table holds ONE
// snapshot per preset id, and the three entries below are the pre-T3 shapes. The roster
// change (new `general` + `debugger` cards, `planner` excluded from every team, new titles
// Explore/Analyst/Manager) moves the shipped default AGAIN, so an install holding the
// pre-T3 row refreshes to the new template, while an install holding the T3 row no longer
// matches its single legacy snapshot and is replayed as a customisation: its team is rebuilt
// from its own saved ids, every one of which is still a known profile, so restore cannot
// fail. Recording the T3 shape instead would have traded one refresh path for the other
// rather than keeping both; a future migration that wants both should widen this type to a
// list of accepted historical shapes rather than replacing an entry.
export type LegacyPresetDefinition = {
    title: string;
    description: string;
    requiresEndpoint: boolean;
    primary: string;
    subagents: readonly string[];
    agents: readonly string[];
    tools: readonly string[];
    environmentTools?: readonly string[];
    template?: 'live' | 'scripted' | 'flaky';
};

export const LEGACY_PRESET_DEFINITIONS: Readonly<Record<string, LegacyPresetDefinition>> = {
    instruct: {
        title: 'Instruct',
        description:
            'A general instruction-following agent with the full shared toolbox. File read/write/edit/glob and a configured search are always available; call toolRequest with capability tags for files, commands, diffs, syntax checks, time, text, or notes. The live presets differ only in their agents, not their tools.',
        requiresEndpoint: true,
        primary: 'instruct',
        subagents: [],
        agents: ['instruct'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['search'],
        template: 'live'
    },
    research: {
        title: 'Research',
        description:
            'A research agent with the same full toolbox as every live harness, plus a summarizer subagent. read and glob are always available; `primary` and `subagents` are explicit: the research agent is the entry point and the only agent that may delegate, and delegation is one level deep. Web search is core and joins the toolbox when the host configured a search key.',
        requiresEndpoint: true,
        primary: 'research',
        subagents: ['summarizer'],
        agents: ['research', 'summarizer'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['search'],
        template: 'live'
    },
    workspace: {
        title: 'Workspace (coding)',
        description:
            'A coding agent with the full shared toolbox: file read/write/edit/glob are always available, and files, syntax checks, diffs, and commands are discovered by tag. Web search is available when a key is configured. It has the same registered tools as every live harness and differs only in its agent profile and routing. Everything runs on the server host.',
        requiresEndpoint: true,
        primary: 'workspace',
        subagents: [],
        agents: ['workspace'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['search'],
        template: 'live'
    }
};
