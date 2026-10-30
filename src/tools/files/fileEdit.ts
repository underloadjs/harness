// fileEdit — replace text in one or more existing files in a single call.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A rename or a signature change touches several files. The schema declares ONE
// property, `edits`, so the single-property rule (see ../core/tool.ts) hands
// `execute` the array itself — `fileEdit([{ path, oldString, newString }])` — while
// a model call carries `{ "edits": [...] }` and reaches the same code.
//
// The safety property comes from the contract, not from a sandbox:
//
//   - oldString must be found, or the call fails (no silent no-op);
//   - oldString must appear exactly once, or the call fails (no "which one did you
//     mean?" guessing) — pass replaceAll to opt into every occurrence;
//   - oldString and newString must differ, or nothing was edited;
//   - the replacement must actually change the file, or the call fails (an edit
//     that matched through a fallback tier and rewrote identical bytes is an
//     honest error, not a silent success).
//
// MATCHING (ported from opencode's v2 edit tool)
// ----------------------------------------------
// Matching is EXACT first, with two narrow fallbacks and line-ending awareness —
// the same cascade opencode v2 uses, so a model that copies text out of fileRead
// (or retypes it with ASCII quotes) lands on the right bytes:
//
//   1. exact match against an LF view of the file: CRLF is folded to LF for
//      matching only, and match offsets are mapped back to the real source, so a
//      CRLF or mixed-ending file never blocks an edit whose oldString says "\n";
//   2. if tier 1 finds nothing, typographic variants are folded (curly quotes →
//      ASCII, en/em dashes → "-", NBSP and friends → space) on both sides — every
//      fold is one character to one, so offsets stay valid;
//   3. if tier 2 also finds nothing, whole-line matching ignores TRAILING
//      WHITESPACE on each line (compared through the same fold).
//
// Indentation is NEVER ignored: a wrong-indent oldString simply does not match,
// which is the failure mode opencode v1's indentation-flexible replacers got
// wrong (they silently rewrote Python at the model's indentation).
//
// Line endings are PRESERVED: the replacement's lines are re-joined with the
// endings of the matched region — a line that keeps a region line (longest common
// subsequence, compared like the trailing-whitespace tier) reuses that line's
// ending, a line that changes in place reuses the ending of the line it replaces,
// and only genuinely new lines take the region's dominant ending. Unchanged
// context inside a match therefore keeps its bytes even in a mixed-ending file.
// The one exception: oldString and newString that differ ONLY in carriage returns
// ask to change the line endings themselves, so that edit applies to exact bytes.
//
// PREFLIGHT — ALL-OR-NOTHING (this is what makes batching safe)
// ------------------------------------------------------------
// Before the first byte is written, EVERY edit is validated (shape, non-empty
// oldString, distinct oldString/newString, no NUL, UNIQUE target file) and EVERY
// file is read, match-checked, and fully computed. A failure anywhere — including
// on the last entry — therefore leaves every file untouched, which is why the
// batch can be trusted. Duplicate targets are rejected rather than merged: two
// edits to one file would both be computed from the same original text, so the
// second write would silently discard the first. Uniqueness is by FILE IDENTITY
// (./identity.ts), so on Windows two case spellings of one file — or a symlink
// alias — are caught as well.
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes happen after the preflight, sequentially. An OS error during the write
// phase may leave earlier files edited: there is NO transaction and NO rollback, and
// the error names the completed paths and the failing one.
//
// No sandbox: paths are resolved against the process working directory and used as
// given.
//
// Executable on its own and registerable on a harness:
//
//     await fileEdit([{ path: 'notes.md', oldString: '# Notes', newString: '# Log' }]);
//
// Metadata comes from ../catalogue so the description a model reads cannot drift
// from the tool that runs (see the note at the top of ../catalogue.ts).

