// Runtime JSON Schema validation (R11).
//
// A tool's `parameters` was, until now, a declaration only: the transport sent
// the schema to the model and the harness forwarded whatever arguments came
// back straight into `execute`. A model that forgot `required`, sent the wrong
// type, invented a property, or ignored an `enum` produced either a confusing
// implementation error or — worse — a silently wrong call (a number where an
// array of paths belonged).
//
// This module is the one runtime gate for that surface. It supports exactly the
// JSON Schema vocabulary the project actually uses:
//
//   type (string | array of strings), properties, required,
//   additionalProperties: false, items, enum, oneOf,
//   minimum / maximum, minLength / maxLength, minItems / maxItems
//
// Everything else in a schema (description, title, default, examples, format,
// $schema) is documentation for the model and is ignored here. An unknown
// keyword is not an error: a schema may describe more than we can enforce, and
// failing a call over a keyword is worse than enforcing the rest.
//
// SINGLE-PROPERTY RULE (see ./tool.ts) is the subtle part:
//
//   - the MODEL is shown a schema, so it sends the wrapper object
//     (`{ "paths": ["a.txt"] }`) and `execute` must still receive the unwrapped
//     value (`["a.txt"]`);
//   - a DIRECT caller (host code, a test, the server's manual tool path) has
//     always passed the unwrapped value (`fileRead(['a.txt'])`).
//
// `resolveToolParameters` applies BOTH without breaking the legacy form: it
// validates the unwrapped value first and, when that fails, re-wraps the object
// under the single property and validates the wrapper. So a direct call keeps
// working and is still checked, and the model path always unwraps.
//
// COST/RISK: validation walks the parsed arguments once, in memory, depth-capped
// (MAX_VALIDATION_DEPTH). It does not protect against a hostile SCHEMA — that is
// `checkToolSchemaComplexity`, which gates the schemas a model creates. Schemas
// that ship with the package (presets, core tools) are trusted code.
//
// Cross-references:
//   - ./tool.ts       — toolParameterKey, the single-property rule
//   - ./creation.ts   — gates a created tool's schema complexity
//   - ../harness.ts   — model path and the manual executeTool path both call here

import { HarnessError } from '../util';
import { utf8ByteLength } from './result-budget';
import { toolParameterKey } from './tool';

// Bounds on a MODEL-CREATED schema. A created tool's schema becomes part of the
// request payload on every turn, and a deeply nested or enormous schema is a
// context bomb as well as a validation cost. These limits are generous enough
// for the project's own schemas (fileRead's `oneOf` item schema nests ~7 levels)
// and small enough that a pathological one is rejected at creation.
//
// DEPTH counts container nesting (objects AND arrays); NODES counts every nested
// object and array anywhere in the value (see checkToolSchemaComplexity); BYTES is
// the UTF-8 length of the serialized schema, which is the only bound that catches
// one enormous scalar `description`/`enum` string. 16 KiB is ~8x the largest
// shipped schema, so every legitimate hand-authored schema fits with room to spare.
export const MAX_CREATED_SCHEMA_DEPTH = 12;
export const MAX_CREATED_SCHEMA_NODES = 256;
export const MAX_CREATED_SCHEMA_BYTES = 16 * 1024;

// The walker's own guard: a value can only be as deep as its schema, and every
// schema reaching validation has already been depth-gated (created ones here,
// bundled ones by their authors). This keeps a malformed hand-built schema from
// recursing without bound.
const MAX_VALIDATION_DEPTH = 24;

// Ok/changed result shape. Messages are complete sentences with a JSON path, so
// the harness can prefix them with the tool name and hand the text to the model.
export type SchemaCheck = { valid: true } | { valid: false; message: string };

const VALID: SchemaCheck = { valid: true };

