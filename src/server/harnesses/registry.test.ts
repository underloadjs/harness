// The in-memory harness registry.
//
// These tests pin the contract the HTTP layer depends on: exactly one primary,
// trusted agent ids only, reserved/duplicate names, every template editable
// (R20.1), and — most importantly — that update() REPLACES a preset rather than
// mutating it, which is what keeps an already-created session frozen to the
// configuration it was built with.
//
// R20.1 specifics:
//   - the registry starts from independent copies of the shipped templates;
//   - a metadata-only patch keeps the captured factory (demo's script, flaky's
//     testFlaky extra);
//   - an executable patch rebuilds demo as an honest live profiled harness and
//     flaky as the live toolbox with testFlaky retained.
//
// No provider and no network: constructing a preset never calls the transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../harness';
import type { HarnessProgress } from '../../harness';
import type { HarnessPreset } from './types';
import type { HarnessRegistry } from './registry';
import {
    createHarnessRegistry,
    isLegacyShippedDefinition,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord,
    restoreHarnessRegistry
} from './registry';
import { describeHarness } from './descriptor';
import {
    ALL_PRESET_TEMPLATES,
    FIXTURE_PRESETS,
    LEGACY_PRESET_DEFINITIONS,
    presets
} from './presets';
import { SHARED_TOOL_NAMES } from './toolbox';
// `agentInstruction` is imported rather than re-typed here: a no-override member must
// equal exactly what the trusted catalogue composes, and duplicating the prose (or the
// join rule) in this file is how a pin silently drifts from the shipped prompt.
import { AGENT_PROFILE_NAMES, AGENT_PROFILES, agentInstruction } from '../../agents';

// The exact tool-order assertions below assume a KEYLESS host: search is
// registered only when EXA_API_KEY/TAVILY_API_KEY resolves (harness.ts:728-738),
// while fetch is keyless and registers whenever the factory opts in
// (harness.ts:753-761). Pin the env so a developer shell holding real keys cannot
// insert search ahead of fetch and turn a correct order into a failure.
beforeEach(() => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'test-model'
};

// Constructing a preset routes no events, so this sink stays empty.
const progress: HarnessProgress = async () => undefined;

const registryError = (run: () => unknown): { status: number; message: string } => {
    try {
        run();
    } catch (error) {
        const failure = error as { status?: number; message: string };
        return { status: failure.status ?? 0, message: failure.message };
    }

    throw new Error('expected the registry to throw');
};

// T5: the scripted demo and the flaky example are no longer part of the shipped
// catalogue, so every test below that pins THEIR template rules (a metadata-only
// patch keeps the script; an executable patch upgrades it) has to ask for them by
// name. That is exactly what a host or a test does now: an explicit fixture
// injection, not a default that ships them.
const fixtureRegistry = (): HarnessRegistry => createHarnessRegistry(ALL_PRESET_TEMPLATES);

describe('the shipped registry', () => {
    it('lists every template as an independent, editable copy', () => {
        const registry = createHarnessRegistry();

        expect(
            registry.list().map((preset) => ({
                name: preset.name,
                builtin: preset.builtin,
                editable: preset.editable
            }))
        ).toEqual([
            { name: 'instruct', builtin: true, editable: true },
            { name: 'research', builtin: true, editable: true },
            { name: 'workspace', builtin: true, editable: true },
            { name: 'reviewer', builtin: true, editable: true },
            { name: 'planner', builtin: true, editable: true }
        ]);

        // R20.1: independent copies. No registry entry aliases a shipped template
        // object or its mutable arrays, so editing one registry cannot leak into
        // another (or into the module constants).
        const instruct = registry.find('instruct')!;
        expect(instruct).not.toBe(presets[0]);
        expect(instruct.tools).not.toBe(presets[0].tools);
        expect(instruct.subagents).not.toBe(presets[0].subagents);

        const other = createHarnessRegistry();
        registry.update('instruct', { title: 'Edited' });
        expect(other.find('instruct')?.title).toBe('Instruct');
        expect(presets[0].title).toBe('Instruct');
    });

    it('ships only real production configurations and keeps the fixtures explicit (T5)', () => {
        // The default catalogue is exactly the five live roles: nothing scripted,
        // nothing that fails on purpose. A user picking a card gets a harness that
        // talks to the configured provider with the shared toolbox.
        expect(createHarnessRegistry().list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(presets.map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);

        // The fixtures still exist as presets — they are just not shipped. Their
        // behaviour is unchanged (demo stays offline/scripted, flaky keeps its
        // failing tool), and a host that wants them asks for them by name.
        expect(FIXTURE_PRESETS.map((preset) => preset.name)).toEqual(['demo', 'flaky']);
        expect(FIXTURE_PRESETS.map((preset) => [preset.name, preset.template, preset.requiresEndpoint])).toEqual([
            ['demo', 'scripted', false],
            ['flaky', 'flaky', true]
        ]);

        const injected = createHarnessRegistry(ALL_PRESET_TEMPLATES);

        expect(injected.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'demo',
            'flaky'
        ]);

        // `ALL_PRESET_TEMPLATES` is the lookup superset restore depends on: a
        // session frozen on the scripted demo rebuilds even though demo left the
        // catalogue (see ./restore.test.ts and ./registry.ts presetFromRecord).
        expect(ALL_PRESET_TEMPLATES.map((preset) => preset.name)).toEqual([
            ...presets.map((preset) => preset.name),
            ...FIXTURE_PRESETS.map((preset) => preset.name)
        ]);
    });

    it('exposes the trusted agent profiles', () => {
        const registry = createHarnessRegistry();

        expect(registry.agents().map((profile) => profile.name)).toEqual([...AGENT_PROFILE_NAMES]);
    });

    it('resolves legacy aliases for lookup but not for update', () => {
        const registry = createHarnessRegistry();

        expect(registry.find('writer')?.name).toBe('instruct');
        expect(registry.find('assistant')?.name).toBe('instruct');
        expect(registry.find('researcher')?.name).toBe('research');
        expect(registry.find('nope')).toBeUndefined();

        expect(registryError(() => registry.update('writer', { title: 'Writer' }))).toEqual({
            status: 404,
            message: 'Unknown harness "writer".'
        });
    });
});

