// T27: session-scoped AGENT BINDINGS, end to end.
//
// What this file pins down, in the order the layers are actually reached:
//   1. `POST /sessions/{id}/agents` is a real write (it used to answer 403): the member joins
//      the LIVE roster, the roster read reports it with `origin: "session"`, and the receipt is
//      the same bounded row an identified read returns;
//   2. `PATCH .../agents/{id} {instruction}` changes ONLY the leading system block of that one
//      member — the rest of its transcript is byte-identical afterwards, which is the whole
//      point of not resetting history to retune a prompt;
//   3. protection and isolation: the primary cannot be detached, a non-member is a 404, a
//      binding does not leak into another session of the same store, and a retired profile
//      cannot be newly selected;
//   4. DURABILITY, the part every earlier in-memory test could fake: a SECOND process opened
//      from `<root>/harness/state.json` through `HarnessPersistence.load()` — the reader, not a
//      raw document injection — still has the bound member, still runs the overridden
//      instruction text, and still names the conversation (the `title` field this owner also
//      fixed in `readSessionRecord`) and keeps the operator defaults (`globalSettings` in
//      `readHarnessDatabase`).
//
// Cross-references:
//   - ../harness.ts              — addAgent / removeAgent / setAgentInstruction and their gate
//   - ./sessions.ts              — addSessionAgent / removeSessionAgent / setSessionAgentInstruction
//   - ./api.ts                   — the three routes and their revisions/events
//   - ./api-reads.ts             — `sessionAgentRowsOf` (`origin` from `record.sessionAgents`)
//   - ./persistence.ts           — readSessionRecord (title, sessionAgents) / readHarnessDatabase
//   - ./api-durable.test.ts      — the fixture shape this file reuses (real fs, no mocks)

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent, harness } from '../harness';
import { agentInstruction } from '../agents';
import { effectiveAgentProfile } from './harnesses/agent-state';
import { createHarnessRegistry } from './harnesses';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';

const ROOT = path.join(process.cwd(), 'Temp', 't27');
const MOUNT = '/v1/harness';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-value',
    model: 'scripted/first'
};

const API_DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

// The agent this file binds into a session. It is a trusted PROFILE id (the identity rule below
// refuses anything else), and `instruct`'s shipped team does not contain it, so the bind is a
// real change to the roster rather than a no-op.
const BINDING = 'summarizer';

const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {}
): Promise<HarnessApiResult> =>
    api({ method, pathname, mount: MOUNT, readBody: async <T,>() => body as T } as HarnessApiRequest);

const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

