// server/api.ts — `GET /v1/harness/config` reports the EFFECTIVE provider time bounds
// (T8, AC4).
//
// The contract, pinned exactly because a frontend task consumes it in parallel:
//
//   providerTimeouts: { responseHeadTimeoutMs: number; firstTokenTimeoutMs: number; streamChunkTimeoutMs: number }
//
// — that field name, those three keys, no nesting. The values are the EFFECTIVE bounds
// (host option, else the validated environment parse, else the shipped defaults), never
// the constants: a status bar that shows 300 s while the deployment runs 45 s would
// explain a `provider-timeout` with the wrong number, which is the whole point of
// reporting it. The internal `ProviderTimeoutConfiguration` spelling (`responseHeadMs`)
// stays a server-layer name and never reaches the wire.
//
// Cross-references:
//   - ./api.ts                          — the option, the mapping, `configDocument`
//   - ../harness-server.swagger.yaml            — the spec the generated DTO comes from
//   - ../shared/harness-api.ts          — `GlobalConfigDocument.providerTimeouts`
//   - ./config.ts                       — `loadProviderTimeoutConfiguration`
//
// Run: yarn vitest run src/server/api-provider-timeouts.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../engine/harness';
import type { GlobalConfigDocument } from '../engine/shared/harness-api';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { createHarnessApi } from './api';
import type { HarnessApiOptions, HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'unused',
    model: 'scripted/test'
};

const API_DEFAULTS = {
    baseURL: 'http://scripted.invalid/v1',
    model: 'scripted/test',
    hasApiKey: false
};

const MOUNT = '/v1/harness';

const scriptedPreset = (): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted provider-timeout contract preset',
    requiresEndpoint: false,
// A ONE-member card: `ranks` covers the single member, which is also the entry (routing).
    // One distinct rank means nobody sits strictly below it, so the runtime registers no
    // `delegate` row — exactly what the retired `subagents: []` stated (R15).
    entry: 'worker',
    ranks: { worker: 'A' },
    agents: ['worker'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings) =>
        harness({
            agents: {
                worker: agent({
                    model: settings.model,
                    instruction: 'Scripted test agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            entry: 'worker',
            presets: false
        })
});

const buildApi = (options: Partial<HarnessApiOptions> = {}) => {
    const registry = createHarnessRegistry([scriptedPreset()]);
    const store = new SessionStore(DEFAULTS, registry);

    return createHarnessApi({ store, defaults: API_DEFAULTS, registry, ...options });
};

const getConfig = async (api: ReturnType<typeof createHarnessApi>): Promise<GlobalConfigDocument> => {
    const result: HarnessApiResult = await api({
        method: 'GET',
        pathname: `${MOUNT}/config`,
        mount: MOUNT,
        readBody: async <T,>() => ({}) as T
    } as HarnessApiRequest);

    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);
    if (result.status !== 200) throw new Error(`Expected 200, got ${result.status}.`);

    return result.body as GlobalConfigDocument;
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('GET /v1/harness/config reports the effective provider bounds (T8, AC4)', () => {
    it('answers `providerTimeouts` with exactly the three documented keys and the effective values', async () => {
        const api = buildApi({
            providerTimeouts: { responseHeadMs: 1234, firstTokenMs: 2345, streamChunkMs: 3456 }
        });

        const config = await getConfig(api);

        // The exact shape a frontend is coded against: one flat object, three camelCase
        // keys named after the env var each leg mirrors.
        expect(config.providerTimeouts).toEqual({
            responseHeadTimeoutMs: 1234,
            firstTokenTimeoutMs: 2345,
            streamChunkTimeoutMs: 3456
        });
        expect(Object.keys(config.providerTimeouts ?? {})).toStrictEqual([
            'responseHeadTimeoutMs',
            'firstTokenTimeoutMs',
            'streamChunkTimeoutMs'
        ]);

        // The server-layer spelling never leaks onto the wire.
        expect(JSON.stringify(config)).not.toContain('responseHeadMs"');
        // The rest of the document is unchanged by the addition.
        expect(config.writable_fields).toEqual(['settings.base_url', 'settings.model', 'settings.api_key']);
        expect(config.defaults).toEqual({ base_url: API_DEFAULTS.baseURL, model: API_DEFAULTS.model, has_api_key: false });
    });

    it('reports the merged ENVIRONMENT when the host has no opinion, not the constants', async () => {
        // An operator deployment: two legs raised, one leg disabled with `0`.
        vi.stubEnv('HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS', '45000');
        vi.stubEnv('HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS', '90000');
        vi.stubEnv('HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS', '0');

        const config = await getConfig(buildApi());

        expect(config.providerTimeouts).toEqual({
            responseHeadTimeoutMs: 45_000,
            firstTokenTimeoutMs: 90_000,
            streamChunkTimeoutMs: 0
        });
    });

    it('falls back to the shipped defaults with no host option and no environment', async () => {
        vi.stubEnv('HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS', '');
        vi.stubEnv('HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS', '');
        vi.stubEnv('HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS', '');

        const config = await getConfig(buildApi());

        // A blank variable means "not set" (like an absent one), so the shipped bounds
        // answer — the same numbers `0`-disabling a leg does NOT mean.
        expect(config.providerTimeouts).toEqual({
            responseHeadTimeoutMs: 300_000,
            firstTokenTimeoutMs: 300_000,
            streamChunkTimeoutMs: 120_000
        });
    });

    it('keeps `PATCH /config` unchanged: a timeout is not a writable field', async () => {
        const api = buildApi({ providerTimeouts: { responseHeadMs: 1234, firstTokenMs: 2345, streamChunkMs: 3456 } });

        const result = await api({
            method: 'PATCH',
            pathname: `${MOUNT}/config`,
            mount: MOUNT,
            readBody: async <T,>() => ({ settings: { response_head_timeout_ms: 1000 } }) as T
        } as HarnessApiRequest);

        // The bounds are a deployment property (env / host option), so the route that
        // owns the per-session credential fields still refuses an unknown one.
        expect(result.kind === 'json' && result.status).toBe(400);

        const config = await getConfig(api);

        expect(config.providerTimeouts).toEqual({
            responseHeadTimeoutMs: 1234,
            firstTokenTimeoutMs: 2345,
            streamChunkTimeoutMs: 3456
        });
    });
});
