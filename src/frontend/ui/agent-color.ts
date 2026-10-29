// Deterministic agent identity colour.
//
// The transcript no longer labels a delegated invocation with a role badge; the
// ONLY thing that separates "this block belongs to agent X" from "agent Y" is the
// colour of the block itself (agent name + the outline drawn around the owning
// surface). That makes the mapping name → colour part of the UI contract, so it
// lives here as one shared helper instead of being invented per component:
//
//   - ui/turns.ts paints the turn tile (root invocation) and every `.thread-tile`
//     (delegated invocation) plus each `.agent` section;
//   - styles.css consumes the two custom properties this module sets
//     (`--agent-color` for the name, `--agent-line` for the block outline).
//
// Properties the rest of the UI relies on:
//   - STABLE: the same agent name always yields the same tone, in this page load
//     and in the next one. Built-in profile ids are an EXPLICIT table (a hash can
//     collide, and the review found research/workspace/reviewer landing on one
//     tone); arbitrary names use a pure hash, never insertion order or a counter,
//     so a re-rendered/hydrated transcript keeps the colours the user learned.
//   - CASE/SPACE INSENSITIVE: `"Writer"`, `"writer"` and `" writer "` are the same
//     agent (the server treats names as ids, and a stray space must not mint a
//     second colour).
//   - UNKNOWN FALLBACK: an empty/absent name, and the UI's `unknown` placeholder
//     for a stream it cannot attribute, get one neutral tone (`slot: -1`) so "we do
//     not know who this is" never looks like an identity (turns.ts paints the tile
//     and its section from the SAME call, so they can never disagree).
//
// Cross-references:
//   - src/agents/index.ts `AGENT_PROFILE_NAMES` — the roster the explicit table
//     mirrors (read-only here: the browser bundle must not import server profiles);
//   - src/frontend/styles.css `:root` — the same fallback values as CSS defaults,
//     so an unpublished block (painted before any event names an agent) reads
//     neutral rather than borrowing slot 0;
//   - src/frontend/ui/turns.ts `createSection` / `createThread` / `rootSection`.

// One deterministic tone. `slot` is the palette index (0..N-1, or -1 for the
// fallback): tests assert slot identity (same agent ⇒ same slot), while the CSS
// only ever sees `color`/`line`.
export type AgentColor = {
    slot: number;
    // Agent name / label colour. A hex value, readable on the dark surface.
    color: string;
    // Outline colour for the agent-owned block. Alpha < 1 keeps a busy transcript
    // from looking like a warning frame; it still survives on top of the
    // state-coloured borders, which is why the outline (not the border) carries
    // identity.
    line: string;
};

// Palette, in slot order. Eight distinct hues for a dark UI: enough that every
// built-in profile gets its own tone. Deliberately avoids the STATE colours green
// (streaming) and red (error), because the outline must be readable ACROSS states:
// a green outline on a green streaming border would read as one state, not an
// identity. Slot 7 (gold) is the one tone that sits near `--warn` (waiting/pending
// text); it is a thin outline + small name label, never a state fill, and it is
// assigned to the `flaky` fixture so the real roles keep the clearly separated hues.
const PALETTE: readonly AgentColor[] = [
    { slot: 0, color: '#7aa2ff', line: 'rgba(122, 162, 255, 0.6)' }, // blue
    { slot: 1, color: '#22d3ee', line: 'rgba(34, 211, 238, 0.6)' }, // cyan
    { slot: 2, color: '#a78bfa', line: 'rgba(167, 139, 250, 0.6)' }, // violet
    { slot: 3, color: '#f472b6', line: 'rgba(244, 114, 182, 0.6)' }, // pink
    { slot: 4, color: '#fb923c', line: 'rgba(251, 146, 60, 0.6)' }, // orange
    { slot: 5, color: '#2dd4bf', line: 'rgba(45, 212, 191, 0.6)' }, // teal
    { slot: 6, color: '#e879f9', line: 'rgba(232, 121, 249, 0.6)' }, // fuchsia
    { slot: 7, color: '#facc15', line: 'rgba(250, 204, 21, 0.6)' } // gold
];

// Unknown agent. Mirror of the `:root` defaults in styles.css (same two values, so
// a block painted here and a block that was never painted look identical).
export const UNKNOWN_AGENT_COLOR: AgentColor = {
    slot: -1,
    color: '#8b94a7',
    line: 'rgba(139, 148, 167, 0.55)'
};

// UI placeholder used by turns.ts for a stream it cannot attribute (a result-only
// legacy frame with no known invocation). It is a sentinel, never an agent id, so
// it resolves to the neutral tone exactly like an absent name.
export const UNNAMED_AGENT_PLACEHOLDER = 'unknown';

// Explicit tones for the built-in profile ids (`src/agents/index.ts`). A hash would
// let two roster roles share a colour (the review caught research/workspace/reviewer
// colliding), so the roster is pinned: one distinct slot per profile, in roster
// order. Keep this table in step with `AGENT_PROFILE_NAMES` — the frontend test
// imports the real roster and fails if a profile is missing or duplicated.
const BUILT_IN_SLOTS: Readonly<Record<string, number>> = {
    instruct: 0,
    research: 1,
    workspace: 2,
    reviewer: 3,
    planner: 4,
    summarizer: 5,
    demo: 6,
    flaky: 7
};

// Canonical agent identity for hashing: trimmed and lower-cased. Exported so a
// caller can compare two spellings without duplicating the rule.
export const agentKeyOf = (agent: string | undefined): string => (agent ?? '').trim().toLowerCase();

// FNV-1a (32-bit). Chosen over a djb2/sum because it spreads short, similar names
// (`helper`, `helpers`) across slots; `Math.imul` keeps the multiply in 32-bit
// range so the result is identical on every engine and in every session. `>>> 0`
// makes it an unsigned index. This is a display-only hash: no security property
// is claimed or needed.
const hashOf = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

// Resolve one agent name to its tone. Pure and total: no throw, no cache, so two
// components can call it for the same name at any time and agree.
export const agentColorOf = (agent: string | undefined): AgentColor => {
    const key = agentKeyOf(agent);

    // Unnamed, or the UI's own placeholder: never hashed, never a palette slot. An
    // unknown agent must not read as (say) slot 0 and look like a real identity.
    if (key.length === 0 || key === UNNAMED_AGENT_PLACEHOLDER) return UNKNOWN_AGENT_COLOR;

    // Built-in profiles are pinned to distinct tones (see BUILT_IN_SLOTS).
    const builtIn = BUILT_IN_SLOTS[key];
    if (builtIn !== undefined) return PALETTE[builtIn];

    return PALETTE[hashOf(key) % PALETTE.length];
};

// Paint an agent-owned surface. Sets the two CSS custom properties styles.css
// consumes and mirrors the name on `data-agent`. An UNNAMED name (empty, blank or
// the `unknown` placeholder) CLEARS `data-agent` instead of writing `''`/`unknown`,
// so every block agrees on the same neutral semantics and a `[data-agent]`
// selector only ever matches a real identity.
export const paintAgentColor = (element: HTMLElement, agent: string | undefined): AgentColor => {
    const tone = agentColorOf(agent);
    element.style.setProperty('--agent-color', tone.color);
    element.style.setProperty('--agent-line', tone.line);

    const name = (agent ?? '').trim();
    if (name.length > 0 && agentKeyOf(name) !== UNNAMED_AGENT_PLACEHOLDER) element.dataset.agent = name;
    else delete element.dataset.agent;

    return tone;
};
