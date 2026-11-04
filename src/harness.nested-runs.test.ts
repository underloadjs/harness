// T14: the worker-mode NESTED-RUN policy, measured on the core doors themselves.
//
// A lane worker already removes the `delegate`/`threadFork` tool entries and replaces
// `harness.runtime.delegate`; T13 proved that is not enough, because a tool BODY can start a
// child conversation through the execution context the core hands it (the shipped
// `textSummarize` did exactly that, and the child's transcript died inside the lane). What is
// pinned here is the seam that closes it — the policy a replica arms and the core enforces:
//
//   - 'allow' is the default, and every inline door behaves EXACTLY as before (control tests);
//   - an armed instance refuses every nested-run door with the named `nested-run-unsupported`
//     limitation, whatever spelling the body used: `context.run(...)`, `ctx.run(...)`,
//     `const { run } = context` destructuring, an alias, the live handle
//     (`context.harness(...)`), or a sibling brain run straight from `context.agents`;
//   - a refused door creates NOTHING observable: no child transcript, no new thread, and not one
//     provider request for the child;
//   - the arm is read at CALL time, so a tool registered or replaced after hello is covered too,
//     and the tool itself can see the policy through `context.nestedRuns`;
//   - arming never blocks the work the instance exists to do: a root call, a host-thread turn,
//     and a tool that answers locally all still succeed;
//   - a model-driven turn SURVIVES the refusal: the run answers, and the child the model asked
//     for is reported as the named limitation instead of silently weakening the guarantee.
//
// Cross-references: src/core/nested-runs.ts (the code + the sentence), src/harness.ts (the
// doors), src/server/workers/lane-worker-loop.ts `refuseNestedRuns` (who arms it),
// src/server/workers/capability.ts (the static door scan), and Temp/t14/probe-a-nested-fixed.ts
// (the standalone version of this probe).

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { NESTED_RUN_LIMITATION_CODE, nestedRunRefusalMessage } from './core';

