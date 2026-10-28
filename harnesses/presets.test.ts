// Harness preset architecture: one shared toolbox, agents as the only difference.
//
// These tests pin the product rule that replaced the old writer/assistant/
// researcher tool subsets:
//   - every LIVE preset (instruct, research, workspace) registers the exact same
//     tool keys, configured and keyless — package coding tools, the app tools,
//     webSearch when a key resolves, then the harness core tools;
//   - `agentDelegate` is the one conditional core tool, and it exists only for a preset
//     that declares subagents (Research), which is an agent-configuration
//     difference;
//   - the instructions really are distinct and the routing is explicit;
//   - `testFlaky` is not part of the shared set (it is an example-only extra);
//   - the scripted demo is a documented fixture exception;
//   - the legacy preset ids still resolve as aliases;
//   - `textSummarize` works in every live preset: it delegates only when a summarizer
//     agent exists and condenses locally otherwise.
//
// No network: constructing a preset never calls the provider (the transport is
// only used when a turn runs), and the search factory resolves its key at
// construction and touches the network only on `execute`. Search keys are stubbed
// per test, so the suite is isolated from the machine and from `.env`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProgress } from '../src/harness';
import {
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    describeHarness,
    findPreset,
    presets,
    PRESET_ALIASES,
    PRESET_MAX_ITERATIONS,
    SHARED_TOOL_NAMES
} from './index';
import { AGENT_PROFILES } from '../src/agents';

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

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('preset catalogue', () => {
    it('lists the agent-named live choices first, then the fixtures', () => {
        expect(presets.map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'demo',
            'flaky'
        ]);

        // The UI selects the first descriptor at boot, so the first card must be a
        // real harness rather than the scripted demo.
        expect(presets[0].name).toBe('instruct');
        expect(presets[0].requiresEndpoint).toBe(true);
    });

    it('keeps the live tool-loop budget at 1000 and the library default untouched', () => {
        expect(PRESET_MAX_ITERATIONS).toBe(1000);
    });

    it('declares explicit primary/subagents and the shared tool list on live presets', () => {
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
                subagents: [],
                agents: ['instruct'],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'research',
                primary: 'research',
                subagents: ['summarizer'],
                agents: ['research', 'summarizer'],
                tools: TOOLBOX,
                environmentTools: ['webSearch']
            },
            {
                name: 'workspace',
                primary: 'workspace',
                subagents: [],
                agents: ['workspace'],
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
    });
});

