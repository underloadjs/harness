// Retry policy for POST /api/models (and /v1/harness/models).
//
// These tests pin the route-level policy in isolation from the network: the
// transport `listModels` is replaced with a controllable mock, and fake timers
// let the suite observe every doubling deadline (10s → 5_120s) without waiting.
//
// What is pinned here:
//   - a failed attempt is retried, and success stops the loop;
//   - each attempt receives a FRESH AbortController signal, aborted exactly on
//     its own 10_000 * 2**attempt deadline;
//   - exactly ten total attempts are made, then the final ModelListError escapes;
//   - timer handles are cleared on success and on the final failure;
//   - 'configuration' errors and unexpected exceptions are never retried.
//
// The route's status mapping (400/502) is covered over real HTTP in
// src/server/models.test.ts; this file owns the attempt schedule itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModels, ModelListError } from '../transport/models';
import type { ModelListConfiguration } from '../transport/models';
import { listModelsWithRetry } from './api';

// Keep the real ModelListError class (api.ts branches on `instanceof`) and
// replace only the network call.
vi.mock('../transport/models', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../transport/models')>();
    return { ...actual, listModels: vi.fn() };
});

const BASE_URL = 'http://provider.test/v1';
const API_KEY = 'secret-key';

// A provider that never answers: resolves only when its attempt signal aborts,
// exactly like a hung HTTP request. Rejects with the same kind the transport
// uses for aborts ('request').
const hangUntilAborted = (configuration: ModelListConfiguration): Promise<string[]> => {
    const signal = configuration.signal;
    if (signal === undefined) {
        return Promise.reject(new Error('listModels must always receive an abort signal from the retry loop.'));
    }

    return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
            reject(new ModelListError(`Request to ${BASE_URL}/models failed: aborted`, 'request'))
        );
    });
};

// The exact per-attempt deadlines: 10_000 * 2**attempt for attempts 0..9.
const DEADLINES = [
    10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000, 5_120_000
];

beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so no implementation or once-queue from
    // a previous test leaks into the next one.
    vi.resetAllMocks();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('listModelsWithRetry', () => {
    it('makes exactly ten attempts with doubling deadlines and a fresh signal each time', async () => {
        const signals: AbortSignal[] = [];
        const configurations: ModelListConfiguration[] = [];

        vi.mocked(listModels).mockImplementation((configuration) => {
            configurations.push(configuration);
            if (configuration.signal !== undefined) {
                signals.push(configuration.signal);
            }
            return hangUntilAborted(configuration);
        });

        // Capture resolution/rejection without letting the rejection go
        // unhandled while the timers are advanced.
        const outcome = listModelsWithRetry({ baseURL: BASE_URL, apiKey: API_KEY }).then(
            () => 'resolved',
            (error: unknown) => error
        );

        // The first attempt starts synchronously and owns a live signal.
        expect(listModels).toHaveBeenCalledTimes(1);
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);

        for (let attempt = 0; attempt < DEADLINES.length; attempt += 1) {
            // One millisecond before the deadline the attempt is still alive...
            await vi.advanceTimersByTimeAsync(DEADLINES[attempt] - 1);
            expect(signals[attempt].aborted, `attempt ${attempt} aborted early`).toBe(false);
            expect(listModels).toHaveBeenCalledTimes(attempt + 1);

            // ...and exactly on it the attempt is aborted.
            await vi.advanceTimersByTimeAsync(1);
            expect(signals[attempt].aborted, `attempt ${attempt} not aborted on its deadline`).toBe(true);

            if (attempt < DEADLINES.length - 1) {
                // The next attempt starts immediately with a NEW controller.
                expect(listModels).toHaveBeenCalledTimes(attempt + 2);
                expect(signals[attempt + 1], `attempt ${attempt + 1} reused the previous signal`).not.toBe(
                    signals[attempt]
                );
                expect(signals[attempt + 1].aborted).toBe(false);
            }
        }

        const error = await outcome;
        expect(error).toBeInstanceOf(ModelListError);
        expect((error as ModelListError).kind).toBe('request');
        expect((error as ModelListError).message).toBe(
            `Request to ${BASE_URL}/models failed: aborted`
        );

        // Ten total attempts, never an eleventh.
        expect(listModels).toHaveBeenCalledTimes(10);
        expect(signals).toHaveLength(10);
        expect(new Set(signals).size).toBe(10);
        expect(signals.every((signal) => signal.aborted)).toBe(true);

        // Every attempt carried the caller's configuration unchanged.
        expect(configurations).toHaveLength(10);
        configurations.forEach((configuration, index) => {
            expect(configuration.baseURL).toBe(BASE_URL);
            expect(configuration.apiKey).toBe(API_KEY);
            expect(configuration.signal).toBe(signals[index]);
        });

        // The final failure left no pending abort timer behind.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops after the first attempt once the provider answers', async () => {
        vi.mocked(listModels).mockResolvedValueOnce(['model-a', 'model-b']);

        const ids = await listModelsWithRetry({ baseURL: BASE_URL });

        expect(ids).toEqual(['model-a', 'model-b']);
        expect(listModels).toHaveBeenCalledTimes(1);
        // A completed attempt clears its timeout immediately.
        expect(vi.getTimerCount()).toBe(0);

        // No delayed retry can fire later.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(listModels).toHaveBeenCalledTimes(1);
    });

    it('retries a provider failure and returns the recovered catalogue', async () => {
        vi.mocked(listModels)
            .mockRejectedValueOnce(new ModelListError('HTTP 503: warming up', 'response'))
            .mockResolvedValueOnce(['recovered']);

        const ids = await listModelsWithRetry({ baseURL: BASE_URL });

        expect(ids).toEqual(['recovered']);
        expect(listModels).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry a configuration error', async () => {
        const failure = new ModelListError('"nope" is not an absolute URL.', 'configuration');
        vi.mocked(listModels).mockRejectedValueOnce(failure);

        await expect(listModelsWithRetry({ baseURL: BASE_URL })).rejects.toBe(failure);

        expect(listModels).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry an exception that is not a ModelListError', async () => {
        const failure = new Error('programming error');
        vi.mocked(listModels).mockRejectedValueOnce(failure);

        await expect(listModelsWithRetry({ baseURL: BASE_URL })).rejects.toBe(failure);

        expect(listModels).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
