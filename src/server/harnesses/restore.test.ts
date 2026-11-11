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
//
// AGENT ROSTER / ROLE-CONTRACT PASS (what the assertions below re-pinned)
// ----------------------------------------------------------------------
// `LEGACY_PRESET_DEFINITIONS` was deliberately NOT extended for this pass: it still
// holds the three pre-T3 snapshots (`instruct`, `research`, `workspace`) with their OLD
// titles (Instruct / Research / Workspace (coding)) and `environmentTools: ['search']`.
// Consequences pinned here:
//   - an install holding a pre-T3 row still matches its snapshot, so it refreshes to the
//     CURRENT template — which now carries the new roster (the Manager is out of every
//     built-in team) and the new titles (Explore / Analyst / Manager);
//   - an install holding the T3 row matches neither its single legacy snapshot nor the
//     current template, so it is an operator customisation and replays verbatim — legal,
//     because every id in that old 5-role team is still a known profile;
//   - an edited title/description survives a refresh;
//   - an older document has no rows for the two new cards, and they ship anyway.

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
import { SHARED_TOOL_NAMES } from './toolbox';
import { PRODUCTION_WITH_FIXTURES, SCRIPTED_FIXTURE } from './fixture-presets.test-support';

const SETTINGS = { baseURL: 'http://provider.test/v1', apiKey: 'server-secret', model: 'test-model' };
const progress: HarnessProgress = async () => undefined;

