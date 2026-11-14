// edit — replace text in one or more existing files in a single call.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A rename or a signature change touches several files. The schema declares ONE
// property, `edits`, so the single-property rule (see ../core/tool.ts) hands
// `execute` the array itself — `edit([{ path, oldString, newString }])` — while
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
// the same cascade opencode v2 uses, so a model that copies text out of read
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
// Line endings are PRESERVED for a LF-only newString: the replacement's lines are
// re-joined with the endings of the matched region — a line that keeps a region line
// (longest common subsequence, compared like the trailing-whitespace tier) reuses that
// line's ending, a line that changes in place reuses the ending of the line it
// replaces, and only genuinely new lines take the region's dominant ending. Unchanged
// context inside a match therefore keeps its bytes even in a mixed-ending file. That is
// the documented default — "write oldString and newString with \n even for a CRLF
// file" — and it means a LF-only newString on a CRLF file COMES BACK AS CRLF: the file
// decides the endings, not the caller.
//
// THE ENDING-EXPLICIT RULE (H6). A newString that contains a carriage return says what
// endings the caller wants, so its bytes are written VERBATIM: no fold to LF, no region
// re-joining. Before this rule the fold deleted every "\r\n" in newString (so an
// explicit CRLF on an LF file silently became LF) and left every LONE "\r" behind,
// which the region join then put next to a real ending — "A\r\r\nB" came back as the
// bytes 41 0d 0d 0a on a CRLF file and as 41 0d 0a on an LF file, i.e. the tool invented
// a carriage return the caller never asked for. Two shapes follow from writing the
// caller's bytes literally, and both are honest rather than silent: a newString ending
// in a lone "\r" sits beside the file's own CR ("B\r" on a CRLF file gives 42 0d 0d 0a,
// because the matched span did not include that CR), and a mixed newString keeps the
// endings it spells instead of adopting the file's. To convert endings explicitly, pass
// oldString and newString that differ ONLY in carriage returns — that edit matches exact
// bytes — or spell every ending in newString.
//
// WHAT THE TRAILING-WHITESPACE TIER REPLACES (M4). That tier compares whole lines with
// trailing whitespace ignored, so its match is the WHOLE LINE SPAN, not the caller's
// oldString: replacing "a\nb" in "a   \nb\t\t\nz\n" removes the two tabs on the second
// line too, because they were inside the matched lines. The tier is reported as
// `match: "trailing-whitespace"` so the widening is visible, and the behaviour is pinned
// by tests rather than incidental.
//
// ENCODING — UTF-8 ONLY, REFUSED IN PREFLIGHT (H7). The file is read as BYTES and must
// decode as UTF-8 with no NUL byte. A non-UTF-8 file used to round-trip lossily: the
// bytes 63 61 66 e9 20 78 ("café x" in Latin-1) came back as 43 61 66 ef bf bd 20 78,
// eight bytes reported as a plain success, because `readFile(path,'utf8')` substitutes
// U+FFFD for bytes it cannot decode and the write encodes the substitution. Now such a
// file is refused with EBINARY naming the byte offset of the offending sequence — the
// same contract `read` publishes — and the refusal happens during the preflight, so an
// unreadable file in a batch leaves every earlier file untouched. A leading BOM is kept
// (ignoreBOM), so a successful edit writes the file back byte for byte.
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
// oldString, distinct oldString/newString, no NUL) and EVERY file is read, DECODED
// (valid UTF-8 with no NUL byte — see "ENCODING" above), match-checked, and fully
// computed — a failure anywhere, including on the last entry, therefore leaves every
// file untouched, which is why the batch can be trusted. Each file is then written
// exactly ONCE with its final text.
//
// ONE CRITICAL SECTION PER FILE (D4: no lost update)
// --------------------------------------------------
// Read-match-write is three awaits, so two overlapping calls used to read the same
// original text, both match, both report success, and the last write silently wins.
// The whole read/match/write span is therefore held under a per-file lock
// (./lock.ts), keyed by FILE IDENTITY so two spellings of one file share it. A later
// call now sees the earlier call's text and fails honestly ("edit found no match")
// instead of clobbering a change it never saw. A multi-file batch takes its locks in
// sorted identity order, so two overlapping batches cannot deadlock.
//
// BOUNDED BATCHES (M12)
// --------------------
// One call carries at most FILE_EDIT_MAX_TARGETS (100) entries, the cap `read`, `write`
// and `files` already publish. Without it a single call could name an arbitrary number of
// files, hold a lock on every one of them, and return an unbounded result array — the
// response size of a batched tool should be bounded by the contract, not by luck. The cap
// is enforced BEFORE any validation or filesystem work, so a refused batch reads nothing,
// writes nothing, and never appears to have applied the first 100 entries.
//
// BOUNDED WORK ON THE FAILURE AND replaceAll PATHS
// ------------------------------------------------
// A broad oldString can match an order of magnitude more often than a model meant,
// so nothing on those paths may scale with matches x file size. The candidate line
// numbers are collected in ONE forward pass over the text (not one prefix copy per
// match), the ambiguity message NAMES only the first AMBIGUITY_LINE_LIMIT of them
// (the count stays exact), and replaceAll splices by collecting the gaps and joining
// ONCE (not one whole-file rebuild per match). The trailing-whitespace tier is a
// single forward pass with a ring of `expected.length` line keys, not one object per
// line plus one array slice per candidate position: that tier runs on EVERY miss, so
// an allocation proportional to the file's line count made "the text is not here" the
// most expensive answer this tool gives (measured on a 120 MB file: 2,390 ms -> 951 ms
// for a one-line search, 2,324 ms -> 1,113 ms for a three-line search, verified
// side-by-side in one process against byte-identical output on 20 line shapes).
// All three were quadratic, and because
// this tool is declared `mode: 'sync'` and the server defaults to
// `threadExecution: 'inline'`, a quadratic tool body stalls the whole process.
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
//     await edit([{ path: 'notes.md', oldString: '# Notes', newString: '# Log' }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { readFile, stat, writeFile as writeTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// How many entries one `edit` call may carry. `read`, `write` (./write.tool.ts:114) and
// `files` all cap a batch at 100; `edit` carried none (M12), so a single call could name
// an arbitrary number of files, take a lock on every one of them, and return a result
// array of arbitrary length. Enforced in `normalizeEdits` BEFORE any validation or
// filesystem work, so a refused batch reads nothing and writes nothing.
export const FILE_EDIT_MAX_TARGETS = 100;

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

