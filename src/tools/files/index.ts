// @underload/harness tools/files — read, write, edit, list, and glob.
//
// The minimum a coding agent needs. **No sandbox:** every path is resolved against
// the process working directory and used as given. Powerful by default, and meant
// to run under whatever process-level boundary the host provides (a container, a
// worktree, a scoped cwd). Narrow them by wrapping `execute` if a harness needs a
// fence.
//
// BATCHING (T14): fileRead, fileWrite, fileEdit, and fileList each declare ONE
// array property (`paths` / `files` / `edits`), so the single-property rule hands
// `execute` the array itself and one call covers several targets. fileWrite and
// fileEdit validate everything before the first write; fileRead and fileList reject
// the whole call on one bad entry, so a partial answer never looks complete.
//
// fileGlob is the one search surface: filename matching, plus an optional `content`
// regex that switches the result to matching lines. It uses ./glob's walker, so
// .git, node_modules, and symlinks are skipped, results are capped, and .gitignore
// is deliberately not read. Content mode is also byte-bounded: each match text is
// cut to 1 KiB with an explicit `textTruncated`, and a call stops at 64 KiB of
// match text with `truncated: true` (see ./fileGlob).
//
// fileList returns a bounded PAGE, not the whole listing: `{ entries, truncated,
// nextOffset, offset, limit, bytes, contentBudget }`, 200 entries by default and
// 1000 at most, 64 KiB of entry text per call, resumed by passing `nextOffset` as
// `offset` (see ./fileList). fileWrite refuses NUL content because it would create
// a file fileRead rejects as binary.
//
// Two private helpers sit beside the tool and are shared by the batch:
//   - ./identity — one canonical key per real file, so duplicate targets (Windows
//     case aliases, symlink aliases, aliased roots) cannot slip through;
//   - ./bounded-regex — content matching inside node:vm with a timeout, so a
//     catastrophic pattern fails instead of hanging the process.
export { fileRead } from './fileRead';
export type { FileReadEntry, FileReadParameters, FileReadResult, FileReadTarget } from './fileRead';
export { fileWrite } from './fileWrite';
export type {
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry
} from './fileWrite';
export { fileEdit } from './fileEdit';
export type {
    FileEditEntry,
    FileEditParameters,
    FileEditResult,
    FileEditResultEntry
} from './fileEdit';
export { fileList, FILE_LIST_CONTENT_BUDGET, FILE_LIST_DEFAULT_LIMIT, FILE_LIST_MAX_LIMIT } from './fileList';
export type { FileListParameters, FileListQuery, FileListResult } from './fileList';
export { fileGlob, FILE_GLOB_CONTENT_BUDGET, FILE_GLOB_MATCH_TEXT_BYTES } from './fileGlob';
export type {
    FileGlobFilesResult,
    FileGlobMatch,
    FileGlobMatchesResult,
    FileGlobParameters,
    FileGlobResult
} from './fileGlob';
