// R11 live-shell wiring: a transcript file link uses the EXISTING tool endpoint.
//
// The unit tests cover the dialog and the DOM transform. This test pins the seam
// the shell owns: clicking a file link posts one bounded `read` call through
// `api.callTool`, with no new route and no auto-fetch — and (R11+) a link that names
// a file by BARE BASENAME first posts one `glob` lookup through that same endpoint,
// then reads the path the lookup found.
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
        coreTools: ['toolRequest', 'toolCreate', 'task'],
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

const stubServer = (restored: SessionSnapshot, globFiles?: string[]): Call[] => {
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

            if (url === '/api/tools/read' && method === 'POST') {
                // The dialog reads `files[]` structurally, and the fixture echoes the
                // requested path so a test can tell WHICH file the shell asked for.
                const requested = String(
                    (body as { parameters?: { path?: string }[] } | undefined)?.parameters?.[0]?.path ?? ''
                );

                return json({
                    ok: true,
                    result: {
                        files: [
                            {
                                path: requested,
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

            if (url === '/api/tools/glob' && method === 'POST') {
                // R11+: the basename resolver asks the real `glob` tool with an OBJECT
                // argument, and `glob` answers `{ files, truncated }` with paths
                // relative to the `'.'` root it walked — exactly the workspace-root
                // shape `read` resolves against.
                return json({ ok: true, result: { files: globFiles ?? [], truncated: false }, durationMs: 4 });
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

it('opens a bounded read through the existing tool endpoint', async () => {
    const restored = snapshot({ turns: [turn()] });
    localStorage.setItem(SESSION_KEY, 's1');
    const calls = stubServer(restored);

    await import('./main');
    await flush();

    const link = document.querySelector<HTMLButtonElement>('.turn-prompt button.file-link');
    expect(link?.dataset.path).toBe('src/frontend/main.ts');

    link?.click();
    await flush();

    const toolCalls = calls.filter((call) => call.url === '/api/tools/read');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.method).toBe('POST');
    expect(toolCalls[0]?.body).toEqual({
        parameters: [{ path: 'src/frontend/main.ts', startLine: 1, maxLines: 200 }]
    });
    // A path that already names its directory needs no lookup: the resolver stays
    // out of the way, so a complete reference is one request, exactly as before.
    expect(calls.filter((call) => call.url === '/api/tools/glob')).toHaveLength(0);

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

// R11+ — the "clicking a file shows nothing" case: a transcript reference that names
// a file WITHOUT its directory used to go straight to `read` and fail with ENOENT.
// The shell now supplies a `glob`-backed resolver, so the same click walks the
// workspace root once and opens the real file.
it('resolves a bare basename through glob and reads the real workspace path', async () => {
    const restored = snapshot({ turns: [turn({ prompt: 'open descriptors.ts please' })] });
    localStorage.setItem(SESSION_KEY, 's1');
    const calls = stubServer(restored, [
        'src/frontend/ui/descriptors.ts',
        // A substring hit is a DIFFERENT file: the dialog filter must drop it even
        // though the walk offered it (a real `glob` root can return one for a
        // `**/*name*` style query).
        'src/frontend/ui/old-descriptors.ts'
    ]);

    await import('./main');
    await flush();

    const link = document.querySelector<HTMLButtonElement>('.turn-prompt button.file-link');
    expect(link?.dataset.path).toBe('descriptors.ts');

    link?.click();
    await flush();

    // One lookup, with the exact `glob` argument the adapter promises: `**/` can
    // consume zero directories, so the pattern also covers a root-level file.
    const globCalls = calls.filter((call) => call.url === '/api/tools/glob');
    expect(globCalls).toHaveLength(1);
    expect(globCalls[0]?.body).toEqual({
        parameters: { patterns: ['**/descriptors.ts'], paths: ['.'], maxResults: 100 }
    });

    // …and the read names the RESOLVED path, not the bare name that used to ENOENT.
    const readCalls = calls.filter((call) => call.url === '/api/tools/read');
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]?.body).toEqual({
        parameters: [{ path: 'src/frontend/ui/descriptors.ts', startLine: 1, maxLines: 200 }]
    });

    const dialog = document.querySelector<HTMLElement>('.dialog');
    expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('src/frontend/ui/descriptors.ts');
    expect(dialog?.querySelector('.preview-meta')?.textContent).toBe(
        'src/frontend/ui/descriptors.ts · typescript · lines 1–1'
    );
    expect(dialog?.querySelector('.preview-code code')?.textContent).toBe('export const answer = 42;\n');

    dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
});

it('lists every match instead of reading blindly when the bare name is ambiguous', async () => {
    const restored = snapshot({ turns: [turn({ prompt: 'open descriptors.ts please' })] });
    localStorage.setItem(SESSION_KEY, 's1');
    const calls = stubServer(restored, [
        'src/a/descriptors.ts',
        'packages/underload/harness/src/b/descriptors.ts'
    ]);

    await import('./main');
    await flush();

    document.querySelector<HTMLButtonElement>('.turn-prompt button.file-link')?.click();
    await flush();

    // Nothing is read until the reader chooses, so a wrong guess cannot happen.
    expect(calls.filter((call) => call.url === '/api/tools/read')).toHaveLength(0);

    const dialog = document.querySelector<HTMLElement>('.dialog');
    expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('descriptors.ts · 2 files');
    const candidates = [...(dialog?.querySelectorAll<HTMLButtonElement>('.preview-candidate') ?? [])];
    expect(candidates.map((button) => button.dataset.path)).toEqual([
        'src/a/descriptors.ts',
        'packages/underload/harness/src/b/descriptors.ts'
    ]);

    candidates[1]?.click();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/glob')).toHaveLength(1);
    expect(calls.filter((call) => call.url === '/api/tools/read')).toHaveLength(1);
    expect(calls.filter((call) => call.url === '/api/tools/read')[0]?.body).toEqual({
        parameters: [{ path: 'packages/underload/harness/src/b/descriptors.ts', startLine: 1, maxLines: 200 }]
    });
    expect(dialog?.querySelector('.dialog-title')?.textContent).toBe(
        'packages/underload/harness/src/b/descriptors.ts'
    );

    dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
});

it('says the file was not found instead of reading a path that cannot exist', async () => {
    const restored = snapshot({ turns: [turn({ prompt: 'open descriptors.ts please' })] });
    localStorage.setItem(SESSION_KEY, 's1');
    const calls = stubServer(restored, []);

    await import('./main');
    await flush();

    document.querySelector<HTMLButtonElement>('.turn-prompt button.file-link')?.click();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/read')).toHaveLength(0);

    const dialog = document.querySelector<HTMLElement>('.dialog');
    expect(dialog?.querySelector('.preview-error')?.textContent).toBe(
        'descriptors.ts was not found under the workspace root; the reference may be incomplete.'
    );
    expect(dialog?.querySelector('.preview-code')).toBeNull();

    dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
});
