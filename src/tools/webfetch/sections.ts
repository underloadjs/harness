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
): { matches: SectionMatch[]; totalSections: number; totalMatches: number } => {
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

    return { matches, totalSections: sections.length, totalMatches };
};