describe('creating a harness', () => {
    it('registers one primary and its allowlist with the shared toolbox', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'my-review',
            title: 'My review',
            description: 'A review pairing.',
            primary: 'research',
            subagents: ['summarizer']
        });

        expect({
            name: preset.name,
            title: preset.title,
            description: preset.description,
            requiresEndpoint: preset.requiresEndpoint,
            primary: preset.primary,
            subagents: preset.subagents,
            agents: preset.agents,
            tools: preset.tools,
            environmentTools: preset.environmentTools,
            builtin: preset.builtin,
            editable: preset.editable
        }).toEqual({
            name: 'my-review',
            title: 'My review',
            description: 'A review pairing.',
            requiresEndpoint: true,
            primary: 'research',
            subagents: ['summarizer'],
            agents: ['research', 'summarizer'],
            tools: SHARED_TOOL_NAMES,
            // The live toolbox opts into websearch AND webfetch; search stays
            // unadvertised on a keyless host because the catalogue has no executable
            // entry, while fetch (native) registers everywhere (R9-R11).
            environmentTools: ['search', 'fetch'],
            builtin: false,
            editable: true
        });

        // It is a real harness: same agents, same registry, and delegate exists
        // exactly because there is a subagent.
        const harness = preset.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['research', 'summarizer']);
        expect(Object.keys(harness.subagents)).toEqual(['summarizer']);
        expect(harness.tools.delegate.visibility).toBe('core');
        // R9-R11: createToolboxHarness opts into `webfetch: true`, and the harness
        // appends environment tools after the configured table and before the
        // harness-owned core set (harness.ts:740-761). search is absent because
        // this host is keyless; fetch needs no credential, so it lands first of
        // the appended tools and is declared core like a configured search.
        expect(Object.keys(harness.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'task',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'delegate',
            'threadFork',
            'toolCancel',
            ...SHARED_TOOL_NAMES,
            'fetch'
        ]);

        // The registry lists it after the built-ins.
        expect(registry.list().map((entry) => entry.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'my-review'
        ]);
    });

    it('defaults title to the name and description to empty', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({ name: 'solo', primary: 'workspace' });

        expect(preset.title).toBe('solo');
        expect(preset.description).toBe('');
        expect(preset.agents).toEqual(['workspace']);
        expect(preset.subagents).toEqual([]);

        // No subagents means the harness registers no delegate tool at all.
        expect(preset.create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('rejects bad names, reserved aliases, duplicates and unknown agents', () => {
        const registry = createHarnessRegistry();

        expect(registryError(() => registry.create({ name: '1nope', primary: 'instruct' }))).toEqual({
            status: 400,
            message:
                '`name` must start with a letter and contain only letters, digits, "_" or "-", at most 64 characters.'
        });

        expect(registryError(() => registry.create({ name: 'writer', primary: 'instruct' }))).toEqual({
            status: 400,
            message: 'Harness name "writer" is reserved as an alias of "instruct".'
        });

        expect(registryError(() => registry.create({ name: 'instruct', primary: 'instruct' }))).toEqual({
            status: 409,
            message: 'Harness "instruct" already exists.'
        });

        // Case-insensitive: a second card that differs only by case is ambiguous.
        expect(registryError(() => registry.create({ name: 'Instruct', primary: 'instruct' }))).toEqual({
            status: 409,
            message: 'Harness "Instruct" already exists.'
        });

        expect(registryError(() => registry.create({ name: 'x', primary: 'nobody' }))).toEqual({
            status: 400,
            message: `\`primary\` names unknown agent "nobody". Known agents: ${AGENT_PROFILE_NAMES.join(', ')}.`
        });
    });

    it('enforces exactly one primary and a distinct, bounded allowlist', () => {
        const registry = createHarnessRegistry();

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', subagents: ['instruct'] })
            )
        ).toEqual({
            status: 400,
            message: 'Subagent "instruct" is the primary agent; a harness has exactly one primary.'
        });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', subagents: ['workspace', 'workspace'] })
            )
        ).toEqual({
            status: 400,
            message: 'Subagent "workspace" is listed more than once.'
        });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', subagents: ['critic'] })
            )
        ).toEqual({
            status: 400,
            message: `\`subagents\` names unknown agent "critic". Known agents: ${AGENT_PROFILE_NAMES.join(', ')}.`
        });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', subagents: 'workspace' as never })
            )
        ).toEqual({ status: 400, message: '`subagents` must be an array of agent names.' });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    subagents: Array.from({ length: 17 }, () => 'workspace')
                })
            )
        ).toEqual({ status: 400, message: '`subagents` cannot exceed 16 entries.' });
    });

    it('validates title and description types and bounds', () => {
        const registry = createHarnessRegistry();

        expect(
            registryError(() => registry.create({ name: 'x', primary: 'instruct', title: 7 as never }))
        ).toEqual({ status: 400, message: '`title` must be a string.' });

        expect(
            registryError(() => registry.create({ name: 'x', primary: 'instruct', title: '   ' }))
        ).toEqual({ status: 400, message: '`title` cannot be empty.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', title: 'a'.repeat(121) })
            )
        ).toEqual({ status: 400, message: '`title` cannot exceed 120 characters.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', description: 'a'.repeat(2001) })
            )
        ).toEqual({ status: 400, message: '`description` cannot exceed 2000 characters.' });
    });
});

