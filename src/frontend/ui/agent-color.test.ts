// Agent identity colour — the R1/R3 assignment contract (T5).
//
// What changed: the palette slot an agent gets is no longer DRAWN per page (the old
// shuffle), it is DERIVED from the canonical agent key. Two requirements drive that:
//
//   - R1 STABLE ACROSS RELOAD: the reader learns the team by colour, so refreshing the
//     page must not make them re-learn it. The mapping is a pure function of the key plus
//     the roster order, so it survives a reload (and a server restart) with nothing
//     persisted and no colour field in the schema.
//   - R3 AUTOMATIC PALETTE FALLBACK: an agent nobody configured still gets a palette
//     tone, and configuring ONE agent's colour must never recolour the others.
//
// What still has to hold, and what this file owns:
//   - DISTINCT UNTIL EXHAUSTED: the hashed slot is probed FORWARD to a free slot, so the
//     first `PALETTE.length` identities get pairwise different tones;
//   - A STABLE REPEAT PAST THAT: the 9th identity reuses its own hashed slot, so a tone
//     never drifts when some other agent shows up;
//   - ONE IDENTITY, ONE SLOT: `Writer` / `writer` / ` writer ` are one agent and must not
//     mint a second colour or burn a second slot;
//   - NO FLICKER: one canonical id maps to one tone for the whole page lifetime, so no
//     re-render, chrome rebuild or dialog re-open recolours a block mid-read;
//   - INCREMENTAL CONFIGURE: a boot roster followed by a live session roster adds agents
//     without moving the tones already learned;
//   - UNKNOWN COSTS NOTHING: an empty/absent name and the `unknown` placeholder get the
//     neutral fallback (`slot: -1`) and consume neither a slot nor a colour;
//   - EXPLICIT WINS: a configured / per-call hex is painted instead, its outline is
//     derived from the same channels, an unusable value falls back to the palette, and
//     the slot pool is untouched by any of it.
//
// Every expectation below is an EXACT value. The slot vectors are what the documented
// algorithm produces (FNV-1a 32-bit `hash % 8`, then a forward probe for a free slot);
// they were captured once and hardcoded, so a hash edit, a palette edit or a probe edit
// lands here as a deliberate diff rather than a silent recolour. The palette hexes stay
// hardcoded too: they are what a user learns.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-color.test.ts

import type { AgentColor } from './agent-color';
import { AGENT_PROFILE_NAMES } from '../../agents';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_PALETTE,
    UNNAMED_AGENT_PLACEHOLDER,
    UNKNOWN_AGENT_COLOR,
    agentColorOf,
    agentKeyOf,
    configureAgentColors,
    paintAgentColor,
    resetAgentColors
} from './agent-color';

// The eight tones, in slot order (ui/agent-color.ts `AGENT_PALETTE`). A copy, so a
// palette edit has to be a deliberate test edit, and so a slot vector can be read as the
// colour the reader actually sees.
const PALETTE = [
    { slot: 0, color: '#7aa2ff', line: 'rgba(122, 162, 255, 0.6)' },
    { slot: 1, color: '#22d3ee', line: 'rgba(34, 211, 238, 0.6)' },
    { slot: 2, color: '#a78bfa', line: 'rgba(167, 139, 250, 0.6)' },
    { slot: 3, color: '#f472b6', line: 'rgba(244, 114, 182, 0.6)' },
    { slot: 4, color: '#fb923c', line: 'rgba(251, 146, 60, 0.6)' },
    { slot: 5, color: '#2dd4bf', line: 'rgba(45, 212, 191, 0.6)' },
    { slot: 6, color: '#e879f9', line: 'rgba(232, 121, 249, 0.6)' },
    { slot: 7, color: '#facc15', line: 'rgba(250, 204, 21, 0.6)' }
];

// The roster the harness ships (src/agents/index.ts `AGENT_PROFILE_NAMES`), in roster
// order — the order `configureAgentColors` resolves collisions in.
const ROSTER = ['instruct', 'research', 'workspace', 'reviewer', 'planner', 'summarizer', 'demo', 'flaky'];

// The slots that roster lands on: three of its keys hash onto an already-owned slot
// (`planner`, `demo`, `flaky`) and walk forward, which is why the vector is not simply
// the raw hash residues [3,4,6,2,3,0,6,6].
const ROSTER_SLOTS = [3, 4, 6, 2, 5, 0, 7, 1];

