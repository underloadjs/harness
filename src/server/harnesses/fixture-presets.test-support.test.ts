// The test fixtures themselves (./fixture-presets.test-support.ts).
//
// These fixtures used to be SHIPPED presets — `demo` and `flaky` in the catalogue, with
// matching agent profiles and, for the failure example, a scanned `*.tool.ts` source entry
// under `src/server/tools/examples`. They are deleted from the product, and the suites that
// needed an offline loop or a throwing tool now inject these objects instead. A fixture that
// no production code exercises still has to be correct, so the behaviour the shipped
// presets used to get for free is pinned here:
//
//   1. the scripted transport runs the whole discovery → call → answer loop and mints
//      conversation-unique tool-call ids, including across a restore;
//   2. `testFlaky` fails twice out of three, keeps its attempt count PER AGENT, and stores
//      that count in harness-owned memory so a replaced implementation keeps counting;
//   3. the two presets carry the templates the registry's patch rules depend on
//      ('scripted' keeps its factory, 'flaky' rebuilds through the toolbox factory).

import { describe, expect, it } from 'vitest';
import { FLAKY_FIXTURE, SCRIPTED_FIXTURE, testFlaky } from './fixture-presets.test-support';

const SETTINGS = { baseURL: 'http://provider.test/v1', apiKey: 'server-secret', model: 'test-model' };

const progress = (): void => {
    // The scripted transport is the subject; events are irrelevant here.
};

const callIds = (messages: readonly { role: string; toolCalls?: readonly { id: string }[] }[]): string[] => {
    const ids: string[] = [];
    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const call of message.toolCalls ?? []) ids.push(call.id);
    }
    return ids;
};

describe('the scripted fixture transport', () => {
    it('runs the discovery loop and answers without an endpoint', async () => {
        const harness = SCRIPTED_FIXTURE.create(SETTINGS, progress);

        expect(harness.requiresEndpoint ?? true).not.toBe(false);

        const answer = await harness('What time is it?');

        expect(answer.content).toContain('timeNow returned');
    }, 30_000);

    it('continues minting unique tool-call ids on a second task and a restored session', async () => {
        // The harness rejects a tool-call id that is not unique across the CONVERSATION
        // (one result must pair with exactly one call), and this fixture is reused by
        // successive tasks and by a restored session — so the ids have to be derived from
        // the transcript, not from a per-process counter.
        const preset = SCRIPTED_FIXTURE;
        const first = preset.create(SETTINGS, progress);

        const firstMessage = await first('What time is it?');
        expect(firstMessage.content).toContain('timeNow returned');

        // The agent key is `general`, not `demo`: the PRESET is named `demo` (a frozen
        // session record names it), but the AGENT inside it is a real role.
        const snapshot = first.snapshot();
        expect(callIds(snapshot.agents.general.messages)).toEqual(['call_tool_request_1', 'call_time_now_1']);

        // A NEW harness restored from the persisted transcript stands in for a server
        // restart during the same session.
        const restored = preset.create(SETTINGS, progress);
        restored.restore(snapshot);

        const secondMessage = await restored('And once more?');
        expect(secondMessage.content).toContain('timeNow returned');

        const ids = callIds(restored.agents.general.messages);
        expect(ids).toEqual([
            'call_tool_request_1',
            'call_time_now_1',
            'call_tool_request_2',
            'call_time_now_2'
        ]);

        // Every id is distinct: the uniqueness guard would have rejected the run before
        // any tool executed.
        expect(new Set(ids).size).toBe(ids.length);

        // The persisted view is consistent with the live transcript.
        expect(callIds(restored.snapshot().agents.general.messages)).toEqual(ids);
    }, 30_000);
});

describe('testFlaky', () => {
    // Two distinct agent objects stand in for two sessions. `{}` is enough because the
    // tool only uses the agent's identity as a WeakMap key.
    const agentA = {} as never;
    const agentB = {} as never;

    const attempt = (agent: never) => testFlaky.execute({ parameters: {}, agent });

    it('fails twice out of three', async () => {
        await expect(attempt(agentA)).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(attempt(agentA)).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(attempt(agentA)).resolves.toBe('Success on attempt 3.');
    });

    it('keeps the attempt counter isolated per agent/session', async () => {
        // Interleaved calls: each agent fails twice and succeeds on its third call,
        // independently of the other agent's progress. A process-wide counter would let
        // agent A's failures "heal" agent B's first call.
        const freshA = {} as never;
        const freshB = {} as never;

        await expect(attempt(freshA)).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(attempt(freshB)).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(attempt(freshA)).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(attempt(freshB)).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(attempt(freshA)).resolves.toBe('Success on attempt 3.');
        await expect(attempt(freshB)).resolves.toBe('Success on attempt 3.');
    });

    it('uses one explicit fallback counter for direct calls with no agent', async () => {
        // A bare call has no harness and no agent, so there is nothing to key on; the
        // module counter is the documented fallback, not a bug.
        const bare = () => testFlaky({});

        await expect(bare()).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(bare()).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(bare()).resolves.toBe('Success on attempt 3.');
    });

    it('stores the per-agent attempt store in harness-owned memory when present', async () => {
        // A minimal live harness memory: the tool only needs get/set. The WeakMap lives
        // INSIDE this memory, so a replacement module (which shares the same harness)
        // reads the same counters instead of starting from zero.
        const data = new Map<string, unknown>();
        const harness = {
            memory: {
                get: (key: string) => data.get(key),
                set: (key: string, value: unknown) => {
                    data.set(key, value);
                }
            }
        } as never;

        const agent = {} as never;
        const stored = () => testFlaky.execute({ parameters: {}, agent, harness });

        await expect(stored()).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(stored()).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(stored()).resolves.toBe('Success on attempt 3.');
        expect(data.get('testFlaky:attempts')).toBeInstanceOf(WeakMap);
    });
});

describe('the fixture presets carry the templates the registry rules need', () => {
    it('keeps the scripted fixture offline and the flaky fixture live', () => {
        expect({
            name: SCRIPTED_FIXTURE.name,
            requiresEndpoint: SCRIPTED_FIXTURE.requiresEndpoint,
            primary: SCRIPTED_FIXTURE.primary,
            template: SCRIPTED_FIXTURE.template,
            tools: SCRIPTED_FIXTURE.tools
        }).toEqual({
            name: 'demo',
            requiresEndpoint: false,
            // A REAL profile: there is no `demo` agent profile in the trusted registry any
            // more, and the scripted transport ignores the instruction text anyway.
            primary: 'general',
            template: 'scripted',
            tools: ['timeNow']
        });

        expect({
            name: FLAKY_FIXTURE.name,
            requiresEndpoint: FLAKY_FIXTURE.requiresEndpoint,
            template: FLAKY_FIXTURE.template
        }).toEqual({ name: 'flaky', requiresEndpoint: true, template: 'flaky' });

        // The flaky fixture selects a REAL profile: there is no `flaky` agent profile in
        // the trusted registry any more, so a live harness naming one would fail
        // validation against src/agents.
        expect(FLAKY_FIXTURE.agents).toEqual(['general']);
        expect(FLAKY_FIXTURE.primary).toBe('general');
    });
});
