// @vitest-environment jsdom
// T20: the ONE test that runs the whole chain end to end, with no hand-written section
// data anywhere in it:
//
//     scripted runtime  →  real SessionStore (recorder + journal + persistence)
//         →  real turn projector (`store.getView` / `store.get`)
//             →  the real client board (`createTurnBoard.reconcileView`), the same call
//                `src/frontend/main.ts` makes for every `/views` frame
//
// Every other test in this area feeds the board a fixture tree it invented, or feeds the
// fold an event list it invented. This one asks what the USER actually sees after a real
// delegated run, which is the only way to answer the R17/R18 acceptance questions with
// evidence instead of intent:
//
//   R17  the delegated conversation carries ITS OWN context bar, with ITS OWN segments,
//        and the main tile's strip is not an aggregate of the two.
//   R18  the delegated conversation renders as an INDEPENDENT card outside the main
//        content, in the recorded depth-first order, addressed by its persistent
//        conversation and labelled with the SAME stable name every later turn and every
//        `#` reference uses — live, not only after a restart (the T20 label fix).
//   R19  a live run draws no retry line anywhere.
//   R20  a cold replay (what a reconnect or a reload does) reproduces that DOM row for
//        row: no duplicate card, no renumbered label.
//
// Environment note: this file lives in the SERVER suite because it needs the store
// (node:fs for the journal), and it opts into jsdom per-file for the board. Both halves
// are the real implementations, so the assertion below is a wire-to-pixel contract.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { SessionStore } from './sessions';
import type { SessionView } from './protocol';
import { createTurnBoard } from '../frontend/ui/turns';
import type { TurnBoard } from '../frontend/ui/turns';
import { sessionThreadsOf } from '../frontend/ui/threads';

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];

    return last === undefined ? '' : String(last.content);
};

// `lead → helper`: the parent's FIRST request issues exactly one `delegate` call, the
// helper answers, and the parent answers once the result lands. Every later request (and
// every later turn) answers directly, so the recorded tree is one main conversation with
// one delegated conversation under it — the exact shape the request is about.
//
// The factory is written fresh per store instance (a restarted store builds a fresh
// harness), so `delegated` resets with it and a cold replay never re-delegates.
const delegatingPreset = (): HarnessPreset => {
    let delegated = false;
    const create: HarnessPreset['create'] = (settings, progress) =>
        harness({
            agents: {
                lead: agent({
                    model: settings.model,
                    instruction: 'lead',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);

                        if (prompt === 'delegate please' && !delegated) {
                            delegated = true;

                            yield {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    {
                                        id: 'delegate-1',
                                        name: 'delegate',
                                        arguments: JSON.stringify({ agent: 'helper', input: 'child work' })
                                    }
                                ]
                            };

                            return;
                        }

                        yield { type: 'text', delta: `lead answer: ${prompt}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                }),
                helper: agent({
                    model: settings.model,
                    instruction: 'helper',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        yield { type: 'text', delta: `helper answer: ${lastUser(request.messages)}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'lead',
            subagents: ['helper'],
            presets: false,
            report: { progress }
        });

    return {
        name: 'lead',
        title: 'lead',
        description: 'lead + helper',
        requiresEndpoint: false,
        primary: 'lead',
        subagents: ['helper'],
        agents: ['lead', 'helper'],
        tools: [],
        builtin: true,
        editable: true,
        create
    };
};

const createStore = (
    presets: HarnessPreset[],
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>
): SessionStore =>
    new SessionStore(DEFAULTS, createHarnessRegistry(presets), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database })
    });

// ---------------------------------------------------------------------------
// The DOM the request is about, read the way a reader experiences it
// ---------------------------------------------------------------------------

/** The board's visible block order — the labels a reader meets top to bottom. */
const readingOrder = (): string[] => [
    ...[...document.querySelectorAll<HTMLElement>('.turn-row > .tile, .thread-row')].map((node) =>
        node.classList.contains('thread-row')
            ? (node.querySelector('.thread-name')?.textContent ?? '')
            : (node.querySelector('.tile-agent')?.textContent ?? '')
    )
];

const threadRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.thread-row')];

const rowFor = (label: string): HTMLElement =>
    threadRows().find((row) => row.querySelector('.thread-name')?.textContent === label) as HTMLElement;

/** The strip one block OWNS: the tile's own body host, or a card's body host. */
const stripOf = (block: Element, root: boolean): HTMLElement | null =>
    root
        ? block.querySelector<HTMLElement>(':scope > .tile-body > .context-bar-host')
        : block.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body > .context-bar-host');

const segmentsOf = (host: Element): string[] =>
    [...host.querySelectorAll<HTMLElement>('.context-bar-segment')].map((node) => node.dataset.blockId ?? '');

/** Mount the board exactly the way `main.ts` does: session, roster, then the view frame. */
const mountView = (store: SessionStore, sessionId: string, view: SessionView): TurnBoard => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });

    board.bindSession(sessionId);
    document.body.replaceChildren(board.element);
    // The roster is the same normalized list the shell hands the board (./main.ts
    // `board.setThreads`), so the persistent-thread join below is the store's, not a fixture.
    board.setThreads(sessionThreadsOf(store.get(sessionId)));

    for (const handle of board.reconcileView(view)) handle.flush();

    board.setThreads(sessionThreadsOf(store.get(sessionId)));

    return board;
};

afterEach(() => {
    document.body.innerHTML = '';
});

