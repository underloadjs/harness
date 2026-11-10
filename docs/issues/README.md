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

The records-store entries (0008-0011) came from a stress test of the shared store
— 7 threads across 5 agents writing the same collections concurrently. The
concurrency contract **held**: no lost updates under a same-`rev` race,
`mergeDisjoint` refused an overlapping-field merge, and every batch was atomic
(no partial write on a rejected call). Those four issues are the ergonomics and
consistency gaps that surfaced around that core, not defects in it.

The web-tool entries (0012-0016) came from a stress test of `search`, `fetch`
and `download` — 40+ calls against live providers — then re-checked reviewer by
reviewer. Several claims as first filed were **refuted** (a "mismatch" that was
gzip compressed-vs-decoded length, a `pageCharacters` figure that was correct,
a `query`-mode exclusion that would have broken correct answers); the refutations
are recorded in 0007 so the same claim is not re-filed. What survived as a gap
is below; the rest of that pass is the web-tools section of 0007.

## Index

| Issue | Area | Severity | One line |
|---|---|---|---|
| [0001](./blocking-provider-request-body-extension.md) | transport | Blocking | No extension point for outbound chat-completion request fields: `stream_options.include_usage` cannot be requested and no response format can be enforced. |
| [0002](./significant-standalone-tool-source-compilation.md) | tools / published surface | Significant | TypeScript tool-source compile/validate is only reachable through a live harness instance; the standalone kernel helper is not published. |
| [0003](./significant-tool-registry-instance-lifecycle.md) | tools / lifecycle | Significant | The tool registry and the `maxCreatedTools` budget are per-harness-instance state, so a per-conversation host re-registers and recompiles on every conversation. |
| [0004](./minor-context-window-and-token-budget.md) | context | Minor | No pre-request context-window guard and no provider overflow classification; the estimator exists but is not published. |
| [0005](./significant-server-api-chat-product-parity.md) | server API | Significant | The built-in session API cannot seed a transcript at creation, and every live preset ships the full toolbox. |
| [0006](./minor-streaming-and-adapter-ergonomics.md) | server / adapters | Minor | Two independent SSE writers, and the `{ stream }` abort wiring is documented only in the source headers. |
| [0007](./review-list-improvements-review-list.md) | cross-cutting | Review list | Everything else found during review — plus the records-store stress-test items that are doc wording or a wrong unit on one key — listed separately for the package owner to triage. |
| [0008](./significant-multi-record-mutation-names-no-ids.md) | records store | Significant | A batch that changes several records returns no `entry` and no id list, so additions and patches cannot be confirmed without a re-read — the fix removals already got (`removedIds`) was never applied to them. |
| [0009](./minor-guarded-write-refusal-omits-the-record.md) | records store | Minor | The `guarded-write` refusal says "read it first" but returns only the id, while `stale-record` on the same record returns the whole entry — so the error that needs the `rev` is the one that omits it. |
| [0010](./minor-define-plus-collection-two-paths-disagree.md) | records store | Minor | `define` beside `collection` is refused by the engine as "ambiguous" but silently consumed by the tool entry point, which registers the collection and echoes a different name. |
| [0011](./minor-change-feed-has-no-floor-watermark.md) | records store | Minor | The change feed reports that a gap was lost (`changesTruncated`) but never exposes the oldest retained revision, so a poller cannot size its lag and one refusal must guess between two causes. |
| [0012](./significant-webfetch-markdown-converter-mangles-math-and-attributes.md) | web tools | Significant | The markdown converter flattens `<sup>`/`<sub>` and math into juxtaposition — `10<sup>12</sup>` reads as `1012`, `ℏ/2` as `ℏ2` — with no `note` to disclose it, and leaks Parsoid `data-mw`/`{{cite}}` metadata into prose. |
| [0013](./minor-websearch-category-filters-reach-provider-as-opaque-400.md) | web tools | Minor | The four `category` + date/domain combinations the description already calls invalid are accepted locally and rejected remotely, so the caller gets `Exa search failed (HTTP 400)` naming no field. |
| [0014](./minor-webfetch-oversized-response-advice-names-remedies-that-cannot-work.md) | web tools | Minor | The oversized-response error offers three remedies and two cannot work in the state that triggers it: `query` runs after the size check, and `grep` skips files over the 1 MiB that caused the error — silently, `matches: []`. |
| [0015](./minor-webfetch-network-error-collapses-distinct-causes.md) | web tools | Minor | DNS failure, a refused connection and an unreachable host all collapse into one `could not be reached (network error)` sentence, so a caller cannot tell a permanent condition from a retryable one. |
| [0016](./minor-webfetch-query-mode-reports-truncated-without-nextoffset.md) | web tools | Minor | `query` mode reports `truncated: true` while carrying neither `offset` nor `nextOffset`, and one flag conflates the byte budget with the 20-section cap — two causes needing opposite responses. |
| [0017](./minor-rust-port-context-lane-drift.md) | rust port | Minor | The context bar's display lane (`ContextBlock.lane`, swagger `:8122`) plus the per-event stamp, the per-turn starting lane and the durable per-conversation `contextLane` exist only in TypeScript; `packages/typecrate/harness` has not synced them. |
| [0018](./minor-context-lane-c1-follow-ups.md) | context bar / display lane | Minor | Four C1 follow-ups: a lane bump has no route back from a worker-side harness (the feature is inert outside the default `inline` engine), the contract renderer turns an `anyOf` body with sibling `properties` into `unknown \| unknown` and never renders property prose, no test joins the shipped compaction plugin to the store recorder and the projector fold, and `.context-bar-lane` never joined the forced-colors convention. |

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
