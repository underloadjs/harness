// delegate — standalone source entry for one-level bounded delegation.
//
// The allowlist schema is per-harness, so the kernel registration supplies the
// exact description/schema while this entry owns the execution contract. The
// runtime operation enforces caller role/depth and invokes the invocation-bound
// `context.run`, never a captured child implementation.
//
// Metadata is a pure literal (T19 / R9)
// -------------------------------------
// `metadata` below is a literal object with no computation, no interpolation and
// no call. That is what lets the startup metadata reader
// (../../core/tool-scan.ts) extract it from the file's TypeScript AST without
// evaluating the module. The dynamic, allowlist-aware form lives in
// `agentDelegateMetadata(subagents)`, which the harness calls at registration time
// to override description/schema; its zero-allowlist branch is derived FROM the
// literal, so the two cannot drift (pinned by core/metadata.ownership.test.ts).
//
// The two new literals are annotated `as const` rather than with the
// ToolMetadata/ToolRegistration types: a runtime entry must keep
// `dependencies: []` (scripts/check-package-tools.mjs), and only the `core` /
// `tools/catalogue` specifiers resolve LIVE — a leaf type import would be captured
// as a local dependency. The shape is enforced at read time by
// core/tool-scan.ts.
//
// T28 RESULT CONTRACT (why the description is long)
// -------------------------------------------------
// The result is no longer `{ agent, content }`. It carries the SAME identity
// agentManage/agentResult report (`invocationId`, `threadId`, `status`,
// `durationMs`), pages `content` with `maxChars`/`truncated`/`nextOffset`, and
// returns a cancelled/failed child as a STRUCTURED result with `partialContent`
// and `cancelledAtMessage` instead of an empty record. The model reads the
// description, not this file, so the description states all three facts: a caller
// that assumes the old two-field shape would silently drop the identity and the
// continuation offset.
//
// DURABILITY OF THE PARTIAL (issue 0033, 2026-11-14): `partialContent` and
// `cancelledAtMessage` are not only fields of THIS envelope. They are written onto the
// child's terminal RECORD, which the snapshot projection carries (`src/types/index.ts`
// `HarnessAgentResultSnapshot`) and a server persists verbatim in its `core`, so the same
// partial is still readable by `invocationId` after a save/restart/reload. Before that,
// an unfinished child's answer lived only in the running process: the caller had been
// shown it, and the durable ledger answered the same id with an empty `content`.
//
// B2 (2026-11-13, corrected in the same review wave): the identity is OBSERVED, never
// invented, so it is CONDITIONAL. `src/harness.ts:4353-4363` omits `invocationId`,
// `threadId` and `status` when the child's ledger record cannot be resolved — its
// record was purged with its thread (a `threadDelete`/cascade mid-run) or the bounded
// result ledger evicted it. The description used to list all four keys
// unconditionally, which promised an address a caller could not address; it now names
// the condition instead. The allowlist wording is duplicated verbatim in
// `core/metadata.ts`, so BOTH copies change together (core/metadata.ownership.test.ts
// compares the two projections).
//
// C4 (2026-11-14, independent review) — FOUR COPIES, TWO BYTE CHAINS. The `callCancelled`
// clause added to BOTH description forms (abandoning a live child with `toolCancel` still
// delivers the child's terminal envelope, and the `toolCancel` result stays an
// acknowledgement) travels down two chains that must each stay byte-identical:
//   - the ZERO-SUBAGENT literal -> regenerated into `core/tool-manifest.ts` by
//     `yarn tools:manifest` (pinned byte-identically by core/tool-discovery.test.ts) ->
//     hand-mirrored into the Rust row packages/typecrate/harness/src/tools/catalogue.rs;
//   - the ALLOWLIST template here -> hand-duplicated in `core/metadata.ts`
//     (pinned by core/metadata.ownership.test.ts).
// The clause therefore carries NO backticks: it also lives inside two template literals,
// where a backtick would need escaping, and one canonical sentence is easier to keep equal
// across four copies than two spellings of it.
//
// Beware the AST scanner when editing the literal: it must stay a plain literal, and a
// single-quoted string cannot contain an unescaped apostrophe.
//
// TIME POLICY (2026-11-09, docs/tasks/2026-11-09-thread-timeout-policy.md)
// ------------------------------------------------------------------------
// `timeoutMs` used to default to 300000 (5 minutes). The DEFAULT is now "no time
// limit" and `timeoutMs` is an optional, caller-set bound; the property description
// below says so, in the order the policy doc requires (unbounded default → optional
// bound → the structured `cancelled` envelope on expiry → `toolCancel` as the
// recovery for a stuck child → the child's TOOLS keep their own clocks).
// Two constraints keep that text exactly where it is:
//   - it must stay a plain literal holding number LITERALS, because the startup
//     scanner reads this object out of the AST and scripts/check-package-tools.mjs
//     requires `dependencies: []` for this entry — so it cannot import
//     `DELEGATE_TIMEOUT_MS` from ../core;
//   - src/core/metadata.ownership.test.ts pins the inlined ceiling against the
//     canonical constants, which is the fix for that duplication.
// The schema `maximum` bounds a MODEL argument only; `runtime.delegate` (the host
// path) is not schema-validated and may pass any finite bound.
//
// TURNS POLICY (2026-11-13, finding C1 + the `maxTurns` addition)
// ---------------------------------------------------------------
// `maxTurns` is a second OPTIONAL, caller-set bound next to `timeoutMs`: a count of
// MODEL REQUESTS instead of a wall clock. It is deliberately not a "tool rounds"
// count (stress report #7, 2026-11-14): the gate is `run.iteration >= turnLimit`
// checked BEFORE the increment — see the `turnLimit` computation in `runAgentCore`
// (src/harness.ts), referenced by symbol because the line number drifts — so
// `maxTurns: N` permits exactly N model requests and the child's ANSWER must be one
// of them; N allows at most N-1 tool rounds. Omitting it is the default and
// means "the harness-wide limit" (`maxIterations`, itself unarmed unless a host
// names one), so this argument can only LOWER what one child may do. Its ceiling
// equals `DELEGATE_MAX_TURNS_MAX` in core/agent-limits.ts, restated here as the
// literal `64` for the same zero-captured-dependency reason as the timeout ceiling
// (which equals `MODEL_TIMEOUT_MAX_MS`), and the pin step asserts the equality.
//
// The other half of C1 is pure prose: the envelope has always carried `threadId`,
// and it is the HANDLE for follow-up work (threadSend / threadRead on the child
// conversation, threadDelete to release it). Nothing in the schema says so, so both
// description forms below do — a model only ever reads the description.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const AGENT_DELEGATE_NAME = 'delegate';

