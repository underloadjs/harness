// The trusted agent registry.
//
// One place answers "what agents exist, and what are they instructed to do?".
// The server exposes these as AgentDescriptor values, validates a harness's
// primary/subagents against them, and builds the actual runtime agents from the
// same profiles. A client never supplies instruction text.
//
// Order matters: the first entries are the general-purpose agents a picker should
// show first, followed by the delegated summarizer, then the two fixtures. Tests
// pin the order, so a new profile is an explicit addition rather than an accident
// of object key ordering.
//
// Cross-references:
//   - ./types.ts      — AgentProfile
//   - ./instruct.ts … — one file per profile
//   - ../../harnesses/presets.ts — built-in harnesses assembled from these ids
//   - ../../harnesses/registry.ts — user-created harnesses validated here

import type { AgentProfile } from './types';
import { instruct } from './instruct';
import { research } from './research';
import { summarizer } from './summarizer';
import { workspace } from './workspace';
import { demo } from './demo';
import { flaky } from './flaky';

export type { AgentProfile } from './types';

// The registry, keyed by the id a harness selects. `satisfies` keeps the literal
// keys while proving every value is a complete profile.
export const AGENT_PROFILES = {
    instruct,
    research,
    summarizer,
    workspace,
    demo,
    flaky
} as const satisfies Record<string, AgentProfile>;

export type AgentProfileName = keyof typeof AGENT_PROFILES;

// Display/selection order. Kept separate from the object so a reordering never
// changes ids, and so a caller can iterate without relying on insertion order.
export const AGENT_PROFILE_NAMES: readonly AgentProfileName[] = [
    'instruct',
    'research',
    'summarizer',
    'workspace',
    'demo',
    'flaky'
];

// Every profile, in `AGENT_PROFILE_NAMES` order.
export const agentProfiles = (): AgentProfile[] =>
    AGENT_PROFILE_NAMES.map((name) => AGENT_PROFILES[name]);

// Resolve a profile by id. Validation happens here so a typo in a harness request
// is a clear error rather than an agent with no instructions.
export const agentProfile = (name: string): AgentProfile => {
    if (!isAgentProfileName(name)) {
        throw new Error(
            `Unknown agent "${name}". Known agents: ${AGENT_PROFILE_NAMES.join(', ')}.`
        );
    }

    return AGENT_PROFILES[name];
};

export const isAgentProfileName = (name: string): name is AgentProfileName =>
    Object.prototype.hasOwnProperty.call(AGENT_PROFILES, name);

// Build the system messages for an agent: the identity instruction first, then one
// composed guidelines block. A single helper means a guideline added to a profile
// reaches the runtime automatically — the definitions ARE the prompt, not
// documentation that can drift from it.
//
// Empty guidelines produce only the instruction, so a minimal profile is valid.
export const agentInstruction = (profile: AgentProfile): string[] => {
    const instruction = profile.instruction.trim();
    const guidelines = profile.guidelines.map((guideline) => guideline.trim()).filter((line) => line.length > 0);

    if (guidelines.length === 0) return [instruction];

    return [instruction, ['Guidelines:', ...guidelines.map((line) => `- ${line}`)].join('\n')];
};
