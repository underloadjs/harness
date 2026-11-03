// Real-glob check for the file-preview basename resolver (the "clicking a file
// shows nothing" fix, R11+).
//
// The dialog takes a resolver adapter; main.ts implements it with
// `callTool('glob', { patterns: filePreviewGlobPattern(name), paths: ['.'] })`.
// Mocking that pattern string is not enough — `**/<name>` has to be proven against
// the ACTUAL matcher, because the whole fix rests on two properties of
// src/tools/files/glob.ts:
//   1. `**/` can consume ZERO directories, so a file at the workspace root is found
//      (this is why the adapter needs no `["<name>"]` fallback pattern);
//   2. the pattern is anchored and case-sensitive, so `old-descriptors.ts` and
//      `Descriptors.ts` are NOT returned for `descriptors.ts`.
// So this file runs the real tool over a disposable tree under the repo-root Temp
// directory (the same shape as ui/references-fileglob.test.ts) and asserts the exact
// candidate list the dialog would show, plus the dialog end to end.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-preview-glob.test.ts

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { glob } from '../../tools/files/glob.tool';
import { filePreviewCandidatesOf, filePreviewGlobPattern, openFilePreview } from './file-preview';
import type { FilePreviewReader } from './file-preview';

// Locate the repo root regardless of whether vitest runs from the package root
// (`npm run test:frontend`) or the frontend root. Scratch always stays in root Temp.
const REPO_ROOT =
    [
        process.cwd(),
        resolve(process.cwd(), '../../..'),
        resolve(process.cwd(), '../../../..'),
        resolve(process.cwd(), '../../../../..')
    ].find((candidate) => existsSync(join(candidate, 'packages', 'underload', 'harness', 'package.json'))) ??
    process.cwd();
const TEMP_ROOT = join(REPO_ROOT, 'Temp', 'coding-ui-filepreview');

let root: string;

// The presentation the browser sees: with the real adapter the root is `'.'`, so
// `glob` returns root-prefixed RELATIVE posix paths (`src/x/d.ts`). Rooting the tool
// at an absolute scratch directory returns the same files prefixed with that
// directory, so the prefix is stripped here to reproduce the wire shape exactly.
const relativeFiles = (files: readonly string[]): string[] =>
    files.map((file) => relative(root, file).replace(/\\/g, '/'));

// One walk of the real tool for one bare name, in the browser's shape.
const globFilesFor = async (name: string): Promise<string[]> => {
    const result = await glob({
        patterns: filePreviewGlobPattern(name),
        paths: [root],
        maxResults: 100
    });
    expect(result.truncated).toBe(false);

    return relativeFiles(result.files);
};

beforeEach(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    root = await mkdtemp(join(TEMP_ROOT, 'resolver-'));

    const files = [
        // A root-level match: only `**/` matching zero directories finds this one.
        'descriptors.ts',
        'src/nested/descriptors.ts',
        'src/other/descriptors.ts',
        // Decoys a substring resolver would offer: they must never be candidates.
        'src/other/old-descriptors.ts',
        // A case decoy in its OWN directory: NTFS is case-insensitive, so
        // `Descriptors.ts` and `descriptors.ts` could not coexist as siblings.
        'src/case/Descriptors.ts',
        'src/other/notes.md'
    ];

    for (const path of files) {
        const full = join(root, ...path.split('/'));
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, `// ${path}\n`, 'utf8');
    }
});

afterEach(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.innerHTML = '';
    await rm(root, { recursive: true, force: true });
});

describe('the glob pattern the shell adapter sends', () => {
    it('finds the name at every depth and nothing else', async () => {
        // Sorted, because the tool answers in walk order and this assertion is about
        // the MATCH SET, not about the resolver's presentation order.
        expect((await globFilesFor('descriptors.ts')).sort()).toEqual([
            'descriptors.ts',
            'src/nested/descriptors.ts',
            'src/other/descriptors.ts'
        ]);
    });

    it('answers nothing for a name the tree does not contain', async () => {
        expect(await globFilesFor('missing.ts')).toEqual([]);
    });

    it('finds a unique name with exactly one entry', async () => {
        expect(await globFilesFor('notes.md')).toEqual(['src/other/notes.md']);
    });
});

