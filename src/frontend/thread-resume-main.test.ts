// T4/R2 shell wiring: the thread action bar's Resume control dials the resume route
// `POST /sessions/{id}/threads/{tid}/resume` with an EMPTY body, on ONE press, with no
// confirmation — and the control retires from the roster the shell re-reads afterwards, not
// from a local flag.
//
// This is the wiring proof the standalone board test cannot give:
//   - `main.ts` passes `resumeThread` into the board (exactly how `stopThread`/`deleteThread`
//     reach it), so a `stopped` conversation's bar shows a LIVE Resume instead of a
//     disabled one that only states a missing transport;
//   - one press sends exactly ONE resume with no request body (the server re-submits the
//     input it recorded on the interrupted turn), and no confirmation layer, no `/cancel`
//     and no `DELETE` ever appear;
//   - the receipt's continuation turn is NOT hand-painted: `resumeThreadForSession` applies
//     the roster document `resumeViewThread` re-reads through `applyView`, and THAT frame is
//     what hides the control and turns the destructive slot back into `Stop`;
//   - a refusal (the server's 409 "the answer was already reached") surfaces through the
//     board's error notice with the server's own sentence — no silent failure — and the same
//     control is pressable again with the conversation still on screen.
//
// `main.ts` boots on import, so (exactly like thread-stop-main.test.ts) the fixture stubs
// fetch and opens a saved session through the raw routes; `viewAwareFetch` compiles the
// answers into the display wire. The `/events` route is here because the conversation is
// running again the moment the resume lands, and a running conversation makes the shell
// subscribe to its flow.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-resume-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
    HarnessDescriptor,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../server/protocol';
import type { TaskReceipt } from '../shared/harness-api';
import { viewAwareFetch } from './view-test-support';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
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
        description: 'Answers directly.',
        instruction: 'Answer.',
        guidelines: []
    }
];

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const thread = (overrides: Partial<SessionThread> = {}): SessionThread => ({
    id: 'thread-a',
    agent: 'instruct',
    origin: 'host',
    status: 'stopped',
    sequence: 1,
    label: 'IN1',
    invocationIds: ['inv-a'],
    messages: [
        { role: 'user', content: 'hello thread' },
        { role: 'assistant', content: 'half an answer' }
    ],
    ...overrides
});

// The interrupted turn: the thread was halted mid-flight, so the row is `cancelled` (it
// never reached an answer) and the resume route's guard considers it replayable.
const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-a',
    index: 0,
    prompt: 'hello thread',
    threadId: 'thread-a',
    status: 'cancelled',
    startedAt: T,
    updatedAt: T + 100,
    events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'text', agent: 'instruct', delta: 'half an answer' }
    ],
    eventTimes: [T, T + 50],
    ...overrides
});

// The conversation as the server holds it when the host has stopped it: the row is on
// screen, the thread is `stopped`, and nothing is running.
const stopped = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [turn()],
        threads: [thread()]
    }) as SessionSnapshot;

// What the roster re-read answers once the resume landed: the SAME conversation running
// again, with the interrupted turn requeued IN PLACE under its own id (rev2 pinned the v1
// fixture that invented a second `turn-b` row — the route does not mint one; the receipt and
// the ledger both name the row the halt left behind). Newer `updatedAt`, or `applyView` would
// reject it as stale. The resumed run also cleared the session's failure note (the row that
// carried it is being replayed), so no `last_error` survives in this document either.
const runningAgain = (): SessionSnapshot =>
    ({
        ...stopped(),
        status: 'running',
        updatedAt: 30,
        turns: [
            turn({
                status: 'running',
                startedAt: T + 500,
                updatedAt: T + 600,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }],
                eventTimes: [T + 500]
            })
        ],
        threads: [thread({ status: 'running' })]
    }) as SessionSnapshot;

// REV2: the state the request is about, and the one the v1 gate could never paint. A run that
// was in flight when the server died comes back as an `error` row on an `idle` conversation
// (the runtime persists a conversation as `stopped` or `idle` only), and the restore writes a
// SESSION-level pair with it: `status: 'error'` plus the sentence below as `last_error`. That
// pair is the red banner the shell paints, and the bar beside it had only Delete + Transcript.
// The literal mirrors the server's module-private `INTERRUPTED_MESSAGE` (../server/sessions.ts
// :764) — the same convention ../server/shutdown-background.test.ts:77 uses.
const RESTART_BANNER =
    'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.';

const interruptedByRestart = (): SessionSnapshot =>
    ({
        ...stopped(),
        status: 'error',
        lastError: RESTART_BANNER,
        turns: [turn({ status: 'error' })],
        threads: [thread({ status: 'idle' })]
    }) as SessionSnapshot;

