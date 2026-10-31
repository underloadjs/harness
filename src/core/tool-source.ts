// Tool source compilation and loading (R1/R2).
//
// WHY THIS EXISTS
// ---------------
// A running harness must be able to replace its own tools from editable source
// without rebuilding the package. `core/creation.ts` only compiles a bare async
// function BODY with `new AsyncFunction`, which is enough for `toolCreate` but
// cannot load an editable module with metadata, local helper imports, or `node:`
// imports. This module is the shared synchronous module compiler behind both
// startup registration and runtime `toolRegistry` registration.
//
// PLATFORM BOUNDARY (Node compiler vs browser import)
// ---------------------------------------------------
// The compiler needs `node:fs`/`crypto`/`module`/`path`/`url` and TypeScript's
// synchronous `transpileModule`. A browser cannot load any of those. This module
// therefore loads the Node runtime with a guarded top-level dynamic import:
//
//   - Node: the runtime is available before any harness factory call, so startup
//     registration stays synchronous.
//   - Browser: no Node/TypeScript module is evaluated; importing the browser root
//     still works. `prepareToolCandidate()` throws an actionable HarnessError
//     because source compilation genuinely cannot run there. Prebuilt tool
//     definitions remain usable; source registration needs a Node host.
//
// The previous implementation statically imported Node and TypeScript modules and
// also held an eager `core/index` namespace snapshot. In the bundled entry, the
// snapshot was initialised before `core/index` had finished (a module cycle), so
// live `../core` imports fell through to capturing harness source and failed on
// `import.meta`. Live modules are now looked up lazily from narrowly imported core
// submodules, so `tool()` and `HarnessError` identity is preserved without taking
// a namespace reference during initialisation.
//
// WHAT IS CHECKED
// ---------------
//   - TypeScript SYNTAX diagnostics from transpilation;
//   - static module-graph capture (literal import/export/require/dynamic import);
//   - module loading (top-level evaluation) errors;
//   - the runtime tool contract: a usable export, a wire-safe name, non-empty
//     description/tags, an execute function, and a JSON-shaped schema.
//
// What is NOT checked:
//   - semantic TypeScript type correctness (transpileModule does not type-check);
//   - behavioural correctness or safety. Candidate code runs with this process's
//     permissions, exactly like `toolCreate` and `commandRun`.
//
// MODULE RESOLUTION
// -----------------
// A source revision is captured synchronously before anything is published:
//   - the ENTRY is read (or supplied as `moduleText`) before compilation;
//   - every literal local import/require/dynamic-import is resolved recursively
//     from the TypeScript AST BEFORE load or revision hashing, so a dependency
//     used only inside a branch is still part of the immutable revision;
//   - a candidate that supplies `moduleText` or `dependencies` is a CAPTURED
//     revision: its local graph comes only from those bytes. Disk files are never
//     re-read, even when `sourcePath` still exists and has changed. A missing
//     captured helper is an actionable error, not a silent disk recapture;
//   - harness-internal modules (`core/*`, `util/*`, `types`, `tools/catalogue`)
//     resolve to LIVE package modules. This avoids a second `tool()`/`HarnessError`
//     identity and keeps framework helpers stable. Their deterministic identity is
//     part of the revision (see `liveDependencies`), because a preset's metadata
//     lives in the live catalogue rather than in the preset entry file;
//   - other bare specifiers resolve through Node's CommonJS resolver from the
//     package root. ESM-only packages are not supported by this synchronous
//     loader (documented limitation; the shipped tools only use `node:` builtins
//     and local helpers).
//
// Fresh identity: every registration evaluates a NEW module graph. Compiled JS
// is not cached across registrations; no ESM cache is involved, so a new revision
// is always genuinely new code. Old revisions remain reachable only through
// already-captured tool definitions and are eventually garbage-collected.
//
// CANDIDATE METADATA IS CLONED
// ----------------------------
// A selected export can be a Tool instance owned by a live module (for example a
// module that re-exports a preset). Candidate name/description/tags/schema
// overrides are applied to a FRESH callable wrapper, never to that shared object;
// a failed override/validation therefore cannot mutate the previously published
// definition.
//
// Cross-references:
//   - ./creation        — legacy async-function-body compiler used by toolCreate
//   - ./tool            — the Tool factory every prepared module is normalized to
//   - ./metadata        — TOOL_REGISTRY_METADATA and core metadata
//   - ../harness        — the one registration/publish lifecycle that calls this
//   - ../tools/catalogue — preset metadata + entry names

import type * as TypeScriptApi from 'typescript';
import { HarnessError, toErrorInfo } from '../util';
import type { Tool, ToolConfiguration, ToolVisibility } from '../types';
import { createDynamicTool } from './creation';
import { normalizeTags, tool } from './tool';
// Live core namespaces are imported NARROWLY. Importing `./index` here creates a
// cycle (`index` re-exports this module) that lost the namespace during bundled
// initialisation; none of these submodules import `./index` or this file.
import * as agentApi from './agent';
import * as toolApi from './tool';
import * as discoveryApi from './discovery';
import * as creationApi from './creation';
import * as resultBudgetApi from './result-budget';
import * as schemaValidationApi from './schema-validation';
import * as todoApi from './todo';
import * as profileApi from './profile';
import * as chapterApi from './chapter';
import * as locationApi from './location';
import * as snapshotApi from './snapshot';
import * as toolUiApi from './tool-ui';
import * as schedulerApi from './scheduler';
import * as metadataApi from './metadata';
import * as actionApi from './action';
import * as branchApi from './branch';
import * as threadApi from './thread';
import * as utilApi from '../util';
import * as catalogueApi from '../tools/catalogue';

// File extensions the synchronous loader understands. `.tsx` is included because
// a tool may carry a UI helper; `.mjs`/`.cjs` are already JavaScript.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

// One captured local dependency. `path` is the label a model/host can inspect
// (relative to the source root when possible, absolute otherwise).
export type ToolSourceDependency = {
    path: string;
    text: string;
};

// A live framework module consumed by a captured tool source. Its bytes are not
// part of the editable revision, but its deterministic identity is: a preset
// entry imports `PRESET_TOOLS` from the live catalogue, so catalogue metadata
// changes must change the installed revision even though the entry text did not.
export type ToolSourceLiveDependency = {
    path: string;
    revision: string;
};

// The captured source of one installed revision. This is what `toolSource()`
// returns and what a snapshot persists when a runtime registration must survive.
export type ToolSourceRecord = {
    name: string;
    // Content-addressed revision over the entry, every captured dependency, the
    // installed metadata/schema identity, and live module identities.
    revision: string;
    // Package-relative (preferred) or absolute entry path.
    sourcePath?: string;
    // Set when the registration supplied module text instead of a path.
    moduleText?: string;
    dependencies: ToolSourceDependency[];
    // Deterministic identities of framework modules the entry imports live.
    liveDependencies?: ToolSourceLiveDependency[];
    // Distinguishes the legacy `source` function-body form from a full module.
    format: 'module' | 'function-body';
    // Legacy function body, retained for snapshots/backward compatibility.
    source?: string;
    // The exact checks performed before publication.
    checks: readonly string[];
};

// A registration candidate. `toolRegistry` accepts this shape directly; startup
// uses the same shape with `sourcePath` for shipped entries.
export type ToolRegistrationCandidate = {
    name?: string;
    description?: string;
    tags?: readonly string[];
    parameters?: Record<string, unknown>;
    visibility?: ToolVisibility;
    // Legacy toolCreate form: the BODY of an async function.
    source?: string;
    // Full editable module text (TypeScript or JavaScript).
    moduleText?: string;
    // Editable entry file: relative to the package source roots, or absolute.
    sourcePath?: string;
    // Captured virtual local modules for a moduleText/sourcePath candidate.
    dependencies?: readonly ToolSourceDependency[];
};

// A compiled candidate that has NOT been published. The harness prepares every
// candidate first (compile/load/validate), and only then mutates its registry.
// This separation is what makes failed registrations and restore all-or-nothing.
export type PreparedTool = {
    tool: Tool;
    record: ToolSourceRecord;
    // Revision is repeated here for callers that only need publication data.
    revision: string;
};

