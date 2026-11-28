// toolList (R4 + defect F2): the live registry inventory, delivered as a PAGE.
//
// The result contains EVERY registered tool, enabled or not, and each row has
// EXACTLY `name` (+ `description` in the default projection). No tags, schema,
// enabled flag, or source is leaked: toolRequest is the grant and toolManage is the
// rich inspection surface.
//
// WHY THERE IS A PAGE ENVELOPE AT ALL. The registry's rows are usage contracts, not
// id lines: this repo's registry serializes at 62,536 payload bytes (measured,
// probe Temp/fix-f5/probe-tool-list-bytes.ts, after the records clamp disclosure grew
// the `records` row), against the
// 32,768-byte per-result delivery cap (./core/result-budget.ts:231), and
// `boundToolResult` REFUSES a JSON document it cannot fit
// (./core/result-budget.ts:559-578) — the whole inventory became a failed tool
// result, not a trimmed list. So the tool bounds its own answer, in the currency the
// cap is enforced in (`modelPayloadBytes`), and reports the cursor honestly. The
// assertions below are therefore of two kinds, and both matter:
//   - the SHAPE (envelope keys, projections, cursor semantics), pinned exactly;
//   - the DELIVERY VERDICT, measured through `boundToolResult` rather than estimated
//     by hand, plus the byte figures it is derived from. If a description grows, these
//     figures move LOUDLY instead of the result quietly turning into a refusal.
//
// Byte figures in this file are MEASURED (`modelPayloadBytes` of
// the serialized result), not counted by hand. They are stable because every
// registered description and schema is a literal in the generated
// ./core/tool-manifest.ts, so the same registry always produces the same bytes.
//
// The file also carries the `toolManage operation: "list"` page assertions, at the
// bottom: that operation is the same delivery defect with a larger payload, and its
// acceptance condition is a byte measurement against the same cap.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type { HarnessStream } from './index';
import {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    boundToolResult,
    modelPayloadBytes
} from './core';
// The generated catalogue is the needle source for the discovery-wording contract at
// the bottom of this file: it is what discovery scores (./core/discovery.ts scores the
// live Tool, whose description/tags come from this table for bundled tools).
import { BUILTIN_TOOL_DESCRIPTORS } from './core/tool-manifest';
import {
    TOOL_LIST_DEFAULT_LIMIT,
    TOOL_LIST_MAX_LIMIT,
    TOOL_LIST_PAGE_BUDGET_BYTES
} from './tools/runtime/toolList.tool';
import {
    TOOL_MANAGE_LIST_DEFAULT_LIMIT,
    TOOL_MANAGE_LIST_MAX_LIMIT,
    TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES
} from './tools/runtime/toolManage.tool';

const stream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const brain = () => agent({ model: 'test/model', stream });

// The harness-owned kernel rows, in REGISTRATION ORDER — the order `offset` counts
// in. `presets: false` keeps the catalogue to exactly these 16 rows, which is what
// makes the paging assertions below readable; the two fixture tools a test adds land
// after them, because registration order is insertion order.
const KERNEL_ROWS = [
    'toolRegistry',
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'records',
    'tasks',
    'profiles',
    'chapters',
    'locations',
    'knowledge',
    'agentManage',
    'agentResult',
    'threadFork',
    'sleep',
    'toolCancel'
];

// The registry is the source of the expected rows: a row's description IS the tool's
// registered description, so the assertion states the contract without freezing 2 KB
// of prose per row.
const rowsOf = (writer: ReturnType<typeof harness>, names: readonly string[]) =>
    names.map((name) => ({ name, description: writer.tools[name].description }));

// The measure the delivery cap is enforced in (./core/payload-bytes.ts:72). The
// harness serializes a non-string tool result with `JSON.stringify`
// (./harness.ts:1369-1373) and gates THAT text, so this is the number the provider
// pays for one toolList call.
const wireBytes = (value: unknown): number => modelPayloadBytes(JSON.stringify(value));

// A registry with two searchable fixtures, one enabled and one only registered, so a
// page can be checked against a known 18-row inventory.
const fixtureHarness = () =>
    harness({
        agents: { writer: brain() },
        presets: false,
        tools: {
            enabledFixture: tool({
                name: 'enabledFixture',
                description: 'Already enabled fixture.',
                tags: ['fixture'],
                execute: () => 'enabled'
            }),
            disabledFixture: tool({
                name: 'disabledFixture',
                description: 'Not enabled fixture.',
                tags: ['fixture'],
                execute: () => 'disabled'
            })
        }
    });

const FIXTURE_ROWS = [...KERNEL_ROWS, 'enabledFixture', 'disabledFixture'];

