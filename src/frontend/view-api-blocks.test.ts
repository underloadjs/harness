// The lazy block-detail read on the CANONICAL mount (T11 → T23), and the boundary the
// facade owns between the wire record and the render model.
//
// One rule drives this file: WHEN a browser is allowed to ask for a segment's text.
// `GET /v1/harness/sessions/{session_id}/turns/{turn_id}/blocks/{block_id}` (generated in
// ../shared/harness-api.ts:97) is reached only from a context-segment click. A rows page
// and a display tree both carry the segment's DESCRIPTOR (identity, label, chars, state,
// event span) and never its bytes, so the assertions that matter are:
//
//   - the exact canonical address and the envelope field the answer is read from
//     (`{ block }`, ../shared/harness-api.ts:1593 `TurnBlockDetailResponse`);
//   - the ONE rename the facade owns: the wire's `label` is the render model's `name`,
//     and `inPrompt` is not published any more, so it is filled as the projector does
//     (./view-api.ts:591 `readBlockDetail` -> ./display-project.ts);
//   - a 404 stays a failure: the caller renders the refusal, so the transport must not
//     swallow it into a fake empty block.
//
// The legacy `/api/views/:id/turns/:tid/blocks/:bid` mirror is gone, and with it the
// `getBlockDetail` export — the facade now answers the PROJECTED detail, not the record.
//
// T5 adds the WRITE on the same route, and the same rule applies to it: `PATCH` with ONE field
// (`included`), answered by the state the server persisted. The whole-document transcript PUT is
// not part of this surface — a dialog holds a segment, not a conversation — and the strict stub
// below is what proves no second request happens.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-api-blocks.test.ts

import type { TurnBlockDetail } from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBlockDetail, writeBlockInclusion } from './view-api';

const T = 1_700_000_000_000;

type Call = { method: string; url: string; body: string; keepalive: boolean };

const calls: Call[] = [];

// A stub that THROWS for a route it does not declare, so a client that invents a second
// request (an eager bar fetch, a polling detail read) fails here instead of passing silently.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const url = String(input);

            calls.push({ method, url, body: String(init?.body ?? ''), keepalive: init?.keepalive === true });

            const key = `${method} ${url}`;
            const value = routes[key] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: statuses[key] ?? statuses[url] ?? 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

// A tool segment as the identified read publishes it: the recorded argument value and
// result text, verbatim, which nothing on the rows or tree path carries.
const block: TurnBlockDetail = {
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't 1',
    sectionId: 't1:0',
    label: 'read',
    chars: 54,
    state: 'done',
    eventFrom: 7,
    eventTo: 9,
    sessionId: 's 1',
    args: '{"path":"notes.md","max":20}',
    result: 'the whole recorded file body'
};

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('readBlockDetail', () => {
    it('addresses ONE segment by its exact canonical route and unwraps the block envelope', async () => {
        serve({ 'GET /v1/harness/sessions/s%201/turns/t%201/blocks/0-tool-7': { block } });

        // The facade's answer is the wire record with `name` derived from `label` and the
        // unpublished `inPrompt` filled, exactly as ./view-api.ts:600 states it.
        expect(await readBlockDetail('s 1', 't 1', '0-tool-7')).toEqual({
            ...block,
            name: 'read',
            inPrompt: true
        });
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/turns/t%201/blocks/0-tool-7', body: '', keepalive: false }
        ]);
    });

    it('falls back to the kind when the segment carries no label', async () => {
        const unlabelled = { ...block, id: '0-system-instructions', kind: 'system', label: '', entries: ['Answer directly.'] };
        serve({ 'GET /v1/harness/sessions/s1/turns/t1/blocks/0-system-instructions': { block: unlabelled } });

        const detail = await readBlockDetail('s1', 't1', '0-system-instructions');

        // `label ?? kind` is nullish, not falsy: an empty label is a published value, so
        // the render name is the empty string and only an ABSENT label falls back.
        expect(detail.name).toBe('');
        expect(detail.entries).toEqual(['Answer directly.']);
        expect(calls.map((call) => call.url)).toEqual(['/v1/harness/sessions/s1/turns/t1/blocks/0-system-instructions']);
    });

    it('encodes an id that needs it, because ids are user-visible data', async () => {
        serve({ 'GET /v1/harness/sessions/s1/turns/t%201/blocks/0-tool%207': { block: { ...block, id: '0-tool 7' } } });

        expect((await readBlockDetail('s1', 't 1', '0-tool 7')).id).toBe('0-tool 7');
        expect(calls.map((call) => call.url)).toEqual(['/v1/harness/sessions/s1/turns/t%201/blocks/0-tool%207']);
    });

    it('keeps an absent payload field absent instead of reading the error envelope', async () => {
        // 404 for a block the bar never minted (or one dropped with a failed attempt) is the
        // SERVER's honest answer; the caller renders the failure, so the transport must not
        // swallow it into a fake empty block.
        serve(
            { 'GET /v1/harness/sessions/s1/turns/t1/blocks/nope': { error: { message: 'Unknown block "nope".' } } },
            { 'GET /v1/harness/sessions/s1/turns/t1/blocks/nope': 404 }
        );

        await expect(readBlockDetail('s1', 't1', 'nope')).rejects.toThrow('Unknown block "nope".');
        expect(calls).toHaveLength(1);
    });

    it('asks once per click and never for the whole bar', async () => {
        serve({
            'GET /v1/harness/sessions/s1/turns/t1/blocks/0-tool-7': { block },
            'GET /v1/harness/sessions/s1/turns/t1/blocks/0-tool-9': { block: { ...block, id: '0-tool-9' } }
        });

        await readBlockDetail('s1', 't1', '0-tool-7');
        await readBlockDetail('s1', 't1', '0-tool-9');

        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/turns/t1/blocks/0-tool-7',
            '/v1/harness/sessions/s1/turns/t1/blocks/0-tool-9'
        ]);
    });
});

