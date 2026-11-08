// read — read a BOUNDED window of one or more UTF-8 text files.
//
// WHY BOUNDED BY DEFAULT
// ----------------------
// Reading every requested file in full is unsafe as a model-facing default: one
// minified bundle or log file can consume the entire context window, and the
// harness only caps the SERIALIZED result after the fact (see
// ../../core/result-budget.ts). This implementation bounds its own work:
//
//   - a 1-based line window per file: `startLine` (default 1) plus `maxLines`
//     (default: no line cap, so the budget decides; an EXPLICIT value is capped at
//     20000 — see "WHY THE DEFAULT LINE CAP IS GONE" below);
//   - an aggregate budget of 256 KiB of SERIALIZED JSON across the whole batch
//     (`FILE_READ_WIRE_BUDGET`), allocated by demand rather than by headcount;
//   - a streaming read chunk and a hard stop as soon as the allowance is reached,
//     so a single huge file or line is never pulled into memory wholesale;
//   - at most 100 paths per call, so thousands of empty files cannot inflate the
//     metadata side of the response;
//   - explicit binary rejection (NUL bytes or invalid UTF-8) for every byte INSIDE
//     the returned window, because replacing binary bytes with U+FFFD would be a
//     silently wrong answer. This is not whole-file validation: bytes before the
//     window, after the last read chunk, or after an early stop are never decoded.
//     The consequence is deliberate and is stated in the tool description — a file
//     whose NUL sits past the requested window reads as TEXT for that window and as
//     EBINARY for a wider one. Rejecting the file outright would mean reading all of
//     it to decide, which is exactly the unbounded work this tool exists to avoid,
//     and the bytes the caller asked for are genuinely valid text either way.
//     Skipping the prefix is now a BYTE scan (newline counting with `indexOf`), so
//     bytes before the window are not merely unread, they are not even decoded: a
//     file that is invalid UTF-8 only BEFORE the window reads fine.
//
// THE BUDGET IS WIRE BYTES, NOT CONTENT BYTES
// -------------------------------------------
// The previous contract budgeted 64 KiB of raw UTF-8 CONTENT and the harness then
// capped the SERIALIZED result at the same 64 KiB. Those are different numbers for
// the same response: `JSON.stringify` escapes `\n`, `"`, `\` and control
// characters, so a result that exactly filled the content budget was ALWAYS over
// the wire budget. The harness then cut it mid-string and replaced the whole object
// with its own envelope, destroying every field a caller needs in order to continue
// — `nextLine`, `nextColumn`, the per-entry `truncated` — so the agent could not
// resume. Measured escape overhead: 2.1% on realistic source, 15.2% on
// quote/backslash-heavy code.
//
// So the budget here is charged against the SERIALIZED form. Each character costs
// its escaped UTF-8 length (`\n` is two bytes, an emoji four), and the fixed JSON
// scaffolding of each entry (keys, braces, the resolved path) is reserved up front.
// `bytes` still reports RAW content bytes, because that is what a caller compares
// against a file; `wireBytes` reports the exact serialized length of what was
// produced. The result therefore fits the envelope it is delivered in.
//
// WHY ONE ARRAY PROPERTY (T14 batching rule, preserved)
// ------------------------------------------------------
// Reading several files is one intent, not several round trips. The schema still
// declares exactly ONE property, `paths`, so the single-property rule (see
// ../../core/tool.ts) hands `execute` the array itself:
//
//     read(['a.ts', 'b.ts'])
//     read([{ path: 'a.ts', startLine: 10, maxLines: 20 }])
//
// A model call carries `{ "paths": [...] }` and reaches this same code. Each item
// is either a path string (defaults: startLine 1, no line cap) or a range object
// `{ path, startLine?, startColumn?, startByte?, maxLines? }`. Keeping the range on
// the item — rather than adding top-level properties — is deliberate: a second
// top-level property would disable the single-property rule and break every
// existing paths-only call.
//
// ALLOCATION IS BY DEMAND, NOT BY HEADCOUNT
// -----------------------------------------
// The old split was `budget / numberOfFiles`. One small file beside one large one
// therefore wasted the small file's whole share, and a batch of 100 tiny files
// starved the one file that mattered down to 655 bytes — 6.4% of the budget used.
// Allocation is now water-filling: every file gets an equal share, files that need
// less than their share hand the difference back, and the surplus is offered to the
// files that were actually cut. A 40 KiB file beside 99 36-byte files returns in
// full; 100 equal large files still split evenly.
//
// This terminates. Each pass either leaves no file truncated (done) or satisfies at
// least one file, and a satisfied file's allowance never shrinks: the remaining
// budget divided among the still-truncated files is at least the previous share,
// because the satisfied files took no more than their share. Passes are also capped
// (ALLOCATION_PASSES) so the re-scan work stays bounded on a pathological batch.
//
// RESULT SHAPE
// ------------
//     {
//       files: [{ path, content, startLine, endLine, truncated, limit, nextLine,
//                  nextColumn, nextByte, bytes, sizeBytes, error? }],
//       truncated: boolean,          // any file truncated
//       bytes: number,               // total RAW content bytes returned
//       wireBytes: number,           // serialized bytes the budget is charged on
//       contentBudget: number,       // the wire budget this call was subject to
//       skipped: number,             // entries that reported an error, not content
//       note?: string                // advisory for a truncated LARGE file
//     }
//
// WHY A TOP-LEVEL `note` EXISTS (R4)
// ----------------------------------
// Every continuation field this tool publishes is per ENTRY, and a caller that reads a
// 261 KB file gets back 256 KB of text plus four numbers it has to notice and
// interpret. In a reviewed agent run that is exactly what did not happen: the model
// read a truncated window of a large file, saw no prose telling it the file continued,
// and answered as if it had the whole file. Small reads do not need the sentence (the
// entry fields are the contract, and a note on every entry would cost budget).
//
// So `note` is a ONE-LINE-PER-FILE advisory, emitted only when BOTH hold:
//   - the entry is `truncated` and therefore has a continuation (`nextByte` or
//     `nextLine`), and
//   - the file is at least FILE_READ_NOTE_MIN_BYTES (64 KiB).
//
// The size gate is what keeps the note an advisory rather than boilerplate, and it is
// also why a 261 KB SINGLE-LINE file gets no note: such a file needs no escaping, so
// it comes back whole (`truncated: false`, nothing withheld), and `sizeBytes` already
// reports its size. A 261 KB multi-line file crosses the wire budget because every
// `\n` costs two serialized bytes, and that is the case the note is for.
//
// At most FILE_READ_NOTE_MAX_PATHS paths are spelled out and the rest are counted, so
// a 100-file batch cannot spend the budget it just freed on the advisory. The note's
// worst-case serialized cost is reserved BEFORE the content budget is split
// (`noteReserve`), which is what keeps `wireBytes <= contentBudget` true with the note
// present — the guarantee the wire-cap test exists to prove. That reserve is priced in
// UTF-8 BYTES like the measurement it protects, never in UTF-16 code units: a path of
// CJK characters costs three bytes per character, and a code-unit reserve under-shoots
// the cap by exactly the difference (F1).
//
// A clause never advises "raise maxLines" to a caller already at FILE_READ_MAX_LINES,
// because following that advice with 20000+1 is rejected as an invalid request; at the
// ceiling the note names the ceiling and gives the continuation instead (F3).
//
// WHY `limit` EXISTS (D5)
// -----------------------
// `truncated: true` used to be the whole story, and it is not actionable on its own:
// a window cut by `maxLines` and a window cut by the byte budget have IDENTICAL
// shapes, but the right response is the opposite in each case — raise `maxLines` for
// one, accept less for the other. An agent that cannot tell them apart guesses and
// spends a round trip finding out. `limit` names the reason: "maxLines", "budget",
// or null when the window reached EOF.
//
// `path` is the ABSOLUTE resolved path. `content` is raw text: line 1 of `content`
// corresponds to file line `startLine`, so line numbering is METADATA rather than
// prefixes inside the copied text. `endLine` is the last line represented (it may
// equal startLine for a partial line, and is startLine - 1 when nothing was
// returned). `sizeBytes` is the whole file's size, so a caller can judge how much
// is left without paying for another read.
//
// `error` is present on a per-entry failure (see FAILURE SEMANTICS): it carries
// `{ code, message }` and the entry's metadata is the same empty-window shape an
// empty file would produce. Every other entry has no `error` property at all, so an
// existing caller that compares whole entries is unaffected.
//
// CONTINUATION
// ------------
// `truncated` means "more file content exists after this window". When true:
//   - `nextLine` is the 1-based line to request next;
//   - `nextColumn` is the 0-based UTF-8 BYTE offset within that line (0 at a line
//     boundary). A giant single line is the only reason this is non-zero: the
//     window was cut mid-line, and `{ path, startLine: nextLine,
//     startColumn: nextColumn }` resumes exactly where it stopped, at a code-point
//     boundary. Repeating the request pages through a line of any size;
//   - `nextByte` is the ABSOLUTE file offset of the first unread byte, always exact
//     and always on a code-point boundary. Passing it back as `startByte` resumes by
//     SEEKING, with no line counting, so a large file can be walked in O(window) per
//     call instead of O(file). When `startByte` is supplied, `nextColumn` is measured
//     from `startByte` rather than from the physical line start; `nextByte` and
//     `nextLine` stay exact.
// When false, `limit` is null and `nextLine`, `nextColumn` and `nextByte` are null:
// the window reached the end of the file.
//
// STARTBYTE IS A BYTE ADDRESS, AND IS TREATED AS ONE (D1, D2)
// -----------------------------------------------------------
// `startByte` used to be handed straight to the decoder. Two consequences, both now
// fixed:
//
//   - A hand-computed or byte-oriented offset can land in the MIDDLE of a multi-byte
//     code point. The streaming decoder then saw a lone continuation byte, called the
//     whole file binary, and reported EBINARY for a perfectly ordinary UTF-8 file —
//     while the same offset through `startColumn` read fine. A seek offset is now
//     advanced to the next code-point boundary (skipping `0b10xxxxxx` lead-ins) and
//     the adjusted value is reported as `startByteAligned`, so the answer says where
//     the window really began. EBINARY is reserved for genuinely invalid sequences.
//   - With no `startLine`, the scanner used to report the DEFAULT line number 1 for
//     bytes that were tens of thousands of lines deep, which is a wrong number rather
//     than a missing one. The scanner counts the skipped prefix on the raw bytes at
//     `indexOf` speed, so the true line at a seek offset is now cheap to know and is
//     reported. An EXPLICIT `startLine` still wins — threading `nextByte` and
//     `nextLine` back together remains correct and skips the count entirely — but a
//     seek with no `startLine` is no longer a lie.
//
// FAILURE SEMANTICS (per-entry; only a malformed request rejects the call)
// ------------------------------------------------------------------------
// A path that cannot be read does NOT fail the call. Every requested path keeps its
// ordered position and an unreadable one becomes an entry with empty `content`,
// `bytes` 0 and a structured `error`. This covers ENOENT, a directory, a permission
// denial, BINARY CONTENT, and a `startByte` at or past the end of the file. The middle
// three previously rejected the whole batch and destroyed the content of every other
// file in it. A failed entry consumes no content budget, so the readable files in the
// same call keep their full share.
//
// WHY A SEEK PAST EOF IS AN ERROR AND NOT AN EMPTY WINDOW (D10)
// -------------------------------------------------------------
// `startByte: 9999` on a 6-byte file used to return `content: "", bytes: 0,
// truncated: false` — indistinguishable from "this file is empty". A caller threading
// a stale `nextByte` through a loop therefore read "the file is empty" where the truth
// is "your offset is out of range", and the loop terminated on a false premise. The
// entry now carries `error: { code: "ERANGE" }` naming the file size, so the two
// outcomes are different answers. A `startByte` exactly at EOF is the same case: there
// is no byte there to read.
//
// Only a malformed REQUEST still rejects the whole call, before any disk access: a
// non-array argument, an empty array, too many paths, a blank/NUL/non-string path,
// or an invalid range value. Those are caller bugs rather than file outcomes, and
// answering them per-entry would let a broken request look like a successful read.
//
// BINARY DETECTION IS WINDOW-SCOPED, NOT WHOLE-FILE
// -------------------------------------------------
// A file is called binary by the bytes this call actually decoded. A text file with
// one stray NUL far past the requested window therefore reads as text for the window
// and as EBINARY for a wider one (measured: a 100 KB file whose NUL sits at byte
// 100,001 returns line 1 fine and fails a whole-file read). That is the honest answer
// — the bytes you asked for ARE valid text — and the only alternative, scanning the
// entire file to classify it, would charge every small read for the largest file in
// the batch. `sizeBytes` is always reported, so a caller that needs a whole-file
// verdict can page to the end.
//
// COST OF RANGES
// --------------
// A window at line N with no `startByte` requires counting from byte 0, so it rescans
// the skipped prefix; memory stays bounded by the allowance and the chunk size. The
// skip is a BYTE scan — newlines are counted with `Buffer.indexOf(0x0a)` over the raw
// chunk and only the requested window is decoded — because the previous shape decoded
// every skipped byte and iterated it CHARACTER BY CHARACTER purely to count newlines.
// Measured on an 11 MB file, the same 50-line window: `startLine: 1` 1.6 ms, deep
// `startLine: 199000` 482 ms (302x the shallow read), a `startByte` seek 0.7 ms. The
// byte scan brings a deep line window to within a few percent of the seek, and it is
// exactly equivalent: both count 0x0a bytes, which in UTF-8 can only be a real newline.
//
// There is deliberately no shared line-index cache: it would be process-global mutable
// state whose lifetime is unbounded, and `startByte` already gives a caller the O(1)
// resume without that complexity or any staleness risk.
//
// WHY THE REALLOCATION PASS SEEKS INSTEAD OF RESTARTING (D4)
// ----------------------------------------------------------
// Water-filling re-scans a file that was cut, with a larger allowance. It used to
// re-scan from byte 0 every time, so the bytes it had ALREADY produced were decoded
// and cost twice: a 300 KB file alone cost 18.5 ms and the same file beside one 1-byte
// file cost 26.5 ms (1.43x) purely because the surplus pass rebuilt the whole window.
// Pass 1 reports an exact `nextByte` at its cut point, so a later pass seeks there and
// decodes only the SURPLUS, appending to the text pass 1 kept. The window is identical
// — the seek offset is the cut offset, on a code-point boundary by construction — and
// the skipped prefix is a byte scan rather than a second decode.
//
// No sandbox: paths are resolved against the process working directory and used as
// given. Run the harness under whatever process boundary the host provides (a
// container, a worktree, a scoped cwd), or wrap `execute`.
//
// Executable on its own and registerable on a harness:
//
//     await read(['package.json']);
//     await read([{ path: 'README.md', startLine: 20, maxLines: 40 }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';

