# 0001 — No extension point for outbound request fields (`stream_options`, response format)

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
> **Severity:** Blocking
> **Area:** `src/transport/openai.ts`, `src/types/index.ts` (transport/provider configuration)
> **Date opened:** 2026-11-02

## Context

`distribution/chat-assistant` is being re-platformed onto the harness building
kit: its own `@underload/service` endpoint will call `agent()` / `harness()`
instead of proxying an OpenAI-compatible relay from the browser. Its current
browser client sends
`{ model, stream: true, stream_options: { include_usage: true }, messages }`
and depends on the trailing usage frame for the per-conversation token totals
(`distribution/chat-assistant/src/api/provider.ts:146-150`). Through the harness
transport that opt-in cannot be expressed at all, so the same UI feature
regresses to "no usage reported".

The same conversation surfaced a second, larger product need: a **response
format setting**. Forcing a specific output shape (JSON object, or a named JSON
Schema) is genuinely useful for a downstream product — it is what turns a chat
turn into a machine-readable result the caller can parse without heuristics —
and there is currently no way to ask for it.

## Gap

A consumer of the package cannot influence **any** field of the outbound chat
completion body beyond the five sampling knobs. Concretely, it cannot:

- request streamed usage (`stream_options.include_usage`) — the field the whole
  token-accounting surface depends on when the gateway does not send usage
  unprompted;
- require a response format (`response_format: { type: 'json_object' }`, or a
  `json_schema` with `strict`), i.e. **make the model return a defined shape**;
- set `seed`, `stop`, `top_k`, `parallel_tool_calls`, `tool_choice`,
  `max_completion_tokens`, or any provider-specific field;
- do any of this without supplying a complete replacement transport, because the
  built-in transport's request-building and SSE-parsing internals are private.

The last point is what makes this blocking rather than merely annoying: writing
a custom `HarnessStream` is the documented escape hatch, and it costs a full
fork of a 929-line file, because nothing of the default transport is reusable.

## Why it is the way it is

Deliberate, and documented:

- `src/transport/openai.ts:16-20` — "`stream_options` is deliberately NOT sent —
  several gateways this workspace talks to reject unknown request fields. Usage
  is captured when a provider reports it anyway."
- Zero-runtime-dependency rule (`README.md:12-14`, `openai.ts:8-14`): the
  transport is hand-written, so there is no SDK request object to widen.
- `HarnessSampling` is a fixed OpenAI field list (`src/types/index.ts:447-453`),
  which keeps sampling typed instead of an opaque bag.

Every proposal below keeps those rules: a caller-supplied body is still
dependency-free, still opt-in per agent, and cannot silently change what a
gateway that rejects unknown fields receives.

## Evidence

| Fact | Source |
|---|---|
| The outbound body is exactly `{ model, stream, messages, tools?, ...sampling }` | `src/transport/openai.ts:829-835` |
| The omission is documented in the source header | `src/transport/openai.ts:16-20` |
| …and in one README line, with no alternative offered | `README.md:1938` ("`stream_options` is not sent — several gateways reject unknown request fields") |
| Sampling is a closed set of five fields | `src/types/index.ts:447-453` |
| Provider configuration accepts `baseURL`, `apiKey`, `headers`, `sampling` — nothing else | `src/types/index.ts:457-467` |
| `HarnessStreamRequest` carries `model`, `messages`, `tools?`, `signal` only | `src/types/index.ts:409-417` |
| A custom transport is `(request) => AsyncIterable<HarnessStreamEvent>` and wins over `provider` | `src/types/index.ts:443`, `:455-456`, `src/core/agent.ts:148-159` |
| `openAICompatible` is the only **chat-completion** export of the transport module (the module also exports the `PreparedToolMedia` type and the `groupToolMedia` helper for attachment grouping — neither is a request-body seam); `wireMessage`, `wireTool`, `samplingBody` are module-private | `src/transport/openai.ts:295` (`wireMessage`), `:592` (`wireTool`), `:672` (`samplingBody`), `:789` (`openAICompatible`); the two non-body exports are `:416` (`PreparedToolMedia`), `:483` (`groupToolMedia`) |
| `usage` on the committed answer is optional by contract | `src/types/index.ts:318-319` |
| Server-side turn tallies are summed from per-request `usage` events, so an absent frame is an absent tally | `src/server/protocol.ts:208-213`, `README.md:2717-2719` |
| Consumer depends on `stream_options.include_usage` | `distribution/chat-assistant/src/api/provider.ts:142-149` |
| Schema validation the package already exports and could reuse for structured output | `src/harness.ts:12021-12034` (`validateSchemaValue` :12028, `checkToolSchemaComplexity` :12029, `MAX_CREATED_SCHEMA_*` `:12030-12032`) |