// The whole-line key used by the trailing-whitespace tier: the line with its
// trailing whitespace dropped and the typographic lookalikes folded. Shared by the
// expected lines and the file lines so the two sides can never be compared through
// different rules.
const lineKey = (line: string): string => normalizeForMatch(line.trimEnd());

// Whole-line occurrences that match once trailing whitespace is ignored (compared
// through the same typographic fold). `search` is the LF view, so lines split on
// "\n" only. Candidates that overlap an earlier one are dropped, so a repeated
// blank-line pattern cannot double-count the same region.
//
// ONE forward pass, O(content.length) time and O(expected.length) memory.
// The previous shape materialised an object per line (`matchAll` + `filter` + `map`)
// and then `slice`d a fresh array per candidate position, so a miss on a large file
// allocated two arrays the size of the file's line count before answering "no match"
// — measured at ~2.5 s and hundreds of MB of garbage on a 120 MB file, on a tier that
// runs ONLY when the exact and typographic tiers already found nothing. The scan here
// keeps a ring of the last `m` line keys and only compares the whole window when the
// newest key already matches the last expected line, which is the rare case.
//
// The line enumeration is identical to the old regex (`/[^\n]*(?:\n|$)/g` with the
// trailing empty match dropped): every "\n"-terminated line, plus a final unterminated
// line when the file does not end with a newline, and empty lines included.
const findLineOccurrences = (content: string, search: string): Match[] => {
    const trailingNewline = search.endsWith('\n');
    const expected = search.split('\n');
    if (trailingNewline) expected.pop();

    const width = expected.length;
    if (width === 0) return [];

    const expectedKeys = expected.map(lineKey);
    const lastKey = expectedKeys[width - 1];

    // Ring buffers, index 0 = the OLDEST line of the current window.
    const keys: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    const contentEnds: number[] = [];
    let lastHasNewline = false;

    const found: Match[] = [];
    let offset = 0;

    while (offset < content.length) {
        const breakAt = content.indexOf('\n', offset);
        const hasNewline = breakAt !== -1;
        const lineEnd = hasNewline ? breakAt + 1 : content.length;
        const text = hasNewline ? content.slice(offset, breakAt) : content.slice(offset, lineEnd);

        keys.push(lineKey(text));
        starts.push(offset);
        ends.push(lineEnd);
        // Where the line's CONTENT ends, i.e. before a CRLF's carriage return. A match
        // that does not demand a trailing newline stops here so the \r stays in the file.
        contentEnds.push(offset + text.length - (text.endsWith('\r') ? 1 : 0));
        lastHasNewline = hasNewline;

        if (keys.length > width) {
            keys.shift();
            starts.shift();
            ends.shift();
            contentEnds.shift();
        }

        // Cheap filter first: a window can only match if its LAST line already does.
        if (
            keys.length === width &&
            keys[width - 1] === lastKey &&
            keys.every((key, index) => key === expectedKeys[index]) &&
            (!trailingNewline || lastHasNewline)
        ) {
            const candidate: Match = {
                start: starts[0],
                end: trailingNewline ? ends[width - 1] : contentEnds[width - 1]
            };

            // Overlap rule, unchanged: a candidate that overlaps an accepted one is
            // dropped, so a repeated blank-line pattern cannot double-count a region.
            if (!found.some((match) => match.end > candidate.start && match.start < candidate.end)) {
                found.push(candidate);
            }
        }

        offset = lineEnd;
    }

    return found;
};

