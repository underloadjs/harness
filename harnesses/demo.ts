// The offline demo transport.
//
// It scripts the shape of a real run — reasoning deltas, a requestTools discovery
// round, one tool call, then a final answer — so the app is fully interactive
// without an endpoint or an API key. The harness cannot tell this apart from a
// provider: it only sees `HarnessStreamEvent`s.

import type { HarnessStream, HarnessStreamEvent } from '../src/harness';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('The run was aborted.'));
            return;
        }

        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new Error('The run was aborted.'));
        };

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });

// Stream a string in small chunks so the client sees the same event shape a real
// provider produces: many deltas, then one terminal frame.
async function* speak(
    text: string,
    type: 'text' | 'reasoning',
    signal?: AbortSignal
): AsyncGenerator<HarnessStreamEvent> {
    for (const piece of text.split(/(\s+)/)) {
        if (piece.length === 0) continue;

        await sleep(16, signal);
        yield { type, delta: piece };
    }
}

const DEMO_REASONING =
    'No endpoint is attached to this preset, so the transport is scripted. ' +
    'Only requestTools is declared, so I have to discover the clock before I can read the time.';

const DEMO_DISCOVERY = 'Asking the catalogue for time-related tools first, since only requestTools is visible.';

const DEMO_PREAMBLE = 'Found it. Calling the clock tool now.';

// The scripted transport reads the request to decide which round it is in. The
// harness appends a `tool` message before re-requesting, and that message's
// `name` says which round just finished:
//
//   1. user prompt        -> requestTools(["time"])   (the only declared tool)
//   2. requestTools result    -> clock                (now declared, so callable)
//   3. clock result       -> the answer
export const scriptedDemo = (): HarnessStream =>
    async function* (request): AsyncGenerator<HarnessStreamEvent> {
        const last = request.messages[request.messages.length - 1];
        const afterTool = last !== undefined && last.role === 'tool' ? last : undefined;

        if (afterTool !== undefined && afterTool.name === 'clock') {
            const text =
                `The clock tool returned ${afterTool.content}. ` +
                'That is the whole loop: the harness ran the tool, appended its result, and re-requested ' +
                'until the model answered with text. Switch to a live preset and set an endpoint to try ' +
                'this against a real model.';

            yield* speak(text, 'text', request.signal);
            yield {
                type: 'done',
                stopReason: 'stop',
                toolCalls: [],
                usage: { input: 148, output: 64, total: 212 }
            };
            return;
        }

        if (afterTool !== undefined && afterTool.name === 'requestTools') {
            yield* speak(DEMO_PREAMBLE, 'reasoning', request.signal);
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_clock_1', name: 'clock', arguments: '{"timezone":"UTC"}' }],
                usage: { input: 96, output: 22, total: 118 }
            };
            return;
        }

        yield* speak(DEMO_REASONING, 'reasoning', request.signal);
        yield* speak(DEMO_DISCOVERY, 'text', request.signal);
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'call_get_tools_1', name: 'requestTools', arguments: '{"tags":["time"]}' }],
            usage: { input: 48, output: 18, total: 66 }
        };
    };
