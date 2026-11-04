// @underload/harness tools/files — read, write, edit, list, glob, and grep.
//
// The minimum a coding agent needs. **No sandbox:** every path is resolved against
// the process working directory and used as given. Powerful by default, and meant
// to run under whatever process-level boundary the host provides (a container, a
// worktree, a scoped cwd). Narrow them by wrapping `execute` if a harness needs a
// fence.
//
// NAMES (rename): the wire names are `read`, `write`, `edit`, `fileList`, `glob`, and
// `grep`. `fileWrite` is now `write` and `fileGlob` is now `glob` plus the new `grep`;
// there are no old aliases on the wire, because two names for one tool makes discovery
// ambiguous. The exported TypeScript names keep their historical spelling
// (`FileWrite*`, `FileGlob*`) so a consumer's imports survive the rename.
//
// BATCHING (T14): read, write, edit, and fileList each declare ONE array property
// (`paths` / `files` / `edits`), so the single-property rule hands `execute` the array
// itself and one call covers several targets. write and edit validate everything before
// the first write; read keeps the ordered entry of a MISSING path (empty content +
// `error: { code: 'ENOENT' }`, see ./read) but still rejects the whole call for a
// malformed request, a directory, binary content, or any other I/O error. fileList
// rejects the whole call on one bad directory, so a partial answer never looks
// complete. glob and grep declare several properties each and receive the whole object.
//
// SEARCH IS TWO TOOLS NOW, NOT ONE TOOL WITH TWO MODES
// ----------------------------------------------------
// `fileGlob` used to switch between "list matching names" and "list matching lines"
// depending on whether the caller sent `content`. The split removes that mode rule, and
// both halves now page and account for themselves:
//
//   glob  ({ patterns?, paths?, maxResults?, offset? })
//     -> { files, truncated, offset, limit, nextOffset, bytes, contentBudget,
//          stopReason, partial, searched, excluded, patterns, note? }
//
//   grep  ({ pattern, patterns?, paths?, maxResults?, offset?, flags?, output?, context? })
//     -> { matches, truncated, offset, limit, nextOffset, bytes, contentBudget,
//          output, stopReason, partial, searched, skipped, excluded, patterns, note? }
//
// Both use ./glob's walker and ./search's shared candidate collection, so .git and
// symlinks are skipped (node_modules only until a root is placed inside it), .gitignore
// files at or below each root are honored, roots are deduplicated by real file
// identity, and results are capped (default 100, maximum 1000) and RESUMABLE: the walk is
// a deterministic prefix, so `nextOffset` paged back as `offset` continues the same
// sequence — the way read and fileList already worked.
//
// Both also explain themselves. `excluded` counts what the WALK did not yield (ignored
// files, pruned directories, unreadable directories, symlinks, whether the .gitignore
// caps dropped rules), grep's `skipped` counts files it refused to READ (over 1 MiB,
// binary, unreadable), `searched` counts what it did, and `note` states whatever needs
// action. An empty result is therefore distinguishable from a withheld one, which the
// previous shape could not claim: `matches: []` and "every candidate was skipped" were
// the same answer.
//
// grep is byte-bounded as before — each match text is cut to 1 KiB with an explicit
// `textTruncated`, and a call stops at 64 KiB of returned text with `truncated: true`
// (see ./grep) — and glob now carries the same 64 KiB budget over its path text, so a
// page is bounded by BYTES in both tools rather than by an entry count alone.
//
// grep's time bounds are two and separate: 30s of REGEX EXECUTION (charged only by
// measured matching time, ./bounded-regex) throws, while 30s of WALL CLOCK over the whole
// search returns a partial result with `stopReason: 'searchBudget'`. A big tree is never
// reported as an expensive pattern again.
//
// fileList returns a bounded PAGE, not the whole listing: `{ entries, truncated,
// nextOffset, offset, limit, bytes, contentBudget }`, 200 entries by default and
// 1000 at most, 64 KiB of entry text per call, resumed by passing `nextOffset` as
// `offset` (see ./fileList). write refuses NUL content because it would create a file
// read rejects as binary.
//
// TYPE-ONLY BARREL (T21)
// ----------------------
// This barrel re-exports TYPES only. A value re-export from a `*.tool.ts` entry
// would statically evaluate that entry — and therefore `node:fs` — at import time,
// which is exactly what the lazy catalogue (../lazy, ../index) exists to avoid. The
// tool values are reached through the generated descriptor loader, and their
// constants (FILE_LIST_CONTENT_BUDGET, FILE_GREP_CONTENT_BUDGET, …) are imported from
// the entry file itself by the implementation and its focused tests.
//
// Four private helpers sit beside the tools and are shared by the batch:
//   - ./identity       — one canonical key per real file, so duplicate targets (Windows
//     case aliases, symlink aliases, aliased roots) cannot slip through;
//   - ./search         — the pattern/root/candidate plumbing both search presets walk,
//     so glob and grep cannot drift apart: brace expansion and `!` negation, the root
//     error boundary, the per-root coverage counters, and the bounded-concurrency read
//     pipeline that keeps result order identical to the serial walk;
//   - ./gitignore      — the per-root `.gitignore` matcher ./search builds for each root,
//     so an ignored directory is skipped by both tools and skipped identically;
//   - ./bounded-regex  — content matching inside node:vm with a timeout charged only by
//     measured matching time, so a catastrophic pattern fails instead of hanging the
//     process, and a slow filesystem is never blamed on the pattern.
export type { FileReadEntry, FileReadParameters, FileReadResult, FileReadTarget } from './read.tool';
export type {
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry
} from './write.tool';
export type {
    FileEditEntry,
    FileEditParameters,
    FileEditResult,
    FileEditResultEntry
} from './edit.tool';
export type { FileListParameters, FileListQuery, FileListResult } from './fileList.tool';
// The two search entries publish more than a result object: the verdict selector
// (`FileGrepOutput`), the entry shapes inside `matches`, and the bound that closed the
// window (`stopReason`) are all part of the wire contract a consumer switches on. They
// are exported for the same reason `FileReadEntry` and `FileWriteEntry` are — a caller
// typing a handler needs to NAME the pieces, not only the envelope.
export type {
    FileGlobExcluded,
    FileGlobParameters,
    FileGlobResult,
    FileGlobStopReason
} from './glob.tool';
export type {
    FileGrepExcluded,
    FileGrepFile,
    FileGrepLine,
    FileGrepMatch,
    FileGrepOutput,
    FileGrepParameters,
    FileGrepResult,
    FileGrepSkipped,
    FileGrepStopReason
} from './grep.tool';
