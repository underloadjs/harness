// Harness preset architecture: one shared toolbox, agents as the only difference.
//
// These tests pin the product rule that replaced the old writer/assistant/researcher
// tool subsets, plus the current roster (T3 + the role-contract pass):
//   - seven REAL roles (general, instruct, research, workspace, reviewer, planner,
//     debugger) are the WHOLE shipped catalogue, in that order, with the visible titles
//     General/Instruct/Explore/Analyst/Reviewer/Manager/Debugger; `research`,
//     `workspace` and `planner` keep their persisted ids while only their TITLES moved,
//     because an id is written into every saved record and has no alias fallback
//     (../../agents/index.ts). The scripted demo and the flaky example are presets too,
//     but T5 un-shipped them — they stay available through FIXTURE_PRESETS/
//     ALL_PRESET_TEMPLATES so a host or a test injects them explicitly;
//   - `general` is the DEFAULT card (it is `presets[0]` and `DEFAULT_CLI_PRESET`) and the
//     ONLY live preset with no team: `subagents: []`, which means `delegate` is never
//     even REGISTERED for it (src/harness.ts `activation: 'subagents'`), so it is absent
//     from the registry, from the declarations, and from the descriptor's coreTools;
//   - every real preset registers the exact same tool keys, configured and keyless —
//     package coding tools, the app tools, search when a key resolves, then the
//     harness core tools; the only difference is `delegate`, which the default card lacks;
//   - `teamOf()` derives every built-in allowlist from ONE list, minus the primary and
//     minus `planner`/Manager — a Manager refuses to run as a delegate
//     (../../agents/planner.ts), so a shipped team never offers a member that would
//     refuse it — then adds `summarizer` so the `textSummarize` delegated path keeps working;
//   - the delegation wording lives in ONE shared guideline line (../../agents/guidelines.ts)
//     that the six team roles compose verbatim, and the default profile carries no
//     delegation line at all because it has no subagents;
//   - every profile-built agent is seeded with exactly ONE system message: the
//     identity sentence and the guidelines joined into a single prompt by
//     `agentInstruction()` (../../agents/index.ts), because two seeded `system`
//     messages lose the guidelines on gateways that accept only one system turn;
//   - `testFlaky` is not part of the shared set (it is an example-only extra);
//   - the scripted demo is a documented fixture exception;
//   - the legacy preset ids still resolve as aliases (`writer`/`assistant` → `instruct`,
//     `researcher` → `research`), and the new TITLES are deliberately not names;
//   - `LEGACY_PRESET_DEFINITIONS` stays at its three pre-T3 snapshots on purpose (the
//     roster pass did not extend it — see the note in ./presets.ts);
//   - `textSummarize` delegates to `summarizer` in every TEAM preset and condenses
//     locally where that agent is absent (the default card and the fixtures).
//
// No network: constructing a preset never calls the provider (the transport is
// only used when a turn runs), and the search factory resolves its key at
// construction and touches the network only on `execute`. Search keys are stubbed
// per test, so the suite is isolated from the machine and from `.env`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProgress } from '../../harness';
import {
    ALL_PRESET_TEMPLATES,
    createHarnessRegistry,
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    describeHarness,
    findPreset,
    FIXTURE_PRESETS,
    LEGACY_PRESET_DEFINITIONS,
    presets,
    PRESET_ALIASES,
    PRESET_MAX_ITERATIONS,
    SHARED_TOOL_NAMES,
    SPECIALIST_AGENT_NAMES,
    teamOf
} from './index';
import { AGENT_PROFILES, agentInstruction } from '../../agents';
import { DEFAULT_CLI_PRESET } from '../cli/options';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// Provider settings are never used by construction; they only feed `agent(...)`.
const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'test-model'
};

// Constructing a preset routes no events, so this sink stays empty.
const progress: HarnessProgress = async () => undefined;

const presetOf = (name: string) => {
    const preset = findPreset(name);
    if (!preset) throw new Error(`Missing preset "${name}".`);
    return preset;
};

const registeredTools = (name: string): string[] => Object.keys(presetOf(name).create(SETTINGS, progress).tools);

// THE system prompt an agent actually runs: `agentInstruction()` joins the identity
// sentence and the guidelines into ONE string (../../agents/index.ts), and
// `agent({ instruction })` seeds exactly one `system` message per string, so
// `messages[0]` is the whole prompt — not its first half.
const instructionOf = (presetName: string, agentName: string): string => {
    const harness = presetOf(presetName).create(SETTINGS, progress);
    const message = harness.agents[agentName].messages[0];

    if (message.role !== 'system' || typeof message.content !== 'string') {
        throw new Error(`Agent "${agentName}" has no system instruction.`);
    }

    return message.content;
};

