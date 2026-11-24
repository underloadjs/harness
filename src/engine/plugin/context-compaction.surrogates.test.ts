// The `context-compaction` shrink's surrogate pairing (T3, 2026-11-24, the lone-surrogate
// provider defect) — the two cuts `planCompactionRequest` takes and the one wire rule they
// exist to respect.
//
// WHY THIS FILE EXISTS NEXT TO `context-compaction.test.ts`: that suite pins the ladder —
// which rung cuts, what it reports, and the exact 267-character clipped string. This one pins
// the boundary the ladder never thought about: `SHRINK_CLIP_CHARS` (240) counts UTF-16 CODE
// UNITS, so a cut at the budget can land BETWEEN the two halves of an emoji. The clipped text
// then ends on a lone high half, `JSON.stringify` writes it as `\ud83d`, the provider parses
// the body, and its strict UTF-8 encoder refuses it — the live failure was `HTTP 500 …
// 'utf-8' codec can't encode character '\ud83d' in position 643: surrogates not allowed`, on
// every retry, because the clipped entry is a request-level rewrite that rides every later
// turn. The stress run that hit it had 295 tool calls and ~9.85M characters of content: at
// that size, a mid-pair clip is not a corner case, it is a certainty.
//
// The two cuts pinned here:
//   1. `clipShrinkText` (plugin:1417-1437) — applied to an entry's `content` AND to an
//      assistant turn's `toolCalls[].arguments`, both to the same 240-unit budget;
//   2. the DIGEST EXCERPT (plugin:1770-1784) — the harness's own `Oldest removed:` line, cut
//      from an entry it already clipped, which is the one clipped string the harness AUTHORS
//      and therefore the one the model can never edit its way out of.
//
// The budget and the marker are spelled literally here (not imported) for the same reason the
// sibling suite spells them: a reword of the plugin has to move this file too.
//
// Run: yarn vitest run src/engine/plugin/context-compaction.surrogates.test.ts

import { describe, expect, it } from 'vitest';
import { planCompactionRequest } from '../plugins/context-compaction.plugin';
// The provider's rule, measured with the same helper the transport's wire sanitizer uses, so
// "no lone surrogate here" means the same thing in both places.
import { countLoneSurrogates } from '../util';
import type { HarnessMessage } from '../types';

// A complete emoji pair, and the clip marker `clipShrinkText` appends (1 + 26 characters).
const PAIR = '\ud83c\udf89';
const CLIP = '\u2026 [truncated by compaction]';
// The shrink clip budget (`SHRINK_CLIP_CHARS` in the plugin).
const BUDGET = 240;

// A 1,000-unit string with a pair STRADDLING the budget: 239 x's, the high half at index 239,
// the low half at index 240. `clipShrinkText` cuts at exactly 240, so this fixture is the
// split, not a near miss.
const straddling = `${'x'.repeat(BUDGET - 1)}${PAIR}${'X'.repeat(759)}`;

// The same shape inside a JSON-shaped tool-call `arguments` string: `{"v":"` is 6 units, so 233
// x's put the pair on 239/240 as well (arguments are clipped under the same budget, and a 2 MB
// file written through a tool call is the case that budget exists for).
const straddlingArgs = `{"v":"${'x'.repeat(BUDGET - 1 - 6)}${PAIR}${'Y'.repeat(759)}"}`;

// Five entries: three in the head (the default `keepTail` is 2) and two verbatim in the tail.
const transcript = (): HarnessMessage[] => [
    { role: 'user', content: straddling },
    {
        role: 'assistant',
        content: 'a',
        toolCalls: [{ id: 'c1', name: 'write', arguments: straddlingArgs }]
    },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'tail one' },
    { role: 'user', content: 'tail two' }
];

// Every string a plan can put on the wire: each entry's `content`, and each tool call's
// `arguments`. The count is what the provider's encoder would have rejected.
const loneSurrogatesOf = (messages: readonly HarnessMessage[]): number => {
    let total = 0;

    for (const entry of messages) {
        total += countLoneSurrogates(String(entry.content ?? ''));

        const calls = (entry as { toolCalls?: { arguments?: unknown }[] }).toolCalls ?? [];

        for (const call of calls) total += countLoneSurrogates(String(call.arguments ?? ''));
    }

    return total;
};

