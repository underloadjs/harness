// glob — the filename-search contract (the name half of the old fileGlob).
//
// `fileGlob` used to be one tool with two modes, discriminated by whether the caller
// sent `content`. This file pins the name half under its own wire name; the line-level
// half lives in ./grep.test.ts. What that split has to guarantee:
//
//   - `glob` answers with PATHS ONLY: { files, truncated, offset, limit, nextOffset,
//     bytes, contentBudget, stopReason, partial, searched, excluded, patterns, note },
//     and its schema has no `content` property (a caller that sends one is rejected by
//     `additionalProperties: false` rather than silently answered with names);
//   - glob matching: *, ?, **, character classes, and the "no slash also matches the
//     file name at any depth" rule;
//   - root-prefixed presentation in the CALLER's root order, dedupe across overlapping
//     and aliased roots by real file identity, and one GLOBAL cap;
//   - `.gitignore` scoping (./gitignore.ts, wired in by ./search.ts): rules come only from
//     files AT OR BELOW each root, an ignored directory is pruned before its own
//     .gitignore is ever read, a `!` negation re-includes a file, and a root the caller
//     names explicitly is walked even when an enclosing rule ignores it or the walker
//     would prune it by name (`node_modules`);
//   - argument rules: a non-object argument is rejected rather than defaulted to
//     "every file", empty patterns/paths arrays are rejected rather than matching
//     nothing, and patterns are matched relative to EACH root.
//
// What THIS revision adds, and pins:
//
//   - `offset`/`limit`/`nextOffset`: a capped listing is resumable. The walk is a
//     deterministic prefix, which is the precondition; `read` and `files` already
//     paged and a search that could not was the asymmetry that left a caller guessing a
//     narrower pattern.
//   - the cap is 1-1000 instead of 1-100, and `limit` echoes what was applied — a
//     request for 500 that silently got 100 used to be indistinguishable from a tree
//     that holds 100 files.
//   - `excluded`/`searched`/`note`: `[]` caused by a prune is now told apart from `[]`
//     caused by absence (the 369-`.min.js`-files case).
//   - `{a,b}` expansion and `!` exclusion in `patterns`, both of which used to answer
//     "no such file" to a request that meant something else.
//   - a FILE as a root, and a root error that names the fix instead of `ENOENT … scandir`.
//
// The fixture tree is the process cwd for this file, so roots are relative and the
// results are the documented root-prefixed relative paths (the same presentation
// files uses: "." contributes no prefix). Fixtures live under the repo-root
// `Temp/`, one unique directory per run, removed afterwards. The `.gitignore` describes
// at the end of this file each own a second `Temp/` directory of their own, because that
// shared tree deliberately has no `.gitignore` in it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../../util';
import { MAX_RESULTS_LIMIT, expandBraces, globToRegExp, matchGlob, walkFiles } from './glob';
import { FILE_GLOB_CONTENT_BUDGET, GLOB_METADATA, glob } from './glob.tool';

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
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-glob-'));
    process.chdir(workdir);

    // Never entered by the walker. This tree has no `.gitignore` at all, so the skip is
    // the walker's name rule alone (`SKIPPED_DIRECTORIES`), and every assertion below
    // that lists the tree is complete. The .gitignore cases have their own fixtures.
    await seed('.git/secret.ts', '// TODO: hidden\n');
    await seed('node_modules/pkg/index.js', '// TODO: ignored\n');

    // The searchable tree. A binary file is a plain RESULT here: skipping binary
    // content is grep's job, glob only matches names.
    await seed('binary.bin', 'TODO\u0000binary\n');
    await seed('docs/readme.md', 'TODO: four\n');
    await seed('src/a.ts', 'const x = 1;\n// TODO: one\n');
    await seed('src/b.ts', '// TODO: two\n');
    await seed('src/nested/c.js', 'TODO: three\n');
    await seed('src/nested/deep/d.ts', 'no match here\n');
    await seed('task/e.ts', '// TODO: five\n');
    await seed('root.txt', 'TODO: six\n');

    // A `.tsx` sibling, so brace expansion has something only it can reach.
    await seed('ui/App.tsx', 'export const App = 1;\n');

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

// The whole fixture tree, in walk order, with .git and node_modules left out. This is
// the answer the documented default request has to produce, so it is written out once
// and asserted exactly rather than "contains something".
const EVERY_FILE = [
    'binary.bin',
    'docs/readme.md',
    'root.txt',
    'src/a.ts',
    'src/b.ts',
    'src/nested/c.js',
    'src/nested/deep/d.ts',
    'task/e.ts',
    'ui/App.tsx'
];

// The paging/bound window of a listing, extracted so a test asserts the arithmetic that
// closed the page exactly without repeating the whole coverage object.
const windowOf = (result: Awaited<ReturnType<typeof glob>>) => ({
    truncated: result.truncated,
    offset: result.offset,
    limit: result.limit,
    nextOffset: result.nextOffset,
    bytes: result.bytes,
    contentBudget: result.contentBudget,
    stopReason: result.stopReason,
    partial: result.partial,
    patterns: result.patterns
});

