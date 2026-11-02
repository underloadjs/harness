# 0003 — Tool registry and creation budget are per-instance, with no shared-catalogue path

> **Status:** Open
> **Severity:** Significant
> **Area:** `src/harness.ts` construction, `src/types/index.ts` (`HarnessConfiguration`, `Harness`)
> **Date opened:** 2026-11-02

## Context

A host that maps one conversation to one harness instance — the grain the
package itself uses (`README.md:1880`: "The server keeps one harness per
session") — has to construct a harness per conversation. For a chat-style host
that also maintains its own **user** tool registry (many rows, edited in a UI),
this means every conversation re-installs the same user tools.

## Gap

There is no first-class way to share a compiled tool catalogue across harness
instances, and the per-instance bookkeeping does not survive that shape:

- registration lives on the instance (`readonly tools`, `toolCreate`,
  `registerTool` — `src/types/index.ts:2132-2154`), so N conversations need N
  registrations of the same user tool;
- a tool passed in as an already-constructed `Tool` has **no source record**:
  `toolSource(name)` returns `undefined` for "registered from an
  already-constructed definition" (`src/types/index.ts:2155-2158`,
  `:1863-1866`). A host that shares compiled tools across conversations therefore
  loses the inspect/revision/source surface `toolManage` and the Tools tab are
  built on;
- `maxCreatedTools` (default 32) is a **per-instance lifetime** budget
  (`src/types/index.ts:2032-2039`), and `reset()` deliberately does not refund it
  (`:2324-2330`). Per-conversation instances make the number meaningless as a
  guard: it bounds nothing globally and silently re-arms for every new chat;
- each construction pays the descriptor scan (`docs/runtime-tools.md:57-60`,
  "no hand-written registration inventory") unless the host remembers
  `presets: false` (`src/types/index.ts:2079-2083`). That is a documented knob,
  but the per-conversation cost profile is documented nowhere.

## Why it is the way it is

By design, and stated: discovery state, todo/record stores, the tool registry and
the creation budget are **session** memory, and threads exist precisely so one
instance can hold many conversations while sharing it
(`src/types/index.ts:2240-2251`, `README.md:72-116`). Per-instance creation
budgeting is the mechanism that stops one runaway session growing the registry
without bound. `toolSource()` returning `undefined` for constructed definitions
is also explicit (`src/types/index.ts:1863-1866`).

The gap is therefore not "the design is wrong" — it is that the design supports
exactly **two** grains (one instance per session, or threads inside one
instance) and a third grain that a library consumer naturally wants (many
short-lived instances fed from one shared catalogue) is unsupported and
undocumented.

## Evidence

| Fact | Source |
|---|---|
| Registered tools, creation, and inspection are all instance members | `src/types/index.ts:2132-2160` |
| `maxCreatedTools` default 32, lifetime per instance | `src/types/index.ts:2032-2039`, `src/harness.ts:7458-7469` (`DEFAULT_CREATED_TOOLS_LIMIT`) |
| `reset()` keeps created tools and does not restore the budget | `src/types/index.ts:2324-2330` |
| Constructed definitions have no source record; source-registered ones do | `src/types/index.ts:2155-2158`, `:1863-1866` |
| Created-tool sources are part of a snapshot and are recompiled on restore | `src/types/index.ts:2210-2224`, `:1872-1877` region (`HarnessSnapshot`) |
| Preset catalogue preload is opt-out per instance | `src/types/index.ts:2079-2083` |
| Construction discovers descriptors by AST scan on Node (generated manifest on browser) | `docs/runtime-tools.md:57-60`, `src/tools/descriptors.ts` |
| The package's own app grain is one harness per session | `README.md:1880-1885`, `src/server/sessions.ts:800` (`create`) |
| Threads are the sanctioned "many conversations, one session" answer | `src/types/index.ts:2240-2251`, `README.md:72-116` |

## Proposal

**Two parts, both small; neither changes the design.**

**(A) Make "share a catalogue" a supported, documented shape.** A host should be
able to compile its user tools once (issue 0002), keep a
`Record<string, Tool>`, and pass it to every instance — `harness({ presets:
false, tools })` already accepts that — **and still keep the source/revision
surface**. That last clause is the actual code change: accept a source record
alongside a constructed definition, e.g.

```ts
tools?: Record<string, Tool | { tool: Tool; source: { moduleText: string; dependencies?: … } }>
```

or let `registerTool` take a pre-compiled `definition` plus its candidate
source. The header comment already promises exactly that — "`definition` is
accepted for host/plugin compatibility: those definitions are already
constructed and are published through the SAME registry commit path"
(`src/types/index.ts:587-592`) — but `HarnessToolRegistrationCandidate` does not
declare a `definition` field at all (`:592-602`). Closing 0003 would fix that
comment/type drift as a side effect.

**(B) State the budget contract for multi-instance hosts.** Either

- document, in `README.md` (Tool discovery / lifetime row, `:542-556`) and in the
  `maxCreatedTools` doc comment, that the budget is per instance and therefore
  **not** a global guard, and point hosts at a shared catalogue as the way to
  bound user tools; or
- add an optional host-provided counter (`creationBudget?: { remaining: () =>
  number; consume: () => void }`) so a host with a real global cap can express
  it instead of accepting per-instance semantics.

Prefer (A) + the doc half of (B); add the counter only if a second consumer needs
it.

**Alternative considered:** "use threads instead of many instances." Valid, and
the reason this is Significant rather than Blocking — but it forces the host to
adopt the server's session model (shared todos, stores, discovery, 256-thread
cap, `MAX_THREAD_RECORDS` at `src/core/thread.ts:46`) when all it wanted was
cheap reuse of compiled code.

**Alternative considered:** a process-global tool registry. Rejected: it would
break the isolation snapshot/restore relies on and make a replaced registration
leak between sessions.

## Acceptance criteria

1. A host can construct N harnesses from one shared tool catalogue, and
   `toolSource()`/`toolSources()` still report a revision and source text for
   those tools.
2. `README.md` states the per-instance cost profile of `harness()` construction
   (AST scan, `presets`, `toolFolders`, compile) and names the recommended
   per-conversation shape.
3. The `maxCreatedTools` documentation says explicitly that the budget is
   per-instance, in both the config comment (`src/types/index.ts:2032-2039`) and
   the README table row.
4. A replacement registered over a shared tool still changes `revision` and is
   visible to the next construction (no stale alias).

## Tests to add

- `src/harness.test.ts` — two instances from one catalogue: same definitions,
  each has a source record, replacing a tool in instance A does not change
  instance B.
- `src/harness.creation-policy.test.ts` / `src/harness.creation.test.ts` —
  budget behaviour under N instances, and (if the counter lands) a shared counter
  being honoured across instances.
- `src/core/tool-source.test.ts` — a constructed definition plus source yields the
  same revision as compiling the same text.

## Out of scope

- Any change to thread semantics or `MAX_THREAD_RECORDS`.
- A global registry, a plugin host, or a cross-process tool store.
- Discovery-state sharing (per-instance enabled set is correct as-is).