describe('updating a harness', () => {
    it('replaces metadata and routing without mutating the old preset', () => {
        const registry = createHarnessRegistry();
        const before = registry.find('instruct')!;

        const after = registry.update('instruct', {
            title: 'Instruct (edited)',
            description: 'Edited description.',
            primary: 'workspace',
            subagents: ['research', 'summarizer']
        });

        expect({
            title: after.title,
            description: after.description,
            primary: after.primary,
            subagents: after.subagents,
            agents: after.agents
        }).toEqual({
            title: 'Instruct (edited)',
            description: 'Edited description.',
            primary: 'workspace',
            subagents: ['research', 'summarizer'],
            agents: ['workspace', 'research', 'summarizer']
        });

        // The objects handed out BEFORE the patch are untouched: a session that
        // captured `before` keeps running the original configuration.
        expect({
            title: before.title,
            description: before.description,
            primary: before.primary,
            subagents: before.subagents,
            agents: before.agents
        }).toEqual({
            title: 'Instruct',
            // The shipped description, byte-for-byte: the patch replaced the
            // registry entry, not the object the old session captured.
            description: presets[0].description,
            primary: 'instruct',
            // The shipped team (T3): every other real role plus the summarizer.
            subagents: ['research', 'workspace', 'reviewer', 'planner', 'summarizer'],
            agents: ['instruct', 'research', 'workspace', 'reviewer', 'planner', 'summarizer']
        });
        expect(before).not.toBe(after);
        expect(registry.find('instruct')).toBe(after);

        // The rebuilt harness follows the new routing, and delegate appears now
        // that the primary has somewhere to delegate.
        const harness = after.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['workspace', 'research', 'summarizer']);
        expect(Object.keys(harness.subagents)).toEqual(['research', 'summarizer']);
        expect(harness.tools.delegate.visibility).toBe('core');
    });

    it('drops the new primary from the old allowlist when subagents are not restated', () => {
        const registry = createHarnessRegistry();

        // Research starts with the symmetric team (T3): instruct, workspace,
        // reviewer, planner, summarizer. Promoting one member must remove it from
        // the allowlist and keep the rest in order.
        const after = registry.update('research', { primary: 'summarizer' });

        expect(after.primary).toBe('summarizer');
        expect(after.subagents).toEqual(['instruct', 'workspace', 'reviewer', 'planner']);
        expect(after.agents).toEqual([
            'summarizer',
            'instruct',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(after.create(SETTINGS, progress).tools.delegate.visibility).toBe('core');
    });

    it('validates a patched allowlist against the effective primary', () => {
        const registry = createHarnessRegistry();

        expect(
            registryError(() => registry.update('research', { subagents: ['research'] }))
        ).toEqual({
            status: 400,
            message: 'Subagent "research" is the primary agent; a harness has exactly one primary.'
        });

        expect(
            registryError(() => registry.update('research', { primary: 'nobody' }))
        ).toEqual({
            status: 400,
            message: `\`primary\` names unknown agent "nobody". Known agents: ${AGENT_PROFILE_NAMES.join(', ')}.`
        });
    });

    it('patches every shipped template and rejects only unknown names', () => {
        const registry = fixtureRegistry();

        // R20.1: no read-only category. A metadata-only patch is a 200 for the
        // formerly frozen demo/flaky templates too (T5: injected, not shipped).
        expect(registry.update('demo', { title: 'Demo!' }).title).toBe('Demo!');
        expect(registry.update('flaky', { title: 'Flaky!' }).title).toBe('Flaky!');

        expect(registryError(() => registry.update('missing', { title: 'x' }))).toEqual({
            status: 404,
            message: 'Unknown harness "missing".'
        });
    });

    it('keeps the demo script and flaky extras through a metadata-only patch', () => {
        const registry = fixtureRegistry();
        const demoBefore = registry.find('demo')!;
        const flakyBefore = registry.find('flaky')!;

        const demoAfter = registry.update('demo', {
            title: 'Scripted demo (renamed)',
            description: 'Edited description.'
        });
        const flakyAfter = registry.update('flaky', {
            title: 'Recoverable failures (renamed)'
        });

        // The factory is the SAME closure: metadata is not execution, so the
        // scripted transport and the timeNow-only registry survive.
        expect(demoAfter.create).toBe(demoBefore.create);
        expect(demoAfter.tools).toEqual(['timeNow']);
        expect(demoAfter.requiresEndpoint).toBe(false);
        expect(demoAfter.template).toBe('scripted');

        // The flaky example keeps its extra tool and shared toolbox declaration.
        expect(flakyAfter.create).toBe(flakyBefore.create);
        expect(flakyAfter.tools).toEqual([...SHARED_TOOL_NAMES, 'testFlaky']);
        expect(flakyAfter.environmentTools).toEqual(['search', 'fetch']);
        expect(flakyAfter.template).toBe('flaky');

        // The runtime really keeps them: these are the exact registered names.
        expect(Object.keys(demoAfter.create(SETTINGS, progress).tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'task',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);
        expect(Object.keys(flakyAfter.create(SETTINGS, progress).tools)).toContain('testFlaky');

        // The old objects are untouched; a session that captured them keeps the
        // shipped metadata too.
        expect(demoBefore.title).toBe('Scripted demo');
        expect(flakyBefore.title).toBe('Recoverable failures (example)');
    });

    it('upgrades the demo to an honest live profiled harness on an executable patch', () => {
        const registry = fixtureRegistry();
        const before = registry.find('demo')!;
        const scripted = before.create(SETTINGS, progress);

        const after = registry.update('demo', { primary: 'workspace' });

        // The descriptor stops claiming the offline fixture: it now needs a
        // provider, advertises the shared toolbox the live factory registers, and
        // adopts the template's live prose because the shipped text was untouched.
        expect(after.template).toBe('live');
        expect(after.title).toBe('Live demo');
        expect(after.description).toContain('no longer uses the offline script');
        expect(after.requiresEndpoint).toBe(true);
        expect(after.tools).toEqual(SHARED_TOOL_NAMES);
        expect(after.environmentTools).toEqual(['search', 'fetch']);
        expect(after.primary).toBe('workspace');
        expect(after.agents).toEqual(['workspace']);

        const live = after.create(SETTINGS, progress);
        expect(Object.keys(live.agents)).toEqual(['workspace']);
        expect(Object.keys(live.tools)).toEqual(
            expect.arrayContaining([...SHARED_TOOL_NAMES, 'toolRequest', 'toolCreate', 'task'])
        );
    });

    it('rebuilds flaky live and retains testFlaky on an executable patch', () => {
        const registry = fixtureRegistry();

        const after = registry.update('flaky', {
            primary: 'workspace',
            agentModels: { workspace: 'big/model' }
        });

        expect(after.template).toBe('flaky');
        expect(after.tools).toEqual([...SHARED_TOOL_NAMES, 'testFlaky']);
        expect(after.requiresEndpoint).toBe(true);
        expect(after.agents).toEqual(['workspace']);

        const live = after.create(SETTINGS, progress);
        expect(live.tools.testFlaky).toBeDefined();
        expect(Object.keys(live.agents)).toEqual(['workspace']);
        expect(live.agents.workspace.model()).toBe('big/model');
    });
});

// Deleting a harness (T5).
//
// This is the contract the `DELETE /harnesses/:name` route is built on: any name is
// removable (a shipped built-in exactly like a user harness), an unknown or
// already-removed name is an honest 404 rather than a second success, and a built-in
// stays removed only because the registry records a TOMBSTONE the persistence layer
// can replay — `list()` alone cannot express "this shipped default is gone", because
// every registry seeds itself from ./presets.ts. Sessions are deliberately outside
// this contract: an existing session holds the preset it captured (pinned by
// ../sessions.test.ts) and a saved one rebuilds from its own record
// (../persistence.test.ts).
describe('deleting a harness', () => {
    it('removes a user harness without tombstoning it', () => {
        const registry = createHarnessRegistry();
        registry.create({ name: 'temp', primary: 'instruct' });

        // The removed entry is returned by identity, so a caller can log or roll back
        // exactly what disappeared.
        const before = registry.find('temp')!;
        expect(registry.remove('temp')).toBe(before);
        expect(before.title).toBe('temp');

        expect(registry.find('temp')).toBeUndefined();
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);

        // No tombstone: a user harness is absent from the saved document as soon as
        // it is absent from list(), and nothing ships it back.
        expect(registry.deletedBuiltins()).toEqual([]);

        // The object a session captured is still a working harness after removal.
        expect(Object.keys(before.create(SETTINGS, progress).agents)).toEqual(['instruct']);
    });

    it('tombstones a deleted built-in and takes it out of every lookup', () => {
        const registry = createHarnessRegistry();
        const instruct = registry.find('instruct')!;

        expect(registry.remove('instruct')).toBe(instruct);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(registry.find('instruct')).toBeUndefined();

        // An alias follows its target: `writer` still NAMES instruct, and instruct is
        // gone, so the alias resolves to nothing rather than to a stale card.
        expect(registry.find('writer')).toBeUndefined();

        // The tombstone is the durable half of the deletion.
        expect(registry.deletedBuiltins()).toEqual(['instruct']);

        // Alias names stay reserved whether or not their target exists: accepting
        // `writer` as a new harness would make an old client's `writer` request mean
        // something different after this harness is deleted.
        expect(registryError(() => registry.create({ name: 'writer', primary: 'instruct' }))).toEqual({
            status: 400,
            message: 'Harness name "writer" is reserved as an alias of "instruct".'
        });
    });

    it('reports an unknown, already-deleted, or alias-only name as 404', () => {
        const registry = createHarnessRegistry();

        // Never seen.
        expect(registryError(() => registry.remove('nope'))).toEqual({
            status: 404,
            message: 'Unknown harness "nope".'
        });

        // A repeat DELETE did not remove anything, so it must not claim success.
        expect(registry.remove('planner').name).toBe('planner');
        expect(registryError(() => registry.remove('planner'))).toEqual({
            status: 404,
            message: 'Harness "planner" has already been deleted.'
        });

        // An alias is a read redirect, not an identity that can be deleted: this must
        // not touch `instruct` (the same rule update() follows).
        expect(registryError(() => registry.remove('writer'))).toEqual({
            status: 404,
            message: 'Unknown harness "writer".'
        });
        expect(registry.find('instruct')?.title).toBe('Instruct');

        // A deleted built-in is no longer patchable either.
        expect(registryError(() => registry.update('planner', { title: 'Back?' }))).toEqual({
            status: 404,
            message: 'Unknown harness "planner".'
        });
    });

    it('lets a deleted built-in name be taken again and clears the tombstone', () => {
        const registry = createHarnessRegistry();
        registry.remove('instruct');

        // The name is free again: deleting the shipped card and creating your own
        // under the same id is the documented way to replace a default.
        const rebuilt = registry.create({ name: 'instruct', title: 'My instruct', primary: 'research' });
        expect(rebuilt.builtin).toBe(false);

        // The tombstone is gone, or the next restore would delete the harness the
        // operator just made.
        expect(registry.deletedBuiltins()).toEqual([]);
        expect(registry.find('instruct')?.title).toBe('My instruct');

        // ...and the legacy alias resolves again, to the replacement.
        expect(registry.find('writer')?.title).toBe('My instruct');

        // A re-created name appends: it does not return to the shipped position,
        // because listing order is creation order for anything not shipped.
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'research',
            'workspace',
            'reviewer',
            'planner',
            'instruct'
        ]);
    });

    it('seeds tombstones at construction, including for a name this build does not ship', () => {
        const registry = createHarnessRegistry(presets, { deletedBuiltins: ['instruct', 'workspace'] });

        expect(registry.list().map((preset) => preset.name)).toEqual(['research', 'reviewer', 'planner']);
        expect(registry.deletedBuiltins()).toEqual(['instruct', 'workspace']);
        expect(registry.find('writer')).toBeUndefined();

        // A tombstone naming something this build does not ship is KEPT: it records a
        // real decision, and a default that returns in a later build must come back
        // already deleted rather than resurrected.
        const unmatched = createHarnessRegistry(presets, { deletedBuiltins: ['retired-default'] });
        expect(unmatched.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(unmatched.deletedBuiltins()).toEqual(['retired-default']);
    });

    it('replays deletions idempotently and removes an entry the build still ships', () => {
        const registry = createHarnessRegistry(ALL_PRESET_TEMPLATES);

        // Startup replay: duplicates and blank names are noise, not errors, and a
        // name this build does not ship is still recorded.
        registry.restoreDeletedBuiltins(['demo', 'demo', '  ', 'retired-default']);

        expect(registry.find('demo')).toBeUndefined();
        expect(registry.deletedBuiltins()).toEqual(['demo', 'retired-default']);

        // Order-stable and idempotent: replaying the same list again changes nothing,
        // which is what makes a restart safe.
        registry.restoreDeletedBuiltins(['demo']);
        expect(registry.deletedBuiltins()).toEqual(['demo', 'retired-default']);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'flaky'
        ]);

        // A replayed deletion is indistinguishable from a live one to the caller.
        expect(registryError(() => registry.remove('demo'))).toEqual({
            status: 404,
            message: 'Harness "demo" has already been deleted.'
        });
    });

    it('snapshots and restores entries, listing order, and tombstones', () => {
        const registry = createHarnessRegistry();
        const captured = registry.snapshot();

        // Every mutation shape at once: create, patch, and delete.
        registry.create({ name: 'extra', primary: 'instruct' });
        registry.update('research', { title: 'Renamed' });
        registry.remove('planner');

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'extra'
        ]);
        expect(registry.deletedBuiltins()).toEqual(['planner']);

        // The rollback the durable commit uses (SessionStore.mutateRegistry).
        registry.restore(captured);

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(registry.find('research')?.title).toBe('Researcher');
        expect(registry.find('extra')).toBeUndefined();
        expect(registry.find('planner')).toBeDefined();
        expect(registry.deletedBuiltins()).toEqual([]);

        // A restored entry is the SAME preset object that was captured, so a session
        // holding it is unaffected by a rollback either way.
        expect(registry.find('instruct')).toBe(captured.entries.find(([name]) => name === 'instruct')![1]);
    });
});

