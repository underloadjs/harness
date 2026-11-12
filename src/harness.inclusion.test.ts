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
//   2. THE UNIT OF EXCLUSION IS ONE TRANSCRIPT ENTRY (R8). A flag on an assistant
//      entry removes ONLY that entry: its committed results keep riding in the
//      request as ownerless `tool` messages, because an answer the model already
//      has is worth keeping even when its request is switched off. A flag on a tool
//      RESULT removes only that result and replaces it, in the slot it occupied,
//      with a request-only `status: 'withheld'` placeholder, so an emitted
//      `tool_calls[]` entry always has exactly one answer (src/harness.ts
//      `projectTranscript`, and src/transport/openai.ts emits tool messages without
//      validating pairing either way).
//   3. Filtering is request-only: `agent.messages` keeps every entry, in place,
//      with its flag, so the change is reversible.
//   4. Pairing has two halves now: a withheld RESULT keeps the projection
//      pair-clean (the placeholder answers the call, siblings untouched), while a
//      withheld REQUEST deliberately leaves its results ownerless — the oracle
//      below names them, and that leak IS the feature. Surviving blocks keep CALL
//      ORDER.
//   5. (Stage 1b) `entries` is the CANONICAL list with LIVE, per-ENTRY `included`;
//      `setIncluded()` is a canonical write of exactly ONE entry, takes effect in
//      the SAME model request, survives into later turns, persists through
//      snapshot/restore, and never stores `true`.
//   6. (Stage 1b) An explicit transcript (setTranscript / a returned `transcript`)
//      outranks that re-projection and is sanitized; a bad index, a foreign entry
//      and an entry made stale by `replaceHistory()` all throw without writing.
//   7. (Stage 1b) A branch run gets the same control surface on its EPHEMERAL
//      copy: its own request is filtered, the source transcript and any snapshot
//      stay flag-free, and no persistence notification is reported.
//   8. (Uplift T1 / H1) With NO context policy applied and NO flag anywhere the
//      projection IS the transcript — every recorded entry, canonical order, equal
//      content (pair and `reasoning` included), no flag key, and no transcript write
//      by the engine itself. Section 11 pins it as an executed contract.
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
// The generated auto-discovery wiring (src/plugins scanned at build time). Section 11 reads
// it to name-replace EVERY auto-loaded plugin, so a new built-in cannot silently start
// trimming inside the "no policy installed" fixture.
import { BUILTIN_PLUGINS } from './plugin/manifest';
import type {
    HarnessContextEditPatch,
    HarnessContextEntry,
    HarnessEvent,
    HarnessMessage,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginSettingsProvider,
    HarnessStateChangeEvent,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent,
    HarnessToolCall,
    HarnessTurnBeforeContext
} from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

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
// no other role in between; every tool message must belong to such a run. Under
// per-entry inclusion (R8) this oracle has two readings: a withheld RESULT must
// still report NO issue (the placeholder answers the call), while a withheld
// REQUEST reports each of its riding results here as an orphan — the exact figure
// the tests below pin for that case.
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

// The request-only answer a withheld tool RESULT leaves in the slot the real result
// occupied (src/harness.ts `projectTranscript`, the `withheldResultCallIds` branch).
// Quoted once here so every assertion below pins the SAME byte-exact content, and a
// wording change in production fails loudly instead of passing a fuzzy check.
const withheldContent = (callId: string, name: string): string =>
    JSON.stringify({
        status: 'withheld',
        callId,
        name,
        note: 'The result of this tool call is withheld from your context, so its content is not available to you. The call already finished; do not re-run it just because the answer is missing.'
    });

