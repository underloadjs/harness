// actionRequest wire parsing (N3).
//
// This module is the SINGLE semantic gate for the two model/host shapes the
// actionRequest tool exchanges:
//
//   validateActionRequestParameters(value) — the tool ARGUMENTS the model sent.
//   validateActionChoice(value, request)   — the answer an owner/host returns.
//
// The JSON Schema in core/metadata.ts bounds types and lengths, but a schema
// cannot say "recommended must name one of these option ids" or "an option id is
// unique within this request". Both rules are enforced here, because a server
// route, the frontend card, and the harness runtime must agree exactly.
//
// Deliberate contract choices (frozen for N3 consumers):
//   - there is NO `allowCustom` model argument: custom answers are always
//     allowed, and a supplied allowCustom key is rejected as unknown;
//   - an unknown `recommended` id is an ERROR, never a silent fallback to the
//     first option;
//   - ids/labels/texts are trimmed before validation, so surrounding whitespace
//     can never create two "different" ids that render identically;
//   - unknown properties are rejected at every level (strict, like the tool
//     schema's additionalProperties: false).
//
// Cross-references:
//   - ../types/index.ts   — HarnessActionRequest / Choice / Result
//   - ./metadata.ts       — ACTION_REQUEST_METADATA / THREAD_FORK_METADATA
//   - ./branch.ts         — branches that may answer a request automatically
//   - ../harness.ts       — runtime emitter/answerer (later worker)

import { HarnessError } from '../util';
import type { HarnessActionChoice, HarnessActionOption, HarnessActionRequest } from '../types';

// Every bound is exported so the metadata schemas and any server/frontend
// re-validation quote one number instead of drifting.
export const ACTION_REQUEST_LIMITS = {
    question: 4000,
    optionsMin: 2,
    optionsMax: 8,
    optionIdMin: 1,
    optionIdMax: 32,
    optionLabelMin: 1,
    optionLabelMax: 120,
    optionDescriptionMax: 500,
    customTextMin: 1,
    customTextMax: 4000,
    // threadFork's display label shares the option-label ceiling.
    forkLabelMax: 120
} as const;

// Ids are provider/model-facing keys, so the grammar is intentionally narrow:
// letters, digits, underscore and hyphen. The same grammar applies to every
// option id and to the `recommended` value.
const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Narrow unknown to a plain object. Arrays and null are not objects for this
// parser: both would otherwise pass `typeof value === 'object'`.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Reject every property the shape does not declare. This is what turns "no
// allowCustom model argument" from a documentation claim into an enforced rule.
const assertExactKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    context: string
): void => {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new HarnessError(
                `${context} has unknown property "${key}". Allowed properties: ${allowed.join(', ')}.`
            );
        }
    }
};

// A required text field: string, trimmed, non-empty, and within the limit below.
// NOTE: this measures JavaScript string length, i.e. UTF-16 CODE UNITS. JSON
// Schema `maxLength` counts Unicode CODE POINTS, so these agree for BMP text but
// NOT for astral characters: an emoji is one code point and two code units, so
// this gate is the stricter one for such inputs. A client that mirrors the JSON
// Schema must not assume the two counts are identical; this module is
// authoritative at runtime.
const requiredText = (value: unknown, field: string, max: number): string => {
    if (typeof value !== 'string') {
        throw new HarnessError(`${field} must be a string.`);
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
        throw new HarnessError(`${field} must not be empty.`);
    }

    if (trimmed.length > max) {
        throw new HarnessError(`${field} is ${trimmed.length} characters; the maximum is ${max}.`);
    }

    return trimmed;
};

// One option id: grammar + length. Kept separate so `recommended` and each
// option id cannot diverge.
const optionId = (value: unknown, field: string): string => {
    const id = requiredText(value, field, ACTION_REQUEST_LIMITS.optionIdMax);

    if (!OPTION_ID_PATTERN.test(id)) {
        throw new HarnessError(
            `${field} must contain only letters, digits, "_" or "-"; received "${id}".`
        );
    }

    return id;
};

