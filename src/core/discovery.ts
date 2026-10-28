// Tool discovery — the ranking behind the harness's toolRequest tool.
//
// A harness may register thousands of tools. Declaring all of them on every
// request would spend the model's context on schemas it will never call, so only
// core tools are declared up front and everything else waits in the catalogue.
// toolRequest is how the model asks "what do you have for X?"; this module answers
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
// The result is capped at MAX_DISCOVERY_MATCHES (5) enabled tools per request:
// a broad query for "code" returns a shortlist plus the `remaining` count of
// additional matches, never the whole family.
//
// PROGRESSIVE DISCOVERY (R12): the cap used to be stationary — repeating the same
// query returned the same five tools and the same `remaining` count forever, so
// the omitted tail was unreachable by any tag refinement. `searchTools` now takes
// an `offset` into the ranked list, and the harness advances it for an identical
// query. The second identical call returns the NEXT tranche, `remaining` still
// counts the matches left AFTER the returned page, and the pure function stays
// pure — a caller that never passes an offset keeps the old first-page result.
//
// Only `visibility: 'searchable'` tools are candidates: core tools are already
// declared, so returning them would waste the model's turn. Only metadata is ever
// read here — name, description, tags — never `execute`, so a lazily-imported
// preset (src/tools) is rankable without loading its implementation.
//
// Cross-references:
//   - ../types       — ToolSearchResult, ToolMatch, ToolVisibility
//   - ./tool         — where tags are normalized
//   - ../harness     — toolRequest, which enables the matches for the next turn

import type { Tool, ToolSearchResult } from '../types';
import { normalizeTags } from './tool';

// Default cap on one discovery result, and the hard maximum (R7). Discovery
// trades context for an extra round trip, so the shortlist is deliberately small:
// five schemas is what a model can weigh in one turn, and a broad tag such as
// "files" (five matching tools today) must not re-flood the context. A query that
// matches more reports the excess as the `remaining` COUNT, and the model refines
// its tags to drill deeper — there is no pagination and no list of omitted names.
//
// Exported because toolRequest's schema and the server's core descriptor both
// advertise this number; one constant keeps the promise and the behaviour equal.
export const MAX_DISCOVERY_MATCHES = 5;

// The cap and the default are the same number on purpose: a caller (or the model,
// through toolRequest's `limit`) may ask for FEWER matches, never more.
const MAX_MATCHES = MAX_DISCOVERY_MATCHES;
const DEFAULT_MAX_MATCHES = MAX_DISCOVERY_MATCHES;

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

// Best single-tag score one query tag earns against one tool.
//
// This is a MAX, not a sum. Summing made breadth additive: a tool with
// ['files', 'file', 'filesystem'] scored 4+3+2 = 9 on the query "files" and
// outranked the tool whose only tag was an exact ['files'] (4). The documented
// contract (README "Ranking" row, knowledge.md toolRequest section, and the
// header above) is OR-style best-match — a tool's rank is its strongest single
// tag — with breadth only breaking ties in searchTools. A name/description hit
// is the 1-point rung of the same ladder, so it can lift a tool that has no tag
// hit but never stacks on top of a stronger tag hit.
const scoreTool = (tool: Tool, needle: string): number => {
    let best = 0;

    for (const tag of tool.tags) {
        const points = scoreTag(tag, needle);
        if (points > best) best = points;
    }

    if (needle.length >= MIN_FUZZY_LENGTH) {
        if (tool.name.toLowerCase().includes(needle)) best = Math.max(best, 1);
        if (tool.description.toLowerCase().includes(needle)) best = Math.max(best, 1);
    }

    return best;
};

const vocabulary = (tools: readonly Tool[]): string[] => {
    const tags = new Set<string>();

    for (const tool of tools) {
        for (const tag of tool.tags) tags.add(tag);
    }

    return [...tags].sort((left, right) => left.localeCompare(right));
};

// Clamp the requested cap into [0, MAX_MATCHES]. A missing or non-finite limit
// falls back to the documented default, so toolRequest can pass whatever the model
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
// `limit` narrows the shortlist below the 5-match cap (toolRequest's optional
// `limit` argument). It can never raise it: the cap is a context guard, so a host
// calling searchTools directly gets the same semantics as the model.
//
// `offset` skips that many ranked matches before the shortlist starts, which is
// how the harness walks the tail a capped query would otherwise never show (R12).
// It is clamped to the ranked list, so an over-large offset is simply an empty
// page. The result carries `offset` only when it is non-zero, so a first-page
// result keeps its original exact shape.
export const searchTools = (
    tools: readonly Tool[],
    tags: readonly string[],
    limit?: number,
    offset = 0
): ToolSearchResult => {
    const needles = normalizeTags(tags);
    const catalogue = tools.filter((tool) => tool.visibility === 'searchable');
    const availableTags = vocabulary(catalogue);
    const cap = resolveLimit(limit);

    // No usable query: hand back the vocabulary so the model can retry instead of
    // guessing at tags. Nothing matched, so nothing is left over.
    if (needles.length === 0) {
        return { enabled: [], tools: [], remaining: 0, availableTags };
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
        return { enabled: [], tools: [], remaining: 0, unmatchedTags, availableTags };
    }

    // Split the ranked list into what is returned and what is only counted. The
    // omitted tail never leaks a name: `remaining` is the whole answer for it, so
    // the model refines tags (e.g. "files" then "write") rather than paging — but
    // a repeated identical query now advances by one capped page (see the header).
    const start = Math.min(Math.max(0, Math.floor(offset)), scored.length);
    const kept = scored.slice(start, start + cap);
    // Counted AFTER this page, so "remaining" always means "further matches you
    // have not seen yet" and reaches 0 exactly when the catalogue is exhausted.
    const remaining = scored.length - start - kept.length;

    const result: ToolSearchResult = {
        enabled: kept.map(({ tool }) => tool.name),
        tools: kept.map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            tags: [...tool.tags]
        })),
        remaining
    };

    // Present only for a later page, so a first-page result keeps its old shape.
    if (unmatchedTags.length > 0) result.unmatchedTags = unmatchedTags;
    if (start > 0) result.offset = start;
    if (remaining > 0) result.truncated = true;

    return result;
};
