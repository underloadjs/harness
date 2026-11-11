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
  keeps harness construction on descriptor metadata plus the GENERATED lazy loader
  (one `import()` per entry), so it registers the same declaration shape without
  compiling source and never fabricates browser source records.
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

## Baseline registration (metadata first)

`harness({})` holds **no hand-written registration inventory**. Construction
scans the package's `tools/**/*.tool.ts` entries and reads each entry's exported
`metadata` and `registration` literals through the TypeScript AST
(`core/tool-discovery.ts`). No `.tool.ts` module is imported or evaluated to build
that list, so a metadata-only entry (or one whose imports would fail) is still
discoverable — the failure only matters when the body is loaded for execution.

Each discovered row carries `{ name, metadata, sourcePath, label, origin,
group, activation, mode?, order, pendingOnly?, control?, primaryOnly?,
answerExtraction?, sessionBound?, listed?, alwaysDeclared? }`. `mode` is the
resolved turn policy — WHEN a completion may re-enter the model — bound to
the published DEFINITION rather than the wire name, and ABSENT when the
entry declared none so a consumer can tell "defaulted" (the runtime applies
`DEFAULT_TOOL_MODE`, `'sync'`) from "stated"; `alwaysDeclared` is a
DECLARATION classification (membership in the always-declared core
projection from `coreToolMetadata()`), not a registration condition. One
loop in `src/harness.ts` registers every row whose `activation` the current
configuration satisfies, in `order` (scan order):

| `activation` | registered when |
| --- | --- |
| `always` | every harness |
| `creation` | `toolCreation !== false` |
| `subagents` | the harness has a non-empty allowlist |
| `interaction` | `interaction` is configured |
| `forks` | `forks.enabled` |
| `threads` | the session opens its first independent thread |
| `websearch` | `websearch` is configured AND a provider key resolved (`createWebSearchTool` returned a tool) |
| `webfetch` | `webfetch` is configured (the factory always returns a tool: the `native` provider needs no key) |

For both web rows a host-registered tool of the same wire name wins, and the
provider surface (description, tags, and the per-harness `provider` enum)
replaces the entry's generic literal at registration — credentials and the
configured provider list never enter editable source. The `download` entry needs
neither credential nor configuration: it is a `preset`-group row with
`activation: always` and `visibility: searchable`, so every harness registers it and
opens it through `toolRequest` (order 235, between `gitDiff` 230 and `search` 240).
The two web rows are the opposite: `search.tool.ts` and `fetch.tool.ts` are
`visibility: core` (R9-R11), so a harness that REGISTERED them declares them on every
request - the gate is activation, never a discovery round. The server mirrors that
pair with one catalogue module per name (`src/server/harnesses/websearch.ts` and
`webfetch.ts`), and `describeHarness` advertises each environment name only when that
catalogue carries an executable definition for it.

The policy flags are bound to the published **definition object**, not the wire
name, so replacing a tool publishes an ordinary tool that inherits nothing:
`primaryOnly` (role gate + declaration filter), `answerExtraction` (delegation
answer parsing), `control` (`cancel`/`fork`/`action` run dispatch), `pendingOnly`
(declared only while the agent has work in flight).

`presets: false` filters the `preset` **group** and nothing else; the runtime
(harness-owned) rows stay registered. Configured `toolSources`, `toolFolders`,
`tools`, and plugins keep their historical precedence: they are committed after
the baseline, so an override of a baseline name intentionally wins.

Adding a tool therefore means adding one `*.tool.ts` entry with its `metadata`
and `registration` literals. No registry edit, no static import, and no manual
inventory. `src/tools/descriptors.ts` derives the package catalogue from the SAME
scanner `harness({})` uses (T24), so a cold Node process already lists and loads a
brand-new entry; regenerating the data-only manifest (`yarn tools:manifest`) is
only needed for the BROWSER build, which cannot scan or parse TypeScript.

## Production source model

The published package contains two siblings:

```text
<installed-package>/
  dist/   generated production entry and chunks
  src/    editable TypeScript source shipped for inspection and compilation
```

