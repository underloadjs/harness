// @underload/harness tools — the preset catalogue, grouped by capability.
//
// One file per tool, one folder per capability, so the folder reads as the list of
// what ships out of the box:
//
//   syntax/   syntaxCheck (javascript or python, named by the caller)
//   files/    fileRead, fileWrite, fileEdit, fileList, fileGlob
//   command/  commandRun, gitDiff
//   websearch/ webSearch — opt-in, per-harness (NOT in `presetTools`: it needs a
//             provider key, which belongs to one harness; see createWebSearchTool)
//
// NAMING (T14): every wire name is `<namespace><action>`. The four file tools and
// commandRun/webSearch were renamed; there are no aliases, because two names for
// one tool makes discovery ambiguous.
//
// Lazy, not eager (R1b)
// --------------------
// Importing this module does NOT import any implementation, and therefore does not
// load `node:fs`, `node:child_process`, `node:vm`, or a Python probe. Each export is
// a callable Tool proxy whose metadata comes from ./catalogue (static) and whose
// body is fetched by `import()` on first execution. That keeps a harness cheap to
// construct and a catalogue cheap to enumerate, while preserving the exact Tool
// contract the registry relies on:
//
//     await syntaxCheck({ code: 'print(1)', language: 'python' }); // true
//     await fileRead(['package.json']);                            // [{ path, content }]
//     await fileWrite([{ path: 'a.txt', content: 'hi' }]);         // [{ path, bytes }]
//     harness({ tools: { syntaxCheck, fileRead } });                // the model calls them
//
// Every proxy has writable `name`, `description`, `tags`, `visibility`, `parameters`
// and a deferred `execute`, so harness registration/rename and the server's direct
// calls behave exactly as they did with eager tools. See ./lazy.
//
// R18: fileRead/fileWrite/fileEdit/fileGlob are **core** and declared up front;
// fileList, syntaxCheck, commandRun, and gitDiff stay **searchable**, so the model
// asks toolRequest for `files`/`list`, `shell`, `git`, … and discovery enables the
// matches. A harness preloads `presetTools` unless it is created with
// `presets: false`.
//
// They are deliberately opinionated about *shape* and unopinionated about
// *policy*: no sandboxing, no confirmation prompts, no allowlists. A harness that
// needs a fence wraps `execute`, or runs the process inside one.
//
// Build note: the dynamic imports in ./catalogue turn into separate chunks. The
// published `dist/` must ship them next to `underload-harness.mjs` (package.json
// includes all of dist), and `inlineDynamicImports` must stay off — inlining would
// hoist the Node built-in imports back into the entry and defeat the split.
import { lazyTool } from './lazy';
import type {
    FileEditParameters,
    FileEditResult,
    FileGlobParameters,
    FileGlobResult,
    FileListParameters,
    FileReadResult,
    FileWriteResult
} from './files';
import type { CommandRunResult, GitDiffParameters, GitDiffResult } from './command';
import type { SyntaxCheckParameters } from './syntax';
import type { Tool } from '../types';

// The named exports. Type parameters are spelled out so a direct call keeps its
// precise signature even though the implementation is loaded lazily.
export const syntaxCheck = lazyTool<SyntaxCheckParameters, boolean>('syntaxCheck');

// The four file tools are BATCHED: each takes the array its single schema property
// declares, so a direct call and a model call reach `execute` identically.
export const fileRead = lazyTool<string[], FileReadResult>('fileRead');
export const fileWrite = lazyTool<{ path: string; content: string }[], FileWriteResult>('fileWrite');
export const fileEdit = lazyTool<FileEditParameters, FileEditResult>('fileEdit');
export const fileList = lazyTool<FileListParameters, string[]>('fileList');
// fileGlob declares four properties, so it receives the whole object and its
// result shape depends on whether `content` was supplied.
export const fileGlob = lazyTool<FileGlobParameters, FileGlobResult>('fileGlob');

export const commandRun = lazyTool<{ command: string; cwd?: string }, CommandRunResult>('commandRun');
export const gitDiff = lazyTool<GitDiffParameters, GitDiffResult>('gitDiff');

export type { SyntaxCheckLanguage, SyntaxCheckParameters } from './syntax';
export type {
    FileEditEntry,
    FileEditParameters,
    FileEditResult,
    FileEditResultEntry,
    FileGlobFilesResult,
    FileGlobMatch,
    FileGlobMatchesResult,
    FileGlobParameters,
    FileGlobResult,
    FileListParameters,
    FileReadEntry,
    FileReadParameters,
    FileReadResult,
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry
} from './files';
export type { CommandRunResult, GitDiffParameters, GitDiffResult } from './command';

// Web search is intentionally outside `presetTools`: a preset is shared by every
// harness, while a search tool closes over that harness's key. harness.ts calls
// this factory only when `websearch` is configured (the configuration property
// keeps its name; only the TOOL is called webSearch), and the factory returns
// undefined when no provider key is available.
export { createWebSearchTool, WEB_SEARCH_METADATA, WEB_SEARCH_TOOL_NAME } from './websearch';
export type { WebSearchMetadata } from './websearch';
export type {
    WebsearchConfiguration,
    WebSearchMatch,
    WebSearchParameters,
    WebsearchProvider,
    WebsearchProviderConfiguration,
    WebSearchResult
} from '../types';

// The preload catalogue, keyed by the name the model calls. `harness()` spreads
// this into its registry by default, and the harness app's server uses it to offer
// direct calls without building a harness. Values are lazy proxies, so spreading
// this object costs no implementation imports.
export const presetTools = {
    syntaxCheck,
    fileRead,
    fileWrite,
    fileEdit,
    fileList,
    fileGlob,
    commandRun,
    gitDiff
} satisfies Record<string, Tool>;
