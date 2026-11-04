// The preset tools.
//
// Each one is exercised twice, because that is the contract: standalone (called
// directly) and registered on a harness (called by the model). File tools run
// inside a temporary directory so they never touch the repository.
//
// T14: the four file tools are BATCHED (one array argument each). The rename moved
// `fileWrite` to `write`, split `fileGlob` into `glob` (names) and `grep` (lines), and
// moved `syntax` to `syntax` — with no old names on the wire, so this file also
// pins that the PUBLIC ENTRY exports the new names. Names follow
// `<namespace><action>` except the two bare search verbs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    agent,
    harness,
    shell,
    edit,
    glob,
    grep,
    fileList,
    read,
    write,
    syntax
} from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

// Mirrors FILE_READ_CONTENT_BUDGET in ./files/read. Importing the constant
// through the package would evaluate the implementation module eagerly and break
// the lazy-loading contract (see laziness.test.ts).
const FILE_READ_CONTENT_BUDGET = 64 * 1024;

// Mirrors FILE_LIST_CONTENT_BUDGET / FILE_LIST_DEFAULT_LIMIT in ./files/fileList
// for the same lazy-loading reason as above.
const FILE_LIST_CONTENT_BUDGET = 64 * 1024;
const FILE_LIST_DEFAULT_LIMIT = 200;

// Mirrors FILE_GREP_CONTENT_BUDGET in ./files/grep.tool for the same reason: grep is
// the content half of the old fileGlob, and its aggregate budget is part of the
// result shape a model reads. glob now publishes the same size budget for its path
// text, so both are mirrored here rather than imported (importing would evaluate the
// implementation module eagerly and break laziness.test.ts).
const FILE_GREP_CONTENT_BUDGET = 64 * 1024;
const FILE_GLOB_CONTENT_BUDGET = 64 * 1024;

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

describe('syntax', () => {
    it('checks JavaScript when the caller names the language', async () => {
        await expect(
            syntax({ code: 'const a = 1; function f() { return a; }', language: 'javascript' })
        ).resolves.toBe(true);
        await expect(syntax({ code: 'const = ;', language: 'javascript' })).resolves.toBe(false);
    });

    it('parses JavaScript as a classic script only', async () => {
        await expect(
            syntax({ code: 'for (const x of [1]) { console.log(x); }', language: 'javascript' })
        ).resolves.toBe(true);
        // Classic-script parser: import/export is module syntax.
        await expect(syntax({ code: 'import x from "y";', language: 'javascript' })).resolves.toBe(
            false
        );
    });

    it('checks Python when the caller names the language', async () => {
        await expect(
            syntax({ code: 'def f(x):\n    return x + 1', language: 'python' })
        ).resolves.toBe(true);
        await expect(syntax({ code: 'def f(x) return x', language: 'python' })).resolves.toBe(
            false
        );
    });

    it('checks the languages the rename added, through the public entry', async () => {
        // R3: TypeScript/TSX/JSX/JSON are reachable through `@underload/harness`, and
        // the aliases a caller really types ("ts", ".tsx") resolve too.
        await expect(syntax({ code: 'const a: number = 1;', language: 'ts' })).resolves.toBe(true);
        await expect(syntax({ code: 'const a: number = 1;', language: '.ts' })).resolves.toBe(true);
        await expect(syntax({ code: 'const el = <div />;', language: 'tsx' })).resolves.toBe(true);

        // The DIALECT decides the grammar: the same JSX is a parse error in plain .ts.
        await expect(
            syntax({ code: 'const el = <div />;', language: 'typescript' })
        ).resolves.toBe(false);
        await expect(
            syntax({ code: 'export const El = () => <div />;', language: 'jsx' })
        ).resolves.toBe(true);

        await expect(syntax({ code: '{"a":1}', language: 'json' })).resolves.toBe(true);
        await expect(syntax({ code: '{"a":1,}', language: 'json' })).resolves.toBe(false);

        // transpileModule reports SYNTAX diagnostics only, so a type error is a valid
        // parse — the limit the description publishes.
        await expect(syntax({ code: 'const a: number = "s";', language: 'ts' })).resolves.toBe(true);
    });

    it('does not execute the code it checks', async () => {
        // If either ran, it would create the file.
        await expect(
            syntax({ code: 'open("executed.txt", "w").write("x")', language: 'python' })
        ).resolves.toBe(true);
        await expect(
            syntax({
                code: 'require("node:fs").writeFileSync("executed-js.txt", "x");',
                language: 'javascript'
            })
        ).resolves.toBe(true);

        // A missing path is now a not-found ENTRY (R1), so "the code did not run" is
        // proven by the ENOENT error on that entry instead of a thrown call.
        await expect(read(['executed.txt', 'executed-js.txt'])).resolves.toEqual({
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
                            'read could not find "executed.txt": no such file or directory (ENOENT).'
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
                            'read could not find "executed-js.txt": no such file or directory (ENOENT).'
                    }
                }
            ],
            truncated: false,
            bytes: 0,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });

    it('rejects an unsupported language instead of guessing', async () => {
        // R3: `language` has no schema enum any more, so BOTH a model call and a
        // direct call are answered by the implementation — which refuses rather than
        // returning a verdict for a language with no parser here.
        await expect(syntax({ code: 'puts 1', language: 'ruby' as never })).rejects.toThrow(
            'syntax supports javascript (js), typescript (ts), tsx, jsx, json, python (py, python3); received "ruby". A language outside that list has no parser here, so it is reported as an error rather than answered with a syntax verdict.'
        );
    });

    it('has a standard tool shape', () => {
        expect(syntax.name).toBe('syntax');

        // The description names every parser, in the case the schema uses, so a model
        // selecting by description finds the language it actually has.
        for (const language of ['javascript', 'typescript', 'tsx', 'jsx', 'json', 'python']) {
            expect(syntax.description).toContain(`"${language}"`);
        }

        expect(syntax.parameters).toMatchObject({
            type: 'object',
            required: ['code', 'language']
        });

        // R3: `language` stays a validated free string — no enum, because an
        // unsupported name has to produce the tool's own error, not a schema rejection.
        const syntaxParameters = syntax.parameters as { properties?: Record<string, unknown> };

        expect(syntaxParameters.properties).not.toHaveProperty('language.enum');
    });
});

