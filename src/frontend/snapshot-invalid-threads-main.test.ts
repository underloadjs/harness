// C6 — `invalidThreads` survives the whole snapshot path into the frontend.
//
// The seam between the server's tolerant restore (C4) and the editable transcript (C5)
// is one field on one record: `SessionSnapshot.invalidThreads`, whose per-entry
// `messages` holds the value the harness could NOT read. Nothing may lose it on the way
// in, and nothing may re-shape it:
//
//   GET /sessions/:id ─┐
//   GET /sessions      ├─ api.ts returns the parsed body VERBATIM ── main.ts
//   POST /tasks        │                                             applySnapshot:
//   SSE snapshot frame ┘                                             { ...session,
//                                                                    turns, threads }
//
// `applySnapshot` has no field whitelist (it replaces `turns` and filters `threads`,
// and spreads everything else), so the roster reaches `instance.snapshot`, the board's
// roster projection (ui/threads.ts) and the transcript dialog unchanged. That is the
// property this shell-level test pins, end to end, through real `fetch` JSON parsing:
//
//   1. a snapshot that arrives over GET carries the unreadable conversation: its
//      `threads[]` row holds the server PLACEHOLDER and its `invalidThreads` entry holds
//      the RAW value — the board marks the card and the editor shows the raw JSON, not
//      the placeholder;
//   2. a malformed roster entry costs only itself (no card, no crash) while the valid
//      entry survives;
//   3. the roster also survives the SNAPSHOT a save returns (the same apply path), so a
//      still-unreadable transcript stays marked after the write.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts snapshot-invalid-threads-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { THREAD_TRANSCRIPT_SAVE_NOTE } from './ui/thread-transcript';
import { viewAwareFetch } from './view-test-support';

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
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const SESSION_KEY = 'underload-harness-app:session';

// Exactly the pair the store publishes for an unreadable conversation.
const ERROR = 'thread "thread-x" messages[0] must be an object';
const PLACEHOLDER = [{ role: 'system', content: `[transcript unreadable: ${ERROR}]` }];
const RAW = { edited: 'by hand', broken: [1, 2] };

const threadRow = (id: string, label: string, messages: unknown) => ({
    id,
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: id === 'thread-a' ? 1 : 2,
    label,
    messages
});

const turnRow = (id: string, threadId: string, index: number, prompt: string) => ({
    id,
    index,
    prompt,
    threadId,
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [{ type: 'start', agent: 'instruct', model: 'm1' }],
    eventTimes: [1]
});

// The document shape the server writes: one healthy conversation, one unreadable one
// (placeholder row + raw roster entry), plus a roster entry a hand-edited state file
// produced that has NO usable id.
const wireSnapshot = (): Record<string, unknown> => ({
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 5,
    messages: [],
    turns: [turnRow('turn-a', 'thread-a', 0, 'hello'), turnRow('turn-x', 'thread-x', 1, 'broken prompt')],
    threads: [
        threadRow('thread-a', 'IN1', [{ role: 'user', content: 'hello' }]),
        threadRow('thread-x', 'IN2', PLACEHOLDER)
    ],
    invalidThreads: [
        { error: 'an entry with no id cannot be joined', messages: 'junk' },
        { id: 'thread-x', label: 'IN2', agent: 'instruct', error: ERROR, messages: RAW }
    ]
});

const bootstrap = (session: Record<string, unknown>): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [session],
    agents
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
};

const card = (threadId: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`.conversation[data-thread-id="${threadId}"]`);
    if (found === null) throw new Error(`missing conversation card for ${threadId}`);
    return found;
};

// Presses the Transcript action of one conversation and waits for the freshness read.
const openTranscriptOf = async (threadId: string): Promise<HTMLElement> => {
    const open = card(threadId).querySelector<HTMLButtonElement>('.tile-transcript-action .transcript-open');
    if (open === null) throw new Error(`no transcript action on ${threadId}`);
    open.click();
    await flush();

    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no transcript dialog');
    return panel;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('carries invalidThreads from the wire into the board and the editor, verbatim', async () => {
    const snapshot = wireSnapshot();
    localStorage.setItem(SESSION_KEY, 's1');

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            if (url === '/api') return json(bootstrap(snapshot));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: snapshot });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }))
    );

    await import('./main');
    await flush();

    // 1. The roster entry reached the board's normalized roster: the unreadable
    //    conversation is marked, and the nameless entry created no phantom card.
    expect(card('thread-x').dataset.invalid).toBe('true');
    expect(card('thread-a').dataset.invalid).toBeUndefined();
    expect(document.querySelectorAll('.conversation')).toHaveLength(2);

    // 2. The dialog opens directly in the editor holding the RAW stored value, even
    //    though the applied snapshot's `threads[]` row says `PLACEHOLDER`.
    const panel = await openTranscriptOf('thread-x');
    const editor = panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (editor === null) throw new Error('the unreadable transcript did not open in the editor');

    expect(editor.value).toBe(pretty(RAW));
    expect(editor.value).not.toContain('[transcript unreadable');
    expect(panel.querySelector('.thread-transcript-json')).toBeNull();
    expect(panel.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
        `transcript unreadable: ${ERROR}`
    );
    // The readable conversation is untouched by its broken neighbour.
    expect(panel.querySelector<HTMLElement>('.thread-transcript-meta')?.textContent).toBe(
        'IN2 · instruct · idle · editing JSON'
    );
    // C6 editor scope note: only the messages are saved.
    expect(panel.querySelector<HTMLElement>('.thread-transcript-note')?.textContent).toBe(
        THREAD_TRANSCRIPT_SAVE_NOTE
    );
});

it('keeps the roster through the snapshot a save returns so the break stays visible', async () => {
    const snapshot = wireSnapshot();
    localStorage.setItem(SESSION_KEY, 's1');

    // The PUT answer is the server's real one for a still-broken write: a post-write
    // snapshot that STILL names the thread in `invalidThreads`, plus the transcript
    // document whose `messages` is the placeholder.
    const applied = {
        ...snapshot,
        updatedAt: 9,
        invalidThreads: [{ id: 'thread-x', label: 'IN2', agent: 'instruct', error: ERROR, messages: RAW }]
    };

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            if (url === '/api') return json(bootstrap(snapshot));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: snapshot });
            if (url === '/api/sessions/s1/threads/thread-x/transcript' && method === 'PUT') {
                return json({
                    session: applied,
                    transcript: {
                        threadId: 'thread-x',
                        agent: 'instruct',
                        messages: PLACEHOLDER,
                        raw: pretty(RAW),
                        invalid: { error: ERROR, messages: RAW }
                    }
                });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }))
    );

    await import('./main');
    await flush();

    const panel = await openTranscriptOf('thread-x');
    const editor = panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (editor === null) throw new Error('the unreadable transcript did not open in the editor');

    // A no-op save: the text is the raw value, and Save sends it back parsed.
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    const save = panel.querySelector<HTMLButtonElement>('.thread-transcript-save');
    if (save === null) throw new Error('the editor has no Save control');
    expect(save.disabled).toBe(false);
    save.click();
    await flush();

    // The applied PUT snapshot carried the roster again: the card is still marked, and
    // the editor still states the unreadable failure with the text unchanged.
    expect(card('thread-x').dataset.invalid).toBe('true');
    expect(panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor')?.value).toBe(
        pretty(RAW)
    );
    expect(panel.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
        `transcript unreadable: ${ERROR}`
    );
});
