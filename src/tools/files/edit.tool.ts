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
//   - oldString must be found, or the call fails ("no match" rather than a silent
//     nothing-happened);
//   - oldString must appear exactly once, or the call fails (no "which one did you
//     mean?" guessing) — pass replaceAll to opt into every occurrence;
//   - an EMPTY oldString is refused against a file that has text, because it matches
//     everywhere (M12). The one place it does name exactly is the start of an EMPTY file,
//     so `oldString: ""` is accepted there and inserts newString — which is the only way
//     an empty file could be edited at all, since no non-empty oldString can match it;
//   - oldString and newString MAY be identical (M12). The match and ambiguity rules still
//     run — a no-op whose oldString is missing or ambiguous still fails — and the receipt
//     says `changed: false`. Before this, a legitimate no-op was an error and the
//     replacement-count reporting had nothing to describe;
//   - a replacement that matched but rewrote identical bytes is an honest error, UNLESS
//     the caller asked for exactly that no-op above. The guard exists for the fallback
//     tiers: curly quotes in the file, an ASCII oldString that matched them, and a curly
//     newString mean the file would come back as it was — "applied" would be a lie.
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
// Before the first byte is written, EVERY edit is validated (shape, no unknown field,
// oldString/newString types, no NUL in the path) and EVERY file is STATTED (regular file,
// within FILE_EDIT_MAX_BYTES — see "THE SIZE BOUND" below), read, DECODED (valid UTF-8
// with no NUL byte — see "ENCODING" above), match-checked, and fully computed — a failure
// anywhere, including on the last entry, therefore leaves every file untouched, which is
// why the batch can be trusted. Each file that actually changed is then published exactly
// ONCE with its final text.
//
// ONE CRITICAL SECTION PER FILE (D4: no torn state, no lost edit-vs-edit update)
// ------------------------------------------------------------------------------
// Read-match-write is three awaits, so two overlapping calls used to read the same
// original text, both match, both report success, and the last write silently won.
// The whole read/match/write span is therefore held under a per-file lock
// (./lock.ts), keyed by FILE IDENTITY so two spellings of one file share it. A later
// edit now sees the earlier edit's text and fails honestly ("edit found no match")
// instead of clobbering a change it never saw. A multi-file batch takes its locks in
// sorted identity order, so two overlapping batches cannot deadlock.
//
// WHAT THAT DOES NOT BUY (H6). Two claims used to be published that the lock does not
// support. First, the ordering is PER PROCESS: ./lock.ts is a Map on one event loop, and
// under `threadExecution: 'worker'` (../../server/config.ts) every lane worker has its OWN
// map, so two lanes naming one file are not serialized at all — exactly as another process
// or an outside editor is not. The default is 'inline', which is the case the guarantee
// holds for, and the published description says so instead of burying it in ./lock.ts.
// Second, `edit` is serialized against `write` by the SAME lock, but a `write` replaces the
// whole text without re-checking what is there (./lock.ts: "WHY A MUTEX AND NOT AN
// mtime/hash CHECK" — a compare-and-swap would reopen the window the mutex closes, and
// `write` publishes "Replaces the previous contents"). So a `write` that runs after a
// concurrent `edit` on the same path WINS, and the edit's change is gone; the lock only
// promises the two calls never interleaved into a torn file. No precondition was added to
// close that: it would change `write`'s documented semantics to buy back a window the
// design comment already rejects.
//
// EACH EDITED FILE IS PUBLISHED ATOMICALLY (C2)
// ---------------------------------------------
// `edit` used to finish with `writeFile(target, text, 'utf8')`, whose default 'w' flag is
// O_WRONLY|O_TRUNC: the target's OWN inode was emptied at open, before a byte of the new
// text had arrived. `write` had already moved to staging + rename for exactly that reason
// (./write.tool.ts, ./atomic-publish.ts), which left the tool whose whole job is changing
// one line as the only file writer in the package that could expose — and keep — a
// half-written file, and left ENOSPC/EPERM/a signal mid-write with nothing to roll back to.
// `edit` now calls the SAME `publishAtomically`, so the guarantee is identical:
//
//   - the new text lands in a `<name>.tmp-<token>` sibling and is renamed into place, so a
//     reader sees the whole previous file or the whole new one, never a prefix;
//   - a failure before the rename leaves the target with its PREVIOUS content, its previous
//     inode, and its mode, and removes the staging file — no litter, no truncation;
//   - the target's mode is copied onto the staging file, because the rename swaps the inode
//     and in-place writing used to keep 0755-style bits for free.
//
// Two consequences of the swap, both inherited from `write` and both published:
//   - M3, and a fix rather than a regression: an in-place write had to OPEN the existing
//     inode, so an edit of a 0444 file died EACCES while `write` of the same file
//     succeeded. Only the DIRECTORY gates the rename now, so `edit` and `write` agree, and
//     a read-only file is editable. (A read-only DIRECTORY still refuses both.) Note the
//     uid dependence: that 0444 refusal was never visible to root or to a process holding
//     CAP_FOWNER, so a test for it has to probe the privilege instead of assuming it;
//   - the target gets a NEW inode, so an already-open handle, a hard link, `uid`/`gid` and
//     xattrs keep describing the old file. A hard-link sibling keeps the PREVIOUS bytes
//     under its own name: the caller named one path, and nothing here can update both.
//
// Because a rename replaces a NAME, `edit` can no longer rely on the kernel following a
// symlink for it: the staging file and the rename go to the RESOLVED target, exactly as
// `write` does. Resolving first is what keeps an edit of `alias.txt -> real.txt` updating
// `real.txt` instead of deleting the link and leaving a regular file where the alias was,
// and it keeps the publish a same-directory rename (a cross-device rename is a copy).
//
// THE SIZE BOUND (L9)
// -------------------
// `edit` has to hold the whole file: it reads it as BYTES, decodes it, and folds it into
// the LF view before matching, so a miss allocates three to five full-size string copies
// per entry (measured: 20 MB of target cost +20.2 MB of heap). The matching work is bounded
// (see "BOUNDED WORK" below) but the SIZE was not, and this tool is declared `mode: 'sync'`
// on a server that defaults to `threadExecution: 'inline'` — one huge target could stall or
// OOM the whole process, the exact failure class the section above exists to prevent.
// A stat of the target now refuses anything over the published FILE_EDIT_MAX_BYTES with
// EFBIG and a remedy that names the tools that DO bound their payload (`read` windows,
// `write` replaces without re-matching). A streaming/splicing edit is the real fix and was
// deliberately not attempted here: it would touch every matching tier at once.
//
// The bound is advisory in one narrow way, stated plainly: the stat and the read are
// separate syscalls, so a file that grows between them can be read slightly over the
// ceiling. Nothing in this package races a writer outside the harness (see D4 above), and
// the point of the check is the ordinary "a model pointed edit at a 200 MB log" case, not
// an adversarial one.
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
// match) and DEDUPLICATED, so a candidate repeated three times on one line names that
// line once instead of spending three of the AMBIGUITY_LINE_LIMIT slots on "lines 1, 1, 1"
// (L4 — the match COUNT in the message stays exact and independent of the list). The
// ambiguity message NAMES only the first AMBIGUITY_LINE_LIMIT of them, and replaceAll
// splices by collecting the gaps and joining ONCE (not one whole-file rebuild per match).
// The trailing-whitespace tier is a
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
// instead of silent. `changed` is likewise present, and only as `false`, for the two M12
// cases that matched and rewrote identical bytes: an explicit no-op (oldString ===
// newString) and an empty newString inserted into an empty file. Neither republishes the
// file at all. A normal success stays terse, and so does every pre-existing receipt shape.
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes happen after the preflight, sequentially. An OS error during the write
// phase may leave earlier files edited: there is NO transaction and NO rollback, and
// the error names the completed paths and the failing one.
//
// What the FAILING file looks like IS defined, which is what the atomic publish above buys:
// it still holds the text it had BEFORE the call, on its own inode, with its own mode, and
// the half-written staging file is gone. So "Edits already applied: <1..N-1>" describes
// exactly what changed on disk, and the failing entry is deliberately not in that list.
// Before the publish, the honest version of that sentence was impossible: the failing file
// could just as well have been truncated to nothing.
//
// The throw also carries machine-readable data (M11): `code` is the errno from the
// published FILE_EDIT_ERROR_CODES list (EIO with `details.rawCode` when it is not one of
// those) and `details` is { failedPath, completedPaths, rawCode? }, so a caller that has to
// recover does not parse the completed list out of the sentence. The message still names
// both, because the message is the half that reaches a model.
//
// CANCELLATION IS A CODED REFUSAL, NOT A SILENT EDIT
// --------------------------------------------------
// `context.signal` (src/types/index.ts:2349-2364) is observed: once at the top of the call,
// once before each file is READ (the phase that costs the time, and the one that used to run
// to completion after a cancel), and once per publish inside ./atomic-publish.ts. A cancelled
// `edit` therefore REFUSES with `ECANCELED` + { completedPaths } rather than rewriting files
// for a caller that has gone, and the same partial-batch sentence applies: edits already
// published are listed, the rest were never touched. `ECANCELED` is in FILE_EDIT_ERROR_CODES
// because FILE_PUBLISH_ERROR_CODES carries it, and it is NOT folded into `EIO` — the transient
// code a caller is told to retry, and a cancellation is permanent. The host's own abort reason
// survives as the error's `cause`. ./cancellation.ts is the shared mapping for all four file
// tools, so the four cannot disagree.
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

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import {
    FILE_PUBLISH_ERROR_CODES,
    nonRegularTargetMessage,
    nonRegularTargetOf,
    publishAtomically,
    publishErrorCode
} from './atomic-publish';
import { throwIfFileCancelled } from './cancellation';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// How many entries one `edit` call may carry. `read`, `write` and `files` all cap a batch
// at 100; `edit` carried none (M12), so a single call could name an arbitrary number of
// files, take a lock on every one of them, and return a result array of arbitrary length.
// Enforced in `normalizeEdits` BEFORE any validation or filesystem work, so a refused
// batch reads nothing and writes nothing.
export const FILE_EDIT_MAX_TARGETS = 100;

