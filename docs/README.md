# `docs/`

The documents that live beside `README.md` and `knowledge.md` but are not
either of them: one authoring guide, one integration reference, and two logs
with their own rules. `README.md` explains how to use the package, and
`knowledge.md` is the internal map of what it is; everything below is for a
narrower reader with a narrower job.

| Document | Reader | One line |
|---|---|---|
| [plugins.md](./plugins.md) | a plugin author | The authoring guide for the plugin surface: subscription semantics (wildcard `'*'`, `priority`, `timeoutMs`, the synchronous fast path), the `turn.before` merge/precedence rules and what each `HarnessTurnDecision` does to a run, the `context.edit`/`setIncluded` role rules, `api.snapshot()` / `settings.setOwn` / `report.diagnostic`, `host.state_change`, teardown via `harness.dispose`, and the stated prohibitions. |
| [runtime-tools.md](./runtime-tools.md) | a runtime-tools integrator | The self-modifying tool runtime: entries compiled from the editable `src/` sources shipped beside `dist/`, activation, rollback. Integration documentation — it asserts no passing production verification run on its own. |
| [request-body.md](./request-body.md) | a host wiring its own provider | The outbound contract of the built-in transport: the exact default body, the fields deliberately **not** sent (`stream_options`, `response_format`, `seed`/`stop`/`tool_choice`/…), the three request-body seams and their precedence, the byte caps, and which rejection lands at construction versus as an `error` frame. |
| [issues/](./issues/README.md) | the package owner | The **issue log**: verified gaps between what a consumer needs and what the published surface provides, one file per issue, with the evidence to re-check each claim and rules for how an entry may shrink. |
| [tasks/](./tasks/README.md) | an implementing agent | The **task log**: actionable work items found while exercising the package from inside live sessions — each entry names the change, the file it touches, and the check that closes it, and a landed entry keeps its corrected findings auditable. |

The two logs split along one line: an **issue** describes behaviour the
package implements on purpose and records what that leaves a consumer unable
to reach; a **task** is a to-do list with closing checks. Something promoted
out of exploration usually lands in `tasks/` first; what survives as a design
gap moves to `issues/`.