// Per-agent model overrides (R9).
//
// The contract: a map of selected agent id → model id is validated against the
// FINAL member set, applied when the live harness is assembled, and captured by the
// preset's factory closure so an existing session keeps the models it was built
// with. Only model ids are client-supplied — never a provider or credential.
describe('per-agent model overrides', () => {
    it('applies an override to that agent only, falling back to the session model', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'mixed',
            primary: 'research',
            subagents: ['summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });

        expect(preset.agentModels).toEqual({ summarizer: 'small/fast' });

        const harness = preset.create(SETTINGS, progress);
        // The override applies to the summarizer; the primary keeps the session
        // model because the map omits it (not because it is special).
        expect(harness.agents.summarizer.model()).toBe('small/fast');
        expect(harness.agents.research.model()).toBe('test-model');
    });

    it('accepts an override for the primary and trims the id', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'trimmed',
            primary: 'instruct',
            agentModels: { instruct: '  merge/ds4-flash  ' }
        });

        expect(preset.agentModels).toEqual({ instruct: 'merge/ds4-flash' });
        expect(preset.create(SETTINGS, progress).agents.instruct.model()).toBe('merge/ds4-flash');
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentModels: [] as never })
            )
        ).toEqual({ status: 400, message: '`agentModels` must be an object mapping agent ids to model ids.' });

        // A key that is not a final member: an override for an agent this harness
        // does not contain could never apply.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentModels: { summarizer: 'small/fast' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentModels` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, an over-long id, and control
        // characters are all rejected with the agent named.
        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentModels: { instruct: 7 as never } })
            )
        ).toEqual({ status: 400, message: '`agentModels.instruct` must be a model id string.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentModels: { instruct: '   ' } })
            )
        ).toEqual({ status: 400, message: '`agentModels.instruct` cannot be empty.' });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentModels: { instruct: 'a'.repeat(201) }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentModels.instruct` cannot exceed 200 characters.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentModels: { instruct: 'bad\nmodel' }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentModels.instruct` contains control characters.'
        });
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'mixed',
            primary: 'research',
            subagents: ['summarizer'],
            agentModels: { research: 'big/model', summarizer: 'small/fast' }
        });

        // A stated map replaces the previous one: only `summarizer` is overridden
        // now, so the primary goes back to the session model.
        const replaced = registry.update('mixed', { agentModels: { summarizer: 'tiny/model' } });
        expect(replaced.agentModels).toEqual({ summarizer: 'tiny/model' });
        expect(replaced.create(SETTINGS, progress).agents.research.model()).toBe('test-model');
        expect(replaced.create(SETTINGS, progress).agents.summarizer.model()).toBe('tiny/model');

        // Changing membership without restating the map drops the override for the
        // agent that is no longer selected; the survivor keeps its model.
        const narrowed = registry.update('mixed', { subagents: [] });
        expect(narrowed.agentModels).toEqual({});
        expect(narrowed.create(SETTINGS, progress).agents.research.model()).toBe('test-model');

        // An explicit empty map clears every override.
        const reseeded = registry.update('mixed', {
            subagents: ['summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });
        expect(reseeded.agentModels).toEqual({ summarizer: 'small/fast' });
        expect(registry.update('mixed', { agentModels: {} }).agentModels).toEqual({});
    });

    it('rejects an explicitly unknown key even when the same patch changes membership', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'mixed',
            primary: 'research',
            subagents: ['summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });

        // `summarizer` is dropped by this patch, and the stated map still names
        // it: a stated key is explicit input, so it is a 400 rather than silently
        // discarded.
        expect(
            registryError(() => registry.update('mixed', { subagents: [], agentModels: { summarizer: 'x' } }))
        ).toEqual({
            status: 400,
            message:
                '`agentModels` names "summarizer", which is not a member of this harness. Members: research.'
        });
    });

    it('leaves the captured factory and descriptor of an old preset untouched', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'mixed',
            primary: 'research',
            subagents: ['summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });
        const oldHarness = before.create(SETTINGS, progress);

        registry.update('mixed', { agentModels: { summarizer: 'other/model' } });

        // The old preset object and its closure are not mutated: a session built
        // from `before` keeps the model it was created with.
        expect(before.agentModels).toEqual({ summarizer: 'small/fast' });
        expect(oldHarness.agents.summarizer.model()).toBe('small/fast');
        expect(before.create(SETTINGS, progress).agents.summarizer.model()).toBe('small/fast');

        const after = registry.find('mixed')!;
        expect(after.agentModels).toEqual({ summarizer: 'other/model' });
        expect(after.create(SETTINGS, progress).agents.summarizer.model()).toBe('other/model');
    });

    it('describes the override map only when it is non-empty', () => {
        const registry = createHarnessRegistry();

        const bare = registry.create({ name: 'bare', primary: 'instruct' });
        expect(describeHarness(bare).agentModels).toBeUndefined();

        const mapped = registry.create({
            name: 'mapped',
            primary: 'instruct',
            agentModels: { instruct: 'big/model' }
        });
        // The descriptor carries the OVERRIDE map, not a resolved model per agent:
        // a UI shows "default" for the agents it omits.
        expect(describeHarness(mapped).agentModels).toEqual({ instruct: 'big/model' });
    });
});