// ---------------------------------------------------------------------------
// Node runtime loader (guarded top-level import; never evaluated in a browser)
// ---------------------------------------------------------------------------

type SourceDirectoryEntry = {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
};

type SourceRuntime = {
    existsSync: (candidate: string) => boolean;
    readFileSync: (candidate: string, encoding: 'utf8') => string;
    writeFileSync: (candidate: string, text: string, encoding: 'utf8') => void;
    mkdirSync: (candidate: string, options: { recursive: true }) => void;
    unlinkSync: (candidate: string) => void;
    readdirSync: (
        candidate: string,
        options: { withFileTypes: true }
    ) => SourceDirectoryEntry[];
    realpathSync: (candidate: string) => string;
    statSync: (candidate: string) => {
        isFile: () => boolean;
        isDirectory: () => boolean;
    };
    lstatSync: (candidate: string) => { isSymbolicLink: () => boolean };
    createHash: (algorithm: 'sha256') => {
        update: (value: string) => { digest: (encoding: 'hex') => string };
    };
    createRequire: (filename: string) => (specifier: string) => unknown;
    dirname: (value: string) => string;
    extname: (value: string) => string;
    isAbsolute: (value: string) => boolean;
    join: (...values: string[]) => string;
    relative: (from: string, to: string) => string;
    resolve: (...values: string[]) => string;
    sep: string;
    fileURLToPath: (value: string | URL) => string;
    ts: typeof TypeScriptApi;
};

// Guard: no `process` access in a browser. `typeof process` itself is safe even
// when the bundler does not define it.
const NODE_RUNTIME =
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: unknown } }).versions?.node === 'string';

const loadSourceRuntime = async (): Promise<SourceRuntime> => {
    const [fs, crypto, moduleApi, pathApi, urlApi, tsModule] = await Promise.all([
        import('node:fs'),
        import('node:crypto'),
        import('node:module'),
        import('node:path'),
        import('node:url'),
        import('typescript')
    ]);

    // TypeScript ships CommonJS; Node's ESM interop exposes the API on `default`
    // as well as named exports. Normalising here keeps `transpileModule` direct.
    const ts = ((tsModule as { default?: typeof TypeScriptApi }).default ??
        tsModule) as typeof TypeScriptApi;

    return {
        existsSync: fs.existsSync,
        readFileSync: fs.readFileSync as SourceRuntime['readFileSync'],
        writeFileSync: fs.writeFileSync as SourceRuntime['writeFileSync'],
        mkdirSync: fs.mkdirSync as SourceRuntime['mkdirSync'],
        unlinkSync: fs.unlinkSync,
        readdirSync: fs.readdirSync as SourceRuntime['readdirSync'],
        realpathSync: fs.realpathSync,
        statSync: fs.statSync,
        lstatSync: fs.lstatSync,
        createHash: crypto.createHash as SourceRuntime['createHash'],
        createRequire: moduleApi.createRequire,
        dirname: pathApi.dirname,
        extname: pathApi.extname,
        isAbsolute: pathApi.isAbsolute,
        join: pathApi.join,
        relative: pathApi.relative,
        resolve: pathApi.resolve,
        sep: pathApi.sep,
        fileURLToPath: urlApi.fileURLToPath,
        ts
    };
};

let sourceRuntime: SourceRuntime | undefined;
let sourceRuntimeLoadError: string | undefined;

if (NODE_RUNTIME) {
    try {
        sourceRuntime = await loadSourceRuntime();
    } catch (error) {
        // Keep the package importable so a host can report a precise diagnostic
        // when it actually tries to compile a tool.
        sourceRuntimeLoadError = toErrorInfo(error).message;
    }
}

const source = (): SourceRuntime => {
    if (sourceRuntime !== undefined) return sourceRuntime;

    throw new HarnessError(
        sourceRuntimeLoadError === undefined
            ? 'Tool source compilation requires a Node runtime with node:fs, node:crypto, node:path, node:url, node:module, and TypeScript. This environment cannot compile or register tool source; use prebuilt tool definitions instead.'
            : `Tool source compiler is unavailable: ${sourceRuntimeLoadError}`
    );
};

// Resolve the package root by walking up from this module. Works from `src/`
// during development and from `dist/` in the published package, then prefers the
// editable `src/` tree (dev) and falls back to `tool-sources/` (deployed copies).
const findPackageRoot = (runtime: SourceRuntime): string => {
    let directory = runtime.dirname(runtime.fileURLToPath(import.meta.url));

    for (let depth = 0; depth < 6; depth++) {
        const manifest = runtime.join(directory, 'package.json');

        if (runtime.existsSync(manifest)) {
            try {
                const parsed = JSON.parse(runtime.readFileSync(manifest, 'utf8')) as {
                    name?: string;
                };
                if (parsed.name === '@underload/harness') return directory;
            } catch {
                // A malformed manifest is not this loader's concern; keep walking.
            }
        }

        const parent = runtime.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }

    // The package should always be found; this fallback keeps error messages
    // actionable rather than throwing before a candidate can be compiled.
    return process.cwd();
};

const PACKAGE_ROOT = sourceRuntime === undefined ? '' : findPackageRoot(sourceRuntime);

// The editable source roots, in preference order. `src` is the development /
// workspace location; `tool-sources` is what a published install ships beside
// `dist` so an agent can inspect and edit real source in production. A browser
// never compiles source, so empty roots are honest there.
const SOURCE_ROOTS =
    sourceRuntime === undefined
        ? []
        : [sourceRuntime.join(PACKAGE_ROOT, 'src'), sourceRuntime.join(PACKAGE_ROOT, 'tool-sources')].filter(
              (directory) => sourceRuntime?.existsSync(directory)
          );

const requireFromPackage =
    sourceRuntime === undefined
        ? undefined
        : sourceRuntime.createRequire(sourceRuntime.join(PACKAGE_ROOT, 'package.json'));

// Pure slash normalisation: works on Windows without importing node:path (the
// browser import graph must not evaluate it).
const toPosix = (value: string): string => value.replace(/\\/g, '/');

// Strip an extension and a trailing `/index` so aliases can match either import
// spelling (`./core` and `./core/index`).
const moduleKeyOf = (file: string): string => {
    const withoutExtension = file.replace(/\.(?:[cm]?[jt]sx?)$/, '');
    return withoutExtension.replace(/\/index$/, '');
};

// A source label relative to the first root that contains the file, otherwise
// absolute. Used in records, diagnostics, and dependency lists.
const labelOf = (file: string): string => {
    const runtime = source();
    for (const root of SOURCE_ROOTS) {
        const rel = runtime.relative(root, file);
        if (rel.length > 0 && !rel.startsWith('..') && !runtime.isAbsolute(rel)) return toPosix(rel);
    }

    return toPosix(file);
};

const revisionOf = (parts: readonly string[]): string =>
    source().createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Live framework modules
// ---------------------------------------------------------------------------

type LiveModuleLookup = () => Record<string, unknown>;

// One lazily assembled namespace for `../core`. It is built at RESOLUTION time,
// after every core submodule has initialised; never during module initialisation.
let liveCoreNamespace: Record<string, unknown> | undefined;
const liveCoreApi = (): Record<string, unknown> => {
    if (liveCoreNamespace !== undefined) return liveCoreNamespace;

    const namespace = Object.assign(
        {},
        agentApi,
        toolApi,
        discoveryApi,
        creationApi,
        resultBudgetApi,
        schemaValidationApi,
        todoApi,
        profileApi,
        chapterApi,
        locationApi,
        snapshotApi,
        toolUiApi,
        schedulerApi,
        metadataApi,
        actionApi,
        branchApi,
        threadApi
    );
    // `core/index` also re-exports this compiler. A tool importing `../core` must
    // see the same functions; these bindings are only read after module init.
    Object.assign(namespace, {
        prepareToolCandidate,
        cloneToolSourceRecord,
        TOOL_SOURCE_PACKAGE_ROOT,
        TOOL_SOURCE_ROOTS
    });
    liveCoreNamespace = namespace;

    return namespace;
};

