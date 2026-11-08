// The harness command registry — registration order, collisions, and the built-ins.
//
// What this file pins (all of it harness-level; the grammar itself is unit-tested
// in src/core/command.test.ts):
//   - a harness starts with the five built-ins (/help, /tools, /task, /websearch,
//     /webfetch) even when `plugins` is absent;
//   - `/task` mutates THIS harness's task store (the model path and snapshot()
//     both see it), and add/complete/reopen/remove/claim/release/takeover map onto
//     the tool's real parameter schema. The three content verbs (complete, reopen,
//     remove) are GUARDED writes: `executeTool` always carries an agent identity,
//     so the command reads the store first and sends the current `expects` tokens
//     (src/core/task.ts). An unknown id gets no token and reports the tool's own
//     unknown-id rejection;
//   - `/task claim|release|takeover` are OWNERSHIP actions: they move the holder
//     pair without touching `rev`, so they need no token, and they run unthreaded
//     (`executeTool` supplies no threadId), which makes the operator a holder that
//     is distinct from every conversation's;
//   - `/websearch` and `/webfetch` are pass-throughs to `search`/`fetch`, and when
//     the tool is absent they answer a helpful error result instead of throwing;
//   - `commands` entries register after the built-ins and a collision (with a
//     built-in or inside the list) fails CONSTRUCTION;
//   - a plugin's `addCommand` runs last and REPLACES by name;
//   - `registerCommand` replaces at runtime, `commands` is a frozen copy, and
//     `executeCommand` never calls the model and never emits a progress event
//     (the underlying tool call still fires stateChange('tool_execute')).
//
// Expectations come from the documented contract, not from whatever the
// implementation printed: a usage mistake is `{ content, isError: true }`, a host
// bug (not a command / unknown name) is a HarnessError.
//
// Cross-references:
//   - ./core/command.ts             — parseCommandLine/formatCommandHelp (unit)
//   - ./core/command-builtins.ts    — the built-in implementations
//   - ./harness.task.test.ts        — the same scripted-agent conventions

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import { TASK_DEFAULT_LEASE_MS } from './core/task';
import type {
    Agent,
    HarnessCommand,
    HarnessCommandConfiguration,
    HarnessEvent,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessSnapshot,
    TaskChange,
    TaskChangeOp,
    TaskItem,
    Tool
} from '@underload/harness';

// A stream that answers immediately and RECORDS every model request, so the
// "a command never spends a model turn" assertions have something to count.
const scripted = (seen: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(
        request: HarnessStreamRequest
    ): AsyncIterable<HarnessStreamEvent> {
        seen.push(request);
        index++;
        yield { type: 'text', delta: `answer ${index}` };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };
};

const brain = (seen: HarnessStreamRequest[]): Agent =>
    agent({ model: 'merge/ds4-flash', stream: scripted(seen) });

// Presets OFF: the registry is exactly the core set plus whatever a test adds, so
// `/tools` and the web pass-throughs are predictable.
const quiet = (
    entry: Agent,
    tools: Record<string, Tool> = {},
    commands?: readonly HarnessCommandConfiguration[]
) =>
    harness({
        agents: { writer: entry },
        tools,
        presets: false,
        ...(commands === undefined ? {} : { commands })
    });

// The five built-ins, in the order the registry sorts them for an assertion.
const BUILT_INS = ['help', 'task', 'tools', 'webfetch', 'websearch'];

// The task store's timestamps are all `Date.now()`/`new Date()` (src/core/task.ts
// line 1069/1109/1304), so the `/task` block pins the clock: `updatedAt`, the
// change-feed stamps, and a claim's `leaseUntil = now + TASK_DEFAULT_LEASE_MS`
// then have ONE exact expected value each instead of "some string". Only Date is
// faked — the command path schedules no timer, and the model path is not used
// inside that block.
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);
const LEASE_UNTIL = EPOCH_MS + TASK_DEFAULT_LEASE_MS;
const LEASE_ISO = new Date(LEASE_UNTIL).toISOString();