`sourcePath` values are resolved relative to the installed `src/` root (or may be
absolute). `harness.toolSource(name).sourcePath` therefore reports a package-
relative label such as `tools/runtime/toolRegistry.tool.ts`, not a generated
`dist/` module. TypeScript is a runtime dependency of the package because the
compiler is needed in production.

The package `files` allow-list includes `src` and excludes tests. The runtime
compiler must remain able to read these editable entries after a production
install; generated `dist/` files are not the editable source model.

The opt-in web tools also ship independently as `tools/runtime/search.tool.ts`
and `tools/runtime/fetch.tool.ts`; their editable provider implementations are shipped
too — `tools/websearch/` (`exa.ts`, `tavily.ts`, `linkup.ts`) and
`tools/webfetch/` (`native.ts`, `exa.ts`, `linkup.ts`). The registered entries
delegate provider/credential operations to the harness that owns them; startup
supplies the configured metadata/runtime closure. `download` is different:
`tools/webdownload/download.tool.ts` is a self-contained preset entry with no
harness-owned closure (no credential, and its bounds and MIME tables are inline
literals so a compiled revision keeps `dependencies: []`). A replacement
registered under those names is an ordinary source revision and
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
// undefined means the tool was registered from an already-built definition with no
// source attachment (a bare configured tool or a plugin) and has no editable source
// revision. A configured tool that ALSO carries its bytes — `tools: { name: { tool,
// source: { moduleText | sourcePath } } }` — does have one: the revision the compile
// derived from those bytes, with the definition itself never re-evaluated. Its
// `checks` report what construction actually established for the pair
// (`transpile:syntax`, `contract:tool`, `schema:json`), never `'load:module'`.

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

### Compile a candidate without touching the registry

Answering "is this definition valid?" with a harness is expensive and ambiguous:
constructing one builds agents and a transport, and a throw from inside that build is not
the same fact as "the candidate does not transpile". The root export
`compileToolSourceModule(candidate, options?)` is the read-only half of the same kernel —
no harness, no registry, no registration semantics changed:

```ts
import { compileToolSourceModule, supportsToolCompilation } from '@underload/harness';

const compiled = compileToolSourceModule({
    name: 'example',
    description: 'Return a greeting.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    moduleText: 'export default { … }'
    // sourcePath: 'tools/example.tool.ts'   // alternative: an editable entry on disk
    // dependencies: [{ path, text }]        // virtual local helpers for moduleText
    // definition                            // an already-built Tool to publish instead
});
// compiled: { name, description, tags, parameters?, visibility,
//             revision, record, checks, definition? }
```

- `revision`/`record` are the SAME content-addressed identity `harness.toolSource()`
  reports for that source, because both sides derive it from the same captured bytes:
  `compileToolSourceModule({ name, moduleText })` and
  `tools: { name: { tool, source: { moduleText } } }` produce the same revision.
- `definition` is callable and registered **nowhere**. The caller may run it, publish it
  into a harness with `registerTool({ definition, … })`, or drop it.
- `evaluate` selects how far the compile goes. `'load'` (default) transpiles, resolves the
  static import graph, and EVALUATES the module to take the definition it exports — so the
  candidate's top-level code runs, with the side-effect cost stated in **Platform and
  limits**. `'syntax'` stops after the transpile (plus the JSON-shape check of a supplied
  `parameters`), which is what an endpoint validating untrusted source wants: the answer
  costs no side effects. `'syntax'` with no supplied `definition` must be given `name`,
  because nothing is evaluated to read it from, and the metadata reported is then the
  candidate's own.
- A supplied `definition` selects the no-load path in EITHER mode: the module is not
  evaluated, the caller's object is what `definition` holds, and the revision still comes
  from the bytes beside it.
- `checks` is the whole claim, and it is mode-honest:
  `['transpile:syntax']` (plus `'schema:json'` for a supplied schema) in `'syntax'` mode,
  `['transpile:syntax', 'contract:tool', 'schema:json']` for a supplied definition with
  source, and `'load:module'` with `'load'`.
  **No mode performs semantic type checking** — the compiler is `ts.transpileModule`, so a
  type error a project build would report is not a compile failure here, exactly as with
  registration.
