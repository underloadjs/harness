// Composer @ / # pure logic (T5 R1/R2).
//
// Pins the token grammar, the query-aware file glob, the @ folder rows (folders
// come from `fileList`; `fileGlob` only yields files), the latest-label rule (the
// same rule the server applies to plain `#LABEL`) and the exact {turnId,
// threadId?, label} metadata a reference chip carries into a submit.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/references.test.ts

import { expect, it } from 'vitest';
import {
    referenceChipOf,
    fileChipOf,
    fileGlobPattern,
    fileListEntriesOf,
    filePathsOf,
    fileQueryScope,
    filterFilePathList,
    folderPathsOf,
    isReferenceableBlock,
    latestReferenceBlock,
    mentionTriggerAt,
    normalizeFileQuery,
    normalizeReferenceLabel,
    referenceOfBlock,
    referencesOfChips
} from './references';
import type { AgentBlockDescriptor, FileQueryScope } from './references';

const block = (overrides: Partial<AgentBlockDescriptor> = {}): AgentBlockDescriptor => ({
    turnId: 't1',
    label: 'IT1',
    agent: 'instruct',
    status: 'done',
    ...overrides
});

it('recognizes @ and # triggers at the caret and rejects glued ones', () => {
    expect(mentionTriggerAt('look @src/fr', 12)).toEqual({ kind: 'file', query: 'src/fr', start: 5 });
    expect(mentionTriggerAt('see #IT', 7)).toEqual({ kind: 'reference', query: 'IT', start: 4 });
    expect(mentionTriggerAt('#', 1)).toEqual({ kind: 'reference', query: '', start: 0 });

    // Whitespace ends an @ query; punctuation ends a # label.
    expect(mentionTriggerAt('mail @a b', 9)).toBeUndefined();
    expect(mentionTriggerAt('see #IT!', 8)).toBeUndefined();
    // Glued to a letter/digit is not a trigger (an email, C#).
    expect(mentionTriggerAt('name@host', 9)).toBeUndefined();
    expect(mentionTriggerAt('C#', 2)).toBeUndefined();
    expect(mentionTriggerAt('plain', 5)).toBeUndefined();
});

it('builds a narrowing glob instead of filtering a capped page', () => {
    expect(fileGlobPattern('')).toEqual(['**/*']);
    expect(fileGlobPattern('main')).toEqual(['**/*main*']);
    // A path query needs BOTH descendants and the path itself: `**/src/frontend*`
    // alone matches no file below `src/frontend`.
    expect(fileGlobPattern('src/frontend')).toEqual(['**/src/frontend*/**', '**/src/frontend*']);
    // A TRAILING SLASH means "drill into this folder" — it is exactly what picking
    // a folder row types (`@src/frontend/`), so only that folder's descendants are
    // candidates. The no-slash form above still means "name prefix".
    expect(fileGlobPattern('./src/frontend/')).toEqual(['**/src/frontend/**']);
    // Windows-style separators normalize to the posix paths fileGlob returns.
    expect(fileGlobPattern('.\\src\\frontend')).toEqual(['**/src/frontend*/**', '**/src/frontend*']);
    // Glob magic is escaped, so a query cannot widen the walk.
    expect(fileGlobPattern('a*b')).toEqual(['**/*a[*]b*']);
    expect(fileGlobPattern('src/x[1]')).toEqual(['**/src/x[[]1[]]*/**', '**/src/x[[]1[]]*']);
});

it('drills into a folder for a trailing-slash query', () => {
    // `@src/` is the folder row for src: descendants only, no `src*` sibling match.
    expect(fileGlobPattern('src/')).toEqual(['**/src/**']);
    expect(fileGlobPattern('src/frontend/')).toEqual(['**/src/frontend/**']);
    // A Windows-style trailing slash drills the same folder.
    expect(fileGlobPattern('.\\src\\frontend\\')).toEqual(['**/src/frontend/**']);
    // Glob magic is still escaped in the drilled walk.
    expect(fileGlobPattern('a*b/')).toEqual(['**/a[*]b/**']);
});

