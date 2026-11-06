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

// The sections whose heading or body contains the phrase. Matching is on the
// WHOLE section text, so a hit anywhere in a block returns that block with its
// heading — the context is the point, not the line.
//
// `maxBlocks` bounds the answer: a one-word query against a long page would
// otherwise match most of it and smuggle the whole document back past every
// bound the tool just applied.
export const selectSections = (
    content: string,
    query: string,
    maxBlocks: number
): { matches: SectionMatch[]; totalSections: number; totalMatches: number; matchMode: MatchMode } => {
    const sections = splitSections(content);
    const needle = query.toLowerCase();
    const lines = content.split('\n');
    const matches: SectionMatch[] = [];
    let totalMatches = 0;

    for (const section of sections) {
        const text = lines.slice(section.start, section.end).join('\n');

        if (!section.heading.toLowerCase().includes(needle) && !text.toLowerCase().includes(needle)) {
            continue;
        }

        totalMatches += 1;

        if (matches.length < maxBlocks) {
            matches.push({ heading: section.heading, text: text.trim(), line: section.start });
        }
    }

    return { matches, totalSections: sections.length, totalMatches, matchMode: 'heading' };
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
