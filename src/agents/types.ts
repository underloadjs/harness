// Trusted agent profiles.
//
// WHY THIS FILE EXISTS
// --------------------
// An agent is more than a model name: it is an identity with an instruction and a
// set of guidelines. Those definitions are TRUSTED catalogue data — a client may
// choose an agent, but must never supply the text a model is seeded with. Keeping
// them under `src/agents` (instead of inline in the application's preset
// factories) means:
//
//   - the catalogue can expose `AgentDescriptor` metadata (name/title/description/
//     instruction/guidelines) without building a harness or a transport;
//   - the server can validate a user-selected primary/subagent against a stable
//     registry of known ids;
//   - a preset and a user-created harness build the SAME agent from the SAME
//     definition, so they cannot drift in wording.
//
// The application layer (harnesses/) supplies the provider settings and assembles
// agents with `agent({ model, instruction: agentInstruction(profile), ... })`.
// Nothing here imports the transport, so this folder is pure data + helpers.
//
// Cross-references:
//   - ./index.ts          — the registry, `agentProfile()`, `agentInstruction()`
//   - ../../harnesses/presets.ts — built-in harnesses assembled from these profiles
//   - ../../server/protocol.ts   — AgentDescriptor, the wire view of a profile

// One trusted agent. `instruction` is the identity sentence; `guidelines` are the
// rules that follow it. Both are seeded into the model's system messages — the
// runtime composition lives in `agentInstruction()` so "guidelines affect runtime"
// is a single, testable path rather than per-preset string concatenation.
export type AgentProfile = {
    // Stable registry id. A harness selects agents by this name, and a session
    // records the names it was built with.
    name: string;
    // Human label for a picker/card.
    title: string;
    // One sentence: what this agent is for.
    description: string;
    // The identity system message.
    instruction: string;
    // Ordered behavioural rules. Each becomes one bullet in the composed system
    // message; empty means the instruction stands alone.
    guidelines: readonly string[];
};
