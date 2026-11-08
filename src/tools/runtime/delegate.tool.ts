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
        'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404.',
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
                    'Wall-clock bound for the child run, in milliseconds. Defaults to 300000 (5 minutes). On expiry the child is stopped and the result reports status "cancelled" with its partialContent and cancelledAtMessage, so a frozen child cannot hold the session open.'
            },
            scope: {
                type: 'object',
                description:
                    'Restrict what the child may do. `tools` is an allowlist of wire names: the child neither sees nor can call anything outside it, so a planning or review delegation can be read-only by construction instead of by instruction. Omit for the historical unrestricted child.',
                properties: {
                    tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Wire names the child may use (e.g. ["read", "glob", "grep"] for a read-only review). An empty array declares no tools at all.'
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
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further. The result carries agent, content, contentLength, offset, limit, truncated, nextOffset, invocationId, threadId, status, durationMs, and - for a run that did not complete - error, partialContent, and cancelledAtMessage. content is ONE page of at most maxChars characters (default 8000): when truncated is true, read the rest with agentResult using invocationId and nextOffset as offset, or delegate again with a larger maxChars. A cancelled or failed child still returns its partialContent and cancelledAtMessage instead of an empty record, so you can see what it had produced and how far it got. DELIVERY: a delegation is background work, so the RESULT SHAPE is always the envelope above, but WHEN it arrives depends on the child. A child that finishes without real I/O has its result in the tool message of your next turn; a child that is still running leaves a { status: "pending", callId } placeholder there instead, and the real envelope arrives in a later turn (use toolCancel with that callId to abandon it). Never treat the placeholder as an answer, and never assume the envelope is missing just because the first turn showed a placeholder.`,
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
