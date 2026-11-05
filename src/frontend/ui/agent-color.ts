// Agent identity colour, resolved by one shared helper for the whole UI (T5/R1/R3/R4).
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
// CONTRACT (R1: stable across reload · R3: automatic palette fallback · explicit override)
// ---------------------------------------------------------------------------------------
//   - STABLE ACROSS RELOAD (R1): the slot is DERIVED from the canonical agent key by a
//     deterministic hash, not drawn per page. The reader learns the team by colour, so
//     "what colour is Researcher" must be the same answer on every page load; the old
//     per-page shuffle made that answer change on refresh, which is what this module no
//     longer does.
//   - DISTINCT WHILE THE PALETTE LASTS: the hashed slot is probed FORWARD to the first
//     slot nobody owns yet, so the first `PALETTE.length` identities get pairwise
//     different tones with no hand-tuned table. Once the palette is exhausted a new
//     identity reuses its OWN hashed slot — a stable repeat, never a tone that drifts as
//     other agents are discovered.
//   - ONE IDENTITY, ONE SLOT: the slot is keyed by the canonical id, so the same agent
//     keeps the SAME tone for the whole page lifetime — across re-renders, a chrome
//     rebuild, a re-opened dialog and every surface at once. An already-assigned key
//     never re-probes, so a re-render cannot flicker a colour the reader is using.
//   - CONFIGURABLE: `configureAgentColors({ roster, colors })` is called when the roster
//     becomes known. `roster` pins the slots in ROSTER ORDER (so the mapping is a fact
//     about the team, not about which DOM node painted first); `colors` replaces an
//     identity's DISPLAY colour with an explicit hex. Both calls are incremental, so a
//     boot roster followed by a live session roster adds agents without moving the ones
//     already learned. ./main.ts pairs each of its calls with `resetAgentColors()` when the
//     ACTIVE view changes, which is the one case where "incremental" would be wrong (a hex
//     configured by the harness the reader just left must stop painting).
//   - EXPLICIT NEVER DISTURBS AUTOMATIC (R3): an explicit colour consumes no slot and
//     changes no other agent's slot. Every roster key still takes its deterministic
//     auto slot, so auto assignments are independent of which agents happen to be
//     configured.
//   - CASE/SPACE INSENSITIVE: `"Writer"`, `"writer"` and `" writer "` are the same
//     agent (the server treats names as ids, and a stray space must not mint a second
//     colour, nor consume a second slot).
//   - UNKNOWN FALLBACK: an empty/absent name, and the UI's `unknown` placeholder for a
//     stream it cannot attribute, get one neutral tone (`slot: -1`) and CONSUME
//     NOTHING, so "we do not know who this is" never looks like an identity and never
//     steals a slot from a real agent (turns.ts paints the tile and its section from the
//     SAME call, so they can never disagree).
//   - TOTAL, NO THROW: a malformed explicit colour (a name, `rgb(...)`, garbage off the
//     wire) is ignored and the agent falls back to the automatic palette tone.
//
// Why the per-page shuffle is gone: randomness hid the fact that the mapping is a
// function of identity, and the reload reset it. A hash restores the reload-stability
// for free (no persistence, no backend colour field — the schema still has none), while
// the forward probe keeps the property the shuffle was bought for: distinct tones for
// the first eight identities without anyone maintaining a table. With 8 palette slots
// and 8 built-in profiles, the whole roster still gets eight different tones.
//
// Cross-references:
//   - src/agents/index.ts `AGENT_PROFILE_NAMES` — the roster; ui/agent-color.test.ts
//     asserts it never outgrows the palette (read-only here: the browser bundle must
//     not import server profiles);
//   - src/frontend/main.ts — the PRODUCTION caller, wired in T4: `configureBaselineAgentColors`
//     seeds the boot roster the app booted with, and `configureAgentColorsFor` re-derives the
//     mapping for the ACTIVE view (that roster plus the team, and the `agent_colors` map the
//     server exposes) before any surface paints. The wiring lives outside this module, so
//     nothing here imports it;
//   - src/frontend/styles.css `:root` — the same fallback values as CSS defaults, so an
//     unpublished block (painted before any event names an agent) reads neutral rather
//     than borrowing a real agent's slot;
//   - src/frontend/ui/turns.ts `createSection` / `createThread` / `rootSection`;
//   - src/frontend/ui/agent-control.ts / ui/agent-dialog.ts (R4 surfaces).

