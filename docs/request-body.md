# What the built-in transport sends on the wire

One statement of the outbound contract of `openAICompatible` — the fields that
leave the process, the fields that never do, and the three places a host may add
its own. `README.md` covers the same ground from the user's side (see
[Transport](../README.md#transport)); this page is the reference a host checks a
gateway against, so it is field-exact.

The whole surface is dependency-free by rule: the body is assembled by hand, so
"what can I send" is a question about this file, not about an SDK.

## The default body

With `provider` configured and none of the extension seams used, the request body
is exactly:

```jsonc
{
    "model": "<agent model>",
    "stream": true,
    "messages": [ /* wire-mapped transcript */ ],
    "tools": [ /* only when the request declares tools */ ],
    // plus only the sampling keys that were actually set:
    "temperature": 0, "top_p": 0, "max_tokens": 0,
    "presence_penalty": 0, "frequency_penalty": 0
}
```

That shape is byte-for-byte stable: an unset `extraBody` adds no key, an unset
`sampling` field adds no key, and `tools` is absent (not `[]`) when nothing is
declared. `Content-Type: application/json`, plus `Authorization: Bearer <key>`
when a key resolves, plus any `provider.headers`.

### Never sent, unless a host asks

| Field | Why it is absent | How to get it |
|---|---|---|
| `stream_options` | Several gateways in this workspace reject unknown request fields, so a default would break working deployments to buy an optional counter. | `extraBody: { stream_options: { include_usage: true } }` |
| `response_format` | A response shape is a product decision, not a transport default. | `provider.responseFormat` (or `agent({ structured })`) |
| `seed`, `stop`, `top_k`, `parallel_tool_calls`, `tool_choice`, `max_completion_tokens` | `HarnessSampling` is a closed, typed five-field list; an untyped grab-bag would move every provider quirk into the numeric-knob type. | `extraBody` |

Usage is still **read** whenever a provider reports it, with or without the
opt-in; what the opt-in changes is that a product can *depend* on the frame
instead of getting it by luck. A request whose provider reports nothing leaves
`HarnessAssistantMessage.usage` undefined, and a server's per-turn tally is
exactly as reliable as that.

## The three seams

| Seam | Shape | Merged |
|---|---|---|
| `provider.extraBody` | `Record<string, unknown>` or `(request) => Record<string, unknown>` | FIRST — see precedence |
| `provider.responseFormat` | `'text'` \| `'json'` \| `{ jsonSchema: { name, schema, strict? } }` | after `extraBody` |
| `openAICompatible(provider, { buildBody })` | `(body, request) => Record<string, unknown>` | replaces the body |

### Precedence, in one rule

Fields the package models are authoritative; an extension may only ADD fields.

```
extraBody  →  model, stream, messages, tools, sampling, response_format  →  buildBody
(added)       (always win over the extension)                                (final say)
```

- `model`, `stream`, `messages` and the sampling numbers are written after the
  extension, so they outrank it.
- `tools` is **removed** from the extension rather than merely outranked. When the
  request declares tools the declared list wins anyway; when it declares none, a
  host-supplied `tools` would tell the provider about functions the harness has no
  implementation to route calls to.
- `stream` cannot be overridden through `extraBody` at all. It is what the SSE
  reader downstream parses, so changing it is a `buildBody` decision, not a side
  effect of spread order.
- `response_format` from `responseFormat` wins over an `extraBody` key with the same
  name: a first-class setting beats the escape hatch.

### `response_format` mapping

| Configuration | On the wire |
|---|---|
| `'text'` | `{"response_format":{"type":"text"}}` |
| `'json'` | `{"response_format":{"type":"json_object"}}` |
| `{ jsonSchema: { name, schema } }` | `{"response_format":{"type":"json_schema","json_schema":{"name":…,"schema":…}}}` |
| `…strict: true` | the same, plus `"strict":true` |

`strict` is omitted, not sent as `false`: an absent key leaves the decision with
the provider. A name must match a gateway's `[a-zA-Z0-9_-]{1,64}`
(`MAX_RESPONSE_SCHEMA_NAME_CHARS`).

`agent({ structured: schema })` is the same field plus a guarantee: the schema is
sent through this seam (unless the host set `responseFormat` itself, which wins),
and the answer is validated before it is committed. See
[Structured output](../README.md#structured-output).

## Where a rejection lands

| When | What | Code |
|---|---|---|
| Transport construction (for an agent: agent construction) | `extraBody` not a plain JSON object; an `undefined`/function/symbol-valued key; a cycle; over `MAX_EXTRA_BODY_BYTES` (8 KiB) serialized; a malformed `responseFormat`; a `buildBody` that is not a function | `provider-request-body` |
| Per request, before fetch | the `extraBody` function returns a value that fails those rules; `buildBody` returns a non-object; the body cannot be serialized | an `error` frame, and **nothing was sent** |
| Per request | any HTTP status, a provider error on a `200` stream, a malformed frame, a truncated stream | an `error` frame |

The construction-time rule is the point: a misconfigured `extraBody` is a mistake
on the line it was written, and it fails there instead of on the first prompt or
as a gateway 400.

## What the transport does not do

- It never retries. Every failure is reported, and the **agent** is the single
  retry owner (see [Retries](../README.md#retries)).
- It never executes a tool and never mutates the transcript it is handed.
- It stays browser-safe: the module imports no Node built-in, so the new seams add
  nothing to the browser chunk (pinned in
  `src/transport/openai.test.ts`, with the entry split pinned by
  `src/structure.test.ts`).
- It sends no other field of its own accord: no `n`, no `user`, no
  `response_format` when unset, no `stream_options` when unasked.