const shipped = (name: string) => {
    // T5: demo and flaky are no longer in `presets`, but a saved row for them still
    // describes what an OLDER build shipped, and this helper builds exactly those
    // rows. The superset is the honest source for "what any build of this package
    // has shipped", which is also what `presetFromRecord` uses for a scripted row.
    const preset = PRODUCTION_WITH_FIXTURES.find((candidate) => candidate.name === name);
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
        // works in the restored entry. This is `teamOf('instruct')` as the roster pass
        // ships it — every OTHER live role (now including the two new profiles, `general`
        // and `debugger`) minus the Manager, plus the summarizer.
        expect(refreshed?.subagents).toEqual([
            'general',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        expect(refreshed?.agents).toEqual([
            'instruct',
            'general',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        // `instruct` kept its title across the pass, so the refresh has no prose to carry.
        expect(refreshed?.title).toBe('Instruct');
        expect(
            Object.keys(refreshed!.create(SETTINGS, progress).tools)
        ).toContain('delegate');
    });

    it('derives every built-in team from the 7 live roles, excluding the Manager', () => {
        // `teamOf` is the ONE list the shipped teams come from (presets.ts:133-164). Two
        // ids never appear in another card's allowlist: the primary itself, and `planner`
        // — the Manager refuses to run as a delegate, so offering it would burn a child
        // run. `summarizer` is appended everywhere so the `textSummarize` path works.
        expect([
            teamOf('general'),
            teamOf('instruct'),
            teamOf('research'),
            teamOf('workspace'),
            teamOf('reviewer'),
            teamOf('planner'),
            teamOf('debugger')
        ]).toEqual([
            ['instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer']
        ]);

        // The shipped rows agree with it, and the default card is the one deliberate
        // exception: `general` runs alone, so `delegate` is never registered for it.
        const registry = createHarnessRegistry();
        expect(
            ['general', 'instruct', 'research', 'workspace', 'reviewer', 'planner', 'debugger'].map(
                (name) => registry.find(name)!.subagents
            )
        ).toEqual([
            [],
            ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            ['general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer']
        ]);
        expect(Object.keys(registry.find('general')!.create(SETTINGS, progress).subagents)).toEqual([]);
        expect(registry.find('general')!.create(SETTINGS, progress).tools.delegate).toBeUndefined();
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

        // THE title consequence of the roster pass: a row still holding the OLD shipped
        // title (`Research`, `Workspace (coding)`) is shipped text, not operator prose, so
        // the refresh adopts the new card titles while the ids stay as saved.
        expect(
            ['instruct', 'research', 'workspace'].map((name) => registry.find(name)!.title)
        ).toEqual(['Instruct', 'Explore', 'Analyst']);
        expect(LEGACY_PRESET_DEFINITIONS.research.title).toBe('Research');
        expect(LEGACY_PRESET_DEFINITIONS.workspace.title).toBe('Workspace (coding)');

        // The refreshed rows run the current roster, and the Manager is nowhere in another
        // card's allowlist.
        expect(registry.find('research')!.subagents).toEqual([
            'general',
            'instruct',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        expect(registry.find('workspace')!.subagents).toEqual([
            'general',
            'instruct',
            'research',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
    });

    it('adds the two new cards to an installation whose saved document predates them', () => {
        const registry = createHarnessRegistry();

        // An old document holds rows only for the cards it shipped. Nothing tombstones
        // `general` or `debugger`, so both new defaults are simply present next to the
        // refreshed rows.
        restoreHarnessRegistry(registry, [
            legacyRecord('instruct'),
            legacyRecord('research'),
            legacyRecord('workspace')
        ]);

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(registry.deletedBuiltins()).toEqual([]);
        expect(registry.find('general')).toBeDefined();
        expect(registry.find('debugger')).toBeDefined();
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
        // ...while the shipped executable default is adopted: the current team, which is
        // every other live role except the Manager plus the summarizer.
        expect(current.subagents).toEqual([
            'general',
            'instruct',
            'research',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        expect(current.agents).toEqual([
            'workspace',
            'general',
            'instruct',
            'research',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
    });

    it('carries only prose the operator actually wrote, and adopts the rest', () => {
        // A saved field that still EQUALS the legacy shipped text is the shipped text, so the
        // new template's wording wins (registry.ts:1063-1065). A saved field that matches
        // neither snapshot is operator prose and is re-applied over the refreshed row.
        const editedTitleOnly = createHarnessRegistry();
        restoreHarnessRegistry(editedTitleOnly, [legacyRecord('workspace', { title: 'My coder' })]);

        expect(editedTitleOnly.find('workspace')!.title).toBe('My coder');
        // The description in that row is still `LEGACY_PRESET_DEFINITIONS.workspace.description`,
        // so the refresh replaces it with the current card's text.
        expect(editedTitleOnly.find('workspace')!.description).toBe(
            shipped('workspace').description
        );
        expect(editedTitleOnly.find('workspace')!.description).not.toBe(
            LEGACY_PRESET_DEFINITIONS.workspace.description
        );

        // Nothing edited: both fields follow the new template — including the retitled card.
        const untouched = createHarnessRegistry();
        restoreHarnessRegistry(untouched, [legacyRecord('workspace')]);
        expect(untouched.find('workspace')!.title).toBe('Analyst');
        expect(untouched.find('workspace')!.description).toBe(shipped('workspace').description);
    });

    it('replays a T3-era row (the old 5-role team) verbatim instead of refreshing it', () => {
        // The T3 row no longer matches its single legacy snapshot (`subagents` moved) and it
        // is not the current template either, so the policy treats it as a customisation and
        // replays it exactly. That is SAFE because every id in that team is still a known
        // profile — the roster pass changed titles and added profiles, never renamed one.
        const OLD_TEAM = ['research', 'workspace', 'reviewer', 'planner', 'summarizer'];
        const t3Row: HarnessPresetRecord = {
            ...presetToRecord(shipped('instruct')),
            title: 'Instruct',
            subagents: [...OLD_TEAM],
            agents: ['instruct', ...OLD_TEAM]
        };

        const registry = createHarnessRegistry();
        restoreHarnessRegistry(registry, [t3Row]);

        const current = registry.find('instruct')!;
        expect(current.title).toBe('Instruct');
        expect(current.subagents).toEqual(OLD_TEAM);
        expect(current.agents).toEqual(['instruct', ...OLD_TEAM]);
        // The saved row is reproduced exactly, so the next save cannot drift it.
        expect(presetRecordEquals(presetToRecord(current), t3Row)).toBe(true);

        // Restore did not merely keep the metadata: the rebuilt harness really runs that
        // roster, Manager included, because each id still resolves to a trusted profile.
        const harness = current.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['instruct', ...OLD_TEAM]);
        expect(Object.keys(harness.subagents)).toEqual(OLD_TEAM);
        expect(harness.tools.delegate.visibility).toBe('core');
        expect(OLD_TEAM.filter((id) => !registry.agents().some((p) => p.name === id))).toEqual([]);

        // The same guarantee on the session side: a frozen record from that build rebuilds
        // through `presetFromRecord` with the team it started with.
        const frozen = presetFromRecord(t3Row).create(SETTINGS, progress);
        expect(Object.keys(frozen.agents)).toEqual(['instruct', ...OLD_TEAM]);
        expect(Object.keys(frozen.subagents)).toEqual(OLD_TEAM);
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
        const registry = createHarnessRegistry(PRODUCTION_WITH_FIXTURES);
        const demo = presetToRecord(shipped('demo'));
        const flaky = presetToRecord(shipped('flaky'));

        restoreHarnessRegistry(registry, [
            { ...demo, title: 'Scripted fixture (mine)' },
            { ...flaky, description: 'Failure drill.' }
        ]);

        const restoredDemo = registry.find('demo')!;
        expect(restoredDemo.title).toBe('Scripted fixture (mine)');
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

        // A saved 'flaky' row carries executable fields, so the replay goes through the
        // executable patch path and REBUILDS the factory — which is where the honest
        // consequence of the deletion shows up. The template survives (the entry still
        // routes through createToolboxHarness), but the example tool it used to re-attach
        // came from `src/server/tools/examples`, and this build does not ship that folder.
        // The declaration drops with the factory, so the card never advertises a tool the
        // session cannot call. A metadata-only replay keeps the captured factory and its
        // testFlaky — pinned in ./registry.test.ts.
        const restoredFlaky = registry.find('flaky')!;
        expect(restoredFlaky.description).toBe('Failure drill.');
        expect(restoredFlaky.template).toBe('flaky');
        expect(restoredFlaky.tools).toEqual([...SHARED_TOOL_NAMES]);

        const flakyTools = Object.keys(restoredFlaky.create(SETTINGS, progress).tools);
        expect(flakyTools).not.toContain('testFlaky');
        expect(flakyTools).toContain('read');
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

        // The registry, meanwhile, has moved on (the refresh above): the current shipped
        // team, Manager excluded.
        const registry = createHarnessRegistry();
        restoreHarnessRegistry(registry, [record]);
        expect(registry.find('instruct')?.subagents).toEqual([
            'general',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
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
            'general',
            'instruct',
            'research',
            'reviewer',
            'planner',
            'debugger',
            'chat'
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
        expect(registry.find('instruct')?.subagents).toEqual([
            'general',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        expect(registry.find('research')).toBeUndefined();
        // The alias follows its target, so `researcher` is gone with it.
        expect(registry.find('researcher')).toBeUndefined();
        // The remaining catalogue, in shipped order, with the tombstoned Explore absent.
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
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
            'general',
            'instruct',
            'research',
            'reviewer',
            'planner',
            'debugger',
            'chat',
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
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(registry.deletedBuiltins()).toEqual([]);
    });

    it('rebuilds a frozen scripted session from the injected template the host still has', () => {
        // The other half of the same story: the CARD is not shipped, but a conversation
        // recorded against it restores — provided the host still injects the scripted
        // preset, which is the only place a scripted factory can come from now that no
        // shipped template is scripted. `sessions.ts` passes exactly this: the registry's
        // current entry for the name, as `fallback`.
        const record = presetToRecord(shipped('demo'));
        expect(record.template).toBe('scripted');

        const preset = presetFromRecord(record, SCRIPTED_FIXTURE);
        expect(preset.name).toBe('demo');
        expect(preset.template).toBe('scripted');
        expect(preset.requiresEndpoint).toBe(false);

        const offline = preset.create(SETTINGS, progress);
        // The agent key is the real `general` role, not `demo`: the preset name is the
        // harness identity, the agent name is a profile this build ships.
        expect(Object.keys(offline.agents)).toEqual(['general']);

        // A DEFAULT registry has no such entry: the scripted factory exists only because
        // a host put it there.
        expect(createHarnessRegistry().find('demo')).toBeUndefined();
    });

    it('refuses a scripted record this build cannot rebuild at all', () => {
        // Honest failure for a scripted harness with no injected template: the session
        // cannot be restored, and inventing a live harness in its place would change what
        // the transcript means (the saved turns were produced without a provider).
        //
        // This is the case the deleted `demo` preset used to answer from a shipped
        // superset. With the superset gone, a name the host has not injected — or an entry
        // that is no longer scripted — is the error.
        expect(() => presetFromRecord(presetToRecord(shipped('demo')))).toThrowError(
            'Scripted harness "demo" is not shipped in this build; the session cannot be restored.'
        );

        // A same-named but non-scripted fallback is a different harness, not a rebuild.
        expect(() =>
            presetFromRecord(presetToRecord(shipped('demo')), PRODUCTION_WITH_FIXTURES.find((p) => p.name === 'general'))
        ).toThrowError('Scripted harness "demo" is not shipped in this build; the session cannot be restored.');
    });
});
