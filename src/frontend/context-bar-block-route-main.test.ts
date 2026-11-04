// T11 (R3 + R8): the ONE lazy route the context bar can cost, proven at SHELL level.
//
// The tile-level suite (./ui/turns-context-bar.test.ts) drives the board with an INJECTED
// loader, so it proves the click contract while saying nothing about the client that answers
// it. This file removes that seam: the shell boots against the composed views adapter
// (./view-test-support.ts), which serves `GET /views/:id/turns/:turnId/blocks/:blockId` from
// the SAME raw session record the rest of the test declares. A segment click therefore goes
// through `createApi.getBlockDetail` (./api.ts) -> `getBlockDetail` (./view-api.ts) ->
// `blockDetailPayloadOf` (./view-detail.ts) -> the dialog (./ui/context-detail.ts), which is
// the whole path a browser takes and nothing short of it.
//
// What is pinned, in order:
//   - painting a recorded turn costs NO detail request at all (R3 — no eager fetching, and
//     the bar is metadata only: the recorded argument string appears nowhere on it);
//   - one click costs EXACTLY ONE request, on the block route, addressed by the segment's
//     server-assigned id (R8 — the full detail is the click's answer, not a hover, and not
//     the lazy STEP route the tool card used);
//   - the answer carries the recorded text in full, which is the only place it appears;
//   - a second click is served from the detail cache and a different segment costs its own
//     request, because the cache is keyed per block (R7 — hundreds of segments stay cheap).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts context-bar-block-route-main.test.ts
import type {
    HarnessAssistantMessage,
    HarnessDescriptor,
    SessionSnapshot,
    SessionTurn
} from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;

// Long enough that the bar's figures and the dialog's text are unmistakably different
// surfaces: the strip carries `args 56 + result 63`, the dialog carries these strings.
const ARGS = '{"path":"notes/context-bar.md","pattern":"segment","limit":20}';
const RESULT = [
    'read: 3 matches',
    'notes/context-bar.md:12 the segment is the recorded context entry',
    'notes/context-bar.md:41 one bar per user-delimited turn'
].join('\n');
const PROMPT = 'describe the context bar in this file, every line of the record';

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

const assistant = (): HarnessAssistantMessage =>
    ({
        role: 'assistant',
        content: 'the recorded answer',
        reasoning: '',
        toolCalls: [],
        model: 'm1',
        stopReason: 'stop'
    }) as HarnessAssistantMessage;

const snapshot = (turns: SessionTurn[]): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns,
        harnessDefinition: descriptor()
    }) as unknown as SessionSnapshot;

// One recorded turn, settled: the exact shape the restore path serves, so the fold behind
// the adapter is the same fold a cold reload runs (../shared/turn-display.ts `displayOfTurn`).
const recorded = (): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: PROMPT,
        status: 'done',
        startedAt: T,
        updatedAt: T + 3000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'tool_call', agent: 'instruct', call: { id: 'c1', name: 'read', arguments: ARGS } },
            { type: 'tool_result', agent: 'instruct', name: 'read', content: RESULT, isError: false, callId: 'c1' },
            { type: 'text', agent: 'instruct', delta: 'the recorded answer' },
            { type: 'done', agent: 'instruct', message: assistant() }
        ],
        eventTimes: [T, T + 200, T + 1200, T + 1500, T + 2000]
    }) as SessionTurn;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

// The strict shell stub, wrapped in the views adapter. Every call is logged BEFORE the route
// is answered, so a request the adapter COMPOSES is still visible as the URL the browser
// actually asked for — which is exactly what "one request, on the block route" needs.
const stubShell = (turns: SessionTurn[]): { url: string; method: string | undefined }[] => {
    const session = snapshot(turns);
    const calls: { url: string; method: string | undefined }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;

            calls.push({ url, method });

            if (url === '/api')
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [session],
                    agents
                });
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: [session] });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    return calls;
};

const blockCalls = (
    calls: { url: string; method: string | undefined }[]
): { url: string; method: string | undefined }[] => calls.filter((call) => call.url.includes('/blocks/'));

