// Canonical tool-argument fingerprinting (src/core/argument-fingerprint.ts) — progressive
// compaction T2.1/T2.2, from
// ../docs/tasks/2026-11-09-progressive-compaction.md.
//
// Every assertion is an exact expected string derived by hand from the input, because this
// value is a MATCH KEY: a pruning decision is only as good as the equality of two of them,
// so a silent change in key order, number formatting or fallback shape silently changes
// which transcript units stop being sent to the model.
//
// The contract under test, in one line each:
//   - a JSON object is re-serialized with sorted keys at every depth, whitespace-free;
//   - array ORDER survives (position is data), objects inside arrays are still sorted;
//   - malformed or non-object JSON keeps the TRIMMED RAW text — mirroring `wireArguments`
//     (../transport/openai.ts:271-285) and the snapshot reader's "malformed arguments are
//     a replayable fact" (../core/snapshot.ts:76-79);
//   - the match key is name + fingerprint, never the id (../harness.ts:5822-5857).

import { describe, expect, it } from 'vitest';
import { argumentFingerprint, toolCallFingerprint } from './argument-fingerprint';
import type { HarnessToolOutcome } from '../types';

describe('argumentFingerprint', () => {
    it('sorts top-level keys and discards insignificant whitespace', () => {
        // The doc's own example: `{"b":1,"a":2}` is the object {b:1, a:2}, so the
        // canonical spelling emits key `a` first with its value 2.
        expect(argumentFingerprint('{"b":1,"a":2}')).toBe('{"a":2,"b":1}');
        expect(argumentFingerprint('{ "b" : 1 , "a" : 2 }')).toBe('{"a":2,"b":1}');
        expect(argumentFingerprint('\n\t{"b":1,"a":2}\n')).toBe('{"a":2,"b":1}');

        // An already-canonical spelling is unchanged — the helper is a fixed point on its
        // own output, which is what makes a second compaction pass a no-op (T4.3).
        expect(argumentFingerprint('{"a":2,"b":1}')).toBe('{"a":2,"b":1}');
    });

    it('sorts keys at every depth', () => {
        // Nested objects sort too: z -> {c -> {h,i}, d}, and `a` moves to the front.
        expect(argumentFingerprint('{"z":{"d":4,"c":{"i":9,"h":8}},"a":1}')).toBe(
            '{"a":1,"z":{"c":{"h":8,"i":9},"d":4}}'
        );
    });

    it('preserves array order but canonicalizes the objects inside arrays', () => {
        // `list` elements keep their positions; each element's own keys are sorted. `m`
        // keeps the inner arrays exactly as sent.
        expect(argumentFingerprint('{"list":[{"y":1,"x":2},{"n":null}],"m":[[3,1],[2]]}')).toBe(
            '{"list":[{"x":2,"y":1},{"n":null}],"m":[[3,1],[2]]}'
        );

        // Order IS data: sorting array elements would fold two different jobs into one key
        // (a reordered list is a different request, not a different spelling).
        expect(argumentFingerprint('{"m":[1,2]}')).toBe('{"m":[1,2]}');
        expect(argumentFingerprint('{"m":[2,1]}')).toBe('{"m":[2,1]}');
    });

    it('orders keys by UTF-16 code unit, never by locale', () => {
        // 'A' (65) < '_' (95) < 'b' (98). A locale-aware compare would let the host decide
        // whether two transcripts show the same call, so the order is pinned here.
        expect(argumentFingerprint('{"b":1,"A":2,"_":3}')).toBe('{"A":2,"_":3,"b":1}');
    });

    it('passes primitive values through and keeps an explicit null value', () => {
        // `null` survives as a value: dropping it would change which call the model made.
        expect(argumentFingerprint('{"a":null,"b":true,"c":"x","d":0,"e":""}')).toBe(
            '{"a":null,"b":true,"c":"x","d":0,"e":""}'
        );
        // Keys with a null/boolean VALUE are kept; only an `undefined` value would be
        // dropped by JSON, and JSON.parse cannot produce one.
        expect(argumentFingerprint('{"z":null,"a":false}')).toBe('{"a":false,"z":null}');
    });

    it('normalizes number literals the way JSON itself does', () => {
        // 1.50 -> 1.5, 1e3 -> 1000, 1e2 -> 100: two spellings of one number are one call,
        // and the canonical text is what `JSON.stringify` would send.
        expect(argumentFingerprint('{"a":1.50,"b":1e3,"c":1e2}')).toBe('{"a":1.5,"b":1000,"c":100}');
    });

    it('keeps the last spelling of a duplicated key, which is what the tool receives', () => {
        // JSON.parse already resolved the duplicate before this helper sees the text, so
        // the fingerprint agrees with the arguments the implementation actually got.
        expect(argumentFingerprint('{"a":1,"a":2}')).toBe('{"a":2}');
    });

    it('is idempotent — fingerprinting its own output returns the same text', () => {
        const once = argumentFingerprint('{"z":{"b":1,"a":2},"a":[3,{"y":1,"x":2}]}');

        expect(once).toBe('{"a":[3,{"x":2,"y":1}],"z":{"a":2,"b":1}}');
        expect(argumentFingerprint(once)).toBe('{"a":[3,{"x":2,"y":1}],"z":{"a":2,"b":1}}');
    });

    it('falls back to the raw text for valid JSON that is not an object', () => {
        // Same exclusions as `wireArguments` (../transport/openai.ts:275-279): an array is
        // not an argument map, and neither is a bare scalar.
        expect(argumentFingerprint('null')).toBe('null');
        expect(argumentFingerprint('42')).toBe('42');
        expect(argumentFingerprint('true')).toBe('true');
        expect(argumentFingerprint('"a string"')).toBe('"a string"');
        expect(argumentFingerprint('[1,2]')).toBe('[1,2]');

        // The fallback does NOT re-serialize: interior whitespace survives, which is the
        // proof that the text is kept rather than rebuilt.
        expect(argumentFingerprint('  [1,  2]  ')).toBe('[1,  2]');

        // An empty OBJECT is an argument map, so it is canonical text, not a fallback.
        expect(argumentFingerprint('{}')).toBe('{}');
    });

    it('fingerprints the empty and blank argument strings as empty text', () => {
        // `''` is what a provider sends for a no-argument call, and the snapshot reader
        // allows it (../core/snapshot.ts:77-79). Trimmed, it is the empty string.
        expect(argumentFingerprint('')).toBe('');
        expect(argumentFingerprint('   \n ')).toBe('');
    });

    it('keeps malformed text verbatim apart from trimming', () => {
        // The dangerous row from the wire guard's own table (../transport/openai.ts:255-260):
        // a generation cut at the output-token ceiling commits half a JSON document.
        expect(argumentFingerprint('{"command":"ec')).toBe('{"command":"ec');
        expect(argumentFingerprint('not json')).toBe('not json');
        expect(argumentFingerprint('  {oops  ')).toBe('{oops');
        expect(argumentFingerprint('{"a":1,}')).toBe('{"a":1,}');
        expect(argumentFingerprint('{"a":1"b":2}')).toBe('{"a":1"b":2}');
    });

    it('never throws for a hostile runtime value', () => {
        // A restored transcript that reached this helper without passing the snapshot
        // reader can hold anything in `arguments`. Every non-string measures as empty text
        // rather than failing a turn boundary (./argument-fingerprint.ts TOTALITY).
        const hostile: unknown[] = [undefined, null, 42, true, {}, [], Symbol('x'), () => 0];

        expect(hostile.map((value) => argumentFingerprint(value as string))).toEqual(['', '', '', '', '', '', '', '']);
    });
});

