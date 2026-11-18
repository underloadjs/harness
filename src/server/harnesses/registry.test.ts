// The in-memory harness registry.
//
// These tests pin the contract the HTTP layer depends on: an explicit roster, trusted agent
// ids only, reserved/duplicate names, a RESOLVED rank map, every template editable (R20.1),
// and — most importantly — that update() REPLACES a preset rather than mutating it, which is
// what keeps an already-created session frozen to the configuration it was built with.
//
// THE RANK MODEL (the pass that replaced `primary` + `subagents`)
// ---------------------------------------------------------------
// A harness definition is THREE fields, and each has exactly one rule:
//   - `agents` — a NON-EMPTY roster in DECLARATION ORDER. Order is ROUTING: its first name is
//     the entry default. No member may be listed twice, and nothing caps how many members
//     share a rank;
//   - `entry`  — ROUTING. Omitted means roster[0]; stated must name a member. It carries no
//     authority, so the entry agent may hold ANY rank, including the lowest one;
//   - `ranks`  — AUTHORITY: agent id → a single A–Z letter (A highest). The STORED map is
//     RESOLVED and COMPLETE — a request may name fewer members, and the server fills every
//     name it omitted ONE RANK BELOW the lowest rank the request stated, entry agent included
//     (./toolbox.ts `resolveRosterRanks`, the host mirror of the kernel's fill at
//     ../../harness.ts:1505-1545). Storing the resolved map is what keeps the durable record,
//     the card, and the construction argument stating the same ranks.
//
// Delegation follows from those ranks and NOTHING else (strictly downward), so there is NO
// "exactly one primary" invariant left in this file and no allowlist to assert: several members
// may hold Rank A, a harness may have no Rank A member at all, and `Harness.ranks` replaces the
// removed `harness.subagents` view.
//
// R20.1 specifics:
//   - the registry starts from independent copies of the shipped templates;
//   - a metadata-only patch keeps the captured factory (demo's script, flaky's
//     testFlaky extra);
//   - an executable patch rebuilds demo as an honest live profiled harness and
//     flaky as the live toolbox with testFlaky retained.
//
// No provider and no network: constructing a preset never calls the transport.
//
// AGENT ROSTER / ROLE-CONTRACT PASS (what the assertions below re-pinned)
// ----------------------------------------------------------------------
//   - the trusted roster is 10 ids in order: general, instruct, research, workspace,
//     reviewer, planner, debugger, summarizer, demo, flaky. `research`/`workspace`/
//     `planner` keep their ids (an agent id is persisted and has no alias fallback) and
//     only their TITLES moved to Explore / Analyst / Manager;
//   - the shipped catalogue is 8 live cards, general first (the default); its order is
//     exactly what `GET /harnesses` returns;
//   - a built-in team is an `entry` + `ranks` PAIR: the entry agent at Rank A, every other
//     live role MINUS the Manager (`planner` refuses to run as a delegate,
//     ../../agents/planner.ts) plus the summarizer at Rank B. So the Manager appears at Rank A
//     on its OWN card only, and never as another card's junior — the shape the removed
//     `teamOf(primary)` helper used to derive from an allowlist is now data on the card;
//   - the harness-level aliases are UNCHANGED (writer/assistant -> instruct,
//     researcher -> research) because they map HARNESS names, not agent titles — and the
//     titles General/Explore/Analyst/Manager/Debugger are not names and do not resolve.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../harness';
import type { HarnessProgress } from '../../harness';
import type { HarnessPreset } from './types';
import type { HarnessRegistry } from './registry';
import {
    createHarnessRegistry,
    isLegacyShippedDefinition,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord,
    restoreHarnessRegistry
} from './registry';
import { describeHarness } from './descriptor';
import { LEGACY_PRESET_DEFINITIONS, presets } from './presets';
import { FIXTURE_PRESETS, PRODUCTION_WITH_FIXTURES } from './fixture-presets.test-support';
import { SHARED_TOOL_NAMES } from './toolbox';
// `AGENT_PROFILE_NAMES` is deliberately NOT imported: the roster assertions below are written
// as literal id lists, so renaming/adding a profile is a visible test edit rather than a
// change that re-derives the expectation from the same source it checks.
// `agentInstruction` is imported rather than re-typed here: a no-override member must
// equal exactly what the trusted catalogue composes, and duplicating the prose (or the
// join rule) in this file is how a pin silently drifts from the shipped prompt.
import { AGENT_PROFILES, agentInstruction } from '../../agents';

// The exact tool-order assertions below assume a KEYLESS host: search is
// registered only when EXA_API_KEY/TAVILY_API_KEY resolves (harness.ts:728-738),
// while fetch is keyless and registers whenever the factory opts in
// (harness.ts:753-761). Pin the env so a developer shell holding real keys cannot
// insert search ahead of fetch and turn a correct order into a failure.
beforeEach(() => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'test-model'
};

// Constructing a preset routes no events, so this sink stays empty.
const progress: HarnessProgress = async () => undefined;

const registryError = (run: () => unknown): { status: number; message: string } => {
    try {
        run();
    } catch (error) {
        const failure = error as { status?: number; message: string };
        return { status: failure.status ?? 0, message: failure.message };
    }

    throw new Error('expected the registry to throw');
};

// T5: the scripted demo and the flaky example are no longer part of the shipped
// catalogue, so every test below that pins THEIR template rules (a metadata-only
// patch keeps the script; an executable patch upgrades it) has to ask for them by
// name. That is exactly what a host or a test does now: an explicit fixture
// injection, not a default that ships them.
const fixtureRegistry = (): HarnessRegistry => createHarnessRegistry(PRODUCTION_WITH_FIXTURES);

describe('the shipped registry', () => {
    it('lists every template as an independent, editable copy', () => {
        const registry = createHarnessRegistry();

        // Seven live cards, DEFAULT FIRST, with the titles the roster/role pass shipped
        // (presets.ts:486-494).
        // `research`/`workspace`/`planner` keep their ids and carry the new visible titles
        // Explore/Analyst/Manager; `general` and `debugger` are the two new profiles.
        expect(
            registry.list().map((preset) => ({
                name: preset.name,
                title: preset.title,
                builtin: preset.builtin,
                editable: preset.editable
            }))
        ).toEqual([
            { name: 'general', title: 'General', builtin: true, editable: true },
            { name: 'instruct', title: 'Instruct', builtin: true, editable: true },
            { name: 'research', title: 'Explore', builtin: true, editable: true },
            { name: 'workspace', title: 'Analyst', builtin: true, editable: true },
            { name: 'reviewer', title: 'Reviewer', builtin: true, editable: true },
            { name: 'planner', title: 'Manager', builtin: true, editable: true },
            { name: 'debugger', title: 'Debugger', builtin: true, editable: true },
            // Issue 0005-D: the tool-less card is a production entry like the roles — built-in and
            // editable — and it trails them because it is not a role.
            { name: 'chat', title: 'Chat', builtin: true, editable: true }
        ]);

        // R20.1: independent copies. No registry entry aliases a shipped template
        // object or its mutable arrays, so editing one registry cannot leak into
        // another (or into the module constants).
        // The catalogue index moved with the roster: `presets[0]` is now `general`, so the
        // copy guard below runs against instruct at its CURRENT index (1).
        const instruct = registry.find('instruct')!;
        expect(presets[0].name).toBe('general');
        expect(presets[1].name).toBe('instruct');
        expect(instruct).not.toBe(presets[1]);
        expect(instruct.tools).not.toBe(presets[1].tools);
        // The rank map is one of the copied objects: a registry entry must never hand out the
        // shipped module's own map, or an edit here would leak into every other registry.
        expect(instruct.ranks).not.toBe(presets[1].ranks);

        const other = createHarnessRegistry();
        registry.update('instruct', { title: 'Edited' });
        expect(other.find('instruct')?.title).toBe('Instruct');
        expect(presets[1].title).toBe('Instruct');
    });

    it('ships only real production configurations and keeps the fixtures explicit (T5)', () => {
        // The default catalogue is exactly the seven live roles: nothing scripted, nothing
        // that fails on purpose. A user picking a card gets a harness that talks to the
        // configured provider with the shared toolbox. The two new profiles from the roster
        // pass (`general`, `debugger`) join it, `general` first because it is the default
        // entry point (DEFAULT_CLI_PRESET in ../cli/options.ts).
        expect(createHarnessRegistry().list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(presets.map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        // The catalogue ORDER is the `GET /harnesses` order, the picker order, and the order
        // the frontend palette assigns tones by, so the titles travel with it (presets.ts:483-494).
        expect(presets.map((preset) => preset.title)).toEqual([
            'General',
            'Instruct',
            'Explore',
            'Analyst',
            'Reviewer',
            'Manager',
            'Debugger',
            // The tool-less card's title (issue 0005-D), last like the card.
            'Chat'
        ]);

        // The DEFAULT card's contract (the `general` entry in ./presets.ts): its roster holds
        // ONE rank, so the runtime never even registers `delegate` for it — the default agent
        // cannot split work out, not even by accident. Rank, not an allowlist, is what makes it
        // alone: its own rank is 'A' and there is nobody below it. (The tool-less `chat` card
        // runs the same profile and the same one-rank map; ./presets.test.ts pins that pair.)
        const general = presets[0];
        expect([general.entry, general.ranks, general.agents]).toEqual([
            'general',
            { general: 'A' },
            ['general']
        ]);
        const generalHarness = general.create(SETTINGS, progress);
        expect(generalHarness.ranks).toEqual({ general: 'A' });
        expect(generalHarness.tools.delegate).toBeUndefined();

        // The fixtures still exist as presets — they are just not shipped. Their
        // behaviour is unchanged (demo stays offline/scripted, flaky keeps its
        // failing tool), and a host that wants them asks for them by name.
        expect(FIXTURE_PRESETS.map((preset) => preset.name)).toEqual(['demo', 'flaky']);
        expect(FIXTURE_PRESETS.map((preset) => [preset.name, preset.template, preset.requiresEndpoint])).toEqual([
            ['demo', 'scripted', false],
            ['flaky', 'flaky', true]
        ]);

        const injected = createHarnessRegistry(PRODUCTION_WITH_FIXTURES);

        expect(injected.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat',
            'demo',
            'flaky'
        ]);

        // `PRODUCTION_WITH_FIXTURES` is the lookup superset restore depends on: a
        // session frozen on the scripted demo rebuilds even though demo left the
        // catalogue (see ./restore.test.ts and ./registry.ts presetFromRecord).
        expect(PRODUCTION_WITH_FIXTURES.map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat',
            'demo',
            'flaky'
        ]);
    });

    it('exposes the trusted agent profiles in catalogue order', () => {
        const registry = createHarnessRegistry();

        // The exact roster (src/agents/index.ts:78-89). The ids `research`, `workspace` and
        // `planner` are UNCHANGED on purpose — an agent id is persisted in every record and
        // there is no agent-id alias fallback — while their visible titles moved to Explore /
        // Analyst / Manager, and two new profiles (`general`, `debugger`) joined the roster.
        expect(registry.agents().map((profile) => profile.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'summarizer'
        ]);
        // Titles are catalogue data too, and they are the pair the card/picker renders.
        expect(registry.agents().map((profile) => profile.title)).toEqual([
            'General',
            'Instruct',
            'Explore',
            'Analyst',
            'Reviewer',
            'Manager',
            'Debugger',
            'Summarizer'
        ]);
    });

    it('resolves legacy aliases for lookup but not for update', () => {
        const registry = createHarnessRegistry();

        // The aliases map HARNESS names, not agent titles, so the roster pass left it
        // exactly as it was (registry.ts:114-118): writer/assistant -> instruct,
        // researcher -> research.
        expect(registry.find('writer')?.name).toBe('instruct');
        expect(registry.find('assistant')?.name).toBe('instruct');
        expect(registry.find('researcher')?.name).toBe('research');
        expect(registry.find('nope')).toBeUndefined();

        // The new/moved VISIBLE TITLES are titles, not names: no alias was added for them
        // (presets.ts:82-93), and lookup is exact-key + alias-map only (registry.ts:1187-1193).
        // `General`/`Debugger` are titles whose id is lowercase-shipped, and a lookup is
        // case-sensitive, so the capitalized form resolves to nothing.
        expect(registry.find('General')).toBeUndefined();
        expect(registry.find('Explore')).toBeUndefined();
        expect(registry.find('Analyst')).toBeUndefined();
        expect(registry.find('Manager')).toBeUndefined();
        expect(registry.find('Debugger')).toBeUndefined();
        // The new ids themselves are real names: both are shipped cards.
        expect(registry.find('general')?.title).toBe('General');
        expect(registry.find('debugger')?.title).toBe('Debugger');
        // A title reserves nothing (an `Explore` harness is still free to create), while a
        // shipped id stays taken case-insensitively, so `General` cannot shadow `general`.
        expect(registry.create({ name: 'Explore', agents: ['research'] }).name).toBe('Explore');
        expect(registryError(() => registry.create({ name: 'General', agents: ['instruct'] }))).toEqual({
            status: 409,
            message: 'Harness "General" already exists.'
        });

        expect(registryError(() => registry.update('writer', { title: 'Writer' }))).toEqual({
            status: 404,
            message: 'Unknown harness "writer".'
        });
    });
});

