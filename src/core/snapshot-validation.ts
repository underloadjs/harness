// Shared validators for restoring persisted core state.
//
// The snapshot API (see ./snapshot.ts and ../harness.ts) is the inverse of a
// save: JSON read back from disk is UNTRUSTED input even when this process wrote
// it earlier. Every field is therefore checked here before a store or an agent is
// touched, so a corrupt file produces one HarnessError instead of a half-applied
// session.
//
// Rules these helpers enforce:
//   - records are plain objects with exactly the keys the current schema knows
//     (an unknown key is rejected rather than silently dropped);
//   - strings have explicit minimum/maximum lengths;
//   - integers are finite safe integers, never NaN/Infinity/fractions;
//   - ids are the decimal strings this package generates ("1", "2", ...), unique
//     within their store, and every `nextId` is greater than the largest id it
//     could collide with;
//   - JSON values may not contain functions, undefined, symbols, bigints, or
//     non-finite numbers: a snapshot must survive JSON.parse(JSON.stringify(...)).
//
// Cross-references:
//   - ./todo.ts, profile.ts, chapter.ts, location.ts — per-store state readers
//   - ./snapshot.ts                                — the harness-wide reader
//   - ../types                                     — store state shapes
//   - ../util                                      — HarnessError

import { HarnessError } from '../util';

// A JSON object. Arrays are rejected: a JSON array is valid data but never a
// record, and accepting it would hide a schema mismatch behind an arbitrary key
// lookup.
export const isSnapshotRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const readSnapshotRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!isSnapshotRecord(value)) {
        throw new HarnessError(`${label} must be a JSON object.`);
    }

    return value;
};

export const readSnapshotArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) {
        throw new HarnessError(`${label} must be an array.`);
    }

    return value;
};

export const readSnapshotString = (
    value: unknown,
    label: string,
    options: { min?: number; max?: number } = {}
): string => {
    if (typeof value !== 'string') {
        throw new HarnessError(`${label} must be a string.`);
    }

    const min = options.min ?? 0;
    const max = options.max ?? Number.POSITIVE_INFINITY;

    if (value.length < min) {
        throw new HarnessError(`${label} must be at least ${min} characters.`);
    }

    if (value.length > max) {
        throw new HarnessError(`${label} must be at most ${max} characters.`);
    }

    return value;
};

export const readSnapshotBoolean = (value: unknown, label: string): boolean => {
    if (typeof value !== 'boolean') {
        throw new HarnessError(`${label} must be a boolean.`);
    }

    return value;
};

export const readSnapshotInteger = (
    value: unknown,
    label: string,
    options: { min?: number; max?: number } = {}
): number => {
    if (!Number.isSafeInteger(value)) {
        throw new HarnessError(`${label} must be a safe integer.`);
    }

    const integer = value as number;
    const min = options.min ?? Number.NEGATIVE_INFINITY;
    const max = options.max ?? Number.POSITIVE_INFINITY;

    if (integer < min || integer > max) {
        throw new HarnessError(`${label} must be between ${min} and ${max}.`);
    }

    return integer;
};

// Exact-key check. A current schema has a fixed shape, so a missing key would
// silently default and an extra key would silently disappear on the next save.
// Both are data loss, so both are errors. `optional` names may be absent (a
// chapter's `order` is genuinely optional), but are still the only other keys
// permitted.
export const readSnapshotKeys = (
    record: Record<string, unknown>,
    allowed: readonly string[],
    label: string,
    optional: readonly string[] = []
): void => {
    const permitted = new Set(allowed);
    const mayBeAbsent = new Set(optional);

    for (const key of Object.keys(record)) {
        if (!permitted.has(key)) {
            throw new HarnessError(`${label} has an unknown field "${key}".`);
        }
    }

    for (const key of allowed) {
        if (mayBeAbsent.has(key)) continue;

        if (!Object.prototype.hasOwnProperty.call(record, key)) {
            throw new HarnessError(`${label} is missing the field "${key}".`);
        }
    }
};

// A store id: the decimal strings factories emit (String(nextId)). Leading zeros,
// signs, fractions, and non-safe magnitudes are rejected so an id always maps
// exactly back to the counter that produced it.
export const readSnapshotId = (value: unknown, label: string): string => {
    const id = readSnapshotString(value, label, { min: 1 });

    if (!/^[1-9][0-9]*$/.test(id)) {
        throw new HarnessError(`${label} must be a positive decimal id.`);
    }

    if (!Number.isSafeInteger(Number(id))) {
        throw new HarnessError(`${label} is larger than a safe integer.`);
    }

    return id;
};

// Validate a store's id list and its next counter together: ids must be unique,
// and nextId must be strictly greater than the largest id (otherwise a later
// `add` would reuse an id that is already in the restored list).
export const readSnapshotIdCounter = (
    ids: readonly string[],
    nextIdValue: unknown,
    label: string
): number => {
    const seen = new Set<string>();

    for (const id of ids) {
        if (seen.has(id)) {
            throw new HarnessError(`${label} contains the duplicate id "${id}".`);
        }

        seen.add(id);
    }

    const nextId = readSnapshotInteger(nextIdValue, `${label}.nextId`, { min: 1 });
    const largest = ids.reduce((max, id) => Math.max(max, Number(id)), 0);

    if (nextId <= largest) {
        throw new HarnessError(
            `${label}.nextId must be greater than the largest id (${largest}); received ${nextId}.`
        );
    }

    return nextId;
};

// Deep-copy one JSON value while rejecting anything that is not JSON. Used for a
// created tool's `parameters`: a function or undefined nested in a schema would
// otherwise vanish on the next save, which is exactly the silent data loss this
// API must not have.
//
// `depth` bounds recursion so a hostile file cannot overflow the stack before a
// schema-complexity check gets a chance to reject it. 64 levels is far beyond any
// schema this package accepts (MAX_CREATED_SCHEMA_DEPTH is smaller).
const MAX_JSON_DEPTH = 64;

export const readSnapshotJsonValue = (value: unknown, label: string, depth = 0): unknown => {
    if (depth > MAX_JSON_DEPTH) {
        throw new HarnessError(`${label} is nested too deeply.`);
    }

    if (value === null) return null;

    const type = typeof value;

    if (type === 'string' || type === 'boolean') return value;

    if (type === 'number') {
        if (!Number.isFinite(value)) {
            throw new HarnessError(`${label} contains a non-finite number.`);
        }

        return value;
    }

    if (type !== 'object') {
        throw new HarnessError(`${label} contains a non-JSON ${type}.`);
    }

    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            readSnapshotJsonValue(entry, `${label}[${index}]`, depth + 1)
        );
    }

    const record = readSnapshotRecord(value, label);
    const copy: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(record)) {
        copy[key] = readSnapshotJsonValue(entry, `${label}.${key}`, depth + 1);
    }

    return copy;
};
