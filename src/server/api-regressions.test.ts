// T39 REGRESSION SUITE — the four real defects the migrated queue/canonical reads surfaced
// (T34/T35 asserted them as-observed and reported them; this file turns each one into an
// assertion that FAILS while the bug is present).
//
// Everything runs offline against scripted presets: no provider, no network, clock pinned.
// Every figure is asserted through the CANONICAL REST surface (a named read or a receipt),
// never through `store.get()`/`store.snapshot()` — the cheap projections are the product, and
// a copy-of-everything oracle would not fail when a projection goes blind.
//
// What each group pins (production files under test: ./api.ts, ./api-reads.ts):
//   A. `PATCH /config` input validation + ATOMICITY. The route used to write each key into the
//      live defaults as it walked the body and applied no length bound at all, so (i) a 200
//      answer could park an over-cap value in `defaults` and every LATER `POST /sessions` then
//      failed the shared validator (./config.ts:424-430) for a body the client never sent, and
//      (ii) a refused body had already mutated the keys that came before it.
//   B. `POST /cancel` type-checks `all`. `requireKnownFields` guarded the FIELD SET only, so
//      `{all:'yes'}` answered 200 and ran as `all:false` — the backlog the caller asked to drop
//      stayed queued, and the receipt published `dropped_queued_tasks: 0`.
//   C. the lane backlog is VISIBLE: a queued continuation (an attachment-bearing submit into a
//      RUNNING conversation, which cannot be steered — ./sessions.ts:6380-6384) appears on
//      `GET .../queue` in FIFO order, is counted by `session.queue_depth`, is named by
//      `POST .../cancel {all:true}`'s `dropped_queued_tasks`, and `TaskReceipt.queue_position`
//      is the contract's 1-based ordinal (./harness.swagger.yaml:5001-5005) of that ordering.
//      Concurrent plain-thread submit is NOT changed by any of this: an unfocused submit still
//      opens its own conversation and runs immediately (./queue.test.ts pins that).
//   D. tool registration states what it did to a PRIOR registration. The create path hardcoded
//      `created: true, replaced: false`, contradicting the kernel's own rule for the same write
//      (../harness.ts:1292-1293 + :1386-1399) and the budget figure in the same receipt.
//
// Cross-references: ./queue.test.ts (the migrated contract this suite sharpens),
// ./api-canonical.test.ts (response-shape pins), ./config.test.ts (the shared bounds owner).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { SessionStore } from './sessions';
import { HARNESS_ROUTES } from '../shared/harness-api';
import { bindApiCall, readOk, readTurn, submitTask, type CanonicalCall } from './canonical-reads.test-support';