describe('creating a harness', () => {
    it('registers an explicit roster with its entry agent, a resolved rank map, and the shared toolbox', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'my-review',
            title: 'My review',
            description: 'A review pairing.',
            agents: ['research', 'summarizer']
        });

        expect({
            name: preset.name,
            title: preset.title,
            description: preset.description,
            requiresEndpoint: preset.requiresEndpoint,
            entry: preset.entry,
            ranks: preset.ranks,
            agents: preset.agents,
            tools: preset.tools,
            environmentTools: preset.environmentTools,
            builtin: preset.builtin,
            editable: preset.editable
        }).toEqual({
            name: 'my-review',
            title: 'My review',
            description: 'A review pairing.',
            requiresEndpoint: true,
            // ROUTING: an omitted `entry` is the FIRST name of the roster the client sent. Order
            // is a routing statement only — nothing here says that name outranks the others.
            entry: 'research',
            // AUTHORITY, RESOLVED. An omitted rank map is the kernel's rule-1 default: the entry
            // agent at 'A' and every other member ONE RANK BELOW at 'B' (../../harness.ts
            // 1505-1545, mirrored by `resolveRosterRanks` in ./toolbox.ts). The map is STORED
            // complete — every member keyed — so the card, the durable record, and the argument
            // handed to `harness()` all state the same ranks instead of re-deriving them.
            ranks: { research: 'A', summarizer: 'B' },
            agents: ['research', 'summarizer'],
            tools: SHARED_TOOL_NAMES,
            // The live toolbox opts into websearch AND webfetch; search stays
            // unadvertised on a keyless host because the catalogue has no executable
            // entry, while fetch (native) registers everywhere (R9-R11).
            environmentTools: ['search', 'fetch'],
            builtin: false,
            editable: true
        });

        // It is a real harness: same agents, same registry, and `delegate` exists exactly
        // because the roster SPANS TWO RANKS — not because an allowlist named a target.
        const harness = preset.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['research', 'summarizer']);
        expect(harness.ranks).toEqual({ research: 'A', summarizer: 'B' });
        expect(harness.tools.delegate.visibility).toBe('core');
        // R9-R11: createToolboxHarness opts into `webfetch: true`, and the harness
        // appends environment tools after the configured table and before the
        // harness-owned core set (harness.ts:740-761). search is absent because
        // this host is keyless; fetch needs no credential, so it lands first of
        // the appended tools and is declared core like a configured search.
        expect(Object.keys(harness.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',

            'tasks',
            'profiles',
            'chapters',
            'locations',
            'knowledge',
            'agentManage',
            'agentResult',
            'delegate',
            'threadFork',
            'toolCancel',
            ...SHARED_TOOL_NAMES,
            'fetch'
        ]);

        // The registry lists it after the built-ins.
        expect(registry.list().map((entry) => entry.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat',
            'my-review'
        ]);
    });

    it('defaults title to the name and description to empty, and a one-member roster to one rank', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({ name: 'solo', agents: ['workspace'] });

        expect(preset.title).toBe('solo');
        expect(preset.description).toBe('');
        expect(preset.entry).toBe('workspace');
        // A one-member roster has nobody BELOW the entry, so the resolved map holds one rank —
        // and a single-rank roster registers no `delegate` row at all (the kernel's
        // `rosterHasDelegation()` in ../../harness.ts). The refusal to split work is a property
        // of the ranks, not of a missing allowlist entry.
        expect(preset.ranks).toEqual({ workspace: 'A' });
        expect(preset.agents).toEqual(['workspace']);

        expect(preset.create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('rejects bad names, reserved aliases, duplicates and unknown agents', () => {
        const registry = createHarnessRegistry();

        expect(registryError(() => registry.create({ name: '1nope', agents: ['instruct'] }))).toEqual({
            status: 400,
            message:
                '`name` must start with a letter and contain only letters, digits, "_" or "-", at most 64 characters.'
        });

        expect(registryError(() => registry.create({ name: 'writer', agents: ['instruct'] }))).toEqual({
            status: 400,
            message: 'Harness name "writer" is reserved as an alias of "instruct".'
        });

        expect(registryError(() => registry.create({ name: 'instruct', agents: ['instruct'] }))).toEqual({
            status: 409,
            message: 'Harness "instruct" already exists.'
        });

        // Case-insensitive: a second card that differs only by case is ambiguous.
        expect(registryError(() => registry.create({ name: 'Instruct', agents: ['instruct'] }))).toEqual({
            status: 409,
            message: 'Harness "Instruct" already exists.'
        });

        expect(registryError(() => registry.create({ name: 'x', agents: ['nobody'] }))).toEqual({
            status: 400,
            // The refusal names the whole trusted roster, in `AGENT_PROFILE_NAMES` order
            // (src/agents/index.ts:78-89) — pinned as literal prose so a renamed or added
            // profile is a deliberate test edit rather than a silent message change. The FIELD
            // name is now `agents`: there is one roster field, not a primary plus an allowlist.
            message:
                '`agents` names unknown agent "nobody". Known agents: general, instruct, research, workspace, reviewer, planner, debugger, summarizer.'
        });
    });

    it('refuses a roster that is not an array, is empty, is too long, or repeats a member', () => {
        const registry = createHarnessRegistry();

        // A roster is an ARRAY of names. Anything else is a client that sent the old scalar
        // shape, and the message says what `agents` has to be.
        expect(
            registryError(() => registry.create({ name: 'x', agents: 'instruct' as never }))
        ).toEqual({
            status: 400,
            message: '`agents` must be a non-empty array of agent names.'
        });

        // An EMPTY roster is refused rather than defaulted: a harness with no agent cannot run
        // a turn, and silently picking someone would make the entry default (the first name)
        // depend on a value the client never sent.
        expect(registryError(() => registry.create({ name: 'x', agents: [] }))).toEqual({
            status: 400,
            message: '`agents` must name at least one agent; a harness with no agent cannot run a turn.'
        });

        // A name listed TWICE is ambiguous — which occurrence, and which rank entry, was meant?
        // The registry refuses instead of guessing, which is also what replaced the old
        // "subagent X is the primary agent" refusal: an agent may now appear exactly ONCE,
        // whatever rank it holds.
        expect(
            registryError(() => registry.create({ name: 'x', agents: ['instruct', 'instruct'] }))
        ).toEqual({
            status: 400,
            message: 'Agent "instruct" is listed in `agents` more than once.'
        });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: Array.from({ length: 17 }, () => 'instruct') })
            )
        ).toEqual({
            status: 400,
            // The cap is checked BEFORE the duplicate scan, so 17 entries is a length refusal.
            message: '`agents` cannot exceed 16 entries.'
        });

        expect(
            registryError(() => registry.create({ name: 'x', agents: ['instruct', 'critic'] }))
        ).toEqual({
            status: 400,
            // Same roster prose as the refusal above (./registry.ts `requireAgent`).
            message:
                '`agents` names unknown agent "critic". Known agents: general, instruct, research, workspace, reviewer, planner, debugger, summarizer.'
        });
    });

    it('fills an unlisted rank one letter below the LOWEST rank the request stated — entry agent included', () => {
        const registry = createHarnessRegistry();

        // The client named ONE member and left the entry agent unranked. The kernel's rule
        // (../../harness.ts:1505-1545) puts every member the map omits one rank BELOW the
        // lowest rank the map states, and that includes the entry agent — so a map that ranks a
        // junior at 'B' leaves the entry at 'C'. Being first in the roster buys routing, never
        // authority.
        const preset = registry.create({
            name: 'inverted',
            agents: ['research', 'summarizer'],
            ranks: { summarizer: 'B' }
        });

        expect(preset.entry).toBe('research');
        expect(preset.ranks).toEqual({ summarizer: 'B', research: 'C' });

        // The runtime runs with exactly the stored map: the host resolved it once, and the
        // kernel re-derives nothing.
        const harness = preset.create(SETTINGS, progress);
        expect(harness.ranks).toEqual({ summarizer: 'B', research: 'C' });
        // Delegation follows the ranks, not the roster order: the Rank B member may hand work to
        // the Rank C one, and the roster spans two ranks, so `delegate` is registered.
        expect(harness.tools.delegate).toBeDefined();
    });

    it('reads an empty rank map as a flat team, and accepts several Rank A agents', () => {
        const registry = createHarnessRegistry();

        // `ranks: {}` states NO rank, so the fill puts every member one below the lowest stated
        // rank — and with nothing stated that is 'B', the entry agent included. One distinct
        // rank means no delegation anywhere: this is the explicit "a team of peers" shape the
        // old model could not express.
        const peers = registry.create({ name: 'peers', agents: ['instruct', 'research'], ranks: {} });

        expect(peers.entry).toBe('instruct');
        expect(peers.ranks).toEqual({ instruct: 'B', research: 'B' });
        expect(peers.create(SETTINGS, progress).tools.delegate).toBeUndefined();

        // TWO Rank A AGENTS ARE LEGAL. The removed model needed a rule against it ("a harness
        // has exactly one primary"); the rank model needs none, because delegation is strictly
        // DOWNWARD — two peers simply cannot hand work to each other, and both may hand it to
        // the junior below them. Nothing promoted, flattened, or rejected this map.
        const coLeads = registry.create({
            name: 'co-leads',
            agents: ['instruct', 'research', 'summarizer'],
            ranks: { instruct: 'A', research: 'A', summarizer: 'C' }
        });

        expect(coLeads.entry).toBe('instruct');
        expect(coLeads.ranks).toEqual({ instruct: 'A', research: 'A', summarizer: 'C' });

        const harness = coLeads.create(SETTINGS, progress);
        expect(harness.ranks).toEqual({ instruct: 'A', research: 'A', summarizer: 'C' });
        expect(Object.keys(harness.agents)).toEqual(['instruct', 'research', 'summarizer']);
        expect(harness.tools.delegate.visibility).toBe('core');
    });

    it('validates `entry` as routing and `ranks` as authority, independently', () => {
        const registry = createHarnessRegistry();

        // `entry` must name a MEMBER, and the refusal lists the members: the usual mistake is a
        // client that renamed an agent or sent an `entry` for a member it forgot to add.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], entry: 'research' })
            )
        ).toEqual({
            status: 400,
            message:
                '`entry` names "research", which is not a member of this harness. Members: instruct.'
        });

        // A rank key for an agent this harness does not select can never apply, so it is a
        // visible 400 rather than a stored no-op — the same reasoning the model map follows.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], ranks: { research: 'A' } })
            )
        ).toEqual({
            status: 400,
            message:
                '`ranks` names "research", which is not a member of this harness. Members: instruct.'
        });

        // A rank VALUE is one upper-case letter, checked with the shared `isAgentRank` guard
        // rather than a re-spelled letter set. Case matters: `'a'` is refused instead of quietly
        // upper-cased, because a lowercase letter is exactly what a hand-edited document or a UI
        // bug produces.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], ranks: { instruct: 'a' as never } })
            )
        ).toEqual({
            status: 400,
            message:
                '`ranks.instruct` must be a single rank letter from A (highest) to Z (lowest), upper-case. Received "a".'
        });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], ranks: { instruct: 7 as never } })
            )
        ).toEqual({
            status: 400,
            message:
                '`ranks.instruct` must be a single rank letter from A (highest) to Z (lowest), upper-case. Received 7.'
        });

        expect(
            registryError(() => registry.create({ name: 'x', agents: ['instruct'], ranks: [] as never }))
        ).toEqual({
            status: 400,
            message: '`ranks` must be an object mapping agent ids to rank letters.'
        });

        // ROUTING SAYS NOTHING ABOUT AUTHORITY, and the edge accepts that on purpose: the entry
        // agent here is the LOWEST-ranked member of its own harness, so requests land on an agent
        // that has nobody below it while a senior still holds the delegation.
        const routed = registry.create({
            name: 'low-entry',
            agents: ['instruct', 'summarizer'],
            entry: 'summarizer',
            ranks: { instruct: 'A', summarizer: 'B' }
        });

        expect(routed.entry).toBe('summarizer');
        expect(routed.ranks).toEqual({ instruct: 'A', summarizer: 'B' });
        expect(routed.create(SETTINGS, progress).ranks).toEqual({ instruct: 'A', summarizer: 'B' });
    });

    it('validates title and description types and bounds', () => {
        const registry = createHarnessRegistry();

        expect(
            registryError(() => registry.create({ name: 'x', agents: ['instruct'], title: 7 as never }))
        ).toEqual({ status: 400, message: '`title` must be a string.' });

        expect(
            registryError(() => registry.create({ name: 'x', agents: ['instruct'], title: '   ' }))
        ).toEqual({ status: 400, message: '`title` cannot be empty.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], title: 'a'.repeat(121) })
            )
        ).toEqual({ status: 400, message: '`title` cannot exceed 120 characters.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], description: 'a'.repeat(2001) })
            )
        ).toEqual({ status: 400, message: '`description` cannot exceed 2000 characters.' });
    });
});

