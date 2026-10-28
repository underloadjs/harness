// Runtime JSON Schema validation and the single-property rule (R11).
//
// The contract pinned here:
//   - the MODEL sends the schema wrapper (`{ "paths": [...] }`); `execute`
//     receives the unwrapped property value;
//   - a DIRECT/host call keeps its legacy already-unwrapped form
//     (`fileRead(['a.txt'])`) and is validated as the property;
//   - a manual call may also pass the wrapper; both resolve to the same value;
//   - wrong types, missing required properties, unknown properties (when
//     additionalProperties is false), enums, oneOf, and numeric/string/array
//     limits are rejected with an exact, path-carrying message;
//   - a created schema is depth/size gated before it can become a request
//     payload.

import { describe, expect, it } from 'vitest';
import {
    MAX_CREATED_SCHEMA_BYTES,
    MAX_CREATED_SCHEMA_DEPTH,
    MAX_CREATED_SCHEMA_NODES,
    checkToolSchemaComplexity,
    resolveToolParameters,
    validateSchemaValue
} from '@underload/harness';

// The fileRead shape: one property, whose value is an array of strings.
const single = {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' } } },
    required: ['paths'],
    additionalProperties: false
};

// The syntaxCheck shape: two required properties, so no unwrapping happens.
const multi = {
    type: 'object',
    properties: {
        code: { type: 'string' },
        language: { type: 'string', enum: ['javascript', 'python'] }
    },
    required: ['code', 'language'],
    additionalProperties: false
};

describe('resolveToolParameters', () => {
    it('unwraps the model wrapper for a single-property schema', () => {
        expect(resolveToolParameters(single, { paths: ['a.txt', 'b.txt'] }, 'model')).toEqual([
            'a.txt',
            'b.txt'
        ]);
    });

    it('tolerates a model that sent the bare value instead', () => {
        expect(resolveToolParameters(single, ['a.txt'], 'model')).toEqual(['a.txt']);
    });

    it('keeps the legacy direct form unchanged and still validates it', () => {
        expect(resolveToolParameters(single, ['a.txt'], 'direct')).toEqual(['a.txt']);
        expect(() => resolveToolParameters(single, 7, 'direct')).toThrow(
            '$.paths must be of type array.'
        );
    });

    it('resolves a direct wrapper object to the same value as the bare form', () => {
        expect(resolveToolParameters(single, { paths: ['a.txt'] }, 'direct')).toEqual(['a.txt']);
        expect(resolveToolParameters(single, { paths: ['a.txt'] }, 'direct')).toEqual(
            resolveToolParameters(single, ['a.txt'], 'direct')
        );
    });

    it('validates the wrapper and reports the offending path', () => {
        expect(() => resolveToolParameters(single, { paths: 'a.txt' }, 'model')).toThrow(
            '$.paths must be of type array.'
        );
        expect(() => resolveToolParameters(single, {}, 'model')).toThrow('$.paths is required.');
        expect(() => resolveToolParameters(single, { paths: ['a'], x: 1 }, 'model')).toThrow(
            '$ must not include the additional property "x".'
        );
        expect(() => resolveToolParameters(single, { paths: [1] }, 'model')).toThrow(
            '$.paths[0] must be of type string.'
        );
    });

    it('passes a multi-property object through as the parameters object', () => {
        expect(
            resolveToolParameters(multi, { code: 'x', language: 'python' }, 'model')
        ).toEqual({ code: 'x', language: 'python' });
    });

    it('enforces enum and required on a multi-property schema', () => {
        expect(() => resolveToolParameters(multi, { code: 'x' }, 'model')).toThrow(
            '$.language is required.'
        );
        expect(() =>
            resolveToolParameters(multi, { code: 'x', language: 'ruby' }, 'model')
        ).toThrow('$.language must be one of: "javascript", "python".');
    });

    it('does nothing when the tool declares no schema', () => {
        expect(resolveToolParameters(undefined, 'anything', 'model')).toBe('anything');
        expect(resolveToolParameters(undefined, { a: 1 }, 'direct')).toEqual({ a: 1 });
    });
});

describe('validateSchemaValue', () => {
    it('applies numeric, string, and array limits', () => {
        expect(validateSchemaValue({ type: 'integer', minimum: 1, maximum: 3 }, 0)).toEqual({
            valid: false,
            message: '$ must be >= 1.'
        });
        expect(validateSchemaValue({ type: 'integer', minimum: 1, maximum: 3 }, 4)).toEqual({
            valid: false,
            message: '$ must be <= 3.'
        });
        expect(validateSchemaValue({ type: 'number', minimum: 1 }, 1.5)).toEqual({ valid: true });
        // `integer` is stricter than `number`.
        expect(validateSchemaValue({ type: 'integer' }, 1.5)).toEqual({
            valid: false,
            message: '$ must be of type integer.'
        });

        expect(validateSchemaValue({ type: 'string', minLength: 2, maxLength: 3 }, 'a')).toEqual({
            valid: false,
            message: '$ must be at least 2 characters.'
        });
        expect(validateSchemaValue({ type: 'string', maxLength: 3 }, 'abcd')).toEqual({
            valid: false,
            message: '$ must be at most 3 characters.'
        });

        expect(validateSchemaValue({ type: 'array', minItems: 1 }, [])).toEqual({
            valid: false,
            message: '$ must contain at least 1 items.'
        });
        expect(validateSchemaValue({ type: 'array', maxItems: 2 }, [1, 2, 3])).toEqual({
            valid: false,
            message: '$ must contain at most 2 items.'
        });
    });

    it('accepts either branch of a oneOf and rejects none or both', () => {
        const schema = { oneOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }] };

        expect(validateSchemaValue(schema, 'a.txt')).toEqual({ valid: true });
        expect(validateSchemaValue(schema, { path: 'a.txt' })).toEqual({ valid: true });
        expect(validateSchemaValue(schema, true)).toEqual({
            valid: false,
            message: '$ must match exactly one of the allowed shapes (matched 0).'
        });
    });

    it('ignores keywords it does not enforce', () => {
        // description/format/$schema are model documentation, not constraints.
        expect(validateSchemaValue({ type: 'string', description: 'x', format: 'uri' }, 'v')).toEqual({
            valid: true
        });
    });
});

