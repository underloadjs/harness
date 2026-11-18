// The provider target and the provider bounds, in the BOOTED app (T9 / AC1 + AC4).
//
// Two surfaces, one boot:
//   AC1 — the header under the harness title states NOTHING about the provider. T9 had
//         painted a persistent `provider localhost:5500 · model basalt-8k` line there; the
//         reader asked for it back out ("that is not necessary"), so the head is again only
//         its title row + note and the settings dialog is the single surface that names the
//         dialled provider. AC1 is therefore an ABSENCE assertion here: the node must not
//         exist at all, while the app still boots normally without the dialog open. The
//         text builder itself (`providerTargetNote`) stays in ./provider-diagnostics.ts and
//         is pinned there.
//   AC4 — `GET /v1/harness/config.providerTimeouts` is OPTIONAL (the server side lands in
//         parallel). Both shapes are booted here, because the acceptance rule is about
//         ABSENCE: a server that does not answer the field must neither throw during boot nor
//         blank the app, and the settings line must simply not appear. The fixture answers the
//         SAME routes both times, so the only difference between the two boots is the field.
//
// The config answer carries `base_url: http://localhost:5500/...` — the port that started
// this whole change — and no session row, so the boot lands on the harness with no
// conversation; that value now reaches the reader only through the settings surface.
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

it('keeps any provider-target line out of the header, with the settings dialog closed (AC1)', async () => {
    stubServer({ responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 });

    await import('./main');
    await flush();

    // The app booted (a blank page would have failed every assertion below, and AC4 says
    // absence must not blank it either).
    expect(document.querySelector('.composer-input')).not.toBeNull();

    // The provider-target line is GONE, not merely hidden: neither its id nor its class
    // exists anywhere in the document, so no painter can bring it back on another view.
    expect(document.querySelector('#harness-provider')).toBeNull();
    expect(document.querySelector('.harness-provider')).toBeNull();

    // AC1/R3: what the head DOES keep, in order — the title row (with the session cycler,
    // its `+` and the `.harness-id` chip) and the note line, nothing else.
    const head = document.querySelector<HTMLElement>('.harness-head');

    // The absence above is only half of AC1: the header must also stop SAYING it. A pin on
    // the head's WORDS (title row + note text together) is what proves the user's request,
    // because a future painter could otherwise re-add the sentence under a new class name and
    // still pass the two node checks above. The note's own copy is part of this text and never
    // mentions either word ('Edits apply to new sessions' for this boot).
    expect(head?.textContent ?? '').not.toMatch(/provider|model /);

    expect([...(head?.children ?? [])].map((node) => node.className)).toEqual(['harness-title-row', 'harness-note']);
    expect(document.querySelector('#harness-note')).not.toBeNull();
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

    // No throw, no blanked UI: the composer is still painted and the config read still
    // filled the settings pane from `defaults`; the removed header line stays absent.
    expect(document.querySelector('.composer-input')).not.toBeNull();
    expect(document.querySelector('#harness-provider')).toBeNull();

    // AC1 again for THIS boot shape (no `providerTimeouts`): the wording-level pin from the
    // first test, so the header is checked for the WORDS and not only for the removed node.
    const head = document.querySelector<HTMLElement>('.harness-head');

    expect(head?.textContent ?? '').not.toMatch(/provider|model /);

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
