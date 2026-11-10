// Context-compaction T8 — the harness PARK/QUEUE primitives.
//
// WHAT THIS FILE PINS
// -------------------
// A 'paused' thread is a conversation a PLUGIN owns. Before T8 a model-driven
// submission (the `threadSend` tool → `postThreadMessage`) LIFTED that park and started
// a turn in it, which made the holder of a park (the compaction plugin, T9) lose its own
// turn to whatever spoke last. The operator-approved semantics pinned here:
//
//   paused + threadSend      → QUEUE (`delivered: 'queued'`), park preserved, no run
//   paused + threads.steer   → QUEUE (`queued: true`),          park preserved
//   paused + sendThreadInput → still REVIVES and runs (the host escape hatch, unchanged)
//   running / idle / stopped → unchanged (regression group below + the citations in it)
//
// plus the new plugin contract T9 consumes EXACTLY as typed:
//
//   api.threads.pause(id)  → parks (idempotent), throws for an unknown id, refuses stopped
//   api.threads.resume(id) → un-parks to 'running' (run attached) / 'idle' (no run);
//                            a no-op that returns the record for anything not parked
//
// and the PARK OWNERSHIP rule T11 (D1) adds on top of that pair:
//
//   a park taken by a plugin's `turn.before` payload is OWNED by that plugin — a later
//   plugin's payload `pause()` on the same round neither steals it nor lifts it, and the
//   holder's own `resume()` (this round or a later one) still does;
//   an OWNERLESS park — `api.threads.pause`, a decision-channel `{action:'pause'}`, or a
//   park by a host path — is lifted by anyone, which is what keeps a stranded
//   conversation reachable through `api.threads.resume` and a host `sendThreadInput`.
//
// The ownership group below is two-plugin fixtures on purpose: the claim is about what a
// SECOND plugin's controls do to a park the FIRST one took, which is the shipped
// `context-compaction` (first) + `context-trimmer` (second) arrangement
// (./plugin/manifest.ts:42-58, sequential dispatch in ./plugin/hooks.ts).
//
// Drain semantics — the half that makes queueing useful. A queued submission lands in
// the SAME `ThreadState.queue` a running steer uses, drained by `drainThreadQueue` as an
// ordinary user message at the loop's safe boundary (`harness.ts` `runAgentCore`, which
// calls `drainThreadQueue(run)` immediately before `requestTurn`). So:
//   - a park taken INSIDE a run is applied at THAT run's next boundary — the top of the
//     loop, or the terminal re-check (`if (drainThreadQueue(run)) continue`, "guidance
//     that arrived while this final turn was in flight buys one more turn") when the run
//     was already answering. Either way it is one run, never a second one;
//   - a park that OUTLIVED its run drains at the first boundary of the NEXT run.
//
// Cross-references:
//   - ./harness.ts `postThreadMessage`    — the `paused` branch that replaced the resume
//   - ./harness.ts `steerThread`          — the `paused` branch (queue, never resume)
//   - ./harness.ts `pauseThreadState`/`resumeThreadState` — the helpers behind the api
//   - ./harness.ts `sendThreadInput`      — the untouched host revival path
//   - ./types/index.ts `HarnessPluginApi.threads.pause`/`resume` — the same contract as typed
//   - ./harness.thread-runtime.test.ts    — the `threadSend` state table (the T3 group)
//                                           and the transport helpers mirrored below
//   - ./harness.plugin.test.ts            — the `turn.before` park + lifecycle-event fixtures

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    Harness,
    HarnessPluginApi,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessThreadRecord
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Fixtures (mirrored from ./harness.thread-runtime.test.ts so both files read alike)
// ---------------------------------------------------------------------------

// Canonical transcript entries carry a minted `messageId` (context T1); it is identity,
// not content, so it is stripped DEEPLY and pinned where it is the subject.
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// A roster record gains a minted `invocationId` once its thread has run (the join key
// for `agentResult`); like `messageId` it is identity, not content. Dropping it keeps
// every record assertion below an exact `toEqual` over the fields this change can move
// (`id`, `agent`, `origin`, `status`, `sequence`, `label`).
const stableRecord = (
    record: HarnessThreadRecord
): Omit<HarnessThreadRecord, 'invocationId'> => {
    const { invocationId: _dropped, ...stable } = record;

    return stable;
};

