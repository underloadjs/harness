// @underload/harness tools/catalogue — the static half of every preset.
//
// WHY THIS FILE EXISTS
// --------------------
// A harness can be created (and a model prompted) without ever needing a tool's
// implementation. The interesting metadata — name, description, tags, schema — must
// therefore be readable without importing `node:fs`, `node:child_process`, or any
// other preset body. That is the whole point of R1b: keep the catalogue cheap to
// enumerate and load the body on first execution.
//
// This module is that static half. It has NO static import of an implementation
// module: `loadPresetTool()` reaches them through `import()`, so a bundler can
// code-split them and Node only evaluates the body when a tool is actually called.
//
// NAMING (T14): every wire name is `<namespace><action>` — fileRead, fileWrite,
// fileEdit, fileList, fileGlob, commandRun, gitDiff, syntaxCheck, webSearch. The
// namespace groups related tools for discovery; the action is what the model calls.
// The old names (readFile, writeFile, editFile, listFiles, globFiles, searchFiles,
// runCommand, websearch) are gone: there are no compatibility aliases, because a
// catalogue with two names for one tool makes discovery ambiguous.
//
// Single source of truth
// ----------------------
// Each implementation spreads its entry from `PRESET_TOOLS` into `tool({...})`,
// e.g. `files/fileRead.ts`:
//
//     tool<string[], FileReadResult>({ ...PRESET_TOOLS.fileRead, execute: ... })
//
// So the text a model reads and the tool that runs can never drift apart. Edit a
// description HERE, not in the implementation file.
//
// Cross-references:
//   - ./lazy        — the callable proxy built from one entry
//   - ./index       — builds the named exports + `presetTools` from this table
//   - ../core/tool  — normalizes tags and defines the Tool contract
//
// Discovery: EVERY entry is `searchable` (the tool() default). Searchable means
// the harness declares it only after toolRequest matches its tags, so the
// catalogue can grow without spending context. The only core tools are the
// harness-owned toolRequest/toolCreate/todoManage (plus agentDelegate for a primary
// with subagents); no preset — including the file tools — is declared up front.
// One discovery surface for the whole catalogue, so a file tool costs the same
// round trip as commandRun.

import type { Tool, ToolVisibility } from '../types';

// The metadata every preset must publish eagerly. Deliberately a subset of
// ToolConfiguration: `execute` is the only field that requires the implementation.
export type PresetToolMetadata = {
    // Wire name the model calls. Kept identical to the export and registry key.
    name: string;
    description: string;
    tags: readonly string[];
    // 'searchable' when omitted, matching tool()'s default.
    visibility?: ToolVisibility;
    parameters: Record<string, unknown>;
};

