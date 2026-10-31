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
// Only `visibility: 'searchable'` tools are candidates for ENABLING: core tools
// are already declared, so returning them in `enabled` would waste the model's
// turn and spend the cap. Only metadata is ever read here — name, description,
// tags — never `execute`, so a lazily-imported preset (src/tools) is rankable
// without loading its implementation.
//
// ALREADY-AVAILABLE CORE TOOLS (additive, never enabled). A query used to answer
// "no match" for a capability the caller could already call — the reported case
// was tag "agentDelegate" in a harness WITH subagents, where the tool is declared
// on every request yet discovery claimed nothing matched. searchTools now also
// scores the core tools the CALLER already has (options.declared, supplied by the
// harness from its own declaration rule) and reports the hits as
// `alreadyAvailable`. This is a report only:
//   - nothing is added to `enabled`/`tools`, so the 5-match budget is untouched;
//   - no declaration changes, because those tools were declared already;
//   - the caller supplies the visible set, so a subagent (which never sees
//     agentDelegate) or a one-agent harness (which has no agentDelegate at all)
//     gets no such entry — absence stays honest;
//   - a core hit also counts as a MATCHED query tag, so `unmatchedTags` cannot
//     claim a capability is absent when it is available.
//
// Core scoring is deliberately stricter than searchable scoring: wire NAME and
// TAGS only, never the description. Core descriptions mention everyday words
// ("session", "tools", "file") and scanning them would append an already-available
// capability to almost every query, burying the real shortlist.
//
// EXPLICIT SELECTION (selectTools, below). searchTools keeps the legacy paged,
// tag-only answer for existing hosts. The configurable tool surface needs a second
// selector that can also address tools by exact NAME or by a NAME REGEX, returns
// the whole union with no 5-match cap, and leaves the per-turn enable cap to the
// harness. Selection never enables anything: it is pure metadata, like searchTools.
//
// Cross-references:
//   - ../types       — ToolSearchResult, ToolMatch, ToolVisibility
//   - ./tool         — where tags are normalized
//   - ../harness     — toolRequest, which enables the matches for the next turn

import type { Tool, ToolMatch, ToolSearchOptions, ToolSearchResult } from '../types';
import { HarnessError } from '../util';
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

// Score one ALREADY-DECLARED (core) tool against one query tag.
//
// Same ladder as scoreTag (exact 4, prefix 3, contains 2) but applied to the wire
// NAME as well as the tags, and NEVER to the description. Name comparison is
// case-insensitive because normalizeTags lower-cases the query, and it is what
// makes an exact-name lookup ("agentDelegate") resolve even though tag matching
// alone would stop at "delegate".
const scoreDeclaredTool = (tool: Tool, needle: string): number => {
    let best = 0;

    for (const tag of tool.tags) {
        const points = scoreTag(tag, needle);
        if (points > best) best = points;
    }

    const name = tool.name.toLowerCase();

    if (name === needle) {
        // An exact wire name is as strong as an exact tag.
        best = Math.max(best, 4);
    } else if (needle.length >= MIN_PREFIX_LENGTH && name.startsWith(needle)) {
        best = Math.max(best, 3);
    } else if (needle.length >= MIN_FUZZY_LENGTH && name.includes(needle)) {
        best = Math.max(best, 2);
    }

    return best;
};

// Rank the declared core tools against the query, with the same OR-style rule as
// the searchable catalogue: a tool's score is its best single query-tag hit, and
// breadth is not additive. Order is best score first, then name, so the report is
// deterministic; the whole list is returned (no cap) because these tools are
// already in context and naming them costs no schema.
//
// `matched` is the set of query tags that hit ANY declared tool. It feeds the
// `unmatchedTags` computation so a tag naming an available core capability is
// never reported as unmatched.
const rankDeclared = (
    declared: readonly Tool[],
    needles: readonly string[]
): { scored: { tool: Tool; best: number }[]; matched: string[] } => {
    const scored: { tool: Tool; best: number }[] = [];
    const matched: string[] = [];

    for (const tool of declared) {
        let best = 0;

        for (const needle of needles) {
            const points = scoreDeclaredTool(tool, needle);
            if (points === 0) continue;

            if (!matched.includes(needle)) matched.push(needle);
            if (points > best) best = points;
        }

        if (best > 0) scored.push({ tool, best });
    }

    scored.sort(
        (left, right) => right.best - left.best || left.tool.name.localeCompare(right.tool.name)
    );

    return { scored, matched };
};

