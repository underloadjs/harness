# Runtime tools

> **Status:** Integration documentation for the self-modifying tool runtime.
> The source implementation and package check are present, but this document
> does not assert a passing production verification run. The release gate
> `npm run test:package:tools` must pass after a successful build.
> **Source of truth:** `tasks/task-harness-self-modifying-tools.md` (sections
> 1–8 and 10).

---

## Scope

A running Node harness can compile, register, replace, and retest its own tools
without rebuilding the package or restarting the process. The editable source
ships beside the generated build, so an agent can inspect and edit the same files
the runtime compiles.

This feature is intentionally a production self-modification surface. It is not
a sandbox, a type checker, or a browser feature. See **Platform and limits**
before relying on it.

## Platform and limits

- **Runtime:** Node.js `>=18` (the package `engines` range) supports source
  compilation. The harness exposes an explicit supports flag to the source
  runtime: it is true on Node and false in the browser build. A missing Node
  source therefore fails loudly instead of falling back to a stale definition.
  `toolRegistry` source registration and `toolSource`/`toolSources` are
  unavailable in the browser and return an actionable error; the browser alias
  keeps importing/harness construction on the prepared legacy baseline
  definitions and never fabricates browser source records.
- **Compiler:** synchronous TypeScript transpilation only
  (`ts.transpileModule`), not semantic type checking. Syntax is checked; type
  errors that TypeScript would report in a project build are not. Before loading,
  the compiler walks the TypeScript AST statically: static imports/exports and
  literal `import()`/`require()` calls are resolved recursively. Non-literal
  `import()`/`require()` calls are rejected.
- **Evaluation:** captured source bytes override the current disk contents for
  that revision. Each registration evaluates a fresh CommonJS module graph with
  no shared ESM module cache; importing a new revision really evaluates new code.
  Changing only the file on disk is not what invalidates a cache.
- **External dependencies:** `node:` built-ins and bare package imports resolve
  through Node's CommonJS resolution from the package root. External packages
  that are ESM-only cannot be loaded by this synchronous path and are not
  supported.
- **Source side effects:** loading a candidate evaluates its top-level code.
  Compilation/loading is not side-effect-free, and failed registration cannot
  roll back arbitrary side effects from candidate code. The failed-registration
  guarantee covers registry publication only.
- **Authority:** loaded code runs with the process's permissions. There is no
  per-tool isolation or security boundary. Sandboxing is separate work.

## Production source model

The published package contains two siblings:

```text
<installed-package>/
  dist/   generated production entry and chunks
  src/    editable TypeScript source shipped for inspection and compilation
```

`sourcePath` values are resolved relative to the installed `src/` root (or may be
absolute). `harness.toolSource(name).sourcePath` therefore reports a package-
relative label such as `runtime-tools/toolRegistry.tool.ts`, not a generated
`dist/` module. TypeScript is a runtime dependency of the package because the
compiler is needed in production.

The package `files` allow-list includes `src` and excludes tests. The runtime
compiler must remain able to read these editable entries after a production
install; generated `dist/` files are not the editable source model.

The opt-in web tools also ship independently as `runtime-tools/webSearch.tool.ts`
and `runtime-tools/webFetch.tool.ts`; their editable provider implementations are shipped
too. The registered entries delegate provider/credential operations to the
harness that owns them; startup supplies the configured metadata/runtime closure.
A replacement registered under those names is an ordinary source revision and
does not inherit the original harness's configured provider closure. Module-local
provider state is not migrated between revisions. Credentials remain harness
configuration, never candidate source or source records.

## External tool folders and `toolManage`