// Default and hard limits. These are exported so docs/tests can quote the same
// numbers the implementation enforces (and so a host cannot quietly disagree).
//
// WHY THE DEFAULT LINE CAP IS GONE (D6)
// -------------------------------------
// The default used to be 5000 lines, justified by "at 5000 lines the budget binds
// first". That holds for ~55-byte source lines and nowhere else: a default read of a
// 60,001-line file of short lines used 11.2% of the 256 KiB budget, and even at the
// 20,000-line hard maximum only 49.3% (measured). The tool returned a small answer and
// made the agent pay a full round trip for the rest. Memory is bounded by the WIRE
// BUDGET in every case — a 256 KiB window cannot exceed 256 KiB however many lines it
// holds — so a line cap below the budget buys no safety, only latency. The default is
// therefore "no line cap: the budget decides", and `maxLines` remains as an explicit
// per-request guard for a caller who wants a smaller window than the envelope allows.
//
// WHY AN EXPLICIT maxLines IS STILL CAPPED
// ----------------------------------------
// The default bypasses the cap because the budget already bounds it. An EXPLICIT
// request is still capped at FILE_READ_MAX_LINES, so a hand-written
// `maxLines: 100000000` cannot ask for an unbounded line window and defeat the shape
// of the tool. The asymmetry is deliberate and is stated in the description.
//
// The honest cost of the change: a DEFAULT read of a large file now commits up to the
// whole budget rather than a fifth of it, so a careless default read costs more tokens
// per call. That is the intended direction — the budget is the documented governor.
export const FILE_READ_DEFAULT_MAX_LINES = Number.MAX_SAFE_INTEGER;
export const FILE_READ_MAX_LINES = 20_000;

// The aggregate budget, charged against the SERIALIZED JSON of the result rather
// than raw content. 256 KiB is roughly 64k tokens of English prose.
//
// The old bug was two independent constants — read's content budget and the
// harness's wire cap — both set to 64 KiB while describing the SAME response, so a
// full-budget read was always over the cap and got destroyed. The fix is that read
// now measures its own budget on the serialized form.
//
// The value is written out rather than imported from ../../core/result-budget on
// purpose: a relative import becomes a CAPTURED SOURCE DEPENDENCY of the compiled
// tool (see harness.self-modifying.test.ts and toolbox-sources.test.ts, which pin
// that shipped presets compile with `dependencies: []`), and it would make read
// non-self-contained against its own "executable on its own" contract. The two
// numbers are kept equal by an assertion in read.test.ts instead, which catches the
// drift without changing how the tool compiles.
export const FILE_READ_WIRE_BUDGET = 256 * 1024;

// Back-compat alias for the aggregate budget's historical name. It now denotes
// WIRE bytes; the result still reports it as `contentBudget` so existing callers
// keep a number they can compare against.
export const FILE_READ_CONTENT_BUDGET = FILE_READ_WIRE_BUDGET;

// A batch cap as well as a content cap: without it, thousands of empty files
// would still return thousands of metadata entries and blow the response up.
export const FILE_READ_MAX_TARGETS = 100;

// Read this many bytes at a time. Large enough to amortize syscalls, small enough
// that a huge single line cannot be pulled into memory before the allowance stops
// it.
const READ_CHUNK_BYTES = 64 * 1024;

// Upper bound on reallocation passes. Convergence is guaranteed (see the
// water-filling note above); this only bounds the re-scan work when a batch is
// adversarial, and two passes already handle every realistic case.
const ALLOCATION_PASSES = 4;

// THE LARGE-FILE ADVISORY (`note`) — see "WHY A TOP-LEVEL `note` EXISTS" above.
//
// A file at or above this size is the case where a truncated window is genuinely
// surprising: 64 KiB is the size every OTHER file tool in this package caps a whole
// response at (`FILE_GLOB_CONTENT_BUDGET`, `FILE_GREP_CONTENT_BUDGET`), so a file this
// large cannot be taken in by any of them in one call, while a smaller one usually
// can. Below the gate the per-entry continuation fields are the whole contract and a
// note would be noise charged against the caller's context.
export const FILE_READ_NOTE_MIN_BYTES = 64 * 1024;

// How many paths the note spells out. Beyond that the affected files are COUNTED,
// because a 100-file batch of large reads must not spend the wire budget the allocator
// just freed on the advisory itself.
export const FILE_READ_NOTE_MAX_PATHS = 2;

// Per-path request: a bare path keeps the old call shape, an object selects a
// window. All range fields are optional so `{ path }` is valid too.
export type FileReadTarget =
    | string
    | {
          // Path to read, absolute or relative to the process working directory.
          path: string;
          // 1-based first line to return. Defaults to 1.
          startLine?: number;
          // 0-based UTF-8 byte offset within startLine. Defaults to 0. This is the
          // continuation value reported as `nextColumn` for a giant line.
          startColumn?: number;
          // Absolute 0-based UTF-8 byte offset to seek to, skipping the line count.
          // Feed back the `nextByte` of a previous window. An explicit `startLine`
          // is still honoured as the reported number (threading nextByte/nextLine
          // through together stays correct and skips the count entirely); WITHOUT
          // one, the true line at that offset is counted on the raw bytes and
          // reported rather than defaulting to 1. An offset that falls inside a
          // multi-byte code point is advanced to the next boundary and reported as
          // `startByteAligned`; an offset at or past EOF is an ERANGE entry.
          startByte?: number;
          // Maximum lines to return. DEFAULT: no line cap, so the byte budget is the
          // only limit. An EXPLICIT value is an integer in [1, 20000].
          maxLines?: number;
      };

// A per-entry failure that is REPORTED, not thrown: anything the caller named that
// cannot be read as text. `code` lets a caller branch on it; `message` is the
// human-readable sentence, naming the requested path.
//
// ERANGE is the one code that describes the REQUEST rather than the file: the
// `startByte` it carried is at or past the end of that file. It is a per-entry error
// and not a rejected call because the same offset may be perfectly in range for the
// other paths in the batch, and because the honest answer is "offset out of range",
// which an empty window is not.
export type FileReadErrorCode = 'ENOENT' | 'EISDIR' | 'EACCES' | 'EPERM' | 'EBINARY' | 'ERANGE' | 'EIO';

export type FileReadEntryError = {
    code: FileReadErrorCode;
    message: string;
};

