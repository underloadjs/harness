// grep — the content-search half of the old unified `fileGlob` (R2).
//
// `fileGlob` used to answer "which files match this NAME?" and "which LINES match
// this text?" from one entry, discriminated by whether the caller sent `content`.
// This file pins the line-level half under its own wire name; the name half lives in
// ./glob.test.ts. What has to stay true after the split:
//
//   - one shape, no mode switch: `{ matches, truncated, bytes, contentBudget }`, and
//     a REQUIRED `pattern` (an absent or empty pattern is an error, not "no matches");
//   - the schema declares exactly `pattern`, `patterns`, `paths`, `maxResults` — the
//     old `content` property is gone, so a stale request cannot silently mean
//     something else;
//   - the safety inherited from fileGlob's content mode: the same walker and skip
//     list (.git, node_modules, symlinks, binary, > 1 MiB), roots deduplicated by
//     real file identity, one GLOBAL 100-match cap, a 1 KiB snippet cap per match
//     (`textTruncated`), a 64 KiB aggregate budget (`truncated`), and the bounded
//     regex that stops a catastrophic pattern instead of hanging the process;
//   - argument rules (T16): a non-object argument is rejected rather than defaulted,
//     empty `patterns`/`paths` arrays are rejected rather than matching nothing, and
//     patterns are matched relative to EACH root (results are root-prefixed).
//
// The fixture tree is the process cwd for this file, so roots are relative and the
// results are the documented root-prefixed relative paths (the same presentation
// fileList uses: "." contributes no prefix). Fixtures live under the repo-root
// `Temp/`, one unique directory per run, removed afterwards.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FILE_GREP_CONTENT_BUDGET,
    FILE_GREP_MATCH_TEXT_BYTES,
    GREP_METADATA,
    grep
} from './grep.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;
// A directory symlink is privileged on Windows (Developer Mode or elevated); the
// alias assertions run only when the host let us create one.
let rootAlias: string | undefined;

const seed = async (relativePath: string, content = 'x\n'): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

