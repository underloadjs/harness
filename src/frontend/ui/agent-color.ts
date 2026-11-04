// Agent identity colour, assigned by the UI for the current page (T5/R4).
//
// The transcript no longer labels a delegated invocation with a role badge; the
// ONLY thing that separates "this block belongs to agent X" from "agent Y" is the
// colour of the block itself (agent name + the outline drawn around the owning
// surface). That makes the mapping name → colour part of the UI contract, so it
// lives here as one shared helper instead of being invented per component:
//
//   - ui/turns.ts paints the turn tile (root invocation), every `.thread-tile` /
//     `.thread-select` row (delegated invocation, the `IT1`/`RR2` labels) and each
//     `.agent` section;
//   - ui/agent-control.ts paints the composer's agent button (`Instruct` / `IT`);
//   - ui/agent-dialog.ts paints every roster badge (`Configure …`) and every `[+]`
//     picker option;
//   - styles.css + ui/agent-dialog.css consume the two custom properties this module
//     sets (`--agent-color` for the name/label, `--agent-line` for the block frame).
//
// CONTRACT (R4: the user asked for the UI to assign colours RANDOMLY)
// -------------------------------------------------------------------
//   - RANDOM, ONCE PER PAGE: a fresh identity gets the next slot of a palette order
//     shuffled at module load. No backend field and no stored preference is involved
//     (the schema has no colour concept), and the assignment is not persisted across a
//     reload — "what colour is Researcher" may change on reload, which the user
//     accepted in exchange for not having to configure anything.
//   - STABLE FOR THIS PAGE: the slot is keyed by the canonical agent id, so the same
//     agent keeps the SAME tone for the whole page lifetime — across re-renders, a
//     chrome rebuild, a re-opened dialog and every surface at once. Only a NEW
//     identity consumes anything; an already-known agent never re-draws, so a
//     re-render cannot flicker a colour the reader is already using.
//   - DISTINCT WHILE THE PALETTE LASTS: the shuffled order is a permutation, so the
//     first `PALETTE.length` identities get pairwise different tones. Only after the
//     palette is exhausted does a tone get reused (the permutation cycles again).
//   - CASE/SPACE INSENSITIVE: `"Writer"`, `"writer"` and `" writer "` are the same
//     agent (the server treats names as ids, and a stray space must not mint a second
//     colour, nor consume a second slot).
//   - UNKNOWN FALLBACK: an empty/absent name, and the UI's `unknown` placeholder for a
//     stream it cannot attribute, get one neutral tone (`slot: -1`) and CONSUME
//     NOTHING, so "we do not know who this is" never looks like an identity and never
//     steals a slot from a real agent (turns.ts paints the tile and its section from
//     the SAME call, so they can never disagree).
//
// Why the previous deterministic hash + pinned built-in table is gone: the hash made
// the mapping look like a fact about the agent (and the review needed an explicit
// table to stop roster collisions). The user instead wants the palette treated as an
// anonymous set of slots the UI hands out, so identity separation is guaranteed by
// "distinct until exhausted" rather than by a hand-tuned table — with 8 palette slots
// and 8 built-in profiles, the whole roster still gets eight different tones.
//
// Cross-references:
//   - src/agents/index.ts `AGENT_PROFILE_NAMES` — the roster; ui/agent-color.test.ts
//     asserts it never outgrows the palette (read-only here: the browser bundle must
//     not import server profiles);
//   - src/frontend/styles.css `:root` — the same fallback values as CSS defaults, so an
//     unpublished block (painted before any event names an agent) reads neutral rather
//     than borrowing a random slot;
//   - src/frontend/ui/turns.ts `createSection` / `createThread` / `rootSection`;
//   - src/frontend/ui/agent-control.ts / ui/agent-dialog.ts (R4 surfaces).

// One palette tone. `slot` is the palette index (0..N-1, or -1 for the fallback):
// tests assert slot relationships (same agent ⇒ same slot, different agents ⇒
// different slots), while the CSS only ever sees `color`/`line`.
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

