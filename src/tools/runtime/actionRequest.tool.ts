// actionRequest — standalone baseline entry; runtime dispatch owns the owner run.
import type { CoreToolMetadata } from '../../core';

// N3 owner interaction and private history forks. Both are CONDITIONAL core
// tools (registered only when interaction/forks are configured), like
// toolCancel, so they are deliberately not part of coreToolMetadata().
export const ACTION_REQUEST_NAME = 'actionRequest';

// N3 owner interaction. The model MUST offer alternatives and a recommendation,
// and the owner can ALWAYS answer with free text; there is deliberately no
// `allowCustom` argument for the model to switch off. The description states the
// recommendation contract because the model reads the description, not this file.
export const ACTION_REQUEST_METADATA: CoreToolMetadata = {
    name: ACTION_REQUEST_NAME,
    description:
        'Ask the owner a bounded question when the request is genuinely ambiguous and guessing would be unsafe or wasteful. Supply ONE question, 2-8 distinct options (each an id plus a short label and optional description), and `recommended` set to the id of the option you suggest. The owner may still answer with free text, so never assume your recommendation was accepted; the tool result tells you exactly which answer was chosen. Ask at most one focused question at a time, and never use this for a decision you can make safely yourself.',
    tags: ['question', 'ask', 'clarify', 'owner', 'user', 'choice', 'interaction'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                minLength: 1,
                maxLength: 4000,
                description:
                    'The one question to ask. Be specific about the decision and why it matters. Maximum 4000 characters.'
            },
            recommended: {
                type: 'string',
                minLength: 1,
                maxLength: 32,
                pattern: '^[A-Za-z0-9_-]+$',
                description:
                    'Id of the option you recommend. MUST exactly match one of the supplied option ids; an unknown id is rejected (there is no automatic fallback).'
            },
            options: {
                type: 'array',
                minItems: 2,
                maxItems: 8,
                description:
                    'Alternative answers, 2-8 entries with unique ids. The owner can still reply with free text.',
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 32,
                            pattern: '^[A-Za-z0-9_-]+$',
                            description:
                                'Stable id, 1-32 characters of letters, digits, "_" or "-". Unique within this request.'
                        },
                        label: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 120,
                            description: 'Short human-visible label, 1-120 characters.'
                        },
                        description: {
                            type: 'string',
                            maxLength: 500,
                            description:
                                'Optional supporting detail, at most 500 characters.'
                        }
                    },
                    required: ['id', 'label'],
                    additionalProperties: false
                }
            }
        },
        required: ['question', 'recommended', 'options'],
        additionalProperties: false
    }
};

export const metadata = ACTION_REQUEST_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'interaction',
    order: 140,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true,
    control: 'action'
} as const;

export const execute = () => {
    throw new Error(
        'actionRequest requires the harness run that owns the conversation; call it from a model tool call.'
    );
};
