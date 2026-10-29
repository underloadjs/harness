// fileRead — the BOUNDED batched read contract.
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
//     truncation (`truncated`), and continuation (`nextLine`/`nextColumn`);
//   - defaults are 200 lines per file and a 64 KiB aggregate CONTENT budget split
//     fairly across files; a giant line is cut at a byte boundary and can be paged
//     through with `startColumn`;
//   - UTF-8 bytes (not UTF-16 code units) are counted, and CRLF/empty files keep
//     their exact text;
//   - a path that does not exist keeps its ordered slot as an entry with empty
//     content, 0 bytes, and a structured `error` (code ENOENT) — while a directory,
//     an invalid range, or binary content (NUL bytes or invalid UTF-8) still rejects
//     the WHOLE call.
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
import {
    fileRead,
    FILE_READ_CONTENT_BUDGET,
    FILE_READ_DEFAULT_MAX_LINES,
    FILE_READ_MAX_LINES,
    FILE_READ_MAX_TARGETS
} from './fileRead';

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

// The 201-line fixture is generated rather than pasted, but the assertions below
// still spell out the exact slice expected for each window.
const LINES_201 = Array.from({ length: 201 }, (_, index) => `line ${index + 1}\n`).join('');

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
    await seed('utf8.txt', 'héllo\n'); // 7 UTF-8 bytes, 6 code points
    await seed('lines.txt', LINES_201);

    // Giant single lines: one ASCII and one multibyte, so the byte-boundary rule
    // is proven rather than assumed.
    await seed('giant.txt', 'x'.repeat(70000));
    await seed('multibyte.txt', 'é'.repeat(40000)); // 2 bytes each = 80000 bytes

    // Continuation fixtures: the line after a cut must survive intact, in both
    // ASCII and multibyte form. The full file is reconstructed in the assertions.
    await seed('giant-multiline.txt', `${'x'.repeat(70000)}\nB\nC\n`);
    await seed('multibyte-multiline.txt', `${'é'.repeat(40000)}\nsecond\nthird\n`);
    await seed('offset.txt', 'abcdefghij\nsecond\nthird\n');

    // Aggregate-budget fixtures: four equal files split the 64 KiB cap exactly.
    await seed('many/0.txt', 'a'.repeat(40000));
    await seed('many/1.txt', 'a'.repeat(40000));
    await seed('many/2.txt', 'a'.repeat(40000));
    await seed('many/3.txt', 'a'.repeat(40000));

    // Binary fixtures: NUL bytes and bytes that are not valid UTF-8 (no NUL).
    await seedBytes('binary-nul.bin', Buffer.from([0x61, 0x00, 0x62]));
    await seedBytes('binary-invalid.bin', Buffer.from([0xc3, 0x28]));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('fileRead', () => {
    it('reads several files in one call, in the caller order', async () => {
        const result = await fileRead([join(workdir, 'b.txt'), join(workdir, 'a.txt')]);

        expect(result).toEqual({
            files: [
                {
                    path: join(workdir, 'b.txt'),
                    content: 'beta\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 5
                },
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 6
                }
            ],
            truncated: false,
            bytes: 11,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('resolves relative paths and reports the absolute path', async () => {
        const previous = process.cwd();
        process.chdir(workdir);

        try {
            await expect(fileRead(['a.txt', 'nested/c.txt'])).resolves.toEqual({
                files: [
                    {
                        path: resolve('a.txt'),
                        content: 'alpha\n',
                        startLine: 1,
                        endLine: 1,
                        truncated: false,
                        nextLine: null,
                        nextColumn: null,
                        bytes: 6
                    },
                    {
                        path: resolve('nested/c.txt'),
                        content: 'gamma',
                        startLine: 1,
                        endLine: 1,
                        truncated: false,
                        nextLine: null,
                        nextColumn: null,
                        bytes: 5
                    }
                ],
                truncated: false,
                bytes: 11,
                contentBudget: FILE_READ_CONTENT_BUDGET
            });
        } finally {
            process.chdir(previous);
        }
    });

    it('returns file text byte-for-byte, including CRLF and an empty file', async () => {
        await expect(fileRead([join(workdir, 'crlf.txt'), join(workdir, 'empty.txt')])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'crlf.txt'),
                    content: 'one\r\ntwo\r\n',
                    startLine: 1,
                    endLine: 2,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 10
                },
                {
                    path: join(workdir, 'empty.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0
                }
            ],
            truncated: false,
            bytes: 10,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('counts UTF-8 bytes, not UTF-16 code units', async () => {
        await expect(fileRead([join(workdir, 'utf8.txt')])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'utf8.txt'),
                    content: 'héllo\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    // h(1) é(2) l(1) l(1) o(1) \n(1) = 7 bytes, while the string
                    // length is 6 code units.
                    bytes: 7
                }
            ],
            truncated: false,
            bytes: 7,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('defaults to the first 200 lines and reports the next line', async () => {
        // The fixture has 201 lines: the default window is exactly the first 200,
        // and line 201 exists, so the window is explicitly truncated.
        const first200 = Array.from({ length: 200 }, (_, index) => `line ${index + 1}\n`).join('');
        const bytes = Buffer.byteLength(first200, 'utf8');

        await expect(fileRead([join(workdir, 'lines.txt')])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: first200,
                    startLine: 1,
                    endLine: 200,
                    truncated: true,
                    nextLine: 201,
                    nextColumn: 0,
                    bytes
                }
            ],
            truncated: true,
            bytes,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('applies an exact 1-based startLine/maxLines window', async () => {
        await expect(
            fileRead([{ path: join(workdir, 'lines.txt'), startLine: 50, maxLines: 3 }])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: 'line 50\nline 51\nline 52\n',
                    startLine: 50,
                    endLine: 52,
                    truncated: true,
                    nextLine: 53,
                    nextColumn: 0,
                    bytes: Buffer.byteLength('line 50\nline 51\nline 52\n', 'utf8')
                }
            ],
            truncated: true,
            bytes: Buffer.byteLength('line 50\nline 51\nline 52\n', 'utf8'),
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('does not truncate when the line window reaches EOF', async () => {
        await expect(
            fileRead([{ path: join(workdir, 'lines.txt'), startLine: 199, maxLines: 5 }])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: 'line 199\nline 200\nline 201\n',
                    startLine: 199,
                    endLine: 201,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: Buffer.byteLength('line 199\nline 200\nline 201\n', 'utf8')
                }
            ],
            truncated: false,
            bytes: Buffer.byteLength('line 199\nline 200\nline 201\n', 'utf8'),
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('returns an empty window, without truncation, when startLine is past EOF', async () => {
        await expect(
            fileRead([{ path: join(workdir, 'lines.txt'), startLine: 500 }])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: '',
                    startLine: 500,
                    endLine: 499,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0
                }
            ],
            truncated: false,
            bytes: 0,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('keeps CRLF exact inside a single-line window', async () => {
        await expect(
            fileRead([{ path: join(workdir, 'crlf.txt'), startLine: 2, maxLines: 1 }])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'crlf.txt'),
                    content: 'two\r\n',
                    startLine: 2,
                    endLine: 2,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 5
                }
            ],
            truncated: false,
            bytes: 5,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('applies startColumn only to the first line, never every line', async () => {
        // F1 regression: lineOffset resets at each newline. Without a lineNumber
        // guard the five-byte skip was reapplied to "second"/"third", dropping their
        // prefixes and silently losing data.
        await expect(
            fileRead([
                { path: join(workdir, 'offset.txt'), startLine: 1, startColumn: 5, maxLines: 5 }
            ])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'offset.txt'),
                    content: 'fghij\nsecond\nthird\n',
                    startLine: 1,
                    endLine: 3,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 19
                }
            ],
            truncated: false,
            bytes: 19,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('cuts a giant single line at the content budget and resumes at nextColumn', async () => {
        // One file gets the whole 64 KiB budget. The line is 70000 ASCII bytes, so
        // the first window is exactly 65536 bytes and points inside line 1.
        const first = await fileRead([join(workdir, 'giant.txt')]);

        expect(first).toEqual({
            files: [
                {
                    path: join(workdir, 'giant.txt'),
                    content: 'x'.repeat(FILE_READ_CONTENT_BUDGET),
                    startLine: 1,
                    endLine: 1,
                    truncated: true,
                    nextLine: 1,
                    nextColumn: FILE_READ_CONTENT_BUDGET,
                    bytes: FILE_READ_CONTENT_BUDGET
                }
            ],
            truncated: true,
            bytes: FILE_READ_CONTENT_BUDGET,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });

        // Resuming at the reported byte offset returns the remaining 4464 bytes and
        // reaches EOF, so there is no second continuation.
        await expect(
            fileRead([
                {
                    path: join(workdir, 'giant.txt'),
                    startLine: first.files[0].nextLine as number,
                    startColumn: first.files[0].nextColumn as number
                }
            ])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'giant.txt'),
                    content: 'x'.repeat(4464),
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 4464
                }
            ],
            truncated: false,
            bytes: 4464,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('cuts a multibyte giant line only at a whole code point', async () => {
        // 'é' is 2 UTF-8 bytes, so 32768 code points fill 65536 bytes exactly; the
        // continuation offset is a byte offset that still lands on a boundary.
        const first = await fileRead([join(workdir, 'multibyte.txt')]);

        expect(first).toEqual({
            files: [
                {
                    path: join(workdir, 'multibyte.txt'),
                    content: 'é'.repeat(32768),
                    startLine: 1,
                    endLine: 1,
                    truncated: true,
                    nextLine: 1,
                    nextColumn: 65536,
                    bytes: 65536
                }
            ],
            truncated: true,
            bytes: 65536,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });

        await expect(
            fileRead([
                {
                    path: join(workdir, 'multibyte.txt'),
                    startLine: 1,
                    startColumn: 65536
                }
            ])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'multibyte.txt'),
                    content: 'é'.repeat(7232), // 40000 - 32768 code points
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 14464
                }
            ],
            truncated: false,
            bytes: 14464,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('preserves every following line when a giant line is paged (ASCII)', async () => {
        const original = `${'x'.repeat(70000)}\nB\nC\n`;
        const first = await fileRead([join(workdir, 'giant-multiline.txt')]);

        expect(first.files[0]).toEqual({
            path: join(workdir, 'giant-multiline.txt'),
            content: 'x'.repeat(65536),
            startLine: 1,
            endLine: 1,
            truncated: true,
            nextLine: 1,
            nextColumn: 65536,
            bytes: 65536
        });

        const second = await fileRead([
            {
                path: join(workdir, 'giant-multiline.txt'),
                startLine: 1,
                startColumn: 65536
            }
        ]);

        expect(second).toEqual({
            files: [
                {
                    path: join(workdir, 'giant-multiline.txt'),
                    content: `${'x'.repeat(4464)}\nB\nC\n`,
                    startLine: 1,
                    endLine: 3,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 4469
                }
            ],
            truncated: false,
            bytes: 4469,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });

        // The two windows concatenate to the exact original: no omitted line and no
        // duplicated byte at the cut.
        expect(first.files[0].content + second.files[0].content).toBe(original);
    });

    it('preserves following lines and UTF-8 boundaries across a paged giant line', async () => {
        const original = `${'é'.repeat(40000)}\nsecond\nthird\n`;
        const first = await fileRead([join(workdir, 'multibyte-multiline.txt')]);

        expect(first.files[0]).toEqual({
            path: join(workdir, 'multibyte-multiline.txt'),
            content: 'é'.repeat(32768),
            startLine: 1,
            endLine: 1,
            truncated: true,
            nextLine: 1,
            nextColumn: 65536,
            bytes: 65536
        });

        const second = await fileRead([
            {
                path: join(workdir, 'multibyte-multiline.txt'),
                startLine: 1,
                startColumn: 65536
            }
        ]);

        expect(second).toEqual({
            files: [
                {
                    path: join(workdir, 'multibyte-multiline.txt'),
                    content: `${'é'.repeat(7232)}\nsecond\nthird\n`,
                    startLine: 1,
                    endLine: 3,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 14478
                }
            ],
            truncated: false,
            bytes: 14478,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });

        expect(first.files[0].content + second.files[0].content).toBe(original);
    });

    it('splits the aggregate budget fairly across files and marks the rest truncatable', async () => {
        // Four equally-sized files share 65536 bytes: 16384 each. Every entry is
        // cut mid-line, and the total is exactly the cap (no overshoot).
        const paths = [0, 1, 2, 3].map((index) => join(workdir, 'many', `${index}.txt`));

        const result = await fileRead(paths);

        expect(result).toEqual({
            files: paths.map((path) => ({
                path,
                content: 'a'.repeat(16384),
                startLine: 1,
                endLine: 1,
                truncated: true,
                nextLine: 1,
                nextColumn: 16384,
                bytes: 16384
            })),
            truncated: true,
            bytes: 65536,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('rejects NUL binary content and invalid UTF-8 instead of replacing bytes', async () => {
        await expect(fileRead([join(workdir, 'binary-nul.bin')])).rejects.toThrow(
            'fileRead refused "'
        );
        await expect(fileRead([join(workdir, 'binary-nul.bin')])).rejects.toThrow(/binary data/);

        await expect(fileRead([join(workdir, 'binary-invalid.bin')])).rejects.toThrow(/binary data/);

        // All-or-nothing: a readable text file before the binary one does not turn
        // the call into a partial answer.
        await expect(
            fileRead([join(workdir, 'a.txt'), join(workdir, 'binary-nul.bin')])
        ).rejects.toThrow(/binary data/);
    });

    it('keeps an ordered not-found entry for a missing path and reads the rest', async () => {
        // R1: a missing file is a RESULT, not a failed call. It keeps its ordered
        // slot with empty content, the empty-window range, 0 bytes, and a structured
        // ENOENT error, while both readable files are still returned in full.
        const missing = join(workdir, 'missing.txt');

        await expect(
            fileRead([join(workdir, 'a.txt'), missing, join(workdir, 'b.txt')])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 6
                },
                {
                    path: missing,
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0,
                    error: {
                        code: 'ENOENT',
                        message: `fileRead could not find "${missing}": no such file or directory (ENOENT).`
                    }
                },
                {
                    path: join(workdir, 'b.txt'),
                    content: 'beta\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 5
                }
            ],
            truncated: false,
            bytes: 11,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('reports every missing path, keeping the requested range as empty metadata', async () => {
        // An all-missing batch still succeeds: one entry per path, in order, each
        // with zero bytes, no continuation, and the requested startLine preserved so
        // `endLine` is the usual "nothing returned" value.
        const first = join(workdir, 'absent-1.txt');
        const second = join(workdir, 'absent-2.txt');

        await expect(fileRead([first, { path: second, startLine: 5, maxLines: 2 }])).resolves.toEqual(
            {
                files: [
                    {
                        path: first,
                        content: '',
                        startLine: 1,
                        endLine: 0,
                        truncated: false,
                        nextLine: null,
                        nextColumn: null,
                        bytes: 0,
                        error: {
                            code: 'ENOENT',
                            message: `fileRead could not find "${first}": no such file or directory (ENOENT).`
                        }
                    },
                    {
                        path: second,
                        content: '',
                        startLine: 5,
                        endLine: 4,
                        truncated: false,
                        nextLine: null,
                        nextColumn: null,
                        bytes: 0,
                        error: {
                            code: 'ENOENT',
                            message: `fileRead could not find "${second}": no such file or directory (ENOENT).`
                        }
                    }
                ],
                truncated: false,
                bytes: 0,
                contentBudget: FILE_READ_CONTENT_BUDGET
            }
        );
    });

    it('charges no content budget to a missing entry', async () => {
        // R1 budget rule: the 40 KB file used to split the 64 KiB cap with the
        // missing path (32 KB each), even though the missing entry can never spend
        // its share. The split now covers files that exist, so the whole file is
        // returned and the caller sees the same window as a one-file call.
        await expect(
            fileRead([join(workdir, 'many', '0.txt'), join(workdir, 'missing.txt')])
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'many', '0.txt'),
                    content: 'a'.repeat(40000),
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 40000
                },
                {
                    path: join(workdir, 'missing.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0,
                    error: {
                        code: 'ENOENT',
                        message: `fileRead could not find "${join(workdir, 'missing.txt')}": no such file or directory (ENOENT).`
                    }
                }
            ],
            truncated: false,
            bytes: 40000,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('rejects a directory path with the path in the message', async () => {
        // A directory read fails at the filesystem layer (EISDIR on POSIX, EPERM on
        // Windows), so the whole batch is rejected rather than returning directory
        // "content". The wrapper names the requested path, matching ENOENT.
        const directory = join(workdir, 'nested');

        await expect(fileRead([directory])).rejects.toThrow(`fileRead failed to read "${directory}":`);
    });

    it('rejects an empty array instead of answering "no files"', async () => {
        await expect(fileRead([])).rejects.toThrow(
            'fileRead received an empty paths array; pass at least one file path.'
        );
    });

    it('rejects a batch larger than the metadata cap', async () => {
        // 100 paths is the schema maxItems; the implementation enforces it too so
        // a direct call cannot return thousands of metadata entries.
        const tooMany = Array.from({ length: FILE_READ_MAX_TARGETS + 1 }, () =>
            join(workdir, 'a.txt')
        );

        await expect(fileRead(tooMany)).rejects.toThrow(
            `fileRead accepts at most ${FILE_READ_MAX_TARGETS} paths per call; received ${FILE_READ_MAX_TARGETS + 1}. Split the batch.`
        );
    });

    it('rejects blank, NUL, non-string, and non-array arguments', async () => {
        await expect(fileRead([''])).rejects.toThrow('fileRead paths must be non-empty strings.');
        await expect(fileRead([join(workdir, 'a.txt'), ''])).rejects.toThrow(
            'fileRead paths must be non-empty strings.'
        );
        await expect(fileRead(['a\u0000b'])).rejects.toThrow(
            'fileRead paths must not contain NUL characters.'
        );
        await expect(fileRead([7] as never)).rejects.toThrow(
            'fileRead paths must be strings or { path, startLine, startColumn, maxLines } objects.'
        );
        // A model that sends a bare string instead of an array is told the shape.
        await expect(fileRead('a.txt' as never)).rejects.toThrow(
            'fileRead expects an array of paths (strings or { path, startLine, startColumn, maxLines } objects), e.g. ["package.json"].'
        );
        // An object without a usable path is rejected with the path guidance.
        await expect(fileRead([{ path: '' }])).rejects.toThrow(
            'fileRead paths must be non-empty strings.'
        );
        await expect(fileRead([{ path: 7 } as never])).rejects.toThrow(
            'fileRead paths must be non-empty strings.'
        );
    });

    it('rejects invalid range values instead of silently clamping', async () => {
        await expect(fileRead([{ path: join(workdir, 'a.txt'), startLine: 0 }])).rejects.toThrow(
            'fileRead startLine must be an integer between 1 and 9007199254740991; received 0.'
        );
        await expect(fileRead([{ path: join(workdir, 'a.txt'), startLine: 1.5 }])).rejects.toThrow(
            'fileRead startLine must be an integer between 1 and 9007199254740991; received 1.5.'
        );
        await expect(fileRead([{ path: join(workdir, 'a.txt'), startColumn: -1 }])).rejects.toThrow(
            'fileRead startColumn must be an integer between 0 and 9007199254740991; received -1.'
        );
        await expect(fileRead([{ path: join(workdir, 'a.txt'), maxLines: 0 }])).rejects.toThrow(
            `fileRead maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}; received 0.`
        );
        await expect(
            fileRead([{ path: join(workdir, 'a.txt'), maxLines: FILE_READ_MAX_LINES + 1 }])
        ).rejects.toThrow(
            `fileRead maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}; received ${FILE_READ_MAX_LINES + 1}.`
        );
    });

    it('accepts an object target with only a path, using the defaults', async () => {
        await expect(fileRead([{ path: join(workdir, 'a.txt') }])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'a.txt'),
                    content: 'alpha\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 6
                }
            ],
            truncated: false,
            bytes: 6,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('declares a single "paths" array property whose items are strings or ranges', () => {
        expect(fileRead.parameters).toEqual({
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
                                    maxLines: {
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: 5000,
                                        description:
                                            'Maximum lines to return. Defaults to 200 and is capped at 5000.'
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
        expect(toolParameterKey(fileRead.parameters)).toBe('paths');
    });

    it('publishes the documented default and hard caps', () => {
        expect(FILE_READ_DEFAULT_MAX_LINES).toBe(200);
        expect(FILE_READ_MAX_LINES).toBe(5000);
        expect(FILE_READ_CONTENT_BUDGET).toBe(65536);
        expect(FILE_READ_MAX_TARGETS).toBe(100);
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        await expect(
            fileRead.execute({
                parameters: [{ path: join(workdir, 'lines.txt'), startLine: 2, maxLines: 1 }]
            })
        ).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'lines.txt'),
                    content: 'line 2\n',
                    startLine: 2,
                    endLine: 2,
                    truncated: true,
                    nextLine: 3,
                    nextColumn: 0,
                    bytes: 7
                }
            ],
            truncated: true,
            bytes: 7,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });
});
