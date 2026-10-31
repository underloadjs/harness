// gitDiff — read-only unified diff of a git working tree.
//
// Why a dedicated tool when commandRun can already run `git diff`? Because the
// model should not have to compose a command line to get the one thing it needs
// before editing, and because the argv must be fixed:
//
//   git --no-pager diff --no-color --no-ext-diff --no-textconv --abbrev=40 [--staged] [ref] [-- ...paths]
//
// Consequences of that shape, all deliberate:
//   - no shell: argv goes straight to spawn, so refs/paths cannot inject flags;
//   - --no-pager keeps git from ever opening a pager on a pipe;
//   - --no-color / --no-ext-diff / --no-textconv keep the output deterministic and
//     stop a repository's config from running an external diff driver;
//   - --abbrev=40 prints full object names. `--no-abbrev` does not apply to the
//     diff index line on git 2.45, and core.abbrev would otherwise change the
//     header from one machine to the next;
//   - pathspecs always follow "--", so a path that looks like an option is still a
//     path;
//   - GIT_OPTIONAL_LOCKS=0 stops git refreshing/writing the index, so a "read"
//     really is a read.
//
// Nothing here stages, commits, resets, or writes. A non-zero exit (not a git
// repository, bad ref) is returned as data like commandRun does, so the model can
// read git's own message and correct itself.
//
// Executable on its own and registerable on a harness:
//
//     const { stdout } = await gitDiff({ ref: 'HEAD~1' });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { BoundedText, COMMAND_STDERR_MAX_BYTES, COMMAND_STDOUT_MAX_BYTES } from './boundedText';
import { processGroupOptions, terminateTree } from './processTree';

export type GitDiffParameters = {
    // Commit/branch/range to diff against. Rejected when option-like.
    ref?: string;
    // Diff the index instead of the working tree.
    staged?: boolean;
    // Pathspecs, sent after "--". An explicitly empty array is rejected rather
    // than silently diffing everything.
    paths?: string | string[];
    // Repository directory. Defaults to the process working directory.
    cwd?: string;
};

export type GitDiffResult = {
    // Process exit code, or -1 when a signal/this tool terminated the process.
    exitCode: number;
    stdout: string;
    stderr: string;
    // True when STDOUT exceeded MAX_OUTPUT_BYTES and the tail was dropped.
    truncated: boolean;
    // True when STDERR exceeded the stderr cap and the tail was dropped.
    stderrTruncated: boolean;
    // True when the timeout killed the process.
    timedOut: boolean;
    // True when context.signal killed the process.
    aborted: boolean;
};

// A diff can be arbitrarily large; a model cannot use more than this in one turn
// and an unbounded string would just burn memory. The stderr cap (16 KiB) is the
// shared command cap: git diagnostics can be long, but a wall of warnings must
// not dominate the result.
const MAX_OUTPUT_BYTES = COMMAND_STDOUT_MAX_BYTES;

// git diff on a big tree can legitimately take seconds; more than this means
// something is wrong (huge repository, slow filesystem), and the run must end.
const TIMEOUT_MS = 10_000;

// Backstop after a timeout/abort kill, so a stuck tree cannot hang the tool.
const KILL_GRACE_MS = 2_000;


// A ref is a user-controlled argv element, so validate it rather than relying on
// "--" (which only protects pathspecs, not the revision position):
//   - no leading "-" (would be parsed as a git option);
//   - no whitespace or control characters (would be meaningless in a revision);
//   - no NUL (cannot exist in argv anyway, but keep spawn honest).
// "..", "...", "^", "~" and friends stay allowed: they are how ranges are written.
const validateRef = (ref: string): string => {
    if (ref.length === 0) {
        throw new HarnessError('gitDiff received an empty ref. Omit ref to diff the working tree.');
    }

    if (ref.length > 256) {
        throw new HarnessError('gitDiff received a ref longer than 256 characters.');
    }

    if (ref.startsWith('-')) {
        throw new HarnessError(`gitDiff refuses an option-like ref ("${ref}"); pass a commit, branch, or range.`);
    }

    if (/[\s\u0000-\u001f\u007f]/.test(ref)) {
        throw new HarnessError(`gitDiff received a ref containing whitespace or control characters ("${ref}").`);
    }

    return ref;
};

// Normalize the pathspec argument into a list of non-empty strings. Each entry is
// placed after "--" later, so option-like paths are safe; only obviously broken
// values (empty string, empty array, NUL) are rejected. An empty ARRAY is rejected
// rather than treated as "no paths": "paths: []" almost always means a computed
// list came out empty, and silently diffing the whole tree would hide that bug.
const normalizePaths = (paths: string | string[] | undefined): string[] => {
    if (paths === undefined) return [];

    const list = Array.isArray(paths) ? paths : [paths];

    if (list.length === 0) {
        throw new HarnessError('gitDiff paths array must not be empty when provided.');
    }

    const normalized: string[] = [];

    for (const path of list) {
        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('gitDiff paths must be non-empty strings.');
        }

        if (path.includes('\u0000')) {
            throw new HarnessError('gitDiff paths must not contain NUL characters.');
        }

        normalized.push(path);
    }

    return normalized;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const GIT_DIFF_METADATA: PresetToolMetadata = {
    name: 'gitDiff',
    description:
        'Show the unified diff of uncommitted changes in a git repository, with colour, external diff drivers, and textconv disabled. Optionally diff against a ref, the staged index, or a set of paths. Read-only: nothing is staged, committed, or written. Returns exit code, stdout, stderr, and truncation/timeout flags; a non-zero exit is data, not an error. `stderrTruncated` reports that stderr was capped (16 KiB) and `aborted` that the run was cancelled.',
    tags: ['git', 'diff', 'vcs', 'review', 'command'],
    parameters: {
        type: 'object',
        properties: {
            ref: {
                type: 'string',
                description: 'Commit, branch, or range to diff against, e.g. "HEAD~1", "main", or "main...HEAD". Must not start with "-".'
            },
            staged: {
                type: 'boolean',
                description: 'Diff the staged index instead of the working tree (git diff --staged). Defaults to false.'
            },
            paths: {
                // Non-empty by contract: an empty pathspec list would read as
                // "no restriction" while the caller asked for one.
                oneOf: [
                    { type: 'string', minLength: 1 },
                    { type: 'array', items: { type: 'string' }, minItems: 1 }
                ],
                description: 'Path or paths to restrict the diff to (at least one). Passed after "--" so they are always pathspecs.'
            },
            cwd: {
                type: 'string',
                description: 'Repository working directory. Defaults to the directory the harness was started in.'
            }
        },
        additionalProperties: false
    }
};