const DEFAULTS = { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test', hasApiKey: true };

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The shared bounds, spelled here rather than imported from ./config.ts so a change to a cap
// fails this file loudly (it is the route's answer that is pinned, not the constant).
const BASE_URL_CAP_MESSAGE = 'A provider base URL cannot exceed 2048 characters.';
const MODEL_CAP_MESSAGE = 'A model name cannot exceed 256 characters.';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

const lastUser = (messages: readonly { role: string; content: unknown }[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];

    return last === undefined ? '' : String(last.content);
};

// A per-prompt gate, so a test can hold ONE conversation running while it submits behind it.
// `started(prompt)` resolves when the scripted transport has entered that prompt, which is the
// deterministic proof that the follow-up submit landed BEHIND an active run.
const gatedFixture = (): { preset: HarnessPreset; started: (p: string) => { promise: Promise<void>; resolve: () => void }; gate: (p: string) => { promise: Promise<void>; resolve: () => void } } => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts = new Map<string, ReturnType<typeof deferred>>();

    const slot = (map: Map<string, ReturnType<typeof deferred>>, prompt: string) => {
        const existing = map.get(prompt);
        if (existing !== undefined) return existing;

        const created = deferred();
        map.set(prompt, created);

        return created;
    };

    const preset: HarnessPreset = {
        name: 'gated',
        title: 'gated',
        description: 'gated scripted preset',
        requiresEndpoint: false,
        primary: 'gated',
        subagents: [],
        agents: ['gated'],
        tools: [],
        builtin: true,
        editable: true,
        create: (settings, progress) =>
            harness({
                agents: {
                    gated: agent({
                        model: settings.model,
                        instruction: 'Wait for a per-prompt gate.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            const prompt = lastUser(request.messages).trim();

                            slot(starts, prompt).resolve();

                            // Abort-aware: a cancel must settle the turn even when its gate is
                            // never released.
                            await new Promise<void>((resolve, reject) => {
                                if (request.signal?.aborted === true) {
                                    reject(new Error('The run was aborted.'));
                                    return;
                                }

                                request.signal?.addEventListener('abort', () => reject(new Error('The run was aborted.')), { once: true });
                                slot(gates, prompt).promise.then(resolve, reject);
                            });

                            yield { type: 'text', delta: `answer:${prompt}` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'gated',
                presets: false,
                report: { progress }
            })
    };

    return { preset, started: (prompt) => slot(starts, prompt), gate: (prompt) => slot(gates, prompt) };
};

const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        settings: SETTINGS,
        defaults: DEFAULTS,
        store: new SessionStore(SETTINGS, createHarnessRegistry(presets)),
        loadEnvironment: false
    });

const callOf = (runtime: HarnessRuntime): CanonicalCall => bindApiCall(runtime.api, '/v1/harness');

const createSession = async (call: CanonicalCall): Promise<string> => {
    const body = await readOk<{ session: { id: string } }>(call, 'POST', HARNESS_ROUTES.sessions(), 201, {
        harness: 'gated'
    });

    return body.session.id;
};

/** One `GET /config` document, read through the contract route (no store oracle). */
const readConfig = (call: CanonicalCall) =>
    readOk<{ defaults: { base_url: string; model: string; has_api_key: boolean } }>(
        call,
        'GET',
        HARNESS_ROUTES.config(),
        200
    );

/** The one figure every cancel assertion here shares: the receipt, exactly. */
type CancelBody = {
    cancelled: boolean;
    session_id: string;
    dropped_queued_tasks: number;
    active_turn_id?: string;
    revision: number;
};

const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('PATCH /config validates its input and mutates nothing when it refuses', () => {
    it('refuses an over-cap base_url with the shared validator message and keeps the defaults usable', async () => {
        const runtime = runtimeOf([gatedFixture().preset]);
        const call = callOf(runtime);

        // 2_049 characters: one past `MAX_BASE_URL_LENGTH` (./config.ts:140).
        const over = 'y'.repeat(2_049);
        const refused = await call('PATCH', HARNESS_ROUTES.config(), { settings: { base_url: over } });

        expect(refused.kind).toBe('json');
        if (refused.kind !== 'json') throw new Error('expected JSON');
        expect(refused.status).toBe(400);
        // The SAME words the shared validator uses (./config.ts:424-426), because a client that
        // gets 200 here and 400 from `POST /sessions` has no way to find out which body broke.
        expect(refused.body).toEqual({ error: { message: BASE_URL_CAP_MESSAGE } });

        // Nothing moved: `defaults` is still the endpoint the store boots with.
        expect((await readConfig(call)).defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/test',
            has_api_key: true
        });

        // The regression in one line: before the fix this answered 400 with
        // `A provider base URL cannot exceed 2048 characters.` for a body that named no base URL,
        // because the poisoned DEFAULT was validated at session creation instead.
        await expect(readOk(call, 'POST', HARNESS_ROUTES.sessions(), 201, { harness: 'gated' })).resolves.toBeDefined();

        // Exactly at the cap is a legal value (a bound, not a style rule).
        const atCap = await call('PATCH', HARNESS_ROUTES.config(), { settings: { base_url: 'y'.repeat(2_048) } });
        expect(atCap.kind === 'json' && atCap.status).toBe(200);
        expect((await readConfig(call)).defaults.base_url).toBe('y'.repeat(2_048));
    });

    it('refuses an over-cap model and leaves every other setting untouched', async () => {
        const runtime = runtimeOf([gatedFixture().preset]);
        const call = callOf(runtime);

        const refused = await call('PATCH', HARNESS_ROUTES.config(), { settings: { model: 'm'.repeat(257) } });

        expect(refused.kind).toBe('json');
        if (refused.kind !== 'json') throw new Error('expected JSON');
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: { message: MODEL_CAP_MESSAGE } });

        expect((await readConfig(call)).defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/test',
            has_api_key: true
        });

        await expect(readOk(call, 'POST', HARNESS_ROUTES.sessions(), 201, { harness: 'gated' })).resolves.toBeDefined();
    });

    it('applies a refused multi-key patch to NOTHING (the earlier keys do not stay written)', async () => {
        const runtime = runtimeOf([gatedFixture().preset]);
        const call = callOf(runtime);

        // The body that exposed the write-as-you-go loop: `base_url` is refused (blank), and the
        // `model` written BEFORE that check used to survive the 400.
        const refused = await call('PATCH', HARNESS_ROUTES.config(), {
            settings: { base_url: '', model: 'written-then-refused' }
        });

        expect(refused.kind).toBe('json');
        if (refused.kind !== 'json') throw new Error('expected JSON');
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: { message: 'A provider base URL cannot be empty.' } });

        // Both keys are exactly as they were — a 400 patch is a patch that did not happen.
        expect((await readConfig(call)).defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/test',
            has_api_key: true
        });

        // An oversize value in the same body as a VALID new credential issues nothing: the
        // T28 credential scope is only reassigned by a patch that commits.
        const credential = await call('PATCH', HARNESS_ROUTES.config(), {
            settings: { base_url: 'y'.repeat(2_049), api_key: 'client-key' }
        });

        expect(credential.kind === 'json' && credential.status).toBe(400);
        expect((await readConfig(call)).defaults.has_api_key).toBe(true);

        // A committed key write still flips the claim, and the key is never echoed.
        const issued = await readOk<{ defaults: Record<string, unknown> }>(
            call,
            'PATCH',
            HARNESS_ROUTES.config(),
            200,
            { settings: { api_key: 'client-key' } }
        );

        expect(issued.defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/test',
            has_api_key: true
        });
        expect(JSON.stringify(issued)).not.toContain('client-key');

        const cleared = await readOk<{ defaults: { has_api_key: boolean } }>(
            call,
            'PATCH',
            HARNESS_ROUTES.config(),
            200,
            { settings: { api_key: '' } }
        );

        expect(cleared.defaults.has_api_key).toBe(false);
    });
});

