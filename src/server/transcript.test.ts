// C4: per-thread transcript read/write + tolerant restore (server side).
//
// THE CONTRACT pinned here (design notes live in ./sessions.ts and ./api.ts):
//
//   1. A thread transcript is FULLY user-editable JSON. PUT installs a valid
//      value wholesale (harness `setThreadMessages`), the roster and the provider
//      request both see the replacement, and the write is durable before the
//      response.
//   2. A STRUCTURALLY INVALID value is a SUCCESSFUL write (200), not a 400: the
//      raw submission is recorded as unreadable, the live transcript becomes one
//      valid placeholder, and the response carries `transcript.invalid` plus
//      `session.invalidThreads`.
//   3. A later valid save clears both (and the durable record).
//   4. An unreadable transcript SURVIVES a restart: the session loads (it is NOT
//      dropped), the thread still exists with its placeholder, and the raw value
//      is still served for editing. That is what "the visualiser must still work"
//      needs, and it is checked over a REAL state.json with a FRESH runtime.
//   5. Status contract: unknown session/thread 404, running thread 409, absent
//      `messages` / non-object body 400, wrong method 405.
//   6. One broken THREAD is per-thread tolerance. A corrupt DOCUMENT (a `core`
//      that is not an object, a malformed `invalidThreads` map) stays fatal.
//
// The invalid-transcript error texts below are the EXACT messages
// `readHarnessMessages` (src/core/snapshot.ts) emits with the store's label,
// asserted verbatim so the wire text cannot drift silently.
//
// Conventions follow ./restore-isolation.test.ts and ./threads.test.ts: injected
// scripted presets, a real database root under the repo-root `Temp/C4/` scratch
// directory (never OS temp), no provider and no network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessProgress, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry, createToolCatalogue, createWebSearchCatalogueEntry } from './harnesses';
import { HarnessPersistenceError } from './persistence';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import type { SessionSnapshot, ThreadTranscriptResponse, UpdateThreadTranscriptResult } from './protocol';
import { SessionError } from './sessions';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
// Scratch roots for this task live under the repo-root `Temp/C4/` directory.
const SCRATCH_ROOT = path.join(REPO_ROOT, 'Temp', 'C4');

fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, `transcript-${label}-`));
    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
    hasApiKey: true
};

// Force the unconfigured search entry so behaviour never depends on a developer's
// environment (nor on a .env file).
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The seeded conversation. `instruction: 'sys'` seeds exactly ONE system message,
// so a host thread's stored transcript is short and fully known up front; a host
// thread's roster projection keeps assistant entries compact (role + content).
const SEEDED_TRANSCRIPT: HarnessMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer:hello' }
];

// The two refusal texts `readHarnessMessages` produces for the invalid values
// submitted below (verified against the reader, not guessed).
const BAD_ROLE = 'thread "thread-1" messages[0].role must be one of: system, user, assistant, tool.';
const NOT_AN_ARRAY = 'thread "thread-1" messages must be an array.';

// An unreadable thread's live transcript is a placeholder the STORE mints, so its
// exact text is part of the contract asserted here.
const placeholder = (error: string): HarnessMessage[] => [
    { role: 'system', content: `[transcript unreadable: ${error}]` }
];

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];

    return last === undefined ? '' : String(last.content);
};

// Project a recorded PROVIDER request down to role+content. The transport receives
// the full message objects (assistant entries carry model/stopReason metadata);
// the conversation's shape is what these assertions are about, and the projection
// is the one ./threads.test.ts uses for the same purpose.
const plain = (messages: readonly HarnessMessage[]): { role: string; content: string }[] =>
    messages.map((message) => ({ role: message.role, content: String(message.content) }));

// One scripted agent that RECORDS the transcript of every provider request — the
// direct proof that an edited transcript is what the model path actually sends —
// and optionally holds each request on a gate, which is how a RUNNING thread is
// observed without depending on wall-clock timing.
type Scripted = { preset: HarnessPreset; requests: HarnessMessage[][] };

