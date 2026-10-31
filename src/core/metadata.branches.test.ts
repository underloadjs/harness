// core/metadata.ts — actionRequest / threadFork declarative contracts (N3).
//
// Pinned contract:
//   - wire names are `actionRequest` and `threadFork`;
//   - actionRequest advertises 2-8 unique options, a recommended id, and NO
//     allowCustom model argument;
//   - threadFork requires a non-empty input and an optional 120-char label;
//   - both are CONDITIONAL core tools, so coreToolMetadata() (the
//     always-registered set) must not list them.

import { describe, expect, it } from 'vitest';
import {
    ACTION_REQUEST_METADATA,
    ACTION_REQUEST_NAME,
    THREAD_FORK_METADATA,
    THREAD_FORK_NAME,
    coreToolMetadata
} from './metadata';
import { ACTION_REQUEST_LIMITS } from './action';

type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    items?: Schema;
};

describe('metadata: actionRequest', () => {
    it('pins the name and core visibility', () => {
        expect(ACTION_REQUEST_NAME).toBe('actionRequest');
        expect(ACTION_REQUEST_METADATA.name).toBe('actionRequest');
        expect(ACTION_REQUEST_METADATA.visibility).toBe('core');
        expect(ACTION_REQUEST_METADATA.tags).toEqual([
            'question',
            'ask',
            'clarify',
            'owner',
            'user',
            'choice',
            'interaction'
        ]);
    });

    it('advertises the bounded question/options/recommended schema and no allowCustom', () => {
        const schema = ACTION_REQUEST_METADATA.parameters as Schema;
        const properties = schema.properties!;

        expect(schema.type).toBe('object');
        expect(schema.required).toEqual(['question', 'recommended', 'options']);
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(properties)).toEqual(['question', 'recommended', 'options']);

        expect(properties.question).toMatchObject({
            type: 'string',
            minLength: 1,
            maxLength: ACTION_REQUEST_LIMITS.question
        });
        expect(properties.recommended).toMatchObject({
            type: 'string',
            minLength: ACTION_REQUEST_LIMITS.optionIdMin,
            maxLength: ACTION_REQUEST_LIMITS.optionIdMax,
            pattern: '^[A-Za-z0-9_-]+$'
        });
        expect(properties.options).toMatchObject({
            type: 'array',
            minItems: ACTION_REQUEST_LIMITS.optionsMin,
            maxItems: ACTION_REQUEST_LIMITS.optionsMax
        });

        const option = properties.options.items!;
        expect(option.required).toEqual(['id', 'label']);
        expect(option.additionalProperties).toBe(false);
        expect(option.properties!.id).toMatchObject({
            type: 'string',
            minLength: ACTION_REQUEST_LIMITS.optionIdMin,
            maxLength: ACTION_REQUEST_LIMITS.optionIdMax,
            pattern: '^[A-Za-z0-9_-]+$'
        });
        expect(option.properties!.label).toMatchObject({
            type: 'string',
            minLength: ACTION_REQUEST_LIMITS.optionLabelMin,
            maxLength: ACTION_REQUEST_LIMITS.optionLabelMax
        });
        expect(option.properties!.description).toMatchObject({
            type: 'string',
            maxLength: ACTION_REQUEST_LIMITS.optionDescriptionMax
        });

        // There is no model-facing switch for free text.
        expect('allowCustom' in properties).toBe(false);
    });
});

describe('metadata: threadFork', () => {
    it('pins the name, input requirement and optional label bound', () => {
        expect(THREAD_FORK_NAME).toBe('threadFork');
        expect(THREAD_FORK_METADATA.name).toBe('threadFork');
        expect(THREAD_FORK_METADATA.visibility).toBe('core');
        expect(THREAD_FORK_METADATA.tags).toEqual([
            'fork',
            'thread',
            'branch',
            'history',
            'summarize',
            'research'
        ]);

        const schema = THREAD_FORK_METADATA.parameters as Schema;

        expect(schema.required).toEqual(['input']);
        expect(schema.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties!)).toEqual(['input', 'label']);
        expect(schema.properties!.input).toMatchObject({
            type: 'string',
            minLength: 1
        });
        expect(schema.properties!.label).toMatchObject({
            type: 'string',
            minLength: 1,
            maxLength: ACTION_REQUEST_LIMITS.forkLabelMax
        });
    });
});

describe('conditional core registration', () => {
    it('does not put the conditional tools in the always-registered core set', () => {
        expect(coreToolMetadata().map((metadata) => metadata.name)).toEqual([
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult'
        ]);
    });
});