// How many times the single character `needle` occurs in `haystack`, from `from`.
// `indexOf` in a loop: no allocation per match, and for a character that is absent it
// is a single memchr-speed scan.
const countChar = (haystack: string, needle: string, from = 0): number => {
    let count = 0;
    let at = haystack.indexOf(needle, from);

    while (at !== -1) {
        count += 1;
        at = haystack.indexOf(needle, at + 1);
    }

    return count;
};

// Fold CRLF to LF in a caller-supplied string. `split/join` rather than `replaceAll`
// (the declared `lib` predates ES2021), guarded by one `includes` because the vast
// majority of oldStrings and newStrings carry no CR at all and the split would allocate
// an array the size of the string's line count for nothing.
const foldLf = (value: string): string => (value.includes('\r') ? value.split('\r\n').join('\n') : value);

// The LF view of a source, plus the CRLF positions needed to map view offsets back.
type LfView = { view: string; removed: number[] };

// Shared empty position list: an LF-only file needs no offset mapping at all, and one
// array literal per call would be garbage for nothing. `countBefore` only reads it.
const NO_CRLF: number[] = [];

// Fold CRLF to LF for MATCHING ONLY, and record enough to map offsets back.
//
// The previous shape did this unconditionally: a whole-file `split('\r\n').join('\n')`
// plus `[...source.matchAll(/\r\n/g)]`, which allocates one match OBJECT per CRLF on
// top of a second array of positions. On an 11 MB file that fixed cost was 90 ms paid
// before any matching happened — even for a tier-1 exact hit that needed none of it —
// against 34 ms for the LF equivalent. Two changes:
//
//   - a file with no CR at all costs one `includes`, because the LF view IS the source
//     and no offset ever needs mapping (the fold is the identity);
//   - a file with CRs is walked with `indexOf`, so only the positions array is built
//     and no per-match object exists.
//
// `removed[k]` is the VIEW offset of the k-th CRLF, i.e. its source offset minus the k
// carriage returns already dropped. Adding the count of entries strictly below a view
// offset converts view coordinates to source coordinates, exactly as before.
const foldToLf = (source: string): LfView => {
    if (!source.includes('\r')) return { view: source, removed: NO_CRLF };

    const removed: number[] = [];
    let view = '';
    let cursor = 0;
    let at = source.indexOf('\r\n');

    while (at !== -1) {
        // Drop the CR, keep the LF. `view.length` is now (at + 1) - removed.length,
        // so the view offset of this very newline is `view.length - 1`.
        view += source.slice(cursor, at) + '\n';
        removed.push(view.length - 1);
        cursor = at + 2;
        at = source.indexOf('\r\n', cursor);
    }

    return { view: view + source.slice(cursor), removed };
};

// The dominant line ending in `text`, or `fallback` when neither wins.
//
// `lfCount` is BARE newlines — a CRLF is one line ending, not two — so it is the total
// newline count MINUS the CRLF count. Getting that subtraction wrong silently flips the
// answer on a pure-CRLF file, which is why the equivalence is pinned by a test rather
// than argued here.
//
// This used to be two `split()`s, which materialise TWO ARRAYS OF STRINGS the size of
// the file's line count just to read their lengths: 8.5 ms and 16.2 ms on a 200,000-line
// file, paid on EVERY edit call including a tier-1 exact hit. Counting with `indexOf`
// allocates nothing and answers the same question. A file with no CR at all — the
// common case — skips the CRLF scan entirely.
const lineEnding = (text: string, fallback: string): string => {
    const crlfCount = text.includes('\r') ? countChar(text, '\r\n') : 0;
    const bareLfCount = countChar(text, '\n') - crlfCount;

    if (crlfCount === bareLfCount) return fallback;
    return crlfCount > bareLfCount ? '\r\n' : '\n';
};

// `lineEnding` without the fallback: null means "no opinion" (no line endings at all,
// or an exact tie), so the caller decides what to do and only pays for a wider scan
// when this one is inconclusive.
const dominantEnding = (text: string): '\r\n' | '\n' | null => {
    const crlfCount = text.includes('\r') ? countChar(text, '\r\n') : 0;
    const bareLfCount = countChar(text, '\n') - crlfCount;

    if (crlfCount === bareLfCount) return null;
    return crlfCount > bareLfCount ? '\r\n' : '\n';
};

// Above this many cell comparisons, `alignLines` gives up on the LCS and maps lines
// positionally instead. The alignment exists ONLY to choose a line ending per replaced
// line, and the full table costs O(before x after) in BOTH time and memory: a
// replaceAll over a 5,000-line region measured 275 ms and a 95 MB `Uint32Array`
// (5001 x 5001 x 4 bytes) for that nicety. 1,000 x 1,000 = 1e6 cells is already more
// work than most whole edits are worth, and stays under 4 MB.
const ALIGN_CELL_LIMIT = 1_000_000;