// The page every successful `task` call returns (src/core/task.ts): one shape for
// a read, an add, a patch, a removal and an ownership action alike, now plus
// `storeRev` — one increment per RECORDED event (a claim renewal, a no-op release
// and a read record nothing, so they leave it where it was).
const taskPage = (
    tasks: unknown[],
    total: number,
    completed: number,
    pending: number,
    storeRev: number
) => ({
    tasks,
    counts: { total, completed, pending },
    page: { offset: 0, limit: 20, hasMore: false },
    storeRev
});

// One stored record as the COMMAND door writes it. Attribution comes from the
// caller: `executeTool` hands the tool the harness's primary (`writer`) and NO
// threadId, so `updatedBy` is set and `updatedThreadId` is absent entirely.
// `rev` is the content revision — 1 on add, +1 only for a real text/completed
// change, never for a claim.
const record = (id: string, text: string, completed: boolean, rev: number) => ({
    id,
    text,
    completed,
    rev,
    updatedBy: 'writer',
    updatedAt: EPOCH_ISO
});

// The same record while the OPERATOR holds it. A claim from an unthreaded caller
// must not keep a thread tag (core/task.ts setClaim), so `ownerThreadId` is absent
// and the holder pair is ("writer", undefined).
const claimedRecord = (id: string, text: string, completed: boolean, rev: number) => ({
    ...record(id, text, completed, rev),
    owner: 'writer',
    leaseUntil: LEASE_UNTIL
});

// One change-feed entry, in the canonical key order core/task.ts logs
// (`rev, id, op, by, threadId, at, fields, itemRev`), stamped at the frozen
// instant. `by`/`threadId` appear only when the caller had that identity, which is
// why the release `harness.stopThread`/`deleteThread` trigger (core `releaseThread`)
// is distinguishable from a voluntary one: it names the thread and has no `by`.
const event = (
    rev: number,
    id: string,
    op: TaskChangeOp,
    shape: {
        by?: string;
        threadId?: string;
        fields?: Array<'text' | 'completed'>;
        itemRev?: number;
    } = {}
): TaskChange => ({
    rev,
    id,
    op,
    ...(shape.by === undefined ? {} : { by: shape.by }),
    ...(shape.threadId === undefined ? {} : { threadId: shape.threadId }),
    at: EPOCH_ISO,
    ...(shape.fields === undefined ? {} : { fields: shape.fields }),
    ...(shape.itemRev === undefined ? {} : { itemRev: shape.itemRev })
});

const taskUsage =
    'usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>... | claim <id>... | release <id>... | takeover <id>...]';