`unconfirmed`: whether the LAN relay used by this workspace already emits a
usage frame without the opt-in. The package contract still makes the answer
unreliable — "provider reports it anyway" is not a guarantee a product can
budget against.

## Proposal

**Adopt (A) and (C) now; treat (B) as the follow-up that consumes (A).**

**(A) `provider.extraBody`** — one additive field on
`HarnessProviderConfiguration`:

```ts
extraBody?: Record<string, unknown>
  | ((request: HarnessStreamRequest) => Record<string, unknown>);
```

Rules that must hold, so this does not become a foot-gun:

- merged **first**, so `model`, `messages`, `tools` and the sampling fields
  always win — an extra body can add fields, never hijack the request shape;
  if an override of `stream` is ever wanted, it must be an explicit second
  option, not a side effect of spread order;
- a plain-object value is shallow-merged per request; the function form is
  called once per request, after the model/messages/tools are resolved, so a
  host can key `stream_options` off `request.signal`/`request.tools`;
- bounded like the other caps (`MAX_BASE_URL_LENGTH`, `MAX_MODEL_LENGTH`):
  serialize and reject over a stated byte cap with a `SettingsError`-style
  typed error rather than sending a body the gateway will 400 on;
- validated as a JSON-serializable plain object (reject functions, circular
  references, `undefined`-valued keys) at **transport construction**, not at
  first prompt — the same fail-early rule `resolveStream` uses
  (`src/core/agent.ts:147-159`).

**(C) Make the default transport composable.** Either export the internals
(`wireMessage`, `wireTool`, the SSE reader, the tool-call accumulator), or —
preferred, smaller public surface — accept an options argument:

```ts
openAICompatible(configuration, { buildBody?: (base, request) => Record<string, unknown> })
```

so a host that needs a non-OpenAI dialect can reuse message mapping, attachment
parts, aborting, error scrubbing and chunk parsing. Today every one of those is
private and must be duplicated.

**(B) A first-class response-format setting**, built on (A):

```ts
provider: {
  baseURL,
  responseFormat?:
    | 'text'
    | 'json'
    | { jsonSchema: { name: string; schema: Record<string, unknown>; strict?: boolean } },
}
```

and, at the agent layer, `agent({ structured: schema })` meaning "send the
schema AND hand me a validated value". The parts that already exist should be
reused rather than rewritten:

- the outbound field goes through (A);
- the reply is validated with the exported `validateSchemaValue`, and the schema
  itself with `checkToolSchemaComplexity` / `MAX_CREATED_SCHEMA_*`
  (`src/harness.ts:12021-12034`) — the same gates a created tool's schema passes;
- an invalid answer must be an explicit, typed failure (or one schema-repair
  retry inside the existing retry budget, `src/types/index.ts:386-405`) — never
  a silent `{}`;
- `stopReason: 'length'` stays distinguishable from a schema failure, because a
  truncated answer is a different problem (`src/types/index.ts:317`, `:324`).

**Alternatives considered.**

- *"Write your own transport."* Correct and available, but it means copying the
  whole file per host (see (C)) and it forfeits the shared attachment/video/
  error-scrub behaviour. This is the workaround, not the answer.
- *Widen `HarnessSampling` to a free-form record.* Rejected: sampling stays
  typed, and an untyped grab-bag would move every provider quirk into the type
  that is about numeric knobs.
- *Opt into usage automatically (`stream_options` always sent).* Rejected for
  the reason already in the file header: gateways in this workspace reject
  unknown fields, so a default would break working deployments to fix an
  optional counter.

## Acceptance criteria

1. A host can make a streamed request report usage **without** writing a custom
   transport, and the resulting `usage` reaches
   `HarnessAssistantMessage.usage` and the harness `usage` events unchanged.
