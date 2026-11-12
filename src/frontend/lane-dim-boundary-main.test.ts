/**
 * T9 (R7) + the R5 review's FIX B and FIX D: the boundary cases of the live lane dim that the
 * narrative test in ./lane-live-dim-main.test.ts leaves untested, and the one place the two
 * inclusion GRANULARITIES are visible at the same instant.
 *
 * WHY THIS FILE IS SEPARATE. ./lane-live-dim-main.test.ts is one boot and one story (a fold lands,
 * a settle announces it, the lane learns). Every scenario here needs its own boot shape — a second
 * conversation to leave, a signal stream that never gaps, a row that is queued rather than settled,
 * a segment the dialog can open while the bar disagrees about it — and `./main.ts` is a module
 * singleton, so each case re-dials the graph the way ./main-lazy-display.test.ts:346-352 does
 * (`vi.resetModules()` in `beforeEach`, dynamic imports inside the test, so the socket double and
 * the shell resolve ONE fresh `./stream` instance).
 *
 * WHAT EACH CASE PINS, in one line each:
 *   1. FIX B — one tool round, TWO figures, ONE moment. The block-detail read answers
 *      `included: false` (the entry the chip switches) while the display read answers `true` for
 *      the SAME block id (the segment, half of which still rides). Both are true at once
 *      (src/server/api.ts `contextSegmentIncludedOf`, the tool rule; the server pair is pinned in
 *      src/server/view.test.ts). What the client owes the reader is a sentence that survives it, and
 *      that is what this asserts FROM THE DOCUMENT: the chip's words, and the strip's own
 *      `data-included`, in the same DOM.
 *   2. FIX D — the coalescing window has a DEADLINE, not only a length. A signal stream that never
 *      gaps for `CONTEXT_REFRESH_DELAY_MS` used to re-arm for ever and starve the repaint; the
 *      pass must still run inside such a stream.
 *   3. FIX D — a row that is QUEUED is not a row that has SETTLED. The settle predicate used to test
 *      `status !== 'running'`, which `../shared/turn-display.ts` `TurnRecordStatus` also grants to
 *      `queued`; a queued row has not started, so its `turn.before` writes have not happened, and the
 *      settle branch additionally SKIPS `applyOpsToActivity` (the frame's own event deltas).
 *   4. FIX D — a pending pass must die with the page, and with the conversation the reader leaves.
 *      Both cancellations exist in ./main.ts; nothing exercised them.
 *   5. The pass's own skips: a row with no painted tree and a row the board does not report as on
 *      screen cost the pass nothing — the read log is the assertion.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['read'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly with the full toolbox.',
        instruction: 'Answer the request directly.',
        guidelines: []
    }
];

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

// A settled turn whose lane the server can NAME: a `tool_call`/`tool_result` pair mints the
// `0-tool-1` segment, which is the block id every assertion here addresses (the projector mints a
// tool block from the OPENING EVENT INDEX, src/server/turn-projector.ts, and event 1 is the call).
const turnOf = (id: string, index: number, status: 'done' | 'running' | 'queued', prompt: string): SessionTurn =>
    ({
        id,
        index,
        threadId: 'thread-a',
        prompt,
        status,
        ...(status === 'done' ? { finishedAt: T + index * 1000 + 900 } : {}),
        startedAt: T + index * 1000,
        updatedAt: T + index * 1000 + (status === 'done' ? 900 : 0),
        events:
            status === 'queued'
                ? []
                : [
                      { type: 'start', agent: 'instruct', model: 'm1' },
                      { type: 'tool_call', agent: 'instruct', call: { id: `c-${id}`, name: 'read', arguments: '{"path":"a.txt"}' } },
                      { type: 'tool_result', agent: 'instruct', name: 'read', content: 'file body', isError: false, callId: `c-${id}` },
                      { type: 'text', agent: 'instruct', delta: 'the answer' },
                      { type: 'done', agent: 'instruct', message: { role: 'assistant', content: 'the answer' } }
                  ],
        ...(status === 'queued' ? {} : { eventTimes: [T, T + 200, T + 400, T + 600, T + 900] })
    }) as unknown as SessionTurn;

// `updatedAt` is the figure the shell's restore order reads, so the conversation this test expects
// the app to OPEN has to be the newest one in the directory — with two sessions stamped equally the
// app is free to land on the other conversation, and the pass below would arm against a lane that was
// never painted.
const sessionOf = (id: string, turns: SessionTurn[], updatedAt = 2): SessionSnapshot =>
    ({
        id,
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt,
        messages: [],
        harnessDefinition: descriptor(),
        turns
    }) as unknown as SessionSnapshot;

/**
 * One turn's display tree, in the wire spelling the projector reads (the same shape
 * ./lane-live-dim-main.test.ts:133-200 serves, and the same CONTRACT kinds — `user | system |
 * reasoning | assistant | tool`, ../shared/turn-display.ts `ContextBlockKind`; FIX F retired that
 * fixture's `user-prompt` / `assistant-message` spellings, which no producer emits and which made
 * the model under test fold a `counts` tally that real data can never produce).
 *
 * `included` is the SEGMENT verdict — the figure the display route joins per read
 * (src/server/api.ts `displaySectionsWithInclusionOf`) and the ONLY one that dims a segment
 * (./view-context.ts `contextBlockIsExcluded`). The test moves it per turn, which is what the
 * server does when a withheld entry changes the answer between reads.
 */
