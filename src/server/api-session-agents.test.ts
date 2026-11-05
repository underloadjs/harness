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
//   5. R6 — a saved session owns its history: an agent that still OWNS a conversation is not
//      detached, the 409 names the conversations, the roster's `deletable` flag states the same
//      condition, and an accepted removal detaches NO thread (`detached_threads: 0`).
//   6. R7 — a session may invent an agent the catalogue never described: its own name, model and
//      instruction, durable as `preset.customAgents` and rebuilt byte-identically by the second
//      process, with `instruction_source: "session"` on every read and the base text as the
//      honest undo of a `null` instruction patch.
//
// Cross-references:
//   - ../harness.ts              — addAgent / removeAgent / setAgentInstruction and their gate
//   - ./sessions.ts              — addSessionAgent / removeSessionAgent / setSessionAgentInstruction
//   - ./api.ts                   — the three routes and their revisions/events
//   - ./api-reads.ts             — `sessionAgentRowsOf` (`origin` from `record.sessionAgents`,
//                                  `deletable` from host-thread ownership, `customAgents` provenance)
//   - ./harnesses/toolbox.ts     — `agentConfigurationForCustom` / `customAgentInstruction` /
//                                  `agentsFromProfiles` (the rebuild half of R7)
//   - ./persistence.ts           — readSessionRecord (title, sessionAgents) / readPresetRecord
//                                  (`customAgents`) / readHarnessDatabase
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