const recordOf = (host: Harness, threadId: string): Omit<HarnessThreadRecord, 'invocationId'> => {
    const record = host.thread(threadId);

    if (record === undefined) throw new Error(`Thread "${threadId}" is missing from the roster.`);

    return stableRecord(record);
};

// Replay scripted frames, one list per REQUEST; the last list repeats. `seen` counts
// provider requests, which is how "no run started" becomes an exact assertion.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const brain = (stream: HarnessStream): Agent => agent({ model: 'merge/ds4-flash', stream });

// Drain microtasks plus one zero-delay timer so a fire-and-forget run reaches its next
// resting point without depending on wall-clock time.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
};

// Join a run the harness started FIRE-AND-FORGET (`threadSend` into an idle thread),
// waiting for the conversation to come back to 'idle'. The bound is a failure, not a
// hang: a run that never settles breaks this assertion instead of the test timeout.
const settleThread = async (host: Harness, threadId: string): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await flush();
        if (host.thread(threadId)?.status === 'idle') return;
    }

    throw new Error(`Thread "${threadId}" never returned to idle after a detached run.`);
};

// Wait for a status the harness writes from INSIDE a run (the park), bounded so a
// missing transition fails this test instead of timing it out.
const waitStatus = async (host: Harness, threadId: string, status: string): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await flush();
        if (host.thread(threadId)?.status === status) return;
    }

    throw new Error(
        `Thread "${threadId}" never reached "${status}" (last status: ${
            host.thread(threadId)?.status ?? 'missing'
        }).`
    );
};

type Gate = { promise: Promise<void>; open: () => void };

const gate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });

    return { promise, open };
};

// The text `postThreadMessage` attributes to a HANDLE-level `threadSend` (no calling
// run, so no `senderThreadId`) — see harness.ts `postThreadMessage`.
const attributed = (message: string): string => `from agent "writer":\n${message}`;

// One configured agent plus one observer plugin whose api the test also holds, so the
// same test can drive both the model-driven door (`executeTool('threadSend')`) and the
// plugin api. `setup` runs during `harness(...)`, so the api is live before turn one.
const fixture = (
    stream: HarnessStream,
    handler: (api: HarnessPluginApi) => void
): { harness: Harness; api: HarnessPluginApi } => {
    let captured: HarnessPluginApi | undefined;

    const instance = harness({
        agents: { writer: brain(stream) },
        plugins: [
            {
                name: 'observer',
                setup: (api) => {
                    captured = api;
                    handler(api);
                }
            }
        ],
        presets: false
    });

    if (captured === undefined) throw new Error('The observer plugin never received its api.');

    return { harness: instance, api: captured };
};

// A throwing call captured as its exact message, so a refusal is pinned as a value
// rather than as a substring match.
const failureOf = (call: () => unknown): string => {
    try {
        call();
    } catch (error) {
        return (error as Error).message;
    }

    return 'no error thrown';
};

// ---------------------------------------------------------------------------
// Queueing into a park (`postThreadMessage` / `api.threads.steer`)
// ---------------------------------------------------------------------------

