// Canonical tool-argument fingerprinting — progressive-compaction T2.1 (the helper) and
// T2.2 (the match key). See ../docs/tasks/2026-11-09-progressive-compaction.md.
//
// WHY THIS EXISTS
// ---------------
// A pruning policy has to answer one question about two committed tool calls: "did the
// later unit already do THIS work?" Nothing in the transcript makes that answerable
// today:
//   - the call id can never be the anchor. Ids must be unique across the WHOLE
//     conversation, and a turn that reuses one is rejected before anything executes
//     (../harness.ts:5822-5857 `assertToolCallIds`, enforced at :8173) — so a retry
//     always arrives with a different id;
//   - `arguments` is stored verbatim as the raw JSON text the model produced
//     (../types/index.ts:100-112), and JSON has no canonical byte order: `{"a":1,"b":2}`
//     and `{"b":2,"a":1}` are the same call and two different strings.
// So "the same call" is today unexpressible, and a plain string compare of the raw text
// is not a signal (R4 of the entry: a decision must be justified by structure). This
// module produces the value that IS comparable.
//
// THE CONTRACT
// ------------
//   argumentFingerprint(raw) — one canonical string per argument VALUE:
//     - a JSON OBJECT is re-serialized with every object's keys sorted, at every depth,
//       and with insignificant whitespace gone;
//     - ARRAY ORDER IS PRESERVED (position is data to the tool), but objects inside an
//       array are sorted like any other object;
//     - malformed JSON, and valid-but-NON-OBJECT JSON (`null`, `[1,2]`, `42`, `"s"`,
//       `true`, the empty string), fall back to the TRIMMED RAW TEXT. That mirrors two
//       existing stances instead of inventing a third: `wireArguments` repairs only a
//       non-object and never rewrites the transcript
//       (../transport/openai.ts:271-285), and the snapshot reader keeps raw text because
//       "malformed arguments are a replayable fact" (./snapshot.ts:76-79).
//   toolCallFingerprint(name, args) — `name` + NUL + the argument fingerprint. This is
//     the key a policy groups by: name and fingerprint only, never the id (T2.2). The
//     name is part of the key because `read({"path":"a"})` and `write({"path":"a"})` are
//     different jobs.
//
// 'Fingerprint' here means a canonical, comparable identity — NOT a digest. Nothing is
// hashed, so a diagnostic can print the key and an operator can read which call it names
// (T4.5 requires exactly that).
//
// TOTALITY: neither function throws, whatever a restored or hostile transcript holds in
// `arguments`. Both run at a turn boundary where a throw would fail the turn for
// nothing — the same rule the estimator states for the same reason
// (./context-estimate.ts:36-38).
//
// THE TWO EDGES, DECIDED HERE (T2.4)
// ----------------------------------
//   1. A call whose ARGUMENTS were cut off mid-generation is not repaired. The result
//      budget bounds a tool RESULT and never touches a call (./result-budget.ts:16-19),
//      but a generation stopped at the output-token ceiling can end inside the argument
//      text, and `core/agent.ts` commits exactly what arrived
//      (../transport/openai.ts:255-267). Such a half-written call parses as nothing, so
//      it fingerprints as its own raw text and a later, complete call with the intended
//      arguments does NOT resolve it. The failure stays visible — the conservative
//      direction, and the honest one: the two calls did not carry the same recorded work.
//   2. EXACT match only. A same-name call whose arguments differ in a counter — `read` at
//      another `offset`, a paged `threadRead` — is a DIFFERENT job and gets a DIFFERENT
//      fingerprint. A prefix or normalization heuristic is explicitly out (the entry's
//      "Open decisions" item 4): it would fold two different reads into one key and prune
//      a call that was never answered.
//
// WHAT THIS MODULE DOES NOT DECIDE
// --------------------------------
// The outcome half. Whether a fingerprint match actually resolves a candidate depends on
// `HarnessToolOutcome` — `completed` resolves an earlier `failed`/`rejected`, never a
// `cancelled`, and a `completed` unit is never itself a prune candidate
// (../types/index.ts:234-251). That is the T3 policy's call; importing the outcome here
// would put policy in a data helper. The resolution matrix is pinned as a table in
// ./argument-fingerprint.test.ts so the rule at least has one executable home.
//
// Cross-references:
//   - ../types/index.ts:100-112                          HarnessToolCall (id, name, arguments)
//   - ../types/index.ts:234-251                          HarnessToolOutcome
//   - ../harness.ts:5822-5857, :8173                     assertToolCallIds — why ids differ per retry
//   - ../transport/openai.ts:255-285                     wireArguments — the non-object honesty mirrored here
//   - ./snapshot.ts:68-81                                readToolCalls — raw arguments are kept on restore
//   - ./context-estimate.ts:36-38                        the totality precedent
//   - ./result-budget.ts:16-19                           budgeting bounds results, not calls
//   - ../docs/tasks/2026-11-09-progressive-compaction.md T2 (this task), T3 (the policy that consumes it)

