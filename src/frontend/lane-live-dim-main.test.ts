/**
 * T9 (R7): the lane of an ALREADY-PAINTED tile goes dim when a `turn.before` plugin withholds
 * context — with no operator reload and no click.
 *
 * WHY A RE-READ IS THE ONLY HOOK THE TRIMMER HAS (the finding this test pins). The shipped trimmer
 * (../plugins/context-trimmer.plugin.ts:36-59) withholds entries at `turn.before` through the
 * context-port setter, which writes `included: false` ONTO the canonical committed message IN PLACE
 * (../harness.ts `writeIncluded`, 8721-8730) and reports the write as canonical (`setIncluded` →
 * `reportCanonicalWrite`, ../harness.ts:9072-9084). That report reaches the store's state-change
 * observer (`noteStateChange`, ../server/sessions.ts:3307), which snapshots and saves WITHOUT
 * publishing a frame; `transcript.updated` is minted only inside `updateThreadTranscript`
 * (../server/sessions.ts:9273), and even then the broker routes that kind to the `thread` scope
 * alone (../server/stream/protocol.ts:73-86 + `isKindPublishedTo`, ../server/stream/broker.ts:487).
 * Meanwhile the projector NEVER mints `included` (../shared/turn-display.ts:652-670: "THE SERVER IS
 * A PRODUCER OF IT, not the fold … the projector never mints this key") — only
 * `../server/api.ts` `contextSegmentIncludedOf` stamps it, per read. So no frame can patch a painted
 * lane: the figure can only arrive on a fresh display read.
 *
 * That is why this file answers the display route itself: the fixture fold has no inclusion
 * vocabulary, so the wire tree below is the smallest payload that states the figure — `included:
 * true` on the first read, `false` on the one after the write, which is exactly what
 * `getSessionTurnDisplay` publishes for a withheld entry. Everything else is the real client: the
 * live session frame, the coalescing window, the plane's capped read queue, and the lane DOM
 * (`button.dataset.included`, ./ui/context-bar.ts:833).
 *
 * The two assertions are the two halves of R7: the flip lands with NO click and NO reload, and a
 * burst of settle frames costs ONE re-read, not one per frame.
 */
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';

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

// The agent roster the shell's right rail reads; the same descriptor the block-route fixture
// serves (./context-bar-block-route-main.test.ts:59-66), because the lane's tool segment resolves
// its label through it.
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

// Real timers throughout: the bound under test IS a timer (`CONTEXT_REFRESH_DELAY_MS`, ./main.ts).
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * An already-submitted turn (index 0, `t0`) whose context the lane can name, and the turn that is
 * RUNNING (index 1, `t1`) while the trimmer's `turn.before` pass folds the older tool result out.
 * The running row is what makes the settle frame below a RUN COMPLETING rather than a replay of an
 * already-settled row.
 */
const createHost = (): SessionSnapshot =>
    structuredClone({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        harnessDefinition: descriptor(),
        turns: [
            {
                id: 't0',
                index: 0,
                threadId: 'thread-a',
                prompt: 'Show me the file',
                status: 'done',
                startedAt: T,
                finishedAt: T + 900,
                updatedAt: T + 900,
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    { type: 'tool_call', agent: 'instruct', call: { id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' } },
                    { type: 'tool_result', agent: 'instruct', name: 'read', content: 'file body', isError: false, callId: 'c1' },
                    { type: 'text', agent: 'instruct', delta: 'the answer' },
                    { type: 'done', agent: 'instruct', message: { role: 'assistant', content: 'the answer' } }
                ],
                eventTimes: [T, T + 200, T + 400, T + 600, T + 900]
            },
            {
                id: 't1',
                index: 1,
                threadId: 'thread-a',
                prompt: 'Now fold the old result',
                status: 'running',
                startedAt: T + 1000,
                updatedAt: T + 1000,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }],
                eventTimes: [T + 1000]
            }
        ]
    }) as unknown as SessionSnapshot;

