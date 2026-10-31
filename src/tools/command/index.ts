// @underload/harness tools/command — the shell escape hatch, and the read-only git view.
//
// commandRun has no sandbox, no allowlist, and no confirmation: it runs with the
// host's permissions. gitDiff is the narrow alternative for the common case — a
// fixed, non-mutating `git diff` argv with no shell.
//
// Both tools bound their output (./boundedText) and end runaway runs through
// ./processTree: a timeout, or an AbortSignal on the ToolContext, terminates the
// child process tree rather than leaving it holding the pipes.
export { commandRun } from './commandRun.tool';
export type { CommandRunParameters, CommandRunResult } from './commandRun.tool';
export { gitDiff } from './gitDiff.tool';
export type { GitDiffParameters, GitDiffResult } from './gitDiff.tool';