// The canonical, AST-extractable declaration. Deliberately literal (see header).
// This is the ZERO-SUBAGENT catalogue form: a host that lists the capability
// before any session exists sees this description and a free-form agent name.
//
// T28: the literal carries the FULL argument surface (every property except the
// allowlist enum). The allowlist form below is derived from it, so a new delegate
// argument is declared ONCE and both forms — the catalogue row and the live
// declaration — advertise it. The previous split (a two-property literal plus a
// hand-retyped allowlist schema) meant every added argument had to be written twice
// and the catalogue silently advertised a smaller surface than the runtime.
export const metadata = {
    name: AGENT_DELEGATE_NAME,
    description:
        'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404. EACH delegation starts a NEW conversation with that subagent: the child sees neither this conversation nor an earlier child\'s - unless the call comes from the host rather than one of your conversations, and then the child re-enters that subagent\'s default conversation (`agent:<name>`), where it may remember what it answered for you before - so the brief must carry everything it needs. The envelope names two HANDLES: `threadId` is the conversation the child ran in, so a follow-up goes through threadSend (another message into it) or threadRead (its transcript), and `invocationId` is what agentResult pages by; a finished child stays addressable until it is released with threadDelete. `maxChars` pages the answer (default 8000) - when the page is truncated, continue with agentResult by that `invocationId` and pass `limit`, whose own default is 4000, to keep your page size. `timeoutMs` optionally bounds the child\'s wall clock (omit it for no limit), and `maxTurns` optionally caps how many model REQUESTS the child may make at 1-64 (its answer must be one of them, so N allows at most N-1 tool rounds; omit it for the harness-wide limit). A child that did not finish keeps its error plus the last assistant TEXT it committed as `partialContent` - its tool calls and tool results are rolled back and not retained - and `cancelledAtMessage`, which counts committed messages rather than measuring progress. Abandoning a live child with toolCancel does not discard its outcome: the tool message of that call carries the same envelope, built from the child\'s terminal record - status, any partialContent/cancelledAtMessage - plus callCancelled: true, which marks that you released the call while the child\'s result stayed readable. The toolCancel result itself is an acknowledgement, not the delegation\'s answer.',
    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            agent: {
                type: 'string',
                description: 'Subagent name, one of the session harness allowlist.'
            },
            input: { type: 'string', description: 'The full brief the subagent should act on.' },
            maxChars: {
                type: 'integer',
                minimum: 1,
                maximum: 8000,
                description:
                    'Page size in characters for the returned answer, 1-8000. Defaults to 8000; a longer answer reports truncated and nextOffset.'
            },
            requireClarification: {
                type: 'boolean',
                description:
                    'When true, refuse the delegation BEFORE the child runs if the brief names no concrete target (file, symbol, URL, or id) or no acceptance criterion. Use it for a write-capable subagent so an under-specified brief cannot spend a run mutating the workspace.'
            },
            timeoutMs: {
                type: 'integer',
                minimum: 1,
                maximum: 3600000,
                description:
                    'Optional wall-clock bound for the child run, in integer milliseconds (1-3600000). OMIT IT FOR NO TIME LIMIT, which is the default: the child runs until it gives its own final answer, and nothing external ends it on a clock. Set a value only when you believe a limit is warranted; the 1-3600000 range bounds what you may ask for, never the absence of a bound. On expiry the child is stopped and the result reports status "cancelled" with its partialContent and cancelledAtMessage, exactly as for any other unfinished child. A child that is still running is abandoned with toolCancel using the callId from its pending placeholder. The tools the child calls carry their own time bounds, which is what keeps an unbounded child from hanging on I/O.'
            },
            // A COUNT bound next to the clock bound: 1-64 MODEL REQUESTS. The answer
            // must be one of them, so N buys at most N-1 tool rounds (see the TURNS
            // POLICY block above).
            // Omitted means the harness-wide `maxIterations` limit, which a host owns
            // and a model cannot raise. Hitting the cap means the child never
            // answered, so the result is the unfinished-run envelope (status
            // "failed"/"cancelled" with partialContent), never a truncated answer
            // presented as one.
            maxTurns: {
                type: 'integer',
                minimum: 1,
                maximum: 64,
                description:
                    'Optional cap on how many model REQUESTS the child run may make, 1-64. The cap counts model requests, not tool rounds: the child\'s answer has to land inside it, so N allows at most N-1 tool rounds and 1 only suits a child that answers with no tool call at all. OMIT IT to use the harness-wide limit for this session, which is what normally applies; set it to keep a quick lookup cheap or to bound a long research run. A child that runs out of turns has not answered, so its result is reported like any other unfinished run - its status plus the partialContent it had produced - instead of a final answer it never gave.'
            },
            scope: {
                type: 'object',
                description:
                    'Restrict what the child may do. `tools` is an allowlist of wire names: the child neither sees nor can call anything outside it, so a planning or review delegation can be read-only by construction instead of by instruction. One door is never restricted BY THE SCOPE: toolRequest stays available to a scoped child so it can report what it is missing instead of looping - unless the user of this conversation has switched toolRequest off, which is a session switch and applies to every child. Omit for the historical unrestricted child.',
                properties: {
                    tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Wire names the child may use (e.g. ["read", "glob", "grep"] for a read-only review). An empty array declares no tools at all; toolRequest is still available to it as the discovery door, unless the user of this conversation has switched toolRequest off.'
                    }
                },
                additionalProperties: false
            }
        },
        required: ['agent', 'input'],
        additionalProperties: false
    }
} as const;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are not part of the Tool wire contract, and the discovery reader
// only ever READS them (never executes anything) to reproduce the historical
// registration order and conditional policy.
export const registration = {
    group: 'runtime',
    activation: 'subagents',
    // T2/R2: ASYNC, deliberately. A delegation is a whole child run, so the parent must
    // stay free (its own turn is not held by the child), a completion triggers its own
    // turn the moment the child answers, and `toolCancel` / the periodic heartbeat keep
    // working exactly as before. Grouping it would serialize the delegation model.
    mode: 'async',
    order: 120,
    primaryOnly: true,
    answerExtraction: true,
    sessionBound: true,
    listed: true,
    alwaysDeclared: false
} as const;

