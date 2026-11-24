// src/engine/util/unicode.ts — the pairing rule the whole package shares (T3, 2026-11-24,
// the lone-surrogate provider defect).
//
// THE DEFECT, in one line: a JavaScript `slice` counts UTF-16 CODE UNITS, so a cut may land
// between a high half and its low half and leave an UNPAIRED surrogate behind. That half is
// legal in JS and legal in JSON (`JSON.stringify` writes it as `\ud83d`), and a provider whose
// server encodes strictly dies on it — the reported live failure was `HTTP 500 … 'utf-8' codec
// can't encode character '\ud83d' in position 643: surrogates not allowed`, on every one of
// eleven retries, because the transcript replays the poisoned text verbatim.
//
// Every expectation below is an exact, hardcoded value (observed once, then written down),
// because these helpers decide what bytes leave the process:
//   - `pairSafeCut`/`clipPrefix` — a prefix cut backs off ONE unit rather than splitting a
//     pair; a cut that is already legal, at the ends, or out of range is left alone;
//   - `countLoneSurrogates`/`hasLoneSurrogate` — a valid pair is 0/false, an orphan half in
//     either direction is 1/true, and U+FFFD is NOT a surrogate;
//   - `sanitizeLoneSurrogates` — replaces orphans, keeps valid pairs and U+FFFD byte for byte,
//     and returns the SAME reference for a clean string (the no-op contract the wire walk
//     depends on);
//   - `trimBrokenTrailSurrogate`/`trimBrokenLeadSurrogate` — repair a slice already taken at an
//     arbitrary offset, one unit at each end, and never touch a character that is whole;
//   - `sanitizeWireBody`/`countWireLoneSurrogates` — the request-body walk: mutates in place,
//     writes only the dirty slots, never adds/drops/reorders a key, and never throws on a
//     hostile body (a cycle, a frozen object).
//
// A NOTE ON THE LITERALS: `\ud83d` (a stray HIGH half) and `\udc00` (a stray LOW half) are
// written as escapes, not typed, because an editor/terminal cannot tell them from a real emoji,
// and this file is the contract about exactly that difference. `'\ud83c\udf89'` is a COMPLETE
// pair (🎉) and must survive every helper unchanged.
//
// Run: yarn vitest run src/engine/util/unicode.test.ts

import { describe, expect, it } from 'vitest';
import {
    clipPrefix,
    countLoneSurrogates,
    countWireLoneSurrogates,
    hasLoneSurrogate,
    isHighSurrogateCode,
    isLowSurrogateCode,
    pairSafeCut,
    sanitizeLoneSurrogates,
    sanitizeWireBody,
    trimBrokenLeadSurrogate,
    trimBrokenTrailSurrogate
} from './unicode';

// A stray lead surrogate (the first half of `\ud83d\ude00`, with its partner missing), a stray
// trail surrogate, and one COMPLETE pair. `REPLACEMENT` is what a repaired orphan looks like.
const HIGH = '\ud83d';
const LOW = '\udc00';
const PAIR = '\ud83c\udf89';
const REPLACEMENT = '\ufffd';

describe('isHighSurrogateCode / isLowSurrogateCode', () => {
    it('splits the two halves at their code-point ranges', () => {
        // The range ENDS, not the values copied around: 0xdbff is the last high half and
        // 0xdc00 the first low half, and they are adjacent.
        expect(isHighSurrogateCode(0xd800)).toBe(true);
        expect(isHighSurrogateCode(0xdbff)).toBe(true);
        expect(isHighSurrogateCode(0xdc00)).toBe(false);
        expect(isLowSurrogateCode(0xdc00)).toBe(true);
        expect(isLowSurrogateCode(0xdfff)).toBe(true);
        expect(isLowSurrogateCode(0xdbff)).toBe(false);

        // `charCodeAt` answers NaN past the end of the string, and every comparison with NaN
        // is false — that is what lets callers probe index -1 and index length without a
        // bounds check.
        expect(isHighSurrogateCode(Number.NaN)).toBe(false);
        expect(isLowSurrogateCode(Number.NaN)).toBe(false);
    });
});