// The boundary between the name and the argument text inside a call fingerprint. NUL
// cannot appear in a registry tool name (names are matched literally), so the split point
// can never be forged by argument content — `('a', 'b')` and `('a\u0000b', '')` cannot
// collide the way they would with a printable separator.
const FINGERPRINT_SEPARATOR = '\u0000';

// A JSON OBJECT LITERAL and nothing else. `null` and arrays are `typeof 'object'` too, and
// the wire guard excludes them the same way (../transport/openai.ts:275-279), so one
// predicate states the rule at both ends.
const isArgumentObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

// Rebuild a parsed JSON value so every object serializes with sorted keys.
//
// Key order is `Array.prototype.sort()`'s default: ascending UTF-16 code units, so `'A'`
// precedes `'_'` precedes `'b'`. That order is total, locale-free and identical on every
// host — a `localeCompare` would let a machine's locale decide whether two transcripts
// show the same call.
//
// A fresh object literal is built rather than sorting keys in place: mutating the parse
// result would be visible to anyone else holding it, and property insertion order is
// observable through `Object.keys`.
const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        // Order is data: `[{"b":1,"a":2}]` and `[{"a":2,"b":1}]` are different lists, so
        // the elements keep their positions while each object inside them is canonicalized.
        const items: unknown[] = [];
        for (const item of value) items.push(canonicalValue(item));

        return items;
    }

    if (isArgumentObject(value)) {
        const entry: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) entry[key] = canonicalValue(value[key]);

        return entry;
    }

    // Primitives (string, number, boolean, null) pass through. `JSON.parse` cannot produce
    // `undefined`, `NaN` or a cycle, so the stringify below can never throw or drop a key.
    return value;
};

/**
 * The canonical identity of one tool call's `arguments` text (T2.1).
 *
 * Deterministic and pure: the same input string always returns the same output string,
 * with no state, no locale and no I/O. Two spellings of one argument object
 * (`{"b":1,"a":2}` and `{ "a" : 2 , "b" : 1 }`) return the same value; two different
 * argument objects never do.
 *
 * @param raw The raw `HarnessToolCall.arguments` text, exactly as recorded — it may be
 *            malformed or non-object, and that is a fact to preserve, not an error.
 * @returns   Sorted-key compact JSON for an object; otherwise the trimmed raw text.
 */
export const argumentFingerprint = (raw: string): string => {
    // Typed `string`, but this runs over restored and pre-validation transcripts where the
    // reader kept whatever arrived. A non-string contributes empty text rather than
    // throwing at a turn boundary (see TOTALITY in the header).
    const text = typeof raw === 'string' ? raw : '';

    try {
        const parsed: unknown = JSON.parse(text);

        // Only an object has a key order to canonicalize. Anything else falls through to
        // the raw text below, so `[1, 2]` is never silently rewritten to `[1,2]`.
        if (isArgumentObject(parsed)) return JSON.stringify(canonicalValue(parsed));
    } catch {
        // Not JSON at all: fall through to the placeholder-free raw text.
    }

    // Whitespace is the only thing the fallback normalizes — trimming cannot change meaning,
    // while re-serializing a non-object would invent a call the model never sent.
    return text.trim();
};

/**
 * The match key for "the same work" (T2.2): tool name plus argument fingerprint.
 *
 * Group transcript tool calls by this value, never by their ids — `assertToolCallIds`
 * forbids id reuse, so a retry's id is always new (../harness.ts:5822-5857). A policy
 * then reads the pair of fingerprints; the outcome rules that turn a match into a prune
 * live in the policy (T3), not here.
 *
 * @param name The tool name as the model requested it.
 * @param args The raw `arguments` text for that request.
 * @returns    `name` + NUL + `argumentFingerprint(args)`.
 */
export const toolCallFingerprint = (name: string, args: string): string =>
    // Name side: template interpolation already stringifies a hostile non-string, which
    // keeps this total for free without a second defensive branch.
    `${name}${FINGERPRINT_SEPARATOR}${argumentFingerprint(args)}`;
