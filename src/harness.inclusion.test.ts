// Stages 1a + 1b — the persisted context-inclusion flag on `HarnessMessage.included`.
//
// What this file pins (and ONLY this): a canonical transcript entry carrying
// `included: false` is witheld from the MODEL REQUEST, while canonical history
// stays untouched. Stage 1a sets the flag by mutating `agent.messages` directly;
// section 5 adds the plugin-facing surface, where the flag is written through
// `turn.before`'s `context.setIncluded()` and read through `context.entries`.
//
// Contract:
//   1. DEFAULT IS BYTE-IDENTICAL. Absent means included, and re-enabling DELETES
//      the key, so `included` never appears in a projection, a snapshot or a
//      provider payload unless somebody turned a turn off.
//   2. The unit of exclusion is a whole tool-call block: an assistant message
//      with non-empty `toolCalls` plus every `tool` message matching one of its
//      call ids. `false` on ANY member withholds the entire block — its results
//      and its request-only pending placeholders — because a partial block is
//      not a valid OpenAI-compatible request (src/transport/openai.ts pairing).
//   3. Filtering is request-only: `agent.messages` keeps every entry, in place,
//      with its flag, so the change is reversible.
//   4. The projection stays pair-clean: no orphan result, no missing result, and
//      the surviving blocks keep CALL ORDER.
//   5. (Stage 1b) `entries` is the CANONICAL list with LIVE, per-unit `included`;
//      `setIncluded()` is a canonical write that cascades to the whole unit, takes
//      effect in the SAME model request, survives into later turns, persists
//      through snapshot/restore, and never stores `true`.
//   6. (Stage 1b) An explicit transcript (setTranscript / a returned `transcript`)
//      outranks that re-projection and is sanitized; a bad index, a foreign entry
//      and an entry made stale by `replaceHistory()` all throw without writing.
//   7. (Stage 1b) A branch run gets the same control surface on its EPHEMERAL
//      copy: its own request is filtered, the source transcript and any snapshot
//      stay flag-free, and no persistence notification is reported.
//
// Deterministic values below come from the scripted turns and the committed
// transcript (the same exactness src/harness.background.test.ts uses), never
// from reading implementation output after the fact. The pairing oracle is the
// `wireIssues` check of that file, re-expressed for one projected list. Where a
// number is not derivable from the contract alone — how many `agent_message`
// notifications a run emits, the exact refusal wording, which content identifies
// a branch round — it was captured from a scratch probe under
// Temp/coding/stage1b-*.probe.ts and then hardcoded, so a future change to any of
// them fails loudly instead of silently widening the assertion.
//
// Clock policy: real timers everywhere except the pending-placeholder test and
// the branch test, each of which owns a local fake clock so the gate and the fork
// scheduler settle at an exact point.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, openAICompatible, tool } from '@underload/harness';
import type {
    HarnessContextEntry,
    HarnessEvent,
    HarnessMessage,
    HarnessPluginApi,
    HarnessStateChangeEvent,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent,
    HarnessToolCall,
    HarnessTurnBeforeContext
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deep copy at capture time: the harness keeps appending to its live transcript
// after a request, so a recorded projection must not alias the running one.
const copyMessages = (messages: HarnessMessage[]): HarnessMessage[] =>
    JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

// A compact, exact view of a transcript (role + content + call ids), so a
// placement bug is readable in the failure message instead of buried in a diff.
const shape = (messages: readonly HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;
        if (message.role === 'assistant') {
            const ids = (message.toolCalls ?? []).map((entry) => entry.id).join('|');
            return `assistant:${message.content}:${ids}`;
        }
        return `${message.role}:${message.content}`;
    });

// The strict pairing oracle (R3 of src/harness.background.test.ts, applied to a
// single projected list): after every assistant message that requests tools, the
// next messages must be exactly one tool message per call, in call order, with
// no other role in between; every tool message must belong to such a run. An
// excluded unit that leaked one result would show up here as an orphan.
const pairIssues = (messages: readonly HarnessMessage[]): string[] => {
    const issues: string[] = [];
    const claimed = new Set<number>();

    messages.forEach((message, index) => {
        if (message.role !== 'assistant') return;
        const requested = message.toolCalls ?? [];
        if (requested.length === 0) return;

        const expected = requested.map((entry) => entry.id);
        const actual: string[] = [];
        let cursor = index + 1;

        while (cursor < messages.length && messages[cursor].role === 'tool') {
            const toolMessage = messages[cursor] as Extract<HarnessMessage, { role: 'tool' }>;
            actual.push(toolMessage.toolCallId);
            claimed.add(cursor);
            cursor += 1;
        }

        if (actual.join(',') !== expected.join(',')) {
            issues.push(
                `assistant#${index}: expected [${expected.join(',')}] but paired [${actual.join(',')}]`
            );
        }
    });

    messages.forEach((message, index) => {
        if (message.role !== 'tool' || claimed.has(index)) return;
        const toolMessage = message as Extract<HarnessMessage, { role: 'tool' }>;
        issues.push(`orphan tool#${index}: ${toolMessage.toolCallId}`);
    });

    return issues;
};

// The flag is invisible unless somebody sets it: a serialized projection that
// contains the word at all means a `true` leaked into a request.
const carriesFlag = (messages: readonly HarnessMessage[]): boolean =>
    JSON.stringify(messages).includes('included');

// Branch ids come from a sequence shared by every harness in the process, so the
// same scenario run twice differs ONLY by that number. Normalizing it turns a
// branch-vs-branch comparison into evidence instead of luck.
const withoutBranchIds = (value: unknown): string =>
    JSON.stringify(value).replace(/branch-\d+/g, 'branch-n');

// A state-change stream as compact, order-significant keys. A shared store turns
// each of these into a durable save, so "which writes notify" is exactly the
// persistence contract — and `branchId` distinguishes a branch write from a root one.
const changesOf = (events: readonly HarnessStateChangeEvent[]): string[] =>
    events.map((event) => `${event.reason}:${event.agent ?? '-'}:${event.branchId ?? '-'}`);

// One scripted turn list replayed request-by-request, recording the exact
// projection each request received. The last turn repeats once the list is
// exhausted, which is what lets a test start a second run without re-scripting.
const scripted = (turns: HarnessStreamEvent[][], seen: HarnessMessage[][]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen.push(copyMessages(request.messages));
        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const call = (id: string, name: string, args = '{}'): HarnessToolCall => ({ id, name, arguments: args });

const calls = (...requested: HarnessToolCall[]): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: requested }
];

// A core, SYNC tool: its result is committed inside the same run, so the tests
// below mutate a transcript that is already fully settled.
const echoTool = (name: string, output: string) =>
    tool({
        description: `Echo tool ${name}.`,
        tags: ['test'],
        visibility: 'core',
        execute: () => output
    });

// An ASYNC tool that stays pending until the test settles it — the only way to
// observe a request-time placeholder and prove an excluded unit emits none.
const gatedTool = (name: string, gate: Promise<string>) =>
    tool({
        description: `Gated test tool ${name}.`,
        tags: ['test'],
        visibility: 'core',
        mode: 'async',
        execute: () => gate
    });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const deferred = <T,>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((inner) => {
        resolve = inner;
    });
    return { promise, resolve };
};

type RunState<T> = { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown };

// Handlers attached immediately, so a rejection is never unhandled and a paused
// run can be observed as still open.
const probe = <T,>(promise: Promise<T>): RunState<T> => {
    const state: RunState<T> = { status: 'pending' };
    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error: unknown) => {
            state.status = 'rejected';
            state.error = error;
        }
    );
    return state;
};

// Drain the harness's promise chain without moving the clock (the fake-timer
// policy src/harness.background.test.ts established).
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 8; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// One settled conversation to mutate: user prompt, one answered tool block, one
// final answer. Every exclusion test below starts from exactly this transcript.
// Inference is left to the call site on purpose: `harness()` is generic, and an
// explicit return annotation here would erase the callable+`.agent` shape.
const settledRun = async (
    prompt = 'go',
    turns: HarnessStreamEvent[][] = [calls(call('a1', 'alpha')), answer('after alpha')],
    tools: Record<string, ReturnType<typeof tool>> = { alpha: echoTool('alpha', 'A') }
) => {
    const seen: HarnessMessage[][] = [];
    const writer = harness({
        agents: { writer: agent({ model: 'test/model', stream: scripted(turns, seen) }) },
        tools,
        presets: false
    });

    await writer(prompt);

    return { writer, seen };
};

