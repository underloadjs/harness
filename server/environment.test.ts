// Automatic `.env` loading: parsing, precedence, absence, and actual config wiring.
//
// Fixtures are written under the repo-root Temp/ directory (never OS temp), one
// unique directory per test, removed in afterEach. Most tests inject a target
// object so they do not mutate the Vitest process; the process.env tests save and
// restore every key they touch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from './config';
import { ENVIRONMENT_PATH, loadEnvironmentFile } from './environment';
import { startHarnessServer } from './index';
import type { HarnessIndex } from './protocol';

// Repo-root Temp/ (four levels up from server/). Module-relative so the location
// does not depend on the cwd Vitest was started from.
const TEMP_ROOT = fileURLToPath(new URL('../../../../Temp', import.meta.url));

// Every fixture directory created by a test, removed in afterEach.
const fixtures: string[] = [];

// Environment keys that `loadConfiguration` reads; saved and cleared around the
// tests that run the loader against the real process.env.
const CONFIGURATION_KEYS = [
    'HARNESS_BASE_URL',
    'HARNESS_API_KEY',
    'OPENAI_API_KEY',
    'HARNESS_MODEL',
    'EXA_API_KEY',
    'TAVILY_API_KEY'
] as const;

let savedConfigurationEnvironment: Record<string, string | undefined> = {};

const createFixture = (source: string): string => {
    mkdirSync(TEMP_ROOT, { recursive: true });
    const directory = mkdtempSync(join(TEMP_ROOT, 'harness-env-'));
    fixtures.push(directory);

    const path = join(directory, '.env');
    writeFileSync(path, source, 'utf8');
    return path;
};

// A path inside a fresh fixture directory that deliberately has no file.
const createMissingFixture = (): string => {
    mkdirSync(TEMP_ROOT, { recursive: true });
    const directory = mkdtempSync(join(TEMP_ROOT, 'harness-env-'));
    fixtures.push(directory);
    return join(directory, '.env');
};

// Remove HARNESS_*/search keys so a fixture is the only source of configuration.
// Saved values (including undefined) are restored in afterEach.
const isolateConfigurationEnvironment = (): void => {
    savedConfigurationEnvironment = {};

    for (const key of CONFIGURATION_KEYS) {
        savedConfigurationEnvironment[key] = process.env[key];
        delete process.env[key];
    }
};

