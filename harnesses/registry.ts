// The in-memory harness registry.
//
// WHY THIS EXISTS
// ---------------
// The catalogue used to be a frozen array of presets: the only harnesses a client
// could run were the ones shipped with the package. The latest design lets a
// client create a harness (choose a primary agent, optionally some subagents) and
// let an operator override a built-in's title/description/agent routing. Both are
// in-memory only: there is no persistence layer, so a restart returns to the
// shipped catalogue. That limitation is documented in README.md/knowledge.md.
//
// INVARIANTS
// ----------
//   - exactly one primary; `agents` is derived as [primary, ...subagents];
//   - a subagent is never the primary, never duplicated, and must be a known
//     TRUSTED agent id (src/agents);
//   - names are unique (case-insensitively) and a client may not take a built-in
//     name or a legacy alias;
//   - create() adds a NEW preset object and update() REPLACES one. Nothing is
//     mutated in place, so an already-created session — which captured the preset
//     it was built with — keeps its old factory and descriptor. "Registry changes
//     affect future sessions only" is therefore a structural property, not a
//     convention.
//
// VALIDATION OWNERSHIP
// --------------------
// Field/type validation that concerns the wire (unknown properties, non-object
// bodies) lives in server/api.ts. Semantic validation — known agents, duplicate
// ids, reserved names, editable checks — lives here, because both the HTTP API
// and any future caller must agree. Registry failures carry an HTTP status so the
// dispatcher can map them without re-deriving one.
//
// Cross-references:
//   - ../src/agents/index.ts — the trusted profile registry
//   - ./presets.ts           — the shipped built-ins
//   - ./toolbox.ts           — createProfiledHarness (the live harness factory)
//   - ../server/sessions.ts  — resolves a session's harness through find()
//   - ../server/api.ts       — POST/PATCH /harnesses and GET /agents

import { agentProfiles, isAgentProfileName } from '../src/agents';
import type { AgentProfile } from '../src/agents';
import type { HarnessPreset } from './types';
import { presets } from './presets';
import { SHARED_TOOL_NAMES, createProfiledHarness } from './toolbox';

// Legacy preset identifiers. The catalogue is agent-named now, but a CLI
// invocation, script, or bookmarked API client written against the old names must
// still run. Aliases resolve to the canonical harness and are never listed a
// second time; they are also reserved so a user-created harness cannot shadow
// one. `writer`/`assistant` both meant "one agent" and map to Instruct;
// `researcher` maps to Research.
export const PRESET_ALIASES: Readonly<Record<string, string>> = {
    writer: 'instruct',
    assistant: 'instruct',
    researcher: 'research'
};

// A harness id appears in a URL path and in a session record. Letters first (so
// it is never confused with a number), then letters/digits/_/-, at most 64.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Bounds on human text. Generous for a description, tight enough that a
// descriptor cannot bloat a bootstrap document.
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

// A harness with a huge allowlist is almost certainly a mistake (and every name
// is a trusted id, so the useful ceiling is tiny). The agent registry has six
// profiles today; 16 leaves room without allowing an unbounded array.
const MAX_SUBAGENTS = 16;

// Bounds on a client-supplied model id (R9). Generous for the workspace's
// provider-prefixed ids ("merge/ds4-flash") and for a long hosted name, tight
// enough that the map cannot smuggle a payload into a descriptor.
const MAX_MODEL_ID_LENGTH = 200;

// A model id is an identifier for the session's own provider — the client may
// choose which one, never where it comes from. Control characters are rejected
// because a provider id with a newline is a header-injection smell, not a model.
const MODEL_ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

// What a client may supply when creating a harness. No instructions, provider
// settings, tools, or model: those are trusted/configured server-side.
export type HarnessRegistration = {
    name: string;
    title?: string;
    description?: string;
    primary: string;
    subagents?: readonly string[];
    // Per-agent model overrides (R9): agent id → model id. Optional; an omitted
    // member uses the session's model. Only ids are client-supplied — never a
    // provider, base URL, or credential.
    agentModels?: Readonly<Record<string, string>>;
};

