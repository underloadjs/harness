// R1/F1: the click-armed reveal in ./main.ts and the ONE place that re-applies it.
//
// `ui/turns.ts expand` reveals the pressed entry synchronously. The part of the same press
// that finishes LATER is the display tree the lazy plane reads for the opened row (T24): it
// grows the conversation ABOVE the pressed row and the transcript keeps its numeric scroll
// offset, so the viewport slides off the row the reader clicked. `main.ts` therefore keeps
// `revealEntry` — the entry the click asked to see — and `revalidateReveal` re-applies the
// same `block:'nearest'` reveal from `repaintPlane`, the paint that adopts a lazily read
// tree.
//
// This file pins the whole arm/disarm contract against the real shell (the board-level suites
// cannot see it: the arm lives in the pane closure and only `repaintPlane` dials it):
//
//   (a) a press ARMS, and the tree that lands re-reveals the pressed tile EXACTLY ONCE with
//       `{ block: 'nearest' }` — the completion of the click, not a second gesture;
//   (b) it DISARMS on a reader gesture in the log (wheel / pointerdown / keydown), when the
//       expansion moves to another surface, and when the board is cleared — in every one of
//       those the late tree lands and moves NOTHING;
//   (c) F3: a press that does NOT change which surface is open (a button or chip inside the
//       conversation already being read) leaves no request behind, so a background repaint
//       cannot re-land a tile the reader is deep inside.
//
// The tree reads are HELD by the fixture, which is what makes "the repaint did/did not
// re-reveal" a fact the test controls instead of a race.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts reveal-revalidation-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionThread, SessionTurn } from '../server/protocol';
import { viewAwareFetch } from './view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly.',
        instruction: 'Answer.',
        guidelines: []
    }
];

const thread = (): SessionThread =>
    ({
        id: 'thread-a',
        agent: 'instruct',
        origin: 'host',
        status: 'idle',
        sequence: 1,
        label: 'IN1',
        messages: [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'first answer' }
        ]
    }) as SessionThread;

// The DELEGATED conversation: the roster joins the nested invocation `inv-9` to a persistent
// thread, which is what turns that card's header press into a conversation focus (F3b).
const childThread = (): SessionThread =>
    ({
        id: 'thread-child',
        agent: 'helper',
        origin: 'agent',
        status: 'idle',
        sequence: 2,
        label: 'HP1',
        ownerThreadId: 'thread-a',
        invocationId: 'inv-9',
        messages: [{ role: 'assistant', content: 'child answer' }]
    }) as SessionThread;

// The head exchange also delegates, so the conversation card carries a nested child card the
// reader can press.
const eventsOf = (index: number): unknown[] =>
    index === 0
        ? [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'tool_call', agent: 'instruct', call: { id: 'd1', name: 'delegate', arguments: '{}' } },
            { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-9' } },
            { type: 'text', agent: 'instruct', delta: 'answer 0' }
        ]
        : [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: `answer ${index}` }
        ];

const turn = (id: string, index: number): SessionTurn =>
    ({
        id,
        index,
        prompt: `task ${index}`,
        threadId: 'thread-a',
        status: 'done',
        startedAt: T + index,
        updatedAt: T + index + 1,
        events: eventsOf(index)
    }) as SessionTurn;

// ONE settled conversation with two exchanges of its own: the multi-entry thread the report
// is about, and the two rows the arm can be moved between.
const conversation = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T,
        messages: [],
        turns: [turn('turn-0', 0), turn('turn-1', 1)],
        threads: [thread(), childThread()],
        actions: []
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
};

// --- the display-read gate ---------------------------------------------------

type Gate = {
    // Every tree route the shell asked for, in the order it asked.
    reads: string[];
    // Trees still sitting unanswered (the repaint they would cause has not happened).
    held(): string[];
    // Answer the held read for ONE turn; the answer comes from the canonical double.
    release(turnId: string): void;
};

let gate: Gate | undefined;