/**
 * One turn's display tree in the WIRE spelling the projector reads (`turnId`, `sections`,
 * `agentLabel` — ../shared/harness-api.ts display subtree, projected by ./display-project.ts), and
 * the LANE the read publishes: `context` blocks carrying the `included` figure that is the whole
 * subject of this file (../shared/turn-display.ts:567-628, ./types.ts `ContextBlock`). The shared
 * descriptor does not require `context` — the lane is the frontend's own contract — so the response
 * validator passes it through verbatim, which is how the block-route fixture's segments exist.
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
                            role: 'user',
                            label: 'Prompt',
                            turnId,
                            index: 0,
                            content: `prompt ${turnId}`,
                            chars: 12,
                            tokens: 11,
                            inPrompt: true,
                            included,
                            nodes: [
                                { index: 0, kind: 'user', role: 'user', label: 'Prompt', content: `prompt ${turnId}`, tokens: 11, contentLength: 12 }
                            ]
                        },
                        {
                            id: '0-tool-1',
                            kind: 'tool',
                            role: 'tool',
                            label: 'read',
                            turnId,
                            index: 1,
                            content: 'file body',
                            chars: 19,
                            argsChars: 17,
                            resultChars: 9,
                            tokens: 512,
                            inPrompt: true,
                            included,
                            state: 'done',
                            nodes: [
                                { index: 1, kind: 'tool', role: 'tool', label: 'read', content: 'file body', meta: 'read · ok', tokens: 512, contentLength: 19 }
                            ]
                        },
                        {
                            id: '0-assistant-3',
                            kind: 'assistant',
                            role: 'assistant',
                            label: 'Assistant',
                            turnId,
                            index: 3,
                            content: 'the answer',
                            chars: 10,
                            tokens: 9,
                            inPrompt: true,
                            included,
                            nodes: [
                                {
                                    index: 3,
                                    kind: 'assistant',
                                    role: 'assistant',
                                    label: 'Assistant',
                                    content: 'the answer',
                                    tokens: 9,
                                    contentLength: 10
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    });

/**
 * The settled form of the running turn: what a `{type:'turn'}` frame on the SESSION scope carries
 * when the run ends. The double folds it exactly like the store's watcher does
 * (`toViewItem`, ./view-test-support.ts:358-392 — a TERMINAL record settles the projector), and the
 * ops that reach the client are a ROW patch plus the section patches of the turn that just closed —
 * never a tree for the tile that was already painted, which is the gap this file closes.
 */
const settledTurn = (): Record<string, unknown> => ({
    id: 't1',
    index: 1,
    threadId: 'thread-a',
    prompt: 'Now fold the old result',
    status: 'done',
    startedAt: T + 1000,
    finishedAt: T + 2000,
    updatedAt: T + 2000,
    events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'text', agent: 'instruct', delta: 'the folded answer' },
        { type: 'done', agent: 'instruct', message: { role: 'assistant', content: 'the folded answer' } }
    ],
    eventTimes: [T + 1000, T + 1500, T + 2000]
});