describe('candidates built from a real glob answer', () => {
    it('keeps exact matches only, shallowest-first', async () => {
        expect(filePreviewCandidatesOf('descriptors.ts', await globFilesFor('descriptors.ts'))).toEqual([
            'descriptors.ts',
            'src/nested/descriptors.ts',
            'src/other/descriptors.ts'
        ]);
    });

    it('resolves a unique name to the one path the dialog will read', async () => {
        expect(filePreviewCandidatesOf('notes.md', await globFilesFor('notes.md'))).toEqual([
            'src/other/notes.md'
        ]);
    });
});

describe('openFilePreview against real glob answers', () => {
    const reader = (): FilePreviewReader =>
        vi.fn<FilePreviewReader>(async ({ path }) => ({
            files: [{ content: `// ${path}\n`, startLine: 1, endLine: 1, truncated: false }]
        }));

    const dialog = (): HTMLElement => {
        const found = document.querySelector<HTMLElement>('.dialog');
        if (found === null) throw new Error('missing dialog');
        return found;
    };

    // The adapter behind these cases walks a REAL tree, so the number of ticks until
    // the dialog settles is unknown (fs I/O, not a stubbed promise). Poll against a
    // deadline: a state that never arrives is a thrown failure, never a silent pass.
    const settled = async (done: () => boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (!done()) {
            if (Date.now() > deadline) throw new Error(`the preview never ${what}`);
            await new Promise((resolveTick) => setTimeout(resolveTick, 10));
        }
    };

    it('lists three real paths for an ambiguous name and opens the one clicked', async () => {
        const read = reader();
        const handle = openFilePreview('descriptors.ts', {
            read,
            resolve: async () => await globFilesFor('descriptors.ts')
        });
        await settled(() => dialog().querySelectorAll('.preview-candidate').length > 0, 'listed the candidates');

        expect(read).not.toHaveBeenCalled();
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('descriptors.ts · 3 files');
        expect(
            [...dialog().querySelectorAll<HTMLButtonElement>('.preview-candidate')].map(
                (button) => button.dataset.path
            )
        ).toEqual(['descriptors.ts', 'src/nested/descriptors.ts', 'src/other/descriptors.ts']);

        dialog()
            .querySelectorAll<HTMLButtonElement>('.preview-candidate')[1]
            ?.click();
        await settled(() => read.mock.calls.length > 0, 'read the picked candidate');

        expect(read).toHaveBeenCalledWith({
            path: 'src/nested/descriptors.ts',
            startLine: 1,
            maxLines: 200
        });
        await settled(() => dialog().querySelector('.preview-code code') !== null, 'rendered the picked file');
        expect(dialog().querySelector('.preview-code code')?.textContent).toBe(
            '// src/nested/descriptors.ts\n'
        );
        handle.close();
    });

    it('reads the single deep file a unique name resolves to', async () => {
        const read = reader();
        const handle = openFilePreview('notes.md', {
            read,
            resolve: async () => await globFilesFor('notes.md')
        });
        await settled(() => read.mock.calls.length > 0, 'read the resolved file');

        expect(read).toHaveBeenCalledWith({
            path: 'src/other/notes.md',
            startLine: 1,
            maxLines: 200
        });
        await settled(() => dialog().querySelector('.preview-meta') !== null, 'rendered the file');
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('src/other/notes.md');
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe(
            'src/other/notes.md · markdown · lines 1–1'
        );
        handle.close();
    });

    it('says not found for a name the real walk did not return', async () => {
        const read = reader();
        const handle = openFilePreview('missing.ts', {
            read,
            resolve: async () => await globFilesFor('missing.ts')
        });
        await settled(() => dialog().querySelector('.preview-error') !== null, 'reported not found');

        expect(read).not.toHaveBeenCalled();
        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'missing.ts was not found under the workspace root; the reference may be incomplete.'
        );
        handle.close();
    });
});
