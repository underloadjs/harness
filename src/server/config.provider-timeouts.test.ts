// server/config.ts — the T6 provider time bounds as a deployment setting.
//
// Pinned contract: the shipped defaults, an env override per bound, `0` as the
// per-bound opt-out, a typo that names the variable (nothing coerced), and the
// reported configuration `loadConfiguration` exposes so a status surface can say
// which bound is in force (AC4).
//
// Run: yarn vitest run src/server/config.provider-timeouts.test.ts

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_TIMEOUT_CONFIGURATION, loadProviderTimeoutConfiguration } from '@underload/harness';
import { HarnessError } from '@underload/harness';

describe('provider timeout configuration (T6)', () => {
    it('resolves the documented defaults when nothing is configured', () => {
        expect(loadProviderTimeoutConfiguration({})).toEqual({
            responseHeadMs: 300_000,
            firstTokenMs: 300_000,
            streamChunkMs: 120_000
        });

        // The reported defaults are the SAME numbers, not a second copy that can drift.
        expect(DEFAULT_PROVIDER_TIMEOUT_CONFIGURATION).toEqual({
            responseHeadMs: 300_000,
            firstTokenMs: 300_000,
            streamChunkMs: 120_000
        });
    });

    it('takes each bound from its own variable, and 0 disables only that bound', () => {
        expect(
            loadProviderTimeoutConfiguration({
                HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '60000',
                HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS: '0'
            })
        ).toEqual({
            responseHeadMs: 60_000,
            firstTokenMs: 300_000,
            streamChunkMs: 0
        });
    });

    it('refuses a value that is not an integer of milliseconds, naming the variable', () => {
        expect(() =>
            loadProviderTimeoutConfiguration({ HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS: '5m' })
        ).toThrow(HarnessError);

        expect(() =>
            loadProviderTimeoutConfiguration({ HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS: '5m' })
        ).toThrow(/HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS must be an integer between 0 and 86400000/);
    });

    it('reads a blank variable as unset rather than as zero', () => {
        expect(loadProviderTimeoutConfiguration({ HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '  ' })).toEqual({
            responseHeadMs: 300_000,
            firstTokenMs: 300_000,
            streamChunkMs: 120_000
        });
    });
});
