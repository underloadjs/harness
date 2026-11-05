// The in-memory harness registry.
//
// WHY THIS EXISTS
// ---------------
// The catalogue used to be a frozen array of presets: the only harnesses a client
// could run were the ones shipped with the package. The registry now starts from
// INDEPENDENT COPIES of the shipped templates (R20.1): every card is an editable
// application entry, a client may create a harness (choose a primary, optionally
// subagents/models), and PATCH produces a new immutable entry. Everything is
// in-memory only: there is no persistence layer, so a restart returns to the
// shipped templates. That limitation is documented in README.md/knowledge.md.
//
// There is NO read-only harness concept. `editable` survives on the wire as a
// compatibility field and is always true; the registry never gates on it, and a
// non-live template (demo's script, flaky's extra tool) is editable too.
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
// TEMPLATE PRESERVATION
// ---------------------
// A PATCH is split into two kinds:
//   - metadata only (title/description) — keep the captured factory and every
//     executable field, so demo stays the scripted fixture, flaky keeps testFlaky,
//     and a live harness keeps the exact closure a session captured;
//   - executable (primary/subagents and the per-agent maps: agentModels,
//     agentInstructions, agentColors) — rebuild from the template:
//       'live'     → createProfiledHarness (unchanged behaviour);
//       'scripted' → upgrade to a LIVE profiled harness and correct the descriptor
//                    (requiresEndpoint, shared toolbox, environmentTools) so the
//                    card stops claiming scripted behaviour it no longer runs;
//       'flaky'    → rebuild the live toolbox with the testFlaky extra retained.
// A hand-built/injected preset without a `template` defaults to 'live'.
//
// DELETION (T5)
// -------------
// `remove()` takes a harness out of the catalogue for good. Two different problems
// have to stay distinct:
//   - a USER harness (builtin:false): its row is written from `list()`, so removing
//     the entry removes the row and the next restart has nothing to resurrect.
//   - a SHIPPED built-in: the registry always starts from the templates in
//     ./presets.ts, so "the row is gone" is not enough — a restart would ship it
//     again. A deleted built-in therefore leaves an additive TOMBSTONE (the name in
//     `deletedBuiltins`, persisted as `deleted` in the database). Restore replays
//     tombstones BEFORE the saved rows, and `create()` clears the tombstone for the
//     name it takes so a re-created harness survives its own restart.
// Aliases follow their target: `writer` is an alias of `instruct`, so it resolves
// to nothing while `instruct` is deleted and resolves again once it is re-created.
// The alias NAMES themselves stay reserved, deleted target or not.
//
// SHIPPED-DEFAULT REFRESH (T3)
// ----------------------------
// restoreHarnessRegistry() replays a saved built-in row only when it differs from
// what this build ships. To keep an improved default (a wider subagent allowlist,
// a new title) from being pinned by an old copy, a row whose executable fields
// still match LEGACY_PRESET_DEFINITIONS (./presets.ts) is treated as an unmodified
// shipped default and refreshed; a row with any executable difference is treated
// as a customisation and replayed. Frozen sessions are unaffected: they rebuild
// from their own record (see ./sessions.ts restoreSession).
//
// VALIDATION OWNERSHIP
// --------------------
// Field/type validation that concerns the wire (unknown properties, non-object
// bodies) lives in src/server/api.ts. Semantic validation — known agents, duplicate
// ids, reserved names — lives here, because both the HTTP API and any future
// caller must agree. Registry failures carry an HTTP status so the dispatcher can
// map them without re-deriving one.
//
// Cross-references:
//   - ../src/agents/index.ts — the trusted profile registry
//   - ./presets.ts           — the shipped templates
//   - ./toolbox.ts           — createProfiledHarness / createToolboxHarness
//   - ../sessions.ts  — resolves a session's harness through find()
//   - ../api.ts       — POST/PATCH /harnesses and GET /agents

import { agentProfiles, isAgentProfileName } from '../../agents';
import type { AgentProfile } from '../../agents';
import type { HarnessPreset } from './types';
import type { HarnessAgentRecord, HarnessPresetRecord } from '../persistence';
import { attachDefaultAgentState, createAgentState } from './agent-state';
import type { AgentProfilePatch, AgentState } from './agent-state';
import { ALL_PRESET_TEMPLATES, LEGACY_PRESET_DEFINITIONS, presets } from './presets';
import type { LegacyPresetDefinition } from './presets';
import {
    EXAMPLE_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createProfiledHarness,
    createToolboxHarness
} from './toolbox';

// Legacy preset identifiers. The catalogue is agent-named now, but a CLI
// invocation, script, or bookmarked API client written against the old names must
// still run. Aliases resolve to the canonical harness and are never listed a
// second time; they are also reserved so a user-created harness cannot shadow
// one. `writer`/`assistant` both meant "one agent" and map to Instruct;
// `researcher` maps to Research.
//
// T3 deliberately does NOT alias the visible title "Coder": `workspace` is the id
// every saved session, bookmark and script uses, and reserving a new name could
// collide with a user-created harness of that name on a restart (the row would be
// rejected and the database restore would fail). The card title says Coder, and the
// CLI listing shows the pair, which is enough discovery.
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
// is a trusted id, so the useful ceiling is tiny). The agent registry has eight
// profiles today (five real roles, the summarizer, two fixtures); 16 leaves room
// without allowing an unbounded array.
const MAX_SUBAGENTS = 16;

// Bounds on a client-supplied model id (R9). Generous for the workspace's
// provider-prefixed ids ("merge/ds4-flash") and for a long hosted name, tight
// enough that the map cannot smuggle a payload into a descriptor.
const MAX_MODEL_ID_LENGTH = 200;

// A model id is an identifier for the session's own provider — the client may
// choose which one, never where it comes from. Control characters are rejected
// because a provider id with a newline is a header-injection smell, not a model.
const MODEL_ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

// Bounds on a client-supplied INSTRUCTION override (T3 editable configuration).
// A system prompt is legitimately longer than a description, but it must stay a
// prompt: 8000 characters is generous for a role definition while keeping one
// saved harness from smuggling megabytes into every request of every session.
const MAX_INSTRUCTION_LENGTH = 8_000;

// Instruction text keeps its prose shape: tab, newline and CR are allowed (a role
// definition is often multi-line), every other control character is rejected.
const INSTRUCTION_TEXT_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/;

