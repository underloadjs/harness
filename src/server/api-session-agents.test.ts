// T27: session-scoped AGENT BINDINGS, end to end.
//
// What this file pins down, in the order the layers are actually reached:
//   1. `POST /sessions/{id}/agents` is a real write (it used to answer 403): the member joins
//      the LIVE roster, the roster read reports it with `origin: "session"`, and the receipt is
//      the same bounded row an identified read returns;
//   2. `PATCH .../agents/{id} {instruction}` changes ONLY the leading system block of that one
//      member — the rest of its transcript is byte-identical afterwards, which is the whole
//      point of not resetting history to retune a prompt;
//   3. protection and isolation: the ENTRY AGENT cannot be detached (entry, not rank, is the
//      structural rule — R15), a non-member is a 404, a
//      binding does not leak into another session of the same store, and a retired profile
//      cannot be newly selected;
//   4. DURABILITY, the part every earlier in-memory test could fake: a SECOND process opened
//      from `<root>/harness/` (v2: `index.json` plus `sessions/<id>/session.json`) through
//      `HarnessPersistence.load()` — the reader, not a
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
//      honest undo of a `null` instruction patch;
//   7. R20 — a FRESH session (no host thread, no turn) can re-state an existing member's rank,
//      and the same write answers 409 once a thread exists. That is the window `+ New session`
//      opens eagerly, and the one the frontend's rank badge offers.
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
import { AGENT_RANKS, agent, harness } from '../engine/harness';
// U6: the closed prefix turn, so the banded fixture below states its bands in the SAME type the
// registry stores and the runtime seeds (no structural cast).
import type { HarnessPrefixTurn } from '../engine/harness';
import { agentInstruction } from '../engine/agents';
import { effectiveAgentProfile } from './harnesses/agent-state';
import { createHarnessRegistry } from './harnesses';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { HarnessPersistence } from './persistence';
// v2 layout readers (./persistence-test-helpers.ts): the reassembled database is read through
// the helper rather than one raw file, so the durability pins below cover every shard.
import { readPersistedDocument } from './persistence-test-helpers';
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

// v2 layout: the header document is `index.json` and each session is its own shard
// (`sessions/<id>/session.json`, transcripts under `sessions/<id>/threads/`). `readDocument`
// keeps the ONE-document view these pins are written against — including the `database` option
// value it is fed back into, which is the unchanged in-memory `HarnessDatabase` shape — by
// reassembling the shards in `index.json` order. A missing header still throws, as before.
const readDocument = (root: string): Record<string, any> => readPersistedDocument(root);