// L9 — the largest target this tool will read, in bytes.
//
// `edit` is a whole-file tool: it reads the target as bytes, decodes it, and folds it into
// the LF view for matching, so one call holds several full-size copies of the text at once
// (measured on a 20 MB target: +20.2 MB of heap for a MISS, before any replacement). The
// matching ALLOCATION is bounded (see the "BOUNDED WORK" section of this header) but the
// SIZE was not, and this tool is `mode: 'sync'` on a server that defaults to
// `threadExecution: 'inline'` — a 200 MB log could stall or OOM the whole process.
//
// 8 MiB is a deliberate, published ceiling rather than a tuned one: it is 32x the largest
// window `read` will hand back (262144 bytes) and comfortably above any file a model edits
// by copying text out of `read` (a file whose every line `read` can page through in one
// 2000-line window is under it), while the worst-case transient footprint stays around
// 5 x 8 MiB = 40 MB of string, not hundreds. `write` gets no equivalent bound because it
// never re-reads: its payload is the caller's own bytes, one copy, and the batch cap already
// bounds the response.
export const FILE_EDIT_MAX_BYTES = 8 * 1024 * 1024;

// Every machine code an `edit` failure can carry (M11), published so a caller enumerates it
// instead of parsing prose — the same convention as ./read.tool.ts's `FileReadErrorCode`.
// It is the shared publish list plus the two codes this tool synthesizes itself: EBINARY
// (the target is not UTF-8 text — already published, see the "ENCODING" section) and EFBIG
// (the L9 size bound). The shared list already carries ECANCELED (the cancellation guard in
// ./atomic-publish.ts, ./cancellation.ts), so this tool publishes exactly what it can raise.
export const FILE_EDIT_ERROR_CODES = [...FILE_PUBLISH_ERROR_CODES, 'EBINARY', 'EFBIG'];