// Import specifiers that must use the LIVE harness package rather than a fresh
// copy of their source. Loading them again would create a second `tool()` factory
// and a second `HarnessError` class; preset tests rely on the package error type.
const LIVE_MODULE_KEYS: Record<string, LiveModuleLookup> = {
    core: liveCoreApi,
    'core/index': liveCoreApi,
    'core/tool': () => toolApi,
    'core/creation': () => creationApi,
    'core/metadata': () => metadataApi,
    'core/schema-validation': () => schemaValidationApi,
    util: () => utilApi,
    'util/index': () => utilApi,
    types: () => ({}),
    'types/index': () => ({}),
    // Preset entries import their metadata from this live table. Its identity is
    // captured in `liveDependencies` so a catalogue edit changes the revision.
    'tools/catalogue': () => catalogueApi as unknown as Record<string, unknown>
};

// Deterministic identity for a live module. Function modules contribute their
// export names (framework version identity); the catalogue contributes the actual
// metadata data because that is a tool's editable declarative half.
const liveIdentityOf = (path: string, module: Record<string, unknown>): string => {
    if (path === 'tools/catalogue') {
        return revisionOf([path, stableSerialize(module.PRESET_TOOLS)]);
    }

    return revisionOf([path, Object.keys(module).sort().join(',')]);
};

// ---------------------------------------------------------------------------
// Source file resolution
// ---------------------------------------------------------------------------

// Resolve an import specifier to a real source file. Node's resolution rules are
// approximated deliberately: this loader wants deterministic, inspectable inputs,
// not a full bundler.
const resolveSourceFile = (base: string): string | undefined => {
    const runtime = source();
    const attempts: string[] = [];
    const extension = runtime.extname(base);

    if (extension.length > 0) attempts.push(base);
    for (const candidate of SOURCE_EXTENSIONS) attempts.push(`${base}${candidate}`);
    for (const candidate of SOURCE_EXTENSIONS) attempts.push(runtime.join(base, `index${candidate}`));

    for (const attempt of attempts) {
        if (!runtime.existsSync(attempt)) continue;
        if (!runtime.statSync(attempt).isFile()) continue;
        return attempt;
    }

    return undefined;
};

const resolveCandidatePath = (candidate: ToolRegistrationCandidate): string | undefined => {
    if (candidate.sourcePath === undefined) return undefined;
    const runtime = source();

    if (runtime.isAbsolute(candidate.sourcePath)) {
        const direct = resolveSourceFile(candidate.sourcePath);
        if (direct) return direct;
    }

    const normalized = candidate.sourcePath.split(/[\\/]/).join(runtime.sep);

    for (const root of SOURCE_ROOTS) {
        const direct = resolveSourceFile(runtime.resolve(root, normalized));
        if (direct) return direct;
    }

    // A relative path from the process cwd is convenient for tests and an agent
    // editing a repository checkout; only accept it if the file exists.
    const fromCwd = resolveSourceFile(runtime.resolve(process.cwd(), normalized));
    if (fromCwd) return fromCwd;

    return undefined;
};

// ---------------------------------------------------------------------------
// Configured external tool folders (`toolFolders`)
// ---------------------------------------------------------------------------
//
// A host can point the harness at one or more folders of editable `*.tool.ts`
// modules. This is deliberately a separate, narrow surface from the package
// source roots:
//   - discovery is recursive and deterministic (folders in configuration order,
//     then a global byte-wise sort of each folder's relative POSIX paths);
//   - later folders win by tool name because the harness publishes in discovery
//     order through the same last-registration-wins kernel;
//   - writes are allowed ONLY through `resolveToolFolderTarget`/`writeToolSourceFile`
//     below, which reject paths outside the configured folders, traversal, and
//     symlink escapes. The compiler itself still reads a trusted entry with the
//     process's permissions: folder code is trusted code.
//
// The extension is part of the contract: a folder tool entry MUST end in
// `.tool.ts`. Other `.ts` helpers beside it are ordinary captured dependencies.
export const TOOL_SOURCE_EXTENSION = '.tool.ts';

// The canonical on-disk location of one writable folder entry. `folder` is the
// canonical root, `path` the canonical target file.
export type ToolFolderTarget = {
    folder: string;
    path: string;
};

const isPathInside = (root: string, target: string): boolean => {
    const runtime = source();
    const relative = runtime.relative(root, target);
    return (
        relative.length === 0 ||
        (!relative.startsWith('..') && !runtime.isAbsolute(relative))
    );
};

const folderError = (folder: unknown, detail: string): HarnessError =>
    new HarnessError(`toolFolders entry ${JSON.stringify(folder)} is invalid: ${detail}`);

// Resolve and validate the configured folders ONCE. Relative entries resolve
// against the process cwd (the documented external-folder convenience); absolute
// entries are used verbatim. Missing paths, non-directories, and duplicate
// canonical roots fail loudly instead of silently scanning the wrong place.
export const resolveToolFolders = (folders: readonly string[]): string[] => {
    if (!Array.isArray(folders)) {
        throw new HarnessError('toolFolders must be an array of folder paths.');
    }

    const runtime = source();
    const resolved: string[] = [];

    for (const folder of folders) {
        if (typeof folder !== 'string' || folder.trim().length === 0) {
            throw folderError(folder, 'expected a non-empty string path.');
        }

        const absolute = runtime.isAbsolute(folder)
            ? runtime.resolve(folder)
            : runtime.resolve(process.cwd(), folder);

        if (!runtime.existsSync(absolute)) {
            throw folderError(folder, `folder does not exist (resolved to "${toPosix(absolute)}").`);
        }

        if (!runtime.statSync(absolute).isDirectory()) {
            throw folderError(folder, `path is not a directory (resolved to "${toPosix(absolute)}").`);
        }

        let canonical: string;
        try {
            canonical = runtime.realpathSync(absolute);
        } catch (error) {
            throw folderError(folder, `folder could not be resolved: ${toErrorInfo(error).message}`);
        }

        if (!resolved.includes(canonical)) resolved.push(canonical);
    }

    return resolved;
};

// Recursively collect every `*.tool.ts` entry under one canonical folder. Sort
// for determinism and skip symlinks entirely: a folder whose meaning depends on
// an external link would make both discovery order and later-folder-wins
// unpredictable, and a symlinked file is outside this feature's write fence.
export const discoverToolFolderSources = (folders: readonly string[]): string[] => {
    const runtime = source();
    const sources: string[] = [];

    const walk = (directory: string): void => {
        let entries: SourceDirectoryEntry[];

        try {
            entries = runtime.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            throw new HarnessError(
                `Tool folder "${toPosix(directory)}" could not be read: ${toErrorInfo(error).message}`,
                { cause: error }
            );
        }

        entries.sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        );

        for (const entry of entries) {
            // Do not follow symlinks in either direction. A symlinked directory can
            // escape the configured folder or create a cycle; a symlinked entry is
            // not a stable on-disk module this feature owns.
            if (entry.isSymbolicLink()) continue;

            const absolute = runtime.join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith(TOOL_SOURCE_EXTENSION)) {
                sources.push(absolute);
            }
        }
    };

    // Folder order is configuration order (later folders must win collisions).
    // WITHIN one folder the order is a global byte-wise sort of the relative
    // POSIX path, not raw depth-first traversal: `a/b.tool.ts` sorts before
    // `a.tool.ts`, so the documented rule is what actually runs.
    for (const folder of resolveToolFolders(folders)) {
        const before = sources.length;
        walk(folder);

        const discovered = sources
            .splice(before)
            .map((absolute) => ({ absolute, relative: toPosix(runtime.relative(folder, absolute)) }))
            .sort((left, right) =>
                left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
            )
            .map((entry) => entry.absolute);

        sources.push(...discovered);
    }

    return sources;
};

