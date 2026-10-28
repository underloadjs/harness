// The preset tools.
//
// Each one is exercised twice, because that is the contract: standalone (called
// directly) and registered on a harness (called by the model). File tools run
// inside a temporary directory so they never touch the repository.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    agent,
    harness,
    listFiles,
    readFile,
    runCommand,
    syntaxCheck,
    writeFile
} from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

let workdir: string;
let previousCwd: string;

beforeAll(async () => {
    previousCwd = process.cwd();
    workdir = await mkdtemp(join(tmpdir(), 'underload-harness-'));
    process.chdir(workdir);
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

// A transport that replays scripted turns, one per request.
const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;
    return async function* (): AsyncIterable<HarnessStreamEvent> {
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

describe('syntaxCheck', () => {
    it('checks JavaScript when the caller names the language', async () => {
        await expect(
            syntaxCheck({ code: 'const a = 1; function f() { return a; }', language: 'javascript' })
        ).resolves.toBe(true);
        await expect(syntaxCheck({ code: 'const = ;', language: 'javascript' })).resolves.toBe(false);
    });

    it('parses JavaScript as a classic script only', async () => {
        await expect(
            syntaxCheck({ code: 'for (const x of [1]) { console.log(x); }', language: 'javascript' })
        ).resolves.toBe(true);
        // Classic-script parser: import/export is module syntax.
        await expect(syntaxCheck({ code: 'import x from "y";', language: 'javascript' })).resolves.toBe(
            false
        );
    });

    it('checks Python when the caller names the language', async () => {
        await expect(
            syntaxCheck({ code: 'def f(x):\n    return x + 1', language: 'python' })
        ).resolves.toBe(true);
        await expect(syntaxCheck({ code: 'def f(x) return x', language: 'python' })).resolves.toBe(
            false
        );
    });

    it('does not execute the code it checks', async () => {
        // If either ran, it would create the file.
        await expect(
            syntaxCheck({ code: 'open("executed.txt", "w").write("x")', language: 'python' })
        ).resolves.toBe(true);
        await expect(
            syntaxCheck({
                code: 'require("node:fs").writeFileSync("executed-js.txt", "x");',
                language: 'javascript'
            })
        ).resolves.toBe(true);

        await expect(readFile('executed.txt')).rejects.toThrow();
        await expect(readFile('executed-js.txt')).rejects.toThrow();
    });

    it('rejects an unsupported language instead of guessing', async () => {
        // The schema's enum catches a model call; a direct call bypasses the
        // schema, so the implementation refuses rather than returning a verdict.
        await expect(
            syntaxCheck({ code: 'puts 1', language: 'ruby' as never })
        ).rejects.toThrow(
            'syntaxCheck requires language to be "javascript" or "python"; received "ruby".'
        );
    });

    it('has a standard tool shape', () => {
        expect(syntaxCheck.name).toBe('syntaxCheck');
        expect(syntaxCheck.description).toContain('JavaScript');
        expect(syntaxCheck.description).toContain('Python');
        expect(syntaxCheck.parameters).toMatchObject({
            type: 'object',
            required: ['code', 'language']
        });
    });
});

describe('file tools', () => {
    it('writes, reads, and lists', async () => {
        const written = await writeFile({ path: 'notes/hello.md', content: '# Hello' });

        expect(written.bytes).toBe(7);
        expect(written.path.endsWith(join('notes', 'hello.md'))).toBe(true);

        await expect(readFile('notes/hello.md')).resolves.toBe('# Hello');
        await expect(listFiles('notes')).resolves.toEqual(['hello.md']);
    });

    it('lists directories with a trailing slash so they are distinguishable', async () => {
        await writeFile({ path: 'tree/a.txt', content: 'a' });
        await writeFile({ path: 'tree/sub/b.txt', content: 'b' });

        await expect(listFiles('tree')).resolves.toEqual(['a.txt', 'sub/']);
    });

    it('defaults listFiles to the working directory', async () => {
        await writeFile({ path: 'root.txt', content: 'r' });
        const entries = await listFiles(undefined);
        expect(entries).toContain('root.txt');
    });

    it('overwrites an existing file', async () => {
        await writeFile({ path: 'over.txt', content: 'first' });
        await writeFile({ path: 'over.txt', content: 'second' });

        await expect(readFile('over.txt')).resolves.toBe('second');
    });

    it('surfaces a missing file as a thrown error', async () => {
        await expect(readFile('nope/missing.txt')).rejects.toThrow();
    });
});

describe('runCommand', () => {
    it('returns exit code, stdout, and stderr', async () => {
        const result = await runCommand({ command: 'node -e "console.log(42)"' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('42');
        expect(result.stderr).toBe('');
    });

    it('returns a non-zero exit as data instead of throwing', async () => {
        const result = await runCommand({ command: 'node -e "process.exit(3)"' });

        expect(result.exitCode).toBe(3);
    });

    it('honours cwd', async () => {
        await writeFile({ path: 'cwd-test/marker.txt', content: 'x' });
        const result = await runCommand({ command: 'node -e "console.log(process.cwd())"', cwd: 'cwd-test' });

        expect(result.stdout.trim().endsWith('cwd-test')).toBe(true);
    });
});

describe('presets inside a harness', () => {
    it('ships every preset searchable, file tools included', () => {
        expect(readFile.tags).toEqual(['files', 'read', 'filesystem']);
        expect(syntaxCheck.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);
        expect(readFile.visibility).toBe('searchable');
        expect(runCommand.visibility).toBe('searchable');
        expect(syntaxCheck.visibility).toBe('searchable');
    });

    it('registers a file tool under its export name and runs it after discovery', async () => {
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c0', 'requestTools', '{"tags":["read"]}'),
                callTool('c1', 'readFile', '{"path":"harness.txt"}'),
                answer('read it')
            ])
        });

        const writer = harness({ agents: { writer: entry }, tools: { readFile, writeFile } });

        await writeFile({ path: 'harness.txt', content: 'seeded content' });

        // The registry key renames the tool, so the model calls `readFile`.
        expect(writer.tools.readFile.name).toBe('readFile');

        const message = await writer('read the file');

        expect(message.content).toBe('read it');
        // user -> requestTools -> readFile call -> result -> answer. Discovery is
        // OR-ranked, so description mentions of "read" ("Read-only", "Does not
        // read .gitignore files.") also enable those tools as weak matches.
        expect(JSON.parse((entry.messages[2] as { content: string }).content).enabled).toEqual([
            'readFile',
            'gitDiff',
            'globFiles',
            'searchFiles'
        ]);
        expect((entry.messages[4] as { content: string }).content).toBe('seeded content');
    });

    it('discovers syntaxCheck and hands it the whole two-property object', async () => {
        // syntaxCheck declares `code` and `language`, so the single-property rule
        // does not apply: the implementation receives the object a direct call
        // would pass.
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c0', 'requestTools', '{"tags":["python"]}'),
                callTool(
                    'c1',
                    'syntaxCheck',
                    '{"code":"def f():\\n    pass","language":"python"}'
                ),
                answer('valid')
            ])
        });

        const writer = harness({ agents: { writer: entry }, tools: { syntaxCheck } });
        await writer('check it');

        expect(JSON.parse((entry.messages[2] as { content: string }).content).enabled).toEqual([
            'syntaxCheck'
        ]);
        expect((entry.messages[4] as { content: string }).content).toBe('true');
    });
});
