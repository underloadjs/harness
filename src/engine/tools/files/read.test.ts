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
//     truncation (`truncated`), and continuation (`nextLine`/`nextColumn`/`nextByte`) —
//     and a TRUNCATED window's cursor names a position strictly past where the window
//     started, whatever the allowance was (C2), with `nextColumn` counted from the
//     PHYSICAL start of the line it names (H4), so the documented continuation makes
//     progress instead of re-reading the same empty window;
//   - the DEFAULT window is a CONTEXT budget, not a memory budget (D11): 2000 lines and
//     64 KiB per file, both raisable per request up to the 20 000 / 262 144 ceilings,
//     and `limit` names which of the three governors (maxLines / maxBytes / budget)
//     actually cut the window — the difference between "raise it" and "want less";
//   - a window that counted the whole file publishes `lineCount`, and a seek past the
//     end is an ERANGE entry naming the file's size or line count, never an empty window
//     that reads as "this file is empty" — on the BYTE axis for any offset at or past EOF,
//     on the LINE axis for a line past `lineCount + 1`. The two axes are not the same rule
//     (M11): `startLine: lineCount + 1` is a legal request for the boundary one past the
//     last line, and a 0-byte file has no lines to be past, so ANY `startLine` there
//     answers the empty window with `lineCount: 0` and no error;
//   - the model receives a PROSE rendering of these same facts (`toolText`), never the
//     escaped JSON. The two views are BUDGETED, not ordered (F4): `wireBytes` is what the
//     machine view costs and it must stay inside `contentBudget`, while `modelBytes` is the
//     prose — usually the LARGER number, because gutters, escapes and continuation notes are
//     the model's cost — and it is what the scanner charges for up front, which is what
//     keeps the harness envelope from ever cutting it;
//   - the aggregate budget is measured on the SERIALIZED result, so a full-budget
//     read always survives the harness's own wire cap intact — the fields needed to
//     continue are never destroyed;
//   - allocation is by DEMAND: a small file hands its unused share back instead of
//     stranding a large one at 1/N of the budget;
//   - UTF-8 bytes (not UTF-16 code units) are counted, and CRLF/empty files keep
//     their exact text — with the two UNITS kept apart (M2): `maxBytes` and the batch
//     budget are charged in escaped wire bytes, while `bytes` reports raw ones, so a
//     newline-heavy window stops at `limit: "maxBytes"` well under the number it named;
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
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundToolResult, toolParameterKey, unwrapToolResult } from '../../core';
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from '../../core/result-budget';
import {
    read as readTool,
    readFileBatch,
    DEFAULT_FILE_READ_LIMITS,
    FILE_READ_ERROR_CODES,
    FILE_READ_IO_DEADLINE_MS,
    FILE_READ_METADATA,
    FILE_READ_CONTENT_BUDGET,
    FILE_READ_DEFAULT_MAX_BYTES,
    FILE_READ_MAX_BYTES,
    FILE_READ_DEFAULT_MAX_LINES,
    FILE_READ_MAX_LINES,
    FILE_READ_MAX_TARGETS,
    FILE_READ_NOTE_MAX_PATHS,
    FILE_READ_NOTE_MIN_BYTES,
    FILE_READ_ERROR_ENTRY_BUDGET_BYTES,
    FILE_READ_WIRE_BUDGET
} from './read.tool';
import type { FileReadEntry, FileReadLimits, FileReadResult } from './read.tool';

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

// The unit `maxBytes`, the batch pool, and `wireBytes` are all charged in: raw UTF-8 bytes
// PLUS one extra byte for every character `JSON.stringify` must escape (M2 - "a newline or
// a quote costs 2 here"). Every fixture the full-envelope assertions below use is ASCII
// lines, where the only escaped character is `\n`, so the charge is exactly
// `raw + newlines` and the arithmetic of "the envelope was filled" can be checked instead
// of asserted. (`content.match` counts, rather than `split`, so a trailing empty segment is
// never counted as a newline that is not there.)
const chargedBytes = (content: string): number => Buffer.byteLength(content, 'utf8') + (content.match(/\n/g) ?? []).length;

// Follows a cut window's own cursor to EOF and returns the concatenation of every page.
//
// WHY IT EXISTS. Under the old 256 KiB envelope, "the continuation the note names is
// correct" could be proved by ONE follow-up call, because the remainder of a 261 KiB file
// still fitted one page. Under a 32 KiB envelope it takes six, so every test that proves a
// cursor is byte-exact now has to page — which is what a real caller does anyway, and what
// makes the assertion stronger: it checks EVERY boundary, not just the first one.
//
// The two inline assertions are the paging contract itself, not scaffolding: a page that
// errors, or that returns nothing while still claiming to be truncated, is an infinite loop
// for the caller that trusts the cursor.
const pageToEof = async (
    path: string,
    first: FileReadEntry
): Promise<{ text: string; last: FileReadEntry; pages: number }> => {
    let collected = first.content;
    let entry = first;
    let pages = 0;

    for (; entry.truncated && entry.nextByte !== null && pages < 32; pages += 1) {
        const page = await read([
            { path, startByte: entry.nextByte as number, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }
        ]);

        entry = page.files[0];
        expect(entry.error, `page at byte ${entry.startLine}`).toBeUndefined();
        expect(entry.bytes, 'the cursor makes progress').toBeGreaterThan(0);
        collected += entry.content;
    }

    expect(entry.truncated, 'paging reached EOF').toBe(false);

    return { text: collected, last: entry, pages };
};

// THE TEST SEAM H2 needs (deadline + cancellation). `read`'s `execute` passes the
// published limits and the harness's own signal; `readFileBatch` takes them as
// arguments — the same shape `./grep.tool.ts:626-639` publishes — so a test can ask for
// `ioDeadlineMs: 0` and pin the timeout path synchronously instead of racing the 10 s
// production ceiling, and can hand over an AbortSignal exactly as a harness run does.
const readWith = async (
    paths: Parameters<typeof readTool>[0],
    limits?: Partial<FileReadLimits>,
    signal?: AbortSignal
): Promise<FileReadResult> =>
    unwrapToolResult<FileReadResult>(
        await readFileBatch(paths, { ...DEFAULT_FILE_READ_LIMITS, ...limits }, signal)
    ).content;

// POSIX-only fixture makers for the target CLASSES H2 is about, because Node exposes no
// FIFO API at all (`fs.mkfifo` does not exist in any supported runtime — measured), so a
// FIFO comes from the platform binary. `null` / `false` means "this box cannot build the
// target", which the test turns into an early return; anything else that goes wrong
// throws, so a broken fixture fails loudly rather than skipping the assertion away.
const exec = (command: string, args: string[]): Promise<void> =>
    new Promise((resolveRun, rejectRun) =>
        execFile(command, args, (error) => (error === null ? resolveRun() : rejectRun(error)))
    );

const makeFifo = async (relativePath: string): Promise<string | null> => {
    if (process.platform === 'win32') return null;

    const target = join(workdir, relativePath);

    try {
        await exec('mkfifo', [target]);
    } catch (error) {
        // No `mkfifo` binary on this box: the case cannot exist here.
        if ((error as { code?: string }).code === 'ENOENT') return null;

        throw error;
    }

    // A FIFO that is not actually a FIFO would make the assertions below meaningless.
    if (!(await lstat(target)).isFIFO()) throw new Error(`mkfifo did not create a FIFO at ${target}`);

    return target;
};