/** A fresh database root per case, under the repo's `Temp/` scratch area. */
const tempRoot = (label: string): string => {
    const root = path.join(ROOT, `agents-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(root, { recursive: true });

    return root;
};

const stateFile = (root: string): string => path.join(root, 'harness', HARNESS_DATABASE_FILE);

const readDocument = (root: string): Record<string, any> =>
    JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;

// An in-memory pair (no database root) for the behavior cases, and a file-backed one for the
// restart case.
//
// WHY A CUSTOM NARROW PRESET, AND WHY `template: 'live'`
// ------------------------------------------------------
// Every SHIPPED live preset's team is `teamOf(primary)` — every other role plus the summarizer
// (./harnesses/presets.ts:132) — so a session created from the shipped catalogue already contains
// every trusted profile and there is nothing left to bind. A one-member preset makes the bind a
// real roster change.
//
// `template: 'live'` is what makes the durability half testable at all: a session-local binding
// is durable inside the session's own preset copy, and `presetFromRecord` can only rebuild a team
// from a record whose template says 'live' (a 'scripted' record replays a shipped factory and
// ignores the saved team, and a template-less record needs its injected factory back). The
// scripted `create` below is what the FIRST process runs; after a restart the record rebuilds the
// same team through the real profiled factory, which is exactly the path under test.
const narrowPreset = (): HarnessPreset => ({
    name: 'instruct',
    title: 'Instruct',
    description: 'Single-role fixture for the session binding contract.',
    requiresEndpoint: false,
    template: 'live',
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: [],
    builtin: false,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                instruct: agent({
                    model: settings.model,
                    instruction: 'Fixture agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'ok' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'instruct',
            presets: false,
            report: { progress }
        })
});

const openInMemory = () => {
    const registry = createHarnessRegistry([narrowPreset()]);
    const store = new SessionStore(SETTINGS, registry);
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

    return { api, store, registry };
};

const openOnDisk = (root: string) => {
    const persistence = new HarnessPersistence(root);
    const restoreProblems: string[] = [];

    // A REAL restart: `load()` runs `readHarnessDatabase`, i.e. the validators that used to drop
    // `title` and `globalSettings`. `options.database` is the already-validated form, so passing
    // a hand-parsed object would bypass exactly the code under test.
    const database = persistence.load();
    const registry = createHarnessRegistry([narrowPreset()]);
    const store = new SessionStore(SETTINGS, registry, undefined, {
        persistence,
        database: database ?? undefined,
        // A dropped restore is normally a log line; here it is an assertion target, because a
        // session that silently fails to reload turns every later read into a 404.
        onRestoreError: (error) => restoreProblems.push(error.message)
    });
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

    return { api, store, registry, persistence, restoreProblems };
};

const createSession = async (api: ReturnType<typeof createHarnessApi>, title?: string): Promise<string> => {
    const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'instruct', ...(title === undefined ? {} : { title }) }));

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

describe('session agent bindings', () => {
    it('binds a trusted profile into one session and reports it as a session-scoped row', async () => {
        const { api } = openInMemory();
        const sessionId = await createSession(api);

        const before = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(before.status).toBe(200);
        expect(before.body.agents.map((row: Record<string, any>) => row.agent_id)).not.toContain(BINDING);

        const bound = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                name: BINDING,
                profile: BINDING,
                model: 'scripted/bound',
                instruction: 'Compress the answer into one paragraph.'
            })
        );

        expect(bound.status).toBe(201);

        // The exact row, every field named. `origin` is what separates this member from the ones
        // the definition shipped, `role: subagent` is the structural consequence of the primary
        // staying put, and `inherited_model` is the CREATION baseline (the session's model), not
        // the override — which is the distinction the contract's `inherited_model` exists for.
        const { revision, instruction_chars, guidelines_count, restorable, ...binding } = bound.body.agent;

        expect(binding).toEqual({
            agent_id: BINDING,
            profile: BINDING,
            role: 'subagent',
            origin: 'session',
            model: 'scripted/bound',
            inherited_model: 'scripted/first',
            instruction_source: 'harness',
            has_instruction_override: true,
            editable: true,
            deletable: true
        });
        expect(typeof revision).toBe('number');
        expect(restorable).toBe(true);
        expect(typeof instruction_chars).toBe('number');
        expect(guidelines_count).toBe(1);

        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.total).toBe(before.body.total + 1);
        expect(roster.body.agents.map((row: Record<string, any>) => row.agent_id)).toContain(BINDING);

        // The instruction subresource states the text this member ACTUALLY runs: the override
        // plus the profile's trusted guidelines, composed by the one function that joins them
        // (`agentInstruction`, src/agents/index.ts:113) — the same composition a restart replays.
        const instruction = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${BINDING}/instruction`)
        );
        const profile = effectiveAgentProfile(BINDING)!;

        expect(instruction.status).toBe(200);
        expect(instruction.body.instruction).toBe(
            agentInstruction(profile, 'Compress the answer into one paragraph.')
        );
        expect(instruction.body.source).toBe('harness');
        expect(instruction.body.chars).toBe(instruction.body.instruction.length);

        // A second bind of the same profile is a conflict, not a duplicate row.
        expect(
            (await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING })).status
        ).toBe(409);
    });

    it('keeps a binding out of every other session of the same store', async () => {
        const { api } = openInMemory();
        const first = await createSession(api);
        const second = await createSession(api);

        expect(
            (await call(api, 'POST', `${MOUNT}/sessions/${first}/agents`, { name: BINDING })).status
        ).toBe(201);

        const other = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${second}/agents`));

        expect(other.body.agents.map((row: Record<string, any>) => row.agent_id)).not.toContain(BINDING);

        // The shared registry is untouched: a session binding is session state, and the harness
        // card every session reports still lists what it shipped with.
        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${second}/definition`));

        expect(definition.body.definition.agents).not.toContain(BINDING);
    });

    it('replaces only the leading system block when a member already has committed history', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        // Seed a conversation on the live brain the way a turn would: one system message from the
        // profile, then committed turns. `messages` is the live array the handle exposes, so the
        // store's edit and this assertion read the same object.
        const record = store.liveSession(sessionId);
        const primary = record.definition.primary as string;
        const brain = record.harness.agents[primary];
        const seededInstructionLength = brain.instructions.length;

        brain.user('What changed?');
        brain.assistant('Nothing yet.');

        const history = JSON.parse(JSON.stringify(brain.messages)) as unknown[];

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${primary}`, {
                instruction: 'Answer in exactly two sentences.'
            })
        );

        expect(patched.status).toBe(200);
        expect(patched.body.agent.instruction_source).toBe('harness');

        // The leading block is exactly one message now, and every message after it is byte for
        // byte what was there before: no reset, no reseed of the conversation. The stored text is
        // the COMPOSED prompt (override + the profile's trusted guidelines), because
        // `agentInstruction` is the single place that joins them and a restart feeds the raw
        // override through the same call — live and rebuilt must agree character for character.
        const composed = agentInstruction(effectiveAgentProfile(primary)!, 'Answer in exactly two sentences.');

        expect(brain.instructions).toEqual([composed]);
        expect(brain.messages[0]).toEqual({ role: 'system', content: composed });
        expect(brain.messages.length).toBe(history.length - seededInstructionLength + 1);
        expect(JSON.parse(JSON.stringify(brain.messages.slice(1)))).toEqual(history.slice(seededInstructionLength));

        // The recorded turns of the session are untouched by a prompt change.
        expect(store.liveSession(sessionId).turns).toEqual([]);

        // `null` clears the session override and restores the deployment's effective profile
        // text, which is the same string the next build composes from the same profile.
        const cleared = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${primary}/instruction`, {
                instruction: null
            })
        );

        expect(cleared.status).toBe(200);
        expect(cleared.body.instruction).toBe(agentInstruction(effectiveAgentProfile(primary)!));
        expect(brain.messages[0].content).toBe(agentInstruction(effectiveAgentProfile(primary)!));
    });

    it('refuses to detach the primary, an unknown member, or a retired profile', async () => {
        const { api, registry, store } = openInMemory();
        const sessionId = await createSession(api);
        const primary = store.liveSession(sessionId).definition.primary as string;

        const protectedPrimary = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${primary}`));

        expect(protectedPrimary.status).toBe(409);
        expect(protectedPrimary.body.error.message).toContain('entry point');

        expect((await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/nobody`)).status).toBe(404);

        // A binding must be the profile's own name: the roster key is what a restart resolves
        // back through `agentFromProfile`, so a made-up alias would restore as a dropped session.
        const alias = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'helper', profile: BINDING })
        );

        expect(alias.status).toBe(400);
        expect(alias.body.error.message).toContain('profile');

        // Retiring a profile globally does not touch an existing session; it only closes the door
        // for new selections — the same 409 the global surface states. `planner` rather than the
        // profile the other cases bind, because the global override overlay is shared process
        // state and a tombstone here must not leak into the restart case below.
        expect((await call(api, 'DELETE', `${MOUNT}/agents/planner`)).status).toBe(200);
        expect(registry.agents().some((profile) => profile.name === 'planner')).toBe(false);

        const retired = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'planner' }));

        expect(retired.status).toBe(409);
        expect(retired.body.error.message).toContain('retired');

        // The roster is unchanged by every refusal above.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.agents.map((row: Record<string, any>) => row.agent_id)).not.toContain('planner');
        expect(roster.body.total).toBe(1);
    });

    it('restarts from disk with the binding, the instruction, the title, and the operator defaults', async () => {
        const root = tempRoot('restart');
        const persistence = new HarnessPersistence(root);
        const registry = createHarnessRegistry([narrowPreset()]);
        const store = new SessionStore(SETTINGS, registry, undefined, { persistence });
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

        const sessionId = await createSession(api, 'Planning lane');

        expect(
            (
                await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                    name: BINDING,
                    profile: BINDING,
                    model: 'scripted/bound',
                    instruction: 'Compress the answer into one paragraph.'
                })
            ).status
        ).toBe(201);

        // Durable BEFORE the answer: the document already names the new member in the session's
        // own preset and definition copies, and carries the binding provenance list.
        const document = readDocument(root);
        const stored = document.sessions[0];

        expect(stored.sessionAgents).toEqual([BINDING]);
        expect(stored.preset.subagents).toContain(BINDING);
        expect(stored.preset.agentInstructions[BINDING]).toBe('Compress the answer into one paragraph.');
        expect(stored.definition.agents).toContain(BINDING);
        // T27 (persistence): the serializer has always written the title and the operator
        // defaults; the READER used to drop both, so a rename and a saved `/config` silently
        // reverted on the next boot.
        expect(stored.title).toBe('Planning lane');

        expect(
            (await call(api, 'PATCH', `${MOUNT}/config`, { settings: { model: 'scripted/saved' } })).status
        ).toBe(200);
        expect(readDocument(root).globalSettings).toEqual({ model: 'scripted/saved' });

        // ---- second process, opened through the validating reader -------------------------
        const reopened = openOnDisk(root);

        expect(reopened.restoreProblems).toEqual([]);

        const row = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}`));

        expect(row.status).toBe(200);
        expect(row.body.session.title).toBe('Planning lane');
        expect(jsonOf(await call(reopened.api, 'GET', `${MOUNT}/config`)).body.defaults.model).toBe(
            'scripted/saved'
        );

        const roster = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));
        const restored = roster.body.agents.find((entry: Record<string, any>) => entry.agent_id === BINDING);

        expect(restored).toBeDefined();
        expect(restored).toMatchObject({ origin: 'session', role: 'subagent', model: 'scripted/bound' });

        // The rebuilt brain runs the overridden text, not the shipped profile: proof that the
        // durable override went through the same composition the session was first built with.
        const live = reopened.store.liveSession(sessionId).harness.agents[BINDING];

        expect(live.instructions).toEqual([
            agentInstruction(effectiveAgentProfile(BINDING)!, 'Compress the answer into one paragraph.')
        ]);

        // The exact restored roster. `inherited_model` is still the session's own model (the
        // binding did not rewrite the creation-time baseline), and the original member is still
        // the only primary — a round trip replaces the roster, it does not append to it.
        const primary = store.liveSession(sessionId).definition.primary as string;

        expect(roster.body.total).toBe(2);
        expect(roster.body.agents.map((entry: Record<string, any>) => entry.agent_id)).toEqual([
            primary,
            BINDING
        ]);
        expect(restored.inherited_model).toBe('scripted/first');
        expect(
            roster.body.agents.find((entry: Record<string, any>) => entry.agent_id === primary)
        ).toMatchObject({ role: 'primary', origin: 'definition', deletable: false });
    });

    it('answers 409 rather than resetting history while the session has live work', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);
        // `Session.busy` is the store's own single-flight gate — the same field a streaming run
        // or a manual tool call sets — so this drives the real predicate, not a mock of it.
        const record = store.liveSession(sessionId);

        // The store's own gate: a run, an active lane, or a queued turn. Setting `busy` is how
        // the store represents an in-flight turn, so this exercises the real predicate rather
        // than a mock of it.
        record.busy = true;

        const bound = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING }));

        expect(bound.status).toBe(409);
        expect(bound.body.error.message).toContain('queued work');

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${store.liveSession(sessionId).definition.primary}`, {
                instruction: 'later'
            })
        );

        expect(patched.status).toBe(409);

        record.busy = false;

        expect(
            (await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING })).status
        ).toBe(201);
    });
});
