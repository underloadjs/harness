# 0023 — `scope.tools` accepts names that resolve to no tool, silently starving the child

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (delegation scope), `src/tools/runtime/delegate.tool.ts` (schema)
> **Date opened:** 2026-11-11

## Context

`scope.tools` is sold as a construction guarantee: "a planning or review delegation can
therefore be read-only by construction instead of by instruction". A caller can therefore
reasonably assume that every name it lists is a tool the child will have. It is not
validated. A delegation scoped `{ tools: ["read", "wri"] }` — a typo for `write` — started
a child whose scope really was `read, wri`, where `wri` is nothing. The child reported the
oddity only because it was asked to inspect its own tools; the run finished
`status: "completed"` with a degraded answer, and the parent saw nothing wrong.

## Gap

A caller that builds a scope from a list of names needs a typo to fail at dispatch, not
to become a silently smaller toolbox. Today an unknown name costs the child a capability
and costs the parent nothing visible, so a scoping mistake is discovered by the child
volunteering it — or not at all. The same gap makes it impossible to scope to a tool that
is registered in some sessions and not others without silently losing it.

## Why it is the way it is

The scope is applied as a filter, never as a lookup. `parameters.scope.tools` is passed
straight into the child run (`src/harness.ts:4196-4201`), stored as `run.toolScope`, and
used as the membership test that refuses everything else:
`src/harness.ts:7281` (`Tool "${call.name}" is outside this run's scope. Allowed:
${run.toolScope.join(', ') || 'none'}.`). A name in the list that matches no registered
definition is simply never consulted, so nothing can notice it. The scope is deliberately
not schema-validated beyond `type: array of string` with `additionalProperties: false`
(`src/tools/runtime/delegate.tool.ts:114-127`), and the harness resolves the allowlist
against the registry only at the point of denial. The design goal — a child that "neither
sees nor can call anything outside" the list — is satisfied; the missing piece is the
other half, that everything inside it should resolve.

## Evidence

| Fact | Source |
|---|---|
| The scope is forwarded to the child run unvalidated | `src/harness.ts:4196-4201` (`...(parameters.scope?.tools === undefined ? {} : { tools: parameters.scope.tools })`) |
| It is used only as a membership test at denial time | `src/harness.ts:7281`; the discovery-side mirror at `:3352-3371` |
| The schema declares only "array of string" | `src/tools/runtime/delegate.tool.ts:114-127` |
| Runtime, 2026-11-11: `scope: { tools: ["read", "wri"] }` | the child's own report: its scope message read `Allowed: read, wri`; `toolRequest { names: ["wri"] }` → `matched: 0`, no `forbidden` entry, no error; `toolRequest { names: ["write"] }` → `forbidden` with `"allowed": ["read", "wri"]`; the delegation returned `status: "completed"` |
| An empty allowlist is handled and documented | `src/harness.delegation.test.ts:859` ("declares only the discovery door for an empty allowlist"); `src/tools/runtime/delegate.tool.ts:120-124` |
| The scope is otherwise enforced, not advisory | `src/harness.delegation.test.ts:795`, `:1055`, `:1116` |

## Proposal

Validate the list against the live registry at dispatch, before the child is started, and
refuse a name that resolves to no registered definition — naming the offending entry and
the nearest registered name, the way the `agent` allowlist refusal already names what is
allowed (`src/harness.ts:4072-4076`). Keep the empty array meaning "no tools at all",
which is documented and pinned. If a refusal is judged too strict for hosts that scope to
optionally-present tools, the minimum acceptable behaviour is to report the unresolved
names in the envelope (`scopeUnresolved: ["wri"]`) so the parent can see the child was
starved without the child having to volunteer it.

**Alternatives considered.**

- *Silently drop unknown names.* Rejected: it converts a visible typo into an invisible
  capability loss — the failure being reported here.
- *Validate against the child's declared set rather than the registry.* Rejected: a
  searchable tool the child could enable is legitimately in scope, so the registry is the
  right domain.
- *Do nothing; the child can report the limitation.* Rejected: `toolRequest` keeps the
  discovery door open for exactly that reason, but it depends on the child choosing to
  look, which is instruction-level, not construction-level.

## Acceptance criteria

1. `delegate` with a `scope.tools` entry that names no registered tool is refused before
   the child runs, and the refusal names the entry.
2. `scope: { tools: [] }` still means "no tools at all" and still leaves `toolRequest`
   available.
3. A scope of valid names is unaffected: the existing enforcement and discovery pins still
   pass byte-for-byte.
4. If unresolved names are tolerated rather than refused, every one of them appears in the
   envelope.

## Tests to add

- `src/harness.delegation.test.ts` — a scope naming an unregistered tool: assert the
  refusal happens before the child runs (no child invocation is created) and names the
  entry.
- `src/harness.delegation.test.ts` — a mixed scope (one valid, one unknown): assert the
  refusal, and that the valid name is quoted so the caller can see what was accepted.
- Extend `:859` to pin that an empty allowlist is not an unknown-name refusal.

## Out of scope

- Scoping by tag or by capability instead of by name.
- Restricting which tools a caller may *remove* (for example, whether a caller may scope
  away `toolRequest`) — the description fixes that door as never restricted.
- Nested-run policy.

## Update (2026-11-11) — independent review

- **Verdict: confirmed, severity lowered from the reporter's Medium to Minor** (this repo's
  vocabulary has no Medium; `minor-` is the right prefix for a silent ergonomics failure).
- **The exact enforcement points are now pinned.** `scope.tools` is forwarded at
  `src/harness.ts:4196-4201` and used only as a membership test —
  `isToolInScope = scope === undefined || scope.includes(name) || isScopeEscapeHatch(name)`
  (`:4447-4448`, the escape hatch being `toolRequest` alone at `:4436`) — applied to
  declarations at `:4490` and to the launch gate at `:7279-7283`. The schema declares
  `items: { type: 'string' }` and nothing else
  (`src/tools/runtime/delegate.tool.ts:100-110`, `tools` at `:105`).
- **Fix location named:** validate inside `delegateFor` immediately after the agent-allowlist
  refusal (`src/harness.ts:4072-4076`) and throw a `HarnessError` naming the unknown entries,
  copying that refusal's shape, so the failure lands before dispatch.
- **Widened by the review:** the match is exact and case-sensitive with no normalisation, so
  `["Read"]` or `[" read"]` starves the child exactly like the `"wri"` typo, with the same
  silent success. A validate-and-refuse fix should trim, reject duplicates, and refuse a name
  that still does not resolve after trimming — otherwise the fix covers typos and misses the
  more likely formatting slip.
- **Test gap confirmed:** no test passes an unknown, mis-cased, or duplicate name in
  `scope.tools`.