// One palette tone. `slot` is the palette index (0..N-1, or -1 for the fallback and for
// an explicit colour outside the palette): tests assert slot relationships (same agent ⇒
// same slot, different agents ⇒ different slots), while the CSS only ever sees
// `color`/`line`.
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
// The ORDER is the slot space the deterministic probe walks: `slot` is an index derived
// from the agent key, so changing this array's order re-derives every automatic mapping
// (an explicit colour is unaffected, which is the point of keeping the two separate).
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

// Canonical agent identity: trimmed and lower-cased. Exported because it is BOTH the
// comparison rule a caller can reuse and the key the slot assignment and the explicit
// colour map are stored under — which is what makes one agent's colour identical on
// every surface, however its name is spelled in the event that named it.
export const agentKeyOf = (agent: string | undefined): string => (agent ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- explicit colours ----

// The four CSS "hash hex" bodies: 3/4 shorthand and 6/8 full digits. The 4/8-digit forms
// carry an alpha channel, which is accepted but ignored (see `parseHexColor`). Anything
// else — a CSS name (`red`), `rgb(...)`, `transparent`, an empty string — is "no colour".
const HEX_BODY = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

// Outline alpha for an explicit colour: the palette's own alpha, so a user-configured
// identity frames its block with exactly the same weight as an automatic one.
const EXPLICIT_LINE_ALPHA = 0.6;

// A parsed hash-hex colour: canonical lower-case `#rrggbb` plus its channels.
type RgbColor = { hex: string; red: number; green: number; blue: number };

// Parse one hex value. Returns undefined instead of throwing for anything that is not a
// hash hex, because both sources of these strings are outside our control (a config file
// the user edits, a colour field that arrives over the wire) and a bad value must cost a
// reader nothing more than the automatic tone.
const parseHexColor = (value: string): RgbColor | undefined => {
    // Trimmed: config hexes pick up trailing spaces from editors, and CSS itself ignores
    // whitespace around a declaration value.
    const text = value.trim();
    if (text.length === 0 || text.charAt(0) !== '#') return undefined;

    const digits = text.slice(1).toLowerCase();
    if (!HEX_BODY.test(digits)) return undefined;

    let rgb: string;
    if (digits.length === 3 || digits.length === 4) {
        // Shorthand expands by DOUBLING each nibble, exactly like CSS: `#f0a` is
        // `#ff00aa`, not `#f000a0`. The 4-digit form's extra nibble is alpha, dropped.
        rgb = '';
        for (let index = 0; index < 3; index += 1) rgb += digits.charAt(index).repeat(2);
    } else if (digits.length === 6 || digits.length === 8) {
        // Likewise the 8-digit form's trailing alpha is dropped: `line` fixes its own
        // alpha at 0.6, so an explicit identity can never configure an INVISIBLE outline.
        rgb = digits.slice(0, 6);
    } else {
        return undefined;
    }

    return {
        hex: `#${rgb}`,
        red: Number.parseInt(rgb.slice(0, 2), 16),
        green: Number.parseInt(rgb.slice(2, 4), 16),
        blue: Number.parseInt(rgb.slice(4, 6), 16)
    };
};

// Canonical `#rrggbb` → palette slot, so an explicit colour that happens to BE a palette
// tone reports the slot it matches instead of `-1`. Built once from the palette; the
// values are already canonical, so this only normalises case/spacing defensively.
const PALETTE_HEX_SLOTS = new Map<string, number>();
for (const tone of AGENT_PALETTE) {
    const rgb = parseHexColor(tone.color);
    if (rgb && !PALETTE_HEX_SLOTS.has(rgb.hex)) PALETTE_HEX_SLOTS.set(rgb.hex, tone.slot);
}

// The tone for an explicit hex, or undefined when the value is unusable.
//
// `color` is the caller's own string (trimmed), NOT a re-cased copy: what the user
// configured is what the CSS gets. `line` is derived from the same channels, and `slot`
// is a read-out for tests — the palette tone this hex equals, or -1 — never a claim on
// the slot pool (see `assignSlot`: an explicit colour must not push an automatic agent
// off a hue it already owns).
const explicitToneOf = (value: string): AgentColor | undefined => {
    const rgb = parseHexColor(value);
    if (!rgb) return undefined;

    return {
        slot: PALETTE_HEX_SLOTS.get(rgb.hex) ?? -1,
        color: value.trim(),
        line: `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${EXPLICIT_LINE_ALPHA})`
    };
};

// ------------------------------------------------------------------- slot assignment ---

// FNV-1a, 32-bit. Chosen because it is dependency-free, one line per character, and
// frozen by specification: the same key hashes to the same integer in every run, browser
// and Node version. That is precisely the property R1 needs — the mapping survives a
// reload (and a server restart) without persisting anything.
const hashKey = (key: string): number => {
    let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis

    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        // `imul` keeps the multiply inside 32 bits (a plain `*` would lose low bits to
        // float rounding past 2^53 on long keys).
        hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
    }

    // Unsigned view of the accumulated bits, so `%` below can never go negative.
    return hash >>> 0;
};

