// fileList — the paginated directory-listing contract.
//
// What this pins (R5):
//   - one call lists several directories, grouped in the CALLER's order, every entry
//     prefixed with the directory it came from;
//   - the result is a PAGE, not a bare array: `{ entries, truncated, nextOffset,
//     offset, limit, bytes, contentBudget }` — the intentional shape migration;
//   - `offset` indexes the deterministic FLAT list, so walking page by page with
//     `nextOffset` visits every entry exactly once, in order, with no gaps;
//   - bounds: 200 entries by default, 1000 maximum (clamped), and 64 KiB of UTF-8
//     entry text, which stops a page early with a correct `nextOffset`;
//   - legacy inputs keep working: a bare string, a string[], `null`, `{}`, and
//     `{ paths }` all mean the first page of the documented directories;
//   - an explicit empty array is rejected instead of answering `[]` (an empty result
//     would read as "the directory is empty"), and blank/NUL/non-string entries are
//     rejected before touching disk;
//   - the traversal stays NON-recursive: a child directory appears as "child/",
//     never as its contents. Recursion is fileGlob's job;
//   - a missing directory rejects the whole call instead of returning a partial
//     page, even when the missing directory lies past the requested window.
//
// Fixtures are real directories under the repo-root `Temp/` (never OS temp), one
// unique directory per run, removed afterwards. Module-relative so the location does
// not depend on the cwd Vitest was started from — the same convention as
// server/environment.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FILE_LIST_CONTENT_BUDGET,
    FILE_LIST_DEFAULT_LIMIT,
    FILE_LIST_MAX_LIMIT,
    fileList,
    paginateEntries
} from './fileList';

// Repo-root Temp/ (six levels up from src/tools/files/).
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

// Every fixture is seeded once in beforeAll, so each expected page below is a
// fixed literal rather than "whatever readdir happened to return".
const seed = async (relativePath: string, content = 'x\n'): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

// The fixture names in walk order, used by the pagination roundtrip below.
const HUGE_NAMES = Array.from({ length: 250 }, (_unused, index) => `f${String(index).padStart(3, '0')}.txt`);

