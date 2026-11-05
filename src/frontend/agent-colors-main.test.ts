// T4 (R1 + R2 + R3): the harness's explicit agent colours, wired into the shell.
//
// ./ui/agent-color.ts owns ONE page-wide mapping, and every painted surface reads it
// without being handed a colour (ui/agent-control.ts, ui/agent-dialog.ts and ui/turns.ts all
// call `paintAgentColor(host, name)`). That makes the SHELL responsible for two things this
// file pins:
//
//   1. R2 — an `agentColors` map that reaches the browser (a boot row, a conversation's
//      frozen definition, or the configuration dialog's definition read) has to land on
//      EVERY surface of the active view: the composer button, the roster badges, and the
//      transcript's tile/section hosts. One paint per surface is not enough; they must agree.
//   2. R1/R3 — an agent the map omits keeps its DETERMINISTIC palette tone, and switching to
//      a view that configures something else (or nothing) must REPLACE the explicit tones,
//      never merge over them. `configureAgentColors` merges by design, so the replace comes
//      from ./main.ts `configureAgentColorsFor` resetting first; the reset is only correct
//      because the re-derivation is a pure function of (roster order, colours) — which is
//      what the "same tone again after switching back" assertion below proves.
//
// The exact tone an uncoloured agent gets is asserted against an INDEPENDENT re-derivation
// of the same roster (reset + configure + `agentColorOf`), not against the DOM value the
// shell happened to paint: a tautology would survive a shell that never configured
// anything, while this one does not.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts agent-colors-main.test.ts

import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';
import { AGENT_PALETTE, agentColorOf, configureAgentColors, resetAgentColors } from './ui/agent-color';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const SESSION_KEY = 'underload-harness-app:session';

// The one colour this fixture configures. Chosen because it is NOT a palette tone, so a
// painted value can only come from the explicit map (R2) — never from the automatic slot.
const EXPLICIT = '#ff6600';

const agents = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer directly.', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', instruction: 'Compress.', guidelines: [] },
    { name: 'critic', title: 'Critic', description: 'Reviews the answer.', instruction: 'Find problems.', guidelines: [] }
];

// A definition for the rail. `colors` is stated in the fixture's own camelCase spelling; the
// shared double re-expresses it as the contract's `agent_colors`, and ./api.ts `descriptorOf`
// maps it back — so this fixture walks the real wire spelling end to end.
const descriptor = (name: string, overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name,
        title: name === 'instruct' ? 'Instruct' : 'Plain',
        description: 'A two-agent team.',
        requiresEndpoint: true,
        agents: ['instruct', 'summarizer'],
        tools: [],
        coreTools: ['toolRequest', 'task', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const painted = descriptor('instruct', { agentColors: { instruct: EXPLICIT } });
// Same team, same primary, NO colour map: the switching case. Identical members matter — the
// only thing that may change between the two views is the explicit colour.
const plain = descriptor('plain', { title: 'Plain' });

// One settled conversation of the painted harness, with its frozen definition carried on the
// record (the spelling a saved session really has, ./contract.ts `frozenDefinitionOf`).
const saved = (harness: string, definition: HarnessDescriptor): SessionSnapshot =>
    ({
        id: 's9',
        harness,
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 20,
        messages: [],
        harnessDefinition: definition,
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'summarise this',
                status: 'done',
                startedAt: 10,
                updatedAt: 20,
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    { type: 'text', agent: 'instruct', delta: 'the answer' },
                    {
                        type: 'done',
                        agent: 'instruct',
                        message: {
                            role: 'assistant',
                            content: 'the answer',
                            reasoning: '',
                            toolCalls: [],
                            model: 'm1',
                            stopReason: 'stop'
                        }
                    }
                ]
            }
        ]
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

// The stub. `bootPresets` is what the rail boots with; `storedColors` is the map ONLY the
// identified definition read publishes (a card omits `agent_colors`,
// ../shared/harness-api.ts:422), which is the case ./main.ts `loadHarnessConfiguration`
// exists for.
const stub = (input: { presets?: HarnessDescriptor[]; session?: SessionSnapshot; storedColors?: Record<string, string> | null } = {}) => {
    const presets = input.presets ?? [painted];
    const session = input.session ?? saved('instruct', painted);

    return viewAwareFetch(async (input2: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input2);
        const method = init?.method;

        if (url === '/api') {
            return json({ rootPath: '/api', presets, tools: [], defaults, sessions: [session], agents });
        }

        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/harnesses/instruct' && method === undefined) {
            return json({
                harness: {
                    ...painted,
                    ...(input.storedColors === null
                        ? {}
                        : { agentColors: input.storedColors ?? { instruct: EXPLICIT } })
                }
            });
        }
        if (url === '/api/sessions/s9' && method === undefined) return json({ session });

        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    }, { root: '/api' });
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

// The two custom properties, read off the host a surface painted. `''` means "nothing was
// painted", which every assertion below fails explicitly.
const colorOn = (node: Element | null | undefined): string =>
    (node as HTMLElement | null | undefined)?.style.getPropertyValue('--agent-color') ?? '<missing>';

// The composer's agent button (ui/agent-control.ts paints the wrapper).
const composerColor = (): string => colorOn(document.querySelector('.agent-control'));

