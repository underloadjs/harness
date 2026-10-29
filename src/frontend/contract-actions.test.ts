// N3 interaction/branch contract guards.
//
// The browser must not act on a partially malformed action_request/action_answer
// or branch frame: a bad option id could post an answer for the wrong choice, and
// a branch summary without identity cannot be rendered as a row. These parsers
// return undefined instead of inventing fields. `threadOf` also keeps the new
// `kind`/`branchId` metadata so fork/autoanswer rows can be labelled.

import type { HarnessEvent } from '../server/protocol';
import {
    actionAnswerEventOf,
    actionAnswerOf,
    actionChoiceOf,
    actionRequestEventOf,
    actionRequestOf,
    branchEndEventOf,
    branchStartEventOf,
    threadOf
} from './contract';

const request = {
    requestId: 'req-1',
    question: 'Which file?',
    recommended: 'b',
    options: [
        { id: 'a', label: 'Alpha', description: 'first' },
        { id: 'b', label: 'Beta' }
    ],
    allowCustom: true
};

describe('actionRequestOf', () => {
    it('returns the normalized request with every valid option', () => {
        expect(actionRequestOf(request)).toEqual(request);
    });

    it('drops malformed options and duplicate ids but keeps the request usable', () => {
        expect(
            actionRequestOf({
                ...request,
                options: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'a', label: 'Alpha again' },
                    { id: '', label: 'no id' },
                    { id: 'c', label: '' },
                    { id: 'd', label: 'Delta', description: 7 }
                ]
            })
        ).toEqual({
            ...request,
            options: [
                { id: 'a', label: 'Alpha' },
                { id: 'd', label: 'Delta' }
            ]
        });
    });

    it('treats custom answers as always allowed even when the flag is absent', () => {
        expect(actionRequestOf({ ...request, allowCustom: undefined })).toEqual({
            ...request,
            allowCustom: true
        });
    });

    it('rejects a request without the required identity or a non-array option list', () => {
        expect(actionRequestOf(undefined)).toBeUndefined();
        expect(actionRequestOf({ ...request, requestId: '' })).toBeUndefined();
        expect(actionRequestOf({ ...request, question: '' })).toBeUndefined();
        expect(actionRequestOf({ ...request, recommended: '' })).toBeUndefined();
        expect(actionRequestOf({ ...request, options: 'a,b' })).toBeUndefined();
    });
});

describe('actionChoiceOf / actionAnswerOf', () => {
    it('accepts both choice kinds and rejects empty custom text', () => {
        expect(actionChoiceOf({ kind: 'option', optionId: 'b' })).toEqual({
            kind: 'option',
            optionId: 'b'
        });
        expect(actionChoiceOf({ kind: 'custom', text: 'read the docs' })).toEqual({
            kind: 'custom',
            text: 'read the docs'
        });
        expect(actionChoiceOf({ kind: 'custom', text: '   ' })).toBeUndefined();
        expect(actionChoiceOf({ kind: 'option', optionId: '' })).toBeUndefined();
        expect(actionChoiceOf({ kind: 'other' })).toBeUndefined();
    });

    it('keeps an automatic branch id and drops malformed optional fields', () => {
        expect(
            actionAnswerOf({
                requestId: 'req-1',
                choice: { kind: 'option', optionId: 'b' },
                source: 'auto',
                branchId: 'branch-1'
            })
        ).toEqual({
            requestId: 'req-1',
            choice: { kind: 'option', optionId: 'b' },
            source: 'auto',
            branchId: 'branch-1'
        });

        expect(
            actionAnswerOf({
                requestId: 'req-1',
                choice: { kind: 'custom', text: 'x' },
                source: 'owner',
                branchId: 7
            })
        ).toEqual({
            requestId: 'req-1',
            choice: { kind: 'custom', text: 'x' },
            source: 'owner'
        });

        expect(actionAnswerOf({ requestId: 'req-1', choice: { kind: 'option', optionId: 'b' }, source: 'x' })).toBeUndefined();
    });
});

describe('event guards', () => {
    it('validates the whole action_request frame', () => {
        const event = {
            type: 'action_request',
            agent: 'writer',
            callId: 'call-1',
            request
        } as unknown as HarnessEvent;

        expect(actionRequestEventOf(event)?.request).toEqual(request);
        expect(
            actionRequestEventOf({ ...event, agent: '' } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            actionRequestEventOf({ ...event, callId: '' } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            actionRequestEventOf({ ...event, request: { ...request, options: null } } as unknown as HarnessEvent)
        ).toBeUndefined();
    });

    it('rejects an action_answer whose envelope names a different request', () => {
        const answer = {
            requestId: 'req-1',
            choice: { kind: 'option', optionId: 'b' },
            source: 'owner' as const
        };
        const event = {
            type: 'action_answer',
            agent: 'writer',
            requestId: 'req-1',
            answer
        } as unknown as HarnessEvent;

        expect(actionAnswerEventOf(event)?.answer).toEqual(answer);
        expect(
            actionAnswerEventOf({
                ...event,
                requestId: 'req-other'
            } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            actionAnswerEventOf({
                ...event,
                answer: { ...answer, choice: { kind: 'custom', text: '' } }
            } as unknown as HarnessEvent)
        ).toBeUndefined();
    });

    it('accepts only the frozen branch lifecycle shapes', () => {
        const start = {
            type: 'branch_start' as const,
            agent: 'helper',
            branch: {
                branchId: 'branch-1',
                kind: 'fork' as const,
                agent: 'helper',
                role: 'subagent' as const,
                forkDepth: 1,
                model: 'm1',
                tools: ['fileRead']
            }
        };

        expect(branchStartEventOf(start as unknown as HarnessEvent)?.branch.branchId).toBe('branch-1');
        expect(
            branchStartEventOf({ ...start, branch: { ...start.branch, kind: 'other' } } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            branchStartEventOf({ ...start, branch: { ...start.branch, forkDepth: -1 } } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            branchStartEventOf({ ...start, branch: { ...start.branch, tools: 'fileRead' } } as unknown as HarnessEvent)
        ).toBeUndefined();

        const end = {
            type: 'branch_end' as const,
            agent: 'helper',
            branchId: 'branch-1',
            status: 'failed' as const,
            error: { message: 'boom' }
        };

        expect(branchEndEventOf(end as unknown as HarnessEvent)?.status).toBe('failed');
        expect(
            branchEndEventOf({ ...end, status: 'running' } as unknown as HarnessEvent)
        ).toBeUndefined();
        expect(
            branchEndEventOf({ ...end, branchId: '' } as unknown as HarnessEvent)
        ).toBeUndefined();
    });
});

describe('threadOf N3 metadata', () => {
    it('keeps a fork kind and branch identity', () => {
        expect(
            threadOf({ thread: { id: 't1', kind: 'fork', branchId: 'branch-1' } })
        ).toEqual({ id: 't1', kind: 'fork', branchId: 'branch-1' });
    });

    it('drops an unknown kind and a blank branch id', () => {
        expect(threadOf({ thread: { id: 't1', kind: 'other', branchId: '' } })).toEqual({ id: 't1' });
    });
});