// One file's bounded window, in request order.
export type FileReadEntry = {
    // The absolute path that was read.
    path: string;
    // Raw UTF-8 text of the returned window. Line 1 is file line `startLine`.
    content: string;
    // 1-based line number of the first line represented by `content`.
    startLine: number;
    // 1-based line number of the last line represented by `content`. Equals
    // `startLine - 1` when no line was returned (empty file or EOF before the
    // requested range).
    endLine: number;
    // True when more file content exists after this window. See nextLine/nextColumn.
    truncated: boolean;
    // WHY the window stopped, which is what makes `truncated` actionable (D5):
    // "maxLines" when the requested line cap was reached (raise `maxLines` to get
    // more), "budget" when the serialized-byte allowance ran out (more budget would
    // help, more lines would not), and null when the window reached EOF. Never
    // non-null while `truncated` is false.
    limit: 'maxLines' | 'budget' | null;
    // The offset the window actually began at, when `startByte` was supplied and had
    // to be advanced to a code-point boundary (D1). Null when no adjustment was
    // needed, which is the usual case, and when no `startByte` was given.
    startByteAligned: number | null;
    // 1-based line to request next, or null when the window reached EOF.
    nextLine: number | null;
    // 0-based UTF-8 byte offset within nextLine, or null when not truncated.
    nextColumn: number | null;
    // Absolute 0-based byte offset of the first unread byte, or null when not
    // truncated. Pass it back as `startByte` to continue without rescanning.
    nextByte: number | null;
    // UTF-8 bytes in `content` (raw, as they exist in the file).
    bytes: number;
    // Total size of the whole file in bytes, or null when the entry failed.
    sizeBytes: number | null;
    // Present ONLY when this path could not be read (missing, directory, permission
    // denial, binary content, or a `startByte` at or past EOF). The entry then carries
    // empty content, bytes 0 and an empty-window range; the call itself succeeds and
    // the other entries are unaffected. Absent for every readable file.
    error?: FileReadEntryError;
};

// The ordered batch result. `files` has exactly one entry per requested path.
export type FileReadResult = {
    files: FileReadEntry[];
    // True when at least one entry is truncated (line limit or content budget).
    truncated: boolean;
    // Total RAW UTF-8 content bytes returned across `files`.
    bytes: number;
    // Serialized bytes this response costs — the figure the budget governs, measured
    // on the real output rather than estimated.
    wireBytes: number;
    // The aggregate wire budget this call was subject to.
    contentBudget: number;
    // How many entries reported an `error` instead of content.
    skipped: number;
    // The prose advisory for a LARGE file whose window was cut — one short sentence per
    // affected file (path, `sizeBytes`, bytes returned, and the continuation to use),
    // first FILE_READ_NOTE_MAX_PATHS paths named and the remainder counted. Present ONLY
    // when at least one entry is large enough and truncated enough to need it (see the
    // "WHY A TOP-LEVEL `note` EXISTS" section), and the bytes it can cost are reserved
    // before the content budget is split, so it never pushes the response over
    // `contentBudget`. The key is absent, not `undefined`, for a small or complete read.
    note?: string;
};

// The value `execute` receives: the `paths` array itself (single-property rule).
export type FileReadParameters = FileReadTarget[];

// A validated request, with every default resolved.
type NormalizedTarget = {
    path: string;
    startLine: number;
    // True when the CALLER named `startLine`. Only then may it override the line the
    // scanner would otherwise count at a `startByte` seek (D2): an absent `startLine`
    // means "I do not know", not "line 1".
    startLineGiven: boolean;
    startColumn: number;
    startByte: number | null;
    maxLines: number;
};

// One file's place in the allocation. `entry` stays null until a pass scans it, and
// a failed open fills it immediately so the file never takes part in the split.
type ScanSlot = {
    request: NormalizedTarget;
    handle: FileHandle | null;
    sizeBytes: number;
    entry: FileReadEntry | null;
    // JSON scaffolding this entry costs regardless of how much content it returns.
    overhead: number;
    // True when the LAST scan of this slot stopped because of the byte allowance
    // rather than `maxLines` or EOF. Only such a slot is a candidate for surplus.
    cutByBudget: boolean;
    // The window the LAST scan produced, kept so a surplus pass can SEEK to its
    // resume offset and decode only what is missing instead of rebuilding the whole
    // window from byte 0 (D4). Null before this slot's first scan.
    progress: ScanProgress | null;
    // The resolved seek, computed once per call rather than once per pass: the line
    // count before a seek offset does not change between passes, and neither may the
    // code-point alignment. Undefined means "not resolved yet"; the sentinel-free
    // `undefined` check is what distinguishes it from a legitimate result.
    seek?: SeekStart | 'ERANGE';
};

// What one scan of one file had accumulated when it stopped: the window so far, plus
// the exact offset and line to continue from. A later allocation pass seeds a fresh
// scanner from this and appends only the surplus (D4), so the bytes already produced
// are never decoded twice.
type ScanProgress = {
    content: string;
    contentBytes: number;
    wireBytes: number;
    endLine: number;
    emittedLines: number;
    // The line and byte-within-line the scanner stopped on, so a resume continues the
    // SAME line rather than starting a new one.
    lineNumber: number;
    lineOffset: number;
    // Absolute offset of the first byte the scanner did NOT consume. Always on a
    // code-point boundary, because the scanner stops between characters.
    resumeByte: number;
    // True when `maxLines` was already satisfied at the cut, so the next character is
    // what proves more content exists.
    limitReached: boolean;
    // The line number the entry reports for its first line, carried so a resume cannot
    // change it (a surplus pass must produce the SAME window, only longer).
    reportedStartLine: number;
    // Carried through from the request so the final entry reports it unchanged.
    startByteAligned: number | null;
};

// The serialized cost of one character inside a JSON string. This is what the
// budget is charged against, and it is what makes the result fit the envelope the
// harness delivers it in.
//
// `JSON.stringify` escapes exactly these single-character forms in ordinary text:
// `"`, `\`, and the control characters. Node emits `\n`, `\r`, `\t`, `\b`, `\f` as
// two-character escapes and every other control character as a six-character
// `\u00XX`. Everything else — including U+2028/U+2029, which `JSON.stringify` leaves
// literal — costs its UTF-8 length.
//
// It takes a CODE POINT and its UTF-8 length rather than a string, because the
// scanner walks decoded text a code point at a time and already knows both; calling
// `Buffer.byteLength` per character was the single hottest line in the read loop
// (measured: 12.8 ms -> 4.6 ms on 2.3 MB of source, 5.4 ms -> 1.4 ms on
// escape-heavy text, byte-identical output over 594 budget boundaries).
const escapedCharBytes = (code: number, utf8Bytes: number): number => {
    if (code === 0x22 || code === 0x5c) return 2; // " and backslash
    if (code === 0x0a || code === 0x0d || code === 0x09) return 2; // \n \r \t
    if (code === 0x08 || code === 0x0c) return 2; // \b \f
    if (code < 0x20) return 6; // \u00XX

    return utf8Bytes;
};

// UTF-8 length of a code point. Derived arithmetically rather than by encoding it:
// the scanner needs this per character, and `Buffer.byteLength` allocates.
const utf8Length = (code: number): number =>
    code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

// The escaped length of a content string, computed exactly as the scanner charges
// it. Used to account for entries already scanned in an earlier pass.
const contentWireBytes = (content: string): number => {
    let bytes = 0;
    for (const char of content) bytes += escapedCharBytes(char.codePointAt(0) ?? 0, utf8Length(char.codePointAt(0) ?? 0));
    return bytes;
};

// The JSON scaffolding of one entry, measured on a real entry shape rather than
// guessed: the braces, every `"key":`, the separators, and the quoted path. Field
// names are fixed so their cost is fixed; only the path varies.
const ENTRY_SHELL = JSON.stringify({
    path: '',
    content: '',
    startLine: 0,
    endLine: 0,
    truncated: false,
    limit: null,
    startByteAligned: null,
    nextLine: 0,
    nextColumn: 0,
    nextByte: 0,
    bytes: 0,
    sizeBytes: 0
});

// Allowance for the numeric/boolean values growing beyond the single digits used in
// ENTRY_SHELL: a `startLine` of 199990 costs six bytes rather than one, and there
// are nine such fields. It does NOT cover an `error` object, whose message is
// measured exactly instead (see entryOverhead) — reserving a flat 400 bytes for all
// 100 slots would have wasted 15% of the budget on the common no-error path.
const ENTRY_VALUE_RESERVE = 200;

// The JSON cost of one entry's `error` object, measured on the real message. A
// failed entry is known before scanning starts, so there is no need to guess.
//
// `Buffer.byteLength`, NOT `String.length` (F1): the budget is charged on the UTF-8
// bytes the harness actually serializes (see the `shape()` measurement below), while
// `.length` counts UTF-16 code units. An error message embeds the requested path, so
// `.length` UNDER-states the cost by 2 bytes per CJK character (3 UTF-8 bytes against 1
// code unit) and by 2 more per astral character (4 UTF-8 bytes against the 2 code units a
// surrogate pair occupies) — the reserve then buys content that does not fit, and
// `wireBytes` crosses the 256 KiB envelope, which is the failure `boundToolResult`
// turns into a truncated JSON envelope that destroys `nextByte`/`nextLine`.
// `ENTRY_SHELL`/`RESULT_SHELL` below need no such conversion: their every character
// is ASCII, where the two measures agree by construction.
const entryErrorWire = (code: string, message: string): number =>
    Buffer.byteLength(JSON.stringify({ error: { code, message } })) - 1; // -1: the leading comma

// One entry's fixed scaffolding, in UTF-8 BYTES (see `entryErrorWire` for why the
// measurement is not `.length`): the shell, the escaped path, the value allowance,
// and the error object when this path is unreadable. The `- 2` removes the two quote
// characters `JSON.stringify` adds, because `ENTRY_SHELL` already contains them for
// the empty path; quotes are ASCII, so removing them from a byte count is exact.
const entryOverhead = (path: string, error?: { code: string; message: string }): number =>
    ENTRY_SHELL.length + (Buffer.byteLength(JSON.stringify(path)) - 2) + ENTRY_VALUE_RESERVE +
    (error === undefined ? 0 : entryErrorWire(error.code, error.message));

// The fixed cost of the result object around the array: `files`, the four summary
// fields, and their separators. Measured, not guessed.
const RESULT_SHELL = JSON.stringify({
    files: [],
    truncated: false,
    bytes: 0,
    wireBytes: 0,
    contentBudget: 0,
    skipped: 0
});

// ---------------------------------------------------------------------------
// THE LARGE-FILE ADVISORY (`note`) — rationale in the header section of the same
// name. Two functions share one set of clause builders: `buildReadNote` produces the
// text after the scan, `noteReserve` prices its WORST CASE before the scan, so the
// response cannot grow past the budget it measured itself against.
// ---------------------------------------------------------------------------