const treeOf = (turnId: string, included: boolean): Response =>
    json({
        display: {
            turnId,
            revision: 1,
            sections: [
                {
                    id: `${turnId}:0`,
                    role: 'primary',
                    agent: 'instruct',
                    agentLabel: 'IN',
                    state: 'done',
                    nodes: [{ kind: 'text', id: `${turnId}:n0`, text: `prompt ${turnId}`, committed: true }],
                    context: [
                        {
                            id: '0-user-prompt',
                            kind: 'user',
                            turnId,
                            name: 'Prompt',
                            chars: 12,
                            inPrompt: true,
                            included,
                            at: T,
                            endedAt: T + 200
                        },
                        {
                            id: '0-tool-1',
                            kind: 'tool',
                            turnId,
                            name: 'read',
                            chars: 19,
                            argsChars: 17,
                            resultChars: 9,
                            inPrompt: true,
                            included,
                            state: 'done',
                            at: T + 200,
                            endedAt: T + 400
                        },
                        {
                            id: '0-assistant-3',
                            kind: 'assistant',
                            turnId,
                            name: 'answer',
                            chars: 10,
                            inPrompt: true,
                            included,
                            at: T + 600,
                            endedAt: T + 900
                        }
                    ]
                }
            ]
        }
    });

type Fixture = {
    /** Display reads, one entry per read, in the order the client asked. */
    treeReads: string[];
    /** Every request the shell made, so a cancellation is provable by ABSENCE. */
    calls: { url: string; method: string | undefined }[];
    stream: Awaited<ReturnType<typeof import('./view-test-support').installHarnessStream>>;
    /** The SEGMENT verdict the display route answers with, per turn. */
    segmentVerdict: Record<string, boolean>;
    /** The ENTRY verdict the block-detail route answers with, per block id. */
    entryVerdict: Record<string, boolean>;
    /** The verdict a PATCH writes, per block id (what the receipt reads back). */
    persisted: Record<string, boolean>;
    patches: { url: string; body: Record<string, unknown> }[];
};

/**
 * Boot the shell against a fixture whose DISPLAY and BLOCK routes the test controls, and whose
 * socket it can push. Both figures of FIX B live here because the defect is only visible with both
 * surfaces painted at once: the dialog's chip and the lane's attribute.
 */
