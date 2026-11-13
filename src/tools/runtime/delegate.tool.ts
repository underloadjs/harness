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
// model turns (tool rounds) instead of a wall clock. Omitting it is the default and
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
        'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404. The envelope names two HANDLES: `threadId` is the conversation the child ran in, so a follow-up goes through threadSend (another message into it) or threadRead (its transcript), and `invocationId` is what agentResult pages by; a finished child stays addressable until it is released with threadDelete. `maxChars` pages the answer, `timeoutMs` optionally bounds the child\'s wall clock (omit it for no limit), and `maxTurns` optionally caps its model turns at 1-64 (omit it for the harness-wide limit).',
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
            // A COUNT bound next to the clock bound: 1-64 model turns (tool rounds).
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
                    'Optional cap on how many model turns (tool rounds) the child run may take, 1-64. OMIT IT to use the harness-wide limit for this session, which is what normally applies; set it to keep a quick lookup cheap or to bound a long research run. A child that runs out of turns has not answered, so its result is reported like any other unfinished run - its status plus the partialContent it had produced - instead of a final answer it never gave.'
            },
            scope: {
                type: 'object',
                description:
                    'Restrict what the child may do. `tools` is an allowlist of wire names: the child neither sees nor can call anything outside it, so a planning or review delegation can be read-only by construction instead of by instruction. One door is never restricted: toolRequest stays available to a scoped child so it can report what it is missing instead of looping. Omit for the historical unrestricted child.',
                properties: {
                    tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Wire names the child may use (e.g. ["read", "glob", "grep"] for a read-only review). An empty array declares no tools at all; toolRequest is still available to it as the discovery door.'
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
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further. The result carries agent, content, contentLength, offset, limit, truncated, nextOffset and durationMs, and - when the run is identifiable - invocationId, threadId and status; a child whose ledger entry cannot be resolved (released with its thread, or aged out of the bounded result ledger) reports its answer with those three keys ABSENT rather than inventing an identity, and a run that did not complete adds error, partialContent, and cancelledAtMessage. threadId and invocationId are HANDLES, not bookkeeping: threadId is the conversation the child ran in, so post a follow-up message into it with threadSend and read its transcript with threadRead, while agentResult pages that answer by invocationId; a finished child thread stays addressable until it is released with threadDelete, which is also how a session frees a thread slot. content is ONE page of at most maxChars characters (default 8000): when truncated is true, read the rest with agentResult using invocationId and nextOffset as offset, or delegate again with a larger maxChars. A cancelled or failed child still returns its partialContent and cancelledAtMessage instead of an empty record, so you can see what it had produced and how far it got. maxTurns caps the child's model turns (1-64) when you want a deliberately short run; omit it and the harness-wide limit applies. DELIVERY: a delegation is background work, so the RESULT SHAPE is always the envelope above, but WHEN it arrives depends on the child. A child that finishes without real I/O has its result in the tool message of your next turn; a child that is still running leaves a { status: "pending", callId } placeholder there instead, and the real envelope arrives in a later turn (use toolCancel with that callId to abandon it). Never treat the placeholder as an answer, and never assume the envelope is missing just because the first turn showed a placeholder.`,
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
