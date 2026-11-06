// @underload/harness tools/command — the shell escape hatch, and the read-only git view.
//
// shell has no sandbox, no allowlist, and no confirmation: it runs with the
// host's permissions. gitDiff is the narrow alternative for the common case — a
// fixed, non-mutating `git diff` argv with no shell.
//
// Both tools bound their output and end runaway runs through ./processTree: a
// timeout, or an AbortSignal on the ToolContext, terminates the child process tree
// rather than leaving it holding the pipes. The two bound it DIFFERENTLY on
// purpose: gitDiff keeps the HEAD of a diff (./boundedText, a diff is read
// top-down) and shell keeps the HEAD AND THE TAIL of a command's output
// (./boundedOutput, a build log is read bottom-up, where `BUILD FAILED` lives).
//
// TYPE-ONLY BARREL (T21): re-exporting the tool VALUES here would statically
// evaluate `node:child_process` for every importer of the folder barrel, which is
// what the lazy catalogue (../lazy, ../index) avoids. Values are reached through the
// generated descriptor loader; only the public TYPES live on this barrel.
export type { CommandRunParameters, CommandRunResult } from './shell.tool';
export type { GitDiffParameters, GitDiffResult } from './gitDiff.tool';
