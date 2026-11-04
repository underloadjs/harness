// Agent identity colour — the R4 assignment contract (T5).
//
// R4 changed ONE thing: the palette slot an agent gets is DRAWN BY THE UI (randomly,
// once per page) instead of derived from the agent id by a hash + a pinned built-in
// table. Everything the rest of the UI depends on still has to hold, and the whole
// point of this file is to pin the parts that randomness could silently break:
//
//   - STABLE FOR THE PAGE: one canonical id maps to one tone for the whole page
//     lifetime, so no re-render, chrome rebuild or dialog re-open recolours a block
//     while the reader is looking at it (`no flicker`);
//   - DISTINCT UNTIL EXHAUSTED: the draw order is a permutation of the palette, so the
//     first `PALETTE.length` identities get pairwise different tones; only after that
//     does a tone get shared;
//   - ONE IDENTITY, ONE SLOT: `Writer` / `writer` / ` writer ` are one agent and must
//     not mint a second colour or burn a second slot;
//   - UNKNOWN COSTS NOTHING: an empty/absent name and the `unknown` placeholder get the
//     neutral fallback (`slot: -1`) and do not consume a palette slot;
//   - NO PINNED BUILT-INS: the roster is no longer mapped by hand, so an exact expected
//     slot is only ever stated for a SEEDED draw — never "instruct is blue".
//
// How the tests stay deterministic while the feature is random: `reseedAgentColors`
// takes the source of randomness. Two stub sources (`() => 0` and `() => 1`) make
// Fisher-Yates produce a hand-provable order, so exact slot vectors can be asserted; a
// seeded PRNG plus `Math.random` are used for the properties that must hold for ANY
// draw. The palette hexes stay hardcoded here on purpose: they are what a user learns.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-color.test.ts

import { AGENT_PROFILE_NAMES } from '../../agents';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_PALETTE,
    UNNAMED_AGENT_PLACEHOLDER,
    UNKNOWN_AGENT_COLOR,
    agentColorOf,
    agentKeyOf,
    paintAgentColor,
    reseedAgentColors
} from './agent-color';

// The eight tones, in slot order (ui/agent-color.ts `AGENT_PALETTE`). A copy, so a
// palette edit has to be a deliberate test edit, and so a slot vector can be read as
// the colour the reader actually sees.
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

// The draw orders the two stub sources produce. Both are hand-provable from the
// Fisher-Yates loop in ui/agent-color.ts (`for index = 7..1, swap(index, min(index,
// max(0, floor(random() * (index + 1)))))`):
//   - `() => 0` rotates slot 0 to the END: every swap draws index 0, so the value that
//     was at 0 walks forward and each other value shifts down ⇒ [1,2,3,4,5,6,7,0].
//   - `() => 1` draws `index + 1`, which the clamp pins back to `index` (a no-op swap),
//     so the order is UNCHANGED ⇒ [0,1,2,3,4,5,6,7]. This is also the guard against a
//     source that returns exactly 1 (never `undefined` out of range).
const ROTATED = [1, 2, 3, 4, 5, 6, 7, 0];
const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7];

const always = (value: number) => (): number => value;
const ROTATED_DRAW = always(0);
const IDENTITY_DRAW = always(1);

// A real (deterministic) PRNG, for the properties that must hold for an arbitrary draw.
const mulberry32 = (seed: number) => {
    let state = seed >>> 0;

    return (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
};

const slotsOf = (agents: readonly (string | undefined)[]): number[] => agents.map((agent) => agentColorOf(agent).slot);
const sortedSlots = (agents: readonly (string | undefined)[]): number[] => [...slotsOf(agents)].sort((a, b) => a - b);

// Module state is page-scoped, so every case must draw its own order — otherwise a
// previous case's already-assigned ids would leak into the next one's slot vector.
beforeEach(() => {
    reseedAgentColors(ROTATED_DRAW);
});

describe('assignment (R4: the UI draws the colour)', () => {
    it('hands out slots in the drawn order, exactly', () => {
        // `() => 0` ⇒ draw order [1,2,3,4,5,6,7,0]; identities are served in the order
        // they are first seen, and a 9th identity cycles back to the start.
        expect(slotsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])).toEqual([...ROTATED, 1, 2]);

        // The tone is the palette member at that slot — colour and outline always move
        // together, which is what keeps a name and its block frame the same agent.
        expect(agentColorOf('a')).toEqual(PALETTE[1]);
        expect(agentColorOf('b')).toEqual(PALETTE[2]);
        expect(agentColorOf('j')).toEqual(PALETTE[2]);
    });

    it('draws a different mapping per page, so a tone is not a fact about an id', () => {
        // Two consecutive "page loads" with different draws: the SAME id changes tone,
        // which is exactly what R4 asks for (and why nothing may hardcode a per-name
        // colour in CSS or in another component).
        reseedAgentColors(ROTATED_DRAW);
        expect(agentColorOf('instruct')).toEqual(PALETTE[1]);

        reseedAgentColors(IDENTITY_DRAW);
        expect(agentColorOf('instruct')).toEqual(PALETTE[0]);

        // No reload persistence either: a fresh draw forgets the old assignment.
        reseedAgentColors(ROTATED_DRAW);
        expect(agentColorOf('instruct')).toEqual(PALETTE[1]);
    });

    it('no longer pins the built-in roster to fixed slots', () => {
        // The pinned table is gone (the palette permutation does the separating). Under
        // the rotated draw the FIRST identity asked for takes slot 1 — for `instruct`
        // that would have been slot 0 in the old table, so this asserts the table is not
        // secretly still in charge.
        reseedAgentColors(ROTATED_DRAW);
        expect(agentColorOf('instruct')).toEqual(PALETTE[1]);
        expect(agentColorOf('instruct')).not.toEqual(PALETTE[0]);
    });

    it('randomises the draw but never the palette it draws from', () => {
        const roster = [...AGENT_PROFILE_NAMES];

        // Every draw, seeded or real, must be a PERMUTATION: all eight slots handed out,
        // none twice — otherwise two roster roles would share a colour at first paint.
        const vectors: string[] = [];
        for (let run = 0; run < 12; run += 1) {
            reseedAgentColors(run % 2 === 0 ? mulberry32(run + 1) : Math.random);

            const slots = slotsOf(roster);
            expect(sortedSlots(roster)).toEqual(IDENTITY);
            expect(new Set(slots).size).toBe(8);
            vectors.push(slots.join(','));
        }

        // Across twelve draws the mapping really does vary (12 identical permutations of
        // 40320 possible orders is a ~1e-60 chance, so this is a randomness check with no
        // practical flake — and every other assertion above holds whatever it returns).
        expect(new Set(vectors).size).toBeGreaterThan(1);
    });
});

