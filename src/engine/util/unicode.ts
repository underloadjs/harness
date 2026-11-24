// Surrogate-safe text handling — the leaf every cut and every wire write shares.
//
// WHY THIS MODULE EXISTS (2026-11-24, the lone-surrogate provider defect). JavaScript
// strings are UTF-16 code-unit sequences, so `slice(0, n)` is allowed to cut a
// surrogate PAIR in half and leave half of one behind. That half is a LONE SURROGATE:
// legal in a JS string, legal in JSON (it serializes as `\ud83d`), and REJECTED by the
// strict UTF-8 encoder on the other end of the wire. The measured failure was a stress
// run (295 tool calls, ~9.85M chars) whose provider requests died with
// `'utf-8' codec can't encode character '\ud83d' in position 643: surrogates not
// allowed` — a Python gateway that `json.loads` the body (which accepts the escape) and
// then `.encode('utf-8')` on it (which throws). One lone code unit anywhere in ~10 MB
// fails the WHOLE request, and every retry re-sends it, so the ladder cannot recover.
//
// TWO ROLES, matching the two halves of the defect:
//   1. PRODUCERS — every clipped text in the harness (compaction clips, result bounds,
//      previews, tool-output cuts) cuts by code unit. `pairSafeCut`/`clipPrefix` make
//      such a cut back off one unit instead of splitting a pair, and
//      `trimBrokenLeadSurrogate`/`trimBrokenTrailSurrogate` repair a slice that was
//      already taken at an arbitrary offset (a page window can START on the low half).
//   2. THE WIRE — models themselves emit lone surrogates (the `write` tool's `lossy`
//      flag documents it) and they are committed to history VERBATIM, so no producer
//      fix can ever be complete. `sanitizeWireBody` is therefore the guarantee at the
//      one place the requirement lives: the request body, immediately before it is
//      serialized. That is the same philosophy as `wireArguments`
//      (../transport/openai.ts:335-356) — "repair at the wire boundary, where the
//      provider's requirement lives, instead of rewriting the recorded history".
//
// WHY A LEAF: `util/` imports nothing (see ./index.ts), so core, transport, plugins,
// tools and harness can all depend on it without a cycle. Do not import anything here.
//
// WHAT IS *NOT* DONE HERE: nothing re-encodes whole documents into code points, because
// the offsets every paging tool reports (`nextOffset`, `resumeOffsetForCut`) are code
// UNIT offsets, and a rewrite that changed lengths would move them. Every helper below
// either preserves the string exactly or trims/escapes at a boundary the caller chose.

// The Unicode replacement character. Chosen over "drop the character" because a dropped
// character silently changes what the model asked for, while `\ufffd` is visible in the
// transcript and is what a lossy decoder writes everywhere else in this package (the
// `write` tool's lossy disclosure).
const REPLACEMENT_CHAR = '\ufffd';

// The two halves of a UTF-16 surrogate pair, as code-unit ranges. A "high" (lead)
// surrogate is 0xD800-0xDBFF and must be immediately followed by a "low" (trail)
// surrogate, 0xDC00-0xDFFF; anything else is unpaired.
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

// Is `code` a lead (high) surrogate code unit? `charCodeAt` answers `NaN` outside the
// string, and every comparison with `NaN` is false, so callers may probe one unit past
// the end (or one before the start) without a bounds check.
export const isHighSurrogateCode = (code: number): boolean =>
    code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;

// Is `code` a trail (low) surrogate code unit?
export const isLowSurrogateCode = (code: number): boolean =>
    code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;

// How many LONE surrogates `value` holds — unpaired high halves plus unpaired low
// halves, counted as code units. A valid pair contributes 0. This is the number a test
// asserts to prove a string (or a re-parsed body) is wire-safe, and the number the
// transport logs: never the characters themselves, which would put transcript text on
// an operator line.
//
// The scan is single-pass and left-to-right: when a high half is followed by a low
// half, the low half is CONSUMED with it (so the low half can never be miscounted as
// lone), and any low half reached on its own has no high half in front of it — i.e. it
// is genuinely lone.
export const countLoneSurrogates = (value: string): number => {
    let count = 0;

    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);

        if (isHighSurrogateCode(code)) {
            if (isLowSurrogateCode(value.charCodeAt(index + 1))) index++;
            else count++;
        } else if (isLowSurrogateCode(code)) {
            count++;
        }
    }

    return count;
};

// Does `value` hold at least one lone surrogate? The hot-path form of the counter above:
// it stops at the FIRST unpaired unit, so a clean string costs one scan and nothing
// else. This is what the wire walk asks of every string in the body, which is what
// makes sanitizing a clean body free (no new string is ever built).
export const hasLoneSurrogate = (value: string): boolean => {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);

        if (isHighSurrogateCode(code)) {
            if (!isLowSurrogateCode(value.charCodeAt(index + 1))) return true;
            index++;
        } else if (isLowSurrogateCode(code)) {
            return true;
        }
    }

    return false;
};

