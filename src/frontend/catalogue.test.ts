// Tool-catalogue rendering for the credential-dependent search entry.
//
// C1 is a visibility fix: the catalogue must show search even when the server
// has no key, the button must say so before a click, and the runner must offer the
// example arguments while refusing to call it. With a key, the same entry is a
// normal callable tool. `main.ts` is imported with a stubbed fetch, exactly like
// main.test.ts, so no server runs and no key exists anywhere.
//
// R21.2 moved this catalogue: the right rail no longer lists tools at all, so the
// Tools tab is the only place a tool is selected, and the runner opens there.
//
// R5 (Tools Catalogue) took the group headings out of that tab: the list is ONE flat A–Z
// run of every tool, so this file asserts NO `.tool-tab-group` exists and still reads the
// group from the runner head's badge, which is where the figure is actually useful.
//
// R1 (the swap) moved the two activations apart: the TILE (`.tool-tab-button`) is now the
// conversation's enable/disable switch and the row's corner MARK (`.tool-tab-info`,
// `aria-haspopup="dialog"`) is the only way this list opens a runner. `search` is a
// `visibility: 'core'` name, and R5 left its tile a LIVE switch: the row says on, so the tile is
// pressed with no `data-locked` marker at all, and pressing it PATCHes this conversation's
// enablement for that name like any other row's does (./tools-tab.test.ts pins the switch). That
// is why every selection in this file presses the MARK — the tile's press writes, and this file is
// about opening a runner. The availability figure this file is about is unchanged by all of it: it
// still rides `data-availability` on the tile and its note in the runner.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';
import { sessionToolReads } from './session-config-test-support';

// T17: `GET /harnesses` publishes contract CARDS, which are snake_case, and the shell
// maps them through `descriptorOf` (./api.ts:1203) — a mapping that reads
// `requires_endpoint` and spreads `subagents`, so a pre-canonical body without those
// fields threw during boot and left the whole shell offline.
const card = {
    name: 'demo',
    title: 'Demo harness',
    description: 'A harness for the catalogue test.',
    requires_endpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['demo'],
    tools: [],
    builtin: true,
    definition_revision: 1
};

const WEBSEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'What to search for, e.g. "harness tool discovery".' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results to return.' }
    },
    required: ['query'],
    additionalProperties: false
};

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

// The conversation the card opens on. T4: the ⚒ pane lists the toolbox of the CONVERSATION on
// screen and main.ts hides both header toggles while none is bound, so a catalogue test needs one
// — and `harness: 'demo'` is what makes the shell open it on this fixture's only harness.
const SESSION = {
    id: 's1',
    harness: 'demo',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: []
};

// The one tool this fixture ships, stated ONCE: the boot document, the pane's toolbox row and the
// runner's identified schema read all come out of this record, so the availability figure under
// test is the same figure everywhere the shell looks (./session-config-test-support.ts).
const toolOf = (availability: unknown): Record<string, unknown> => ({
    name: 'search',
    group: 'Web search',
    description: 'Search the web with Exa or Tavily.',
    tags: ['web', 'search', 'internet', 'news', 'research'],
    // R18: a configured (or listed) search is core.
    visibility: 'core',
    // A direct call, not a session-registry tool (`session_bound` is the contract's spelling,
    // shared/harness-api.ts:647).
    session_bound: false,
    parameters: WEBSEARCH_PARAMETERS,
    availability
});

const stubFetch = (availability: unknown): void => {
    const tools = [toolOf(availability)];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);

            // Canonical-style bootstrap document: one answer carries the presets,
            // the tool catalogue and the (empty) session list. T45: the shell dials the
            // canonical control plane (`/v1/harness`, `/config`, one page per catalogue),
            // so this legacy body is handed to `viewAwareFetch` (./view-test-support.ts),
            // which re-acts it as those canonical routes without inventing any payload
            // the fixture does not already state.
            if (url === '/api') {
                return json({
                    rootPath: 'D:/repo',
                    presets: [card],
                    tools,
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    // T4: the catalogue pane describes a conversation, so the roster names one.
                    sessions: [SESSION]
                });
            }

            // T4: the conversation the roster points at (the rail's roster read, the view open, and
            // the toolbox page the pane asks for on first open), all from the ONE tool record above.
            if (url === '/api/sessions' || url === '/api/sessions?limit=25') return json({ sessions: [SESSION] });
            if (url === '/api/sessions/s1') return json({ session: SESSION });

            const toolReads = sessionToolReads(tools, url);

            if (toolReads !== undefined) return toolReads;

            // Boot also refreshes the model catalogue in the background.
            if (url.endsWith('/api/models')) return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );
};

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

// R21.2/R3: the tools view is the only catalogue. Selecting a tool means clicking
// its keyed button there, so the global topbar toggle is pressed first (there is no
// tab strip any more).
//
// T4: the press is no longer the ANSWER. The pane lists the conversation's toolbox, which it
// reads on first open, so the rows arrive a turn later — the caller has to wait for them. Before
// T4 the list came out of the boot document and was on screen the moment the swap painted.
const openToolsTab = async (): Promise<void> => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('the global Tools toggle did not render');
    if (found.getAttribute('aria-pressed') !== 'true') found.click();
    await flush();
};

const toolButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('.tool-tab-button')
];

// The corner INFO control of one row (R1 swap). Since the swap the tile is the enable/disable
// switch and this mark is the ONLY thing in the list that opens a tool dialog, so every "select
// the tool" step in this file presses the mark. `main.ts` `toolInfoButtonOf`.
const toolMark = (name: string): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(`.tool-tab-info[data-tool="${name}"]`);

    if (found === null) throw new Error(`the ${name} row has no corner info control`);

    return found;
};

