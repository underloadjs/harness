// edit — exact, batched replacement semantics (T14).
//
// Runs against real files in a temporary directory under the repo-root `Temp/`,
// using absolute paths so it never chdir's. Every assertion is the full result
// array or the exact resulting file text: the tool's value is the guarantee that
// an ambiguous edit cannot happen and that a bad entry in a batch changes nothing,
// so a partial assert would test nothing.
//
// The batch guarantees are the new part:
//   - every edit is validated (shape, non-empty oldString, distinct strings, no NUL)
//     BEFORE any read;
//   - entries are grouped by FILE IDENTITY (./identity.ts), so several entries may
//     name one file — the same path twice, two case spellings on Windows, or a
//     symlink alias on any platform. They are applied in ARRAY order, each matched
//     against the text the previous one produced;
//   - every file is then read and match-checked BEFORE the first write, so a
//     failure on the LAST entry leaves the FIRST file untouched, and each distinct
//     file is written exactly ONCE with its final text;
//   - the result is one entry per requested edit, in request order, naming the path
//     that entry asked for and reporting replacements + the file's final byte size
//     (entries sharing a file therefore report the same size).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile as readTextFile,
    rm,
    symlink,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { HarnessError } from '../../util';
import { edit } from './edit.tool';
import { write } from './write.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

const seed = async (name: string, content: string): Promise<string> => {
    const path = join(workdir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
    return path;
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

        await expect(edit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new HarnessError(
                `edit found 3 matches for oldString in ${path} (lines 1, 1, 1). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('a a a\n');
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

    it('rejects an empty oldString, a no-op edit, and a non-boolean replaceAll', async () => {
        const path = await seed('validation.txt', 'text\n');

        await expect(edit([{ path, oldString: '', newString: 'x' }])).rejects.toThrow(
            new HarnessError('edit requires a non-empty oldString.')
        );
        await expect(edit([{ path, oldString: 'text', newString: 'text' }])).rejects.toThrow(
            new HarnessError('edit did not change the file: oldString and newString are identical.')
        );
        await expect(
            edit([{ path, oldString: 'text', newString: 'x', replaceAll: 'yes' as never }])
        ).rejects.toThrow(new HarnessError('edit replaceAll must be a boolean when provided.'));
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

    it('declares a single "edits" array property of { path, oldString, newString, replaceAll? }', () => {
        expect(edit.parameters).toEqual({
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
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