describe('updating a harness', () => {
    it('replaces metadata, roster, routing and authority without mutating the old preset', () => {
        const registry = createHarnessRegistry();
        const before = registry.find('instruct')!;

        // A real client restates the three roster fields together, because they are three
        // INDEPENDENT statements: who is on the team, who receives the turn, and what each
        // member may delegate to.
        const after = registry.update('instruct', {
            title: 'Instruct (edited)',
            description: 'Edited description.',
            agents: ['workspace', 'research', 'summarizer'],
            entry: 'workspace',
            ranks: { workspace: 'A', research: 'B' }
        });

        expect({
            title: after.title,
            description: after.description,
            entry: after.entry,
            ranks: after.ranks,
            agents: after.agents
        }).toEqual({
            title: 'Instruct (edited)',
            description: 'Edited description.',
            entry: 'workspace',
            // The stated map, FILLED: `summarizer` is the member the patch did not name, so it
            // takes one rank BELOW the lowest rank the patch stated ('B') → 'C'. A PATCH resolves
            // the map with the same rule create() applies, so a card never stores a partial map
            // the next start would have to re-derive (./toolbox.ts `resolveRosterRanks`).
            ranks: { workspace: 'A', research: 'B', summarizer: 'C' },
            // A stated roster REPLACES the members, order included.
            agents: ['workspace', 'research', 'summarizer']
        });

        // The objects handed out BEFORE the patch are untouched: a session that
        // captured `before` keeps running the original configuration.
        expect({
            title: before.title,
            description: before.description,
            entry: before.entry,
            ranks: before.ranks,
            agents: before.agents
        }).toEqual({
            title: 'Instruct',
            // The shipped description, byte-for-byte: the patch replaced the
            // registry entry, not the object the old session captured.
            description: presets[1].description,
            entry: 'instruct',
            // The shipped card, as data: the entry agent at Rank A and every OTHER live role
            // except the Manager (`planner`, which refuses to run as a delegate) plus the
            // summarizer at Rank B. `teamOf(primary)` is gone — this map is the team now.
            ranks: {
                instruct: 'A',
                general: 'B',
                research: 'B',
                workspace: 'B',
                reviewer: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            agents: ['instruct', 'general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer']
        });
        expect(before).not.toBe(after);
        expect(registry.find('instruct')).toBe(after);

        // The rebuilt harness runs with the stored map, and `delegate` follows the two ranks.
        const harness = after.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual(['workspace', 'research', 'summarizer']);
        expect(harness.ranks).toEqual({ workspace: 'A', research: 'B', summarizer: 'C' });
        expect(harness.tools.delegate.visibility).toBe('core');
    });

    it('re-targets routing on its own, and keeps every rank the operator stated', () => {
        const registry = createHarnessRegistry();

        // Explore ships as `entry: research` at Rank A over seven members. Patching `entry`
        // ALONE is a routing decision, so it changes exactly that:
        //   - the roster keeps its stored ORDER. Order is only the entry DEFAULT, so there is
        //     nothing to reorder and no allowlist to prune — the rule that "removed the new
        //     primary from subagents" is gone with the allowlist itself;
        //   - every rank survives, so `research` stays Rank A and the new entry stays Rank B.
        const after = registry.update('research', { entry: 'summarizer' });

        expect(after.entry).toBe('summarizer');
        expect(after.agents).toEqual([
            'research',
            'general',
            'instruct',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);
        expect(after.ranks).toEqual({
            research: 'A',
            general: 'B',
            instruct: 'B',
            workspace: 'B',
            reviewer: 'B',
            debugger: 'B',
            summarizer: 'B'
        });

        // ROUTING DOES NOT BUY AUTHORITY. The entry agent here is Rank B, so IT has no legal
        // target — while the roster still spans two ranks, so `delegate` is registered (for the
        // Rank A member that stayed on the team). The entry-first registration order is what the
        // factory applies, and it changes nothing about the ranks.
        const harness = after.create(SETTINGS, progress);
        expect(Object.keys(harness.agents)).toEqual([
            'summarizer',
            'research',
            'general',
            'instruct',
            'workspace',
            'reviewer',
            'debugger'
        ]);
        expect(harness.ranks).toEqual({
            summarizer: 'B',
            research: 'A',
            general: 'B',
            instruct: 'B',
            workspace: 'B',
            reviewer: 'B',
            debugger: 'B'
        });
        expect(harness.tools.delegate).toBeDefined();
    });

    it('restricts an unrestated rank map to surviving members, and never invents a Rank A', () => {
        const registry = createHarnessRegistry();

        // Replace the roster and say NOTHING about ranks. Two rules run in order:
        //   1. the current map is RESTRICTED TO THE SURVIVORS — a rank for a member this patch
        //      removed can no longer apply, so it is dropped rather than rejected;
        //   2. routing falls back to the FIRST name of the new roster, because this patch dropped
        //      the entry agent and a harness can never be routed at an agent it no longer holds.
        const after = registry.update('instruct', { agents: ['general', 'research', 'summarizer'] });

        expect(after.entry).toBe('general');
        // Every survivor kept its stated 'B', and nothing was PROMOTED into the vacated top rank:
        // a rank is authority the operator stated, and the host does not manufacture one because
        // a seat emptied. One distinct rank, therefore no delegation — a visible consequence the
        // card reports, not a silent substitution.
        expect(after.ranks).toEqual({ general: 'B', research: 'B', summarizer: 'B' });

        const harness = after.create(SETTINGS, progress);
        expect(harness.ranks).toEqual({ general: 'B', research: 'B', summarizer: 'B' });
        expect(harness.tools.delegate).toBeUndefined();
    });

    it('fills a member a PATCH added one rank below the lowest rank that survives', () => {
        const registry = createHarnessRegistry();

        // `planner` is the one catalogue profile the shipped Instruct team does not select, so
        // it is a real newcomer here. The retained map covers the two surviving members
        // (Instruct 'A', summarizer 'B'); the newcomer is unlisted, so it takes one rank BELOW
        // the LOWEST rank that survived — never 'A' by accident, and never a duplicate of its
        // new peers.
        const after = registry.update('instruct', { agents: ['instruct', 'planner', 'summarizer'] });

        expect(after.entry).toBe('instruct');
        expect(after.ranks).toEqual({ instruct: 'A', summarizer: 'B', planner: 'C' });

        const harness = after.create(SETTINGS, progress);
        expect(harness.ranks).toEqual({ instruct: 'A', summarizer: 'B', planner: 'C' });
        // Three ranks in the roster, and the Rank B member now has a junior of its own — which is
        // the two-level chain the old flat allowlist could not express.
        expect(harness.tools.delegate.visibility).toBe('core');
    });

    it('replaces the rank map on a PATCH, and reads `{}` as a flat team', () => {
        const registry = createHarnessRegistry();

        // A STATED map REPLACES: the operator's new map is the whole statement, so a member the
        // new map omits is filled, not carried over from the old one.
        const restacked = registry.update('instruct', { ranks: { instruct: 'A', general: 'C' } });

        expect(restacked.ranks).toEqual({
            instruct: 'A',
            general: 'C',
            // Every other member is unlisted, so each takes one below the lowest stated rank.
            research: 'D',
            workspace: 'D',
            reviewer: 'D',
            debugger: 'D',
            summarizer: 'D'
        });

        // `{}` clears EVERY rank. With nothing stated the fill lands one below Rank A, which is
        // 'B' for all seven members: one flat rank, and no `delegate` row anywhere.
        const flattened = registry.update('instruct', { ranks: {} });

        expect(flattened.ranks).toEqual({
            instruct: 'B',
            general: 'B',
            research: 'B',
            workspace: 'B',
            reviewer: 'B',
            debugger: 'B',
            summarizer: 'B'
        });
        expect(flattened.create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('treats a roster that shares NO member with the old team as UNRANKED, not as flat', () => {
        const registry = fixtureRegistry();

        // The scripted fixture's roster is `general` alone, so a wholesale roster swap leaves
        // NOTHING for the rank restriction to keep. An OMITTED `ranks` is "no opinion", not "no
        // ranks", so the map is filled by the same rule-1 default create() applies — entry 'A',
        // every other member 'B'. That matters: a two-member new team keeps the delegation
        // surface an equivalent POST would have given it, instead of silently losing it because
        // the host read its own empty derived map as the client's statement.
        const swapped = registry.update('demo', { agents: ['workspace', 'research'] });

        expect(swapped.entry).toBe('workspace');
        expect(swapped.ranks).toEqual({ workspace: 'A', research: 'B' });
        expect(swapped.create(SETTINGS, progress).tools.delegate.visibility).toBe('core');

        // The same harness, one PATCH later, with the map STATED EMPTY: now the client has
        // spoken, and 'flat' is exactly what it asked for.
        const flattened = registry.update('demo', { ranks: {} });

        expect(flattened.ranks).toEqual({ workspace: 'B', research: 'B' });
        expect(flattened.create(SETTINGS, progress).tools.delegate).toBeUndefined();
    });

    it('validates a patched roster, entry and rank map against the final roster', () => {
        const registry = createHarnessRegistry();

        // A rank key for an agent this harness does not select is a 400 that lists the members.
        // `planner` is exactly that on Explore's roster.
        expect(registryError(() => registry.update('research', { ranks: { planner: 'C' } }))).toEqual({
            status: 400,
            message:
                '`ranks` names "planner", which is not a member of this harness. Members: research, general, instruct, workspace, reviewer, debugger, summarizer.'
        });

        // `entry` is validated against the roster the SAME patch produced, so a patch that both
        // narrows the roster and restates routing cannot route at a member it just dropped.
        expect(
            registryError(() =>
                registry.update('research', { agents: ['research', 'general'], entry: 'summarizer' })
            )
        ).toEqual({
            status: 400,
            message:
                '`entry` names "summarizer", which is not a member of this harness. Members: research, general.'
        });

        // A rank VALUE is one upper-case letter, whatever the patch shape.
        expect(
            registryError(() => registry.update('research', { ranks: { research: 'b' as never } }))
        ).toEqual({
            status: 400,
            message:
                '`ranks.research` must be a single rank letter from A (highest) to Z (lowest), upper-case. Received "b".'
        });

        // An unknown member names the whole trusted roster (the same message create() gives).
        expect(registryError(() => registry.update('research', { agents: ['nobody'] }))).toEqual({
            status: 400,
            message:
                '`agents` names unknown agent "nobody". Known agents: general, instruct, research, workspace, reviewer, planner, debugger, summarizer.'
        });
    });

    it('patches every shipped template and rejects only unknown names', () => {
        const registry = fixtureRegistry();

        // R20.1: no read-only category. A metadata-only patch is a 200 for the
        // formerly frozen demo/flaky templates too (T5: injected, not shipped).
        expect(registry.update('demo', { title: 'Demo!' }).title).toBe('Demo!');
        expect(registry.update('flaky', { title: 'Flaky!' }).title).toBe('Flaky!');

        expect(registryError(() => registry.update('missing', { title: 'x' }))).toEqual({
            status: 404,
            message: 'Unknown harness "missing".'
        });
    });

    it('keeps the demo script and flaky extras through a metadata-only patch', () => {
        const registry = fixtureRegistry();
        const demoBefore = registry.find('demo')!;
        const flakyBefore = registry.find('flaky')!;

        const demoAfter = registry.update('demo', {
            title: 'Scripted demo (renamed)',
            description: 'Edited description.'
        });
        const flakyAfter = registry.update('flaky', {
            title: 'Recoverable failures (renamed)'
        });

        // The factory is the SAME closure: metadata is not execution, so the
        // scripted transport and the timeNow-only registry survive.
        expect(demoAfter.create).toBe(demoBefore.create);
        expect(demoAfter.tools).toEqual(['timeNow']);
        expect(demoAfter.requiresEndpoint).toBe(false);
        expect(demoAfter.template).toBe('scripted');

        // The flaky example keeps its extra tool and shared toolbox declaration.
        expect(flakyAfter.create).toBe(flakyBefore.create);
        expect(flakyAfter.tools).toEqual([...SHARED_TOOL_NAMES, 'testFlaky']);
        expect(flakyAfter.environmentTools).toEqual(['search', 'fetch']);
        expect(flakyAfter.template).toBe('flaky');

        // The runtime really keeps them: these are the exact registered names.
        expect(Object.keys(demoAfter.create(SETTINGS, progress).tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',

            'tasks',
            'profiles',
            'chapters',
            'locations',
            'knowledge',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel',
            'timeNow'
        ]);
        expect(Object.keys(flakyAfter.create(SETTINGS, progress).tools)).toContain('testFlaky');

        // The old objects are untouched; a session that captured them keeps the
        // injected metadata too.
        expect(demoBefore.title).toBe('Scripted fixture');
        expect(flakyBefore.title).toBe('Recoverable failures (fixture)');
    });

    it('upgrades the demo to an honest live profiled harness on an executable patch', () => {
        const registry = fixtureRegistry();
        const before = registry.find('demo')!;
        const scripted = before.create(SETTINGS, progress);

        const after = registry.update('demo', { agents: ['workspace'] });

        // The descriptor stops claiming the offline fixture: it now needs a
        // provider, advertises the shared toolbox the live factory registers, and
        // adopts the template's live prose because the shipped text was untouched.
        expect(after.template).toBe('live');
        expect(after.title).toBe('Live fixture');
        expect(after.description).toContain('no longer uses the offline script');
        expect(after.requiresEndpoint).toBe(true);
        expect(after.tools).toEqual(SHARED_TOOL_NAMES);
        expect(after.environmentTools).toEqual(['search', 'fetch']);
        expect(after.entry).toBe('workspace');
        expect(after.agents).toEqual(['workspace']);

        const live = after.create(SETTINGS, progress);
        expect(Object.keys(live.agents)).toEqual(['workspace']);
        expect(Object.keys(live.tools)).toEqual(
            expect.arrayContaining([...SHARED_TOOL_NAMES, 'toolRequest', 'toolCreate', 'tasks'])
        );
    });

    it('rebuilds flaky live on an executable patch and drops the example tool this build no longer ships', () => {
        const registry = fixtureRegistry();

        const after = registry.update('flaky', {
            agents: ['workspace'],
            agentModels: { workspace: 'big/model' }
        });

        // The template survives the patch — that is what keeps the entry on the
        // createToolboxHarness path rather than the plain profiled factory — but the
        // example-only tool it used to re-attach came from `src/server/tools/examples`,
        // which is deleted. The DECLARATION follows the FACTORY: a card may not advertise
        // a tool its next session cannot call, the same rule that rewrites requiresEndpoint
        // when a scripted entry goes live.
        expect(after.template).toBe('flaky');
        expect(after.tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(after.requiresEndpoint).toBe(true);
        expect(after.agents).toEqual(['workspace']);

        const live = after.create(SETTINGS, progress);
        expect(live.tools.testFlaky).toBeUndefined();
        expect(Object.keys(live.agents)).toEqual(['workspace']);
        expect(live.agents.workspace.model()).toBe('big/model');

        // A metadata-only patch is different: it keeps the captured factory, and the
        // injected fixture's factory really does register testFlaky. Pinned above.
    });
});

// Deleting a harness (T5).
//
// This is the contract the `DELETE /harnesses/:name` route is built on: any name is
// removable (a shipped built-in exactly like a user harness), an unknown or
// already-removed name is an honest 404 rather than a second success, and a built-in
// stays removed only because the registry records a TOMBSTONE the persistence layer
// can replay — `list()` alone cannot express "this shipped default is gone", because
// every registry seeds itself from ./presets.ts. Sessions are deliberately outside
// this contract: an existing session holds the preset it captured (pinned by
// ../sessions.test.ts) and a saved one rebuilds from its own record
// (../persistence.test.ts).
describe('deleting a harness', () => {
    it('removes a user harness without tombstoning it', () => {
        const registry = createHarnessRegistry();
        registry.create({ name: 'temp', agents: ['instruct'] });

        // The removed entry is returned by identity, so a caller can log or roll back
        // exactly what disappeared.
        const before = registry.find('temp')!;
        expect(registry.remove('temp')).toBe(before);
        expect(before.title).toBe('temp');

        expect(registry.find('temp')).toBeUndefined();
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);

        // No tombstone: a user harness is absent from the saved document as soon as
        // it is absent from list(), and nothing ships it back.
        expect(registry.deletedBuiltins()).toEqual([]);

        // The object a session captured is still a working harness after removal.
        expect(Object.keys(before.create(SETTINGS, progress).agents)).toEqual(['instruct']);
    });

    it('tombstones a deleted built-in and takes it out of every lookup', () => {
        const registry = createHarnessRegistry();
        const instruct = registry.find('instruct')!;

        expect(registry.remove('instruct')).toBe(instruct);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(registry.find('instruct')).toBeUndefined();

        // An alias follows its target: `writer` still NAMES instruct, and instruct is
        // gone, so the alias resolves to nothing rather than to a stale card.
        expect(registry.find('writer')).toBeUndefined();

        // The tombstone is the durable half of the deletion.
        expect(registry.deletedBuiltins()).toEqual(['instruct']);

        // Alias names stay reserved whether or not their target exists: accepting
        // `writer` as a new harness would make an old client's `writer` request mean
        // something different after this harness is deleted.
        expect(registryError(() => registry.create({ name: 'writer', agents: ['instruct'] }))).toEqual({
            status: 400,
            message: 'Harness name "writer" is reserved as an alias of "instruct".'
        });
    });

    it('reports an unknown, already-deleted, or alias-only name as 404', () => {
        const registry = createHarnessRegistry();

        // Never seen.
        expect(registryError(() => registry.remove('nope'))).toEqual({
            status: 404,
            message: 'Unknown harness "nope".'
        });

        // A repeat DELETE did not remove anything, so it must not claim success.
        expect(registry.remove('planner').name).toBe('planner');
        expect(registryError(() => registry.remove('planner'))).toEqual({
            status: 404,
            message: 'Harness "planner" has already been deleted.'
        });

        // An alias is a read redirect, not an identity that can be deleted: this must
        // not touch `instruct` (the same rule update() follows).
        expect(registryError(() => registry.remove('writer'))).toEqual({
            status: 404,
            message: 'Unknown harness "writer".'
        });
        expect(registry.find('instruct')?.title).toBe('Instruct');

        // A deleted built-in is no longer patchable either.
        expect(registryError(() => registry.update('planner', { title: 'Back?' }))).toEqual({
            status: 404,
            message: 'Unknown harness "planner".'
        });
    });

    it('lets a deleted built-in name be taken again and clears the tombstone', () => {
        const registry = createHarnessRegistry();
        registry.remove('instruct');

        // The name is free again: deleting the shipped card and creating your own
        // under the same id is the documented way to replace a default.
        const rebuilt = registry.create({ name: 'instruct', title: 'My instruct', agents: ['research'] });
        expect(rebuilt.builtin).toBe(false);

        // The tombstone is gone, or the next restore would delete the harness the
        // operator just made.
        expect(registry.deletedBuiltins()).toEqual([]);
        expect(registry.find('instruct')?.title).toBe('My instruct');

        // ...and the legacy alias resolves again, to the replacement.
        expect(registry.find('writer')?.title).toBe('My instruct');

        // A re-created name appends: it does not return to the shipped position,
        // because listing order is creation order for anything not shipped.
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat',
            'instruct'
        ]);
    });

    it('seeds tombstones at construction, including for a name this build does not ship', () => {
        const registry = createHarnessRegistry(presets, { deletedBuiltins: ['instruct', 'workspace'] });

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'research',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(registry.deletedBuiltins()).toEqual(['instruct', 'workspace']);
        expect(registry.find('writer')).toBeUndefined();

        // A tombstone naming something this build does not ship is KEPT: it records a
        // real decision, and a default that returns in a later build must come back
        // already deleted rather than resurrected.
        const unmatched = createHarnessRegistry(presets, { deletedBuiltins: ['retired-default'] });
        expect(unmatched.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(unmatched.deletedBuiltins()).toEqual(['retired-default']);
    });

    it('replays deletions idempotently and removes an entry the build still ships', () => {
        const registry = createHarnessRegistry(PRODUCTION_WITH_FIXTURES);

        // Startup replay: duplicates and blank names are noise, not errors, and a
        // name this build does not ship is still recorded.
        registry.restoreDeletedBuiltins(['demo', 'demo', '  ', 'retired-default']);

        expect(registry.find('demo')).toBeUndefined();
        expect(registry.deletedBuiltins()).toEqual(['demo', 'retired-default']);

        // Order-stable and idempotent: replaying the same list again changes nothing,
        // which is what makes a restart safe.
        registry.restoreDeletedBuiltins(['demo']);
        expect(registry.deletedBuiltins()).toEqual(['demo', 'retired-default']);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat',
            'flaky'
        ]);

        // A replayed deletion is indistinguishable from a live one to the caller.
        expect(registryError(() => registry.remove('demo'))).toEqual({
            status: 404,
            message: 'Harness "demo" has already been deleted.'
        });
    });

    it('snapshots and restores entries, listing order, and tombstones', () => {
        const registry = createHarnessRegistry();
        const captured = registry.snapshot();

        // Every mutation shape at once: create, patch, and delete.
        registry.create({ name: 'extra', agents: ['instruct'] });
        registry.update('research', { title: 'Renamed' });
        registry.remove('planner');

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'chat',
            'extra'
        ]);
        expect(registry.deletedBuiltins()).toEqual(['planner']);

        // The rollback the durable commit uses (SessionStore.mutateRegistry).
        registry.restore(captured);

        expect(registry.list().map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        // The restored row carries this build's shipped title: `research` is the id, and
        // Explore is what the roster pass renamed it to on the card.
        expect(registry.find('research')?.title).toBe('Explore');
        expect(registry.find('extra')).toBeUndefined();
        expect(registry.find('planner')).toBeDefined();
        expect(registry.deletedBuiltins()).toEqual([]);

        // A restored entry is the SAME preset object that was captured, so a session
        // holding it is unaffected by a rollback either way.
        expect(registry.find('instruct')).toBe(captured.entries.find(([name]) => name === 'instruct')![1]);
    });
});

// Per-agent model overrides (R9).
//
// The contract: a map of selected agent id → model id is validated against the
// FINAL member set, applied when the live harness is assembled, and captured by the
// preset's factory closure so an existing session keeps the models it was built
// with. Only model ids are client-supplied — never a provider or credential.
describe('per-agent model overrides', () => {
    it('applies an override to that agent only, falling back to the session model', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'mixed',
            agents: ['research', 'summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });

        expect(preset.agentModels).toEqual({ summarizer: 'small/fast' });

        const harness = preset.create(SETTINGS, progress);
        // The override applies to the summarizer; the entry agent keeps the session
        // model because the map omits it (not because it is special).
        expect(harness.agents.summarizer.model()).toBe('small/fast');
        expect(harness.agents.research.model()).toBe('test-model');
    });

    it('accepts an override for the entry agent and trims the id', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'trimmed',
            agents: ['instruct'],
            agentModels: { instruct: '  merge/ds4-flash  ' }
        });

        expect(preset.agentModels).toEqual({ instruct: 'merge/ds4-flash' });
        expect(preset.create(SETTINGS, progress).agents.instruct.model()).toBe('merge/ds4-flash');
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentModels: [] as never })
            )
        ).toEqual({ status: 400, message: '`agentModels` must be an object mapping agent ids to model ids.' });

        // A key that is not a final member: an override for an agent this harness
        // does not contain could never apply.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentModels: { summarizer: 'small/fast' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentModels` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, an over-long id, and control
        // characters are all rejected with the agent named.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentModels: { instruct: 7 as never } })
            )
        ).toEqual({ status: 400, message: '`agentModels.instruct` must be a model id string.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentModels: { instruct: '   ' } })
            )
        ).toEqual({ status: 400, message: '`agentModels.instruct` cannot be empty.' });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentModels: { instruct: 'a'.repeat(201) }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentModels.instruct` cannot exceed 200 characters.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentModels: { instruct: 'bad\nmodel' }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentModels.instruct` contains control characters.'
        });
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'mixed',
            agents: ['research', 'summarizer'],
            agentModels: { research: 'big/model', summarizer: 'small/fast' }
        });

        // A stated map replaces the previous one: only `summarizer` is overridden
        // now, so the entry agent goes back to the session model.
        const replaced = registry.update('mixed', { agentModels: { summarizer: 'tiny/model' } });
        expect(replaced.agentModels).toEqual({ summarizer: 'tiny/model' });
        expect(replaced.create(SETTINGS, progress).agents.research.model()).toBe('test-model');
        expect(replaced.create(SETTINGS, progress).agents.summarizer.model()).toBe('tiny/model');

        // Changing membership without restating the map drops the override for the
        // agent that is no longer selected; the survivor keeps its model.
        const narrowed = registry.update('mixed', { agents: ['research'] });
        expect(narrowed.agentModels).toEqual({});
        expect(narrowed.create(SETTINGS, progress).agents.research.model()).toBe('test-model');

        // An explicit empty map clears every override.
        const reseeded = registry.update('mixed', {
            agents: ['research', 'summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });
        expect(reseeded.agentModels).toEqual({ summarizer: 'small/fast' });
        expect(registry.update('mixed', { agentModels: {} }).agentModels).toEqual({});
    });

    it('rejects an explicitly unknown key even when the same patch changes membership', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'mixed',
            agents: ['research', 'summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });

        // `summarizer` is dropped by this patch, and the stated map still names
        // it: a stated key is explicit input, so it is a 400 rather than silently
        // discarded.
        expect(
            registryError(() => registry.update('mixed', { agents: ['research'], agentModels: { summarizer: 'x' } }))
        ).toEqual({
            status: 400,
            message:
                '`agentModels` names "summarizer", which is not a member of this harness. Members: research.'
        });
    });

    it('leaves the captured factory and descriptor of an old preset untouched', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'mixed',
            agents: ['research', 'summarizer'],
            agentModels: { summarizer: 'small/fast' }
        });
        const oldHarness = before.create(SETTINGS, progress);

        registry.update('mixed', { agentModels: { summarizer: 'other/model' } });

        // The old preset object and its closure are not mutated: a session built
        // from `before` keeps the model it was created with.
        expect(before.agentModels).toEqual({ summarizer: 'small/fast' });
        expect(oldHarness.agents.summarizer.model()).toBe('small/fast');
        expect(before.create(SETTINGS, progress).agents.summarizer.model()).toBe('small/fast');

        const after = registry.find('mixed')!;
        expect(after.agentModels).toEqual({ summarizer: 'other/model' });
        expect(after.create(SETTINGS, progress).agents.summarizer.model()).toBe('other/model');
    });

    it('describes the override map only when it is non-empty', () => {
        const registry = createHarnessRegistry();

        const bare = registry.create({ name: 'bare', agents: ['instruct'] });
        expect(describeHarness(bare).agentModels).toBeUndefined();

        const mapped = registry.create({
            name: 'mapped',
            agents: ['instruct'],
            agentModels: { instruct: 'big/model' }
        });
        // The descriptor carries the OVERRIDE map, not a resolved model per agent:
        // a UI shows "default" for the agents it omits.
        expect(describeHarness(mapped).agentModels).toEqual({ instruct: 'big/model' });
    });
});