describe('POST /cancel type-checks `all` before it mutates anything', () => {
    it('refuses a non-boolean `all` with 400 and leaves the backlog exactly as it was', async () => {
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const call = callOf(runtime);
        const id = await createSession(call);

        // One running conversation, and one QUEUED continuation behind it (the attachment is what
        // makes steering impossible, so this is the case that used to be invisible).
        const first = await submitTask(call, id, { input: 'first' });
        await fixture.started('first').promise;

        const clip = (n: number) => ({
            id: `image-${n}`,
            kind: 'image',
            marker: `[Image ${n}]`,
            name: `p${n}.png`,
            mime: 'image/png',
            size: 12,
            data: 'iVBORw0KGgoAAAAA'
        });

        const queued = await submitTask(call, id, {
            input: 'clip-a',
            thread_id: first.thread_id,
            attachments: [clip(1)]
        });

        expect(queued.status).toBe('queued');

        for (const value of ['yes', 'no', 1, null] as const) {
            const refused = await call('POST', HARNESS_ROUTES.sessionsBySessionIdCancel(id), { all: value });

            expect(refused.kind).toBe('json');
            if (refused.kind !== 'json') throw new Error('expected JSON');
            expect(refused.status).toBe(400);
            // Verbatim legacy wording: the field set was never the problem, the VALUE type is.
            expect(refused.body).toEqual({ error: { message: '`all` must be a boolean when present.' } });
        }

        // Refused BEFORE mutation: the queued continuation is still on the queue page.
        const page = await readOk<{ items: { turn_id: string }[] }>(
            call,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdQueue(id),
            200
        );

        expect(page.items.map((row) => row.turn_id)).toEqual([queued.turn_id]);

        // An absent body and an explicit `false` keep answering the active-run-only cancel.
        const withoutBody = await call('POST', HARNESS_ROUTES.sessionsBySessionIdCancel(id));

        expect(withoutBody.kind).toBe('json');
        if (withoutBody.kind !== 'json') throw new Error('expected JSON');
        expect(withoutBody.status).toBe(200);

        // Releasing the gate lets the cancelled run settle so the session can drain.
        fixture.gate('first').resolve();
        await waitUntil(() => !runtime.store.liveSession(id).busy);
    });
});