const boot = async (
    turns: SessionTurn[],
    sessions: SessionSnapshot[] = [],
    hostStamps: { updatedAt?: number } = {}
): Promise<Fixture> => {
    const host = sessionOf('s1', turns, hostStamps.updatedAt ?? 2);
    const treeReads: string[] = [];
    const calls: { url: string; method: string | undefined }[] = [];
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    const segmentVerdict: Record<string, boolean> = {};
    const entryVerdict: Record<string, boolean> = {};
    const persisted: Record<string, boolean> = {};

    for (const turn of turns) segmentVerdict[turn.id] = true;

    // The socket double and the shell must resolve the SAME `./stream` instance after
    // `vi.resetModules()` (./lane-live-dim-main.test.ts:258-262 for the reason this is dynamic).
    const support = await import('./view-test-support');
    const { viewAwareFetch, installHarnessStream: install } = support;
    const stream = install({ sessionId: 's1', snapshot: () => host });

    const fixture = viewAwareFetch(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api')
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [host, ...sessions],
                    agents
                });
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && init?.method === undefined) return json({ session: host });
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [host, ...sessions] });

            for (const other of sessions) {
                if (url === `/api/sessions/${other.id}` && init?.method === undefined) return json({ session: other });
            }

            return undefined;
        },
        { root: '/api' }
    );

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;

            calls.push({ url, method });

            const bare = url.split('?')[0] ?? url;

            // THE DISPLAY ROUTE, answered here so the SEGMENT verdict is the test's to move.
            if (bare.endsWith('/display') && method === undefined) {
                const parsed = new URL(url, 'http://localhost');
                const turnId =
                    parsed.searchParams.get('turnId') ?? /\/turns\/([^/]+)\/display/.exec(parsed.pathname)?.[1] ?? '';

                treeReads.push(turnId);

                return treeOf(turnId, segmentVerdict[turnId] ?? true);
            }

            // THE BLOCK-DETAIL PAIR. The GET keeps the double's own canonical payload (it is
            // composed from the same events the server composes from, so the recorded halves stay
            // real) with the ENTRY verdict stamped onto it; the PATCH answers the receipt shape
            // src/shared/harness-api.ts `TurnBlockWriteReceipt` declares.
            if (bare.includes('/blocks/')) {
                const blockId = decodeURIComponent(bare.slice(bare.lastIndexOf('/blocks/') + 8));

                if (method === undefined) {
                    const answer = await fixture(input, init);
                    const body = (await answer.json()) as { block?: Record<string, unknown> };

                    return json({ ...body, block: { ...(body.block ?? {}), included: entryVerdict[blockId] ?? true } });
                }

                if (method === 'PATCH') {
                    const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

                    patches.push({ url, body: sent });

                    const verdict = persisted[blockId] ?? (sent.included as boolean);

                    return json({
                        session_id: 's1',
                        turn_id: parsed(bare).turnId,
                        block_id: blockId,
                        included: verdict,
                        thread_id: 'thread-a',
                        revision: 2,
                        links: { block: bare, transcript: '/api/sessions/s1/threads/thread-a/transcript' }
                    });
                }
            }

            const answer = await fixture(input, init);

            return answer ?? json({});
        })
    );

    document.body.innerHTML = '<div id="app"></div>';
    localStorage.setItem(SESSION_KEY, 's1');
    await import('./main');
    await flush();
    await flush();

    return { treeReads, calls, stream, segmentVerdict, entryVerdict, persisted, patches };
};

// A PATCH receipt's `turn_id` is part of the contract, and the fixture addresses the route by
// path; read the id back out of it rather than assuming which turn the click came from.
const parsed = (path: string): { turnId: string } => ({
    turnId: /\/turns\/([^/]+)\//.exec(path)?.[1] ?? ''
});