// Fixed text of one clause, plus the widest number every field it quotes can carry:
//   `" is ` + ` bytes; returned ` + `(limit: maxLines at the 20000 ceiling)` +
//   ` - continue at startByte N, or { startLine: N, startColumn: N }`
// The quoted path is added on top by the caller, in UTF-8 BYTES and DOUBLE-ESCAPED
// (it is text inside the note string, which is itself serialized) — see `noteReserve`.
// 208 dominates the widest clause the builders above can emit: ~115 bytes of fixed
// text (the ceiling wording is the longest variant, longer than "raise maxLines") plus
// up to 15 digits on each of the five numbers it quotes.
const NOTE_CLAUSE_OVERHEAD = 208;

// Everything around the clauses: the `read: ` prefix, the `; ` separators, the
// "and N more large file(s)" tail, and the serialized `"note":"..."` key itself.
const NOTE_SHELL_OVERHEAD = 128;

// The prefix that makes the advisory self-describing once it is separated from the
// entries it refers to (a model reads the note in the result envelope, out of order).
const NOTE_PREFIX = 'read: ';

// One entry plus the line cap its request applied. `FileReadEntry.limit` says WHY the
// window stopped but not at what number, and `noteClause` needs the number to avoid
// advising "raise maxLines" at the ceiling (F3). Slots are paired with entries by
// index at the call site — `files` is `slots.map(...)`, so the order is the contract.
type NoteCandidate = {
    entry: FileReadEntry;
    maxLines: number;
};

// Does this entry deserve a sentence? BOTH must hold (see the header section):
// content was withheld, and the file is large. `truncated` alone is true for a
// 10-line file read with `maxLines: 3`, where the flags already say everything.
const noteWorthy = (entry: FileReadEntry): boolean =>
    entry.error === undefined &&
    entry.truncated &&
    entry.sizeBytes !== null &&
    entry.sizeBytes >= FILE_READ_NOTE_MIN_BYTES &&
    // A continuation the caller can actually act on. `truncated` normally implies one,
    // and the guard keeps a malformed entry from producing "continue at nothing".
    (entry.nextByte !== null || entry.nextLine !== null);

// The resume advice for one entry. `startByte` leads because it is the only form that
// resumes by SEEKING (no rescanned prefix), and it is exact even mid-line; the
// `{ startLine, startColumn }` spelling is offered because a caller that pages by line
// has those fields at hand. `startColumn` is named only when the cut landed INSIDE a
// line, where omitting it would resume at the wrong offset.
const noteContinuation = (entry: FileReadEntry): string => {
    const primary =
        entry.nextByte !== null ? `startByte ${entry.nextByte}` : `startLine ${entry.nextLine}`;

    // Nothing to offer as an alternative when the primary IS the line form.
    if (entry.nextByte === null || entry.nextLine === null) return primary;

    const column = entry.nextColumn === null || entry.nextColumn === 0 ? '' : `, startColumn: ${entry.nextColumn}`;

    return `${primary}, or { startLine: ${entry.nextLine}${column} }`;
};

// One file's sentence: size, what came back, why it stopped, and how to continue.
//
// `maxLines` is the cap THIS request applied, which the entry cannot report (its
// `limit` field is only the reason, not the number). The distinction matters because
// the two `maxLines` cases have OPPOSITE remedies:
//   - below the ceiling: raising `maxLines` is free progress, so the clause says so;
//   - AT the ceiling (FILE_READ_MAX_LINES): "raise maxLines" is a trap — following it
//     with 20001 is rejected by `readMaxLines` as an invalid request, so the clause
//     names the ceiling it hit and leaves the continuation as the only remedy (F3).
const noteClause = (entry: FileReadEntry, maxLines: number): string => {
    const limit =
        entry.limit !== 'maxLines'
            ? `limit: ${entry.limit ?? 'budget'}`
            : maxLines >= FILE_READ_MAX_LINES
              ? `limit: maxLines at the ${FILE_READ_MAX_LINES} ceiling`
              : 'limit: maxLines - raise maxLines';

    return `${JSON.stringify(entry.path)} is ${entry.sizeBytes} bytes; returned ${entry.bytes} (${limit}) - continue at ${noteContinuation(entry)}`;
};

// The note itself, built from the FINAL entries (paired with the cap each request
// applied — see `noteClause`). Absent (not empty) when no entry qualifies, so
// `note === undefined` keeps meaning "nothing needed explaining" — the same convention
// glob and grep publish, and the reason a JSON round trip cannot invent a key.
const buildReadNote = (candidates: readonly NoteCandidate[]): string | undefined => {
    const large = candidates.filter((candidate) => noteWorthy(candidate.entry));

    if (large.length === 0) return undefined;

    const clauses = large
        .slice(0, FILE_READ_NOTE_MAX_PATHS)
        .map((candidate) => noteClause(candidate.entry, candidate.maxLines));
    const rest = large.length - clauses.length;

    if (rest > 0) clauses.push(`and ${rest} more large file(s) report truncated/nextByte`);

    return `${NOTE_PREFIX}${clauses.join('; ')}.`;
};

// The serialized cost to reserve for the note BEFORE the content budget is split.
//
// The note itself needs the scan outcome, which does not exist yet, so the reserve is
// priced from the set the note can only ever be drawn from: a file the note may name is
// a READABLE slot (`entry === null` after the open phase) at or above
// FILE_READ_NOTE_MIN_BYTES, and that is exactly the predicate `noteWorthy` tests against
// the same `sizeBytes` (`scanSafely` copies the stat size onto the entry).
//
// The two LONGEST such paths are reserved, which dominates whatever pair the note
// actually names (it names the first two in request order), and the fixed clause and
// shell overheads are constants above sized for the widest numbers. A reserve larger
// than the final note only costs a few hundred content bytes out of 256 KiB; a reserve
// SMALLER than it would let `wireBytes` overshoot the budget, which is the one property
// the wire-cap test exists to protect.
//
// The path is priced in UTF-8 BYTES, not `String.length` (F1). The note quotes the path
// exactly as `JSON.stringify` renders it, and the harness measures the response in
// bytes, so a code-unit count under-states every non-ASCII path by 2 bytes per CJK
// character — which is how a 261 KiB read under a CJK path ended 52 bytes over the cap
// and lost its continuation fields to the envelope.
//
// The path term is priced DOUBLE-serialized (F1-residual), because the note is the one
// place in the response where a path is escaped TWICE: `noteClause` embeds
// `${JSON.stringify(entry.path)}` as TEXT inside the note string, and that string is
// then serialized as a JSON value. JSON string escaping is per code unit and
// context-free, so the wire cost of that embedded term is exactly
// `byteLength(JSON.stringify(quoted)) - 2` — hence the whole double-serialized length
// below, which dominates it by those 2 quote bytes. A single serialization prices each
// escaped path character at 2 bytes (`\"`) where the wire carries 4 (`\\\"`, because BOTH
// characters of the inner escape are escaped again) — 2 unpriced bytes per escaped
// character, plus 4 more for the two inner quote delimiters the outer pass also has to
// escape. Measured:
// 180 quotes under-reserved 364 bytes and a 261,000-byte multi-line read measured
// 262,146 against the 262,144-byte budget; 200 quotes + 40 backslashes under-reserve 484,
// which is 122 bytes past the cap on top of the ~362 bytes of slack `ENTRY_VALUE_RESERVE`
// and the shell constants leave — the envelope cut that destroys `files`/`nextByte`. The
// `read > holds the wire cap for a cut large file under an escape-heavy path` test pins
// exactly that shape. `entryOverhead` keeps the SINGLE measure: an entry's `path` is a
// JSON string value, escaped only once.
const noteReserve = (slots: readonly ScanSlot[]): number => {
    const candidates = slots
        .filter((slot) => slot.entry === null && slot.sizeBytes >= FILE_READ_NOTE_MIN_BYTES)
        // `resolve(...)` is the exact value `noteClause` embeds: a note-worthy entry is
        // a scanned one, and `scanSafely` sets `path: resolve(request.path)` (see the
        // entry construction above), so the reserve cannot price a different string than
        // the note quotes.
        .map((slot) => {
            const quoted = JSON.stringify(resolve(slot.request.path));
            return Buffer.byteLength(JSON.stringify(quoted), 'utf8');
        })
        .sort((left, right) => right - left)
        .slice(0, FILE_READ_NOTE_MAX_PATHS);

    if (candidates.length === 0) return 0;

    return (
        NOTE_SHELL_OVERHEAD +
        candidates.reduce((total, pathBytes) => total + pathBytes + NOTE_CLAUSE_OVERHEAD, 0) +
        // `; ` between clauses and the closing `.` of the sentence.
        (candidates.length - 1) * 2 +
        1
    );
};

// The ordered entry a failed path produces. It is shaped exactly like an empty
// window (empty content, endLine = startLine - 1, no continuation, zero bytes), so
// a caller's range arithmetic still holds, plus a structured `error` naming the
// requested path. `bytes: 0` is what keeps a failed entry out of the content split.
const failedEntry = (
    request: NormalizedTarget,
    code: FileReadErrorCode,
    message: string,
    sizeBytes: number | null = null
): FileReadEntry => ({
    path: resolve(request.path),
    content: '',
    startLine: request.startLine,
    endLine: request.startLine - 1,
    truncated: false,
    limit: null,
    startByteAligned: null,
    nextLine: null,
    nextColumn: null,
    nextByte: null,
    bytes: 0,
    sizeBytes,
    error: { code, message }
});

// Close best-effort, ignoring a handle that is already closed. Used on every
// failure path so a batch never leaks an open descriptor.
const closeQuietly = async (handles: Iterable<FileHandle>): Promise<void> => {
    for (const handle of handles) {
        try {
            await handle.close();
        } catch {
            // Nothing actionable: the call is already failing, or the handle was
            // closed by the scanner's own finally block.
        }
    }
};

// The binary rejection shared by the NUL and invalid-UTF-8 paths so the message
// (and therefore a test's expectation) cannot drift between them.
const binaryMessage = (path: string): string =>
    `read refused "${path}": the file contains binary data (NUL bytes or invalid UTF-8). read reads UTF-8 text only.`;

const directoryMessage = (path: string): string =>
    `read cannot read "${path}": it is a directory, not a file. Use files to list its entries, or glob to find files inside it.`;

// A `startByte` at or past the end of the file (D10). The message names the file size
// so the caller can see how far in range it was, and points at the two ways to fix it:
// drop `startByte` and read from the top, or stop paging — this offset IS the end.
const rangeMessage = (path: string, startByte: number, sizeBytes: number): string =>
    `read could not seek "${path}" to byte ${startByte}: the file is ${sizeBytes} bytes, so that offset is at or past its end (ERANGE). An empty window is NOT "this file is empty"; drop startByte to read from the beginning, or treat this as the end of the file.`;