// T3 editable configuration — the harness-scoped sibling of `agentModels`. These
// tests are deliberately the same SHAPE as the block above: an instruction override
// is validated, stored, projected and executed by the same machinery, and the only
// intended differences are the value rules (prose bounds instead of id bounds) and
// the fact that the trusted profile stays untouched.
//
// WHY EVERY ASSERTION BELOW EXPECTS A ONE-ENTRY `instructions` ARRAY
// ------------------------------------------------------------------
// `agentInstruction()` (src/agents/index.ts) returns ONE string: for a profile that
// is NOT overridden, the identity paragraph, a BLANK line, then `Guidelines:` with
// one `- ` bullet per guideline in profile order; for an OVERRIDDEN member (T6), the
// stored text verbatim and nothing else. `agent({ instruction })` seeds one `system`
// message per array entry (src/core/agent.ts `normalizeInstructions`), so the old
// two-entry value put TWO system messages at the head of every transcript — and
// several OpenAI-compatible gateways accept only ONE system turn (or keep just the
// first/last), silently dropping the guidelines. A profile-built agent therefore seeds
// exactly ONE system message, which is what the whole-array
// `toEqual([<the one prompt>])` assertions below pin from the harness side: one entry,
// exact text, nothing appended after it.
describe('per-agent instruction overrides', () => {
    // The summarizer's own shipped text, so the assertions below name the exact
    // words an agent is seeded with rather than re-deriving them from the helper.
    // Hand-derived from src/agents/summarizer.ts: identity sentence + its two
    // guideline bullets, joined by the one blank line the rule requires.
    const TRUSTED_SUMMARIZER_INSTRUCTION = 'You compress technical notes into at most two sentences.';
    const TRUSTED_GUIDELINES =
        'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.';

    // The complete one-message prompt for the un-overridden summarizer.
    const TRUSTED_SUMMARIZER_PROMPT = `${TRUSTED_SUMMARIZER_INSTRUCTION}\n\n${TRUSTED_GUIDELINES}`;

    // T6: an override IS the agent's complete prompt, so an overridden summarizer runs
    // the stored sentence verbatim — the trusted policy block above belongs to the
    // UN-overridden default and is never appended underneath operator text. The helper
    // stays as the one place that names this distinction at every call site.
    const summarizerPrompt = (instruction: string) => instruction;

    // The trusted guideline block of a long shared-policy role, rendered exactly as
    // src/agents/index.ts renders it (header plus one `- ` bullet per entry, in
    // declared order). Built from the shipped profile data instead of duplicating
    // ~1.3kB of shared policy prose in this file; `readonly` because
    // `AgentProfile.guidelines` is a readonly tuple. Used below to prove an override's
    // prompt contains NONE of it (the duplication the full-prompt editor removed).
    const guidelinesBlock = (guidelines: readonly string[]) =>
        `Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;

    it('applies an override to that agent only, verbatim, as its whole prompt', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced',
            agents: ['research', 'summarizer'],
            agentInstructions: { summarizer: 'Condense to one line.' }
        });

        expect(preset.agentInstructions).toEqual({ summarizer: 'Condense to one line.' });

        const harness = preset.create(SETTINGS, progress);

        // The override is the entire system message: the operator's sentence, with the
        // profile's trusted bullets NOT appended (the box that produced this text already
        // holds them, so appending duplicated them). The whole prompt is ONE array entry,
        // because a prompt is seeded as one `system` message — two entries would be two
        // turns, and a gateway that accepts one system turn would keep only the first.
        expect(harness.agents.summarizer.instructions).toEqual([
            summarizerPrompt('Condense to one line.')
        ]);

        // A member the map omits runs the trusted profile exactly as before: one
        // entry holding its composed prompt, read from the catalogue itself so the
        // wording of a shared-policy role cannot drift into this file.
        expect(harness.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
    });

    it('never mutates the trusted profile it overrides', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced',
            agents: ['summarizer'],
            agentInstructions: { summarizer: 'Rewrite it as a haiku.' }
        });

        expect(preset.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('Rewrite it as a haiku.')
        ]);

        // The catalogue is still the shipped text: the override lives on the harness
        // entry, and a second harness built from the same profile is unaffected.
        expect(AGENT_PROFILES.summarizer.instruction).toBe(TRUSTED_SUMMARIZER_INSTRUCTION);
        expect(
            registry.create({ name: 'plain', agents: ['summarizer'] }).create(SETTINGS, progress)
                .agents.summarizer.instructions
        ).toEqual([TRUSTED_SUMMARIZER_PROMPT]);
    });

    it('accepts multi-line prose and trims the stored text', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'multiline',
            agents: ['instruct'],
            agentInstructions: { instruct: '  Lead with the answer.\n\nThen show the evidence.  ' }
        });

        expect(preset.agentInstructions).toEqual({
            instruct: 'Lead with the answer.\n\nThen show the evidence.'
        });

        const harness = preset.create(SETTINGS, progress);
        // The trimmed prose is the ENTIRE system message. Blank lines inside the override
        // are legal and are preserved verbatim; they no longer "push the guidelines out"
        // because nothing is appended after the operator's text (T6).
        expect(harness.agents.instruct.instructions).toEqual([
            'Lead with the answer.\n\nThen show the evidence.'
        ]);

        // The duplication guard: the profile's trusted block is absent, not appended a
        // second time below text that already stands on its own.
        expect(harness.agents.instruct.instructions[0]).not.toContain(
            guidelinesBlock(AGENT_PROFILES.instruct.guidelines)
        );
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentInstructions: [] as never })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions` must be an object mapping agent ids to instruction text.'
        });

        // A key that is not a final member: an override for an agent this harness
        // does not contain could never apply.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentInstructions: { summarizer: 'Condense.' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentInstructions` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, an over-long body, and a control
        // character are all rejected with the agent named.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentInstructions: { instruct: 7 as never }
                })
            )
        ).toEqual({ status: 400, message: '`agentInstructions.instruct` must be an instruction string.' });

        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentInstructions: { instruct: '   ' } })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentInstructions.instruct` cannot be empty. Omit the key to run the trusted instruction.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentInstructions: { instruct: 'a'.repeat(8_001) }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions.instruct` cannot exceed 8000 characters.'
        });

        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentInstructions: { instruct: 'null\u0000byte' }
                })
            )
        ).toEqual({
            status: 400,
            message: '`agentInstructions.instruct` contains control characters.'
        });
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'voiced',
            agents: ['research', 'summarizer'],
            agentInstructions: { research: 'Ask before acting.', summarizer: 'Two lines max.' }
        });

        // A stated map REPLACES: the entry agent is back on its trusted composed prompt.
        const replaced = registry.update('voiced', { agentInstructions: { summarizer: 'One line.' } });
        expect(replaced.agentInstructions).toEqual({ summarizer: 'One line.' });

        const rebuilt = replaced.create(SETTINGS, progress);
        // Both sides of the swap are one-message prompts: the dropped member is back on
        // its trusted composed prompt, the kept member on its override verbatim (which,
        // per T6, is the whole prompt).
        expect(rebuilt.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
        expect(rebuilt.agents.summarizer.instructions).toEqual([summarizerPrompt('One line.')]);

        // Narrowing the team drops the override of the agent that left, so a later
        // re-add cannot silently resurrect an old prompt. `summarizer`'s entry is the
        // only one standing, so the map ends up empty.
        const narrowed = registry.update('voiced', { agents: ['research'] });
        expect(narrowed.agentInstructions).toEqual({});

        // An explicit empty map clears every override.
        registry.update('voiced', {
            agents: ['research', 'summarizer'],
            agentInstructions: { summarizer: 'One line.' }
        });
        expect(registry.update('voiced', { agentInstructions: {} }).agentInstructions).toEqual({});
        expect(
            registry.find('voiced')!.create(SETTINGS, progress).agents.summarizer.instructions
        ).toEqual([TRUSTED_SUMMARIZER_PROMPT]);
    });

    it('treats an instruction edit as executable and keeps a captured factory frozen', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'voiced',
            agents: ['research', 'summarizer'],
            agentInstructions: { summarizer: 'Two lines max.' }
        });
        const oldHarness = before.create(SETTINGS, progress);

        const after = registry.update('voiced', { agentInstructions: { summarizer: 'One line.' } });

        // A NEW preset object with a NEW closure: a session built from `before` keeps
        // the words its agents were created with (the frozen-session guarantee).
        expect(oldHarness.agents.summarizer.instructions).toEqual([
            summarizerPrompt('Two lines max.')
        ]);
        expect(before.agentInstructions).toEqual({ summarizer: 'Two lines max.' });
        expect(before.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('Two lines max.')
        ]);
        expect(after.agentInstructions).toEqual({ summarizer: 'One line.' });
        expect(after.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('One line.')
        ]);
    });

    it('upgrades the scripted demo on an instruction edit, exactly like a model edit', () => {
        const registry = fixtureRegistry();

        // The fixture's factory is the offline script, which ignores prompts. An
        // instruction edit is executable, so it must not be stored against a factory
        // that would silently ignore it: the entry becomes a live profiled harness. The
        // member is the real `general` role — the fixture PRESET is named `demo`, but no
        // `demo` agent profile ships any more.
        const patched = registry.update('demo', { agentInstructions: { general: 'Be brief.' } });

        expect(patched.template).toBe('live');
        expect(patched.requiresEndpoint).toBe(true);
        expect(patched.agentInstructions).toEqual({ general: 'Be brief.' });
    });

    it('describes the override map only when it is non-empty', () => {
        const registry = createHarnessRegistry();

        expect(describeHarness(registry.create({ name: 'bare2', agents: ['instruct'] })).agentInstructions).toBeUndefined();

        const mapped = registry.create({
            name: 'voiced2',
            agents: ['instruct'],
            agentInstructions: { instruct: 'Lead with the answer.' }
        });
        // The OVERRIDE map, not the catalogue: a member listed here runs exactly this text,
        // and a member the map omits runs the trusted `GET /agents` prompt the UI composes
        // from `instruction` plus `guidelines` (T6).
        expect(describeHarness(mapped).agentInstructions).toEqual({ instruct: 'Lead with the answer.' });
    });

    it('round-trips through a durable record and stays a customisation', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'voiced3',
            agents: ['research', 'summarizer'],
            agentInstructions: { summarizer: 'One line.' }
        });

        // A record carries the map, so a restart rebuilds the same prompts.
        const record = presetToRecord(preset);
        expect(record.agentInstructions).toEqual({ summarizer: 'One line.' });

        const restored = presetFromRecord(record);
        expect(restored.agentInstructions).toEqual({ summarizer: 'One line.' });
        // The rebuilt preset seeds the same single system message the live preset did,
        // so persistence does not reintroduce a split prompt.
        expect(restored.create(SETTINGS, progress).agents.summarizer.instructions).toEqual([
            summarizerPrompt('One line.')
        ]);

        // Equality ignores insertion order but not the override itself, and a stored
        // override proves the row was customised: the shipped-default refresh must
        // never overwrite it. The record's team already matches the legacy research
        // definition, so `agentInstructions` is the only variable under test.
        expect(presetRecordEquals(record, presetToRecord(restored))).toBe(true);

        // `record` comes from THIS build's registry, whose environmentTools default
        // is now ['search', 'fetch'] (R9-R11). The legacy table records what the OLD
        // shipped row said, and isLegacyShippedDefinition compares that field, so the
        // fixture pins it to the legacy value: `agentInstructions` is the only
        // variable under test. A real old row still carries ['search'] and refreshes.
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
            ...asShippedRow,
            agentInstructions: { summarizer: 'One line.' }
        })).toBe(false);

        expect(isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
            ...asShippedRow,
            agentInstructions: {}
        })).toBe(true);
    });
});

