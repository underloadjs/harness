// read — the BOUNDED batched read contract.
//
// What this pins:
//   - ONE call reads several files and returns one bounded window per requested
//     path, in the caller's order;
//   - `path` is the ABSOLUTE resolved path, so two relative spellings are
//     identifiable;
//   - the schema still declares exactly one array property (`paths`), so the
//     harness's single-property rule hands `execute` the array itself; per-path
//     range objects live on the ITEM, not as a second top-level property;
//   - every window reports line numbering (`startLine`/`endLine`), explicit
//     truncation (`truncated`), and continuation (`nextLine`/`nextColumn`/`nextByte`);
//   - the aggregate budget is measured on the SERIALIZED result, so a full-budget
//     read always survives the harness's own wire cap intact — the fields needed to
//     continue are never destroyed;
//   - allocation is by DEMAND: a small file hands its unused share back instead of
//     stranding a large one at 1/N of the budget;
//   - UTF-8 bytes (not UTF-16 code units) are counted, and CRLF/empty files keep
//     their exact text;
//   - a missing path, a directory, a permission denial, or binary content is
//     reported IN PLACE as an errored entry and does NOT destroy the rest of the
//     batch; only a malformed request rejects the whole call.
//
// Fixtures are real files under the repo-root `Temp/` (never OS temp), one unique
// directory per run, removed afterwards. Module-relative so the location does not
// depend on the cwd Vitest was started from — the same convention as
// server/environment.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from '../../core/result-budget';
import {
    read,
    FILE_READ_CONTENT_BUDGET,
    FILE_READ_DEFAULT_MAX_LINES,
    FILE_READ_MAX_LINES,
    FILE_READ_MAX_TARGETS,
    FILE_READ_WIRE_BUDGET
} from './read.tool';
import type { FileReadResult } from './read.tool';

// Repo-root Temp/ (six levels up from src/tools/files/: files -> tools -> src ->
// harness -> underload -> packages -> repo root).
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

const seed = async (relativePath: string, content: string): Promise<string> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
    return path;
};

const seedBytes = async (relativePath: string, content: Uint8Array): Promise<string> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content);
    return path;
};

// `wireBytes` depends on the length of the per-run temp directory name, so it is
// replaced with a matcher rather than a literal. Everything else is asserted
// exactly, which keeps the strict whole-object comparison the contract needs.
const withWire = (result: FileReadResult) => ({
    ...result,
    wireBytes: expect.any(Number)
});

// The line fixtures are generated rather than pasted; the assertions below spell out
// the exact slice expected for each window. `lines.txt` is 1300 lines, which is
// INSIDE the 5000-line default so the EOF/past-EOF windows are reachable; the default
// window itself is exercised against `many-lines.txt`, which exceeds it.
const linesUpTo = (count: number): string =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join('');