describe('command registry', () => {
    it('registers the five built-ins on a harness with no commands and no plugins', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        expect(Object.keys(writer.commands).sort()).toEqual(BUILT_INS);
        expect(writer.commands.task).toMatchObject({
            name: 'task',
            usage: '/task [list | add <text> | complete <id> | reopen <id> | remove <id>... | claim <id>... | release <id>... | takeover <id>...]'
        });
        // Every built-in carries the description /help renders.
        for (const name of BUILT_INS) {
            expect((writer.commands[name] as HarnessCommand).description.length).toBeGreaterThan(0);
        }
        expect(seen).toHaveLength(0);
    });

    it('exposes commands as a frozen copy that cannot mutate the registry', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));
        const before = writer.commands;

        expect(Object.isFrozen(before)).toBe(true);
        expect(() => {
            (before as Record<string, unknown>).injected = 1;
        }).toThrow(TypeError);
        expect(Object.keys(writer.commands).sort()).toEqual(BUILT_INS);

        // A replacement at runtime is visible in the NEXT read, and the read taken
        // before it stays untouched (it is a copy, not a live view).
        writer.registerCommand({ name: 'later', description: 'L.', execute: () => ({ content: 'l' }) });
        expect(Object.keys(writer.commands).sort()).toEqual([...BUILT_INS, 'later'].sort());
        expect('later' in before).toBe(false);
    });

    it('throws for a line that is not a command and for an unknown name', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await expect(writer.executeCommand('hello')).rejects.toThrow('a command must start with "/"');
        await expect(writer.executeCommand('/nope')).rejects.toThrow('unknown command: /nope');
        // A bare "/" is command-shaped, so the honest answer names the empty name.
        await expect(writer.executeCommand('/')).rejects.toThrow('unknown command: /');
        expect(seen).toHaveLength(0);
    });

    it('registers configuration commands, and fails construction on any collision', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            commands: [
                {
                    // A name with a leading slash and upper case is canonicalized,
                    // exactly like the parser canonicalizes a typed line.
                    name: '/Echo',
                    description: ' Echo the arguments back. ',
                    usage: ' /echo <text> ',
                    execute: (context) => ({
                        content: JSON.stringify({
                            name: context.name,
                            args: context.args,
                            rest: context.rest,
                            input: context.input,
                            harnessName: context.harness.name,
                            commandCount: Object.keys(context.harness.commands).length
                        })
                    })
                }
            ]
        });

        expect(writer.commands.echo.description).toBe('Echo the arguments back.');
        expect(writer.commands.echo.usage).toBe('/echo <text>');

        // The context is what the shared parser produced: lowercased name, quoted
        // argument unquoted, raw tail, and the ORIGINAL line for echoing.
        expect((await writer.executeCommand('/ECHO say "hi there"  ')).content).toBe(
            JSON.stringify({
                name: 'echo',
                args: ['say', 'hi there'],
                rest: 'say "hi there"',
                input: '/ECHO say "hi there"  ',
                harnessName: 'writer',
                commandCount: 6
            })
        );

        // Colliding with a built-in, and repeating a name inside the list, are both
        // construction errors (fail fast, before any command runs).
        expect(() =>
            quiet(brain([]), {}, [
                { name: 'task', description: 'Mine.', execute: () => ({ content: 'x' }) }
            ])
        ).toThrow(
            'Command "/task" is already registered. Built-in commands and "commands" entries share one namespace and must be unique; use a plugin or harness.registerCommand() to override "/task".'
        );
        expect(() =>
            quiet(brain([]), {}, [
                { name: 'alpha', description: 'A.', execute: () => ({ content: 'a' }) },
                { name: 'ALPHA', description: 'B.', execute: () => ({ content: 'b' }) }
            ])
        ).toThrow('Command "/alpha" is already registered.');
        expect(seen).toHaveLength(0);
    });

    it('rejects an invalid name or a malformed definition at construction', () => {
        const attempt = (commands: unknown[], message: string) =>
            expect(() =>
                harness({
                    agents: { writer: brain([]) },
                    presets: false,
                    commands: commands as never
                })
            ).toThrow(message);

        attempt(
            [{ name: 'Bad Name!', description: 'A.', execute: () => ({ content: 'a' }) }],
            'Command name "Bad Name!" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".'
        );
        attempt(
            [{ description: 'Nameless.', execute: () => ({ content: 'a' }) }],
            'A command registered by the "commands" configuration requires a name'
        );
        attempt(
            [{ name: 'alpha', description: 'A.' }],
            'Command "/alpha" requires an execute function.'
        );
        attempt(
            [{ name: 'alpha', execute: () => ({ content: 'a' }) }],
            'Command "/alpha" requires a description.'
        );
        attempt(
            [
                {
                    name: 'alpha',
                    description: 'A.',
                    usage: 7,
                    execute: () => ({ content: 'a' })
                }
            ],
            'Command "/alpha" usage must be a string.'
        );
    });

    it('lets a plugin add a command and OVERRIDE a built-in by name', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            plugins: [
                {
                    name: 'extra',
                    setup: (api) => {
                        api.addCommand('/plugin', {
                            description: 'From a plugin.',
                            execute: () => ({ content: 'plugin', data: { ok: true } })
                        });
                        // Plugins apply after the built-ins, so this is the
                        // supported way to replace one.
                        api.addCommand('help', {
                            description: 'Replaced help.',
                            execute: () => ({ content: 'replaced help' })
                        });
                    }
                }
            ]
        });

        expect(writer.commands.plugin.description).toBe('From a plugin.');
        expect(writer.commands.help.description).toBe('Replaced help.');
        expect(await writer.executeCommand('/plugin')).toEqual({
            content: 'plugin',
            data: { ok: true }
        });
        expect(await writer.executeCommand('/help')).toEqual({ content: 'replaced help' });
        expect(seen).toHaveLength(0);
    });

    it('replaces a command at runtime through registerCommand', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        const first = writer.registerCommand({
            name: 'Greet',
            description: 'First.',
            execute: () => ({ content: 'first' })
        });

        expect(first.name).toBe('greet');
        expect(writer.commands.greet.description).toBe('First.');
        expect((await writer.executeCommand('/greet')).content).toBe('first');

        // Replace-by-name (mirrors registerTool): no error, one entry.
        writer.registerCommand({ name: '/GREET', description: 'Second.', execute: () => ({ content: 'second' }) });

        expect(Object.keys(writer.commands).filter((name) => name === 'greet')).toEqual(['greet']);
        expect(writer.commands.greet.description).toBe('Second.');
        expect((await writer.executeCommand('/greet')).content).toBe('second');

        // Validation still applies at runtime, and a rejected candidate leaves the
        // registry untouched.
        expect(() => writer.registerCommand({ name: '9bad', description: 'X', execute: () => ({ content: 'x' }) })).toThrow(
            'Command name "9bad" is not valid'
        );
        expect((await writer.executeCommand('/greet')).content).toBe('second');
        expect(seen).toHaveLength(0);
    });

    it('normalizes a command result and lets a thrown error propagate', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        writer.registerCommand({ name: 'void', description: 'Nothing.', execute: () => undefined as never });
        writer.registerCommand({
            name: 'weird',
            description: 'Non-string content.',
            execute: () => ({ content: 42 as never, isError: false })
        });
        writer.registerCommand({
            name: 'boom',
            description: 'Throws.',
            execute: () => {
                throw new Error('command boom');
            }
        });

        // `content` is always a string for the host; the optional keys ride along
        // only when the command set them.
        expect(await writer.executeCommand('/void')).toEqual({ content: '' });
        expect(await writer.executeCommand('/weird')).toEqual({ content: '', isError: false });
        await expect(writer.executeCommand('/boom')).rejects.toThrow('command boom');
        expect(seen).toHaveLength(0);
    });

    it('spends no model request and no progress event, but still notifies persistence', async () => {
        const seen: HarnessStreamRequest[] = [];
        const progress: HarnessEvent[] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            report: {
                progress: (event) => {
                    progress.push(event);
                },
                stateChange: (event) => {
                    changes.push(event);
                }
            }
        });

        await writer.executeCommand('/help');
        await writer.executeCommand('/tools task');
        await writer.executeCommand('/task add "testing"');
        await writer.executeCommand('/task complete 1');

        // No model turn, and no conversation progress events.
        expect(seen).toHaveLength(0);
        expect(progress).toEqual([]);
        // The two calls that ran the `task` tool DID fire the ordinary tool
        // state-change, which is what a server uses to schedule a save. Three
        // events, not two: `/task complete` is a GUARDED write, so the command reads
        // the store (one `tool_execute`) before patching it (the second) — see
        // src/core/command-builtins.ts `readTaskRevisions`.
        expect(changes).toEqual([
            { type: 'state_change', reason: 'tool_execute', tool: 'task' },
            { type: 'state_change', reason: 'tool_execute', tool: 'task' },
            { type: 'state_change', reason: 'tool_execute', tool: 'task' }
        ]);

        // Proof the counter above is meaningful: a real run does hit the stream.
        await writer('now talk to the model');
        expect(seen).toHaveLength(1);
    });
});

