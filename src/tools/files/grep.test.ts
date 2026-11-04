// grep — the content-search half of the old unified `fileGlob` (R2), plus the four
// things this revision had to get right: honest coverage, paging, survey output, and a
// budget that blames the right thing.
//
// What stays pinned from the split (./glob.test.ts holds the name half):
//
//   - one shape, no mode switch, and a REQUIRED `pattern` (an absent or empty pattern
//     is an error, not "no matches");
//   - the safety inherited from fileGlob's content mode: the same walker and skip list
//     (.git, node_modules, symlinks, binary, > 1 MiB), roots deduplicated by real file
//     identity, one GLOBAL cap, a 1 KiB snippet cap per match (`textTruncated`), a
//     64 KiB aggregate budget (`truncated`), and the bounded regex that stops a
//     catastrophic pattern instead of hanging the process;
//   - argument rules: a non-object argument is rejected rather than defaulted, empty
//     `patterns`/`paths` arrays are rejected rather than matching nothing, and patterns
//     are matched relative to EACH root (results are root-prefixed);
//   - `.gitignore` files AT OR BELOW the root are honored (./gitignore.ts): an ignored
//     path is never listed and never opened, while a root the caller NAMES is still
//     walked because the ignore file above it is out of scope. The `MARK` fixtures at
//     the bottom of this file pin both halves of that rule.
//
// What is NEW here, and is the point of the revision:
//
//   - `skipped` / `excluded` / `searched` / `partial` / `note`: an empty result is
//     distinguishable from a withheld one. The `*.bin` and `big.txt` cases used to
//     answer `{ matches: [], truncated: false }` for files that DO contain the pattern
//     and were never opened; they now say so with a count.
//   - `offset`/`limit`/`nextOffset`/`stopReason`: a capped search is resumable, and the
//     effective cap is echoed instead of silently floored.
//   - `output: 'files' | 'count'` and `context`: the survey and understand-a-hit
//     questions that used to cost a round trip each.
//   - `flags`: `(?i)foo` is a JavaScript "Invalid group", so case-insensitive matching
//     needs a parameter rather than a flag the source cannot carry.
//   - `{a,b}` expansion and `!` exclusion in `patterns`, both of which used to answer
//     "no matches" to a request that meant something else.
//   - a FILE as a root, and a root error that names the fix instead of `ENOTDIR …
//     scandir`.
//   - the budget split: a big tree is a PARTIAL RESULT, an expensive pattern is an
//     ERROR. The old test mocked `Date.now` to jump 30,001ms per read and thereby PINNED
//     the bug (I/O charging a matching budget); that test is gone, and the accounting it
//     got wrong is pinned in ./bounded-regex.test.ts.
//
// The fixture tree is the process cwd for this file, so roots are relative and the
// results are the documented root-prefixed relative paths (the same presentation
// fileList uses: "." contributes no prefix). Fixtures live under the repo-root
// `Temp/`, one unique directory per run, removed afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../../util';
import { MODEL_TOOL_RESULT_BUDGET_BYTES, boundToolResult } from '../../core/result-budget';
import {
    DEFAULT_GREP_LIMITS,
    FILE_GREP_CONTENT_BUDGET,
    FILE_GREP_MATCH_TEXT_BYTES,
    GREP_METADATA,
    GREP_OUTPUTS,
    MAX_GREP_CONTEXT_LINES,
    MAX_SEARCH_MILLIS,
    grep,
    searchContents
} from './grep.tool';
import { compilePatterns } from './search';

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

    // The `.gitignore` fixtures, on their own `MARK` token so none of the `TODO`
    // expectations above move. Rules cover every interesting shape at once: a
    // directory-only rule (`dist/`), an anchored directory rule (`/Temp/`), a
    // depth-free extension rule (`*.log`) with its negation (`!keep.log`), and the
    // name that is also on the walker's skip list (`node_modules/`).
    await seed('.gitignore', 'dist/\n/Temp/\n*.log\n!keep.log\nnode_modules/\n');

    // The two files that survive every rule: a plain one and a negated one.
    await seed('notes.ts', 'MARK source\n');
    await seed('keep.log', 'MARK kept-log\n');

    // Reached by the walk, then skipped by grep's own binary policy rather than by an
    // ignore rule — the exact control for `dist/binary.ts` below.
    await seed('binary.ts', 'MARK binary\u0000\n');

    // Each of these is `MARK`-bearing and only reachable through a named root.
    await seed('dist/hidden.ts', 'MARK dist\n');
    await seed('Temp/scratch.ts', 'MARK scratch\n');
    await seed('a.log', 'MARK ignored-log\n');
    await seed('node_modules/pkg/i.js', 'MARK dep\n');

    // `dist/binary.ts` is deliberately tiny (the 1 MiB read cap can therefore never
    // explain its absence) and byte-identical to the non-ignored sibling above, so the
    // ONLY difference between the two is the `dist/` rule. `dist/huge.ts` crosses the
    // 1 MiB cap on purpose as well: an ignored oversized file must cost nothing.
    await seed('dist/binary.ts', 'MARK binary\u0000\n');
    await seed('dist/huge.ts', `MARK ${'h'.repeat(1024 * 1024)}\n`);

    // A directory whose every file crosses the 1 MiB read cap, so a search rooted there
    // only ever `continue`s. That is the shape that proves the wall-clock check is not
    // placed after the skip branches: a budget that expires while every candidate is being
    // skipped must still stop the walk, not run it to the end of the tree.
    for (let index = 0; index < 4; index++) {
        await seed(`skips/oversized-${index}.txt`, `${'.'.repeat(1024 * 1024)}OVER${index}\n`);
    }

    // Fixtures for the new arguments, each on its own token so nothing above moves:
    //   - brace expansion (`ui/App.tsx` must be reachable through `**/*.{ts,tsx}`),
    //   - `context` lines (a three-line file whose middle line is the hit),
    //   - `count` output (a file with several hits on separate lines).
    await seed('ui/App.tsx', 'export const NEEDLE = 1;\n');
    await seed('ctx/around.ts', 'first line\nHAYSTACK here\nlast line\n');
    // A minified neighbour, so `context` can be shown cutting a giant line. Seeded HERE
    // rather than inside the test: the coverage counts asserted below are absolute, and
    // a file created by one test and counted by a later one makes those numbers depend
    // on test order.
    await seed('ctx/minified.ts', `x${'y'.repeat(3000)}\nHAYSTACK here\nz${'w'.repeat(3000)}\n`);
    await seed('many/repeats.ts', 'REPEAT a\nnope\nREPEAT b\nREPEAT c\n');
    // A brace in a real file name, for the "a group with no comma stays literal" case.
    await seed('brace/{solo}.ts', 'BRACE literal\n');

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

