// T13 focused regression tests for the two server lifecycle hazards.
//
// P1-B — SHUTDOWN DATA LOSS. dispose() saved the document, then aborted the runs and
// cleared the session map. The aborted run's sink and its post-finally save ran
// AFTERWARDS, so they rewrote the same file with `sessions: []`. Every persistence
// test here runs against a REAL database root under the repo-root Temp/ directory and
// asserts the EXACT persisted document, so a single late write is observable.
//
// P3 — LEGACY SSE WRITE ORDER. The harness awaits the progress it emits from its
// main loop, but background deliveries (completion/wake mailboxes) call the same
// sink concurrently, and neither adapter serializes an emitter. The store's sink is
// now one serial per-turn chain, so a frame is written only after the previous one
// settled. The ordering test drives two concurrent frames whose write delays are
// deliberately inverted: with a serial chain the recorded write sequence is strictly
// sequential; an unserialized sink would complete frame 2 before frame 1.
//
// Cross-references:
//   - sessions.ts                    - dispose(), writeLegacy(), persistBestEffort()
//   - persistence.test.ts            - the restart/interrupted-turn contract
//   - <repo>/Temp/T10/probe-dispose.ts - the original standalone repro

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessProgress, HarnessStream, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import {
    createHarnessRegistry,
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    describeHarness
} from './harnesses';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { SessionStore } from './sessions';
import type { SessionStreamItem } from './protocol';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

// One root per test: a restart must never see another test's sessions.
const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-shutdown-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
    hasApiKey: true
};

// Forced unconfigured webSearch entry: the catalogue must not depend on the test
// runner's environment (mirrors persistence.test.ts).
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

// Exact recovery wording the loader writes for an interrupted turn.
const INTERRUPTED_MESSAGE =
    'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.';

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

// Read the persisted database exactly as written (no re-serialization).
const readState = (root: string): string => fs.readFileSync(stateFile(root), 'utf8');

// One macrotask: enough for an accidental replay/timer to become observable.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const presetOf = (name: string, create: HarnessPreset['create']): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: name,
    subagents: [],
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create
});

