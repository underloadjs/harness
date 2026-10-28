// gitDiff — a fixed, read-only git diff.
//
// The fixture is a real repository created in a temporary directory, so this tests
// the actual git output rather than a mock of it. Expected diffs are built from
// git's documented unified-diff format and the blob hashes of the known contents
// (sha1 of "blob <bytes>\0<content>"), which keeps the assertions exact without
// copying observed output into the test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitDiff } from './gitDiff';
import { HarnessError } from '../../util';

// Fixtures live under the repo-root Temp/ (five levels up from
// src/tools/command/: command -> tools -> src -> harness -> underload -> packages
// -> repo root), never OS temp.
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let repo: string;

// Run git in the fixture repository and fail the suite loudly on setup errors.
const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);

    return result.stdout;
};

// Full 40-character blob id for a file's contents, as git computes it.
const blobId = (content: string): string =>
    createHash('sha1')
        .update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`, 'utf8')
        .digest('hex');

// One-file, one-line unified diff: the exact shape `git diff` emits for the fixture.
const expectedDiff = (file: string, before: string, after: string): string =>
    [
        `diff --git a/${file} b/${file}`,
        `index ${blobId(before)}..${blobId(after)} 100644`,
        `--- a/${file}`,
        `+++ b/${file}`,
        '@@ -1 +1 @@',
        `-${before.replace(/\n$/, '')}`,
        `+${after.replace(/\n$/, '')}`
    ].join('\n') + '\n';

beforeAll(async () => {
    workdir = await mkdtemp(join(TEMP_ROOT, 'underload-git-diff-'));

    // A repository nested in the temporary directory, so "not a repository" can be
    // tested against the parent.
    repo = join(workdir, 'repo');
    await writeTextFile(join(workdir, 'placeholder.txt'), 'outside\n', 'utf8');
    await mkdir(repo);

    // cwd is the repository itself, so init needs no path argument.
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Underload Test');
    // Keep line endings byte-for-byte: Windows installs default to autocrlf=true.
    git('config', 'core.autocrlf', 'false');

    await writeTextFile(join(repo, 'a.txt'), 'hello\n', 'utf8');
    await writeTextFile(join(repo, 'b.txt'), 'one\n', 'utf8');
    git('add', '.');
    git('commit', '--quiet', '-m', 'initial');
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('gitDiff', () => {
    it('returns an empty result for a clean tree', async () => {
        await expect(gitDiff({ cwd: repo })).resolves.toEqual({
            exitCode: 0,
            stdout: '',
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false
        });
    });

    it('returns the exact working-tree diff', async () => {
        await writeTextFile(join(repo, 'a.txt'), 'goodbye\n', 'utf8');

        await expect(gitDiff({ cwd: repo })).resolves.toEqual({
            exitCode: 0,
            stdout: expectedDiff('a.txt', 'hello\n', 'goodbye\n'),
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false
        });

        // Restore so the following tests start from a clean tree.
        await writeTextFile(join(repo, 'a.txt'), 'hello\n', 'utf8');
        git('checkout', '--', 'a.txt');
    });

    it('diffs the staged index and not the working tree', async () => {
        await writeTextFile(join(repo, 'a.txt'), 'goodbye\n', 'utf8');
        git('add', 'a.txt');

        await expect(gitDiff({ cwd: repo, staged: true })).resolves.toEqual({
            exitCode: 0,
            stdout: expectedDiff('a.txt', 'hello\n', 'goodbye\n'),
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false
        });

        // The change is staged, so the default (working tree) view is empty.
        await expect(gitDiff({ cwd: repo })).resolves.toEqual({
            exitCode: 0,
            stdout: '',
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false
        });

        git('reset', '--quiet');
        git('checkout', '--', 'a.txt');
    });

    it('diffs against a ref and restricts the diff to pathspecs', async () => {
        await writeTextFile(join(repo, 'a.txt'), 'goodbye\n', 'utf8');
        await writeTextFile(join(repo, 'b.txt'), 'two\n', 'utf8');

        // Both files changed, but only a.txt is asked for.
        await expect(gitDiff({ cwd: repo, ref: 'HEAD', paths: 'a.txt' })).resolves.toEqual({
            exitCode: 0,
            stdout: expectedDiff('a.txt', 'hello\n', 'goodbye\n'),
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false
        });

        git('checkout', '--', 'a.txt', 'b.txt');
    });

    it('rejects an option-like ref instead of passing it to git', async () => {
        await expect(gitDiff({ cwd: repo, ref: '--stat' })).rejects.toThrow(
            new HarnessError('gitDiff refuses an option-like ref ("--stat"); pass a commit, branch, or range.')
        );

        await expect(gitDiff({ cwd: repo, ref: 'HEAD --stat' })).rejects.toThrow(
            new HarnessError('gitDiff received a ref containing whitespace or control characters ("HEAD --stat").')
        );

        await expect(gitDiff({ cwd: repo, ref: '' })).rejects.toThrow(
            new HarnessError('gitDiff received an empty ref. Omit ref to diff the working tree.')
        );
    });

    it('rejects a non-boolean staged flag instead of guessing', async () => {
        await expect(gitDiff({ cwd: repo, staged: 'true' as unknown as boolean })).rejects.toThrow(
            new HarnessError('gitDiff staged must be a boolean.')
        );
    });

    it('rejects empty pathspecs', async () => {
        await expect(gitDiff({ cwd: repo, paths: '' })).rejects.toThrow(
            new HarnessError('gitDiff paths must be non-empty strings.')
        );
    });

    it('returns a non-zero exit as data when git rejects the revision', async () => {
        // A bad ref is a normal git failure, not a harness failure: the model must
        // be able to read git's message and retry. exit 128 is git's fatal code.
        const result = await gitDiff({ cwd: repo, ref: 'does-not-exist' });

        expect(result.exitCode).toBe(128);
        expect(result.stdout).toBe('');
        expect(result.stderr.startsWith('fatal:')).toBe(true);
        expect(result.truncated).toBe(false);
        expect(result.stderrTruncated).toBe(false);
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);
    });

    it('rejects an explicitly empty paths array instead of diffing everything', async () => {
        // A computed path list that came out empty must not silently widen the
        // diff to the whole tree.
        await expect(gitDiff({ cwd: repo, paths: [] })).rejects.toThrow(
            new HarnessError('gitDiff paths array must not be empty when provided.')
        );
    });

    it('does not spawn when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await gitDiff.execute({
            parameters: { cwd: repo },
            signal: controller.signal
        } as unknown as Parameters<typeof gitDiff.execute>[0]);

        expect(result).toEqual({
            exitCode: -1,
            stdout: '',
            stderr: '',
            truncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: true
        });
    });

    it('caps a large diff and flags truncation', async () => {
        const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n') + '\n';
        await writeTextFile(join(repo, 'a.txt'), lines, 'utf8');

        const result = await gitDiff({ cwd: repo });

        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(true);
        // 128 KiB cap on BYTES; the fixture is ASCII, so the captured string is
        // exactly the cap with no replacement character.
        expect(result.stdout.length).toBe(128 * 1024);
        expect(result.stderrTruncated).toBe(false);
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);

        git('checkout', '--', 'a.txt');
    });
});