describe('toolCallFingerprint', () => {
    it('joins the name and the canonical arguments with NUL', () => {
        expect(toolCallFingerprint('read', '{"b":1,"a":2}')).toBe('read\u0000{"a":2,"b":1}');
        expect(toolCallFingerprint('exec', '{"command":"echo hi","cwd":null}')).toBe(
            'exec\u0000{"command":"echo hi","cwd":null}'
        );
    });

    it('gives a retry the same key despite a new id and a different byte order (T2.2)', () => {
        // The id is deliberately absent: `assertToolCallIds` forbids reuse, so a retry's id
        // is always new (../harness.ts:5822-5857) and can never anchor a match.
        const attempt = toolCallFingerprint('read', '{"path":"a.ts","offset":10}');
        const retry = toolCallFingerprint('read', '{ "offset" : 10, "path" : "a.ts" }');

        expect(attempt).toBe('read\u0000{"offset":10,"path":"a.ts"}');
        expect(retry).toBe('read\u0000{"offset":10,"path":"a.ts"}');
    });

    it('separates a different tool name and a different argument value', () => {
        const keys = [
            toolCallFingerprint('read', '{"path":"a.ts"}'),
            toolCallFingerprint('write', '{"path":"a.ts"}'),
            toolCallFingerprint('read', '{"path":"b.ts"}')
        ];

        expect(keys).toEqual(['read\u0000{"path":"a.ts"}', 'write\u0000{"path":"a.ts"}', 'read\u0000{"path":"b.ts"}']);
        expect(keys.filter((key, index) => keys.indexOf(key) === index).length).toBe(3);
    });

    it('keeps a paged read a different key (T2.4: exact match, no prefix heuristic)', () => {
        // Reading page 2 is a different job than reading page 1, so the later success must
        // NOT be allowed to prune the earlier call.
        expect(toolCallFingerprint('read', '{"offset":0,"path":"a.ts"}')).toBe('read\u0000{"offset":0,"path":"a.ts"}');
        expect(toolCallFingerprint('read', '{"offset":50,"path":"a.ts"}')).toBe(
            'read\u0000{"offset":50,"path":"a.ts"}'
        );
    });

    it('fingerprints a truncated call as its own raw text (T2.4 edge 1)', () => {
        // The result budget never touches the CALL (./result-budget.ts:16-19), so this is
        // only the output-token truncation case. It stays a distinct, unanswered key.
        expect(toolCallFingerprint('exec', '{"command":"ec')).toBe('exec\u0000{"command":"ec');
        expect(toolCallFingerprint('exec', '{"command":"echo"}')).toBe('exec\u0000{"command":"echo"}');
    });

    it('separates a blank call from an explicit empty object', () => {
        // Deliberate and conservative: '' is malformed text, '{}' is an argument map. They
        // mean the same thing to a tool and are different recorded facts in the transcript;
        // a policy that wants them equal has to say so, which the helper cannot.
        expect(toolCallFingerprint('task', '')).toBe('task\u0000');
        expect(toolCallFingerprint('task', '{}')).toBe('task\u0000{}');
    });

    it('cannot collide across the name/argument boundary', () => {
        // A printable separator would let `('a\u0000b', '')` and `('a', 'b')` alias one
        // another; NUL cannot appear in a tool name, so the two keys stay distinct.
        expect(toolCallFingerprint('a\u0000b', '')).toBe('a\u0000b\u0000');
        expect(toolCallFingerprint('a', 'b')).toBe('a\u0000b');
    });
});