// Resolve an EXPLICIT write target into a configured folder. The checks are
// intentionally conservative:
//   - `path` is required (no implicit file name and no implicit folder);
//   - a relative path is relative to `folder` when supplied, otherwise the first
//     configured folder;
//   - the target must stay under a configured canonical root after resolving the
//     nearest existing ancestor with `realpath`, which catches `..` traversal and
//     symlinked directories/files that point outside;
//   - the file name must end in `.tool.ts`.
export const resolveToolFolderTarget = (
    candidatePath: string,
    folders: readonly string[],
    folder?: string
): ToolFolderTarget => {
    if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
        throw new HarnessError('A tool source write requires a non-empty explicit `path`.');
    }

    const roots = resolveToolFolders(folders);

    if (roots.length === 0) {
        throw new HarnessError(
            'No toolFolders are configured. Add `toolFolders` to the harness configuration to write `*.tool.ts` files, or register runtime-only moduleText.'
        );
    }

    const runtime = source();
    let selected: string | undefined;

    if (folder !== undefined) {
        if (typeof folder !== 'string' || folder.trim().length === 0) {
            throw new HarnessError('`folder` must be a non-empty configured folder path when supplied.');
        }

        const absolute = runtime.isAbsolute(folder)
            ? runtime.resolve(folder)
            : runtime.resolve(process.cwd(), folder);
        const canonical = runtime.existsSync(absolute)
            ? runtime.realpathSync(absolute)
            : absolute;
        selected = roots.find((root) => root === canonical);

        if (selected === undefined) {
            throw new HarnessError(
                `Folder "${folder}" is not one of this harness's configured toolFolders.`
            );
        }
    }

    const absoluteTarget = runtime.isAbsolute(candidatePath)
        ? runtime.resolve(candidatePath)
        : runtime.resolve(selected ?? roots[0], candidatePath);

    if (selected === undefined) {
        selected = roots.find((root) => isPathInside(root, absoluteTarget));
    }

    if (selected === undefined) {
        throw new HarnessError(
            `Tool source path "${candidatePath}" is outside the configured toolFolders.`
        );
    }

    if (!absoluteTarget.endsWith(TOOL_SOURCE_EXTENSION)) {
        throw new HarnessError(
            `Tool source path "${candidatePath}" must end in "${TOOL_SOURCE_EXTENSION}".`
        );
    }

    // Walk up to the nearest existing ancestor. Its real path is the only stable
    // containment evidence before the target file exists; `mkdir` is performed
    // later by writeToolSourceFile and re-checked after creation.
    let existing = absoluteTarget;

    while (!runtime.existsSync(existing)) {
        const parent = runtime.dirname(existing);
        if (parent === existing) {
            throw new HarnessError(
                `Tool source path "${candidatePath}" has no existing ancestor inside the configured folder.`
            );
        }
        existing = parent;
    }

    const canonicalExisting = runtime.realpathSync(existing);

    if (!isPathInside(selected, canonicalExisting)) {
        throw new HarnessError(
            `Tool source path "${candidatePath}" escapes the configured toolFolders (resolved through a symlink or traversal).`
        );
    }

    const suffix = runtime.relative(existing, absoluteTarget);
    const canonicalTarget = suffix.length === 0
        ? canonicalExisting
        : runtime.join(canonicalExisting, suffix);

    if (!isPathInside(selected, canonicalTarget)) {
        throw new HarnessError(
            `Tool source path "${candidatePath}" escapes the configured toolFolders.`
        );
    }

    if (runtime.existsSync(canonicalTarget) && runtime.lstatSync(canonicalTarget).isSymbolicLink()) {
        throw new HarnessError(
            `Tool source path "${candidatePath}" is a symlink; write the real file inside the configured toolFolders instead.`
        );
    }

    return { folder: selected, path: canonicalTarget };
};

// Read one editable source file. Reads are not fenced by toolFolders: the registry
// may legitimately reload a package-built-in revision. Writes are fenced below.
export const readToolSourceFile = (path: string): string => source().readFileSync(path, 'utf8');

// Write one folder entry after re-validating the target through the same fence.
// The caller owns rollback when a later compile/contract step fails.
export const writeToolSourceFile = (
    path: string,
    text: string,
    folders: readonly string[]
): string => {
    const target = resolveToolFolderTarget(path, folders);
    const runtime = source();
    runtime.mkdirSync(runtime.dirname(target.path), { recursive: true });

    // Re-check after mkdir: the nearest ancestor may now be a newly created
    // directory, and a concurrent symlink swap must not turn this into an escape.
    const checked = resolveToolFolderTarget(target.path, folders, target.folder);
    runtime.writeFileSync(checked.path, text, 'utf8');
    return checked.path;
};

export const deleteToolSourceFile = (path: string, folders: readonly string[]): void => {
    const target = resolveToolFolderTarget(path, folders);
    if (source().existsSync(target.path)) source().unlinkSync(target.path);
};

// Flatten TypeScript diagnostics into one actionable line. Semantic diagnostics
// are never produced by transpileModule; syntax errors are.
const readDiagnostics = (
    diagnostics: readonly TypeScriptApi.Diagnostic[] | undefined,
    fileName: string
): void => {
    const ts = source().ts;
    const errors = (diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    );

    if (errors.length === 0) return;

    const details = errors
        .map((diagnostic) => {
            const position =
                diagnostic.file && diagnostic.start !== undefined
                    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                    : undefined;
            const where =
                position === undefined
                    ? fileName
                    : `${fileName}:${position.line + 1}:${position.character + 1}`;
            return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
        })
        .join('; ');

    throw new HarnessError(`Tool source could not be transpiled: ${details}`);
};

// Transpile one TypeScript/JavaScript module to CommonJS text. `new Function`
// receives the result; CommonJS is chosen because it can be evaluated
// synchronously without touching Node's ESM cache.
const transpileModule = (text: string, fileName: string): string => {
    const ts = source().ts;
    const result = ts.transpileModule(text, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            allowJs: true,
            jsx: ts.JsxEmit.React,
            inlineSourceMap: false,
            sourceMap: false
        }
    });

    readDiagnostics(result.diagnostics, fileName);

    return result.outputText;
};

// ---------------------------------------------------------------------------
// Immutable captured module graph
// ---------------------------------------------------------------------------

type CapturedModule = {
    // Stable evaluation cache key.
    key: string;
    // Inspectable label (source-root-relative where possible).
    label: string;
    text: string;
};

type ResolvedSpecifier = {
    key: string;
    text: string;
    fileName: string;
    // Live framework module (already loaded, needed for identity capture).
    external?: Record<string, unknown>;
    // Package/Node builtin specifier. Loading is deferred to the actual require
    // so a branch that never executes does not evaluate a package at capture time.
    externalSpecifier?: string;
};

type Evaluation = {
    // key -> module exports. Keys are captured module ids or live/external ids.
    cache: Map<string, Record<string, unknown>>;
    dependencies: ToolSourceDependency[];
    modules: Map<string, CapturedModule>;
    // Modules whose imports have already been statically walked.
    visited: Set<string>;
    // `${importerKey}\u0000${specifier}` -> resolution. Populated BEFORE load.
    resolutions: Map<string, ResolvedSpecifier>;
    // path -> deterministic identity for every live framework module used.
    live: Map<string, string>;
    // Captured dependency alias -> canonical module key. Supplied dependencies
    // can be addressed by their exact path, source-root-relative label, or a
    // UNAMBIGUOUS basename (an inline entry has no directory of its own).
    capturedAliases: Map<string, string>;
    // Alias keys deliberately withheld because two dependencies claim them.
    ambiguousCapturedAliases: Set<string>;
    // True for moduleText/dependencies revisions: never fall back to disk.
    captured: boolean;
    entryKey: string;
};

const resolutionKey = (importer: string, specifier: string): string =>
    `${importer}\u0000${specifier}`;