describe('the lane backlog is a first-class queue: visible, FIFO, counted, and cancellable', () => {
    it('reports a queued continuation on every figure that claims to know the backlog', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => 2_000);

        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const call = callOf(runtime);
        const id = await createSession(call);

        const clip = (n: number) => ({
            id: `image-${n}`,
            kind: 'image',
            marker: `[Image ${n}]`,
            name: `p${n}.png`,
            mime: 'image/png',
            size: 12,
            data: 'iVBORw0KGgoAAAAA'
        });

        const first = await submitTask(call, id, { input: 'first' });

        await fixture.started('first').promise;

        // Two continuation submits, in order. Neither can steer (attachments are text-only in the
        // runtime's steering API), so both must land in the SAME conversation's backlog.
        const one = await submitTask(call, id, { input: 'clip-a', thread_id: first.thread_id, attachments: [clip(1)] });
        const two = await submitTask(call, id, { input: 'clip-b', thread_id: first.thread_id, attachments: [clip(2)] });

        // RECEIPT: both are queued, and each names its slot in the queue page's ordering. The
        // contract makes this figure 1-based (`minimum: 1`, ./harness.swagger.yaml:5001-5005), so
        // the first waiting task is `1`, not `0`.
        expect(one.status).toBe('queued');
        expect(two.status).toBe('queued');
        expect(one.queue_position).toBe(1);
        expect(two.queue_position).toBe(2);
        expect(one.steered).toBeUndefined();
        expect(two.steered).toBeUndefined();
        expect(String(one.turn_id)).toMatch(UUID_PATTERN);

        // THE QUEUE PAGE: the lane backlog IS the backlog. `position` is the 0-based slot of the
        // same ordering (./harness.swagger.yaml:5101-5104), so page row N-1 == receipt N.
        const page = await readOk<{ items: Record<string, unknown>[]; limit: number; next_cursor: string | null; total?: number }>(
            call,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdQueue(id),
            200
        );

        expect(page.items).toEqual([
            {
                turn_id: one.turn_id,
                index: expect.any(Number),
                position: 0,
                status: 'queued',
                prompt_preview: 'clip-a',
                prompt_chars: 6,
                thread_id: first.thread_id,
                // The conversation label rides with the row: a backlog panel names WHERE each
                // waiting task will continue, which is exactly what a lane-scoped queue is for.
                thread_label: 'GD1',
                attachment_count: 1,
                accepted_at: 2_000
            },
            {
                turn_id: two.turn_id,
                index: expect.any(Number),
                position: 1,
                status: 'queued',
                prompt_preview: 'clip-b',
                prompt_chars: 6,
                thread_id: first.thread_id,
                thread_label: 'GD1',
                attachment_count: 1,
                accepted_at: 2_000
            }
        ]);

        // FIFO is stated by the ordinals themselves: a continuation never sorts before the turn
        // that was accepted before it.
        const rows = page.items as unknown as { index: number }[];
        expect(rows[0].index < rows[1].index).toBe(true);

        // SESSION ROW: `queue_depth` counts pending work wherever it waits, so a backlog that is
        // visible on the queue page cannot be absent here (they are the same set).
        const session = await readOk<{ session: { status: string; queue_depth?: number; turn_count: number } }>(
            call,
            'GET',
            `${HARNESS_ROUTES.sessions()}/${id}`,
            200
        );

        expect(session.session.status).toBe('running');
        expect(session.session.queue_depth).toBe(2);

        // LIST ROW: the same figure on the collection read, because a rail that shows a badge
        // reads the list, not the detail.
        const list = await readOk<{ items: { id: string; queue_depth?: number }[] }>(
            call,
            'GET',
            HARNESS_ROUTES.sessions(),
            200
        );

        expect(list.items.map((row) => [row.id, row.queue_depth])).toEqual([[id, 2]]);

        // CANCEL ALL: the receipt must say how much it dropped, including what waits per
        // conversation. Before the fix this published `dropped_queued_tasks: 0` while two
        // continuations were deleted, so a client could not tell what the call cost.
        const cancelCall = call('POST', HARNESS_ROUTES.sessionsBySessionIdCancel(id), { all: true });

        // The route awaits the run it stops, so the gate is released once the cancel is in flight.
        await waitUntil(() => runtime.store.liveSession(id).lanes.size > 0);
        fixture.gate('first').resolve();

        const cancelled = await cancelCall;

        expect(cancelled.kind).toBe('json');
        if (cancelled.kind !== 'json') throw new Error('expected JSON');
        expect(cancelled.status).toBe(200);

        const receipt = cancelled.body as CancelBody;

        expect(receipt).toEqual({
            cancelled: true,
            session_id: id,
            dropped_queued_tasks: 2,
            active_turn_id: first.turn_id,
            revision: receipt.revision
        });

        // DROPPED, not hidden: the backlog is empty on the same read that reported it, and the
        // session row stops claiming a depth it no longer has (absent, never stale).
        const after = await readOk<{ items: unknown[] }>(call, 'GET', HARNESS_ROUTES.sessionsBySessionIdQueue(id), 200);

        expect(after.items).toEqual([]);

        await runtime.store.waitForIdle(id);

        const drained = await readOk<{ session: { status: string; queue_depth?: number } }>(
            call,
            'GET',
            `${HARNESS_ROUTES.sessions()}/${id}`,
            200
        );

        expect(drained.session.queue_depth).toBeUndefined();
        expect(drained.session.status).toBe('error');
    });

    it('keeps an unfocused submit concurrent instead of queueing it (the intended lane behaviour)', async () => {
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const call = callOf(runtime);
        const id = await createSession(call);

        const first = await submitTask(call, id, { input: 'first' });

        await fixture.started('first').promise;

        // An unfocused submit opens its OWN conversation and runs immediately beside the first.
        // Making the queue page see lanes must not turn that into a serialized backlog.
        const second = await submitTask(call, id, { input: 'second' });

        // `started('second')` resolves while `first` is STILL gated, which is the proof of
        // concurrency: the second conversation was executing, not waiting behind the first.
        await fixture.started('second').promise;

        // The receipt states the ACCEPTED state (`queued`: the record is complete before any
        // execution), and the two submits name different conversations.
        expect(second.status).toBe('queued');
        expect(second.thread_id).not.toBe(first.thread_id);

        expect((await readTurn(call, id, first.turn_id)).status).toBe('running');
        expect((await readTurn(call, id, second.turn_id)).status).toBe('running');

        // Neither is pending, so the page that now sees lane backlogs is correctly EMPTY here —
        // seeing lanes did not invent a backlog for work that is already running.
        const page = await readOk<{ items: unknown[] }>(call, 'GET', HARNESS_ROUTES.sessionsBySessionIdQueue(id), 200);

        expect(page.items).toEqual([]);

        const session = await readOk<{ session: { status: string; queue_depth?: number } }>(
            call,
            'GET',
            `${HARNESS_ROUTES.sessions()}/${id}`,
            200
        );

        expect(session.session.status).toBe('running');
        expect(session.session.queue_depth).toBeUndefined();

        fixture.gate('first').resolve();
        fixture.gate('second').resolve();
        await runtime.store.waitForIdle(id);
    });
});

