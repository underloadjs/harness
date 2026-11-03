// The trusted agent registry.
//
// One place answers "what agents exist, and what are they instructed to do?".
// The server exposes these as AgentDescriptor values, validates a harness's
// primary/subagents against them, and builds the actual runtime agents from the
// same profiles. A client never supplies instruction text.
//
// Order matters: the first entries are the real specialist roles a picker should
// show first, followed by the delegated summarizer, then the two fixtures. Tests
// pin the order, so a new profile is an explicit addition rather than an accident
// of object key ordering.
//
// ROSTER (T3): the five real roles are instruct (general), research (researcher),
// workspace (coder), reviewer (skeptical bug hunt) and planner (plan + route to
// specialists). `summarizer` stays as the delegated condenser the research
// profile's `textSummarize` path uses, and `demo`/`flaky` stay as fixtures — they
// are examples, never the headline choice.
//
// Cross-references:
//   - ./types.ts      — AgentProfile
//   - ./guidelines.ts — the policy lines the real roles share (one source, no drift)
//   - ./instruct.ts … — one file per profile
//   - ../../harnesses/presets.ts — built-in harnesses assembled from these ids
//   - ../../harnesses/registry.ts — user-created harnesses validated here

import type { AgentProfile } from './types';
import { instruct } from './instruct';
import { research } from './research';
import { summarizer } from './summarizer';
import { workspace } from './workspace';
import { reviewer } from './reviewer';
import { planner } from './planner';
import { demo } from './demo';
import { flaky } from './flaky';

export type { AgentProfile } from './types';

// The registry, keyed by the id a harness selects. `satisfies` keeps the literal
// keys while proving every value is a complete profile.
export const AGENT_PROFILES = {
    instruct,
    research,
    workspace,
    reviewer,
    planner,
    summarizer,
    demo,
    flaky
} as const satisfies Record<string, AgentProfile>;

export type AgentProfileName = keyof typeof AGENT_PROFILES;

// Display/selection order. Kept separate from the object so a reordering never
// changes ids, and so a caller can iterate without relying on insertion order.
// Real roles first (in preset order), then the summarizer/fixtures: a picker that
// renders this list therefore offers the five usable roles before the examples.
export const AGENT_PROFILE_NAMES: readonly AgentProfileName[] = [
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'summarizer',
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

// Build THE system prompt for an agent: one string holding the identity sentence
// and, below it, one composed guidelines block. A single helper means a guideline
// added to a profile reaches the runtime automatically — the definitions ARE the
// prompt, not documentation that can drift from it.
//
// WHY ONE STRING AND NOT `[instruction, guidelines]`
// --------------------------------------------------
// `agent({ instruction })` seeds one `system` message per array entry
// (../core/agent.ts `seed`), so the previous two-entry return value put TWO system
// messages at the head of every transcript, and the transport forwards them
// verbatim (../transport/openai.ts `wireMessage` → `{ role: 'system' }`). Several
// OpenAI-compatible gateways accept exactly one system turn — or silently keep only
// the first/last one — so on those models the guidelines were dropped or rejected
// and the role ran on its identity sentence alone. The two sections are therefore
// joined HERE, at the single place that composes them, so every model receives the
// same complete prompt as one system message.
//
// Empty guidelines produce the instruction alone, so a minimal profile is valid.
//
// T3 EDITABLE CONFIGURATION — `instructionOverride` is the harness-level
// per-agent instruction the operator saved (`HarnessPreset.agentInstructions`,
// see ../server/harnesses/types.ts). It replaces ONLY the identity sentence:
// `guidelines` stay trusted catalogue policy lines, so a saved configuration can
// retune an agent's role without letting a stored document silently drop the
// shared behavioural rules. An absent or blank override is "no override", which
// keeps the trusted text byte-identical — the shipped profiles remain the default.
export const agentInstruction = (profile: AgentProfile, instructionOverride?: string): string => {
    const custom = instructionOverride === undefined ? '' : instructionOverride.trim();
    const instruction = custom.length > 0 ? custom : profile.instruction.trim();

    // A blank bullet would render as a stray "- " inside the joined prompt, so an
    // empty guideline never survives into the block.
    const guidelines = profile.guidelines.map((guideline) => guideline.trim()).filter((line) => line.length > 0);

    if (guidelines.length === 0) return instruction;

    // Blank line between the sections: the model sees ONE message, so the paragraph
    // break is what separates "who you are" from "rules you follow".
    return `${instruction}\n\nGuidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;
};
