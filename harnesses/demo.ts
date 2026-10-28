// The offline demo transport.
//
// It scripts the shape of a real run — reasoning deltas, a toolRequest discovery
// round, one tool call, then a final answer — so the app is fully interactive
// without an endpoint or an API key. The harness cannot tell this apart from a
// provider: it only sees `HarnessStreamEvent`s.
//
// NAMING (T14): the scripted tool calls use the CURRENT wire names — toolRequest
// and timeNow. The harness id and the preset id stay `demo`.

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
    'Only toolRequest is declared, so I have to discover timeNow before I can read the time.';

const DEMO_DISCOVERY = 'Asking the catalogue for time-related tools first, since only toolRequest is visible.';

const DEMO_PREAMBLE = 'Found it. Calling timeNow now.';

// The scripted transport reads the request to decide which round it is in. The
// harness appends a `tool` message before re-requesting, and that message's
// `name` says which round just finished:
//
//   1. user prompt          -> toolRequest(["time"])   (the only declared tool)
//   2. toolRequest result   -> timeNow                 (now declared, so callable)
//   3. timeNow result       -> the answer
export const scriptedDemo = (): HarnessStream =>
    async function* (request): AsyncGenerator<HarnessStreamEvent> {
        const last = request.messages[request.messages.length - 1];
        const afterTool = last !== undefined && last.role === 'tool' ? last : undefined;

        if (afterTool !== undefined && afterTool.name === 'timeNow') {
            const text =
                `timeNow returned ${afterTool.content}. ` +
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

        if (afterTool !== undefined && afterTool.name === 'toolRequest') {
            yield* speak(DEMO_PREAMBLE, 'reasoning', request.signal);
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_time_now_1', name: 'timeNow', arguments: '{"timezone":"UTC"}' }],
                usage: { input: 96, output: 22, total: 118 }
            };
            return;
        }

        yield* speak(DEMO_REASONING, 'reasoning', request.signal);
        yield* speak(DEMO_DISCOVERY, 'text', request.signal);
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'call_tool_request_1', name: 'toolRequest', arguments: '{"tags":["time"]}' }],
            usage: { input: 48, output: 18, total: 66 }
        };
    };