- Repeated compiles of the SAME input are served from a process-level compile cache
  (bounded FIFO, 128 entries; failures are not cached, and a disk-path candidate is never
  cached, because an edited helper would move the revision under unchanged entry bytes).
  `{ cache: false }` re-transpiles and re-evaluates every call. The cache is compile-side
  only: the registration path never consults it, so
  `toolRegistry`/`toolFolders` still evaluate fresh bytes every time.
- `supportsToolCompilation` is the flag to branch on instead of probing an error string:
  true on Node, false in the browser build, where this entry throws the same actionable
  error `toolSource` does.

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

### Tool-contributed commands

A tool package does not have to stop at tools. The same plugin that calls
`api.addTool` can call `api.addCommand`, so a tool and the operator command that
drives it ship as one unit — and a host that owns the harness can declare the same
command declaratively through `commands` with no plugin at all. A command is an
**operator action, never a prompt**: `execute` receives the tokenized line
(`{ harness, name, args, rest, input }`, grammar in `src/core/command.ts`) and returns
`{ content, isError?, data? }`, and the model is never called. The command below calls
the tool this same package registered, through the live registry.

```ts
import type { HarnessPluginApi } from '@underload/harness';

// A tool package exports the plugin; the host passes it to harness().
export const deployPlugin = {
    name: 'deploy',
    setup: (api: HarnessPluginApi) => {
        api.addTool('deployStatus', {
            description: 'Report deployment status for an environment.',
            parameters: { type: 'object', properties: { env: { type: 'string' } } },
            execute: async ({ parameters }) => status(parameters)
        });

        api.addCommand('deploy', {
            description: 'Report deployment status.',
            usage: '/deploy [env]',
            execute: async ({ harness, args }) =>
                ({ content: JSON.stringify(await harness.executeTool('deployStatus', { env: args[0] ?? 'dev' })) })
        });
    }
};

// Equivalent from the host, no plugin involved.
const writer = harness({
    agents: { /* … */ },
    commands: [
        {
            name: 'deploy',
            description: 'Report deployment status.',
            usage: '/deploy [env]',
            execute: async ({ harness, args }) =>
                ({ content: JSON.stringify(await harness.executeTool('deployStatus', { env: args[0] ?? 'dev' })) })
        }
    ]
});

await writer.executeCommand('/deploy staging');   // no model request, no progress event
```

Names follow `COMMAND_NAME_PATTERN` (`/^[a-z][a-z0-9-]{0,31}$/`): one lowercase letter,
then lowercase letters, digits, or `-`, at most 32 characters. An optional leading slash
and any case are stripped first, so `addCommand('/Deploy', …)` registers `deploy`.
`description` is required and `usage` is optional (shown by `/help`).

**Collision policy is registration order, and it is asymmetric on purpose.** Built-ins
(`/help`, `/tools`, `/task`, `/websearch`, `/webfetch`) install first, then
`configuration.commands` — a name that collides inside that declarative phase throws at
construction. A plugin's `addCommand` and a runtime `harness.registerCommand()` run
later and therefore REPLACE by name, exactly like `addTool`: overriding `/task` is the
supported way to change a built-in, and a tool package that contributes a NEW verb
should pick a name nothing else uses, because it silently takes precedence over a
configured entry of the same name. The registry is read at call time, so the
replacement is live for the next command and never for one already in flight.

Because commands are harness-side, the CLI and the server execute the contributed
command with no per-front-end wiring: the terminal forwards every unrecognized `/name`
to `harness.executeCommand`, and `POST /sessions/:id/tasks` records the result as a
terminal turn (see `README.md`, “Slash commands”).

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

Every shipped preset's tool source routes are compiled through the
shared source operation (a test fixture that opts into extra source tools goes through
the same operation). The `toolRegistry` catalogue entry is session-bound: a
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
