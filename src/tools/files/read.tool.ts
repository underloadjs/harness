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
//     (default 2000 lines, an EXPLICIT value capped at 20000 — see "THE DEFAULT IS
//     A CONTEXT BUDGET, NOT A MEMORY BUDGET" below);
//   - a per-file allowance of 64 KiB of model-facing bytes by default, raisable per
//     request with `maxBytes` up to the whole envelope (`FILE_READ_DEFAULT_MAX_BYTES`
//     / `FILE_READ_MAX_BYTES`);
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
// WHAT THE MODEL ACTUALLY RECEIVES (`modelBytes`, and the `toolText` projection)
// ------------------------------------------------------------------------------
// The result object above is the MACHINE view: the server's manual-execute response
// and a UI render `files[]` field by field. The MODEL view is a prose rendering of
// the same facts, declared by this tool through `toolText(content, text)` (see
// ../../core/tool-text.ts) and peeled by the harness at the one place a result is
// committed:
//
//     /abs/path/file.ts  lines 1-2000 of 12323  size 634705 bytes  returned 61438 bytes
//     [truncated by maxBytes — continue with startByte 61438]
//     <raw text>
//
// WHY BOTHER: serializing `files[].content` costs the CALLER'S CONTEXT WINDOW the
// escaping tax measured above (+2.1% on this package's own source, +15.2% on
// quote-heavy code) PLUS the ~200 bytes of fixed JSON scaffolding every entry
// reserves, all of it competing with the file text for the same budget. Prose pays
// neither. The budget is still charged on the ESCAPED form (the conservative
// measure), so `modelBytes <= wireBytes <= contentBudget` holds by construction and
// the projection can never be cut by the harness envelope — pinned by a test, on
// adversarial paths, for every cut reason this tool can report.
//
// `numbered: true` on a request puts an opencode-style `123: ` gutter on the text
// the model reads, so it can cite line numbers without arithmetic from `startLine`.
// It costs ~8 bytes per line, so it is opt-in; `content` stays raw either way, and
// the gutter is charged against the same per-file allowance as the text itself, so
// numbering can never push a response over its envelope.
//
// THE DEFAULT IS A CONTEXT BUDGET, NOT A MEMORY BUDGET (D11)
// ----------------------------------------------------------
// D6 removed the default line cap and let "the envelope decide". Measured on this
// package's own `harness.ts` (634,705 bytes, 12,323 lines), a DEFAULT read of it
// returned 261,129 bytes of file text — roughly 64k tokens at 4 bytes/token and
// ~78k at the ~3.35 bytes/token typical of TypeScript source. One call therefore
// took a third to two thirds of a 128k context, and two of them exceeded the
// harness's own 512 KiB per-turn aggregate (`MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES`,
// ≈ 128k tokens). Nothing in the transcript said the read had been cut: the model
// had to notice four numbers and act on them, which is the same failure R4 wrote
// the `note` for — except the note can only advise, it cannot give the token budget
// back.
//
// D6's argument was about MEMORY ("a 256 KiB window cannot exceed 256 KiB however
// many lines it holds"). That is still true, and it is still why the CEILING is
// 256 KiB. It was never an argument about CONTEXT, and the section's own closing
// note conceded it: "a careless default read costs more tokens per call". A
// careless default read was the common case, because the description invited it
// ("a default read returns as much as the envelope holds").
//
// So the two governors are now separated:
//   - DEFAULT: 2,000 lines and 64 KiB per file — the order of magnitude a file tool
//     should hand a model unprompted (a mainstream agent tool of the same shape uses
//     2,000 lines / 50 KiB for exactly this reason);
//   - CEILING: 20,000 lines and 262,144 bytes, one explicit `maxLines` / `maxBytes`
//     away, unchanged from D6 and still enforced per request;
//   - `limit` says which of the three governors stopped a window (`maxLines`,
//     `maxBytes`, `budget`), and `nextByte` makes the next call a SEEK, so paging a
//     large file costs one cheap call per window instead of one round trip per
//     surprise.
//
// WHY THE CONTEXT GOVERNOR IS A CONSTANT, NOT A READING OF HEADROOM
// ----------------------------------------------------------------
// The default could instead shrink as the transcript grows, from
// ../../core/context-estimate.ts. It deliberately does not: the same call would
// then return a different amount of file text depending on how much history the
// session happened to carry, so an agent could not reason about its own reads, and
// a tool that guesses at remaining context can be wrong in the expensive direction.
// Context pressure is a separate concern with its own instruments (compaction, the
// per-turn result ledger); `read` just never volunteers more than a fixed window.
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
//                  nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?,
//                  startByteAligned, error? }],
//       truncated: boolean,          // any file truncated
//       bytes: number,               // total RAW content bytes returned
//       wireBytes: number,           // serialized bytes the budget is charged on
//       contentBudget: number,       // the wire budget this call was subject to
//       modelBytes: number,          // bytes of TEXT the model actually receives
//       skipped: number,             // entries that reported an error, not content
//       note?: string                // advisory for a truncated LARGE file
//     }
//
// `lineCount` is PRESENT EXACTLY when this call counted every line of the file — a
// window that reached EOF, or a `startLine` past the end whose prefix scan covered
// the whole file — and absent otherwise. Charging every read for a whole-file
// newline count would violate the cost contract below (the same reason binary
// detection is window-scoped), so the tool reports the count when it is free and
// says nothing when it is not.
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
// A clause never advises "raise maxLines"/"raise maxBytes" to a caller already at the
// matching ceiling (FILE_READ_MAX_LINES / FILE_READ_MAX_BYTES), because following that
// advice with ceiling+1 is rejected as an invalid request; at the ceiling the note
// names the ceiling and gives the continuation instead (F3).
//
// WHY `limit` EXISTS (D5)
// -----------------------
// `truncated: true` used to be the whole story, and it is not actionable on its own:
// a window cut by `maxLines` and a window cut by the byte budget have IDENTICAL
// shapes, but the right response is the opposite in each case — raise `maxLines` for
// one, accept less for the other. An agent that cannot tell them apart guesses and
// spends a round trip finding out. `limit` names the reason, and since D11 there are
// THREE governors to tell apart:
//   - "maxLines" — the request's line cap (the 2000 default or an explicit
//     `maxLines`) stopped the window: raise `maxLines`, the bytes are not the problem;
//   - "maxBytes" — the request's own byte allowance (the 64 KiB default or an
//     explicit `maxBytes`) stopped it: raise `maxBytes`, up to the ceiling;
//   - "budget" — the batch's shared 256 KiB envelope ran out, so this file got a
//     SMALLER share than its own allowance: raising `maxBytes` alone does nothing,
//     the other paths in the call have to want less (or be read in their own call);
//   - null — the window reached EOF, so `truncated` is false.
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
// denial, BINARY CONTENT, and a `startByte` OR `startLine` at or past the end of the
// file (ERANGE). Directory, permission and binary reads previously rejected the whole
// batch and destroyed the content of every other file in it. A failed entry consumes
// no content budget, so the readable files in the same call keep their full share.
//
// WHY A SEEK PAST EOF IS AN ERROR AND NOT AN EMPTY WINDOW (D10, D11-line)
// -----------------------------------------------------------------------
// `startByte: 9999` on a 6-byte file used to return `content: "", bytes: 0,
// truncated: false` — indistinguishable from "this file is empty". A caller threading
// a stale `nextByte` through a loop therefore read "the file is empty" where the truth
// is "your offset is out of range", and the loop terminated on a false premise. The
// entry now carries `error: { code: "ERANGE" }` naming the file size, so the two
// outcomes are different answers. A `startByte` exactly at EOF is the same case: there
// is no byte there to read.
//
// D10 was applied to the BYTE axis only, and the LINE axis kept the bug:
// `startLine: 5000` on a 1300-line file still answered with an empty, untruncated
// window, so the same stale-offset loop read "nothing here" for "off the end". It is
// now ERANGE too, and because reaching that answer means the newline scan already
// walked the whole file, the message can name the file's line COUNT for free — the
// number opencode's out-of-range error exists to give. The asymmetry that remains is
// deliberate: an EMPTY file (0 bytes) has no lines to be past, so any `startLine`
// answers with the empty window it always has, and `lineCount: 0` says so.
//
// Only a malformed REQUEST still rejects the whole call, before any disk access: a
// non-array argument, an empty array, too many paths, a blank/NUL/non-string path,
// or an invalid range value. Those are caller bugs rather than file outcomes, and
// answering them per-entry would let a broken request look like a successful read.
//
// WHY AN UNREADABLE PATH NAMES A SUGGESTION, NOT JUST AN ERRNO
// ------------------------------------------------------------
// ENOENT and EISDIR are the two outcomes an agent hits most and recovers from
// cheapest, and a bare errno sentence wastes the round trip: "no such file" does not
// tell the model that `packages/x/index.ts` exists, or that the directory it asked
// for has 40 entries it could have picked from. So the ENOENT entry lists up to 3
// did-you-mean candidates from the parent folder (case-insensitive substring, ranked
// by name length, then by canonical spelling — NFKC, no-break space and curly quotes
// folded, which is how a filename copied out of a document differs from the one on
// disk), and when the PARENT folder itself is missing it names the nearest existing
// ancestor instead. EISDIR previews the directory's first entries rather than
// shrugging. All of it happens only on the failure path, is bounded (a fixed number
// of names, a bounded ancestor walk), and a directory it cannot list simply yields
// no suggestions.
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
// WHY `lossy: true` EXISTS
// ------------------------
// Strict decoding is the default because replacing invalid bytes with U+FFFD silently
// changes the file. But it also made a Latin-1 log, a cp1252 CSV, or a file with one
// bad byte in a 5 MB export COMPLETELY unreadable — the tool knew the bytes were text
// and refused to show any of them. `lossy: true` opts into substituting U+FFFD, and
// the entry then carries `lossy: true` (absent otherwise) so the substitution is
// reported rather than implied. A NUL byte is STILL EBINARY in lossy mode: it is the
// strong "this is not text" signal, and a lossy read of a real binary is mojibake the
// model pays tokens to ignore.
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
//     await read([{ path: 'bundle.js', maxBytes: FILE_READ_MAX_BYTES }]);
//
// A DIRECT caller gets the machine view (`files[]`, `nextByte`, …); a harness puts
// the prose projection in front of the model. The two are the same facts — see
// "WHAT THE MODEL ACTUALLY RECEIVES" above.
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tool, toolText } from '../../core';
import { HarnessError } from '../../util';
import type { ToolTextEnvelope } from '../../types';
import type { PresetToolMetadata } from '../catalogue';

