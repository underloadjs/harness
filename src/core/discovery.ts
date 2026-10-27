// Tool discovery — the ranking behind the harness's getTools tool.
//
// A harness may register thousands of tools. Declaring all of them on every
// request would spend the model's context on schemas it will never call, so only
// core tools are declared up front and everything else waits in the catalogue.
// getTools is how the model asks "what do you have for X?"; this module answers
// with the closest tag matches.
//
// Matching is deliberately fuzzy but ordered, because a model's tag guess is
// rarely an exact vocabulary hit:
//
//   4  exact tag                    "files"  -> "files"
//   3  tag prefix                   "fil"    -> "files"
//   2  tag contains the query       "file"   -> "filesystem"
//      (and the reverse)            "reader" -> "read"
//   1  name / description contains the query
//
// Ranking is OR-style, not additive: a tool's rank is its BEST query-tag score.
//
//   ["files", "read"]  ->  tool A (tags: files, read)  = 4   (best of 4 and 4)
//                          tool B (tags: files, format) = 4   (best of 4 and 3)
//                          tool C (tags: file-read, txt) = 2
//
// Adding more query tags can therefore never promote a tool that matches none of
// them strongly: a broad tool matching five words weakly (2 each) must not outrank
// an exact tag hit (4). Breadth is only a TIEBREAK — when two tools share the same
// best score, the one matching more of the requested tags comes first, then name
// order, so results are stable.
//
// The result is capped (10 by default, 50 hard maximum) because a query for
// "code" must not re-flood the context with the whole catalogue.
//
// Only `visibility: 'searchable'` tools are candidates: core tools are already
// declared, so returning them would waste the model's turn. Only metadata is ever
// read here — name, description, tags — never `execute`, so a lazily-imported
// preset (src/tools) is rankable without loading its implementation.
//
// Cross-references:
//   - ../types       — ToolSearchResult, ToolMatch, ToolVisibility
//   - ./tool         — where tags are normalized
//   - ../harness     — getTools, which enables the matches for the next turn

import type { Tool, ToolSearchResult } from '../types';
import { normalizeTags } from './tool';

// Default cap on one discovery result. Discovery trades context for an extra round
// trip; returning hundreds of tools would give the round trip back. Ten is the
// documented default a caller (and the model, through getTools' `limit`) gets.
export const DEFAULT_MAX_MATCHES = 10;

// Hard ceiling even when a caller asks for more: the cap exists to protect the
// next request's context window, so it must not be removable by a parameter.
const MAX_MATCHES = 50;

// A one- or two-letter query matches far too much to be treated as a prefix, and
// name/description scanning below three characters is noise rather than signal.
const MIN_PREFIX_LENGTH = 2;
const MIN_FUZZY_LENGTH = 3;

const scoreTag = (tag: string, needle: string): number => {
    if (tag === needle) return 4;

    if (needle.length >= MIN_PREFIX_LENGTH && tag.startsWith(needle)) return 3;

    if (needle.length >= MIN_FUZZY_LENGTH && tag.includes(needle)) return 2;

    // Reverse containment: the tag is the shorter word ("read" inside "reader").
    if (tag.length >= MIN_FUZZY_LENGTH && needle.includes(tag)) return 2;

    return 0;
};

// Points one query tag earns against one tool.
const scoreTool = (tool: Tool, needle: string): number => {
    let points = 0;

    for (const tag of tool.tags) {
        points += scoreTag(tag, needle);
    }

    if (needle.length >= MIN_FUZZY_LENGTH) {
        if (tool.name.toLowerCase().includes(needle)) points += 1;
        if (tool.description.toLowerCase().includes(needle)) points += 1;
    }

    return points;
};

const vocabulary = (tools: readonly Tool[]): string[] => {
    const tags = new Set<string>();

    for (const tool of tools) {
        for (const tag of tool.tags) tags.add(tag);
    }

    return [...tags].sort((left, right) => left.localeCompare(right));
};

// Clamp the requested cap into [0, MAX_MATCHES]. A missing or non-finite limit
// falls back to the documented default, so getTools can pass whatever the model
// sent without trusting it.
const resolveLimit = (limit: number | undefined): number => {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_MAX_MATCHES;
    return Math.min(MAX_MATCHES, Math.max(0, Math.floor(limit)));
};

// Find the closest tools for a set of capability tags.
//
// Pure: the harness turns the result into the enable step, and callers can rank a
// catalogue themselves without building a harness. `enabled` doubles as the
// ranking order.
//
// `limit` caps the number of enabled tools (default 10, hard maximum 50). It is
// exposed for getTools' optional `limit` argument; a host calling searchTools
// directly gets the same cap semantics.
export const searchTools = (
    tools: readonly Tool[],
    tags: readonly string[],
    limit?: number
): ToolSearchResult => {
    const needles = normalizeTags(tags);
    const catalogue = tools.filter((tool) => tool.visibility === 'searchable');
    const availableTags = vocabulary(catalogue);
    const cap = resolveLimit(limit);

    // No usable query: hand back the vocabulary so the model can retry instead of
    // guessing at tags.
    if (needles.length === 0) {
        return { enabled: [], tools: [], availableTags };
    }

    // OR ranking: `best` is the strongest single-tag hit, `hits` only breaks ties.
    const scored: { tool: Tool; best: number; hits: string[] }[] = [];

    for (const tool of catalogue) {
        let best = 0;
        const hits: string[] = [];

        for (const needle of needles) {
            const points = scoreTool(tool, needle);
            if (points === 0) continue;

            hits.push(needle);
            if (points > best) best = points;
        }

        if (best > 0) scored.push({ tool, best, hits });
    }

    scored.sort(
        (left, right) =>
            right.best - left.best ||
            right.hits.length - left.hits.length ||
            left.tool.name.localeCompare(right.tool.name)
    );

    const matchedTags = new Set(scored.flatMap((entry) => entry.hits));
    const unmatchedTags = needles.filter((needle) => !matchedTags.has(needle));

    if (scored.length === 0) {
        return { enabled: [], tools: [], unmatchedTags, availableTags };
    }

    const kept = scored.slice(0, cap);
    const result: ToolSearchResult = {
        enabled: kept.map(({ tool }) => tool.name),
        tools: kept.map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            tags: [...tool.tags]
        }))
    };

    if (unmatchedTags.length > 0) result.unmatchedTags = unmatchedTags;
    if (scored.length > kept.length) result.truncated = true;

    return result;
};