2. A host can require `json_object` / `json_schema` output through configuration,
   and the field actually appears in the outbound body (asserted on a fetch
   stub, not inferred).
3. `extraBody` cannot change `model`, `messages` or `tools`, and a rejected
   value fails at construction with a message naming the field.
4. A documented, exported way to reuse the default transport while overriding
   only the body (or its primitives) exists, and the package's own browser/node
   import split is unchanged (no new Node built-in reaches the browser chunk —
   `README.md:278-288`, `README.md:305-312`).
5. `README.md:1938` (the "`stream_options` is not sent" line) and the transport
   section point at the new setting, and `docs/` states what is and is not sent
   on the wire.

## Tests to add

- `src/transport/openai.test.ts` — body assertions: default unchanged
  byte-for-byte; `extraBody` object form; `extraBody` function form receives the
  resolved request; precedence (a supplied `model`/`messages` in `extraBody` does
  not win); oversize rejection; `responseFormat` → `response_format` mapping for
  all three shapes.
- `src/core/agent.test.ts` — a `structured` schema answer round-trip, an invalid
  answer (typed failure, no commit to history), and interaction with the retry
  sequence (a schema failure is not a transport retry unless policy says so).
- `scripts/check-package-types.mjs` consumer fixtures — the new fields type-check
  for both the NodeNext and the `customConditions: ["browser"]` consumer.

## Out of scope

- Non-OpenAI wire protocols (Anthropic, Gemini, embeddings) — this issue is only
  about making the existing transport composable.
- Server/UI changes to how usage is displayed or aggregated.
- Structured-output **storage** (a session-level result schema) — belongs with
  0005 if it belongs anywhere.
- Sandboxing or cost/latency policy.

## Update (2026-11-11)

- **Anchors re-grounded** against the current tree; the code is unchanged, and no
  claim was added or removed. The gap is intact: the body is still
  `{ model, stream, messages, tools?, ...sampling }`
  (`src/transport/openai.ts:829-835`), `stream_options` is still deliberately
  absent (`src/transport/openai.ts:16-20`, `README.md:1938`), and
  `HarnessProviderConfiguration` still accepts only `baseURL`/`apiKey`/`headers`/
  `sampling` (`src/types/index.ts:457-467`).
- **Factual correction:** the transport file is **929 lines**, not 877 — the cost
  of the "write your own transport" workaround is larger than first stated.
- **Factual correction:** `openAICompatible` is no longer literally the module's
  **only** export. It is still the only **chat-completion** export; the module
  also exports `PreparedToolMedia` (a type, `src/transport/openai.ts:416`) and
  `groupToolMedia` (`:483`), both for the attachment-grouping limits. Neither is
  a request-body seam, so the substance stands: `wireMessage` (`:295`),
  `wireTool` (`:592`) and `samplingBody` (`:672`) remain module-private.
- Status stays **Open**; the `unconfirmed` note about whether the LAN relay
  already emits a usage frame is unchanged.

## Update (2026-11-11) — closed

All three parts of the proposal are implemented, (A) and (C) first and (B) on top
of them, so the header's **Open** (set by the re-anchor section above, which
changed no code) is superseded by this one. **Gap**, **Evidence**, **Proposal**,
**Acceptance criteria** and **Tests to add** are left as filed — this issue was
closed whole, not in part, so nothing is deleted from them; the section below
records what shipped and what the implementation settled that the proposal left
open.

**What shipped**

- **(A) `provider.extraBody`** — `HarnessExtraBody`
  (`src/types/index.ts:485`), object or function form, on
  `HarnessProviderConfiguration` (`:562`). Merged **first**, so `model`,
  `stream`, `messages`, `tools` and the sampling fields always win
  (`transportBody`, `src/transport/openai.ts:999-1030`). The source header's
  "`stream_options` is NOT sent" note now reads "NOT sent **by default**" and
  points at the seam (`src/transport/openai.ts:16-22`).
- **(B) `provider.responseFormat`** — `'text' | 'json' | { jsonSchema }`
  (`HarnessResponseFormat`, `src/types/index.ts:514`; provider field `:567`),
  mapped onto `response_format` by `responseFormatField`
  (`src/transport/openai.ts:915`). At the agent layer,
  `agent({ structured })` (`src/types/index.ts:615`) both sends the schema —
  injected into the built-in transport as `provider.responseFormat`
  (`src/core/agent.ts:289-297`) — and hands back the validated value as
  `HarnessAssistantMessage.structured` (`:327`).