// The palette, in slot order. Eight distinct hues for a dark UI. Deliberately avoids
// the STATE colours green (streaming) and red (error), because the outline must be
// readable ACROSS states: a green outline on a green streaming border would read as
// one state, not an identity. Slot 7 (gold) is the one tone that sits near `--warn`
// (waiting/pending text); it is a thin outline + small name label, never a state fill.
//
// The ORDER is only an index space — R4 hands the slots out in a shuffled order, so
// nothing here encodes "which agent gets which hue" any more.
//
// Exported because the surface tests must be able to say "the colour this badge paints
// is one of the palette entries" without re-typing the hexes (and so a palette edit is
// visible to them).
export const AGENT_PALETTE: readonly AgentColor[] = [
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

// Canonical agent identity: trimmed and lower-cased. Exported so a caller can compare
// two spellings without duplicating the rule — and because it is the key the slot
// assignment is stored under, which is what makes one agent's colour identical on
// every surface no matter which component asked first.
export const agentKeyOf = (agent: string | undefined): string => (agent ?? '').trim().toLowerCase();

// Fisher-Yates over the slot indexes, so the result is a uniformly shuffled
// PERMUTATION of 0..N-1 (never a repeated or missing slot). `random` is injectable for
// tests; production uses `Math.random`.
//
// `floor(random() * (index + 1))` is the standard unbiased draw while `random()` is in
// [0, 1). The clamp only defends against a caller-supplied source that returns exactly
// 1 (a hand-written stub), which would otherwise read `slots[length]` — an `undefined`
// slot would paint nothing at all.
const shuffledSlots = (random: () => number): number[] => {
    const slots = AGENT_PALETTE.map((tone) => tone.slot);

    for (let index = slots.length - 1; index > 0; index -= 1) {
        const draw = Math.floor(random() * (index + 1));
        const swap = Math.min(index, Math.max(0, draw));

        const held = slots[index] as number;
        slots[index] = slots[swap] as number;
        slots[swap] = held;
    }

    return slots;
};

// The page's assignment, module-scoped: created once at import, so every component in
// the bundle shares it and ONE identity owns exactly ONE tone for this page.
//
// `slotOrder` is the shuffled permutation; `nextSlot` counts how many identities have
// been served. Keying by canonical id (not by first-seen order of DOM nodes) is what
// keeps the composer, the dialog and the transcript in step.
let slotOrder: number[] = shuffledSlots(Math.random);
let nextSlot = 0;
const assignments = new Map<string, number>();

// Re-draw the palette order and forget every assignment. Production calls this never
// (the shuffle at module load IS the "random once per page" the user asked for); it
// exists so a test can pin a seeded source of randomness — or clear the map between
// cases — instead of depending on which hue `Math.random` happened to hand out.
export const reseedAgentColors = (random: () => number = Math.random): void => {
    assignments.clear();
    nextSlot = 0;
    slotOrder = shuffledSlots(random);
};

// Resolve one agent name to its tone. Total (no throw) and idempotent: the first call
// for a canonical key draws the slot, every later call for that key — from any
// component, at any time — reads back the SAME tone.
export const agentColorOf = (agent: string | undefined): AgentColor => {
    const key = agentKeyOf(agent);

    // Unnamed, or the UI's own placeholder: never assigned a slot. An unknown agent
    // must not read as (say) the primary's tone and look like a real identity, and it
    // must not burn one of the eight slots a real agent still needs.
    if (key.length === 0 || key === UNNAMED_AGENT_PLACEHOLDER) return UNKNOWN_AGENT_COLOR;

    const drawn = assignments.get(key);
    if (drawn !== undefined) return AGENT_PALETTE[drawn] as AgentColor;

    // A new identity takes the next slot of this page's shuffled permutation. The
    // permutation is unique for the first `PALETTE.length` identities, so distinct
    // agents get distinct tones until the palette is exhausted; past that the cycle
    // repeats and the least-recently-handed-out tone is shared.
    const slot = slotOrder[nextSlot % slotOrder.length] as number;
    nextSlot += 1;
    assignments.set(key, slot);

    return AGENT_PALETTE[slot] as AgentColor;
};

// Paint an agent-owned surface. Sets the two CSS custom properties styles.css consumes
// and mirrors the canonical name on `data-agent` (which ui/activity.ts `paintActivity`
// also selects on, so the ring and the identity always sit on the same host). An
// UNNAMED name (empty, blank or the `unknown` placeholder) CLEARS `data-agent` instead
// of writing `''`/`unknown`, so every block agrees on the same neutral semantics and a
// `[data-agent]` selector only ever matches a real identity.
//
// Custom properties inherit, so painting a WRAPPER (`.agent-control`, a roster badge)
// colours every label inside it without painting each child.
export const paintAgentColor = (element: HTMLElement, agent: string | undefined): AgentColor => {
    const tone = agentColorOf(agent);
    element.style.setProperty('--agent-color', tone.color);
    element.style.setProperty('--agent-line', tone.line);

    const name = (agent ?? '').trim();
    if (name.length > 0 && agentKeyOf(name) !== UNNAMED_AGENT_PLACEHOLDER) element.dataset.agent = name;
    else delete element.dataset.agent;

    return tone;
};