// One tiny guard: the registry accepts an injected catalogue (tests inject
// scripted presets) and must not fall back to the shipped list for lookup.
describe('an injected registry', () => {
    const scripted: HarnessPreset = {
        name: 'scripted',
        title: 'Scripted',
        description: 'A scripted fixture.',
        requiresEndpoint: false,
        // ROUTING and AUTHORITY are separate fields on a preset card now, and an injected card
        // states both: the scripted agent receives the turn, and a one-agent roster holds one
        // rank. The fixture's agent id is NOT a catalogue profile, which is why the card carries
        // it as data rather than resolving it from `agents()`.
        entry: 'scripted',
        ranks: { scripted: 'A' },
        agents: ['scripted'],
        tools: [],
        builtin: true,
        editable: true,
        create: () => {
            throw new Error('the registry must not construct on create()/update()');
        }
    };

    it('keeps its own entries and still offers the trusted agents', () => {
        const registry = createHarnessRegistry([scripted]);

        // R20.1: the entry is an independent copy, not the injected object.
        expect(registry.list()).toEqual([scripted]);
        expect(registry.find('scripted')).not.toBe(scripted);
        expect(registry.find('scripted')).toEqual(scripted);
        expect(registry.find('instruct')).toBeUndefined();
        // The trusted roster is independent of the injected catalogue: the same eight ids,
        // in `AGENT_PROFILE_NAMES` order (src/agents/index.ts). Note that the injected
        // preset's own agent id (`scripted`) is NOT among them — an agent key a harness
        // invents is not a catalogue profile, which is exactly why the deleted `demo`
        // fixture builds its scripted agent inline instead of shipping a profile.
        expect(registry.agents().map((profile) => profile.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'summarizer'
        ]);

        // Creating into an injected registry is still validated and works.
        const created = registry.create({ name: 'fresh', agents: ['instruct'] });
        expect(registry.list().map((entry) => entry.name)).toEqual(['scripted', 'fresh']);
        expect(created.create).not.toBe(scripted.create);
    });
});

