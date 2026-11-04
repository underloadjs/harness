// The GLOBAL agent-override layer (T19).
//
// WHY THIS EXISTS
// ---------------
// `src/agents` is the TRUSTED CATALOGUE: compiled-in profiles that nothing at runtime
// may rewrite (frozen module objects, shared by every harness, tool, and test). The REST
// contract nevertheless exposes `PATCH /agents/{id}` (declarative text overrides) and
// `DELETE /agents/{id}` (retirement), so the deployment needs a layer ABOVE the catalogue
// that stores operator decisions WITHOUT touching the shipped objects.
//
// This module is that layer: an overlay of per-profile field overrides plus retirement
// tombstones, resolved by MERGE at read time. Nothing here mutates `AGENT_PROFILES`,
// `agentProfile()`, or any frozen catalogue object — an effective profile is always a
// freshly built plain object, so a caller holding one can never write back into the
// catalogue ("no unsafe global object mutation").
//
// SEMANTICS
// ---------
//   - a stated field REPLACES the catalogue value for every FUTURE read;
//   - an explicit `null` (which the API layer turns into "field removed from the
//     override") restores the shipped catalogue value for that field only;
//   - an override that equals the shipped value is DROPPED, so `records()` stays a
//     record of decisions and a shipped-default improvement still lands on a profile
//     nobody intentionally changed;
//   - `retired` removes the profile from the selectable catalogue. It does not delete
//     it: existing sessions already hold the agents they were built with, and a saved
//     session restores from its own frozen definition, so retirement changes which
//     profiles NEW sessions and NEW harness edits may name;
//   - "future sessions only" is therefore structural, exactly like the harness
//     registry's replace-never-mutate rule: a running session's brains are separate
//     objects, and nothing here reaches them.
//
// SCOPE / SHARING
// ---------------
// A layer instance is per-registry (tests build isolated registries), with one
// PROCESS-DEFAULT instance behind `defaultAgentState()`: `./toolbox.ts` builds a session's
// agents from a captured factory closure that receives no registry, so the profile text
// has to resolve through a known place. The default instance is the ONLY mutable
// process-global here, it holds only derived overlay data, and the harness registry
// installs itself into it (`attachDefault`), so a host with several registries can keep
// its own instance by passing one to `createHarnessRegistry`.
//
// Cross-references:
//   - ../../../agents/index.ts        — the frozen trusted catalogue (never mutated)
//   - ./registry.ts                   — the harness registry that owns a layer instance
//   - ./toolbox.ts                    — builds session agents through `effectiveAgentProfile`
//   - ../persistence.ts               — `HarnessAgentRecord`, the durable shape (agents.json)
//   - ../api.ts                       — PATCH/DELETE /agents/{id}

import { agentProfiles, isAgentProfileName, agentProfile } from '../../agents';
import type { AgentProfile } from '../../agents';
import type { HarnessAgentRecord } from '../persistence';

export type { HarnessAgentRecord };

/** What a client may change about one profile; `null` restores the shipped value. */
export type AgentProfilePatch = {
    title?: string | null;
    description?: string | null;
    instruction?: string | null;
    guidelines?: readonly string[] | null;
};

/** The fields one profile currently carries, in the shape the wire reports them. */
export type AgentOverrideFields = {
    title?: string;
    description?: string;
    instruction?: string;
    guidelines?: string[];
};

// Bounds and text rules mirror ./registry.ts (which owns HARNESS-level text), because a
// client must not be able to write a 4 MB prompt into an agent profile while the harness
// name field is capped at 120. Kept local on purpose: importing the registry would make
// the dependency cycle (registry -> toolbox -> this module -> registry).
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_INSTRUCTION_LENGTH = 8_000;
const MAX_GUIDELINES = 64;
const MAX_GUIDELINE_LENGTH = 1_000;

// Instruction/guideline text keeps its prose shape (tab/newline/CR allowed, every other
// control character rejected) — the same rule the per-harness instruction override uses.
const PROSE_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/;