describe('a parked conversation queues submissions instead of reviving (T8)', () => {
    // A `turn.before` hook parks the conversation on its first turn and never resumes
    // it, so the park OUTLIVES the run — the stranded-park shape a compaction holder
    // leaves behind, and the exact fixture ./harness.thread-runtime.test.ts (T3.2) uses.
    it('queues a threadSend into a dormant park and drains it at the next run boundary', async () => {
        const seen: HarnessStreamRequest[] = [];
        const lifecycle: string[] = [];
        let parkOnce = true;

        const { harness: writer, api } = fixture(
            scripted([answer('first answer'), answer('second answer')], seen),
            (a) => {
                a.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                a.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                a.on('turn.before', async (payload) => {
                    if (!parkOnce) return;
                    parkOnce = false;
                    await payload.pause();
                });
            }
        );

        const target = writer.createThread('writer', { label: 'Parked' });
        await writer.sendThreadInput(target.id, 'first turn');

        // The park is live and nothing has resumed it: one provider request, `paused`,
        // and the plugin has seen exactly its own `thread.paused`.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(seen).toHaveLength(1);
        expect(lifecycle).toEqual(['paused:paused']);

        await expect(
            writer.executeTool('threadSend', { thread: target.id, message: 'carry on' })
        ).resolves.toEqual({
            threadId: target.id,
            delivered: 'queued',
            sender: 'writer'
        });

        // THE CHANGE. The park survives the message: no `thread.resumed`, no second
        // provider request, and nothing appended yet — the text sits in `state.queue`,
        // which is not part of the transcript until a boundary drains it.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(lifecycle).toEqual(['paused:paused']);
        expect(seen).toHaveLength(1);
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' }
        ]);

        // The holder un-parks through the new contract. A park that outlived its run
        // returns to `idle` (no run attached), and `resume` NEVER drains the queue. The
        // api hands back the LIVE record, so the minted `invocationId` is projected the
        // same way the roster reads above are.
        expect(stableRecord(api.threads.resume(target.id))).toEqual({
            ...target,
            status: 'idle'
        });
        expect(lifecycle).toEqual(['paused:paused', 'resumed:idle']);
        expect(writer.threadMessages(target.id)).toHaveLength(2);

        const message = await writer.sendThreadInput(target.id, 'host turn');
        expect(message.content).toBe('second answer');

        // The queued message became a user turn at the NEXT run's first boundary: after
        // that run's own root prompt, before its request. Queue order is transcript
        // order (`drainThreadQueue`), which is the R5 guarantee, unchanged by T8.
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'host turn' },
            { role: 'user', content: attributed('carry on') },
            { role: 'assistant', content: 'second answer' }
        ]);
        expect(seen).toHaveLength(2);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });

    // The "no run starts" half of the same branch. Before T8 this submission started a
    // turn (stealing the holder's turn); now it must touch the provider not at all.
    it('starts no run when a message lands on a parked conversation with no run', async () => {
        const seen: HarnessStreamRequest[] = [];
        const runs: string[] = [];
        let parkOnce = true;

        const { harness: writer } = fixture(scripted([answer('first answer')], seen), (api) => {
            api.on('run.started', (payload) => void runs.push(payload.input));
            api.on('turn.before', async (payload) => {
                if (!parkOnce) return;
                parkOnce = false;
                await payload.pause();
            });
        });

        const target = writer.createThread('writer');
        await writer.sendThreadInput(target.id, 'first turn');

        await expect(
            writer.executeTool('threadSend', { thread: target.id, message: 'queued only' })
        ).resolves.toEqual({
            threadId: target.id,
            delivered: 'queued',
            sender: 'writer'
        });

        // Nothing a run would show: one provider request and one `run.started` (both the
        // parked run's), status `paused`, transcript unmoved.
        await flush();
        expect(seen).toHaveLength(1);
        expect(runs).toEqual(['first turn']);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' }
        ]);
    });

    // A park taken INSIDE a run is the compaction shape: `turn.before` parks, the holder
    // awaits its own work, then resumes. Here the hook itself holds the gate, so the
    // window under test is exact — status `paused` WITH `state.run` attached, and the
    // run parked inside the hook (harness.ts `emitTurnBefore` runs before the request,
    // so no provider request exists yet).
    //
    // Drain site: the queue is applied at 9440 (`drainThreadQueue` before `requestTurn`)
    // and re-checked at the terminal turn (harness.ts `if (drainThreadQueue(run))
    // continue`, "guidance that arrived while this final turn was in flight buys one
    // more turn"). Both are THIS run's boundaries — no second run is started.
    it('queues into a park held inside a run and gives the text that run own next boundary', async () => {
        const seen: HarnessStreamRequest[] = [];
        const hold = gate();
        const resumed: string[] = [];
        let parkOnce = true;

        const { harness: writer, api } = fixture(
            scripted([answer('first boundary'), answer('after the guidance')], seen),
            (a) => {
                a.on('thread.resumed', (record) => void resumed.push(record.status));
                a.on('turn.before', async (payload) => {
                    if (!parkOnce) return;
                    parkOnce = false;
                    await payload.pause();
                    // The holder's own work: the run waits here, parked.
                    await hold.promise;
                });
            }
        );

        const target = writer.createThread('writer');
        const turn = writer.sendThreadInput(target.id, 'first turn');

        await waitStatus(writer, target.id, 'paused');
        expect(seen).toHaveLength(0);

        // Parked, run attached, and the steer only queues: the receipt is the one a
        // running steer gives, and nothing resumed, so no `thread.resumed`.
        expect(api.threads.steer(target.id, 'steered mid-run')).toEqual({
            threadId: target.id,
            queued: true
        });
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(resumed).toEqual([]);

        hold.open();
        const message = await turn;

        // The guidance bought exactly one more turn of THIS run: the first answer is
        // still committed history, the queued text is the user turn before the second
        // request, and that second turn is the run's answer.
        expect(message.content).toBe('after the guidance');
        expect(seen).toHaveLength(2);
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first boundary' },
            { role: 'user', content: 'steered mid-run' },
            { role: 'assistant', content: 'after the guidance' }
        ]);
        // Nothing resumed the park, so it outlives the run and stays the holder's.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(resumed).toEqual([]);
    });

    // `api.threads.steer` on a DORMANT park: queued, park preserved, and the text still
    // reaches the transcript at the next run's boundary (the same drain as above).
    it('queues api.threads.steer into a dormant park without lifting it', async () => {
        const seen: HarnessStreamRequest[] = [];
        const resumed: string[] = [];
        let parkOnce = true;

        const { harness: writer, api } = fixture(
            scripted([answer('first answer'), answer('second answer')], seen),
            (a) => {
                a.on('thread.resumed', (record) => void resumed.push(record.status));
                a.on('turn.before', async (payload) => {
                    if (!parkOnce) return;
                    parkOnce = false;
                    await payload.pause();
                });
            }
        );

        const target = writer.createThread('writer');
        await writer.sendThreadInput(target.id, 'first turn');

        expect(api.threads.steer(target.id, 'guidance')).toEqual({
            threadId: target.id,
            queued: true
        });
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(resumed).toEqual([]);
        expect(seen).toHaveLength(1);

        const message = await writer.sendThreadInput(target.id, 'host turn');
        expect(message.content).toBe('second answer');
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'host turn' },
            { role: 'user', content: 'guidance' },
            { role: 'assistant', content: 'second answer' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// The plugin contract T9 consumes: api.threads.pause / api.threads.resume
// ---------------------------------------------------------------------------

describe('api.threads.pause / api.threads.resume (the T9 contract)', () => {
    it('parks and un-parks a conversation, idempotently, returning the record', async () => {
        const { harness: writer, api } = fixture(scripted([answer('unused')]), () => undefined);

        const target = writer.createThread('writer', { label: 'Gate' });
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });

        expect(api.threads.pause(target.id)).toEqual({ ...target, status: 'paused' });
        // A second park is a NO-OP: same record, and no duplicate `thread.paused` for a
        // holder that parks defensively.
        expect(api.threads.pause(target.id)).toEqual({ ...target, status: 'paused' });

        expect(api.threads.resume(target.id)).toEqual({ ...target, status: 'idle' });
        // A second resume is a no-op too — only a `paused` record is ever un-parked, so
        // `thread.resumed` cannot fire for a conversation that is not parked.
        expect(api.threads.resume(target.id)).toEqual({ ...target, status: 'idle' });
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });

    // Resume returns whatever status the run loop would give the record. INSIDE a run
    // the run is still attached, so the park lifts back to `running` — the normal case
    // for a compaction holder that parks and resumes within one hook. This also pins
    // that `payload.pause()` and `api.threads.pause` are THE SAME park.
    it('returns a park taken inside a run to running', async () => {
        const observed: string[] = [];
        let parkOnce = true;

        const { harness: writer } = fixture(scripted([answer('the answer')]), (api) => {
            api.on('turn.before', async (payload) => {
                if (!parkOnce) return;
                parkOnce = false;
                await payload.pause();
                observed.push(`parked:${api.threads.pause(payload.threadId ?? '').status}`);
                observed.push(`resumed:${api.threads.resume(payload.threadId ?? '').status}`);
            });
        });

        const target = writer.createThread('writer');
        const message = await writer.sendThreadInput(target.id, 'first turn');

        expect(observed).toEqual(['parked:paused', 'resumed:running']);
        expect(message.content).toBe('the answer');
        // The run completed normally and returned the conversation to `idle`.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });

    it('refuses a stopped thread and an unknown id, and never invents a revival', async () => {
        const { harness: writer, api } = fixture(scripted([answer('unused')]), () => undefined);

        const stopped = writer.createThread('writer', { label: 'Stopped' });
        writer.stopThread(stopped.id, 'operator stop');
        expect(recordOf(writer, stopped.id)).toEqual({ ...stopped, status: 'stopped' });

        // The host owns stopping AND reviving, so a plugin may not park a stopped
        // conversation and bury that stop under a park only a host turn can lift.
        expect(failureOf(() => api.threads.pause(stopped.id))).toBe(
            `Thread "${stopped.id}" is stopped; a plugin cannot park it — only a host turn can revive a stopped conversation.`
        );

        // `resume` keeps its plain no-op for a stopped record: it un-parks, it does not
        // un-stop, so a plugin cannot resurrect what the operator stopped.
        expect(api.threads.resume(stopped.id)).toEqual({ ...stopped, status: 'stopped' });

        const missing = 'thread-never-created';

        expect(failureOf(() => api.threads.pause(missing))).toBe(
            `Thread "${missing}" is not available in this harness; it was never created, or it was deleted.`
        );
        expect(failureOf(() => api.threads.resume(missing))).toBe(
            `Thread "${missing}" is not available in this harness; it was never created, or it was deleted.`
        );
    });
});

// ---------------------------------------------------------------------------
// Park OWNERSHIP (context T11/D1)
// ---------------------------------------------------------------------------

// A tool that answers instantly: one scripted tool call buys a SECOND `turn.before` round
// of the same run, which is the only way a case can watch a park survive one round and be
// lifted by its holder in the next.
const echoTool = (): ReturnType<typeof tool> =>
    tool({ description: 'Echo tool.', tags: ['test'], visibility: 'core', execute: () => 'echo' });

// Prose plus a call — the shape that keeps the run going into another boundary.
const toolRound = (id: string, name: string): HarnessStreamEvent[] => [
    { type: 'text', delta: 'working' },
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: '{}' }] }
];