// One roster badge inside the configuration dialog (ui/agent-dialog.ts).
const badgeColor = (agent: string): string =>
    colorOn(document.querySelector(`.agent-dialog-tab[data-agent="${agent}"]`));

// The transcript host for one agent (ui/turns.ts paints the tile and its root section).
const tileColor = (agent: string): string =>
    colorOn(document.querySelector(`.tile[data-agent="${agent}"]`));

// The dialog is one click away, and idempotent once open.
const openDialog = (): void => {
    if (document.querySelector('.dialog') === null) byClass('.agent-control-button', 'button').click();
};

// The independent oracle: re-derive the mapping the shell is DOCUMENTED to configure
// (library roster, then this team) and answer one agent's automatic tone. Reset first, so
// nothing the shell configured can leak into the expectation; the shell re-configures on its
// next paint, which is exactly the behaviour being asserted.
const autoTone = (agent: string, colors: Record<string, string> = {}): string => {
    resetAgentColors();
    configureAgentColors({ roster: agents.map((agent2) => agent2.name), colors });

    return agentColorOf(agent).color;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    resetAgentColors();
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

describe('the active view paints its configured colours everywhere', () => {
    it('paints the explicit colour on the composer, the dialog badge and the transcript tile', async () => {
        vi.stubGlobal('fetch', vi.fn(stub()));
        localStorage.setItem(SESSION_KEY, 's9');

        await import('./main');
        await flush();
        await flush();
        await flush();

        // The conversation really is open: the tile assertion below is about a painted
        // transcript, not about an empty board (one recorded turn, one card).
        expect(document.querySelectorAll('.tile')).toHaveLength(1);
        expect(document.querySelector<HTMLElement>('.tile')?.dataset.agent).toBe('instruct');

        // R2: one configured hex, three surfaces, one fact.
        expect(composerColor()).toBe(EXPLICIT);
        openDialog();
        await flush();
        expect(badgeColor('instruct')).toBe(EXPLICIT);
        expect(tileColor('instruct')).toBe(EXPLICIT);
    });

    it('derives a palette tone for an agent the map omits, and never leaks the hex onto it', async () => {
        vi.stubGlobal('fetch', vi.fn(stub()));
        localStorage.setItem(SESSION_KEY, 's9');

        await import('./main');
        await flush();
        await flush();
        await flush();

        openDialog();
        await flush();

        const expected = autoTone('summarizer');

        // R3: the uncoloured member keeps a real palette tone (exact, and one of the eight),
        // and it is DISTINCT from the configured member's colour on the same screen.
        expect(badgeColor('summarizer')).toBe(expected);
        expect(AGENT_PALETTE.map((tone) => tone.color)).toContain(badgeColor('summarizer'));
        expect(badgeColor('summarizer')).not.toBe(EXPLICIT);
        expect(badgeColor('instruct')).toBe(EXPLICIT);
    });

    it('learns the colours from the identified definition read, on the dialog open', async () => {
        // The case a boot row cannot cover: a CARD never publishes `agent_colors`
        // (../shared/harness-api.ts:422), so before the dialog is opened this browser has
        // never seen the map. The read lands, the palette re-derives, and BOTH the open
        // dialog and the composer follow it.
        vi.stubGlobal(
            'fetch',
            vi.fn(stub({ presets: [descriptor('instruct')], session: saved('instruct', descriptor('instruct')) }))
        );

        await import('./main');
        await flush();
        await flush();

        expect(composerColor()).not.toBe(EXPLICIT);
        // The uncoloured primary, before the map exists in this browser at all.
        const before = composerColor();

        openDialog();
        await flush();
        await flush();

        expect(badgeColor('instruct')).toBe(EXPLICIT);
        expect(composerColor()).toBe(EXPLICIT);
        // R3: an explicit colour consumes no slot and disturbs nobody — the member nobody
        // configured wears exactly the tone it wore before the map arrived.
        const uncoloured = badgeColor('summarizer');

        expect(before).toBe(autoTone('instruct'));
        expect(uncoloured).toBe(autoTone('summarizer'));
        expect(uncoloured).not.toBe(EXPLICIT);
    });
});

describe('switching views replaces the colours', () => {
    it('drops the previous harness colour, and re-derives the identical tones on the way back', async () => {
        // Two harnesses, the same team and the same primary, one of them coloured: the only
        // thing allowed to move is the explicit map.
        vi.stubGlobal('fetch', vi.fn(stub({ presets: [painted, plain], session: saved('instruct', painted) })));
        localStorage.setItem(SESSION_KEY, 's9');

        await import('./main');
        await flush();
        await flush();

        expect(composerColor()).toBe(EXPLICIT);

        byClass('.harness-item[data-harness="plain"]', 'button').click();
        await flush();
        await flush();

        // No stale hex: the uncoloured view paints the deterministic automatic tone, which is
        // the tone the same roster produces from a clean page (R1/R3).
        expect(composerColor()).toBe(autoTone('instruct'));
        expect(composerColor()).not.toBe(EXPLICIT);

        byClass('.harness-item[data-harness="instruct"]', 'button').click();
        await flush();
        await flush();

        // And switching back restores the configured colour — the mapping is a fact about the
        // view, not about the order the reader visited it in.
        expect(composerColor()).toBe(EXPLICIT);
    });
});
