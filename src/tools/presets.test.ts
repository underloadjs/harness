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
    javascriptSyntax,
    listFiles,
    pythonSyntax,
    readFile,
    runCommand,
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

// A transport that always answers with the given text.
const answer = (text: string): HarnessStream =>
    async function* (): AsyncIterable<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// A transport that asks for one tool call, then answers.
const callsTool = (name: string, args: string, then: string): HarnessStream => {
    let turn = 0;
    return async function* (): AsyncIterable<HarnessStreamEvent> {
        turn++;
        if (turn === 1) {
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'c1', name, arguments: args }]
            };
            return;
        }
        yield { type: 'text', delta: then };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };
};

describe('javascriptSyntax', () => {
    it('is callable on its own', async () => {
        await expect(javascriptSyntax('const a = 1; function f() { return a; }')).resolves.toBe(true);
        await expect(javascriptSyntax('const = ;')).resolves.toBe(false);
    });

    it('accepts a whole program and rejects module syntax', async () => {
        await expect(javascriptSyntax('for (const x of [1]) { console.log(x); }')).resolves.toBe(true);
        // Classic-script parser: import/export is module syntax.
        await expect(javascriptSyntax('import x from "y";')).resolves.toBe(false);
    });

    it('has a standard tool shape', () => {
        expect(javascriptSyntax.name).toBe('javascriptSyntax');
        expect(javascriptSyntax.description).toContain('JavaScript');
        expect(javascriptSyntax.parameters).toMatchObject({ type: 'object', required: ['code'] });
    });
});

describe('pythonSyntax', () => {
    it('is callable on its own', async () => {
        await expect(pythonSyntax('def f(x):\n    return x + 1')).resolves.toBe(true);
        await expect(pythonSyntax('def f(x) return x')).resolves.toBe(false);
    });

    it('does not execute the code it checks', async () => {
        // If this ran, it would create the file.
        await expect(pythonSyntax('open("executed.txt", "w").write("x")')).resolves.toBe(true);

        await expect(readFile('executed.txt')).rejects.toThrow();
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
    it('registers under its export name and runs from a model tool call', async () => {
        const entry = agent({
            model: 'm',
            stream: callsTool('readFile', '{"path":"harness.txt"}', 'read it')
        });

        const writer = harness({ agents: { writer: entry }, tools: { readFile, writeFile } });

        await writeFile({ path: 'harness.txt', content: 'seeded content' });

        // The registry key renames the tool, so the model calls `readFile`.
        expect(writer.tools.readFile.name).toBe('readFile');

        const message = await writer('read the file');

        expect(message.content).toBe('read it');
        expect((entry.messages[2] as { content: string }).content).toBe('seeded content');
    });

    it('unwraps a single-property schema before execute sees it', async () => {
        // pythonSyntax declares one property (`code`), so the harness hands the
        // implementation the string, exactly like a direct call would.
        const entry = agent({
            model: 'm',
            stream: callsTool('pythonSyntax', '{"code":"def f():\\n    pass"}', 'valid')
        });

        const writer = harness({ agents: { writer: entry }, tools: { pythonSyntax } });
        await writer('check it');

        expect((entry.messages[2] as { content: string }).content).toBe('true');
    });
});