describe('toolList', () => {
    it('lists the default page of the live registry by name and description only', async () => {
        const writer = fixtureHarness();

        // Enable exactly one searchable fixture, leaving the other registered but
        // not enabled. toolList must still include both — listing never implies the
        // grant, and page 5 below is where the disabled one appears.
        await writer.executeTool('toolRequest', { names: ['enabledFixture'] });

        const result = await writer.executeTool('toolList', {});

        // Whole-object equality: the rows the default page carries plus the page envelope
        // that says where the rest is. `limit: 10` is the schema default, not a default the
        // caller asked for — and it is NOT what ends this page: the 24,576-byte page budget
        // stops it after 9 rows (`chapters`), so `budgetTruncated` is present and
        // `nextOffset: 9` is the index of the row the budget withheld. MEASURED, not chosen:
        // the `records` row alone is 6,928 description bytes, and the 10th row (`locations`)
        // is what no longer fits (probe Temp/fix-f5/probe-tool-list-bytes.ts).
        expect(result).toEqual({
            tools: rowsOf(writer, KERNEL_ROWS.slice(0, 9)),
            page: {
                offset: 0,
                limit: TOOL_LIST_DEFAULT_LIMIT,
                hasMore: true,
                nextOffset: 9,
                budgetTruncated: true
            }
        });

        // Every row is exactly the two allowed fields, and nothing else — no tags,
        // schema, `enabled`, or source leaks into an inventory row.
        for (const entry of (result as { tools: Record<string, unknown>[] }).tools) {
            expect(Object.keys(entry)).toEqual(['name', 'description']);
        }

        // The tail of the inventory: both fixtures are listed, whichever of them the
        // session enabled.
        const tail = (await writer.executeTool('toolList', { offset: 16 })) as {
            tools: { name: string; description: string }[];
            page: { offset: number; limit: number; hasMore: boolean };
        };

        expect(tail.tools).toEqual([
            { name: 'enabledFixture', description: 'Already enabled fixture.' },
            { name: 'disabledFixture', description: 'Not enabled fixture.' }
        ]);
        expect(tail.page).toEqual({ offset: 16, limit: TOOL_LIST_DEFAULT_LIMIT, hasMore: false });
    });

    it('is stable across enablement and reset()', async () => {
        const writer = harness({ agents: { writer: brain() }, presets: false });
        const before = await writer.executeTool('toolList', {});

        writer.reset();
        expect(await writer.executeTool('toolList', {})).toEqual(before);
    });

    it('states the paging contract in the schema, matching the bounds execute applies', () => {
        const properties = harness({ agents: { writer: brain() }, presets: false }).tools.toolList
            .parameters as Record<string, any>;

        // The model is told the real bounds. These numbers are also the ones `execute`
        // clamps to (./tools/runtime/toolList.tool.ts), and the schema has to carry
        // them as LITERALS: the manifest generator reads that file through the
        // TypeScript AST and never evaluates an imported identifier, so this pin is
        // what keeps the literal and the constant from drifting apart.
        expect(properties).toEqual({
            type: 'object',
            properties: {
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        'Zero-based row to start from, in registration order. Defaults to 0. Pass `page.nextOffset` back to get the next page; an offset past the end answers with no rows and `hasMore: false`.'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: TOOL_LIST_MAX_LIMIT,
                    description:
                        'Rows per page, 1-100 (default 10). A page is also byte-budgeted, so it can carry fewer rows than this - `page.budgetTruncated` says when it did.'
                },
                fields: {
                    type: 'string',
                    enum: ['name', 'name+description'],
                    default: 'name+description',
                    description:
                        'What each row carries. "name+description" (default) is the usage contract and costs the most bytes; "name" is the whole roster at a fraction of the size.'
                }
            },
            required: [],
            additionalProperties: false
        });

        // The defaults the schema advertises are the constants the implementation uses.
        expect(TOOL_LIST_DEFAULT_LIMIT).toBe(10);
        expect(TOOL_LIST_MAX_LIMIT).toBe(100);

        // THE LOAD-BEARING NUMBER (./core/records.ts:146-152, ./core/result-budget.ts:66-70):
        // the page budget stays STRICTLY UNDER the delivery cap, because an inner page
        // that reports `hasMore: false` while the outer envelope still cuts it is a lie
        // the model cannot detect. 24,576 leaves 8,192 bytes of headroom, the same
        // margin ./core/knowledge.ts:211 keeps.
        expect(TOOL_LIST_PAGE_BUDGET_BYTES).toBe(24 * 1024);
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES - TOOL_LIST_PAGE_BUDGET_BYTES).toBe(8 * 1024);
    });

    it('walks the whole registry with no gaps and no duplicates', async () => {
        const writer = fixtureHarness();
        const pages: { names: string[]; page: Record<string, unknown> }[] = [];

        let offset = 0;

        // A cursor loop of the shape a model runs: ask, read `nextOffset`, stop at
        // `hasMore: false`. `limit: 4` is deliberately small so the walk crosses the
        // registration-order seam between kernel rows and fixtures.
        for (;;) {
            const page = (await writer.executeTool('toolList', { offset, limit: 4 })) as {
                tools: { name: string }[];
                page: Record<string, unknown>;
            };

            pages.push({ names: page.tools.map((entry) => entry.name), page: page.page });

            if (!page.page.hasMore) break;

            offset = page.page.nextOffset as number;

            if (pages.length > FIXTURE_ROWS.length) throw new Error('the page walk did not terminate');
        }

        // Every page, exactly: the rows it carries AND the cursor it hands back. The
        // last page has `hasMore: false` and NO `nextOffset`, so a caller that obeyed
        // the envelope stops instead of asking for the same page forever.
        expect(pages).toEqual([
            {
                names: ['toolRegistry', 'toolRequest', 'toolList', 'toolManage'],
                page: { offset: 0, limit: 4, hasMore: true, nextOffset: 4 }
            },
            {
                names: ['toolCreate', 'records', 'tasks', 'profiles'],
                page: { offset: 4, limit: 4, hasMore: true, nextOffset: 8 }
            },
            {
                names: ['chapters', 'locations', 'knowledge', 'agentManage'],
                page: { offset: 8, limit: 4, hasMore: true, nextOffset: 12 }
            },
            {
                names: ['agentResult', 'threadFork', 'sleep', 'toolCancel'],
                page: { offset: 12, limit: 4, hasMore: true, nextOffset: 16 }
            },
            {
                names: ['enabledFixture', 'disabledFixture'],
                page: { offset: 16, limit: 4, hasMore: false }
            }
        ]);

        // The concatenation is the registry: every name once, none skipped, none twice,
        // in registration order.
        expect(pages.flatMap((page) => page.names)).toEqual(FIXTURE_ROWS);
    });

    it('projects rows to names only when fields is "name"', async () => {
        const writer = fixtureHarness();
        const result = (await writer.executeTool('toolList', {
            fields: 'name',
            limit: TOOL_LIST_MAX_LIMIT
        })) as { tools: Record<string, unknown>[]; page: Record<string, unknown> };

        // The whole 18-row roster in ONE page, and a row that carries exactly one key —
        // no empty `description` string to skip over. This is the cheap answer to "what
        // exists": 530 payload bytes for the fixture registry, 681 for the real one.
        expect(result.tools).toEqual(FIXTURE_ROWS.map((name) => ({ name })));
        expect(result.page).toEqual({ offset: 0, limit: TOOL_LIST_MAX_LIMIT, hasMore: false });

        for (const entry of result.tools) expect(Object.keys(entry)).toEqual(['name']);

        // The same page, asked for explicitly, is byte-identical to the default
        // projection MINUS the descriptions — i.e. `fields` is a projection, not a
        // different inventory.
        const full = (await writer.executeTool('toolList', {
            fields: 'name+description',
            limit: 3
        })) as { tools: Record<string, unknown>[] };

        expect(full.tools.map((entry) => entry.name)).toEqual(KERNEL_ROWS.slice(0, 3));
    });

    it('validates the paging arguments and still refuses unknown ones', async () => {
        const writer = fixtureHarness();

        // AC1: the new parameters are actually schema-gated, with the bound named in the
        // message, and `additionalProperties: false` is untouched. These are the exact
        // messages ./core/schema-validation.ts produces for this schema.
        const refusals: [Record<string, unknown>, string][] = [
            [{ offset: -1 }, '$.offset must be >= 0.'],
            [{ offset: 'x' }, '$.offset must be of type integer.'],
            [{ limit: 0 }, '$.limit must be >= 1.'],
            [{ limit: 101 }, '$.limit must be <= 100.'],
            [{ limit: 2.5 }, '$.limit must be of type integer.'],
            [{ fields: 'names' }, '$.fields must be one of: "name", "name+description".'],
            [{ page: 1 }, '$ must not include the additional property "page".']
        ];

        for (const [parameters, message] of refusals) {
            await expect(writer.executeTool('toolList', parameters)).rejects.toThrow(message);
        }

        // A call with NO arguments at all is still the default page — the defect was
        // partly that the advice in the refusal ("re-run with a smaller limit") was a
        // call the schema used to reject.
        await expect(writer.executeTool('toolList', {})).resolves.toMatchObject({
            page: { offset: 0, limit: TOOL_LIST_DEFAULT_LIMIT, hasMore: true }
        });
    });

    it('answers an offset past the end with an empty page and no cursor', async () => {
        const writer = fixtureHarness();

        // A caller paging to exhaustion asks for exactly one page too many. The answer
        // has to be terminal, not a re-issued page: no rows, `hasMore: false`, and no
        // `nextOffset` to follow. `offset` reports the clamped index the page starts at
        // (the registry length), which is the only case where it differs from the
        // cursor the caller sent.
        expect(await writer.executeTool('toolList', { offset: 999 })).toEqual({
            tools: [],
            page: { offset: FIXTURE_ROWS.length, limit: TOOL_LIST_DEFAULT_LIMIT, hasMore: false }
        });
    });

    it('sets budgetTruncated only when the byte cap, not limit, ended the page', async () => {
        const writer = fixtureHarness();

        // `limit: 100` asks for the whole registry. The 24,576-byte page budget stops
        // the page at 9 rows, and the envelope says so — while `nextOffset: 9` is the
        // index after the last row ACTUALLY carried, not `offset + limit`, which is the
        // mistake that would silently skip 16 tools.
        const forced = (await writer.executeTool('toolList', { limit: TOOL_LIST_MAX_LIMIT })) as {
            tools: { name: string }[];
            page: Record<string, unknown>;
        };

        expect(forced.tools.map((entry) => entry.name)).toEqual(KERNEL_ROWS.slice(0, 9));
        expect(forced.page).toEqual({
            offset: 0,
            limit: TOOL_LIST_MAX_LIMIT,
            hasMore: true,
            nextOffset: 9,
            budgetTruncated: true
        });
        // The cap it stopped under, and the whole serialized result at that point. The
        // figure moved from 24,522 when the page carried 10 rows: the budget is what
        // decides the row count, so one longer description moves the CUT, not the budget.
        // F9 (2026-11-25): +1,266 (3 rows x 422) because the `tasks`/`profiles`/`chapters`
        // descriptions now state the producer budget and the serve-time delivery cap as the
        // F11 (2026-11-26): +379 — the same sentences were reworded again (the single-id ceiling and the
        // withheld-field disclosure in `tasks`/`profiles`/`chapters`/`records`), and this figure is the
        // sum of those rows as they now ship. The CUT still ends at row 9, and the page now sits 55
        // bytes under the 24,576-byte budget: the next growth on a row in THIS page moves the cut.
        // two separate bounds they are (see the matching note in those entries). The CUT did
        // not move: this page still ends at row 9, which is why the row-list assertion above
        // is untouched and only the byte total of those rows changed.
        expect(wireBytes(forced)).toBe(24521);
        expect(wireBytes(forced)).toBeLessThanOrEqual(TOOL_LIST_PAGE_BUDGET_BYTES);

        // The other direction of the same honesty: a page that is short because of
        // `limit` carries NO `budgetTruncated` key at all. A caller told "raise your
        // limit" for a page the byte cap cut is told to do something that changes
        // nothing.
        const byLimit = (await writer.executeTool('toolList', { limit: 2 })) as {
            tools: { name: string }[];
            page: Record<string, unknown>;
        };

        expect(byLimit.tools.map((entry) => entry.name)).toEqual(['toolRegistry', 'toolRequest']);
        expect(byLimit.page).toEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2 });
        expect('budgetTruncated' in byLimit.page).toBe(false);
    });

    it('keeps a default page of THIS repo\'s real registry inside the delivery cap', async () => {
        // The registry a session actually gets: `harness({})` with the bundled presets,
        // which is the 26-row case the defect was reported on.
        const writer = harness({ agents: { writer: brain() } });
        const registry = writer.runtime.listTools();

        expect(registry.map((entry) => entry.name).length).toBe(26);

        // THE PREMISE, measured rather than asserted in prose: the bare array this tool
        // used to return is over the cap, and `boundToolResult`'s answer to that is a
        // REFUSAL (`oversized-json`), not a truncated page — the "81266 bytes against a
        // 32768-byte budget … discarded, not truncated" of the stress run.
        // F9 (2026-11-25): +1,688 (4 rows x 422) — the four record-wrapper descriptions grew
        // F11 (2026-11-26): +790 — the same four wrapper descriptions plus `records` and `agentManage`/
        // `agentResult` were reworded; measured on the registry this assertion enumerates.
        // 0032 (2026-11-26): +484 payload bytes (+476 UTF-8), and the move is ONE row: `agentResult`,
        // whose entry description now names the `toolActivity` tally — the counts, the up-to-8 name list
        // and the counts-and-names-only boundary — so a caller learns the field exists before it asks.
        // F1 (2026-11-26, independent audit of the 0032 pass): +69, and again ONE row — `toolCancel`, whose
        // abandoned-call enumeration now names the fourth forensic field that really rides that envelope
        // (`toolActivity`, cap stated) instead of promising three. This clause carries NO quote and no
        // backslash, so it is +69 in both currencies at once: the payload figure here and the UTF-8 figure
        // in the refusal below move by the identical amount, unlike 0032's sentence above.
        // A per-tool diff of the generated manifest against HEAD names four changed strings in TWO tools,
        // and only the `agentResult` pair can land in THIS document: `delegate`'s text grew too (+537 entry
        // (+529 UTF-8) — the four escaped quotes in 0032's sentence are the difference — and +299
        // `timeoutMs`, that one the same in both currencies because the advisory carries no quote), but
        // `delegate` is registered only for an agent that has a lower-ranked
        // peer (`./harness.delegation.test.ts` — "declares delegate only to the agent that has a
        // lower-ranked peer"), so it is not one of these 26 rows; `KERNEL_ROWS` at :66 above carries no
        // `delegate` for the same reason.
        // C2 (2026-11-26, over-cap `threadFork` delivery): +434, and again exactly ONE row — `threadFork`'s
        // description now states the delivery cap its summary has to fit (../tools/runtime/threadFork.tool.ts).
        // The added text carries no `"` and no `\`, so both currencies move by the identical 434 and the
        // 912-byte gap between them is untouched (66,001 payload / 65,089 UTF-8, both re-probed with
        // `Temp/fix-f5/probe-tool-list-bytes.ts`, not derived).
        // F1 (2026-11-27, the branch write doors): +991, and it is TWO rows — `threadFork` +664 (the
        // description now states that the fork's isolation is ENFORCED: `threadSend`, `delegate` and
        // `threadDelete` refuse a branch run unless the fork passed `allowFamilyWrites`) and
        // `toolCancel` +327 (the fail sentence and its `callId` parameter now name the `branch-N`
        // address this door also accepts). Neither clause carries a `"` or a `\`, so BOTH currencies
        // move by the identical 991 and the 912-byte gap between them is STILL untouched
        // (66,992 payload / 66,080 UTF-8, re-probed row by row with `Temp/opencode/probe-row-deltas.ts`
        // against `Temp/opencode/baseline` at HEAD, not derived). The `thread` parameter copies this
        // finding also added to `threadSend` and `threadDelete` move nothing here: neither tool is one
        // of these 26 rows, for the same registration reason `delegate` is not.
        // C0 (2026-11-27, addressable agent answers): +1,384, and exactly ONE row again — `agentResult`
        // (4,175 -> 5,559), whose entry description now states WHICH message the answer is
        // (`answerMessageIndex`) and that the run's other substantive turns are readable as
        // `answerCandidates` / `message`. Re-probed row by row the same way (baseline 65,089 UTF-8 /
        // 66,001 payload at `e66bce8`, live 67,416 / 68,376), and the only other movers in that diff
        // are the `threadFork` +664 and `toolCancel` +327 rows F1 already recorded above.
        // R1 (2026-11-27, the `agentManage` answer-address sentence): +339, ONE row — `agentManage`
        // 2,510 -> 2,849 UTF-8 bytes (measured on the entry's own `metadata.description`, and it is
        // one of these rows even though it is `visibility: 'searchable'`, because this document is the
        // registered catalogue, not the declared one). The sentence carries no `"` and no `\`, so both
        // currencies move by the identical 339 and the 960-byte gap C0 opened is untouched
        // (68,715 payload / 67,755 UTF-8, re-probed, not derived). The `thread` parameter dash this
        // pass restored in `threadSend` (+2 B) moves NOTHING here: `threadSend` is not one of these
        // rows, for the same registration reason `delegate` and `threadDelete` are not.
        // T6 (2026-11-28, the budget-currency alignment wave): +714, FOUR rows — `files` +137,
        // `glob` +141 and `grep` +183 (their result-budget clauses now name the 32 KiB delivery budget
        // and the ESCAPED-payload currency the cap is enforced in, ../tools/files/*.tool.ts) and
        // `download` +253 (the SSRF/redirect-chain sentence plus the session-downloads `path` wording
        // in the entry description, ../tools/webdownload/download.tool.ts). `threadRead` moved too but
        // is not one of these 26 rows, the same registration fact recorded for `threadSend` above. No
        // added clause carries a `"` or a `\`, so BOTH currencies move by the identical 714 and the
        // 960-byte gap is STILL untouched (69,429 payload / 68,469 UTF-8, attributed row by row against
        // the HEAD catalogue snapshot with `Temp/t6-integration/probe-bytes.ts`, sums agreeing to the
        // byte, not derived).
        // T8 (2026-11-28, review-gated correction): +188, ONE row again — `download`. Its entry
        // description stopped claiming "loopback, private and RESERVED addresses are refused" and now
        // names the ranges the gate actually implements (RFC1918, CGNAT 100.64/10, link-local, the
        // metadata IP, and the notations the decode reaches); `224.0.0.1` / `240.0.0.1` /
        // `255.255.255.255` / `192.0.2.1` are allowed by that gate, and "reserved" claimed otherwise.
        // 1,183 -> 1,371 UTF-8 bytes on `DOWNLOAD_METADATA.description`, measured against the pre-edit
        // string with `Temp/t8-fixes/probe3.py` (which also asserts neither new clause carries a `"`
        // or a `\`, so the escaped and UTF-8 currencies move by the identical 188 and the 960-byte gap
        // this file tracks is untouched). The `url` parameter leg this pass also reworded does NOT
        // ride in this document — it is the +77 in the details figure below.
        // by the same sentence (producer budget vs serve-time delivery cap). Still the same
        // fact this assertion exists for: the bare array is over the delivery cap.
        expect(wireBytes(registry)).toBe(69617);

        const bare = boundToolResult(JSON.stringify(registry));

        expect(bare.truncated).toBe(false);
        expect(bare.rejected).toEqual({
            reason: 'oversized-json',
            // 0032 (2026-11-26): +476 here against +484 above — the SAME document measured by two rules,
            // and the arithmetic is the point. `originalBytes` is UTF-8 bytes of the serialized text
            // (./core/result-budget.ts:300); `wireBytes` is model-facing payload bytes, which charge every
            // `"` and `\` TWICE (./core/payload-bytes.ts:75-86). The new sentence adds four escaped
            // quotes (manifest line: 24 `\"` pairs at HEAD, 28 now), so each costs 2 bytes here and 4
            // there: 476 + 4x2 = 484 exactly. The refusal message below quotes the smaller figure, so
            // the two numbers had to move together.
            // F1 (2026-11-26, audit): +69 in BOTH figures at once — `toolCancel`'s added clause has no
            // quote and no backslash, so nothing doubles and the 912-byte gap between the two currencies
            // is untouched (65,567 payload / 64,655 UTF-8, both re-probed, not derived).
            // C2 (2026-11-26): +434 in both figures again, from the one `threadFork` row recorded above, and
            // the gap is STILL 912 (66,001 / 65,089) — the new sentence escapes to itself.
            // F1 (2026-11-27): +991 in both figures, from the `threadFork` and `toolCancel` rows recorded
            // above — neither clause escapes to anything wider, so 66,992 payload / 66,080 UTF-8 keeps the
            // same 912-byte gap. The message below quotes this smaller figure, so both moved together.
            // C0 (2026-11-27): +1,336 here against +1,384 above, and the SPLIT is the point — this is the
            // first move in this chain whose new text carries escaped quotes (`"answerMessageIndex"`,
            // `"answerCandidates"`, `"message"`, `"messageIndex"`, `"truncated"`). 48 of the added
            // characters are `"`, 1 byte in UTF-8 and 2 in the payload currency, so the two figures
            // separate by 48 and the gap they used to keep moves from 912 to 960 (68,376 / 67,416, both
            // re-probed with `Temp/opencode/probe-row-deltas.ts`, not derived). The message below quotes
            // this smaller figure, so both moved together.
            // R1 (2026-11-27): +339 in BOTH figures — the one `agentManage` row recorded above, whose
            // added sentence has no quote and no backslash, so nothing doubles and the 960-byte gap
            // C0 opened is untouched (68,715 payload / 67,755 UTF-8, both re-probed, not derived).
            // T6 (2026-11-28): +714 in BOTH figures — the four `files`/`glob`/`grep`/`download` rows
            // recorded above, none of which added an escaped character, so the 960-byte gap is
            // untouched again (69,429 payload / 68,469 UTF-8, both re-probed with
            // `Temp/t6-integration/probe-bytes.ts`, not derived).
            // T8 (2026-11-28, review-gated correction): +188 in BOTH figures — the one `download`
            // description row recorded above, and `Temp/t8-fixes/probe3.py` asserts the reworded
            // sentences contain no `"` and no backslash, so nothing doubles and the 960-byte gap C0
            // opened is still untouched (69,617 payload / 68,657 UTF-8). The message below quotes
            // this smaller figure, so both moved together.
            originalBytes: 68657,
            budgetBytes: MODEL_TOOL_RESULT_BUDGET_BYTES,
            // The message text belongs to ./core/result-budget.ts (`refusalMessage`), which is not
            // this change's file, so only the figures it quotes are pinned here — and
            // they are worth pinning, because the advice it names ("smaller limit,
            // fewer ids, narrower fields") is the advice this schema used to REFUSE and
            // now implements.
            message: expect.stringContaining('68657 bytes against a 32768-byte budget')
        });
        expect(bare.rejected!.message).toContain('discarded, not truncated');

        // C2 (2026-11-26): THE NON-HANDLE HALF, pinned where the document is the biggest one this
        // package has. The registry is a JSON ARRAY, and the retained-handle clause in
        // ./core/result-budget.ts (`retainedHandleOf`) only fires on an OBJECT carrying `branchId` or
        // `invocationId` — so this refusal keeps the historical "narrow the arguments and re-run"
        // sentence, which is right here because a `toolList` row set really is refetchable by
        // `offset`/`limit`/`fields`. Pinned whole rather than as a fragment: a handle rule that
        // leaked into non-handle documents fails on this line, not somewhere quieter.
        expect(bare.rejected!.message).toContain(
            'Re-run the tool call with narrower arguments (smaller limit, fewer ids, narrower fields) to fetch it.'
        );

        // THE FIX, measured the same way. A default page is under the producer budget
        // AND under the cap, and the harness's own gate delivers it whole:
        // `truncated: false`, no `rejected`.
        const page = (await writer.executeTool('toolList', {})) as {
            tools: { name: string; description: string }[];
            page: Record<string, unknown>;
        };

        expect(page.tools.map((entry) => entry.name)).toEqual(KERNEL_ROWS.slice(0, 9));
        expect(page.page).toEqual({
            offset: 0,
            limit: 10,
            hasMore: true,
            nextOffset: 9,
            budgetTruncated: true
        });
        // F9 (2026-11-25): +1,266 (3 of these 9 rows x 422) — `tasks`/`profiles`/`chapters`
        // carry the corrected budget sentence. The CUT is unchanged (rows 0-8, `nextOffset: 9`),
        // which is the point of the two assertions above.
        expect(wireBytes(page)).toBe(24520);
        expect(wireBytes(page)).toBeLessThan(MODEL_TOOL_RESULT_BUDGET_BYTES);

        const delivered = boundToolResult(JSON.stringify(page));

        expect(delivered.truncated).toBe(false);
        expect(delivered.rejected).toBeUndefined();
        expect(delivered.content).toBe(JSON.stringify(page));

        // And the cursor is truthful for THIS registry: three default pages are the
        // whole inventory, exactly once each, ending with no cursor.
        const walked: string[] = [];

        let offset = 0;

        for (;;) {
            const next = (await writer.executeTool('toolList', { offset })) as {
                tools: { name: string }[];
                page: { hasMore: boolean; nextOffset?: number };
            };

            walked.push(...next.tools.map((entry) => entry.name));

            if (!next.page.hasMore) break;

            offset = next.page.nextOffset as number;

            if (walked.length > registry.length) throw new Error('the real-registry walk did not terminate');
        }

        expect(walked).toEqual(registry.map((entry) => entry.name));

        // `fields: "name"` is the one-call answer for a registry this size: the whole
        // 26-row roster, `hasMore: false`, at 681 bytes.
        const names = (await writer.executeTool('toolList', {
            fields: 'name',
            limit: TOOL_LIST_MAX_LIMIT
        })) as { tools: { name: string }[]; page: Record<string, unknown> };

        expect(names.tools).toEqual(registry.map((entry) => ({ name: entry.name })));
        expect(names.page).toEqual({ offset: 0, limit: TOOL_LIST_MAX_LIMIT, hasMore: false });
        expect(wireBytes(names)).toBe(681);
    });
});

