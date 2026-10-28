// The preset catalogue's static contract.
//
// This file pins what a UI, a docs page, or toolRequest sees WITHOUT executing a
// preset: the name order, the metadata validity rules, the batched file schemas,
// and the unified fileGlob contract. It never calls an implementation — that is
// the point of R1b.
//
// T14: every wire name is `<namespace><action>`, and there are no legacy aliases.
// A separate `searchFiles` tool no longer exists: fileGlob covers filename and
// content search, so this file asserts its absence explicitly.

import { describe, expect, it } from 'vitest';
import { toolParameterKey, normalizeTags } from '../core/tool';
import { PRESET_TOOL_NAMES, PRESET_TOOLS } from './catalogue';
import { presetTools } from './index';

describe('preset catalogue', () => {
    it('lists the presets in a stable order', () => {
        expect(PRESET_TOOL_NAMES).toEqual([
            'syntaxCheck',
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileList',
            'fileGlob',
            'commandRun',
            'gitDiff'
        ]);
        expect(Object.keys(presetTools)).toEqual(PRESET_TOOL_NAMES);
    });

    it('publishes no legacy tool name at all', () => {
        // The breaking part of T14: the old names are gone from the table, so a
        // stale descriptor or a model guessing an old name cannot resolve.
        const legacy = [
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'globFiles',
            'searchFiles',
            'runCommand',
            'websearch',
            'requestTools',
            'createTool',
            'todoTools',
            'delegate'
        ];

        for (const name of legacy) {
            expect(PRESET_TOOLS).not.toHaveProperty(name);
            expect(presetTools).not.toHaveProperty(name);
        }
    });

    it('gives every preset a complete, normalized metadata row', () => {
        for (const name of PRESET_TOOL_NAMES) {
            const metadata = PRESET_TOOLS[name];

            expect(metadata.name).toBe(name);
            expect(metadata.description.length).toBeGreaterThan(0);
            expect(metadata.tags.length).toBeGreaterThan(0);
            // Already normalized, so the model-facing tags match what toolRequest sees.
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

    it('makes the four everyday file tools core and keeps fileList discoverable', () => {
        // R18: read/write/edit/glob are declared on every request; fileList is the
        // occasional directory survey and still waits for toolRequest. Exactly the
        // approved set and no fileSearch alias.
        for (const name of ['fileRead', 'fileWrite', 'fileEdit', 'fileGlob'] as const) {
            expect(PRESET_TOOLS[name].visibility).toBe('core');
            expect(presetTools[name].visibility).toBe('core');
        }

        expect('visibility' in PRESET_TOOLS.fileList).toBe(false);
        expect(presetTools.fileList.visibility).toBe('searchable');
        expect(PRESET_TOOLS).not.toHaveProperty('fileSearch');

        // syntaxCheck, commandRun and gitDiff share the same visibility default:
        // discovery is the only way to reach them.
        for (const name of ['syntaxCheck', 'commandRun', 'gitDiff'] as const) {
            expect(presetTools[name].visibility).toBe('searchable');
        }
    });

    it('declares the three batched file tools as ONE array property each', () => {
        // This is the schema half of the batching contract: one property means the
        // single-property rule hands `execute` the array itself.
        expect(toolParameterKey(PRESET_TOOLS.fileRead.parameters)).toBe('paths');
        expect(toolParameterKey(PRESET_TOOLS.fileWrite.parameters)).toBe('files');
        expect(toolParameterKey(PRESET_TOOLS.fileEdit.parameters)).toBe('edits');

        // R9: fileList is the exception — its paged contract needs `offset`/`limit`
        // beside `paths`, so it is a multi-property object with no `required`. The
        // implementation (and the direct runner) still accept the legacy bare array.
        expect(toolParameterKey(PRESET_TOOLS.fileList.parameters)).toBeUndefined();
        expect(Object.keys(PRESET_TOOLS.fileList.parameters.properties ?? {})).toEqual([
            'paths',
            'offset',
            'limit'
        ]);

        expect(PRESET_TOOLS.fileRead.parameters.required).toEqual(['paths']);
        expect(PRESET_TOOLS.fileWrite.parameters.required).toEqual(['files']);
        expect(PRESET_TOOLS.fileEdit.parameters.required).toEqual(['edits']);
        // fileList has no `required`: the documented default is ["."].
        expect('required' in PRESET_TOOLS.fileList.parameters).toBe(false);

        expect(PRESET_TOOLS.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        expect(PRESET_TOOLS.fileWrite.tags).toEqual(['files', 'write', 'filesystem']);
        expect(PRESET_TOOLS.fileEdit.tags).toEqual(['files', 'edit', 'write', 'replace', 'filesystem']);
        expect(PRESET_TOOLS.fileList.tags).toEqual(['files', 'list', 'filesystem']);
    });

    it('pins the batched entry shapes', () => {
        expect(PRESET_TOOLS.fileWrite.parameters).toEqual({
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'Path to the file, absolute or relative to the working directory.'
                            },
                            content: {
                                type: 'string',
                                description: 'Full text to write. Replaces the previous contents.'
                            }
                        },
                        required: ['path', 'content'],
                        additionalProperties: false
                    },
                    description: 'Files to write, in the order the results are returned.'
                }
            },
            required: ['files'],
            additionalProperties: false
        });

        expect(PRESET_TOOLS.fileEdit.parameters).toEqual({
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description:
                                    'Path to an existing file, absolute or relative to the working directory.'
                            },
                            oldString: {
                                type: 'string',
                                description: 'Exact text to replace. Must be unique unless replaceAll is true.'
                            },
                            newString: {
                                type: 'string',
                                description: 'Replacement text. May be empty to delete the matched text.'
                            },
                            replaceAll: {
                                type: 'boolean',
                                description:
                                    'Replace every occurrence instead of requiring oldString to be unique. Defaults to false.'
                            }
                        },
                        required: ['path', 'oldString', 'newString'],
                        additionalProperties: false
                    },
                    description: 'Edits to apply, one per file, in the order the results are returned.'
                }
            },
            required: ['edits'],
            additionalProperties: false
        });
    });

    it('unifies glob and content search into one fileGlob tool', () => {
        // One entry with FOUR properties, so the single-property rule does NOT
        // apply and `execute` receives the whole object.
        expect(PRESET_TOOLS.fileGlob.tags).toEqual([
            'files',
            'glob',
            'search',
            'grep',
            'find',
            'content',
            'filesystem'
        ]);
        expect(Object.keys(PRESET_TOOLS.fileGlob.parameters.properties)).toEqual([
            'patterns',
            'paths',
            'content',
            'maxResults'
        ]);
        // Every argument is optional: the documented defaults are ["**/*"] and ["."].
        expect('required' in PRESET_TOOLS.fileGlob.parameters).toBe(false);
        expect(toolParameterKey(PRESET_TOOLS.fileGlob.parameters)).toBeUndefined();

        // The description IS the contract the model reads, so the two result shapes
        // and the mode rule have to be stated there.
        expect(PRESET_TOOLS.fileGlob.description).toContain('{ files, truncated }');
        // U11: the documented content-mode shape carries the per-match bounds, not
        // top-level `textTruncated` (see fileGlob.ts FileGlobMatch).
        expect(PRESET_TOOLS.fileGlob.description).toContain(
            'matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget'
        );
        expect(PRESET_TOOLS.fileGlob.description).toContain('Does not read .gitignore files.');
    });

    it('keeps gitDiff unchanged and every argument optional', () => {
        expect(PRESET_TOOLS.gitDiff.tags).toEqual(['git', 'diff', 'vcs', 'review', 'command']);
        expect('required' in PRESET_TOOLS.gitDiff.parameters).toBe(false);
        expect(PRESET_TOOLS.commandRun.tags).toEqual(['shell', 'command', 'process']);
        expect(PRESET_TOOLS.commandRun.parameters.required).toEqual(['command']);
    });

    it('does not claim a sandbox or gitignore support it does not implement', () => {
        // The descriptions are the contract the model reads; wording that implies a
        // fence must not creep in. .gitignore is explicitly documented as unread.
        expect(PRESET_TOOLS.fileGlob.description).toContain('Does not read .gitignore files.');
        expect(PRESET_TOOLS.gitDiff.description).toContain('Read-only');
        expect(PRESET_TOOLS.gitDiff.description).toContain('non-zero exit is data, not an error');
    });
});

// Structural equality for JSON data (schemas are plain objects/arrays).
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