import { readFile as readTextFile, writeFile as writeTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';
import { fileIdentity } from './identity';

// One replacement to apply.
export type FileEditEntry = {
    // Path to an existing file, absolute or relative to the working directory.
    path: string;
    // Exact text to replace. Must be unique unless replaceAll is true.
    oldString: string;
    // Replacement text. May be empty to delete the matched text.
    newString: string;
    // Opt into replacing every occurrence instead of requiring uniqueness.
    replaceAll?: boolean;
};

// The value `execute` receives: the `edits` array itself (single-property rule).
export type FileEditParameters = FileEditEntry[];

// One applied edit, in request order.
export type FileEditResultEntry = {
    // The absolute path that was edited.
    path: string;
    // How many occurrences were replaced (1 unless replaceAll matched more).
    replacements: number;
    // Size of the resulting UTF-8 payload, in bytes.
    bytes: number;
};

// The ordered result: one entry per requested edit, never a subset.
export type FileEditResult = FileEditResultEntry[];

// A region of the file that oldString matched, in SOURCE coordinates.
type Match = {
    start: number;
    end: number;
};

// Fold the typographic lookalikes a model tends to retype with: curly quotes to
// ASCII, fancy dashes to "-", exotic spaces to plain. Every replacement is one
// character to one, so normalized offsets still index the original text.
const normalizeForMatch = (value: string): string =>
    value
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');

// Non-overlapping occurrences of `search`, as offsets. indexOf-based splicing is
// used throughout the write path instead of String.replace so a "$&"-like sequence
// in newString is written literally rather than expanded.
const findOccurrences = (content: string, search: string): Match[] => {
    const result: Match[] = [];
    let offset = 0;

    while ((offset = content.indexOf(search, offset)) !== -1) {
        result.push({ start: offset, end: offset + search.length });
        offset += search.length;
    }

    return result;
};

// Whole-line occurrences that match once trailing whitespace is ignored (compared
// through the same typographic fold). `search` is the LF view, so lines split on
// "\n" only. Candidates that overlap an earlier one are dropped, so a repeated
// blank-line pattern cannot double-count the same region.
const findLineOccurrences = (content: string, search: string): Match[] => {
    const trailingNewline = search.endsWith('\n');
    const expected = search.split('\n');
    if (trailingNewline) expected.pop();

    const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
        .filter((match) => match[0] !== '')
        .map((match) => {
            const start = match.index ?? 0;
            const newline = match[0].endsWith('\n');
            const text = newline ? match[0].slice(0, -1) : match[0];

            return {
                start,
                end: start + match[0].length,
                text,
                contentEnd: start + text.length - (text.endsWith('\r') ? 1 : 0),
                newline
            };
        });

    const candidates = lines.flatMap((line, index) => {
        const actual = lines.slice(index, index + expected.length);
        if (actual.length !== expected.length) return [];

        if (
            !actual.every(
                (item, lineIndex) =>
                    normalizeForMatch(item.text.trimEnd()) ===
                    normalizeForMatch(expected[lineIndex].trimEnd())
            )
        )
            return [];

        const last = actual[actual.length - 1];
        if (trailingNewline && !last.newline) return [];

        return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
    });

    return candidates.reduce<Match[]>((result, candidate) => {
        if (result.some((match) => match.end > candidate.start && match.start < candidate.end))
            return result;
        result.push(candidate);
        return result;
    }, []);
};

// The dominant line ending in `text`, or `fallback` when neither wins.
const lineEnding = (text: string, fallback: string): string => {
    const crlfCount = text.split('\r\n').length - 1;
    const lfCount = text.split('\n').length - 1 - crlfCount;
    if (crlfCount === lfCount) return fallback;
    return crlfCount > lfCount ? '\r\n' : '\n';
};

// For each line of `after`, the index of the `before` line it keeps (longest
// common subsequence) or, between kept lines, the line it takes the place of;
// undefined for lines with no counterpart.
const alignLines = (before: string[], after: string[]): (number | undefined)[] => {
    const width = after.length + 1;
    const table = new Uint32Array((before.length + 1) * width);
    for (let i = before.length - 1; i >= 0; i--)
        for (let j = after.length - 1; j >= 0; j--)
            table[i * width + j] =
                before[i] === after[j]
                    ? table[(i + 1) * width + j + 1] + 1
                    : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);

    const result: (number | undefined)[] = [];
    const gap = { before: [] as number[], after: [] as number[] };
    const flush = () => {
        gap.after.forEach((j, k) => (result[j] = gap.before[k]));
        gap.before = [];
        gap.after = [];
    };

    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            flush();
            result[j++] = i++;
            continue;
        }
        if (table[(i + 1) * width + j] >= table[i * width + j + 1]) gap.before.push(i++);
        else gap.after.push(j++);
    }
    while (i < before.length) gap.before.push(i++);
    while (j < after.length) gap.after.push(j++);
    flush();

    return result;
};