// The same settled conversation, but with a HOST-SEEDED transcript — the path a
// host takes with `agent({ messages })`, and the one where `included: true` used to
// survive into canonical state and into every request object.
const seededRun = async (
    seed: HarnessMessage[],
    turns: HarnessStreamEvent[][] = [answer('seeded answer')]
) => {
    const seen: HarnessMessage[][] = [];
    const writer = harness({
        agents: {
            writer: agent({ model: 'test/model', messages: seed, stream: scripted(turns, seen) })
        },
        presets: false
    });

    await writer('go');

    return { writer, seen };
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1 — the default path is untouched
// ---------------------------------------------------------------------------

describe('context inclusion — default behaviour', () => {
    it('projects the same transcript as before the flag existed and never writes the key', async () => {
        const { writer, seen } = await settledRun();

        // Two requests: the prompt, then the answered tool block. Exact content,
        // not a smoke check.
        expect(seen.map(shape)).toEqual([
            ['user:go'],
            ['user:go', 'assistant::a1', 'tool:a1:A']
        ]);
        expect(seen.map(pairIssues)).toEqual([[], []]);
        expect(seen.some(carriesFlag)).toBe(false);

        // Canonical history is the same list the projection quoted.
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:'
        ]);
        expect(carriesFlag(writer.agent.messages)).toBe(false);
    });

    it('treats an explicit `included: true` exactly like an absent flag, and strips it from the request', async () => {
        const { writer, seen } = await settledRun();

        (writer.agent.messages[0] as HarnessMessage).included = true;
        await writer('again');

        // Included, in place, in the original order — the flag only ever excludes.
        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
        // The invariant, strictly: a request object carries NO `included` key at all.
        // (A `true` set directly on live canonical state by a host is still readable
        // there — see the seed-normalization test for the path that is normalized —
        // but the projection never forwards it.)
        expect(carriesFlag(seen[seen.length - 1])).toBe(false);
        expect(JSON.stringify(seen[seen.length - 1])).not.toContain('"included":false');
        expect(writer.agent.messages[0]).toStrictEqual({
            role: 'user',
            content: 'go',
            included: true
        });
        // And it is normalized again on the way OUT: a snapshot never persists a
        // `true` either, so the value cannot survive a restart (core/snapshot.ts
        // `applyIncluded`), which is why no consumer has to reason about it.
        expect(writer.snapshot().agents.writer.messages[0]).toStrictEqual({
            role: 'user',
            content: 'go'
        });
    });
});

// ---------------------------------------------------------------------------
// 1b — the invariant: `included` exists only as `false`
// ---------------------------------------------------------------------------

describe('context inclusion — `included: true` never persists or travels', () => {
    it('normalizes a host-seeded `included: true` out of canonical state, the projection and the request', async () => {
        const seed: HarnessMessage[] = [
            { role: 'user', content: 'seed on', included: true },
            { role: 'user', content: 'seed off', included: false }
        ];
        const { writer, seen } = await seededRun(seed);

        // Canonical state: `true` is dropped at the seed boundary (absent is the
        // only spelling of "included"), `false` is kept verbatim, and the CALLER's
        // objects were not mutated by the copy.
        expect(writer.agent.messages).toStrictEqual([
            { role: 'user', content: 'seed on' },
            { role: 'user', content: 'seed off', included: false },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'seeded answer' }
        ]);
        expect(seed[0]).toStrictEqual({ role: 'user', content: 'seed on', included: true });
        expect(seed[1]).toStrictEqual({ role: 'user', content: 'seed off', included: false });

        // The first request is the projection: the disabled seed turn is withheld,
        // and no entry carries the key — `toStrictEqual` would fail on an
        // `included: undefined` leftover, and the string check catches any spelling.
        expect(seen).toHaveLength(1);
        expect(seen[0]).toStrictEqual([
            { role: 'user', content: 'seed on' },
            { role: 'user', content: 'go' }
        ]);
        expect(JSON.stringify(seen)).not.toContain('included');

        // A LATER request stays flag-free too, with the disabled turn still gone:
        // the normalization is not a one-shot at construction.
        await writer('again');

        expect(shape(seen[1])).toEqual([
            'user:seed on',
            'user:go',
            'assistant:seeded answer:',
            'user:again'
        ]);
        expect(carriesFlag(seen[1])).toBe(false);
        expect(pairIssues(seen[1])).toEqual([]);
    });

    it('withholds a disabled system instruction from the projection', async () => {
        const { writer, seen } = await seededRun([
            { role: 'system', content: 'CTX off', included: false },
            { role: 'user', content: 'CTX on' }
        ]);

        // A disabled system entry behaves like any other standalone message: it is
        // the only one missing, and the user turn and the prompt both survive.
        expect(seen[0]).toStrictEqual([
            { role: 'user', content: 'CTX on' },
            { role: 'user', content: 'go' }
        ]);
        expect(JSON.stringify(seen[0])).not.toContain('included');
        expect(writer.agent.messages[0]).toStrictEqual({
            role: 'system',
            content: 'CTX off',
            included: false
        });
    });

    it('hands a `turn.before` hook the already-filtered, flag-free projection', async () => {
        const hooks: HarnessTurnBeforeContext[] = [];
        const seen: HarnessMessage[][] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: [
                        { role: 'system', content: 'CTX' },
                        { role: 'user', content: 'off', included: false },
                        { role: 'user', content: 'on', included: true }
                    ],
                    stream: scripted([answer('hooked')], seen)
                })
            },
            plugins: [
                {
                    name: 'inclusion-observer',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            hooks.push(payload);
                        });
                    }
                }
            ],
            presets: false
        });

        await writer('go');

        expect(hooks).toHaveLength(1);
        // The hook receives EXACTLY the projection: the disabled turn is already
        // filtered out, and the seeded `included: true` entry is already stripped —
        // a plugin never has to re-implement the inclusion rules or defend against
        // a `true` it has to normalize itself.
        expect(hooks[0].messages).toStrictEqual([
            { role: 'system', content: 'CTX' },
            { role: 'user', content: 'on' },
            { role: 'user', content: 'go' }
        ]);
        expect(JSON.stringify(hooks[0].messages)).not.toContain('included');
        expect(pairIssues(hooks[0].messages)).toEqual([]);

        // And the provider request is the same list the hook saw (no override was
        // returned), which is what makes the hook a faithful mirror of the request.
        expect(seen[0]).toEqual(hooks[0].messages);
    });
});

// ---------------------------------------------------------------------------
// 2 — standalone messages
// ---------------------------------------------------------------------------

describe('context inclusion — standalone messages', () => {
    it('withholds a disabled user message from the next request and leaves canonical history intact', async () => {
        const { writer, seen } = await settledRun();

        (writer.agent.messages[0] as HarnessMessage).included = false;
        await writer('again');

        expect(shape(seen[seen.length - 1])).toEqual([
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);

        // The turn is disabled, not deleted: canonical history still carries it,
        // flagged, at its original index.
        expect(writer.agent.messages[0]).toEqual({
            role: 'user',
            content: 'go',
            included: false
        });
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again',
            // The second run committed its own answer; the disabled turn is still
            // at index 0 with its flag.
            'assistant:after alpha:'
        ]);
    });

    it('withholds a disabled assistant answer while the rest of the transcript keeps its order', async () => {
        const { writer, seen } = await settledRun();

        (writer.agent.messages[3] as HarnessMessage).included = false;
        await writer('again');

        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again',
            // The second run committed its own answer, and the disabled entry is
            // still in the transcript at index 3.
            'assistant:after alpha:'
        ]);
    });

    it('is reversible: re-enabling deletes the key and restores the unflagged projection', async () => {
        const { writer, seen } = await settledRun();

        const baseline = seen[seen.length - 1];

        (writer.agent.messages[0] as HarnessMessage).included = false;
        await writer('again');
        expect(shape(seen[seen.length - 1])).not.toContain('user:go');

        delete (writer.agent.messages[0] as HarnessMessage).included;
        await writer('again');

        const restored = seen[seen.length - 1];
        expect(carriesFlag(restored)).toBe(false);
        // The entry is back, byte-for-byte as it was before the flag existed.
        expect(restored.slice(0, baseline.length)).toEqual(baseline);
        expect(writer.agent.messages[0]).toEqual({ role: 'user', content: 'go' });
    });
});

// ---------------------------------------------------------------------------
// 3 — tool-call units
// ---------------------------------------------------------------------------