it('splits an @ query into the directory to list and the name prefix', () => {
    // An empty query is the repository ROOT overview; `fileList` takes '.'.
    expect(fileQueryScope('')).toEqual({ directory: '.', prefix: '' });
    // No slash: a name prefix within the root listing.
    expect(fileQueryScope('src')).toEqual({ directory: '.', prefix: 'src' });
    // Trailing slash: drill INTO that folder, no prefix.
    expect(fileQueryScope('src/')).toEqual({ directory: 'src', prefix: '' });
    // A leading `./` is stripped, the trailing slash still drills.
    expect(fileQueryScope('./src/')).toEqual({ directory: 'src', prefix: '' });
    // A partial entry name inside a listed directory.
    expect(fileQueryScope('src/frontend')).toEqual({ directory: 'src', prefix: 'frontend' });
    expect(fileQueryScope('src/frontend/')).toEqual({ directory: 'src/frontend', prefix: '' });
    // Windows-style separators normalize like the glob/filter.
    expect(fileQueryScope('.\\src\\fr')).toEqual({ directory: 'src', prefix: 'fr' });
    // A lone "/" normalizes to the root directory, never an empty directory name.
    expect(fileQueryScope('/')).toEqual({ directory: '.', prefix: '' });
});

it('reads `fileList` entries tolerantly', () => {
    // Folder rows keep their trailing slash; files are bare paths.
    expect(fileListEntriesOf({ entries: ['a', 'b/'] })).toEqual(['a', 'b/']);
    // A malformed entry list contributes only the strings.
    expect(fileListEntriesOf({ entries: [1, 'x', null] })).toEqual(['x']);
    // An error body / missing reply contributes no rows.
    expect(fileListEntriesOf(null)).toEqual([]);
    // `fileGlob`-shaped replies are not `fileList` replies.
    expect(fileListEntriesOf({ files: [] })).toEqual([]);
});

it('offers only immediate FOLDER rows matching the name prefix', () => {
    // Files and dot-folders: only trailing-slash entries survive, in input order.
    expect(folderPathsOf(['README.md', '.git/', 'src/', '.storybook/', 'src/a.ts'], { directory: '.', prefix: '' })).toEqual([
        '.git/',
        'src/',
        '.storybook/'
    ]);
    // The prefix filters entry NAMES (src matches "s", dist does not).
    expect(folderPathsOf(['src/', 'dist/', 'a.md'], { directory: '.', prefix: 's' })).toEqual(['src/']);
    // The prefix is case-insensitive, like `filterFilePathList`.
    expect(folderPathsOf(['src/', 'dist/'], { directory: '.', prefix: 'S' })).toEqual(['src/']);
    // Inside a listed directory `fileList` prefixes entries with that directory.
    expect(folderPathsOf(['src/ui/', 'src/frontend/', 'src/a.ts'], { directory: 'src', prefix: '' })).toEqual([
        'src/ui/',
        'src/frontend/'
    ]);
    // The prefix matches the entry NAME only, never an ancestor directory: the
    // `src` segment of `src/ui/` does not make it a row for the prefix `src`.
    expect(folderPathsOf(['src/ui/'], { directory: '.', prefix: 'src' })).toEqual([]);
    // `folderPathsOf` does NOT scope by `directory`: it trusts the caller, which
    // passes the entries `fileList` returned for that ONE directory. Both entries
    // are folders whose NAME starts with `ui`, so both are rows.
    const srcScope: FileQueryScope = { directory: 'src', prefix: 'ui' };
    expect(folderPathsOf(['src/ui/', 'lib/ui/'], srcScope)).toEqual(['src/ui/', 'lib/ui/']);
    // A repeated entry is one row.
    expect(folderPathsOf(['src/', 'src/'], { directory: '.', prefix: '' })).toEqual(['src/']);
});

it('marks completed and active blocks as referenceable only', () => {
    expect(isReferenceableBlock({ status: 'done' })).toBe(true);
    expect(isReferenceableBlock({ status: 'running' })).toBe(true);
    expect(isReferenceableBlock({ status: 'queued' })).toBe(true);
    expect(isReferenceableBlock({ status: 'error' })).toBe(false);
    expect(isReferenceableBlock({ status: 'cancelled' })).toBe(false);
});