beforeAll(async () => {
    previousCwd = process.cwd();
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-list-'));
    // chdir keeps the relative-directory assertions (and the default paths) about
    // the fixture tree, never about the repository.
    process.chdir(workdir);

    // Two sibling roots, each with a child directory so the trailing-slash
    // convention is visible next to a file entry.
    await seed('src/a.ts');
    await seed('src/B.ts');
    await seed('src/nested/deep/c.ts');
    await seed('task/b.ts');
    await seed('task/work/notes.md');
    await seed('root.txt');

    // 250 entries in one directory: more than the 200 default, fewer than the 1000
    // hard cap, so a two-page roundtrip exercises the real boundary.
    for (const name of HUGE_NAMES) await seed(join('big', name));
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

describe('fileList', () => {
    it('lists several directories in one call, prefixed and grouped', async () => {
        // Code-point order: "B.ts" < "a.ts" < "nested/" (uppercase first), and the
        // second directory's entries follow the first directory's whole listing.
        // Byte counts are UTF-8 lengths of the returned entries (8 + 8 + 11 + 9 + 10).
        await expect(fileList(['src', 'task'])).resolves.toEqual({
            entries: ['src/B.ts', 'src/a.ts', 'src/nested/', 'task/b.ts', 'task/work/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 46,
            contentBudget: 65536
        });
    });

    it('follows the caller order rather than sorting the directories', async () => {
        await expect(fileList(['task', 'src'])).resolves.toEqual({
            entries: ['task/b.ts', 'task/work/', 'src/B.ts', 'src/a.ts', 'src/nested/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 46,
            contentBudget: 65536
        });
    });

    it('stays non-recursive: a child directory is one entry, not a walk', async () => {
        const result = await fileList(['src']);

        expect(result.entries).toEqual(['src/B.ts', 'src/a.ts', 'src/nested/']);
        // The grandchild file under src/nested/deep is never listed.
        expect(result.entries).not.toContain('src/nested/deep/');
        expect(result.entries).not.toContain('src/nested/deep/c.ts');
    });

    it('defaults to the working directory and adds no prefix for "."', async () => {
        // "big/" (4) + "root.txt" (8) + "src/" (4) + "task/" (5) = 21 bytes.
        const expected = {
            entries: ['big/', 'root.txt', 'src/', 'task/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 21,
            contentBudget: 65536
        };

        await expect(fileList(undefined)).resolves.toEqual(expected);
        // Omitted and explicit ["."] are the same request.
        await expect(fileList(['.'])).resolves.toEqual(expected);
    });

    it('normalizes null, {}, and a { paths } wrapper to the same default page', async () => {
        // The server's direct-call route hands `execute` the parameter OBJECT as-is,
        // so an empty argument box arrives as `{}` (or `null`) rather than as
        // `undefined`. All of those mean "no preference", never an error.
        const expected = {
            entries: ['big/', 'root.txt', 'src/', 'task/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 21,
            contentBudget: 65536
        };

        await expect(fileList(null)).resolves.toEqual(expected);
        await expect(fileList({} as never)).resolves.toEqual(expected);
        // A model-shaped body ({ "paths": [...] }) is unwrapped here as well, so
        // both entry points agree.
        await expect(fileList({ paths: ['task'] } as never)).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/']
        });
        await expect(fileList({ paths: ['task', 'src'] } as never)).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/', 'src/B.ts', 'src/a.ts', 'src/nested/']
        });
    });

    it('rejects an unknown object property instead of silently ignoring a typo', async () => {
        // `offest` would otherwise return page 1 forever while the caller believed it
        // was paging, so every key outside paths/offset/limit is reported.
        await expect(fileList({ paths: ['src'], task: 'x' } as never)).rejects.toThrow(
            'fileList accepts only "paths", "offset", and "limit" in the object form.'
        );
        await expect(fileList({ offest: 200 } as never)).rejects.toThrow(
            'fileList accepts only "paths", "offset", and "limit" in the object form.'
        );
    });

    it('normalizes a redundant "./" and a trailing slash on the requested directory', async () => {
        // join() collapses both forms, so the prefix never doubles a separator.
        await expect(fileList(['./task'])).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/']
        });
        await expect(fileList(['task/'])).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/']
        });
    });

    it('accepts a bare string for a single directory (direct-call convenience)', async () => {
        await expect(fileList('task')).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/']
        });
    });

    it('rejects an explicit empty array instead of answering "nothing here"', async () => {
        // An empty result would read as "the directory is empty"; the error names
        // the fix (omit `paths` to list the working directory).
        await expect(fileList([])).rejects.toThrow(
            'fileList received an empty paths array. Omit paths to list the working directory.'
        );
    });

    it('rejects the whole call when one directory is missing', async () => {
        // No partial page: the first directory exists, but a truncated answer that
        // looks complete would be worse than an error.
        await expect(fileList(['src', 'missing'])).rejects.toThrow(/ENOENT/);
    });

    it('rejects a missing directory that lies past the requested window', async () => {
        // The window here covers only "src", but every requested directory is still
        // listed, so the missing one cannot be skipped just because the page ended.
        await expect(fileList({ paths: ['src', 'missing'], offset: 0, limit: 1 })).rejects.toThrow(
            /ENOENT/
        );
    });

    it('rejects blank, NUL, and non-string entries before touching disk', async () => {
        await expect(fileList([''])).rejects.toThrow('fileList paths must be non-empty strings.');
        await expect(fileList(['src', ''])).rejects.toThrow('fileList paths must be non-empty strings.');
        await expect(fileList(['sr\u0000c'])).rejects.toThrow(
            'fileList paths must not contain NUL characters.'
        );
        await expect(fileList([7] as never)).rejects.toThrow('fileList paths must be non-empty strings.');
        await expect(fileList(7 as never)).rejects.toThrow(
            'fileList expects an array of directories or an object with "paths", "offset", and "limit".'
        );
    });

    it('windows the flat list with the object form, in caller root order', async () => {
        // Flat list: src/B.ts, src/a.ts, src/nested/, task/b.ts, task/work/.
        // offset 2 + limit 2 returns entries 3 and 4 (11 + 9 = 20 bytes) and proves
        // there is more beyond them.
        await expect(fileList({ paths: ['src', 'task'], offset: 2, limit: 2 })).resolves.toEqual({
            entries: ['src/nested/', 'task/b.ts'],
            truncated: true,
            nextOffset: 4,
            offset: 2,
            limit: 2,
            bytes: 20,
            contentBudget: 65536
        });
    });

    it('reports a final page that fits exactly as not truncated', async () => {
        // offset 3 of a 5-entry list leaves exactly 2 entries: `limit: 2` is filled
        // with nothing beyond, so `truncated` must stay false and `nextOffset` null.
        await expect(fileList({ paths: ['src', 'task'], offset: 3, limit: 2 })).resolves.toEqual({
            entries: ['task/b.ts', 'task/work/'],
            truncated: false,
            nextOffset: null,
            offset: 3,
            limit: 2,
            bytes: 19,
            contentBudget: 65536
        });
    });

    it('returns an empty final page for an offset beyond the end', async () => {
        await expect(fileList({ paths: ['src'], offset: 99 })).resolves.toEqual({
            entries: [],
            truncated: false,
            nextOffset: null,
            offset: 99,
            limit: 200,
            bytes: 0,
            contentBudget: 65536
        });
    });

    it('clamps offset to 0 and limit into 1..1000, and rejects non-numeric paging values', async () => {
        // A negative offset is what a caller's own arithmetic can produce; the honest
        // answer is the first page.
        await expect(fileList({ paths: ['task'], offset: -5 })).resolves.toMatchObject({
            entries: ['task/b.ts', 'task/work/'],
            offset: 0
        });
        // Too large a limit is "as much as allowed", not an error.
        await expect(fileList({ paths: ['task'], limit: 5000 })).resolves.toMatchObject({
            limit: 1000
        });
        // Fractional values are floored; a limit below 1 becomes 1.
        await expect(fileList({ paths: ['task'], limit: 0.5 })).resolves.toMatchObject({
            limit: 1
        });
        // A non-number would silently restart at the default (and loop forever),
        // so it is reported.
        await expect(fileList({ paths: ['task'], offset: '2' } as never)).rejects.toThrow(
            'fileList offset must be a number when provided.'
        );
        await expect(fileList({ paths: ['task'], limit: '2' } as never)).rejects.toThrow(
            'fileList limit must be a number when provided.'
        );
    });

    it('pages a 250-entry directory through the default 200-entry limit with no gaps or duplicates', async () => {
        // Page 1: the first 200 names (12 bytes each → 2400 bytes).
        const first = await fileList(['big']);

        expect(first.entries).toEqual(HUGE_NAMES.slice(0, 200).map((name) => `big/${name}`));
        expect(first).toMatchObject({
            truncated: true,
            nextOffset: 200,
            offset: 0,
            limit: 200,
            bytes: 2400,
            contentBudget: 65536
        });

        // Page 2 resumes at exactly `nextOffset` and ends the listing.
        const second = await fileList({ paths: ['big'], offset: first.nextOffset as number });

        expect(second.entries).toEqual(HUGE_NAMES.slice(200).map((name) => `big/${name}`));
        expect(second).toMatchObject({
            truncated: false,
            nextOffset: null,
            offset: 200,
            limit: 200,
            bytes: 600,
            contentBudget: 65536
        });

        // The roundtrip reconstructs the whole listing, in order, once per entry.
        const roundtrip = [...first.entries, ...second.entries];
        expect(roundtrip).toEqual(HUGE_NAMES.map((name) => `big/${name}`));
        expect(new Set(roundtrip).size).toBe(250);
    });

    it('matches the unpaginated listing when one page is large enough', async () => {
        // limit 1000 covers all 250 entries: the same sequence, and no truncation.
        const whole = await fileList({ paths: ['big'], limit: 1000 });

        expect(whole.entries).toEqual(HUGE_NAMES.map((name) => `big/${name}`));
        expect(whole).toMatchObject({ truncated: false, nextOffset: null, bytes: 3000 });
    });

    it('declares the documented page bounds as exported constants', () => {
        expect(FILE_LIST_DEFAULT_LIMIT).toBe(200);
        expect(FILE_LIST_MAX_LIMIT).toBe(1000);
        expect(FILE_LIST_CONTENT_BUDGET).toBe(65536);
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        await expect(fileList.execute({ parameters: ['src'] })).resolves.toMatchObject({
            entries: ['src/B.ts', 'src/a.ts', 'src/nested/']
        });
    });
});

