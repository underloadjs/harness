// T22 F1: the COALESCING CONTRACT.
//
// What this file pins, exactly:
//   1. A burst of core state changes inside ONE checkpoint window produces AT MOST ONE
//      best-effort whole-document write (it produced one per state change before F1),
//      while every recorded event still gets its own journal line, and the document on
//      disk still carries every event;
//   2. a STRICT mutation (`renameSession` -> `persistOrThrow`) still commits inside that
//      same window, exactly once — coalescing never delays a write the caller is awaiting;
//   3. the strict turn-start commit makes the turn-start best-effort commit redundant, so a
//      whole 3-tool-call turn costs 5 document writes, not 17 (the measured pre-F1 figure:
//      13 of them from `noteStateChange` alone).
//
// Why the numbers are exact: the provider is scripted (no network, no clock dependence),
// so the state-change sequence and the event count are fixed. The only timing-sensitive
// assertion is "at most one" gated write, and the whole turn runs in milliseconds —
// unambiguously inside the 2 s `VIEW_CHECKPOINT_INTERVAL_MS` window (sessions.ts:486).
//
// The persistence seam is the same one ./api-durable.test.ts:85 uses: a real
// `HarnessPersistence` over a real temp root, with its `save` wrapped to count and to
// attribute each commit to the call site that asked for it (the stack is the attribution;
// `persistBestEffort`/`checkpoint` never appear in a strict commit's stack, and
// `noteStateChange` never appears in one either).
//
// Cross-references:
//   - ./sessions.ts          — `noteStateChange` (the gated observer), `checkpoint`,
//                              `persistOrThrow` (stamps the gate on success)
//   - ./journal.ts           — the per-event append the coalescing must NOT touch
//   - ./persistence.ts       — `serializeHarnessDatabase` (F2: compact bytes)
//   - ./view.test.ts         — the store/preset idioms this file copies

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import type { HarnessStream, HarnessStreamEvent } from '../harness';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { HARNESS_JOURNAL_FILE, HarnessJournal } from './journal';
import { SessionStore } from './sessions';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-coalesce-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-key',
    model: 'scripted/coalesce'
};

const requestStream = (frames: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* (): AsyncGenerator<HarnessStreamEvent> {
        const batch = frames[index] ?? frames[frames.length - 1];

        index += 1;

        for (const frame of batch) yield frame;
    };
};

// Three real `task` tool rounds, then the answer — the shape the live gateway runs. Each
// round settles core state changes (the `tool_execute` store write, then the `agent_message`
// tool-result commit), which is the pair that used to rewrite the whole document each time.
//
// THE ONE THING THIS PRESET DOES THAT A SCRIPTED TEST PRESET NORMALLY DOES NOT: it forwards
// the host's `report.stateChange` observer (the third `create` argument), because that
// observer IS the persistence trigger under test. It also counts every call, which is how
// the test proves the burst really happened.
const toolTurnPreset = (observed: { stateChanges: number; kinds: string[] }): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted three-tool-round preset',
    requiresEndpoint: false,
    primary: 'worker',
    subagents: [],
    agents: ['worker'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress, report?: HarnessPresetReport) =>
        harness({
            agents: {
                worker: agent({
                    model: settings.model,
                    instruction: 'Call the task tool three times, then answer.',
                    stream: requestStream([
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [{ id: 'call-1', name: 'tasks', arguments: JSON.stringify({ tasks: [{ text: 'first' }] }) }],
                                usage: { input: 500, output: 20, total: 520 }
                            }
                        ],
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [{ id: 'call-2', name: 'tasks', arguments: JSON.stringify({ tasks: [{ text: 'second' }] }) }],
                                usage: { input: 500, output: 20, total: 520 }
                            }
                        ],
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [{ id: 'call-3', name: 'tasks', arguments: JSON.stringify({ tasks: [{ text: 'third' }] }) }],
                                usage: { input: 500, output: 20, total: 520 }
                            }
                        ],
                        [
                            { type: 'text', delta: 'finished' },
                            { type: 'done', stopReason: 'stop', toolCalls: [], usage: { input: 620, output: 25, total: 645 } }
                        ]
                    ]),
                    tools: ['task']
                })
            },
            primary: 'worker',
            presets: false,
            report: {
                progress,
                stateChange: (event) => {
                    observed.stateChanges += 1;
                    // `HarnessStateChangeEvent.reason` (../types/index.ts:3389) — `tool_execute`
                    // and `agent_message` are the two that settle per tool call.
                    observed.kinds.push(event.reason);

                    return report?.stateChange?.(event);
                }
            }
        })
});

// One recorded whole-document commit, with the call site that produced it.
type Write = { fromStateChange: boolean; fromCheckpoint: boolean; strict: boolean };

