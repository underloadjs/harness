// Issue 0006 — the ONE SSE writer the package publishes, pinned from BOTH sides.
//
// Why this file exists: the frame contract, the `: connected\n\n` preamble, the
// `X-Accel-Buffering` header, the backpressure rule and the cancel->abort wiring used to
// live twice in the package — once private in ./service.ts (`createSseResponse`), once as a
// second independent writer in the Node adapter ./handler.ts (`createSseWriter` +
// `runStream`) — and nowhere as something a host could import. They are now one exported
// function (`createHarnessSseResponse`) plus one bridge over it (`runHarnessSseStream`). A
// host streaming harness events from its own endpoint returns the same Response this
// package returns, so every rule below is a rule a host inherits; a silent change to any of
// them is a silent change to every host's wire format.
//
// What is asserted, exactly (all exact values, no ranges):
//   1. the writer is importable from the SERVER ENTRY (./index.ts is what
//      `@underload/harness/server` maps to — src/structure.test.ts:329,500 pin that mapping),
//      and it is the SAME function the service adapter calls, not a second copy;
//   2. the fetch-side shape, byte for byte: status 200, the four headers with their exact
//      values, the preamble, then `data: <json>\n\n` per item;
//   3. cancel -> abort: `reader.cancel()` aborts the signal the run was handed, and the
//      reader then sees the end of the stream;
//   4. request-signal -> abort: an aborting request signal reaches the run and closes the
//      body (the wiring the loader's `{ stream }` passthrough cannot express);
//   5. BACKPRESSURE paces the run: the queue holds one chunk, so a run that wants five
//      frames has produced exactly three while the consumer has taken two, and no more after
//      it settles — then the drained bytes are the exact five frames;
//   6. the COLLAPSED Node writer (`runHarnessSseStream`, ./handler.ts) produces the SAME
//      bytes and the SAME header values over a real `http.Server`, and a client that walks
//      away mid-stream aborts the run (the old adapter's own guarantee, now inherited).
//
// Cross-references:
//   - ./service.ts:215   — `createHarnessSseResponse` (the writer, and the R4 note on what
//                          an abort MEANS per route — that stays the dispatcher's decision)
//   - ./handler.ts:170   — `runHarnessSseStream` (the `Readable.fromWeb` bridge)
//   - ./index.ts:11-14   — the barrel surface this file imports from
//   - ../../README.md ("Service host") — the recipe these tests back
//   - docs/issues/minor-streaming-and-adapter-ergonomics.md — the gap being closed

import http from 'node:http';
import { describe, expect, it } from 'vitest';
// The published entry, deliberately: AC1 is "importable from @underload/harness/server", and
// ./index.ts IS that entry in the tree (package.json maps `./server` onto it).
import { createHarnessSseResponse, runHarnessSseStream } from './index';
import type { HarnessApiResult, HarnessApiStream } from './index';
// The direct source module, used to prove the barrel re-exports the writer rather than
// publishing a second implementation of it.
import * as serviceAdapter from './service';

const decoder = new TextDecoder();

// Bounded polling instead of a fixed sleep: the outcome is an exact boolean, and a timeout
// fails the test loudly rather than passing on a race.
const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    throw new Error(`Timed out waiting for ${label}.`);
};