// Eight throwaway identities `a`..`h`: none of them collides, so their slots are exactly
// their hash residues — the smallest vector that pins the hash itself.
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const LETTER_SLOTS = [4, 5, 2, 3, 0, 1, 6, 7];

// A colliding pair: both `aa` and `ee` hash to slot 7, so the probe has to be visible.
const COLLIDERS = ['aa', 'ee'];

// Two more identities that only appear once the palette is exhausted, so their slots are
// their (already-owned) hash residues reused: `i`→4, `j`→5, `k`→2, `l`→3, `m`→0.
const EXHAUSTED_SLOTS = [4, 5];

// An explicit colour outside the palette, and the outline the module must derive from it.
const CUSTOM_HEX = '#ff6600';
const CUSTOM_TONE: AgentColor = { slot: -1, color: CUSTOM_HEX, line: 'rgba(255, 102, 0, 0.6)' };

const slotsOf = (agents: readonly (string | undefined)[]): number[] => agents.map((agent) => agentColorOf(agent).slot);
const tonesOf = (agents: readonly string[]): AgentColor[] => agents.map((agent) => agentColorOf(agent));
const toneAt = (slot: number): AgentColor => PALETTE[slot] as AgentColor;

// The assignment lives in module state for the lifetime of the "page", so every case
// starts from an empty page: otherwise a previous case's slots would leak into this
// one's vector.
beforeEach(() => {
    resetAgentColors();
});

describe('deterministic assignment (R1: stable across reload)', () => {
    it('derives the exact slot for every key, with no draw involved', () => {
        configureAgentColors({ roster: LETTERS });

        expect(slotsOf(LETTERS)).toEqual(LETTER_SLOTS);
        expect(tonesOf(LETTERS)).toEqual(LETTER_SLOTS.map(toneAt));

        // One tone end to end, spelled out: `a` is slot 4 ⇒ the palette's orange, with
        // the outline that belongs to that same slot.
        expect(agentColorOf('a')).toEqual({ slot: 4, color: '#fb923c', line: 'rgba(251, 146, 60, 0.6)' });
    });

    it('repeats the identical tones after a reload (reset + the same roster)', () => {
        configureAgentColors({ roster: ROSTER });
        const before = tonesOf(ROSTER);
        expect(slotsOf(ROSTER)).toEqual(ROSTER_SLOTS);

        // A reload forgets the map but not the rule: the same roster produces the same
        // eight tones, in the same order. This is the R1 requirement — the old shuffle
        // failed exactly here.
        resetAgentColors();
        configureAgentColors({ roster: ROSTER });
        expect(tonesOf(ROSTER)).toEqual(before);

        // 25 more simulated reloads, with the real (unstubbed) `Math.random` available:
        // not one of them may vary the vector.
        for (let run = 0; run < 25; run += 1) {
            resetAgentColors();
            configureAgentColors({ roster: ROSTER });
            expect(tonesOf(ROSTER)).toEqual(before);
        }

        // The roster is not what makes a tone a fact about an identity either: reading
        // the same names with an empty map re-derives the same vector.
        resetAgentColors();
        expect(slotsOf(ROSTER)).toEqual(ROSTER_SLOTS);
    });

    it('answers the same whatever order the surfaces ask in', () => {
        configureAgentColors({ roster: ROSTER });

        // The composer may ask before the transcript, or after the dialog: only the
        // roster order decides a collision, never which component painted first.
        expect(slotsOf([...ROSTER].reverse())).toEqual([...ROSTER_SLOTS].reverse());
    });

    it('never touches the source of randomness', () => {
        // The old contract shuffled the palette at module load with `Math.random`. R1
        // forbids that, so this stub counts draws instead of tolerating them: a single
        // draw is a regression, and the vectors must be the documented ones regardless.
        const original = Math.random;
        let draws = 0;

        try {
            Math.random = (): number => {
                draws += 1;
                return 0.5;
            };

            configureAgentColors({ roster: ROSTER });
            expect(slotsOf(ROSTER)).toEqual(ROSTER_SLOTS);

            resetAgentColors();
            configureAgentColors({ roster: LETTERS });
            expect(slotsOf(LETTERS)).toEqual(LETTER_SLOTS);

            expect(draws).toBe(0);
        } finally {
            Math.random = original;
        }
    });

    it('probes forward on a collision so two agents never share a tone while one is free', () => {
        // `aa` and `ee` both hash to preferred slot 7 ⇒ the second one walks to 0.
        configureAgentColors({ roster: COLLIDERS });
        expect(slotsOf(COLLIDERS)).toEqual([7, 0]);

        // A different roster ORDER puts the pair the other way round — deterministically,
        // i.e. the same way on every reload, which is what the per-page draw could not do.
        resetAgentColors();
        configureAgentColors({ roster: [...COLLIDERS].reverse() });
        expect(slotsOf(COLLIDERS)).toEqual([0, 7]);
    });

    it('reuses the hashed slot (not a drifting one) once the palette is exhausted', () => {
        configureAgentColors({ roster: LETTERS });
        expect(new Set(slotsOf(LETTERS)).size).toBe(8);

        // Identity 9 and 10: all eight slots are owned, so each keeps its OWN preferred
        // slot — `i` shares `a`'s orange, `j` shares `b`'s cyan.
        expect(slotsOf(['i', 'j'])).toEqual(EXHAUSTED_SLOTS);
        expect(agentColorOf('i')).toEqual(toneAt(LETTER_SLOTS[0] as number));
        expect(agentColorOf('j')).toEqual(toneAt(LETTER_SLOTS[1] as number));

        // The repeat is a fact about the key: it must not slide when MORE identities show
        // up afterwards (the old permutation re-cycled whatever position came next).
        expect(slotsOf(['k', 'l', 'm'])).toEqual([2, 3, 0]);
        expect(slotsOf(['i', 'j'])).toEqual(EXHAUSTED_SLOTS);

        // Even the pair that once PROBED to stay apart (`aa` 7, `ee` 0 while slot 7 was
        // contested) now collapses onto each key's own preferred slot: with nothing free,
        // sharing is decided by the key, not by who arrived first.
        expect(slotsOf(COLLIDERS)).toEqual([7, 7]);
    });
});

