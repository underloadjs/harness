// edit — exact, batched replacement semantics (T14).
//
// Runs against real files in a temporary directory under the repo-root `Temp/`,
// using absolute paths so it never chdir's. Every assertion is the full result
// array or the exact resulting file text: the tool's value is the guarantee that
// an ambiguous edit cannot happen and that a bad entry in a batch changes nothing,
// so a partial assert would test nothing.
//
// The batch guarantees are the new part:
//   - every edit is validated (shape, no unknown field, oldString/newString types, no NUL
//     in the path) BEFORE any read;
//   - every target is STATTED before it is read, so a directory, a FIFO, a device or a
//     file over FILE_EDIT_MAX_BYTES is refused with a code and a remedy instead of being
//     opened (L5, L9);
//   - a file that cannot be READ (0o000) is refused; a file that cannot be WRITTEN but
//     can be read (0o444) is not, because the publish renames into the DIRECTORY (M3);
//   - a no-op entry (oldString === newString) and an empty oldString against an EMPTY file
//     are ACCEPTED (M12); a no-op says `changed: false` and is not republished;
//   - entries are grouped by FILE IDENTITY (./identity.ts), so several entries may
//     name one file — the same path twice, two case spellings on Windows, or a
//     symlink alias on any platform. They are applied in ARRAY order, each matched
//     against the text the previous one produced;
//   - every file is then read and match-checked BEFORE the first write, so a
//     failure on the LAST entry leaves the FIRST file untouched, and each distinct
//     file is written exactly ONCE with its final text;
//   - a target whose bytes are not valid UTF-8 (or that holds a NUL byte) is refused
//     with EBINARY naming the byte offset, also in the preflight, so a batch never
//     rewrites a file it cannot decode back byte for byte;
//   - at most 100 entries per call, the cap `read`, `write` and `files` publish;
//   - the result is one entry per requested edit, in request order, naming the path
//     that entry asked for and reporting replacements + the file's final byte size
//     (entries sharing a file therefore report the same size);
//   - the published DESCRIPTION is pinned as text, because it is the contract a model
//     reads — including F6's clause stating that shared-file entries report the same
//     final size, and F7's refusal message, which now names the empty-oldString exception
//     it enforces instead of only the rule.
//
// Line endings are pinned from both sides on purpose. A LF-only newString adopts the
// endings of the file (the documented default); a newString that contains a carriage
// return is ending-explicit and is written verbatim, so the exact resulting BYTES are
// asserted for every shape, including the doubled-CR shapes the rule makes honest.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
    chmod,
    link as hardLink,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readFile as readTextFile,
    readdir,
    readlink,
    rm,
    stat,
    symlink,
    writeFile,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { HarnessError } from '../../util';
import { STAGING_MARKER } from './atomic-publish';
import { edit, FILE_EDIT_ERROR_CODES, FILE_EDIT_MAX_BYTES, FILE_EDIT_METADATA } from './edit.tool';
import { write } from './write.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

const seed = async (name: string, content: string): Promise<string> => {
    const path = join(workdir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
    return path;
};

// ---------------------------------------------------------------------------
// BYTE-GRADE fixtures. Line-ending and encoding behaviour is a statement about BYTES,
// and a UTF-8 text round-trip is exactly what is under test, so both the seed and the
// expectation are written as hex and compared as bytes. A text fixture would fold the
// Latin-1 byte into U+FFFD before an assertion could see the tool do it, and a text
// assertion would render "\r\n" and "\r\r\n" as nearly the same invisible nothing.
// ---------------------------------------------------------------------------

const fromHex = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'hex');

const toHex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

// Seed a file with EXACT BYTES (the hex form, so a fixture reads as the byte pattern the
// defect report named).
const seedBytes = async (name: string, hex: string): Promise<string> => {
    const path = join(workdir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, fromHex(hex));
    return path;
};

const readHex = async (path: string): Promise<string> => toHex(await readFile(path));

