// C2 (R4/R5/R6): an ANSWERED question is never re-marked expired by the server.
//
// The screenshot symptom: the card said "This question expired when the turn ended."
// and "Auto-answered by the owner fork." while the compiled plane's own notice below it
// read "answered · <option>". The server half of that is `expiredRequestIds`: it was
// fed from `completedActions`, which records EVERY settlement — a human answer included
// — so the fold was told the answered request was dead, and after a restart EVERY
// recorded request id was seeded into it (answered or not).
//
// Pinned here, in order:
//   1. `expiredActionRequestIds` — settled-but-never-answered ids only;
//   2. the fold driven by that set: the answered question renders `state:'ok'` with
//      `action.answered` and `expired:false`, the unanswered one stays `expired:true`
//      (R6: genuine expiry is not weakened);
//   3. the live store: an answered id leaves the snapshot's expiry set while the repeat
//      answer is STILL a 409 (AC5: 404/409/400 semantics unchanged);
//   4. the restore path: a restart with a recorded answer excludes the id, one without
//      the answer still expires it.
//
// Every assertion is an exact value read from the COMPILED tree the fold produces (not
// from an implementation detail), and request ids are literals. Nothing here depends on
// the `request-N` spelling the runtime mints (a C1 change makes those ids
// instance-unique), so these ids are opaque strings on purpose.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../engine/harness';
import type {
    AgentRank,
    HarnessActionHandler,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessStream,
    HarnessStreamEvent
} from '../engine/harness';
import type { DisplayProjectContext, DisplayStep } from '../engine/shared/turn-display';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry, describeHarness } from './harnesses';
import { presetToRecord } from './harnesses/registry';
import { HARNESS_DATABASE_VERSION } from './persistence';
import type { HarnessSessionRecord } from './persistence';
import type { SessionTurn } from './protocol';
import { SessionError, SessionStore, expiredActionRequestIds } from './sessions';
import { projectTurn } from './turn-projector';

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'unused',
    model: 'scripted/test'
};

