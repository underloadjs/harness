// fetch — section selection for the optional `query` argument.
//
// WHY A SEPARATE MODULE
// ---------------------
// `query` is the "fetch + grep" mode: one call returns the paragraphs the caller
// actually asked about instead of the whole document. The selection runs on
// CONVERTED content, so it is useful for every provider — a hosted crawler hands
// back markdown with headings just like the native converter does. Keeping it
// here means ./index can reach it without importing ./native (and therefore
// without pulling the native GET transport onto a hosted-provider call).
//
// WHY SECTIONS AND NOT LINES
// --------------------------
// `grep` already exists for line matching. A heading is the unit that carries
// MEANING: a matched line with no heading around it is a quote with no context,
// and a model given a bare line will either ask again or guess. Splitting at
// markdown headings means every returned block is self-describing.
//
// A fenced code block is never split: the fence toggle is tracked, so a ```
// region stays inside the section that opened it and a code sample cannot be
// cut in half between two matches.
//
// MATCHING IS A LITERAL SUBSTRING, CASE-INSENSITIVE — not a regular expression.
// The argument is a phrase a model types from memory, and an unescaped `(` in it
// would otherwise turn a useful call into a syntax error. A caller wanting regex
// power has `download` (bytes to the session folder) plus `grep` over the file.

export type Section = {
    heading: string;
    // 0-based line the section starts on, and the line it ends at.
    start: number;
    end: number;
};

export type SectionMatch = {
    heading: string;
    text: string;
    line: number;
};

// How a `query` answer was produced. Reported to the caller because the two
// modes have very different costs and the caller must be able to tell a precise
// hit from a best-effort excerpt (see selectProximity).
export type MatchMode = 'heading' | 'proximity';

// A document with this few headings has no usable section structure, so
// "return the matching sections" degenerates into "return the whole document".
// Measured: an RFC plain-text page (one pseudo-section, 502,906 characters) and
// a raw-HTML book chapter (two sections, 50,406 characters) both came back
// essentially undiminished while still reporting `matches: 1`, which read like a
// precise hit and was not one.
export const FLAT_DOCUMENT_SECTIONS = 2;

// How much text a proximity window may carry. This is the whole point of the
// mode: a flat page must cost a window, not a document.
export const PROXIMITY_WINDOW_CHARS = 6_000;

const FENCE = /^\s*(?:```|~~~|`{4,}|~{4,})/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

// Split converted content at markdown headings. Content before the first
// heading is its own section (a page that opens with prose has nowhere else to
// put it), and an empty section is dropped rather than returned as a blank block.
export const splitSections = (content: string): Section[] => {
    const lines = content.split('\n');
    const sections: Section[] = [];

    let heading = '';
    let start = 0;
    let inFence = false;

    for (let index = 0; index < lines.length; index += 1) {
        if (FENCE.test(lines[index])) inFence = !inFence;
        if (inFence) continue;

        const match = HEADING.exec(lines[index]);
        if (match === null) continue;

        if (index > start || sections.length === 0) {
            sections.push({ heading, start, end: index });
        }

        heading = match[2];
        start = index;
    }

    sections.push({ heading, start, end: lines.length });

    return sections.filter((section) => section.end > section.start);
};

// Non-overlapping occurrences of `needle` in an already-lowercased haystack.
// Same scan selectProximity uses for `totalMatches`, so both modes count hits the
// same way (a needle that cannot advance stops the loop rather than spinning).
const countOccurrences = (haystack: string, needle: string): number => {
    if (needle.length === 0) return 0;

    let count = 0;

    for (let at = haystack.indexOf(needle); at !== -1; ) {
        count += 1;

        const next = haystack.indexOf(needle, at + needle.length);
        at = next === -1 || next === at ? -1 : next;
    }

    return count;
};

// Hits per character of the section: the ranking `selectSections` orders by.
// A 4 KB section with 3 hits (7.5e-4) outranks a 39 KB one with the same 3 hits
// (7.6e-5). The measured motivation (issue 0016): on a Wikipedia article about
// quantum error correction, the `## References` section was ~39,600 of the
// 52,643 characters returned (75% of the answer) because a link-heavy reference
// list contains almost any phrase — length, not relevance, was buying it the slot.
//
// Both sides are measured on the text the caller actually RECEIVES (trimmed):
// ranking on the raw slice would let a one-character difference in trailing
// whitespace reorder two otherwise identical sections, which turns a stable
// document order into an ordering nobody chose.
//
// The denominator includes the heading so a section matched ONLY by its heading
// still ranks — a 0-hit body of any length would otherwise score 0 and sink.
const matchDensity = (text: string, heading: string, needle: string): number => {
    const hits = countOccurrences(text.toLowerCase(), needle) + countOccurrences(heading.toLowerCase(), needle);

    return hits / Math.max(1, text.length + heading.length);
};

