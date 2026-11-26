// agentManage / agentResult (R3) — session-wide agent result inspection.
//
// Contract pinned here:
//   - both are ALWAYS-registered core tools, declared to EVERY agent in the session at
//     every rank, and their wire names are reserved;
//   - agentManage lists EVERY configured agent (even one that never ran) with
//     only truncated previews of recent invocations;
//   - agentResult reads one completed answer by agent (latest finished when no
//     invocationId is given) and pages long text explicitly, so the harness's
//     64 KiB result cap never silently truncates a full result;
//   - delegated and fork results are available without reading the owner's
//     transcript;
//   - `archiveInvocation` — the door a LANE result comes through — carries the forensic
//     pair of a stopped run (`partialContent` / `cancelledAtMessage`), refuses a malformed
//     value before it mints an order or writes a row, drops the pair on a completed
//     status, and returns what it stored, which is the record the lane seam digests
//     (review finding #5, issues 0020 + 0033);
//   - a non-completed row additionally carries `stopReason` (issue 0036 R3): the CAUSE of
//     the halt (`api-error`, `caller-released`) beside `status`, never replacing it and
//     never a progress measure;
//   - no system prompt, transcript message, tool argument, or tool body is ever
//     exposed: only the completed assistant answer value is recorded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agent, harness, tool } from './index';
import type {
    Agent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// W19 (2026-11-17): every row `snapshot()` writes now carries the LEDGER GENERATION that minted its
// invocation id, so the exact-value pins below name the constant instead of a literal (it is random
// per process). Same import path the epoch pins in `src/harness.threads.test.ts:33` use.
import { HARNESS_PROCESS_EPOCH } from './core/agent-limits';

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

// Route a stream by the REQUEST content instead of a global call counter: a
// fork consumes the same transport as its source, so transcript-based routing is
// the only deterministic way to tell "this is the branch's own user task" from
// "this is the root's next turn".
const routed = (route: (request: HarnessStreamRequest) => HarnessStreamEvent[]): HarnessStream =>
    async function* stream(request) {
        for (const frame of route(request)) {
            yield frame;
        }
    };

const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index--) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

const hasForkResult = (request: HarnessStreamRequest): boolean =>
    request.messages.some(
        (message) =>
            message.role === 'tool' &&
            message.name === 'threadFork' &&
            message.content.includes('fork result')
    );

// R9-R11: only the discovery bootstrap and the session plan are declared. The
// inspection pair (agentManage/agentResult) is registered and searchable, which
// is why it still reaches both agents — through toolRequest, not a declaration.
const CORE_DECLARATIONS = [
    'toolRequest',
    'tasks'
];

describe('agentManage / agentResult registration', () => {
    it('declares both core tools to every agent, at every rank', async () => {
        const seenLead: HarnessStreamRequest[] = [];
        const seenHelper: HarnessStreamRequest[] = [];

        const helper = brain(scripted([answer('helper result')], seenHelper));
        const lead = brain(
            scripted(
                [
                    callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
                    answer('lead result')
                ],
                seenLead
            )
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        expect(writer.tools.agentManage.visibility).toBe('searchable');
        expect(writer.tools.agentResult.visibility).toBe('searchable');
        // RANK TAGS (2026-11-18): the retired `subagent` tag is replaced by `rank`, the
        // delegate entry's existing rank vocabulary. These are EQUALITY pins, so the whole
        // array is the expectation — and because both tools are `searchable`, these tags are
        // also the `availableTags` vocabulary a no-match `toolRequest` reports (pinned in
        // src/harness.already-available.test.ts and src/harness.discovery.test.ts).
        expect(writer.tools.agentManage.tags).toEqual([
            'agents',
            'results',
            'preview',
            'rank',
            'team',
            'inspect'
        ]);
        expect(writer.tools.agentResult.tags).toEqual([
            'agents',
            'result',
            'answer',
            'output',
            'rank',
            'inspect'
        ]);

        expect(declaredNames(seenLead[0])).toEqual([
            ...CORE_DECLARATIONS,
            'delegate',
        ]);
        expect(declaredNames(seenHelper[0])).toEqual(CORE_DECLARATIONS);
    });

    it('lets other tool sources replace agentManage and agentResult (no reserved names)', async () => {
        for (const name of ['agentManage', 'agentResult']) {
            const clash = tool({ description: 'Mine.', tags: ['mine'], execute: () => 'ok' });

            const writer = harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                tools: { [name]: clash },
                presets: false
            });

            expect(writer.tools[name]).not.toBe(clash);
            expect(writer.tools[name].description).toBe('Mine.');
            await expect(writer.executeTool(name, {})).resolves.toBe('ok');
        }
    });

    it('publishes the exact empty-argument listing schema and the paged result schema', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) }, presets: false });

        expect(writer.tools.agentManage.parameters).toEqual({
            type: 'object',
            properties: {},
            additionalProperties: false
        });

        expect(writer.tools.agentResult.parameters).toEqual({
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    minLength: 1,
                    description: 'Configured agent name whose result to read.'
                },
                invocationId: {
                    type: 'string',
                    minLength: 1,
                    description:
                        "Invocation id from agentManage. Omit to read that agent's latest completed result."
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    // B1 (2026-11-26): the row now carries the clamp contract, so a caller learns
                    // from the schema that an offset past the end answers with the END of the
                    // result plus `offsetClamped`/`note`. Pinned whole, in this object's own
                    // exact-equality style; the raw-source copies (entry literal, generated
                    // manifest, Rust row) are pinned in core/metadata.ownership.test.ts.
                    description:
                        '0-based character offset into the result. Defaults to 0; use nextOffset from the previous page. An offset past the end is clamped to it and reported as "offsetClamped" with a "note" naming where the page really starts, so overshooting reads as the end of the result rather than as an empty answer; an offset exactly at "contentLength" is the empty tail it looks like and carries no flag.'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 8000,
                    description: 'Page size in characters, 1-8000. Defaults to 4000.'
                }
            },
            required: ['agent'],
            additionalProperties: false
        });
    });
});

describe('agentManage', () => {
    it('lists every configured agent with previews and no private transcript data', async () => {
        const helper = brain(scripted([answer('helper result')]), {
            instruction: 'HELPER-SYSTEM-SECRET'
        });
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
                answer('lead result')
            ]),
            { instruction: 'LEAD-SYSTEM-SECRET' }
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        const listed = await writer.executeTool('agentManage', {});

        expect(listed).toEqual({
            agents: [
                {
                    name: 'lead',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 11,
                            preview: 'lead result',
                            truncated: false
                        }
                    ]
                },
                {
                    name: 'helper',
                    rank: 'B',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '2',
                            kind: 'delegation',
                            status: 'completed',
                            contentLength: 13,
                            preview: 'helper result',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 2,
            activeResults: 0,
            // F1-1 (2026-11-25): `hiddenResults` is the GLOBAL count of retained rows no
            // per-agent list shows; both rows here are listed, and neither agent overflowed the
            // 5-row cap, so both flags are 0/false.
            hiddenResults: 0,
            truncated: false
        });

        const serialized = JSON.stringify(listed);
        expect(serialized).not.toContain('LEAD-SYSTEM-SECRET');
        expect(serialized).not.toContain('HELPER-SYSTEM-SECRET');
        expect(serialized).not.toContain('{"agent":"helper"');
    });

    it('truncates a long preview while agentResult still returns the exact full answer', async () => {
        const long = 'A'.repeat(250);

        const writer = harness({
            agents: { writer: brain(scripted([answer(long)]), { instruction: 'PROMPT-SECRET' }) },
            presets: false
        });
        await writer('go');

        const listed = await writer.executeTool('agentManage', {});

        expect(listed).toEqual({
            agents: [
                {
                    name: 'writer',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 250,
                            preview: `${'A'.repeat(200)}…`,
                            truncated: true
                        }
                    ]
                }
            ],
            totalResults: 1,
            activeResults: 0,
            hiddenResults: 0,
            truncated: false
        });

        expect(JSON.stringify(listed)).not.toContain(long);
        expect(JSON.stringify(listed)).not.toContain('PROMPT-SECRET');

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: long,
            contentLength: 250,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    // F1-1 (2026-11-25) — the two listing counters are SEPARATE facts, and this is the pair of
    // cases that keeps them apart. `truncated` is per-agent (some agent has more retained rows
    // than the 5 its own entry lists, `AGENT_MANAGE_LIST_PER_AGENT`); `hiddenResults` is the
    // global count of retained rows that appear in no per-agent list, from either cause (cap
    // overflow, or rows retired with a released conversation). The old implementation computed
    // the first from the second (`records.length > listed`, src/engine/harness.ts), so the
    // release case below used to answer `truncated: true` beside `invocationCount: 2` — a flag
    // naming an overflow that had not happened, with no cursor to act on it.
    it('flags per-agent overflow as `truncated`, and the rows past the cap as `hiddenResults`', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('sixth')])) },
            presets: false
        });

        for (let index = 0; index < 6; index += 1) {
            await writer('go');
        }

        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                {
                    name: 'writer',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    // `invocationCount` is the RETAINED count; `results` is capped at 5.
                    invocationCount: 6,
                    results: [
                        {
                            invocationId: '6',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 5,
                            preview: 'sixth',
                            truncated: false
                        },
                        {
                            invocationId: '5',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 5,
                            preview: 'sixth',
                            truncated: false
                        },
                        {
                            invocationId: '4',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 5,
                            preview: 'sixth',
                            truncated: false
                        },
                        {
                            invocationId: '3',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 5,
                            preview: 'sixth',
                            truncated: false
                        },
                        {
                            invocationId: '2',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 5,
                            preview: 'sixth',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 6,
            activeResults: 0,
            // The one row the cap hid is the whole of `hiddenResults` here, and `truncated` is
            // true because THAT agent overflowed its own list.
            hiddenResults: 1,
            truncated: true
        });

        // The oldest row is still readable by id — a flag is not a deletion.
        await expect(writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })).resolves.toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'sixth',
            contentLength: 5,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('answers `truncated: false` with `hiddenResults` above 0 when every agent is inside its cap', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('listed')])) },
            presets: false
        });

        await writer('go');
        await writer('go');

        // A host thread's run is a row of the SAME agent, owned by that conversation.
        const thread = writer.createThread('writer');
        await writer.sendThreadInput(thread.id, 'doomed');

        // Before the release every retained row is listed: `hiddenResults` is 0, and `truncated`
        // is false because 3 is inside the 5-row cap.
        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                {
                    name: 'writer',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    invocationCount: 3,
                    results: [
                        {
                            invocationId: '3',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 6,
                            preview: 'listed',
                            truncated: false
                        },
                        {
                            invocationId: '2',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 6,
                            preview: 'listed',
                            truncated: false
                        },
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 6,
                            preview: 'listed',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 3,
            activeResults: 0,
            hiddenResults: 0,
            truncated: false
        });

        writer.deleteThread(thread.id);

        // THE DISCRIMINATING CASE. The released conversation's row leaves the per-agent list
        // (`recordsForAgent` retires a row whose conversation is marked inactive) but stays in the
        // retention ring, so the global row count and the listed count now differ — the exact
        // condition the old `records.length > listed` reported as `truncated: true`. Nothing
        // overflowed: the agent has 2 retained rows and shows both.
        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                {
                    name: 'writer',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    invocationCount: 2,
                    results: [
                        {
                            invocationId: '2',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 6,
                            preview: 'listed',
                            truncated: false
                        },
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 6,
                            preview: 'listed',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 3,
            activeResults: 0,
            hiddenResults: 1,
            truncated: false
        });

        // And the hidden row is still answerable by id, which is what makes `hiddenResults` a
        // count of reachable rows rather than a loss.
        await expect(writer.executeTool('agentResult', { agent: 'writer', invocationId: '3' })).resolves.toMatchObject({
            invocationId: '3',
            status: 'completed',
            content: 'listed'
        });
    });

    it('only exposes the completed answer, never a tool body', async () => {
        const secretTool = tool({
            description: 'Return a secret.',
            tags: ['test'],
            visibility: 'core',
            execute: () => 'TOOL-BODY-SECRET'
        });

        const writer = harness({
            agents: {
                writer: brain(
                    scripted([callTool('c1', 'secretTool', '{}'), answer('safe answer')]),
                    { instruction: 'PROMPT-SECRET' }
                )
            },
            tools: { secretTool },
            presets: false
        });
        await writer('go');

        const listed = JSON.stringify(await writer.executeTool('agentManage', {}));
        const result = JSON.stringify(await writer.executeTool('agentResult', { agent: 'writer' }));

        expect(listed).not.toContain('TOOL-BODY-SECRET');
        expect(result).not.toContain('TOOL-BODY-SECRET');
        expect(listed).not.toContain('PROMPT-SECRET');
        expect(result).not.toContain('PROMPT-SECRET');
        expect(result).toContain('safe answer');

        // issue 0032 (2026-11-26, AC3) — the same scan over the STOPPED shape, because the tally is
        // the first forensic field that names tools at all. This fixture's run completes, so it
        // carries no tally; the stopped twin is the cancelled run in `carries a cancelled run partial
        // and its message position through snapshot -> restore` above, whose tool answers `released`
        // and whose door, row and reloaded row are pinned WHOLE — an added body or argument string
        // would fail those exact `toEqual`s, not merely this scan. What this line owns is the field
        // ON THE COMPLETED SHAPE: nothing about `toolActivity` crept into the listing or the page,
        // which is the AC5 half of the same promise (the completed shape did not move).
        expect(listed).not.toContain('toolActivity');
        expect(result).not.toContain('toolActivity');
    });
});

