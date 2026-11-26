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
//   - ./task.ts, profile.ts, chapter.ts, location.ts — per-store state readers
//   - ./snapshot.ts                                — the harness-wide reader
//   - ../types                                     — store state shapes
//   - ../util                                      — HarnessError

import { HarnessError } from '../util';
// issue 0032 (2026-11-26): the tally validator below needs the SAME cap the writers enforce, and
// this leaf is the only place both the core reader and the lane fold can reach it. `./agent-limits`
// imports nothing, so this adds no cycle; the type import is erased at transpile.
import { TOOL_ACTIVITY_NAME_CAP } from './agent-limits';
import type { HarnessToolActivity } from '../types';

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

// Count/noun agreement for the length messages in `readSnapshotString` (report
// #17, same fix as ./schema-validation.ts `countNoun`): "at least 1 character" vs
// "at least 3 characters". Kept file-local for the same reason — the package has
// no shared plural helper to reuse. Call sites pass `min: 1` (ids and labels in
// ../core/snapshot.ts and ../core/records.ts), a larger bound, or no bound at all
// (`min` defaults to 0, which can never fire because a length is never negative),
// so only real counts reach the message; the surrounding text and labels are
// untouched.
const countNoun = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`;

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
        throw new HarnessError(`${label} must be at least ${countNoun(min, 'character')}.`);
    }

    if (value.length > max) {
        throw new HarnessError(`${label} must be at most ${countNoun(max, 'character')}.`);
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

// issue 0032 (2026-11-26) — THE ONE VALIDATOR FOR THE TOOL-ACTIVITY TALLY.
//
// WHY IT LIVES HERE AND NOT IN ../core/snapshot.ts. The same value is validated at THREE
// seams, and all three must accept EXACTLY the same payloads or a field is legal to write and
// illegal to read back: the snapshot reader (`./snapshot.ts`, reading a row off disk), the
// archive seam in core (`../harness.ts` `archiveInvocation`), and the lane fold
// (`../../server/workers/lane-commit.ts`).
// That is the same reason `readSnapshotString`/`readSnapshotInteger` are here: the bounds are
// the reader's, and every other door reuses them rather than re-deriving a looser copy — 0020
// lists coercion as a defect, so a wrong value is REFUSED at every door, never repaired.
//
// THE BOUNDS, and where each comes from:
//   * `calls`/`settled` are safe integers >= 0, and `settled` may never exceed `calls` — the
//     settled counter is only ever raised for a call this run scheduled, so an inversion is a
//     hand edit or a broken writer, not a fact;
//   * `truncated` is a boolean and is REQUIRED: the projection always states it, and a row that
//     omitted it would let a capped list read as a complete one (0032's AC2);
//   * `byName` is OPTIONAL (a run whose projection had no name data omits it, and 0032's AC6
//     makes absence the "nothing to say" signal), and when present it is NON-EMPTY and at most
//     `TOOL_ACTIVITY_NAME_CAP` entries — the cap the projection enforces is enforced on the way
//     back IN as well, or a hand-edited document could smuggle an unbounded row past retention;
//   * every name is 1..64 characters, the same ceiling the tool-name rule gives a live tool
//     (`../harness.ts`, "at most 64 characters"), which is what makes the whole payload bounded
//     on both axes (8 names x 64 characters plus two integers).
//
// KEY ORDER IS PART OF THE CONTRACT. The object is rebuilt as `calls, settled, byName?,
// truncated`, the order the writers project it in, because a snapshot's durability test is
// `restore -> snapshot` equality and a reordered key emits a different JSON string.
export const readSnapshotToolActivity = (value: unknown, label: string): HarnessToolActivity => {
    const record = readSnapshotRecord(value, label);
    // `allowed` is the PERMITTED set and `optional` is the may-be-absent subset of it (see
    // `readSnapshotKeys`: a key outside `allowed` is an unknown field, so `byName` has to appear
    // in both lists to be legal-but-optional rather than unknown).
    readSnapshotKeys(record, ['calls', 'settled', 'byName', 'truncated'], label, ['byName']);

    const calls = readSnapshotInteger(record.calls, `${label}.calls`, { min: 0 });
    const settled = readSnapshotInteger(record.settled, `${label}.settled`, { min: 0 });

    if (settled > calls) {
        throw new HarnessError(
            `${label}.settled (${settled}) cannot exceed ${label}.calls (${calls}); a settled call is by definition one that was registered.`
        );
    }

    const truncated = readSnapshotBoolean(record.truncated, `${label}.truncated`);

    if (record.byName === undefined) return { calls, settled, truncated };

    const entries = readSnapshotArray(record.byName, `${label}.byName`);

    if (entries.length === 0) {
        throw new HarnessError(
            `${label}.byName is empty; a tally with no tool names omits the key rather than listing none.`
        );
    }

    if (entries.length > TOOL_ACTIVITY_NAME_CAP) {
        throw new HarnessError(
            `${label}.byName contains ${entries.length} entries; at most ${TOOL_ACTIVITY_NAME_CAP} are recorded.`
        );
    }

    const byName = entries.map((entry, index) => {
        const entryLabel = `${label}.byName[${index}]`;
        const row = readSnapshotRecord(entry, entryLabel);
        readSnapshotKeys(row, ['name', 'calls'], entryLabel);

        return {
            name: readSnapshotString(row.name, `${entryLabel}.name`, { min: 1, max: 64 }),
            calls: readSnapshotInteger(row.calls, `${entryLabel}.calls`, { min: 1 })
        };
    });

    return { calls, settled, byName, truncated };
};
