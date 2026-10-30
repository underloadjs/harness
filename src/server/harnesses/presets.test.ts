// Harness preset architecture: one shared toolbox, agents as the only difference.
//
// These tests pin the product rule that replaced the old writer/assistant/
// researcher tool subsets, plus the T3 roster:
//   - five REAL roles (instruct, research, workspace, reviewer, planner) are the
//     first five cards, with the visible titles Instruct/Researcher/Coder/
//     Reviewer/Planner; demo and flaky stay after them as examples;
//   - every real preset registers the exact same tool keys, configured and keyless —
//     package coding tools, the app tools, webSearch when a key resolves, then the
//     harness core tools;
//   - every real preset declares EVERY other real role plus `summarizer` as a direct
//     subagent, so `agentDelegate` exists on all five and the Planner's researcher/
//     coder/reviewer targets exist by id;
//   - the profiles' delegation wording is conditional and one level deep: a subagent
//     is never asked to delegate again;
//   - `testFlaky` is not part of the shared set (it is an example-only extra);
//   - the scripted demo is a documented fixture exception;
//   - the legacy preset ids still resolve as aliases (`coder` → `workspace`);
//   - `textSummarize` delegates to `summarizer` in every real preset and condenses
//     locally where that agent is absent (the fixtures).
//
// No network: constructing a preset never calls the provider (the transport is
// only used when a turn runs), and the search factory resolves its key at
// construction and touches the network only on `execute`. Search keys are stubbed
// per test, so the suite is isolated from the machine and from `.env`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProgress } from '../../harness';
import {
    createHarnessRegistry,
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    describeHarness,
    findPreset,
    presets,
    PRESET_ALIASES,
    PRESET_MAX_ITERATIONS,
    SHARED_TOOL_NAMES,
    SPECIALIST_AGENT_NAMES,
    teamOf
} from './index';
import { AGENT_PROFILES } from '../../agents';

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

const instructionOf = (presetName: string, agentName: string): string => {
    const harness = presetOf(presetName).create(SETTINGS, progress);
    const message = harness.agents[agentName].messages[0];

    if (message.role !== 'system' || typeof message.content !== 'string') {
        throw new Error(`Agent "${agentName}" has no system instruction.`);
    }

    return message.content;
};

// The exact shared registry order: eight package tools, then five app tools.
const TOOLBOX = [
    'syntaxCheck',
    'fileRead',
    'fileWrite',
    'fileEdit',
    'fileList',
    'fileGlob',
    'commandRun',
    'gitDiff',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize'
];

// The harness-owned core set, in descriptor order, without agentDelegate.
// toolRegistry leads because the kernel registers it before every other core tool.
const CORE = [
    'toolRegistry',
    'toolRequest',
    'toolCreate',
    'todoManage',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentManage',
    'agentResult'
];