// What a client may change on an existing harness. `name` is immutable: a rename
// would break sessions, bookmarks, and the UI's selected card.
export type HarnessPatch = {
    title?: string;
    description?: string;
    primary?: string;
    subagents?: readonly string[];
    // REPLACE semantics when present (not merge): the patch states the map the
    // harness should have afterwards, so `{}` clears every override, and an agent
    // the patch omits falls back to the session model. Keys must name a FINAL
    // member; an existing key for a member the same patch removed is dropped
    // silently (it can no longer apply) rather than rejected.
    agentModels?: Readonly<Record<string, string>>;
};

export type HarnessRegistry = {
    // Shipped harnesses first (preset order), then user-created ones in creation
    // order. Overrides replace an entry in place, so ordering is stable.
    list: () => readonly HarnessPreset[];
    // Resolve a name, including a legacy alias. Undefined means 404 for a session
    // request.
    find: (name: string) => HarnessPreset | undefined;
    // The trusted agent profiles a client may select as primary/subagent.
    agents: () => readonly AgentProfile[];
    create: (registration: HarnessRegistration) => HarnessPreset;
    update: (name: string, patch: HarnessPatch) => HarnessPreset;
};

// A registry failure with an HTTP status, so the dispatcher maps it like
// HttpError/SessionError instead of guessing. 400 = invalid input, 403 =
// read-only built-in, 404 = unknown harness, 409 = name conflict.
export class HarnessRegistryError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HarnessRegistryError';
    }
}

const requireString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw new HarnessRegistryError(400, `\`${field}\` must be a string.`);
    }

    return value;
};

// Trim, then enforce a non-empty title. A blank title would render as an unnamed
// card, so it is rejected rather than silently replaced.
const normalizeTitle = (value: unknown): string => {
    const title = requireString(value, 'title').trim();

    if (title.length === 0) {
        throw new HarnessRegistryError(400, '`title` cannot be empty.');
    }

    if (title.length > MAX_TITLE_LENGTH) {
        throw new HarnessRegistryError(400, `\`title\` cannot exceed ${MAX_TITLE_LENGTH} characters.`);
    }

    return title;
};

const normalizeDescription = (value: unknown): string => {
    const description = requireString(value, 'description').trim();

    if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new HarnessRegistryError(
            400,
            `\`description\` cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`
        );
    }

    return description;
};

// Validate a trusted agent id. The message lists the known set so a client (and
// its user) can correct a typo without a second discovery call.
const requireAgent = (value: unknown, field: string): string => {
    const name = requireString(value, field);

    if (!isAgentProfileName(name)) {
        throw new HarnessRegistryError(
            400,
            `\`${field}\` names unknown agent "${name}". Known agents: ${agentProfiles()
                .map((profile) => profile.name)
                .join(', ')}.`
        );
    }

    return name;
};

// Validate the allowlist against the (already resolved) primary. Duplicates are
// an error rather than silently collapsed: a request that names an agent twice is
// ambiguous, and the registry should not guess which occurrence was meant.
const normalizeSubagents = (
    value: unknown,
    primary: string
): string[] => {
    if (!Array.isArray(value)) {
        throw new HarnessRegistryError(400, '`subagents` must be an array of agent names.');
    }

    if (value.length > MAX_SUBAGENTS) {
        throw new HarnessRegistryError(400, `\`subagents\` cannot exceed ${MAX_SUBAGENTS} entries.`);
    }

    const resolved: string[] = [];

    for (const entry of value) {
        const name = requireAgent(entry, 'subagents');

        if (name === primary) {
            throw new HarnessRegistryError(
                400,
                `Subagent "${name}" is the primary agent; a harness has exactly one primary.`
            );
        }

        if (resolved.includes(name)) {
            throw new HarnessRegistryError(400, `Subagent "${name}" is listed more than once.`);
        }

        resolved.push(name);
    }

    return resolved;
};

