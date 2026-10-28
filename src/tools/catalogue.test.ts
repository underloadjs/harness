// The preset catalogue's static contract.
//
// This file pins what a UI, a docs page, or requestTools sees WITHOUT executing a
// preset: the name order, the metadata validity rules, and the schemas of the new
// coding tools. It never calls an implementation — that is the point of R1b.

import { describe, expect, it } from 'vitest';
import { normalizeTags } from '../core/tool';
import { PRESET_TOOL_NAMES, PRESET_TOOLS } from './catalogue';
import { presetTools } from './index';

describe('preset catalogue', () => {
    it('lists the presets in a stable order', () => {
        expect(PRESET_TOOL_NAMES).toEqual([
            'syntaxCheck',
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
            // Already normalized, so the model-facing tags match what requestTools sees.
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
            expect(proxy.visibility).toBe('visibility' in metadata ? metadata.visibility : 'searchable');
            expect(deepEqual(proxy.parameters, metadata.parameters)).toBe(true);
        }
    });

    it('publishes syntaxCheck as one searchable, language-named preset', () => {
        expect(PRESET_TOOLS.syntaxCheck.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);
        expect(PRESET_TOOLS.syntaxCheck.parameters).toEqual({
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Source code to check.' },
                language: {
                    type: 'string',
                    enum: ['javascript', 'python'],
                    description: 'Language to parse the snippet as.'
                }
            },
            required: ['code', 'language'],
            additionalProperties: false
        });
        expect(presetTools.syntaxCheck.visibility).toBe('searchable');
    });

    it('keeps every preset searchable, including the six file tools', () => {
        // The latest scope: the whole catalogue goes through requestTools, so no
        // preset is declared up front. A descriptor's core list is harness-owned
        // only (requestTools/createTool/todoTools + delegate).
        for (const name of [
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'searchFiles',
            'globFiles'
        ] as const) {
            expect('visibility' in PRESET_TOOLS[name]).toBe(false);
            expect(presetTools[name].visibility).toBe('searchable');
        }

        expect(PRESET_TOOLS.editFile.tags).toEqual(['files', 'edit', 'write', 'replace', 'filesystem']);
        expect(PRESET_TOOLS.editFile.parameters.required).toEqual(['path', 'oldString', 'newString']);

        expect(PRESET_TOOLS.searchFiles.tags).toEqual(['files', 'search', 'grep', 'content', 'filesystem']);
        expect(PRESET_TOOLS.searchFiles.parameters.required).toEqual(['pattern']);

        expect(PRESET_TOOLS.globFiles.tags).toEqual(['files', 'glob', 'search', 'find', 'filesystem']);
        expect(PRESET_TOOLS.globFiles.parameters.required).toEqual(['pattern']);

        expect(PRESET_TOOLS.gitDiff.tags).toEqual(['git', 'diff', 'vcs', 'review', 'command']);
        // Every gitDiff argument is optional: diffing the working tree needs none.
        expect('required' in PRESET_TOOLS.gitDiff.parameters).toBe(false);

        // syntaxCheck, runCommand and gitDiff share the same visibility default:
        // discovery is the only way to reach them.
        for (const name of ['syntaxCheck', 'runCommand', 'gitDiff'] as const) {
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
