// server/config.ts + server/harnesses/toolbox.ts — the per-session provider TIME BOUND
// precedence, end to end (T8, AC2).
//
// THE CHAIN THIS FILE PINS, one test per precedence level:
//
//   session field  ->  environment  ->  shipped default
//
// `mergeSettings` (./config.ts) merges the SESSION field over the SERVER default and
// leaves the field ABSENT when neither layer set one — that absence is the mechanism,
// because it lets the transport resolve the rest with the single parser both layers use
// (`resolveProviderTimeout`, ../transport/provider-timeouts.ts:139). `providerOf`
// (./harnesses/toolbox.ts:248) is the hop that carries the field into `agent(...)`, so
// every expectation here runs the merged settings THROUGH `providerOf` and then through
// that parser, exactly as a live session does — no re-derived shortcut.
//
// Determinism: every bound asserted below is an exact number (the shipped defaults
// 300 000 / 300 000 / 120 000 and literal test values), and a refusal is asserted as the
// exact message plus the 400 status the route maps it to.
//
// Cross-references:
//   - ./config.ts                                  — `mergeSettings`, `optionalTimeout`, `mergedTimeout`
//   - ./harnesses/toolbox.ts                       — `providerOf`, the conditional spread
//   - ../transport/provider-timeouts.ts            — the one parser and the three env names
//   - ../transport/openai.ts:1286                  — where a live transport resolves these bounds
//
// Run: yarn vitest run src/server/config.provider-timeout-precedence.test.ts

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
    PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
    PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
    PROVIDER_TIMEOUT_MAX_MS,
    resolveProviderTimeout
} from '../transport';
import { providerOf } from './harnesses/toolbox';
import { mergeSettings, SettingsError } from './config';
import type { RunnerSettings } from './harnesses/types';

const BASE_URL = 'http://localhost:6660/providers/private/v1';

const SERVER_DEFAULTS: RunnerSettings = { baseURL: BASE_URL, apiKey: 'server-key', model: 'local/basalt' };

// The env an operator would set, spelled with the real variable names.
const OPERATOR_ENV = { HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '45000' };

// The merged settings -> the provider object a session actually builds -> the bound that
// bound's own resolver returns for it. This is the live chain, not a model of it.
const effectiveHeadMs = (settings: RunnerSettings, env: Record<string, string | undefined>): number => {
    const provider = providerOf(settings) as { responseHeadTimeoutMs?: number };

    return resolveProviderTimeout({
        explicit: provider.responseHeadTimeoutMs,
        variable: PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
        env
    });
};

const effectiveFirstTokenMs = (settings: RunnerSettings, env: Record<string, string | undefined>): number => {
    const provider = providerOf(settings) as { firstTokenTimeoutMs?: number };

    return resolveProviderTimeout({
        explicit: provider.firstTokenTimeoutMs,
        variable: PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
        env
    });
};

const effectiveStreamChunkMs = (settings: RunnerSettings, env: Record<string, string | undefined>): number => {
    const provider = providerOf(settings) as { streamChunkTimeoutMs?: number };

    return resolveProviderTimeout({
        explicit: provider.streamChunkTimeoutMs,
        variable: PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
        env
    });
};

