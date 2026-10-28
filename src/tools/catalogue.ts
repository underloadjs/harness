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
// Discovery (R18): the four everyday file tools — fileRead, fileWrite, fileEdit,
// fileGlob — are CORE, so they are declared on every request; fileList stays
// searchable (it is the occasional directory-survey tool, and fileGlob already
// covers filename/content search in one surface). syntaxCheck, commandRun and
// gitDiff stay searchable too. Every other entry keeps the tool() default.
//
// "core" here is a DECLARATION classification, not a session binding: these file
// tools have real standalone implementations, so the server's direct-call path
// still runs them without a sessionId (see harnesses/core.ts / server/api.ts).
// Only harness-owned tools (toolRequest/toolCreate/todoManage/agentDelegate) are
// sessionBound because only they mutate a session's harness.

import type { Tool, ToolVisibility } from '../types';

// The metadata every preset must publish eagerly. Deliberately a subset of
// ToolConfiguration: `execute` is the only field that requires the implementation.
export type PresetToolMetadata = {
    // Wire name the model calls. Kept identical to the export and registry key.
    name: string;
    description: string;
    tags: readonly string[];
    // Omitted means 'searchable' (tool()'s default); the four core file rows set
    // 'core' explicitly.
    visibility?: ToolVisibility;
    parameters: Record<string, unknown>;
};