// For each line of `after`, the index of the `before` line it keeps (longest
// common subsequence) or, between kept lines, the line it takes the place of;
// undefined for lines with no counterpart.
//
// PAST THE CELL LIMIT, POSITIONAL IS THE FALLBACK. Line i of `after` takes the ending
// of line i of `before` where such a line exists, and no counterpart beyond that — the
// same answer an LCS gives when the two sides line up, which is what a replacement that
// rewrites a region line-for-line looks like. It is NOT the same answer when lines are
// inserted or deleted in a MIXED-ending region, and that is the honest trade: a
// mixed-ending region several thousand lines deep, edited by a single call, is rare;
// stalling the process for 275 ms and 95 MB on every such call is worse.
//
// WHAT THAT COSTS EXACTLY (L9, by design): past the cap an UNCHANGED line of the
// replacement can come back with a DIFFERENT ending from the line it stands for — line i
// borrows the ending of line i whether or not those two lines are the same line — and
// every line past the shorter side takes the region's dominant ending instead of its own.
// Under the cap the LCS keeps each unchanged line's own bytes. So a mixed-ending region
// bigger than 1e6 cell comparisons (about 1,000 x 1,000 lines) edited by one call is the
// one case where an unchanged line's ending may move; the result is still well-formed
// text, and it is the alignment table's cost, not a matching change.
const alignLines = (before: string[], after: string[]): (number | undefined)[] => {
    if (before.length * after.length > ALIGN_CELL_LIMIT) {
        const shared = Math.min(before.length, after.length);
        return after.map((_, index) => (index < shared ? index : undefined));
    }

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

// How many candidate lines an ambiguity error NAMES. The reported count is always
// exact; only the list is capped, so the failure stays readable and small enough to
// journal. See the note in this file's header.
const AMBIGUITY_LINE_LIMIT = 10;

// Char code of "\n". Compared numerically so the scan below allocates nothing per
// character.
const NEWLINE_CODE = 0x0a;

// 1-based line numbers of each match start, so an ambiguity error can say WHERE
// the candidates are instead of only how many.
//
// ONE forward pass over the text, not one prefix copy per match. Both finders scan
// left to right, so `matches` arrive in ascending order and a single scan that
// counts newlines while walking to each match start answers every match at once:
// O(content.length) regardless of how many matches there are. The previous shape,
// `matches.map((m) => content.slice(0, m.start).split('\n').length)`, copied a fresh
// prefix per match — O(content.length x matches) — so a 3.3 MB file whose oldString
// matched 200,000 times asked for ~323 GB of temporary strings and stalled the
// process it ran in. The regression test in ./edit.test.ts rebuilds that shape.
const lineNumbers = (content: string, matches: Match[]): number[] => {
    const result: number[] = [];
    let line = 1;
    let offset = 0;

    for (const match of matches) {
        while (offset < match.start) {
            if (content.charCodeAt(offset) === NEWLINE_CODE) line += 1;
            offset += 1;
        }
        result.push(line);
    }

    return result;
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
// never displaced by a looser one. `tier` names the tier that produced the match,
// so the result can report that a fallback was used; undefined means exact bytes.
// THE SINGLE-LINE FAST PATH, AND WHY IT IS EXACTLY EQUIVALENT
// -----------------------------------------------------------
// An oldString that contains NEITHER a carriage return NOR a newline — one line of
// text, which is what the overwhelming majority of real hunks are — can be matched
// against the raw source, because folding CRLF to LF cannot change WHERE such a string
// occurs:
//
//   - a match of it in the source occupies characters that are all still adjacent in
//     the view (the fold deletes only CRs, and this string contains none);
//   - a match of it in the view cannot straddle a line boundary, because it contains no
//     LF, and within one line the view and the source are the same characters up to a
//     trailing CR that this string does not contain.
//
// So the two match sets are in one-to-one correspondence, at offsets that are already
// in SOURCE coordinates — no view copy, no position array, no mapping pass. When the
// fast path finds nothing the full cascade below still runs, and since a CR-deletion
// can only CREATE matches, a raw miss is never a false negative.
//
// MEASURED (2.3 MB / 2.5 MB files, 200,000 lines, tier-1 exact hit, edit-only timing):
// CRLF 90.8 ms -> 25.6 ms, LF 34.3 ms -> 15.5 ms. The whole-file fold that used to run
// on EVERY call — including the exact hits that need none of it — now runs only when a
// multi-line oldString actually misses the raw bytes.
const matchView = (
    source: string,
    oldString: string,
    newString: string
): { matches: Match[]; tier?: FileEditMatch; replace: (match: Match) => string } => {
    // The file's own dominant ending, computed at most ONCE per call. A single-line
    // region has no ending of its own, so it falls back to this — and a `replaceAll`
    // over 40,000 matches would otherwise rescan the whole file 40,000 times, which is
    // the exact quadratic trap this file's header warns about. (It bit once already:
    // the previous code computed `fileEnding` eagerly for every call, single match or
    // not; making it lazy without caching made it per-MATCH.)
    let fileEnding: string | null = null;
    const endingOfWholeFile = (): string => (fileEnding ??= lineEnding(source, '\n'));

    // H6 — a newString that carries a carriage return is ENDING-EXPLICIT: the caller
    // spelled the line endings it wants, so its bytes are written VERBATIM, with no fold
    // to LF and no re-joining against the matched region. Both halves of the old pipeline
    // were silent in opposite directions. `foldLf` deleted every "\r\n" the caller passed,
    // so an explicit CRLF on an LF file came back as LF and LF->CRLF was unreachable
    // outside the differ-only-in-CR form; a LONE "\r" survived that fold, and the region
    // join then appended a real ending after it, so "A\r\r\nB" came back as the bytes
    // 41 0d 0d 0a on a CRLF file and 41 0d 0a on an LF file — a carriage return the tool
    // invented, in both directions, from input the tool claimed to preserve.
    //
    // A LF-only newString keeps the documented default and re-adopts the file's endings
    // ("write oldString and newString with \n even for a CRLF file"), which is what makes
    // the CR case unambiguous: no CR in newString means "the file decides", a CR means
    // "I decided".
    const endingExplicit = newString.includes('\r');
    const replacement = endingExplicit ? newString : foldLf(newString);

    // A replacement with NO newline is one line, and `withRegionEndings` returns a
    // one-line replacement VERBATIM: its only line is also its last line, and the last
    // line never receives an ending. So the ending choice cannot change the output, and
    // neither the region scan nor the whole-file tie-break is worth paying for. This is
    // the common case — a one-line hunk replaced by one line — and without it a
    // single-line edit on a large file still rescans the whole file for a tie-break it
    // never uses. An ending-explicit replacement skips the same scans for the stronger
    // reason above: the caller's bytes ARE the answer, so no ending has to be chosen.
    const verbatim = endingExplicit || !replacement.includes('\n');

    const singleLine = !oldString.includes('\r') && !oldString.includes('\n');
    const rawExact = singleLine ? findOccurrences(source, oldString) : [];

    if (rawExact.length > 0) {
        return {
            matches: rawExact,
            tier: undefined,
            replace: verbatim
                ? () => replacement
                : (match: Match) => {
                      const region = source.slice(match.start, match.end);
                      return withRegionEndings(region, replacement, dominantEnding(region) ?? endingOfWholeFile());
                  }
        };
    }

    const { view, removed } = foldToLf(source);
    const search = foldLf(oldString);

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
            // The whole file's dominant ending is only a TIE-BREAK for a region that has
            // no opinion of its own, so it is computed on demand and memoised: a region
            // with a clear majority — nearly every real one — never pays for the scan, and
            // a `replaceAll` pays for it once rather than per match. `verbatim` skips both
            // scans, because for a one-line replacement the ending cannot change the bytes
            // and for an ending-explicit one the caller's bytes are the answer (H6).
            if (verbatim) return replacement;

            const region = source.slice(match.start, match.end);
            return withRegionEndings(region, replacement, dominantEnding(region) ?? endingOfWholeFile());
        }
    };
};

