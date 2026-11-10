# 0001 — No extension point for outbound request fields (`stream_options`, response format)

> **Status:** Open
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
