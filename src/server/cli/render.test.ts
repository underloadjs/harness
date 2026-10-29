// CLI renderer tests: the terminal projection of concurrent/background tool work
// (R6) plus the legacy lines that must not change.
//
// The renderer writes directly to `process.stdout`/`process.stderr`, so every test
// captures those writes and asserts the EXACT chunks (no trimming, no regex): the
// line layout is the contract a shell user reads.
//
// Run: npx vitest run src/server/cli/render.test.ts

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
        name: 'fileRead',
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

        expect(out).toEqual(['← fileRead\n  ok\n']);
    });

    it('prints the authoritative duration on the result line', () => {
        const { out } = renderAll([resultWith({ durationMs: 1250 })]);

        expect(out).toEqual(['← fileRead · 1.3s\n  ok\n']);
    });

    it('prints an error result with its duration and marks it as an error', () => {
        const { out } = renderAll([
            resultWith({ name: 'commandRun', content: 'exit 1', isError: true, durationMs: 2000 })
        ]);

        expect(out).toEqual(['← commandRun · 2.0s (error)\n  exit 1\n']);
    });

    it('lists calls still in flight under the result that finished', () => {
        const { out } = renderAll([
            resultWith({
                durationMs: 300,
                pending: [
                    { callId: 'c2', name: 'webSearch', elapsedMs: 900 },
                    { callId: 'c3', name: 'commandRun', elapsedMs: 65_000 }
                ]
            })
        ]);

        expect(out).toEqual([
            '← fileRead · 300ms\n  ok\n',
            '  pending · webSearch 900ms, commandRun 1m 05s\n'
        ]);
    });

    it('does not print a pending line when the array is empty or absent', () => {
        expect(renderAll([resultWith({ pending: [] })]).out).toEqual(['← fileRead\n  ok\n']);
    });

    it('reports an interim done with its still-running calls, never as the end', () => {
        const { out } = renderAll([
            doneWith({
                message: message({
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'c1', name: 'fileRead', arguments: '{}' }],
                    usage: { input: 10, output: 5, total: 15 }
                }),
                pending: [
                    { callId: 'c1', name: 'fileRead', elapsedMs: 1200 },
                    { callId: 'c2', name: 'webSearch', elapsedMs: 900 }
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
            wakeupWith({ pending: [{ callId: 'c1', name: 'fileRead', elapsedMs: 1200 }] })
        ]);

        expect(out).toEqual(['~ writer woke · 1 still running · fileRead 1.2s\n']);
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
});
