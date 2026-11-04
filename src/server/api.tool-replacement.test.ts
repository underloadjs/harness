// R4 of the self-modifying-tools task: the server API must execute a named
// session's LIVE tool registry, not the detached static catalogue.
//
// These tests use a real SessionStore + real harness, but replace entries by
// mutating the harness's live `tools` object — the same registry handle a future
// toolRegistry registration publishes into. That keeps the API contract test
// independent of the not-yet-final kernel registration interface, while still
// proving the routing rule:
//
//   POST /v1/harness/sessions/:id/tools/:name/executions -> store.callTool -> live harness entry
//
// A no-session call (`POST /v1/harness/tools/:name/executions`) keeps the static direct
// runner. Every assertion is exact.
//
// Cross-references:
//   - ../api.ts              — callToolRoute (session branch precedes static entry)
//   - ./sessions.ts          — SessionStore.callTool -> harness.executeTool
//   - ./harnesses/toolbox.ts — shared toolbox the custom preset captures

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool } from '../harness';
import type { Harness, Tool } from '../harness';
import { createHarnessRegistry, createToolboxHarness, agentsFromProfiles, presets } from './harnesses';
import type { HarnessPreset } from './harnesses';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
// ToolCallResult is the canonical wire shape (ok + duration_ms), from the contract.
import type { ToolCallResult } from '../shared/harness-api';
import type { SessionSnapshot } from './protocol';

afterEach(() => {
    vi.useRealTimers();
});

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = {
    baseURL: 'http://provider.test/v1',
    model: 'demo-model',
    hasApiKey: true
};

// A replacement for `timeNow`: same name, deliberately different execution. The
// empty schema keeps the direct-call form unambiguous (`parameters: {}`).
const replacementTimeNow = tool<Record<string, never>, { replaced: 'timeNow-v2' }>({
    description: 'Replacement clock used by the live-registry routing tests.',
    tags: ['time', 'clock', 'replacement'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ replaced: 'timeNow-v2' })
});

// A name that exists ONLY in the session's registry, never in the static
// catalogue. The API resolves it through the session (R13/R4).
const sessionOnly = tool<Record<string, never>, { sessionOnly: true }>({
    description: 'A tool that exists only in one live session registry.',
    tags: ['test', 'session'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ sessionOnly: true })
});

// Build a preset whose factory exposes the exact live harness it returned, so a
// test can mutate the registry handle the API must consult at execution time.
const createReplaceablePreset = (captured: Harness[]): HarnessPreset => ({
    name: 'replaceable',
    title: 'Replaceable test harness',
    description: 'Test-only preset that exposes its live harness for registry checks.',
    requiresEndpoint: true,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: ['timeNow'],
    builtin: false,
    editable: true,
    create: (settings, progress, report) => {
        const live = createToolboxHarness(
            {
                agents: agentsFromProfiles(['instruct'], settings),
                primary: 'instruct',
                subagents: []
            },
            settings,
            progress,
            report
        );

        captured.push(live);
        return live;
    }
});

const createRuntime = (captured: Harness[]): HarnessRuntime => {
    const registry = createHarnessRegistry([...presets, createReplaceablePreset(captured)]);

    return createHarnessRuntime({
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry,
        loadEnvironment: false
    });
};

const callApi = (runtime: HarnessRuntime, method: string, pathname: string, body?: unknown) =>
    runtime.api({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async () => (body === undefined ? {} : body),
        bootstrapRoot: true
    });

// Canonical tool execution (T26): the global catalogue call is
// `POST /v1/harness/tools/{tool_id}/executions`, and a call that must run inside a
// session is `POST /v1/harness/sessions/{session_id}/tools/{tool_id}/executions`. The
// session used to travel in the body; on the canonical surface the path IS the session,
// so a body can never reach another session's registry.
const executionPath = (name: string, sessionId?: string): string =>
    sessionId === undefined
        ? `/v1/harness/tools/${name}/executions`
        : `/v1/harness/sessions/${sessionId}/tools/${name}/executions`;

const callTool = async (
    runtime: HarnessRuntime,
    name: string,
    body: unknown,
    sessionId?: string
): Promise<ToolCallResult> => {
    const result = await callApi(runtime, 'POST', executionPath(name, sessionId), body);

    if (result.kind !== 'json') throw new Error('expected a JSON tool response');
    expect(result.status).toBe(200);
    return result.body as ToolCallResult;
};

const createSession = async (runtime: HarnessRuntime): SessionSnapshot => await runtime.store.create('replaceable');