describe('pairSafeCut', () => {
    it('leaves a cut that does not fall inside a pair exactly where it was', () => {
        expect(pairSafeCut('abcdef', 3)).toBe(3);
        // Before a high half (index 1 of `a🎉b`) and after the pair (index 3) are both legal
        // boundaries: the pair stays on one side of the cut.
        expect(pairSafeCut(`a${PAIR}b`, 1)).toBe(1);
        expect(pairSafeCut(`a${PAIR}b`, 3)).toBe(3);
    });

    it('backs off one unit when the cut would split a pair', () => {
        // `a🎉b` is ['a', \ud83c, \udf89, 'b']: index 2 is BETWEEN the two halves, and a cut
        // there would end the prefix on a lone high half.
        expect(pairSafeCut(`a${PAIR}b`, 2)).toBe(1);
        // The same rule at the very start of the string, where backing off reaches 0.
        expect(pairSafeCut(PAIR, 1)).toBe(0);
    });

    it('does not move a cut that only touches a pre-existing orphan half', () => {
        // A LONE low half at index 0 has no high half in front of it, so index 1 is already a
        // legal boundary — there is nothing here to un-split.
        expect(pairSafeCut(`${LOW}a`, 1)).toBe(1);
        // A LONE high half at the END of the string: a cut at `length` is not inside a pair.
        expect(pairSafeCut(`a${HIGH}`, 2)).toBe(2);
    });

    it('clamps an out-of-range budget instead of throwing', () => {
        expect(pairSafeCut(`a${PAIR}b`, 4)).toBe(4);
        expect(pairSafeCut(`a${PAIR}b`, 99)).toBe(4);
        expect(pairSafeCut(`a${PAIR}b`, 0)).toBe(0);
        expect(pairSafeCut(`a${PAIR}b`, -5)).toBe(0);
        // `±Infinity` is how callers spell "no bound" and "nothing" (websearch's
        // `text(redact(value), Number.POSITIVE_INFINITY)`), so they must clamp to the ends
        // rather than to 0 — an Infinity budget that cut to nothing would empty every snippet.
        expect(pairSafeCut(`a${PAIR}b`, Number.POSITIVE_INFINITY)).toBe(4);
        expect(pairSafeCut(`a${PAIR}b`, Number.NEGATIVE_INFINITY)).toBe(0);
        expect(pairSafeCut(`a${PAIR}b`, Number.NaN)).toBe(0);
        // A fractional budget floors, and the floor is what gets the pair check.
        expect(pairSafeCut(`a${PAIR}b`, 2.9)).toBe(1);
    });
});

describe('clipPrefix', () => {
    it('is byte-identical to `slice(0, n)` on text with no pair at the cut', () => {
        const text = 'abcdef';

        expect(clipPrefix(text, 3)).toBe('abc');
        expect(clipPrefix(text, 0)).toBe('');
        expect(clipPrefix(text, 99)).toBe('abcdef');
        expect(clipPrefix(text, Number.POSITIVE_INFINITY)).toBe('abcdef');
    });

    it('loses one unit rather than emitting half of an emoji', () => {
        expect(clipPrefix(`a${PAIR}b`, 2)).toBe('a');
        expect(clipPrefix(`a${PAIR}b`, 1)).toBe('a');
        expect(clipPrefix(`a${PAIR}b`, 3)).toBe(`a${PAIR}`);
        expect(clipPrefix(`a${PAIR}b`, 4)).toBe(`a${PAIR}b`);
        expect(clipPrefix(PAIR, 1)).toBe('');
        expect(clipPrefix(PAIR, 2)).toBe(PAIR);
    });

    it('never sanitizes, only cuts', () => {
        // The orphan here was in the INPUT, and a clip has no licence to rewrite text: the
        // caller that owns the string decides (the wire sanitizer is that place for requests).
        expect(clipPrefix(`a${HIGH}`, 2)).toBe(`a${HIGH}`);
        expect(clipPrefix(`${LOW}a`, 1)).toBe(LOW);
    });
});