// The model-facing shape of an already-declared tool: the same metadata a search
// match carries, copied so a result can never alias a live tool's tag array.
const toMatch = (tool: Tool): ToolMatch => ({
    name: tool.name,
    description: tool.description,
    tags: [...tool.tags]
});

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
//
// `options.declared` is the set of core tools the CALLER already has declared
// (the harness passes exactly what its declaration rule allows that agent to see).
// They are scored by name/tag only and reported as `alreadyAvailable`; they are
// never enabled, never affect `remaining`, and never consume the cap. Omitting
// `options` reproduces the pre-existing behaviour exactly.
export const searchTools = (
    tools: readonly Tool[],
    tags: readonly string[],
    limit?: number,
    offset = 0,
    options?: ToolSearchOptions
): ToolSearchResult => {
    const needles = normalizeTags(tags);
    const catalogue = tools.filter((tool) => tool.visibility === 'searchable');
    const availableTags = vocabulary(catalogue);
    const cap = resolveLimit(limit);

    // No usable query: hand back the vocabulary so the model can retry instead of
    // guessing at tags. Nothing matched, so nothing is left over. Deliberately no
    // `alreadyAvailable`: with no query there is nothing to report as matching.
    if (needles.length === 0) {
        return { enabled: [], tools: [], remaining: 0, availableTags };
    }

    // Core tools are reported, not ranked into the enable list (see the header).
    const { scored: declaredScored, matched: declaredMatched } = rankDeclared(
        options?.declared ?? [],
        needles
    );

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
    // A declared core hit is a match too: `unmatchedTags` must not claim an
    // already-callable capability is absent.
    for (const needle of declaredMatched) matchedTags.add(needle);

    const unmatchedTags = needles.filter((needle) => !matchedTags.has(needle));

    // Same field order regardless of which related fields are present; absent
    // fields keep earlier exact-shape results unchanged.
    const alreadyAvailable = declaredScored.map(({ tool }) => toMatch(tool));

    if (scored.length === 0) {
        const none: ToolSearchResult = { enabled: [], tools: [], remaining: 0 };

        if (alreadyAvailable.length > 0) none.alreadyAvailable = alreadyAvailable;
        if (unmatchedTags.length > 0) none.unmatchedTags = unmatchedTags;
        none.availableTags = availableTags;

        return none;
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
    if (alreadyAvailable.length > 0) result.alreadyAvailable = alreadyAvailable;

    return result;
};

// ---------------------------------------------------------------------------
// selectTools — explicit selection for the configurable tool surface
// ---------------------------------------------------------------------------
//
// The legacy searchTools contract above is tag-only and capped at five. The new
// toolRequest accepts a richer query and must not silently hide matches: it is the
// harness's job to enforce the enabled-per-turn cap on the returned union, not the
// selector's job to shorten the list. selectTools therefore:
//
//   - selects by exact NAME (case-sensitive), NAME REGEX, or capability TAGS;
//   - takes the UNION of all three criteria (a tool matching two appears once);
//   - returns every match, no MAX_DISCOVERY_MATCHES cap and no `remaining`;
//   - reports declared CORE tools as `alreadyAvailable` instead of selecting them,
//     exactly as searchTools does, because they are declared already and must not
//     consume the harness's per-turn enable budget;
//   - never reads `execute`; metadata only, so lazy presets stay unloaded.
//
// Ordering keeps the two useful notions of relevance apart:
//   1. exact requested names, in the order the caller listed them;
//   2. regex name hits, then tag matches, both with the existing OR-style tag
//      ranking (best single-tag score, breadth as tiebreak, then name).
// A tool that matches several criteria is ranked by its STRONGEST group (exact
// name, then regex, then tag-only) and never repeated; each name appears once.
//
// Query validation is synchronous and explicit: an empty query selects nothing,
// and an invalid regex (bad source, bad flags, empty pattern) throws a
// HarnessError whose message names the invalid expression. Patterns are compiled
// with `new RegExp`, never evaluated as code.

// What the caller can ask for. Every field is optional; the fields that are
// present are OR-ed together.
export type ToolSelectionQuery = {
    // Exact wire names. Case-sensitive: the model copies names from the catalogue,
    // so a different case is a different, probably nonexistent, tool.
    names?: readonly string[];
    // JavaScript regex tested against each wire name. Either a bare source
    // ("^file") or the literal form "/^file/i" (source + flags). The literal form
    // is the only way to pass flags without widening the query shape.
    regex?: string;
    // Capability tags, scored with the same fuzzy ladder as searchTools.
    tags?: readonly string[];
};

// Additive context for a selection. Omitting it keeps the simplest behaviour:
// only searchable tools are selected and no core report is produced.
export type ToolSelectionOptions = {
    // Exact, case-sensitive names to leave OUT of the selectable result. Used by
    // the harness to avoid re-returning tools already enabled for this turn. It
    // does not hide `alreadyAvailable`: core tools are not part of the enable
    // list, so removing them from that report would hide a capability the caller
    // still has.
    excludeNames?: readonly string[];
    // Core tools the CALLER already has declared. They are matched by name, name
    // regex, or tags (never description) and reported as `alreadyAvailable`; they
    // are never returned in `names`/`tools`, which are the selectable matches.
    declared?: readonly Tool[];
};

// The selector answer. `names` duplicates the metadata names so a host can enable
// results without reshaping, and `tools` carries the model-facing metadata in the
// same order.
export type ToolSelectionResult = {
    names: string[];
    tools: ToolMatch[];
    // Present only when at least one declared tool matched, so an ordinary result
    // keeps its minimal shape.
    alreadyAvailable?: ToolMatch[];
};

// One candidate before metadata is copied. `group` mirrors the ordering contract:
// 2 exact name, 1 regex name, 0 tag-only. `nameOrder` is the caller's position for
// an exact name (Number.MAX_SAFE_INTEGER elsewhere). `tagBest`/`tagHits` reuse the
// searchTools ranking so tags keep their established behaviour.
type RankedSelection = {
    tool: Tool;
    group: number;
    nameOrder: number;
    tagBest: number;
    tagHits: number;
};

// Normalized query: deduplicated non-empty names (with their caller order), the
// compiled pattern, and normalized tags. Keeping the map beside the list lets the
// exact-name group sort by request order without a second scan per tool.
type NormalizedSelectionQuery = {
    names: string[];
    nameOrder: Map<string, number>;
    pattern?: RegExp;
    tags: string[];
};

const compileSelectionRegex = (input: string): RegExp => {
    if (typeof input !== 'string') {
        throw new HarnessError('Invalid tool selection regex: expected a string pattern.');
    }

    // An empty pattern would match every name, which makes an "empty query means
    // nothing" contract impossible to reason about; reject it instead of silently
    // turning the selector into a list-everything call.
    if (input.length === 0) {
        throw new HarnessError('Invalid tool selection regex: pattern must not be empty.');
    }

    let source = input;
    let flags = '';

    // Literal form /source/flags. A string that merely starts with "/" but has no
    // closing slash is treated as a bare source, so a pattern like "/api" still
    // means what it looks like.
    if (input.startsWith('/')) {
        const closing = input.lastIndexOf('/');
        if (closing > 0) {
            source = input.slice(1, closing);
            flags = input.slice(closing + 1);
            if (source.length === 0) {
                throw new HarnessError('Invalid tool selection regex: pattern must not be empty.');
            }
        }
    }

    try {
        // `new RegExp` validates both the source and the flags. This is pattern
        // compilation, not evaluation: no query text ever reaches eval/Function.
        return new RegExp(source, flags);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new HarnessError(`Invalid tool selection regex ${JSON.stringify(input)}: ${detail}`, {
            cause: error
        });
    }
};

// `g`/`y` make RegExp.test stateful through lastIndex. Reset around every test so
// one tool cannot consume the match and hide the next one.
const matchesSelectionPattern = (pattern: RegExp, name: string): boolean => {
    pattern.lastIndex = 0;
    const matched = pattern.test(name);
    pattern.lastIndex = 0;
    return matched;
};

const normalizeSelectionQuery = (query: ToolSelectionQuery | undefined): NormalizedSelectionQuery => {
    const names: string[] = [];
    const nameOrder = new Map<string, number>();

    // Runtime tolerance mirrors the harness's model-input tolerance: skip values
    // that are not strings rather than letting a sloppy request fail selection.
    // Empty names can never name a registered tool.
    for (const name of Array.isArray(query?.names) ? query.names : []) {
        if (typeof name !== 'string' || name.length === 0 || nameOrder.has(name)) continue;
        nameOrder.set(name, names.length);
        names.push(name);
    }

    const tags = normalizeTags(query?.tags);
    const pattern =
        query?.regex === undefined ? undefined : compileSelectionRegex(query.regex);

    return { names, nameOrder, pattern, tags };
};

// Sort in place, then copy metadata in that order. Exact names use caller order;
// regex and tag groups share the tag ranking (a regex hit with no tag still has
// tagBest/tagHits of 0, so it falls back to name order).
const rankSelection = (ranked: RankedSelection[]): ToolMatch[] => {
    ranked.sort((left, right) => {
        if (left.group !== right.group) return right.group - left.group;

        if (left.group === 2) {
            return (
                left.nameOrder - right.nameOrder ||
                left.tool.name.localeCompare(right.tool.name)
            );
        }

        return (
            right.tagBest - left.tagBest ||
            right.tagHits - left.tagHits ||
            left.tool.name.localeCompare(right.tool.name)
        );
    });

    return ranked.map(({ tool }) => toMatch(tool));
};

// Select every searchable tool that matches ANY supplied criterion.
//
// The function is pure and uncapped. `options.excludeNames` removes already-enabled
// searchable tools from the result; it does not remove `alreadyAvailable` entries
// (see ToolSelectionOptions). `options.declared` is the caller's own core set, not
// the whole registry: the harness passes exactly what the calling agent can see.
export const selectTools = (
    tools: readonly Tool[],
    query: ToolSelectionQuery,
    options?: ToolSelectionOptions
): ToolSelectionResult => {
    const normalized = normalizeSelectionQuery(query);

    // No criterion means no matches, matching searchTools' empty-query contract.
    // Return a fresh object so callers can never mutate a shared empty result.
    if (
        normalized.names.length === 0 &&
        normalized.tags.length === 0 &&
        normalized.pattern === undefined
    ) {
        return { names: [], tools: [] };
    }

    // Read the option arrays once: `options` is optional, and the runtime array
    // checks keep a sloppy host from crashing selection on non-array input.
    const excludeNames = options?.excludeNames;
    const excluded = new Set<string>();
    for (const name of Array.isArray(excludeNames) ? excludeNames : []) {
        if (typeof name === 'string') excluded.add(name);
    }

    const selectable: RankedSelection[] = [];

    for (const tool of tools) {
        // Core tools are declared on every request; selecting them would imply a
        // grant the caller already has. They are reported through `declared`
        // instead. This also means a caller cannot accidentally enable one.
        if (tool.visibility !== 'searchable') continue;
        if (excluded.has(tool.name)) continue;

        const nameOrder = normalized.nameOrder.get(tool.name);
        const exactName = nameOrder !== undefined;
        const regexName =
            normalized.pattern !== undefined &&
            matchesSelectionPattern(normalized.pattern, tool.name);

        let tagBest = 0;
        let tagHits = 0;

        for (const needle of normalized.tags) {
            const points = scoreTool(tool, needle);
            if (points === 0) continue;

            tagHits += 1;
            if (points > tagBest) tagBest = points;
        }

        if (!exactName && !regexName && tagHits === 0) continue;

        selectable.push({
            tool,
            group: exactName ? 2 : regexName ? 1 : 0,
            nameOrder: nameOrder ?? Number.MAX_SAFE_INTEGER,
            tagBest,
            tagHits
        });
    }

    const toolsMatch = rankSelection(selectable);

    // Declared core tools use the same union and ordering, but their tag scoring
    // stops at name + tags: core descriptions mention everyday words and would
    // append an already-available entry to almost every query (see rankDeclared).
    const declaredRanked: RankedSelection[] = [];
    const seenDeclared = new Set<string>();
    const declaredTools = options?.declared;

    for (const tool of Array.isArray(declaredTools) ? declaredTools : []) {
        if (seenDeclared.has(tool.name)) continue;

        const nameOrder = normalized.nameOrder.get(tool.name);
        const exactName = nameOrder !== undefined;
        const regexName =
            normalized.pattern !== undefined &&
            matchesSelectionPattern(normalized.pattern, tool.name);

        let tagBest = 0;
        let tagHits = 0;

        for (const needle of normalized.tags) {
            const points = scoreDeclaredTool(tool, needle);
            if (points === 0) continue;

            tagHits += 1;
            if (points > tagBest) tagBest = points;
        }

        if (!exactName && !regexName && tagHits === 0) continue;

        seenDeclared.add(tool.name);
        declaredRanked.push({
            tool,
            group: exactName ? 2 : regexName ? 1 : 0,
            nameOrder: nameOrder ?? Number.MAX_SAFE_INTEGER,
            tagBest,
            tagHits
        });
    }

    const alreadyAvailable = rankSelection(declaredRanked);
    const result: ToolSelectionResult = {
        names: toolsMatch.map((match) => match.name),
        tools: toolsMatch
    };

    if (alreadyAvailable.length > 0) result.alreadyAvailable = alreadyAvailable;

    return result;
};