describe('tool registration reports the prior registration it replaced', () => {
    const moduleText = (description: string) =>
        `export const metadata = { name: 'regress_tool', description: '${description}', tags: ['regression'] };\nexport const execute = () => ({ ok: 1 });\n`;

    it('answers created/replaced/previous_revision for a second create under the same name', async () => {
        const runtime = runtimeOf([gatedFixture().preset]);
        const call = callOf(runtime);
        const id = await createSession(call);
        const route = HARNESS_ROUTES.sessionsBySessionIdTools(id);

        const created = await readOk<{ registration: Record<string, unknown> }>(call, 'POST', route, 201, {
            name: 'regress_tool',
            description: 'first',
            tags: ['regression'],
            module_text: moduleText('first')
        });

        // A genuinely new name: created, not replaced, and no previous revision to name.
        expect(created.registration.name).toBe('regress_tool');
        expect(created.registration.created).toBe(true);
        expect(created.registration.replaced).toBe(false);
        expect(created.registration).not.toHaveProperty('previous_revision');
        const firstRevision = created.registration.source_revision;

        // The same name again. The kernel's rule (../harness.ts `acceptTool`) is
        // `created: !existed, replaced: existed`, and the budget figure in the SAME receipt does
        // not move; the hardcoded `created: true, replaced: false` contradicted both.
        const replaced = await readOk<{ registration: Record<string, unknown> }>(call, 'POST', route, 201, {
            name: 'regress_tool',
            description: 'second',
            tags: ['regression'],
            module_text: moduleText('second')
        });

        expect(replaced.registration.created).toBe(false);
        expect(replaced.registration.replaced).toBe(true);
        expect(replaced.registration.previous_revision).toBe(firstRevision);
        expect(replaced.registration.source_revision).not.toBe(firstRevision);

        // One creation, one slot: the budget the receipt publishes is the store's, unchanged by a
        // replacement.
        expect(replaced.registration.budget).toEqual(created.registration.budget);

        // And the live registry still resolves the NEWER definition through the session route.
        const executed = await readOk<{ result: unknown }>(
            call,
            'POST',
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(id, 'regress_tool'),
            200,
            { parameters: {} }
        );

        expect(executed.result).toEqual({ ok: 1 });

        const listed = await readOk<{ items: { name: string; description: string }[] }>(call, 'GET', route, 200);

        // The roster row maps the fields it names, so the SECOND definition is the live one — a
        // `replaced: true` receipt that left the older entry callable would fail here.
        expect(
            listed.items
                .filter((row) => row.name === 'regress_tool')
                .map((row) => ({ name: row.name, description: row.description }))
        ).toEqual([{ name: 'regress_tool', description: 'second' }]);
    });
});