describe('agentResult', () => {
    it('pages a long result explicitly instead of letting the 64 KiB cap truncate it', async () => {
        const long = 'A'.repeat(9000);

        const writer = harness({
            agents: { writer: brain(scripted([answer(long)])) },
            presets: false
        });
        await writer('go');

        const first = await writer.executeTool('agentResult', { agent: 'writer' });

        expect(first).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(4000),
            contentLength: 9000,
            offset: 0,
            limit: 4000,
            hasMore: true,
            nextOffset: 4000
        });

        const second = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 4000
        });

        expect(second).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(4000),
            contentLength: 9000,
            offset: 4000,
            limit: 4000,
            hasMore: true,
            nextOffset: 8000
        });

        const third = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 8000
        });

        expect(third).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(1000),
            contentLength: 9000,
            offset: 8000,
            limit: 4000,
            hasMore: false
        });

        expect(
            [first, second, third]
                .map((page) => (page as { content: string }).content)
                .join('')
        ).toBe(long);

        // A caller may narrow the page; nextOffset remains exact.
        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                offset: 7,
                limit: 3
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'AAA',
            contentLength: 9000,
            offset: 7,
            limit: 3,
            hasMore: true,
            nextOffset: 10
        });

        // The advertised maximum is enforced by the shared argument gate.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', limit: 8001 })
        ).rejects.toThrow('$.limit must be <= 8000.');
    });

    // B1 (2026-11-26, work order
    // docs/tasks/2026-11-26-delegate-defects-verified-fix-list.md) — an out-of-range `offset` used to
    // be clamped SILENTLY here while `fetch` reported the identical clamp as `offsetClamped` + `note`
    // (./tools/webfetch/index.ts:689-690 for the flag, :871-876 for the pair). A caller that overshoots
    // by computing `contentLength - n` must be able to tell "you already have the end" from "the tail
    // is genuinely empty" without arithmetic. Fixtures stay small so the note is pinned as an exact
    // string, numbers included.
    it('reports an offset past the end as a clamp, and an in-range offset as nothing at all', async () => {
        const content = 'x'.repeat(300);

        const writer = harness({
            agents: { writer: brain(scripted([answer(content)])) },
            presets: false
        });
        await writer('go');

        // AC1 — overshoot: the clamped page exactly as before, PLUS the flag and a note naming the
        // offset the page really starts at. The wording mirrors webfetch's note noun-for-noun.
        expect(await writer.executeTool('agentResult', { agent: 'writer', offset: 900 })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '',
            contentLength: 300,
            offset: 300,
            limit: 4000,
            hasMore: false,
            offsetClamped: true,
            note: 'Requested offset 900 is past the end of this 300-character result; showing what remains from 300. The result is fully read once "content" is empty.'
        });

        // AC2, and the ONE deliberate deviation from the work order's test item (b) ("offset exactly at
        // contentLength -> same"): `offset === contentLength` is NOT an overshoot, so the key is
        // ABSENT. Reasons, in the order the sources give them: webfetch's own rule is
        // `startOffset !== invocation.offset` (./tools/webfetch/index.ts:690), and the work order's own
        // Fix sentence says "when the requested offset EXCEEDS contentLength". An empty tail at the end
        // of the window is a fact about the answer, not about the request. The exact `toEqual` below is
        // the pin — one extra key and this assertion fails.
        expect(await writer.executeTool('agentResult', { agent: 'writer', offset: 300 })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '',
            contentLength: 300,
            offset: 300,
            limit: 4000,
            hasMore: false
        });

        // AC2 — an in-range offset carries nothing either, so the flag never lies, and the paging
        // keys stay byte-identical to the suite above.
        expect(
            await writer.executeTool('agentResult', { agent: 'writer', offset: 100, limit: 50 })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'x'.repeat(50),
            contentLength: 300,
            offset: 100,
            limit: 50,
            hasMore: true,
            nextOffset: 150
        });
    });

    // B1 (2026-11-26) — the failed/cancelled branch pages `partialContent` with the SAME arithmetic,
    // so it reports the clamp the same way. The row comes from `archiveInvocation` (the seam a lane
    // commits through) rather than from a live cancellation, so the fixture is one call and the
    // expected envelope is fully knowable: `stopReason` and `durationMs` are absent because the
    // archive was given neither.
    it('reports the same clamp when paging a stopped child partialContent', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        // 14 characters of partial, and the forensic pair that makes this branch worth paging at all.
        writer.archiveInvocation({
            invocationId: '513',
            sequence: 3,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'Delegation exceeded its bound.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });

        // AC3 — identical reporting on this branch: flag, note naming the clamp target, and the
        // clamped page itself.
        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                invocationId: '513',
                offset: 40
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '513',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            contentLength: 14,
            offset: 14,
            limit: 4000,
            hasMore: false,
            offsetClamped: true,
            note: 'Requested offset 40 is past the end of this 14-character result; showing what remains from 14. The result is fully read once "content" is empty.',
            error: 'Delegation exceeded its bound.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });

        // The in-range read of the same row keeps its pre-B1 key set exactly — the flag is additive,
        // and every existing exact-key pin in this file depends on that.
        expect(
            await writer.executeTool('agentResult', { agent: 'writer', invocationId: '513' })
        ).toEqual({
            agent: 'writer',
            invocationId: '513',
            kind: 'delegation',
            status: 'cancelled',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'Delegation exceeded its bound.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });
    });

    it('reads a submitted invocation by id and reports an unknown id as an error', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');

        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                invocationId: '1'
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'one',
            contentLength: 3,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // B2 (2026-11-26) — the wording changed because the old one conflated two opposite failures.
        // This id exists nowhere in the ledger, so the refusal says so and the remedy is "give up".
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: 'missing' })
        ).rejects.toThrow(
            'No result "missing" is available for agent "writer": no such invocation in this harness.'
        );

        await expect(writer.executeTool('agentResult', { agent: 'ghost' })).rejects.toThrow(
            'Agent "ghost" is not registered. Configured agents: writer.'
        );
    });

    // B2 (2026-11-26, work order
    // docs/tasks/2026-11-26-delegate-defects-verified-fix-list.md) — `agentResult` used to answer ONE
    // sentence, `No result "<id>" is available for agent "<agent>".`, for both "this id is real but is
    // somebody else's" (remedy: ask that agent) and "this id never happened" (remedy: stop). The 0034
    // repro cost a blind probe per candidate agent, because `agentManage` caps each agent's list at 5
    // rows with no cursor. Fixtures use `archiveInvocation` — the seam a lane commits through — so rows
    // of several agents and several ledger generations exist without running several models.
    it('names the owning agent when an invocation id belongs to another agent', async () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('unused')])),
                helper: brain(scripted([answer('unused')])),
                lead: brain(scripted([answer('unused')]))
            },
            presets: false
        });

        writer.archiveInvocation({
            invocationId: '513',
            sequence: 5,
            agent: 'helper',
            rank: 'B',
            kind: 'delegation',
            status: 'completed',
            content: 'helper answer'
        });

        // THE WRONG-AGENT REFUSAL: the owner is named, so no enumeration is needed to find it.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '513' })
        ).rejects.toThrow(
            'No result "513" is available for agent "writer"; it belongs to agent "helper".'
        );

        // THE SUCCESS PATH IS UNCHANGED for the agent that really owns the id: same envelope, same keys,
        // no `offsetClamped` (the flag is B1's, and an absent `offset` is 0, never an overshoot).
        await expect(
            writer.executeTool('agentResult', { agent: 'helper', invocationId: '513' })
        ).resolves.toEqual({
            agent: 'helper',
            invocationId: '513',
            kind: 'delegation',
            status: 'completed',
            content: 'helper answer',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // AC4 — the UNREGISTERED-AGENT refusal is a different failure, raised before any ledger lookup,
        // and its sentence is preserved verbatim (the roster list is `Object.keys(agents)` order, the
        // config order; same rule pinned at ./harness.delegation.test.ts:837).
        await expect(
            writer.executeTool('agentResult', { agent: 'ghost', invocationId: '513' })
        ).rejects.toThrow(
            'Agent "ghost" is not registered. Configured agents: writer, helper, lead.'
        );
    });

    it('names every owner when a recycled id has rows under two agents, and both still answer', async () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('unused')])),
                helper: brain(scripted([answer('unused')])),
                lead: brain(scripted([answer('unused')]))
            },
            presets: false
        });

        // THE RECYCLED ID: ONE bare id, TWO rows, TWO agents, TWO ledger generations (the shape pinned
        // in ./harness.invocation-run-key.test.ts:101-141). The epoch-preferred resolver answers with
        // exactly ONE of them — this process's — which is why the refusal scans the bounded ledger for
        // every distinct owner instead of trusting that one answer.
        writer.archiveInvocation({
            invocationId: '520',
            sequence: 6,
            agent: 'helper',
            rank: 'B',
            kind: 'delegation',
            status: 'completed',
            content: 'old generation',
            epoch: 'epoch-pre-restart'
        });
        writer.archiveInvocation({
            invocationId: '520',
            sequence: 7,
            agent: 'lead',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'this generation'
        });

        // Both owners, sorted (deterministic, not ledger-insertion order), the asking agent excluded.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '520' })
        ).rejects.toThrow(
            'No result "520" is available for agent "writer"; it belongs to agents "helper", "lead".'
        );

        // SUCCESS PATH: each owning agent still reaches ITS OWN generation of that id — `helper` only via
        // the agent-scoped fallback (`invocationRecordOfInvocationIdForAgent`), which B2 must not weaken.
        await expect(
            writer.executeTool('agentResult', { agent: 'helper', invocationId: '520' })
        ).resolves.toMatchObject({
            invocationId: '520',
            kind: 'delegation',
            content: 'old generation'
        });

        await expect(
            writer.executeTool('agentResult', { agent: 'lead', invocationId: '520' })
        ).resolves.toMatchObject({
            invocationId: '520',
            kind: 'root',
            content: 'this generation'
        });

        // THE OTHER REFUSAL: an id the ledger has never heard of, in a harness that does hold rows.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: 'nope' })
        ).rejects.toThrow(
            'No result "nope" is available for agent "writer": no such invocation in this harness.'
        );
    });

    it('still reads an id retired with its conversation, and names its owner rather than calling it unknown', async () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('listed')])),
                quiet: brain(scripted([answer('unused')]))
            },
            presets: false
        });

        await writer('go');
        await writer('go');

        // A host thread's run is a row of the SAME agent, owned by that conversation (the same fixture
        // the `hiddenResults` pin above builds, :421-523).
        const thread = writer.createThread('writer');
        await writer.sendThreadInput(thread.id, 'doomed');

        // Released. The row leaves every AGENT-FACING LIST — `recordsForAgent` applies
        // `recordIsInactiveOwned` — but it stays in the retention ring and stays readable by id, which
        // is the documented ring behaviour (the pins at :407-418 and :517-523).
        writer.deleteThread(thread.id);

        // AC5 — asking its own agent still READS it. A refactor that moved the inactive filter onto the
        // id-addressed path would turn this into the unknown-id refusal.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '3' })
        ).resolves.toEqual({
            agent: 'writer',
            invocationId: '3',
            kind: 'root',
            status: 'completed',
            content: 'listed',
            contentLength: 6,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // And asking the WRONG agent names the owner: the owners scan may not apply the inactive filter
        // either, or a released row would read as "no such invocation in this harness".
        await expect(
            writer.executeTool('agentResult', { agent: 'quiet', invocationId: '3' })
        ).rejects.toThrow(
            'No result "3" is available for agent "quiet"; it belongs to agent "writer".'
        );
    });

    it('returns an empty state before any run and an empty completed answer exactly', async () => {
        const fresh = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        expect(await fresh.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        const blank = harness({
            agents: { writer: brain(scripted([answer('')])) },
            presets: false
        });
        await blank('go');

        expect(await blank.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('reports a failed invocation without inventing content', async () => {
        const writer = harness({
            agents: {
                // R1: one attempt (`retry: false`) — this pins the terminal failure
                // path, not the retry sequence.
                writer: brain(
                    scripted([[{ type: 'error', message: 'transport exploded' }]]),
                    { retry: false }
                )
            },
            presets: false
        });

        await expect(writer('go')).rejects.toThrow('transport exploded');

        // T28: a failed run reports its forensic state too. `cancelledAtMessage` is how
        // many messages the run had appended when it ended — issue 0036 R1 RETAINS those
        // messages, so the count and the conversation now agree instead of describing a
        // splice that no longer happened. `durationMs` is the measured span. Both are
        // present only when the run actually got that far, so this pins the shape of a run
        // that failed on its first request.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            // F-A Defect 1 (2026-11-15): this door now projects the record's `stopReason`,
            // the machine-readable cause. A transport error with `retry: false` is the
            // classifier's `api-error` branch — the same value the SNAPSHOT row of this run
            // already carried (see the `persists failed results` pin below). Added because
            // the row genuinely has it now; `status: 'failed'` alone cannot tell a first-
            // attempt provider failure from an exhausted retry policy.
            stopReason: 'api-error',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport exploded',
            cancelledAtMessage: 1,
            durationMs: expect.any(Number)
        });
    });

    it('retains results when only an agent transcript is reset (server new-turn path)', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');

        // sessions.ts starts a new block with Agent.reset(), NOT harness.reset();
        // the result archive is session state and must survive that.
        writer.agent.reset();

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            status: 'completed',
            content: 'one'
        });
    });

    it('clears every result on reset()', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            status: 'completed',
            content: 'one'
        });

        writer.reset();

        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                {
                    name: 'writer',
                    rank: 'A',
                    model: 'merge/ds4-flash',
                    invocationCount: 0,
                    results: []
                }
            ],
            totalResults: 0,
            activeResults: 0,
            hiddenResults: 0,
            truncated: false
        });
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });
});

