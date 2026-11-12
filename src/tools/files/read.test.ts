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
//   - the DEFAULT window is a CONTEXT budget, not a memory budget (D11): 2000 lines and
//     64 KiB per file, both raisable per request up to the 20 000 / 262 144 ceilings,
//     and `limit` names which of the three governors (maxLines / maxBytes / budget)
//     actually cut the window — the difference between "raise it" and "want less";
//   - a window that counted the whole file publishes `lineCount`, and a seek past the
//     end — on EITHER axis, byte or line — is an ERANGE entry naming the file's size or
//     line count, never an empty window that reads as "this file is empty";
//   - the model receives a PROSE rendering of these same facts (`toolText`), never the
//     escaped JSON, and it is provably no larger than the machine view (`modelBytes`),
//     so the harness envelope can never cut it;
//   - the aggregate budget is measured on the SERIALIZED result, so a full-budget
//     read always survives the harness's own wire cap intact — the fields needed to
//     continue are never destroyed;
//   - allocation is by DEMAND: a small file hands its unused share back instead of
//     stranding a large one at 1/N of the budget;
//   - UTF-8 bytes (not UTF-16 code units) are counted, and CRLF/empty files keep
//     their exact text;
//   - a missing path, a directory, a permission denial, or binary content is
//     reported IN PLACE as an errored entry and does NOT destroy the rest of the
//     batch; only a malformed request rejects the whole call. An unreadable path also
//     says WHAT WAS THERE — did-you-mean names for ENOENT, an entry preview for EISDIR.
//
// Fixtures are real files under the repo-root `Temp/` (never OS temp), one unique
// directory per run, removed afterwards. Module-relative so the location does not
// depend on the cwd Vitest was started from — the same convention as
// server/environment.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundToolResult, toolParameterKey, unwrapToolResult } from '../../core';
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from '../../core/result-budget';
import {
    read as readTool,
    FILE_READ_METADATA,
    FILE_READ_CONTENT_BUDGET,
    FILE_READ_DEFAULT_MAX_BYTES,
    FILE_READ_MAX_BYTES,
    FILE_READ_DEFAULT_MAX_LINES,
    FILE_READ_MAX_LINES,
    FILE_READ_MAX_TARGETS,
    FILE_READ_NOTE_MAX_PATHS,
    FILE_READ_NOTE_MIN_BYTES,
    FILE_READ_WIRE_BUDGET
} from './read.tool';
import type { FileReadEntry, FileReadResult } from './read.tool';

// A DIRECT call now receives the `toolText()` envelope, because the whole point of the
// tool is that a model and a machine consume the same facts in two different renderings
// (see core/tool-text.ts). These tests are machines: they unwrap to the structured
// result, and the prose is asserted separately, exactly as the transcript would see it.
const read = async (paths: Parameters<typeof readTool>[0]): Promise<FileReadResult> =>
    unwrapToolResult<FileReadResult>(await readTool(paths)).content;

// The prose this same call hands the MODEL, byte for byte.
const projection = async (paths: Parameters<typeof readTool>[0]): Promise<string> =>
    unwrapToolResult(await readTool(paths)).text as string;

// The machine view plus its projection together, for the tests that compare the two.
const readBoth = async (paths: Parameters<typeof readTool>[0]) => {
    const unwrapped = unwrapToolResult<FileReadResult>(await readTool(paths));

    return { result: unwrapped.content, text: unwrapped.text as string };
};

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

// `wireBytes` and `modelBytes` both depend on the length of the per-run temp directory
// name, so they are replaced with matchers rather than literals. Everything else is
// asserted exactly, which keeps the strict whole-object comparison the contract needs.
const withWire = (result: FileReadResult) => ({
    ...result,
    wireBytes: expect.any(Number),
    modelBytes: expect.any(Number)
});

// The line fixtures are generated rather than pasted; the assertions below spell out
// the exact slice expected for each window. `lines.txt` is 1300 lines, which is INSIDE
// the 2000-line default, so the whole-file, EOF and past-EOF windows are all reachable
// without fighting the default. `many-lines.txt` is 5100 lines, which is OUTSIDE it, and
// it is the fixture that proves the default actually cuts (D11) and that an explicit
// `maxLines` still walks past the default up to the 20000 ceiling.
const linesUpTo = (count: number): string =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join('');

const LINES_1300 = linesUpTo(1300);
const LINES_5100 = linesUpTo(5100);
// 11 bytes per line (`line 5100\n`), so 5100 lines are 56_100 bytes: inside the 64 KiB
// per-file byte default. A default read of this file is therefore cut by the LINE cap
// and reports `limit: "maxLines"`, which is exactly the diagnosis a byte cut is not.
const LINES_5100_BYTES = 56_100;

