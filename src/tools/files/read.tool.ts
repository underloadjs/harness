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
//   - explicit binary rejection (NUL bytes or invalid UTF-8) — because replacing
//     binary bytes with U+FFFD would be a silently wrong answer. The two checks have
//     DIFFERENT scopes and the difference is deliberate, so it is spelled out here
//     rather than left to the word "window-scoped":
//       - the NUL check is WINDOW-scoped. It fires when the window would have to
//         CONTAIN a NUL, not when the read chunk happens to hold one, so a file whose
//         NUL sits past the requested window reads as TEXT for that window and as
//         EBINARY for a wider one, and a caller paging a file with `nextByte` reaches
//         the NUL as EBINARY on the page that contains it (H-decision 10: the check
//         used to be `text.includes('\u0000')` over the whole decoded 64 KiB chunk,
//         which rejected a window that had never seen the byte).
//       - the invalid-UTF-8 check is CHUNK-scoped, i.e. coarser: the streaming decoder
//         is handed the whole read chunk before the window is cut, so one bad byte
//         AFTER the cut but inside the same 64 KiB chunk still answers EBINARY. Making
//         it exact would mean decoding the window incrementally per character, which
//         is the per-character cost the byte scan exists to remove.
//     Neither check is whole-file validation: bytes before the window are never decoded
//     (the skip is a raw-byte newline count, so a file that is invalid UTF-8 only
//     BEFORE the window reads fine), and neither are bytes past the last read chunk or
//     past a stop that ended one. Rejecting the file outright would mean reading all of
//     it to decide, which is exactly the unbounded work this tool exists to avoid, and
//     the bytes the caller asked for are genuinely valid text either way.
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
// THE UNITS OF `maxBytes` ARE THE WIRE UNITS, NOT THE `bytes` UNITS (M2)
// ----------------------------------------------------------------------
// The two numbers above are deliberately different, and that makes the per-file
// `maxBytes` allowance a WIRE figure: what the allowance bounds is what the caller's
// context pays, which is the escaped form. So `bytes` can be well under `maxBytes` when
// the window was cut by it — measured, `maxBytes: 100` over `a\n` lines returns 67 raw
// bytes (34 `a` plus 33 newlines: 34 + 66 = 100 escaped) and reports `bytes: 67`. Two
// consequences a caller has to be able to predict: a newline-heavy file stops at
// `limit: "maxBytes"` at roughly HALF the raw size the number names, and a file with long
// lines cannot reach the documented 20,000-line CEILING on bytes at all — measured, 30 001
// lines of 24 characters asked for `maxLines: 20000, maxBytes: 262144` ends at line 10 036
// with 250 889 RAW bytes, because 24-character lines cost 26 escaped bytes each and one
// file's share of the envelope (262 144 minus the entry's own scaffolding) is 260 924 of
// them. That entry also reports `limit: "budget"` rather than `"maxBytes"`, which is the
// other half of the same lesson: an explicit `maxBytes` at the ceiling is still bound by
// the batch share, and `limit` names the one that actually bit. Cheap lines change the
// arithmetic, not the rule — the same request over 1-character lines costs 3 escaped bytes
// each and does reach line 20 000, cut by `maxLines`. `limit` is what makes the stop
// visible; the accounting model itself is the one that keeps `wireBytes <= contentBudget`
// true, so it is not traded away for the nicer-looking raw figure.
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
//     <raw text>
//       [truncated by maxBytes; 61438 bytes returned; continue from startByte 61438]
//
// WHY BOTHER: serializing `files[].content` costs the CALLER'S CONTEXT WINDOW the
// escaping tax measured above (+2.1% on this package's own source, +15.2% on
// quote-heavy code) PLUS the ~200 bytes of fixed JSON scaffolding every entry
// reserves, all of it competing with the file text for the same budget. Prose pays
// neither. The budget is charged on the ESCAPED form (the conservative measure), so
// `wireBytes <= contentBudget` holds by construction and the projection can never be
// cut by the harness envelope — pinned by a test, on adversarial paths, for every cut
// reason this tool can report.
//
// THE TWO VIEWS ARE BUDGETED, NOT ORDERED (F4)
// --------------------------------------------
// `modelBytes <= wireBytes` is NOT one of the guarantees, and a large `numbered` window
// breaks it: the gutter exists only in the prose, yet it is charged against the machine
// allowance, so the machine view pays for bytes it never serializes. Measured on a
// 1050-line file with `{ maxLines: 20000, maxBytes: 65536, numbered: true }`:
// `modelBytes 15,995 > wireBytes 10,981`. Plain (unnumbered) windows never violate it.
// The other direction is the common one and is worth stating, because it is the shape a
// reader meets first: for a SMALL window the machine view's twelve fixed per-entry fields
// cost more than the text does, so the prose is the smaller number there too (the
// `views.txt` fixture in read.test.ts pins `modelBytes` at 82 and `wireBytes` at 307 once
// the fixture path both views carry is set aside — the path cancels, the direction does
// not). Neither number orders the other; both are bounded by `contentBudget`, which is
// the property below.
//
// What DOES hold, and what the harness envelope depends on:
//   - `wireBytes <= contentBudget`, always (zero violations across a 200-call stress);
//   - the gutter CHARGED is at least the gutter RENDERED, because `numberedChargeWidth`
//     is an upper bound on the width `numberProjectionText` pads to — the charge is an
//     upper bound on the prose it renders, file by file, even across a digit straddle
//     (995 -> 1000, 9995 -> 10000);
//   - so the over-charged gutter only shrinks the content allowance, and the projection
//     stays inside the harness's own cap: worst measured 242,988 of 262,144 bytes.
// The asymmetry is therefore benign in the safe direction — a numbered read returns less
// text than an unnumbered one, never more prose than the envelope holds.
//
// `numbered: true` on a request puts an opencode-style `123: ` gutter on the text
// the model reads, so it can cite line numbers without arithmetic from `startLine`.
// It costs ~8 bytes per line, so it is opt-in; `content` stays raw either way, and
// the gutter is charged against the same per-file allowance as the text itself, so
// numbering can never push a response over its envelope — what it CAN do is make
// `modelBytes` exceed `wireBytes`, which is the asymmetry above rather than a bug in it.
//
// TWO CONSEQUENCES OF CHARGING THE GUTTER (M1, L1)
// ------------------------------------------------
//   - the charge is the width the RENDERER pads to (`numberProjectionText` sizes the
//     gutter on the WIDEST line number in the window, so a window over lines 998-2000
//     has a 4-digit gutter on every line), not the width of the line number being
//     printed. Billing `String(lineNumber).length` used to under-charge every line of
//     such a window by the digit it later grew, and an under-charged gutter is the one
//     place where the PROSE could exceed the allowance the machine view paid for. The
//     charge is now the renderer's upper bound, so it can only ever be generous; the
//     remaining `modelBytes` vs `wireBytes` gap is the charged-but-unserialized gutter
//     itself (F4 above), never a window the envelope cut.
//   - `bytes` does NOT report the gutter: it counts raw bytes of `content`, and the
//     gutter is only ever in the model's copy. So a numbered read shows FEWER bytes
//     than the model was given, by `digits(widest line number) + 2` per line. That is
//     why no result field carries the gutter total — the machine view never had those
//     bytes, and inventing one would cost every read to describe a flag most reads do
//     not set.
//   - numbering is PER ENTRY. It was batch-wide once (`requested.some(numbered)`), so
//     one item asking for gutters put them on every file in the call.
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
// says nothing when it is not. An EMPTY file reports 0 for EVERY `startLine`, which is
// how "nothing here" and "that offset is out of range" stay different answers.
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
//   - `nextColumn` is the 0-based UTF-8 BYTE OFFSET WITHIN `nextLine`, counted from that
//     line's PHYSICAL start — never from a seek — and 0 at a line boundary. A giant
//     single line is the only reason it is non-zero, and `{ path, startLine: nextLine,
//     startColumn: nextColumn }` then resumes EXACTLY where this window stopped, at a
//     code-point boundary. Repeating the request pages through a line of any size and
//     terminates, because the pair names an absolute position (H4 removed the exception
//     that measured `nextColumn` from `startByte` when one was supplied: the resume
//     re-applied the column from the physical line start, so a mid-line seek reported a
//     column that sent the next call back to the offset it had just read — `nextByte`
//     walked 1000 -> 2000 and `nextColumn` stayed 1000 forever);
//   - `nextByte` is the ABSOLUTE file offset of the first unread byte, always exact
//     and always on a code-point boundary — and NO byte is skipped to produce it (see
//     THE CURSOR NEVER SKIPS below), so a walk that threads `startByte = nextByte`
//     reconstructs the file byte for byte. Passing it back as `startByte` resumes by
//     SEEKING: the window itself costs O(window). What a bare `startByte` still pays is
//     the bookkeeping the entry needs: the entry must report the true LINE the offset is
//     on (D2), so the prefix is counted raw at 64 KiB per read, and a byte cut on a
//     mid-line seek probes backward for that line's start (geometric, 64 KiB doubling to
//     a 1 MiB cap). Measured on a 6 MiB single-line file, maxBytes 4096: 91 reads / 10.5
//     MB for the first mid-line page and 92 for every page after it — ~10 reads of that
//     is the backward probe, the other ~80 is the prefix line count, both O(file) per
//     call and neither a decode. Paging the same line with `{ startLine, startColumn }`
//     instead costs 3 reads per page (61 for 20 pages), because that pair CARRIES the
//     column: nothing is counted and nothing is probed. Use the line protocol for giant
//     lines and the byte protocol to jump.
// When false, `limit` is null and `nextLine`, `nextColumn` and `nextByte` are null:
// the window reached the end of the file.
//
// THE CURSOR NEVER SKIPS — AND NEVER STALLS (C2, F1)
// --------------------------------------------------
// A TRUNCATED entry satisfies `nextByte > the offset this window started at`, whatever
// the allowance was, AND no byte between two pages is ever lost. Both come from one rule:
// a window that still has content ALWAYS emits at least one code point, even when the
// allowance cannot pay for it, so the emission moves the offset and the cut lands on the
// NEXT character. The per-file allowance may therefore be overshot by one character's
// escaped cost — at most 6 bytes, the widest `JSON.stringify` escape (`\u00XX`) — plus
// that line's gutter when `numbered`. The batch arithmetic reserves that much per file
// before it splits the budget, which is what keeps `wireBytes <= contentBudget` true.
//
// The previous answer to the same livelock was the opposite trade: emit an EMPTY window
// and step the cursor past the offending code point. It moved the cursor and silently
// deleted what it stepped over, on every page — `maxBytes: 1` over `😀abcdef\n`
// reconstructed only "abcdef" (the 4-byte emoji and the trailing newline gone forever),
// a CRLF file at `maxBytes: 1` lost EVERY `\r\n`, `maxBytes: 2` and `3` still lost a
// leading 4-byte emoji, and `numbered: true, maxBytes: 3` on `abc\ndef\n` skipped the
// whole file. Nothing disclosed it: the empty entry carried no extra field and the footer
// just named the next cursor. Escape costs are 2 (control, quote, CR, LF), 3 (CJK), 4
// (emoji) and 6 (a `\u00XX`-escaped control), so ANY `maxBytes < 6` reached that path —
// and the schema's own `minimum: 1` invites exactly that.
//
// The trade is now paid in ROUND TRIPS, not bytes: a tiny `maxBytes` costs more pages and
// loses nothing. Measured over 1438 paged walks (10 bodies x `maxBytes` 1..size x
// `numbered` on/off x every start offset): zero stalls, zero repeated cursors, zero lost
// bytes, and every page inside `contentBudget`.
//
// One asymmetry the floor also removes: when the LAST character of a file was too
// expensive for the allowance, byte paging used to end with an ERANGE page at
// `nextByte == sizeBytes` rather than a clean `truncated: false` one, because the
// character had been stepped over and the walk arrived at EOF with it unread. The floor
// emits that character, the next read finds EOF, and the walk ends on an untruncated
// window (measured: 187 of 196 walks end clean; the other 9 are walks that STARTED at
// EOF, which is the documented ERANGE). A NUL at the start of a window is still EBINARY
// rather than emitted, because the caller pointed at the byte that says "this is not
// text".
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
//     The skip is BOUNDED (L8): it grows its probe while the bytes are continuation
//     bytes and gives up past 64 of them, because a run longer than any valid sequence
//     is not a truncated character, it is invalid data, and walking an arbitrarily long
//     run of `0x80`s from a seek into a 200 MB file would be unbounded work for an
//     answer that is "these bytes are not text" either way. Giving up reports EOF, so
//     the entry is the empty window at EOF rather than an EBINARY window that starts
//     mid-sequence.
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
// denial, BINARY CONTENT, and a `startByte` at or past the end of the file or a
// `startLine` that names a line the file does not have (ERANGE — see the two sections
// below for exactly which off-the-end offsets are errors and which are legal).
// Directory, permission and binary reads previously rejected the whole
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
// number opencode's out-of-range error exists to give.
//
// THE RESIDUAL ASYMMETRY BETWEEN THE TWO AXES, PRECISELY (M11)
// ------------------------------------------------------------
// The two axes are deliberately NOT the same rule, and saying "either axis is ERANGE"
// hides a case that is not:
//   - BYTE axis: `startByte >= sizeBytes` is ERANGE, INCLUDING the offset exactly AT
//     EOF. A byte address names a byte, and there is no byte at `sizeBytes` (D10).
//   - LINE axis: `startLine === lineCount + 1` is a legal request ONLY WHEN THE LAST
//     LINE IS TERMINATED. A newline is what creates the position one past the last line,
//     so the rule reads through that terminator, not through the count alone:
//       * `'a\nb\n'` — terminated, `lineCount: 2`: `startLine: 3` is legal and answers
//         the empty window at EOF (byte `sizeBytes`), `startLine: 4` is ERANGE;
//       * `'a\nb'` — unterminated, `lineCount: 2`: `startLine: 3` is ERANGE, because the
//         last line ends AT `sizeBytes` and there is no position after it;
//       * `'a'` — a single unterminated line, `lineCount: 1`: `startLine: 2` is ERANGE,
//         same reason.
//     `startLine > lineCount + 1` is ERANGE in both shapes. The behavior is what the
//     line protocol needs: the cursor after a terminated final line is a real position
//     the caller can stand on, and the cursor after an unterminated one is EOF, which the
//     BYTE axis already calls out of range. (The prose used to state the terminated rule
//     as if it were the whole rule; measured, `'a\nb'` + `startLine: 3` and `'a'` +
//     `startLine: 2` are both ERANGE, and both are pinned in the tests.)
//   - an EMPTY (0-byte) file has no lines to be past, so ANY `startLine` answers the
//     empty window it always answers, with `lineCount: 0` and NO error. That is not a
//     hole in the rule above: the walk cannot find the requested newline only because
//     there is no file to walk, and an ERANGE for `startLine: 2` of an empty file would
//     tell a caller its offset was out of range in a file that has nothing out of range.
//     (This is what the header claimed and the code did not do — with `sizeBytes: 0` the
//     prefix walk never ran, so `startLine >= 2` fell into the ERANGE branch.)
//
// A READABLE FILE NEVER REPORTS EIO FOR AN EMPTY ALLOWANCE
// --------------------------------------------------------
// The allocation passes used to be guarded by `allowance > 0`, so on a batch whose
// per-entry reserves ate the whole envelope (100 paths with long error messages) no
// pass ran at all, `slot.entry` stayed null, and the fallback reported `EIO` — an I/O
// failure for a file that was never read. The first pass now runs whatever the share
// is, and a 0-byte allowance is just the tightest one there is: the one-code-point floor
// (F1) answers it with ONE character, `limit: "budget"`, and a cursor that moves on —
// previously it was an empty window with the same cursor, and before THAT it was `EIO`.
// A file squeezed to nothing therefore still shows its first character instead of
// reading as empty. `EIO` is back to meaning "this handle could not be read".
//
// A `startColumn` PAST THE END OF THE LINE LANDS ON THE NEXT LINE (H5)
// --------------------------------------------------------------------
// `startColumn` is a byte offset INTO `startLine`. Ask for more bytes than that line
// holds and the skip consumes the line terminator and stops on the line after it — the
// behaviour of every version of this skip, and the one a caller walking a file with
// `{ startLine, startColumn }` depends on, so it is not an error and stays one. What WAS
// wrong is that the entry kept REPORTING the caller's `startLine` while returning the
// text of the next line, and derived `lineCount` from `startLine - 1`, which then
// under-counted by exactly the newline the skip crossed (`abcdefghij\nsecond\nthird\n`
// with `startColumn: 20` returned "second\nthird\n" as line 1 of a 2-line file). Both
// numbers now come from the position the skip actually reached, which is the same
// `prefixNewlines` the line count already needs (L10: that field was dead state, and
// this is what consumes it).
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
// BINARY DETECTION IS NOT WHOLE-FILE: NUL IS WINDOW-SCOPED, BAD UTF-8 IS CHUNK-SCOPED
// -----------------------------------------------------------------------------------
// A file is called binary by the bytes this call actually looked at, never by scanning
// the whole file. The two checks see different amounts of it, and the difference is
// visible to a caller, so it is stated rather than glossed:
//   - the NUL check is WINDOW-scoped. It fires on the character the scanner is about to
//     EMIT, so a text file with one stray NUL far past the requested window reads as
//     text for that window and as EBINARY for a wider one. Measured on a 102 400-byte file
//     with a single NUL at byte 100 001: the default first-line window returns its 64 KiB
//     with NO error, the `maxBytes: 262144` whole-file read returns EBINARY, and a
//     `startByte: 99000, maxBytes: 2048` page that walks over the NUL returns EBINARY —
//     which is the paging contract working as designed, not a surprise. It used to be
//     `text.includes('\u0000')` over the whole decoded 64 KiB chunk, which called a window
//     binary because of a byte it had never returned — the header always claimed the window
//     scope, so this is the prose winning over the implementation, not a contract change.
//   - the invalid-UTF-8 check is CHUNK-scoped: the strict decoder is handed the whole
//     read chunk before the window is cut, so a bad byte AFTER the cut but inside the
//     same 64 KiB chunk answers EBINARY for a window that does not contain it. Measured: a
//     70 000-byte file with `0xFF` at byte 50 000 refuses a `maxBytes: 10` window at the
//     start of the file, and the same read with `startByte: 60000` succeeds — the byte is
//     behind the seek, not inside the chunk. Making the first case exact means decoding per
//     character up to the cut, which is the cost the raw byte skip exists to avoid.
// The only alternative to both — scanning the entire file to classify it — would charge
// every small read for the largest file in the batch. `sizeBytes` is always reported, so
// a caller that needs a whole-file verdict can page to the end.
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
// The one extra cost `nextColumn` adds (H4) is that a byte cut needs the PHYSICAL start
// of the line it cut in. The scanner learns it for free whenever the window crossed a
// newline, whenever the seek landed on a line start, and whenever an earlier allocation
// pass of the SAME call resolved it (`ScanProgress.lineStart`); only a byte cut on a
// mid-line `startByte` seek that has not crossed one has to look backward for it. That
// probe is geometric — 64 KiB, doubling to a 1 MiB cap — so the READ COUNT is
// logarithmic in the line length (~10 reads for a 5 MiB line prefix, measured), while
// the BYTES it reads stay O(distance back to the line start): a single multi-megabyte
// line with its start 5 MiB away costs ~5 MB of raw reads per CALL, because a page is a
// new call and the inherited line start does not cross the call boundary (the tool is
// stateless, and `startByte` exists precisely so no per-file cache is needed). It
// happens on the byte-cut path only, so a `maxLines` cut, a whole-file read and a read
// whose window crossed any newline still pay nothing extra — and a caller paging a giant
// line with `{ startLine, startColumn }` pays nothing at all, because the column carries
// the position (measured: 3 reads per page versus 92 on the byte axis, whose residual is
// the prefix line count, not this probe).
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

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tool, toolText } from '../../core';
import { HarnessError } from '../../util';
import type { ToolTextEnvelope } from '../../types';
import type { PresetToolMetadata } from '../catalogue';
import { fileCancelledError, isFileCancellation } from './cancellation';

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

