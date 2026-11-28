// fetch — the paging WINDOW and surrogate pairing (T3, 2026-11-24, the lone-surrogate
// provider defect).
//
// The suite next to this file (`webfetch.test.ts`) pins the byte bounds, the conversion, the
// hosted adapters and the SSRF gate. This one pins the one thing the WINDOW arithmetic could
// not see: `offset` counts UTF-16 CODE UNITS, and `content.slice(offset)` at an arbitrary
// offset can start on the SECOND unit of a surrogate pair, so the returned page began with a
// lone low surrogate. `JSON.stringify` wrote it as `\udc00`, the provider parsed the JSON, and
// its strict UTF-8 encoder refused to encode it — `HTTP 500 … 'utf-8' codec can't encode
// character '\ud83d' in position 643: surrogates not allowed` in the live stress run (295 tool
// calls, ~9.85M chars), on every retry of every request that replayed the transcript.
//
// The trailing direction was already handled (`trimBrokenSurrogate`, index.ts:579, which runs
// on every candidate the result fit (`fitResult`) considers); the LEAD direction had no guard
// at all, because that helper only looks at the last code unit. Pinned here:
//
//   1. an offset on the LOW half of a pair: the emitted page carries no orphan half, and
//      `offset` / `truncated` / `nextOffset` keep their exact existing values — the repair
//      trims TEXT, it does not move the window;
//   2. an offset on the HIGH half, and an offset between whole characters: byte-for-byte what
//      they always returned, so the guard costs nothing on the paths that never needed it;
//   3. a budget-bound page chain: no emitted page carries an orphan half, and the documented
//      5 % shrink arithmetic still lands exactly where it says — on a pair boundary, with the
//      two windows meeting at a whole character.
//
// Offline and deterministic, exactly like its sibling suite: `fetch` is a stub, the resolved-
// address SSRF gate is switched off, and no key or network is read.
//
// Run: yarn vitest run src/engine/tools/webfetch/webfetch.surrogates.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFetchTool } from '../../index';
import type { Tool, WebFetchParameters, WebFetchResult } from '../../index';
import { countLoneSurrogates } from '../../util';
import { MAX_CONTENT_CHARS, MAX_RESULT_CONTENT_BYTES } from './request';

// A complete pair (one emoji, TWO code units), and a lone low half — the shape a window
// starting mid-pair produces.
const PAIR = '\ud83c\udf89';

// Same shape as `call` in `webfetch.test.ts`, minus the `| string` arm: every case here
// asks for a WINDOW, which only the object form can carry, and `Tool<P, R>` is callable
// with `P` alone — the union arm is a type error the sibling suite never surfaced because
// the package tsconfig excludes `**/*.test.ts` from `tsc --noEmit`.
const call = async (
    definition: Tool<WebFetchParameters, WebFetchResult>,
    parameters: WebFetchParameters
): Promise<WebFetchResult> => (await definition(parameters)) as WebFetchResult;

const plainPage = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const stubFetch = (body: string): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => plainPage(body))
    );
};