- **(C) composable transport** — `openAICompatible(config, { buildBody })`
  (`src/transport/openai.ts:1048`, `HarnessTransportOptions`
  `src/types/index.ts:537-542`), so a non-OpenAI dialect reuses message mapping,
  attachment parts, aborting, error scrubbing and chunk parsing instead of
  forking the file.

**Decisions the proposal left open, and what the implementation chose**

- **`extraBody.tools` is removed, not merely outranked.** Spread order already
  makes a declared tool list win, but when the request declares **no** tools the
  spread would leave the host's list standing — and a provider told about a tool
  the harness never registered produces calls whose results cannot be paired back
  to an implementation. So `tools` is dropped from the extension outright
  (`src/transport/openai.ts:1008-1020`, inside `transportBody`).
- **`stream` is not overridable** through `extraBody` either: the transport is a
  streaming transport, and the issue asked for an explicit option, not a spread
  side effect, if an override is ever wanted.
- **Cap and error type.** `MAX_EXTRA_BODY_BYTES = 8 * 1024`
  (`src/transport/openai.ts:817`) measured on the **serialized** value (a `>`
  test, so exactly 8 KiB passes), with `MAX_RESPONSE_SCHEMA_NAME_CHARS = 64`
  (`:823`) and an OpenAI-gateway `[a-zA-Z0-9_-]` name pattern (`:945`) for
  `jsonSchema.name`. The proposal suggested a "`SettingsError`-style" error; the
  package's own `HarnessError` with code `provider-request-body`
  (`PROVIDER_REQUEST_BODY_CODE`, `:831`) is used instead — importing the
  settings engine's error class into the transport would invert the layering.
  Messages name the offending field (`extraBody`, `provider.responseFormat`,
  `options.buildBody`).
- **Validation timing** follows the fail-early rule exactly as filed: object
  forms are validated at **transport construction**, the function form per
  request, and a rejected per-request value becomes an `error` frame **before**
  any fetch.
- **Structured answers spend no repair retry.** The proposal allowed "or one
  schema-repair retry inside the existing retry budget"; the shipped gate runs
  **after** the transport retry loop and **before** `precommit`, so a schema
  failure is neither retried nor committed (`src/core/agent.ts:1022-1056`).
  `stopReason: 'length'` and `'tool_calls'` are not judged, keeping truncation
  distinguishable from a schema miss. Codes: `structured-schema-invalid`,
  `structured-output-invalid` (`src/core/agent.ts:169-170`). The reply is parsed
  strictly — a non-JSON body fails, no code-fence sniffing.
- **Custom `{ stream }` + `structured`** is validation-only: a host transport owns
  its wire format, so nothing is injected, while the answer is still gated
  (`src/core/agent.ts:270-284`). An explicit `provider.responseFormat` always
  wins on the wire over what `structured` injects.
- **Scope kept:** `harness()`/the server preset do not expose `structured` yet —
  the issue scoped storage/session-level schemas out, and this is agent-level
  only. Forks and threads inherit `structured` (`src/core/agent.ts:1185`, `:1296`).

**Evidence against each acceptance criterion**

1. Usage without a custom transport, reaching the committed message:
   `src/transport/openai.test.ts:1102` (transport yields the `usage` event from
   the `stream_options` frame it bought) and `src/core/agent.test.ts:671`
   (the same usage lands on the committed `HarnessAssistantMessage.usage`).
