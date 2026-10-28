// API root resolution and the bootstrap/fallback loader.
//
// H4: the UI must work against the canonical service root /v1/harness (bootstrap
// document at GET root) and the standalone /api root (root is a 404, individual
// routes are the source). The root is chosen at runtime and validated: a query
// override may not smuggle a scheme, credentials, query string or fragment into
// every request URL.
//
// Run: npx vitest run --config playground/vitest.config.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeApiRoot } from './api';

const descriptor = {
    name: 'demo',
    title: 'Demo',
    description: 'demo preset',
    requiresEndpoint: false,
    agents: ['writer'],
    tools: []
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const session = {
    id: 's1',
    harness: 'demo',
    status: 'idle' as const,
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: []
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (globalThis as { __HARNESS_CONFIG__?: unknown }).__HARNESS_CONFIG__;
});

describe('normalizeApiRoot', () => {
    it('keeps rooted paths and strips trailing slashes', () => {
        expect(normalizeApiRoot('/v1/harness/', '/api')).toBe('/v1/harness');
        expect(normalizeApiRoot('/api', '/api')).toBe('/api');
        // A root of "/" means the origin itself; the concatenation stays correct.
        expect(normalizeApiRoot('/', '/api')).toBe('');
        expect(normalizeApiRoot('', '/api')).toBe('/api');
        expect(normalizeApiRoot(undefined, '/api')).toBe('/api');
    });

    it('accepts absolute http(s) roots without a trailing slash', () => {
        expect(normalizeApiRoot('http://127.0.0.1:5000/v1/harness/', '/api')).toBe(
            'http://127.0.0.1:5000/v1/harness'
        );
        expect(normalizeApiRoot('https://api.example.test/api', '/api')).toBe('https://api.example.test/api');
        // An origin-only URL is a valid mount at the root path.
        expect(normalizeApiRoot('https://api.example.test/', '/api')).toBe('https://api.example.test');
    });

    it('rejects anything that is not a plain path or http(s) origin', () => {
        const invalid = [
            'v1/harness', // relative without a leading slash
            '//evil.example/api', // protocol-relative: silently another origin
            '/\\evil.example/api', // backslash: the URL parser treats it as "//"
            '/\\/evil.example/api', // same, with the slash after it escaped
            '/api\u0000', // control characters are stripped/reinterpreted by fetch
            'javascript:alert(1)',
            'ftp://example.test/api',
            '/api?apiKey=secret', // a secret must never travel in a URL
            '/api#fragment',
            'http://user:pass@example.test/api',
            'http://example.test/api?key=secret'
        ];

        for (const value of invalid) {
            expect(() => normalizeApiRoot(value, '/api')).toThrow();
        }
    });
});