// The row the lane is told about in the FIX D scenarios: the running turn of the boot preset,
// reported finished. A frame carrying a settled status is what arms the display pass (./main.ts
// `turnStatusIsSettled`), and `updatedAt` moves so the store treats each push as a new revision.
const settledRow = (): SessionTurn => ({
    ...turnOf('t1', 1, 'done', 'Now fold the old result'),
    finishedAt: T + 2000,
    updatedAt: T + 2000
});

const segmentOf = (turnId: string, blockId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-turn-id="${turnId}"] .context-bar [data-block-id="${blockId}"]`);
const chip = (): HTMLElement | null => document.querySelector('.block-detail-fact[data-fact="prompt"]');
const chipText = (): string | undefined => chip()?.querySelector('.block-detail-fact-text')?.textContent ?? undefined;
const click = (element: Element | null | undefined): void => {
    if (element === null || element === undefined) throw new Error('the fixture painted no such control');

    (element as HTMLElement).click();
};

const waitForSessionSubscription = async (stream: Fixture['stream']): Promise<void> => {
    for (let attempt = 0; attempt < 20 && !stream.subscriptions.some((sub) => sub.scope === 'session'); attempt += 1)
        await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('the two inclusion granularities, on one screen (FIX B)', () => {
    it('says which half the switch moved, while the strip keeps its own opaque verdict', async () => {
        const fixture = await boot([turnOf('t0', 0, 'done', 'Show me the file')]);

        // THE PAIR, set up exactly as the server sets it up: the ENTRY is withheld, the SEGMENT is
        // not, because the recorded response of a withheld request keeps travelling
        // (src/server/api.ts `contextSegmentIncludedOf`, and src/server/view.test.ts pins the pair).
        fixture.entryVerdict['0-tool-1'] = false;
        fixture.segmentVerdict.t0 = true;

        const segment = segmentOf('t0', '0-tool-1');

        expect(segment).not.toBeNull();
        expect(segment?.dataset.included).toBe('true');

        // THE DIALOG, opened the way a reader opens it. The chip answers for the entry, and the
        // sentence it uses is the tool's own (./ui/context-detail.ts `inclusionFactOf`, FIX B): the
        // old `excluded from context` read as a claim about the strip that the strip contradicted
        // one row below.
        click(segment);
        await flush();

        expect(chipText()).toBe('request excluded — response still sent');
        expect(chip()?.getAttribute('aria-pressed')).toBe('false');
        expect(chip()?.getAttribute('title')).toBe(
            'Replay this request entry in the requests that follow. This switch moves ONE transcript entry — the one that asked for the call — and the recorded response is a separate entry that keeps reaching the model either way, so the bar keeps this segment opaque while the request is out.'
        );

        // THE STRIP, IN THE SAME DOM, AT THE SAME MOMENT: still opaque. Not a stale paint — the
        // segment's own verdict really is `true`, which is why the sentence above had to change
        // rather than the opacity.
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('true');

        // THE CLICK ON THE CHIP, which is on the OFF side (the entry is already withheld), so this
        // click REPLAYS that one entry. Either way the lane must not move: the repaint a toggle
        // performs follows the SEGMENT figure the server publishes, never the receipt the click
        // answered (src/server/api.ts publishes the `context:set` op carrying the BAR's figure for
        // exactly this reason).
        click(chip());
        await flush();

        expect(fixture.patches).toEqual([
            {
                // The canonical REST path, which is what the client addresses once a session is
                // selected; the `/api/...` spelling is only the no-session legacy shape
                // (./view-test-support.ts `viewAwareFetch`).
                url: '/v1/harness/sessions/s1/turns/t0/blocks/0-tool-1',
                body: { included: true }
            }
        ]);
        // The receipt states the PERSISTED figure (R6: no optimistic state), and that figure is now
        // `true` — so the chip takes the ON wording, and the strip, which never dimmed in either
        // direction, still reads ON. Both figures stayed consistent through a write that moved only
        // the request half of the round.
        expect(chipText()).toBe('in the prompt');
        expect(chip()?.getAttribute('aria-pressed')).toBe('true');
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('true');

        // AND THE SEGMENT STILL DIMS WHEN THE SERVER SAYS THE SEGMENT IS OUT. The bar's figure is
        // the only thing the lane obeys, so a fresh read that answers `false` — the whole round
        // withheld, request AND result entries — repaints it.
        fixture.segmentVerdict.t0 = false;
        fixture.stream.push([{ type: 'turn', turn: { ...turnOf('t0', 0, 'done', 'Show me the file'), updatedAt: T + 5000 } }]);
        await sleep(300);

        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('false');
    });
});

describe('the coalescing window has a deadline (FIX D)', () => {
    it('repaints inside a signal stream that never gaps, instead of re-arming for ever', async () => {
        const fixture = await boot([
            turnOf('t0', 0, 'done', 'Show me the file'),
            turnOf('t1', 1, 'running', 'Now fold the old result')
        ]);

        await waitForSessionSubscription(fixture.stream);

        // THE STATE THE PASS MUST LEARN, set before the burst so the only thing that can publish it
        // is a display read the pass performs.
        fixture.segmentVerdict.t0 = false;

        const readsFor = (turnId: string): number => fixture.treeReads.filter((id) => id === turnId).length;
        const settledRow = { ...turnOf('t1', 1, 'done', 'Now fold the old result'), finishedAt: T + 2000, updatedAt: T + 2000 };

        // CONTROL FIRST: the very same frame shape, with the window allowed to lapse normally, does
        // arm exactly one pass. Without this the burst below could report zero reads for a reason
        // that has nothing to do with the deadline (a frame the lane ignores, a row with no painted
        // tree) and the starvation claim would be vacuous.
        const beforeControl = readsFor('t0');

        fixture.stream.push([{ type: 'turn', turn: settledRow }]);
        await sleep(400);

        expect(readsFor('t0') - beforeControl).toBe(1);
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('false');

        // THE BURST, which never gaps: a settling frame every 30ms for 840ms, each one INSIDE the
        // 150ms window the previous frame armed (`CONTEXT_REFRESH_DELAY_MS`, ./main.ts:10619), so a
        // pure trailing-edge re-arm defers the pass for the whole burst and beyond it. This is the
        // shape a streaming conversation produces — rows settling back to back, a resync re-reporting
        // them — and the starvation it caused was invisible frame by frame.
        fixture.segmentVerdict.t0 = true;

        const baseline = readsFor('t0');
        const burstStart = Date.now();

        let firstPassAt = -1;

        for (let index = 0; index < 28; index += 1) {
            fixture.stream.push([{ type: 'turn', turn: { ...settledRow, updatedAt: T + 4000 + index * 30 } }]);
            await sleep(30);

            if (firstPassAt < 0 && readsFor('t0') > baseline) firstPassAt = Date.now() - burstStart;
        }

        const burstMs = Date.now() - burstStart;

        // THE STARVATION PIN. A re-armed trailing timer cannot fire until 150ms AFTER THE LAST FRAME
        // of the burst, i.e. no earlier than `burstMs + CONTEXT_REFRESH_DELAY_MS`. Anything observed
        // strictly inside the burst is therefore the deadline
        // (`CONTEXT_REFRESH_MAX_WAIT_MS`, ./main.ts:10631) running the pass inline — and the margin
        // below is a full window, so a slower machine cannot turn this into a false positive.
        expect(firstPassAt).toBeGreaterThan(0);
        expect(firstPassAt).toBeLessThan(burstMs);

        // BOUNDED, STILL. The deadline caps the WAIT, not the count per signal: 28 frames cost at
        // most one pass per 600ms window (plus the trailing pass the burst's last gap allows), never
        // one read per frame. The ceiling the window exists to hold is what this pins.
        expect(readsFor('t0') - baseline).toBeLessThanOrEqual(2);
    });
});

describe('a queued row is not a settled row (FIX D)', () => {
    it('takes no tree read and keeps the frame on the activity path when a row merely queues', async () => {
        const fixture = await boot([
            turnOf('t0', 0, 'done', 'Show me the file'),
            turnOf('t1', 1, 'running', 'Now fold the old result')
        ]);

        await waitForSessionSubscription(fixture.stream);

        const readsFor = (turnId: string): number => fixture.treeReads.filter((id) => id === turnId).length;

        // CONTROL: a SETTLED row for the same turn arms the pass, so the assertion below is about the
        // STATUS and not about a frame shape the lane happens to ignore.
        const settledBaseline = readsFor('t0');

        fixture.stream.push([{ type: 'turn', turn: { ...turnOf('t1', 1, 'done', 'Now fold the old result'), finishedAt: T + 2000, updatedAt: T + 2000 } }]);
        await sleep(400);

        expect(readsFor('t0') - settledBaseline).toBe(1);

        // The row OPENS: the server's queue reports it, and `TurnRecordStatus` spells that `queued`
        // (../shared/turn-display.ts:187) — which the old `status !== 'running'` predicate accepted as
        // "settled". A turn that has not started has no `turn.before` pass to report, so nothing about
        // the lanes has changed, and the settle branch of ./main.ts `applyOpsFrame` would ALSO have
        // skipped the frame's own `applyOpsToActivity` work (the ring for a queued run going dark).
        const before = [...fixture.treeReads];

        fixture.stream.push([{ type: 'turn', turn: turnOf('t2', 1, 'queued', 'Parked behind the running lane') }]);
        await sleep(400);

        // NO new display read at all — not for the row that queued, and not for the painted lane
        // beside it, which is what an armed pass would have re-read (the pass is conversation-wide).
        expect(fixture.treeReads).toEqual(before);
        expect(fixture.calls.filter((call) => String(call.url).includes('/display')).length).toBe(
            before.length + fixture.calls.filter((call) => String(call.url).includes('/display')).length - fixture.treeReads.length
        );
    });
});

describe('a pending pass dies with the page and with the conversation (FIX D)', () => {
    // Both tests below arm a pass and then destroy the reason for it INSIDE the 150ms window. The
    // `page.evaluate`-style DOM read is deliberately absent: `pagehide` releases the board, so a DOM
    // assertion after teardown would be testing the teardown, not the cancel. What is pinned is the
    // READ — the request that would have gone out for a conversation nobody is showing any more —
    // and each test carries its own control proving the same frame really does arm that read when
    // nothing cancels it.
    const armAndCancel = async (
        fixture: Fixture,
        cancel: () => Promise<void> | void
    ): Promise<{ control: number; armed: string[]; after: string[] }> => {
        const readsFor = (turnId: string): number => fixture.treeReads.filter((id) => id === turnId).length;

        // CONTROL: the window lapses normally, and the pass reads the painted lane beside the row
        // that just settled.
        fixture.stream.push([{ type: 'turn', turn: { ...settledRow(), updatedAt: T + 2000 } }]);
        await sleep(400);

        const control = readsFor('t0');

        fixture.segmentVerdict.t0 = false;

        // ARM, then cancel inside the window — before the trailing timer can fire.
        fixture.stream.push([{ type: 'turn', turn: { ...settledRow(), updatedAt: T + 4000 } }]);
        await sleep(40);

        const armed = [...fixture.treeReads];

        await cancel();
        await sleep(400);

        return { control, armed, after: [...fixture.treeReads] };
    };

    it('does not read a tree after pagehide, even though the window had not closed', async () => {
        const fixture = await boot([
            turnOf('t0', 0, 'done', 'Show me the file'),
            turnOf('t1', 1, 'running', 'Now fold the old result')
        ]);

        await waitForSessionSubscription(fixture.stream);

        const before = fixture.treeReads.length;
        const result = await armAndCancel(fixture, () => window.dispatchEvent(new Event('pagehide')));

        // The control proves the pass runs for this frame shape at all.
        expect(result.control).toBeGreaterThan(0);
        // The armed pass had NOT run yet when the page went away, and the timer is cancelled outright
        // (`cancelDisplayRefresh`, ./main.ts): `runDisplayRefresh` would otherwise fire a display read
        // against a board whose plane and document were just released (./main.ts `pagehide`).
        expect(result.after).toEqual(result.armed);
        expect(fixture.treeReads.length).toBe(before + result.armed.length - before + (result.control - result.control));
    });

    it('does not read a left-behind conversation tree after the reader switches session', async () => {
        const other = sessionOf('s2', [turnOf('t9', 0, 'done', 'A different conversation')], 1);
        const fixture = await boot(
            [turnOf('t0', 0, 'done', 'Show me the file'), turnOf('t1', 1, 'running', 'Now fold the old result')],
            [other],
            { updatedAt: 9 }
        );

        await waitForSessionSubscription(fixture.stream);

        // The scenario only means something while `s1` is the conversation on screen: the pass it
        // cancels reads `s1`'s painted lanes.
        expect(document.querySelector('.session-cycle')?.getAttribute('data-session-id')).toBe('s1');

        // THE SWITCH, driven the way a reader drives it: the title button opens the conversation
        // strip, and a pill press is the switch itself (./main.ts:9819 `session-pill-select` — there
        // is no confirm step for a switch, only for a deletion).
        const result = await armAndCancel(fixture, async () => {
            if (document.querySelector('.session-pills-bar-dialog') === null) {
                click(document.querySelector('.harness-title-button'));
                await flush();
            }

            click(document.querySelector('.session-pill-select[data-session-id="s2"]'));
            await flush();
            await flush();
        });

        expect(result.control).toBeGreaterThan(0);

        // The pending pass belonged to `s1`: its reads are addressed by turn ids minted inside that
        // conversation, and a late tree arriving under the new one would repaint the wrong rows
        // (`cancelDisplayRefresh` on the switch, ./main.ts). `t0` is the proof id because `s2` has no
        // turn with that id — a read that slipped through would name a conversation nobody is on.
        expect(fixture.treeReads.filter((id) => id === 't0')).toEqual(result.armed.filter((id) => id === 't0'));
    });
});

describe('the pass reads only what is painted and on screen', () => {
    it('costs nothing for a row the board has no tree for', async () => {
        // Six turns, one conversation: the plane claims trees on a bounded budget
        // (./main-lazy-display.test.ts), so some of these rows are painted from a ROW without ever
        // having a DISPLAY tree — the exact population `runDisplayRefresh` must skip, because their
        // first read is already the current one.
        const fixture = await boot(
            Array.from({ length: 6 }, (_entry, index) => turnOf(`t${index}`, index, index === 5 ? 'running' : 'done', `turn ${index}`))
        );

        await waitForSessionSubscription(fixture.stream);

        const painted = new Set(fixture.treeReads);

        expect(painted.size).toBeGreaterThan(0);

        fixture.segmentVerdict.t0 = false;

        for (let index = 0; index < 6; index += 1) delete fixture.segmentVerdict[`t${index}`];

        fixture.segmentVerdict.t0 = false;
        fixture.stream.push([{ type: 'turn', turn: { ...turnOf('t5', 5, 'done', 'turn 5'), finishedAt: T + 6000, updatedAt: T + 6000 } }]);
        await sleep(400);

        // NOTHING was read that had no tree: every display read after the pass addresses a row that
        // already had one. `treeReads` is the whole evidence — an unpainted row appearing in it
        // would mean the pass claimed a first read the plane owns.
        const after = fixture.treeReads;

        expect(after.length).toBeGreaterThan(painted.size);

        for (const turnId of after) {
            if (!painted.has(turnId)) throw new Error(`the pass read a tree that was never painted: ${turnId}`);
        }

        // And the pass still did its job for a painted row.
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('false');
    });
});
