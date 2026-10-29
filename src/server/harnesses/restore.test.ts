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
    const preset = presets.find((candidate) => candidate.name === name);
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
        ).toContain('agentDelegate');
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
        const registry = createHarnessRegistry();
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
            'timeNow',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage'
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
        expect(harness.tools.agentDelegate).toBeUndefined();

        // The registry, meanwhile, has moved on (the refresh above).
        const registry = createHarnessRegistry();
        restoreHarnessRegistry(registry, [record]);
        expect(registry.find('instruct')?.subagents).toEqual(teamOf('instruct'));
    });
});
