// searchTools() — the ranking behind getTools.
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

    it('caps the result so one query cannot flood the context', () => {
        const tools = Array.from({ length: 12 }, (_, index) =>
            make(`tool-${String.fromCharCode(97 + index)}`, ['files'])
        );

        const result = searchTools(tools, ['files']);

        // 12 matches, 10 kept, ordered by name after the tie on score.
        expect(result.enabled).toHaveLength(10);
        expect(result.enabled[0]).toBe('tool-a');
        expect(result.enabled[9]).toBe('tool-j');
        expect(result.tools).toHaveLength(10);
        expect(result.truncated).toBe(true);
    });

    it('honours an explicit limit but never exceeds the hard maximum', () => {
        const tools = Array.from({ length: 60 }, (_, index) =>
            make(`tool-${String(index).padStart(2, '0')}`, ['files'])
        );

        // Default is 10; an explicit limit changes only the kept tail.
        expect(searchTools(tools, ['files']).enabled).toHaveLength(10);
        expect(searchTools(tools, ['files'], 3).enabled).toEqual(['tool-00', 'tool-01', 'tool-02']);
        expect(searchTools(tools, ['files'], 3).truncated).toBe(true);

        // The cap is a context guard, so a caller cannot remove it.
        expect(searchTools(tools, ['files'], 500).enabled).toHaveLength(50);
        expect(searchTools(tools, ['files'], 0).enabled).toEqual([]);
        expect(searchTools(tools, ['files'], 0).truncated).toBe(true);
    });

    it('returns the tag vocabulary when nothing matched', () => {
        const tools = [make('alpha', ['files', 'read']), make('beta', ['shell'])];

        const result = searchTools(tools, ['quantum']);

        expect(result.enabled).toEqual([]);
        expect(result.tools).toEqual([]);
        // Reported so the model can retry with real vocabulary instead of guessing.
        expect(result.unmatchedTags).toEqual(['quantum']);
        expect(result.availableTags).toEqual(['files', 'read', 'shell']);
    });

    it('returns the vocabulary for an empty query', () => {
        const result = searchTools([make('alpha', ['files']), make('beta', ['shell'])], []);

        expect(result.enabled).toEqual([]);
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
        definition.name = 'readFile';

        expect(searchTools([definition], ['readfile']).enabled).toEqual(['readFile']);
    });
});
