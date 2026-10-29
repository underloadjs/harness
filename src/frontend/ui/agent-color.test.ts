// Deterministic agent identity colour (R3).
//
// The transcript carries agent identity ONLY through colour (no role badge), so
// the mapping name → tone is a UI contract:
//   - every BUILT-IN profile id gets its own explicit, distinct tone (the review
//     caught research/workspace/reviewer sharing one hash slot) — this test imports
//     the real roster from src/agents/index.ts so a new profile cannot silently
//     land on a duplicate colour;
//   - an arbitrary agent name resolves through the hash, still deterministically:
//     the same name always resolves to the same palette slot;
//   - two spellings of one id (`Writer`, ` writer `) resolve identically;
//   - an empty/absent name AND the `unknown` UI placeholder resolve to the neutral
//     fallback (slot -1), never to a palette slot, so "we cannot attribute this"
//     never looks like an identity;
//   - `paintAgentColor` mirrors the tone into the two custom properties
//     styles.css consumes and keeps `data-agent` clean.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-color.test.ts

import { expect, it } from 'vitest';
import { AGENT_PROFILE_NAMES } from '../../agents';
import {
    UNKNOWN_AGENT_COLOR,
    UNNAMED_AGENT_PLACEHOLDER,
    agentColorOf,
    agentKeyOf,
    paintAgentColor
} from './agent-color';

// The eight palette tones, in slot order (ui/agent-color.ts `PALETTE`). Hardcoded
// on purpose: a palette edit must be a deliberate test edit, because the colours
// are what a user learns to associate with an agent.
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

// The explicit built-in table (ui/agent-color.ts `BUILT_IN_SLOTS`), in roster order.
const BUILT_IN_EXPECTED = {
    instruct: PALETTE[0],
    research: PALETTE[1],
    workspace: PALETTE[2],
    reviewer: PALETTE[3],
    planner: PALETTE[4],
    summarizer: PALETTE[5],
    demo: PALETTE[6],
    flaky: PALETTE[7]
};

it('gives every built-in profile its own distinct, documented tone', () => {
    // The real roster, not a copy: a profile added to src/agents/index.ts without a
    // tone here fails this test instead of shipping a duplicate/undefined colour.
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

    expect(AGENT_PROFILE_NAMES.map((name) => [name, agentColorOf(name)])).toEqual(
        Object.entries(BUILT_IN_EXPECTED)
    );

    // No two built-in profiles share a colour or an outline.
    const tones = AGENT_PROFILE_NAMES.map((name) => agentColorOf(name));
    expect(new Set(tones.map((tone) => tone.color)).size).toBe(AGENT_PROFILE_NAMES.length);
    expect(new Set(tones.map((tone) => tone.line)).size).toBe(AGENT_PROFILE_NAMES.length);
    expect(tones.some((tone) => tone.slot === UNKNOWN_AGENT_COLOR.slot)).toBe(false);
});

it('resolves arbitrary agent names to exact, stable palette slots', () => {
    // Every slot stays reachable for non-profile names (a custom teammate).
    expect(agentColorOf('writer')).toEqual(PALETTE[2]);
    expect(agentColorOf('helper')).toEqual(PALETTE[5]);
    expect(agentColorOf('researcher')).toEqual(PALETTE[3]);
    expect(agentColorOf('worker')).toEqual(PALETTE[7]);
    expect(agentColorOf('delta')).toEqual(PALETTE[1]);
    expect(agentColorOf('archivist')).toEqual(PALETTE[6]);

    // Repeated resolution (two invocations of one agent, a re-render, a reload).
    expect(agentColorOf('writer')).toEqual(agentColorOf('writer'));
});

it('normalises case and space, and prefers the built-in table over the hash', () => {
    // Identity is the normalised id, not the literal spelling.
    expect(agentKeyOf(' Writer ')).toBe('writer');
    expect(agentColorOf('Writer')).toEqual(PALETTE[2]);
    expect(agentColorOf(' writer ')).toEqual(PALETTE[2]);
    expect(agentColorOf('HELPER')).toEqual(PALETTE[5]);

    // The built-in table wins: `Research` is the profile `research` (slot 1), not the
    // hash of the string (which would be slot 4).
    expect(agentColorOf('Research')).toEqual(PALETTE[1]);
    expect(agentColorOf(' Reviewer ')).toEqual(PALETTE[3]);
});

it('falls back to one neutral tone for unknown, unnamed and placeholder agents', () => {
    expect(UNKNOWN_AGENT_COLOR).toEqual({
        slot: -1,
        color: '#8b94a7',
        line: 'rgba(139, 148, 167, 0.55)'
    });

    expect(agentColorOf(undefined)).toEqual(UNKNOWN_AGENT_COLOR);
    expect(agentColorOf('')).toEqual(UNKNOWN_AGENT_COLOR);
    expect(agentColorOf('   ')).toEqual(UNKNOWN_AGENT_COLOR);
    // The UI's own placeholder for an unattributable stream is NOT an identity: it
    // resolves exactly like an empty name (the tile and its section agree).
    expect(UNNAMED_AGENT_PLACEHOLDER).toBe('unknown');
    expect(agentColorOf(UNNAMED_AGENT_PLACEHOLDER)).toEqual(UNKNOWN_AGENT_COLOR);
    expect(agentColorOf(' Unknown ')).toEqual(UNKNOWN_AGENT_COLOR);

    // The fallback is NOT a palette member: an unknown agent must never borrow (for
    // example) slot 0 and look like a real identity.
    expect(PALETTE).not.toContainEqual(UNKNOWN_AGENT_COLOR);
});

it('paints the CSS custom properties and mirrors the name on data-agent', () => {
    const node = document.createElement('div');

    expect(paintAgentColor(node, 'helper')).toEqual(PALETTE[5]);
    expect(node.style.getPropertyValue('--agent-color')).toBe('#2dd4bf');
    expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(45, 212, 191, 0.6)');
    expect(node.dataset.agent).toBe('helper');

    // Repainting (an adopted placeholder, a re-parented entry) replaces the tone.
    expect(paintAgentColor(node, 'writer')).toEqual(PALETTE[2]);
    expect(node.style.getPropertyValue('--agent-color')).toBe('#a78bfa');
    expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(167, 139, 250, 0.6)');
    expect(node.dataset.agent).toBe('writer');

    // Built-in profile: explicit tone, not the hash.
    expect(paintAgentColor(node, 'reviewer')).toEqual(PALETTE[3]);
    expect(node.dataset.agent).toBe('reviewer');

    // An unnamed block gets the fallback tone and NO `data-agent` attribute at all
    // (cleared, not set to ''), so a `[data-agent]` selector cannot match it.
    expect(paintAgentColor(node, '')).toEqual(UNKNOWN_AGENT_COLOR);
    expect(node.style.getPropertyValue('--agent-color')).toBe('#8b94a7');
    expect(node.style.getPropertyValue('--agent-line')).toBe('rgba(139, 148, 167, 0.55)');
    expect(node.hasAttribute('data-agent')).toBe(false);

    // The placeholder name is treated the same way (no identity claimed).
    expect(paintAgentColor(node, UNNAMED_AGENT_PLACEHOLDER)).toEqual(UNKNOWN_AGENT_COLOR);
    expect(node.hasAttribute('data-agent')).toBe(false);

    // A padded name is stored trimmed, matching the key used for the tone.
    expect(paintAgentColor(node, '  helper  ')).toEqual(PALETTE[5]);
    expect(node.dataset.agent).toBe('helper');
});
