// Agent identity colour across every surface (T5/R1/R3/R4).
//
// R4 asks for ONE fact the reader can rely on: an agent's colour is the same wherever
// that agent is named — the composer's agent button (`Instruct` / `IT`), the roster
// badges inside the agent dialog, the `[+]` picker options, and the transcript's
// `IT1`/`RH1` thread labels and their block outlines. Three separate components paint
// those hosts (ui/agent-control.ts, ui/agent-dialog.ts, ui/turns.ts), so the guarantee
// is only real if a test walks all of them and compares the values actually painted.
//
// The assignment is DETERMINISTIC (R1: the same tones come back after a reload), but this
// file still never asserts WHICH tone that is — "instruct is pink" is a fact about the
// palette and the hash, not a surface contract, and it is pinned with exact values in
// ui/agent-color.test.ts. What is pinned here is what only a cross-surface test can see:
//   - CROSS-SURFACE EQUALITY for one agent (the real R4 claim),
//   - PALETTE MEMBERSHIP (a painted value is one of the eight tones, never a stray),
//   - DISTINCTNESS between two agents while the palette has free slots,
//   - the EXACT neutral fallback for an unattributable surface (not derived, so it is
//     asserted as a literal),
//   - IMMUTABILITY across a rebuild / re-open / live refresh (no colour flicker),
//   - RELOAD STABILITY: a fresh module state + the same roster paints the same vector
//     (R1, the requirement the old per-page shuffle failed).
//
// The roster is configured in `beforeEach` — that is what production does (main.ts calls
// `configureAgentColors` with the boot roster, then again with the live session roster)
// and it is what makes the vector below independent of which component painted first.
//
// The mapping's own rules (hash + forward probe, canonical-key stability, slot
// exhaustion, explicit overrides, painted custom properties) are pinned in
// ui/agent-color.test.ts. The CSS side — which property each label actually reads — is
// pinned in ui/compact-control-style.test.ts and ui/thread-conversation-style.test.ts.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-color-surfaces.test.ts

import type { AgentDescriptor, HarnessEvent } from '../../server/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_PALETTE, UNKNOWN_AGENT_COLOR, configureAgentColors, resetAgentColors } from './agent-color';
import { createAgentControl } from './agent-control';
import { openAgentDialog } from './agent-dialog';
import type { AgentDialog, AgentDialogOptions } from './agent-dialog';
import { createTurnBoard } from './turns';
import type { TurnHandle } from './turns';

// The three identities this file puts on screen: the primary (code `IT`), one delegated
// agent (`RH`, a second tone) and one agent that only appears later (`RV`, to prove a
// newly known identity gets its own slot without moving the existing ones).
const agents: AgentDescriptor[] = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'General agent.',
        instruction: 'Answer directly.',
        guidelines: []
    },
    {
        name: 'research',
        title: 'Researcher',
        description: 'Investigates.',
        instruction: 'Investigate.',
        guidelines: []
    },
    {
        name: 'reviewer',
        title: 'Reviewer',
        description: 'Skeptical pass.',
        instruction: 'Hunt for bugs.',
        guidelines: []
    }
];

// The roster handed to `configureAgentColors`: the same names, in the same order, on
// every case (and again after the simulated reload), so the slot vector any assertion
// reads is fixed by the roster rather than by the order the DOM happened to paint.
const ROSTER = agents.map((agent) => agent.name);

const PALETTE_COLORS = AGENT_PALETTE.map((tone) => tone.color);
const PALETTE_LINES = AGENT_PALETTE.map((tone) => tone.line);

// The two custom properties, read straight off the host each component painted. A
// missing host reads `<missing>` and an unpainted host reads `''`; both fail the
// palette-membership check below instead of passing silently.
const colorOn = (node: Element | null | undefined): string =>
    (node as HTMLElement | null | undefined)?.style.getPropertyValue('--agent-color') ?? '<missing>';
const lineOn = (node: Element | null | undefined): string =>
    (node as HTMLElement | null | undefined)?.style.getPropertyValue('--agent-line') ?? '<missing>';

