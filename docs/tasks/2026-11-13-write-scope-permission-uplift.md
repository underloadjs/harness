# Write-scope fence + harness permission — full-scope uplift

**Date:** 2026-11-13
**Method:** read survey of the whole mutation path (file tools, command tools, the registration/replace kernel, the restart/reload load path), plus live probes driven through the shipped registry with `yarn vite-node` — `Temp/instruct/escalation-probe.ts` (P1–P5) and `Temp/instruct/reload-probe.ts` (R1–R2). Two more probes, `Temp/instruct/perm-probe.js` and `perm-child.js`, ran under raw `node --permission` because their subject IS Node's own permission flags, which the sanctioned runner does not expose (root `AGENTS.md` §Runtime / runner policy exempts code that does not run as repo code). All four scripts are disposable and live in repo-root `Temp/instruct/`. Every claim below is either `path:line` or a probe line quoted in `## Probe evidence`.
**Scope:** what the model can *destroy* — `write`, `edit`, `files` (move/copy/delete/mkdir), `download`, `shell`, `toolCreate`/`toolRegistry`/`toolManage` — and the registration rules that decide **who is allowed to be the implementation of a core tool**. Host-side persistence (`src/server/persistence.ts`, `journal.ts`, the `<root>/harness/` database) is out of scope: it never passes through a tool, and this uplift must not touch it.

Framing decision the whole plan hangs on: **this harness is not a product.** It is run personally, at the operator's own risk. The target is therefore *maximum accident-protection with honest boundaries*, not a hostile-tenant security boundary. Every layer below says out loud what it cannot stop, and the package's standing rule — never describe anything as a sandbox (`src/core/creation.ts:19-22`, `README.md:745`, `docs/runtime-tools.md` §"Path fencing is not a sandbox") — stays in force.

---

## Findings

### F1 — There is no root/work-directory concept anywhere in the write path

Every file tool resolves paths itself against `process.cwd()` and accepts absolute paths verbatim:

| Tool | Resolve site | Notes |
|---|---|---|
| `write` | `src/tools/files/write.tool.ts:205` (`resolve(path)`), `mkdir(dirname(target), {recursive:true})` at `:314` | `mkdir` is what turns a typo into created directories across the disk |
| `edit` | `src/tools/files/edit.tool.ts:721` | overwrite in place |
| `files` | `src/tools/files/files.tool.ts:384-395` (`path`/`from`/`to`), `:504` (`mkdir`), `:644` (`to ?? resolve('.')`) | move/copy/delete/mkdir |
| `download` | `src/tools/webdownload/download.tool.ts:240-245, 267` | writes bytes with `flag: 'wx'` at `:274` |
| `shell` | cwd arg `src/tools/command/shell.tool.ts:199-214`, tee dir `:395` | tee lands inside cwd; the command itself goes anywhere |

The package documents the gap and delegates it to the host: `src/tools/files/index.ts:6-7` ("**No sandbox** … or wrap `execute` to add a fence"), `src/tools/files/read.tool.ts:376-378`, `README.md:1301-1304`, `README.md:4005-4010` ("There is deliberately no advertised workspace root … a file-root option would promise behaviour the tools do not implement"), `knowledge.md:4993-4996` ("sandboxed presets and created tools … a `root`-scoped/fenced variant" — Not built yet). Probe **P1**: `write` with `../outside-check.txt` succeeded and reported the absolute path.

There is already a correct fence implementation in the package to copy: `src/core/tool-source.ts:780-866` — containment by realpath of the **nearest existing ancestor**, a re-check **after `mkdir`** (`:856-861`), and symlink-target rejection (`:836`). `isPathInside` (`src/core/tool-source.ts:612`) is module-private.

### F2 — A **created tool may take over a core tool's name**; the reserved gate is never fed