// ---------------------------------------------------------------------------
// THE PER-FILE I/O DEADLINE (H2)
// ---------------------------------------------------------------------------
// `open` was mode `'r'` for EVERY target: `O_RDONLY` with no `O_NONBLOCK`, so a FIFO
// with no writer blocked in the kernel and this tool never came back — no deadline, no
// cancellation, the whole batch lost. The open flags are now chosen from the target's
// mode (see `openFlagsFor`), which removes the hang for the one target class that is
// guaranteed to hang. What it does NOT remove is a filesystem that answers slowly or
// never: a hung NFS/CIFS/FUSE mount, or a device whose read stalls. `Date.now()` bounds
// each file's syscalls, and a file that runs out reports the published `ETIMEDOUT`
// per-entry while its siblings keep their content.
//
// WHY THE VALUE IS 10 SECONDS, AND WHY IT IS PER FILE: a healthy local read of a
// 256 KiB window is single-digit milliseconds, so 10 s is ~3 orders of magnitude of
// headroom before a file is declared unresponsive; per FILE (not per call) because one
// slow mount must not eat the budget of the other 99 paths in the batch, and the
// envelope already bounds the aggregate by disallowing more than 100 of them.
export const FILE_READ_IO_DEADLINE_MS = 10_000;

// Injectable time bounds, in the shape `./grep.tool.ts:626-639` already publishes for
// the same reason: they are parameters rather than reads of the constant so BOTH
// outcomes can be proven in a test without waiting for the production ceiling. The
// deadline is not mockable through `Date.now()` here the way grep's was, because the
// clock is read inside the syscall wrapper, not around a matching loop.
export type FileReadLimits = {
    // Wall-clock ceiling for one file's filesystem I/O. `0` (or any non-positive value)
    // refuses before the first syscall, which is what makes the timeout path testable
    // without a race; `Number.POSITIVE_INFINITY` disables the bound entirely.
    ioDeadlineMs: number;
};

export const DEFAULT_FILE_READ_LIMITS: FileReadLimits = { ioDeadlineMs: FILE_READ_IO_DEADLINE_MS };

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
          // continuation value reported as `nextColumn` for a giant line, so feeding
          // that pair back resumes exactly where the window stopped. It is ALWAYS
          // measured from the PHYSICAL start of the line the window begins on — also
          // when `startByte` supplied that line's offset, which used to add the column
          // to the SEEK instead and so started the window `startColumn` bytes deeper
          // than the line it was naming (H4). A column that resolves BEHIND a
          // `startByte` leaves the window at that seek offset: a position the caller
          // pinned is never moved backwards by a relative field. A column past the end
          // of the line is legal and lands on the line AFTER it — and the entry then
          // reports THAT line as its `startLine` and counts it in `lineCount`, rather
          // than repeating the number the caller named (H5).
          startColumn?: number;
          // Absolute 0-based UTF-8 byte offset to seek to, skipping the line count.
          // Feed back the `nextByte` of a previous window. An explicit `startLine`
          // is still honoured as the reported number (threading nextByte/nextLine
          // through together stays correct and skips the count entirely); WITHOUT
          // one, the true line at that offset is counted on the raw bytes and
          // reported rather than defaulting to 1. An offset that falls inside a
          // multi-byte code point is advanced to the next boundary and reported as
          // `startByteAligned`; an offset at or past EOF is an ERANGE entry (exactly
          // at EOF included — the byte axis has no "one past the end" position, which
          // the line axis deliberately does).
          startByte?: number;
          // Maximum lines to return. DEFAULT: 2000. An EXPLICIT value is an integer
          // in [1, 20000]. Whichever of `maxLines` / `maxBytes` binds first is the
          // one `limit` reports. Note that the 20000 CEILING is only reachable in a
          // file whose lines are long: `maxBytes` is charged on the ESCAPED form, so a
          // newline every line already costs the byte allowance 2 of them.
          maxLines?: number;
          // Bytes this file may take, counted on the ESCAPED/serialized form this call
          // is budgeted in (`\n` costs 2, an emoji 4) — NOT in the raw units `bytes`
          // reports, so a newline-heavy file stops at `limit: "maxBytes"` well below the
          // number named here. DEFAULT: 64 KiB (`FILE_READ_DEFAULT_MAX_BYTES`); an
          // EXPLICIT value is an integer in [1, 262144] (`FILE_READ_MAX_BYTES`, the whole
          // batch envelope). Ask for this when a 64 KiB window is genuinely not enough —
          // it is the only knob that raises a single file's window.
          maxBytes?: number;
          // Substitute U+FFFD for bytes that are not valid UTF-8 instead of reporting
          // EBINARY, so a Latin-1 log stays readable. The entry then carries
          // `lossy: true`. A NUL byte is still EBINARY either way — it is the strong
          // "not text" signal, and a lossy read of a real binary is mojibake the model
          // pays tokens to ignore. Default false.
          lossy?: boolean;
          // Put an opencode-style `123: ` gutter on the TEXT THE MODEL READS, so it
          // can cite line numbers without arithmetic. `content` stays raw, and the
          // gutter is charged against this file's allowance — which is why a numbered
          // read reports FEWER `bytes` than the model was given: the gutter is only
          // ever in the projection, never in `content`. This flag is per entry; one
          // numbered item does not number the rest of the batch (M1). Default false.
          numbered?: boolean;
      };

// A per-entry failure that is REPORTED, not thrown: anything the caller named that
// cannot be read as text. `code` lets a caller branch on it; `message` is the
// human-readable sentence, naming the requested path.
//
// THE CLOSED SET (H5). `code` is always a member of `FileReadErrorCode` below: every
// case names the requested path, gives a verb specific enough to tell the outcomes apart,
// and states what to do instead, because a model reads this and acts on it. A filesystem
// errno outside that set is NOT published verbatim (it used to be, through a naked
// `as FileReadErrorCode` cast, so `ENOTDIR`/`ELOOP`/`EMFILE` reached a caller as codes it
// was never told about, all with the same generic verb). The real errno is carried
// untouched in `rawCode` — present only when it differs from the published `code`, i.e.
// when the answer was folded into `EIO` — so nothing is lost by closing the set.
//
// THE CLOSED SET this tool publishes (the same convention `./files.tool.ts:588-613`
// keeps): `code` is a machine-readable switch target, so anything the caller could plan
// for has to be named HERE, and an errno that is not on this list is folded to `EIO`
// with the untouched errno carried in `rawCode`. A code used to escape verbatim through
// a naked `as FileReadErrorCode` cast, so `ENOTDIR`/`ELOOP`/`EMFILE`/`ENXIO`/... reached
// a model as an unpublished code with the generic verb "read failed to read" (H5).
//
// ERANGE is the one code that describes the REQUEST rather than the file: the offset it
// carried is off the end. On the BYTE axis that is `startByte >= sizeBytes`, exactly at
// EOF included, because a byte address names a byte and there is no byte at `sizeBytes`.
// On the LINE axis it is `startLine > lineCount + 1`: one past the last line is a legal
// position to stand on (the empty window at EOF), and an EMPTY file has no lines to be
// past, so every `startLine` there answers the empty window with `lineCount: 0` and no
// error at all (see "THE RESIDUAL ASYMMETRY BETWEEN THE TWO AXES" in the header).
// It is a per-entry error and not a rejected call because the same offset may be
// perfectly in range for the other paths in the batch, and because the honest answer is
// "offset out of range", which an empty window is not.
//
// The five codes H2/H5 added are the ones a filesystem really answers for the calls this
// tool makes: `ENOTDIR` (a path component is a file, or the caller appended a separator
// to a file), `ELOOP` (a symlink cycle), `ENAMETOOLONG`, `ESPIPE` (a positional read on
// a pipe/socket — see the non-seekable rule in `openFlagsFor`), `EAGAIN` (a FIFO with no
// writer), and `ETIMEDOUT` (this tool's own per-file I/O deadline).
export type FileReadErrorCode =
    | 'ENOENT'
    | 'EISDIR'
    | 'EACCES'
    | 'EPERM'
    | 'EBINARY'
    | 'ERANGE'
    | 'EAGAIN'
    | 'ENOTDIR'
    | 'ELOOP'
    | 'ENAMETOOLONG'
    | 'ESPIPE'
    | 'ETIMEDOUT'
    // CANCELLATION, and the one member that is NEVER an entry's `code`: a cancelled call
    // rejects the whole batch instead (see `bounded` and `scanSafely`, and ./cancellation.ts
    // for why `ECANCELED` and not `EIO`). It is enumerated here because this list is the
    // code space a caller switches on — `read.test.ts` proves every member is also named in
    // the model-facing description — and a caller that cannot name `ECANCELED` cannot tell a
    // cancellation from the transient `EIO` it is told to retry.
    | 'ECANCELED'
    | 'EIO';

// The published set as a value, so a test and the docs can enumerate the same list the
// union carries rather than re-pasting it (and drift is a failing assertion, not prose
// that quietly stops matching).
export const FILE_READ_ERROR_CODES: readonly FileReadErrorCode[] = [
    'ENOENT',
    'EISDIR',
    'EACCES',
    'EPERM',
    'EBINARY',
    'ERANGE',
    'EAGAIN',
    'ENOTDIR',
    'ELOOP',
    'ENAMETOOLONG',
    'ESPIPE',
    'ETIMEDOUT',
    // Call-level only: the code of a REJECTED call, never of one entry. See the union.
    'ECANCELED',
    'EIO'
];

export type FileReadEntryError = {
    code: FileReadErrorCode;
    // The errno the filesystem ACTUALLY reported, present only when it is NOT the
    // published `code` — i.e. only when the real error was folded into `EIO` (H5). A
    // caller that needs the precise reason (EMFILE vs a corrupt record) reads this; a
    // caller that branches on `code` never has to. Absent when they agree, because then
    // `code` already is the fact.
    rawCode?: string;
    message: string;
};