// Normalize a virtual dependency key: posix slashes, no leading `./`, and no
// extension, so `./helper`, `helper.ts`, and `helper` are one identity.
const virtualKey = (value: string): string =>
    moduleKeyOf(toPosix(value).replace(/^\.\//, ''));

// Last path segment. An inline entry has no directory, so a supplied absolute
// helper is commonly imported as `./helper`; a unique basename is the only
// deterministic link in that case.
const basenameOf = (value: string): string => {
    const posix = toPosix(value);
    const separator = posix.lastIndexOf('/');
    return separator === -1 ? posix : posix.slice(separator + 1);
};

const capturedAliasKey = (alias: string): string | undefined => {
    const key = virtualKey(alias);
    return key.length === 0 ? undefined : `captured:${key}`;
};

// Register one deterministic alias unless another dependency already claims it.
// Ambiguous aliases are removed permanently instead of letting insertion order
// decide which helper wins.
const registerCapturedAlias = (
    evaluation: Evaluation,
    alias: string,
    moduleKey: string
): void => {
    const key = capturedAliasKey(alias);
    if (key === undefined || evaluation.ambiguousCapturedAliases.has(key)) return;

    const existing = evaluation.capturedAliases.get(key);
    if (existing !== undefined && existing !== moduleKey) {
        evaluation.capturedAliases.delete(key);
        evaluation.ambiguousCapturedAliases.add(key);
        return;
    }

    evaluation.capturedAliases.set(key, moduleKey);
};

// Resolve `..`/`.` segments in a relative label without touching node:path.
const normalizeLabel = (value: string): string => {
    const parts = toPosix(value).split('/');
    const output: string[] = [];

    for (const part of parts) {
        if (part.length === 0 || part === '.') continue;
        if (part === '..') {
            if (output.length > 0 && output[output.length - 1] !== '..') output.pop();
            else output.push(part);
            continue;
        }
        output.push(part);
    }

    return output.join('/');
};

const isAbsoluteLabel = (value: string): boolean =>
    toPosix(value).startsWith('/') || /^[A-Za-z]:\//.test(toPosix(value));

// The root-relative or absolute label a relative specifier points at from an
// importer label. Absolute importers use node:path so Windows drive labels work.
const labelForSpecifier = (importerLabel: string, specifier: string): string => {
    if (isAbsoluteLabel(specifier)) return labelOf(specifier);

    if (isAbsoluteLabel(importerLabel)) {
        const runtime = source();
        return labelOf(runtime.resolve(runtime.dirname(importerLabel), specifier));
    }

    const directory = importerLabel.includes('/')
        ? importerLabel.slice(0, importerLabel.lastIndexOf('/'))
        : '.';
    return normalizeLabel(`${directory}/${specifier}`);
};

const createEvaluation = (
    candidate: ToolRegistrationCandidate,
    entryKey: string
): Evaluation => {
    // Only a non-empty dependency list makes this a fully captured revision. A
    // candidate that merely forwards `dependencies: []` alongside sourcePath is
    // still a normal path-only capture and may read its local graph from disk.
    const captured =
        candidate.moduleText !== undefined || (candidate.dependencies?.length ?? 0) > 0;
    const evaluation: Evaluation = {
        cache: new Map(),
        dependencies: [],
        modules: new Map(),
        visited: new Set(),
        resolutions: new Map(),
        live: new Map(),
        capturedAliases: new Map(),
        ambiguousCapturedAliases: new Set(),
        captured,
        entryKey
    };

    // Captured dependency paths are aliases, not a single canonical spelling:
    // the entry may address a helper as `./helper`, while a nested helper may use
    // its source-root-relative label, and a host may supply an absolute path.
    for (const dependency of candidate.dependencies ?? []) {
        const record: CapturedModule = {
            key: `captured:${virtualKey(dependency.path)}`,
            label: toPosix(dependency.path),
            text: dependency.text
        };
        evaluation.modules.set(record.key, record);
    }

    // Basename aliases are collected separately: two supplied `helper.ts` files
    // must NOT make `./helper` resolve by insertion order.
    const basenameClaims = new Map<string, { alias: string; moduleKey: string } | null>();

    for (const dependency of candidate.dependencies ?? []) {
        const label = toPosix(dependency.path);
        const moduleKey = `captured:${virtualKey(label)}`;

        // Exact supplied spelling and, for an absolute path, its inspectable
        // source-root-relative label (when the file lives under a source root).
        registerCapturedAlias(evaluation, label, moduleKey);
        if (isAbsoluteLabel(label)) registerCapturedAlias(evaluation, labelOf(label), moduleKey);

        const basename = basenameOf(label);
        const aliasKey = capturedAliasKey(basename);
        if (aliasKey === undefined) continue;

        const claim = basenameClaims.get(aliasKey);
        if (claim === undefined) {
            basenameClaims.set(aliasKey, { alias: basename, moduleKey });
        } else if (claim !== null && claim.moduleKey !== moduleKey) {
            basenameClaims.set(aliasKey, null);
        }
    }

    for (const claim of basenameClaims.values()) {
        if (claim !== null) registerCapturedAlias(evaluation, claim.alias, claim.moduleKey);
    }

    return evaluation;
};

const findCapturedModule = (
    specifier: string,
    importerLabel: string,
    evaluation: Evaluation
): CapturedModule | undefined => {
    const keys = new Set<string>();
    keys.add(virtualKey(specifier));
    keys.add(virtualKey(labelForSpecifier(importerLabel, specifier)));

    // A dependency supplied with an absolute path is also addressable by its
    // source-root-relative label, and vice versa.
    if (isAbsoluteLabel(specifier)) keys.add(virtualKey(labelOf(specifier)));

    // Explicit canonical keys win over inferred aliases.
    for (const key of keys) {
        const module = evaluation.modules.get(`captured:${key}`);
        if (module !== undefined) return module;
    }

    for (const key of keys) {
        const canonicalKey = `captured:${key}`;
        if (evaluation.ambiguousCapturedAliases.has(canonicalKey)) continue;

        const target = evaluation.capturedAliases.get(canonicalKey);
        if (target === undefined) continue;

        const module = evaluation.modules.get(target);
        if (module !== undefined) return module;
    }

    for (const root of SOURCE_ROOTS) {
        const absolute = source().resolve(root, specifier);
        const module = evaluation.modules.get(`captured:${virtualKey(labelOf(absolute))}`);
        if (module !== undefined) return module;
    }

    return undefined;
};

// Statically collect every module specifier in one module. TypeScript is already
// available (the compiler uses it); using the AST avoids a second parser and,
// critically, captures literal dynamic imports/requires that are only executed
// on some future branch.
const collectModuleSpecifiers = (text: string, label: string): string[] => {
    const ts = source().ts;
    const lower = label.toLowerCase();
    // Parse with the same dialect transpilation will use. Parsing a `.ts` file as
    // TSX would misread generic arrow/type syntax and could hide a specifier.
    const scriptKind = lower.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : lower.endsWith('.jsx')
          ? ts.ScriptKind.JSX
          : lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
        label,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
    );
    const specifiers: string[] = [];
    const seen = new Set<string>();

    const add = (specifier: string): void => {
        if (seen.has(specifier)) return;
        seen.add(specifier);
        specifiers.push(specifier);
    };

    const literalOf = (argument: TypeScriptApi.Expression | undefined): string | undefined => {
        if (argument === undefined) return undefined;
        return ts.isStringLiteralLike(argument) ? argument.text : undefined;
    };

    const visit = (node: TypeScriptApi.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier;
            if (specifier !== undefined && ts.isStringLiteralLike(specifier)) add(specifier.text);
        }

        if (ts.isCallExpression(node)) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const commonJsRequire =
                ts.isIdentifier(node.expression) && node.expression.text === 'require';

            if (dynamicImport || commonJsRequire) {
                const argument = node.arguments[0];
                const specifier = literalOf(argument);
                const kind = dynamicImport ? 'import()' : 'require()';

                if (specifier === undefined) {
                    const position = argument
                        ? sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile))
                        : undefined;
                    const where =
                        position === undefined
                            ? label
                            : `${label}:${position.line + 1}:${position.character + 1}`;
                    throw new HarnessError(
                        `Tool source ${where} uses a non-literal ${kind} specifier. A captured tool revision requires literal local imports so its dependency graph is reproducible; replace ${kind} with a literal specifier or move the dynamic external lookup behind a literal import.`
                    );
                }

                add(specifier);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return specifiers;
};