const LINES_1300 = linesUpTo(1300);
const LINES_5100 = linesUpTo(5100);

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-read-'));

    // Exact contents, including a CRLF file and an empty file, so the assertions
    // below are literal rather than "whatever happened to be on disk".
    await seed('a.txt', 'alpha\n');
    await seed('b.txt', 'beta\n');
    await seed('nested/c.txt', 'gamma');
    await seed('crlf.txt', 'one\r\ntwo\r\n');
    await seed('empty.txt', '');
    await seed('utf8.txt', 'h\u00e9llo\n'); // 7 UTF-8 bytes, 6 code points
    await seed('lines.txt', LINES_1300);
    await seed('many-lines.txt', LINES_5100);

    // Lines that fit the 256 KiB wire budget, so a giant line is returned whole
    // rather than cut — the size the OLD 64 KiB budget could not hold.
    await seed('giant.txt', 'x'.repeat(70_000));
    await seed('multibyte.txt', '\u00e9'.repeat(40_000)); // 2 bytes each = 80000

    // A line LARGER than the wire budget, so the mid-line cut and the paging
    // continuation are still proven rather than assumed.
    await seed('huge-line.txt', `${'x'.repeat(300_000)}\nB\nC\n`);
    await seed('huge-multibyte.txt', `${'\u00e9'.repeat(150_000)}\nsecond\nthird\n`); // 300000 bytes

    await seed('offset.txt', 'abcdefghij\nsecond\nthird\n');

    // Demand-allocation fixtures: one 40 KiB file beside many 6-byte files. Under
    // the old even split the large file was cut to ~1/100th of the budget.
    await seed('one-big.txt', 'a'.repeat(40_000));

    // Four equal large files, to show an even split is still even when every file
    // wants more than its share.
    for (const index of [0, 1, 2, 3]) await seed(`many/${index}.txt`, 'a'.repeat(200_000));

    // Binary fixtures: NUL bytes and bytes that are not valid UTF-8 (no NUL).
    await seedBytes('binary-nul.bin', Buffer.from([0x61, 0x00, 0x62]));
    await seedBytes('binary-invalid.bin', Buffer.from([0xc3, 0x28]));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('read', () => {
    it('reads several files in one call, in the caller order', async () => {
        const result = await read([join(workdir, 'b.txt'), join(workdir, 'a.txt')]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'b.txt'),
                    content: 'beta\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 5,
                    sizeBytes: 5
                },
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 6,
                    sizeBytes: 6
                }
            ],
            truncated: false,
            bytes: 11,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 0
        });
    });

    it('resolves relative paths and reports the absolute path', async () => {
        const previous = process.cwd();
        process.chdir(workdir);

        try {
            const result = await read(['a.txt', 'nested/c.txt']);

            expect(withWire(result)).toEqual({
                files: [
                    {
                        path: resolve('a.txt'),
                        content: 'alpha\n',
                        startLine: 1,
                        endLine: 1,
                        truncated: false,
                        limit: null,
                        startByteAligned: null,
                        nextLine: null,
                        nextColumn: null,
                        nextByte: null,
                        bytes: 6,
                        sizeBytes: 6
                    },
                    {
                        path: resolve('nested/c.txt'),
                        content: 'gamma',
                        startLine: 1,
                        endLine: 1,
                        truncated: false,
                        limit: null,
                        startByteAligned: null,
                        nextLine: null,
                        nextColumn: null,
                        nextByte: null,
                        bytes: 5,
                        sizeBytes: 5
                    }
                ],
                truncated: false,
                bytes: 11,
                wireBytes: expect.any(Number),
                contentBudget: FILE_READ_WIRE_BUDGET,
                skipped: 0
            });
        } finally {
            process.chdir(previous);
        }
    });

    it('returns file text byte-for-byte, including CRLF and an empty file', async () => {
        const result = await read([join(workdir, 'crlf.txt'), join(workdir, 'empty.txt')]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'crlf.txt'),
                    content: 'one\r\ntwo\r\n',
                    startLine: 1,
                    endLine: 2,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 10,
                    sizeBytes: 10
                },
                {
                    path: join(workdir, 'empty.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 0,
                    sizeBytes: 0
                }
            ],
            truncated: false,
            bytes: 10,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 0
        });
    });

    it('counts UTF-8 bytes, not UTF-16 code units', async () => {
        const result = await read([join(workdir, 'utf8.txt')]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'utf8.txt'),
                    content: 'h\u00e9llo\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 7,
                    sizeBytes: 7
                }
            ],
            truncated: false,
            bytes: 7,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 0
        });
    });

    it('has no default line cap: a 5100-line file of short lines comes back whole', async () => {
        // The D6 regression. The default used to be 5000 lines, so this file — 5,100
        // lines of 8-9 bytes, 33 KB, a twelfth of the budget — came back cut at line
        // 5000 with `truncated: true`, and the agent paid a whole round trip for the
        // last 100 lines. The budget, not the line count, is the documented limit.
        const result = await read([join(workdir, 'many-lines.txt')]);
        const entry = result.files[0];

        expect(entry.content).toBe(LINES_5100);
        expect(entry.startLine).toBe(1);
        expect(entry.endLine).toBe(5100);
        expect(entry.truncated).toBe(false);
        expect(entry.limit).toBeNull();
        expect(entry.nextByte).toBeNull();
        expect(entry.sizeBytes).toBe(Buffer.byteLength(LINES_5100, 'utf8'));
        expect(result.wireBytes).toBeLessThan(FILE_READ_WIRE_BUDGET);
    });

    it('applies an explicit maxLines and names it as the reason', async () => {
        // An EXPLICIT cap still cuts, and `limit` says so — that is the whole point of
        // the field: a caller reading `truncated: true` must know whether raising
        // `maxLines` would help (it would, here) or not (it never does for "budget").
        const first5000 = linesUpTo(5000);
        const bytes = Buffer.byteLength(first5000, 'utf8');

        const result = await read([{ path: join(workdir, 'many-lines.txt'), maxLines: 5000 }]);
        const entry = result.files[0];

        expect(entry.content).toBe(first5000);
        expect(entry.startLine).toBe(1);
        expect(entry.endLine).toBe(5000);
        expect(entry.bytes).toBe(bytes);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxLines');
        expect(entry.nextLine).toBe(5001);
        expect(entry.nextColumn).toBe(0);
        // nextByte is the absolute offset of line 5001, i.e. exactly the bytes read.
        expect(entry.nextByte).toBe(bytes);
        expect(result.truncated).toBe(true);
    });

    it('fills the wire budget with a default read of typical source', async () => {
        // The utilization contract (improvement #3). A 200-line default used 14.2% of
        // the budget and a 1200-line default used 22.7%, so the tool spent a round trip
        // to deliver a fifth of what the envelope allowed. Lines sized like this
        // repository's own source (mean ~55 bytes) must now reach the budget, which is
        // what makes `maxLines` a guard rather than the effective limit.
        const path = await seed(
            'sized.txt',
            Array.from({ length: 20_000 }, (_, index) => `line ${index} const value = compute(a, b); // note ${index}\n`).join('')
        );

        const result = await read([path]);
        const entry = result.files[0];

        expect(entry.truncated).toBe(true);
        // Budget-bound, not line-bound: fewer than the 5000-line default came back.
        expect(entry.endLine).toBeLessThan(FILE_READ_DEFAULT_MAX_LINES);
        expect(result.wireBytes / FILE_READ_WIRE_BUDGET).toBeGreaterThan(0.8);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
    });

    it('applies an exact 1-based startLine/maxLines window', async () => {
        const result = await read([{ path: join(workdir, 'lines.txt'), startLine: 50, maxLines: 3 }]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: 'line 50\nline 51\nline 52\n',
                    startLine: 50,
                    endLine: 52,
                    truncated: true,
                    limit: 'maxLines',
                    startByteAligned: null,
                    nextLine: 53,
                    nextColumn: 0,
                    nextByte: Buffer.byteLength(
                        Array.from({ length: 52 }, (_, index) => `line ${index + 1}\n`).join(''),
                        'utf8'
                    ),
                    bytes: 24,
                    sizeBytes: Buffer.byteLength(LINES_1300, 'utf8')
                }
            ],
            truncated: true,
            bytes: 24,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 0
        });
    });

    it('does not truncate when the line window reaches EOF', async () => {
        const result = await read([{ path: join(workdir, 'lines.txt'), startLine: 1299, maxLines: 5 }]);

        expect(result.files[0]).toEqual({
            path: join(workdir, 'lines.txt'),
            content: 'line 1299\nline 1300\n',
            startLine: 1299,
            endLine: 1300,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 20,
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8')
        });
    });

    it('returns an empty window, without truncation, when startLine is past EOF', async () => {
        const result = await read([{ path: join(workdir, 'lines.txt'), startLine: 5000 }]);

        expect(result.files[0]).toEqual({
            path: join(workdir, 'lines.txt'),
            content: '',
            startLine: 5000,
            endLine: 4999,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 0,
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8')
        });
    });

    it('keeps CRLF exact inside a single-line window', async () => {
        const result = await read([{ path: join(workdir, 'crlf.txt'), startLine: 2, maxLines: 1 }]);

        expect(result.files[0]).toEqual({
            path: join(workdir, 'crlf.txt'),
            content: 'two\r\n',
            startLine: 2,
            endLine: 2,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 5,
            sizeBytes: 10
        });
    });

    it('applies startColumn only to the first line, never every line', async () => {
        const result = await read([
            { path: join(workdir, 'offset.txt'), startLine: 1, startColumn: 5, maxLines: 3 }
        ]);

        expect(result.files[0]).toEqual({
            path: join(workdir, 'offset.txt'),
            content: 'fghij\nsecond\nthird\n',
            startLine: 1,
            endLine: 3,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 19,
            sizeBytes: 24
        });
    });

    it('returns a 70 KB single line whole, now that the budget is 256 KiB', async () => {
        const result = await read([join(workdir, 'giant.txt')]);

        expect(result.files[0].bytes).toBe(70_000);
        expect(result.files[0].truncated).toBe(false);
        expect(result.files[0].nextByte).toBeNull();
    });

    it('cuts a line larger than the budget and resumes exactly at nextByte', async () => {
        const result = await read([join(workdir, 'huge-line.txt')]);
        const entry = result.files[0];

        expect(entry.truncated).toBe(true);
        expect(entry.nextLine).toBe(1);
        expect(entry.bytes).toBeGreaterThan(200_000);
        expect(entry.bytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
        expect(entry.nextByte).toBe(entry.bytes);

        // The whole file is reconstructed by paging with startByte, with no byte
        // lost or duplicated at any boundary.
        const original = 'x'.repeat(300_000) + '\nB\nC\n';
        let collected = entry.content;
        let next = entry;

        while (next.truncated && next.nextByte !== null) {
            const page = await read([
                { path: join(workdir, 'huge-line.txt'), startByte: next.nextByte, startLine: next.nextLine ?? 1 }
            ]);
            next = page.files[0];
            collected += next.content;
        }

        expect(collected).toBe(original);
    });

    it('cuts a multibyte line only at a whole code point', async () => {
        const result = await read([join(workdir, 'huge-multibyte.txt')]);
        const entry = result.files[0];

        // 2 bytes per character, so a byte-exact cut could land mid-character.
        expect(entry.bytes % 2).toBe(0);
        expect(entry.content).toBe('\u00e9'.repeat(entry.bytes / 2));
        expect(entry.truncated).toBe(true);

        // Resuming at nextByte continues the same line and eventually reaches the
        // following lines intact.
        const page = await read([
            { path: join(workdir, 'huge-multibyte.txt'), startByte: entry.nextByte ?? 0, startLine: entry.nextLine ?? 1 }
        ]);
        const second = page.files[0];

        expect(second.content.startsWith('\u00e9')).toBe(true);
        expect(second.bytes % 2).toBe(0);
    });

    it('preserves every following line when a giant line is paged', async () => {
        const original = 'x'.repeat(300_000) + '\nB\nC\n';
        const first = (await read([join(workdir, 'huge-line.txt')])).files[0];

        // The tail of the file is reachable by seeking to the end of the giant line.
        const tail = await read([{ path: join(workdir, 'huge-line.txt'), startByte: 300_000 }]);

        expect(first.content.length).toBeLessThan(original.length);
        expect(tail.files[0].content).toBe('\nB\nC\n');
    });

    it('allocates by demand: a 40 KiB file beside 99 tiny ones is returned in full', async () => {
        // The regression this pins: the old split was budget/N, so this file was cut
        // to roughly 1/100th of the budget while 99 six-byte neighbours stranded the
        // rest. It now fits entirely, because their surplus is handed to it.
        const paths = [join(workdir, 'one-big.txt'), ...Array.from({ length: 99 }, () => join(workdir, 'a.txt'))];

        const result = await read(paths);

        expect(result.files).toHaveLength(100);
        expect(result.files[0].bytes).toBe(40_000);
        expect(result.files[0].truncated).toBe(false);
        expect(result.files[0].content).toBe('a'.repeat(40_000));
        expect(result.skipped).toBe(0);
    });

    it('still splits evenly when every file wants more than its share', async () => {
        // Four equal 200 KB files: nobody is small enough to hand anything back, so
        // the demand-based allocator must degrade to a plain even split rather than
        // favouring the first file.
        const paths = [0, 1, 2, 3].map((index) => join(workdir, 'many', `${index}.txt`));

        const result = await read(paths);
        const sizes = result.files.map((entry) => entry.bytes);

        expect(result.files.every((entry) => entry.truncated)).toBe(true);
        // Equal within one line's worth of rounding, and the total stays inside the
        // wire budget rather than overshooting it.
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
    });

    it('never exceeds the harness wire cap, so the continuation fields survive', async () => {
        // The core regression. Previously read budgeted 64 KiB of RAW content while
        // the harness capped the SERIALIZED result at the same 64 KiB, so a
        // full-budget read was always over the cap: the harness cut it mid-string and
        // replaced the object with its own envelope, destroying nextLine/nextColumn.
        const result = await read([join(workdir, 'huge-line.txt')]);
        const serialized = JSON.stringify(result);

        expect(Buffer.byteLength(serialized, 'utf8')).toBe(result.wireBytes);
        expect(result.wireBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);

        // The fields a caller needs in order to continue are present, not lost.
        const reparsed = JSON.parse(serialized);
        expect(reparsed.files[0].nextLine).not.toBeNull();
        expect(reparsed.files[0].nextByte).not.toBeNull();
        expect(reparsed.files[0].truncated).toBe(true);
    });

    it('charges the budget on escaped bytes, not raw ones', async () => {
        // 1000 newlines cost 2000 bytes once JSON-escaped. A raw-byte budget would
        // under-count them by half and overflow the envelope.
        const path = await seed('escapes.txt', '\n'.repeat(1000));
        const result = await read([path]);

        expect(result.files[0].bytes).toBe(1000);
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(result.wireBytes);
    });

    it('reports binary content IN PLACE and still reads the rest', async () => {
        // A binary file is a FILE outcome, not a broken request. It used to reject
        // the whole batch and destroy the readable file beside it.
        const nul = join(workdir, 'binary-nul.bin');
        const invalid = join(workdir, 'binary-invalid.bin');

        const result = await read([join(workdir, 'a.txt'), nul, invalid]);

        expect(result.files[0].content).toBe('alpha\n');
        expect(result.files[1].error?.code).toBe('EBINARY');
        expect(result.files[1].error?.message).toMatch(/binary data/);
        expect(result.files[1].bytes).toBe(0);
        expect(result.files[2].error?.code).toBe('EBINARY');
        expect(result.skipped).toBe(2);

        // A binary entry reserves nothing: the readable file keeps its full share.
        const alone = await read([nul]);
        expect(alone.files[0].error?.code).toBe('EBINARY');
    });

    it('reports a missing path IN PLACE and still reads the rest', async () => {
        const missing = join(workdir, 'missing.txt');
        const result = await read([join(workdir, 'a.txt'), missing]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 6,
                    sizeBytes: 6
                },
                {
                    path: missing,
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 0,
                    sizeBytes: null,
                    error: {
                        code: 'ENOENT',
                        message: `read could not find "${missing}": no such file or directory (ENOENT).`
                    }
                }
            ],
            truncated: false,
            bytes: 6,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 1
        });
    });

    it('reports a directory IN PLACE, classified, and still reads the rest', async () => {
        // A directory is neither a permission problem nor a generic I/O failure. It
        // used to reject the whole batch; now it is an errored entry that names the
        // tool that can help, and the text file beside it is still returned.
        const directory = join(workdir, 'nested');
        const result = await read([directory, join(workdir, 'a.txt')]);

        expect(result.files[0].error?.code).toBe('EISDIR');
        expect(result.files[0].error?.message).toBe(
            `read cannot read "${directory}": it is a directory, not a file. Use files to list its entries, or glob to find files inside it.`
        );
        expect(result.files[1].content).toBe('alpha\n');
        expect(result.skipped).toBe(1);
    });

    it('resumes by startByte without rescanning, matching the line-based window', async () => {
        // The efficiency contract: nextByte -> startByte must reproduce exactly what
        // counting from the start would have produced, so a caller can walk a large
        // file in O(window) per call.
        const path = join(workdir, 'lines.txt');
        // Line lengths vary ("line 1\n" is 7 bytes, "line 800\n" is 10), so the seek
        // offset is derived from the fixture rather than guessed.
        const offsetToLine800 = Buffer.byteLength(
            Array.from({ length: 799 }, (_, index) => `line ${index + 1}\n`).join(''),
            'utf8'
        );
        const byLine = await read([{ path, startLine: 800, maxLines: 10 }]);
        const bySeek = await read([{ path, startByte: offsetToLine800, startLine: 800, maxLines: 10 }]);

        expect(bySeek.files[0].content).toBe(byLine.files[0].content);
        expect(bySeek.files[0].startLine).toBe(800);
        expect(bySeek.files[0].endLine).toBe(809);
        expect(bySeek.files[0].nextByte).toBe(byLine.files[0].nextByte);
    });

    it('answers ERANGE, not an empty window, for a startByte at or past EOF', async () => {
        // D10. `startByte: 9999` on a 6-byte file used to return content "", bytes 0,
        // truncated false — the SAME shape as "this file is empty". A caller threading a
        // stale nextByte through a paging loop therefore read "the file is empty" where
        // the truth is "your offset is out of range", and stopped on a false premise.
        const path = join(workdir, 'a.txt');
        const past = await read([{ path, startByte: 9999 }]);
        const atEof = await read([{ path, startByte: 6 }]);

        expect(past.files[0].error?.code).toBe('ERANGE');
        expect(past.files[0].error?.message).toBe(
            `read could not seek "${path}" to byte 9999: the file is 6 bytes, so that offset is at or past its end (ERANGE). An empty window is NOT "this file is empty"; drop startByte to read from the beginning, or treat this as the end of the file.`
        );
        expect(past.files[0].sizeBytes).toBe(6);
        // Exactly at EOF is the same case: there is no byte there to read.
        expect(atEof.files[0].error?.code).toBe('ERANGE');
        // The last offset WITH a byte still reads.
        expect((await read([{ path, startByte: 5 }])).files[0].content).toBe('\n');

        // Per-entry, like every other failure: the readable sibling is untouched.
        const mixed = await read([path, join(workdir, 'utf8.txt')]);
        const oneBad = await read([{ path, startByte: 9999 }, join(workdir, 'utf8.txt')]);
        expect(mixed.files[0].error).toBeUndefined();
        expect(oneBad.files[0].error?.code).toBe('ERANGE');
        expect(oneBad.files[1].content).toBe('h\u00e9llo\n');
        expect(oneBad.skipped).toBe(1);
    });

    it('advances a startByte that lands inside a code point and reports the move', async () => {
        // D1. "ab" + three 2-byte é + "cd". Byte 3 is the CONTINUATION half of the first
        // é, so decoding from there used to see a lone 0b10xxxxxx byte, call the whole
        // file binary, and report EBINARY for an ordinary UTF-8 text file — while the
        // same offset through startColumn read fine.
        const path = await seed('seek-mid-codepoint.txt', 'ab\u00e9\u00e9\u00e9cd\n');

        const mid = await read([{ path, startByte: 3 }]);
        const boundary = await read([{ path, startByte: 4 }]);

        expect(mid.files[0].error).toBeUndefined();
        expect(mid.files[0].content).toBe('\u00e9\u00e9cd\n');
        // The adjustment is reported, so the answer says where the window really began.
        expect(mid.files[0].startByteAligned).toBe(4);
        // An offset already on a boundary reports no adjustment.
        expect(boundary.files[0].content).toBe('\u00e9\u00e9cd\n');
        expect(boundary.files[0].startByteAligned).toBeNull();
        // And the two now agree, which is the whole point: the error class was the bug.
        expect(mid.files[0].content).toBe(boundary.files[0].content);
    });

    it('reports the true line at a seek offset when startLine is not given', async () => {
        // D2. A seek with no `startLine` used to report the DEFAULT line number 1 for
        // bytes tens of thousands of lines deep — a wrong number, not a missing one.
        // The prefix is now counted on raw bytes, so the truth is cheap.
        const path = join(workdir, 'lines.txt');
        const offsetToLine800 = Buffer.byteLength(
            Array.from({ length: 799 }, (_, index) => `line ${index + 1}\n`).join(''),
            'utf8'
        );

        const counted = await read([{ path, startByte: offsetToLine800, maxLines: 3 }]);
        const told = await read([{ path, startByte: offsetToLine800, startLine: 800, maxLines: 3 }]);

        expect(counted.files[0].startLine).toBe(800);
        expect(counted.files[0].endLine).toBe(802);
        expect(counted.files[0].content).toBe('line 800\nline 801\nline 802\n');
        // An explicit startLine still wins, so threading nextByte + nextLine back
        // together remains correct and skips the count entirely.
        expect(told.files[0].startLine).toBe(800);
        expect(told.files[0].content).toBe(counted.files[0].content);
        // A caller that LIES about the line gets its own number back, not the truth.
        const lied = await read([{ path, startByte: offsetToLine800, startLine: 42_000, maxLines: 3 }]);
        expect(lied.files[0].startLine).toBe(42_000);
    });

    it('keeps the bulk-run fast path exact where the budget cuts mid-line', async () => {
        // The scanner appends a RUN of plain ASCII in one slice rather than one character
        // at a time, because such a run costs the same in raw bytes, wire bytes and
        // UTF-16 units and contains no newline. The risk is a budget cut that lands
        // INSIDE such a run: the slice must stop at exactly the last character that fits,
        // and `nextByte` must point at the next one.
        //
        // So the samples must be BIGGER than the budget — a 20 KB file is returned whole
        // and never exercises a mid-run cut at all (an earlier version of this test did
        // exactly that and proved nothing). Each sample here is ~300 KB of ~50-byte
        // lines, which forces the allowance to run out part-way through a line, and the
        // content is adversarial: escaped characters change the wire cost per character,
        // multi-byte characters change the raw cost, and control characters change both.
        const LINES = 6000;
        const samples: [string, string][] = [
            ['plain', Array.from({ length: LINES }, (_, i) => `line ${i} const value = compute(a, b); // note ${i}`).join('\n')],
            ['escapes', Array.from({ length: LINES }, (_, i) => `  "k${i}": "v\\${i}\t${i}\\n", value = "x"`).join('\n')],
            ['multibyte', Array.from({ length: LINES }, (_, i) => `emoji \u{1F389} \u4f60\u597d caf\u00e9 \u2013 row ${i} padded`).join('\n')],
            ['control', Array.from({ length: LINES }, (_, i) => `a${i}\u0001b${i}\u001fc${i}\u0007d${i} padded to length here`).join('\n')],
            ['crlf', Array.from({ length: LINES }, (_, i) => `row,${i},value "x", another "y", more text`).join('\r\n')]
        ];

        for (const [name, body] of samples) {
            const path = await seed(`fastpath-${name}.txt`, body);
            // No raw-size precondition: the budget is charged on the ESCAPED form, so a
            // quote-heavy sample of 237 KB raw is already over 256 KiB wire while a plain
            // one needs more. `limit === "budget"` below is the assertion that actually
            // proves the allowance bound mid-window, which is the precondition here.

            // A default read: the budget binds mid-line, and paging by nextByte must
            // stitch the file back together with nothing lost or duplicated at the join.
            const first = (await read([path])).files[0];
            expect(first.truncated, name).toBe(true);
            expect(first.limit, name).toBe('budget');

            let collected = first.content;
            let next = first;
            let pages = 0;
            while (next.truncated && next.nextByte !== null && pages < 20) {
                const page = await read([{ path, startByte: next.nextByte, startLine: next.nextLine ?? 1 }]);
                next = page.files[0];
                collected += next.content;
                pages += 1;
            }
            expect(next.truncated, `${name} reached EOF`).toBe(false);
            expect(collected, `${name} paging by nextByte`).toBe(body);

            // A cut inside a plain run must still respect the envelope exactly, and
            // `wireBytes` must be the true serialized length rather than an estimate.
            const r = await read([path]);
            expect(r.wireBytes, `${name} budget`).toBeLessThanOrEqual(r.contentBudget);
            expect(Buffer.byteLength(JSON.stringify(r), 'utf8'), `${name} wireBytes`).toBe(r.wireBytes);

            // The line-cap path, where the cut is at a line boundary instead. The
            // expected prefix is taken from the body itself — up to and including the
            // third \n — so a CRLF sample keeps its CRLFs rather than being normalised
            // by the test into something the tool never promised to produce.
            const thirdNewline = body.indexOf('\n', body.indexOf('\n', body.indexOf('\n') + 1) + 1);
            const capped = await read([{ path, maxLines: 3 }]);
            expect(capped.files[0].limit).toBe('maxLines');
            expect(capped.files[0].content, `${name} cap`).toBe(body.slice(0, thirdNewline + 1));
        }
    });

    it('names the reason a window was cut, so the caller knows what to raise', async () => {
        // D5. A `maxLines` cut and a budget cut used to be indistinguishable: identical
        // shapes, opposite remedies. `limit` tells them apart.
        const manyLines = await seed('limit-lines.txt', Array.from({ length: 30_000 }, (_, i) => `l${i}`).join('\n'));
        const oneBigLine = await seed('limit-budget.txt', 'y'.repeat(400_000));

        const byLines = await read([{ path: manyLines, maxLines: 10 }]);
        expect(byLines.files[0].truncated).toBe(true);
        expect(byLines.files[0].limit).toBe('maxLines');

        // Same file, no cap: 30,000 lines of ~6 bytes is ~180 KB, which FITS the 256 KiB
        // budget, so nothing was cut and `limit` stays null. The budget-bound case needs
        // more BYTES than the envelope holds, not more lines than a cap would allow.
        const fits = await read([{ path: manyLines }]);
        expect(fits.files[0].truncated).toBe(false);
        expect(fits.files[0].limit).toBeNull();

        const tooManyLines = await seed(
            'limit-budget-lines.txt',
            Array.from({ length: 60_001 }, (_, i) => `${i}`).join('\n')
        );
        const byBudget = await read([{ path: tooManyLines }]);
        expect(byBudget.files[0].truncated).toBe(true);
        expect(byBudget.files[0].limit).toBe('budget');

        const bigLine = await read([oneBigLine]);
        expect(bigLine.files[0].limit).toBe('budget');

        // A complete window has no reason to give.
        const whole = await read([join(workdir, 'a.txt')]);
        expect(whole.files[0].truncated).toBe(false);
        expect(whole.files[0].limit).toBeNull();
    });

    it('counts a deep startLine on raw bytes and agrees with the seek', async () => {
        // D3. The skip used to decode and iterate every skipped CHARACTER just to count
        // newlines (482 ms for a 50-line window at line 199,000 of an 11 MB file,
        // against 1.6 ms at line 1). The byte scan must give the SAME answer, and the
        // reused read buffer must not count stale bytes past `bytesRead` — a real bug
        // this pinned: an unbounded indexOf saw newlines left over from a previous,
        // larger chunk and reported line 6378 for a byte on line 4552.
        const deep = Array.from({ length: 12_000 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n');
        const path = await seed('deep-lines.txt', deep);
        const startLine = 11_000;

        const byLine = await read([{ path, startLine, maxLines: 5 }]);
        const seekByte = Buffer.byteLength(
            Array.from({ length: startLine - 1 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n') + '\n',
            'utf8'
        );
        const bySeek = await read([{ path, startByte: seekByte, maxLines: 5 }]);

        expect(byLine.files[0].content).toBe(
            Array.from({ length: 5 }, (_, k) => `line ${startLine - 1 + k} ${'z'.repeat(40)}`).join('\n') + '\n'
        );
        expect(byLine.files[0].startLine).toBe(startLine);
        expect(byLine.files[0].endLine).toBe(startLine + 4);
        // The seek with no startLine counts the same line the walk arrived at.
        expect(bySeek.files[0].startLine).toBe(byLine.files[0].startLine);
        expect(bySeek.files[0].content).toBe(byLine.files[0].content);
    });

    it('rejects an empty array instead of answering "no files"', async () => {
        await expect(read([])).rejects.toThrow('read received an empty paths array; pass at least one file path.');
    });

    it('rejects a batch larger than the metadata cap', async () => {
        // 100 paths is the schema maxItems; the implementation enforces it too so
        // a direct call cannot return thousands of metadata entries.
        const tooMany = Array.from({ length: FILE_READ_MAX_TARGETS + 1 }, () => join(workdir, 'a.txt'));

        await expect(read(tooMany)).rejects.toThrow(
            `read accepts at most ${FILE_READ_MAX_TARGETS} paths per call; received ${FILE_READ_MAX_TARGETS + 1}. Split the batch.`
        );
    });

    it('rejects blank, NUL, non-string, and non-array arguments', async () => {
        await expect(read([''])).rejects.toThrow('read paths must be non-empty strings.');
        await expect(read([join(workdir, 'a.txt'), ''])).rejects.toThrow('read paths must be non-empty strings.');
        await expect(read(['a\u0000b'])).rejects.toThrow('read paths must not contain NUL characters.');
        await expect(read([7] as never)).rejects.toThrow(
            'read paths must be strings or { path, startLine, startColumn, startByte, maxLines } objects.'
        );
        // A model that sends a bare string instead of an array is told the shape.
        await expect(read('a.txt' as never)).rejects.toThrow(
            'read expects an array of paths (strings or { path, startLine, startColumn, startByte, maxLines } objects), e.g. ["package.json"].'
        );
        await expect(read([{ path: '' }])).rejects.toThrow('read paths must be non-empty strings.');
        await expect(read([{ path: 7 } as never])).rejects.toThrow('read paths must be non-empty strings.');
    });

    it('rejects invalid range values instead of silently clamping', async () => {
        await expect(read([{ path: join(workdir, 'a.txt'), startLine: 0 }])).rejects.toThrow(
            'read startLine must be an integer between 1 and 9007199254740991; received 0.'
        );
        await expect(read([{ path: join(workdir, 'a.txt'), startLine: 1.5 }])).rejects.toThrow(
            'read startLine must be an integer between 1 and 9007199254740991; received 1.5.'
        );
        await expect(read([{ path: join(workdir, 'a.txt'), startColumn: -1 }])).rejects.toThrow(
            'read startColumn must be an integer between 0 and 9007199254740991; received -1.'
        );
        await expect(read([{ path: join(workdir, 'a.txt'), maxLines: 0 }])).rejects.toThrow(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for no line cap; received 0.`
        );
        await expect(read([{ path: join(workdir, 'a.txt'), maxLines: FILE_READ_MAX_LINES + 1 }])).rejects.toThrow(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for no line cap; received ${FILE_READ_MAX_LINES + 1}.`
        );
        // The exported default round-trips: a caller that reads FILE_READ_DEFAULT_MAX_LINES
        // and passes it back gets the no-cap behaviour, not a validation error. It is the
        // one value outside [1, FILE_READ_MAX_LINES] that is accepted, and the message
        // says "or omitted" rather than printing the sentinel.
        await expect(read([{ path: join(workdir, 'a.txt'), maxLines: FILE_READ_DEFAULT_MAX_LINES }])).resolves.toMatchObject({
            files: [{ content: 'alpha\n' }]
        });
        await expect(read([{ path: join(workdir, 'a.txt'), startByte: -1 }])).rejects.toThrow(
            'read startByte must be a non-negative integer or null; received -1.'
        );
        // null is the documented way to say "count lines", and is accepted.
        await expect(read([{ path: join(workdir, 'a.txt'), startByte: null }])).resolves.toMatchObject({
            files: [{ content: 'alpha\n' }]
        });
    });

    it('accepts an object target with only a path, using the defaults', async () => {
        const result = await read([{ path: join(workdir, 'a.txt') }]);

        expect(withWire(result)).toEqual({
            files: [
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    limit: null,
                    startByteAligned: null,
                    nextLine: null,
                    nextColumn: null,
                    nextByte: null,
                    bytes: 6,
                    sizeBytes: 6
                }
            ],
            truncated: false,
            bytes: 6,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped: 0
        });
    });

    it('declares a single "paths" array property whose items are strings or ranges', () => {
        expect(read.parameters).toEqual({
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    path: {
                                        type: 'string',
                                        description:
                                            'File to read, absolute or relative to the working directory.'
                                    },
                                    startLine: {
                                        type: 'integer',
                                        minimum: 1,
                                        description: '1-based first line to return. Defaults to 1.'
                                    },
                                    startColumn: {
                                        type: 'integer',
                                        minimum: 0,
                                        description:
                                            '0-based UTF-8 byte offset within startLine, for continuing a giant line. Defaults to 0.'
                                    },
                                    startByte: {
                                        type: 'integer',
                                        minimum: 0,
                                        description:
                                            'Absolute 0-based UTF-8 byte offset to seek to, skipping the line count. Feed back a previous nextByte. An offset inside a multi-byte character is advanced to the next code-point boundary and reported as startByteAligned; an offset at or past EOF is an ERANGE entry. Without an explicit startLine the true line at this offset is counted and reported. Defaults to null (count from the start).'
                                    },
                                    maxLines: {
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: 20_000,
                                        description:
                                            'Maximum lines to return. OMIT for no line cap: the 256 KiB budget then decides, which is the default. When supplied it must be an integer in [1, 20000]. A window cut by this cap reports limit: "maxLines".'
                                    }
                                },
                                required: ['path'],
                                additionalProperties: false
                            }
                        ]
                    },
                    description:
                        'Files to read, in the order the results are returned. A string reads a default window; an object selects a line/byte range.'
                }
            },
            required: ['paths'],
            additionalProperties: false
        });
        expect(toolParameterKey(read.parameters)).toBe('paths');
    });

    it('publishes the documented default and hard caps', () => {
        // No default line cap: the budget is the limit. An EXPLICIT maxLines is still
        // bounded by FILE_READ_MAX_LINES, which is why the two numbers differ.
        expect(FILE_READ_DEFAULT_MAX_LINES).toBe(Number.MAX_SAFE_INTEGER);
        expect(FILE_READ_DEFAULT_MAX_LINES).toBeGreaterThan(FILE_READ_MAX_LINES);
        expect(FILE_READ_MAX_LINES).toBe(20_000);
        expect(FILE_READ_MAX_TARGETS).toBe(100);
        // read's budget must never exceed the harness wire cap, or a full-budget read
        // gets cut mid-string and loses the continuation fields. The value is a
        // literal in the tool (a relative import would become a captured source
        // dependency of the compiled preset), so THIS is what holds the two together.
        expect(FILE_READ_WIRE_BUDGET).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(FILE_READ_WIRE_BUDGET).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(FILE_READ_CONTENT_BUDGET).toBe(FILE_READ_WIRE_BUDGET);
        expect(FILE_READ_WIRE_BUDGET).toBe(256 * 1024);
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const result = await read.execute({
            parameters: [{ path: join(workdir, 'lines.txt'), startLine: 2, maxLines: 1 }]
        });

        expect(result.files[0]).toEqual({
            path: join(workdir, 'lines.txt'),
            content: 'line 2\n',
            startLine: 2,
            endLine: 2,
            truncated: true,
            limit: 'maxLines',
            startByteAligned: null,
            nextLine: 3,
            nextColumn: 0,
            // "line 1\n" + "line 2\n": the absolute offset of the first unread byte.
            nextByte: 14,
            bytes: 7,
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8')
        });
        expect(result.truncated).toBe(true);
        expect(result.bytes).toBe(7);
        expect(result.contentBudget).toBe(FILE_READ_WIRE_BUDGET);
    });
});