describe('glob', () => {
    it('publishes the renamed tool with no content mode of its own', () => {
        // R1: the wire name is `glob` and the old `content` property is gone, so the
        // tool can never answer a content request with a name listing. The cap, the
        // roots, and the new paging knob stay, and the visibility is unchanged from
        // fileGlob (core).
        expect(glob.name).toBe('glob');
        expect(Object.keys(glob.parameters.properties ?? {})).toEqual([
            'patterns',
            'paths',
            'maxResults',
            'offset'
        ]);
        expect('required' in glob.parameters).toBe(false);
        expect(glob.parameters.additionalProperties).toBe(false);
        expect(glob.visibility).toBe('core');
        expect(glob.tags).toEqual(['files', 'glob', 'find', 'paths', 'filesystem']);

        // The published shape sentence, and the honesty sentence.
        expect(GLOB_METADATA.description).toContain('{ files, truncated,');
        expect(GLOB_METADATA.description).toContain('names only, never file contents');
        expect(GLOB_METADATA.description.endsWith('Does not search text.')).toBe(true);
    });

    it('publishes the caps it enforces as exported constants', () => {
        // The numbers a caller reads in `limit` / `contentBudget` must be the numbers the
        // module documents, so a host cannot quietly widen them. The hard cap is 1000,
        // not the 100 that made a 369-file question unanswerable.
        expect(MAX_RESULTS_LIMIT).toBe(1000);
        expect(FILE_GLOB_CONTENT_BUDGET).toBe(64 * 1024);
    });

    it('lists every file for the default pattern without entering skipped directories', async () => {
        // `glob({})` is the documented "every file under '.'" request, and "."
        // contributes no prefix.
        const result = await glob({});

        expect(result.files).toEqual(EVERY_FILE);
        expect(windowOf(result)).toEqual({
            truncated: false,
            offset: 0,
            limit: 100,
            nextOffset: null,
            bytes: EVERY_FILE.reduce((total, file) => total + file.length, 0),
            contentBudget: 65536,
            stopReason: 'complete',
            partial: false,
            patterns: ['**/*']
        });
    });

    it('reports what the walk dropped, so an empty listing is explainable', async () => {
        // Defect 2. Two name-skipped directories and one symlink are the only things
        // missing from `EVERY_FILE`, and the result says so with counts instead of
        // leaving the caller to guess whether the tree is smaller than it looks.
        const result = await glob({});

        expect(result.searched).toEqual({
            inScope: EVERY_FILE.length,
            roots: 1
        });
        expect(result.excluded).toEqual({
            ignoredFiles: 0,
            prunedDirectories: 0,
            skippedDirectories: 2, // .git and node_modules, by name
            unreadableDirectories: 0,
            symlinks: rootAlias === undefined ? 0 : 1,
            // This tree has no .gitignore anywhere, so nothing was parsed — and the walk
            // does not pretend otherwise by counting probes as rule sources.
            ignoreFilesParsed: 0,
            ignoreRulesTruncated: false
        });
        expect(result.partial).toBe(false);
        // The skip-by-name clause is the only thing here worth acting on, and the note
        // says how to undo it.
        expect(result.note).toContain('skipped by name (.git, node_modules)');
        expect(result.note).toContain('root the search inside one');
    });

    it('matches a pattern without a slash against file names at any depth', async () => {
        const result = await glob({ patterns: ['*.ts'] });

        expect(result.files).toEqual(['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts', 'task/e.ts']);
        expect(windowOf(result)).toMatchObject({ truncated: false, patterns: ['*.ts'] });
    });

    it('matches a slash pattern against the root-relative path', async () => {
        await expect(glob({ patterns: ['src/**/*.js'] }).then((r) => r.files)).resolves.toEqual([
            'src/nested/c.js'
        ]);

        await expect(glob({ patterns: ['src/*.ts'] }).then((r) => r.files)).resolves.toEqual([
            'src/a.ts',
            'src/b.ts'
        ]);
    });

    it('ORs several patterns together', async () => {
        await expect(glob({ patterns: ['*.md', 'src/*.ts'] }).then((r) => r.files)).resolves.toEqual([
            'docs/readme.md',
            'src/a.ts',
            'src/b.ts'
        ]);
    });

    it('expands brace alternatives instead of matching them literally', async () => {
        // Defect 4. `**/*.{ts,tsx}` used to answer `[]` with `truncated: false`, which
        // reads as "no such file" while `ui/App.tsx` sits in the tree. The expansion is
        // echoed in `patterns` so the caller can see what was actually matched.
        const result = await glob({ patterns: ['**/*.{ts,tsx}'] });

        expect(result.files).toEqual([...EVERY_FILE.filter((file) => file.endsWith('.ts')), 'ui/App.tsx']);
        expect(result.patterns).toEqual(['**/*.ts', '**/*.tsx']);
    });

    it('excludes with a leading ! and treats a list of only ! as "everything except"', async () => {
        // Defect 4. `['**/*', '!**/*.ts']` used to RETURN the .ts files (no negation
        // support at all), and `['!**/*.ts']` used to return `[]` (an empty inclusion
        // list). Both were wrong answers that looked complete.
        const excluded = await glob({ patterns: ['**/*', '!**/*.ts'] });

        expect(excluded.files).toEqual([
            'binary.bin',
            'docs/readme.md',
            'root.txt',
            'src/nested/c.js',
            'ui/App.tsx'
        ]);
        expect(excluded.patterns).toEqual(['**/*', '!**/*.ts']);

        // Only negations means "everything except", the way .gitignore reads it — the
        // same answer as the explicit inclusion above.
        const onlyNegated = await glob({ patterns: ['!**/*.ts'] });

        expect(onlyNegated.files).toEqual(excluded.files);

        // Order does not decide the verdict: exclusions always win, so the two lists
        // below agree even though the caller wrote them the other way round.
        await expect(glob({ patterns: ['!**/*.ts', '**/*'] }).then((r) => r.files)).resolves.toEqual(
            excluded.files
        );
    });

    it('prefixes results with the requested root and follows the caller root order', async () => {
        // Each root contributes its own prefix, and the roots are visited in the
        // caller's order — never sorted.
        await expect(glob({ patterns: ['*.ts'], paths: ['task', 'src'] }).then((r) => r.files)).resolves.toEqual([
            'task/e.ts',
            'src/a.ts',
            'src/b.ts',
            'src/nested/deep/d.ts'
        ]);
    });

    it('deduplicates overlapping roots by file identity, keeping the first prefix', async () => {
        // ['src', '.'] both reach src/a.ts. The FIRST root wins the presentation, so
        // the file appears once — as "src/a.ts", not also as "src/src/a.ts" or
        // "src/a.ts" twice.
        await expect(
            glob({ patterns: ['src/*.ts'], paths: ['src', '.'] }).then((r) => r.files)
        ).resolves.toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('caps results globally across roots and flags truncation', async () => {
        const result = await glob({ patterns: ['*.ts'], paths: ['.'], maxResults: 2 });

        expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);
        expect(windowOf(result)).toMatchObject({
            truncated: true,
            limit: 2,
            nextOffset: 2,
            stopReason: 'resultCap'
        });
    });

    it('does not claim truncation when the cap is not reached', async () => {
        await expect(glob({ patterns: ['*.md'], maxResults: 100 }).then((r) => r.files)).resolves.toEqual([
            'docs/readme.md'
        ]);

        await expect(glob({ patterns: ['*.md'], maxResults: 100 }).then((r) => r.truncated)).resolves.toBe(false);
    });

    it('echoes the effective cap instead of silently flooring a larger request', async () => {
        // Defect 3. `maxResults: 500` used to answer with 100 and never say the cap was
        // 100. The hard cap is now 1000 and `limit` reports what was applied, so a caller
        // that asked for more knows whether it got it.
        const result = await glob({ patterns: ['**/*'], maxResults: 5000 });

        expect(result.limit).toBe(1000);
        expect(result.files).toEqual(EVERY_FILE);
        expect(result.truncated).toBe(false);

        // A zero cap clamps up to one entry rather than meaning "no entries".
        await expect(glob({ patterns: ['**/*'], maxResults: 0 }).then((r) => r.limit)).resolves.toBe(1);
    });

    it('pages a capped listing with offset and nextOffset', async () => {
        // Defect 3. Paging must reproduce the unpaged answer exactly: no duplicate, no
        // gap, in walk order.
        const all = await glob({ patterns: ['**/*'] });
        const first = await glob({ patterns: ['**/*'], maxResults: 4 });
        const second = await glob({ patterns: ['**/*'], maxResults: 4, offset: first.nextOffset as number });

        expect(first.files).toEqual(EVERY_FILE.slice(0, 4));
        expect(first.nextOffset).toBe(4);
        expect(second.offset).toBe(4);
        expect(second.files).toEqual(EVERY_FILE.slice(4, 8));
        expect(second.nextOffset).toBe(8);

        const third = await glob({ patterns: ['**/*'], maxResults: 4, offset: 8 });

        expect(third.files).toEqual(EVERY_FILE.slice(8));
        expect(third.truncated).toBe(false);
        expect(third.nextOffset).toBeNull();
        expect([...first.files, ...second.files, ...third.files]).toEqual(all.files);
    });

    it('stops a page at the path-text budget even when the entry cap is not reached', async () => {
        // The 64 KiB budget is the second bound, and it is only observable when paths are
        // long enough to matter — which is exactly the case a capped listing of a deep tree
        // produces, and the reason an entry cap alone is not a bound (1000 entries of a
        // 300-character path is 300 KiB). `stopReason` has to say which bound closed the
        // page.
        //
        // ONE deep directory with many long file names: the paths are what the budget
        // counts, and a single mkdir chain keeps the fixture to file writes rather than a
        // few hundred `mkdir -p` calls (which cost this test 9s on Windows the first way).
        // 6 levels of 19-char names plus a 12-char file name is ~113 bytes per path, so
        // 64 KiB holds ~580: 700 files is comfortably past the budget and comfortably under
        // the 1000-entry cap, the only arrangement where `contentBudget` can be the reason.
        const deepDirectory = Array.from({ length: 6 }, (_unused, level) => `deep-directory-${level}`).join('/');
        const fixture = await createFixture('budget', {
            [`${deepDirectory}/leaf-000.ts`]: 'x\n'
        });
        const restoredCwd = process.cwd();

        try {
            for (let index = 1; index < 700; index++) {
                await seedUnder(fixture, `${deepDirectory}/leaf-${String(index).padStart(3, '0')}.ts`, 'x\n');
            }

            process.chdir(fixture);

            const result = await glob({ paths: ['.'], patterns: ['**/leaf-*.ts'], maxResults: 1000 });
            const bytes = result.files.reduce((total, file) => total + Buffer.byteLength(file, 'utf8'), 0);

            // The premise, asserted: the paths really are long enough for the byte budget
            // to bind before the entry cap, or this test would be proving nothing.
            expect(result.files[0]?.length).toBeGreaterThan(100);
            expect(result.files.length).toBeLessThan(1000);
            expect(bytes).toBeLessThanOrEqual(FILE_GLOB_CONTENT_BUDGET);
            expect(result.truncated).toBe(true);
            expect(result.stopReason).toBe('contentBudget');
            expect(result.limit).toBe(1000);
            expect(result.nextOffset).toBe(result.files.length);

            // The page still resumes: the next offset is the entry that did not fit, so
            // paging walks the whole listing exactly once even when the budget, not the
            // cap, is what closed a page.
            const rest = await glob({
                paths: ['.'],
                patterns: ['**/leaf-*.ts'],
                maxResults: 1000,
                offset: result.nextOffset as number
            });

            expect(rest.files.length).toBeGreaterThan(0);
            expect(rest.files[0]).not.toBe(result.files[result.files.length - 1]);
        } finally {
            process.chdir(restoredCwd);
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('reports a missing search root with a HarnessError that names the fix', async () => {
        // Defect 5. This used to be `ENOENT: no such file or directory, scandir 'D:\…'`:
        // true, but it named neither the argument the caller got wrong nor what to do,
        // and it leaked an absolute path the caller never typed.
        const error = await glob({ patterns: ['**/*'], paths: ['absent'] }).then(
            () => undefined,
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(HarnessError);
        expect((error as Error).message).toContain('glob path "absent" does not exist');
        expect((error as Error).message).toContain('check the spelling');
        expect((error as { cause?: { code?: string } }).cause?.code).toBe('ENOENT');
    });

    it('lists a single file given as a root', async () => {
        // Defect 5, the other half: `paths: ['src/a.ts']` used to fail with
        // `ENOTDIR … scandir` while read and edit accept files everywhere.
        const result = await glob({ paths: ['src/a.ts'] });

        expect(result.files).toEqual(['src/a.ts']);
        expect(result.searched).toEqual({ inScope: 1, roots: 1 });
        expect(result.partial).toBe(false);

        // The pattern filter still applies, tested against the bare name and the
        // caller's own spelling.
        await expect(glob({ paths: ['src/a.ts'], patterns: ['*.md'] }).then((r) => r.files)).resolves.toEqual([]);
        await expect(glob({ paths: ['src/a.ts'], patterns: ['a.ts'] }).then((r) => r.files)).resolves.toEqual([
            'src/a.ts'
        ]);
    });

    it('rejects an empty patterns or paths array instead of matching nothing', async () => {
        await expect(glob({ patterns: [] })).rejects.toThrow(
            'glob received an empty patterns array. Omit patterns to use the default ("**/*").'
        );
        await expect(glob({ paths: [] })).rejects.toThrow(
            'glob received an empty paths array. Omit paths to use the default (".").'
        );
    });

    it('rejects malformed pattern and path entries', async () => {
        await expect(glob({ patterns: [''] })).rejects.toThrow('glob patterns must be non-empty strings.');
        await expect(glob({ paths: [''] })).rejects.toThrow('glob paths must be non-empty strings.');
        await expect(glob({ patterns: ['a\u0000b'] })).rejects.toThrow(
            'glob patterns must not contain NUL characters.'
        );
        await expect(glob({ paths: ['a\u0000b'] })).rejects.toThrow(
            'glob paths must not contain NUL characters.'
        );
        await expect(glob({ patterns: 'x' } as never)).rejects.toThrow(
            'glob patterns must be an array of strings.'
        );
    });

    it('rejects a non-object argument instead of defaulting to every file', async () => {
        // T16: a string or an array used to slip past the property reads and mean
        // "use every default" — i.e. list the whole tree. A wrong answer that looks
        // complete is worse than an error, so the shape is checked first.
        const message =
            'glob expects an object with optional "patterns", "paths", "maxResults", and "offset" properties, e.g. {"patterns":["**/*.ts"]}.';

        await expect(glob('*.ts' as never)).rejects.toThrow(message);
        await expect(glob(['**/*.ts'] as never)).rejects.toThrow(message);
        await expect(glob(7 as never)).rejects.toThrow(message);

        // `null` and `undefined` are "no argument at all", which is a legitimate
        // documented request: every file under ".".
        await expect(glob(undefined as never)).resolves.toMatchObject({ files: EVERY_FILE, truncated: false });
    });

    it('matches patterns relative to each root and prefixes results with it', async () => {
        // The documented contract: a pattern is never matched against the absolute
        // path or against the root's own name, only against the path of the file
        // relative to the root that found it.
        await expect(glob({ paths: ['src'], patterns: ['**/*.ts'] }).then((r) => r.files)).resolves.toEqual([
            'src/a.ts',
            'src/b.ts',
            'src/nested/deep/d.ts'
        ]);

        // "src/*.ts" therefore matches NOTHING when "src" is the root (the relative
        // paths are "a.ts", "b.ts", …), even though it matches two files when "."
        // is the root. This is the exact confusion the description spells out.
        const rooted = await glob({ paths: ['src'], patterns: ['src/*.ts'] });

        expect(rooted.files).toEqual([]);
        // The two counts separate "the directory is empty" from "the pattern cannot
        // match anything here", which one number cannot.
        expect(rooted.searched.inScope).toBe(4);

        await expect(glob({ paths: ['.'], patterns: ['src/*.ts'] }).then((r) => r.files)).resolves.toEqual([
            'src/a.ts',
            'src/b.ts'
        ]);

        // Two roots keep two prefixes, and each root is matched on its own paths.
        await expect(glob({ paths: ['task', 'src'], patterns: ['**/*.ts'] }).then((r) => r.files)).resolves.toEqual([
            'task/e.ts',
            'src/a.ts',
            'src/b.ts',
            'src/nested/deep/d.ts'
        ]);
    });
});

// T16: two roots that are ONE directory must be walked once. Both cases are about file
// identity rather than spelling, which is what the old `resolve()`-based dedupe missed.
// The shared candidate collection lives in ./search.ts, so this is also grep's dedupe.
describe('glob — aliased roots', () => {
    it('walks a case-aliased root once on Windows and keeps it distinct on Linux', async () => {
        // NTFS is case-insensitive, so 'src' and 'SRC' are the same directory and a
        // second pass would list every file twice under a second prefix. Linux has no
        // 'SRC' at all, so that spelling is a missing root — asserted as its own
        // truth instead of being skipped.
        if (process.platform === 'win32') {
            await expect(
                glob({ paths: ['src', 'SRC'], patterns: ['**/*.ts'] }).then((r) => r.files)
            ).resolves.toEqual(['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts']);
            return;
        }

        await expect(glob({ paths: ['src', 'SRC'], patterns: ['**/*.ts'] })).rejects.toThrow(/does not exist/);
    });

    it('walks a symlinked root once when the host allows symlinks', async () => {
        if (rootAlias === undefined) return;

        // 'src-alias' resolves to 'src', so the second root contributes only
        // duplicates. The first root wins the prefix, exactly like overlapping roots.
        await expect(
            glob({ paths: ['src', rootAlias], patterns: ['**/*.ts'] }).then((r) => r.files)
        ).resolves.toEqual(['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts']);

        // Reverse order: the alias is walked first, so its prefix is the one kept.
        await expect(
            glob({ paths: [rootAlias, 'src'], patterns: ['**/*.ts'] }).then((r) => r.files)
        ).resolves.toEqual(['src-alias/a.ts', 'src-alias/b.ts', 'src-alias/nested/deep/d.ts']);
    });
});

describe('glob matching rules', () => {
    it('anchors patterns and keeps * inside one segment', () => {
        expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
        expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
        expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
        expect(globToRegExp('a?.ts').test('a.ts')).toBe(false);
    });

    it('lets **/ match zero directories', () => {
        expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
        expect(globToRegExp('**/*.ts').test('src/nested/a.ts')).toBe(true);
    });

    it('supports character classes, including negation', () => {
        expect(matchGlob('file[0-9].ts', 'file7.ts')).toBe(true);
        expect(matchGlob('file[!0-9].ts', 'file7.ts')).toBe(false);
        expect(matchGlob('file[!0-9].ts', 'filex.ts')).toBe(true);
    });

    it('falls back to the file name only when the pattern has no slash', () => {
        expect(matchGlob('*.md', 'docs/readme.md')).toBe(true);
        expect(matchGlob('docs/*.md', 'docs/readme.md')).toBe(true);
        expect(matchGlob('docs/*.md', 'other/docs/readme.md')).toBe(false);
    });

    it('treats an unterminated class as a literal bracket', () => {
        expect(matchGlob('file[.ts', 'file[.ts')).toBe(true);
    });

    it('is case-sensitive, on every platform', () => {
        // The one asymmetry a caller has to know: ./identity.ts folds case to compare
        // paths for DEDUPE because NTFS is case-insensitive, while the MATCHER keeps
        // case. `*.TS` naming a `foo.ts` file is a typo the caller should see, not a
        // silent hit — and grep's `flags: "i"` is the way to ask for either.
        // Only the EXTENSION case matters: `*.ts` legitimately matches `A.ts`, because
        // `*` is "any prefix" and the prefix's case is not the thing being tested.
        expect(matchGlob('*.TS', 'a.ts')).toBe(false);
        expect(matchGlob('*.ts', 'a.TS')).toBe(false);
        expect(matchGlob('*.ts', 'A.ts')).toBe(true);
        expect(matchGlob('Readme.md', 'docs/readme.md')).toBe(false);
    });
});

describe('brace expansion', () => {
    it('expands alternatives, nested and repeated', () => {
        expect(expandBraces('*.{ts,tsx}')).toEqual(['*.ts', '*.tsx']);
        expect(expandBraces('src/{a,b}/{x,y}.ts')).toEqual([
            'src/a/x.ts',
            'src/a/y.ts',
            'src/b/x.ts',
            'src/b/y.ts'
        ]);
        expect(expandBraces('a{b,{c,d}}e')).toEqual(['abe', 'ace', 'ade']);
        // An empty alternative is a real alternative: `{,x}` means "nothing or x".
        expect(expandBraces('{,x}.ts')).toEqual(['.ts', 'x.ts']);
    });

    it('leaves a group with no comma and an unterminated group literal', () => {
        // Both are the "this is not a choice" reading, and both used to be a reason a
        // `{...}` pattern silently matched nothing. A group with no comma is also how a
        // file actually NAMED `{solo}.ts` stays reachable.
        expect(expandBraces('{dist}')).toEqual(['{dist}']);
        expect(expandBraces('{solo}.ts')).toEqual(['{solo}.ts']);
        expect(expandBraces('src/{a,b')).toEqual(['src/{a,b']);
        // A brace inside a character class does not open a group.
        expect(expandBraces('[{,]}')).toEqual(['[{,]}']);
    });

    it('treats a backslash as a path separator, not an escape', () => {
        // `globToRegExp` normalizes `\` to `/`, so expansion must agree with it: the same
        // pattern written native-style has to select the same files. Treating `\` as an
        // escape here would make the two spellings mean different things.
        expect(expandBraces('src\\{a,b}\\*.ts')).toEqual(['src\\a\\*.ts', 'src\\b\\*.ts']);
        expect(matchGlob(expandBraces('src\\{a,b}\\*.ts')[0], 'src/a/x.ts')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// .gitignore — ./gitignore.ts, handed to the walker by ./search.ts.
// ---------------------------------------------------------------------------
//
// These cases need trees the shared module fixture cannot provide. That fixture has no
// `.gitignore` file at all, which is exactly why its assertions above still list every
// reachable file (`EVERY_FILE`); a rules-bearing tree would change every one of those
// arrays. So each describe below creates its own `Temp/harness-glob-*` directory, chdirs
// into it for its tests, and hands the previous cwd back in `afterAll` — the same
// isolation pattern the module fixture uses, one level down.
//
// The behaviour pinned here, in the matcher's own words (./gitignore.ts header):
// rules come ONLY from `.gitignore` files at or below the root being walked, so a root
// the caller names explicitly is still answered even when an enclosing rule ignores it.

// Seeds one file under an explicit root. The shared `seed` above is bound to the module
// fixture, and these describes each own a different root.
const seedUnder = async (root: string, relativePath: string, content: string): Promise<void> => {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

// One throwaway fixture root under the repo `Temp/`, seeded from a { path -> content }
// map. Insertion order is irrelevant: the walk sorts every directory by name.
const createFixture = async (label: string, files: Record<string, string>): Promise<string> => {
    await mkdir(TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEMP_ROOT, `harness-glob-${label}-`));

    for (const [relativePath, content] of Object.entries(files)) {
        await seedUnder(root, relativePath, content);
    }

    return root;
};

// Drains a walk into the ordered array an exact `toEqual` needs.
const collectWalk = async (paths: AsyncGenerator<string>): Promise<string[]> => {
    const files: string[] = [];

    for await (const path of paths) files.push(path);

    return files;
};

// One rule per documented matcher behaviour (./gitignore.ts "MATCHING RULES"), in the exact
// text the probe was measured against: a comment line, a directory-only rule, an
// anchored directory rule, a slashless rule that reaches any depth, a negation, an
// anchored nested-directory rule, a `/**` contents rule, and the two names the walker
// ALSO prunes by name (./glob.ts `SKIPPED_DIRECTORIES`) — kept here on purpose, because
// "ignored by a rule" and "skipped by name" are two different code paths.
const ROOT_IGNORE_RULES = [
    '# scratch rules',
    'dist/',
    '/Temp/',
    '*.log',
    '!keep.log',
    'src/skip/',
    'build/**',
    '.git/',
    'node_modules/',
    // A real file ends with a newline; the parser drops the empty last line.
    ''
].join('\n');

// The tree every rule above is measured against.
const RULES_FIXTURE: Record<string, string> = {
    '.gitignore': ROOT_IGNORE_RULES,
    'src/.gitignore': '*.tmp\n',
    'keep.ts': 'x\n',
    'a.log': 'x\n',
    'keep.log': 'x\n',
    'dist/app.js': 'x\n',
    'Temp/points.mts': 'x\n',
    'src/a.ts': 'x\n',
    'src/skip/b.ts': 'x\n',
    'src/x.tmp': 'x\n',
    'src/keep.log': 'x\n',
    'build/index.js': 'x\n',
    '.git/hooks/x': 'x\n',
    'node_modules/pkg/i.js': 'x\n',
    // A nested copy of a name-skipped directory: only a search already rooted inside
    // `node_modules` can reach it, because there the skip list drops to
    // `ALWAYS_SKIPPED_DIRECTORIES` (./search.ts `collectCandidates`, which picks the skip
    // list per root from `rootTargetsSkippedDirectory`).
    'node_modules/pkg/node_modules/dep/index.js': 'x\n'
};

describe('glob — .gitignore rules at the search root', () => {
    let fixture: string;
    let restoredCwd: string;

    beforeAll(async () => {
        restoredCwd = process.cwd();
        fixture = await createFixture('ignore', RULES_FIXTURE);
        process.chdir(fixture);
    });

    afterAll(async () => {
        process.chdir(restoredCwd);
        await rm(fixture, { recursive: true, force: true });
    });

    it('excludes every path the root .gitignore ignores and lists the rest', async () => {
        // One assertion carries most of the rule set: `.gitignore` itself IS a result
        // (it is only a rule source to the loader), `a.log` falls to `*.log`,
        // `keep.log` survives `*.log` because `!keep.log` comes later and last match
        // wins, `dist/` and `/Temp/` are pruned as directories, `src/skip/` is pruned
        // by its anchored rule, `build/**` excludes the file (the rule matches
        // contents, not the directory), `src/x.tmp` falls to the nested
        // `src/.gitignore`, and `.git/hooks/x` plus `node_modules/...` are gone.
        const result = await glob({ paths: ['.'], maxResults: 100 });

        expect(result.files).toEqual([
            '.gitignore',
            'keep.log',
            'keep.ts',
            'src/.gitignore',
            'src/a.ts',
            'src/keep.log'
        ]);
        expect(result.truncated).toBe(false);

        // The new half of the same story: the listing is short, and the result says WHY
        // in counts the caller can check. Note the ORDER of the verdicts: this fixture's
        // .gitignore names `.git/` and `node_modules/` as rules, so those directories are
        // counted as IGNORED rather than name-skipped — the ignore check runs first, and
        // a directory it prunes never reaches the skip list. That is the honest reading
        // (the rule did the work), and it is why the two counters cannot be added to
        // "everything missing".
        expect(result.excluded).toMatchObject({
            ignoredFiles: 3, // a.log, build/index.js, src/x.tmp (by the nested rule)
            prunedDirectories: 5, // dist/, Temp/, src/skip/, .git/, node_modules/
            skippedDirectories: 0
        });
        expect(result.note).toContain('excluded by .gitignore rules');
        expect(result.note).toContain('name such a directory as a root');
    });

    it('walks a directory an enclosing .gitignore ignores when it is named as the root', async () => {
        // `/Temp/` and `dist/` live in the .gitignore ABOVE these roots, and rules above
        // a root are never loaded (./gitignore.ts, "SCOPE: THE SEARCH ROOT"). Naming the directory IS
        // the request, so both roots answer.
        await expect(glob({ paths: ['Temp'] }).then((r) => r.files)).resolves.toEqual(['Temp/points.mts']);

        const dist = await glob({ paths: ['dist'] });

        expect(dist.files).toEqual(['dist/app.js']);

        // F2 regression. An earlier revision attached a "no .gitignore was read at or
        // below the root" paragraph to EVERY directory root that parsed no rule file, so
        // this call - and plain ones like `paths: ['src']` - came with advice about build
        // output that is not under the root at all. `buildNote` documents the opposite
        // contract ("an all-clean listing gets no note at all"), and nothing is withheld
        // here: the scope rule that paragraph explained is the documented behaviour
        // (./gitignore.ts "SCOPE: THE SEARCH ROOT"), pinned by the two assertions above
        // and the one below.
        expect(dist.excluded.ignoreFilesParsed).toBe(0);
        expect(dist.note).toBeUndefined();

        // Same rule the other way, one level deeper: `src/skip/` prunes the directory
        // from a root of '.', and is fully walked as a root of its own.
        await expect(glob({ paths: ['src/skip'] }).then((r) => r.files)).resolves.toEqual(['src/skip/b.ts']);
    });

    it('walks node_modules for a deliberate root, including a nested copy of it', async () => {
        // Two independent reasons this could return nothing: the root .gitignore's
        // `node_modules/` rule, and the walker's name skip list. `search.ts` answers both
        // by checking the RESOLVED root (./glob.ts `rootTargetsSkippedDirectory`) and
        // handing the walk `ALWAYS_SKIPPED_DIRECTORIES` instead, so only `.git` stays
        // pruned — which is why the nested `pkg/node_modules/` is listed as well.
        const result = await glob({ paths: ['node_modules'] });

        expect(result.files).toEqual([
            'node_modules/pkg/i.js',
            'node_modules/pkg/node_modules/dep/index.js'
        ]);
        // Named as a root, nothing is excluded at all: the enclosing rule is out of
        // scope, and the nested `node_modules` copy stays reachable because a root inside
        // a skipped name relaxes the list to `.git` alone. Which is what makes the answer
        // above trustworthy rather than accidental.
        expect(result.excluded).toMatchObject({
            ignoredFiles: 0,
            prunedDirectories: 0,
            skippedDirectories: 0
        });
    });

    it('re-includes a file with a later negation and still honors the ignore at other depths', async () => {
        // `*.log` matches at any depth (it has no '/'), so `a.log` and `src/keep.log` are
        // both excluded by it; `!keep.log` is slashless too, so it re-includes BOTH
        // `keep.log` and `src/keep.log`. An explicit pattern makes the pair observable
        // without repeating the whole listing.
        await expect(glob({ patterns: ['**/*.log'] }).then((r) => r.files)).resolves.toEqual([
            'keep.log',
            'src/keep.log'
        ]);
    });

    it('truncates against the gitignore-filtered listing, not the raw tree', async () => {
        // The cap counts what survives the ignore rules. Walk order is name-sorted
        // ('.gitignore' beats 'a.log', which is itself ignored), so the single surviving
        // first entry is the root .gitignore file and one extra match proves truncation.
        const result = await glob({ paths: ['.'], maxResults: 1 });

        expect(result.files).toEqual(['.gitignore']);
        expect(result.truncated).toBe(true);
        expect(result.nextOffset).toBe(1);

        // And the page resumes at exactly that entry, so paging walks the filtered
        // listing once with no duplicate and no gap.
        const rest = await glob({ paths: ['.'], maxResults: 10, offset: 1 });

        expect(rest.files).toEqual(['keep.log', 'keep.ts', 'src/.gitignore', 'src/a.ts', 'src/keep.log']);
    });
});

// Rules live in three different places at once, and each one reaches a different distance.
const SCOPE_FIXTURE: Record<string, string> = {
    // `ignoredDir/` prunes a subtree; `src/generated/` is an ANCHORED rule that only
    // makes sense from this root, so rooting at 'src' stops applying it.
    '.gitignore': '# scope rules\nignoredDir/\nsrc/generated/\n',
    // The nested file only speaks for its own subtree: it cannot hide the root's `x.tmp`.
    'src/.gitignore': '*.tmp\n',
    // Never read: git's documented limitation, pinned so changing it is deliberate.
    'ignoredDir/.gitignore': '!keep.ts\n',
    'ignoredDir/keep.ts': 'x\n',
    'keep.ts': 'x\n',
    'x.tmp': 'x\n',
    'src/keep.ts': 'x\n',
    'src/x.tmp': 'x\n',
    'src/nested/y.tmp': 'x\n',
    'src/generated/zone.ts': 'x\n'
};

describe('glob — .gitignore scope and pruning', () => {
    let fixture: string;
    let restoredCwd: string;

    beforeAll(async () => {
        restoredCwd = process.cwd();
        fixture = await createFixture('scope', SCOPE_FIXTURE);
        process.chdir(fixture);
    });

    afterAll(async () => {
        process.chdir(restoredCwd);
        await rm(fixture, { recursive: true, force: true });
    });

    it('applies a nested .gitignore only inside its own subtree', async () => {
        // `src/.gitignore` says `*.tmp`, and that reaches `src/x.tmp` plus
        // `src/nested/y.tmp` but never the root-level `x.tmp` sibling — a rule is scoped
        // to the directory that owns the file (./gitignore.ts `scopeRelativePath`).
        await expect(glob({ paths: ['.'], maxResults: 100 }).then((r) => r.files)).resolves.toEqual([
            '.gitignore',
            'keep.ts',
            'src/.gitignore',
            'src/keep.ts',
            'x.tmp'
        ]);
    });

    it('applies a .gitignore that sits AT the root to that root', async () => {
        // The same `src/.gitignore` now belongs to the root itself, so `x.tmp` is hidden
        // here even though the '.' walk keeps the root's own `x.tmp`. The anchored
        // `src/generated/` rule lives one level ABOVE this root and is never loaded, so
        // `src/generated/zone.ts` is reachable — the scoping cuts both ways.
        await expect(glob({ paths: ['src'], maxResults: 100 }).then((r) => r.files)).resolves.toEqual([
            'src/.gitignore',
            'src/generated/zone.ts',
            'src/keep.ts'
        ]);
    });

    it('prunes an ignored directory so its own .gitignore is never consulted', async () => {
        // `ignoredDir/` is ignored by the root file, and `ignoredDir/.gitignore` tries to
        // re-include `!keep.ts`. Git documents that a negation cannot rescue a file under
        // an excluded directory, and neither can this matcher: the walker prunes the
        // directory before reading it (./glob.ts `walkFiles`, which prunes on
        // `ignores.isIgnored` before it ever calls `ignores.load` for that subtree).
        await expect(glob({ patterns: ['**/keep.ts'] }).then((r) => r.files)).resolves.toEqual([
            'keep.ts',
            'src/keep.ts'
        ]);

        // Named as a root, that same directory is walked: the ignoring rule is above it,
        // and its own `!keep.ts` now has nothing to negate.
        await expect(glob({ paths: ['ignoredDir'] }).then((r) => r.files)).resolves.toEqual([
            'ignoredDir/.gitignore',
            'ignoredDir/keep.ts'
        ]);
    });

    it('keeps a bare walkFiles call ignore-free', async () => {
        // The opt-in is an option, not a default: `walkFiles(root)` without a matcher
        // still means "every reachable regular file" (./glob.ts `walkFiles`, whose
        // `ignores` option is opt-in), which is
        // what the tools that never pass `ignores` depend on. Same tree, same order,
        // nothing excluded — including the three files the assertions above hide.
        await expect(collectWalk(walkFiles('.'))).resolves.toEqual([
            '.gitignore',
            'ignoredDir/.gitignore',
            'ignoredDir/keep.ts',
            'keep.ts',
            'src/.gitignore',
            'src/generated/zone.ts',
            'src/keep.ts',
            'src/nested/y.tmp',
            'src/x.tmp',
            'x.tmp'
        ]);
    });

    it('counts what a bare walk dropped only when the caller asks for counters', async () => {
        // The counters are an opt-in on the walker, so a bare `walkFiles` pays nothing.
        // Passing a stats object is what ./search.ts does for both presets, and the
        // numbers it publishes come from here.
        const counted = await collectWalk(walkFiles('.'));

        expect(counted).toHaveLength(10);
    });

    it('yields a file root as its own basename', async () => {
        // "Search this file" reaches the walker too, not just the presets: a bare
        // `walkFiles('keep.ts')` used to throw `ENOTDIR` from `readdir`.
        await expect(collectWalk(walkFiles('keep.ts'))).resolves.toEqual(['keep.ts']);
    });
});

describe('glob — a tree with nothing to ignore', () => {
    let fixture: string;
    let restoredCwd: string;

    beforeAll(async () => {
        restoredCwd = process.cwd();
        fixture = await createFixture('plain', {
            'a.ts': 'x\n',
            'docs/note.md': 'x\n',
            'nested/b.ts': 'x\n',
            // Still skipped, by name, with no .gitignore in the tree to say so.
            '.git/HEAD': 'x\n',
            'node_modules/pkg/index.js': 'x\n'
        });
        process.chdir(fixture);
    });

    afterAll(async () => {
        process.chdir(restoredCwd);
        await rm(fixture, { recursive: true, force: true });
    });

    it('returns every file when no .gitignore exists at or below the root', async () => {
        // The loader treats a missing file as "no rules" (./gitignore.ts `load`, whose
        // failed read is swallowed),
        // so an absent .gitignore changes nothing about the listing — and the two
        // name-skipped seeds stay skipped on the name rule alone.
        const result = await glob({ paths: ['.'], maxResults: 100 });

        expect(result.files).toEqual(['a.ts', 'docs/note.md', 'nested/b.ts']);
        expect(result.excluded).toEqual({
            ignoredFiles: 0,
            prunedDirectories: 0,
            skippedDirectories: 2,
            unreadableDirectories: 0,
            symlinks: 0,
            ignoreFilesParsed: 0,
            ignoreRulesTruncated: false
        });

        // F2 regression: the only clause this note carries is the one that names
        // something the caller can act on (the two name-skipped directories). An earlier
        // revision ALSO appended a "no .gitignore was read at or below the root"
        // paragraph here, purely because the walk parsed no rule file - which contradicted
        // `buildNote`'s documented contract ("an all-clean listing gets no note at all and
        // its absence is information too") and told the caller to go root somewhere else
        // when the listing was already complete. The whole note is therefore asserted
        // verbatim: a re-added clause makes this fail.
        expect(result.note).toBe(
            '2 directories were skipped by name (.git, node_modules) - root the search inside one to walk it'
        );
    });

    it('says nothing for an ordinary subdirectory root that owns no .gitignore', async () => {
        // F2 regression, the shape the noisy clause hit most often: a plain subdirectory
        // with no rule file at or below it. The answer needs no explanation - the walk is
        // complete, `excluded` counts everything it did not yield, and
        // `excluded.ignoreFilesParsed: 0` is a fact rather than an action. The scope rule
        // itself (rules ABOVE a root never apply) stays documented in the tool
        // description and is pinned by the ".gitignore rules at the search root" describe.
        const result = await glob({ paths: ['nested'] });

        expect(result.files).toEqual(['nested/b.ts']);
        expect(result.excluded.ignoreFilesParsed).toBe(0);
        expect(result.note).toBeUndefined();
    });
});

describe('glob — a .gitignore that is a directory', () => {
    let fixture: string;
    let restoredCwd: string;

    beforeAll(async () => {
        restoredCwd = process.cwd();
        fixture = await createFixture('dirignore', {
            // The loader reads `<dir>/.gitignore`; here that path is a directory, so the
            // read fails with EISDIR and the walk must lose rules, not the search.
            '.gitignore/inner.ts': 'x\n',
            'a.ts': 'x\n',
            'nested/b.ts': 'x\n'
        });
        process.chdir(fixture);
    });

    afterAll(async () => {
        process.chdir(restoredCwd);
        await rm(fixture, { recursive: true, force: true });
    });

    it('treats a directory named .gitignore as ordinary content instead of throwing', async () => {
        await expect(glob({ paths: ['.'], maxResults: 100 }).then((r) => r.files)).resolves.toEqual([
            '.gitignore/inner.ts',
            'a.ts',
            'nested/b.ts'
        ]);
    });
});