describe('delegated and fork results', () => {
    it('makes a delegated result readable by agent and invocation id', async () => {
        const helper = brain(scripted([answer('helper result')]));
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
                answer('lead final')
            ])
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        expect(await writer.executeTool('agentResult', { agent: 'helper' })).toEqual({
            agent: 'helper',
            invocationId: '2',
            kind: 'delegation',
            status: 'completed',
            content: 'helper result',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('makes a threadFork branch result readable while the root answer stays latest', async () => {
        const lead = brain(
            routed((request) => {
                // The fork reads the parent snapshot plus its own task; the root
                // never sees that user message.
                if (latestUser(request) === 'investigate') return answer('fork result');

                // Root's turn after the branch result has been delivered.
                if (hasForkResult(request)) return answer('lead final');

                // Root's first turn: ask for one fork.
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return callTool('f1', 'threadFork', '{"input":"investigate"}');
                }

                // A tool-free pause while the branch is still running; the
                // completion drives the next root turn.
                return answer('waiting');
            })
        );

        const writer = harness({ agents: { lead }, presets: false });
        await writer('go');

        // The branch id is runtime-generated (module sequence), so read it from
        // the audit record instead of hardcoding it.
        const branchId = writer.branches()[0].branchId;

        expect(
            await writer.executeTool('agentResult', { agent: 'lead', invocationId: branchId })
        ).toEqual({
            agent: 'lead',
            invocationId: branchId,
            kind: 'fork',
            status: 'completed',
            content: 'fork result',
            contentLength: 11,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Without an id, the agent's latest FINISHED answer is the root's final
        // turn, not the fork that finished earlier.
        expect(await writer.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'lead final',
            contentLength: 10,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        const listed = await writer.executeTool('agentManage', {});
        const leadResults = (listed as { agents: Array<{ name: string; results: unknown[] }> }).agents.find(
            (entry) => entry.name === 'lead'
        )!.results;

        expect(leadResults).toEqual([
            {
                invocationId: branchId,
                kind: 'fork',
                status: 'completed',
                contentLength: 11,
                preview: 'fork result',
                truncated: false
            },
            {
                invocationId: '1',
                kind: 'root',
                status: 'completed',
                contentLength: 10,
                preview: 'lead final',
                truncated: false
            }
        ]);
    });
});

describe('result pagination and Unicode boundaries', () => {
    it('never splits a surrogate pair at either page edge', async () => {
        // Length 8 UTF-16 units: A A A [high low] B B B.
        const content = 'AAA😀BBB';

        const writer = harness({
            agents: { writer: brain(scripted([answer(content)])) },
            presets: false
        });
        await writer('go');

        const first = await writer.executeTool('agentResult', {
            agent: 'writer',
            limit: 4
        });

        // The limit would cut the emoji: return only the three A's and advance to
        // the pair boundary instead of emitting half a glyph.
        expect(first).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'AAA',
            contentLength: 8,
            offset: 0,
            limit: 4,
            hasMore: true,
            nextOffset: 3
        });

        const second = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 3,
            limit: 4
        });

        expect(second).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '😀BB',
            contentLength: 8,
            offset: 3,
            limit: 4,
            hasMore: true,
            nextOffset: 7
        });

        const third = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 7,
            limit: 4
        });

        expect(third).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'B',
            contentLength: 8,
            offset: 7,
            limit: 4,
            hasMore: false
        });

        expect(
            [first, second, third].map((page) => (page as { content: string }).content).join('')
        ).toBe(content);

        // An offset INSIDE the pair is moved back to include the whole glyph; the
        // returned offset is the actual one used.
        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                offset: 4,
                limit: 3
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '😀B',
            contentLength: 8,
            offset: 3,
            limit: 3,
            hasMore: true,
            nextOffset: 6
        });
    });

    // B1 (2026-11-26) — THE FLAG MUST NOT LIE. The lead-surrogate repair inside `resultPageOf`
    // (./harness.ts, `start--` in the pair-repair block) moves an offset that is perfectly IN RANGE back
    // by one unit when it lands on the low half of a pair. A clamp computed as
    // `page.offset !== requestedOffset` — the obvious implementation — would therefore report this
    // legal page as an overshoot. The flag is computed as strict overshoot against the STORED LENGTH
    // instead, so the exact `toEqual` below (no `offsetClamped`, no `note`) is the whole assertion, and
    // the second one shows a genuine overshoot on the same fixture does carry the pair.
    it('does not report a surrogate-boundary repair as an offset clamp', async () => {
        // Length 8 UTF-16 units: A A A [high low] B B B.
        const content = 'AAA😀BBB';

        const writer = harness({
            agents: { writer: brain(scripted([answer(content)])) },
            presets: false
        });
        await writer('go');

        // 4 is INSIDE the pair and 8 > 4, so this is in range on both counts: the start is repaired to
        // 3 and nothing is reported, even though the echoed `offset` differs from the requested one.
        expect(
            await writer.executeTool('agentResult', { agent: 'writer', offset: 4, limit: 3 })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '😀B',
            contentLength: 8,
            offset: 3,
            limit: 3,
            hasMore: true,
            nextOffset: 6
        });

        // AC1 on the same fixture: 9 units into an 8-unit answer IS an overshoot, so the pair appears
        // and the note names the clamp target (8), not the requested offset (9).
        expect(
            await writer.executeTool('agentResult', { agent: 'writer', offset: 9, limit: 3 })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '',
            contentLength: 8,
            offset: 8,
            limit: 3,
            hasMore: false,
            offsetClamped: true,
            note: 'Requested offset 9 is past the end of this 8-character result; showing what remains from 8. The result is fully read once "content" is empty.'
        });
    });
});

describe('snapshot durability (R3)', () => {
    it('round-trips root, delegated and fork results, and advances ids', async () => {
        const helper = brain(scripted([answer('helper answer')]));

        const lead = brain(
            routed((request) => {
                if (latestUser(request) === 'investigate') return answer('fork answer');

                const delegateResult = request.messages.some(
                    (message) =>
                        message.role === 'tool' &&
                        message.name === 'delegate' &&
                        message.content.includes('helper answer')
                );
                const forkResult = request.messages.some(
                    (message) =>
                        message.role === 'tool' &&
                        message.name === 'threadFork' &&
                        message.content.includes('fork answer')
                );

                if (delegateResult && forkResult) return answer('root final');

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return [
                        {
                            type: 'done',
                            stopReason: 'tool_calls',
                            toolCalls: [
                                {
                                    id: 'c1',
                                    name: 'delegate',
                                    arguments: '{"agent":"helper","input":"help"}'
                                },
                                {
                                    id: 'f1',
                                    name: 'threadFork',
                                    arguments: '{"input":"investigate"}'
                                }
                            ]
                        }
                    ];
                }

                return answer('waiting');
            })
        );

        const source = harness({ agents: { lead, helper }, presets: false });
        await source('go');

        const branchId = source.branches()[0].branchId;
        const snapshot = source.snapshot();

        // Only terminal records, ordered by run sequence (root, helper, fork).
        //
        // Every row names its OWNER (`threadId`) — the persistent conversation `purgeThread`'s
        // delete cascade matches on. A default-thread run is owned by `agent:<name>`, and a
        // branch by the conversation that spawned it (0033/0024: the owner is state, so it has to
        // survive the round trip or a conversation deleted after a reload keeps its results).
        expect(snapshot.agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 3,
                agent: 'lead',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'root final',
                threadId: 'agent:lead',
                // W19: the row is addressed by its RUN, so it names the ledger generation that minted
                // `invocationId` (../types `HarnessAgentResultSnapshot.epoch`). This is the field that
                // lets a restarted harness keep this row beside the row of the id it re-mints.
                epoch: HARNESS_PROCESS_EPOCH
            },
            {
                invocationId: '2',
                sequence: 2,
                completedOrder: 1,
                agent: 'helper',
                rank: 'B',
                kind: 'delegation',
                status: 'completed',
                content: 'helper answer',
                threadId: 'agent:helper',
                epoch: HARNESS_PROCESS_EPOCH
            },
            {
                invocationId: branchId,
                sequence: 3,
                completedOrder: 2,
                agent: 'lead',
                rank: 'A',
                kind: 'fork',
                status: 'completed',
                content: 'fork answer',
                threadId: 'agent:lead',
                epoch: HARNESS_PROCESS_EPOCH
            }
        ]);

        // A fresh harness with the same agent identities restores the archive.
        const target = harness({
            agents: {
                lead: brain(scripted([answer('after')])),
                helper: brain(scripted([answer('unused')]))
            },
            presets: false
        });
        // JSON round-trip mirrors the server's on-disk persistence path.
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'root final',
            contentLength: 10,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(await target.executeTool('agentResult', { agent: 'helper' })).toEqual({
            agent: 'helper',
            invocationId: '2',
            kind: 'delegation',
            status: 'completed',
            content: 'helper answer',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(
            await target.executeTool('agentResult', { agent: 'lead', invocationId: branchId })
        ).toEqual({
            agent: 'lead',
            invocationId: branchId,
            kind: 'fork',
            status: 'completed',
            content: 'fork answer',
            contentLength: 11,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Round-trip is exact.
        expect(target.snapshot().agentResults).toEqual(snapshot.agentResults);

        // A new run takes sequence 4, so it cannot reuse/overwrite invocation '1'.
        await target('after');
        expect(await target.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '4',
            kind: 'root',
            status: 'completed',
            content: 'after',
            contentLength: 5,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(
            await target.executeTool('agentResult', { agent: 'lead', invocationId: '1' })
        ).toMatchObject({ content: 'root final' });
    });

    it('persists failed results and restores their error', async () => {
        const source = harness({
            agents: {
                // R1: one attempt — the terminal failure shape is what is pinned here.
                writer: brain(scripted([[{ type: 'error', message: 'transport exploded' }]]), {
                    retry: false
                })
            },
            presets: false
        });

        await expect(source('go')).rejects.toThrow('transport exploded');

        const snapshot = source.snapshot();
        expect(snapshot.agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'failed',
                // Issue 0036 R3: the CAUSE of the halt travels on the row beside the
                // status. A transport failure that exhausted its attempts classifies as
                // `api-error` — the classifier's fallback branch for a run that died on
                // the provider, not a progress measure and not a second status.
                stopReason: 'api-error',
                content: '',
                error: 'transport exploded',
                // Issue 0033: the position the run reached is stored with the row, and it
                // travels on its own — this run failed on its first request, so it has a
                // message count and NO `partialContent` key. That asymmetry is the runtime's
                // own (0020's open case), and the reader keeps it rather than pairing the two.
                cancelledAtMessage: 1,
                // The callable root belongs to the agent's DEFAULT conversation, so the row names
                // that owner (`agent:writer`) rather than leaving it out (0033/0024).
                threadId: 'agent:writer',
                // W19: the ledger generation that minted this row's invocation id.
                epoch: HARNESS_PROCESS_EPOCH
            }
        ]);

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        target.restore(snapshot);

        expect(await target.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            // F-A Defect 1 (2026-11-15): the cause survives the restart in BOTH places —
            // the row above carries it, and after `restore()` this door reads it back off
            // the re-projected record. That is the durability half of R4: a caller asking
            // "why did it stop" after a reboot gets the same machine-readable answer it
            // would have got before one.
            stopReason: 'api-error',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport exploded',
            cancelledAtMessage: 1
        });
    });

    it('omits a running invocation from a snapshot and persists it once terminal', async () => {
        let release: (() => void) | undefined;

        const hold = tool({
            description: 'Hold until released.',
            tags: ['test'],
            visibility: 'core',
            execute: () =>
                new Promise<string>((resolve) => {
                    release = () => resolve('held');
                })
        });

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('h1', 'hold', '{}'), answer('late answer')]))
            },
            tools: { hold },
            presets: false
        });

        const pending = writer('go');
        await vi.waitFor(() => expect(release).toBeDefined());

        // A running invocation has no answer; it is omitted rather than fabricated.
        expect(writer.snapshot().agentResults).toBeUndefined();

        release!();
        await pending;

        expect(writer.snapshot().agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'late answer',
                // A completed row may name its owner too — unlike the forensic pair, a finished
                // turn still belongs to the conversation that ran it (0033/0024).
                threadId: 'agent:writer',
                // W19: every persisted row names its ledger generation.
                epoch: HARNESS_PROCESS_EPOCH
            }
        ]);
    });

    it('restores an old snapshot without the field and mutates nothing on invalid results', async () => {
        const source = harness({
            agents: { writer: brain(scripted([answer('archived')])) },
            presets: false
        });
        await source('go');
        const snapshot = source.snapshot();

        const legacy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
        delete legacy.agentResults;

        const fresh = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        fresh.restore(legacy as never);
        expect(await fresh.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The target already has a different result. A rejected snapshot must not
        // clear or partially overwrite it.
        const target = harness({
            agents: { writer: brain(scripted([answer('keep')])) },
            presets: false
        });
        await target('go');

        const invalid = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        invalid.agentResults[0].status = 'running';

        expect(() => target.restore(invalid as never)).toThrow(
            'snapshot.agentResults[0].status must be one of: completed, failed, cancelled (running is not persisted).'
        );
        expect(await target.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'keep',
            contentLength: 4,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('rejects duplicate ids and over-bound result arrays before mutating', async () => {
        const source = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await source('go');
        const snapshot = source.snapshot() as Record<string, unknown>;

        const duplicate = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        duplicate.agentResults.push({ ...duplicate.agentResults[0] });

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        // The row came from a live snapshot, so it carries its epoch and the refusal names the RUN
        // (W19: the uniqueness rule moved onto the run, because one document can legitimately hold
        // the same bare id once per ledger generation).
        expect(() => target.restore(duplicate as never)).toThrow(
            `snapshot.agentResults contains the duplicate invocationId "1" of epoch "${HARNESS_PROCESS_EPOCH}".`
        );

        const overBound = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        overBound.agentResults = Array.from({ length: 65 }, (_, index) => ({
            invocationId: `r${index + 1}`,
            sequence: index + 1,
            completedOrder: index + 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'x'
        }));

        expect(() => target.restore(overBound as never)).toThrow(
            'snapshot.agentResults contains 65 records; at most 64 are retained.'
        );
    });

    it('retains at most 64 results and snapshot restores that bound', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('x')])) },
            presets: false
        });

        for (let index = 0; index < 70; index++) await writer(`prompt ${index}`);

        const retained = writer.snapshot().agentResults!;

        expect(retained).toHaveLength(64);
        expect(retained[0]).toMatchObject({ invocationId: '7', sequence: 7 });
        expect(retained.at(-1)).toMatchObject({ invocationId: '70', sequence: 70 });

        // B2 (2026-11-26) — this id was EVICTED by the ring, so it exists nowhere and the refusal says
        // the honest thing. (It is also why the wording pin belongs here: an evicted row is exactly the
        // "no such invocation" case, not the wrong-agent case.)
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '6' })
        ).rejects.toThrow(
            'No result "6" is available for agent "writer": no such invocation in this harness.'
        );

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        target.restore(writer.snapshot());
        expect(target.snapshot().agentResults).toHaveLength(64);
    });

    it('reserves restored branch ids so a new fork cannot overwrite an archived result', async () => {
        const source = brain(
            routed((request) => {
                if (latestUser(request) === 'archived task') return answer('archived fork');

                if (hasForkResult(request)) return answer('archived root');

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return callTool('f1', 'threadFork', '{"input":"archived task"}');
                }

                return answer('waiting');
            })
        );

        const first = harness({ agents: { lead: source }, presets: false });
        await first('go');

        const snapshot = first.snapshot();
        const archivedBranch = snapshot.agentResults!.find((result) => result.kind === 'fork')!;
        archivedBranch.invocationId = 'branch-99999';

        const targetStream = routed((request) => {
            if (latestUser(request) === 'new task') return answer('new fork answer');

            const newFork = request.messages.some(
                (message) =>
                    message.role === 'tool' &&
                    message.name === 'threadFork' &&
                    message.content.includes('new fork answer')
            );

            if (newFork) return answer('new root answer');

            const requestedNewFork = request.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    message.toolCalls?.some((call) => call.id === 'f2')
            );

            // First target turn: ask for exactly one NEW fork (the restored
            // transcript's old fork is already paired and must not suppress this).
            if (!requestedNewFork) return callTool('f2', 'threadFork', '{"input":"new task"}');

            // Tool-free pause until the new branch delivers its result.
            return answer('waiting');
        });

        const target = harness({ agents: { lead: brain(targetStream) }, presets: false });
        target.restore(snapshot);

        expect(
            await target.executeTool('agentResult', {
                agent: 'lead',
                invocationId: 'branch-99999'
            })
        ).toMatchObject({ content: 'archived fork', kind: 'fork' });

        await target('again');

        const newBranchId = target.branches()[0].branchId;
        expect(newBranchId).not.toBe('branch-99999');
        expect(Number(newBranchId.slice('branch-'.length))).toBeGreaterThan(99999);

        // The archived record is still addressable after the new fork.
        expect(
            await target.executeTool('agentResult', {
                agent: 'lead',
                invocationId: 'branch-99999'
            })
        ).toMatchObject({ content: 'archived fork' });
    });
});