const scripted = (turns: HarnessStreamEvent[][], requests: { count: number }): HarnessStream => {
    let index = 0;

    return async function* stream() {
        requests.count += 1;

        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const modelCall = (id: string, name: string, args = '{}'): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// One module revision, registered through the SAME kernel a model's toolCreate uses, so the body
// under test is compiled source — the shape a real created tool arrives in.
const moduleFor = (name: string, body: string): string => `
export const metadata = {
    name: '${name}',
    description: 'T14 nested-run probe tool.',
    tags: ['probe'],
    visibility: 'core',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

${body}
`;

const TOOL_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

// The six spellings of "start a nested conversation from inside a tool body", plus one body that
// HANDLES the refusal instead of being broken by it.
const BODIES = {
    // What T13 measured: a plain `context.run` call.
    ctxRunner: `
export const execute = async (context) => {
    const child = await context.run('helper', 'nested child brief');
    return 'child said ' + String(child && child.content);
};`,
    // An alias of the same closure: the guard lives inside the closure the core builds, so
    // binding the member under another name cannot dodge it.
    aliasRunner: `
export const execute = async (context) => {
    const nested = context.run;
    const child = await nested('helper', 'aliased brief');
    return 'child said ' + String(child && child.content);
};`,
    // The destructured spelling the shipped textSummarize writes.
    destructuredRunner: `
export const execute = async ({ run }) => {
    const child = await run('helper', 'destructured brief');
    return 'child said ' + String(child && child.content);
};`,
    // The LIVE handle used as a runner: a second ROOT conversation started from a tool body.
    handleRunner: `
export const execute = async (context) => {
    const child = await context.harness('a root run started from inside a tool body');
    return 'handle said ' + String(child && child.content);
};`,
    // A sibling brain run directly — the provider request never passes through runAgent.
    siblingRunner: `
export const execute = async (context) => {
    for await (const event of context.agents.helper.turn()) void event;
    return 'sibling turn ran';
};`,
    // A sibling brain READ: no model request, so this stays available on a lane.
    siblingReader: `
export const execute = async (context) => 'helper model ' + String(context.agents.helper.model());`,
    // A fire-and-forget body: the refusal has to be a THROW, or an ignored promise would let the
    // tool answer as if nothing happened.
    ignoredRunner: `
export const execute = async (context) => {
    context.run('helper', 'nobody awaits me');
    return 'looks ok';
};`,
    // The documented worker-safe shape: check the reported policy and take the local path.
    fallbackRunner: `
export const execute = async (context) => {
    if (context.nestedRuns === 'refuse') return 'local fallback instead of a child';
    const child = await context.run('helper', 'a brief for the child');
    return 'child said ' + String(child && child.content);
};`,
    // T15: a body that KEEPS the references it was handed and fires them from a DETACHED
    // continuation — exactly what a callback, a timer or a module-scope capture left behind does.
    // Nothing here can be bound by a timing window (the body has already returned), so what the
    // exposure hands out must itself be the guard. Each outcome is recorded as plain text.
    captureRefs: `
export const execute = async (context) => {
    const { harness, run, agents } = context;
    const memory = harness.memory;
    const call = async (label, start) => {
        try {
            await start();
            memory.set('t15.' + label, 'RAN');
        } catch (error) {
            memory.set('t15.' + label, String(error.name));
        }
    };

    const late = async () => {
        await call('callable', () => harness('a late root run'));
        await call('run', () => run('helper', 'a late child'));
        await call('sibling', async () => {
            for await (const event of agents.helper.turn()) void event;
        });
        memory.set('t15.done', true);
    };

    // A macrotask, so the continuation demonstrably fires AFTER this invocation settled: a
    // microtask could still land inside the scheduler's own unwinding, which is the timing window
    // this test deliberately does NOT rely on.
    setTimeout(() => void late(), 0);

    return 'settled first';
};`,
    // T15: what the handle surface itself is on each side of the policy. Reads must keep working
    // (that is what a routed cross-thread toolbox needs) and only the conversation-starting members
    // may refuse; writing through the view must land on the LIVE instance, not on a copy.
    handleProbe: `
export const execute = async (context) => {
    const view = context.harness;
    const facts = {
        sameObjectOnEveryRead: view === context.harness,
        policy: view.nestedRuns(),
        toolsVisible: Object.keys(view.tools).length > 0,
        helperTranscript: JSON.stringify(view.threadMessages('agent:helper'))
    };

    view.memory.set('t15.through-view', 'written by the view');

    try {
        const start = view.sendThreadInput;
        facts.sendThreadInput = 'READABLE';
    } catch (error) {
        facts.sendThreadInput = String(error.name);
    }

    try {
        await view('a root run started from a tool body');
        facts.callable = 'RAN';
    } catch (error) {
        facts.callable = String(error.name);
    }

    return JSON.stringify(facts);
};`
};

type HarnessUnderTest = ReturnType<typeof harness>;

const counts = () => ({ writer: { count: 0 }, helper: { count: 0 } });

// A two-agent harness: `writer` is the entry, `helper` is the sibling a nested run would drive.
const build = (turns?: Record<string, HarnessStreamEvent[][]>): { instance: HarnessUnderTest; seen: ReturnType<typeof counts> } => {
    const seen = counts();

    const instance = harness({
        agents: {
            writer: agent({ model: 'test/model', stream: scripted(turns?.writer ?? [answer('the writer answer')], seen.writer) }),
            helper: agent({ model: 'test/model', stream: scripted(turns?.helper ?? [answer('the child answer')], seen.helper) })
        },
        presets: false
    });

    return { instance, seen };
};

const register = async (instance: HarnessUnderTest, name: keyof typeof BODIES): Promise<void> => {
    await instance.registerTool({
        name: String(name),
        description: 'T14 nested-run probe tool.',
        tags: ['probe'],
        parameters: TOOL_PARAMETERS as never,
        moduleText: moduleFor(String(name), BODIES[name])
    });
};

// Full `role:content` rows: the assertions below quote exact values, so nothing is truncated.
const transcript = (instance: HarnessUnderTest, threadId: string): string[] =>
    (instance.threadMessages(threadId) as { role: string; content: unknown }[]).map((message) => `${message.role}:${String(message.content)}`);

const roster = (instance: HarnessUnderTest): string[] =>
    (((instance.snapshot() as { threads?: { id: string }[] }).threads ?? []) as { id: string }[]).map((record) => record.id).sort();

// `harness(...)` and `sendThreadInput` resolve to the assistant MESSAGE, not a string.
const contentOf = async (promise: Promise<{ content: string }>): Promise<string> => (await promise).content;

const rejection = async (promise: Promise<unknown>): Promise<{ name: string; message: string }> =>
    await promise.then(
        () => {
            throw new Error('expected the nested-run door to reject');
        },
        (error: { name: string; message: string }) => ({ name: error.name, message: error.message })
    );

// Wait until a retained continuation has recorded its outcome. The probe bodies fire from a
// macrotask on purpose (see `captureRefs`), so this is a bounded wait for a fact, never a sleep
// that could mask a missing refusal.
const recorded = async (instance: HarnessUnderTest, key: string, limitMs = 4_000): Promise<void> => {
    const started = Date.now();

    while (instance.memory.get(key) === undefined) {
        if (Date.now() - started > limitMs) {
            throw new Error(`The retained continuation never recorded "${key}" (within ${limitMs}ms).`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe('the nested-run policy', () => {
    it('defaults to allow and arms a validated policy', () => {
        const { instance } = build();

        // Nothing changes for an inline host: the default is the historical behaviour.
        expect(instance.nestedRuns()).toBe('allow');

        expect(instance.nestedRuns('refuse')).toBe('refuse');
        expect(instance.nestedRuns()).toBe('refuse');

        // Values are checked, never coerced: a typo must not leave a replica believing it refused.
        expect(() => instance.nestedRuns('maybe' as never)).toThrow('nestedRuns must be one of: "allow", "refuse"; received maybe.');
        expect(instance.nestedRuns()).toBe('refuse');

        expect(NESTED_RUN_LIMITATION_CODE).toBe('nested-run-unsupported');
    });

    it('refuses a tool-context run before any child state exists', async () => {
        const { instance, seen } = build();

        await register(instance, 'ctxRunner');
        instance.nestedRuns('refuse');

        const failure = await rejection(instance.executeTool('ctxRunner', {}));

        // Named, in the words the model and the operator both read.
        expect(failure.name).toBe(NESTED_RUN_LIMITATION_CODE);
        expect(failure.message).toBe(nestedRunRefusalMessage('context.run("helper")'));
        expect(failure.message).toContain('threadExecution "inline"');

        // The refusal happened BEFORE the child: no conversation, no roster entry, and not one
        // provider request for the sibling.
        expect(transcript(instance, 'agent:helper')).toEqual([]);
        expect(roster(instance)).toEqual([]);
        expect(seen.helper.count).toBe(0);
    });

    it('refuses the aliased and destructured spellings of the same door', async () => {
        const { instance, seen } = build();

        await register(instance, 'aliasRunner');
        await register(instance, 'destructuredRunner');
        instance.nestedRuns('refuse');

        expect((await rejection(instance.executeTool('aliasRunner', {}))).message).toBe(nestedRunRefusalMessage('context.run("helper")'));
        expect((await rejection(instance.executeTool('destructuredRunner', {}))).message).toBe(nestedRunRefusalMessage('context.run("helper")'));

        expect(seen.helper.count).toBe(0);
        expect(transcript(instance, 'agent:helper')).toEqual([]);
    });

    it('refuses a fire-and-forget context.run, so an ignored promise cannot answer as if it worked', async () => {
        const { instance, seen } = build();

        await register(instance, 'ignoredRunner');
        instance.nestedRuns('refuse');

        // The throw is synchronous inside the guarded closure, so the CALL FAILS — it does not
        // leave a rejection nobody looks at while the tool returns "looks ok".
        expect((await rejection(instance.executeTool('ignoredRunner', {}))).message).toBe(nestedRunRefusalMessage('context.run("helper")'));
        expect(seen.helper.count).toBe(0);
    });

    it('refuses the live handle and a sibling brain, but never a plain sibling read', async () => {
        const { instance, seen } = build();

        await register(instance, 'handleRunner');
        await register(instance, 'siblingRunner');
        await register(instance, 'siblingReader');
        instance.nestedRuns('refuse');

        expect((await rejection(instance.executeTool('handleRunner', {}))).message).toBe(nestedRunRefusalMessage('harness(...) called from a tool body'));
        expect((await rejection(instance.executeTool('siblingRunner', {}))).message).toBe(nestedRunRefusalMessage('harness.agents.helper.turn()'));

        // `context.agents` stays the live registry for everything that is not a run: a read of a
        // sibling's model answers normally, so the guard closes doors, not the whole surface.
        expect(await instance.executeTool('siblingReader', {})).toBe('helper model test/model');

        expect(seen.helper.count).toBe(0);
        expect(roster(instance)).toEqual([]);
    });

    // T15: the door a TIMING window could never close. A body keeps whatever it is handed — a
    // callback, a timer, a module-scope capture — and may call it long after its own invocation
    // settled, when no tool body is "in flight" any more. On a refusing instance the object the
    // body holds IS the guard (`toolHandleView` / `toolAgentsView` / the guarded `run` closure), so
    // the WHEN of the call stops mattering. The probe below fires its retained references from a
    // macrotask, so the refusal cannot be credited to the body still being open.
    it('refuses a handle, a run and a sibling brain the body kept past its own settled call', async () => {
        const { instance, seen } = build({
            writer: [answer('the late root answer')],
            helper: [answer('the late child answer'), answer('the late sibling answer')]
        });

        await register(instance, 'captureRefs');
        instance.nestedRuns('refuse');

        // The invocation SETTLES here; every outcome asserted below is recorded after it.
        expect(await instance.executeTool('captureRefs', {})).toBe('settled first');
        await recorded(instance, 't15.done');

        expect(instance.memory.get('t15.callable')).toBe(NESTED_RUN_LIMITATION_CODE);
        expect(instance.memory.get('t15.run')).toBe(NESTED_RUN_LIMITATION_CODE);
        expect(instance.memory.get('t15.sibling')).toBe(NESTED_RUN_LIMITATION_CODE);

        // Refused late is still refused completely: no root run, no child, no sibling turn, no
        // roster entry, and not one provider request on either brain.
        expect(transcript(instance, 'agent:writer')).toEqual([]);
        expect(transcript(instance, 'agent:helper')).toEqual([]);
        expect(roster(instance)).toEqual([]);
        expect(seen.writer.count).toBe(0);
        expect(seen.helper.count).toBe(0);
    });

    it('hands a refusing tool a guarded view, while an inline host keeps the identical live handle', async () => {
        const armed = build();

        await register(armed.instance, 'handleProbe');
        armed.instance.nestedRuns('refuse');

        // Only the conversation-starting members refuse. Everything a lane toolbox actually needs —
        // the registry, a thread read, the policy itself, `memory` — answers, so the guard closes
        // doors rather than lobotomising the surface the routed operations ride on.
        expect(JSON.parse(String(await armed.instance.executeTool('handleProbe', {})))).toEqual({
            sameObjectOnEveryRead: true,
            policy: 'refuse',
            toolsVisible: true,
            helperTranscript: '[]',
            sendThreadInput: NESTED_RUN_LIMITATION_CODE,
            callable: NESTED_RUN_LIMITATION_CODE
        });

        // The view is bound to THIS instance, not a snapshot of it: what the body wrote through the
        // view is the live harness's own memory — the state a lane commits.
        expect(armed.instance.memory.get('t15.through-view')).toBe('written by the view');
        expect(armed.seen.writer.count).toBe(0);

        // The inline control is byte-for-byte the historical surface: readable AND runnable.
        const control = build();

        await register(control.instance, 'handleProbe');

        expect(JSON.parse(String(await control.instance.executeTool('handleProbe', {})))).toEqual({
            sameObjectOnEveryRead: true,
            policy: 'allow',
            toolsVisible: true,
            helperTranscript: '[]',
            sendThreadInput: 'READABLE',
            callable: 'RAN'
        });
        expect(control.instance.memory.get('t15.through-view')).toBe('written by the view');
        expect(control.seen.writer.count).toBe(1);
        expect(transcript(control.instance, 'agent:writer')).toEqual(['user:a root run started from a tool body', 'assistant:the writer answer']);
    });

    it('lets an inline host run a reference the body kept, exactly as it always did', async () => {
        const { instance, seen } = build({
            writer: [answer('the late root answer')],
            helper: [answer('the late child answer'), answer('the late sibling answer')]
        });

        await register(instance, 'captureRefs');

        // No policy armed (the inline default), so the retained references still do what they
        // always did — this is the half of the change that must NOT move.
        expect(await instance.executeTool('captureRefs', {})).toBe('settled first');
        await recorded(instance, 't15.done');

        expect(instance.memory.get('t15.callable')).toBe('RAN');
        expect(instance.memory.get('t15.run')).toBe('RAN');
        expect(instance.memory.get('t15.sibling')).toBe('RAN');
        expect(seen.writer.count).toBe(1);
        expect(seen.helper.count).toBe(2);
    });

    it('lets a tool that respects the reported policy answer locally, and leaves the lane work untouched', async () => {        const { instance, seen } = build();

        await register(instance, 'fallbackRunner');
        instance.nestedRuns('refuse');

        expect(await instance.executeTool('fallbackRunner', {})).toBe('local fallback instead of a child');
        expect(seen.helper.count).toBe(0);

        // The lane's OWN conversation is not a nested run: a root call and a host-thread turn both
        // still execute, which is what a lane worker drives every turn.
        expect(await contentOf(instance('carry on'))).toBe('the writer answer');

        const thread = instance.createThread('writer');

        expect(await contentOf(instance.sendThreadInput(thread.id, 'a queued turn'))).toBe('the writer answer');
    });

    it('reports the refusal to the model and keeps the turn alive', async () => {
        const { instance, seen } = build({
            writer: [modelCall('c1', 'ctxRunner'), answer('the writer answered after the refusal')],
            helper: [answer('the child answer')]
        });

        await register(instance, 'ctxRunner');
        instance.nestedRuns('refuse');

        expect(await contentOf(instance('run the probe tool'))).toBe('the writer answered after the refusal');

        // The model reads the NAMED limitation in its own transcript, and the child it asked for
        // never existed: no sibling request, no leaked child answer. The tool row is the exact
        // sentence the core throws, in the exact shape the runtime reports a failed call.
        const refusalRow = (instance.threadMessages('agent:writer') as { role: string; content: unknown }[]).find((message) => message.role === 'tool');

        expect(String(refusalRow?.content)).toBe(`Tool "ctxRunner" failed: ${nestedRunRefusalMessage('context.run("helper")')}`);
        expect(JSON.stringify(instance.threadMessages('agent:writer'))).not.toContain('the child answer');
        expect(seen.helper.count).toBe(0);
        expect(transcript(instance, 'agent:helper')).toEqual([]);
    });

    it('refuses the delegate and threadFork paths as well, once the policy is armed', async () => {
        const { instance, seen } = build({
            writer: [modelCall('c1', 'delegate', '{"agent":"helper","input":"a brief"}'), modelCall('c2', 'threadFork', '{"input":"a branch brief"}'), answer('the writer answered'), ],
            helper: [answer('the child answer')]
        });

        // Both tools really exist here, or the refusal below would prove nothing.
        expect(instance.tools.delegate).toBeDefined();
        expect(instance.tools.threadFork).toBeDefined();

        instance.nestedRuns('refuse');

        expect(await contentOf(instance('delegate then fork'))).toBe('the writer answered');

        const writerTranscript = JSON.stringify(instance.threadMessages('agent:writer'));

        expect(writerTranscript).toContain(NESTED_RUN_LIMITATION_CODE);
        expect(seen.helper.count).toBe(0);
        expect(transcript(instance, 'agent:helper')).toEqual([]);
    });

    it('keeps every door open while the policy allows nesting (the inline control)', async () => {
        // A FRESH instance per door, so every assertion below names the exact state that door
        // produced — no cumulative transcript to reason about.
        const direct = build();

        await register(direct.instance, 'ctxRunner');
        expect(await direct.instance.executeTool('ctxRunner', {})).toBe('child said the child answer');
        expect(transcript(direct.instance, 'agent:helper')).toEqual(['user:nested child brief', 'assistant:the child answer']);
        expect(direct.seen.helper.count).toBe(1);

        const aliased = build();

        await register(aliased.instance, 'aliasRunner');
        expect(await aliased.instance.executeTool('aliasRunner', {})).toBe('child said the child answer');
        expect(transcript(aliased.instance, 'agent:helper')).toEqual(['user:aliased brief', 'assistant:the child answer']);
        expect(aliased.seen.helper.count).toBe(1);

        const destructured = build();

        await register(destructured.instance, 'destructuredRunner');
        expect(await destructured.instance.executeTool('destructuredRunner', {})).toBe('child said the child answer');
        expect(transcript(destructured.instance, 'agent:helper')).toEqual(['user:destructured brief', 'assistant:the child answer']);
        expect(destructured.seen.helper.count).toBe(1);

        const viaHandle = build();

        await register(viaHandle.instance, 'handleRunner');
        expect(await viaHandle.instance.executeTool('handleRunner', {})).toBe('handle said the writer answer');
        // Exactly one model request — the one the tool body started through the live handle.
        expect(viaHandle.seen.writer.count).toBe(1);
        expect(transcript(viaHandle.instance, 'agent:writer')).toEqual([
            'user:a root run started from inside a tool body',
            'assistant:the writer answer'
        ]);

        const viaSibling = build();

        await register(viaSibling.instance, 'siblingRunner');
        expect(await viaSibling.instance.executeTool('siblingRunner', {})).toBe('sibling turn ran');
        // The brain ran WITHOUT a runAgent call: the append is visible, and it cost one request.
        expect(transcript(viaSibling.instance, 'agent:helper')).toEqual(['assistant:the child answer']);
        expect(viaSibling.seen.helper.count).toBe(1);

        const aware = build();

        await register(aware.instance, 'fallbackRunner');
        // The policy-aware tool still takes the NESTED path when nesting is allowed.
        expect(await aware.instance.executeTool('fallbackRunner', {})).toBe('child said the child answer');
        expect(aware.seen.helper.count).toBe(1);
        expect(aware.instance.nestedRuns()).toBe('allow');
    });
});