// The same message in `shape()` spelling, for the projection lists asserted below.
const withheldShape = (callId: string, name: string): string =>
    `tool:${callId}:${withheldContent(callId, name)}`;

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
// observe a request-time placeholder and prove a switched-off REQUEST entry emits
// none of it.
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
        expect(withoutIds(writer.agent.messages[0])).toStrictEqual({
            role: 'user',
            content: 'go',
            included: true
        });
        // And it is normalized again on the way OUT: a snapshot never persists a
        // `true` either, so the value cannot survive a restart (core/snapshot.ts
        // `applyIncluded`), which is why no consumer has to reason about it.
        expect(withoutIds(writer.snapshot().agents.writer.messages[0])).toStrictEqual({
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
        expect(withoutIds(writer.agent.messages)).toStrictEqual([
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
        expect(withoutIds(writer.agent.messages[0])).toStrictEqual({
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
        expect(withoutIds(writer.agent.messages[0])).toEqual({
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
        expect(withoutIds(writer.agent.messages[0])).toEqual({ role: 'user', content: 'go' });
    });
});

// ---------------------------------------------------------------------------
// 3 — tool-call units
// ---------------------------------------------------------------------------

describe('context inclusion — tool-call units', () => {
    it('withholds ONLY the disabled request entry and lets its answer keep riding', async () => {
        const { writer, seen } = await settledRun();

        (writer.agent.messages[1] as HarnessMessage).included = false;
        await writer('again');

        // R8: one entry, one flag. Switching the REQUEST off drops the assistant
        // `toolCalls` entry alone — no block, and no placeholder invented for a call
        // whose answer already exists — while the committed result stays in the
        // request as a top-level `tool` message (src/harness.ts `projectTranscript`
        // skips exactly the flagged entry and nothing next to it).
        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again'
        ]);
        // The one deliberate pairing leak: a riding result with no owning block. The
        // oracle names it, and the transport emits it unchanged
        // (src/transport/openai.ts builds `tool` messages without validating pairing).
        expect(pairIssues(seen[seen.length - 1])).toEqual(['orphan tool#1: a1']);
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1',
            'tool:a1:A',
            'assistant:after alpha:',
            'user:again',
            // The second run committed its own answer, and BOTH entries of the
            // switched-off request are still in canonical history at their original
            // positions: the flag never deletes and never reaches the result.
            'assistant:after alpha:'
        ]);
        expect(writer.agent.messages[2].included).toBeUndefined();
    });

    it('withholds ONE result of a parallel block, answers its call with the placeholder, and leaves the sibling result', async () => {
        const { writer, seen } = await settledRun('go', [
            calls(call('a1', 'alpha'), call('b1', 'beta')),
            answer('both done')
        ], { alpha: echoTool('alpha', 'A'), beta: echoTool('beta', 'B') });

        const before = shape(seen[seen.length - 1]);
        expect(before).toEqual(['user:go', 'assistant::a1|b1', 'tool:a1:A', 'tool:b1:B']);

        // A RESULT flag is a statement about that one entry (R8). The block still has to
        // answer both calls — an emitted `tool_calls[]` entry with no following `tool`
        // message is what a strict provider rejects — so the withheld slot is filled
        // with the request-only `status: 'withheld'` placeholder, in place, while the
        // sibling result is emitted exactly as it always was.
        (writer.agent.messages[3] as HarnessMessage).included = false;
        await writer('again');

        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'assistant::a1|b1',
            'tool:a1:A',
            withheldShape('b1', 'beta'),
            'assistant:both done:',
            'user:again'
        ]);
        // A withheld RESULT is the pair-clean half of the contract: the call is
        // answered, so nothing is orphaned.
        expect(pairIssues(seen[seen.length - 1])).toEqual([]);
        // The placeholder is request-only: canonical history still holds the real
        // result content, only flagged.
        const result = writer.agent.messages[3] as Extract<HarnessMessage, { role: 'tool' }>;
        expect({ content: result.content, toolCallId: result.toolCallId, name: result.name, included: result.included }).toEqual({
            content: 'B',
            toolCallId: 'b1',
            name: 'beta',
            included: false
        });
    });

    it('leaves the other blocks intact and in call order when one block is disabled, its two answers riding on', async () => {
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

        // The surviving block keeps BOTH results in CALL order. The disabled REQUEST
        // loses only its own entry: its two answers ride on, above the surviving
        // block, which is exactly what makes a truncated request cheaper than a
        // deleted unit (R8).
        expect(shape(seen[seen.length - 1])).toEqual([
            'user:go',
            'tool:a1:A',
            'tool:a2:A2',
            'assistant::b1|b2',
            'tool:b1:B',
            'tool:b2:B2',
            'assistant:all done:',
            'user:again'
        ]);
        expect(pairIssues(seen[seen.length - 1])).toEqual([
            'orphan tool#1: a1',
            'orphan tool#2: a2'
        ]);
        expect(carriesFlag(seen[seen.length - 1])).toBe(false);
    });

    it('switches exactly one entry even when a result sits outside its assistant block (restored or hand-edited history)', async () => {
        // A canonical transcript may hold a result NON-contiguously: restore, a
        // host edit, or a delivery that landed after another turn committed the
        // interlude. Per-entry inclusion (R8) has no adjacency rule to break — the
        // flag moves the one entry it is on and nothing else, wherever its partner
        // happens to sit. Both flag positions are pinned below: the assistant entry
        // leaves and its detached answer rides on; the answer leaves and its block
        // gets the withheld placeholder even across the interlude.
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

        // Flagging the ASSISTANT entry: no block, no placeholder for it, and the
        // detached result is NOT taken with it — it rides on, orphaned, exactly as the
        // unflagged baseline projected it. One entry moved.
        expect(shape(flagged[0])).toEqual(['user:go', 'assistant:interlude:', 'tool:c1:R', 'user:again']);
        expect(pairIssues(flagged[0])).toEqual(['orphan tool#2: c1']);
        expect(carriesFlag(flagged[0])).toBe(false);

        // Flagging the detached RESULT instead: the block keeps its request entry and
        // must still answer it, so the call is answered by the withheld placeholder —
        // found by CALL ID, not by adjacency (src/harness.ts `withheldResultCallIds`
        // scans the whole transcript before the block walk).
        const resultFlagged: HarnessMessage[][] = [];
        const resultDisabled = seededHistory();
        resultDisabled[3].included = false;
        const reader = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: resultDisabled,
                    stream: scripted([answer('ok')], resultFlagged)
                })
            },
            presets: false
        });
        await reader('again');

        expect(shape(resultFlagged[0])).toEqual([
            'user:go',
            'assistant::c1',
            withheldShape('c1', 'alpha'),
            'assistant:interlude:',
            'user:again'
        ]);
        expect(pairIssues(resultFlagged[0])).toEqual([]);
        expect(carriesFlag(resultFlagged[0])).toBe(false);
    });

    it('suppresses the placeholder of a switched-off request entry and lets the landed answer ride', async () => {
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

        // R8: the flag is on the REQUEST entry, so no block is emitted and there is
        // nothing to answer — the pending placeholder is gone with its block, while
        // the answer that has now landed rides on alone.
        expect(shape(seen[2])).toEqual(['user:go', 'tool:a1:A-done', 'assistant:waiting:']);
        expect(pairIssues(seen[2])).toEqual(['orphan tool#1: a1']);

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

    it('maps a filtered transcript onto the provider payload: kept block pair-complete, withheld request answers riding, no flag field', async () => {
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

        // The exact provider payload. The surviving block keeps both answers in call
        // order and stays pair-complete; the switched-off REQUEST leaves its own
        // `tool_calls` entry out while BOTH of its answers ride on under their own
        // `tool_call_id` — the transport validates nothing here, it maps what the
        // projection handed it (src/transport/openai.ts), which is what makes the
        // per-entry flag (R8) observable on the wire rather than at the model.
        expect(body.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'tool', tool_call_id: 'a1', content: 'A' },
            { role: 'tool', tool_call_id: 'a2', content: 'A2' },
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

    it('sends a withheld result as the one tool message that answers its call, beside an untouched sibling', async () => {
        // The wire half of the placeholder contract: the provider gets EXACTLY one tool
        // message per `tool_calls[]` entry, in call order — the withheld slot filled by the
        // `status: 'withheld'` payload, the kept slot carrying the real answer. Nothing in
        // the payload mentions the flag (src/transport/openai.ts maps role/content/id only).
        const { writer, seen } = await settledRun('go', [
            calls(call('a1', 'alpha'), call('a2', 'alpha2')),
            answer('both done')
        ], { alpha: echoTool('alpha', 'A'), alpha2: echoTool('alpha2', 'A2') });

        (writer.agent.messages[3] as HarnessMessage).included = false;
        await writer('again');

        const body = await sendToProvider(seen[seen.length - 1]);

        expect(body.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'a1', type: 'function', function: { name: 'alpha', arguments: '{}' } },
                    { id: 'a2', type: 'function', function: { name: 'alpha2', arguments: '{}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'a1', content: 'A' },
            { role: 'tool', tool_call_id: 'a2', content: withheldContent('a2', 'alpha2') },
            { role: 'assistant', content: 'both done' },
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
// instruction, a standalone user turn, ONE complete tool call (request entry plus
// result entry), and a final answer. All enabled, so each test flips exactly ONE
// ENTRY and asserts that entry's own consequence — nothing else moves (R8).
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
    it('lists every canonical entry with its OWN live inclusion while messages stays the filtered projection', async () => {
        const seed = seededTranscript();
        // A standalone disabled turn AND one disabled RESULT. The assistant that asked
        // for that result reports `included: true` — its own flag was never written,
        // and R8 removed the inheritance (src/harness.ts, the entry `included` getter).
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
        // any other. `included` is THAT ENTRY's live verdict (R8): entry 2 stays `true`
        // even though its result is off, and no member of anything inherits anything.
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
            { index: 2, included: true, role: 'assistant', content: '' },
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
        // the surviving request entry is STILL emitted (its own flag is on) and answers
        // its call with the withheld placeholder in the slot the off result vacated.
        expect(entrySnapshots[0].messages).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: withheldContent('c1', 'alpha'), toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(carriesFlag(entrySnapshots[0].messages)).toBe(false);
        // …and it is exactly what the provider received.
        expect(seen[0]).toEqual(entrySnapshots[0].messages);
        expect(pairIssues(seen[0])).toEqual([]);
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
        expect(withoutIds(writer.agent.messages[1])).toStrictEqual({
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

    it('setIncluded on an assistant index writes that ONE entry and leaves its result unflagged', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [turnBeforePlugin('disable-request', (context) => context.setIncluded(2, false))]
        });

        // Only the request entry left the request (R8): the answer the model already
        // has keeps riding, which is why the pair oracle now reports it as an orphan.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual(['orphan tool#2: c1']);

        // ONE canonical write, addressed by numeric index: the assistant carries the
        // flag and its result carries NOTHING — no cascade, no inherited verdict.
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(withoutIds(writer.agent.messages[3])).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha'
        });

        // Nothing else gained a key, and no key is ever `true`.
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(1);
        expect(JSON.stringify(writer.agent.messages)).not.toContain('"included":true');
    });

    it('setIncluded on a tool result withholds ONLY that answer and fills its slot with the placeholder', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('disable-result', (context) => {
                    context.setIncluded(entryWith(context, 'A'), false);
                })
            ]
        });

        // The request entry stays (its own flag is untouched) and its call is still
        // answered — by the request-only `status: 'withheld'` message, so no provider
        // can reject the pairing.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: withheldContent('c1', 'alpha'), toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual([]);

        // The write moved the answer and ONLY the answer: the owning assistant keeps
        // its verdict, which is the whole point of addressing one entry per call
        // (src/harness.ts `writeIncluded`).
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(withoutIds(writer.agent.messages[3])).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha',
            included: false
        });
    });

    it('finds a NON-adjacent result by CALL ID, writes only it, and leaves an ownerless result alone', async () => {
        // A restored or hand-edited transcript can hold the answer NON-contiguously,
        // plus an orphan result whose owning block is gone entirely. Membership is by
        // CALL ID for the PROJECTION (which slot gets the placeholder) and never for the
        // WRITE, which is one entry deep.
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

        // Only the targeted row reports `false`. The assistant three rows away keeps its
        // own verdict, and the orphan nobody requested is simply another entry.
        expect(contexts[0].entries.map((entry) => entry.included)).toEqual([
            true,
            true,
            true,
            false,
            true,
            true
        ]);

        // The block stays and answers its call from three rows away — the withheld scan
        // runs over the WHOLE transcript, not just the contiguous run
        // (src/harness.ts `withheldResultCallIds`). The orphan is untouched, exactly as
        // it would have been without the flag: the oracle names it and only it.
        expect(seen[0]).toStrictEqual([
            { role: 'user', content: 'oldest' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: withheldContent('c9', 'alpha'), toolCallId: 'c9', name: 'alpha' },
            { role: 'assistant', content: 'interlude' },
            { role: 'tool', content: 'ORPHAN', toolCallId: 'gone', name: 'alpha' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual(['orphan tool#4: gone']);

        expect(writer.agent.messages[1].included).toBeUndefined();
        expect(writer.agent.messages[3].included).toBe(false);
        expect(writer.agent.messages[4].included).toBeUndefined();
    });

    it('re-including ONE entry puts it back in the SAME request and deletes the key instead of writing true', async () => {
        const seed = seededTranscript();
        seed[2].included = false;
        seed[3].included = false;

        const { writer, seen } = await controlRun({
            seed,
            plugins: [turnBeforePlugin('re-enable-request', (context) => context.setIncluded(2, true))]
        });

        // Only the entry the hook named comes back (R8). The request entry is in again
        // and must answer its call, and the result the hook did NOT name is still off —
        // so its slot holds the placeholder rather than the real answer.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: withheldContent('c1', 'alpha'), toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual([]);

        // Canonical state: the re-enabled entry's key is GONE (never `true`), so that
        // entry is byte-identical to one that was never disabled, while the other entry
        // keeps the flag this hook never touched.
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(withoutIds(writer.agent.messages[3])).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha',
            included: false
        });
        expect(JSON.stringify(writer.agent.messages)).not.toContain('"included":true');
    });

    it('re-including the RESULT entry emits the real answer again while the request entry stays out', async () => {
        // The mirror image of the case above, and the per-entry half of the reversibility
        // contract: each member is restored by its own write, one at a time.
        const seed = seededTranscript();
        seed[2].included = false;
        seed[3].included = false;

        const { writer, seen } = await controlRun({
            seed,
            plugins: [turnBeforePlugin('re-enable-result', (context) => context.setIncluded(3, true))]
        });

        // The request entry is still off, so no block is emitted; the answer is back and
        // rides on alone.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual(['orphan tool#2: c1']);
        expect(seen[0].some((message) => message.content === withheldContent('c1', 'alpha'))).toBe(false);

        // Only the entry the hook named lost its key.
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
        });
        expect(withoutIds(writer.agent.messages[3])).toStrictEqual({
            role: 'tool',
            content: 'A',
            toolCallId: 'c1',
            name: 'alpha'
        });
    });

    it('takes both entries through two writes for whole-unit exclusion, byte-for-byte as one cascading write did', async () => {
        // A plugin that wants the WHOLE call gone (compaction is the real caller) gets it
        // by writing every member — the same projection the old cascading `setIncluded`
        // produced from one write, and now an explicit one-write-per-entry contract
        // (src/plugins/context-compaction.plugin.ts is that caller).
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('exclude-both', (context) => {
                    context.setIncluded(2, false);
                    context.setIncluded(3, false);
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
        expect(carriesFlag(seen[0])).toBe(false);
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(2);
    });

    it('suppresses a pending placeholder when the hook switches off its request entry on that same request', async () => {
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
                    // Turn 3 re-reads the ENTRY states through `entries` (captured inside
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

        // The exclusion keeps holding once the real result lands, and the entry that
        // arrived later was never flagged itself: it rides on, orphaned, beside the
        // answer of the round that waited for it.
        expect(seen[2]).toStrictEqual([
            { role: 'user', content: 'go' },
            { role: 'tool', content: 'A-done', toolCallId: 'a1', name: 'alpha' },
            { role: 'assistant', content: 'waiting' }
        ]);
        expect(pairIssues(seen[2])).toEqual(['orphan tool#1: a1']);
        expect(includedAtRound3).toEqual([true, false, true, true]);
        expect(withoutIds(writer.agent.messages[1])).toStrictEqual({
            role: 'assistant',
            content: '',
            included: false,
            toolCalls: [{ id: 'a1', name: 'alpha', arguments: '{}' }]
        });
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
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
        expect(withoutIds(first.writer.agent.messages[1])).toStrictEqual({
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
                        requestBefore: entries[2].included,
                        resultBefore: entries[3].included
                    };

                    context.setIncluded(entries[1], false);
                    // The SAME entry object, re-read: live, not a stale snapshot.
                    observations.questionAfterSelf = entries[1].included;
                    // An unrelated entry is unaffected by that write.
                    observations.otherEntryStillOn = entries[2].included;

                    // Targeting a RESULT moves ONLY that entry (R8): the owning assistant
                    // re-reads its own verdict, which the write never touched.
                    context.setIncluded(entries[3], false);
                    observations.assistantAfterResult = entries[2].included;
                    observations.resultAfterResult = entries[3].included;
                })
            ]
        });

        expect(withoutIds(observations)).toEqual({
            questionBefore: true,
            requestBefore: true,
            resultBefore: true,
            questionAfterSelf: false,
            otherEntryStillOn: true,
            assistantAfterResult: true,
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
                        // A STRING is a transcript address now (context T1.5), so this
                        // is no longer a shape error: it is an id that names nothing, and
                        // the refusal says so with the same cure the stale entry names.
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
            'turn.before setIncluded received a stale messageId "1": no entry with that id is in the transcript. Read `entries` again after `replaceHistory()`.',
            'turn.before setIncluded needs a transcript index, an entry from this turn, or a messageId.'
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
        expect(withoutIds(replacedOnly.writer.agent.messages)).toStrictEqual([
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

        expect(withoutIds(rebuilt.seen[0])).toStrictEqual([{ role: 'user', content: 'kept' }]);
        expect(withoutIds(rebuilt.writer.agent.messages)).toStrictEqual([
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
        expect(withoutIds(shifted.writer.agent.messages)).toStrictEqual([
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
        expect(withoutIds(snapshot.agents.writer.messages[1])).toStrictEqual({
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
        // exactly ONE ENTRY is off — the write names one entry, and its result keeps
        // riding (R8).
        expect(applied.slice(0, 6)).toEqual([true, true, true, true, true, true]);
        expect(applied.slice(6)).toEqual([true, true, false, true, true, true]);

        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual(['orphan tool#2: c1']);
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(1);
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
        expect(withoutIds(oneSeed.writer.agent.messages[0])).toStrictEqual({
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

        expect(withoutIds(withheld.seen[0])).toStrictEqual([{ role: 'user', content: 'go' }]);
        expect(withoutIds(withheld.writer.agent.messages[0])).toStrictEqual({
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
        expect(withoutIds(first.writer.agent.messages[1])).toStrictEqual({
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
        expect(withoutIds(second.seen[0])).toStrictEqual(a.afterOverride);
        // The flag write is still a CONVERSATION change even though the override decided
        // this request.
        expect(withoutIds(second.writer.agent.messages[1])).toStrictEqual({
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
        expect(withoutIds(writer.agent.messages[1])).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false
        });

        // The handler threw AFTER its write: fail-open swallowed the rejection, the run
        // still committed its answer, and the flag the handler wrote survived the throw
        // (a hook error never rolls back a canonical write it already made).
        expect(withoutIds(writer.agent.messages[writer.agent.messages.length - 1])).toStrictEqual({
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

// ---------------------------------------------------------------------------
// 8 — pipeline T3: `context.edit`, the SECOND mutation primitive, and the branch
//     discriminator (pipeline T3.4 / context T8 — one change, one landing)
// ---------------------------------------------------------------------------

// Canonical state, as BYTES, read from inside a handler through the entries the round
// issued (an entry's `message` IS the canonical object). `edit`'s all-or-nothing rule is
// only worth having if a refusal can be proven to have changed nothing at all, so every
// refusal test takes this before and after the attempts and compares them — the edit
// sibling of the `setIncluded` tests' "changing nothing" assertions, one level stricter.
const canonicalBytes = (context: HarnessTurnBeforeContext): string =>
    JSON.stringify(context.entries.map((entry) => entry.message));

// One user turn, rewritten — the shape every edit test below asserts against. Written
// out rather than derived from `seededRequest` so a placement bug cannot hide behind a
// shared transformation of the expected value.
const EDITED_SEED_REQUEST: HarnessMessage[] = [
    { role: 'system', content: 'Write.' },
    { role: 'user', content: 'edited question' },
    {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
    },
    { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
    { role: 'assistant', content: 'answered' },
    { role: 'user', content: 'go' }
];

describe('context control — entry editing (pipeline T3)', () => {
    it('edits one user entry in place, and the SAME request carries the new text', async () => {
        const changes: HarnessStateChangeEvent[] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('editor', (context) => {
                    context.edit(entryWith(context, 'question'), { content: 'edited question' });
                })
            ],
            stateChanges: changes
        });

        // T3.1/T3.2: an edit is a CANONICAL write, so the round that made it is
        // re-projected and the provider receives the new text on THIS request — the same
        // seep `setIncluded` has, with no `setTranscript` involved.
        expect(seen[0]).toStrictEqual(EDITED_SEED_REQUEST);

        // Canonical history: same entries, same positions, only that one entry's text
        // different. No `included` key appeared, and nothing else moved.
        expect(withoutIds(writer.agent.messages)).toStrictEqual([
            ...EDITED_SEED_REQUEST,
            { role: 'assistant', content: 'settled' }
        ]);

        // ONE persistence notification for ONE edit, and it is the transcript-change
        // reason every other canonical write reports: the run's own user append, then the
        // edit, then the committed answer.
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);

        // Read-your-writes through the live view: the handler's own write is already in
        // `currentMessages()`, while `messages` stays what it was entered with.
        const views: Array<{ atEntry: string; live: string }> = [];
        await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('view-check', (context) => {
                    const atEntry = JSON.stringify(context.messages);
                    context.edit(entryWith(context, 'question'), { content: 'edited question' });
                    views.push({ atEntry, live: JSON.stringify(context.currentMessages()) });
                })
            ]
        });

        expect(JSON.parse(views[0].atEntry)).toStrictEqual(seededRequest('go'));
        expect(JSON.parse(views[0].live)).toStrictEqual(EDITED_SEED_REQUEST);
    });

    it('edits a tool result content while its pairing keys stay exactly as they were', async () => {
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('result-editor', (context) => {
                    const result = entryWith(context, 'A');

                    // T3.1: content is what a result may change. An edit moves ONLY this
                    // entry's text — R8 made every write one entry deep, and an edit
                    // could not move a pairing key even when the runtime did cascade.
                    context.edit(result, { content: 'rewritten result' });
                })
            ]
        });

        const request = seen[0];
        expect(request).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
            },
            { role: 'tool', content: 'rewritten result', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        // The provider pairing oracle stays empty, and the unit is still in request.
        expect(pairIssues(request)).toEqual([]);
        expect(request.filter((message) => message.role === 'tool')).toHaveLength(1);

        // The canonical result object keeps its EXACT key set and order — an assignment
        // to an existing field, not a rebuild. That is what lets an edit add no key to the
        // snapshot and branch whitelists (T3.6); the one extra name below is the address
        // the insertion minted (context T1.2), which is the only key T1 added anywhere.
        const canonical = writer.agent.messages[3];
        expect(Object.keys(canonical)).toEqual([
            'role',
            'content',
            'toolCallId',
            'name',
            'messageId'
        ]);
        expect(canonical).toStrictEqual({
            role: 'tool',
            content: 'rewritten result',
            toolCallId: 'c1',
            name: 'alpha',
            // The tool result is the fourth canonical entry of this transcript, so its id
            // is the fourth minted (src/core/message-id.ts counts per transcript).
            messageId: 'msg-4'
        });
    });

    it('edits an assistant turn\'s text and reasoning, and refuses reasoning on every other role', async () => {
        const failures: string[] = [];
        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('answer-editor', (context) => {
                    context.edit(entryWith(context, 'answered'), {
                        content: 're-worded answer',
                        reasoning: 'thoughts, edited'
                    });

                    // `reasoning` is an assistant field and the snapshot/branch
                    // whitelists list it for that role ONLY, so writing it anywhere else
                    // would produce a transcript that no longer restores.
                    for (const content of ['question', 'Write.', 'A']) {
                        try {
                            context.edit(entryWith(context, content), { reasoning: 'nope' });
                        } catch (error) {
                            failures.push((error as Error).message);
                        }
                    }
                })
            ]
        });

        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 're-worded answer', reasoning: 'thoughts, edited' },
            { role: 'user', content: 'go' }
        ]);

        // The assistant-with-toolCalls entry is untouched (no reasoning was named on it),
        // and the plain assistant gained the key the assistant whitelist already carries.
        expect(withoutIds(writer.agent.messages[4])).toStrictEqual({
            role: 'assistant',
            content: 're-worded answer',
            reasoning: 'thoughts, edited'
        });
        expect(Object.keys(writer.agent.messages[4])).toEqual([
            'role',
            'content',
            'messageId',
            'reasoning'
        ]);

        expect(failures).toEqual([
            'turn.before edit cannot change `reasoning` on a user message: only an assistant message carries reasoning, and no other role whitelists it.',
            'turn.before edit cannot change `reasoning` on a system message: only an assistant message carries reasoning, and no other role whitelists it.',
            'turn.before edit cannot change `reasoning` on a tool message: only an assistant message carries reasoning, and no other role whitelists it.'
        ]);
    });

    it('refuses every patch that is not text, before writing a single byte', async () => {
        const failures: string[] = [];
        let bytesBefore = '';
        let bytesAfter = '';

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('refusals', (context) => {
                    const assistant = entryWith(context, 'answered');
                    const result = entryWith(context, 'A');
                    const question = entryWith(context, 'question');

                    // Shaped like a real entry, but never handed out by this round.
                    const foreign = {
                        index: 0,
                        message: { role: 'user', content: 'elsewhere' },
                        included: true
                    } as HarnessContextEntry;

                    bytesBefore = canonicalBytes(context);

                    const attempts: Array<() => void> = [
                        // Pairing keys on a tool result (T3.1).
                        () => context.edit(result, { toolCallId: 'c2' } as unknown as HarnessContextEditPatch),
                        () => context.edit(result, { name: 'beta' } as unknown as HarnessContextEditPatch),
                        // Structure: tool-call membership is what the unit resolver keys on.
                        () => context.edit(assistant, { toolCalls: [] } as unknown as HarnessContextEditPatch),
                        () => context.edit(question, { role: 'system' } as unknown as HarnessContextEditPatch),
                        () => context.edit(question, { attachments: [] } as unknown as HarnessContextEditPatch),
                        // The other axis of context control, with its own control.
                        () => context.edit(question, { included: false } as unknown as HarnessContextEditPatch),
                        // Not text.
                        () => context.edit(question, { content: 12 as unknown as string }),
                        () => context.edit(question, { content: null as unknown as string }),
                        () => context.edit(question, { content: undefined }),
                        // An empty patch names nothing to change.
                        () => context.edit(question, {}),
                        // Not a patch.
                        () => context.edit(question, 're-worded' as unknown as { content: string }),
                        () => context.edit(question, null as unknown as { content: string }),
                        () => context.edit(question, [{ content: 'x' }] as unknown as { content: string }),
                        // A fabricated entry, and one this round never issued.
                        () => context.edit(foreign, { content: 'x' }),
                        () => context.edit(42 as unknown as HarnessContextEntry, { content: 'x' })
                    ];

                    for (const attempt of attempts) {
                        try {
                            attempt();
                        } catch (error) {
                            failures.push((error as Error).message);
                        }
                    }

                    bytesAfter = canonicalBytes(context);
                })
            ]
        });

        expect(failures).toEqual([
            'turn.before edit cannot change `toolCallId` on a tool message: the call id pairs this result with its assistant block; changing it re-pairs the transcript by hand.',
            'turn.before edit cannot change `name` on a tool message: the tool name is part of the call identity the transport re-emits.',
            'turn.before edit cannot change `toolCalls` on an assistant message: a patch may not change tool-call membership — unit resolution and provider pairing both key on call ids.',
            'turn.before edit cannot change `role` on a user message: a role is not text; a patch cannot turn one entry into another.',
            'turn.before edit cannot change `attachments` on a user message: attachments are validated bytes, not text.',
            'turn.before edit cannot change `included` on a user message: inclusion is a different axis and switches ONE entry at a time; use setIncluded.',
            'turn.before edit needs a string for `content` on a user message; received 12.',
            'turn.before edit needs a string for `content` on a user message; received null.',
            'turn.before edit needs a string for `content` on a user message; received undefined.',
            'turn.before edit received an empty patch; name at least one editable field (content).',
            'turn.before edit needs a patch object for entry 1; received "re-worded".',
            'turn.before edit needs a patch object for entry 1; received null.',
            'turn.before edit needs a patch object for entry 1; received [{"content":"x"}].',
            'turn.before edit received an entry that does not belong to this turn.',
            'turn.before edit needs an entry from this turn.'
        ]);

        // THE POINT OF THE ORDERING: fifteen refusals, zero bytes of change. The
        // comparison is on the RAW document (addresses included), which is the strictest
        // form of "nothing moved".
        expect(bytesAfter).toBe(bytesBefore);
        expect(withoutIds(JSON.parse(bytesAfter))).toEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }]
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);

        // And the request the round went out with is the untouched projection.
        expect(seen[0]).toStrictEqual(seededRequest('go'));
        expect(writer.agent.messages.filter((message) => 'included' in message)).toHaveLength(0);
    });

    it('refuses an entry made stale by replaceHistory, exactly like setIncluded does', async () => {
        const failures: string[] = [];

        await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('stale-editor', (context) => {
                    const stale = entryWith(context, 'question');
                    context.replaceHistory([
                        { role: 'user', content: 'kept' },
                        { role: 'user', content: 'dropped' }
                    ]);

                    try {
                        context.edit(stale, { content: 'written where?' });
                    } catch (error) {
                        failures.push((error as Error).message);
                    }

                    // The rewritten transcript is addressable, because a LATER read of
                    // `entries` sees the replacement — the documented cure.
                    context.edit(entryWith(context, 'dropped'), { content: 'dropped, edited' });
                })
            ]
        });

        expect(failures).toEqual([
            'turn.before edit received a stale entry (index 1): its message is no longer in the transcript. Read `entries` again after `replaceHistory()`.'
        ]);
    });
});