// Default and hard limits. These are exported so docs/tests can quote the same
// numbers the implementation enforces (and so a host cannot quietly disagree).
//
// WHY THE DEFAULTS ARE 2000 LINES / 64 KiB — SEE "THE DEFAULT IS A CONTEXT BUDGET,
// NOT A MEMORY BUDGET (D11)" ABOVE, which retires the D6 reasoning for the DEFAULT
// while keeping it for the CEILING. D6 (kept here as history) removed the default
// line cap on the grounds that a 256 KiB window cannot exceed 256 KiB however many
// lines it holds, so "a line cap below the budget buys no safety, only latency".
// True about memory; silent about the caller's context window, which is the budget
// the tool description claims to protect. The measured cost of that silence — one
// default read of `harness.ts` at ~64k-78k tokens — is what D11 reverted.
//
// The CEILING numbers are D6's, unchanged: an explicit request can still take 20,000
// lines or the whole 256 KiB envelope, and `limit` says which governor stopped the
// window when it did.
export const FILE_READ_DEFAULT_MAX_LINES = 2_000;
export const FILE_READ_MAX_LINES = 20_000;

// The per-file byte allowance, in the same units the budget is charged in (escaped
// wire bytes, so the number a caller compares against `bytes`/`wireBytes`).
//
// 64 KiB is ~16k tokens of prose: enough for almost any real function, config or
// document a model is reading in order to ACT on the next line, and small enough
// that one default read cannot dominate a context window on its own. It is also the
// size every OTHER file tool in this package caps a whole response at
// (`FILE_GLOB_CONTENT_BUDGET`, `FILE_GREP_CONTENT_BUDGET`, and the old
// `MODEL_TOOL_RESULT_BUDGET_BYTES`), so the number a caller has to remember is one
// number across the package.
//
// `FILE_READ_MAX_BYTES` is the ceiling for one explicit `maxBytes`: the whole batch
// envelope. Above it the request is rejected rather than clamped, like every other
// range field here — a silent clamp is how `limit` stops being trustworthy.
export const FILE_READ_DEFAULT_MAX_BYTES = 64 * 1024;
export const FILE_READ_MAX_BYTES = 256 * 1024;

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

// The budget above is the WHOLE call; FILE_READ_DEFAULT_MAX_BYTES is one file's
// share of it by default. Both are ceilings; neither is a target. A batch of four
// 200 KiB files still splits the 256 KiB envelope evenly (each gets a share SMALLER
// than its own allowance, which is what `limit: "budget"` reports), and one file
// beside 99 tiny ones still gets its surplus (it is still capped at its own
// allowance, which is what `limit: "maxBytes"` reports).

// Failure-path bounds. Suggestions and directory previews cost a readdir, so they
// are bounded and only ever happen on an entry that already failed.
export const FILE_READ_SUGGESTION_MAX = 3;
export const FILE_READ_PREVIEW_MAX = 12;
// A folder is a LOOKUP surface, not a search surface: past a few hundred names the
// substring scan cannot plausibly beat the caller's own grep, and the entry already
// has a correct errno. This is how many names the scan inspects at most.
export const FILE_READ_SUGGESTION_SCAN = 200;
// A candidate name longer than this is not scored at all (see `suggestNames`): the
// distance matrix is quadratic in the name length, and the point of that scan is that
// it stays cheaper than the readdir which produced the names.
const SUGGESTION_NAME_MAX_CODE_POINTS = 120;
// How many levels up a missing path walks looking for a folder that exists. Bounded so
// a pathological path cannot make one failed read expensive, and because past a dozen
// levels the honest answer is already "nothing along that path exists".
const MISSING_ANCESTOR_WALK = 12;

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
          // Maximum lines to return. DEFAULT: 2000. An EXPLICIT value is an integer
          // in [1, 20000]. Whichever of `maxLines` / `maxBytes` binds first is the
          // one `limit` reports.
          maxLines?: number;
          // Bytes this file may take, in the same units `bytes`/`wireBytes` are
          // measured in. DEFAULT: 64 KiB (`FILE_READ_DEFAULT_MAX_BYTES`); an EXPLICIT
          // value is an integer in [1, 262144] (`FILE_READ_MAX_BYTES`, the whole batch
          // envelope). Ask for this when a 64 KiB window is genuinely not enough —
          // it is the only knob that raises a single file's window.
          maxBytes?: number;
          // Substitute U+FFFD for bytes that are not valid UTF-8 instead of reporting
          // EBINARY, so a Latin-1 log stays readable. The entry then carries
          // `lossy: true`. A NUL byte is still EBINARY either way. Default false.
          lossy?: boolean;
          // Put an opencode-style `123: ` gutter on the TEXT THE MODEL READS, so it
          // can cite line numbers without arithmetic. `content` stays raw, and the
          // gutter is charged against this file's allowance. Default false.
          numbered?: boolean;
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
    // "maxLines" when this request's line cap (the 2000 default or an explicit
    // maxLines) stopped it — raise `maxLines`, the bytes are not the problem;
    // "maxBytes" when this request's own byte allowance (the 64 KiB default or an
    // explicit maxBytes) stopped it — raise `maxBytes`, up to 262144; "budget" when
    // the batch's shared 256 KiB envelope gave this file a smaller share than its
    // allowance — raising `maxBytes` alone does nothing, the batch has to want less;
    // and null when the window reached EOF. Never non-null while `truncated` is false.
    limit: 'maxLines' | 'maxBytes' | 'budget' | null;
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
    // Total LINES in the file — present EXACTLY when this call counted them for free
    // (the window reached EOF, or a `startLine` past the end scanned the whole file
    // anyway) and absent when knowing them would have cost a second whole-file scan.
    // An empty file reports 0, which is how "past the end" and "nothing here" stay
    // distinguishable.
    lineCount?: number;
    // Present ONLY when `lossy: true` was requested AND this window actually contained
    // bytes that are not valid UTF-8: the U+FFFD in `content` came from substitution,
    // not from the file. Absent for a strict read, which cannot produce any.
    lossy?: true;
    // Present ONLY when this path could not be read (missing, directory, permission
    // denial, binary content, or a `startByte`/`startLine` at or past EOF). The entry
    // then carries empty content, bytes 0 and an empty-window range; the call itself
    // succeeds and the other entries are unaffected. Absent for every readable file.
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
    // Bytes of TEXT the model actually receives: the exact UTF-8 length of the prose
    // projection this result is delivered as (see "WHAT THE MODEL ACTUALLY RECEIVES"
    // above). Always <= `wireBytes`, because the budget is charged on the escaped JSON
    // form and prose never costs more than that — which is what makes the projection
    // immune to the harness's own envelope cut.
    modelBytes: number;
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
    // This file's own byte allowance (D11), already defaulted to
    // FILE_READ_DEFAULT_MAX_BYTES and bounded by FILE_READ_MAX_BYTES.
    maxBytes: number;
    // Substitute U+FFFD instead of reporting EBINARY for invalid UTF-8.
    lossy: boolean;
    // Number the model's copy of the window (charged to the same allowance).
    numbered: boolean;
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
    // What this entry's line in the MODEL PROJECTION costs before any content is read
    // (see `projectionOverhead`). Charged against the same content budget the entries
    // split, because the projection is delivered through the same envelope and the
    // harness measures that envelope once, not per consumer.
    projectionReserve: number;
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
    // Newlines that exist BEFORE this window, and whether this call actually counted
    // them (D2's explicit-`startLine` case trusts the caller instead, and then the
    // file's line count is not knowable — see `lineCount` on the entry). A resume must
    // inherit both, or a second pass would report a count the first pass never earned.
    prefixNewlines: number;
    prefixCounted: boolean;
    // A lossy pass that substituted U+FFFD stays lossy when a later pass extends it.
    sawLoss: boolean;
    // Newlines the resumed window has already emitted, so the line count continues
    // from the first pass instead of re-counting from `startLine`.
    windowNewlines: number;
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

