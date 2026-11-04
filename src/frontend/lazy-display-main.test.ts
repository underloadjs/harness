// T21: the lazy display plane (./view-shell.ts `createDisplayPlane`) and its loader
// (./view-api.ts `createDisplayLoader`), on an independent canonical fixture. This
// file is NEW and owned by the production worker; it deliberately does not import
// ./view-test-support.ts (the shell-fixture worker owns that file).
//
// What is pinned, and why each rule matters on the wire:
//   - a visible row ALWAYS gets its tree, and never more than `concurrency` reads
//     run at once (the payload rule that replaced the whole-document read);
//   - the same row is never requested twice (dedupe), and a failed row is never
//     retried in a generation (no loop on a turn deleted mid-scroll);
//   - an answer from a superseded generation is discarded, never painted;
//   - history grows ONLY from the cursor the server issued, exactly one page per
//     call, and the affordance reports when there is nothing older to ask for.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnSummary as WireTurnSummary } from '../shared/harness-api';
import type { TurnDisplay } from '../shared/turn-display';
import { createDisplayLoader } from './view-api';
import { createDisplayPlane } from './view-shell';
import type { SessionView } from './view-model';

const row = (id: string, index: number): WireTurnSummary => ({
    id,
    index,
    promptPreview: `task ${index}`,
    promptChars: 6,
    status: 'done',
    state: 'done',
    updatedAt: 1000 + index,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: [],
    blocks: []
});

const documentOf = (turns: WireTurnSummary[], olderCursor: string | null = null): SessionView => ({
    id: 's1',
    harness: 'ghost-story',
    status: 'idle',
    model: 'gpt-5',
    createdAt: 1,
    updatedAt: 2,
    turns: turns.map((entry) => ({
        ...entry,
        prompt: entry.promptPreview,
        promptPreview: entry.promptPreview,
        promptChars: entry.promptChars,
        promptIsPreview: true
    })),
    displays: {},
    olderCursor,
    turnsRevision: 4
});

const treeOf = (turnId: string): TurnDisplay => ({
    turnId,
    sections: [
        {
            id: `${turnId}:0`,
            role: 'primary',
            agent: 'narrator',
            agentLabel: 'RR1',
            state: 'done',
            nodes: [{ kind: 'text', id: 'n1', text: 'the answer', committed: true }]
        }
    ]
});

describe('lazy display loader', () => {
    it('caps concurrency at 4 and drains the backlog as reads settle', async () => {
        let running = 0;
        let peak = 0;
        const released: (() => void)[] = [];

        const loader = createDisplayLoader('s1', {
            fetch: () => {
                running += 1;
                peak = Math.max(peak, running);

                return new Promise<TurnDisplay>((resolve) => {
                    released.push(() => {
                        running -= 1;
                        resolve(treeOf('u'));
                    });
                });
            }
        });

        const started = loader.pump(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);

        // Four in flight, two queued — never six at once.
        expect(started).toEqual(['u1', 'u2', 'u3', 'u4']);
        expect(running).toBe(4);

        // Settling one admits exactly the next queued id.
        released[0]();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(peak).toBe(4);
        expect(running).toBe(4);
        expect(loader.tracked('u5')).toBe(true);

        // Dedupe: a second pump of the same rows starts nothing.
        expect(loader.pump(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'])).toEqual([]);
    });

    it('discards an answer from a superseded generation', async () => {
        let resolveRead: ((tree: TurnDisplay) => void) | undefined;
        const loader = createDisplayLoader('s1', {
            fetch: () =>
                new Promise<TurnDisplay>((resolve) => {
                    resolveRead = resolve;
                })
        });

        const answer = loader.load('u1');
        loader.pump(['u1']);

        // The reader switched conversation while the tree was in flight.
        loader.invalidate();
        resolveRead?.(treeOf('u1'));

        expect(await answer).toBeUndefined();

        // The stale id is requestable again in the new generation (the cache dropped).
        expect(loader.tracked('u1')).toBe(false);
    });

    it('remembers a failed read instead of retrying it forever', async () => {
        const fetches: string[] = [];
        const loader = createDisplayLoader('s1', {
            fetch: (sessionId, turnId) => {
                fetches.push(`${sessionId}/${turnId}`);

                return Promise.reject(new Error('Unknown turn'));
            }
        });

        expect(await loader.load('u9')).toBeUndefined();
        expect(await loader.load('u9')).toBeUndefined();

        expect(fetches).toEqual(['s1/u9']);
    });
});

describe('display plane (visibility + load older)', () => {
    let fetched: string[] = [];

    beforeEach(() => {
        fetched = [];

        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            fetched.push(url);

            // The canonical older page, exactly one cursor walk.
            return new Response(
                JSON.stringify({
                    items: [row('u0', 0)].map((entry) => ({
                        ...entry,
                        prompt: entry.promptPreview
                    })),
                    limit: 25,
                    next_cursor: null,
                    observed_at: 1,
                    revision: 5
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }) as never;
    });

    it('fills a tree for every visible row and repaints once per arrival', async () => {
        const document = documentOf([row('u3', 3), row('u2', 2)]);
        let repaints = 0;

        const plane = createDisplayPlane({
            sessionId: () => 's1',
            document: () => document,
            repaint: () => {
                repaints += 1;
            },
            fetch: async (sessionId, turnId) => {
                fetched.push(`tree:${sessionId}/${turnId}`);

                return treeOf(turnId);
            }
        });

        plane.ensureVisible();
        // Let the reads and their waiter chain settle. One macrotask is enough and is
        // deterministic; the production code contains no sleeps.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Both rows adopted their trees, oldest-of-the-visible requested after the
        // tail, and the document is the only place the boards read from.
        expect(fetched.sort()).toEqual(['tree:s1/u2', 'tree:s1/u3']);
        expect(Object.keys(document.displays).sort()).toEqual(['u2', 'u3']);
        expect(repaints).toBe(2);

        // Nothing left to load: the pump is a no-op (no request storm on scroll).
        fetched = [];
        expect(plane.ensureVisible()).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it('walks one older page from the issued cursor and reports the end of history', async () => {
        const document = documentOf([row('u3', 3)], 'cursor-older');
        const plane = createDisplayPlane({
            sessionId: () => 's1',
            document: () => document,
            repaint: () => undefined,
            fetch: async (_sessionId, turnId) => treeOf(turnId)
        });

        expect(plane.hasOlder()).toBe(true);

        const loaded = await plane.loadOlder();

        expect(loaded).toBe(true);
        expect(fetched).toEqual(['/v1/harness/sessions/s1/turns?limit=25&cursor=cursor-older&order=desc']);

        // Prepended in recorded order, and the affordance retires when the server
        // says the beginning is already loaded.
        expect(document.turns.map((entry) => entry.id)).toEqual(['u0', 'u3']);
        expect(plane.hasOlder()).toBe(false);
        expect(await plane.loadOlder()).toBe(false);
        expect(fetched).toHaveLength(1);
    });

    it('drops an older page whose conversation is no longer on screen', async () => {
        const document = documentOf([row('u3', 3)], 'cursor-older');
        let session = 's1';

        const plane = createDisplayPlane({
            sessionId: () => session,
            document: () => document,
            repaint: () => undefined,
            fetch: async (_sessionId, turnId) => treeOf(turnId)
        });

        const pending = plane.loadOlder();

        // The reader selected another conversation while the page was in flight.
        session = 's2';

        expect(await pending).toBe(false);
        expect(document.turns.map((entry) => entry.id)).toEqual(['u3']);
    });
});