// The body the resume route promises: the ORDINARY submit receipt (`TaskReceipt`), at 200,
// for the continuation turn — never a document. `turn_id` names the INTERRUPTED row (the same
// figure the roster and the ledger name), and there is no `queue_position`: the lane was free,
// so its pump moved the requeued row straight into the active slot — the exact pair the route's
// own HTTP contract pins in ../server/threads.test.ts (`thread resume HTTP contract`).
const receipt = (): TaskReceipt => ({
    session_id: 's1',
    turn_id: 'turn-a',
    status: 'queued',
    thread_id: 'thread-a',
    session_revision: 31,
    accepted_at: T + 700,
    links: {
        turn: '/v1/harness/sessions/s1/turns/turn-a',
        turns: '/v1/harness/sessions/s1/turns',
        thread: '/v1/harness/sessions/s1/threads/thread-a',
        stream: '/v1/harness/stream'
    }
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
};

// `body` is captured so the EMPTY request body of the contract is pinned, not assumed: the
// server re-submits the input it recorded, so a client-invented prompt would be a lie.
type Call = { url: string; method: string | undefined; body: BodyInit | null | undefined };

type Fixture = { calls: Call[] };

const RESUME_URL = '/api/sessions/s1/threads/thread-a/resume';

// The fixture server. `current` mutates as the write lands, so the roster re-read after the
// resume answers the RUNNING document rather than the stopped one the page opened with.
// `refuse` swaps the resume answer for the contract's 409 state guard.
const stubServer = (
    initial: SessionSnapshot,
    answer: 'accept' | 'refuse' = 'accept'
): Fixture => {
    const calls: Call[] = [];
    let current = initial;

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({ url, method, body: init?.body });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [current],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === RESUME_URL && method === 'POST') {
                if (answer === 'refuse') {
                    // The server's OWN sentence for this guard (../server/threads.test.ts pins
                    // the route's refusal surface verbatim): the newest turn is `done`, so the
                    // answer was reached. A paraphrased 409 here would let the shell's notice
                    // contract drift from what the route actually says.
                    return json(
                        { error: { message: 'Thread "thread-a" already reached its answer (turn 0 is done).' } },
                        409
                    );
                }

                current = runningAgain();

                return json(receipt());
            }

            // A running conversation makes the shell subscribe to its flow. An empty, open
            // stream is enough: every transition in this file comes from the re-read the
            // mutation performs, not from a pushed frame.
            if (url === '/api/sessions/s1/events') {
                return new Response(new ReadableStream<Uint8Array>(), {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            }

            if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    return { calls };
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The bar's third control, wherever the bar lives (the tile's bar is a direct child of the
// tile, so this selector cannot answer with a nested card's bar).
const resumeOf = (): HTMLButtonElement =>
    byClass('.tile-transcript-action .resume-open', 'button');

const expandOnlyTile = async (): Promise<HTMLElement> => {
    const tile = byClass('.tile', 'article');
    if (!tile.classList.contains('is-expanded')) {
        tile.querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();
    }
    expect(tile.classList.contains('is-expanded')).toBe(true);

    return tile;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('resumes a stopped thread with one press, an empty body and no dialog, then retires from the roster', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const fixture = stubServer(stopped());

    await import('./main');
    await flush();

    const tile = await expandOnlyTile();
    expect(tile.dataset.threadId).toBe('thread-a');

    // The bar, as the SHELL renders it: three children in the order `[Delete, Resume,
    // Transcript]`, and the middle one is live — the transport is injected, so the title
    // states the action rather than a missing route.
    const bar = byClass('.tile-transcript-action', 'div');
    expect([...bar.children].map((node) => node.className)).toEqual([
        'thread-delete',
        'resume-open action-resume',
        'transcript-open action-transcript'
    ]);

    const button = resumeOf();
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector('.action-label')?.textContent).toBe('Resume');
    expect(button.querySelector('.action-glyph')?.textContent).toBe('▶');
    expect(button.getAttribute('aria-label')).toBe('Resume thread IN1');
    expect(button.title).toBe('Resume this stopped thread');

    const before = fixture.calls.length;
    button.click();
    await flush();
    await flush();

    // Exactly ONE resume, for the pressed thread, with NOTHING in the body — and no
    // confirmation layer of any kind on this surface, which cannot prove a desktop.
    const resumes = fixture.calls
        .slice(before)
        .filter((call) => call.url === RESUME_URL);
    expect(resumes).toEqual([{ url: RESUME_URL, method: 'POST', body: undefined }]);
    expect(
        fixture.calls.filter((call) => call.url.endsWith('/cancel') || call.method === 'DELETE')
    ).toEqual([]);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);

    // The roster the shell re-read after the write is what repaints the bar: the
    // conversation is running again, so the Resume control is hidden and the destructive
    // slot has become `Stop` — from the SERVER's status, never from a local flag.
    expect(button.hidden).toBe(true);
    // `hidden` is the ONLY suppression path — the control is not force-disabled on hide, so
    // a re-published `stopped` row can put it back without a second source of truth.
    expect(button.disabled).toBe(false);
    const destructive = bar.querySelector<HTMLButtonElement>('.thread-delete');
    if (destructive === null) throw new Error('missing the destructive control');
    expect(destructive.className).toBe('thread-delete thread-stop');
    expect(destructive.querySelector('.action-label')?.textContent).toBe('Stop');

    // Transcript survives the whole exchange, still the bar's trailing control.
    const transcript = bar.querySelector<HTMLButtonElement>('.transcript-open');
    if (transcript === null) throw new Error('missing the transcript control');
    expect(transcript.hidden).toBe(false);
    expect(transcript.disabled).toBe(false);
});

it('reports a 409 refusal through the error notice and re-arms the same control', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const fixture = stubServer(stopped(), 'refuse');

    await import('./main');
    await flush();

    const tile = await expandOnlyTile();
    const button = resumeOf();
    expect(button.hidden).toBe(false);

    button.click();
    await flush();
    await flush();

    // The server's own sentence, in the BOARD's notice — the conversation is untouched and
    // the reader is never left guessing why nothing happened. Scoped to `.log` because the
    // view owns one more `.notice` node: the shell's `p.notice.session-note` outcome line
    // (main.ts:1123), which stays hidden and empty here because a refused resume is not a
    // session failure — it is reported where the press happened.
    const notices = [...document.querySelectorAll<HTMLElement>('.log .notice')];
    const notice = notices.find((node) => node.dataset.tone === 'error');
    expect(notices.map((node) => [node.dataset.tone, node.textContent])).toEqual([
        ['error', 'resume thread: Thread "thread-a" already reached its answer (turn 0 is done).']
    ]);
    expect(notice?.dataset.tone).toBe('error');
    expect(notice?.textContent).toBe(
        'resume thread: Thread "thread-a" already reached its answer (turn 0 is done).'
    );
    const sessionNote = document.querySelector<HTMLElement>('.notice.session-note');
    expect(sessionNote?.hidden).toBe(true);
    expect(sessionNote?.textContent).toBe('');

    // The request went out once, and the refused thread is still on screen with a pressable
    // Resume (the roster never changed).
    expect(
        fixture.calls.filter((call) => call.url === RESUME_URL).map((call) => call.method)
    ).toEqual(['POST']);
    expect(tile.classList.contains('is-expanded')).toBe(true);
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
});