const stubServer = (): Gate => {
    const reads: string[] = [];
    const held: { turnId: string; answer: () => void }[] = [];

    const fixture = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api') {
            return json({
                rootPath: '/api',
                presets: [descriptor()],
                tools: [],
                defaults,
                sessions: [conversation()],
                agents
            });
        }
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && init?.method === undefined) return json({ session: conversation() });
        // T1/R1: one click on the pill's delete sends this DELETE, and the shell clears the
        // board when it comes back.
        if (url === '/api/sessions/s1' && init?.method === 'DELETE') return json({ deleted: true });

        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    }, { root: '/api' });

    // The gate wraps the double rather than replacing the route: the tree answer is the one
    // the double composes from the fixture, it is only DELIVERED when the test says so. Every
    // other read (rows, roster, metadata) answers immediately, so the only repaint in flight is
    // the one being released.
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const bare = url.split('?')[0] ?? url;

            if (bare.endsWith('/display') && init?.method === undefined) {
                reads.push(bare);

                return await new Promise<Response>((resolve) => {
                    const [turnId] = bare.split('/turns/')[1]?.split('/') ?? [];

                    held.push({
                        turnId: turnId ?? bare,
                        answer: () =>
                            void Promise.resolve(fixture(input, init)).then((answer) => {
                                // The double composes every tree route from the fixture, so
                                // "no answer" here is a fixture bug: fail the request loudly
                                // instead of resolving it with `undefined` and hanging the
                                // client on a shape the wire never sends.
                                resolve(answer ?? json({ error: `no tree for ${bare}` }, 500));
                            })
                    });
                });
            }

            const answer = fixture(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return {
        reads,
        held: () => held.map((entry) => entry.turnId),
        release: (turnId: string) => {
            const index = held.findIndex((entry) => entry.turnId === turnId);

            if (index === -1) throw new Error(`nothing held for ${turnId}; held=${held.join(',')}`);
            held.splice(index, 1)[0]?.answer();
        }
    };
};

// --- DOM probes ---------------------------------------------------------------

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

// The transcript rows, in recorded order (`turns[0]` is the conversation's head exchange).
const tiles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.tile')];

const press = (tile: HTMLElement): void => {
    const select = tile.querySelector<HTMLButtonElement>(':scope > .tile-select');

    if (select === null) throw new Error('missing the tile header');
    select.click();
};

// Which node a reveal was asked for, plus the exact request: `${id}:${args}`. A delegated
// card names its CONVERSATION (that row IS the surface), an exchange names its TURN; the tile
// card carries `data-turn-id`, and a card nested inside it must not read as its owner's turn.
const revealSpy = (): string[] => {
    const calls: string[] = [];

    (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = function (
        this: HTMLElement,
        arg?: unknown
    ) {
        const id =
            this.dataset.persistentThread ??
            this.getAttribute('data-turn-id') ??
            this.querySelector('[data-turn-id]')?.getAttribute('data-turn-id') ??
            'unknown';

        calls.push(`${id}:${JSON.stringify(arg ?? null)}`);
    };

    return calls;
};

const nativeScrollIntoView: unknown = (HTMLElement.prototype as unknown as { scrollIntoView?: unknown })
    .scrollIntoView;

// Boot the shell against the gated server with the conversation remembered.
const boot = async (): Promise<Gate> => {
    localStorage.setItem(SESSION_KEY, 's1');

    const instance = stubServer();
    gate = instance;

    await import('./main');
    await flush();
    await flush();

    expect(tiles()).toHaveLength(2);

    return instance;
};

const NEAREST = '{"block":"nearest"}';

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
    gate = undefined;

    if (nativeScrollIntoView === undefined) {
        delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    } else {
        (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView =
            nativeScrollIntoView;
    }
});

it('re-reveals the pressed tile exactly once when its lazily read tree lands (R1)', async () => {
    const server = await boot();

    // The open policy asked for BOTH trees and the gate is holding both, so no repaint can
    // have happened yet and the tile bodies are still empty.
    // Newest first: the open policy asks for the tail before the older rows it must not fetch.
    expect(server.held().sort()).toEqual(['turn-0', 'turn-1']);

    const revealed = revealSpy();
    const [head] = tiles();

    press(head);

    // The board's own synchronous reveal for the pressed entry — and nothing else, because the
    // tree that grows this row has not arrived.
    expect(head.classList.contains('is-expanded')).toBe(true);
    expect(revealed).toEqual([`turn-0:${NEAREST}`]);

    server.release('turn-0');
    await flush();

    // The tree adopted by the plane is the completion of that press, so this is the ONE
    // legitimate re-reveal: same element, same minimal request, one call for one repaint.
    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-0:${NEAREST}`]);

    // A repaint with nothing new to adopt repeats nothing: the arm survives, `nearest` is a
    // no-op while the row is on screen, and the second tree landing re-reveals at most once.
    server.release('turn-1');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-0:${NEAREST}`, `turn-0:${NEAREST}`]);
});

it('does not re-reveal after the reader scrolls the transcript themselves (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);
    expect(revealed).toEqual([`turn-0:${NEAREST}`]);

    // A wheel is the reader moving their own position; the click's request is retired with it.
    // It is also NOT what a programmatic reveal fires (that is a `scroll` event), so the
    // reveal cannot disarm itself.
    byClass('.log-wrap', 'div').dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

    server.release('turn-0');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`]);
});

it('does not re-reveal after a pointerdown in the transcript (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);

    // A scrollbar drag starts this way, and a press elsewhere in the pane is a new intent.
    byClass('.log-wrap', 'div').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    server.release('turn-0');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`]);
});