2. Response format on the wire, asserted on a fetch stub:
   `src/transport/openai.test.ts:1340` (`text`), `:1348` (`json_object`),
   `:1356` (`json_schema` with `strict`), `:1377` (`strict` omitted when unset),
   `:1397` (first-class field beats an `extraBody` key of the same name);
   `src/core/agent.test.ts:701` (the agent's schema reaches `response_format`)
   and `:726` (an explicit `provider.responseFormat` survives on the wire while
   `structured` still gates the reply).
3. `extraBody` cannot change the request shape, and a rejected value fails at
   construction naming the field: `src/transport/openai.test.ts:1180`
   (`model`/`messages`/`tools`/`stream`/sampling all win), `:1243` (the 8 KiB cap,
   field named), `:1269` and `:1299` (every non-plain-object and every
   JSON-drops-it key rejected at construction), `:1319` (function-form rejection
   is an `error` frame with no fetch).
4. Documented body-override seam with the import split intact:
   `src/transport/openai.test.ts:1454`/`:1491` (`buildBody` rewrites the body and
   is handed the assembled base body plus the resolved request), `:1531`/`:1547`
   (a non-object result and a non-function option), `:1557` (the transport module
   imports no Node built-in, so nothing new reaches the browser chunk).
5. Docs: `README.md:1980-2010` ("What is on the wire" — the seam table, the
   precedence rule, the cap), `README.md:459-490` (`#### Structured output` under
   `agent()`, the section runs to the next `####` at `:807`), `docs/request-body.md`
   (new, the full wire contract), and the `knowledge.md`
   transport/agent/type sections.

**Tests** — `src/transport/openai.test.ts` 58/58 (19 new, `describe` at `:1081`)
and `src/core/agent.test.ts` 34/34 (12 new, `describe` at `:645`); scoped
regressions green: `src/structure.test.ts` 21/21, an 8-file core batch 213/213,
and a 10-file batch covering `harness.retry/races/fork`,
`agent.retry/fork/attachments`, `harness.test.ts`, `schema-validation`,
`harness.background` and `server/background` at 173/173. `tsc --noEmit` over the
package exits 0. `scripts/check-package-types.mjs` gained the consumer fixtures
this issue asked for (both consumers configure the new fields; the NodeNext
consumer compiles).

**One packaging finding, not closed here:** the published **browser** consumer
check (`yarn test:package` → `scripts/check-package-types.mjs`) fails — but it
fails identically with HEAD's fixture (verified by compiling HEAD's browser entry
verbatim against this tree's `dist`: the same `dist/server/**` `node:http` /
`NodeJS` / `Buffer` errors), and **both** fixtures — HEAD's entry and the one with
this issue's additions — compile clean (exit 0) once `types: ["node"]` is added to
the browser fixture's tsconfig. Cause: `dist/browser.d.ts` re-exports
`./harness.js`, whose published declarations reference the server surface, and the
browser fixture omits `types: ["node"]` while the script's own comment at
`scripts/check-package-types.mjs:347-349` states the server declarations require
it; the `@ts-expect-error` on the server import does not suppress those unrelated
declaration errors, so the run exits 1. Issue 0001 adds no Node reference to the
browser declarations (`dist/browser.d.ts` and `dist/harness.d.ts` contain no
`node:`/`NodeJS` reference); the one-line fixture tsconfig change sits in a file
this issue owns only for its fixture lines, so it is left for the owner alongside
the alternative — stop `browser.d.ts` from pulling in the server surface.

**Drift against the cites above** — the **body** cite in **Evidence** is now
historical: the assembled body is built by `transportBody` at
`src/transport/openai.ts:999-1030` and serialized at `:1174-1180`, not
`:829-835`, because this fix grew the file from **929** lines to **1292**. The
header-note cite `:16-20` still lands on the (reworded) `stream_options` note.
`README.md:1938` was the "`stream_options` is not sent" line; it is now
`README.md:1984` inside the new subsection. Every `src/types/index.ts` cite moved
**down by 8 lines** (a usage field was added to the `done` stream event above
them, which is what AC1's "usage reaches the committed message unchanged"
depends on): sampling `:447-453` → `:455-461`, `HarnessStream` `:443` → `:451`,
`HarnessStreamRequest` `:409-417` → `:417-425`, provider configuration
`:457-467` → `:547-569` (a documentation block for the new fields also sits
above the type), and the "`{ stream }` wins over `provider`" cites `:455-456` →
`:583-590`. The validator cites (`src/harness.ts:12021-12034`) and
`src/core/agent.ts:147-159` (`resolveStream`, now `:270`) are the two other
affected spots: `resolveStream` moved because the structured codes and helpers
were inserted above it.

- Status is **Fixed**. The log's rule for a closed issue is to delete the file and
  drop the index row; the file is kept, with the row marked, so the fix can be
  reviewed against its issue in the same pass — the owner's integrated run decides,
  and deletion is then a one-command step.