// Apply replacements to `content`. `matches` are ascending and non-overlapping (both
// finders scan left to right and drop overlaps), and `replace` maps one match to the
// text that takes its place, line endings already resolved.
//
// One pass: the untouched gaps and the replacements are collected in order and joined
// ONCE. The previous right-to-left `reduce` spliced the whole string per match, which
// is O(content.length x matches) — the same quadratic trap the ambiguity message fell
// into, reached by any `replaceAll` on a common oldString.
const applyReplacements = (
    content: string,
    matches: Match[],
    replace: (match: Match) => string
): string => {
    if (matches.length === 1) {
        const only = matches[0];
        return content.slice(0, only.start) + replace(only) + content.slice(only.end);
    }

    const pieces: string[] = [];
    let cursor = 0;

    for (const match of matches) {
        pieces.push(content.slice(cursor, match.start), replace(match));
        cursor = match.end;
    }
    pieces.push(content.slice(cursor));

    return pieces.join('');
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
            'edit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
    }

    if (edits.length === 0) {
        throw new HarnessError('edit received an empty edits array; pass at least one edit.');
    }

    // M12: rejected before any validation or filesystem work, like read's batch cap and
    // write's (./write.tool.ts:169). A caller that sends 400 entries needs to split the
    // batch, not to have 100 files locked, edited and reported while 300 were dropped.
    if (edits.length > FILE_EDIT_MAX_TARGETS) {
        throw new HarnessError(
            `edit accepts at most ${FILE_EDIT_MAX_TARGETS} edits per call; received ${edits.length}. Split the batch.`
        );
    }

    const normalized: NormalizedEdit[] = [];

    for (const entry of edits) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError(
                'edit edits must be objects with "path", "oldString", and "newString" strings.'
            );
        }

        const { path, oldString, newString, replaceAll } = entry as Partial<FileEditEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('edit edits require a non-empty "path" string.');
        }

        if (path.includes('\u0000')) {
            throw new HarnessError('edit paths must not contain NUL characters.');
        }

        if (typeof oldString !== 'string' || oldString.length === 0) {
            // An empty oldString matches everywhere (including between every pair of
            // characters), so it is never a meaningful edit.
            throw new HarnessError('edit requires a non-empty oldString.');
        }

        if (typeof newString !== 'string') {
            throw new HarnessError('edit requires a "newString" string.');
        }

        // Rejecting a no-op keeps "the edit applied" an honest claim: a model that
        // passes the same text twice has not changed anything.
        if (oldString === newString) {
            throw new HarnessError(
                'edit did not change the file: oldString and newString are identical.'
            );
        }

        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
            throw new HarnessError('edit replaceAll must be a boolean when provided.');
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