describe('a per-session provider timeout overrides env, which overrides the default (T8, AC2)', () => {
    it('level 1 — a session field is authoritative over the environment and the default', () => {
        const merged = mergeSettings(SERVER_DEFAULTS, { responseHeadTimeoutMs: 1500 });

        expect(merged).toEqual({
            baseURL: BASE_URL,
            model: 'local/basalt',
            apiKey: 'server-key',
            responseHeadTimeoutMs: 1500
        });

        // The env says 45 s; the session says 1.5 s; the session wins.
        expect(effectiveHeadMs(merged, OPERATOR_ENV)).toBe(1500);

        // `0` is a value, not "unset": it disables that bound for this session and still
        // outranks the environment, which is the documented escape hatch.
        expect(effectiveHeadMs(mergeSettings(SERVER_DEFAULTS, { responseHeadTimeoutMs: 0 }), OPERATOR_ENV)).toBe(0);

        // A leg this session did not set is untouched by the leg it did.
        expect(effectiveFirstTokenMs(merged, OPERATOR_ENV)).toBe(DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS);
        expect(effectiveStreamChunkMs(merged, OPERATOR_ENV)).toBe(DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS);
    });

    it('level 1b — the server default is the layer under an explicit session field', () => {
        const serverWithBound: RunnerSettings = { ...SERVER_DEFAULTS, streamChunkTimeoutMs: 20_000 };

        // No session field: the server default carries through.
        expect(mergeSettings(serverWithBound, undefined).streamChunkTimeoutMs).toBe(20_000);
        expect(effectiveStreamChunkMs(mergeSettings(serverWithBound, {}), {})).toBe(20_000);

        // Session field present: it outranks the server default as well as the env.
        const merged = mergeSettings(serverWithBound, { streamChunkTimeoutMs: 750 });

        expect(merged.streamChunkTimeoutMs).toBe(750);
        expect(effectiveStreamChunkMs(merged, { [PROVIDER_STREAM_CHUNK_TIMEOUT_ENV]: '45000' })).toBe(750);
    });

    it('level 2 — with no session field the environment wins over the shipped default', () => {
        const merged = mergeSettings(SERVER_DEFAULTS, undefined);

        // The merged settings carry NO bound at all, which is what keeps the env in play.
        expect(providerOf(merged)).not.toHaveProperty('responseHeadTimeoutMs');

        expect(effectiveHeadMs(merged, OPERATOR_ENV)).toBe(45_000);
        // A blank variable means "not set", exactly like an absent one.
        expect(effectiveHeadMs(merged, { HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '  ' })).toBe(
            DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS
        );
        // The other two legs still answer to their own variables.
        expect(
            effectiveFirstTokenMs(merged, { [PROVIDER_FIRST_TOKEN_TIMEOUT_ENV]: '90000' })
        ).toBe(90_000);
        expect(
            effectiveStreamChunkMs(merged, { [PROVIDER_STREAM_CHUNK_TIMEOUT_ENV]: '9000' })
        ).toBe(9_000);
    });

    it('level 3 — with neither layer nor environment the shipped default is the value', () => {
        const merged = mergeSettings(SERVER_DEFAULTS, undefined);

        expect(effectiveHeadMs(merged, {})).toBe(300_000);
        expect(effectiveFirstTokenMs(merged, {})).toBe(300_000);
        expect(effectiveStreamChunkMs(merged, {})).toBe(120_000);

        // Those are the shipped constants themselves: T8 did not move any default.
        expect([
            DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
            DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
            DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS
        ]).toEqual([300_000, 300_000, 120_000]);
    });

    it('an untouched session still merges to the exact {baseURL, model, apiKey} object it always did', () => {
        // No `undefined`-valued keys: a consumer comparing `toStrictEqual` would see them,
        // and every pre-T8 fixture pins the three-key shape.
        expect(mergeSettings(SERVER_DEFAULTS, undefined)).toStrictEqual({
            baseURL: BASE_URL,
            model: 'local/basalt',
            apiKey: 'server-key'
        });
        expect(providerOf(mergeSettings(SERVER_DEFAULTS, undefined))).toStrictEqual({
            baseURL: BASE_URL,
            apiKey: 'server-key',
            sampling: { temperature: 0.3 }
        });
    });

    it('refuses a bound that is not a safe integer in range, as a 400 naming the field', () => {
        const expected = (field: string, received: string): string =>
            `\`settings.${field}\` must be an integer between 0 and ${PROVIDER_TIMEOUT_MAX_MS} ` +
            `(0 disables the bound); received ${received}.`;

        const refusal = (input: Record<string, unknown>): SettingsError => {
            try {
                mergeSettings(SERVER_DEFAULTS, input as Partial<RunnerSettings>);
            } catch (error) {
                return error as SettingsError;
            }

            throw new Error('Expected mergeSettings to refuse the value.');
        };

        // A string is what an unvalidated JSON body actually carries; nothing is coerced,
        // because coercing to 0 would silently mean "this bound is off".
        expect(refusal({ responseHeadTimeoutMs: '12s' })).toMatchObject({
            name: 'SettingsError',
            status: 400,
            message: expected('responseHeadTimeoutMs', '"12s"')
        });
        expect(refusal({ firstTokenTimeoutMs: -1 }).message).toBe(expected('firstTokenTimeoutMs', '-1'));
        expect(refusal({ streamChunkTimeoutMs: PROVIDER_TIMEOUT_MAX_MS + 1 }).message).toBe(
            expected('streamChunkTimeoutMs', String(PROVIDER_TIMEOUT_MAX_MS + 1))
        );
        expect(refusal({ responseHeadTimeoutMs: 1.5 }).message).toBe(expected('responseHeadTimeoutMs', '1.5'));

        // The boundaries themselves are accepted: 0 (off) and the ceiling.
        expect(mergeSettings(SERVER_DEFAULTS, { responseHeadTimeoutMs: 0 }).responseHeadTimeoutMs).toBe(0);
        expect(
            mergeSettings(SERVER_DEFAULTS, { responseHeadTimeoutMs: PROVIDER_TIMEOUT_MAX_MS }).responseHeadTimeoutMs
        ).toBe(PROVIDER_TIMEOUT_MAX_MS);
    });
});