// Resolve one specifier while capturing. This is the ONLY place local bytes are
// read; after capture, evaluation consumes the immutable module/resolution maps.
const captureSpecifier = (
    specifier: string,
    importer: CapturedModule,
    evaluation: Evaluation
): ResolvedSpecifier => {
    const runtime = source();
    const bare =
        specifier.startsWith('node:') ||
        (isAbsoluteLabel(specifier) === false && specifier.startsWith('.') === false);

    if (bare) {
        const bareKey = moduleKeyOf(specifier);
        const lookup = LIVE_MODULE_KEYS[bareKey];

        if (lookup !== undefined) {
            const module = lookup();
            const path = bareKey;
            if (!evaluation.live.has(path)) {
                evaluation.live.set(path, liveIdentityOf(path, module));
            }
            return {
                key: `live:${path}`,
                text: '',
                fileName: path,
                external: module
            };
        }

        if (requireFromPackage === undefined) {
            throw new HarnessError(
                `Tool source "${importer.label}" imports "${specifier}", but external module loading requires a Node runtime.`
            );
        }

        return {
            key: `external:${specifier}`,
            text: '',
            fileName: specifier,
            externalSpecifier: specifier
        };
    }

    // A relative framework import (../core, ../util, ../types) must not be read
    // from source: it would instantiate a second framework identity.
    const relativeLabel = labelForSpecifier(importer.label, specifier);
    const relativeKey = moduleKeyOf(relativeLabel);
    const liveLookup = LIVE_MODULE_KEYS[relativeKey] ?? LIVE_MODULE_KEYS[moduleKeyOf(specifier)];

    if (liveLookup !== undefined) {
        const module = liveLookup();
        const path = LIVE_MODULE_KEYS[relativeKey] !== undefined ? relativeKey : moduleKeyOf(specifier);
        if (!evaluation.live.has(path)) {
            evaluation.live.set(path, liveIdentityOf(path, module));
        }
        return { key: `live:${path}`, text: '', fileName: path, external: module };
    }

    if (evaluation.captured) {
        const captured = findCapturedModule(specifier, importer.label, evaluation);
        if (captured !== undefined) {
            evaluation.modules.set(captured.key, captured);
            return {
                key: captured.key,
                text: captured.text,
                fileName: captured.label
            };
        }

        throw new HarnessError(
            `Tool source "${importer.label}" imports "${specifier}", but the captured revision does not include that local module. Pass its bytes in the registration's dependencies; a captured revision is never completed from changed files on disk.`
        );
    }

    const base = isAbsoluteLabel(specifier)
        ? specifier
        : runtime.resolve(runtime.dirname(importer.key), specifier);
    const file = resolveSourceFile(base);

    if (file !== undefined) {
        const fileLabel = labelOf(file);
        const fileKey = moduleKeyOf(fileLabel);
        const fileLookup = LIVE_MODULE_KEYS[fileKey];

        if (fileLookup !== undefined) {
            const module = fileLookup();
            if (!evaluation.live.has(fileKey)) {
                evaluation.live.set(fileKey, liveIdentityOf(fileKey, module));
            }
            return { key: `live:${fileKey}`, text: '', fileName: fileKey, external: module };
        }

        const capturedFile: CapturedModule = {
            key: file,
            label: fileLabel,
            text: runtime.readFileSync(file, 'utf8')
        };
        evaluation.modules.set(file, capturedFile);
        return { key: file, text: capturedFile.text, fileName: fileLabel };
    }

    // Inline candidates can still supply virtual dependencies when they are not
    // marked as a fully captured revision.
    const virtual = findCapturedModule(specifier, importer.label, evaluation);
    if (virtual !== undefined) {
        evaluation.modules.set(virtual.key, virtual);
        return { key: virtual.key, text: virtual.text, fileName: virtual.label };
    }

    throw new HarnessError(
        `Tool source import "${specifier}" from "${importer.label}" could not be resolved.`
    );
};

const captureModule = (module: CapturedModule, evaluation: Evaluation): void => {
    if (evaluation.visited.has(module.key)) return;
    evaluation.visited.add(module.key);

    evaluation.modules.set(module.key, module);

    if (module.key !== evaluation.entryKey) {
        evaluation.dependencies.push({ path: module.label, text: module.text });
    }

    for (const specifier of collectModuleSpecifiers(module.text, module.label)) {
        const key = resolutionKey(module.key, specifier);
        if (evaluation.resolutions.has(key)) continue;

        const resolved = captureSpecifier(specifier, module, evaluation);
        evaluation.resolutions.set(key, resolved);

        if (resolved.external === undefined && resolved.externalSpecifier === undefined) {
            const dependency = evaluation.modules.get(resolved.key);
            if (dependency !== undefined && dependency.key !== evaluation.entryKey) {
                captureModule(dependency, evaluation);
            }
        }
    }
};

// Build the complete graph BEFORE evaluation/hash. An inline dependency supplied
// by the candidate can be addressed by label; a disk module is read exactly once.
const captureGraph = (
    entry: CapturedModule,
    candidate: ToolRegistrationCandidate,
    evaluation: Evaluation
): Evaluation => {
    if (!evaluation.captured) {
        // A disk entry is keyed by absolute path; its label is still the
        // deterministic record/resolution label.
        evaluation.modules.set(entry.key, entry);
    } else {
        evaluation.modules.set(entry.key, entry);
        // The entry is also addressable by label for virtual cycles.
        evaluation.modules.set(`captured:${virtualKey(entry.label)}`, entry);
    }

    if (evaluation.captured) {
        for (const dependency of candidate.dependencies ?? []) {
            const label = toPosix(dependency.path);
            // Seed the concrete dep record under both its canonical key and its
            // capture alias; evaluation cache identity stays the canonical key.
            const record: CapturedModule = {
                key: `captured:${virtualKey(label)}`,
                label,
                text: dependency.text
            };
            evaluation.modules.set(record.key, record);
        }
    }

    captureModule(entry, evaluation);
    return evaluation;
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// Evaluate one captured module and return its exports. This is CJS evaluation, not
// an ESM import: no cache is shared with Node and every registration gets fresh
// identity. Resolution is table-driven; this function never touches the disk.
const evaluateModule = (
    module: CapturedModule,
    evaluation: Evaluation
): Record<string, unknown> => {
    const cached = evaluation.cache.get(module.key);
    if (cached !== undefined) return cached;

    const compiled = transpileModule(module.text, module.label);
    const produced: Record<string, unknown> = {};
    // Put the placeholder in the cache BEFORE evaluation so a local cycle sees a
    // partially populated module rather than recursing forever (CJS semantics).
    evaluation.cache.set(module.key, produced);

    const requireForModule = (specifier: string): unknown => {
        if (typeof specifier !== 'string') {
            throw new HarnessError(`Tool source "${module.label}" required a non-string specifier.`);
        }

        const resolved = evaluation.resolutions.get(resolutionKey(module.key, specifier));

        if (resolved === undefined) {
            // Literal specifiers are captured before load. Reaching this means the
            // module built a specifier at runtime, which cannot be part of a
            // reproducible revision.
            throw new HarnessError(
                `Tool source "${module.label}" loaded the uncaptured module "${specifier}". Captured revisions require literal import()/require() specifiers; a computed specifier cannot be part of an immutable dependency graph.`
            );
        }

        if (resolved.external !== undefined) return resolved.external;

        if (resolved.externalSpecifier !== undefined) {
            if (requireFromPackage === undefined) {
                throw new HarnessError(
                    `Tool source "${module.label}" imports "${specifier}", but external module loading requires a Node runtime.`
                );
            }
            return requireFromPackage(resolved.externalSpecifier);
        }

        const dependency = evaluation.modules.get(resolved.key);
        if (dependency === undefined) {
            throw new HarnessError(
                `Tool source "${module.label}" resolved "${specifier}", but its captured module is missing.`
            );
        }

        return evaluateModule(dependency, evaluation);
    };

    const factory = new Function(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        `${compiled}\n//# sourceURL=tool-source://${module.label.replace(/[\\/]/g, '/')}`
    ) as (
        exports: unknown,
        require: (specifier: string) => unknown,
        module: { exports: unknown },
        filename: string,
        dirname: string
    ) => void;

    const moduleRecord = { exports: produced };
    const dir = isAbsoluteLabel(module.label)
        ? source().dirname(module.label)
        : module.label.includes('/')
          ? module.label.slice(0, module.label.lastIndexOf('/'))
          : '.';
    factory(moduleRecord.exports, requireForModule, moduleRecord, module.label, dir);

    if (moduleRecord.exports !== produced) {
        evaluation.cache.set(module.key, moduleRecord.exports as Record<string, unknown>);
        return moduleRecord.exports as Record<string, unknown>;
    }

    return produced;
};

// ---------------------------------------------------------------------------
// Tool selection and contract
// ---------------------------------------------------------------------------

const isToolLike = (value: unknown): value is Tool =>
    typeof value === 'function' && typeof (value as Tool).execute === 'function';

const isConfigurationLike = (value: unknown): value is ToolConfiguration =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolConfiguration).execute === 'function';