it('reads file paths defensively and filters them for the exact query', () => {
    expect(filePathsOf({ files: ['a.ts', 'src/b.ts'], truncated: true })).toEqual(['a.ts', 'src/b.ts']);
    expect(filePathsOf({ matches: [] })).toEqual([]);
    expect(filePathsOf(null)).toEqual([]);
    expect(filePathsOf({ files: ['1', '2', '3'] }, 2)).toEqual(['1', '2']);

    expect(filterFilePathList(['src/main.ts', 'README.md', 'src/main.ts', 'src/other.ts'], 'MAIN')).toEqual([
        'src/main.ts'
    ]);
    // The filter normalizes exactly like the glob, so a real returned path survives
    // `@./src/frontend` and `@.\src\frontend`.
    expect(normalizeFileQuery('./src/frontend/')).toBe('src/frontend');
    expect(filterFilePathList(['src/frontend/main.ts', 'src/backend/x.ts'], './src/frontend')).toEqual([
        'src/frontend/main.ts'
    ]);
    expect(filterFilePathList(['src/frontend/main.ts', 'src/backend/x.ts'], '.\\src\\frontend')).toEqual([
        'src/frontend/main.ts'
    ]);
});

it('labels a block reference in uppercase and binds root vs nested exactly', () => {
    expect(normalizeReferenceLabel('#it1')).toBe('IT1');
    expect(normalizeReferenceLabel('Rh2')).toBe('RH2');

    expect(referenceOfBlock(block())).toEqual({ turnId: 't1', label: 'IT1' });
    expect(referenceOfBlock(block({ turnId: 't2', threadId: 'call:d1', label: 'RH1' }))).toEqual({
        turnId: 't2',
        threadId: 'call:d1',
        label: 'RH1'
    });

    expect(referenceChipOf(block())).toEqual({
        kind: 'reference',
        id: 'reference:t1::IT1',
        label: '#IT1',
        data: { referenceTurn: 't1', referenceLabel: 'IT1' }
    });
    expect(referenceChipOf(block({ threadId: 'call:d1', label: 'RH1' }))).toEqual({
        kind: 'reference',
        id: 'reference:t1:call:d1:RH1',
        label: '#RH1',
        data: { referenceTurn: 't1', referenceThread: 'call:d1', referenceLabel: 'RH1' }
    });
});

it('resolves the LATEST matching label across turns', () => {
    const blocks = [
        block({ turnId: 't1', threadId: 'root-1' }),
        block({ turnId: 't1', threadId: 'call:a', label: 'RH1', agent: 'research' }),
        block({ turnId: 't2' }),
        block({ turnId: 't2', threadId: 'call:b', label: 'RH1', agent: 'research' })
    ];

    // `IT1` is allocated again in t2: the newest block wins.
    expect(latestReferenceBlock(blocks, '#IT1')).toEqual(block({ turnId: 't2' }));
    expect(latestReferenceBlock(blocks, 'rh1')?.threadId).toBe('call:b');
    // Exact labels only: a future IT10 must not match IT1.
    expect(latestReferenceBlock([block({ label: 'IT10' })], 'IT1')).toBeUndefined();
});

it('rebuilds submit references from chips in document order without duplicates', () => {
    const chips = [
        { kind: 'reference', dataset: { referenceTurn: 't2', referenceLabel: 'IT1' } },
        { kind: 'file', dataset: { chipId: 'src/a.ts' } },
        { kind: 'reference', dataset: { referenceTurn: 't2', referenceThread: 'call:b', referenceLabel: 'RH1' } },
        // Same binding repeated: one wire entry.
        { kind: 'reference', dataset: { referenceTurn: 't2', referenceLabel: 'IT1' } },
        // Plain text has no metadata (the server resolves `#IT1` itself).
        { kind: 'reference', dataset: {} }
    ];

    expect(referencesOfChips(chips)).toEqual([
        { turnId: 't2', label: 'IT1' },
        { turnId: 't2', threadId: 'call:b', label: 'RH1' }
    ]);
});

it('serializes file chips as pointer tokens (no bytes)', () => {
    expect(fileChipOf('src/frontend/main.ts')).toEqual({
        kind: 'file',
        id: 'src/frontend/main.ts',
        label: '@src/frontend/main.ts'
    });
});
