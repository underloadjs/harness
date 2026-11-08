// Restore policy for saved registry rows (T3).
//
// A restart replays the registry rows saved in state.json. That is right for a row
// the operator created or customised, but wrong for a row that is merely a copy of
// an older build's SHIPPED default: replaying it would pin the old roster forever.
//
// The policy under test is conservative and provable:
//   - an unmodified shipped row (executable fields == LEGACY_PRESET_DEFINITIONS) is
//     refreshed to the current template;
//   - a row with ANY executable difference (team, tools, environment tools,
//     template, or a non-empty agentModels map) is replayed exactly as saved;
//   - an edited title/description survives a refresh;
//   - the fixtures keep their scripted/flaky templates (they have no legacy entry,
//     so they replay through the normal metadata-only path);
//   - a FROZEN session is unaffected: it rebuilds from its own record, so it keeps
//     the team it started with even when the registry entry was refreshed.
//
// Assertions are exact: registry rows are compared as complete records, not by
// individual fields, so an accidental extra change is a failure.

import { describe, expect, it } from 'vitest';
import type { HarnessProgress } from '../../harness';
import type { HarnessPresetRecord } from '../persistence';
import {
    ALL_PRESET_TEMPLATES,
    createHarnessRegistry,
    LEGACY_PRESET_DEFINITIONS,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord,
    presets,
    restoreHarnessRegistry,
    teamOf
} from './index';

const SETTINGS = { baseURL: 'http://provider.test/v1', apiKey: 'server-secret', model: 'test-model' };
const progress: HarnessProgress = async () => undefined;

const shipped = (name: string) => {
    // T5: demo and flaky are no longer in `presets`, but a saved row for them still
    // describes what an OLDER build shipped, and this helper builds exactly those
    // rows. The superset is the honest source for "what any build of this package
    // has shipped", which is also what `presetFromRecord` uses for a scripted row.
    const preset = ALL_PRESET_TEMPLATES.find((candidate) => candidate.name === name);
    if (preset === undefined) throw new Error(`Missing shipped preset "${name}".`);
    return preset;
};

// Build the exact record an older build would have persisted for a shipped preset:
// the current record shape with the recorded legacy EXECUTABLE definition merged in.
const legacyRecord = (
    name: string,
    overrides: Partial<HarnessPresetRecord> = {}
): HarnessPresetRecord => {
    const definition = LEGACY_PRESET_DEFINITIONS[name];
    if (definition === undefined) throw new Error(`Missing legacy definition "${name}".`);

    return {
        ...presetToRecord(shipped(name)),
        title: definition.title,
        description: definition.description,
        requiresEndpoint: definition.requiresEndpoint,
        primary: definition.primary,
        subagents: [...definition.subagents],
        agents: [...definition.agents],
        tools: [...definition.tools],
        ...(definition.environmentTools === undefined
            ? {}
            : { environmentTools: [...definition.environmentTools] }),
        ...(definition.template === undefined ? {} : { template: definition.template }),
        ...overrides
    };
};