describe('/task', () => {
    // THE FROZEN CLOCK (see EPOCH_ISO above): every `updatedAt`, every change-feed
    // `at`, and every claim `leaseUntil` in this block is then one exact value.
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(EPOCH_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('adds, lists, completes, reopens, and removes through the live task store', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        // An untouched store records nothing, so `storeRev` is 0 on the first read.
        expect(await writer.executeCommand('/task')).toEqual({
            content: 'No tasks.\n0 total, 0 completed, 0 pending\npage: offset 0, limit 20, showing 0',
            data: taskPage([], 0, 0, 0, 0)
        });

        // `/task add "testing"` — the quoted phrase is ONE task text. An ADD is not
        // a guarded write (there is no prior record), so it needs no token; `rev`
        // starts at 1 and the primary is credited because executeTool has one.
        expect(await writer.executeCommand('/task add "testing"')).toEqual({
            content: '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
            data: taskPage([record('1', 'testing', false, 1)], 1, 0, 1, 1)
        });

        // A later add joins the remaining tokens, and `/task` re-reads the list.
        expect((await writer.executeCommand('/task add fix  the build')).content).toBe(
            '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2'
        );
        expect((await writer.executeCommand('/task list')).content).toBe(
            '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2'
        );
        expect(await writer.executeCommand('/task complete 1')).toEqual({
            content: '#1 [x] testing\n#2 [ ] fix the build\n2 total, 1 completed, 1 pending\npage: offset 0, limit 20, showing 2',
            // One RECORDED event for the flip (storeRev 3), and `rev` moves by
            // exactly one because one content field changed.
            data: taskPage(
                [record('1', 'testing', true, 2), record('2', 'fix the build', false, 1)],
                2,
                1,
                1,
                3
            )
        });
        expect(await writer.executeCommand('/task reopen 1')).toEqual({
            content: '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2',
            data: taskPage(
                [record('1', 'testing', false, 3), record('2', 'fix the build', false, 1)],
                2,
                0,
                2,
                4
            )
        });
        expect(await writer.executeCommand('/task remove 2')).toEqual({
            content: '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
            data: taskPage([record('1', 'testing', false, 3)], 1, 0, 1, 5)
        });

        // The store is THIS harness's: the host tool path and a snapshot both see
        // exactly what the command wrote.
        expect(await writer.executeTool('task', {})).toEqual(
            taskPage([record('1', 'testing', false, 3)], 1, 0, 1, 5)
        );
        expect(writer.snapshot().records.todos.items).toEqual([
            record('1', 'testing', false, 3)
        ]);
        expect(seen).toHaveLength(0);
    });

    it('sends the revision it just read, so a guarded command write is recorded not refused', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await writer.executeCommand('/task add "testing"');
        await writer.executeCommand('/task complete 1');
        await writer.executeCommand('/task remove 1');

        // The change feed is the proof. THREE events, all attributed to the primary
        // (executeTool's context), and the two guarded writes landed on the first
        // try — a blind write would have been refused with `guarded write: pass
        // expects [...]` and recorded nothing. The command's internal revision reads
        // are silent, so they add no events of their own.
        const feed = (await writer.executeTool('task', { since: 0 })) as { changes: unknown[] };

        expect(feed.changes).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'update', { by: 'writer', fields: ['completed'], itemRev: 2 }),
            event(3, '1', 'remove', { by: 'writer' })
        ]);
        expect(seen).toHaveLength(0);
    });

    it('claims, renews, releases and takes over records without touching rev', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await writer.executeCommand('/task add "testing"');

        // CLAIM — the holder pair is ("writer", undefined), because a command runs
        // through executeTool, which supplies no threadId. `rev` stays 1 (core/task
        // .ts: an ownership action never moves the content revision), and the
        // listing names the holder so a later refusal is explainable.
        const claim = await writer.executeCommand('/task claim 1');

        expect(claim).toEqual({
            content: `#1 [ ] testing (claimed by writer until ${LEASE_ISO})\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1`,
            data: taskPage([claimedRecord('1', 'testing', false, 1)], 1, 0, 1, 2)
        });

        // A second claim by the SAME holder is a renewal: the lease is re-armed at
        // the same frozen instant, nothing is logged, and `storeRev` stays 2.
        expect(await writer.executeCommand('/task claim 1')).toEqual(claim);
        // `/task takeover` of a claim the operator already holds is that same
        // renewal, not an override of somebody else.
        expect(await writer.executeCommand('/task takeover 1')).toEqual(claim);

        // RELEASE — the three ownership keys are DELETED, not nulled, so a snapshot
        // never carries an empty holder; the release is one recorded event.
        const released = {
            content: '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
            data: taskPage([record('1', 'testing', false, 1)], 1, 0, 1, 3)
        };

        expect(await writer.executeCommand('/task release 1')).toEqual(released);
        // Releasing an UNCLAIMED record is a no-op success: nothing to lift, so
        // nothing to log, and `storeRev` stays 3.
        expect(await writer.executeCommand('/task release 1')).toEqual(released);

        // The holder's own content write is NOT blocked by its own claim: the
        // operator claimed as ("writer", undefined) and writes as the same pair, so
        // `/task complete` applies and `rev` moves by exactly one.
        await writer.executeCommand('/task claim 1');

        expect(await writer.executeCommand('/task complete 1')).toEqual({
            content: `#1 [x] testing (claimed by writer until ${LEASE_ISO})\n1 total, 1 completed, 0 pending\npage: offset 0, limit 20, showing 1`,
            data: taskPage([claimedRecord('1', 'testing', true, 2)], 1, 1, 0, 5)
        });

        // The feed for the whole sequence: add, claim, release, claim, update — a
        // renewal contributes nothing, which is exactly why a heartbeat cannot knock
        // another agent off its CAS token.
        const feed = (await writer.executeTool('task', { since: 0 })) as { changes: unknown[] };

        expect(feed.changes).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'claim', { by: 'writer' }),
            event(3, '1', 'release', { by: 'writer' }),
            event(4, '1', 'claim', { by: 'writer' }),
            event(5, '1', 'update', { by: 'writer', fields: ['completed'], itemRev: 2 })
        ]);
        expect(seen).toHaveLength(0);
    });

    it('answers a usage mistake as an error result instead of throwing', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await writer.executeCommand('/task add "testing"');

        const cases: [string, string][] = [
            ['/task bogus', `/task: unknown action "bogus".\n${taskUsage}`],
            ['/task add', `/task: "add" needs the task text.\n${taskUsage}`],
            ['/task complete', `/task: "complete" needs a task id.\n${taskUsage}`],
            ['/task reopen', `/task: "reopen" needs a task id.\n${taskUsage}`],
            ['/task remove', `/task: "remove" needs at least one task id.\n${taskUsage}`],
            ['/task claim', `/task: "claim" needs at least one task id.\n${taskUsage}`],
            ['/task release', `/task: "release" needs at least one task id.\n${taskUsage}`],
            ['/task takeover', `/task: "takeover" needs at least one task id.\n${taskUsage}`],
            ['/task list 1', `/task: "list" takes no arguments (got 1).\n${taskUsage}`],
            ['/task complete 1 2', `/task: "complete" takes one id (got 2).\n${taskUsage}`]
        ];

        for (const [line, content] of cases) {
            expect(await writer.executeCommand(line)).toEqual({ content, isError: true });
        }

        // An unknown id is a TOOL rejection; a command still reports it as text. The
        // guarded verbs report it too — the command reads first, finds no revision,
        // and lets the tool name the missing id instead of inventing a CAS token.
        for (const line of ['/task complete 99', '/task reopen 99', '/task remove 99']) {
            const action = line.split(' ')[1] as string;

            expect(await writer.executeCommand(line)).toEqual({
                content: `/task ${action}: task has no task with id "99".`,
                isError: true
            });
        }

        // Same for the three ownership verbs, whose ids are validated by the tool.
        for (const action of ['claim', 'release', 'takeover']) {
            expect(await writer.executeCommand(`/task ${action} 99`)).toEqual({
                content: `/task ${action}: task has no task with id "99".`,
                isError: true
            });
        }

        // None of the rejected calls changed the list.
        expect((await writer.executeCommand('/task')).content).toBe(
            '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1'
        );
        expect(seen).toHaveLength(0);
    });
});

