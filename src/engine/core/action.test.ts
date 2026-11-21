// core/action.ts — strict actionRequest parsing (N3).
//
// Pinned contract:
//   - the model may NOT send `allowCustom` (custom answers are always allowed,
//     never a model switch);
//   - `recommended` must name a real option id: there is no silent fallback;
//   - ids/labels/question/custom text are trimmed and exact bounds are enforced;
//   - an owner choice must name an offered option id or carry 1-4000 chars of
//     custom text; unknown properties are rejected at every level.

import { describe, expect, it } from 'vitest';
import { ACTION_REQUEST_LIMITS, validateActionChoice, validateActionRequestParameters } from './action';
import type { HarnessActionRequest } from '../types';

const request = (): HarnessActionRequest => ({
    requestId: 'req-1',
    question: 'Which file?',
    recommended: 'a',
    options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta', description: 'Second choice' }
    ],
    allowCustom: true
});

describe('validateActionRequestParameters', () => {
    it('returns a trimmed canonical request with optional descriptions preserved', () => {
        const parsed = validateActionRequestParameters({
            question: '  Which file?  ',
            recommended: ' b ',
            options: [
                { id: ' a ', label: ' Alpha ', description: '  first  ' },
                { id: 'b', label: 'Beta', description: '   ' }
            ]
        });

        expect(parsed).toEqual({
            question: 'Which file?',
            recommended: 'b',
            options: [
                { id: 'a', label: 'Alpha', description: 'first' },
                { id: 'b', label: 'Beta' }
            ]
        });
    });

    it('rejects allowCustom as an unknown model argument', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' }
                ],
                allowCustom: true
            })
        ).toThrow(
            'actionRequest parameters has unknown property "allowCustom". Allowed properties: question, recommended, options.'
        );
    });

    it('rejects an unknown recommended id instead of falling back', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'missing',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' }
                ]
            })
        ).toThrow(
            'actionRequest.recommended "missing" is not one of the supplied option ids: a, b.'
        );
    });

    it('enforces the 2-8 option count', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [{ id: 'a', label: 'A' }]
            })
        ).toThrow('actionRequest.options must contain 2-8 entries; received 1.');

        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: Array.from({ length: 9 }, (_, index) => ({
                    id: `o${index}`,
                    label: `Option ${index}`
                }))
            })
        ).toThrow('actionRequest.options must contain 2-8 entries; received 9.');
    });

    it('rejects duplicate ids after trimming', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: ' a ', label: 'Again' }
                ]
            })
        ).toThrow('actionRequest.options[1].id duplicates option id "a".');
    });

    it('rejects ids outside the provider-safe grammar and beyond 32 characters', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'bad id', label: 'B' }
                ]
            })
        ).toThrow(
            'actionRequest.options[1].id must contain only letters, digits, "_" or "-"; received "bad id".'
        );

        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'o'.repeat(33), label: 'B' }
                ]
            })
        ).toThrow('actionRequest.options[1].id is 33 characters; the maximum is 32.');
    });

    it('enforces label, description and question bounds', () => {
        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: ' ' }
                ]
            })
        ).toThrow('actionRequest.options[1].label must not be empty.');

        expect(() =>
            validateActionRequestParameters({
                question: 'Q?',
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B', description: 'd'.repeat(501) }
                ]
            })
        ).toThrow('actionRequest.options[1].description is 501 characters; the maximum is 500.');

        expect(() =>
            validateActionRequestParameters({
                question: 'q'.repeat(ACTION_REQUEST_LIMITS.question + 1),
                recommended: 'a',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' }
                ]
            })
        ).toThrow('actionRequest.question is 4001 characters; the maximum is 4000.');
    });
});

describe('validateActionChoice', () => {
    it('accepts a known option id', () => {
        expect(validateActionChoice({ kind: 'option', optionId: ' b ' }, request())).toEqual({
            kind: 'option',
            optionId: 'b'
        });
    });

    it('accepts trimmed custom text', () => {
        expect(validateActionChoice({ kind: 'custom', text: '  use src/a.ts  ' }, request())).toEqual({
            kind: 'custom',
            text: 'use src/a.ts'
        });
    });

    it('rejects an option id the request never offered', () => {
        expect(() => validateActionChoice({ kind: 'option', optionId: 'z' }, request())).toThrow(
            'actionRequest choice optionId "z" is not one of the request\'s option ids: a, b.'
        );
    });

    it('rejects empty and oversized custom text', () => {
        expect(() => validateActionChoice({ kind: 'custom', text: '   ' }, request())).toThrow(
            'actionRequest.choice.text must not be empty.'
        );

        expect(() =>
            validateActionChoice({ kind: 'custom', text: 'x'.repeat(4001) }, request())
        ).toThrow('actionRequest.choice.text is 4001 characters; the maximum is 4000.');
    });

    it('rejects unknown kinds and properties', () => {
        expect(() => validateActionChoice({ kind: 'maybe' }, request())).toThrow(
            'actionRequest choice.kind must be "option" or "custom".'
        );

        expect(() =>
            validateActionChoice({ kind: 'option', optionId: 'a', text: 'extra' }, request())
        ).toThrow(
            'actionRequest option choice has unknown property "text". Allowed properties: kind, optionId.'
        );
    });
});
