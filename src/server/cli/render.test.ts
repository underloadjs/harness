// CLI renderer tests: the terminal projection of concurrent/background tool work
// (R6) plus the legacy lines that must not change.
//
// The renderer writes directly to `process.stdout`/`process.stderr`, so every test
// captures those writes and asserts the EXACT chunks (no trimming, no regex): the
// line layout is the contract a shell user reads.
//
// The `progress` arm (T2 / review F4, 2026-11-19) is pinned here rather than only in a
// probe file: it is the frame that makes a silent minute of tool-block composition legible
// in a terminal, and its validator is the third copy of the "a frame must say something"
// rule after the transport (src/transport/openai.ts:2015) and the projector
// (src/server/turn-projector.ts:381-391). Pins: one line per DISTINCT sample, the dedupe
// re-arms at every attempt boundary, and a malformed or slot-less frame prints NOTHING.
//
// Run: yarn vitest run src/server/cli/render.test.ts   (cwd packages/underload/harness)

import type { HarnessAssistantMessage, HarnessEvent } from '../../harness';
import { createRenderer } from './render';
import type { RenderOptions } from './render';

const message = (overrides: Partial<HarnessAssistantMessage> = {}): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: 'writer-model',
    stopReason: 'stop',
    ...overrides
});

// Capture both streams. `as unknown as` keeps the overloaded Node signature while
// the mock records each chunk verbatim.
const capture = () => {
    const out: string[] = [];
    const err: string[] = [];

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: unknown
    ) => {
        out.push(String(chunk));
        return true;
    }) as unknown as typeof process.stdout.write);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((
        chunk: unknown
    ) => {
        err.push(String(chunk));
        return true;
    }) as unknown as typeof process.stderr.write);

    return {
        out,
        err,
        restore: () => {
            stdout.mockRestore();
            stderr.mockRestore();
        }
    };
};

const renderAll = (events: readonly HarnessEvent[], options: RenderOptions = { json: false, color: false }) => {
    const streams = capture();
    const render = createRenderer(options);
    for (const event of events) render(event);
    streams.restore();
    return streams;
};

// Frame builders. A `Record` of overrides keeps each test to the field it cares
// about; the cast is only for that convenience (the union itself is canonical).
const resultWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'tool_result',
        agent: 'writer',
        name: 'read',
        content: 'ok',
        isError: false,
        ...fields
    }) as unknown as HarnessEvent;

const doneWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({ type: 'done', agent: 'writer', message: message(), ...fields }) as unknown as HarnessEvent;

const wakeupWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'wakeup',
        agent: 'writer',
        reason: 'pending-tools',
        pending: [],
        ...fields
    }) as unknown as HarnessEvent;

const retryWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11,
        delayMs: 1_000,
        error: { message: 'HTTP 500: overloaded' },
        ...fields
    }) as unknown as HarnessEvent;

// (T2 / F4) The tool-composition heartbeat frame, same builder discipline as `retryWith`.
// The counters are the whole payload, so the defaults below are the two numbers a reader
// reads off the line.
const progressWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'progress',
        agent: 'writer',
        phase: 'tool-composition',
        toolCallSlots: 2,
        argumentChars: 64,
        ...fields
    }) as unknown as HarnessEvent;

