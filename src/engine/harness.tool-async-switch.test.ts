// THE RESERVED PER-CALL `async` SWITCH — the behavioral contract of the tool-plane
// turn-policy switch (./core/tool.ts owns the key; ./harness.ts `launchToolCall` owns the
// precedence; ./core/schema-validation.ts `resolveToolParameters` owns the strip).
//
// CONTRACT PINNED HERE (black box, through the public package surface — no scheduler
// internals, exactly like ./harness.sync-async.test.ts, whose R2/R3/R5 pins this file
// extends rather than restates):
//
//   S1  EVERY declaration advertises ONE optional boolean property named `async`, and it
//       is advertised on the MODEL-FACING COPY only. `definition.parameters` — which is
//       ALSO the runtime validation schema and the input to `toolParameterKey`'s
//       single-property rule — keeps the shape its author wrote.
//   S2  The switch flips the turn policy of ONE call, both directions: `"async": true`
//       makes an ordinary sync call resolve to 'async' (it buys its own turn and does not
//       join the message's sync group), and `"async": false` makes a declared-async call
//       join the group (one wake for the batch, no placeholder turn). Absent means "the
//       tool's own chain".
//   S3  THE LONE-DELEGATE REFINEMENT. A `delegate` call that the tool's own chain
//       resolves to 'async', with no switch on it, in a message holding EXACTLY ONE
//       async-resolving call, resolves to 'sync': one child is the shape where the spawner
//       is waiting on that child's answer, so the placeholder turn the async policy exists
//       for is pure cost. The parent's NEXT request therefore carries the child's REAL
//       envelope (with its `invocationId`/`threadId` handles), never a `status:'pending'`
//       stand-in.
//   S4  Fan-out keeps its freedom. TWO delegates (2 async-resolving calls), one delegate
//       plus one DECLARED `threadFork` (also 2), or an explicit `"async": true` beside a
//       lone delegate (still 2) all keep the placeholder turn and the per-completion wake.
//       The count reads the definitions THIS REQUEST was offered, so a searchable row the
//       request never carried contributes nothing — the file pins that boundary too,
//       including the case where that row is a branch control that dispatches anyway.
//   S5  PRECEDENCE: explicit switch -> registration/discovered mode -> lone-delegate
//       refinement -> DEFAULT_TOOL_MODE. An explicit switch wins in both directions; an
//       explicit `"async": false` is NOT "a second async thing" for the count, because the
//       spawner is waiting on that call too.
//   S6  The switch never reaches the tool: an `additionalProperties:false` tool accepts
//       it, `context.parameters` never carries it, a ONE-property tool still receives its
//       UNWRAPPED value (the documented hazard: ./core/tool.ts `toolParameterKey`), a tool
//       that declares `async` ITSELF owns that property (not injected, not stripped, and
//       it never drives the mode), and a non-boolean value is refused with one exact
//       sentence on every plane. The RAW `call.arguments` string KEEPS the switch —
//       transcript/replay fidelity; only the resolved/validated value is stripped.
//   S7  The runtime controls honour it where they schedule: `threadFork` joins the batch
//       ONLY on an explicit `"async": false` (the lone-call refinement deliberately never
//       reaches a branch), `actionRequest` accepts `"async": true` and clears its
//       batch-group membership (while the mode-INDEPENDENT "a run never asks its model
//       while it owns an unanswered question" hold keeps the placeholder turn away
//       anyway), and `toolCancel` accepts the key and ignores it — it never schedules.
//   S8  The host doors (`executeTool`, `callTool`) accept and strip it through the same
//       shared resolver as the model wire.
//   S9  THE PINNED DIVERGENCE (accepted, see the last describe): the shipped heartbeat
//       plugin resolves a pending call's mode BY NAME from the generated discovery table,
//       so a call the harness refined to 'sync' still keeps the ping armed.
//
// Determinism: every gate below is resolved by the test, one at a time, so each REQUEST
// COUNT and each request PROJECTION is an exact expected value (fake timers own the
// clock). Volatile identity — the per-process `invocationId` counter and the per-process
// `branch-N` counter — is pinned by SHAPE here and by VALUE only by carrying it forward.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    Harness,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessStreamTool,
    HarnessToolCall,
    Tool,
    ToolMode
} from './index';
import { TOOL_ASYNC_PARAMETER_DESCRIPTION, toolParameterKey } from './core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
    let settle!: (value: T) => void;

    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

// Run every queued job to its resting point WITHOUT advancing wall time (32 passes: a
// launch -> deliver -> wake -> re-request chain spans more microtasks than one await, and
// a delegated child run adds another hop on top — the count ./harness.delegation.test.ts
// uses for the same reason).
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

// Records the settled state of a promise WITHOUT awaiting it, so "still parked" is an
// observation rather than an inference from a request count.
const probe = (
    promise: Promise<unknown>
): { status: 'pending' | 'resolved' | 'rejected'; value?: any; error?: unknown } => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: any; error?: unknown } = {
        status: 'pending'
    };

    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );

    return state;
};

const call = (id: string, name: string, args = '{}'): HarnessToolCall => ({
    id,
    name,
    arguments: args
});

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const calls = (...requested: HarnessToolCall[]): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: requested }
];

// The exact transcript shape one request was shown. A DELIVERED tool result carries its
// serialized payload; an outstanding call is a placeholder whose content is not
// contractual — so "this turn saw the whole batch" is proven by the payload being
// present, and "this turn was bought by one async completion" by its absence.
const shape = (messages: readonly HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;
        if (message.role === 'assistant') {
            const ids = (message.toolCalls ?? []).map((entry) => entry.id).join('|');
            return `assistant:${message.content}:${ids}`;
        }
        return `${message.role}:${message.content}`;
    });

const toolMessages = (messages: readonly HarnessMessage[]): string[] =>
    messages
        .filter(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool'
        )
        .map((message) => `${message.toolCallId}:${message.content}`);

// A transport that replays `script` per request index (the last entry repeats), recording
// every request's projection AND the declaration rows it was shown.
const scripted = (
    script: HarnessStreamEvent[][],
    seen: string[][],
    declared: HarnessStreamTool[][]
): HarnessStream => {
    let turn = 0;

    return async function* stream(request: HarnessStreamRequest) {
        const index = turn;
        turn += 1;
        seen.push(shape(request.messages));
        declared.push(request.tools ?? []);

        await Promise.resolve();

        const frames = index < script.length ? script[index] : script[script.length - 1];
        for (const frame of frames) yield frame;
    };
};

// A spy tool: it records the EXACT value `execute` received (so "the switch never reaches
// the tool" is a direct observation), and parks on `gate` when one is given.
type Probe = { name: string; parameters: unknown };