// `dns: { off: true }` keeps the run offline, exactly as in `webfetch.test.ts`.
const keyless = () => createWebFetchTool({ env: {}, dns: { off: true } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the fetch window never emits a lone surrogate', () => {
    // 'x' × 9, then the pair at indices 9 (high) and 10 (LOW), then 'y' × 20. The whole page
    // is 31 units, so nothing here is bounded by bytes or characters — every difference a
    // test observes is the window cut and nothing else.
    const page = `${'x'.repeat(9)}${PAIR}${'y'.repeat(20)}`;

    it('drops an orphan low half when the offset lands mid-pair, and keeps every offset', async () => {
        stubFetch(page);

        // Offset 10 is the SECOND unit of the pair — what a caller that carried a byte count
        // into a character offset, or computed its own arithmetic, actually asks for.
        const result = await call(keyless(), { url: 'https://example.com/mid', offset: 10 });

        // The page text: the orphan half is gone, the rest of the window is intact.
        expect(result.content).toBe('y'.repeat(20));
        expect(countLoneSurrogates(result.content)).toBe(0);
        // OFFSETS DO NOT MOVE. `offset` still echoes the window that was asked for; only the
        // emitted text lost a unit that was never a character of the document.
        expect(result.offset).toBe(10);
        expect(result.characters).toBe(20);
        expect(result.pageCharacters).toBe(31);
        // The one visible consequence of trimming WITHOUT shifting: `truncated` is computed
        // from the source length, so a window that dropped an orphan half reads as one unit
        // short, and `nextOffset` (`startOffset + content.length` = 30) points at the last
        // character it already delivered. Paging therefore repeats at most ONE character and
        // can never skip one — the alternative (moving the offset) would have made the
        // reported position disagree with the page the caller asked for.
        expect(result.truncated).toBe(true);
        expect(result.nextOffset).toBe(30);
        expect(result.offsetClamped).toBeUndefined();

        // …and the chain terminates: the resume reads the one overlapping character and stops.
        const resumed = await call(keyless(), { url: 'https://example.com/mid', offset: 30 });

        expect(resumed.content).toBe('y');
        expect(resumed.truncated).toBe(false);
        expect(resumed.nextOffset).toBeUndefined();
        expect(countLoneSurrogates(resumed.content)).toBe(0);
    });

    it('keeps a window that starts on the HIGH half whole', async () => {
        stubFetch(page);

        // Offset 9 is the FIRST unit of a pair: the pair is a legitimate way to start a
        // window, and nothing may be trimmed from it.
        const result = await call(keyless(), { url: 'https://example.com/high', offset: 9 });

        expect(result.content).toBe(`${PAIR}${'y'.repeat(20)}`);
        expect(result.offset).toBe(9);
        expect(result.characters).toBe(22);
        expect(countLoneSurrogates(result.content)).toBe(0);
    });

    it('leaves an offset that already falls between whole characters exactly as it was', async () => {
        stubFetch(page);

        // Offset 11 is one unit PAST the pair, and offset 0 is the unwindowed page: both are
        // the untouched common case, asserted byte for byte so the guard cannot quietly
        // shorten a normal read.
        const past = await call(keyless(), { url: 'https://example.com/past', offset: 11 });

        expect(past.content).toBe('y'.repeat(20));
        expect(past.offset).toBe(11);
        expect(past.characters).toBe(20);

        const whole = await call(keyless(), { url: 'https://example.com/whole' });

        expect(whole.content).toBe(page);
        expect(whole.offset).toBe(0);
        expect(whole.characters).toBe(31);
        expect(whole.truncated).toBe(false);
    });

    it('pages a budget-bound page with no orphan half on any emitted page', async () => {
        // The path a long document actually takes: the RESULT budget (32 KiB of ESCAPED
        // payload, of which MAX_RESULT_CONTENT_BYTES = 30,720 is the share left for
        // `content`) binds long before the 240,000-character page bound, and the shrink
        // steps back 5 % at a time until the encoded form fits. Derived from that
        // documented arithmetic, not read back from a run: the first candidate is
        // `keep = 30,720` units, which encodes to 30,722 bytes (the pair inside it costs
        // 4 escaped bytes for 2 units), so one step fires — 30,720 - floor(30,720 × 0.05)
        // = 29,184 units — and that cut lands BETWEEN the halves of the pair at
        // 29,183/29,184, so the trailing trim drops the orphan high half and the page ends
        // at 29,183 characters.
        stubFetch(`${'x'.repeat(29_183)}${PAIR}${'y'.repeat(4_000)}`);

        const first = await call(keyless(), { url: 'https://example.com/long' });

        // 32 KiB cap minus the RESULT_OVERHEAD_BYTES envelope the fields need.
        expect(MAX_RESULT_CONTENT_BYTES).toBe(30_720);
        expect(MAX_CONTENT_CHARS).toBeGreaterThan(MAX_RESULT_CONTENT_BYTES);
        expect(first.characters).toBe(29_183);
        expect(first.content).toBe('x'.repeat(29_183));
        expect(countLoneSurrogates(first.content)).toBe(0);
        expect(first.truncated).toBe(true);
        expect(first.nextOffset).toBe(29_183);

        // The resume: the pair is now the first WHOLE character of the second window — the two
        // windows split the document at a pair boundary instead of through the middle of one,
        // and nothing between them is lost or repeated.
        const second = await call(keyless(), { url: 'https://example.com/long', offset: 29_183 });

        expect(second.content).toBe(`${PAIR}${'y'.repeat(4_000)}`);
        expect(countLoneSurrogates(second.content)).toBe(0);
        expect(second.offset).toBe(29_183);
        expect(second.characters).toBe(4_002);
        expect(second.truncated).toBe(false);
        expect(second.nextOffset).toBeUndefined();
    });
});