// Delegation (R4). Capability-by-configuration: the harness registers delegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - the catalogue-only literal above (the server lists the capability
//     and a session without subagents answers a clear 404 when it is called).
//
// A fresh object is returned every call: the harness spreads it into a Tool and a
// caller may mutate that Tool, so the module-level literal is never handed out.
export const agentDelegateMetadata = (subagents: readonly string[] = []): CoreToolMetadata => {
    const listed = [...subagents];

    if (listed.length === 0) {
        return {
            name: metadata.name,
            description: metadata.description,
            tags: [...metadata.tags],
            visibility: 'core',
            parameters: JSON.parse(JSON.stringify(metadata.parameters)) as Record<string, unknown>
        };
    }

    return {
        name: AGENT_DELEGATE_NAME,
        // The allowlist wording is DUPLICATED verbatim in core/metadata.ts
        // `agentDelegateMetadata` (the manifest-backed projection the server
        // catalogue reads), because the two modules may not import each other. Keep
        // the two in step when this changes — core/metadata.ownership.test.ts
        // compares the two projections for equality.
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, and each delegation starts a NEW conversation with it, so it remembers no earlier one either - unless the call comes from the host rather than one of your conversations, and then the child re-enters that subagent's default conversation (agent:<name>), where it may remember what it answered for you before: the brief must carry everything it needs. Only the primary agent can delegate; subagents cannot delegate further. The result carries agent, content, contentLength, offset, limit, truncated, nextOffset and durationMs, and - when the run is identifiable - invocationId, threadId and status; a child whose ledger entry cannot be resolved (released with its thread, or aged out of the bounded result ledger) reports its answer with those three keys ABSENT rather than inventing an identity, and a run that did not complete adds error, plus the forensic fields it has: partialContent - only the LAST assistant TEXT that run committed, its tool calls and tool results are rolled back and never retained - and cancelledAtMessage, which counts the messages that run had committed and is not a measure of progress. threadId and invocationId are HANDLES, not bookkeeping: threadId is the conversation the child ran in, so post a follow-up message into it with threadSend and read its transcript with threadRead, while agentResult pages that answer by invocationId; a finished child thread stays addressable until it is released with threadDelete, which is also how a session frees a thread slot. content is ONE page of at most maxChars characters (default 8000): when truncated is true, read the rest with agentResult using invocationId and nextOffset as offset - and pass limit, because agentResult's own page is at most 8000 and DEFAULTS TO 4000, so following the cursor without it silently halves your page - or delegate again with a larger maxChars. A cancelled or failed child is reported as a structured result rather than an empty record: its error, plus partialContent whenever it had committed assistant text. That partial is one assistant message, so work the child did through tools is not recoverable from it, and cancelledAtMessage counts committed messages - durationMs is the field that scales with the work. maxTurns caps how many model REQUESTS the child may make (1-64) when you want a deliberately short run; its answer must land inside the cap, so N leaves room for at most N-1 tool rounds and 1 only suits a child that answers with no tool call. Omit it and the harness-wide limit applies. DELIVERY: a delegation is background work, so the RESULT SHAPE is always the envelope above, but WHEN it arrives depends on the child. A child that finishes without real I/O has its result in the tool message of your next turn; a child that is still running leaves a { status: "pending", callId, name, invocationId, threadId, elapsedMs, note } placeholder there instead, and the real envelope arrives in a later turn (use toolCancel with that callId to abandon it). The two ids are in the placeholder on purpose: while the child is still running you can already page what it has produced with agentResult by invocationId, or read its live transcript with threadRead / post into it with threadSend by threadId - and both are ABSENT when the child never started, so a missing id means no run, not an unknown one. Never treat the placeholder as an answer, and never assume the envelope is missing just because the first turn showed a placeholder. Abandoning a live child with toolCancel does not discard its outcome: the tool message of that call carries the same envelope, built from the child's terminal record - status, any partialContent/cancelledAtMessage - plus callCancelled: true, which marks that you released the call while the child's result stayed readable. The toolCancel result itself is an acknowledgement, not the delegation's answer.`,
        tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
        visibility: 'core',
        parameters: {
            type: 'object',
            // T28: derived from the literal above, so the allowlist form advertises
            // exactly the same argument surface — only `agent` is replaced.
            properties: {
                ...(metadata.parameters.properties as Record<string, unknown>),
                agent: {
                    type: 'string',
                    enum: listed,
                    description: 'Subagent name, one of the configured allowlist.'
                }
            },
            required: [...metadata.parameters.required],
            additionalProperties: false
        }
    };
};

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('delegate requires the live harness reference.');
    }

    return context.harness.runtime.delegate(
        context.agent,
        (context.parameters ?? {}) as {
            agent?: string;
            input?: string;
            maxChars?: number;
            requireClarification?: boolean;
            timeoutMs?: number;
            maxTurns?: number;
            scope?: { tools?: readonly string[] };
        },
        context.run,
        context.runDepth,
        // The CALLING run's signal, so the runtime can tell a child cancellation
        // (a structured result) from a caller rollback (which must propagate).
        context.signal,
        // The CALLING tool call's id, so the runtime reports THIS child's identity
        // even while a sibling delegation to the same agent is in flight.
        context.callId,
        // The CALLING run's scope: a call id is unique only within one run.
        context.runScope
    );
};
