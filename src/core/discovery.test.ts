// searchTools() — the ranking behind requestTools.
//
// The contract that matters: a model's tag guess is approximate, so the matcher
// has to find close matches, rank them OR-style (best query-tag hit first, breadth
// only as a tiebreak), and never hand back the whole catalogue. No tool, no
// harness, no transport here — this is the pure part.

import { describe, expect, it } from 'vitest';
import { searchTools, tool } from '@underload/harness';
import type { ToolVisibility } from '@underload/harness';
// The new selector is exercised at the engine boundary directly: the package root
// export is wired by the integration change, while this file owns the engine's
// exact behaviour and must not depend on that wiring.
import { selectTools } from './discovery';

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

// Already-available core tools (R1). A query naming a capability the caller already
// has declared - agentDelegate is the reported case - must say so instead of "no
// match", without enabling it or spending the discovery cap.
describe('searchTools with declared core tools', () => {
    const delegate = make('agentDelegate', ['agents', 'delegate', 'delegation', 'subagent', 'team'], {
        visibility: 'core'
    });

    it('reports an exact core wire name instead of an empty match', () => {
        // "agentDelegate" is not one of its own tags ("delegate" is), so the wire
        // name is what has to resolve.
        const result = searchTools([], ['agentDelegate'], undefined, 0, { declared: [delegate] });

        expect(result).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ],
            availableTags: []
        });
    });

    it('treats the capability synonyms as a hit on the declared tool', () => {
        // "agents", "delegate" and "delegation" are all exact tags (the metadata
        // carries the noun form), so every synonym hits and none may be reported as
        // unmatched.
        const result = searchTools([], ['agents', 'delegate', 'delegation'], undefined, 0, {
            declared: [delegate]
        });

        expect(result).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ],
            availableTags: []
        });
    });

    it('never matches a declared tool by its description', () => {
        // Core descriptions mention everyday words; scanning them would append an
        // already-available tool to almost every query. Name and tags only.
        const reader = make('fileRead', ['files', 'read'], {
            visibility: 'core',
            description: 'Read a text file.'
        });

        const result = searchTools([], ['text'], undefined, 0, { declared: [reader] });

        expect(result).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            unmatchedTags: ['text'],
            availableTags: []
        });
    });

    it('reports a declared tool alongside a searchable match without enabling it', () => {
        const summary = make('agentSummary', ['agents', 'summary']);

        const result = searchTools([summary], ['agents'], undefined, 0, { declared: [delegate] });

        expect(result).toEqual({
            enabled: ['agentSummary'],
            tools: [
                {
                    name: 'agentSummary',
                    description: 'agentSummary capability.',
                    tags: ['agents', 'summary']
                }
            ],
            remaining: 0,
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ]
        });
    });

    it('does not let a declared tool consume the five-match cap', () => {
        const core = make('filesCore', ['files'], { visibility: 'core' });
        const tools = Array.from({ length: 6 }, (_, index) =>
            make(`file-${String(index).padStart(2, '0')}`, ['files'])
        );

        const result = searchTools(tools, ['files'], undefined, 0, { declared: [core] });

        // The cap still holds five SEARCHABLE tools; the declared tool is a report,
        // so it neither fills a slot nor changes the `remaining` count.
        expect(result.enabled).toEqual(['file-00', 'file-01', 'file-02', 'file-03', 'file-04']);
        expect(result.tools.map((entry) => entry.name)).toEqual([
            'file-00',
            'file-01',
            'file-02',
            'file-03',
            'file-04'
        ]);
        expect(result.remaining).toBe(1);
        expect(result.truncated).toBe(true);
        expect(result.alreadyAvailable).toEqual([
            { name: 'filesCore', description: 'filesCore capability.', tags: ['files'] }
        ]);
    });

    it('orders declared hits by score then name', () => {
        // Two exact tag hits tie (4) and fall back to name order; the prefix hit
        // ("filesystem") scores 3 and follows.
        const zulu = make('zulu', ['files'], { visibility: 'core' });
        const alpha = make('alpha', ['files'], { visibility: 'core' });
        const prefix = make('fileTools', ['filesystem'], { visibility: 'core' });

        const result = searchTools([], ['files'], undefined, 0, {
            declared: [zulu, prefix, alpha]
        });

        expect(result.alreadyAvailable?.map((entry) => entry.name)).toEqual([
            'alpha',
            'zulu',
            'fileTools'
        ]);
    });

    it('keeps an empty query free of an alreadyAvailable report', () => {
        // No query means nothing matched, so there is nothing to report as already
        // available - the vocabulary answer keeps its original shape.
        const result = searchTools([], [], undefined, 0, { declared: [delegate] });

        expect(result).toEqual({ enabled: [], tools: [], remaining: 0, availableTags: [] });
    });
});

