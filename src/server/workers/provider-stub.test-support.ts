// TEST SUPPORT (not production, not collected by vitest: the file name ends in
// `.test-support.ts`, while `src/**/*.{test,spec}.{ts,tsx}` is the include pattern in
// ../../vitest.config.ts).
//
// WHY A WORKER LANE NEEDS A PROVIDER
// ----------------------------------
// A lane worker rebuilds the session's harness from the durable preset record
// (`presetFromRecord(blueprint.record)`, ./lane-worker-loop.ts `sayHello`). That works for a
// template-backed preset because the FACTORY lives in shipped code — `liveFactory` compiles the
// profiled toolbox from source paths inside the worker process. It cannot work for an injected
// scripted preset: its factory is a closure over a stream function, and a closure does not
// cross `worker_threads`. So the scripted fixture in
// ../harnesses/fixture-presets.test-support.ts is an INLINE-only fixture, and every suite that
// drives a real lane has to run a LIVE preset against a provider it can reach — over HTTP, from
// the worker thread, which is precisely why the answer has to be bytes on a socket rather than a
// stubbed transport object.
//
// WHAT THIS FILE PROVIDES
//   `startScriptedProvider()` — a loopback OpenAI-shaped SSE server that answers like the
//   deleted scripted transport: a tool round, then an answer that quotes the tool result. It
//   reads the REQUEST to decide which round it is in (the same rule the scripted transport used:
//   the trailing `tool` message names the round that just finished), so it drives any number of
//   turns in any order, and a restored or rebuilt lane keeps working.
//
//   `startProvider(rounds)` — the lower-level form: answer these literal SSE bodies, in order,
//   repeating the last one. `textRound`, `callRound` and `sse` build those bodies.
//
// PACING IS NOT COSMETIC. The suites that watch two lanes report `busy` at the same instant, or
// sample a sibling's event stream while a CPU burn runs, need a turn that is still in flight
// long enough to observe. A stub that answered instantly would make those tests pass by accident
// or fail by timing out. `chunkDelayMs`/`chunks` therefore stretch a round to roughly the wall
// clock the scripted transport used to produce (~1.5 s per turn), and the deltas are real SSE
// frames, so the event count a turn records is real too.
//
// Cross-references:
//   - ./lane-worker.test.ts, ./lane-worker-correctness.test.ts  - the lane suites that run on it
//   - ./lane-tool-settings.test.ts                              - the request-capturing variant
//   - ../harnesses/fixture-presets.test-support.ts              - the inline scripted fixture
//   - src/transport/openai.ts                                   - the wire format served here

import http from 'node:http';

export type Stub = { origin: string; requests: Record<string, any>[]; close: () => Promise<void> };

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const DONE = 'data: [DONE]\n\n';

export const providerSse = sse;

// One complete round: every delta of `content`, then the finish reason, then the terminator.
// `finishReason` defaults to `stop` (a plain answer); `tool_calls` is what a round that asks for
// a tool sends.
const round = (
    content: string[],
    finishReason: 'stop' | 'tool_calls' = 'stop',
    toolCalls?: { id: string; name: string; arguments: string }[]
): string => {
    let body = '';

    for (const piece of content) body += sse({ choices: [{ delta: { content: piece } }] });

    if (toolCalls !== undefined) {
        toolCalls.forEach((call, index) => {
            body += sse({
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index,
                                    id: call.id,
                                    type: 'function',
                                    function: { name: call.name, arguments: call.arguments }
                                }
                            ]
                        }
                    }
                ]
            });
        });
    }

    body += sse({ choices: [{ delta: {}, finish_reason: finishReason }] });

    return body + DONE;
};

// A minimal valid completion (src/transport/openai.ts's OpenAI shape). The agent retries a
// FAILED model request with real backoff (src/harness.ts R1), so an error response would make a
// suite wait out retries instead of reading what it already captured.
export const textRound = (content: string): string =>
    sse({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + DONE;

export const callRound = (id: string, name: string, args: string): string =>
    sse({
        choices: [
            {
                delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
                finish_reason: 'tool_calls'
            }
        ]
    }) + DONE;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Write one SSE frame and flush it. A chunked response with no `Content-Length` is exactly how a
// streaming provider arrives, and the transport parses frames as they land.
const writeFrame = (response: http.ServerResponse, frame: string): void => {
    response.write(frame);
};

const listen = async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server_address(server);

    return typeof address === 'object' && address !== null ? address.port : 0;
};

const server_address = (server: http.Server): ReturnType<http.Server['address']> => server.address();

const closeServer = (server: http.Server): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });

// ---------------------------------------------------------------------------
// The ordered-round stub
// ---------------------------------------------------------------------------