// The sections whose heading or body contains the phrase. Matching is on the
// WHOLE section text, so a hit anywhere in a block returns that block with its
// heading — the context is the point, not the line.
//
// `maxBlocks` bounds the answer: a one-word query against a long page would
// otherwise match most of it and smuggle the whole document back past every
// bound the tool just applied.
//
// WHICH blocks survive the cap is a ranking decision (issue 0016). Taking the
// first 20 in DOCUMENT order means the cap is won by whatever appears earliest,
// and on a long article that is the lead plus a link-heavy References block.
// Sections are therefore ordered by match density BEFORE the cap is applied, so
// the blocks that are dropped are the ones that matched because they are long.
// This deprioritizes, never excludes: a section is still returned whenever it
// matches (a `query="Bibcode"` call must still answer with References and
// External links), and equal densities keep document order — the sort breaks
// ties on the section's line, so a one-hit-per-heading query behaves exactly as
// it did before whenever the sections are the same size.
export const selectSections = (
    content: string,
    query: string,
    maxBlocks: number
): { matches: SectionMatch[]; totalSections: number; totalMatches: number; matchMode: MatchMode } => {
    const sections = splitSections(content);
    const needle = query.toLowerCase();
    const lines = content.split('\n');

    // Every matching section, ranked. `raw` (not the trimmed text) is what the
    // match test and the density denominator use, so trimming can never change
    // which sections match or how they measure.
    const ranked = sections
        .map((section) => {
            const raw = lines.slice(section.start, section.end).join('\n');

            return { section, raw };
        })
        .filter(
            ({ section, raw }) =>
                section.heading.toLowerCase().includes(needle) || raw.toLowerCase().includes(needle)
        )
        .map(({ section, raw }) => {
            // The trimmed text is BOTH what the caller receives and what the ranking
            // measures, so two sections with the same content measure the same.
            const text = raw.trim();

            return {
                heading: section.heading,
                text,
                line: section.start,
                density: matchDensity(text, section.heading, needle)
            };
        })
        // Densest first; identical densities keep document order.
        .sort((left, right) => right.density - left.density || left.line - right.line);

    return {
        matches: ranked.slice(0, maxBlocks).map(({ heading, text, line }) => ({ heading, text, line })),
        totalSections: sections.length,
        totalMatches: ranked.length,
        matchMode: 'heading'
    };
};

// The fallback for a document with no heading structure: one window of text
// centred on the first occurrence of the phrase.
//
// WHY THIS EXISTS
// ---------------
// `selectSections` is only a filter when the content HAS sections. Plain text,
// CSV, JSON, and raw HTML markup convert to one or two "sections", so a `query`
// against them returned the entire document while reporting `matches: 1` — the
// caller paid full price, got no narrowing, and had no way to know the filter
// had not done anything. This answers the same question at window cost.
//
// The window is centred so the phrase lands mid-block with context on both
// sides; a caller reading a hit wants the sentences around it, not the hit at
// character zero. The heading label is the nearest preceding markdown heading
// when one exists, so the block is still self-describing.
export const selectProximity = (
    content: string,
    query: string,
    windowChars = PROXIMITY_WINDOW_CHARS
): { matches: SectionMatch[]; totalSections: number; totalMatches: number; matchMode: MatchMode } => {
    const sections = splitSections(content);
    const needle = query.toLowerCase();
    const haystack = content.toLowerCase();

    const at = haystack.indexOf(needle);
    if (at === -1) {
        return { matches: [], totalSections: sections.length, totalMatches: 0, matchMode: 'proximity' };
    }

    // Count every occurrence, so `totalMatches` still means "how many hits exist"
    // across both modes rather than silently changing units.
    let totalMatches = 0;
    for (let scan = at; scan !== -1; ) {
        totalMatches += 1;
        const next = haystack.indexOf(needle, scan + needle.length);
        scan = next === -1 || next === scan ? -1 : next;
    }

    const start = Math.max(0, Math.floor(at - windowChars / 2));
    const end = Math.min(content.length, start + windowChars);

    // Snap to line boundaries so a window never opens or closes mid-word, which
    // is what makes a returned excerpt readable rather than a puzzle. A page with
    // no newlines at all (one giant line) has nothing to snap to, so the raw
    // character window is used there rather than collapsing to an empty block.
    const openLine = content.lastIndexOf('\n', start);
    const from = openLine === -1 ? start : openLine + 1;
    const nextBreak = content.indexOf('\n', end);
    const to = nextBreak === -1 ? content.length : nextBreak;

    const before = content.slice(0, at);
    const line = before.split('\n').length - 1;

    // Nearest preceding heading, if the document has any.
    let heading = '';
    for (const section of sections) {
        if (section.start <= line && section.heading.length > 0) heading = section.heading;
    }

    return {
        matches: [{ heading, text: content.slice(from, to).trim(), line }],
        totalSections: sections.length,
        totalMatches,
        matchMode: 'proximity'
    };
};