describe('configureAgentColors (roster order + explicit colours)', () => {
    it('grows incrementally without moving a tone the reader already learned', () => {
        // Boot roster: two agents.
        configureAgentColors({ roster: ['instruct', 'research'] });
        expect(slotsOf(['instruct', 'research'])).toEqual([3, 4]);

        // Live session roster: the team grew, so `reviewer` takes a free slot while the
        // two tones already on screen stay exactly where they were.
        configureAgentColors({ roster: ['instruct', 'research', 'reviewer'] });
        expect(slotsOf(['instruct', 'research', 'reviewer'])).toEqual([3, 4, 2]);

        // One name at a time (the worst case of a chatty live roster) still lands on the
        // same vector as one full configure.
        resetAgentColors();
        for (const name of ROSTER) configureAgentColors({ roster: [name] });
        expect(slotsOf(ROSTER)).toEqual(ROSTER_SLOTS);
    });

    it('is idempotent: re-configuring the same roster changes nothing', () => {
        configureAgentColors({ roster: ROSTER });
        const first = tonesOf(ROSTER);

        configureAgentColors({ roster: ROSTER });
        configureAgentColors({ roster: ROSTER, colors: { ghost: CUSTOM_HEX } });
        configureAgentColors({});

        expect(tonesOf(ROSTER)).toEqual(first);
        expect(first.map((tone) => tone.slot)).toEqual(ROSTER_SLOTS);
    });

    it('ignores blank and placeholder roster entries so they consume no slot', () => {
        configureAgentColors({
            roster: ['', '   ', UNNAMED_AGENT_PLACEHOLDER, ' UNKNOWN ', ...LETTERS]
        });

        // Five non-identities came first and burned nothing: the eight real keys still
        // land on the same slots they would have alone.
        expect(slotsOf(LETTERS)).toEqual(LETTER_SLOTS);
        expect(agentColorOf('unknown')).toBe(UNKNOWN_AGENT_COLOR);
    });

    it('reads a roster name through the canonical key', () => {
        configureAgentColors({ roster: [' Writer '] });

        expect(agentKeyOf(' Writer ')).toBe('writer');

        // One roster entry, four spellings: one slot (the one `writer` hashes to).
        expect(slotsOf(['writer', 'WRITER', '\tWriter\n', ' Writer '])).toEqual([2, 2, 2, 2]);

        // And the padded entry consumed exactly one slot: the next distinct identity
        // still lands on its own hashed slot instead of a probe-shifted one.
        configureAgentColors({ roster: [' Writer ', ' Helper '] });
        expect(slotsOf([' Helper '])).toEqual([5]);
    });

    it('never lets an explicit colour move an automatic slot (R3)', () => {
        // Two agents configured away from their palette tones: nobody else is displaced,
        // because an explicit colour never claims a slot. (`a`/`b` are excluded from the
        // vector: their reported slot is the colour's own read-out, not an auto slot.)
        configureAgentColors({ roster: LETTERS, colors: { a: CUSTOM_HEX, b: '#00ff00' } });
        expect(slotsOf(LETTERS.slice(2))).toEqual(LETTER_SLOTS.slice(2));

        // A roster key that IS configured still takes its deterministic auto slot, and
        // that slot really is held: `ba` hashes to the same preferred slot as `a` (4), so
        // it is pushed to 5 only because `a` owns 4 — colour or no colour.
        resetAgentColors();
        configureAgentColors({ roster: ['a'], colors: { a: CUSTOM_HEX } });
        expect(agentColorOf('a')).toEqual(CUSTOM_TONE);

        configureAgentColors({ roster: ['ba'] });
        expect(agentColorOf('ba')).toEqual(toneAt(5));

        // The same probe with no colour involved at all, to show the two vectors agree.
        resetAgentColors();
        configureAgentColors({ roster: ['a', 'ba'] });
        expect(slotsOf(['a', 'ba'])).toEqual([4, 5]);

        // Colours for names that are on no roster consume nothing either, and a
        // blank/`unknown` colour key is ignored outright.
        resetAgentColors();
        configureAgentColors({
            colors: { ghost: '#ff0000', specter: 'rebeccapurple', unknown: '#00ff00', '': '#000000' }
        });
        expect(slotsOf(LETTERS)).toEqual(LETTER_SLOTS);
    });
});