describe('one toolbox, different agents', () => {
    it('registers the identical shared toolbox on every live preset when search is configured', () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        // Identical by construction: preset.tools is the same table and the only
        // core difference is delegate (Research declares a subagent).
        expect(registeredTools('instruct')).toEqual([
            ...TOOLBOX,
            'webSearch',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);
        expect(registeredTools('research')).toEqual([
            ...TOOLBOX,
            'webSearch',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]);
        expect(registeredTools('workspace')).toEqual([
            ...TOOLBOX,
            'webSearch',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);

        // The example gets the same shared set plus its own failure tool.
        expect(registeredTools('flaky')).toEqual([
            ...TOOLBOX,
            'testFlaky',
            'webSearch',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);

        // The scripted offline fixture is a documented exception.
        expect(registeredTools('demo')).toEqual(['timeNow', 'toolRequest', 'toolCreate', 'todoManage']);
    });

    it('registers the identical toolbox on every live preset when the host is keyless', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(registeredTools('instruct')).toEqual([...TOOLBOX, 'toolRequest', 'toolCreate', 'todoManage']);
        expect(registeredTools('research')).toEqual([
            ...TOOLBOX,
            'toolRequest',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]);
        expect(registeredTools('workspace')).toEqual([...TOOLBOX, 'toolRequest', 'toolCreate', 'todoManage']);

        // No key means the factory registers no webSearch at all; the global
        // catalogue is where a keyless host learns it exists but is unconfigured.
        expect(registeredTools('instruct')).not.toContain('webSearch');
    });

    it('excludes testFlaky from the shared toolbox and the three live harnesses', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(SHARED_TOOL_NAMES).not.toContain('testFlaky');
        expect(registeredTools('instruct')).not.toContain('testFlaky');
        expect(registeredTools('research')).not.toContain('testFlaky');
        expect(registeredTools('workspace')).not.toContain('testFlaky');
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
                [
                    'fileRead',
                    'fileWrite',
                    'fileEdit',
                    'fileList',
                    'fileGlob',
                    'syntaxCheck',
                    'commandRun',
                    'gitDiff',
                    'timeNow',
                    'textCount',
                    'diceRoll',
                    'noteSearch',
                    'textSummarize'
                ].map((name) => [name, harness.tools[name].visibility])
            )
        ).toEqual({
            fileRead: 'core',
            fileWrite: 'core',
            fileEdit: 'core',
            fileList: 'searchable',
            fileGlob: 'core',
            syntaxCheck: 'searchable',
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
        expect(harness.tools.toolRequest.visibility).toBe('core');
        expect(harness.tools.toolCreate.visibility).toBe('core');
        expect(harness.tools.todoManage.visibility).toBe('core');
        expect(harness.tools.agentDelegate).toBeUndefined();
        expect(presetOf('research').create(SETTINGS, progress).tools.agentDelegate.visibility).toBe('core');
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

        const names = ['instruct', 'research', 'workspace', 'demo', 'flaky'];

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
        // (the live trio and flaky; not the scripted demo).
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

        // Pin the configured live order too, so a descriptor cannot drift silently.
        expect(describeHarness(presetOf('instruct'), configured).coreTools).toEqual([
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileGlob',
            'webSearch',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);
    });

    it('gives each live preset distinct instructions and the right subagents', () => {
        const instruct = instructionOf('instruct', 'instruct');
        const research = instructionOf('research', 'research');
        const workspace = instructionOf('workspace', 'workspace');
        const summarizer = instructionOf('research', 'summarizer');

        expect(new Set([instruct, research, workspace, summarizer]).size).toBe(4);
        expect(instruct).toContain('You are the Instruct agent.');
        expect(research).toContain('You are the Research agent.');
        expect(workspace).toContain('You are a workspace coding agent.');
        expect(summarizer).toContain('You compress technical notes');

        // Research is the only preset with a delegate target; its allowlist is
        // exactly the summarizer and never the primary itself.
        const researchHarness = presetOf('research').create(SETTINGS, progress);
        expect(Object.keys(researchHarness.subagents)).toEqual(['summarizer']);
        expect(Object.keys(presetOf('instruct').create(SETTINGS, progress).subagents)).toEqual([]);
        expect(Object.keys(presetOf('workspace').create(SETTINGS, progress).subagents)).toEqual([]);
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
        // The agentDelegate guideline is what makes the subagent reachable in words.
        expect((research.agents.research.messages[1] as { content: string }).content).toContain(
            'You may call agentDelegate with agent "summarizer" for a self-contained brief'
        );
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
        const harness = presetOf('instruct').create(SETTINGS, progress);

        // Direct tool call: the same path a model call takes after discovery.
        expect(await harness.tools.textSummarize('First sentence. Second sentence. Third sentence.')).toBe(
            'First sentence. Second sentence.'
        );
        expect(await harness.tools.textSummarize('  one   line\n\nsecond line  ')).toBe('one line second line');
        expect(await harness.tools.textSummarize('   ')).toBe('');
    });

    it('has a summarizer to delegate to only in Research', () => {
        const research = presetOf('research').create(SETTINGS, progress);

        // The agent registry is the prerequisite the tool checks; the delegated
        // path itself would call the provider, so this suite stops at the wiring.
        expect(research.agents.summarizer).toBeDefined();
        expect(presetOf('instruct').create(SETTINGS, progress).agents.summarizer).toBeUndefined();
        expect(presetOf('workspace').create(SETTINGS, progress).agents.summarizer).toBeUndefined();
    });
});
