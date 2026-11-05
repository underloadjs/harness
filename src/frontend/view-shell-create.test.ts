// The shell's create-session write, pinned on the exact bytes it dials (T-B).
//
// `createView` (./view-shell.ts:142) is what the "New conversation" / "Instruct" flow calls.
// It takes the shell's OWN provider record — `RunnerSettings`, camelCase
// (`baseURL`/`apiKey`/`model`, ../server/harnesses/types.ts:18-22) — while the contract's
// create body is snake_case (`RunnerSettingsInput`, ../shared/harness-api.ts:369-373). The
// server runs `requireKnownFields(settings, ['base_url', 'api_key', 'model'])` over
// `POST /sessions` (../server/api.ts:544, helper at ../server/api.ts:504-510) BEFORE a
// session exists, so a camelCase field is a hard 400:
//
//     Unknown field "baseURL". Allowed fields: base_url, api_key, model.
//
// That 400 is the defect this pins closed: the panel failed its FIRST submit, every time,
// because the record that reached the wire had never been renamed. The assertions are on the
// raw request string (not only the parsed object) so a rename that leaves a camelCase key
// behind, or a mapper that drops a blank field, fails here rather than in the browser.
//
// Two rules the shape of these cases comes from:
//   1. the mapping is TOTAL — every field is sent even when blank. `api_key: ''` is the
//      spelling the server already reads as "no key" (../server/api.ts:553) and a blank
//      `model` string is a string the server accepts (../server/api.ts:558), so omitting a
//      blank would silently change which default the session boots with;
//   2. `createView(harness)` with NO second argument omits `settings` ENTIRELY — an
//      explicit-`undefined` property would survive no `JSON.stringify`, but a `settings: {}`
//      would not, and the contract reads an absent block as "keep every configured default".
//
// The stub answers `POST /v1/harness/sessions` with the `{ session }` envelope
// (../shared/harness-api.ts `SessionResponse`) and THROWS for any route it does not declare,
// so `calls` being exactly one entry is itself an assertion that create costs one request.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-shell-create.test.ts

import type { SessionResource, SessionResponse } from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createView } from './view-shell';

const CANONICAL = '/v1/harness/sessions';

type Call = { method: string; url: string; body: string; keepalive: boolean };

let calls: Call[] = [];

// Records everything the client asked for, raw body included, and throws for an undeclared
// route (same shape as the `serve` helper in ./view-api.test.ts:89-110).
const serve = (routes: Record<string, unknown>): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = String(input);
            const body = String(init?.body ?? '');

            calls.push({ method, url, body, keepalive: init?.keepalive === true });

            const value = routes[`${method} ${url}`] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

// The row `POST /sessions` answers: identity plus counters, no turns (../shared/harness-api.ts
// `SessionResource`), which is why the create path costs a header and not a document.
const session: SessionResource = {
    id: 's 1',
    harness: 'instruct',
    status: 'idle',
    model: 'm2',
    created_at: 1,
    updated_at: 2,
    turn_count: 0,
    thread_count: 0,
    revision: 1,
    definition_revision: 1,
    agent_models: { worker: 'm2' },
    endpoint: { base_url: 'http://other/v1', model: 'm2', has_api_key: true },
    runtime_execution: 'inline',
    pending_action_count: 0,
    created_tool_count: 0,
    created_tool_limit: 32
} as SessionResource;

const routes: Record<string, unknown> = { 'POST /v1/harness/sessions': { session } satisfies SessionResponse };

beforeEach(() => {
    calls = [];
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createView — the settings block on the wire', () => {
    it('renames the provider record into the contract spelling and dials one POST', async () => {
        serve(routes);

        const view = await createView('instruct', { baseURL: 'http://other/v1', apiKey: 'sk-test', model: 'm2' });

        // The whole recorded request, byte for byte: the key ORDER is part of the pin, because
        // it is the mapper's insertion order (./view-shell.ts:116-120) and a stale camelCase
        // key appended after the three good ones would still be a 400.
        expect(calls).toEqual([
            {
                method: 'POST',
                url: CANONICAL,
                body: '{"harness":"instruct","settings":{"base_url":"http://other/v1","api_key":"sk-test","model":"m2"}}',
                keepalive: false
            }
        ]);

        const body = JSON.parse(calls[0].body);

        expect(body).toEqual({
            harness: 'instruct',
            settings: { base_url: 'http://other/v1', api_key: 'sk-test', model: 'm2' }
        });

        // The `settings` allow-list at ../server/api.ts:544, stated as an exact key set.
        expect(Object.keys(body.settings)).toEqual(['base_url', 'api_key', 'model']);

        // The rejected spellings, absent from the serialized request entirely.
        expect(calls[0].body).not.toContain('baseURL');
        expect(calls[0].body).not.toContain('apiKey');

        // The `{ session }` envelope is what the view is built from.
        expect(view.id).toBe('s 1');
    });

    it('sends every blank field instead of dropping it (the mapping is total)', async () => {
        serve(routes);

        await createView('instruct', { baseURL: '', apiKey: '', model: '' });

        expect(calls).toEqual([
            {
                method: 'POST',
                url: CANONICAL,
                body: '{"harness":"instruct","settings":{"base_url":"","api_key":"","model":""}}',
                keepalive: false
            }
        ]);

        const body = JSON.parse(calls[0].body);

        expect(body).toEqual({ harness: 'instruct', settings: { base_url: '', api_key: '', model: '' } });

        // A mapper that filtered falsy values would leave `settings` an empty object here, and
        // the session would boot on the SERVER's advertised default instead of the UI's blank.
        expect(Object.keys(body.settings)).toEqual(['base_url', 'api_key', 'model']);
        expect(Object.keys(body)).toEqual(['harness', 'settings']);
    });

    it('omits the settings key completely when no settings record is passed', async () => {
        serve(routes);

        await createView('instruct');

        expect(calls).toEqual([
            { method: 'POST', url: CANONICAL, body: '{"harness":"instruct"}', keepalive: false }
        ]);

        const body = JSON.parse(calls[0].body);

        expect(body).toEqual({ harness: 'instruct' });

        // Not `settings: undefined` and not `settings: {}` — the property must not exist, so
        // the server reads "keep every configured default" (../server/api.ts:538).
        expect('settings' in body).toBe(false);
        expect(Object.keys(body)).toEqual(['harness']);
    });
});