// ---------------------------------------------------------------------------
// B2 (2026-11-13) — ONE synchronous terminal commit for a finished run
// ---------------------------------------------------------------------------
//
// A run's terminal state is TWO facts: the agent-result ledger entry (`finishInvocation`)
// and the conversation's release back to `idle`. They used to happen in two places with an
// `await` between them, so anything a `run.finished`/`run.failed` handler did in that
// window saw a conversation that had already ANSWERED but was still `running` and still
// held its run slot. Two consequences, both pinned here:
//   - a handler that reaps a finished conversation (`deleteThread`, the way a session
//     frees a thread slot) drew `Thread "…" is running; stop it before deleting it.` even
//     though the run was over;
//   - the read side handed back the NEWEST STARTED record when no finished one was newer,
//     i.e. a `status: 'running'` next to `content: ''` — indistinguishable from "this
//     agent has never said anything", which is why a caller stopped polling a child that
//     had already answered on an earlier turn.
//
// The host thread is the fixture throughout: `deleteThread` refuses an agent's default
// `agent:<name>` conversation by design, so `origin: 'host'` is the only conversation a
// reaper can actually close, and it is also the only one whose removal is observable here.
describe('terminal commit is atomic for a finished run (B2)', () => {
    // A gate the test opens by hand: the run that calls `hold` stays in flight until the
    // assertions below have been made, which is the only way to observe a STARTED record.
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((accept) => {
            resolve = accept;
        });
        return { promise, resolve };
    };

    // Real timers and an explicit pump: this block is about STATE, not time, so the runs
    // are driven by draining the queue until the roster says what the test needs, and the
    // pump itself asserts the condition so a stuck run fails here rather than later.
    const pump = async (predicate: () => boolean, passes = 60): Promise<void> => {
        for (let index = 0; index < passes && !predicate(); index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(predicate()).toBe(true);
    };

    it('a run.finished handler finds the thread idle, and its delete removes the whole conversation', async () => {
        const reaped: { threadId: string; status: string | undefined }[] = [];
        let refusal: string | undefined;
        let reapedId: string | undefined;

        const reaper = {
            name: 'reaper',
            setup: (api) => {
                api.on('run.finished', ({ threadId }) => {
                    if (threadId === undefined || threadId !== reapedId) return;

                    // Observed from INSIDE the hook, which is the window the finding is
                    // about: the record's status at the moment `run.finished` fires.
                    reaped.push({
                        threadId,
                        status: api.threads.list().find((record) => record.id === threadId)?.status
                    });

                    try {
                        api.threads.delete(threadId);
                    } catch (error) {
                        refusal = (error as Error).message;
                    }
                });
            }
        };

        const writer = harness({
            agents: { writer: brain(scripted([answer('done here')])) },
            plugins: [reaper],
            presets: false
        });

        const thread = writer.createThread('writer');
        reapedId = thread.id;

        expect((await writer.sendThreadInput(thread.id, 'go')).content).toBe('done here');

        // THE FIX: at `run.finished` the ledger entry is terminal AND the conversation is
        // released, with no await in between, so the record reads `idle` and the delete is
        // accepted. Before this, `status` was 'running' and `refusal` was the sentence the
        // handler had no way to satisfy — the run it was told about was already over.
        expect(reaped).toEqual([{ threadId: thread.id, status: 'idle' }]);
        expect(refusal).toBeUndefined();

        // And the removal is WHOLE. Record, roster, transcript and the invocation lookup
        // all go together (purgeThread matches `record.threadId` and the roster's own
        // `invocationId`), so "the conversation is gone but its result survives" is now
        // unrepresentable — which is the state a reaping caller could previously be left
        // polling.
        expect(writer.thread(thread.id)).toBeUndefined();
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer']);

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The other half of the atomic claim: the harness is still usable afterwards, so a
        // reaped conversation cannot strand the session.
        expect(writer.agent.messages).toEqual([]);
    });

    it('a delete that arrives while the run still holds the conversation refuses on the live run', async () => {
        let refusal: string | undefined;
        let reapedId: string | undefined;

        // `run.started` is the genuinely-live case: the run owns the slot, the record says
        // `running`, and deleting then must still refuse. B2 moved state earlier; it did
        // NOT loosen the live-run guard, and this is the half that proves that.
        const eager = {
            name: 'eager',
            setup: (api) => {
                api.on('run.started', ({ threadId }) => {
                    if (threadId === undefined || threadId !== reapedId) return;

                    try {
                        api.threads.delete(threadId);
                    } catch (error) {
                        refusal = (error as Error).message;
                    }
                });
            }
        };

        const writer = harness({
            agents: { writer: brain(scripted([answer('still here')])) },
            plugins: [eager],
            presets: false
        });

        const thread = writer.createThread('writer');
        reapedId = thread.id;

        expect((await writer.sendThreadInput(thread.id, 'go')).content).toBe('still here');

        expect(refusal).toBe(`Thread "${thread.id}" is running; stop it before deleting it.`);
        expect(writer.thread(thread.id)).toMatchObject({ id: thread.id, status: 'idle' });

        // The refusal left nothing half-removed, so the conversation is still repleasable
        // by the same op once its run is genuinely over.
        expect(writer.deleteThread(thread.id)).toEqual({
            deleted: thread.id,
            removedThreadIds: [thread.id],
            // The turn that had just finished is the lookup the release takes with it — named
            // on the receipt, since `agentResult` for it starts throwing on the next call.
            removedInvocationIds: ['1'],
            removedBranchIds: []
        });
    });

    it('the default result is the newest FINISHED answer, never a run that is still in flight', async () => {
        const gate = deferred<string>();

        // One agent, two conversations: `first` finishes (record 1), `second` is parked
        // inside a tool (record 2). Before B2 the DEFAULT lookup sorted by START order, so
        // `agentResult` with no invocationId returned record 2 with an empty body and a
        // `running` status — the caller read that as "no answer yet" and stopped polling,
        // even though record 1 held the real answer.
        const writerAgent = brain(
            routed((request) => {
                const brief = latestUser(request);

                if (brief.includes('second')) {
                    return request.messages.some((message) => message.name === 'hold')
                        ? answer('second answer')
                        : callTool('h1', 'hold', '{}');
                }

                return answer('first answer');
            })
        );

        // A second agent whose ONLY invocation is in flight: it has no result at all, and
        // the honest answer is the empty state, not a `running` record with an empty body.
        const quietAgent = brain(
            routed((request) =>
                request.messages.some((message) => message.name === 'hold')
                    ? answer('quiet answer')
                    : callTool('h2', 'hold', '{}')
            )
        );

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const writer = harness({
            agents: { writer: writerAgent, quiet: quietAgent },
            tools: { hold },
            presets: false
        });

        const first = writer.createThread('writer');
        await writer.sendThreadInput(first.id, 'first');
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'completed',
            content: 'first answer'
        });

        const second = writer.createThread('writer');
        const quiet = writer.createThread('quiet');

        const secondRun = writer.sendThreadInput(second.id, 'second');
        const quietRun = writer.sendThreadInput(quiet.id, 'hush');

        await pump(() => {
            return (
                writer.thread(second.id)?.status === 'running' &&
                writer.thread(quiet.id)?.status === 'running'
            );
        });

        // The finished answer still wins the default, with the parked run in flight.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'completed',
            content: 'first answer'
        });

        // An agent with only an in-flight run reports the EMPTY state — `status: 'running'`
        // next to `content: ''` was the lie this replaces.
        expect(await writer.executeTool('agentResult', { agent: 'quiet' })).toEqual({
            agent: 'quiet',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The live invocations are still reported where they belong, and an explicit id
        // still reaches the running record: `agentManage` is the liveness surface, and
        // `agentResult` by id is the address.
        expect(await writer.executeTool('agentManage', {})).toMatchObject({
            totalResults: 3,
            activeResults: 2
        });

        expect(await writer.executeTool('agentResult', { agent: 'quiet', invocationId: '3' })).toMatchObject({
            invocationId: '3',
            kind: 'root',
            status: 'running',
            content: ''
        });

        gate.resolve('released');
        const secondAnswer = await secondRun;
        const quietAnswer = await quietRun;

        expect([secondAnswer.content, quietAnswer.content]).toEqual(['second answer', 'quiet answer']);

        // Completion order decides the default, and every record is terminal again.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '2',
            status: 'completed',
            content: 'second answer'
        });

        expect(await writer.executeTool('agentResult', { agent: 'quiet' })).toMatchObject({
            invocationId: '3',
            status: 'completed',
            content: 'quiet answer'
        });

        expect(await writer.executeTool('agentManage', {})).toMatchObject({
            totalResults: 3,
            activeResults: 0
        });
    });

    // THE UNTESTED HALF OF THE B2 SELECTOR (`src/harness.ts:3935-3939`):
    // `record = completed[0] ?? recent.find((entry) => entry.status !== 'running')`.
    // The completed branch and the nothing-finished-at-all branch were both pinned; the
    // `??` fallback — an agent whose only FINISHED runs failed or were cancelled — was
    // not, and that is exactly the case the entry's prose used to get wrong (it promised
    // `status: 'empty'` "when that agent has no completed result", which contradicts a
    // fallback that returns that failed record). Pinned here as an exact answer: the
    // NEWEST terminal record, with its own error and forensic fields, never `empty`.
    it('the default selector returns the newest terminal record when nothing completed (B2 fallback)', async () => {
        const gate = deferred<string>();

        // Turn 1 is a transport error (record 1 -> `failed`). Turn 2 parks inside a tool
        // so the host can stop it (record 2 -> `cancelled`). `retry: false` keeps the
        // first run ONE record rather than a retry sequence with several.
        const writerAgent = brain(
            routed((request) => {
                const brief = latestUser(request);

                if (brief.includes('stop')) {
                    return request.messages.some((message) => message.name === 'hold')
                        ? answer('never answered')
                        : callTool('h1', 'hold', '{}');
                }

                return [{ type: 'error', message: 'first transport exploded' }];
            }),
            { retry: false }
        );

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const writer = harness({ agents: { writer: writerAgent }, tools: { hold }, presets: false });

        const broken = writer.createThread('writer');

        await expect(writer.sendThreadInput(broken.id, 'boom')).rejects.toThrow('first transport exploded');

        // Nothing has COMPLETED, so a caller of the pre-B2-fallback build read `empty`
        // here and gave up. The terminal fallback answers the failed run instead.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'failed',
            error: 'first transport exploded'
        });

        const stopped = writer.createThread('writer');
        const stoppedRun = writer.sendThreadInput(stopped.id, 'stop me');

        await pump(() => writer.thread(stopped.id)?.status === 'running');
        expect(writer.stopThread(stopped.id, 'the host stopped it')).toBe(true);
        await expect(stoppedRun).rejects.toThrow();

        // The NEWEST terminal record wins the default — the cancelled run, not the older
        // failure — because "the last thing that actually finished" is what a caller
        // polling without an id is asking for.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '2',
            kind: 'root',
            status: 'cancelled',
            // F-A Defect 1 (2026-11-15): the run was halted by `writer.stopThread`, which
            // is the host's intent, so the cause is `user-stopped` — not `caller-released`
            // (a peer that walked away) and not `timeout`. This is the whole point of the
            // field: the two runs above and below this one are BOTH non-completed, and only
            // this key says which kind of non-completion each one is.
            stopReason: 'user-stopped',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'the host stopped it',
            cancelledAtMessage: 1,
            durationMs: expect.any(Number)
        });

        // And `empty` keeps its exact, narrow meaning: no finished run at all. The same
        // agent answers `empty` before its first run, which is the only place that status
        // appears for an agent that HAS run.
        const untouched = harness({
            agents: { writer: brain(scripted([answer('unused')])), fresh: brain(scripted([answer('unused')])) },
            presets: false
        });

        expect(await untouched.executeTool('agentResult', { agent: 'fresh' })).toEqual({
            agent: 'fresh',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        gate.resolve('released');
    });

    // D5 (2026-11-26) — THE OTHER HALF OF THE B2 SELECTOR WAS STILL START-ORDERED.
    //
    // `agentResultFor`'s no-`invocationId` selector read `completed[0] ?? recent.find(e =>
    // e.status !== 'running')`. The completed half sorts by `completedOrder`; `recent` is
    // SORTED BY START (`recordsForAgent`), so the fallback half — exactly the state this block
    // describes, an agent with nothing finished except failures — handed the default to
    // whichever overlapping child happened to START LAST. Two children of one agent is the
    // shape that makes that observable: the one that began second but died first beat the one
    // that began first and finished last, which is the fork-masking case the comment at the
    // selector promises is impossible ("completion order, not start order").
    //
    // The fixture keeps BOTH runs non-completed, so the fallback half is the only half that can
    // answer, and pins the two orderings INVERTED, which is what makes the pin a proof rather
    // than a restatement of the selector.
    it('the no-id fallback picks the last FINISHED terminal record, not the last started one (D5)', async () => {
        const gate = deferred<string>();

        // `slow` parks inside `hold` (it is the run the test stops SECOND); `fast` dies on the
        // transport immediately (it is the run that FINISHES FIRST while having STARTED last).
        // `retry: false` keeps the failure ONE record rather than a retry sequence.
        const writerAgent = brain(
            routed((request) => {
                const brief = latestUser(request);

                if (brief.includes('fast')) {
                    return [{ type: 'error', message: 'fast transport exploded' }];
                }

                return request.messages.some((message) => message.name === 'hold')
                    ? answer('never answered')
                    : callTool('h1', 'hold', '{}');
            }),
            { retry: false }
        );

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const writer = harness({ agents: { writer: writerAgent }, tools: { hold }, presets: false });

        // START ORDER: slow first (record 1), fast second (record 2). Registration happens when
        // the run begins, so the pump below is what guarantees `fast` registers AFTER `slow` —
        // two threads of one agent run concurrently (pinned in
        // ./harness.thread-runtime.test.ts:389), so both rows are alive at once.
        const slow = writer.createThread('writer');
        const slowRun = writer.sendThreadInput(slow.id, 'slow, then stop');

        await pump(() => writer.thread(slow.id)?.status === 'running');

        const fast = writer.createThread('writer');
        await expect(writer.sendThreadInput(fast.id, 'fast')).rejects.toThrow('fast transport exploded');

        // Nothing has completed and both rows are terminal-ish: `fast` is `failed`, `slow` is
        // still `running`. The default therefore answers the failed run — the only finished one
        // there is at this instant.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '2',
            status: 'failed'
        });

        // COMPLETION ORDER: now the older run finishes, SECOND. `completedOrder` is a global
        // counter, so this is the step that inverts the two orderings — and the snapshot below
        // is the proof, asserted as exact numbers rather than as a description.
        expect(writer.stopThread(slow.id, 'the host stopped it')).toBe(true);
        await expect(slowRun).rejects.toThrow();

        expect(
            ((writer.snapshot() as { agentResults?: Record<string, unknown>[] }).agentResults ?? [])
                .map((row) => [row.invocationId, row.sequence, row.completedOrder, row.status])
                // [id, sequence (START), completedOrder (FINISH), status] — deliberately crossed:
                // the row that started first finished last, and vice versa.
        ).toEqual([
            ['1', 1, 2, 'cancelled'],
            ['2', 2, 1, 'failed']
        ]);

        // THE SELECTOR. With no completed row, the retired `recent.find(...)` read START order
        // and returned `2` (started last, finished FIRST); the fixed fallback sorts the terminal
        // rows by `completedOrder` and returns `1` — the last thing that actually finished. The
        // exact envelope is pinned so a change of selector cannot quietly swap the ERROR too.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            stopReason: 'user-stopped',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'the host stopped it',
            // The POSITION the stopped run had reached, asserted as the number this fixture
            // actually produces (assistant tool-call turn + the synthesized answer the harness
            // writes for the unanswered call, 0036 R1's thread-bound retention — the transcript
            // is `[user, assistant, tool(hold)]`). The M1 pin above shows `1` for a run stopped
            // one step earlier; this counter is a forensic position, not part of the selector
            // claim, and it is pinned exactly so a change here stays visible.
            cancelledAtMessage: 2,
            // issue 0032 (2026-11-26) — the selector envelope now says what the stopped run DID.
            // One `hold` call, and it never answered (`settled: 0`): the run was stopped inside
            // the tool round, which is the case `partialContent` cannot describe at all — this row
            // carries no partial, so before 0032 it said nothing about the call in flight.
            toolActivity: { calls: 1, settled: 0, byName: [{ name: 'hold', calls: 1 }], truncated: false },
            durationMs: expect.any(Number)
        });

        // Both rows stay individually addressable, so this is a SELECTOR fix and not a change to
        // what the ledger holds: the started-last failure is still reachable by its own id.
        expect(await writer.executeTool('agentResult', { agent: 'writer', invocationId: '2' })).toMatchObject(
            {
                invocationId: '2',
                status: 'failed',
                error: 'fast transport exploded'
            }
        );

        gate.resolve('released');
    });

    it('invents no invocation identity when the delegate result has no ledger record to point at', () => {
        // This one is pinned against the SOURCE, and the reason is honest: the omitted
        // identity has no reachable trigger inside one process today. A delegated child
        // runs in the child agent's DEFAULT conversation (`agent:<name>`), which
        // `deleteThread` refuses outright, and the requesting run holds its own thread
        // until its pending async work settles — so neither the child's conversation nor
        // an ancestor can be reaped while the delegation is open, and the only other way
        // to lose the record is the 64-record ledger bound. The branch is therefore
        // guarded at the read, and this test is what makes removing the guard a decision
        // rather than an accident.
        const source = readFileSync(fileURLToPath(new URL('./harness.ts', import.meta.url)), 'utf8');

        // Every identity field is a CONDITIONAL spread: an absent record means an absent
        // field, never a placeholder that reads like an address or a status.
        expect(source).toContain('...(record === undefined ? {} : { invocationId: record.invocationId }),');
        expect(source).toContain('...(record?.threadId === undefined ? {} : { threadId: record.threadId }),');
        expect(source).toContain('...(record === undefined ? {} : { status: record.status }),');

        // The fabrication the finding replaced is gone from the CODE: an empty string that
        // READS like an address, so a caller pages `agentResult` with `''` and gets an
        // unrelated result instead of noticing that there is none. Comment lines are
        // excluded because the comment at the commit site QUOTES the old code.
        const codeLines = source
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => !line.startsWith('//') && !line.startsWith('*'));

        expect(codeLines.filter((line) => line.includes("invocationId: ''"))).toEqual([]);

        // `durationMs` keeps its honest fallback: the child's own measurement when the
        // record exists, otherwise the span this call actually spent.
        expect(source).toContain('durationMs: record?.durationMs ?? Math.max(0, Date.now() - startedAt)');
    });
});