const warningNotes = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.tool-card .tool-note.is-warning'));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('lists an unconfigured search, explains it, and disables the call', async () => {
    const hint =
        'Web search is not configured on this server. Set EXA_API_KEY or TAVILY_API_KEY in packages/underload/harness/.env (or the process environment) and restart the harness server.';

    stubFetch({ state: 'unconfigured', environment: ['EXA_API_KEY', 'TAVILY_API_KEY'], hint });
    await boot();

    // R21.2: no tool list on the right rail any more, and no mode switch either.
    expect(document.querySelectorAll('.modes')).toHaveLength(0);
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();

    // T4: the press opens the pane, and the pane's FIRST answer is that it is reading THIS
    // conversation's toolbox — an empty list and a reading list are different states, and the head
    // line is what tells them apart. The rows only land once the read lands, so the frame is
    // asserted BEFORE the promise is awaited.
    const toolsTab = openToolsTab();

    expect(document.querySelector('.tool-tab-group')).toBeNull();
    expect(document.querySelector<HTMLElement>('.tools-loading')?.textContent).toBe(
        'Reading this conversation’s toolbox…'
    );

    await toolsTab;

    const button = toolButtons()[0];

    expect(toolButtons()).toHaveLength(1);
    expect(button.dataset.tool).toBe('search');
    expect(button.dataset.availability).toBe('unconfigured');
    expect(button.querySelector('.tool-tab-kind')?.textContent).toBe('core · unconfigured');
    // R1 (swap): the tile states the ENABLED figure and never advertises a layer. R5 (this pass):
    // `search` is a core name, and a core name is a SWITCHABLE name — pressed with a green edge and
    // NO `data-locked` marker, because the marker now names only `writing` and `no-enablement`. The
    // tile is never `disabled` either, so the row keeps its focus and its corner mark keeps opening
    // the runner.
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.dataset.locked).toBeUndefined();
    expect(button.getAttribute('aria-haspopup')).toBeNull();
    expect(button.disabled).toBe(false);
    expect(toolMark('search').getAttribute('aria-haspopup')).toBe('dialog');
    expect(toolMark('search').getAttribute('aria-expanded')).toBe('false');
    expect(toolMark('search').getAttribute('aria-label')).toBe('Details for search');

    // The Tools tab opens the first entry automatically, so the runner is already showing
    // search. The explicit path is the row's CORNER MARK, not the tile: the tile is the
    // enablement switch, and pressing it here would PATCH this conversation's enablement for
    // `search` (a core name is switched exactly like any other), which is not what an
    // availability test wants. The mark carries `aria-haspopup="dialog"`.
    toolMark('search').click();

    // The tool opens in the centre; the header describes it without badge clutter.
    expect(document.querySelector('.main-title')?.textContent).toBe('search');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Web search');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: web, search, internet, news, research · unconfigured'
    );
    // The rails stay accessible around the runner.
    expect(document.querySelector('.rail-left')).not.toBeNull();
    expect(document.querySelector('.rail-right')).not.toBeNull();

    // The example arguments are still offered (they are useful documentation),
    // but both inputs that could start a call are disabled.
    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    expect(args?.value).toBe('{\n  "query": "harness tool discovery",\n  "maxResults": 5\n}');
    expect(args?.disabled).toBe(true);

    const call = document.querySelector<HTMLButtonElement>('.tool-card button.primary');
    expect(call?.disabled).toBe(true);

    // The visible warning is the server's hint, verbatim; the safety note is the
    // other warning paragraph and stays visible in both states.
    const notes = warningNotes();
    expect(notes).toHaveLength(2);
    expect(notes[1].hidden).toBe(false);
    expect(notes[1].textContent).toBe(hint);

    expect(document.querySelector('.tool-output .card-label')?.textContent).toBe('unconfigured');
    expect(document.querySelector('.tool-output .card-body')?.textContent).toBe('Not configured on this server.');
});

it('enables the same entry when the server reports it configured', async () => {
    stubFetch({ state: 'available', environment: ['EXA_API_KEY', 'TAVILY_API_KEY'] });
    await boot();

    const toolsTab = openToolsTab();

    await toolsTab;

    const button = toolButtons()[0];

    expect(button.dataset.tool).toBe('search');
    expect(button.dataset.availability).toBeUndefined();
    expect(button.querySelector('.tool-tab-kind')?.textContent).toBe('core');
    // R1 (swap): a configured core entry reads exactly like the unconfigured one from the switch's
    // side — pressed, no lock marker, no layer advertised by the tile — because a core name is a
    // switchable name. Availability is a different figure and rides `data-availability` (absent
    // here) and the runner's note.
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.dataset.locked).toBeUndefined();
    expect(button.getAttribute('aria-haspopup')).toBeNull();

    // The corner mark opens the runner here, for the same reason as above.
    const mark = toolMark('search');

    expect(mark.getAttribute('aria-expanded')).toBe('false');
    mark.click();
    expect(mark.getAttribute('aria-expanded')).toBe('true');

    expect(document.querySelector('.main-title')?.textContent).toBe('search');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: web, search, internet, news, research'
    );

    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    expect(args?.disabled).toBe(false);

    const call = document.querySelector<HTMLButtonElement>('.tool-card button.primary');
    expect(call?.disabled).toBe(false);

    const notes = warningNotes();
    expect(notes).toHaveLength(2);
    expect(notes[1].hidden).toBe(true);

    // R8: the runner's response pane labels itself `response` (its own copy control
    // sits beside that label, and it contributes no text to the label line).
    expect(document.querySelector('.tool-output .card-label')?.textContent).toBe('response');
    expect(document.querySelector('.tool-output .card-body')?.textContent).toBe('Nothing yet. Press “Call tool”.');
});