// The house schema for these probes: ONE required property and a CLOSED surface, so a
// surviving `async` key would fail validation rather than pass silently.
const VALUE_SCHEMA = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false
} as Record<string, unknown>;

// A TWO-property closed schema. A tool shaped like this is the one whose recorded
// `context.parameters` can prove the strip (the whole arguments object is what reaches
// `execute`, so a surviving key would show up in it), while `VALUE_SCHEMA`'s single
// property is what pins the unwrap hazard.
const PAIR_SCHEMA = {
    type: 'object',
    properties: { value: { type: 'string' }, note: { type: 'string' } },
    required: ['value', 'note'],
    additionalProperties: false
} as Record<string, unknown>;

// A closed schema whose AUTHOR owns `async` as a real argument — the case the reserved key
// must yield to.
const OWNS_SCHEMA = {
    type: 'object',
    properties: {
        async: { type: 'boolean', description: 'The tool\'s own argument.' },
        label: { type: 'string' }
    },
    required: ['label'],
    additionalProperties: false
} as Record<string, unknown>;

// A ONE-property closed schema: `toolParameterKey` answers `path` for it, and the whole
// point of the strip is that it STILL does after the key is offered to the model.
const ONE_PROPERTY_SCHEMA = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false
} as Record<string, unknown>;

const spy = (
    name: string,
    log: Probe[],
    options: { mode?: ToolMode; parameters?: Record<string, unknown>; gate?: Deferred<string>; reply?: string } = {}
): Tool =>
    tool<Record<string, unknown>, unknown>({
        description: `Probe tool ${name}.`,
        tags: ['test'],
        // Core, so the model can call it without a discovery round.
        visibility: 'core',
        // `mode` is REQUIRED-by-decision here (absent = declare nothing): a test can
        // never accidentally rely on DEFAULT_TOOL_MODE without saying so at its call site.
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        parameters: options.parameters ?? VALUE_SCHEMA,
        execute: (context) => {
            log.push({ name, parameters: context.parameters });
            if (options.gate !== undefined) return options.gate.promise;
            return options.reply ?? `echo:${name}`;
        }
    });

type Fixture = {
    run: Harness;
    brain: ReturnType<typeof agent>;
    seen: string[][];
    declared: HarnessStreamTool[][];
    events: HarnessEvent[];
};

// A single-agent harness with exactly these tools (no presets, so the recorded
// projections and declaration rows stay readable). `wakeIntervalMs` seeds the shipped
// `async-ping` plugin's `intervalMs` setting, which makes a heartbeat boundary reachable
// in fake time.
const fixture = (
    script: HarnessStreamEvent[][],
    tools: Record<string, Tool>,
    options: { wakeIntervalMs?: number } = {}
): Fixture => {
    const seen: string[][] = [];
    const declared: HarnessStreamTool[][] = [];
    const events: HarnessEvent[] = [];
    const brain = agent({ model: 'test/model', stream: scripted(script, seen, declared) });

    const run = harness({
        agents: { writer: brain },
        tools,
        presets: false,
        ...(options.wakeIntervalMs === undefined ? {} : { wakeIntervalMs: options.wakeIntervalMs }),
        report: { progress: async (event) => void events.push(event) }
    });

    return { run, brain, seen, declared, events };
};

const wakeupsOf = (events: readonly HarnessEvent[]): Array<{ agent: string; reason: string }> =>
    events
        .filter((event) => event.type === 'wakeup')
        .map((event) => ({
            agent: (event as { agent: string }).agent,
            reason: (event as { reason: string }).reason
        }));

const rowOf = (rows: readonly HarnessStreamTool[], name: string): HarnessStreamTool | undefined =>
    rows.find((row) => row.name === name);

// The properties a declaration row advertises, in the order the schema states them.
const propertiesOf = (row: HarnessStreamTool | undefined): string[] =>
    Object.keys(((row?.parameters as Record<string, any>)?.properties ?? {}) as Record<string, unknown>);

// ---------------------------------------------------------------------------
// Agent-plane helpers (delegate / threadFork) — deliberately local copies of the
// ./harness.delegate-fanout.test.ts and ./harness.fork.test.ts idioms, so this file
// cannot be broken by edits to another suite's fixtures.
// ---------------------------------------------------------------------------

const childBrain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'merge/ds4-flash', stream });

// ONE child agent whose whole generation parks on a gate, so "in flight" is a fact the
// test controls. `log` records the open/close instants, which is the overlap proof.
const gatedChild = (
    key: string,
    gate: Promise<unknown>,
    answerText: string,
    log: string[]
): ReturnType<typeof agent> =>
    childBrain(
        (async function* stream() {
            log.push(`open:${key}`);
            await gate;
            log.push(`close:${key}`);
            yield { type: 'text', delta: answerText };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        }) as unknown as HarnessStream
    );

// One `delegate` call. `extraSwitch` is spliced INSIDE the arguments object, so a test
// can state the reserved key (`,"async":true`) without retyping the whole payload.
const delegateCall = (
    id: string,
    agentName: string,
    input: string,
    extraSwitch = ''
): HarnessToolCall =>
    call(id, 'delegate', `{"agent":"${agentName}","input":"${input}"${extraSwitch}}`);

// The tool message a REQUEST carries for a call id — what the model actually READS about
// that call this turn, including a projection-only `status:"pending"` placeholder.
const requestToolContent = (request: HarnessStreamRequest | undefined, callId: string): Record<string, any> => {
    const message = ((request?.messages ?? []) as Array<{ role?: string; toolCallId?: string; content?: string }>).find(
        (entry) => entry.role === 'tool' && entry.toolCallId === callId
    );

    if (message === undefined) throw new Error(`no tool message for ${callId} in the request`);

    return JSON.parse(String(message.content)) as Record<string, any>;
};

const envelopeOf = (messages: readonly unknown[], callId: string): Record<string, any> => {
    const message = (messages as Array<{ role?: string; toolCallId?: string; content?: string }>).find(
        (entry) => entry.role === 'tool' && entry.toolCallId === callId
    );

    if (message === undefined) throw new Error(`no tool result for ${callId}`);

    return JSON.parse(String(message.content)) as Record<string, any>;
};

// The last user message of a request — for a fork that is its task, for the root run the
// original input. This is how ./harness.fork.test.ts routes ONE transport between the
// origin run and its branch, and how this file separates their requests.
const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

const routed = (
    route: (request: HarnessStreamRequest) => HarnessStreamEvent[] | Promise<HarnessStreamEvent[]>,
    seen?: HarnessStreamRequest[]
): HarnessStream =>
    (async function* stream(request: HarnessStreamRequest) {
        seen?.push(request);
        for (const frame of await route(request)) yield frame;
    }) as unknown as HarnessStream;

