// searchTools() — the ranking behind requestTools.
//
// The contract that matters: a model's tag guess is approximate, so the matcher
// has to find close matches, rank them OR-style (best query-tag hit first, breadth
// only as a tiebreak), and never hand back the whole catalogue. No tool, no
// harness, no transport here — this is the pure part.

import { describe, expect, it } from 'vitest';
import { searchTools, tool } from '@underload/harness';
import type { ToolVisibility } from '@underload/harness';

const make = (
    name: string,
    tags: string[],
    extra: { visibility?: ToolVisibility; description?: string } = {}
) =>
    tool({
        name,
        description: extra.description ?? `${name} capability.`,
        tags,
        visibility: extra.visibility,
        execute: () => 'ok'
    });

describe('searchTools', () => {
    it('ranks exact tags above prefixes above substrings above name hits', () => {
        const exact = make('alpha', ['files']);
        const prefix = make('beta', ['filesystem']);
        const substring = make('gamma', ['myfiles']);
        const named = make('files-delta', ['unrelated'], { description: 'Unrelated capability.' });

        const result = searchTools([named, substring, prefix, exact], ['files']);

        expect(result.enabled).toEqual(['alpha', 'beta', 'gamma', 'files-delta']);
        expect(result.unmatchedTags).toBeUndefined();
        expect(result.truncated).toBeUndefined();
    });

    it('ranks the best single-tag match first, so weak breadth cannot outrank an exact hit', () => {
        // OR ranking: a tool that matches one query tag exactly (4) must beat a
        // tool that matches three query tags only weakly (2 each), even though the
        // summed points would favour the broad tool (4 vs 6).
        const exact = make('exact', ['files']);
        const broad = make('broad', ['file', 'reading', 'shells']);

        expect(searchTools([broad, exact], ['files', 'read', 'shell']).enabled).toEqual(['exact', 'broad']);
    });

    it('scores one query tag by its best tag hit, never by the sum across tags', () => {
        // Regression (F2): scoreTool used to ADD every matching tag for the same
        // needle, so a tool with several partial tags outranked a true exact tag.
        // "files" against broad scores 2 ('file' reverse-contains) + 3
        // ('filesystem' prefix) = 5 under the old sum, beating the exact 4. The
        // documented contract is best-single-tag, so the exact tool must win.
        const exact = make('alpha-exact', ['files']);
        const broad = make('zeta-broad', ['file', 'filesystem', 'folder']);

        expect(searchTools([broad, exact], ['files']).enabled).toEqual(['alpha-exact', 'zeta-broad']);
    });

    it('keeps best-match semantics across multiple query tags', () => {
        // Broad matches every needle only weakly; exact hits its one needle
        // exactly. Summing within a needle would lift broad's best to 5 (2+3),
        // but the rank is a max per needle, so its best stays 3.
        const exact = make('alpha-exact', ['files']);
        const broad = make('zeta-broad', ['file', 'filesystem', 'reading', 'shells']);

        expect(searchTools([broad, exact], ['files', 'read', 'shell']).enabled).toEqual([
            'alpha-exact',
            'zeta-broad'
        ]);
    });

    it('breaks a tie between equally exact tools deterministically', () => {
        // Both contain the exact tag, so best scores are equal (4) and each
        // matched the single requested tag. Name order decides, as documented;
        // the extra non-matching tags on "many" are not breadth of MATCHES.
        const many = make('alpha-many', ['files', 'file', 'filesystem']);
        const one = make('zeta-one', ['files']);

        expect(searchTools([one, many], ['files']).enabled).toEqual(['alpha-many', 'zeta-one']);
    });

    it('keeps every exact hit in the shortlist before weaker matches', () => {
        // Five exact hits exactly fill the cap; the three prefix matches are
        // counted as remaining instead of displacing an exact tag.
        const exact = ['a', 'b', 'c', 'd', 'e'].map((name) => make(`exact-${name}`, ['files']));
        const broad = ['p', 'q', 'r'].map((name) => make(`broad-${name}`, ['filesystem']));

        const result = searchTools([...broad, ...exact], ['files']);

        expect(result.enabled).toEqual(['exact-a', 'exact-b', 'exact-c', 'exact-d', 'exact-e']);
        expect(result.remaining).toBe(3);
        expect(result.truncated).toBe(true);
    });

    it('prefers the tool matching more requested tags when best scores tie', () => {
        const both = make('both', ['files', 'read']);
        const one = make('one', ['files']);

        // Same best score (4 via "files"); breadth is the tiebreak.
        expect(searchTools([one, both], ['files', 'read']).enabled).toEqual(['both', 'one']);
    });

    it('finds a tool when the query word contains its tag', () => {
        const read = make('reader', ['read'], { description: 'Reads text.' });

        expect(searchTools([read], ['reading']).enabled).toEqual(['reader']);
    });

    it('normalizes the query before matching', () => {
        const read = make('reader', ['read']);

        expect(searchTools([read], ['  READ ', 'read']).enabled).toEqual(['reader']);
    });

    it('never returns core tools, which are already declared', () => {
        const core = make('always', ['files'], { visibility: 'core' });
        const hidden = make('sometimes', ['files']);

        expect(searchTools([core, hidden], ['files']).enabled).toEqual(['sometimes']);
    });

    it('caps the result at five matches and counts the rest (R7)', () => {
        const tools = Array.from({ length: 12 }, (_, index) =>
            make(`tool-${String.fromCharCode(97 + index)}`, ['files'])
        );

        const result = searchTools(tools, ['files']);

        // 12 matches, 5 kept, ordered by name after the tie on score. The omitted
        // seven are reported as a COUNT only: no names, so the model refines tags.
        expect(result.enabled).toEqual(['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e']);
        expect(result.tools.map((entry) => entry.name)).toEqual([
            'tool-a',
            'tool-b',
            'tool-c',
            'tool-d',
            'tool-e'
        ]);
        expect(result.remaining).toBe(7);
        expect(result.truncated).toBe(true);
    });

    it('reports remaining 0 and no truncation when every match fits', () => {
        const tools = ['a', 'b', 'c', 'd', 'e'].map((name) => make(`tool-${name}`, ['files']));

        const result = searchTools(tools, ['files']);

        // Exactly five matches is the boundary: all of them, nothing left over.
        expect(result.enabled).toEqual(['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e']);
        expect(result.remaining).toBe(0);
        expect(result.truncated).toBeUndefined();
    });

    it('keeps the first five of a tied group in a stable order', () => {
        // Every tool ties on score and breadth, so name order decides both which
        // five survive and the order they are returned in.
        const tools = ['m', 'c', 'z', 'a', 'q', 'b', 'y'].map((name) =>
            make(`tool-${name}`, ['files'])
        );

        const result = searchTools(tools, ['files']);

        expect(result.enabled).toEqual(['tool-a', 'tool-b', 'tool-c', 'tool-m', 'tool-q']);
        expect(result.remaining).toBe(2);
    });

    it('does not count hidden core tools or unmatched tools in remaining', () => {
        const core = make('always', ['files'], { visibility: 'core' });
        const unrelated = make('shell', ['shell']);
        const tools = Array.from({ length: 6 }, (_, index) =>
            make(`file-${String(index)}`, ['files'])
        );

        const result = searchTools([core, unrelated, ...tools], ['files']);

        // Only the six searchable matches count: six matched, five returned, so
        // remaining is 1 — the core tool is never a candidate and the shell tool
        // never matched.
        expect(result.enabled).toHaveLength(5);
        expect(result.enabled).not.toContain('always');
        expect(result.enabled).not.toContain('shell');
        expect(result.remaining).toBe(1);
    });

    it('honours a smaller explicit limit and never exceeds the five-match cap', () => {
        const tools = Array.from({ length: 60 }, (_, index) =>
            make(`tool-${String(index).padStart(2, '0')}`, ['files'])
        );

        // The default is the cap; an explicit limit may only narrow the shortlist.
        expect(searchTools(tools, ['files']).enabled).toHaveLength(5);
        expect(searchTools(tools, ['files'], 3).enabled).toEqual(['tool-00', 'tool-01', 'tool-02']);
        expect(searchTools(tools, ['files'], 3).remaining).toBe(57);
        expect(searchTools(tools, ['files'], 3).truncated).toBe(true);

        // The cap is a context guard, so a caller cannot remove it.
        const raised = searchTools(tools, ['files'], 500);
        expect(raised.enabled).toHaveLength(5);
        expect(raised.remaining).toBe(55);

        const none = searchTools(tools, ['files'], 0);
        expect(none.enabled).toEqual([]);
        expect(none.remaining).toBe(60);
        expect(none.truncated).toBe(true);
    });

    it('returns the tag vocabulary when nothing matched', () => {
        const tools = [make('alpha', ['files', 'read']), make('beta', ['shell'])];

        const result = searchTools(tools, ['quantum']);

        expect(result.enabled).toEqual([]);
        expect(result.tools).toEqual([]);
        expect(result.remaining).toBe(0);
        // Reported so the model can retry with real vocabulary instead of guessing.
        expect(result.unmatchedTags).toEqual(['quantum']);
        expect(result.availableTags).toEqual(['files', 'read', 'shell']);
    });

    it('returns the vocabulary for an empty query', () => {
        const result = searchTools([make('alpha', ['files']), make('beta', ['shell'])], []);

        expect(result.enabled).toEqual([]);
        expect(result.remaining).toBe(0);
        expect(result.availableTags).toEqual(['files', 'shell']);
    });

    it('reports only the query tags that matched', () => {
        const result = searchTools([make('alpha', ['files'])], ['files', 'quantum']);

        expect(result.enabled).toEqual(['alpha']);
        expect(result.unmatchedTags).toEqual(['quantum']);
    });

    it('sees a tool\'s registry name, not its definition name', () => {
        // The harness renames tools to their registry key; discovery ranks what
        // the model will actually call.
        const definition = make('tool', ['unrelated'], { description: 'Unrelated capability.' });
        definition.name = 'fileRead';

        expect(searchTools([definition], ['fileread']).enabled).toEqual(['fileRead']);
    });
});