/** A layer failure with an HTTP status, so the dispatcher maps it instead of guessing. */
export class AgentStateError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'AgentStateError';
    }
}

const invalid = (message: string): never => {
    throw new AgentStateError(400, message);
};

const normalizeText = (value: string, field: string, max: number): string => {
    const text = value.trim();

    if (text.length === 0) invalid(`\`agent.${field}\` cannot be empty. Send null to restore the shipped value.`);

    if (text.length > max) invalid(`\`agent.${field}\` cannot exceed ${max} characters.`);

    if (!PROSE_PATTERN.test(text)) invalid(`\`agent.${field}\` contains control characters.`);

    return text;
};

// Validate a stated `guidelines` list. `[]` is the explicit clear (the contract says an
// empty array means "no guidelines", and `agentInstruction` composes zero bullets), while
// a blank or oversized entry is a visible 400 rather than a silently dropped line.
const normalizeGuidelines = (value: readonly string[]): string[] => {
    if (value.length > MAX_GUIDELINES) invalid(`\`agent.guidelines\` cannot exceed ${MAX_GUIDELINES} entries.`);

    return value.map((entry, index) =>
        normalizeText(typeof entry === 'string' ? entry : invalid(`\`agent.guidelines[${index}]\` must be a string.`), `guidelines[${index}]`, MAX_GUIDELINE_LENGTH)
    );
};

export type AgentState = {
    /** Every selectable profile, catalogue order, with the global overlay already merged. */
    profiles: () => AgentProfile[];
    /** The effective profile for one id, or `undefined` when unknown or retired. */
    effective: (name: string) => AgentProfile | undefined;
    /** Selectability for NEW work: a known catalogue id that is not retired. */
    isKnown: (name: string) => boolean;
    /** The shipped catalogue profile, with no overlay applied (a receipt's baseline). */
    shipped: (name: string) => AgentProfile | undefined;
    /** Retired ids, in retirement order (durable, and the receipt's `tombstoned` fact). */
    retired: () => readonly string[];
    /** The override fields currently stated for one profile (never a shipped copy). */
    overridesOf: (name: string) => AgentOverrideFields;
    /** The durable projection of every decision this layer holds, in first-decision order. */
    records: () => HarnessAgentRecord[];
    /** Apply a declarative patch; returns the effective profile afterwards. */
    patch: (name: string, patch: AgentProfilePatch) => AgentProfile;
    /** Retire a profile (the DELETE route). Returns the retired id. */
    retire: (name: string) => string;
    /** Replay durable records onto a freshly built layer (startup). Never throws. */
    restore: (records: readonly HarnessAgentRecord[]) => void;
    /** Rollback support: the whole overlay as a value, and its wholesale replacement. */
    snapshot: () => HarnessAgentRecord[];
    restoreSnapshot: (records: readonly HarnessAgentRecord[]) => void;
};

// The shipped catalogue, keyed once per layer build. `agentProfiles()` returns fresh
// objects already, but the lookup is what makes `shipped()` O(1).
const catalogue = (): Map<string, AgentProfile> =>
    new Map(agentProfiles().map((profile) => [profile.name, profile]));