// A plain one-answer scripted harness, wired to the core observer exactly like a
// production preset (so the store's state-change path is exercised too).
const idlePreset = (): HarnessPreset =>
    presetOf('idle', (settings, progress: HarnessProgress, report) =>
        harness({
            agents: {
                idle: agent({
                    model: settings.model,
                    instruction: 'You are the idle scripted agent.',
                    stream: answerStream('quiet')
                })
            },
            primary: 'idle',
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

const runtimeOf = (root: string, presets: HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presets),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

// A one-agent scripted harness that reports one delta and then parks inside the
// model stream until `release()`. It deliberately IGNORES the abort signal while
// parked: that is the "uncooperative work" a graceful shutdown must survive, because
// the run only settles AFTER dispose(), exactly the window that used to rewrite the
// file with `sessions: []`.
const gatedPreset = (): {
    preset: HarnessPreset;
    started: Promise<void>;
    release: () => void;
    starts: () => number;
} => {
    let startRun!: () => void;
    const started = new Promise<void>((resolve) => {
        startRun = resolve;
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    // Counts model-stream starts, so "no replay" is an exact number, not a guess.
    let starts = 0;

    const preset = presetOf('gated', (settings, progress: HarnessProgress, report) =>
        harness({
            agents: {
                gated: agent({
                    model: settings.model,
                    instruction: 'You are the gated scripted agent.',
                    stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                        starts += 1;
                        yield { type: 'text', delta: 'held' };
                        startRun();
                        await gate;
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'gated',
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

    return { preset, started, release, starts: () => starts };
};

describe('T13 shutdown safety (P1-B)', () => {
    it('keeps every session, the interrupted turn, and the queued backlog across dispose()', async () => {
        const root = tempRoot('dispose-running');
        const fixture = gatedPreset();
        const first = runtimeOf(root, [fixture.preset]);

        // Two idle sessions that must survive the shutdown untouched.
        const idleA = first.store.create('gated');
        const idleB = first.store.create('gated');

        // One session with a turn genuinely in flight (LEGACY path: run()'s promise
        // resolves only after the whole executeTurn continuation, which is exactly
        // the window that used to overwrite the file).
        const running = first.store.create('gated');
        const runSettled = first.store.run(running.id, 'hold the turn', async () => {});
        await fixture.started;

        // A prompt accepted while that turn runs: dispose() must persist it before
        // dropping the accepted backlog.
        const queued = first.store.enqueue(running.id, 'do this next');

        // Count every save from here on, so "dispose writes exactly once and never
        // again" is an exact number rather than an inference.
        const saves: number[] = [];
        const persistence = first.persistence;
        const originalSave = persistence.save.bind(persistence);
        persistence.save = (database): void => {
            saves.push(database.sessions.length);
            originalSave(database);
        };

        first.store.dispose();

        // The graceful document is the one that must survive verbatim.
        const committed = readState(root);

        // The dropped queued turn's completion is released by the shutdown itself.
        await queued.settled;
        expect(saves).toEqual([3]);

        // Late, uncooperative completion of the aborted run: its sink and its
        // post-finally save land AFTER dispose() and must not touch the file.
        fixture.release();
        await runSettled;
        await flush();

        expect(readState(root)).toBe(committed);
        expect(saves).toEqual([3]);

        // Exact persisted ids, in creation order.
        const committedSessions = (
            JSON.parse(committed) as { sessions: { id: string; status: string; turns: { status: string; prompt: string }[] }[] }
        ).sessions;
        expect(committedSessions.map((session) => session.id)).toEqual([
            idleA.id,
            idleB.id,
            running.id
        ]);

        // The document records the running turn (restored as interrupted) and the
        // queued prompt before execution began.
        expect(
            committedSessions.find((session) => session.id === running.id)?.turns.map(
                (turn) => `${turn.status}:${turn.prompt}`
            )
        ).toEqual(['running:hold the turn', 'queued:do this next']);

        // Restart over the same root: ALL sessions come back, the in-flight turn is
        // an error row with its recorded events, and nothing is replayed.
        const second = runtimeOf(root, [fixture.preset]);
        expect(second.store.list().map((session) => session.id)).toEqual([
            idleA.id,
            idleB.id,
            running.id
        ]);

        const restored = second.store.get(running.id);
        expect(restored.status).toBe('error');
        expect(restored.lastError).toBe(INTERRUPTED_MESSAGE);
        expect(restored.turns.map((turn) => `${turn.index}:${turn.status}:${turn.prompt}`)).toEqual([
            '0:error:hold the turn',
            '1:queued:do this next'
        ]);
        // The agent-run start frame plus the one delta that was actually delivered
        // and committed before the shutdown.
        expect(restored.turns[0].events.map((event) => event.type)).toEqual(['start', 'text']);
        expect(restored.queueDepth).toBe(1);

        await flush();
        expect(fixture.starts()).toBe(1);

        second.store.dispose();
    });

    it('commits an idle store exactly once and stays idempotent', () => {
        const root = tempRoot('dispose-idle');
        const first = runtimeOf(root, [idlePreset()]);

        const created = first.store.create('idle');

        const saves: number[] = [];
        const persistence = first.persistence;
        const originalSave = persistence.save.bind(persistence);
        persistence.save = (database): void => {
            saves.push(database.sessions.length);
            originalSave(database);
        };

        first.store.dispose();

        // One graceful save with the session still present; that is the whole write.
        expect(saves).toEqual([1]);
        const committed = readState(root);
        expect(
            (JSON.parse(committed) as { sessions: { id: string }[] }).sessions.map((session) => session.id)
        ).toEqual([created.id]);

        // A second dispose() is a no-op: no save, byte-identical file.
        first.store.dispose();
        expect(saves).toEqual([1]);
        expect(readState(root)).toBe(committed);
    });

    it('refuses structural writes after dispose() instead of writing an empty document', () => {
        const root = tempRoot('dispose-refuse');
        const first = runtimeOf(root, [idlePreset()]);

        const created = first.store.create('idle');
        first.store.dispose();
        const committed = readState(root);

        // A request that raced the shutdown is answered honestly (503) and rolls its
        // in-memory mutation back; the good document is untouched.
        expect(() => first.store.create('idle')).toThrowError(
            'The harness database is closed; nothing was saved.'
        );
        expect(first.store.size).toBe(0);
        expect(readState(root)).toBe(committed);
        expect(
            (JSON.parse(committed) as { sessions: { id: string }[] }).sessions.map((session) => session.id)
        ).toEqual([created.id]);

        // The registry write-through path refuses for the same reason.
        expect(() => first.store.persistRegistry()).toThrowError(
            'The harness database is closed; nothing was saved.'
        );
        expect(readState(root)).toBe(committed);
    });
});

describe('T13 legacy stream ordering (P3)', () => {
    // Names the frames the store writes, so the ordering assertion can name them.
    const frameLabel = (item: SessionStreamItem): string => {
        if (item.type === 'turn') return 'turn';
        if (item.type === 'snapshot') return 'snapshot';
        if (item.type === 'failed') return 'failed';
        return item.event.type === 'text' ? `text:${item.event.delta}` : item.event.type;
    };

    it('writes concurrent progress frames serially in record order under backpressure', async () => {
        // The wrapper reports TWO frames concurrently and only then runs the real
        // (quiet) harness. That is the production shape of a background mailbox
        // delivery racing the loop's own frame; here it is deterministic.
        const preset = presetOf('concurrent', (settings, progress: HarnessProgress, report) => {
            const inner = harness({
                agents: {
                    concurrent: agent({
                        model: settings.model,
                        instruction: 'You are the concurrent scripted agent.',
                        stream: answerStream('quiet')
                    })
                },
                primary: 'concurrent',
                presets: false,
                report: {
                    progress,
                    ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
                }
            });

            return new Proxy(inner, {
                apply: (target, _thisArg, args: [string]) => {
                    const firstFrame = progress({ type: 'text', agent: 'concurrent', delta: '1' });
                    const secondFrame = progress({ type: 'text', agent: 'concurrent', delta: '2' });

                    return Promise.all([firstFrame, secondFrame]).then(() => inner(args[0]));
                }
            });
        });

        const store = new SessionStore(SETTINGS, createHarnessRegistry([preset]), (entry) =>
            describeHarness(entry, CATALOGUE)
        );
        const session = store.create('concurrent');

        // Deliberately inverted write delays: frame 2 settles instantly while frame 1
        // is held. A serial chain still starts 2 only after 1 ended; an unserialized
        // sink would finish 2 first, which is the reordering this test forbids.
        const delays: Record<string, number> = {
            turn: 5,
            'text:1': 30,
            'text:2': 0,
            start: 0,
            'text:quiet': 0,
            done: 0,
            snapshot: 0
        };
        const writes: string[] = [];
        const emit = async (item: SessionStreamItem): Promise<void> => {
            const label = frameLabel(item);
            writes.push(`>${label}`);
            await new Promise<void>((resolve) => setTimeout(resolve, delays[label] ?? 0));
            writes.push(`<${label}`);
        };

        await store.run(session.id, 'go', emit);

        // EXACT wire order: the opening turn frame, the two concurrent frames in
        // record order, the harness's own quiet turn, and the terminal snapshot.
        expect(writes).toEqual([
            '>turn',
            '<turn',
            '>text:1',
            '<text:1',
            '>text:2',
            '<text:2',
            '>start',
            '<start',
            '>text:quiet',
            '<text:quiet',
            '>done',
            '<done',
            '>snapshot',
            '<snapshot'
        ]);

        // Recording order is the emission order (the chain never drops or duplicates
        // a frame), and the run is terminal.
        const deltas = store
            .get(session.id)
            .turns[0].events.flatMap((event) => (event.type === 'text' ? [event.delta] : []));
        expect(deltas).toEqual(['1', '2', 'quiet']);
        expect(store.get(session.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual([
            '0:done'
        ]);
    });
});