describe('stability (no flicker on re-render)', () => {
    it('keeps one tone for one agent across every request in the same page', () => {
        reseedAgentColors(mulberry32(11));

        const first = agentColorOf('Researcher');

        // A re-render, a chrome rebuild, a re-opened dialog, two invocations of one
        // agent: the same value every time — the same OBJECT, so a repaint writes the
        // identical string and the browser cannot even transition between two tones.
        expect(agentColorOf('Researcher')).toBe(first);
        expect(agentColorOf('Researcher')).toBe(first);

        const node = document.createElement('div');
        expect(paintAgentColor(node, 'Researcher')).toBe(first);
        const painted = node.style.getPropertyValue('--agent-color');
        expect(paintAgentColor(node, 'Researcher').color).toBe(painted);
        expect(node.style.getPropertyValue('--agent-color')).toBe(painted);
    });

    it('normalises case and space into one identity that costs one slot', () => {
        reseedAgentColors(ROTATED_DRAW);

        expect(agentKeyOf(' Writer ')).toBe('writer');

        // One agent, three spellings: one tone, and it never redraws.
        expect(agentColorOf('Writer')).toEqual(PALETTE[1]);
        expect(agentColorOf(' writer ')).toEqual(PALETTE[1]);
        expect(agentColorOf('WRITER')).toEqual(PALETTE[1]);
        expect(agentColorOf('\twriter\n')).toEqual(PALETTE[1]);

        // The padded spellings burned no extra slots, so the next DISTINCT identity still
        // takes the next slot in the draw (2), not a later one.
        expect(agentColorOf('Helper')).toEqual(PALETTE[2]);
    });

    it('agrees between surfaces because every surface reads the same key', () => {
        reseedAgentColors(mulberry32(5));

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

        // The roster the harness ships must still fit inside one permutation, or two
        // built-in profiles would collide on every page. A new profile that overflows
        // the palette fails here and says exactly what to widen.
        expect(AGENT_PROFILE_NAMES).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'summarizer',
            'demo',
            'flaky'
        ]);

        reseedAgentColors(mulberry32(3));
        const tones = AGENT_PROFILE_NAMES.map((name) => agentColorOf(name));
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
        // randomly handed-out slot and start looking like a real identity.
        expect(PALETTE).not.toContainEqual(UNKNOWN_AGENT_COLOR);
    });

    it('consumes no slot, so unknowns never push a real agent into a shared tone', () => {
        reseedAgentColors(ROTATED_DRAW);

        // Five unattributable blocks first — a reader who has a lot of legacy frames
        // must still see eight distinct tones for their eight agents.
        for (const unknown of [undefined, '', '  ', 'unknown', ' UNKNOWN ']) agentColorOf(unknown);

        expect(slotsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual(ROTATED);
        expect(agentColorOf(undefined)).toBe(UNKNOWN_AGENT_COLOR);
    });
});

describe('painting', () => {
    it('writes the two custom properties and mirrors the canonical name on data-agent', () => {
        reseedAgentColors(ROTATED_DRAW);

        const node = document.createElement('div');

        // `helper` is the second identity served ⇒ slot 1 ⇒ cyan.
        expect(paintAgentColor(node, 'helper')).toEqual(PALETTE[1]);
        expect(node.style.getPropertyValue('--agent-color')).toBe('#22d3ee');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(34, 211, 238, 0.6)');
        expect(node.dataset.agent).toBe('helper');

        // Repainting (an adopted placeholder, a re-parented entry, a different primary)
        // replaces the tone; it never layers a second value. `writer` is the second
        // identity served in this draw ⇒ the next slot (2).
        expect(paintAgentColor(node, 'writer')).toEqual(PALETTE[2]);
        expect(node.style.getPropertyValue('--agent-color')).toBe('#a78bfa');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(167, 139, 250, 0.6)');
        expect(node.dataset.agent).toBe('writer');

        // A fresh page (new draw, assignment map forgotten) re-serves `zebra` as the
        // first identity ⇒ slot 0, whatever tone it wore a moment ago.
        reseedAgentColors(IDENTITY_DRAW);
        expect(paintAgentColor(node, 'zebra')).toEqual(PALETTE[0]);
        expect(node.style.getPropertyValue('--agent-color')).toBe('#7aa2ff');
        expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(122, 162, 255, 0.6)');

        // A padded name is stored trimmed, matching the key the tone is assigned under —
        // and it re-reads the tone `zebra` already owns instead of taking another slot.
        expect(paintAgentColor(node, '  zebra  ')).toEqual(PALETTE[0]);
        expect(node.dataset.agent).toBe('zebra');
    });

    it('clears data-agent for an unattributable surface instead of claiming one', () => {
        reseedAgentColors(ROTATED_DRAW);

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