// T2.3 — the resolution matrix, as DATA.
//
// `sameWork` is the ONLY half this module owns: does a later unit name the same work as an
// earlier one. The outcome half (`completed` resolves, `cancelled` is never resolved,
// `completed` is never a candidate) is the T3 policy's decision over
// `HarnessToolOutcome` (../types/index.ts:234-251); it is written here as the rule T3 must
// satisfy, so the matrix has one executable home before the policy exists, and the
// `resolves` column below is checked against the hand-written expectations, not re-derived
// from production code that does not exist yet.
type MatrixRow = {
    case: string;
    earlierName: string;
    earlierArgs: string;
    earlierOutcome: HarnessToolOutcome;
    laterName: string;
    laterArgs: string;
    laterOutcome: HarnessToolOutcome;
    // Expected: the helper says "the same work".
    sameWork: boolean;
    // Expected under T2.3: the later unit answers the earlier one.
    resolves: boolean;
};

// The two outcome sets the contract fixes: only `completed` answers, and only a real
// failure or refusal is ever a prune candidate (`cancelled` is a healthy control outcome,
// and `completed` is a live result). See ../types/index.ts:247-250.
const RESOLVING_OUTCOME: HarnessToolOutcome = 'completed';
const PRUNE_CANDIDATE_OUTCOMES: readonly HarnessToolOutcome[] = ['failed', 'rejected'];

const RESOLUTION_MATRIX: readonly MatrixRow[] = [
    {
        case: 'retry-succeeded',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{ "path" : "a.ts" }',
        laterOutcome: 'completed',
        sameWork: true,
        resolves: true
    },
    {
        case: 'reordered-keys-retry-succeeded',
        earlierName: 'read',
        earlierArgs: '{"offset":10,"path":"a.ts"}',
        earlierOutcome: 'rejected',
        laterName: 'read',
        laterArgs: '{"path":"a.ts","offset":10}',
        laterOutcome: 'completed',
        sameWork: true,
        resolves: true
    },
    {
        case: 're-sent-identical-malformed-call-succeeded',
        earlierName: 'exec',
        earlierArgs: '{"command":"ec',
        earlierOutcome: 'rejected',
        laterName: 'exec',
        laterArgs: '  {"command":"ec  ',
        laterOutcome: 'completed',
        // The trim in the fallback is what makes a re-sent broken call comparable at all.
        sameWork: true,
        resolves: true
    },
    {
        case: 'answered-by-different-page',
        earlierName: 'read',
        earlierArgs: '{"offset":0,"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"offset":50,"path":"a.ts"}',
        laterOutcome: 'completed',
        sameWork: false,
        resolves: false
    },
    {
        case: 'answered-by-different-tool',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'write',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        sameWork: false,
        resolves: false
    },
    {
        case: 'truncated-call-answered-by-complete-call',
        earlierName: 'exec',
        earlierArgs: '{"command":"ec',
        earlierOutcome: 'failed',
        laterName: 'exec',
        laterArgs: '{"command":"echo"}',
        laterOutcome: 'completed',
        sameWork: false,
        resolves: false
    },
    {
        case: 'blank-call-answered-by-empty-object',
        earlierName: 'tasks',
        earlierArgs: '',
        earlierOutcome: 'failed',
        laterName: 'tasks',
        laterArgs: '{}',
        laterOutcome: 'completed',
        sameWork: false,
        resolves: false
    },
    {
        case: 'cancelled-is-never-resolved',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'cancelled',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        sameWork: true,
        resolves: false
    },
    {
        case: 'completed-is-never-a-candidate',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'completed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        sameWork: true,
        resolves: false
    },
    {
        case: 'answered-by-a-cancellation',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'cancelled',
        sameWork: true,
        resolves: false
    },
    {
        case: 'answered-by-another-failure',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'failed',
        sameWork: true,
        resolves: false
    }
];