// The catalogue. Key order is the order `presetTools` is built in, which is the
// order the harness preloads — grouped syntax, files, command so the folder
// structure and the registry read the same way. No entry is core: the whole
// catalogue is declared only after toolRequest enables it.
//
// `as const` keeps literal tag tuples (so a parity test can compare them exactly)
// while `satisfies` proves every row is complete enough to become a Tool.
export const PRESET_TOOLS = {
    syntaxCheck: {
        name: 'syntaxCheck',
        description:
            'Check whether a code snippet parses, without executing it. Pass language "javascript" (JavaScript as a classic script: no import/export and no top-level await) or "python" (Python; needs a Python 3 interpreter on PATH). Returns true when the syntax is valid, false otherwise.',
        tags: ['code', 'syntax', 'javascript', 'python', 'validation'],
        // Two properties, so the single-property rule does not apply: execute
        // receives the whole { code, language } object, exactly what a direct
        // call passes.
        parameters: {
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
        }
    },
    // fileRead is BATCHED (T14): one property, an array of paths, so the
    // single-property rule hands execute the array itself and the result is an
    // ordered [{ path, content }] array. A missing file rejects the whole call.
    fileRead: {
        name: 'fileRead',
        description:
            'Read one or more UTF-8 text files and return their contents. Pass an array of paths and get an ordered array of { path, content } entries in the same order. One missing or unreadable path rejects the whole call, so a short answer never looks complete. Paths are absolute or relative to the working directory.',
        tags: ['files', 'read', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Files to read, absolute or relative to the working directory, in the order the results are returned.'
                }
            },
            required: ['paths'],
            additionalProperties: false
        }
    },
    // fileWrite is BATCHED (T14): one property, an array of { path, content }.
    // Every entry is validated and every target path resolved (and deduplicated)
    // before the first write; parent directories are created as needed.
    fileWrite: {
        name: 'fileWrite',
        description:
            'Write one or more UTF-8 text files, creating parent directories as needed and overwriting existing files. Pass an array of { path, content } entries and get an ordered array of { path, bytes } in the same order. Every entry is validated before anything is written, and the same target path twice is rejected. A write error part-way through is reported with the paths already completed: there is no rollback.',
        tags: ['files', 'write', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description:
                                    'Path to the file, absolute or relative to the working directory.'
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
        }
    },
    // fileEdit is BATCHED (T14): one property, an array of
    // { path, oldString, newString, replaceAll? }. ALL entries are read and
    // match-checked before the first write, so a bad entry leaves every file
    // untouched; duplicate targets are rejected.
    fileEdit: {
        name: 'fileEdit',
        description:
            'Replace text in one or more existing files. Pass an array of { path, oldString, newString } entries; oldString must match byte-for-byte and must appear exactly once unless replaceAll is true, so an ambiguous edit is rejected instead of changing the wrong place. Every entry is read and checked before anything is written, so one bad entry leaves every file unchanged. Returns an ordered array of { path, replacements, bytes }. Creates nothing: use fileWrite for new files.',
        tags: ['files', 'edit', 'write', 'replace', 'filesystem'],
        parameters: {
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
                                description:
                                    'Exact text to replace. Must be unique unless replaceAll is true.'
                            },
                            newString: {
                                type: 'string',
                                description:
                                    'Replacement text. May be empty to delete the matched text.'
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
        }
    },
    // fileList is BATCHED (T14): one property, an array of directories. Every
    // result is prefixed with its directory so a flat list stays readable.
    // Deliberately NOT recursive — fileGlob is the walking tool.
    //
    // T16: the documented default is an explicit `default: ["."]` as well as an
    // omitted `required`, and the implementation accepts the shapes an empty
    // argument box actually produces (`undefined`, `null`, `{}`) so a manual call
    // and a model call agree.
    fileList: {
        name: 'fileList',
        description:
            'List the immediate entries of one or more directories, non-recursively. Every result is prefixed with the directory it came from (e.g. ["src/a.ts", "src/nested/", "task/b.ts"]), directories end with a trailing slash so they are distinguishable from files, and entries are sorted. Pass several directories to survey them in one call; the default is ["."], which returns bare entry names.',
        tags: ['files', 'list', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    default: ['.'],
                    description:
                        'Directories to list, absolute or relative to the working directory, in the order the results are grouped. Defaults to ["."].'
                }
            },
            additionalProperties: false
        }
    },
    // fileGlob is the ONE search surface (T14): filename matching, plus an
    // optional content regex that switches the result shape. The description must
    // state the mode rule, because a model reads it and nothing else.
    //
    // T16 adds the two things a model got wrong from the old text: patterns are
    // relative to EACH root (results are root-prefixed, never absolute-matched),
    // and content matching is time-bounded, so an exponential pattern fails with a
    // message instead of hanging the call.
    fileGlob: {
        name: 'fileGlob',
        description:
            'Find files by glob pattern, and optionally search their contents in the same call. `patterns` (default ["**/*"]) supports *, ?, **, and [abc] classes; a pattern with no slash also matches file names at any depth. Patterns are matched against each file\'s path RELATIVE TO THE ROOT that found it, never against an absolute path, and every result is prefixed with that root: { "paths": ["src"], "patterns": ["**/*.ts"] } returns "src/a.ts" and "src/nested/b.ts". `paths` (default ["."]) lists the roots to walk, in order; overlapping roots and patterns are deduplicated by real file identity (a symlink alias or a case-alias root is walked once), so a file is reported once, under the first root that reached it. WITHOUT `content` the result is { files, truncated }. WITH `content` (a JavaScript regular expression) every file matching the patterns is read and each matching line is returned as { matches: [{ path, line, text }], truncated }; a pattern that backtracks past the 2-second matching budget is stopped with an error rather than allowed to hang. Content mode skips .git, node_modules, symlinks, binary files, and files larger than 1 MiB. Results are capped (100 by default) across all roots. Does not read .gitignore files.',
        tags: ['files', 'glob', 'search', 'grep', 'find', 'content', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                patterns: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Glob patterns, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"] or ["*.md", "*.txt"]. Defaults to ["**/*"].'
                },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Root directories to walk, absolute or relative to the working directory, in the order they are visited. Results are prefixed with the root that found them. Defaults to ["."].'
                },
                content: {
                    type: 'string',
                    description:
                        'JavaScript regular expression to match inside each file, e.g. "TODO|FIXME". Providing it switches the result from file paths to matching lines. Matching is time-bounded.'
                },
                maxResults: {
                    type: 'number',
                    description:
                        'Maximum files or matches to return across all roots. Defaults to 100 and is clamped to 1-100.'
                }
            },
            additionalProperties: false
        }
    },
    commandRun: {
        name: 'commandRun',
        description:
            'Run a shell command and return its exit code, stdout, and stderr. The command string is passed to the platform shell, so pipes, redirects, and quoting work. A non-zero exit code is returned as data, not thrown.',
        tags: ['shell', 'command', 'process'],
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run, e.g. "git status --short".' },
                cwd: {
                    type: 'string',
                    description: 'Working directory. Defaults to the directory the harness was started in.'
                }
            },
            required: ['command'],
            additionalProperties: false
        }
    },
    gitDiff: {
        name: 'gitDiff',
        description:
            'Show the unified diff of uncommitted changes in a git repository, with colour, external diff drivers, and textconv disabled. Optionally diff against a ref, the staged index, or a set of paths. Read-only: nothing is staged, committed, or written. Returns exit code, stdout, stderr, and truncation/timeout flags; a non-zero exit is data, not an error.',
        tags: ['git', 'diff', 'vcs', 'review', 'command'],
        parameters: {
            type: 'object',
            properties: {
                ref: {
                    type: 'string',
                    description: 'Commit, branch, or range to diff against, e.g. "HEAD~1", "main", or "main...HEAD". Must not start with "-".'
                },
                staged: {
                    type: 'boolean',
                    description: 'Diff the staged index instead of the working tree (git diff --staged). Defaults to false.'
                },
                paths: {
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    description: 'Path or paths to restrict the diff to. Passed after "--" so they are always pathspecs.'
                },
                cwd: {
                    type: 'string',
                    description: 'Repository working directory. Defaults to the directory the harness was started in.'
                }
            },
            additionalProperties: false
        }
    }
} as const satisfies Record<string, PresetToolMetadata>;

export type PresetToolName = keyof typeof PRESET_TOOLS;

// Every preset's name, in catalogue order. Used by tests and by tooling that only
// needs the list.
export const PRESET_TOOL_NAMES = Object.keys(PRESET_TOOLS) as PresetToolName[];

// Load one implementation. Every branch is a dynamic import: this function is the
// ONLY place the implementations are named, and evaluating this module does not
// evaluate any of them.
//
// Vite/Rollup turn each branch into its own chunk; the built package must ship
// those chunks alongside `dist/underload-harness.mjs` (they live in `dist/`, which
// package.json already includes). Turning on `inlineDynamicImports` would undo the
// split and hoist the Node built-in imports back to the entry, so don't.
export const loadPresetTool = (name: PresetToolName): Promise<Tool> => {
    switch (name) {
        case 'syntaxCheck':
            return import('./syntax/syntaxCheck').then((module) => module.syntaxCheck);
        case 'fileRead':
            return import('./files/fileRead').then((module) => module.fileRead);
        case 'fileWrite':
            return import('./files/fileWrite').then((module) => module.fileWrite);
        case 'fileEdit':
            return import('./files/fileEdit').then((module) => module.fileEdit);
        case 'fileList':
            return import('./files/fileList').then((module) => module.fileList);
        case 'fileGlob':
            return import('./files/fileGlob').then((module) => module.fileGlob);
        case 'commandRun':
            return import('./command/commandRun').then((module) => module.commandRun);
        case 'gitDiff':
            return import('./command/gitDiff').then((module) => module.gitDiff);
    }
};