// The roster exactly as a PLUGIN reads it: the check a `pause()`/`resume()` wrapper can
// perform between its own two calls, so it is what the shipped trimmer's `finally` leaves
// behind when it lifts a park it never took.
const parkStatus = (api: HarnessPluginApi, threadId: string): string =>
    String(api.threads.list().find((entry) => entry.id === threadId)?.status ?? 'missing');

// TWO named plugins, in the order given, and their captured apis. Ownership is a property
// of a SECOND plugin's payload controls acting on a park the FIRST one took, so a
// one-plugin fixture (the `fixture` above) cannot express the claim at all. Plugin order is
// dispatch order: `setup` order becomes registration order, and hook dispatch is sequential
// in registration order at equal priority (./plugin/hooks.ts). That is exactly the shipped
// arrangement the D1 defect lives in — `context-compaction` registers before
// `context-trimmer` (./plugin/manifest.ts:42-58) — with 'holder' standing in for the
// compactor and 'later' for the trimmer's `pause -> write -> resume` wrapper
// (./plugins/context-trimmer.plugin.ts ~421-427).
const pairOf = (
    stream: HarnessStream,
    plugins: Array<{ name: string; setup: (api: HarnessPluginApi) => void }>,
    tools?: Record<string, ReturnType<typeof tool>>
): { harness: Harness; apis: Record<string, HarnessPluginApi> } => {
    const apis: Record<string, HarnessPluginApi> = {};

    const instance = harness({
        agents: { writer: brain(stream) },
        ...(tools === undefined ? {} : { tools }),
        plugins: plugins.map((entry) => ({
            name: entry.name,
            setup: (api: HarnessPluginApi) => {
                apis[entry.name] = api;
                entry.setup(api);
            }
        })),
        presets: false
    });

    return { harness: instance, apis };
};