// `toolManage operation: "list"` was the suggested workaround for the defect above,
// and it is the SAME defect with a bigger payload: each row is a `toolDetailsFor` row
// (./harness.ts:3220-3273) carrying the tool's whole `parameters` JSON Schema, so the
// un-paged answer is more than twice the size of the un-paged toolList. It is asserted
// HERE, next to the toolList delivery measurements, because the acceptance condition is
// identical — "the answer reaches the model" — and the byte figures only mean something
// measured against the same cap in the same currency.
//
// Everything else toolManage does is pinned by ./harness.tool-folders.test.ts
// (create/update/source/path/reload) and ./harness.discovery.test.ts
// (enable/disable/remove); those shapes are untouched here.
describe('toolManage list paging', () => {
    it('pages the details inventory and stays inside the delivery cap', async () => {
        const writer = harness({ agents: { writer: brain() } });

        // THE PREMISE: the un-paged `{ tools: [...] }` the runtime answers is the
        // largest tool result in this area of the catalogue, and the harness gate
        // refuses it outright.
        const unpaged = writer.runtime.manageTool(undefined, { operation: 'list' });

        // F9 (2026-11-25): +1,688 (4 rows x 422) — the four record-wrapper descriptions grew
        // F11 (2026-11-26): +1,248 — every reworded description this document carries; the document is
        // further over the cap than before, which is the fact this pin protects.
        // 0032 (2026-11-26): +794 — the same single `agentResult` row as the registry figure above, in
        // DETAILS form, which is why the number is bigger: a details row also carries the SCHEMA, and this
        // tool's `offset` parameter text grew with the past-the-end clamp sentence (+310 payload bytes on
        // top of the entry description's +484). `delegate` is absent from this document for the peer-gate
        // reason recorded in the registry case above, so its own +537/+299 (+529/+299 in UTF-8 — only
        // 0032's four escaped quotes differ) does not appear in either figure.
        // F1 (2026-11-26, audit): +69, the same `toolCancel` clause as above — this document carries that
        // row too, and the clause has no escaped character, so one number covers both currencies.
        // C2 (2026-11-26): +434, the same single `threadFork` row as the registry figure above — DETAILS
        // form carries the same description, and its SCHEMA text did not move (the cap lives in the
        // entry description, not in a parameter). 139,050 -> 139,484, re-probed.
        // F1 (2026-11-27): +1,925, and here the SCHEMA moves too, which is why this document grows more
        // than the registry does: `threadFork` +1,426 (the enforcement sentence +664 plus the new
        // `allowFamilyWrites` parameter) and `toolCancel` +499 (the fail sentence +327 plus its widened
        // `callId` parameter). 139,484 -> 141,409, re-probed with `Temp/opencode/probe-row-deltas.ts`.
        // C0 (2026-11-27): +2,065, ONE row again — `agentResult` 5,500 -> 7,565 — and the split against
        // the +1,384 in the registry above is the schema leg: the details inventory serializes the whole
        // `parameters` object, so the new `message` property (its type, bounds and the ordinal-vs-index
        // sentence that keeps a caller from passing a transcript index) rides here and not there.
        // Re-probed row by row the same way; the totals agree to the byte (143,462 + the 12-byte
        // envelope this assertion counts = 143,474).
        // R1 (2026-11-27): +339, ONE row again — `agentManage`'s entry description, the same sentence
        // priced in the registry above. Its DETAILS form carries the same description, and this pass
        // added no parameter, so the schema leg did not move and the two documents grew by the identical
        // 339 (143,474 -> 143,813, re-probed against this tree, not derived).
        // T6 (2026-11-28, the budget-currency alignment wave): +935 = the +714 of entry descriptions the
        // registry figure above already counts (`files` +137, `glob` +141, `grep` +183, `download` +253)
        // PLUS this document's schema leg: `download`'s `url` parameter (the private-address sentence)
        // and `path` parameter (the session-downloads wording) add +221 on the details side alone, which
        // is why the two documents moved by different amounts. `glob`/`grep`/`files` added no parameter
        // text, and `threadRead` again is not one of these rows. 143,813 -> 144,748, attributed row by
        // row against the HEAD catalogue with `Temp/t6-integration/probe-bytes.ts`, not derived.
        // T8 (2026-11-28, review-gated correction): +265 = the +188 of `download`'s entry description
        // that the registry figure above already counts, PLUS this document's schema leg — the
        // reworded private-address sentence in `download`'s `url` parameter, 185 -> 262 UTF-8 bytes
        // (+77). `path` gained only a source comment, which is trivia and serializes nowhere, and no
        // new clause carries a `"` or a `\`, so both currencies move by the identical 265 and the
        // 960-byte gap is untouched. 144,748 -> 145,013, measured against the pre-edit strings with
        // `Temp/t8-fixes/probe3.py` — and the failing pin agreed to the byte before it was re-anchored,
        // which is the attribution.
        // by the same sentence (producer budget vs serve-time delivery cap). The refusal below
        // is what this pin protects, and a bigger document is still refused.
        expect(wireBytes(unpaged)).toBe(145013);
        expect(boundToolResult(JSON.stringify(unpaged)).rejected?.reason).toBe('oversized-json');

        // THE FIX: the default page is 5 rows, well inside both budgets, and the gate
        // hands it over whole.
        const page = (await writer.executeTool('toolManage', {
            operation: 'list'
        })) as { tools: Record<string, unknown>[]; page: Record<string, unknown> };

        expect(page.tools.map((row) => row.name)).toEqual(KERNEL_ROWS.slice(0, 5));
        expect(page.page).toEqual({
            offset: 0,
            limit: TOOL_MANAGE_LIST_DEFAULT_LIMIT,
            hasMore: true,
            nextOffset: 5
        });
        expect(wireBytes(page)).toBe(14661);
        expect(wireBytes(page)).toBeLessThan(MODEL_TOOL_RESULT_BUDGET_BYTES);

        const delivered = boundToolResult(JSON.stringify(page));

        expect(delivered.truncated).toBe(false);
        expect(delivered.rejected).toBeUndefined();

        // A `list` row is still a complete details row — paging must not have quietly
        // projected it. The row equals the runtime's own `details` answer for the same
        // name, key for key.
        expect(page.tools[5 - 1]).toEqual(
            writer.runtime.manageTool(undefined, { operation: 'details', name: 'toolCreate' })
        );

        // Walking the real registry: every tool exactly once, in registration order.
        const walked: string[] = [];

        let offset = 0;

        for (;;) {
            const next = (await writer.executeTool('toolManage', {
                operation: 'list',
                offset,
                limit: TOOL_MANAGE_LIST_DEFAULT_LIMIT
            })) as { tools: { name: string }[]; page: { hasMore: boolean; nextOffset?: number } };

            walked.push(...next.tools.map((row) => row.name));

            if (!next.page.hasMore) break;

            offset = next.page.nextOffset as number;

            if (walked.length > 40) throw new Error('the toolManage page walk did not terminate');
        }

        expect(walked).toEqual(writer.runtime.listTools().map((entry) => entry.name));
    });

    it('reports the byte cap and the limit apart, and leaves other operations alone', async () => {
        const writer = harness({ agents: { writer: brain() }, presets: false });

        // The schema bounds are declared, not implied, and the budget literal sits under
        // the cap by the same 8 KiB margin toolList keeps (./core/records.ts:146-152).
        const properties = writer.tools.toolManage.parameters as Record<string, any>;

        expect(properties.properties.offset).toMatchObject({ type: 'integer', minimum: 0 });
        expect(properties.properties.limit).toMatchObject({
            type: 'integer',
            minimum: 1,
            maximum: TOOL_MANAGE_LIST_MAX_LIMIT
        });
        expect(TOOL_MANAGE_LIST_DEFAULT_LIMIT).toBe(5);
        expect(TOOL_MANAGE_LIST_MAX_LIMIT).toBe(100);
        expect(TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES).toBe(24 * 1024);
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES - TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES).toBe(8 * 1024);

        // `limit: 100` on the real registry asks for all 26 rows and gets 5, flagged.
        // The cursor is the index after the last row carried, not `offset + limit`.
        const forced = (await writer.executeTool('toolManage', {
            operation: 'list',
            limit: TOOL_MANAGE_LIST_MAX_LIMIT
        })) as { tools: { name: string }[]; page: Record<string, unknown> };

        expect(forced.tools.map((row) => row.name)).toEqual(KERNEL_ROWS.slice(0, 5));
        expect(forced.page).toEqual({
            offset: 0,
            limit: TOOL_MANAGE_LIST_MAX_LIMIT,
            hasMore: true,
            nextOffset: 5,
            budgetTruncated: true
        });
        expect(wireBytes(forced)).toBe(14688);
        expect(wireBytes(forced)).toBeLessThanOrEqual(TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES);

        // A page short because of `limit` carries no `budgetTruncated`.
        const byLimit = (await writer.executeTool('toolManage', {
            operation: 'list',
            offset: 3,
            limit: 2
        })) as { tools: { name: string }[]; page: Record<string, unknown> };

        expect(byLimit.tools.map((row) => row.name)).toEqual(['toolManage', 'toolCreate']);
        expect(byLimit.page).toEqual({ offset: 3, limit: 2, hasMore: true, nextOffset: 5 });
        expect('budgetTruncated' in byLimit.page).toBe(false);

        // Paging keys are inert for every other operation, and those shapes do not move:
        // `details` with a `limit` attached is byte-identical to `details` without one.
        const details = (await writer.executeTool('toolManage', {
            operation: 'details',
            name: 'toolList'
        })) as Record<string, unknown>;
        const detailsWithPaging = (await writer.executeTool('toolManage', {
            operation: 'details',
            name: 'toolList',
            offset: 4,
            limit: 1
        })) as Record<string, unknown>;

        expect(detailsWithPaging).toEqual(details);
        expect(details.name).toBe('toolList');
        expect(details).not.toHaveProperty('page');

        // `operation` stays REQUIRED: a bare `{}` is a refusal, exactly as it was before
        // paging, and the `{ operation: 'list' }` fallback in
        // ./tools/runtime/toolManage.tool.ts only covers a call that arrives with NO
        // parameters object at all. Adding optional paging keys must not have relaxed
        // the one required key the rest of the surface depends on.
        await expect(writer.executeTool('toolManage', {})).rejects.toThrow('$.operation is required.');

        // An unknown paging-style key is still refused (`additionalProperties: false` is
        // untouched), which is what makes `offset`/`limit` a contract rather than a
        // suggestion that used to be a schema error.
        await expect(
            writer.executeTool('toolManage', { operation: 'list', page: 1 })
        ).rejects.toThrow('$ must not include the additional property "page".');
        await expect(writer.executeTool('toolManage', { operation: 'list', limit: 0 })).rejects.toThrow(
            '$.limit must be >= 1.'
        );
    });
});

