// @underload/harness tools/files — read, write, edit, list, search, and glob.
//
// The minimum a coding agent needs. **No sandbox:** every path is resolved against
// the process working directory and used as given. Powerful by default, and meant
// to run under whatever process-level boundary the host provides (a container, a
// worktree, a scoped cwd). Narrow them by wrapping `execute` if a harness needs a
// fence.
//
// searchFiles and globFiles share ./glob's walker: .git, node_modules, and symlinks
// are skipped, results are capped, and .gitignore is deliberately not read.
export { readFile } from './readFile';
export { writeFile } from './writeFile';
export type { WriteFileResult } from './writeFile';
export { editFile } from './editFile';
export type { EditFileParameters, EditFileResult } from './editFile';
export { listFiles } from './listFiles';
export { searchFiles } from './searchFiles';
export type { SearchFilesMatch, SearchFilesParameters, SearchFilesResult } from './searchFiles';
export { globFiles } from './globFiles';
export type { GlobFilesParameters, GlobFilesResult } from './globFiles';