describe('context control — the branch discriminator (pipeline T3.4 / context T8)', () => {
    it('names a fork round differently from a root round while threadId stays equal, and a branch edit reports no notification', async () => {
        vi.useFakeTimers();

        // Same routing convention as the branch test above (a branch shares its source's
        // transport, so requests are routed by content) and the same drain budget.
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
        const settle = async (): Promise<void> => {
            for (let pass = 0; pass < 32; pass += 1) {
                await vi.advanceTimersByTimeAsync(0);
                await Promise.resolve();
            }
        };

        // A round is the branch's own when its transcript holds the `created-branch`
        // placeholder for the still-pending fork call — content the root never carries.
        // The discriminator under test is then checked AGAINST that ground truth, which is
        // why this test does not need branch ids to be predictable.
        const isBranchRound = (context: HarnessTurnBeforeContext): boolean =>
            context.entries.some((entry) => entry.message.content.includes('created-branch'));

        const runFork = async (withPlugin: boolean) => {
            const seen: HarnessMessage[][] = [];
            const changes: HarnessStateChangeEvent[] = [];
            const contexts: HarnessTurnBeforeContext[] = [];

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
                              turnBeforePlugin('branch-editor', (context) => {
                                  contexts.push(context);

                                  if (!isBranchRound(context)) return;

                                  // A branch owns an ephemeral copy, so the same control
                                  // surface applies there — and it is the copy the branch
                                  // request is projected from.
                                  context.edit(entryWith(context, 'root input'), {
                                      content: 'branch-edited root input'
                                  });
                              })
                          ]
                      }
                    : {}),
                report: { stateChange: (event: HarnessStateChangeEvent) => void changes.push(event) }
            });

            await writer('root input');
            await settle();

            return { seen, changes, contexts, writer };
        };

        const plain = await runFork(false);
        const edited = await runFork(true);

        const branchContexts = edited.contexts.filter(isBranchRound);
        const rootContexts = edited.contexts.filter((context) => !isBranchRound(context));

        // One fork round, two root rounds (the fork request and the final one).
        expect(branchContexts).toHaveLength(1);
        expect(rootContexts).toHaveLength(2);

        const [rootContext] = rootContexts;
        const [branchContext] = branchContexts;

        // (1) `threadId` STILL means the spawning conversation: identical on both rounds,
        //     which is exactly the trap F11/T3.4 named. Its meaning did not change.
        expect(branchContext.threadId).toBe(rootContext.threadId);

        // (2) A root round is the registered agent's own scheduling key, and carries NO
        //     branch id at all — the key is absent, not `branchId: undefined`.
        expect(rootContext.actorKey).toBe('writer');
        expect('branchId' in rootContext).toBe(false);
        expect(rootContext.branchId).toBeUndefined();

        // (3) The fork round reports `branch:<id>` and the branch's own id, and that id is
        //     the same one the harness's branch record names — exposure, not invention.
        expect(branchContext.branchId).toBeDefined();
        expect(branchContext.actorKey).toBe(`branch:${branchContext.branchId}`);
        expect(edited.writer.branches()[0].branchId).toBe(branchContext.branchId);

        // (4) The two rounds are distinguishable by the discriminator alone: a policy that
        //     must not touch a transcript that is about to be incorporated can now say so.
        expect(branchContext.actorKey).not.toBe(rootContext.actorKey);

        // (5) The branch edit landed on the branch's OWN request.
        const branchRequest = edited.seen.find((messages) => lastUser(messages) === 'inspect');
        const plainRequest = plain.seen.find((messages) => lastUser(messages) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(plainRequest).toBeDefined();
        expect(branchRequest!.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
        expect(branchRequest![0]).toStrictEqual({
            role: 'user',
            content: 'branch-edited root input'
        });
        expect(branchRequest!.some((message) => message.content === 'root input')).toBe(false);
        expect(pairIssues(branchRequest!)).toEqual([]);

        // (6) T3.6: a branch write is EPHEMERAL and SILENT. The source conversation and
        //     its snapshot never saw the edit, and the state-change stream is what the
        //     plugin-less run reported — one notification fewer than the root round's own
        //     writes would have added.
        expect(
            edited.writer.agent.messages.filter((message) => message.content === 'branch-edited root input')
        ).toHaveLength(0);
        expect(edited.writer.agent.messages.some((message) => message.content === 'root input')).toBe(true);
        expect(JSON.stringify(edited.writer.snapshot())).not.toContain('branch-edited root input');
        expect(withoutBranchIds(changesOf(edited.changes))).toBe(withoutBranchIds(changesOf(plain.changes)));
    });
});

// ---------------------------------------------------------------------------
// 8 — stable transcript addresses (context T1)
// ---------------------------------------------------------------------------
//
// The flag write needs an address that OUTLIVES the round that wrote it. Stage 1
// shipped two, and both are round-scoped: a numeric index is re-read against the
// CURRENT transcript, and `replaceHistory()` replaces the message identities a held
// entry depends on. `messageId` is the third (F1/T1), and it is an ADDITIONAL target:
// index and entry resolution stay exactly as they were, because they are shipped,
// tested behaviour.
//
// Contract pinned below:
//   - ONE id per canonical entry, minted where the message is created
//     (`msg-<n>` per transcript, in creation order — src/core/message-id.ts);
//   - never re-minted on a copy: a projection, a fork and a snapshot carry or drop the
//     id, they do not invent one;
//   - NEVER in a provider request: `withIncluded` strips it with the flag, so the wire
//     and the `turn.before` `messages` view are exactly what they were before ids;
//   - `entries` expose it, `setIncluded` accepts it, and a stale/blank id is refused in
//     the same loud style as a stale entry, naming the cure.