// The paging/bound window of a result, extracted so a test asserts the interesting
// matches exactly and the arithmetic that closed the window exactly, without repeating
// the coverage counters (which have their own focused assertions below).
const windowOf = (result: Awaited<ReturnType<typeof grep>>) => ({
    output: result.output,
    truncated: result.truncated,
    offset: result.offset,
    limit: result.limit,
    nextOffset: result.nextOffset,
    bytes: result.bytes,
    contentBudget: result.contentBudget,
    partial: result.partial,
    stopReason: result.stopReason,
    patterns: result.patterns
});

describe('grep', () => {
    it('publishes the split-out tool with one required pattern and no content mode', () => {
        // R1/R2: new wire name, core visibility (it replaces fileGlob's content mode),
        // and a schema whose only required property is `pattern` — `content` is gone.
        expect(GREP_METADATA.name).toBe('grep');
        expect(grep.name).toBe('grep');
        expect(GREP_METADATA.visibility).toBe('core');
        expect(GREP_METADATA.tags).toEqual(['files', 'grep', 'search', 'content', 'regex', 'filesystem']);

        expect(Object.keys(GREP_METADATA.parameters.properties ?? {})).toEqual([
            'pattern',
            'patterns',
            'paths',
            'maxResults',
            'offset',
            'flags',
            'output',
            'context'
        ]);
        expect(GREP_METADATA.parameters.required).toEqual(['pattern']);
        expect(GREP_METADATA.parameters.additionalProperties).toBe(false);

        // The three verdicts are an enum, so a caller cannot invent a fourth and get a
        // silently defaulted `content` answer.
        expect(GREP_METADATA.parameters.properties?.output).toMatchObject({
            enum: [...GREP_OUTPUTS]
        });
        expect(GREP_METADATA.parameters.properties?.context).toMatchObject({
            minimum: 0,
            maximum: MAX_GREP_CONTEXT_LINES
        });

        // The published shape, pinned verbatim: the model reads this sentence to know
        // which fields exist.
        expect(GREP_METADATA.description).toContain(
            '{ "matches": [...], "truncated": boolean, "bytes": number, "contentBudget": number'
        );
        expect(GREP_METADATA.description).toContain('Each hit is { path, line, text, textTruncated, bytes }');

        // The honesty contract, in the description as well as in the result.
        expect(GREP_METADATA.description).toContain('Nothing is silently dropped');
        expect(GREP_METADATA.description).toContain('Reads .gitignore files at or below each root');
        expect(GREP_METADATA.description).not.toContain('Does not read .gitignore files');
        expect(GREP_METADATA.description).toContain('Does not list file names (use glob for that).');

        // The two time bounds are published as two different outcomes, which is the
        // whole point of the split.
        expect(GREP_METADATA.description).toContain('30s of regex execution throws');
        expect(GREP_METADATA.description).toContain('stopReason "searchBudget"');
    });

    it('reports the byte budget it enforces as exported constants', () => {
        // The numbers a caller reads in the result must be the numbers the module
        // documents, so a host cannot quietly widen them.
        expect(FILE_GREP_MATCH_TEXT_BYTES).toBe(1024);
        expect(FILE_GREP_CONTENT_BUDGET).toBe(65536);
        expect(MAX_SEARCH_MILLIS).toBe(30_000);
    });

    it('returns every non-skipped match in walk order', async () => {
        const result = await grep({ pattern: 'TODO' });

        expect(result.matches).toEqual([
            { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
            { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
            { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
        ]);

        expect(windowOf(result)).toEqual({
            output: 'content',
            truncated: false,
            offset: 0,
            limit: 100,
            nextOffset: null,
            bytes: 67,
            contentBudget: 65536,
            partial: false,
            stopReason: 'complete',
            patterns: ['**/*']
        });
    });

    it('counts what it searched and what it skipped, so an empty result is explainable', async () => {
        // Defect 2. The walk yields 27 candidates; seven are never searched — two binary
        // and five over the 1 MiB cap (eol/big.txt plus the four in skips/) — and the rest
        // of what is missing is accounted for by the ignore rules and the name skip list.
        // Every one of those reasons used to be invisible: `matches: []` was the whole
        // story. Every fixture is seeded in `beforeAll`, so these absolute counts cannot
        // drift with test order.
        const result = await grep({ pattern: 'TODO' });

        expect(result.searched).toEqual({ inScope: 27, scanned: 20, roots: 1 });
        expect(result.skipped).toEqual({ tooLarge: 5, binary: 2, unreadable: 0 });
        expect(result.excluded).toEqual({
            ignoredFiles: 1, // a.log, by `*.log`
            prunedDirectories: 3, // dist/, Temp/, node_modules/
            skippedDirectories: 1, // .git, by name
            unreadableDirectories: 0,
            // The src-alias symlink, when this host let us create one (a directory
            // symlink needs Developer Mode or elevation on Windows).
            symlinks: rootAlias === undefined ? 0 : 1,
            // Only the root owns a .gitignore, so exactly one file was parsed. The count
            // is files READ, not directories visited: a repo-wide walk used to report
            // hundreds of "no such file" probes as if they were rule sources.
            ignoreFilesParsed: 1,
            ignoreRulesTruncated: false
        });

        // The note names the two things a caller would otherwise conclude "not present".
        expect(result.note).toContain('5 file(s) larger than 1048576 bytes were not searched');
        expect(result.note).toContain('2 binary file(s) were not searched');
        expect(result.note).toContain('excluded by .gitignore rules');
    });

    it('restricts the content search to files matching the patterns', async () => {
        const result = await grep({ pattern: 'TODO', patterns: ['*.ts'] });

        expect(result.matches).toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
        ]);
        expect(windowOf(result)).toMatchObject({ bytes: 37, truncated: false, patterns: ['*.ts'] });
    });

    it('treats pattern as a JavaScript regular expression', async () => {
        await expect(grep({ pattern: 'TODO: (one|three)' }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
        ]);
    });

    it('caps matches globally and flags truncation', async () => {
        const result = await grep({ pattern: 'TODO', maxResults: 2 });

        expect(result.matches).toEqual([
            { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
            { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 }
        ]);
        expect(windowOf(result)).toMatchObject({
            truncated: true,
            limit: 2,
            nextOffset: 2,
            bytes: 19,
            stopReason: 'resultCap'
        });
    });

    it('echoes the effective cap instead of silently flooring a larger request', async () => {
        // Defect 3. `maxResults: 500` used to answer with 100 and never say the cap was
        // 100; the hard cap is now 1000 (the number fileList settled on) and `limit`
        // reports what was actually applied.
        const result = await grep({ pattern: 'TODO', maxResults: 5000 });

        expect(result.matches).toHaveLength(6);
        expect(windowOf(result)).toMatchObject({
            limit: 1000,
            truncated: false,
            nextOffset: null,
            stopReason: 'complete'
        });

        // A zero cap is clamped UP to one match (not "no matches"), and a non-number
        // cap falls back to the documented default of 100 rather than failing the call.
        await expect(grep({ pattern: 'TODO', maxResults: 0 }).then((r) => r.limit)).resolves.toBe(1);
        await expect(grep({ pattern: 'TODO', maxResults: 'x' as never }).then((r) => r.limit)).resolves.toBe(100);
    });

    it('pages a capped search with offset and nextOffset', async () => {
        // Defect 3. The walk is a deterministic prefix, so paging is well defined: page 1
        // + page 2 is exactly the unpaged answer, with no duplicate and no gap.
        const all = await grep({ pattern: 'TODO' });
        const first = await grep({ pattern: 'TODO', maxResults: 2 });
        const second = await grep({ pattern: 'TODO', maxResults: 2, offset: first.nextOffset as number });

        expect(first.nextOffset).toBe(2);
        expect(second.nextOffset).toBe(4);
        expect(second.offset).toBe(2);

        const paged = [...first.matches, ...second.matches];
        const third = await grep({ pattern: 'TODO', maxResults: 2, offset: second.nextOffset as number });

        expect(third.nextOffset).toBeNull();
        expect([...paged, ...third.matches]).toEqual(all.matches);
    });

    it('returns an empty match list when nothing matches, and says what was searched', async () => {
        const result = await grep({ pattern: 'ZZZ' });

        // The old answer was indistinguishable from "the tree is empty": now the counts
        // say 19 files were opened and scanned and none matched.
        expect(result.matches).toEqual([]);
        expect(result.searched.scanned).toBe(20);
        expect(result.stopReason).toBe('complete');
        expect(result.truncated).toBe(false);
        expect(result.partial).toBe(false);
    });

    it('reports the files it refused to search instead of returning a bare empty list', async () => {
        // THE Defect-2 repro, in miniature: binary.bin really does contain "TODO" and
        // eol/big.txt really does contain BIGNEEDLE, and both used to produce
        // `{ matches: [], truncated: false }` — the same answer a genuinely absent
        // pattern gives. Each now carries the count that explains it.
        const binary = await grep({ pattern: 'TODO', patterns: ['*.bin'] });

        expect(binary.matches).toEqual([]);
        expect(binary.truncated).toBe(false);
        expect(binary.skipped).toEqual({ tooLarge: 0, binary: 1, unreadable: 0 });
        expect(binary.note).toContain('1 binary file(s) were not searched');

        const oversized = await grep({ pattern: 'BIGNEEDLE', patterns: ['big.txt'] });

        expect(oversized.matches).toEqual([]);
        expect(oversized.truncated).toBe(false);
        expect(oversized.skipped).toEqual({ tooLarge: 1, binary: 0, unreadable: 0 });
        expect(oversized.note).toContain('1 file(s) larger than 1048576 bytes were not searched');

        // The same walker does read the neighbour in the same root, so the empties
        // above are the policy and not a broken root.
        await expect(grep({ pattern: 'CRNEEDLE', patterns: ['crlf.txt'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'eol/crlf.txt', line: 1, text: 'CRNEEDLE one', textTruncated: false, bytes: 12 },
            { path: 'eol/crlf.txt', line: 3, text: 'CRNEEDLE two', textTruncated: false, bytes: 12 }
        ]);
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
            'grep expects an object with "pattern" and optional "patterns", "paths", "maxResults", "offset", "flags", "output", and "context" properties, e.g. {"pattern":"TODO","patterns":["**/*.ts"]}.';

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

    it('reports a missing search root with a HarnessError that names the fix', async () => {
        // Defect 5. This used to be `ENOENT: no such file or directory, scandir 'D:\…'`:
        // true, but it named neither the argument the caller got wrong nor what to do
        // about it, and it leaked an absolute path the caller never typed.
        const error = await grep({ pattern: 'TODO', paths: ['absent'] }).then(
            () => undefined,
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(HarnessError);
        expect((error as Error).message).toContain('grep path "absent" does not exist');
        expect((error as Error).message).toContain('check the spelling');
        // The OS string is kept as the cause for debugging, not shown to the model.
        expect((error as { cause?: { code?: string } }).cause?.code).toBe('ENOENT');
    });

    it('searches a single file given as a root', async () => {
        // Defect 5, the other half: "search this file" is the most natural grep call
        // there is, and it used to fail with `ENOTDIR … scandir` while read and edit
        // accept files everywhere.
        const result = await grep({ pattern: 'TODO: one', paths: ['src/a.ts'] });

        expect(result.matches).toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
        ]);
        expect(result.searched).toEqual({ inScope: 1, scanned: 1, roots: 1 });
        expect(result.partial).toBe(false);

        // An absolute spelling works too, and is presented exactly as the caller wrote it
        // (posix separators, no re-rooting), which is what makes the path usable.
        const absolute = await grep({ pattern: 'TODO: one', paths: [join(process.cwd(), 'src', 'a.ts')] });

        expect(absolute.matches).toHaveLength(1);
        expect(absolute.matches[0]).toMatchObject({
            path: join(process.cwd(), 'src', 'a.ts').split('\\').join('/'),
            line: 2
        });

        // A path whose PARENT is a file is a different mistake, and gets its own message:
        // "does not exist" would send the caller to a spelling check that finds nothing.
        const nested = await grep({ pattern: 'TODO', paths: ['src/a.ts/deeper'] }).then(
            () => undefined,
            (caught: unknown) => caught
        );

        expect(nested).toBeInstanceOf(HarnessError);
        expect((nested as Error).message).toMatch(/is not a directory|does not exist/);
    });

    it('still applies the pattern filter to a file root, and says so', async () => {
        // `paths: ['src/a.ts'], patterns: ['*.md']` is a contradiction, not a match. The
        // answer is empty, but `inScope` proves the file WAS in scope while `scanned`
        // proves its contents were never opened — the two numbers separate "filtered out"
        // from "searched and did not match", which one number cannot.
        const result = await grep({ pattern: 'TODO', paths: ['src/a.ts'], patterns: ['*.md'] });

        expect(result.matches).toEqual([]);
        expect(result.searched).toEqual({ inScope: 1, scanned: 0, roots: 1 });
    });

    it('reports paths relative to a nested root and deduplicates overlapping roots', async () => {
        // Root 'src' + '.' both reach src/a.ts. Every result is root-prefixed (the
        // same presentation fileList uses), and the FIRST root wins, so the file is
        // reported once as "src/a.ts" — never twice, and never "src/src/a.ts".
        await expect(grep({ pattern: 'TODO: one', paths: ['src', '.'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
        ]);

        // The same request rooted at "." alone produces the identical path, which is
        // what makes the dedupe invisible to a caller that lists one root.
        await expect(grep({ pattern: 'TODO: one', paths: ['.'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
        ]);

        // A pattern is matched against the path RELATIVE TO ITS ROOT, so "src/*.ts"
        // finds nothing when "src" is the root.
        const relative = await grep({ pattern: 'TODO', paths: ['src'], patterns: ['src/*.ts'] });

        expect(relative.matches).toEqual([]);
        // Four files were in scope and none were opened: the empty answer is the pattern
        // spelling, not an empty directory, and the two numbers say so.
        expect(relative.searched).toEqual({ inScope: 4, scanned: 0, roots: 1 });
    });

    it('expands brace alternatives instead of matching them literally', async () => {
        // Defect 4. `**/*.{ts,tsx}` used to answer `[]` with `truncated: false`, which
        // reads as "there are no such files": `ui/App.tsx` exists. The expansion is
        // echoed in `patterns` so a caller can see what was actually matched.
        const result = await grep({ pattern: 'NEEDLE', patterns: ['**/*.{ts,tsx}'] });

        expect(result.matches).toEqual([
            { path: 'ui/App.tsx', line: 1, text: 'export const NEEDLE = 1;', textTruncated: false, bytes: 24 }
        ]);
        expect(result.patterns).toEqual(['**/*.ts', '**/*.tsx']);

        // The alternative list is a real union: a `.tsx`-only pattern finds the same file.
        await expect(grep({ pattern: 'NEEDLE', patterns: ['**/*.tsx'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'ui/App.tsx', line: 1, text: 'export const NEEDLE = 1;', textTruncated: false, bytes: 24 }
        ]);

        // A brace group with no comma is not a choice, so it stays LITERAL rather than
        // matching nothing (git reads `{a}` the same way). The braces are regex-escaped by
        // the compiler, so a file actually named `{solo}.ts` is still reachable.
        const literal = await grep({ pattern: 'BRACE', paths: ['brace'], patterns: ['{solo}.ts'] });

        expect(literal.matches).toEqual([
            { path: 'brace/{solo}.ts', line: 1, text: 'BRACE literal', textTruncated: false, bytes: 13 }
        ]);
        expect(literal.patterns).toEqual(['{solo}.ts']);
    });

    it('excludes with a leading ! and treats a list of only ! as "everything except"', async () => {
        // Defect 4. `['**/*', '!**/*.test.ts']` used to RETURN the test files (no
        // negation support), and `['!**/*.ts']` used to return `[]` (an empty inclusion
        // list). Both were wrong answers that looked right.
        const excluded = await grep({ pattern: 'TODO', patterns: ['**/*', '!*.ts'] });

        expect(excluded.matches).toEqual([
            { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
            { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
            { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
        ]);
        expect(excluded.patterns).toEqual(['**/*', '!*.ts']);

        // Only negations: everything that is not a .ts file, which is the same answer as
        // the explicit inclusion above — the rule a caller assumes from .gitignore.
        const onlyNegated = await grep({ pattern: 'TODO', patterns: ['!*.ts'] });

        expect(onlyNegated.matches).toEqual(excluded.matches);
    });

    it('matches case-insensitively with flags, and rejects the (?i) spelling it cannot use', async () => {
        // Defect 4. Every agent trained on ripgrep writes `(?i)todo` first, and in
        // JavaScript that is a SyntaxError ("Invalid group") — an error that does not
        // mention the option that would have worked.
        await expect(grep({ pattern: 'todo', patterns: ['*.ts'] }).then((r) => r.matches)).resolves.toEqual([]);

        const insensitive = await grep({ pattern: 'todo', patterns: ['*.ts'], flags: 'i' });

        expect(insensitive.matches).toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
        ]);
        expect(insensitive.patterns).toEqual(['*.ts']);

        await expect(grep({ pattern: '(?i)todo' })).rejects.toThrow(/Invalid group/);
        await expect(grep({ pattern: 'todo', flags: 'z' })).rejects.toThrow(
            'grep flags accepts only the JavaScript flag letters "dgimsuyv" ("i" for case-insensitive is the usual one); got "z".'
        );
        await expect(grep({ pattern: 'todo', flags: 1 as never })).rejects.toThrow(
            'grep flags must be a string of JavaScript flag letters, e.g. "i".'
        );
    });

    it('answers "which files?" with one entry per file, and "how many?" with a count', async () => {
        // Defect 4. A survey question used to cost 7+ calls because the 100-match cap was
        // eaten by the hits in the first file. `files` and `count` answer it once.
        const files = await grep({ pattern: 'TODO', output: 'files' });

        expect(files.matches).toEqual([
            { path: 'docs/readme.md', matchCount: null },
            { path: 'root.txt', matchCount: null },
            { path: 'src/a.ts', matchCount: null },
            { path: 'src/b.ts', matchCount: null },
            { path: 'src/nested/c.js', matchCount: null },
            { path: 'task/e.ts', matchCount: null }
        ]);
        // 14+8+8+8+15+9 bytes of path text.
        expect(windowOf(files)).toMatchObject({ output: 'files', bytes: 62, truncated: false });

        const counted = await grep({ pattern: 'REPEAT', paths: ['many'], output: 'count' });

        expect(counted.matches).toEqual([{ path: 'many/repeats.ts', matchCount: 3 }]);
        expect(counted.bytes).toBe('many/repeats.ts'.length);

        // `null` in files mode is deliberate: the scan stopped at the first match, so the
        // number was not counted and must not look like 1.
        const oneFile = await grep({ pattern: 'REPEAT', paths: ['many'], output: 'files' });

        expect(oneFile.matches).toEqual([{ path: 'many/repeats.ts', matchCount: null }]);

        // A rejected `output` is an error, not a silent fallback to `content`: the shape
        // of the answer is what the caller asked for.
        await expect(grep({ pattern: 'TODO', output: 'names' as never })).rejects.toThrow(
            'grep output must be one of "content", "files", "count"; got "names".'
        );
    });

    it('adds context lines when asked, and keeps the default entry shape when not', async () => {
        // Defect 4. Without context every hit costs a follow-up `read` to understand.
        const result = await grep({ pattern: 'HAYSTACK', paths: ['ctx'], patterns: ['around.ts'], context: 1 });

        expect(result.matches).toEqual([
            {
                path: 'ctx/around.ts',
                line: 2,
                text: 'HAYSTACK here',
                textTruncated: false,
                bytes: 13,
                before: ['first line'],
                // The trailing empty string is the file's final newline seen as a line:
                // `content.split(/\r?\n/)` produces it, and context reports the file's
                // lines rather than a prettified view of them.
                after: ['last line']
            }
        ]);

        // Context is charged against the aggregate budget, so `bytes` is the snippet PLUS
        // the context text — and the entry's own `bytes` stays the snippet alone.
        expect(result.bytes).toBe(13 + 'first line'.length + 'last line'.length);
        expect((result.matches[0] as { bytes: number }).bytes).toBe(13);

        // No context, no extra keys: the shape every existing caller already reads.
        const plain = await grep({ pattern: 'HAYSTACK', paths: ['ctx'] });

        expect(Object.keys(plain.matches[0] ?? {})).toEqual(['path', 'line', 'text', 'textTruncated', 'bytes']);

        // A knob, so it clamps: 50 plainly means "as many as allowed", and the answer is
        // the one `context: 10` gives — including the empty line the file's final newline
        // produces, which a 1-line window does not reach.
        const clamped = await grep({ pattern: 'HAYSTACK', paths: ['ctx'], patterns: ['around.ts'], context: 50 });
        const atMax = await grep({ pattern: 'HAYSTACK', paths: ['ctx'], patterns: ['around.ts'], context: MAX_GREP_CONTEXT_LINES });

        expect(clamped.matches).toEqual(atMax.matches);
        expect((clamped.matches[0] as { after: string[] }).after).toEqual(['last line', '']);

        // A non-number is reported rather than defaulted, because silently ignoring it
        // would return a context-free answer the caller believes has context.
        await expect(grep({ pattern: 'HAYSTACK', context: '2' as never })).rejects.toThrow(
            `grep context must be a number of lines between 0 and ${MAX_GREP_CONTEXT_LINES}.`
        );
    });

    it('cuts a giant context line to the snippet cap and flags it', async () => {
        // A minified file with `context: 10` would otherwise charge up to 20 MiB for ONE
        // hit — which is both an oversized result and, because no page could ever hold
        // it, a `nextOffset` that never advances. The fixture is seeded in `beforeAll`.
        const result = await grep({ pattern: 'HAYSTACK', paths: ['ctx'], patterns: ['minified.ts'], context: 1 });
        const hit = result.matches[0] as {
            before: string[];
            after: string[];
            contextTruncated?: boolean;
        };

        expect(hit.before[0]).toHaveLength(FILE_GREP_MATCH_TEXT_BYTES);
        expect(hit.after[0]).toHaveLength(FILE_GREP_MATCH_TEXT_BYTES);
        expect(hit.contextTruncated).toBe(true);
        expect(result.bytes).toBeLessThanOrEqual(FILE_GREP_CONTENT_BUDGET);
    });

    it('stops a catastrophic pattern instead of hanging, and blames the pattern', async () => {
        // T16 regression: `(a+)+$` against 31 "a"s and a "b" used to block the whole
        // process for seconds. It runs inside a vm with a real timeout, so the call fails
        // instead of freezing the harness — and the message may blame the pattern, because
        // under measured accounting ONLY matching time charges this budget
        // (./bounded-regex).
        //
        // The old version of this test mocked `Date.now` to jump 30,001ms PER READ, which
        // did not just permit the bug, it pinned it: I/O was charged to a matching budget.
        // That accounting is proven wrong-on-purpose in ./bounded-regex.test.ts. Here the
        // budget is injected rather than waited out, so the outcome is observed in
        // milliseconds with the real clock and a real backtrack.
        const startedAt = Date.now();
        const error = await searchContents(
            { source: '(a+)+$', flags: '', output: 'content', context: 0, offset: 0, limit: 100, roots: ['.'] },
            compilePatterns(['line.txt']),
            { matchBudgetMs: 400, searchBudgetMs: 30_000 }
        ).then(
            () => undefined,
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(HarnessError);
        expect((error as Error).message).toContain('did not finish within its 400ms matching budget');
        expect((error as Error).message).toContain('the pattern is the problem here and not the size of the tree');
        // The file it died in is named, which is the first thing a caller wants to open.
        expect((error as Error).message).toContain('evil/line.txt');
        // The vm timeout is what stopped it, not a wait out of the published ceiling.
        expect(Date.now() - startedAt).toBeLessThan(5_000);

        // The published default is still the 30s the description names, so the injected
        // budget above is the same mechanism, not a different one.
        expect(DEFAULT_GREP_LIMITS.matchBudgetMs).toBe(30_000);
        expect(DEFAULT_GREP_LIMITS.searchBudgetMs).toBe(MAX_SEARCH_MILLIS);
    });

    it('reports a large tree as a PARTIAL result, never as an expensive pattern', async () => {
        // Defect 1, the outcome that used to be an error. With the search budget injected
        // at 0ms the very first file exhausts it, and the answer must be what was found so
        // far plus an explanation that points at the SIZE of the tree.
        const result = await searchContents(
            { source: 'TODO', flags: '', output: 'content', context: 0, offset: 0, limit: 100, roots: ['.'] },
            compilePatterns(['**/*']),
            { matchBudgetMs: 30_000, searchBudgetMs: 0 }
        );

        expect(result.stopReason).toBe('searchBudget');
        expect(result.partial).toBe(true);
        // A page from a scope-limited search cannot be resumed reliably, so no nextOffset
        // is promised — the note's advice (narrow the roots) is the only advice that is
        // always true here.
        expect(result.truncated).toBe(false);
        expect(result.nextOffset).toBeNull();
        expect(result.note).toContain('wall-clock budget');
        expect(result.note).toContain('the tree, not the pattern, cost the time');
        expect(result.note).toContain('narrow "paths" or "patterns"');
        // The search did real work before it stopped: a partial answer beats a refused
        // call, which is the whole point of separating the two bounds. (Which file comes
        // first is the walk's order, not this test's concern, so the assertion is on the
        // count of files examined rather than on matches — the first entries of this
        // fixture hold no `TODO`.)
        expect(result.searched.scanned).toBeGreaterThan(0);
        expect(result.bytes).toBeGreaterThanOrEqual(0);
    });

    it('enforces the search budget while walking past files it never opens', async () => {
        // The bound has to hold for the WHOLE search, not only for files that get matched.
        // Every candidate under `skips/` is over the 1 MiB cap, so the loop only ever
        // `continue`s — and a budget check placed after those `continue`s would never run:
        // the walk would consume the entire tree however long the clock said, which is the
        // same class of bug this revision set out to fix.
        //
        // Two numbers discriminate the placement. With the check at the top of the loop,
        // the budget fires after the FIRST candidate is examined (the first is always
        // examined, so a search never answers "I stopped before looking at anything"):
        // stopReason is 'searchBudget' and exactly one file is counted as skipped. With
        // the check after the skip branches, all four are consumed, the loop ends on its
        // own, and the answer is 'complete' with four skips — a full walk of a tree the
        // budget said was too big.
        //
        // `searched.inScope` is NOT the measure of how far the search got: the read
        // pipeline prefetches up to GREP_READ_CONCURRENCY candidates, so the walk has
        // already yielded all four before the consumer stops. That is the pipeline working
        // as designed — it is why `skipped` (what the consumer actually processed) is the
        // number that discriminates, and why `inScope` is documented as "candidates the
        // patterns could have selected" rather than "files examined".
        const result = await searchContents(
            { source: 'NEVER_MATCHES', flags: '', output: 'content', context: 0, offset: 0, limit: 100, roots: ['skips'] },
            compilePatterns(['**/*']),
            { matchBudgetMs: 30_000, searchBudgetMs: 0 }
        );

        expect(result.stopReason).toBe('searchBudget');
        expect(result.partial).toBe(true);
        expect(result.matches).toEqual([]);
        expect(result.skipped).toEqual({ tooLarge: 1, binary: 0, unreadable: 0 });
        expect(result.searched.inScope).toBe(4);
        // The note counts candidates EXAMINED rather than files matched, so it stays
        // truthful when the budget expired on a file that was never opened.
        expect(result.note).toContain('candidate file(s)');
    });

    it('does not report a cheap pattern over a big tree as an expensive pattern', async () => {
        // THE Defect-1 assertion at tool level. A literal cannot backtrack, so the
        // matching budget is unreachable by construction; a large tree can still exhaust
        // the WALL-CLOCK search budget, and that must arrive as a partial result naming
        // the size, never as "simplify the pattern".
        const result = await grep({ pattern: 'zzz_absent_pattern_zzz' });

        expect(result.matches).toEqual([]);
        expect(result.stopReason).not.toBe('patternBudget');
        expect(result.partial).toBe(false);
        expect(result.note).not.toMatch(/simplify|backtrack/i);
        // The tree was fully scanned within the budget on this fixture, which is the
        // honest version of the answer the old build refused to give.
        expect(result.stopReason).toBe('complete');
        expect(result.searched.scanned).toBe(20);
    });

    it('keeps ordinary content searches unaffected by the budget', async () => {
        // The same fixture set as before, with the vm-backed matcher: same matches,
        // same order, same line numbers.
        await expect(grep({ pattern: 'TODO', patterns: ['*.ts'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
        ]);
    });

    // R2: one match on a giant line used to copy the WHOLE line. The snippet cap
    // cuts it on a code-point boundary and says so per match.
    it('cuts a giant ASCII line to the 1 KiB snippet cap and flags it, keeping the line number', async () => {
        await expect(grep({ pattern: 'NEEDLE', patterns: ['ascii.txt'] }).then((r) => r.matches)).resolves.toEqual([
            {
                path: 'huge/ascii.txt',
                line: 1,
                // Exactly 1024 bytes: 7 for "NEEDLE " plus 1017 "a"s.
                text: `NEEDLE ${'a'.repeat(1017)}`,
                textTruncated: true,
                bytes: 1024
            }
        ]);
    });

    it('never splits a surrogate pair when cutting a giant non-ASCII line', () => {
        // The fixture is "NEEDLE " (7 bytes) plus 300 four-byte emoji. 7 + 4 * 254 =
        // 1023 bytes fit; the 255th emoji would take it to 1027, so the cut lands
        // BEFORE it. A UTF-16 slice at 1024 units would have produced a lone
        // surrogate, i.e. a character that is not in the file.
        return expect(
            grep({ pattern: 'NEEDLE', patterns: ['emoji.txt'] }).then((r) => r.matches)
        ).resolves.toEqual([
            {
                path: 'huge/emoji.txt',
                line: 1,
                text: `NEEDLE ${'\u{1F600}'.repeat(254)}`,
                textTruncated: true,
                bytes: 1023
            }
        ]);
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

        const result = await grep({ pattern: 'Q', patterns: ['lines.txt'] });

        expect(result.matches).toEqual(expectedBudgetMatches);
        expect(windowOf(result)).toEqual({
            output: 'content',
            truncated: true,
            offset: 0,
            limit: 100,
            nextOffset: 64,
            bytes: 65536,
            contentBudget: 65536,
            partial: false,
            stopReason: 'contentBudget',
            patterns: ['lines.txt']
        });

        // And the page resumes exactly where the budget stopped: 6 more lines exist.
        const rest = await grep({ pattern: 'Q', patterns: ['lines.txt'], offset: 64 });

        expect(rest.matches).toHaveLength(6);
        expect(rest.offset).toBe(64);
        expect(rest.nextOffset).toBeNull();
        expect(rest.stopReason).toBe('complete');
    });

    it('reports the cap independently of the byte budget', async () => {
        // 40 matches of 1024 bytes charge 40960 bytes, well inside the 64 KiB budget,
        // so `truncated: true` here can only come from the maxResults cap, and
        // `stopReason` says which one did it. The flag means "a match that exists was
        // withheld", whichever limit did it.
        const expectedCappedMatches = Array.from({ length: 40 }, (_unused, index) => ({
            path: 'budget/lines.txt',
            line: index + 1,
            text: 'Q'.repeat(1024),
            textTruncated: false,
            bytes: 1024
        }));

        const capped = await grep({ pattern: 'Q', patterns: ['lines.txt'], maxResults: 40 });

        expect(capped.matches).toEqual(expectedCappedMatches);
        expect(windowOf(capped)).toMatchObject({
            truncated: true,
            bytes: 40960,
            stopReason: 'resultCap',
            nextOffset: 40
        });

        // A result that is genuinely complete says so: one 1 KiB snippet, nothing
        // withheld by the cap or the budget.
        const complete = await grep({ pattern: 'NEEDLE', patterns: ['ascii.txt'] });

        expect(complete.matches).toEqual([
            {
                path: 'huge/ascii.txt',
                line: 1,
                text: `NEEDLE ${'a'.repeat(1017)}`,
                textTruncated: true,
                bytes: 1024
            }
        ]);
        expect(windowOf(complete)).toMatchObject({ truncated: false, stopReason: 'complete', nextOffset: null });
    });

    it('keeps the honesty fields ahead of the result list in the serialized form', async () => {
        // The harness caps a serialized tool result at 64 KiB of TEXT and keeps the
        // BEGINNING when it must cut (core/result-budget.ts). grep's own budget is the
        // same 64 KiB — of match text, not of JSON — so a full page of 1 KiB snippets
        // serializes past the wire cap, because every entry also carries its path, line
        // number, flags and braces. If `matches` came first, the envelope would cut
        // exactly the fields that explain the cut: `truncated`, `stopReason`, `skipped`,
        // `excluded`, `note`.
        const result = await grep({ pattern: 'Q', patterns: ['lines.txt'] });

        expect(result.truncated).toBe(true);

        const serialized = JSON.stringify(result);

        // The premise, asserted rather than assumed: this result really does exceed the
        // wire cap, so the ordering is load-bearing and not decorative.
        expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(MODEL_TOOL_RESULT_BUDGET_BYTES);

        const bounded = boundToolResult(serialized);

        expect(bounded.truncated).toBe(true);

        // The envelope is `{ truncated, originalBytes, budgetBytes, content }`, and
        // `content` is the leading slice of the serialized result. What survives that cut
        // must be the EXPLANATION, because that is the part a caller needs in order to
        // read a short list correctly.
        const envelope = JSON.parse(bounded.content) as { content: string };
        const prefix = envelope.content;

        for (const field of [
            '"output":"content"',
            '"truncated":true',
            '"limit":100',
            '"stopReason":"contentBudget"',
            '"partial":false',
            '"searched":{',
            '"skipped":{',
            '"excluded":{',
            '"patterns":["lines.txt"]',
            '"note":'
        ]) {
            expect(prefix).toContain(field);
        }

        // The cut lands inside `matches` — the last key, and the only thing that can be
        // lost without losing the meaning of the answer.
        expect(prefix.indexOf('"matches":[')).toBeGreaterThan(prefix.indexOf('"note":'));
        expect(prefix.endsWith(']')).toBe(false);

        // And the field order is the mechanism, pinned directly so a refactor that moves
        // `matches` back to the front fails here rather than in a model's context.
        expect(Object.keys(result)).toEqual([
            'output',
            'truncated',
            'offset',
            'limit',
            'nextOffset',
            'bytes',
            'contentBudget',
            'partial',
            'stopReason',
            'searched',
            'skipped',
            'excluded',
            'patterns',
            'note',
            'matches'
        ]);
    });

    it('stops walking once the window is full and truncation is proven', async () => {
        // Efficiency, and the reason a capped search is cheap: the walk is abandoned the
        // moment one extra match has been PROVEN, so the rest of the tree is never
        // enumerated. `searched.scanned` is the proof — a full walk of this fixture scans
        // 20 files, and a two-match search must scan fewer.
        const capped = await grep({ pattern: 'TODO', maxResults: 2 });

        expect(capped.searched.scanned).toBeLessThan(20);
        expect(capped.truncated).toBe(true);
    });
});

// The `.gitignore` scope rule is the whole contract: rules come ONLY from files at or
// below the root, so the same directory is invisible from `paths: ['.']` and fully
// searchable from `paths: ['dist']`. Both directions are asserted, because either one
// alone is consistent with a broken walk.
describe('grep - .gitignore scoping', () => {
    it('excludes every path an ignore rule covers under the default root', async () => {
        // From '.', the fixture .gitignore prunes `dist/` (directory rule), `/Temp/`
        // (anchored directory rule) and `node_modules/`, and `*.log` excludes a.log —
        // while keep.log survives because `!keep.log` is the LAST matching rule. The
        // result is exactly the two survivors, in walk order (`keep.log` sorts before
        // `notes.ts`), and nothing else: root binary.ts is reached but skipped as
        // binary, and the .gitignore file itself holds no MARK.
        const result = await grep({ pattern: 'MARK', paths: ['.'], maxResults: 100 });

        expect(result.matches).toEqual([
            { path: 'keep.log', line: 1, text: 'MARK kept-log', textTruncated: false, bytes: 13 },
            { path: 'notes.ts', line: 1, text: 'MARK source', textTruncated: false, bytes: 11 }
        ]);
        expect(result.truncated).toBe(false);
        expect(result.bytes).toBe(24);

        // The counts are the other half of this assertion: what is missing from the list
        // is missing because of a RULE, and the result says how many of each kind.
        expect(result.excluded).toMatchObject({ ignoredFiles: 1, prunedDirectories: 3 });
    });

    it('counts a symlinked entry instead of silently passing over it', async () => {
        if (rootAlias === undefined) return;

        const result = await grep({ pattern: 'ZZZ', paths: ['.'] });

        // Counting it is what makes "never followed" visible: an entry that is neither
        // yielded nor counted is indistinguishable from one that does not exist.
        expect(result.excluded.symlinks).toBe(1);
    });

    it('searches a deliberately named root that an enclosing .gitignore ignores', async () => {
        // All three roots are named by the caller, so the .gitignore ABOVE them is out of
        // scope and is never loaded — the ripgrep/OpenCode behaviour that makes an
        // ignored build or scratch directory still searchable on purpose.
        await expect(grep({ pattern: 'MARK', paths: ['Temp'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'Temp/scratch.ts', line: 1, text: 'MARK scratch', textTruncated: false, bytes: 12 }
        ]);

        await expect(grep({ pattern: 'MARK', paths: ['dist'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'dist/hidden.ts', line: 1, text: 'MARK dist', textTruncated: false, bytes: 9 }
        ]);

        // node_modules is BOTH on the fixed name-skip list and ignored here, so a result
        // proves the relaxation (./glob.ts rootTargetsSkippedDirectory) as well: the
        // neighbour `pkg/index.js` carries `TODO`, and only i.js carries MARK, so the
        // single hit is the deliberate root's own content, not a leaked default walk.
        const dependencies = await grep({ pattern: 'MARK', paths: ['node_modules'] });

        expect(dependencies.matches).toEqual([
            { path: 'node_modules/pkg/i.js', line: 1, text: 'MARK dep', textTruncated: false, bytes: 8 }
        ]);
        // Named as a root, nothing is excluded by a rule: the enclosing file is out of
        // scope, which is what makes the answer above trustworthy rather than accidental.
        expect(dependencies.excluded).toMatchObject({
            ignoredFiles: 0,
            prunedDirectories: 0,
            skippedDirectories: 0
        });
    });

    it('applies the ignore filter together with the glob filter and the negation', async () => {
        // `*.log` is a NAME filter and `*.log` is also an ignore rule, so only the file
        // the `!` re-includes can appear. A result that ignored the negation would list
        // a.log too; a result that ignored the name filter would list every survivor.
        await expect(grep({ pattern: 'MARK', patterns: ['*.log'], paths: ['.'] }).then((r) => r.matches)).resolves.toEqual(
            [{ path: 'keep.log', line: 1, text: 'MARK kept-log', textTruncated: false, bytes: 13 }]
        );
    });

    it('never opens a file an ignore rule excludes', async () => {
        // The decisive pair. dist/hidden.ts is small and plain text, so no read cap and
        // no binary rule can explain the empty result below — only "the walker never
        // yielded the path" does. Rooting AT dist reads the very same file and matches it,
        // which is what turns the empty array into proof instead of a coincidence.
        const ignored = await grep({ pattern: 'MARK', patterns: ['hidden.ts'] });

        expect(ignored.matches).toEqual([]);
        // It was never even a candidate, so it is not in `skipped` either — it is in
        // `excluded`, which is the field that distinguishes "never walked" from "walked
        // but not searched".
        expect(ignored.skipped).toEqual({ tooLarge: 0, binary: 0, unreadable: 0 });
        // `inScope` counts everything the IGNORE policy let through, before the pattern
        // filter, so it is not the field that proves this. `scanned: 0` plus
        // `prunedDirectories: 3` is the proof: the file was never a candidate to open, and
        // the result says which policy did it.
        expect(ignored.searched.scanned).toBe(0);
        expect(ignored.excluded.prunedDirectories).toBe(3);

        await expect(
            grep({ pattern: 'MARK', patterns: ['hidden.ts'], paths: ['dist'] }).then((r) => r.matches)
        ).resolves.toEqual([
            { path: 'dist/hidden.ts', line: 1, text: 'MARK dist', textTruncated: false, bytes: 9 }
        ]);

        // The two oversized/binary neighbours under the same ignored directory are also
        // absent by name, so the rule prunes the subtree instead of filtering one entry:
        // dist/huge.ts crosses the 1 MiB read cap and dist/binary.ts is byte-identical to
        // the reachable root sibling binary.ts (which grep skips as binary), so the
        // ignore rule is the only difference between those two paths.
        await expect(grep({ pattern: 'MARK', patterns: ['huge.ts'] }).then((r) => r.matches)).resolves.toEqual([]);
        await expect(grep({ pattern: 'MARK', patterns: ['binary.ts'] }).then((r) => r.matches)).resolves.toEqual([]);
    });

    it('keeps the ignore scope per root, in caller order', async () => {
        // Two roots, two fresh matchers (./search.ts). Root '.' has `/Temp/` loaded and
        // therefore never sees Temp/scratch.ts; root 'Temp' is the named-root escape
        // hatch, so the file appears exactly once, contributed by the second root and
        // prefixed with it. Order is the documented root order, and the first root keeps
        // any path both could reach.
        await expect(grep({ pattern: 'MARK', paths: ['.', 'Temp'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'keep.log', line: 1, text: 'MARK kept-log', textTruncated: false, bytes: 13 },
            { path: 'notes.ts', line: 1, text: 'MARK source', textTruncated: false, bytes: 11 },
            { path: 'Temp/scratch.ts', line: 1, text: 'MARK scratch', textTruncated: false, bytes: 12 }
        ]);

        // Reversed roots: the same three files, re-ordered, and the scratch match now
        // arrives first. A shared matcher across roots would have lost it in the first
        // root's rules, which is the failure this direction catches.
        await expect(grep({ pattern: 'MARK', paths: ['Temp', '.'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'Temp/scratch.ts', line: 1, text: 'MARK scratch', textTruncated: false, bytes: 12 },
            { path: 'keep.log', line: 1, text: 'MARK kept-log', textTruncated: false, bytes: 13 },
            { path: 'notes.ts', line: 1, text: 'MARK source', textTruncated: false, bytes: 11 }
        ]);
    });
});

// Two roots that are ONE directory must be searched once. Both cases are about file
// identity rather than spelling, which is what an old `resolve()`-based dedupe missed.
describe('grep - aliased roots', () => {
    it('searches a case-aliased root once on Windows and keeps it distinct on Linux', async () => {
        // NTFS is case-insensitive, so 'src' and 'SRC' are the same directory and a
        // second pass would report every match twice under a second prefix. Linux has no
        // 'SRC' at all, so that spelling is a missing root — asserted as its own
        // truth instead of being skipped.
        if (process.platform === 'win32') {
            await expect(grep({ pattern: 'TODO', paths: ['src', 'SRC'] }).then((r) => r.matches)).resolves.toEqual([
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
            ]);
            return;
        }

        await expect(grep({ pattern: 'TODO', paths: ['src', 'SRC'] })).rejects.toThrow(/does not exist/);
    });

    it('searches a symlinked root once when the host allows symlinks', async () => {
        if (rootAlias === undefined) return;

        // 'src-alias' resolves to 'src', so the second root contributes only
        // duplicates. The first root wins the prefix, exactly like overlapping roots.
        await expect(grep({ pattern: 'TODO', paths: ['src', rootAlias] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
        ]);

        // Reverse order: the alias is walked first, so its prefix is the one kept.
        await expect(grep({ pattern: 'TODO', paths: [rootAlias, 'src'] }).then((r) => r.matches)).resolves.toEqual([
            { path: 'src-alias/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
            { path: 'src-alias/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
            { path: 'src-alias/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
        ]);
    });
});
