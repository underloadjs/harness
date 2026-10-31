// threadFork — standalone baseline entry; runtime dispatch owns the branch.
import type { CoreToolMetadata } from '../core';

export const THREAD_FORK_NAME = 'threadFork';

// N3 private history fork. The model names the task for the forked thread; the
// runtime copies the owner transcript itself, so the model neither supplies nor
// sees raw history here. `label` is display-only.
export const THREAD_FORK_METADATA: CoreToolMetadata = {
    name: THREAD_FORK_NAME,
    description:
        'Fork a private thread that reads the ENTIRE current conversation independently and returns one final summary. Use it when a self-contained investigation benefits from isolated reasoning without polluting this transcript. The new thread cannot see later messages and never receives this agent\'s tools automatically beyond the runtime grant. Pass the task as `input`; `label` is an optional short display name. The fork shares this process and any external side effects, so it is not a sandbox.',
    tags: ['fork', 'thread', 'branch', 'history', 'summarize', 'research'],
    visibility: 'core',
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

export const execute = () => {
    throw new Error(
        'threadFork requires the harness run that owns the conversation; call it from a model tool call.'
    );
};
