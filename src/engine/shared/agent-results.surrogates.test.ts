// `boundAgentResultContent` (src/engine/shared/agent-results.ts) — the reference-block bound
// and surrogate pairing (T3, 2026-11-24, the lone-surrogate provider defect).
//
// A `#label` reference block is pasted into a DELEGATED prompt, so its content is bound to a
// character ceiling (`MAX_REFERENCE_CONTENT_CHARS`, or the caller's `limit`) plus an explicit
// `\n...[truncated N characters]` marker. That ceiling counts UTF-16 code units, so the cut
// could land between the two halves of an emoji and the delegated prompt carried a lone
// surrogate — the same failure the provider reported for clipped tool output (`'utf-8' codec
// can't encode character '\ud83d' … surrogates not allowed`).
//
// Pinned exactly, because the marker is a character count a reader may diff against the
// source:
//   - a cut that would split a pair backs off ONE unit (239 characters here, not 240), and the
//     emitted block carries no orphan half;
//   - the ASCII path is byte-for-byte what it always was (240 characters), so no existing
//     bound in the agent-results suites drifts;
//   - a block already inside the limit is returned as the SAME reference.
//
// Run: yarn vitest run src/engine/shared/agent-results.surrogates.test.ts

import { describe, expect, it } from 'vitest';
import { boundAgentResultContent } from './agent-results';
import { countLoneSurrogates } from '../util';

const PAIR = '\ud83c\udf89';
const LIMIT = 240;

describe('boundAgentResultContent', () => {
    it('backs the cut off one unit instead of ending a block on half an emoji', () => {
        // 252 units: 210 x's, then the pair at 210 (high) and 211 (LOW). The fixed-point
        // arithmetic solves `keep = limit - marker.length` to 211 for this block — exactly the
        // boundary between the two halves, which is why the old cut left one orphan behind.
        const content = `${'x'.repeat(210)}${PAIR}${'z'.repeat(40)}`;

        expect(content.length).toBe(252);
        expect(countLoneSurrogates(content.slice(0, 211))).toBe(1);

        const bounded = boundAgentResultContent(content, LIMIT);

        // The marker length is part of the bound: `\n...[truncated 41 characters]` is 29
        // characters, so the kept text is 210 units, one short of the 211 the arithmetic asked
        // for — and the block ends on a whole character.
        expect(bounded).toBe(`${'x'.repeat(210)}\n...[truncated 41 characters]`);
        expect(bounded.length).toBe(239);
        expect(bounded.length).toBeLessThanOrEqual(LIMIT);
        expect(countLoneSurrogates(bounded)).toBe(0);
    });

    it('leaves a plain-text bound exactly where it always was', () => {
        // The no-drift control, byte for byte: 300 ASCII characters against the same 240
        // ceiling keep `keep = 211` and the 29-character marker, for 240 characters total —
        // the spelling every existing agent-results assertion is written against.
        const plain = 'q'.repeat(300);

        expect(boundAgentResultContent(plain, LIMIT)).toBe(
            `${'q'.repeat(211)}\n...[truncated 89 characters]`
        );
        expect(boundAgentResultContent(plain, LIMIT)).toHaveLength(240);
    });

    it('passes an in-limit block through by reference', () => {
        const short = `party ${PAIR} time`;

        expect(boundAgentResultContent(short, LIMIT)).toBe(short);
    });
});