// Replace every lone surrogate in `value` with U+FFFD, leaving valid pairs intact.
//
// THE NO-OP CONTRACT, which is what makes this safe on the send path: a clean string is
// returned as THE SAME REFERENCE, so an in-place writer can detect "nothing changed" by
// comparing references and touch no key at all. That is how a byte-identical serialized
// body is guaranteed — `JSON.stringify` of the untouched object is literally the same
// call it always was.
export const sanitizeLoneSurrogates = (value: string): string => {
    if (!hasLoneSurrogate(value)) return value;

    let output = '';
    // The dirty path only, so correctness and clarity outrank throughput here. The
    // loop mirrors the counter's pairing rule so a valid pair survives byte for byte.
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);

        if (isHighSurrogateCode(code)) {
            if (isLowSurrogateCode(value.charCodeAt(index + 1))) {
                // A complete pair: both units, unchanged.
                output += value[index] + value[index + 1];
                index++;
            } else {
                output += REPLACEMENT_CHAR;
            }
            continue;
        }

        if (isLowSurrogateCode(code)) {
            output += REPLACEMENT_CHAR;
            continue;
        }

        output += value[index];
    }

    return output;
};

// Where a cut may actually land, backing off ONE code unit when `index` would separate
// a high half from its low half. Clamped into `[0, value.length]`, so an over-large or
// negative budget is a whole-string or empty cut rather than a range error.
//
// BACKING OFF (never skipping forward) is the right direction for a PREFIX cut: the
// text before the cut stays byte-identical, which is what every clip marker in this
// package promises the reader. The one unit lost is a character the budget did not fit
// anyway; the one thing that must not happen is a clipped string ending on half of an
// emoji.
export const pairSafeCut = (value: string, index: number): number => {
    // `NaN` is the only non-finite input that has no sensible clamp; `±Infinity` clamp
    // through `Math.floor`/`Math.min` to "the whole string" and "nothing", which is what
    // the callers that pass `Number.POSITIVE_INFINITY` for "no bound" mean (see
    // `boundedFlagged` in ../tools/websearch/request.ts).
    if (Number.isNaN(index)) return 0;

    const at = Math.min(Math.max(0, Math.floor(index)), value.length);

    // The boundary between `at - 1` and `at` is inside a pair exactly when a high half
    // sits before it and its low half sits after it.
    if (
        at > 0 &&
        at < value.length &&
        isHighSurrogateCode(value.charCodeAt(at - 1)) &&
        isLowSurrogateCode(value.charCodeAt(at))
    ) {
        return at - 1;
    }

    return at;
};

// The first `budget` code units of `value`, cut so a surrogate pair is never split.
// Drop-in for `value.slice(0, budget)` at every clip site: identical output whenever the
// cut does not land inside a pair, one unit shorter when it does.
export const clipPrefix = (value: string, budget: number): string =>
    value.slice(0, pairSafeCut(value, budget));

// Drop a LONELY TRAILING HIGH HALF left by a slice taken at an arbitrary end offset.
// Same reference when there is nothing to trim. (Every producer that clips through
// `clipPrefix` no longer needs this; it stays for a slice the caller had already taken.)
export const trimBrokenTrailSurrogate = (value: string): string => {
    if (value.length === 0) return value;

    return isHighSurrogateCode(value.charCodeAt(value.length - 1)) ? value.slice(0, -1) : value;
};

// Drop a LONELY LEADING LOW HALF left by a slice taken at an arbitrary START offset —
// the paging case a trailing trim can never see. A window that begins at a code unit in
// the middle of a pair begins WITH a lone low surrogate, which serializes as `\udc00`
// and kills the request exactly like a broken tail does.
//
// TRIMMING (rather than backing the offset up one unit) is deliberate: every caller here
// reports the offset it started at and the offset the next window resumes at, so the
// page text may lose the orphan half while the offsets stay exactly as computed.
export const trimBrokenLeadSurrogate = (value: string): string => {
    if (value.length === 0) return value;

    return isLowSurrogateCode(value.charCodeAt(0)) ? value.slice(1) : value;
};

// What a wire walk reports: the value the caller should serialize, and how many lone
// surrogates it replaced. `value` is the SAME REFERENCE whenever the input is an object
// (the walk mutates in place); it differs from the argument only when the argument was
// itself a dirty string, which cannot be mutated.
export type WireSanitizeResult<T> = {
    value: T;
    replaced: number;
};

// How many lone surrogates a whole VALUE holds — every string at any depth of a plain
// object or array, plus the value itself when it is a string. The read-only twin of
// `sanitizeWireBody`, and the assertion tool for the wire contract: re-parse the
// serialized body and count, and "0" is the proof the provider can encode it.
//
// It walks the same shape the sanitizer walks (strings, arrays, own enumerable string
// keys), and it assumes an ACYCLIC value — which is what a `JSON.parse` result always
// is. The send path never calls it: the sanitizer already counts what it replaced, and
// a cyclic host body is the sanitizer's problem to survive, not this counter's.
export const countWireLoneSurrogates = (value: unknown): number => {
    if (typeof value === 'string') return countLoneSurrogates(value);
    if (value === null || typeof value !== 'object') return 0;

    let total = 0;

    if (Array.isArray(value)) {
        for (const child of value) total += countWireLoneSurrogates(child);

        return total;
    }

    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record)) {
        total += countWireLoneSurrogates(record[key]);
    }

    return total;
};

