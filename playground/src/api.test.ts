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