afterEach(() => {
    for (const directory of fixtures.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }

    for (const [key, value] of Object.entries(savedConfigurationEnvironment)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    savedConfigurationEnvironment = {};
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('loadEnvironmentFile', () => {
    it('parses standard dotenv syntax into the target environment', () => {
        const path = createFixture(
            [
                '# comment line',
                'HARNESS_MODEL="quoted model"',
                'HARNESS_BASE_URL=http://env.example/v1 # trailing comment',
                "EXA_API_KEY='exa secret'",
                'TAVILY_API_KEY=plain-value',
                'EMPTY_VALUE=',
                'export EXPORTED=exported-value',
                'SPACED = spaced value'
            ].join('\n')
        );

        const environment: Record<string, string | undefined> = {};

        expect(loadEnvironmentFile({ path, environment })).toEqual({ path, loaded: true });
        expect(environment).toEqual({
            HARNESS_MODEL: 'quoted model',
            HARNESS_BASE_URL: 'http://env.example/v1',
            EXA_API_KEY: 'exa secret',
            TAVILY_API_KEY: 'plain-value',
            EMPTY_VALUE: '',
            EXPORTED: 'exported-value',
            SPACED: 'spaced value'
        });
    });

    it('keeps existing values, including explicitly empty ones', () => {
        const path = createFixture(
            ['HARNESS_MODEL=file-model', 'EXA_API_KEY=file-exa', 'TAVILY_API_KEY=file-tavily'].join('\n')
        );
        const environment: Record<string, string | undefined> = {
            HARNESS_MODEL: 'shell-model',
            EXA_API_KEY: '',
            TAVILY_API_KEY: 'shell-tavily'
        };

        expect(loadEnvironmentFile({ path, environment })).toEqual({ path, loaded: true });
        expect(environment).toEqual({
            HARNESS_MODEL: 'shell-model',
            EXA_API_KEY: '',
            TAVILY_API_KEY: 'shell-tavily'
        });
    });

    it('treats a missing file as a no-op', () => {
        const path = createMissingFixture();
        const environment: Record<string, string | undefined> = { UNTOUCHED: 'value' };

        expect(loadEnvironmentFile({ path, environment })).toEqual({ path, loaded: false });
        expect(environment).toEqual({ UNTOUCHED: 'value' });
    });

    it('does not log the path, a count, or any value', () => {
        const log = vi.spyOn(console, 'log');
        const error = vi.spyOn(console, 'error');
        const path = createFixture('HARNESS_MODEL=quiet-model');

        loadEnvironmentFile({ path, environment: {} });

        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it('defaults to the package-root .env regardless of cwd', () => {
        expect(ENVIRONMENT_PATH).toBe(fileURLToPath(new URL('../.env', import.meta.url)));
    });

    it('loads into process.env without overriding shell values', () => {
        const shellKey = 'HARNESS_ENV_TEST_SHELL';
        const emptyKey = 'HARNESS_ENV_TEST_EMPTY';
        const fileKey = 'HARNESS_ENV_TEST_FILE';

        vi.stubEnv(shellKey, 'shell-value');
        vi.stubEnv(emptyKey, '');
        delete process.env[fileKey];

        const path = createFixture(
            [`${fileKey}=file-value`, `${shellKey}=file-value`, `${emptyKey}=file-value`].join('\n')
        );

        expect(loadEnvironmentFile({ path })).toEqual({ path, loaded: true });
        expect(process.env[fileKey]).toBe('file-value');
        expect(process.env[shellKey]).toBe('shell-value');
        expect(process.env[emptyKey]).toBe('');

        delete process.env[fileKey];
    });
});

describe('configuration wiring', () => {
    it('feeds provider defaults and search keys into loadConfiguration', () => {
        isolateConfigurationEnvironment();
        const path = createFixture(
            [
                'HARNESS_BASE_URL="http://env.example/v1"',
                'HARNESS_API_KEY=file-key',
                'HARNESS_MODEL=file-model',
                'EXA_API_KEY=search-key'
            ].join('\n')
        );

        expect(loadEnvironmentFile({ path })).toEqual({ path, loaded: true });

        expect(loadConfiguration()).toEqual({
            settings: {
                baseURL: 'http://env.example/v1',
                apiKey: 'file-key',
                model: 'file-model'
            },
            defaults: {
                baseURL: 'http://env.example/v1',
                model: 'file-model',
                hasApiKey: true
            }
        });
        expect(process.env.EXA_API_KEY).toBe('search-key');
    });

    it('keeps shell values and an explicitly empty key authoritative in configuration', () => {
        isolateConfigurationEnvironment();
        process.env.HARNESS_MODEL = 'shell-model';
        process.env.HARNESS_API_KEY = '';
        const path = createFixture(
            ['HARNESS_BASE_URL=http://file.example/v1', 'HARNESS_MODEL=file-model', 'HARNESS_API_KEY=file-key'].join(
                '\n'
            )
        );

        loadEnvironmentFile({ path });

        expect(loadConfiguration()).toEqual({
            settings: {
                baseURL: 'http://file.example/v1',
                apiKey: '',
                model: 'shell-model'
            },
            defaults: {
                baseURL: 'http://file.example/v1',
                model: 'shell-model',
                hasApiKey: false
            }
        });
    });

    it('server startup advertises the provider values loaded into process.env', async () => {
        isolateConfigurationEnvironment();
        const path = createFixture(
            [
                'HARNESS_BASE_URL=http://server.example/v1',
                'HARNESS_API_KEY=server-key',
                'HARNESS_MODEL=server-model'
            ].join('\n')
        );

        loadEnvironmentFile({ path });
        const server = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            const response = await fetch(`${server.url}/api/harnesses`, {
                headers: { 'X-Harness-Client': 'ui' }
            });

            expect(response.status).toBe(200);
            const index = (await response.json()) as HarnessIndex;

            expect(index.defaults).toEqual({
                baseURL: 'http://server.example/v1',
                model: 'server-model',
                hasApiKey: true
            });
        } finally {
            await server.close();
        }
    });
});