// Answer these literal bodies, in order; the LAST one repeats, so a run that asks more times
// than the script answers still settles instead of hanging. `requests` is the observation: the
// parsed body of every chat request the stub received.
export const startProvider = async (rounds: string[]): Promise<Stub> => {
    const requests: Record<string, any>[] = [];
    const scripted = rounds.slice();
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));

            const body = scripted[Math.min(requests.length - 1, scripted.length - 1)];

            response.setHeader('Content-Type', 'text/event-stream');
            response.statusCode = 200;
            response.end(body);
        });
    });

    const port = await listen(server);

    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => closeServer(server)
    };
};

// ---------------------------------------------------------------------------
// The scripted stub (what a lane suite runs on)
// ---------------------------------------------------------------------------

export type ScriptedStub = Stub & { turns: number };

export type ScriptedStubOptions = {
    // Words per streamed block. Together with `chunkDelayMs` this sets how long a turn stays
    // in flight, which is what the concurrency and progress sampling loops observe.
    chunks?: number;
    chunkDelayMs?: number;
    // The tool the first round asks for. It must be a name the shared toolbox declares on every
    // request (core visibility), so no discovery round is needed to make the call legal.
    tool?: string;
};

// Tool-call ids must be unique across a CONVERSATION (the core rejects a reused id before
// executing anything). A lane is rebuilt, reclaimed and restored across a session, so the id is
// derived from the transcript the request carries — the same rule the scripted fixture follows —
// rather than from a per-process counter the worker could never share.
const usedCallIds = (request: Record<string, any>): Set<string> => {
    const used = new Set<string>();

    for (const message of (request.messages ?? []) as Record<string, any>[]) {
        if (message.role !== 'assistant') continue;

        for (const call of (message.tool_calls ?? []) as Record<string, any>[]) used.add(String(call.id));
    }

    return used;
};

const nextCallId = (request: Record<string, any>, base: string): string => {
    const used = usedCallIds(request);

    for (let index = 1; ; index += 1) {
        const candidate = `${base}_${index}`;

        if (!used.has(candidate)) return candidate;
    }
};

const words = (count: number, label: string): string[] =>
    Array.from({ length: count }, (_, index) => `${label}${index} `);

// A loopback provider that behaves like the deleted scripted transport: round one streams text
// and asks for the tool, round two — the request whose trailing message is the tool result —
// streams an answer that quotes it. It decides from the REQUEST, not from a counter, so it
// answers correctly after a lane reclaim, a restore, or an interleaved second conversation.
export const startScriptedProvider = async (options: ScriptedStubOptions = {}): Promise<ScriptedStub> => {
    const chunkCount = options.chunks ?? 24;
    const chunkDelayMs = options.chunkDelayMs ?? 40;
    const toolName = options.tool ?? 'timeNow';
    const requests: Record<string, any>[] = [];
    let turns = 0;

    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            void handle(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        });

        const handle = async (body: Record<string, any>): Promise<void> => {
            requests.push(body);

            response.setHeader('Content-Type', 'text/event-stream');
            response.statusCode = 200;

            const messages = (body.messages ?? []) as Record<string, any>[];
            const last = messages[messages.length - 1];
            const afterTool = last !== undefined && last.role === 'tool' ? last : undefined;

            if (afterTool !== undefined) {
                // The answer round. It quotes the tool result so a suite can tell an EXECUTED
                // call from a refused one without reading the event stream.
                const text = `the tool returned ${String(afterTool.content ?? '')}`;

                for (const piece of [...words(chunkCount, 'answer'), text]) {
                    await sleep(chunkDelayMs);
                    writeFrame(response, sse({ choices: [{ delta: { content: piece } }] }));
                }

                turns += 1;
                writeFrame(response, sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
                response.end(DONE);

                return;
            }

            // The tool round: streamed text first, so the turn records real progress events, then
            // the call.
            for (const piece of words(chunkCount, 'thinking')) {
                await sleep(chunkDelayMs);
                writeFrame(response, sse({ choices: [{ delta: { content: piece } }] }));
            }

            writeFrame(
                response,
                sse({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: nextCallId(body, 'call_stub_tool'),
                                        type: 'function',
                                        function: { name: toolName, arguments: '{"timezone":"UTC"}' }
                                    }
                                ]
                            },
                            finish_reason: 'tool_calls'
                        }
                    ]
                })
            );

            response.end(DONE);
        };
    });

    const port = await listen(server);

    const stub: ScriptedStub = {
        origin: `http://127.0.0.1:${port}`,
        requests,
        get turns() {
            return turns;
        },
        close: () => closeServer(server)
    };

    return stub;
};

// The tool names one captured request was given, in the order the replica declared them (the
// OpenAI wire format nests the definition under `function`, src/transport/openai.ts).
export const requestedTools = (request: Record<string, any> | undefined): string[] =>
    ((request?.tools ?? []) as { function?: { name?: string } }[]).map((entry) => String(entry.function?.name));
