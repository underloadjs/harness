// R11 live-shell wiring: a transcript file link uses the EXISTING tool endpoint.
//
// The unit tests cover the dialog and the DOM transform. This test pins the seam
// the shell owns: clicking a file link posts one bounded `fileRead` call through
// `api.callTool`, with no new route and no auto-fetch.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts transcript-preview-main.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'todoManage'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'read src/frontend/main.ts',
        status: 'done',
        startedAt: T,
        updatedAt: T,
        events: [],
        ...overrides
    }) as SessionTurn;

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
};

type Call = { url: string; method: string | undefined; body: unknown };

const stubServer = (restored: SessionSnapshot): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [restored],
                    agents: []
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: restored });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: [restored] });

            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start() {
                            // Snapshot-only test: the boot snapshot already hydrated.
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/tools/fileRead' && method === 'POST') {
                return json({
                    ok: true,
                    result: {
                        files: [
                            {
                                path: 'D:/repo/src/frontend/main.ts',
                                content: 'export const answer = 42;\n',
                                startLine: 1,
                                endLine: 1,
                                truncated: false,
                                nextLine: null,
                                nextColumn: null,
                                bytes: 26
                            }
                        ],
                        truncated: false,
                        bytes: 26,
                        contentBudget: 65536
                    },
                    durationMs: 3
                });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    return calls;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('opens a bounded fileRead through the existing tool endpoint', async () => {
    const restored = snapshot({ turns: [turn()] });
    localStorage.setItem(SESSION_KEY, 's1');
    const calls = stubServer(restored);

    await import('./main');
    await flush();

    const link = document.querySelector<HTMLButtonElement>('.turn-prompt button.file-link');
    expect(link?.dataset.path).toBe('src/frontend/main.ts');

    link?.click();
    await flush();

    const toolCalls = calls.filter((call) => call.url === '/api/tools/fileRead');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.method).toBe('POST');
    expect(toolCalls[0]?.body).toEqual({
        parameters: [{ path: 'src/frontend/main.ts', startLine: 1, maxLines: 200 }]
    });

    const dialog = document.querySelector<HTMLElement>('.dialog');
    expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('src/frontend/main.ts');
    expect(dialog?.querySelector('.preview-code code')?.textContent).toBe('export const answer = 42;\n');
    expect(dialog?.textContent).not.toContain('base64');

    // The composer is NOT the dialog's focus owner: opening a preview never pulls
    // the caret back into the field.
    expect(document.activeElement).not.toBe(document.querySelector('.composer-input'));

    dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
    expect(document.querySelector('.dialog')).toBeNull();
});