const TRANSPORT: HarnessStream = async function* (): AsyncGenerator<HarnessStreamEvent> {
    yield { type: 'text', delta: 'done' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

// Routing/rank context the fold needs. `entry` names the turn's ROOT flow, and `ranks`
// is the authority ladder — neither has anything to do with question expiry, which is
// the whole point of R5.
const CONTEXT: DisplayProjectContext = { entry: 'worker', ranks: { worker: 'A' as AgentRank } };

const REQUEST: HarnessActionRequest = {
    requestId: 'req-1',
    question: 'Which path should I take?',
    recommended: 'a',
    allowCustom: true,
    options: [
        { id: 'a', label: 'Path A', description: 'The recommended path' },
        { id: 'b', label: 'Path B' }
    ]
};

const requestEvent = (requestId: string, callId: string) => ({
    type: 'action_request',
    agent: 'worker',
    callId,
    request: { ...REQUEST, requestId }
});

const answerEvent = (requestId: string, optionId: string, source: 'owner' | 'auto' = 'owner') => ({
    type: 'action_answer',
    agent: 'worker',
    requestId,
    answer: { requestId, choice: { kind: 'option', optionId }, source }
});

const turnOf = (events: unknown[], overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'ask the owner',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events,
        eventTimes: events.map((_event, index) => index + 1),
        ...overrides
    }) as SessionTurn;

// Reads the action step out of the COMPILED tree the server fold produces — the same
// tree the browser's `paintCompiledAction` receives.
const actionStep = (turn: SessionTurn, context: DisplayProjectContext, requestId: string): DisplayStep => {
    const { display } = projectTurn(turn, context);
    const steps = display.sections[0].nodes.filter(
        (node) => node.kind === 'action' && (node as DisplayStep).action?.requestId === requestId
    );

    expect(steps).toHaveLength(1);

    return steps[0] as DisplayStep;
};

describe('expiredActionRequestIds (R5)', () => {
    it('excludes answered ids from the settled history', () => {
        expect(expiredActionRequestIds(['req-1', 'req-2', 'req-3'], ['req-1', 'req-3'])).toEqual(
            new Set(['req-2'])
        );
    });

    it('keeps the whole history expired when nothing was answered', () => {
        expect(expiredActionRequestIds(['req-1', 'req-2'], [])).toEqual(new Set(['req-1', 'req-2']));
    });

    it('names nothing when every request was answered', () => {
        expect(expiredActionRequestIds(['req-1'], ['req-1'])).toEqual(new Set<string>());
    });
});

describe('the fold driven by the store-derived expiry set (R4/R5)', () => {
    // The exact set `displayContext` builds for a session that settled req-1 with an
    // answer and req-2 without one.
    const contextFor = (completed: readonly string[], answered: readonly string[]): DisplayProjectContext => ({
        ...CONTEXT,
        expiredRequestIds: expiredActionRequestIds(completed, answered)
    });

    it('renders an answered question as answered, never expired', () => {
        const step = actionStep(
            turnOf([requestEvent('req-1', 'call-1'), answerEvent('req-1', 'a')]),
            contextFor(['req-1'], ['req-1']),
            'req-1'
        );

        expect(step.state).toBe('ok');
        expect(step.action?.expired).toBe(false);
        expect(step.action?.answered?.choice).toEqual({ kind: 'option', optionId: 'a' });
        expect(step.action?.answered?.source).toBe('owner');
    });

    it('re-folds a settled turn with the answered id in the completed history as answered', () => {
        // The cold re-fold the screenshot showed: after a restart `completedActions`
        // holds req-1, and only `answeredActions` can say it was ANSWERED.
        const completed = ['req-1'];
        const answered = ['req-1'];
        const step = actionStep(
            turnOf([requestEvent('req-1', 'call-1'), answerEvent('req-1', 'b')]),
            contextFor(completed, answered),
            'req-1'
        );

        expect(step.state).toBe('ok');
        expect(step.action?.expired).toBe(false);
        expect(step.action?.answered?.choice).toEqual({ kind: 'option', optionId: 'b' });
        expect(step.action?.answered?.source).toBe('owner');
    });

    it('still expires the settled question that was never answered (R6)', () => {
        const turn = turnOf([
            requestEvent('req-1', 'call-1'),
            answerEvent('req-1', 'a'),
            requestEvent('req-2', 'call-2')
        ]);
        const context = contextFor(['req-1', 'req-2'], ['req-1']);

        expect(actionStep(turn, context, 'req-1').action?.expired).toBe(false);
        expect(actionStep(turn, context, 'req-1').state).toBe('ok');

        const expired = actionStep(turn, context, 'req-2');
        // The turn record is `done`, so the settle sweep closes the still-running step
        // (`turn-projector.ts:3835-3866`): an unanswered question ends as a failed
        // step AND stays expired — R6's genuine expiry is intact.
        expect(expired.state).toBe('error');
        expect(expired.action?.expired).toBe(true);
        expect(expired.action?.answered).toBeUndefined();
    });
});

// --- store surface -------------------------------------------------------------

// The preset factory captures the `interaction.actionRequest` handler the store
// installs, which is the object the runtime would await: calling it registers the
// pending entry exactly as a run would, without a provider.
const capturePreset = (): HarnessPreset & { captured: { handler?: HarnessActionHandler } } => {
    const captured: { handler?: HarnessActionHandler } = {};

    return {
        ...{
            name: 'worker',
            title: 'worker',
            description: 'worker scripted preset',
            requiresEndpoint: false,
            entry: 'worker',
            ranks: { worker: 'A' } as Record<string, AgentRank>,
            agents: ['worker'],
            tools: [],
            builtin: true,
            editable: true,
            create: (_settings, progress, report) => {
                captured.handler = report?.interaction?.actionRequest;

                return harness({
                    agents: {
                        worker: agent({
                            model: DEFAULTS.model,
                            instruction: 'Scripted interaction test agent.',
                            stream: TRANSPORT
                        })
                    },
                    entry: 'worker',
                    presets: false,
                    report: { progress }
                });
            }
        },
        captured
    };
};

const contextOf = (
    requestId: string,
    overrides: Partial<HarnessActionRequestContext> = {}
): HarnessActionRequestContext => ({
    requestId,
    agent: 'worker',
    callId: 'call-1',
    request: { ...REQUEST, requestId },
    ...overrides
});

const sessionErrorOf = async (run: () => unknown): Promise<SessionError> => {
    try {
        await run();
    } catch (error) {
        if (error instanceof SessionError) return error;
        throw error;
    }

    throw new Error('expected a SessionError');
};

// One restored session: `turns` replay exactly as a restart would.
const restoredStore = (preset: HarnessPreset, turns: SessionTurn[], sessionId: string): SessionStore => {
    const built = preset.create(DEFAULTS, () => undefined);

    const record: HarnessSessionRecord = {
        id: sessionId,
        harness: 'worker',
        preset: presetToRecord(preset),
        definition: describeHarness(preset),
        settings: { baseURL: DEFAULTS.baseURL, model: DEFAULTS.model },
        status: 'idle',
        createdAt: 1,
        updatedAt: 2,
        turns,
        queue: [],
        core: built.snapshot()
    };

    return new SessionStore(DEFAULTS, createHarnessRegistry([preset]), (entry) => describeHarness(entry), {
        database: {
            version: HARNESS_DATABASE_VERSION,
            savedAt: 3,
            registry: [presetToRecord(preset)],
            sessions: [record]
        }
    });
};

describe('SessionStore snapshot expiry (R5/AC3)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('drops an answered request from the snapshot expiry set but keeps its 409 (AC5)', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = await store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-1'), new AbortController().signal);

        // Before the answer: settled history is empty, so nothing is expired.
        expect(store.expiredRequestIds(created.id)).toEqual(new Set<string>());

        store.answerAction(created.id, 'req-1', { kind: 'option', optionId: 'b' });
        await expect(awaiting).resolves.toEqual({ kind: 'option', optionId: 'b' });

        // The answer WAS recorded: the fold must not read this id as expired.
        expect(store.expiredRequestIds(created.id)).toEqual(new Set<string>());

        // R6: the answer route is untouched — a repeat is still 409, not 404.
        const repeated = await sessionErrorOf(() =>
            store.answerAction(created.id, 'req-1', { kind: 'option', optionId: 'a' })
        );
        expect(repeated.status).toBe(409);
        expect(repeated.message).toBe('Action request "req-1" was already answered or has expired.');

        const unknown = await sessionErrorOf(() =>
            store.answerAction(created.id, 'never-seen', { kind: 'option', optionId: 'a' })
        );
        expect(unknown.status).toBe(404);
    });

    it('restores a restart with a recorded answer OUT of the expiry set', () => {
        const preset = capturePreset();
        const store = restoredStore(
            preset,
            [turnOf([requestEvent('req-answered', 'call-1'), answerEvent('req-answered', 'a')], { id: 'turn-1' })],
            'restored-answer'
        );

        // `completedActions` still holds the id (the 409 contract), and the fold no
        // longer reads it as an expiry.
        expect(store.expiredRequestIds('restored-answer')).toEqual(new Set<string>());

        const turn = store.get('restored-answer').turns[0];
        const step = actionStep(turn as SessionTurn, {
            ...CONTEXT,
            expiredRequestIds: store.expiredRequestIds('restored-answer')
        }, 'req-answered');

        expect(step.state).toBe('ok');
        expect(step.action?.expired).toBe(false);
        expect(step.action?.answered?.source).toBe('owner');
    });

    it('restores a restart with NO recorded answer as genuinely expired (R6)', async () => {
        const preset = capturePreset();
        const store = restoredStore(preset, [turnOf([requestEvent('req-dead', 'call-1')], { id: 'turn-1' })], 'restored-dead');

        expect(store.expiredRequestIds('restored-dead')).toEqual(new Set(['req-dead']));

        const turn = store.get('restored-dead').turns[0];
        const step = actionStep(turn as SessionTurn, {
            ...CONTEXT,
            expiredRequestIds: store.expiredRequestIds('restored-dead')
        }, 'req-dead');

        expect(step.action?.expired).toBe(true);
        expect(step.action?.answered).toBeUndefined();

        const refused = await sessionErrorOf(() =>
            store.answerAction('restored-dead', 'req-dead', { kind: 'option', optionId: 'a' })
        );
        expect(refused.status).toBe(409);
    });

    it('separates answered from unanswered ids across a restart', () => {
        const preset = capturePreset();
        const store = restoredStore(
            preset,
            [
                turnOf(
                    [
                        requestEvent('req-answered', 'call-1'),
                        answerEvent('req-answered', 'b'),
                        requestEvent('req-expired', 'call-2')
                    ],
                    { id: 'turn-1' }
                )
            ],
            'restored-mixed'
        );

        expect(store.expiredRequestIds('restored-mixed')).toEqual(new Set(['req-expired']));
    });

    it('keeps a fork-answered child request out of the expiry set', () => {
        const preset = capturePreset();
        const store = restoredStore(
            preset,
            [
                turnOf(
                    [requestEvent('req-child', 'call-1'), answerEvent('req-child', 'b', 'auto')],
                    { id: 'turn-1' }
                )
            ],
            'restored-child'
        );

        expect(store.expiredRequestIds('restored-child')).toEqual(new Set<string>());
    });
});