const durableStoreOf = (preset: HarnessPreset, root: string): { store: SessionStore; writes: Write[]; persistence: HarnessPersistence } => {
    const persistence = new HarnessPersistence(root);
    const writes: Write[] = [];
    const realSave = persistence.save.bind(persistence);

    (persistence as unknown as { save: (database: Parameters<typeof realSave>[0]) => void }).save = (database) => {
        const stack = new Error().stack ?? '';

        realSave(database);

        writes.push({
            // The gated best-effort path: the state-change observer, with or without the
            // checkpoint gate in between.
            fromStateChange: stack.includes('noteStateChange'),
            fromCheckpoint: stack.includes('checkpoint'),
            // The strict, caller-awaited path — never throttled.
            strict: stack.includes('persistOrThrow')
        });
    };

    const store = new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, { persistence });

    return { store, writes, persistence };
};

const stateFileOf = (root: string): string => path.join(root, 'harness', HARNESS_DATABASE_FILE);
const journalFileOf = (root: string, sessionId: string): string =>
    path.join(root, 'harness', 'sessions', sessionId, HARNESS_JOURNAL_FILE);

describe('state-change persistence coalescing (F1)', () => {
    it('writes the document at most once for a whole tool-driven burst, journals every event, and stays complete', async () => {
        const root = tempRoot('burst');
        const observed = { stateChanges: 0, kinds: [] as string[] };
        const { store, writes, persistence } = durableStoreOf(toolTurnPreset(observed), root);

        const created = await store.create('worker');
        const accepted = await store.dispatch(created.id, 'do the work');

        await store.waitForIdle(created.id);

        const turn = store.get(created.id).turns.find((candidate) => candidate.id === accepted.turn.id);

        expect(turn?.status).toBe('done');
        // The scripted sequence records exactly this many events; the number is the shape of
        // three tool rounds plus the final answer, and it is what the journal must mirror.
        expect(turn?.events).toHaveLength(16);

        // (1) THE BURST REALLY HAPPENED. 13 committed core state changes across the three
        // settled tool calls — the pre-F1 code rewrote the whole document for every one.
        expect(observed.stateChanges).toBe(13);
        expect(observed.kinds).toContain('tool_execute');
        expect(observed.kinds).toContain('agent_message');

        // (2) THE CONTRACT: 13 state changes -> ONE best-effort whole-document write.
        // That one is the cold-start anchor (`Session.firstCommitPending`), the first
        // boundary of a fresh session; the other 12 are absorbed by the interval. Pre-F1 the
        // same burst wrote the whole document 13 times.
        const bestEffort = writes.filter((write) => write.fromStateChange || write.fromCheckpoint);

        expect(bestEffort).toHaveLength(1);
        expect(bestEffort[0].fromStateChange).toBe(true);
        expect(bestEffort[0].strict).toBe(false);

        // (3) THE WHOLE TURN, END TO END: 5 writes — session create (strict), the accepted
        // turn (strict), the turn-start transition (strict), the anchored first boundary
        // (best-effort), and the terminal commit (best-effort). Pre-F1 the same turn cost 17,
        // 13 of them from `noteStateChange`. That is 1.67 writes per settled tool call, and
        // ZERO of them are per-state-change: on a real provider cadence (seconds per tool
        // call) the same turn costs 4, because the interval then absorbs the anchor too.
        expect(writes).toHaveLength(5);

        // (4) EVENT DURABILITY IS UNTOUCHED: one journal line per event, per event, and the
        // coalesced document on disk still carries every recorded event.
        const journal = new HarnessJournal(persistence.directory, created.id).read();

        expect(journal.missing).toBe(false);
        expect(journal.events).toHaveLength(16);

        const document = JSON.parse(fs.readFileSync(stateFileOf(root), 'utf8')) as {
            sessions: { id: string; turns: { id: string; status: string; events: unknown[] }[] }[];
        };
        const storedTurn = document.sessions.find((session) => session.id === created.id)?.turns.find((candidate) => candidate.id === turn?.id);

        expect(storedTurn?.status).toBe('done');
        expect(storedTurn?.events).toHaveLength(16);

        store.dispose();
    });

    it('still commits a strict mutation immediately, once, inside the same window', async () => {
        const root = tempRoot('strict');
        const observed = { stateChanges: 0, kinds: [] as string[] };
        const { store, writes, persistence } = durableStoreOf(toolTurnPreset(observed), root);

        const created = await store.create('worker');

        await store.dispatch(created.id, 'do the work');
        await store.waitForIdle(created.id);

        // The burst above is over and the window has not expired, so the ONLY way this next
        // mutation reaches the file is the strict path. That is the durability rule F1 must
        // not weaken: an awaited mutation commits, exactly once, however recent the last
        // checkpoint was.
        const before = writes.length;

        await store.renameSession(created.id, 'coalesced title');

        expect(writes).toHaveLength(before + 1);
        expect(writes[before].strict).toBe(true);
        expect(writes[before].fromStateChange).toBe(false);

        // And the mutation is really on disk by the time the call resolves.
        const document = JSON.parse(fs.readFileSync(stateFileOf(root), 'utf8')) as { sessions: { id: string; title?: string }[] };

        expect(document.sessions.find((session) => session.id === created.id)?.title).toBe('coalesced title');

        // The strict commit also proves the document is compact (F2): the bytes this store
        // wrote are `serializeHarnessDatabase`'s output, i.e. one line, no indentation.
        const raw = fs.readFileSync(persistence.file, 'utf8');

        expect(raw.includes('\n  ')).toBe(false);

        store.dispose();
    });
});
