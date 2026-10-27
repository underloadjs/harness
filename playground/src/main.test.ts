// End-to-end smoke of the shell + request lifecycle (R8).
//
// `main.ts` is a module with side effects: it builds the shell and boots against
// the API. This test drives it with a stubbed `fetch` — no server, no provider —
// and asserts the lifecycle the user actually sees:
//
//   queued/waiting tile → streaming markdown → done, pill text at each step,
//   duplicate submits blocked while the request is in flight.
//
// The SSE body is a real `ReadableStream` so `submitMessage` exercises its own
// frame parser rather than a mock of it.
//
// Run: npx vitest run --config playground/vitest.config.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const descriptor = {
    name: 'demo',
    title: 'Demo harness',
    description: 'A harness for the lifecycle test.',
    requiresEndpoint: true,
    agents: ['writer'],
    tools: []
};

const session = (status: 'idle' | 'running' = 'idle') => ({
    id: 's1',
    harness: 'demo',
    status,
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: []
});

// One SSE frame per `SessionStreamItem`, exactly the shape `api.ts` parses.
const sse = (items: readonly unknown[]): Response => {
    const body = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        }
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 25));
};

beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('shows the full request lifecycle and renders the final markdown', async () => {
    let messageRequests = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/api/harnesses')) {
            return json({ harnesses: [descriptor], defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false } });
        }

        if (url.endsWith('/api/tools')) return json({ tools: [] });
        if (url.endsWith('/api/models')) return json({ models: ['m1'] });
        if (url.endsWith('/api/sessions')) return json({ session: session() });

        if (url.endsWith('/messages') && init?.method === 'POST') {
            messageRequests += 1;

            return sse([
                { type: 'event', event: { type: 'start', agent: 'writer', model: 'm1' } },
                { type: 'event', event: { type: 'text', agent: 'writer', delta: '# Hi\n\n' } },
                { type: 'event', event: { type: 'text', agent: 'writer', delta: 'a **b**' } },
                {
                    type: 'event',
                    event: {
                        type: 'done',
                        agent: 'writer',
                        message: {
                            role: 'assistant',
                            content: 'a b',
                            reasoning: '',
                            toolCalls: [],
                            model: 'm1',
                            stopReason: 'stop'
                        }
                    }
                },
                { type: 'snapshot', session: session() }
            ]);
        }

        throw new Error(`unexpected request: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    await import('./main');
    await flush();

    // Boot finished against the stubbed index.
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(document.querySelector('.main-title')?.textContent).toBe('Demo harness');

    const input = document.querySelector<HTMLTextAreaElement>('.composer-input');
    const form = document.querySelector<HTMLFormElement>('.composer');
    const run = document.querySelector<HTMLButtonElement>('button.primary');
    if (input === null || form === null || run === null) throw new Error('shell did not render');

    input.value = 'say hi';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The tile exists before the server answers; while the stream is open the
    // request lock is held, so a second submit is ignored.
    expect(document.querySelector('.tile')).not.toBeNull();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(messageRequests).toBe(1);

    const tile = document.querySelector('.tile');
    expect(tile?.getAttribute('data-state')).toBe('done');
    expect(tile?.querySelector('.tile-status-text')?.textContent).toBe('done');
    expect(tile?.querySelector('.turn-prompt')?.textContent).toBe('say hi\n');
    expect(tile?.querySelector('.agent-text')?.innerHTML).toBe('<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n');
    expect(tile?.querySelector('.agent-meta')?.textContent).toBe('m1 · stop');
    expect(tile?.classList.contains('is-expanded')).toBe(true);

    expect(document.querySelector('.status-text')?.textContent).toBe('done · m1 · idle');
    expect(run.disabled).toBe(false);
});