// The fork tests answer the origin run and its branch through ONE transport (a branch is
// a clone of the calling agent, so it carries the same stream). Their requests are
// therefore separated by the fork's task, which is the newest user message of a branch
// request and of a branch request only — this is the same split ./harness.fork.test.ts
// routes on.
const BRANCH_TASK = 'branch task';

const originRequests = (seen: readonly HarnessStreamRequest[]): HarnessStreamRequest[] =>
    seen.filter((request) => latestUser(request) !== BRANCH_TASK);

const branchRequests = (seen: readonly HarnessStreamRequest[]): HarnessStreamRequest[] =>
    seen.filter((request) => latestUser(request) === BRANCH_TASK);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// S1 — the switch is ADVERTISED, on the copy, on every row
// ---------------------------------------------------------------------------

describe('the reserved async switch is advertised on the model-facing copy only (S1)', () => {
    it('adds an optional boolean to every row without touching the validation schema', async () => {
        const log: Probe[] = [];
        const world = fixture(
            [answer('nothing called')],
            {
                solo: spy('solo', log, { mode: 'sync' }),
                // A TWO-property schema whose author owns `async` as a real argument.
                owns: spy('owns', log, { mode: 'sync', parameters: OWNS_SCHEMA })
            }
        );

        await world.run('go');

        // --- the advertised copy carries the reserved key --------------------------------
        const soloRow = rowOf(world.declared[0], 'solo');
        expect(propertiesOf(soloRow)).toEqual(['value', 'async']);
        expect((soloRow!.parameters as Record<string, any>).properties.async).toEqual({
            type: 'boolean',
            // The ONE sentence ./core/tool.ts owns, named through the constant so the
            // wording stays re-wordable while the property's TYPE is pinned exactly.
            description: TOOL_ASYNC_PARAMETER_DESCRIPTION
        });
        // It is OPTIONAL (`required` is still the author's list) and the row still states a
        // CLOSED surface, so the model is not told the surface is open-ended.
        expect((soloRow!.parameters as Record<string, any>).required).toEqual(['value']);
        expect((soloRow!.parameters as Record<string, any>).additionalProperties).toBe(false);

        // --- the executable definition keeps the shape its author wrote ------------------
        // `definition.parameters` is ALSO the validation schema and the input to
        // `toolParameterKey`, which is exactly why the injection lives on the copy.
        expect(Object.keys((world.run.tools.solo.parameters as Record<string, any>).properties)).toEqual([
            'value'
        ]);
        expect(toolParameterKey(world.run.tools.solo.parameters)).toBe('value');

        // --- a tool that owns the key is advertised UNTOUCHED ----------------------------
        // Same properties, and the property is still ITS description, not the harness's.
        expect(propertiesOf(rowOf(world.declared[0], 'owns')).slice().sort()).toEqual([
            'async',
            'label'
        ]);
        expect(
            (rowOf(world.declared[0], 'owns')!.parameters as Record<string, any>).properties.async
        ).toEqual({ type: 'boolean', description: 'The tool\'s own argument.' });

        // --- and it is advertised on EVERY row, built-ins included ------------------------
        // A declaration list where one row lacks the key teaches the model the switch is
        // per-tool, so a shipped row has to carry it too.
        const requestRow = rowOf(world.declared[0], 'toolRequest');
        expect(requestRow).toBeDefined();
        expect(propertiesOf(requestRow)).toContain('async');
    });

    it('advertises it on toolCancel while the board has work in flight', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('c1', 'solo', '{"value":"x","async":true}')), answer('waiting'), answer('done')],
            { solo: spy('solo', [], { mode: 'sync', gate }) }
        );

        const running = world.run('go');
        await flush();

        // The switch bought the background turn, so request 2 exists while the call is
        // outstanding — and that is the one moment `toolCancel` is declared at all.
        expect(world.seen.length).toBe(2);

        const cancelRow = rowOf(world.declared[1], 'toolCancel');
        expect(cancelRow).toBeDefined();
        expect(propertiesOf(cancelRow)).toEqual(['callId', 'async']);

        gate.resolve('solo-value');
        await flush();
        await expect(running).resolves.toMatchObject({ content: 'done' });
    });
});

// ---------------------------------------------------------------------------
// S2 — the switch on an ordinary sync tool (criterion 1) and forcing sync (criterion 2)
// ---------------------------------------------------------------------------

describe('the switch on an ordinary sync tool buys its own turn (criterion 1)', () => {
    it('keeps a forced-async call out of the message sync group', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('c1', 'solo', '{"value":"x","async":true}')), answer('waiting'), answer('done')],
            { solo: spy('solo', [], { mode: 'sync', gate }) }
        );

        const running = world.run('go');
        const state = probe(running);
        await flush();

        // 'async': the run re-prompted with a placeholder while the call is outstanding,
        // and it was NOT held by the batch gate its own declaration would have joined.
        expect(world.seen.length).toBe(2);
        expect(world.seen[1].some((line) => line.startsWith('tool:c1:solo-value'))).toBe(false);
        expect(state.status).toBe('pending');

        // The completion buys its OWN turn, with the real payload.
        gate.resolve('solo-value');
        await flush();

        expect(world.seen.length).toBe(3);
        expect(world.seen[2]).toContain('tool:c1:solo-value');
        await expect(running).resolves.toMatchObject({ content: 'done' });
        expect(toolMessages(world.brain.messages)).toEqual(['c1:solo-value']);
    });

    it('holds one turn for the sync pair and lets the forced-async call go its own way', async () => {
        const one = deferred<string>();
        const two = deferred<string>();
        const three = deferred<string>();

        // s1: no switch (its own 'sync' chain). s2: explicit false — the same answer as s1,
        // stated out loud. s3: explicit true on a 'sync' tool — the override under test.
        const world = fixture(
            [
                calls(
                    call('s1', 'one', '{"value":"1"}'),
                    call('s2', 'two', '{"value":"2","async":false}'),
                    call('s3', 'three', '{"value":"3","async":true}')
                ),
                answer('waiting'),
                answer('done')
            ],
            {
                one: spy('one', [], { mode: 'sync', gate: one }),
                two: spy('two', [], { mode: 'sync', gate: two }),
                three: spy('three', [], { mode: 'sync', gate: three })
            }
        );

        const running = world.run('go');
        await flush();

        // The two sync members park the run; the async member is still outstanding too.
        expect(world.seen.length).toBe(1);

        // The forced-async call settles first and re-prompts the model on its own, while
        // the group is still holding.
        three.resolve('three-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:s3:three-value');
        expect(world.seen[1].some((line) => line.startsWith('tool:s1:one-value'))).toBe(false);
        expect(world.seen[1].some((line) => line.startsWith('tool:s2:two-value'))).toBe(false);

        // A sync member settling early buys nothing.
        one.resolve('one-value');
        await flush();
        expect(world.seen.length).toBe(2);

        // The LAST member drains the group: exactly one turn, carrying everything.
        two.resolve('two-value');
        await flush();

        expect(world.seen.length).toBe(3);
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:one-value',
            's2:two-value',
            's3:three-value'
        ]);
        await expect(running).resolves.toMatchObject({ content: 'done' });
    });

    it('still collapses three unswitched sync calls into one turn (the key changes nothing by being offered)', async () => {
        const one = deferred<string>();
        const two = deferred<string>();
        const three = deferred<string>();

        const world = fixture(
            [
                calls(
                    call('s1', 'one', '{"value":"1"}'),
                    call('s2', 'two', '{"value":"2"}'),
                    call('s3', 'three', '{"value":"3"}')
                ),
                answer('done')
            ],
            {
                one: spy('one', [], { mode: 'sync', gate: one }),
                two: spy('two', [], { mode: 'sync', gate: two }),
                three: spy('three', [], { mode: 'sync', gate: three })
            }
        );

        const running = world.run('go');
        await flush();
        expect(world.seen.length).toBe(1);

        // Settlement in reverse call order: only the last one may spend a turn.
        three.resolve('three-value');
        await flush();
        two.resolve('two-value');
        await flush();
        expect(world.seen.length).toBe(1);

        one.resolve('one-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:s1:one-value');
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:one-value',
            's2:two-value',
            's3:three-value'
        ]);
        await expect(running).resolves.toMatchObject({ content: 'done' });
    });
});