`src/core/creation.ts:107-125` implements a reserved-name gate — and the live registration path calls `createDynamicTool(creation, {})` with **no reserved list** (`src/core/tool-source.ts:1941`). The harness side does not add one either: `createToolFrom` (`src/harness.ts:3435-3465`) → `acceptTool`, whose comment states the rule (`src/harness.ts:2010`: "REPLACEMENT: names are not reserved, 'already registered' is not an error") and whose publish step is unconditional (`src/harness.ts:2208-2210`, `tools[name] = prepared.tool`). A replacement also never spends the creation budget (`src/harness.ts:2196-2206`: "Replacing an existing definition never exhausts the budget").

Probe **P2**: `h.createTool({ name: 'write', source: 'return "HIJACKED-BY-CREATED-TOOL";' })` → **accepted**; `write` then answered the hijack and **wrote nothing at all** (the target file still held its previous content). The revision pair (`7c734b58…` → `2cecd7b0…`) proves the preset's own source was replaced, not shadowed.

Model-facing `toolManage` is the same door with a schema: its operation enum is `list|details|source|path|create|update|reload` (`src/core/tool-manifest.ts:225-232`), so `create`/`update` on a preset name is a normal call. `remove`/`enable`/`disable` are host-only by contract (`src/types/index.ts:1131-1149`) and reach the process through the REST operator routes (`DELETE /v1/harness/sessions/:s/tools/:name`, `src/server/api-session-tool-writes.test.ts:254-269`) — a run cannot unregister what the operator installed.

### F3 — The rewrite-then-reload escalation is real, and it has three persistence grades

This is the vector the uplift was asked to check ("rewriting core tools' methods and then somehow restarting the server … grants permission beyond scope"). Confirmed, with grades:

| Grade | How | Lifetime | Evidence |
|---|---|---|---|
| **(a) runtime-only** | `toolCreate`, or `toolManage update persist:"runtime"`, on a **baseline** name | live until the harness instance dies or the session restores — deliberately **not recorded**, because "replacing a baseline preset/core tool is runtime-only" (`src/harness.ts:2230-2256`) | P2: snapshot `createdTools` stayed `[]`; restoring into a fresh instance brought the **real** preset back. P3: `manageTool update persist:'runtime'` on `write` → `created:false, replaced:true`, `write` answers `MANAGE-RUNTIME-HIJACK` |
| **(b) snapshot-persisted** | a **new** name created at runtime | survives snapshot/restore (`src/core/snapshot.ts:802-925`; restore recompiles at `src/harness.ts:11481-11509`, `:11662-11671`) | grade (b) cannot hijack a preset name — it is grade (a) that does |
| **(c) disk-persisted** | `toolManage create/update` writing a `*.tool.ts` inside a configured `toolFolders` root | **survives process restart**, because "Disk is the source of truth: a restart re-scans toolFolders" (`src/harness.ts:2236-2240`) and folder entries are published through the startup kernel where "a later folder wins a name collision" (`src/harness.ts:4403-4413`, `docs/runtime-tools.md` §External tool folders) | P4: a folder module publishing `name:'write'` **beat the preset at startup**; the model then rewrote that file through `toolManage update path:'mywrite.tool.ts'` (`replaced:true`, `sourcePath` = the folder file); a freshly built harness — a simulated restart — executed the model's own code: `MODEL-REWRITTEN-WRITE-SURVIVES-RESTART` |

**Grade (c) is currently unreachable in the shipped server**: `createToolboxHarness` passes `toolSources` + `presets:false` (`src/server/harnesses/toolbox.ts:601-606`) and **never** `toolFolders`; `SHARED_TOOL_FOLDERS` (`src/server/harnesses/toolbox.ts:178`) is re-exported at `src/server/harnesses/index.ts:59` and handed to nobody. So `configuredToolFolders.length === 0` and a persistent op refuses (`src/harness.ts:2473-2477`) — probe **P3**: `toolManage update cannot persist: no toolFolders are configured.` It becomes reachable the moment an operator follows the documented integration path (`docs/runtime-tools.md`) and adds a folder, and `toolSources` paths are **not** a write fence.

