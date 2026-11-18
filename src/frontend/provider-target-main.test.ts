// The provider target and the provider bounds, in the BOOTED app (T9 / AC1 + AC4).
//
// Two surfaces, one boot:
//   AC1 — the header line under the harness title states the provider this app dials
//         (`provider localhost:5500 · model basalt-8k`) WITHOUT the settings dialog being
//         opened. `main.ts` paints it from `paintHeadTitleTrigger`, the one hook every head
//         painter passes through, and its value is the session document's `endpoint` when a
//         conversation is open, else this browser's committed provider settings (which the
//         boot's `GET /config` defaults just filled).
//   AC4 — `GET /v1/harness/config.providerTimeouts` is OPTIONAL (the server side lands in
//         parallel). Both shapes are booted here, because the acceptance rule is about
//         ABSENCE: a server that does not answer the field must neither throw during boot nor
//         blank the app, and the settings line must simply not appear. The fixture answers the
//         SAME routes both times, so the only difference between the two boots is the field.
//
// The config answer carries `base_url: http://localhost:5500/...` — the port that started
// this whole change — and no session row, so the boot lands on the harness with no
// conversation and the line can only come from the effective provider settings.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts src/frontend/provider-target-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Two microtasks: the boot's `Promise.all` of six reads, then the paint that follows it.
const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    await Promise.resolve();
    await Promise.resolve();
};

const descriptor = () =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        agents: ['instruct'],
        tools: [],
        entry: 'instruct',
        ranks: { instruct: 'A' },
        builtin: true,
        editable: true
    }) as never;

const agentRows = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly.',
        has_instruction_override: false,
        has_global_override: false
    }
];

// The config document. `timeouts` is the ONLY thing that varies between the two boots.
const configDocument = (timeouts?: Record<string, number>) => ({
    defaults: { base_url: 'http://localhost:5500/providers/private/v1', model: 'basalt-8k', has_api_key: false },
    writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
    revision: 1,
    ...(timeouts === undefined ? {} : { providerTimeouts: timeouts })
});

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const page = <T>(items: T[]) => ({ items, total: items.length, has_more: false, next_cursor: null, revision: 1 });

const stubServer = (timeouts?: Record<string, number>) => {
    const calls: string[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push(`${init?.method ?? 'GET'} ${url}`);

            if (url === '/v1/harness') {
                return json({
                    api_root: '/v1/harness',
                    service: 'harness',
                    api_version: 'v1',
                    server_time: 1,
                    epoch: 'e1',
                    capabilities: {},
                    limits: { page_limit: { default: 25, max: 100 } },
                    links: {}
                });
            }
            if (url === '/v1/harness/config') return json(configDocument(timeouts));
            if (url.startsWith('/v1/harness/harnesses?')) return json(page([descriptor()]));
            if (url.startsWith('/v1/harness/tools?')) return json(page([]));
            if (url.startsWith('/v1/harness/agents?')) return json(page(agentRows));
            if (url.startsWith('/v1/harness/sessions?')) return json(page([]));
            if (url.startsWith('/v1/harness/models')) return json({ models: ['basalt-8k'] });

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        })
    );

    return { calls };
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('names the provider host and the model in the header, with the settings dialog closed (AC1)', async () => {
    stubServer({ responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 });

    await import('./main');
    await flush();

    // The app booted (a blank page would have failed every assertion below, and AC4 says
    // absence must not blank it either).
    expect(document.querySelector('.composer-input')).not.toBeNull();

    const line = document.querySelector<HTMLElement>('#harness-provider');

    expect(line).not.toBeNull();
    expect(line?.hidden).toBe(false);
    // The port that was the user's question, printed in the always-visible header.
    expect(line?.textContent).toBe('provider localhost:5500 · model basalt-8k');
    // The tooltip carries the full dialled address, path included.
    expect(line?.title).toBe('Provider base URL: http://localhost:5500/providers/private/v1');
    // ...and none of this required opening the settings layer.
    expect(document.querySelector('.endpoint-dialog')).toBeNull();
});

it('prints the provider bounds the config reports, in the settings surface (AC4)', async () => {
    stubServer({ responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 });

    await import('./main');
    await flush();

    // The settings pane is the persistent `endpointBody`, adopted into a layer only when the
    // status pill is pressed — so the query happens the way a reader reaches it, which also
    // proves the line lives in the surface that owns the Base URL field.
    document.querySelector<HTMLButtonElement>('.status-button')?.click();
    await flush();

    const dialog = document.querySelector('.endpoint-dialog');

    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('.field-input')).not.toBeNull();

    const line = dialog?.querySelector<HTMLElement>('#endpoint-timeouts');

    expect(line).not.toBeNull();
    expect(line?.hidden).toBe(false);
    expect(line?.textContent).toBe('provider timeouts · response head 30.0s · first token 1m30s · stream chunk 20.0s');
    // It reads as read-only configuration: no control is bound to it.
    expect(line?.querySelector('input, button, select')).toBeNull();
});

it('boots unchanged when the config has no providerTimeouts field at all (AC4)', async () => {
    stubServer();

    await import('./main');
    await flush();

    // No throw, no blanked UI: the composer and the provider line are still painted, and
    // the config read still filled them from `defaults`.
    expect(document.querySelector('.composer-input')).not.toBeNull();
    expect(document.querySelector('#harness-provider')?.textContent).toBe('provider localhost:5500 · model basalt-8k');

    document.querySelector<HTMLButtonElement>('.status-button')?.click();
    await flush();

    const dialog = document.querySelector('.endpoint-dialog');

    expect(dialog).not.toBeNull();
    // The dialog still owns its Base URL field — the pane did not lose a row.
    expect(dialog?.querySelector('.field-input')).not.toBeNull();

    const line = dialog?.querySelector<HTMLElement>('#endpoint-timeouts');

    expect(line).not.toBeNull();
    expect(line?.hidden).toBe(true);
    expect(line?.textContent).toBe('');
});
