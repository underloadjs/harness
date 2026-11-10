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
//   - A STABLE REPEAT PAST THAT: a beyond-palette identity reuses its OWN hashed slot, so
//     a tone never drifts when some other agent shows up;
//   - THE EIGHT TONES COVER EVERY SESSION, AND THE CATALOGUE MAY EXCEED THEM: what a
//     reader SEES is one view's roster (the active harness's members), never the whole
//     catalogue. The largest live team — the Manager's — is its primary plus its
//     `teamOf()` allowlist = 8 members, exactly the palette, and every other live team is
//     7, so no live session ever has two members in one tone. The CATALOGUE
//     (src/agents/index.ts `AGENT_PROFILE_NAMES`) is now ALSO exactly eight ids: the
//     `demo`/`flaky` fixture profiles were deleted, so the roster and the palette are the
//     same size and the catalogue fills the palette with no repeat at all. The repeat rule
//     is still pinned below because it is what protects a FUTURE ninth role — widening the
//     palette would re-derive the hash modulus (`PALETTE_SIZE`) and repaint every agent
//     (see ui/agent-color.ts, the `EIGHT TONES IS ENOUGH` block);
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
// they were captured once with a scratch probe against the real module and hardcoded, so
// a hash edit, a palette edit, a probe edit or a roster edit lands here as a deliberate
// diff rather than a silent recolour. The palette hexes stay hardcoded too: they are what
// a user learns.
//
// The catalogue is read from src/agents (a read-only import: the shipped browser bundle
// never imports server profiles) and the live teams from
// src/server/harnesses/presets.ts, so a new role or a changed allowlist shows up here as
// a failing exact-vector assertion instead of a comment that quietly went stale.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-color.test.ts

import type { AgentColor } from './agent-color';
import { AGENT_PROFILE_NAMES } from '../../agents';
import { presets, teamOf } from '../../server/harnesses/presets';
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

// The catalogue the harness ships (src/agents/index.ts `AGENT_PROFILE_NAMES`), in
// catalogue order — the order `configureAgentColors` resolves collisions in when a caller
// seeds the whole catalogue. EIGHT ids for EIGHT tones: the seven real roles plus the
// summarizer. The `demo`/`flaky` fixture profiles used to make this ten, which forced the
// documented repeat; they are deleted, so the roster and the palette are the same size.
const CATALOGUE = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger',
    'summarizer'
];

// The slots that catalogue lands on. Four of its keys hash onto an already-owned slot
// (`instruct` 3, `planner` 3, `debugger` 6, `summarizer` 0 collide) and walk forward,
// which is why the vector is not simply the raw residues [3, 3, 4, 6, 2, 3, 6, 0]. With
// the two fixtures deleted the eight ids take all eight slots, one each, so the shipped
// roster has NO repeated tone — the probe still runs, it just never runs out of room.
const CATALOGUE_SLOTS = [3, 4, 5, 6, 2, 7, 0, 1];

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