// Accepted per-agent identity COLOR (R2): a CSS hex color, 3/4/6/8 digits, either
// case. This is deliberately the SAME expression the library validates at agent
// construction (src/core/agent.ts `AGENT_COLOR_PATTERN`) and the same expression the
// HTTP contract publishes (`harness.swagger.yaml` `agent_colors.pattern`): a color the
// edge accepts is always one `agent()` accepts and a UI can always paint. The
// duplication is only about the ERROR, not the rule — here a rejection must be a 400
// that names the offending agent, while `agent()` names the agent it was configuring.
// src/server/harnesses/registry.test.ts pins the two layers to one shared
// accepted/rejected sample set so they cannot drift.
const AGENT_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// What a client may supply when creating a harness. No provider settings, tools,
// or model: those are trusted/configured server-side. `agentInstructions` (T3) is
// the one text-shaped field, and it is an OVERRIDE stored on this harness — the
// trusted profile in src/agents is never rewritten by it.
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
    // Per-agent instruction overrides (T3): agent id → instruction text. Optional;
    // an omitted member runs its trusted catalogue instruction.
    agentInstructions?: Readonly<Record<string, string>>;
    // Per-agent identity colors (R2): agent id → CSS hex color. Optional, and
    // display-only — it changes what a host paints, never what an agent runs. Values
    // must be a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and keys must name
    // a member, exactly like the two maps above.
    agentColors?: Readonly<Record<string, string>>;
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
    // Same REPLACE semantics as `agentModels` (T3): `{}` clears every instruction
    // override so every member runs its trusted instruction again.
    agentInstructions?: Readonly<Record<string, string>>;
    // Same REPLACE semantics as the two maps above (R2): `{}` clears every color, so
    // every member falls back to the host's own swatch. A color is display-only, but
    // it is still EXECUTABLE in the registry's sense: the map is captured by the
    // factory closure, so a stated map rebuilds the factory (see `update`) and an
    // existing session keeps the colors it was built with.
    agentColors?: Readonly<Record<string, string>>;
};

// A synchronous capture of everything a registry mutation can change: the entries
// (in listing order) and the deleted-builtin tombstones (T5). Entries hold the SAME
// preset objects the registry holds — a preset is never mutated in place (update()
// replaces it), so a capture is cheap and restoring one cannot disagree with what
// an existing session already captured.
//
// WHY THIS EXISTS: a harness mutation is only real once it is durable, so the
// dispatcher's create/patch/delete route commits through the session store, which
// writes the whole document. If that write fails, an in-memory registry that still
// shows the mutation is a lie the next restart will undo. Snapshot/restore gives
// that commit path ONE rollback mechanism for all three mutations instead of a
// hand-written undo per mutation (and it preserves insertion order, which a
// "re-create it" rollback would not).
export type HarnessRegistrySnapshot = {
    entries: readonly (readonly [string, HarnessPreset])[];
    deletedBuiltins: readonly string[];
    // T19: the global agent overlay travels with the registry snapshot, because the agent
    // layer is registry-owned state committed through the SAME durable unit. A store that
    // rolls a failed commit back with `restore(snapshot)` therefore rolls an agent edit
    // back too, without any change to the store's commit code.
    agents: readonly HarnessAgentRecord[];
};

export type HarnessRegistry = {
    // Shipped harnesses first (preset order), then user-created ones in creation
    // order. Overrides replace an entry in place, so ordering is stable. A deleted
    // built-in (T5) is absent here and stays absent across restarts.
    list: () => readonly HarnessPreset[];
    // Resolve a name, including a legacy alias. Undefined means 404 for a session
    // request.
    find: (name: string) => HarnessPreset | undefined;
    // The trusted agent profiles a client may select as primary/subagent. T19: these are
    // the EFFECTIVE profiles — the shipped catalogue with the global override layer merged
    // and retired profiles removed — so every existing reader of `agents()` (harness
    // validation, instruction projections, the agent catalogue) states the operator's
    // configuration without knowing the layer exists.
    agents: () => readonly AgentProfile[];
    // T19: the global agent overlay itself (./agent-state.ts). Exposed so the API can state
    // `has_global_override` / `instruction_source` from ONE authority instead of re-deriving
    // it, and so a host can persist `agentRecords()` without reaching into the layer.
    agentState: () => AgentState;
    // T19: declarative text override of one trusted profile. Never touches the shipped
    // catalogue object; affects FUTURE sessions only. Throws AgentStateError (400/404).
    patchAgent: (name: string, patch: AgentProfilePatch) => AgentProfile;
    // T19: retire one profile (the DELETE route): it leaves the selectable catalogue for
    // new sessions and new member selections, and leaves a durable tombstone.
    retireAgent: (name: string) => string;
    // T19: the durable projection of the overlay (overrides + retirement).
    agentRecords: () => HarnessAgentRecord[];
    // T19: retired profile ids, in retirement order.
    deletedAgents: () => readonly string[];
    // T19: whether one id may be SELECTED by new work (known and not retired).
    isAgentSelectable: (name: string) => boolean;
    // T19: replay the durable overlay onto a freshly built registry (startup restore).
    // Idempotent and never throws.
    restoreAgentRecords: (records: readonly HarnessAgentRecord[]) => void;
    create: (registration: HarnessRegistration) => HarnessPreset;
    update: (name: string, patch: HarnessPatch) => HarnessPreset;
    // T5: remove one harness. Direct name only, like update() — a legacy alias is a
    // read compatibility redirect, not an identity that can be deleted. Throws 404
    // for an unknown or already-deleted name. A deleted BUILT-IN leaves a tombstone
    // (see `deletedBuiltins`); a deleted user harness leaves nothing, because its
    // saved row is simply gone. Sessions are untouched: an existing session runs the
    // preset it captured, and a saved session restores from its own frozen record.
    remove: (name: string) => HarnessPreset;
    // The built-in names the operator deleted (T5), in deletion order. This is
    // durable state: ./persistence.ts writes it as `deleted` so a restart does not
    // resurrect a shipped card the operator removed.
    deletedBuiltins: () => readonly string[];
    // Replay durable deletions onto a freshly built registry (startup restore). The
    // entry is dropped when this build ships it, and the tombstone is recorded even
    // when it does not, so the decision survives a build that renames a default.
    // Idempotent and never throws — a startup replay has no request to answer.
    restoreDeletedBuiltins: (names: readonly string[]) => void;
    // Rollback support for the durable commit path (see HarnessRegistrySnapshot).
    snapshot: () => HarnessRegistrySnapshot;
    restore: (snapshot: HarnessRegistrySnapshot) => void;
};

// A registry failure with an HTTP status, so the dispatcher maps it like
// HttpError/SessionError instead of guessing. 400 = invalid input, 404 = unknown
// harness, 409 = name conflict. There is no 403: no harness is read-only (R20.1).
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
//
// T19: `selectable` is the GLOBAL agent overlay's gate. The id must always be a
// catalogue identity; when a checker is supplied, a RETIRED profile is refused too,
// because an HTTP write that selected it could never run in a new session. A restored
// saved row deliberately passes no checker: a harness that already selects a profile the
// operator retired stays replayable (its own sessions keep working), and the refusal
// happens when someone tries to select it NEW.
const requireAgent = (
    value: unknown,
    field: string,
    selectable?: (name: string) => boolean
): string => {
    const name = requireString(value, field);

    if (!isAgentProfileName(name)) {
        throw new HarnessRegistryError(
            400,
            `\`${field}\` names unknown agent "${name}". Known agents: ${agentProfiles()
                .map((profile) => profile.name)
                .join(', ')}.`
        );
    }

    if (selectable !== undefined && !selectable(name)) {
        throw new HarnessRegistryError(
            409,
            `Agent "${name}" is retired and can no longer be selected. Existing harnesses and sessions that already select it are unaffected.`
        );
    }

    return name;
};