describe('explicit colour override', () => {
    it('paints the configured hex and derives its outline from the same channels', () => {
        configureAgentColors({
            roster: [],
            colors: {
                writer: CUSTOM_HEX,
                helper: ' #22d3ee ',
                short: '#f0a',
                alpha: '#11223380',
                upper: '#A78BFA'
            }
        });

        // A colour outside the palette: `slot: -1`, the user's own string, and the
        // outline at the palette's alpha so an explicit identity frames its block with
        // the same weight as an automatic one.
        expect(agentColorOf('writer')).toEqual(CUSTOM_TONE);

        // A configured colour that IS a palette tone reports that slot (a read-out only —
        // it still claims nothing). The value is trimmed, not re-cased.
        expect(agentColorOf('helper')).toEqual({ slot: 1, color: '#22d3ee', line: 'rgba(34, 211, 238, 0.6)' });

        // Shorthand expands the way CSS does (`#f0a` ⇒ 255,0,170), and the 4th/8th digit
        // (alpha) is dropped: an explicit identity can never configure an invisible frame.
        expect(agentColorOf('short')).toEqual({ slot: -1, color: '#f0a', line: 'rgba(255, 0, 170, 0.6)' });
        expect(agentColorOf('alpha')).toEqual({ slot: -1, color: '#11223380', line: 'rgba(17, 34, 51, 0.6)' });

        // Case does not make a different colour, so the palette match still resolves.
        expect(agentColorOf('upper')).toEqual({ slot: 2, color: '#A78BFA', line: 'rgba(167, 139, 250, 0.6)' });
    });

    it('takes the per-call colour over the configured one, without overwriting it', () => {
        configureAgentColors({ roster: ['writer'], colors: { writer: CUSTOM_HEX } });

        expect(agentColorOf('writer', '#123456')).toEqual({
            slot: -1,
            color: '#123456',
            line: 'rgba(18, 52, 86, 0.6)'
        });

        // Same call without the argument: the configured colour is still in charge, so a
        // single override on one surface cannot un-learn the user's setting.
        expect(agentColorOf('writer')).toEqual(CUSTOM_TONE);
    });

    it('falls back to the deterministic palette for an unusable colour, and never throws', () => {
        configureAgentColors({ roster: ['writer'] });

        // `writer` owns slot 2; every unusable value has to land back on it.
        for (const unusable of [
            'red',
            'rgb(1, 2, 3)',
            'transparent',
            'currentcolour',
            '#12345',
            '#1234567',
            '##7aa2ff',
            '#7aa2fg',
            'not a colour',
            '',
            '   ',
            undefined
        ]) {
            expect(agentColorOf('writer', unusable)).toEqual(toneAt(2));
        }

        // The same defence on the configured side: a malformed entry degrades to the
        // automatic tone instead of painting `undefined` into the custom property.
        resetAgentColors();
        configureAgentColors({ roster: ['writer'], colors: { writer: 'rebeccapurple' } });
        expect(agentColorOf('writer')).toEqual(toneAt(2));

        // An unusable ARGUMENT also wins over the map ("the caller said what this is"),
        // so it cannot be replaced by an older configured colour: still the auto tone.
        expect(agentColorOf('writer', 'rebeccapurple')).toEqual(toneAt(2));
    });

    it('keeps the neutral fallback in charge of an unattributable block', () => {
        // No identity ⇒ no colour of its own, not even one that was supplied or
        // configured: "we do not know" must never start looking like an agent.
        expect(agentColorOf(undefined, CUSTOM_HEX)).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf('', CUSTOM_HEX)).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf('   ', CUSTOM_HEX)).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf(UNNAMED_AGENT_PLACEHOLDER, CUSTOM_HEX)).toBe(UNKNOWN_AGENT_COLOR);

        configureAgentColors({ colors: { unknown: CUSTOM_HEX } });
        expect(agentColorOf(' Unknown ')).toBe(UNKNOWN_AGENT_COLOR);
    });
});

