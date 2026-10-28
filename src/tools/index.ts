// @underload/harness tools — the preset catalogue, grouped by capability.
//
// One file per tool, one folder per capability, so the folder reads as the list of
// what ships out of the box:
//
//   syntax/   javascriptSyntax, pythonSyntax
//   files/    readFile, writeFile, editFile, listFiles, searchFiles, globFiles
//   command/  runCommand, gitDiff
//   websearch/ websearch — opt-in, per-harness (NOT in `presetTools`: it needs a
//             provider key, which belongs to one harness; see createWebsearchTool)
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
//     await pythonSyntax('print(1)');                 // true — loads syntax/pythonSyntax now
//     await readFile('package.json');                 // the file, as text
//     harness({ tools: { pythonSyntax, readFile } }); // the model calls them
//
// Every proxy has writable `name`, `description`, `tags`, `visibility`, `parameters`
// and a deferred `execute`, so harness registration/rename and the server's direct
// calls behave exactly as they did with eager tools. See ./lazy.
//
// Every preset is **searchable**, so registering the whole catalogue still declares
// only getTools: the model asks for `files`, `shell`, `git`, … and discovery enables
// the matches. A harness preloads `presetTools` unless it is created with
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
    EditFileParameters,
    EditFileResult,
    GlobFilesParameters,
    GlobFilesResult,
    SearchFilesParameters,
    SearchFilesResult,
    WriteFileResult
} from './files';
import type { GitDiffParameters, GitDiffResult, RunCommandResult } from './command';
import type { Tool } from '../types';

// The named exports. Type parameters are spelled out so a direct call keeps its
// precise signature even though the implementation is loaded lazily.
export const javascriptSyntax = lazyTool<string, boolean>('javascriptSyntax');
export const pythonSyntax = lazyTool<string, boolean>('pythonSyntax');

export const readFile = lazyTool<string, string>('readFile');
export const writeFile = lazyTool<{ path: string; content: string }, WriteFileResult>('writeFile');
export const editFile = lazyTool<EditFileParameters, EditFileResult>('editFile');
export const listFiles = lazyTool<string | undefined, string[]>('listFiles');
export const searchFiles = lazyTool<SearchFilesParameters, SearchFilesResult>('searchFiles');
export const globFiles = lazyTool<GlobFilesParameters, GlobFilesResult>('globFiles');

export const runCommand = lazyTool<{ command: string; cwd?: string }, RunCommandResult>('runCommand');
export const gitDiff = lazyTool<GitDiffParameters, GitDiffResult>('gitDiff');

export type { WriteFileResult } from './files';
export type {
    EditFileParameters,
    EditFileResult,
    GlobFilesParameters,
    GlobFilesResult,
    SearchFilesMatch,
    SearchFilesParameters,
    SearchFilesResult
} from './files';
export type { GitDiffParameters, GitDiffResult, RunCommandResult } from './command';

// Web search is intentionally outside `presetTools`: a preset is shared by every
// harness, while a search tool closes over that harness's key. harness.ts calls
// this factory only when `websearch` is configured, and the factory returns
// undefined when no provider key is available.
export { createWebsearchTool, WEBSEARCH_METADATA, WEBSEARCH_TOOL_NAME } from './websearch';
export type { WebsearchMetadata } from './websearch';
export type {
    WebsearchConfiguration,
    WebsearchMatch,
    WebsearchParameters,
    WebsearchProvider,
    WebsearchProviderConfiguration,
    WebsearchResult
} from '../types';

// The preload catalogue, keyed by the name the model calls. `harness()` spreads
// this into its registry by default, and the harness app's server uses it to offer
// direct calls without building a harness. Values are lazy proxies, so spreading
// this object costs no implementation imports.
export const presetTools = {
    javascriptSyntax,
    pythonSyntax,
    readFile,
    writeFile,
    editFile,
    listFiles,
    searchFiles,
    globFiles,
    runCommand,
    gitDiff
} satisfies Record<string, Tool>;
