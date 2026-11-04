// T16: the durable half of the canonical contract.
//
// What is asserted, exactly:
//   1. `PATCH /sessions/{id} {title}` and a create-with-title reach `state.json` on the SESSION
//      record, so a rail that names a conversation still names it after a restart;
//   2. `PATCH /config {settings:{model}}` reaches the document's `globalSettings`, so an operator
//      change does not vanish on the next boot, and a fresh store + API reports the saved model as
//      its default (and a new session runs it);
//   3. the SECRET RULE: the api key never appears anywhere in the document, under any spelling -
//      a write that accepts `api_key` must not persist it;
//   4. a field that was never written stays absent, so a pre-T16 document keeps its exact shape.
//
// Cross-references:
//   - ./persistence.ts       — `HarnessSessionRecord.title`, `HarnessGlobalSettingsRecord`
//   - ./sessions.ts          — `renameSession`, `updateGlobalSettings`, restore seeding
//   - ./api.ts               — `PATCH /sessions/{id}`, `GET|PATCH /config`, `POST /sessions`
//   - ../server/persistence.test.ts — the same file-backed store pattern (real fs, no mocks)

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';

const ROOT = path.join(process.cwd(), 'Temp', 't16');

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-value',
    model: 'scripted/first'
};

const API_DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

const MOUNT = '/v1/harness';

const preset = (): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted durable-contract preset',
    requiresEndpoint: false,
    primary: 'worker',
    subagents: [],
    agents: ['worker'],
    tools: [],
    builtin: false,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                worker: agent({
                    model: settings.model,
                    instruction: 'Scripted durable test agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'ok' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'worker',
            presets: false,
            report: { progress }
        })
});

/** A fresh database root per case, under the repo's `Temp/` scratch area. */
const tempRoot = (label: string): string => {
    const root = path.join(ROOT, `durable-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(root, { recursive: true });

    return root;
};

const stateFile = (root: string): string => path.join(root, 'harness', HARNESS_DATABASE_FILE);

const openPair = (root: string, database?: Record<string, unknown>) => {
    const registry = createHarnessRegistry([preset()]);
    const store = new SessionStore(SETTINGS, registry, undefined, {
        persistence: new HarnessPersistence(root),
        ...(database === undefined ? {} : { database: database as never })
    });
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

    return { store, registry, api };
};

const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {}
): Promise<HarnessApiResult> =>
    api({
        method,
        pathname,
        mount: MOUNT,
        readBody: async <T,>() => body as T
    } as HarnessApiRequest);

const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

const readDocument = (root: string): Record<string, any> =>
    JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;

describe('durable canonical fields', () => {
    it('persists a session title on its record and restores it into the row', async () => {
        const root = tempRoot('title');
        const { api, store } = openPair(root);

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        // No title written yet: the field stays ABSENT (a pre-T16 document keeps its shape).
        expect('title' in created.body.session).toBe(false);
        expect('title' in readDocument(root).sessions[0]).toBe(false);

        const patched = jsonOf(await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}`, { title: '  Planning lane  ' }));

        expect(patched.status).toBe(200);
        expect(patched.body.session.title).toBe('Planning lane');

        // Durable BEFORE the answer: the document on disk already carries the trimmed title.
        expect(readDocument(root).sessions[0].title).toBe('Planning lane');

        // Re-open the process from that document: the row states the same title, with no map,
        // cache, or client resend involved.
        const reopened = openPair(root, readDocument(root));
        const row = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}`));

        expect(row.status).toBe(200);
        expect(row.body.session.title).toBe('Planning lane');
        expect(jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions`)).body.items[0].title).toBe('Planning lane');

        // A null clears it, durably.
        const cleared = jsonOf(await call(reopened.api, 'PATCH', `${MOUNT}/sessions/${sessionId}`, { title: null }));

        expect('title' in cleared.body.session).toBe(false);
        expect('title' in readDocument(root).sessions[0]).toBe(false);

        void store;
    });

    it('persists the operator global defaults and applies them to a restored process', async () => {
        const root = tempRoot('config');
        const { api } = openPair(root);

        const before = jsonOf(await call(api, 'GET', `${MOUNT}/config`));

        expect(before.body.defaults).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/first',
            has_api_key: true
        });
        // A deployment that never touched `/config` writes no document for it (a pure read never
        // persists, and a pre-T16 document keeps its exact shape).
        expect(fs.existsSync(stateFile(root))).toBe(false);

        const patched = jsonOf(await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/saved' } }));

        expect(patched.status).toBe(200);

        // The document carries the new default and NOTHING that looks like a credential.
        const document = readDocument(root);

        expect(document.globalSettings).toEqual({ model: 'scripted/saved' });
        expect(JSON.stringify(document)).not.toContain('server-secret-value');
        expect(JSON.stringify(document)).not.toMatch(/api_?key/i);

        // A restored process reports the saved default, and a session created in it runs it.
        const reopened = openPair(root, readDocument(root));

        expect(jsonOf(await call(reopened.api, 'GET', `${MOUNT}/config`)).body.defaults.model).toBe('scripted/saved');

        const created = jsonOf(await call(reopened.api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));

        expect(created.status).toBe(201);
        expect(created.body.session.model).toBe('scripted/saved');
        expect(created.body.session.endpoint).toEqual({
            base_url: 'http://scripted.invalid/v1',
            model: 'scripted/saved',
            has_api_key: true
        });

        // A write that SETS the key is accepted but never persisted (process-only by rule).
        const withKey = jsonOf(await call(reopened.api, 'PATCH', `${MOUNT}/config`, { settings: { api_key: 'rotated-secret' } }));

        expect(withKey.status).toBe(200);
        expect(withKey.body.defaults.has_api_key).toBe(true);
        expect(JSON.stringify(readDocument(root))).not.toContain('rotated-secret');
    });

    it('adopts a title supplied at create time and keeps the frozen definition untouched', async () => {
        const root = tempRoot('create-title');
        const { api } = openPair(root);

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker', title: 'From create' }));
        const sessionId = created.body.session.id as string;

        expect(created.body.session.title).toBe('From create');
        expect(readDocument(root).sessions[0].title).toBe('From create');

        // The frozen copy is per-session state and must NOT inherit a global default change: a
        // later `/config` PATCH moves future sessions only.
        await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/later' } });

        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.status).toBe(200);
        expect(definition.body.definition.name).toBe('worker');

        const stillFirst = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}`));

        expect(stillFirst.body.session.model).toBe('scripted/first');
    });
});