describe('context inclusion — tool-call units', () => {
    it('withholds the assistant message AND its result when the block is disabled', async () => {
        const { writer, seen } = await settledRun();

        (writer.agent.messages[1] as HarnessMessage).included = false;
        await writer('again');

        // No assistant `toolCalls` entry and no orphan `tool` message.
        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant:after alpha:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again',
            // The second run committed its own answer, and the whole disabled
            // block is still in canonical history at its original position.
            'assistant:after alpha:'
        ]);
    });

    it('withholds the whole unit when only ONE result of a parallel block is disabled', async () => {
        const { writer, seen } = await settledRun('go', [
            calls(call('a1', 'alpha'), call('b1', 'beta')),
            answer('both done')
        ], { alpha: echoTool('alpha', 'A'), beta: echoTool('beta', 'B') });

        const before = shape(seen[seen.length - 1]);
        expect(before).toEqual(['user:go', 'assistant::a1|b1', 'tool:a1:A', 'tool:b1:B']);

        // Disabling one RESULT is a statement about its unit, not about one row:
        // keeping the assistant with a half-answered `tool_calls[]` is what every
        // strict provider rejects.
        (writer.agent.messages[3] as HarnessMessage).included = false;
        await writer('again');

        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant:both done:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
    });

    it('leaves the other units intact and in call order when one of several blocks is disabled', async () => {
        const { writer, seen } = await settledRun('go', [
            calls(call('a1', 'alpha'), call('a2', 'alpha2')),
            calls(call('b1', 'beta'), call('b2', 'beta2')),
            answer('all done')
        ], {
            alpha: echoTool('alpha', 'A'),
            alpha2: echoTool('alpha2', 'A2'),
            beta: echoTool('beta', 'B'),
            beta2: echoTool('beta2', 'B2')
        });

        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1|a2',
            'tool:a1:A',
            'tool:a2:A2',
            'assistant::b1|b2',
            'tool:b1:B',
            'tool:b2:B2',
            'assistant:all done:'
        ]);

        (writer.agent.messages[1] as HarnessMessage).included = false;
        await writer('again');

        // The surviving block keeps BOTH results in CALL order; the disabled one
        // takes its two results with it.
        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant::b1|b2',
            'tool:b1:B',
            'tool:b2:B2',
            'assistant:all done:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
        expect(carriesFlag(seen[seen.length - 1])).toBe(false);
    });

    it('withholds a result that sits outside its assistant block (restored or hand-edited history)', async () => {
        // A canonical transcript may hold a result NON-contiguously: restore, a
        // host edit, or a delivery that landed after another turn committed the
        // interlude. The unit rule must still take that result with its block,
        // otherwise it would ride into every later request as an orphan.
        const seededHistory = (): HarnessMessage[] => [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')] },
            { role: 'assistant', content: 'interlude' },
            { role: 'tool', content: 'R', toolCallId: 'c1', name: 'alpha' }
        ];

        const unflagged: HarnessMessage[][] = [];
        const plain = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: seededHistory(),
                    stream: scripted([answer('ok')], unflagged)
                })
            },
            presets: false
        });
        await plain('again');

        // Baseline WITHOUT the flag: the block gets a request-only placeholder and
        // the out-of-place result is still projected — the oracle names it as the
        // orphan it is. This is pre-existing behaviour, pinned so the disabled
        // case below is provably a difference the flag makes.
        expect(unflagged[0].map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
            'tool',
            'user'
        ]);
        expect(pairIssues(unflagged[0])).toEqual(['orphan tool#4: c1']);

        const flagged: HarnessMessage[][] = [];
        const disabled = seededHistory();
        disabled[1].included = false;
        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: disabled,
                    stream: scripted([answer('ok')], flagged)
                })
            },
            presets: false
        });
        await writer('again');

        // No assistant block, no placeholder for it, and the detached result is
        // gone with its unit instead of becoming an orphan.
        expect(shape(flagged[0])).toEqual(['user:go', 'assistant:interlude:', 'user:again']);
        expect(pairIssues(flagged[0])).toEqual([]);
        expect(carriesFlag(flagged[0])).toBe(false);
    });

    it('emits no pending placeholder for a disabled unit whose call is still running', async () => {
        vi.useFakeTimers();

        const gate = deferred<string>();
        const seen: HarnessMessage[][] = [];
        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: scripted([calls(call('a1', 'alpha')), answer('waiting'), answer('settled')], seen)
                })
            },
            tools: { alpha: gatedTool('alpha', gate.promise) },
            presets: false
        });

        const state = probe(writer('go'));
        await flush();

        // R1/R3 baseline: the model was re-requested while the call was running,
        // and that request carries exactly one projection-only placeholder. Its
        // wording is not part of the published contract (see the alignment note in
        // src/harness.background.test.ts), so every CONTRACT field is asserted and
        // only the free-text `note` is set aside.
        expect(state.status).toBe('pending');
        expect(seen[1].map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(pairIssues(seen[1])).toEqual([]);

        const placeholder = seen[1][2] as Extract<HarnessMessage, { role: 'tool' }>;
        expect({ role: placeholder.role, toolCallId: placeholder.toolCallId, name: placeholder.name }).toEqual({
            role: 'tool',
            toolCallId: 'a1',
            name: 'alpha'
        });
        const { note: _note, ...placeholderPayload } = JSON.parse(placeholder.content) as {
            status: string;
            callId: string;
            name: string;
            elapsedMs: number;
            note: string;
        };
        expect(placeholderPayload).toEqual({ status: 'pending', callId: 'a1', name: 'alpha', elapsedMs: 0 });

        (writer.agent.messages[1] as HarnessMessage).included = false;
        gate.resolve('A-done');
        await flush();

        // With the unit disabled there is no assistant block left to answer, so
        // neither the placeholder NOR the real result may be emitted — and no
        // orphan may take their place.
        expect(shape(seen[2])).toEqual(['user:go', 'assistant:waiting:']);
        expect(seen[2].some((message) => message.role === 'tool')).toBe(false);
        expect(pairIssues(seen[2])).toEqual([]);

        await flush();
        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('settled');
    });
});

// ---------------------------------------------------------------------------
// 4 — the provider payload itself
// ---------------------------------------------------------------------------

describe('context inclusion — provider wire mapping', () => {
    const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
        const encoder = new TextEncoder();
        return new ReadableStream({
            start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
            }
        });
    };

    const collect = async (events: AsyncIterable<HarnessStreamEvent>): Promise<void> => {
        for await (const event of events) {
            // The frames are not the subject here; the REQUEST body this transport
            // built is. The loop only drives it to completion.
            void event;
        }
    };

    const sendToProvider = async (messages: HarnessMessage[]): Promise<Record<string, unknown>> => {
        const fetchMock = vi.fn(
            async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
        );
        vi.stubGlobal('fetch', fetchMock);

        await collect(openAICompatible({ baseURL: 'http://x/v1' })({ model: 'm', messages }));

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        return JSON.parse(String(init.body)) as Record<string, unknown>;
    };

    it('maps a filtered transcript onto a pair-complete provider payload with no flag field', async () => {
        const { writer, seen } = await settledRun('go', [
            calls(call('a1', 'alpha'), call('a2', 'alpha2')),
            calls(call('b1', 'beta'), call('b2', 'beta2')),
            answer('all done')
        ], {
            alpha: echoTool('alpha', 'A'),
            alpha2: echoTool('alpha2', 'A2'),
            beta: echoTool('beta', 'B'),
            beta2: echoTool('beta2', 'B2')
        });

        (writer.agent.messages[1] as HarnessMessage).included = false;
        await writer('again');

        const body = await sendToProvider(seen[seen.length - 1]);

        // The exact provider payload: the surviving block keeps both answers in
        // call order, and the withheld block left no `tool_call_id` behind.
        expect(body.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'b1', type: 'function', function: { name: 'beta', arguments: '{}' } },
                    { id: 'b2', type: 'function', function: { name: 'beta2', arguments: '{}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'b1', content: 'B' },
            { role: 'tool', tool_call_id: 'b2', content: 'B2' },
            { role: 'assistant', content: 'all done' },
            { role: 'user', content: 'again' }
        ]);
        expect(JSON.stringify(body)).not.toContain('included');
    });
});

// ---------------------------------------------------------------------------
// 5 — Stage 1b: the `turn.before` control surface (`entries` / `setIncluded`)
// ---------------------------------------------------------------------------

// One inline HOST plugin driving `turn.before` with the LIVE context. Nothing about
// the API is mocked: a real harness, the real hook bus with its built-ins, the real
// projection, and the real persistence observer. A hook may also return a
// `{ transcript }` override, exactly as a shipped plugin does.
const turnBeforePlugin = (
    name: string,
    hook: (context: HarnessTurnBeforeContext) => { transcript?: readonly HarnessMessage[] } | void
) => ({
    name,
    setup: (api: HarnessPluginApi) => {
        api.on('turn.before', (context) => hook(context));
    }
});

// The canonical transcript every control test starts from: a seeded system
// instruction, a standalone user turn, ONE complete tool unit, and a final answer.
// All enabled, so each test flips exactly one member and asserts the unit consequence.
const seededTranscript = (): HarnessMessage[] => [
    { role: 'system', content: 'Write.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')] },
    { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
    { role: 'assistant', content: 'answered' }
];