const PALETTE_SIZE = AGENT_PALETTE.length;

// The page's assignment, module-scoped: created once at import, so every component in
// the bundle shares it and ONE identity owns exactly ONE tone.
//
//   - `assignments` canonical key → slot (the cache that makes re-reads idempotent);
//   - `usedSlots`   the slots `assignments` owns, so the probe can find a free one
//                   without scanning the map on every miss (kept in sync by `assignSlot`
//                   and `resetAgentColors` only);
//   - `explicitColors` canonical key → display colour configured by the user, validated
//                   lazily at read time so a malformed entry degrades to the auto tone.
const assignments = new Map<string, number>();
const usedSlots = new Set<number>();
const explicitColors = new Map<string, string>();

// Deterministic slot for a canonical key, mutating nothing when the key already owns one.
//
// Algorithm (pure — no clock, no `Math.random`, no discovery order other than the roster
// order the caller supplies):
//   1. `preferred = hash(key) % PALETTE_SIZE`;
//   2. probe `preferred, preferred + 1, …` modulo N and take the first slot no assigned
//      key owns — the first N identities therefore always land on distinct tones;
//   3. if the palette is exhausted, reuse `preferred`. The 9th agent shares a tone
//      FOREVER (and the tone is a fact about the 9th agent alone), instead of the
//      least-recently-handed-out slot moving every time a new identity appears.
const assignSlot = (key: string): number => {
    const owned = assignments.get(key);
    if (owned !== undefined) return owned;

    const preferred = hashKey(key) % PALETTE_SIZE;

    for (let offset = 0; offset < PALETTE_SIZE; offset += 1) {
        const candidate = (preferred + offset) % PALETTE_SIZE;
        if (usedSlots.has(candidate)) continue;

        usedSlots.add(candidate);
        assignments.set(key, candidate);
        return candidate;
    }

    assignments.set(key, preferred);
    return preferred;
};

// An entry that names no identity (blank, or the `unknown` placeholder) owns neither a
// slot nor a colour: it is a sentinel, and letting it take either would make "we do not
// know" displace a real agent.
const isIdentityKey = (key: string): boolean => key.length > 0 && key !== UNNAMED_AGENT_PLACEHOLDER;

// Teach the UI who the team is and (optionally) which colour each identity must wear.
//
// Production calls this as soon as the roster is known — once with the boot roster from
// the served configuration, then once per ACTIVE view (its team plus the colours that view
// configures). The call itself is always INCREMENTAL, and that is the contract a caller has
// to reason about:
//   - `roster`: every name that does not already own a slot takes one, in roster order,
//     so the mapping is a fact about the team rather than about which component painted
//     first. Names that already own a slot keep it, so the roster growing mid-session
//     never recolours a block the reader is looking at.
//   - `colors`: explicit display colours keyed by agent name (matched through the same
//     canonical key as the slots). Merged rather than replaced: a later call refines or
//     adds entries, and an entry the caller drops keeps its colour until
//     `resetAgentColors` — so a partial session payload cannot silently un-learn a
//     colour the user configured at boot.
//
// A caller that needs a map to be EXACT rather than additive (./main.ts, on a session or
// harness switch) resets first and then configures once with the whole roster and the whole
// map; growth within one view still lands incrementally, because that reset happens only
// when the view changes.
//
// Total and non-throwing: a non-string colour value is skipped, and an invalid hex is
// kept but degrades to the automatic tone at read time.
export const configureAgentColors = (options: {
    roster?: readonly string[];
    colors?: Readonly<Record<string, string>>;
}): void => {
    const colors = options.colors;
    if (colors) {
        for (const name of Object.keys(colors)) {
            const key = agentKeyOf(name);
            if (!isIdentityKey(key)) continue;

            // `Record<string, string>` says it is a string; the payload behind it comes
            // from JSON, so a null/undefined/number is possible and simply means "no
            // explicit colour for this agent".
            const value = colors[name];
            if (typeof value !== 'string') continue;

            explicitColors.set(key, value);
        }
    }

    for (const agent of options.roster ?? []) {
        const key = agentKeyOf(agent);
        if (!isIdentityKey(key)) continue;

        assignSlot(key);
    }
};

