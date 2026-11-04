// tools/files/search — the plumbing both search presets share, tested where the entry
// tests cannot reach it.
//
// glob.test.ts and grep.test.ts pin the tools' published contracts, which covers most of
// this module through behaviour. Two pieces need direct tests because a tool-level
// assertion cannot distinguish a correct implementation from an accidental one:
//
//   - `mapConcurrent`: grep reads files through it, and its whole justification is that
//     it changes the WALL CLOCK and nothing else. Order must be identical to the serial
//     walk (otherwise `offset`/`nextOffset` arithmetic pages a shuffled sequence),
//     abandoning the consumer must abandon the WALK (otherwise a capped search still
//     enumerates the tree, which is the cost the fix was meant to remove), a rejection
//     must surface at its own position rather than as an unhandled rejection, and a
//     mapper that resolves to `undefined` must not silently drop a candidate.
//   - `compilePatterns`: brace expansion and `!` negation decide what both tools match,
//     and the `effective` list is a published field. The entry tests see the consequence;
//     these pin the rule, including the cases where a pattern is deliberately NOT a
//     choice (`{a}`, an unterminated group, a lone `!`).
//
// `collectCandidates` is exercised through the two entries (roots, aliases, ignore
// scoping, file roots, coverage counters) rather than duplicated here.

import { describe, expect, it } from 'vitest';
import { compilePatterns, mapConcurrent, matchesPatterns } from './search';

const drain = async <T>(source: AsyncGenerator<T>): Promise<T[]> => {
    const values: T[] = [];

    for await (const value of source) values.push(value);

    return values;
};

const of = async function* <T>(values: readonly T[]): AsyncGenerator<T> {
    for (const value of values) yield value;
};