// Validate one model id. Trimmed, non-empty, bounded, and free of control
// characters; anything else is a 400 that names the agent so the UI can point at
// the offending dropdown.
const requireModelId = (value: unknown, agent: string): string => {
    if (typeof value !== 'string') {
        throw new HarnessRegistryError(
            400,
            `\`agentModels.${agent}\` must be a model id string.`
        );
    }

    const model = value.trim();

    if (model.length === 0) {
        throw new HarnessRegistryError(400, `\`agentModels.${agent}\` cannot be empty.`);
    }

    if (model.length > MAX_MODEL_ID_LENGTH) {
        throw new HarnessRegistryError(
            400,
            `\`agentModels.${agent}\` cannot exceed ${MAX_MODEL_ID_LENGTH} characters.`
        );
    }

    if (!MODEL_ID_PATTERN.test(model)) {
        throw new HarnessRegistryError(
            400,
            `\`agentModels.${agent}\` contains control characters.`
        );
    }

    return model;
};

// Validate a per-agent model map against the FINAL member set (R9).
//
// Every key must be a member of this harness — an override for an agent that is
// not selected could never apply, and accepting it would leave a client believing
// it configured something. Unknown keys are therefore rejected explicitly; the
// caller (update) drops keys that became non-members because the SAME patch
// changed the membership, which is a legitimate consequence rather than a typo.
const normalizeAgentModels = (
    value: unknown,
    members: readonly string[]
): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HarnessRegistryError(
            400,
            '`agentModels` must be an object mapping agent ids to model ids.'
        );
    }

    const resolved: Record<string, string> = {};

    for (const [agent, model] of Object.entries(value as Record<string, unknown>)) {
        if (!members.includes(agent)) {
            throw new HarnessRegistryError(
                400,
                `\`agentModels\` names "${agent}", which is not a member of this harness. Members: ${members.join(', ')}.`
            );
        }

        resolved[agent] = requireModelId(model, agent);
    }

    return resolved;
};

