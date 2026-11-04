// T19: the global agent-override layer, as a unit (no HTTP, no store).
//
// Pinned exactly:
//   - a merge never writes into the frozen catalogue, and an unchanged profile is returned as
//     a COPY (so a caller holding one cannot write back through it);
//   - a stated field replaces, an explicit removal restores the shipped value, and an override
//     that equals the shipped value is dropped rather than recorded;
//   - retirement removes a profile from selection without erasing the shipped text, and the
//     durable record order is stable;
//   - the value rules (blank / too long / control characters / wrong kind) are visible 400s
//     naming the field, and an unknown or retired id is a 404;
//   - snapshot/restore is a whole-layer rollback, which is what makes a failed durable write a
//     no-op for the agent catalogue too;
//   - the durable file (`<root>/harness/agents.json`) round-trips, is absent-safe, and reports a
//     corrupt document loudly instead of falling back to the shipped catalogue.
//
// Cross-references:
//   - ./agent-state.ts   — the layer
//   - ../persistence.ts  — `HarnessAgentRecord`, `read/writeHarnessAgentRecords`
//   - ../../../agents    — the trusted catalogue the layer must never mutate

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentProfile, agentProfiles } from '../../agents';
import {
    AgentStateError,
    attachDefaultAgentState,
    createAgentState,
    defaultAgentState,
    effectiveAgentProfile
} from './agent-state';
import { HARNESS_AGENT_FILE, readHarnessAgentRecords, writeHarnessAgentRecords } from '../persistence';

const ROOT = path.join(process.cwd(), 'Temp', 't19');

// The layer behind `effectiveAgentProfile` is process state on purpose (a captured harness
// factory has no registry to ask). Every case installs a FRESH layer so a leaked decision from
// one case cannot change another case's answer.
beforeEach(() => {
    attachDefaultAgentState(createAgentState());
});

const instruct = () => agentProfile('instruct');

describe('createAgentState overlay resolution', () => {
    it('starts identical to the trusted catalogue, and hands out copies', () => {
        const state = createAgentState();

        expect(state.profiles().map((profile) => profile.name)).toEqual(
            agentProfiles().map((profile) => profile.name)
        );
        expect(state.profiles()[0]).toEqual(agentProfiles()[0]);
        expect(state.overridesOf('instruct')).toEqual({});
        expect(state.retired()).toEqual([]);
        expect(state.records()).toEqual([]);

        // Mutating a returned profile cannot reach the shipped object (the "no unsafe global
        // object mutation" rule this layer exists to keep).
        const copy = state.effective('instruct')!;

        copy.title = 'written through';

        expect(agentProfile('instruct').title).toBe(instruct().title);
    });

    it('replaces a stated field and restores it when the field is removed', () => {
        const state = createAgentState();

        const patched = state.patch('instruct', { title: 'Generalist', description: 'Short prose.' });

        expect(patched.title).toBe('Generalist');
        expect(patched.description).toBe('Short prose.');
        // Untouched fields keep the shipped text.
        expect(patched.instruction).toBe(instruct().instruction);
        expect(patched.guidelines).toEqual(instruct().guidelines);
        expect(state.overridesOf('instruct')).toEqual({ title: 'Generalist', description: 'Short prose.' });

        const restored = state.patch('instruct', { title: null });

        expect(restored.title).toBe(instruct().title);
        expect(state.overridesOf('instruct')).toEqual({ description: 'Short prose.' });

        // Replacing the bullet list wholesale, including with none at all.
        expect(state.patch('instruct', { guidelines: [] }).guidelines).toEqual([]);
        expect(state.overridesOf('instruct').guidelines).toEqual([]);
    });

    it('drops an override that equals the shipped value instead of recording a decision', () => {
        const state = createAgentState();

        state.patch('instruct', { title: 'Temporary' });

        const back = state.patch('instruct', { title: instruct().title });

        expect(back.title).toBe(instruct().title);
        expect(state.overridesOf('instruct')).toEqual({});
        expect(state.records()).toEqual([]);
    });

    it('retires a profile from selection without losing the shipped text', () => {
        const state = createAgentState();

        expect(state.isKnown('summarizer')).toBe(true);

        expect(state.retire('summarizer')).toBe('summarizer');

        expect(state.isKnown('summarizer')).toBe(false);
        expect(state.effective('summarizer')).toBeUndefined();
        expect(state.profiles().map((profile) => profile.name)).not.toContain('summarizer');
        expect(state.retired()).toEqual(['summarizer']);
        // The shipped entry is still resolvable, because retirement is a selection rule and the
        // text an existing session runs still came from somewhere.
        expect(state.shipped('summarizer')!.instruction).toBe(agentProfile('summarizer').instruction);
        // The record states the tombstone and nothing else.
        expect(state.records()).toEqual([{ name: 'summarizer', retired: true }]);
    });

    it('keeps record order stable in first-decision order', () => {
        const state = createAgentState();

        state.retire('flaky');
        state.patch('instruct', { title: 'First prose' });
        state.retire('demo');
        state.patch('instruct', { description: 'More prose' });

        expect(state.records()).toEqual([
            { name: 'flaky', retired: true },
            { name: 'instruct', title: 'First prose', description: 'More prose' },
            { name: 'demo', retired: true }
        ]);
    });

    it('rolls the whole layer back from its snapshot', () => {
        const state = createAgentState();
        const captured = state.snapshot();

        state.patch('instruct', { instruction: 'Changed.' });
        state.retire('summarizer');

        expect(state.effective('instruct')!.instruction).toBe('Changed.');

        state.restoreSnapshot(captured);

        expect(state.effective('instruct')!.instruction).toBe(instruct().instruction);
        expect(state.isKnown('summarizer')).toBe(true);
        expect(state.records()).toEqual([]);
    });
});

