// T20: the ONE test that runs the whole chain end to end, with no hand-written section
// data anywhere in it:
//
//     scripted runtime  →  real SessionStore (recorder + journal + persistence)
//         →  real turn projector (`store.getView` / `store.get`)
//             →  the compiled `/views` feed the client board consumes
//
// Every other test in this area feeds the board a fixture tree it invented, or feeds the
// fold an event list it invented. This one asks what the SERVER serves after a real
// delegated run, which is the only way to answer the R17/R18 acceptance questions with
// evidence instead of intent:
//
//   R17  the delegated conversation carries ITS OWN context bar, with ITS OWN segments,
//        and the main section's bar is not an aggregate of the two.
//   R18  the delegated conversation is an INDEPENDENT section outside the main content, in
//        the recorded depth-first order, addressed by its persistent conversation and
//        labelled with the SAME stable name every later turn and every `#` reference uses —
//        live, not only after a restart (the T20 label fix).
//   R19  a live run carries no retry chatter anywhere.
//   R20  a cold replay (what a reconnect or a reload does) reproduces that tree row for
//        row: no duplicate section, no renumbered label.
//
// Environment note: the client board itself (`createTurnBoard`) now lives in
// `@loadscript/harness`, which is not published to npm, so the server suite cannot import
// it. This test therefore pins the SERVER half of the same contract — the section tree,
// the per-section context bars and the thread roster the board renders from — and the UI
// package owns the DOM assertions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { SessionStore } from './sessions';
import type { SessionView } from './protocol';
import type { TurnDisplay } from '../shared/turn-display';

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
            // R1 — `entry` (routing) + `ranks` (authority) replace `primary`/`subagents`; `helper`
            // is Rank B, so it is `lead`'s only legal `delegate` target.
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            presets: false,
            report: { progress }
        });

    return {
        name: 'lead',
        title: 'lead',
        description: 'lead + helper',
        requiresEndpoint: false,
        // R15 — the rank map IS the team: entry `lead` at Rank A, `helper` strictly below it.
        entry: 'lead',
        ranks: { lead: 'A', helper: 'B' },
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
// The server view the board reads, reduced to the figures it paints
// ---------------------------------------------------------------------------

const sectionsOf = (view: SessionView, turnId: string) => view.displays[turnId]?.sections ?? [];

/** The roster the shell hands the board: persistent id + the stable label. */
const rosterOf = (view: SessionView): [string, string | undefined][] =>
    (view.threadViews ?? view.threads ?? []).map((thread) => [thread.id, thread.label]);

/** The section tree + context bars + roster, without any client-side rendering. */
const snapshotOf = (view: SessionView, turnId: string) => ({
    sections: sectionsOf(view, turnId).map((section) => ({
        id: section.id,
        parentSectionId: section.parentSectionId,
        agentLabel: section.agentLabel,
        threadId: section.threadId,
        threadLabel: section.threadLabel,
        context: (section.context ?? []).map((block) => block.id)
    })),
    roster: rosterOf(view)
});

describe('a live delegated run as the server view serves it (R17/R18/R19/R20)', () => {
    it('sends the delegate as an independent section with its own bar, label and address', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't20-board-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegatingPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const turnId = task.turn.id;
        const view = store.getView(created.id);
        const display = view.displays[turnId];
        const sections = display.sections;

        // --- R18: two sections, in the recorded order, one nested under the other --------
        expect(sections.map((section) => section.id)).toEqual([`${turnId}:0`, `${turnId}:1`]);

        const [tile, card] = sections;

        expect([tile.agentLabel, tile.threadId, tile.threadLabel, tile.parentSectionId]).toEqual([
            'LD1',
            'thread-1',
            'LD1',
            undefined
        ]);
        expect([card.agentLabel, card.threadId, card.threadLabel, card.parentSectionId]).toEqual([
            'HR1',
            'thread-2',
            'HR1',
            `${turnId}:0`
        ]);

        // The delegated card is OUTSIDE the main content: a sibling section in the turn's one
        // compiled tree, never a child of the root section's strip.
        expect(card.parentSectionId).toBe(tile.id);
        expect(card.id).not.toBe(tile.id);

        // --- R18: the identity a LATER turn can reference, live --------------------------
        // The persistent conversation (focus/steer/delete target) and the STABLE name.
        // `HR1` here is the T20 fix: the live fold used to paint this row with an empty
        // label and only show `HR1` after a restart, so the name a user typed `#` for while
        // the run was live disagreed with the durable record.
        expect(rosterOf(view)).toEqual([
            ['thread-1', 'LD1'],
            ['thread-2', 'HR1']
        ]);

        // --- R17: one bar per conversation, each with only its own segments --------------
        const tileSegments = (tile.context ?? []).map((block) => block.id);
        const cardSegments = (card.context ?? []).map((block) => block.id);

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
        expect(tileSegments).toHaveLength(4);
        expect(cardSegments).toHaveLength(2);
        // Every segment reports the section that owns it, so the bar cannot paint one
        // conversation's block inside the other's strip.
        expect((tile.context ?? []).every((block) => block.sectionId === tile.id)).toBe(true);
        expect((card.context ?? []).every((block) => block.sectionId === card.id)).toBe(true);
        expect(display.turnId).toBe(turnId);

        // --- R19: a live run prints no retry chatter anywhere ---------------------------
        expect(
            sections
                .flatMap((section) => section.nodes)
                .filter((node) => node.kind === 'notice' && node.tone === 'retry')
        ).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('replays the same view from disk after a restart, without duplicating or renaming a section', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't20-board-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegatingPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const live = store.getView(created.id);
        const before = snapshotOf(live, task.turn.id);

        // A reconnect/reload: a NEW store folded cold from the journal, a NEW view, the
        // same frame the rail would receive first.
        const reloaded = createStore([delegatingPreset()], persistence, persistence.load());
        const restored = reloaded.getView(created.id);

        expect(restored.displays[task.turn.id]).toEqual(live.displays[task.turn.id]);
        expect(snapshotOf(restored, task.turn.id)).toEqual(before);

        expect(before.sections).toHaveLength(2);
        expect(before.sections.map((section) => section.threadId)).toEqual(['thread-1', 'thread-2']);
        // R20: one compiled tree for the turn, never a second copy of the delegated card.
        expect(Object.keys(restored.displays)).toEqual([task.turn.id]);

        // The conversation CONTAINERS are unchanged on the way — one per conversation
        // that owns turns. The delegated card is not a container of its own (it has no
        // SessionTurn); it is a section inside its parent's tree, addressable by
        // `threadId`, which is exactly the shape the request asked for.
        expect(snapshotOf(restored, task.turn.id).sections.map((section) => section.threadId)).toEqual([
            'thread-1',
            'thread-2'
        ]);

        store.dispose();
        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