// selectTools() - explicit names / regex / tags for the configurable tool
// surface. Unlike searchTools there is no five-match cap and no paging: the
// selector returns the whole union and the harness applies the per-turn enable
// cap. Exact-name matching is case-sensitive; regexes compile through RegExp, so
// an invalid source or flag set is a clear error rather than a silent empty result.
describe('selectTools', () => {
    it('selects exact names case-sensitively in the order the caller listed them', () => {
        const alpha = make('alpha', ['files']);
        const beta = make('beta', ['shell']);

        // Query order is preserved for exact names: the caller asked for beta
        // first, so beta is first. Nothing fuzzy matches "alph".
        expect(selectTools([alpha, beta], { names: ['beta', 'alpha'] })).toEqual({
            names: ['beta', 'alpha'],
            tools: [
                { name: 'beta', description: 'beta capability.', tags: ['shell'] },
                { name: 'alpha', description: 'alpha capability.', tags: ['files'] }
            ]
        });

        // Case is significant: ALPHA is not the registered alpha.
        expect(selectTools([alpha, beta], { names: ['ALPHA'] })).toEqual({
            names: [],
            tools: []
        });
        expect(selectTools([alpha, beta], { names: ['alph'] })).toEqual({
            names: [],
            tools: []
        });
    });

    it('matches a name regex and accepts the /source/flags literal form', () => {
        const read = make('fileRead', ['files']);
        const write = make('fileWrite', ['files']);
        const shell = make('shellRun', ['shell']);

        // Case-insensitive literal: only fileRead matches the anchored source.
        expect(selectTools([write, read, shell], { regex: '/^fileread$/i' })).toEqual({
            names: ['fileRead'],
            tools: [{ name: 'fileRead', description: 'fileRead capability.', tags: ['files'] }]
        });

        // A bare source is also accepted; both file tools match, name order wins.
        expect(selectTools([write, read, shell], { regex: '^file' }).names).toEqual([
            'fileRead',
            'fileWrite'
        ]);
    });

    it('resets a global/sticky regex between names so one hit cannot hide the next', () => {
        // RegExp.test is stateful with /g: without resetting lastIndex, the second
        // tool would be skipped even though it matches the same pattern.
        const tools = [make('tool-a', ['files']), make('tool-b', ['files'])];

        expect(selectTools(tools, { regex: '/^tool-/g' }).names).toEqual(['tool-a', 'tool-b']);
    });

    it('throws a clear error for invalid or empty regex input', () => {
        expect(() => selectTools([], { regex: '[' })).toThrow(/Invalid tool selection regex/);
        expect(() => selectTools([], { regex: '/foo/z' })).toThrow(/Invalid tool selection regex/);
        expect(() => selectTools([], { regex: '' })).toThrow(/pattern must not be empty/);
        expect(() => selectTools([], { regex: '//' })).toThrow(/pattern must not be empty/);
    });

    it('returns no matches for an empty query', () => {
        const tools = [make('alpha', ['files'])];

        expect(selectTools(tools, {})).toEqual({ names: [], tools: [] });
        expect(selectTools(tools, { names: [], tags: [] })).toEqual({ names: [], tools: [] });
        expect(selectTools(tools, { names: [''], tags: ['  '] })).toEqual({
            names: [],
            tools: []
        });
    });

    it('unions names, regex and tags, returning each tool once', () => {
        const alpha = make('alpha', ['files']);
        const beta = make('beta', ['files']);
        const delta = make('delta', ['files']);
        const gamma = make('gamma', ['filesystem']);

        // alpha is requested by exact name (and also matches the tag), beta by
        // regex (and also matches the tag), delta/gamma by tag only. Exact names
        // rank first, then the regex group, then the existing tag ranking:
        // exact "files" (4) before prefix "filesystem" (3).
        expect(
            selectTools([gamma, delta, beta, alpha], {
                names: ['alpha'],
                regex: '^beta$',
                tags: ['files']
            }).names
        ).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    });

    it('keeps the existing tag ranking: exact, prefix, substring, name hit', () => {
        const exact = make('exact', ['files']);
        const prefix = make('prefix', ['filesystem']);
        const substring = make('substring', ['myfiles']);
        const named = make('named-files', ['unrelated'], { description: 'Unrelated.' });

        expect(selectTools([named, substring, prefix, exact], { tags: ['files'] }).names).toEqual([
            'exact',
            'prefix',
            'substring',
            'named-files'
        ]);
    });

    it('uses tag breadth only as a tiebreak, as searchTools does', () => {
        const both = make('both', ['files', 'read']);
        const one = make('one', ['files']);

        // Both score 4 through "files"; "both" also matched "read".
        expect(selectTools([one, both], { tags: ['files', 'read'] }).names).toEqual([
            'both',
            'one'
        ]);
    });

    it('ranks regex hits by tag score before falling back to name order', () => {
        const weak = make('toolAlpha', ['unrelated'], { description: 'Unrelated.' });
        const strong = make('toolBeta', ['files']);

        // Both match /^tool/ (group 1); strong also has the exact tag (4), weak
        // has no tag hit (0), so the tag ranking decides within the regex group.
        expect(selectTools([weak, strong], { regex: '^tool', tags: ['files'] }).names).toEqual([
            'toolBeta',
            'toolAlpha'
        ]);
    });

    it('returns every match without the five-match discovery cap', () => {
        const tools = Array.from({ length: 12 }, (_, index) =>
            make(`tool-${String.fromCharCode(97 + index)}`, ['files'])
        );

        const result = selectTools(tools, { tags: ['files'] });
        const expected = Array.from({ length: 12 }, (_, index) =>
            `tool-${String.fromCharCode(97 + index)}`
        );

        // Twelve exact tag hits, all returned in name order. No `remaining` and no
        // `truncated`: the selector is deliberately uncapped, and the harness owns
        // the per-turn enable cap.
        expect(result.names).toEqual(expected);
        expect(result.tools.map((entry) => entry.name)).toEqual(expected);
        expect(Object.keys(result)).toEqual(['names', 'tools']);
    });

    it('leaves excluded names out of the selectable result', () => {
        const alpha = make('alpha', ['files']);
        const beta = make('beta', ['files']);

        expect(selectTools([alpha, beta], { tags: ['files'] }, { excludeNames: ['alpha'] })).toEqual({
            names: ['beta'],
            tools: [{ name: 'beta', description: 'beta capability.', tags: ['files'] }]
        });

        // Exclusion is exact and case-sensitive, like name selection.
        expect(
            selectTools([alpha, beta], { tags: ['files'] }, { excludeNames: ['ALPHA'] }).names
        ).toEqual(['alpha', 'beta']);
    });
});