export const createHarnessRegistry = (initial: readonly HarnessPreset[] = presets): HarnessRegistry => {
    // Insertion-ordered map: list() is stable, and update() preserves position.
    const entries = new Map<string, HarnessPreset>();

    for (const preset of initial) entries.set(preset.name, preset);

    const find = (name: string): HarnessPreset | undefined => {
        const direct = entries.get(name);
        if (direct !== undefined) return direct;

        const canonical = PRESET_ALIASES[name];
        return canonical === undefined ? undefined : entries.get(canonical);
    };

    // Case-insensitive lookup: "Instruct" would be a distinct map key but the
    // same card to a user, so a new name must not shadow an existing one that way.
    const nameTaken = (name: string): boolean =>
        [...entries.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase());

    const create = (registration: HarnessRegistration): HarnessPreset => {
        const name = requireString(registration?.name, 'name').trim();

        if (!NAME_PATTERN.test(name)) {
            throw new HarnessRegistryError(
                400,
                '`name` must start with a letter and contain only letters, digits, "_" or "-", at most 64 characters.'
            );
        }

        if (Object.prototype.hasOwnProperty.call(PRESET_ALIASES, name)) {
            throw new HarnessRegistryError(
                400,
                `Harness name "${name}" is reserved as an alias of "${PRESET_ALIASES[name]}".`
            );
        }

        if (nameTaken(name)) {
            throw new HarnessRegistryError(409, `Harness "${name}" already exists.`);
        }

        const primary = requireAgent(registration?.primary, 'primary');
        const subagents =
            registration.subagents === undefined
                ? []
                : normalizeSubagents(registration.subagents, primary);

        // The final member set: one primary then its allowlist. The per-agent
        // model map is validated against exactly this, so a key can never name an
        // agent the harness does not contain.
        const agents = [primary, ...subagents];
        const agentModels =
            registration.agentModels === undefined
                ? {}
                : normalizeAgentModels(registration.agentModels, agents);

        const preset: HarnessPreset = {
            name,
            title:
                registration.title === undefined
                    ? name
                    : normalizeTitle(registration.title),
            description:
                registration.description === undefined
                    ? ''
                    : normalizeDescription(registration.description),
            // A user-created harness selects trusted live agents, so it needs a
            // provider exactly like the live built-ins do.
            requiresEndpoint: true,
            primary,
            subagents,
            agents,
            // One toolbox for every live harness, user-created included: the
            // whole catalogue is searchable and the harness core tools are
            // harness-owned.
            tools: SHARED_TOOL_NAMES,
            environmentTools: ['websearch'],
            // Absent vs `{}` are the same thing: no overrides. Stored as a plain
            // object so update() has one shape to reason about.
            agentModels,
            builtin: false,
            editable: true,
            // The factory closure captures the map, so a later PATCH builds a NEW
            // closure: an existing session keeps the models it was created with.
            create: createProfiledHarness(primary, subagents, agentModels)
        };

        entries.set(name, preset);
        return preset;
    };

    const update = (name: string, patch: HarnessPatch): HarnessPreset => {
        // Direct lookup, not find(): a legacy alias is a compatibility redirect for
        // session creation, not an editable identity. PATCHing /harnesses/writer
        // must not silently rewrite instruct.
        const current = entries.get(name);

        if (current === undefined) {
            throw new HarnessRegistryError(404, `Unknown harness "${name}".`);
        }

        // Fixtures are read-only: demo and flaky exist to demonstrate scripted and
        // failing behaviour, and an override would make the fixture claim a
        // configuration it does not run.
        if (!current.editable) {
            throw new HarnessRegistryError(403, `Harness "${current.name}" is read-only.`);
        }

        const primary =
            patch.primary === undefined ? current.primary : requireAgent(patch.primary, 'primary');

        // Changing the primary without restating the allowlist must not leave the
        // new primary inside `subagents` (a harness has exactly one primary). When
        // the client does restate it, it is validated against the new primary.
        const subagents =
            patch.subagents === undefined
                ? current.subagents.filter((entry) => entry !== primary)
                : normalizeSubagents(patch.subagents, primary);

        const agents = [primary, ...subagents];

        // Per-agent models (R9) follow the FINAL membership:
        //   - existing overrides for a member this patch removed are dropped: the
        //     model cannot apply to an agent that is no longer selected, and
        //     carrying it would silently resurrect when the agent returned;
        //   - a stated map REPLACES the overrides (so `{}` clears them all);
        //   - keys in a stated map must be final members — an explicit unknown key
        //     is a typo the client should see, not something to discard.
        const retainedModels = Object.fromEntries(
            Object.entries(current.agentModels ?? {}).filter(([agent]) =>
                agents.includes(agent)
            )
        );

        const agentModels =
            patch.agentModels === undefined
                ? retainedModels
                : normalizeAgentModels(patch.agentModels, agents);

        // A new object, with a new factory closure: an existing session keeps the
        // preset it captured, so it continues to run (and report) the old
        // configuration — including the old per-agent models. This is the
        // frozen-session guarantee.
        const preset: HarnessPreset = {
            ...current,
            title:
                patch.title === undefined ? current.title : normalizeTitle(patch.title),
            description:
                patch.description === undefined
                    ? current.description
                    : normalizeDescription(patch.description),
            primary,
            subagents,
            agents,
            agentModels,
            create: createProfiledHarness(primary, subagents, agentModels)
        };

        entries.set(current.name, preset);
        return preset;
    };

    return {
        list: () => [...entries.values()],
        find,
        agents: () => agentProfiles(),
        create,
        update
    };
};
