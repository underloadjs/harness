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
// Metadata comes from ../catalogue so descriptions and schemas cannot drift.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

export type GitDiffParameters = {
    // Commit/branch/range to diff against. Rejected when option-like.
    ref?: string;
    // Diff the index instead of the working tree.
    staged?: boolean;
    // Pathspecs, sent after "--".
    paths?: string | string[];
    // Repository directory. Defaults to the process working directory.
    cwd?: string;
};

export type GitDiffResult = {
    // Process exit code, or -1 when the process was terminated by a signal.
    exitCode: number;
    stdout: string;
    stderr: string;
    // True when stdout exceeded MAX_OUTPUT_BYTES and the tail was dropped.
    truncated: boolean;
    // True when the timeout killed the process.
    timedOut: boolean;
};

// A diff can be arbitrarily large; a model cannot use more than this in one turn
// and an unbounded string would just burn memory.
const MAX_OUTPUT_BYTES = 128 * 1024;

// git diff on a big tree can legitimately take seconds; more than this means
// something is wrong (huge repository, slow filesystem), and the run must end.
const TIMEOUT_MS = 10_000;

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
// values (empty, NUL) are rejected.
const normalizePaths = (paths: string | string[] | undefined): string[] => {
    if (paths === undefined) return [];

    const list = Array.isArray(paths) ? paths : [paths];
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

export const gitDiff = tool<GitDiffParameters, GitDiffResult>({
    ...PRESET_TOOLS.gitDiff,
    execute: ({ parameters: { ref, staged, paths, cwd } }) =>
        new Promise<GitDiffResult>((resolvePromise, rejectPromise) => {
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

            const child = spawn('git', args, {
                cwd: cwd ? resolve(cwd) : undefined,
                shell: false,
                env: {
                    ...process.env,
                    // Read-only intent: do not refresh or write the index.
                    GIT_OPTIONAL_LOCKS: '0'
                }
            });

            // Decode incrementally so a multi-byte character split across chunks
            // is not mangled (except at the truncation boundary, where a partial
            // sequence necessarily becomes a replacement character).
            const decoder = new StringDecoder('utf8');
            let stdout = '';
            let stderr = '';
            let captured = 0;
            let truncated = false;
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, TIMEOUT_MS);

            child.stdout?.on('data', (chunk: Buffer) => {
                if (captured >= MAX_OUTPUT_BYTES) {
                    truncated = true;
                    return;
                }

                const remaining = MAX_OUTPUT_BYTES - captured;

                // Keep the head of the diff; the model sees whole early hunks
                // rather than a random slice.
                const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;

                if (chunk.length > remaining) truncated = true;

                captured += slice.length;
                stdout += decoder.write(slice);
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                // stderr is git's own diagnostics: small, and worth keeping whole
                // up to a modest bound so a wall of warnings cannot dominate.
                if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
            });

            // Spawn failures (git missing, cwd missing) are setup problems, not
            // diff results: throw so the harness reports a real error.
            child.on('error', (error) => {
                clearTimeout(timer);
                rejectPromise(error);
            });

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                stdout += decoder.end();

                resolvePromise({
                    exitCode: code ?? (signal ? -1 : 0),
                    stdout,
                    stderr,
                    truncated,
                    timedOut
                });
            });
        })
});