// Validate the allowlist against the (already resolved) primary. Duplicates are
// an error rather than silently collapsed: a request that names an agent twice is
// ambiguous, and the registry should not guess which occurrence was meant.
const normalizeSubagents = (
    value: unknown,
    primary: string,
    selectable?: (name: string) => boolean
): string[] => {
    if (!Array.isArray(value)) {
        throw new HarnessRegistryError(400, '`subagents` must be an array of agent names.');
    }

    if (value.length > MAX_SUBAGENTS) {
        throw new HarnessRegistryError(400, `\`subagents\` cannot exceed ${MAX_SUBAGENTS} entries.`);
    }

    const resolved: string[] = [];

    for (const entry of value) {
        const name = requireAgent(entry, 'subagents', selectable);
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
//
// Exported because the session store validates the same map for
// PATCH /sessions/:id (a live per-agent model change). One validator keeps the
// two mutation surfaces from disagreeing about what a model id is, and the
// message a client sees is identical. It throws HarnessRegistryError (400); a
// non-registry caller re-wraps it into its own error type.
export const normalizeAgentModels = (
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

// Validate one instruction override. Trimmed, non-empty, bounded, and free of
// control characters other than tab/newline/CR. A blank value is rejected rather
// than treated as "no override" for exactly the reason an empty model id is: a
// client that means "revert to the trusted instruction" must OMIT the key (or send
// `{}`), so an accidental paste of whitespace cannot silently discard a saved
// override while the UI still shows the old text.
const requireInstruction = (value: unknown, agent: string): string => {
    if (typeof value !== 'string') {
        throw new HarnessRegistryError(
            400,
            `\`agentInstructions.${agent}\` must be an instruction string.`
        );
    }

    const instruction = value.trim();

    if (instruction.length === 0) {
        throw new HarnessRegistryError(
            400,
            `\`agentInstructions.${agent}\` cannot be empty. Omit the key to run the trusted instruction.`
        );
    }

    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
        throw new HarnessRegistryError(
            400,
            `\`agentInstructions.${agent}\` cannot exceed ${MAX_INSTRUCTION_LENGTH} characters.`
        );
    }

    if (!INSTRUCTION_TEXT_PATTERN.test(instruction)) {
        throw new HarnessRegistryError(
            400,
            `\`agentInstructions.${agent}\` contains control characters.`
        );
    }

    return instruction;
};

// Validate a per-agent instruction map against the FINAL member set (T3).
//
// Mirrors `normalizeAgentModels` deliberately: the same key-membership rule (an
// override for an agent this harness does not select can never apply, so it is a
// visible 400 rather than a stored no-op) and the same all-or-nothing shape. The
// value rule differs only in bounds, because instruction text is prose rather than
// an identifier. Exported for the same reason as the model validator: one place
// decides what a legal instruction override is, so the wire message cannot drift.
export const normalizeAgentInstructions = (
    value: unknown,
    members: readonly string[]
): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HarnessRegistryError(
            400,
            '`agentInstructions` must be an object mapping agent ids to instruction text.'
        );
    }

    const resolved: Record<string, string> = {};

    for (const [agent, instruction] of Object.entries(value as Record<string, unknown>)) {
        if (!members.includes(agent)) {
            throw new HarnessRegistryError(
                400,
                `\`agentInstructions\` names "${agent}", which is not a member of this harness. Members: ${members.join(', ')}.`
            );
        }

        resolved[agent] = requireInstruction(instruction, agent);
    }

    return resolved;
};

// Validate one color override. Trimmed, then matched against the hex shape. A blank
// value is a rejection rather than "no color", for the same reason a blank model id
// and blank instruction are: a client that means "drop this swatch" must omit the key
// (or send `{}`), so an accidental paste cannot silently discard a saved color while
// the UI still paints the old one.
const requireAgentColor = (value: unknown, agent: string): string => {
    if (typeof value !== 'string') {
        throw new HarnessRegistryError(
            400,
            `\`agentColors.${agent}\` must be a CSS hex color string.`
        );
    }

    const color = value.trim();

    if (color.length === 0) {
        throw new HarnessRegistryError(
            400,
            `\`agentColors.${agent}\` cannot be empty. Omit the key to leave this agent uncolored.`
        );
    }

    if (!AGENT_COLOR_PATTERN.test(color)) {
        throw new HarnessRegistryError(
            400,
            `\`agentColors.${agent}\` must be a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa). Received ${JSON.stringify(value)}.`
        );
    }

    return color;
};

// Validate a per-agent color map against the FINAL member set (R2).
//
// The third map of the same shape, with the same two rules as `normalizeAgentModels`
// and `normalizeAgentInstructions`: an entry for an agent this harness does not select
// can never be painted, so it is a visible 400 rather than a stored no-op, and the
// whole map is validated all-or-nothing. Exported for the same reason as the other
// two: one place decides what a legal color is, so the wire message cannot drift
// between the harness routes and any later caller that re-validates a color map.
export const normalizeAgentColors = (
    value: unknown,
    members: readonly string[]
): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HarnessRegistryError(
            400,
            '`agentColors` must be an object mapping agent ids to CSS hex colors.'
        );
    }

    const resolved: Record<string, string> = {};

    for (const [agent, color] of Object.entries(value as Record<string, unknown>)) {
        if (!members.includes(agent)) {
            throw new HarnessRegistryError(
                400,
                `\`agentColors\` names "${agent}", which is not a member of this harness. Members: ${members.join(', ')}.`
            );
        }

        resolved[agent] = requireAgentColor(color, agent);
    }

    return resolved;
};

// Copy one template into an independent registry entry. Arrays and the model map
// are copied so nothing a registry (or a caller holding list()[i]) does can reach
// the shipped module constants. The factory is shared: it is immutable (a closure
// over its own configuration), and sharing it is exactly what lets a metadata-only
// PATCH preserve demo's script / flaky's extra tool.
//
// `editable` is forced true: R20.1 removes the read-only concept, and the field is
// kept only so an existing client still sees its familiar wire shape.
const copyTemplate = (preset: HarnessPreset): HarnessPreset => ({
    ...preset,
    subagents: [...preset.subagents],
    agents: [...preset.agents],
    tools: [...preset.tools],
    ...(preset.environmentTools === undefined
        ? {}
        : { environmentTools: [...preset.environmentTools] }),
    ...(preset.agentModels === undefined ? {} : { agentModels: { ...preset.agentModels } }),
    ...(preset.agentInstructions === undefined
        ? {}
        : { agentInstructions: { ...preset.agentInstructions } }),
    ...(preset.agentColors === undefined ? {} : { agentColors: { ...preset.agentColors } }),
    // R7: a session template's invented agents are copied like the three maps above, so a
    // registry entry (or an injected preset) that carries them never shares one mutable object
    // with the caller. Harness DEFINITIONS declare none — the create/PATCH surface has no field
    // for it — so in practice this key is absent on every registry entry.
    ...(preset.customAgents === undefined ? {} : { customAgents: { ...preset.customAgents } }),
    editable: true
});