// T3 editable configuration — the harness-scoped sibling of `agentModels`. These
// tests are deliberately the same SHAPE as the block above: an instruction override
// is validated, stored, projected and executed by the same machinery, and the only
// intended differences are the value rules (prose bounds instead of id bounds) and
// the fact that the trusted profile stays untouched.
//
// WHY EVERY ASSERTION BELOW EXPECTS A ONE-ENTRY `instructions` ARRAY
// ------------------------------------------------------------------
// `agentInstruction()` (src/agents/index.ts) returns ONE string: the identity
// paragraph, a BLANK line, then `Guidelines:` with one `- ` bullet per guideline in
// profile order. `agent({ instruction })` seeds one `system` message per array entry
// (src/core/agent.ts `normalizeInstructions`), so the old two-entry value put TWO
// system messages at the head of every transcript — and several OpenAI-compatible
// gateways accept only ONE system turn (or keep just the first/last), silently
// dropping the guidelines. A profile-built agent therefore seeds exactly ONE system
// message, which is what the whole-array `toEqual([<joined prompt>])` assertions below
// pin from the harness side: one entry, exact text, nothing appended after it.
describe('per-agent instruction overrides', () => {
    // The summarizer's own shipped text, so the assertions below name the exact
    // words an agent is seeded with rather than re-deriving them from the helper.
    // Hand-derived from src/agents/summarizer.ts: identity sentence + its two
    // guideline bullets, joined by the one blank line the rule requires.
    const TRUSTED_SUMMARIZER_INSTRUCTION = 'You compress technical notes into at most two sentences.';
    const TRUSTED_GUIDELINES =
        'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.';

    // The complete one-message prompt for the un-overridden summarizer.
    const TRUSTED_SUMMARIZER_PROMPT = `${TRUSTED_SUMMARIZER_INSTRUCTION}\n\n${TRUSTED_GUIDELINES}`;

    // An override swaps ONLY the identity paragraph, so every summarizer override
    // below runs the operator's sentence above the unchanged trusted policy block.
    const summarizerPrompt = (instruction: string) => `${instruction}\n\n${TRUSTED_GUIDELINES}`;

    // The trusted guideline block of a long shared-policy role, rendered exactly as
    // src/agents/index.ts renders it (header plus one `- ` bullet per entry, in
    // declared order). Built from the shipped profile data instead of duplicating
    // ~1.3kB of shared policy prose in this file; `readonly` because
    // `AgentProfile.guidelines` is a readonly tuple.
    const guidelinesBlock = (guidelines: readonly string[]) =>
        `Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;

    it('applies an override to that agent only and keeps the trusted guidelines', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced',
            primary: 'research',
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'Condense to one line.' }
        });

        expect(preset.agentInstructions).toEqual({ summarizer: 'Condense to one line.' });

        const harness = preset.create(SETTINGS, progress);

        // The override replaces ONLY the identity sentence; the policy lines stay,
        // which is what keeps a saved configuration from dropping shared rules. The
        // whole prompt is ONE array entry, because the sections are joined where they
        // are composed — two entries would be two `system` messages, and a gateway
        // that accepts one system turn would keep only the identity paragraph.
        expect(harness.agents.summarizer.instructions).toEqual([
            summarizerPrompt('Condense to one line.')
        ]);

        // A member the map omits runs the trusted profile exactly as before: one
        // entry holding its composed prompt, read from the catalogue itself so the
        // wording of a shared-policy role cannot drift into this file.
        expect(harness.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
    });

    it('never mutates the trusted profile it overrides', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced',
            primary: 'summarizer',
            agentInstructions: { summarizer: 'Rewrite it as a haiku.' }
        });

        expect(preset.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('Rewrite it as a haiku.')
        ]);

        // The catalogue is still the shipped text: the override lives on the harness
        // entry, and a second harness built from the same profile is unaffected.
        expect(AGENT_PROFILES.summarizer.instruction).toBe(TRUSTED_SUMMARIZER_INSTRUCTION);
        expect(
            registry.create({ name: 'plain', primary: 'summarizer' }).create(SETTINGS, progress)
                .agents.summarizer.instructions
        ).toEqual([TRUSTED_SUMMARIZER_PROMPT]);
    });

    it('accepts multi-line prose and trims the stored text', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'multiline',
            primary: 'instruct',
            agentInstructions: { instruct: '  Lead with the answer.\n\nThen show the evidence.  ' }
        });

        expect(preset.agentInstructions).toEqual({
            instruct: 'Lead with the answer.\n\nThen show the evidence.'
        });

        const harness = preset.create(SETTINGS, progress);
        // The trimmed prose is the identity paragraph of the ONE system message, and
        // the trusted block still follows it after the single blank line the join rule
        // requires. Blank lines inside the override are legal; they never push the
        // guidelines out of the message or split it into a second entry.
        expect(harness.agents.instruct.instructions).toEqual([
            `Lead with the answer.\n\nThen show the evidence.\n\n${guidelinesBlock(AGENT_PROFILES.instruct.guidelines)}`
        ]);
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentInstructions: [] as never })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions` must be an object mapping agent ids to instruction text.'
        });

        // A key that is not a final member: an override for an agent this harness
        // does not contain could never apply.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentInstructions: { summarizer: 'Condense.' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentInstructions` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, an over-long body, and a control
        // character are all rejected with the agent named.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentInstructions: { instruct: 7 as never }
                })
            )
        ).toEqual({ status: 400, message: '`agentInstructions.instruct` must be an instruction string.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentInstructions: { instruct: '   ' } })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentInstructions.instruct` cannot be empty. Omit the key to run the trusted instruction.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentInstructions: { instruct: 'a'.repeat(8_001) }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions.instruct` cannot exceed 8000 characters.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentInstructions: { instruct: 'null\u0000byte' }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions.instruct` contains control characters.'
        });
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'voiced',
            primary: 'research',
            subagents: ['summarizer'],
            agentInstructions: { research: 'Ask before acting.', summarizer: 'Two lines max.' }
        });

        // A stated map REPLACES: the primary is back on its trusted one-message prompt.
        const replaced = registry.update('voiced', { agentInstructions: { summarizer: 'One line.' } });
        expect(replaced.agentInstructions).toEqual({ summarizer: 'One line.' });

        const rebuilt = replaced.create(SETTINGS, progress);
        // Both sides of the swap are one-message prompts: the dropped member is back on
        // its trusted joined prompt, the kept member on the override above its trusted
        // guideline block.
        expect(rebuilt.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
        expect(rebuilt.agents.summarizer.instructions).toEqual([summarizerPrompt('One line.')]);

        // Narrowing the team drops the override of the agent that left, so a later
        // re-add cannot silently resurrect an old prompt. `summarizer`'s entry is the
        // only one standing, so the map ends up empty.
        const narrowed = registry.update('voiced', { subagents: [] });
        expect(narrowed.agentInstructions).toEqual({});

        // An explicit empty map clears every override.
        registry.update('voiced', {
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'One line.' }
        });
        expect(registry.update('voiced', { agentInstructions: {} }).agentInstructions).toEqual({});
        expect(
            registry.find('voiced')!.create(SETTINGS, progress).agents.summarizer.instructions
        ).toEqual([TRUSTED_SUMMARIZER_PROMPT]);
    });

    it('treats an instruction edit as executable and keeps a captured factory frozen', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'voiced',
            primary: 'research',
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'Two lines max.' }
        });
        const oldHarness = before.create(SETTINGS, progress);

        const after = registry.update('voiced', { agentInstructions: { summarizer: 'One line.' } });

        // A NEW preset object with a NEW closure: a session built from `before` keeps
        // the words its agents were created with (the frozen-session guarantee).
        expect(oldHarness.agents.summarizer.instructions).toEqual([
            summarizerPrompt('Two lines max.')
        ]);
        expect(before.agentInstructions).toEqual({ summarizer: 'Two lines max.' });
        expect(before.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('Two lines max.')
        ]);
        expect(after.agentInstructions).toEqual({ summarizer: 'One line.' });
        expect(after.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('One line.')
        ]);
    });

    it('upgrades the scripted demo on an instruction edit, exactly like a model edit', () => {
        const registry = fixtureRegistry();

        // The demo's shipped factory is the offline script, which ignores prompts. An
        // instruction edit is executable, so it must not be stored against a factory
        // that would silently ignore it: the entry becomes a live profiled harness.
        const patched = registry.update('demo', { agentInstructions: { demo: 'Be brief.' } });

        expect(patched.template).toBe('live');
        expect(patched.requiresEndpoint).toBe(true);
        expect(patched.agentInstructions).toEqual({ demo: 'Be brief.' });
    });

    it('describes the override map only when it is non-empty', () => {
        const registry = createHarnessRegistry();

        expect(describeHarness(registry.create({ name: 'bare2', primary: 'instruct' })).agentInstructions).toBeUndefined();

        const mapped = registry.create({
            name: 'voiced2',
            primary: 'instruct',
            agentInstructions: { instruct: 'Lead with the answer.' }
        });
        // The OVERRIDE map, not the effective text: a UI pairs this with the trusted
        // `GET /agents` instruction to show what an agent actually runs.
        expect(describeHarness(mapped).agentInstructions).toEqual({ instruct: 'Lead with the answer.' });
    });

    it('round-trips through a durable record and stays a customisation', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced3',
            primary: 'research',
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'One line.' }
        });

        // A record carries the map, so a restart rebuilds the same prompts.
        const record = presetToRecord(preset);
        expect(record.agentInstructions).toEqual({ summarizer: 'One line.' });

        const restored = presetFromRecord(record);
        expect(restored.agentInstructions).toEqual({ summarizer: 'One line.' });
        // The rebuilt preset seeds the same single system message the live preset did,
        // so persistence does not reintroduce a split prompt.
        expect(restored.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('One line.')
        ]);

        // Equality ignores insertion order but not the override itself, and a stored
        // override proves the row was customised: the shipped-default refresh must
        // never overwrite it. The record's team already matches the legacy research
        // definition, so `agentInstructions` is the only variable under test.
        expect(presetRecordEquals(record, presetToRecord(restored))).toBe(true);

        // `record` comes from THIS build's registry, whose environmentTools default
        // is now ['search', 'fetch'] (R9-R11). The legacy table records what the OLD
        // shipped row said, and isLegacyShippedDefinition compares that field, so the
        // fixture pins it to the legacy value: `agentInstructions` is the only
        // variable under test. A real old row still carries ['search'] and refreshes.
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
            ...asShippedRow,
            agentInstructions: { summarizer: 'One line.' }
        })).toBe(false);

        expect(isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
            ...asShippedRow,
            agentInstructions: {}
        })).toBe(true);
    });
});