describe('countLoneSurrogates / hasLoneSurrogate', () => {
    it('counts each unpaired half and never a complete pair', () => {
        expect(countLoneSurrogates(PAIR)).toBe(0);
        expect(countLoneSurrogates(`a${HIGH}`)).toBe(1);
        expect(countLoneSurrogates(`a${LOW}`)).toBe(1);
        // Two highs in a row: the first has no low half after it, and the second is stranded
        // at the end, so BOTH are orphan.
        expect(countLoneSurrogates(`${HIGH}${HIGH}`)).toBe(2);
        expect(countLoneSurrogates(`${LOW}${LOW}`)).toBe(2);
        expect(countLoneSurrogates(`x${HIGH}y${LOW}z`)).toBe(2);
        // A valid pair in the MIDDLE: its low half must not be miscounted as orphan, and its
        // high half must not be miscounted either.
        expect(countLoneSurrogates(`${HIGH}${PAIR}${LOW}`)).toBe(2);
        expect(countLoneSurrogates('')).toBe(0);
        expect(countLoneSurrogates('plain text')).toBe(0);
    });

    it('treats U+FFFD as an ordinary character', () => {
        // The replacement character is what THIS module writes, so counting it as damage
        // would make the sanitizer report a repair that never happened.
        expect(countLoneSurrogates(`a${REPLACEMENT}b`)).toBe(0);
        expect(hasLoneSurrogate(`a${REPLACEMENT}b`)).toBe(false);
    });

    it('agrees with the counter on every shape', () => {
        const cases: readonly string[] = [
            PAIR,
            `a${HIGH}`,
            `a${LOW}`,
            `${HIGH}${HIGH}`,
            `${LOW}${LOW}`,
            `x${HIGH}y${LOW}z`,
            `${HIGH}${PAIR}${LOW}`,
            '',
            'plain text',
            `a${REPLACEMENT}b`
        ];

        for (const value of cases) {
            expect(hasLoneSurrogate(value)).toBe(countLoneSurrogates(value) > 0);
        }
    });
});

describe('sanitizeLoneSurrogates', () => {
    it('replaces an orphan high half and an orphan low half with U+FFFD', () => {
        expect(sanitizeLoneSurrogates(`a${HIGH}b`)).toBe(`a${REPLACEMENT}b`);
        expect(sanitizeLoneSurrogates(`a${LOW}b`)).toBe(`a${REPLACEMENT}b`);
        expect(sanitizeLoneSurrogates(HIGH)).toBe(REPLACEMENT);
        expect(sanitizeLoneSurrogates(LOW)).toBe(REPLACEMENT);
        // Mixed: the pair in the middle survives, both orphans become U+FFFD.
        expect(sanitizeLoneSurrogates(`${HIGH}${PAIR}${LOW}`)).toBe(
            `${REPLACEMENT}${PAIR}${REPLACEMENT}`
        );
    });

    it('returns the SAME reference for text it had no reason to touch', () => {
        // THE no-op contract: the wire walk compares references to decide whether to write a
        // key at all, which is what keeps a clean request byte-identical.
        const clean = `a${PAIR}b`;

        expect(sanitizeLoneSurrogates(clean)).toBe(clean);
        expect(sanitizeLoneSurrogates('plain')).toBe('plain');
        expect(sanitizeLoneSurrogates('')).toBe('');
        // An existing U+FFFD is not a surrogate and is left alone, same reference.
        const replaced = `a${REPLACEMENT}b`;

        expect(sanitizeLoneSurrogates(replaced)).toBe(replaced);
    });

    it('is idempotent and leaves the repaired text clean', () => {
        const once = sanitizeLoneSurrogates(`a${HIGH}b${LOW}c`);

        expect(once).toBe(`a${REPLACEMENT}b${REPLACEMENT}c`);
        expect(sanitizeLoneSurrogates(once)).toBe(once);
        expect(countLoneSurrogates(once)).toBe(0);
    });
});

describe('trimBrokenTrailSurrogate / trimBrokenLeadSurrogate', () => {
    it('drops the trailing high half a slice can leave behind', () => {
        expect(trimBrokenTrailSurrogate(`a${HIGH}`)).toBe('a');
        expect(trimBrokenTrailSurrogate(`${PAIR}${HIGH}`)).toBe(PAIR);
    });

    it('drops the leading low half a slice taken mid-pair leaves behind', () => {
        // The paging case: `content.slice(offset)` with `offset` on the SECOND unit of a pair.
        expect(trimBrokenLeadSurrogate(`${LOW}a`)).toBe('a');
        expect(trimBrokenLeadSurrogate(`${LOW}${LOW}`)).toBe(LOW);
    });

    it('keeps a whole character at either end, and an orphan of the other kind', () => {
        // The trailing trim looks at the LAST unit only, and a low half at the start is the
        // lead trim's job — the two helpers are deliberately not one rule.
        expect(trimBrokenTrailSurrogate(`a${PAIR}`)).toBe(`a${PAIR}`);
        expect(trimBrokenTrailSurrogate(`a${LOW}`)).toBe(`a${LOW}`);
        expect(trimBrokenLeadSurrogate(`${PAIR}a`)).toBe(`${PAIR}a`);
        expect(trimBrokenLeadSurrogate(`${HIGH}a`)).toBe(`${HIGH}a`);
        expect(trimBrokenTrailSurrogate('')).toBe('');
        expect(trimBrokenLeadSurrogate('')).toBe('');
    });
});