const invalid = (message: string): SchemaCheck => ({ valid: false, message });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// The JSON type of a runtime value, as a schema would spell it.
const jsonTypeOf = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';

    const type = typeof value;
    if (type === 'object') return 'object';
    if (type === 'string' || type === 'boolean' || type === 'number') return type;

    // undefined, function, symbol, bigint: not representable in JSON at all.
    return 'invalid';
};

const matchesType = (value: unknown, type: string): boolean => {
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return jsonTypeOf(value) === type;
};

// Scalar/structural equality via the JSON encoding. Enum values in this project
// are strings, but this stays correct for the object/array enums JSON allows.
const jsonEqual = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

const childPath = (path: string, key: string): string => `${path}.${key}`;

// Validate one value against one schema node. `path` is the JSON path used in
// messages ($, $.paths, $.paths[0].path), so a model can locate the mistake.
export const validateSchemaValue = (
    schema: unknown,
    value: unknown,
    path = '$',
    depth = 0
): SchemaCheck => {
    if (!isPlainObject(schema)) return VALID;

    if (depth > MAX_VALIDATION_DEPTH) {
        return invalid(`${path} cannot be validated: the schema nests too deeply.`);
    }

    // `type` may be a single name or a list of alternatives.
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const names = types.filter((entry): entry is string => typeof entry === 'string');

        if (names.length > 0 && !names.some((name) => matchesType(value, name))) {
            return invalid(`${path} must be of type ${names.join(' or ')}.`);
        }
    }

    // `enum` is exact membership.
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(entry, value))) {
        return invalid(`${path} must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`);
    }

    // `oneOf`: exactly one branch must accept the value. A value that matches
    // none is as wrong as one that matches two (an ambiguous schema).
    if (Array.isArray(schema.oneOf)) {
        const matched = schema.oneOf.filter((branch) => validateSchemaValue(branch, value, path, depth + 1).valid);

        if (matched.length !== 1) {
            return invalid(`${path} must match exactly one of the allowed shapes (matched ${matched.length}).`);
        }
    }

    // Numeric limits.
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            return invalid(`${path} must be >= ${schema.minimum}.`);
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            return invalid(`${path} must be <= ${schema.maximum}.`);
        }
    }

    // String limits.
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            return invalid(`${path} must be at least ${schema.minLength} characters.`);
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            return invalid(`${path} must be at most ${schema.maxLength} characters.`);
        }
    }

    // Array item limits and the item schema.
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            return invalid(`${path} must contain at least ${schema.minItems} items.`);
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            return invalid(`${path} must contain at most ${schema.maxItems} items.`);
        }

        if (schema.items !== undefined) {
            for (let index = 0; index < value.length; index++) {
                const check = validateSchemaValue(schema.items, value[index], `${path}[${index}]`, depth + 1);
                if (!check.valid) return check;
            }
        }
    }

    // Object properties, required set, and additionalProperties: false.
    if (isPlainObject(value)) {
        const properties = isPlainObject(schema.properties) ? schema.properties : undefined;

        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (typeof key !== 'string') continue;
                if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
                    return invalid(`${childPath(path, key)} is required.`);
                }
            }
        }

        if (properties) {
            // Only properties the caller actually sent are checked: an omitted
            // optional property is absence, not an undefined value.
            for (const [key, propertySchema] of Object.entries(properties)) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                if (value[key] === undefined) continue;

                const check = validateSchemaValue(propertySchema, value[key], childPath(path, key), depth + 1);
                if (!check.valid) return check;
            }
        }

        if (schema.additionalProperties === false) {
            const known = new Set(properties ? Object.keys(properties) : []);

            for (const key of Object.keys(value)) {
                if (known.has(key)) continue;
                return invalid(`${path} must not include the additional property "${key}".`);
            }
        }
    }

    return VALID;
};