// Turn a failed read of an edit target into a sentence a model can act on.
//
// The raw errno (`ENOENT: no such file or directory, open '...'`) is what Node
// reports and what this tool used to leak. It names no remedy, and the remedy here is
// specific — `edit` deliberately does not create files, so a missing target means the
// caller wanted `write`. `read` already explains itself per failure (./read.tool.ts);
// an inconsistent error surface between two adjacent tools is its own defect (D8).
//
// `target` is the caller's own resolved path and is what the message names, NOT the
// errno's `path`: a failure deep in a read can report no path at all (EISDIR from a
// directory read carries none), and the value that means something to the caller is
// the one they passed.
//
// Windows reports EPERM for reading a directory, which by code alone looks like a
// permission denial, so only in that case (and only after the failure) one narrow stat
// decides. A failed stat keeps the original classification, so a real denial is never
// relabelled as a directory.
const classifyReadFailure = async (target: string, error: unknown): Promise<never> => {
    const reason = error instanceof Error ? error.message : String(error);
    const code =
        typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;

    if (code === 'ENOENT') {
        throw new HarnessError(
            `edit could not find ${target}: no such file or directory (ENOENT). edit changes an EXISTING file; use write to create one.`
        );
    }

    if (code === 'EISDIR' || ((code === 'EPERM' || code === 'EBADF') && (await isDirectoryPath(target)))) {
        throw new HarnessError(
            `edit was given the directory ${target}. edit changes one existing file; pass a file path, or use write.`
        );
    }

    if (code === 'EACCES' || code === 'EPERM') {
        throw new HarnessError(
            `edit was denied permission to read ${target}: ${reason} This is a filesystem permission problem, not a missing path.`
        );
    }

    throw new HarnessError(`edit failed to read ${target}: ${reason}`);
};

const isDirectoryPath = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------
// ENCODING — the target must be UTF-8 text with no NUL byte, or the call is refused.
// ---------------------------------------------------------------------------

// The rejection shared by the NUL path and the invalid-UTF-8 path, so the message (and
// therefore a test's expectation) cannot drift between them, and so it says the same
// thing about the same bytes that `read` says (./read.tool.ts:1207). The OFFSET is named
// because the caller cannot find it: the byte that broke the decode is somewhere in a
// file the caller has so far only ever seen substituted.
const binaryMessage = (path: string, detail: string): string =>
    `edit refused "${path}": the file contains binary data (${detail}). edit reads and writes UTF-8 text, so it refuses a file it cannot rewrite byte for byte.`;

// The continuation-byte range each UTF-8 lead byte allows, or null when the byte cannot
// lead a sequence at all. This is the WHATWG decoder's own rejection table: C0/C1 are
// overlong two-byte forms, E0 must be followed by A0..BF (no overlong three-byte form),
// ED by 80..9F (no surrogates), F0 by 90..BF, F4 by 80..8F (nothing past U+10FFFF), and
// F5..FF plus a bare 80..BF are not lead bytes.
const utf8ContinuationRange = (lead: number): [number, number] | null => {
    if (lead >= 0xc2 && lead <= 0xdf) return [0x80, 0xbf];
    if (lead === 0xe0) return [0xa0, 0xbf];
    if (lead >= 0xe1 && lead <= 0xec) return [0x80, 0xbf];
    if (lead === 0xed) return [0x80, 0x9f];
    if (lead >= 0xee && lead <= 0xef) return [0x80, 0xbf];
    if (lead === 0xf0) return [0x90, 0xbf];
    if (lead >= 0xf1 && lead <= 0xf3) return [0x80, 0xbf];
    if (lead === 0xf4) return [0x80, 0x8f];
    return null;
};

// How many continuation bytes a lead byte declares. Only called for the lead bytes the
// table above accepts, so the three branches below cover every case it can be handed
// (C2..DF -> 1, E0..EF -> 2, F0..F4 -> 3).
const utf8SequenceLength = (lead: number): number => (lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : 1);

// Byte offset of the first structurally invalid UTF-8 sequence, or -1 when the buffer is
// valid. The strict decoder in `decodeEditSource` is the AUTHORITY for whether a file is
// accepted — its `TypeError` carries no position, so this scan exists only to name the
// byte a caller can act on. A sequence that runs out of buffer is invalid, and the
// reported offset is the LEAD BYTE's, because that is where the invalid sequence starts.
// Runs only on the rejection path, so its one pass costs nothing on a good file.
const firstInvalidUtf8Byte = (buffer: Buffer): number => {
    let index = 0;

    while (index < buffer.length) {
        const lead = buffer[index];

        if (lead < 0x80) {
            index += 1;
            continue;
        }

        const range = utf8ContinuationRange(lead);
        if (range === null) return index;

        const extra = utf8SequenceLength(lead);
        // A truncated sequence is invalid whatever follows it — report the lead byte.
        if (index + extra >= buffer.length) return index;

        for (let offset = 1; offset <= extra; offset++) {
            const byte = buffer[index + offset];
            if (byte < range[0] || byte > range[1]) return index;
            // Only the FIRST continuation byte is range-restricted; the rest just have to
            // be continuations, exactly as the decoder's table has it.
            range[0] = 0x80;
            range[1] = 0xbf;
        }

        index += extra + 1;
    }

    return -1;
};