// ---------------------------------------------------------------------------
// The wording is part of the delivery contract (defect F2, AC 5)
// ---------------------------------------------------------------------------
//
// A reworded description is not free text. The discovery scorer charges a >=3-char
// NAME or DESCRIPTION substring 1 point (./core/discovery.ts:128-141), and ANY score
// above 0 puts a searchable row into `toolRequest.enabled` inside the 5-match cap
// (./core/discovery.ts:93). This repo proved it the hard way while fixing F2: a draft
// sentence that said "a page at a time" made `toolList` answer the `{tags:["time"]}`
// round scripted in ../server/api.test.ts:2807 — "at a time" contains "time" — and
// moved that recorded enabled set.
//
// So the invariant is MEASURED rather than hoped for. For each row this change
// reworded, the set of registry capability tags its description contains — minus the
// tags that row already owns, which it answers at tag strength regardless — must be
// EXACTLY the set the pre-F2 sentence contained. Equality, both directions: a reword
// that DROPS a tag the row used to answer is a routing change too. The expected sets
// are measured, so an unexpected hit fails with the offending tag named.
const PRE_F2_DESCRIPTIONS: Record<string, string> = {
    // `git show HEAD:src/engine/tools/runtime/toolList.tool.ts` / …/toolManage.tool.ts
    // as of the F2 fix (2026-11-25). They are pinned here as the routing baseline: if a
    // deliberate reword later changes what these rows answer, this assertion is the
    // place that decision has to be made, and the recorded discovery rounds in
    // ../server/api.test.ts are the reason it cannot be made silently.
    toolList:
        'List every registered tool by name and description, whether or not toolRequest has enabled it. Use this for an inventory; use toolRequest to make searchable tools callable, and toolManage for tags, schema, source, or editing.',
    toolManage:
        'Inspect and edit registered tools. `list` returns registry metadata, `details` inspects one tool, `source` returns its captured module text and local dependencies, `path` resolves a tool source path or a candidate path inside the configured toolFolders, `create` and `update` register a module and, by default, persist it: `create` writes a safe `<name>.tool.ts` filename in the LAST configured toolFolders entry, and `update` rewrites the tool\'s owning source path (an explicit `path` overrides either). Set `persist: "runtime"` to opt out of disk writes explicitly; that mode keeps the module in this session\'s registry only and cannot be combined with `path` or `folder`. `reload` recompiles the installed source revision. Every mutation is validated and published atomically through the same kernel as toolCreate/toolRegistry; a failed compile leaves the previous tool registered. Loaded tool code runs with this process\'s full permissions - there is no sandbox.'
};