export const createAgentState = (
    initialRecords: readonly HarnessAgentRecord[] = [],
    source: () => readonly AgentProfile[] = agentProfiles
): AgentState => {
    // Insertion-ordered decision log: `records()` — and therefore the durable file — does
    // not reshuffle between restarts, and a later decision for the same id keeps its
    // original position.
    const overlays = new Map<string, { fields: AgentOverrideFields; retired: boolean }>();

    const known = (): Map<string, AgentProfile> => new Map(source().map((profile) => [profile.name, profile]));

    for (const record of initialRecords) {
        if (record === undefined || typeof record.name !== 'string') continue;

        const fields: AgentOverrideFields = {};

        if (record.title !== undefined) fields.title = record.title;
        if (record.description !== undefined) fields.description = record.description;
        if (record.instruction !== undefined) fields.instruction = record.instruction;
        if (record.guidelines !== undefined) fields.guidelines = [...record.guidelines];

        overlays.set(record.name, { fields, retired: record.retired === true });
    }

    const merge = (profile: AgentProfile, fields: AgentOverrideFields): AgentProfile => ({
        ...profile,
        ...(fields.title === undefined ? {} : { title: fields.title }),
        ...(fields.description === undefined ? {} : { description: fields.description }),
        ...(fields.instruction === undefined ? {} : { instruction: fields.instruction }),
        // A stated list REPLACES the shipped bullets wholesale (`[]` means none), and the
        // copy keeps the result independent of both the catalogue and the caller's array.
        ...(fields.guidelines === undefined ? {} : { guidelines: [...fields.guidelines] })
    });

    const profiles = (): AgentProfile[] => {
        const list: AgentProfile[] = [];

        for (const profile of source()) {
            const entry = overlays.get(profile.name);

            if (entry?.retired === true) continue;

            list.push(entry === undefined ? { ...profile } : merge(profile, entry.fields));
        }

        return list;
    };

    const effective = (name: string): AgentProfile | undefined => {
        const profile = known().get(name);

        if (profile === undefined) return undefined;

        const entry = overlays.get(name);

        if (entry?.retired === true) return undefined;

        return entry === undefined ? { ...profile } : merge(profile, entry.fields);
    };

    // One validator for every field so the message a client sees cannot depend on the
    // order the patch names its keys.
    const validate = (patch: AgentProfilePatch): AgentOverrideFields => {
        const fields: AgentOverrideFields = {};

        if (patch.title !== undefined && patch.title !== null) {
            fields.title = normalizeText(String(patch.title), 'title', MAX_TITLE_LENGTH);
        }

        if (patch.description !== undefined && patch.description !== null) {
            fields.description = normalizeText(String(patch.description), 'description', MAX_DESCRIPTION_LENGTH);
        }

        if (patch.instruction !== undefined && patch.instruction !== null) {
            fields.instruction = normalizeText(String(patch.instruction), 'instruction', MAX_INSTRUCTION_LENGTH);
        }

        if (patch.guidelines !== undefined && patch.guidelines !== null) {
            if (!Array.isArray(patch.guidelines)) invalid('`agent.guidelines` must be an array of strings or null.');

            fields.guidelines = normalizeGuidelines(patch.guidelines as readonly string[]);
        }

        return fields;
    };

    const patch = (name: string, patch: AgentProfilePatch): AgentProfile => {
        const profile = known().get(name);

        if (profile === undefined || !isAgentProfileName(name)) {
            throw new AgentStateError(404, `Unknown agent "${name}".`);
        }

        if (overlays.get(name)?.retired === true) {
            throw new AgentStateError(
                404,
                `Agent "${name}" is retired; it is no longer part of the selectable catalogue.`
            );
        }

        const stated = validate(patch);
        const current = overlays.get(name) ?? { fields: {}, retired: false };
        const fields: AgentOverrideFields = { ...current.fields };

        // One rule per field: a stated value REPLACES the override, an explicit `null` REMOVES
        // the override (which restores the shipped value below), and an omitted field leaves it
        // exactly as it was.
        if (patch.title === null) delete fields.title;
        else if (stated.title !== undefined) fields.title = stated.title;

        if (patch.description === null) delete fields.description;
        else if (stated.description !== undefined) fields.description = stated.description;

        if (patch.instruction === null) delete fields.instruction;
        else if (stated.instruction !== undefined) fields.instruction = stated.instruction;

        if (patch.guidelines === null) delete fields.guidelines;
        else if (stated.guidelines !== undefined) fields.guidelines = stated.guidelines;

        // A decision that equals the shipped value is not a decision: dropping it keeps the
        // durable record a list of what the operator actually changed.
        const equalsShipped = (field: 'title' | 'description' | 'instruction'): boolean =>
            fields[field] !== undefined && fields[field] === profile[field];

        for (const field of ['title', 'description', 'instruction'] as const) {
            if (equalsShipped(field)) delete fields[field];
        }

        if (
            fields.guidelines !== undefined &&
            JSON.stringify(fields.guidelines) === JSON.stringify(profile.guidelines)
        ) {
            delete fields.guidelines;
        }

        if (Object.keys(fields).length === 0 && !current.retired) overlays.delete(name);
        else overlays.set(name, { fields, retired: current.retired });

        return merge(profile, fields);
    };

    const retire = (name: string): string => {
        const profile = known().get(name);

        if (profile === undefined || !isAgentProfileName(name)) {
            throw new AgentStateError(404, `Unknown agent "${name}".`);
        }

        if (overlays.get(name)?.retired === true) {
            throw new AgentStateError(404, `Agent "${name}" is already retired.`);
        }

        const current = overlays.get(name) ?? { fields: {}, retired: false };

        overlays.set(name, { fields: current.fields, retired: true });

        return name;
    };

    // The durable projection. Named apart from the `records` constructor parameter so the
    // two never shadow each other inside this closure.
    const toRecords = (): HarnessAgentRecord[] =>
        [...overlays.entries()].map(([name, entry]) => ({
            name,
            ...(entry.fields.title === undefined ? {} : { title: entry.fields.title }),
            ...(entry.fields.description === undefined ? {} : { description: entry.fields.description }),
            ...(entry.fields.instruction === undefined ? {} : { instruction: entry.fields.instruction }),
            ...(entry.fields.guidelines === undefined ? {} : { guidelines: [...entry.fields.guidelines] }),
            ...(entry.retired ? { retired: true } : {})
        }));

    const restore = (incoming: readonly HarnessAgentRecord[]): void => {
        overlays.clear();

        for (const record of incoming) {
            if (record === undefined || typeof record.name !== 'string') continue;

            const fields: AgentOverrideFields = {};

            if (record.title !== undefined) fields.title = record.title;
            if (record.description !== undefined) fields.description = record.description;
            if (record.instruction !== undefined) fields.instruction = record.instruction;
            if (record.guidelines !== undefined) fields.guidelines = [...record.guidelines];

            overlays.set(record.name, { fields, retired: record.retired === true });
        }
    };

    return {
        profiles,
        effective,
        isKnown: (name) => effective(name) !== undefined,
        shipped: (name) => {
            const profile = known().get(name);

            return profile === undefined ? undefined : { ...profile };
        },
        retired: () => [...overlays.entries()].filter(([, entry]) => entry.retired).map(([name]) => name),
        overridesOf: (name) => {
            const fields = overlays.get(name)?.fields ?? {};

            return {
                ...(fields.title === undefined ? {} : { title: fields.title }),
                ...(fields.description === undefined ? {} : { description: fields.description }),
                ...(fields.instruction === undefined ? {} : { instruction: fields.instruction }),
                ...(fields.guidelines === undefined ? {} : { guidelines: [...fields.guidelines] })
            };
        },
        records: toRecords,
        patch,
        retire,
        restore,
        snapshot: () => toRecords(),
        restoreSnapshot: (incoming) => restore(incoming)
    };
};

// The process-default layer. `./toolbox.ts` resolves profile text through it, because a
// captured harness factory has no registry reference; `createHarnessRegistry` installs the
// registry's own instance here unless a host explicitly passes another one.
let DEFAULT: AgentState | undefined;

export const defaultAgentState = (): AgentState => (DEFAULT ??= createAgentState());

export const attachDefaultAgentState = (state: AgentState): void => {
    DEFAULT = state;
};

/** The profile a NEW session's agent should run: catalogue text with the global overlay merged. */
export const effectiveAgentProfile = (name: string): AgentProfile | undefined =>
    defaultAgentState().effective(name);

/** The shipped catalogue text for one id (never overlay-merged), for receipts and errors. */
export const shippedAgentProfile = (name: string): AgentProfile | undefined =>
    isAgentProfileName(name) ? { ...agentProfile(name) } : undefined;