`toolFolders` accepts an ordered list of absolute or cwd-relative directories. The
harness recursively discovers `*.tool.ts` entries in deterministic order (folder
order, then a byte-wise sort of each folder's relative POSIX paths) and publishes each through the same kernel; a later
folder wins a name collision. An invalid folder or module fails harness
construction with the exact path. Folder modules are trusted code: they load with
the process's permissions and there is no sandbox.

Canonical `*.tool.ts` entry:

```ts
// tools/example.tool.ts
export const metadata = {
    name: 'example',
    description: 'Return a greeting.',
    tags: ['example', 'greeting'],
    parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false
    }
};

export const execute = ({ parameters }: ToolContext) => `Hello, ${parameters.name}!`;
```

`toolManage` is the model-facing management surface (the host can call
`harness.runtime.manageTool` directly with the same parameters):

- `list` — registry metadata for every live tool;
- `details` — one tool's metadata, cloned `parameters` schema, enabled/state,
  source revision, and any preserved `owningPath`;
- `source` — captured `moduleText`, local dependencies, format, revision, checks;
- `path` — configured folders plus an installed `sourcePath`/preserved
  `owningPath`, or the deterministic `createPath` an unowned name would use, or
  validate an explicit candidate path inside the write fence (never writes);
- `create` / `update` — compile/validate/publish through the shared kernel.
  **Persistent by default:** a pathless `create` requires `name` and writes
  `<name>.tool.ts` in the LAST configured folder (later folders win startup
  collisions); a pathless `update` reuses the tool's captured owning `sourcePath`
  when it is inside a configured root. An explicit `path` inside a configured root
  overrides; the file must end in `.tool.ts`. `persist: "runtime"` is the explicit
  no-disk mode (snapshot-persisted only) and cannot be combined with `path`/`folder`.
  No configured root is a clear error for persistent operations;
- `reload` — re-read a disk-backed revision, or recompile captured bytes.

Traversal, symlink escapes, and implicit outside-folder writes are rejected. A
failed registration rolls the just-written file back to its previous contents (or
removes a newly created file), reports a rollback failure explicitly, and leaves the
prior registry entry untouched. Disk-backed create/update is disk-owned catalogue
state: it does not enter `createdToolRecords` or spend `maxCreatedTools`; restart
re-scans the folder. Path fencing is not a sandbox: the compiler still executes
trusted candidate code with process permissions.

## API

All paths below are properties of the live harness created at startup. Every tool
invocation receives that same object as `context.harness`; it is never a clone,
snapshot, or replacement harness.

### Inspect an installed revision

```ts
const source = harness.toolSource('toolRegistry');
// source: {
//   name, revision, sourcePath?, moduleText?, dependencies,
//   format: 'module' | 'function-body', source?, checks
// }
// undefined means the tool was registered from an already-built definition
// (a configured tool/plugin) and has no editable source revision.

const allSources = harness.toolSources(); // every installed source revision
```

`revision` is content-addressed from the captured entry/helper bytes, the
installed metadata and input schema, and the identities of live package
dependencies. `dependencies` records captured local helper modules as
`{ path, text }`; their bytes are what the revision and snapshot retain, not a
promise to re-read the same disk file later. A source entry that imports another
registered tool instead of resolving it through the harness can bake a fixed copy
into its own revision; use `context.callTool`/`harness.callTool` for live
tool-to-tool resolution.

### Register or replace a tool

The ordinary model-facing tool is `toolRegistry`. The host can call the same
implementation explicitly:

```ts
const result = await harness.executeTool('toolRegistry', {
    name: 'example',                         // optional if the module exports it
    sourcePath: 'tools/example.tool.ts'      // relative to installed src/, or absolute
    // moduleText: '...'                     // alternative: full inline module text
    // dependencies: [{ path, text }]        // virtual local helpers for moduleText
});

// result:
// {
//   name: 'example',
//   revision: '0123456789abcdef',
//   created: false,
//   replaced: true,
//   previousRevision?: '...',
//   sourcePath?: 'tools/example.tool.ts',
//   checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
// }
```

A module must export a usable tool in one of the supported shapes: a named Tool
matching the requested name, a default Tool, a `tool` export, a `metadata` +
`execute` pair, or a single Tool-like named export. Metadata from the module can
be overridden by the registration candidate. Successful publication makes the
tool available to the registering agent immediately; no extra `toolRequest`
discovery round is required.

`harness.registerTool(candidate)` is the underlying kernel operation and accepts
the same candidate shape. `toolRegistry` is an ordinary tool that delegates to
it. Startup registration uses the same compile/load/validate publication path;
startup may call the kernel directly before `toolRegistry` exists.

The legacy `source` form (the body of an async function) remains accepted by
`toolCreate`/`createTool` for compatibility. New editable tools should use a
module `sourcePath` or `moduleText`.

### Invoke through the live registry

```ts
// Host/manual invocation; bypasses model discovery but still validates the schema.
const value = await harness.executeTool('example', { input: 'hello' });

// A tool calling another registered tool at CALL time. The current definition is
// resolved then, so a later replacement is observed.
const nestedByContext = await context.callTool!('otherTool', { input: 'hello' });

// Equivalent public handle method for host/other callers.
const nestedByHarness = await harness.callTool('otherTool', { input: 'hello' }, {
    agent: writer,
    runDepth: 1
});
```

The context also exposes the current `agent`, `agents`, `runDepth`, optional
cancellation `signal`, and optional `threadId`. Persistent tool state that must
survive implementation replacement belongs in `harness.memory`:

```ts
harness.memory.set('example:state', { count: 1 });
const state = harness.memory.get('example:state');
harness.memory.has('example:state');
harness.memory.delete('example:state');
harness.memory.keys();
harness.memory.clear();
```

Module-local variables and closures belong to one loaded revision and are not
migrated when that revision is replaced.

## Compilation and dependency resolution

For a module candidate:

1. The entry source is captured first. `sourcePath` reads the installed source
   file; `moduleText` uses the supplied text.
2. The compiler parses the TypeScript AST and resolves the dependency graph
   BEFORE loading or hashing: static imports/exports and literal
   `import()`/`require()` calls are followed recursively. Non-literal dynamic
   imports/requires are rejected.
3. Relative imports resolve to real source files (TS/TSX/JS/MJS/CJS) or to
   virtual `dependencies` entries. Every recursively discovered local helper's
   bytes are captured into the revision; captured bytes override later disk
   edits for that revision.
4. Harness-internal modules (`core`, `util`, `types`, `tools/catalogue`) resolve
   to the live package modules rather than a second copy of the framework. Their
   identities are part of the revision; package/catalogue changes are re-resolved
   on restore rather than stored as helper source.
5. `node:` imports and package dependencies resolve through the package's Node
   CommonJS resolver. ESM-only packages are unsupported.
6. The module is transpiled to CommonJS and evaluated as a fresh module graph.
   New revisions do not reuse Node's ESM cache.
7. The resulting tool contract and metadata/schema are validated before
   publication.

The exact checks reported on success are:

```text
transpile:syntax
load:module
contract:tool
schema:json
```

These checks prove that the source transpiled, the module loaded, the exported
tool contract is usable, and its schema is JSON-serialisable. They do **not**
prove semantic type correctness, behavioural correctness, security, or absence of
top-level side effects.

Compilation diagnostics are actionable errors from the registration operation:

- syntax: `Tool source could not be transpiled: <path>:<line>:<character>: <message>`
- load/top-level throw: `Tool source "<path>" could not be loaded: <message>`
- invalid exports: ``Tool module did not export a tool: expected a named/default Tool, or `metadata` + `execute` exports.``

A failed new registration leaves the name unregistered. A failed replacement
leaves the previous implementation, metadata, schema, source record, and enabled
state unchanged through the registration operation.

## Publication and ordering

The kernel operation is synchronous from capture through publication:

```text
capture source -> transpile -> load -> validate contract -> publish registry entry
```

No compilation is deferred to a background task. For one harness, registrations
therefore complete in synchronous submission order; a later submission wins if it
replaces the same name. `registerTool` returns a Promise, but the work has already
committed before that Promise is created, so awaiting it is a completion barrier,
not a queue wait.

Successful publication replaces a definition object. Already-started or scheduled
invocations keep the definition they captured. Model requests capture the
definitions they advertise, so a tool call returned by an outstanding request is
validated and executed against that advertised revision rather than silently
against an incompatible replacement. Later requests see the published replacement.

## Server integration

All shipped preset, demo, and flaky tool source routes are compiled through the
shared source operation. The `toolRegistry` catalogue entry is session-bound: a
call with a `sessionId` runs against that session's live harness registry and
accepts any registered name, including a source revision just published there.

The no-session static direct runner is intentionally not tied to any harness
instance. It has no live `H` to mutate or register into; session-bound tools must
be invoked with a session. This is a deliberate boundary, not a second harness or
a detached copy of one.

## Source records and revision lifecycle

`toolSource(name)` returns a detached inspection copy. The revision covers the
captured entry/helper bytes, metadata/schema, and live dependency identities.
Replacing a revision publishes a new definition object and updates the source
record; later disk edits do not change an already-captured revision.

Every registration evaluates a fresh CommonJS module graph from captured bytes;
no ESM module cache is consulted. Old revisions remain reachable only through
already-captured definitions/in-flight invocations and are not explicitly
unloaded. Replacing a registry entry does not imply that an old module is removed
from memory or that the runtime will eventually recycle it.

## Snapshots and persistence

The existing snapshot schema records runtime-created tool names in
`createdTools` (and the lifetime creation count). A new source registration and a
replacement of a previously runtime-created name are persisted there, including
captured local-helper bytes (and inline module text where the record uses that
form). Replacing a baseline preset/core tool is runtime-only and is not carried
across a snapshot restore, because a fresh harness already supplies that baseline.

Restore validates and re-prepares persisted records through the same compiler
operation before mutating live state, then republishes the restored records.
Captured helper bytes come from the snapshot; package/live dependency identities
and the current catalogue are recomputed against the restoring installation,
rather than trusting stale serialized copies. As with any module load, candidate
top-level evaluation is not a guarantee of a side-effect-free operation.
Cross-process restoration beyond the existing snapshot contract is not added by
this feature.

## Usage check

The package check exercises the copied published package shape:

```powershell
npm run test:package:tools
# equivalent from the package root:
node scripts/check-package-tools.mjs
```

It:

- copies the resolved `files` set (`dist` + editable `src`) into repository
  `Temp/`;
- links the declared runtime dependencies from installed `node_modules` (no
  network; this is **not** a clean `npm install --omit=dev`);
- imports the copied production entry and creates a scripted, offline harness;
- verifies startup source records for harness-owned core entries;
- compiles and invokes an actual shipped app source entry from the copied `src/`;
- compiles the shipped opt-in web source entries without invoking them (provider
  credentials are a harness configuration concern, not a package-check network
  call);
- edits synthetic source/helper fixtures in the copied tree at the same path,
  registers through `toolRegistry`, invokes without discovery, replaces, and
  checks failed-publication invariance;
- checks self-replacement of `toolRegistry`, live nested lookup, memory and
  conversation continuity, and strict live-harness identity.

The command is wired into `package.json` as `test:package:tools` and is the last
package check in `prepublishOnly`, after build/type/runtime package checks.

## Accepted risk

- Agents may install behaviourally broken tools or break their own registration
  capability; the design does not prevent that.
- There is no automatic behavioural rollback, human approval workflow, per-tool
  isolation, security sandbox, or external-side-effect protection.
- Browser runtime compilation is not supported in this implementation.
- Compilation success is not a guarantee of type correctness or runtime
  correctness; agents must retest and iterate.