// One tiny guard: the registry accepts an injected catalogue (tests inject
// scripted presets) and must not fall back to the shipped list for lookup.
describe('an injected registry', () => {
    const scripted: HarnessPreset = {
        name: 'scripted',
        title: 'Scripted',
        description: 'A scripted fixture.',
        requiresEndpoint: false,
        primary: 'scripted',
        subagents: [],
        agents: ['scripted'],
        tools: [],
        builtin: true,
        editable: true,
        create: () => {
            throw new Error('the registry must not construct on create()/update()');
        }
    };

    it('keeps its own entries and still offers the trusted agents', () => {
        const registry = createHarnessRegistry([scripted]);

        // R20.1: the entry is an independent copy, not the injected object.
        expect(registry.list()).toEqual([scripted]);
        expect(registry.find('scripted')).not.toBe(scripted);
        expect(registry.find('scripted')).toEqual(scripted);
        expect(registry.find('instruct')).toBeUndefined();
        expect(registry.agents().map((profile) => profile.name)).toEqual([...AGENT_PROFILE_NAMES]);

        // Creating into an injected registry is still validated and works.
        const created = registry.create({ name: 'fresh', primary: 'instruct' });
        expect(registry.list().map((entry) => entry.name)).toEqual(['scripted', 'fresh']);
        expect(created.create).not.toBe(scripted.create);
    });
});