// The exact shared registry order: nine package tools, then five app tools.
const TOOLBOX = [
    'syntax',
    'read',
    'write',
    'edit',
    'files',
    'glob',
    'grep',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize'
];

// The harness-owned core set, in descriptor order, without delegate. This is the
// REGISTERED list: R9-R11 changed visibility (what a request declares), not which
// rows the kernel registers, so every row below still exists in `harness.tools`.
// toolRegistry leads because the kernel registers it before every other core tool.
const CORE = [
    'toolRegistry',
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'records',

    'tasks',
    'profiles',
    'chapters',
    'locations',
    'agentManage',
    'agentResult'
];

// The seven real primaries, in catalogue order, DEFAULT FIRST.
const REAL = ['general', 'instruct', 'research', 'workspace', 'reviewer', 'planner', 'debugger'] as const;

// The six that get a built-in team. `general` is deliberately NOT here: its card passes
// `subagents: []`, so `delegate` is not registered for it at all — every assertion about
// `delegate` and about the delegated `summarizer` applies to this list only.
const TEAMED = ['instruct', 'research', 'workspace', 'reviewer', 'planner', 'debugger'] as const;

// One live card, spelled out from the metadata the descriptor publishes. `team` is the
// literal allowlist (pinned independently against `teamOf` in the team test), so this
// helper cannot paper over a card that drifted from the derivation.
const card = (name: string, team: readonly string[]) => ({
    name,
    primary: name,
    subagents: [...team],
    agents: [name, ...team],
    tools: TOOLBOX,
    environmentTools: ['search', 'fetch']
});

// The ONE delegation line the six team roles compose verbatim (../../agents/guidelines.ts
// `DELEGATION_GUIDELINE`). The gate itself — primary-only, one level deep, registered only
// with subagents — is carried by the tool declaration, so this line only carries the three
// policies no schema can say. It is pinned as a literal so a rewording in the source is a
// visible diff here instead of a silent pass.
const DELEGATION_LINE =
    'When you delegate, give ONE target a self-contained brief because a subagent never sees this conversation, verify its answer before relying on it, and follow up with the same target instead of guessing: a later delegation continues that subagent\'s conversation.';