// Build the factory for a template's LIVE form. 'flaky' keeps its example-only
// extra tool; everything else is the shared profiled harness. The model, instruction,
// and color maps are captured by the closure (via createProfiledHarness /
// agentsFromProfiles), which is what makes a later PATCH invisible to an existing
// session. `customAgents` (R7) is captured the same way, and it is the map that tells
// `agentsFromProfiles` which members are session-defined rather than catalogue roles; a
// harness-definition PATCH passes none (default `{}`), because a registry entry cannot
// declare one — only a session's frozen record carries it, and `presetFromRecord` below is
// the caller that hands it back.
const liveFactory = (
    template: 'live' | 'flaky',
    primary: string,
    subagents: readonly string[],
    agentModels: Readonly<Record<string, string>>,
    agentInstructions: Readonly<Record<string, string>> = {},
    agentColors: Readonly<Record<string, string>> = {},
    customAgents: Readonly<Record<string, string>> = {}
): HarnessPreset['create'] => {
    if (template === 'live') {
        return createProfiledHarness(
            primary,
            subagents,
            agentModels,
            agentInstructions,
            agentColors,
            customAgents
        );
    }

    return (settings, progress, report) =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles(
                    [primary, ...subagents],
                    settings,
                    agentModels,
                    agentInstructions,
                    agentColors,
                    customAgents
                ),
                primary,
                subagents: [...subagents],
                // T19/F1: a rebuilt flaky example keeps its extra TOOL SET, but
                // the extra is supplied as an editable source path so startup uses
                // the same compiler as every other shipped/app tool.
                // T25: the paths are DISCOVERED from server/tools/examples, so the
                // example set cannot drift from the files.
                extraToolSources: { ...EXAMPLE_APP_TOOL_SOURCES }
            },
            settings,
            progress,
            report
        );
};

// ---------------------------------------------------------------------------
// Durable registry records (R3b)
// ---------------------------------------------------------------------------
//
// These helpers keep the persistence layer out of the registry's internals: a
// record is a preset WITHOUT its factory, and the functions below are the only
// place that knows how to turn one back into a preset. That matters because a
// restart must reproduce a session's captured harness even after the registry
// entry was patched (a session freezes its creation-time preset).

// Project a preset onto durable metadata. Arrays/maps are copied so a caller
// (or a saved document) can never alias the live registry entry.
export const presetToRecord = (preset: HarnessPreset): HarnessPresetRecord => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    requiresEndpoint: preset.requiresEndpoint,
    primary: preset.primary,
    subagents: [...preset.subagents],
    agents: [...preset.agents],
    tools: [...preset.tools],
    ...(preset.environmentTools === undefined
        ? {}
        : { environmentTools: [...preset.environmentTools] }),
    ...(preset.agentModels === undefined || Object.keys(preset.agentModels).length === 0
        ? {}
        : { agentModels: { ...preset.agentModels } }),
    ...(preset.agentInstructions === undefined ||
      Object.keys(preset.agentInstructions).length === 0
        ? {}
        : { agentInstructions: { ...preset.agentInstructions } }),
    // R2: same absent/empty equivalence — a harness with no colors writes no field, so
    // every document saved before colors is byte-identical.
    ...(preset.agentColors === undefined || Object.keys(preset.agentColors).length === 0
        ? {}
        : { agentColors: { ...preset.agentColors } }),
    // R7: same absent/empty equivalence — a harness with no session-defined agents writes no
    // field, so every document saved before R7 (and every harness DEFINITION, which never has
    // any) is byte-identical.
    ...(preset.customAgents === undefined || Object.keys(preset.customAgents).length === 0
        ? {}
        : { customAgents: { ...preset.customAgents } }),
    builtin: preset.builtin,
    editable: preset.editable,
    ...(preset.template === undefined ? {} : { template: preset.template }),
    ...(preset.live === undefined ? {} : { live: { ...preset.live } })
});

// Deterministic equality for records this module builds (fixed key order), used
// to skip re-applying an unmodified shipped template on restore.
export const presetRecordEquals = (left: HarnessPresetRecord, right: HarnessPresetRecord): boolean =>
    JSON.stringify(presetToRecordShape(left)) === JSON.stringify(presetToRecordShape(right));

// Normalize field ORDER so equality is structural rather than insertion-order
// dependent (the validator returns keys in a fixed order, while presetToRecord
// spreads optionals; both must compare equal).
const presetToRecordShape = (record: HarnessPresetRecord): HarnessPresetRecord => ({
    name: record.name,
    title: record.title,
    description: record.description,
    requiresEndpoint: record.requiresEndpoint,
    primary: record.primary,
    subagents: [...record.subagents],
    agents: [...record.agents],
    tools: [...record.tools],
    ...(record.environmentTools === undefined
        ? {}
        : { environmentTools: [...record.environmentTools] }),
    ...(record.agentModels === undefined || Object.keys(record.agentModels).length === 0
        ? {}
        : { agentModels: { ...record.agentModels } }),
    ...(record.agentInstructions === undefined ||
      Object.keys(record.agentInstructions).length === 0
        ? {}
        : { agentInstructions: { ...record.agentInstructions } }),
    // R2: part of the fixed key order, so a saved row that carries colors compares
    // equal to the registry entry rebuilt from it (and one that carries none keeps the
    // pre-R2 shape on both sides).
    ...(record.agentColors === undefined || Object.keys(record.agentColors).length === 0
        ? {}
        : { agentColors: { ...record.agentColors } }),
    // R7: same treatment for the session-defined agent map. This is the comparison that makes
    // a session restore rebuild its factory (`./sessions.ts` `restoreSession` compares the
    // registry entry against the session's frozen record), so a record that carries a custom
    // agent NEVER matches an entry that does not — which is exactly the outcome that routes the
    // rebuild through `presetFromRecord` and back through `agentsFromProfiles`.
    ...(record.customAgents === undefined || Object.keys(record.customAgents).length === 0
        ? {}
        : { customAgents: { ...record.customAgents } }),
    builtin: record.builtin,
    editable: record.editable,
    ...(record.template === undefined ? {} : { template: record.template }),
    ...(record.live === undefined ? {} : { live: { ...record.live } })
});