Two extra reachability notes: no process restart is even required for the hijack to spread — `toolManage reload` recompiles the installed revision in place (`src/harness.ts:2961-3005`), and every **new session** builds its own harness and compiles each `toolSources`/folder path on first use (`src/server/harnesses/tools.ts`, `src/server/harnesses/toolbox.ts:591-597` "COLD-STARTUP DISCOVERY").

### F4 — The harness cannot restart the server, and does not need to

No model-facing tool and no REST route exits the process: `src/server/api.ts`, `src/server/service.ts` and `src/server/handler.ts` contain no `process.exit`/shutdown call (the word `restart` appears there only in comments about what a restart does to durable rows), `fetch` is a bounded GET (`README.md` §Web fetch) and `download` is GET retrieval, so neither can POST a control call. Teardown exists only inward (`harness.dispose`, `src/types/index.ts:4153-4155`) and operator-side — the real process shutdown is the CLI's signal handling (`src/server/cli/index.ts:398-404`: `SIGINT`/`SIGTERM` → `process.exit(0|1)`). A `shell` line (`pkill`, `systemctl --user restart`, a watcher touching a file) is therefore the harness's only route to a true restart — which is precisely the case a tool-layer fence cannot cover (F6).

### F5 — `toolManage reload` is broken for **every** function-body revision

`src/harness.ts:2999-3004` rebuilds the tool from `{ name, source }` alone, dropping description and tags, and `createDynamicTool` requires a description (`src/core/creation.ts:127-130`). Probe **R1**: reloading a plain created tool throws `Tool "plainBody" requires a description.` while `details` on the same tool reports the description present (R2). Probe **P3** shows the same failure after a runtime replacement of `write`, and `write` stayed hijacked afterwards — so a failed `reload` leaves the escalated revision live rather than restoring anything.

Adjacent to the fence work, not part of it, but it sits on exactly the load path this uplift depends on, so it is a prerequisite task (T9), not an optional fix.

### F6 — A created tool's body has real filesystem reach under the sanctioned runner

Probe **P5**: a `toolCreate` body reached `process.getBuiltinModule('node:fs/promises')` and wrote a file **outside `process.cwd()`** — under `yarn vite-node`, the only runner this repo allows (root `AGENTS.md` §Runtime / runner policy). Dynamic `import()` inside a created body does **not** work under that runner: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, because compilation is `new AsyncFunction` in the host realm (`src/core/creation.ts:96`, documented at `src/core/creation.ts:19-22` "the full permissions of the process: filesystem, network, child processes").