// The byte budget cannot be reached with 200 short real filenames, so it is pinned
// on the pure pager the tool uses: deterministic, platform-independent, and it
// exercises both the exact-fit and the stop-before-the-next-entry boundaries.
describe('fileList — aggregate byte budget (paginateEntries)', () => {
    it('stops BEFORE the entry that would cross 64 KiB and points at it', () => {
        // 300-byte entries: 218 fit (65400 bytes), the 219th would reach 65700.
        const entries = Array.from({ length: 300 }, (_unused, index) => {
            const suffix = String(index).padStart(3, '0');
            // Exactly 300 bytes: 297 pad characters plus 3 digits.
            return `${'_'.repeat(297)}${suffix}`;
        });

        const page = paginateEntries(entries, 0, 1000);

        expect(page).toEqual({
            entries: entries.slice(0, 218),
            truncated: true,
            nextOffset: 218,
            offset: 0,
            limit: 1000,
            bytes: 65400,
            contentBudget: 65536
        });

        // Resuming at `nextOffset` continues with the exact entry that did not fit
        // (no gap), and the remaining 82 entries fit the budget, so this page ends
        // the list.
        const resumed = paginateEntries(entries, page.nextOffset as number, 1000);

        expect(resumed.entries[0]).toBe(entries[218]);
        expect(resumed).toEqual({
            entries: entries.slice(218),
            truncated: false,
            nextOffset: null,
            offset: 218,
            limit: 1000,
            bytes: 24600,
            contentBudget: 65536
        });
    });

    it('refuses an entry that is itself larger than the budget instead of looping forever', () => {
        // An entry of 65537 bytes can never fit a 65536-byte page. The old arithmetic
        // returned `{ entries: [], truncated: true, nextOffset: offset }` — a
        // continuation that never advances — so the call is refused and names the
        // entry. offset 1 is used so the reported index is the ENTRY's index, not 0.
        const oversized = 'x'.repeat(FILE_LIST_CONTENT_BUDGET + 1);
        const entries = ['ok', oversized, 'also-ok'];

        expect(() => paginateEntries(entries, 1, 1000)).toThrow(
            `fileList entry at offset 1 is 65537 UTF-8 bytes, larger than the 65536-byte page budget, so it can never be returned. List a deeper directory so the entry prefix is shorter, or shorten the entry's name.`
        );
    });

    it('returns a single entry of exactly the budget bytes, and ends the list', () => {
        // 65536 bytes is the boundary the refusal above must NOT catch: it fits the
        // budget exactly, so it is an ordinary (if enormous) page.
        const entries = ['x'.repeat(FILE_LIST_CONTENT_BUDGET)];

        expect(paginateEntries(entries, 0, 1000)).toEqual({
            entries,
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 1000,
            bytes: 65536,
            contentBudget: 65536
        });
    });

    it('does not report truncation when the budget is reached on the last entry', () => {
        // 64 entries of exactly 1024 bytes = 65536 bytes, which is the budget itself.
        const entries = Array.from({ length: 64 }, () => 'x'.repeat(1024));

        expect(paginateEntries(entries, 0, 1000)).toEqual({
            entries,
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 1000,
            bytes: 65536,
            contentBudget: 65536
        });
    });
});