describe('/tools and /help', () => {
    it('lists registered tools sorted, and filters by a substring', async () => {
        const seen: HarnessStreamRequest[] = [];
        const zeta = tool({
            name: 'zeta',
            description: 'Zeta tool.',
            tags: ['zeta'],
            execute: () => 'zeta'
        });
        const writer = quiet(brain(seen), { zeta });

        const all = await writer.executeCommand('/tools');
        const names = Object.keys(writer.tools).sort();

        expect(all.data).toEqual(names);
        expect(all.content).toContain('zeta — Zeta tool.');
        // Long core descriptions are flattened to one preview line so the
        // inventory stays scannable (core/command-builtins.ts).
        expect(all.content.split('\n')).toHaveLength(names.length);
        expect(all.content.split('\n')[names.indexOf('task')]).toMatch(
            /^task — Maintain the task list for this harness session\./
        );

        // A filter matches the name or the description; `zeta` is unique here.
        expect(await writer.executeCommand('/tools zeta')).toEqual({
            content: 'zeta — Zeta tool.',
            data: ['zeta']
        });
        expect(await writer.executeCommand('/tools ZETA')).toEqual({
            content: 'zeta — Zeta tool.',
            data: ['zeta']
        });
        expect(await writer.executeCommand('/tools nothing-matches')).toEqual({
            content: '/tools: no registered tool matches "nothing-matches".\nusage: /tools [filter]',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('lists every command, shows one, and reports an unknown one', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        expect((await writer.executeCommand('/help')).content).toBe(
            [
                '/help  List the commands in this harness, or show one command.',
                '  usage: /help [command]',
                "/task  Read and change this session's task list.",
                '  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>... | claim <id>... | release <id>... | takeover <id>...]',
                '/tools  List the tools registered in this harness.',
                '  usage: /tools [filter]',
                "/webfetch  Fetch one http(s) page through this session's fetch tool.",
                '  usage: /webfetch <url>',
                "/websearch  Search the web with this session's configured search tool.",
                '  usage: /websearch <query>'
            ].join('\n')
        );

        // `/help <name>` — the same renderer over one entry, and the name lookup
        // is as forgiving as the parser.
        expect((await writer.executeCommand('/help task')).content).toBe(
            "/task  Read and change this session's task list.\n  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>... | claim <id>... | release <id>... | takeover <id>...]"
        );
        expect((await writer.executeCommand('/help /TASK')).content).toBe(
            "/task  Read and change this session's task list.\n  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>... | claim <id>... | release <id>... | takeover <id>...]"
        );
        expect(await writer.executeCommand('/help zzz')).toEqual({
            content: '/help: unknown command "/zzz".\nusage: /help [command]',
            isError: true
        });
        expect(await writer.executeCommand('/help task extra')).toEqual({
            content: '/help: "help" takes at most one command name.\nusage: /help [command]',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('renders the live registry, so /help follows a replacement', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        writer.registerCommand({
            name: 'zulu',
            description: 'Zulu command.',
            usage: '/zulu',
            execute: () => ({ content: 'z' })
        });

        expect((await writer.executeCommand('/help')).content).toContain(
            '/zulu  Zulu command.\n  usage: /zulu'
        );
        expect((await writer.executeCommand('/help zulu')).content).toBe(
            '/zulu  Zulu command.\n  usage: /zulu'
        );
        expect(seen).toHaveLength(0);
    });
});

describe('/websearch and /webfetch', () => {
    // A `search` tool with the REAL parameter schema (tools/websearch/index.ts):
    // `query` is required and additional properties are rejected, so a command
    // that sent the wrong key would fail validation instead of passing.
    const fakeSearch = (): Tool =>
        tool({
            name: 'search',
            description: 'Fake search.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    maxResults: { type: 'integer' },
                    provider: { type: 'string' }
                },
                required: ['query'],
                additionalProperties: false
            },
            execute: ({ parameters }) => ({
                provider: 'exa',
                query: (parameters as { query: string }).query,
                maxResults: 5,
                results: [
                    {
                        title: 'Harness docs',
                        url: 'https://example.com/docs',
                        snippet: 'line one\nline  two',
                        published: '2026-01-01'
                    },
                    { title: '', url: 'https://example.com/two', snippet: '' }
                ]
            })
        });

    // Same for `fetch` (tools/webfetch/index.ts): `url` is required.
    const fakeFetch = (): Tool =>
        tool({
            name: 'fetch',
            description: 'Fake fetch.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    format: { type: 'string' },
                    provider: { type: 'string' }
                },
                required: ['url'],
                additionalProperties: false
            },
            execute: ({ parameters }) => ({
                provider: 'native',
                url: (parameters as { url: string }).url,
                contentType: 'text/html',
                format: 'markdown',
                characters: 12,
                truncated: false,
                title: 'Example   Docs',
                content: '# Hello\nworld'
            })
        });

    it('calls the search tool with the query and formats the results', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen), { search: fakeSearch() });

        const result = await writer.executeCommand('/websearch harness  docs');

        expect(result.content).toBe(
            '2 result(s) via exa:\n1. Harness docs\n   https://example.com/docs\n   line one line two\n   published: 2026-01-01\n2. (untitled)\n   https://example.com/two'
        );
        // `data` is the tool's own result, and the RAW tail was the query (its
        // spacing intact), not a re-joined token list.
        expect((result.data as { query: string }).query).toBe('harness  docs');

        // Quotes/escapes are NOT applied to a query: the operator's phrase is data.
        expect(((await writer.executeCommand('/websearch "exact phrase"')).data as { query: string }).query).toBe(
            '"exact phrase"'
        );

        expect(await writer.executeCommand('/websearch')).toEqual({
            content: '/websearch: a query is required.\nusage: /websearch <query>',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('reports a failed search call as an error result, never a throw', async () => {
        const seen: HarnessStreamRequest[] = [];
        const broken = tool({
            name: 'search',
            description: 'Broken search.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            },
            execute: () => {
                throw new Error('provider exploded');
            }
        });
        const writer = quiet(brain(seen), { search: broken });

        expect(await writer.executeCommand('/websearch anything')).toEqual({
            content: '/websearch: provider exploded',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('calls the fetch tool with the first argument and formats the page', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen), { fetch: fakeFetch() });

        const result = await writer.executeCommand('/webfetch https://example.com/docs');

        expect(result.content).toBe(
            'title: Example Docs\nurl: https://example.com/docs\ncontent type: text/html\ncharacters: 12\n\n# Hello\nworld'
        );
        expect((result.data as { url: string }).url).toBe('https://example.com/docs');

        expect(await writer.executeCommand('/webfetch')).toEqual({
            content: '/webfetch: a URL is required.\nusage: /webfetch <url>',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('explains the configuration when the web tools are absent', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        // No `search` tool exists without a provider key, and no `fetch` tool
        // without `webfetch`. Both answers are results, not exceptions.
        expect(await writer.executeCommand('/websearch anything')).toEqual({
            content:
                '/websearch needs the "search" tool, which this harness does not register. Set websearch: true (or a websearch configuration object) and provide a provider key: EXA_API_KEY, TAVILY_API_KEY, or LINKUP_API_KEY.',
            isError: true
        });
        expect(await writer.executeCommand('/webfetch https://x.test')).toEqual({
            content:
                '/webfetch needs the "fetch" tool, which this harness does not register. Set webfetch: true (or a webfetch configuration object) to enable it; its native provider needs no key, and exa/linkup read EXA_API_KEY / LINKUP_API_KEY.',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });
});

describe('snapshot isolation', () => {
    // The `/task` block's clock rule applies here too (see EPOCH_ISO): this block
    // runs commands only — never a model turn — so pinning Date makes the
    // persisted record's `updatedAt` an exact value.
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(EPOCH_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps command state per harness, like every other session store', async () => {
        const seen: HarnessStreamRequest[] = [];
        const first = quiet(brain(seen));
        const second = quiet(brain(seen));

        await first.executeCommand('/task add "only here"');

        expect((await second.executeCommand('/task')).content).toBe(
            'No tasks.\n0 total, 0 completed, 0 pending\npage: offset 0, limit 20, showing 0'
        );
        expect((await first.executeCommand('/task')).content).toBe(
            '#1 [ ] only here\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1'
        );

        // A registered command is per-harness too: replacing one name in the first
        // session leaves the second one on the built-in.
        first.registerCommand({ name: 'help', description: 'Mine.', execute: () => ({ content: 'mine' }) });
        expect((await first.executeCommand('/help')).content).toBe('mine');
        expect(((await second.executeCommand('/help')).content as string).startsWith('/help  ')).toBe(true);

        const snapshot: HarnessSnapshot = first.snapshot();

        // T1: a persisted record carries its content revision and its attribution
        // (`updatedBy` is the primary, because a command writes through
        // executeTool), and the store's event revision rides along in `storeRev`.
        expect(snapshot.records.todos.items).toEqual([record('1', 'only here', false, 1)]);
        expect(snapshot.records.todos.storeRev).toBe(1);
        expect(seen).toHaveLength(0);
    });
});