describe('file tools', () => {
    it('writes, reads, and lists with the batched arguments', async () => {
        const written = await write([{ path: 'notes/hello.md', content: '# Hello' }]);

        expect(written).toEqual([{ path: join(workdir, 'notes', 'hello.md'), bytes: 7 }]);

        // The batched read returns one bounded window per path, in request order.
        // `# Hello` is one unterminated line, so the window ended at EOF.
        await expect(read(['notes/hello.md'])).resolves.toEqual({
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

    it('finds names with glob and lines with grep — the split of the old fileGlob', async () => {
        await write([
            { path: 'search-split/a.ts', content: 'const a = 1;\n// TODO: one\n' },
            { path: 'search-split/nested/b.js', content: 'TODO: two\n' },
            { path: 'search-split/notes.md', content: 'nothing here\n' }
        ]);

        // glob answers with PATHS ONLY, root-prefixed. The result carries the paging
        // window and the coverage counters beside the list, so `toEqual` on the whole
        // object pins that the DEFAULT call reports a complete, un-truncated page.
        await expect(glob({ paths: ['search-split'], patterns: ['*.ts'] })).resolves.toEqual({
            files: ['search-split/a.ts'],
            truncated: false,
            offset: 0,
            limit: 100,
            nextOffset: null,
            bytes: 'search-split/a.ts'.length,
            contentBudget: FILE_GLOB_CONTENT_BUDGET,
            stopReason: 'complete',
            partial: false,
            searched: { inScope: 3, roots: 1 },
            excluded: {
                ignoredFiles: 0,
                prunedDirectories: 0,
                skippedDirectories: 0,
                unreadableDirectories: 0,
                symlinks: 0,
                ignoreFilesParsed: 0,
                ignoreRulesTruncated: false
            },
            patterns: ['*.ts']
        });

        // grep answers with LINES, in the same walk order, with the byte accounting and
        // the same coverage fields.
        await expect(grep({ pattern: 'TODO', paths: ['search-split'] })).resolves.toEqual({
            output: 'content',
            matches: [
                {
                    path: 'search-split/a.ts',
                    line: 2,
                    text: '// TODO: one',
                    textTruncated: false,
                    bytes: 12
                },
                {
                    path: 'search-split/nested/b.js',
                    line: 1,
                    text: 'TODO: two',
                    textTruncated: false,
                    bytes: 9
                }
            ],
            truncated: false,
            offset: 0,
            limit: 100,
            nextOffset: null,
            bytes: 21,
            contentBudget: FILE_GREP_CONTENT_BUDGET,
            partial: false,
            stopReason: 'complete',
            // All three files in scope were opened and scanned; only two matched. The
            // gap between `inScope` and `matches.length` is the pattern filter, and the
            // gap between `inScope` and `scanned` would be a skip policy.
            searched: { inScope: 3, scanned: 3, roots: 1 },
            skipped: { tooLarge: 0, binary: 0, unreadable: 0 },
            excluded: {
                ignoredFiles: 0,
                prunedDirectories: 0,
                skippedDirectories: 0,
                unreadableDirectories: 0,
                symlinks: 0,
                ignoreFilesParsed: 0,
                ignoreRulesTruncated: false
            },
            patterns: ['**/*']
        });

        // There is no mode rule left to remember: glob has no `content` property, and
        // grep's pattern is required, so a stale `fileGlob({ content })` request cannot
        // be silently reinterpreted as something else. The casts keep the reads inside
        // the `Record<string, unknown>` shape the Tool contract publishes.
        const globParameters = glob.parameters as { properties?: Record<string, unknown> };
        const grepParameters = grep.parameters as { required?: string[] };

        expect(globParameters.properties).not.toHaveProperty('content');
        expect(grepParameters.required).toEqual(['pattern']);
    });

    it('reads several files in one call', async () => {
        await write([
            { path: 'multi-read/a.txt', content: 'a' },
            { path: 'multi-read/b.txt', content: 'b' }
        ]);

        await expect(read(['multi-read/b.txt', 'multi-read/a.txt'])).resolves.toEqual({
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
        await write([
            { path: 'multi-edit/a.txt', content: 'alpha\n' },
            { path: 'multi-edit/b.txt', content: 'beta\n' }
        ]);

        await expect(
            edit([
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
        await write([
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
        await write([
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
        await write([{ path: 'defaults/empty/marker.txt', content: 'm' }]);
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
        await write([{ path: 'over.txt', content: 'first' }]);
        await write([{ path: 'over.txt', content: 'second' }]);

        await expect(read(['over.txt'])).resolves.toEqual({
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
        await expect(read(['nope/missing.txt'])).resolves.toEqual({
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
                            'read could not find "nope/missing.txt": no such file or directory (ENOENT).'
                    }
                }
            ],
            truncated: false,
            bytes: 0,
            contentBudget: FILE_READ_CONTENT_BUDGET
        });
    });
});

describe('shell', () => {
    it('returns exit code, stdout, and stderr', async () => {
        const result = await shell({ command: 'node -e "console.log(42)"' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('42');
        expect(result.stderr).toBe('');
    });

    it('returns a non-zero exit as data instead of throwing', async () => {
        const result = await shell({ command: 'node -e "process.exit(3)"' });

        expect(result.exitCode).toBe(3);
    });

    it('honours cwd', async () => {
        await write([{ path: 'cwd-test/marker.txt', content: 'x' }]);
        const result = await shell({
            command: 'node -e "console.log(process.cwd())"',
            cwd: 'cwd-test'
        });

        expect(result.stdout.trim().endsWith('cwd-test')).toBe(true);
    });
});

describe('presets inside a harness', () => {
    it('ships the five everyday file tools core and the rest searchable', () => {
        expect(read.tags).toEqual(['files', 'read', 'filesystem']);
        expect(syntax.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'typescript',
            'json',
            'python',
            'validation'
        ]);
        expect(read.visibility).toBe('core');
        expect(edit.visibility).toBe('core');
        expect(write.visibility).toBe('core');
        // Both search surfaces are core (R18): naming a file and finding a line are the
        // everyday first steps of a code task.
        expect(glob.visibility).toBe('core');
        expect(grep.visibility).toBe('core');
        expect(fileList.visibility).toBe('searchable');
        expect(shell.visibility).toBe('searchable');
        expect(syntax.visibility).toBe('searchable');
    });

    it('registers a core file tool under its export name and runs it without discovery', async () => {
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c1', 'read', '{"paths":["harness.txt"]}'),
                answer('read it')
            ])
        });

        const writer = harness({ agents: { writer: entry }, tools: { read, write } });

        await write([{ path: 'harness.txt', content: 'seeded content' }]);

        // The registry key renames the tool, so the model calls `read`.
        expect(writer.tools.read.name).toBe('read');
        // R18: core, so the very first declaration already contains it.
        expect(writer.tools.read.visibility).toBe('core');

        const message = await writer('read the file');

        expect(message.content).toBe('read it');
        // user -> read call -> real result -> answer: no toolRequest round, and NO
        // pause turn spent on a placeholder.
        //
        // T2/R3: `read` declares `mode: 'sync'`, so its completion joins the message's
        // SYNC GROUP and the batch gate holds the next request until the result was
        // DELIVERED. `read` does real fs I/O, so this is exactly where the historical
        // background behaviour differed: a pending sync call used to let the harness
        // commit a pause turn and re-request once the result landed (a 5-message
        // transcript). Under the sync policy the model is asked again only after the
        // whole sync batch settled, so the transcript is four messages and the scripted
        // answer is consumed once.
        expect(entry.messages.map((item) => item.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        expect((entry.messages[3] as { content: string }).content).toBe('read it');
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

    it('discovers syntax and hands it the whole two-property object', async () => {
        // syntax declares `code` and `language`, so the single-property rule
        // does not apply: the implementation receives the object a direct call
        // would pass.
        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c0', 'toolRequest', '{"tags":["python"]}'),
                callTool(
                    'c1',
                    'syntax',
                    '{"code":"def f():\\n    pass","language":"python"}'
                ),
                answer('valid')
            ])
        });

        const writer = harness({ agents: { writer: entry }, tools: { syntax } });
        await writer('check it');

        expect(JSON.parse((entry.messages[2] as { content: string }).content).enabled).toEqual([
            'syntax'
        ]);
        expect((entry.messages[4] as { content: string }).content).toBe('true');
    });
});