const segmentOf = (turnId: string, blockId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-turn-id="${turnId}"] .context-bar [data-block-id="${blockId}"]`);

// The canonical display route carries the turn in its query (?turnId=…, ./api.ts `getDisplay`); the
// legacy spelling carries it in the path. Both are read out here so the read log is a turn id per
// entry rather than a URL.
const turnIdOf = (url: string): string => {
    const parsed = new URL(url, 'http://localhost');

    return parsed.searchParams.get('turnId') ?? /\/turns\/([^/]+)\/display/.exec(parsed.pathname)?.[1] ?? '';
};

describe('the live lane dim (T9 R7)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        localStorage.clear();
        document.body.innerHTML = '';
    });

    it('dims a painted tile when the run that withheld its context settles, and folds a burst of settles into one re-read', async () => {
        // What the server says about each turn's lane AT THE MOMENT THE READ IS ANSWERED. Flipping
        // `t0` is the stand-in for `turn.before setIncluded`: the fold cannot carry the figure, so
        // only a display read can state it, and a read after the write must answer differently.
        const withheld: Record<string, boolean> = { t0: true, t1: true };
        const treeReads: string[] = [];
        const host = createHost();

        // The socket double and the shell must resolve the SAME `./stream` module instance, and the
        // double owns the global socket: both come from a fresh graph here (./main-lazy-display
        // .test.ts:543-545 for the reason this is a dynamic import).
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
                        sessions: [host],
                        agents
                    });
                if (url === '/api/models') return json({ models: ['m1'] });
                if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [host] });
                if (url === '/api/sessions/s1' && init?.method === undefined) return json({ session: host });

                return undefined;
            },
            { root: '/api' }
        );

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const bare = url.split('?')[0] ?? url;

                // The tree route is answered HERE so the `included` figure is the test's to move.
                if (bare.endsWith('/display') && init?.method === undefined) {
                    const turnId = turnIdOf(url);
                    treeReads.push(turnId);

                    return treeOf(turnId, withheld[turnId] ?? true);
                }

                const answer = fixture(input, init);

                return answer instanceof Promise ? await answer : answer;
            })
        );

        // The shell mounts into `#app` (./main.ts:2435) — the same mount every sibling
        // frontend test sets up before it imports the entrypoint.
        document.body.innerHTML = '<div id="app"></div>';
        localStorage.setItem(SESSION_KEY, 's1');
        await import('./main');
        await flush();
        await flush();

        const toolSegment = segmentOf('t0', '0-tool-1');

        // Both lanes are painted and nothing is withheld yet: the figure the first read stated is
        // the figure the bar shows, and each painted tile cost exactly one tree read.
        expect(toolSegment).not.toBeNull();
        expect(toolSegment?.dataset.included).toBe('true');
        expect(segmentOf('t1', '0-tool-1')?.dataset.included).toBe('true');
        expect(treeReads.filter((turnId) => turnId === 't0')).toEqual(['t0']);
        expect(treeReads.filter((turnId) => turnId === 't1')).toEqual(['t1']);

        // --- the fold lands while the run is still going ------------------------------------
        withheld.t0 = false;

        // Frames are addressed to a SUBSCRIPTION, and the client writes its `subscribe` only after
        // the double's welcome answers (./stream.ts queues it), so the push waits for the session
        // subscription it means — the same order the real server has. NOTHING here is clicked: R7
        // is the operator watching a run finish, not operating on a tile.
        for (let attempt = 0; attempt < 20 && !stream.subscriptions.some((sub) => sub.scope === 'session'); attempt += 1)
            await flush();

        stream.push([{ type: 'turn', turn: settledTurn() }]);
        await sleep(30);

        // INSIDE the coalescing window (`CONTEXT_REFRESH_DELAY_MS = 150`, ./main.ts) nothing has
        // been re-read for the tile the fold touched: the settle frame alone does not repaint a
        // lane, and a re-read per frame is exactly what the bound forbids.
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('true');
        expect(treeReads.filter((turnId) => turnId === 't0')).toEqual(['t0']);
        // The settling row's OWN tree is the one thing that is read immediately, and not by this
        // pass: a row that settles without a flow subscription is stale by construction, and the
        // settle path claims one bounded tree read for it (`refreshUnopenedTree`, T44). Because
        // that claim already covers the row, the pass must — and does — exclude it.
        expect(treeReads.filter((turnId) => turnId === 't1')).toEqual(['t1', 't1']);

        // --- the window closes -------------------------------------------------------------
        await sleep(250);

        // R7: the lane of a tile the reader never touched learned the truth by itself — no click,
        // no reload, no new transport. The segment is QUERIED FROM THE DOCUMENT rather than read
        // off the handle captured above: adopting a fresh tree repaints the bar (./ui/turns.ts
        // `syncContextBar`), and a repaint rebuilds the strip's elements.
        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('false');
        // One re-read for the tile the fold touched, and NO second one for the row the settle path
        // had already re-read — the exclusion in `DisplayRefreshPass.exceptTurnIds`.
        expect(treeReads.filter((turnId) => turnId === 't0')).toEqual(['t0', 't0']);
        expect(treeReads.filter((turnId) => turnId === 't1')).toEqual(['t1', 't1']);

        // --- the bound, measured against a burst -------------------------------------------
        // Five settling frames in one synchronous burst — what a resync, a queued run, or a row the
        // subscription keeps re-reporting produces. A naive listener re-reads five times per tile;
        // the trailing window RE-ARMS, so the burst costs ONE pass.
        const before = treeReads.length;

        withheld.t0 = true;

        for (let index = 0; index < 5; index += 1) stream.push([{ type: 'turn', turn: settledTurn() }]);

        await sleep(350);

        expect(segmentOf('t0', '0-tool-1')?.dataset.included).toBe('true');
        // TWO reads for five signals — one per painted lane, never one per signal. The settled row
        // rejoins this pass because its one bounded settle claim (T44) was spent on the first
        // settle, so nothing else has covered it.
        expect(treeReads.length - before).toBe(2);
        expect(treeReads.filter((turnId) => turnId === 't0')).toEqual(['t0', 't0', 't0']);
        expect(treeReads.filter((turnId) => turnId === 't1')).toEqual(['t1', 't1', 't1']);
        if (process.env.VERBOSE === '1') console.log({ stage: 'after burst', treeReads });
    });
});