describe('sanitizeWireBody / countWireLoneSurrogates', () => {
    // A request body in the shape the transport actually builds: nested arrays, an
    // array-of-parts `content`, and a tool call whose `arguments` is a JSON STRING (the two
    // places the reported failure hid). Fresh per call, because the walk mutates.
    const body = (): Record<string, unknown> => ({
        model: 'local/basalt',
        stream: true,
        messages: [
            { role: 'system', content: 'brief' },
            { role: 'user', content: [`one ${HIGH}`, { type: 'text', text: `two ${LOW}` }] },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'write', arguments: `{"text":"a${HIGH}b"}` }
                    }
                ]
            }
        ],
        max_tokens: 4096,
        stop: null
    });

    // The same body, every orphan replaced by U+FFFD and nothing else changed.
    const repaired = (): Record<string, unknown> => ({
        model: 'local/basalt',
        stream: true,
        messages: [
            { role: 'system', content: 'brief' },
            { role: 'user', content: [`one ${REPLACEMENT}`, { type: 'text', text: `two ${REPLACEMENT}` }] },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'write', arguments: `{"text":"a${REPLACEMENT}b"}` }
                    }
                ]
            }
        ],
        max_tokens: 4096,
        stop: null
    });

    it('repairs every string at every depth, in place, and counts what it replaced', () => {
        const poisoned = body();
        const result = sanitizeWireBody(poisoned);

        // Three orphans: a high half in a content part, a low half in a nested part, and a
        // high half inside the tool call's `arguments` string.
        expect(result.replaced).toBe(3);
        // Mutated IN PLACE (the body is built fresh per attempt, so a copy would cost the
        // whole transcript twice).
        expect(result.value).toBe(poisoned);
        expect(result.value).toEqual(repaired());
        expect(countWireLoneSurrogates(result.value)).toBe(0);
        // And the proof the provider can encode it: the serialized form carries no `\udXXX`.
        expect(JSON.stringify(result.value)).not.toMatch(/\\ud[0-9a-fA-F]{3}/);
    });

    it('keeps the key set and its order, and every non-string value', () => {
        const poisoned = body();
        const keysBefore = Object.keys(poisoned);
        const partsBefore = Object.keys(poisoned.messages as never);
        const result = sanitizeWireBody(poisoned);

        expect(Object.keys(result.value)).toEqual(keysBefore);
        expect(Object.keys(result.value.messages as never)).toEqual(partsBefore);
        expect(Object.keys((result.value.messages as never[])[1] as never)).toEqual([
            'role',
            'content'
        ]);
        expect(result.value.max_tokens).toBe(4096);
        expect(result.value.stop).toBeNull();
        expect(result.value.stream).toBe(true);
    });

    it('is a strict no-op for a clean body: same reference, same bytes', () => {
        const clean = {
            model: 'local/basalt',
            stream: true,
            messages: [
                { role: 'system', content: 'brief' },
                { role: 'user', content: [`party ${PAIR}`, { type: 'text', text: 'nested' }] },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'c1',
                            type: 'function',
                            function: { name: 'write', arguments: `{"text":"${PAIR}"}` }
                        }
                    ]
                }
            ],
            max_tokens: 4096
        };
        // The exact string the transport would have sent BEFORE this fix existed.
        const before = JSON.stringify(clean);
        const result = sanitizeWireBody(clean);

        expect(result.replaced).toBe(0);
        expect(result.value).toBe(clean);
        // BYTE-IDENTICAL, not merely equal: a clean request must not change shape, a field
        // order, or a single byte, because every existing wire test pins its exact body.
        expect(JSON.stringify(result.value)).toBe(before);
        expect(countWireLoneSurrogates(clean)).toBe(0);
    });

    it('walks arrays at the top level and repairs string elements', () => {
        const list = [`a${HIGH}`, { note: `b${LOW}` }, 'clean', 7, null];
        const result = sanitizeWireBody(list);

        expect(result.replaced).toBe(2);
        expect(result.value).toEqual([`a${REPLACEMENT}`, { note: `b${REPLACEMENT}` }, 'clean', 7, null]);
        expect(countWireLoneSurrogates(result.value)).toBe(0);
    });

    it('counts a whole value, at any depth, when asked read-only', () => {
        // One orphan in a nested array, one orphan low half that FOLLOWS a complete pair, and
        // one in a sibling key: three, counted across the whole tree.
        expect(
            countWireLoneSurrogates({ a: [`x${HIGH}`, { b: `${PAIR}${LOW}` }], c: HIGH })
        ).toBe(3);
        expect(countWireLoneSurrogates('a')).toBe(0);
        expect(countWireLoneSurrogates(null)).toBe(0);
        expect(countWireLoneSurrogates(undefined)).toBe(0);
        expect(countWireLoneSurrogates(42)).toBe(0);
        // A `Map` serializes as `{}` (its entries are not own enumerable properties), so
        // `JSON.stringify` never carries its strings and neither does this count.
        expect(countWireLoneSurrogates(new Map([['k', `${HIGH}`]]))).toBe(0);
    });

    it('repairs a top-level string by returning the repaired value', () => {
        // The one arm that cannot mutate its argument, so it answers with the value instead.
        const result = sanitizeWireBody(`a${HIGH}b`);

        expect(result.value).toBe(`a${REPLACEMENT}b`);
        expect(result.replaced).toBe(1);

        const clean = `a${PAIR}b`;

        expect(sanitizeWireBody(clean).value).toBe(clean);
        expect(sanitizeWireBody(clean).replaced).toBe(0);
    });

    it('leaves values the serializer does not walk alone', () => {
        const value = new Date(0);
        const fn = (): number => 0;
        const odd = { n: 1, b: true, nil: null, when: value, fn, list: [null, 1, `${LOW}`] };
        const result = sanitizeWireBody(odd);

        // Only the one real string in the tree is touched; a Date/Map/function is left as it
        // was, because `JSON.stringify` renders those from toJSON / nothing at all.
        expect(result.replaced).toBe(1);
        expect(result.value.list).toEqual([null, 1, REPLACEMENT]);
        expect(result.value.when).toBe(value);
        expect(result.value.fn).toBe(fn);
        expect(result.value.n).toBe(1);
    });

    it('survives a cyclic body without throwing or hanging', () => {
        type Cyclic = { note: string; self?: unknown };
        const cyclic: Cyclic = { note: `x${HIGH}` };

        cyclic.self = cyclic;

        const result = sanitizeWireBody(cyclic);

        // The cycle guard visits `self` once (it was already reached as the root), so the walk
        // terminates — and the string it reached BEFORE the cycle is still repaired.
        expect(result.replaced).toBe(1);
        expect(cyclic.note).toBe(`x${REPLACEMENT}`);
        // The body is still not serializable: that stays the `JSON.stringify` gate's honest
        // error frame, and sanitizing must not pre-empt it.
        expect(() => JSON.stringify(cyclic)).toThrow(TypeError);
    });

    it('survives a frozen host body without throwing and without over-reporting', () => {
        // A host may hand the transport a body it keeps, and may freeze it. The walk is best
        // effort: it must not turn a repairable request into a throw, and it must not claim a
        // repair the object refused.
        const frozen = Object.freeze({ note: `x${HIGH}` });
        const result = sanitizeWireBody(frozen);

        expect(result.value).toBe(frozen);
        expect(result.replaced).toBe(0);
        expect(frozen.note).toBe(`x${HIGH}`);
    });

    it('repairs a shared subtree once, and reports it once', () => {
        // The same object referenced twice (a DAG, not a cycle): the second visit is skipped,
        // which is free AND correct, because the first visit already repaired the object the
        // two references share.
        const shared = { text: `a${HIGH}` };
        const result = sanitizeWireBody({ one: shared, two: shared });

        expect(result.replaced).toBe(1);
        expect(shared.text).toBe(`a${REPLACEMENT}`);
        expect(result.value.two).toEqual({ text: `a${REPLACEMENT}` });
    });
});