describe('restoreHarnessRegistry — shipped defaults vs customisations', () => {
    it('refreshes an unmodified shipped row to the current template', () => {
        const registry = createHarnessRegistry();

        // The pre-T3 row: one agent, no subagents, the old title.
        restoreHarnessRegistry(registry, [legacyRecord('instruct')]);

        const refreshed = registry.find('instruct');
        expect(refreshed).toBeDefined();
        expect(presetToRecord(refreshed!)).toEqual(presetToRecord(shipped('instruct')));

        // The concrete point of the refresh: the wider team is live, so delegation
        // works in the restored entry.
        expect(refreshed?.subagents).toEqual(teamOf('instruct'));
        expect(refreshed?.title).toBe('Instruct');
        expect(
            Object.keys(refreshed!.create(SETTINGS, progress).tools)
        ).toContain('delegate');
    });

    it('refreshes every real preset whose saved row is an unmodified shipped default', () => {
        const registry = createHarnessRegistry();

        restoreHarnessRegistry(registry, [
            legacyRecord('instruct'),
            legacyRecord('research'),
            legacyRecord('workspace')
        ]);

        expect(
            ['instruct', 'research', 'workspace'].map((name) => presetToRecord(registry.find(name)!))
        ).toEqual(
            ['instruct', 'research', 'workspace'].map((name) => presetToRecord(shipped(name)))
        );
    });

    it('does not touch an entry whose saved row already equals the current template', () => {
        const registry = createHarnessRegistry();
        const before = registry.find('planner');

        restoreHarnessRegistry(registry, [presetToRecord(shipped('planner'))]);

        // Identity, not just equality: nothing was rebuilt.
        expect(registry.find('planner')).toBe(before);
    });

    it('replays a customised built-in row exactly as saved', () => {
        const registry = createHarnessRegistry();

        // A deliberate customisation of an otherwise-legacy row: the operator chose
        // a smaller team. It must NOT be widened by the refresh.
        restoreHarnessRegistry(registry, [
            legacyRecord('instruct', {
                title: 'Instruct (mine)',
                subagents: ['summarizer'],
                agents: ['instruct', 'summarizer']
            })
        ]);

        const current = registry.find('instruct')!;
        expect(current.title).toBe('Instruct (mine)');
        expect(current.subagents).toEqual(['summarizer']);
        expect(current.agents).toEqual(['instruct', 'summarizer']);
        expect(presetRecordEquals(presetToRecord(current), legacyRecord('instruct'))).toBe(false);
    });

    it('keeps an edited title and description across an executable refresh', () => {
        const registry = createHarnessRegistry();

        restoreHarnessRegistry(registry, [
            legacyRecord('workspace', {
                title: 'My coder',
                description: 'House coding harness.'
            })
        ]);

        const current = registry.find('workspace')!;
        // Prose the operator wrote survives...
        expect(current.title).toBe('My coder');
        expect(current.description).toBe('House coding harness.');
        // ...while the shipped executable default (the wider team) is adopted.
        expect(current.subagents).toEqual(teamOf('workspace'));
        expect(current.agents).toEqual(['workspace', ...teamOf('workspace')]);
    });

    it('treats a per-agent model map as a customisation, not a shipped default', () => {
        const registry = createHarnessRegistry();

        restoreHarnessRegistry(registry, [
            legacyRecord('instruct', {
                agentModels: { instruct: 'small/fast' }
            })
        ]);

        const current = registry.find('instruct')!;
        expect(current.subagents).toEqual([]);
        expect(current.agentModels).toEqual({ instruct: 'small/fast' });
        expect(current.title).toBe('Instruct');
    });

    it('leaves the fixtures on their own templates with their edited metadata', () => {
        // T5: a host that WANTS the fixtures injects them, and then a saved row for
        // one replays through the normal metadata-only path (no legacy entry exists
        // for a fixture, so it is always treated as a customisation of its template).
        const registry = createHarnessRegistry(ALL_PRESET_TEMPLATES);
        const demo = presetToRecord(shipped('demo'));
        const flaky = presetToRecord(shipped('flaky'));

        restoreHarnessRegistry(registry, [
            { ...demo, title: 'Scripted demo (mine)' },
            { ...flaky, description: 'Failure drill.' }
        ]);

        const restoredDemo = registry.find('demo')!;
        expect(restoredDemo.title).toBe('Scripted demo (mine)');
        expect(restoredDemo.template).toBe('scripted');
        // The scripted factory (timeNow only) is still what this entry runs.
        expect(Object.keys(restoredDemo.create(SETTINGS, progress).tools)).toEqual([
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
            'agentResult',
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);

        const restoredFlaky = registry.find('flaky')!;
        expect(restoredFlaky.description).toBe('Failure drill.');
        expect(restoredFlaky.template).toBe('flaky');
        expect(Object.keys(restoredFlaky.create(SETTINGS, progress).tools)).toContain('testFlaky');
    });

    it('a frozen session still rebuilds from its own record after the refresh', () => {
        // The old session's frozen preset: legacy instruct (no subagents).
        const record = legacyRecord('instruct');
        const frozen = presetFromRecord(record);
        const harness = frozen.create(SETTINGS, progress);

        // It keeps the team it started with, so nothing it recorded becomes
        // unreachable and no new agent is silently introduced.
        expect(Object.keys(harness.agents)).toEqual(['instruct']);
        expect(Object.keys(harness.subagents)).toEqual([]);
        expect(harness.tools.delegate).toBeUndefined();

        // The registry, meanwhile, has moved on (the refresh above).
        const registry = createHarnessRegistry();
        restoreHarnessRegistry(registry, [record]);
        expect(registry.find('instruct')?.subagents).toEqual(teamOf('instruct'));
    });
});

// Durable deletions (T5): the third input is the list of built-ins the operator
// removed, persisted as `deleted` beside the rows. A restart replays it BEFORE the
// rows, so this build's shipped copy of a deleted default is gone before the record
// loop can compare or patch it.
describe('restoreHarnessRegistry — durable deletions (T5)', () => {
    it('keeps a deleted built-in deleted even though the build ships it again', () => {
        const registry = createHarnessRegistry();

        restoreHarnessRegistry(registry, [], ['workspace']);

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'reviewer',
            'planner'
        ]);
        expect(registry.find('workspace')).toBeUndefined();

        // The tombstone survives the replay, so the next save still carries it.
        expect(registry.deletedBuiltins()).toEqual(['workspace']);
    });

    it('ignores a stale row for the deleted built-in instead of resurrecting it', () => {
        const registry = createHarnessRegistry();

        // An older document wrote a row for `workspace` before it was deleted; the
        // deletion is the newer decision, so the row must not bring the card back.
        restoreHarnessRegistry(registry, [presetToRecord(shipped('workspace'))], ['workspace']);

        expect(registry.find('workspace')).toBeUndefined();
        expect(registry.deletedBuiltins()).toEqual(['workspace']);
    });

    it('replays the other rows normally around a deletion', () => {
        const registry = createHarnessRegistry();

        restoreHarnessRegistry(registry, [legacyRecord('instruct')], ['research']);

        // The unmodified shipped default is refreshed (T3 policy, untouched by this),
        // while the deleted one is gone.
        expect(registry.find('instruct')?.subagents).toEqual(teamOf('instruct'));
        expect(registry.find('research')).toBeUndefined();
        expect(registry.find('researcher')).toBeUndefined();
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'workspace',
            'reviewer',
            'planner'
        ]);
    });

    it('lets a saved row that takes the deleted name win, clearing the tombstone', () => {
        const registry = createHarnessRegistry();

        // The operator deleted `workspace` and then created their own harness under
        // that name: the document holds a builtin:false row for it and NO tombstone.
        // A hand-edited document that carries both is resolved the same way — the row
        // is the newer decision.
        restoreHarnessRegistry(registry, [
            {
                ...presetToRecord(shipped('reviewer')),
                name: 'workspace',
                title: 'My coder',
                builtin: false
            }
        ], ['workspace']);

        const restored = registry.find('workspace');
        expect(restored).toBeDefined();
        expect(restored?.title).toBe('My coder');
        expect(registry.deletedBuiltins()).toEqual([]);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'reviewer',
            'planner',
            'workspace'
        ]);
    });

    it('does not resurrect a fixture an older build shipped (demo)', () => {
        const registry = createHarnessRegistry();

        // A pre-T5 document contains demo as a BUILT-IN row. This build does not ship
        // it, and a built-in row never creates an entry — otherwise the fixture would
        // quietly reappear in the production catalogue.
        restoreHarnessRegistry(registry, [presetToRecord(shipped('demo'))]);

        expect(registry.find('demo')).toBeUndefined();
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(registry.deletedBuiltins()).toEqual([]);
    });

    it('still rebuilds a frozen scripted session for a fixture that left the catalogue', () => {
        // The other half of the same story: the CARD is gone, but a conversation
        // recorded while it existed has to restore. `presetFromRecord` resolves a
        // 'scripted' record through ALL_PRESET_TEMPLATES (the shipped-catalogue
        // lookup alone would throw).
        const record = presetToRecord(shipped('demo'));
        expect(record.template).toBe('scripted');

        const preset = presetFromRecord(record);
        expect(preset.name).toBe('demo');
        expect(preset.template).toBe('scripted');
        expect(preset.requiresEndpoint).toBe(false);

        const offline = preset.create(SETTINGS, progress);
        expect(Object.keys(offline.agents)).toEqual(['demo']);

        // No registry entry is involved: this is how an old demo conversation keeps
        // its transcript and its reported harness after the row disappears.
        expect(createHarnessRegistry().find('demo')).toBeUndefined();
    });

    it('refuses a scripted record this build cannot rebuild at all', () => {
        // Honest failure for a fixture that is NOT shipped in any form: the session
        // cannot be restored, and inventing a live harness in its place would change
        // what the transcript means.
        expect(() =>
            presetFromRecord({ ...presetToRecord(shipped('demo')), name: 'long-gone' })
        ).toThrowError(
            'Scripted harness "long-gone" is not shipped in this build; the session cannot be restored.'
        );
    });
});
