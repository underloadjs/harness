// Harness preset architecture: one shared toolbox, agents as the only difference.
//
// These tests pin the product rule that replaced the old writer/assistant/
// researcher tool subsets:
//   - every LIVE preset (instruct, research, workspace) registers the exact same
//     tool keys, configured and keyless — package coding tools, the app tools,
//     websearch when a key resolves, then the harness core tools;
//   - `delegate` is the one conditional core tool, and it exists only for a preset
//     that declares subagents (Research), which is an agent-configuration
//     difference;
//   - the instructions really are distinct and the routing is explicit;
//   - `flaky` is not part of the shared set (it is an example-only extra);
//   - the scripted demo is a documented fixture exception;
//   - the legacy preset ids still resolve as aliases;
//   - `summarize` works in every live preset: it delegates only when a summarizer
//     agent exists and condenses locally otherwise.
//
// No network: constructing a preset never calls the provider (the transport is
// only used when a turn runs), and the search factory resolves its key at
// construction and touches the network only on `execute`. Search keys are stubbed
// per test, so the suite is isolated from the machine and from `.env`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProgress } from '../src/harness';
import { findPreset, presets, PRESET_ALIASES, PRESET_MAX_ITERATIONS, SHARED_TOOL_NAMES } from './index';
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

// The exact shared registry order: nine package tools, then five app tools.
const TOOLBOX = [
    'syntaxCheck',
    'readFile',
    'writeFile',
    'editFile',
    'listFiles',
    'searchFiles',
    'globFiles',
    'runCommand',
    'gitDiff',
    'clock',
    'wordCount',
    'roll',
    'searchNotes',
    'summarize'
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
                environmentTools: ['websearch']
            },
            {
                name: 'research',
                primary: 'research',
                subagents: ['summarizer'],
                agents: ['research', 'summarizer'],
                tools: TOOLBOX,
                environmentTools: ['websearch']
            },
            {
                name: 'workspace',
                primary: 'workspace',
                subagents: [],
                agents: ['workspace'],
                tools: TOOLBOX,
                environmentTools: ['websearch']
            },
            {
                name: 'demo',
                primary: 'demo',
                subagents: [],
                agents: ['demo'],
                tools: ['clock'],
                environmentTools: undefined
            },
            {
                name: 'flaky',
                primary: 'flaky',
                subagents: [],
                agents: ['flaky'],
                tools: [...TOOLBOX, 'flaky'],
                environmentTools: undefined
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
            'websearch',
            'requestTools',
            'createTool',
            'todoTools'
        ]);
        expect(registeredTools('research')).toEqual([
            ...TOOLBOX,
            'websearch',
            'requestTools',
            'createTool',
            'todoTools',
            'delegate'
        ]);
        expect(registeredTools('workspace')).toEqual([
            ...TOOLBOX,
            'websearch',
            'requestTools',
            'createTool',
            'todoTools'
        ]);

        // The example gets the same shared set plus its own failure tool.
        expect(registeredTools('flaky')).toEqual([
            ...TOOLBOX,
            'flaky',
            'websearch',
            'requestTools',
            'createTool',
            'todoTools'
        ]);

        // The scripted offline fixture is a documented exception.
        expect(registeredTools('demo')).toEqual(['clock', 'requestTools', 'createTool', 'todoTools']);
    });

    it('registers the identical toolbox on every live preset when the host is keyless', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(registeredTools('instruct')).toEqual([...TOOLBOX, 'requestTools', 'createTool', 'todoTools']);
        expect(registeredTools('research')).toEqual([
            ...TOOLBOX,
            'requestTools',
            'createTool',
            'todoTools',
            'delegate'
        ]);
        expect(registeredTools('workspace')).toEqual([...TOOLBOX, 'requestTools', 'createTool', 'todoTools']);

        // No key means the factory registers no websearch at all; the global
        // catalogue is where a keyless host learns it exists but is unconfigured.
        expect(registeredTools('instruct')).not.toContain('websearch');
    });

    it('excludes flaky from the shared toolbox and the three live harnesses', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        expect(SHARED_TOOL_NAMES).not.toContain('flaky');
        expect(registeredTools('instruct')).not.toContain('flaky');
        expect(registeredTools('research')).not.toContain('flaky');
        expect(registeredTools('workspace')).not.toContain('flaky');
        expect(registeredTools('flaky')).toContain('flaky');
    });

    it('keeps every shared tool searchable, file tools included', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        const harness = presetOf('instruct').create(SETTINGS, progress);

        // The latest scope: discovery is the only way to reach a catalogue tool,
        // so no preset entry is declared up front. Only the harness-owned core
        // tools bypass requestTools.
        expect(
            Object.fromEntries(
                [
                    'readFile',
                    'writeFile',
                    'editFile',
                    'listFiles',
                    'searchFiles',
                    'globFiles',
                    'syntaxCheck',
                    'runCommand',
                    'gitDiff',
                    'clock',
                    'wordCount',
                    'roll',
                    'searchNotes',
                    'summarize'
                ].map((name) => [name, harness.tools[name].visibility])
            )
        ).toEqual({
            readFile: 'searchable',
            writeFile: 'searchable',
            editFile: 'searchable',
            listFiles: 'searchable',
            searchFiles: 'searchable',
            globFiles: 'searchable',
            syntaxCheck: 'searchable',
            runCommand: 'searchable',
            gitDiff: 'searchable',
            clock: 'searchable',
            wordCount: 'searchable',
            roll: 'searchable',
            searchNotes: 'searchable',
            summarize: 'searchable'
        });

        // Names and metadata are registered without eager implementation loading
        // (the package entries are lazy proxies, see src/tools/lazy.ts).
        expect(harness.tools.readFile.tags).toEqual(['files', 'read', 'filesystem']);
        expect(harness.tools.requestTools.visibility).toBe('core');
        expect(harness.tools.createTool.visibility).toBe('core');
        expect(harness.tools.todoTools.visibility).toBe('core');
        expect(harness.tools.delegate).toBeUndefined();
        expect(presetOf('research').create(SETTINGS, progress).tools.delegate.visibility).toBe('core');
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
        // The delegate guideline is what makes the subagent reachable in words.
        expect((research.agents.research.messages[1] as { content: string }).content).toContain(
            'You may call delegate with agent "summarizer" for a self-contained brief'
        );
    });

    it('marks the catalogue builtin/editable for future registry mutations', () => {
        expect(
            presets.map((preset) => ({
                name: preset.name,
                builtin: preset.builtin,
                editable: preset.editable
            }))
        ).toEqual([
            { name: 'instruct', builtin: true, editable: true },
            { name: 'research', builtin: true, editable: true },
            { name: 'workspace', builtin: true, editable: true },
            // Fixtures are not overridable: an override would make the scripted
            // demo / failure example claim behaviour it does not run.
            { name: 'demo', builtin: true, editable: false },
            { name: 'flaky', builtin: true, editable: false }
        ]);
    });
});

describe('summarize under one shared toolbox', () => {
    it('condenses locally when the harness has no summarizer agent', async () => {
        const harness = presetOf('instruct').create(SETTINGS, progress);

        // Direct tool call: the same path a model call takes after discovery.
        expect(await harness.tools.summarize('First sentence. Second sentence. Third sentence.')).toBe(
            'First sentence. Second sentence.'
        );
        expect(await harness.tools.summarize('  one   line\n\nsecond line  ')).toBe('one line second line');
        expect(await harness.tools.summarize('   ')).toBe('');
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