describe('tool description discovery contract', () => {
    // The needle set discovery can receive: every capability tag any bundled descriptor
    // advertises (./core/tool-manifest.ts is the generated catalogue discovery scores).
    const vocabulary = [
        ...new Set(BUILTIN_TOOL_DESCRIPTORS.flatMap((entry) => entry.metadata.tags.map((tag) => String(tag).toLowerCase())))
    ];

    // Tags a description answers WITHOUT owning them — the only ones a reword can add.
    const answeredTags = (name: string, text: string): string[] => {
        const own = new Set(
            (BUILTIN_TOOL_DESCRIPTORS.find((entry) => entry.name === name)?.metadata.tags ?? []).map((tag) =>
                String(tag).toLowerCase()
            )
        );
        const lower = text.toLowerCase();

        return vocabulary
            .filter((tag) => tag.length >= 3 && lower.includes(tag) && !own.has(tag))
            .sort();
    };

    it('answers exactly the capability tags the pre-paging sentences answered', () => {
        const writer = harness({ agents: { writer: brain() } });

        // MEASURED on this registry — the full list, so the tag that breaks the rule is
        // named by the diff rather than hidden behind a boolean.
        expect(answeredTags('toolList', writer.tools.toolList.description)).toEqual([
            'edit',
            'manage',
            'search',
            'source',
            'tool'
        ]);
        expect(answeredTags('toolManage', writer.tools.toolManage.description)).toEqual([
            'code',
            'compile',
            'create',
            'file',
            'folder',
            'inspect',
            'list',
            'process',
            'registry',
            'time',
            'tool',
            'write'
        ]);

        // And the same sets the pre-F2 sentences produced: the paging wording added
        // NOTHING (this is also why `time` is absent from `toolList` — the row must not
        // answer the recorded `{tags:["time"]}` round in ../server/api.test.ts:2807).
        for (const name of ['toolList', 'toolManage'] as const) {
            expect(answeredTags(name, writer.tools[name].description)).toEqual(
                answeredTags(name, PRE_F2_DESCRIPTIONS[name])
            );
        }
    });
});