// Per-agent identity colors (R2) — the display-only sibling of `agentModels` and
// `agentInstructions`.
//
// The contract, deliberately the same shape as the two maps above:
//   - a map of selected agent id → CSS hex color is validated against the FINAL member
//     set (an entry for an unselected agent could never be painted, so it is a 400 that
//     names the agent rather than a stored no-op);
//   - a stated map on PATCH REPLACES the stored one, `{}` clears every color, and a key
//     for a member the same patch removed is dropped;
//   - the map is captured by the factory closure, so an existing session keeps the
//     swatches its agents were built with while the next session gets the new ones;
//   - `describeHarness` emits it only when non-empty, and the durable record reads and
//     replays it exactly like `agentModels`;
//   - and the thing that makes it DIFFERENT from the other two: nothing it touches
//     changes what an agent runs, which the instruction/model assertions below pin.
describe('per-agent identity colors', () => {
    // One table, three layers. The library pattern (src/core/agent.ts
    // `AGENT_COLOR_PATTERN`), the registry pattern (registry.ts, same file) and the HTTP
    // contract (`harness.swagger.yaml` `agent_colors.pattern`) must agree on exactly this
    // set, or a stored color could be one a UI cannot paint.
    const HEX_ACCEPTED = ['#abc', '#abcd', '#aabbcc', '#aabbccdd', '#ABC', '#4ADE80'];
    const HEX_REJECTED = [
        'red',
        'rgb(74, 222, 128)',
        '#',
        '#ab',
        '#abcde',
        '#aabbccdde',
        'aabbcc',
        '#gggggg',
        '#ff_000',
        '',
        '   '
    ];

    // The registry's refusal for one value: blank text and a malformed shape are stated
    // differently on purpose (clearing is omitting the key, never storing an empty value).
    const registryRefusal = (color: string): string =>
        color.trim().length === 0
            ? '`agentColors.instruct` cannot be empty. Omit the key to leave this agent uncolored.'
            : `\`agentColors.instruct\` must be a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa). Received ${JSON.stringify(color)}.`;

    it('colors that agent only, leaves the rest uncolored, and changes nothing about the prompt', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'painted',
            agents: ['research', 'summarizer'],
            agentColors: { summarizer: '#4ade80' }
        });

        expect(preset.agentColors).toEqual({ summarizer: '#4ade80' });

        const harness = preset.create(SETTINGS, progress);
        // The colored member carries its swatch on the AGENT (R1: stable identity
        // metadata, not only on the card), and the member the map omits carries NO key.
        expect(harness.agents.summarizer.color).toBe('#4ade80');
        expect(Object.hasOwn(harness.agents.research, 'color')).toBe(false);

        // Display-only, proven: the same team with no colors at all runs byte-identical
        // prompts and the same models. A color is not a prompt override.
        const bare = registry.create({
            name: 'unpainted',
            agents: ['research', 'summarizer'],
        }).create(SETTINGS, progress);

        expect(harness.agents.summarizer.instructions).toEqual(bare.agents.summarizer.instructions);
        expect(harness.agents.summarizer.model()).toBe(bare.agents.summarizer.model());
        expect(harness.agents.research.model()).toBe('test-model');
    });

    it('accepts an override for the entry agent and trims the value', () => {
        const registry = createHarnessRegistry();
        const preset = registry.create({
            name: 'trimmed',
            agents: ['instruct'],
            agentColors: { instruct: '  #4ADE80  ' }
        });

        expect(preset.agentColors).toEqual({ instruct: '#4ADE80' });
        // The stored casing survives all the way to the agent the next session builds.
        expect(preset.create(SETTINGS, progress).agents.instruct.color).toBe('#4ADE80');
    });

    it('validates the map shape, its keys, and its values', () => {
        const registry = createHarnessRegistry();

        // Not a plain object.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentColors: [] as never })
            )
        ).toEqual({
            status: 400,
            message: '`agentColors` must be an object mapping agent ids to CSS hex colors.'
        });

        // A key that is not a final member: a swatch for an agent this harness does not
        // contain could never be painted.
        expect(
            registryError(() =>
                registry.create({
                    name: 'x',
                    agents: ['instruct'],
                    agentColors: { summarizer: '#4ade80' }
                })
            )
        ).toEqual({
            status: 400,
            message:
                '`agentColors` names "summarizer", which is not a member of this harness. Members: instruct.'
        });

        // Values: a non-string, a blank string, and every malformed hex shape are 400s
        // naming the agent, so the UI can point at the offending swatch.
        expect(
            registryError(() =>
                registry.create({ name: 'x', agents: ['instruct'], agentColors: { instruct: 7 as never } })
            )
        ).toEqual({
            status: 400,
            message: '`agentColors.instruct` must be a CSS hex color string.'
        });

        for (const color of HEX_REJECTED) {
            expect(
                registryError(() =>
                    registry.create({ name: 'x', agents: ['instruct'], agentColors: { instruct: color } })
                )
            ).toEqual({ status: 400, message: registryRefusal(color) });
        }
    });

    it('accepts and rejects the same hex set as agent() construction', () => {
        const registry = createHarnessRegistry();
        const provider = { baseURL: 'http://provider.test/v1' };

        expect(
            HEX_ACCEPTED.map((color) => [
                // Registry edge: stored verbatim (trimmed), and reported back.
                registry.create({
                    name: `both-ok-${HEX_ACCEPTED.indexOf(color)}`,
                    agents: ['instruct'],
                    agentColors: { instruct: color }
                }).agentColors,
                // Library edge: the same value reaches the agent.
                agent({ name: 'writer', model: 'm', provider, color }).color
            ])
        ).toEqual(HEX_ACCEPTED.map((color) => [{ instruct: color }, color]));

        // Every value the registry refuses with a 400 is also a construction error in the
        // library, so a document written by an older server can never hold a color the
        // runtime would reject.
        for (const color of HEX_REJECTED) {
            expect(() => agent({ name: 'writer', model: 'm', provider, color })).toThrow(
                `Agent "writer" has an invalid \`color\`: ${JSON.stringify(color)}.`
            );
        }
    });

    it('replaces the map on update, drops removed members, and clears on {}', () => {
        const registry = createHarnessRegistry();
        registry.create({
            name: 'painted',
            agents: ['research', 'summarizer'],
            agentColors: { research: '#4ade80', summarizer: '#f97316' }
        });

        // A stated map REPLACES: the member it omits is uncolored again.
        const replaced = registry.update('painted', { agentColors: { summarizer: '#22d3ee' } });
        expect(replaced.agentColors).toEqual({ summarizer: '#22d3ee' });

        const rebuilt = replaced.create(SETTINGS, progress);
        expect(rebuilt.agents.summarizer.color).toBe('#22d3ee');
        expect(Object.hasOwn(rebuilt.agents.research, 'color')).toBe(false);

        // Narrowing the team drops the swatch of the agent that left, so a later re-add
        // cannot silently resurrect an old color.
        const narrowed = registry.update('painted', { agents: ['research'] });
        expect(narrowed.agentColors).toEqual({});

        // An explicit empty map clears every color, and the rebuilt agents carry none.
        registry.update('painted', {
            agents: ['research', 'summarizer'],
            agentColors: { summarizer: '#22d3ee' }
        });
        expect(registry.update('painted', { agentColors: {} }).agentColors).toEqual({});
        expect(
            Object.hasOwn(registry.find('painted')!.create(SETTINGS, progress).agents.summarizer, 'color')
        ).toBe(false);
    });

    it('treats a color edit as executable and keeps a captured factory frozen', () => {
        const registry = createHarnessRegistry();
        const before = registry.create({
            name: 'painted',
            agents: ['research', 'summarizer'],
            agentColors: { summarizer: '#4ade80' }
        });

        // An existing session holds THIS preset object; recoloring the registry entry
        // produces a NEW one, so the frozen copy still builds the old swatch.
        registry.update('painted', { agentColors: { summarizer: '#f97316' } });

        const after = registry.find('painted')!;
        expect(after).not.toBe(before);
        expect(before.agentColors).toEqual({ summarizer: '#4ade80' });
        expect(after.agentColors).toEqual({ summarizer: '#f97316' });
        expect(before.create(SETTINGS, progress).agents.summarizer.color).toBe('#4ade80');
        expect(after.create(SETTINGS, progress).agents.summarizer.color).toBe('#f97316');

        // A color patch is EXECUTABLE: it rebuilds the factory, so the next session's
        // agents carry it. A metadata-only patch (title alone) keeps the captured closure.
        const metadataOnly = registry.update('painted', { title: 'Renamed' });
        expect(metadataOnly.create).toBe(after.create);
        expect(metadataOnly.agentColors).toEqual({ summarizer: '#f97316' });
    });

    it('upgrades a scripted template the same way an instruction edit does', () => {
        const registry = fixtureRegistry();

        // The rule is the T3 instruction rule, restated for colors: a patch that changes
        // what the factory captures cannot keep the offline script.
        //
        // The patch also re-targets the primary, and it has to. Going live replaces the
        // scripted agent with one built from the TRUSTED profiles, and the fixture's own
        // id (`demo`) is no longer a profile — it was deleted with the preset. An injected
        // scripted entry whose primary is not a catalogue profile can therefore only go
        // live by naming one.
        const recolored = registry.update('demo', {
            agents: ['instruct'],
            agentColors: { instruct: '#4ade80' }
        });

        expect(recolored.template).toBe('live');
        expect(recolored.requiresEndpoint).toBe(true);
        expect(recolored.tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(recolored.create(SETTINGS, progress).agents.instruct.color).toBe('#4ade80');
    });

    it('projects the map onto the descriptor only when the harness colors something', () => {
        const registry = createHarnessRegistry();

        // An untouched built-in carries no key at all, so every existing card keeps its
        // exact pre-R2 shape.
        expect(describeHarness(registry.find('instruct')!).agentColors).toBeUndefined();

        const colored = registry.create({
            name: 'carded',
            agents: ['instruct'],
            agentColors: { instruct: '#4ade80' }
        });
        expect(describeHarness(colored).agentColors).toEqual({ instruct: '#4ade80' });

        // Clearing every color removes the field from the card again.
        expect(
            describeHarness(registry.update('carded', { agentColors: {} })).agentColors
        ).toBeUndefined();

        // The descriptor copy is not the preset's own object: a caller holding a card
        // cannot repaint the registry entry through it.
        const card = describeHarness(colored);
        card.agentColors!.instruct = '#000000';
        expect(colored.agentColors).toEqual({ instruct: '#4ade80' });
    });

    it('round-trips through a durable record and replays it on restore', () => {
        const registry = createHarnessRegistry();
        const created = registry.create({
            name: 'saved',
            agents: ['research', 'summarizer'],
            agentColors: { research: '#4ade80', summarizer: '#f97316' }
        });

        const record = presetToRecord(created);
        expect(record.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });

        // Rebuilding a preset from the record reproduces both the metadata and the
        // colored agents, and the record of the rebuilt entry compares equal — which is
        // what lets a restore skip an unmodified row.
        const rebuilt = presetFromRecord(record);
        expect(rebuilt.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });
        expect(rebuilt.create(SETTINGS, progress).agents.research.color).toBe('#4ade80');
        expect(presetRecordEquals(presetToRecord(rebuilt), record)).toBe(true);

        // A harness with no colors writes NO field, so a document saved before R2 keeps
        // its exact old byte shape (and a record without the field stays equal to itself).
        const bare = presetToRecord(registry.create({ name: 'bare', agents: ['research'] }));
        expect(Object.hasOwn(bare, 'agentColors')).toBe(false);
        expect(presetRecordEquals(bare, bare)).toBe(true);
        expect(presetFromRecord({ ...bare, agentColors: undefined }).agentColors).toBeUndefined();

        // Restore replays the row through `update()`, so the colors reach the rebuilt
        // factory rather than being dropped as prose.
        const replay = createHarnessRegistry();
        restoreHarnessRegistry(replay, [record]);
        expect(replay.find('saved')!.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });
        expect(replay.find('saved')!.create(SETTINGS, progress).agents.summarizer.color).toBe('#f97316');
    });

    it('counts a saved color as a customisation of a built-in', () => {
        // The shipped-default refresh replays PROSE only, so a row that carries a color
        // must not be treated as an unmodified shipped default — the operator's swatch
        // would otherwise vanish on the next restart.
        const registry = createHarnessRegistry();
        const record = presetToRecord(
            registry.create({ name: 'colored', agents: ['research', 'summarizer'] })
        );

        // Same shape adjustment the instruction test above makes: the record is from THIS
        // build, so `environmentTools` is pinned to the legacy row's value and the color
        // map is the only variable under test.
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                agentColors: {}
            })
        ).toBe(true);

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                agentColors: { research: '#4ade80' }
            })
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R7: SESSION-DEFINED agents in the durable preset record.
//
// A harness DEFINITION never declares a custom agent — `HarnessRegistration`/`HarnessPatch` have
// no field for it — so the only writer of `customAgents` is a session's own frozen preset copy
// (./sessions.ts `applyBindingMaps`). The pieces a restore routes through must therefore hold
// here:
//   - `presetToRecord` writes the field ONLY when the map has an entry, so every document saved
//     before R7 (and every harness definition) keeps its exact old byte shape, and
//     `presetRecordEquals` does not treat an absent map as different from an empty one;
//   - `presetFromRecord` hands the map to the factory, so the rebuilt harness really CREATES the
//     invented brain (`agentsFromProfiles` → `agentConfigurationForCustom`: the stored base
//     verbatim, no profile lookup, no guidelines) while the catalogue members beside it keep
//     their trusted composed prompts;
//   - a saved custom roster is a CUSTOMISATION of a built-in row (the shipped-default refresh
//     replays prose only, so it must not silently drop the member), and an injected factory that
//     cannot build the invented member is REFUSED rather than restored with the agent missing.
// ---------------------------------------------------------------------------
describe('session-defined agents in the durable preset record (R7)', () => {
    const CUSTOM = 'localizer';
    const CUSTOM_BASE = 'You rewrite copy for the target market.';

    it('round-trips the custom agent map and rebuilds the invented agent from it', () => {
        const registry = createHarnessRegistry();
        const created = registry.create({
            name: 'owned',
            agents: ['research', 'summarizer'],
        });

        // The shape a SESSION writes: the invented name joins `agents`, its rank joins the
        // COMPLETE rank map (a durable record's map keys EVERY member, invented ones included —
        // ../persistence.ts refuses one that does not), its model joins `agentModels`, and its
        // base text joins the new `customAgents` map.
        const withCustom: HarnessPreset = {
            ...created,
            ranks: { ...created.ranks, [CUSTOM]: 'B' },
            agents: [...created.agents, CUSTOM],
            agentModels: { ...created.agentModels, [CUSTOM]: 'small/fast' },
            agentColors: { ...created.agentColors, [CUSTOM]: '#22d3ee' },
            customAgents: { [CUSTOM]: CUSTOM_BASE }
        };

        const record = presetToRecord(withCustom);

        expect(record.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(record.agentModels).toEqual({ [CUSTOM]: 'small/fast' });
        expect(record.agents).toEqual(['research', 'summarizer', CUSTOM]);
        // The map round-trips in SORTED KEY ORDER (the rank map is the one field whose key order
        // carries no meaning, so `presetRecordEquals` must not read an insertion-order change as
        // an executable difference).
        expect(record.ranks).toEqual({ research: 'A', summarizer: 'B', [CUSTOM]: 'B' });
        expect(Object.keys(record.ranks)).toEqual([CUSTOM, 'research', 'summarizer']);

        const rebuilt = presetFromRecord(record);

        expect(rebuilt.customAgents).toEqual({ [CUSTOM]: CUSTOM_BASE });
        expect(rebuilt.agents).toEqual(['research', 'summarizer', CUSTOM]);
        expect(rebuilt.entry).toBe('research');
        expect(rebuilt.ranks).toEqual({ research: 'A', summarizer: 'B', [CUSTOM]: 'B' });

        const harness = rebuilt.create(SETTINGS, progress);

        // All three members exist, including the one no profile describes.
        expect(Object.keys(harness.agents).sort()).toEqual(
            ['research', 'summarizer', CUSTOM].sort()
        );
        // The invented brain is RANKED like any other member: no profile means no privilege, and
        // no penalty either — it sits where the record put it.
        expect(harness.ranks).toEqual({ research: 'A', summarizer: 'B', [CUSTOM]: 'B' });
        // THE point: the invented brain is built from its own stored text VERBATIM (no guideline
        // block, because there is no trusted profile to supply one) on its own model, and the
        // R2 swatch travels with it exactly like a catalogue member's.
        expect(harness.agents[CUSTOM].instructions).toEqual([CUSTOM_BASE]);
        expect(harness.agents[CUSTOM].model()).toBe('small/fast');
        expect(harness.agents[CUSTOM].color).toBe('#22d3ee');
        // A catalogue member beside it is untouched by the new branch: still the trusted prompt.
        expect(harness.agents.research.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.research)
        ]);
        expect(harness.agents.summarizer.instructions).toEqual([
            agentInstruction(AGENT_PROFILES.summarizer)
        ]);

        // The record of the rebuilt entry compares equal, which is what lets a restore skip an
        // unmodified row (`./sessions.ts` `restoreSession` uses the same comparison to decide
        // whether the frozen record or the live registry entry builds the harness).
        expect(presetRecordEquals(presetToRecord(rebuilt), record)).toBe(true);
    });

    it('writes no field without custom agents and keeps a pre-R7 record equal', () => {
        const registry = createHarnessRegistry();
        const bare = presetToRecord(registry.create({ name: 'plain', agents: ['research'] }));

        // Absent, not `{}`: a document saved before R7 (or a harness definition) keeps its exact
        // old byte shape, so a later reader cannot invent a roster member.
        expect(Object.hasOwn(bare, 'customAgents')).toBe(false);
        expect(presetRecordEquals(bare, bare)).toBe(true);
        expect(presetFromRecord({ ...bare, customAgents: undefined }).customAgents).toBeUndefined();
        expect(
            Object.keys(presetFromRecord(bare).create(SETTINGS, progress).agents)
        ).toEqual(['research']);

        // Absent and empty are the same statement, so they compare equal to each other...
        expect(presetRecordEquals(bare, { ...bare, customAgents: {} })).toBe(true);

        // ...while a record that names an invented agent is a DIFFERENT roster. This is the
        // comparison that routes a saved session with custom agents through `presetFromRecord`
        // instead of the unchanged registry entry.
        expect(presetRecordEquals(bare, { ...bare, customAgents: { [CUSTOM]: CUSTOM_BASE } })).toBe(
            false
        );
    });

    it('counts a saved custom agent as a customisation of a built-in', () => {
        // The shipped-default refresh replays PROSE only, so a row carrying a custom roster must
        // not be mistaken for an unmodified shipped default — the invented member would vanish on
        // the next restart while its sessions still name it.
        const registry = createHarnessRegistry();
        const record = presetToRecord(
            registry.create({ name: 'invented', agents: ['research', 'summarizer'] })
        );
        const asShippedRow = {
            ...record,
            name: 'research',
            environmentTools: [...(LEGACY_PRESET_DEFINITIONS.research.environmentTools ?? [])]
        };

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                customAgents: {}
            })
        ).toBe(true);

        expect(
            isLegacyShippedDefinition(LEGACY_PRESET_DEFINITIONS.research, {
                ...asShippedRow,
                customAgents: { [CUSTOM]: CUSTOM_BASE }
            })
        ).toBe(false);
    });

    it('refuses an injected factory that cannot build the saved custom agent', () => {
        // An injected preset (no `template`) rebuilds only from a factory the caller hands back,
        // so a saved roster naming an agent that factory has no way to create is an ERROR, not a
        // session that silently loses a member. (`assertDurableRoster` in ./api.ts is why a real
        // session never gets here: a template-less binding is refused with 409 up front.)
        const injected: HarnessPreset = {
            name: 'injected',
            title: 'Injected',
            description: 'A host-supplied factory with no template hint.',
            requiresEndpoint: false,
            // A card states routing and authority even when its factory is opaque: a record
            // written from this preset must carry a complete rank map, or the restore cannot
            // rebuild the team it froze.
            entry: 'instruct',
            ranks: { instruct: 'A' },
            agents: ['instruct'],
            tools: [],
            builtin: false,
            editable: true,
            create: () => {
                throw new Error('never built in this case');
            }
        };

        const record = presetToRecord(injected);

        expect(presetFromRecord(record, injected).name).toBe('injected');

        expect(() =>
            presetFromRecord({ ...record, customAgents: { [CUSTOM]: CUSTOM_BASE } }, injected)
        ).toThrow('changed incompatibly');
    });
});