// Rebuild a preset from durable metadata. The factory is chosen from `template`
// exactly like update() does:
//   - 'live'     → the standard profiled factory;
//   - 'flaky'    → live toolbox with testFlaky retained;
//   - 'scripted' → the shipped scripted factory for that name, looked up in
//                  ALL_PRESET_TEMPLATES so a fixture that left the shipped
//                  catalogue (T5: demo) still rebuilds for an old session (a
//                  scripted entry's executable fields can never have changed: an
//                  executable PATCH promotes it to 'live');
//   - absent     → an injected/custom preset. Its factory is not serializable, so
//                  a caller must pass the still-available entry as `fallback`; a
//                  mismatch is an error instead of a silently different harness.
export const presetFromRecord = (
    record: HarnessPresetRecord,
    fallback?: HarnessPreset
): HarnessPreset => {
    let create: HarnessPreset['create'];

    if (record.template === 'scripted') {
        // T5: the lookup is the SUPERSET (catalogue + fixtures), not `presets`. A
        // session frozen on an older build recorded only the NAME of a scripted
        // harness, and its factory lives in exactly one place; if that place is no
        // longer in the shipped catalogue, the session still has to rebuild. Same
        // reason the fixture presets stay exported.
        const shipped = ALL_PRESET_TEMPLATES.find(
            (preset) => preset.name === record.name && preset.template === 'scripted'
        );

        if (shipped === undefined) {
            throw new Error(
                `Scripted harness "${record.name}" is not shipped in this build; the session cannot be restored.`
            );
        }

        create = shipped.create;
    } else if (record.template === 'flaky') {
        create = liveFactory(
            'flaky',
            record.primary,
            record.subagents,
            record.agentModels ?? {},
            record.agentInstructions ?? {},
            record.agentColors ?? {},
            // R7: the session's invented agents go back into the same closure the roster is
            // built from, so a rebuilt member runs the same prompt and model it was bound with.
            record.customAgents ?? {}
        );
    } else if (record.template === 'live') {
        create = liveFactory(
            'live',
            record.primary,
            record.subagents,
            record.agentModels ?? {},
            record.agentInstructions ?? {},
            record.agentColors ?? {},
            record.customAgents ?? {}
        );
    } else {
        if (fallback === undefined) {
            throw new Error(
                `Harness "${record.name}" was injected in memory and cannot be rebuilt from disk; provide it in the registry before restoring.`
            );
        }

        const current = presetToRecord(fallback);

        if (
            current.primary !== record.primary ||
            JSON.stringify(current.subagents) !== JSON.stringify(record.subagents) ||
            JSON.stringify(current.agents) !== JSON.stringify(record.agents) ||
            JSON.stringify(current.agentModels ?? {}) !== JSON.stringify(record.agentModels ?? {}) ||
            // T3: a saved instruction override is part of the executable
            // definition. An injected preset that no longer carries it would
            // silently restore a different prompt, so the mismatch is an error.
            JSON.stringify(current.agentInstructions ?? {}) !==
            JSON.stringify(record.agentInstructions ?? {}) ||
            // R2: a saved color is part of the frozen definition too. An injected preset
            // that no longer carries it would restore a differently painted harness, so
            // the mismatch is an error rather than a silent repaint.
            JSON.stringify(current.agentColors ?? {}) !== JSON.stringify(record.agentColors ?? {}) ||
            // R7: a saved session-defined agent is part of the frozen roster in the strongest
            // sense — an injected factory has no way to build a brain the catalogue does not
            // know about, so a record that names one while the factory's preset does not would
            // silently restore a team missing that member.
            JSON.stringify(current.customAgents ?? {}) !== JSON.stringify(record.customAgents ?? {})
        ) {
            throw new Error(
                `Harness "${record.name}" changed incompatibly while its session was saved; the frozen definition cannot be rebuilt.`
            );
        }

        create = fallback.create;
    }

    // Metadata comes from the RECORD (the session's frozen view), the factory from
    // the template. `editable` is normalized true by the registry everywhere.
    return {
        name: record.name,
        title: record.title,
        description: record.description,
        requiresEndpoint: record.requiresEndpoint,
        primary: record.primary,
        subagents: [...record.subagents],
        agents: [...record.agents],
        tools: [...record.tools],
        ...(record.environmentTools === undefined
            ? {}
            : { environmentTools: [...record.environmentTools] }),
        ...(record.agentModels === undefined
            ? {}
            : { agentModels: { ...record.agentModels } }),
        ...(record.agentInstructions === undefined
            ? {}
            : { agentInstructions: { ...record.agentInstructions } }),
        ...(record.agentColors === undefined ? {} : { agentColors: { ...record.agentColors } }),
        // R7: the session-defined agent map is metadata the rebuilt entry must keep, or the
        // NEXT session created from this preset (and the roster read of the restored one) would
        // lose the member. Absent stays absent, so a pre-R7 record produces a preset with no
        // key at all — the exact shape it had before this field existed.
        ...(record.customAgents === undefined ? {} : { customAgents: { ...record.customAgents } }),
        builtin: record.builtin,
        editable: true,
        ...(record.template === undefined ? {} : { template: record.template }),
        ...(record.live === undefined ? {} : { live: { ...record.live } }),
        create
    };
};

// Register every shipped harness as an independent, editable application copy.
//
// A SHIPPED DEFAULT vs A USER EDIT (T3 restore policy)
// ----------------------------------------------------
// A saved built-in record is a copy of what shipped at the time it was saved. Some
// builds change a shipped default — T3 widened the real presets' subagent
// allowlists and retitled research/workspace — and replaying such a row verbatim
// would pin the old build's defaults forever.
//
// The rule is CONSERVATIVE and provable: refresh a built-in row only when its
// executable fields still match a recorded previous shipped definition
// (LEGACY_PRESET_DEFINITIONS in ./presets.ts). That means the operator never
// changed the executable configuration, so the row is a shipped default, not a
// decision. A row that differs in ANY executable field (or carries per-agent
// models) is a real customisation and is replayed exactly as saved. Prose edits
// survive a refresh: a saved title/description that differs from BOTH the legacy
// and the current shipped text is re-applied with a metadata-only patch.
//
// FROZEN SESSIONS ARE NEVER TOUCHED: this function only rebuilds registry entries.
// A session restores through ./sessions.ts `restoreSession`, which rebuilds from
// the session's OWN frozen preset record, so an old conversation keeps the team it
// started with no matter what the registry now ships.
export const isLegacyShippedDefinition = (
    definition: LegacyPresetDefinition,
    record: HarnessPresetRecord
): boolean => {
    const sameList = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
        JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

    return (
        record.requiresEndpoint === definition.requiresEndpoint &&
        record.primary === definition.primary &&
        sameList(record.subagents, definition.subagents) &&
        sameList(record.agents, definition.agents) &&
        sameList(record.tools, definition.tools) &&
        sameList(record.environmentTools, definition.environmentTools) &&
        (record.template ?? 'live') === (definition.template ?? 'live') &&
        // A per-agent model map is a customisation, even when the team matches.
        Object.keys(record.agentModels ?? {}).length === 0 &&
        // T3: so is a saved instruction override — it is executable text, not prose.
        Object.keys(record.agentInstructions ?? {}).length === 0 &&
        // R2: and so is a saved color. Shipped templates carry none, and a refresh would
        // drop the row's map (the refresh replays prose only), so an operator who colored
        // one member of a built-in keeps that decision instead of losing it to an upgrade.
        Object.keys(record.agentColors ?? {}).length === 0 &&
        // R7: and so is a saved session-defined agent (a registry row never has one, so this
        // only ever fires on a document a foreign writer produced — where dropping the custom
        // roster on a prose refresh would be a silent roster change).
        Object.keys(record.customAgents ?? {}).length === 0
    );
};