// ---------------------------------------------------------------------------
// ISSUE 0033 (2026-11-14) — the forensic partial of an UNFINISHED run survives
// persistence
// ---------------------------------------------------------------------------
//
// `partialContent` and `cancelledAtMessage` were, when issue 0033 shipped, the ONLY
// surviving account of a cancelled or failed run: the transcript rollback in
// `runAgentCore`'s catch spliced the run's own messages out, so a post-mortem had
// exactly these two fields plus `error`. Issue 0036 R1 retired that splice for a
// THREAD-BOUND run — its committed turns (plus one synthesized answer per unanswered
// call) now stay in the conversation, so the pair is corroborating evidence beside a
// readable transcript rather than the only trace. It is still the ONLY account for a
// branch/ephemeral run, which keeps its rollback, and for any post-mortem that reads
// the row without the conversation. They were also RUNTIME-ONLY. The snapshot
// projection wrote `content` alone — empty for a non-completed run — and `restore()`
// rebuilt the record without the pair, so the restart took back an answer the caller
// had already been shown. `Temp/t12-verify/probes/t12-snapshot-partial.test.ts`
// measured it on the pre-fix tree (invocationId `2`, the abort door):
//
//   live      content:"half an answer", contentLength:14, partialContent present, cancelledAtMessage:2
//   snapshot  content:"" and NO `partialContent` key
//   restored  content:"", contentLength:0, and NO `partialContent` key
//
// That is the stress report's #5 harm class — "the answer I already relied on is
// gone" — one door further down. The fixtures below reproduce the same two shapes the
// probe used (a committed text turn, then a parked tool for the cancel; a committed
// text turn, then a transport error for the failure) and pin the whole chain with
// exact values: live door, snapshot row, restored door, and re-projection.
//
// The pair also bounds itself, which is why persisting it costs nothing: a terminal
// record holds its answer in exactly ONE of `content` (completed) or `partialContent`
// (unfinished) — `finishInvocation` (`src/harness.ts:3866-3890`) never writes both and
// `archiveInvocation` (`:7194-7196`) keeps the same rule — so the archive's answer-text
// footprint is unchanged and the row count is still capped by AGENT_RESULT_RETENTION
// (64, `src/core/agent-limits.ts:25`). No new size cap was introduced; `content` was
// already stored in full and paged on READ, and this field follows that precedent.
//
// What still does NOT survive, and deliberately: the run's transcript in the RESULT row
// (0036 R1 retains it in the CONVERSATION for a thread-bound run; a branch run still
// rolls back, and either way the result row itself never carried it),
// its tool calls and tool bodies (0020's leak boundary, 0032), and `durationMs` — a
// wall-clock measurement of the run this process made, not part of 0033's gap, so the
// restored envelopes below assert its ABSENCE rather than inventing a value.
describe('the forensic partial survives persistence (issue 0033)', () => {
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((accept) => {
            resolve = accept;
        });
        return { promise, resolve };
    };

    // Real timers, state-driven pump — same convention as the B2 block above.
    const pump = async (predicate: () => boolean, passes = 120): Promise<void> => {
        for (let index = 0; index < passes && !predicate(); index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(predicate()).toBe(true);
    };

    const settle = async (passes = 20): Promise<void> => {
        for (let index = 0; index < passes; index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };

    const rowOf = (snapshot: unknown, invocationId: string) =>
        ((snapshot as { agentResults?: Record<string, unknown>[] }).agentResults ?? []).find(
            (record) => record.invocationId === invocationId
        ) ?? null;

    // The cancelled fixture: ONE committed assistant text turn, then a park inside a
    // hanging sync tool. The abort door is the run's OWN signal — a host `stopThread`
    // reaches the same catch but leaves nothing committed (see the pin at :1571, where a
    // stopped run reports `cancelledAtMessage: 1` with NO partial), so only the signal
    // exercises the pair.
    const cancelledRun = async (): Promise<{
        source: ReturnType<typeof harness>;
        invocationId: string;
        // The host thread this run belongs to — the owner the persisted row has to name, so the
        // assertions below can address it without hardcoding the minted id.
        threadId: string;
        release: () => void;
    }> => {
        const gate = deferred<string>();

        const source = harness({
            agents: {
                writer: brain(
                    routed((request) =>
                        request.messages.some((message) => message.role === 'tool')
                            ? answer('never reached')
                            : [
                                  { type: 'text', delta: 'half an answer' },
                                  ...callTool('h1', 'hold', '{}')
                              ]
                    )
                )
            },
            tools: {
                hold: tool({
                    description: 'Hold until the test releases it.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => gate.promise
                })
            },
            presets: false
        });

        const thread = source.createThread('writer');
        const controller = new AbortController();
        const run = source
            .sendThreadInput(thread.id, 'go', { signal: controller.signal })
            .catch((error: Error) => error);

        await pump(() =>
            source.threadMessages(thread.id).some((message) => message.role === 'assistant')
        );

        controller.abort(new Error('operator stop'));
        await run;

        gate.resolve('released');
        await settle();

        return {
            source,
            threadId: thread.id,
            invocationId: String(source.thread(thread.id)?.invocationId ?? ''),
            release: () => undefined
        };
    };

    it('carries a cancelled run partial and its message position through snapshot -> restore', async () => {
        const { source, threadId, invocationId } = await cancelledRun();

        // SURFACE 1 — the live door, the shape the caller was promised.
        expect(await source.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            // F-A Defect 1 (2026-11-15): the run died on the CALLER's own abort signal
            // (`controller.abort`), which is `caller-released`, and the persisted row below
            // has always said so — this door was the one still answering `undefined`. It is
            // pinned identically at every surface in this test on purpose: live row,
            // durable row, and the post-restart read must not disagree about the cause.
            stopReason: 'caller-released',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            // issue 0032 (2026-11-26) — SURFACE 1, the live door: what the stopped run DID, beside
            // what it said. One `hold` call, unanswered when the abort landed.
            toolActivity: { calls: 1, settled: 0, byName: [{ name: 'hold', calls: 1 }], truncated: false },
            durationMs: expect.any(Number)
        });

        // SURFACE 2 — the persisted row. `content` stays EMPTY (it is the completed
        // answer, and this run never gave one); the partial and its position travel
        // beside the error instead. `threadId` names the conversation that ran it — the
        // same fact `purgeThread`'s cascade matches on, and the one a restart used to
        // lose (0033/0024).
        const snapshot = source.snapshot();

        expect(rowOf(snapshot, invocationId)).toEqual({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'cancelled',
            // Issue 0036 R3: the row names WHY the run halted, separately from the fact
            // that it was cancelled. The caller released the run through its own abort
            // (`operator stop` is the abort reason), which classifies as
            // `caller-released`; a host stop would say `user-stopped` instead, and only
            // the first of those is resumable by `threadSend`.
            stopReason: 'caller-released',
            content: '',
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            // issue 0032 (2026-11-26) — SURFACE 2, the durable row. The tally is stored state, not
            // a live projection: `finishInvocation` wrote it once at the rollback boundary and
            // `snapshot()` writes it with the row, so the same account has to come back from disk.
            // The key order matters here — the reader rebuilds it in this order so the re-projected
            // row below is byte-identical, which is what `restore -> snapshot` idempotency means.
            toolActivity: { calls: 1, settled: 0, byName: [{ name: 'hold', calls: 1 }], truncated: false },
            threadId,
            // W19: the ledger generation of this row (../types `HarnessAgentResultSnapshot.epoch`).
            epoch: HARNESS_PROCESS_EPOCH
        });

        // SURFACE 3 — the restart. JSON on purpose: this is the bytes a server writes
        // under DATABASE_ROOT, so the round trip is proven through the serialiser and the
        // reader, not only through two in-process objects.
        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            // F-A Defect 1 (2026-11-15): SURFACE 3 — the restart keeps the cause too, which
            // is the point of validating it in `core/snapshot.ts`: a reader that dropped it
            // would make this door answer `undefined` only after a reboot.
            stopReason: 'caller-released',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            // issue 0032 (2026-11-26) — SURFACE 3, after the restart through real JSON: the tally
            // crossed the reader (`core/snapshot.ts` validates it with the archive seam's own
            // bounds) and answers the same value the live door printed above. AC4 and AC-B4-4 in
            // one assertion: same value, both doors, on both sides of a reboot.
            toolActivity: { calls: 1, settled: 0, byName: [{ name: 'hold', calls: 1 }], truncated: false }
        });

        // The restored record re-projects byte-for-byte, so a restart cannot start
        // drifting the archive a second time.
        expect(rowOf(target.snapshot(), invocationId)).toEqual(rowOf(snapshot, invocationId));

        // SURFACE 4 — the owner is the point of persisting it, and BOTH doors have to
        // behave the same way: the delete runs on the live record and on the RELOADED one.
        // Before 0033/0024 the restored record had no `threadId`, so `purgeThread`'s
        // predicate (`record.threadId === threadId`) missed it and only the live door
        // reached the row. Both doors are asserted in the same run, so the parity is the
        // finding rather than an assumption.
        expect(source.deleteThread(threadId)).toEqual({
            deleted: threadId,
            removedThreadIds: [threadId],
            removedInvocationIds: [invocationId],
            removedBranchIds: []
        });
        expect(target.deleteThread(threadId)).toEqual({
            deleted: threadId,
            removedThreadIds: [threadId],
            removedInvocationIds: [invocationId],
            removedBranchIds: []
        });

        // What a delete leaves behind is issue 0036 R2's, and the two sentences of it are
        // pinned together here: the CONVERSATION is no longer addressable (`thread()` is
        // gone on both surfaces), while the FORENSIC ROW is retained — the delete marks the
        // owner released, it does not destroy what the owner recorded. That is why the
        // receipt above says `removedInvocationIds: ["1"]` and the row is still readable
        // below: the id stopped being LISTED under a conversation that is itself no longer
        // listed, which is not the same claim as "the row was deleted", and the whole value
        // of a forensic partial is that it survives the register that carried it. Re-captured
        // from an actual run: byte-for-byte the row that was archived before the delete,
        // identical on the live and the reloaded surface (the parity half of this test).
        const archived = rowOf(snapshot, invocationId);

        expect(rowOf(source.snapshot(), invocationId)).toEqual(archived);
        expect(rowOf(target.snapshot(), invocationId)).toEqual(archived);
        expect(target.thread(threadId)).toBeUndefined();
        expect(source.thread(threadId)).toBeUndefined();
    });

    // D1 + D2 (2026-11-26) — THE ABSENCE HALF OF THE CAUSE TRIO, pinned where absence is real.
    //
    // The restored row is the case a blanket projection would have corrupted: `durationMs` is a
    // wall-clock measurement of a run THIS process made, so the archive never writes it
    // (`archiveInvocation`, `src/engine/harness.ts`) and the envelopes above assert its
    // ABSENCE on purpose. A listing row that projected `durationMs: undefined` would add a key
    // every pre-existing pin excludes. `error` and `stopReason`, in contrast, are forensic
    // facts that DO travel — and the row now shows them, which is what a glance at
    // `agentManage` was never able to say before.
    it('previews a restored partial and its cause at the listing door, with `durationMs` still absent', async () => {
        const { source, invocationId } = await cancelledRun();
        const snapshot = source.snapshot();

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        const listed = (await target.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
            totalResults: number;
            activeResults: number;
        };

        expect(listed.agents.map((entry) => entry.name)).toEqual(['writer']);
        expect([listed.totalResults, listed.activeResults]).toEqual([1, 0]);

        const [restoredRow] = listed.agents[0].results;

        expect(restoredRow).toEqual({
            invocationId,
            kind: 'root',
            status: 'cancelled',
            // D1 — the partial survives persistence, so the glance shows it (14 chars, well
            // under the 200 bound, so `truncated: false` and no ellipsis).
            contentLength: 14,
            preview: 'half an answer',
            truncated: false,
            // D2 — the two facts that travel through the archive are projected...
            error: 'operator stop',
            stopReason: 'caller-released'
        });
        // ...and the one that does not stays ABSENT, not `undefined`: this is the whole reason
        // the trio is absence-conditional rather than a plain projection.
        expect(restoredRow).not.toHaveProperty('durationMs');
        expect(restoredRow).not.toHaveProperty('startedAt');
        expect(restoredRow).not.toHaveProperty('ageMs');
        // The live row and the reloaded one differ by EXACTLY ONE key — the wall-clock span of a
        // run this process never made — and agree on every forensic field. That is the precise
        // statement of what persistence does to a glance row: it carries the answer and the
        // cause, and it drops the one number a restart cannot honestly re-derive.
        const [liveRow] = (
            (await source.executeTool('agentManage', {})) as {
                agents: { name: string; results: unknown[] }[];
            }
        ).agents.find((entry) => entry.name === 'writer')!.results;

        expect(liveRow).toEqual({ ...restoredRow, durationMs: expect.any(Number) });
    });

    it('carries a failed run partial through snapshot -> restore', async () => {
        // A FAILED terminal state with something committed: the assistant text turn
        // lands, the tool it called throws, and the NEXT request dies on the transport
        // with `retry: false` so the failure is one record, not a retry sequence.
        const source = harness({
            agents: {
                writer: brain(
                    routed((request) =>
                        request.messages.some((message) => message.role === 'tool')
                            ? [{ type: 'error', message: 'transport died mid-run' }]
                            : [
                                  { type: 'text', delta: 'a partial before the crash' },
                                  ...callTool('b1', 'boom', '{}')
                              ]
                    ),
                    { retry: false }
                )
            },
            tools: {
                boom: tool({
                    description: 'Fail loudly.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => {
                        throw new Error('tool exploded');
                    }
                })
            },
            presets: false
        });

        const thread = source.createThread('writer');

        await expect(source.sendThreadInput(thread.id, 'go')).rejects.toThrow('transport died mid-run');

        const invocationId = String(source.thread(thread.id)?.invocationId ?? '');

        expect(await source.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            // F-A Defect 1 (2026-11-15): the transport died mid-run, so the classifier's
            // provider branch stamped `api-error`; the durable row below has always carried
            // that value and this door now reads the same record. `cancelledAtMessage: 3`
            // stays the POSITION — the two fields answer different questions.
            stopReason: 'api-error',
            content: 'a partial before the crash',
            contentLength: 26,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3,
            // issue 0032 (2026-11-26, AC1) — the FAILED door, not only the cancelled one: the run
            // answered one `boom` call and then lost the transport, so `calls` and `settled` agree.
            // The crash happened after the round closed, and the tally says so.
            toolActivity: { calls: 1, settled: 1, byName: [{ name: 'boom', calls: 1 }], truncated: false },
            durationMs: expect.any(Number)
        });

        const snapshot = source.snapshot();

        expect(rowOf(snapshot, invocationId)).toEqual({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'failed',
            // Issue 0036 R3: the cause travels beside the status — a provider that died
            // mid-run classifies as `api-error`, the classifier's transport branch. It is
            // a cause, not a progress measure: `cancelledAtMessage` stays the position.
            stopReason: 'api-error',
            content: '',
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3,
            // issue 0032 (2026-11-26): the tally rides the durable row too, so a post-mortem that
            // reads only the agent-result ledger — after a restart, with the transcript gone or
            // released — can still say what this failed run did.
            toolActivity: { calls: 1, settled: 1, byName: [{ name: 'boom', calls: 1 }], truncated: false },
            // The owner travels on a failed row exactly as it does on a cancelled one.
            threadId: thread.id,
            // W19: the ledger generation of this row.
            epoch: HARNESS_PROCESS_EPOCH
        });

        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            // F-A Defect 1 (2026-11-15): after the JSON round trip the cause is still the
            // same one the live door reported — persistence does not downgrade it to prose.
            stopReason: 'api-error',
            content: 'a partial before the crash',
            contentLength: 26,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3,
            // issue 0032 (2026-11-26, AC4 + worker-mode-adjacent durability): the value survives
            // the JSON round trip byte-identically — same counts, same single name, same flag —
            // which is what the reader's shared validator in `core/snapshot-validation.ts` exists
            // to guarantee rather than leave to chance.
            toolActivity: { calls: 1, settled: 1, byName: [{ name: 'boom', calls: 1 }], truncated: false }
        });
    });

    it('restores an OLD-GENERATION agent-result row that never carried the forensic keys', async () => {
        // Compatibility is asserted against DATA, not against this build's own writer:
        // the array below is a literal, typed only as JSON, exactly the row shape every
        // file written before 0033 holds (`error` present, no forensic keys). Both
        // halves of the rule matter: the old row must still VALIDATE, and the reader must
        // not INVENT the keys on the way back out.
        const base = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        const document = base.snapshot() as Record<string, unknown>;

        document.agentResults = [
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'cancelled',
                content: '',
                error: 'operator stop'
            },
            {
                invocationId: '2',
                sequence: 2,
                completedOrder: 2,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'a finished answer'
            }
        ];

        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(document)) as never);

        // The old file answers exactly what it always did: the cancelled run reports its
        // error and an empty page, with NO forensic key rather than an empty-string one.
        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId: '1' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop'
        });
        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId: '2' })).toEqual({
            agent: 'writer',
            invocationId: '2',
            kind: 'root',
            status: 'completed',
            content: 'a finished answer',
            contentLength: 17,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Round-tripping old data does not quietly upgrade it: the keys stay absent, so a
        // file this build reads is also a file the previous build could read back.
        expect(target.snapshot().agentResults).toEqual(document.agentResults);

        // A MIXED-generation array — one row with the pair, one without — validates and
        // restores per row, which is what a store with files from both eras needs.
        const mixed = JSON.parse(JSON.stringify(document)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        mixed.agentResults[0].partialContent = 'half an answer';
        mixed.agentResults[0].cancelledAtMessage = 2;

        const both = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        both.restore(mixed as never);

        expect(await both.executeTool('agentResult', { agent: 'writer', invocationId: '1' })).toMatchObject({
            status: 'cancelled',
            content: 'half an answer',
            contentLength: 14,
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });
        expect(await both.executeTool('agentResult', { agent: 'writer', invocationId: '2' })).toMatchObject({
            status: 'completed',
            content: 'a finished answer'
        });
        expect(rowOf(both.snapshot(), '2')).not.toHaveProperty('partialContent');
    });

    it('refuses a forensic value the runtime can never write, without touching live state', async () => {
        const base = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        const rowOfStatus = (status: string): Record<string, unknown> => ({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status,
            content: '',
            ...(status === 'completed' ? {} : { error: 'operator stop' })
        });

        const restoreWith = (patch: Record<string, unknown>): (() => void) => () => {
            const document = JSON.parse(JSON.stringify(base.snapshot())) as {
                agentResults: Record<string, unknown>[];
            };
            document.agentResults = [patch];

            harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false }).restore(
                document as never
            );
        };

        // A writer that stored a blank partial is hand-edited data, not a fact this build
        // produces (`finishInvocation` guards on a non-blank trim, src/harness.ts:3887-3889),
        // and restoring it would answer `partialContent: ""` where the runtime says ABSENT.
        expect(restoreWith({ ...rowOfStatus('cancelled'), partialContent: '' })).toThrow(
            'snapshot.agentResults[0].partialContent must be at least 1 character.'
        );

        expect(restoreWith({ ...rowOfStatus('cancelled'), partialContent: 7 })).toThrow(
            'snapshot.agentResults[0].partialContent must be a string.'
        );

        // `cancelledAtMessage` may be 0 — a run stopped before it appended anything
        // reports zero — but not negative and not fractional.
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: 0 })).not.toThrow();
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: -1 })).toThrow(
            'snapshot.agentResults[0].cancelledAtMessage must be between 0 and Infinity.'
        );
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: 1.5 })).toThrow(
            'snapshot.agentResults[0].cancelledAtMessage must be a safe integer.'
        );

        // The same completed-row rule `error` already enforces: a completed answer has no
        // partial, and a row claiming one is a contradiction, not a redundant field.
        expect(restoreWith({ ...rowOfStatus('completed'), content: 'done', partialContent: 'draft' })).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
        );
        expect(restoreWith({ ...rowOfStatus('completed'), content: 'done', cancelledAtMessage: 4 })).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
        );

        // Nothing above is a PARTIAL accept either: a refused row leaves the harness's own
        // registry exactly as it was (the reader runs before any live state is touched).
        const target = harness({ agents: { writer: brain(scripted([answer('keep')])) }, presets: false });
        await target('go');

        const refused = JSON.parse(JSON.stringify(target.snapshot())) as {
            agentResults: Record<string, unknown>[];
        };
        refused.agentResults[0].partialContent = 'a draft that never was';

        expect(() => target.restore(refused as never)).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
        );
        expect(await target.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'keep',
            contentLength: 4,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // THE OWNER KEY (0033/0024) is read under the same rules: optional on the row, NEVER
        // blank on a row that carries one — both writers (the snapshot projection and
        // `archiveInvocation`) spread it only when the invocation has a conversation, so a
        // `threadId: ""` on disk is a hand edit, and restoring one would hand `purgeThread`'s
        // cascade predicate an owner that matches no conversation.
        expect(restoreWith({ ...rowOfStatus('cancelled'), threadId: '' })).toThrow(
            'snapshot.agentResults[0].threadId must be at least 1 character.'
        );
        expect(restoreWith({ ...rowOfStatus('cancelled'), threadId: 7 })).toThrow(
            'snapshot.agentResults[0].threadId must be a string.'
        );

        // And, unlike the forensic pair, it is LEGAL on a completed row — a finished turn of a
        // host thread still belongs to that thread — and it survives the restore intact, which is
        // the whole point: the cascade still matches after the reload.
        const ownerKept = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        ownerKept.restore({
            ...(JSON.parse(JSON.stringify(base.snapshot())) as Record<string, unknown>),
            agentResults: [{ ...rowOfStatus('completed'), content: 'done', threadId: 'thread-9' }]
        } as never);

        expect(rowOf(ownerKept.snapshot(), '1')).toEqual({
            ...rowOfStatus('completed'),
            content: 'done',
            threadId: 'thread-9'
        });
    });
});