// The `maxLines` CEILING fixture: 20 001 lines of 7-11 bytes, so a request for exactly
// FILE_READ_MAX_LINES (20 000) is cut by the LINE cap rather than by the byte budget
// (20 000 lines serialize to 228 894 bytes, inside the 262 144-byte envelope) while the
// file stays at 208 905 bytes, over the 65 536-byte note gate. Every number the note
// quotes is derivable from this shape.
const LINES_20001 = linesUpTo(20_001);

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

    // The R4 fixtures, in the shape the reviewed run actually hit: 261 KB of ordinary
    // 58-byte lines needs 265,500 SERIALIZED bytes (every `\n` escapes to two), so the
    // 256 KiB envelope CUTS it and the caller needs the advisory; the same 261 000
    // bytes on ONE line needs no escaping and comes back WHOLE, where it does not.
    const fixedLine = `${'x'.repeat(57)}\n`; // exactly 58 bytes
    await seed('big-multiline.txt', fixedLine.repeat(4_500)); // exactly 261_000 bytes
    // 150 000 bytes on ONE line: over the 64 KiB note gate, and small enough that the
    // whole envelope (less every reserve) still holds it — which is what makes it the
    // "bigger than the gate but nothing was withheld" case. 261 000 used to fit; the D11
    // projection reserve means it no longer does, and a fixture that is 92 bytes away
    // from a cap is a fixture that tests the cap, not the absence of one.
    await seed('big-singleline.txt', 'x'.repeat(150_000)); // exactly 150 000 bytes

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
                    sizeBytes: 5,
                    // A file ending with a newline holds exactly one line per
                    // terminator — the `wc -l` count the entry's own `endLine` uses.
                    lineCount: 1
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
                    sizeBytes: 6,
                    lineCount: 1
                }
            ],
            truncated: false,
            bytes: 11,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            modelBytes: expect.any(Number),
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
                        sizeBytes: 6,
                        lineCount: 1
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
                        sizeBytes: 5,
                        lineCount: 1
                    }
                ],
                truncated: false,
                bytes: 11,
                wireBytes: expect.any(Number),
                contentBudget: FILE_READ_WIRE_BUDGET,
                modelBytes: expect.any(Number),
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
                    sizeBytes: 10,
                    lineCount: 2
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
                    sizeBytes: 0,
                    lineCount: 0
                }
            ],
            truncated: false,
            bytes: 10,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            modelBytes: expect.any(Number),
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
                    sizeBytes: 7,
                    lineCount: 1
                }
            ],
            truncated: false,
            bytes: 7,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            modelBytes: expect.any(Number),
            skipped: 0
        });
    });

    it('cuts the 2000-line default window and says so, and an explicit maxLines walks past it', async () => {
        // D11 replaced the "no default line cap" contract. This file — 5,100 lines of
        // 11 bytes, 56 100 bytes, a fifth of the byte envelope — is exactly the shape
        // that made the old default dangerous: it FIT the budget, so a default read
        // handed the caller all 5,100 lines (≈15k tokens) and the caller only learned
        // afterwards that the tool had volunteered them.
        const result = await read([join(workdir, 'many-lines.txt')]);
        const entry = result.files[0];

        expect(entry.startLine).toBe(1);
        expect(entry.endLine).toBe(FILE_READ_DEFAULT_MAX_LINES);
        expect(entry.truncated).toBe(true);
        // Bytes are NOT the governor here — the file is well inside the byte default —
        // so `limit` names the line cap, which is the answer that tells the caller to
        // raise maxLines rather than accept a smaller window.
        expect(entry.limit).toBe('maxLines');
        expect(entry.nextLine).toBe(FILE_READ_DEFAULT_MAX_LINES + 1);
        expect(entry.nextColumn).toBe(0);
        expect(entry.nextByte).toBe(entry.bytes);
        // A cut window never claims to know the file's total.
        expect(entry.lineCount).toBeUndefined();
        expect(entry.bytes).toBeLessThan(LINES_5100_BYTES);
        // The whole point: a default call is now a bounded window, not the envelope.
        expect(result.wireBytes).toBeLessThan(FILE_READ_DEFAULT_MAX_BYTES);

        // The other half of the contract: the cap is a DEFAULT, not a ceiling. Asking
        // explicitly still gets the whole file, with the total now known.
        const asked = await read([
            { path: join(workdir, 'many-lines.txt'), maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }
        ]);
        const whole = asked.files[0];

        expect(whole.content).toBe(LINES_5100);
        expect(whole.endLine).toBe(5100);
        expect(whole.truncated).toBe(false);
        expect(whole.limit).toBeNull();
        expect(whole.lineCount).toBe(5100);
        expect(asked.wireBytes).toBeLessThan(FILE_READ_WIRE_BUDGET);
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

    it('fills the wire budget when the caller asks for the whole envelope', async () => {
        // The utilization contract (improvement #3), now scoped to an EXPLICIT ask. A
        // 200-line default used 14.2% of the budget and a 1200-line default used 22.7%,
        // so the tool spent a round trip to deliver a fifth of what the envelope
        // allowed; `maxBytes: FILE_READ_MAX_BYTES` still buys the whole envelope, which
        // is what makes the 64 KiB DEFAULT a policy rather than a ceiling. Lines sized
        // like this repository's own source (mean ~57 bytes) must reach the budget when
        // asked, so `maxLines` stays a guard rather than the effective limit.
        const path = await seed(
            'sized.txt',
            Array.from({ length: 20_000 }, (_, index) => `line ${index} const value = compute(a, b); // note ${index}\n`).join('')
        );

        const result = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const entry = result.files[0];

        expect(entry.truncated).toBe(true);
        // Budget-bound, not line-bound: far fewer than the 20 000-line ceiling came back
        // (~5 000 lines of 57 bytes), so `limit` must NOT send the caller off to raise a
        // line cap that never bound it.
        expect(entry.endLine).toBeLessThan(FILE_READ_MAX_LINES);
        expect(entry.limit).toBe('budget');
        expect(result.wireBytes / FILE_READ_WIRE_BUDGET).toBeGreaterThan(0.8);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
    });

    it('the default of its own accord takes a context-sized window, not the envelope', async () => {
        // The other side of the same fixture. Before D11 the call above WAS the default,
        // and measured on this package's own `harness.ts` one such read cost ~64k-78k
        // tokens: a third to two thirds of a 128k context, from a call that asked for
        // nothing. The default now stops at 64 KiB, and says which governor stopped it.
        const path = await seed(
            'sized-default.txt',
            Array.from({ length: 20_000 }, (_, index) => `line ${index} const value = compute(a, b); // note ${index}\n`).join('')
        );

        const result = await read([path]);
        const entry = result.files[0];

        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxBytes');
        expect(entry.bytes).toBeLessThanOrEqual(FILE_READ_DEFAULT_MAX_BYTES);
        expect(result.wireBytes).toBeLessThan(FILE_READ_DEFAULT_MAX_BYTES * 2);
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
            modelBytes: expect.any(Number),
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
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8'),
            // The window ran to EOF, so the whole-file count was counted on the way
            // there and is published; a cut window does not claim it.
            lineCount: 1300
        });
    });

    it('answers ERANGE, naming the line count, for a startLine past the end (D11-line)', async () => {
        // D10 made a `startByte` past EOF an ERANGE entry and left the LINE axis with
        // the bug it removed: `startLine: 5000` on a 1301-line file answered an empty,
        // UNTRUNCATED window, which a caller paging with a stale `nextLine` reads as
        // "this file is empty" and loops on. Proving the line is missing already walked
        // every newline in the file, so the message can name the total for free.
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
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8'),
            error: {
                code: 'ERANGE',
                message:
                    `read could not start "${join(workdir, 'lines.txt')}" at line 5000: the file has 1300 lines, ` +
                    'so that line does not exist (ERANGE). An empty window is NOT "this file is empty"; drop startLine ' +
                    'to read from the beginning, or treat this as the end of the file.'
            }
        });
        expect(result.skipped).toBe(1);
        // A failed entry takes no content, so its siblings keep their full share.
        const mixed = await read([join(workdir, 'a.txt'), { path: join(workdir, 'lines.txt'), startLine: 5000 }]);

        expect(mixed.files[0].content).toBe('alpha\n');
        expect(mixed.files[0].error).toBeUndefined();
        expect(mixed.files[1].error?.code).toBe('ERANGE');
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
            sizeBytes: 10,
            lineCount: 2
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
            sizeBytes: 24,
            lineCount: 3
        });
    });

    it('returns a 70 KB single line whole when asked, and a 64 KiB window when not', async () => {
        // The 256 KiB envelope is unchanged; what changed (D11) is that reaching it is
        // now an explicit ask. `giant.txt` — one 70 000-byte line — sits just past the
        // default, so it demonstrates both halves of the new contract with one fixture.
        const result = await read([{ path: join(workdir, 'giant.txt'), maxBytes: FILE_READ_MAX_BYTES }]);

        expect(result.files[0].bytes).toBe(70_000);
        expect(result.files[0].truncated).toBe(false);
        expect(result.files[0].nextByte).toBeNull();
        // One line, unterminated: the count is exactly one, which is also what the
        // projection's header says.
        expect(result.files[0].lineCount).toBe(1);

        const defaulted = await read([join(workdir, 'giant.txt')]);

        expect(defaulted.files[0].truncated).toBe(true);
        expect(defaulted.files[0].limit).toBe('maxBytes');
        expect(defaulted.files[0].bytes).toBe(FILE_READ_DEFAULT_MAX_BYTES);
        // A cut window has no idea how big the file's remainder is, and says nothing.
        expect(defaulted.files[0].lineCount).toBeUndefined();
    });

    it('cuts a line larger than the allowance and resumes exactly at nextByte', async () => {
        const result = await read([{ path: join(workdir, 'huge-line.txt'), maxBytes: FILE_READ_MAX_BYTES }]);
        const entry = result.files[0];

        expect(entry.truncated).toBe(true);
        expect(entry.nextLine).toBe(1);
        expect(entry.bytes).toBeGreaterThan(200_000);
        expect(entry.bytes).toBeLessThanOrEqual(FILE_READ_MAX_BYTES);
        expect(entry.nextByte).toBe(entry.bytes);

        // The whole file is reconstructed by paging with startByte, with no byte
        // lost or duplicated at any boundary. Every page asks for the same allowance
        // the first one did — a page that let it fall back to the 64 KiB default would
        // still terminate, and this loop would silently be proving the wrong thing.
        const original = 'x'.repeat(300_000) + '\nB\nC\n';
        let collected = entry.content;
        let next = entry;

        while (next.truncated && next.nextByte !== null) {
            const page = await read([
                {
                    path: join(workdir, 'huge-line.txt'),
                    startByte: next.nextByte,
                    startLine: next.nextLine ?? 1,
                    maxBytes: FILE_READ_MAX_BYTES
                }
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

        // R4: and the advisory survives with them. `huge-line.txt` is 300 006 bytes and
        // its window is cut by the envelope, so this is a large-file truncation - the
        // note was reserved before the split precisely so that this call could carry it
        // without crossing the cap the test exists to protect.
        expect(reparsed.note).toContain('is 300005 bytes');
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
                    sizeBytes: 6,
                    lineCount: 1
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
                        // The historical sentence, verbatim, and then the guidance this
                        // tool adds on the failure path (asserted separately below,
                        // because which hint applies depends on what exists on disk).
                        message:
                            `read could not find "${missing}": no such file or directory (ENOENT). Nothing in "${workdir}" resembles that name; list the folder (files/glob) before assuming the path is right.`
                    }
                }
            ],
            truncated: false,
            bytes: 6,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            modelBytes: expect.any(Number),
            skipped: 1
        });
    });

    it('names what WAS there: did-you-mean for a near-miss, a preview for a directory', async () => {
        // A bare errno wastes the round trip it cost. An agent that typed `index.ts`
        // when the file is `src/index.ts`, or copied a name through a document that
        // swapped an ASCII space for NO-BREAK, wants the candidate list now, not a
        // second call to glob.
        const dir = await seed('suggest/deeply/nested-target.ts', 'export const x = 1;\n');
        const folder = dir.slice(0, dir.lastIndexOf('/'));
        await seed('suggest/deeply/nested-target.test.ts', 'test\n');
        await seed('suggest/deeply/other.ts', 'other\n');

        const typo = await read([`${folder}/nested-targt.ts`]);
        const message = typo.files[0].error?.message ?? '';

        expect(typo.files[0].error?.code).toBe('ENOENT');
        expect(message).toContain('no such file or directory (ENOENT).');
        expect(message).toContain('Did you mean');
        // Closest first: the exact-shape near-miss precedes the longer sibling.
        expect(message.indexOf('"nested-target.ts"')).toBeLessThan(message.indexOf('"nested-target.test.ts"'));
        expect(message).toContain(`in "${folder}"`);

        // A name whose difference is invisible (NBSP, curly apostrophe) still matches.
        const copied = await seed('suggest/deeply/report name.ts', 'x\n');
        void copied;
        const invis = await read([`${folder}/report\u00a0name.ts`]);

        expect(invis.files[0].error?.message).toContain('"report name.ts"');

        // Suggestions are BOUNDED and never invent: a folder with no near-miss at all
        // gets the plain sentence plus where the path stopped existing.
        const unrelated = await read([`${folder}/zzzz-nothing-like.ts`]);

        expect(unrelated.files[0].error?.message).not.toContain('Did you mean');
        expect(unrelated.files[0].error?.message).toContain('list the folder (files/glob)');

        // EISDIR previews the entries instead of shrugging.
        const directory = await seed('suggest/preview/one.txt', '1\n');
        await seed('suggest/preview/two.txt', '2\n');
        void directory;
        const listed = await read([`${workdir}/suggest/preview`]);

        expect(listed.files[0].error?.code).toBe('EISDIR');
        expect(listed.files[0].error?.message).toContain('Its entries: one.txt, two.txt.');
    });

    it('reports a directory IN PLACE, classified, and still reads the rest', async () => {
        // A directory is neither a permission problem nor a generic I/O failure. It
        // used to reject the whole batch; now it is an errored entry that names the
        // tool that can help, and the text file beside it is still returned.
        const directory = join(workdir, 'nested');
        const result = await read([directory, join(workdir, 'a.txt')]);

        expect(result.files[0].error?.code).toBe('EISDIR');
        expect(result.files[0].error?.message).toBe(
            `read cannot read "${directory}": it is a directory, not a file. Its entries: c.txt. Pass a file path inside it, or use files/glob to list more.`
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

            // A read asking for the whole envelope: the batch budget then binds
            // mid-line (the 64 KiB default would bind first and report `maxBytes`,
            // which is a different governor and a different test), and paging by
            // nextByte must stitch the file back with nothing lost at the join.
            const first = (await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }])).files[0];
            expect(first.truncated, name).toBe(true);
            expect(first.limit, name).toBe('budget');

            let collected = first.content;
            let next = first;
            let pages = 0;
            while (next.truncated && next.nextByte !== null && pages < 20) {
                const page = await read([
                    {
                        path,
                        startByte: next.nextByte,
                        startLine: next.nextLine ?? 1,
                        maxBytes: FILE_READ_MAX_BYTES,
                        maxLines: FILE_READ_MAX_LINES
                    }
                ]);
                next = page.files[0];
                collected += next.content;
                pages += 1;
            }
            expect(next.truncated, `${name} reached EOF`).toBe(false);
            expect(collected, `${name} paging by nextByte`).toBe(body);

            // A cut inside a plain run must still respect the envelope exactly, and
            // `wireBytes` must be the true serialized length rather than an estimate.
            const r = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
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
        // D5, with D11's third reason. The three cut reasons have OPPOSITE remedies, and
        // which one fires depends on which governor is nearest — the point of naming it.
        const manyLines = await seed('limit-lines.txt', Array.from({ length: 19_000 }, (_, i) => `l${i}`).join('\n'));
        const heavyLines = await seed('limit-budget-lines.txt', `${'y'.repeat(20)}\n`.repeat(15_000));
        const oneBigLine = await seed('limit-budget.txt', 'y'.repeat(400_000));

        // 1. The caller's own line cap. 19 000 lines of ~7 bytes is ~104 KB, comfortably
        //    inside the byte envelope, so bytes cannot be the reason.
        const byLines = await read([{ path: manyLines, maxLines: 10 }]);
        expect(byLines.files[0].truncated).toBe(true);
        expect(byLines.files[0].limit).toBe('maxLines');

        // 2. The same file, no caps at all: it now FITS everything the tool allows —
        //    under the 20 000-line ceiling and under the 256 KiB envelope — so nothing
        //    was cut and `limit` stays null, with the whole-file count published because
        //    the scan ran to EOF.
        const fits = await read([{ path: manyLines, maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }]);
        expect(fits.files[0].truncated).toBe(false);
        expect(fits.files[0].limit).toBeNull();
        expect(fits.files[0].lineCount).toBe(19_000);

        // 3. The DEFAULT of the same file: 19 000 lines over the 2000-line default, well
        //    under the 64 KiB allowance (13 KB), so the LINE governor is what stopped it —
        //    and "raise maxLines" is the right advice here.
        expect((await read([{ path: manyLines }])).files[0].limit).toBe('maxLines');

        // 4. The SHARED envelope: 15 000 lines of 21 bytes is 315 000 bytes, more than
        //    262 144 and fewer than 20 000 lines, so with both caps at their ceilings the
        //    batch budget is the only thing left that can bind. Raising either cap on this
        //    path would achieve nothing, which is what the label tells the caller.
        const byBudget = await read([
            { path: heavyLines, maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }
        ]);
        expect(byBudget.files[0].truncated).toBe(true);
        expect(byBudget.files[0].limit).toBe('budget');

        // One huge line, asked generously: still the envelope, because 400 000 bytes do
        // not fit it however the line is paged.
        const bigLine = await read([{ path: oneBigLine, maxBytes: FILE_READ_MAX_BYTES }]);
        expect(bigLine.files[0].limit).toBe('budget');

        // 5. The same file by DEFAULT: its own 64 KiB allowance stopped it long before
        //    the envelope, a DIFFERENT answer, and the reason the third label exists —
        //    raising `maxBytes` helps here and changes nothing in the paragraph above.
        const byBytes = await read([oneBigLine]);
        expect(byBytes.files[0].limit).toBe('maxBytes');
        expect(byBytes.files[0].bytes).toBeLessThanOrEqual(FILE_READ_DEFAULT_MAX_BYTES);

        // A complete window has no reason to give.
        const whole = await read([join(workdir, 'a.txt')]);
        expect(whole.files[0].truncated).toBe(false);
        expect(whole.files[0].limit).toBeNull();
    });

    // -----------------------------------------------------------------------
    // THE LARGE-FILE ADVISORY (`note`, R4). Every entry already carries
    // `truncated`/`limit`/`nextByte`, and in the reviewed run those fields were present
    // and still missed: a 261 KB file came back at 256 KiB with no prose saying the
    // file continued. These tests pin the sentence, the exact conditions it appears
    // under, and the budget accounting that keeps it inside the wire cap.
    // -----------------------------------------------------------------------

    it('publishes the note thresholds it documents', () => {
        // The gate a caller can reason about: 64 KiB, the size every other file tool in
        // this package caps a response at, and two named paths.
        expect(FILE_READ_NOTE_MIN_BYTES).toBe(65_536);
        expect(FILE_READ_NOTE_MAX_PATHS).toBe(2);
    });

    it('names the size, the bytes returned, and the exact continuation for a cut large file', async () => {
        const path = join(workdir, 'big-multiline.txt');
        const full = await readFile(path, 'utf8');
        // `maxBytes` at the ceiling, deliberately: this test is about the SHARED 256 KiB
        // envelope and the note reserve priced against it, which is what the F1/F2
        // regressions were about. Under the 64 KiB DEFAULT the file would be cut by its
        // own allowance (`limit: "maxBytes"`) and never reach the envelope, so the
        // default-cut case is pinned separately and this one keeps asking for the whole.
        const result = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const entry = result.files[0];

        // The premise, in exact bytes: 4500 lines of 58 is 261 000 raw, and 265 500
        // SERIALIZED (a `\n` costs two), so the 262 144-byte envelope must cut it.
        expect(Buffer.byteLength(full, 'utf8')).toBe(261_000);
        expect(entry.sizeBytes).toBe(261_000);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('budget');
        // The window starts at byte 0, so the first unread byte IS the number of bytes
        // returned - the value the note quotes as the resume offset.
        expect(entry.nextByte).toBe(entry.bytes);
        expect(entry.bytes).toBeLessThan(261_000);
        // The note costs a few hundred bytes of a 262 144-byte budget, never a sizeable
        // share of it (the bound a caller needs to trust the reserve).
        expect(entry.bytes).toBeGreaterThan(253_000);

        // The sentence itself, asserted whole. The `{ startLine, startColumn }` half is
        // spelled out only when the cut actually landed inside a line (which it does
        // here, because the allowance is not a whole number of lines); quoting a column
        // of 0 would be the tool claiming a mid-line resume it did not perform.
        const column = entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 261000 bytes; returned ${entry.bytes} (limit: budget) - ` +
                `continue at startByte ${entry.nextByte}, or { startLine: ${entry.nextLine}${column} }.`
        );

        // And the advice is correct rather than decorative: what the note names as the
        // continuation rebuilds the file exactly, with nothing duplicated or dropped.
        const rest = await read([{ path, startByte: entry.nextByte as number }]);
        expect(rest.files[0].truncated).toBe(false);
        expect(entry.content + rest.files[0].content).toBe(full);
    });

    it('keeps a large-file read with its note inside the wire budget', async () => {
        // R4's other half: the note's worst case is reserved BEFORE the content budget
        // is split (`noteReserve` in ./read.tool.ts), so quoting a path, two numbers and
        // a continuation cannot push the response past the cap the harness would cut it
        // at - which is the case the review hit, because the advisory is exactly what an
        // envelope truncation would have destroyed.
        const result = await read([join(workdir, 'big-multiline.txt')]);
        const serialized = JSON.stringify(result);

        expect(result.note).toBeTypeOf('string');
        expect(Buffer.byteLength(serialized, 'utf8')).toBe(result.wireBytes);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
        expect(result.wireBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);

        // The advisory leads the serialized object, so even a hypothetical envelope cut
        // (which the assertion above is what prevents) keeps it.
        expect(serialized.startsWith('{"note":"read: ')).toBe(true);
    });

    it('holds the wire cap for a cut large file under a long non-ASCII path', async () => {
        // F1 regression. `wireBytes` is a UTF-8 measurement (see `shape()` in
        // ./read.tool.ts), so every reserve charged against the same budget has to be
        // UTF-8 too. `entryOverhead` and `noteReserve` priced the path with
        // `JSON.stringify(path).length`, which counts UTF-16 CODE UNITS: a CJK character
        // costs 3 bytes on the wire and 1 unit in that count. Six nested CJK directories
        // plus a CJK file name put 103 multi-byte characters in the path the ENTRY quotes
        // and the NOTE quotes again - 412 bytes of response nobody priced - and a
        // full-budget read measured 262,196 bytes against the 262,144-byte harness cap,
        // so `boundToolResult` threw the whole object away and the continuation fields
        // the note advertises were destroyed with it.
        const cjkSegment = '读取大文件窗口预算契约测试目录'; // 15 chars, 45 UTF-8 bytes
        const cjkName = '大文件截断续读回归测试文件.txt'; // 13 CJK + ".txt" = 17 chars, 43 bytes
        const relative = `${Array.from({ length: 6 }, () => cjkSegment).join('/')}/${cjkName}`;
        // The same 261 000 bytes / 4 500 lines as `big-multiline.txt`, so the ONLY
        // variable this test moves is how the path is spelled.
        const path = await seed(relative, `${'x'.repeat(57)}\n`.repeat(4_500));
        const full = await readFile(path, 'utf8');
        const result = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const entry = result.files[0];

        // The premise, in exact numbers: 103 multi-byte characters, so the resolved path
        // is 206 bytes longer than its code-unit length, and the file is the same cut.
        expect(entry.path.length + 206).toBe(Buffer.byteLength(entry.path, 'utf8'));
        expect(Buffer.byteLength(full, 'utf8')).toBe(261_000);
        expect(entry.sizeBytes).toBe(261_000);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('budget');
        expect(entry.nextByte).toBe(entry.bytes);

        // The note is present and EXACT - not merely "survived" - including the path as
        // `JSON.stringify` renders it. CJK characters are not escaped, so the characters
        // the note quotes are the bytes that broke the code-unit accounting.
        const column = entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 261000 bytes; returned ${entry.bytes} (limit: budget) - ` +
                `continue at startByte ${entry.nextByte}, or { startLine: ${entry.nextLine}${column} }.`
        );

        // The cap itself, held: `wireBytes` is the real serialized length of THIS
        // response, and it fits both the tool's own budget and the harness's.
        const serialized = JSON.stringify(result);

        expect(Buffer.byteLength(serialized, 'utf8')).toBe(result.wireBytes);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
        expect(result.wireBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);

        // End to end, with the module that actually does the cutting: an under-reserved
        // response comes back `truncated: true` with an envelope instead of `files`,
        // which is the failure this test exists for.
        const bounded = boundToolResult(serialized);

        expect(bounded.truncated).toBe(false);
        expect(bounded.content).toBe(serialized);
        expect(bounded.originalBytes).toBe(result.wireBytes);
        expect((JSON.parse(bounded.content).files[0] as { nextByte: number }).nextByte).toBe(entry.nextByte);

        // And the continuation the note names is correct under the non-ASCII path too,
        // so the advice is not just affordable - it resumes the file exactly.
        const rest = await read([{ path, startByte: entry.nextByte as number }]);

        expect(rest.files[0].truncated).toBe(false);
        expect(entry.content + rest.files[0].content).toBe(full);
    });

    // `"` and `\` are illegal in a Windows file name (and `\` is its separator), so the
    // fixture this test needs can only exist on a POSIX filesystem; CI is ubuntu-latest.
    it.runIf(process.platform !== 'win32')('holds the wire cap for a cut large file under an escape-heavy path', async () => {
        // F1-residual regression. F1 moved the reserves from code units to UTF-8 BYTES,
        // but the NOTE quotes the path one level deeper than an entry does: `noteClause`
        // embeds `${JSON.stringify(entry.path)}` as TEXT inside the note string, and that
        // string is serialized AGAIN. Every `"` and every `\` in the name is therefore
        // escaped TWICE on the wire (`"` -> `\"` -> `\\\"`), while `noteReserve` priced it
        // with a SINGLE `JSON.stringify`. 200 quotes + 40 backslashes buy 484 bytes of
        // unpriced wire, the estimator only leaves ~362 bytes of slack, and a 261 000-byte
        // multi-line read measured 262,266 against the 262,144-byte budget — so
        // `boundToolResult` replaced the whole object with its envelope and `files`,
        // `nextByte`, `nextLine` and the note itself were gone.
        //
        // Both characters are legal in a POSIX file name (and illegal on Windows, which
        // is why the case is `runIf`-guarded above), so the fixture is a real file on a
        // real path rather than a mock; the ONLY thing this read differs in from
        // `big-multiline.txt` is how the name is spelled.
        const QUOTES = 200;
        const BACKSLASHES = 40;
        const name = `${'"'.repeat(QUOTES)}${'\\'.repeat(BACKSLASHES)}.txt`; // 244 bytes, inside NAME_MAX
        const path = await seed(name, `${'x'.repeat(57)}\n`.repeat(4_500));
        const full = await readFile(path, 'utf8');
        const result = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const entry = result.files[0];

        // The premise, in exact numbers: the same 261 000 bytes / 4 500 lines as the
        // ASCII fixture, cut by the budget rather than by a line cap.
        expect(Buffer.byteLength(name, 'utf8')).toBe(244);
        expect(Buffer.byteLength(full, 'utf8')).toBe(261_000);
        expect(entry.sizeBytes).toBe(261_000);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('budget');
        expect(entry.nextByte).toBe(entry.bytes);
        // The 484-byte penalty is paid out of CONTENT, not out of the cap: the reserve is
        // a few hundred bytes of a 262 144-byte budget, which is the bound a caller needs
        // in order to keep trusting it (the same shape the ASCII large-file case pins).
        expect(entry.bytes).toBeGreaterThan(253_000);

        // The amplification itself, asserted as arithmetic rather than assumed: the single
        // pass prices one escaped character as 2 bytes (`\"`), and the outer pass escapes
        // BOTH of those bytes again, so the wire carries 4 — 2 more per escaped character
        // than the old reserve knew about, plus 4 more for the pair of inner quotes the
        // outer pass has to escape as well.
        const singleEscaped = Buffer.byteLength(JSON.stringify(entry.path), 'utf8');
        const doubleEscaped = Buffer.byteLength(JSON.stringify(JSON.stringify(entry.path)), 'utf8');

        expect(doubleEscaped - singleEscaped).toBe(2 * (QUOTES + BACKSLASHES) + 4);
        expect(doubleEscaped - singleEscaped).toBe(484);

        // The note is present and EXACT, including the path as `JSON.stringify` renders
        // it — the string whose double escaping the reserve now prices.
        const column = entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 261000 bytes; returned ${entry.bytes} (limit: budget) - ` +
                `continue at startByte ${entry.nextByte}, or { startLine: ${entry.nextLine}${column} }.`
        );

        // The cap, held: `wireBytes` is the real serialized length of THIS response, and
        // it fits both the tool's own budget and the harness's.
        const serialized = JSON.stringify(result);

        expect(Buffer.byteLength(serialized, 'utf8')).toBe(result.wireBytes);
        expect(result.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
        expect(result.wireBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);

        // The penalty is charged against CONTENT, before the scan, and never against the
        // cap. Measured as a pair against the SAME bytes under an ASCII path: the escaped
        // spelling returns measurably FEWER content bytes and leaves measurably MORE slack
        // under the cap, i.e. the 484 bytes the note's inner string costs and the 240 the
        // entry's does are priced out of the window instead of overshooting the envelope.
        // (They no longer TIP the cap on their own - the projection reserve D11 added
        // enlarged the headroom - so this is the assertion that still proves the
        // accounting happens at all: an unpriced reserve would show up as `wireBytes`
        // above `contentBudget`, which the line below pins.)
        const ascii = await read([
            { path: join(workdir, 'big-multiline.txt'), maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }
        ]);
        const unpriced = doubleEscaped - singleEscaped;
        const slackPenalty = FILE_READ_WIRE_BUDGET - result.wireBytes - (FILE_READ_WIRE_BUDGET - ascii.wireBytes);

        expect(ascii.files[0].bytes - entry.bytes).toBeGreaterThan(0);
        expect(slackPenalty).toBeGreaterThanOrEqual(Math.floor(unpriced / 2));
        expect(slackPenalty).toBeLessThanOrEqual(unpriced);

        // End to end, through the module that actually does the cutting: an escape-heavy
        // path survives intact, with every continuation field still parseable.
        const bounded = boundToolResult(serialized);

        expect(bounded.truncated).toBe(false);
        expect(bounded.content).toBe(serialized);
        expect(bounded.originalBytes).toBe(result.wireBytes);

        const parsed = JSON.parse(bounded.content) as { files: { nextByte: number; nextLine: number }[] };

        expect(parsed.files[0].nextByte).toBe(entry.nextByte);
        expect(parsed.files[0].nextLine).toBe(entry.nextLine);

        // And the continuation the note names rebuilds the file exactly under that path,
        // so the reserve did not just buy room — it bought room for advice that works.
        const rest = await read([{ path, startByte: entry.nextByte as number }]);

        expect(rest.files[0].truncated).toBe(false);
        expect(entry.content + rest.files[0].content).toBe(full);
        // The tail is a complete read, so it needs no advisory of its own.
        expect(rest.note).toBeUndefined();
    });

    it('advises raise-maxLines when a large file stops at the caller line cap', async () => {
        // `limit` already names the reason per entry; the note repeats it as an action,
        // because the remedy for a `maxLines` cut is the OPPOSITE of the remedy for a
        // budget cut (see the D5 section of ./read.tool.ts).
        const result = await read([{ path: join(workdir, 'big-multiline.txt'), maxLines: 3 }]);
        const entry = result.files[0];

        // Three 58-byte lines: every number in the sentence is derivable from the file.
        expect(entry.bytes).toBe(174);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxLines');
        expect(entry.nextByte).toBe(174);
        expect(entry.nextLine).toBe(4);
        expect(entry.nextColumn).toBe(0);

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 261000 bytes; returned 174 ` +
                '(limit: maxLines at 3 - raise maxLines) - continue at startByte 174, or { startLine: 4 }.'
        );
    });

    it('stops advising raise-maxLines once the caller is at the maxLines ceiling', async () => {
        // F3 regression. The clause used to append "- raise maxLines" to EVERY
        // `limit: "maxLines"` note, including the one a caller already at
        // FILE_READ_MAX_LINES received - and that advice throws, because `readMaxLines`
        // rejects 20001 with "read maxLines must be an integer between 1 and 20000". At
        // the ceiling the continuation is the only usable remedy, so the clause names the
        // ceiling it hit instead of a raise that cannot happen.
        const path = await seed('ceiling.txt', LINES_20001);
        const result = await read([{ path, maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }]);
        const entry = result.files[0];

        // The window is exactly the cap, and every number is derivable from the fixture:
        // 20 001 lines are 208 905 bytes, the first 20 000 are 208 894 of them, and the
        // next unread byte is the start of line 20 001. The file is over the 65 536-byte
        // gate, so the note IS published - it just cannot promise an impossible raise.
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxLines');
        expect(entry.sizeBytes).toBe(208_905);
        expect(entry.bytes).toBe(208_894);
        expect(entry.nextByte).toBe(208_894);
        expect(entry.nextLine).toBe(20_001);
        expect(entry.nextColumn).toBe(0);

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 208905 bytes; returned 208894 ` +
                '(limit: maxLines at the 20000 ceiling) - continue at startByte 208894, or { startLine: 20001 }.'
        );

        // One line below the ceiling the free remedy really is available, and the note
        // says so - which is what keeps the ceiling wording an exception rather than a
        // blanket rewrite of the clause.
        const below = await read([
            { path, maxLines: FILE_READ_MAX_LINES - 1, maxBytes: FILE_READ_MAX_BYTES }
        ]);

        expect(below.files[0].limit).toBe('maxLines');
        expect(below.files[0].bytes).toBe(208_883);
        expect(below.note).toBe(
            `read: ${JSON.stringify(below.files[0].path)} is 208905 bytes; returned 208883 ` +
                '(limit: maxLines at 19999 - raise maxLines) - continue at startByte 208883, or { startLine: 20000 }.'
        );

        // The advice the ceiling case removed was not just unhelpful, it was rejected -
        // pinned here so the note can never send a caller into that error again.
        await expect(read([{ path, maxLines: FILE_READ_MAX_LINES + 1 }])).rejects.toThrow(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for the ${FILE_READ_DEFAULT_MAX_LINES}-line default; received ${FILE_READ_MAX_LINES + 1}.`
        );
    });

    it('names at most two large files and counts the rest', async () => {
        // A 100-path batch cannot spend the budget the allocator just freed on the
        // advisory, so the tail is a count (FILE_READ_NOTE_MAX_PATHS).
        const paths = [0, 1, 2].map((index) => join(workdir, 'many', `${index}.txt`));
        // All three ask for the ceiling, so what cuts each one is its share of the
        // SHARED envelope - the only case that produces `limit: "budget"`, which is what
        // this test is about. Left at the default each file would stop at its own 64 KiB
        // allowance and report `maxBytes`, a different governor.
        const result = await read(
            paths.map((path) => ({ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }))
        );

        expect(result.files.every((entry) => entry.truncated)).toBe(true);

        const [first, second, third] = result.files;
        const column = (entry: typeof first): string =>
            entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;
        const clause = (entry: typeof first): string =>
            `${JSON.stringify(entry.path)} is 200000 bytes; returned ${entry.bytes} (limit: budget) - ` +
                `continue at startByte ${entry.nextByte}, or { startLine: ${entry.nextLine}${column(entry)} }`;

        expect(result.note).toBe(
            `read: ${clause(first)}; ${clause(second)}; and 1 more large file(s) report truncated/nextByte.`
        );

        // The third file is counted, not spelled out - and it is still fully described
        // by its own entry fields, which is what makes counting it honest.
        expect(result.note).not.toContain(JSON.stringify(third.path));
        expect(third.nextByte).not.toBeNull();
    });

    it('says nothing for a small read, a complete read, or a truncated small one', async () => {
        // Three negatives, because "when is there no note" is the half a caller has to
        // be able to rely on:
        //   1. a small file returned whole;
        const small = await read([join(workdir, 'a.txt')]);

        expect(small.truncated).toBe(false);
        expect(small.note).toBeUndefined();
        // Absent, not `undefined`, so a JSON round trip cannot invent the key and
        // `'note' in result` stays meaningful.
        expect('note' in small).toBe(false);

        //   2. a 150 KB file on ONE line - bigger than the gate, but nothing was
        //      withheld (asked for the whole envelope, and no newline to escape, so it
        //      fits), which is why this case deliberately gets no sentence: an advisory
        //      that says "continue" where there is nothing to continue teaches a model to
        //      doubt a complete answer. `sizeBytes` already reports the size;
        const singleLine = await read([
            { path: join(workdir, 'big-singleline.txt'), maxBytes: FILE_READ_MAX_BYTES }
        ]);

        expect(singleLine.files[0].sizeBytes).toBe(150_000);
        expect(singleLine.files[0].bytes).toBe(150_000);
        expect(singleLine.files[0].truncated).toBe(false);
        expect(singleLine.note).toBeUndefined();
        expect('note' in singleLine).toBe(false);

        //   3. a file BELOW the size gate that really is cut (line cap) - the per-entry
        //      fields carry it, and a note here would be boilerplate on the common read.
        const smallCut = await read([{ path: join(workdir, 'lines.txt'), maxLines: 3 }]);

        expect(smallCut.files[0].truncated).toBe(true);
        expect(smallCut.files[0].limit).toBe('maxLines');
        expect(smallCut.files[0].sizeBytes).toBe(Buffer.byteLength(LINES_1300, 'utf8'));
        expect(smallCut.note).toBeUndefined();
        expect('note' in smallCut).toBe(false);
    });

    // -----------------------------------------------------------------------
    // THE MODEL PROJECTION. The machine view (`files[]`) and the model's copy are the
    // SAME facts in two renderings, delivered through one branded envelope
    // (../../core/tool-text.ts) and peeled in exactly one place. What these tests pin:
    // the prose says what the JSON says, `content` stays byte-exact regardless of how
    // the prose is rendered, and the prose is never the part the harness envelope has to
    // cut - which is the whole reason it exists.
    // -----------------------------------------------------------------------

    it('hands the model prose instead of escaped JSON, and reports its size', async () => {
        const small = join(workdir, 'a.txt');
        const big = join(workdir, 'big-multiline.txt');
        const both = await readBoth([small, { path: big, maxBytes: FILE_READ_DEFAULT_MAX_BYTES }]);
        const text = both.text;

        // One header per entry, in request order, then the raw window. The path is
        // literal, not a JSON string: the prose never carries `\"` or `\\` that the
        // caller did not put in the file.
        expect(text.startsWith(`${small}  lines 1-1 of 1  size 6 bytes  (reached end of file)  returned 6 bytes\nalpha\n`)).toBe(true);
        expect(text).toContain(`${big}  size ${261_000} bytes`);
        expect(text).toContain('[truncated by maxBytes;');
        // The machine view is still the machine view: nothing about the projection leaks
        // into `content`, and the summary fields are untouched.
        expect(both.result.files[0].content).toBe('alpha\n');
        // `modelBytes` is the real byte length of THAT text, measured the way the
        // harness will measure it going into the transcript - not an estimate.
        expect(both.result.modelBytes).toBe(Buffer.byteLength(text, 'utf8'));
    });

    it('numbers the model\'s copy without touching the bytes the machine reads', async () => {
        // The gutter exists so a model can cite a line without arithmetic. `content`
        // stays raw: a caller diffing a window against the file must not have to strip a
        // prefix it never asked for.
        const plain = await readBoth([{ path: join(workdir, 'lines.txt'), startLine: 998, maxLines: 4 }]);
        const numbered = await readBoth([
            { path: join(workdir, 'lines.txt'), startLine: 998, maxLines: 4, numbered: true }
        ]);

        expect(plain.result.files[0].content).toBe('line 998\nline 999\nline 1000\nline 1001\n');
        expect(numbered.result.files[0].content).toBe(plain.result.files[0].content);

        // The gutter width follows the LARGEST line number in the window, so 998-1001
        // aligns instead of breaking at the 3-to-4-digit boundary.
        expect(numbered.text).toContain('\n 998: line 998\n 999: line 999\n1000: line 1000\n1001: line 1001\n');
        expect(plain.text).not.toContain(': line 998');

        // Numbering costs bytes, and says so where the caller can see it: the gutter is
        // charged inside the scanner, so it cannot silently push the window past the
        // allowance the same allowance bought unnumbered.
        expect(numbered.result.modelBytes).toBeGreaterThan(plain.result.modelBytes);
        expect(numbered.result.files[0].bytes).toBeLessThanOrEqual(plain.result.files[0].bytes);
    });

    it('substitutes for invalid UTF-8 only when asked, and still refuses NUL', async () => {
        // The flag exists for a Latin-1 log: the bytes ARE text, the tool knows it, and
        // the default answer (EBINARY for the whole window) shows none of it.
        const latin = await seed('latin.txt', Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' n\n')]));

        expect((await read([latin])).files[0].error?.code).toBe('EBINARY');

        const soft = await read([{ path: latin, lossy: true }]);

        expect(soft.files[0].content).toBe('caf\ufffd n\n');
        // The substitution is STATED, not implied: a caller reading the window cannot
        // otherwise tell a replaced byte from a file that really contained U+FFFD.
        expect(soft.files[0].lossy).toBe(true);
        expect(soft.files[0].bytes).toBe(9);

        // Asking for `lossy` on a file that needs no substitution does not fabricate the
        // flag - `lossy: true` means "this text was changed", not "you asked me to allow it".
        expect((await read([{ path: join(workdir, 'a.txt'), lossy: true }])).files[0].lossy).toBeUndefined();

        // NUL bytes stay binary under `lossy` (pinned deliberately): the flag's promise is
        // about DECODING, and a NUL is valid UTF-8. A UTF-16 or JSON-with-NUL blob is
        // binary whoever looks at it, and decoding it into a window of U+FFFD-and-nothing
        // would be the silent change the strict default exists to prevent.
        const nul = await seed('nul-lossy.bin', Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from('b\n')]));

        expect((await read([{ path: nul, lossy: true }])).files[0].error?.code).toBe('EBINARY');
    });

    it('keeps the model\'s copy inside the envelope whichever governor cut the window', async () => {
        // The property that makes the projection SAFE to deliver through the harness
        // envelope: the prose is never larger than the JSON it replaces, so a response
        // that fits the wire cap fits with its prose intact. Measured across all three
        // cut reasons and both adversarial paths, because the reserve is priced per file
        // BEFORE the scan and an under-priced line would show up here as a cut.
        const cases = [
            [join(workdir, 'big-multiline.txt')],
            [{ path: join(workdir, 'big-multiline.txt'), maxLines: 3 }],
            [{ path: join(workdir, 'big-multiline.txt'), maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }],
            [{ path: join(workdir, 'many', '0.txt'), maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }],
            [join(workdir, 'binary-nul.bin')],
            [join(workdir, 'missing.txt'), join(workdir, 'nested')],
            Array.from({ length: 40 }, (_, index) => join(workdir, 'tiny', `${index}.txt`))
        ];

        for (const request of cases) {
            const both = await readBoth(request as never);
            const label = JSON.stringify(request).slice(0, 80);

            expect(both.result.modelBytes, label).toBe(Buffer.byteLength(both.text, 'utf8'));
            expect(both.result.modelBytes, `${label} fits where the JSON fits`).toBeLessThanOrEqual(both.result.wireBytes);
            expect(both.result.wireBytes, `${label} within budget`).toBeLessThanOrEqual(both.result.contentBudget);

            // End to end: the harness cuts a SERIALIZED result, so feeding it the prose
            // alone cannot truncate - and feeding it the full machine result cannot
            // either, which is the case the review actually hit.
            expect(boundToolResult(both.text).truncated, `${label} prose survives`).toBe(false);
            expect(boundToolResult(JSON.stringify(both.result)).truncated, `${label} result survives`).toBe(false);
        }
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
            'read paths must be strings or { path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered } objects.'
        );
        // A model that sends a bare string instead of an array is told the shape.
        await expect(read('a.txt' as never)).rejects.toThrow(
            'read expects an array of paths (strings or { path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered } objects), e.g. ["package.json"].'
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
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for the ${FILE_READ_DEFAULT_MAX_LINES}-line default; received 0.`
        );
        await expect(read([{ path: join(workdir, 'a.txt'), maxLines: FILE_READ_MAX_LINES + 1 }])).rejects.toThrow(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for the ${FILE_READ_DEFAULT_MAX_LINES}-line default; received ${FILE_READ_MAX_LINES + 1}.`
        );
        // The exported default round-trips: a caller that reads
        // FILE_READ_DEFAULT_MAX_LINES and passes it back gets the behaviour that constant
        // names, not a validation error. It is the one value OUTSIDE [1, ceiling] that is
        // accepted, and the message says "or omitted" instead of advertising it.
        await expect(read([{ path: join(workdir, 'a.txt'), maxLines: FILE_READ_DEFAULT_MAX_LINES }])).resolves.toMatchObject({
            files: [{ content: 'alpha\n' }]
        });
        // `maxBytes` (D11) is bounded, not clamped: a silent clamp of 10 000 000 down to
        // the envelope would report `limit: "budget"` for a request the caller believed
        // was unlimited, and `limit` is the field that decides whether to ask again.
        await expect(read([{ path: join(workdir, 'a.txt'), maxBytes: 0 }])).rejects.toThrow(
            `read maxBytes must be an integer between 1 and ${FILE_READ_MAX_BYTES}, or omitted for the ${FILE_READ_DEFAULT_MAX_BYTES}-byte default; received 0.`
        );
        await expect(read([{ path: join(workdir, 'a.txt'), maxBytes: FILE_READ_MAX_BYTES + 1 }])).rejects.toThrow(
            `read maxBytes must be an integer between 1 and ${FILE_READ_MAX_BYTES}, or omitted for the ${FILE_READ_DEFAULT_MAX_BYTES}-byte default; received ${FILE_READ_MAX_BYTES + 1}.`
        );
        // ... and the exported byte default round-trips exactly like the line one.
        await expect(read([{ path: join(workdir, 'a.txt'), maxBytes: FILE_READ_DEFAULT_MAX_BYTES }])).resolves.toMatchObject({
            files: [{ content: 'alpha\n' }]
        });
        // A flag is a boolean. Answering `lossy: "yes"` as `true` would substitute U+FFFD
        // into text the caller believed was exact - the silent change the flag exists to
        // opt INTO - so a non-boolean is refused rather than coerced.
        await expect(read([{ path: join(workdir, 'a.txt'), lossy: 'yes' } as never])).rejects.toThrow(
            'read lossy must be a boolean or omitted; received yes.'
        );
        await expect(read([{ path: join(workdir, 'a.txt'), numbered: 1 } as never])).rejects.toThrow(
            'read numbered must be a boolean or omitted; received 1.'
        );
        // `null` means "not set", which is what a JSON producer that cannot omit a field
        // sends, and it cannot mean substitution.
        await expect(read([{ path: join(workdir, 'a.txt'), lossy: null, numbered: null }])).resolves.toMatchObject({
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
                    sizeBytes: 6,
                    lineCount: 1
                }
            ],
            truncated: false,
            bytes: 6,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            modelBytes: expect.any(Number),
            skipped: 0
        });
    });

    it('declares a single "paths" array property whose items are strings or ranges', () => {
        // The harness's single-property rule: the schema must expose EXACTLY one
        // property, an array, or a direct `execute` call cannot be handed the array
        // itself. Every range knob therefore lives on the ITEM, never as a second
        // top-level property - which is what this pins, structurally, rather than by
        // pasting the whole description text (that prose is size-guarded below).
        const schema = readTool.parameters as {
            type: string;
            required: string[];
            additionalProperties: boolean;
            properties: Record<string, Record<string, never>>;
        };

        expect(Object.keys(schema.properties)).toEqual(['paths']);
        expect(schema.required).toEqual(['paths']);
        expect(schema.additionalProperties).toBe(false);

        const paths = schema.properties.paths;

        expect(paths.type).toBe('array');
        expect(paths.maxItems).toBe(FILE_READ_MAX_TARGETS);
        expect(toolParameterKey(readTool.parameters)).toBe('paths');

        const item = paths.items as { oneOf: Record<string, never>[] };

        expect(item.oneOf[0]).toEqual({ type: 'string' });

        const object = item.oneOf[1];

        expect(object.type).toBe('object');
        expect(object.required).toEqual(['path']);
        // A typo'd knob must be REFUSED, not ignored: silently dropping `maxLine` would
        // hand the caller a default window it did not ask for.
        expect(object.additionalProperties).toBe(false);
        expect(Object.keys(object.properties as Record<string, unknown>).sort()).toEqual([
            'lossy',
            'maxBytes',
            'maxLines',
            'numbered',
            'path',
            'startByte',
            'startColumn',
            'startLine'
        ]);

        const bounds = (name: string) =>
            expect(object.properties[name] as Record<string, unknown>).toMatchObject(
                (
                    {
                        startLine: { type: 'integer', minimum: 1 },
                        startColumn: { type: 'integer', minimum: 0 },
                        startByte: { type: 'integer', minimum: 0 },
                        maxLines: { type: 'integer', minimum: 1, maximum: FILE_READ_MAX_LINES },
                        maxBytes: { type: 'integer', minimum: 1, maximum: FILE_READ_MAX_BYTES },
                        lossy: { type: 'boolean' },
                        numbered: { type: 'boolean' },
                        path: { type: 'string' }
                    } as Record<string, Record<string, unknown>>
                )[name]
            );

        for (const name of Object.keys(object.properties) as (keyof typeof object.properties)[]) bounds(name);

        // Every knob the VALIDATOR accepts must be declared, or a model cannot discover
        // it - and every declared one must be validated, or the schema is a claim the
        // implementation does not keep.
        expect(new Set(Object.keys(object.properties))).toEqual(
            new Set(['path', 'startLine', 'startColumn', 'startByte', 'maxLines', 'maxBytes', 'lossy', 'numbered'])
        );
    });

    it('publishes the documented default and hard caps', () => {
        // D11's two-number contract per axis: a DEFAULT that is a context budget, and a
        // CEILING that is still 10x above it. The default must be SMALL enough that a
        // read which asks nothing cannot fill a model's window, and the ceiling large
        // enough that "omit the argument" is never the same sentence as "want less".
        expect(FILE_READ_DEFAULT_MAX_LINES).toBe(2_000);
        expect(FILE_READ_MAX_LINES).toBe(20_000);
        expect(FILE_READ_DEFAULT_MAX_BYTES).toBe(64 * 1024);
        expect(FILE_READ_MAX_BYTES).toBe(FILE_READ_WIRE_BUDGET);
        // The default must be the thing that bites first on a plain call: if the ceiling
        // were the binding number, the default would be a label and not a policy.
        expect(FILE_READ_DEFAULT_MAX_LINES).toBeLessThan(FILE_READ_MAX_LINES);
        expect(FILE_READ_DEFAULT_MAX_BYTES).toBeLessThan(FILE_READ_MAX_BYTES);
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

    it('keeps the declaration inside its context budget', () => {
        // THE DECLARATION TAX. `visibility: 'core'` means this description and this
        // schema are sent on EVERY request, so their bytes are paid by every conversation
        // the harness runs, not only by the calls that use `read`. Measured before D11:
        // 3,285 bytes of description and 2,939 of parameter schema. The guard exists
        // because a description only ever grows - the reasoning that belongs in a
        // sentence here is worth 400 bytes on every request, and the reasoning that
        // belongs in a paragraph belongs in the source header or the projection.
        const descriptionBytes = Buffer.byteLength(FILE_READ_METADATA.description, 'utf8');
        const schemaBytes = Buffer.byteLength(JSON.stringify(readTool.parameters), 'utf8');

        expect(descriptionBytes).toBeLessThanOrEqual(1_700);
        expect(schemaBytes).toBeLessThanOrEqual(2_600);
        // The two things a model cannot guess and MUST be told, because both decide the
        // next call: what the caps are, and what each `limit` value means.
        expect(FILE_READ_METADATA.description).toContain(String(FILE_READ_DEFAULT_MAX_LINES));
        expect(FILE_READ_METADATA.description).toContain(String(FILE_READ_DEFAULT_MAX_BYTES));
        for (const reason of ['maxLines', 'maxBytes', 'budget']) {
            expect(FILE_READ_METADATA.description).toContain(reason);
        }
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        // The path a HARNESS takes, not the convenience callable: `execute` receives the
        // single property's value and returns the branded envelope, which the harness
        // peels into a machine payload and a model-facing string in one place
        // (../../core/tool-media.ts + harness.ts). Both halves are asserted here, because
        // the registration is what makes the projection reach the transcript.
        const envelope = await readTool.execute!({
            parameters: [{ path: join(workdir, 'lines.txt'), startLine: 2, maxLines: 1 }]
        });
        const unwrapped = unwrapToolResult<FileReadResult>(envelope);
        const result = unwrapped.content;

        // The prose the model would see: header, window, and the continuation the entry
        // reports - no JSON escaping, and no `\n` two-character sequences.
        expect(unwrapped.text).toBe(
            `${join(workdir, 'lines.txt')}  lines 2-2 of ?  size ${Buffer.byteLength(LINES_1300, 'utf8')} bytes  ` +
                'returned 7 bytes\n' +
                'line 2\n' +
                '  [truncated by maxLines; 7 bytes returned; continue from startByte 14]\n'
        );
        expect(unwrapped.text).toContain('line 2\n');
        // 2 000 is the DEFAULT, and this window is 1 line because the caller asked for 1.
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
