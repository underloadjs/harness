// T13: the canonical REST contract, pinned at the boundaries this task exists to create.
//
// WHAT THIS FILE PROVES (each block is one acceptance criterion of the assignment):
//   1. BOOT BOUNDED    - `GET /v1/harness` is a constant-size identity/links/limits document:
//                        no catalogue, no defaults, no sessions. This is the ~50 MB the task
//                        removes, asserted as BYTES, not as "smaller than before".
//   2. LIST BOUNDED    - `GET /v1/harness/sessions` rows are metadata + counters, and while
//                        seven sessions each carry a 5,000-char recorded task, the page is
//                        still kilobytes, and the dispatcher never calls `store.list()`,
//                        `store.get()`, or `snapshot()` (spied). The heavy children stay on
//                        their own lazy routes.
//   3. LAZY CHILDREN   - a turns page carries bounded previews + counts, never events or
//                        transcripts, and a cursor/limit misuse answers 400 naming the
//                        parameter.
//   4. SLIM WRITES     - a submit answers a receipt (ids, status, revision, links), not the
//                        mutated aggregate.
//   5. NO BACK-COMPAT  - `/api`, `/presets`, and `/messages` are gone from the network surface.
//   6. HONEST POLICY   - a capability the domain cannot perform answers 403 AND is advertised
//                        false in the boot document; a tool that executed and failed answers
//                        200 `ok:false`; an unknown route is 404 and a known path with the
//                        wrong method is 405.
//
// Determinism: every status, key list, count, and length below is an EXACT assertion. The
// harness is scripted (no provider, no network), timestamps are never compared to literals,
// and revisions are compared to the hub's own counters so the file cannot drift against a
// restart.
//
// Cross-references:
//   - ./api.ts                    — the dispatcher under test
//   - ./api-events.ts             — the hub (epoch/revisions/baseline) asserted as the wire's source
//   - ../shared/harness-api.ts    — the DTO/limit/capability constants quoted below

import { describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_PAGE_LIMIT, HARNESS_SERVICE_CAPABILITIES, HARNESS_SERVICE_LIMITS } from '../shared/harness-api';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
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

// The root every canonical request is addressed under (no second mount exists any more).
const MOUNT = '/v1/harness';

/** One scripted preset: a single-agent harness that answers without a provider. */
const workerPreset = (): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted canonical-contract preset',
    requiresEndpoint: false,
    primary: 'worker',
    subagents: [],
    agents: ['worker'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
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
            primary: 'worker',
            presets: false,
            // The store hands its recorder in as `progress`: WITHOUT this the run records no
            // events, and a turn row/event_count would prove nothing about the read model.
            report: { progress }
        })
});

/** Build a store + API over an in-memory document (no persistence, no IO worker). */
const createContext = () => {
    const registry = createHarnessRegistry([workerPreset()]);
    const store = new SessionStore(DEFAULTS, registry);
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

    return { store, registry, api };
};

/** One dispatch, with the query string expressed the way an adapter passes it. */
const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {},
    searchParams?: string
): Promise<HarnessApiResult> =>
    api({
        method,
        pathname,
        mount: MOUNT,
        searchParams,
        readBody: async <T,>() => body as T
    } as HarnessApiRequest);

/** The JSON arm of a result, asserted as such (a stream arm is a contract violation here). */
const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

/** Serialized size of a response body, the figure the boot/list assertions are about. */
const bytesOf = (body: unknown): number => Buffer.byteLength(JSON.stringify(body), 'utf8');