// Validate one non-negative integer range field. `undefined` takes the default;
// anything else must be an integer in [minimum, maximum].
const readInteger = (
    value: unknown,
    field: string,
    defaultValue: number,
    minimum: number,
    maximum: number
): number => {
    if (value === undefined) return defaultValue;

    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new HarnessError(
            `read ${field} must be an integer between ${minimum} and ${maximum}; received ${String(value)}.`
        );
    }

    return value as number;
};

// The line cap. Absent means "no cap: the budget decides", which is the default.
// An explicit value must be in [1, FILE_READ_MAX_LINES] — with ONE deliberate
// exception: the exported default itself is accepted. A caller that reads
// `FILE_READ_DEFAULT_MAX_LINES` and passes it back must get the behaviour that constant
// names, not a validation error, and that is not hypothetical: the repo's own
// scripts/verify-read-fixes.mjs threads the constant through exactly this way, and so
// does any host that mirrors it. Refusing it would make the documented default a value
// the tool rejects. The MESSAGE does not advertise the sentinel, because printing
// 9007199254740991 at a model that passed `maxLines: 0` answers a question it did not
// ask; "omit it" is the actionable form.
const readMaxLines = (value: unknown): number => {
    if (value === undefined || value === FILE_READ_DEFAULT_MAX_LINES) return FILE_READ_DEFAULT_MAX_LINES;

    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > FILE_READ_MAX_LINES) {
        throw new HarnessError(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for no line cap; received ${String(value)}.`
        );
    }

    return value as number;
};

// `startByte` is the only nullable range field: absent means "count lines", present
// means "seek here". It must be a non-negative integer when supplied.
const readByte = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;

    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new HarnessError(`read startByte must be a non-negative integer or null; received ${String(value)}.`);
    }

    return value as number;
};

// A path must be a non-empty string with no NUL. NUL cannot exist in a real path
// and a non-string (e.g. a model sending 7) would reach the filesystem as an
// unhelpful type error.
const validatePath = (path: unknown): string => {
    if (typeof path !== 'string' || path.length === 0) {
        throw new HarnessError('read paths must be non-empty strings.');
    }

    if (path.includes('\u0000')) {
        throw new HarnessError('read paths must not contain NUL characters.');
    }

    return path;
};

// Validate every target BEFORE touching disk, so a typo in the last entry cannot
// produce a misleading partial answer (and so an invalid range never opens a file).
const normalizeTargets = (paths: FileReadParameters): NormalizedTarget[] => {
    if (!Array.isArray(paths)) {
        throw new HarnessError(
            'read expects an array of paths (strings or { path, startLine, startColumn, startByte, maxLines } objects), e.g. ["package.json"].'
        );
    }

    if (paths.length === 0) {
        throw new HarnessError('read received an empty paths array; pass at least one file path.');
    }

    if (paths.length > FILE_READ_MAX_TARGETS) {
        throw new HarnessError(
            `read accepts at most ${FILE_READ_MAX_TARGETS} paths per call; received ${paths.length}. Split the batch.`
        );
    }

    return paths.map((target) => {
        // A bare string is the historical shape: whole file, bounded by defaults.
        if (typeof target === 'string') {
            return {
                path: validatePath(target),
                startLine: 1,
                startLineGiven: false,
                startColumn: 0,
                startByte: null,
                maxLines: FILE_READ_DEFAULT_MAX_LINES
            };
        }

        // A range object must carry a usable path. Arrays/null/non-objects are
        // rejected with the same shape guidance as a non-array argument.
        if (target === null || typeof target !== 'object' || Array.isArray(target)) {
            throw new HarnessError(
                'read paths must be strings or { path, startLine, startColumn, startByte, maxLines } objects.'
            );
        }

        return {
            path: validatePath(target.path),
            startLine: readInteger(target.startLine, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER),
            // Whether the CALLER named it. A seek with no `startLine` must report the
            // true line rather than the default 1 (D2).
            startLineGiven: target.startLine !== undefined,
            startColumn: readInteger(target.startColumn, 'startColumn', 0, 0, Number.MAX_SAFE_INTEGER),
            startByte: readByte(target.startByte),
            maxLines: readMaxLines(target.maxLines)
        };
    });
};

// The mutable scanner state for one file. Kept explicit so the streaming loop can
// stop at an exact character boundary and report where the next window starts.
//
// There is no `startColumn` here any more. The prefix skip (lines before `startLine`,
// and the leading `startColumn` bytes of the first requested line) is now resolved to
// a BYTE OFFSET before any decoding happens — see `locateWindow` — so the character
// loop only ever sees bytes that belong to the window. That also removes the F1
// regression this field used to guard: a skip that lived inside the loop could reapply
// to later lines and silently drop their prefixes; a skip that happens once, up front,
// cannot.
type ScanState = {
    target: string;
    // Absolute file offset of the character currently being scanned. Deliberately
    // separate from the READ cursor: a streaming TextDecoder holds back a trailing
    // partial code point and emits it with the next chunk, so offsets are counted
    // per character and can never drift out of step with the decoded text.
    scanOffset: number;
    // The line number this entry REPORTS for the first returned line. It is the
    // requested `startLine` except for a seek with no `startLine`, where it is the
    // line actually counted at that offset (D2).
    startLine: number;
    maxLines: number;
    budget: number;
    lineNumber: number; // 1-based line currently being scanned
    lineOffset: number; // UTF-8 bytes consumed in the current line
    content: string;
    contentBytes: number;
    wireBytes: number;
    endLine: number;
    emittedLines: number;
    truncated: boolean;
    // "maxLines" | "budget" | null — the reason the window stopped (D5).
    limit: 'maxLines' | 'budget' | null;
    nextLine: number | null;
    nextColumn: number | null;
    nextByte: number | null;
    limitReached: boolean; // maxLines lines have been finalized
    stopped: boolean;
    // WHY the window stopped, because it decides whether more budget would help: a
    // file cut by the ALLOWANCE is worth re-scanning with a larger one, while a file
    // cut by `maxLines` is already complete for this request and would absorb
    // surplus it can never use.
    cutByBudget: boolean;
    // Non-null only when a supplied `startByte` had to be advanced to a code-point
    // boundary (D1); reported through to the entry verbatim, including across a
    // surplus resume.
    startByteAligned: number | null;
};

// Record the truncation point at the current character, so a continuation resumes
// exactly here rather than skipping or repeating it. `byBudget` also names the reason
// in `limit`, which is what tells a caller whether to raise `maxLines` or accept less.
const stopAt = (state: ScanState, line: number, column: number, byBudget: boolean): true => {
    state.truncated = true;
    state.limit = byBudget ? 'budget' : 'maxLines';
    state.nextLine = line;
    state.nextColumn = column;
    state.nextByte = state.scanOffset;
    state.cutByBudget = byBudget;
    return true;
};

// How many plain characters must be in a row before slicing them in bulk beats
// emitting them one at a time. Below this the scan to find the run end costs more
// than it saves: measured on escape-heavy JSON-ish text, an aggressive threshold was
// SLOWER than the plain per-character loop (1.65 ms vs 1.32 ms), while on ordinary
// source the bulk path is 7x faster (0.83 ms vs 5.97 ms). 24 is where both shapes win.
const MIN_PLAIN_RUN = 24;

// Process one decoded chunk. Returns true when the scanner is done (line limit
// followed by one more character, or the allowance exhausted).
//
// The prefix is already gone: `skipToWindow`/`resolveSeek` turned `startLine` and
// `startColumn` into a byte offset BEFORE anything was decoded, so every character
// this loop sees belongs to the window. What remains is the bounded contract:
//   1. `limitReached` — once maxLines is finalized, the NEXT character proves there
//      is more content, so the window is truncated (even if that character is a
//      newline: the next line is just empty). EOF means not truncated.
//   2. a character that would exceed the allowance truncates at this exact
//      character, so a giant line can be paged through without arbitrary omission.
//   3. otherwise the character is appended and counted in BOTH raw bytes (what
//      `bytes` reports) and escaped bytes (what the allowance is charged against).
//
// THE FAST PATH, AND WHY IT IS EXACT
// ----------------------------------
// A run of "plain" characters — single-byte ASCII that `JSON.stringify` leaves alone
// — costs the SAME number of raw bytes, wire bytes and UTF-16 units, and contains no
// newline (0x0a is a control character, so `isPlainCode` excludes it). So a run of N
// of them can be sliced and appended in one go, charging N to both counters and
// touching no line state. Only the characters that break a run — newline, quote,
// backslash, control characters, anything non-ASCII — go through the per-character
// path that tracks lines and escapes. Byte-identical output is not assumed here: it is
// pinned by an equivalence test against the reference loop over adversarial samples at
// every budget boundary.
//
// The loop is index-based over the decoded string rather than `for...of`, because the
// per-character path needs the UTF-16 length of a code point to step over a surrogate
// pair, and `Buffer.byteLength` per character was the hottest line in the tool.
const consumeText = (state: ScanState, text: string): boolean => {
    // Decoding is fatal, so this only catches NULs (which are valid UTF-8). A NUL
    // is the cheapest strong signal that the file is not text.
    if (text.includes('\u0000')) {
        throw new HarnessError(binaryMessage(state.target));
    }

    const length = text.length;
    let index = 0;

    while (index < length) {
        // 1. Line limit already reached: any further character means more content.
        if (state.limitReached) {
            return stopAt(state, state.lineNumber, 0, false);
        }

        const code = text.charCodeAt(index);

        // 2. Bulk-append a plain run. The run is found by a charCodeAt walk, which is
        // cheaper per character than the emitting path, so it is only taken up to a
        // lookahead bound; a run that reaches the bound is confirmed to its end.
        if (isPlainCode(code)) {
            let end = index + 1;
            const bound = Math.min(length, index + MIN_PLAIN_RUN);
            while (end < bound && isPlainCode(text.charCodeAt(end))) end += 1;

            if (end - index >= MIN_PLAIN_RUN || end === length) {
                while (end < length && isPlainCode(text.charCodeAt(end))) end += 1;
            }

            const runLength = end - index;
            const room = state.budget - state.wireBytes;

            // 3. Allowance check for the whole run at once: its wire cost is its
            // length, so `room` characters fit and no more.
            if (runLength > room) {
                if (room <= 0) return stopAt(state, state.lineNumber, state.lineOffset, true);

                state.content += text.slice(index, index + room);
                state.contentBytes += room;
                state.wireBytes += room;
                state.lineOffset += room;
                state.scanOffset += room;
                state.endLine = state.lineNumber;

                return stopAt(state, state.lineNumber, state.lineOffset, true);
            }

            state.content += text.slice(index, end);
            state.contentBytes += runLength;
            state.wireBytes += runLength;
            state.lineOffset += runLength;
            state.scanOffset += runLength;
            state.endLine = state.lineNumber;
            index = end;
            continue;
        }

        // 4. A character that needs care: escapes, newlines, anything multi-byte.
        const point = text.codePointAt(index) as number;
        const units = point < 0x10000 ? 1 : 2;
        const charBytes = utf8Length(point);
        const wireCost = escapedCharBytes(point, charBytes);

        // The allowance check is against the ESCAPED cost. A newline counts too: it
        // is content, and it costs two bytes once escaped.
        if (state.wireBytes + wireCost > state.budget) {
            return stopAt(state, state.lineNumber, state.lineOffset, true);
        }

        state.content += units === 1 ? text[index] : text.slice(index, index + 2);
        state.contentBytes += charBytes;
        state.wireBytes += wireCost;
        state.lineOffset += charBytes;
        state.scanOffset += charBytes;
        // `endLine` advances with every emitted character, so a partial giant line
        // reports the line it was cut inside.
        state.endLine = state.lineNumber;

        if (point === NEWLINE_CODE) {
            state.emittedLines += 1;
            state.lineNumber += 1;
            state.lineOffset = 0;
            if (state.emittedLines >= state.maxLines) state.limitReached = true;
        }

        index += units;
    }

    return false;
};

// Char code of "\n". Compared as a NUMBER so the scans below allocate nothing per
// byte, and used by `Buffer.indexOf` for the newline count.
const NEWLINE_CODE = 0x0a;
const NEWLINE_BYTE = Buffer.from([NEWLINE_CODE]);

// True for a character that costs exactly one raw byte, one WIRE byte and one UTF-16
// unit: single-byte ASCII that `JSON.stringify` leaves alone. A run of these can be
// sliced in bulk, because none of them is a newline (0x0a is a control character) and
// none of them is escaped, so the run's raw cost, wire cost and length are the same
// number. That is the whole fast path of the scanner.
const isPlainCode = (code: number): boolean =>
    code >= 0x20 && code !== 0x22 && code !== 0x5c && code < 0x80;

// Read one byte at `offset` and, if it is a UTF-8 continuation byte (`0b10xxxxxx`),
// advance until a lead byte or EOF. A caller that hands back a hand-computed or
// byte-oriented `startByte` can land inside a multi-byte character; decoding from
// there would see a lone continuation byte, call the file binary, and report EBINARY
// for ordinary UTF-8 (D1). Advancing is the honest reading of "start here": the next
// WHOLE character is the first thing the caller can actually see.
const alignToCodePoint = async (handle: FileHandle, offset: number, sizeBytes: number): Promise<number> => {
    if (offset === 0) return 0;

    const want = Math.min(4, sizeBytes - offset);
    if (want <= 0) return sizeBytes;

    const probe = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(probe, 0, want, offset);
    if (bytesRead === 0) return sizeBytes;

    let at = offset;
    while (at < offset + bytesRead && (probe[at - offset]! & 0xc0) === 0x80) at += 1;

    return at;
};

// How many newlines lie in the byte range [from, to). A raw-byte `indexOf` scan: no
// decode, no allocation per character, and exactly equivalent because 0x0a cannot
// appear inside a multi-byte UTF-8 sequence.
const countNewlines = async (handle: FileHandle, from: number, to: number): Promise<number> => {
    if (to <= from) return 0;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let count = 0;
    let cursor = from;

    while (cursor < to) {
        // `want` never crosses `to`, so every byte this read returns is in range.
        const want = Math.min(buffer.length, to - cursor);
        const { bytesRead } = await handle.read(buffer, 0, want, cursor);
        if (bytesRead === 0) break;

        cursor += bytesRead;

        // Scan ONLY the bytes this read filled. The buffer is reused across iterations
        // and `allocUnsafe`, so everything past `bytesRead` is STALE — and
        // `Buffer.indexOf` has no end parameter, so scanning `buffer` itself would
        // count newlines left over from an earlier, larger chunk. Measured on a 20,000-
        // line file: the last 8,928-byte read of a 140,000-byte range counted 1,826
        // phantom newlines from the stale tail and reported line 6378 for a byte that
        // is really on line 4552. `subarray` is a view, so this costs no copy.
        const chunk = buffer.subarray(0, bytesRead);
        let at = chunk.indexOf(NEWLINE_BYTE);
        while (at !== -1) {
            count += 1;
            at = chunk.indexOf(NEWLINE_BYTE, at + 1);
        }
    }

    return count;
};

// The ABSOLUTE offset of the first newline in [from, to), or -1. Same raw-byte scan
// as `countNewlines`, used by the `startColumn` skip so it stops at a line end exactly
// where the old in-loop skip did.
const firstNewline = async (handle: FileHandle, from: number, to: number): Promise<number> => {
    if (to <= from) return -1;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let cursor = from;

    while (cursor < to) {
        const want = Math.min(buffer.length, to - cursor);
        const { bytesRead } = await handle.read(buffer, 0, want, cursor);
        if (bytesRead === 0) break;

        // Same stale-tail rule as `countNewlines`: bound the scan to what was read.
        const at = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE);
        if (at !== -1) return cursor + at;

        cursor += bytesRead;
    }

    return -1;
};

// Where a scan begins: the byte offset to decode from, the line that offset belongs
// to, and the aligned offset when a supplied `startByte` had to be moved.
type SeekStart = {
    offset: number;
    line: number;
    aligned: number | null;
};

// Resolve `startByte` into a place to start DECODING. Nothing here counts characters:
// a seek is a byte read plus, at worst, one raw newline count.
const resolveSeek = async (
    handle: FileHandle,
    request: NormalizedTarget,
    sizeBytes: number
): Promise<SeekStart | 'ERANGE'> => {
    const given = request.startByte;
    if (given === null) return { offset: 0, line: 1, aligned: null };

    // D10: a seek at or past EOF is answered as an ERANGE entry. That is normally
    // settled in phase 1 from the stat, so this is the defensive path; the case that
    // genuinely cannot be known that early is below, where ALIGNMENT walks off the end.
    if (given >= sizeBytes) return 'ERANGE';

    const aligned = await alignToCodePoint(handle, given, sizeBytes);

    // The offset was inside the file but pointed at a continuation byte, and walking
    // forward to the next whole character ran past the end: the last character of the
    // file started before this offset, so there is nothing readable from here. That is
    // an empty window, NOT "offset out of range" — the offset was in range — and not an
    // error at all, because a caller paging through the file has reached its end.
    if (aligned >= sizeBytes) {
        return { offset: sizeBytes, line: 1 + (await countNewlines(handle, 0, sizeBytes)), aligned: aligned === given ? null : aligned };
    }

    // The line at the seek point is the caller's word when it named one — threading
    // `nextByte` and `nextLine` back together is then free, with no count at all —
    // and otherwise the truth, counted on raw bytes rather than defaulted to 1 (D2).
    const line = request.startLineGiven
        ? request.startLine
        : 1 + (await countNewlines(handle, 0, aligned));

    return { offset: aligned, line, aligned: aligned === given ? null : aligned };
};

// Advance past the requested prefix WITHOUT decoding it: `linesToSkip` newlines, then
// `columnToSkip` bytes rounded up to a code-point boundary. Returns the offset the
// window starts at and the line that offset belongs to.
//
// This is the D3 fix. The skip used to live inside the character loop, so reaching
// line 199,000 decoded and iterated 199,000 lines' worth of CHARACTERS purely to count
// newlines — 482 ms against 1.6 ms for the same window at line 1, and 0.7 ms for a
// `startByte` seek. Counting 0x0a with `indexOf` does the same job at seek speed.
type WindowStart = { offset: number; line: number };

const skipToWindow = async (
    handle: FileHandle,
    sizeBytes: number,
    start: WindowStart,
    linesToSkip: number,
    columnToSkip: number
): Promise<WindowStart> => {
    let cursor = start.offset;
    let line = start.line;
    let needed = linesToSkip;

    if (needed > 0) {
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let landed = false;

        while (!landed && cursor < sizeBytes) {
            const want = Math.min(buffer.length, sizeBytes - cursor);
            const { bytesRead } = await handle.read(buffer, 0, want, cursor);
            if (bytesRead === 0) break;

            // Bound to the bytes actually read: the buffer is reused, so its tail holds
            // newlines from a previous chunk (see `countNewlines`). Without this a deep
            // `startLine` can stop at the WRONG offset, because a phantom newline makes
            // `needed` reach zero too early.
            const chunk = buffer.subarray(0, bytesRead);
            let at = chunk.indexOf(NEWLINE_BYTE);
            while (at !== -1) {
                needed -= 1;
                line += 1;
                if (needed === 0) {
                    cursor = cursor + at + 1;
                    landed = true;
                    break;
                }
                at = chunk.indexOf(NEWLINE_BYTE, at + 1);
            }

            // The chunk held fewer newlines than still needed: it is skipped whole.
            if (!landed) cursor += bytesRead;
        }

        // Fewer newlines exist than were asked for: the window starts at EOF and is
        // empty, which is the documented answer for a `startLine` past the end.
        if (!landed) cursor = sizeBytes;
    }

    if (columnToSkip > 0 && cursor < sizeBytes) {
        const want = Math.min(cursor + columnToSkip, sizeBytes);
        const newlineAt = await firstNewline(handle, cursor, want);

        if (newlineAt !== -1) {
            // The requested column runs past the end of the first requested line. The
            // old in-loop skip consumed that newline and then stopped, so the window
            // begins on the FOLLOWING line — reproduced exactly rather than improved
            // on, because `startColumn` past a line end is a caller error and the old
            // answer is the one already pinned by tests.
            cursor = newlineAt + 1;
            line += 1;
        } else {
            // Rounding up to a code-point boundary cannot cross a newline: 0x0a is a
            // single-byte character, never a continuation byte, so `line` is unchanged.
            cursor = await alignToCodePoint(handle, want, sizeBytes);
        }
    }

    return { offset: cursor, line };
};

// The outcome of one scan of one file: the entry, whether a larger allowance would
// have helped, and the progress a surplus pass resumes from (D4).
type ScanOutcome = {
    entry: FileReadEntry;
    cutByBudget: boolean;
    progress: ScanProgress | null;
};

// Stream one file, retaining only the requested window.
//
// `seek` is where decoding may begin and what line that offset belongs to; `progress`
// is the window an earlier allocation pass already produced, or null on the first
// pass. With `startByte` the read is O(window); without it, line numbers force a raw
// newline count from byte 0 — cheap, but not free.
const scanFile = async (
    handle: FileHandle,
    request: NormalizedTarget,
    allowance: number,
    sizeBytes: number,
    seek: SeekStart,
    progress: ScanProgress | null
): Promise<ScanOutcome> => {
    const resuming = progress !== null;

    // A seek says WHERE to read, so it never skips lines: `startLine` beside a
    // `startByte` is a reporting field, exactly as the contract describes it. Without
    // a seek, `startLine` selects the position and must be walked to.
    const linesToSkip = resuming || request.startByte !== null ? 0 : request.startLine - seek.line;
    const columnToSkip = resuming ? 0 : request.startColumn;

    const windowStart = resuming
        ? { offset: seek.offset, line: seek.line }
        : await skipToWindow(handle, sizeBytes, seek, linesToSkip, columnToSkip);

    // What the entry REPORTS as the first line: the caller's `startLine` when it named
    // one or when there was no seek at all, otherwise the line actually counted at the
    // seek offset (D2).
    const reportedStartLine = resuming
        ? progress.reportedStartLine
        : request.startByte === null || request.startLineGiven
          ? request.startLine
          : windowStart.line;

    const state: ScanState = {
        target: request.path,
        scanOffset: windowStart.offset,
        startLine: reportedStartLine,
        maxLines: request.maxLines,
        budget: allowance,
        lineNumber: windowStart.line,
        lineOffset: resuming ? progress.lineOffset : 0,
        content: resuming ? progress.content : '',
        contentBytes: resuming ? progress.contentBytes : 0,
        wireBytes: resuming ? progress.wireBytes : 0,
        endLine: resuming ? progress.endLine : reportedStartLine - 1,
        emittedLines: resuming ? progress.emittedLines : 0,
        truncated: false,
        limit: null,
        nextLine: null,
        nextColumn: null,
        nextByte: null,
        limitReached: resuming ? progress.limitReached : false,
        stopped: false,
        cutByBudget: false,
        startByteAligned: seek.aligned
    };

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let readOffset = windowStart.offset;

    while (!state.stopped) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
        if (bytesRead === 0) break;

        readOffset += bytesRead;

        let text: string;
        try {
            text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        } catch {
            throw new HarnessError(binaryMessage(request.path));
        }

        state.stopped = consumeText(state, text);
    }

    // Only flush at EOF: flushing after an early stop would reject a trailing
    // partial code point in bytes we deliberately never needed to read.
    if (!state.stopped) {
        let tail: string;
        try {
            tail = decoder.decode();
        } catch {
            throw new HarnessError(binaryMessage(request.path));
        }

        if (tail.length > 0) state.stopped = consumeText(state, tail);
    }

    // A file ending without a newline still contributes an unterminated line, but
    // there is nothing after it, so no truncation flag is added here. `endLine`
    // already tracks every emitted character.
    const entry: FileReadEntry = {
        path: resolve(request.path),
        content: state.content,
        startLine: state.startLine,
        endLine: state.endLine,
        truncated: state.truncated,
        limit: state.truncated ? state.limit : null,
        startByteAligned: state.startByteAligned,
        nextLine: state.truncated ? state.nextLine : null,
        nextColumn: state.truncated ? state.nextColumn : null,
        nextByte: state.truncated ? state.nextByte : null,
        bytes: state.contentBytes,
        sizeBytes: null
    };

    // The state a surplus pass resumes from. Only a BUDGET cut can use it: a file that
    // reached EOF or its line cap is already final, and `scanSafely` drops the progress
    // in those cases so a later pass cannot double-count.
    const resumable = state.truncated && state.cutByBudget && state.nextByte !== null;
    const next: ScanProgress | null = resumable
        ? {
              content: state.content,
              contentBytes: state.contentBytes,
              wireBytes: state.wireBytes,
              endLine: state.endLine,
              emittedLines: state.emittedLines,
              lineNumber: state.nextLine ?? state.lineNumber,
              lineOffset: state.nextColumn ?? 0,
              resumeByte: state.nextByte as number,
              reportedStartLine: state.startLine,
              limitReached: state.limitReached,
              startByteAligned: state.startByteAligned
          }
        : null;

    // `cutByBudget` is not part of the public entry: it only tells the allocator
    // whether a larger allowance would have helped, so a `maxLines` cut is never
    // offered surplus it cannot use.
    return { entry, cutByBudget: state.cutByBudget, progress: next };
};

// Resolve a slot's seek ONCE and keep it. A surplus pass would otherwise recount the
// newlines before the seek point every time it ran, which is exactly the rescanning
// D4 exists to remove; and the alignment decision must not be able to change between
// passes, or two passes of one batch would disagree about where the window starts.
const seekOf = async (slot: ScanSlot): Promise<SeekStart | 'ERANGE'> => {
    if (slot.seek !== undefined) return slot.seek;

    const { handle, request, sizeBytes } = slot;
    // handle is null only for an entry that already failed, which never scans.
    slot.seek = handle === null ? { offset: 0, line: 1, aligned: null } : await resolveSeek(handle, request, sizeBytes);
    return slot.seek;
};

// Scan one slot, translating the scanner's binary throw into a per-entry EBINARY
// result. A binary file is a FILE outcome, not a broken request, so it must not
// destroy the rest of the batch.
const scanSafely = async (slot: ScanSlot, allowance: number): Promise<FileReadEntry> => {
    const { request, handle, sizeBytes } = slot;
    if (handle === null) return failedEntry(request, 'EIO', `read failed to read "${request.path}".`, sizeBytes);

    const seek = await seekOf(slot);
    if (seek === 'ERANGE') {
        slot.cutByBudget = false;
        slot.progress = null;
        return failedEntry(request, 'ERANGE', rangeMessage(request.path, request.startByte as number, sizeBytes), sizeBytes);
    }

    // A surplus pass continues where the last one stopped (D4): the seek becomes the
    // resume offset, and the window the last pass produced is seeded into the scanner
    // so only the missing bytes are decoded.
    const progress = slot.progress;
    const start: SeekStart = progress === null
        ? seek
        : { offset: progress.resumeByte, line: progress.lineNumber, aligned: progress.startByteAligned };

    try {
        const { entry, cutByBudget, progress: next } = await scanFile(
            handle,
            request,
            allowance,
            sizeBytes,
            start,
            progress
        );
        slot.cutByBudget = cutByBudget;
        slot.progress = next;
        return { ...entry, sizeBytes };
    } catch (error) {
        if (error instanceof HarnessError) {
            slot.cutByBudget = false;
            return failedEntry(request, 'EBINARY', error.message, sizeBytes);
        }
        throw error;
    }
};

// Classify one filesystem failure into a per-entry error. Every case names the
// requested path and says what to do instead, because a model reads this and acts
// on it; a bare errno does not.
//
// A directory is NOT a permission problem and NOT a generic I/O failure, so it gets
// its own message naming the tool that can help. Windows reports EPERM for a
// directory read, which by code alone is indistinguishable from a real denial — so
// only in that case (and only after the failure) one narrow stat decides. A failed
// stat keeps the original classification, so an actual EPERM is never relabelled.
const errorCodeOf = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
};

const classifyFailure = async (
    request: NormalizedTarget,
    error: unknown
): Promise<{ code: FileReadErrorCode; message: string }> => {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCodeOf(error);

    if (code === 'ENOENT') {
        // The one outcome that is a plain lookup result rather than a failure to
        // read something that exists; kept word-for-word from the previous contract
        // so existing callers and tests see the same sentence.
        return {
            code: 'ENOENT',
            message: `read could not find "${request.path}": no such file or directory (ENOENT).`
        };
    }

    if (code === 'EISDIR') return { code: 'EISDIR', message: directoryMessage(request.path) };

    // Windows reports EPERM for a directory read. One narrow stat decides, and only
    // after the failure, so a genuine denial keeps permission wording.
    if (code === 'EPERM' && (await isDirectory(request.path))) {
        return { code: 'EISDIR', message: directoryMessage(request.path) };
    }

    if (code === 'EACCES' || code === 'EPERM') {
        return {
            code: code as FileReadErrorCode,
            message: `read was denied permission to read "${request.path}": ${message}. This is a filesystem permission problem, not a missing path or a directory read.`
        };
    }

    return {
        code: (code === undefined ? 'EIO' : code) as FileReadErrorCode,
        message: `read failed to read "${request.path}": ${message}`
    };
};

// Decide the one ambiguity Windows leaves: EPERM means either "this is a
// directory" or "you may not read it". Only called after an EPERM, and a failed
// stat answers false, so a real denial is never relabelled as a directory.
const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_READ_METADATA: PresetToolMetadata = {
    name: 'read',
    description:
        'Read a BOUNDED window of one or more UTF-8 text files. Each `paths` item is either a path string (defaults below) or { path, startLine, startColumn, startByte, maxLines }. Returns { files: [{ path, content, startLine, endLine, truncated, limit, startByteAligned, nextLine, nextColumn, nextByte, bytes, sizeBytes, error? }], truncated, bytes, wireBytes, contentBudget, skipped, note? }. Defaults: startLine 1, startColumn 0, startByte null, and NO line cap — the byte budget is the limit, so a default read returns as much as the envelope holds; an EXPLICIT maxLines is an integer in [1, 20000]. `content` is raw text whose first line is file line `startLine`, so line numbering is metadata rather than prefixes. `limit` says WHY a truncated window stopped: "maxLines" (raise maxLines to get more) or "budget" (more lines would not help; the 256 KiB envelope is full) — or null when the window reached EOF, in which case truncated is false. When an entry is truncated, pass startByte = nextByte to resume by SEEKING (no rescanned prefix) — that is how a large file should be walked; or use { startLine: nextLine, startColumn: nextColumn }, where nextColumn is 0 at a line boundary and non-zero only when a single huge line was cut mid-line. LARGE FILE: check `sizeBytes` against `bytes` and read `truncated` before assuming you have the whole file, and for a file you already know is large ask for a window ({ startLine } or { startByte }) instead of reading blindly from the top — when a file of 65536 bytes or more comes back cut, the top-level `note` names up to 2 of them — their size, what was returned, and the exact continuation — and counts the remainder as \"and N more large file(s) report truncated/nextByte\", so a big batch never spends the budget the note freed. A startByte that lands inside a multi-byte character is advanced to the next code-point boundary and reported as startByteAligned; a startByte at or past the end of the file is an ERANGE entry, not an empty window, so "offset out of range" and "file is empty" are different answers. With no startLine, the true line at a seek offset is counted and reported rather than defaulting to 1. The whole batch shares a 256 KiB budget measured on the SERIALIZED JSON (escaping included), allocated by demand: files that need less hand their surplus back to files that were cut, instead of splitting evenly by headcount. A call accepts at most 100 paths. A path that cannot be read is reported IN PLACE as its own ordered entry with empty `content`, `bytes` 0, and `error: { code, message }` - codes are ENOENT, EISDIR (a directory: use files or glob), EACCES/EPERM (a real denial), EBINARY (NUL bytes or invalid UTF-8), ERANGE (startByte at or past EOF), or EIO - and it consumes no budget, so the other files in the same call are still read in full. Only a malformed request (bad path, bad range, empty or oversized array) rejects the whole call. A window at a deep line without startByte counts newlines from the start to find it, on raw bytes and at seek speed. Binary detection is WINDOW-SCOPED, not whole-file: bytes outside the requested window are never decoded, so one file can read as text for a narrow window and as EBINARY for a wide one. Paths are absolute or relative to the working directory.',
    tags: ['files', 'read', 'filesystem'],
    // R18: everyday file access is core — always declared, never discovered.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                maxItems: 100,
                items: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description:
                                        'File to read, absolute or relative to the working directory.'
                                },
                                startLine: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '1-based first line to return. Defaults to 1.'
                                },
                                startColumn: {
                                    type: 'integer',
                                    minimum: 0,
                                    description:
                                        '0-based UTF-8 byte offset within startLine, for continuing a giant line. Defaults to 0.'
                                },
                                startByte: {
                                    type: 'integer',
                                    minimum: 0,
                                    description:
                                        'Absolute 0-based UTF-8 byte offset to seek to, skipping the line count. Feed back a previous nextByte. An offset inside a multi-byte character is advanced to the next code-point boundary and reported as startByteAligned; an offset at or past EOF is an ERANGE entry. Without an explicit startLine the true line at this offset is counted and reported. Defaults to null (count from the start).'
                                },
                                maxLines: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 20_000,
                                    description:
                                        'Maximum lines to return. OMIT for no line cap: the 256 KiB budget then decides, which is the default. When supplied it must be an integer in [1, 20000]. A window cut by this cap reports limit: "maxLines".'
                                }
                            },
                            required: ['path'],
                            additionalProperties: false
                        }
                    ]
                },
                description:
                    'Files to read, in the order the results are returned. A string reads a default window; an object selects a line/byte range.'
            }
        },
        required: ['paths'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = FILE_READ_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // T2/R2: reading is cheap and the model needs the bytes before it can act on
    // them, so a read completion does not start a turn of its own - the whole sync
    // batch of this message settles first. Same value as the `tool({ mode })`
    // declaration below; this literal is what discovery and the generated manifest
    // report.
    mode: 'sync',
    order: 170,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const read = tool<FileReadParameters, FileReadResult>({
    ...FILE_READ_METADATA,
    // T2/R2: the DECLARED turn policy, mirrored from `registration` above so the
    // standalone callable, a host-registered `tools: { read }`, and the harness's
    // descriptor-bound registration all resolve the same effective mode.
    mode: 'sync',
    execute: async ({ parameters: paths }) => {
        const requested = normalizeTargets(paths);

        // PHASE 1 — open every path and turn every unreadable one into a failed
        // entry, preserving the caller's order. Opening first is what lets PHASE 2
        // split the budget only across files that can actually be read: a missing,
        // directory, permission-denied or binary path never reserves a share it
        // cannot use. A directory is detected on the handle's stat rather than on a
        // read error, because Windows lets a directory open and fails only later.
        const slots: ScanSlot[] = [];
        const openHandles = new Set<FileHandle>();

        try {
            for (const request of requested) {
                const absolute = resolve(request.path);

                try {
                    const handle = await open(request.path, 'r');
                    openHandles.add(handle);
                    const info = await handle.stat();

                    // A directory is detected here rather than from a read error:
                    // Windows opens one successfully and fails only later, and the
                    // stat is free next to an open we already paid for.
                    if (info.isDirectory()) {
                        await closeQuietly([handle]);
                        openHandles.delete(handle);
                        const message = directoryMessage(request.path);
                        slots.push({
                            request,
                            handle: null,
                            sizeBytes: info.size,
                            overhead: entryOverhead(absolute, { code: 'EISDIR', message }),
                            entry: failedEntry(request, 'EISDIR', message, info.size),
                            cutByBudget: false,
                            progress: null
                        });
                        continue;
                    }

                    // A `startByte` at or past EOF is decided here, from the stat we
                    // already have, rather than inside the scan: an entry that will
                    // carry an error message must have that message measured into the
                    // reservation BEFORE the budget is split, exactly like ENOENT and
                    // EISDIR, or it would take a content share it cannot use and then
                    // spend wire bytes on the error instead.
                    if (request.startByte !== null && request.startByte >= info.size) {
                        await closeQuietly([handle]);
                        openHandles.delete(handle);
                        const message = rangeMessage(request.path, request.startByte, info.size);
                        slots.push({
                            request,
                            handle: null,
                            sizeBytes: info.size,
                            overhead: entryOverhead(absolute, { code: 'ERANGE', message }),
                            entry: failedEntry(request, 'ERANGE', message, info.size),
                            cutByBudget: false,
                            progress: null
                        });
                        continue;
                    }

                    slots.push({
                        request,
                        handle,
                        sizeBytes: info.size,
                        overhead: entryOverhead(absolute),
                        entry: null,
                        cutByBudget: false,
                        progress: null
                    });
                } catch (error) {
                    const { code, message } = await classifyFailure(request, error);
                    slots.push({
                        request,
                        handle: null,
                        sizeBytes: 0,
                        overhead: entryOverhead(absolute, { code, message }),
                        entry: failedEntry(request, code, message),
                        cutByBudget: false,
                        progress: null
                    });
                }
            }
        } catch (error) {
            // Do not leak handles opened before the failing target.
            await closeQuietly(openHandles);
            throw error;
        }

        // PHASE 2 — water-fill the budget across the readable files.
        //
        // Reserve the scaffolding of EVERY entry first, including the failed ones: an
        // error message is part of the response and costs wire bytes too. What is
        // left is content.
        //
        // `noteReserve(slots)` is added to the same reserve (R4): the advisory is only
        // writable after the scan, but it is part of the response too, so a budget
        // spent without pricing it is a budget that overshoots `contentBudget` exactly
        // when the note fires — the one case the wire-cap test covers.
        let reserved = RESULT_SHELL.length + noteReserve(slots);
        for (const slot of slots) reserved += slot.overhead;

        const contentBudget = Math.max(0, FILE_READ_WIRE_BUDGET - reserved);
        const readable = slots.filter((slot) => slot.entry === null);

        try {
            let pending = readable;
            let allowance = pending.length > 0 ? Math.floor(contentBudget / pending.length) : 0;

            for (let pass = 0; pass < ALLOCATION_PASSES && pending.length > 0 && allowance > 0; pass += 1) {
                // A cut file is scanned AGAIN on the next pass with a larger allowance,
                // so the handle stays open until the allocation is final. It is not
                // re-read from byte 0: `scanSafely` resumes from the previous pass's
                // exact cut point (see ScanProgress / D4), and closing the handle here
                // would force a re-open per pass.
                for (const slot of pending) {
                    slot.entry = await scanSafely(slot, allowance);
                }

                // Who was satisfied, and how much of their share did they leave?
                let surplus = 0;
                const cut: ScanSlot[] = [];

                for (const slot of pending) {
                    const entry = slot.entry;
                    if (entry === null) continue;

                    // Only a BUDGET cut is worth re-scanning. A file cut by `maxLines`
                    // returned everything the caller asked for, so counting its
                    // unused share as surplus would let it be re-offered (and
                    // re-cut) on every pass without ever freeing anything.
                    if (slot.cutByBudget) cut.push(slot);
                    else surplus += Math.max(0, allowance - contentWireBytes(entry.content));
                }

                // Everything fits, or there is nothing to give. Either way the
                // allocation is final.
                if (cut.length === 0 || surplus === 0) break;

                // Offer the surplus to the files that were cut. This is exactly
                // (remaining budget) / (cut files): the satisfied files took u_i of
                // an equal share A, so what is left is surplus + cut.length * A.
                // The new allowance is therefore never smaller than the old one, a
                // satisfied file cannot regress, and `pending` strictly shrinks
                // whenever the allowance grows — which is what makes the loop end.
                allowance += Math.floor(surplus / cut.length);
                pending = cut;
            }
        } finally {
            // Whatever is still open closes here: a file that never entered a pass
            // (allowance 0) or a throw part-way through.
            await closeQuietly(openHandles);
            openHandles.clear();
        }

        const files = slots.map(
            (slot) => slot.entry ?? failedEntry(slot.request, 'EIO', `read failed to read "${slot.request.path}".`)
        );

        const bytes = files.reduce((total, entry) => total + entry.bytes, 0);
        const truncated = files.some((entry) => entry.truncated);
        const skipped = files.filter((entry) => entry.error !== undefined).length;

        // The advisory, decided from the FINAL entries (see `buildReadNote`). Each entry
        // is paired with the line cap its OWN request applied, because the note must not
        // advise "raise maxLines" to a caller already at FILE_READ_MAX_LINES (F3); the
        // pairing is by index and `files` is built from `slots` in the same order. Its
        // worst-case cost was already taken out of the content budget by `noteReserve`,
        // so adding it here cannot push `wireBytes` past `contentBudget`.
        const note = buildReadNote(
            slots.map((slot, index) => ({ entry: files[index], maxLines: slot.request.maxLines }))
        );

        // Measure the real serialized length rather than trusting the reserve: this
        // is the exact number the harness compares against its own cap, so a caller
        // can rely on `wireBytes <= contentBudget`.
        //
        // Iterate to a fixed point, because `wireBytes` is itself part of what is
        // measured: reporting a length that assumed a 1-byte placeholder would
        // understate the real response by the digits of the number itself. The
        // measurement is monotone in the inserted value and the value's digit count
        // stabilises after one refinement, so the loop settles immediately; the cap
        // just guarantees termination for any input.
        //
        // `note` leads the object — the same reasoning grep gives for putting `note`
        // before `matches`: if the harness ever does cut a serialized result, it keeps
        // the BEGINNING, and the advisory is the part a caller needs in order to read
        // the rest of the response correctly.
        const shape = (wire: number) =>
            Buffer.byteLength(
                JSON.stringify({
                    ...(note === undefined ? {} : { note }),
                    files,
                    truncated,
                    bytes,
                    wireBytes: wire,
                    contentBudget: FILE_READ_WIRE_BUDGET,
                    skipped
                }),
                'utf8'
            );

        // `shape(w) = base + digits(w)` is non-decreasing in `w`, so this climbs to a
        // fixed point (or, at a digit boundary, a 2-cycle). Keeping the LARGEST value
        // seen makes the result an upper bound on the real serialized length, which is
        // the safe direction: `wireBytes <= contentBudget` then genuinely implies the
        // harness envelope will not truncate.
        let wireBytes = shape(0);
        for (let i = 0; i < 8; i += 1) {
            const next = shape(wireBytes);
            if (next <= wireBytes) break;
            wireBytes = next;
        }

        return {
            ...(note === undefined ? {} : { note }),
            files,
            truncated,
            bytes,
            wireBytes,
            contentBudget: FILE_READ_WIRE_BUDGET,
            skipped
        };
    }
});