describe('resolveApiRoot', () => {
    it('defaults to /api', async () => {
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/api');
    });

    it('takes a rooted path from ?apiRoot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=%2Fv1%2Fharness%2F');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/v1/harness');
    });

    it('takes an absolute http(s) root from ?apiRoot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2F127.0.0.1%3A5000%2Fv1%2Fharness');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('https://127.0.0.1:5000/v1/harness');
    });

    it('ignores an invalid override instead of refusing to boot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=javascript%3Aalert(1)');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/api');
    });

    // F1: the saved provider key is posted to the resolved root. A runtime
    // override therefore may only name the page's own origin or a loopback host;
    // any other absolute origin would be a credential-exfiltration path.
    it('refuses a cross-origin absolute ?apiRoot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2Fevil.example%2Fapi');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/api');
    });

    it('refuses a query root that escapes the origin only after URL decoding', async () => {
        // %5C decodes to a backslash; fetch() would resolve "/\evil.example/api"
        // against the page as "//evil.example/api" - another origin.
        window.history.replaceState(null, '', '/?apiRoot=%2F%5Cevil.example%2Fapi');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/api');
    });

    it('accepts same-origin and loopback absolute roots', async () => {
        const origin = window.location.origin;

        window.history.replaceState(null, '', `/?apiRoot=${encodeURIComponent(`${origin}/v1/harness`)}`);
        let module = await import('./api');
        expect(module.API_ROOT).toBe(`${origin}/v1/harness`);

        vi.resetModules();
        window.history.replaceState(
            null,
            '',
            '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness'
        );
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://localhost:5000/v1/harness');

        vi.resetModules();
        window.history.replaceState(
            null,
            '',
            '/?apiRoot=http%3A%2F%2F%5B%3A%3A1%5D%3A5000%2Fv1%2Fharness'
        );
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://[::1]:5000/v1/harness');
    });

    it('applies the same trust rule to injected config', async () => {
        (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: string } }).__HARNESS_CONFIG__ = {
            apiRoot: 'https://evil.example/api'
        };

        let module = await import('./api');
        expect(module.API_ROOT).toBe('/api');

        vi.resetModules();
        (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: string } }).__HARNESS_CONFIG__ = {
            apiRoot: 'http://127.0.0.1:5000/v1/harness'
        };
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://127.0.0.1:5000/v1/harness');
    });

    it('trusts a cross-origin build-time VITE_HARNESS_API', async () => {
        // Build-time config is compiled by the operator, not taken from a URL a
        // user can be tricked into opening, so it may name another origin.
        vi.stubEnv('VITE_HARNESS_API', 'https://api.example.test/v1/harness');

        const module = await import('./api');
        expect(module.API_ROOT).toBe('https://api.example.test/v1/harness');
    });

    it('sends a saved provider key only to the validated root', async () => {
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2Fevil.example%2Fapi');

        const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({
                    url: String(input),
                    method: init?.method,
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
                });

                return json({ session });
            })
        );

        const module = await import('./api');
        const settings = {
            baseURL: 'http://provider/v1',
            apiKey: 'saved-provider-key',
            model: 'm1'
        };

        await module.createSession('demo', settings);

        // The hostile root was discarded, so the key goes to the page's documented
        // /api mount and is never part of a URL.
        expect(calls).toEqual([
            {
                url: '/api/sessions',
                method: 'POST',
                body: { harness: 'demo', settings }
            }
        ]);
    });

    it('routes every request through the resolved root', async () => {
        window.history.replaceState(null, '', '/?apiRoot=%2Fv1%2Fharness');

        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                calls.push(url);

                if (url === '/v1/harness') {
                    return json({ rootPath: 'D:/repo', presets: [descriptor], tools: [], defaults, sessions: [session] });
                }

                if (url === '/v1/harness/sessions/a%2Fb') return json({ session });

                throw new Error(`unexpected request: ${url}`);
            })
        );

        const module = await import('./api');
        const bootstrap = await module.getBootstrap();

        expect(bootstrap).toEqual({
            rootPath: 'D:/repo',
            presets: [descriptor],
            tools: [],
            defaults,
            sessions: [session]
        });
        expect(calls).toEqual(['/v1/harness']);

        // Session ids are path segments and must be encoded, never interpolated.
        await module.getSession('a/b');
        expect(calls).toEqual(['/v1/harness', '/v1/harness/sessions/a%2Fb']);
    });
});

describe('loadBootstrap', () => {
    it('carries the agent library through the standalone fallback', async () => {
        const agent = {
            name: 'instruct',
            title: 'Instruct',
            description: 'General agent.',
            instruction: 'Answer directly.',
            guidelines: ['Be concise.']
        };

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);

                if (url === '/api') return json({ error: { message: 'Unknown API route.' } }, 404);
                if (url === '/api/harnesses') return json({ harnesses: [descriptor], defaults, agents: [agent] });
                if (url === '/api/tools') return json({ tools: [] });
                if (url === '/api/sessions') return json({ sessions: [] });

                throw new Error(`unexpected request: ${url}`);
            })
        );

        const module = await import('./api');
        const bootstrap = await module.loadBootstrap();

        // The picker is server-driven: the fallback keeps the same agent presets
        // the canonical bootstrap document carries.
        expect(bootstrap.agents).toEqual([agent]);
        expect(bootstrap.presets).toEqual([descriptor]);
    });

    it('uses the canonical root document when it answers', async () => {
        window.history.replaceState(null, '', '/?apiRoot=%2Fv1%2Fharness');

        const calls: string[] = [];
        const bootstrap = {
            rootPath: 'D:/repo',
            presets: [descriptor],
            tools: [],
            defaults,
            sessions: [session]
        };

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                calls.push(url);
                if (url === '/v1/harness') return json(bootstrap);
                throw new Error(`unexpected request: ${url}`);
            })
        );

        const module = await import('./api');
        expect(await module.loadBootstrap()).toEqual(bootstrap);
        // One request, not four: the canonical document is complete.
        expect(calls).toEqual(['/v1/harness']);
    });

    it('falls back to the standalone routes when the root is a 404', async () => {
        // No ?apiRoot: the default /api mount, whose root is the documented 404.
        const calls: Array<{ url: string; method: string | undefined }> = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                calls.push({ url, method: init?.method });

                if (url === '/api') return json({ error: { message: 'Unknown API route.' } }, 404);
                if (url === '/api/harnesses') return json({ harnesses: [descriptor], defaults });
                if (url === '/api/tools') return json({ tools: [] });
                if (url === '/api/sessions') return json({ sessions: [session] });

                throw new Error(`unexpected request: ${url}`);
            })
        );

        const module = await import('./api');
        const bootstrap = await module.loadBootstrap();

        expect(bootstrap).toEqual({
            // Standalone advertises no filesystem root; "" means "not reported".
            rootPath: '',
            presets: [descriptor],
            tools: [],
            defaults,
            sessions: [session]
        });
        expect(calls).toEqual([
            { url: '/api', method: undefined },
            { url: '/api/harnesses', method: undefined },
            { url: '/api/tools', method: undefined },
            { url: '/api/sessions', method: undefined }
        ]);
    });

    it('surfaces the fallback failure when the server is unreachable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                throw new TypeError(`connect ECONNREFUSED ${String(input)}`);
            })
        );

        const module = await import('./api');
        await expect(module.loadBootstrap()).rejects.toThrow('The harness server is unreachable');
    });
});

