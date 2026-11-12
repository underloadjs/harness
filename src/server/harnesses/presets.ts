// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// EVERY PRESET HERE IS A PRODUCTION CONFIGURATION
// ------------------------------------------------
//   general, instruct, research, workspace, reviewer, planner, debugger, chat. All eight
//   are built from TRUSTED agent profiles in src/agents through `createProfiledHarness`
//   (./toolbox.ts), and the first SEVEN register the SAME toolbox: package coding tools, the app
//   tools, environment-backed search, and the harness core tools. Only the agents differ: names,
//   instructions, guidelines, primary, and subagents. The eighth, `chat`, is the ONE declared
//   exception on the toolbox axis (./toolbox.ts `sharedToolbox: false`): it
//   registers no catalogue tool at all, which is exactly why it exists — a client that wants a
//   session that never touches the server host had no card to pick. These eight are `presets`, the
//   default catalogue every registry and every `GET /harnesses` listing starts from — and they are
//   the WHOLE catalogue. There is no second tier.
//
//   THE FIXTURES ARE GONE. `demo` (a scripted offline run with timeNow only) and
//   `flaky` (the recoverable-failure example with `testFlaky`) used to ship as
//   `FIXTURE_PRESETS` behind a `ALL_PRESET_TEMPLATES` superset. They are deleted, along
//   with the scripted transport (./demo.ts), the `testFlaky` example tool, and the two
//   agent profiles. A card a user can pick has to be a configuration that actually runs
//   a model on the shared toolbox; a scripted transcript and a tool that throws on
//   purpose are not that. Anything that needs one — a test that wants an offline loop, a
//   host that wants an extra-tool harness — declares its own `HarnessPreset` next to
//   itself and injects it (`createHarnessRegistry([myFixture])`). Nothing in the shipped
//   product depends on the deleted pair.
//
//   DELETION IS NOT A TOMBSTONE. Removing a preset from this module is not the same as
//   an operator deleting a card: a deletion is a durable row in the database, while this
//   is simply a catalogue that no longer has the row. The consequence is restore, and it
//   is handled in ./registry.ts: a saved row or a frozen session naming `demo` or
//   `flaky` no longer has a template to rebuild from, so it is reported rather than
//   silently resurrected (see the note above `presetFromRecord`).
//
// THE SEVEN REAL ROLES, PLUS THE TOOL-LESS CARD
// ---------------------------------------------
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
//   chat      — NOT a role: the same trusted `general` profile with NO toolbox and ONE model
//               call (issue 0005-D). It is last in the catalogue because it is not a team and
//               never joins one; see the note above the card.
//
// HOW A TEAM IS DERIVED, AND THE ONE EXCEPTION. `teamOf()` builds every live preset's
// allowlist from ONE list, so the presets cannot drift. Two ids are excluded: the primary
// (a harness has exactly one primary and the registry rejects a subagent that names it) and
// `planner`/Manager, because a Manager refuses to run as a delegate (src/agents/planner.ts
// states the refusal) — offering a member that answers "I do not run as a subagent" is a
// wasted run. A USER-created team may still select the Manager; the refusal is what makes
// that honest. `summarizer` stays everywhere so the `textSummarize` delegated path keeps
// working (it condenses locally when absent). `chat` is not in that derivation at all: it
// declares no team, so `teamOf` is never called for it and it is never a member of one.
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
// what a metadata-only patch must preserve. Every shipped entry is 'live' —
// rebuilt from the selected agents/models — and the two non-live template kinds
// ('scripted', 'flaky') survive ONLY as durable-record vocabulary: an
// installation that saved a row or froze a session while the fixtures shipped
// still names one, and ./registry.ts has to answer it honestly rather than crash.
// An injected preset may still declare either.
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

import type { HarnessPreset } from './types';
import { PRESET_MAX_ITERATIONS, SHARED_TOOL_NAMES, createProfiledHarness } from './toolbox';

// Re-exported for callers that imported the app-wide tool-loop budget from here
// (the CLI and server tests did); the value now lives with the shared factory.
export { PRESET_MAX_ITERATIONS };

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

