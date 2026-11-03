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
import type { HarnessProgress } from '../../harness';
import type { HarnessPreset } from './types';
import type { HarnessRegistry } from './registry';
import {
    createHarnessRegistry,
    isLegacyShippedDefinition,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord
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