// The default card's replacement for that line (../../agents/general.ts): alone by
// contract, with BOTH loopholes a lone agent could still use to hand a step away closed
// in the same breath — `threadFork` (spawns a branch) and `threadSend` (posts the step
// into another conversation the host happens to have open).
const LONE_LINE =
    'You work alone: no subagent exists here, so a step you cannot do is a step to unlock with toolRequest, never a step to pass on. Do not spawn a branch with threadFork, and do not hand the step to another conversation with threadSend.';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('preset catalogue', () => {
    it('ships the seven real roles and keeps the two examples as explicit fixtures (T5)', () => {
        // The shipped catalogue is exactly the real roles: every card is a live
        // harness a user can actually run. The scripted demo and the failure example
        // are presets, but they are no longer product configurations.
        expect(presets.map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger'
        ]);

        // ORDER IS A CONTRACT: this is the order `GET /harnesses` returns, the order a
        // picker renders, and the order the frontend palette assigns tones by. It must
        // match `AGENT_PROFILE_NAMES` (../../agents/index.ts) minus summarizer/fixtures.
        expect(presets.map((preset) => preset.title)).toEqual([
            'General',
            'Instruct',
            'Explore',
            'Analyst',
            'Reviewer',
            'Manager',
            'Debugger'
        ]);

        // The UI selects the first descriptor at boot and the CLI uses it with no
        // `--preset`, so the first card must be the default real harness — the two
        // values are one product decision pinned from both sides.
        expect(presets[0].name).toBe('general');
        expect(presets[0].requiresEndpoint).toBe(true);
        expect(DEFAULT_CLI_PRESET).toBe('general');

        // The review the removal came with: nothing in the shipped catalogue is
        // offline, scripted, or registers a tool that fails on purpose.
        expect(presets.every((preset) => preset.requiresEndpoint)).toBe(true);
        expect(presets.every((preset) => preset.template === 'live')).toBe(true);
        expect(presets.flatMap((preset) => preset.tools)).not.toContain('testFlaky');

        // The fixtures stay available for explicit injection and for restoring an
        // older session, in the same order they used to ship in.
        expect(FIXTURE_PRESETS.map((preset) => [preset.name, preset.title])).toEqual([
            ['demo', 'Scripted demo'],
            ['flaky', 'Recoverable failures (example)']
        ]);
        expect(ALL_PRESET_TEMPLATES.map((preset) => preset.name)).toEqual([
            ...presets.map((preset) => preset.name),
            'demo',
            'flaky'
        ]);
    });

    it('keeps the live tool-loop budget at 1000 and the library default untouched', () => {
        expect(PRESET_MAX_ITERATIONS).toBe(1000);
    });

    it('derives one team per primary: every other real role except the Manager, then the summarizer', () => {
        // The ONE list every team is derived from, in catalogue order (default first).
        expect([...SPECIALIST_AGENT_NAMES]).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger'
        ]);

        // Exact expansion per primary: SPECIALIST order minus the primary minus
        // `planner`/Manager, then `summarizer` last. `planner` is excluded from every
        // built-in team because it refuses to run as a delegate (../../agents/planner.ts
        // and the note above each card in ./presets.ts); `general` IS a legal target for
        // the other primaries even though its OWN card has no team.
        expect(REAL.map((primary) => [primary, teamOf(primary)])).toEqual([
            ['general', ['instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['instruct', ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['research', ['general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['workspace', ['general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer']],
            ['reviewer', ['general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer']],
            ['planner', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['debugger', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer']]
        ]);

        // The exclusion, stated twice so a one-sided edit cannot pass: no built-in team
        // offers the Manager, and a primary is never inside its own team.
        expect(REAL.map((primary) => teamOf(primary).includes('planner'))).toEqual(
            REAL.map(() => false)
        );
        expect(REAL.map((primary) => teamOf(primary).includes(primary))).toEqual(
            REAL.map(() => false)
        );

        // `summarizer` is in every derived team — the `textSummarize` delegated path
        // looks that id up at call time.
        expect(REAL.map((primary) => teamOf(primary).at(-1))).toEqual(
            REAL.map(() => 'summarizer')
        );
    });

    it('declares explicit primary/subagents and the shared tool list on real presets', () => {
        // Cards are spelled out from literals, not from `teamOf`, so a card that stops
        // agreeing with the derivation fails HERE as well as in the team test.
        expect(
            presets.map((preset) => ({
                name: preset.name,
                primary: preset.primary,
                subagents: preset.subagents,
                agents: preset.agents,
                tools: preset.tools,
                environmentTools: preset.environmentTools
            }))
        ).toEqual([
            // THE DEFAULT CARD: the only live preset with an empty allowlist. That is a
            // load-bearing choice, not an omission — `delegate` registers only when the
            // allowlist is non-empty, so this harness never declares the tool.
            card('general', []),
            card('instruct', ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']),
            card('research', ['general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer']),
            card('workspace', ['general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer']),
            card('reviewer', ['general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer']),
            card('planner', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']),
            card('debugger', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer'])
        ]);

        // The fixtures are unchanged by the roster pass, and still declared honestly:
        // demo is offline with timeNow only, flaky adds its example tool.
        expect(
            FIXTURE_PRESETS.map((preset) => ({
                name: preset.name,
                primary: preset.primary,
                subagents: preset.subagents,
                agents: preset.agents,
                environmentTools: preset.environmentTools,
                template: preset.template
            }))
        ).toEqual([
            {
                name: 'demo',
                primary: 'demo',
                subagents: [],
                agents: ['demo'],
                environmentTools: undefined,
                template: 'scripted'
            },
            {
                name: 'flaky',
                primary: 'flaky',
                subagents: [],
                agents: ['flaky'],
                // The factory opts into search AND webfetch through
                // createToolboxHarness, so the metadata says so too
                // (descriptor/runtime agreement).
                environmentTools: ['search', 'fetch'],
                template: 'flaky'
            }
        ]);

        // The one exception spelled out: demo declares exactly `timeNow`, and flaky is
        // the shared toolbox plus `testFlaky` (the factory opts into search, so the
        // metadata says so too — descriptor/runtime agreement).
        expect(FIXTURE_PRESETS.map((preset) => [...preset.tools])).toEqual([
            ['timeNow'],
            [...SHARED_TOOL_NAMES, 'testFlaky']
        ]);

        // The exported table is the same list, not a second hand-maintained copy.
        expect(SHARED_TOOL_NAMES).toEqual(TOOLBOX);
    });

    it('resolves the legacy preset identifiers as aliases of the new ones', () => {
        expect(PRESET_ALIASES).toEqual({
            writer: 'instruct',
            assistant: 'instruct',
            researcher: 'research'
        });

        expect(findPreset('writer')).toBe(findPreset('instruct'));
        expect(findPreset('assistant')).toBe(findPreset('instruct'));
        expect(findPreset('researcher')).toBe(findPreset('research'));
        expect(findPreset('nope')).toBeUndefined();

        // TITLES are not NAMES (T3, and again for Explore/Analyst/Manager): the ids stay
        // `workspace`/`research`/`planner` so saved sessions and the agents.json overlay
        // keep resolving, and no new reserved name collides with a user harness. The
        // roster renames are therefore only visible in the `title` field.
        expect(findPreset('workspace')?.title).toBe('Analyst');
        expect(findPreset('research')?.title).toBe('Explore');
        expect(findPreset('planner')?.title).toBe('Manager');
        expect(findPreset('coder')).toBeUndefined();
        expect(findPreset('explore')).toBeUndefined();
        expect(findPreset('analyst')).toBeUndefined();
        expect(findPreset('manager')).toBeUndefined();

        // `general` and `debugger` are real ids, not aliases — the alias table above is
        // still exactly the three legacy names.
        expect(findPreset('general')?.title).toBe('General');
        expect(findPreset('debugger')?.title).toBe('Debugger');
    });

    it('keeps LEGACY_PRESET_DEFINITIONS at its three pre-T3 snapshots (deliberately not extended)', () => {
        // ./presets.ts records WHY this table was not touched by the roster pass: it holds
        // ONE snapshot per id, so an install holding the pre-T3 row refreshes to the new
        // template, while an install holding the T3 row is replayed as a customisation.
        // Pinning the exact shape here is what makes "not extended" an assertion rather
        // than an accident.
        expect(Object.keys(LEGACY_PRESET_DEFINITIONS)).toEqual(['instruct', 'research', 'workspace']);

        expect(
            Object.entries(LEGACY_PRESET_DEFINITIONS).map(([name, definition]) => ({
                name,
                title: definition.title,
                requiresEndpoint: definition.requiresEndpoint,
                primary: definition.primary,
                subagents: definition.subagents,
                agents: definition.agents,
                environmentTools: definition.environmentTools,
                template: definition.template
            }))
        ).toEqual([
            {
                name: 'instruct',
                title: 'Instruct',
                requiresEndpoint: true,
                primary: 'instruct',
                subagents: [],
                agents: ['instruct'],
                environmentTools: ['search'],
                template: 'live'
            },
            {
                name: 'research',
                title: 'Research',
                requiresEndpoint: true,
                primary: 'research',
                subagents: ['summarizer'],
                agents: ['research', 'summarizer'],
                environmentTools: ['search'],
                template: 'live'
            },
            {
                name: 'workspace',
                title: 'Workspace (coding)',
                requiresEndpoint: true,
                primary: 'workspace',
                subagents: [],
                agents: ['workspace'],
                environmentTools: ['search'],
                template: 'live'
            }
        ]);

        // The legacy rows keep the OLD titles, which is the whole point: the refresh
        // compares a saved record against these, and a record whose executable fields
        // match is a shipped default rather than an operator decision. Only two of the
        // three rows had a title to move (`instruct` was never renamed), so the contrast
        // with the current cards is pinned where a rename actually happened.
        expect(LEGACY_PRESET_DEFINITIONS.instruct.title).toBe(findPreset('instruct')?.title);
        expect(LEGACY_PRESET_DEFINITIONS.research.title).toBe('Research');
        expect(LEGACY_PRESET_DEFINITIONS.workspace.title).toBe('Workspace (coding)');
        expect(findPreset('research')?.title).toBe('Explore');
        expect(findPreset('workspace')?.title).toBe('Analyst');
        // The legacy rows also predate the environment `fetch` declaration, so a saved
        // record that still says `['search']` is recognisably a pre-T3 default.
        expect(
            Object.values(LEGACY_PRESET_DEFINITIONS).map((definition) => definition.environmentTools)
        ).toEqual([['search'], ['search'], ['search']]);
    });
});

describe('one toolbox, different agents', () => {
    it('registers the identical shared toolbox on every team preset when search is configured', () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        // Identical by construction: preset.tools is the same table, every TEAMED preset
        // declares subagents (so delegate exists), and the only other difference is the
        // example's testFlaky. W4: the toolbox factory also opts into webfetch, so fetch
        // is registered right after the configured search and stays SEARCHABLE (it is not
        // in CORE).
        for (const name of TEAMED) {
            expect(registeredTools(name)).toEqual([
                ...CORE,
                'delegate',
                'threadFork',
                'toolCancel',
                ...TOOLBOX,
                'search',
                'fetch'
            ]);
        }

        // The example gets the same shared set plus its own failure tool.
        expect(registeredTools('flaky')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            ...TOOLBOX,
            'testFlaky',
            'search',
            'fetch'
        ]);

        // The scripted offline fixture is a documented exception.
        expect(registeredTools('demo')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);
    });

    it('omits delegate from the default card while every other row stays identical', () => {
        // THE load-bearing difference, pinned in both key states: `subagents: []` means
        // the kernel never registers `delegate` (src/harness.ts `activation: 'subagents'`),
        // so the row is absent from the registry rather than merely undeclared —
        // `toolRequest` cannot surface it either, because discovery only lists rows.
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        expect(registeredTools('general')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            ...TOOLBOX,
            'search',
            'fetch'
        ]);

        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        expect(registeredTools('general')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            ...TOOLBOX,
            'fetch'
        ]);

        // One agent, no subagent map, and therefore no summarizer to delegate to either.
        const harness = presetOf('general').create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['general']);
        expect(Object.keys(harness.subagents)).toEqual([]);
        expect(harness.tools.delegate).toBeUndefined();
        expect(harness.agents.summarizer).toBeUndefined();

        // The descriptor agrees with the runtime: a picker must not advertise a
        // delegation capability this card does not have.
        const configured = createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({
                configuration: { env: { EXA_API_KEY: 'configured-exa-key' } }
            })
        });
        expect(describeHarness(presetOf('general'), configured).coreTools).toEqual([
            'toolRequest',
            'tasks',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'search',
            'fetch'
        ]);
    });

    it('registers the identical toolbox on every team preset when the host is keyless', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        // W4: fetch needs no credential, so unlike search it is still here on
        // a keyless host; it lands after the shared table and before the core set.
        for (const name of TEAMED) {
            expect(registeredTools(name)).toEqual([
                ...CORE,
                'delegate',
                'threadFork',
                'toolCancel',
                ...TOOLBOX,
                'fetch'
            ]);
        }

        // No key means the factory registers no search at all; the global
        // catalogue is where a keyless host learns it exists but is unconfigured.
        // fetch is the documented exception: native fetch is keyless.
        expect(registeredTools('instruct')).not.toContain('search');
    });

    it('excludes testFlaky from the shared toolbox and the real presets', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(SHARED_TOOL_NAMES).not.toContain('testFlaky');
        for (const name of REAL) expect(registeredTools(name)).not.toContain('testFlaky');
        expect(registeredTools('flaky')).toContain('testFlaky');
    });

    it('marks the five everyday file tools core and leaves files discoverable', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        const harness = presetOf('instruct').create(SETTINGS, progress);

        // R18: read/write/edit/glob/grep are declared up front. files and the app /
        // command tools still go through toolRequest. The harness-owned tools are
        // core as well, but they are the session-bound set.
        expect(
            Object.fromEntries(
                [...TOOLBOX].map((name) => [name, harness.tools[name].visibility])
            )
        ).toEqual({
            syntax: 'searchable',
            read: 'core',
            write: 'core',
            edit: 'core',
            files: 'searchable',
            glob: 'core',
            grep: 'core',
            shell: 'searchable',
            gitDiff: 'searchable',
            // R9-R11: download is registered but searchable, so it is discovered
            // through toolRequest instead of declared on every request.
            download: 'searchable',
            timeNow: 'searchable',
            textCount: 'searchable',
            diceRoll: 'searchable',
            noteSearch: 'searchable',
            textSummarize: 'searchable'
        });

        // Names and metadata are registered without eager implementation loading
        // (the package entries are lazy proxies, see src/tools/lazy.ts).
        expect(harness.tools.read.tags).toEqual(['files', 'read', 'filesystem']);

        // W4: the toolbox factory also opts into webfetch, but fetching stays
        // discovery-gated (SEARCHABLE), so it is never a core declaration and
        // never appears in a descriptor's coreTools.
        // R9-R11: fetch is environment core, so a live card can advertise the
        // declaration its harness really makes (src/server/harnesses/webfetch.ts).
        expect(harness.tools.fetch.visibility).toBe('core');
        expect(harness.tools.fetch.tags).toEqual(['web', 'fetch', 'internet', 'read', 'url', 'research']);
        expect(harness.tools.toolRequest.visibility).toBe('core');
        expect(harness.tools.toolCreate.visibility).toBe('searchable');
        expect(harness.tools.tasks.visibility).toBe('core');
        expect(harness.tools.delegate.visibility).toBe('core');
        expect(presetOf('demo').create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('marks a configured search core, like the file core set', () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        const harness = presetOf('instruct').create(SETTINGS, progress);

        expect(harness.tools.search.visibility).toBe('core');
        // Still only registered when a key resolved.
        vi.stubEnv('EXA_API_KEY', '');
        expect(presetOf('instruct').create(SETTINGS, progress).tools.search).toBeUndefined();
    });

    it('descriptor coreTools agrees with the runtime core declarations', () => {
        const coreNamesAtRuntime = (name: string): string[] =>
            Object.values(presetOf(name).create(SETTINGS, progress).tools)
                .filter((tool) => tool.visibility === 'core')
                .map((tool) => tool.name);

        const names = presets.map((preset) => preset.name);

        // Keyless: no search anywhere, and the demo fixture claims no file
        // tools because it registers timeNow only.
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        const keyless = createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
        });
        for (const name of names) {
            expect(describeHarness(presetOf(name), keyless).coreTools).toEqual(coreNamesAtRuntime(name));
        }

        // Configured: search is core exactly on the presets that registered it
        // (the seven real roles and flaky; not the scripted demo).
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        const configured = createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({
                configuration: { env: { EXA_API_KEY: 'configured-exa-key' } }
            })
        });
        for (const name of names) {
            expect(describeHarness(presetOf(name), configured).coreTools).toEqual(coreNamesAtRuntime(name));
        }

        // Pin the configured real order too, so a descriptor cannot drift silently.
        // R9-R11: only the bootstrap pair, delegate (this card has a team), the five
        // core file presets, and the configured search are declared up front.
        expect(describeHarness(presetOf('instruct'), configured).coreTools).toEqual([
            'toolRequest',
            'tasks',
            'delegate',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'search',
            // R9-R11: the web pair is advertised together; fetch is registered on
            // every live card because the native provider needs no credential.
            'fetch'
        ]);
        // R9-R11: fetch IS a core declaration on a live card, and the descriptor
        // says so because the catalogue carries the executable entry. A host that
        // opts out (webfetch disabled) gets the opposite, and catalogue.test.ts pins
        // that pairing.
        expect(describeHarness(presetOf('instruct'), configured).coreTools).toContain('fetch');
    });

    it('gives each real preset distinct instructions and the right subagents', () => {
        const instructions = REAL.map((name) => instructionOf(name, name));

        // Each real preset runs the WHOLE prompt its profile composes, verbatim: the
        // expected value is `agentInstruction(profile)`, so a guideline added to a
        // profile is covered here without touching this test again.
        expect(instructions).toEqual(REAL.map((name) => agentInstruction(AGENT_PROFILES[name])));

        // No two real roles share a prompt, so a picker choice is a real choice.
        expect(new Set(instructions).size).toBe(REAL.length);

        // The identity sentence, quoted exactly, is the text ABOVE the joined
        // `Guidelines:` block. Splitting on the literal separator pins both the
        // sentence and the `\n\nGuidelines:\n` structure the runtime must produce.
        // Titles moved for three ids (Explore/Analyst/Manager) while the ids behind
        // them did not, so the sentence is the only place the rename is visible.
        expect(instructions.map((prompt) => prompt.split('\n\nGuidelines:\n')[0])).toEqual([
            'You are the General agent, the default. Do every step of the task yourself, in this conversation, and never hand work to another agent.',
            'You are the Instruct agent. Do the work yourself, and delegate only a step that would cost more context than it is worth to perform.',
            'You are the Explore agent. Establish what is actually there and how it works, and report only what you can point to.',
            'You are the Analyst agent. Implement the work in the codebase at the standard its surrounding code already sets, and prove it works.',
            'You are the Reviewer agent, a strict judge. Test the work against what it claims, and report only what you can point to.',
            'You are the Manager agent. Hold the whole goal, plan it, and steer specialists through every step; you delegate the work and never do it yourself.',
            'You are the Debugger agent. Exercise the whole system until something breaks, then prove how it breaks.'
        ]);

        // The delegated summarizer is a profile too: same composition, one string.
        expect(instructionOf('research', 'summarizer')).toBe(
            'You compress technical notes into at most two sentences.\n\nGuidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        );

        // Every preset has exactly its team; the primary is never a subagent. The
        // default card's entry is the contract, not an omission: empty team, one agent.
        expect(
            REAL.map((name) => {
                const harness = presetOf(name).create(SETTINGS, progress);
                return [name, Object.keys(harness.subagents), Object.keys(harness.agents)];
            })
        ).toEqual([
            ['general', [], ['general']],
            ['instruct', ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'], ['instruct', 'general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['research', ['general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer'], ['research', 'general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['workspace', ['general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer'], ['workspace', 'general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer']],
            ['reviewer', ['general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer'], ['reviewer', 'general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer']],
            ['planner', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'], ['planner', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']],
            ['debugger', ['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer'], ['debugger', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer']]
        ]);
    });

    it('composes one shared delegation line for the team roles, and none on the default card', () => {
        // The six roles that may delegate all compose the SAME line (no per-role
        // paraphrase that can drift), and that line reads correctly for a primary (it has
        // the tool) and for a subagent (it never does — `primaryOnlyDefinitions` in
        // src/harness.ts). The GATE itself — primary-only, one level deep, registered only
        // with subagents — is declared by the tool, not repeated here.
        for (const name of TEAMED) {
            const block = AGENT_PROFILES[name].guidelines.join('\n');

            expect(block).toContain(DELEGATION_LINE);
        }

        // The default card carries no delegation wording at all, because its harness has
        // no subagents and therefore no `delegate` row to describe. Instead it states the
        // rule the runtime enforces, plus the fork loophole the runtime leaves open.
        const loneBlock = AGENT_PROFILES.general.guidelines.join('\n');

        expect(loneBlock).toContain(LONE_LINE);
        expect(loneBlock).not.toContain('delegate');
        expect(loneBlock).not.toContain(DELEGATION_LINE);

        // The roles that DO delegate must not promise the lone card's contract, either.
        expect(AGENT_PROFILES.instruct.guidelines.join('\n')).not.toContain(LONE_LINE);
    });

    it('makes the Manager refuse to work alone or as a delegate, and name only reachable ids', () => {
        // Both refusal rules are prompt-level, because `AgentConfiguration` has no tool
        // list to deny with (../../agents/planner.ts). Rule 1 covers a harness with no
        // team; rule 2 covers the Manager running as someone's subagent — the same
        // observable signal (no declared `delegate`) decides both.
        const plannerPlan = AGENT_PROFILES.planner.guidelines.join('\n');

        expect(plannerPlan).toContain(
            'If `delegate` is not declared to you, stop and say why: with no one to delegate to a Manager cannot manage, and it must not quietly become a worker.'
        );
        expect(plannerPlan).toContain(
            'If this brief reached you because another agent delegated to you, reply that a Manager does not run as a delegate, and stop without starting the task.'
        );
        expect(plannerPlan).toContain('never do a step yourself');

        // ROUTING NAMES NO UNREACHABLE ID. The delegate `agent` enum IS the session
        // allowlist (src/harness.ts), so every id the prompt offers has to be a member of
        // the Manager's own built-in team — and `planner` itself never is, which is what
        // the exclusion in `teamOf` guarantees.
        const routingIds = ['research', 'workspace', 'reviewer', 'debugger', 'general', 'summarizer'];

        expect(plannerPlan).toContain(
            'Delegate every step to the narrowest id that fits: research to investigate, workspace to implement, reviewer to challenge, debugger to stress-test, general for a whole self-contained job, summarizer to condense.'
        );
        expect(routingIds.map((id) => teamOf('planner').includes(id))).toEqual(
            routingIds.map(() => true)
        );
        expect(teamOf('planner').includes('planner')).toBe(false);

        // The stale promise from the five-role roster stays gone: the Manager must not
        // tell its caller to route to an id its team cannot reach.
        expect(plannerPlan).not.toContain('instruct for general work');
    });

    it('exposes each team preset team as the valid delegation ids', () => {
        // The runtime declaration's `agent` enum IS the allowlist, so a Manager can only
        // name agents that exist in its team. The default card is not in this loop
        // because it has no `delegate` tool to inspect — asserted right below.
        const enums = TEAMED.map((name) => {
            const parameters = presetOf(name).create(SETTINGS, progress).tools.delegate
                .parameters as { properties: { agent: { enum?: readonly string[] } } };
            return [name, parameters.properties.agent.enum];
        });

        expect(enums).toEqual(TEAMED.map((name) => [name, teamOf(name)]));

        // Widest allowlist in the product: the Manager is the only primary whose team
        // holds all six other roles, because it is excluded from every OTHER team.
        expect(enums[4][1]).toEqual(['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']);
        // A peer team never offers the Manager back.
        expect(enums[5][1]).toEqual(['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer']);

        expect(presetOf('general').create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('seeds the trusted profile instruction and guidelines into the runtime', () => {
        const research = presetOf('research').create(SETTINGS, progress);

        // ONE system message per agent, holding the identity sentence AND the
        // composed guidelines block. `agentInstruction()` joins them because a
        // profile used to seed two `system` messages, and several OpenAI-compatible
        // gateways accept only one system turn — the guidelines were dropped there
        // and the role ran on its identity sentence alone (../../agents/index.ts).
        // The same composition runs for the summarizer, so a guideline cannot be
        // documentation that never reaches a model.
        expect(withoutIds(research.agents.research.messages.slice(0, 1))).toEqual([
            { role: 'system', content: agentInstruction(AGENT_PROFILES.research) }
        ]);
        expect(withoutIds(research.agents.summarizer.messages.slice(0, 1))).toEqual([
            { role: 'system', content: agentInstruction(AGENT_PROFILES.summarizer) }
        ]);

        // Nothing else in either transcript is a system turn: the join is what makes
        // the prompt complete, so a second seeded system message is a regression.
        expect(research.agents.research.messages.filter((message) => message.role === 'system')).toHaveLength(1);
        expect(research.agents.summarizer.messages.filter((message) => message.role === 'system')).toHaveLength(1);

        // The joined text byte for byte: identity sentence, a BLANK line, then
        // `Guidelines:` with one `- ` bullet per profile guideline, in profile order.
        expect(withoutIds(research.agents.research.messages[0])).toEqual({
            role: 'system',
            content: [
                'You are the Explore agent. Establish what is actually there and how it works, and report only what you can point to.',
                '',
                'Guidelines:',
                ...AGENT_PROFILES.research.guidelines.map((line) => `- ${line}`)
            ].join('\n')
        });

        // The exact identity sentence, not just a substring: the profile is the
        // source and the harness must not append or rewrite it.
        expect(research.agents.research.messages[0].content.split('\n\nGuidelines:\n')[0]).toBe(
            'You are the Explore agent. Establish what is actually there and how it works, and report only what you can point to.'
        );
    });

    it('marks every template editable (compatibility field only)', () => {
        expect(
            ALL_PRESET_TEMPLATES.map((preset) => ({
                name: preset.name,
                builtin: preset.builtin,
                editable: preset.editable,
                template: preset.template
            }))
        ).toEqual([
            { name: 'general', builtin: true, editable: true, template: 'live' },
            { name: 'instruct', builtin: true, editable: true, template: 'live' },
            { name: 'research', builtin: true, editable: true, template: 'live' },
            { name: 'workspace', builtin: true, editable: true, template: 'live' },
            { name: 'reviewer', builtin: true, editable: true, template: 'live' },
            { name: 'planner', builtin: true, editable: true, template: 'live' },
            { name: 'debugger', builtin: true, editable: true, template: 'live' },
            // R20.1: there is no read-only template. `editable: true` is a wire
            // compatibility field; `template` is the registry's internal signal
            // for what a metadata-only vs executable patch must do.
            { name: 'demo', builtin: true, editable: true, template: 'scripted' },
            { name: 'flaky', builtin: true, editable: true, template: 'flaky' }
        ]);
    });
});

describe('summarize under one shared toolbox', () => {
    it('condenses locally when the harness has no summarizer agent', async () => {
        // A user-created single-agent harness: the shared toolbox is there, but with
        // no `summarizer` member (every shipped TEAMED preset includes one; the default
        // card does not, because it has no team at all).
        const harness = createHarnessRegistry()
            .create({ name: 'solo', primary: 'instruct' })
            .create(SETTINGS, progress);

        // Direct tool call: the same path a model call takes after discovery.
        expect(await harness.tools.textSummarize('First sentence. Second sentence. Third sentence.')).toBe(
            'First sentence. Second sentence.'
        );
        expect(await harness.tools.textSummarize('  one   line\n\nsecond line  ')).toBe('one line second line');
        expect(await harness.tools.textSummarize('   ')).toBe('');
    });

    it('has a summarizer to delegate to in every team preset and none on the default card', () => {
        // The agent registry is the prerequisite the tool checks; the delegated
        // path itself would call the provider, so this suite stops at the wiring.
        for (const name of TEAMED) {
            expect(presetOf(name).create(SETTINGS, progress).agents.summarizer).toBeDefined();
        }

        // `subagents: []` on the default card also removes the summarizer, so its
        // `textSummarize` call takes the local-condensation branch — the same branch the
        // two fixtures take. Absence asserted exactly, not "may be undefined".
        for (const name of ['general', 'demo', 'flaky']) {
            expect(presetOf(name).create(SETTINGS, progress).agents.summarizer).toBeUndefined();
        }
    });
});