// Re-join the replacement's lines with the endings of the matched region: a
// replacement line that keeps a region line reuses that line's ending, a line that
// changes in place reuses the ending of the line it replaces, and only lines
// beyond those take `fallback`. Unchanged context inside a match therefore keeps
// its bytes even in a mixed-ending file.
const withRegionEndings = (region: string, replacement: string, fallback: string): string => {
    const before = region.split(/\r?\n/);
    const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0]);
    const after = replacement.split('\n');
    const key = (line: string): string => normalizeForMatch(line.trimEnd());
    const source = alignLines(before.map(key), after.map(key));

    return after
        .map((line, index) => {
            if (index === after.length - 1) return line;
            const aligned = source[index];
            return line + (aligned === undefined ? fallback : (endings[aligned] ?? fallback));
        })
        .join('');
};

// Number of sorted positions strictly before `offset`.
const countBefore = (positions: number[], offset: number): number => {
    let low = 0;
    let high = positions.length;

    while (low < high) {
        const middle = (low + high) >> 1;
        if (positions[middle] < offset) low = middle + 1;
        else high = middle;
    }

    return low;
};

// Match against the LF view, then map offsets back to the source, so CRLF and
// mixed line endings neither block matches nor leak into untouched regions. The
// fallback tiers only run when the tier above found NOTHING, so an exact match is
// never displaced by a looser one.
const matchView = (
    source: string,
    oldString: string,
    newString: string
): { matches: Match[]; replace: (match: Match) => string } => {
    // split/join, not replaceAll: the declared `lib` predates ES2021.
    const view = source.split('\r\n').join('\n');
    // View offset of every CRLF; adding the count strictly before an offset maps
    // view coordinates back to source coordinates (the fold is one-to-one).
    const removed = [...source.matchAll(/\r\n/g)].map((match, index) => (match.index ?? 0) - index);
    const fileEnding = lineEnding(source, '\n');
    const search = oldString.split('\r\n').join('\n');
    const replacement = newString.split('\r\n').join('\n');

    const exact = findOccurrences(view, search);
    const unicode =
        exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
    const trailing =
        exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search);

    const found = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing;

    return {
        matches: found.map((match) => ({
            start: match.start + countBefore(removed, match.start),
            end: match.end + countBefore(removed, match.end)
        })),
        replace: (match: Match) => {
            const region = source.slice(match.start, match.end);
            return withRegionEndings(region, replacement, lineEnding(region, fileEnding));
        }
    };
};

// A validated edit whose target has been resolved: what the read/match pass needs.
type NormalizedEdit = {
    target: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
};

// A validated, match-checked edit: everything the write phase needs. The full
// updated text is computed during the preflight, so the write phase never
// re-reads or re-matches.
type PreparedEdit = {
    target: string;
    updated: string;
    replacements: number;
};

// Validate the shape of every entry, resolve every target, and reject duplicates.
// Kept separate from the read/match pass so shape errors are reported before any
// filesystem work at all. The duplicate check does read (`realpath`), because two
// spellings of one existing file must collide on every platform — see
// ./identity.ts for the rule and for why only win32 folds case.
const normalizeEdits = async (edits: FileEditParameters): Promise<NormalizedEdit[]> => {
    if (!Array.isArray(edits)) {
        throw new HarnessError(
            'fileEdit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
    }

    if (edits.length === 0) {
        throw new HarnessError('fileEdit received an empty edits array; pass at least one edit.');
    }

    const normalized: NormalizedEdit[] = [];
    const seen = new Set<string>();

    for (const entry of edits) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError(
                'fileEdit edits must be objects with "path", "oldString", and "newString" strings.'
            );
        }

        const { path, oldString, newString, replaceAll } = entry as Partial<FileEditEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileEdit edits require a non-empty "path" string.');
        }

        if (path.includes('\u0000')) {
            throw new HarnessError('fileEdit paths must not contain NUL characters.');
        }

        if (typeof oldString !== 'string' || oldString.length === 0) {
            // An empty oldString matches everywhere (including between every pair of
            // characters), so it is never a meaningful edit.
            throw new HarnessError('fileEdit requires a non-empty oldString.');
        }

        if (typeof newString !== 'string') {
            throw new HarnessError('fileEdit requires a "newString" string.');
        }

        // Rejecting a no-op keeps "the edit applied" an honest claim: a model that
        // passes the same text twice has not changed anything.
        if (oldString === newString) {
            throw new HarnessError(
                'fileEdit did not change the file: oldString and newString are identical.'
            );
        }

        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
            throw new HarnessError('fileEdit replaceAll must be a boolean when provided.');
        }

        const target = resolve(path);

        // Two edits to one file would both be computed from the same original text,
        // so the second write would discard the first. Reject rather than guess.
        // The message names the resolved path; the comparison uses the real file
        // identity, so `a.txt`/`A.TXT` (Windows) and symlink aliases collide too.
        const identity = await fileIdentity(target);

        if (seen.has(identity)) {
            throw new HarnessError(
                `fileEdit received the same target path twice (${target}); make one edit per file per call.`
            );
        }

        seen.add(identity);
        normalized.push({ target, oldString, newString, replaceAll: replaceAll === true });
    }

    return normalized;
};