// Replay a saved registry onto a freshly built in-memory registry.
//
// Built-ins are patched through update() so the template rules (scripted demo
// keeps its script on a metadata-only edit; an executable edit promotes it) run
// exactly as they did originally. User-created entries are re-created in saved
// order, which is also their listing order. An untouched entry is skipped.
//
// A `builtin` record absent from the target registry is a seeded/injected preset
// this build does not ship; it is left to the caller (its sessions still restore
// from their own frozen preset record).
//
// T5 `deletedBuiltins`: the names the operator deleted, replayed FIRST so this
// build's shipped copy of one of them is gone before the record loop can compare or
// patch it. A deleted built-in has no saved row (the document is written from
// `list()`), so the two lists never disagree about the same name; a row that DOES
// name a tombstoned entry is the newer decision and re-creates it (which clears the
// tombstone in `create()`).
export const restoreHarnessRegistry = (
    registry: HarnessRegistry,
    records: readonly HarnessPresetRecord[],
    deletedBuiltins: readonly string[] = [],
    // T19 (ADDITIVE): the durable global agent overlay (`agents.json`). Replayed first, so
    // the entry loop below compares and patches against the EFFECTIVE profiles rather than
    // the shipped ones.
    agentRecords: readonly HarnessAgentRecord[] = []
): void => {
    registry.restoreDeletedBuiltins(deletedBuiltins);

    if (Array.isArray(agentRecords) && agentRecords.length > 0) {
        registry.restoreAgentRecords(agentRecords);
    }

    const known = new Map(registry.list().map((preset) => [preset.name, presetToRecord(preset)]));

    for (const record of records) {
        const existing = known.get(record.name);

        if (existing === undefined) {
            if (record.builtin) continue;

            registry.create({
                name: record.name,
                title: record.title,
                description: record.description,
                primary: record.primary,
                subagents: [...record.subagents],
                ...(record.agentModels === undefined ? {} : { agentModels: { ...record.agentModels } }),
                ...(record.agentInstructions === undefined
                    ? {}
                    : { agentInstructions: { ...record.agentInstructions } }),
                ...(record.agentColors === undefined ? {} : { agentColors: { ...record.agentColors } })
                // R7: no `customAgents` half here, deliberately. `HarnessRegistration`
                // (./registry.ts) declares no custom agents — they are session state, written
                // only into a session's own frozen preset copy — so a replayed DEFINITION row
                // rebuilds its factory with `{}`. A session that carries customs never takes
                // this path: it rebuilds through `presetFromRecord` (./sessions.ts
                // `restoreSession`), which does hand the map to the factory.
            });
            known.set(record.name, record);
            continue;
        }

        if (presetRecordEquals(existing, record)) continue;

        // Shipped-default refresh (see the header note). `existing` is the CURRENT
        // template as this build ships it, and a legacy match proves the saved row
        // is an unmodified older default.
        const legacy = record.builtin ? LEGACY_PRESET_DEFINITIONS[record.name] : undefined;

        if (legacy !== undefined && isLegacyShippedDefinition(legacy, record)) {
            // Only prose the operator actually wrote is carried across: text that
            // still equals the legacy shipped text is the shipped text, so the new
            // template's wording wins.
            const keepTitle = record.title !== legacy.title && record.title !== existing.title;
            const keepDescription =
                record.description !== legacy.description && record.description !== existing.description;

            if (keepTitle || keepDescription) {
                registry.update(record.name, {
                    ...(keepTitle ? { title: record.title } : {}),
                    ...(keepDescription ? { description: record.description } : {})
                });
            }

            const refreshed = registry.find(record.name);
            if (refreshed !== undefined) known.set(record.name, presetToRecord(refreshed));
            continue;
        }

        // Executable fields are replayed only for templates whose factory is
        // derivable from them. A scripted/unknown (injected) template keeps its
        // captured factory, so only its human metadata is applied.
        const executable = record.template === 'live' || record.template === 'flaky';

        registry.update(record.name, {
            title: record.title,
            description: record.description,
            ...(executable
                ? {
                      primary: record.primary,
                      subagents: [...record.subagents],
                      agentModels: { ...record.agentModels },
                      // T3: instruction overrides are executable state, so a saved
                      // row replays them through the same patch that rebuilds the
                      // factory. `{}` is correct when the row has none: it clears
                      // overrides a newer template might ship.
                      agentInstructions: { ...record.agentInstructions },
                      // R2: colors replay through the same patch for the same reason —
                      // the map is captured by the factory, and `{}` is the explicit
                      // "this row had none", which clears colors a newer template might
                      // ship. A scripted/injected row keeps its captured factory, so it
                      // stays metadata-only exactly like the two maps above.
                      agentColors: { ...record.agentColors }
                      // R7: `customAgents` is NOT part of `HarnessPatch`, for the same reason it is not part of
                      // `HarnessRegistration`: a harness DEFINITION cannot declare one (only a session's frozen
                      // preset copy carries them), so a definition row replays with none and the factory it
                      // rebuilds needs no custom-agent map. A restored SESSION never takes this path: it rebuilds
                      // through ./sessions.ts `restoreSession` -> `presetFromRecord`, which does pass the map.
                  }
                : {})
        });
        known.set(record.name, record);
    }
};

export type HarnessRegistryOptions = {
    // T5: built-in names the operator deleted, already recorded in the durable
    // database (`deleted` in <root>/harness/state.json). A template whose name
    // appears here is NOT inserted, so a shipped default stays removed across
    // restarts. Order is preserved, which keeps the saved document stable.
    deletedBuiltins?: readonly string[];
    // T19: the durable global agent overlay (`<root>/harness/agents.json`), replayed
    // before the first read so a restart does not resurrect a retired profile or forget
    // an operator's text override.
    agentRecords?: readonly HarnessAgentRecord[];
    // T19: inject an existing overlay layer instead of building one. A host that keeps
    // several registries (or a test that wants an isolated catalogue) passes one; without
    // it, this registry's layer also becomes the PROCESS default that ./toolbox.ts
    // resolves profile text through — see the note in ./agent-state.ts.
    agentState?: AgentState;
};

