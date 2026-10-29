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

// Mirrors FILE_READ_CONTENT_BUDGET in ./files/fileRead. Importing the constant
// through the package would evaluate the implementation module eagerly and break
// the lazy-loading contract (see laziness.test.ts).
const FILE_READ_CONTENT_BUDGET = 64 * 1024;

// Mirrors FILE_LIST_CONTENT_BUDGET / FILE_LIST_DEFAULT_LIMIT in ./files/fileList
// for the same lazy-loading reason as above.
const FILE_LIST_CONTENT_BUDGET = 64 * 1024;
const FILE_LIST_DEFAULT_LIMIT = 200;

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

        // A missing path is now a not-found ENTRY (R1), so "the code did not run" is
        // proven by the ENOENT error on that entry instead of a thrown call.
        await expect(fileRead(['executed.txt', 'executed-js.txt'])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'executed.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0,
                    error: {
                        code: 'ENOENT',
                        message:
                            'fileRead could not find "executed.txt": no such file or directory (ENOENT).'
                    }
                },
                {
                    path: join(workdir, 'executed-js.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0,
                    error: {
                        code: 'ENOENT',
                        message:
                            'fileRead could not find "executed-js.txt": no such file or directory (ENOENT).'
                    }
                }
            ],
            truncated: false,
            bytes: 0,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
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

        // The batched read returns one bounded window per path, in request order.
        // `# Hello` is one unterminated line, so the window ended at EOF.
        await expect(fileRead(['notes/hello.md'])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'notes', 'hello.md'),
                    content: '# Hello',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 7
                }
            ],
            truncated: false,
            bytes: 7,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
        // Results carry the directory they came from, so one flat list can hold
        // several directories without ambiguity.
        //
        // The listing is PAGINATED (fileList.ts header): the legacy string argument
        // still selects the directory, but the answer is one bounded page.
        await expect(fileList('notes')).resolves.toEqual({
            entries: ['notes/hello.md'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 14,
            contentBudget: FILE_LIST_CONTENT_BUDGET
        });
    });

    it('reads several files in one call', async () => {
        await fileWrite([
            { path: 'multi-read/a.txt', content: 'a' },
            { path: 'multi-read/b.txt', content: 'b' }
        ]);

        await expect(fileRead(['multi-read/b.txt', 'multi-read/a.txt'])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'multi-read', 'b.txt'),
                    content: 'b',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 1
                },
                {
                    path: join(workdir, 'multi-read', 'a.txt'),
                    content: 'a',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 1
                }
            ],
            truncated: false,
            bytes: 2,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
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

        await expect(fileList('tree')).resolves.toEqual({
            entries: ['tree/a.txt', 'tree/sub/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: FILE_LIST_DEFAULT_LIMIT,
            // 'tree/a.txt' (10) + 'tree/sub/' (9) UTF-8 bytes.
            bytes: 19,
            contentBudget: FILE_LIST_CONTENT_BUDGET
        });
    });

    it('lists several directories in one call, grouped in the caller order', async () => {
        await fileWrite([
            { path: 'multi/src/a.ts', content: 'a' },
            { path: 'multi/task/b.ts', content: 'b' }
        ]);

        await expect(fileList(['multi/task', 'multi/src'])).resolves.toEqual({
            entries: ['multi/task/b.ts', 'multi/src/a.ts'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: FILE_LIST_DEFAULT_LIMIT,
            // 'multi/task/b.ts' (15) + 'multi/src/a.ts' (14) UTF-8 bytes.
            bytes: 29,
            contentBudget: FILE_LIST_CONTENT_BUDGET
        });
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
            // 'marker.txt' (10) + 'sub/' (4) UTF-8 bytes, no prefix (".").
            const defaultPage = {
                entries: ['marker.txt', 'sub/'],
                truncated: false,
                nextOffset: null,
                offset: 0,
                limit: FILE_LIST_DEFAULT_LIMIT,
                bytes: 14,
                contentBudget: FILE_LIST_CONTENT_BUDGET
            };
            await expect(fileList(undefined)).resolves.toEqual(defaultPage);
            // Omitted and explicit ["."] are the same request.
            await expect(fileList(['.'])).resolves.toEqual(defaultPage);
        } finally {
            process.chdir(previous);
        }
    });

    it('overwrites an existing file', async () => {
        await fileWrite([{ path: 'over.txt', content: 'first' }]);
        await fileWrite([{ path: 'over.txt', content: 'second' }]);

        await expect(fileRead(['over.txt'])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'over.txt'),
                    content: 'second',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 6
                }
            ],
            truncated: false,
            bytes: 6,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('reports a missing file as an ordered not-found entry', async () => {
        // R1: a missing path is data now, not a thrown error. The entry keeps the
        // absolute resolved path, empty content, 0 bytes, and the ENOENT error.
        await expect(fileRead(['nope/missing.txt'])).resolves.toEqual({
            files: [
                {
                    path: join(workdir, 'nope/missing.txt'),
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 0,
                    error: {
                        code: 'ENOENT',
                        message:
                            'fileRead could not find "nope/missing.txt": no such file or directory (ENOENT).'
                    }
                }
            ],
            truncated: false,
            bytes: 0,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
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
        // user -> fileRead call -> result -> pause -> answer: no toolRequest round.
        // IMMEDIATE CONTINUATION (R1): fileRead does real fs I/O, so it is still
        // pending when the harness takes the next turn. The scripted answer is
        // therefore committed as a PAUSE (index 3), the real result is inserted at
        // its original call position (index 2), and the model is re-requested once
        // the read lands. The scripted transport has no further turn left, so it
        // repeats its last answer for that final request (index 4).
        expect(entry.messages.map((item) => item.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
            'assistant'
        ]);
        expect((entry.messages[3] as { content: string }).content).toBe('read it');
        expect((entry.messages[4] as { content: string }).content).toBe('read it');
        // The single-property rule unwrapped the model's {"paths":[...]} to the
        // array, and the result serialized as the bounded batch object.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            files: [
                {
                    path: join(workdir, 'harness.txt'),
                    content: 'seeded content',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 14
                }
            ],
            truncated: false,
            bytes: 14,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
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