// Read, match-check, and fully compute every edit. Nothing is written here, so a
// failure on the last entry still leaves the first file untouched.
const prepareEdits = async (edits: NormalizedEdit[]): Promise<PreparedEdit[]> => {
    const prepared: PreparedEdit[] = [];

    for (const edit of edits) {
        // A missing or unreadable file throws straight out of the read: editing is
        // for existing files, and fileWrite is the tool that creates.
        const content = await readTextFile(edit.target, 'utf8');

        // oldString and newString that differ ONLY in carriage returns ask to change
        // the file's line endings themselves, so that edit applies to the exact
        // bytes instead of the LF view. Every other edit matches the LF view and
        // keeps the file's endings.
        const endingsOnly =
            edit.oldString.split('\r').join('') === edit.newString.split('\r').join('');

        const { matches, replace } = endingsOnly
            ? { matches: findOccurrences(content, edit.oldString), replace: () => edit.newString }
            : matchView(content, edit.oldString, edit.newString);

        if (matches.length === 0) {
            throw new HarnessError(
                `fileEdit found no match for oldString in ${edit.target}. Read the file first and copy the text exactly, including indentation.`
            );
        }

        if (matches.length > 1 && !edit.replaceAll) {
            throw new HarnessError(
                `fileEdit found ${matches.length} matches for oldString in ${edit.target}. Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            );
        }

        // Splice right-to-left so earlier match offsets stay valid through every
        // replacement. Without replaceAll only the single unique match is applied.
        const chosen = edit.replaceAll ? matches : matches.slice(0, 1);
        const updated = chosen
            .slice()
            .reverse()
            .reduce(
                (text, match) => text.slice(0, match.start) + replace(match) + text.slice(match.end),
                content
            );

        // A fallback tier can match text that already equals newString (for example
        // curly quotes in the file against an ASCII oldString and a curly newString).
        // Saying "applied" then would be dishonest, so the edit is rejected.
        if (updated === content) {
            throw new HarnessError(
                `fileEdit did not change ${edit.target}: the replacement text is identical to the text it matched. Line endings follow the file; to change them, pass oldString and newString that differ only in carriage returns.`
            );
        }

        prepared.push({ target: edit.target, updated, replacements: chosen.length });
    }

    return prepared;
};

export const fileEdit = tool<FileEditParameters, FileEditResult>({
    ...PRESET_TOOLS.fileEdit,
    execute: async ({ parameters: edits }) => {
        const normalized = await normalizeEdits(edits);
        const prepared = await prepareEdits(normalized);
        const results: FileEditResultEntry[] = [];

        for (const edit of prepared) {
            try {
                // No mkdir: the parent must already exist, because the file did.
                await writeTextFile(edit.target, edit.updated, 'utf8');
            } catch (error) {
                // Partial success is reported honestly: the completed paths are
                // named, and there is no claim of a transaction or rollback.
                const completed = results.length === 0 ? 'none' : results.map((entry) => entry.path).join(', ');
                const reason = error instanceof Error ? error.message : String(error);

                throw new HarnessError(
                    `fileEdit failed on ${edit.target}: ${reason} Edits already applied: ${completed}. No rollback was performed.`
                );
            }

            results.push({
                path: edit.target,
                replacements: edit.replacements,
                bytes: Buffer.byteLength(edit.updated, 'utf8')
            });
        }

        return results;
    }
});