// The five real primaries, in catalogue order.
const REAL = ['instruct', 'research', 'workspace', 'reviewer', 'planner'] as const;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('preset catalogue', () => {
    it('lists the five real roles first, then the two examples', () => {
        expect(presets.map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'demo',
            'flaky'
        ]);
        expect(presets.map((preset) => preset.title)).toEqual([
            'Instruct',
            'Researcher',
            'Coder',
            'Reviewer',
            'Planner',
            'Scripted demo',
            'Recoverable failures (example)'
        ]);

        // The UI selects the first descriptor at boot, so the first card must be a
        // real harness rather than the scripted demo.
        expect(presets[0].name).toBe('instruct');
        expect(presets[0].requiresEndpoint).toBe(true);
    });

    it('keeps the live tool-loop budget at 1000 and the library default untouched', () => {
        expect(PRESET_MAX_ITERATIONS).toBe(1000);
    });

    it('derives one symmetric team per primary: the other real roles, then the summarizer', () => {
        expect([...SPECIALIST_AGENT_NAMES]).toEqual([...REAL]);

        expect(REAL.map((primary) => [primary, teamOf(primary)])).toEqual([
            ['instruct', ['research', 'workspace', 'reviewer', 'planner', 'summarizer']],
            ['research', ['instruct', 'workspace', 'reviewer', 'planner', 'summarizer']],
            ['workspace', ['instruct', 'research', 'reviewer', 'planner', 'summarizer']],
            ['reviewer', ['instruct', 'research', 'workspace', 'planner', 'summarizer']],
            ['planner', ['instruct', 'research', 'workspace', 'reviewer', 'summarizer']]
        ]);
    });

    it('declares explicit primary/subagents and the shared tool list on real presets', () => {
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
            {
                name: 'instruct',
                primary: 'instruct',
                subagents: teamOf('instruct'),
                agents: ['instruct', ...teamOf('instruct')],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'research',
                primary: 'research',
                subagents: teamOf('research'),
                agents: ['research', ...teamOf('research')],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'workspace',
                primary: 'workspace',
                subagents: teamOf('workspace'),
                agents: ['workspace', ...teamOf('workspace')],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'reviewer',
                primary: 'reviewer',
                subagents: teamOf('reviewer'),
                agents: ['reviewer', ...teamOf('reviewer')],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'planner',
                primary: 'planner',
                subagents: teamOf('planner'),
                agents: ['planner', ...teamOf('planner')],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'demo',
                primary: 'demo',
                subagents: [],
                agents: ['demo'],
                tools: ['timeNow'],
                environmentTools: undefined
            },
            {
                name: 'flaky',
                primary: 'flaky',
                subagents: [],
                agents: ['flaky'],
                tools: [...TOOLBOX, 'testFlaky'],
                // The factory opts into search via createToolboxHarness, so the
                // metadata says so too (descriptor/runtime agreement).
                environmentTools: ['webSearch']
            }
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

        // The visible title "Coder" keeps the `workspace` id (T3): no new reserved
        // name is introduced, so a user-created harness named "coder" stays legal.
        expect(findPreset('workspace')?.title).toBe('Coder');
        expect(findPreset('coder')).toBeUndefined();
    });
});