describe('the switch forcing sync joins an async-declared tool (criterion 2)', () => {
    it('parks the run and spends no placeholder turn', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('k1', 'free', '{"value":"x","async":false}')), answer('synced')],
            { free: spy('free', [], { mode: 'async', gate }) }
        );

        const running = world.run('go');
        const state = probe(running);
        await flush();

        // A declared-async call the model forced sync: the run is parked on its group, so
        // there is exactly ONE request and no `status:'pending'` turn was bought.
        expect(world.seen.length).toBe(1);
        expect(state.status).toBe('pending');

        gate.resolve('free-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:k1:free-value');
        expect(toolMessages(world.brain.messages)).toEqual(['k1:free-value']);
        await expect(running).resolves.toMatchObject({ content: 'synced' });
    });

    it('holds only the call that asked to be held', async () => {
        const held = deferred<string>();
        const background = deferred<string>();

        // ONE message, ONE async-declared tool forced sync and ONE left on its own chain:
        // the switch is per-call, so the sibling keeps its background freedom.
        const world = fixture(
            [
                calls(
                    call('s1', 'held', '{"value":"1","async":false}'),
                    call('a1', 'background', '{"value":"2"}')
                ),
                answer('waiting'),
                answer('done')
            ],
            {
                held: spy('held', [], { mode: 'async', gate: held }),
                background: spy('background', [], { mode: 'async', gate: background })
            }
        );

        const running = world.run('go');
        await flush();
        expect(world.seen.length).toBe(1);

        background.resolve('background-value');
        await flush();

        // The async sibling bought its own turn; the forced-sync member still holds.
        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:a1:background-value');

        held.resolve('held-value');
        await flush();

        expect(world.seen.length).toBe(3);
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:held-value',
            'a1:background-value'
        ]);
        await expect(running).resolves.toMatchObject({ content: 'done' });
    });
});

// ---------------------------------------------------------------------------
// S3 — the lone-delegate refinement (criterion 3)
// ---------------------------------------------------------------------------