// Declared core tools are already callable. selectTools reports them as
// alreadyAvailable and never adds them to the selectable names/tools, so they
// cannot consume the harness's per-turn enable budget.
describe('selectTools with declared core tools', () => {
    const delegate = make(
        'agentDelegate',
        ['agents', 'delegate', 'delegation', 'subagent', 'team'],
        { visibility: 'core' }
    );

    it('reports a core tool matched by exact name without selecting it', () => {
        expect(selectTools([], { names: ['agentDelegate'] }, { declared: [delegate] })).toEqual({
            names: [],
            tools: [],
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ]
        });
    });

    it('reports a core tool matched by name regex without selecting it', () => {
        expect(selectTools([], { regex: '/^agentdel/i' }, { declared: [delegate] })).toEqual({
            names: [],
            tools: [],
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ]
        });
    });

    it('reports core tag hits next to a selectable match', () => {
        const summary = make('agentSummary', ['agents', 'summary']);

        expect(
            selectTools([summary], { tags: ['agents'] }, { declared: [delegate] })
        ).toEqual({
            names: ['agentSummary'],
            tools: [
                {
                    name: 'agentSummary',
                    description: 'agentSummary capability.',
                    tags: ['agents', 'summary']
                }
            ],
            alreadyAvailable: [
                {
                    name: 'agentDelegate',
                    description: 'agentDelegate capability.',
                    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
                }
            ]
        });
    });

    it('never matches a declared core tool by its description', () => {
        const reader = make('fileRead', ['files', 'read'], {
            visibility: 'core',
            description: 'Read a text file.'
        });

        // Name and tags only, as in searchTools: "text" appears in the description
        // but names no declared capability.
        expect(selectTools([], { tags: ['text'] }, { declared: [reader] })).toEqual({
            names: [],
            tools: []
        });
    });

    it('does not let a declared core tool consume the uncapped selector or hide behind excludes', () => {
        const core = make('filesCore', ['files'], { visibility: 'core' });
        const tools = Array.from({ length: 6 }, (_, index) =>
            make(`file-${String(index).padStart(2, '0')}`, ['files'])
        );

        const result = selectTools(
            [core, ...tools],
            { tags: ['files'] },
            { declared: [core], excludeNames: [core.name] }
        );

        // The core tool is in the catalogue but is never selectable. The exclusion
        // applies to the selectable list only, so the alreadyAvailable report still
        // tells the caller the capability is present.
        expect(result.names).toEqual([
            'file-00',
            'file-01',
            'file-02',
            'file-03',
            'file-04',
            'file-05'
        ]);
        expect(result.tools.map((entry) => entry.name)).toEqual(result.names);
        expect(result.alreadyAvailable).toEqual([
            { name: 'filesCore', description: 'filesCore capability.', tags: ['files'] }
        ]);
    });
});
