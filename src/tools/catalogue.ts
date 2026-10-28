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
// Single source of truth
// ----------------------
// Each implementation spreads its entry from `PRESET_TOOLS` into `tool({...})`,
// e.g. `files/readFile.ts`:
//
//     tool<string, string>({ ...PRESET_TOOLS.readFile, execute: ... })
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
// the harness declares it only after requestTools matches its tags, so the
// catalogue can grow without spending context. The only core tools are the
// harness-owned requestTools/createTool/todoTools (plus delegate for a primary
// with subagents); no preset — including the file tools — is declared up front.
// This is the latest scope decision: one discovery surface for the whole
// catalogue, so a file tool costs the same round trip as runCommand.

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
// catalogue is declared only after requestTools enables it.
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
    readFile: {
        name: 'readFile',
        description:
            'Read a UTF-8 text file from disk and return its contents. Throws when the file does not exist or is not readable.',
        tags: ['files', 'read', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' }
            },
            required: ['path'],
            additionalProperties: false
        }
    },
    writeFile: {
        name: 'writeFile',
        description:
            'Write UTF-8 text to a file, creating parent directories as needed and overwriting an existing file. Returns the absolute path and the number of bytes written.',
        tags: ['files', 'write', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' },
                content: { type: 'string', description: 'Full text to write. Replaces the previous contents.' }
            },
            required: ['path', 'content'],
            additionalProperties: false
        }
    },
    editFile: {
        name: 'editFile',
        description:
            'Replace text in an existing file. oldString must match the file byte-for-byte and must appear exactly once unless replaceAll is true, so an ambiguous edit is rejected instead of changing the wrong place. Returns the absolute path, the replacement count, and the resulting byte size. Creates nothing: use writeFile for new files.',
        tags: ['files', 'edit', 'write', 'replace', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to an existing file, absolute or relative to the working directory.' },
                oldString: { type: 'string', description: 'Exact text to replace. Must be unique unless replaceAll is true.' },
                newString: { type: 'string', description: 'Replacement text. May be empty to delete the matched text.' },
                replaceAll: {
                    type: 'boolean',
                    description: 'Replace every occurrence instead of requiring oldString to be unique. Defaults to false.'
                }
            },
            required: ['path', 'oldString', 'newString'],
            additionalProperties: false
        }
    },
    listFiles: {
        name: 'listFiles',
        description:
            'List the immediate entries of a directory. Directories are returned with a trailing slash so they are distinguishable from files. Returns a sorted list of entry names, not full paths.',
        tags: ['files', 'list', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Directory to list, absolute or relative to the working directory. Defaults to ".".'
                }
            },
            additionalProperties: false
        }
    },
    searchFiles: {
        name: 'searchFiles',
        description:
            'Search file contents with a regular expression, returning one match per line. Skips .git, node_modules, symlinks, binary files, and files larger than 1 MiB. Results are capped (100 by default) and paths are relative to the search root with 1-based line numbers. Does not read .gitignore files.',
        tags: ['files', 'search', 'grep', 'content', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'JavaScript regular expression to match, e.g. "TODO|FIXME".' },
                path: {
                    type: 'string',
                    description: 'Directory to search, absolute or relative to the working directory. Defaults to ".".'
                },
                include: {
                    type: 'string',
                    description: 'Glob limiting which files are read, e.g. "*.ts" or "src/**/*.ts". Matches file names when the pattern has no slash.'
                },
                maxResults: {
                    type: 'number',
                    description: 'Maximum matches to return. Defaults to 100 and is clamped to 1–100.'
                }
            },
            required: ['pattern'],
            additionalProperties: false
        }
    },
    globFiles: {
        name: 'globFiles',
        description:
            'Find files by glob pattern. Supports *, ?, **, and [abc] classes; a pattern with no slash also matches file names at any depth. Skips .git, node_modules, and symlinks. Paths are relative to the search root, sorted, and capped (100 by default) with a truncated flag. Does not read .gitignore files.',
        tags: ['files', 'glob', 'search', 'find', 'filesystem'],
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.test.ts" or "*.md".' },
                path: {
                    type: 'string',
                    description: 'Directory to search, absolute or relative to the working directory. Defaults to ".".'
                },
                maxResults: {
                    type: 'number',
                    description: 'Maximum paths to return. Defaults to 100 and is clamped to 1–100.'
                }
            },
            required: ['pattern'],
            additionalProperties: false
        }
    },
    runCommand: {
        name: 'runCommand',
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
        case 'readFile':
            return import('./files/readFile').then((module) => module.readFile);
        case 'writeFile':
            return import('./files/writeFile').then((module) => module.writeFile);
        case 'editFile':
            return import('./files/editFile').then((module) => module.editFile);
        case 'listFiles':
            return import('./files/listFiles').then((module) => module.listFiles);
        case 'searchFiles':
            return import('./files/searchFiles').then((module) => module.searchFiles);
        case 'globFiles':
            return import('./files/globFiles').then((module) => module.globFiles);
        case 'runCommand':
            return import('./command/runCommand').then((module) => module.runCommand);
        case 'gitDiff':
            return import('./command/gitDiff').then((module) => module.gitDiff);
    }
};