// Validate the model-facing actionRequest arguments and return the CANONICAL
// request arguments (without requestId; the runtime generates that). The return
// value is a detached copy: the caller's arrays/objects are never aliased.
export function validateActionRequestParameters(value: unknown): {
    question: string;
    recommended: string;
    options: HarnessActionOption[];
} {
    if (!isPlainObject(value)) {
        throw new HarnessError('actionRequest parameters must be an object.');
    }

    // allowCustom is intentionally absent from this list: it is not a model
    // argument, and sending it is a schema violation rather than a harmless extra.
    assertExactKeys(value, ['question', 'recommended', 'options'], 'actionRequest parameters');

    const question = requiredText(
        value.question,
        'actionRequest.question',
        ACTION_REQUEST_LIMITS.question
    );

    if (!Array.isArray(value.options)) {
        throw new HarnessError('actionRequest.options must be an array.');
    }

    if (
        value.options.length < ACTION_REQUEST_LIMITS.optionsMin ||
        value.options.length > ACTION_REQUEST_LIMITS.optionsMax
    ) {
        throw new HarnessError(
            `actionRequest.options must contain ${ACTION_REQUEST_LIMITS.optionsMin}-${ACTION_REQUEST_LIMITS.optionsMax} entries; received ${value.options.length}.`
        );
    }

    const options: HarnessActionOption[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < value.options.length; index += 1) {
        const raw = value.options[index];
        const field = `actionRequest.options[${index}]`;

        if (!isPlainObject(raw)) {
            throw new HarnessError(`${field} must be an object.`);
        }

        assertExactKeys(raw, ['id', 'label', 'description'], field);

        const id = optionId(raw.id, `${field}.id`);

        if (seen.has(id)) {
            throw new HarnessError(`${field}.id duplicates option id "${id}".`);
        }
        seen.add(id);

        const label = requiredText(
            raw.label,
            `${field}.label`,
            ACTION_REQUEST_LIMITS.optionLabelMax
        );

        // Description is optional. When supplied it is trimmed; an all-whitespace
        // description is omitted rather than stored as an empty string, so the
        // canonical shape never carries meaningless detail.
        let description: string | undefined;
        if (raw.description !== undefined) {
            if (typeof raw.description !== 'string') {
                throw new HarnessError(`${field}.description must be a string.`);
            }

            const trimmed = raw.description.trim();
            if (trimmed.length > ACTION_REQUEST_LIMITS.optionDescriptionMax) {
                throw new HarnessError(
                    `${field}.description is ${trimmed.length} characters; the maximum is ${ACTION_REQUEST_LIMITS.optionDescriptionMax}.`
                );
            }

            if (trimmed.length > 0) description = trimmed;
        }

        options.push(
            description === undefined ? { id, label } : { id, label, description }
        );
    }

    const recommended = optionId(value.recommended, 'actionRequest.recommended');

    // No silent recommended fallback: a model that names a missing option is
    // told exactly what it did wrong and must retry.
    if (!seen.has(recommended)) {
        throw new HarnessError(
            `actionRequest.recommended "${recommended}" is not one of the supplied option ids: ${[...seen].join(', ')}.`
        );
    }

    return { question, recommended, options };
}

// Validate one owner/host answer against the request it answers. `request` is
// expected to be the already-canonicalised value (validateActionRequestParameters
// plus a runtime-generated requestId); this function never mutates it.
export function validateActionChoice(
    value: unknown,
    request: HarnessActionRequest
): HarnessActionChoice {
    if (!isPlainObject(value)) {
        throw new HarnessError('actionRequest choice must be an object.');
    }

    const kind = value.kind;

    if (kind === 'option') {
        assertExactKeys(value, ['kind', 'optionId'], 'actionRequest option choice');

        const chosen = optionId(value.optionId, 'actionRequest.choice.optionId');
        const match = request.options.find((option) => option.id === chosen);

        // Choosing an id the model never offered is a programming error in the
        // host/UI, not a free-text answer: reject it instead of coercing.
        if (match === undefined) {
            throw new HarnessError(
                `actionRequest choice optionId "${chosen}" is not one of the request's option ids: ${request.options.map((option) => option.id).join(', ')}.`
            );
        }

        return { kind: 'option', optionId: chosen };
    }

    if (kind === 'custom') {
        assertExactKeys(value, ['kind', 'text'], 'actionRequest custom choice');

        const text = requiredText(
            value.text,
            'actionRequest.choice.text',
            ACTION_REQUEST_LIMITS.customTextMax
        );

        // `allowCustom` is a type-level `true` on HarnessActionRequest, so there
        // is no request-side flag to check here. A future host that wants to
        // forbid free text must reject it before calling this parser.
        return { kind: 'custom', text };
    }

    throw new HarnessError(
        'actionRequest choice.kind must be "option" or "custom".'
    );
}