export const gitDiff = tool<GitDiffParameters, GitDiffResult>({
    ...GIT_DIFF_METADATA,
    execute: (context) => {
        const { ref, staged, paths, cwd } = context.parameters;

        // context.signal is being added to ToolContext by a parallel change; read
        // it structurally so this module works with or without that field typed.
        const signal = (context as { signal?: AbortSignal }).signal;

        // The harness does not validate JSON Schema, so a model can send
        // "true" instead of true. Reject that instead of silently diffing the
        // wrong side of the index.
        if (staged !== undefined && typeof staged !== 'boolean') {
            throw new HarnessError('gitDiff staged must be a boolean.');
        }

        const args = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--abbrev=40'];

        // --staged before the revision, matching git's own usage examples.
        if (staged === true) args.push('--staged');

        if (ref !== undefined) args.push(validateRef(ref));

        const pathspecs = normalizePaths(paths);

        // "--" ends option parsing: every remaining token is a pathspec, even
        // one that starts with "-".
        if (pathspecs.length > 0) args.push('--', ...pathspecs);

        // Already cancelled before anything started: report a clean aborted
        // result instead of spawning git just to kill it.
        if (signal?.aborted) {
            return Promise.resolve({
                exitCode: -1,
                stdout: '',
                stderr: '',
                truncated: false,
                stderrTruncated: false,
                timedOut: false,
                aborted: true
            });
        }

        return new Promise<GitDiffResult>((resolvePromise, rejectPromise) => {
            const child = spawn('git', args, {
                cwd: cwd ? resolve(cwd) : undefined,
                shell: false,
                env: {
                    ...process.env,
                    // Read-only intent: do not refresh or write the index.
                    GIT_OPTIONAL_LOCKS: '0'
                },
                ...processGroupOptions()
            });

            // Decode incrementally so a multi-byte character split across chunks
            // is not mangled (except at the truncation boundary, where a partial
            // sequence necessarily becomes a replacement character). Both streams
            // are byte-capped; stderr keeps the head up to the shared 16 KiB cap.
            const stdout = new BoundedText(MAX_OUTPUT_BYTES);
            const stderr = new BoundedText(COMMAND_STDERR_MAX_BYTES);

            let timedOut = false;
            let aborted = false;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let graceTimer: ReturnType<typeof setTimeout> | undefined;
            // Shared kill promise: timeout and abort may both fire; the tree is
            // terminated (and awaited) once.
            let treeKill: Promise<void> | undefined;

            // Settle exactly once; also releases the timer and abort listener.
            const settle = (finish: () => void): void => {
                if (settled) return;

                settled = true;
                if (timer) clearTimeout(timer);
                if (graceTimer) clearTimeout(graceTimer);
                signal?.removeEventListener('abort', onAbort);
                finish();
            };

            // Backstop: resolve with the captured head even if a killed git tree
            // never emits 'close'. Scheduled only after terminateTree resolves, so
            // it cannot race ahead of the Windows taskkill wait.
            const finishKilled = (): void =>
                settle(() =>
                    resolvePromise({
                        exitCode: -1,
                        stdout: stdout.end(),
                        stderr: stderr.end(),
                        truncated: stdout.truncated,
                        stderrTruncated: stderr.truncated,
                        timedOut,
                        aborted
                    })
                );

            const scheduleGrace = (): void => {
                if (graceTimer === undefined) graceTimer = setTimeout(finishKilled, KILL_GRACE_MS);
            };

            const terminate = (): Promise<void> => {
                if (!treeKill) {
                    treeKill = terminateTree(child).then(scheduleGrace, scheduleGrace);
                }

                return treeKill;
            };

            const onAbort = (): void => {
                aborted = true;
                void terminate();
            };

            timer = setTimeout(() => {
                timedOut = true;
                void terminate();
            }, TIMEOUT_MS);

            signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
            child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));

            // Spawn failures (git missing, cwd missing) are setup problems, not
            // diff results: throw so the harness reports a real error.
            child.on('error', (error) => settle(() => rejectPromise(error)));

            child.on('close', (code, exitSignal) => {
                const finish = (): void =>
                    settle(() =>
                        resolvePromise({
                            exitCode: timedOut || aborted ? -1 : code ?? (exitSignal ? -1 : 0),
                            stdout: stdout.end(),
                            stderr: stderr.end(),
                            truncated: stdout.truncated,
                            stderrTruncated: stderr.truncated,
                            timedOut,
                            aborted
                        })
                    );

                // A timed-out/aborted close is reported only after the tree kill
                // has completed, so the result cannot precede the grandchild kill.
                if (treeKill) {
                    void treeKill.then(finish, finish);
                    return;
                }

                finish();
            });
        });
    }
});