describe('mapConcurrent', () => {
    it('yields in source order however the work finishes', async () => {
        // The reads grep overlaps finish out of order on a real filesystem; the result
        // sequence must still be the walk's, because `offset` indexes that sequence.
        const source = of([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
        const delays = new Map<number, number>([
            [10, 30],
            [1, 1]
        ]);

        const mapped = await drain(
            mapConcurrent(source, 4, async (value) => {
                await new Promise((resolve) => setTimeout(resolve, delays.get(value) ?? 10));
                return value;
            })
        );

        expect(mapped).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('overlaps the work, which is the only thing it changes', async () => {
        // Four 40ms tasks: serial would be ~160ms, concurrency 4 is ~40ms. The bound is
        // loose on purpose — a CI box under load is slower — but it separates "runs the
        // tasks at once" from "runs them in a row" by a wide margin.
        const startedAt = Date.now();

        await drain(
            mapConcurrent(of([1, 2, 3, 4]), 4, async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                return null;
            })
        );

        expect(Date.now() - startedAt).toBeLessThan(140);
    });

    it('never runs more than `concurrency` tasks at once', async () => {
        let live = 0;
        let peak = 0;

        await drain(
            mapConcurrent(of(Array.from({ length: 20 }, (_unused, index) => index)), 3, async () => {
                live += 1;
                peak = Math.max(peak, live);
                await new Promise((resolve) => setTimeout(resolve, 2));
                live -= 1;
                return null;
            })
        );

        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
    });

    it('abandons the source when the consumer stops early', async () => {
        // The efficiency claim, stated as a test: a search that has filled its window and
        // proven truncation must not keep walking. `return()` on the source is what the
        // for-await's early `break` triggers, and `mapConcurrent` forwards it.
        let pulled = 0;
        let closed = false;

        const source = (async function* () {
            try {
                for (;;) {
                    pulled += 1;
                    yield pulled;
                }
            } finally {
                closed = true;
            }
        })();

        const mapped = mapConcurrent(source, 2, async (value) => value);
        const first = [];

        for await (const value of mapped) {
            first.push(value);
            if (first.length === 3) break;
        }

        // Let the pipeline's finally run (it awaits `source.return()`).
        await mapped.return(undefined);

        expect(first).toEqual([1, 2, 3]);
        expect(closed).toBe(true);
        expect(pulled).toBeLessThan(10);
    });

    it('reports a failure at its own position, not as an unhandled rejection', async () => {
        // A rejected mapper used to become an unhandled rejection while a sibling was
        // awaited. Here the failure is carried in the slot and re-thrown when the loop
        // reaches it, so earlier successes are still yielded first.
        const values: number[] = [];
        let caught: unknown;

        try {
            for await (const value of mapConcurrent(of([1, 2, 3]), 3, async (value) => {
                if (value === 2) throw new Error('second failed');
                return value;
            })) {
                values.push(value);
            }
        } catch (error) {
            caught = error;
        }

        expect(values).toEqual([1]);
        expect((caught as Error).message).toBe('second failed');
    });

    it('yields a mapper result of undefined instead of dropping it', async () => {
        // The verdict shape must not be confused with "no verdict". The first
        // implementation used `undefined` as its own sentinel for "nothing to yield", so a
        // mapper that legitimately resolved to `undefined` silently lost a candidate —
        // three inputs, zero outputs, and no error anywhere.
        const yielded: unknown[] = [];

        for await (const value of mapConcurrent(of([1, 2, 3]), 2, async () => undefined)) {
            yielded.push(value);
        }

        expect(yielded).toEqual([undefined, undefined, undefined]);
    });

    it('accepts a concurrency of zero or a fraction without serializing into nothing', async () => {
        expect(await drain(mapConcurrent(of([1, 2, 3]), 0, async (value) => value))).toEqual([1, 2, 3]);
        expect(await drain(mapConcurrent(of([1, 2, 3]), 2.9, async (value) => value))).toEqual([1, 2, 3]);
        expect(await drain(mapConcurrent(of([]), 4, async (value) => value))).toEqual([]);
    });
});

describe('compilePatterns', () => {
    const matching = (patterns: string[], path: string): boolean =>
        matchesPatterns(compilePatterns(patterns), path);

    it('ORs inclusions and reports the expanded list it compiled', () => {
        const set = compilePatterns(['*.md', 'src/*.ts']);

        expect(set.include).toHaveLength(2);
        expect(set.exclude).toHaveLength(0);
        expect(set.negated).toBe(false);
        expect(set.effective).toEqual(['*.md', 'src/*.ts']);
        expect(matching(['*.md', 'src/*.ts'], 'docs/a.md')).toBe(true);
        expect(matching(['*.md', 'src/*.ts'], 'src/a.ts')).toBe(true);
        expect(matching(['*.md', 'src/*.ts'], 'task/e.ts')).toBe(false);
    });

    it('expands every alternative and keeps the order a caller can read', () => {
        const set = compilePatterns(['**/*.{ts,tsx}']);

        expect(set.effective).toEqual(['**/*.ts', '**/*.tsx']);
        expect(matching(['**/*.{ts,tsx}'], 'src/a.ts')).toBe(true);
        expect(matching(['**/*.{ts,tsx}'], 'ui/App.tsx')).toBe(true);
        expect(matching(['**/*.{ts,tsx}'], 'docs/a.md')).toBe(false);
    });

    it('lets an exclusion veto an inclusion, in either order', () => {
        // The rule a caller assumes from .gitignore: an exclusion wins. If order decided
        // it, `['**/*.ts', '!**/*.test.ts']` and the reverse would answer differently,
        // and only one of them would be right by accident.
        expect(matching(['**/*.ts', '!**/*.test.ts'], 'src/a.ts')).toBe(true);
        expect(matching(['**/*.ts', '!**/*.test.ts'], 'src/a.test.ts')).toBe(false);
        expect(matching(['!**/*.test.ts', '**/*.ts'], 'src/a.test.ts')).toBe(false);
        expect(matching(['!**/*.test.ts', '**/*.ts'], 'src/a.ts')).toBe(true);
    });

    it('treats a list of only exclusions as "everything except"', () => {
        // `['!**/*.ts']` used to compile to an EMPTY inclusion list, which matched
        // nothing — the opposite of what the caller meant.
        expect(compilePatterns(['!**/*.ts']).include).toHaveLength(0);
        expect(matching(['!**/*.ts'], 'docs/a.md')).toBe(true);
        expect(matching(['!**/*.ts'], 'src/a.ts')).toBe(false);
    });

    it('keeps a non-choice brace literal, and reports it as written', () => {
        expect(compilePatterns(['{solo}.ts']).effective).toEqual(['{solo}.ts']);
        expect(matching(['{solo}.ts'], '{solo}.ts')).toBe(true);
        expect(compilePatterns(['src/{a,b']).effective).toEqual(['src/{a,b']);
    });

    it('treats a lone "!" as the character, not as "exclude everything"', () => {
        // A pattern that is only "!" has no body to negate. Reading it as an exclusion of
        // nothing would make the whole list match nothing; git reads a lone "!" as a
        // (useless) pattern, and so does this.
        const set = compilePatterns(['!']);

        expect(set.exclude).toHaveLength(0);
        expect(set.effective).toEqual(['!']);
        expect(matching(['!'], '!')).toBe(true);
        expect(matching(['!'], 'a.ts')).toBe(false);
    });

    it('applies the slashless-name rule to expanded and negated patterns alike', () => {
        // `*.test.ts` has no slash, so it must also match a file name at any depth —
        // including when it arrives through `{a,b}` or behind a `!`.
        expect(matching(['*.{ts,tsx}'], 'src/nested/deep/a.tsx')).toBe(true);
        expect(matching(['**/*.ts', '!*.test.ts'], 'src/nested/a.test.ts')).toBe(false);
    });

    it('rejects an unknown flag-shaped pattern no differently from a plain one', () => {
        // A glob is not a regex: nothing here throws, because ./glob.ts treats an
        // unterminated class as a literal. A typo costs matches, never the search.
        expect(() => compilePatterns(['[abc'])).not.toThrow();
        expect(matching(['[abc'], '[abc')).toBe(true);
    });

});