// REV2 (R1 + R2): the case the request is about, end to end through the SHELL. A run that was
// in flight when the server died comes back as an `error` row on an `idle` conversation, with
// the restore's banner pair on the SESSION — and the v1 bar showed Delete + Transcript only,
// under a red note that stayed forever. Here the same conversation shows the play button next
// to Transcript, one press posts the empty resume body, and the roster document the shell
// re-reads afterwards repaints BOTH: the control retires (the run is in flight) and the pane's
// restart note is gone (the replay is what the note promised).
it('resumes the run a restart interrupted on an idle conversation, and clears the restart banner', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const fixture = stubServer(interruptedByRestart());

    await import('./main');
    await flush();

    // THE BANNER, before anything is pressed: the session-level note the restore wrote.
    const banner = document.querySelector<HTMLElement>('.notice.session-note');
    expect(banner?.hidden).toBe(false);
    expect(banner?.dataset.tone).toBe('error');
    expect(banner?.textContent).toBe(RESTART_BANNER);

    const tile = await expandOnlyTile();
    expect(tile.dataset.threadId).toBe('thread-a');

    // REV2: the bar offers Resume even though the roster says `idle`, because the conversation's
    // newest row ended `error`.
    const button = resumeOf();
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Resume thread IN1');

    const before = fixture.calls.length;
    button.click();
    await flush();
    await flush();

    // One resume, empty body, no dialog — the same transport contract as a stopped thread's.
    expect(fixture.calls.slice(before).filter((call) => call.url === RESUME_URL)).toEqual([
        { url: RESUME_URL, method: 'POST', body: undefined }
    ]);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);

    // THE TWO THINGS THE REQUEST ASKS FOR. The document the shell re-reads states the replay:
    // the conversation is running again, so the control is unpainted…
    expect(button.hidden).toBe(true);

    // …and the restart note is retired. It is the SESSION pair (`status` + `last_error`) the
    // restore wrote, and the resume's own write is what clears it — `sessionFailureOf` prints
    // nothing once the session is no longer an error record.
    expect(banner?.hidden).toBe(true);
    expect(banner?.textContent).toBe('');

    // The transcript action is untouched by either change, and the interrupted row was never
    // replaced by a second copy of the question.
    const transcript = byClass('.tile-transcript-action', 'div')
        .querySelector<HTMLButtonElement>('.transcript-open');
    if (transcript === null) throw new Error('missing the transcript control');
    expect(transcript.hidden).toBe(false);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
});
