// Shared settings validation (`mergeSettings`).
//
// This is the single merge point for POST /models and POST /sessions, so the
// credential rule and the length caps are unit-tested here with exact values; the
// wire behaviour (the authorization header a provider actually receives) is
// covered by credentials.test.ts.
//
// Cross-references:
//   - ./config.ts     — implementation
//   - ./api.ts        — maps SettingsError to 400
//   - ./credentials.test.ts — server-key containment over real HTTP

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RUNTIME_CONFIGURATION,
    DEFAULT_THREAD_EXECUTION,
    MAX_LANE_WORKERS_LIMIT,
    WORKER_HANDSHAKE_MS_MAX,
    WORKER_IDLE_MS_MAX,
    isSameProvider,
    loadRuntimeConfiguration,
    mergeSettings,
    normalizeProviderURL,
    parseThreadExecutionMode,
    resolveRuntimeConfiguration,
    ServerRuntimeError,
    SettingsError
} from './config';

const DEFAULTS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-key',
    model: 'server-model'
};

describe('mergeSettings', () => {
    it('returns the server settings when the client sends nothing', () => {
        expect(mergeSettings(DEFAULTS, undefined)).toEqual({
            baseURL: 'http://provider.test/v1',
            apiKey: 'server-key',
            model: 'server-model'
        });
        expect(mergeSettings(DEFAULTS, {})).toEqual({
            baseURL: 'http://provider.test/v1',
            apiKey: 'server-key',
            model: 'server-model'
        });
    });

    it('keeps the server key for the same provider despite a trailing slash', () => {
        expect(mergeSettings(DEFAULTS, { baseURL: 'http://provider.test/v1/', apiKey: '' })).toEqual({
            baseURL: 'http://provider.test/v1/',
            apiKey: 'server-key',
            model: 'server-model'
        });
    });

    it('drops the server key when the client overrides the base URL to a foreign provider', () => {
        expect(mergeSettings(DEFAULTS, { baseURL: 'https://evil.example/v1', apiKey: '' })).toEqual({
            baseURL: 'https://evil.example/v1',
            apiKey: '',
            model: 'server-model'
        });

        // Same origin, different base path is also "not the configured provider".
        expect(mergeSettings(DEFAULTS, { baseURL: 'http://provider.test/v2' })).toEqual({
            baseURL: 'http://provider.test/v2',
            apiKey: '',
            model: 'server-model'
        });
    });

    it('uses an explicit client key wherever the client points', () => {
        expect(mergeSettings(DEFAULTS, { baseURL: 'https://evil.example/v1', apiKey: 'client-key' })).toEqual({
            baseURL: 'https://evil.example/v1',
            apiKey: 'client-key',
            model: 'server-model'
        });

        // Trimmed, because a pasted key often carries whitespace.
        expect(mergeSettings(DEFAULTS, { apiKey: '  client-key  ' }).apiKey).toBe('client-key');
    });

    it('falls back to the server model but never to a blank base URL', () => {
        expect(mergeSettings(DEFAULTS, { model: '', baseURL: '' })).toEqual({
            baseURL: '',
            apiKey: '',
            model: 'server-model'
        });
    });

    it('caps the base URL and model length', () => {
        expect(() => mergeSettings(DEFAULTS, { baseURL: 'x'.repeat(2_049) })).toThrowError(
            new SettingsError('A provider base URL cannot exceed 2048 characters.')
        );
        expect(() => mergeSettings(DEFAULTS, { model: 'x'.repeat(257) })).toThrowError(
            new SettingsError('A model name cannot exceed 256 characters.')
        );

        // Exactly at the cap is accepted.
        expect(mergeSettings(DEFAULTS, { model: 'x'.repeat(256) }).model).toBe('x'.repeat(256));
    });

    it('rejects non-string fields with a field-naming 400', () => {
        const cases: { input: Record<string, unknown>; message: string }[] = [
            { input: { baseURL: 5 }, message: '`settings.baseURL` must be a string when present.' },
            { input: { model: null }, message: '`settings.model` must be a string when present.' },
            { input: { apiKey: [] }, message: '`settings.apiKey` must be a string when present.' }
        ];

        for (const entry of cases) {
            let caught: unknown;
            try {
                mergeSettings(DEFAULTS, entry.input as never);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(SettingsError);
            expect((caught as SettingsError).message).toBe(entry.message);
            expect((caught as SettingsError).status).toBe(400);
        }
    });
});

describe('server runtime configuration', () => {
    // R3: the runtime is deployment-owned and VALIDATED, never coerced. A number
    // helper that maps a typo to 0 would silently change isolation behaviour, so the
    // accepted range is part of the message.
    const RUNTIME_DEFAULTS = {
        threadExecution: 'inline',
        workerIdleMs: 120_000,
        maxLaneWorkers: 16,
        workerHandshakeMs: 60_000
    };

    it('ships inline execution as the safe default', () => {
        expect(DEFAULT_THREAD_EXECUTION).toBe('inline');
        expect(DEFAULT_RUNTIME_CONFIGURATION).toEqual(RUNTIME_DEFAULTS);
        expect(loadRuntimeConfiguration({})).toEqual(RUNTIME_DEFAULTS);
    });

    it('reads every worker variable and trims the entry path', () => {
        expect(
            loadRuntimeConfiguration({
                HARNESS_THREAD_EXECUTION: '  WORKER ',
                HARNESS_WORKER_IDLE_MS: '0',
                HARNESS_MAX_LANE_WORKERS: '3',
                HARNESS_WORKER_HANDSHAKE_MS: '1000',
                HARNESS_WORKER_ENTRY: ' D:/build/worker.mjs '
            })
        ).toEqual({
            threadExecution: 'worker',
            workerIdleMs: 0,
            maxLaneWorkers: 3,
            workerHandshakeMs: 1000,
            workerEntry: 'D:/build/worker.mjs'
        });
    });

    it('treats an absent or blank worker entry as unset, not as an empty path', () => {
        expect(loadRuntimeConfiguration({ HARNESS_WORKER_ENTRY: '   ' })).toEqual(RUNTIME_DEFAULTS);
        expect(loadRuntimeConfiguration({})).not.toHaveProperty('workerEntry');
    });

    it('accepts each documented boundary value', () => {
        expect(
            loadRuntimeConfiguration({
                HARNESS_WORKER_IDLE_MS: String(WORKER_IDLE_MS_MAX),
                HARNESS_MAX_LANE_WORKERS: String(MAX_LANE_WORKERS_LIMIT),
                HARNESS_WORKER_HANDSHAKE_MS: String(WORKER_HANDSHAKE_MS_MAX)
            })
        ).toEqual({
            threadExecution: 'inline',
            workerIdleMs: WORKER_IDLE_MS_MAX,
            maxLaneWorkers: MAX_LANE_WORKERS_LIMIT,
            workerHandshakeMs: WORKER_HANDSHAKE_MS_MAX
        });
    });

    it('rejects a mode that is neither accepted spelling, naming what was sent', () => {
        expect(parseThreadExecutionMode(undefined)).toBe('inline');
        expect(parseThreadExecutionMode('')).toBe('inline');
        expect(parseThreadExecutionMode(' Worker ')).toBe('worker');

        for (const value of ['threads', 'threaded', 'WORKERS']) {
            expect(() => parseThreadExecutionMode(value)).toThrowError(
                new ServerRuntimeError(`HARNESS_THREAD_EXECUTION must be "inline" or "worker"; received ${JSON.stringify(value)}.`)
            );
        }

        // Whitespace is tolerated; a wrong word is not.
        expect(parseThreadExecutionMode('inline ')).toBe('inline');
        expect(() => parseThreadExecutionMode('workers')).toThrowError(ServerRuntimeError);
    });

    it('rejects a number that is not plain digits, naming the variable and its range', () => {
        const cases: { env: Record<string, string>; message: string }[] = [
            {
                env: { HARNESS_WORKER_IDLE_MS: '12s' },
                message: 'HARNESS_WORKER_IDLE_MS must be an integer between 0 and 3600000.'
            },
            {
                env: { HARNESS_WORKER_IDLE_MS: '-1' },
                message: 'HARNESS_WORKER_IDLE_MS must be an integer between 0 and 3600000.'
            },
            {
                env: { HARNESS_WORKER_IDLE_MS: '1e7' },
                message: 'HARNESS_WORKER_IDLE_MS must be an integer between 0 and 3600000.'
            },
            {
                // A digit separator is legal TypeScript but not an env value.
                env: { HARNESS_WORKER_IDLE_MS: '120_000' },
                message: 'HARNESS_WORKER_IDLE_MS must be an integer between 0 and 3600000.'
            },
            {
                env: { HARNESS_WORKER_IDLE_MS: String(WORKER_IDLE_MS_MAX + 1) },
                message: 'HARNESS_WORKER_IDLE_MS must be an integer between 0 and 3600000.'
            },
            {
                env: { HARNESS_MAX_LANE_WORKERS: '0' },
                message: 'HARNESS_MAX_LANE_WORKERS must be an integer between 1 and 64.'
            },
            {
                env: { HARNESS_MAX_LANE_WORKERS: String(MAX_LANE_WORKERS_LIMIT + 1) },
                message: 'HARNESS_MAX_LANE_WORKERS must be an integer between 1 and 64.'
            },
            {
                env: { HARNESS_WORKER_HANDSHAKE_MS: '999' },
                message: 'HARNESS_WORKER_HANDSHAKE_MS must be an integer between 1000 and 600000.'
            }
        ];

        for (const entry of cases) {
            let caught: unknown;

            try {
                loadRuntimeConfiguration(entry.env);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(ServerRuntimeError);
            expect((caught as ServerRuntimeError).message).toBe(entry.message);
        }
    });

    it('lets explicit host options win per field over the environment layer', () => {
        const loaded = loadRuntimeConfiguration({
            HARNESS_THREAD_EXECUTION: 'worker',
            HARNESS_WORKER_IDLE_MS: '5000',
            HARNESS_WORKER_ENTRY: '/built/worker.mjs'
        });

        expect(resolveRuntimeConfiguration(loaded, undefined)).toEqual(loaded);
        expect(resolveRuntimeConfiguration(loaded, undefined)).not.toBe(loaded);

        expect(resolveRuntimeConfiguration(loaded, { threadExecution: 'inline', maxLaneWorkers: 2 })).toEqual({
            threadExecution: 'inline',
            workerIdleMs: 5000,
            maxLaneWorkers: 2,
            workerHandshakeMs: 60_000,
            workerEntry: '/built/worker.mjs'
        });

        // A blank override means "not supplied", so the built-in path survives a
        // settings form that posts an empty input.
        expect(resolveRuntimeConfiguration(loaded, { workerEntry: '   ' }).workerEntry).toBe('/built/worker.mjs');

        expect(() => resolveRuntimeConfiguration(loaded, { threadExecution: 'threads' as never })).toThrowError(
            new ServerRuntimeError('threadExecution must be "inline" or "worker"; received "threads".')
        );
        expect(() => resolveRuntimeConfiguration(loaded, { workerIdleMs: 12.5 })).toThrowError(
            new ServerRuntimeError('workerIdleMs must be an integer between 0 and 3600000.')
        );
        expect(() => resolveRuntimeConfiguration(loaded, { maxLaneWorkers: 0 })).toThrowError(
            new ServerRuntimeError('maxLaneWorkers must be an integer between 1 and 64.')
        );
        expect(() => resolveRuntimeConfiguration(loaded, { workerHandshakeMs: 999 })).toThrowError(
            new ServerRuntimeError('workerHandshakeMs must be an integer between 1000 and 600000.')
        );
    });
});

describe('provider URL comparison', () => {
    it('normalizes case, default port, and trailing slashes', () => {
        expect(normalizeProviderURL('HTTP://Provider.Test:80/v1/')).toBe('http://provider.test/v1');
        expect(normalizeProviderURL('  https://provider.test/v1//  ')).toBe('https://provider.test/v1');
        expect(normalizeProviderURL('')).toBe('');
        // An unparseable value falls back to trimmed, slash-normalized text.
        expect(normalizeProviderURL(' provider.test/v1/ ')).toBe('provider.test/v1');
    });

    it('keeps a query string distinct, so a key cannot follow an injected parameter', () => {
        expect(normalizeProviderURL('http://provider.test/v1?redirect=1')).toBe(
            'http://provider.test/v1?redirect=1'
        );
        expect(isSameProvider('http://provider.test/v1', 'http://provider.test/v1?redirect=1')).toBe(false);
    });

    it('never treats an empty base URL as a provider', () => {
        expect(isSameProvider('', '')).toBe(false);
        expect(isSameProvider('   ', '   ')).toBe(false);
        expect(isSameProvider('http://provider.test/v1/', 'http://provider.test/v1')).toBe(true);
    });
});