// Forget every slot and explicit colour. Production calls this too, and only in ONE
// place: ./main.ts `configureAgentColorsFor`, which re-derives the mapping whenever the
// ACTIVE view changes (a session open or switch, a harness re-selection, a definition read
// that revealed explicit colours). Without it `configureAgentColors` would only ever MERGE
// colours — the right rule for a partial payload, the wrong one for a conversation switch,
// where a hex the previous harness configured has to stop painting.
//
// Reset-then-configure is still deterministic: the tones come from `roster` order plus the
// hash/probe, with no clock and no `Math.random`, so the same view on a fresh page produces
// the same vector (R1). Tests use the same call to simulate a reload and to keep cases from
// leaking assignments into each other.
export const resetAgentColors = (): void => {
    assignments.clear();
    usedSlots.clear();
    explicitColors.clear();
};

// Resolve one agent name to its tone. Total (no throw) and idempotent: every call for a
// canonical key — from any component, at any time, before or after a reload — reads back
// the SAME tone.
//
// `explicitColor` is the per-call override for this agent (the colour the backend/roster
// payload carries for it). Resolution order, and why:
//   1. no identity at all → the neutral fallback, and NOTHING is consumed;
//   2. an explicit hex → that colour, with no slot touched. The ARGUMENT wins over the
//      configured map, and it wins even when it is unusable, so a value the caller
//      supplied deliberately cannot be replaced by an older configured one;
//   3. otherwise → the configured map's hex if valid, else the deterministic auto slot.
export const agentColorOf = (agent: string | undefined, explicitColor?: string): AgentColor => {
    const key = agentKeyOf(agent);

    // Unnamed, or the UI's own placeholder: never assigned a slot. An unknown agent must
    // not read as (say) the primary's tone and look like a real identity, and it must not
    // burn one of the eight slots a real agent still needs.
    if (!isIdentityKey(key)) return UNKNOWN_AGENT_COLOR;

    const supplied = (explicitColor ?? '').trim();
    const requested = supplied.length > 0 ? supplied : (explicitColors.get(key) ?? '').trim();

    if (requested.length > 0) {
        const explicit = explicitToneOf(requested);
        // A malformed hex falls through to the palette rather than painting `undefined`
        // into a custom property (which would drop the block back to the CSS default).
        if (explicit) return explicit;
    }

    return AGENT_PALETTE[assignSlot(key)] as AgentColor;
};

// Paint an agent-owned surface. Sets the two CSS custom properties styles.css consumes
// and mirrors the canonical name on `data-agent` (which ui/activity.ts `paintActivity`
// also selects on, so the ring and the identity always sit on the same host). An
// UNNAMED name (empty, blank or the `unknown` placeholder) CLEARS `data-agent` instead
// of writing `''`/`unknown`, so every block agrees on the same neutral semantics and a
// `[data-agent]` selector only ever matches a real identity.
//
// `explicitColor` is forwarded to `agentColorOf` unchanged; callers that have a colour
// for this agent (a roster payload) pass it here so every surface resolves it once,
// through the same oracle the tests use.
//
// Custom properties inherit, so painting a WRAPPER (`.agent-control`, a roster badge)
// colours every label inside it without painting each child.
export const paintAgentColor = (
    element: HTMLElement,
    agent: string | undefined,
    explicitColor?: string
): AgentColor => {
    const tone = agentColorOf(agent, explicitColor);
    element.style.setProperty('--agent-color', tone.color);
    element.style.setProperty('--agent-line', tone.line);

    const name = (agent ?? '').trim();
    if (name.length > 0 && agentKeyOf(name) !== UNNAMED_AGENT_PLACEHOLDER) element.dataset.agent = name;
    else delete element.dataset.agent;

    return tone;
};
