# Issue log

Open gaps and improvement requests against `@underload/harness`. Each file is one
issue: a verified gap between what a consumer needs and what the published
surface provides, with the evidence needed to re-check it.

These are **not** bug reports about behaviour that contradicts the docs. Every
entry below describes behaviour the package implements on purpose; the issue is
that the documented design leaves a consumer unable to reach a capability the
package's own model already implies. Where the omission is deliberate (a
security rule, a dependency rule, a gateway-compatibility rule) that is stated in
**Why it is the way it is**, and the proposal works inside the rule instead
of against it.

## Index

| Issue | Area | Severity | One line |
|---|---|---|---|
| [0001](./0001-provider-request-body-extension.md) | transport | Blocking | No extension point for outbound chat-completion request fields: `stream_options.include_usage` cannot be requested and no response format can be enforced. |
| [0002](./0002-standalone-tool-source-compilation.md) | tools / published surface | Significant | TypeScript tool-source compile/validate is only reachable through a live harness instance; the standalone kernel helper is not published. |
| [0003](./0003-tool-registry-instance-lifecycle.md) | tools / lifecycle | Significant | The tool registry and the `maxCreatedTools` budget are per-harness-instance state, so a per-conversation host re-registers and recompiles on every conversation. |
| [0004](./0004-context-window-and-token-budget.md) | context | Minor | No pre-request context-window guard and no provider overflow classification; the estimator exists but is not published. |
| [0005](./0005-server-api-chat-product-parity.md) | server API | Significant | The built-in session API cannot seed a transcript at creation, and every live preset ships the full toolbox. |
| [0006](./0006-streaming-and-adapter-ergonomics.md) | server / adapters | Minor | Two independent SSE writers, and the `{ stream }` abort wiring is documented only in the source headers. |
| [0007](./0007-improvements-review-list.md) | cross-cutting | Review list | Everything else found during review, listed separately for the package owner to triage. |

## Format

Every issue file uses the same sections, in this order, so an owner can compare
entries and decide without re-reading the source:

1. **Status / Severity / Area / Date opened.**
2. **Context** — who hit it and what they were building. One paragraph.
3. **Gap** — what the consumer needs, stated as a capability, not as a fix.
4. **Why it is the way it is** — the existing design rule, with the source
   reference that proves it is intentional. If this section is empty the issue
   is an oversight, not a trade-off.
5. **Evidence** — `path:line` facts only. A reader must be able to re-check
   every claim in minutes.
6. **Proposal** — the smallest change that closes the gap, plus alternatives
   considered and why they were rejected.
7. **Acceptance criteria** — observable conditions that close the issue.
8. **Tests to add** — the named test files that must cover it.
9. **Out of scope** — what this issue must not grow into.

Severity vocabulary: **Blocking** (a consumer cannot ship the feature at all
without forking the package), **Significant** (shippable only with meaningful
duplicated code), **Minor** (ergonomics or drift risk), **Review list**
(no single fix, decisions to make).

Rules of the log: an issue is never edited to hide a regression — a correction
goes in a `## Update` section with its own date; **when part of an issue is
closed, that part is deleted outright — from the title, from **Gap**, from the
**Evidence** table, from **Proposal**, from **Acceptance criteria** and from
**Tests to add** — and the header records the reduction with its date. A closed
item is not kept as a footnote or a changelog entry: the log holds only live
gaps, and the history of what was removed is git's, not the file's**; when a
whole issue closes, the file is deleted and its index row dropped, and any
surviving note moves into a sibling issue or into 0007; a claim without a source
reference is marked `unconfirmed`.
