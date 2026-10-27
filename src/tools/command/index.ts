// @underload/harness tools/command — the shell escape hatch, and the read-only git view.
//
// runCommand has no sandbox, no allowlist, and no confirmation: it runs with the
// host's permissions. gitDiff is the narrow alternative for the common case — a
// fixed, non-mutating `git diff` argv with no shell.
export { runCommand } from './runCommand';
export type { RunCommandResult } from './runCommand';
export { gitDiff } from './gitDiff';
export type { GitDiffParameters, GitDiffResult } from './gitDiff';