// Per-agent identity colors (R2) — the display-only sibling of `agentModels` and
// `agentInstructions`.
//
// The contract, deliberately the same shape as the two maps above:
//   - a map of selected agent id → CSS hex color is validated against the FINAL member
//     set (an entry for an unselected agent could never be painted, so it is a 400 that
//     names the agent rather than a stored no-op);
//   - a stated map on PATCH REPLACES the stored one, `{}` clears every color, and a key
//     for a member the same patch removed is dropped;
//   - the map is captured by the factory closure, so an existing session keeps the
//     swatches its agents were built with while the next session gets the new ones;
//   - `describeHarness` emits it only when non-empty, and the durable record reads and
//     replays it exactly like `agentModels`;
//   - and the thing that makes it DIFFERENT from the other two: nothing it touches
//     changes what an agent runs, which the instruction/model assertions below pin.
describe('per-agent identity colors', () => {
    // One table, three layers. The library pattern (src/core/agent.ts
    // `AGENT_COLOR_PATTERN`), the registry pattern (registry.ts, same file) and the HTTP
    // contract (`harness.swagger.yaml` `agent_colors.pattern`) must agree on exactly this
    // set, or a stored color could be one a UI cannot paint.
    const HEX_ACCEPTED = ['#abc', '#abcd', '#aabbcc', '#aabbccdd', '#ABC', '#4ADE80'];
    const HEX_REJECTED = [
        'red',
        'rgb(74, 222, 128)',
        '#',
        '#ab',
        '#abcde',
        '#aabbccdde',
        'aabbcc',
        '#gggggg',
        '#ff_000',
        '',
        '   '
    ];

    // The registry's refusal for one value: blank text and a malformed shape are stated
    // differently on purpose (clearing is omitting the key, never storing an empty value).
    const registryRefusal = (color: string): string =>
        color.trim().length === 0
            ? '`agentColors.instruct` cannot be empty. Omit the key to leave this agent uncolored.'
            : `\`agentColors.instruct\` must be a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa). Received ${JSON.stringify(color)}.`;

    it('colors that agent only, leaves the rest uncolored, and changes nothing about the prompt', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { summarizer: '#4ade80' }
        });

        expect(preset.agentColors).toEqual({ summarizer: '#4ade80' });

        const harness = preset.create(SETTINGS, progress);
        // The colored member carries its swatch on the AGENT (R1: stable identity
        // metadata, not only on the card), and the member the map omits carries NO key.
        expect(harness.agents.summarizer.color).toBe('#4ade80');
        expect(Object.hasOwn(harness.agents.research, 'color')).toBe(false);

        // Display-only, proven: the same team with no colors at all runs byte-identical
        // prompts and the same models. A color is not a prompt override.
        const bare = registry.create({
            name: 'unpainted',
            primary: 'research',
            subagents: ['summarizer']
        }).create(SETTINGS, progress);

        expect(harness.agents.summarizer.instructions).toEqual(bare.agents.summarizer.instructions);
        expect(harness.agents.summarizer.model()).toBe(bare.agents.summarizer.model());
        expect(harness.agents.research.model()).toBe('test-model');
    });

    it('accepts an override for the primary and trims the value', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'trimmed',
            primary: 'instruct',
            agentColors: { instruct: '  #4ADE80  ' }
        });

        expect(preset.agentColors).toEqual({ instruct: '#4ADE80' });
        // The stored casing survives all the way to the agent the next session builds.
        expect(preset.create(SETTINGS, progress).agents.instruct.color).toBe('#4ADE80');
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentColors: [] as never })
            )
        ).toEqual({
            status: 400,
            message: '`agentColors` must be an object mapping agent ids to CSS hex colors.'
        });

        // A key that is not a final member: a swatch for an agent this harness does not
        // contain could never be painted.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    primary: 'instruct',
                    agentColors: { summarizer: '#4ade80' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentColors` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, and every malformed hex shape are 400s
        // naming the agent, so the UI can point at the offending swatch.
        expect(
            registryError(() =>
                registry.create({ name: 'x', primary: 'instruct', agentColors: { instruct: 7 as never } })
            )
        ).toEqual({
            status: 400,
            message: '`agentColors.instruct` must be a CSS hex color string.'
        });

        for (const color of HEX_REJECTED) {
            expect(
                registryError(() =>
                    registry.create({ name: 'x', primary: 'instruct', agentColors: { instruct: color } })
                )
            ).toEqual({ status: 400, message: registryRefusal(color) });
        }
    });

    it('accepts and rejects the same hex set as agent() construction', () => {
        const registry = createHarnessRegistry();
        const provider = { baseURL: 'http://provider.test/v1' };

        expect(
            HEX_ACCEPTED.map((color) => [
                // Registry edge: stored verbatim (trimmed), and reported back.
                registry.create({
                    name: `both-ok-${HEX_ACCEPTED.indexOf(color)}`,
                    primary: 'instruct',
                    agentColors: { instruct: color }
                }).agentColors,
                // Library edge: the same value reaches the agent.
                agent({ name: 'writer', model: 'm', provider, color }).color
            ])
        ).toEqual(HEX_ACCEPTED.map((color) => [{ instruct: color }, color]));

        // Every value the registry refuses with a 400 is also a construction error in the
        // library, so a document written by an older server can never hold a color the
        // runtime would reject.
        for (const color of HEX_REJECTED) {
            expect(() => agent({ name: 'writer', model: 'm', provider, color })).toThrow(
                `Agent "writer" has an invalid \`color\`: ${JSON.stringify(color)}.`
            );
        }
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { research: '#4ade80', summarizer: '#f97316' }
        });

        // A stated map REPLACES: the member it omits is uncolored again.
        const replaced = registry.update('painted', { agentColors: { summarizer: '#22d3ee' } });
        expect(replaced.agentColors).toEqual({ summarizer: '#22d3ee' });

        const rebuilt = replaced.create(SETTINGS, progress);
        expect(rebuilt.agents.summarizer.color).toBe('#22d3ee');
        expect(Object.hasOwn(rebuilt.agents.research, 'color')).toBe(false);

        // Narrowing the team drops the swatch of the agent that left, so a later re-add
        // cannot silently resurrect an old color.
        const narrowed = registry.update('painted', { subagents: [] });
        expect(narrowed.agentColors).toEqual({});

        // An explicit empty map clears every color, and the rebuilt agents carry none.
        registry.update('painted', { subagents: ['summarizer'], agentColors: { summarizer: '#22d3ee' } });
        expect(registry.update('painted', { agentColors: {} }).agentColors).toEqual({});
        expect(
            Object.hasOwn(registry.find('painted')!.create(SETTINGS, progress).agents.summarizer, 'color')
        ).toBe(false);
    });

    it('treats a color edit as executable and keeps a captured factory frozen', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { summarizer: '#4ade80' }
        });

        // An existing session holds THIS preset object; recoloring the registry entry
        // produces a NEW one, so the frozen copy still builds the old swatch.
        registry.update('painted', { agentColors: { summarizer: '#f97316' } });

        const after = registry.find('painted')!;
        expect(after).not.toBe(before);
        expect(before.agentColors).toEqual({ summarizer: '#4ade80' });
        expect(after.agentColors).toEqual({ summarizer: '#f97316' });
        expect(before.create(SETTINGS, progress).agents.summarizer.color).toBe('#4ade80');
        expect(after.create(SETTINGS, progress).agents.summarizer.color).toBe('#f97316');

        // A color patch is EXECUTABLE: it rebuilds the factory, so the next session's
        // agents carry it. A metadata-only patch (title alone) keeps the captured closure.
        const metadataOnly = registry.update('painted', { title: 'Renamed' });
        expect(metadataOnly.create).toBe(after.create);
        expect(metadataOnly.agentColors).toEqual({ summarizer: '#f97316' });
    });

    it('upgrades a scripted template the same way an instruction edit does', () => {
        const registry = fixtureRegistry();
        const recolored = registry.update('demo', { agentColors: { demo: '#4ade80' } });

        // The rule is the T3 instruction rule, restated for colors: a patch that changes
        // what the factory captures cannot keep the offline script.
        expect(recolored.template).toBe('live');
        expect(recolored.requiresEndpoint).toBe(true);
        expect(recolored.tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(recolored.create(SETTINGS, progress).agents.demo.color).toBe('#4ade80');
    });

    it('projects the map onto the descriptor only when the harness colors something', () => {
        const registry = createHarnessRegistry();

        // An untouched built-in carries no key at all, so every existing card keeps its
        // exact pre-R2 shape.
        expect(describeHarness(registry.find('instruct')!).agentColors).toBeUndefined();

        const colored = registry.create({
            name: 'carded',
            primary: 'instruct',
            agentColors: { instruct: '#4ade80' }
        });
        expect(describeHarness(colored).agentColors).toEqual({ instruct: '#4ade80' });

        // Clearing every color removes the field from the card again.
        expect(
            describeHarness(registry.update('carded', { agentColors: {} })).agentColors
        ).toBeUndefined();

        // The descriptor copy is not the preset's own object: a caller holding a card
        // cannot repaint the registry entry through it.
        const card = describeHarness(colored);
        card.agentColors!.instruct = '#000000';
        expect(colored.agentColors).toEqual({ instruct: '#4ade80' });
    });

    it('round-trips through a durable record and replays it on restore', () => {
        const registry = createHarnessRegistry();
        const created = registry.create({
            name: 'saved',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { research: '#4ade80', summarizer: '#f97316' }
        });

        const record = presetToRecord(created);
        expect(record.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });

        // Rebuilding a preset from the record reproduces both the metadata and the
        // colored agents, and the record of the rebuilt entry compares equal — which is
        // what lets a restore skip an unmodified row.
        const rebuilt = presetFromRecord(record);
        expect(rebuilt.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });
        expect(rebuilt.create(SETTINGS, progress).agents.research.color).toBe('#4ade80');
        expect(presetRecordEquals(presetToRecord(rebuilt), record)).toBe(true);

        // A harness with no colors writes NO field, so a document saved before R2 keeps
        // its exact old byte shape (and a record without the field stays equal to itself).
        const bare = presetToRecord(registry.create({ name: 'bare', primary: 'research' }));
        expect(Object.hasOwn(bare, 'agentColors')).toBe(false);
        expect(presetRecordEquals(bare, bare)).toBe(true);
        expect(presetFromRecord({ ...bare, agentColors: undefined }).agentColors).toBeUndefined();

        // Restore replays the row through `update()`, so the colors reach the rebuilt
        // factory rather than being dropped as prose.
        const replay = createHarnessRegistry();
        restoreHarnessRegistry(replay, [record]);
        expect(replay.find('saved')!.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });
        expect(replay.find('saved')!.create(SETTINGS, progress).agents.summarizer.color).toBe('#f97316');
    });

    it('counts a saved color as a customisation of a built-in', () => {
        // The shipped-default refresh replays PROSE only, so a row that carries a color
        // must not be treated as an unmodified shipped default — the operator's swatch
        // would otherwise vanish on the next restart.
        const registry = createHarnessRegistry();
        const record = presetToRecord(
            registry.create({ name: 'colored', primary: 'research', subagents: ['summarizer'] })
        );

        // Same shape adjustment the instruction test above makes: the record is from THIS
        // build, so `environmentTools` is pinned to the legacy row's value and the color
        // map is the only variable under test.
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                agentColors: {}
            })
        ).toBe(true);

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                agentColors: { research: '#4ade80' }
            })
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R7: SESSION-DEFINED agents in the durable preset record.
//
// A harness DEFINITION never declares a custom agent — `HarnessRegistration`/`HarnessPatch` have
// no field for it — so the only writer of `customAgents` is a session's own frozen preset copy
// (./sessions.ts `applyBindingMaps`). The pieces a restore routes through must therefore hold
// here:
//   - `presetToRecord` writes the field ONLY when the map has an entry, so every document saved
//     before R7 (and every harness definition) keeps its exact old byte shape, and
//     `presetRecordEquals` does not treat an absent map as different from an empty one;
//   - `presetFromRecord` hands the map to the factory, so the rebuilt harness really CREATES the
//     invented brain (`agentsFromProfiles` → `agentConfigurationForCustom`: the stored base
//     verbatim, no profile lookup, no guidelines) while the catalogue members beside it keep
//     their trusted composed prompts;
//   - a saved custom roster is a CUSTOMISATION of a built-in row (the shipped-default refresh
//     replays prose only, so it must not silently drop the member), and an injected factory that
//     cannot build the invented member is REFUSED rather than restored with the agent missing.
// ---------------------------------------------------------------------------
describe('session-defined agents in the durable preset record (R7)', () => {
    const CUSTOM = 'localizer';
    const CUSTOM_BASE = 'You rewrite copy for the target market.';

    it('round-trips the custom agent map and rebuilds the invented agent from it', () => {
        const registry = createHarnessRegistry();
        const created = registry.create({
            name: 'owned',
            primary: 'research',
            subagents: ['summarizer']
        });

        // The shape a SESSION writes: the invented name joins `agents`/`subagents`, its model
        // joins `agentModels`, and its base text joins the new `customAgents` map.
        const withCustom: HarnessPreset = {
            ...created,
            subagents: [...created.subagents, CUSTOM],
            agents: [...created.agents, CUSTOM],
            agentModels: { ...created.agentModels, [CUSTOM]: 'small/fast' },
            agentColors: { ...created.agentColors, [CUSTOM]: '#22d3ee' },
            customAgents: { [CUSTOM]: CUSTOM_BASE }
        };

        const record = presetToRecord(withCustom);

        expect(record.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(record.agentModels).toEqual({ [CUSTOM]: 'small/fast' });
        expect(record.agents).toEqual(['research', 'summarizer', CUSTOM]);

        const rebuilt = presetFromRecord(record);

        expect(rebuilt.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(rebuilt.agents).toEqual(['research', 'summarizer', CUSTOM]);

        const harness = rebuilt.create(SETTINGS, progress);

        // All three members exist, including the one no profile describes.
        expect(Object.keys(harness.agents).sort()).toEqual(
            ['research', 'summarizer', CUSTOM].sort()
        );
        // THE point: the invented brain is built from its own stored text VERBATIM (no guideline
        // block, because there is no trusted profile to supply one) on its own model, and the
        // R2 swatch travels with it exactly like a catalogue member's.
        expect(harness.agents[CUSTOM].instructions).toEqual([CUSTOM_BASE]);
        expect(harness.agents[CUSTOM].model()).toBe('small/fast');
        expect(harness.agents[CUSTOM].color).toBe('#22d3ee');
        // A catalogue member beside it is untouched by the new branch: still the trusted prompt.
        expect(harness.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
        expect(harness.agents.summarizer.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.summarizer)
        ]);

        // The record of the rebuilt entry compares equal, which is what lets a restore skip an
        // unmodified row (`./sessions.ts` `restoreSession` uses the same comparison to decide
        // whether the frozen record or the live registry entry builds the harness).
        expect(presetRecordEquals(presetToRecord(rebuilt), record)).toBe(true);
    });

    it('writes no field without custom agents and keeps a pre-R7 record equal', () => {
        const registry = createHarnessRegistry();
        const bare = presetToRecord(registry.create({ name: 'plain', primary: 'research' }));

        // Absent, not `{}`: a document saved before R7 (or a harness definition) keeps its exact
        // old byte shape, so a later reader cannot invent a roster member.
        expect(Object.hasOwn(bare, 'customAgents')).toBe(false);
        expect(presetRecordEquals(bare, bare)).toBe(true);
        expect(presetFromRecord({ ...bare, customAgents: undefined }).customAgents).toBeUndefined();
        expect(
            Object.keys(presetFromRecord(bare).create(SETTINGS, progress).agents)
        ).toEqual(['research']);

        // Absent and empty are the same statement, so they compare equal to each other...
        expect(presetRecordEquals(bare, { ...bare, customAgents: {} })).toBe(true);

        // ...while a record that names an invented agent is a DIFFERENT roster. This is the
        // comparison that routes a saved session with custom agents through `presetFromRecord`
        // instead of the unchanged registry entry.
        expect(presetRecordEquals(bare, { ...bare, customAgents: { [CUSTOM]: CUSTOM_BASE } })).toBe(
            false
        );
    });

    it('counts a saved custom agent as a customisation of a built-in', () => {
        // The shipped-default refresh replays PROSE only, so a row carrying a custom roster must
        // not be mistaken for an unmodified shipped default — the invented member would vanish on
        // the next restart while its sessions still name it.
        const registry = createHarnessRegistry();
        const record = presetToRecord(
            registry.create({ name: 'invented', primary: 'research', subagents: ['summarizer'] })
        );
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                customAgents: {}
            })
        ).toBe(true);

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                customAgents: { [CUSTOM]: CUSTOM_BASE }
            })
        ).toBe(false);
    });

    it('refuses an injected factory that cannot build the saved custom agent', () => {
        // An injected preset (no `template`) rebuilds only from a factory the caller hands back,
        // so a saved roster naming an agent that factory has no way to create is an ERROR, not a
        // session that silently loses a member. (`assertDurableRoster` in ./api.ts is why a real
        // session never gets here: a template-less binding is refused with 409 up front.)
        const injected: HarnessPreset = {
            name: 'injected',
            title: 'Injected',
            description: 'A host-supplied factory with no template hint.',
            requiresEndpoint: false,
            primary: 'instruct',
            subagents: [],
            agents: ['instruct'],
            tools: [],
            builtin: false,
            editable: true,
            create: () => {
                throw new Error('never built in this case');
            }
        };

        const record = presetToRecord(injected);

        expect(presetFromRecord(record, injected).name).toBe('injected');

        expect(() =>
            presetFromRecord({ ...record, customAgents: { [CUSTOM]: CUSTOM_BASE } }, injected)
        ).toThrow('changed incompatibly');
    });
});