describe('park ownership (context T11/D1)', () => {
    // THE D1 CASE, end to end. The holder parks on the trigger round; a later plugin runs
    // its own pause/resume wrapper in the SAME round (the trimmer's shape); the park must
    // survive it, and the holder must still own it on the next round.
    it('leaves the holder park intact when a later plugin parks and un-parks in the same round', async () => {
        const seen: HarnessStreamRequest[] = [];
        const observed: string[] = [];
        const lifecycle: string[] = [];
        const rounds = { holder: 0, later: 0 };

        const { harness: writer, apis } = pairOf(
            scripted([toolRound('t1', 'echo'), answer('settled')], seen),
            [
                {
                    // THE HOLDER (the compactor's shape): park on the trigger round, and on
                    // the next boundary lift it — which is only legal if the later pass
                    // never took the park over.
                    name: 'holder',
                    setup: (api) => {
                        api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                        api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                        api.on('turn.before', async (payload) => {
                            rounds.holder += 1;

                            if (rounds.holder === 1) {
                                await payload.pause();
                                observed.push(`holder.pause:${parkStatus(api, payload.threadId)}`);
                                return;
                            }

                            await payload.resume();
                            observed.push(`holder.resume:${parkStatus(api, payload.threadId)}`);
                        });
                    }
                },
                {
                    // THE LATER PASS (the trimmer's shape): park, do the flag write, ALWAYS
                    // un-park in a `finally`.
                    name: 'later',
                    setup: (api) => {
                        api.on('turn.before', async (payload) => {
                            rounds.later += 1;
                            if (rounds.later !== 1) return;

                            await payload.pause();
                            observed.push(`later.pause:${parkStatus(api, payload.threadId)}`);

                            try {
                                // One flag write's worth of awaited work.
                                await Promise.resolve();
                            } finally {
                                await payload.resume();
                                observed.push(`later.resume:${parkStatus(api, payload.threadId)}`);
                            }
                        });
                    }
                }
            ],
            { echo: echoTool() }
        );

        const target = writer.createThread('writer', { label: 'Owned park' });
        const message = await writer.sendThreadInput(target.id, 'first turn');

        expect(message.content).toBe('settled');
        expect(seen).toHaveLength(2);

        expect(observed).toEqual([
            'holder.pause:paused',
            // A second plugin parking on top of a park is a NO-OP — and must not take the
            // park over, or its own `finally` below would free it.
            'later.pause:paused',
            // THE FIX. This line read `later.resume:running` before T11: the later pass
            // lifted a park it had never taken, and the paused-during-compaction window an
            // operator watches was gone on the very turn that opened it.
            'later.resume:paused',
            // Ownership never moved, so the holder's own lift lands on the next boundary.
            'holder.resume:running'
        ]);

        // ONE event pair for the whole exchange: the later pass produced no `thread.resumed`
        // of its own, which is the observable the D1 review called the broken signal.
        expect(lifecycle).toEqual(['paused:paused', 'resumed:running']);

        // The holder's lift is the ordinary one — back to 'running' because the run is still
        // attached — and the run then finished normally.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
        expect(apis.holder).toBeDefined();
    });

    // The other half of the rule: ownership is not a global lock. A plugin that parked by
    // itself still un-parks across rounds, exactly as it did before T11.
    it('lifts a park in a later round when the same plugin took it', async () => {
        const seen: HarnessStreamRequest[] = [];
        const observed: string[] = [];
        const lifecycle: string[] = [];
        const rounds = { later: 0 };

        const { harness: writer } = pairOf(
            scripted([toolRound('t1', 'echo'), answer('settled')], seen),
            [
                {
                    // The observer only: it must never see a lift it did not earn.
                    name: 'holder',
                    setup: (api) => {
                        api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                        api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                    }
                },
                {
                    name: 'later',
                    setup: (api) => {
                        api.on('turn.before', async (payload) => {
                            rounds.later += 1;

                            if (rounds.later === 1) {
                                await payload.pause();
                                observed.push(`later.pause:${parkStatus(api, payload.threadId)}`);
                                return;
                            }

                            await payload.resume();
                            observed.push(`later.resume:${parkStatus(api, payload.threadId)}`);
                        });
                    }
                }
            ],
            { echo: echoTool() }
        );

        const target = writer.createThread('writer', { label: 'Own park' });
        const message = await writer.sendThreadInput(target.id, 'first turn');

        expect(message.content).toBe('settled');
        expect(observed).toEqual(['later.pause:paused', 'later.resume:running']);
        expect(lifecycle).toEqual(['paused:paused', 'resumed:running']);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });

    // THE ESCAPE HATCH, pinned from the OTHER plugin's side: `api.threads.resume` is
    // ownerless, so a conversation a payload `pause()` stranded is still reachable — here by
    // a plugin that never owned the park, and (in the group above and ./harness.thread-
    // runtime.test.ts T3.2) by a host `sendThreadInput`.
    it('lets an ownerless api resume lift a park another plugin took', async () => {
        const seen: HarnessStreamRequest[] = [];
        const lifecycle: string[] = [];
        let parkOnce = true;

        const { harness: writer, apis } = pairOf(scripted([answer('first answer')], seen), [
            {
                name: 'holder',
                setup: (api) => {
                    api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                    api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                    api.on('turn.before', async (payload) => {
                        if (!parkOnce) return;
                        parkOnce = false;
                        // Parked, and deliberately never resumed: the stranded-park shape.
                        await payload.pause();
                    });
                }
            },
            { name: 'later', setup: () => undefined }
        ]);

        const target = writer.createThread('writer', { label: 'Stranded' });
        await writer.sendThreadInput(target.id, 'first turn');

        // The owned park outlived its run and nothing lifted it.
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });
        expect(lifecycle).toEqual(['paused:paused']);

        // THE LIFT. A different plugin's OWNERLESS api call reaches an owned park, and the
        // record returns to 'idle' (no run attached).
        expect(stableRecord(apis.later.threads.resume(target.id))).toEqual({
            ...target,
            status: 'idle'
        });
        expect(lifecycle).toEqual(['paused:paused', 'resumed:idle']);
    });

    // A second pause on top of an owned park NEVER re-keys it — including the OWNERLESS
    // api-level form, which is what a plugin that only knows thread ids would reach for.
    // If that pause had cleared the holder, the later pass's `resume()` below would have
    // freed the park.
    it('keeps the owner when a second, ownerless pause lands on an owned park', async () => {
        const seen: HarnessStreamRequest[] = [];
        const observed: string[] = [];
        const lifecycle: string[] = [];

        const { harness: writer, apis } = pairOf(scripted([answer('first answer')], seen), [
            {
                name: 'holder',
                setup: (api) => {
                    api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                    api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                    api.on('turn.before', async (payload) => {
                        await payload.pause();
                        observed.push(`holder.pause:${parkStatus(api, payload.threadId)}`);

                        // The defensive re-park, taken through the ID-level api (ownerless).
                        api.threads.pause(payload.threadId);
                        observed.push(`holder.apiPause:${parkStatus(api, payload.threadId)}`);
                    });
                }
            },
            {
                name: 'later',
                setup: (api) => {
                    api.on('turn.before', async (payload) => {
                        await payload.pause();
                        observed.push(`later.pause:${parkStatus(api, payload.threadId)}`);
                        await payload.resume();
                        observed.push(`later.resume:${parkStatus(api, payload.threadId)}`);
                    });
                }
            }
        ]);

        const target = writer.createThread('writer', { label: 'Double park' });
        const message = await writer.sendThreadInput(target.id, 'first turn');

        expect(message.content).toBe('first answer');
        expect(observed).toEqual([
            'holder.pause:paused',
            'holder.apiPause:paused',
            'later.pause:paused',
            'later.resume:paused'
        ]);
        // Nothing lifted it, so the run ended parked — and only an ownerless lift gets out.
        expect(lifecycle).toEqual(['paused:paused']);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });

        expect(stableRecord(apis.holder.threads.resume(target.id))).toEqual({
            ...target,
            status: 'idle'
        });
        expect(lifecycle).toEqual(['paused:paused', 'resumed:idle']);
    });

    // The last row of the ownership table: an OWNERLESS park (the api form) is liftable by
    // anyone, including a payload `resume()` that names an owner. Ownership restricts LIFTS
    // of owned parks; it never walls a park off.
    it('lifts an ownerless api park through a payload resume', async () => {
        const seen: HarnessStreamRequest[] = [];
        const observed: string[] = [];
        const lifecycle: string[] = [];

        const { harness: writer } = pairOf(scripted([answer('first answer')], seen), [
            {
                name: 'holder',
                setup: (api) => {
                    api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                    api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                }
            },
            {
                name: 'later',
                setup: (api) => {
                    api.on('turn.before', async (payload) => {
                        // The park is taken through the ID-level api: NO owner is recorded.
                        api.threads.pause(payload.threadId);
                        observed.push(`later.apiPause:${parkStatus(api, payload.threadId)}`);

                        // And the payload pair, which names 'later', lifts it anyway.
                        await payload.resume();
                        observed.push(`later.resume:${parkStatus(api, payload.threadId)}`);
                    });
                }
            }
        ]);

        const target = writer.createThread('writer', { label: 'Ownerless' });
        const message = await writer.sendThreadInput(target.id, 'first turn');

        expect(message.content).toBe('first answer');
        expect(observed).toEqual(['later.apiPause:paused', 'later.resume:running']);
        expect(lifecycle).toEqual(['paused:paused', 'resumed:running']);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });
});

