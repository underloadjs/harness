// The preset catalogue's static contract.
//
// This file pins what a UI, a docs page, or toolRequest sees WITHOUT executing a
// preset: the name order, the metadata validity rules, the batched file schemas,
// and the two search surfaces. It never calls an implementation — that is the point
// of R1b.
//
// T14: every wire name is `<namespace><action>`, and there are no legacy aliases.
// A separate `searchFiles` tool no longer exists: fileGlob covers filename and
// content search, so this file asserts its absence explicitly. The rename splits that
// one tool in two — `glob` answers with NAMES and `grep` with matching LINES — and
// `fileWrite` becomes `write` and `syntaxCheck` becomes `syntax`, again with no
// aliases, so this file pins both halves separately.

import { describe, expect, it } from 'vitest';
import { toolParameterKey, normalizeTags } from '../core/tool';
import { PRESET_TOOL_NAMES, PRESET_TOOLS } from './catalogue';
import { presetTools } from './index';

describe('preset catalogue', () => {
    it('lists the presets in a stable order', () => {
        expect(PRESET_TOOL_NAMES).toEqual([
            'syntax',
            'read',
            'write',
            'edit',
            'fileList',
            'glob',
            'grep',
            'shell',
            'gitDiff',
            // R3/R4: byte retrieval with the multimodal hand-off. Order 235 —
            // after gitDiff (230), before the web provider rows (240/250).
            'download'
        ]);
        expect(Object.keys(presetTools)).toEqual(PRESET_TOOL_NAMES);
    });

    it('publishes no legacy tool name at all', () => {
        // The breaking part of T14, and of the rename: the old names are gone from the
        // table, so a stale descriptor or a model guessing an old name cannot resolve.
        const legacy = [
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'globFiles',
            'searchFiles',
            'fileWrite',
            'fileGlob',
            'fileSearch',
            'syntaxCheck',
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

    it('publishes syntax as one searchable, language-named preset', () => {
        // R3: the language set grew (typescript/tsx/jsx/json joined javascript and
        // python) and `language` is a free name, so the schema has NO enum — an
        // unsupported name is a runtime error, which the description states.
        expect(PRESET_TOOLS.syntax.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'typescript',
            'json',
            'python',
            'validation'
        ]);
        expect(PRESET_TOOLS.syntax.parameters).toEqual({
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Source code to check.' },
                language: {
                    type: 'string',
                    minLength: 1,
                    description:
                        'Language to parse the snippet as. Parsers exist for javascript (js), typescript (ts), tsx, jsx, json, python (py, python3); an alias is matched case-insensitively and a leading dot is allowed. Any other name is an error.'
                }
            },
            required: ['code', 'language'],
            additionalProperties: false
        });
        expect(presetTools.syntax.visibility).toBe('searchable');
    });

    it('makes the five everyday file tools core and keeps fileList discoverable', () => {
        // R18: read/write/edit/glob/grep are declared on every request; fileList is the
        // occasional directory survey and still waits for toolRequest. Exactly the
        // approved set and no fileSearch alias.
        for (const name of ['read', 'write', 'edit', 'glob', 'grep'] as const) {
            expect(PRESET_TOOLS[name].visibility).toBe('core');
            expect(presetTools[name].visibility).toBe('core');
        }

        expect('visibility' in PRESET_TOOLS.fileList).toBe(false);
        expect(presetTools.fileList.visibility).toBe('searchable');
        expect(PRESET_TOOLS).not.toHaveProperty('fileSearch');

        // R9-R11: `download` registers with the package presets but is SEARCHABLE,
        // so both projections must say so: the live compiled entry and the static
        // catalogue that reads the GENERATED manifest (`npm run tools:manifest`).
        // The earlier T8/F1 `core` claim is superseded: download is demand-discovered
        // through toolRequest, exactly like syntax/shell/gitDiff.
        expect(PRESET_TOOLS.download.visibility).toBe('searchable');
        expect(presetTools.download.visibility).toBe('searchable');

        // syntax, shell and gitDiff share the same visibility default:
        // discovery is the only way to reach them.
        for (const name of ['syntax', 'shell', 'gitDiff'] as const) {
            expect(presetTools[name].visibility).toBe('searchable');
        }
    });

    it('declares the three batched file tools as ONE array property each', () => {
        // This is the schema half of the batching contract: one property means the
        // single-property rule hands `execute` the array itself.
        expect(toolParameterKey(PRESET_TOOLS.read.parameters)).toBe('paths');
        expect(toolParameterKey(PRESET_TOOLS.write.parameters)).toBe('files');
        expect(toolParameterKey(PRESET_TOOLS.edit.parameters)).toBe('edits');

        // R9: fileList is the exception — its paged contract needs `offset`/`limit`
        // beside `paths`, so it is a multi-property object with no `required`. The
        // implementation (and the direct runner) still accept the legacy bare array.
        expect(toolParameterKey(PRESET_TOOLS.fileList.parameters)).toBeUndefined();
        expect(Object.keys(PRESET_TOOLS.fileList.parameters.properties ?? {})).toEqual([
            'paths',
            'offset',
            'limit'
        ]);

        expect(PRESET_TOOLS.read.parameters.required).toEqual(['paths']);
        expect(PRESET_TOOLS.write.parameters.required).toEqual(['files']);
        expect(PRESET_TOOLS.edit.parameters.required).toEqual(['edits']);
        // fileList has no `required`: the documented default is ["."].
        expect('required' in PRESET_TOOLS.fileList.parameters).toBe(false);

        expect(PRESET_TOOLS.read.tags).toEqual(['files', 'read', 'filesystem']);
        expect(PRESET_TOOLS.write.tags).toEqual(['files', 'write', 'filesystem']);
        expect(PRESET_TOOLS.edit.tags).toEqual(['files', 'edit', 'write', 'replace', 'filesystem']);
        expect(PRESET_TOOLS.fileList.tags).toEqual(['files', 'list', 'filesystem']);
    });

    it('pins the batched entry shapes', () => {
        expect(PRESET_TOOLS.write.parameters).toEqual({
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

        expect(PRESET_TOOLS.edit.parameters).toEqual({
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
                    description:
                        'Edits to apply, in the order the results are returned. Several entries may name the same file; they are applied in array order.'
                }
            },
            required: ['edits'],
            additionalProperties: false
        });
    });

    it('splits search into glob for names and grep for contents', () => {
        // Both entries declare SEVERAL properties, so the single-property rule does
        // NOT apply and `execute` receives the whole object.
        expect(PRESET_TOOLS.glob.tags).toEqual(['files', 'glob', 'find', 'paths', 'filesystem']);
        // `offset` joins the list because a capped search is now resumable, the way read
        // and fileList already were.
        expect(Object.keys(PRESET_TOOLS.glob.parameters.properties)).toEqual([
            'patterns',
            'paths',
            'maxResults',
            'offset'
        ]);
        // Every glob argument is optional: the documented defaults are ["**/*"] and ["."].
        expect('required' in PRESET_TOOLS.glob.parameters).toBe(false);
        expect(toolParameterKey(PRESET_TOOLS.glob.parameters)).toBeUndefined();

        // The description IS the contract the model reads: one shape for glob, and no
        // leftover `content` property that would resurrect the old mode switch.
        expect(PRESET_TOOLS.glob.description).toContain('{ files, truncated,');
        expect(PRESET_TOOLS.glob.description).toContain('names only, never file contents');
        // The honesty fields are part of the published contract, not an implementation
        // detail: a caller reads them to tell "nothing matched" from "something was
        // withheld".
        expect(PRESET_TOOLS.glob.description).toContain('excluded');
        expect(PRESET_TOOLS.glob.description).toContain('nextOffset');
        expect(PRESET_TOOLS.glob.parameters.properties).not.toHaveProperty('content');

        expect(PRESET_TOOLS.grep.tags).toEqual([
            'files',
            'grep',
            'search',
            'content',
            'regex',
            'filesystem'
        ]);
        // `offset` pages the result, `flags` carries what the source cannot, `output`
        // picks the verdict, and `context` makes a hit readable without a second call.
        expect(Object.keys(PRESET_TOOLS.grep.parameters.properties)).toEqual([
            'pattern',
            'patterns',
            'paths',
            'maxResults',
            'offset',
            'flags',
            'output',
            'context'
        ]);
        // `pattern` is the one property with no default; omitting it is an error
        // rather than a search that matches everything.
        expect(PRESET_TOOLS.grep.parameters.required).toEqual(['pattern']);
        expect(toolParameterKey(PRESET_TOOLS.grep.parameters)).toBeUndefined();

        // U11: the content shape carries the per-match bounds, not a top-level
        // `textTruncated` (see grep.tool.ts FileGrepMatch).
        expect(PRESET_TOOLS.grep.description).toContain(
            'Each hit is { path, line, text, textTruncated, bytes }'
        );
        expect(PRESET_TOOLS.grep.description).toContain(
            '{ "matches": [...], "truncated": boolean, "bytes": number, "contentBudget": number }'
        );
        expect(PRESET_TOOLS.grep.description).toContain('use glob for that');
    });

    it('keeps gitDiff unchanged and every argument optional', () => {
        expect(PRESET_TOOLS.gitDiff.tags).toEqual(['git', 'diff', 'vcs', 'review', 'command']);
        expect('required' in PRESET_TOOLS.gitDiff.parameters).toBe(false);
        expect(PRESET_TOOLS.shell.tags).toEqual(['shell', 'command', 'process']);
        expect(PRESET_TOOLS.shell.parameters.required).toEqual(['command']);
    });

    it('does not claim a sandbox and pins the gitignore wording glob and grep now publish', () => {
        // The descriptions are the contract the model reads. Two halves:
        //
        //   1. No fence wording may creep in — glob/grep resolve roots against the
        //      process working directory (files/glob.tool.ts:65, files/grep.tool.ts:62),
        //      so neither description names a sandbox.
        //   2. Both search surfaces now CONSULT `.gitignore` at or below each root
        //      (files/gitignore.ts, policy note in files/glob.tool.ts:61-63 and
        //      files/grep.tool.ts:57-59). The pre-gitignore claim "Does not read
        //      .gitignore files" is therefore gone, and the replacement wording is
        //      pinned verbatim so an edit that quietly drops it fails here.
        for (const name of ['glob', 'grep'] as const) {
            expect(PRESET_TOOLS[name].description).not.toContain('sandbox');

            // Shared ignore rule, identical in both rows (glob.tool.ts:142, grep.tool.ts:212).
            expect(PRESET_TOOLS[name].description).toContain('Reads .gitignore files at or below each root');
            expect(PRESET_TOOLS[name].description).not.toContain('Does not read .gitignore files');
        }

        // glob's own skip sentence plus the glob-specific half of the ignore rule:
        // an ignored path is not LISTED, and an explicitly named root is WALKED.
        expect(PRESET_TOOLS.glob.description).toContain(
            'Skips .git and symlinks, and skips node_modules unless a root is placed inside it.'
        );
        expect(PRESET_TOOLS.glob.description).toContain(
            'so an ignored path is not listed - while a root you name explicitly is walked even when an enclosing .gitignore ignores it.'
        );

        // The closing sentence is the names-only boundary of this tool; nothing is
        // appended after it, so a future rewrite that moves or extends it fails.
        expect(PRESET_TOOLS.glob.description.endsWith('Does not search text.')).toBe(true);

        // grep's own skip sentence (it adds binary and size skips) and its half of the
        // ignore rule: an ignored path is never OPENED, and an explicitly named root
        // is SEARCHED.
        expect(PRESET_TOOLS.grep.description).toContain(
            'Skips .git, symlinks, binary files, and files larger than 1 MiB, and skips node_modules unless a root is placed inside it.'
        );
        expect(PRESET_TOOLS.grep.description).toContain(
            'so an ignored path is never opened - while a root you name explicitly is searched even when an enclosing .gitignore ignores it.'
        );
        expect(PRESET_TOOLS.grep.description.endsWith('Does not list file names (use glob for that).')).toBe(true);

        // The `paths` argument is where the explicit-root escape hatch is documented,
        // per tool: glob.tool.ts:160 says "walked", grep.tool.ts:237 says "searched".
        // `parameters` is Record<string, unknown> (core/tool-metadata.ts:45), so the
        // property map is narrowed to the shape the tool entries actually publish.
        const globPaths = PRESET_TOOLS.glob.parameters.properties as Record<string, { description: string }>;
        expect(globPaths.paths.description).toContain(
            'A root you name explicitly is walked even when a .gitignore above it ignores that directory.'
        );

        const grepPaths = PRESET_TOOLS.grep.parameters.properties as Record<string, { description: string }>;
        expect(grepPaths.paths.description).toContain(
            'A root you name explicitly is searched even when a .gitignore above it ignores that directory.'
        );

        // gitDiff's own claims are pinned in the same place: the read-only promise and
        // the exit-code policy.
        expect(PRESET_TOOLS.gitDiff.description).toContain('Read-only');
        expect(PRESET_TOOLS.gitDiff.description).toContain('non-zero exit is data, not an error');
    });
});

// Structural equality for JSON data (schemas are plain objects/arrays).
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