describe('checkToolSchemaComplexity', () => {
    it('accepts the bundled fileRead-shaped schema untouched', () => {
        const nested = {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' },
                                    startLine: { type: 'integer', minimum: 1 }
                                },
                                required: ['path'],
                                additionalProperties: false
                            }
                        ]
                    }
                }
            },
            required: ['paths'],
            additionalProperties: false
        };

        expect(checkToolSchemaComplexity(nested)).toEqual({ valid: true });
    });

    it('rejects a schema nested deeper than the limit', () => {
        // Build `{ properties: { a: { properties: { a: ... } } } }` deeper than
        // MAX_CREATED_SCHEMA_DEPTH and down to a string leaf.
        let schema: Record<string, unknown> = { type: 'string' };

        for (let level = 0; level < MAX_CREATED_SCHEMA_DEPTH + 1; level++) {
            schema = { type: 'object', properties: { a: schema } };
        }

        expect(checkToolSchemaComplexity(schema)).toEqual({
            valid: false,
            message: `are nested deeper than ${MAX_CREATED_SCHEMA_DEPTH} levels`
        });
    });

    it('rejects a schema with more nodes than the limit', () => {
        const properties: Record<string, unknown> = {};

        for (let index = 0; index < MAX_CREATED_SCHEMA_NODES; index++) {
            properties[`p${index}`] = { type: 'string' };
        }

        expect(checkToolSchemaComplexity({ type: 'object', properties })).toEqual({
            valid: false,
            message: `have more than ${MAX_CREATED_SCHEMA_NODES} schema nodes`
        });
    });

    // U11: the cap must count CONTAINERS ANYWHERE, not only the keywords
    // `validateSchemaValue` happens to implement. Each of these was accepted before
    // the fix even though it would ship on every request.
    it('counts $defs containers toward the node cap', () => {
        const defs: Record<string, unknown> = {};

        // 400 nested objects under a keyword the validator does not read. Nodes:
        // root + $defs + 400 entries = 402 > 256.
        for (let index = 0; index < 400; index++) defs[`def${index}`] = { type: 'string' };

        expect(checkToolSchemaComplexity({ type: 'object', $defs: defs })).toEqual({
            valid: false,
            message: `have more than ${MAX_CREATED_SCHEMA_NODES} schema nodes`
        });
    });

    it('counts patternProperties containers toward the node cap', () => {
        const patternProperties: Record<string, unknown> = {};

        for (let index = 0; index < 300; index++) {
            patternProperties[`^p${index}$`] = { type: 'string', minLength: 1 };
        }

        expect(checkToolSchemaComplexity({ type: 'object', patternProperties })).toEqual({
            valid: false,
            message: `have more than ${MAX_CREATED_SCHEMA_NODES} schema nodes`
        });

        // A small $defs/patternProperties vocabulary is LEGITIMATE: this gate limits
        // traversal, it does not declare those keywords unsupported (the validator
        // still ignores them) — see the header note in schema-validation.ts.
        expect(
            checkToolSchemaComplexity({
                type: 'object',
                $defs: { name: { type: 'string' } },
                patternProperties: { '^x-': { type: 'string' } }
            })
        ).toEqual({ valid: true });
    });

    it('follows UNKNOWN keywords so no nested object escapes the walk', () => {
        // One container per level under a keyword nobody implements: counted, so the
        // depth cap applies to it exactly like `properties`.
        let schema: Record<string, unknown> = { type: 'string' };

        for (let level = 0; level < MAX_CREATED_SCHEMA_DEPTH + 1; level++) {
            schema = { 'x-custom': schema };
        }

        expect(checkToolSchemaComplexity(schema)).toEqual({
            valid: false,
            message: `are nested deeper than ${MAX_CREATED_SCHEMA_DEPTH} levels`
        });

        // Same shape, within the limit, is accepted exactly.
        expect(
            checkToolSchemaComplexity({ type: 'object', 'x-custom': { a: { b: {} } } })
        ).toEqual({ valid: true });
    });

    it('rejects a schema whose serialized bytes exceed the cap', () => {
        // ONE node with an enormous scalar: a node count cannot see this, the byte
        // cap can. `x` is JSON-escape-free, so the payload is description + ~24.
        const schema = { type: 'string', description: 'x'.repeat(MAX_CREATED_SCHEMA_BYTES) };

        expect(checkToolSchemaComplexity(schema)).toEqual({
            valid: false,
            message: `are larger than ${MAX_CREATED_SCHEMA_BYTES} serialized bytes`
        });
    });

    it('rejects a reference cycle instead of recursing or throwing', () => {
        // JSON cannot express a cycle, but a host can pass a live object. Without
        // this guard the walk would never terminate (and JSON.stringify would throw
        // a TypeError that names nothing useful).
        const cyclic: Record<string, unknown> = { type: 'object' };

        cyclic.properties = { a: cyclic };

        expect(checkToolSchemaComplexity(cyclic)).toEqual({
            valid: false,
            message: 'contain a reference cycle'
        });
    });
});