// ---------------------------------------------------------------------------
// Regressions: the paths this change must NOT touch
// ---------------------------------------------------------------------------

describe('the unchanged paths around a park (regressions)', () => {
    // The host escape hatch, verbatim: a plugin that parked and never resumed leaves a
    // REACHABLE conversation, and it sees its own park lifted (`thread.resumed`).
    it('still revives a parked conversation for an explicit host turn', async () => {
        const resumed: string[] = [];
        let parkOnce = true;

        const { harness: writer } = fixture(
            scripted([answer('first answer'), answer('carried on')]),
            (api) => {
                api.on('thread.resumed', (record) => void resumed.push(record.status));
                api.on('turn.before', async (payload) => {
                    if (!parkOnce) return;
                    parkOnce = false;
                    await payload.pause();
                });
            }
        );

        const target = writer.createThread('writer');
        await writer.sendThreadInput(target.id, 'first turn');
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'paused' });

        const message = await writer.sendThreadInput(target.id, 'carry on');

        // `idle` in the payload, not `running`: the parked run had already ended, so the
        // resume returns the status the run loop would have given it.
        expect(resumed).toEqual(['idle']);
        expect(message.content).toBe('carried on');
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'carry on' },
            { role: 'assistant', content: 'carried on' }
        ]);
        expect(recordOf(writer, target.id)).toEqual({ ...target, status: 'idle' });
    });

    // `idle` still STARTS a turn (`delivered: 'started'`) and `stopped` still throws —
    // the two neighbours of the branch that changed. The RUNNING branch (steer into a
    // live request, drained at the next boundary) stays pinned in
    // ./harness.thread-runtime.test.ts: `steers a genuinely running conversation and its
    // next turn reflects the message (T3.1)`, and the in-model stopped refusal by
    // `leaves a stopped conversation untouched when a model sends into it (T3.3)`.
    it('still starts a turn for an idle target and refuses a stopped one', async () => {
        const seen: HarnessStreamRequest[] = [];
        const { harness: writer } = fixture(scripted([answer('beta answers')], seen), () => undefined);

        const idle = writer.createThread('writer', { label: 'Idle' });

        await expect(
            writer.executeTool('threadSend', { thread: idle.id, message: 'ping' })
        ).resolves.toEqual({ threadId: idle.id, delivered: 'started', sender: 'writer' });

        await settleThread(writer, idle.id);
        expect(seen).toHaveLength(1);
        expect(withoutIds(writer.threadMessages(idle.id))).toEqual([
            { role: 'user', content: attributed('ping') },
            { role: 'assistant', content: 'beta answers' }
        ]);

        const stopped = writer.createThread('writer', { label: 'Stopped' });
        writer.stopThread(stopped.id, 'operator stop');

        await expect(
            writer.executeTool('threadSend', { thread: stopped.id, message: 'ping' })
        ).rejects.toThrow(
            `Thread "${stopped.id}" is stopped; it cannot receive messages until a host resumes or deletes it.`
        );
        expect(recordOf(writer, stopped.id)).toEqual({ ...stopped, status: 'stopped' });
        // The refusal mutates nothing: still no provider request in this harness.
        expect(seen).toHaveLength(1);
    });
});