// Walk a COMPLETE schema value, rejecting one that is too deep, too large, or
// self-referential. Only used for MODEL-CREATED schemas: bundled schemas are
// authored code and are trusted.
//
// WHAT THIS IS (and is not): a TRAVERSAL LIMIT, not schema validation. It counts
// every nested object and array wherever it appears — `properties`, `items`,
// `oneOf`, but equally `$defs`, `definitions`, `patternProperties`,
// `dependentSchemas`, `propertyNames`, or a keyword nobody has implemented yet —
// so no nested object can reach the model's request payload without being counted.
// The earlier keyword-only walk missed exactly those containers: 400 objects under
// `$defs`/`patternProperties` passed the 256-node cap and were then re-sent on
// every request. Unknown keywords remain unsupported by `validateSchemaValue`;
// this function only says "the value is small enough to ship".
//
// THREE BOUNDS, because they fail differently:
//   - DEPTH: a hand-built or generated schema can nest without end;
//   - NODES (objects + arrays): the context-growth cost of the JSON itself;
//   - BYTES of the serialized schema: one enormous scalar `description` or
//     `enum` string is ONE node, so a node count alone cannot see it. JSON
//     escaping is measured too (the wire cost is the escaped form).
//
// CYCLES: JSON cannot express one, but a HOST can hand a live object to
// `createDynamicTool`/`createTool`. `JSON.stringify` would throw an unhelpful
// TypeError and a traversal would recurse forever, so cycles are detected first
// (ancestor set, so a shared non-cyclic subtree is not mistaken for a cycle).
export const checkToolSchemaComplexity = (
    schema: unknown,
    limits: { maxDepth?: number; maxNodes?: number; maxBytes?: number } = {}
): SchemaCheck => {
    const maxDepth = limits.maxDepth ?? MAX_CREATED_SCHEMA_DEPTH;
    const maxNodes = limits.maxNodes ?? MAX_CREATED_SCHEMA_NODES;
    const maxBytes = limits.maxBytes ?? MAX_CREATED_SCHEMA_BYTES;

    const counter = { nodes: 0 };
    // Ancestors only: add before recursing, delete after, so two sibling branches
    // may legally reference one shared object.
    const ancestors = new WeakSet<object>();

    const walk = (node: unknown, depth: number): SchemaCheck => {
        // Scalars are leaves: their SIZE is covered by the byte cap below.
        if (typeof node !== 'object' || node === null) return VALID;

        counter.nodes++;
        if (counter.nodes > maxNodes) return invalid(`have more than ${maxNodes} schema nodes`);
        if (depth > maxDepth) return invalid(`are nested deeper than ${maxDepth} levels`);

        if (ancestors.has(node)) return invalid('contain a reference cycle');
        ancestors.add(node);

        try {
            // Arrays are containers too: `enum`, `required`, `oneOf`, and any
            // unknown keyword list all count and all nest.
            const children = Array.isArray(node) ? node : Object.values(node);

            for (const child of children) {
                const check = walk(child, depth + 1);
                if (!check.valid) return check;
            }

            return VALID;
        } finally {
            ancestors.delete(node);
        }
    };

    const shape = walk(schema, 0);
    if (!shape.valid) return shape;

    // Serialized size. `JSON.stringify` cannot throw here: cycles were rejected
    // above, and every remaining value is a JSON-compatible node. A non-JSON value
    // (a function property) stringifies to `{}`/omitted, which under-counts rather
    // than failing a request for something the transport cannot even send.
    let serialized: string;
    try {
        serialized = JSON.stringify(schema) ?? '';
    } catch {
        // Defensive: a value JSON rejects (BigInt) is not a usable schema either.
        return invalid('are not JSON-serialisable');
    }

    const bytes = utf8ByteLength(serialized);
    if (bytes > maxBytes) return invalid(`are larger than ${maxBytes} serialized bytes`);

    return VALID;
};

// How the arguments arrived. 'model' is the wire path (a JSON string parsed into
// the schema's wrapper object); 'direct' is a host/direct call that may already
// carry the unwrapped value.
export type ToolArgumentMode = 'model' | 'direct';