// ---------------------------------------------------------------------------
// REVIEW FINDING #5 / issues 0020 + 0033 (2026-11-14) — THE ARCHIVE SEAM ITSELF.
//
// Everything above this block establishes that a STOPPED RUN holds the pair (live reader, persisted
// row, restored row). What it could not say is that an ARCHIVE — the door a lane result comes
// through, and the door `restore()`-then-re-archive pushes through — carries it. Until this change
// `HarnessInvocationArchiveInput` named neither field, so `archiveInvocation` stored `content: ''`
// and nothing else: issue 0020's "significant cancelled child reports no partial content" with NO
// restart involved, because the loss was in this payload.
//
// The rules pinned here are the snapshot reader's own (../core/snapshot.ts:242-298), reused through
// `core/snapshot-validation.ts` rather than re-derived, so an archive can never mint a live record
// the next snapshot cannot reload:
//   * PRESENT means it said something — a value must be a non-blank string, and an integer >= 0;
//   * a malformed value is REFUSED, not coerced, and refused BEFORE anything moves: no record
//     written, no completion order burned (the lane seam turns this throw into a permanent
//     `invalid-mutation`, so a canonical state corrupted on the way would never be repaired);
//   * a `completed` status carries NEITHER field, exactly like `error` — and on a REPLACE it drops
//     the pair the earlier cancellation left behind, because the reader refuses a completed row
//     that holds one;
//   * the RETURNED record carries what was stored, because the lane digests the return value
//     (`lane-authority.ts` → `archiveDigestOf(archived.record)`) and a field the digest covers that
//     the return omits is a lane that re-archives the same row forever.
// ---------------------------------------------------------------------------
describe('the archive seam carries the forensic pair of a stopped run (review #5, 0020 + 0033)', () => {
    // An archive never runs a model, so one scripted turn is the whole fixture.
    const coreOf = () => harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });

    const rowOf = (snapshot: unknown, invocationId: string) =>
        ((snapshot as { agentResults?: Record<string, unknown>[] }).agentResults ?? []).find(
            (record) => record.invocationId === invocationId
        ) ?? null;

    const cancelledArchive = {
        invocationId: '513',
        sequence: 3,
        agent: 'writer',
        rank: 'B',
        kind: 'delegation',
        status: 'cancelled',
        content: '',
        error: 'The run was cancelled.',
        partialContent: 'half an answer',
        cancelledAtMessage: 2,
        threadId: 'thread-9'
    } as const;

    it('stores the pair on the canonical row AND returns it, which is the record the lane digests', () => {
        const source = coreOf();
        const archived = source.archiveInvocation(cancelledArchive);

        expect(archived.replaced).toBe(false);
        // The whole returned record, key for key. `lane-authority.ts` digests THIS object as the
        // receipt the lane compares against its own derivation, so the pair has to be on it.
        expect(archived.record).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            // W19: an archive that names no `epoch` belongs to THIS process's ledger generation, and
            // the stored/returned record carries it — the key the next snapshot writes, and the one
            // `archiveDigestOf` deliberately leaves outside the lane receipt.
            epoch: HARNESS_PROCESS_EPOCH
        });

        // And the row the session reads, `/results` serves, and the next snapshot writes.
        expect(rowOf(source.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });

        // Reloadable in the strictest sense: the persisted form parses and restores unchanged, which
        // is the guarantee the pair has to keep (the reader's `min: 1` / `>= 0` bounds are why the
        // writer refuses anything else rather than tidying it up).
        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);
        expect(rowOf(reloaded.snapshot(), '513')).toEqual(rowOf(source.snapshot(), '513'));
    });

    it('drops the pair on a completed archive, and off the row a completed archive replaces', () => {
        const source = coreOf();

        // A caller that sends `completed` WITH a partial is not refused — the pair simply has no
        // meaning there, exactly as `error` is ignored on a completed status. Storing it would write
        // a row ../core/snapshot.ts refuses to read back, so the whole snapshot would stop loading.
        const completed = source.archiveInvocation({
            ...cancelledArchive,
            status: 'completed',
            content: 'the finished answer',
            error: undefined
        });

        expect(completed.record).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            // W19: even an archive that omits the field lands in THIS process's ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });
        expect(rowOf(source.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });

        // THE CASE THAT MATTERS: a lane child that is cancelled and then finishes. The first archive
        // stores the pair; the completed one replaces the row, and a spread merge would quietly
        // resurrect the stale partial beside a completed status.
        const staged = coreOf();

        staged.archiveInvocation(cancelledArchive);
        expect(rowOf(staged.snapshot(), '513')?.partialContent).toBe('half an answer');

        staged.archiveInvocation({ ...cancelledArchive, status: 'completed', content: 'the finished answer', error: undefined });

        expect(rowOf(staged.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 2,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });
        // Still one row, and the persisted form is one the reader accepts.
        expect((staged.snapshot() as { agentResults?: unknown[] }).agentResults).toHaveLength(1);

        const restored = coreOf();

        restored.restore(JSON.parse(JSON.stringify(staged.snapshot())) as never);
        expect(rowOf(restored.snapshot(), '513')).toEqual(rowOf(staged.snapshot(), '513'));
    });

    // -----------------------------------------------------------------------
    // issue 0032 (2026-11-26) — THE TALLY CROSSES THE SAME SEAM AS THE PAIR
    // -----------------------------------------------------------------------
    //
    // The archive payload is the ONLY way a stopped lane child's record reaches canonical state, so
    // a field that is not on this door is invisible to every lane reader no matter what the engine
    // stores. This test is the seam half of that claim: input, returned receipt, canonical row,
    // completed-replacement drop, reload, and the refusals.
    it('carries the tool tally through the archive seam, and drops it when the run completed (0032)', async () => {
        const source = coreOf();

        // A stopped lane child that called two tools, one of them twice. `cancelledArchive` above is
        // the PRE-0032 payload and stays legal untouched (the last test in this block archives it
        // with no tally at all) — this is the same door one field wider.
        const toolActivity = {
            calls: 3,
            settled: 2,
            byName: [
                { name: 'read', calls: 2 },
                { name: 'shell', calls: 1 }
            ],
            truncated: false
        };
        const archived = source.archiveInvocation({
            ...cancelledArchive,
            invocationId: '520',
            sequence: 6,
            toolActivity
        });

        // THE RECEIPT, key for key. `lane-authority.ts` digests this returned object as the receipt a
        // lane compares against its own derivation, and `archiveDigestOf`
        // (../server/workers/lane-commit.ts) covers `toolActivity` BECAUSE the fold stores it — a
        // field the digest counts and the receipt omits is a lane that re-archives one row forever.
        expect(archived.record).toEqual({
            invocationId: '520',
            sequence: 6,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            toolActivity,
            epoch: HARNESS_PROCESS_EPOCH
        });

        // THE ROW — what `/results` serves and the next snapshot writes.
        expect(rowOf(source.snapshot(), '520')).toEqual({
            invocationId: '520',
            sequence: 6,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId: 'thread-9',
            toolActivity,
            epoch: HARNESS_PROCESS_EPOCH
        });

        // READ BACK, not dropped: the door a caller uses answers with the archived tally, so the
        // field survives archive → canonical state → surface, not just archive → disk.
        expect(
            await source.executeTool('agentResult', { agent: 'writer', invocationId: '520' })
        ).toMatchObject({ status: 'cancelled', toolActivity });

        // RELOAD, through the serialiser and the strict reader, and re-project: byte-identical.
        // This is `restore -> snapshot` idempotency for this key, which is why the reader validates
        // the value instead of trimming it (an over-cap row that RESTORED as an eight-name row would
        // re-write itself smaller on the next snapshot, and the lane receipt would move).
        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);

        expect(rowOf(reloaded.snapshot(), '520')).toEqual(rowOf(source.snapshot(), '520'));
        expect(
            await reloaded.executeTool('agentResult', { agent: 'writer', invocationId: '520' })
        ).toMatchObject({ toolActivity });

        // COMPLETED MEANS IT IS GONE — on the row a completed archive writes, and on the row it
        // REPLACES. The tally describes a run that did not conclude; ../core/snapshot.ts refuses a
        // completed row that carries one, so keeping it here would make the next snapshot unloadable
        // rather than merely stale. Same rule the partial pair above already enforces.
        const done = source.archiveInvocation({
            ...cancelledArchive,
            invocationId: '520',
            sequence: 6,
            status: 'completed',
            content: 'the finished answer',
            error: undefined,
            toolActivity
        });

        expect(done.replaced).toBe(true);
        expect(done.record).not.toHaveProperty('toolActivity');
        expect(rowOf(source.snapshot(), '520')).not.toHaveProperty('toolActivity');

        // REFUSED, BEFORE ANYTHING MOVES, by the one validator all three doors share
        // (../core/snapshot-validation.ts `readSnapshotToolActivity`). Each sentence is the reader's
        // own, so nothing an archive accepts can be illegal to reload.
        const refuse = (invocationId: string, value: unknown): (() => void) => () =>
            source.archiveInvocation({
                ...cancelledArchive,
                invocationId,
                sequence: 7,
                toolActivity: value as never
            });

        // The cap, named as a number: nine entries is a tally the projection cannot produce.
        expect(
            refuse('521', {
                calls: 9,
                settled: 9,
                byName: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'].map((name) => ({
                    name,
                    calls: 1
                })),
                truncated: true
            })
        ).toThrow('Invocation "521".toolActivity.byName contains 9 entries; at most 8 are recorded.');

        // `settled` is a SUBSET of `calls`, and a row that says otherwise was not written by this engine.
        expect(refuse('522', { calls: 1, settled: 2, truncated: false })).toThrow(
            'Invocation "522".toolActivity.settled (2) cannot exceed Invocation "522".toolActivity.calls (1); a settled call is by definition one that was registered.'
        );

        // `truncated` is REQUIRED: a tally that does not say whether the cap closed the list leaves a
        // reader to guess, which is the ambiguity the field exists to remove. The refusal is the
        // whitelist's own "missing the field" sentence (`readSnapshotKeys`), not the boolean-coercion
        // one — an absent key and a key holding `7` are two different defects and say so.
        expect(refuse('523', { calls: 1, settled: 1 })).toThrow(
            'Invocation "523".toolActivity is missing the field "truncated".'
        );
        expect(refuse('527', { calls: 1, settled: 1, truncated: 1 })).toThrow(
            'Invocation "527".toolActivity.truncated must be a boolean.'
        );

        // An empty name list is the zero-shaped mistake in persisted form — the tally omits the key.
        expect(refuse('524', { calls: 1, settled: 1, byName: [], truncated: false })).toThrow(
            'Invocation "524".toolActivity.byName is empty; a tally with no tool names omits the key rather than listing none.'
        );

        // And an unknown key inside the tally is refused rather than tidied, exactly like an unknown
        // key on the row itself.
        expect(
            refuse('525', {
                calls: 1,
                settled: 1,
                truncated: false,
                byName: [{ name: 'read', calls: 1, extra: true }]
            })
        ).toThrow('Invocation "525".toolActivity.byName[0] has an unknown field "extra".');

        // None of the six left a row, and none burned a completion order — the same property the
        // malformed-pair test below pins for the forensic pair, because the lane seam turns a throw
        // into a permanent `invalid-mutation` and retries the same payload.
        for (const invocationId of ['521', '522', '523', '524', '525', '527']) {
            expect(rowOf(source.snapshot(), invocationId)).toBeNull();
        }

        // A LEGAL tally with no `byName` at all is accepted and reads back unchanged: the key is
        // optional, and "a stopped run whose names the recorder could not list" is a different claim
        // from "this run called nothing" (which reports no tally at all).
        const names = source.archiveInvocation({
            ...cancelledArchive,
            invocationId: '526',
            sequence: 8,
            toolActivity: { calls: 2, settled: 1, truncated: false }
        });

        expect(names.record.toolActivity).toEqual({ calls: 2, settled: 1, truncated: false });
        expect(rowOf(source.snapshot(), '526')?.toolActivity).toEqual({
            calls: 2,
            settled: 1,
            truncated: false
        });

        await source.dispose();
        await reloaded.dispose();
    });

    it('refuses a malformed pair before anything moves — no row, no burned completion order', () => {
        const source = coreOf();

        // The four malformed shapes, each refused with the snapshot reader's own sentence (so a
        // value that is legal to archive is never illegal to reload).
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: '' })).toThrow(
            'Invocation "513".partialContent must be at least 1 character.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: '   ' })).toThrow(
            'Invocation "513".partialContent cannot be blank; a run that said nothing archives no partial at all.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: 7 as unknown as string })).toThrow(
            'Invocation "513".partialContent must be a string.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, cancelledAtMessage: -1 })).toThrow(
            'Invocation "513".cancelledAtMessage must be between 0 and Infinity.'
        );
        // A count is a count, not a string.
        expect(() => source.archiveInvocation({ ...cancelledArchive, cancelledAtMessage: '2' as unknown as number })).toThrow(
            'Invocation "513".cancelledAtMessage must be a safe integer.'
        );

        // NONE of the five touched live canonical state: not a record, not a slot, not the ordering
        // counter. `completedOrder` is minted by incrementing harness-owned state, which is why the
        // validation runs above it — a refusal that burned an order would leave `/results` with a
        // gap nobody can explain, and the lane seam retries the same op against the same payload.
        expect(rowOf(source.snapshot(), '513')).toBeNull();
        expect((source.snapshot() as { agentResults?: unknown[] }).agentResults ?? []).toEqual([]);

        const landed = source.archiveInvocation({ ...cancelledArchive, invocationId: '514', sequence: 4 });

        expect(landed.record.completedOrder).toBe(1);
        expect(rowOf(source.snapshot(), '514')).toEqual({
            invocationId: '514',
            sequence: 4,
            completedOrder: 1,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });

        // An absent pair stays absent — the pre-change payload is still a legal archive, and `''` is
        // a DIFFERENT claim that the reader would refuse. This is what lets an older lane keep
        // archiving while the field crosses the seam.
        const bare = source.archiveInvocation({
            invocationId: '515',
            sequence: 5,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });

        expect(bare.record.completedOrder).toBe(2);
        expect(rowOf(source.snapshot(), '515')).toEqual({
            invocationId: '515',
            sequence: 5,
            completedOrder: 2,
            agent: 'writer',
            rank: 'B',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            threadId: 'thread-9',
            // W19: the persisted row names its ledger generation.
            epoch: HARNESS_PROCESS_EPOCH
        });
    });
});