// An in-memory pair (no database root) for the behavior cases, and a file-backed one for the
// restart case.
//
// WHY A CUSTOM NARROW PRESET, AND WHY `template: 'live'`
// ------------------------------------------------------
// Every SHIPPED live preset states its roster explicitly, and each delegating card's roster is
// every other role plus the summarizer (./harnesses/presets.ts:57-70) — so a session created from
// the shipped catalogue already contains every trusted profile and there is nothing left to bind.
// A one-member preset makes the bind a real roster change, and its `ranks` map states the lone
// member at Rank A, because the authority map is required and complete (./harnesses/types.ts).
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
    entry: 'instruct',
    ranks: { instruct: 'A' },
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
            entry: 'instruct',
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
        // the definition shipped, `rank: 'B'` is the rank the KERNEL resolved for a member added with
        // no rank of its own (one below the lowest stated rank — ../harness.ts, and the letter this
        // session's own copy records), and `inherited_model` is the CREATION baseline (the session's
        // model), not the override — which is the distinction the contract's `inherited_model` exists for.
        const { revision, instruction_chars, guidelines_count, restorable, ...binding } = bound.body.agent;

        expect(binding).toEqual({
            agent_id: BINDING,
            profile: BINDING,
            rank: 'B',
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

        // The instruction subresource states the text this member ACTUALLY runs. Since T6 a
        // stored override IS that complete text — verbatim, with no guideline block appended
        // — which is what `agentInstruction` (src/agents/index.ts) now returns, and the same
        // composition a restart replays.
        const instruction = jsonOf(
            await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${BINDING}/instruction`)
        );
        const profile = effectiveAgentProfile(BINDING)!;

        expect(instruction.status).toBe(200);
        expect(instruction.body.instruction).toBe(
            agentInstruction(profile, 'Compress the answer into one paragraph.')
        );

        // The contract, spelled out: exactly the operator's sentence, nothing appended.
        expect(instruction.body.instruction).toBe('Compress the answer into one paragraph.');
        expect(instruction.body.instruction).not.toContain('Guidelines:');
        expect(instruction.body.source).toBe('harness');
        expect(instruction.body.chars).toBe(instruction.body.instruction.length);

        // A second bind of the same profile is a conflict, not a duplicate row.
        expect(
            (await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING })).status
        ).toBe(409);
    });

    // R20 / the fresh-session window: `+ New session` creates an EMPTY record eagerly, so the
    // frontend still lets the reader re-state its ranks until the first thread exists. This is
    // the server half of that rule — the same PATCH, the same persisted map, and the exact 409
    // once a host thread exists.
    it('changes a rank on a fresh session and refuses it once a thread exists', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        const ranked = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { rank: 'C' })
        );

        expect(ranked.status).toBe(200);
        expect(ranked.body.agent.rank).toBe('C');

        // The live roster, the frozen definition AND the runtime all read the new letter, so a
        // restart and the delegation graph can never disagree about the team.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.agents.find((row: Record<string, any>) => row.agent_id === 'instruct').rank).toBe('C');

        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.body.definition.ranks).toEqual({ instruct: 'C' });
        expect(store.liveSession(sessionId).harness.ranks).toEqual({ instruct: 'C' });
        expect(store.liveSession(sessionId).preset.ranks).toEqual({ instruct: 'C' });

        // A host thread is the line: the conversation has started, so the rank map is the one
        // its delegation graph was built from and the write is refused with the same sentence
        // the dialog shows.
        const thread = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/threads`, { agent: 'instruct' })
        );

        expect(thread.status).toBe(201);

        const refused = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { rank: 'D' })
        );

        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(
            'A saved conversation keeps the ranks its harness template defines; start a new session to change them.'
        );

        // Nothing moved: the roster still reads the letter the fresh window wrote.
        const after = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(after.body.agents.find((row: Record<string, any>) => row.agent_id === 'instruct').rank).toBe('C');
    });

    it('persists a fresh session rank change across a restart', async () => {
        const root = tempRoot('fresh-rank');
        const persistence = new HarnessPersistence(root);
        const registry = createHarnessRegistry([narrowPreset()]);
        const store = new SessionStore(SETTINGS, registry, undefined, { persistence });
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

        const sessionId = await createSession(api);

        expect(
            (await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { rank: 'C' })).status
        ).toBe(200);

        // The durable preset and definition copies carry the new letter before the answer, which
        // is what a second process rebuilds its harness from.
        const stored = readDocument(root).sessions[0];

        expect(stored.preset.ranks).toEqual({ instruct: 'C' });
        expect(stored.definition.ranks).toEqual({ instruct: 'C' });

        const reopened = openOnDisk(root);

        expect(reopened.restoreProblems).toEqual([]);

        const roster = jsonOf(await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.agents.find((row: Record<string, any>) => row.agent_id === 'instruct').rank).toBe('C');
        expect(reopened.store.liveSession(sessionId).harness.ranks).toEqual({ instruct: 'C' });
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
        // member the map omits — this fixture's entry agent — carries NO key at all.
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
        const entryAgent = record.definition.entry as string;
        const brain = record.harness.agents[entryAgent];
        const seededInstructionLength = brain.instructions.length;

        brain.user('What changed?');
        brain.assistant('Nothing yet.');

        const history = JSON.parse(JSON.stringify(brain.messages)) as unknown[];

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${entryAgent}`, {
                instruction: 'Answer in exactly two sentences.'
            })
        );

        expect(patched.status).toBe(200);
        expect(patched.body.agent.instruction_source).toBe('harness');

        // The leading block is exactly one message now, and every message after it is byte for
        // byte what was there before: no reset, no reseed of the conversation. The stored text is
        // what the agent runs, and since T6 an override IS the complete text (no guideline block
        // appended), because the box that produced it holds the whole effective prompt. The one
        // helper that decides this is `agentInstruction` (src/agents/index.ts) — the same call a
        // restart feeds the raw override through, so live and rebuilt agree character for
        // character.
        const composed = agentInstruction(
            effectiveAgentProfile(entryAgent)!,
            'Answer in exactly two sentences.'
        );

        expect(brain.instructions).toEqual([composed]);
        expect(brain.instructions).toEqual(['Answer in exactly two sentences.']);
        expect(brain.messages[0]).toEqual({ role: 'system', content: composed });
        expect(brain.messages.length).toBe(history.length - seededInstructionLength + 1);
        expect(JSON.parse(JSON.stringify(brain.messages.slice(1)))).toEqual(history.slice(seededInstructionLength));

        // The recorded turns of the session are untouched by a prompt change.
        expect(store.liveSession(sessionId).turns).toEqual([]);

        // `null` clears the session override and restores the deployment's effective profile
        // text, which is the same string the next build composes from the same profile.
        const cleared = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${entryAgent}/instruction`, {
                instruction: null
            })
        );

        expect(cleared.status).toBe(200);
        expect(cleared.body.instruction).toBe(agentInstruction(effectiveAgentProfile(entryAgent)!));
        expect(brain.messages[0].content).toBe(agentInstruction(effectiveAgentProfile(entryAgent)!));
    });

    it('refuses to detach the entry agent, an unknown member, or a retired profile', async () => {
        const { api, registry, store } = openInMemory();
        const sessionId = await createSession(api);
        const entryAgent = store.liveSession(sessionId).definition.entry as string;

        const protectedEntry = jsonOf(
            await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${entryAgent}`)
        );

        expect(protectedEntry.status).toBe(409);
        expect(protectedEntry.body.error.message).toContain('entry point');

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

    // R15 — AUTHORITY IS RANK-GOVERNED, DETACHABILITY IS ENTRY-GOVERNED, and the two are
    // independent facts. The retired axis fused them: "the primary" was simultaneously the
    // top of the hierarchy and the protected member, so a second top-rank member was
    // unrepresentable and protection was a rank rule. On this axis each half is pinned
    // separately:
    //   - several members may hold Rank A at once, entry agent included, and the roster, the
    //     live definition and the durable preset copy all state the same letters;
    //   - a Rank A member that is not the entry point DETACHES, while the entry agent is
    //     refused by MEMBERSHIP while holding that very letter;
    //   - a detach deletes the departed member's rank with it, so a removed agent can never
    //     keep authority in a restored document (./sessions.ts `applyBindingMaps`);
    //   - a letter outside the scale is a 400 that names the letters, refused before the
    //     durability and idle gates (./sessions.ts `validateBindingRank`), and the roster is
    //     left exactly as it was.
    it('binds several members at Rank A, guards only the entry agent, and refuses an unusable rank', async () => {
        const { api, store } = openInMemory();
        const sessionId = await createSession(api);

        // The fixture roster is one member, and it is the entry agent, at Rank A.
        const entryAgent = store.liveSession(sessionId).definition.entry as string;

        expect(store.liveSession(sessionId).definition.agents).toEqual([entryAgent]);
        expect(store.liveSession(sessionId).definition.ranks).toEqual({ [entryAgent]: 'A' });

        // Two bindings, each explicitly Rank A — the same letter the entry agent holds.
        const first = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: BINDING, rank: 'A' })
        );
        const second = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'reviewer', rank: 'A' })
        );

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(first.body.agent.rank).toBe('A');
        expect(second.body.agent.rank).toBe('A');

        // The roster read states all three letters, and only the entry agent is protected:
        // `deletable` is the entry rule surfaced as a flag, never a rank comparison.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.body.total).toBe(3);
        expect(
            roster.body.agents.map((row: Record<string, any>) => [row.agent_id, row.rank, row.deletable])
        ).toEqual([
            [entryAgent, 'A', false],
            [BINDING, 'A', true],
            ['reviewer', 'A', true]
        ]);

        // The frozen session definition carries the same map, so a client comparing the roster
        // against the definition it was built from cannot be told two different stories.
        const definition = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(definition.body.definition.entry).toBe(entryAgent);
        expect(definition.body.definition.ranks).toEqual({
            [entryAgent]: 'A',
            [BINDING]: 'A',
            reviewer: 'A'
        });

        // A Rank A member that is not the entry point detaches cleanly, and its rank goes with
        // it — the surviving map is exactly the two members that remain.
        const detached = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${BINDING}`));

        expect(detached.status).toBe(200);
        expect(detached.body.detached_threads).toBe(0);
        expect(store.liveSession(sessionId).definition.agents).toEqual([entryAgent, 'reviewer']);
        expect(store.liveSession(sessionId).definition.ranks).toEqual({ [entryAgent]: 'A', reviewer: 'A' });

        // The entry agent is refused FOR BEING THE ENTRY POINT, letter included: it holds the
        // same Rank A the detached member held, and the refusal says its rank can change while
        // its membership cannot.
        const protectedEntry = jsonOf(
            await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${entryAgent}`)
        );

        expect(protectedEntry.status).toBe(409);
        expect(protectedEntry.body.error.message).toBe(
            `Agent "${entryAgent}" is the entry agent of session "${sessionId}" and cannot be detached; every session needs an entry point. Its rank can change, its membership cannot.`
        );

        // A rank the scale does not contain is refused out loud, naming every letter it accepts,
        // and the refusal is not persisted — no partial rank, no phantom member.
        const unusable = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'research', rank: 'AA' })
        );

        expect(unusable.status).toBe(400);
        expect(unusable.body.error.message).toBe(
            `An agent binding takes a "rank": one letter of the authority scale, ${AGENT_RANKS.join(
                ', '
            )}. The rank is what decides what the agent may reach; the roster alone does not.`
        );
        expect(store.liveSession(sessionId).definition.agents).toEqual([entryAgent, 'reviewer']);
        expect(store.liveSession(sessionId).definition.ranks).toEqual({ [entryAgent]: 'A', reviewer: 'A' });
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
        // The session's own preset copy carries the RESOLVED authority map — the entry agent at
        // Rank A exactly as the fixture states it, and the bound member one below, which is the
        // letter the runtime resolved and the store recorded verbatim (./sessions.ts
        // `addSessionAgent` reads it back off `harness.ranks`).
        expect(stored.preset.ranks).toEqual({ instruct: 'A', [BINDING]: 'B' });
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
        expect(restored).toMatchObject({ origin: 'session', rank: 'B', model: 'scripted/bound' });

        // The rebuilt brain runs the overridden text, not the shipped profile: proof that the
        // durable override went through the same composition the session was first built with.
        const live = reopened.store.liveSession(sessionId).harness.agents[BINDING];

        expect(live.instructions).toEqual([
            agentInstruction(effectiveAgentProfile(BINDING)!, 'Compress the answer into one paragraph.')
        ]);

        // T6 spelled out: the rebuild seeds the stored text VERBATIM. A restart must not
        // re-grow the guideline block a full-prompt edit removed.
        expect(live.instructions).toEqual(['Compress the answer into one paragraph.']);

        // The exact restored roster. `inherited_model` is still the session's own model (the
        // binding did not rewrite the creation-time baseline), and the member the definition NAMES
        // as the entry point is still the one that survives a round trip — a restart replaces the
        // roster, it does not append to it, and rank travels with the member.
        const entryAgent = store.liveSession(sessionId).definition.entry as string;

        expect(roster.body.total).toBe(2);
        expect(roster.body.agents.map((entry: Record<string, any>) => entry.agent_id)).toEqual([
            entryAgent,
            BINDING
        ]);
        expect(restored.inherited_model).toBe('scripted/first');
        expect(
            roster.body.agents.find((entry: Record<string, any>) => entry.agent_id === entryAgent)
        ).toMatchObject({ rank: 'A', origin: 'definition', deletable: false });
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
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/${store.liveSession(sessionId).definition.entry}`, {
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
            rank: 'B',
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
        expect(record.preset.ranks).toEqual({ instruct: 'A', [CUSTOM]: 'B' });
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
        expect(stored.preset.ranks).toEqual({ instruct: 'A', [CUSTOM]: 'B' });
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
            rank: 'B',
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

    it('refuses to detach an agent that still owns a conversation, and still refuses it once the thread is only marked deleted', async () => {
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
        expect(conflict.body.error.message).toContain(
            'A deleted thread is retained, so removing this agent needs the session deleted.'
        );

        // Nothing moved: the conversation is still addressable, and the member is still a row.
        const threads = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads`));

        expect(threads.body.items.map((row: Record<string, any>) => row.id)).toContain(threadId);
        expect(store.liveSession(sessionId).harness.thread(threadId)).toBeDefined();

        const still = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(still.body.total).toBe(2);
        expect(rowOf(still.body).deletable).toBe(false);
        expect(store.liveSession(sessionId).preset.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });

        // Delete the conversation the caller DID name. The roster says the member is deletable
        // again, yet the removal is STILL refused: the delete only MARKED the thread, and its
        // retained host row still names this agent. Only the session going away releases it.
        const dropped = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/threads/${threadId}`));

        expect(dropped.status).toBe(200);

        const afterThread = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        // The roster hides the marked row, so this flag is advisory after a delete; the write
        // gate below is the authoritative answer.
        expect(rowOf(afterThread.body).deletable).toBe(true);

        const stillBlocked = jsonOf(await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/agents/${CUSTOM}`));

        expect(stillBlocked.status).toBe(409);
        expect(stillBlocked.body.error.message).toContain(threadId);
        // This refusal comes from the harness's own backstop (../harness.ts `removeAgent`): the
        // store's guard reads the roster, which hides the marked row, so the kernel is what stops
        // the removal when the only conversation left is a retained one.
        expect(stillBlocked.body.error.message).toContain(
            'Cannot remove agent "localizer" while it owns thread "thread-1"; a deleted thread is still retained, so only deleting the session releases it.'
        );

        // Nothing moved: the member is still registered and its stored base is intact.
        expect(store.liveSession(sessionId).harness.agents[CUSTOM]).toBeDefined();
        expect(Object.hasOwn(store.liveSession(sessionId).preset, 'customAgents')).toBe(true);

        // R7: the durable base belongs to the session, so deleting the session is the door
        // that releases the retained rows and drops what a restart would rebuild.
        expect(await store.remove(sessionId)).toBe(true);
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
        const entryNameClash = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'Instruct' })
        );

        expect(entryNameClash.status).toBe(409);

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

// U6 — PRESET HISTORY (the seeded prefix band) over HTTP.
//
// What this block pins, in the order a band editor actually hits it:
//   1. a definition that seeds a band shows it on the identified read (`agent_prefixes`), and the
//      SAME bytes reach the session's live transcript on the first read of
//      `GET …/agents/{id}/prefix` with `source: "harness"`;
//   2. `PATCH …/agents/{id} {prefix}` replaces ONLY the band — accumulated history is kept — and
//      the read follows the live brain, with `source: "session"`;
//   3. the three states of the field are three different durable outcomes: an ARRAY records the
//      session's own band, `[]` records the explicit choice "no preset history", and `null` removes
//      the session key so the frozen definition's band comes back;
//   4. turn validation runs at the EDGE, before the store's gates, and refuses a malformed band, a
//      tool role, or a band for a member the definition never selected — with the registry's own
//      wording on both surfaces;
//   5. DURABILITY: a second process opened from `<root>/harness/` still seeds the band the session
//      wrote, which is only true because `agentPrefixes` is part of the preset RECORD the factory is
//      rebuilt from (./persistence.ts `readPresetRecord`, ./harnesses/registry.ts `presetFromRecord`).
//
// U9 (2026-11-24) adds the two cross-component pins an independent review found missing:
//   - F2 — `GET /harnesses/{name}` states `agent_prefixes` on EVERY answer, `{}` when nothing is
//     seeded, because that presence is the CAPABILITY a client negotiates the preset editor from
//     (the PATCH field is a whole-map REPLACE whose `{}` clears every band, so a client may only
//     send a map it READ; a pre-U6 backend omits the property and its PATCH refuses the field).
//     Pinned for the cleared definition and the seeded card, together with the cards staying clean;
//   - F1 — `GET /sessions/{id}/definition` carries the FROZEN map (a keyed `[]` included, and
//     omitted when the captured copy states nothing, which is what keeps an old session's row
//     byte-identical), and F3 — a prefix write is refused 409 with the store's own idle/queued-work
//     gate, exactly like an instruction write, on both the array and the `null` undo.
//
// Cross-references:
//   - ../engine/harness.ts            — setAgentPrefix and the three lives it moves
//   - ./sessions.ts                   — setSessionAgentPrefix / addSessionAgent / applyBindingMaps
//   - ./api.ts                        — the allowlists, the edge validator call, and the prefix route
//   - ./api-reads.ts                  — `harnessDefinitionOf` (`agent_prefixes`)
//   - ./harnesses/registry.ts         — requirePrefixTurns / normalizeAgentPrefixes / presetFromRecord
describe('session agent preset history (U6)', () => {
    type Turn = { role: 'system' | 'user' | 'assistant'; content: string };

    // The band the fixture DEFINITION seeds, asserted byte for byte everywhere it surfaces
    // (definition read, live transcript, prefix read, durable document, rebuilt session).
    const DEFINITION_BAND: Turn[] = [
        { role: 'system', content: 'Cite every figure.' },
        { role: 'user', content: 'Draft the summary.' },
        { role: 'assistant', content: 'Summary drafted.' }
    ];

    // A one-member live preset whose factory seeds the band — the fixture mirror of what
    // `createProfiledHarness` does for a shipped card through `agentsFromProfiles` →
    // `agentConfigurationFromProfile(…, prefix)` → `agent({ prefix })` (./harnesses/toolbox.ts).
    // `agentPrefixes` is the EXECUTABLE map: the same object the registry copies, the record
    // stores, and this factory closes over.
    const bandedPreset = (agentPrefixes?: Record<string, Turn[]>): HarnessPreset => ({
        name: 'instruct',
        title: 'Instruct',
        description: 'Single-role fixture for the preset-history contract.',
        requiresEndpoint: false,
        template: 'live',
        entry: 'instruct',
        ranks: { instruct: 'A' },
        agents: ['instruct'],
        tools: [],
        builtin: false,
        editable: true,
        ...(agentPrefixes === undefined ? {} : { agentPrefixes }),
        create: (settings, progress) =>
            harness({
                agents: {
                    instruct: agent({
                        model: settings.model,
                        instruction: 'Fixture agent.',
                        ...(agentPrefixes?.instruct === undefined
                            ? {}
                            : { prefix: agentPrefixes.instruct as HarnessPrefixTurn[] }),
                        stream: async function* () {
                            yield { type: 'text', delta: 'ok' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                entry: 'instruct',
                presets: false,
                report: { progress }
            })
    });

    const openBanded = (agentPrefixes?: Record<string, Turn[]>) => {
        const registry = createHarnessRegistry([bandedPreset(agentPrefixes)]);
        const store = new SessionStore(SETTINGS, registry);
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

        return { api, store, registry };
    };

    // A file-backed pair on the SAME banded fixture (the in-memory `openOnDisk` above is welded to
    // `narrowPreset`, which seeds no history at all).
    const openBandedOnDisk = (root: string, agentPrefixes?: Record<string, Turn[]>) => {
        const persistence = new HarnessPersistence(root);
        const database = persistence.load();
        const registry = createHarnessRegistry([bandedPreset(agentPrefixes)]);
        const store = new SessionStore(SETTINGS, registry, undefined, { persistence, database: database ?? undefined });
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

        return { api, store, registry, persistence };
    };

    const prefixOf = async (api: ReturnType<typeof createHarnessApi>, sessionId: string, agentId = 'instruct') =>
        jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents/${agentId}/prefix`));

    // The live brain's transcript as `{ role, content }` pairs — the seed the provider reads, with
    // the minted ids left out because those are derived from the whole transcript.
    const bandOf = (store: SessionStore, sessionId: string, agentId = 'instruct') => {
        const record = store.liveSession(sessionId);
        const brain = record?.harness.agents[agentId];

        return (brain?.messages ?? []).map((entry: { role: string; content: unknown }) => ({
            role: entry.role,
            content: entry.content
        }));
    };

    it('seeds the definition band and names the definition as its source', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        const read = await prefixOf(api, sessionId);

        expect(read.status).toBe(200);
        // THE WHOLE DOCUMENT, four keys and no more (the spec says `additionalProperties: false`).
        expect(read.body).toEqual({
            session_id: sessionId,
            agent_id: 'instruct',
            prefix: [
                { role: 'system', content: 'Cite every figure.' },
                { role: 'user', content: 'Draft the summary.' },
                { role: 'assistant', content: 'Summary drafted.' }
            ],
            source: 'harness'
        });

        // The same bytes are the live transcript below the instruction block — the read is not a
        // re-projection of the stored map.
        expect(bandOf(store, sessionId)).toEqual([
            { role: 'system', content: 'Fixture agent.' },
            { role: 'system', content: 'Cite every figure.' },
            { role: 'user', content: 'Draft the summary.' },
            { role: 'assistant', content: 'Summary drafted.' }
        ]);

        // And the band stays OUT of the roster row: a band is a list of prompt-length strings, so it
        // is addressed per agent rather than carried on every list frame.
        const roster = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/agents`));

        expect(roster.status).toBe(200);
        expect(Object.keys(roster.body.agents[0])).not.toContain('prefix');
    });

    it('replaces the band and reports the session as its source', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
                prefix: [{ role: 'user', content: 'Answer in one sentence.' }]
            })
        );

        expect(patched.status).toBe(200);
        expect(patched.body.agent.agent_id).toBe('instruct');

        const read = await prefixOf(api, sessionId);

        expect(read.body).toEqual({
            session_id: sessionId,
            agent_id: 'instruct',
            prefix: [{ role: 'user', content: 'Answer in one sentence.' }],
            // The band differs from what the definition seeds, which is exactly what `session` means.
            source: 'session'
        });

        // THE WHOLE TRANSCRIPT: three seeded turns in, one turn out, and the instruction block above
        // the band untouched. That "only the band moved" claim is what the write is for, and the
        // guarantee that an ALREADY-accumulated conversation survives it byte-for-byte (and by object
        // identity) is pinned at the engine level, ./../engine/harness.prefix.test.ts.
        expect(bandOf(store, sessionId)).toEqual([
            { role: 'system', content: 'Fixture agent.' },
            { role: 'user', content: 'Answer in one sentence.' }
        ]);

        // DURABLE STATE, exactly: the session's own preset copy carries the band it wrote.
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({
            instruct: [{ role: 'user', content: 'Answer in one sentence.' }]
        });
    });

    it('keeps an explicit empty band as the session choice it is', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        const patched = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { prefix: [] })
        );

        expect(patched.status).toBe(200);

        const read = await prefixOf(api, sessionId);

        expect(read.body).toEqual({ session_id: sessionId, agent_id: 'instruct', prefix: [], source: 'session' });

        // `[]` is a value: the preset keeps the KEY, so the suppression survives a restart instead of
        // reverting to the definition's history.
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({ instruct: [] });
    });

    it('restores the frozen definition band on null, in the transcript and in the record', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
            prefix: [{ role: 'user', content: 'Temporary history.' }]
        });

        const restored = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { prefix: null })
        );

        expect(restored.status).toBe(200);

        const read = await prefixOf(api, sessionId);

        expect(read.body).toEqual({
            session_id: sessionId,
            agent_id: 'instruct',
            prefix: DEFINITION_BAND,
            source: 'harness'
        });

        // THE POINT OF THE `null`: the session's own override is gone, and what stands in its place is
        // the definition's band — recorded in the preset because the preset is what a RESTART seeds
        // the member from. Leaving the map empty would rebuild this member with no history at all.
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({ instruct: DEFINITION_BAND });
        // And the frozen definition copy was never rewritten by any session write.
        expect(store.liveSession(sessionId)!.definition.agentPrefixes).toEqual({ instruct: DEFINITION_BAND });
    });

    it('reads a restated definition band as harness, and a definition with no history as none', async () => {
        const identical = openBanded({ instruct: DEFINITION_BAND });
        const identicalSession = await createSession(identical.api);

        await call(identical.api, 'PATCH', `${MOUNT}/sessions/${identicalSession}/agents/instruct`, {
            prefix: DEFINITION_BAND
        });

        const identicalRead = await prefixOf(identical.api, identicalSession);

        expect(identicalRead.body.source).toBe('harness');
        // The session DID record it (the write is real), yet the read refuses to claim a divergence
        // the model cannot observe.
        expect(identical.store.liveSession(identicalSession)!.preset.agentPrefixes).toEqual({
            instruct: DEFINITION_BAND
        });

        // A definition that seeds nothing at all: no key on the descriptor, and the read answers
        // `none` rather than inventing a layer.
        const bare = openBanded();
        const bareSession = await createSession(bare.api);
        const bareRead = await prefixOf(bare.api, bareSession);

        expect(bareRead.status).toBe(200);
        expect(bareRead.body).toEqual({ session_id: bareSession, agent_id: 'instruct', prefix: [], source: 'none' });
        expect(bare.store.liveSession(bareSession)!.definition.agentPrefixes).toBeUndefined();
    });

    it('binds a new member with its own history, and inherits the definition band when none is stated', async () => {
        const { api } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        const bound = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, {
                name: BINDING,
                profile: BINDING,
                prefix: [{ role: 'assistant', content: 'Earlier exchange.' }]
            })
        );

        expect(bound.status).toBe(201);

        const read = await prefixOf(api, sessionId, BINDING);

        expect(read.body).toEqual({
            session_id: sessionId,
            agent_id: BINDING,
            prefix: [{ role: 'assistant', content: 'Earlier exchange.' }],
            // The definition has no band for this member, so the bind's own array is the whole story.
            source: 'session'
        });

        // A second bind that states nothing asks for nothing of its own — and the definition seeds no
        // band for `summarizer` either, so `none` is the honest answer.
        const plain = jsonOf(
            await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/agents`, { name: 'reviewer', profile: 'reviewer' })
        );

        expect(plain.status).toBe(201);

        const plainRead = await prefixOf(api, sessionId, 'reviewer');

        expect(plainRead.body).toEqual({ session_id: sessionId, agent_id: 'reviewer', prefix: [], source: 'none' });
    });

    it('refuses a malformed band at the edge, in the registry wording, with nothing written', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);

        const notAnArray = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { prefix: 'nope' })
        );

        expect(notAnArray.status).toBe(400);
        expect(notAnArray.body.error.message).toBe(
            '`prefix.instruct` must be an ARRAY of preset-history turns ({ role, content }).'
        );

        const toolTurn = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
                prefix: [{ role: 'tool', content: 'Orphan.' }]
            })
        );

        expect(toolTurn.status).toBe(400);
        expect(toolTurn.body.error.message).toBe(
            '`prefix.instruct`[0] has role "tool". A preset history turn is "system", "user", or "assistant" — a tool turn belongs to a conversation, not to a preset.'
        );

        // Both refusals left the band, the preset, and the live transcript exactly as they were: the
        // session's preset copy still carries the band its definition seeded, which is what a fresh
        // session of the same card starts with.
        const read = await prefixOf(api, sessionId);

        expect(read.body.source).toBe('harness');
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({ instruct: DEFINITION_BAND });
        expect(bandOf(store, sessionId)).toEqual([
            { role: 'system', content: 'Fixture agent.' },
            ...DEFINITION_BAND
        ]);
    });

    it('carries agent_prefixes on the harness definition read and both harness write bodies', async () => {
        const { api } = openBanded({ instruct: DEFINITION_BAND });

        const created = jsonOf(
            await call(api, 'POST', `${MOUNT}/harnesses`, {
                name: 'banded-card',
                agents: ['instruct'],
                entry: 'instruct',
                agent_prefixes: { instruct: DEFINITION_BAND }
            })
        );

        expect(created.status).toBe(201);
        // The map the client sent, echoed exactly — including the ORDER inside each band, which is
        // the whole content of the field.
        expect(created.body.harness.agent_prefixes).toEqual({ instruct: DEFINITION_BAND });

        // A PATCH REPLACES the map, and an explicit `[]` on a member is a band, not a clear.
        const emptied = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/harnesses/banded-card`, { agent_prefixes: { instruct: [] } })
        );

        expect(emptied.status).toBe(200);
        expect(emptied.body.harness.agent_prefixes).toEqual({ instruct: [] });

        // `{}` clears every band, and F2 changes only what the READ looks like afterwards: the map
        // comes back EMPTY rather than leaving the row, because on this contract the identified read
        // states `agent_prefixes` on every answer. Presence is the capability a client negotiates the
        // preset editor from (the PATCH field is a whole-map REPLACE, so only a client that READ the
        // map may send `{}` back), and a server that omitted an empty map would look exactly like a
        // pre-U6 backend that has no editor at all.
        const cleared = jsonOf(await call(api, 'PATCH', `${MOUNT}/harnesses/banded-card`, { agent_prefixes: {} }));

        expect(cleared.status).toBe(200);
        expect(cleared.body.harness.agent_prefixes).toEqual({});

        // THE CAPABILITY ADVERTISEMENT: the identified read states `agent_prefixes` on EVERY
        // answer — the `{}` above for the definition whose bands were just cleared, and the seeded
        // map for the fixture card that always had one — while the CARD LIST omits the field
        // entirely, so a band stays definition detail and the identified read stays its only
        // publisher. That is what keeps "absent" meaningful for a client: a pre-U6 backend omits
        // the property on this route, and that is the signal to hide the editor rather than to send
        // a destructive `{}`.
        const clearedDefinition = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses/banded-card`));

        expect(clearedDefinition.status).toBe(200);
        expect(clearedDefinition.body.harness.agent_prefixes).toEqual({});

        const seededRead = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses/instruct`));

        expect(seededRead.status).toBe(200);
        expect(seededRead.body.harness.agent_prefixes).toEqual({ instruct: DEFINITION_BAND });

        const cards = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses`));

        expect(cards.status).toBe(200);
        expect(cards.body.items.every((card: Record<string, unknown>) => !('agent_prefixes' in card))).toBe(true);
    });

    // F1 — the frozen-definition read carries the band map this conversation was built with.
    //
    // WHY IT NEEDS ITS OWN CASE: `SessionDefinitionResource` inherits `HarnessDefinition`, so the
    // type has named `agent_prefixes` since U6, and `main.ts` uses exactly this read as the
    // fallback for a saved conversation whose per-member band read has not answered (or failed).
    // With the projection missing the field, the UI painted an empty editor over a template that
    // seeds three turns, and the durable record DID hold them the whole time (./persistence.ts
    // `readDescriptor` / `readPresetRecord` both restore the map, pinned at
    // ./persistence.test.ts:3029-3068). Asserted against the REAL read, on both halves:
    //   - a non-empty frozen map, copied byte for byte in the contract's turn shape;
    //   - a map whose only key holds `[]`, which is NON-empty and must stay keyed (an explicit
    //     "no preset history" the definition stated, not an absence);
    //   - a definition that states nothing at all, which keeps the pre-U6 row exactly (the omission
    //     rule here is deliberate — see `api-reads.ts sessionDefinitionOf`; a session negotiates the
    //     feature from `GET …/agents/{id}/prefix`, and old saved sessions stay additive-compatible).
    it('carries the frozen prefix bands on the session definition read', async () => {
        const seeded = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(seeded.api);

        const frozen = jsonOf(await call(seeded.api, 'GET', `${MOUNT}/sessions/${sessionId}/definition`));

        expect(frozen.status).toBe(200);
        // Byte for byte the band the definition seeds — and the live brain seeds the same turns,
        // which is the claim that makes this read safe to paint from.
        expect(frozen.body.definition.agent_prefixes).toEqual({ instruct: DEFINITION_BAND });
        expect(bandOf(seeded.store, sessionId)).toEqual([
            { role: 'system', content: 'Fixture agent.' },
            ...DEFINITION_BAND
        ]);

        // The copy is detached: a caller rewriting the response cannot rewrite the frozen record
        // (the same discipline `harnessDefinitionOf` and ./harnesses/descriptor.ts follow).
        frozen.body.definition.agent_prefixes.instruct[0].content = 'Rewritten by a caller.';
        expect(seeded.store.liveSession(sessionId)!.definition.agentPrefixes).toEqual({
            instruct: DEFINITION_BAND
        });

        // A keyed `[]` is a NON-empty map, so an explicit "this member seeds no history" survives
        // the projection instead of collapsing into the absent form.
        const explicit = openBanded({ instruct: [] });
        const explicitSession = await createSession(explicit.api);
        const explicitFrozen = jsonOf(
            await call(explicit.api, 'GET', `${MOUNT}/sessions/${explicitSession}/definition`)
        );

        expect(explicitFrozen.body.definition.agent_prefixes).toEqual({ instruct: [] });

        // And the pre-U6 shape: a definition that never names the map leaves the property OFF the
        // session read, so a session stored before prefixes existed answers exactly as it did.
        const bare = openBanded();
        const bareSession = await createSession(bare.api);
        const bareFrozen = jsonOf(await call(bare.api, 'GET', `${MOUNT}/sessions/${bareSession}/definition`));

        expect(bareFrozen.status).toBe(200);
        expect('agent_prefixes' in bareFrozen.body.definition).toBe(false);
    });

    // F3(a) — the prefix write obeys the SAME idle discipline as an instruction write. The store
    // gate (`./sessions.ts assertBindingIdle`, the one every binding route calls) refuses while a
    // turn is running or queued, and the runtime repeats it (`../engine/harness.ts
    // assertRosterIdle`), because `setAgentPrefix` splices the transcript a live turn is reading.
    // Pinned with the store's own `busy` flag — the same field a streaming run sets — so this is
    // the real predicate, and pinned on BOTH shapes of the request (an array and the `null` undo).
    it('refuses a prefix write while the session has live or queued work', async () => {
        const { api, store } = openBanded({ instruct: DEFINITION_BAND });
        const sessionId = await createSession(api);
        const record = store.liveSession(sessionId);

        record.busy = true;

        const written = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
                prefix: [{ role: 'user', content: 'While a turn runs.' }]
            })
        );

        expect(written.status).toBe(409);
        expect(written.body.error.message).toContain('queued work');

        const undone = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, { prefix: null })
        );

        expect(undone.status).toBe(409);
        expect(undone.body.error.message).toContain('queued work');

        // The refused requests changed NOTHING: the live band is still the one the definition
        // seeded, and the session's preset copy never recorded the attempted band.
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({ instruct: DEFINITION_BAND });
        expect(bandOf(store, sessionId)).toEqual([
            { role: 'system', content: 'Fixture agent.' },
            ...DEFINITION_BAND
        ]);

        // The gate is the run, not the field: once the session is idle the same request lands.
        record.busy = false;

        const accepted = jsonOf(
            await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
                prefix: [{ role: 'user', content: 'Once idle.' }]
            })
        );

        expect(accepted.status).toBe(200);
        expect(store.liveSession(sessionId)!.preset.agentPrefixes).toEqual({
            instruct: [{ role: 'user', content: 'Once idle.' }]
        });
    });

    it('refuses a band for a member the definition never selected, and a malformed turn', async () => {
        const { api } = openBanded();

        const unknownMember = jsonOf(
            await call(api, 'POST', `${MOUNT}/harnesses`, {
                name: 'wrong-band',
                agents: ['instruct'],
                agent_prefixes: { ghost: [{ role: 'user', content: 'Unseedable.' }] }
            })
        );

        expect(unknownMember.status).toBe(400);
        expect(unknownMember.body.error.message).toBe(
            '`agentPrefixes` names "ghost", which is not a member of this harness. Members: instruct.'
        );

        const badTurn = jsonOf(
            await call(api, 'POST', `${MOUNT}/harnesses`, {
                name: 'bad-band',
                agents: ['instruct'],
                agent_prefixes: { instruct: [{ role: 'user', content: 7 }] }
            })
        );

        expect(badTurn.status).toBe(400);
        expect(badTurn.body.error.message).toBe(
            '`agentPrefixes.instruct`[0] needs a string "content". Received 7.'
        );

        // Neither refusal created an entry: the registry still lists exactly the seeded fixture.
        const cards = jsonOf(await call(api, 'GET', `${MOUNT}/harnesses`));

        expect(cards.body.items.map((card: Record<string, unknown>) => card.name)).toEqual(['instruct']);
    });

    it('re-seeds the session band and the definition band in a second process', async () => {
        const root = tempRoot('prefix-durable');
        const first = openBandedOnDisk(root, { instruct: DEFINITION_BAND });
        const sessionId = await createSession(first.api);

        // A session-scoped band, written by the first process and durable in its own preset copy.
        const patched = jsonOf(
            await call(first.api, 'PATCH', `${MOUNT}/sessions/${sessionId}/agents/instruct`, {
                prefix: [{ role: 'user', content: 'History that must survive.' }]
            })
        );

        expect(patched.status).toBe(200);

        const document = readDocument(root);

        expect(document.sessions[0].preset.agentPrefixes).toEqual({
            instruct: [{ role: 'user', content: 'History that must survive.' }]
        });

        // A REAL restart: `load()` runs the validators (`readPresetRecord` / `readDescriptor`), and
        // the rebuilt harness seeds the band the record names — not the one the shipped template
        // seeds, and not nothing.
        const second = openBandedOnDisk(root, { instruct: DEFINITION_BAND });
        const reloaded = await call(second.api, 'GET', `${MOUNT}/sessions/${sessionId}`);
        const reloadedJson = reloaded.kind === 'json' ? (reloaded.body as Record<string, any>) : {};

        expect(reloaded.status).toBe(200);
        expect(reloadedJson.session?.id).toBe(sessionId);

        const read = await prefixOf(second.api, sessionId);

        expect(read.status).toBe(200);
        expect(read.body).toEqual({
            session_id: sessionId,
            agent_id: 'instruct',
            prefix: [{ role: 'user', content: 'History that must survive.' }],
            source: 'session'
        });

        // The frozen definition copy survived too, so the `null` undo still means the same thing
        // after a restart.
        expect(second.store.liveSession(sessionId)!.definition.agentPrefixes).toEqual({
            instruct: DEFINITION_BAND
        });
    });
});
