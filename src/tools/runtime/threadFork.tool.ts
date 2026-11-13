// threadFork — standalone baseline entry; runtime dispatch owns the branch.
import type { CoreToolMetadata } from '../../core';

export const THREAD_FORK_NAME = 'threadFork';

// N3 private history fork. The model names the task for the forked thread; the
// runtime copies the owner transcript itself, so the model neither supplies nor
// sees raw history here. `label` is display-only.
//
// BOUNDS ARE LITERALS (same rule as every runtime entry): the `timeoutMs` ceiling
// below restates MODEL_TIMEOUT_MAX_MS in core/agent-limits.ts, and its unbounded
// default restates FORK_TIMEOUT_MS there — an entry may not value-import ../core
// (that closes a cycle through core/metadata.ts), so the equality is pinned instead.
//
// WHAT THE RESULT'S IDS ARE (finding C1, 2026-11-13). A branch answers with
// `{ branchId, threadId, content }` and BOTH ids are the same generated `branch-N`
// string (src/harness.ts ~8009-8013), which is also the invocation id the branch is
// recorded under. So the description says what a caller can do with it: threadRead
// reads the branch transcript by that id, and agentResult reads the answer — plus
// the partialContent of a branch that was cancelled, failed or timed out before it
// finished — by using it as `invocationId`. Before this, the ids were reported and
// nothing told the model they addressed anything.
export const THREAD_FORK_METADATA: CoreToolMetadata = {
    name: THREAD_FORK_NAME,
    description:
        'Fork a private thread that reads the ENTIRE current conversation independently and returns one final summary. Use it when a self-contained investigation benefits from isolated reasoning without polluting this transcript. The new thread cannot see later messages and never receives this agent\'s tools automatically beyond the runtime grant. Pass the task as `input`; `label` is an optional short display name. The result reports `branchId` and `threadId`, which are the SAME generated `branch-N` id, plus the summary in `content`. Treat that id as a handle, not a receipt: threadRead accepts it to read the branch transcript, and agentResult accepts it as `invocationId` to page the answer - including the partialContent of a branch that was cancelled, failed or timed out before it answered. `timeoutMs` optionally bounds the branch clock (1-3600000 ms); omit it for no time limit. On expiry the branch is stopped and the result that reaches you carries the partial content it had produced instead of a final summary, and that content stays readable through agentResult afterwards. A fork may fork again, but nesting stops at two levels below this conversation (your fork, and its fork) - a deeper fork is refused. The fork shares this process and any external side effects, so it is not a sandbox.',
    tags: ['fork', 'thread', 'branch', 'history', 'summarize', 'research'],
    // R9-R11 demand discovery: searchable, so the model finds it through toolRequest
    // and enables it for this session instead of seeing it declared on every request.
    // Registration itself is unchanged (the entry still joins the harness registry),
    // so toolRequest always has something to surface.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                minLength: 1,
                description:
                    'The complete task for the forked thread. It reads the full current history, so refer to that context rather than repeating it.'
            },
            label: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
                description:
                    'Optional short display label. Maximum 120 characters; it grants no authority.'
            },
            // The fork half of the 2026-11-09 time policy: a COUNT-free wall clock
            // the CALLER may set, with the same shape as delegate's `timeoutMs` —
            // unbounded by default, finite on request, and a partial result rather
            // than an empty one when it expires. Bounds are literals pinned against
            // MODEL_TIMEOUT_MAX_MS / FORK_TIMEOUT_MS in core/agent-limits.ts.
            timeoutMs: {
                type: 'integer',
                minimum: 1,
                maximum: 3600000,
                description:
                    'Optional wall-clock bound for the branch run, in integer milliseconds (1-3600000). OMIT IT FOR NO TIME LIMIT, which is the default: the branch runs until it answers, and nothing external ends it on a clock. Set a value only when you believe a limit is warranted; the 1-3600000 range bounds what you may ask for, never the absence of a bound. On expiry the branch is stopped and the result delivered to you carries the partial content it had produced, exactly as a cancelled or failed branch does, and that content stays readable with agentResult using the branch id as invocationId. A branch that is still running is abandoned with toolCancel using the callId from its pending placeholder. The tools the branch calls carry their own time bounds, which is what keeps an unbounded branch from hanging on I/O.'
            }
        },
        required: ['input'],
        additionalProperties: false
    }
};

export const metadata = THREAD_FORK_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'forks',
    // T2/R2: ASYNC, and this is the declaration of the behaviour the branch runtime
    // already implements (a detached clone answers through the mailbox whenever it
    // finishes, and the requester stays free). The control dispatch path never joins a
    // sync group, so the mode and the dispatch agree by construction.
    mode: 'async',
    order: 130,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true,
    control: 'fork'
} as const;

export const execute = () => {
    throw new Error(
        'threadFork requires the harness run that owns the conversation; call it from a model tool call.'
    );
};
