// threadFork — standalone baseline entry; runtime dispatch owns the branch.
import type { CoreToolMetadata } from '../../core';

export const THREAD_FORK_NAME = 'threadFork';

// N3 private history fork. The model names the task for the forked thread; the
// runtime copies the owner transcript itself, so the model neither supplies nor
// sees raw history here. `label` is display-only.
export const THREAD_FORK_METADATA: CoreToolMetadata = {
    name: THREAD_FORK_NAME,
    description:
        'Fork a private thread that reads the ENTIRE current conversation independently and returns one final summary. Use it when a self-contained investigation benefits from isolated reasoning without polluting this transcript. The new thread cannot see later messages and never receives this agent\'s tools automatically beyond the runtime grant. Pass the task as `input`; `label` is an optional short display name. The fork shares this process and any external side effects, so it is not a sandbox.',
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