beforeAll(async () => {
    previousCwd = process.cwd();
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-grep-'));
    process.chdir(workdir);

    // Never entered by the walker.
    await seed('.git/secret.ts', '// TODO: hidden\n');
    await seed('node_modules/pkg/index.js', '// TODO: ignored\n');

    // A NUL byte makes this "binary", so its TODO is never a match.
    await seed('binary.bin', 'TODO\u0000binary\n');

    // The searchable tree.
    await seed('docs/readme.md', 'TODO: four\n');
    await seed('src/a.ts', 'const x = 1;\n// TODO: one\n');
    await seed('src/b.ts', '// TODO: two\n');
    await seed('src/nested/c.js', 'TODO: three\n');
    await seed('src/nested/deep/d.ts', 'no match here\n');
    await seed('task/e.ts', '// TODO: five\n');
    await seed('root.txt', 'TODO: six\n');

    // The budget fixture: 31 bytes that make `(a+)+$` backtrack catastrophically.
    await seed('evil/line.txt', `${'a'.repeat(31)}b\n`);

    // Fixtures that use their own tokens, so the `TODO` expectations below stay the
    // documented six matches:
    //   - a 2000-character ASCII line (cut at 1024 bytes on a code-point boundary),
    //   - a line of 300 four-byte emoji (a naive UTF-16 slice would split a pair),
    //   - 70 lines of exactly 1024 bytes each: 64 fit the 64 KiB aggregate budget
    //     EXACTLY and the 65th proves truncation,
    //   - a CRLF file (line text must come back without the carriage return),
    //   - a file just over the 1 MiB read cap (never opened at all).
    await seed('huge/ascii.txt', `NEEDLE ${'a'.repeat(2000)}\n`);
    await seed('huge/emoji.txt', `NEEDLE ${'\u{1F600}'.repeat(300)}\n`);
    await seed('budget/lines.txt', `${`${'Q'.repeat(1024)}\n`.repeat(70)}`);
    await seed('eol/crlf.txt', 'CRNEEDLE one\r\nplain line\r\nCRNEEDLE two\r\n');
    await seed('eol/big.txt', `${'.'.repeat(1024 * 1024)}BIGNEEDLE\n`);

    try {
        await symlink(join(workdir, 'src'), join(workdir, 'src-alias'), 'dir');
        rootAlias = 'src-alias';
    } catch {
        rootAlias = undefined;
    }
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

describe('grep', () => {
    it('publishes the split-out tool with one required pattern and no content mode', () => {
        // R1/R2: new wire name, core visibility (it replaces fileGlob's content mode),
        // and a schema with exactly the four documented properties — `content` is gone.
        expect(GREP_METADATA.name).toBe('grep');
        expect(grep.name).toBe('grep');
        expect(GREP_METADATA.visibility).toBe('core');
        expect(GREP_METADATA.tags).toEqual(['files', 'grep', 'search', 'content', 'regex', 'filesystem']);

        expect(GREP_METADATA.parameters).toEqual({
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    minLength: 1,
                    description:
                        'JavaScript regular-expression source to match inside each file, e.g. "TODO|FIXME". No delimiters and no flags.'
                },
                patterns: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Glob patterns selecting which files to read, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"]. Defaults to ["**/*"].'
                },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Root directories to walk, absolute or relative to the working directory, in the order they are visited. Results are prefixed with the root that found them. Defaults to ["."].'
                },
                maxResults: {
                    type: 'number',
                    description:
                        'Maximum matching lines to return across all roots. Defaults to 100 and is clamped to 1-100.'
                }
            },
            required: ['pattern'],
            additionalProperties: false
        });

        // Beside glob (210) so the two search presets enumerate together, and NOT
        // session-bound, exactly like the tool it replaces.
        expect(GREP_METADATA.description).toContain('{ "matches": [...], "truncated": boolean');
        expect(GREP_METADATA.description).toContain('Does not read .gitignore files');
    });

    it('reports the byte budget it enforces as exported constants', () => {
        // The numbers a caller reads in the result must be the numbers the module
        // documents, so a host cannot quietly widen them.
        expect(FILE_GREP_MATCH_TEXT_BYTES).toBe(1024);
        expect(FILE_GREP_CONTENT_BUDGET).toBe(65536);
    });

    it('returns every non-skipped match in walk order', async () => {
        await expect(grep({ pattern: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 67,
            contentBudget: 65536
        });
    });

    it('restricts the content search to files matching the patterns', async () => {
        await expect(grep({ pattern: 'TODO', patterns: ['*.ts'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 37,
            contentBudget: 65536
        });
    });

    it('treats pattern as a JavaScript regular expression', async () => {
        await expect(grep({ pattern: 'TODO: (one|three)' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
            ],
            truncated: false,
            bytes: 23,
            contentBudget: 65536
        });
    });

    it('caps matches globally and flags truncation', async () => {
        await expect(grep({ pattern: 'TODO', maxResults: 2 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 }
            ],
            truncated: true,
            bytes: 19,
            contentBudget: 65536
        });
    });

    it('clamps maxResults to the hard cap without claiming truncation', async () => {
        // 6 matches exist; asking for 1_000 must not exceed the documented cap and
        // must not claim truncation when everything fits.
        await expect(grep({ pattern: 'TODO', maxResults: 1000 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 67,
            contentBudget: 65536
        });

        // A zero cap is clamped UP to one match (not "no matches"), and a non-number
        // cap falls back to the documented default of 100 rather than failing the call.
        await expect(grep({ pattern: 'TODO', maxResults: 0 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 }
            ],
            truncated: true,
            bytes: 10,
            contentBudget: 65536
        });
        await expect(grep({ pattern: 'TODO', maxResults: 'x' as never })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 67,
            contentBudget: 65536
        });
    });

    it('returns an empty match list when nothing matches', async () => {
        await expect(grep({ pattern: 'ZZZ' })).resolves.toEqual({
            matches: [],
            truncated: false,
            bytes: 0,
            contentBudget: 65536
        });
    });

    it('skips binary files and files over the size cap', async () => {
        // binary.bin really does contain "TODO" and eol/big.txt really does contain
        // BIGNEEDLE, so an empty result proves the skip rather than a bad pattern.
        await expect(grep({ pattern: 'TODO', patterns: ['*.bin'] })).resolves.toEqual({
            matches: [],
            truncated: false,
            bytes: 0,
            contentBudget: 65536
        });
        await expect(grep({ pattern: 'BIGNEEDLE', patterns: ['big.txt'] })).resolves.toEqual({
            matches: [],
            truncated: false,
            bytes: 0,
            contentBudget: 65536
        });

        // The same walker does read the neighbour in the same root, so the empties
        // above are the policy and not a broken root.
        await expect(grep({ pattern: 'CRNEEDLE', patterns: ['crlf.txt'] })).resolves.toEqual({
            matches: [
                { path: 'eol/crlf.txt', line: 1, text: 'CRNEEDLE one', textTruncated: false, bytes: 12 },
                { path: 'eol/crlf.txt', line: 3, text: 'CRNEEDLE two', textTruncated: false, bytes: 12 }
            ],
            truncated: false,
            bytes: 24,
            contentBudget: 65536
        });
    });

    it('reports CRLF lines without the carriage return', async () => {
        // Splitting on \n only would leave a trailing \r inside every `text`, which a
        // model would then quote back as part of the line.
        const result = await grep({ pattern: 'plain', paths: ['eol'] });

        expect(result.matches).toEqual([
            { path: 'eol/crlf.txt', line: 2, text: 'plain line', textTruncated: false, bytes: 10 }
        ]);
    });

    it('surfaces an invalid regular expression', async () => {
        await expect(grep({ pattern: '[' })).rejects.toThrow(SyntaxError);
    });

    it('requires a non-empty pattern instead of answering "no matches"', async () => {
        const message =
            'grep requires a non-empty "pattern" regular-expression string, e.g. {"pattern":"TODO"}.';

        await expect(grep({} as never)).rejects.toThrow(message);
        await expect(grep({ pattern: '' })).rejects.toThrow(message);
        await expect(grep({ pattern: 7 as never })).rejects.toThrow(message);

        // `null` and `undefined` are "no argument at all", so the property defaults
        // apply — and the one property with no default is the pattern.
        await expect(grep(undefined as never)).rejects.toThrow(message);
        await expect(grep(null as never)).rejects.toThrow(message);
    });

    it('rejects a non-object argument instead of defaulting to every file', async () => {
        // T16: a string or an array used to slip past the property reads and mean
        // "use every default". A wrong answer that looks complete is worse than an
        // error, so the shape is checked first.
        const message =
            'grep expects an object with "pattern" and optional "patterns", "paths", and "maxResults" properties, e.g. {"pattern":"TODO","patterns":["**/*.ts"]}.';

        await expect(grep('TODO' as never)).rejects.toThrow(message);
        await expect(grep(['TODO'] as never)).rejects.toThrow(message);
        await expect(grep(7 as never)).rejects.toThrow(message);
    });

    it('rejects an empty patterns or paths array instead of matching nothing', async () => {
        await expect(grep({ pattern: 'TODO', patterns: [] })).rejects.toThrow(
            'grep received an empty patterns array. Omit patterns to use the default ("**/*").'
        );
        await expect(grep({ pattern: 'TODO', paths: [] })).rejects.toThrow(
            'grep received an empty paths array. Omit paths to use the default (".").'
        );
    });

    it('rejects malformed pattern and path entries', async () => {
        await expect(grep({ pattern: 'TODO', patterns: [''] })).rejects.toThrow(
            'grep patterns must be non-empty strings.'
        );
        await expect(grep({ pattern: 'TODO', paths: [''] })).rejects.toThrow(
            'grep paths must be non-empty strings.'
        );
        await expect(grep({ pattern: 'TODO', patterns: ['a\u0000b'] })).rejects.toThrow(
            'grep patterns must not contain NUL characters.'
        );
        await expect(grep({ pattern: 'TODO', paths: ['a\u0000b'] })).rejects.toThrow(
            'grep paths must not contain NUL characters.'
        );
        await expect(grep({ pattern: 'TODO', patterns: 'x' } as never)).rejects.toThrow(
            'grep patterns must be an array of strings.'
        );
        await expect(grep({ pattern: 'TODO', paths: 'src' } as never)).rejects.toThrow(
            'grep paths must be an array of strings.'
        );
    });

    it('surfaces a missing search root', async () => {
        await expect(grep({ pattern: 'TODO', paths: ['absent'] })).rejects.toThrow(/ENOENT/);
    });

    it('reports paths relative to a nested root and deduplicates overlapping roots', async () => {
        // Root 'src' + '.' both reach src/a.ts. Every result is root-prefixed (the
        // same presentation fileList uses), and the FIRST root wins, so the file is
        // reported once as "src/a.ts" — never twice, and never "src/src/a.ts".
        await expect(grep({ pattern: 'TODO: one', paths: ['src', '.'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
            ],
            truncated: false,
            bytes: 12,
            contentBudget: 65536
        });

        // The same request rooted at "." alone produces the identical path, which is
        // what makes the dedupe invisible to a caller that lists one root.
        await expect(grep({ pattern: 'TODO: one', paths: ['.'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
            ],
            truncated: false,
            bytes: 12,
            contentBudget: 65536
        });

        // A pattern is matched against the path RELATIVE TO ITS ROOT, so "src/*.ts"
        // finds nothing when "src" is the root.
        await expect(grep({ pattern: 'TODO', paths: ['src'], patterns: ['src/*.ts'] })).resolves.toEqual({
            matches: [],
            truncated: false,
            bytes: 0,
            contentBudget: 65536
        });
    });

    it('stops a catastrophic pattern instead of hanging, with a clear error', async () => {
        // T16 regression: `(a+)+$` against 31 "a"s and a "b" used to block the whole
        // process for seconds. It now runs inside a vm with the documented cumulative
        // 30-second budget, so the call fails instead of freezing the harness.
        //
        // Waiting out the real default would exceed vitest's 15s per-test timeout, so
        // the clock is mocked to jump 30001ms per read: the matcher takes its deadline
        // from the first read, the second read is past it, and an exhausted deadline is
        // refused BEFORE any matching. That proves grep passes the DEFAULT budget
        // (30000ms), which is what the message names. Restricted to the one file, so no
        // other fixture is scanned before the stop.
        const now = vi.spyOn(Date, 'now');
        let tick = 0;

        try {
            now.mockImplementation(() => {
                tick += 1;
                return 1_000_000 + tick * 30_001;
            });

            await expect(grep({ pattern: '(a+)+$', patterns: ['line.txt'] })).rejects.toThrow(
                'grep pattern did not finish within its 30000ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.'
            );
        } finally {
            now.mockRestore();
        }
    });

    it('keeps ordinary content searches unaffected by the budget', async () => {
        // The same fixture set as before, with the vm-backed matcher: same matches,
        // same order, same line numbers.
        await expect(grep({ pattern: 'TODO', patterns: ['*.ts'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 37,
            contentBudget: 65536
        });
    });

    // R2: one match on a giant line used to copy the WHOLE line. The snippet cap
    // cuts it on a code-point boundary and says so per match.
    it('cuts a giant ASCII line to the 1 KiB snippet cap and flags it, keeping the line number', async () => {
        await expect(grep({ pattern: 'NEEDLE', patterns: ['ascii.txt'] })).resolves.toEqual({
            matches: [
                {
                    path: 'huge/ascii.txt',
                    line: 1,
                    // Exactly 1024 bytes: 7 for "NEEDLE " plus 1017 "a"s.
                    text: `NEEDLE ${'a'.repeat(1017)}`,
                    textTruncated: true,
                    bytes: 1024
                }
            ],
            truncated: false,
            bytes: 1024,
            contentBudget: 65536
        });
    });

    it('never splits a surrogate pair when cutting a giant non-ASCII line', async () => {
        // The fixture is "NEEDLE " (7 bytes) plus 300 four-byte emoji. 7 + 4 * 254 =
        // 1023 bytes fit; the 255th emoji would take it to 1027, so the cut lands
        // BEFORE it. A UTF-16 slice at 1024 units would have produced a lone
        // surrogate, i.e. a character that is not in the file.
        await expect(grep({ pattern: 'NEEDLE', patterns: ['emoji.txt'] })).resolves.toEqual({
            matches: [
                {
                    path: 'huge/emoji.txt',
                    line: 1,
                    text: `NEEDLE ${'\u{1F600}'.repeat(254)}`,
                    textTruncated: true,
                    bytes: 1023
                }
            ],
            truncated: false,
            bytes: 1023,
            contentBudget: 65536
        });
    });

    it('stops at the aggregate 64 KiB budget and reports truncation instead of dropping matches silently', async () => {
        // budget/lines.txt has 70 matching lines of exactly 1024 bytes. 64 matches
        // charge 64 * 1024 = 65536 bytes — the budget EXACTLY — so all 64 are
        // returned; the 65th match is the one that cannot fit, which is what makes
        // `truncated: true` a proven fact rather than a guess.
        const expectedBudgetMatches = Array.from({ length: 64 }, (_unused, index) => ({
            path: 'budget/lines.txt',
            line: index + 1,
            text: 'Q'.repeat(1024),
            textTruncated: false,
            bytes: 1024
        }));

        await expect(grep({ pattern: 'Q', patterns: ['lines.txt'] })).resolves.toEqual({
            matches: expectedBudgetMatches,
            truncated: true,
            bytes: 65536,
            contentBudget: 65536
        });
    });

    it('reports the cap independently of the byte budget', async () => {
        // 40 matches of 1024 bytes charge 40960 bytes, well inside the 64 KiB budget,
        // so `truncated: true` here can only come from the maxResults cap. The flag
        // means "a match that exists was withheld", whichever limit did it.
        const expectedCappedMatches = Array.from({ length: 40 }, (_unused, index) => ({
            path: 'budget/lines.txt',
            line: index + 1,
            text: 'Q'.repeat(1024),
            textTruncated: false,
            bytes: 1024
        }));

        await expect(
            grep({ pattern: 'Q', patterns: ['lines.txt'], maxResults: 40 })
        ).resolves.toEqual({
            matches: expectedCappedMatches,
            truncated: true,
            bytes: 40960,
            contentBudget: 65536
        });

        // A result that is genuinely complete says so: one 1 KiB snippet, nothing
        // withheld by the cap or the budget.
        await expect(grep({ pattern: 'NEEDLE', patterns: ['ascii.txt'] })).resolves.toEqual({
            matches: [
                {
                    path: 'huge/ascii.txt',
                    line: 1,
                    text: `NEEDLE ${'a'.repeat(1017)}`,
                    textTruncated: true,
                    bytes: 1024
                }
            ],
            truncated: false,
            bytes: 1024,
            contentBudget: 65536
        });
    });
});

// Two roots that are ONE directory must be searched once. Both cases are about file
// identity rather than spelling, which is what an old `resolve()`-based dedupe missed.
describe('grep - aliased roots', () => {
    it('searches a case-aliased root once on Windows and keeps it distinct on Linux', async () => {
        // NTFS is case-insensitive, so 'src' and 'SRC' are the same directory and a
        // second pass would report every match twice under a second prefix. Linux has
        // no 'SRC' at all, so that spelling is a missing root — asserted as its own
        // truth instead of being skipped.
        if (process.platform === 'win32') {
            await expect(grep({ pattern: 'TODO', paths: ['src', 'SRC'] })).resolves.toEqual({
                matches: [
                    { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                    { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                    {
                        path: 'src/nested/c.js',
                        line: 1,
                        text: 'TODO: three',
                        textTruncated: false,
                        bytes: 11
                    }
                ],
                truncated: false,
                bytes: 35,
                contentBudget: 65536
            });
            return;
        }

        await expect(grep({ pattern: 'TODO', paths: ['src', 'SRC'] })).rejects.toThrow(/ENOENT/);
    });

    it('searches a symlinked root once when the host allows symlinks', async () => {
        if (rootAlias === undefined) return;

        // 'src-alias' resolves to 'src', so the second root contributes only
        // duplicates. The first root wins the prefix, exactly like overlapping roots.
        await expect(grep({ pattern: 'TODO', paths: ['src', rootAlias] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                {
                    path: 'src/nested/c.js',
                    line: 1,
                    text: 'TODO: three',
                    textTruncated: false,
                    bytes: 11
                }
            ],
            truncated: false,
            bytes: 35,
            contentBudget: 65536
        });

        // Reverse order: the alias is walked first, so its prefix is the one kept.
        await expect(grep({ pattern: 'TODO', paths: [rootAlias, 'src'] })).resolves.toEqual({
            matches: [
                {
                    path: 'src-alias/a.ts',
                    line: 2,
                    text: '// TODO: one',
                    textTruncated: false,
                    bytes: 12
                },
                {
                    path: 'src-alias/b.ts',
                    line: 1,
                    text: '// TODO: two',
                    textTruncated: false,
                    bytes: 12
                },
                {
                    path: 'src-alias/nested/c.js',
                    line: 1,
                    text: 'TODO: three',
                    textTruncated: false,
                    bytes: 11
                }
            ],
            truncated: false,
            bytes: 35,
            contentBudget: 65536
        });
    });
});