// The `/proc` guard: the pseudo-file IS the fixture for the H3/EXTRA-4 tests, and it only
// exists on Linux. Everything else in this file is platform-independent.
const exists = async (target: string): Promise<boolean> => {
    try {
        await lstat(target);

        return true;
    } catch {
        return false;
    }
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

// `wireBytes` and `modelBytes` both carry the fixture's ABSOLUTE path once — the
// serialized entry for the first, the projection's header line for the second — so a
// whole-number literal is a number for one checkout path only. CI checks this package
// out as `underloadjs/harness` from its own repo root, a shorter path than the
// monorepo checkout the literals were written on. Where an exact figure is the point,
// the tests below pin the path-INDEPENDENT cost and add the path back, and everything
// else is asserted exactly, which keeps the strict whole-object comparison the contract
// needs.
//
// `budgetPool` is masked for the same reason, and it is not the only place the number is
// checked: it is the batch's splittable bytes (M7), which is `contentBudget` minus the
// per-entry scaffolding — every one of which embeds a path. The exact figure is pinned by
// arithmetic in the budget tests below (`budgetGranted === floor(budgetPool / paths)`), so
// masking it here costs no precision, only the path.
const withWire = (result: FileReadResult) => ({
    ...result,
    wireBytes: expect.any(Number),
    modelBytes: expect.any(Number),
    budgetPool: anyPool
});

// M7: the batch's SPLITTABLE bytes, masked everywhere it is not the subject of the test.
// `budgetPool = contentBudget - (per-entry JSON scaffolding + the projection's fixed line +
// the floor headroom)`, and every one of those reserves embeds the fixture's absolute path,
// so no checkout can write it as a literal. Where the pool IS the subject, the tests below
// pin it as the arithmetic it is defined by (`budgetGranted === floor(budgetPool / files)`),
// which is exact and path-free.
const anyPool = expect.any(Number);

// Raw bytes, the unit `modelBytes` measures the prose in.
const pathBytes = (path: string): number => Buffer.byteLength(path, 'utf8');

// The serialized path is the JSON form: on Windows each separator doubles, and a
// non-ASCII segment is escaped. `- 2` removes only the surrounding quotes.
const serializedPathBytes = (path: string): number => Buffer.byteLength(JSON.stringify(path), 'utf8') - 2;

// The wire cost of one NUMBER field in the result object, `"name":N,` separators included
// — because `wireBytes` measures the serialized object, not its fields. M7 added
// `budgetPool`, whose digit count follows the pool, which follows the fixture path: adding
// this term keeps a `wireBytes` pin exact on every checkout instead of freezing the number
// for one of them.
const fieldWire = (name: string, value: number): number => Buffer.byteLength(`"${name}":${value},`, 'utf8');

// M7 in one term: the result's own `budgetPool`, priced wherever a `wireBytes` literal was
// written before the field existed.
const poolWire = (result: FileReadResult): number => fieldWire('budgetPool', result.budgetPool);

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
// `line N\n` is 6 bytes plus the digits of N, so 5100 lines are
// 63 + 720 + 8100 + 4101*10 = 49_893 bytes (measured, not asserted from the comment —
// the old 56_100 figure assumed 11 bytes for every line and no longer matches the
// fixture). The number only ever appears in `toBeLessThan` bounds, but a stale constant
// makes the window math below unreadable.
const LINES_5100_BYTES = 49_893;

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
                    lineCount: 1,
                    // A two-path batch splits the 32 KiB envelope into a ~16 KiB share per
                    // path, which is BELOW the 16384 default the caller was told, so M7's
                    // `budgetGranted` is published on every entry of every multi-path read.
                    // Its exact value is a function of the absolute temp paths this test
                    // runs under, so it is shape-checked here;
                    // `read > publishes what the batch actually granted, and only when the
                    // batch was the limit (M7)` pins the arithmetic itself.
                    budgetGranted: expect.any(Number)
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
                    lineCount: 1,
                    budgetGranted: expect.any(Number)
                }
            ],
            truncated: false,
            bytes: 11,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            budgetPool: anyPool,
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
                        lineCount: 1,
                        // See the note on the first test: a multi-path read always runs
                        // under the 16384 default, so every entry says what it was granted.
                        budgetGranted: expect.any(Number)
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
                        lineCount: 1,
                        budgetGranted: expect.any(Number)
                    }
                ],
                truncated: false,
                bytes: 11,
                wireBytes: expect.any(Number),
                contentBudget: FILE_READ_WIRE_BUDGET,
                budgetPool: anyPool,
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
                    lineCount: 2,
                    // See the note on the first test.
                    budgetGranted: expect.any(Number)
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
                    lineCount: 0,
                    // An empty file still had an allowance; publishing it here is what
                    // lets a caller tell "this file is empty" from "this file was starved"
                    // (M7), which is exactly the ambiguity `budgetGranted` exists for.
                    budgetGranted: expect.any(Number)
                }
            ],
            truncated: false,
            bytes: 10,
            wireBytes: expect.any(Number),
            contentBudget: FILE_READ_WIRE_BUDGET,
            budgetPool: anyPool,
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
            budgetPool: anyPool,
            modelBytes: expect.any(Number),
            skipped: 0
        });
    });

    it('cuts the default window at the byte allowance and says so, and an explicit maxLines walks past it', async () => {
        // D11 replaced the "no default line cap" contract. This file — 5,100 lines, 49 893
        // bytes, a fifth of the OLD byte envelope — is exactly the shape that made the old
        // default dangerous: it FIT the budget, so a default read handed the caller all
        // 5,100 lines (≈15k tokens) and the caller only learned afterwards that the tool
        // had volunteered them. Under the context-derived defaults it is also the shape
        // that shows WHICH governor fired: 2000 lines of this file cost 18 893 bytes, more
        // than the 16 384-byte default, so `limit` names `maxBytes` rather than `maxLines`,
        // and that is the diagnosis that tells the caller what to raise.
        const result = await read([join(workdir, 'many-lines.txt')]);
        const entry = result.files[0];

        expect(entry.startLine).toBe(1);
        // T3 re-derived the defaults from the context window (`maxBytes` is 8192 MODEL
        // TOKENS = 16384 serialized bytes), and that is BELOW what this file's 2000-line
        // default window costs (18,893 bytes of `line N` text), so on this fixture the
        // BYTE allowance is the governor and the 2000-line cap never fires. The numbers
        // are exact for this fixture and path-independent: the window is bounded by the
        // 16384 default, not by the batch pool, so 1590 whole lines plus the first byte of
        // line 1591 is the largest prefix that fits. `read > applies an explicit maxLines
        // and names it as the reason` pins the line-governed side of the same contract.
        expect(entry.endLine).toBe(1591);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxBytes');
        expect(entry.bytes).toBe(14_794);
        // A byte-axis cut may stop INSIDE a line, which is exactly why the continuation is
        // a (line, column, byte) triple rather than a line number: line 1591 is the line it
        // stopped in, column 1 the byte of it it stopped at, and `nextByte` the absolute
        // offset paging resumes from.
        expect(entry.nextLine).toBe(1591);
        expect(entry.nextColumn).toBe(1);
        expect(entry.nextByte).toBe(entry.bytes);
        // A cut window never claims to know the file's total.
        expect(entry.lineCount).toBeUndefined();
        expect(entry.bytes).toBeLessThanOrEqual(FILE_READ_DEFAULT_MAX_BYTES);
        expect(entry.bytes).toBeLessThan(LINES_5100_BYTES);
        // The whole point: a default call is a bounded window, not the envelope. The
        // ENVELOPE is the ceiling the wire has to respect; the window is what the default
        // bought, and the entry's own scaffolding (13 fields, the path, the prose line) sits
        // on top of it, which is why `wireBytes` sits a little over 16 384 while `bytes`
        // does not.
        expect(result.wireBytes).toBeLessThan(result.contentBudget);

        // The other half of the contract: the caps are DEFAULTS, not ceilings, and asking
        // explicitly still buys everything the envelope can hold. It cannot buy the whole
        // 49 893-byte file any more — a 32 KiB result is 4% of the smallest context window
        // the harness sizes itself against, and that is the number the envelope exists to
        // protect. What the ask DOES buy is every byte of the pool: `entry.bytes` and
        // `budgetPool` are the same number, so the caller can see the envelope was filled
        // rather than the file being cut short by a policy it never asked for.
        const asked = await read([
            { path: join(workdir, 'many-lines.txt'), maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }
        ]);
        const whole = asked.files[0];

        expect(whole.content).toBe(LINES_5100.slice(0, whole.bytes));
        expect(whole.truncated).toBe(true);
        // The envelope, not the line cap and not the per-file ask, is what stopped it —
        // which is precisely the answer that tells the caller to ask for LESS next time
        // instead of raising a cap that was never the governor.
        expect(whole.limit).toBe('budget');
        // A cut window never claims to know the file's total.
        expect(whole.lineCount).toBeUndefined();
        // The pool is charged in SERIALIZED bytes - one extra per `\n` (M2) - so a window
        // that spent the whole envelope is the pool minus its newlines, give or take the
        // one line that did not fit (11 raw + 1 escaped on this fixture).
        expect(chargedBytes(whole.content)).toBeLessThanOrEqual(asked.budgetPool);
        expect(asked.budgetPool - chargedBytes(whole.content)).toBeLessThan(12);
        expect(whole.bytes).toBeGreaterThan(FILE_READ_DEFAULT_MAX_BYTES);
        expect(whole.bytes).toBeLessThan(LINES_5100_BYTES);
        expect(asked.wireBytes).toBeLessThanOrEqual(asked.contentBudget);
    });

    it('applies an explicit maxLines and names it as the reason', async () => {
        // An EXPLICIT cap still cuts, and `limit` says so — that is the whole point of
        // the field: a caller reading `truncated: true` must know whether raising
        // `maxLines` would help (it would, here) or not (it never does for "budget").
        //
        // 500 lines, not the 5000 this test used before the envelope moved: 5000 lines of
        // this file are 48 893 bytes, which no 32 KiB envelope can hand back, so that
        // request would be cut by the budget and prove nothing about the line cap. 500
        // lines are 4 392 bytes — inside the envelope, outside the cap — which is the only
        // shape where `limit: "maxLines"` is the honest answer.
        const first500 = linesUpTo(500);
        const bytes = Buffer.byteLength(first500, 'utf8');

        expect(bytes).toBe(4_392);

        const result = await read([{ path: join(workdir, 'many-lines.txt'), maxLines: 500 }]);
        const entry = result.files[0];

        expect(entry.content).toBe(first500);
        expect(entry.startLine).toBe(1);
        expect(entry.endLine).toBe(500);
        expect(entry.bytes).toBe(bytes);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('maxLines');
        expect(entry.nextLine).toBe(501);
        expect(entry.nextColumn).toBe(0);
        // nextByte is the absolute offset of line 501, i.e. exactly the bytes read.
        expect(entry.nextByte).toBe(bytes);
        // A window the LINE cap stopped still had the whole envelope available, so the
        // batch pool was never the governor and M7 says nothing about a grant.
        expect(entry.budgetGranted).toBeUndefined();
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
            budgetPool: anyPool,
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

    it('draws the line-axis boundary where the BYTES are, terminated against unterminated (F3)', async () => {
        // M11 as corrected by the reviewer's F3. The old prose claimed `startLine` was
        // "always clamped to the first line", which is false twice over (a `startLine`
        // inside the file is honoured, and a missing one is ERANGE), and the boundary it
        // left implicit was inconsistent: `startLine: lineCount + 1` succeeded on a
        // file-final newline and failed on a file with no final newline. The rule the
        // implementation actually enforces, and the one the description now states, is
        // about BYTES: the boundary is the last byte of the file. A final newline makes an
        // extra empty line addressable, because its start is a real offset; a final line
        // without a terminator has no such offset, so one line past it is the first
        // out-of-range line.
        const terminated = await seed('axis-terminated.txt', 'a\nb\nc\n'); // 6 bytes, 3 lines
        const unterminated = await seed('axis-unterminated.txt', 'a\nb\nc'); // 5 bytes, 3 lines

        // The line after the last terminated line is LEGAL: line 4 starts at byte 6, which
        // is the file size, and the ERANGE contract refuses only a byte PAST that.
        const legal = await read([{ path: terminated, startLine: 4 }]);

        expect(legal.files[0].error).toBeUndefined();
        expect(legal.files[0]).toMatchObject({
            content: '',
            startLine: 4,
            endLine: 3, // an empty window names a line that does not exist
            truncated: false,
            limit: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 0,
            sizeBytes: 6,
            // The count the walk counted on the way to the boundary, published rather than
            // hidden: the walk that proved line 4 is the empty position at EOF also proved
            // there are exactly 3 lines. `startLine: lineCount + 1` is the documented
            // legal-at-EOF request (knowledge.md "the empty window at EOF"), so the answer
            // is an empty window WITH this count and no error — and `startLine: 5`, one past
            // it, is the ERANGE above that names the same 3.
            lineCount: 3
        });

        // One line further and the file is exhausted: the empty window is a legitimate
        // "no lines left here", while a missing line is an error naming the total.
        expect((await read([{ path: terminated, startLine: 5 }])).files[0].error?.code).toBe('ERANGE');

        // The same line number on the unterminated file is the FIRST missing line, because
        // line 3 is terminated by EOF rather than by a newline and line 4 has no start
        // offset at all.
        const illegal = await read([{ path: unterminated, startLine: 4 }]);

        expect(illegal.files[0].error?.code).toBe('ERANGE');
        expect(illegal.files[0].error?.message).toContain('the file has 3 lines');

        // The last real line is readable on both, and the unterminated one keeps its text
        // with no newline added — the same answer `startByte` gives at that offset.
        expect((await read([{ path: terminated, startLine: 3 }])).files[0].content).toBe('c\n');
        expect((await read([{ path: unterminated, startLine: 3 }])).files[0].content).toBe('c');
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

    it('fills the envelope for a 70 KB single line when asked, and the default window when not', async () => {
        // What changed (D11) is that reaching the envelope is an explicit ask. `giant.txt`
        // — one 70 000-byte line — sits just past the default, so it demonstrates both
        // halves with one fixture. It no longer demonstrates "the whole file on request":
        // a 32 KiB result is 4% of the smallest context the harness sizes itself against,
        // so 70 000 bytes cannot come back in one page however the caps are set. What the
        // ask DOES buy is the whole pool, and the entry can prove it: `bytes` and
        // `budgetPool` are the same number when one path is the only claimant.
        const result = await read([{ path: join(workdir, 'giant.txt'), maxBytes: FILE_READ_MAX_BYTES }]);

        expect(result.files[0].bytes).toBe(result.budgetPool);
        expect(result.files[0].bytes).toBeGreaterThan(FILE_READ_DEFAULT_MAX_BYTES);
        expect(result.files[0].truncated).toBe(true);
        // The envelope stopped it, not the 64 KiB ask - which is the answer that tells the
        // caller to page rather than to raise a cap that was never the governor.
        expect(result.files[0].limit).toBe('budget');
        expect(result.files[0].nextByte).toBe(result.files[0].bytes);
        // One line, cut inside it: the count is not knowable, so it is not published.
        expect(result.files[0].lineCount).toBeUndefined();
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);

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
        // The ask was 262 144 bytes and the envelope is 32 768, so the pool is what comes
        // back — that is the whole point of `limit: "budget"`, and the pool being fully
        // spent is what makes the number checkable without knowing this test's path.
        expect(entry.bytes).toBe(result.budgetPool);
        expect(entry.bytes).toBeGreaterThan(FILE_READ_DEFAULT_MAX_BYTES);
        expect(entry.bytes).toBeLessThanOrEqual(FILE_READ_MAX_BYTES);
        expect(entry.bytes).toBeLessThanOrEqual(result.contentBudget);
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

    it('allocates by demand: one big file beside 99 tiny ones takes the pool, and the folded rest is declared', async () => {
        // The regression this pins: the old split was budget/N, so this file was cut
        // to roughly 1/100th of the budget while 99 six-byte neighbours stranded the
        // rest. It still takes the pool, because their surplus is handed to it — what
        // changed with the 32 KiB envelope is that 100 paths no longer FIT in it at all,
        // so the batch now answers the prefix it can pay for and names the rest instead
        // of answering all 100 with a share of nothing.
        const paths = [
            { path: join(workdir, 'one-big.txt'), maxBytes: FILE_READ_MAX_BYTES },
            ...Array.from({ length: 99 }, () => ({ path: join(workdir, 'a.txt') }))
        ];

        const result = await read(paths);

        // Every enumerated entry answers its path: no errors, and each tiny neighbour
        // complete at its 6 bytes.
        expect(result.skipped).toBe(0);
        expect(result.files.slice(1).every((entry) => entry.bytes === 6 && entry.truncated === false)).toBe(true);
        // The big file's share is the point: more content than all its neighbours put
        // together, which an even split of this batch could never produce, and the
        // envelope is what stopped it — raising `maxBytes` would not help.
        const neighbours = result.files.slice(1).reduce((total, entry) => total + entry.bytes, 0);

        expect(result.files[0].bytes).toBeGreaterThan(neighbours);
        expect(result.files[0].truncated).toBe(true);
        expect(result.files[0].limit).toBe('budget');
        // The fold: `files` plus the declared omission is exactly the request, and the
        // omission is more than nothing (100 paths of ~500 bytes of reserve each cannot
        // fit a 32 768-byte envelope) but leaves a useful batch behind.
        expect(result.files.length + (result.omitted ?? 0)).toBe(100);
        expect(result.omitted).toBeGreaterThan(0);
        expect(result.files.length).toBeGreaterThan(30);
        // The envelope holds WITH the fold declaration in it.
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);
        // And the model's copy says what happened, ahead of the windows it does return.
        expect(await projection(paths)).toContain(`read: folded - ${result.omitted} of 100`);
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

    it('holds the envelope for a batch WIDER than the envelope, and declares what it folded', async () => {
        // THE BATCH-WIDTH INVARIANT (the half of the context explosion the per-path caps
        // cannot answer). Eight paths of 1.9 KiB of error message each was 15 KiB of the
        // old 64 KiB result; forty paths of the same message is 76 KiB, and no per-path
        // cap can fix that, because the cost is per ENTRY and the entries are the request.
        // The envelope stays at 32 768 bytes (4% of the context the harness sizes against),
        // so what is bounded instead is how many paths one call may enumerate.
        //
        // Three shapes, all wider than the envelope in reserve alone:
        const shortMissing = Array.from(
            { length: 40 },
            (_, index) => join(workdir, 'fold', `missing-${String(index).padStart(2, '0')}.txt`)
        );
        const wideMissing = Array.from(
            { length: 100 },
            (_, index) => join(workdir, 'fold', `gone-${String(index).padStart(3, '0')}.txt`)
        );
        const tiny = await Promise.all(
            Array.from({ length: 100 }, (_, index) => seed(`fold/tiny-${String(index).padStart(3, '0')}.txt`, `t${index}\n`))
        );

        // Which ceiling the fold line is allowed to blame, per shape (F2). The walk prices
        // slots in request order and stops at the first one it cannot afford, so a batch of
        // failures halts at the 8 192-byte error allowance with most of the envelope still
        // unspent, while a batch of readable files halts on the envelope itself. The fold
        // line has to name the one that fired — and only that one.
        const foldReasons = {
            envelope: `because this ${FILE_READ_WIRE_BUDGET}-byte envelope cannot answer them all`,
            errors: `because the ${FILE_READ_ERROR_ENTRY_BUDGET_BYTES}-byte failed-path allowance is full`
        };

        const cases: { label: string; gate: keyof typeof foldReasons; paths: { path: string }[] }[] = [
            // 1. forty unreadable paths with SHORT names (the short "no such file" message:
            //    the parent directory exists, so there is no did-you-mean or preview clause);
            { label: '40 ENOENT, short paths', gate: 'errors', paths: shortMissing.map((path) => ({ path })) },
            // 2. a hundred of them;
            { label: '100 ENOENT, short paths', gate: 'errors', paths: wideMissing.map((path) => ({ path })) },
            // 3. and a hundred READABLE three-byte files, which is the shape that used to
            //    return 100 entries with a content pool of 0.
            { label: '100 readable tiny files', gate: 'envelope', paths: tiny.map((path) => ({ path })) }
        ];

        for (const { label, gate, paths } of cases) {
            const result = await read(paths);
            const text = await projection(paths);

            // The envelope, in the unit the harness compares against its cap. `wireBytes`
            // is first pinned as the REAL serialized length, so the bound below cannot be
            // satisfied by an under-reported number.
            const serialized = JSON.stringify(result);

            expect(Buffer.byteLength(serialized, 'utf8'), `${label}: wireBytes is honest`).toBe(result.wireBytes);
            expect(result.wireBytes, `${label}: machine view fits`).toBeLessThanOrEqual(result.contentBudget);
            expect(result.wireBytes, `${label}: machine view fits the harness cap`).toBeLessThanOrEqual(
                MODEL_TOOL_RESULT_BUDGET_BYTES
            );
            // The prose the transcript actually commits, in the payload unit
            // `boundToolResult` measures - the OTHER view of the same call, and the one an
            // under-reserved fold would cut.
            expect(result.modelBytes, `${label}: prose fits`).toBeLessThanOrEqual(result.contentBudget);
            expect(boundToolResult(text).truncated, `${label}: the harness does not cut the prose`).toBe(false);
            expect(boundToolResult(text).content, `${label}: prose is delivered intact`).toBe(text);
            // Nothing is silently dropped: `files` plus the declared omission is exactly the
            // request, in the request's own order.
            expect(result.files.length + (result.omitted ?? 0), `${label}: the request is accounted for`).toBe(
                paths.length
            );
            // And every path the batch DID answer is an answer: an error object, or content.
            // A zero-content success entry - the old "1 byte of a 100-path batch" shape - is
            // the thing the fold replaces, so none may appear.
            expect(
                result.files.every((entry) => entry.error !== undefined || entry.bytes >= 1),
                `${label}: every enumerated path carries something`
            ).toBe(true);
            // If it folded, the fold is the FIRST thing the model reads, and it names the
            // same count the machine view declares.
            if ((result.omitted ?? 0) > 0) {
                const declared = text.split('\n')[0];

                expect(declared, `${label}: the fold is declared first`).toContain(
                    `read: folded - ${result.omitted} of ${paths.length} requested paths were not read`
                );
                // F2: and the reason clause names the ceiling that ACTUALLY stopped the
                // walk. Blaming the envelope for a fold the error allowance caused is the
                // wrong remedy — splitting the batch or raising `maxBytes` cannot help when
                // the reserve that ran out is the one for failed paths.
                expect(declared, `${label}: the fold names the gate that fired`).toContain(foldReasons[gate]);
                expect(
                    declared,
                    `${label}: the fold does not blame the ceiling that did not fire`
                ).not.toContain(gate === 'envelope' ? foldReasons.errors : foldReasons.envelope);
            } else {
                expect(text).not.toContain('read: folded');
            }
        }

        // THE OMISSION IS THE TAIL, EXACTLY. The fold line claims the omitted paths are the
        // LAST `omitted` of the request; that is only an honest claim if re-asking the prefix
        // reproduces it byte for byte. The 100-tiny-file batch is the case with readable
        // content on both sides of the cut.
        const wide = await read(tiny.map((path) => ({ path })));
        const prefix = await read(tiny.slice(0, wide.files.length).map((path) => ({ path })));

        expect(prefix.omitted, 'a request the envelope can afford in full declares nothing').toBeUndefined();
        expect(prefix.files.length).toBe(wide.files.length);
        expect(prefix.files).toEqual(wide.files);
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
            budgetPool: anyPool,
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

        // 2. A file that FITS both caps and the envelope: 1 000 lines of ~7 bytes is under
        //    the 2 000-line default, under the 20 000-line ceiling and inside the 32 KiB
        //    envelope, so nothing was cut, `limit` stays null, and the whole-file count is
        //    published because the scan ran to EOF. (The 19 000-line file above cannot show
        //    this any more: 133 000 bytes is four envelopes, so it is truncated by the
        //    budget however the caps are set — case 4's shape.)
        const fitsFile = await seed('limit-fits.txt', Array.from({ length: 1_000 }, (_, i) => `l${i}`).join('\n'));
        const fits = await read([{ path: fitsFile, maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }]);
        expect(fits.files[0].truncated).toBe(false);
        expect(fits.files[0].limit).toBeNull();
        expect(fits.files[0].lineCount).toBe(1_000);

        // 3. The DEFAULT of the 19 000-line file: 2 000 lines of ~7 bytes is 14 000 bytes,
        //    inside the 16 384-byte default allowance, so the LINE governor is what stopped
        //    it — and "raise maxLines" is the right advice here.
        expect((await read([{ path: manyLines }])).files[0].limit).toBe('maxLines');

        // 4. The SHARED envelope: 15 000 lines of 21 bytes is 315 000 bytes, more than
        //    32 768 and fewer than 20 000 lines, so with both caps at their ceilings the
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
        // `maxBytes` at the ceiling, deliberately: this test is about the SHARED 32 KiB
        // envelope and the note reserve priced against it, which is what the F1/F2
        // regressions were about. Under the 16 384-byte DEFAULT the file is cut by its own
        // allowance (`limit: "maxBytes"`) and never reaches the envelope, so the default-cut
        // case is pinned separately and this one keeps asking for the whole.
        const result = await read([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const entry = result.files[0];

        // The premise, in exact bytes: 4500 lines of 58 is 261 000 raw, and 265 500
        // SERIALIZED (a `\n` costs two), so the 32 768-byte envelope must cut it — by a
        // factor of eight, which is the regime this test now lives in.
        expect(Buffer.byteLength(full, 'utf8')).toBe(261_000);
        expect(entry.sizeBytes).toBe(261_000);
        expect(entry.truncated).toBe(true);
        expect(entry.limit).toBe('budget');
        // The window starts at byte 0, so the first unread byte IS the number of bytes
        // returned - the value the note quotes as the resume offset.
        expect(entry.nextByte).toBe(entry.bytes);
        expect(entry.bytes).toBeLessThan(261_000);
        // The window is nearly the whole envelope, so the note costs a few hundred bytes of
        // a 32 768-byte budget and never a sizeable share of it (the bound a caller needs to
        // trust the reserve). Stated in the charge unit rather than as a raw byte count,
        // because the pool - and therefore the window - is what this test's path length
        // moves: a full envelope of 58-byte terminated lines is the pool minus one byte per
        // newline, within the slack of the line that did not fit.
        expect(chargedBytes(entry.content)).toBeLessThanOrEqual(result.budgetPool);
        expect(result.budgetPool - chargedBytes(entry.content)).toBeLessThan(60);

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
        // continuation rebuilds the file exactly, with nothing duplicated or dropped —
        // followed page by page, because a 261 KiB file is six pages of this envelope.
        expect((await pageToEof(path, entry)).text).toBe(full);
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

        // End to end, with the module that actually does the cutting - and in the unit that
        // module measures. `boundToolResult` bounds the TEXT the harness commits to the
        // transcript, and for this tool that is the prose projection, priced in REQUEST-BODY
        // payload bytes (`modelPayloadBytes` in ../../core/result-budget.ts) - the same unit
        // `modelBytes` reports. Feeding it the machine view instead measures a scenario the
        // harness never builds for a `toolText` result: re-serializing a JSON string escapes
        // every one of the JSON's own quote characters again, so a result that exactly fills
        // the envelope pays ~250 more bytes for quotes than its `wireBytes` counted. Both
        // figures are pinned, and so is the fact that the continuation survives in the copy
        // the model reads - which is the failure this test exists for.
        const text = await projection([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const bounded = boundToolResult(text);

        expect(bounded.truncated).toBe(false);
        expect(bounded.content).toBe(text);
        expect(result.modelBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(bounded.content).toContain(`continue from startByte ${entry.nextByte}`);
        // The machine view, for the consumer that gets it (the server's manual-execute
        // response and any caller threading `nextByte`), is inside its own budget too.
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);

        // And the continuation the note names is correct under the non-ASCII path too,
        // so the advice is not just affordable - it resumes the file exactly. Paged to EOF,
        // because the 230 000-byte remainder is more than one page of a 32 KiB envelope.
        expect((await pageToEof(path, entry)).text).toBe(full);
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
        // a few hundred bytes of a 32 768-byte budget (~1.5%), which is the bound a caller
        // needs in order to keep trusting it (the same shape the ASCII large-file case
        // pins). Stated in the charge unit, because the window is what moves with this
        // test's path length - not the ~484 bytes of double-escaped path.
        expect(chargedBytes(entry.content)).toBeLessThanOrEqual(result.budgetPool);
        expect(result.budgetPool - chargedBytes(entry.content)).toBeLessThan(60);

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

        // End to end, through the module that actually does the cutting, in the unit it
        // measures (the prose projection, as the transcript receives it - see the CJK case
        // above for why the machine view is the wrong input here): an escape-heavy path
        // survives intact, and the continuation it advertises is still in the copy the model
        // reads, where the reserve was supposed to put it.
        const text = await projection([{ path, maxBytes: FILE_READ_MAX_BYTES, maxLines: FILE_READ_MAX_LINES }]);
        const bounded = boundToolResult(text);

        expect(bounded.truncated).toBe(false);
        expect(bounded.content).toBe(text);
        expect(result.modelBytes).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(result.wireBytes).toBeLessThanOrEqual(result.contentBudget);
        expect(bounded.content).toContain(`continue from startByte ${entry.nextByte}`);
        expect(bounded.content).toContain(`startLine ${entry.nextLine}`);

        // And the continuation the note names rebuilds the file exactly under that path,
        // so the reserve did not just buy room — it bought room for advice that works.
        // Paged to EOF: 261 000 bytes is six pages of a 32 768-byte envelope.
        const paged = await pageToEof(path, entry);

        expect(paged.text).toBe(full);
        // EOF has no continuation to name, which is what tells a caller the paging is over.
        expect(paged.last.nextByte).toBeNull();
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
        // the ceiling the continuation is the only usable remedy, so the note must name the
        // ceiling it hit rather than a raise that cannot happen.
        //
        // The envelope moved, and with it the reachability of that branch: 20 000 lines
        // cost at least 2 bytes of SERIALIZED allowance each (one byte of text plus an
        // escaped `\n`), so the line ceiling needs 40 000 charged bytes and the envelope
        // hands out ~31 200 of them. The byte budget is therefore ALWAYS the governor at
        // the ceiling - which serves the same guarantee by a shorter route: a note that
        // says `limit: budget` cannot advise raising `maxLines` at all. Both halves are
        // pinned: the label, and the absence of the impossible advice.
        const path = await seed('ceiling.txt', LINES_20001);
        const result = await read([{ path, maxLines: FILE_READ_MAX_LINES, maxBytes: FILE_READ_MAX_BYTES }]);
        const entry = result.files[0];

        // 20 001 lines are 208 905 bytes, over the 65 536-byte gate, so the note IS
        // published - and it is cut by the envelope long before the line ceiling it cannot
        // reach. The byte figures are stated as a relation to the pool, which is what this
        // test's own path length moves.
        expect(entry.truncated).toBe(true);
        expect(entry.sizeBytes).toBe(208_905);
        expect(entry.limit).toBe('budget');
        expect(chargedBytes(entry.content)).toBeLessThanOrEqual(result.budgetPool);
        expect(result.budgetPool - chargedBytes(entry.content)).toBeLessThan(12);
        expect(entry.nextByte).toBe(entry.bytes);
        // Well under 20 000 lines came back, so the line ceiling never fired.
        expect(entry.endLine).toBeLessThan(FILE_READ_MAX_LINES);

        const column = entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;

        expect(result.note).toBe(
            `read: ${JSON.stringify(entry.path)} is 208905 bytes; returned ${entry.bytes} (limit: budget) - ` +
                `continue at startByte ${entry.nextByte}, or { startLine: ${entry.nextLine}${column} }.`
        );
        // The advice a caller at the ceiling must NOT get, asserted directly rather than
        // left to the shape of the sentence above.
        expect(result.note).not.toContain('maxLines');

        // One line BELOW the ceiling changes nothing, and that is the point: the line cap
        // is now out of reach for this fixture either way - 19 999 lines of 10-11 bytes cost
        // ~220 000 charged bytes against a 31 200-byte pool - so the byte envelope governs
        // both reads and neither note can offer a `maxLines` raise, at the ceiling or below
        // it. The free remedy is still pinned where it is real:
        // `read > advises raise-maxLines when a large file stops at the caller line cap`,
        // which cuts the same class of file at `maxLines: 3` and gets the
        // `(limit: maxLines at 3 - raise maxLines)` clause verbatim.
        const below = await read([
            { path, maxLines: FILE_READ_MAX_LINES - 1, maxBytes: FILE_READ_MAX_BYTES }
        ]);

        expect(below.files[0].limit).toBe('budget');
        expect(chargedBytes(below.files[0].content)).toBeLessThanOrEqual(below.budgetPool);
        expect(below.note).toBe(
            `read: ${JSON.stringify(below.files[0].path)} is 208905 bytes; returned ${below.files[0].bytes} ` +
                `(limit: budget) - continue at startByte ${below.files[0].nextByte}, or { startLine: ${below.files[0].nextLine}${
                    below.files[0].nextColumn === 0 ? '' : `, startColumn: ${below.files[0].nextColumn}`
                } }.`
        );
        expect(below.note).not.toContain('maxLines');

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

        //   2. a file that IS cut but sits BELOW the size gate - the advisory's own
        //      threshold, not the envelope's. A 40 000-byte single line cannot fit a 32 KiB
        //      envelope, so it is a real byte-envelope cut (`limit: "budget"`), and the
        //      per-entry fields carry it without a sentence. Under the OLD 256 KiB envelope
        //      this slot held the opposite shape - a 150 KB file returned COMPLETE, the one
        //      read that must not be narrated - and that case is now unreachable: the 64 KiB
        //      gate is above the envelope, so no file the note may name can ever be
        //      complete. The "complete reads say nothing" half is case 1.
        const belowGate = await seed('below-gate-singleline.txt', 'q'.repeat(40_000));
        const singleLine = await read([{ path: belowGate, maxBytes: FILE_READ_MAX_BYTES }]);

        expect(singleLine.files[0].sizeBytes).toBe(40_000);
        expect(singleLine.files[0].bytes).toBeLessThan(40_000);
        expect(singleLine.files[0].truncated).toBe(true);
        expect(singleLine.files[0].limit).toBe('budget');
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
    // THE CONTINUATION CURSOR, THE UNITS OF THE ALLOWANCE, AND THE OFF-THE-END CASES.
    // Every test in this block exists because a caller could not act on the answer it
    // got: a truncated window whose cursor named the offset it had already read (C2), a
    // column counted from the wrong end of the line (H4), a window reported under a line
    // number it did not start on (H5), an out-of-range line indistinguishable from an
    // empty file (M11), `maxBytes` silently meaning escaped bytes while `bytes` meant raw
    // (M2), and `EIO` for a file that was never read (zero allowance).
    // -----------------------------------------------------------------------

    it('emits one code point even when the allowance cannot hold it', async () => {
        // C2, as corrected by the reviewer's F1. The byte cut used to fire BEFORE the
        // character was emitted, so an allowance smaller than the one code point at the
        // window start produced `content: ""` with `nextByte` equal to the offset the
        // window started at. The cursor was then repaired by STEPPING to the next code
        // point — which silently deleted every character whose escape cost exceeded the
        // allowance. The rule in force is the one-code-point floor: while a window has
        // emitted nothing, every byte check (allowance, chunk end, per-line budget, gutter
        // charge) is bypassed, so a window with content always carries at least one code
        // point, nothing is ever skipped, and `nextByte` is literally the first unread
        // byte. The overshoot is bounded: one code point escapes to at most 6 bytes, and
        // while the floor is armed the gutter is charged as part of the same emission.
        const emoji = await seed('emoji.txt', '😀abc\n');
        const unaffordable = await read([{ path: emoji, maxBytes: 3 }]);

        expect(unaffordable.files[0]).toEqual({
            path: join(workdir, 'emoji.txt'),
            content: '😀',
            startLine: 1,
            endLine: 1,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            // 4: the emoji was emitted anyway, and the cursor names the byte AFTER all
            // four of its bytes — 'a'. It used to stall at 0, then to skip to 4 with the
            // emoji gone; the emoji is now on the page AND the cursor moves.
            nextLine: 1,
            nextColumn: 4,
            nextByte: 4,
            // The overshoot the floor promises: the escaped emoji costs 4 bytes against a
            // `maxBytes` of 3, and no line was rendered, so the gutter adds nothing.
            bytes: 4,
            sizeBytes: 8
        });

        // The proof that this is a cursor and not a decoration: the same 3-byte allowance
        // from the reported offset reads the three bytes that follow the emoji.
        expect((await read([{ path: emoji, startByte: 4, maxBytes: 3 }])).files[0].content).toBe('abc');

        // A tab is ONE raw byte but costs two escaped ones, so `maxBytes: 1` cannot hold
        // it either — the same floor, reached through the accounting the allowance
        // actually uses rather than through the raw-byte check.
        const tab = await seed('tab.txt', '\tfoo\n');

        expect((await read([{ path: tab, maxBytes: 1 }])).files[0]).toEqual({
            path: join(workdir, 'tab.txt'),
            content: '\t',
            startLine: 1,
            endLine: 1,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            nextLine: 1,
            nextColumn: 1,
            nextByte: 1,
            // 1: `bytes` reports the RAW span (a tab occupies one byte on disk), while the
            // allowance was emptied by the ESCAPED charge of 2. The asymmetry is the M2
            // contract, not this fix; what this case pins is that the tab is on the page.
            bytes: 1,
            sizeBytes: 5
        });

        // A `numbered` window pays a `1: ` gutter per line out of the same allowance, so
        // an allowance that cannot hold the gutter alone is this case with a different
        // reason. The floor covers the gutter too — the charge is what a rendered line costs,
        // gutter included — so the smallest numbered window is a whole line of text, and the
        // cursor still moves. `content` carries the source bytes only; the gutter exists
        // solely in the model's copy.
        const gutter = await seed('gutter.txt', 'abc\n');

        expect((await read([{ path: gutter, maxBytes: 1, numbered: true }])).files[0]).toEqual({
            path: join(workdir, 'gutter.txt'),
            content: 'a',
            startLine: 1,
            endLine: 1,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            nextLine: 1,
            nextColumn: 1,
            nextByte: 1,
            // 1 raw byte, while the charge that emptied the allowance was the 3-byte gutter
            // plus that byte: the floor's overshoot is a rendered line, never a silent drop.
            bytes: 1,
            sizeBytes: 4
        });

        // When the unaffordable code point IS a line terminator, the floor emits THAT
        // newline and the cursor lands on the NEXT line at column 0: `nextLine`/`nextColumn`
        // describe where the cursor stands, which is the only pair a `{ startLine,
        // startColumn }` continuation can feed back without re-reading the newline. A
        // CRLF file read this way used to lose every `\r\n` pair in the file.
        const newlines = await seed('cursor-newlines.txt', 'a\nbb\nccc\n');

        expect((await read([{ path: newlines, startByte: 1, maxBytes: 1 }])).files[0]).toEqual({
            path: join(workdir, 'cursor-newlines.txt'),
            content: '\n',
            startLine: 1,
            // 1: a newline belongs to the line it TERMINATES, and `nextLine` is the line
            // that starts at `nextByte` — the pair a `{ startLine, startColumn }` request
            // feeds back without re-reading the terminator.
            endLine: 1,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            nextLine: 2,
            nextColumn: 0,
            nextByte: 2,
            // 1, not 2: `bytes` reports the RAW span (the newline occupies one byte on
            // disk) while the allowance was emptied by its ESCAPED cost of 2 — the M2 split
            // of units, the same one the `maxBytes` schema spells out. What this case pins
            // is that the newline itself is on the page instead of being stepped over.
            bytes: 1,
            sizeBytes: 9
        });

        // The limit that the header documents: a NUL at the window start is EBINARY, not
        // stepped over — the caller pointed at the byte that says "this is not text".
        const nulled = await seedBytes('cursor-nul.txt', Buffer.from([0x61, 0x00, 0x62]));

        expect((await read([{ path: nulled, startByte: 1, maxBytes: 1 }])).files[0].error?.code).toBe('EBINARY');
    });

    it('walks a tiny allowance to a CLEAN end rather than into an ERANGE wall (F5)', async () => {
        // The reviewer's F5-4, which the header's promise ("the two EOF answers are
        // equivalent — an end-of-file continuation ends the walk cleanly") did not hold.
        // The cursor repair used to STEP the last code point of a file without emitting it,
        // so the walk reached EOF with that character unread and the next request carried
        // `startByte === sizeBytes` — the one value ERANGE rejects. A line-axis walk ended
        // `truncated: false`; a byte-axis walk of the same file ended in an error. The
        // one-code-point floor removed the asymmetry, and this pins the walk end to end.
        const text = 'a\nbb\nccc\n';
        const file = await seed('tiny-walk.txt', text);
        const pages: FileReadEntry[] = [];

        for (let guard = 0; guard < 32; guard += 1) {
            const entry = (await read([{ path: file, startByte: pages.length === 0 ? 0 : (pages[pages.length - 1].nextByte as number), maxBytes: 1 }])).files[0];

            pages.push(entry);
            if (!entry.truncated) break; // the clean end; ERANGE would have set entry.error
        }

        // The walk ended on its own terms: no ERANGE anywhere, and the last page says
        // "finished" the way the line-axis answer does — untruncated, cursor null.
        expect(pages.some((entry) => entry.error !== undefined)).toBe(false);
        expect(pages[pages.length - 1].truncated).toBe(false);
        expect(pages[pages.length - 1].nextByte).toBeNull();
        // The equivalence itself: one page per code point, and their concatenation IS the
        // file. Nothing was stepped over (the old repair) and nothing was read twice.
        expect(pages.map((entry) => entry.content)).toEqual(['a', '\n', 'b', 'b', '\n', 'c', 'c', 'c', '\n']);
        expect(pages.map((entry) => entry.content).join('')).toBe(text);

        // An unterminated final line ends the same way: the last page carries the partial
        // line and reports EOF, so a caller does not need a second request to find out.
        const ragged = await seed('tiny-walk-ragged.txt', 'a\nb');
        const raggedPages: FileReadEntry[] = [];

        for (let guard = 0; guard < 8; guard += 1) {
            const entry = (await read([{ path: ragged, startByte: raggedPages.length === 0 ? 0 : (raggedPages[raggedPages.length - 1].nextByte as number), maxBytes: 1 }])).files[0];

            raggedPages.push(entry);
            if (!entry.truncated) break;
        }

        expect(raggedPages.map((entry) => entry.content)).toEqual(['a', '\n', 'b']);
        expect(raggedPages[raggedPages.length - 1]).toMatchObject({ truncated: false, nextByte: null, endLine: 2 });
    });

    it('gives every file of a one-byte batch a code point, inside the wire cap (C1)', async () => {
        // F1 with the batch allocation. The floor is what makes these pages carry anything;
        // the RESERVE is what keeps the floor from breaking the envelope. The batch used to
        // hand every file an allowance of 1 with no headroom, so the escaped overshoot the
        // floor needs came out of nothing and a `maxBytes: 1` batch of 100 files used to
        // return 100 empty entries (the reviewer's probe measured 492 wire bytes for 100
        // files, all of it metadata, with 100 empty contents). Now the per-file floor
        // headroom is taken off the top BEFORE the pool is split, so the sum of what the
        // floor may emit is budgeted, not hoped for.
        const files = await Promise.all(
            Array.from({ length: 100 }, (_, index) => seed(`tiny-batch/f${index}.txt`, `${index} line\n`))
        );
        const batch = await read(files.map((path) => ({ path, maxBytes: 1 })));

        // The batch cannot answer all 100 paths inside 32 768 bytes: each entry costs ~460
        // bytes of scaffolding in the two views BEFORE it carries anything, so 100 of them
        // is ~46 KiB of reserve alone. It answers the prefix it can pay for, and `omitted`
        // accounts for the rest. The old behaviour this test replaced was 100 entries and a
        // pool of 0 - a response that spent everything on metadata and called it a read.
        expect(batch.files.every((entry) => entry.error === undefined)).toBe(true);
        expect(batch.files.length).toBeLessThan(100);
        expect(batch.files.length + (batch.omitted ?? 0)).toBe(100);
        expect(batch.omitted).toBeGreaterThan(0);
        // One code point each, in caller order — the first character of each file, and the
        // prefix is exactly the first `files.length` paths.
        expect(batch.files.map((entry) => entry.content)).toEqual(
            files.slice(0, batch.files.length).map((_, index) => String(index)[0])
        );
        expect(batch.files.map((entry) => entry.bytes)).toEqual(batch.files.map(() => 1));
        // The envelope holds with the floors included: `bytes` is exactly the code points
        // the floor emitted, and the rest of the wire is the fixed metadata.
        expect(batch.bytes).toBe(batch.files.length);
        expect(batch.wireBytes).toBeLessThanOrEqual(FILE_READ_WIRE_BUDGET);
        expect(batch.wireBytes).toBeGreaterThan(batch.bytes);
        // And every cursor moved, so paging from any of them is progress, not a loop.
        expect(batch.files.every((entry) => entry.truncated && entry.nextByte === 1)).toBe(true);
        // The omission is declared in the copy the model reads, not only in a field the
        // model never sees: this is the whole point of folding rather than starving.
        const text = await projection(files.map((path) => ({ path, maxBytes: 1 })));

        expect(text.split('\n')[0]).toContain(`read: folded - ${batch.omitted} of 100 requested paths were not read`);
        // F2: THIS fold really is the envelope's — 100 readable paths, no failed entry in
        // the batch, so the error allowance never fired and the reason clause says so.
        expect(text.split('\n')[0]).toContain(
            `because this ${FILE_READ_WIRE_BUDGET}-byte envelope cannot answer them all`
        );
    });

    it('refuses a NUL only on the page that contains it', async () => {
        // Decision 10, and the two-scope contract the header states. BINARY rejection is
        // not a whole-file verdict: the NUL check is WINDOW-scoped (it fires on the
        // character the window is about to emit) while the invalid-UTF-8 check is
        // CHUNK-scoped (the strict decoder is handed the whole read chunk). A caller that
        // cannot predict which of its windows gets the verdict cannot page a 100 KB log at
        // all, which is what the old whole-chunk `includes('\u0000')` made it.
        const body = Buffer.alloc(102_400, 0x61);
        body.writeUInt8(0x00, 100_000); // one stray NUL, 100 001 bytes into the file
        const nulled = await seedBytes('windowed-nul.txt', body);

        // The default window stops 84 KiB short of the NUL, so it is TEXT. (Under the old
        // 64 KiB default it stopped 36 KiB short; the number moved with the context-derived
        // default, and the contract did not.)
        const before = (await read([{ path: nulled }])).files[0];

        expect(before.error).toBeUndefined();
        expect([before.bytes, before.truncated, before.nextByte]).toEqual([
            FILE_READ_DEFAULT_MAX_BYTES,
            true,
            FILE_READ_DEFAULT_MAX_BYTES
        ]);

        // The page that walks over it is EBINARY, and so is the same page asked for the
        // whole ceiling. "The read that covers the file" is no longer a thing one call can
        // ask for - 100 001 bytes is three envelopes - so the ceiling ask is pinned on the
        // page that DOES contain the NUL, which is the case that matters.
        expect((await read([{ path: nulled, startByte: 99_000, maxBytes: 2_048 }])).files[0].error?.code).toBe('EBINARY');
        expect((await read([{ path: nulled, startByte: 99_000, maxBytes: 262_144 }])).files[0].error?.code).toBe('EBINARY');

        // The chunk half, in both directions: `0xFF` at byte 50 000 is INSIDE the chunk a
        // window at byte 0 decodes, so that window is refused even though its 10 bytes are
        // clean; the same read from byte 60 000 has the bad byte BEHIND the seek and reads
        // fine.
        const mixed = Buffer.alloc(70_000, 0x61);
        mixed.writeUInt8(0xff, 50_000);
        const bad = await seedBytes('chunked-bad.txt', mixed);

        expect((await read([{ path: bad, maxBytes: 10 }])).files[0].error?.code).toBe('EBINARY');
        expect((await read([{ path: bad, startByte: 60_000, maxBytes: 10 }])).files[0].content).toBe('a'.repeat(10));
    });

    it('pages one giant line with columns that count from the start of the line', async () => {
        // H4. `startColumn` is a byte offset INTO a physical line, so `nextColumn` has to
        // be one too. It used to be counted from wherever THIS window began, which is the
        // same thing only when the window starts at a line start — so paging a 100 KB line
        // with the documented `{ startLine, startColumn: nextColumn }` pair reported
        // column 1000 on every page and read the same 1000 bytes forever.
        const giant = await seed('giant.txt', `${'x'.repeat(100_000)}\nsecond\n`);

        const first = (await read([{ path: giant, startLine: 1, maxBytes: 1_000 }])).files[0];
        const second = (await read([
            { path: giant, startLine: 1, startColumn: first.nextColumn as number, maxBytes: 1_000 }
        ])).files[0];
        const third = (await read([
            { path: giant, startLine: 1, startColumn: second.nextColumn as number, maxBytes: 1_000 }
        ])).files[0];

        // Each page is 1 000 bytes of the line, and the column it hands back is where the
        // NEXT page starts — measured from byte 0 of the line, which is also
        // `nextByte`, because this line begins at byte 0.
        expect([first.bytes, first.nextLine, first.nextColumn, first.nextByte]).toEqual([1_000, 1, 1_000, 1_000]);
        expect([second.bytes, second.nextLine, second.nextColumn, second.nextByte]).toEqual([1_000, 1, 2_000, 2_000]);
        expect([third.bytes, third.nextLine, third.nextColumn, third.nextByte]).toEqual([1_000, 1, 3_000, 3_000]);

        // Byte-exact, in order, with no gap and no repeat: page 2 is the bytes the window
        // of page 1 never returned.
        expect(first.content).toBe('x'.repeat(1_000));
        expect(second.content).toBe('x'.repeat(1_000));
        expect(third.content).toBe('x'.repeat(1_000));

        // The same rule on a line that does NOT start at byte 0: a seek lands mid-line, so
        // the window-relative and line-relative answers differ, and the line-relative one
        // is what the entry owes. Line 2 of this file starts at byte 6.
        const two = await seed('giant-two-lines.txt', `line1\n${'x'.repeat(200)}\n`);
        const sought = (await read([{ path: two, startByte: 7, maxBytes: 10 }])).files[0];

        expect(sought.content).toBe('x'.repeat(10));
        // 17 - 6: the cut is at byte 17 and the line begins at byte 6.
        expect([sought.nextLine, sought.nextColumn, sought.nextByte]).toEqual([2, 11, 17]);
    });

    it('names the line a startColumn past the end of the line actually returned', async () => {
        // H5. A `startColumn` longer than `startLine` consumes that line's terminator and
        // starts on the next line — the behaviour every version of the skip had, and what
        // a caller walking `{ startLine, startColumn }` depends on. What was wrong is that
        // the entry kept REPORTING the line the caller named, so it printed line 2's text
        // under line 1's number and derived `lineCount` from `startLine - 1`, under-counting
        // by exactly the newline the skip crossed.
        const shifted = await seed('column-past-line.txt', 'abcdefghij\nsecond\nthird\n');

        expect((await read([{ path: shifted, startLine: 1, startColumn: 20 }])).files[0]).toEqual({
            path: join(workdir, 'column-past-line.txt'),
            content: 'second\nthird\n',
            // The line the window starts on (2), not the one that was asked for (1), and
            // the whole file's count is right (3), not short by the crossed newline (2).
            startLine: 2,
            endLine: 3,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 13,
            sizeBytes: 24,
            lineCount: 3
        });

        // A column that fits inside the line keeps reporting the line it was given — the
        // fix is about the position actually reached, not about rewriting every read.
        const inside = (await read([{ path: shifted, startLine: 1, startColumn: 4 }])).files[0];

        expect([inside.startLine, inside.lineCount, inside.content]).toEqual([1, 3, 'efghij\nsecond\nthird\n']);
    });

    it('answers any startLine of an empty file with the empty window it always had', async () => {
        // M11. The line axis made `startLine: 5000` of a 1300-line file an ERANGE entry
        // (and it stays one — pinned above), but the same rule applied to a 0-BYTE file
        // told a caller its offset was out of range in a file that has nothing out of
        // range: the walk that "ran out of file" never ran, because there was no file to
        // walk. An empty file answers the empty window, with the line count that says so.
        const nothing = await seed('m11-empty.txt', '');

        expect((await read([{ path: nothing, startLine: 5 }])).files[0]).toEqual({
            path: join(workdir, 'm11-empty.txt'),
            content: '',
            startLine: 5,
            endLine: 4,
            truncated: false,
            limit: null,
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 0,
            sizeBytes: 0,
            lineCount: 0
        });

        // `startLine: 1` is the same answer with the number the caller stood on, and the
        // byte axis keeps its own rule: an empty file still has no byte at offset 0, so
        // `startByte: 0` there is ERANGE, not an empty window.
        expect((await read([nothing])).files[0].lineCount).toBe(0);
        expect((await read([{ path: nothing, startByte: 0 }])).files[0].error?.code).toBe('ERANGE');

        // And a NON-empty file is still strict about a line past its end, naming the
        // count. `startLine: 1301` of 1300 is the legal boundary one past the last line;
        // 1302 is a line the file does not have.
        const lines = join(workdir, 'lines.txt');
        const boundary = (await read([{ path: lines, startLine: 1_301 }])).files[0];

        expect([boundary.error, boundary.bytes, boundary.truncated, boundary.startLine]).toEqual([
            undefined,
            0,
            false,
            1_301
        ]);

        const past = (await read([{ path: lines, startLine: 1_302 }])).files[0];

        expect(past.error?.code).toBe('ERANGE');
        expect(past.error?.message).toContain('1300');
    });

    it('refuses an endless continuation run by name and offset, not with a silent empty window', async () => {
        // M1, restating L8's bound. The probe stays BOUNDED on purpose: walking an
        // unbounded run of `0x80`s from a seek into a 200 MB file is unbounded work for an
        // answer that is "these bytes are not text" either way. What L8 did with that answer
        // was the defect: giving up reported EOF, the same value the legitimate end-of-file
        // exits report, so a caller that aimed `startByte` at a run of continuation bytes
        // got `content: ""`, `truncated: false` and no error — "the file ends here", for a
        // file with readable bytes before the run. The bound is unchanged; the outcome is
        // now the published `EBINARY` naming the byte the caller pointed at, which is what
        // the same file already answers when the window LANDS on those bytes.
        const misaligned = await seedBytes(
            'misaligned.txt',
            Buffer.concat([Buffer.from('a'), Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80])])
        );

        expect((await read([{ path: misaligned, startByte: 1, lossy: false }])).files[0]).toEqual({
            path: join(workdir, 'misaligned.txt'),
            content: '',
            startLine: 1,
            endLine: 0,
            truncated: false,
            limit: null,
            // Nothing was aligned TO: the offset the caller gave is the offset that was
            // refused, and it is named in the message instead of posing as a window start.
            startByteAligned: null,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 0,
            sizeBytes: 6,
            error: {
                code: 'EBINARY',
                message:
                    `read refused "${join(workdir, 'misaligned.txt')}": byte 1 is inside a run of UTF-8 continuation ` +
                    'bytes longer than any code point, so no whole character starts there (invalid UTF-8). read reads ' +
                    'UTF-8 text only; seek to a byte before the run, or to one after it.'
            }
        });

        // `lossy: true` does not buy a pass over this: the refusal is about the OFFSET being
        // inside data that is not a character at all, which is why NUL is fatal in both decode
        // modes too. A lossy read of the same bytes WITHOUT the seek still substitutes.
        expect((await read([{ path: misaligned, startByte: 1, lossy: true }])).files[0].error?.code).toBe('EBINARY');
        expect((await read([{ path: misaligned, lossy: true }])).files[0].content).toBe('a\ufffd\ufffd\ufffd\ufffd\ufffd');

        // A run of 5 continuation bytes is already past the 4-byte ceiling of a code point,
        // and the probe grows 4 -> 16 -> 64 before it gives up, so a 300-byte run is answered
        // the same way WITHOUT reading the rest of it: bounded work, honest outcome. The old
        // answer for this one was `startByteAligned: 301` and "the file ends".
        const long = await seedBytes('misaligned-long.txt', Buffer.concat([Buffer.from('a'), Buffer.alloc(300, 0x80)]));
        const walked = (await read([{ path: long, startByte: 1 }])).files[0];

        expect([walked.bytes, walked.startByteAligned, walked.error?.code]).toEqual([0, null, 'EBINARY']);

        // Ordinary UTF-8 is still aligned, not given up on: a seek into the MIDDLE of a
        // 2-byte character moves to the next whole one and reads it, and the entry says
        // where the window really began. In `café`, the `é` is bytes 3-4, so a seek to the
        // continuation byte at 4 begins at 5.
        const accents = await seed('misaligned-fine.txt', 'café\n');
        const aligned = (await read([{ path: accents, startByte: 4 }])).files[0];

        expect([aligned.content, aligned.startByteAligned, aligned.bytes]).toEqual(['\n', 5, 1]);
    });

    it('names the failed-path allowance as the reason when the allowance folds the batch (F2)', async () => {
        // F2. The fold line used to blame `FILE_READ_WIRE_BUDGET` for EVERY fold, and for
        // this shape that is simply false. The walk prices slots in REQUEST ORDER and stops
        // at the first one it cannot afford; a failed entry the 8 192-byte error allowance
        // cannot pay for is unaffordable by definition (its message IS its answer), so the
        // walk halts there with most of the 32 768-byte envelope unspent and folds the whole
        // remainder. Measured on this fixture: 40 failures enumerate 4 error entries and fold
        // the rest at ~3.6 KiB of wire — the envelope was nowhere near full.
        //
        // Why the wording is the fix, and the fold mechanics are not: the prefix rule is what
        // makes "the omitted paths are the last N in the order requested" exactly true, so a
        // readable path behind the halt folds with the failures. The caller cannot see that
        // from a count, and a reason clause that blames the envelope sends it to raise
        // `maxBytes` or split a batch that neither of those helps. Here the remedy is fewer
        // FAILED paths, and the pair below is what proves the clause means that: the same
        // batch with the readable file FIRST reads it complete, and BOTH orders name the
        // allowance, because the gate is the ceiling that fired and not the accident of which
        // path happened to be readable.
        const lines = join(workdir, 'lines.txt');
        const clauses = {
            envelope: `because this ${FILE_READ_WIRE_BUDGET}-byte envelope cannot answer them all`,
            errors: `because the ${FILE_READ_ERROR_ENTRY_BUDGET_BYTES}-byte failed-path allowance is full`
        };

        for (const failures of [20, 25, 40]) {
            const missing = Array.from(
                { length: failures },
                (_, index) => join(workdir, 'fold', `missing-${String(index).padStart(2, '0')}.txt`)
            );

            const behind = await readBoth([...missing, { path: lines }]);
            const inFront = await readBoth([{ path: lines }, ...missing]);

            for (const [label, view] of [
                ['file last', behind],
                ['file first', inFront]
            ] as const) {
                const { result, text } = view;
                const declared = text.split('\n')[0];

                expect(declared, `${failures} failures, ${label}: the fold is the first line`).toContain(
                    `read: folded - ${result.omitted} of ${failures + 1} requested paths were not read`
                );
                expect(declared, `${failures} failures, ${label}: names the allowance that fired`).toContain(
                    clauses.errors
                );
                expect(declared, `${failures} failures, ${label}: does not blame the envelope`).not.toContain(
                    clauses.envelope
                );
                // The prefix rule is untouched by the wording: the omission is still exactly
                // the tail of the request.
                expect(
                    result.files.length + (result.omitted ?? 0),
                    `${failures} failures, ${label}: the request is accounted for`
                ).toBe(failures + 1);
                expect(result.omitted, `${failures} failures, ${label}: something folded`).toBeGreaterThan(0);
            }

            // THE ORDER HALF. Behind the halt the readable path is not in `files` at all —
            // every enumerated entry is one of the failures — and in front of it the same
            // file is enumerated and reads COMPLETE, all 11 893 bytes of it, `lineCount` and
            // all. The two batches differ by exactly that one entry.
            expect(
                behind.result.files.every((entry) => entry.error?.code === 'ENOENT'),
                `${failures} failures, file last: only failures are enumerated`
            ).toBe(true);
            expect(
                behind.result.files.some((entry) => entry.path === lines),
                `${failures} failures, file last: the readable path folded with the failures`
            ).toBe(false);

            expect(inFront.result.files[0].path, `${failures} failures, file first: the file is enumerated`).toBe(lines);
            expect(inFront.result.files[0]).toMatchObject({
                bytes: Buffer.byteLength(LINES_1300, 'utf8'),
                truncated: false,
                limit: null,
                nextByte: null,
                lineCount: 1_300
            });

            // The error allowance is what both orders ran out of, and the readable path does
            // not touch that reserve — so the same number of failures is affordable either
            // way, and the only difference between the two batches is the file itself.
            expect(inFront.result.files.length, `${failures} failures: one extra entry, the readable file`).toBe(
                behind.result.files.length + 1
            );
            expect(inFront.result.omitted, `${failures} failures: one fewer folded path`).toBe(
                (behind.result.omitted ?? 0) - 1
            );
        }
    });

    it('names the FIRST byte that cannot decode, not the caller\'s own window start (F8)', async () => {
        // F8. The strict decoder's TypeError carries no position, and the message used to fill
        // the gap with the offset it had on hand — the CALLER's `startByte`. For one bad byte
        // at absolute 20 that made the windows opened at 0, 1, 5 and 11 each echo their own
        // start back ("the bytes from 5 on ... seek past 5"), so the documented remedy advanced
        // exactly ONE byte per call and the caller walked 20 calls to get past one byte. The
        // offset published now is the byte the decode actually rejected, found by the same
        // shape of scan `edit` already reports (edit.tool.ts:1150, "invalid UTF-8 at offset N").
        const message = (path: string, offset: number): string =>
            `read refused "${path}": the first byte of this window that cannot decode is ${offset}, the start of the ` +
            'first sequence that is not valid UTF-8. read reads UTF-8 text only; pass lossy: true to get the window ' +
            `with U+FFFD for the bytes that cannot decode, or seek past ${offset}.`;

        // `a` x 20, then 0xFF at 20, then `b` x 10.
        const oneBad = await seedBytes(
            'decode-offset.bin',
            Buffer.concat([Buffer.alloc(20, 0x61), Buffer.from([0xff]), Buffer.alloc(10, 0x62)])
        );

        // Every window that reaches the bad byte names IT, whatever it started at: the
        // answer no longer depends on where the caller happened to stand.
        for (const startByte of [0, 1, 5, 11, 20]) {
            expect(
                (await read([{ path: oneBad, startByte }])).files[0].error,
                `startByte ${startByte} names the byte that failed, not its own offset`
            ).toEqual({ code: 'EBINARY', message: message(oneBad, 20) });
        }

        // THE POINT OF NAMING IT: the remedy advances in ONE call. Seek past the offset the
        // message gave and the rest of the file is ordinary text.
        const past = (await read([{ path: oneBad, startByte: 21 }])).files[0];

        expect([past.content, past.bytes, past.error]).toEqual(['b'.repeat(10), 10, undefined]);

        // Several bad bytes in one window: the EARLIEST is the one named, from either side of
        // it. 0xFE at 20 is not a lead byte at all; the `C3 28` at 25 — the Latin-1 `Ã(` pair,
        // and the fixture this file already seeds two bytes of — is later, and must not move
        // the number.
        const manyBad = await seedBytes(
            'decode-first.bin',
            Buffer.concat([
                Buffer.alloc(20, 0x61),
                Buffer.from([0xfe]),
                Buffer.alloc(4, 0x61),
                Buffer.from([0xc3, 0x28]),
                Buffer.alloc(4, 0x61)
            ])
        );

        for (const startByte of [0, 18]) {
            expect(
                (await read([{ path: manyBad, startByte }])).files[0].error?.message,
                `startByte ${startByte} names the first invalid byte`
            ).toBe(message(manyBad, 20));
        }

        // THE EDGE THAT DOES NOT MOVE (scope deliberately not widened): a multi-byte sequence
        // the FILE ends in the middle of. That is not a byte in the middle of the text — it is
        // the last character, truncated — and the offset named is the LEAD byte of the sequence,
        // 10, which is what the EOF flush reported before this fix too. The answer is pinned
        // from both sides of the window start so a future change to the flush cannot start
        // echoing the request again.
        const truncated = await seedBytes(
            'decode-tail.bin',
            Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from([0xe4, 0xb8])])
        );

        for (const startByte of [0, 5]) {
            expect(
                (await read([{ path: truncated, startByte }])).files[0].error?.message,
                `a truncated final sequence is named at its lead byte (startByte ${startByte})`
            ).toBe(message(truncated, 10));
        }
    });

    it('charges maxBytes in escaped bytes while bytes stays raw', async () => {
        // M2. The two numbers are deliberately different units, and a caller that cannot
        // predict the difference reads `bytes: 67` from a `maxBytes: 100` window as an
        // off-by-33 bug. The allowance bounds what the CONTEXT pays — the escaped form —
        // while `bytes` bounds what the FILE holds. Both are exact; neither is the other.
        const newlines = await seed('escaped-units.txt', 'a\n'.repeat(60));
        const cut = (await read([{ path: newlines, maxBytes: 100 }])).files[0];

        // 33 whole lines plus the `a` of line 34: 67 raw bytes, 34 `a`s and 33 newlines.
        expect(cut.content).toBe(`${'a\n'.repeat(33)}a`);
        expect([cut.bytes, cut.startLine, cut.endLine, cut.truncated, cut.limit]).toEqual([67, 1, 34, true, 'maxBytes']);
        expect([cut.nextLine, cut.nextColumn, cut.nextByte]).toEqual([34, 1, 67]);

        // The allowance was spent EXACTLY, in its own units: the escaped cost of what was
        // returned is 100, and the raw count is 33 bytes short of it.
        expect(Buffer.byteLength(JSON.stringify(cut.content), 'utf8') - 2).toBe(100);
        expect(Buffer.byteLength(cut.content, 'utf8')).toBe(67);

        // The same shape from the other side: quote-heavy content costs the escape twice,
        // so a 8-byte allowance returns 5 raw bytes.
        const quotes = await seed('escaped-quotes.txt', '"a\n"a\n"a\n');

        expect((await read([{ path: quotes, maxBytes: 8 }])).files[0]).toEqual({
            path: join(workdir, 'escaped-quotes.txt'),
            content: '"a\n"a',
            startLine: 1,
            endLine: 2,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            nextLine: 2,
            nextColumn: 2,
            nextByte: 5,
            bytes: 5,
            sizeBytes: 9
        });
    });

    it('folds a batch the per-entry reserves cannot fit instead of reporting EIO', async () => {
        // Zero allowance. The allocation passes used to be guarded by `allowance > 0`, so
        // a batch whose per-entry reserves exceeded the envelope (here: 95 unreadable
        // paths with 1 200-character names, each of whose error message is reserved up
        // front) ran NO pass at all, the readable file kept `entry: null`, and the fallback
        // called it `EIO` — an I/O failure for a file that was never read. A 0-byte
        // allowance is just the tightest allowance there is.
        const lines = join(workdir, 'lines.txt');
        const missing = Array.from(
            { length: 95 },
            (_, index) => join(workdir, 'reserves', `${'x'.repeat(1_200)}-missing-${index}.txt`)
        );

        const starved = await read([...missing, { path: lines }]);

        // `EIO` is back to meaning "this handle could not be read": it appears nowhere.
        expect(starved.files.some((entry) => entry.error?.code === 'EIO')).toBe(false);
        // What happens instead of the starvation: ONE error entry. Measured on this
        // fixture, a 1 200-character missing path costs 3 003 bytes of entry JSON (the
        // path appears three times — `path`, and twice inside the ENOENT sentence — and
        // every one of them is escaped) plus 1 500 bytes of prose line = 4 503 bytes of
        // per-slot reserve. The batch-wide error budget is a QUARTER of the envelope
        // (8 192 of 32 768), because an error message is an answer but it is not the point
        // of a read: two of these would cost 9 006, so the walk stops at one and folds the
        // other 95 paths — including the readable one, because request order is the only
        // order this tool promises.
        expect(starved.files).toHaveLength(1);
        expect(starved.files[0].error?.code).toBe('ENOENT');
        expect(starved.skipped).toBe(1);
        expect(starved.omitted).toBe(95);
        expect(starved.files.length + (starved.omitted ?? 0)).toBe(96);
        // The envelope holds with the fold declaration in it — the invariant that lets the
        // harness skip its own truncation, which is what `EIO` was a symptom of.
        expect(starved.wireBytes).toBeLessThanOrEqual(starved.contentBudget);
        // And it is declared in the copy the model reads, ahead of every window.
        expect(await projection([...missing, { path: lines }])).toContain(
            'read: folded - 95 of 96 requested paths were not read'
        );

        // THE OTHER HALF, and the reason the fold is not just a smaller lie: with one error
        // entry instead of 95, the same readable file is enumerated and reads COMPLETE —
        // 11 893 bytes, no truncation, no cursor. The old batch handed it one character and
        // called the envelope full; the new one hands it the file and says which paths it
        // could not answer.
        const small = await read([missing[0], { path: lines }]);

        expect(small.omitted).toBeUndefined();
        expect(small.files).toHaveLength(2);
        expect(small.files[0].error?.code).toBe('ENOENT');
        expect(small.files[1]).toMatchObject({
            path: lines,
            bytes: Buffer.byteLength(LINES_1300, 'utf8'),
            truncated: false,
            limit: null,
            nextByte: null,
            lineCount: 1_300
        });
        expect(small.wireBytes).toBeLessThanOrEqual(small.contentBudget);
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
        expect(both.result.modelBytes).toBe(Buffer.byteLength(JSON.stringify(text), 'utf8') - 2);
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

    it('numbers the model copy of ONE file, not of the whole batch', async () => {
        // M1. Numbering was a BATCH-wide flag (`requested.some(...)`), so one caller
        // asking for line numbers printed a gutter on every other file in the call — and
        // since a gutter is charged, it also shrank the windows of files whose owners
        // never asked for one. The flag is per entry now, index-aligned with `files[]`.
        const lines = join(workdir, 'lines.txt');
        const caps = { startLine: 995, maxLines: 10, maxBytes: 128 };

        // A cap chosen so the difference is visible: 128 bytes is exactly the point where
        // paying for a gutter decides how much text fits.
        const solo = await read([{ path: lines, ...caps }]);
        const mixed = await read([{ path: lines, ...caps }, { path: lines, ...caps, numbered: true }]);

        // The unnumbered file's entry is the SAME object shape and the SAME window it
        // gets alone: its bytes were not spent on a gutter it never asked for.
        expect(mixed.files[0]).toEqual(solo.files[0]);
        expect(mixed.files[0].content.startsWith('line 995\n')).toBe(true);
        expect(mixed.files[0].content).toContain('line 1004');

        // The numbered sibling paid for its gutter, so it holds less text — 73 raw bytes
        // against 95, cut at line 1002 instead of running to the 10-line cap.
        expect([mixed.files[1].bytes, mixed.files[1].endLine, mixed.files[1].nextByte]).toEqual([73, 1_002, 8_911]);

        // And the prose says which file has gutters: only the one that asked.
        const alpha = await seed('m1-alpha.txt', 'alpha\n');
        const bravo = await seed('m1-bravo.txt', 'bravo\n');
        const both = await readBoth([{ path: alpha }, { path: bravo, numbered: true }]);

        expect(both.text).toContain('\nalpha\n');
        expect(both.text).toContain('\n1: bravo\n');
        expect(both.text).not.toContain('1: alpha');
        // The machine view is untouched in both directions.
        expect(both.result.files.map((entry) => entry.content)).toEqual(['alpha\n', 'bravo\n']);
    });

    it('charges the gutter at the width the model copy pads to', async () => {
        // L1, restated after the reviewer's F4. The invariant this charge exists for is NOT
        // "the model's copy is never larger than the machine view" — escapes and the
        // continuation note can make the prose bigger, and it legitimately is here. What has
        // to hold is that the gutter the SCANNER charges is at least the gutter the RENDERER
        // prints, so a window can never be cut at an allowance the wire then cannot pay.
        // Charging `String(lineNumber).length` per line under-charged every line of a window
        // that later crossed a digit boundary (995-999 are 3 wide, 1000 onward are 4).
        const lines = join(workdir, 'lines.txt');
        const capped = await readBoth([
            { path: lines, startLine: 995, maxLines: 10, maxBytes: 128, numbered: true }
        ]);

        // 128 is the discriminating cap. Charged per line at the CURRENT width, lines
        // 995-999 cost 16 escaped bytes of text ('line 995\n') plus 5 of gutter each and
        // line 1002 (12 + 6) fits at 126 — the window would end at line 1002 complete, 79
        // bytes, cursor 8913. Charged at the width the renderer pads to (4 digits for a
        // window that reaches 1000), all of line 1002 costs 132, does not fit, and the
        // window stops 8 bytes into it — which is what the entry has to report.
        expect(capped.result.files[0]).toEqual({
            path: lines,
            content: `${['995', '996', '997', '998', '999', '1000', '1001'].map((n) => `line ${n}\n`).join('')}line 100`,
            startLine: 995,
            endLine: 1_002,
            truncated: true,
            limit: 'maxBytes',
            startByteAligned: null,
            nextLine: 1_002,
            // 8911 - 8903: 8 bytes into line 1002, counted from the start of THAT line.
            nextColumn: 8,
            nextByte: 8_911,
            bytes: 73,
            sizeBytes: Buffer.byteLength(LINES_1300, 'utf8')
        });

        // The invariant the charge exists for, on the read that stresses it, is not an
        // ordering of the two views (F4) — it is that the machine view fits the budget it
        // names. Both views also carry the same fixture path, so the path-independent
        // costs are what the numbers pin: the entry's fixed fields and the escaped
        // content outweigh the 73-byte prose window by 97 bytes (378 against 281). The
        // wire also pays M7's `budgetPool` field, whose cost is its own digits, and the
        // 32 768-byte `contentBudget` it now reports is one digit shorter than the
        // 262 144 it used to — that is the byte the old base counted. Either way the wire
        // is inside `contentBudget`, which is what keeps the continuation from being cut.
        expect(capped.result.wireBytes).toBe(378 + serializedPathBytes(lines) + poolWire(capped.result));
        // +10 against the pre-T3 base of 271: `modelBytes` is now the ESCAPED length of the
        // projection (the unit `boundToolResult` measures and the request body pays), and
        // this window's prose holds exactly ten newlines - eight window lines, the entry
        // header and the truncation footer - each of which costs 2 there and 1 raw.
        expect(capped.result.modelBytes).toBe(281 + pathBytes(lines));
        expect(capped.result.wireBytes).toBeLessThanOrEqual(capped.result.contentBudget);

        // One steady gutter across the 999 -> 1000 boundary — the alignment is the
        // feature, and a ragged gutter is what the per-line width produced.
        expect(capped.text).toContain(
            '\n 995: line 995\n 996: line 996\n 997: line 997\n 998: line 998\n 999: line 999\n' +
                '1000: line 1000\n1001: line 1001\n1002: line 100\n'
        );
        expect(capped.text).toContain('  [truncated by maxBytes; 73 bytes returned; continue from startByte 8911, or startLine 1002 +8 bytes into it]\n');
    });

    it('states the real relationship between the two views, in both directions (F4)', async () => {
        // F4. The header used to promise `modelBytes <= wireBytes` ("the model's copy is
        // provably no larger than the machine view"), and the test that appeared to prove it
        // ran a plain, single-digit, one-line window where the escapes happened to cost the
        // prose nothing. The two views are BUDGETED, not ordered, and this pins both
        // directions with numbers a reader can recompute.
        const pair = await seed('views.txt', 'x\ny\n');
        const numbered = await readBoth([{ path: pair, numbered: true }]);

        // Direction 1 — the shape a reader meets first, and the only one the old invariant
        // ever saw: a four-byte window costs MORE on the machine view than in prose, because
        // the entry carries twelve fixed fields whatever the content is. Both views also
        // carry this fixture's path, so the pinned bases carry the direction on their own.
        expect(numbered.result.files[0].content).toBe('x\ny\n');
        expect(numbered.result.files[0].bytes).toBe(4);
        // The −1 against the pre-T3 base is `contentBudget`: 32 768 is one digit shorter
        // than the 262 144 the result used to report. `poolWire` absorbs the digits of
        // `budgetPool` itself, so nothing else here moves with the fixture's path.
        expect(numbered.result.wireBytes).toBe(306 + serializedPathBytes(pair) + poolWire(numbered.result));
        // +3 against the pre-T3 base of 82, for the same reason as the gutter case: the
        // prose of a complete two-line numbered window is the entry header plus two lines,
        // i.e. three newlines, and `modelBytes` counts each of them at its PAYLOAD cost of
        // 2 bytes rather than its raw 1.
        expect(numbered.result.modelBytes).toBe(85 + pathBytes(pair));

        // Direction 2 — the one the old invariant ruled out. The gutter lives only in the
        // prose, yet it is charged against the machine allowance, so a large numbered window
        // delivers more bytes of TEXT than the machine view costs: this window is the whole
        // of `lines.txt`, the machine view serializes it once, and the model's copy pays a
        // gutter on all 1300 lines on top of it.
        const lines = join(workdir, 'lines.txt');
        const whole = await readBoth([{ path: lines, startLine: 1, maxLines: 1_300, maxBytes: 65_536, numbered: true }]);

        expect(whole.result.files[0].endLine).toBe(1_300);
        expect(whole.result.files[0].bytes).toBe(Buffer.byteLength(LINES_1300, 'utf8'));
        // Pinned exactly, path included. The larger number is the PROSE — the asymmetry
        // the header documents rather than a bug in it. The bases moved with T3: −1 on the
        // wire for the one-digit-shorter `contentBudget`, and +1,301 on the prose because
        // `modelBytes` now counts the payload cost of every newline the model's copy
        // carries (the header line plus all 1,300 window lines) rather than its raw cost.
        // The extra `fieldWire` term is M7's `budgetGranted`: this shape asks for 65 536
        // and the batch can only grant the pool, so the grant is published on the entry
        // even though the file ended before it was spent — and its cost is its own digits.
        expect(whole.result.wireBytes).toBe(
            13_515 +
                serializedPathBytes(lines) +
                poolWire(whole.result) +
                fieldWire('budgetGranted', whole.result.files[0].budgetGranted as number)
        );
        expect(whole.result.modelBytes).toBe(21_080 + pathBytes(lines));

        // What the guarantee actually is, on both shapes: the machine view — the part the
        // harness envelope would have to fit — always fits the budget it names, so the
        // continuation fields survive and the prose is never the thing that gets cut.
        expect(numbered.result.wireBytes).toBeLessThanOrEqual(numbered.result.contentBudget);
        expect(whole.result.wireBytes).toBeLessThanOrEqual(whole.result.contentBudget);

        // And the property the projection exists for: whatever the machine view delivered,
        // the prose carries the SAME content, so neither consumer can be cut off from a fact
        // the other one has. For a plain window that is literal — the bytes of `content`
        // appear in the prose exactly as they are.
        const controls = await seed('views-controls.txt', 'a"b\tc\n');
        const plain = await readBoth([{ path: controls, maxBytes: 7 }]);

        // `maxBytes: 7` is spent on 'a' (1) + '"' (2, escaped) + 'b' (1) + '\t' (2, escaped)
        // + 'c' (1) = 7, so the newline does not fit: 5 RAW bytes in `content` against the
        // 7-byte ESCAPED allowance that paid for them — the M2 units, visible in one window.
        expect(plain.result.files[0].content).toBe('a"b\tc');
        expect(plain.result.files[0].bytes).toBe(5);
        expect(plain.text).toContain(plain.result.files[0].content);
        // For a numbered window, the same fact in the rendering the model reads: every line
        // the machine view delivered appears with its gutter.
        expect(numbered.text).toContain('1: x\n2: y\n');
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

            expect(both.result.modelBytes, label).toBe(Buffer.byteLength(JSON.stringify(both.text), 'utf8') - 2);
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

    it('refuses an unknown range field by name instead of serving the default window', async () => {
        // The sibling of ./write.test.ts's `write files entries do not accept ...` pin, and the
        // half THIS tool was missing. The schema says `additionalProperties: false`, but the
        // DIRECT call path hands `execute` its argument untouched (../../core/tool.ts), and the
        // bare-ARRAY form of `paths` skips the `parameters.paths` wrapper the harness validates
        // at all. So `[{ path, offset: 3 }]` — and the typos `maxByte`, `maxLine`, `maxlines`,
        // which are one character from a real field — were served the DEFAULT window with no
        // signal whatsoever: the caller believed it had bounded the read, and the entry reported
        // a window it never asked for. Naming the key and the accepted set (./read.tool.ts's
        // `FILE_READ_FIELDS`) turns that silence into one round trip. Mirrors the wording of
        // `write files entries do not accept ...` and `edit edits entries do not accept ...`.
        const alpha = join(workdir, 'a.txt');

        // Refused before any syscall: the guard runs inside `normalizeTargets`, so a typo in the
        // LAST entry cannot produce a misleading partial answer.
        for (const field of ['offset', 'maxByte', 'maxLine', 'maxlines']) {
            await expect(read([{ path: alpha, [field]: 1 } as never])).rejects.toThrow(
                `read paths entries do not accept "${field}". Allowed fields: path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered.`
            );
        }

        // The same key inside a mixed bare batch, where the first entry is a valid bare string:
        // the guard cannot be avoided by changing the shape of the entry around it.
        await expect(read([alpha, { path: alpha, offset: 2 } as never])).rejects.toThrow(
            'read paths entries do not accept "offset". Allowed fields: path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered.'
        );
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
            // L11: the value is echoed as JSON, so a quoted string reads as a quoted
            // string. `received yes` was the same sentence for `'yes'` and for `yes`,
            // which is the one distinction the caller needed.
            'read lossy must be a boolean or omitted; received "yes".'
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
            budgetPool: anyPool,
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
        expect(FILE_READ_DEFAULT_MAX_BYTES).toBe(16 * 1024);
        expect(FILE_READ_MAX_BYTES).toBe(256 * 1024);
        // The ceiling is deliberately ABOVE the envelope (8x). Asking for more than the
        // envelope can deliver is allowed and answered with the envelope as the binding
        // limit, which `limit: "budget"` and the aggregate projection line both report.
        // Equality here would make the ceiling a second name for the budget and hide
        // which of the two cut a window.
        expect(FILE_READ_MAX_BYTES).toBe(8 * FILE_READ_WIRE_BUDGET);
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
        expect(FILE_READ_WIRE_BUDGET).toBe(32 * 1024);
    });

    it('keeps the declaration inside its context budget', () => {
        // THE DECLARATION TAX. `visibility: 'core'` means this description and this
        // schema are sent on EVERY request, so their bytes are paid by every conversation
        // the harness runs, not only by the calls that use `read`. Measured before D11:
        // 3,285 bytes of description and 2,939 of parameter schema. The guard exists
        // because a description only ever grows - the reasoning that belongs in a
        // sentence here is worth 400 bytes on every request, and the reasoning that
        // belongs in a paragraph belongs in the source header or the projection.
        //
        // T14 raised the number by 10 bytes, and paid for them the same way T6 did: naming
        // `ECANCELED` (the description has to name every published code, and the loop below is
        // what enforces that) costs 34 bytes for " or a cancelled call (`ECANCELED`)", which two
        // clauses that restated the parameter schema paid for — "Max 100 paths. " (15, already in
        // `maxItems`) and "(a SEEK) " (9, a description of a description). The description now
        // says what a cancelled call does, which is the fact a caller cannot infer from
        // `error: { code }`, and the ceiling did not move.
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
        // T6 raised the description's WORK (it now has to explain the new wire surface:
        // `rawCode`, `budgetPool`, `budgetGranted`, `sizeBytes: null`, the physical-start
        // rule for `startColumn`, and three codes that did not exist before) without raising
        // the ceiling: the text was rewritten so every clause that merely restated the
        // parameter schema — which travels with it on every request anyway — gave up its
        // bytes to those facts. Measured after the rewrite, and again after T14's 10-byte
        // addition: 1,695 description bytes and 2,580 schema bytes, against 1,700 and 2,600, so
        // the declaration tax is still inside the envelope it was capped at. The headroom is 5
        // bytes on purpose: the next fact that wants a sentence has to pay for it out of the
        // description, not out of the ceiling.
        //
        // One clause the rewrite dropped and the rewrite's own follow-up put BACK: "The 256
        // KiB budget is measured on the SERIALIZED result". A caller that takes `content`'s
        // raw length as its allowance is wrong, because the envelope counts the SERIALIZED
        // result — path, escaping and the note included — and that is the one fact about the
        // budget a model cannot infer from the field names. `src/tools/laziness.test.ts:160`
        // pins the same phrase; the assertion below is what stops a future trim from silently
        // breaking it from this side.
        // T3 paid for two new facts inside this ceiling (the envelope is a shared,
        // model-facing budget, and it is measured on the SERIALIZED form) by dropping the
        // parentheticals that only restated the schema. Re-measured, not estimated.
        //
        // T7's fold fact (a batch wider than the envelope answers a PREFIX and declares
        // `omitted`) costs 104 bytes, paid for inside the same ceiling by dropping the two
        // diagnostic glosses ", `modelBytes` what this call put in the transcript,
        // `wireBytes` what the machine result costs" (93 bytes): those two field names say
        // what they are, and neither changes what the next call should ask for, whereas a
        // caller that cannot see the omission asks for nothing. Re-measured: 1 694 against
        // the 1 700 ceiling.
        expect(descriptionBytes).toBe(1_694);
        // Every code this tool can publish is named in the description, because a model that
        // is not told a code exists cannot branch on one (H5 made the set closed and
        // enumerable, which is what makes this assertion possible).
        for (const code of FILE_READ_ERROR_CODES) {
            expect(FILE_READ_METADATA.description).toContain(code);
        }
        // The same argument for the new receipts and the two rules a caller cannot infer from
        // the shape alone: the per-file deadline's number, and the fact that a `sizeBytes` of
        // 0 or null is not EOF.
        // The same argument for the new receipts and the three rules a caller cannot infer
        // from the shape alone: the per-file deadline's number, the fact that a `sizeBytes`
        // of 0 or null is not EOF, and the fact that the envelope is measured on the
        // SERIALIZED result rather than on `content`'s raw length.
        for (const fact of [
            'rawCode',
            'budgetPool',
            'budgetGranted',
            'skipped',
            'sizeBytes',
            '32 KiB budget is measured on the SERIALIZED result',
            String(FILE_READ_IO_DEADLINE_MS),
            'null as EOF'
        ]) {
            expect(FILE_READ_METADATA.description).toContain(fact);
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

    // -------------------------------------------------------------------------
    // T6 REGRESSION COVERAGE — one test per audit finding, in the id's own words.
    // Each comment names the id and the `read.tool.ts` region that implements the
    // fix, so a future edit that changes the behavior fails a test that says which
    // behavior it was. Platform-dependent fixtures (FIFO, unix socket, symlink loop,
    // `/proc`) are guarded at the top of each test and explained there.
    // -------------------------------------------------------------------------

    it('opens a FIFO without hanging the call and answers EAGAIN for an empty pipe (H2)', async () => {
        // H2: `open` was mode `'r'` (`O_RDONLY` with no `O_NONBLOCK`) for EVERY target, so
        // a FIFO with no writer blocked IN THE KERNEL — no deadline, no cancellation, the
        // whole batch lost with it. The open flags are now chosen from the target's mode
        // (`kindOfTarget` + `OPEN_NONBLOCKING`), decided BEFORE the open because nothing on
        // the JavaScript side can interrupt an `open(fifo, 'r')` that never returns.
        //
        // This test IS the no-hang proof: with the old flags the call would sit here until
        // the runner's own timeout. With `O_NONBLOCK` the open returns at once, the empty
        // pipe answers "no bytes right now", and the entry publishes `EAGAIN` instead of the
        // EOF it used to pose as (`wouldBlock` in `scanFile` + `WouldBlockError`).
        const fifo = await makeFifo('pipe');

        if (fifo === null) return; // no FIFO on this box — the target cannot be built

        const result = await read([fifo, join(workdir, 'a.txt')]);

        expect(result.files[0]).toEqual({
            path: fifo,
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
            // H3: what a pipe holds is not a `st_size` fact, so nothing is published here.
            sizeBytes: null,
            error: {
                code: 'EAGAIN',
                message:
                    `read found no bytes to read in "${fifo}": nothing is writing to it right now, so the read had ` +
                    'nothing to take (EAGAIN). A FIFO only carries what a writer sends: start the writer, or read a ' +
                    'regular file. This is NOT "the file is empty" — retry once there is a writer.'
            }
        });
        // EXTRA-1: the failure stayed in its own entry — and this one is raised in the SCAN
        // phase, which is exactly where the old code let an error escape the batch.
        expect(result.files[1].content).toBe('alpha\n');
        expect(result.files[1].error).toBeUndefined();
        expect(result.skipped).toBe(1);
    });

    it('refuses a startByte on a FIFO as ESPIPE rather than reading it from nowhere (H2)', async () => {
        // H2: a POSITIONAL read on a pipe, socket or device is ESPIPE. So a `startByte` on
        // such a target is not a value to ignore but a request that cannot be answered, and
        // phase 1 says so before the budget is split (`unseekableMessage`).
        const fifo = await makeFifo('pipe-seek');

        if (fifo === null) return;

        expect((await read([{ path: fifo, startByte: 5 }])).files[0]).toEqual({
            path: fifo,
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
                code: 'ESPIPE',
                message:
                    `read cannot seek "${fifo}": it is not a regular file (a pipe, socket or device has no file ` +
                    'offset, so startByte cannot be answered there — ESPIPE). Read it without startByte, which ' +
                    'streams it from wherever it currently is.'
            }
        });
    });

    it('gives an unresponsive file its own ETIMEDOUT entry instead of taking the call (H2)', async () => {
        // H2: a per-file wall-clock budget (`FILE_READ_IO_DEADLINE_MS`, threaded through
        // `FileIo`/`IoBudget` and enforced by `bounded` around every syscall). A file that
        // runs out is ONE entry's outcome; its siblings keep their content.
        //
        // `ioDeadlineMs: 0` is the deterministic seam: a non-positive ceiling produces an
        // already-expired deadline, which `bounded` refuses SYNCHRONICALLY before the first
        // syscall — so this pins the path without racing a timer or waiting out 10 seconds.
        const alpha = join(workdir, 'a.txt');
        const beta = join(workdir, 'b.txt');

        expect(FILE_READ_IO_DEADLINE_MS).toBe(10_000);
        expect(DEFAULT_FILE_READ_LIMITS.ioDeadlineMs).toBe(FILE_READ_IO_DEADLINE_MS);

        const timedOut = await readWith([alpha, beta], { ioDeadlineMs: 0 });

        expect(timedOut.files.map((file) => file.error?.code)).toEqual(['ETIMEDOUT', 'ETIMEDOUT']);
        expect(timedOut.files[0].error?.message).toBe(
            `read gave up on "${alpha}" after 0ms of filesystem I/O (ETIMEDOUT): the device or mount holding it did ` +
                "not answer in time, so this file's window is empty and the other paths in the call are unaffected. " +
                'Try the path again, or read a file on a responsive mount.'
        );
        // An honest empty window: no bytes, no claim of truncation, and `sizeBytes: null`
        // because nothing was ever learned about the file.
        expect([timedOut.files[0].bytes, timedOut.files[0].truncated, timedOut.files[0].sizeBytes]).toEqual([
            0,
            false,
            null
        ]);
        expect(timedOut.bytes).toBe(0);
        expect(timedOut.skipped).toBe(2);

        // The ceiling is a limit, not a law: `Infinity` switches the bound off and the same
        // file reads normally, which is what a host with longer patience binds.
        const patient = await readWith([alpha], { ioDeadlineMs: Number.POSITIVE_INFINITY });

        expect(patient.files[0].content).toBe('alpha\n');
        expect(patient.files[0].error).toBeUndefined();
        expect(patient.skipped).toBe(0);
    });

    it('rejects the whole call when the harness cancels it, and does not invent an entry (H2)', async () => {
        // Cancellation is not a fact about one file. The harness discards a late result
        // anyway (src/types/index.ts:2356-2357), so `execute` hands the run's signal to
        // `readFileBatch` and an aborted call REJECTS; a per-file DEADLINE is the opposite
        // case and stays one entry (test above). The two must not be confused, which is also
        // why `errorCodeOf` refuses to read an AbortError's NUMERIC `code` as an errno —
        // otherwise cancellation would have been folded into `EIO` per entry.
        //
        // What the rejection IS changed (T14). It used to be whatever the host's signal
        // carried: measured on this exact call, a DOMException whose `name` is `AbortError` and
        // whose `code` is the NUMBER 20 — not a string errno, not a member of
        // `FILE_READ_ERROR_CODES`, and one careless `errorCodeOf` away from the `EIO` fold this
        // very comment warns about. It is now the published `ECANCELED` (./cancellation.ts), so
        // the caller that has to branch has a CODE, while the platform reason it caused is still
        // there as `rawCode` (present because it differs from `code`, the published rule) and as
        // `cause`.
        const alpha = join(workdir, 'a.txt');
        const controller = new AbortController();

        // A live signal changes nothing about the answer.
        const live = await readWith([alpha], undefined, controller.signal);

        expect(live.files[0].content).toBe('alpha\n');

        controller.abort();

        const failure = await readFileBatch([alpha], DEFAULT_FILE_READ_LIMITS, controller.signal)
            .then(() => null)
            .catch((error: unknown) => error as { name?: string; code?: string; message?: string; details?: unknown });

        expect(failure).not.toBeNull();
        expect(failure?.name).toBe('ECANCELED');
        expect(failure?.code).toBe('ECANCELED');
        expect(failure?.code).not.toBe('EIO');
        expect(failure?.message).toBe(
            `read was cancelled (ECANCELED) on ${JSON.stringify(alpha)}: the caller's abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended.`
        );
        expect(failure?.details).toEqual({ rawCode: 'AbortError', path: alpha });
        // Reached through the cast src/util/errors.ts itself uses: `cause` is assigned, not
        // declared, because the package does not pull in lib es2022.error.
        expect((failure as { cause?: { name?: string } }).cause?.name).toBe('AbortError');
    });

    it('answers a cancelled call to a host with one ECANCELED rejection, never with partial results', async () => {
        // The same contract from the CALLABLE side, because this is what a host actually sees.
        // The abort below is issued synchronously after `execute`, so it arrives after the
        // callable's own pre-check and on the FIRST entry's check: the deterministic form of a
        // mid-call cancellation, and the reason `details.path` names `alpha` rather than `beta`.
        // The half that matters for the contract is that the call REJECTS: a cancelled read does
        // not come back holding whichever file it happened to reach, because a cancelled call has
        // no consumer left for a result.
        const alpha = join(workdir, 'a.txt');
        const beta = join(workdir, 'b.txt');
        const controller = new AbortController();

        const pending = readTool.execute({ parameters: [alpha, beta], signal: controller.signal });

        controller.abort();

        const failure = await pending
            .then(() => null)
            .catch((error: unknown) => error as { name?: string; code?: string; details?: unknown; files?: unknown });

        expect(failure).not.toBeNull();
        expect(failure?.name).toBe('ECANCELED');
        expect(failure?.code).toBe('ECANCELED');
        expect(failure?.details).toEqual({ rawCode: 'AbortError', path: alpha });
        // No `files` array survived the rejection: the caller is never handed half a batch and
        // told it is the answer.
        expect(failure?.files).toBeUndefined();
        expect((failure as { cause?: { name?: string } }).cause?.name).toBe('AbortError');
    });

    it('reads a size-less pseudo-file honestly and lets its own cursor resume it (H3)', async () => {
        // H3 + EXTRA-2: a `/proc` entry is a REGULAR file that reports `st_size === 0` while
        // really holding over a kilobyte of text. Publishing that 0 as `sizeBytes` made three
        // separate wrong answers: the documented `startByte = nextByte` continuation was an
        // ERANGE on a file with bytes in it; the byte walks were bounded by 0, so a
        // `startLine` was silently answered from byte 0 (EXTRA-2); and a full window
        // short-circuited to `lineCount: 0` (EXTRA-4). The size is now a model (`FileSize`),
        // a phase-1 one-byte probe separates "empty" from "unknown", and only a fact is
        // published.
        //
        // FIXTURE: `/proc/self/limits`, NOT `/proc/self/status`. Measured: `status` re-renders
        // on EVERY read and its `State:` line changes LENGTH ("S (sleeping)" is 12 characters,
        // "R (running)" 10), so the absolute offset of every later line moves between the chunk
        // whose newlines this tool counted and the positional read that follows — 21 of 40
        // line-axis windows disagreed with the file's own line 3, which is exactly how this
        // test came to fail under the parallel suite while passing focused. `limits` is the
        // same pseudo-file shape (`st_size` 0, regular, text, newline-terminated) with 0
        // differing re-renders in 40 reads, so the cross-read expectations below are exact.
        //
        // `/proc` IS the fixture, so this test is Linux by nature: absent it, it returns.
        if (!(await exists('/proc/self/limits'))) return;

        const path = '/proc/self/limits';
        const whole = (await read([path])).files[0];

        expect(whole.error).toBeUndefined();
        expect(whole.sizeBytes).toBeNull();
        // The bytes the entry reports are the bytes the content holds, whatever `stat` said.
        expect(whole.bytes).toBe(Buffer.byteLength(whole.content, 'utf8'));
        expect(whole.truncated).toBe(false);
        expect(whole.nextByte).toBeNull();
        // EXTRA-4: the line count is a COUNT, not a `st_size` reading. A newline TERMINATES
        // the line above it, so the terminators are the count, and the walk that read this
        // file to EOF earned that number without probing the tail.
        expect(whole.content.endsWith('\n')).toBe(true);
        expect(whole.lineCount).toBe(whole.content.split('\n').length - 1);
        expect(whole.lineCount).toBe(whole.endLine);

        // A 3-line window, then the documented resume from the byte it names.
        const window = (await read([{ path, maxLines: 3 }])).files[0];

        expect(window.truncated).toBe(true);
        expect(window.limit).toBe('maxLines');
        expect(window.startLine).toBe(1);
        expect(window.endLine).toBe(3);
        expect(window.nextLine).toBe(4);
        expect(window.nextColumn).toBe(0);
        expect(window.nextByte).toBe(Buffer.byteLength(window.content, 'utf8'));
        // A window stopped mid-file on a target with no proven end has no whole-file answer,
        // so the key is absent rather than 0 (the old EXTRA-4 false answer).
        expect('lineCount' in window).toBe(false);

        const resumed = (await read([{ path, startByte: window.nextByte as number }])).files[0];

        // THE defect's executable answer: not ERANGE and not empty — the REST of the same
        // file, byte for byte, with no invented size. The split/join here round-trips exactly
        // (`whole.content` ends with a terminator, so the last element is an empty string),
        // which makes this a byte-exact expectation rather than a prefix check.
        expect(resumed.error).toBeUndefined();
        expect(resumed.startLine).toBe(4);
        expect(resumed.sizeBytes).toBeNull();
        expect(resumed.content).toBe(whole.content.split('\n').slice(3).join('\n'));
        // Paging to the end earns the count even with no size to stand on (EXTRA-4): the walk
        // proved the end, and `endsWithNewline` settles the terminator question from the byte
        // that walk actually stopped on instead of a positional probe a pseudo-file can answer
        // arbitrarily.
        expect(resumed.truncated).toBe(false);
        expect(resumed.lineCount).toBe(resumed.endLine);

        // EXTRA-2: the LINE axis on the same lying `st_size`. A walk bounded by the bogus 0
        // asked for `0 - cursor` bytes, moved nothing, and answered `startLine: 5` from byte 0
        // — line 1's text under line 5's number, with no error to say so. With the size
        // modelled as unknown the walk is unbounded and stops at a real EOF instead.
        const fifth = (await read([{ path, startLine: 5, maxLines: 2 }])).files[0];

        expect(fifth.error).toBeUndefined();
        expect(fifth.startLine).toBe(5);
        expect(fifth.endLine).toBe(6);
        expect(fifth.content).toBe(`${whole.content.split('\n').slice(4, 6).join('\n')}\n`);
        // Not line 1 again — the exact shape of the old bug (line 1 of this file is its
        // `Limit ... Units` column header).
        expect(fifth.content.startsWith('Limit')).toBe(false);
        // And it did not start at byte 0: the absolute cursor the window ends at is the end of
        // line 6 measured from the top of the file, which a from-byte-0 answer could not be.
        expect(fifth.nextByte).toBe(Buffer.byteLength(`${whole.content.split('\n').slice(0, 6).join('\n')}\n`, 'utf8'));
        // Stopped mid-file, so the whole-file count is still not earned (EXTRA-4).
        expect(fifth.truncated).toBe(true);
        expect(fifth.limit).toBe('maxLines');
        expect('lineCount' in fifth).toBe(false);
    });

    it('names a real line count when a pseudo-file cannot answer the line axis (EXTRA-4)', async () => {
        // The count in this message is what makes "you are past the end" actionable, and it
        // used to be 0 because the whole calculation went through a `sizeBytes === 0` shortcut
        // (`lineCountAtEof`). `/proc/self/status` is the fixture here — a single read, and the
        // assertion is about the SHAPE of the number, not its value: how many lines that file
        // has depends on the kernel, and its own content re-renders between reads (see the H3
        // test above), so the honest exactness level is "a positive integer that is not 0".
        if (!(await exists('/proc/self/status'))) return;

        const entry = (await read([{ path: '/proc/self/status', startLine: 5000 }])).files[0];

        expect(entry.error?.code).toBe('ERANGE');
        expect(entry.sizeBytes).toBeNull();
        expect(entry.error?.message).toMatch(
            /^read could not start "\/proc\/self\/status" at line 5000: the file has [1-9]\d* lines, so that line does not exist \(ERANGE\)\./
        );
        expect(entry.error?.message).not.toContain('has 0 lines');
    });

    it('folds an errno it does not publish into EIO with the untouched name in rawCode (H5)', async () => {
        // H5: the published code set is CLOSED — `FileReadErrorCode` plus the
        // `FILE_READ_ERROR_CODES` value a caller can enumerate. `open()` on a unix-domain
        // socket answers ENXIO, which has no published entry, so the entry carries
        // `code: 'EIO'` (branchable) and `rawCode: 'ENXIO'` (loggable). Before the fix the
        // arbitrary errno WAS the code, with no contract saying it could be.
        //
        // POSIX/Linux only: the fixture is a socket inode, and opening one is what yields
        // the errno.
        if (process.platform === 'win32') return;

        const socketPath = join(workdir, 's');
        const server = createServer((client) => client.end());

        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(socketPath, () => resolve());
            });
        } catch {
            server.close();

            return; // no unix sockets here (unsupported, or the path outgrew the sockaddr)
        }

        try {
            const result = await read([socketPath, join(workdir, 'a.txt')]);

            expect(result.files[0].error?.code).toBe('EIO');
            expect(result.files[0].error?.rawCode).toBe('ENXIO');
            // This tool's own sentence plus the errno it refused to lose. The rest of the
            // line is libuv's wording, which the contract does not promise.
            expect(result.files[0].error?.message).toContain(`read failed to read "${socketPath}": ENXIO`);
            // The fold stayed in its entry: the sibling is untouched, and an entry with no
            // error carries no `rawCode`.
            expect(result.files[1].content).toBe('alpha\n');
            expect(result.files[1].error).toBeUndefined();
            expect(result.skipped).toBe(1);
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await rm(socketPath, { force: true });
        }
    });

    it('publishes exactly the error codes its contract says it publishes (H5)', () => {
        // The closed set, pinned as a value (the type is erased at runtime, so this list IS
        // the contract a caller can enumerate). 14 members, no duplicates, no gap. T14 added
        // `ECANCELED`: a cancelled call REJECTED before this too (H2 above), but with whatever
        // the host's signal carried — measured: a DOMException named `AbortError` whose `code`
        // is the NUMBER 20 — which is not a member of this set and cannot be branched on.
        expect([...FILE_READ_ERROR_CODES].sort()).toEqual([
            'EACCES',
            'EAGAIN',
            'EBINARY',
            'ECANCELED',
            'EIO',
            'EISDIR',
            'ELOOP',
            'ENAMETOOLONG',
            'ENOENT',
            'ENOTDIR',
            'EPERM',
            'ERANGE',
            'ESPIPE',
            'ETIMEDOUT'
        ]);
        expect(new Set(FILE_READ_ERROR_CODES).size).toBe(FILE_READ_ERROR_CODES.length);
    });

    it('answers ENOTDIR and ELOOP by name, with the remedy each one needs (H5)', async () => {
        // Two of the newly-named codes. Both used to reach the caller as a bare errno with a
        // Node message; each has a published entry now because the two need OPPOSITE
        // remedies — one is a path spelling, the other a link cycle.
        const notADirectory = join(workdir, 'a.txt', 'inner');
        const notDir = (await read([notADirectory, join(workdir, 'a.txt')])).files;

        expect(notDir[0].error).toEqual({
            code: 'ENOTDIR',
            message:
                `read cannot resolve "${notADirectory}": a component of the path before the file is not a directory ` +
                '(ENOTDIR), so nothing can be looked up inside it. Check that the separator belongs where the name does.'
        });
        expect(notDir[1].content).toBe('alpha\n');

        // A symlink loop needs the POSIX symlink call; skip where it cannot be created.
        if (process.platform === 'win32') return;

        const loop = join(workdir, 'loop-a');
        const loopOther = join(workdir, 'loop-b');

        await symlink(loopOther, loop);
        await symlink(loop, loopOther);

        expect((await read([loop])).files[0].error).toEqual({
            code: 'ELOOP',
            message:
                `read cannot resolve "${loop}": the path crosses more symbolic-link levels than the filesystem allows ` +
                '(ELOOP), so it almost certainly links back to itself. Read the link\'s target directly.'
        });
    });

    it('keeps a scan-phase rejection inside its own entry (EXTRA-1)', async () => {
        // EXTRA-1: an error raised AFTER phase 1 — while a window was being scanned — used to
        // escape the allocation loop, rejecting the whole call and destroying the content its
        // siblings had already produced. `scanSafely` classifies it into that ONE entry now.
        // The deterministic case is the M1 binary rejection (a `startByte` inside a run of
        // continuation bytes); the FIFO's `EAGAIN` above is the filesystem-error case.
        const misaligned = await seedBytes(
            'extra1-binary.txt',
            Buffer.concat([Buffer.from('a'), Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80])])
        );

        const result = await read([{ path: misaligned, startByte: 1 }, join(workdir, 'a.txt')]);

        expect(result.files[0].error?.code).toBe('EBINARY');
        expect(result.files[0].content).toBe('');
        expect(result.files[1].content).toBe('alpha\n');
        expect(result.files[1].error).toBeUndefined();
        expect(result.bytes).toBe(6);
        expect(result.skipped).toBe(1);
    });

    it('publishes what the batch actually granted, and only when the batch was the limit (M7)', async () => {
        // M7: `limit: "budget"` named WHICH governor cut a window but not what it was worth,
        // so "raise maxBytes" advice that changed nothing was unexplainable. Two receipts:
        // the result's `budgetPool` (bytes left to split after every reserve) and each
        // share-bound entry's `budgetGranted` (the exact allowance the scanner cut against).
        const paths = [0, 1, 2, 3].map((index) => join(workdir, 'many', `${index}.txt`));
        const shared = await read(paths);

        // Four files that all want more than the envelope holds: the water-filling pass opens
        // at an equal share and gets no surplus back, so the share IS floor(pool / 4) — the
        // arithmetic `budgetGranted` publishes.
        expect(shared.files.map((file) => file.limit)).toEqual(['budget', 'budget', 'budget', 'budget']);
        expect(shared.budgetPool).toBeLessThan(shared.contentBudget);
        expect(shared.files.map((file) => file.budgetGranted)).toEqual([
            Math.floor(shared.budgetPool / 4),
            Math.floor(shared.budgetPool / 4),
            Math.floor(shared.budgetPool / 4),
            Math.floor(shared.budgetPool / 4)
        ]);
        // Not decoration: on these single-line files the window ends exactly AT the grant, so
        // the number is the cap that bound it.
        expect(shared.files.map((file) => file.nextByte)).toEqual(shared.files.map((file) => file.budgetGranted));

        // The other half of the rule: a file bound by its OWN `maxBytes` — every file in a
        // one-path call, the common shape — keeps the entry it always had. A key that is not
        // true is not published at all.
        const own = (await read([{ path: join(workdir, 'giant.txt'), maxBytes: 10 }])).files[0];

        expect(own.limit).toBe('maxBytes');
        expect('budgetGranted' in own).toBe(false);
    });

    it('flags lossy only for bytes it replaced, not for a U+FFFD already in the file (EXTRA-3)', async () => {
        // EXTRA-3: the old test was `text.includes('\ufffd')`, which cannot tell a
        // replacement this tool made from a U+FFFD that is legitimately IN the file — a log
        // line that already held one was reported as if read had rewritten bytes. The
        // question that IS answerable is "would a STRICT decoder accept these same bytes?",
        // so a lossy read runs one over the identical stream (`noteTwin`).
        const native = await seed('lossy-native.txt', 'a\ufffdb\n');

        expect((await read([native])).files[0].content).toBe('a\ufffdb\n');
        // A strict read of valid UTF-8 publishes no flag at all...
        expect('lossy' in (await read([native])).files[0]).toBe(false);
        // ...and neither does a LOSSY read of it: nothing was substituted, whatever the
        // text happens to contain.
        const asked = (await read([{ path: native, lossy: true }])).files[0];

        expect(asked.content).toBe('a\ufffdb\n');
        expect('lossy' in asked).toBe(false);

        // The genuine case: `0xc3` starts a 2-byte sequence and `0x28` is not a continuation
        // byte, so one byte really is replaced — strict refuses, lossy substitutes and says.
        const broken = await seedBytes('lossy-invalid.bin', Buffer.from([0x61, 0xc3, 0x28, 0x0a]));

        expect((await read([broken])).files[0].error?.code).toBe('EBINARY');

        const replaced = (await read([{ path: broken, lossy: true }])).files[0];

        expect(replaced.content).toBe('a\ufffd(\n');
        expect(replaced.lossy).toBe(true);
        expect(replaced.bytes).toBe(6);
    });

    it('measures startColumn from the physical start of its line, whichever axis got there (H4)', async () => {
        // H4: `startColumn` is a byte offset into a PHYSICAL line, and `nextColumn` is
        // reported from that same base — so the pair this tool prints is the pair this tool
        // accepts. It used to be added to the SEEK instead, which started the window
        // `startColumn` bytes deeper than the line it was naming, and the documented
        // `{ startLine: nextLine, startColumn: nextColumn }` continuation re-read bytes.
        //
        // `cols.txt` is 'abcdef\nghijkl\n': line 1 starts at byte 0 and its terminator is
        // byte 6, so line 2 starts at byte 7. Every expected offset below is that arithmetic.
        const cols = join(workdir, 'columns-h4.txt');

        await seed('columns-h4.txt', 'abcdef\nghijkl\n');

        const table = [
            {
                // Line axis with a column: base 0 + 2 = byte 2, capped by `maxLines: 1`.
                request: { startLine: 1, startColumn: 2, maxLines: 1 },
                content: 'cdef\n',
                startLine: 1,
                bytes: 5,
                nextLine: 2,
                nextColumn: 0,
                nextByte: 7
            },
            {
                // THE defect. Seek 1 + column 2 measures from the line's physical start
                // (0 + 2 = byte 2), NOT from the seek (which gave byte 3, 'def\n'). The
                // window is identical to the row above — that is the point.
                request: { startByte: 1, startColumn: 2, maxLines: 1 },
                content: 'cdef\n',
                startLine: 1,
                bytes: 5,
                nextLine: 2,
                nextColumn: 0,
                nextByte: 7
            },
            {
                // A column past the terminator lands on the NEXT line, and the entry says
                // THAT line is the first one it returned (H5).
                request: { startLine: 1, startColumn: 7, maxLines: 1 },
                content: 'ghijkl\n',
                startLine: 2,
                bytes: 7,
                nextLine: null,
                nextColumn: null,
                nextByte: null
            },
            {
                // Seek 8 (the 'h' of line 2) + column 2: line 2 starts at 7, so the column
                // resolves to byte 9, ahead of the seek — and the seek's line is still the
                // counted one, 2, not the default 1.
                request: { startByte: 8, startColumn: 2, maxLines: 1 },
                content: 'ijkl\n',
                startLine: 2,
                bytes: 5,
                nextLine: null,
                nextColumn: null,
                nextByte: null
            },
            {
                // The `max` half: a column that resolves BEHIND the seek (0 + 1 = byte 1)
                // cannot pull the window back before the position the caller pinned.
                request: { startByte: 3, startColumn: 1, maxLines: 1 },
                content: 'def\n',
                startLine: 1,
                bytes: 4,
                nextLine: 2,
                nextColumn: 0,
                nextByte: 7
            }
        ];

        for (const row of table) {
            const entry = (await read([{ path: cols, ...row.request }])).files[0];

            expect([entry.content, entry.startLine, entry.bytes, entry.nextLine, entry.nextColumn, entry.nextByte]).toEqual([
                row.content,
                row.startLine,
                row.bytes,
                row.nextLine,
                row.nextColumn,
                row.nextByte
            ]);
        }

        // The continuation the whole rule exists for: page one line of any size by the pair
        // the previous entry printed, with no re-read and no `startByte` at all.
        const giant = join(workdir, 'giant.txt'); // 1000 x 'x', one line
        const first = (await read([{ path: giant, maxBytes: 100 }])).files[0];

        expect([first.bytes, first.nextLine, first.nextColumn, first.nextByte]).toEqual([100, 1, 100, 100]);

        const second = (await read([{ path: giant, startLine: 1, startColumn: 100, maxBytes: 100 }])).files[0];

        // Bytes 100..199, then the cursor for the next hop — the window ADVANCED.
        expect([second.bytes, second.nextLine, second.nextColumn, second.nextByte]).toEqual([100, 1, 200, 200]);
    });
});