describe('the compaction shrink never clips a surrogate pair', () => {
    it('proves the fixture really straddles the budget (a raw cut is broken)', () => {
        // Without this, the two cases below would pass on a fixture that never exercised the
        // boundary: the OLD code cut at exactly `BUDGET`, and each string here leaves exactly
        // one orphan half behind at that cut.
        expect(countLoneSurrogates(straddling.slice(0, BUDGET))).toBe(1);
        expect(countLoneSurrogates(straddlingArgs.slice(0, BUDGET))).toBe(1);
        // And the whole strings themselves are clean, so any orphan counted later is the
        // clip's doing, not the input's.
        expect(countLoneSurrogates(straddling)).toBe(0);
        expect(countLoneSurrogates(straddlingArgs)).toBe(0);
    });

    it('clips a straddling `content` and `arguments` one unit short instead of mid-pair', () => {
        // A target the CLIPPED head fits and the full transcript does not (the full request
        // estimates 510 tokens, the clipped one 142), so this plan is Pass A alone: every entry
        // survives, cut.
        const plan = planCompactionRequest(transcript(), 300);

        expect(plan.dropped).toBe(0);
        expect(plan.clipped).toBe(2);
        expect(plan.tokens).toBe(142);
        // Exactly the clipped prefix (239 units, the pair dropped whole) plus the marker — a
        // byte-exact spelling of "the cut backed off one unit".
        expect(plan.messages[0].content).toBe(`${'x'.repeat(BUDGET - 1)}${CLIP}`);
        expect(
            (plan.messages[1] as { toolCalls: { arguments: string }[] }).toolCalls[0].arguments
        ).toBe(`{"v":"${'x'.repeat(BUDGET - 1 - 6)}${CLIP}`);
        // The wire rule, asserted over every string the rewritten request would carry.
        expect(loneSurrogatesOf(plan.messages)).toBe(0);
        expect(JSON.stringify(plan.messages)).not.toMatch(/\\ud[0-9a-fA-F]{3}/);
    });

    it('leaves a cut that lands between whole characters exactly where it was', () => {
        // The no-drift control: an ASCII payload clips to 240 units plus the marker — the
        // spelling every existing ladder assertion in `context-compaction.test.ts` pins — so
        // the pair-safe clip does not shorten a request that never needed it.
        const plain: HarnessMessage[] = [
            { role: 'user', content: 'z'.repeat(1000) },
            {
                role: 'assistant',
                content: 'a',
                toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"x"}' }]
            },
            { role: 'user', content: 'second' },
            { role: 'user', content: 'tail one' },
            { role: 'user', content: 'tail two' }
        ];
        const plan = planCompactionRequest(plain, 200);

        // The figures for this fixture: 261 tokens full, 78 clipped, so the target selects
        // Pass A alone exactly as it does in the case above.
        expect(plan.dropped).toBe(0);
        expect(plan.clipped).toBe(1);
        expect(plan.tokens).toBe(78);
        expect(plan.messages[0].content).toBe(`${'z'.repeat(BUDGET)}${CLIP}`);
        expect(loneSurrogatesOf(plan.messages)).toBe(0);
    });

    it('writes a digest excerpt free of an orphan half, byte for byte', () => {
        // A target NOTHING can reach, so Pass B drops the whole head and the digest entry —
        // the harness-authored message that rides every later request — carries the excerpts.
        const plan = planCompactionRequest(transcript(), 1);

        expect(plan.dropped).toBe(3);
        expect(plan.clipped).toBe(2);
        expect(plan.tokens).toBe(139);
        expect(plan.messages).toHaveLength(3);

        // The whole digest line, spelled out: the excerpt is the clipped entry's text cut to
        // 240 units, i.e. the 239 kept x's plus the marker's first character. Under the old
        // code this string carried a lone high half (`… xxxxx\ud83d …`), because the excerpt
        // was cut from a clip that had already split the pair.
        expect(plan.messages[0].content).toBe(
            '[context compaction digest] The harness removed 3 earlier turns from this request ' +
                'without a model to summarize them, because the request itself did not fit the ' +
                'context window. The removed turns are still on the record; they are simply not ' +
                `being sent. Oldest removed: ${'x'.repeat(BUDGET - 1)}\u2026 | Most recent removed: second`
        );
        expect(loneSurrogatesOf(plan.messages)).toBe(0);
        expect(countLoneSurrogates(String(plan.messages[0].content))).toBe(0);
        // The tail survives verbatim, so nothing here silently rewrote an entry the model needs.
        expect(plan.messages[1].content).toBe('tail one');
        expect(plan.messages[2].content).toBe('tail two');
    });
});