export const createHarnessRegistry = (
    initial: readonly HarnessPreset[] = presets,
    options: HarnessRegistryOptions = {}
): HarnessRegistry => {
    // Insertion-ordered map: list() is stable, and update() preserves position.
    const entries = new Map<string, HarnessPreset>();

    // T19: the global agent overlay this registry resolves profiles through. Built from
    // the durable records BEFORE anything reads `agents()`, so a restart cannot serve a
    // retired profile for one request. It also becomes the PROCESS default
    // (./agent-state.ts `attachDefaultAgentState`), which is what lets a captured harness
    // factory — a shipped template included — resolve the operator's text at the moment a
    // NEW session is built. One server process therefore owns one registry; a host that
    // keeps several passes its own `agentState` and pins the default itself.
    const agentState = options.agentState ?? createAgentState(options.agentRecords ?? []);

    attachDefaultAgentState(agentState);

    // Selectability gate for NEW selections only (see `requireAgent`): the id must be a
    // catalogue identity AND not retired. A name this harness already selects bypasses the
    // check, so a saved row that keeps a retired member stays replayable and patchable.
    const selectableAgent = (name: string): boolean => agentState.isKnown(name);

    // Deleted built-in tombstones (T5). An insertion-ordered Set, so
    // `deletedBuiltins()` — and therefore the saved document — does not reshuffle
    // between restarts.
    const deleted = new Set<string>();

    // Seed the tombstones BEFORE the templates are copied in, because a tombstoned
    // template must never appear in `entries` at all.
    for (const value of options.deletedBuiltins ?? []) {
        if (typeof value !== 'string') continue;

        const name = value.trim();

        if (name.length > 0) deleted.add(name);
    }

    // R20.1: start from independent template copies, never the module constants.
    for (const preset of initial) {
        if (deleted.has(preset.name)) continue;

        entries.set(preset.name, copyTemplate(preset));
    }

    // The shipped title/description per template. An executable upgrade of a
    // non-live template adopts its `live` metadata only while these strings are
    // still untouched, so an operator's earlier title/description edit survives.
    const shippedMetadata = new Map(
        initial.map((preset) => [
            preset.name,
            { title: preset.title, description: preset.description }
        ])
    );

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

        const primary = requireAgent(registration?.primary, 'primary', selectableAgent);
        const subagents =
            registration.subagents === undefined
                ? []
                : normalizeSubagents(registration.subagents, primary, selectableAgent);

        // The final member set: one primary then its allowlist. The per-agent
        // model map is validated against exactly this, so a key can never name an
        // agent the harness does not contain.
        const agents = [primary, ...subagents];
        const agentModels =
            registration.agentModels === undefined
                ? {}
                : normalizeAgentModels(registration.agentModels, agents);

        // Instruction overrides (T3) are validated against the same final member
        // set: an override for an unselected agent could never apply.
        const agentInstructions =
            registration.agentInstructions === undefined
                ? {}
                : normalizeAgentInstructions(registration.agentInstructions, agents);

        // Colors (R2) are validated against the same final member set: a swatch for an
        // unselected agent could never be painted, so it is a 400 rather than a stored
        // no-op. The value rule is the library's hex shape, so a saved harness can never
        // hold a color `agent()` would reject.
        const agentColors =
            registration.agentColors === undefined
                ? {}
                : normalizeAgentColors(registration.agentColors, agents);

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
            // One toolbox for every live harness, user-created included. The four
            // core file tools are declared up front (R18); the searchable remainder
            // waits for toolRequest. The factory is createToolboxHarness, which opts
            // into BOTH web rows, and each is declared core when it registers
            // (R9-R11) - so both belong in this declaration.
            // Copied so no registry entry aliases the shared module array.
            tools: [...SHARED_TOOL_NAMES],
            environmentTools: ['search', 'fetch'],
            // Absent vs `{}` are the same thing: no overrides. Stored as a plain
            // object so update() has one shape to reason about.
            agentModels,
            // T3: same absent-vs-empty equivalence as `agentModels`. The factory
            // closure captures it, so an existing session keeps the instruction its
            // agents were built with.
            agentInstructions,
            // R2: same absent-vs-empty equivalence, and captured by the same factory
            // closure, so an existing session keeps the colors its agents were built with.
            agentColors,
            builtin: false,
            editable: true,
            // A created harness is a live profiled harness; later PATCHes treat
            // it like the live built-ins.
            template: 'live',
            // The factory closure captures the map, so a later PATCH builds a NEW
            // closure: an existing session keeps the models it was created with.
            create: createProfiledHarness(primary, subagents, agentModels, agentInstructions, agentColors)
        };

        entries.set(name, preset);

        // T5: taking a deleted built-in's NAME is an explicit decision to have that
        // harness again, so the tombstone goes with it. Without this the document
        // would carry the new row AND the tombstone, and the next restore would
        // remove the harness the operator just created. The commit order is what
        // keeps the two consistent: the dispatcher persists AFTER this returns, and
        // a failed write restores the tombstone through `restore()`.
        deleted.delete(name);

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

        // R20.1: no read-only gate. Every entry is an editable application copy;
        // the previous 403 branch is intentionally gone, and `editable` is a wire
        // compatibility field only.
        //
        // T19 selectability: a name this entry ALREADY selects stays valid after the
        // operator retires the profile (that is what keeps a saved row restorable and an
        // existing team runnable), while a name the patch INTRODUCES must be selectable.
        const previouslySelected = new Set(current.agents);
        const selectableHere = (name: string): boolean =>
            selectableAgent(name) || previouslySelected.has(name);

        const primary =
            patch.primary === undefined
                ? current.primary
                : requireAgent(patch.primary, 'primary', selectableHere);

        // Changing the primary without restating the allowlist must not leave the
        // new primary inside `subagents` (a harness has exactly one primary). When
        // the client does restate it, it is validated against the new primary.
        const subagents =
            patch.subagents === undefined
                ? current.subagents.filter((entry) => entry !== primary)
                : normalizeSubagents(patch.subagents, primary, selectableHere);

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

        // Instruction overrides (T3) follow the identical rule, for the identical
        // reason: an override for an agent this patch removed can never apply, so it
        // is dropped, and a stated map REPLACES the stored one (`{}` clears it).
        const retainedInstructions = Object.fromEntries(
            Object.entries(current.agentInstructions ?? {}).filter(([agent]) =>
                agents.includes(agent)
            )
        );

        const agentInstructions =
            patch.agentInstructions === undefined
                ? retainedInstructions
                : normalizeAgentInstructions(patch.agentInstructions, agents);

        // Colors (R2) follow the identical rule for the identical reason: a swatch for an
        // agent this patch removed can never be painted, so it is dropped, and a stated
        // map REPLACES the stored one (`{}` clears every color).
        const retainedColors = Object.fromEntries(
            Object.entries(current.agentColors ?? {}).filter(([agent]) =>
                agents.includes(agent)
            )
        );

        const agentColors =
            patch.agentColors === undefined
                ? retainedColors
                : normalizeAgentColors(patch.agentColors, agents);

        // R20.1 template handling. A metadata-only patch keeps the exact factory
        // the entry already captured (demo's script, flaky's testFlaky, a live
        // closure). An executable patch rebuilds from the template:
        //   - 'scripted' upgrades to a live profiled factory AND corrects the
        //     descriptor fields that would otherwise still advertise the offline
        //     fixture (requiresEndpoint/tools/environmentTools), then becomes a
        //     'live' entry for any later patch;
        //   - 'flaky' rebuilds the live toolbox with testFlaky retained;
        //   - everything else uses the standard profiled factory.
        const template = current.template ?? 'live';

        // An instruction edit is EXECUTABLE, not prose: it changes the system
        // messages the next session's agents are seeded with, so it must rebuild the
        // factory exactly like a model or team change (and, on the scripted demo,
        // upgrade it to a live harness rather than storing text the script ignores).
        const executable =
            patch.primary !== undefined ||
            patch.subagents !== undefined ||
            patch.agentModels !== undefined ||
            patch.agentInstructions !== undefined ||
            // R2: a color is display-only, but it is still EXECUTABLE in this sense: the
            // map is captured by the factory closure and reaches every `Agent` built from
            // it, so a stated color must rebuild the factory (and, on the scripted demo,
            // upgrade it to a live harness exactly like an instruction edit does). Keeping
            // it metadata-only would store a swatch that no agent ever carries.
            patch.agentColors !== undefined;

        const upgradedScripted = executable && template === 'scripted';

        // Honest prose on upgrade: only when the current values are still the
        // shipped template's (an operator edit is never overwritten).
        const shipped = shippedMetadata.get(current.name);
        const untouched = (field: 'title' | 'description'): boolean =>
            shipped !== undefined && current[field] === shipped[field];
        const upgradedTitle =
            upgradedScripted && current.live !== undefined && untouched('title')
                ? current.live.title
                : current.title;
        const upgradedDescription =
            upgradedScripted && current.live !== undefined && untouched('description')
                ? current.live.description
                : current.description;

        const create = executable
            ? liveFactory(
                  template === 'scripted' || template === 'live' ? 'live' : 'flaky',
                  primary,
                  subagents,
                  agentModels,
                  agentInstructions,
                  agentColors
              )
            : current.create;

        // A new object: an existing session keeps the preset it captured, so it
        // continues to run (and report) the old configuration — including the old
        // per-agent models. This is the frozen-session guarantee.
        const preset: HarnessPreset = {
            ...current,
            title:
                patch.title === undefined ? upgradedTitle : normalizeTitle(patch.title),
            description:
                patch.description === undefined
                    ? upgradedDescription
                    : normalizeDescription(patch.description),
            primary,
            subagents,
            agents,
            agentModels,
            // T3: stated explicitly (not inherited from `...current`) so a patch that
            // replaces or clears the map is what the new entry carries.
            agentInstructions,
            // R2: same explicit statement — `{}` from a patch means "no colors", which
            // `...current` would not produce on its own.
            agentColors,
            ...(upgradedScripted
                ? {
                      // The upgrade replaces the script with the live toolbox, which
                      // registers search AND fetch; both are core declarations (R9-R11).
                      requiresEndpoint: true,
                      tools: [...SHARED_TOOL_NAMES],
                      environmentTools: ['search', 'fetch'],
                      template: 'live' as const
                  }
                : {}),
            create
        };

        entries.set(current.name, preset);
        return preset;
    };

    // T5: remove one harness. Returns the entry that was removed (the dispatcher's
    // DELETE route answers `{ deleted: true }`, but a host that rolls back or logs
    // the removal needs to know what it removed).
    const remove = (name: string): HarnessPreset => {
        // Direct lookup, like update(): `PATCH/DELETE /harnesses/writer` must never
        // rewrite `instruct` through a compatibility redirect.
        const current = entries.get(name);

        if (current === undefined) {
            // A repeat DELETE is 404, not a second success: the caller believed it
            // removed something. The wording says which kind of miss this is, so a
            // UI cannot confuse "never existed" with "already deleted".
            throw new HarnessRegistryError(
                404,
                deleted.has(name)
                    ? `Harness "${name}" has already been deleted.`
                    : `Unknown harness "${name}".`
            );
        }

        entries.delete(name);

        // Only a built-in needs a tombstone, because only a built-in comes back on
        // the next start (the registry always seeds from ./presets.ts). A user
        // harness is durable-absent as soon as it is absent from `list()`, which is
        // what the saved document is written from.
        if (current.builtin) deleted.add(name);

        return current;
    };

    // Startup replay of durable deletions (restoreHarnessRegistry). Deliberately
    // total: an unknown or already-deleted name is a no-op rather than an error,
    // because a tombstone may name a built-in this build stopped shipping (a
    // re-shipped default must still come back deleted) and a restart has no request
    // to answer with a status.
    const restoreDeletedBuiltins = (names: readonly string[]): void => {
        for (const value of Array.isArray(names) ? names : []) {
            if (typeof value !== 'string') continue;

            const name = value.trim();

            if (name.length === 0) continue;

            entries.delete(name);
            deleted.add(name);
        }
    };

    // T19: agent-layer operations, exposed through the registry so the dispatcher's commit
    // unit (`store.mutateRegistry`) covers them with the SAME snapshot/restore it already
    // uses for a harness create/patch/delete: `snapshot()` captures the overlay, and a
    // failed durable write restores it, so an agent edit is never half-applied.
    const patchAgent = (name: string, patch: AgentProfilePatch): AgentProfile =>
        agentState.patch(name, patch);

    const retireAgent = (name: string): string => agentState.retire(name);

    // A repeat DELETE of an already-retired profile is 404 (`Unknown agent`), which is what
    // `agentState.retire` already answers; a repeat DELETE of an unknown id is the same.

    const snapshot = (): HarnessRegistrySnapshot => ({
        entries: [...entries.entries()],
        deletedBuiltins: [...deleted],
        // A detached copy (the layer returns fresh records), so a later mutation cannot
        // write through the captured rollback value.
        agents: agentState.snapshot()
    });

    // Replace the whole mutable state with a captured one. Order is rebuilt from the
    // snapshot's entry list, so a rolled-back registry lists exactly what it listed
    // before the failed commit. Safe as a wholesale replace because a registry
    // mutation and its commit are one synchronous block in the dispatcher (the body
    // is read before the mutation), so no other request can have changed the map in
    // between; a preset object itself is never mutated in place, so an existing
    // session's captured preset is identical either way.
    const restore = (captured: HarnessRegistrySnapshot): void => {
        entries.clear();

        for (const [name, preset] of captured.entries) entries.set(name, preset);

        deleted.clear();

        for (const name of captured.deletedBuiltins) deleted.add(name);

        // T19: the overlay rolls back with the entries. Guarded, because a snapshot
        // captured by a caller built before the agent layer carries no `agents` field, and
        // wiping the overlay in that case would silently un-apply an operator's decisions.
        if (Array.isArray(captured.agents)) agentState.restoreSnapshot(captured.agents);
    };

    return {
        list: () => [...entries.values()],
        find,
        // T19: the EFFECTIVE profiles (catalogue + global overlay, retired ones removed).
        agents: () => agentState.profiles(),
        agentState: () => agentState,
        patchAgent,
        retireAgent,
        agentRecords: () => agentState.records(),
        deletedAgents: () => agentState.retired(),
        isAgentSelectable: (name: string) => agentState.isKnown(name),
        restoreAgentRecords: (records: readonly HarnessAgentRecord[]) => agentState.restore(records),
        create,
        update,
        remove,
        deletedBuiltins: () => [...deleted],
        restoreDeletedBuiltins,
        snapshot,
        restore
    };
};