describe('tool calls', () => {
    it('sends a sessionId only when one is captured for a core call', async () => {
        const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({
                    url: String(input),
                    method: init?.method,
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
                });

                return json({ ok: true, result: { enabled: [] }, durationMs: 3 });
            })
        );

        const module = await import('./api');

        // A catalogue tool keeps the pre-R8 body: no sessionId key at all.
        expect(await module.callTool('fileRead', { path: 'a.txt' })).toEqual({
            ok: true,
            result: { enabled: [] },
            durationMs: 3
        });
        await module.callTool('toolRequest', { tags: ['web'] }, 'session-1');
        // An empty id is "no session" for this purpose, not a session lookup.
        await module.callTool('toolRequest', { tags: ['web'] }, '');

        expect(calls).toEqual([
            {
                url: '/api/tools/fileRead',
                method: 'POST',
                body: { parameters: { path: 'a.txt' } }
            },
            {
                url: '/api/tools/toolRequest',
                method: 'POST',
                body: { parameters: { tags: ['web'] }, sessionId: 'session-1' }
            },
            {
                url: '/api/tools/toolRequest',
                method: 'POST',
                body: { parameters: { tags: ['web'] } }
            }
        ]);
    });
});

describe('harness mutations', () => {
    const agent = {
        name: 'instruct',
        title: 'Instruct',
        description: 'General agent.',
        instruction: 'Answer directly.',
        guidelines: []
    };
    const custom = { ...descriptor, name: 'release-captain', title: 'Release captain' };

    it('lists agent presets and sends the documented request bodies', async () => {
        const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                calls.push({
                    url,
                    method: init?.method,
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
                });

                if (url === '/api/agents') return json({ agents: [agent] });
                if (url === '/api/harnesses' && init?.method === 'POST') {
                    return json({ harness: custom }, 201);
                }
                // Harness names are path segments and must be encoded.
                if (url === '/api/harnesses/a%2Fb' && init?.method === 'PATCH') {
                    return json({ harness: custom });
                }

                throw new Error(`unexpected request: ${url}`);
            })
        );

        const module = await import('./api');

        expect(await module.listAgents()).toEqual([agent]);

        expect(
            await module.createHarness({
                name: 'release-captain',
                title: 'Release captain',
                primary: 'instruct',
                subagents: ['helper']
            })
        ).toEqual(custom);

        expect(await module.updateHarness('a/b', { primary: 'helper', subagents: ['instruct'] })).toEqual(
            custom
        );

        expect(calls).toEqual([
            { url: '/api/agents', method: undefined, body: undefined },
            {
                url: '/api/harnesses',
                method: 'POST',
                body: {
                    name: 'release-captain',
                    title: 'Release captain',
                    primary: 'instruct',
                    subagents: ['helper']
                }
            },
            {
                url: '/api/harnesses/a%2Fb',
                method: 'PATCH',
                body: { primary: 'helper', subagents: ['instruct'] }
            }
        ]);
    });
});