describe('createAgentState validation', () => {
    const refused = (run: () => unknown): { status: number; message: string } => {
        try {
            run();
        } catch (error) {
            if (error instanceof AgentStateError) return { status: error.status, message: error.message };

            throw error;
        }

        throw new Error('Expected the patch to be refused.');
    };

    it('names the field for every value rule', () => {
        const state = createAgentState();

        expect(refused(() => state.patch('instruct', { title: '   ' }))).toEqual({
            status: 400,
            message: '`agent.title` cannot be empty. Send null to restore the shipped value.'
        });

        expect(refused(() => state.patch('instruct', { description: 'x'.repeat(2_001) })).status).toBe(400);

        expect(
            refused(() => state.patch('instruct', { description: 'x'.repeat(2_001) })).message
        ).toBe('`agent.description` cannot exceed 2000 characters.');

        expect(refused(() => state.patch('instruct', { instruction: 'a\u0000b' })).message).toBe(
            '`agent.instruction` contains control characters.'
        );

        expect(refused(() => state.patch('instruct', { guidelines: 'not-a-list' as never })).message).toBe(
            '`agent.guidelines` must be an array of strings or null.'
        );

        expect(refused(() => state.patch('instruct', { guidelines: ['ok', '  '] })).message).toBe(
            '`agent.guidelines[1]` cannot be empty. Send null to restore the shipped value.'
        );

        // A refusal never touched the layer.
        expect(state.overridesOf('instruct')).toEqual({});
    });

    it('answers 404 for an unknown id, a retired id, and a repeat retire', () => {
        const state = createAgentState();

        expect(refused(() => state.patch('nope', { title: 'X' }))).toEqual({
            status: 404,
            message: 'Unknown agent "nope".'
        });

        state.retire('demo');

        expect(refused(() => state.patch('demo', { title: 'X' }))).toEqual({
            status: 404,
            message: 'Agent "demo" is retired; it is no longer part of the selectable catalogue.'
        });

        expect(refused(() => state.retire('demo'))).toEqual({
            status: 404,
            message: 'Agent "demo" is already retired.'
        });
    });

    it('replays durable records, and an out-of-catalogue name is simply carried', () => {
        const state = createAgentState([
            { name: 'instruct', title: 'Saved title' },
            { name: 'summarizer', retired: true },
            { name: 'gone-next-build', retired: true }
        ]);

        expect(state.effective('instruct')!.title).toBe('Saved title');
        expect(state.isKnown('summarizer')).toBe(false);
        expect(state.records()).toEqual([
            { name: 'instruct', title: 'Saved title' },
            { name: 'summarizer', retired: true },
            { name: 'gone-next-build', retired: true }
        ]);

        // Replaying onto a live layer is total (a startup replay has nothing to reconcile).
        state.restore([{ name: 'research', guidelines: [] }]);

        expect(state.records()).toEqual([{ name: 'research', guidelines: [] }]);
        expect(state.isKnown('instruct')).toBe(true);
    });
});