// One file's bounded window, in request order.
export type FileReadEntry = {
    // The absolute path that was read.
    path: string;
    // Raw UTF-8 text of the returned window. Line 1 is file line `startLine`.
    content: string;
    // 1-based line number of the first line represented by `content`. This is the
    // caller's `startLine` EXCEPT where the scanner knows better: a `startByte` seek
    // with no `startLine` reports the line actually counted at that offset (D2), and a
    // `startColumn` that ran past the end of `startLine` reports the line the window
    // really begins on (H5) — reporting the number the caller named while returning the
    // NEXT line's text is a wrong number, not a missing one. `startColumn` is applied to
    // THAT line's physical start, so the reported number and the returned text agree (H4).
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
    // 0-based UTF-8 byte offset WITHIN `nextLine`, counted from that line's PHYSICAL
    // start (0 at a line boundary), or null when not truncated. Never measured from a
    // seek: `{ startLine: nextLine, startColumn: nextColumn }` names an absolute
    // position, so repeating it walks a line of any size to its end instead of
    // re-reading the same window (H4).
    nextColumn: number | null;
    // Absolute 0-based byte offset of the FIRST UNREAD byte — literally the next byte the
    // file holds, never one that was stepped over to make progress. Null when not
    // truncated. Pass it back as `startByte` to continue without rescanning. A truncated
    // entry ALWAYS has `nextByte` greater than the offset the window started at, because a
    // window with content remaining emits at least one code point even when the allowance
    // cannot pay for it (F1): the emission moves the cursor, so the documented continuation
    // cannot loop, and `startByte = nextByte` reconstructs the file byte for byte.
    nextByte: number | null;
    // UTF-8 bytes in `content` (raw, as they exist in the file). NOT the number
    // `maxBytes` bounds, which is the ESCAPED form: a window of newlines costs the
    // allowance 2 bytes each and reports 1 here. It also excludes the `numbered` gutter,
    // which exists only in the model's copy, so a numbered read shows fewer bytes than
    // the model was given (L1).
    bytes: number;
    // Total size of the whole file in bytes, or null when the entry failed OR when the
    // filesystem's size is not a fact about readable bytes (H3). A `/proc`-style
    // pseudo-file, a FIFO, a socket or a device reports `st_size === 0` while really
    // holding content, so publishing that 0 made every resume cursor look past the end of
    // a 0-byte file (a false ERANGE) and made a counted window publish `lineCount: 0`.
    // For those targets the size is unknown and said so: no clamp, no collapse, and
    // `bytes` plus the cursors are the only sizes this entry can vouch for.
    sizeBytes: number | null;
    // Total LINES in the file — present EXACTLY when this call counted them for free
    // (the window reached EOF, or a `startLine` past the end scanned the whole file
    // anyway) and absent when knowing them would have cost a second whole-file scan.
    // An empty file reports 0 for EVERY `startLine`, which is how "past the end" and
    // "nothing here" stay distinguishable. A pseudo-file of unknown size reports a count
    // only once a read has actually reached its end; it never reports a confident 0 for
    // a window that came back full of lines (EXTRA-4).
    lineCount?: number;
    // Present ONLY when `lossy: true` was requested AND this window actually contained
    // bytes that are not valid UTF-8: the U+FFFD in `content` came from substitution,
    // not from the file. Absent for a strict read, which cannot produce any.
    //
    // It is decided by decoding the SAME bytes strictly and seeing whether that decoder
    // rejects them, not by searching the decoded text for U+FFFD — a file that legitimately
    // contains U+FFFD in valid UTF-8 used to be flagged as if this tool had replaced bytes
    // when it had replaced none (EXTRA-3).
    lossy?: true;
    // The exact wire-byte allowance THIS file was scanned against, present ONLY when the
    // batch share was SMALLER than this request's own `maxBytes` (M7). `limit: "budget"`
    // already says the shared envelope bound the window; this names the number it bound
    // it at, which is the difference between "the 40 files in my call each got 4968
    // bytes" and a guess. Absent when this file's own `maxBytes` was the smaller of the
    // two, because then `maxBytes` already is the answer.
    budgetGranted?: number;
    // Present ONLY when this path could not be read (missing, directory, permission
    // denial, binary content, an unreadable pipe/socket, a filesystem that did not answer
    // in `FILE_READ_IO_DEADLINE_MS`, or a `startByte`/`startLine` at or past EOF). The
    // entry then carries empty content, bytes 0 and an empty-window range; the call
    // itself succeeds and the other entries are unaffected. Absent for every readable
    // file. Scan-phase I/O failures are per-entry too (EXTRA-1): one unreadable file
    // cannot reject the batch and destroy its siblings' content.
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
    // The aggregate wire budget this call was subject to: the constant
    // `FILE_READ_WIRE_BUDGET` (256 KiB), i.e. the ENVELOPE, not what was splittable.
    // `budgetPool` is the part that was actually left for content once every reserve was
    // taken, and `budgetGranted` is one file's share of it (M7).
    contentBudget: number;
    // The bytes that were actually split between the readable files:
    // `contentBudget` minus the serialized scaffolding of the result and of every entry
    // (including the `note`'s worst case) minus the per-file headroom the one-code-point
    // floor can overshoot by (M7). Without this number a caller can see that its batch
    // was cut and cannot tell WHY: 40 paths of a 256 KiB envelope is a pool of ~5 KiB per
    // file, and the 64 KiB `maxBytes` it asked for is not the number it got.
    budgetPool: number;
    // Bytes of TEXT the model actually receives: the exact UTF-8 length of the prose
    // projection this result is delivered as (see "WHAT THE MODEL ACTUALLY RECEIVES"
    // above). It is NOT bounded by `wireBytes` in either direction (F4): a small window's
    // fixed per-entry fields make the JSON the larger view, while a large `numbered` window
    // puts MORE bytes in prose than in the machine view, because the model's copy pays a
    // gutter per line that the JSON never renders. What is guaranteed, and what makes the
    // projection immune to the harness's own envelope cut, is `wireBytes <= contentBudget`:
    // the machine view — the part the envelope would have to fit — always fits, so the
    // continuation fields survive and the prose is never the thing that gets cut.
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

// The file's size, as far as this tool is allowed to trust it (H3).
//
// `st_size` from `fstat` is a FACT for a regular file and a LIE for everything else the
// kernel answers here with: every `/proc` entry is a regular file with `st_size === 0`
// while really holding tens of kilobytes, and a FIFO/socket/device reports 0 whatever it
// carries. Publishing that 0 as `sizeBytes` made three separate wrong answers:
//   - `startByte >= 0` clamped every resume cursor to ERANGE ("the file is 0 bytes"),
//     even though the previous window really returned 87 bytes;
//   - `alignToCodePoint` and the prefix walk were bounded by 0, so they did nothing at
//     all, and a `startLine: 500` was silently answered from byte 0 (EXTRA-2);
//   - `lineCountFromProbe` short-circuited a full window to `lineCount: 0` (EXTRA-4).
//
// The rule is therefore: `known` is populated ONLY when the size is a fact — a regular
// file whose `st_size` is non-zero, or one whose 0 was PROVEN by a read that returned no
// bytes. Otherwise the size is unknown, the entry publishes null, no clamp may run
// against it, and `bound` is infinity, which every raw-byte walk below already stops
// correctly on `bytesRead === 0`.
type FileSize = {
    // The whole-file byte count, published as the entry's `sizeBytes`. Null = unknown.
    known: number | null;
    // The end-of-file bound a byte walk may treat as final: `known`, or infinity when
    // the size is unknown.
    bound: number;
    // The offset a walk actually found EOF at, filled in the first time a read of this
    // handle answers 0 bytes. It is what lets a pseudo-file of unknown size still settle
    // the one question that needs an absolute end — whether the last line is terminated
    // — instead of answering it from the bogus 0.
    discovered: number | null;
};

// A handle plus everything its reads are bounded by, threaded through the scanner in
// place of the bare `FileHandle`. Three reasons (H2/EXTRA-1):
//   - `seekable: false` (a FIFO, socket or device): a POSITIONAL read on those is
//     `ESPIPE`, so every read this tool makes on them has to be sequential;
//   - `deadlineAt` bounds each syscall, so a hung mount answers `ETIMEDOUT` for its own
//     entry instead of hanging the call;
//   - `signal` is the harness cancellation for the call, which a syscall wrapper is the
//     only place in this tool that can actually observe it between steps.
type FileIo = {
    handle: FileHandle;
    size: FileSize;
    // Wall-clock instant after which this file's next syscall is refused. Null = unbounded.
    deadlineAt: number | null;
    // The configured ceiling, so the ETIMEDOUT message can name the number it used.
    deadlineMs: number;
    // The call's cancellation signal, when the caller has one (a harness run does).
    signal?: AbortSignal;
    // The path as the caller named it, for the messages this file's failures produce.
    path: string;
    // False when the target is not a regular file, i.e. when `pread` is meaningless.
    seekable: boolean;
    // True for a FIFO/socket: a read there answers "no bytes right now" rather than EOF
    // (see `wouldBlock` in `scanFile`), which is the condition this tool reports as
    // `EAGAIN` instead of pretending the stream ended.
    wouldBlock: boolean;
    // Set by `ioRead` the first time ANY read on this handle returns bytes. It is the
    // only honest way to tell "this target holds nothing" from "this target holds text
    // but its `st_size` says 0" (H3/M11), and phase 1's one-byte probe is what sets it for
    // the pseudo-files where the difference matters.
    sawBytes: boolean;
    // The offset JUST PAST the last byte of the most recent read that returned bytes, and
    // that byte itself (H3/EXTRA-4). A read that ends exactly at EOF has the file's final
    // byte in hand, so "is this file's last line terminated?" is answered from what the
    // walk already saw instead of another positional read — which matters twice: it saves
    // a syscall on the common path, and a pseudo-file (`/proc`, a device) answers a random
    // positional read of its tail with whatever its generator feels like, so probing the
    // tail there can be wrong in a way the sequential walk never is.
    lastByteAt: number | null;
    lastByte: number | null;
};

// The error this tool throws at itself when a file's I/O budget runs out. It carries a
// `code` exactly like a Node filesystem error, so `classifyFailure` maps it onto the
// published `ETIMEDOUT` through the SAME path an errno takes rather than a special case
// (H2/H5).
class FileReadTimeoutError extends Error {
    readonly code = 'ETIMEDOUT';

    constructor(readonly path: string, readonly millis: number) {
        super(`${path} did not answer within ${millis}ms of filesystem I/O (ETIMEDOUT)`);
        this.name = 'FileReadTimeoutError';
    }
}

// The error this tool throws at itself when a FIFO or socket has nothing in it yet (H2).
// It carries a `code` like a Node filesystem error so `classifyFailure` maps it onto the
// published `EAGAIN` through the SAME path an errno takes: the kernel answer this is
// standing in for really is EAGAIN, and modelling it as an errno keeps the classifier
// honest about the one set of codes this tool publishes.
class WouldBlockError extends Error {
    readonly code = 'EAGAIN';

    constructor(readonly path: string) {
        super(`${path} had no bytes to read right now (EAGAIN)`);
        this.name = 'WouldBlockError';
    }
}

// A per-file (or per-path) wall-clock budget plus the cancellation signal, before a
// handle exists: the open and the stat have to be bounded too, since a FIFO hangs in the
// OPEN, not in the read.
type IoBudget = {
    deadlineAt: number | null;
    // The configured ceiling, carried so the timeout message can name the number it used.
    deadlineMs: number;
    signal?: AbortSignal;
    path: string;
};

// The cancellation this tool raises, built in ONE place because two different sites observe
// the abort (the synchronous pre-check below and the race guard) and they must not disagree
// about the code, the message, or the `details`. It is a CALL-level outcome, not a per-entry
// one: cancellation is not a fact about one path, which is the same split this tool already
// publishes for its per-file `ETIMEDOUT` (that one stays one entry). The reason the HOST
// passed to `abort()` travels as the HarnessError's `cause`, so harness.ts's documented
// preference for "the tool's own explanation" (src/harness.ts's `throwIfAborted`) still hands
// the caller its own error object. ./cancellation.ts holds the mapping and its reasoning.
const readCancellation = (budget: IoBudget): HarnessError =>
    fileCancelledError('read', `on "${budget.path}"`, {
        reason: budget.signal?.reason,
        details: { path: budget.path }
    });

// Run one filesystem operation under `budget`.
//
// The expired check is SYNCHRONIC and BEFORE the operation: an already-expired budget
// must not start a syscall it will not wait for, because that turns a deterministic
// "this file is out of budget" into a race with the operation it abandoned. It is also
// what makes the timeout path testable at `ioDeadlineMs: 0` without a timer.
//
// CANCELLATION is checked first and THROWS the coded `ECANCELED` refusal: a cancelled call
// has no consumer for a per-entry answer, and the harness discards a late result anyway
// (src/types/index.ts:2356-2357). The deadline, by contrast, is a fact about ONE file, so
// it becomes a per-entry `ETIMEDOUT` and the batch's other files keep their content.
//
// It used to throw the signal's own reason. That looked neutral and was not: the platform
// DOMException's `code` is the NUMBER 20, which is not a string errno, not in any published
// set, and not something a caller can switch on — the one code a cancelled tool call was
// guaranteed NOT to be able to classify.
const bounded = async <T>(budget: IoBudget, work: () => Promise<T>): Promise<T> => {
    if (budget.signal?.aborted === true) throw readCancellation(budget);

    const started = Date.now();

    if (budget.deadlineAt !== null && budget.deadlineAt <= started) {
        throw new FileReadTimeoutError(budget.path, budget.deadlineMs);
    }

    const operation = work();

    // Nothing to wait for: the ordinary case (no cancellation, unbounded budget) stays a
    // bare await with no timer and no listener allocated per syscall.
    if (budget.signal === undefined && budget.deadlineAt === null) return await operation;

    // The guard settles the race when the clock runs out or the call is cancelled. It is
    // built BEFORE the listeners so both attach inside the promise body, where a throw
    // while attaching cannot strand the race.
    let cleanup: () => void = () => undefined;

    const guard = new Promise<never>((_resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];

        if (budget.deadlineAt !== null) {
            const timer = setTimeout(() => reject(new FileReadTimeoutError(budget.path, budget.deadlineMs)), budget.deadlineAt - started);
            // A pending timer must not be what keeps the process alive.
            timer.unref?.();
            timers.push(timer);
        }

        const onAbort = (): void => reject(readCancellation(budget));

        if (budget.signal !== undefined) budget.signal.addEventListener('abort', onAbort, { once: true });

        cleanup = () => {
            for (const timer of timers) clearTimeout(timer);
            if (budget.signal !== undefined) budget.signal.removeEventListener('abort', onAbort);
        };
    });

    try {
        return await Promise.race([operation, guard]);
    } finally {
        cleanup();
        // A promise we stopped awaiting still settles later: a kernel read on a FIFO or a
        // hung mount cannot be interrupted, so the abandonment is expected and its late
        // rejection must not surface as an unhandled rejection.
        void operation.catch(() => undefined);
    }
};

// An empty buffer for flushing the strict twin (EXTRA-3): `decode(new Uint8Array(0),
// { stream: false })` is how a TextDecoder reports the bytes still pending from the last
// chunk, which is exactly the truncated-tail question. Allocated once, because the flush
// happens on every lossy read.
const TWIN_FLUSH = Buffer.alloc(0);

// One bounded read on a file's handle: fills `buffer[0..length)` at `position` when the
// target is seekable, and SEQUENTIALLY when it is not (a positional read on a pipe,
// socket or device is ESPIPE). Returns the number of bytes read.
//
// It is also the ONE place that records what reads proved, so no walk has to remember to
// (H3/EXTRA-4): any bytes at all flips `sawBytes`, and a zero-byte answer at a position we
// asked for is a real end of file, which becomes `size.discovered` when the size is not a
// fact. `markEof` ignores a positional read of a file whose size IS known, so this cannot
// move a byte-exact bound.
const ioRead = async (io: FileIo, buffer: Buffer, length: number, position: number | null): Promise<number> => {
    // H2: a positional read on a pipe, socket or device is ESPIPE, so the position is
    // dropped for those. It is still RECORDED below, because every caller tracks its own
    // logical cursor and that cursor is what "where this stream ended" has to mean.
    const { bytesRead } = await bounded(io, () => io.handle.read(buffer, 0, length, io.seekable ? position : null));

    if (bytesRead > 0) {
        io.sawBytes = true;

        // A read that filled up to `position + bytesRead` owns the byte at that offset minus
        // one. `endsWithNewline` only trusts the pair when the offset matches the end it is
        // being asked about, so an unrelated probe elsewhere in the file cannot corrupt it.
        if (position !== null) {
            io.lastByteAt = position + bytesRead;
            io.lastByte = buffer[bytesRead - 1];
        }
    } else if (position !== null) markEof(io, position);

    return bytesRead;
};

// Is the file's LAST byte a newline? That decides whether the final line of a whole-file
// count is its own line (see `lineCountFromProbe`).
//
// The walk usually already knows: when some read ended exactly at `end`, its last byte IS
// the file's last byte, and that answer costs nothing and cannot be wrong. Only when no
// read stopped there does this fall back to one positional read of the byte before `end`
// (`lastIsNewline`), which is what the known-size path always used (H3/EXTRA-4).
const endsWithNewline = async (io: FileIo, end: number): Promise<boolean | null> =>
    io.lastByteAt === end && io.lastByte !== null ? io.lastByte === NEWLINE_CODE : lastIsNewline(io, end);

// Is there anything left to read at `offset`? For a target with a KNOWN end this is the
// byte bound the paging tests pin, exactly as before. For one whose size is unknown it
// stays true until a read through this handle reports EOF (`discovered`), which is the
// only honest end a pseudo-file has — `st_size` of 0 is not one (H3).
const hasMore = (io: FileIo, offset: number): boolean => offset < sizeEnd(io.size);

// A size nothing has vouched for yet: the shape a failed open/stat starts with, and the
// starting point `sizeOfStat` narrows.
const unknownSize = (): FileSize => ({ known: null, bound: Number.POSITIVE_INFINITY, discovered: null });

// The size model for one stat'd target (H3).
//
// `st_size` is a FACT about readable bytes for a regular file that has any, and a LIE for
// everything else that reports 0 while holding content. Measured in Temp/orch/read/probe2.ts:
// `/proc/cpuinfo` answers `isFile()` with `st_size === 0`, a positional read at an arbitrary
// offset returns data, and a sequential pass reports 30,640 bytes. Publishing that 0 as
// `sizeBytes` is what made every `nextByte` cursor on such a file look at or past EOF, so the
// documented resume answered ERANGE for a file with tens of kilobytes in it — and it is what
// made a window full of lines publish `lineCount: 0`, because the count went through a
// `sizeBytes === 0` shortcut.
//
// The ambiguous case is a REGULAR file whose size says 0. `readFileBatch` settles it with one
// probe byte before believing either answer: bytes ⇒ the 0 was a lie, nothing ⇒ the file is
// genuinely empty and keeps `known: 0`, which is what preserves the correct answers for an
// empty file (`sizeBytes: 0`, `lineCount: 0`, and an out-of-range `startByte`).
const sizeOfStat = (info: Stats): FileSize =>
    info.isFile() && info.size > 0 ? { known: info.size, bound: info.size, discovered: null } : unknownSize();

// Does this target's OPEN block (H2)? A FIFO open with no writer waits for a writer in the
// kernel; sockets, terminals and devices can stall the same way. Regular files — the whole
// point of this tool — do not, and they keep the plain `'r'` mode so nothing about the
// byte-exact paging path changes.
const blocksInOpen = (info: Stats): boolean =>
    info.isFIFO() || info.isSocket() || info.isCharacterDevice() || info.isBlockDevice();

// The mode that removes the hang: `O_RDONLY | O_NONBLOCK`. Measured (Temp/orch/read/probe2.ts)
// on a fresh FIFO with no writer: this returns in 0 ms, while mode `'r'` (`O_RDONLY` alone)
// never returns at all. Read-only is kept because this tool never writes, and `O_NONBLOCK` is
// the only flag added — it changes nothing for a regular file, which is exactly why the
// regular-file path still opens as `'r'` and stays byte-identical to the pinned behavior.
const OPEN_NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

// Asks that question BEFORE the open, since neither the deadline nor the signal can fire
// while an un-awaited syscall owns the thread (measured: an `open(fifo, 'r')` with no writer
// never returns). The answer is only a flag choice, so an ordinary errno here — missing,
// unreadable, a directory — answers "use the ordinary mode" and lets the OPEN produce the
// same message it always produced. A deadline or a cancellation is different in kind: it
// propagates, because opening a path on a dead mount would hang exactly the call the deadline
// exists to bound.
const kindOfTarget = async (budget: IoBudget): Promise<'blocking' | 'plain'> => {
    try {
        return blocksInOpen(await bounded(budget, () => stat(budget.path))) ? 'blocking' : 'plain';
    } catch (error) {
        // Cancellation first (./cancellation.ts): a coded `ECANCELED` HarnessError carries a
        // STRING `code`, so the errno test below would read it as "an ordinary filesystem
        // answer" and quietly open a path on a cancelled call — one syscall more than a
        // cancelled call should ever pay.
        if (isFileCancellation(error)) throw error;

        if (error instanceof FileReadTimeoutError || error instanceof WouldBlockError || errorCodeOf(error) === undefined) throw error;

        return 'plain';
    }
};