const settle = async (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One frame of the contract, in the exact bytes the shipped UI parser reads.
const frameOf = (item: unknown): string => `data: ${JSON.stringify(item)}\n\n`;

const streamOf = (text: string | undefined): string => decoder.decode(text as Uint8Array);

describe('the published SSE writer (issue 0006)', () => {
    it('is importable from the server entry and is the function the service adapter calls', () => {
        // AC1, first half: a host that imports `@underload/harness/server` gets the writer.
        // The identity check is the real assertion: a barrel that re-declared the helper, or
        // an adapter that kept its own private copy, fails here while still exporting a
        // callable function of the right name.
        expect(createHarnessSseResponse).toBe(serviceAdapter.createHarnessSseResponse);

        // AC1, second half: the Node adapter runs on the same writer (its body is the only
        // consumer inside the package, and the cases below pin what it produces).
        expect(typeof runHarnessSseStream).toBe('function');
    });

    it('answers with the frame contract byte for byte: preamble, then data frames, with the four headers', async () => {
        const start: HarnessApiStream = async (emit): Promise<void> => {
            await emit({ type: 'a' });
            await emit({ type: 'b' });
        };

        const response = createHarnessSseResponse(start);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
        expect(response.headers.get('connection')).toBe('keep-alive');
        // The header a host needs most and is most likely to forget: without it a proxy
        // between the browser and the endpoint buffers whole frames.
        expect(response.headers.get('x-accel-buffering')).toBe('no');

        expect(await response.text()).toBe(`${': connected\n\n'}${frameOf({ type: 'a' })}${frameOf({ type: 'b' })}`);
    });

    it('aborts the run when the consumer cancels, and the reader then sees the end', async () => {
        let runSignal: AbortSignal | undefined;
        let finished = false;

        const start: HarnessApiStream = async (emit, signal): Promise<void> => {
            runSignal = signal;

            let tick = 0;
            while (!signal.aborted) {
                await emit({ type: 'tick', n: tick });
                tick += 1;
                await settle(2);
            }

            finished = true;
        };

        const response = createHarnessSseResponse(start);
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();

        expect(streamOf((await reader.read()).value)).toBe(': connected\n\n');

        await reader.cancel();

        // cancel() -> stop() -> the signal handed to `start` aborts, which is the ONLY way a
        // browser disconnect reaches a run. WHAT it means per route stays the dispatcher's.
        await waitUntil(() => runSignal?.aborted === true, 'the cancel to abort the run');
        expect(runSignal?.aborted).toBe(true);

        // The writer closes the body once the run returns, so the consumer sees a clean end
        // rather than a stalled stream.
        await waitUntil(() => finished, 'the run to return');
        expect(finished).toBe(true);
        expect(await reader.read()).toEqual({ value: undefined, done: true });
    });

    it('aborts the run when the request signal aborts, and closes the body', async () => {
        let runSignal: AbortSignal | undefined;
        let finished = false;

        const start: HarnessApiStream = async (emit, signal): Promise<void> => {
            runSignal = signal;

            let tick = 0;
            while (!signal.aborted) {
                await emit({ type: 'tick', n: tick });
                tick += 1;
                await settle(2);
            }

            finished = true;
        };

        // The service adapter passes `context.req.raw.signal` here (service.ts:626); a host
        // whose runtime propagates a disconnect gets the same wiring for free.
        const request = new AbortController();
        const response = createHarnessSseResponse(start, request.signal);
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();

        expect(streamOf((await reader.read()).value)).toBe(': connected\n\n');

        request.abort();

        await waitUntil(() => runSignal?.aborted === true, 'the request abort to reach the run');
        expect(runSignal?.aborted).toBe(true);
        await waitUntil(() => finished, 'the run to return');
        expect(finished).toBe(true);
        expect(await reader.read()).toEqual({ value: undefined, done: true });
    });

    it('paces the run on backpressure: five frames, and only three produced after two reads', async () => {
        // The queue holds ONE chunk (the default `ReadableStream` strategy), so a frame waits
        // for the consumer's next `pull`. The preamble is enqueued when the stream is built,
        // so the run's first frame is already parked at construction; each read releases
        // exactly one frame. Two reads therefore mean: preamble out, frame 1 out, frame 2
        // queued, and the run parked on frame 3 — a writer without the drain wait would have
        // queued all five.
        let produced = 0;

        const start: HarnessApiStream = async (emit): Promise<void> => {
            for (let index = 1; index <= 5; index += 1) {
                produced += 1;
                await emit({ n: index });
            }
        };

        const response = createHarnessSseResponse(start);
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();

        expect(streamOf((await reader.read()).value)).toBe(': connected\n\n');
        expect(streamOf((await reader.read()).value)).toBe(frameOf({ n: 1 }));

        // Settled, not racy: a broken backpressure rule has had 40 ms to run ahead here.
        await settle();
        expect(produced).toBe(3);

        expect(streamOf((await reader.read()).value)).toBe(frameOf({ n: 2 }));
        expect(streamOf((await reader.read()).value)).toBe(frameOf({ n: 3 }));
        expect(streamOf((await reader.read()).value)).toBe(frameOf({ n: 4 }));
        expect(streamOf((await reader.read()).value)).toBe(frameOf({ n: 5 }));
        expect(await reader.read()).toEqual({ value: undefined, done: true });

        await settle();
        expect(produced).toBe(5);
    });
});

// The Node side of the collapse (./handler.ts). No in-package route answers a plain HTTP GET
// with a stream arm any more — T15 moved live updates to the WebSocket upgrade — so this
// drives the exported bridge the way the adapter does: a real `http.Server`, a real client,
// and the dispatcher's `start` handed over directly.
const serve = (result: Extract<HarnessApiResult, { kind: 'stream' }>): Promise<{ base: string; close: () => Promise<void> }> =>
    new Promise((resolve) => {
        const server = http.createServer((request, response) => {
            void runHarnessSseStream(result, request, response);
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            resolve({
                base: `http://127.0.0.1:${typeof address === 'string' ? 0 : address.port}`,
                close: async (): Promise<void> => {
                    // Undici keeps the socket alive after a cancelled response; dropping the
                    // connections is what lets `close()` settle inside the test timeout.
                    server.closeAllConnections();
                    await new Promise((resolveClose) => server.close(resolveClose));
                }
            });
        });
    });

describe('the Node adapter over the shared writer (issue 0006)', () => {
    it('streams the identical bytes and headers over a real http.Server', async () => {
        const start: HarnessApiStream = async (emit): Promise<void> => {
            await emit({ type: 'a' });
            await emit({ type: 'b' });
        };

        const { base, close } = await serve({ kind: 'stream', start });

        try {
            const response = await fetch(base);

            expect(response.status).toBe(200);
            // Same four values the deleted adapter set by hand; only their NAME casing comes
            // from `Response.headers` now, which HTTP treats case-insensitively.
            expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
            expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
            expect(response.headers.get('connection')).toBe('keep-alive');
            expect(response.headers.get('x-accel-buffering')).toBe('no');

            expect(await response.text()).toBe(': connected\n\ndata: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
        } finally {
            await close();
        }
    });

    it('aborts the run when the client disconnects mid-stream', async () => {
        let runSignal: AbortSignal | undefined;
        let outcome: { finished: boolean; aborted: boolean } = { finished: false, aborted: false };

        const start: HarnessApiStream = async (emit, signal): Promise<void> => {
            runSignal = signal;

            let tick = 0;
            while (!signal.aborted) {
                await emit({ type: 'tick', n: tick });
                tick += 1;
                await settle(2);
            }

            outcome = { finished: true, aborted: signal.aborted };
        };

        const { base, close } = await serve({ kind: 'stream', start });

        try {
            const response = await fetch(base);
            const reader = (response.body as ReadableStream<Uint8Array>).getReader();

            // The stream really started before the client walked away. Chunk BOUNDARIES over
            // a socket are not a fixed value (one read can carry two frames), so the exact
            // bytes are pinned by the case above; what is pinned here is the exact PREFIX,
            // i.e. the preamble followed by the first frame.
            const prefix = `: connected\n\n${frameOf({ type: 'tick', n: 0 })}`;
            let text = '';

            for (let attempt = 0; attempt < 50 && !text.includes(prefix); attempt += 1) {
                const { done, value } = await reader.read();

                if (done) break;
                text += streamOf(value);
            }

            expect(text.slice(0, prefix.length)).toBe(prefix);

            // The browser closes the tab: the socket dies, the adapter's `close` listener
            // aborts, the bridge is destroyed in its `finally`, and the writer's `cancel()`
            // path fires. The run ends because it was aborted, not because it ran out.
            await reader.cancel();

            await waitUntil(() => runSignal?.aborted === true, 'the disconnect to abort the run');
            await waitUntil(() => outcome.finished, 'the run to return');

            expect(outcome).toEqual({ finished: true, aborted: true });
        } finally {
            await close();
        }
    });
});