// The seven LIVE harnesses (`presets` in src/server/harnesses/presets.ts) and the exact
// set each one paints: primary first, then its `teamOf()` allowlist, and the exact slot
// each member lands on when THAT roster is configured on an empty page. The member sets
// and slots are measured off the module, not derived in the assertion; the live test
// re-derives the members from production `teamOf` and requires this literal.
//
// `planner` (the Manager) is the largest team there is: `teamOf()` drops the primary and
// the Manager from every OTHER team, so its own allowlist keeps all six remaining
// specialists plus the summarizer = 7 subagents + the primary = 8 members, EXACTLY the
// palette. Every other live team is 7. That is the real "the roster fits the palette"
// guarantee — the largest live team fits (the Manager's fills it), and the catalogue may
// exceed it and repeats stably. `general`'s shipped preset passes `subagents: []`, so what
// that card really paints is one member; the 7-member set below is its upper bound.
const LIVE_TEAMS: { primary: string; members: readonly string[]; slots: readonly number[] }[] = [
    {
        primary: 'general',
        members: ['general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
        slots: [3, 4, 5, 6, 2, 7, 0]
    },
    {
        primary: 'instruct',
        members: ['instruct', 'general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
        slots: [3, 4, 5, 6, 2, 7, 0]
    },
    {
        primary: 'research',
        members: ['research', 'general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer'],
        slots: [4, 3, 5, 6, 2, 7, 0]
    },
    {
        primary: 'workspace',
        members: ['workspace', 'general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer'],
        slots: [6, 3, 4, 5, 2, 7, 0]
    },
    {
        primary: 'reviewer',
        members: ['reviewer', 'general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer'],
        slots: [2, 3, 4, 5, 6, 7, 0]
    },
    {
        // The Manager: eight members, so the palette is exactly used up — no spare slot,
        // and still no shared tone.
        primary: 'planner',
        members: ['planner', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
        slots: [3, 4, 5, 6, 7, 2, 0, 1]
    },
    {
        primary: 'debugger',
        members: ['debugger', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer'],
        slots: [6, 3, 4, 5, 7, 2, 0]
    }
];

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
        configureAgentColors({ roster: CATALOGUE });
        const before = tonesOf(CATALOGUE);
        expect(slotsOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS);

        // A reload forgets the map but not the rule: the same roster produces the same
        // ten tones, in the same order. This is the R1 requirement — the old shuffle
        // failed exactly here.
        resetAgentColors();
        configureAgentColors({ roster: CATALOGUE });
        expect(tonesOf(CATALOGUE)).toEqual(before);

        // 25 more simulated reloads, with the real (unstubbed) `Math.random` available:
        // not one of them may vary the vector.
        for (let run = 0; run < 25; run += 1) {
            resetAgentColors();
            configureAgentColors({ roster: CATALOGUE });
            expect(tonesOf(CATALOGUE)).toEqual(before);
        }

        // The roster is not what makes a tone a fact about an identity either: reading
        // the same names with an empty map re-derives the same vector.
        resetAgentColors();
        expect(slotsOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS);
    });

    it('answers the same whatever order the surfaces ask in', () => {
        configureAgentColors({ roster: CATALOGUE });

        // The composer may ask before the transcript, or after the dialog: only the
        // roster order decides a collision, never which component painted first.
        expect(slotsOf([...CATALOGUE].reverse())).toEqual([...CATALOGUE_SLOTS].reverse());
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

            configureAgentColors({ roster: CATALOGUE });
            expect(slotsOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS);

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
        for (const name of CATALOGUE) configureAgentColors({ roster: [name] });
        expect(slotsOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS);
    });

    it('is idempotent: re-configuring the same roster changes nothing', () => {
        configureAgentColors({ roster: CATALOGUE });
        const first = tonesOf(CATALOGUE);

        configureAgentColors({ roster: CATALOGUE });
        configureAgentColors({ roster: CATALOGUE, colors: { ghost: CUSTOM_HEX } });
        configureAgentColors({});

        expect(tonesOf(CATALOGUE)).toEqual(first);
        expect(first.map((tone) => tone.slot)).toEqual(CATALOGUE_SLOTS);
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

describe('palette shape (the largest live team fits; the catalogue may exceed it and repeats stably)', () => {
    it('publishes exactly eight distinct tones, and no more', () => {
        expect(AGENT_PALETTE).toEqual(PALETTE);
        expect(AGENT_PALETTE.length).toBe(8);
        expect(AGENT_PALETTE.map((tone) => tone.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(new Set(AGENT_PALETTE.map((tone) => tone.color)).size).toBe(8);
        expect(new Set(AGENT_PALETTE.map((tone) => tone.line)).size).toBe(8);

        // Eight slots is the modulus the probe walks (ui/agent-color.ts `PALETTE_SIZE`).
        // Widening the array re-derives every automatic mapping, so the size is pinned:
        // the decision to keep eight must be a deliberate edit here. The shipped roster is
        // now exactly this long — the deleted `demo`/`flaky` profiles were the surplus — so
        // a ninth role is the edit that makes the repeat rule matter again, and it will
        // repaint nothing but itself.
        expect(CATALOGUE.length - AGENT_PALETTE.length).toBe(0);
    });

    it('pins the eight-id catalogue slot for slot, with no repeat', () => {
        // The catalogue the harness ships, in catalogue order: eight ids, eight tones.
        expect(AGENT_PROFILE_NAMES).toEqual(CATALOGUE);
        expect(AGENT_PROFILE_NAMES.length).toBe(8);

        configureAgentColors({ roster: AGENT_PROFILE_NAMES });

        // One exact slot per id — the whole vector, in catalogue order.
        expect(slotsOf(AGENT_PROFILE_NAMES)).toEqual(CATALOGUE_SLOTS);
        expect(tonesOf(AGENT_PROFILE_NAMES)).toEqual(CATALOGUE_SLOTS.map(toneAt));

        // The catalogue fills the palette exactly once each, so no two shipped agents share
        // a tone and the repeat rule is not exercised by anything this build ships.
        expect([...new Set(CATALOGUE_SLOTS)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

        // The rule that WOULD cover a surplus is still pinned, on throwaway identities
        // rather than on deleted fixtures: once every slot is owned, an extra id keeps its
        // own hash residue instead of walking (see `EXHAUSTED_SLOTS` above).
        expect(slotsOf(['i', 'j'])).toEqual(EXHAUSTED_SLOTS);

        // Eight ids, eight tones: eight distinct colours, and none of them is the neutral
        // fallback — every real id gets a real tone.
        expect(new Set(tonesOf(AGENT_PROFILE_NAMES).map((tone) => tone.color)).size).toBe(8);
        expect(CATALOGUE_SLOTS.filter((slot) => slot === UNKNOWN_AGENT_COLOR.slot).length).toBe(0);
    });

    it('repeats a surplus stably instead of drifting a tone a reader is already using', () => {
        // The shipped roster is exactly eight ids, so it fills the palette with no repeat.
        // The repeat rule is still what protects a NINTH role (or a session-defined agent),
        // so it is pinned here on throwaway identities rather than on the deleted
        // `demo`/`flaky` fixtures — the rule is about the palette being full, not about
        // those two keys.
        configureAgentColors({ roster: CATALOGUE });
        expect(slotsOf(CATALOGUE)).toEqual([3, 4, 5, 6, 2, 7, 0, 1]);
        expect(new Set(slotsOf(CATALOGUE)).size).toBe(8);

        // The surplus joins on a later, incremental configure (the way a live roster
        // grows): every slot is owned, so each extra id keeps its OWN residue instead of
        // walking — `i`→4 (`research`'s tone) and `j`→5 (`reviewer`'s).
        configureAgentColors({ roster: ['i', 'j'] });
        expect(slotsOf(['i', 'j'])).toEqual(EXHAUSTED_SLOTS);

        // No drift: identities discovered AFTER the surplus cannot move the surplus, the
        // catalogue, or each other — the repeat is a fact about the key, never a slot
        // handed out round-robin.
        configureAgentColors({ roster: ['k', 'l', 'm', ...COLLIDERS] });
        expect(slotsOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS);
        expect(slotsOf(['i', 'j'])).toEqual(EXHAUSTED_SLOTS);

        // And the identical map again from an empty page (a reload, or the ACTIVE view
        // being re-selected): id by id, the same eight tones.
        resetAgentColors();
        configureAgentColors({ roster: CATALOGUE });
        expect(tonesOf(CATALOGUE)).toEqual(CATALOGUE_SLOTS.map(toneAt));
    });

    it('keeps every live harness team pairwise distinct inside the eight slots', () => {
        // The seven live cards (`presets`), in catalogue order — the fixtures are absent
        // here, which is exactly why the catalogue is not the constraint.
        expect(presets.map((preset) => preset.primary)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger'
        ]);

        // Member counts, per card: the Manager's team is the largest there is and lands
        // exactly on the palette size, every other live team is smaller. A new specialist
        // role (or a summarizer that joins twice) pushes this vector past 8 and fails.
        expect(LIVE_TEAMS.map((team) => team.members.length)).toEqual([7, 7, 7, 7, 7, 8, 7]);
        expect(Math.max(...LIVE_TEAMS.map((team) => team.members.length))).toBe(8);

        for (const team of LIVE_TEAMS) {
            resetAgentColors();

            // The members the module is configured with: the primary plus the production
            // allowlist (`teamOf`), so a changed rule shows up here instead of in a stale
            // copy of the list.
            expect([team.primary, ...teamOf(team.primary)]).toEqual(team.members);

            configureAgentColors({ roster: team.members });

            // Exact slots for that roster, and pairwise distinct by construction: one
            // distinct slot and one distinct colour per member.
            const slots = slotsOf(team.members);
            expect(slots).toEqual(team.slots);
            expect(new Set(slots).size).toBe(team.members.length);
            expect(tonesOf(team.members)).toEqual(team.slots.map(toneAt));
            expect(new Set(tonesOf(team.members).map((tone) => tone.color)).size).toBe(team.members.length);
        }
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