describe('session-aware tool execution (R4)', () => {
    it('executes a replacement of a known catalogue tool in the named session', async () => {
        // Pin the wall clock so the direct-run assertion is byte-exact.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));

        const captured: Harness[] = [];
        const runtime = createRuntime(captured);
        const session = await createSession(runtime);
        const live = captured[0];
        if (live === undefined) throw new Error('expected the preset factory to expose its harness');

        // Replace the definition object the way a registry publication would. The
        // `tools` handle is the live registry; the static catalogue still holds the
        // original app definition.
        (live.tools as Record<string, Tool>).timeNow = replacementTimeNow;

        const viaSession = await callTool(runtime, 'timeNow', { parameters: {} }, session.id);

        expect(viaSession).toEqual({
            ok: true,
            result: { replaced: 'timeNow-v2' },
            duration_ms: expect.any(Number)
        });

        // No session: the static catalogue's direct runner is unchanged, including
        // its declarative panels.
        const direct = await callTool(runtime, 'timeNow', { parameters: 'UTC' });
        const content = { timezone: 'UTC', iso: '2026-01-02T03:04:05.678Z', unix: 1767323045 };

        expect(direct).toEqual({
            ok: true,
            result: content,
            panels: [
                {
                    id: 'timeNow',
                    slot: 'right',
                    title: 'Current time',
                    blocks: [
                        {
                            type: 'keyValue',
                            items: [
                                { label: 'Timezone', value: 'UTC' },
                                { label: 'ISO 8601', value: content.iso },
                                { label: 'Unix', value: '1767323045' }
                            ]
                        },
                        { type: 'text', text: 'Read from the server clock at execution time.' }
                    ]
                }
            ],
            duration_ms: expect.any(Number)
        });
    });

    it('executes a session-only name and keeps it unknown without a session', async () => {
        const captured: Harness[] = [];
        const runtime = createRuntime(captured);
        const session = await createSession(runtime);
        const live = captured[0];
        if (live === undefined) throw new Error('expected the preset factory to expose its harness');

        // The static catalogue has no such entry; only this session's registry does.
        (live.tools as Record<string, Tool>).sessionOnly = sessionOnly;

        const viaSession = await callTool(runtime, 'sessionOnly', { parameters: {} }, session.id);

        expect(viaSession).toEqual({
            ok: true,
            result: { sessionOnly: true },
            duration_ms: expect.any(Number)
        });

        // Without a session there is no registry to resolve it: the historical 404
        // still applies to a name the static catalogue does not know.
        const direct = await callApi(runtime, 'POST', executionPath('sessionOnly'), { parameters: {} });
        expect(direct).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: 'Unknown tool "sessionOnly".' } }
        });
    });

    it('reports a hostile thrown Proxy as a normal tool error, not an escaped catch', async () => {
        const captured: Harness[] = [];
        const runtime = createRuntime(captured);
        const session = await createSession(runtime);
        const live = captured[0];
        if (live === undefined) throw new Error('expected the preset factory to expose its harness');

        // The thrown Proxy makes `error instanceof SessionError` (and every other
        // `instanceof` in a catch) throw from its getPrototypeOf trap. The route
        // must classify it safely and return the ordinary 200 tool-error payload.
        await live.registerTool({
            name: 'hostileThrow',
            moduleText: `
export const metadata = {
    name: 'hostileThrow',
    description: 'Throws a hostile proxy.',
    tags: ['test', 'hostile']
};
export const execute = () => {
    throw new Proxy({}, {
        getPrototypeOf() {
            throw new Error('hostile-prototype');
        }
    });
};
`
        });

        const result = await callApi(runtime, 'POST', executionPath('hostileThrow', session.id), { parameters: {} });

        expect(result).toEqual({
            kind: 'json',
            status: 200,
            // Every canonical response carries the server epoch header (contract
            // `HARNESS_EPOCH_HEADER`), including a 200 tool-error answer.
            headers: { 'X-Harness-Epoch': expect.any(String) },
            body: {
                ok: false,
                error: { message: 'Unknown harness error' },
                duration_ms: expect.any(Number)
            }
        });
    });

    it('reports a static tool absent from the named session as a 404 instead of falling back', async () => {
        const captured: Harness[] = [];
        const runtime = createRuntime(captured);
        const session = await createSession(runtime);
        const live = captured[0];
        if (live === undefined) throw new Error('expected the preset factory to expose its harness');

        // Remove a statically listed entry from THIS session's registry. The API
        // must not execute a detached catalogue copy behind the session's back.
        delete (live.tools as Record<string, Tool>).timeNow;

        const result = await callApi(runtime, 'POST', executionPath('timeNow', session.id), { parameters: 'UTC' });

        expect(result.kind).toBe('json');
        expect(result.status).toBe(404);
        // The canonical 404 says the name is unknown IN THIS SESSION, which is the
        // routing rule this test exists for: no silent fallback to the static catalogue.
        expect((result as { body: unknown }).body).toEqual({
            error: { message: `Unknown tool "timeNow" in session "${session.id}".` }
        });
    });
});