// The EXACT line the arm prints for that default frame: the wording, the `·` separator and
// the singular/plural rule are the contract a shell user reads, so they are pinned verbatim
// rather than with a substring match.
const PROGRESS_LINE = '~ writer composing 2 tool calls · 64 chars\n';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createRenderer', () => {
    it('emits one JSON line per event and nothing else in json mode', () => {
        const { out, err } = renderAll([{ type: 'text', agent: 'writer', delta: 'hi' }], {
            json: true,
            color: false
        });

        expect(out).toEqual(['{"type":"text","agent":"writer","delta":"hi"}\n']);
        expect(err).toEqual([]);
    });

    it('prints a legacy tool result exactly as before (no duration, no pending)', () => {
        const { out } = renderAll([resultWith()]);

        expect(out).toEqual(['← read\n  ok\n']);
    });

    it('prints the authoritative duration on the result line', () => {
        const { out } = renderAll([resultWith({ durationMs: 1250 })]);

        expect(out).toEqual(['← read · 1.3s\n  ok\n']);
    });

    it('prints an error result with its duration and marks it as an error', () => {
        const { out } = renderAll([
            resultWith({ name: 'shell', content: 'exit 1', isError: true, durationMs: 2000 })
        ]);

        expect(out).toEqual(['← shell · 2.0s (error)\n  exit 1\n']);
    });

    it('lists calls still in flight under the result that finished', () => {
        const { out } = renderAll([
            resultWith({
                durationMs: 300,
                pending: [
                    { callId: 'c2', name: 'search', elapsedMs: 900 },
                    { callId: 'c3', name: 'shell', elapsedMs: 65_000 }
                ]
            })
        ]);

        expect(out).toEqual([
            '← read · 300ms\n  ok\n',
            '  pending · search 900ms, shell 1m05s\n'
        ]);
    });

    it('does not print a pending line when the array is empty or absent', () => {
        expect(renderAll([resultWith({ pending: [] })]).out).toEqual(['← read\n  ok\n']);
    });

    it('reports an interim done with its still-running calls, never as the end', () => {
        const { out } = renderAll([
            doneWith({
                message: message({
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
                    usage: { input: 10, output: 5, total: 15 }
                }),
                pending: [
                    { callId: 'c1', name: 'read', elapsedMs: 1200 },
                    { callId: 'c2', name: 'search', elapsedMs: 900 }
                ]
            })
        ]);

        expect(out).toEqual([
            '  writer-model · tool_calls · 1 tool call · 15 tokens · 2 tools still running\n'
        ]);
    });

    it('keeps the legacy done line when no calls are pending', () => {
        expect(renderAll([doneWith({ pending: [] })]).out).toEqual(['  writer-model · stop\n']);
        expect(renderAll([doneWith()]).out).toEqual(['  writer-model · stop\n']);
    });

    it('prints a wakeup with the calls that are still running', () => {
        const { out } = renderAll([
            wakeupWith({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] })
        ]);

        expect(out).toEqual(['~ writer woke · 1 still running · read 1.2s\n']);
    });

    it('prints a wakeup that leaves nothing pending as a finished wake', () => {
        expect(renderAll([wakeupWith()]).out).toEqual([
            '~ writer woke · pending tools finished · continuing\n'
        ]);
    });

    it('ignores a wakeup frame without a pending list', () => {
        // `pending` is required on the frame; a wake without it says nothing about
        // the queue and must not print "finished".
        expect(renderAll([wakeupWith({ pending: undefined })]).out).toEqual([]);
    });

    it('closes an open stream line before a wakeup', () => {
        const { out } = renderAll([
            { type: 'text', agent: 'writer', delta: 'answering' },
            wakeupWith()
        ]);

        expect(out).toEqual(['answering', '\n', '~ writer woke · pending tools finished · continuing\n']);
    });

    it('stays silent for per-request usage', () => {
        const { out } = renderAll([
            { type: 'usage', agent: 'writer', usage: { input: 10, output: 5, total: 15 } }
        ]);

        expect(out).toEqual([]);
    });

    // R1/R4: one dim line per retried model request, naming the attempt, the budget,
    // the backoff and the failed attempt's own error.
    it('prints a model-request retry', () => {
        const { out } = renderAll([
            retryWith({ attempt: 2, maxAttempts: 11, delayMs: 2_000, error: { message: 'HTTP 500: down' } })
        ]);

        expect(out).toEqual(['~ writer retry 2/11 in 2.0s · HTTP 500: down\n']);
    });

    it('closes an open stream line before a retry', () => {
        const { out } = renderAll([
            { type: 'text', agent: 'writer', delta: 'partial' },
            retryWith()
        ]);

        expect(out).toEqual(['partial', '\n', '~ writer retry 1/11 in 1.0s · HTTP 500: overloaded\n']);
    });

    // F6: a persisted/older/hand-written frame is untrusted input. A malformed retry
    // must print NOTHING — never "retry undefined/NaN in NaNms", and never throw on a
    // missing `error` object. The browser's `retryOf` (src/frontend/contract.ts)
    // applies exactly these rules; the terminal must agree with it.
    it('ignores every malformed retry frame instead of throwing or inventing a line', () => {
        const malformed: HarnessEvent[] = [
            // No `error` at all: `event.error.message` used to throw here.
            retryWith({ error: undefined }),
            retryWith({ error: { message: 42 } }),
            retryWith({ attempt: undefined }),
            retryWith({ attempt: 0 }),
            retryWith({ attempt: Number.NaN }),
            retryWith({ attempt: Number.POSITIVE_INFINITY }),
            // Budget below the attempt it reports.
            retryWith({ attempt: 5, maxAttempts: 2 }),
            retryWith({ maxAttempts: undefined }),
            retryWith({ delayMs: Number.NaN }),
            retryWith({ delayMs: -1 }),
            retryWith({ delayMs: undefined }),
            // An unnamed frame says nothing about a retry sequence.
            retryWith({ agent: '' })
        ];

        for (const frame of malformed) {
            const { out, err } = renderAll([frame]);
            expect(out).toEqual([]);
            expect(err).toEqual([]);
        }
    });

    // ------------------------------------------------------------------
    // T2 / F4 — the `progress` arm (render.ts:258, validator at :95-107)
    // ------------------------------------------------------------------
    //
    // The heartbeat is the ONLY frame that says the model is still writing while a tool
    // block composes, and the terminal is where the 2026-11-19 incident was actually
    // watched, so it prints one dim line per DISTINCT sample: the transport throttles to at
    // most one frame per 500 ms (src/transport/openai.ts:2015), so printing every accepted
    // frame would be two lines per second of composition, while what a reader wants is the
    // numbers MOVING. Every pin below asserts the WHOLE chunk list, so a wording change, a
    // lost dedupe or a spurious line fails on the exact bytes.
    it('prints one composition line per distinct sample and dedupes the repeat', () => {
        const { out, err } = renderAll([
            progressWith({ toolCallSlots: 2, argumentChars: 4_096 }),
            progressWith({ toolCallSlots: 2, argumentChars: 4_096 }),
            progressWith({ toolCallSlots: 4, argumentChars: 6_512 }),
            progressWith({ toolCallSlots: 1, argumentChars: 5 })
        ]);

        // Four frames, three lines: the second is the same sample. Note the CLI prints the
        // RAW integer (`4096`) while the tile groups it (`4,096`) — the review records that
        // as cosmetic; the counters themselves are identical, and pinning the digits here is
        // what stops the two surfaces drifting SILENTLY if one of them changes.
        expect(out).toEqual([
            '~ writer composing 2 tool calls · 4096 chars\n',
            '~ writer composing 4 tool calls · 6512 chars\n',
            '~ writer composing 1 tool call · 5 chars\n'
        ]);
        expect(err).toEqual([]);
    });

    // The dedupe is ATTEMPT-scoped, never global: it forgets the line at the same boundaries
    // the projector clears its field on (src/server/turn-projector.ts:3287, 3405, 3420, 3481,
    // 3685, 3925 — `retry` / `attempt_commit` / `done` / `error` and the F1 edges), so a
    // re-sent attempt may report the same figures again.
    it('re-arms the composition line at every attempt boundary', () => {
        const boundaries: { name: string; frame: HarnessEvent; printed: string[] }[] = [
            { name: 'retry', frame: retryWith(), printed: ['~ writer retry 1/11 in 1.0s · HTTP 500: overloaded\n'] },
            // The commit prints nothing of its own, but it still ends the attempt.
            {
                name: 'attempt_commit',
                frame: { type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 },
                printed: []
            },
            { name: 'done', frame: doneWith(), printed: ['  writer-model · stop\n'] },
            // A new flow composes its OWN numbers: the previous flow's identical line must not
            // swallow this one's first heartbeat (a delegated child re-opening the same
            // counters is a fact worth printing).
            {
                name: 'start',
                frame: { type: 'start', agent: 'writer', model: 'writer-model' },
                printed: ['\n── writer · writer-model ──\n']
            }
        ];

        for (const boundary of boundaries) {
            const { out } = renderAll([progressWith(), boundary.frame, progressWith()]);

            expect(out).toEqual([PROGRESS_LINE, ...boundary.printed, PROGRESS_LINE]);
        }
    });

    it('re-arms on a terminal error, whose line goes to stderr instead', () => {
        const { out, err } = renderAll([
            progressWith(),
            { type: 'error', agent: 'writer', error: { message: 'lane died' } } as unknown as HarnessEvent,
            progressWith()
        ]);

        // stdout keeps only the two composition lines (the error line is not a stdout
        // chunk), which is also the proof that the boundary cleared the dedupe.
        expect(out).toEqual([PROGRESS_LINE, PROGRESS_LINE]);
        expect(err).toEqual(['error: lane died\n']);
    });

    // The arm takes the same care as `retry`/`wakeup` with a half-open prose line: the status
    // line starts on its own row and the streamed text is never left unterminated.
    it('closes an open stream line before the composition line', () => {
        const { out } = renderAll([{ type: 'text', agent: 'writer', delta: 'launching' }, progressWith()]);

        expect(out).toEqual(['launching', '\n', PROGRESS_LINE]);
    });

    // F4 + F3: a persisted/older/hand-written journal is UNTRUSTED input, and a frame that
    // names no open call is not malformed but VACUOUS — `composing 0 tool calls · 0 chars`
    // claims work while contradicting itself, and pre-F3 journals on disk really do contain
    // it. `progressOf` (render.ts:95-107) prints NOTHING for all of them and never throws,
    // on the same rules the projector applies (src/server/turn-projector.ts:381-391
    // `toolProgressOf`) and the transport enforces at the source
    // (src/transport/openai.ts:2015) — three consumers, one accepted-frame set.
    it('ignores every malformed or vacuous progress frame instead of throwing or inventing a line', () => {
        const malformed: HarnessEvent[] = [
            // An unknown phase says nothing a reader can act on.
            progressWith({ phase: 'sideways' }),
            // `idle` is the DISPLAY plane's clear, spelled by the projector and by this file,
            // never a frame a transport sends — so a journaled one prints nothing.
            progressWith({ phase: 'idle' }),
            // F3: a slot-less frame, whether it carries characters or not.
            progressWith({ toolCallSlots: 0, argumentChars: 0 }),
            progressWith({ toolCallSlots: 0, argumentChars: 512 }),
            // Counters are integers: 1.5 calls and 1.5 characters are not facts, and a
            // negative count is not a drain signal.
            progressWith({ toolCallSlots: -1 }),
            progressWith({ toolCallSlots: 1.5 }),
            progressWith({ argumentChars: -1 }),
            progressWith({ argumentChars: 1.5 }),
            progressWith({ argumentChars: 'ten' }),
            // A missing counter is data, not an instruction to print zero.
            progressWith({ toolCallSlots: undefined }),
            progressWith({ argumentChars: undefined }),
            // An unnamed frame cannot be attributed to an agent at all.
            progressWith({ agent: '' }),
            progressWith({ agent: undefined }),
            progressWith({ agent: null })
        ];

        for (const frame of malformed) {
            const { out, err } = renderAll([frame]);

            expect(out).toEqual([]);
            expect(err).toEqual([]);
        }
    });

    // The vacuous frames must stay silent IN CONTEXT too: a refused frame neither prints nor
    // touches the line already on screen, so an empty delta between two real samples costs
    // nothing and the dedupe still holds around it.
    it('a vacuous frame neither prints nor disturbs the line already on screen', () => {
        const { out, err } = renderAll([
            progressWith({ toolCallSlots: 0, argumentChars: 0 }),
            progressWith({ toolCallSlots: 3, argumentChars: 900 }),
            progressWith({ toolCallSlots: 0, argumentChars: 0 }),
            progressWith({ toolCallSlots: 3, argumentChars: 900 })
        ]);

        expect(out).toEqual(['~ writer composing 3 tool calls · 900 chars\n']);
        expect(err).toEqual([]);
    });

    // R3/F1: the per-request success boundary a tool round needs. It is state, not
    // prose, so the terminal prints nothing for it; `--json` still emits the frame.
    it('prints nothing for an attempt_commit boundary', () => {
        const { out, err } = renderAll([
            { type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 }
        ]);

        expect(out).toEqual([]);
        expect(err).toEqual([]);
    });

    it('emits attempt_commit unchanged under --json', () => {
        const { out } = renderAll(
            [{ type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 }],
            { json: true, color: false }
        );

        expect(out).toEqual([
            '{"type":"attempt_commit","agent":"writer","attempt":1,"maxAttempts":11}\n'
        ]);
    });

    // The `progress` frame under `--json` is the machine-readable half of the same event: a
    // program tallying composition must get the frame VERBATIM — the prose arm's dedupe and
    // its refusals apply to the human line only, never to the wire.
    it('emits a progress frame unchanged under --json, slot-less frames included', () => {
        const { out } = renderAll(
            [progressWith(), progressWith({ toolCallSlots: 0, argumentChars: 0 })],
            { json: true, color: false }
        );

        expect(out).toEqual([
            '{"type":"progress","agent":"writer","phase":"tool-composition","toolCallSlots":2,"argumentChars":64}\n',
            '{"type":"progress","agent":"writer","phase":"tool-composition","toolCallSlots":0,"argumentChars":0}\n'
        ]);
    });
});