describe('one toolbox, different agents', () => {
    it('registers the identical shared toolbox on every real preset when search is configured', () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        // Identical by construction: preset.tools is the same table, every real
        // preset declares subagents (so agentDelegate exists on all five), and the
        // only other difference is the example's testFlaky. W4: the toolbox factory
        // also opts into webfetch, so webFetch is registered right after the
        // configured webSearch and stays SEARCHABLE (it is not in CORE).
        for (const name of REAL) {
            expect(registeredTools(name)).toEqual([
                ...CORE,
                'agentDelegate',
                'threadFork',
                'toolCancel',
                ...TOOLBOX,
                'webSearch',
                'webFetch'
            ]);
        }

        // The example gets the same shared set plus its own failure tool.
        expect(registeredTools('flaky')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            ...TOOLBOX,
            'testFlaky',
            'webSearch',
            'webFetch'
        ]);

        // The scripted offline fixture is a documented exception.
        expect(registeredTools('demo')).toEqual([
            ...CORE,
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);
    });

    it('registers the identical toolbox on every real preset when the host is keyless', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        // W4: webFetch needs no credential, so unlike webSearch it is still here on
        // a keyless host; it lands after the shared table and before the core set.
        for (const name of REAL) {
            expect(registeredTools(name)).toEqual([
                ...CORE,
                'agentDelegate',
                'threadFork',
                'toolCancel',
                ...TOOLBOX,
                'webFetch'
            ]);
        }

        // No key means the factory registers no webSearch at all; the global
        // catalogue is where a keyless host learns it exists but is unconfigured.
        // webFetch is the documented exception: native fetch is keyless.
        expect(registeredTools('instruct')).not.toContain('webSearch');
    });

    it('excludes testFlaky from the shared toolbox and the real presets', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(SHARED_TOOL_NAMES).not.toContain('testFlaky');
        for (const name of REAL) expect(registeredTools(name)).not.toContain('testFlaky');
        expect(registeredTools('flaky')).toContain('testFlaky');
    });

    it('marks the four everyday file tools core and leaves fileList discoverable', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        const harness = presetOf('instruct').create(SETTINGS, progress);

        // R18: read/write/edit/glob are declared up front. fileList and the app /
        // command tools still go through toolRequest. The harness-owned tools are
        // core as well, but they are the session-bound set.
        expect(
            Object.fromEntries(
                [...TOOLBOX].map((name) => [name, harness.tools[name].visibility])
            )
        ).toEqual({
            syntaxCheck: 'searchable',
            fileRead: 'core',
            fileWrite: 'core',
            fileEdit: 'core',
            fileList: 'searchable',
            fileGlob: 'core',
            commandRun: 'searchable',
            gitDiff: 'searchable',
            timeNow: 'searchable',
            textCount: 'searchable',
            diceRoll: 'searchable',
            noteSearch: 'searchable',
            textSummarize: 'searchable'
        });

        // Names and metadata are registered without eager implementation loading
        // (the package entries are lazy proxies, see src/tools/lazy.ts).
        expect(harness.tools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);

        // W4: the toolbox factory also opts into webfetch, but fetching stays
        // discovery-gated (SEARCHABLE), so it is never a core declaration and
        // never appears in a descriptor's coreTools.
        expect(harness.tools.webFetch.visibility).toBe('searchable');
        expect(harness.tools.webFetch.tags).toEqual(['web', 'fetch', 'internet', 'read', 'url', 'research']);
        expect(harness.tools.toolRequest.visibility).toBe('core');
        expect(harness.tools.toolCreate.visibility).toBe('core');
        expect(harness.tools.todoManage.visibility).toBe('core');
        expect(harness.tools.agentDelegate.visibility).toBe('core');
        expect(presetOf('demo').create(SETTINGS, progress).tools.agentDelegate).toBeUndefined();
    });

    it('marks a configured webSearch core, like the file core set', () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        const harness = presetOf('instruct').create(SETTINGS, progress);

        expect(harness.tools.webSearch.visibility).toBe('core');
        // Still only registered when a key resolved.
        vi.stubEnv('EXA_API_KEY', '');
        expect(presetOf('instruct').create(SETTINGS, progress).tools.webSearch).toBeUndefined();
    });

    it('descriptor coreTools agrees with the runtime core declarations', () => {
        const coreNamesAtRuntime = (name: string): string[] =>
            Object.values(presetOf(name).create(SETTINGS, progress).tools)
                .filter((tool) => tool.visibility === 'core')
                .map((tool) => tool.name);

        const names = presets.map((preset) => preset.name);

        // Keyless: no webSearch anywhere, and the demo fixture claims no file
        // tools because it registers timeNow only.
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        const keyless = createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
        });
        for (const name of names) {
            expect(describeHarness(presetOf(name), keyless).coreTools).toEqual(coreNamesAtRuntime(name));
        }

        // Configured: webSearch is core exactly on the presets that registered it
        // (the five real roles and flaky; not the scripted demo).
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
        expect(describeHarness(presetOf('instruct'), configured).coreTools).toEqual([
            ...CORE,
            'agentDelegate',
            'threadFork',
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileGlob',
            'webSearch'
        ]);
        // W4: webFetch is registered by the live factory but is SEARCHABLE, so a
        // descriptor must never advertise it as a core declaration.
        expect(describeHarness(presetOf('instruct'), configured).coreTools).not.toContain('webFetch');
    });

    it('gives each real preset distinct instructions and the right subagents', () => {
        const instructions = REAL.map((name) => instructionOf(name, name));

        expect(new Set(instructions).size).toBe(REAL.length);
        expect(instructions[0]).toContain('You are the Instruct agent.');
        expect(instructions[1]).toContain('You are the Research agent.');
        expect(instructions[2]).toContain('You are a workspace coding agent.');
        expect(instructions[3]).toContain('You are the Reviewer agent.');
        expect(instructions[4]).toContain('You are the Planner agent.');
        expect(instructionOf('research', 'summarizer')).toContain('You compress technical notes');

        // Every real preset has exactly its team; the primary is never a subagent.
        expect(
            REAL.map((name) => {
                const harness = presetOf(name).create(SETTINGS, progress);
                return [name, Object.keys(harness.subagents), Object.keys(harness.agents)];
            })
        ).toEqual(
            REAL.map((name) => [name, [...teamOf(name)], [name, ...teamOf(name)]])
        );
    });

    it('asks each real profile to delegate conditionally, one level deep', () => {
        // Every real profile must describe `agentDelegate` as declared only to a
        // PRIMARY when the harness configures targets AND state that a subagent
        // cannot delegate further. That combination is what makes the same text
        // correct for a primary and for a lone/subagent profile, which must do the
        // work itself rather than wait for a tool it never receives.
        for (const name of REAL) {
            const block = AGENT_PROFILES[name].guidelines.join('\n');

            expect(block).toContain('agentDelegate');
            expect(block).toContain('If you are the primary agent and this harness configures subagents');
            expect(block).toContain('declared to you');
            expect(block).toContain('cannot delegate further');
        }

        // The Planner additionally names the specialist ids it routes to, so the
        // researcher/coder/reviewer targets are discoverable in words.
        const plannerPlan = AGENT_PROFILES.planner.guidelines.join('\n');
        for (const target of ['research', 'workspace', 'reviewer', 'instruct']) {
            expect(plannerPlan).toContain(target);
        }
    });

    it('exposes each real preset team as the valid delegation ids', () => {
        // The runtime declaration's `agent` enum IS the allowlist, so a Planner can
        // only name agents that exist in its team; this is the id-level proof that
        // researcher/coder/reviewer are callable there.
        const enums = REAL.map((name) => {
            const parameters = presetOf(name).create(SETTINGS, progress).tools.agentDelegate
                .parameters as { properties: { agent: { enum?: readonly string[] } } };
            return [name, parameters.properties.agent.enum];
        });

        expect(enums).toEqual(REAL.map((name) => [name, teamOf(name)]));
        expect(enums[4][1]).toEqual(['instruct', 'research', 'workspace', 'reviewer', 'summarizer']);
    });

    it('seeds the trusted profile instruction and guidelines into the runtime', () => {
        const research = presetOf('research').create(SETTINGS, progress);

        // Agent messages start with the profile's instruction, then ONE composed
        // guidelines block. The same composition is used for the summarizer, so a
        // guideline cannot be documentation that never reaches a model.
        expect(research.agents.research.messages.slice(0, 2)).toEqual([
            { role: 'system', content: AGENT_PROFILES.research.instruction },
            {
                role: 'system',
                content: [
                    'Guidelines:',
                    ...AGENT_PROFILES.research.guidelines.map((line) => `- ${line}`)
                ].join('\n')
            }
        ]);
        expect(research.agents.summarizer.messages.slice(0, 2)).toEqual([
            { role: 'system', content: AGENT_PROFILES.summarizer.instruction },
            {
                role: 'system',
                content: [
                    'Guidelines:',
                    ...AGENT_PROFILES.summarizer.guidelines.map((line) => `- ${line}`)
                ].join('\n')
            }
        ]);

        // The exact identity sentence, not just a substring: the profile is the
        // source and the harness must not append or rewrite it.
        expect(research.agents.research.messages[0]).toEqual({
            role: 'system',
            content: 'You are the Research agent. Investigate before you answer, and separate what you found from what you inferred.'
        });
    });

    it('marks every template editable (compatibility field only)', () => {
        expect(
            presets.map((preset) => ({
                name: preset.name,
                builtin: preset.builtin,
                editable: preset.editable,
                template: preset.template
            }))
        ).toEqual([
            { name: 'instruct', builtin: true, editable: true, template: 'live' },
            { name: 'research', builtin: true, editable: true, template: 'live' },
            { name: 'workspace', builtin: true, editable: true, template: 'live' },
            { name: 'reviewer', builtin: true, editable: true, template: 'live' },
            { name: 'planner', builtin: true, editable: true, template: 'live' },
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
        // no `summarizer` member (the shipped real presets always include one).
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

    it('has a summarizer to delegate to in every real preset', () => {
        // The agent registry is the prerequisite the tool checks; the delegated
        // path itself would call the provider, so this suite stops at the wiring.
        for (const name of REAL) {
            expect(presetOf(name).create(SETTINGS, progress).agents.summarizer).toBeDefined();
        }

        expect(presetOf('demo').create(SETTINGS, progress).agents.summarizer).toBeUndefined();
        expect(presetOf('flaky').create(SETTINGS, progress).agents.summarizer).toBeUndefined();
    });
});