describe('context inclusion — stable transcript addresses (context T1)', () => {
    it('mints one address per canonical entry in creation order, and keeps it out of every request', async () => {
        const { writer, seen } = await settledRun();

        // The whole transcript of `settledRun`: the prompt, the answered tool unit,
        // and the final answer — four canonical creations, four minted addresses, in
        // creation order. Exact, because the runtime counts per transcript and nothing
        // else: no process-global counter is involved (src/core/message-id.ts header).
        expect(writer.agent.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3',
            'msg-4'
        ]);

        // THE PROVIDER NEVER SEES AN ADDRESS. Every projected copy goes through
        // `withIncluded` (src/core/agent.ts), which strips `messageId` exactly as it
        // strips the flag, so a custom transport gets the same flag-free, id-free data
        // it got before either feature existed — and R3's byte-identical default path
        // survives the new field.
        expect(JSON.stringify(seen)).not.toContain('messageId');
        expect(JSON.stringify(seen)).not.toContain('included');
        expect(seen.map(shape)).toEqual([
            ['user:go'],
            ['user:go', 'assistant::a1', 'tool:a1:A']
        ]);
        expect(seen.map(pairIssues)).toEqual([[], []]);

        // Every canonical entry carries one, and no entry carries a second spelling.
        expect(writer.agent.messages.filter((message) => message.messageId !== undefined)).toHaveLength(4);
        expect(JSON.stringify(writer.agent.messages)).not.toContain('messageId":undefined');
    });

    it('addresses the same turn by id in a LATER round of one conversation', async () => {
        let questionId = '';
        const rounds: string[][] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('address-by-id', (context) => {
                    rounds.push(context.entries.map((entry) => entry.messageId ?? '-'));

                    if (questionId === '') {
                        // Round one only LEARNS the address of the seeded user turn.
                        questionId = entryWith(context, 'question').messageId ?? '';

                        return;
                    }

                    // Round two acts on it: not the index (the transcript grew), and not
                    // the message object (this handler never held one).
                    context.setIncluded(questionId, false);
                })
            ]
        });

        await writer('again');

        // The address is the second canonical entry — the seeded instruction is first.
        expect(questionId).toBe('msg-2');

        // Round 1 saw the seeded five plus the run's own prompt (minted by
        // `agent.user`, src/core/agent.ts `appendUser`); round 2 additionally sees round
        // 1's committed answer and its own prompt. Both lists are exact.
        expect(rounds).toEqual([
            ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6'],
            ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6', 'msg-7', 'msg-8']
        ]);

        // The first request carried the turn; the second one does not, and nothing else
        // moved — the id named the SAME unit in a round that had never seen the entry.
        expect(seen[0]).toStrictEqual(seededRequest('go'));
        expect(seen[1]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' },
            { role: 'user', content: 'again' }
        ]);
        expect(pairIssues(seen[1])).toEqual([]);
        expect(carriesFlag(seen[1])).toBe(false);

        // Canonical history still holds the turn, flagged, with its address unchanged.
        expect(writer.agent.messages[1]).toStrictEqual({
            role: 'user',
            content: 'question',
            included: false,
            messageId: 'msg-2'
        });
        expect(writer.agent.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3',
            'msg-4',
            'msg-5',
            'msg-6',
            'msg-7',
            'msg-8',
            'msg-9'
        ]);
    });

    it('keeps an id addressable across replaceHistory, while the entry object it replaced is refused', async () => {
        const outcomes: string[] = [];

        const { writer } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('replace-then-address', (context) => {
                    const question = entryWith(context, 'question');
                    const questionId = question.messageId ?? '';

                    // A compactor's usual move: rewrite the list from the entries it is
                    // holding. The replacement is validated through the snapshot reader,
                    // which COPIES the entries and carries their addresses (T1.3) — so
                    // the ids survive and the object identities do not.
                    context.replaceHistory(context.entries.map((entry) => entry.message));

                    try {
                        context.setIncluded(question, false);
                        outcomes.push('entry: accepted');
                    } catch (error) {
                        outcomes.push(`entry: ${(error as Error).message}`);
                    }

                    try {
                        context.setIncluded(questionId, false);
                        outcomes.push('id: accepted');
                    } catch (error) {
                        outcomes.push(`id: ${(error as Error).message}`);
                    }

                    for (const [label, target] of [
                        ['missing', 'msg-99'],
                        ['blank', '   ']
                    ] as const) {
                        try {
                            context.setIncluded(target, false);
                            outcomes.push(`${label}: accepted`);
                        } catch (error) {
                            outcomes.push(`${label}: ${(error as Error).message}`);
                        }
                    }
                })
            ]
        });

        expect(outcomes).toEqual([
            'entry: turn.before setIncluded received a stale entry (index 1): its message is no longer in the transcript. Read `entries` again after `replaceHistory()`.',
            'id: accepted',
            'missing: turn.before setIncluded received a stale messageId "msg-99": no entry with that id is in the transcript. Read `entries` again after `replaceHistory()`.',
            'blank: turn.before setIncluded needs a non-empty messageId; received an empty string.'
        ]);

        // The accepted id write landed on the REPLACED transcript, on that entry alone,
        // and the addresses themselves are unchanged — the whole point of the field.
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question', included: false },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }] },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' }
        ]);
        expect(writer.agent.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3',
            'msg-4',
            'msg-5',
            'msg-6',
            'msg-7'
        ]);
    });

    it('keeps `edit` entry-addressed, refuses a patch that rewrites an address, and writes nothing', async () => {
        const outcomes: string[] = [];

        const { writer, seen } = await controlRun({
            seed: seededTranscript(),
            plugins: [
                turnBeforePlugin('id-shape', (context) => {
                    const question = entryWith(context, 'question');

                    // (1) `edit` stays ENTRY-addressed (pipeline T3): an edit rewrites the
                    // text of ONE specific entry, and the stage's own finding is that a
                    // bare number is unreliable against a moving transcript. A bare id is
                    // therefore a shape error here, not a second spelling of the control —
                    // only `setIncluded` grew the id target (T1.5).
                    try {
                        context.edit(question.messageId as unknown as HarnessContextEntry, {
                            content: 'edited'
                        });
                        outcomes.push('id as entry: accepted');
                    } catch (error) {
                        outcomes.push(`id as entry: ${(error as Error).message}`);
                    }

                    // (2) An address is not text. A plugin that re-worded one would
                    // silently re-point every later `setIncluded(id, …)`.
                    try {
                        context.edit(question, { messageId: 'msg-9' } as unknown as HarnessContextEditPatch);
                        outcomes.push('messageId patch: accepted');
                    } catch (error) {
                        outcomes.push(`messageId patch: ${(error as Error).message}`);
                    }
                })
            ]
        });

        expect(outcomes).toEqual([
            'id as entry: turn.before edit needs an entry from this turn.',
            "messageId patch: turn.before edit cannot change `messageId` on a user message: the messageId is this entry's address, not its text; the runtime mints and copies it."
        ]);

        // Both refusals wrote nothing: the request went out as the plain projection, and
        // no entry was switched off.
        expect(seen[0]).toStrictEqual(seededRequest('go'));
        expect(writer.agent.messages.some((message) => message.included === false)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 9 — the live size of the request (context T5)
// ---------------------------------------------------------------------------

describe('context inclusion — the entry-time and live context estimates (context T5)', () => {
    it('keeps `estimatedTokens` entry-time and reports the savings through currentEstimatedTokens()', async () => {
        const record: Record<string, unknown> = {};
        let late: HarnessTurnBeforeContext | undefined;

        const { writer, seen } = await controlRun({
            seed: [
                { role: 'system', content: 'Write.' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'answered' }
            ],
            plugins: [
                turnBeforePlugin('estimate-views', (context) => {
                    if (Object.keys(record).length > 0) return;

                    // Kept so the round can be re-read AFTER it closed: the live accessor
                    // must answer about the request the round SENT, not about whatever the
                    // transcript looks like now.
                    late = context;

                    // The projection at entry is 24 characters of counted text — 6 + 8 +
                    // 8 + the run's own 2-character prompt — and src/core/context-estimate
                    // .ts is `ceil(chars / 4)`, so 6. Nothing has been written yet, so the
                    // live accessor answers the same number.
                    record.entryBefore = context.estimatedTokens;
                    record.liveBefore = context.currentEstimatedTokens();
                    record.listBefore = context.currentMessages().length;
                    record.staticListBefore = context.messages.length;

                    const question = entryWith(context, 'question');
                    context.setIncluded(question.messageId ?? '', false);

                    // ENTRY-TIME, DELIBERATELY (F7/T5 option b): the number the shipped
                    // compactor compares against its limit and its cooldown map does NOT
                    // move underneath it, so a pass can never trigger on a transcript it
                    // never measured.
                    record.entryAfter = context.estimatedTokens;
                    record.staticListAfter = context.messages.length;

                    // ...and the live accessor is the same estimator over the same list
                    // `currentMessages()` returns: 16 characters now, so 4. The write saved
                    // exactly 2 tokens by this measure, which is what a minimum-savings
                    // floor needs to see in the handler that made the write.
                    record.liveAfter = context.currentEstimatedTokens();
                    record.listAfter = context.currentMessages().length;
                })
            ]
        });

        expect(record).toEqual({
            entryBefore: 6,
            liveBefore: 6,
            listBefore: 4,
            staticListBefore: 4,
            entryAfter: 6,
            staticListAfter: 4,
            liveAfter: 4,
            listAfter: 3
        });

        // AFTER THE ROUND, both live accessors are frozen to what the round DECIDED — the
        // same rule `currentMessages()` already follows, and the reason the live number is
        // still useful to a late reader (a parked context, a test inspecting one after the
        // run). The run has since committed its answer, so the canonical transcript is FIVE
        // entries and a naive re-projection now would measure four; this answers three
        // entries and 4 tokens, exactly the request that went out.
        expect(late?.currentMessages()).toHaveLength(3);
        expect(late?.currentEstimatedTokens()).toBe(4);
        expect(late?.estimatedTokens).toBe(6);
        expect(writer.agent.messages).toHaveLength(5);

        // The provider received the live view, not the entry-time one: the disabled turn
        // is absent, and neither the flag nor an address rides along.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(JSON.stringify(seen[0])).not.toContain('included');
        expect(JSON.stringify(seen[0])).not.toContain('messageId');
    });
});

// ---------------------------------------------------------------------------
// 10 — host hygiene for a submitted `included: true` (context T6)
// ---------------------------------------------------------------------------
//
// T6.1 keeps the shipped behaviour: an entry point that accepts WHOLE messages
// normalizes a submitted `included: true` to the absent form instead of rejecting it,
// because rejecting would break a host that round-trips its own JSON (a transcript
// document read back and written again). T6.2 records that read-side normalization is
// NOT added to `threadMessages()`: the read surface shows canonical state, and
// `entries` must keep showing the canonical object. One test per accepted entry point,
// each asserting the same two things: canonical state carries no `true`, and the host
// read surface never shows one either.

describe('context inclusion — a submitted `included: true` never reaches state or the read surface (context T6)', () => {
    it('normalizes a seeded `true` in canonical state and in threadMessages()', async () => {
        const { writer } = await controlRun({
            seed: [
                { role: 'user', content: 'seed on', included: true },
                { role: 'user', content: 'seed off', included: false }
            ]
        });

        const expected = [
            { role: 'user', content: 'seed on', messageId: 'msg-1' },
            { role: 'user', content: 'seed off', included: false, messageId: 'msg-2' },
            { role: 'user', content: 'go', messageId: 'msg-3' },
            { role: 'assistant', content: 'settled', messageId: 'msg-4' }
        ];

        // `true` is dropped, `false` is kept verbatim, and the caller's own objects were
        // not touched (core/agent.ts `withIncluded`, pinned at the seed boundary).
        expect(writer.agent.messages).toStrictEqual(expected);
        expect(writer.threadMessages('agent:writer')).toStrictEqual(expected);
        expect(JSON.stringify(writer.threadMessages('agent:writer'))).not.toContain('"included":true');
    });

    it('normalizes a `true` submitted through setThreadMessages, in state and in the read', () => {
        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream: scripted([answer('unused')], []) }) },
            presets: false
        });

        writer.setThreadMessages('agent:writer', [
            { role: 'user', content: 'replaced on', included: true },
            { role: 'user', content: 'replaced off', included: false }
        ]);

        const stored = writer.threadMessages('agent:writer');

        expect(stored).toStrictEqual([
            { role: 'user', content: 'replaced on', messageId: 'msg-1' },
            { role: 'user', content: 'replaced off', included: false, messageId: 'msg-2' }
        ]);

        // A replaced transcript is a NEW conversation state, so the reader mints its
        // addresses from the top of the new list (context T1.3).
        expect(JSON.stringify(stored)).not.toContain('"included":true');
        expect(writer.agent.messages[0]).not.toHaveProperty('included');
    });

    it('normalizes a `true` submitted through the lane append seam, and gives the appended entry an unused address', async () => {
        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream: scripted([answer('unused')], []) }) },
            presets: false
        });

        writer.setThreadMessages('agent:writer', [{ role: 'user', content: 'base', messageId: 'msg-7' }]);

        // The append is the one host write that delivers a SLICE, so the reader mints
        // against the WHOLE transcript: the appended entry cannot be given an address the
        // conversation already owns (core/snapshot.ts `readHarnessMessages`).
        const appended = writer.appendThreadMessages(
            'agent:writer',
            [{ role: 'user', content: 'appended on', included: true }],
            1
        );

        expect(appended).toStrictEqual([
            { role: 'user', content: 'base', messageId: 'msg-7' },
            { role: 'user', content: 'appended on', messageId: 'msg-8' }
        ]);
        expect(writer.threadMessages('agent:writer')).toStrictEqual(appended);
        expect(JSON.stringify(writer.snapshot().agents.writer.messages)).not.toContain('"included":true');

        // The submitted id is honoured, not renumbered — a copy keeps its identity.
        await Promise.resolve();
    });

    it('leaves a hand-written `true` on a direct canonical edit visible to the read surface — the recorded T6.2 decision', async () => {
        const { writer, seen } = await settledRun();

        // The path the contract already disclaims: `agent.messages` is public and
        // mutable, and the state-change observer cannot see a direct edit
        // (`HarnessStateChangeEvent`). T6.2 DECIDES not to normalize on READ: nothing
        // rewrites this key on the way out, so `entries` and `threadMessages()` keep
        // showing exactly what canonical state holds.
        writer.agent.messages[0].included = true;

        expect(writer.threadMessages('agent:writer')[0]).toStrictEqual({
            role: 'user',
            content: 'go',
            included: true,
            messageId: 'msg-1'
        });

        // ...while the model-facing surfaces stay clean: the projection strips the key
        // (core/agent.ts `withIncluded`), and the snapshot reader normalizes it
        // (core/snapshot.ts `applyIncluded`), so the value cannot survive a restart.
        await writer('again');
        const last = seen[seen.length - 1];
        expect(carriesFlag(last)).toBe(false);
        expect(JSON.stringify(writer.snapshot().agents.writer.messages)).not.toContain('"included":true');

        // The rule a host has to keep (T6.3), stated in the type comment and README: the
        // storage form is "only `false`", so a persisted copy OMITS the key.
        expect(writer.snapshot().agents.writer.messages[0]).toStrictEqual({
            role: 'user',
            content: 'go',
            messageId: 'msg-1'
        });
    });
});

// ---------------------------------------------------------------------------
// Context T4 / compaction T4.4 — notification coalescing at the round boundary.
//
// `agent_message` is the ONLY durability mechanism a plugin's flag write has, and the
// server turns each one into a whole-document atomic rewrite (src/server/persistence.ts).
// So N writes from ONE `turn.before` round must become ONE report, or a 40-unit compaction
// costs 40 saves for one logical change.
//
// Three properties are pinned together, and each one is a hazard on its own:
//   * BATCHING — three flag writes in one round report once (and all three flags are still
//     in canonical state; coalescing the report must never coalesce the WRITE);
//   * COMPLETENESS — the batch also covers a flag write plus an entry edit, because both
//     move the same transcript and the same document save covers both;
//   * THE HOST PLANE IS UNTOUCHED — a host transcript write (`setThreadMessages`) is still
//     one write, one report: the batching window is a plugin round, not a time window, and
//     no debounce may ever delay a durability report across a run boundary (context T4.3).
// ---------------------------------------------------------------------------