const assertValid = (schema: unknown, value: unknown, path: string): void => {
    const check = validateSchemaValue(schema, value, path);
    if (!check.valid) throw new HarnessError(check.message);
};

// Resolve the value `execute({ parameters })` receives, validating it on the way.
//
// Throws HarnessError when the arguments do not match the schema; the harness
// turns that into a recoverable tool result for the model.
export const resolveToolParameters = (
    schema: Record<string, unknown> | undefined,
    raw: unknown,
    mode: ToolArgumentMode
): unknown => {
    // No schema: nothing to unwrap and nothing to check (a created tool may omit
    // `parameters` entirely, and so may a hand-written tool).
    if (!isPlainObject(schema)) return raw;

    const key = toolParameterKey(schema);
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined;

    // Multi-property (or schema-less-shaped) tool: the arguments ARE the value,
    // so validate the object itself. This is the syntaxCheck/toolRequest path.
    if (key === undefined || properties === undefined) {
        const check = validateSchemaValue(schema, raw, '$');

        if (!check.valid && mode === 'direct' && !isPlainObject(raw)) {
            // LEGACY DIRECT FORM of a multi-property tool. fileList's documented
            // direct call is the bare directory value (`fileList(['src'])`), which
            // predates the paged object schema and is still accepted by its
            // implementation. Wrap it under the ONE property whose schema accepts it
            // and validate the wrapper: an ambiguous value (a number that could be
            // `offset` or `limit`) is NOT guessed — it keeps the original error.
            const matches = Object.entries(properties ?? {}).filter(
                ([, propertySchema]) => validateSchemaValue(propertySchema, raw, '$.legacy').valid
            );

            if (matches.length === 1) {
                const [property] = matches[0];
                assertValid(schema, { [property]: raw }, '$');
                return raw;
            }
        }

        if (!check.valid) throw new HarnessError(check.message);

        return raw;
    }

    const propertySchema = properties[key];
    const propertyPath = childPath('$', key);

    // MODEL path. A model is shown the schema, so an object is the wrapper: it is
    // validated AS the wrapper and then unwrapped. A non-object is tolerated as
    // the bare value (a model that answered with just the value), which keeps a
    // call the tool can serve from failing over protocol pedantry.
    if (mode === 'model') {
        if (isPlainObject(raw)) {
            assertValid(schema, raw, '$');
            return raw[key];
        }

        assertValid(propertySchema, raw, propertyPath);
        return raw;
    }

    // DIRECT path. The legacy form is the unwrapped value, so it is tried first
    // and validated as the property. Only when that fails do we treat the value as
    // the schema wrapper (plus validation of the wrapper), which is what makes
    // `executeTool('fileRead', { paths: ['a'] })` and
    // `executeTool('fileRead', ['a'])` behave identically.

    // An EMPTY object is the "nothing filled in" argument box, not a value: both a
    // model and the HTTP UI send `{}` for a call with no arguments, and the
    // documented default (fileList `paths: ["."]`) must apply. `execute` receives
    // the single property's value (undefined), which every implementation treats as
    // "use the default" and reports a specific error for when it cannot.
    //
    // The wrapper is NOT re-validated here on purpose: `required` describes what a
    // caller must supply, and an empty box is exactly the case where the tool's own
    // message ("timeNow timezone must be …") is more useful than "$.timezone is
    // required." — the model path still enforces `required` on a non-empty object.
    if (isPlainObject(raw) && Object.keys(raw).length === 0) return raw[key];

    const unwrapped = validateSchemaValue(propertySchema, raw, propertyPath);
    if (unwrapped.valid) return raw;

    if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, key)) {
        const wrapped = validateSchemaValue(schema, raw, '$');
        if (wrapped.valid) return raw[key];
        throw new HarnessError(wrapped.message);
    }

    throw new HarnessError(unwrapped.message);
};