// One file's place in the allocation. `entry` stays null until a pass scans it, and
// a failed open fills it immediately so the file never takes part in the split.
type ScanSlot = {
    request: NormalizedTarget;
    handle: FileIo | null;
    // The size model for this path (H3): authoritative only for a regular file whose
    // `st_size` is a fact, unknown for a pseudo-file/FIFO/socket/device.
    size: FileSize;
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
    seek?: SeekStart | 'ERANGE' | { binaryAt: number };
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
    // SAME line rather than starting a new one. `lineStart` is the ABSOLUTE offset that
    // line begins at: a resume derives its own position within it as
    // `resumeByte - lineStart`, which is what keeps paging one giant line O(window)
    // instead of looking the line start up again on every pass (H4).
    lineNumber: number;
    lineStart: number | null;
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
    // `prefixNewlines` is what `lineCount` is built from (L10: it used to be computed
    // and carried and then never read, while the count used `startLine - 1` — the same
    // number only until a `startColumn` skip crossed a newline, which is H5).
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

// The CEILING on what one code point can cost on the wire, measured against
// `JSON.stringify`: control/quote/CR/LF cost 2 escaped bytes, a CJK character 3 (raw
// UTF-8, which JSON leaves unescaped), an emoji 4 (raw UTF-8), and a control character
// rendered as a `\u00XX` literal 6. The one-code-point floor (F1) may overshoot an
// allowance by at most this much (plus one gutter line when `numbered`), so it is the
// per-file headroom the batch arithmetic reserves (see PHASE 2a in `execute`), and it is
// also the reason a `maxBytes` below 6 is legal but expensive: every such window pays one
// character and an extra round trip instead of skipping the character it could not afford.
const CODE_POINT_ESCAPE_CEILING_BYTES = 6;

// The most digits a line number this tool can print can have. `numberedChargeWidth` pads
// to the digit count of the widest line number a window can show, and no line number can
// exceed `Number.MAX_SAFE_INTEGER` (16 digits). So `numberedGutterBytes(MAX_LINE_DIGITS)`
// bounds any gutter the scanner can charge, which is what the floor's per-file reserve
// needs (it is priced before any file is scanned).
const MAX_LINE_DIGITS = 16;

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

// What a FINISHED entry actually took out of its per-file allowance, in the currency the
// scanner charges: the escaped wire bytes of the text PLUS, for a `numbered` window, the
// gutter it billed per line. The allocator's surplus and the scanner's `budget` check
// have to agree about what was spent — if the surplus ignores the gutter, a numbered file
// hands back bytes it really used, the next pass hands them to someone else, and the
// response can end up past `contentBudget` (L1). Same width the scanner billed
// (`numberedChargeWidth`), so the two numbers are identical rather than merely close.
const chargedContentBytes = (slot: ScanSlot, entry: FileReadEntry): number => {
    const text = contentWireBytes(entry.content);

    if (!slot.request.numbered) return text;

    const gutter = numberedGutterBytes(numberedChargeWidth(entry.startLine, slot.request.maxLines, slot.size.bound));

    return text + numberedLineCount(entry.content) * gutter;
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
// are nine such fields. It also covers the one OPTIONAL field a successful entry can
// carry that ENTRY_SHELL does not spell out, `budgetGranted` (`"budgetGranted":4968,`
// is 20 bytes, M7) — it appears only on a share-bound file, and the two-digit values in
// the shell leave ~170 bytes of slack here, so pricing it in the shell itself would
// charge every entry in every batch for a field almost none of them has. It does NOT
// cover an `error` object, whose message is measured exactly instead (see entryOverhead)
// — reserving a flat 400 bytes for all 100 slots would have wasted 15% of the budget on
// the common no-error path.
const ENTRY_VALUE_RESERVE = 200;

// The JSON cost of one entry's `error` object, measured on the real message. A
// failed entry is known before scanning starts, so there is no need to guess.
//
// `rawCode` (H5) is priced when the classifier attached it: a folded errno carries the
// untouched name, so the object that reaches the wire is bigger than `{ code, message }`
// and the reserve has to cover what is actually serialized.
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
const entryErrorWire = (code: string, message: string, rawCode?: string): number =>
    Buffer.byteLength(JSON.stringify(rawCode === undefined ? { error: { code, message } } : { error: { code, rawCode, message } })) - 1; // -1: the leading comma

// One entry's fixed scaffolding, in UTF-8 BYTES (see `entryErrorWire` for why the
// measurement is not `.length`): the shell, the escaped path, the value allowance,
// and the error object when this path is unreadable. The `- 2` removes the two quote
// characters `JSON.stringify` adds, because `ENTRY_SHELL` already contains them for
// the empty path; quotes are ASCII, so removing them from a byte count is exact.
const entryOverhead = (
    path: string,
    error?: { code: string; message: string; rawCode?: string }
): number =>
    ENTRY_SHELL.length + (Buffer.byteLength(JSON.stringify(path)) - 2) + ENTRY_VALUE_RESERVE +
    (error === undefined ? 0 : entryErrorWire(error.code, error.message, error.rawCode));

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
    budgetPool: 0,
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
// always the answer. `startByte` leads because it is the SEEK; the line form is offered
// alongside it only when the cut landed INSIDE a line, because that is the case where a
// caller that pages by line needs the byte-count-into-the-line as well (`nextColumn` is
// bytes into `nextLine` from its physical start — H4 — so naming it without the line
// would be the wrong half of the pair).
const projectionFooter = (entry: FileReadEntry): string => {
    const limit = entry.limit ?? 'budget';
    const column = entry.nextColumn === null || entry.nextColumn === 0;

    if (entry.nextByte === null) {
        return `  [truncated by ${limit}; ${entry.bytes} bytes returned; continue from startLine ${entry.nextLine ?? entry.endLine}${column ? '' : ` +${entry.nextColumn} bytes into it`}]`;
    }

    return `  [truncated by ${limit}; ${entry.bytes} bytes returned; continue from startByte ${entry.nextByte}${column ? '' : `, or startLine ${entry.nextLine} +${entry.nextColumn} bytes into it`}]`;
};

// The size clause of a projection header. `sizeBytes: null` means the filesystem's size
// is not a fact about readable bytes (H3) — a `/proc` entry, a FIFO, a device — and
// printing `0` there would repeat in prose the exact lie the null exists to remove in the
// machine view.
const sizeClause = (sizeBytes: number | null): string =>
    sizeBytes === null ? 'size unknown' : `size ${sizeBytes} bytes`;

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
        return `ERROR: ${entry.error.code}: ${entry.error.message} (${sizeClause(entry.sizeBytes)})`;
    }

    const cutInsideLine = entry.truncated && entry.nextColumn !== 0;

    const range =
        entry.bytes === 0 || cutInsideLine ? '' : `  lines ${entry.startLine}-${entry.endLine} of ${entry.lineCount ?? '?'}`;
    // The total, once. The `of N` inside the range clause and a standalone `N lines`
    // are the same number, and the projection is paid for in context on every read, so
    // the standalone form appears only when the range clause was suppressed.
    const count = range === '' && entry.lineCount !== undefined ? `  ${entry.lineCount} lines` : '';
    const eof = entry.truncated ? '' : '  (reached end of file)';

    return `${entry.path}${range}${count}  ${sizeClause(entry.sizeBytes)}${eof}  returned ${entry.bytes} bytes`;
};

// One entry's chunks: header, text, continuation. `bytes` sums to the entry's share of
// `modelBytes`. The two views draw on the SAME budget but neither is a subset of the
// other: the projection's fixed scaffolding is priced before the scan (`projectionReserve`
// on the slot) and its text is priced by the charge the machine view carries, while the
// machine view pays for JSON escaping the prose never renders. For a plain window that
// works out as `modelBytes <= wireBytes` (measured: no violations); for a `numbered` one
// the gutter tips it the other way, because the gutter is charged to the machine budget
// but exists only here (F4, and the header section on the two views). `numbered` is THIS
// entry's flag, not the batch's: see `renderProjection`.
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

// The gutter width a window's model copy pads to: the digits of the widest line number
// it can show. The RENDERER takes it from the lines it actually has, the SCANNER takes
// it from `numberedChargeWidth` (an upper bound, because it bills a line before it knows
// how far the window will run). Both go through `numberedGutterBytes`, because the
// invariant this pair has to hold is "the gutter CHARGED >= the gutter RENDERED" —
// billing `String(lineNumber).length` per line, as this used to, under-charged every line
// of a window that later crossed a digit boundary (995 -> 1000, 9995 -> 10000) by the
// digit it grew, and an under-charged gutter is the one gap that could put prose above the
// allowance the machine view paid for (L1). Note what that invariant does NOT claim: it
// bounds the prose against the CHARGE, not `modelBytes` against `wireBytes`. The charge
// includes bytes that never appear in the serialized entry, so a large numbered window
// has `modelBytes > wireBytes` (F4) while `wireBytes <= contentBudget` and the projection
// stays inside the harness cap.
const numberColumnWidth = (startLine: number, endLine: number): number =>
    String(Math.max(startLine, endLine, 1)).length;

// What one numbered line's gutter costs: the padded number plus `": "`.
const numberedGutterBytes = (width: number): number => width + 2;

// The width the SCANNER bills a numbered window at: the widest line number its model copy
// can ever print. A window emits at most `maxLines` lines, and it cannot emit more lines
// than the file has bytes (every line is at least one byte), so the last line it shows is
// at most `startLine + min(maxLines, sizeBytes) - 1`. Both clamps matter: the first is what
// keeps the bound from running away on a 6-line file read with the 2000-line default, and
// the second is what keeps it honest when the caller's `startLine` is a LIE — a window
// starting at line 999 999 999 of a 6-byte file really does print 10-digit gutters, and a
// bound that stopped at `sizeBytes` would bill 9 and render 10. It is an UPPER bound on
// what the renderer pads to, so the charge can only ever be generous, and the cost of that
// generosity is a few bytes per line of window — never an envelope the response escapes.
// A pseudo-file passes `bound: Infinity` (H3), where the byte clamp cannot bind at all
// and only the line cap bounds the window: an upper bound either way, and never the
// under-charge an unknown size would produce if the bogus 0 were used instead.
const numberedChargeWidth = (startLine: number, maxLines: number, sizeBytes: number): number =>
    String(startLine + Math.min(Math.max(maxLines, 1), Math.max(sizeBytes, 1)) - 1).length;// How many lines a window's model copy puts a gutter on. `numberProjectionText`'s rule:
// every line except the empty piece after a trailing newline (a line break is not a
// line). Used to bill a numbered file's leftover share honestly (see the allocator).
const numberedLineCount = (content: string): number =>
    content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);

// The model's copy of one entry, optionally numbered (see `numbered` on the request).
// Numbering is a RENDERING choice and applies only here: `content` stays raw, so the
// machine view of a window is identical whether or not the model's copy is numbered.
const numberProjectionText = (entry: FileReadEntry, text: string): string => {
    const width = numberColumnWidth(entry.startLine, entry.endLine);
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
//
// `numbered` is ONE FLAG PER ENTRY, index-aligned with `files` the same way the note
// pairs entries with the caps their requests applied (`files` is `slots.map(...)`, over
// `requested`, so the order is the contract). It used to be a single batch-wide flag
// computed as `requested.some(...)`, which put a gutter on every file in a call because
// one of them asked for one — and a gutter is charged, so it also shrank the windows of
// files whose owners never asked for it (M1).
const renderProjection = (files: readonly FileReadEntry[], numbered: readonly boolean[]): string =>
    files
        .flatMap((entry, index) => projectionChunks(entry, numbered[index] === true))
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
// by <reason>; N bytes returned; continue from startByte B, or startLine L +C bytes into
// it]`, ~163 with every number at MAX_SAFE_INTEGER's 16 digits). Both are deliberately
// generous: this reserve backs the text the MODEL actually receives, and an
// under-reserved projection is the one case where `modelBytes` could exceed
// `contentBudget` and the harness would cut prose the machine view still has.
//
// There is no gutter term here on purpose. A `numbered` window's gutter is CONTENT for
// budget purposes — the scanner bills it inside the same per-file allowance as the text
// (`numberedChargeWidth`), at a width that is never SMALLER than the one the renderer
// pads to — so reserving it again here would charge the model's copy twice.
const PROJECTION_HEADER_MARGIN = 128;
const PROJECTION_CONTINUATION_MARGIN = 176;

const projectionOverhead = (
    path: string,
    // `rawCode` is accepted because a folded error carries it (H5), but the PROJECTION
    // line prints only the published code and the message (see `projectionHeader`), so it
    // is deliberately not priced here.
    error?: { code: string; message: string; rawCode?: string }
): number => {
    const header = Buffer.byteLength(JSON.stringify(path), 'utf8');

    if (error === undefined) return header + PROJECTION_HEADER_MARGIN;

    // The widest size clause the header can carry (`size unknown`, for an entry whose
    // filesystem size is not a fact — H3), priced rather than the known-size form.
    const line = `ERROR: ${error.code}: ${error.message} (${sizeClause(null)})\n`;

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
        // A pseudo-file of unknown size can never be named by the note: the clause quotes
        // `sizeBytes`, which is exactly the number this file does not have (H3).
        .filter((slot) => slot.entry === null && slot.size.known !== null && slot.size.known >= FILE_READ_NOTE_MIN_BYTES)
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
//
// `rawCode` is only ever set by `classifyFailure`, and only when the published `code`
// is a fold (H5) — the key is then present so a JSON round trip cannot drop it.
// `budgetGranted` is absent: an entry that never scanned was never granted an
// allowance, and publishing 0 would claim the allocator starved it (M7).
const failedEntry = (
    request: NormalizedTarget,
    code: FileReadErrorCode,
    message: string,
    sizeBytes: number | null = null,
    rawCode?: string
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
    error: rawCode === undefined ? { code, message } : { code, rawCode, message }
});

// Close best-effort, ignoring a handle that is already closed or already past this file's
// budget. Used on every failure path so a batch never leaks an open descriptor.
//
// The close is BOUNDED like every other syscall on this file: a descriptor on a hung mount
// can block in `close` too, and refusing it there leaks one descriptor until the process
// exits — strictly better than hanging the batch a second time after already reporting it
// (H2). The refusal lands in the catch below, which is why it stays quiet.
const closeQuietly = async (files: Iterable<FileIo>): Promise<void> => {
    for (const io of files) {
        try {
            await bounded(io, () => io.handle.close());
        } catch {
            // Nothing actionable: the call is already failing, the budget has run out, or
            // the scanner's own finally block closed it.
        }
    }
};

// The binary rejection shared by the NUL and invalid-UTF-8 paths so the message
// (and therefore a test's expectation) cannot drift between them.
const binaryMessage = (path: string): string =>
    `read refused "${path}": the file contains binary data (NUL bytes or invalid UTF-8). read reads UTF-8 text only.`;

// The same rejection when the tool knows WHERE it gave up (M1). A seek into a run of
// UTF-8 continuation bytes longer than any real code point is invalid data, and the
// honest answer names the offset the caller pointed at rather than answering with an
// empty window that says nothing went wrong.
const binaryAtMessage = (path: string, offset: number): string =>
    `read refused "${path}": byte ${offset} is inside a run of UTF-8 continuation bytes longer than any code point, so no whole character starts there (invalid UTF-8). read reads UTF-8 text only; seek to a byte before the run, or to one after it.`;

// The rejection for a strict decode that actually SAW the bad bytes (the window landed on
// them rather than merely seeking next to them). It names the first byte the failing read
// covered, so the caller can seek past it, and points at `lossy` as the way to see the
// window anyway.
const binaryDecodeMessage = (path: string, offset: number): string =>
    `read refused "${path}": the bytes from ${offset} on in this window are not valid UTF-8. read reads UTF-8 text only; pass lossy: true to get the window with U+FFFD for the bytes that cannot decode, or seek past ${offset}.`;

// A seek the target cannot honour (H2). A pipe, socket or terminal has no file offset —
// a positional read there is ESPIPE — so `startByte` is not a meaningless value to ignore,
// it is a request that cannot be answered.
const unseekableMessage = (path: string): string =>
    `read cannot seek "${path}": it is not a regular file (a pipe, socket or device has no file offset, so startByte cannot be answered there — ESPIPE). Read it without startByte, which streams it from wherever it currently is.`;

// A FIFO/socket with nothing in it (H2). Opening one non-blocking is what stops the call
// hanging forever in the kernel; the price is that the empty pipe answers "no bytes right
// now", and the entry has to say that instead of claiming the stream ended.
const wouldBlockMessage = (path: string): string =>
    `read found no bytes to read in "${path}": nothing is writing to it right now, so the read had nothing to take (EAGAIN). A FIFO only carries what a writer sends: start the writer, or read a regular file. This is NOT "the file is empty" — retry once there is a writer.`;

// The deadline message (H2), produced by classifyFailure from FileReadTimeoutError.
const timeoutMessage = (path: string, millis: number): string =>
    `read gave up on "${path}" after ${millis}ms of filesystem I/O (ETIMEDOUT): the device or mount holding it did not answer in time, so this file's window is empty and the other paths in the call are unaffected. Try the path again, or read a file on a responsive mount.`;

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
//
// `lineCount` is null when the target gave no proven end to count against: a pseudo-file
// whose `st_size` is not a fact, or a stream with no offset to probe (H3). Saying "the
// file ends before that line" is still the actionable answer; inventing a number is not.
const rangeLineMessage = (path: string, startLine: number, lineCount: number | null): string =>
    lineCount === null
        ? `read could not start "${path}" at line ${startLine}: the data ends before that line (ERANGE). This target reports no trustworthy size, so the line total is not knowable in one pass. An empty window is NOT "this file is empty"; drop startLine to read from the beginning, or treat this as the end of the file.`
        : `read could not start "${path}" at line ${startLine}: the file has ${lineCount} lines, so that line does not exist (ERANGE). An empty window is NOT "this file is empty"; drop startLine to read from the beginning, or treat this as the end of the file.`;

// Render an unknown value the way a caller can tell it apart from another value:
// `received 5` is the same sentence for the number 5 and the string `"5"`, and a model
// that quoted its number gets no clue from it (L11). `JSON.stringify` is exactly that
// distinction — strings quoted, numbers bare, `null`/`true` bare — and it never throws on
// the shapes a tool call can carry. It DOES throw on a circular object and returns
// `undefined` for a function or symbol, so those fall back to `String`, which is at least
// type-named. `undefined` itself stringifies to `undefined` (the literal text), which is
// what the callers of this helper want printed.
const receivedText = (value: unknown): string => {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    } catch {
        return String(value);
    }
};

// Validate one non-negative integer range field. `undefined` takes the default;
// anything else must be an integer in [minimum, maximum].
//
// The value is echoed with `receivedText`, not `String` (L11): `received 5` prints the
// same for the number 5 and the string "5", so a caller that sent a quoted number could
// not see its own mistake.
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
            `read ${field} must be an integer between ${minimum} and ${maximum}; received ${receivedText(value)}.`
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
            `read maxLines must be an integer between 1 and ${FILE_READ_MAX_LINES}, or omitted for the ${FILE_READ_DEFAULT_MAX_LINES}-line default; received ${receivedText(value)}.`
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
            `read maxBytes must be an integer between 1 and ${FILE_READ_MAX_BYTES}, or omitted for the ${FILE_READ_DEFAULT_MAX_BYTES}-byte default; received ${receivedText(value)}.`
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

    throw new HarnessError(`read ${field} must be a boolean or omitted; received ${receivedText(value)}.`);
};

// `startByte` is the only nullable range field: absent means "count lines", present
// means "seek here". It must be a non-negative integer when supplied.
const readByte = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;

    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new HarnessError(`read startByte must be a non-negative integer or null; received ${receivedText(value)}.`);
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

