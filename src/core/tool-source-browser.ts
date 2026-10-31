// Browser stub for @underload/harness core/tool-source.
//
// WHY THIS FILE EXISTS
// --------------------
// The real compiler needs `node:fs`/`crypto`/`module`/`path`/`url` and
// TypeScript's synchronous transpiler. None of those belong in a browser graph.
// The library build aliases `./core/tool-source` to this module ONLY for the
// browser entry, so `import '@underload/harness'` in a browser evaluates no Node
// or TypeScript module and the browser root keeps its public API shape.
//
// HONEST CAPABILITY BOUNDARY
// --------------------------
// A browser cannot compile a tool source revision in-process. The harness kernel
// still publishes prebuilt tool definitions, but its startup sequence registers
// the model-facing controls from editable source (`runtime-tools/*.tool.ts`), so
// constructing a full harness in a browser rejects with the actionable error
// below instead of pretending source registration worked. A browser host that
// needs a harness must either run the kernel on Node or supply a prepared
// definition fallback in a future kernel change (reported separately; this stub
// intentionally does not invent a second registration pipeline).
//
// The functions are intentionally thin: no source bytes are read, no module is
// evaluated, and no compiler dependency is imported.

import { HarnessError } from '../util';
import type {
    PreparedTool,
    ToolFolderTarget,
    ToolRegistrationCandidate,
    ToolSourceRecord
} from './tool-source';

// Explicit capability boundary: source compilation is not available in this
// aliased browser build. The harness uses this flag for baseline fallback; empty
// source roots alone are NOT the signal (a mispackaged Node build must fail).
export const supportsToolCompilation = false;

// A stable placeholder: there is no package/source tree to inspect in a browser.
export const TOOL_SOURCE_PACKAGE_ROOT = '';
export const TOOL_SOURCE_ROOTS: readonly string[] = [];

// The folder extension is pure data, so a browser can still describe the
// convention even though it cannot scan or write a folder.
export const TOOL_SOURCE_EXTENSION = '.tool.ts';

const noFolderSupport = (): never => {
    throw new HarnessError(
        'toolFolders require the Node source compiler. The browser root exposes prebuilt tool definitions only; construct the harness on Node to scan or edit *.tool.ts folders.'
    );
};

export const resolveToolFolders = (_folders: readonly string[]): string[] => noFolderSupport();
export const discoverToolFolderSources = (_folders: readonly string[]): string[] =>
    noFolderSupport();
export const resolveToolFolderTarget = (
    _path: string,
    _folders: readonly string[],
    _folder?: string
): ToolFolderTarget => noFolderSupport();
export const readToolSourceFile = (_path: string): string => noFolderSupport();
export const writeToolSourceFile = (
    _path: string,
    _text: string,
    _folders: readonly string[]
): string => noFolderSupport();
export const deleteToolSourceFile = (_path: string, _folders: readonly string[]): void =>
    noFolderSupport();

// Same exported name and signature as the Node compiler, so the aliased browser
// graph links. Failure is a capability result, not a silent no-op.
export const prepareToolCandidate = (
    candidate: ToolRegistrationCandidate
): PreparedTool => {
    const name = candidate.name ?? '<unnamed>';
    throw new HarnessError(
        `Tool source compilation is unavailable in the browser build (candidate "${name}"). The browser root exposes prebuilt tool definitions only; run the harness on Node to compile or register editable source revisions.`
    );
};

// Inspection clones are pure data, so they remain available in a browser for a
// host that holds an already-captured record (for example one received from a
// Node server). Copying is still necessary: callers must not mutate the record.
export const cloneToolSourceRecord = (record: ToolSourceRecord): ToolSourceRecord => ({
    name: record.name,
    revision: record.revision,
    ...(record.sourcePath === undefined ? {} : { sourcePath: record.sourcePath }),
    ...(record.moduleText === undefined ? {} : { moduleText: record.moduleText }),
    dependencies: record.dependencies.map((dependency) => ({ ...dependency })),
    ...(record.liveDependencies === undefined
        ? {}
        : {
              liveDependencies: record.liveDependencies.map((dependency) => ({
                  ...dependency
              }))
          }),
    format: record.format,
    ...(record.source === undefined ? {} : { source: record.source }),
    checks: [...record.checks]
});

export type {
    PreparedTool,
    ToolFolderTarget,
    ToolRegistrationCandidate,
    ToolSourceDependency,
    ToolSourceLiveDependency,
    ToolSourceRecord
} from './tool-source';