// The catalogue. Key order is the order `presetTools` is built in, which is the
// order the harness preloads — grouped syntax, files, command so the folder
// structure and the registry read the same way. The four core file rows are
// declared immediately; the searchable remainder (fileList, syntaxCheck,
// commandRun, gitDiff) waits for toolRequest.
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
    // fileRead is BATCHED (T14): one property, an array of paths/ranges, so the
    // single-property rule hands execute the array itself. Per-path ranges stay on
    // the ITEM: a second top-level property would disable the single-property rule
    // and break every existing paths-only call. Reading is bounded by default (line
    // window + fixed aggregate content budget) because the harness has no output cap.
    fileRead: {
        name: 'fileRead',
        description:
            'Read a BOUNDED window of one or more UTF-8 text files. Each `paths` item is either a path string (defaults below) or { path, startLine, startColumn, maxLines }. Returns { files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, bytes }], truncated, bytes, contentBudget }. Defaults: startLine 1, startColumn 0, maxLines 200 (hard maximum 5000). `content` is raw text whose first line is file line `startLine`, so line numbering is metadata rather than prefixes. When an entry is truncated, request { path, startLine: nextLine, startColumn: nextColumn } to continue; nextColumn is 0 at a line boundary and non-zero only when a single huge line was cut mid-line. The whole batch shares a fixed 64 KiB UTF-8 CONTENT budget (not counting JSON escaping), split fairly between the requested files, and reading stops at that budget instead of loading huge files or lines wholesale. A call accepts at most 100 paths. One missing or unreadable path, or binary bytes (NUL or invalid UTF-8) encountered while streaming the file, rejects the whole call, so a short answer never looks complete. Binary detection covers decoded chunks, not the whole file beyond the last chunk read. A window at a deep line rescans from the start to count lines. Paths are absolute or relative to the working directory.',
        tags: ['files', 'read', 'filesystem'],
        // R18: everyday file access is core — always declared, never discovered.
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    path: {
                                        type: 'string',
                                        description:
                                            'File to read, absolute or relative to the working directory.'
                                    },
                                    startLine: {
                                        type: 'integer',
                                        minimum: 1,
                                        description: '1-based first line to return. Defaults to 1.'
                                    },
                                    startColumn: {
                                        type: 'integer',
                                        minimum: 0,
                                        description:
                                            '0-based UTF-8 byte offset within startLine, for continuing a giant line. Defaults to 0.'
                                    },
                                    maxLines: {
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: 5000,
                                        description:
                                            'Maximum lines to return. Defaults to 200 and is capped at 5000.'
                                    }
                                },
                                required: ['path'],
                                additionalProperties: false
                            }
                        ]
                    },
                    description:
                        'Files to read, in the order the results are returned. A string reads a default window; an object selects a line/byte range.'
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
        // R18: writing files is core, like the rest of the everyday file set.
        visibility: 'core',
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
        // R18: editing files is core, so a model never spends a discovery round on it.
        visibility: 'core',
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
    // fileList is BATCHED (T14) and PAGINATED (R9). The object schema carries the
    // paging cursor, so a model that hits a full page can continue instead of
    // believing the directory has 200 entries. Every result is prefixed with its
    // directory so a flat list stays readable; deliberately NOT recursive —
    // fileGlob is the walking tool.
    //
    // T16: the documented default is an explicit `default: ["."]` as well as an
    // omitted `required`, and the implementation accepts the shapes an empty
    // argument box actually produces (`undefined`, `null`, `{}`) so a manual call
    // and a model call agree. The direct runner additionally accepts the legacy
    // string/array argument (core/schema-validation.ts 'direct' mode).
    fileList: {
        name: 'fileList',
        description:
            'List the immediate entries of one or more directories, non-recursively, ONE PAGE at a time. Every entry is prefixed with the directory it came from (e.g. ["src/a.ts", "src/nested/", "task/b.ts"]), directories end with a trailing slash so they are distinguishable from files, and entries are sorted. Pass several directories to survey them in one call; the default is ["."], which returns bare entry names. The result is { entries, truncated, nextOffset, offset, limit, bytes, contentBudget }: a page holds at most 200 entries by default (maximum 1000) and at most 64 KiB of UTF-8 entry text, so when `truncated` is true pass `nextOffset` back as `offset` to read the rest. A missing or unreadable directory fails the whole call rather than returning a partial list.',
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
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        '0-based index into the flat entry list. Defaults to 0; use nextOffset from the previous page.'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 1000,
                    description: 'Maximum entries in this page, 1-1000. Defaults to 200.'
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
            'Find files by glob pattern, and optionally search their contents in the same call. `patterns` (default ["**/*"]) supports *, ?, **, and [abc] classes; a pattern with no slash also matches file names at any depth. Patterns are matched against each file\'s path RELATIVE TO THE ROOT that found it, never against an absolute path, and every result is prefixed with that root: { "paths": ["src"], "patterns": ["**/*.ts"] } returns "src/a.ts" and "src/nested/b.ts". `paths` (default ["."]) lists the roots to walk, in order; overlapping roots and patterns are deduplicated by real file identity (a symlink alias or a case-alias root is walked once), so a file is reported once, under the first root that reached it. WITHOUT `content` the result is { files, truncated }. WITH `content` (a JavaScript regular expression) every file matching the patterns is read and each matching line is returned as { matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget }; a pattern that backtracks past the 2-second matching budget is stopped with an error rather than allowed to hang. A matched line is reported as a 1024-byte UTF-8 snippet (that match carries `textTruncated` when the line was cut, and its `bytes` is the returned snippet size), and the whole content result shares a 64 KiB aggregate budget (top-level `bytes` / `contentBudget`). Content mode skips .git, node_modules, symlinks, binary files, and files larger than 1 MiB. Results are capped (100 by default) across all roots. Does not read .gitignore files.',
        tags: ['files', 'glob', 'search', 'grep', 'find', 'content', 'filesystem'],
        // R18: fileGlob is core because it is the ONE search surface (filename and
        // content). There is deliberately no fileSearch alias/tool: the previous
        // consolidation stays, and its functionality is now always declared.
        visibility: 'core',
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
            'Run a shell command and return its exit code, stdout, and stderr. The command string is passed to the platform shell, so pipes, redirects, and quoting work. A non-zero exit code is returned as data, not thrown. `timeoutMs` bounds the run (integer milliseconds, 1-600000, default 120000); a command that exceeds it is killed together with its process tree on a best-effort basis and the result reports `timedOut: true`. Output is capped at 128 KiB of stdout and 16 KiB of stderr, with `truncated: true` when either cap was applied, and an aborted run reports `aborted: true`.',
        tags: ['shell', 'command', 'process'],
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run, e.g. "git status --short".' },
                cwd: {
                    type: 'string',
                    description: 'Working directory. Defaults to the directory the harness was started in.'
                },
                timeoutMs: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 600000,
                    default: 120000,
                    description:
                        'Wall-clock limit in milliseconds, 1-600000. Defaults to 120000 (2 minutes); the process tree is killed when it is exceeded.'
                }
            },
            required: ['command'],
            additionalProperties: false
        }
    },
    gitDiff: {
        name: 'gitDiff',
        description:
            'Show the unified diff of uncommitted changes in a git repository, with colour, external diff drivers, and textconv disabled. Optionally diff against a ref, the staged index, or a set of paths. Read-only: nothing is staged, committed, or written. Returns exit code, stdout, stderr, and truncation/timeout flags; a non-zero exit is data, not an error. `stderrTruncated` reports that stderr was capped (16 KiB) and `aborted` that the run was cancelled.',
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
                    // Non-empty by contract: an empty pathspec list would read as
                    // "no restriction" while the caller asked for one.
                    oneOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', items: { type: 'string' }, minItems: 1 }
                    ],
                    description: 'Path or paths to restrict the diff to (at least one). Passed after "--" so they are always pathspecs.'
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