describe('the process default layer the harness factory resolves through', () => {
    it('is the same object `effectiveAgentProfile` reads, so a new session sees the decision', () => {
        const state = createAgentState();

        attachDefaultAgentState(state);

        expect(defaultAgentState()).toBe(state);
        expect(effectiveAgentProfile('instruct')!.instruction).toBe(instruct().instruction);

        state.patch('instruct', { instruction: 'The deployment sentence.' });

        expect(effectiveAgentProfile('instruct')!.instruction).toBe('The deployment sentence.');
        expect(agentProfile('instruct').instruction).toBe(instruct().instruction);
        expect(effectiveAgentProfile('nope')).toBeUndefined();

        state.retire('instruct');

        expect(effectiveAgentProfile('instruct')).toBeUndefined();
    });
});

describe('the durable overlay file', () => {
    const tempRoot = (label: string): string => {
        const root = path.join(ROOT, `state-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

        fs.mkdirSync(root, { recursive: true });

        return root;
    };

    it('round-trips a decision list and stays absent-safe', () => {
        const root = tempRoot('round-trip');

        // Nothing written yet: "no decisions", not a failure.
        expect(readHarnessAgentRecords(root)).toEqual([]);
        expect(readHarnessAgentRecords(undefined)).toEqual([]);

        writeHarnessAgentRecords(root, [
            { name: 'instruct', title: 'Generalist', guidelines: [] },
            { name: 'summarizer', retired: true }
        ]);

        expect(fs.existsSync(path.join(root, 'harness', HARNESS_AGENT_FILE))).toBe(true);
        expect(readHarnessAgentRecords(root)).toEqual([
            { name: 'instruct', title: 'Generalist', guidelines: [] },
            { name: 'summarizer', retired: true }
        ]);

        // An empty list is a stated decision ("nothing overridden"), and it round-trips.
        writeHarnessAgentRecords(root, []);

        expect(readHarnessAgentRecords(root)).toEqual([]);

        // No root means an in-memory deployment: nothing is written, and nothing is claimed.
        writeHarnessAgentRecords(undefined, [{ name: 'instruct', title: 'Ignored' }]);
    });

    it('replays the file into a fresh layer exactly as the running one looked', () => {
        const root = tempRoot('replay');
        const state = createAgentState();

        state.patch('research', { title: 'Investigator', guidelines: ['One bullet.'] });
        state.retire('flaky');

        writeHarnessAgentRecords(root, state.records());

        const reopened = createAgentState(readHarnessAgentRecords(root));

        expect(reopened.profiles()).toEqual(state.profiles());
        expect(reopened.retired()).toEqual(state.retired());
    });

    it('reports a corrupt document loudly instead of restoring the shipped catalogue', () => {
        const root = tempRoot('corrupt');
        const file = path.join(root, 'harness', HARNESS_AGENT_FILE);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ "not": "an array" }', 'utf8');

        expect(() => readHarnessAgentRecords(root)).toThrow(
            'The harness agent overlay must be an array of agent records.'
        );

        fs.writeFileSync(file, '[{ "name": "" }]', 'utf8');

        expect(() => readHarnessAgentRecords(root)).toThrow('agents[0].name must not be blank.');

        fs.writeFileSync(file, '[{ "name": "a" }, { "name": "a" }]', 'utf8');

        expect(() => readHarnessAgentRecords(root)).toThrow(
            'The harness agent overlay lists agent "a" more than once.'
        );
    });
});
