// The preset tools.
//
// Each one is exercised twice, because that is the contract: standalone (called
// directly) and registered on a harness (called by the model). File tools run
// inside a temporary directory so they never touch the repository.
//
// T14: the four file tools are BATCHED (one array argument each) and fileGlob is
// the single search surface (filename mode, or content mode when `content` is
// supplied). Names follow `<namespace><action>`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    agent,
    harness,
    commandRun,
    fileEdit,
    fileGlob,
    fileList,
    fileRead,
    fileWrite,
    syntaxCheck
} from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

// Repo-root Temp/, so fixtures never land in OS temp.
const TEMP_ROOT = fileURLToPath(new URL('../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

beforeAll(async () => {
    previousCwd = process.cwd();
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-presets-'));
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

        await expect(fileRead(['executed.txt'])).rejects.toThrow();
        await expect(fileRead(['executed-js.txt'])).rejects.toThrow();
    });

    it('rejects an unsupported language instead of guessing', async () => {
        // The schema's enum catches a model call; a direct call bypasses the
        // schema, so the implementation refuses rather than returning a verdict.
        await expect(syntaxCheck({ code: 'puts 1', language: 'ruby' as never })).rejects.toThrow(
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
    it('writes, reads, and lists with the batched arguments', async () => {
        const written = await fileWrite([{ path: 'notes/hello.md', content: '# Hello' }]);

        expect(written).toEqual([{ path: join(workdir, 'notes', 'hello.md'), bytes: 7 }]);

        // The batched read returns [{ path, content }] in request order.
        await expect(fileRead(['notes/hello.md'])).resolves.toEqual([
            { path: join(workdir, 'notes', 'hello.md'), content: '# Hello' }
        ]);
        // Results carry the directory they came from, so one flat list can hold
        // several directories without ambiguity.
        await expect(fileList('notes')).resolves.toEqual(['notes/hello.md']);
    });

    it('reads several files in one call', async () => {
        await fileWrite([
            { path: 'multi-read/a.txt', content: 'a' },
            { path: 'multi-read/b.txt', content: 'b' }
        ]);

        await expect(fileRead(['multi-read/b.txt', 'multi-read/a.txt'])).resolves.toEqual([
            { path: join(workdir, 'multi-read', 'b.txt'), content: 'b' },
            { path: join(workdir, 'multi-read', 'a.txt'), content: 'a' }
        ]);
    });

    it('edits several files in one call', async () => {
        await fileWrite([
            { path: 'multi-edit/a.txt', content: 'alpha\n' },
            { path: 'multi-edit/b.txt', content: 'beta\n' }
        ]);

        await expect(
            fileEdit([
                { path: 'multi-edit/a.txt', oldString: 'alpha', newString: 'ALPHA' },
                { path: 'multi-edit/b.txt', oldString: 'beta', newString: 'BETA' }
            ])
        ).resolves.toEqual([
            {
                path: join(workdir, 'multi-edit', 'a.txt'),
                replacements: 1,
                bytes: Buffer.byteLength('ALPHA\n', 'utf8')
            },
            {
                path: join(workdir, 'multi-edit', 'b.txt'),
                replacements: 1,
                bytes: Buffer.byteLength('BETA\n', 'utf8')
            }
        ]);
    });

    it('lists directories with a trailing slash so they are distinguishable', async () => {
        await fileWrite([
            { path: 'tree/a.txt', content: 'a' },
            { path: 'tree/sub/b.txt', content: 'b' }
        ]);

        await expect(fileList('tree')).resolves.toEqual(['tree/a.txt', 'tree/sub/']);
    });

    it('lists several directories in one call, grouped in the caller order', async () => {
        await fileWrite([
            { path: 'multi/src/a.ts', content: 'a' },
            { path: 'multi/task/b.ts', content: 'b' }
        ]);

        await expect(fileList(['multi/task', 'multi/src'])).resolves.toEqual([
            'multi/task/b.ts',
            'multi/src/a.ts'
        ]);
    });

    it('defaults fileList to the working directory', async () => {
        // A fresh, otherwise-empty directory makes the default listing exact: no
        // other test's fixtures leak in, so "." must produce exactly these names
        // with no prefix at all.
        const previous = process.cwd();
        await mkdir('defaults/empty/sub', { recursive: true });
        await fileWrite([{ path: 'defaults/empty/marker.txt', content: 'm' }]);
        process.chdir(join(previous, 'defaults', 'empty'));

        try {
            await expect(fileList(undefined)).resolves.toEqual(['marker.txt', 'sub/']);
            // Omitted and explicit ["."] are the same request.
            await expect(fileList(['.'])).resolves.toEqual(['marker.txt', 'sub/']);
        } finally {
            process.chdir(previous);
        }
    });

    it('overwrites an existing file', async () => {
        await fileWrite([{ path: 'over.txt', content: 'first' }]);
        await fileWrite([{ path: 'over.txt', content: 'second' }]);

        await expect(fileRead(['over.txt'])).resolves.toEqual([
            { path: join(workdir, 'over.txt'), content: 'second' }
        ]);
    });

    it('surfaces a missing file as a thrown error', async () => {
        await expect(fileRead(['nope/missing.txt'])).rejects.toThrow();
    });
});

describe('commandRun', () => {
    it('returns exit code, stdout, and stderr', async () => {
        const result = await commandRun({ command: 'node -e "console.log(42)"' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('42');
        expect(result.stderr).toBe('');
    });

    it('returns a non-zero exit as data instead of throwing', async () => {
        const result = await commandRun({ command: 'node -e "process.exit(3)"' });

        expect(result.exitCode).toBe(3);
    });

    it('honours cwd', async () => {
        await fileWrite([{ path: 'cwd-test/marker.txt', content: 'x' }]);
        const result = await commandRun({
            command: 'node -e "console.log(process.cwd())"',
            cwd: 'cwd-test'
        });

        expect(result.stdout.trim().endsWith('cwd-test')).toBe(true);
    });
});

describe('presets inside a harness', () => {
    it('ships the four everyday file tools core and the rest searchable', () => {
        expect(fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        expect(syntaxCheck.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);
        expect(fileRead.visibility).toBe('core');
        expect(fileEdit.visibility).toBe('core');
        expect(fileGlob.visibility).toBe('core');
        expect(fileList.visibility).toBe('searchable');
        expect(commandRun.visibility).toBe('searchable');
        expect(syntaxCheck.visibility).toBe('searchable');
    });

    it('registers a core file tool under its export name and runs it without discovery', async () => {
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c1', 'fileRead', '{"paths":["harness.txt"]}'),
                answer('read it')
            ])
        });

        const writer = harness({ agents: { writer: entry }, tools: { fileRead, fileWrite } });

        await fileWrite([{ path: 'harness.txt', content: 'seeded content' }]);

        // The registry key renames the tool, so the model calls `fileRead`.
        expect(writer.tools.fileRead.name).toBe('fileRead');
        // R18: core, so the very first declaration already contains it.
        expect(writer.tools.fileRead.visibility).toBe('core');

        const message = await writer('read the file');

        expect(message.content).toBe('read it');
        // user -> fileRead call -> result -> answer: no toolRequest round.
        expect(entry.messages.map((item) => item.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        // The single-property rule unwrapped the model's {"paths":[...]} to the
        // array, and the result serialized as the ordered array.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual([
            { path: join(workdir, 'harness.txt'), content: 'seeded content' }
        ]);
    });

    it('discovers syntaxCheck and hands it the whole two-property object', async () => {
        // syntaxCheck declares `code` and `language`, so the single-property rule
        // does not apply: the implementation receives the object a direct call
        // would pass.
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c0', 'toolRequest', '{"tags":["python"]}'),
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