// The fixed cost of the result object around the array: `files`, the summary fields,
// and their separators. Measured, not guessed — and it must carry EVERY field the
// result publishes (that is why `modelBytes` is here), because this constant is what
// the budget is reserved against while `shape()` below is what it is charged on.
const RESULT_SHELL = JSON.stringify({
    files: [],
    truncated: false,
    bytes: 0,
    wireBytes: 0,
    contentBudget: 0,
    modelBytes: 0,
    skipped: 0
});

// ---------------------------------------------------------------------------
// THE MODEL PROJECTION — rationale in the header section "WHAT THE MODEL
// ACTUALLY RECEIVES". The machine view (`files[]`) and the model view (prose) are
// the same facts in two renderings; the harness picks one per consumer through the
// `toolText()` brand (see ../../core/tool-text.ts).
//
// A chunk carries a STRING and its byte length together, because `Buffer.byteLength`
// is additive over concatenation: summing the lengths measures the whole projection
// without building it, which is what lets the `wireBytes` fixed-point loop below run
// its (cheap) refinements without re-rendering megabytes of text.
// ---------------------------------------------------------------------------

type ProjectionChunk = { text: string; bytes: number };

// The one line a truncated entry gets after its text. A cut window is the outcome a
// reader can act on, and the model does not see `nextByte` in prose unless told, so the
// continuation IS the point of this line. The reason (`limit`) rides along on purpose:
// it is the difference between "raise maxLines" and "want fewer bytes across the batch",
// and a footer that only said "continue at 12345" would teach the model that paging is
// always the answer. `startLine`/`startColumn` are spelled out as well, because a caller
// that has not learned to seek can still continue correctly with them.
const projectionFooter = (entry: FileReadEntry): string => {
    const column = entry.nextColumn === null || entry.nextColumn === 0 ? '' : `+${entry.nextColumn} column`;

    if (entry.nextByte === null) {
        return `  [truncated by ${entry.limit ?? 'budget'}; ${entry.bytes} bytes returned; continue from startLine ${entry.nextLine ?? entry.endLine}${column}]`;
    }

    return `  [truncated by ${entry.limit ?? 'budget'}; ${entry.bytes} bytes returned; continue from startByte ${entry.nextByte}${column}]`;
};

// The header line. The `lines …` clause is dropped exactly when it would mislead: an
// empty window (no lines to name) or a cut that landed INSIDE a line, where
// `endLine` is the line the window started on and "1-1" would read as "this is all of
// line 1" when the line goes on for another 100 KB.
//
// `entry.nextColumn` alone cannot make that decision: it is `null` on a window that
// reached EOF, and `null !== 0` would silently drop the clause from every complete read
// — the one case where "lines 1-3 of 3" is most worth telling the model.
const projectionHeader = (entry: FileReadEntry): string => {
    if (entry.error !== undefined) {
        return `ERROR: ${entry.error.code}: ${entry.error.message} (size ${entry.sizeBytes ?? 0} bytes)`;
    }

    const cutInsideLine = entry.truncated && entry.nextColumn !== 0;

    const range =
        entry.bytes === 0 || cutInsideLine ? '' : `  lines ${entry.startLine}-${entry.endLine} of ${entry.lineCount ?? '?'}`;
    // The total, once. The `of N` inside the range clause and a standalone `N lines`
    // are the same number, and the projection is paid for in context on every read, so
    // the standalone form appears only when the range clause was suppressed.
    const count = range === '' && entry.lineCount !== undefined ? `  ${entry.lineCount} lines` : '';
    const eof = entry.truncated ? '' : '  (reached end of file)';

    return `${entry.path}${range}${count}  size ${entry.sizeBytes ?? 0} bytes${eof}  returned ${entry.bytes} bytes`;
};

// One entry's chunks: header, text, continuation. `bytes` sums to the entry's share of
// `modelBytes`, and every byte of it is a byte that also appears in the serialized
// `files[]` entry, so `modelBytes <= wireBytes` holds by construction — the property
// that makes the projection immune to the harness's own envelope cut.
const projectionChunks = (entry: FileReadEntry, numbered: boolean): ProjectionChunk[] => {
    const chunks: ProjectionChunk[] = [];

    const add = (text: string): void => {
        if (text.length > 0) chunks.push({ text, bytes: Buffer.byteLength(text, 'utf8') });
    };

    add(`${projectionHeader(entry)}\n`);

    if (entry.error !== undefined) return chunks;

    if (entry.content.length > 0) add(numbered ? numberProjectionText(entry, entry.content) : entry.content);

    if (!entry.content.endsWith('\n') && (entry.content.length > 0 || entry.bytes > 0)) add('\n');

    if (entry.truncated) add(`${projectionFooter(entry)}\n`);

    return chunks;
};

// Number a rendered line the way a source viewer does — `<width spaces for the
// number>: `. The width follows the LARGEST line number the model sees in this
// window, not the current one, so a window spanning lines 998-1300 has a steady
// gutter instead of a ragged one that would break the alignment the feature exists
// for. The first character of the text is then file line `startLine`, which is the
// same contract `content` has, so a model citing `123:` is citing the line the entry's
// metadata calls 123.
const numberProjectionLine = (line: string, lineNumber: number, width: number): string =>
    `${String(lineNumber).padStart(width, ' ')}: ${line}`;

// The model's copy of one entry, optionally numbered (see `numbered` on the request).
// Numbering is a RENDERING choice and applies only here: `content` stays raw, so the
// machine view of a window is identical whether or not the model's copy is numbered.
const numberProjectionText = (entry: FileReadEntry, text: string): string => {
    const width = String(Math.max(entry.startLine, entry.endLine, 1)).length;
    const lines = text.split('\n');
    const last = lines.length - 1;

    return lines
        .map((line, index) =>
            // The piece after the final newline is empty (the text ended with `\n`): it
            // is a line break, not a line, so it must not grow a gutter.
            line.length === 0 && index === last ? line : numberProjectionLine(line, entry.startLine + index, width)
        )
        .join('\n');
};

// The prose the model reads, in request order. One flat array joined once: the content
// strings are already in memory, so this costs a copy of the window and nothing else.
const renderProjection = (files: readonly FileReadEntry[], numbered: boolean): string =>
    files
        .flatMap((entry) => projectionChunks(entry, numbered))
        .map((chunk) => chunk.text)
        .join('');

// What one entry's projection line costs, priced BEFORE the scan (the budget is split
// before anything is read). A failed entry's message is known, so it is measured
// exactly; a readable one's is not, so the widest header it could ever emit is used —
// the path escaped as a JSON string value, plus every digit the numbers can carry.
// Overshooting costs a few hundred content bytes out of 256 KiB; undershooting would
// let the projection the harness actually delivers exceed `contentBudget`.
// 128 dominates the widest header (`  lines A-B of C  size S bytes  (reached end of
// file)  returned N bytes`, ~96 at the widest numbers) with room for the digit growth
// `entryOverhead` gives the same fields; 176 dominates the widest footer (`  [truncated
// by <reason>; N bytes returned; continue from startByte B+C column]`, ~105). Both are
// deliberately generous: this reserve backs the text the MODEL actually receives, and an
// under-reserved projection is the one case where `modelBytes` could exceed
// `contentBudget` and the harness would cut prose the machine view still has.
const PROJECTION_HEADER_MARGIN = 128;
const PROJECTION_CONTINUATION_MARGIN = 176;

const projectionOverhead = (
    path: string,
    error?: { code: string; message: string }
): number => {
    const header = Buffer.byteLength(JSON.stringify(path), 'utf8');

    if (error === undefined) return header + PROJECTION_HEADER_MARGIN;

    const line = `ERROR: ${error.code}: ${error.message} (size 0 bytes)\n`;

    return header + Buffer.byteLength(line, 'utf8') + PROJECTION_CONTINUATION_MARGIN;
};

// ---------------------------------------------------------------------------
// THE LARGE-FILE ADVISORY (`note`) — rationale in the header section of the same
// name. Two functions share one set of clause builders: `buildReadNote` produces the
// text after the scan, `noteReserve` prices its WORST CASE before the scan, so the
// response cannot grow past the budget it measured itself against.
// ---------------------------------------------------------------------------

