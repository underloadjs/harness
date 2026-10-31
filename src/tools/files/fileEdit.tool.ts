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
// SEVERAL HUNKS PER FILE (T20)
// ----------------------------
// Entries are applied in REQUEST ORDER, and a later entry naming the same file is
// matched against the text the previous one produced, so one call can change
// several places in one file instead of forcing a whole-file rewrite. Entries are
// grouped by FILE IDENTITY (./identity.ts), so on Windows two case spellings of
// one file — or a symlink alias — are one file with a defined order rather than
// two writes where the last would silently win.
//
// PREFLIGHT — ALL-OR-NOTHING (this is what makes batching safe)
// ------------------------------------------------------------
// Before the first byte is written, EVERY edit is validated (shape, non-empty
// oldString, distinct oldString/newString, no NUL) and EVERY file is read,
// match-checked, and fully computed — a failure anywhere, including on the last
// entry, therefore leaves every file untouched, which is why the batch can be
// trusted. Each file is then written exactly ONCE with its final text.
//
// The result reports, per entry, HOW the oldString matched: exact byte-for-byte
// (nothing extra in the result), or one of the two fallback tiers, which is named
// in `match`. A model that retyped a quote instead of copying it still gets its
// edit, but it is told the match was not byte-exact, so the difference is visible
// instead of silent.
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
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { readFile, writeFile as writeTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
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
    // How many occurrences this entry replaced (1 unless replaceAll matched more).
    replacements: number;
    // Size of the file's UTF-8 payload after this call, in bytes. Entries that
    // share a file report the same final size, because a file is written once.
    bytes: number;
    // HOW oldString matched. Omitted when the match was byte-exact, which is the
    // normal case; present when a fallback tier had to be used, so a model learns
    // that it retyped a quote or trailing whitespace instead of copying it. The
    // edit still applied - the file now holds newString.
    match?: FileEditMatch;
};

// The matching tier that produced an edit: typographic folding, or whole-line
// matching that ignored trailing whitespace. An exact byte match reports nothing.
export type FileEditMatch = 'typographic' | 'trailing-whitespace';

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

// 1-based line numbers of each match start, so an ambiguity error can say WHERE
// the candidates are instead of only how many. Cheap: the text is already in
// memory, and only the newlines before each start are counted.
const lineNumbers = (content: string, matches: Match[]): number[] =>
    matches.map((match) => content.slice(0, match.start).split('\n').length);

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
// never displaced by a looser one. `tier` names the tier that produced the match,
// so the result can report that a fallback was used; undefined means exact bytes.
const matchView = (
    source: string,
    oldString: string,
    newString: string
): { matches: Match[]; tier?: FileEditMatch; replace: (match: Match) => string } => {
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
    const tier: FileEditMatch | undefined =
        exact.length > 0 ? undefined : unicode.length > 0 ? 'typographic' : 'trailing-whitespace';

    return {
        matches: found.map((match) => ({
            start: match.start + countBefore(removed, match.start),
            end: match.end + countBefore(removed, match.end)
        })),
        tier,
        replace: (match: Match) => {
            const region = source.slice(match.start, match.end);
            return withRegionEndings(region, replacement, lineEnding(region, fileEnding));
        }
    };
};

// A validated edit whose target has been resolved: what the read/match pass needs.
type NormalizedEdit = {
    target: string;
    // Canonical file identity (./identity.ts), so two spellings of one file group
    // together and are written once.
    identity: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
};

// A validated, match-checked edit: what the write phase needs. The text is
// computed during the preflight, so the write phase never re-reads or re-matches.
type PreparedEdit = {
    target: string;
    identity: string;
    replacements: number;
    match?: FileEditMatch;
};

// One distinct file's final text. A file appears once however many entries named
// it, because it is written once.
type PreparedFile = {
    target: string;
    identity: string;
    updated: string;
};

// Validate the shape of every entry and resolve every target. Kept separate from
// the read/match pass so shape errors are reported before any filesystem work at
// all. The identity lookup does read (`realpath`), because two spellings of one
// existing file must group together on every platform — see ./identity.ts for the
// rule and for why only win32 folds case.
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

        // Group entries by REAL FILE IDENTITY (./identity.ts): `a.txt`/`A.TXT` on
        // Windows, or a symlink alias, are one file with one write. Request order is
        // preserved inside the group, so a later entry is matched against the text
        // the earlier one produced — several hunks in one file in one call.
        const identity = await fileIdentity(target);

        normalized.push({
            target,
            identity,
            oldString,
            newString,
            replaceAll: replaceAll === true
        });
    }

    return normalized;
};

