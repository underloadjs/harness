// Tool-execution containment (bugfix regression).
//
// Contract pinned here:
//   - a REGISTERED/COMPILED tool that throws synchronously, rejects
//     asynchronously, or throws a non-Error value becomes a failed tool result
//     for the model; the same run continues with its other calls and later turns;
//   - a nested live-registry call that fails propagates to its caller (awaited)
//     or is observed without becoming a process-level unhandledRejection
//     (fire-and-forget), and never poisons the scheduler/run;
//   - a manual host call still REJECTS with the implementation error (the
//     documented contract), but an ignored call cannot crash the process;
//   - a tool result that cannot be serialized is reported as a failed tool call
//     instead of aborting the run through the delivery/mailbox path;
//   - cancellation still reaches a compiled tool's signal and its rejection is
//     visible to the caller; the harness remains usable afterwards.
//
// The implementations below are real runtime-compiled modules loaded through
// `registerTool` (core/tool-source.ts), not prebuilt Tool objects, so the exact
// compiled path is exercised.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type {
    HarnessEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// One frame list per model request. The final list repeats, mirroring the
// scripted provider used by the other harness tests.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[Math.min(index, turns.length - 1)];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const call = (id: string, name: string, args = '{}'): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: [{ id, name, arguments: args }]
    }
];

const brain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'test/model', stream });

// A provider that rejects asynchronously, used to make `context.run` return a
// promise that fails AFTER the compiled tool has already returned.
const failingStream = (message: string): HarnessStream =>
    async function* stream() {
        throw new Error(message);
    };

// A module in the runtime-tools shape. `visibility: 'core'` makes it declared to
// this agent without a toolRequest round, so the model can call it immediately.
const moduleFor = (name: string, body: string): string => `
export const metadata = {
    name: ${JSON.stringify(name)},
    description: 'Compiled ${name} probe.',
    tags: ['probe'],
    visibility: 'core'
};

export const execute = async (context) => {
    ${body}
};
`;

// A Tool-like export WITHOUT tool()'s async wrapper. This is a legal compiled
// module shape and its `execute` is genuinely synchronous, so it pins the raw
// synchronous-throw boundary rather than only the normalized async path.
const rawSyncThrowModule = (name: string, message: string): string => `
const callable = () => undefined;
Object.defineProperty(callable, 'name', { value: ${JSON.stringify(name)} });
callable.description = 'Raw compiled throw probe.';
callable.tags = ['probe'];
callable.visibility = 'core';
callable.execute = () => { throw new Error(${JSON.stringify(message)}); };
export const ${name} = callable;
`;

const makeHarness = (stream: HarnessStream, events?: HarnessEvent[]) =>
    harness({
        agents: { writer: brain(stream) },
        presets: false,
        ...(events === undefined
            ? {}
            : { report: { progress: (event) => void events.push(event) } })
    });

const toolResults = (events: HarnessEvent[]) =>
    events.filter(
        (event): event is Extract<HarnessEvent, { type: 'tool_result' }> =>
            event.type === 'tool_result'
    );

const resultByCall = (events: HarnessEvent[], callId: string) =>
    toolResults(events).find((event) => event.callId === callId);

// Capture process-level unhandled rejections for one critical section. The
// listener is removed in `finally`; the assertion is exact (no events), which is
// what a fire-and-forget compiled call must produce after containment.
const withUnhandledCapture = async (work: () => Promise<void>): Promise<unknown[]> => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
        unhandled.push(reason);
    };

    process.on('unhandledRejection', listener);
    try {
        await work();
        // Let the rejection/observation microtasks and the unhandled check run.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
        process.off('unhandledRejection', listener);
    }

    return unhandled;
};