const scriptedPreset = (name: string, hold?: () => Promise<void>): Scripted => {
    const requests: HarnessMessage[][] = [];

    const preset: HarnessPreset = {
        name,
        title: name,
        description: `${name} scripted preset`,
        requiresEndpoint: false,
        primary: name,
        subagents: [],
        agents: [name],
        tools: [],
        builtin: true,
        editable: true,
        create: (settings, progress: HarnessProgress) =>
            harness({
                agents: {
                    [name]: agent({
                        model: settings.model,
                        instruction: 'sys',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            // Detached copy, so a later transcript write cannot
                            // rewrite what this test recorded.
                            const copy = JSON.parse(JSON.stringify(request.messages)) as HarnessMessage[];
                            requests.push(copy);

                            if (hold !== undefined) await hold();

                            yield { type: 'text', delta: `answer:${lastUser(copy)}` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: name,
                presets: false,
                report: { progress }
            })
    };

    return { preset, requests };
};

const runtimeOf = (root: string, preset: HarnessPreset): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry([preset]),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

// The persisted document, kept UNTYPED: these tests tamper with and inspect raw
// JSON (that is what C4 is about), so narrowing it would hide the shape.
type StoredDocument = {
    version: number;
    savedAt: number;
    registry: unknown[];
    sessions: Record<string, any>[];
};

const readDocument = (root: string): StoredDocument =>
    JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as StoredDocument;

const writeDocument = (root: string, document: StoredDocument): void => {
    fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
};

// One stored session record, addressed by id (a missing id is a fixture bug, so
// it throws rather than skipping an assertion).
const storedSession = (root: string, id: string): Record<string, any> => {
    const session = readDocument(root).sessions.find((entry) => entry.id === id);
    if (session === undefined) throw new Error(`state.json holds no session "${id}".`);

    return session;
};

// The stored core snapshot of one session (the harness truth after a save).
const storedCore = (root: string, id: string): Record<string, any> => storedSession(root, id).core;

// The stored transcript of one thread, straight off disk.
const storedThreadMessages = (root: string, sessionId: string, threadId: string): unknown =>
    (storedCore(root, sessionId).threads as Record<string, any>[]).find((entry) => entry.id === threadId)!
        .messages;

// In-document variants of the two above, for tests that TAMPER with the parsed
// document before writing it back (a direct file edit is the C4 scenario).
const documentSession = (document: StoredDocument, id: string): Record<string, any> => {
    const session = document.sessions.find((entry) => entry.id === id);
    if (session === undefined) throw new Error(`the document holds no session "${id}".`);

    return session;
};

const documentThreads = (document: StoredDocument, id: string): Record<string, any>[] =>
    documentSession(document, id).core.threads as Record<string, any>[];

// HTTP-shaped call through the runtime dispatcher. `mount` defaults to the
// service mount; `/api` is exercised once to prove the dispatcher (not a
// per-mount route table) owns the new routes.
const callApi = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {},
    mount = '/v1/harness'
): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await runtime.api({
        method,
        pathname,
        mount,
        readBody: async <T>() => body as T
    });

    if (result.kind !== 'json') throw new Error(`expected a JSON answer from ${method} ${pathname}`);

    return { status: result.status, body: result.body as Record<string, unknown> };
};

const transcriptOf = (body: Record<string, unknown>): ThreadTranscriptResponse =>
    (body as { transcript: ThreadTranscriptResponse }).transcript;

const resultOf = (body: Record<string, unknown>): UpdateThreadTranscriptResult =>
    body as unknown as UpdateThreadTranscriptResult;

// Exact pretty-printed JSON the editor must receive (the store formats with
// `JSON.stringify(value, null, 2)`).
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const transcriptPath = (id: string, threadId = 'thread-1'): string =>
    `/v1/harness/sessions/${id}/threads/${threadId}/transcript`;

// Poll a condition on the 0-delay macrotask queue (the ./threads.test.ts
// convention) so "this run is in flight" is OBSERVED, not assumed.
const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

// D4: the strict store methods are async, so a refused write arrives as a REJECTION -
// an async helper is the only way to observe its status and message. Same contract, awaited.
const sessionErrorOf = async (run: () => unknown): Promise<{ status: number; message: string }> => {
    try {
        await run();
    } catch (error) {
        if (error instanceof SessionError) return { status: error.status, message: error.message };
        throw error;
    }

    throw new Error('expected the call to throw a SessionError.');
};

// D4: the strict store methods are async, so a refused write arrives as a REJECTION -
// an async helper is the only way to observe its status and message. Same contract, awaited.
const persistenceErrorOf = async (run: () => unknown): Promise<unknown> => {
    try {
        await run();
    } catch (error) {
        return error;
    }

    throw new Error('expected the runtime to throw.');
};

// One thread roster entry of a snapshot (every fixture here owns exactly one).
const threadOf = (snapshot: SessionSnapshot): Record<string, any> =>
    (snapshot.threads as Record<string, any>[])[0];

// One runtime whose `thread-1` holds SEEDED_TRANSCRIPT (one completed turn).
type Seeded = { root: string; runtime: HarnessRuntime; sessionId: string; requests: HarnessMessage[][] };

const seeded = async (label: string, scripted: Scripted = scriptedPreset('one')): Promise<Seeded> => {
    const root = tempRoot(label);
    const runtime = runtimeOf(root, scripted.preset);
    const created = await runtime.store.create('one');

    const task = await runtime.store.enqueue(created.id, 'hello');
    await task.settled;
    await runtime.store.waitForIdle(created.id);

    return { root, runtime, sessionId: created.id, requests: scripted.requests };
};

describe('thread transcript read/write (C4)', () => {
    it('serves the editable JSON of a readable transcript over GET on both mounts', async () => {
        const { runtime, sessionId, requests } = await seeded('get-valid');

        // The baseline every later assertion here is written against: the provider
        // received the seeded system message plus the prompt.
        expect(requests.map(plain)).toEqual([
            [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]
        ]);

        const got = await callApi(runtime, 'GET', transcriptPath(sessionId));
        expect(got.status).toBe(200);
        expect(transcriptOf(got.body)).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            messages: SEEDED_TRANSCRIPT,
            raw: pretty(SEEDED_TRANSCRIPT)
        });

        // The `/api` mount reaches the same store (dispatcher-level routing).
        const viaApi = await callApi(
            runtime,
            'GET',
            `/api/sessions/${sessionId}/threads/thread-1/transcript`,
            {},
            '/api'
        );
        expect(viaApi.status).toBe(200);
        expect(viaApi.body).toEqual(got.body);

        runtime.store.dispose();
    });

    it('replaces the transcript with a valid PUT, and the model path runs from the replacement', async () => {
        const { root, runtime, sessionId, requests } = await seeded('put-valid');

        const put = await callApi(runtime, 'PUT', transcriptPath(sessionId), {
            messages: [{ role: 'user', content: 'rewritten' }]
        });

        expect(put.status).toBe(200);
        expect(transcriptOf(put.body)).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            messages: [{ role: 'user', content: 'rewritten' }],
            // Exact editor text: key order and the 2-space indent are what the
            // user reads back after saving.
            raw: '[\n  {\n    "role": "user",\n    "content": "rewritten"\n  }\n]'
        });

        // A readable transcript carries no invalid marker anywhere.
        expect(resultOf(put.body).transcript.invalid).toBeUndefined();
        expect(resultOf(put.body).session.invalidThreads).toBeUndefined();
        expect(threadOf(resultOf(put.body).session).messages).toEqual([{ role: 'user', content: 'rewritten' }]);

        // Visible to the harness immediately (the roster is a live read), and
        // durable: the committed core snapshot holds the replacement.
        expect(threadOf(runtime.store.get(sessionId)).messages).toEqual([
            { role: 'user', content: 'rewritten' }
        ]);
        expect(storedThreadMessages(root, sessionId, 'thread-1')).toEqual([
            { role: 'user', content: 'rewritten' }
        ]);

        // The next turn of the SAME conversation starts from the edited value: the
        // request the provider actually receives is the replacement plus the new
        // prompt, with no trace of the discarded history.
        const continuation = await runtime.store.enqueue(sessionId, 'again', undefined, undefined, 'thread-1');
        await continuation.settled;
        await runtime.store.waitForIdle(sessionId);

        expect(plain(requests[1])).toEqual([
            { role: 'user', content: 'rewritten' },
            { role: 'user', content: 'again' }
        ]);
        expect(threadOf(runtime.store.get(sessionId)).messages).toEqual([
            { role: 'user', content: 'rewritten' },
            { role: 'user', content: 'again' },
            { role: 'assistant', content: 'answer:again' }
        ]);

        runtime.store.dispose();
    });

    it('accepts a structurally invalid transcript with 200 and reports it as unreadable', async () => {
        const { root, runtime, sessionId } = await seeded('put-invalid');

        const put = await callApi(runtime, 'PUT', transcriptPath(sessionId), {
            messages: [{ role: 'bogus', content: 'x' }]
        });

        expect(put.status).toBe(200);

        const result = resultOf(put.body);
        expect(result.transcript).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            // The live transcript is the placeholder: that is what this conversation
            // can legally run and restore with.
            messages: placeholder(BAD_ROLE),
            // `raw` is the submitted value VERBATIM (bad role included), so the
            // editor shows the user exactly what they wrote.
            raw: '[\n  {\n    "role": "bogus",\n    "content": "x"\n  }\n]',
            invalid: { error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }] }
        });

        // The snapshot reports the unreadable thread, keyed and sorted by id.
        expect(result.session.invalidThreads).toEqual([
            { id: 'thread-1', agent: 'one', error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }] }
        ]);
        expect(runtime.store.get(sessionId).invalidThreads).toEqual(result.session.invalidThreads);

        // The roster still addresses the thread (the visualiser keeps working).
        expect(threadOf(result.session).id).toBe('thread-1');
        expect(threadOf(result.session).status).toBe('idle');

        // And this is the durable record, not only the response.
        expect(storedSession(root, sessionId).invalidThreads).toEqual({
            'thread-1': { error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }], agent: 'one' }
        });
        expect(storedThreadMessages(root, sessionId, 'thread-1')).toEqual(placeholder(BAD_ROLE));

        runtime.store.dispose();
    });

    it('accepts a value that is not an array, and a later valid save clears everything', async () => {
        const { root, runtime, sessionId } = await seeded('put-not-array');

        const put = await callApi(runtime, 'PUT', transcriptPath(sessionId), {
            messages: { not: 'an array' }
        });

        expect(put.status).toBe(200);

        const result = resultOf(put.body);
        expect(result.transcript.raw).toBe('{\n  "not": "an array"\n}');
        expect(result.transcript.invalid).toEqual({
            error: NOT_AN_ARRAY,
            messages: { not: 'an array' }
        });
        expect(result.transcript.messages).toEqual(placeholder(NOT_AN_ARRAY));
        expect(result.session.invalidThreads).toEqual([
            { id: 'thread-1', agent: 'one', error: NOT_AN_ARRAY, messages: { not: 'an array' } }
        ]);

        // An empty array is a VALID transcript (it is what the editor clears to).
        const cleared = await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: [] });
        expect(cleared.status).toBe(200);
        expect(resultOf(cleared.body).transcript).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            messages: [],
            raw: '[]'
        });
        expect(resultOf(cleared.body).session.invalidThreads).toBeUndefined();
        expect(runtime.store.get(sessionId).invalidThreads).toBeUndefined();

        // A repaired document does not keep the raw record it no longer needs.
        expect(storedSession(root, sessionId).invalidThreads).toBeUndefined();
        expect(storedThreadMessages(root, sessionId, 'thread-1')).toEqual([]);

        runtime.store.dispose();
    });

    it('serves the raw value and the error for an unreadable thread after a restart', async () => {
        const { root, runtime, sessionId } = await seeded('get-invalid');

        await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: 'broken' });
        runtime.store.dispose();

        // A FRESH runtime reads the persisted placeholder + raw value back.
        const second = runtimeOf(root, scriptedPreset('one').preset);
        const snapshot = second.store.get(sessionId);

        expect(second.store.restoreErrors).toEqual([]);
        expect(threadOf(snapshot).messages).toEqual(placeholder(NOT_AN_ARRAY));
        expect(snapshot.invalidThreads).toEqual([
            { id: 'thread-1', agent: 'one', error: NOT_AN_ARRAY, messages: 'broken' }
        ]);

        const got = await callApi(second, 'GET', transcriptPath(sessionId));
        expect(got.status).toBe(200);
        expect(transcriptOf(got.body)).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            messages: placeholder(NOT_AN_ARRAY),
            raw: '"broken"',
            invalid: { error: NOT_AN_ARRAY, messages: 'broken' }
        });

        // The thread is still addressable and still runnable after the restart: a
        // broken transcript never takes the conversation down with it.
        const continuation = await second.store.enqueue(sessionId, 'still here', undefined, undefined, 'thread-1');
        await continuation.settled;
        await second.store.waitForIdle(sessionId);

        expect(threadOf(second.store.get(sessionId)).messages).toEqual([
            ...placeholder(NOT_AN_ARRAY),
            { role: 'user', content: 'still here' },
            { role: 'assistant', content: 'answer:still here' }
        ]);

        second.store.dispose();
    });

    it('round-trips an unreadable transcript through a restart without dropping the session', async () => {
        const { root, runtime, sessionId } = await seeded('persist-invalid');

        await callApi(runtime, 'PUT', transcriptPath(sessionId), {
            messages: [{ role: 'bogus', content: 'x' }]
        });

        // The operator's raw text is IN the file, beside the placeholder core.
        const written = fs.readFileSync(stateFile(root), 'utf8');
        expect(written).toContain('"invalidThreads"');
        expect(written).toContain('"bogus"');

        runtime.store.dispose();

        const second = runtimeOf(root, scriptedPreset('one').preset);

        // Not dropped, and not reported as a restore failure.
        expect(second.store.restoreErrors).toEqual([]);
        expect(second.store.list().map((session) => session.id)).toEqual([sessionId]);

        const restored = second.store.get(sessionId);
        expect(restored.turns.map((turn) => [turn.index, turn.prompt, turn.status])).toEqual([
            [0, 'hello', 'done']
        ]);
        expect(threadOf(restored).id).toBe('thread-1');
        expect(threadOf(restored).messages).toEqual(placeholder(BAD_ROLE));
        expect(restored.invalidThreads).toEqual([
            { id: 'thread-1', agent: 'one', error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }] }
        ]);

        // A fix submitted after the restart clears the record for good — including
        // on disk.
        const repaired = await callApi(second, 'PUT', transcriptPath(sessionId), {
            messages: [{ role: 'user', content: 'fixed after restart' }]
        });

        expect(resultOf(repaired.body).transcript.invalid).toBeUndefined();
        expect(fs.readFileSync(stateFile(root), 'utf8')).not.toContain('invalidThreads');

        // Third process: the repaired session loads with nothing unreadable.
        second.store.dispose();
        const third = runtimeOf(root, scriptedPreset('one').preset);
        expect(third.store.get(sessionId).invalidThreads).toBeUndefined();
        expect(threadOf(third.store.get(sessionId)).messages).toEqual([
            { role: 'user', content: 'fixed after restart' }
        ]);
        third.store.dispose();
    });

    it('tolerates a transcript broken by hand in state.json and captures the raw value', async () => {
        const { root, runtime, sessionId } = await seeded('hand-edit');
        runtime.store.dispose();

        // The exact failure this task exists for: the user replaces a thread's
        // `messages` with JSON that is not a transcript, and nothing recorded it
        // as unreadable (an older build, or a direct file edit).
        const document = readDocument(root);
        documentThreads(document, sessionId)[0].messages = [{ role: 'bogus', content: 'x' }];
        writeDocument(root, document);

        const second = runtimeOf(root, scriptedPreset('one').preset);

        // The session LOADS — it is not dropped — and its other records survive.
        expect(second.store.restoreErrors).toEqual([]);
        expect(second.store.list().map((entry) => entry.id)).toEqual([sessionId]);

        const restored = second.store.get(sessionId);
        expect(threadOf(restored).messages).toEqual(placeholder(BAD_ROLE));
        expect(restored.invalidThreads).toEqual([
            { id: 'thread-1', agent: 'one', error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }] }
        ]);
        expect(restored.turns.map((turn) => turn.prompt)).toEqual(['hello']);

        second.store.dispose();
    });

    it('drops a stale unreadable record whose thread was repaired by hand', async () => {
        const { root, runtime, sessionId } = await seeded('stale-entry');

        await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: 'broken' });
        runtime.store.dispose();

        // The operator edits the THREAD's messages inside `core` into something
        // valid (not the placeholder), leaving the old raw record behind.
        const document = readDocument(root);
        documentThreads(document, sessionId)[0].messages = [{ role: 'user', content: 'hand repaired' }];
        writeDocument(root, document);

        const second = runtimeOf(root, scriptedPreset('one').preset);

        expect(second.store.restoreErrors).toEqual([]);
        expect(threadOf(second.store.get(sessionId)).messages).toEqual([
            { role: 'user', content: 'hand repaired' }
        ]);
        // The persisted raw value no longer describes the transcript, so it is gone.
        expect(second.store.get(sessionId).invalidThreads).toBeUndefined();

        second.store.dispose();
    });

    // C8-m3: an unreadable DEFAULT conversation (`agent:<name>`) survived a live PUT
    // but was silently lost across a restart. `updateThreadTranscript` accepts those
    // ids, yet tolerant restore only revalidated ids present in `core.threads` — and
    // the persisted thread list is host-only (src/core/snapshot.ts refuses an `agent:`
    // id there), so the raw value was dropped and the placeholder started reading as
    // the conversation's real history.
    it('keeps an unreadable DEFAULT conversation transcript across a restart', async () => {
        const DEFAULT_NOT_ARRAY = 'thread "agent:one" messages must be an array.';
        const { root, runtime, sessionId } = await seeded('default-invalid');

        // The default conversation IS addressable by its `agent:<name>` id, and an
        // invalid submission is accepted exactly like a host thread's.
        const put = await callApi(runtime, 'PUT', transcriptPath(sessionId, 'agent:one'), {
            messages: 'broken'
        });

        expect(put.status).toBe(200);
        expect(transcriptOf(put.body)).toEqual({
            threadId: 'agent:one',
            agent: 'one',
            messages: placeholder(DEFAULT_NOT_ARRAY),
            raw: '"broken"',
            invalid: { error: DEFAULT_NOT_ARRAY, messages: 'broken' }
        });

        // Durable BEFORE the restart, too.
        expect(storedSession(root, sessionId).invalidThreads).toEqual({
            'agent:one': { error: DEFAULT_NOT_ARRAY, messages: 'broken', agent: 'one' }
        });

        runtime.store.dispose();

        const second = runtimeOf(root, scriptedPreset('one').preset);
        expect(second.store.restoreErrors).toEqual([]);

        const restored = second.store.get(sessionId);

        // The RAW value is still carried, and the live default transcript is still the
        // placeholder (not a "readable" conversation that never said anything).
        expect(restored.invalidThreads).toEqual([
            { id: 'agent:one', agent: 'one', error: DEFAULT_NOT_ARRAY, messages: 'broken' }
        ]);
        expect(restored.messages).toEqual(placeholder(DEFAULT_NOT_ARRAY));

        const got = await callApi(second, 'GET', transcriptPath(sessionId, 'agent:one'));
        expect(got.status).toBe(200);
        expect(transcriptOf(got.body)).toEqual({
            threadId: 'agent:one',
            agent: 'one',
            messages: placeholder(DEFAULT_NOT_ARRAY),
            raw: '"broken"',
            invalid: { error: DEFAULT_NOT_ARRAY, messages: 'broken' }
        });

        // A fix submitted after the restart clears the record for good, on disk as
        // well as in memory (the same lifecycle a host thread has).
        const repaired = await callApi(second, 'PUT', transcriptPath(sessionId, 'agent:one'), {
            messages: [{ role: 'user', content: 'fixed after restart' }]
        });

        expect(resultOf(repaired.body).transcript.invalid).toBeUndefined();
        expect(fs.readFileSync(stateFile(root), 'utf8')).not.toContain('invalidThreads');
        expect(second.store.get(sessionId).messages).toEqual([
            { role: 'user', content: 'fixed after restart' }
        ]);

        second.store.dispose();
    });

    // C8-m3 boundary: keeping the raw record for a DEFAULT conversation must NOT
    // soften the documented strictness of a hand-edited agent transcript. A broken
    // `core.agents[name].messages` in the file is still a refused restore, because a
    // placeholder there would silently rewrite the session's primary conversation.
    it('still drops a session whose DEFAULT transcript was broken by hand in the file', async () => {
        const { root, runtime, sessionId } = await seeded('default-hand-edit');
        runtime.store.dispose();

        const document = readDocument(root);
        documentSession(document, sessionId).core.agents.one.messages = [{ role: 'bogus', content: 'x' }];
        writeDocument(root, document);

        const second = runtimeOf(root, scriptedPreset('one').preset);

        // Not tolerated, and reported — the session is DROPPED, exactly as before.
        expect(second.store.list().map((entry) => entry.id)).toEqual([]);
        expect(second.store.restoreErrors).toHaveLength(1);
        expect(String(second.store.restoreErrors[0])).toContain('messages[0].role');

        second.store.dispose();
    });

    // C8-m7: the raw unreadable value used to be stored AND returned by reference, so
    // an in-process caller (the API body object, a host tool, a test) could rewrite
    // server state through a value it merely read.
    it('stores and serves the raw invalid value by value, not by reference', async () => {
        const { root, runtime, sessionId } = await seeded('invalid-by-reference');

        // A caller-held object, exactly what `PUT` hands the store.
        const submitted = [{ role: 'bogus', content: 'x' }];
        const put = await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: submitted });

        expect(put.status).toBe(200);
        expect(resultOf(put.body).transcript.invalid).toEqual({
            error: BAD_ROLE,
            messages: [{ role: 'bogus', content: 'x' }]
        });

        // Writing through the CALLER's array after the fact cannot rewrite the record.
        submitted[0].content = 'mutated by the writer';
        submitted.push({ role: 'also-bogus', content: 'y' });

        // And neither can writing through the value the READER was handed.
        const first = await callApi(runtime, 'GET', transcriptPath(sessionId));
        const invalid = transcriptOf(first.body).invalid;

        if (invalid === undefined) throw new Error('expected an unreadable transcript');
        expect(invalid.messages).not.toBe(submitted);

        (invalid.messages as unknown as Record<string, unknown>).mutated = true;
        (invalid.messages as unknown as { content: string }[])[0].content = 'mutated by the reader';

        const again = await callApi(runtime, 'GET', transcriptPath(sessionId));
        expect(transcriptOf(again.body)).toEqual({
            threadId: 'thread-1',
            agent: 'one',
            messages: placeholder(BAD_ROLE),
            raw: pretty([{ role: 'bogus', content: 'x' }]),
            invalid: { error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }] }
        });

        // The snapshot projection hands out a copy as well, and the durable document
        // still carries exactly what was submitted.
        const snapshot = runtime.store.get(sessionId);
        const projected = snapshot.invalidThreads?.[0];

        expect(projected?.messages).toEqual([{ role: 'bogus', content: 'x' }]);
        if (projected !== undefined) (projected.messages as unknown as { content: string }[])[0].content = 'reader';
        expect(runtime.store.get(sessionId).invalidThreads?.[0]?.messages).toEqual([
            { role: 'bogus', content: 'x' }
        ]);

        expect(storedSession(root, sessionId).invalidThreads).toEqual({
            'thread-1': { error: BAD_ROLE, messages: [{ role: 'bogus', content: 'x' }], agent: 'one' }
        });

        runtime.store.dispose();
    });

    it('drops the unreadable record of a deleted thread from the durable document', async () => {
        const { root, runtime, sessionId } = await seeded('delete-invalid');

        await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: 'broken' });
        expect(storedSession(root, sessionId).invalidThreads).toBeDefined();

        const deleted = await callApi(runtime, 'DELETE', `/v1/harness/sessions/${sessionId}/threads/thread-1`);
        expect(deleted.status).toBe(200);

        const snapshot = runtime.store.get(sessionId);
        expect(snapshot.threads).toBeUndefined();
        expect(snapshot.invalidThreads).toBeUndefined();

        // The file matches memory: no orphaned raw value for a vanished thread.
        expect(storedSession(root, sessionId).invalidThreads).toBeUndefined();

        runtime.store.dispose();
    });
});