// Chat: THE TOOL-LESS CARD (issue 0005-D). Every other card here answers "what can an agent do with
// the toolbox"; this one answers "just reply". It is the minimum a chat product needs from the built-in
// `/sessions` API, and it is a CATALOGUE ENTRY, not a new mechanism: the same trusted-profile
// composition every live card uses (`createProfiledHarness`, ./toolbox.ts) plus the one declared
// toolbox exception that factory now accepts.
//
// WHAT THIS BUYS A CLIENT, exactly:
//   - `tools: []` with NO `environmentTools`, and `sharedToolbox: false` in the factory: the card
//     advertises no catalogue tool AND the harness registers none, so a "answer me" session can never
//     spend a tool round reading or writing the SERVER HOST's filesystem. That is the gap this card
//     exists to close — before it, a client had no way to select an empty toolbox, because every
//     shipped card declared `SHARED_TOOL_NAMES`.
//   - `subagents: []`: `delegate` is not even registered (src/harness.ts `activation: 'subagents'`),
//     so there is no delegation and no child conversation.
//   - `maxIterations` is NOT set here: the tool-loop budget is an optional safeguard and no
//     shipped card carries one, so this card answers when the model answers, however many
//     rounds that takes. A tool round it does take can only ever hit a harness-owned core row
//     — `sharedToolbox: false` registered nothing else.
//
// WHY `general` IS THE PRIMARY. "The preset name is also the entry agent's name" is a convention, not
// a rule (the deleted `demo`/`flaky` fixtures ran `general` the same way), and `general` is the one
// TRUSTED profile whose own guidelines already state this card's contract — it works alone, and it is
// told not to spawn a branch with `threadFork` or hand a step over with `threadSend`
// (../../agents/general.ts). Selecting that profile keeps the product rule intact: a client chooses an
// agent, it never supplies the text a model is seeded with (../../agents/types.ts). A new `chat` agent
// id would instead be a new prompt in the trusted catalogue, which is a different change (and an agent
// id is persisted in every record with no alias fallback).
//
// WHAT STAYS, and why the card is not literally "zero tools": the kernel always owns its harness-owned
// rows, and two of them declare core visibility (`toolRequest`, the discovery bootstrap, and `tasks`,
// the session plan). They are the harness's own surface, not a toolbox, and there is nothing registered
// for `toolRequest` to surface here.
//
// WHAT AN EXECUTABLE PATCH DOES. The registry rebuilds a 'live' template through
// `createProfiledHarness(primary, subagents, …)` (./registry.ts), which passes no toolbox argument, so
// PATCHing this card's TEAM gives the shared toolbox back. That is deliberate: the tool-less posture is
// a property of the shipped TEMPLATE, not a durable field — `HarnessPresetRecord` carries no tool
// column, and widening the durable schema is out of scope for this issue. A metadata-only patch
// (title/description) keeps this factory exactly like every other template.
const chat: HarnessPreset = {
    name: 'chat',
    title: 'Chat',
    description:
        'A single answer with no toolbox: the General profile on an empty catalogue (no file, search, delegation, or record tool is registered), so it cannot read or write the server host — the only tools it can ever call are the harness-owned core rows. It carries no iteration budget, so it keeps going until the model answers.',
    requiresEndpoint: true,
    // The trusted profile it runs — see the note above for why this is `general` and not a new id.
    primary: 'general',
    // Empty on purpose, exactly like the default card: no team, therefore no `delegate` row.
    subagents: [],
    agents: ['general'],
    // THE load-bearing line. The descriptor projects this list (plus any environment row the host can
    // run), and `sharedToolbox: false` below is what makes the empty promise true in the runtime rather
    // than only on the card.
    tools: [],
    // No `environmentTools`: `fetch` registers WITHOUT a credential, so a card that declared the flag
    // would advertise a core declaration this harness no longer makes.
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('general', [], {}, {}, {}, {}, { sharedToolbox: false })
};

// ---------------------------------------------------------------------------
// Catalogue exports (T5)
// ---------------------------------------------------------------------------
// THE CATALOGUE, in UI/CLI order (general is the default/first card, which is
// also what `DEFAULT_CLI_PRESET` in ../cli/options.ts selects). Every entry is a real,
// usable configuration: a live agent team on the shared toolbox that runs against the
// configured provider — EXCEPT `chat`, the one card that deliberately opts out of the
// toolbox (see its note). This array IS the product — there is no fixture tier behind it
// any more, so `presets` is both the shipped catalogue and the complete set of
// templates this build can rebuild a factory from.
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
    debuggerPreset,
    chat
];

// There is no `FIXTURE_PRESETS` and no `ALL_PRESET_TEMPLATES` any more. Both existed to
// keep the scripted `demo` and the `flaky` example reachable behind the production
// catalogue; with those presets deleted there is no second tier to name. `presets` is the
// whole set, and a host or a test that wants its own fixture passes it straight to
// `createHarnessRegistry([...presets, myFixture])` — the registry already accepts any
// `HarnessPreset[]`, so nothing was ever needed from this module to make that work.

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