// The fields one `paths` range object may name. Enforced at runtime as well as in the
// schema, for the reason ./write.tool.ts and ./edit.tool.ts give in full: the schema says
// `additionalProperties: false`, but the DIRECT call path hands `execute` its argument
// untouched (../../core/tool.ts), and the bare-ARRAY form of `paths` skips the
// `parameters.paths` wrapper the harness validates entirely. So `[{ path, offset: 3 }]`, or
// a typo'd `maxByte` / `maxLine` / `maxlines`, used to be served the DEFAULT window with no
// signal at all: the caller believed it had bounded the read, and the entry reported a
// window it did not ask for. Naming the key and the accepted set turns that into one round
// trip. Mirrors the wording of `write files entries do not accept ...` and
// `edit edits entries do not accept ...`.
const FILE_READ_FIELDS = [
    'path',
    'startLine',
    'startColumn',
    'startByte',
    'maxLines',
    'maxBytes',
    'lossy',
    'numbered'
] as const;

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

        // Unknown fields are REFUSED, not destructured away (see `FILE_READ_FIELDS` above).
        // Checked before the field types on purpose: a misspelled `path` alongside a typo'd
        // knob is the case where "there is no path" is the least useful answer.
        for (const key of Object.keys(target as Record<string, unknown>)) {
            if (!(FILE_READ_FIELDS as readonly string[]).includes(key)) {
                throw new HarnessError(
                    `read paths entries do not accept "${key}". Allowed fields: ${FILE_READ_FIELDS.join(', ')}.`
                );
            }
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
    // line actually counted at that offset (D2), and for a `startColumn` skip that ran
    // past the end of the requested line, where it is the line actually returned (H5).
    startLine: number;
    maxLines: number;
    budget: number;
    lineNumber: number; // 1-based line currently being scanned
    // The ABSOLUTE offset where the line currently being scanned begins, or null while
    // that is not yet known. Null happens in exactly one situation: a `startByte` seek
    // that landed mid-line, before this window has crossed any newline. `nextColumn`
    // needs it (it is counted from the physical line start, H4), so a byte cut that is
    // still sitting on that first line looks it up with one backward `lastIndexOf`;
    // every other cut already knows it for free.
    lineStart: number | null;
    // Bytes one `numbered` line's gutter costs this window, at the width the renderer
    // pads to (see `numberedChargeWidth`). Charged here, in the same currency as the
    // text, because the model receives the gutter as part of the text.
    gutterBytes: number;
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
    // The continuation column, counted from the PHYSICAL start of `nextLine`. `stopAt`
    // leaves it null and `scanFile` finalizes it once, after the scan: at the moment of
    // the cut the scanner may not know where the cut's line starts (a mid-line seek),
    // and only the post-scan step can look it up without paying for it per character.
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
    // billed, so a line is charged once no matter how many chunks it spans. The width
    // billed is `state.gutterBytes`, fixed for the whole window (the renderer pads to one
    // width too), and it is an upper bound on what the renderer will print.
    numbered: boolean;
    gutterCharged: boolean;
    // THE ONE-CODE-POINT FLOOR (F1) — armed while this window has emitted nothing, and
    // disarmed by the first emission. A byte-governor check that fails while it is armed
    // does NOT cut: the character is emitted anyway, the window overshoots its allowance by
    // that one character's escaped cost (plus its gutter when `numbered`), and the cut moves
    // to the following character.
    //
    // Without it, an allowance below the escape cost of the character at the window start
    // produced an EMPTY truncated window, and an empty window cannot advance its cursor
    // without skipping bytes. Measured at `maxBytes: 1`: `😀abcdef\n` lost the 4-byte emoji
    // and the trailing newline on every page, a CRLF file lost EVERY `\r\n`, and
    // `numbered: true, maxBytes: 3` on `abc\ndef\n` skipped the whole file. The costs are
    // asymmetric and large — control/quote/CR/LF cost 2 escaped bytes, a CJK character 3, an
    // emoji 4, a `\u00XX`-escaped control 6 — so ANY `maxBytes < 6` reached that path, and
    // the schema's own `minimum: 1` invites it. The floor cannot stall (an emission always
    // advances `scanOffset`) and cannot lose a byte, which is what makes
    // `startByte = nextByte` byte-exact paging. `execute` reserves this overshoot per file
    // when it splits the batch budget, which is what keeps `wireBytes <= contentBudget`.
    emitFloor: boolean;
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
//
// There is no `column` argument: `nextColumn` is a property of the LINE the cut landed
// on, not of this moment, and the scanner frequently does not know where that line
// starts yet. `scanFile` resolves it once, after the loop, where the lookup can be
// awaited and paid for only by the cuts that need it (H4).
const stopAt = (state: ScanState, line: number, byBytes: boolean): true => {
    state.truncated = true;
    state.limit = byBytes ? state.byteCutLimit : 'maxLines';
    state.nextLine = line;
    state.nextColumn = null;
    state.nextByte = state.scanOffset;
    state.cutByBudget = byBytes && state.byteCutLimit === 'budget';
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
// WHERE BINARY REJECTION LIVES IN THIS LOOP
// -----------------------------------------
// There is no whole-chunk `text.includes('\u0000')` any more (decision 10). The NUL
// rejection fires on the CHARACTER the window is about to emit, which is what the header
// has always promised ("a file whose NUL sits past the requested window reads as TEXT for
// that window"): the old check looked at the entire decoded 64 KiB chunk before the
// window was cut, so it refused a window because of a byte it had never returned. A NUL
// is never `isPlainCode`, so every one of them reaches the per-character branch below, and
// the throw sits AFTER the allowance check — a NUL the window cannot afford is beyond the
// cut, and beyond the cut is not the caller's problem. The cost is one integer compare per
// character in a loop that already does several; the native scan it replaces never ran on
// the bytes the window had already decided to stop before.
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
    const length = text.length;
    let index = 0;

    while (index < length) {
        // 1. Line limit already reached: any further character means more content.
        if (state.limitReached) {
            return stopAt(state, state.lineNumber, false);
        }

        // 1b. Bill this line's numbering gutter before any of its characters, so the
        // window the model sees is the window the allowance paid for. A resume bills
        // the continuation of a giant line too: in the model's copy it is a numbered
        // line of its own entry, gutter and all. The width is the renderer's upper
        // bound, so this can never under-bill the gutter the model ends up reading (L1).
        // A gutter that does not fit is charged ANYWAY while the floor is armed (F1):
        // refusing the gutter would refuse the line with it, and a window that emits
        // nothing has no cursor that can move without skipping bytes.
        if (state.numbered && !state.gutterCharged) {
            if (state.wireBytes + state.gutterBytes > state.budget && !state.emitFloor) {
                return stopAt(state, state.lineNumber, true);
            }

            state.wireBytes += state.gutterBytes;
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
                if (room <= 0) {
                    // The floor (F1): an empty window that emits nothing cannot move its
                    // cursor without skipping a byte, so it takes exactly one character of
                    // this run — a plain run costs 1 wire byte per character, so the
                    // overshoot is 1 — and cuts in front of the next one.
                    if (state.emitFloor) {
                        state.content += text[index];
                        state.contentBytes += 1;
                        state.wireBytes += 1;
                        state.scanOffset += 1;
                        state.endLine = state.lineNumber;
                        state.emitFloor = false;

                        return stopAt(state, state.lineNumber, true);
                    }

                    return stopAt(state, state.lineNumber, true);
                }

                state.content += text.slice(index, index + room);
                state.contentBytes += room;
                state.wireBytes += room;
                state.scanOffset += room;
                state.endLine = state.lineNumber;
                state.emitFloor = false;

                return stopAt(state, state.lineNumber, true);
            }

            state.content += text.slice(index, end);
            state.contentBytes += runLength;
            state.wireBytes += runLength;
            state.scanOffset += runLength;
            state.endLine = state.lineNumber;
            state.emitFloor = false;
            index = end;
            continue;
        }

        // 4. A character that needs care: escapes, newlines, anything multi-byte.
        const point = text.codePointAt(index) as number;
        const units = point < 0x10000 ? 1 : 2;
        const charBytes = utf8Length(point);
        const wireCost = escapedCharBytes(point, charBytes);

        // The allowance check is against the ESCAPED cost. A newline counts too: it
        // is content, and it costs two bytes once escaped. While the floor is armed
        // nothing has been emitted yet, and an empty truncated window is the shape that
        // either stalls the continuation or skips the character (F1), so the character
        // that does not fit is taken anyway and the cut moves to the next one.
        if (state.wireBytes + wireCost > state.budget && !state.emitFloor) {
            return stopAt(state, state.lineNumber, true);
        }

        // NUL is the cheapest strong signal that the file is not text, and it stays
        // fatal in BOTH decode modes: a lossy read is for mojibake-prone legacy text,
        // not for bytes that say "I am a binary". (Invalid UTF-8 is what `lossy` exists
        // for, and the decoder itself handles that — see scanFile.) It is checked here,
        // after the allowance test, so that only a NUL the window would have RETURNED
        // rejects it — the window-scoped contract the header describes. The floor (F1)
        // makes a NUL at the start of even a 1-byte window "a character this window would
        // have returned", which is exactly why `maxBytes: 1` on such a file is EBINARY
        // rather than an empty window.
        if (point === 0) {
            throw new HarnessError(binaryMessage(state.target));
        }

        state.content += units === 1 ? text[index] : text.slice(index, index + 2);
        state.contentBytes += charBytes;
        state.wireBytes += wireCost;
        state.scanOffset += charBytes;
        state.emitFloor = false;
        // `endLine` advances with every emitted character, so a partial giant line
        // reports the line it was cut inside.
        state.endLine = state.lineNumber;

        if (point === NEWLINE_CODE) {
            state.emittedLines += 1;
            state.windowNewlines += 1;
            state.lineNumber += 1;
            // The next line begins at the offset the scanner has just reached. This is
            // how `nextColumn` knows where a line starts without ever searching for it:
            // a window that crossed a newline has seen its start (H4).
            state.lineStart = state.scanOffset;
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

// A UTF-8 code point is at most 4 bytes, so at most 3 CONTINUATION bytes can follow a
// lead byte. A longer run of them is not a truncated character — it is invalid data —
// and walking an unbounded run of `0x80`s from a seek into a 200 MB file would be
// unbounded work for an answer that is "these bytes are not text" either way. So the
// probe grows 4 -> 16 -> 64 and then gives up (L8).
//
// WHAT "giving up" answers is the part M1 fixed. It used to report EOF, the same value
// the legitimate end-of-file exits report, and the caller got `content: ""`,
// `truncated: false` and no error for a window the caller had pointed straight at a
// broken byte sequence: right to bound the work, wrong to stay silent about it. The
// bounded probe now reports the three outcomes separately (see `CodePointAlignment`), so
// a run of continuation bytes longer than any code point is `EBINARY` naming the offset,
// while `bytesRead === 0`, a short read, and an offset at or past a KNOWN end stay the
// plain EOF they always were.
const MAX_CODE_POINT_BYTES = 4;
const MAX_CONTINUATION_PROBE = 64;

// The three things the alignment probe can discover, and which answer each one deserves.
type CodePointAlignment =
    // A lead byte at this offset: the boundary the caller can decode from.
    | { kind: 'aligned'; offset: number }
    // Nothing is readable from here because the file ends: the empty window at EOF,
    // which is NOT an out-of-range error (the offset was in range).
    | { kind: 'eof' }
    // `MAX_CONTINUATION_PROBE` continuation bytes in a row: not UTF-8 at all, at `offset`
    // (the caller's own seek point). Reported as EBINARY (M1).
    | { kind: 'invalid'; offset: number };

// Read one byte at `offset` and, if it is a UTF-8 continuation byte (`0b10xxxxxx`),
// advance until a lead byte or EOF. A caller that hands back a hand-computed or
// byte-oriented `startByte` can land inside a multi-byte character; decoding from
// there would see a lone continuation byte, call the file binary, and report EBINARY
// for ordinary UTF-8 (D1). Advancing is the honest reading of "start here": the next
// WHOLE character is the first thing the caller can actually see.
const alignToCodePoint = async (io: FileIo, offset: number): Promise<CodePointAlignment> => {
    if (offset === 0) return { kind: 'aligned', offset: 0 };

    // `io.size.bound` is `Infinity` when the size is not a fact (H3), so this only fires
    // when the end is really known; for a pseudo-file the probe below settles it with an
    // actual read instead.
    const sizeBytes = io.size.bound;

    if (offset >= sizeBytes) return { kind: 'eof' };

    for (let want = MAX_CODE_POINT_BYTES; want <= MAX_CONTINUATION_PROBE; want *= 4) {
        // Never read past the end of the file, so `bytesRead < length` below means
        // "the probe hit EOF" rather than "the filesystem gave me less than I asked for".
        const length = Math.min(want, sizeBytes - offset);
        const probe = Buffer.allocUnsafe(length);
        const bytesRead = await ioRead(io, probe, length, offset);
        if (bytesRead === 0) return { kind: 'eof' };

        let at = 0;
        while (at < bytesRead && (probe[at]! & 0xc0) === 0x80) at += 1;

        // A lead byte inside the probe: that is the boundary the caller can decode from.
        if (at < bytesRead) return { kind: 'aligned', offset: offset + at };
        // The whole probe was continuation bytes. If the read came up short, the run
        // reaches the end of the file and there is nothing readable from here.
        if (bytesRead < length) return { kind: 'eof' };
    }

    // More `MAX_CONTINUATION_PROBE` continuation bytes in a row: invalid data, and the
    // answer is EBINARY at the offset the caller named (M1 — this used to be the silent
    // EOF exit below).
    return { kind: 'invalid', offset };
};

// The ABSOLUTE offset of the physical start of the line containing `offset`: the byte
// after the LAST newline before it, or 0 when there is none. This is what makes
// `nextColumn` mean one thing everywhere (H4): a byte cut in a window that started
// mid-line has to know where that line really begins, and the only way to know it
// without carrying state per character is to look backward once, on the cut path only.
//
// WHY THE PROBE GROWS GEOMETRICALLY (F2)
// --------------------------------------
// A fixed 64 KiB probe is one `handle.read` per 64 KiB of line, so a megabyte-scale
// single line costs megabytes of reads PER CALL: measured on a 6 MiB single-line file,
// the first mid-line page cost 163 reads / 10.5 MB, ~82 reads of them this walk alone,
// and every further page cost the same ~164 reads — a page is a NEW call, and the
// inherited `lineStart` (see `ScanProgress`) only survives the allocation passes INSIDE
// one call. Doubling from 64 KiB to a 1 MiB cap covers the same distance in logarithmic
// steps — a handful of reads for a multi-megabyte line — at the cost of reading past the
// newline by up to one probe, which is discarded. What is still linear is the BYTES
// walked, which is O(distance back to the line start) and unavoidable when the caller
// asked to resume mid-line by BYTE offset; the header's cost model says exactly that,
// and points at the line protocol (`startLine`/`startColumn`) for the O(window) paging.
const LINE_START_PROBE_MIN = 64 * 1024;
const LINE_START_PROBE_MAX = 1024 * 1024;

// Records where a walk actually found EOF (H3). Only meaningful for a target whose size
// is not a fact: it turns "infinity" back into a concrete offset the line-count probe can
// stand on, so an unknown-size file still settles whether its last line is terminated
// rather than answering that from the bogus `st_size` of 0.
const markEof = (io: FileIo, offset: number): void => {
    if (io.size.known !== null) return;
    if (io.size.discovered === null || offset < io.size.discovered) io.size.discovered = offset;
};

// The end this call may treat as final: the size when it is a fact, the offset a walk
// discovered EOF at otherwise, and infinity while neither is known yet.
const sizeEnd = (size: FileSize): number => size.known ?? size.discovered ?? Number.POSITIVE_INFINITY;

const lineStartOf = async (io: FileIo, offset: number): Promise<number> => {
    if (offset <= 0) return 0;

    let end = offset;
    // The step this walk is taking, doubled each round up to the cap. Local on purpose:
    // two concurrent reads of two files must not inflate each other's probe.
    let step = LINE_START_PROBE_MIN;

    while (end > 0) {
        const length = Math.min(step, end);
        const start = end - length;
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = await ioRead(io, chunk, length, start);

        if (bytesRead === 0) break;

        // The stale-tail rule again (see `countNewlines`): only what this read filled is
        // trustworthy. `lastIndexOf` picks the NEWEST newline in the window, which is the
        // terminator of the line the offset sits on.
        const at = chunk.subarray(0, bytesRead).lastIndexOf(NEWLINE_BYTE);
        if (at !== -1) return start + at + 1;

        // A short read means the file ended below `start`, so there is nothing further to
        // walk. Defensive: `end` never exceeds the caller's offset, which is inside the
        // file, but a filesystem that returns less than asked for must not send this walk
        // looking at bytes that do not exist.
        if (bytesRead < length) {
            markEof(io, start + bytesRead);
            break;
        }

        end = start;
        if (step < LINE_START_PROBE_MAX) step = Math.min(step * 2, LINE_START_PROBE_MAX);
    }

    return 0;
};

// How many newlines lie in the byte range [from, to). A raw-byte `indexOf` scan: no
// decode, no allocation per character, and exactly equivalent because 0x0a cannot
// appear inside a multi-byte UTF-8 sequence.
const countNewlines = async (io: FileIo, from: number, to: number): Promise<number> => {
    if (to <= from) return 0;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let count = 0;
    let cursor = from;

    while (cursor < to) {
        // `want` never crosses `to`, so every byte this read returns is in range.
        const want = Math.min(buffer.length, to - cursor);
        const bytesRead = await ioRead(io, buffer, want, cursor);
        if (bytesRead === 0) {
            // `to` was infinity (an unknown-size file, H3): this is where its end is.
            markEof(io, cursor);
            break;
        }

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
const firstNewline = async (io: FileIo, from: number, to: number): Promise<number> => {
    if (to <= from) return -1;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let cursor = from;

    while (cursor < to) {
        const want = Math.min(buffer.length, to - cursor);
        const bytesRead = await ioRead(io, buffer, want, cursor);
        if (bytesRead === 0) {
            markEof(io, cursor);
            break;
        }

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
    // The physical start of `line`, when a seek already knows it for free (H4). Null
    // means "not known", which is the normal answer for a byte seek: the line a seek
    // offset sits on can start anywhere behind it, and looking it up costs a backward
    // scan that only a byte cut ever needs. `offset: 0` is the one free case — byte 0 IS
    // the start of line 1 — and it is worth carrying because a whole-file read and every
    // `startLine` read start there.
    lineStart: number | null;
};

// Resolve `startByte` into a place to start DECODING. Nothing here counts characters:
// a seek is a byte read plus, at worst, one raw newline count.
const resolveSeek = async (
    io: FileIo,
    request: NormalizedTarget
): Promise<SeekStart | 'ERANGE' | { binaryAt: number }> => {
    const given = request.startByte;
    if (given === null) return { offset: 0, line: 1, aligned: null, counted: true, lineStart: 0 };

    // D10: a seek at or past EOF is answered as an ERANGE entry. That is normally
    // settled in phase 1 from the stat, so this is the defensive path; the case that
    // genuinely cannot be known that early is below, where ALIGNMENT walks off the end.
    // A size that is not known cannot say so (H3), and a non-seekable target never
    // reaches this function at all (H2: phase 1 rejects a `startByte` there with ESPIPE).
    const size = io.size;
    if (size.known !== null && given >= size.bound) return 'ERANGE';

    const alignment = await alignToCodePoint(io, given);

    // M1: the probe walked out of the 4-byte run it is willing to chase and the bytes are
    // still not a character. That used to be reported as this window's EOF, which for a
    // mid-file seek meant an empty `truncated: false` entry with no error. It is now a
    // per-entry EBINARY naming the offset, returned as an outcome for `scanSafely` to
    // publish rather than thrown, so the rest of the batch survives it (EXTRA-1).
    if (alignment.kind === 'invalid') return { binaryAt: alignment.offset };

    // The offset was inside the file but pointed at a continuation byte, and walking
    // forward to the next whole character ran past the end: the last character of the
    // file started before this offset, so there is nothing readable from here. That is
    // an empty window, NOT "offset out of range" — the offset was in range — and not an
    // error at all, because a caller paging through the file has reached its end.
    //
    // `kind: 'eof'` against an UNKNOWN size can only mean a read answered zero bytes,
    // which IS the real end of a pseudo-file (H3), so `sizeEnd` below stands on either a
    // stat or a discovered EOF and never on the bogus 0.
    if (alignment.kind === 'eof') {
        const end = sizeEnd(size);

        return {
            offset: end,
            line: 1 + (await countNewlines(io, 0, end)),
            // The alignment did not move the cursor onto a readable character, so nothing
            // is published as "aligned" — the same answer this branch gave before M1.
            aligned: null,
            counted: true,
            lineStart: null
        };
    }

    const { offset: aligned } = alignment;

    // The line at the seek point is the caller's word when it named one — threading
    // `nextByte` and `nextLine` back together is then free, with no count at all —
    // and otherwise the truth, counted on raw bytes rather than defaulted to 1 (D2).
    if (request.startLineGiven) {
        return {
            offset: aligned,
            line: request.startLine,
            aligned: aligned === given ? null : aligned,
            counted: false,
            lineStart: null
        };
    }

    return {
        offset: aligned,
        line: 1 + (await countNewlines(io, 0, aligned)),
        aligned: aligned === given ? null : aligned,
        counted: true,
        lineStart: null
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
    // Set when the prefix walk could not find `linesToSkip` newlines before EOF, and
    // there WAS a file to walk (M11: an empty file has no lines to be past, so its
    // caller gets the empty window it always got, not an out-of-range error).
    pastEof: boolean;
    // Every newline in the file, when the walk went all the way to EOF (it must have,
    // for `pastEof` to be set). Meaningless otherwise.
    newlinesSeen: number;
    // The PHYSICAL start of `line`, when this skip landed on it and therefore knows it
    // for free: a `startLine` skip stops exactly one byte past a newline, and a
    // `startColumn` skip that ran past the end of its line stops exactly one byte past
    // the newline it crossed. Null when the window starts in the middle of a line whose
    // start this skip never saw (a mid-line `startByte`), which is the only case that
    // later costs a backward lookup — and only if the window ends in a byte cut (H4).
    lineStart: number | null;
    // True when `startColumn` was PAST the end of `startLine`, so the skip consumed that
    // line's terminator and the window begins on the following line. The entry then has
    // to report the line it actually starts on rather than the one the caller named (H5).
    crossedLineEnd: boolean;
    // Did this target yield any byte at all? M11's rule ("an empty file has no lines to be
    // past the end of") used to rest on `sizeBytes > 0`, which H3 shows is a lie for every
    // pseudo-file. This is the honest version: a read answered bytes (H3).
    sawBytes: boolean;
    // Did this walk reach a PROVEN end of file — a read that answered zero bytes, or a
    // cursor that stood exactly on a known bound? Only on this proof is a whole-file line
    // count knowable from the newlines seen so far (EXTRA-4).
    sawEof: boolean;
};

const skipToWindow = async (
    io: FileIo,
    size: FileSize,
    start: { offset: number; line: number; counted: boolean; lineStart: number | null },
    linesToSkip: number,
    columnToSkip: number
): Promise<WindowStart> => {
    let cursor = start.offset;
    let line = start.line;
    let needed = linesToSkip;
    let newlinesSeen = 0;
    let pastEof = false;
    let lineStart = start.lineStart;
    let crossedLineEnd = false;
    let sawBytes = false;
    let sawEof = !hasMore(io, cursor);

    if (needed > 0) {
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let landed = false;

        while (!landed && hasMore(io, cursor)) {
            // H3: against a KNOWN end the walk asks for exactly the bytes that are left,
            // which is the byte-exact behavior the paging tests pin. Against an unknown
            // end (`/proc`, a FIFO) it asks for a whole window and lets the read itself
            // say where the data stops — a request bounded by `Infinity` would allocate a
            // 64 KiB read every time and stop on the short read anyway.
            const want = size.known === null ? buffer.length : Math.min(buffer.length, size.bound - cursor);
            const bytesRead = await ioRead(io, buffer, want, cursor);

            if (bytesRead === 0) {
                sawEof = true;
                break;
            }
            sawBytes = true;

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
                    // Landing one byte past a terminator IS standing on the next line's
                    // physical start, so `lineStart` comes free here (H4).
                    cursor = cursor + at + 1;
                    lineStart = cursor;
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
        //
        // `hasSawBytes()` is the M11 half of the rule, restated on H3's honest model. It
        // used to be `sizeBytes > 0`, which for a pseudo-file is 0 in `st_size` while the
        // file holds text: `startLine: 500` of `/proc/self/status` walked zero chunks,
        // matched neither branch, and got the empty window that means "this file is
        // empty". Asking whether this target ever yielded a byte separates the two cases
        // that `st_size === 0` conflates: a target that has given us nothing on a proven
        // EOF is genuinely empty (no error), while one that has bytes and still ran out of
        // newlines is past the end (ERANGE). A regular file with no newlines at all, like
        // one giant line, still lands here correctly because its walk read bytes to reach
        // a real EOF.
        // Neither answer below applies when the walk LANDED: an offset the caller asked for
        // that this target could reach says nothing about EOF or about being past the end.
        if (!landed) {
            // Standing exactly on a KNOWN end is a proven end just as much as a read that
            // answered zero bytes is: the walk asked for `bound - cursor` bytes, got them,
            // and has nothing left to ask for. Without this half, a file that ends exactly
            // where the walk stopped (every file whose last line is terminated, i.e. most of
            // them) would report `sawEof: false` and lose the line count that makes its own
            // ERANGE message actionable (EXTRA-4).
            sawEof = sawEof || !hasMore(io, cursor);

            // Bytes were read but the newlines ran out: this is "past the end", not "empty"
            // (M11). A target that never yielded a byte is the empty case and answers with no
            // error at all.
            pastEof = needed > 0 && (sawBytes || io.sawBytes);
        }
    }

    // The column skip asks for a real position, so the bound comes from the read
    // itself (H3): `end` is the last byte worth looking at inside `columnToSkip`, and
    // the target only when nothing else bounds it.
    if (columnToSkip > 0 && hasMore(io, cursor)) {
        // H4: `startColumn` is measured from the PHYSICAL start of the line the window
        // begins on, which is the same base `nextColumn` is reported from (see the byte
        // cut's use of `lineStartOf`), so the pair this tool prints is the pair this tool
        // accepts. `max` keeps a `startByte` the caller pinned: a column that resolves
        // BEHIND the seek offset cannot pull the window backwards past the position they
        // asked for, and the window simply starts at the seek.
        //
        // The line-axis path already knows the line start (its skip counted the newlines
        // and set it), and so does every resume. The only caller that does not is a
        // `{ startByte, startColumn }` pair, which skipped the count on purpose — for it
        // this ONE bounded backward read is what makes the two fields mean the same thing
        // they mean everywhere else, and it is paid only by a call that asked for both.
        const base = lineStart === null ? await lineStartOf(io, cursor) : lineStart;
        const target = Math.max(cursor, base + columnToSkip);
        const end = size.known === null ? target : Math.min(target, size.bound);
        const newlineAt = await firstNewline(io, cursor, end);

        // The base this skip resolved IS the physical start of the window's line, so
        // carrying it out saves the byte-cut report the same backward walk (H4).
        lineStart = base;

        if (newlineAt !== -1) {
            // The requested column runs past the end of the first requested line. The
            // old in-loop skip consumed that newline and then stopped, so the window
            // begins on the FOLLOWING line — reproduced exactly rather than improved
            // on, because `startColumn` past a line end is a caller error and the old
            // answer is the one already pinned by tests. What was wrong was the REPORT:
            // `crossedLineEnd` says so, and the entry reports the line it landed on (H5).
            cursor = newlineAt + 1;
            line += 1;
            lineStart = cursor;
            crossedLineEnd = true;
        } else {
            // Rounding up to a code-point boundary cannot cross a newline: 0x0a is a
            // single-byte character, never a continuation byte, so `line` and `lineStart`
            // are unchanged.
            //
            // The two non-`aligned` answers both mean "the byte you asked for is the byte
            // you get": `eof` because the target ends at or before it (the old code landed
            // on the same offset, one past the readable bytes), and `invalid` because the
            // caller asked to skip into data that is not text — which is not this skip's
            // problem to judge; the scan that follows reports it (M1 names the offset).
            const alignment = await alignToCodePoint(io, target);

            cursor = alignment.kind === 'aligned' ? alignment.offset : target;
        }
    }

    return {
        offset: cursor,
        line,
        pastEof,
        newlinesSeen,
        lineStart,
        crossedLineEnd,
        sawBytes: sawBytes || io.sawBytes,
        // Either this walk saw the end itself, or an earlier read on this handle proved it
        // (`discovered`), which is the only end an unknown-size target has (H3).
        sawEof: sawEof || io.size.discovered !== null
    };
};

// The whole-file line count for a window that landed past the end (H3 + EXTRA-4).
// `seen` is every newline the walks counted, and it is the whole truth only when `exact`
// says both halves held: the prefix before the seek point was actually counted, AND the
// walk reached a PROVEN end of file. Where the size is a fact, the terminating byte
// decides whether the final line is its own line, exactly as the byte-exact path always
// did. Where it is not — a pseudo-file, whose `st_size` of 0 said nothing — the proven end
// IS the answer: the walk stopped because a read returned no bytes, so the final line is
// unterminated and counts, and a target that never yielded a byte has no lines at all.
// `null` is the honest answer when the count was not earned: `scanSafely` then leaves
// `lineCount` off the entry instead of naming a number it cannot back up.
const lineCountAtEof = async (
    io: FileIo,
    size: FileSize,
    seen: number,
    exact: boolean,
    sawBytes: boolean
): Promise<number | null> => {
    if (!exact) return null;

    // The end to stand on: the stat when it is a fact, the offset a walk proved EOF at
    // otherwise, and nothing at all when even that has not happened yet (H3).
    const end = sizeEnd(size);

    if (end === Number.POSITIVE_INFINITY) return sawBytes ? null : 0;

    // H3/EXTRA-4: answer from the walk's own last byte when it reached this end, and only
    // otherwise probe the tail. For a pseudo-file the probe is the unreliable option.
    const terminated = await endsWithNewline(io, end);

    if (terminated === null) return null;

    return lineCountFromProbe(seen, 0, end, terminated);
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
    outOfRange: { lineCount: number | null } | null;
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
    io: FileIo,
    request: NormalizedTarget,
    allowance: number,
    byteCutLabel: 'maxBytes' | 'budget',
    size: FileSize,
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
        ? {
              offset: seek.offset,
              line: seek.line,
              pastEof: false,
              newlinesSeen: 0,
              // A resume inherits the line start the previous pass resolved, which is
              // what keeps paging one giant line O(window) instead of looking the line
              // start up again per pass (H4).
              lineStart: progress.lineStart,
              crossedLineEnd: false,
              // A pass that is resuming has already read from this target (its cursor came
              // from a previous pass), and it has NOT proved an end — the previous pass
              // stopped mid-file by definition, which is why there is a resume at all.
              sawBytes: true,
              sawEof: io.size.discovered !== null
          }
        : await skipToWindow(io, size, seek, linesToSkip, columnToSkip);

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
            entry: emptyWindowEntry(request, size),
            cutByBudget: false,
            progress: null,
            // H3/EXTRA-4: the count is a count, not a `st_size` reading. It comes from the
            // newlines this walk actually saw, and only when the walk BOTH started at a
            // position whose prefix was counted and reached a proven end of file. For a
            // pseudo-file that end is a read answering zero bytes — never the 0 in
            // `st_size`, which is the false EOF that used to make this report one line.
            outOfRange: {
                lineCount: await lineCountAtEof(
                    io,
                    size,
                    // `windowStart.line - 1` IS every newline in the file here: the walk
                    // continued the seek's own count and ran to the end, which is what
                    // `sawEof` proved. Adding `newlinesSeen` again would count the tail
                    // twice.
                    prefixNewlines,
                    prefixCounted && windowStart.sawEof,
                    windowStart.sawBytes
                )
            }
        };
    }

    // What the entry REPORTS as the first line: the caller's `startLine` when it named
    // one or when there was no seek at all, otherwise the line actually counted at the
    // seek offset (D2).
    //
    // The one exception is a `startColumn` that ran PAST the end of `startLine` (H5): that
    // skip consumed the line terminator, so the window the caller gets begins on the NEXT
    // line, and reporting the line they named would print one line's text under another
    // line's number — and would under-count the file by exactly the newline the skip
    // crossed, since `lineCount` is built from the reported line. The position the skip
    // actually reached is the answer, and it is the same `windowStart.line` the count needs.
    const reportedStartLine = resuming
        ? progress.reportedStartLine
        : windowStart.crossedLineEnd
          ? windowStart.line
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
        // H4: the physical start of the line the window begins on, free whenever the skip
        // or a previous pass knows it, null when only a backward lookup could say.
        lineStart: resuming ? progress.lineStart : windowStart.lineStart,
        // The gutter a numbered window is billed per line, fixed for the window because
        // the renderer pads to one width as well. `numberedChargeWidth` is an UPPER bound
        // on that width, which is what makes the model's copy fit inside the wire form
        // (L1) rather than above it.
        gutterBytes: numberedGutterBytes(numberedChargeWidth(reportedStartLine, request.maxLines, size.bound)),
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
        // Armed from the first byte of every pass: the window has emitted nothing yet, and
        // the first character it can see must reach the response whatever the allowance is
        // (F1). A RESUME arms it too — the pass must add at least one new character, or the
        // cursor it reports cannot move past the one the previous pass stopped at.
        emitFloor: true,
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

    // EXTRA-3: the strict twin that decides whether `lossy` should be PUBLISHED.
    //
    // The old test was `text.includes('\ufffd')`, which cannot tell a replacement this tool
    // made from a U+FFFD that is legitimately IN the file: a log line that already holds `
    // was reported as if read had rewritten bytes, and an agent acting on that flag re-saves
    // content it never needed to touch. The question that IS answerable is "would a strict
    // decoder accept these same bytes?", so a lossy read runs one over the identical stream.
    // Feeding it the same chunks with `stream: true` keeps a code point split across a read
    // boundary a single character for the twin as well, so the verdict is about the window's
    // bytes and not about where the reads happened to stop. It only exists when `lossy` was
    // requested, so a strict read pays nothing for this.
    const twin = request.lossy ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : null;

    // Feeds the twin and records its verdict. Once a substitution has been seen the twin is
    // dropped: the flag is sticky and there is no second question for it to answer.
    const noteTwin = (bytes: Buffer, stream: boolean): void => {
        if (twin === null || state.sawLoss) return;

        try {
            twin.decode(bytes, { stream });
        } catch {
            state.sawLoss = true;
        }
    };

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let readOffset = windowStart.offset;
    // Whether this pass read the file to its end. Only then is the whole-file line
    // count knowable from what was already counted (see `lineCount` on the entry).
    let reachedEnd = false;

    while (!state.stopped) {
        // One bounded read (H2): the per-file deadline is enforced inside `ioRead`, so a
        // hung mount gives THIS entry its ETIMEDOUT instead of hanging the call.
        const chunkStart = readOffset;
        const bytesRead = await ioRead(io, buffer, buffer.length, chunkStart);

        if (bytesRead === 0) {
            // A FIFO or socket that has never yielded a byte is not at EOF — it is empty
            // RIGHT NOW, waiting for a writer. Measured (Temp/orch/read/probe2.ts): this
            // kernel answers an empty non-blocking FIFO read with `bytesRead === 0` rather
            // than throwing EAGAIN, so nothing in the read itself separates "no writer yet"
            // from "the writer closed". Whether a byte was ever seen does: a stream that has
            // produced content has ended, and one that has not would block. Claiming EOF
            // there would hand back `content: ""`, `truncated: false` and no error, which is
            // the same silent wrong answer D10 removed on the byte axis.
            if (io.wouldBlock && !io.sawBytes) throw new WouldBlockError(request.path);

            reachedEnd = true;
            break;
        }

        readOffset += bytesRead;

        let text: string;
        try {
            text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        } catch {
            // The byte that broke the strict decode is somewhere in the bytes this window
            // pulled, so the offset published is the first byte this read covered — a lower
            // bound, and still the number that makes "seek past it" actionable. Before M1's
            // message work the offset was missing entirely.
            throw new HarnessError(binaryDecodeMessage(request.path, chunkStart));
        }

        noteTwin(buffer.subarray(0, bytesRead), true);

        state.stopped = consumeText(state, text);
    }

    // Only flush at EOF: flushing after an early stop would reject a trailing
    // partial code point in bytes we deliberately never needed to read.
    if (!state.stopped) {
        let tail: string;
        try {
            tail = decoder.decode();
        } catch {
            // The pending bytes at the very end of the file are what failed here, and
            // `state.scanOffset` is the first byte after everything this window consumed:
            // the offset the caller would have to seek past.
            throw new HarnessError(binaryDecodeMessage(request.path, state.scanOffset));
        }

        // Flushing the twin is what catches a truncated sequence at the END of the file,
        // which no chunk-level test can see (EXTRA-3).
        noteTwin(TWIN_FLUSH, false);

        if (tail.length > 0) state.stopped = consumeText(state, tail);
    }

    // ---------------------------------------------------------------------
    // THE CONTINUATION CURSOR, FINISHED IN ONE PLACE (C2 + H4)
    // ---------------------------------------------------------------------
    // `stopAt` records WHERE the cut happened and deliberately leaves `nextColumn` null:
    // two facts about that position can only be settled after the loop, where an `await`
    // is available and where each cost is paid by exactly the cut that needs it.
    //
    //   C2 — a TRUNCATED window must satisfy `nextByte` > the offset this window started
    //   at, so the documented continuation can never re-read the same window. That now
    //   holds UPSTREAM, by construction: the one-code-point floor (`ScanState.emitFloor`)
    //   makes a window with content emit at least one code point even when the allowance
    //   cannot pay for it, and an emission always advances `scanOffset`. Nothing is skipped
    //   on the way, which is what the earlier version of this block got wrong: it stepped
    //   the cursor to the next code point WITHOUT emitting it, so every character whose
    //   escape cost exceeded the allowance vanished from every page (the emoji in
    //   `😀abcdef\n` at `maxBytes: 1`, and every `\r\n` of a CRLF file read that way).
    //   `nextByte` is once again literally the first unread byte.
    //
    //   The clamp below is therefore defensive: it covers a truncated window whose cursor
    //   did not move, a shape the floor cannot produce. It names EOF rather than stepping a
    //   code point by hand, because hand-stepping is what used to lose bytes, and it keeps
    //   the cursor monotonic so no caller can loop on it.
    //
    //   H4 — `nextColumn` counts from the PHYSICAL start of `nextLine`, not from wherever
    //   this window happened to begin. `state.lineStart` already holds it whenever the
    //   window crossed a newline (the scanner records it), whenever the skip landed on a
    //   line start (a `startLine` walk, a `startColumn` that crossed a terminator), and
    //   whenever an earlier pass resolved it; only a byte cut on a mid-line `startByte`
    //   seek that never crossed a newline pays the backward lookup. Writing the answer
    //   back into `state.lineStart` is what makes the next pass of a water-filled batch
    //   get it for free.
    if (state.truncated && state.nextByte !== null) {
        // The defensive cursor clamp (C2). A truncated window must move, and the floor
        // (F1) already guarantees it does, so this branch only names the alternative:
        // where the size IS a fact, the end is `size.bound` and standing on it means EOF;
        // where it is not, there is no end to name, so the cursor advances exactly one
        // byte — the smallest honest step that cannot re-read the same window (H3: the
        // old `= sizeBytes` assignment put `0` in `nextByte` for every pseudo-file, which
        // sent the documented resume back to the start of the file).
        if (state.nextByte <= windowStart.offset) state.nextByte = size.known === null ? windowStart.offset + 1 : size.bound;

        if (state.nextColumn === null) {
            const lineStart = state.lineStart ?? (await lineStartOf(io, state.nextByte));

            state.lineStart = lineStart;
            state.nextColumn = state.nextByte - lineStart;
        }
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
    //
    // It is built from `state.prefixNewlines`, the newlines the prefix walk COUNTED, and
    // not from `startLine - 1` (L10): those are the same number until a `startColumn` skip
    // crosses a line terminator, and the count used to be silently short by that one.
    let lineCount: number | undefined;

    if (prefixCounted) {
        // Where the DECODED window ended. `scanOffset` is the first byte this pass did
        // not consume, so everything after it is still unread bytes of the file.
        const windowEnd = state.scanOffset;

        // The end this count may stand on: the stat when it is a fact, the offset a walk
        // proved EOF at otherwise. `Infinity` means neither has happened, and a window
        // that stopped early on an unbounded stream has no whole-file answer to give (H3:
        // standing on the pseudo-file's `st_size` of 0 instead published `lineCount: 0`
        // for a window that had just returned dozens of lines).
        const end = sizeEnd(size);

        if (Number.isFinite(end) && (windowEnd >= end || reachedEnd)) {
            // Either the window consumed the whole file (nothing left to count) or it
            // stopped early with a raw suffix that a byte scan settles for free.
            const trailing = windowEnd >= end ? 0 : await countNewlines(io, windowEnd, end);
            // H3/EXTRA-4: the byte the walk last landed on answers the terminator question
            // whenever a read stopped exactly at this end, which is what both paths above
            // just did. Only a target that never produced a read reaching `end` — a stream,
            // or a size the walk has not stood on — still pays the tail probe, and a
            // non-seekable one answers null and leaves `lineCount` unpublished.
            const terminated = await endsWithNewline(io, end);

            if (terminated !== null) {
                lineCount = lineCountFromProbe(state.prefixNewlines, state.windowNewlines + trailing, end, terminated);
            }
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
        // H3: only a fact about this file's size is published. A pseudo-file that answered
        // `0` here made its own resume cursor look out of range on the next call.
        sizeBytes: size.known,
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
              // The PHYSICAL start of the line the cursor sits on, resolved once (H4): a
              // surplus pass derives its own column as `resumeByte - lineStart` and never
              // pays for the backward lookup twice.
              lineStart: state.lineStart,
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
//
// It answers `null` when the question cannot be asked. A stream with no file offset has
// no `end - 1` to reach without reading the whole thing a second time, and re-reading a
// FIFO consumes its data (H2) — so the caller leaves `lineCount` unpublished rather than
// inventing a convention for a question this target cannot answer.
const lastIsNewline = async (io: FileIo, sizeBytes: number): Promise<boolean | null> => {
    if (!io.seekable) return null;
    if (sizeBytes === 0) return false;

    const probe = Buffer.allocUnsafe(1);
    const bytesRead = await ioRead(io, probe, 1, sizeBytes - 1);

    return bytesRead === 1 && probe[0] === NEWLINE_CODE;
};

// How many lines a file holds, when every newline in it has been counted. A newline
// TERMINATES the line above it rather than starting an empty one, so N terminators mean
// exactly N lines, and only a file that does NOT end with one has an extra (unterminated)
// final line. That is the `wc -l` convention, and the one `startLine`/`endLine` already
// use — an agent that counts the lines it was shown must land on the same number the
// entry reports. `prefixNewlines` is what the prefix walk counted (valid only because
// `prefixCounted` guarantees it, and why the count is NOT built from `startLine - 1`,
// which is the same number only until a `startColumn` skip crosses a terminator — L10).
// A 0-byte file has no lines at all, which is what keeps "past the end" and "nothing
// here" different answers.
const lineCountFromProbe = (
    prefixNewlines: number,
    windowNewlines: number,
    sizeBytes: number,
    trailingNewline: boolean
): number => {
    if (sizeBytes === 0) return 0;

    return prefixNewlines + windowNewlines + (trailingNewline ? 0 : 1);
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
const seekOf = async (slot: ScanSlot): Promise<SeekStart | 'ERANGE' | { binaryAt: number }> => {
    if (slot.seek !== undefined) return slot.seek;

    const { request } = slot;
    const io = slot.handle;

    // io is null only for an entry that already failed, which never scans. The size model
    // travels inside the handle (H3) — `slot.size` is the SAME object — so there is exactly
    // one source for it and a walk can update `discovered` where its reads proved it.
    slot.seek = io === null
        ? { offset: 0, line: 1, aligned: null, counted: true, lineStart: 0 }
        : await resolveSeek(io, request);

    return slot.seek;
};

// The empty window an out-of-range `startLine` leaves behind. Shaped exactly like the
// window a seek-to-EOF produces (see `failedEntry` for the same reasoning on the byte
// axis), so a caller's range arithmetic still holds; `scanSafely` turns it into the
// ERANGE entry that names the file's line count.
const emptyWindowEntry = (request: NormalizedTarget, size: FileSize): FileReadEntry => ({
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
    // H3: the size is published only when it is a fact. A pseudo-file's 0 would tell the
    // caller its resume cursor is out of range, which is the false-ERANGE bug this field
    // used to cause.
    sizeBytes: size.known
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
    const { request, size } = slot;
    const io = slot.handle;
    if (io === null) return failedEntry(request, 'EIO', `read failed to read "${request.path}".`, size.known);

    const effective = Math.min(allowance, request.maxBytes);
    const byteCutLabel: 'maxBytes' | 'budget' = request.maxBytes < allowance ? 'maxBytes' : 'budget';

    // M7: the batch's shared envelope is what bound this file only when the share is
    // SMALLER than the file's own `maxBytes`, and `budgetGranted` then names the exact
    // allowance the scanner cut against. Absent otherwise: a file bound by its own
    // `maxBytes` — every file in a one-path call, which is the common shape — keeps the
    // entry it always had, and the one optional key is priced in `ENTRY_VALUE_RESERVE`
    // rather than charged to every entry in every batch.
    const shareBinds = allowance < request.maxBytes;

    const seek = await seekOf(slot);

    if (seek === 'ERANGE') {
        slot.cutByBudget = false;
        slot.progress = null;

        return failedEntry(
            request,
            'ERANGE',
            rangeMessage(request.path, request.startByte as number, sizeEnd(size)),
            size.known
        );
    }

    // M1: the bounded probe proved the caller's `startByte` sits inside a run of
    // continuation bytes longer than any code point. An EBINARY entry naming that offset,
    // produced here rather than thrown, so its siblings keep their content (EXTRA-1).
    if ('binaryAt' in seek) {
        slot.cutByBudget = false;
        slot.progress = null;

        return failedEntry(request, 'EBINARY', binaryAtMessage(request.path, seek.binaryAt), size.known);
    }

    // A surplus pass continues where the last one stopped (D4): the seek becomes the
    // resume offset, and the window the last pass produced is seeded into the scanner
    // so only the missing bytes are decoded.
    const progress = slot.progress;
    const start: SeekStart =
        progress === null
            ? seek
            : {
                  offset: progress.resumeByte,
                  line: progress.lineNumber,
                  aligned: progress.startByteAligned,
                  counted: progress.prefixCounted,
                  lineStart: progress.lineStart
              };

    try {
        const { entry, cutByBudget, progress: next, outOfRange } = await scanFile(
            io,
            request,
            effective,
            byteCutLabel,
            size,
            start,
            progress
        );

        // `startLine` named a line the file does not have (D11-line). The count that
        // proves it was a byproduct of the walk, so the message can name the file's
        // total — the number that makes "you are past the end" actionable. `null` is the
        // honest answer when the target gave no proven end to count against (H3), and the
        // message then says so instead of naming a wrong number.
        if (outOfRange !== null) {
            slot.cutByBudget = false;
            slot.progress = null;

            return failedEntry(
                request,
                'ERANGE',
                rangeLineMessage(request.path, request.startLine, outOfRange.lineCount),
                size.known
            );
        }

        slot.cutByBudget = cutByBudget;
        slot.progress = next;

        return shareBinds ? { ...entry, budgetGranted: effective } : entry;
    } catch (error) {
        slot.cutByBudget = false;
        slot.progress = null;

        // CANCELLATION FIRST — before the `HarnessError` branch below, and for a reason worth
        // the comment: the cancellation this tool now raises IS a HarnessError (it carries a
        // `code`, which is the whole point), and this branch's contract is "a HarnessError here
        // is the binary rejection". Folding a cancelled call into `EBINARY` would tell the
        // caller the FILE is binary — the most misleading answer available to a cancel — and
        // would turn one aborted path into a per-entry result the batch never promised.
        // Cancellation rejects the call, exactly as it does in phase 1 (./cancellation.ts).
        if (isFileCancellation(error)) throw error;

        // A binary rejection raised by the scanner is a fact about THIS file, and its
        // message is already the published one. `HarnessError` is that signal and nothing
        // else in this file throws it — the cancellation above is the one exception, and it
        // is excluded before this test so the rule still holds for everything that reaches it.
        if (error instanceof HarnessError) {
            return failedEntry(request, 'EBINARY', error.message, size.known);
        }

        // H2 + EXTRA-1: anything else that carries a filesystem code is this file's
        // outcome, not the call's — the per-file deadline (`ETIMEDOUT`), an empty FIFO
        // (`EAGAIN`), or an errno a read in the middle of the scan reported. The old code
        // let these propagate, which rejected the whole batch and destroyed the content
        // every sibling entry had already produced.
        if (
            error instanceof FileReadTimeoutError ||
            error instanceof WouldBlockError ||
            errorCodeOf(error) !== undefined
        ) {
            const failure = await classifyFailure(request, error, io.deadlineMs);

            return failedEntry(request, failure.code, failure.message, size.known, failure.rawCode);
        }

        // No code, not a binary rejection: a bug in this tool, not a condition of the
        // filesystem. Surfacing it beats folding it into EIO, and the caller's handles are
        // closed by `execute`'s own finally block either way.
        throw error;
    }
};

// Classify one filesystem failure into a per-entry error. Every case names the
// requested path and says what to do instead, because a model reads this and acts
// on it; a bare errno does not.
//
// THE CODES ARE A CLOSED SET (H5). `FileReadErrorCode` and `FILE_READ_ERROR_CODES`
// enumerate everything this tool can publish, and this function is the only place a raw
// errno becomes one of them. The old version did `code as FileReadErrorCode` on an
// arbitrary string, so a caller that handled the documented six could receive EMFILE,
// EBADF, ESTALE or ENODEV with no warning and no branch — and could not tell whether a
// fold had happened. Now: an errno with a published entry keeps its own name and gets a
// specific verb and remedy, and one without folds into `EIO` with the untouched name in
// `rawCode`. `rawCode` is OMITTED when they would agree, so the common entry carries the
// field it always did and only a real fold pays the extra key.
// The `code` field of a Node filesystem error, or undefined for anything that is not one
// (including a DOMException, whose `code` is a number). Pulled out because both the
// classifier and `scanSafely` need it, and because the STRING test is what keeps an
// AbortError from being mistaken for a filesystem outcome (H2: cancellation rejects the
// whole call, it is not one entry's answer).
const errorCodeOf = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
};

const classifyFailure = async (
    request: NormalizedTarget,
    error: unknown,
    deadlineMs: number
): Promise<{ code: FileReadErrorCode; message: string; rawCode?: string }> => {
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
            code,
            message: `read was denied permission to read "${request.path}": ${message}. This is a filesystem permission problem, not a missing path or a directory read.`
        };
    }

    // A component of the path ahead of the file is a FILE, so the path cannot be resolved
    // past it. This is a spelling mistake, not a missing file, and naming the errno alone
    // hides that.
    if (code === 'ENOTDIR') {
        return {
            code,
            message: `read cannot resolve "${request.path}": a component of the path before the file is not a directory (ENOTDIR), so nothing can be looked up inside it. Check that the separator belongs where the name does.`
        };
    }

    if (code === 'ELOOP') {
        return {
            code,
            message: `read cannot resolve "${request.path}": the path crosses more symbolic-link levels than the filesystem allows (ELOOP), so it almost certainly links back to itself. Read the link's target directly.`
        };
    }

    if (code === 'ENAMETOOLONG') {
        return {
            code,
            message: `read cannot resolve "${request.path}": the path is longer than this filesystem accepts (ENAMETOOLONG). Use a shorter path or a relative one from the working directory.`
        };
    }

    // H2: the target exists and opened, but has no file offset, so a positional request
    // cannot be answered there. The remedy is in the message because it is a different
    // call, not a retry.
    if (code === 'ESPIPE') {
        return { code, message: unseekableMessage(request.path) };
    }

    // H2: a FIFO or socket with no writer yet. Node reports the kernel's EAGAIN through
    // this tool's own `WouldBlockError` (measured in Temp/orch/read/probe2.ts: a
    // non-blocking read of an empty FIFO answers zero BYTES rather than throwing, so the
    // scanner raises this to keep "nothing right now" from being published as EOF), and a
    // real EAGAIN from the filesystem takes the same published entry.
    if (code === 'EAGAIN') {
        return { code, message: wouldBlockMessage(request.path) };
    }

    // H2: this file's I/O budget ran out. The number is the configured ceiling, and it is
    // in the message because "the mount did not answer" is only actionable once the caller
    // knows how long it waited. `FileReadTimeoutError` carries it; a genuine ETIMEDOUT
    // errno from the filesystem may not, and then the ceiling this call used is right.
    if (code === 'ETIMEDOUT') {
        const millis = error instanceof FileReadTimeoutError ? error.millis : deadlineMs;

        return { code, message: timeoutMessage(request.path, millis) };
    }

    // Everything else is folded. The set above is what a caller can branch on; this branch
    // is what a caller can LOG, which is why the untouched name travels in `rawCode`.
    return {
        code: 'EIO',
        ...(code === undefined || code === 'EIO' ? {} : { rawCode: code }),
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
    //
    // HOW THE `ECANCELED` CLAUSE WAS PAID FOR. The set has to name every published code (a
    // model cannot branch on a code it was never told about, and `read.test.ts` asserts the
    // enumeration), and adding one sentence to a description pinned at 1,685 of a 1,700-byte
    // ceiling costs 34 bytes. It was funded inside the same ceiling, the way the earlier
    // rewrite funded its three new codes: two clauses that only restated the parameter schema
    // — which travels with the description on every request anyway — gave up their bytes.
    // "Max 100 paths." is `paths.maxItems: 100`; "(a SEEK)" is the `startByte` field's own
    // "byte offset to SEEK to". Net +10, and the headroom stays positive. The ceiling did not
    // move.
    description:
        'Read a BOUNDED window of UTF-8 text files. Per-file defaults startLine 1, startColumn 0, startByte null, maxLines 2000, maxBytes 65536 (escaped wire bytes, not raw) - this feeds a context window, not a pipe. Act on `truncated`/`limit` first: "maxLines" raise maxLines, "maxBytes" raise maxBytes, "budget" means the batch\'s 256 KiB envelope is full, null means EOF. The 256 KiB budget is measured on the SERIALIZED result and allocated by demand. A budget cut is explainable: `budgetPool` is what the batch had left to split, `budgetGranted` what this file got. A truncated entry\'s `nextByte` is its first unread byte, so paging cannot loop; continue with startByte = nextByte or { startLine: nextLine, startColumn: nextColumn } - `startColumn` counts bytes from the PHYSICAL start of `startLine`, so that pair is an absolute position and walks a line of any size. `sizeBytes` is null when the size is not a filesystem fact (a /proc file, FIFO, socket, device): never treat 0 or null as EOF; such a target answers startByte with ESPIPE. An unreadable path stays IN ORDER with `error: { code, rawCode?, message }`, costs no budget, and counts in `skipped`: ENOENT (names likely paths), EISDIR (previews entries), EACCES/EPERM/ENOTDIR/ELOOP/ENAMETOOLONG, EBINARY (`lossy: true` substitutes U+FFFD), ERANGE (names the size or line count), ESPIPE (no file offset - read it without startByte), EAGAIN (an empty FIFO: start the writer), ETIMEDOUT (that file missed the 10000ms I/O deadline; siblings unaffected), EIO with the untouched errno in `rawCode`. Files 65536 bytes or larger the budget cut are also named in `note`. Only a malformed request or a cancelled call (`ECANCELED`) rejects the call.\'',
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
                                        '0-based UTF-8 byte offset within startLine, for continuing a giant line. Past the end of that line it lands on the next line, and the entry reports the line it actually returned. Defaults to 0.'
                                },
                                startByte: {
                                    type: 'integer',
                                    minimum: 0,
                                    description:
                                        '0-based UTF-8 byte offset to SEEK to; feed back a previous nextByte - it names the first unread byte. Inside a multi-byte character it moves to the next boundary (startByteAligned); at or past EOF it is an ERANGE entry. Without startLine the true line here is counted. Defaults to null.'
                                },
                                maxLines: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 20_000,
                                    description:
                                        'Lines to return. Default 2000, max 20000. A window cut by this cap reports limit: "maxLines".'
                                },
                                maxBytes: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 262_144,
                                    description:
                                        'Byte allowance for THIS file, charged in ESCAPED wire bytes (the unit `wireBytes` counts), not the raw bytes `bytes` reports: a newline costs 2 here and 1 there, a quote costs 2, and a non-ASCII character costs its raw UTF-8 length unless JSON escapes it. One character is always returned, up to 6 bytes over; a window can still stop with `bytes` well under this number. Default 65536; max 262144. The only knob that widens ONE file. A window cut by it reports limit: "maxBytes".'
                                },
                                lossy: {
                                    type: 'boolean',
                                    description:
                                        'Substitute U+FFFD for bytes that are not valid UTF-8 instead of reporting EBINARY, so a Latin-1 log stays readable; the entry then says `lossy: true`. A NUL byte is still EBINARY either way: it says "binary", not "wrong codepage". Default false.'
                                },
                                numbered: {
                                    type: 'boolean',
                                    description:
                                        "Prefix each line of this file's model copy with its line number (`123: `) so it can cite lines without arithmetic. `content` stays raw and `bytes` excludes the gutter, but the gutter is charged against maxBytes — a numbered window holds fewer bytes than the same call without it. Other files are unaffected. Default false."
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

// ---------------------------------------------------------------------------
// THE BATCH ITSELF — a named function with INJECTABLE LIMITS (H2's test seam)
// ---------------------------------------------------------------------------
// `read`'s `execute` is a one-line delegation to this. The body needs a per-file
// wall-clock budget and the caller's cancellation signal, and a test has to be able to
// ask for `ioDeadlineMs: 0` to prove the timeout path deterministically instead of
// waiting out the 10-second production ceiling. Widening `execute`'s parameter for that
// would have put a harness knob in the model-facing schema, so the limits are a second
// argument here — the same shape `./grep.tool.ts:626-639` publishes for exactly this
// reason (`FileGrepLimits` plus a `DEFAULT_` value plus an internal function that takes
// them). Exported, because the seam is the point: `scripts/verify-read-fixes.ts` and any
// host that wants a longer budget than 10 s can bind this directly.
export const readFileBatch = async (
    paths: FileReadParameters,
    limits: FileReadLimits = DEFAULT_FILE_READ_LIMITS,
    signal?: AbortSignal
): Promise<ToolTextEnvelope<FileReadResult>> => {
    const requested = normalizeTargets(paths);

    // PHASE 1 — open every path and turn every unreadable one into a failed
    // entry, preserving the caller's order. Opening first is what lets PHASE 2
    // split the budget only across files that can actually be read: a missing,
    // directory, permission-denied or binary path never reserves a share it
    // cannot use. A directory is detected on the handle's stat rather than on a
    // read error, because Windows lets a directory open and fails only later.
    //
    // ONE I/O BUDGET PER PATH (H2). Every syscall this loop and every later scan makes
    // for one path runs under that path's own wall-clock ceiling plus the caller's
    // cancellation signal. Per path, not per call: a file on a dead mount gets an
    // `ETIMEDOUT` entry and nothing else, while the other 99 keep their content. The
    // clock starts when the path's first syscall starts and is NOT restarted by the
    // water-filling passes, so one unresponsive filesystem cannot buy itself more time by
    // being re-scanned.
    const budgetFor = (path: string): IoBudget => ({
        // `ioDeadlineMs: 0` (or any non-positive value) yields a deadline that is already
        // expired, which `bounded` refuses SYNCHRONICALLY before the first syscall — the
        // deterministic seam the timeout test uses instead of racing a timer. `Infinity`
        // disables the bound, which is what a caller with its own, longer timeout wants.
        deadlineAt: Number.isFinite(limits.ioDeadlineMs) ? Date.now() + Math.max(0, limits.ioDeadlineMs) : null,
        deadlineMs: Math.max(0, limits.ioDeadlineMs),
        ...(signal === undefined ? {} : { signal }),
        path
    });

    const slots: ScanSlot[] = [];
    const openFiles = new Set<FileIo>();

    try {
        for (const request of requested) {
            const absolute = resolve(request.path);
            const budget = budgetFor(request.path);

            try {
                // THE OPEN FLAGS ARE CHOSEN BEFORE THE OPEN, because the hang H2 is about
                // happens INSIDE it: measured in Temp/orch/read/probe2.ts,
                // `open(fifo, 'r')` on a FIFO with no writer blocks in the kernel with
                // nothing on the JavaScript side able to interrupt it, while
                // `O_RDONLY | O_NONBLOCK` returns immediately. A regular file keeps mode
                // `'r'`, byte-identically to the behavior every paging test pins.
                const kind = await kindOfTarget(budget);

                const handle = await bounded(budget, () =>
                    open(request.path, kind === 'blocking' ? OPEN_NONBLOCKING : 'r')
                );

                // Authoritative after the open (an `fstat` on the descriptor we are
                // holding), so a race between the pre-stat above and the target changing
                // type cannot misclassify it.
                const info = await bounded(budget, () => handle.stat());
                const size = sizeOfStat(info);

                const io: FileIo = {
                    handle,
                    // THE SAME OBJECT as `slot.size` below: a walk that proves an end for
                    // an unknown-size target records it (`markEof`), and the slot's entry
                    // must see that proof rather than a stale copy (H3/EXTRA-4).
                    size,
                    deadlineAt: budget.deadlineAt,
                    deadlineMs: budget.deadlineMs,
                    ...(signal === undefined ? {} : { signal }),
                    path: request.path,
                    // Only a regular file has a file offset. A pipe, socket or device
                    // answers a positional read with ESPIPE, so every read on those goes
                    // through `ioRead` sequentially (H2).
                    seekable: info.isFile(),
                    // A FIFO/socket read answers "nothing right now" instead of EOF, which
                    // is the condition this tool publishes as EAGAIN.
                    wouldBlock: info.isFIFO() || info.isSocket(),
                    sawBytes: false,
                    // No read has happened on this handle yet, so nothing is known about
                    // its last byte (see `endsWithNewline`).
                    lastByteAt: null,
                    lastByte: null
                };

                openFiles.add(io);

                // A directory is detected here rather than from a read error:
                // Windows opens one successfully and fails only later, and the
                // stat is free next to an open we already paid for.
                if (info.isDirectory()) {
                    await closeQuietly([io]);
                    openFiles.delete(io);
                    const message = await directoryEntryMessage(request.path);
                    slots.push({
                        request,
                        handle: null,
                        // H3: a directory's `st_size` says nothing about readable bytes, so
                        // the entry publishes `sizeBytes: null` instead of a number a caller
                        // could mistake for an empty file.
                        size: unknownSize(),
                        overhead: entryOverhead(absolute, { code: 'EISDIR', message }),
                        projectionReserve: projectionOverhead(absolute, { code: 'EISDIR', message }),
                        entry: failedEntry(request, 'EISDIR', message),
                        cutByBudget: false,
                        progress: null
                    });
                    continue;
                }

                // A non-seekable target CANNOT honour `startByte` (H2): the kernel answer
                // to a positional read on a pipe is ESPIPE, so this is not a value to
                // ignore but a request that cannot be answered. Decided here, where the
                // entry's message can be priced into the reservation before the budget is
                // split, like every other known-in-advance failure.
                if (!io.seekable && request.startByte !== null) {
                    await closeQuietly([io]);
                    openFiles.delete(io);
                    const message = unseekableMessage(request.path);
                    slots.push({
                        request,
                        handle: null,
                        size,
                        overhead: entryOverhead(absolute, { code: 'ESPIPE', message }),
                        projectionReserve: projectionOverhead(absolute, { code: 'ESPIPE', message }),
                        entry: failedEntry(request, 'ESPIPE', message, size.known),
                        cutByBudget: false,
                        progress: null
                    });
                    continue;
                }

                // The probe that separates an empty regular file from a pseudo-file whose
                // `st_size` of 0 is a lie (H3). One byte, on a regular file only — a FIFO
                // would consume a byte of a live stream, and there an empty read means "no
                // writer yet", which the scan reports as EAGAIN.
                if (size.known === null && info.isFile()) {
                    const bytesRead = await ioRead(io, Buffer.allocUnsafe(1), 1, 0);

                    if (bytesRead === 0) {
                        // The stat was telling the truth: this file really is empty. The
                        // `markEof` the probe recorded becomes the authoritative 0.
                        size.known = 0;
                        size.bound = 0;
                    }
                }

                // A `startByte` at or past EOF is decided here, from the stat we
                // already have, rather than inside the scan: an entry that will
                // carry an error message must have that message measured into the
                // reservation BEFORE the budget is split, exactly like ENOENT and
                // EISDIR, or it would take a content share it cannot use and then
                // spend wire bytes on the error instead.
                //
                // `size.known !== null` is the H3 half of this rule: a target whose size is
                // not a fact cannot be said to have an offset past its end, so no clamp and
                // no false ERANGE. The scan settles those with a real read instead, and
                // reports ERANGE from the offset it actually proved (see `resolveSeek`).
                if (request.startByte !== null && size.known !== null && request.startByte >= size.known) {
                    await closeQuietly([io]);
                    openFiles.delete(io);
                    const message = rangeMessage(request.path, request.startByte, size.known);
                    slots.push({
                        request,
                        handle: null,
                        size,
                        overhead: entryOverhead(absolute, { code: 'ERANGE', message }),
                        projectionReserve: projectionOverhead(absolute, { code: 'ERANGE', message }),
                        entry: failedEntry(request, 'ERANGE', message, size.known),
                        cutByBudget: false,
                        progress: null
                    });
                    continue;
                }

                slots.push({
                    request,
                    handle: io,
                    size,
                    overhead: entryOverhead(absolute),
                    projectionReserve: projectionOverhead(absolute),
                    entry: null,
                    cutByBudget: false,
                    progress: null
                });
            } catch (error) {
                // A cancelled call has no consumer for a per-entry answer: the harness
                // discards a late result anyway (src/types/index.ts:2356-2357), so the
                // signal propagates and the `finally` below closes what is open (H2). A
                // per-file DEADLINE is the opposite case — a fact about one file — and
                // becomes that entry's `ETIMEDOUT` through the classifier like any errno.
                if (signal?.aborted === true) throw error;

                // An unknown throw is a bug in this tool, not a filesystem outcome; and
                // EXTRA-1 says only per-path conditions may become per-entry errors.
                if (errorCodeOf(error) === undefined) throw error;

                const { code, message, rawCode } = await classifyFailure(request, error, budget.deadlineMs);

                slots.push({
                    request,
                    handle: null,
                    size: unknownSize(),
                    overhead: entryOverhead(absolute, { code, message, rawCode }),
                    projectionReserve: projectionOverhead(absolute, { code, message, rawCode }),
                    entry: failedEntry(request, code, message, null, rawCode),
                    cutByBudget: false,
                    progress: null
                });
            }
        }
    } catch (error) {
        // Do not leak handles opened before the failing target.
        await closeQuietly(openFiles);
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

    // PHASE 2a — reserve the floor's headroom before the budget is split (F1).
    //
    // A window whose allowance cannot hold its first code point emits that code point
    // anyway, so it can overshoot the share it was given by the widest escape
    // `JSON.stringify` produces (6 bytes for a control character rendered as a
    // six-character `\u00XX` literal) plus, for a `numbered` window, the one gutter
    // line it billed. `numberedGutterBytes(MAX_LINE_DIGITS)` bounds any gutter this
    // tool can charge, because `numberedChargeWidth` pads to a line number's digit
    // count and no line number has more digits than `Number.MAX_SAFE_INTEGER`.
    //
    // Subtracting the reserves BEFORE the split is what makes the envelope a theorem:
    // file i emits at most `share_i + reserve_i`, the shares sum to the pool, and the
    // reserves are exactly what the pool gave up, so the total is at most
    // `contentBudget` — the bound the harness compares its own wire cap against. Without
    // the reservation, a 100-path batch at `maxBytes: 1` could let up to ~2.8 KiB of
    // floor escape the budget it was measured against.
    const floorReserve = readable.reduce(
        (total, slot) =>
            total + CODE_POINT_ESCAPE_CEILING_BYTES + (slot.request.numbered ? numberedGutterBytes(MAX_LINE_DIGITS) : 0),
        0
    );
    const pool = Math.max(0, contentBudget - floorReserve);

    try {
        let pending = readable;
        let allowance = pending.length > 0 ? Math.floor(pool / pending.length) : 0;

        // No `allowance > 0` guard (the zero-allowance defect): a batch whose
        // per-entry reserves ate the whole envelope used to run NO pass at all, so
        // every readable file kept `entry: null` and the fallback reported `EIO` for
        // a file that was never opened for reading. A 0-byte allowance is simply the
        // tightest one there is — an empty window, `limit: "budget"`, and a cursor
        // that still moves (C2) — and `EIO` is back to meaning "this handle could not
        // be read". The loop still cannot spin: a 0 allowance leaves the entries cut
        // with no surplus to give, so `surplus === 0` breaks out right after pass 0.
        for (let pass = 0; pass < ALLOCATION_PASSES && pending.length > 0; pass += 1) {
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
                // The leftover has to be computed in the currency the scanner spent:
                // escaped wire bytes of the text PLUS, for a `numbered` window, the
                // gutter it billed per line (L1). Subtracting only the text hands a
                // numbered file's gutter back to the batch as if it had never been
                // charged, and since the gutter is now the renderer's upper bound
                // rather than the current line's digits, that gap is no longer a
                // rounding error — it is what could let `wireBytes` run past
                // `contentBudget` on a batch of numbered reads.
                else surplus += Math.max(0, allowance - chargedContentBytes(slot, entry));
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
        await closeQuietly(openFiles);
        openFiles.clear();
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
    // One flag per entry, index-aligned with `files` (M1). `requested.some(...)` made
    // the gutter a batch-wide property, so one caller asking for line numbers put a
    // gutter — and a gutter charge — on every other file in the call.
    const projection = renderProjection(files, requested.map((item) => item.numbered));
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
                // M7: the number that was actually splittable, in the same position
                // `RESULT_SHELL` reserves it, so the measurement and the reserve agree.
                budgetPool: pool,
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
            // M7: `contentBudget` is the envelope; this is what was left to split after
            // every reserve, which is the number that explains a `limit: "budget"` cut.
            budgetPool: pool,
            modelBytes,
            skipped
        } satisfies FileReadResult,
        projection
    );
};

export const read = tool<FileReadParameters, ToolTextEnvelope<FileReadResult>>({
    ...FILE_READ_METADATA,
    // T2/R2: the DECLARED turn policy, mirrored from `registration` above so the
    // standalone callable, a host-registered `tools: { read }`, and the harness's
    // descriptor-bound registration all resolve the same effective mode.
    mode: 'sync',
    // The production call: the published limits and the harness's own cancellation
    // signal (src/types/index.ts:2287-2364), which is honoured BETWEEN syscalls by
    // `bounded` and, once fired, rejects the whole call rather than answering per entry.
    execute: ({ parameters: paths, signal }) => readFileBatch(paths, DEFAULT_FILE_READ_LIMITS, signal)
});