// Select the exported implementation. Supported shapes, in order:
//   1. the named export the harness expects (`export const fileRead = tool(...)`);
//   2. a default export that is a Tool or ToolConfiguration;
//   3. a named `tool` export;
//   4. `metadata` + `execute` named exports (the runtime-tools convention);
//   5. a single Tool-like named export.
const selectToolExport = (
    exports: Record<string, unknown>,
    expectedName: string | undefined
): { definition: Tool; metadata?: Partial<ToolConfiguration> } => {
    if (expectedName !== undefined && isToolLike(exports[expectedName])) {
        return { definition: exports[expectedName] as Tool };
    }

    if (isToolLike(exports.default)) return { definition: exports.default as Tool };

    if (isConfigurationLike(exports.default)) {
        return { definition: tool(exports.default) };
    }

    if (isToolLike(exports.tool)) return { definition: exports.tool as Tool };
    if (isConfigurationLike(exports.tool)) return { definition: tool(exports.tool) };

    const metadata = exports.metadata;

    if (typeof exports.execute === 'function' && typeof metadata === 'object' && metadata !== null) {
        const record = metadata as Record<string, unknown>;
        const metadataName =
            typeof record.name === 'string' ? record.name : expectedName ?? '<tool-module>';

        // Do not silently downgrade an invalid visibility to the default. Direct
        // Tool-like exports are checked after cloning; the metadata+execute shape
        // never reaches tool() with the invalid value, so validate it here.
        if (
            record.visibility !== undefined &&
            record.visibility !== 'core' &&
            record.visibility !== 'searchable'
        ) {
            throw new HarnessError(
                `Tool "${metadataName}" visibility must be one of: ${TOOL_VISIBILITIES.join(', ')}. Received "${String(record.visibility)}".`
            );
        }

        const configuration: ToolConfiguration = {
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            // Empty values deliberately reach tool()'s own contract error; the
            // runtime entry metadata is required to provide both fields.
            description: typeof record.description === 'string' ? record.description : '',
            tags: Array.isArray(record.tags) ? (record.tags as string[]) : [],
            ...(record.visibility === 'core' || record.visibility === 'searchable'
                ? { visibility: record.visibility }
                : {}),
            ...(typeof record.parameters === 'object' && record.parameters !== null
                ? { parameters: record.parameters as Record<string, unknown> }
                : {}),
            execute: exports.execute as ToolConfiguration['execute']
        };

        return { definition: tool(configuration), metadata: configuration };
    }

    const tools = Object.values(exports).filter(isToolLike);

    if (tools.length === 1) return { definition: tools[0] };

    throw new HarnessError(
        'Tool module did not export a tool: expected a named/default Tool, or `metadata` + `execute` exports.'
    );
};

// A wire-safe name: the same alphabet the transport accepts for function names.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// The visibility values the public Tool contract resolves to. A Tool-like export
// can bypass tool()'s constructor, so the compiler must validate this itself.
const TOOL_VISIBILITIES: readonly ToolVisibility[] = ['core', 'searchable'];

// Deep JSON clone for an accepted schema. The caller owns the candidate object
// and may mutate it after registration; the installed tool and its revision must
// keep the exact schema that was validated at install time.
const cloneJsonValue = (value: unknown, toolName: string): unknown => {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('value is not JSON-serialisable');
        return JSON.parse(serialized) as unknown;
    } catch (error) {
        throw new HarnessError(`Tool "${toolName}" parameters must be JSON-serialisable.`, {
            cause: error
        });
    }
};

// Validate the runtime contract every source-revision must satisfy before it can
// be published. Bounds are intentionally only those the wire protocol needs;
// replacing a core tool must not be rejected for being "already registered".
const assertToolContract = (definition: Tool): void => {
    if (typeof definition.name !== 'string' || !NAME_PATTERN.test(definition.name)) {
        throw new HarnessError(
            `Tool module name "${String(definition.name)}" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.`
        );
    }

    if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
        throw new HarnessError(`Tool "${definition.name}" requires a description.`);
    }

    if (!Array.isArray(definition.tags) || definition.tags.length === 0) {
        throw new HarnessError(`Tool "${definition.name}" requires at least one tag.`);
    }

    if (!TOOL_VISIBILITIES.includes(definition.visibility)) {
        throw new HarnessError(
            `Tool "${definition.name}" visibility must be one of: ${TOOL_VISIBILITIES.join(', ')}. Received "${String(definition.visibility)}".`
        );
    }

    if (typeof definition.execute !== 'function') {
        throw new HarnessError(`Tool "${definition.name}" requires an execute function.`);
    }

    if (definition.parameters !== undefined) {
        if (
            typeof definition.parameters !== 'object' ||
            definition.parameters === null ||
            Array.isArray(definition.parameters)
        ) {
            throw new HarnessError(`Tool "${definition.name}" parameters must be a JSON Schema object.`);
        }

        try {
            JSON.stringify(definition.parameters);
        } catch {
            throw new HarnessError(`Tool "${definition.name}" parameters must be JSON-serialisable.`);
        }
    }
};

// Create a fresh callable with fresh metadata containers. The EXECUTE function is
// reused (behaviour identity is intentional); name/description/tags/schema are
// owned by this registration so a failed override can never touch the shared
// source export.
const cloneToolDefinition = (sourceTool: Tool): Tool => {
    const execute = sourceTool.execute;
    const callable = ((value: unknown) =>
        execute({ parameters: value } as never)) as unknown as Tool;

    Object.defineProperty(callable, 'name', {
        value: sourceTool.name,
        writable: true,
        enumerable: true,
        configurable: true
    });

    callable.description = sourceTool.description;
    // normalizeTags also avoids spreading a malformed/missing `tags` value before
    // contract validation, which previously surfaced as a raw TypeError.
    callable.tags = normalizeTags(sourceTool.tags);
    callable.visibility = sourceTool.visibility ?? 'searchable';
    callable.parameters =
        sourceTool.parameters === undefined
            ? undefined
            : (cloneJsonValue(sourceTool.parameters, sourceTool.name) as Record<string, unknown>);
    callable.execute = execute;

    return callable;
};

// Stable JSON independent of object key insertion order. Revision identity must
// not change just because a host rebuilt an equivalent schema object.
const stableSerialize = (value: unknown): string => {
    const sort = (current: unknown): unknown => {
        if (Array.isArray(current)) return current.map(sort);
        if (current === null || typeof current !== 'object') return current;

        const record = current as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) sorted[key] = sort(record[key]);
        return sorted;
    };

    return JSON.stringify(sort(value)) ?? 'undefined';
};

// The installed metadata/schema identity that must be part of the revision.
const metadataIdentityOf = (definition: Tool): string =>
    stableSerialize({
        name: definition.name,
        description: definition.description,
        tags: [...definition.tags],
        visibility: definition.visibility,
        ...(definition.parameters === undefined
            ? {}
            : { parameters: definition.parameters })
    });

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