it('does not re-reveal after a keyboard gesture in the transcript (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);

    byClass('.log-wrap', 'div').dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' })
    );

    server.release('turn-0');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`]);
});

it('re-reveals the surface that is open now, never the exchange the reader left (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head, other] = tiles();

    // Two presses: the arm is RECOMPUTED, so only the surface open at the end is still owed a
    // reveal — the first entry's request is spent.
    press(head);
    press(other);

    expect(other.classList.contains('is-expanded')).toBe(true);
    expect(head.classList.contains('is-expanded')).toBe(false);
    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-1:${NEAREST}`]);

    server.release('turn-0');
    await flush();

    // turn-0's tree arrives; the row it would have moved is no longer the opened surface, so
    // the viewport is not touched on its behalf.
    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-1:${NEAREST}`, `turn-1:${NEAREST}`]);
});

it('re-reveals nothing once the conversation itself is closed (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);
    expect(revealed).toEqual([`turn-0:${NEAREST}`]);

    // The same header again is the deliberate unfocus: no surface is open, so the press leaves
    // no reveal request for a late paint to act on.
    press(head);
    expect(document.querySelector('.tile.is-expanded')).toBeNull();

    server.release('turn-0');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`]);
});

it('re-reveals nothing after the board is cleared with the rows (R1 disarm)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);
    expect(revealed).toEqual([`turn-0:${NEAREST}`]);

    // Deleting the conversation clears the board: the rows the reveal could act on are gone,
    // and the pane drops the request with them.
    byClass('.harness-title-button', 'button').click();
    byClass('.session-pill[data-session-id="s1"] .session-pill-delete', 'button').click();
    await flush();
    await flush();

    expect(document.querySelector('.tile')).toBeNull();

    server.release('turn-0');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`]);
});

it('leaves the reader alone when a press does not change the open surface (F3)', async () => {
    const server = await boot();
    const revealed = revealSpy();
    const [head] = tiles();

    press(head);
    server.release('turn-0');
    await flush();

    // Opening the conversation is a change of surface: press reveal + the one re-reveal its
    // own tree earns.
    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-0:${NEAREST}`]);

    // A press INSIDE the conversation that is already open — the bar's own frame here, which
    // carries the Delete/Transcript buttons but is not itself an action. Nothing about the
    // opened surface changes, so nothing is armed.
    const bar = head.querySelector<HTMLElement>(':scope > .tile-transcript-action');

    if (bar === null) throw new Error('missing the conversation action bar');
    bar.click();

    expect([...document.querySelectorAll('.tile.is-expanded')]).toEqual([head]);

    // The second tree lands and repaints the grown document. The reader is reading inside this
    // very tile, so the tile is taller than the viewport: re-arming on the inert press is what
    // used to drag them back to its edge.
    server.release('turn-1');
    await flush();

    expect(revealed).toEqual([`turn-0:${NEAREST}`, `turn-0:${NEAREST}`]);
});

it('keeps the reveal owed to a focused delegated child row (F3b)', async () => {
    const server = await boot();

    // The nested child card is part of the HEAD exchange's tree, so that tree has to be
    // adopted before there is a card to press. Releasing it before any press keeps the
    // repaint itself silent: nothing is armed yet.
    server.release('turn-0');
    await flush();

    const revealed = revealSpy();
    const childRow = document.querySelector<HTMLElement>(
        '.thread-row[data-persistent-thread="thread-child"]'
    );

    if (childRow === null) throw new Error('missing the delegated child card');

    const header = childRow.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select');

    if (header === null) throw new Error('missing the delegated child header');
    header.click();

    // Pressing that card focuses the CHILD conversation, which detaches the tile expansion:
    // there is no expanded tile to follow any more, and the node the board revealed is the
    // child's own row (`ui/turns.ts` `focusChildThread`, a gesture).
    expect(document.querySelector('.tile.is-expanded')).toBeNull();
    expect(childRow.classList.contains('is-expanded')).toBe(true);
    expect(revealed).toEqual([`thread-child:${NEAREST}`]);

    // The second tree lands and repaints the grown document, which inserts content ABOVE that
    // card. The delegated row is still the open surface, so the press is still owed its
    // position — this is the lazy-growth reveal the tile-only arm used to drop.
    server.release('turn-1');
    await flush();

    expect(revealed).toEqual([`thread-child:${NEAREST}`, `thread-child:${NEAREST}`]);
});
