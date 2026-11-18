// T21 — the CLONE-COUNT contract of the display read (and of the roster page).
//
// WHY THIS FILE EXISTS. The inclusion join (`./api.ts` `contextSegmentIncludedOf`) is a
// request-time verdict, so it runs once per context block, and every visit used to read the
// candidate conversation through `harness.threadMessages` — one JSON deep clone per visit
// (../harness.ts:860-861 `cloneMessages`, called at :7544). On the real session that meant 9,068
// clones and ~378 MB of transcript bytes for ONE display read of 1,099 blocks, i.e. 2,753 ms of
// 2,776 ms spent copying (measured; Temp/coding-t21/probe2.ts, which is also how the fix was A/B'd:
// 11 clones and ~0.5 MB after, ~20 ms, same body). Nothing in the existing suite could see that,
// because the payloads are identical either way — so the regression is pinned HERE, on the seam
// that costs, in the same style the package already pins request-count and compactness budgets
// (../frontend/display-flood-main.test.ts pins request counts; ./view.test.ts pins compactness).
//
// THE CONTRACT, stated exactly:
//   1. ONE display read clones a conversation's transcript AT MOST ONCE, no matter how many
//      segments resolve inside it — `clones === distinctConversationsProbed`, and never more than
//      `threads() + 1`;
//   2. the memo is PER REQUEST: the next read clones again, so `included` stays a live verdict
//      (a plugin's `setIncluded` or another tab's toggle must show up on the next read —
//      ./api.ts `contextSegmentIncludedOf` documents why no verdict may be cached across
//      requests);
//   3. the fast path is the SAME path that produces the verdicts: the tri-state census is the
//      pinned one for this turn (`true` where an entry answers, ABSENT where the join cannot
//      single one out) — a bound paid for by dropping verdicts would be worthless;
//   4. the roster page clones only the conversations it ANSWERS WITH: a `limit=1` page reads ONE
//      transcript, and its row is byte-identical to the same row of the unbounded page
//      (./api.ts `threadRecordsOf`/`threadRowFor` — the page filter runs on the thread RECORDS,
//      whose `agent`/`status`/`sequence` fields are exactly the row's).
//
// The seam is wrapped, not mocked: `store.liveSession(id).harness` is the live object every read
// path resolves `threadMessages` through, so counting its calls counts the route's real clones.
//
// Cross-references:
//   - ./api.ts `transcriptViewOf`      — the per-request view that bounds the clones
//   - ./view.test.ts                   — the verdict/ambiguity contracts this read must not break
//   - Temp/coding-t21/probe2.ts        — the real-session A/B behind the numbers above

import { describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessStream, HarnessStreamEvent, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { SessionStore } from './sessions';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import type { SessionTurn } from './protocol';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret',
    model: 'scripted/test'
};

// A preset with enough SEGMENTS to make the bound mean something: thinking, a tool round (the
// entry join), then two answer runs (the answer join, one block per run — see ./turn-projector.ts
// `closeWriters`). Twelve joinable segments over a handful of conversations is the ratio that
// turned the per-visit clone into a 2.7 s read, and it is the ratio this test pins.
const requestStream = (requests: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* (): AsyncGenerator<HarnessStreamEvent> {
        const frames = requests[index] ?? requests[requests.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const floodPreset = (name = 'flooder'): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    // R15 — the map is the team: the entry holds Rank A and BOTH helpers are Rank B, so
    // the roster has two distinct ranks (which is what registers `delegate`) while neither helper
    // may delegate to the other — same-rank peers are not targets.
    entry: name,
    ranks: { [name]: 'A', 'helper-a': 'B', 'helper-b': 'B' },
    agents: [name, 'helper-a', 'helper-b'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: 'Think, take one tool round, then answer twice.',
                    stream: requestStream([
                        [
                            { type: 'reasoning', delta: 'planning the work' },
                            { type: 'text', agent: name, delta: 'opening note' },
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [{ id: 'call-1', name: 'tasks', arguments: JSON.stringify({ tasks: [{ text: 'alpha' }] }) }],
                                usage: { input: 500, output: 20, total: 520 }
                            }
                        ],
                        [
                            { type: 'reasoning', delta: 'reading the result' },
                            { type: 'text', agent: name, delta: 'closing note' },
                            { type: 'done', stopReason: 'stop', toolCalls: [], usage: { input: 620, output: 25, total: 645 } }
                        ]
                    ]),
                    tools: ['task']
                }),
                // Two idle Rank B peers: each owns a default conversation (`agent:helper-a`,
                // `agent:helper-b`), so the candidate roster holds MORE than one conversation and
                // "one clone per conversation" cannot be satisfied by a single-transcript session.
                'helper-a': agent({ model: settings.model, instruction: 'Idle helper A.', stream: async function* () {} }),
                'helper-b': agent({ model: settings.model, instruction: 'Idle helper B.', stream: async function* () {} })
            },
            entry: name,
            presets: false,
            report: { progress }
        })
});