// Compile, load, and contract-check one candidate. Publication is the caller's
// responsibility (harness.acceptTool), which is what makes restoration and failed
// replacement atomic.
export const prepareToolCandidate = (
    candidate: ToolRegistrationCandidate,
    options: { expectedName?: string } = {}
): PreparedTool => {
    // Browser (or a Node install missing the compiler) gets this actionable error
    // before any filesystem/TypeScript access.
    source();

    // A supplied moduleText is a captured revision: its path is an identity label
    // for relative resolution, not a file to probe. Do not resolve/stat it, so a
    // deleted or edited source file cannot change the restored graph.
    const suppliedModuleText = candidate.moduleText !== undefined;
    const sourcePath = suppliedModuleText ? undefined : resolveCandidatePath(candidate);
    const expectedName = candidate.name ?? options.expectedName;

    // Captured dependencies only make sense next to captured entry text. Reading
    // the entry from disk while helpers come from supplied bytes would produce a
    // hybrid revision that is neither a clean path capture nor an immutable one.
    // An EMPTY dependency list captures nothing, so it still permits a clean
    // path-only capture (toolRegistry often forwards an empty model array).
    const suppliedDependencies = candidate.dependencies ?? [];
    if (suppliedDependencies.length > 0 && candidate.moduleText === undefined) {
        const label =
            candidate.sourcePath ?? candidate.name ?? options.expectedName ?? '<tool-module>';
        throw new HarnessError(
            `Tool source "${String(label)}" supplied captured dependencies without moduleText. A captured revision requires the entry module text as well; pass moduleText alongside dependencies, or omit dependencies for a normal path-only capture.`
        );
    }

    // Legacy function-body form. It keeps the historical toolCreate contract and
    // validation bounds (name/description/tags/source length/schema complexity).
    if (sourcePath === undefined && candidate.moduleText === undefined) {
        if (typeof candidate.source !== 'string' || candidate.source.trim().length === 0) {
            // Preserve the legacy toolCreate diagnostic when a caller supplied no
            // module form and an empty/missing function body.
            if (candidate.source !== undefined) {
                throw new HarnessError(
                    `Tool "${String(expectedName ?? candidate.name)}" requires a source body.`
                );
            }

            throw new HarnessError(
                `Tool "${String(expectedName ?? candidate.name)}" requires a sourcePath, moduleText, or legacy source body.`
            );
        }

        const creationName = candidate.name ?? options.expectedName ?? '';
        const creation = {
            name: creationName,
            description: candidate.description ?? '',
            tags: candidate.tags ?? [],
            ...(candidate.parameters === undefined
                ? {}
                : {
                      parameters: cloneJsonValue(
                          candidate.parameters,
                          creationName
                      ) as Record<string, unknown>
                  }),
            source: candidate.source
        };

        const definition = createDynamicTool(creation, {});
        // Same body/name can still install different metadata/schema, so the
        // revision covers the full installed contract rather than source alone.
        const revision = revisionOf([
            'function-body',
            metadataIdentityOf(definition),
            candidate.source
        ]);

        return {
            tool: definition,
            revision,
            record: {
                name: definition.name,
                revision,
                dependencies: [],
                format: 'function-body',
                source: candidate.source,
                checks: ['transpile:function-body', 'contract:tool', 'schema:json']
            }
        };
    }

    if (sourcePath === undefined && candidate.moduleText === undefined) {
        throw new HarnessError('Tool source candidate is empty.');
    }

    // CAPTURE FIRST. A supplied moduleText is authoritative even when sourcePath
    // still points at a (possibly edited or deleted) file.
    const entryText =
        candidate.moduleText !== undefined
            ? candidate.moduleText
            : source().readFileSync(sourcePath as string, 'utf8');
    // A captured path is kept verbatim (normalised to posix) instead of being
    // resolved against current disk: it is the relative-resolution identity at
    // install time, and the file may legitimately be gone on restore.
    const suppliedLabel =
        candidate.sourcePath === undefined
            ? undefined
            : isAbsoluteLabel(candidate.sourcePath)
              ? labelOf(candidate.sourcePath)
              : normalizeLabel(candidate.sourcePath);
    const entryLabel = suppliedModuleText
        ? suppliedLabel ?? candidate.name ?? options.expectedName ?? '<inline-tool-module>'
        : sourcePath !== undefined
          ? labelOf(sourcePath)
          : candidate.name ?? options.expectedName ?? '<inline-tool-module>';
    // A persisted revision carries BOTH its captured entry text and its path; the
    // path is the resolution identity (so relative imports/aliases behave exactly
    // as at install time) while the captured text is what is actually compiled.
    const entryKey = suppliedModuleText ? `virtual:${entryLabel}` : (sourcePath as string);
    const entry: CapturedModule = { key: entryKey, label: entryLabel, text: entryText };

    const evaluation = createEvaluation(candidate, entryKey);
    let exports: Record<string, unknown>;

    try {
        captureGraph(entry, candidate, evaluation);
        exports = evaluateModule(entry, evaluation);
    } catch (error) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError(
            `Tool source "${entryLabel}" could not be loaded: ${toErrorInfo(error).message}`,
            { cause: error }
        );
    }

    let selected: ReturnType<typeof selectToolExport>;

    try {
        selected = selectToolExport(exports, expectedName);
    } catch (error) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError(
            `Tool source "${entryLabel}" has an invalid export: ${toErrorInfo(error).message}`,
            { cause: error }
        );
    }

    // A fresh wrapper owns candidate overrides. Validation failure leaves the
    // selected (possibly shared/live) definition untouched.
    const definition = cloneToolDefinition(selected.definition);

    // Candidate metadata overrides module metadata only where supplied. This lets
    // a runtime registration rename/retag an implementation while keeping the
    // module's behaviour, and lets a module stay the source of truth by default.
    if (candidate.name !== undefined) definition.name = candidate.name;
    if (candidate.description !== undefined) definition.description = candidate.description;
    if (candidate.tags !== undefined) {
        // Tool.tags is readonly in the public contract; the registry owns this
        // fresh instance exclusively, so applying a registration override is safe.
        (definition as unknown as { tags: string[] }).tags = normalizeTags(candidate.tags);
    }
    if (candidate.visibility !== undefined) definition.visibility = candidate.visibility;
    if (candidate.parameters !== undefined) {
        // JSON clone BEFORE validation/hash/publication: the caller keeping a
        // reference to its schema must not be able to mutate the installed schema
        // or make `record.revision` describe bytes that are no longer installed.
        definition.parameters = cloneJsonValue(
            candidate.parameters,
            definition.name
        ) as Record<string, unknown>;
    }

    assertToolContract(definition);

    const dependencies = evaluation.dependencies.map((dependency) => ({ ...dependency }));
    const liveDependencies = [...evaluation.live.entries()]
        .map(([path, revision]) => ({ path, revision }))
        .sort((left, right) => left.path.localeCompare(right.path));

    // Complete identity: captured bytes + installed metadata/schema + live
    // framework metadata. A source-only hash missed candidate overrides and the
    // preset catalogue that supplies a preset entry's declarative half.
    const revision = revisionOf([
        entryLabel,
        entryText,
        ...dependencies.flatMap((dependency) => [dependency.path, dependency.text]),
        'metadata',
        metadataIdentityOf(definition),
        ...liveDependencies.flatMap((dependency) => [dependency.path, dependency.revision])
    ]);

    const record: ToolSourceRecord = {
        name: definition.name,
        revision,
        // Always capture the entry bytes, not just a path: a snapshot/inspection
        // record must correspond to the exact revision that was installed even if
        // the editable file changes or disappears later.
        moduleText: entryText,
        ...(suppliedModuleText
            ? suppliedLabel === undefined
                ? {}
                : { sourcePath: suppliedLabel }
            : sourcePath === undefined
              ? {}
              : { sourcePath: labelOf(sourcePath) }),
        dependencies,
        ...(liveDependencies.length === 0 ? {} : { liveDependencies }),
        format: 'module',
        checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
    };

    return { tool: definition, record, revision: record.revision };
};

// Inspectable copy of a captured source record. The harness keeps the canonical
// object in a private map; callers must not mutate it through `toolSource()`.
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

// Package/source roots are exported for focused tests and packaging owners. They
// are not part of the model-facing surface.
export const TOOL_SOURCE_PACKAGE_ROOT = PACKAGE_ROOT;
export const TOOL_SOURCE_ROOTS = SOURCE_ROOTS;

// Explicit capability boundary. This is TRUE even when `SOURCE_ROOTS` is empty:
// a Node install missing editable source must fail startup compilation with an
// actionable diagnostic rather than silently switching to prepared definitions.
// Only the aliased browser stub sets this false.
export const supportsToolCompilation = true;