// ---------------------------------------------------------------------------
// T5/R6: the inclusion switch — ONE PATCH, ONE field, the segment's own route
// ---------------------------------------------------------------------------

describe('writeBlockInclusion', () => {
    it('switches one segment with a single PATCH on its own route, and answers the state it persisted', async () => {
        // The receipt is the server's PERSISTED verdict — including the unit cascade — and the
        // dialog paints from it rather than from the click (./ui/context-detail.ts
        // `toggleInclusion`). The ids are encoded exactly as the read above encodes them, and the
        // body carries one field: this is a fact write. `serve` throws for any route it does not
        // declare, so the second request a whole-document transcript write would need
        // (`PUT /sessions/{id}/threads/{thread}/transcript/document`) fails this test rather than
        // passing quietly — which is the whole reason the segment got its own verb.
        const receipt = {
            session_id: 's 1',
            turn_id: 't 1',
            block_id: '0-tool-7',
            included: false,
            thread_id: 'thread-1',
            revision: 3,
            links: {
                block: '/v1/harness/sessions/s 1/turns/t 1/blocks/0-tool-7',
                transcript: '/v1/harness/sessions/s 1/threads/thread-1/transcript'
            }
        };

        serve({ 'PATCH /v1/harness/sessions/s%201/turns/t%201/blocks/0-tool-7': receipt });

        expect(await writeBlockInclusion('s 1', 't 1', '0-tool-7', false)).toEqual(receipt);
        expect(calls).toEqual([
            {
                method: 'PATCH',
                url: '/v1/harness/sessions/s%201/turns/t%201/blocks/0-tool-7',
                body: JSON.stringify({ included: false }),
                keepalive: false
            }
        ]);
    });

    it('hands back the server\u2019s refusal untouched, because the dialog states the reason', async () => {
        // A 409 here has two honest causes the reader can act on differently — the segment has no
        // transcript entry to switch, or the run owns the transcript right now — and the transport
        // must not flatten either into a generic failure or swallow it into a fake receipt.
        serve(
            {
                'PATCH /v1/harness/sessions/s1/turns/t1/blocks/0-system-instructions': {
                    error: {
                        message: `Context segment "0-system-instructions" has no transcript entry to switch: the call it recorded is not in this conversation's transcript.`
                    }
                }
            },
            { 'PATCH /v1/harness/sessions/s1/turns/t1/blocks/0-system-instructions': 409 }
        );

        await expect(writeBlockInclusion('s1', 't1', '0-system-instructions', false)).rejects.toThrow(
            'Context segment "0-system-instructions" has no transcript entry to switch'
        );
        expect(calls).toHaveLength(1);
    });
});