describe('toolCallFingerprint resolution matrix (T2.3)', () => {
    it('matches the hand-derived expectations for every row', () => {
        const actual = RESOLUTION_MATRIX.map((row) => {
            // The helper's whole contribution: name + fingerprint equality.
            const sameWork =
                toolCallFingerprint(row.earlierName, row.earlierArgs) ===
                toolCallFingerprint(row.laterName, row.laterArgs);

            return {
                case: row.case,
                sameWork,
                // The T2.3 rule, stated as the test's own reference so the row's outcome
                // columns are checked against it rather than left as prose.
                resolves:
                    sameWork &&
                    row.laterOutcome === RESOLVING_OUTCOME &&
                    PRUNE_CANDIDATE_OUTCOMES.indexOf(row.earlierOutcome) !== -1
            };
        });

        expect(actual).toEqual(
            RESOLUTION_MATRIX.map((row) => ({ case: row.case, sameWork: row.sameWork, resolves: row.resolves }))
        );
    });

    it('keeps the matrix whole and its resolved set exact', () => {
        // A dropped or edited row has to be noticed: the table is the executable statement
        // of T2.3 until the policy task lands its own tests.
        expect(RESOLUTION_MATRIX.length).toBe(11);

        expect(RESOLUTION_MATRIX.map((row) => row.case)).toEqual([
            'retry-succeeded',
            'reordered-keys-retry-succeeded',
            're-sent-identical-malformed-call-succeeded',
            'answered-by-different-page',
            'answered-by-different-tool',
            'truncated-call-answered-by-complete-call',
            'blank-call-answered-by-empty-object',
            'cancelled-is-never-resolved',
            'completed-is-never-a-candidate',
            'answered-by-a-cancellation',
            'answered-by-another-failure'
        ]);

        // Exactly the three answered-failure rows resolve; every other combination keeps
        // its unit in the request.
        const resolvedCases = RESOLUTION_MATRIX.filter(
            (row) =>
                toolCallFingerprint(row.earlierName, row.earlierArgs) ===
                    toolCallFingerprint(row.laterName, row.laterArgs) &&
                row.laterOutcome === RESOLVING_OUTCOME &&
                PRUNE_CANDIDATE_OUTCOMES.indexOf(row.earlierOutcome) !== -1
        ).map((row) => row.case);

        expect(resolvedCases).toEqual([
            'retry-succeeded',
            'reordered-keys-retry-succeeded',
            're-sent-identical-malformed-call-succeeded'
        ]);
    });

    it('prunes only failed and rejected, and only a completed unit answers', () => {
        // Data guard for the outcome contract itself (../types/index.ts:247-250): adding
        // `cancelled` or `completed` to the candidate set is a contract change, and this is
        // the only place the sets are written down before T3 exists.
        expect(PRUNE_CANDIDATE_OUTCOMES).toEqual(['failed', 'rejected']);
        expect(RESOLVING_OUTCOME).toBe('completed');
    });
});

// T2.1/T2.2 — "one helper, exported from `src/core` beside the estimator". The barrel is
// the surface the T3 policy imports from, so the export itself is part of the contract and
// is pinned here rather than assumed. The import is DYNAMIC and inside the test on purpose:
// a static one would drag the whole core graph (agent, discovery, task stores) into a
// leaf-module test file, while the assertion only needs the export map. Identity (`toBe`)
// is the exact check: the same function object, not a second implementation.
describe('the fingerprint is reachable from src/core', () => {
    it('re-exports both helpers as the same functions', async () => {
        const core = await import('./index');

        expect(core.argumentFingerprint).toBe(argumentFingerprint);
        expect(core.toolCallFingerprint).toBe(toolCallFingerprint);
        expect(core.argumentFingerprint('{"b":1,"a":2}')).toBe('{"a":2,"b":1}');
        expect(core.toolCallFingerprint('read', '{"path":"a"}')).toBe(
            toolCallFingerprint('read', '{"path":"a"}')
        );
    });
});