// That transcript fully enabled, as the model receives it for one prompt (the
// projection copies, so these are equal by value and independent by identity).
const seededRequest = (prompt: string): HarnessMessage[] => [
    { role: 'system', content: 'Write.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
    { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
    { role: 'assistant', content: 'answered' },
    { role: 'user', content: prompt }
];

// A control run: a seeded conversation driven by host plugins, recording every
// request the transport received and (optionally) every state-change notification —
// the persistence signal a shared store writes `state.json` from.
const controlRun = async (options: {
    prompt?: string;
    seed?: HarnessMessage[];
    turns?: HarnessStreamEvent[][];
    plugins?: ReturnType<typeof turnBeforePlugin>[];
    stateChanges?: HarnessStateChangeEvent[];
    events?: HarnessEvent[];
}) => {
    const seen: HarnessMessage[][] = [];
    const stateChange = options.stateChanges;
    const progress = options.events;

    const writer = harness({
        agents: {
            writer: agent({
                model: 'test/model',
                ...(options.seed === undefined ? {} : { messages: options.seed }),
                stream: scripted(options.turns ?? [answer('settled')], seen)
            })
        },
        tools: { alpha: echoTool('alpha', 'A') },
        presets: false,
        ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        ...(stateChange === undefined && progress === undefined
            ? {}
            : {
                  report: {
                      ...(progress === undefined
                          ? {}
                          : {
                                progress: (event: HarnessEvent) => void progress.push(event)
                            }),
                      ...(stateChange === undefined
                          ? {}
                          : {
                                stateChange: (event: HarnessStateChangeEvent) =>
                                    void stateChange.push(event)
                            })
                  }
              })
    });

    await writer(options.prompt ?? 'go');

    return { writer, seen };
};

// The entry carrying one content string. Throwing on a miss is deliberate: a missing
// entry means the fixture broke, and a skipped assertion would hide that.
const entryWith = (
    context: HarnessTurnBeforeContext,
    content: string
): HarnessContextEntry => {
    const entry = context.entries.find((candidate) => candidate.message.content === content);

    if (entry === undefined) throw new Error(`no context entry for "${content}".`);

    return entry;
};

describe('context inclusion — the turn.before control surface (Stage 1b)', () => {
    it('lists every canonical entry with EFFECTIVE unit inclusion while messages stays the filtered projection', async () => {
        const seed = seededTranscript();
        // A standalone disabled turn AND one disabled RESULT: the assistant that
        // asked for it is off too, although its own flag was never written.
        seed[1].included = false;
        seed[3].included = false;

        // Snapshot taken INSIDE the handler: `entries` and `messages` are lazy views of
        // the round, so a control test has to read them while the round is running.
        // Reading `entries` here is also what builds it — nothing pays for that list
        // until a handler actually asks for it.
        const entrySnapshots: { entries: readonly HarnessContextEntry[]; messages: readonly HarnessMessage[] }[] = [];
        const contexts: HarnessTurnBeforeContext[] = [];
        const { writer, seen } = await controlRun({
            seed,
            plugins: [
                turnBeforePlugin('observer', (context) => {
                    contexts.push(context);
                    // Read twice: the second read must return THE SAME array, which is
                    // what the per-handler cache promises.
                    const entries = context.entries;

                    if (context.entries !== entries) throw new Error('entries is not cached per handler.');

                    entrySnapshots.push({ entries, messages: context.messages });
                })
            ]
        });

        expect(contexts).toHaveLength(1);
        const context = contexts[0];
        const entries = entrySnapshots[0].entries;

        // Lazy, and cached PER HANDLER: the late reads below return the very same array
        // object the handler saw, so an entry a plugin kept holding stays usable.
        expect(context.entries).toBe(entries);

        // `entries` is the CANONICAL list — the two turns a projection cannot show are
        // still here — in canonical order, with the system instruction as an entry like
        // any other. `included` answers for the UNIT, not for the member.
        expect(
            entries.map((entry) => ({
                index: entry.index,
                included: entry.included,
                role: entry.message.role,
                content: entry.message.content
            }))
        ).toEqual([
            { index: 0, included: true, role: 'system', content: 'Write.' },
            { index: 1, included: false, role: 'user', content: 'question' },
            { index: 2, included: false, role: 'assistant', content: '' },
            { index: 3, included: false, role: 'tool', content: 'A' },
            { index: 4, included: true, role: 'assistant', content: 'answered' },
            { index: 5, included: true, role: 'user', content: 'go' }
        ]);

        // `index` is the canonical index and `message` is the canonical OBJECT, not a
        // copy: a plugin can hold an entry and act on it later in the same round. The
        // run appended its answer to the SAME array afterwards, so the comparison is
        // against the prefix the hook saw — and identity (`toBe`) is what proves the
        // entry points at canonical state rather than at a snapshot of it.
        const canonical = writer.agent.messages;
        expect(entries).toHaveLength(6);
        expect(entries.map((entry) => entry.message)).toEqual(canonical.slice(0, entries.length));
        entries.forEach((entry) => {
            expect(entry.message).toBe(canonical[entry.index]);
        });

        // `messages` keeps its existing contract: the filtered, flag-free projection…
        expect(entrySnapshots[0].messages).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(carriesFlag(entrySnapshots[0].messages)).toBe(false);
        // …and it is exactly what the provider received.
        expect(seen[0]).toEqual(entrySnapshots[0].messages);
    });

    it('setIncluded on a user entry removes it from the SAME request, and the next turn still withholds it', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('disable-question', (context) => {
                    context.setIncluded(entryWith(context, 'question'), false);
                })
            ]
        });

        // The SAME captured provider request already reflects the flag — no extra turn
        // was needed, which is the whole point of the same-request re-projection.
        const expected = seededRequest('go');
        expected.splice(1, 1);
        expect(seen[0]).toStrictEqual(expected);
        expect(pairIssues(seen[0])).toEqual([]);
        expect(carriesFlag(seen[0])).toBe(false);

        // Disabled, not deleted: canonical history still holds the message, flagged.
        expect(writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });

        // A second run projects the same flags with no plugin action at all.
        await writer('again');

        expect(shape(seen[1])).toEqual([
            'system:Write.',
            'assistant::c1',
            'tool:c1:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:',
            'user:again'
        ]);
        expect(carriesFlag(seen[1])).toBe(false);
        expect(pairIssues(seen[1])).toEqual([]);
    });

    it('setIncluded on an assistant index disables the WHOLE unit and flags every member of it', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [turnBeforePlugin('disable-unit', (context) => context.setIncluded(2, false))]
        });

        // Assistant and result are both gone from this request, and the transcript the
        // provider sees is still pair-clean.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual([]);

        // Cascading is mandatory: the target was the assistant (a numeric index, the
        // other accepted form) and its result is flagged as well.
        expect(writer.agent.messages[2]).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(writer.agent.messages[3]).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha',
            included: false
        });

        // Nothing else gained a key, and no key is ever `true`.
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(2);
        expect(JSON.stringify(writer.agent.messages)).not.toContain('"included":true');
    });

    it('setIncluded on a tool result takes the OWNING unit out of the same request', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('disable-result', (context) => {
                    context.setIncluded(entryWith(context, 'A'), false);
                })
            ]
        });

        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual([]);

        // Owner resolution runs BOTH ways: the plugin targeted the answer, and the
        // assistant that requested that call is flagged with it, so no later turn can
        // emit a `tool_calls[]` entry with a missing result.
        expect(writer.agent.messages[2]).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(writer.agent.messages[3]).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha',
            included: false
        });
    });

    it('resolves unit membership by CALL ID, not adjacency, and leaves an ownerless result alone', async () => {
        // A restored or hand-edited transcript can hold the answer NON-contiguously,
        // plus an orphan result whose owning block is gone entirely.
        const seed: HarnessMessage[] = [
            { role: 'user', content: 'oldest' },
            { role: 'assistant', content: '', toolCalls: [call('c9', 'alpha')] },
            { role: 'assistant', content: 'interlude' },
            { role: 'tool', content: 'LATE', toolCallId: 'c9', name: 'alpha' },
            { role: 'tool', content: 'ORPHAN', toolCallId: 'gone', name: 'alpha' }
        ];

        const contexts: HarnessTurnBeforeContext[] = [];
        const { writer, seen } = await controlRun({
            seed,
            plugins: [
                turnBeforePlugin('by-call-id', (context) => {
                    contexts.push(context);
                    context.setIncluded(entryWith(context, 'LATE'), false);
                })
            ]
        });

        // The assistant three rows away is part of the SAME unit (it owns call `c9`),
        // so it reports the effective `false`; the orphan answers `gone`, which nobody
        // requested, so it is its own unit and stays enabled.
        expect(contexts[0].entries.map((entry) => entry.included)).toEqual([
            true,
            false,
            true,
            false,
            true,
            true
        ]);

        // Both members left the request; the orphan stayed, exactly as it would have
        // without the flag — the oracle names it, proving the write changed only the
        // targeted unit.
        expect(seen[0]).toStrictEqual([
            { role: 'user', content: 'oldest' },
            { role: 'assistant', content: 'interlude' },
            { role: 'tool', content: 'ORPHAN', toolCallId: 'gone', name: 'alpha' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual(['orphan tool#2: gone']);

        expect(writer.agent.messages[1].included).toBe(false);
        expect(writer.agent.messages[3].included).toBe(false);
        expect(writer.agent.messages[4].included).toBeUndefined();
    });

    it('re-including a unit puts it back in the SAME request and deletes the key instead of writing true', async () => {
        const seed = seededTranscript();
        seed[2].included = false;
        seed[3].included = false;

        const { writer, seen } = await controlRun({
            seed,
            plugins: [turnBeforePlugin('re-enable', (context) => context.setIncluded(2, true))]
        });

        // The unit is back in the request this very hook belongs to.
        expect(seen[0]).toStrictEqual(seededRequest('go'));
        expect(pairIssues(seen[0])).toEqual([]);

        // Canonical state: the key is GONE from both members (never `true`), so the
        // transcript is byte-identical to one that was never disabled.
        expect(writer.agent.messages[2]).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(writer.agent.messages[3]).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha'
        });
        expect(JSON.stringify([writer.agent.messages, seen])).not.toContain('included');
    });

    it('suppresses a pending placeholder for a unit the hook disables on that same request', async () => {
        vi.useFakeTimers();

        const gate = deferred<string>();
        const seen: HarnessMessage[][] = [];
        let atEntry: readonly HarnessMessage[] | undefined;
        let afterWrite: readonly HarnessMessage[] | undefined;
        let includedAtRound3: boolean[] | undefined;

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: scripted(
                        [calls(call('a1', 'alpha')), answer('waiting'), answer('settled')],
                        seen
                    )
                })
            },
            tools: { alpha: gatedTool('alpha', gate.promise) },
            presets: false,
            plugins: [
                turnBeforePlugin('disable-pending', (context) => {
                    // Turn 3 re-reads the unit state through `entries` (captured inside
                    // the handler — `entries` is a lazy per-round view, so a control
                    // test reads it while its round is running).
                    if (context.iteration === 3) includedAtRound3 = context.entries.map((entry) => entry.included);

                    // Turn 2 is the request that carries the placeholder for the call
                    // that is still running.
                    if (context.iteration !== 2) return;

                    // Snapshot BEFORE the write: this is the projection the handler was
                    // entered with, placeholder included.
                    atEntry = context.messages;
                    context.setIncluded(1, false);
                    // After the write, the LIVE accessor reports the re-projected list
                    // while `messages` stays what the handler was entered with.
                    afterWrite = context.currentMessages();
                })
            ]
        });

        const state = probe(writer('go'));
        await flush();

        // The hook DID see the placeholder at handler entry…
        expect(state.status).toBe('pending');
        expect(atEntry!.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
        // …and `currentMessages()` after the write shows the re-projected list, i.e.
        // the live view is accurate at ACCESS time while `messages` stays the
        // projection the handler was entered with.
        expect(afterWrite!.map((message) => message.role)).toEqual(['user']);
        // The provider received exactly what the live view reported, so a handler can
        // never be shown one list and have another one sent: neither the placeholder
        // nor an orphan result reached the provider.
        expect(seen[1]).toStrictEqual(afterWrite);
        expect(seen[1]).toStrictEqual([{ role: 'user', content: 'go' }]);
        expect(seen[1].some((message) => message.role === 'tool')).toBe(false);
        expect(pairIssues(seen[1])).toEqual([]);

        gate.resolve('A-done');
        await flush();

        // The exclusion keeps holding once the real result lands: the unit is still
        // gone, and the entry that arrived later was never flagged itself.
        expect(seen[2]).toStrictEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'waiting' }
        ]);
        expect(pairIssues(seen[2])).toEqual([]);
        expect(includedAtRound3).toEqual([true, false, false, true]);
        expect(writer.agent.messages[1]).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'a1', name: 'alpha', arguments: '{}' }]
        });
        expect(writer.agent.messages[2]).toStrictEqual({
            role: 'tool',
            content: 'A-done',
            toolCallId: 'a1',
            name: 'alpha'
        });

        await flush();
        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('settled');
    });

    it('lets an explicit transcript win over re-projection, in either call order, and strips a plugin-authored flag', async () => {
        const first = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('explicit-after-flag', (context) => {
                    context.setIncluded(entryWith(context, 'question'), false);
                    context.setTranscript([
                        { role: 'user', content: 'explicit prompt', included: true },
                        { role: 'assistant', content: 'kept from earlier' }
                    ]);
                })
            ]
        });

        // The explicit transcript is what the provider receives — the canonical
        // re-projection does not sneak the disabled turn back in — and the
        // `included: true` a plugin authored is normalized away.
        expect(first.seen[0]).toStrictEqual([
            { role: 'user', content: 'explicit prompt' },
            { role: 'assistant', content: 'kept from earlier' }
        ]);
        expect(JSON.stringify(first.seen)).not.toContain('included');
        // The flag write is a CONVERSATION change, so it happened even though an
        // override decided this request.
        expect(first.writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });

        const reversed = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('explicit-before-flag', (context) => {
                    context.setTranscript([{ role: 'user', content: 'explicit prompt', included: true }]);
                    context.setIncluded(entryWith(context, 'question'), false);
                })
            ]
        });

        expect(reversed.seen[0]).toStrictEqual([{ role: 'user', content: 'explicit prompt' }]);
        expect(reversed.writer.agent.messages[1].included).toBe(false);
    });

    it('sanitizes a RETURNED transcript the same way and leaves canonical state alone', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('returns', () => ({
                    transcript: [
                        { role: 'user', content: 'authored', included: true },
                        { role: 'tool', content: 'answer', toolCallId: 'x1', name: 'alpha' }
                    ]
                }))
            ]
        });

        expect(seen[0]).toStrictEqual([
            { role: 'user', content: 'authored' },
            { role: 'tool', content: 'answer', toolCallId: 'x1', name: 'alpha' }
        ]);
        expect(JSON.stringify(seen)).not.toContain('included');
        // A returned transcript requests; it does not rewrite the conversation.
        expect(JSON.stringify(writer.snapshot())).not.toContain('included');
    });

    it('builds entries per handler, so a later hook sees what an earlier one switched', async () => {
        const firstSaw: boolean[] = [];
        const secondSaw: { included: boolean[]; messages: readonly HarnessMessage[] }[] = [];

        const { seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('a-disables', (context) => {
                    firstSaw.push(...context.entries.map((entry) => entry.included));
                    context.setIncluded(entryWith(context, 'question'), false);
                }),
                turnBeforePlugin('b-observes', (context) => {
                    secondSaw.push({
                        included: context.entries.map((entry) => entry.included),
                        messages: context.messages
                    });
                })
            ]
        });

        // Handler A saw the transcript as it was: every entry enabled, including the
        // tool unit whose members are all still on.
        expect(firstSaw).toEqual([true, true, true, true, true, true]);
        // Handler B's entries are FRESHLY built and live: the same conversation now
        // answers `false` for the entry A disabled.
        expect(secondSaw[0].included).toEqual([true, false, true, true, true, true]);
        // And B's `messages` is the RE-PROJECTED request, not the stale list B was
        // handed at the start of the round.
        expect(secondSaw[0].messages).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(seen[0]).toEqual(secondSaw[0].messages);
    });

    it('answers a re-read of the same entry with the state the write produced', async () => {
        let observations: Record<string, boolean> | undefined;

        await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('live-getter', (context) => {
                    const entries = context.entries;

                    observations = {
                        questionBefore: entries[1].included,
                        unitBefore: entries[2].included,
                        resultBefore: entries[3].included
                    };

                    context.setIncluded(entries[1], false);
                    // The SAME entry object, re-read: live, not a stale snapshot.
                    observations.questionAfterSelf = entries[1].included;
                    // An unrelated unit is unaffected by that write.
                    observations.otherUnitStillOn = entries[2].included;

                    // Targeting a RESULT cascades to its owner, and the owner's entry
                    // answers immediately.
                    context.setIncluded(entries[3], false);
                    observations.assistantAfterResult = entries[2].included;
                    observations.resultAfterResult = entries[3].included;
                })
            ]
        });

        expect(observations).toEqual({
            questionBefore: true,
            unitBefore: true,
            resultBefore: true,
            questionAfterSelf: false,
            otherUnitStillOn: true,
            assistantAfterResult: false,
            resultAfterResult: false
        });
    });

    it('refuses an invalid index, an out-of-range index, and an entry from elsewhere, changing nothing', async () => {
        const failures: string[] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('refusals', (context) => {
                    // Shaped like a real entry, but never handed out by this turn.
                    const foreign = {
                        index: 0,
                        message: { role: 'user', content: 'elsewhere' },
                        included: true
                    } as HarnessContextEntry;

                    const attempts: Array<() => void> = [
                        () => context.setIncluded(1.5, false),
                        () => context.setIncluded(Number.NaN, false),
                        () => context.setIncluded(6, false),
                        () => context.setIncluded(-1, false),
                        () => context.setIncluded(foreign, false),
                        () => context.setIncluded('1' as unknown as number, false),
                        () => context.setIncluded(null as unknown as HarnessContextEntry, false)
                    ];

                    for (const attempt of attempts) {
                        try {
                            attempt();
                        } catch (error) {
                            failures.push((error as Error).message);
                        }
                    }
                })
            ]
        });

        expect(failures).toEqual([
            'turn.before setIncluded needs an integer transcript index; received 1.5.',
            'turn.before setIncluded needs an integer transcript index; received NaN.',
            'turn.before setIncluded index 6 is outside this transcript (0-5).',
            'turn.before setIncluded index -1 is outside this transcript (0-5).',
            'turn.before setIncluded received an entry that does not belong to this turn.',
            'turn.before setIncluded needs a transcript index or an entry from this turn.',
            'turn.before setIncluded needs a transcript index or an entry from this turn.'
        ]);

        // Every refusal was a no-op: the transcript carries no key at all, and the
        // request is the untouched full projection.
        expect(seen[0]).toStrictEqual(seededRequest('go'));
        expect(writer.agent.messages.filter((message) => 'included' in message)).toHaveLength(0);
    });

    it('refuses an entry made stale by replaceHistory and pins how a numeric index behaves after one', async () => {
        const rewritten: HarnessMessage[] = [
            { role: 'user', content: 'kept' },
            { role: 'user', content: 'dropped' }
        ];

        const failures: string[] = [];
        const replacedOnly = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('replace-only', (context) => {
                    const stale = entryWith(context, 'question');
                    context.replaceHistory(rewritten);

                    try {
                        context.setIncluded(stale, false);
                    } catch (error) {
                        failures.push((error as Error).message);
                    }
                })
            ]
        });

        // The documented ordering caveat: `replaceHistory` swaps the canonical
        // messages, so an entry captured before it is refused by identity instead of
        // writing a flag onto a message that is no longer part of the conversation.
        expect(failures).toEqual([
            'turn.before setIncluded received a stale entry (index 1): its message is no longer in the transcript. Read `entries` again after `replaceHistory()`.'
        ]);
        // `replaceHistory` rewrites COMMITTED state; the request already built for this
        // turn keeps the projection it was built from, and the refused write added
        // nothing to it.
        expect(replacedOnly.seen[0]).toStrictEqual(seededRequest('go'));
        expect(replacedOnly.writer.agent.messages).toStrictEqual([
            { role: 'user', content: 'kept' },
            { role: 'user', content: 'dropped' },
            { role: 'assistant', content: 'settled' }
        ]);

        // A LATER handler gets freshly built entries, so acting on the rewritten
        // transcript is straightforward — and its write re-projects this request.
        const rebuilt = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('replacer', (context) => {
                    context.replaceHistory(rewritten);
                }),
                turnBeforePlugin('acts-on-rewritten', (context) => {
                    context.setIncluded(entryWith(context, 'dropped'), false);
                })
            ]
        });

        expect(rebuilt.seen[0]).toStrictEqual([{ role: 'user', content: 'kept' }]);
        expect(rebuilt.writer.agent.messages).toStrictEqual([
            { role: 'user', content: 'kept' },
            { role: 'user', content: 'dropped', included: false },
            { role: 'assistant', content: 'settled' }
        ]);

        // DOCUMENTED CAVEAT, pinned rather than assumed: a NUMERIC index is resolved
        // against the transcript as it is at the moment of the call, so after a
        // rewrite the same number silently addresses whatever moved into that slot —
        // `entries` and indices are not auto-refreshed, and an out-of-range number is
        // refused against the NEW bounds.
        const shifted = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('replace-then-index', (context) => {
                    context.replaceHistory(rewritten);

                    // Index 1 now means `dropped` (it meant `question` a moment ago).
                    context.setIncluded(1, false);

                    try {
                        // The pre-rewrite bounds were 0-5; the new transcript ends at 1.
                        context.setIncluded(3, false);
                    } catch (error) {
                        failures.push((error as Error).message);
                    }
                })
            ]
        });

        expect(failures[failures.length - 1]).toBe(
            'turn.before setIncluded index 3 is outside this transcript (0-1).'
        );
        expect(shifted.seen[0]).toStrictEqual([{ role: 'user', content: 'kept' }]);
        expect(shifted.writer.agent.messages).toStrictEqual([
            { role: 'user', content: 'kept' },
            { role: 'user', content: 'dropped', included: false },
            { role: 'assistant', content: 'settled' }
        ]);
    });

    it('reports a flag write as a transcript change, and a restored harness keeps withholding the entry', async () => {
        const quiet: HarnessStateChangeEvent[] = [];
        const changed: HarnessStateChangeEvent[] = [];

        await controlRun({
            seed: seededTranscript(),
            plugins: [turnBeforePlugin('reader', () => undefined)],
            stateChanges: quiet
        });
        const { writer } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('disabler', (context) => {
                    context.setIncluded(entryWith(context, 'question'), false);
                })
            ],
            stateChanges: changed
        });

        // A hook that only reads dirties nothing. A flag write is a transcript change
        // and notifies EXACTLY like every other canonical write, which is the path a
        // shared store turns into a durable `state.json` save.
        expect(changesOf(quiet)).toEqual(['agent_message:writer:-', 'agent_message:writer:-']);
        expect(changesOf(changed)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);

        // The flag is in the persisted document, and only on the disabled entry.
        const snapshot = JSON.parse(JSON.stringify(writer.snapshot())) as HarnessSnapshot;
        expect(snapshot.agents.writer.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });
        expect(snapshot.agents.writer.messages.filter((message) => message.included === false)).toHaveLength(
            1
        );

        // A harness restored from that document withholds the entry again with no
        // plugin involved at all.
        const restoredSeen: HarnessMessage[][] = [];
        const target = harness({
            agents: {
                writer: agent({ model: 'test/model', stream: scripted([answer('restored')], restoredSeen) })
            },
            tools: { alpha: echoTool('alpha', 'A') },
            presets: false
        });
        target.restore(snapshot);
        expect(target.snapshot()).toEqual(snapshot);

        await target('again');

        // The snapshot was taken after the run, so the restored conversation also
        // replays its own committed answer — and still no `question` turn.
        expect(shape(restoredSeen[0])).toEqual([
            'system:Write.',
            'assistant::c1',
            'tool:c1:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:',
            'user:again'
        ]);
        expect(carriesFlag(restoredSeen[0])).toBe(false);
        expect(restoredSeen[0].some((message) => message.content === 'question')).toBe(false);
    });

    it('applies setIncluded to a branch run, whose transcript is ephemeral', async () => {
        vi.useFakeTimers();

        // A branch shares its source's transport, so requests are routed by content —
        // the convention src/harness.fork.test.ts established.
        const lastUser = (messages: readonly HarnessMessage[]): string => {
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                if (messages[index].role === 'user') return String(messages[index].content);
            }
            return '';
        };
        const toolContents = (messages: readonly HarnessMessage[]): string[] =>
            messages
                .filter((message) => message.role === 'tool')
                .map((message) => String(message.content));
        // Fork runs need more drain passes than the plain board (the branch is a second
        // actor): 32 zero-advance passes, as src/harness.fork.test.ts uses.
        const settle = async (): Promise<void> => {
            for (let pass = 0; pass < 32; pass += 1) {
                await vi.advanceTimersByTimeAsync(0);
                await Promise.resolve();
            }
        };

        const runFork = async (withPlugin: boolean) => {
            const seen: HarnessMessage[][] = [];
            const changes: HarnessStateChangeEvent[] = [];
            const contexts: HarnessTurnBeforeContext[] = [];
            const refusals: string[] = [];

            const writer = harness({
                agents: {
                    writer: agent({
                        model: 'test/model',
                        stream: async function* (request) {
                            const messages = request.messages;
                            seen.push(copyMessages(messages));

                            if (lastUser(messages) === 'inspect') {
                                for (const frame of answer('branch summary')) yield frame;
                                return;
                            }
                            if (toolContents(messages).some((content) => content.includes('branch summary'))) {
                                for (const frame of answer('root final')) yield frame;
                                return;
                            }
                            if (!messages.some((message) => message.role === 'assistant')) {
                                for (const frame of calls(call('f1', 'threadFork', '{"input":"inspect"}'))) {
                                    yield frame;
                                }
                                return;
                            }

                            for (const frame of answer('waiting')) yield frame;
                        }
                    })
                },
                presets: false,
                ...(withPlugin
                    ? {
                          plugins: [
                              turnBeforePlugin('branch-disabler', (context) => {
                                  contexts.push(context);

                                  // The branch is identified by CONTENT, not by
                                  // `threadId`: a fork run reports the id of the
                                  // conversation that SPAWNED it (`emitTurnBefore`
                                  // reads `run.threadId`, which `runAgent` resolves
                                  // from the parent thread), so the root round and
                                  // the branch round carry the same string. The
                                  // branch's copied transcript holds the
                                  // `created-branch` placeholder for its own
                                  // still-pending fork call — content that only a
                                  // branch round can contain.
                                  if (
                                      !context.entries.some((entry) =>
                                          entry.message.content.includes('created-branch')
                                      )
                                  ) {
                                      return;
                                  }

                                  context.setIncluded(entryWith(context, 'root input'), false);

                                  // A branch has no persistent conversation to
                                  // rewrite, so the OTHER transcript control is
                                  // refused outright — and the refusal must not
                                  // disturb the round that is already running.
                                  try {
                                      context.replaceHistory([{ role: 'user', content: 'refused' }]);
                                  } catch (error) {
                                      refusals.push((error as Error).message);
                                  }
                              })
                          ]
                      }
                    : {}),
                report: { stateChange: (event: HarnessStateChangeEvent) => void changes.push(event) }
            });

            await writer('root input');
            await settle();

            return { seen, changes, contexts, refusals, writer };
        };

        const plain = await runFork(false);
        const flagged = await runFork(true);

        // The branch really did get a control surface, and it belongs to the FIRST
        // fork round: that is the only `turn.before` whose entries contain the
        // `created-branch` placeholder — the root's later round carries the real fork
        // result instead. Entries are live, so the list read back after the round
        // shows the branch's own write taking effect immediately.
        const branchContexts = flagged.contexts.filter((context) =>
            context.entries.some((entry) => entry.message.content.includes('created-branch'))
        );
        expect(branchContexts).toHaveLength(1);
        expect(
            branchContexts[0].entries.map((entry) => ({
                index: entry.index,
                included: entry.included,
                content: String(entry.message.content).slice(0, 11)
            }))
        ).toEqual([
            { index: 0, included: false, content: 'root input' },
            { index: 1, included: true, content: '' },
            { index: 2, included: true, content: 'No tool res' },
            { index: 3, included: true, content: 'inspect' }
        ]);

        const branchRequest = flagged.seen.find((messages) => lastUser(messages) === 'inspect');
        const plainRequest = plain.seen.find((messages) => lastUser(messages) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(plainRequest).toBeDefined();

        // Without the plugin the branch starts with the source turn it copied; with
        // the flag the branch's OWN request drops it, while the remapped pending call
        // keeps its placeholder and the transcript stays pair-complete.
        expect(plainRequest!.map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'user'
        ]);
        expect(branchRequest!.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
        expect(branchRequest!.some((message) => message.content === 'root input')).toBe(false);
        expect(pairIssues(branchRequest!)).toEqual([]);
        expect(carriesFlag(branchRequest!)).toBe(false);

        // `replaceHistory` was refused exactly once — on the branch round — and the
        // root rounds never reached that call at all.
        expect(flagged.refusals).toEqual([
            'replaceHistory needs a persistent conversation; this run has none.'
        ]);

        // The SOURCE conversation is untouched: a branch flags its own ephemeral copy,
        // never the transcript it forked, so nothing of it can reach a snapshot.
        expect(withoutBranchIds(flagged.writer.agent.messages)).toBe(
            withoutBranchIds(plain.writer.agent.messages)
        );
        expect(flagged.writer.agent.messages.filter((message) => 'included' in message)).toHaveLength(0);
        expect(JSON.stringify(flagged.writer.snapshot())).not.toContain('included');

        // And the ephemeral write reports no change at all: `agent_message` means "a
        // persistent conversation moved", which a branch write never is, so the branch
        // run's notification is skipped (src/harness.ts:7561).
        expect(withoutBranchIds(changesOf(flagged.changes))).toBe(withoutBranchIds(changesOf(plain.changes)));
    });

    it('leaves the request and the event stream byte-identical when a plugin only reads entries', async () => {
        const turns: HarnessStreamEvent[][] = [calls(call('a1', 'alpha')), answer('after alpha')];

        // The same compact, id-aware projection of the progress stream
        // src/harness.plugin.test.ts uses for its microtask-neutrality checks.
        const eventKey = (event: HarnessEvent): string => {
            if (event.type === 'tool_call') return `tool_call:${event.agent}:${event.call.id}`;
            if (event.type === 'tool_result') {
                return `tool_result:${event.agent}:${event.callId}:${event.content}`;
            }
            if (event.type === 'done') return `done:${event.agent}:${event.message.content}`;
            if (event.type === 'text') return `text:${event.agent}:${event.delta}`;
            return `${event.type}:${event.agent}`;
        };

        const plainEvents: HarnessEvent[] = [];
        const readEvents: HarnessEvent[] = [];

        const plain = await controlRun({ turns, events: plainEvents });
        const read = await controlRun({
            turns,
            events: readEvents,
            plugins: [
                turnBeforePlugin('reader', (context) => {
                    void context.entries.filter((entry) => !entry.included);
                })
            ]
        });

        // The baseline pinned on its own, so the comparison below cannot drift into
        // "whatever the second harness happened to do".
        expect(shape(plain.seen[0])).toEqual(['user:go']);
        expect(shape(plain.seen[1])).toEqual(['user:go', 'assistant::a1', 'tool:a1:A']);
        expect(plainEvents.map(eventKey)).toEqual([
            'start:writer',
            'tool_call:writer:a1',
            // The request's success boundary closes BEFORE the inline result is
            // delivered, exactly as the plugin framework pins it.
            'attempt_commit:writer',
            'tool_result:writer:a1:A',
            'text:writer:after alpha',
            'done:writer:after alpha'
        ]);

        // An observing plugin that only reads `entries`/`included` changes nothing:
        // identical provider requests, identical frames (no added microtask boundary),
        // identical committed history.
        expect(JSON.stringify(read.seen)).toBe(JSON.stringify(plain.seen));
        expect(readEvents.map(eventKey)).toEqual(plainEvents.map(eventKey));
        expect(JSON.stringify(read.writer.agent.messages)).toBe(JSON.stringify(plain.writer.agent.messages));
    });
});

