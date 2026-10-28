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
// is deliberately not read.
export { fileRead } from './fileRead';
export type { FileReadEntry, FileReadParameters, FileReadResult } from './fileRead';
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
export { fileList } from './fileList';
export type { FileListParameters } from './fileList';
export { fileGlob } from './fileGlob';
export type {
    FileGlobFilesResult,
    FileGlobMatch,
    FileGlobMatchesResult,
    FileGlobParameters,
    FileGlobResult
} from './fileGlob';