// The EBINARY refusal, spelled once so every encoding test asserts the SAME sentence the
// tool owes a model: the path the caller passed, what is wrong with the bytes, and where
// the offending byte sits. `code` and `name` are both asserted because HarnessError sets
// `name` from the code (./util/errors.ts:31), and a caller switches on one while the
// message is the half that reaches the model.
const expectBinaryRefusal = async (
    call: () => Promise<unknown>,
    path: string,
    detail: string
): Promise<void> => {
    const failure = await call().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessError);

    const error = failure as HarnessError;
    expect(error.code).toBe('EBINARY');
    expect(error.name).toBe('EBINARY');
    expect(error.message).toBe(
        `edit refused "${path}": the file contains binary data (${detail}). ` +
            'edit reads and writes UTF-8 text, so it refuses a file it cannot rewrite byte for byte.'
    );
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-edit-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('edit', () => {
    it('replaces a unique match in one entry and reports the exact result', async () => {
        const path = await seed('unique.txt', 'x alpha y\n');

        const result = await edit([{ path, oldString: 'alpha', newString: 'beta' }]);

        expect(result).toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('x beta y\n', 'utf8') }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('x beta y\n');
    });

    it('applies several edits in one call, in the caller order', async () => {
        const first = await seed('batch/a.txt', 'one\n');
        const second = await seed('batch/b.txt', 'two\n');

        const result = await edit([
            { path: second, oldString: 'two', newString: 'TWO' },
            { path: first, oldString: 'one', newString: 'ONE' }
        ]);

        expect(result).toEqual([
            { path: second, replacements: 1, bytes: Buffer.byteLength('TWO\n', 'utf8') },
            { path: first, replacements: 1, bytes: Buffer.byteLength('ONE\n', 'utf8') }
        ]);
        await expect(readTextFile(first, 'utf8')).resolves.toBe('ONE\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('TWO\n');
    });

    it('refuses an ambiguous match and leaves the file untouched', async () => {
        const path = await seed('ambiguous.txt', 'a a a\n');

        // L4: three candidates on ONE line name that line ONCE. The match count is still
        // exact (3), and the named list is what a caller uses to find the candidates, so
        // "lines 1, 1, 1" used to spend three of the ten published slots repeating a fact
        // while pushing the lines that actually differ off the end of the list.
        await expect(edit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new HarnessError(
                `edit found 3 matches for oldString in ${path} (lines 1). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('a a a\n');
    });

    it('names each candidate line once, however many candidates share it', async () => {
        // L4, the other half: the list must still name the DISTINCT lines. Six matches
        // live on three lines here, and the answer a caller can act on is those three.
        const path = await seed('ambiguous-lines.txt', 'x\n\nx\n\nx\n');

        await expect(edit([{ path, oldString: 'x', newString: 'y' }])).rejects.toThrow(
            new HarnessError(
                `edit found 3 matches for oldString in ${path} (lines 1, 3, 5). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('x\n\nx\n\nx\n');
    });

    // CRASH REGRESSION. A broad oldString on a large file used to make the ambiguity
    // failure copy a fresh prefix of the file PER MATCH (O(file x matches)) and then
    // name every candidate line in the message. On a 3.3 MB file whose oldString
    // matched 200,000 times that was ~323 GB of temporary strings and a 1.5 MB error,
    // computed on the event loop (this tool is `mode: 'sync'` and the server defaults
    // to `threadExecution: 'inline'`), which stalled the whole server. Both the work
    // and the message are bounded now: one forward pass, ten named lines, exact count.
    it('fails an ambiguity on a large file quickly and names only the first candidate lines', async () => {
        const lines = 40_000;
        const source = 'line 0 data\n'.repeat(lines);
        const path = await seed('ambiguous-large.txt', source);

        const startedAt = Date.now();
        const failure = await edit([{ path, oldString: 'line ', newString: 'LINE ' }]).catch(
            (error: unknown) => error
        );
        const elapsedMs = Date.now() - startedAt;

        expect(failure).toBeInstanceOf(HarnessError);
        const message = (failure as Error).message;
        expect(message).toContain(
            `edit found ${lines} matches for oldString in ${path} (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and 39990 more).`
        );
        // The failure has to stay small enough to journal and cheap for a model to read.
        expect(message.length).toBeLessThan(600);
        // The old shape paid tens of seconds here; the bound is loose on purpose (a CI
        // box under load is slower) but far above what one pass over the text costs.
        expect(elapsedMs).toBeLessThan(5_000);
        await expect(readTextFile(path, 'utf8')).resolves.toBe(source);
    });

    it('replaces every occurrence on a large file without rebuilding it per match', async () => {
        const lines = 40_000;
        const source = 'line 0 data\n'.repeat(lines);
        const updated = 'LINE 0 data\n'.repeat(lines);
        const path = await seed('all-large.txt', source);

        const startedAt = Date.now();
        const result = await edit([
            { path, oldString: 'line ', newString: 'LINE ', replaceAll: true }
        ]);
        const elapsedMs = Date.now() - startedAt;

        expect(result).toEqual([{ path, replacements: lines, bytes: Buffer.byteLength(updated, 'utf8') }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe(updated);
        // Same trap on the success path: the old right-to-left splice reduce rebuilt the
        // whole file once per match.
        expect(elapsedMs).toBeLessThan(5_000);
    });

    it('replaces every occurrence when replaceAll is set', async () => {
        const path = await seed('all.txt', 'a a a\n');

        const result = await edit([{ path, oldString: 'a', newString: 'bb', replaceAll: true }]);

        expect(result).toEqual([
            { path, replacements: 3, bytes: Buffer.byteLength('bb bb bb\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('bb bb bb\n');
    });

    it('deletes text when newString is empty', async () => {
        const path = await seed('delete.txt', 'keep REMOVE keep\n');

        const result = await edit([{ path, oldString: ' REMOVE', newString: '' }]);

        expect(result).toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('keep keep\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('keep keep\n');
    });

    it('writes replacement text literally, without $-substitution', async () => {
        const path = await seed('literal.txt', 'price 10\n');

        await edit([{ path, oldString: '10', newString: '$& $1 $`' }]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('price $& $1 $`\n');
    });

    it('rejects a missing match', async () => {
        const path = await seed('missing.txt', 'nothing here\n');

        await expect(edit([{ path, oldString: 'absent', newString: 'x' }])).rejects.toThrow(
            new HarnessError(
                `edit found no match for oldString in ${path}. Read the file first and copy the text exactly, including indentation.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('nothing here\n');
    });

    // ---------------------------------------------------------------------
    // The two fallback tiers. They run ONLY when the tier above found nothing, and
    // the trailing-whitespace finder was rewritten from a per-line object/array
    // allocation to a single forward pass, so its edge cases are pinned here rather
    // than assumed: the window, the overlap rule, empty lines, a file with no final
    // newline, and CRLF content-end handling.
    // ---------------------------------------------------------------------

    it('prefers the exact tier and reports no match tier', async () => {
        // The file holds ASCII quotes and no trailing whitespace, so an exact copy
        // matches at tier 1 and the result carries no `match` field at all.
        const path = await seed('tiers/exact.txt', 'say "hello" world\n');

        const result = await edit([{ path, oldString: 'say "hello"', newString: 'say "hi"' }]);

        expect(result).toEqual([{
            path,
            replacements: 1,
            bytes: Buffer.byteLength('say "hi" world\n', 'utf8')
        }]);
    });

    it('matches typographic lookalikes and names the tier', async () => {
        // The file has curly quotes; the caller retyped ASCII ones. Tier 1 finds
        // nothing, tier 2 folds them, and the result must SAY the match was not exact.
        const path = await seed('tiers/curly.txt', 'say \u201Chello\u201D world\n');

        const result = await edit([{ path, oldString: 'say "hello"', newString: 'say "hi"' }]);

        expect(result).toEqual([
            {
                path,
                replacements: 1,
                bytes: Buffer.byteLength('say "hi" world\n', 'utf8'),
                match: 'typographic'
            }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('say "hi" world\n');
    });

    it('ignores trailing whitespace and names the tier', async () => {
        const path = await seed('tiers/trailing.txt', 'alpha   \nbeta\t\ngamma\n');

        const result = await edit([
            { path, oldString: 'alpha\nbeta\ngamma', newString: 'ONE\nTWO\nTHREE' }
        ]);

        expect(result[0].match).toBe('trailing-whitespace');
        // The replacement is written as given; the file's trailing whitespace lived
        // inside the matched region, so it goes away with it.
        await expect(readTextFile(path, 'utf8')).resolves.toBe('ONE\nTWO\nTHREE\n');
    });

    // M4, by design and pinned. The trailing-whitespace tier COMPARES whole lines (with
    // trailing whitespace ignored), so what it REPLACES is the whole-line span, not the
    // caller's oldString. These are the two shapes the stress report called surprising:
    // whitespace the caller never named disappears, including the final newline of the
    // last matched line. The receipt says `match: "trailing-whitespace"`, which is the
    // honest half — the tier is what widened the region. Changing the span to end where
    // oldString ends would keep the file's trailing whitespace, and would make the tier
    // rewrite bytes the caller did copy; reporting the replaced span instead (a receipt
    // that says "N lines replaced") is the follow-up option, not this behaviour.
    it('replaces the whole matched lines through the trailing-whitespace tier, tabs and all', async () => {
        const path = await seed('tiers/wide-tabs.txt', 'a   \nb\t\t\nz\n');

        const result = await edit([{ path, oldString: 'a\nb', newString: 'Q' }]);

        // 'Q\nz\n' is 4 bytes, and the `b\t\t` tabs are gone with the line they lived on.
        expect(result).toEqual([
            { path, replacements: 1, bytes: 4, match: 'trailing-whitespace' }
        ]);
        await expect(readHex(path)).resolves.toBe('51 0a 7a 0a');
    });

    it('takes the final newline of the last matched line on the trailing-whitespace tier', async () => {
        const path = await seed('tiers/wide-final.txt', 'a   \nb\n');

        const result = await edit([{ path, oldString: 'a\nb', newString: 'Q' }]);

        // The search has NO trailing newline, so the span stops at the END OF LINE 2's
        // CONTENT (before its newline, and before a CRLF's CR — see `contentEnds` in
        // findLineOccurrences): 'a   \nb' is replaced and the file's own final newline is
        // the only thing left after 'Q'.
        expect(result).toEqual([{ path, replacements: 1, bytes: 2, match: 'trailing-whitespace' }]);
        await expect(readHex(path)).resolves.toBe('51 0a');
    });

    it('finds a trailing-whitespace window in the middle of many lines', async () => {
        // Exercises the sliding window: the match starts at line 402 of 800, so a
        // one-pass scan must still align the window and report the right offsets.
        const before = Array.from({ length: 401 }, (_, index) => `filler ${index}\n`).join('');
        const path = await seed('tiers/middle.txt', `${before}target one  \ntarget two\ntarget three \ntail\n`);

        const result = await edit([
            { path, oldString: 'target one\ntarget two\ntarget three', newString: 'REPLACED' }
        ]);

        expect(result[0].match).toBe('trailing-whitespace');
        await expect(readTextFile(path, 'utf8')).resolves.toBe(`${before}REPLACED\ntail\n`);
    });

    it('matches a window containing empty lines', async () => {
        // The old regex enumeration included empty lines, and the rewrite must too:
        // dropping them would shift every window and miss this match entirely.
        const path = await seed('tiers/empty-lines.txt', 'a\n\n\nb   \nc\n');

        const result = await edit([{ path, oldString: 'a\n\n\nb\nc', newString: 'X' }]);

        expect(result[0].match).toBe('trailing-whitespace');
        await expect(readTextFile(path, 'utf8')).resolves.toBe('X\n');
    });

    it('matches a final line that has no newline', async () => {
        // A file not ending in "\n" still contributes an unterminated last line, and a
        // search WITHOUT a trailing newline must be able to end there. Both lines carry
        // trailing spaces so the exact tier cannot match and tier 3 is the only route.
        const path = await seed('tiers/no-final-newline.txt', 'head   \ntail   ');

        const result = await edit([{ path, oldString: 'head\ntail', newString: 'done' }]);

        expect(result[0].match).toBe('trailing-whitespace');
        // The unterminated last line stays unterminated: the replacement ends the file.
        await expect(readTextFile(path, 'utf8')).resolves.toBe('done');
    });

    it('keeps the carriage return when a CRLF window is matched without a trailing newline', async () => {
        // The tier compares the LF view, so a match that does NOT demand a trailing
        // newline must stop before the "\r"; otherwise the file's endings would be
        // silently rewritten. The replacement's own lines still take the region's CRLF.
        const path = await seed('tiers/crlf.txt', 'one\r\ntwo   \r\nthree\r\n');

        const result = await edit([{ path, oldString: 'one\ntwo\nthree', newString: 'A\nB\nC' }]);

        expect(result[0].match).toBe('trailing-whitespace');
        await expect(readTextFile(path, 'utf8')).resolves.toBe('A\r\nB\r\nC\r\n');
    });

    it('matches a single-line oldString in a CRLF file without folding the file', async () => {
        // D7. A one-line oldString (no CR, no LF) can be matched against the RAW source:
        // folding CRLF to LF deletes only carriage returns, and this string contains
        // none, so an occurrence cannot straddle a line boundary and the match sets are
        // identical — at identical offsets. That removes a whole-file copy plus a
        // per-CRLF position array from the common case (measured: a tier-1 hit on a
        // 2.5 MB CRLF file, 90.8 ms -> 22.3 ms).
        const path = await seed('fast/crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');

        const result = await edit([{ path, oldString: 'beta', newString: 'BETA!' }]);

        // 'alpha\r\nBETA!\r\ngamma\r\n' is 5+2 + 5+2 + 5+2 = 21 bytes.
        expect(result).toEqual([{ path, replacements: 1, bytes: 21 }]);
        // The file's CRLF endings survive untouched, exactly as before the fast path.
        await expect(readTextFile(path, 'utf8')).resolves.toBe('alpha\r\nBETA!\r\ngamma\r\n');
    });

    it('keeps a single-line edit exact when the file has mixed endings', async () => {
        // The fast path must not quietly become a line-ending policy. Each line keeps
        // whatever it already had, because only the matched text is replaced.
        const path = await seed('fast/mixed.txt', 'one\r\ntwo\nthree\r\n');

        await edit([{ path, oldString: 'two', newString: 'TWO' }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('one\r\nTWO\nthree\r\n');

        await edit([{ path, oldString: 'three', newString: 'THREE' }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('one\r\nTWO\nTHREE\r\n');
    });

    it('still finds a multi-line oldString that only exists in the folded view', async () => {
        // The other half of the fast-path argument: when the raw search finds nothing,
        // the full cascade still runs, so a CR-deletion that CREATES a match is not
        // lost. A multi-line oldString is where that matters.
        const path = await seed('fast/fold-only.txt', 'one\r\ntwo\r\nthree\r\n');

        const result = await edit([{ path, oldString: 'one\ntwo\nthree', newString: 'A\nB\nC' }]);

        expect(result[0].replacements).toBe(1);
        // Matched through the view, re-joined with the region's dominant CRLF.
        await expect(readTextFile(path, 'utf8')).resolves.toBe('A\r\nB\r\nC\r\n');
    });

    it('writes a newline-free newString verbatim, with no ending chosen for it', async () => {
        // A replacement with no newline is ONE line, and a one-line replacement never
        // receives an ending (its only line is also its last line). So skipping the
        // region and whole-file ending scans cannot change the bytes written — and on a
        // large file it removes a full rescan per call.
        const path = await seed('fast/verbatim.txt', 'alpha\r\nbeta\r\n');

        await edit([{ path, oldString: 'alpha\r\n', newString: 'ALPHA\r\n' }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('ALPHA\r\nbeta\r\n');

        // A newline-free newString replacing text that spanned an ending: the result is
        // the newString itself, and the surrounding endings are the file's own.
        await edit([{ path, oldString: 'ALPHA\r\nbeta', newString: 'MERGED' }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('MERGED\r\n');
    });

    it('aligns a huge region positionally instead of paying for a quadratic table', async () => {
        // D8. The LCS in alignLines exists only to pick a line ending per replaced line,
        // and it cost O(before x after) in time AND memory: a 5,000 x 5,000 region was
        // 275 ms and a 95 MB Uint32Array. Past the cell cap the mapping is positional,
        // which gives the same answer whenever the two sides line up — the shape of a
        // line-for-line rewrite — for a fraction of the cost.
        const lines = (marker: string, count: number) =>
            Array.from({ length: count }, (_, i) => `${marker}${i}`).join('\n');
        const path = await seed('align/big.txt', lines('a', 5000));

        const result = await edit([{ path, oldString: lines('a', 5000), newString: lines('b', 5000) }]);

        expect(result[0].replacements).toBe(1);
        await expect(readTextFile(path, 'utf8')).resolves.toBe(lines('b', 5000));

        // Under the cap the LCS still runs, and a replaced line still takes the ending
        // of the line it stands in for — NOT the region's dominant ending. That is the
        // behaviour the cap must not erase, and a mixed-ending region is where the two
        // answers differ: CRLF dominates here, yet line 2 keeps its own bare LF.
        const mixed = await seed('align/small-mixed.txt', 'x1\r\nx2\nx3\r\n');
        await edit([{ path: mixed, oldString: 'x1\nx2\nx3', newString: 'y1\ny2\ny3' }]);
        await expect(readTextFile(mixed, 'utf8')).resolves.toBe('y1\r\ny2\ny3\r\n');
    });

    // ---------------------------------------------------------------------
    // H6 — the line-ending contract, pinned as BYTES in both directions.
    //
    //   - a newString with NO carriage return adopts the endings of the file (the
    //     documented default: "write oldString and newString with \n even for a CRLF
    //     file"), and a line that keeps a region line keeps that line's ending;
    //   - a newString that CONTAINS a carriage return is ending-explicit and is written
    //     verbatim, so an explicit "\r\n" is neither rewritten into the file's endings
    //     nor answered with a carriage return the caller did not type.
    //
    // Before this rule `foldLf(newString)` deleted every "\r\n" the caller passed and
    // left every LONE "\r" in place, which the region join then hung off the end of a
    // line — the bytes below are the rows that made the report, and each one names the
    // shape it covers.
    // ---------------------------------------------------------------------

    it('writes an explicit CRLF newString into an LF file instead of folding it to LF', async () => {
        // The report's "explicit CRLF on an LF file is discarded" rows. Each one now
        // carries the caller's CR: 0d 0a, exactly where the caller typed it.
        const single = await seedBytes('h6/lf-single.txt', '61 0a 62 0a');
        await edit([{ path: single, oldString: 'b', newString: 'B\r\nX' }]);
        await expect(readHex(single)).resolves.toBe('61 0a 42 0d 0a 58 0a');

        const region = await seedBytes('h6/lf-region.txt', '61 0a 62 0a');
        await edit([{ path: region, oldString: 'a\nb', newString: 'A\r\nB' }]);
        await expect(readHex(region)).resolves.toBe('41 0d 0a 42 0a');

        // A trailing "\r\n" in newString used to fold into an extra LF (the caller asked
        // for one ending and got two), and a doubled CR used to come back single because
        // the fold removed exactly one CR from it.
        const trailing = await seedBytes('h6/lf-trailing.txt', '61 0a 62 0a');
        await edit([{ path: trailing, oldString: 'a\nb', newString: 'A\nB\r\n' }]);
        await expect(readHex(trailing)).resolves.toBe('41 0a 42 0d 0a 0a');

        const doubled = await seedBytes('h6/lf-doubled.txt', '61 0a 62 0a');
        await edit([{ path: doubled, oldString: 'a\nb', newString: 'A\r\r\nB' }]);
        await expect(readHex(doubled)).resolves.toBe('41 0d 0d 0a 42 0a');
    });

    it('writes a mixed newString on a CRLF file exactly as the caller spelled it', async () => {
        // The same rule on the other kind of file: the caller wrote line 1 with a bare LF
        // and line 2 with CRLF, so that is what the file holds. It used to come back as
        // 41 0d 0a 42 0d 0a 0d 0a — the tool converting a line the caller had chosen.
        const path = await seedBytes('h6/crlf-mixed.txt', '61 0d 0a 62 0d 0a');
        await edit([{ path, oldString: 'a\nb', newString: 'A\nB\r\n' }]);
        await expect(readHex(path)).resolves.toBe('41 0a 42 0d 0a 0d 0a');

        // A doubled CR inside newString is the caller's own byte, not one the tool adds
        // after a fold the way it used to (41 0d 0d 0a via region re-joining).
        const doubled = await seedBytes('h6/crlf-doubled.txt', '61 0d 0a 62 0d 0a');
        await edit([{ path: doubled, oldString: 'a\nb', newString: 'A\r\r\nB' }]);
        await expect(readHex(doubled)).resolves.toBe('41 0d 0d 0a 42 0d 0a');

        // The one honest doubling left, and why it is honest: newString ENDS in a lone CR
        // and the CR that follows it belongs to the file, outside the matched span ('b'
        // was matched, its CR was not). The tool writes the caller's bytes and nothing
        // else's; a caller who wants the file's ending replaced matches the ending.
        const lone = await seedBytes('h6/crlf-lone-cr.txt', '78 0d 0a 62 0d 0a');
        await edit([{ path: lone, oldString: 'b', newString: 'B\r' }]);
        await expect(readHex(lone)).resolves.toBe('78 0d 0a 42 0d 0d 0a');
    });

    it('keeps a LF-only newString adopting the endings of the file, line by line', async () => {
        // THE DOCUMENTED DEFAULT, which the ending-explicit rule must not break: no CR in
        // newString means the file decides. A CRLF file keeps CRLF, an LF file keeps LF,
        // and a MIXED region hands each line back the ending that line already had.
        const crlf = await seedBytes('h6/default-crlf.txt', '61 0d 0a 62 0d 0a');
        await edit([{ path: crlf, oldString: 'a\r\nb', newString: 'A\nB' }]);
        await expect(readHex(crlf)).resolves.toBe('41 0d 0a 42 0d 0a');

        const lf = await seedBytes('h6/default-lf.txt', '61 0a 62 0a');
        await edit([{ path: lf, oldString: 'a\nb', newString: 'A\nB' }]);
        await expect(readHex(lf)).resolves.toBe('41 0a 42 0a');

        const mixed = await seedBytes('h6/default-mixed.txt', '6f 6e 65 0d 0a 74 77 6f 0a 74 68 72 65 65 0d 0a');
        await edit([{ path: mixed, oldString: 'one\ntwo\nthree', newString: 'A\nB\nC' }]);
        await expect(readHex(mixed)).resolves.toBe('41 0d 0a 42 0a 43 0d 0a');
    });

    it('still changes the endings themselves through the differ-only-in-CR form', async () => {
        // The other documented route to a line-ending change: oldString and newString that
        // differ ONLY in carriage returns match the RAW bytes, so LF->CRLF converts exactly
        // the region that was matched and nothing else.
        const path = await seedBytes('h6/endings-only.txt', '61 0a 62 0a');
        await edit([{ path, oldString: 'a\nb', newString: 'a\r\nb' }]);
        await expect(readHex(path)).resolves.toBe('61 0d 0a 62 0a');
    });

    it('never forgives indentation on the trailing-whitespace tier', async () => {
        // Leading whitespace is NOT ignored: a wrong-indent oldString simply does not
        // match, which is the failure mode the flexible replacers got wrong.
        const path = await seed('tiers/indent.txt', '    alpha\n    beta\n');

        await expect(
            edit([{ path, oldString: 'alpha\nbeta', newString: 'X' }])
        ).rejects.toThrow('edit found no match for oldString');
        await expect(readTextFile(path, 'utf8')).resolves.toBe('    alpha\n    beta\n');
    });

    it('does not double-count overlapping trailing-whitespace candidates', async () => {
        // A two-line search matches at line 1, then again at line 2 (overlapping the
        // first), then again at line 3. The overlap rule keeps only the first and third,
        // so replaceAll rewrites two DISJOINT regions and the middle line survives once.
        const path = await seed('tiers/overlap.txt', 'x\ny   \nx\ny\n');

        const result = await edit([{ path, oldString: 'x\ny\nx', newString: 'M', replaceAll: true }]);

        expect(result[0].match).toBe('trailing-whitespace');
        expect(result[0].replacements).toBe(1);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('M\ny\n');
    });

    it('answers a miss on a large file in one pass', async () => {
        // The performance regression this pins. The tier used to build an object per
        // line and a fresh array slice per candidate position, so a MISS on a big file
        // allocated two arrays the size of the line count before answering. A miss must
        // now cost roughly the linear scan it is.
        const lines = 120_000;
        const body = Array.from({ length: lines }, (_, index) => `line ${index} const value = compute(a, b);\n`).join('');
        const path = await seed('tiers/big-miss.txt', body);

        const started = Date.now();
        // Nothing matches, so all three tiers run and the whole file is walked.
        await expect(
            edit([{ path, oldString: 'a string that is not in this file at all', newString: 'x' }])
        ).rejects.toThrow('edit found no match for oldString');
        const elapsed = Date.now() - started;

        // Generous on a fast machine, and still an order of magnitude below the ~2.5 s
        // the allocating version measured on a comparable file.
        expect(elapsed).toBeLessThan(1500);
    });

    it('leaves every earlier file untouched when a later edit does not match', async () => {
        // This is the whole reason batching is safe: the preflight reads and
        // match-checks ALL entries before the first write.
        const first = await seed('preflight/a.txt', 'alpha\n');
        const second = await seed('preflight/b.txt', 'beta\n');

        await expect(
            edit([
                { path: first, oldString: 'alpha', newString: 'ALPHA' },
                { path: second, oldString: 'absent', newString: 'x' }
            ])
        ).rejects.toThrow(new RegExp(`edit found no match for oldString in ${escapeRegExp(second)}`));

        await expect(readTextFile(first, 'utf8')).resolves.toBe('alpha\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('beta\n');
    });

    // ---------------------------------------------------------------------
    // H7 — the encoding boundary. The target is read as BYTES and must decode as UTF-8
    // with no NUL, or the call is refused with EBINARY naming the byte offset, which is
    // the contract `read` already publishes (./read.tool.ts). Before this, `readFile`'s
    // lossy UTF-8 decoding substituted U+FFFD for whatever it could not read and the
    // write phase saved the substitution back, so an edit of a Latin-1 file rewrote a
    // byte the caller never named — bytes 63 61 66 e9 20 78 came back as the eight bytes
    // 43 61 66 ef bf bd 20 78 and the call reported a plain success.
    // ---------------------------------------------------------------------

    it('refuses a non-UTF-8 target with EBINARY naming the byte offset, and rewrites nothing', async () => {
        // The report's exact row: 'caf' 0xE9 ' x' (a Latin-1 'é'), edited at 'c'. The
        // invalid sequence STARTS at offset 3, and the file is still 6 bytes.
        const path = await seedBytes('encoding/latin1.txt', '63 61 66 e9 20 78');

        await expectBinaryRefusal(
            () => edit([{ path, oldString: 'c', newString: 'C' }]),
            path,
            'invalid UTF-8 at offset 3'
        );
        await expect(readHex(path)).resolves.toBe('63 61 66 e9 20 78');
    });

    it('names the first invalid sequence for every UTF-8 shape the decoder rejects', async () => {
        // Each row is one arm of the decoder's rejection table, and the offset is the
        // START of the offending sequence — where a caller has to go look. A truncated
        // sequence reports its lead byte, because that is where it began.
        const shapes: Array<[string, string]> = [
            ['41 c0 80 0a', '1'], // overlong two-byte form (C0 is never a lead byte)
            ['41 ed a0 80 0a', '1'], // ED A0..BF would encode a surrogate
            ['41 f4 90 80 80 0a', '1'], // past U+10FFFF
            ['41 e9 0a', '1'], // three-byte lead with no continuations: truncated
            ['41 e9 20 0a', '1'], // continuation byte is an ASCII space
            ['80 41 0a', '0'] // stray continuation byte
        ];

        for (const [index, [hex, offset]] of shapes.entries()) {
            const path = await seedBytes(`encoding/shape-${index}.txt`, hex);

            await expectBinaryRefusal(
                () => edit([{ path, oldString: 'A', newString: 'B' }]),
                path,
                `invalid UTF-8 at offset ${offset}`
            );
            await expect(readHex(path)).resolves.toBe(hex);
        }
    });

    it('refuses a target holding a NUL byte, the way read and write already do', async () => {
        // A NUL is valid UTF-8, so the decoder would have accepted it — but `read` calls
        // the file binary and `write` will not create it, so an edit that accepted one was
        // rewriting a file no other tool in this package can open again.
        const path = await seedBytes('encoding/nul.txt', '41 00 41 0a');

        await expectBinaryRefusal(
            () => edit([{ path, oldString: 'A', newString: 'B' }]),
            path,
            'NUL byte at offset 1'
        );
        await expect(readHex(path)).resolves.toBe('41 00 41 0a');
    });

    it('leaves every earlier file untouched when a later target is not valid UTF-8', async () => {
        // The refusal is a PREFLIGHT decision, so the all-or-nothing guarantee covers it:
        // an edited-and-then-refused batch writes nothing, exactly like a batch whose last
        // oldString is missing.
        const good = await seedBytes('encoding/preflight-good.txt', '61 0a');
        const bad = await seedBytes('encoding/preflight-bad.txt', '61 e9 0a');

        await expectBinaryRefusal(
            () =>
                edit([
                    { path: good, oldString: 'a', newString: 'A' },
                    { path: bad, oldString: 'a', newString: 'B' }
                ]),
            bad,
            'invalid UTF-8 at offset 1'
        );
        await expect(readHex(good)).resolves.toBe('61 0a');
        await expect(readHex(bad)).resolves.toBe('61 e9 0a');
    });

    it('rewrites a valid UTF-8 target byte for byte, BOM and astral code points included', async () => {
        // The other half of H7: refusing is only right if a good file is untouched except
        // where the edit put it. A BOM survives (a decoder that stripped it would silently
        // delete three bytes from every BOM file this tool edited), and a multi-byte code
        // point is neither substituted nor split.
        const bom = await seedBytes('encoding/bom.txt', 'ef bb bf 41 0a');
        expect(await edit([{ path: bom, oldString: 'A', newString: 'B' }])).toEqual([
            { path: bom, replacements: 1, bytes: 5 }
        ]);
        await expect(readHex(bom)).resolves.toBe('ef bb bf 42 0a');

        const astral = await seedBytes('encoding/astral.txt', 'f0 9f 98 80 41 0a');
        expect(await edit([{ path: astral, oldString: 'A', newString: 'B' }])).toEqual([
            { path: astral, replacements: 1, bytes: 6 }
        ]);
        await expect(readHex(astral)).resolves.toBe('f0 9f 98 80 42 0a');

        const twoByte = await seedBytes('encoding/two-byte.txt', '41 c3 a9 0a');
        expect(await edit([{ path: twoByte, oldString: 'A', newString: 'B' }])).toEqual([
            { path: twoByte, replacements: 1, bytes: 4 }
        ]);
        await expect(readHex(twoByte)).resolves.toBe('42 c3 a9 0a');
    });

    it('applies several entries that name one file, in array order', async () => {
        // CURRENT contract: one edit per file is no longer a rule. Two entries may name
        // the same file, they are applied in ARRAY order, each matched against the text
        // the previous one produced, and the file is written ONCE with the final text.
        // (Aligned with the shipped implementation; an earlier revision rejected the
        // batch outright.)
        const path = await seed('duplicate.txt', 'alpha\nbeta\n');

        await expect(
            edit([
                { path, oldString: 'alpha', newString: 'one' },
                { path: join(workdir, '.', 'duplicate.txt'), oldString: 'beta', newString: 'two' }
            ])
        // `bytes` is reported per file IDENTITY (the file's size once the batch ran),
        // so both entries naming one file carry the same count.
        ).resolves.toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') },
            { path, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') }
        ]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('one\ntwo\n');
    });

    it('treats two spellings of one file as one file, judged by this platform', async () => {
        // T16 judged duplicitous spellings by FILE IDENTITY. CURRENT contract keeps that
        // identity judgement but no longer rejects the batch: on Windows
        // "alias.txt"/"ALIAS.TXT" are the SAME file, so both entries are applied to it in
        // array order (each result naming the path that entry asked for), while on Linux
        // they are two files and both edits apply.
        const lower = await seed('alias.txt', 'alpha\nbeta\n');
        const upper = join(workdir, 'ALIAS.TXT');

        if (process.platform === 'win32') {
            await expect(
                edit([
                    { path: lower, oldString: 'alpha', newString: 'one' },
                    { path: upper, oldString: 'beta', newString: 'two' }
                ])
            ).resolves.toEqual([
                // Same file, so the same final byte count on both entries; each still
                // names the path that entry asked for.
                { path: lower, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') },
                { path: upper, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') }
            ]);

            await expect(readTextFile(lower, 'utf8')).resolves.toBe('one\ntwo\n');
            return;
        }

        // Linux keeps the two spellings apart, so `other` below is a SECOND file: both
        // entries then name different identities and each result reports the bytes of
        // the file that entry named. `lower` still holds the text seeded above, so its
        // oldString comes from that text.
        const other = await seed('ALIAS.TXT', 'other\n');

        await expect(
            edit([
                { path: lower, oldString: 'alpha', newString: 'one' },
                { path: other, oldString: 'other', newString: 'two' }
            ])
        ).resolves.toEqual([
            { path: lower, replacements: 1, bytes: Buffer.byteLength('one\nbeta\n', 'utf8') },
            { path: other, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') }
        ]);
        await expect(readTextFile(lower, 'utf8')).resolves.toBe('one\nbeta\n');
        await expect(readTextFile(other, 'utf8')).resolves.toBe('two\n');
    });

    it('applies two spellings that reach one file through a symlink as one file', async () => {
        // Creating a symlink is privileged on Windows (Developer Mode or elevated),
        // so the guard is "could we create it", not the platform name. Where the link
        // cannot be created there is nothing to prove, so the fixture is asserted
        // untouched and the case ends.
        //
        // CURRENT contract (T20): a symlink alias is no longer a rejected duplicate.
        // realpath() collapses `linked/target.txt` and `linked-alias/target.txt` onto
        // one identity (./identity.ts), so both entries are ONE file, applied in array
        // order, written once.
        const real = await seed('linked/target.txt', 'alpha\nbeta\n');
        const alias = join(workdir, 'linked-alias');

        try {
            await symlink(join(workdir, 'linked'), alias, 'dir');
        } catch {
            await expect(readTextFile(real, 'utf8')).resolves.toBe('alpha\nbeta\n');
            return;
        }

        const throughLink = join(alias, 'target.txt');

        await expect(
            edit([
                { path: real, oldString: 'alpha', newString: 'one' },
                // 'one\nbeta' exists only in the text the FIRST entry produced, so
                // matching it through the alias proves the two spellings are one file
                // with a defined order rather than two independent writes.
                { path: throughLink, oldString: 'one\nbeta', newString: 'two' }
            ])
        ).resolves.toEqual([
            // One identity, so one final byte count carried by both entries; each entry
            // still names the path it asked for (identity is for comparing, never for
            // reporting).
            { path: real, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') },
            { path: throughLink, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') }
        ]);

        // Written exactly once, through the first-appearance spelling; reading through
        // the alias shows the same bytes, so no second file appeared beside it.
        await expect(readTextFile(real, 'utf8')).resolves.toBe('two\n');
        await expect(readTextFile(throughLink, 'utf8')).resolves.toBe('two\n');
    });

    it('rejects a non-boolean replaceAll, an empty newString type error, and an unknown field', async () => {
        const path = await seed('validation.txt', 'text\n');

        await expect(
            edit([{ path, oldString: 'text', newString: 'x', replaceAll: 'yes' as never }])
        ).rejects.toThrow(new HarnessError('edit replaceAll must be a boolean when provided.'));
        await expect(
            edit([{ path, oldString: 'text', newString: 7 as never }])
        ).rejects.toThrow(new HarnessError('edit requires a "newString" string.'));

        // M9: the schema refuses unknown fields, but a direct call never sees the schema,
        // and `{ replaceAll: true, replace: 'all' }` used to be silently dropped — the
        // entry applied ONE replacement and reported success.
        await expect(
            edit([{ path, oldString: 'text', newString: 'x', replace: 'all' as never }])
        ).rejects.toThrow(
            new HarnessError(
                `edit edits entries do not accept "replace". Allowed fields: path, oldString, newString, replaceAll.`
            )
        );

        await expect(readTextFile(path, 'utf8')).resolves.toBe('text\n');
    });

    it('rejects an empty array, a non-array, and malformed entries', async () => {
        await expect(edit([])).rejects.toThrow(
            'edit received an empty edits array; pass at least one edit.'
        );
        await expect(edit('a.txt' as never)).rejects.toThrow(
            'edit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
        await expect(edit([null] as never)).rejects.toThrow(
            'edit edits must be objects with "path", "oldString", and "newString" strings.'
        );
        await expect(edit([{ path: 'a.txt', oldString: 'a' }] as never)).rejects.toThrow(
            'edit requires a "newString" string.'
        );
        await expect(
            edit([{ path: 'a\u0000b', oldString: 'a', newString: 'b' }])
        ).rejects.toThrow('edit paths must not contain NUL characters.');
        await expect(edit([{ path: '', oldString: 'a', newString: 'b' }])).rejects.toThrow(
            'edit edits require a non-empty "path" string.'
        );
    });

    it('rejects a batch larger than the published cap, before reading anything', async () => {
        // M12. `read`, `write` and `files` each refuse a batch over 100 targets; `edit`
        // carried no cap, so one call could name an arbitrary number of files, hold a
        // per-file lock on every one of them, and return a result of arbitrary length.
        // The refusal comes BEFORE the first read, so the rejected batch left nothing
        // behind — the paths below were never created, which is what the ENOENT check
        // proves.
        const tooMany = Array.from({ length: 101 }, (_, index) => ({
            path: join(workdir, 'cap', `${index}.txt`),
            oldString: 'a',
            newString: 'b'
        }));

        await expect(edit(tooMany)).rejects.toThrow(
            'edit accepts at most 100 edits per call; received 101. Split the batch.'
        );
        await expect(readTextFile(join(workdir, 'cap', '0.txt'), 'utf8')).rejects.toThrow(/ENOENT/);

        // Exactly AT the cap is accepted: one result entry per entry, each naming the
        // path it asked for, each reporting the 2 bytes ('b' + newline) its file ended
        // with.
        const atCap = await Promise.all(
            Array.from({ length: 100 }, (_, index) => seedBytes(`cap-ok/${index}.txt`, '61 0a'))
        );

        expect(await edit(atCap.map((path) => ({ path, oldString: 'a', newString: 'b' })))).toEqual(
            atCap.map((path) => ({ path, replacements: 1, bytes: 2 }))
        );
    });

    it('reports the real final byte size of every entry, never a placeholder', async () => {
        // L7. `bytes` used to be `sizes.get(identity) ?? 0`. The `?? 0` was unreachable by
        // construction (every prepared identity is a key of the map the write loop fills),
        // but it reported a CONFIDENT zero had the bookkeeping ever missed — so it is now a
        // throw, and this pins the invariant that guard protects: every entry names the
        // size the file really ended with, including the two entries that share one file
        // and the multi-byte text where the character count and the byte count differ.
        const shared = await seed('sizes/shared.txt', 'alpha\nbeta\n');
        const texted = await seed('sizes/multibyte.txt', 'caf\u00E9\n');

        expect(
            await edit([
                { path: shared, oldString: 'alpha', newString: 'one' },
                { path: texted, oldString: 'caf\u00E9', newString: 'CAF\u00C9' },
                { path: shared, oldString: 'one\nbeta', newString: 'two' }
            ])
        ).toEqual([
            { path: shared, replacements: 1, bytes: 4 },
            // 'CAF' + U+00C9 (two UTF-8 bytes) + newline: 6 bytes for 5 characters.
            { path: texted, replacements: 1, bytes: 6 },
            { path: shared, replacements: 1, bytes: 4 }
        ]);

        await expect(readHex(shared)).resolves.toBe('74 77 6f 0a');
        await expect(readHex(texted)).resolves.toBe('43 41 46 c3 89 0a');
    });

    it('does not create a file that is missing, and says what to use instead', async () => {
        const path = join(workdir, 'absent', 'new.txt');

        // D8: the raw errno (`ENOENT: no such file or directory, open '...'`) named no
        // remedy. `edit` deliberately never creates, so the answer is always `write`,
        // and the message must say so.
        await expect(edit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new RegExp(`edit could not find ${escapeRegExp(path)}: no such file or directory \\(ENOENT\\)\\. edit changes an EXISTING file; use write to create one\\.$`)
        );
        await expect(readTextFile(path, 'utf8')).rejects.toThrow();
    });

    it('names a directory target as a directory rather than a permission problem', async () => {
        // Windows reports EPERM for reading a directory, which by code alone looks like
        // a denial. One stat after the failure decides, and the message names the tool
        // that can take a directory.
        const directory = join(workdir, 'a-directory');
        await mkdir(directory, { recursive: true });

        await expect(edit([{ path: directory, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new RegExp(`edit was given the directory ${escapeRegExp(directory)}`)
        );
    });

    it('serializes concurrent edits of one file so neither update is lost', async () => {
        // D4, the regression this pins. Read-match-write is three awaits, so before the
        // per-file lock (./lock.ts) all three calls read `VERSION-0`, all three matched,
        // all three reported success, and the file ended at whichever write landed last
        // — an answer nobody asked for. With the lock the later calls see the earlier
        // call's text, so exactly one applies and the rest fail honestly.
        const path = await seed('race.txt', 'VERSION-0\n');

        const texts = ['VERSION-A', 'VERSION-B', 'VERSION-C'];
        const results = await Promise.allSettled(
            texts.map((newString) => edit([{ path, oldString: 'VERSION-0', newString }]))
        );

        const applied = results
            .map((outcome, index) => ({ outcome, index }))
            .filter(({ outcome }) => outcome.status === 'fulfilled');
        const rejected = results.filter(
            (outcome) => outcome.status === 'rejected' && /edit found no match/.test(String(outcome.reason))
        );

        // Exactly one caller may claim success, and every other one must say why it
        // did not — never a silent third answer.
        expect(applied).toHaveLength(1);
        expect(rejected).toHaveLength(2);

        // The file holds the edit that was reported as applied, whichever one that was
        // (asserting the winner's own text keeps this independent of arrival order).
        await expect(readTextFile(path, 'utf8')).resolves.toBe(`${texts[applied[0].index]}\n`);
    });

    it('serializes a concurrent write and edit of one file', async () => {
        // The same lock covers `write`, so a write and an edit of one path cannot both
        // claim success against text the other one overwrote.
        const path = await seed('race-write.txt', 'ONE\n');

        const [written, edited] = await Promise.allSettled([
            write([{ path, content: 'FROM-WRITE\n' }]),
            edit([{ path, oldString: 'ONE', newString: 'FROM-EDIT' }])
        ]);

        expect(written.status).toBe('fulfilled');
        expect(edited.status === 'fulfilled' || /edit found no match/.test(String(edited.reason))).toBe(true);

        const text = await readTextFile(path, 'utf8');
        // Whichever ran first, the file holds ONE complete result rather than a mix.
        expect(['FROM-WRITE\n', 'FROM-EDIT\n']).toContain(text);
    });

    it('declares a single "edits" array property capped at 100 entries', () => {
        expect(edit.parameters).toEqual({
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    // M12: the cap is published in the schema, the same way `write`
                    // publishes its own, and the runtime rejection names the same number.
                    maxItems: 100,
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description:
                                    'Path to an existing file, absolute or relative to the working directory.'
                            },
                            oldString: {
                                type: 'string',
                                description: 'Exact text to replace. Must be unique unless replaceAll is true.'
                            },
                            newString: {
                                type: 'string',
                                description: 'Replacement text. May be empty to delete the matched text.'
                            },
                            replaceAll: {
                                type: 'boolean',
                                description:
                                    'Replace every occurrence instead of requiring oldString to be unique. Defaults to false.'
                            }
                        },
                        required: ['path', 'oldString', 'newString'],
                        additionalProperties: false
                    },
                    description:
                        'Edits to apply, in the order the results are returned. Several entries may name the same file; they are applied in array order.'
                }
            },
            required: ['edits'],
            additionalProperties: false
        });
        expect(toolParameterKey(edit.parameters)).toBe('edits');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const path = await seed('execute-path.txt', 'before\n');

        await expect(
            edit.execute({ parameters: [{ path, oldString: 'before', newString: 'after' }] })
        ).resolves.toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('after\n', 'utf8') }]);
    });
});

// A path interpolated into a RegExp needs its Windows separators and dots escaped.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// The C2 / M3 / M11 half of the contract: WHAT happens to the file when an edit lands.
// Before this fix `edit` ended in `writeFile`, which truncated the target's OWN inode at
// open; every test below is a statement about inodes, modes, links, and what a failure
// leaves behind — none of which the pre-fix write could promise.
// ---------------------------------------------------------------------------

// The staging entries of one directory. The publish creates a sibling
// `<name>.tmp-<token>` and renames it, so after ANY outcome — success, refusal, or a
// failure between the create and the rename — this list has to be empty. Matched on the
// marker ./atomic-publish.ts exports, so the token format is not hard-coded here.
const stagingEntries = async (dir: string): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.includes(STAGING_MARKER)).sort();

// The thrown failure as a VALUE, so a test can assert `code`, `name` and `details` next to
// the sentence. `toThrow(errorInstance)` compares the MESSAGE (and, given an Error, also
// fails when the thrown error carries `details` the expected one lacks), which is the half
// M11 adds.
const failureOf = async (call: () => Promise<unknown>): Promise<HarnessError> => {
    const failure = await call().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessError);

    return failure as HarnessError;
};

// A FIFO (named pipe) at `path`, false when this host has no `mkfifo`. The fixture exists
// for L5: `readFile` on a pipe BLOCKS until a writer closes it, which on a `mode: 'sync'`
// tool running on the default inline lane is a hung process, not a slow call. The
// stat-before-read guard answers it instead; the elapsed bound below is what pins
// "answered" rather than "waited".
const makeFifo = (path: string): boolean => spawnSync('mkfifo', [path]).status === 0;

describe('edit - the publish (C2, M3)', () => {
    it('publishes the new text through a rename onto a NEW inode, keeping the mode', async () => {
        const dir = join(workdir, 'publish');
        const path = join(dir, 'script.sh');
        await mkdir(dir, { recursive: true });
        await writeTextFile(path, '#!/bin/sh\none\n', 'utf8');
        await chmod(path, 0o755);

        const before = await stat(path);
        // The mode worth preserving, asserted before the call so a platform that models chmod
        // loosely (Windows) fails the fixture rather than silently passing it.
        if (process.platform !== 'win32') expect(before.mode & 0o7777).toBe(0o755);

        await expect(edit([{ path, oldString: 'one', newString: 'ONE' }])).resolves.toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('#!/bin/sh\nONE\n', 'utf8') }
        ]);

        const after = await stat(path);
        // C2: a DIFFERENT inode holds the new text. The in-place write kept this inode and
        // emptied it first, which is the window the staging rename closes.
        expect(after.ino).not.toBe(before.ino);
        expect(after.isFile()).toBe(true);
        expect(after.size).toBe(Buffer.byteLength('#!/bin/sh\nONE\n', 'utf8'));
        // The rename swaps the inode, so the mode has to travel with it: a 0755 script that
        // came back 0644 would silently stop being executable.
        expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
        // No staging sibling survives the success.
        await expect(stagingEntries(dir)).resolves.toEqual([]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('#!/bin/sh\nONE\n');
    });

    it('leaves a hard-link partner holding the previous bytes under its own name', async () => {
        // The published trade of the publish (D7b): one name was named, one name is replaced.
        // An in-place write would have changed BOTH names' bytes while the receipt spoke about
        // one file.
        const dir = join(workdir, 'publish-hardlink');
        const path = join(dir, 'target.txt');
        const partner = join(dir, 'partner.txt');
        await mkdir(dir, { recursive: true });
        await writeTextFile(path, 'one\n', 'utf8');

        try {
            await hardLink(path, partner);
        } catch {
            // Hard links are privileged on Windows without Developer Mode.
            await expect(readTextFile(path, 'utf8')).resolves.toBe('one\n');

            return;
        }

        const shared = (await stat(partner)).ino;
        expect((await stat(path)).ino).toBe(shared);

        await expect(edit([{ path, oldString: 'one', newString: 'ONE' }])).resolves.toEqual([
            { path, replacements: 1, bytes: 4 }
        ]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('ONE\n');
        await expect(readTextFile(partner, 'utf8')).resolves.toBe('one\n');
        expect((await stat(partner)).ino).toBe(shared);
        expect((await stat(path)).ino).not.toBe(shared);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('edits through a symlink, updating the target and keeping the link itself', async () => {
        // A rename replaces a NAME, so renaming onto the LINK path would delete the link and
        // leave a regular file where an alias used to be. The staging file and the rename
        // therefore go to the RESOLVED target — and the link has to still be a link, still
        // pointing at the same place, with the new bytes reachable through it.
        const dir = join(workdir, 'publish-symlink');
        const real = join(dir, 'real.txt');
        const alias = join(dir, 'alias.txt');
        await mkdir(dir, { recursive: true });
        await writeTextFile(real, 'original\n', 'utf8');

        try {
            await symlink(real, alias);
        } catch {
            await expect(readTextFile(real, 'utf8')).resolves.toBe('original\n');

            return;
        }

        await expect(edit([{ path: alias, oldString: 'original', newString: 'updated' }])).resolves.toEqual([
            { path: alias, replacements: 1, bytes: Buffer.byteLength('updated\n', 'utf8') }
        ]);

        // The bytes moved into the file the link names, not into a new file at the link's own
        // name, and the entry still reports the path the caller asked for.
        await expect(readTextFile(real, 'utf8')).resolves.toBe('updated\n');
        expect((await lstat(alias)).isSymbolicLink()).toBe(true);
        await expect(readlink(alias)).resolves.toBe(real);
        expect((await readdir(dir)).sort()).toEqual(['alias.txt', 'real.txt']);
    });

    it('leaves the previous text, the mode and no staging file when the directory refuses the publish', async () => {
        // C2 + M11, the failure half. The target's DIRECTORY is made read-only AFTER the
        // target exists, so the staging file cannot be created and the call must fail before
        // it can publish — the deterministic stand-in for ENOSPC or a kill mid-write. What is
        // pinned is the promise the sentence makes: the earlier file really is on disk
        // complete, and the failing file really still holds what it had, whole.
        const dir = join(workdir, 'publish-failed');
        const locked = join(dir, 'locked');
        const writable = join(dir, 'writable');
        await mkdir(locked, { recursive: true });
        await mkdir(writable, { recursive: true });

        await chmod(locked, 0o500);

        let createBlocked = false;

        try {
            await writeTextFile(join(locked, 'probe.txt'), 'x', 'utf8');
        } catch {
            createBlocked = true;
        }

        if (!createBlocked) {
            // root ignores the directory write bit and Windows has no such bit: there is no
            // failure to construct here, so the case is skipped openly, not weakened.
            await rm(join(locked, 'probe.txt'), { force: true });
            await chmod(locked, 0o700);

            return;
        }

        const failing = join(locked, 'target.txt');
        await chmod(locked, 0o700);
        await writeTextFile(failing, 'PREVIOUS', 'utf8');
        await chmod(failing, 0o640);
        await chmod(locked, 0o500);

        const completed = join(writable, 'done.txt');
        await writeTextFile(completed, 'before\n', 'utf8');

        try {
            const failure = await failureOf(() =>
                edit([
                    { path: completed, oldString: 'before', newString: 'AFTER' },
                    { path: failing, oldString: 'PREVIOUS', newString: 'NEVER' }
                ])
            );

            expect(['EACCES', 'EPERM', 'EROFS']).toContain(failure.code);
            expect(failure.name).toBe(failure.code);
            expect(failure.message).toMatch(
                new RegExp(
                    `^edit failed on ${escapeRegExp(failing)}: (EACCES|EPERM|EROFS).*\\. Edits already applied: ${escapeRegExp(
                        completed
                    )}\\. No rollback was performed\\.$`
                )
            );
            // M11: the same facts as data, so a caller does not parse the completed list out of
            // prose. The failing path is deliberately NOT in the completed list: it still holds
            // the text it had, which is what the staged publish guarantees.
            expect((failure.details as { failedPath: string }).failedPath).toBe(failing);
            expect((failure.details as { completedPaths: string[] }).completedPaths).toEqual([completed]);

            await expect(readTextFile(completed, 'utf8')).resolves.toBe('AFTER\n');
            await expect(readTextFile(failing, 'utf8')).resolves.toBe('PREVIOUS');
            expect((await stat(failing)).mode & 0o777).toBe(0o640);
            await expect(stagingEntries(locked)).resolves.toEqual([]);
        } finally {
            // The fixture directory has to be writable again for the suite cleanup.
            await chmod(locked, 0o700);
        }
    });

    it('edits a 0444 file, which the in-place write could not open, and keeps the mode', async () => {
        // M3. Writing INTO a read-only file needs write permission on the INODE; publishing
        // needs write permission on the DIRECTORY, which is why `write` has always accepted
        // this and `edit` did not. The two tools now agree, and the file's 0444 survives the
        // rename because the mode is copied onto the staging file.
        const path = join(workdir, 'read-only-file.txt');
        await writeTextFile(path, 'one\n', 'utf8');
        await chmod(path, 0o444);

        // The fixture has to DISCRIMINATE: a 0444 file is exactly what an in-place write
        // cannot open for writing, so on an unprivileged host the scratch file below proves
        // the pre-fix shape fails where the publish succeeds. Where the host is privileged
        // (root, CAP_FOWNER) the in-place write also succeeds, that half is vacuous, and only
        // the published behavior — success, mode intact — is asserted.
        const scratch = join(workdir, 'read-only-scratch.txt');
        await writeTextFile(scratch, 'one\n', 'utf8');
        await chmod(scratch, 0o444);

        const inPlaceBlocked = await writeTextFile(scratch, 'two\n', 'utf8').then(
            () => false,
            () => true
        );

        if (inPlaceBlocked) {
            // And `write` has always accepted this target, which is the inconsistency M3 was:
            // one tool editing what the other one could already replace.
            await expect(write([{ path: scratch, content: 'three\n' }])).resolves.toEqual([
                { path: scratch, bytes: 6 }
            ]);
            await expect(readTextFile(scratch, 'utf8')).resolves.toBe('three\n');
            expect((await stat(scratch)).mode & 0o777).toBe(0o444);
        }

        await expect(edit([{ path, oldString: 'one', newString: 'ONE' }])).resolves.toEqual([
            { path, replacements: 1, bytes: 4 }
        ]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('ONE\n');

        const after = await stat(path);
        if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o444);
    });

    it('refuses a file it cannot read, with the permission code and the target as data', async () => {
        // The other half of M3: a publish needs only the directory, but an EDIT has to READ
        // the file first, so a 0000 target is still a refusal — an honest one, with the code
        // that says so (M11) rather than a bare errno sentence.
        const path = join(workdir, 'unreadable-file.txt');
        await writeTextFile(path, 'secret\n', 'utf8');
        await chmod(path, 0o000);

        // Capability probe: root (or CAP_DAC_OVERRIDE) reads a 0000 file, and then there is
        // no refusal on this host to assert.
        const readBlocked = await readFile(path).then(
            () => false,
            () => true
        );

        if (!readBlocked) {
            await chmod(path, 0o600);

            return;
        }

        const failure = await failureOf(() => edit([{ path, oldString: 'secret', newString: 'public' }]));

        expect(['EACCES', 'EPERM']).toContain(failure.code);
        expect(failure.name).toBe(failure.code);
        expect(failure.message).toMatch(
            new RegExp(
                `^edit was denied permission to read ${escapeRegExp(path)}: .*\\. This is a filesystem permission problem, not a missing path\\.$`
            )
        );
        expect((failure.details as { target: string }).target).toBe(path);

        await chmod(path, 0o600);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('secret\n');
    });
});

describe('edit - the preflight (L5, L9, M12, M9, H6)', () => {
    it('refuses a FIFO without blocking on it', async () => {
        // L5. `readFile` on a pipe waits for a writer that never comes, and this tool is
        // `mode: 'sync'` on the default inline lane, so the old read-first shape could hang
        // the process on one argument. One `stat` answers instead, with the sentence and the
        // code shared with ./write.tool.ts.
        const dir = join(workdir, 'preflight-fifo');
        const fifo = join(dir, 'pipe.txt');
        await mkdir(dir, { recursive: true });

        if (!makeFifo(fifo)) {
            await expect(readdir(dir)).resolves.toEqual([]);

            return;
        }

        const startedAt = Date.now();
        const failure = await failureOf(() => edit([{ path: fifo, oldString: 'x', newString: 'y' }]));
        const elapsedMs = Date.now() - startedAt;

        expect(failure.code).toBe('EOPNOTSUPP');
        expect(failure.name).toBe('EOPNOTSUPP');
        expect(
            failure.message.startsWith(
                `edit refused ${fifo}: the target is a FIFO (named pipe), not a regular file. `
            )
        ).toBe(true);
        expect(failure.message.length).toBeLessThan(600);
        expect((failure.details as { kind: string }).kind).toBe('a FIFO (named pipe)');
        expect((failure.details as { target: string }).target).toBe(fifo);
        // Loose on purpose, but nowhere near the seconds-to-forever a blocked read is.
        expect(elapsedMs).toBeLessThan(5_000);
    });

    it('refuses a character device as not a regular file', async () => {
        // L5, the shape whose read does not block but never ends (`/dev/zero`) or answers once
        // with no bytes (`/dev/null`). Guarded on the host actually having a character device
        // at that path, because the refusal is a claim about the node type.
        let isCharDevice = false;

        try {
            isCharDevice = (await lstat('/dev/null')).isCharacterDevice();
        } catch {
            isCharDevice = false;
        }

        if (!isCharDevice) return;

        const failure = await failureOf(() =>
            edit([{ path: '/dev/null', oldString: 'nothing here', newString: 'x' }])
        );

        expect(failure.code).toBe('EOPNOTSUPP');
        expect(
            failure.message.startsWith('edit refused /dev/null: the target is a character device, not a regular file. ')
        ).toBe(true);
        expect((failure.details as { kind: string }).kind).toBe('a character device');
    });

    it('refuses a directory with the sentence a model can act on, and creates no staging file', async () => {
        // L5 + C2 together: the refusal happens BEFORE the read and before any staging file,
        // so the directory still holds exactly the children it had.
        const dir = join(workdir, 'preflight-dir');
        await mkdir(dir, { recursive: true });
        await writeTextFile(join(dir, 'keep.txt'), 'keep', 'utf8');

        const failure = await failureOf(() => edit([{ path: dir, oldString: 'x', newString: 'y' }]));

        expect(failure.code).toBe('EISDIR');
        expect(failure.name).toBe('EISDIR');
        expect(failure.message).toBe(
            `edit was given the directory ${dir}. edit changes one existing file; pass a file path, or use write.`
        );
        expect((failure.details as { kind: string }).kind).toBe('directory');
        expect((await readdir(dir)).sort()).toEqual(['keep.txt']);
    });

    it('refuses a symlink loop as ELOOP, never as the transient EIO', async () => {
        // The read leg of a publish resolves its target through the SAME hand-rolled link walk
        // as `write` (./atomic-publish.ts's `realWriteTarget`), and the throw there has to CARRY
        // its code: `publishErrorCode` reads `error.code`, and a throw with no code folds to
        // `EIO` — the harness's TRANSIENT code, the one the published descriptions tell a model
        // to retry. Measured on one self-referential link, `edit` and `files` already answered
        // `ELOOP` and `write` answered `{ code: 'EIO', rawCode: null }`; this is the pin that
        // keeps `edit` on the right side of that fix as the shared walk changes.
        const loop = join(workdir, 'edit-loop-ELOOP.txt');

        // A symlink is privileged on Windows (Developer Mode or elevation), so the assertion is
        // about a link that this host was able to create — the same concession the symlink
        // fixtures above and ./identity.test.ts:46-53 make. Linux and macOS always create one,
        // so the pin is never silently skipped where the defect was reported.
        try {
            await symlink('edit-loop-ELOOP.txt', loop);
        } catch {
            return;
        }

        const failure = await failureOf(() => edit([{ path: loop, oldString: 'x', newString: 'y' }]));

        expect(failure.code).toBe('ELOOP');
        expect(failure.name).toBe('ELOOP');
        expect(FILE_EDIT_ERROR_CODES).toContain('ELOOP');
        // The whole defect, in one assertion: `EIO` is what a caller used to see.
        expect(failure.code).not.toBe('EIO');
        expect(failure.details).toEqual({ target: loop, reason: 'unreadable-target' });
        expect(failure.message).toContain('ELOOP: too many symbolic links encountered');

        // The refusal happens before the read, so nothing was staged next to the link, and the
        // link itself is still a link (`lstat`, because `stat` on this one never answers).
        await expect(stagingEntries(workdir)).resolves.toEqual([]);
        const loopStats = await lstat(loop);
        expect(loopStats.isSymbolicLink()).toBe(true);
    });

    it('publishes the size ceiling and refuses a file over it with EFBIG, leaving it untouched', async () => {
        // L9: a file AT the ceiling is accepted and one byte over it is refused, with the limit
        // named in both the sentence and the data, and the refused file provably not rewritten
        // (same inode, same size).
        expect(FILE_EDIT_MAX_BYTES).toBe(8 * 1024 * 1024);
        expect(FILE_EDIT_ERROR_CODES).toContain('EFBIG');
        expect(new Set(FILE_EDIT_ERROR_CODES).size).toBe(FILE_EDIT_ERROR_CODES.length);

        const dir = join(workdir, 'size-bound');
        await mkdir(dir, { recursive: true });

        const atLimit = join(dir, 'at-limit.txt');
        const overLimit = join(dir, 'over-limit.txt');
        const atLimitText = 'a'.repeat(FILE_EDIT_MAX_BYTES - 6) + 'UNIQUE';
        const overLimitText = 'a'.repeat(FILE_EDIT_MAX_BYTES) + 'b';

        await writeTextFile(atLimit, atLimitText, 'utf8');
        await writeTextFile(overLimit, overLimitText, 'utf8');
        expect(Buffer.byteLength(atLimitText, 'utf8')).toBe(FILE_EDIT_MAX_BYTES);
        expect(Buffer.byteLength(overLimitText, 'utf8')).toBe(FILE_EDIT_MAX_BYTES + 1);

        await expect(edit([{ path: atLimit, oldString: 'UNIQUE', newString: 'ONCE' }])).resolves.toEqual([
            { path: atLimit, replacements: 1, bytes: FILE_EDIT_MAX_BYTES - 2 }
        ]);

        const before = await stat(overLimit);
        const failure = await failureOf(() => edit([{ path: overLimit, oldString: 'ab', newString: 'x' }]));

        expect(failure.code).toBe('EFBIG');
        expect(failure.name).toBe('EFBIG');
        expect(failure.message).toBe(
            `edit refused ${overLimit}: the file is ${FILE_EDIT_MAX_BYTES + 1} bytes, over the ${FILE_EDIT_MAX_BYTES}-byte ceiling this tool reads and rewrites in memory. Read the region you want to change with read, then edit that text, or replace the whole file with write.`
        );
        expect(failure.details).toEqual({ target: overLimit, size: FILE_EDIT_MAX_BYTES + 1, limit: FILE_EDIT_MAX_BYTES });

        const after = await stat(overLimit);
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(FILE_EDIT_MAX_BYTES + 1);
    });

    it('accepts a no-op entry, reports changed: false, and does not republish the file', async () => {
        // M12. Passing the same text twice is a CHECK: the match and uniqueness rules still
        // run (the next test pins that), and the receipt says what actually happened — nothing
        // — instead of either failing or claiming a change. The inode and mtime assertions are
        // the "was not republished" half: after C2 a no-op that still renamed would churn the
        // inode and invalidate a reader's open handle for nothing.
        const path = join(workdir, 'no-op.txt');
        await writeTextFile(path, 'x alpha y\n', 'utf8');
        const before = await stat(path);

        await expect(edit([{ path, oldString: 'alpha', newString: 'alpha' }])).resolves.toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('x alpha y\n', 'utf8'), changed: false }
        ]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('x alpha y\n');
        const after = await stat(path);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.size).toBe(before.size);
    });

    it('still fails a no-op whose text is missing, and one that is not unique', async () => {
        const absent = join(workdir, 'no-op-absent.txt');
        const ambiguous = join(workdir, 'no-op-ambiguous.txt');
        await writeTextFile(absent, 'x alpha y\n', 'utf8');
        await writeTextFile(ambiguous, 'a a a\n', 'utf8');

        await expect(edit([{ path: absent, oldString: 'missing', newString: 'missing' }])).rejects.toThrow(
            new HarnessError(
                `edit found no match for oldString in ${absent}. Read the file first and copy the text exactly, including indentation.`
            )
        );

        // L4 from the other direction: a no-op is diagnosed exactly like the real edit it
        // stands for, deduped line list included.
        await expect(edit([{ path: ambiguous, oldString: 'a', newString: 'a' }])).rejects.toThrow(
            new HarnessError(
                `edit found 3 matches for oldString in ${ambiguous} (lines 1). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );

        await expect(readTextFile(absent, 'utf8')).resolves.toBe('x alpha y\n');
        await expect(readTextFile(ambiguous, 'utf8')).resolves.toBe('a a a\n');
    });

    it('matches a no-op written with \\n against a CRLF file and changes nothing', async () => {
        // M12 and the ending rules together: two identical strings trivially "differ only in
        // carriage returns", which would send the entry down the exact-bytes branch and answer
        // "no match" for a file whose text is plainly there. A no-op is routed through the
        // normal cascade instead, so it is diagnosed like the real edit it stands for — found,
        // through the LF view, reported unchanged, with the BYTES not one bit different.
        const path = await seedBytes('no-op-crlf.txt', '61 0d 0a 62 0d 0a');
        const before = await stat(path);

        await expect(edit([{ path, oldString: 'a\nb', newString: 'a\nb' }])).resolves.toEqual([
            { path, replacements: 1, bytes: 6, changed: false }
        ]);

        await expect(readHex(path)).resolves.toBe('61 0d 0a 62 0d 0a');
        expect((await stat(path)).ino).toBe(before.ino);
    });

    it('inserts into an empty file with an empty oldString, and refuses that needle anywhere else', async () => {
        // M12: the empty needle names exactly one place — the start of a file with no text —
        // and it is the only way an empty file can be edited at all, since no non-empty
        // oldString can match it. Against a file with text the same needle matches between
        // every pair of characters, so it is refused — and the F7 pin below is what that
        // refusal has to say.
        const empty = join(workdir, 'empty-insert.txt');
        await writeTextFile(empty, '', 'utf8');

        await expect(edit([{ path: empty, oldString: '', newString: 'inserted' }])).resolves.toEqual([
            { path: empty, replacements: 1, bytes: 8 }
        ]);
        await expect(readTextFile(empty, 'utf8')).resolves.toBe('inserted');

        const full = join(workdir, 'empty-needle.txt');
        await writeTextFile(full, 'text\n', 'utf8');

        const failure = await failureOf(() => edit([{ path: full, oldString: '', newString: 'x' }]));

        // F7: the refusal used to stop at "edit requires a non-empty oldString.", which hid
        // the exception the schema and the published description both grant — an empty
        // oldString IS accepted against an EMPTY file — and left the caller no next call. The
        // message now states the rule it enforces, why this file does not qualify, and the
        // two calls that do what was meant. Pinned verbatim: it is the contract a model reads.
        expect(failure.message).toBe(
            'edit requires a non-empty oldString. An empty oldString is accepted only against an EMPTY file, ' +
                'where it names the one place text can go; this file has text, so an empty oldString would match everywhere. ' +
                'Pass a non-empty oldString that names the text to change (add replaceAll: true to change every match), ' +
                'or use write to replace the whole file.'
        );
        // Still a malformed REQUEST rather than a filesystem state, so it stays codeless
        // (./edit.tool.ts:1327-1330) — only the prose grew.
        expect(failure.code).toBeUndefined();
        expect(failure.details).toEqual({ target: full, reason: 'empty-needle-on-non-empty-file' });
        await expect(readTextFile(full, 'utf8')).resolves.toBe('text\n');
    });

    it('publishes that the lock is per process and that a writer outside it wins (H6)', async () => {
        // H6: the two claims the old description made were stronger than ./lock.ts supports.
        // Pinned as TEXT, because the description IS the contract a model reads — and pinned
        // for both writers, so the qualifier cannot be added to one tool and forgotten in the
        // other.
        const description = FILE_EDIT_METADATA.description;

        expect(description).toContain(
            'serialized per file (in this process only - a second harness process or a worker-thread lane keeps its own locks)'
        );
        expect(description).toContain('a concurrent edit cannot silently clobber another edit');
        expect(description).toContain('a writer outside that lock');
        // The overclaim this replaced, verbatim: an unqualified promise that no concurrent edit
        // could ever clobber another.
        expect(description).not.toContain(
            'serialized per file (read-match-write is one critical section), so a concurrent edit never silently clobbers another'
        );
        // And the facts the publish made true (C2, M3, L5, L9, M12), each one clause of the
        // same description, so the prose cannot drift back.
        expect(description).toContain('never a partial write');
        expect(description).toContain('a hard link to it keeps the previous bytes');
        expect(description).toContain('(0444) can still be edited');
        expect(description).toContain('is refused with a code rather than replaced by one');
        expect(description).toContain('EFBIG');
        expect(description).toContain('{ path, replacements, bytes, match?, changed? }');
        // F6: the shared-file rule the RESULT TYPE already states (./edit.tool.ts:345-347 —
        // a file is written once, so entries naming it report the same final size) was missing
        // from the published description, and the description is the half a model reads. One
        // clause, pinned so it cannot be trimmed back out. The wording is not free-form: those
        // bytes are priced into ../../plugin/context-compaction.test.ts's `CATALOGUE` floor, and
        // this exact phrasing is 144 bytes, which keeps that floor a whole number of tokens.
        expect(description).toContain(
            'where `bytes` is the size of the file after this call, so entries that name the SAME file report that same final size - a file is written only once'
        );
        // T14: the cancelled-call refusal is published in the same breath as the other codes,
        // pinned as text for the same reason — the description IS the contract a model reads,
        // and `ECANCELED` is now a code this tool can answer with (./cancellation.ts).
        expect(description).toContain(
            'A cancelled call rejects with `ECANCELED` and names the files already edited: there is no rollback'
        );
    });
});

describe('edit - a cancelled call is refused with the published ECANCELED (T14)', () => {
    // Cancellation used to be invisible here: `context.signal` was never read, so an aborted
    // call still read its files, still published new ones, and still reported success to a
    // caller that had already walked away (src/types/index.ts:2349-2364 says the harness
    // discards a late result, so that "success" had no consumer at all). It now refuses with
    // the published `ECANCELED` (./cancellation.ts), as a CALL-level rejection like every
    // other refused edit, with `completedPaths` in `details` and the host's own abort reason
    // kept as `cause` (src/harness.ts:7804-7816 prefers a tool's own explanation of a
    // cancellation over the generic reason, so the reason has to survive somewhere).
    it('refuses a cancelled call with ECANCELED before reading any file', async () => {
        const target = await seed('cancel-pre.txt', 'one\n');
        const controller = new AbortController();
        controller.abort();

        const failure = await failureOf(() =>
            edit.execute({ parameters: [{ path: target, oldString: 'one', newString: 'ONE' }], signal: controller.signal })
        );

        expect(failure.code).toBe('ECANCELED');
        expect(failure.name).toBe('ECANCELED');
        expect(FILE_EDIT_ERROR_CODES).toContain('ECANCELED');
        // `EIO` is the fold this replaces: transient, and the one the descriptions teach a model
        // to retry — a cancelled call is permanent by construction.
        expect(failure.code).not.toBe('EIO');
        expect(failure.message).toBe(
            'edit was cancelled (ECANCELED) before any file was edited: the caller\'s abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended.'
        );
        expect(failure.details).toEqual({ rawCode: 'AbortError', completedPaths: [] });

        // Reached through the cast src/util/errors.ts itself uses: `cause` is assigned, not
        // declared, because the package does not pull in lib es2022.error.
        const cause = (failure as { cause?: { name?: string } }).cause;
        expect(cause?.name).toBe('AbortError');

        // Nothing ran: the file still holds the bytes it had.
        await expect(readTextFile(target, 'utf8')).resolves.toBe('one\n');
        await expect(stagingEntries(workdir)).resolves.toEqual([]);
    });

    it('stops a cancelled batch at the next file, names that file, and changes nothing', async () => {
        // The abort below is issued synchronously after `execute`, so it lands after the
        // top-of-call check and on the FIRST entry's own check — the deterministic middle case
        // between "cancelled before the call" and "cancelled after one file landed". There is no
        // seam in the published API to abort inside the loop, so `completedPaths: []` is the
        // honest, reproducible half-state here; the call-level channel and the named target are
        // what the contract promises.
        const first = await seed('cancel-mid-a.txt', 'one\n');
        const second = await seed('cancel-mid-b.txt', 'two\n');
        const controller = new AbortController();

        const pending = edit.execute({
            parameters: [
                { path: first, oldString: 'one', newString: 'ONE' },
                { path: second, oldString: 'two', newString: 'TWO' }
            ],
            signal: controller.signal
        });

        controller.abort();

        const failure = await failureOf(() => pending);

        expect(failure.code).toBe('ECANCELED');
        expect(failure.message).toBe(
            `edit was cancelled (ECANCELED) before reading ${JSON.stringify(first)}: the caller's abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended.`
        );
        expect(failure.details).toEqual({ rawCode: 'AbortError', completedPaths: [] });

        // Both files still hold the text the call was asked to replace, and no staging file was
        // left behind — a cancelled edit is not a half-edited file.
        await expect(readTextFile(first, 'utf8')).resolves.toBe('one\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('two\n');
        await expect(stagingEntries(workdir)).resolves.toEqual([]);
    });
});