describe('thread transcript route status contract (C4)', () => {
    it('answers 404 for an unknown thread and an unknown session', async () => {
        const { runtime, sessionId } = await seeded('not-found');

        const missingGet = await callApi(runtime, 'GET', transcriptPath(sessionId, 'thread-9'));
        expect(missingGet.status).toBe(404);
        expect(missingGet.body).toEqual({ error: { message: 'Unknown thread "thread-9".' } });

        const missingPut = await callApi(runtime, 'PUT', transcriptPath(sessionId, 'thread-9'), {
            messages: []
        });
        expect(missingPut.status).toBe(404);
        expect(missingPut.body).toEqual({ error: { message: 'Unknown thread "thread-9".' } });

        const unknownSession = await callApi(
            runtime,
            'PUT',
            '/v1/harness/sessions/none/threads/thread-1/transcript',
            { messages: [] }
        );
        expect(unknownSession.status).toBe(404);
        expect(unknownSession.body).toEqual({ error: { message: 'Unknown session "none".' } });

        const unknownSessionGet = await callApi(
            runtime,
            'GET',
            '/v1/harness/sessions/none/threads/thread-1/transcript'
        );
        expect(unknownSessionGet.status).toBe(404);
        expect(unknownSessionGet.body).toEqual({ error: { message: 'Unknown session "none".' } });

        runtime.store.dispose();
    });

    it('answers 400 for an absent messages field and a non-object body, and 405 for a wrong method', async () => {
        const { runtime, sessionId } = await seeded('bad-request');

        const absent = await callApi(runtime, 'PUT', transcriptPath(sessionId), {});
        expect(absent.status).toBe(400);
        expect(absent.body).toEqual({
            error: { message: 'A transcript update requires a `messages` value.' }
        });

        const nullMessages = await callApi(runtime, 'PUT', transcriptPath(sessionId), { messages: null });
        expect(nullMessages.status).toBe(200);
        expect(resultOf(nullMessages.body).transcript.invalid).toEqual({
            error: NOT_AN_ARRAY,
            messages: null
        });

        const arrayBody = await callApi(runtime, 'PUT', transcriptPath(sessionId), []);
        expect(arrayBody.status).toBe(400);
        expect(arrayBody.body).toEqual({
            error: { message: 'The request body must be a JSON object.' }
        });

        const wrongMethod = await callApi(runtime, 'POST', transcriptPath(sessionId), { messages: [] });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.body).toEqual({
            error: { message: 'Use GET or PUT for /v1/harness/sessions/:id/threads/:threadId/transcript.' }
        });

        // Nothing above touched the seeded conversation except the accepted
        // `messages: null` save, which the readable save below repairs.
        const repaired = await callApi(runtime, 'PUT', transcriptPath(sessionId), {
            messages: SEEDED_TRANSCRIPT
        });
        expect(resultOf(repaired.body).transcript.messages).toEqual(SEEDED_TRANSCRIPT);

        runtime.store.dispose();
    });

    it('answers 409 while the thread is running, and the write lands once it settles', async () => {
        const root = tempRoot('running');

        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        const scripted = scriptedPreset('one', () => held);
        const runtime = runtimeOf(root, scripted.preset);
        const created = await runtime.store.create('one');

        // Submit WITHOUT awaiting, then observe the run becoming live.
        await runtime.store.enqueue(created.id, 'hold');
        await waitUntil(() => threadOf(runtime.store.get(created.id)).status === 'running');

        const busy = await callApi(runtime, 'PUT', transcriptPath(created.id), {
            messages: [{ role: 'user', content: 'too late' }]
        });
        expect(busy.status).toBe(409);
        expect(busy.body).toEqual({
            error: { message: 'Thread "thread-1" is running; stop it before replacing its transcript.' }
        });

        // Reading stays available while the thread runs (the editor can refresh).
        const readable = await callApi(runtime, 'GET', transcriptPath(created.id));
        expect(readable.status).toBe(200);

        // Release the transport; the same write then lands.
        release();
        await waitUntil(() => threadOf(runtime.store.get(created.id)).status === 'idle');

        const settled = await callApi(runtime, 'PUT', transcriptPath(created.id), {
            messages: [{ role: 'user', content: 'after the run' }]
        });
        expect(settled.status).toBe(200);
        expect(threadOf(runtime.store.get(created.id)).messages).toEqual([
            { role: 'user', content: 'after the run' }
        ]);

        runtime.store.dispose();
    });

    it('throws the same statuses from the store methods the routes call', async () => {
        const { runtime, sessionId } = await seeded('store-contract');

        expect((await sessionErrorOf(async () => await runtime.store.updateThreadTranscript('none', 'thread-1', []))).status).toBe(
            404
        );
        expect(
            (await sessionErrorOf(async () => await runtime.store.updateThreadTranscript(sessionId, 'thread-9', []))).status
        ).toBe(404);
        expect((await sessionErrorOf(() => runtime.store.threadTranscript('none', 'thread-1'))).status).toBe(404);
        expect((await sessionErrorOf(() => runtime.store.threadTranscript(sessionId, 'thread-9'))).message).toBe(
            'Unknown thread "thread-9".'
        );

        // A stopped conversation is still editable — that IS the repair path.
        await runtime.store.cancelThread(sessionId, 'thread-1');
        expect(threadOf(runtime.store.get(sessionId)).status).toBe('stopped');

        const stopped = await runtime.store.updateThreadTranscript(sessionId, 'thread-1', [
            { role: 'user', content: 'repaired while stopped' }
        ]);
        expect(stopped.transcript.messages).toEqual([{ role: 'user', content: 'repaired while stopped' }]);
        expect(threadOf(stopped.session).status).toBe('stopped');

        runtime.store.dispose();
    });
});