// Every painted value must be a real palette tone: that is what catches a component that
// paints the wrong property, paints nothing, or invents its own colour.
const expectPaletteTone = (color: string, line: string): void => {
    expect(PALETTE_COLORS).toContain(color);
    expect(PALETTE_LINES).toContain(line);
};

// --- surface 1: the composer's agent button (ui/agent-control.ts) --------------
const composer = (primary: string): HTMLElement =>
    createAgentControl({ primary, agents, onActivate: () => undefined }).element;

// --- surface 2: the agent dialog's roster badges (ui/agent-dialog.ts) ----------
let dialog: AgentDialog | undefined;

const dialogOptions = (members: readonly string[]): AgentDialogOptions => ({
    members,
    primary: 'instruct',
    agents,
    editable: true,
    models: { models: {}, catalogue: ['m1', 'm2'], fallbackModel: 'm1', editable: true },
    instructions: {},
    onApply: () => Promise.resolve({ applied: true, message: 'Saved.' })
});

const openDialog = (members: readonly string[]): AgentDialog => {
    dialog = openAgentDialog(dialogOptions(members));
    return dialog;
};

const badge = (agent: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.agent-dialog-tab[data-agent="${agent}"]`);
const badgeName = (agent: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.agent-dialog-tab[data-agent="${agent}"] .agent-dialog-agent-name`);
const pickerOption = (agent: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.agent-dialog-add-option[data-agent="${agent}"]`);

// --- surface 3: the transcript's tile + thread labels (ui/turns.ts) -----------
// `withThread`/`delegateCall` mirror ui/turns-threads.test.ts: frozen thread metadata on
// an ordinary frame is what makes the invocation (and therefore its `IT1`/`RH1` label) a
// real entry instead of a flat legacy section.
const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread } as unknown as HarnessEvent);

const delegateCall = (agent: string, input: string, id: string): HarnessEvent =>
    ({
        type: 'tool_call',
        agent: 'instruct',
        call: { id, name: 'delegate', arguments: JSON.stringify({ agent, input }) }
    }) as unknown as HarnessEvent;

const mount = () => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.append(board.element);
    return board;
};

// One turn: the primary (`instruct`) runs, delegates to `research`, and `research`
// starts its own invocation. Afterwards the tile, the thread row and both label hosts
// exist.
const stream = (board: ReturnType<typeof createTurnBoard>, prompt = 'look it up'): TurnHandle => {
    const turn = board.begin(prompt);

    turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    turn.apply(delegateCall('research', 'find the source', 'd1'));
    turn.apply(
        withThread(
            { type: 'start', agent: 'research', model: 'm2' },
            { id: 't1', callId: 'd1', input: 'find the source' }
        )
    );
    turn.flush();

    return turn;
};

// The painted host of the ROOT code label. `turn.element` is the tile in the current
// shape, and `.closest('[data-agent]')` keeps the read correct (and honestly scoped) if
// the tile ever moves inside a wrapper row again.
const rootHost = (turn: TurnHandle): HTMLElement | null => {
    const label = turn.element.querySelector('.tile-agent');
    return (label ?? turn.element).closest<HTMLElement>('[data-agent]');
};

// The painted host of a thread's code label, scoped to ONE turn so a second turn on the
// same board cannot be answered by the first turn's row.
const threadHost = (turn: TurnHandle, agent: string): HTMLElement | null => {
    const scope = turn.element.closest<HTMLElement>('.turn-row') ?? (turn.element.parentElement as HTMLElement);
    const row = scope?.querySelector<HTMLElement>(`.thread-row[data-agent="${agent}"]`);
    const label = row?.querySelector('.thread-name');

    return (label ?? row ?? null)?.closest<HTMLElement>('[data-agent]') ?? null;
};

const threadTile = (turn: TurnHandle, agent: string): HTMLElement | null => {
    const scope = turn.element.closest<HTMLElement>('.turn-row') ?? (turn.element.parentElement as HTMLElement);
    return scope?.querySelector<HTMLElement>(`.thread-row[data-agent="${agent}"] .thread-tile`) ?? null;
};

// One full "page load": a board with a primary run that delegates, plus the dialog open on
// the same team. Every value is the custom property a real host now carries, so the record
// is the whole page's identity colouring in one comparable object — used to prove a reload
// reproduces it exactly (R1). A stale query reads `''` (unpainted) or `'<missing>'`, which
// the palette-membership check below turns into a failure instead of a silent match.
const paintPage = (): Record<string, string> => {
    const board = mount();
    const turn = stream(board);
    openDialog(['instruct', 'research']);

    const row = threadHost(turn, 'research');

    return {
        // The primary, on each host that names it.
        composerPrimary: colorOn(composer('instruct')),
        composerPrimaryLine: lineOn(composer('instruct')),
        tile: colorOn(turn.element),
        badgePrimary: colorOn(badge('instruct')),
        badgePrimaryLine: lineOn(badge('instruct')),

        // The delegated agent, on each host that names it.
        composerDelegate: colorOn(composer('research')),
        threadRow: colorOn(row),
        threadRowLine: lineOn(row),
        threadTile: colorOn(threadTile(turn, 'research')),
        badgeDelegate: colorOn(badge('research'))
    };
};

beforeEach(() => {
    document.body.innerHTML = '';
    resetAgentColors();
    configureAgentColors({ roster: ROSTER, colors: {} });
});

// Tears every painted surface down. `badge()` / `pickerOption()` query the DOCUMENT, so a
// case that opens a second dialog must not leave the first dialog's tabs behind, or it
// would read a stale node instead of the one it just painted.
const clearSurfaces = (): void => {
    dialog?.close();
    dialog = undefined;
    for (const overlay of document.querySelectorAll('.dialog-overlay')) overlay.remove();
    document.body.innerHTML = '';
};

afterEach(clearSurfaces);

describe('one agent, one colour, everywhere (R4)', () => {
    it('paints the composer, the roster badge and the transcript blocks with one tone', () => {
        const board = mount();
        const turn = stream(board);

        openDialog(['instruct', 'research']);

        // The primary: composer button == its dialog badge == its transcript tile.
        const control = composer('instruct');
        const controlColor = colorOn(control);
        const controlLine = lineOn(control);

        expect([colorOn(badge('instruct')), colorOn(turn.element)]).toEqual([controlColor, controlColor]);
        expect([lineOn(badge('instruct')), lineOn(turn.element)]).toEqual([controlLine, controlLine]);
        expectPaletteTone(controlColor, controlLine);

        // The delegated agent: its thread row (which owns the `RH1` label), its nested
        // block and its badge all agree — and on a DIFFERENT tone than the primary,
        // because colour is the only thing separating the two blocks.
        const row = threadHost(turn, 'research');
        const rowColor = colorOn(row);
        const rowLine = lineOn(row);

        expect([colorOn(threadTile(turn, 'research')), colorOn(badge('research'))]).toEqual([rowColor, rowColor]);
        expect([lineOn(threadTile(turn, 'research')), lineOn(badge('research'))]).toEqual([rowLine, rowLine]);
        expectPaletteTone(rowColor, rowLine);

        expect(rowColor).not.toBe(controlColor);
        expect(rowLine).not.toBe(controlLine);

        // The labels inside a painted host carry no colour of their own, so styles.css /
        // ui/agent-dialog.css resolve `var(--agent-color)` by inheritance: an inline
        // `color` on a label would silently override the identity tone.
        expect(badgeName('instruct')?.hasAttribute('style')).toBe(false);
        expect(control.querySelector<HTMLElement>('.agent-control-name')?.hasAttribute('style')).toBe(false);
        expect(control.querySelector<HTMLElement>('.agent-control-code')?.hasAttribute('style')).toBe(false);
    });

    it('colours the `IT1`/`RH1` label hosts with the same tones as the composer and dialog', () => {
        const board = mount();
        const turn = stream(board);
        openDialog(['instruct', 'research']);

        // The exact labels the reader sees: the root tile code and the thread code.
        expect(turn.element.querySelector('.tile-agent')?.textContent).toBe('IT1');
        expect(threadHost(turn, 'research')?.querySelector('.thread-name')?.textContent).toBe('RH1');

        // Each label resolves its colour from the nearest painted ancestor, and that
        // ancestor is the SAME host the composer/dialog key on: the identity the label
        // names is the identity the label is coloured with.
        expect(rootHost(turn)?.dataset.agent).toBe('instruct');
        expect(threadHost(turn, 'research')?.dataset.agent).toBe('research');

        expect(colorOn(rootHost(turn))).toBe(colorOn(composer('instruct')));
        expect(colorOn(rootHost(turn))).toBe(colorOn(badge('instruct')));
        expect(colorOn(threadHost(turn, 'research'))).toBe(colorOn(badge('research')));
        expect(colorOn(threadHost(turn, 'research'))).toBe(colorOn(composer('research')));

        // A second turn of one agent repeats the tone instead of drawing a new one, and
        // its label host matches the first turn's host exactly. (The label TEXT itself is
        // the allocator's contract, pinned in ui/turns-threads.test.ts; here only the
        // colour is in scope.)
        const second = stream(board, 'look it up again');
        expect(colorOn(rootHost(second))).toBe(colorOn(rootHost(turn)));
        expect(colorOn(threadHost(second, 'research'))).toBe(colorOn(threadHost(turn, 'research')));
    });

    it('paints the `[+]` picker option with the tone its badge will keep', () => {
        // Only two of the three agents are on the team, so `reviewer` is addable.
        const handle = openDialog(['instruct', 'research']);
        expect(handle.isOpen).toBe(true);

        // The picker opens through its own control; the roster strip is already painted.
        document.querySelector<HTMLButtonElement>('.agent-dialog-add')?.click();

        const option = pickerOption('reviewer');
        const optionColor = colorOn(option);
        const optionLine = lineOn(option);

        expect(option?.textContent).toBe('Reviewer');
        expectPaletteTone(optionColor, optionLine);

        // Drafting the add turns the option into a badge; the colour cannot change on the
        // way, or the reader relearns the team after every add.
        option?.click();

        expect([colorOn(badge('reviewer')), lineOn(badge('reviewer'))]).toEqual([optionColor, optionLine]);
        expect(badgeName('reviewer')?.hasAttribute('style')).toBe(false);
    });

    it('keeps an unattributable surface neutral on every host', () => {
        const board = mount();
        const turn = board.begin('legacy');

        // A frame with no `start` cannot name an agent, so the tile and the placeholder
        // section both fall back to the documented neutral tone (an exact literal: the
        // fallback is the one value R4 does not randomise).
        turn.apply({ type: 'tool_result', agent: 'ghost', name: 'read', content: 'ok', isError: false });

        const section = turn.element.querySelector<HTMLElement>('.agent');

        expect([colorOn(turn.element), lineOn(turn.element)]).toEqual([
            UNKNOWN_AGENT_COLOR.color,
            UNKNOWN_AGENT_COLOR.line
        ]);
        expect([colorOn(section), lineOn(section)]).toEqual([
            UNKNOWN_AGENT_COLOR.color,
            UNKNOWN_AGENT_COLOR.line
        ]);

        // No identity is claimed anywhere, so no `[data-agent]` rule — identity colour or
        // activity ring — can match these hosts.
        expect(turn.element.hasAttribute('data-agent')).toBe(false);
        expect(section?.hasAttribute('data-agent')).toBe(false);

        // The composer paints the same neutral tone for a primary the shell cannot name,
        // and the `unknown` placeholder is not an identity either.
        expect([colorOn(composer('')), lineOn(composer(''))]).toEqual([
            UNKNOWN_AGENT_COLOR.color,
            UNKNOWN_AGENT_COLOR.line
        ]);
        expect(composer('unknown').hasAttribute('data-agent')).toBe(false);

        // A dialog badge can only ever be a real member, so no badge falls back: both of
        // these stay palette tones.
        openDialog(['instruct', 'research']);
        expectPaletteTone(colorOn(badge('instruct')), lineOn(badge('instruct')));
        expectPaletteTone(colorOn(badge('research')), lineOn(badge('research')));
    });
});

describe('stability while the page lives', () => {
    it('keeps every tone identical across a rebuild, a re-open and a live refresh', () => {
        const board = mount();
        const turn = stream(board);
        const handle = openDialog(['instruct', 'research']);

        const read = (): string[] => [
            colorOn(composer('instruct')),
            colorOn(badge('instruct')),
            colorOn(turn.element),
            colorOn(composer('research')),
            colorOn(badge('research')),
            colorOn(threadHost(turn, 'research'))
        ];

        const before = read();
        expect(new Set(before).size).toBe(2);

        // A chrome repaint builds a brand-new composer control and re-runs the roster
        // loop (the dialog body is rebuilt on every refresh, and re-opening builds it
        // again). Nothing may re-draw a tone the reader is already using.
        handle.update(dialogOptions(['instruct', 'research']));
        handle.close();
        openDialog(['instruct', 'research']);

        expect(read()).toEqual(before);

        // The live activity path must not recolour either: it paints rings only, and the
        // badges keep their identity tone underneath.
        handle.paintActivity(new Set<string>(['instruct']));
        openDialog(['instruct', 'research']).paintActivity(new Set<string>(['instruct', 'research']));

        expect(read()).toEqual(before);
    });

    it('paints the identical tones on a fresh page: the mapping survives a reload (R1)', () => {
        const before = paintPage();

        // The vector is real before it is stable: every host names one of the two agents
        // and carries a genuine palette tone, so the comparison below cannot be won by a
        // page that painted nothing.
        expectPaletteTone(before.composerPrimary, before.composerPrimaryLine);
        expectPaletteTone(before.threadRow, before.threadRowLine);
        expect({ tile: before.tile, badgePrimary: before.badgePrimary }).toEqual({
            tile: before.composerPrimary,
            badgePrimary: before.composerPrimary
        });
        expect({
            composerDelegate: before.composerDelegate,
            threadTile: before.threadTile,
            badgeDelegate: before.badgeDelegate
        }).toEqual({
            composerDelegate: before.threadRow,
            threadTile: before.threadRow,
            badgeDelegate: before.threadRow
        });
        expect(before.threadRow).not.toBe(before.composerPrimary);

        // The reload: module state is gone, and boot configures the same roster in the
        // same order (exactly what main.ts does on a fresh page). Under the old per-page
        // draw this is where the team's colours changed on the reader.
        clearSurfaces();
        resetAgentColors();
        configureAgentColors({ roster: ROSTER, colors: {} });

        expect(paintPage()).toEqual(before);
    });

    it('gives a newly known identity its own tone without moving the ones already learned', () => {
        const board = mount();
        const turn = stream(board);
        const handle = openDialog(['instruct', 'research']);

        const before = {
            instructBadge: colorOn(badge('instruct')),
            researchBadge: colorOn(badge('research')),
            tile: colorOn(turn.element),
            threadRow: colorOn(threadHost(turn, 'research'))
        };

        // The team grows mid-session (a save, or a harness PATCH): the new agent draws a
        // FREE slot, and the two tones the reader already knows stay put.
        handle.update(dialogOptions(['instruct', 'research', 'reviewer']));

        const reviewer = colorOn(badge('reviewer'));
        expectPaletteTone(reviewer, lineOn(badge('reviewer')));

        expect({
            instructBadge: colorOn(badge('instruct')),
            researchBadge: colorOn(badge('research')),
            tile: colorOn(turn.element),
            threadRow: colorOn(threadHost(turn, 'research'))
        }).toEqual(before);

        expect(reviewer).not.toBe(before.instructBadge);
        expect(reviewer).not.toBe(before.researchBadge);

        // A delegated run of that same new agent lands on the tone its badge shows — the
        // transcript never draws a second colour for an agent the dialog already named.
        const reviewing = board.begin('review it');
        reviewing.apply({ type: 'start', agent: 'instruct', model: 'm1' });
        reviewing.apply(delegateCall('reviewer', 'check it', 'd9'));
        reviewing.apply(
            withThread(
                { type: 'start', agent: 'reviewer', model: 'm3' },
                { id: 't9', callId: 'd9', input: 'check it' }
            )
        );
        reviewing.flush();

        expect(colorOn(threadHost(reviewing, 'reviewer'))).toBe(reviewer);
    });
});