Consequence for the design, stated up front so nobody later over-promises: **a grant can be withheld from a created tool; raw JS in a created body cannot be stopped by any in-process check.** The `shell` tool is the same story one level up (Node's Permission Model does not confine child processes — probe `perm-child.js`: a `sh -c 'echo x > /tmp/…'` child wrote fine while the parent was restricted).

### F7 — `corrected`: created→created calls are **not** restricted today

The belief that a created tool cannot call another created tool is `corrected`, kept here because the reasoning is auditable:

- The `toolCreate` description says the opposite outright: "Nothing forbids the forwarding call (this package has no sandbox)" (`src/core/tool-manifest.ts:330`, `src/tools/runtime/toolCreate.tool.ts:17`).
- What exists is a **report code**, `created-tool-proxy` (`src/server/workers/capability.ts:495-511`), raised only from the worker-lane authority path (`:694-697`) — an inline session gets nothing at all.
- The detector is a **text-pattern scan** of the body (`capability.ts:499-507`), which the tool description itself admits "also fires on a comment or a string", so it is neither a call-graph check nor reliable in either direction.

So there is a *policy statement with an advisory signal in one of two execution modes*, and no rule. Whether to make it a rule is open decision D5.

### F8 — Every registry mutation crosses the worker authority, in both modes

`toolManage` and `toolCreate` are routed to the canonical harness: `AUTHORITY_RUNTIME_METHODS` maps `manageTool → 'toolManage'` and `createToolForAgent → 'toolCreate'`, and both names are in `SHARED_STATE_TOOL_NAMES` (`src/server/workers/capability.ts:190-234`). A lane replica therefore cannot be the enforcement point — the hijack lands on the one canonical registry the session shares. Enforcement belongs inside the tool bodies and the registration kernel, not on the replica handle.

---

## Target design

Four terms, kept as small and closed as the package's other unions:

1. **Root** — one absolute directory per harness. Default `process.cwd()` (the value the harness already reports to the model). Override: `HARNESS_FS_ROOT` (matching the `HARNESS_*` server convention at `src/server/config.ts:373-375`), and `harness({ fs: { root } })` for library hosts. `variables.root` stays what it is today — the DB/storage boundary (`README.md:4005-4011`) — and is **not** the fs root.
2. **Guard** — the in-tool path fence (L1 below). On by default for every model-facing mutation.
3. **Permission** — a named, **default-off** capability the host grants, which the guard consults. Closed union, one key now, shaped so later keys fit:
   ```ts
   export type HarnessFsPermission = 'writeOutsideRoot' | 'deleteRootSelf' | 'followSymlinksOut';
   harness({ fs: { root?, permissions?: readonly HarnessFsPermission[] } })
   ```
   Absent/false = the guard refuses; a grant opens exactly that one exception. Resolution happens once at construction (like the `websearch`/`webfetch` credential rule, `src/types/index.ts:3596-3610`) and is **readable, never self-issued**: `harness.fs()` answers `{ root, permissions }`; no model-facing tool can add a permission.
4. **Trust class** — stamped on every registration: `baseline` (descriptor-registered presets/core), `installed` (host `tools` / `toolSources` / `toolFolders` at startup, plugin `addTool`), `created` (anything registered after startup through `toolCreate` / `toolRegistry` / `toolManage`). Carried as a marker on the definition object, exactly like the existing runtime-control marker that a replacement deliberately drops (`src/harness.ts:832`, and the same identity-based reasoning at `:1304-1328`), plus a parallel ledger beside `toolOwningPaths`/`toolSourceRecords` (`src/harness.ts:1285`, `:2211-2228`). `toolSource(name).trust` publishes it.

**The two rules the user asked for, made operational:**

- **A tool may bypass; a created tool may not.** The guard consults the *grant held by the registration that is executing*. `baseline`/`installed` registrations are configured by the operator, so they may carry a permission and may call the escape hatch the guard exposes (`withRootExempt()`); `created` registrations get `undefined` in their `ToolContext` (`src/types/index.ts:2216-2260`) and the escape hatch throws for them. Since F6 shows a created body can reach `fs` itself, this is stated in the tool text as *the harness will not grant you more scope*, not *you are confined*.
- **A created tool may not become a core tool.** Replacing a `baseline` name after startup is the escalation in F2/F3, so it is refused by default and only proceeds under an explicit operator opt-in (`harness({ fs: { allowBaselineReplacement: 'runtime' | 'never' } })`, default `'never'`), never silently, and never to disk.

### Enforcement layers and honest coverage

| # | Layer | `write`/`edit`/`files`/`download` | created-tool bodies | `shell` commands | Cost | Model sees a usable refusal |
|---|---|---|---|---|---|---|
| L1 | Guard in the tool layer (new) | ✅ | — (they don't call the tools) | cwd only | ~120 lines + 4 call sites | ✅ named-permission error |
| L2 | Registry trust gate (new) | ✅ (blocks the self-grant) | ✅ refuses baseline takeover, refuses disk persistence of a baseline name | n/a | ~80 lines | ✅ |
| L3 | Node Permission Model, operator opt-in | ✅ | ✅ (`process.getBuiltinModule` writes hit the same `fs` layer) | ❌ (probe `perm-child.js`) | config only | ⚠️ `ERR_ACCESS_DENIED` |
| L4 | OS containment (`bwrap`, installed here at `/usr/bin/bwrap`; `unshare`/Landlock also present) | ✅ | ✅ | ✅ | per-deployment launcher | ❌ `EACCES`/`EROFS` |
| L0 | Instruction + audit (`src/agents/guidelines.ts:87-90`, `tool.before`/`tool.after` observers, `turn.before` `stop`) | ⚠️ detection, not prevention | ⚠️ | ⚠️ | small | partly |

L1 + L2 are the uplift's default-on core and work in every deployment. L3 is the recommended belt for created bodies (verified: Node v24.19.0 exposes `--permission`/`--allow-fs-write`, in-process writes outside the allow-list → `ERR_ACCESS_DENIED`); its allow-list is more than one path — Vite's cache, `node_modules/.vite`, the `<root>/harness/` database, the `shell` tee dir, plus `--allow-child-process` or `shell`/`gitDiff`/`syntax` die. L4 stays the operator's call and is exactly what the docs already tell a host to provide (`README.md:1301-1304`).

### Refusal style

Every refusal is a normal `HarnessError` in the package's established "honest, actionable" voice — naming the tool, the resolved absolute target, the root, and the permission that would allow it, e.g.

> `write refused "../notes.md": resolved "/home/you/notes.md" is outside the working directory "/repo/noobscript". Write inside it, or ask the operator to grant the writeOutsideRoot permission. No file was written.`

`files` keeps its existing split contract (`src/tools/files/index.ts` BATCHING note): a refusal in preflight changes nothing; a mid-batch failure names the ops already applied and promises no rollback.

---

## Tasks

Ordered so the protection lands before the ergonomics. Each task names its files and one **closing check** (all checks run `yarn vitest run <file>` or the named script, per root `AGENTS.md`).

### Phase 1 — the guard (L1): stop the accident

**T1 — Shared path-guard helper.** New `src/core/path-guard.ts`: `resolveGuardedPath({ tool, path, root, mode: 'write'|'delete'|'mkdir'|'read' })` implementing the `tool-source.ts:780-866` discipline (resolve → realpath nearest existing ancestor → containment → reject a symlink target that leaves the root → re-check after `mkdir` at the call site). Export `isPathInside` from `src/core/tool-source.ts:612` instead of duplicating it.
*Check:* new `src/core/path-guard.test.ts` — `..` traversal, `a/../../b`, an absolute path inside and outside, a symlinked ancestor, a symlinked target, a not-yet-existing leaf, and the post-`mkdir` symlink swap. Windows case-alias behaviour marked `unconfirmed` — the case/symlink identity helper (`src/tools/files/identity.ts`) was exercised on Linux only.

**T2 — Apply the guard to the four mutation tools.** `write.tool.ts:205`, `edit.tool.ts:721`, `files.tool.ts:384-395`/`:504`/`:644`, `download.tool.ts:240-267`. Reads stay unrestricted by design (a read leaks, it does not destroy; see D2). The `files` `from` side follows the D3 rule (copy-in allowed, move-out refused).
*Check:* one refusal case per tool in `write.test.ts`, `edit.test.ts`, `files.test.ts`, plus `src/tools/files/files.test.ts` asserting the batch-level preflight contract is unchanged.

**T3 — Root-destruction and cwd rules.** (i) `files` `delete`/`rm` of the root directory itself is refused (F1's most expensive accident); (ii) `shell`'s `cwd` argument (`src/tools/command/shell.tool.ts:199-214`) is guarded, with the tee directory (`:395`) proven inside the root by construction; (iii) `gitDiff`'s `cwd` (`src/tools/command/gitDiff.tool.ts:237`) is guarded for consistency.
*Check:* `src/tools/command/shell.test.ts` + `gitDiff.test.ts` refusal cases; a `files.test.ts` case for `delete(root, {recursive:true})`.

**T4 — Text that must agree with the new behaviour.** Tool descriptions in `src/core/tool-manifest.ts` for `write`/`edit`/`files`/`download`/`shell`/`gitDiff` (state the root and the refusal), `src/agents/guidelines.ts:87-90` (`PERMISSIONS_GUIDELINE` currently promises "unsandboxed with the server process permissions"), and the `## No sandbox` header comments in `src/tools/files/index.ts:6-7` and `read.tool.ts:376-378` (rewrite as "writes are rooted at the working directory; reads are not").
*Check:* `yarn tools:manifest && yarn test:contract` regenerates `scripts/generate-harness-contract.test.ts`'s fixture and stays green; `yarn vitest run src/agents/agents.test.ts src/server/api.test.ts`, which assert the shipped guideline text.

### Phase 2 — the permission

**T5 — Permission type + construction-time resolution.** `HarnessFsPermission`, `harness({ fs })`, one resolution at construction, `harness.fs()` read surface, `HARNESS_FS_ROOT` in `src/server/config.ts` beside `:373-375`.
*Check:* `src/harness.test.ts` (or a focused `src/harness.fs.test.ts`) — default `process.cwd()`, env override, an unknown permission key refused at construction, `fs()` immutable.

**T6 — Trust classes.** Stamp `baseline`/`installed`/`created` at registration (`acceptTool`, `src/harness.ts:2164-2290`, using the existing `startupPhase`/`options.baseline` flags at `:2196-2206`), publish `toolSource(name).trust`, and expose the executing registration's trust to its body (`ToolContext`).
*Check:* a test proving a preset reports `baseline`, a `tools:` entry reports `installed`, a `toolCreate` result reports `created`, and a runtime replacement of `write` re-reports the name as `created` (this is the F2 assertion).

**T7 — Grant only to trusted registrations.** The guard reads the permission **through the executing registration**; `baseline`/`installed` may hold one, `created` gets `undefined`, and the `withRootExempt()` escape hatch throws for `created`. Because F6 proves a created body can bypass in-process anyway, the created-tool text says "you get no grant", not "you are confined".
*Check:* a created tool that tries the escape hatch is refused with a named reason; the same body run as an `installed` revision succeeds.

**T8 — Audit + UI.** Log every guard decision (refusal or permission use) through `configuration.report.stateChange`/`diagnostic` (`src/types/index.ts:3627-3640`) and surface root + active grants in the Tools/Session panes (`src/frontend/view-api.ts`, next to the existing `createdToolCount`/`createdLimit` fields at `:170-171`).
*Check:* a `src/server/plugins.test.ts`-style assertion that a refusal produces exactly one diagnostic, and the frontend test for the new row.

### Phase 3 — the escalation gate (L2)

**T9 — Fix `toolManage reload` first.** `src/harness.ts:2999-3004` must rebuild a function-body revision with the record's own `description`/`tags`/`parameters`/`visibility`, and a failed reload must leave the previous definition live (P3 showed the hijack survives a failed reload).
*Check:* `src/harness.tool-failures.test.ts` — reload round-trips a function-body tool (R1 today, P3 today) and keeps the prior implementation on a compile failure.

**T10 — Refuse a created takeover of a baseline name.** In `acceptTool`, a post-startup registration whose name is `baseline`/`installed` is refused unless `fs.allowBaselineReplacement === 'runtime'`; the refusal text names the trust class and the operator switch. Disk persistence under a baseline name stays refused in every mode (grade (c) in F3).
*Check:* the F2 probe becomes a test — `toolCreate({ name: 'write' })` refuses by default, answers `replaced:true` under the opt-in, and reports the new revision's `trust: 'created'`.

**T11 — Feed the reserved-name gate, and keep the one replacement flow that is real.** Pass the registry's own name list into `createDynamicTool` instead of `{}` (`src/core/tool-source.ts:1941`; the gate itself already exists at `src/core/creation.ts:107-125`). Boundary to pin, so T10 and T11 cannot contradict each other: `toolCreate` refuses a name that belongs to a `baseline`/`installed` registration (T10's rule, plus the `'runtime'` opt-in), **keeps** its existing power to re-register a name it created itself (`replacingCreated`, `src/harness.ts:2191`, `:2244-2246`), and the host paths `registerTool`/`createTool` still replace anything on purpose (`src/harness.ts:2010`, `:12602-12604`).
*Check:* one test per side of that line, in `src/harness.creation.test.ts` and `src/harness.creation-policy.test.ts`.

**T12 — Decide and implement the created→created call rule (D5).** If restrictive: replace the text-pattern scan (`src/server/workers/capability.ts:499-507`) with a real check at call time — a `created` body's `context.callTool` may not name a `created` tool — so both execution modes agree (F8). If advisory-only: keep the report code, but fix its two lies (inline mode reports nothing; the pattern fires on comments) and update the description at `src/core/tool-manifest.ts:330`.
*Check:* whichever way D5 lands, one test in inline mode and one in lane-worker mode, plus `src/harness.delegation.test.ts` unaffected.

### Phase 4 — process-level belts, server surface, docs

**T13 — L3 packaging.** A documented launch recipe plus a checked allow-list builder for `--permission --allow-fs-write=…` (workspace root **plus** the harness database root, Vite cache, `node_modules/.vite`, the `shell` tee dir, `--allow-child-process`), with the child-process limitation (`perm-child.js`) stated in the doc.
*Check:* a `scripts/` probe or doc snippet that boots the server under the flags and runs one `write` inside and one outside.

**T14 — L4 recipe.** A `bwrap`/`unshare` launcher example (both present on this host) for operators who need `shell` contained. Documentation only; no runtime coupling.
*Check:* the recipe is exercised once manually and its output recorded in the task entry.

**T15 — Server + API + docs.** (i) advertise the root: `ServiceInfo` gains `fs_root` + `fs_permissions`, which is what finally makes `README.md:4005-4010` true instead of apologetic; (ii) keep the constant-size promise in `src/shared/harness-api.ts`; (iii) update `README.md:741-750`, `:1132`, `:1301-1304`, `:1730-1732`, `:4005-4010`; (iv) move `knowledge.md:4993-4996` out of *Not built yet* and add a Decisions row; (v) add a `docs/permissions.md` (or a § in `docs/runtime-tools.md`) as the single home for the layer table.
*Check:* `yarn tools:manifest:check && yarn plugins:manifest:check && yarn typecheck && yarn test && yarn test:contract && yarn test:package:files`.

---

## Decisions (answer before Phase 1 merges)

| # | Question | Recommendation |
|---|---|---|
| D1 | Guard on by default? | **On.** The whole point is the un-guarded accident; an operator who wants none sets one env var. |
| D2 | Fence reads too? | **No.** `read`/`glob`/`grep` keep roaming; a fence that blocks reads costs usefulness and buys no protection against deletion. Optional `fs.readOutsideRoot='deny'` later, not now. |
| D3 | `files` `copy`/`move` with an outside `from`? | **`copy` in allowed, `move` out refused** — a move destroys the outside original. |
| D4 | Symlink writes? | **Refuse a symlink target that resolves outside the root** (matches `tool-source.ts:836`). |
| D5 | Is created→created a rule or an advisory? | **Advisory fixed in place (T12 second branch)** unless the operator wants the restriction; the current state is neither, and it is the finding most likely to be re-reported (F7). |
| D6 | Baseline replacement by a run? | **Refused by default** (`'never'`), `'runtime'` as the operator switch, disk never (T10). |
| D7 | Does a *new* created name get the permission if the harness holds one? | **No** — a grant travels with the registration, not with the harness (this is the user's "tools can bypass, not createdTools"). |
| D8 | Where does the root live for the server: per-harness card, or one process-wide value? | **Process-wide env + per-harness override**, so a card cannot quietly widen its own scope without an operator edit. |

---

## Probe evidence

`Temp/instruct/escalation-probe.ts` (run: `yarn vite-node Temp/instruct/escalation-probe.ts`), `Temp/instruct/reload-probe.ts`, `Temp/instruct/perm-probe.js`, `Temp/instruct/perm-child.js` (`node --permission --allow-fs-write=…`). Reproduction is disposable; nothing in `Temp/` is a deliverable (root `AGENTS.md` §Scratch space) — T2/T9/T10 promote the assertions into real test files.

```text
P1 write inside cwd -> [{"path":"…/Temp/instruct/probe/a.txt","bytes":4}]
P1 write ../outside -> [{"path":"…/Temp/instruct/outside-check.txt","bytes":1}]
P1 revision before -> 7c734b58e056 sourcePath: tools/files/write.tool.ts
P2 createTool(name:"write") refused? -> NO (accepted)
P2 write now returns -> "HIJACKED-BY-CREATED-TOOL"
P2 file content unchanged? -> "real"                       ← the hijacked write never touched disk
P2 snapshot.createdTools -> []
P2 revision after -> 2cecd7b0847c
P2 after restore, write -> [{"path":"…/Temp/instruct/probe/a.txt","bytes":8}]   ← the real preset is back
P3 manageTool update persist:folder (no toolFolders) -> THROWS: toolManage update cannot persist:
   no toolFolders are configured. Add a toolFolders entry or pass persist: "runtime".
P3 manageTool update persist:runtime -> {"name":"write","created":false,"replaced":true,
   "previousRevision":"7c734b58e05670fa","checks":["transpile:function-body",…]}
P3 write now -> "MANAGE-RUNTIME-HIJACK"
P3 manageTool reload -> THROWS: Tool "write" requires a description.
P3 write after reload -> "MANAGE-RUNTIME-HIJACK"           ← a failed reload restores nothing
P4 startup folder shadow -> "FOLDER-WRITE-WINS"            ← a folder module beat the preset at boot
P4 toolSource(write).sourcePath -> …/probe/tools/mywrite.tool.ts
P4 model rewrite of write -> {"created":false,"replaced":true,"sourcePath":"…mywrite.tool.ts",…}
P4 after simulated restart, write -> "MODEL-REWRITTEN-WRITE-SURVIVES-RESTART"
P5 created tool -> {"process":"object","getBuiltinModule":"function","cwd":"…/noobscript"}
P5 wrote OUTSIDE the cwd -> true

R1 reload a plain created tool -> THROWS: Tool "plainBody" requires a description.
R2 details on the same tool -> {"description":"A plain created tool with a function body.",…}

perm-probe (node --permission --allow-fs-write=<repo>/Temp/**):
  OK    ./Temp/instruct/inside.txt
  DENY  <repo>/knowledge.md.outside -> ERR_ACCESS_DENIED
  DENY  /tmp/outside.txt -> ERR_ACCESS_DENIED
perm-child (--allow-child-process, restricted parent):
  CHILD OK    ./Temp/instruct/child-inside.txt
  CHILD OK    /tmp/child-outside.txt                        ← child processes are NOT confined
```

## Not tested

- No real provider was called: every probe is construction + direct tool execution, no model turn.
- Lane-worker mode was read, not run: F8's routing claim is code-only (`capability.ts:190-234`); the T12 check is where it gets exercised.
- "Simulated restart" in P4 means a **fresh `harness()` in the same process** with the same folder — not a server process restart against a persisted database. The folder-rescan claim is anchored in code (`harness.ts:2236-2240`, `:4403-4413`); grade (c) end-to-end through `src/server/persistence.ts` is unverified, and grade (c) is unreachable in the shipped server today (F3, P3).
- The L3 allow-list was probed for `fs/promises` writes and child inheritance only; Vite's own cache writes and the harness journal under the permission model are unmeasured, and the flags were never applied to a real `dev:server` boot.
- No Windows run: `isPathInside` (`src/core/tool-source.ts:612`) and case-alias identity (`src/tools/files/identity.ts`) were exercised on Linux only.
- `frontend` Tools/Session rendering of the new trust and grant fields (T8) is design, not observation.