describe('stability (no flicker on re-render)', () => {
    it('keeps one tone object for one agent across every request in the same page', () => {
        configureAgentColors({ roster: ['research'] });

        const first = agentColorOf('research');

        // A re-render, a chrome rebuild, a re-opened dialog, two invocations of one
        // agent: the same value every time — the same OBJECT, so a repaint writes the
        // identical string and the browser cannot even transition between two tones.
        expect(agentColorOf('research')).toBe(first);
        expect(agentColorOf(' Research ')).toBe(first);

        const node = document.createElement('div');
        expect(paintAgentColor(node, 'research')).toBe(first);
        const painted = node.style.getPropertyValue('--agent-color');
        expect(paintAgentColor(node, 'research').color).toBe(painted);
        expect(node.style.getPropertyValue('--agent-color')).toBe(painted);
    });

    it('normalises case and space into one identity that costs one slot', () => {
        configureAgentColors({ roster: ['writer', 'helper'] });

        expect(agentKeyOf(' Writer ')).toBe('writer');

        // One agent, four spellings: one tone, and it never re-probes.
        expect(agentColorOf('Writer')).toEqual(toneAt(2));
        expect(agentColorOf(' writer ')).toEqual(toneAt(2));
        expect(agentColorOf('WRITER')).toEqual(toneAt(2));
        expect(agentColorOf('\twriter\n')).toEqual(toneAt(2));

        // The padded spellings burned no extra slot, so the next DISTINCT identity still
        // lands on its own hashed slot rather than a probe-shifted one.
        expect(agentColorOf('Helper')).toEqual(toneAt(5));
    });

    it('agrees between surfaces because every surface reads the same key', () => {
        configureAgentColors({ roster: ['workspace'] });

        const tone = agentColorOf('workspace');

        // The composer, a dialog badge and a transcript tile all go through this one
        // function (ui/agent-control.ts, ui/agent-dialog.ts, ui/turns.ts), so the API
        // level of the cross-surface guarantee is: any call, any order, one answer.
        const nodes = [document.createElement('div'), document.createElement('span')];
        for (const node of nodes) paintAgentColor(node, ' Workspace ');

        expect(nodes.map((node) => node.style.getPropertyValue('--agent-color'))).toEqual([
            tone.color,
            tone.color
        ]);
        expect(nodes.map((node) => node.style.getPropertyValue('--agent-line'))).toEqual([tone.line, tone.line]);
    });
});

describe('palette shape', () => {
    it('publishes eight distinct tones and fits the real roster', () => {
        expect(AGENT_PALETTE).toEqual(PALETTE);
        expect(new Set(AGENT_PALETTE.map((tone) => tone.color)).size).toBe(8);
        expect(new Set(AGENT_PALETTE.map((tone) => tone.line)).size).toBe(8);

        // The roster the harness ships must still fit inside one palette, or two built-in
        // profiles would share a colour on every page. A new profile that overflows fails
        // here and says exactly what to widen.
        expect(AGENT_PROFILE_NAMES).toEqual(ROSTER);

        configureAgentColors({ roster: AGENT_PROFILE_NAMES });
        const tones = tonesOf(AGENT_PROFILE_NAMES);
        expect(tones.map((tone) => tone.slot)).toEqual(ROSTER_SLOTS);
        expect(new Set(tones.map((tone) => tone.color)).size).toBe(8);
        expect(tones.some((tone) => tone.slot === UNKNOWN_AGENT_COLOR.slot)).toBe(false);
    });
});