// R7: an agent NO catalogue profile describes, which the session therefore defines for itself.
// The name is deliberately not a profile id and not a case-variant of one, and the base text is
// asserted byte for byte everywhere it surfaces (live brain, roster row, instruction route,
// durable document, rebuilt brain).
const CUSTOM = 'localizer';
const CUSTOM_BASE = 'You rewrite copy for the target market.';

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
const narrowPreset = (agentColors?: Record<string, string>): HarnessPreset => ({
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
    // R2: an optional per-agent COLOR map, so the binding case below can state a swatch for the
    // member it binds without changing the shape every other case in this file reads. A seeded
    // template is copied in as-is (`createHarnessRegistry` -> `copyTemplate`), because the
    // "every key must name a member" rule is a create/PATCH rule; coloring an agent the roster
    // does not yet contain is exactly the state a session-scoped bind resolves.
    ...(agentColors === undefined ? {} : { agentColors }),
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

const openInMemory = (agentColors?: Record<string, string>) => {
    const registry = createHarnessRegistry([narrowPreset(agentColors)]);
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

    // R2/R3: a binding composes the agent through the SAME `agentConfigurationFromProfile` the
    // preset factory uses (./sessions.ts `addSessionAgent` -> ./harnesses/toolbox.ts), so the
    // definition's swatch for that member must reach the live brain. Without it the UI would
    // paint one agent two colors across a restart: rebuilt members get their color from
    // `preset.agentColors` (./harnesses/registry.test.ts "colors that agent only, leaves the
    // rest uncolored"), and a bound member gets it only from this argument.
    //
    // The binding RESPONSE is not where the color shows: the roster row keeps its exact pre-R2
    // shape (a color is definition metadata, not a session-scoped override), so the two honest
    // observations are the live agent and the frozen definition read.
    it('paints a bound member with the color the frozen definition configures for it', async () => {
        const { api, store } = openInMemory({ [BINDING]: '#22d3ee' });
        const sessionId = await createSession(api);

        // The definition read states the map from the moment the session exists, because the
        // frozen descriptor carries it (./harnesses/descriptor.ts emits `agentColors` from the
        // preset) — this is the field the saved-session UI paints swatches from.
        const before = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(before.status).toBe(200);
        expect(before.body.definition.agent_colors).toEqual({ [BINDING]: '#22d3ee' });

        const bound = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                name: BINDING,
                model: 'scripted/bound'
            })
        );

        expect(bound.status).toBe(201);
        // The receipt grows no color field: `POST /sessions/{id}/agents` keeps the row shape
        // every other case in this file pins.
        expect(Object.hasOwn(bound.body.agent, 'color')).toBe(false);

        // The live brain carries the swatch, verbatim (stored trimmed, casing preserved), and the
        // member the map omits — this fixture's primary — carries NO key at all.
        const record = store.liveSession(sessionId);

        expect(record.harness.agents[BINDING].color).toBe('#22d3ee');
        expect(Object.hasOwn(record.harness.agents.instruct, 'color')).toBe(false);

        // The map stays on the session's OWN preset copy, which is what `presetToRecord` persists
        // and `presetFromRecord` replays (./persistence.ts) — so a member rebuilt after a restart
        // gets the same swatch through `agentsFromProfiles`. The durable roster itself is pinned in
        // the restart case below.
        expect(record.preset.agentColors).toEqual({ [BINDING]: '#22d3ee' });

        // The frozen definition read is unchanged by the bind: the roster grew, the swatch map did
        // not, because a binding never writes a new `agentColors` entry (`applyBindingMaps` touches
        // only the model and instruction maps).
        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.status).toBe(200);
        expect(definition.body.definition.agent_colors).toEqual({ [BINDING]: '#22d3ee' });
        expect(definition.body.definition.agents).toContain(BINDING);
    });

    it('leaves a member bound from an uncolored definition uncolored', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.status).toBe(200);
        expect(Object.hasOwn(definition.body.definition, 'agent_colors')).toBe(false);

        const bound = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING })
        );

        expect(bound.status).toBe(201);
        expect(bound.body.agent.agent_id).toBe(BINDING);

        // No map, no swatch: the bound agent is built exactly as it was before R2, so the client
        // keeps its own derivation for it (`agent.color === undefined`).
        expect(Object.hasOwn(store.liveSession(sessionId).harness.agents[BINDING], 'color')).toBe(false);
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

    // -----------------------------------------------------------------------
    // R7: a session owns its agents, so it may INVENT one the catalogue never described — its
    // own name, model, and instruction — and that agent has to survive the three reads the
    // contract exposes (roster row, instruction subresource, frozen definition read) AND a
    // restart from disk. These cases pin each half, because the pre-R7 answer was a 404.
    // -----------------------------------------------------------------------

    it('defines a session agent no profile describes and states where its text comes from', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        const created = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                name: CUSTOM,
                model: 'scripted/local',
                instruction: CUSTOM_BASE
            })
        );

        expect(created.status).toBe(201);

        // The receipt is the contract's row, every field named. `origin: 'session'` because this
        // conversation created the member; `instruction_source: 'session'` because NO profile
        // describes it — the catalogue → global → harness ladder has no layer to answer for an
        // agent with no profile, and `harness` would wrongly imply an override of something;
        // `inherited_model` is still the session model, which is the creation baseline the
        // override sits on.
        const { revision, instruction_chars, guidelines_count, restorable, ...binding } = created.body.agent;

        expect(binding).toEqual({
            agent_id: CUSTOM,
            profile: CUSTOM,
            role: 'subagent',
            origin: 'session',
            model: 'scripted/local',
            inherited_model: 'scripted/first',
            instruction_source: 'session',
            editable: true,
            deletable: true
        });
        expect(typeof revision).toBe('number');
        // A custom agent always has a stated undo: `null` restores the base it was created with.
        expect(restorable).toBe(true);
        // The base text VERBATIM — a custom agent has no guidelines appended, so the count is the
        // caller's sentence and nothing else.
        expect(instruction_chars).toBe(CUSTOM_BASE.length);
        // One system message, which IS the whole prompt (`agent()` seeds one per instruction).
        expect(guidelines_count).toBe(1);

        const record = store.liveSession(sessionId);

        expect(record.harness.agents[CUSTOM].instructions).toEqual([CUSTOM_BASE]);
        expect(record.harness.agents[CUSTOM].model()).toBe('scripted/local');

        // The durable half of the same write: the session's OWN preset copy carries the base
        // (that is what `presetFromRecord` → `agentsFromProfiles` rebuilds from), and NO
        // `agentInstructions` entry, which is why the row above says `session` and not `harness`.
        expect(record.preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(record.preset.agentInstructions).toBeUndefined();
        expect(record.preset.subagents).toEqual([CUSTOM]);
        expect(record.definition.agents).toEqual(['instruct', CUSTOM]);

        // The instruction subresource states the same text, with no guideline layer.
        const text = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}/instruction`)
        );

        expect(text.status).toBe(200);
        expect(text.body).toEqual({
            session_id: sessionId,
            agent_id: CUSTOM,
            source: 'session',
            instruction: CUSTOM_BASE,
            guidelines: [],
            chars: CUSTOM_BASE.length
        });

        // The frozen definition read carries the member in its roster AND in its instruction
        // summary, and does not throw for a name no profile describes (the summary's ladder
        // resolves a profile, which this member does not have).
        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.status).toBe(200);
        expect(definition.body.definition.agents).toEqual(['instruct', CUSTOM]);
        expect(definition.body.definition.instruction_summary).toContainEqual({
            agent: CUSTOM,
            source: 'session',
            overridden: false,
            chars: CUSTOM_BASE.length
        });

        // "As many agents as it likes" means more than one, and an OMITTED instruction is not an
        // error: the session mints a deterministic identity sentence for its own agent.
        const second = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'ops-bot' })
        );

        expect(second.status).toBe(201);
        expect(second.body.agent.model).toBe('scripted/first');
        expect(store.liveSession(sessionId).harness.agents['ops-bot'].instructions).toEqual([
            'You are the ops-bot agent.'
        ]);

        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.status).toBe(200);
        expect(roster.body.total).toBe(3);
        expect(roster.body.agents.map((row: Record<string, any>) => row.agent_id)).toEqual([
            'instruct',
            CUSTOM,
            'ops-bot'
        ]);
    });

    it('re-instructs a session-defined agent and restores its own base with a null patch', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        expect(
            (
                await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                    name: CUSTOM,
                    model: 'scripted/local',
                    instruction: CUSTOM_BASE
                })
            ).status
        ).toBe(201);

        const override = 'Rewrite for the Japanese market.';

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`, {
                instruction: override
            })
        );

        expect(patched.status).toBe(200);
        // The source stays `session` (there is no other layer this member could come from), and
        // the override flag now states that the conversation re-wrote its own base text.
        expect(patched.body.agent).toMatchObject({
            agent_id: CUSTOM,
            instruction_source: 'session',
            has_instruction_override: true,
            restorable: true,
            instruction_chars: override.length
        });

        const live = store.liveSession(sessionId);

        expect(live.harness.agents[CUSTOM].instructions).toEqual([override]);
        // The base is NOT overwritten, so `null` below has something honest to restore, and the
        // override is durable as the RAW text exactly like a profile member's.
        expect(live.preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(live.preset.agentInstructions).toEqual({ [CUSTOM]: override });

        const text = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}/instruction`)
        );

        expect(text.body).toEqual({
            session_id: sessionId,
            agent_id: CUSTOM,
            source: 'session',
            instruction: override,
            guidelines: [],
            chars: override.length
        });

        const cleared = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}/instruction`, {
                instruction: null
            })
        );

        expect(cleared.status).toBe(200);
        expect(cleared.body.source).toBe('session');
        expect(cleared.body.instruction).toBe(CUSTOM_BASE);
        expect(cleared.body.chars).toBe(CUSTOM_BASE.length);

        const restored = store.liveSession(sessionId);

        expect(restored.harness.agents[CUSTOM].instructions).toEqual([CUSTOM_BASE]);
        // The override entry is gone (not blank), while the base survives: exactly the pair a
        // restart replays as "the agent's own text".
        expect(Object.hasOwn(restored.preset, 'agentInstructions')).toBe(false);
        expect(restored.preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
    });

    // R2 for an invented member: the swatch comes from the same frozen `agentColors` map a
    // rebuilt catalogue member reads, so a session-defined agent is painted identically before
    // and after a restart (the roster row keeps its exact shape either way).
    it('paints a session-defined agent with the color the definition configures for it', async () => {
        const { api, store } = openInMemory({ [CUSTOM]: '#22d3ee' });
        const sessionId = await createSession(api);

        const created = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: CUSTOM })
        );

        expect(created.status).toBe(201);
        expect(Object.hasOwn(created.body.agent, 'color')).toBe(false);
        expect(store.liveSession(sessionId).harness.agents[CUSTOM].color).toBe('#22d3ee');

        // And the roster row still carries no color field, exactly as for a profile binding.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));
        const row = roster.body.agents.find((entry: Record<string, any>) => entry.agent_id === CUSTOM);

        expect(Object.hasOwn(row, 'color')).toBe(false);
    });

    it('restarts from disk with the session-defined agent, its model, and its exact instruction', async () => {
        const root = tempRoot('custom-restart');
        const persistence = new HarnessPersistence(root);
        const registry = createHarnessRegistry([narrowPreset()]);
        const store = new SessionStore(SETTINGS, registry, undefined, { persistence });
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

        const sessionId = await createSession(api, 'Invented team');

        expect(
            (
                await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                    name: CUSTOM,
                    model: 'scripted/local',
                    instruction: CUSTOM_BASE
                })
            ).status
        ).toBe(201);

        const override = 'Rewrite for the Japanese market.';

        expect(
            (
                await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`, {
                    instruction: override
                })
            ).status
        ).toBe(200);

        // Durable BEFORE the answer. `customAgents` is the one additive field R7 needs: the base
        // text of an agent no profile describes, next to the override map and the roster lists
        // every pre-R7 document already carried.
        const stored = readDocument(root).sessions[0];

        expect(stored.sessionAgents).toEqual([CUSTOM]);
        expect(stored.preset.subagents).toEqual([CUSTOM]);
        expect(stored.preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(stored.preset.agentInstructions).toEqual({ [CUSTOM]: override });
        expect(stored.definition.agents).toEqual(['instruct', CUSTOM]);

        // ---- second process, opened through the validating reader -------------------------
        const reopened = openOnDisk(root);

        expect(reopened.restoreProblems).toEqual([]);

        const roster = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));
        const row = roster.body.agents.find((entry: Record<string, any>) => entry.agent_id === CUSTOM);

        expect(row).toMatchObject({
            agent_id: CUSTOM,
            profile: CUSTOM,
            origin: 'session',
            role: 'subagent',
            model: 'scripted/local',
            instruction_source: 'session',
            has_instruction_override: true,
            deletable: true
        });
        expect(row.instruction_chars).toBe(override.length);

        // The rebuilt brain runs the OVERRIDE on the same model, byte for byte:
        // `agentsFromProfiles` resolves `agentInstructions[name] ?? customAgents[name]`, which is
        // the same precedence the live PATCH applied. This is the proof that the durable map
        // reached the factory rather than being dropped as prose.
        const live = reopened.store.liveSession(sessionId);

        expect(live.harness.agents[CUSTOM].instructions).toEqual([override]);
        expect(live.harness.agents[CUSTOM].model()).toBe('scripted/local');
        expect(live.preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });

        const text = jsonOf(
            await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}/instruction`)
        );

        expect(text.body.source).toBe('session');
        expect(text.body.instruction).toBe(override);
        expect(text.body.guidelines).toEqual([]);
        expect(text.body.chars).toBe(override.length);

        // The definition read after the restart still names the invented agent.
        const definition = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.body.definition.agents).toEqual(['instruct', CUSTOM]);
        expect(definition.body.definition.instruction_summary).toContainEqual({
            agent: CUSTOM,
            source: 'session',
            overridden: true,
            chars: override.length
        });

        // The catalogue member the definition shipped is untouched: a round trip replaces the
        // roster, it does not append to it.
        expect(roster.body.total).toBe(2);
        expect(roster.body.agents.map((entry: Record<string, any>) => entry.agent_id)).toEqual([
            'instruct',
            CUSTOM
        ]);
    });

    // -----------------------------------------------------------------------
    // R6: a saved session owns its history. An agent that still OWNS a conversation is not
    // detached — the removal used to delete its host threads behind the caller's back, which
    // threw away transcripts the request never named.
    // -----------------------------------------------------------------------

    it('refuses to detach an agent that still owns a conversation, then detaches it once the thread is gone', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        expect(
            (
                await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                    name: CUSTOM,
                    instruction: CUSTOM_BASE
                })
            ).status
        ).toBe(201);

        const rowOf = (body: Record<string, any>) =>
            (body.agents as Record<string, any>[]).find((row) => row.agent_id === CUSTOM);

        // The member's own DEFAULT conversation (`agent:localizer`) is not what the guard counts:
        // it is the agent's transcript, and it travels with the agent by definition.
        const before = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(before.status).toBe(200);
        expect(rowOf(before.body).deletable).toBe(true);

        const thread = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/threads`, { agent: CUSTOM })
        );

        expect(thread.status).toBe(201);

        const threadId = thread.body.thread.id as string;

        // The roster states the guard before the client has to discover it with a failing call.
        const guarded = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(rowOf(guarded.body).deletable).toBe(false);

        const conflict = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`));

        expect(conflict.status).toBe(409);
        // The refusal names the agent, how many conversations it owns, WHICH ids, and the fix.
        expect(conflict.body.error.message).toContain(`Agent "${CUSTOM}"`);
        expect(conflict.body.error.message).toContain('1 conversation');
        expect(conflict.body.error.message).toContain(threadId);
        expect(conflict.body.error.message).toContain('Delete those threads before removing the agent');

        // Nothing moved: the conversation is still addressable, and the member is still a row.
        const threads = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads`));

        expect(threads.body.items.map((row: Record<string, any>) => row.id)).toContain(threadId);
        expect(store.liveSession(sessionId).harness.thread(threadId)).toBeDefined();

        const still = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(still.body.total).toBe(2);
        expect(rowOf(still.body).deletable).toBe(false);
        expect(store.liveSession(sessionId).preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });

        // Delete the conversation the caller DID name, and the removal is accepted — with no
        // thread detached as a side effect.
        const dropped = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/threads/${threadId}`));

        expect(dropped.status).toBe(200);

        const afterThread = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(rowOf(afterThread.body).deletable).toBe(true);

        const removed = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`));
        const removedRevision = removed.body.revision;

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            agent_id: CUSTOM,
            session_id: sessionId,
            // R6: an accepted removal never detaches anything, and the field stays because the
            // contract declares it.
            detached_threads: 0,
            revision: removedRevision
        });

        const after = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(after.body.total).toBe(1);
        expect(after.body.agents.map((row: Record<string, any>) => row.agent_id)).toEqual(['instruct']);
        expect(store.liveSession(sessionId).harness.agents[CUSTOM]).toBeUndefined();

        // R7: detaching also deletes the stored base, so a restart has nothing left to rebuild.
        expect(Object.hasOwn(store.liveSession(sessionId).preset, 'customAgents')).toBe(false);
    });

    it('refuses an unusable session-defined name and keeps an unknown DELETE a 404', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        // R7 widened WHICH names are legal, not what a name may look like: the roster key is a
        // delegation id, a runtime registry key, and a key of the session's durable maps at once.
        const slash = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'ops/bot' })
        );

        expect(slash.status).toBe(400);
        expect(slash.body.error.message).toContain('session-defined agent');

        const control = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'ops\u0007bot' })
        );

        expect(control.status).toBe(400);

        // `unknown` is the placeholder a client paints for "no agent at all", in any case.
        for (const taken of ['unknown', 'UNKNOWN']) {
            const refused = jsonOf(
                await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: taken })
            );

            expect(refused.status).toBe(400);
            expect(refused.body.error.message).toContain('placeholder');
        }

        // A case-only difference from an existing member is the same agent to every reader, and
        // the runtime's roster would hold two keys for one delegation word.
        expect(
            (await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: CUSTOM })).status
        ).toBe(201);

        const clash = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'Localizer' })
        );

        expect(clash.status).toBe(409);
        expect(clash.body.error.message).toContain('case');

        // A catalogue profile spelled differently collides too: `Instruct` is not a profile id,
        // and inventing a look-alike of the entry point would be a silent roster surprise.
        const primaryClash = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'Instruct' })
        );

        expect(primaryClash.status).toBe(409);

        // The roster every refusal left behind, exactly — and the one member that was accepted
        // carries the deterministic default sentence, because no instruction was supplied.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.agents.map((row: Record<string, any>) => row.agent_id)).toEqual([
            'instruct',
            CUSTOM
        ]);
        expect(store.liveSession(sessionId).preset.customAgents).toEqual({
            [CUSTOM]: `You are the ${CUSTOM} agent.`
        });

        // Only the POST gained a custom branch: DELETE of a name that was never a member is
        // still a 404, and a member that IS one detaches.
        expect((await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/never-was`)).status).toBe(404);
        expect(
            (await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`)).status
        ).toBe(200);
    });
});