// Fixed text of one clause, plus the widest number every field it quotes can carry:
//   `" is ` + ` bytes; returned ` + `(limit: maxBytes at the 262144 ceiling)` +
//   ` - continue at startByte N with maxBytes N, or { startLine: N, startColumn: N }`
// The quoted path is added on top by the caller, in UTF-8 BYTES and DOUBLE-ESCAPED
// (it is text inside the note string, which is itself serialized) — see `noteReserve`.
// 216 dominates the widest clause the builders above can emit: ~130 bytes of fixed
// text (the two ceiling wordings are the longest variants, longer than "raise maxLines")
// plus up to 15 digits on each of the six numbers it quotes.
const NOTE_CLAUSE_OVERHEAD = 216;

// Everything around the clauses: the `read: ` prefix, the `; ` separators, the
// "and N more large file(s)" tail, and the serialized `"note":"..."` key itself.
const NOTE_SHELL_OVERHEAD = 128;

// The prefix that makes the advisory self-describing once it is separated from the
// entries it refers to (a model reads the note in the result envelope, out of order).
const NOTE_PREFIX = 'read: ';

// One entry plus the caps its request applied. `FileReadEntry.limit` says WHY the
// window stopped but not at what number, and `noteClause` needs the numbers to avoid
// advising "raise maxLines"/"raise maxBytes" at the ceiling (F3). Slots are paired with
// entries by index at the call site — `files` is `slots.map(...)`, so the order is the
// contract.
type NoteCandidate = {
    entry: FileReadEntry;
    maxLines: number;
    maxBytes: number;
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
// The caps are what THIS request applied, which the entry cannot report (its `limit`
// field is only the reason, not the number). The distinction matters because the cases
// have OPPOSITE remedies:
//   - below a ceiling: raising that cap is free progress, so the clause says so, and
//     names the cap it stopped at so the caller knows what to raise it FROM;
//   - AT a ceiling: "raise it" is a trap — following it with ceiling+1 is rejected by
//     `readMaxLines`/`readMaxBytes` as an invalid request — so the clause names the
//     ceiling it hit and leaves the continuation as the only remedy (F3);
//   - `budget`: neither of this file's caps bound it, the batch's shared envelope did,
//     so raising anything on this path alone would achieve nothing.
const noteClause = (entry: FileReadEntry, caps: { maxLines: number; maxBytes: number }): string => {
    let limit = `limit: ${entry.limit ?? 'budget'}`;

    if (entry.limit === 'maxLines') {
        limit =
            caps.maxLines >= FILE_READ_MAX_LINES
                ? `limit: maxLines at the ${FILE_READ_MAX_LINES} ceiling`
                : `limit: maxLines at ${caps.maxLines} - raise maxLines`;
    } else if (entry.limit === 'maxBytes') {
        limit =
            caps.maxBytes >= FILE_READ_MAX_BYTES
                ? `limit: maxBytes at the ${FILE_READ_MAX_BYTES} ceiling`
                : `limit: maxBytes at ${caps.maxBytes} - raise maxBytes`;
    }

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
        .map((candidate) => noteClause(candidate.entry, candidate));
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

// ---------------------------------------------------------------------------
// FAILURE-PATH GUIDANCE — a bounded, failure-only convenience (see the header
// section "WHY AN UNREADABLE PATH NAMES A SUGGESTION"). None of this runs on a
// successful read, every helper is capped, and every helper answers "no help"
// rather than throwing, because guidance is not worth failing a batch over.
// ---------------------------------------------------------------------------

// Fold a NAME the way a human comparing two spellings does: case-insensitive, and
// with the invisible differences a copied path carries removed. NFKC collapses the
// look-alikes (a FULLWIDTH colon, a compatibility ligature), and the hand-written
// pairs cover what NFKC leaves alone: NBSP and its narrow/thin relatives become a
// plain space, curly quotes become ASCII. Without this, a filename copied out of a
// document or a chat message differs from the one on disk by exactly one code point
// the eye cannot see, and "did you mean" would find nothing.
const FOLD_MAP: ReadonlyMap<string, string> = new Map([
    ['\u00a0', ' '],
    ['\u2007', ' '],
    ['\u202f', ' '],
    ['\u200a', ' '],
    ['\u2018', "'"],
    ['\u2019', "'"],
    ['\u201c', '"'],
    ['\u201d', '"'],
    ['\u2010', '-'],
    ['\u2011', '-'],
    ['\u2012', '-'],
    ['\u2013', '-'],
    ['\u2014', '-'],
    ['\u2026', '...']
]);

const foldName = (value: string): string =>
    [...value.normalize('NFKC').toLowerCase()].map((char) => FOLD_MAP.get(char) ?? char).join('');

// The parent folder's names, bounded. A missing path is usually a near-miss inside a
// folder that DOES exist, so one bounded readdir is the whole answer. A folder that
// cannot be listed (missing, unreadable, or huge) yields nothing rather than a delay:
// the entry already carries a correct errno, and guidance can only improve on it.
const listNames = async (dir: string, cap: number): Promise<string[]> => {
    try {
        const names: string[] = [];

        for await (const entry of await readdir(dir)) {
            names.push(entry);
            if (names.length >= cap) break;
        }

        return names;
    } catch {
        return [];
    }
};

// The edit distance between two folded names, or `cap + 1` as soon as it is proven to
// exceed `cap`. Row-wise Levenshtein with the standard early exit: when a row's running
// minimum passes the cap, no later row can come back under it, so a name that is
// clearly unrelated costs its first row rather than the whole matrix. That is what
// makes scoring EVERY name in a folder a rounding error next to the readdir that
// already happened — `FILE_READ_SUGGESTION_SCAN` names x a few hundred cells, with the
// bail firing on almost all of them.
const editDistance = (left: string, right: string, cap: number): number => {
    if (Math.abs(left.length - right.length) > cap) return cap + 1;

    const prev = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let row = 1; row <= left.length; row += 1) {
        let diagonal = prev[0];
        prev[0] = row;
        let rowMin = row;

        for (let column = 1; column <= right.length; column += 1) {
            const saved = prev[column];
            prev[column] = Math.min(
                prev[column] + 1,
                prev[column - 1] + 1,
                diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
            );
            diagonal = saved;
            if (prev[column] < rowMin) rowMin = prev[column];
        }

        if (rowMin > cap) return cap + 1;
    }

    return prev[right.length];
};

// How far a name may be from the requested one and still be worth SUGGESTING: the
// distance must stay under a third of the longer spelling, so the two must share at
// least ~2/3 of their characters. A fixed allowance is wrong in both directions — a
// flat 3 calls `util.ts` a near-miss of a 30-character name and refuses one dropped
// character in a 40-character one. The ratio is also what a caller expects: one
// dropped, doubled or transposed character is always close enough, an unrelated
// sibling never is.
const suggestionCap = (base: string, folded: string): number =>
    Math.floor(Math.max(base.length, folded.length) / 3);

// Up to `limit` did-you-mean candidates from the parent folder, ranked by how closely
// the name matches — exact, then prefix, then substring, then the reverse (a caller
// that typed MORE than the real name), then edit distance — then by distance, brevity,
// and name, so the answer is stable across runs and platforms.
//
// Both families of near-miss are needed, and they are disjoint. An agent that half
// remembers a path drops a prefix or truncates a tail, which substring matching catches
// and a similarity score alone can rank below an unrelated name of the same length. An
// agent that COPIED a name mistypes one character (`nested-targt.ts` for
// `nested-target.ts`), which no amount of substring testing catches — that is the case
// the edit distance exists for.
const suggestNames = async (requested: string, limit: number): Promise<string[]> => {
    const dir = dirname(requested);
    const base = foldName(basename(requested));

    // An empty base ("dir/") asks for nothing, and a substring test against the empty
    // string matches EVERY name in the folder — three arbitrary siblings would be
    // offered as if they were the answer. Decline rather than pad the message.
    if (base.length === 0) return [];

    const names = await listNames(dir, FILE_READ_SUGGESTION_SCAN);

    return names
        .filter((name) => name !== requested)
        .map((name) => {
            // Code points, not UTF-16 units: a name built from astral characters would
            // otherwise get a cap sized in surrogate halves, i.e. twice as generous as
            // the same spelling in ASCII. Over-long names are dropped outright — the
            // matrix is quadratic in the length, and 500 characters is not a plausible
            // near-miss of anything, so the scan stays bounded on a pathological folder.
            const folded = foldName(name);

            if (folded.length > SUGGESTION_NAME_MAX_CODE_POINTS) return { name, rank: 9, distance: 999 };

            const cap = suggestionCap(base, folded);
            const distance = editDistance(base, folded, cap);

            return {
                name,
                // 0 exact, 1 prefix, 2 substring, 3 contains-it, 4 close-but-not-a
                // substring, 9 nothing.
                rank:
                    folded === base
                        ? 0
                        : folded.startsWith(base)
                          ? 1
                          : folded.includes(base)
                            ? 2
                            : base.includes(folded)
                              ? 3
                              : distance <= cap
                                ? 4
                                : 9,
                distance
            };
        })
        .filter((candidate) => candidate.rank < 9)
        .sort(
            (left, right) =>
                left.rank - right.rank ||
                left.distance - right.distance ||
                left.name.length - right.name.length ||
                (left.name < right.name ? -1 : 1)
        )
        .slice(0, limit)
        .map((candidate) => candidate.name);
};

// The nearest folder that DOES exist above a missing path, so the entry can say where
// the caller's spelling stopped matching reality rather than just "no such file". The
// walk is bounded: past a dozen levels the answer is "nothing along that path", which
// is what a typo near the root would say anyway, and it keeps the failure cheap on a
// pathological `/a/a/a/a/…` path.
const nearestExistingAncestor = async (path: string): Promise<{ dir: string; levels: number } | null> => {
    let dir = dirname(path);

    for (let levels = 1; levels <= MISSING_ANCESTOR_WALK; levels += 1) {
        try {
            const info = await stat(dir);
            if (info.isDirectory()) return { dir, levels };
        } catch {
            // Keep walking: this level does not exist either.
        }

        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }

    return null;
};

// The ENOENT sentence. The first clause is the historical contract, kept word-for-word
// so existing callers and tests see the same answer; the guidance is APPENDED, and only
// when there is something to append.
const missingMessage = async (path: string): Promise<string> => {
    const base = `read could not find "${path}": no such file or directory (ENOENT).`;
    const parent = dirname(path);
    const suggestions = await suggestNames(path, FILE_READ_SUGGESTION_MAX);

    // The parent exists and something in it resembles the name: the candidates alone are
    // the actionable part, and this is the case the guidance exists for — opencode's own
    // out-of-range and partial-read errors exist to give exactly this kind of "here is
    // what IS there" detail rather than a bare errno.
    if (suggestions.length > 0) {
        return `${base} Did you mean ${suggestions.map((name) => `"${name}"`).join(', ')} in "${parent}"?`;
    }

    const parentExists = await isDirectory(parent);

    if (parentExists) {
        return `${base} Nothing in "${parent}" resembles that name; list the folder (files/glob) before assuming the path is right.`;
    }

    // The folder the caller named is itself the mistake, which the errno cannot say:
    // ENOENT is the same code for "wrong file name" and "wrong directory".
    const ancestor = await nearestExistingAncestor(path);

    if (ancestor === null) {
        return `${base} No folder along that path exists either, so the spelling of the directory, not just the file name, is the problem.`;
    }

    return `${base} Its parent folder "${parent}" is missing too — the nearest folder along that path that DOES exist is "${ancestor.dir}", ${ancestor.levels} folder(s) up, so the directory part of the path is wrong, not only the file name.`;
};

// The EISDIR sentence, with a preview when the folder can be listed. A bare "it is a
// directory" costs a round trip: the agent's next call is always "then list it".
const directoryEntryMessage = async (path: string): Promise<string> => {
    const names = await listNames(path, FILE_READ_PREVIEW_MAX + 1);

    if (names.length === 0) return directoryMessage(path);

    const shown = names.slice(0, FILE_READ_PREVIEW_MAX).sort((left, right) => (left < right ? -1 : 1));
    const rest = names.length - shown.length;
    const preview = `${shown.join(', ')}${rest > 0 ? `, …and ${rest} more` : ''}`;

    return `read cannot read "${path}": it is a directory, not a file. Its entries: ${preview}. Pass a file path inside it, or use files/glob to list more.`;
};

// A `startByte` at or past the end of the file (D10). The message names the file size
// so the caller can see how far in range it was, and points at the two ways to fix it:
// drop `startByte` and read from the top, or stop paging — this offset IS the end.
const rangeMessage = (path: string, startByte: number, sizeBytes: number): string =>
    `read could not seek "${path}" to byte ${startByte}: the file is ${sizeBytes} bytes, so that offset is at or past its end (ERANGE). An empty window is NOT "this file is empty"; drop startByte to read from the beginning, or treat this as the end of the file.`;

// The same answer on the LINE axis (D11-line). It names the file's LINE COUNT, which
// the missing-line walk counted on the way to proving the request was out of range —
// the difference between "startLine 5000, file has 1300 lines" and a message that
// leaves the caller to discover that by paging.
const rangeLineMessage = (path: string, startLine: number, lineCount: number): string =>
    `read could not start "${path}" at line ${startLine}: the file has ${lineCount} lines, so that line does not exist (ERANGE). An empty window is NOT "this file is empty"; drop startLine to read from the beginning, or treat this as the end of the file.`;

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

// The line cap. DEFAULT: FILE_READ_DEFAULT_MAX_LINES (2000) — D11, see the header
// section "THE DEFAULT IS A CONTEXT BUDGET, NOT A MEMORY BUDGET". An explicit value
// must be in [1, FILE_READ_MAX_LINES] — with ONE deliberate exception: the exported
// default itself is accepted. A caller that reads `FILE_READ_DEFAULT_MAX_LINES` and
// passes it back must get the behaviour that constant names, not a validation error,
// and that is not hypothetical: the repo's own scripts/verify-read-fixes.mjs threads
// the constant through exactly this way, and so does any host that mirrors it.
// Refusing it would make the documented default a value the tool rejects. The MESSAGE
// does not advertise the sentinel, because printing 9007199254740991 at a model that
// passed `maxLines: 0` answers a question it did not ask; "omit it" is the actionable
// form, and it now names the real default instead of the retired "no line cap".
const readMaxLines = (value: unknown): number => {
    if (value === undefined || value === FILE_READ_DEFAULT_MAX_LINES) return FILE_READ_DEFAULT_MAX_LINES;

    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > FILE_READ_MAX_LINES) {
        throw new HarnessError(
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for the ${FILE_READ_DEFAULT_MAX_LINES}-line default; received ${String(value)}.`
        );
    }

    return value as number;
};

// The per-file byte allowance (D11), in the same escaped-wire-byte units `bytes` and
// `wireBytes` are measured in, so the number a caller compares against its own
// result is the number it asked for. Absent means the 64 KiB default.
//
// Bounded rather than clamped, exactly like every other range field here: a silent
// clamp of `maxBytes: 10_000_000` down to the envelope would report `limit: "budget"`
// for a request the caller believed was unlimited, and `limit` is the field that
// tells an agent whether to ask for more. Above the ceiling the request is refused,
// and the message names the ceiling so the retry is one edit, not a guess.
const readMaxBytes = (value: unknown): number => {
    if (value === undefined || value === FILE_READ_DEFAULT_MAX_BYTES) return FILE_READ_DEFAULT_MAX_BYTES;

    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > FILE_READ_MAX_BYTES) {
        throw new HarnessError(
            `read maxBytes must be an integer between 1 and ${FILE_READ_MAX_BYTES}, or omitted for the ${FILE_READ_DEFAULT_MAX_BYTES}-byte default; received ${String(value)}.`
        );
    }

    return value as number;
};

// An optional boolean flag (`lossy`, `numbered`). Defaulted to false rather than
// coerced: answering `lossy: "yes"` as `true` would substitute U+FFFD into text the
// caller believed was exact, which is precisely the silent change the flag has to be
// opted into. `null` is accepted as "not set" because a JSON producer that means
// "omitted" often spells it that way, and it cannot mean substitution.
const readFlag = (value: unknown, field: string): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;

    throw new HarnessError(`read ${field} must be a boolean or omitted; received ${String(value)}.`);
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
            'read expects an array of paths (strings or { path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered } objects), e.g. ["package.json"].'
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
                maxLines: FILE_READ_DEFAULT_MAX_LINES,
                maxBytes: FILE_READ_DEFAULT_MAX_BYTES,
                lossy: false,
                numbered: false
            };
        }

        // A range object must carry a usable path. Arrays/null/non-objects are
        // rejected with the same shape guidance as a non-array argument.
        if (target === null || typeof target !== 'object' || Array.isArray(target)) {
            throw new HarnessError(
                'read paths must be strings or { path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered } objects.'
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
            maxLines: readMaxLines(target.maxLines),
            maxBytes: readMaxBytes(target.maxBytes),
            // Optional booleans, defaulted rather than clamped: `lossy: "yes"` is a
            // caller bug and answering it as `true` would silently substitute U+FFFD
            // into text the caller believed was exact.
            lossy: readFlag(target.lossy, 'lossy'),
            numbered: readFlag(target.numbered, 'numbered')
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
    // "maxLines" | "maxBytes" | "budget" | null — the reason the window stopped (D5).
    limit: 'maxLines' | 'maxBytes' | 'budget' | null;
    // Which label a BYTE cut gets: "maxBytes" when this file's own allowance is what
    // bound it, "budget" when the batch share is smaller than that allowance, so the
    // surplus is stranded elsewhere. Only the second is worth re-scanning with a
    // bigger allowance, which is what `cutByBudget` below decides.
    byteCutLimit: 'maxBytes' | 'budget';
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
    // Newlines before the window and whether this call counted them, carried so a
    // later pass can still report an honest `lineCount` (see ScanProgress).
    prefixNewlines: number;
    prefixCounted: boolean;
    // Numbering is a rendering choice, but its BYTES are charged here: the gutter a
    // numbered window adds is part of what the model receives, so it competes for the
    // same allowance as the text. `gutterCharged` marks the current line as already
    // billed, so a line is charged once no matter how many chunks it spans.
    numbered: boolean;
    gutterCharged: boolean;
    // Lossy decoding: `lossy` is the request, `sawLoss` says this window actually
    // substituted something, which is the only case that earns the entry's `lossy`.
    lossy: boolean;
    sawLoss: boolean;
    // Newlines CONSUMED by this window (every newline it emitted), needed to finish the
    // whole-file line count when the scan reaches EOF — `endLine` cannot do the job,
    // because an unterminated last line never increments it.
    windowNewlines: number;
};

// Record the truncation point at the current character, so a continuation resumes
// exactly here rather than skipping or repeating it. `byBytes` names the reason in
// `limit` — which of the two byte governors stopped it, from the state, because only
// a SHARE-bound file is worth re-scanning with a bigger allowance (D5, D11).
const stopAt = (state: ScanState, line: number, column: number, byBytes: boolean): true => {
    state.truncated = true;
    state.limit = byBytes ? state.byteCutLimit : 'maxLines';
    state.nextLine = line;
    state.nextColumn = column;
    state.nextByte = state.scanOffset;
    state.cutByBudget = byBytes && state.byteCutLimit === 'budget';
    return true;
};

// The width of one `123: ` line gutter in the model's copy. Charged to the same
// allowance as the text, so `numbered` shrinks the window it numbers instead of
// letting a response grow past its envelope.
const gutterWidth = (lineNumber: number): number => String(lineNumber).length + 2;

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
//   1b. the gutter of a `numbered` window is billed when its line STARTS, because
//      the model receives `123: ` as part of the text — charging it here (rather than
//      post-hoc) is what makes a numbered read fit the same allowance an unnumbered
//      one does, and what makes a cut land at a line start when the gutter itself
//      would not fit.
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
    // NUL is the cheapest strong signal that the file is not text, and it stays fatal
    // in BOTH decode modes: a lossy read is for mojibake-prone legacy text, not for
    // bytes that say "I am a binary". (Invalid UTF-8 is what `lossy` exists for, and
    // the decoder itself handles that — see scanFile.)
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

        // 1b. Bill this line's numbering gutter before any of its characters, so the
        // window the model sees is the window the allowance paid for. A resume bills
        // the continuation of a giant line too: in the model's copy it is a numbered
        // line of its own entry, gutter and all.
        if (state.numbered && !state.gutterCharged) {
            const gutter = gutterWidth(state.lineNumber);

            if (state.wireBytes + gutter > state.budget) {
                return stopAt(state, state.lineNumber, state.lineOffset, true);
            }

            state.wireBytes += gutter;
            state.gutterCharged = true;
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
            state.windowNewlines += 1;
            state.lineNumber += 1;
            state.lineOffset = 0;
            // The next line owes its own gutter.
            state.gutterCharged = false;
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
// to, the aligned offset when a supplied `startByte` had to be moved, and whether the
// line number is a COUNT or the caller's word (`counted`). The distinction is what
// lets the entry report `lineCount` honestly: a number the caller supplied was never
// verified against the file, so the file's total is not knowable from it.
type SeekStart = {
    offset: number;
    line: number;
    aligned: number | null;
    counted: boolean;
};

// Resolve `startByte` into a place to start DECODING. Nothing here counts characters:
// a seek is a byte read plus, at worst, one raw newline count.
const resolveSeek = async (
    handle: FileHandle,
    request: NormalizedTarget,
    sizeBytes: number
): Promise<SeekStart | 'ERANGE'> => {
    const given = request.startByte;
    if (given === null) return { offset: 0, line: 1, aligned: null, counted: true };

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
        return {
            offset: sizeBytes,
            line: 1 + (await countNewlines(handle, 0, sizeBytes)),
            aligned: aligned === given ? null : aligned,
            counted: true
        };
    }

    // The line at the seek point is the caller's word when it named one — threading
    // `nextByte` and `nextLine` back together is then free, with no count at all —
    // and otherwise the truth, counted on raw bytes rather than defaulted to 1 (D2).
    if (request.startLineGiven) {
        return { offset: aligned, line: request.startLine, aligned: aligned === given ? null : aligned, counted: false };
    }

    return {
        offset: aligned,
        line: 1 + (await countNewlines(handle, 0, aligned)),
        aligned: aligned === given ? null : aligned,
        counted: true
    };
};

// Advance past the requested prefix WITHOUT decoding it: `linesToSkip` newlines, then
// `columnToSkip` bytes rounded up to a code-point boundary. Returns the offset the
// window starts at and the line that offset belongs to.
//
// This is the D3 fix. The skip used to live inside the character loop, so reaching
// line 199,000 decoded and iterated 199,000 lines' worth of CHARACTERS purely to count
// newlines — 482 ms against 1.6 ms for the same window at line 1, and 0.7 ms for a
// `startByte` seek. Counting 0x0a with `indexOf` does the same job at seek speed.
//
// The skip also settles the LINE-axis range question (D11-line). Reaching the target
// line means walking every newline before it, so the walk either found them all or
// ran out of file:
//   - `newlinesSeen < linesToSkip` — the file holds fewer line TERMINATORS than were
//     skipped, so `startLine` names a line that does not exist and cannot be returned
//     empty: `pastEof` reports it and `scanFile` answers ERANGE, the same answer the
//     byte axis already gives for a `startByte` past the end (D10);
//   - `newlinesSeen === linesToSkip` at EOF — the target line IS the unterminated last
//     line, which legitimately reads as an empty window at EOF.
//
// `newlinesSeen` is a byproduct of a walk that already happened, which is why the
// whole-file line count is free to report in exactly these cases (and only here).
type WindowStart = {
    offset: number;
    line: number;
    // Set when the prefix walk could not find `linesToSkip` newlines before EOF.
    pastEof: boolean;
    // Every newline in the file, when the walk went all the way to EOF (it must have,
    // for `pastEof` to be set). Meaningless otherwise.
    newlinesSeen: number;
};

const skipToWindow = async (
    handle: FileHandle,
    sizeBytes: number,
    start: { offset: number; line: number; counted: boolean },
    linesToSkip: number,
    columnToSkip: number
): Promise<WindowStart> => {
    let cursor = start.offset;
    let line = start.line;
    let needed = linesToSkip;
    let newlinesSeen = 0;
    let pastEof = false;

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
                newlinesSeen += 1;
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

        // Fewer newlines exist than were asked for: the window starts at EOF, which is
        // "past the end of the file", not "an empty line here" (D11-line). A file whose
        // last line is unterminated can still land here with `needed === 1` for THAT
        // line, so the count is what distinguishes them, not the position.
        if (!landed) {
            cursor = sizeBytes;
            pastEof = needed > 0;
        }
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

    return { offset: cursor, line, pastEof, newlinesSeen };
};

// The line count of a file the caller asked to start past the end of. `newlinesSeen`
// is every terminator in the file (the prefix walk went to EOF to prove the line was
// missing), and an unterminated final line counts as one more. One byte of probe
// decides whether that extra line exists — free next to the walk that already read
// the whole file, and it is the number the ERANGE message exists to give.
const lineCountOf = async (handle: FileHandle, sizeBytes: number, newlinesSeen: number): Promise<number> => {
    if (sizeBytes === 0) return 0;

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(probe, 0, 1, sizeBytes - 1);

    const trailingNewline = bytesRead === 1 && probe[0] === NEWLINE_CODE;

    // Same rule as `lineCountFromProbe`: a newline TERMINATES the line above it, so N
    // terminators mean N lines, and only a file that does not end with one has an extra
    // (unterminated) final line.
    return newlinesSeen + (trailingNewline ? 0 : 1);
};


// The outcome of one scan of one file: the entry, whether a larger allowance would
// have helped, and the progress a surplus pass resumes from (D4).
type ScanOutcome = {
    entry: FileReadEntry;
    cutByBudget: boolean;
    progress: ScanProgress | null;
    // Set when `startLine` named a line the file does not have (D11-line). The scan
    // produced an empty window, and the caller gets ERANGE instead — with the file's
    // line count, which the prefix walk that proved the miss already counted.
    outOfRange: { lineCount: number } | null;
};

// Stream one file, retaining only the requested window.
//
// `seek` is where decoding may begin and what line that offset belongs to; `progress`
// is the window an earlier allocation pass already produced, or null on the first
// pass. With `startByte` the read is O(window); without it, line numbers force a raw
// newline count from byte 0 — cheap, but not free.
//
// `allowance` is the number of wire bytes THIS file may take: the smaller of its own
// `maxBytes` and the batch share, decided by the caller (D11). `byteCutLabel` says
// which of those two bound it, and a byte cut is reported as that reason — a caller
// told "budget" when its own 64 KiB allowance is what ran out would raise nothing,
// because raising the batch does not help one file, and a caller told "maxBytes" when
// the batch share is smaller would raise `maxBytes` and get the same window back.
const scanFile = async (
    handle: FileHandle,
    request: NormalizedTarget,
    allowance: number,
    byteCutLabel: 'maxBytes' | 'budget',
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
        ? { offset: seek.offset, line: seek.line, pastEof: false, newlinesSeen: 0 }
        : await skipToWindow(handle, sizeBytes, seek, linesToSkip, columnToSkip);

    // The newlines before the window, and whether anyone actually counted them: the
    // seek's own count when it did the counting, and otherwise the caller's asserted
    // `startLine` (unverified, so the file's total is not knowable from it).
    const prefixNewlines = resuming ? progress.prefixNewlines : windowStart.line - 1;
    const prefixCounted = resuming ? progress.prefixCounted : seek.counted;

    // `startLine` past the end (D11-line). An empty, untruncated window is NOT the
    // answer, because it is indistinguishable from "this file is empty" — the exact
    // bug D10 removed on the byte axis. Settled here rather than in phase 1 because
    // knowing a line is missing requires walking the file, and phase 1 only has a stat.
    if (windowStart.pastEof) {
        return {
            entry: emptyWindowEntry(request),
            cutByBudget: false,
            progress: null,
            outOfRange: { lineCount: await lineCountOf(handle, sizeBytes, windowStart.newlinesSeen) }
        };
    }

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
        byteCutLimit: byteCutLabel,
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
        startByteAligned: seek.aligned,
        prefixNewlines,
        prefixCounted,
        numbered: request.numbered,
        gutterCharged: false,
        lossy: request.lossy,
        sawLoss: resuming ? progress.sawLoss : false,
        windowNewlines: resuming ? progress.windowNewlines : 0
    };

    // A strict decoder (`fatal: true`) turns ONE bad byte into EBINARY for the whole
    // window, which is the right default (silently changing a file is worse than
    // refusing it) and the wrong one for a Latin-1 log: the bytes are text, the tool
    // knows it, and it shows none of them. `lossy: true` swaps in the substituting
    // decoder, which turns the same byte into U+FFFD and carries on; the entry then
    // reports `lossy: true` so the substitution is stated rather than implied.
    const decoder = new TextDecoder('utf-8', { fatal: !request.lossy, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let readOffset = windowStart.offset;
    // Whether this pass read the file to its end. Only then is the whole-file line
    // count knowable from what was already counted (see `lineCount` on the entry).
    let reachedEnd = false;

    while (!state.stopped) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
        if (bytesRead === 0) {
            reachedEnd = true;
            break;
        }

        readOffset += bytesRead;

        let text: string;
        try {
            text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        } catch {
            throw new HarnessError(binaryMessage(request.path));
        }

        if (request.lossy) sawSubstitution(state, text);

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

        if (request.lossy) sawSubstitution(state, tail);

        if (tail.length > 0) state.stopped = consumeText(state, tail);
    }

    // A file ending without a newline still contributes an unterminated line, but
    // there is nothing after it, so no truncation flag is added here. `endLine`
    // already tracks every emitted character.
    //
    // `lineCount` is published ONLY when this call actually counted every line of the
    // file: the prefix before the window was counted (`prefixCounted`) and the scan ran
    // to EOF. Anything else would need a second whole-file pass, which the cost
    // contract forbids — the same reasoning that keeps binary detection window-scoped.
    // Reaching EOF is the common case for exactly the reads where the number matters
    // (a small file read whole, or one paged to its end).
    let lineCount: number | undefined;

    if (prefixCounted) {
        // Where the DECODED window ended. `scanOffset` is the first byte this pass did
        // not consume, so everything after it is still unread bytes of the file.
        const windowEnd = state.scanOffset;

        if (windowEnd >= sizeBytes) {
            // Nothing left to read: the newlines are all accounted for, and one byte of
            // probe says whether the last line is terminated.
            lineCount = lineCountFromProbe(state.startLine, state.windowNewlines, sizeBytes, await lastIsNewline(handle, sizeBytes));
        } else if (reachedEnd) {
            // The window stopped early (line cap, or a `startByte` seek that left a
            // suffix unread) but the file is still open and the suffix is a raw scan
            // away — no decode, no allocation per character, so the count is still free.
            const trailing = await countNewlines(handle, windowEnd, sizeBytes);

            lineCount = lineCountFromProbe(
                state.startLine,
                state.windowNewlines + trailing,
                sizeBytes,
                await lastIsNewline(handle, sizeBytes)
            );
        }
    }

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
        sizeBytes: null,
        ...(lineCount === undefined ? {} : { lineCount }),
        ...(state.lossy && state.sawLoss ? { lossy: true as const } : {})
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
              startByteAligned: state.startByteAligned,
              prefixNewlines: state.prefixNewlines,
              prefixCounted: state.prefixCounted,
              sawLoss: state.sawLoss,
              windowNewlines: state.windowNewlines
          }
        : null;

    // `cutByBudget` is not part of the public entry: it only tells the allocator
    // whether a larger allowance would have helped, so a `maxLines` cut is never
    // offered surplus it cannot use.
    return { entry, cutByBudget: state.cutByBudget, progress: next, outOfRange: null };
};

// Is the file's LAST byte a newline? One byte of probe, and it settles whether the
// final line is terminated (a terminated final line means "N newlines = N lines") or
// unterminated (which means one more line than there are terminators). Called only
// where a whole-file scan has already been paid for, so this byte is free.
const lastIsNewline = async (handle: FileHandle, sizeBytes: number): Promise<boolean> => {
    if (sizeBytes === 0) return false;

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(probe, 0, 1, sizeBytes - 1);

    return bytesRead === 1 && probe[0] === NEWLINE_CODE;
};

// How many lines a file holds, when every newline in it has been counted. A newline
// TERMINATES the line above it rather than starting an empty one, so N terminators mean
// exactly N lines, and only a file that does NOT end with one has an extra (unterminated)
// final line. That is the `wc -l` convention, and the one `startLine`/`endLine` already
// use — an agent that counts the lines it was shown must land on the same number the
// entry reports. `startLine - 1` are behind the window (valid only because
// `prefixCounted` guarantees `startLine` is the TRUE line there, not a caller's word).
// A 0-byte file has no lines at all, which is what keeps "past the end" and "nothing
// here" different answers.
const lineCountFromProbe = (
    startLine: number,
    windowNewlines: number,
    sizeBytes: number,
    trailingNewline: boolean
): number => {
    if (sizeBytes === 0) return 0;

    return startLine - 1 + windowNewlines + (trailingNewline ? 0 : 1);
};

// Did a lossy decode substitute anything in this chunk? Only the presence matters: the
// entry reports `lossy: true` to say "some of these U+FFFD came from us", and a count
// would cost a second pass over the text for no extra actionability.
const sawSubstitution = (state: ScanState, text: string): void => {
    if (!state.sawLoss && text.includes('\ufffd')) state.sawLoss = true;
};

// Resolve a slot's seek ONCE and keep it. A surplus pass would otherwise recount the
// newlines before the seek point every time it ran, which is exactly the rescanning
// D4 exists to remove; and the alignment decision must not be able to change between
// passes, or two passes of one batch would disagree about where the window starts.
const seekOf = async (slot: ScanSlot): Promise<SeekStart | 'ERANGE'> => {
    if (slot.seek !== undefined) return slot.seek;

    const { handle, request, sizeBytes } = slot;
    // handle is null only for an entry that already failed, which never scans.
    slot.seek = handle === null ? { offset: 0, line: 1, aligned: null, counted: true } : await resolveSeek(handle, request, sizeBytes);
    return slot.seek;
};

// The empty window an out-of-range `startLine` leaves behind. Shaped exactly like the
// window a seek-to-EOF produces (see `failedEntry` for the same reasoning on the byte
// axis), so a caller's range arithmetic still holds; `scanSafely` turns it into the
// ERANGE entry that names the file's line count.
const emptyWindowEntry = (request: NormalizedTarget): FileReadEntry => ({
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
    sizeBytes: null
});

// Scan one slot, translating the scanner's binary throw into a per-entry EBINARY
// result. A binary file is a FILE outcome, not a broken request, so it must not
// destroy the rest of the batch.
//
// `allowance` is the BATCH share. The effective allowance this file gets is
// `min(allowance, request.maxBytes)`, and `byteCutLabel` records which of the two is
// smaller so a byte cut names the governor that actually bound it (D11). Capping here
// rather than in the allocator keeps the water-filling arithmetic untouched: a small
// `maxBytes` gives its unused share back to the batch exactly like a file that needed
// less than its share did, and a large `maxBytes` cannot reach past the envelope
// because the share still comes from the same 256 KiB.
const scanSafely = async (slot: ScanSlot, allowance: number): Promise<FileReadEntry> => {
    const { request, handle, sizeBytes } = slot;
    if (handle === null) return failedEntry(request, 'EIO', `read failed to read "${request.path}".`, sizeBytes);

    const effective = Math.min(allowance, request.maxBytes);
    const byteCutLabel: 'maxBytes' | 'budget' = request.maxBytes < allowance ? 'maxBytes' : 'budget';

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
        : { offset: progress.resumeByte, line: progress.lineNumber, aligned: progress.startByteAligned, counted: progress.prefixCounted };

    try {
        const { entry, cutByBudget, progress: next, outOfRange } = await scanFile(
            handle,
            request,
            effective,
            byteCutLabel,
            sizeBytes,
            start,
            progress
        );

        // `startLine` named a line the file does not have (D11-line). The count that
        // proves it was a byproduct of the walk, so the message can name the file's
        // total — the number that makes "you are past the end" actionable.
        if (outOfRange !== null) {
            slot.cutByBudget = false;
            slot.progress = null;
            return failedEntry(
                request,
                'ERANGE',
                rangeLineMessage(request.path, request.startLine, outOfRange.lineCount),
                sizeBytes
            );
        }

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
        // The one outcome that is a plain lookup result rather than a failure to read
        // something that exists. The leading sentence is kept word-for-word from the
        // previous contract so existing callers and tests see the same answer; the
        // guidance after it (suggestions, or where the path stopped existing) is
        // failure-only and bounded — see the header section on unreadable paths.
        return { code: 'ENOENT', message: await missingMessage(request.path) };
    }

    if (code === 'EISDIR') return { code: 'EISDIR', message: await directoryEntryMessage(request.path) };

    // Windows reports EPERM for a directory read. One narrow stat decides, and only
    // after the failure, so a genuine denial keeps permission wording.
    if (code === 'EPERM' && (await isDirectory(request.path))) {
        return { code: 'EISDIR', message: await directoryEntryMessage(request.path) };
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
    // THE DECLARATION TAX. This description and the schema below go to the model on
    // EVERY request (`visibility: 'core'`), so their bytes are paid by every
    // conversation the harness runs, not only by the calls that use this tool.
    // Measured before D11: 3,285 bytes here and 2,939 of parameter schema, against the
    // ~500 bytes a same-shaped file tool declares elsewhere. It is now sized for what
    // the model must know to make the NEXT call correctly — the caps, what each
    // `limit` means, and how to continue. The reasoning for every field lives here in
    // the source and in the prose projection the model actually reads, not in the
    // declaration. `read.test.ts` guards the ceiling, because a description only ever
    // grows by default.
    description:
        'Read a BOUNDED window of UTF-8 text files. A `paths` item is a path string or { path, startLine, startColumn, startByte, maxLines, maxBytes, lossy, numbered }. Result: { files: [{ path, content, startLine, endLine, truncated, limit, startByteAligned, nextLine, nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?, error? }], truncated, bytes, wireBytes, contentBudget, modelBytes, skipped, note? }. Per-file defaults startLine 1, startColumn 0, startByte null, maxLines 2000, maxBytes 65536 - deliberately SMALL, because this feeds a context window, not a pipe (ceilings 20000 lines, 262144 bytes). `content` is raw text whose first line is `startLine`; `numbered: true` prefixes the model\'s copy with `123: `. Act on `truncated`/`limit` before assuming you have the file: "maxLines" raise maxLines, "maxBytes" raise maxBytes, "budget" means the batch\'s 256 KiB envelope is full (want fewer bytes across the batch), null means EOF. Continue with startByte = nextByte (a SEEK) or { startLine: nextLine, startColumn: nextColumn }; files 65536+ bytes cut are also named in `note`. A seek past EOF is an ERANGE entry naming the file size or line count, never an empty window. The 256 KiB budget is measured on the SERIALIZED result and allocated by demand; max 100 paths. An unreadable path stays IN ORDER with `error: { code, message }` - ENOENT (names likely paths), EISDIR (previews entries), EACCES/EPERM, EBINARY (`lossy: true` substitutes U+FFFD), ERANGE, EIO - and costs no budget. Only a malformed request rejects the call. Paths are relative to the working directory.',
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
                                        '0-based UTF-8 byte offset to SEEK to; feed back a previous nextByte. Inside a multi-byte character it moves to the next boundary (startByteAligned); at or past EOF it is an ERANGE entry. Without startLine the true line here is counted and reported. Defaults to null.'
                                },
                                maxLines: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 20_000,
                                    description:
                                        'Lines to return. Default 2000; an explicit value is an integer in [1, 20000]. A window cut by this cap reports limit: "maxLines".'
                                },
                                maxBytes: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 262_144,
                                    description:
                                        'Bytes this file may take, in the units `bytes`/`wireBytes` report. Default 65536; an explicit value is an integer in [1, 262144]. The only knob that widens ONE file. A window cut by it reports limit: "maxBytes".'
                                },
                                lossy: {
                                    type: 'boolean',
                                    description:
                                        'Substitute U+FFFD for bytes that are not valid UTF-8 instead of reporting EBINARY, so a Latin-1 log stays readable; the entry then says `lossy: true`. Default false.'
                                },
                                numbered: {
                                    type: 'boolean',
                                    description:
                                        "Prefix each line of the model's copy with its line number (`123: `) so it can cite lines without arithmetic. `content` stays raw. Costs bytes. Default false."
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

export const read = tool<FileReadParameters, ToolTextEnvelope<FileReadResult>>({
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
                        const message = await directoryEntryMessage(request.path);
                        slots.push({
                            request,
                            handle: null,
                            sizeBytes: info.size,
                            overhead: entryOverhead(absolute, { code: 'EISDIR', message }),
                            projectionReserve: projectionOverhead(absolute, { code: 'EISDIR', message }),
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
                            projectionReserve: projectionOverhead(absolute, { code: 'ERANGE', message }),
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
                        projectionReserve: projectionOverhead(absolute),
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
                        projectionReserve: projectionOverhead(absolute, { code, message }),
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
        //
        // `projectionReserve` is charged for the same reason and by the same argument:
        // the model's copy of this result is the prose projection, delivered through
        // the same envelope the harness measures, so its fixed part has to be paid for
        // before the content is split, not discovered afterwards.
        let reserved = RESULT_SHELL.length + noteReserve(slots);
        for (const slot of slots) reserved += slot.overhead + slot.projectionReserve;

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
            slots.map((slot, index) => ({
                entry: files[index],
                maxLines: slot.request.maxLines,
                maxBytes: slot.request.maxBytes
            }))
        );

        // The model's copy (see "WHAT THE MODEL ACTUALLY RECEIVES"). It is measured on
        // the text itself, exactly as the harness will measure it going into the
        // transcript — no estimation, and no dependence on how the chunks happen to be
        // split. The per-entry chunk breakdown above exists for the RESERVE (priced
        // before the scan, per file); this is the one place the final number is taken.
        const numbered = requested.some((item) => item.numbered);
        const projection = renderProjection(files, numbered);
        const modelBytes = Buffer.byteLength(projection, 'utf8');

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
        // `modelBytes` participates in the same fixed point: its value is a constant
        // (the projection depends on neither number), but the wire cost of REPORTING
        // `wireBytes` depends on `modelBytes`'s digits, and vice versa. Climbing both
        // to the pair's upper bound keeps the result an upper bound on the real
        // serialized length.
        //
        // `note` leads the object — the same reasoning grep gives for putting `note`
        // before `matches`: if the harness ever does cut a serialized result, it keeps
        // the BEGINNING, and the advisory is the part a caller needs in order to read
        // the rest of the response correctly.
        const shape = (wire: number, model: number) =>
            Buffer.byteLength(
                JSON.stringify({
                    ...(note === undefined ? {} : { note }),
                    files,
                    truncated,
                    bytes,
                    wireBytes: wire,
                    contentBudget: FILE_READ_WIRE_BUDGET,
                    modelBytes: model,
                    skipped
                }),
                'utf8'
            );

        // `shape(w, m) = base + digits(w) + digits(m)` is non-decreasing in each
        // argument, so this climbs to a fixed point (or, at a digit boundary, a
        // 2-cycle). Keeping the LARGEST pair seen makes the result an upper bound on
        // the real serialized length, which is the safe direction: `wireBytes <=
        // contentBudget` then genuinely implies the harness envelope will not truncate.
        let wireBytes = shape(0, modelBytes);
        for (let i = 0; i < 8; i += 1) {
            const next = shape(wireBytes, modelBytes);
            if (next <= wireBytes) break;
            wireBytes = next;
        }

        // The branded pair: `content` is the machine view (the server response, a UI
        // card, a caller threading `nextByte`), the text is what the transcript gets.
        return toolText(
            {
                ...(note === undefined ? {} : { note }),
                files,
                truncated,
                bytes,
                wireBytes,
                contentBudget: FILE_READ_WIRE_BUDGET,
                modelBytes,
                skipped
            } satisfies FileReadResult,
            projection
        );
    }
});