describe('unknown fallback', () => {
    it('resolves unnamed, blank and placeholder agents to one neutral tone', () => {
        expect(UNKNOWN_AGENT_COLOR).toEqual({
            slot: -1,
            color: '#8b94a7',
            line: 'rgba(139, 148, 167, 0.55)'
        });

        expect(agentColorOf(undefined)).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf('')).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf('   ')).toBe(UNKNOWN_AGENT_COLOR);

        // The UI's own placeholder for an unattributable stream is NOT an identity: it
        // resolves exactly like an empty name (the tile and its section agree).
        expect(UNNAMED_AGENT_PLACEHOLDER).toBe('unknown');
        expect(agentColorOf(UNNAMED_AGENT_PLACEHOLDER)).toBe(UNKNOWN_AGENT_COLOR);
        expect(agentColorOf(' Unknown ')).toBe(UNKNOWN_AGENT_COLOR);

        // The fallback is NOT a palette member: an unknown agent must never borrow a
        // derived slot and start looking like a real identity.
        expect(PALETTE).not.toContainEqual(UNKNOWN_AGENT_COLOR);
    });

    it('consumes no slot, so unknowns never push a real agent into a shared tone', () => {
        // Five unattributable blocks first — a reader with a lot of legacy frames must
        // still see eight distinct tones for their eight agents.
        for (const unknown of [undefined, '', '  ', 'unknown', ' UNKNOWN ']) agentColorOf(unknown);

        configureAgentColors({ roster: LETTERS });
        expect(slotsOf(LETTERS)).toEqual(LETTER_SLOTS);
        expect(agentColorOf(undefined)).toBe(UNKNOWN_AGENT_COLOR);
    });
});

describe('painting', () => {
    it('writes the two custom properties and mirrors the canonical name on data-agent', () => {
        configureAgentColors({ roster: ['helper', 'writer'] });

        const node = document.createElement('div');

        // `helper` is slot 5 ⇒ teal, and the outline is that same slot's rgba.
        expect(paintAgentColor(node, 'helper')).toEqual(toneAt(5));
        expect(node.style.getPropertyValue('--agent-color')).toBe('#2dd4bf');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(45, 212, 191, 0.6)');
        expect(node.dataset.agent).toBe('helper');

        // Repainting (an adopted placeholder, a re-parented entry, a different primary)
        // replaces the tone; it never layers a second value.
        expect(paintAgentColor(node, 'writer')).toEqual(toneAt(2));
        expect(node.style.getPropertyValue('--agent-color')).toBe('#a78bfa');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(167, 139, 250, 0.6)');
        expect(node.dataset.agent).toBe('writer');

        // A padded name is stored trimmed, matching the key the tone is assigned under —
        // and it re-reads the tone `writer` already owns instead of taking another slot.
        expect(paintAgentColor(node, '  writer  ')).toEqual(toneAt(2));
        expect(node.dataset.agent).toBe('writer');

        // The override is forwarded through the paint path, which is the only way the
        // roster payload's colour reaches the CSS custom properties.
        expect(paintAgentColor(node, 'writer', CUSTOM_HEX)).toEqual(CUSTOM_TONE);
        expect(node.style.getPropertyValue('--agent-color')).toBe(CUSTOM_HEX);
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(255, 102, 0, 0.6)');
    });

    it('clears data-agent for an unattributable surface instead of claiming one', () => {
        configureAgentColors({ roster: ['helper'] });

        const node = document.createElement('div');
        paintAgentColor(node, 'helper');
        expect(node.dataset.agent).toBe('helper');

        // An unnamed block gets the fallback tone and NO `data-agent` attribute at all
        // (cleared, not set to ''), so a `[data-agent]` selector — including
        // ui/activity.ts's ring selector — cannot match a block with no identity.
        expect(paintAgentColor(node, '')).toBe(UNKNOWN_AGENT_COLOR);
        expect(node.style.getPropertyValue('--agent-color')).toBe('#8b94a7');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(139, 148, 167, 0.55)');
        expect(node.hasAttribute('data-agent')).toBe(false);

        paintAgentColor(node, 'helper');
        expect(paintAgentColor(node, UNNAMED_AGENT_PLACEHOLDER)).toBe(UNKNOWN_AGENT_COLOR);
        expect(node.hasAttribute('data-agent')).toBe(false);

        paintAgentColor(node, 'helper');
        expect(paintAgentColor(node, undefined)).toBe(UNKNOWN_AGENT_COLOR);
        expect(node.hasAttribute('data-agent')).toBe(false);
    });
});
