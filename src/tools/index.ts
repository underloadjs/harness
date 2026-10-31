// @underload/harness tools — the preset catalogue, grouped by capability.
//
// One file per tool, one folder per capability, so the folder reads as the list of
// what ships out of the box:
//
//   syntax/   syntaxCheck (javascript or python, named by the caller)
//   files/    fileRead, fileWrite, fileEdit, fileList, fileGlob
//   command/  commandRun, gitDiff
//   runtime/  the harness-owned core entries (toolRequest, toolCreate, …) — moved
//             here from the old top-level `runtime-tools/` folder (T21)
//   websearch/ webSearch — opt-in, per-harness (NOT in `presetTools`: it needs a
//             provider key, which belongs to one harness; see createWebSearchTool)
//   webfetch/  webFetch — opt-in, per-harness (native GET by default, the `exa`
//             provider only when a key exists; see createWebFetchTool)
//
// NAMING (T14): every wire name is `<namespace><action>`. The four file tools and
// commandRun/webSearch were renamed; there are no aliases, because two names for
// one tool makes discovery ambiguous.
//
// Lazy, not eager (R1b)
// --------------------
// Importing this module does NOT import any implementation, and therefore does not
// load `node:fs`, `node:child_process`, `node:vm`, or a Python probe. Each export is
// a callable Tool proxy whose metadata comes from the discovered descriptor
// catalogue (via ./descriptors) and whose body is fetched by a generated `import()`
// — or compiled from its editable source when the entry is newer than the generated
// manifest (T24) — on first execution. That keeps a harness cheap to construct and a
// catalogue cheap to enumerate, while preserving the exact Tool contract the
// registry relies on:
//
//     await syntaxCheck({ code: 'print(1)', language: 'python' }); // true
//     await fileRead(['package.json']);                            // { files: […], truncated, bytes, contentBudget }
//     await fileWrite([{ path: 'a.txt', content: 'hi' }]);         // [{ path, bytes }]
//     harness({ tools: { syntaxCheck, fileRead } });                // the model calls them
//
// DERIVED TABLE, HAND-WRITTEN API (T21 → T24)
// -------------------------------------------
// `presetTools` is BUILT from the discovered descriptors: no row here names a
// metadata constant or an implementation module. The named exports below are the
// package's API surface (`@underload/harness` re-exports them by name), so they stay
// spelled out — they are a contract, not an inventory. Each one reads the SAME proxy
// instance the table holds, so `presetTools.fileRead === fileRead`.
//
// Adding a tool therefore means adding one `.tool.ts` file. T24: `./descriptors`
// derives its catalogue from a LIVE scan on Node, so a cold process already lists
// and loads the new entry; the generated manifest is only the browser fallback and
// no longer has to be regenerated for the Node surface to see the file. This file
// only needs a named export if the tool is meant to be part of the public import
// surface.
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
// Build note: the generated dynamic imports turn into separate chunks. The
// published `dist/` must ship them next to `underload-harness.mjs` (package.json
// includes all of dist), and `inlineDynamicImports` must stay off — inlining would
// hoist the Node built-in imports back into the entry and defeat the split.
import { lazyTool } from './lazy';
import { PRESET_DESCRIPTORS } from './descriptors';
import type {
    FileEditParameters,
    FileEditResult,
    FileGlobParameters,
    FileGlobResult,
    FileListParameters,
    FileListResult,
    FileReadParameters,
    FileReadResult,
    FileWriteResult
} from './files';
import type { CommandRunParameters, CommandRunResult, GitDiffParameters, GitDiffResult } from './command';
import type { SyntaxCheckParameters } from './syntax';
import type { Tool } from '../types';

// One lazy proxy per discovered preset, keyed by wire name, in descriptor order.
// Built once at module evaluation: metadata only, so no implementation is loaded.
const presetProxies: Readonly<Record<string, Tool>> = Object.fromEntries(
    PRESET_DESCRIPTORS.map((descriptor) => [descriptor.name, lazyTool(descriptor.name)])
);

// Read a discovered proxy for a NAMED export below. Throws at module evaluation
// when the generated manifest has no such entry, so a renamed/removed tool fails
// loudly at import time instead of publishing an undefined export.
const presetProxy = <TParameters, TResult>(name: string): Tool<TParameters, TResult> => {
    const proxy = presetProxies[name];

    if (proxy === undefined) {
        throw new Error(`No tool descriptor was generated for the preset "${name}".`);
    }

    return proxy as Tool<TParameters, TResult>;
};

// The named exports. Type parameters are spelled out so a direct call keeps its
// precise signature even though the implementation is loaded lazily.
export const syntaxCheck = presetProxy<SyntaxCheckParameters, boolean>('syntaxCheck');

// The four file tools are BATCHED: each takes the array its single schema property
// declares, so a direct call and a model call reach `execute` identically.
export const fileRead = presetProxy<FileReadParameters, FileReadResult>('fileRead');
export const fileWrite = presetProxy<{ path: string; content: string }[], FileWriteResult>('fileWrite');
export const fileEdit = presetProxy<FileEditParameters, FileEditResult>('fileEdit');
export const fileList = presetProxy<FileListParameters, FileListResult>('fileList');
// fileGlob declares four properties, so it receives the whole object and its
// result shape depends on whether `content` was supplied.
export const fileGlob = presetProxy<FileGlobParameters, FileGlobResult>('fileGlob');

export const commandRun = presetProxy<CommandRunParameters, CommandRunResult>('commandRun');
export const gitDiff = presetProxy<GitDiffParameters, GitDiffResult>('gitDiff');

// NOTE: the bounded-read constants live in ./files/fileRead and are deliberately
// NOT re-exported here. A VALUE re-export from './files' would statically evaluate
// the implementation module and destroy the lazy-loading contract this file tests
// (the folder barrels are therefore type-only — see ./files/index.ts).
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
    FileListQuery,
    FileListResult,
    FileReadEntry,
    FileReadParameters,
    FileReadResult,
    FileReadTarget,
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry
} from './files';
export type {
    CommandRunParameters,
    CommandRunResult,
    GitDiffParameters,
    GitDiffResult
} from './command';

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

// Page fetch sits beside web search for the same reason: it is opt-in per
// harness (the `exa` provider closes over that harness's key). Unlike search,
// the factory always returns a tool, because its default provider (`native`)
// needs no credential. harness.ts registers it only when `webfetch` is set.
export { createWebFetchTool, WEB_FETCH_TOOL_NAME } from './webfetch';
export type {
    WebFetchConfiguration,
    WebFetchParameters,
    WebFetchProvider,
    WebFetchResult
} from '../types';

// The preload catalogue, keyed by the name the model calls. `harness()` spreads
// this into its registry by default, and the harness app's server uses it to offer
// direct calls without building a harness. Values are lazy proxies, so spreading
// this object costs no implementation imports, and the key set is exactly the
// discovered preset descriptors — never a hand-written list.
export const presetTools: Readonly<Record<string, Tool>> = presetProxies;