// ---------------------------------------------------------------------------
// 6 — Stage 1c refinements (review caveats: strict flag, lazy entries, live view)
// ---------------------------------------------------------------------------

describe('context inclusion — turn.before refinements', () => {
    it('refuses an `included` value that is not a boolean and applies nothing', async () => {
        const failures: string[] = [];
        const applied: unknown[] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('strict-flag', (context) => {
                    applied.push(...context.entries.map((entry) => entry.included));

                    // Each of these USED to be coerced silently: `'truthy'` and `1`
                    // re-enabled (deleting the key), `0`/`null`/`undefined` disabled.
                    // None of them is a decision the caller can have meant.
                    for (const value of ['truthy', 0, 1, null, undefined, '', 'false', 10n]) {
                        try {
                            context.setIncluded(2, value as unknown as boolean);
                        } catch (error) {
                            failures.push((error as Error).message);
                        }
                    }

                    // A real boolean still works after all those refusals.
                    context.setIncluded(2, false);
                    applied.push(...context.entries.map((entry) => entry.included));
                })
            ]
        });

        expect(failures).toEqual([
            'turn.before setIncluded needs a boolean for `included`; received "truthy".',
            'turn.before setIncluded needs a boolean for `included`; received 0.',
            'turn.before setIncluded needs a boolean for `included`; received 1.',
            'turn.before setIncluded needs a boolean for `included`; received null.',
            'turn.before setIncluded needs a boolean for `included`; received undefined.',
            'turn.before setIncluded needs a boolean for `included`; received "".',
            'turn.before setIncluded needs a boolean for `included`; received "false".',
            'turn.before setIncluded needs a boolean for `included`; received 10.'
        ]);

        // Nothing moved until the accepted call: before it EVERY entry was on, after it
        // exactly one unit is off.
        expect(applied.slice(0, 6)).toEqual([true, true, true, true, true, true]);
        expect(applied.slice(6)).toEqual([true, true, false, false, true, true]);

        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(2);
    });

    it('reports the real bounds of the live transcript, computed from the transcript itself', async () => {
        const refusals: string[] = [];
        const record = (label: string, run: () => void): void => {
            try {
                run();
            } catch (error) {
                refusals.push(`${label}: ${(error as Error).message}`);
            }
        };

        // ONE seeded message, and the run's own prompt appended before the first turn:
        // the transcript the hook is handed has TWO entries, so index 2 is the first
        // invalid one and the message must say so exactly.
        const oneSeed = await controlRun({
            seed: [{ role: 'user', content: 'only' }],
            plugins: [
                turnBeforePlugin('probe-two-entries', (context) => {
                    const snapshot = context.entries.map((entry) => `${entry.index}:${entry.message.content}`);

                    if (snapshot.join('|') !== '0:only|1:go') throw new Error(`unexpected transcript ${snapshot.join('|')}.`);

                    context.setIncluded(0, false);
                    record('index 2', () => context.setIncluded(2, false));
                })
            ]
        });

        expect(refusals).toEqual([
            'index 2: turn.before setIncluded index 2 is outside this transcript (0-1).'
        ]);
        // Withholding the only seeded turn leaves JUST the run's prompt on the wire:
        // request-time filtering follows the canonical flags, entry bounds or not.
        expect(oneSeed.seen[0]).toStrictEqual([{ role: 'user', content: 'go' }]);
        expect(oneSeed.writer.agent.messages[0]).toStrictEqual({
            role: 'user',
            content: 'only',
            included: false
        });

        // THREE canonical entries (instruction, user turn, plain assistant answer): the
        // valid range is 0-2 and index 3 has to be refused against THAT range. The old
        // `Math.max(length - 1, 0)` form was only accidentally right for transcripts
        // longer than one entry, and lied for the empty one below.
        refusals.length = 0;

        const threeEntries = await controlRun({
            seed: [
                { role: 'system', content: 'Write.' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'answered' }
            ],
            plugins: [
                turnBeforePlugin('probe-three-entries', (context) => {
                    if (context.entries.length !== 4) {
                        throw new Error(`expected 4 entries, saw ${String(context.entries.length)}.`);
                    }

                    record('index 4', () => context.setIncluded(4, false));
                })
            ]
        });

        expect(refusals).toEqual([
            'index 4: turn.before setIncluded index 4 is outside this transcript (0-3).'
        ]);
        expect(threeEntries.seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);

        // THE EMPTY TRANSCRIPT: `(0-0)` claimed index 0 was valid, when nothing is. No
        // live run can reach it — the harness appends the run's prompt before the first
        // `turn.before`, so the transcript always has >= 1 entry — hence the defensive
        // wording is pinned by what IS reachable above, and the request-with-nothing
        // case is pinned here instead: every entry withheld projects to an empty body.
        const withheld = await controlRun({
            seed: [{ role: 'system', content: 'Write.' }],
            plugins: [
                turnBeforePlugin('withhold-everything', (context) => {
                    for (const entry of context.entries) {
                        if (entry.message.content !== 'go') context.setIncluded(entry, false);
                    }
                })
            ]
        });

        expect(withheld.seen[0]).toStrictEqual([{ role: 'user', content: 'go' }]);
        expect(withheld.writer.agent.messages[0]).toStrictEqual({
            role: 'system',
            content: 'Write.',
            included: false
        });
    });

    it('keeps `messages` the projection at handler entry and adds currentMessages() for the live one', async () => {
        const a: {
            sameBeforeWrite: boolean[];
            atEntry: readonly HarnessMessage[] | undefined;
            afterFlag: readonly HarnessMessage[] | undefined;
            afterOverride: readonly HarnessMessage[] | undefined;
        } = { sameBeforeWrite: [], atEntry: undefined, afterFlag: undefined, afterOverride: undefined };

        // Round 1: A writes a flag, B is entered afterwards.
        const first = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('a-writes', (context) => {
                    // Unchanged state: the live view IS the entry-time projection.
                    a.sameBeforeWrite.push(context.messages === context.currentMessages());
                    a.atEntry = context.messages;

                    context.setIncluded(entryWith(context, 'question'), false);

                    // A's OWN write did not move `messages` underneath it (the contract
                    // harness.plugin.test.ts pins for `turn.before`), while the live
                    // accessor already dropped the disabled turn.
                    a.afterFlag = context.currentMessages();
                }),
                turnBeforePlugin('b-reads', (context) => {
                    // B is ENTERED with the projection A's write produced, and by
                    // IDENTITY: the cache is refreshed once per write, not rebuilt for
                    // every handler.
                    if (context.messages !== a.afterFlag) {
                        throw new Error('handler B was not entered with A\'s re-projection.');
                    }

                    if (context.currentMessages() !== context.messages) {
                        throw new Error('the live view diverged with nothing written.');
                    }
                })
            ]
        });

        expect(a.sameBeforeWrite).toEqual([true]);
        expect(a.atEntry).toStrictEqual(seededRequest('go'));
        expect(a.afterFlag).toStrictEqual(seededRequest('go').filter((message) => message.content !== 'question'));
        // The provider received the live view, never the stale entry-time one.
        expect(first.seen[0]).toStrictEqual(a.afterFlag);
        expect(first.writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });

        // Round 2: an explicit override is visible to the live accessor inside the SAME
        // handler, and it is what the provider receives.
        const second = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('a-overrides', (context) => {
                    context.setIncluded(entryWith(context, 'question'), false);
                    context.setTranscript([{ role: 'user', content: 'explicit override' }]);
                    a.afterOverride = context.currentMessages();
                })
            ]
        });

        expect(a.afterOverride).toStrictEqual([{ role: 'user', content: 'explicit override' }]);
        expect(second.seen[0]).toStrictEqual(a.afterOverride);
        // The flag write is still a CONVERSATION change even though the override decided
        // this request.
        expect(second.writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });
    });

    it('applies the same live/entry semantics when the handler round is asynchronous', async () => {
        const observed: {
            atEntry: readonly HarnessMessage[];
            afterFlag: readonly HarnessMessage[];
            afterAwait: readonly HarnessMessage[];
        }[] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                {
                    name: 'async-writer',
                    setup: (api: HarnessPluginApi) => {
                        api.on('turn.before', async (context) => {
                            const atEntry = context.messages;

                            context.setIncluded(entryWith(context, 'question'), false);

                            // A handler that does real work: the round leaves the
                            // synchronous fast path, and the request is decided on a
                            // microtask instead of on the caller's tick.
                            await Promise.resolve();

                            observed.push({
                                atEntry,
                                afterFlag: context.currentMessages(),
                                afterAwait: context.messages
                            });

                            // Fail-open: a rejected handler must not fail the run.
                            throw new Error('compactor said no');
                        });
                    }
                }
            ]
        });

        expect(observed).toHaveLength(1);
        // Entry-time view unchanged, live view already withheld the disabled turn —
        // identical to the synchronous round above, because the projection cache does
        // not depend on the dispatch being sync.
        expect(observed[0].atEntry).toStrictEqual(seededRequest('go'));
        expect(observed[0].afterFlag).toStrictEqual(
            seededRequest('go').filter((message) => message.content !== 'question')
        );
        expect(observed[0].afterAwait).toBe(observed[0].atEntry);

        // The ASYNC tail still applied the flag to the request that went out...
        expect(seen[0]).toStrictEqual(observed[0].afterFlag);
        expect(pairIssues(seen[0])).toEqual([]);
        // ... and the write persisted exactly as in the sync case.
        expect(writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });

        // The handler threw AFTER its write: fail-open swallowed the rejection, the run
        // still committed its answer, and the flag the handler wrote survived the throw
        // (a hook error never rolls back a canonical write it already made).
        expect(writer.agent.messages[writer.agent.messages.length - 1]).toStrictEqual({
            role: 'assistant',
            content: 'settled'
        });
    });

    it('builds `entries` on first read and hands each handler its own cached list', async () => {
        const lists: readonly HarnessContextEntry[][] = [];

        const { seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                // A writes through a NUMERIC index and never reads `entries` at all —
                // the case that used to pay for the list anyway.
                turnBeforePlugin('a-index-writer', (context) => context.setIncluded(1, false)),
                turnBeforePlugin('b-observer', (context) => {
                    if (context.entries !== context.entries) {
                        throw new Error('B\'s entries are not cached per handler.');
                    }

                    lists.push(context.entries);
                }),
                turnBeforePlugin('c-observer', (context) => {
                    if (context.entries !== context.entries) {
                        throw new Error('C\'s entries are not cached per handler.');
                    }

                    lists.push(context.entries);
                })
            ]
        });

        expect(lists).toHaveLength(2);
        // One list per handler: never the same array, always the CURRENT state — B and
        // C both report what A switched off.
        expect(lists[1]).not.toBe(lists[0]);
        expect(lists[0].map((entry) => entry.included)).toEqual([
            true,
            false,
            true,
            true,
            true,
            true
        ]);
        expect(lists[1].map((entry) => entry.included)).toEqual(lists[0].map((entry) => entry.included));

        // A's index-only write still reached the provider.
        expect(seen[0]).toStrictEqual(seededRequest('go').filter((message) => message.content !== 'question'));
    });
});