const storeOf = (presets: HarnessPreset[]): SessionStore => new SessionStore(SETTINGS, createHarnessRegistry(presets));

const apiOf = (store: SessionStore) =>
    createHarnessApi({
        store,
        defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true },
        registry: createHarnessRegistry([floodPreset()])
    });

const call = async (
    api: (request: HarnessApiRequest) => Promise<HarnessApiResult>,
    method: string,
    pathname: string,
    // T13 query channel: `limit`/`cursor`/filters ride on `searchParams`, never inside
    // `pathname` (./api.ts `queryOf` normalizes this shape).
    search?: string,
    // The JSON body a mutation route reads (a read carries none, and `readBody` answers `{}`).
    body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> => {
    const result = await api({
        method,
        pathname,
        mount: '/v1/harness',
        ...(search === undefined ? {} : { searchParams: search }),
        readBody: async <T>() => (body === undefined ? ({} as T) : (body as T))
    });

    if (result.kind !== 'json') throw new Error(`expected a json result, got ${result.kind}`);

    return { status: result.status, json: result.body as Record<string, unknown> };
};

const runTurn = async (store: SessionStore, id: string, input: string): Promise<SessionTurn> => {
    const accepted = await store.dispatch(id, input);

    await store.waitForIdle(id);

    return store.get(id).turns.find((candidate) => candidate.id === accepted.turn.id) as SessionTurn;
};

/** Wraps the clone seam on the LIVE record and answers the counter. Every
 *  `harness.threadMessages` call IS one `cloneMessages` JSON deep clone (../harness.ts:7544),
 *  which is the only thing that made the display read slow. */
const watchClones = (store: SessionStore, sessionId: string) => {
    const harnessRef = store.liveSession(sessionId).harness as { threadMessages: (id: string, caller?: string) => unknown[] };
    const original = harnessRef.threadMessages.bind(harnessRef);
    const perThread = new Map<string, number>();

    const read = () => Object.fromEntries(perThread);

    harnessRef.threadMessages = (id: string, caller?: string) => {
        perThread.set(id, (perThread.get(id) ?? 0) + 1);

        return original(id, caller);
    };

    return {
        reset: (): void => {
            perThread.clear();
        },
        read,
        total: (): number => Object.values(read()).reduce((sum, calls) => sum + calls, 0),
        release: (): void => {
            harnessRef.threadMessages = original;
        }
    };
};

/** The served bar, flattened to `[blockId, verdict]` with ABSENT spelled `unaddressable` (the
 *  tri-state is the contract: absent != false, ../shared/turn-display.ts `ContextBlock.included`). */
const barOf = (json: Record<string, unknown>): Record<string, unknown>[] =>
    ((json.display as { sections: { context?: Record<string, unknown>[] }[] }).sections ?? []).flatMap((section) =>
        (section.context ?? []).map((segment) => ({
            id: segment.id,
            kind: segment.kind,
            included: Object.hasOwn(segment, 'included') ? segment.included : 'unaddressable'
        }))
    );

describe('the display read clones each conversation at most once (T21)', () => {
    it('bounds one display read to one clone per conversation, keeps the verdicts, and re-clones per request', async () => {
        const store = storeOf([floodPreset()]);
        const api = apiOf(store);
        const created = await store.create('flooder');
        const turn = await runTurn(store, created.id, 'do the work');
        const turnId = turn.id;
        const route = `/v1/harness/sessions/${created.id}/turns/${turnId}/display`;

        // The roster this read may probe: the entry conversation plus one default conversation
        // per configured agent (../harness.ts keeps `agent:<name>` rows for every agent), and the
        // bound the fix promises is in terms of THIS number, never in terms of the block count.
        const candidateIds = (store.liveSession(created.id).harness.threads() as { id: string }[]).map((thread) => thread.id);

        expect(candidateIds.length).toBeGreaterThanOrEqual(2);

        const clones = watchClones(store, created.id);

        // ---- (1) one clone per conversation, for a bar with MORE segments than conversations ----
        clones.reset();
        const first = await call(api, 'GET', route);

        expect(first.status).toBe(200);

        const firstCounts = clones.read();
        const firstTotal = clones.total();
        const segments = barOf(first.json);

        // The bar really is a flood relative to the roster: pre-fix, each of these segments walked
        // the candidate roster and cloned every conversation it visited.
        expect(segments.length).toBeGreaterThan(candidateIds.length);

        // The contract: no conversation is read twice, and the total is the number of distinct
        // conversations the join touched (bounded by the roster, plus the slack of a conversation
        // the roster no longer lists, which the join must still be allowed to probe once).
        expect(Object.values(firstCounts).every((calls) => calls === 1)).toBe(true);
        expect(firstTotal).toBeLessThanOrEqual(candidateIds.length + 1);

        // ---- (3) the fast path still states the tri-state verdicts ----
        // The tool segment and both answer runs name one entry each, so they answer `true`
        // (nothing was switched); the `system` and `user` segments join N entries / no call id and
        // stay ABSENT. Pinned as the exact served bar, so a bound bought by dropping a verdict
        // cannot pass. The event indexes are computed, never guessed (./view.test.ts idiom).
        const events = store.liveSession(created.id).turns.find((candidate) => candidate.id === turnId)?.events ?? [];
        const toolIndex = events.findIndex((event) => (event as { type?: string }).type === 'tool_call');
        const reasoningIndexes = events.reduce<number[]>((indexes, event, index) => {
            if ((event as { type?: string }).type === 'reasoning') indexes.push(index);

            return indexes;
        }, []);
        const textIndexes = events.reduce<number[]>((indexes, event, index) => {
            if ((event as { type?: string }).type === 'text') indexes.push(index);

            return indexes;
        }, []);

        expect(segments).toEqual([
            { id: '0-system-instructions', kind: 'system', included: 'unaddressable' },
            { id: '0-user-prompt', kind: 'user', included: 'unaddressable' },
            // Each pair is in RECORDED-ORDER: the thinking delta opens its window before the text
            // delta of the same attempt does, so the reasoning block precedes the answer block it
            // streams beside (./turn-projector.ts mints both from the event that opens them).
            { id: `0-reasoning-${reasoningIndexes[0]}`, kind: 'reasoning', included: true },
            { id: `0-assistant-${textIndexes[0]}`, kind: 'assistant', included: true },
            { id: `0-tool-${toolIndex}`, kind: 'tool', included: true },
            { id: `0-reasoning-${reasoningIndexes[1]}`, kind: 'reasoning', included: true },
            { id: `0-assistant-${textIndexes[1]}`, kind: 'assistant', included: true }
        ]);

        // ---- (2) PER REQUEST, not forever ----
        // The memo dies with the request, so the next read pays the same reads again. That is the
        // price of a live verdict, and it is the guard against a cross-request cache creeping
        // back in: a cached transcript would answer this second read with ZERO clones.
        clones.reset();
        const second = await call(api, 'GET', route);

        expect(clones.read()).toEqual(firstCounts);
        expect(clones.total()).toBe(firstTotal);
        expect(clones.total()).toBeGreaterThan(0);

        // And the same request-shape twice serves the same bar — the bound changed nothing.
        expect(second.json).toEqual(first.json);

        clones.release();
    });

    it('reads a transcript only for the roster rows the page answers with', async () => {
        const store = storeOf([floodPreset()]);
        const api = apiOf(store);
        const created = await store.create('flooder');

        await runTurn(store, created.id, 'do the work');

        // TWO more conversations, through the create route whose 201 read-back T21 also made a
        // single-row lookup (`threadRowOfId`). The roster page lists HOST threads only
        // (../types `HarnessThreadRecord.origin`), so without these the page-window assertion
        // below would be vacuous: one row is trivially "one clone".
        for (const agentName of ['helper-a', 'helper-b']) {
            const made = await call(api, 'POST', `/v1/harness/sessions/${created.id}/threads`, undefined, { agent: agentName });

            expect(made.status).toBe(201);
        }

        const route = `/v1/harness/sessions/${created.id}/threads`;
        const all = await call(api, 'GET', route, 'limit=50');

        expect(all.status).toBe(200);

        const rows = (all.json.items as Record<string, unknown>[]) ?? [];

        expect(rows.length).toBeGreaterThanOrEqual(2);

        const clones = watchClones(store, created.id);

        // One page row = one transcript read. Pre-fix this read cloned EVERY conversation's
        // transcript, including the rows the window dropped (./api.ts `threadRowsOf`, 3.7 ms of
        // copying on the real session for a page that consumes `message_count`, `chars` and
        // `has_transcript` only).
        clones.reset();
        const page = await call(api, 'GET', route, 'limit=1');

        expect(page.status).toBe(200);

        const pageItems = (page.json.items as Record<string, unknown>[]) ?? [];

        expect(pageItems.length).toBe(1);
        expect(clones.total()).toBe(1);
        expect(clones.read()).toEqual({ [String(pageItems[0].id)]: 1 });

        // Laziness must not move a figure: the paged row IS the same row of the unbounded page,
        // and the page envelope is the generated one (no extra field, no missing one).
        expect(pageItems[0]).toEqual(rows[0]);
        expect(Object.keys(page.json).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.json.limit).toBe(1);

        // The filter runs on the records too, so an agent filter costs ONE clone as well, and it
        // still answers the same row the whole-roster filter answered (./api.ts `getSessionThreads`).
        const agentName = String(rows[0].agent);
        const fullFiltered = await call(api, 'GET', route, `agent=${agentName}&limit=50`);

        clones.reset();
        const pagedFiltered = await call(api, 'GET', route, `agent=${agentName}&limit=1`);

        expect((pagedFiltered.json.items as Record<string, unknown>[])[0]).toEqual(
            (fullFiltered.json.items as Record<string, unknown>[])[0]
        );
        expect(clones.total()).toBe(1);

        clones.release();
    });
});