describe('context inclusion — one persistence report per plugin round (context T4 / compaction T4.4)', () => {
    // Three standalone turns, so a plugin can disable exactly three units and nothing else
    // moves. The run's own writes are the baseline every count below subtracts.
    const threeTurnSeed = (): HarnessMessage[] => [
        { role: 'system', content: 'Write.' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'user', content: 'third' },
        { role: 'assistant', content: 'answered' }
    ];

    it('reports a three-unit flag write ONCE, with all three flags persisted', async () => {
        const changes: HarnessStateChangeEvent[] = [];

        const { writer, seen } = await controlRun({
            seed: threeTurnSeed(),
            plugins: [
                turnBeforePlugin('batcher', (context) => {
                    // Three writes in the order a real policy performs them: an index, a
                    // messageId, and a live entry — the batching point must not care how the
                    // unit was addressed.
                    context.setIncluded(1, false);
                    context.setIncluded('msg-3', false);
                    context.setIncluded(context.entries[3], false);
                })
            ],
            stateChanges: changes
        });

        // THREE writes, ONE report. The three events below are the run's own user append,
        // the round's single coalesced transcript change, and the committed answer. A
        // per-write notifier would have produced five.
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);

        // Coalescing the REPORT never coalesces the WRITE: every named unit is disabled in
        // canonical state, which is what a snapshot and the next round read.
        expect(withoutIds(writer.agent.messages)).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'first', included: false },
            { role: 'user', content: 'second', included: false },
            { role: 'user', content: 'third', included: false },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' }
        ]);

        // The provider request for the run carries only what stayed enabled: the batch landed
        // on THIS round's request, not on the next one.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
    });

    it('batches a flag write together with an entry edit', async () => {
        const changes: HarnessStateChangeEvent[] = [];

        const { writer, seen } = await controlRun({
            seed: threeTurnSeed(),
            plugins: [
                turnBeforePlugin('editor-and-disabler', (context) => {
                    context.setIncluded(1, false);
                    context.edit(context.entries[2], { content: 'second, re-worded' });
                })
            ],
            stateChanges: changes
        });

        // Two canonical writes of two different kinds, ONE report: the document save that
        // follows sees both, because both were in the transcript before the flush.
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);

        expect(
            (writer.agent.messages[2] as Extract<HarnessMessage, { role: 'user' }>).content
        ).toBe('second, re-worded');
        expect((writer.agent.messages[1] as { included?: boolean }).included).toBe(false);

        // Both changes are on the request that went out in the same round.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'second, re-worded' },
            { role: 'user', content: 'third' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
    });

    it('leaves host transcript writes notifying per write', async () => {
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    instruction: 'Write.',
                    stream: scripted([], [])
                })
            },
            presets: false,
            report: {
                stateChange: (event: HarnessStateChangeEvent) => void changes.push(event)
            }
        });

        const thread = writer.createThread('writer', { label: 'Host writes' });

        // A host write is ONE write, so it is ONE report — the batching window is a plugin
        // round, and there is no round here. Three successive host writes therefore notify
        // three times: coalescing them across calls would be a time-based debounce, which is
        // exactly what durability forbids (context T4.3).
        for (const content of ['one', 'two', 'three']) {
            writer.setThreadMessages(thread.id, [{ role: 'user', content }]);
        }

        expect(
            changesOf(changes).filter((change) => change.startsWith('agent_message'))
        ).toEqual(['agent_message:writer:-', 'agent_message:writer:-', 'agent_message:writer:-']);

        // One report per write, and the LAST document is what a store would persist.
        expect(withoutIds(writer.threadMessages(thread.id))).toStrictEqual([
            { role: 'user', content: 'three' }
        ]);
    });

    it('still reports a flag write that lands after the round closed', async () => {
        const changes: HarnessStateChangeEvent[] = [];
        let late: HarnessTurnBeforeContext | undefined;

        const { writer } = await controlRun({
            seed: threeTurnSeed(),
            plugins: [
                turnBeforePlugin('hoarder', (context) => {
                    // Park the context; write nothing in this round.
                    late = context;
                })
            ],
            stateChanges: changes
        });

        if (late === undefined) throw new Error('the hoarder handler never ran.');
        const lateContext = late;

        const baseline = changesOf(changes);

        expect(baseline).toEqual(['agent_message:writer:-', 'agent_message:writer:-']);

        // A plugin that acts after its round: the batch window is gone, so the write reports
        // on the spot. Dropping this report is how a coalescer would lose a durable write —
        // the hazard the context entry names as the reason no debounce is allowed.
        lateContext.setIncluded(1, false);

        expect(changesOf(changes)).toEqual([...baseline, 'agent_message:writer:-']);
        expect((writer.agent.messages[1] as { included?: boolean }).included).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 11 — uplift T1 / acceptance H1: the ENGINE CORE trims nothing.
//
// The claim "the engine does not trim anything; the trimmer does" is true of
// src/harness.ts by construction and by comment (the projection note at
// src/harness.ts:6543-6570: a `false` entry is skipped, everything else is emitted, and
// "the default case (no flag anywhere) [is] byte-identical"). No test said so. This
// section pins it as an EXECUTED contract, so a future engine-side window, eviction or
// elision fails here rather than silently changing what a model sees.
//
// Two things have to be true at once, and the fixture has to make the first one
// verifiable rather than assumed:
//   * NO CONTEXT POLICY IS RUNNING. `harness()` ALWAYS auto-loads the built-ins
//     (src/plugin/manifest.ts is applied before `configuration.plugins`,
//     src/plugin/host.ts:18-27), so there is no plugin-less harness. The executable form
//     of "no plugin installed" is therefore the operator's own escape hatch: name-replace
//     every auto-loaded built-in with an inert stub of the same name, which host.ts does
//     IN PLACE (host.ts:22, "later registration wins"). A stub is `{ name }` alone —
//     metadata and setup are both optional (host.ts:6) — and `metadataOf` then synthesizes
//     `{ name, title: name, builtin: false }` (host.ts:114-117). Asserting that synthesized
//     shape is what PROVES no shipped descriptor, and with it no context-policy hook or
//     setting, survived; a stub that registered a hook could not claim this.
//   * NO FLAG ANYWHERE. The seed carries nothing flagged and no plugin writes, so the
//     projection's skip filter has nothing to skip and identity is testable.
//
// The identity asserted is exactly the spec's sentence: the provider request contains
// EVERY recorded entry, in CANONICAL ORDER, with equal content (pair intact, thinking
// still attached), carries no flag key, and the engine reported no transcript write of
// its own beyond the run's own append and commit. `messageId` is stripped from BOTH sides
// because stripping it is itself the projection contract (core/agent.ts:194-208
// `withIncluded` strips `included` and `messageId`).
//
// The closure half of T1 — `projectTranscript` has no consumer other than the two in
// harness.ts (the projection rebuild at :8393 and the request path at :9199) — is a grep,
// recorded in docs/tasks/2026-11-10-context-trimmer-uplift.md, not an assertion here.
// ---------------------------------------------------------------------------

describe('context inclusion — the engine core trims nothing (uplift T1 / H1)', () => {
    // Every auto-loaded built-in, replaced by an inert stub of the SAME name. Derived from
    // BUILTIN_PLUGINS rather than a literal list on purpose: if a fourth built-in ever ships,
    // it is stubbed here too, so this fixture cannot drift into "the engine trims nothing except
    // for whatever the new plugin does".
    const inertBuiltins = (): HarnessPlugin[] => BUILTIN_PLUGINS.map((plugin) => ({ name: plugin.name }));

    // The conversation the identity is asserted over — real shape, so identity is non-trivial:
    // a completed tool unit (assistant `toolCalls` plus its `tool` result), a STANDALONE
    // assistant entry carrying `reasoning`, and a second user turn. A pair has to survive as a
    // pair, thinking has to survive as thinking, and two user turns have to survive as two.
    const identitySeed = (): HarnessMessage[] => [
        { role: 'user', content: 'first question' },
        {
            role: 'assistant',
            content: '',
            reasoning: 'planning the alpha call',
            toolCalls: [call('c1', 'alpha', '{"path":"a.ts"}')]
        },
        { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
        { role: 'assistant', content: 'first answer', reasoning: 'summarising A' },
        { role: 'user', content: 'second question' }
    ];

    // One settled run with no policy in the process: the scripted stream records the exact
    // projection each request received (the `scripted`/`seen` pattern of section 1), and
    // `report.stateChange` records every canonical write — "which writes notify" is how the
    // rest of this file proves a write happened, so the ABSENCE of a third event is the
    // evidence that the engine touched no recorded entry.
    const unpolicedRun = async (prompt = 'third question') => {
        const seen: HarnessMessage[][] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: identitySeed(),
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: { alpha: echoTool('alpha', 'A') },
            // `presets: false` keeps the transcript exactly the seed plus the run's own
            // entries — no preset instruction can be mistaken for an engine-side write.
            presets: false,
            plugins: inertBuiltins(),
            report: {
                stateChange: (event: HarnessStateChangeEvent) => void changes.push(event)
            }
        });

        await writer(prompt);

        return { writer, seen, changes };
    };

    it('T1: with no context policy installed and no flags anywhere, the projection is the identity — the engine core trims nothing', async () => {
        const { writer, seen, changes } = await unpolicedRun();
        const request = seen[0];
        const canonical = writer.agent.messages;

        // --- PRECONDITION, verified not assumed: the three context policies are out. -------
        // Applied names come from the manifest, so every built-in really was replaced rather
        // than dropped or shadowed.
        expect(writer.plugins).toEqual(BUILTIN_PLUGINS.map((plugin) => plugin.name));
        // And each applied entry is the SYNTHESIZED metadata of a stub (`title === name`,
        // `builtin: false`): the shipped descriptors — titles, `hooks`, `settings` — are gone,
        // so no trim/compaction hook can fire and no setting can be read.
        expect(
            writer.pluginMetadata.map((entry) => ({
                name: entry.name,
                title: entry.title,
                builtin: entry.builtin
            }))
        ).toEqual(
            BUILTIN_PLUGINS.map((plugin) => ({ name: plugin.name, title: plugin.name, builtin: false }))
        );

        // --- THE REQUEST, entry for entry, hardcoded rather than read off the run. ---------
        // One request for one prompt: the engine spent no extra round of its own.
        expect(seen).toHaveLength(1);
        expect(request).toHaveLength(6);
        expect(request).toStrictEqual([
            { role: 'user', content: 'first question' },
            {
                role: 'assistant',
                content: '',
                reasoning: 'planning the alpha call',
                toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{"path":"a.ts"}' }]
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'first answer', reasoning: 'summarising A' },
            { role: 'user', content: 'second question' },
            { role: 'user', content: 'third question' }
        ]);
        // The same list in the failure-readable form this file uses everywhere: a dropped or
        // moved entry shows up here as one changed line instead of a full-object diff.
        expect(shape(request)).toEqual([
            'user:first question',
            'assistant::c1',
            'tool:c1:A',
            'assistant:first answer:',
            'user:second question',
            'user:third question'
        ]);
        // Nothing was reordered into a broken pair: the strict pairing oracle says the
        // answered unit arrived as a unit.
        expect(pairIssues(request)).toEqual([]);

        // The two fields a context window or a "send the essentials" pass would drop first:
        // `reasoning` on both assistant entries, and the `toolCalls` the result answers.
        expect(
            request.map((message) => ({
                role: message.role,
                reasoning: message.role === 'assistant' ? message.reasoning ?? null : null,
                toolCalls: message.role === 'assistant' ? (message.toolCalls ?? []).map((entry) => entry.id) : []
            }))
        ).toEqual([
            { role: 'user', reasoning: null, toolCalls: [] },
            { role: 'assistant', reasoning: 'planning the alpha call', toolCalls: ['c1'] },
            { role: 'tool', reasoning: null, toolCalls: [] },
            { role: 'assistant', reasoning: 'summarising A', toolCalls: [] },
            { role: 'user', reasoning: null, toolCalls: [] },
            { role: 'user', reasoning: null, toolCalls: [] }
        ]);

        // --- THE IDENTITY, stated the way the task states it. ------------------------------
        // Every RECORDED entry is in the request, in canonical order, with equal content: the
        // request is the canonical prefix with `messageId` stripped, entry for entry. Six
        // recorded entries at request time; the seventh is the answer committed AFTER the
        // request, which is the only difference between the two lists.
        expect(canonical).toHaveLength(7);
        expect(withoutIds(canonical.slice(0, request.length))).toStrictEqual(request);

        // No flag key reaches a request object — not `included`, and not the address
        // `messageId`. `harness.ts:6566-6570` promises a custom `HarnessStream` flag-free
        // data, so the keys must be ABSENT, not merely undefined.
        expect(carriesFlag(request)).toBe(false);
        expect(
            request.map((message) =>
                Object.keys(message).filter((key) => key === 'included' || key === 'messageId')
            )
        ).toEqual([[], [], [], [], [], []]);

        // Nothing was flagged on the way in either, so "the filter skipped nothing" is a fact
        // about the fixture rather than an inference: no canonical entry carries the key.
        expect(canonical.filter((message) => message.included !== undefined)).toStrictEqual([]);
        expect(JSON.stringify(canonical)).not.toContain('included');

        // --- THE ENGINE WROTE NOTHING. ----------------------------------------------------
        // Exactly two transcript notifications for the run: its own user append and its own
        // committed answer — the identical baseline a read-only `turn.before` hook produces
        // (this file:1643). A third `agent_message` would mean something in the engine edited
        // or flagged a recorded entry on its own.
        expect(changesOf(changes)).toEqual(['agent_message:writer:-', 'agent_message:writer:-']);

        // --- AND IT STILL HOLDS A TURN LATER, with the run's own answer now recorded. ------
        // Seven recorded entries plus the new prompt = an eight-message request. This is the
        // shape an engine-side horizon ("send the last N turns") breaks first, and it is why
        // the identity is asserted on the second turn as well as the first.
        await writer('fourth question');

        const second = seen[1];

        expect(seen).toHaveLength(2);
        expect(second).toHaveLength(8);
        expect(shape(second)).toEqual([
            'user:first question',
            'assistant::c1',
            'tool:c1:A',
            'assistant:first answer:',
            'user:second question',
            'user:third question',
            'assistant:settled:',
            'user:fourth question'
        ]);
        expect(pairIssues(second)).toEqual([]);
        expect(withoutIds(writer.agent.messages.slice(0, second.length))).toStrictEqual(second);
        expect(
            second.map((message) =>
                Object.keys(message).filter((key) => key === 'included' || key === 'messageId')
            )
        ).toEqual([[], [], [], [], [], [], [], []]);
        // Two turns, two appends, two commits, and still no engine-side history write.
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);
        expect(writer.agent.messages.filter((message) => message.included !== undefined)).toStrictEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 12 — the SHIPPED trimmer's write over a transcript that mixes a kept block with a
//      withheld one (uplift T4 / Part F invariant 1: pair-atomicity)
// ---------------------------------------------------------------------------
// WHY THIS CASE EXISTS
// --------------------
// Sections 1-11 drive the flag by hand (a host mutation or a synthetic `turn.before` handler);
// section 11 proves the opposite posture, that with NO policy installed the projection is the
// identity. Neither of them runs the plugin that now owns trimming. Part F invariant 1 says a
// tool unit leaves the context WHOLE or not at all, whatever switch admitted it, and asks for
// that to be green on a block with one withheld and one kept call — through the REAL built-in,
// in a REAL run, so the write path (`turn.before` -> one `setIncluded(member, false)` per
// member, R8 -> the request built from the canonical projection) is what is under test, not a
// fake api's log.
//
// The transcript is deliberately the two shapes T4 makes adjacent:
//   * a MIXED block (one `failed` answer and one healthy one) — a documented KEEP under every
//     combination of the switches (F2), so it must still be in the request, pair intact; and
//   * the all-`failed` unit right after it — the shape `dropSupersededToolCalls` (and, at the
//     default outcome set, the generalisation too) withholds, because a later unit answered the
//     same tool with a `completed` result.
// That adjacency is the pairing hazard: the withheld unit's leader and its result sit between
// two KEPT units, and a pass that wrote only HALF of it would produce either an orphan `tool`
// message (request off, answer riding) or an assistant block answered by the `withheld`
// placeholder — both of which `pairIssues` and the shape list below catch.
//
// Settings are pinned through `pluginSettings` rather than trusted to ambient defaults, so the
// switches that produce this request are part of the fixture (F5: settings are process-wide and
// live, so a fixture that reads them implicitly is a fixture that can drift).
// ---------------------------------------------------------------------------

describe('context inclusion — the trimmer withholds a whole unit beside a kept one (uplift T4 / F1)', () => {
    // Only the trimmer's keys are pinned; every other (plugin, key) returns `undefined`, which is
    // the harness's signal to fall back to the DECLARED default
    // (src/plugin/settings.ts reads through this provider). So the matcher, the duplicate switch
    // and the economy knobs stay exactly as shipped, and the case is about the switches it names.
    const trimmerSettings = (values: Record<string, boolean | string | number>): HarnessPluginSettingsProvider => ({
        get: (plugin: string, key: string) => (plugin === 'context-trimmer' ? values[key] : undefined)
    });

    // The seed: user prompt, the MIXED unit (`a1` refused, `a2` answered), the all-`failed` unit
    // (`a3`), the unit that ANSWERS it (`a4`, `completed`), and a closing assistant turn. The
    // outcome keys are the stored spelling (core/tool-outcome.ts: only a NON-`completed` outcome
    // is ever stored), so a restored transcript reads exactly like this one.
    const adjacencySeed = (): HarnessMessage[] => [
        { role: 'user', content: 'question' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [
                { id: 'a1', name: 'alpha', arguments: '{"path":"a.ts"}' },
                { id: 'a2', name: 'alpha', arguments: '{"path":"b.ts"}' }
            ]
        },
        { role: 'tool', content: 'Tool "alpha" failed: boom', toolCallId: 'a1', name: 'alpha', outcome: 'failed' },
        { role: 'tool', content: 'A', toolCallId: 'a2', name: 'alpha' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a3', name: 'alpha', arguments: '{"path":"c.ts"}' }] },
        { role: 'tool', content: 'Tool "alpha" failed: nope', toolCallId: 'a3', name: 'alpha', outcome: 'failed' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a4', name: 'alpha', arguments: '{"path":"d.ts"}' }] },
        { role: 'tool', content: 'A', toolCallId: 'a4', name: 'alpha' },
        { role: 'assistant', content: 'answered' }
    ];

    const runTrimmed = async (settings: Record<string, boolean | string | number>) => {
        const seen: HarnessMessage[][] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: adjacencySeed(),
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: { alpha: echoTool('alpha', 'A') },
            presets: false,
            // NO `plugins` key: the auto-discovered built-ins load, trimmer included — which is
            // the point. The applied roster is asserted below so "the real plugin ran" is evidence
            // rather than an assumption about auto-discovery.
            pluginSettings: trimmerSettings(settings),
            report: { stateChange: (event: HarnessStateChangeEvent) => void changes.push(event) }
        });

        await writer('go');

        return { writer, seen, changes };
    };

    it('withholds the failed unit and only that unit: the kept pair, the mixed block and the answering block all stay, and the request is pair-clean', async () => {
        const { writer, seen } = await runTrimmed({
            enabled: true,
            dropSupersededToolCalls: true,
            // `trimInvalidTools` is the current spelling of the old
            // `dropInvalidToolCallsOnceAnswered`, and every tool rule now carries its own
            // TOOL-TURN horizon. Both horizons are pinned at 0 here: this fixture's failed unit
            // has exactly one newer tool turn above it, so the shipped defaults (2) would
            // protect it and the pass would report nothing. The shipped values are pinned in
            // src/plugin/context-trimmer.test.ts.
            trimInvalidTools: true,
            supersededTurns: 0,
            invalidToolTurns: 0,
            invalidOutcomes: 'failed,rejected'
        });

        // The built-in really was the one installed (auto-discovery, not a stub of section 11).
        expect(writer.plugins).toEqual(expect.arrayContaining(['context-trimmer']));
        expect(seen).toHaveLength(1);

        const request = seen[0];

        // THE PAIRING ORACLE — the assertion Part F invariant 1 asks for. The withheld unit's
        // leader and its result sat BETWEEN two kept units; nothing leaked and nothing orphaned.
        expect(pairIssues(request)).toEqual([]);

        // Entry for entry, hardcoded from the contract (kept mixed block, kept answering block,
        // the withheld pair gone, the run's own user append last), not read back off the run.
        expect(shape(request)).toEqual([
            'user:question',
            'assistant::a1|a2',
            'tool:a1:Tool "alpha" failed: boom',
            'tool:a2:A',
            'assistant::a4',
            'tool:a4:A',
            'assistant:answered:',
            'user:go'
        ]);
        // `a3` — the withheld call — appears nowhere in the request, and neither does its result.
        expect(request.some((message) => JSON.stringify(message).includes('a3'))).toBe(false);
        expect(request).toHaveLength(8);

        // --- CANONICAL HISTORY IS UNTOUCHED, only flagged. ---------------------------------
        const canonical = writer.agent.messages;

        expect(canonical).toHaveLength(11);
        expect(shape(canonical)).toEqual([
            'user:question',
            'assistant::a1|a2',
            'tool:a1:Tool "alpha" failed: boom',
            'tool:a2:A',
            'assistant::a3',
            'tool:a3:Tool "alpha" failed: nope',
            'assistant::a4',
            'tool:a4:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:'
        ]);
        // Exactly the withheld unit carries the key — the leader AND its result, because the
        // trimmer writes every member of the unit it withholds
        // (src/plugins/context-trimmer.plugin.ts `applyTrimPlan`) and both halves flagged is
        // what keeps the request pair-clean — and `true` is never stored.
        expect(
            canonical
                .map((message, index) => ({ index, included: message.included }))
                .filter((entry) => entry.included !== undefined)
        ).toEqual([
            { index: 4, included: false },
            { index: 5, included: false }
        ]);
    });

    it('a second turn re-derives the same plan, writes nothing new, and cannot switch the unit back on', async () => {
        const { writer, seen } = await runTrimmed({
            enabled: true,
            dropSupersededToolCalls: true,
            trimInvalidTools: true,
            supersededTurns: 0,
            invalidToolTurns: 0,
            invalidOutcomes: 'failed,rejected'
        });

        await writer('again');

        expect(seen).toHaveLength(2);

        const second = seen[1];

        // Invariant 2 (withhold-only) and invariant 3 (idempotence), read off the second request:
        // the withheld pair is still absent, the kept shapes are still present, and the pair is
        // still clean — the plan was re-derived and found nothing new to do.
        expect(pairIssues(second)).toEqual([]);
        expect(shape(second)).toEqual([
            'user:question',
            'assistant::a1|a2',
            'tool:a1:Tool "alpha" failed: boom',
            'tool:a2:A',
            'assistant::a4',
            'tool:a4:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:',
            'user:again'
        ]);

        // Still exactly two flagged entries: a pass that wrote again would have flagged the same
        // pair (no new entry) or re-enabled it, and both are visible here.
        expect(
            writer.agent.messages.filter((message) => message.included === false)
        ).toHaveLength(2);
    });

    it('the SAME transcript with the tool switches off keeps every entry — the write is the switches, not the plugin existing', async () => {
        const { seen } = await runTrimmed({
            enabled: true,
            dropSupersededToolCalls: false,
            // Both tool rules off (the current spelling of that control), with the horizons
            // pinned exactly as the two cases above, so the untouched request below is provably
            // the switches and not a horizon.
            trimInvalidTools: false,
            supersededTurns: 0,
            invalidToolTurns: 0,
            invalidOutcomes: 'failed,rejected'
        });

        expect(seen).toHaveLength(1);

        const request = seen[0];

        // The control for the two cases above: with both tool switches off, the identical
        // transcript goes to the provider untouched, so the withholding below is provably the
        // switch and not the plugin's presence.
        expect(pairIssues(request)).toEqual([]);
        expect(shape(request)).toEqual([
            'user:question',
            'assistant::a1|a2',
            'tool:a1:Tool "alpha" failed: boom',
            'tool:a2:A',
            'assistant::a3',
            'tool:a3:Tool "alpha" failed: nope',
            'assistant::a4',
            'tool:a4:A',
            'assistant:answered:',
            'user:go'
        ]);
        expect(request.some((message) => JSON.stringify(message).includes('a3'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 13 — THE SECOND AXIS: `reasoningIncluded` resolves OUT of the projection
//      (trimmer uplift T6 / orchestrator decisions I1 and I2)
// ---------------------------------------------------------------------------
// WHAT THIS SECTION PINS, AND WHY IT IS A DIFFERENT SHAPE OF TEST
// ---------------------------------------------------------------
// Sections 1-12 are about the FIRST axis: `included === false` removes an entry (or a whole
// tool unit) from the request. The second axis does not remove anything. `reasoningIncluded:
// false` on one ASSISTANT entry keeps that entry in the request — same position, same `content`,
// same `toolCalls` — and removes its THINKING from the copy the provider sees. Two consequences
// make it a different contract to test:
//
//   1. THE FLAG NEVER REACHES A REQUEST. `core/agent.ts` `withoutWithheldReasoning` (run by
//      `projectTranscript` through `requestCopyOf`) drops BOTH the `reasoning` key and the flag
//      key, so a request object is flag-free on both axes and the transport needs no new field:
//      the ABSENCE of `reasoning` is the wire signal the transport's echo decision reads. The
//      assertions below therefore compare whole request objects with `toStrictEqual` — the one
//      comparison that proves a key is genuinely absent rather than `undefined`.
//   2. THE PAIRING ORACLE CANNOT SEE IT, which is the point: `pairIssues` stays empty for every
//      case here precisely because nothing structural moved.
//
// Canonical state is the other half: the flag lives on the entry, the thinking TEXT survives
// beside it, and `true` is the exact inverse (it deletes the key). Persistence is the fourth
// case, because this field had to be whitelisted by the snapshot reader and the branch copier
// (`core/snapshot.ts`, `core/branch.ts`) or a transcript with a withheld thought would have
// stopped restoring.
// ---------------------------------------------------------------------------

describe('context inclusion — the thinking flag resolves out of the projection (uplift T6)', () => {
    // A seed with two finished turns, both carrying thinking, so one entry can be flagged and its
    // neighbour left alone: the projection must change ONE request copy and nothing else.
    const thinkingSeed = (): HarnessMessage[] => [
        { role: 'system', content: 'Write.' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'first answer', reasoning: 'the first thought' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer', reasoning: 'the second thought' }
    ];

    // The run that produces an OPEN turn: iteration 1 asks for a tool, so the request built for
    // iteration 2 contains the run's OWN assistant entry — the entry a `turn` policy must never
    // strip. Reasoning frames are scripted, so the committed entries carry thinking the assertions
    // can name.
    const TOOL_TURNS: HarnessStreamEvent[][] = [
        [
            { type: 'reasoning', delta: 'planning the c1 call' },
            { type: 'done', stopReason: 'tool_calls', toolCalls: [call('c1', 'alpha')] }
        ],
        [{ type: 'reasoning', delta: 'the final thought' }, ...answer('settled')]
    ];

    // `controlRun` plus a settings provider, which a thinking fixture HERE cannot do without: the
    // auto-discovered built-ins load in every case in this file (a host plugin only REPLACES a
    // built-in it names, src/plugin/host.ts), so the shipped trimmer is live unless a provider
    // turns it off — and its thought axis ships ON with a 2-entry horizon (`trimThoughts: true`,
    // `thoughtTurns: 2`). A fixture that reads that
    // implicitly is a fixture whose request was produced by a switch it never named (F5).
    // Only the trimmer's keys are pinned; every other (plugin, key) returns `undefined`, which is the
    // harness's signal to use the DECLARED default (src/plugin/settings.ts reads through this
    // provider). Same builder as section 12's, for the same reason.
    const trimmerProvider = (values: Record<string, boolean | string | number>): HarnessPluginSettingsProvider => ({
        get: (plugin: string, key: string) => (plugin === 'context-trimmer' ? values[key] : undefined)
    });

    const thinkingRun = async (options: {
        prompt?: string;
        seed?: HarnessMessage[];
        turns?: HarnessStreamEvent[][];
        settings?: Record<string, boolean | string | number>;
        hook?: (context: HarnessTurnBeforeContext) => void;
        stateChanges?: HarnessStateChangeEvent[];
    }) => {
        const seen: HarnessMessage[][] = [];
        const stateChanges = options.stateChanges;

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
            ...(options.settings === undefined ? {} : { pluginSettings: trimmerProvider(options.settings) }),
            ...(options.hook === undefined
                ? {}
                : { plugins: [turnBeforePlugin('thinking-control', (context) => options.hook?.(context))] }),
            ...(stateChanges === undefined
                ? {}
                : { report: { stateChange: (event: HarnessStateChangeEvent) => void stateChanges.push(event) } })
        });

        await writer(options.prompt ?? 'go');

        return { writer, seen };
    };

    // A harness that restores a document and continues it, with the shipped trimmer OFF. The case
    // below is about the RESTORED FLAG resolving out of the projection on its own — with no provider
    // the auto-loaded built-in (thought axis ON, newest 2 thoughts protected) would flag the other
    // entries' thinking too, and the
    // request would no longer name one decision.
    const restoreTarget = (seen: HarnessMessage[][], reply: string) =>
        harness({
            agents: {
                writer: agent({ model: 'test/model', stream: scripted([answer(reply)], seen) })
            },
            tools: { alpha: echoTool('alpha', 'A') },
            presets: false,
            pluginSettings: trimmerProvider({ enabled: false })
        });

    // The settings every control-surface case below runs under: the shipped trimmer OFF, so the ONLY
    // thing that can withhold anything is the hook the case names.
    const TRIMMER_OFF = { enabled: false };

    it('withholds one entry\'s thinking from the request while its text, its neighbours and the pair all stay', async () => {
        const changes: HarnessStateChangeEvent[] = [];
        const quiet: HarnessStateChangeEvent[] = [];

        // The control: a round that only reads. Whatever the writing round adds has to be the write.
        const baseline = await thinkingRun({
            seed: thinkingSeed(),
            turns: TOOL_TURNS,
            settings: TRIMMER_OFF,
            hook: () => undefined,
            stateChanges: quiet
        });

        expect(baseline.seen).toHaveLength(2);
        // With the switch off, both seeded entries keep their thinking in the request.
        expect(baseline.seen[0][2]).toStrictEqual({
            role: 'assistant',
            content: 'first answer',
            reasoning: 'the first thought'
        });

        const { writer, seen } = await thinkingRun({
            seed: thinkingSeed(),
            turns: TOOL_TURNS,
            settings: TRIMMER_OFF,
            stateChanges: changes,
            hook: (context) => {
                // Iteration 1 only: the second round is what proves the write is transcript state
                // and not a per-round decision.
                if (context.iteration !== 1) return;

                context.setReasoningIncluded(entryWith(context, 'first answer'), false);
            }
        });

        // --- REQUEST 1. ---------------------------------------------------------------------
        // Entry 2 is the flagged one: still here, same slot, same `content` — and NO `reasoning`
        // key. Its neighbour, one entry later, keeps its thinking verbatim.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' }
        ]);

        // --- REQUEST 2, the round with an OPEN turn. ----------------------------------------
        // The run's own assistant entry travels WITH its thinking, next to the flagged entry which
        // travels WITHOUT it, and the tool result still answers its call.
        expect(seen[1]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [call('c1', 'alpha')],
                reasoning: 'planning the c1 call'
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' }
        ]);

        // NEITHER flag key reaches a request object — `included` and `reasoningIncluded` both
        // contain the word, so one substring check covers the two axes. The absence of the thinking
        // is spelled by the missing key, never by a flag.
        expect(seen.map(carriesFlag)).toEqual([false, false]);
        // The pairing oracle cannot see this axis, and cannot be broken by it.
        expect(seen.map(pairIssues)).toEqual([[], []]);

        // --- CANONICAL: the flag is the write, and the text survives beside it. --------------
        expect(withoutIds(writer.agent.messages)).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer', reasoning: 'the first thought', reasoningIncluded: false },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')], reasoning: 'planning the c1 call' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'settled', reasoning: 'the final thought' }
        ]);
        // The FIRST axis is untouched — a thinking write never sets `included` — and no thought was
        // destroyed: FOUR assistant entries carry thinking (the two seeded answers, the run's own
        // tool-call turn, and its final answer), and every one of them still has its `reasoning`
        // text, including the flagged one. That is the whole point of the flag being a switch
        // rather than an edit (I1).
        expect(writer.agent.messages.some((message) => message.included === false)).toBe(false);
        expect(
            writer.agent.messages.filter(
                (message) => message.role === 'assistant' && message.reasoning !== undefined
            )
        ).toHaveLength(4);

        // --- DURABILITY CLASS: one transcript change, exactly like a flag write on axis one. --
        // The quiet round's events are what the two iterations record: the prompt append, the tool
        // turn, the tool result, the tool execution itself, and the final answer. The writing round
        // inserts EXACTLY one more `agent_message` — the flag write, which lands inside iteration 1's
        // `turn.before`, i.e. after the prompt and before that iteration's assistant entry — and that
        // single notification is what a shared store turns into a save.
        expect(changesOf(quiet)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-',
            'tool_execute:writer:-',
            'agent_message:writer:-'
        ]);
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-',
            'tool_execute:writer:-',
            'agent_message:writer:-'
        ]);
    });

    it('addresses one entry by index, by messageId and by entry, refuses every other role, and never cascades', async () => {
        // A tool unit whose LEADER carries thinking — the shape where a per-entry write is
        // most visible: the thinking axis moves this entry's `reasoning` alone, while the
        // inclusion axis on this same entry takes the REQUEST alone and lets the result ride.
        const unitSeed = (): HarnessMessage[] => [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')], reasoning: 'planning the c1 call' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered', reasoning: 'summarising A' }
        ];

        const failures: string[] = [];

        const { writer } = await thinkingRun({
            seed: unitSeed(),
            settings: TRIMMER_OFF,
            hook: (context) => {
                const attempt = (run: () => void): void => {
                    try {
                        run();
                    } catch (error) {
                        failures.push((error as Error).message);
                    }
                };

                // Every refusal below was captured from a scratch probe driving this same control
                // surface (Temp/T6) and then hardcoded, so changed wording fails loudly.
                attempt(() => context.setReasoningIncluded(context.entries[0], false));
                attempt(() => context.setReasoningIncluded(2, false));
                attempt(() => context.setReasoningIncluded(context.entries[1], 'false'));
                attempt(() => context.setReasoningIncluded(context.entries[1], undefined));
                attempt(() => context.setReasoningIncluded(99, false));
                attempt(() => context.setReasoningIncluded(Number.NaN, false));
                attempt(() => context.setReasoningIncluded('msg-99', false));
                attempt(() => context.setReasoningIncluded('', false));
                attempt(() => context.setReasoningIncluded({} as never, false));

                // The two non-entry targets, on an eligible entry: the index writes the flag, the
                // `messageId` removes it again (the exact inverse), and the entry object then flags
                // a DIFFERENT assistant entry — so exactly one flag survives.
                context.setReasoningIncluded(1, false);
                context.setReasoningIncluded(String(context.entries[1].messageId), true);
                context.setReasoningIncluded(context.entries[3], false);
            }
        });

        expect(failures).toEqual([
            'turn.before setReasoningIncluded cannot switch thinking on a user message: only an assistant entry carries reasoning, so only an assistant entry can withhold it.',
            'turn.before setReasoningIncluded cannot switch thinking on a tool message: only an assistant entry carries reasoning, so only an assistant entry can withhold it.',
            'turn.before setReasoningIncluded needs a boolean for `reasoningIncluded`; received "false".',
            'turn.before setReasoningIncluded needs a boolean for `reasoningIncluded`; received undefined.',
            'turn.before setReasoningIncluded index 99 is outside this transcript (0-4).',
            'turn.before setReasoningIncluded needs an integer transcript index; received NaN.',
            'turn.before setReasoningIncluded received a stale messageId "msg-99": no entry with that id is in the transcript. Read `entries` again after `replaceHistory()`.',
            'turn.before setReasoningIncluded needs a non-empty messageId; received an empty string.',
            'turn.before setReasoningIncluded needs a transcript index, an entry from this turn, or a messageId.'
        ]);

        // THE CASCADE, or rather its absence: exactly ONE flagged entry — the last successful call's
        // target — while the tool result of the same unit carries no key, although `setIncluded` on
        // that leader would have withheld the result too.
        expect(
            writer.agent.messages.map((message, index) => ({
                index,
                messageId: (message as { messageId?: string }).messageId,
                reasoningIncluded: (message as { reasoningIncluded?: boolean }).reasoningIncluded
            }))
        ).toEqual([
            { index: 0, messageId: 'msg-1', reasoningIncluded: undefined },
            { index: 1, messageId: 'msg-2', reasoningIncluded: undefined },
            { index: 2, messageId: 'msg-3', reasoningIncluded: undefined },
            { index: 3, messageId: 'msg-4', reasoningIncluded: false },
            { index: 4, messageId: 'msg-5', reasoningIncluded: undefined },
            { index: 5, messageId: 'msg-6', reasoningIncluded: undefined }
        ]);

        // `true` is never stored: the run's snapshot has no key except the one write that survived.
        expect(JSON.stringify(writer.snapshot()).match(/reasoningIncluded/g)).toHaveLength(1);
    });

    it('treats `true` as the exact inverse, on a transcript that arrives already flagged', async () => {
        const unitSeed = (): HarnessMessage[] => [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')], reasoning: 'planning the c1 call' },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered', reasoning: 'summarising A' }
        ];

        // The withheld shape arriving from the outside (a host's JSON, or a restore), withheld again
        // by nothing: the projection resolves the flag on its own.
        const preFlagged = unitSeed();

        preFlagged[1] = { ...preFlagged[1], reasoningIncluded: false };

        const withheld = await thinkingRun({ seed: preFlagged, settings: TRIMMER_OFF });

        expect(withheld.seen[0][1]).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [call('c1', 'alpha')]
        });

        // A later round re-enabling it is the exact inverse: the KEY is gone (not `true`), and the
        // next request carries the thinking again.
        const reenabled = await thinkingRun({
            seed: preFlagged,
            settings: TRIMMER_OFF,
            hook: (context) => {
                context.setReasoningIncluded(context.entries[1], true);
            }
        });

        expect(reenabled.seen[0]).toStrictEqual([
            { role: 'user', content: 'question' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [call('c1', 'alpha')],
                reasoning: 'planning the c1 call'
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'answered', reasoning: 'summarising A' },
            { role: 'user', content: 'go' }
        ]);
        expect(withoutIds(reenabled.writer.agent.messages[1])).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{}' }],
            reasoning: 'planning the c1 call'
        });
        // `true` is nowhere in the durable document either.
        expect(JSON.stringify(reenabled.writer.snapshot()).includes('reasoningIncluded')).toBe(false);
    });

    it('a snapshot carries the flag, a restore puts it back, and a plugin-free continue still omits the thinking', async () => {
        const { writer } = await thinkingRun({
            seed: thinkingSeed(),
            settings: TRIMMER_OFF,
            hook: (context) => {
                context.setReasoningIncluded(entryWith(context, 'first answer'), false);
            }
        });

        // THE PERSISTENCE CONTRACT — the whitelist warning in ../types made executable: a
        // per-message field the snapshot reader does not list either refuses the transcript or
        // restores it WITHOUT the flag, and this is the case that would catch both.
        const snapshot = JSON.parse(JSON.stringify(writer.snapshot())) as HarnessSnapshot;

        expect(withoutIds(snapshot.agents.writer.messages[2])).toStrictEqual({
            role: 'assistant',
            content: 'first answer',
            reasoning: 'the first thought',
            reasoningIncluded: false
        });
        expect(
            snapshot.agents.writer.messages.filter(
                (message) => (message as { reasoningIncluded?: boolean }).reasoningIncluded !== undefined
            )
        ).toHaveLength(1);

        const restoredSeen: HarnessMessage[][] = [];
        const target = restoreTarget(restoredSeen, 'restored');

        target.restore(snapshot);

        // `restore -> snapshot` is a fixed point: the reader accepts the key and writes it back
        // verbatim, and never invents `reasoningIncluded: true`.
        expect(target.snapshot()).toEqual(snapshot);
        expect(JSON.stringify(target.snapshot()).match(/reasoningIncluded/g)).toHaveLength(1);

        // The stable address survived too — the flag and the id name the same entry.
        expect(withoutIds(target.agent.messages[2])).toStrictEqual({
            role: 'assistant',
            content: 'first answer',
            reasoning: 'the first thought',
            reasoningIncluded: false
        });

        await target('again');

        // The decision survives the restart with NOTHING making the choice: no host plugin, and the
        // auto-loaded built-in explicitly OFF (the provider above), so the ONLY reason this request
        // omits the thinking is the restored flag resolving out of the projection. Every other
        // thought is still sent.
        expect(restoredSeen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' },
            { role: 'user', content: 'again' }
        ]);
        expect(pairIssues(restoredSeen[0])).toEqual([]);
        expect(carriesFlag(restoredSeen[0])).toBe(false);

        // A hand-edited or host-round-tripped `reasoningIncluded: true` is accepted and NORMALIZED
        // to the absent form — the same treatment `included: true` gets, and what keeps
        // `restore -> snapshot` idempotent instead of re-adding a key the runtime never writes.
        const edited = JSON.parse(JSON.stringify(writer.snapshot())) as HarnessSnapshot;

        (edited.agents.writer.messages[4] as { reasoningIncluded?: boolean }).reasoningIncluded = true;

        const normalizedSeen: HarnessMessage[][] = [];
        const normalizer = restoreTarget(normalizedSeen, 'normal');

        normalizer.restore(edited);

        // The `true` is gone on the way IN — the reader writes the ABSENT form, never `true`, exactly
        // as it does for `included: true`.
        expect(normalizer.agent.messages[4]).toStrictEqual({
            role: 'assistant',
            content: 'second answer',
            reasoning: 'the second thought',
            messageId: 'msg-5'
        });

        await normalizer('more');

        // ... and the next request sends that thinking: normalizing `true` to "absent" means
        // "included", so a host round-tripping its own JSON cannot accidentally lose a thought.
        expect(normalizedSeen[0][4]).toStrictEqual({
            role: 'assistant',
            content: 'second answer',
            reasoning: 'the second thought'
        });
        // Nothing was written by this run either: the document still carries the ONE flag it arrived
        // with, and `true` appears nowhere.
        expect(JSON.stringify(normalizer.snapshot()).match(/reasoningIncluded/g)).toHaveLength(1);
    });

    it('runs the shipped thought horizon: the newest thought travels, every older one loses its thinking, and the request stays pair-clean', async () => {
        // THE POLICY, end to end: no hand-driven write here at all — the built-in's horizon rule
        // produced these flags. The tool switches are pinned OFF so thinking is the ONLY thing
        // this pass can withhold, which makes the request difference unambiguous.
        //
        // The axis is a toggle plus a THOUGHT-ENTRY horizon now
        // (src/plugins/context-trimmer.plugin.ts `trimThoughts` / `thoughtTurns`: N protects the
        // N newest thought ENTRIES, 0 protects nothing), which is not the retired
        // `off|turn|all` tier. `thoughtTurns: 1` is the horizon that protects exactly the newest
        // thought, which inside a tool loop is the OPEN turn's — and outside one, as in request 1
        // below, it is the newest seeded thought.
        const policy = {
            enabled: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false,
            trimThoughts: true,
            thoughtTurns: 1
        };

        const { writer, seen } = await thinkingRun({ seed: thinkingSeed(), turns: TOOL_TURNS, settings: policy });

        // Request 1: no thought of this run exists yet, so the NEWEST thought in the transcript is
        // the second seeded answer's — that one travels, and the older one goes. The entry itself
        // travels either way: the thinking axis removes a key, never a row.
        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' }
        ]);

        // Request 2: the run's OWN assistant entry has landed, so IT is the newest thought, the
        // seeded one that travelled a moment ago is now older, and the pass catches up — the
        // horizon is re-derived from the transcript every round, not remembered.
        expect(seen[1]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [call('c1', 'alpha')],
                reasoning: 'planning the c1 call'
            },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' }
        ]);
        expect(seen.map(pairIssues)).toEqual([[], []]);
        expect(seen.map(carriesFlag)).toEqual([false, false]);

        // Canonical after run 1: the two seeded thoughts are flagged (the second one only once the
        // run's own thought displaced it) and the OPEN turn's thought is not. Every thinking TEXT is
        // still stored — the flag is a switch, not a deletion.
        expect(
            writer.agent.messages.map((message, index) => ({
                index,
                thinking: message.role === 'assistant' ? message.reasoning ?? null : null,
                flag: (message as { reasoningIncluded?: boolean }).reasoningIncluded
            }))
        ).toEqual([
            { index: 0, thinking: null, flag: undefined },
            { index: 1, thinking: null, flag: undefined },
            { index: 2, thinking: 'the first thought', flag: false },
            { index: 3, thinking: null, flag: undefined },
            { index: 4, thinking: 'the second thought', flag: false },
            { index: 5, thinking: null, flag: undefined },
            { index: 6, thinking: 'planning the c1 call', flag: undefined },
            { index: 7, thinking: null, flag: undefined },
            { index: 8, thinking: 'the final thought', flag: undefined }
        ]);

        // A SECOND RUN makes a new thought the newest one (index 8, the answer run 1 ended with), so
        // the horizon moves with it: the entry that was protected a moment ago (index 6) is flagged
        // now, and nothing that was flagged is ever un-flagged. This is the re-derive claim from the
        // spec — the rule is a function of the transcript, not a note the plugin keeps.
        await writer('again');

        // The request the second run's first iteration sent, in full: every thought but the newest
        // travels WITHOUT its thinking, the entries themselves (including the tool-call block and
        // its answer) travel unchanged, and the new `again` prompt is last.
        const third = seen[2];

        expect(third).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [call('c1', 'alpha')] },
            { role: 'tool', content: 'A', toolCallId: 'c1', name: 'alpha' },
            { role: 'assistant', content: 'settled', reasoning: 'the final thought' },
            { role: 'user', content: 'again' }
        ]);
        expect(pairIssues(third)).toEqual([]);
        expect(carriesFlag(third)).toBe(false);

        // Exactly THREE flagged entries now — 2, 4 and 6. The newest thought (index 8) and the
        // second run's own answer (index 10, which the replayed frame gives no thinking at all) are
        // not among them.
        expect(seen).toHaveLength(3);
        expect(
            writer.agent.messages.map((message, index) => ({
                index,
                flag: (message as { reasoningIncluded?: boolean }).reasoningIncluded
            }))
        ).toEqual([
            { index: 0, flag: undefined },
            { index: 1, flag: undefined },
            { index: 2, flag: false },
            { index: 3, flag: undefined },
            { index: 4, flag: false },
            { index: 5, flag: undefined },
            { index: 6, flag: false },
            { index: 7, flag: undefined },
            { index: 8, flag: undefined },
            { index: 9, flag: undefined },
            { index: 10, flag: undefined }
        ]);
        // And the text of every one of those three withheld thoughts is still in canonical state:
        // the policy withheld replay, not the record.
        expect(
            writer.agent.messages.filter(
                (message, index) =>
                    (message as { reasoningIncluded?: boolean }).reasoningIncluded === false &&
                    typeof message.reasoning === 'string' &&
                    message.reasoning.length > 0
            ).map((message) => message.reasoning)
        ).toEqual(['the first thought', 'the second thought', 'planning the c1 call']);
    });

    it('with the thought axis off, the identical transcript and run send every recorded thought and store no flag at all', async () => {
        // THE CONTROL for the case above — H2's first half in a real run: `trimThoughts: false`
        // is the engine's posture when the axis is switched off, so this request is the one the
        // harness sent before this axis existed, key for key.
        const { writer, seen } = await thinkingRun({
            seed: thinkingSeed(),
            turns: TOOL_TURNS,
            settings: {
                enabled: true,
                dropSupersededToolCalls: false,
                trimInvalidTools: false,
                trimThoughts: false
            }
        });

        expect(seen[0]).toStrictEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer', reasoning: 'the first thought' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer', reasoning: 'the second thought' },
            { role: 'user', content: 'go' }
        ]);
        expect(seen[1][6]).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [call('c1', 'alpha')],
            reasoning: 'planning the c1 call'
        });
        // Nothing was written, so nothing persists: the durable document does not mention the field.
        expect(JSON.stringify(writer.snapshot()).includes('reasoningIncluded')).toBe(false);
        expect(writer.agent.messages.every((message) => (message as { included?: boolean }).included === undefined)).toBe(true);
    });

    // -------------------------------------------------------------------
    // 13.1 — THE TIER ON THE WIRE (trimmer uplift H4, end to end)
    // -------------------------------------------------------------------
    // The two halves of the thought policy have lived in two files: §13 above pins what the
    // PROJECTION does with the horizon's flags (`withoutWithheldReasoning` drops the `reasoning`
    // KEY from one request copy and moves nothing else), and src/transport/openai.test.ts pins what
    // the TRANSPORT does with a projected entry (emit `reasoning_content` iff that entry carries
    // a non-empty `reasoning`, omit it entirely otherwise). What neither file can show alone is
    // the PAIRING — that the thought policy a real `turn.before` pass decided is the policy the
    // provider actually receives. The policy→wire link was previously only IMPLIED by the two
    // suites describing the same shape in the same words.
    //
    // So this case runs the shipped chain with nothing substituted:
    //   1. the auto-discovered `context-trimmer` BUILT-IN (no host plugin, no hand-driven
    //      `setReasoningIncluded`) configured only through `pluginSettings` via the
    //      `trimmerProvider` above — the tool switches are pinned off so thinking is the only
    //      thing that pass can withhold, which makes the wire difference unambiguous;
    //   2. the real projection that pass writes through — `scripted` records the exact request
    //      copy the harness built for each iteration, and that object IS what a transport is
    //      handed, so capturing it here is not a mock of the transport's input, it is one;
    //   3. the real transport building a request over a stubbed `fetch`, in the same
    //      `sendToProvider` shape section 4 established (:793-821).
    //
    // The fixture is §13's own (`thinkingSeed` + `TOOL_TURNS`), and the payload compared is the
    // TOOL-LOOP continuation: the only request that carries BOTH halves of the claim at once —
    // two CLOSED turns with recorded thinking (the seeded answers) and the run's own OPEN-turn
    // entry (the tool call, with the thinking that produced it).
    // -------------------------------------------------------------------

    // The wire capture: an SSE body the transport can stream to completion, a `fetch` stub that
    // records the request it was answering, and the parsed body back. Same trio as section 4's
    // `sendToProvider`; `afterEach` already calls `vi.unstubAllGlobals()`.
    const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
        const encoder = new TextEncoder();

        return new ReadableStream({
            start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
            }
        });
    };

    const wireBodyOf = async (messages: HarnessMessage[]): Promise<Record<string, unknown>> => {
        const fetchMock = vi.fn(async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 }));

        vi.stubGlobal('fetch', fetchMock);

        for await (const event of openAICompatible({ baseURL: 'http://x/v1' })({ model: 'm', messages })) {
            // The frames are not the subject; the request BODY the transport built is.
            void event;
        }

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        return JSON.parse(String(init.body)) as Record<string, unknown>;
    };

    // A wire payload's `messages` list, narrowed once for the per-entry assertions below.
    const wireMessagesOf = (body: Record<string, unknown>): Record<string, unknown>[] => body.messages as Record<string, unknown>[];

    // One `tool_calls` entry in the wire's own shape: the payloads below are compared through
    // `JSON.stringify`, so key ORDER is part of what is pinned, and the transport documents
    // `reasoning_content` as written BEFORE `tool_calls`.
    const wireCall = (id: string, name: string): Record<string, unknown> => ({
        id,
        type: 'function',
        function: { name, arguments: '{}' }
    });

    // The same settings every thought-policy run uses, with the thought axis named explicitly —
    // the trimmer replaced the retired `off|turn|all` tier with a toggle plus a THOUGHT-ENTRY
    // horizon (src/plugins/context-trimmer.plugin.ts `trimThoughts` + `thoughtTurns`, where N
    // protects the N NEWEST thought entries and 0 protects nothing). So the arms below are:
    //   'turn' -> `thoughtTurns: 1`, the newest thought only — inside a tool loop that is the
    //             entry the run itself just committed;
    //   'all'  -> `thoughtTurns: 0`, nothing protected, every recorded thought withheld;
    //   'off'  -> `trimThoughts: false`, the axis switched off;
    //   omitted -> the SHIPPED DEFAULTS (`trimThoughts: true`, `thoughtTurns: 2`), because an
    //             unlisted key resolves to the declared descriptor value (src/plugin/settings.ts).
    const tierSettings = (tier?: 'turn' | 'all' | 'off'): Record<string, boolean | string | number> => ({
        enabled: true,
        dropSupersededToolCalls: false,
        trimInvalidTools: false,
        ...(tier === undefined
            ? {}
            : tier === 'off'
              ? { trimThoughts: false }
              : { trimThoughts: true, thoughtTurns: tier === 'turn' ? 1 : 0 })
    });

    it('puts the thought policy on the wire: horizon 1 echoes only the newest thought, horizon 0 echoes none, off echoes every recorded thought (uplift H4)', async () => {
        // One setting's TOOL-LOOP continuation, all the way to the provider payload. The projection
        // assertions are the pair-clean invariants FIRST: if the policy moved a key, the oracle
        // fails here instead of hiding inside a byte diff.
        const wireOf = async (tier?: 'turn' | 'all' | 'off'): Promise<Record<string, unknown>> => {
            const { seen } = await thinkingRun({ seed: thinkingSeed(), turns: TOOL_TURNS, settings: tierSettings(tier) });

            expect(seen).toHaveLength(2);
            // INVARIANT 1 on every tier: the thinking axis removes a KEY, never an entry, so the
            // oracle cannot see it — and no flag key reached a request object.
            expect(seen.map(pairIssues)).toEqual([[], []]);
            expect(seen.map(carriesFlag)).toEqual([false, false]);

            return wireBodyOf(seen[1]);
        };

        // --- horizon 1: exactly ONE echoed entry — the newest thought — and every older one. ----
        const turn = await wireOf('turn');

        expect(JSON.stringify(turn.messages)).toBe(
            JSON.stringify([
                { role: 'system', content: 'Write.' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'first answer' },
                { role: 'user', content: 'second question' },
                { role: 'assistant', content: 'second answer' },
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'planning the c1 call',
                    tool_calls: [wireCall('c1', 'alpha')]
                },
                { role: 'tool', tool_call_id: 'c1', content: 'A' }
            ])
        );
        // The older turns' field is ABSENT, never `""` (a strict provider reads an empty string
        // as a thinking block whose content is missing), and the total is exactly the number of
        // entries this horizon left eligible — so a per-entry omission cannot be confused with a
        // whole-request one.
        expect(wireMessagesOf(turn)[2]).not.toHaveProperty('reasoning_content');
        expect(wireMessagesOf(turn)[4]).not.toHaveProperty('reasoning_content');
        expect(JSON.stringify(turn).match(/reasoning_content/g)).toHaveLength(1);

        // THE SHIPPED DEFAULT IS THE HORIZON AT 2: the identical run with `trimThoughts` and
        // `thoughtTurns` never supplied protects the TWO newest thoughts — the run's own entry and
        // the seeded answer one above it — and strips every older one. That is the out-of-the-box
        // wire, and it is one echoed entry wider than the `turn` arm above.
        const byDefault = await wireOf(undefined);

        expect(JSON.stringify(byDefault.messages)).toBe(
            JSON.stringify([
                { role: 'system', content: 'Write.' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'first answer' },
                { role: 'user', content: 'second question' },
                { role: 'assistant', content: 'second answer', reasoning_content: 'the second thought' },
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'planning the c1 call',
                    tool_calls: [wireCall('c1', 'alpha')]
                },
                { role: 'tool', tool_call_id: 'c1', content: 'A' }
            ])
        );
        expect(JSON.stringify(byDefault).match(/reasoning_content/g)).toHaveLength(2);

        // --- `all` (horizon 0): the pre-T8 payload, byte for byte. ------------------------------
        const all = await wireOf('all');

        // Declared in wire key order, because `JSON.stringify` of both sides compares BYTES:
        // every withheld entry still travels, in the same slot, with the same `content` and the
        // same `tool_calls`, and no thinking field anywhere — exactly what this transport sent
        // before the echo existed.
        const preEchoWire = [
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', tool_calls: [wireCall('c1', 'alpha')] },
            { role: 'tool', tool_call_id: 'c1', content: 'A' }
        ];

        expect(JSON.stringify(all.messages)).toBe(JSON.stringify(preEchoWire));
        // The substring is the whole claim: not one `reasoning`/`reasoning_content` key in the
        // body, on any role.
        expect(JSON.stringify(all)).not.toContain('reasoning');

        // --- `off` (the axis switched off): every recorded thought is echoed, in place. ---------
        const off = await wireOf('off');

        expect(JSON.stringify(off.messages)).toBe(
            JSON.stringify([
                { role: 'system', content: 'Write.' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'first answer', reasoning_content: 'the first thought' },
                { role: 'user', content: 'second question' },
                { role: 'assistant', content: 'second answer', reasoning_content: 'the second thought' },
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'planning the c1 call',
                    tool_calls: [wireCall('c1', 'alpha')]
                },
                { role: 'tool', tool_call_id: 'c1', content: 'A' }
            ])
        );
        expect(JSON.stringify(off).match(/reasoning_content/g)).toHaveLength(3);

        // THE PAIRING CLAIM, stated structurally rather than by eye: delete the echoed field
        // from each payload and all three tiers produce the SAME request. The policy decided
        // which thinking travels; it never reordered, reworded, re-paired or dropped an entry.
        const withoutEcho = (body: Record<string, unknown>): string =>
            JSON.stringify(
                wireMessagesOf(body).map((message) => {
                    const copy: Record<string, unknown> = { ...message };

                    delete copy.reasoning_content;

                    return copy;
                })
            );

        expect(withoutEcho(turn)).toBe(withoutEcho(all));
        expect(withoutEcho(turn)).toBe(withoutEcho(off));
        expect(withoutEcho(turn)).toBe(JSON.stringify(preEchoWire));
    });
});
