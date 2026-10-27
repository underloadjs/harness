// The preset catalogue's static contract.
//
// This file pins what a UI, a docs page, or getTools sees WITHOUT executing a
// preset: the name order, the metadata validity rules, and the schemas of the new
// coding tools. It never calls an implementation — that is the point of R1b.

import { describe, expect, it } from 'vitest';
import { normalizeTags } from '../core/tool';
import { PRESET_TOOL_NAMES, PRESET_TOOLS } from './catalogue';
import { presetTools } from './index';

describe('preset catalogue', () => {
    it('lists the presets in a stable order', () => {
        expect(PRESET_TOOL_NAMES).toEqual([
            'javascriptSyntax',
            'pythonSyntax',
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'searchFiles',
            'globFiles',
            'runCommand',
            'gitDiff'
        ]);
        expect(Object.keys(presetTools)).toEqual(PRESET_TOOL_NAMES);
    });

    it('gives every preset a complete, normalized metadata row', () => {
        for (const name of PRESET_TOOL_NAMES) {
            const metadata = PRESET_TOOLS[name];

            expect(metadata.name).toBe(name);
            expect(metadata.description.length).toBeGreaterThan(0);
            expect(metadata.tags.length).toBeGreaterThan(0);
            // Already normalized, so the model-facing tags match what getTools sees.
            expect(normalizeTags(metadata.tags)).toEqual([...metadata.tags]);
            expect(metadata.parameters.type).toBe('object');
            expect(deepEqual(metadata.parameters, presetTools[name].parameters)).toBe(true);
        }
    });

    it('exposes metadata through the lazy proxies without renaming them', () => {
        for (const name of PRESET_TOOL_NAMES) {
            const metadata = PRESET_TOOLS[name];
            const proxy = presetTools[name];

            expect(proxy.name).toBe(name);
            expect(proxy.description).toBe(metadata.description);
            expect(proxy.tags).toEqual([...metadata.tags]);
            expect(proxy.visibility).toBe(metadata.visibility ?? 'searchable');
            expect(deepEqual(proxy.parameters, metadata.parameters)).toBe(true);
        }
    });

    it('publishes the new coding tools as searchable, fully described presets', () => {
        expect(PRESET_TOOLS.editFile.tags).toEqual(['files', 'edit', 'write', 'replace', 'filesystem']);
        expect(PRESET_TOOLS.editFile.parameters.required).toEqual(['path', 'oldString', 'newString']);

        expect(PRESET_TOOLS.searchFiles.tags).toEqual(['files', 'search', 'grep', 'content', 'filesystem']);
        expect(PRESET_TOOLS.searchFiles.parameters.required).toEqual(['pattern']);

        expect(PRESET_TOOLS.globFiles.tags).toEqual(['files', 'glob', 'search', 'find', 'filesystem']);
        expect(PRESET_TOOLS.globFiles.parameters.required).toEqual(['pattern']);

        expect(PRESET_TOOLS.gitDiff.tags).toEqual(['git', 'diff', 'vcs', 'review', 'command']);
        // Every gitDiff argument is optional: diffing the working tree needs none.
        expect('required' in PRESET_TOOLS.gitDiff.parameters).toBe(false);

        for (const name of ['editFile', 'searchFiles', 'globFiles', 'gitDiff'] as const) {
            expect(presetTools[name].visibility).toBe('searchable');
        }
    });

    it('does not claim a sandbox or gitignore support it does not implement', () => {
        // The descriptions are the contract the model reads; wording that implies a
        // fence must not creep in. .gitignore is explicitly documented as unread.
        expect(PRESET_TOOLS.searchFiles.description).toContain('Does not read .gitignore files.');
        expect(PRESET_TOOLS.globFiles.description).toContain('Does not read .gitignore files.');
        expect(PRESET_TOOLS.gitDiff.description).toContain('Read-only');
        expect(PRESET_TOOLS.gitDiff.description).toContain('non-zero exit is data, not an error');
    });
});

// Structural equality for JSON data (schemas are plain objects/arrays).
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