// ---------------------------------------------------------------------------
// DEFECT M1 (2026-11-17) — A RUNNING INVOCATION SAYS HOW LONG IT HAS BEEN RUNNING
// ---------------------------------------------------------------------------
//
// THE DEFECT. Both liveness doors answered `status: 'running'` with NO time fact at all. The
// ledger had no start stamp — `durationMs` is computed only on the TERMINAL transition
// (src/harness.ts `finishInvocation`) — `delegate` has no wall-clock bound by default
// (`DELEGATE_TIMEOUT_MS === +Infinity`, src/core/agent-limits.ts), and `pruneInvocationRecords`
// never evicts a running row. A run that started a second ago and a run parked for an hour were
// therefore the SAME bytes, so a caller polling a stalled child had nothing to decide on.
//
// THE REMEDY, AND ITS FENCE. `registerInvocation` now stamps `startedAt` on the in-memory record
// from `RunState.startedAt`, and BOTH doors project `startedAt` (epoch ms) plus `ageMs` (elapsed
// at READ time) on RUNNING rows only. `status` and every transition are untouched, and there is
// NO liveness/"stalled" key: a read-time liveness check would race the run's `finally` cleanup
// and has no cross-boundary source in lane/worker mode, where the canonical harness never sees
// the worker's live runs. Age alone is the observable fact at every boundary.
//
// WHY THE CLOCK IS FAKED AS `Date` ONLY. Every value below is then a pinned constant instead of
// a wall-clock approximation: the run starts at EPOCH_MS, the clock is moved by exactly AGED_MS,
// and the assertions demand exactly that delta. `toFake: ['Date']` leaves the macrotask queue
// REAL, which is what lets `pump` drain the run into the parked state. It also pins the terminal
// `durationMs` to the same delta, which is the proof that the live age and the terminal span
// measure from ONE stamp (`run.startedAt`) rather than from two clock reads.
describe('a running invocation reports when it started and how old it is (M1)', () => {
    // A fixed, arbitrary epoch. Nothing in the harness derives anything from its value.
    const EPOCH_MS = 1_760_000_000_000;
    // The one clock delta this block applies before reading an aged row.
    const AGED_MS = 45_000;

    // Parks a run inside a tool so its row stays `running` while both doors are read.
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((accept) => {
            resolve = accept;
        });
        return { promise, resolve };
    };

    // Real timers plus an explicit pump: the run is driven by draining the queue until the
    // roster says `running`, and the pump asserts its own condition, so a run that never starts
    // fails HERE instead of in an unrelated envelope assertion below.
    const pump = async (predicate: () => boolean, passes = 120): Promise<void> => {
        for (let index = 0; index < passes && !predicate(); index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(predicate()).toBe(true);
    };

    // A tool that never resolves on its own; the test opens it.
    const hangTool = (gate: { promise: Promise<string> }) =>
        tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

    // The ONE agent shape this block needs: first turn calls `hold`, second turn answers.
    const holder = () =>
        brain(
            routed((request) =>
                request.messages.some((message) => message.name === 'hold')
                    ? answer('quiet answer')
                    : callTool('h1', 'hold', '{}')
            )
        );

    // AC2 as a POSITIVE assertion. An exact `toEqual` would already fail if a key appeared, but
    // the claim under test is specifically "no non-running envelope gained THIS pair", so the
    // absence is demanded by name at every door.
    const expectNoAgeKeys = (envelope: unknown): void => {
        expect(envelope).not.toHaveProperty('startedAt');
        expect(envelope).not.toHaveProperty('ageMs');
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(EPOCH_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports startedAt and ageMs on a running result addressed by id, and on the agentManage row for the same run', async () => {
        const gate = deferred<string>();
        const writer = harness({ agents: { quiet: holder() }, tools: { hold: hangTool(gate) }, presets: false });

        const thread = writer.createThread('quiet');
        const running = writer.sendThreadInput(thread.id, 'hush');

        await pump(() => writer.thread(thread.id)?.status === 'running');

        // The clock moves by a KNOWN amount; every number below is that delta, never an approximation.
        vi.setSystemTime(new Date(EPOCH_MS + AGED_MS));

        // DOOR 1 — `agentResult` addressed by id. The pair joins the existing keys; every other
        // key, and `status: 'running'` itself, is byte-for-byte what it was.
        expect(await writer.executeTool('agentResult', { agent: 'quiet', invocationId: '1' })).toEqual({
            agent: 'quiet',
            invocationId: '1',
            kind: 'root',
            status: 'running',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            startedAt: EPOCH_MS,
            ageMs: AGED_MS
        });

        // DOOR 2 — `agentManage` at the same instant, from the same record. One map and one
        // derivation helper back both doors, so the two cannot name different ages for one run.
        const listed = (await writer.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
            totalResults: number;
            activeResults: number;
            truncated: boolean;
        };

        expect(listed.agents.find((entry) => entry.name === 'quiet')?.results).toEqual([
            {
                invocationId: '1',
                kind: 'root',
                status: 'running',
                contentLength: 0,
                preview: '',
                truncated: false,
                startedAt: EPOCH_MS,
                ageMs: AGED_MS
            }
        ]);
        expect([listed.totalResults, listed.activeResults]).toEqual([1, 1]);

        // `ageMs` is computed AT READ TIME, not stored: another 30_000 ms on the same frozen
        // clock moves the age and leaves the start stamp alone. A stored age would sit still and
        // tell every later poller the run froze at the moment it was first observed.
        vi.setSystemTime(new Date(EPOCH_MS + AGED_MS + 30_000));

        expect(await writer.executeTool('agentResult', { agent: 'quiet', invocationId: '1' })).toEqual({
            agent: 'quiet',
            invocationId: '1',
            kind: 'root',
            status: 'running',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            startedAt: EPOCH_MS,
            ageMs: AGED_MS + 30_000
        });

        gate.resolve('released');
        expect((await running).content).toBe('quiet answer');

        // AC3 + AC2 at the terminal end: the transition is unchanged, and the row is back to its
        // EXACT pre-M1 key set the moment it is no longer running — at BOTH doors.
        const completed = await writer.executeTool('agentResult', { agent: 'quiet' });

        expect(completed).toEqual({
            agent: 'quiet',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'quiet answer',
            contentLength: 12,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expectNoAgeKeys(completed);

        const settled = (await writer.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
            totalResults: number;
            activeResults: number;
        };

        expect(settled.agents.find((entry) => entry.name === 'quiet')?.results).toEqual([
            {
                invocationId: '1',
                kind: 'root',
                status: 'completed',
                contentLength: 12,
                preview: 'quiet answer',
                truncated: false
            }
        ]);
        expect([settled.totalResults, settled.activeResults]).toEqual([1, 0]);
    });

    it('leaves a failed, cancelled, and empty envelope at its exact pre-M1 key set', async () => {
        // FAILED. A transport error with retries off, so the run is ONE record and the envelope
        // below is the whole answer.
        const failing = harness({
            agents: {
                writer: brain(scripted([[{ type: 'error', message: 'transport exploded' }]]), { retry: false })
            },
            presets: false
        });

        await expect(failing('go')).rejects.toThrow('transport exploded');

        const failed = await failing.executeTool('agentResult', { agent: 'writer' });

        // `durationMs` is exact (not `expect.any(Number)`) because the clock is frozen and the
        // terminal span is measured FROM the same start stamp the live age used.
        //
        // `cancelledAtMessage` and `stopReason` on a FAILED (not cancelled) row are pre-existing:
        // `finishInvocation` writes the forensic pair on EVERY non-success transition, and
        // `HarnessDelegationResult.cancelledAtMessage` documents it as "when it was
        // cancelled/failed". Neither is an M1 key — the point of this assertion is that the pair
        // M1 added is absent here while the keys that were already here stay exactly as they were.
        expect(failed).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport exploded',
            stopReason: 'api-error',
            cancelledAtMessage: 1,
            durationMs: 0
        });
        expectNoAgeKeys(failed);

        // CANCELLED by the host, after a KNOWN span. This is the pairing that matters for AC2:
        // the row had an age while it ran, and the terminal envelope reports the SAME elapsed
        // number under its terminal key (`durationMs`) — never both.
        const gate = deferred<string>();
        const stopped = harness({ agents: { writer: holder() }, tools: { hold: hangTool(gate) }, presets: false });

        const thread = stopped.createThread('writer');
        const running = stopped.sendThreadInput(thread.id, 'go');

        await pump(() => stopped.thread(thread.id)?.status === 'running');
        vi.setSystemTime(new Date(EPOCH_MS + AGED_MS));

        expect(stopped.stopThread(thread.id, 'the host stopped it')).toBe(true);
        await expect(running).rejects.toThrow();

        const cancelled = await stopped.executeTool('agentResult', { agent: 'writer' });

        expect(cancelled).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'the host stopped it',
            stopReason: 'user-stopped',
            cancelledAtMessage: 1,
            durationMs: AGED_MS
        });
        expectNoAgeKeys(cancelled);

        // The listing row for that same cancelled run: terminal rows never carry the pair, which
        // is also the rule that keeps an ARCHIVED or RESTORED row (both terminal by construction,
        // and neither has a start stamp) at its historical shape.
        const listed = (await stopped.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
        };
        const [cancelledRow] = listed.agents.find((entry) => entry.name === 'writer')?.results ?? [];

        // The listing row for that same cancelled run (D1 + D2, 2026-11-26).
        //
        // D2 — the row now carries the CAUSE TRIO its own `agentResult` envelope has always
        // carried, projected from the same record: `error`, `stopReason`, and `durationMs` with
        // the SAME number the envelope reports (`AGED_MS`, because both are measured from the
        // run's own start stamp). A listing that showed a run died and told the caller nothing
        // about why is what sent the stress report's Rank B child back for another round trip.
        //
        // D1 — the text half stays `0 / '' / false` HERE, and that is the honest answer rather
        // than the old blanket zero: this run was stopped by `stopThread` before it committed
        // anything, so `finishInvocation`'s non-blank guard (~:4874) stored no `partialContent`
        // at all — which is exactly why the envelope above has no `partialContent` key either.
        // A cancelled run that HAD produced text is the other case, and it is pinned with an
        // exact clipped preview two tests below.
        //
        // The age pair stays absent at this door too: a terminal row's span is `durationMs`.
        expect(cancelledRow).toEqual({
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            contentLength: 0,
            preview: '',
            truncated: false,
            error: 'the host stopped it',
            stopReason: 'user-stopped',
            durationMs: AGED_MS
        });
        expectNoAgeKeys(cancelledRow);

        // EMPTY. `agentResult` with nothing finished at all is its own envelope shape, and it is
        // reached without an address at all — so it must not grow identity-free age keys either.
        const untouched = harness({
            agents: {
                writer: brain(scripted([answer('unused')])),
                fresh: brain(scripted([answer('unused')]))
            },
            presets: false
        });

        const empty = await untouched.executeTool('agentResult', { agent: 'fresh' });

        expect(empty).toEqual({
            agent: 'fresh',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expectNoAgeKeys(empty);
    });

    // D1 + D2 (2026-11-26, stress-report pass) — THE OTHER HALF OF THE TERMINAL ROW. The pin
    // above covers a terminal row with NO partial (`stopThread` before the first commit) and a
    // clock delta, so the trio's values are `0 / '' / false` plus a real `durationMs`. This one
    // is the case the defect named: a run that PRODUCED text and then failed, whose partial is
    // longer than the 200-char preview bound. Before the fix this row answered
    // `contentLength: 0, preview: '', truncated: false` while `agentResult` handed the same
    // caller all 300 characters — the listing hid the one fact a glance is for.
    it('previews and clips a long failed partial at the listing door, with the cause trio', async () => {
        // 180 + 120 = 300 chars of two distinct runs, so the exact CLIP POSITION is asserted,
        // not just "something shorter than the input": a preview one character off at the cut
        // is a different string. The stored text is untrimmed and has no leading or trailing
        // whitespace, so `contentLength` (the untrimmed answer, the completed branch's own
        // convention) is 300 while `preview` shows the trimmed form clipped at 200.
        const PARTIAL = `${'x'.repeat(180)}${'y'.repeat(120)}`;

        // The 0033 failed-run shape: ONE committed assistant text turn, then a throwing tool,
        // then the next request dies on the transport with `retry: false` so the whole run is
        // one record. Routing on the tool message keeps the two turns apart with no counter.
        const failing = harness({
            agents: {
                writer: brain(
                    routed((request) =>
                        request.messages.some((message) => message.role === 'tool')
                            ? [{ type: 'error', message: 'transport died mid-run' }]
                            : [{ type: 'text', delta: PARTIAL }, ...callTool('b1', 'boom', '{}')]
                    ),
                    { retry: false }
                )
            },
            tools: {
                boom: tool({
                    description: 'Fail loudly.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => {
                        throw new Error('tool exploded');
                    }
                })
            },
            presets: false
        });

        const thread = failing.createThread('writer');
        await expect(failing.sendThreadInput(thread.id, 'go')).rejects.toThrow('transport died mid-run');

        const listed = (await failing.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
        };
        const [failedRow] = listed.agents.find((entry) => entry.name === 'writer')?.results ?? [];

        expect(failedRow).toEqual({
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            contentLength: 300,
            // Exactly the first 200 code units of the trimmed partial (180 'x' + 20 'y'), plus
            // the ellipsis that marks the clip — the SAME `previewFieldsOf` lines the completed
            // branch runs, so the two doors cannot drift apart.
            preview: `${'x'.repeat(180)}${'y'.repeat(20)}…`,
            truncated: true,
            error: 'transport died mid-run',
            // The provider died mid-run, so the classifier stamped `api-error` — the same value
            // the envelope and the durable row carry for this run (0033's pins above).
            stopReason: 'api-error',
            // Exact, not `expect.any(Number)`: the clock is frozen at `EPOCH_MS`, so a run that
            // both began and ended under the frozen clock spans 0 ms — the same measurement the
            // failed envelope reports at :2977.
            durationMs: 0
        });

        // The pair the age clause reserves for RUNNING rows stays absent here even though the
        // row now carries three more keys, and `cancelledAtMessage` (a forensic field of the
        // envelope, never of the glance row) stays absent too.
        expectNoAgeKeys(failedRow);
        expect(failedRow).not.toHaveProperty('cancelledAtMessage');
        expect(failedRow).not.toHaveProperty('partialContent');

        // The two doors agree on ONE record, which is the claim D1 is worth: the listing's
        // `contentLength` is the envelope's, and the listing's `preview` is that same content
        // clipped — a caller that glances at `agentManage` and then reads `agentResult` is
        // looking at one answer, not two.
        expect(await failing.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'failed',
            content: PARTIAL,
            contentLength: 300,
            error: 'transport died mid-run',
            stopReason: 'api-error',
            durationMs: 0
        });
    });

    it('reports the pair on the parked run while the default door still answers the older completed run with none', async () => {
        // TWO runs of ONE agent: the first CONCLUDES, the second parks inside `hold`. This is the
        // shape a polling caller actually lives in, and it pins the two halves of the change
        // against each other: the by-id door reports the parked run's age, while the DEFAULT
        // selector (no `invocationId`) keeps handing back the older completed answer with its
        // exact pre-M1 key set — a running row in the same ledger adds nothing to it.
        const gate = deferred<string>();

        const agent = brain(
            routed((request) => {
                // Route on the BRIEF, so the parked run and the finished one are distinguishable
                // without a global call counter (the same trick the B2 block above uses).
                if (latestUser(request).includes('second')) {
                    return request.messages.some((message) => message.name === 'hold')
                        ? answer('second answer')
                        : callTool('h1', 'hold', '{}');
                }

                return answer('first answer');
            })
        );

        const writer = harness({ agents: { writer: agent }, tools: { hold: hangTool(gate) }, presets: false });

        const first = writer.createThread('writer');
        expect((await writer.sendThreadInput(first.id, 'first')).content).toBe('first answer');

        const settled = await writer.executeTool('agentResult', { agent: 'writer' });

        expect(settled).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'first answer',
            contentLength: 12,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expectNoAgeKeys(settled);

        const second = writer.createThread('writer');
        const running = writer.sendThreadInput(second.id, 'second');

        await pump(() => writer.thread(second.id)?.status === 'running');
        vi.setSystemTime(new Date(EPOCH_MS + AGED_MS));

        // The parked run, addressed: the pair, and nothing else changed.
        const parked = await writer.executeTool('agentResult', { agent: 'writer', invocationId: '2' });

        expect(parked).toEqual({
            agent: 'writer',
            invocationId: '2',
            kind: 'root',
            status: 'running',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            startedAt: EPOCH_MS,
            ageMs: AGED_MS
        });

        // The default door, with a running row in the same ledger: still the finished answer,
        // still no age keys, still the same selector the B2 block pins.
        const defaultAgain = await writer.executeTool('agentResult', { agent: 'writer' });

        expect(defaultAgain).toEqual(settled);
        expectNoAgeKeys(defaultAgain);

        // One listing, two rows, two different shapes — and the difference is exactly `status`.
        const listed = (await writer.executeTool('agentManage', {})) as {
            agents: { name: string; results: unknown[] }[];
            totalResults: number;
            activeResults: number;
        };

        expect(listed.agents.find((entry) => entry.name === 'writer')?.results).toEqual([
            {
                invocationId: '2',
                kind: 'root',
                status: 'running',
                contentLength: 0,
                preview: '',
                truncated: false,
                startedAt: EPOCH_MS,
                ageMs: AGED_MS
            },
            {
                invocationId: '1',
                kind: 'root',
                status: 'completed',
                contentLength: 12,
                preview: 'first answer',
                truncated: false
            }
        ]);
        expect([listed.totalResults, listed.activeResults]).toEqual([2, 1]);

        gate.resolve('released');
        expect((await running).content).toBe('second answer');
    });
});
