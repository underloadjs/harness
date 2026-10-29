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

import { describe, expect, it } from 'vitest';
import type { HarnessProgress } from '../../harness';
import type { HarnessPreset } from './types';
import { createHarnessRegistry } from './registry';
import { describeHarness } from './descriptor';
import { presets } from './presets';
import { SHARED_TOOL_NAMES } from './toolbox';
import { AGENT_PROFILE_NAMES } from '../../agents';

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
            { name: 'planner', builtin: true, editable: true },
            { name: 'demo', builtin: true, editable: true },
            { name: 'flaky', builtin: true, editable: true }
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
            environmentTools: ['webSearch'],
            builtin: false,
            editable: true
        });

        // It is a real harness: same agents, same registry, and delegate exists
        // exactly because there is a subagent.
        const harness = preset.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['research', 'summarizer']);
        expect(Object.keys(harness.subagents)).toEqual(['summarizer']);
        expect(harness.tools.agentDelegate.visibility).toBe('core');
        expect(Object.keys(harness.tools)).toEqual([
            ...SHARED_TOOL_NAMES,
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'agentDelegate',
            'threadFork'
        ]);

        // The registry lists it after the built-ins.
        expect(registry.list().map((entry) => entry.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'demo',
            'flaky',
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
        expect(preset.create(SETTINGS, progress).tools.agentDelegate).toBeUndefined();
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
        expect(harness.tools.agentDelegate.visibility).toBe('core');
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
        expect(after.create(SETTINGS, progress).tools.agentDelegate.visibility).toBe('core');
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
        const registry = createHarnessRegistry();

        // R20.1: no read-only category. A metadata-only patch is a 200 for the
        // formerly frozen demo/flaky templates too.
        expect(registry.update('demo', { title: 'Demo!' }).title).toBe('Demo!');
        expect(registry.update('flaky', { title: 'Flaky!' }).title).toBe('Flaky!');

        expect(registryError(() => registry.update('missing', { title: 'x' }))).toEqual({
            status: 404,
            message: 'Unknown harness "missing".'
        });
    });

    it('keeps the demo script and flaky extras through a metadata-only patch', () => {
        const registry = createHarnessRegistry();
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
        expect(flakyAfter.environmentTools).toEqual(['webSearch']);
        expect(flakyAfter.template).toBe('flaky');

        // The runtime really keeps them: these are the exact registered names.
        expect(Object.keys(demoAfter.create(SETTINGS, progress).tools)).toEqual([
            'timeNow',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork'
        ]);
        expect(Object.keys(flakyAfter.create(SETTINGS, progress).tools)).toContain('testFlaky');

        // The old objects are untouched; a session that captured them keeps the
        // shipped metadata too.
        expect(demoBefore.title).toBe('Scripted demo');
        expect(flakyBefore.title).toBe('Recoverable failures (example)');
    });

    it('upgrades the demo to an honest live profiled harness on an executable patch', () => {
        const registry = createHarnessRegistry();
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
        expect(after.environmentTools).toEqual(['webSearch']);
        expect(after.primary).toBe('workspace');
        expect(after.agents).toEqual(['workspace']);

        const live = after.create(SETTINGS, progress);
        expect(Object.keys(live.agents)).toEqual(['workspace']);
        expect(Object.keys(live.tools)).toEqual(
            expect.arrayContaining([...SHARED_TOOL_NAMES, 'toolRequest', 'toolCreate', 'todoManage'])
        );

        // The captured scripted harness is unchanged (frozen-session guarantee).
        expect(Object.keys(scripted.agents)).toEqual(['demo']);
        expect(Object.keys(scripted.tools)).toEqual([
            'timeNow',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork'
        ]);
    });

    it('rebuilds flaky live and retains testFlaky on an executable patch', () => {
        const registry = createHarnessRegistry();

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