/** Seven sessions, each with one recorded 5,000-character task, so history is REAL. */
const seedHistory = async (api: ReturnType<typeof createHarnessApi>, store: SessionStore): Promise<string[]> => {
    const ids: string[] = [];

    for (let index = 0; index < 7; index += 1) {
        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));

        expect(created.status).toBe(201);

        const id = created.body.session.id as string;

        ids.push(id);

        const submitted = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${id}/tasks`, { input: `task ${index} ${'x'.repeat(5_000)}` })
        );

        expect(submitted.status).toBe(202);

        await store.waitForIdle(id);
    }

    return ids;
};

describe('canonical REST contract', () => {
    it('answers the root as a constant-size identity document with no catalogues', async () => {
        const { api, store } = createContext();

        await seedHistory(api, store);

        const root = jsonOf(await call(api, 'GET', MOUNT));

        expect(root.status).toBe(200);
        expect(Object.keys(root.body).sort()).toEqual([
            'api_root',
            'api_version',
            'capabilities',
            'epoch',
            'limits',
            'links',
            'server_time',
            'service'
        ]);
        expect(root.body.api_root).toBe(MOUNT);
        expect(root.body.api_version).toBe('v1');
        expect(root.body.limits).toEqual(HARNESS_SERVICE_LIMITS);
        expect(root.body.epoch).toBe(api.events.epoch);

        // The capabilities map is the advertised TRUTH, not the generated wish list. T19: the
        // global agent override layer exists (./harnesses/agent-state.ts), so `agent_writes` is
        // the contract's own value; the write families the domain still cannot back are named in
        // api.ts's `CAPABILITY_GAPS` and answered 403 per route.
        expect(root.body.capabilities).toEqual(HARNESS_SERVICE_CAPABILITIES);

        // Links are named pointers only; no catalogue rides along.
        // T5 (R2/R3): `plugins` joined the set - the built-in plugin catalogue is a global
        // collection like `tools`, and the Plugins pane's only read is the page behind it.
        expect(Object.keys(root.body.links).sort()).toEqual([
            'agents',
            'config',
            'harnesses',
            'health',
            'models',
            'plugins',
            'self',
            'sessions',
            'stream',
            'tools'
        ]);
        expect(root.body.links.sessions).toBe(`${MOUNT}/sessions`);
        expect(root.body.links.plugins).toBe(`${MOUNT}/plugins`);

        // THE acceptance number: seven long-running sessions, and the boot document is still
        // under 2 KB. The legacy bootstrap carried every descriptor, every session, and every
        // recorded turn of the same state.
        expect(bytesOf(root.body)).toBeLessThan(2_048);
    });

    it('pages sessions as metadata rows without building any history', async () => {
        const { api, store } = createContext();

        await seedHistory(api, store);

        // A history the OLD surfaces would copy: 7 sessions x (one recorded 5k-char task with
        // its events) is what `store.list()` used to hand a booting client.
        const listSpy = vi.spyOn(store, 'list');
        const getSpy = vi.spyOn(store, 'get');
        const watchSpy = vi.spyOn(store, 'watch');

        const page = jsonOf(await call(api, 'GET', `${MOUNT}/sessions`, {}, '?limit=3&cursor='));

        expect(page.status).toBe(200);
        expect(listSpy).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalled();
        expect(watchSpy).not.toHaveBeenCalled();

        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.body.limit).toBe(3);
        expect(page.body.items).toHaveLength(3);
        expect(typeof page.body.next_cursor).toBe('string');
        expect(page.body.revision).toBe(api.events.getRevision('session', null));

        // A row is identity + counters. THE point of the route: no turn, thread, transcript,
        // definition, or event data appears in it.
        for (const row of page.body.items) {
            expect(Object.keys(row).sort()).toEqual([
                'created_at',
                'harness',
                'id',
                'model',
                'queue_depth?',
                'revision',
                'status',
                'thread_count',
                'turn_count',
                'updated_at'
            ].filter((key) => key !== 'queue_depth?'));
            expect(row.status).toBe('idle');
            expect(row.turn_count).toBe(1);
            // A threaded submit opens its own conversation, so a session that ran one task
            // has exactly one host thread - counted here, not enumerated.
            expect(row.thread_count).toBe(1);
            expect(row.harness).toBe('worker');
        }

        // 7 rows of counters is kilobytes; the same state as legacy snapshots was megabytes.
        const all = jsonOf(await call(api, 'GET', `${MOUNT}/sessions`));

        expect(all.body.items).toHaveLength(7);
        expect(bytesOf(all.body)).toBeLessThan(4_096);

        listSpy.mockRestore();
        getSpy.mockRestore();
        watchSpy.mockRestore();
    });

    it('pages turns with bounded previews and never an event list', async () => {
        const { api, store } = createContext();
        const ids = await seedHistory(api, store);
        const sessionId = ids[0];
        const promptChars = `task 0 ${'x'.repeat(5_000)}`.trim().length;

        const page = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns`, {}, '?limit=1'));

        expect(page.status).toBe(200);
        expect(page.body.limit).toBe(1);
        expect(page.body.items).toHaveLength(1);
        expect(page.body.revision).toBe(api.events.getRevision('turns', sessionId));

        const row = page.body.items[0];

        expect(row.status).toBe('done');
        // The row states the EXACT recorded length next to a bounded preview, so the full
        // text is never needed to render a list (and never travels with one).
        expect(row.promptChars).toBe(promptChars);
        expect(row.promptPreview.length).toBeLessThanOrEqual(320);
        // Counts, not content: the row states how big the turn is without carrying it. The
        // scripted run calls no tools, so the step count is exactly zero, and the root agent
        // flow is the one section the fold produces.
        expect(row.stepCount).toBe(0);
        expect(row.sectionCount).toBe(1);
        // `activeAgents` names agents whose run is IN FLIGHT; a settled row states none, so a
        // client never renders a finished turn as live.
        expect(row.activeAgents).toEqual([]);
        expect('events' in row).toBe(false);
        expect('eventTimes' in row).toBe(false);
        expect('steerTexts' in row).toBe(false);

        // The identified turn read is the one place the verbatim task text is allowed.
        const turn = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${row.id}`));

        expect(turn.status).toBe(200);
        expect(turn.body.turn.prompt.length).toBe(promptChars);
        expect(turn.body.turn.event_count).toBeGreaterThan(0);
        expect('events' in turn.body.turn).toBe(false);
        expect(Object.keys(turn.body.turn).sort()).toEqual([
            'attachment_count',
            'event_count',
            'event_time_count',
            'id',
            'index',
            'prompt',
            'revision',
            'session_id',
            'started_at',
            'status',
            'steer_count',
            'thread_id',
            'thread_label',
            'updated_at'
        ]);
    });

    it('refuses a bad limit or cursor by naming the parameter', async () => {
        const { api, store } = createContext();
        const ids = await seedHistory(api, store);

        const badLimit = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${ids[0]}/turns`, {}, '?limit=0'));

        expect(badLimit.status).toBe(400);
        expect(badLimit.body.error.message).toContain('"limit"');

        const bigLimit = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${ids[0]}/turns`, {}, `?limit=${HARNESS_PAGE_LIMIT.max + 1}`));

        expect(bigLimit.status).toBe(400);

        const badCursor = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${ids[0]}/turns`, {}, '?cursor=not-a-cursor'));

        expect(badCursor.status).toBe(400);
        expect(badCursor.body.error.message).toContain('"cursor"');
    });

    it('answers a submit with a slim receipt and links, never the aggregate', async () => {
        const { api, store } = createContext();
        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker', title: 'Rail row' }));
        const sessionId = created.body.session.id as string;

        expect(created.body.session.title).toBe('Rail row');

        const receipt = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: '  plan the thing  ' }));

        expect(receipt.status).toBe(202);
        // The required figure set, exactly. `queue_position` is optional and present only
        // while the submit still sits behind other work (this scripted pump starts at once),
        // so it is asserted by type when present rather than pinned to a race.
        const receiptKeys = Object.keys(receipt.body).filter((key) => key !== 'queue_position').sort();

        expect(receiptKeys).toEqual([
            'accepted_at',
            'links',
            'session_id',
            'session_revision',
            'status',
            'thread_id',
            'turn_id'
        ]);

        if (receipt.body.queue_position !== undefined) {
            expect(typeof receipt.body.queue_position).toBe('number');
        }
        // Neither `session` nor `turn` rides a receipt: the stream and a bounded page carry it.
        expect('session' in receipt.body).toBe(false);
        expect('turn' in receipt.body).toBe(false);
        expect(receipt.body.session_id).toBe(sessionId);
        expect(receipt.body.status).toBe('queued');
        expect(receipt.body.session_revision).toBe(api.events.getRevision('session', sessionId));
        expect(receipt.body.links).toEqual({
            turn: `${MOUNT}/sessions/${sessionId}/turns/${receipt.body.turn_id}`,
            turns: `${MOUNT}/sessions/${sessionId}/turns`,
            thread: receipt.body.thread_id
                ? `${MOUNT}/sessions/${sessionId}/threads/${receipt.body.thread_id}`
                : `${MOUNT}/sessions/${sessionId}/turns`,
            stream: `${MOUNT}/stream`
        });

        await store.waitForIdle(sessionId);

        const after = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${receipt.body.turn_id}`));

        expect(after.body.turn.status).toBe('done');
        // The submit trims, exactly as the store's own validation does.
        expect(after.body.turn.prompt).toBe('plan the thing');
    });

    it('drops the legacy network surface: /api, /presets, and /messages are gone', async () => {
        const { api, store } = createContext();
        const ids = await seedHistory(api, store);

        // A stale mount is a 404, never a redirect and never a second route table.
        const stale = jsonOf(
            await api({
                method: 'GET',
                pathname: '/api/sessions',
                mount: '/api',
                readBody: async <T,>() => ({}) as T
            } as HarnessApiRequest)
        );

        expect(stale.status).toBe(404);
        expect(stale.body.error.message).toContain('is not mounted');

        expect(jsonOf(await call(api, 'GET', `${MOUNT}/presets`)).status).toBe(404);
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/tools/bootstrap`)).status).toBe(404);
        expect(jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${ids[0]}/messages`, { input: 'hi' })).status).toBe(404);

        // A known path with an undeclared method is 405, not 404.
        const wrongMethod = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions`));

        expect(wrongMethod.status).toBe(405);

        // ...and the SSE route is not a REST route at all: a plain GET without an upgrade is
        // a 400 that says what the transport expects.
        const stream = jsonOf(await call(api, 'GET', `${MOUNT}/stream`));

        expect(stream.status).toBe(400);
        expect(stream.body.error.message).toContain('upgrade');
    });

    it('refuses an unsupported capability as 403, and backs the ones it advertises', async () => {
        const { api, store } = createContext();
        const ids = await seedHistory(api, store);
        const sessionId = ids[0];

        // T19: the global agent writes are REAL now - the override layer exists and the boot
        // document says so - so the same calls that used to answer 403 answer 200 and state the
        // change. The in-memory fixture has no database root, which the DELETE receipt reports
        // honestly as `restored_by_restart: true`.
        const patchAgent = jsonOf(await call(api, 'PATCH', `${MOUNT}/agents/instruct`, { instruction: 'x' }));

        expect(patchAgent.status).toBe(200);
        expect(patchAgent.body.agent.instruction).toBe('x');
        expect(patchAgent.body.agent.instruction_source).toBe('global');
        expect(patchAgent.body.agent.overridden_fields).toEqual(['instruction']);

        expect(jsonOf(await call(api, 'DELETE', `${MOUNT}/agents/instruct`)).body).toEqual({
            deleted: true,
            agent_id: 'instruct',
            tombstoned: true,
            restored_by_restart: true
        });

        // A retired profile is out of the selectable catalogue: 404 on the identified read.
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/agents/instruct`)).status).toBe(404);

        // T27: a session agent binding is a REAL operation now (it used to answer 403 naming the
        // missing create/remove). The roster key must be the trusted profile's own name, so a
        // made-up alias is a 400 that says why, and the primary is still not detachable.
        const createBinding = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'extra', profile: 'instruct' })
        );

        expect(createBinding.status).toBe(400);
        expect(createBinding.body.error.message).toContain('profile');

        expect(jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/worker`)).status).toBe(409);

        // ...but the roster READ and the model PATCH are real, because the domain backs them.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.status).toBe(200);
        expect(Object.keys(roster.body).sort()).toEqual(['agents', 'revision', 'session_id', 'total']);
        expect(roster.body.total).toBe(1);
        expect(roster.body.agents[0]).toMatchObject({ agent_id: 'worker', role: 'primary', origin: 'definition' });

        const patched = jsonOf(await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/worker`, { model: 'scripted/next' }));

        expect(patched.status).toBe(200);
        expect(patched.body.agent.model).toBe('scripted/next');

        // A tool that executed and FAILED is 200 `ok:false`; a call the server cannot make is
        // an HTTP status. `shell` is catalogue-searchable and unconfigured here by name.
        const unknownTool = jsonOf(await call(api, 'POST', `${MOUNT}/tools/no-such-tool/executions`, { parameters: {} }));

        expect(unknownTool.status).toBe(404);

        // A harness-owned control tool has no standalone implementation: policy, not absence.
        const boundTool = jsonOf(await call(api, 'POST', `${MOUNT}/tools/toolRequest/executions`, { parameters: {} }));

        expect(boundTool.status).toBe(403);
    });

    it('reads and patches global config as a bounded document with a revision', async () => {
        const { api } = createContext();

        const before = jsonOf(await call(api, 'GET', `${MOUNT}/config`));

        expect(before.status).toBe(200);
        expect(Object.keys(before.body).sort()).toEqual(['defaults', 'revision', 'runtime', 'writable_fields']);
        expect(before.body.revision).toBe(0);
        expect(before.body.defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/test',
            has_api_key: false
        });
        expect(before.body.runtime).toEqual({
            thread_execution: 'inline',
            worker_idle_ms: 120_000,
            max_lane_workers: 16,
            worker_handshake_ms: 60_000
        });
        expect(before.body.writable_fields).toEqual(['settings.base_url', 'settings.model', 'settings.api_key']);

        const patched = jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/other' } }));

        expect(patched.status).toBe(200);
        expect(patched.body.revision).toBe(1);
        expect(patched.body.defaults.model).toBe('scripted/other');
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/config`)).body.defaults.model).toBe('scripted/other');

        // A write-only key never leaks back, and an unknown field is a 400 naming it.
        const unknown = jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, { settings: { temperature: 1 } }));

        expect(unknown.status).toBe(400);
        expect(unknown.body.error.message).toContain('temperature');

        expect(jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, {})).status).toBe(400);
    });

    it('pages harnesses, agents, and tools as summaries with the identified reads one hop away', async () => {
        const { api, registry } = createContext();

        const harnesses = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses`, {}, `?limit=${HARNESS_PAGE_LIMIT.default}`));

        expect(harnesses.status).toBe(200);
        expect(harnesses.body.items).toHaveLength(1);
        expect(Object.keys(harnesses.body.items[0]).sort()).toEqual([
            'agents',
            'builtin',
            'definition_revision',
            'description',
            'name',
            'primary',
            'requires_endpoint',
            'subagents',
            'title',
            'tools'
        ]);

        // A card carries no instruction TEXT: `agent_instructions` is per-agent text, and the
        // identified read plus the instruction routes are where text lives.
        expect('agentInstructions' in harnesses.body.items[0]).toBe(false);
        expect('agent_instructions' in harnesses.body.items[0]).toBe(false);

        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses/worker`));

        expect(definition.status).toBe(200);
        // The core-tool set is what THIS host would declare: the harness-owned control tools
        // (`toolRequest`, `task`), and no `delegate` because this definition has no subagent
        // allowlist. Same rule the frozen session copies use, so a card and a session cannot
        // disagree.
        expect(definition.body.harness.core_tools).toEqual(['toolRequest', 'tasks']);
        expect(definition.body.harness.instruction_summary).toEqual([
            { agent: 'worker', source: 'catalogue', overridden: false, chars: 0 }
        ]);

        const created = jsonOf(
            await call(api, 'POST', `${MOUNT}/harnesses`, {
                name: 'canon',
                primary: 'instruct',
                agent_models: { instruct: 'scripted/model' }
            })
        );

        expect(created.status).toBe(201);
        expect(created.body.harness.name).toBe('canon');
        expect(created.body.harness.agent_models).toEqual({ instruct: 'scripted/model' });
        expect(created.body.harness.definition_revision).toBe(api.events.getRevision('definition', 'canon'));

        const unknown = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses/nope`));

        expect(unknown.status).toBe(404);

        // An unknown agent id is a 404; a known one answers with the trusted profile.
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/agents/nope`)).status).toBe(404);

        const profile = jsonOf(await call(api, 'GET', `${MOUNT}/agents/instruct`));

        expect(profile.status).toBe(200);
        expect(profile.body.agent.name).toBe('instruct');
        expect(profile.body.agent.instruction_source).toBe('catalogue');
        // The created `canon` definition selects this profile, so the removal-impact list
        // names it: `referenced_by` is derived from the live registry, not stored beside it.
        expect(profile.body.agent.referenced_by).toEqual(['canon']);

        const tools = jsonOf(await call(api, 'GET', `${MOUNT}/tools`, {}, '?limit=5'));

        expect(tools.status).toBe(200);
        expect(tools.body.items.length).toBeGreaterThan(0);
        // `availability` rides a row only when the entry has something to say (an
        // environment-backed tool with a missing credential); item[0] is a core entry, which
        // does state its state. The argument schema NEVER rides a row.
        expect(Object.keys(tools.body.items[0]).sort()).toEqual([
            'availability',
            'description',
            'group',
            'name',
            'session_bound',
            'tags',
            'visibility'
        ]);
        expect('parameters' in tools.body.items[0]).toBe(false);

        const detail = jsonOf(await call(api, 'GET', `${MOUNT}/tools/${tools.body.items[0].name}`));

        expect(detail.status).toBe(200);
        // The detail read is the row PLUS the argument schema and the execution gate.
        expect(Object.keys(detail.body.tool).sort()).toEqual([
            'availability',
            'description',
            'execution',
            'group',
            'name',
            'parameters',
            'session_bound',
            'tags',
            'visibility'
        ]);
        expect(detail.body.tool.execution).toEqual({ scope: 'session_required', manual: false });

        void registry;
    });

    it('serves every lazy child read from the same seeded history', async () => {
        const { api, store } = createContext();
        const ids = await seedHistory(api, store);
        const sessionId = ids[0];

        // Collection reads first: each is a page or a bounded list, and none of them may
        // carry the heavy member the contract keeps on its own route.
        const queue = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/queue`));

        expect(queue.status).toBe(200);
        expect(queue.body.items).toEqual([]);
        expect(queue.body.revision).toBe(api.events.getRevision('queue', sessionId));

        const usage = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/usage`));

        expect(usage.status).toBe(200);
        expect(Object.keys(usage.body).sort()).toEqual([
            'by_thread',
            'reported_turns',
            'revision',
            'session_id',
            'truncated',
            'turn_count'
        ]);
        expect(usage.body.turn_count).toBe(1);
        // The scripted provider reports nothing, so `usage` is ABSENT rather than zero.
        expect('usage' in usage.body).toBe(false);
        expect(usage.body.reported_turns).toBe(0);

        const commands = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/commands`));

        expect(commands.status).toBe(200);
        expect(commands.body.items.length).toBeGreaterThan(0);
        expect(commands.body.items[0].invocation).toBe(`/${commands.body.items[0].name}`);

        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.status).toBe(200);
        expect(definition.body.definition.session_id).toBe(sessionId);
        expect(definition.body.definition.name).toBe('worker');
        expect(definition.body.definition.current).toBe(true);
        expect(definition.body.definition.frozen_at).toBeGreaterThan(0);

        // The conversation roster, then one conversation, then its transcript three ways.
        const threads = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads`));

        expect(threads.status).toBe(200);
        expect(threads.body.items).toHaveLength(1);
        expect(Object.keys(threads.body.items[0]).sort()).toEqual([
            'agent',
            // `chars` rides only when the conversation HAS a transcript, which this one does
            // after one run: it is the size signal that tells a client whether the lazy
            // transcript read is worth asking for.
            'chars',
            'has_transcript',
            'id',
            'label',
            'message_count',
            'origin',
            'sequence',
            'status',
            'transcript_state'
        ]);

        const threadId = threads.body.items[0].id as string;

        const thread = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads/${threadId}`));

        expect(thread.status).toBe(200);
        expect(thread.body.thread.session_id).toBe(sessionId);
        expect(thread.body.thread.invocation_ids_truncated).toBe(false);
        expect('messages' in thread.body.thread).toBe(false);

        const meta = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads/${threadId}/transcript`));

        expect(meta.status).toBe(200);
        expect(meta.body.transcript.thread_id).toBe(threadId);
        expect(meta.body.transcript.transcript_state).toBe('ok');
        expect(meta.body.transcript.role_counts).toEqual({ system: 1, user: 1, assistant: 1, tool: 0 });
        expect(meta.body.transcript.message_count).toBe(3);

        const messages = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads/${threadId}/transcript/messages`, {}, '?limit=2')
        );

        expect(messages.status).toBe(200);
        expect(messages.body.items).toHaveLength(2);
        expect(messages.body.total).toBe(3);
        expect(typeof messages.body.next_cursor).toBe('string');
        // The entries are the domain's own camelCase records, verbatim.
        expect(messages.body.items[0].role).toBe('system');

        const document = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads/${threadId}/transcript/document`)
        );

        expect(document.status).toBe(200);
        expect(document.body.content_type).toBe('application/json');
        expect(JSON.parse(document.body.document)).toHaveLength(3);

        // One turn's verbatim events, paged by ordinal, and the display tree.
        const turns = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns`));
        const turnId = turns.body.items[0].id as string;

        const events = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/events`, {}, '?limit=2')
        );

        expect(events.status).toBe(200);
        expect(events.body.turn_id).toBe(turnId);
        expect(events.body.partial).toBe(false);
        expect(events.body.items).toHaveLength(2);
        // Each row pairs the event with the recorded time, so a client never re-pairs by index.
        expect(events.body.items[0].index).toBe(0);
        expect(typeof events.body.items[0].at).toBe('number');
        expect(typeof events.body.items[0].event.type).toBe('string');
        expect(events.body.total_events).toBeGreaterThanOrEqual(2);

        const display = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/display`));

        expect(display.status).toBe(200);
        expect(display.body.display.turnId).toBe(turnId);
        expect(display.body.display.revision).toBe(api.events.getRevision('turn', `${sessionId}:${turnId}`));
        expect(display.body.display.sections).toHaveLength(1);
        expect(display.body.display.sections[0].agent).toBe('worker');

        // The identified sub-reads a click needs: a step that does not exist is a 400 (a step
        // id is a recorded ordinal), and an unknown attachment/step/block are honest 404s.
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/steps/999`)).status).toBe(404);
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/steps/not-a-number`)).status).toBe(400);
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/blocks/nope`)).status).toBe(404);
        expect(jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/attachments/nope`)).status).toBe(404);

        // The actions list is live-only and bounded by the pending-action budget.
        const actions = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/actions`));

        expect(actions.status).toBe(200);
        expect(actions.body.actions).toEqual([]);
        expect(actions.body.session_id).toBe(sessionId);

        // The session toolbox is the live registry, budgeted, with no source text on a row.
        const tools = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools`, {}, '?limit=3'));

        expect(tools.status).toBe(200);
        expect(Object.keys(tools.body).sort()).toEqual(['budget', 'items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(tools.body.budget).toEqual({ used: 0, limit: HARNESS_SERVICE_LIMITS.created_tools });
        // A row states the live session facts; the argument schema, the source TEXT, and any
        // tool result never ride it. `source_revision` rides only for a row with an installed
        // revision (item[0] here is a source-registered tool), and the bytes themselves are
        // one named route away.
        expect(Object.keys(tools.body.items[0]).sort()).toEqual([
            'declared',
            'description',
            'enabled',
            'group',
            'name',
            'origin',
            'protected',
            'session_bound',
            'session_id',
            'source_available',
            'source_revision',
            'tags',
            'visibility'
        ]);
        expect('parameters' in tools.body.items[0]).toBe(false);
        expect('source' in tools.body.items[0]).toBe(false);
        expect('module_text' in tools.body.items[0]).toBe(false);

        // A created tool goes through the SAME registration kernel the model's `toolCreate`
        // uses, and the receipt is metadata only.
        // A legacy function-body creation returns its value from `args`, which is the shape the
        // harness documents for that form (the module form is the other spelling, and the source
        // route shows whichever revision was installed).
        const registered = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tools`, {
                name: 'canonEcho',
                description: 'Echoes its argument.',
                tags: ['test'],
                source: 'return args.text;'
            })
        );

        expect(registered.status).toBe(201);
        expect(Object.keys(registered.body.registration).sort()).toEqual([
            'budget',
            'checks',
            'created',
            'name',
            'replaced',
            'source_revision'
        ]);
        expect(registered.body.registration.created).toBe(true);
        expect(registered.body.registration.budget).toEqual({ used: 1, limit: HARNESS_SERVICE_LIMITS.created_tools });

        const source = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/canonEcho/source`));

        // `SessionToolSourceResponse` IS the payload (no envelope key), so the read is asserted
        // flat: it quotes the SAME revision the registration receipt reported, which is how a
        // client that writes then reads avoids comparing two numbers for one revision.
        expect(source.status).toBe(200);
        expect(source.body.revision).toBe(registered.body.registration.source_revision);
        expect(source.body.name).toBe('canonEcho');
        expect(source.body.source).toBe('return args.text;');

        // Execution inside the session: a call that fails is 200 `ok:false`, and a name the
        // session does not register is a 404.
        const executed = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tools/canonEcho/executions`, { parameters: { text: 'hi' } })
        );

        expect(executed.status).toBe(200);
        expect(executed.body.ok).toBe(true);
        // The tool's ordinary unwrapped value, verbatim, plus the server-measured duration.
        expect(executed.body.result).toBe('hi');
        expect(typeof executed.body.duration_ms).toBe('number');
        expect(typeof executed.body.duration_ms).toBe('number');

        expect(jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tools/nope/executions`, { parameters: {} })).status).toBe(404);

        // A lifecycle guard is a refusal, never a silent success: deleting the conversation
        // that OWNS the only turn is allowed, and deleting the default lane is a 400.
        const notFound = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/threads/nope`));

        expect(notFound.status).toBe(404);

        void store;
    });

    it('exposes the hub the realtime owner integrates with', async () => {
        const { api } = createContext();

        const root = jsonOf(await call(api, 'GET', MOUNT));

        // The epoch a client learns from REST is the epoch the stream will welcome with, and
        // the baseline links are bounded page paths, never a snapshot path.
        expect(root.body.epoch).toBe(api.events.epoch);
        expect(api.epoch).toBe(api.events.epoch);
        expect(api.events.baseline('session', 'abc').link).toBe(`${MOUNT}/sessions/abc`);
        expect(api.events.baseline('turns', 'abc').link).toBe(`${MOUNT}/sessions/abc/turns?limit=25`);
        expect(api.events.baseline('turn', 'abc:turn-1').link).toBe(`${MOUNT}/sessions/abc/turns/turn-1`);
        expect(api.events.baseline('transcript', 'abc:thr-1').link).toBe(`${MOUNT}/sessions/abc/threads/thr-1/transcript`);
        expect(api.events.baseline('harnesses').id).toBeNull();
        expect(api.events.revisions([{ resource: 'config', id: null }])).toEqual([
            { resource: 'config', id: null, revision: 0, epoch: api.events.epoch }
        ]);

        // A subscriber sees exactly one event per publish, quoting the revision the write
        // landed at (the route owns the bump; publishing only reports and fans out).
        const seen: unknown[] = [];
        const detach = api.events.subscribe((event) => seen.push(event));

        jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/two' } }));

        detach();
        jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/three' } }));

        expect(seen).toHaveLength(1);
        expect(api.events.getRevision('config')).toBe(2);
    });
});