describe('a live delegated run rendered by the real board (R17/R18/R19/R20)', () => {
    it('draws the delegate as an independent card with its own bar, label and address', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't20-board-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegatingPreset()], persistence);
        const created = store.create('lead');

        const task = store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const turnId = task.turn.id;
        mountView(store, created.id, store.getView(created.id));

        // --- R18: two blocks, in the recorded order, one of them independent ----------
        expect(readingOrder()).toEqual(['LD1', 'HR1']);

        const tile = document.querySelector<HTMLElement>('.turn-row > .tile') as HTMLElement;
        const card = rowFor('HR1');

        expect(tile).toBeTruthy();
        expect(card).toBeTruthy();

        // The delegated card is OUTSIDE the main content: a sibling row in the turn's one
        // children host, never another element inside `.tile` / `.tile-body` / `.tile-flow`.
        expect(tile.contains(card)).toBe(false);
        expect(tile.querySelector('.tile-body')?.contains(card)).toBe(false);
        expect(tile.querySelector('.tile-flow')?.contains(card)).toBe(false);

        const turnRow = tile.parentElement as HTMLElement;
        const host = turnRow.querySelector<HTMLElement>(':scope > .thread-children') as HTMLElement;

        expect(turnRow.className).toBe('turn-row');
        expect(host.className).toBe('thread-children');
        expect([...host.children].map((child) => (child as HTMLElement).dataset.threadId)).toEqual([`${turnId}:1`]);

        // The recorded hierarchy survives as ORDER plus DATA (depth, parent), because the
        // DOM no longer nests anything. The parent value is the ROOT SECTION's wire id, so
        // the card names whose delegation it is — the link the no-placeholder path used to
        // lose before T20 resolved a parent through the invocation join as well.
        expect(card.dataset.depth).toBe('1');
        expect(card.dataset.parentThread).toBe(`${turnId}:0`);
        expect(card.style.getPropertyValue('--thread-depth')).toBe('0');
        expect([...card.children].map((child) => (child as HTMLElement).className)).toEqual(['thread-tile']);

        // --- R18: the identity a LATER turn can reference, live ----------------------
        // The persistent conversation (focus/steer/delete target) and the STABLE name.
        // `HR1` here is the T20 fix: the live fold used to paint this row with an empty
        // label and only show `HR1` after a restart, so the name a user typed `#` for while
        // the run was live disagreed with the durable record.
        expect(card.dataset.threadId).toBe(`${turnId}:1`);
        expect(card.dataset.persistentThread).toBe('thread-2');
        expect(card.querySelector('.thread-name')?.textContent).toBe('HR1');

        // The roster carries the same name for the same conversation, which is what the
        // composer's `#` popup offers — one label sequence, one authority.
        expect(
            store
                .get(created.id)
                .threads!.map((thread) => [thread.id, thread.label])
        ).toEqual([
            ['thread-1', 'LD1'],
            ['thread-2', 'HR1']
        ]);

        // --- R17: one bar per conversation, each with only its own segments ----------
        const tileStrip = stripOf(tile, true) as HTMLElement;
        const cardStrip = stripOf(card, false) as HTMLElement;

        expect(tileStrip).toBeTruthy();
        expect(cardStrip).toBeTruthy();
        expect(tileStrip.hidden).toBe(false);
        expect(cardStrip.hidden).toBe(false);
        expect(tileStrip.dataset.sectionId).toBe(`${turnId}:0`);
        expect(cardStrip.dataset.sectionId).toBe(`${turnId}:1`);

        const tileSegments = segmentsOf(tileStrip);
        const cardSegments = segmentsOf(cardStrip);

        // Exactly the server's own bar for the MAIN conversation: its instructions, the
        // user's submit, the `delegate` call, and its own answer — and NOT the child's
        // instructions or answer (the aggregate this change removed).
        expect(tileSegments).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-tool-1',
            '0-assistant-7'
        ]);
        // …and the delegated card's strip carries ITS conversation's context only: the
        // helper's own system instructions and its own answer.
        expect(cardSegments).toEqual(['1-system-instructions', '1-assistant-4']);

        // Neither strip repeats a segment the other owns (the arrays above already prove
        // the per-section split; this is the one figure a future fixture drift would have
        // to break to smuggle an aggregate back in).
        expect(tileSegments.filter((id) => cardSegments.includes(id))).toEqual([]);
        // The strip's own provenance counters match what it painted.
        expect(tileStrip.dataset.segments).toBe('4');
        expect(cardStrip.dataset.segments).toBe('2');

        // The child's bar answers for its own conversation's context (its instructions and
        // its answer), which is the data a per-thread strip needs to exist at all.
        expect(cardStrip.dataset.turnId).toBe(turnId);

        // --- R19: a live run prints no retry chatter anywhere ------------------------
        expect(document.querySelectorAll('.agent-retry')).toHaveLength(0);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('replays the same DOM from disk after a restart, without duplicating or renaming a card', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't20-board-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegatingPreset()], persistence);
        const created = store.create('lead');

        const task = store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const live = store.getView(created.id);
        mountView(store, created.id, live);

        const before = {
            order: readingOrder(),
            rows: threadRows().map((row) => [row.dataset.threadId, row.dataset.depth, row.dataset.parentThread, row.dataset.persistentThread]),
            strips: threadRows().map((row) => [stripOf(row, false)?.dataset.sectionId, segmentsOf(stripOf(row, false) as HTMLElement)])
        };

        // A reconnect/reload: a NEW store folded cold from the journal, a NEW board, the
        // same frame the rail would receive first.
        const reloaded = createStore([delegatingPreset()], persistence, persistence.load());
        const restored = reloaded.getView(created.id);

        expect(restored.displays[task.turn.id]).toEqual(live.displays[task.turn.id]);

        mountView(reloaded, created.id, restored);

        expect(readingOrder()).toEqual(before.order);
        expect(threadRows()).toHaveLength(before.rows.length);
        expect(
            threadRows().map((row) => [row.dataset.threadId, row.dataset.depth, row.dataset.parentThread, row.dataset.persistentThread])
        ).toEqual(before.rows);
        expect(
            threadRows().map((row) => [stripOf(row, false)?.dataset.sectionId, segmentsOf(stripOf(row, false) as HTMLElement)])
        ).toEqual(before.strips);

        // R20: the conversation CONTAINERS are unchanged on the way — one per conversation
        // that owns turns. The delegated card is not a container of its own (it has no
        // SessionTurn); it is a block inside its parent's row, addressable by
        // `data-persistent-thread`, which is exactly the shape the request asked for.
        expect(
            [...document.querySelectorAll<HTMLElement>('.conversation')].map((card) => card.dataset.threadId)
        ).toEqual(['thread-1']);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual(['thread-2']);

        store.dispose();
        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