export type FileEditErrorCode = (typeof FILE_EDIT_ERROR_CODES)[number];

// The fields one `edits` entry may name, enforced at runtime as well as in the schema (M9).
const FILE_EDIT_FIELDS = ['path', 'oldString', 'newString', 'replaceAll'] as const;

// One replacement to apply.
export type FileEditEntry = {
    // Path to an existing file, absolute or relative to the working directory.
    path: string;
    // Exact text to replace. Must be unique unless replaceAll is true. Empty is accepted
    // only against an EMPTY file, where it names one place and inserts newString (M12).
    oldString: string;
    // Replacement text. May be empty to delete the matched text. May be IDENTICAL to
    // oldString: the match is still checked and the entry reports `changed: false`.
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
    // M12 — present, and only ever as `false`, when this entry changed nothing on
    // disk: an explicit no-op (`oldString === newString` matched exactly), or an
    // empty `newString` inserted into an empty file. The match and uniqueness rules
    // still ran and still passed, so this is not a silently ignored request: it is
    // the receipt stating that the file's bytes are the ones it already had, and the
    // file was NOT republished (no new inode). Omitted when the entry did change the
    // file, so every pre-existing `{ path, replacements, bytes }` receipt - and the
    // tests that pin that shape - is unchanged.
    changed?: false;
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
// DEDUPLICATED (L4): both finders scan left to right, so the line numbers come out
// non-decreasing and a repeat is always ADJACENT — one `!==` comparison, no Set and no
// second pass. The list exists to tell a caller WHERE to look, and three candidates on
// one line used to spend three of the AMBIGUITY_LINE_LIMIT slots on "lines 1, 1, 1",
// hiding the two lines that actually differ. The match COUNT in the message is separate
// and stays exact (`edit found 3 matches ... (lines 1)`), so nothing about how many
// candidates there were becomes less true; only the named list gets useful.
const lineNumbers = (content: string, matches: Match[]): number[] => {
    const result: number[] = [];
    let line = 1;
    let offset = 0;
    // No match can be on line 0, so this is a clean "nothing pushed yet" sentinel.
    let named = 0;

    for (const match of matches) {
        while (offset < match.start) {
            if (content.charCodeAt(offset) === NEWLINE_CODE) line += 1;
            offset += 1;
        }

        if (line !== named) {
            result.push(line);
            named = line;
        }
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
    // M12 — false when this entry matched and left the text exactly as it found it:
    // an exact no-op (`oldString === newString`), or an empty `newString` inserted
    // into an empty file. Carried per ENTRY, because two entries naming one file can
    // differ — the receipt says which one did nothing.
    changed: boolean;
};

// One distinct file's final text. A file appears once however many entries named
// it, because it is written once.
type PreparedFile = {
    target: string;
    identity: string;
    updated: string;
    // M12 / C2 — false when the file's final text equals the text it was READ as, so
    // the write phase skips the publish: a call that changed nothing must not hand the
    // file a new inode, bump its mtime, or cost a rename. `original` is what makes that
    // comparison possible after several entries have rewritten the same file.
    changed: boolean;
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

        const record = entry as Record<string, unknown>;
        const { path, oldString, newString, replaceAll } = entry as Partial<FileEditEntry>;

        // M9. The schema says `additionalProperties: false`, but a direct call — the shape
        // this module exports, and what the tests and any host registration use — bypasses
        // schema validation entirely, so an unknown key used to be destructured away and
        // quietly ignored: `{ path, oldString, newString, replace: true }` applied ONE
        // replacement and reported success. Naming the key and the allowed list turns "my
        // replaceAll did nothing" into one round trip. Checked before the field types,
        // because a misspelled `path` is the case where "there is no path" is the least
        // useful answer.
        for (const key of Object.keys(record)) {
            if (!(FILE_EDIT_FIELDS as readonly string[]).includes(key)) {
                throw new HarnessError(
                    `edit edits entries do not accept "${key}". Allowed fields: ${FILE_EDIT_FIELDS.join(', ')}.`
                );
            }
        }

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('edit edits require a non-empty "path" string.');
        }

        if (path.includes('\u0000')) {
            throw new HarnessError('edit paths must not contain NUL characters.');
        }

        // M12 — an EMPTY oldString is no longer refused HERE, because the one place it does
        // name exactly one location is the start of an EMPTY file, and refusing it made an
        // empty file impossible to edit at all (no non-empty oldString can match it). The
        // refusal belongs where the file's content is known, and it is still a refusal:
        // see the `oldString.length === 0` branch in `prepareEdits`.
        if (typeof oldString !== 'string') {
            throw new HarnessError('edit requires an "oldString" string.');
        }

        if (typeof newString !== 'string') {
            throw new HarnessError('edit requires a "newString" string.');
        }

        // M12 — a no-op (`oldString === newString`) is likewise no longer a validation
        // error. A caller that spells the same text twice asked for a check, and the check
        // is worth running: uniqueness and existence still fail the call the way they would
        // for the equivalent real edit, and a no-op that matches is reported with
        // `changed: false` and does NOT republish the file. What used to be an error was
        // also, in practice, how a model discovered it had nothing to change.
        //
        // The honest-"applied" guard this rejection used to provide stays exactly where it
        // was — in `prepareEdits`, where a FALLBACK tier matching bytes that already equal
        // newString would otherwise claim a change that never happened.
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

    // M11 — every refusal also carries the published machine code and the target it is
    // about, because prose is what a model reads and `code` is what a caller switches on.
    // `publishErrorCode` is the one fold used by ./write.tool.ts and ./files.tool.ts: a
    // known errno passes through, an unknown one becomes EIO with the real name in
    // `rawCode`, so the code a caller branches on is always in the published set.
    const published = publishErrorCode(error);
    const details = (extra?: Record<string, unknown>) => ({
        target,
        ...(published.rawCode === undefined ? {} : { rawCode: published.rawCode }),
        ...extra
    });

    if (code === 'ENOENT') {
        throw new HarnessError(
            `edit could not find ${target}: no such file or directory (ENOENT). edit changes an EXISTING file; use write to create one.`,
            { code: 'ENOENT', details: details({ reason: 'missing-target' }) }
        );
    }

    if (code === 'EISDIR' || ((code === 'EPERM' || code === 'EBADF') && (await isDirectoryPath(target)))) {
        throw new HarnessError(
            `edit was given the directory ${target}. edit changes one existing file; pass a file path, or use write.`,
            { code: 'EISDIR', details: details({ kind: 'directory' }) }
        );
    }

    if (code === 'EACCES' || code === 'EPERM') {
        // The reason is separated from the next sentence by `. ` after a trailing-period
        // strip: Node's errno messages carry NO trailing period, so the old interpolation
        // glued "... open '/x'" straight into "This is a filesystem permission problem".
        const prose = reason.replace(/[\s.]+$/, '');

        throw new HarnessError(
            `edit was denied permission to read ${target}: ${prose}. This is a filesystem permission problem, not a missing path.`,
            { code: published.code, details: details({ reason: 'unreadable-target' }) }
        );
    }

    throw new HarnessError(`edit failed to read ${target}: ${reason}`, {
        code: published.code,
        details: details({ reason: 'unreadable-target' })
    });
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
    edits: NormalizedEdit[],
    // The call's abort signal (./cancellation.ts). Checked once per NEW file, immediately
    // before its stat+read: that pair is where a cancelled batch used to keep spending time
    // and descriptors, and checking per FILE rather than per edit keeps a multi-edit batch
    // against one file from repeating the check for nothing.
    signal?: AbortSignal
): Promise<{ prepared: PreparedEdit[]; files: PreparedFile[] }> => {
    // Current text per file identity, filled on first use. Kept separate from the
    // result array so a later entry sees the earlier entry's output. `original` is the
    // text as it was read, which is what makes M12's "did this call change anything?"
    // answerable after several entries have rewritten the same file.
    const texts = new Map<string, { target: string; original: string; content: string }>();
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
            // THE STAT BEFORE THE READ (L5, L9)
            //
            // One `stat` refuses two things that must never cost an `open()`:
            //
            //   - a target that is not a regular file. `readFile` on a FIFO BLOCKS until a
            //     writer closes it, which may be never, and this tool is declared
            //     `mode: 'sync'` on a server that defaults to `threadExecution: 'inline'`
            //     — a hung tool call takes the process with it. A character device reads
            //     until an EOF that `/dev/zero` never sends. And the publish below would in
            //     either case REPLACE the node with a regular file, which is not what the
            //     caller named. The sentence, the code and the classification are shared
            //     with ./write.tool.ts through ./atomic-publish.ts, so the two tools cannot
            //     disagree about what a file is.
            //   - a target over the published FILE_EDIT_MAX_BYTES. This tool holds the
            //     whole file several times over (see "THE SIZE BOUND" in this header), so
            //     the cost of a 200 MB log was paid before the first oldString was looked
            //     at; `EFBIG` says which tool bounds its own payload instead.
            //
            // A directory keeps the sentence the read used to produce, because that is the
            // answer a model can act on — the same fact, learned one syscall earlier, and
            // the same words. A failed stat goes through the SAME classifier the read used,
            // so a denial is still a denial.
            // A cancelled call must not read one more file: the read phase is the expensive
            // one (stat + readFile + the matching below), and its result has no consumer once
            // the signal has fired. `ECANCELED` + `completedPaths: []` says the truth here —
            // the read phase applies nothing, so an abort anywhere in it leaves every file
            // exactly as it was (./cancellation.ts).
            throwIfFileCancelled('edit', signal, `before reading "${edit.target}"`, {
                completedPaths: []
            });

            try {
                const info = await stat(edit.target);
                const nonRegular = nonRegularTargetOf(info);

                if (nonRegular !== undefined) {
                    throw nonRegular.code === 'EISDIR'
                        ? new HarnessError(
                              `edit was given the directory ${edit.target}. edit changes one existing file; pass a file path, or use write.`,
                              { code: 'EISDIR', details: { target: edit.target, kind: 'directory' } }
                          )
                        : new HarnessError(nonRegularTargetMessage('edit', edit.target, nonRegular), {
                              code: nonRegular.code,
                              details: { target: edit.target, kind: nonRegular.kind }
                          });
                }

                if (info.size > FILE_EDIT_MAX_BYTES) {
                    throw new HarnessError(
                        `edit refused ${edit.target}: the file is ${info.size} bytes, over the ${FILE_EDIT_MAX_BYTES}-byte ceiling this tool reads and rewrites in memory. Read the region you want to change with read, then edit that text, or replace the whole file with write.`,
                        {
                            code: 'EFBIG',
                            details: { target: edit.target, size: info.size, limit: FILE_EDIT_MAX_BYTES }
                        }
                    );
                }
            } catch (error) {
                if (error instanceof HarnessError) throw error;

                await classifyReadFailure(edit.target, error);
            }

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

            const content = decodeEditSource(edit.target, bytes);

            state = { target: edit.target, original: content, content };
            texts.set(edit.identity, state);
        }

        const content = state.content;

        // M12 — AN EMPTY FILE IS EDITABLE, and `oldString: ""` is the only needle that can
        // name it. Accepted against ONE shape: a file with no text, where the empty needle
        // has exactly one position. Refused anywhere else with the message this tool has
        // always used, because the empty needle also matches between every pair of
        // characters — and mechanically a zero-width match never advances, so the finders
        // below would loop forever on it.
        //
        // No code is attached (unlike the filesystem refusals): this is a malformed request,
        // not a filesystem state, and every other shape refusal in this tool is codeless
        // for the same reason. `details` still names the target, because a batch of a
        // hundred files has to say which one was meant.
        if (edit.oldString.length === 0) {
            if (content.length > 0) {
                throw new HarnessError('edit requires a non-empty oldString.', {
                    details: { target: edit.target, reason: 'empty-needle-on-non-empty-file' }
                });
            }

            // The insertion: an empty file has no line endings to preserve and no matched
            // region to re-join, so newString IS the file's whole final text, verbatim.
            // `replacements: 1` — one place named, one place filled, whatever `replaceAll`
            // says, because an empty file has only that one place. `changed` is false only
            // for the degenerate request that inserts nothing into nothing.
            prepared.push({
                target: edit.target,
                identity: edit.identity,
                replacements: 1,
                changed: edit.newString.length > 0
            });

            // Fed back so a second entry for this file matches against the text the
            // insertion just produced, exactly as a normal edit's output is.
            state.content = edit.newString;
            continue;
        }

        // oldString and newString that differ ONLY in carriage returns ask to change
        // the file's line endings themselves, so that edit applies to the exact
        // bytes instead of the LF view. Every other edit matches the LF view; its
        // replacement then either re-adopts the file's endings (a LF-only newString)
        // or is written exactly as given (a newString carrying a CR — see matchView).
        // A no-op is EXCLUDED from the exact-bytes branch on purpose (M12). Two identical
        // strings trivially "differ only in carriage returns", but the caller is not asking
        // to convert endings — it is asking whether this text is here. Routing it through
        // the normal cascade means a no-op is diagnosed exactly like the real edit it stands
        // for: found in a CRLF file through the LF view (and reported `changed: false`),
        // reported "no match" when it is absent, and reported as ambiguous when it is not
        // unique. The exact-bytes branch would have answered all three with "no match".
        const endingsOnly =
            edit.oldString !== edit.newString &&
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
        const changed = updated !== content;

        // A fallback tier can match text that already equals newString (for example
        // curly quotes in the file against an ASCII oldString and a curly newString).
        // Saying "applied" then would be dishonest, so the edit is rejected.
        //
        // M12 — the guard skips the one case where "nothing changed" IS the request: a
        // no-op the caller spelled by passing the same text twice. It matched, it was
        // unique, and the receipt says `changed: false`; that is a different answer from a
        // fuzzy tier matching bytes that were already right and reporting a change. Every
        // other identical-bytes outcome still fails exactly as before.
        if (changed === false && edit.oldString !== edit.newString) {
            throw new HarnessError(
                `edit did not change ${edit.target}: the replacement text is identical to the text it matched. Line endings follow the file; to change them, pass oldString and newString that differ only in carriage returns.`
            );
        }

        prepared.push({
            target: edit.target,
            identity: edit.identity,
            replacements: chosen.length,
            match: tier,
            changed
        });

        // Feed the result back so the next entry for this file matches against it.
        state.content = updated;
    }

    // One write per distinct file, in first-appearance order. A file whose final text is
    // the text it was read as is marked unchanged here and skipped in the write phase
    // (M12): a call that changed nothing must not hand the file a new inode (C2) or move
    // its mtime.
    const files: PreparedFile[] = [...texts.entries()].map(([identity, state]) => ({
        target: state.target,
        identity,
        updated: state.content,
        changed: state.content !== state.original
    }));

    return { prepared, files };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_EDIT_METADATA: PresetToolMetadata = {
    name: 'edit',
    description:
        'Replace text in one or more existing files. Pass an array of { path, oldString, newString } entries; oldString must match exactly, including whitespace and indentation, and must identify a unique location unless replaceAll is true, so an ambiguous edit is rejected instead of changing the wrong place. A call accepts at most 100 entries; split a larger batch, and a file larger than 8 MiB (8388608 bytes) is refused with EFBIG because edit reads and rewrites the WHOLE file - use read to see a region, or write to replace the file. Calls that name the same file are serialized per file (in this process only - a second harness process or a worker-thread lane keeps its own locks), so a concurrent write and edit never interleave into a torn file and a concurrent edit cannot silently clobber another edit: the later one fails with "no match" against the text the earlier one produced. Neither sentence holds across processes: a writer outside that lock - another harness process, a worker-thread lane, or a plain editor - can change the file between the read of this call and its publish, and that write simply wins, because the file is replaced under the name, not compared first. Several entries may name the SAME file: they are applied in array order, each matched against the text the previous one produced, so one call can change several places in one file and each file is still written once. Line endings are matched and preserved: write oldString and newString with \\n even for a CRLF file, and the replacement is re-joined line by line with the endings of the region it replaced: a line standing in for a matched line keeps the ending of that line, a genuinely new line takes the dominant ending of the region (that of the file when the region has none), and the last line gets no ending of its own, so a mixed-ending file stays mixed and the endings the caller typed survive only when it spells them itself: with \\r, or in the differ-only-in-carriage-returns form below; a newString that contains \\r is ending-explicit and is written verbatim, byte for byte, so an explicit \\r\\n is never rewritten into the endings of the file; to convert the endings themselves, pass oldString and newString that differ only in carriage returns (a `\\r` in one and not the other): that form matches exact bytes, so it converts the endings of exactly the region it matched and nothing else. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line; otherwise it fails. That trailing-whitespace tier matches WHOLE LINES, so an edit that matched through it replaces those whole lines and removes the trailing whitespace inside them. A target whose bytes are not valid UTF-8, or that holds a NUL byte, is refused with EBINARY naming the byte offset: edit rewrites files byte for byte and never substitutes for bytes it cannot decode. Every entry is read and checked before anything is written, so one bad entry leaves every file unchanged. Each edited file is then published atomically: a reader sees either its previous content or its new content, never a partial write, and a failed publish leaves that file exactly as it was, with its own mode and no leftover staging file. The publish replaces the file instead of writing into it, so a hard link to it keeps the previous bytes, an existing read-only file (0444) can still be edited because only the directory has to be writable, and a target that is not a regular file - a directory, a FIFO, a device, a socket - is refused with a code rather than replaced by one. Passing the same text twice (oldString equal to newString) is a check, not a mistake: the entry still has to match uniquely, and it reports { changed: false } without rewriting the file. An empty oldString is accepted only against an EMPTY file, where it names the one place text can go and inserts newString; against a file that has text it matches everywhere, so it is refused. Returns an ordered array of { path, replacements, bytes, match?, changed? }, where `match` is present only when a fallback tier was used ("typographic" or "trailing-whitespace"), so a fuzzy match is never silent, and `changed` only when the entry changed nothing on disk. A cancelled call rejects with `ECANCELED` and names the files already edited: there is no rollback. Creates nothing: use write for new files.',
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
    execute: async ({ parameters: edits, signal }) => {
        // Cancellation before ANY work, including the normalization (which resolves every
        // target and looks up every identity): a cancelled call has no consumer for any of
        // it, and `ECANCELED` is a code from FILE_EDIT_ERROR_CODES rather than a platform
        // exception (./cancellation.ts).
        throwIfFileCancelled('edit', signal, 'before any file was edited', {
            completedPaths: []
        });

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
                const { prepared, files } = await prepareEdits(normalized, signal);

                // Byte size per file IDENTITY, so entries sharing a file (including two
                // spellings of one path) report the same final size rather than each
                // other's intermediate text.
                const sizes = new Map<string, number>();
                // The files whose final text is now on disk — or was already, for a file this
                // call left alone — in the order they were reached. A partial failure names
                // this list, so it has to include the no-op entries too: their edits DID
                // apply, they just had nothing to publish.
                const applied: string[] = [];

                for (const file of files) {
                    // M12 — a file whose final text equals the text it was read as is not
                    // published at all. C2 makes that worth more than tidy bookkeeping:
                    // without the skip, a no-op would still rename a new inode into place,
                    // reset the mtime, and invalidate a reader's open handle for nothing.
                    if (file.changed) {
                        try {
                            // No mkdir: the parent must already exist, because the file did.
                            //
                            // C2 — staged + renamed through the SAME publish ./write.tool.ts
                            // uses (./atomic-publish.ts), in place of `writeFile`, whose 'w'
                            // flag emptied this file's own inode before a byte of the new text
                            // had arrived. The publish also resolves the symlink chain so the
                            // rename happens on the real target, copies the mode onto the
                            // staged file, refuses a non-regular landing, and on failure leaves
                            // the previous content and no `.tmp-` litter. `signal` rides along
                            // because that publish is where the per-entry cancellation check
                            // lives for BOTH writers: a batch cancelled at file 12 stops there
                            // and reports 1-11 as applied (./cancellation.ts).
                            await publishAtomically('edit', file.target, file.updated, signal);
                        } catch (error) {
                            // Partial success is reported honestly: the completed paths are
                            // named, and there is no claim of a transaction or rollback. The
                            // failed target is deliberately NOT in the list: it still holds
                            // the text it had before, which is exactly what the staged publish
                            // above guarantees.
                            //
                            // M11 — the same facts in the machine-readable half, so a caller
                            // that has to recover does not parse prose: `code` from the shared
                            // fold (an unknown errno becomes EIO and names the real one in
                            // `rawCode`), and the failed/completed paths as data.
                            const { code, rawCode } = publishErrorCode(error);
                            // Node's errno messages have NO trailing period, so the old
                            // interpolation glued two sentences together ("... open '/x' Edits
                            // already applied: none.").
                            const reason = (error instanceof Error ? error.message : String(error)).replace(
                                /[\s.]+$/,
                                ''
                            );
                            const completed = applied.length === 0 ? 'none' : applied.join(', ');

                            throw new HarnessError(
                                `edit failed on ${file.target}: ${reason}. Edits already applied: ${completed}. No rollback was performed.`,
                                {
                                    code,
                                    details: {
                                        failedPath: file.target,
                                        completedPaths: applied,
                                        ...(rawCode === undefined ? {} : { rawCode })
                                    }
                                }
                            );
                        }
                    }

                    applied.push(file.target);
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

                    // And only mention `changed` when it is FALSE (M12) — same convention as
                    // `match`, and for the same reason: an additive field has to be absent in
                    // the ordinary case or every existing receipt, and the tests that pin
                    // `{ path, replacements, bytes }`, changes shape.
                    if (edit.changed === false) entry.changed = false;

                    return entry;
                });
            }
        );
    }
});