describe('document-level corruption stays fatal (C4 regression)', () => {
    it('still aborts startup for an unreadable core and for a malformed invalidThreads map', async () => {
        const { root, runtime, sessionId } = await seeded('fatal');
        const written = fs.readFileSync(stateFile(root), 'utf8');
        runtime.store.dispose();

        // 1. The pre-existing fatal case: `core` is not an object at all. A
        //    document-level shape failure is corruption, not a per-thread repair.
        const document = readDocument(root);
        documentSession(document, sessionId).core = 'not-a-snapshot';
        writeDocument(root, document);

        const corrupted = await persistenceErrorOf(() => runtimeOf(root, scriptedPreset('one').preset));
        expect(corrupted).toBeInstanceOf(HarnessPersistenceError);
        expect((corrupted as Error).message).toBe(
            `${stateFile(root)}: The harness database has an invalid shape or version: ` +
                'sessions[0].core must be an object.'
        );
        // A fatal load never rewrites the operator's file.
        expect(fs.readFileSync(stateFile(root), 'utf8')).toContain('"core": "not-a-snapshot"');

        // 2. The new OPTIONAL field is validated when present: an `invalidThreads`
        //    entry whose `error` is not a string is document corruption.
        fs.writeFileSync(stateFile(root), written, 'utf8');
        const restored = readDocument(root);
        documentSession(restored, sessionId).invalidThreads = { 'thread-1': { error: 7, messages: [] } };
        writeDocument(root, restored);

        const malformed = await persistenceErrorOf(() => runtimeOf(root, scriptedPreset('one').preset));
        expect(malformed).toBeInstanceOf(HarnessPersistenceError);
        expect((malformed as Error).message).toBe(
            `${stateFile(root)}: The harness database has an invalid shape or version: ` +
                'sessions[0].invalidThreads.thread-1.error must be a string.'
        );

        // 3. A map that is not an object is corruption too (the reader refuses it
        //    exactly like every other map field).
        const notAMap = readDocument(root);
        documentSession(notAMap, sessionId).invalidThreads = 'broken';
        writeDocument(root, notAMap);

        const shaped = await persistenceErrorOf(() => runtimeOf(root, scriptedPreset('one').preset));
        expect(shaped).toBeInstanceOf(HarnessPersistenceError);
        expect((shaped as Error).message).toBe(
            `${stateFile(root)}: The harness database has an invalid shape or version: ` +
                'sessions[0].invalidThreads must be an object.'
        );
    });

    it('keeps loading a document that has no invalidThreads field at all', async () => {
        // The field is OPTIONAL in both directions: a pre-C4 document (and a
        // healthy C4 one) round-trips without it.
        const { root, runtime, sessionId } = await seeded('no-field');
        expect(storedSession(root, sessionId).invalidThreads).toBeUndefined();

        runtime.store.dispose();

        const second = runtimeOf(root, scriptedPreset('one').preset);
        expect(second.store.restoreErrors).toEqual([]);
        expect(second.store.get(sessionId).invalidThreads).toBeUndefined();
        expect(threadOf(second.store.get(sessionId)).messages).toEqual(SEEDED_TRANSCRIPT);

        second.store.dispose();
    });
});
