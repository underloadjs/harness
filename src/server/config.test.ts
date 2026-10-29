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
import { isSameProvider, mergeSettings, normalizeProviderURL, SettingsError } from './config';

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