// THE WIRE GUARANTEE: walk a request body and replace every lone surrogate in every
// string it holds, so no request this package sends can carry one.
//
// WHY IN PLACE. The body is built fresh for every attempt (`transportBody` →
// `buildBody`), so mutating it costs nothing and avoids copying a ~10 MB transcript per
// request. Keys are only ever RE-ASSIGNED, never added, deleted, or reordered, and a
// clean string is never assigned at all (see `sanitizeLoneSurrogates`), so a clean body
// serializes BYTE-IDENTICALLY to the unsanitized one. The one visible consequence is on
// a host that hands the transport a body it keeps a reference to (a `buildBody` that
// returns a shared object, or a nested value from `provider.extraBody`): a dirty string
// inside it is repaired for that host too, permanently. That is the intended trade —
// the alternative is a second multi-megabyte copy of every request.
//
// WHAT THE WALK TOUCHES: strings, arrays, and the OWN ENUMERABLE string keys of objects
// — exactly the set `JSON.stringify` would emit, so the walk cannot sanitize something
// the wire never sees or miss something it does. A `Map`/`Set`/`Date` has no own
// enumerable string keys, and `JSON.stringify` renders those as `{}` (a Date via
// `toJSON`, whose output is always clean), so nothing is skipped in practice.
//
// WHAT THE WALK CANNOT DO: repair a string that only EXISTS at serialization time — a
// `toJSON` result, or a getter's value read by the serializer. Such a value is a host
// construction, and a lone surrogate in it is reported by the provider rather than
// silently rewritten here.
//
// NEVER THROWS. A hostile host body can refuse the walk (a throwing property getter, a
// frozen object that rejects the write, a `getOwnPropertyNames` trap). Swallowing keeps
// the pre-existing `JSON.stringify` gate the single authority on a body that cannot go
// out — sanitizing must not become a new failure mode on the send path, and a frozen
// body that could not be repaired still fails upstream exactly as it did before.
export const sanitizeWireBody = <T>(body: T): WireSanitizeResult<T> => {
    const state = { replaced: 0 };

    try {
        if (typeof body === 'string') {
            // The one arm that cannot mutate, so it answers with the repaired value.
            const clean = sanitizeLoneSurrogates(body);
            if (clean !== body) state.replaced = countLoneSurrogates(body);

            return { value: clean as unknown as T, replaced: state.replaced };
        }

        if (body !== null && typeof body === 'object') {
            // `seen` breaks a cycle. Without it a cyclic body (which the stringify gate
            // below already turns into an honest error frame) would spin this walk forever
            // — a hang where the old code had an error. A shared subtree visited twice is
            // skipped the second time, which is free and correct: it was repaired in place
            // on the first visit.
            sanitizeWireChildren(body, new Set<object>(), state);
        }
    } catch {
        // Best effort: `state.replaced` keeps whatever was already repaired.
    }

    return { value: body, replaced: state.replaced };
};

// One container's children, repaired in place. Split out so the array and object arms
// each read as one rule: a string child is replaced, an object child recurses.
const sanitizeWireChildren = (
    container: object,
    seen: Set<object>,
    state: { replaced: number }
): void => {
    if (seen.has(container)) return;
    seen.add(container);

    // Repairs ONE string slot. The write is handed in rather than returned so the count
    // can FOLLOW it: `replaced` is a claim about what the wire will actually carry, and a
    // frozen or accessor-guarded slot can refuse the write (the outer catch in
    // `sanitizeWireBody` then ends the walk, and a refused slot is never counted).
    const repair = (child: string, write: (clean: string) => void): void => {
        const clean = sanitizeLoneSurrogates(child);
        if (clean === child) return;

        write(clean);
        state.replaced += countLoneSurrogates(child);
    };

    if (Array.isArray(container)) {
        const list = container as unknown[];

        for (let index = 0; index < list.length; index++) {
            const child = list[index];

            if (typeof child === 'string') {
                repair(child, (clean) => {
                    list[index] = clean;
                });
            } else if (child !== null && typeof child === 'object') {
                sanitizeWireChildren(child, seen, state);
            }
        }

        return;
    }

    const record = container as Record<string, unknown>;

    for (const key of Object.keys(record)) {
        const child = record[key];

        if (typeof child === 'string') {
            // Re-assignment of an EXISTING key: no key is added, dropped, or reordered,
            // so the serialized spelling of a body that needed no repair is untouched.
            repair(child, (clean) => {
                record[key] = clean;
            });
        } else if (child !== null && typeof child === 'object') {
            sanitizeWireChildren(child, seen, state);
        }
    }
};