// Decode one edit target, or refuse it. `fatal: true` is the same authority `read` uses
// (./read.tool.ts:2263), so the two tools cannot disagree about which files are text.
// `ignoreBOM: true` keeps a leading BOM in the decoded text: `readFile(path,'utf8')`
// never stripped one either, and letting the decoder drop it would turn every successful
// edit of a BOM file into a three-byte rewrite the caller never asked for.
const decodeEditSource = (target: string, buffer: Buffer): string => {
    // A NUL byte IS valid UTF-8, so the decoder alone would accept it — but `read` calls
    // it binary (EBINARY) and `write` refuses to create it, so accepting it here would
    // let `edit` rewrite a file no other tool in this package can open again.
    const nul = buffer.indexOf(0);

    if (nul !== -1) {
        throw new HarnessError(binaryMessage(target, `NUL byte at offset ${nul}`), {
            code: 'EBINARY'
        });
    }

    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch (error) {
        throw new HarnessError(
            binaryMessage(target, `invalid UTF-8 at offset ${firstInvalidUtf8Byte(buffer)}`),
            { code: 'EBINARY', cause: error }
        );
    }
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
            // is written. Editing is for existing files; write creates. The raw errno
            // is classified into a sentence that says what to do, because a model
            // reading `ENOENT: no such file or directory, open '...'` has nothing to
            // act on and read's message is right next door (see ./read.tool.ts).
            //
            // The file is read as BYTES and decoded by hand (see decodeEditSource).
            // `readFile(path,'utf8')` used to do the decoding, and that decoding is
            // LOSSY: one Latin-1 byte in an otherwise ordinary file became U+FFFD and
            // the edit reported a plain success, so a byte the caller never touched was
            // rewritten by this tool. Refusing is also a preflight decision — a file
            // rejected for its encoding fails the call before the first write, exactly
            // like a file whose oldString is missing.
            const bytes = await readFile(edit.target).catch((error) =>
                classifyReadFailure(edit.target, error)
            );

            state = {
                target: edit.target,
                content: decodeEditSource(edit.target, bytes)
            };
            texts.set(edit.identity, state);
        }

        const content = state.content;

        // oldString and newString that differ ONLY in carriage returns ask to change
        // the file's line endings themselves, so that edit applies to the exact
        // bytes instead of the LF view. Every other edit matches the LF view; its
        // replacement then either re-adopts the file's endings (a LF-only newString)
        // or is written exactly as given (a newString carrying a CR — see matchView).
        const endingsOnly =
            edit.oldString.split('\r').join('') === edit.newString.split('\r').join('');

        const { matches, replace, tier } = endingsOnly
            ? { matches: findOccurrences(content, edit.oldString), replace: () => edit.newString, tier: undefined }
            : matchView(content, edit.oldString, edit.newString);

        if (matches.length === 0) {
            throw new HarnessError(
                `edit found no match for oldString in ${edit.target}. Read the file first and copy the text exactly, including indentation.`
            );
        }

        if (matches.length > 1 && !edit.replaceAll) {
            // Naming the lines is what makes the failure actionable: a model can
            // copy more surrounding text from a line it can actually locate. Only the
            // first AMBIGUITY_LINE_LIMIT are named — the count stays exact and the tail
            // is named by how many it is, because a broad oldString can match hundreds
            // of thousands of times and the full list is a megabyte of text no model
            // reads and the session journal still has to store.
            const lines = lineNumbers(content, matches);
            const named = lines.slice(0, AMBIGUITY_LINE_LIMIT);
            const remaining = lines.length - named.length;
            const where = remaining > 0 ? `${named.join(', ')}, and ${remaining} more` : named.join(', ');

            throw new HarnessError(
                `edit found ${matches.length} matches for oldString in ${edit.target} (lines ${where}). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            );
        }

        // Without replaceAll only the single unique match is applied; with it, every
        // occurrence is replaced in one pass (see ./applyReplacements).
        const chosen = edit.replaceAll ? matches : matches.slice(0, 1);
        const updated = applyReplacements(content, chosen, replace);

        // A fallback tier can match text that already equals newString (for example
        // curly quotes in the file against an ASCII oldString and a curly newString).
        // Saying "applied" then would be dishonest, so the edit is rejected.
        if (updated === content) {
            throw new HarnessError(
                `edit did not change ${edit.target}: the replacement text is identical to the text it matched. Line endings follow the file; to change them, pass oldString and newString that differ only in carriage returns.`
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
    name: 'edit',
    description:
        'Replace text in one or more existing files. Pass an array of { path, oldString, newString } entries; oldString must match exactly, including whitespace and indentation, and must identify a unique location unless replaceAll is true, so an ambiguous edit is rejected instead of changing the wrong place. A call accepts at most 100 entries; split a larger batch. Calls that name the same file are serialized per file (read-match-write is one critical section), so a concurrent edit never silently clobbers another - the later one fails with "no match" against the text the earlier one produced. Several entries may name the SAME file: they are applied in array order, each matched against the text the previous one produced, so one call can change several places in one file and each file is still written once. Line endings are matched and preserved: write oldString and newString with \\n even for a CRLF file, and the replacement is re-joined line by line with the endings of the region it replaced: a line standing in for a matched line keeps the ending of that line, a genuinely new line takes the dominant ending of the region (that of the file when the region has none), and the last line gets no ending of its own, so a mixed-ending file stays mixed and the endings the caller typed survive only when it spells them itself: with \\r, or in the differ-only-in-carriage-returns form below; a newString that contains \\r is ending-explicit and is written verbatim, byte for byte, so an explicit \\r\\n is never rewritten into the endings of the file; to convert the endings themselves, pass oldString and newString that differ only in carriage returns (a `\\r` in one and not the other): that form matches exact bytes, so it converts the endings of exactly the region it matched and nothing else. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line; otherwise it fails. That trailing-whitespace tier matches WHOLE LINES, so an edit that matched through it replaces those whole lines and removes the trailing whitespace inside them. A target whose bytes are not valid UTF-8, or that holds a NUL byte, is refused with EBINARY naming the byte offset: edit rewrites files byte for byte and never substitutes for bytes it cannot decode. Every entry is read and checked before anything is written, so one bad entry leaves every file unchanged. Returns an ordered array of { path, replacements, bytes, match? }, where `match` is present only when a fallback tier was used ("typographic" or "trailing-whitespace"), so a fuzzy match is never silent. Creates nothing: use write for new files.',
    tags: ['files', 'edit', 'write', 'replace', 'filesystem'],
    // R18: editing files is core, so a model never spends a discovery round on it.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                // The batch cap is part of the published schema, exactly as `write`
                // publishes its own (./write.tool.ts:400), so a caller reads the bound
                // instead of discovering it through a rejection. The literal matches
                // FILE_EDIT_MAX_TARGETS and a test pins both, so the declared schema and
                // the runtime rejection cannot drift.
                maxItems: 100,
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
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = FILE_EDIT_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // T2/R2: an applied edit must be visible before the model reasons about the file
    // again, so this call is grouped with the rest of its message's sync batch.
    mode: 'sync',
    order: 190,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const edit = tool<FileEditParameters, FileEditResult>({
    ...FILE_EDIT_METADATA,
    // T2/R2: mirrors `registration.mode` (see the note in this file's registration
    // export); the tool() declaration is what a standalone/host registration carries.
    mode: 'sync',
    execute: async ({ parameters: edits }) => {
        const normalized = await normalizeEdits(edits);

        // D4: the lock is taken BEFORE the read, not just before the write. Holding it
        // across read-match-write is the whole fix — a lock around only the write would
        // still let two calls compute from the same stale text and let the second one
        // overwrite the first. Locks are acquired in sorted identity order (./lock.ts),
        // so overlapping multi-file batches cannot deadlock.
        return withFileLocks(
            normalized.map((edit) => edit.identity),
            async () => {
                // Everything up to here has been validated and matched; nothing has been
                // written yet, so any throw above left every file untouched.
                const { prepared, files } = await prepareEdits(normalized);

                // Byte size per file IDENTITY, so entries sharing a file (including two
                // spellings of one path) report the same final size rather than each
                // other's intermediate text.
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
                            `edit failed on ${file.target}: ${reason} Edits already applied: ${completed}. No rollback was performed.`
                        );
                    }

                    written.push(file.target);
                    sizes.set(file.identity, Buffer.byteLength(file.updated, 'utf8'));
                }

                // One entry per requested edit, in request order: entries that share a
                // file each report their own replacement count against that file's final
                // size.
                return prepared.map((edit) => {
                    // L7: `bytes` is a claim about a file this call just wrote, so a
                    // missing size is a broken bookkeeping, never a zero. Every prepared
                    // identity is a key of `texts`, and `files` is built from `texts`, so
                    // this lookup cannot miss — but the previous `?? 0` would have reported
                    // a confidently wrong byte count if that ever stopped being true, and a
                    // wrong byte count is the silent rewriting this tool exists to avoid.
                    // Fail loudly, and say which path the bookkeeping lost.
                    const bytes = sizes.get(edit.identity);

                    if (bytes === undefined) {
                        throw new HarnessError(
                            `edit lost the byte size of ${edit.target}: the edit was matched and applied, but no write recorded the file's size.`
                        );
                    }

                    const entry: FileEditResultEntry = {
                        path: edit.target,
                        replacements: edit.replacements,
                        bytes
                    };

                    // Only mention the tier when it was not exact, so the common case
                    // stays terse and a fuzzy match is never silent.
                    if (edit.match !== undefined) entry.match = edit.match;

                    return entry;
                });
            }
        );
    }
});