const segmentsOf = (tile: HTMLElement): HTMLElement[] =>
    Array.from(tile.querySelectorAll<HTMLElement>('.context-bar-segment'));

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

it('costs no detail request to paint, and exactly one to open a segment', async () => {
    const calls = stubShell([recorded()]);
    localStorage.setItem(SESSION_KEY, 's1');

    await import('./main');
    await flush();
    await flush();

    const tile = byClass('.tile', 'article');
    const segments = segmentsOf(tile);

    // R7: the turn's context is ONE strip, in the server's order, and the call is a segment
    // of it — not a card, and not one strip per section.
    expect(tile.querySelectorAll('.context-bar')).toHaveLength(1);
    expect(tile.querySelectorAll('.tool')).toHaveLength(0);
    expect(segments.map((node) => node.dataset.blockId)).toEqual([
        '0-user-prompt',
        '0-tool-1',
        '0-assistant-3'
    ]);

    const callSegment = segments[1];

    // The strip carries FIGURES only. The exact recorded characters are on it (args + result),
    // and the recorded strings are not — that is the whole reason the detail is a click away.
    expect(callSegment.dataset.chars).toBe(String(ARGS.length + RESULT.length));
    expect(callSegment.dataset.durationMs).toBe('1000');
    expect(tile.textContent ?? '').not.toContain(ARGS);
    expect(tile.textContent ?? '').not.toContain(RESULT);

    // R3: nothing was fetched to paint this turn — no block route, and no step route either.
    expect(blockCalls(calls)).toHaveLength(0);
    expect(calls.filter((call) => call.url.includes('/steps/'))).toHaveLength(0);
    expect(document.querySelector('.dialog')).toBeNull();

    // --- the click ---------------------------------------------------------------------
    callSegment.click();
    await flush();
    await flush();

    // R8: one request, on the block route, addressed by the SERVER's block id.
    expect(blockCalls(calls)).toEqual([
        { url: `/api/views/s1/turns/t1/blocks/0-tool-1`, method: undefined }
    ]);

    const detail = byClass('.block-detail', 'div');

    expect(detail.dataset.kind).toBe('tool');
    expect(detail.dataset.blockId).toBe('0-tool-1');
    expect(detail.dataset.status).toBe('full');
    expect(document.querySelector('.dialog-title')?.textContent).toBe('read · tool · ok');
    // The recorded halves, verbatim and complete — the click's whole point.
    expect(document.querySelector<HTMLElement>('[data-pane="args"]')?.textContent).toContain(ARGS);
    expect(document.querySelector<HTMLElement>('[data-pane="result"]')?.textContent).toContain(RESULT);
    // The metadata line states the figures the strip was built from, plus the answer's size.
    const fact = (name: string): string | undefined =>
        document.querySelector<HTMLElement>(`.block-detail-fact[data-fact='${name}']`)?.textContent;

    expect(fact('kind')).toBe('tool · ok');
    expect(fact('chars')).toBe(`${ARGS.length + RESULT.length} characters recorded`);
    expect(fact('split')).toBe(`args ${ARGS.length} + result ${RESULT.length}`);
    expect(fact('answer')).toBe(`answer ${ARGS.length + RESULT.length} characters`);
    expect(fact('time')).toBe('time taken 1.0s');

    // A second click is the cache, not the network.
    callSegment.click();
    await flush();

    expect(blockCalls(calls)).toHaveLength(1);
    expect(byClass('.block-detail', 'div').dataset.status).toBe('cached');

    // A different segment is a different block, so it pays its own one request (R7: hundreds
    // of segments stay affordable because the cache is per block, not per turn).
    segments[0].click();
    await flush();
    await flush();

    expect(blockCalls(calls).map((call) => call.url)).toEqual([
        '/api/views/s1/turns/t1/blocks/0-tool-1',
        '/api/views/s1/turns/t1/blocks/0-user-prompt'
    ]);
    expect(byClass('.block-detail', 'div').dataset.kind).toBe('user');
    expect(document.querySelector<HTMLElement>('[data-pane="text"]')?.textContent).toContain(PROMPT);
});