// Read, match-check, and fully compute every edit. Nothing is written here, so a
// failure on the last entry still leaves the first file untouched. Each file is
// read ONCE; its entries are applied in request order to the text the previous one
// produced, so several hunks in one file need one call and one write.
const prepareEdits = async (
    edits: NormalizedEdit[]
): Promise<{ prepared: PreparedEdit[]; files: PreparedFile[] }> => {
    // Current text per file identity, filled on first use. Kept separate from the
    // result array so a later entry sees the earlier entry's output.
    const texts = new Map<string, { target: string; content: string }>();
    const prepared: PreparedEdit[] = [];

    for (const edit of edits) {
        let state = texts.get(edit.identity);

        if (state === undefined) {
            // A missing, unreadable, or non-file target fails here, before anything
            // is written. Editing is for existing files; fileWrite creates.
            state = { target: edit.target, content: await readFile(edit.target, 'utf8') };
            texts.set(edit.identity, state);
        }

        const content = state.content;

        // oldString and newString that differ ONLY in carriage returns ask to change
        // the file's line endings themselves, so that edit applies to the exact
        // bytes instead of the LF view. Every other edit matches the LF view and
        // keeps the file's endings.
        const endingsOnly =
            edit.oldString.split('\r').join('') === edit.newString.split('\r').join('');

        const { matches, replace, tier } = endingsOnly
            ? { matches: findOccurrences(content, edit.oldString), replace: () => edit.newString, tier: undefined }
            : matchView(content, edit.oldString, edit.newString);

        if (matches.length === 0) {
            throw new HarnessError(
                `fileEdit found no match for oldString in ${edit.target}. Read the file first and copy the text exactly, including indentation.`
            );
        }

        if (matches.length > 1 && !edit.replaceAll) {
            // Naming the lines is what makes the failure actionable: a model can
            // copy more surrounding text from a line it can actually locate.
            throw new HarnessError(
                `fileEdit found ${matches.length} matches for oldString in ${edit.target} (lines ${lineNumbers(content, matches).join(', ')}). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
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

        prepared.push({ target: edit.target, identity: edit.identity, replacements: chosen.length, match: tier });

        // Feed the result back so the next entry for this file matches against it.
        state.content = updated;
    }

    // One write per distinct file, in first-appearance order.
    const files: PreparedFile[] = [...texts.entries()].map(([identity, state]) => ({
        target: state.target,
        identity,
        updated: state.content
    }));

    return { prepared, files };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_EDIT_METADATA: PresetToolMetadata = {
    name: 'fileEdit',
    description:
        'Replace text in one or more existing files. Pass an array of { path, oldString, newString } entries; oldString must match exactly, including whitespace and indentation, and must identify a unique location unless replaceAll is true, so an ambiguous edit is rejected instead of changing the wrong place. Several entries may name the SAME file: they are applied in array order, each matched against the text the previous one produced, so one call can change several places in one file and each file is still written once. Line endings are matched and preserved: write oldString and newString with \\n even for a CRLF file. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line; otherwise it fails. Every entry is read and checked before anything is written, so one bad entry leaves every file unchanged. Returns an ordered array of { path, replacements, bytes, match? }, where `match` is present only when a fallback tier was used ("typographic" or "trailing-whitespace"), so a fuzzy match is never silent. Creates nothing: use fileWrite for new files.',
    tags: ['files', 'edit', 'write', 'replace', 'filesystem'],
    // R18: editing files is core, so a model never spends a discovery round on it.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description:
                                'Path to an existing file, absolute or relative to the working directory.'
                        },
                        oldString: {
                            type: 'string',
                            description:
                                'Exact text to replace. Must be unique unless replaceAll is true.'
                        },
                        newString: {
                            type: 'string',
                            description:
                                'Replacement text. May be empty to delete the matched text.'
                        },
                        replaceAll: {
                            type: 'boolean',
                            description:
                                'Replace every occurrence instead of requiring oldString to be unique. Defaults to false.'
                        }
                    },
                    required: ['path', 'oldString', 'newString'],
                    additionalProperties: false
                },
                description:
                    'Edits to apply, in the order the results are returned. Several entries may name the same file; they are applied in array order.',
            }
        },
        required: ['edits'],
        additionalProperties: false
    }
};

export const fileEdit = tool<FileEditParameters, FileEditResult>({
    ...FILE_EDIT_METADATA,
    execute: async ({ parameters: edits }) => {
        const normalized = await normalizeEdits(edits);
        // Everything below this line has been validated and matched; nothing has been
        // written yet, so any throw above left every file untouched.
        const { prepared, files } = await prepareEdits(normalized);

        // Byte size per file IDENTITY, so entries sharing a file (including two
        // spellings of one path) report the same final size rather than each other's
        // intermediate text.
        const sizes = new Map<string, number>();
        const written: string[] = [];

        for (const file of files) {
            try {
                // No mkdir: the parent must already exist, because the file did.
                await writeTextFile(file.target, file.updated, 'utf8');
            } catch (error) {
                // Partial success is reported honestly: the completed paths are
                // named, and there is no claim of a transaction or rollback.
                const completed = written.length === 0 ? 'none' : written.join(', ');
                const reason = error instanceof Error ? error.message : String(error);

                throw new HarnessError(
                    `fileEdit failed on ${file.target}: ${reason} Edits already applied: ${completed}. No rollback was performed.`
                );
            }

            written.push(file.target);
            sizes.set(file.identity, Buffer.byteLength(file.updated, 'utf8'));
        }

        // One entry per requested edit, in request order: entries that share a file
        // each report their own replacement count against that file's final size.
        return prepared.map((edit) => {
            const entry: FileEditResultEntry = {
                path: edit.target,
                replacements: edit.replacements,
                bytes: sizes.get(edit.identity) ?? 0
            };

            // Only mention the tier when it was not exact, so the common case stays
            // terse and a fuzzy match is never silent.
            if (edit.match !== undefined) entry.match = edit.match;

            return entry;
        });
    }
});