describe('compiled tool failure containment', () => {
    it('turns a synchronous throw into a failed result and keeps the turn alive', async () => {
        const events: HarnessEvent[] = [];
        const entry = brain(
            scripted([call('c1', 'syncBoom'), call('c2', 'echo'), answer('recovered')])
        );
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer.registerTool({
            name: 'syncBoom',
            moduleText: moduleFor('syncBoom', "throw new Error('sync-boom');")
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        const final = await writer('go');

        expect(final.content).toBe('recovered');
        expect(resultByCall(events, 'c1')).toMatchObject({
            type: 'tool_result',
            agent: 'writer',
            name: 'syncBoom',
            callId: 'c1',
            content: 'Tool "syncBoom" failed: sync-boom',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({
            type: 'tool_result',
            agent: 'writer',
            name: 'echo',
            callId: 'c2',
            content: 'still-alive',
            isError: false,
            outcome: 'completed'
        });
        expect(entry.messages[2]).toEqual({
            role: 'tool',
            content: 'Tool "syncBoom" failed: sync-boom',
            toolCallId: 'c1',
            name: 'syncBoom'
        });

        // The same harness stays usable manually and the failing name still
        // rejects when the host explicitly asks for it.
        await expect(writer.executeTool('echo', {})).resolves.toBe('still-alive');
        await expect(writer.executeTool('syncBoom', {})).rejects.toThrow('sync-boom');
    });

    it('treats thrown/rejected undefined as failures, not successful undefined results', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([
                call('u1', 'throwUndefined'),
                call('u2', 'rejectUndefined'),
                call('u3', 'echo'),
                answer('recovered')
            ]),
            events
        );

        await writer.registerTool({
            name: 'throwUndefined',
            moduleText: moduleFor('throwUndefined', 'throw undefined;')
        });
        await writer.registerTool({
            name: 'rejectUndefined',
            moduleText: moduleFor('rejectUndefined', 'return Promise.reject(undefined);')
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'u1')).toMatchObject({
            content: 'Tool "throwUndefined" failed: Unknown harness error',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'u2')).toMatchObject({
            content: 'Tool "rejectUndefined" failed: Unknown harness error',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'u3')).toMatchObject({
            content: 'still-alive',
            isError: false,
            outcome: 'completed'
        });
    });

    it('turns an async promise rejection into a failed result', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'asyncBoom'), call('c2', 'echo'), answer('recovered')]),
            events
        );

        await writer.registerTool({
            name: 'asyncBoom',
            moduleText: moduleFor('asyncBoom', "return Promise.reject(new Error('async-boom'));")
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'Tool "asyncBoom" failed: async-boom',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({
            content: 'still-alive',
            isError: false,
            outcome: 'completed'
        });
    });

    it.each([
        ["throw 42", '42'],
        ["throw 'plain-string'", 'plain-string'],
        ["throw { message: 'object-message', code: 'E_OBJECT' }", 'object-message'],
        ["throw { code: 'E_SHAPE', retry: false }", '{"code":"E_SHAPE","retry":false}'],
        ["throw Symbol('toast')", 'Symbol(toast)'],
        [
            "throw { get message() { throw new Error('hostile-message'); } }",
            'Unknown harness error'
        ]
    ])('reports an unusual thrown value (%s) without throwing in the reporter', async (body, reason) => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'weird', '{}'), answer('recovered')]),
            events
        );

        await writer.registerTool({
            name: 'weird',
            moduleText: moduleFor('weird', `${body};`)
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: `Tool "weird" failed: ${reason}`,
            isError: true,
            outcome: 'failed'
        });
    });

    it('contains a compiled Tool-like export whose execute throws synchronously', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'rawBoom'), call('c2', 'echo'), answer('recovered')]),
            events
        );

        await writer.registerTool({
            name: 'rawBoom',
            moduleText: rawSyncThrowModule('rawBoom', 'raw-sync-boom')
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'Tool "rawBoom" failed: raw-sync-boom',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({ content: 'still-alive' });
    });

    it('propagates an awaited nested live-registry failure to the calling tool result', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'outer'), call('c2', 'echo'), answer('recovered')]),
            events
        );

        await writer.registerTool({
            name: 'nestedBoom',
            moduleText: moduleFor('nestedBoom', "throw new Error('nested-boom');")
        });
        // `context.callTool` resolves the sibling through the LIVE registry at call
        // time and returns its rejected promise unchanged.
        await writer.registerTool({
            name: 'outer',
            moduleText: moduleFor(
                'outer',
                "return await context.callTool('nestedBoom', {});"
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'Tool "outer" failed: nested-boom',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({ content: 'still-alive' });
    });

    it('contains a fire-and-forget nested rejection from a compiled tool', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'careless'), call('c2', 'echo'), answer('recovered')]),
            events
        );

        await writer.registerTool({
            name: 'nestedBoom',
            moduleText: moduleFor('nestedBoom', "throw new Error('nested-boom');")
        });
        // The compiled body never awaits or handles the nested promise. It looks
        // healthy (it returns 'looks-ok'); before containment this became an
        // unhandledRejection that could terminate the Node host.
        await writer.registerTool({
            name: 'careless',
            moduleText: moduleFor(
                'careless',
                "context.callTool('nestedBoom', {}); return 'looks-ok';"
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        let final: Awaited<ReturnType<typeof writer>> | undefined;

        const unhandled = await withUnhandledCapture(async () => {
            final = await writer('go');

            // A host that ignores a manual failure must not crash either. Leave
            // the promise unobserved across a macrotask so a missing internal
            // observer would surface as unhandledRejection; the original promise
            // still rejects for the caller that awaits it afterwards.
            const ignored = writer.executeTool('nestedBoom', {});
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await expect(ignored).rejects.toThrow('nested-boom');
        });

        expect(unhandled).toEqual([]);
        expect(final?.content).toBe('recovered');
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'looks-ok',
            isError: false,
            outcome: 'completed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({ content: 'still-alive' });
    });

    it('contains ignored context.run rejections from compiled tools (model and manual)', async () => {
        const events: HarnessEvent[] = [];
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([call('c1', 'carelessRun'), call('c2', 'echo'), answer('recovered')])
                ),
                helper: brain(failingStream('helper-boom'))
            },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer.registerTool({
            name: 'carelessRun',
            moduleText: moduleFor(
                'carelessRun',
                "context.run('helper', 'nested'); return 'looks-ok';"
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        const unhandled = await withUnhandledCapture(async () => {
            await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });

            // The manual path issues the same ignored `context.run` and must be
            // contained too. The compiled tool itself resolves successfully.
            const ignored = writer.executeTool('carelessRun', {});
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await expect(ignored).resolves.toBe('looks-ok');
        });

        expect(unhandled).toEqual([]);
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'looks-ok',
            isError: false,
            outcome: 'completed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({ content: 'still-alive' });
    });

    it('reports synchronous and awaited context.run failures as failed tool results', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([
                call('c1', 'missingRun'),
                call('c2', 'awaitedReentry'),
                call('c3', 'echo'),
                answer('recovered')
            ]),
            events
        );

        // A missing target throws synchronously inside the compiled async body.
        await writer.registerTool({
            name: 'missingRun',
            moduleText: moduleFor('missingRun', "context.run('ghost', 'x'); return 'looks-ok';")
        });
        // An awaited rejection must reach the tool result unchanged: the observer
        // does not swallow it or replace it with `undefined`.
        await writer.registerTool({
            name: 'awaitedReentry',
            moduleText: moduleFor(
                'awaitedReentry',
                "return await context.run('writer', 'nested');"
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'Tool "missingRun" failed: Agent "ghost" is not registered.',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({
            content:
                'Tool "awaitedReentry" failed: Agent "writer" is already running; it cannot be re-entered (delegation cycle).',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c3')).toMatchObject({
            content: 'still-alive',
            isError: false,
            outcome: 'completed'
        });
    });

    it('reports a result the harness cannot serialize as a failed tool result', async () => {
        const events: HarnessEvent[] = [];
        const writer = makeHarness(
            scripted([call('c1', 'badResult'), call('c2', 'echo'), answer('recovered')]),
            events
        );

        // The tool itself succeeds; only the RESULT is unusable. `toJSON` gives a
        // deterministic serialization error (unlike the engine-specific circular
        // TypeError text).
        await writer.registerTool({
            name: 'badResult',
            moduleText: moduleFor(
                'badResult',
                "return { toJSON() { throw new Error('bad-result'); } };"
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'recovered' });
        expect(resultByCall(events, 'c1')).toMatchObject({
            content: 'Tool "badResult" completed but its result could not be serialized: bad-result',
            isError: true,
            outcome: 'failed'
        });
        expect(resultByCall(events, 'c2')).toMatchObject({
            content: 'still-alive',
            isError: false,
            outcome: 'completed'
        });
    });

    it('keeps manual failure rejection semantics without poisoning later runs', async () => {
        const events: HarnessEvent[] = [];
        const entry = brain(scripted([answer('after-failure')]));
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer.registerTool({
            name: 'manualBoom',
            moduleText: moduleFor('manualBoom', "throw new Error('manual-boom');")
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        await expect(writer.executeTool('manualBoom', {})).rejects.toThrow('manual-boom');
        await expect(writer.executeTool('echo', {})).resolves.toBe('still-alive');

        // No stuck task/gate: a normal model run still completes afterwards and
        // sees no leaked failure.
        await expect(writer('go')).resolves.toMatchObject({ content: 'after-failure' });
        expect(entry.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'after-failure' }
        ]);
    });

    it('delivers cancellation to a compiled tool and remains usable afterwards', async () => {
        const writer = makeHarness(scripted([answer('unused')]));

        await writer.registerTool({
            name: 'hold',
            moduleText: moduleFor(
                'hold',
                `return new Promise((resolve, reject) => {
                    const signal = context.signal;
                    if (signal.aborted) {
                        reject(signal.reason);
                        return;
                    }
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });`
            )
        });
        await writer.registerTool({
            name: 'echo',
            moduleText: moduleFor('echo', "return 'still-alive';")
        });

        const controller = new AbortController();
        const pending = writer.callTool('hold', {}, { signal: controller.signal });
        controller.abort(new Error('stop-now'));

        await expect(pending).rejects.toThrow('stop-now');
        await expect(writer.executeTool('echo', {})).resolves.toBe('still-alive');
    });
});