describe('a lone delegate is sync: the spawner is waiting on that one child (criterion 3)', () => {
    it('delivers the child result in the parent next request, with no pending placeholder turn', async () => {
        const gate = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(delegateCall('c1', 'helper', 'find it'));
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', gate.promise, 'helper finished', log) },
            presets: false,
            // The heartbeat is not the subject here; replacing it keeps timer counts exact.
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // The child IS in flight, and the parent has spent exactly ONE request: the
        // refinement parked it on the batch gate instead of buying a placeholder turn.
        expect(log).toEqual(['open:helper']);
        expect(running.status).toBe('pending');
        expect(seen.length).toBe(1);
        expect(vi.getTimerCount()).toBe(0);

        gate.resolve(undefined);
        await flush();

        // The next request the parent is shown carries the child's REAL envelope at the
        // original call position — never `status:'pending'`.
        expect(seen.length).toBe(2);
        const delivered = requestToolContent(seen[1], 'c1');

        expect({
            agent: delivered.agent,
            content: delivered.content,
            status: delivered.status,
            threadId: delivered.threadId,
            // Both identity handles are present; only their SHAPE is pinnable here (the id
            // is a per-process counter, and `branch-N`/`invocation-N` counters move with
            // every other test in the file).
            invocationIdShape: delivered.invocationId
        }).toEqual({
            agent: 'helper',
            content: 'helper finished',
            status: 'completed',
            threadId: 'agent:helper',
            invocationIdShape: expect.stringMatching(/^\d+$/)
        });

        expect(log).toEqual(['open:helper', 'close:helper']);
        await flush();
        expect(running.status).toBe('resolved');
        expect(running.value.content).toBe('final');
    });

    it('still refines when the message also holds an ordinary sync call (one thing to wait for)', async () => {
        const child = deferred<unknown>();
        const io = deferred<string>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'helper', 'find it'),
                        call('s1', 'io', '{"value":"read"}')
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', child.promise, 'helper finished', log) },
            tools: { io: spy('io', [], { mode: 'sync', gate: io }) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // `io` joins the same group, so the delegate is still the message's ONLY
        // async-resolving call: the refinement applies and no turn is spent.
        expect(seen.length).toBe(1);
        expect(running.status).toBe('pending');

        io.resolve('io-value');
        await flush();
        expect(seen.length).toBe(1);

        child.resolve(undefined);
        await flush();

        // ONE turn for the whole batch, carrying both real results.
        expect(seen.length).toBe(2);
        expect(requestToolContent(seen[1], 'c1')).toMatchObject({
            status: 'completed',
            content: 'helper finished'
        });
        expect(
            (seen[1].messages as Array<{ role?: string; toolCallId?: string; content?: string }>)
                .find((message) => message.role === 'tool' && message.toolCallId === 's1')!
                .content
        ).toBe('io-value');

        await flush();
        expect(running.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// S4 — fan-out keeps its async freedom (criterion 4)
// ---------------------------------------------------------------------------

describe('fan-out keeps the background freedom (criterion 4)', () => {
    it('runs two delegates as background work with one wake per completion', async () => {
        const alpha = deferred<unknown>();
        const beta = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'alpha', 'find alpha'),
                        delegateCall('c2', 'beta', 'find beta')
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: {
                writer: writerAgent,
                alpha: gatedChild('alpha', alpha.promise, 'alpha finished', log),
                beta: gatedChild('beta', beta.promise, 'beta finished', log)
            },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // TWO async-resolving calls: no refinement. The parent is re-prompted once with
        // both children outstanding, and both are placeholders.
        expect(log).toEqual(['open:alpha', 'open:beta']);
        expect(seen.length).toBe(2);
        expect(['c1', 'c2'].map((id) => requestToolContent(seen[1], id).status)).toEqual([
            'pending',
            'pending'
        ]);
        expect(running.status).toBe('pending');

        alpha.resolve(undefined);
        await flush();

        // Per-completion wake: the parent stays free, and its sibling is still a card.
        expect(seen.length).toBe(3);
        expect(requestToolContent(seen[2], 'c1')).toMatchObject({
            status: 'completed',
            content: 'alpha finished'
        });
        expect(requestToolContent(seen[2], 'c2').status).toBe('pending');

        beta.resolve(undefined);
        await flush();

        expect(seen.length).toBe(4);
        await flush();
        expect(running.status).toBe('resolved');

        expect(['c1', 'c2'].map((id) => envelopeOf(writerAgent.messages, id).content)).toEqual([
            'alpha finished',
            'beta finished'
        ]);
    });

    it('keeps a lone delegate async when the message also launches a declared threadFork', async () => {
        const child = deferred<unknown>();
        const branch = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        // ONE transport serves the origin run and its branch (a branch is a clone of the
        // calling agent), so the two are separated by the fork's task.
        const writerAgent = childBrain(
            routed(async (request) => {
                if (latestUser(request) === BRANCH_TASK) {
                    await branch.promise;
                    return answer('branch summary');
                }

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'helper', 'find it'),
                        call('f1', 'threadFork', `{"input":"${BRANCH_TASK}"}`)
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', child.promise, 'helper finished', log) },
            presets: false,
            // `threadFork` is a SEARCHABLE row, so it only counts toward the message's
            // async total while the request actually carries it (see the next test).
            enableAllTools: true,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // Precondition: the fork really is declared to this request, i.e. it is one of the
        // definitions the count reads.
        expect((seen[0].tools ?? []).map((row) => row.name)).toEqual(
            expect.arrayContaining(['delegate', 'threadFork'])
        );

        // The message holds TWO async-resolving calls (the delegate and the branch), so the
        // count — not a delegate tally — keeps the delegate async: the origin is re-prompted
        // with BOTH calls as placeholders and never parks, while the branch runs on.
        expect(log).toEqual(['open:helper']);
        expect(originRequests(seen).length).toBe(2);
        expect(branchRequests(seen).length).toBe(1);
        expect(['c1', 'f1'].map((id) => requestToolContent(originRequests(seen)[1], id).status)).toEqual(
            ['pending', 'pending']
        );
        expect(running.status).toBe('pending');

        child.resolve(undefined);
        await flush();
        expect(originRequests(seen).length).toBe(3);
        expect(requestToolContent(originRequests(seen)[2], 'c1')).toMatchObject({
            status: 'completed'
        });
        expect(requestToolContent(originRequests(seen)[2], 'f1').status).toBe('pending');

        branch.resolve(undefined);
        await flush();
        expect(originRequests(seen).length).toBe(4);

        await flush();
        expect(running.status).toBe('resolved');
        expect(envelopeOf(writerAgent.messages, 'f1')).toEqual({
            branchId: expect.stringMatching(/^branch-\d+$/),
            // The branch address is the SAME id on both keys (the contract ./harness.fork.test.ts pins).
            threadId: expect.stringMatching(/^branch-\d+$/),
            content: 'branch summary'
        });
    });

    it('counts only the definitions the request was offered, so an undeclared threadFork leaves the delegate lone', async () => {
        const child = deferred<unknown>();
        const branch = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed(async (request) => {
                if (latestUser(request) === BRANCH_TASK) {
                    await branch.promise;
                    return answer('branch summary');
                }

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'helper', 'find it'),
                        call('f1', 'threadFork', `{"input":"${BRANCH_TASK}"}`)
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', child.promise, 'helper finished', log) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // Precondition: with no operator enablement, `threadFork` is a searchable row the
        // request never carried — while the branch control still dispatches, because its
        // handler sits ABOVE the discovery gate (./harness.ts `launchToolCall`).
        expect((seen[0].tools ?? []).map((row) => row.name)).toContain('delegate');
        expect((seen[0].tools ?? []).map((row) => row.name)).not.toContain('threadFork');

        // OBSERVED CONSEQUENCE, pinned: the count reads ONLY the offered definitions, so an
        // undeclared branch contributes nothing and the delegate is still the message's only
        // async-resolving call. It is refined to 'sync' and parks the origin, next to a
        // branch that keeps running in the background — the branch is invisible to the count
        // but not to the run.
        expect(log).toEqual(['open:helper']);
        expect(originRequests(seen).length).toBe(1);
        expect(branchRequests(seen).length).toBe(1);
        expect(running.status).toBe('pending');

        child.resolve(undefined);
        await flush();

        // The refined delegate settles the group and buys the ONE group turn; the branch is
        // still a placeholder there, because its own completion is what will speak for it.
        expect(originRequests(seen).length).toBe(2);
        expect(requestToolContent(originRequests(seen)[1], 'c1')).toMatchObject({
            status: 'completed'
        });
        expect(requestToolContent(originRequests(seen)[1], 'f1').status).toBe('pending');

        branch.resolve(undefined);
        await flush();
        expect(originRequests(seen).length).toBe(3);

        await flush();
        expect(running.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// S5 — precedence, both directions (criterion 5)
// ---------------------------------------------------------------------------

describe('an explicit switch outranks the refinement (criterion 5)', () => {
    it('sends a lone delegate to the background when the call states async true', async () => {
        const gate = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(delegateCall('c1', 'helper', 'find it', ',"async":true'));
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', gate.promise, 'helper finished', log) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // Step 1 outranks step 3: the spawner said it would not wait, so it gets the
        // placeholder turn and stays free.
        expect(seen.length).toBe(2);
        expect(requestToolContent(seen[1], 'c1').status).toBe('pending');
        expect(running.status).toBe('pending');

        gate.resolve(undefined);
        await flush();

        expect(seen.length).toBe(3);
        expect(requestToolContent(seen[2], 'c1')).toMatchObject({
            status: 'completed',
            content: 'helper finished'
        });
        await flush();
        expect(running.status).toBe('resolved');
    });

    it('treats an explicit false as "waiting too", so a delegate pair resolves as one sync batch', async () => {
        const alpha = deferred<unknown>();
        const beta = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'alpha', 'find alpha', ',"async":false'),
                        delegateCall('c2', 'beta', 'find beta')
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: {
                writer: writerAgent,
                alpha: gatedChild('alpha', alpha.promise, 'alpha finished', log),
                beta: gatedChild('beta', beta.promise, 'beta finished', log)
            },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // The switched call is sync by step 1. The remaining UNswitched delegate is the
        // message's only ASYNC-resolving call — an explicit false is a call the spawner is
        // also waiting on, not a second async thing — so step 3 refines it too, and the
        // whole message becomes one parked batch with no placeholder turn.
        expect(log).toEqual(['open:alpha', 'open:beta']);
        expect(seen.length).toBe(1);
        expect(running.status).toBe('pending');

        alpha.resolve(undefined);
        await flush();
        expect(seen.length).toBe(1);

        beta.resolve(undefined);
        await flush();

        expect(seen.length).toBe(2);
        expect(['c1', 'c2'].map((id) => requestToolContent(seen[1], id).status)).toEqual([
            'completed',
            'completed'
        ]);
        await flush();
        expect(running.status).toBe('resolved');
    });

    it('keeps both delegates async when one of two states async true (the count gates the refinement)', async () => {
        const alpha = deferred<unknown>();
        const beta = deferred<unknown>();
        const seen: HarnessStreamRequest[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        delegateCall('c1', 'alpha', 'find alpha', ',"async":true'),
                        delegateCall('c2', 'beta', 'find beta')
                    );
                }
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: {
                writer: writerAgent,
                alpha: gatedChild('alpha', alpha.promise, 'alpha finished', []),
                beta: gatedChild('beta', beta.promise, 'beta finished', [])
            },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // Two async-resolving calls: neither is refined, so BOTH keep background freedom —
        // the message shape decides, not how many calls carry the key.
        expect(seen.length).toBe(2);
        expect(['c1', 'c2'].map((id) => requestToolContent(seen[1], id).status)).toEqual([
            'pending',
            'pending'
        ]);

        alpha.resolve(undefined);
        await flush();
        expect(seen.length).toBe(3);

        beta.resolve(undefined);
        await flush();
        expect(seen.length).toBe(4);

        await flush();
        expect(running.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// S6 — schema and validation interactions (criterion 6)
// ---------------------------------------------------------------------------

describe('the switch never reaches the tool and never breaks its schema (criterion 6)', () => {
    it('is accepted by an additionalProperties:false tool and stripped from context.parameters', async () => {
        const log: Probe[] = [];
        const sent = '{"value":"x","note":"n","async":true}';
        const world = fixture([calls(call('c1', 'pair', sent)), answer('done')], {
            pair: spy('pair', log, { mode: 'sync', parameters: PAIR_SCHEMA, reply: 'pair-value' })
        });

        await expect(world.run('go')).resolves.toMatchObject({ content: 'done' });

        // The call is legal (the closed schema the tool AUTHOR wrote never saw the key),
        // and the whole-object value `execute` received is exactly the author's shape.
        expect(log).toEqual([{ name: 'pair', parameters: { value: 'x', note: 'n' } }]);
        expect(toolMessages(world.brain.messages)).toEqual(['c1:pair-value']);

        // TRANSCRIPT FIDELITY: the raw call arguments keep the switch, so a replay sends
        // the model's own turn back unchanged. Only the resolved value is stripped.
        const assistant = world.brain.messages.find((message) => message.role === 'assistant')!;
        expect((assistant.toolCalls ?? [])[0]).toEqual({
            id: 'c1',
            name: 'pair',
            arguments: sent
        });
    });

    it('keeps a single-property tool unwrapped (the toolParameterKey hazard)', async () => {
        const log: Probe[] = [];
        // A schema with EXACTLY ONE property: had the key survived into validation,
        // `toolParameterKey` would answer `undefined` and `execute` would get the WRAPPER.
        const world = fixture([calls(call('p1', 'single', '{"path":"a.ts","async":true}')), answer('done')], {
            single: spy('single', log, { mode: 'sync', parameters: ONE_PROPERTY_SCHEMA, reply: 'read a.ts' })
        });

        await expect(world.run('go')).resolves.toMatchObject({ content: 'done' });

        expect(log).toEqual([{ name: 'single', parameters: 'a.ts' }]);
        expect(toolMessages(world.brain.messages)).toEqual(['p1:read a.ts']);
    });

    it('yields to a tool that declares its own async property', async () => {
        const log: Probe[] = [];
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('o1', 'owns', '{"async":true,"label":"x"}')), answer('done')],
            { owns: spy('owns', log, { mode: 'sync', parameters: OWNS_SCHEMA, gate }) }
        );

        const running = world.run('go');
        await flush();

        // The property is the TOOL's, so it drives nothing: this 'sync' tool still joined
        // its message's group and the run is parked on it.
        expect(world.seen.length).toBe(1);

        gate.resolve('owns-value');
        await flush();

        expect(world.seen.length).toBe(2);
        // And the value survives untouched — the harness neither injects nor strips it.
        expect(log).toEqual([{ name: 'owns', parameters: { async: true, label: 'x' } }]);
        await expect(running).resolves.toMatchObject({ content: 'done' });
    });

    it('refuses a non-boolean switch with the exact sentence, on the model plane', async () => {
        const log: Probe[] = [];
        const world = fixture([calls(call('c1', 'solo', '{"value":"x","async":"yes"}')), answer('recovered')], {
            solo: spy('solo', log, { mode: 'sync', reply: 'solo-value' })
        });

        await expect(world.run('go')).resolves.toMatchObject({ content: 'recovered' });

        // One exact type error, from the shared resolver, wrapped in the harness's normal
        // "does not match its schema" tool result — and the call never executed.
        expect(log).toEqual([]);
        expect(toolMessages(world.brain.messages)).toEqual([
            'c1:Tool "solo" received arguments that do not match its schema: $.async must be a boolean (true for async, false for sync); received string.'
        ]);
        // A call that never schedules cannot strand the batch gate: one turn, not a park.
        expect(world.seen.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// S7 — the runtime controls (criterion 7)
// ---------------------------------------------------------------------------

describe('the runtime controls honour the switch (criterion 7)', () => {
    // The ONE transport answers both the origin run and its branch, routed by the newest
    // user message (the fork's task). `branch` gates the branch generation so "in flight"
    // is a fact the test controls.
    const forkBrain = (
        seen: HarnessStreamRequest[],
        branch: Deferred<unknown>,
        args: string
    ): ReturnType<typeof agent> =>
        childBrain(
            routed(async (request) => {
                if (latestUser(request) === BRANCH_TASK) {
                    await branch.promise;
                    return answer('branch summary');
                }

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(call('f1', 'threadFork', args));
                }
                return answer('final');
            }, seen)
        );

    it('holds the origin batch for a threadFork the model forced sync', async () => {
        const branch = deferred<unknown>();
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: forkBrain(seen, branch, `{"input":"${BRANCH_TASK}","async":false}`) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // `"async": false` is the ONLY thing that puts a branch in its origin's group: the
        // origin is parked, so its second request does not exist yet, while the branch runs.
        expect(originRequests(seen).length).toBe(1);
        expect(branchRequests(seen).length).toBe(1);
        expect(running.status).toBe('pending');

        branch.resolve(undefined);
        await flush();

        // The branch's settlement drains the group: ONE origin turn, carrying the result.
        expect(originRequests(seen).length).toBe(2);
        const delivered = requestToolContent(originRequests(seen)[1], 'f1');
        expect({ threadId: delivered.threadId, content: delivered.content }).toEqual({
            threadId: delivered.branchId,
            content: 'branch summary'
        });
        expect(delivered.branchId).toMatch(/^branch-\d+$/);

        await flush();
        expect(running.status).toBe('resolved');
        expect(running.value.content).toBe('final');
    });

    it('never holds the origin for an unswitched threadFork, even as the message lone call', async () => {
        const branch = deferred<unknown>();
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: forkBrain(seen, branch, `{"input":"${BRANCH_TASK}"}`) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // The lone-call refinement is deliberately NOT a branch rule: a fork exists so the
        // requester keeps running, so today's never-joins behaviour stands with the switch
        // merely offered. Same message shape, opposite policy: the origin was re-prompted
        // with the branch as a placeholder instead of parking on it.
        expect(originRequests(seen).length).toBe(2);
        expect(branchRequests(seen).length).toBe(1);
        expect(requestToolContent(originRequests(seen)[1], 'f1').status).toBe('pending');
        expect(running.status).toBe('pending');

        branch.resolve(undefined);
        await flush();

        expect(originRequests(seen).length).toBe(3);
        expect(requestToolContent(originRequests(seen)[2], 'f1').content).toBe('branch summary');
        await flush();
        expect(running.status).toBe('resolved');
    });

    it('accepts the key on toolCancel and stays an inline acknowledgement', async () => {
        const cancelling = deferred<string>();
        const world = fixture(
            [
                calls(
                    call('s1', 'willCancel', '{"value":"2"}'),
                    // The control answers inline and never schedules, so the switch has
                    // nothing to group here — it must simply not break the legal call.
                    call('c9', 'toolCancel', '{"callId":"s1","async":true}')
                ),
                answer('settled')
            ],
            { willCancel: spy('willCancel', [], { mode: 'sync', gate: cancelling }) }
        );

        const running = world.run('go');
        await flush();

        // The release landed, the single sync member settled as cancelled, and the group
        // drained into exactly one turn.
        expect(world.seen.length).toBe(2);
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:Tool call "willCancel" (s1) was cancelled before it completed; no result is available.',
            // F1-M6 (2026-11-27) — the cancel receipt's trailing `threadId` (./harness.ts
            // `toolCancel`); the switch itself changes nothing about the receipt's shape.
            'c9:{"cancelled":true,"callId":"s1","name":"willCancel","threadId":"agent:writer"}'
        ]);

        // A late result for a released call is data on a dead task.
        cancelling.resolve('ignored-late-value');
        await flush();
        expect(world.seen.length).toBe(2);

        await expect(running).resolves.toMatchObject({ content: 'settled' });
    });

    it('clears the batch membership for an actionRequest the model forced async', async () => {
        const seen: HarnessStreamRequest[] = [];
        const handler = deferred<{ kind: 'option'; optionId: string }>();
        const entry = childBrain(
            routed((request) => {
                if (
                    (request.messages as Array<{ content?: string }>).some((message) =>
                        String(message.content ?? '').includes('"answeredBy"')
                    )
                ) {
                    return answer('root done');
                }

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        call(
                            'q1',
                            'actionRequest',
                            '{"question":"Which path should I take?","recommended":"fast","options":[{"id":"fast","label":"Fast path"},{"id":"slow","label":"Slow path"}],"async":true}'
                        )
                    );
                }
                return answer('waiting');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async () => handler.promise
            },
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // `"async": true` is accepted and the call does NOT join the message's sync group.
        // What still holds the run is the mode-INDEPENDENT hold of ./harness.action-request
        // -hold.test.ts ("a run that owns an unanswered question asks its model nothing"),
        // so no placeholder turn appears either way: the switch's effect here is the group
        // membership, and the question is what the run waits on.
        expect(seen.length).toBe(1);
        expect(running.status).toBe('pending');

        handler.resolve({ kind: 'option', optionId: 'fast' });
        await flush();

        expect(seen.length).toBe(2);
        const delivered = requestToolContent(seen[1], 'q1');
        expect({ answeredBy: delivered.answeredBy, choice: delivered.choice }).toEqual({
            answeredBy: 'owner',
            choice: { kind: 'option', optionId: 'fast', label: 'Fast path' }
        });
        expect(delivered.requestId).toMatch(/^request-[0-9a-z]+-[0-9a-z]+-\d+$/);

        await flush();
        expect(running.status).toBe('resolved');
        expect(running.value.content).toBe('root done');
    });
});

// ---------------------------------------------------------------------------
// S8 — the host/nested doors (criterion 8)
// ---------------------------------------------------------------------------

describe('the host doors accept and strip the key (criterion 8)', () => {
    it('strips it on executeTool and callTool, and unwraps a single-property tool', async () => {
        const log: Probe[] = [];
        const world = fixture([answer('no model call')], {
            // A declared-async tool called through a host door: the switch is irrelevant
            // to a door (there is no turn to schedule), and the key must still stay out of
            // the body.
            pair: spy('pair', log, { mode: 'async', parameters: PAIR_SCHEMA, reply: 'door-value' }),
            single: spy('single', log, { mode: 'sync', parameters: ONE_PROPERTY_SCHEMA, reply: 'door-path' }),
            owns: spy('owns', log, { mode: 'sync', parameters: OWNS_SCHEMA, reply: 'door-owns' })
        });

        // The whole-object form: a surviving key would sit in the recorded parameters.
        expect(await world.run.executeTool('pair', { value: 'x', note: 'n', async: true })).toBe('door-value');
        expect(await world.run.callTool('pair', { value: 'y', note: 'n', async: false })).toBe('door-value');

        // The single-property hazard, on the DIRECT form: the stripped wrapper still
        // unwraps to the bare value.
        expect(await world.run.executeTool('single', { path: 'a.ts', async: true })).toBe('door-path');

        // A tool that owns the key keeps it on this door too.
        expect(await world.run.executeTool('owns', { async: true, label: 'x' })).toBe('door-owns');

        expect(log).toEqual([
            { name: 'pair', parameters: { value: 'x', note: 'n' } },
            { name: 'pair', parameters: { value: 'y', note: 'n' } },
            { name: 'single', parameters: 'a.ts' },
            { name: 'owns', parameters: { async: true, label: 'x' } }
        ]);
    });

    it('refuses a non-boolean on a host door with the same sentence', async () => {
        const log: Probe[] = [];
        const world = fixture([answer('no model call')], {
            pair: spy('pair', log, { mode: 'sync', parameters: PAIR_SCHEMA, reply: 'door-value' })
        });

        // The shared resolver is the ONE type gate, so a host caller sees the bare
        // HarnessError (a door has no tool-result envelope to wrap it in), with the same
        // sentence the model plane reports inside its tool result.
        await expect(
            world.run.executeTool('pair', { value: 'x', note: 'n', async: 'yes' })
        ).rejects.toThrow(
            '$.async must be a boolean (true for async, false for sync); received string.'
        );
        await expect(
            world.run.callTool('pair', { value: 'x', note: 'n', async: 1 })
        ).rejects.toThrow('$.async must be a boolean (true for async, false for sync); received number.');
        expect(log).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// S9 — THE PINNED DIVERGENCE (accepted): the heartbeat resolves mode BY NAME
// ---------------------------------------------------------------------------
//
// WHAT ACTUALLY HAPPENS, pinned as an observation rather than as an aspiration: the
// shipped `async-ping` plugin arms from the `async.pending` payload, whose entries carry
// only `{ callId, name, elapsedMs }` — no resolved mode — so it re-derives the policy
// from the LIVE registry plus the GENERATED discovery table
// (./plugins/async-ping.plugin.ts:26-46). A call the harness refined to 'sync' (the lone
// delegate) or forced to 'sync' (`"async": false` on an async-declared tool) is still a
// row that says 'async', so the ping stays armed and the parked run gets ONE extra
// placeholder turn per boundary.
//
// WHY IT IS ACCEPTED: over-pinging is the safe direction (at most one extra turn — the
// same direction ./harness.sync-async.test.ts pins for a mode-less replacement of an
// async built-in name), and under-pinging is what the plugin header refuses to risk.
//
// THE FIX, for whoever closes it: put the RESOLVED mode on the payload — a `mode` field on
// the `HarnessPendingTool` entries the `async.pending` hook delivers (./types/index.ts),
// filled from the `callMode` ./harness.ts `launchToolCall` already resolves — and let
// `isAsyncPending` read that field instead of re-deriving the policy from the registry and
// the generated table. Then both tests below flip to "no wake" and the R5 rule
// ./harness.sync-async.test.ts states holds for switched and refined calls too.
describe('the heartbeat still resolves a switched call mode by name (accepted divergence, criterion 9)', () => {
    it('pings a run parked on an async-declared tool the model forced sync', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [
                calls(call('k1', 'slow', '{"value":"x","async":false}')),
                answer('parked'),
                answer('settled')
            ],
            { slow: spy('slow', [], { mode: 'async', gate }) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        const state = probe(running);
        await flush();

        // Parked by the harness's own rule (the switch), AND armed by the plugin's registry
        // lookup (step 1: the definition DECLARES 'async').
        expect(world.seen.length).toBe(1);
        expect(state.status).toBe('pending');
        expect(vi.getTimerCount()).toBe(1);

        await advance(250);

        // THE DIVERGENCE: a sync-parked run is still woken, so the run spends a turn it
        // did not need, and the projection is the pending placeholder.
        expect(wakeupsOf(world.events)).toEqual([
            { agent: 'writer', reason: 'pending-tools' }
        ]);
        expect(world.seen.length).toBe(2);
        expect(world.seen[1].some((line) => line.startsWith('tool:k1:slow-value'))).toBe(false);

        gate.resolve('slow-value');
        await flush();

        expect(world.seen.length).toBe(3);
        expect(toolMessages(world.brain.messages)).toEqual(['k1:slow-value']);
        await expect(running).resolves.toMatchObject({ content: 'settled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('pings a run parked on a refined lone delegate', async () => {
        const gate = deferred<unknown>();
        const log: string[] = [];
        const seen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];

        const writerAgent = childBrain(
            routed((request) => {
                const answers = (request.messages as Array<{ content?: string }>).filter(
                    (message) => message.role === 'tool'
                );
                if (answers.length === 0) return calls(delegateCall('c1', 'helper', 'find it'));
                return answer('final');
            }, seen)
        );

        const writer = harness({
            agents: { writer: writerAgent, helper: gatedChild('helper', gate.promise, 'helper finished', log) },
            presets: false,
            // THE SHIPPED PLUGIN: this test is about what it does today, so nothing here
            // may replace it. `wakeIntervalMs` seeds its `intervalMs`.
            wakeIntervalMs: 250,
            report: { progress: async (event) => void events.push(event) }
        });

        const running = probe(writer('go'));
        await flush();

        // The refinement parked the run (one request, no placeholder turn — criterion 3),
        // while the plugin armed a heartbeat for the `delegate:async` row.
        expect(seen.length).toBe(1);
        expect(running.status).toBe('pending');
        expect(vi.getTimerCount()).toBe(1);

        await advance(250);

        // THE DIVERGENCE, pinned: the parked-but-refined run is woken anyway and sees the
        // child as `status:'pending'` — the very placeholder the refinement exists to avoid.
        expect(wakeupsOf(events)).toEqual([
            { agent: 'writer', reason: 'pending-tools' }
        ]);
        expect(seen.length).toBe(2);
        expect(requestToolContent(seen[1], 'c1').status).toBe('pending');

        gate.resolve(undefined);
        await flush();

        // The child's OWN settlement is what delivers (the harness's sync rule), and the
        // drained board takes the heartbeat with it — the divergence costs ONE extra turn,
        // not a permanent ping.
        expect(seen.length).toBe(3);
        expect(requestToolContent(seen[2], 'c1').status).toBe('completed');
        expect(vi.getTimerCount()).toBe(0);
        expect(wakeupsOf(events)).toEqual([
            { agent: 'writer', reason: 'pending-tools' }
        ]);

        await flush();
        expect(running.status).toBe('resolved');
        expect(running.value.content).toBe('final');
    });
});
