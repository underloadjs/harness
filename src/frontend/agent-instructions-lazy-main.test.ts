// The configuration dialog reads the definition it edits (T11), AND the trusted default text it
// seeds an unoverridden agent from (the T11/T32 companion read).
//
// A `/views` frame types `harnessDefinition` as a `HarnessDescriptor` but OMITS
// `agentInstructions` (../server/protocol.ts:655-663): per-agent instruction TEXT would
// otherwise ride every view frame, which is exactly the payload class the display wire exists
// to remove. So the shell may not assume the text the dialog's textarea is seeded with is the
// stored text — it has to ask, once, when the reader opens the dialog.
//
// The DEFAULT side of that pair has the same gap one layer down. `GET /agents` — the boot page
// the agent library is built from — answers SUMMARIES with no prompt at all
// (../shared/harness-api.ts:552-563), and `agentRowOf` maps that absence to '' on purpose
// (./api.ts:1246-1273). The dialog's ONE editable box falls back to that row (./ui/agent-dialog.ts
// `baselineInstructionOf`), so before ./main.ts `loadAgentPresetTexts` existed the box was BLANK
// for every agent this harness does not override. The identified profile read `GET /agents/:id`
// (./api.ts `getAgent`) is the only response that states the shipped text and its guideline rules,
// and it had no caller at all.
//
// R4 (T7a) then removed the second, read-only "preset instruction" block and its revert control:
// the box holds the FULL prompt the agent runs (identity sentence plus its `Guidelines:` block,
// exactly what `GET /agents/:id` answers through ./ui/agents.ts `agentDefaultInstructionOf`), and
// clearing the text by hand is how the default comes back. `agent-instructions-main.test.ts` pins
// the two harness-context saves; this file pins the reads that make the box truthful.
//
// These tests drive the REAL composer button against a stubbed server and pin:
//   - no harness read while the app boots, hydrates, streams or polls (the render path must
//     not grow a request per frame);
//   - exactly ONE `GET /harnesses/:name` per explicit open, and its answer reaching the
//     editor that is already on screen;
//   - the degradation rule: a gateway that has not mounted the route (405) leaves the reader
//     with the definition-derived text and a working dialog, not an error;
//   - the write rule: a harness PATCH restates the map the reader can SEE (document plus the
//     read), because the server replaces `agentInstructions` wholesale — otherwise an override
//     the view omitted would be silently wiped;
//   - the default-text rule: one `GET /agents/:id` per member whose library row is still empty,
//     fired when the dialog opens (and on a `[+]` selection that walk never covered), its FULL
//     prompt reaching the single box, its title NOT being allowed to relabel a tile, a failed read
//     degrading to the honest blank without poisoning the next selection, and clearing a stored
//     override landing on that default rather than on nothing.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts agent-instructions-lazy-main.test.ts

import type { HarnessDescriptor } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'summarizer'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'tasks', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

// The same definition with extra members on the team (primary first, then every subagent).
// One helper so the boot row and the identified read can never disagree about the team.
const definitionWith = (extra: readonly string[], overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    descriptor({
        ...(extra.length === 0
            ? {}
            : { agents: ['instruct', 'summarizer', ...extra], subagents: ['summarizer', ...extra] }),
        ...overrides
    });

// The trusted library (GET /agents): what a member with NO stored override runs.
const agents = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer directly.', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', instruction: 'Compress notes into two sentences.', guidelines: [] }
];

// The same catalogue in the shape the route REALLY answers: an `AgentSummary` carries identity
// plus the two override flags and NOTHING else (../shared/harness-api.ts:552-563), so
// `agentRowOf` (./api.ts:1259-1273) yields `instruction: ''` / `guidelines: []`. This is the
// state the dialog really boots against, and the third profile is offered by the catalogue
// WITHOUT being on the team — the `[+]` picker's only option.
const summaryRows = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', has_instruction_override: false, has_global_override: false },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', has_instruction_override: false, has_global_override: false },
    { name: 'retriever', title: 'Retriever', description: 'Looks things up.', has_instruction_override: false, has_global_override: false }
];

// What `GET /agents/:id` ships per profile (the `AgentProfile` text fields,
// ../shared/harness-api.ts:571-581). The title and description are deliberately NOT the
// summary's words: ./main.ts `agentRowWithTextOf` moves `instruction` and `guidelines` ONLY,
// so an assertion on a visible label proves the provenance merge instead of a blind spread.
// A `null` entry is the retired profile the route 404s (../server/api.ts:1685-1695).
type ShippedProfile = { instruction: string; guidelines: string[]; title: string; description: string };

const shipped: Record<string, ShippedProfile | null> = {
    instruct: {
        instruction: 'Answer directly.',
        guidelines: ['Name the answer first.', 'Quote the file it came from.'],
        title: 'Instruct (shipped profile)',
        description: 'Shipped profile description.'
    },
    summarizer: {
        instruction: 'Compress notes into two sentences.',
        guidelines: [],
        title: 'Summarizer (shipped profile)',
        description: 'Shipped profile description.'
    },
    retriever: {
        instruction: 'Search before answering.',
        guidelines: ['Cite the source.'],
        title: 'Retriever (shipped profile)',
        description: 'Shipped profile description.'
    }
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

// The reader's path to the dialog: the one composer button.
const openDialog = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

const instructionBox = (): HTMLTextAreaElement => {
    openDialog();

    return byClass('.agent-dialog-instruction', 'textarea');
};

// The identified profile read as a pathname. The stub declares its routes under `/api` (it is
// handed the REWRITTEN url), while the shell dials the contract mount (`/v1/harness`,
// ../shared/harness-api.ts:39,63) — so both spellings are needed to count one action.
const FIXTURE_AGENT_ROUTE = /^\/api\/agents\/([^/]+)$/;
const CANONICAL_AGENT_ROUTE = /^\/v1\/harness\/agents\/([^/]+)$/;

const matches = (url: string, pattern: RegExp): boolean => pattern.test(url);

// One tab's read-only trusted reference (./ui/agents.ts `createAgentPresetDetail`) is GONE (R4 /
// T7a): the single editable box carries the full prompt, so these tests read the box and assert
// its exact text. The two constants below are that text — the composition
// ./ui/agents.ts `agentDefaultInstructionOf` documents and src/agents/index.ts `agentInstruction`
// ships (identity, a blank line, then one `- ` bullet per guideline in profile order).
const instructDefault = 'Answer directly.\n\nGuidelines:\n- Name the answer first.\n- Quote the file it came from.';
const retrieverDefault = 'Search before answering.\n\nGuidelines:\n- Cite the source.';

/**
 * One stub for every test. `stored` is the definition only the GET route knows: the boot
 * document and every `/views` frame carry the descriptor WITHOUT `agentInstructions`, which is
 * what the real display wire does.
 *
 * `summaries: true` re-states the boot catalogue the way `GET /agents` really answers it —
 * identity only, no prompt and no guidelines — which is the gap the preset-text fix has to
 * recover from. `profiles` is the identified `GET /agents/:id` answer per agent.
 * `extraMembers` puts agents on the team that the catalogue does not advertise.
 */
const stub = (
    input: {
        stored?: Record<string, string>;
        status?: number;
        patches?: Record<string, unknown>[];
        summaries?: boolean;
        profiles?: Record<string, ShippedProfile | null>;
        extraMembers?: readonly string[];
    } = {}
) => {
    const { stored = {}, status = 200, summaries = false } = input;
    const extra = input.extraMembers ?? [];
    const patches = input.patches ?? [];
    const profileAnswers = input.profiles ?? shipped;
    const reads: { url: string; method: string }[] = [];
    // What the SHELL dialled, counted before the double's canonical adapter folds several
    // fixture probes into one answer: `withViewRoutes` memoizes GETs, so a repeat dial of one
    // pathname can be invisible in `reads`. `dials` is therefore the only log that proves the
    // shell STOPPED asking, and `reads` the only log that proves which mount it reached.
    const dials: { url: string; method: string }[] = [];
    const bare = definitionWith(extra);
    // The frame the browser is given on boot: no instruction text anywhere.
    delete (bare as { agentInstructions?: unknown }).agentInstructions;

    const answer = viewAwareFetch(
        async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            reads.push({ url, method });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [bare],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents: summaries ? summaryRows : agents
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });

            // `GET /agents/:id` — the identified profile read. Answers the contract's
            // `AgentProfileResponse` envelope (../shared/harness-api.ts:593-595), which
            // ./api.ts:701-702 unwraps through `.agent`.
            const agentMatch = url.match(FIXTURE_AGENT_ROUTE);

            if (agentMatch !== null && method === 'GET') {
                const agent = decodeURIComponent(agentMatch[1]);
                const profile = profileAnswers[agent];

                if (profile === undefined || profile === null) {
                    return json({ error: { message: `Unknown agent ${agent}` } }, 404);
                }

                return json({
                    agent: {
                        name: agent,
                        title: profile.title,
                        description: profile.description,
                        instruction: profile.instruction,
                        guidelines: profile.guidelines,
                        instruction_source: 'catalogue',
                        referenced_by: [],
                        revision: 1
                    }
                });
            }

            if (url === '/api/harnesses/instruct' && method === 'GET') {
                if (status !== 200) return json({ error: { message: 'Use PATCH or DELETE for /api/harnesses/:name.' } }, status);

                return json({ harness: definitionWith(extra, { agentInstructions: stored }) });
            }

            if (url === '/api/harnesses/instruct' && method === 'PATCH') {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                patches.push(body);

                return json({
                    harness: descriptor({
                        primary: body.primary as string,
                        subagents: body.subagents as string[],
                        ...(body.agentModels === undefined ? {} : { agentModels: body.agentModels as Record<string, string> }),
                        ...(body.agentInstructions === undefined ? {} : { agentInstructions: body.agentInstructions as Record<string, string> })
                    })
                });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        },
        // T32: this fixture declares its routes under `/api`, while the client dials the
        // contract mount (`/v1/harness`, shared/harness-api.ts:39). The adapter only rewrites
        // a canonical request into the fixture's own mount when it is TOLD that mount, so
        // without this option the canonical boot catalogues answer empty and the shell has
        // no harness to paint — which is the "missing .agent-control-button" this file kept
        // reporting. `agent-instructions-main.test.ts` and `composer-agent-control.test.ts`
        // already pass it; the assertions below are unchanged.
        { root: '/api' }
    );

    vi.stubGlobal(
        'fetch',
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
            dials.push({ url: String(request), method: init?.method ?? 'GET' });

            return answer(request, init);
        })
    );

    return {
        reads,
        patches,
        harnessReads: () => reads.filter((call) => call.method === 'GET' && call.url === '/api/harnesses/instruct'),
        // What reached THIS stub on the identified profile route, in dial order.
        agentReads: () => reads.filter((call) => call.method === 'GET' && matches(call.url, FIXTURE_AGENT_ROUTE)),
        // What the shell dialled on that same route, in dial order. Every duplicate here is a
        // request the reader paid for twice.
        agentDials: () => dials.filter((call) => call.method === 'GET' && matches(call.url, CANONICAL_AGENT_ROUTE))
    };
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

describe('the configuration dialog reads what it edits', () => {
    it('never reads the definition while the app boots, hydrates or renders', async () => {
        const server = stub({ stored: { summarizer: 'Compress into one paragraph.' } });

        await import('./main');
        await flush();
        await flush();

        // The composer button and the team strip are painted from the frame the browser was
        // given; no instruction text is needed for that, so none is asked for.
        expect(server.harnessReads()).toHaveLength(0);
        expect(document.querySelector('.agent-control-button')).not.toBeNull();
    });

    it('asks for the definition once, on the explicit open, and seeds the editor with it', async () => {
        const server = stub({ stored: { instruct: 'Lead with the answer, then explain.' } });

        await import('./main');
        await flush();

        expect(server.harnessReads()).toHaveLength(0);

        instructionBox();
        await flush();

        expect(server.harnessReads()).toHaveLength(1);
        // The stored override, not the trusted preset, is what the reader edits.
        expect(instructionBox().value).toBe('Lead with the answer, then explain.');

        // A second open asks again (the definition may have moved in another tab), and it is
        // still one request per open.
        byClass('.dialog-close', 'button').click();
        openDialog();
        await flush();
        expect(server.harnessReads()).toHaveLength(2);
    });

    it('restates every stored override on a harness write, including the ones only the read revealed', async () => {
        const server = stub({ stored: { summarizer: 'Compress into one paragraph.' } });

        await import('./main');
        await flush();

        // The reader edits the PRIMARY's instruction; the PATCH must keep the summarizer's
        // override, which the view frame never carried.
        const box = instructionBox();
        await flush();
        box.value = 'Answer in two paragraphs.';
        box.dispatchEvent(new Event('input', { bubbles: true }));

        byClass('.agent-dialog-apply', 'button').click();
        await flush();

        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].agentInstructions).toEqual({
            instruct: 'Answer in two paragraphs.',
            summarizer: 'Compress into one paragraph.'
        });
    });

    it('keeps working against a gateway that has not mounted the read', async () => {
        const server = stub({ status: 405 });

        await import('./main');
        await flush();

        expect(instructionBox().value).toBe('Answer directly.');
        await flush();

        // The 405 is a "no extra information", not a failure the reader has to be told about:
        // no STATUS line moved, no notice appeared, and the box is still editable.
        expect(document.querySelector('.status')?.dataset.state).toBe('idle');
        expect(document.querySelector('.agent-dialog-error')?.textContent).toBe('');

        // The session note element exists in the shell and stays put: an unreadable definition
        // is not a conversation error.
        const notice = document.querySelector<HTMLElement>('.notice');
        expect(notice?.hidden ?? true).toBe(true);
        expect(notice?.textContent ?? '').toBe('');
        expect(instructionBox().disabled).toBe(false);
        expect(server.harnessReads()).toHaveLength(1);
    });

    it('does not send an instruction map the server never had', async () => {
        const server = stub({ status: 404 });

        await import('./main');
        await flush();

        const box = instructionBox();
        await flush();
        box.value = 'Answer in two paragraphs.';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        byClass('.agent-dialog-apply', 'button').click();
        await flush();

        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].agentInstructions).toEqual({ instruct: 'Answer in two paragraphs.' });
    });
});

describe('the configuration dialog reads the default text it seeds', () => {
    // The regression itself. The boot catalogue carries no prompt, so the box opens blank and
    // the identified profile read is the only thing that can fill it.
    it('fills the blank textarea with the shipped profile instruction', async () => {
        stub({ summaries: true });

        await import('./main');
        await flush();

        // Before the read lands: the row the boot page produced, which has no text. This is
        // exactly what the reader used to be left with, forever.
        expect(instructionBox().value).toBe('');

        await flush();

        // After it: the FULL prompt the agent runs, verbatim — the identity sentence AND its
        // guideline block, because the box is the whole truth (R4). `agentRowOf` mapped the
        // summary's absent `instruction` to '', so anything other than this string is the bug.
        expect(instructionBox().value).toBe(instructDefault);
        expect(instructionBox().disabled).toBe(false);
    });

    // R4 (T7a): the guideline rules are part of the ONE editable box, not a second read-only
    // panel, and there is no revert control — clearing the text by hand is the undo.
    it('holds the shipped instruction and its guideline rules in the one editable box', async () => {
        stub({ summaries: true });

        await import('./main');
        await flush();
        instructionBox();
        await flush();

        const box = instructionBox();

        // One box, and its text is the composed prompt: identity, a blank line, `- ` bullets.
        expect(box.value).toBe(instructDefault);
        expect(box.disabled).toBe(false);
        expect(document.querySelectorAll('.agent-dialog-instruction')).toHaveLength(1);
        // The reference disclosure and its revert action are gone.
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.querySelector('.agent-dialog-revert')).toBeNull();
    });

    // Bounded cost: one read per member whose row is still empty, paid for by the action that
    // opened the dialog, and never again while this browser holds usable text.
    it('asks once per member for the open, and not again on a re-open', async () => {
        const server = stub({ summaries: true });

        await import('./main');
        await flush();

        // Boot, hydration and the composer paint cost nothing.
        expect(server.agentDials()).toEqual([]);

        instructionBox();
        await flush();

        expect(server.agentReads()).toEqual([
            { url: '/api/agents/instruct', method: 'GET' },
            { url: '/api/agents/summarizer', method: 'GET' }
        ]);
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);

        // The catalogue agent with no tab is never asked for: the walk covers the members, and
        // nothing else has a panel to fill yet.
        byClass('.dialog-close', 'button').click();
        openDialog();
        await flush();

        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);
        // The re-open still re-reads the DEFINITION (the freshness rule above); it just has no
        // reason to re-read a prompt this browser already holds.
        expect(server.harnessReads()).toHaveLength(2);
        expect(instructionBox().value).toBe(instructDefault);
    });

    // Provenance merge: the profile read states a title and description too, and the row the
    // summary produced keeps them — a late answer cannot relabel a tile under the reader.
    it('takes only the text from the profile read and keeps the summary label', async () => {
        stub({ summaries: true });

        await import('./main');
        await flush();
        instructionBox();
        await flush();

        // The profile answers with 'Instruct (shipped profile)'; the header and the strip still
        // say what the boot page said.
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Instruct');
        expect(
            byClass('.agent-dialog-tab[data-agent="instruct"]', 'button').getAttribute('aria-label')
        ).toBe('Configure Instruct · primary agent');
        expect(
            byClass('.agent-dialog-tab[data-agent="instruct"] .agent-dialog-agent-name', 'span').textContent
        ).toBe('Instruct');
        expect(
            byClass('.agent-dialog-tab[data-agent="summarizer"] .agent-dialog-agent-name', 'span').textContent
        ).toBe('Summarizer');

        // While the text on this same tab did move — to the FULL composed prompt.
        expect(instructionBox().value).toBe(instructDefault);
    });

    // Override precedence, then the undo: an override wins while it is stored, and clearing the
    // box lands on the DEFAULT prompt — which is only reachable because of the read above.
    it('prefers the stored override and clears back to the default, not to a blank', async () => {
        const server = stub({ summaries: true, stored: { instruct: 'Override text.' } });

        await import('./main');
        await flush();

        const box = instructionBox();
        await flush();

        // The boot page alone leaves the box blank (the bug), and the DEFINITION read's stored
        // override is what wins once it lands — the default never overrides an override.
        expect(box.value).toBe('');
        expect(instructionBox().value).toBe('Override text.');
        // R4: the undo is the box's own text, and it is a draft like any other edit.
        expect(document.querySelector('.agent-dialog-revert')).toBeNull();

        instructionBox().value = '';
        instructionBox().dispatchEvent(new Event('input', { bubbles: true }));
        byClass('.agent-dialog-apply', 'button').click();
        await flush();

        // The complete map is restated with this key cleared — the server replaces it wholesale.
        expect(server.patches).toHaveLength(1);
        expect(server.patches[0]).toEqual({
            primary: 'instruct',
            subagents: ['summarizer'],
            agentInstructions: {}
        });

        // And the box falls back to the shipped prompt, not to the empty draft it held while the
        // write was in flight.
        expect(instructionBox().value).toBe(instructDefault);
        expect(document.querySelector('.agent-dialog-error')?.textContent).toBe('');
        // Clearing an override costs no extra read: the text was already in hand.
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);
    });

    // Degradation: a retired profile 404s (../server/api.ts:1685-1695), the dialog stays usable
    // with the honest blank, and that failure is deliberately NOT cached.
    it('degrades to the honest blank on a 404 and asks again on the next selection', async () => {
        const server = stub({ summaries: true, profiles: { ...shipped, summarizer: null } });

        await import('./main');
        await flush();

        instructionBox();
        await flush();

        // The member that answered is filled with its FULL shipped prompt; the one that 404ed is
        // not filled at all.
        expect(instructionBox().value).toBe(instructDefault);

        byClass('.agent-dialog-tab[data-agent="summarizer"]', 'button').click();
        await flush();

        // The explicit selection asked again (the 404 poisoned nothing), and the answer is the
        // same absent profile: an honest blank, stated as an absence rather than invented.
        expect(instructionBox().value).toBe('');

        // No crash and no false alarm: the run state never moved and the dialog reports no
        // failure for a read that is allowed to fail. And the box is still editable, because an
        // empty default is a prompt the reader can write into, not a locked field.
        expect(document.querySelector('.status')?.dataset.state).toBe('idle');
        expect(document.querySelector('.agent-dialog-error')?.textContent).toBe('');
        expect(instructionBox().disabled).toBe(false);
        // R4: with no default to show there is no reference block either — the empty box is the
        // whole statement.
        expect(document.querySelector('.agent-detail')).toBeNull();

        // One dial at the open, one more on the selection that asked again — exactly one more.
        // (The double answers the retry from its own GET memo, so only this log can see it.)
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);
    });

    // A member the catalogue stopped advertising has no library row to attach text to, so it is
    // skipped rather than dialled (./main.ts:6229-6239).
    it('never asks for a member the boot catalogue never advertised', async () => {
        const server = stub({ summaries: true, extraMembers: ['archivist'] });

        await import('./main');
        await flush();

        instructionBox();
        await flush();

        // Only the two advertised members were asked for.
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);

        // The orphan keeps its tab (a saved team can name an agent the server dropped). T7b: a
        // member is named by its id, because the neutral 'Agent' word would make two dropped
        // profiles indistinguishable — and its panel is the honest blank with no preset read at
        // all, since there is no row to fill.
        expect(
            byClass('.agent-dialog-tab[data-agent="archivist"] .agent-dialog-agent-name', 'span').textContent
        ).toBe('archivist');

        byClass('.agent-dialog-tab[data-agent="archivist"]', 'button').click();
        await flush();

        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);
        expect(instructionBox().value).toBe('');
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.body.textContent).not.toContain('does not advertise');
    });

    // The `[+]` path: an agent the dialog-open walk never covered is asked for by the explicit
    // press that adds it (./ui/agent-dialog.ts:520).
    it('asks once for an agent added through the [+] picker', async () => {
        const server = stub({ summaries: true });

        await import('./main');
        await flush();

        instructionBox();
        await flush();

        // The open walk covered the two members only.
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' }
        ]);

        byClass('.agent-dialog-add', 'button').click();

        // The picker offers exactly the catalogue agent without a tab, labelled with the title
        // the boot page gave it (the profile's own title never reaches the tile).
        const options = document.querySelectorAll<HTMLButtonElement>('.agent-dialog-add-option');
        expect(Array.from(options).map((option) => option.textContent)).toEqual(['Retriever']);

        options[0].click();
        await flush();

        expect(server.agentReads()).toEqual([
            { url: '/api/agents/instruct', method: 'GET' },
            { url: '/api/agents/summarizer', method: 'GET' },
            { url: '/api/agents/retriever', method: 'GET' }
        ]);
        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' },
            { url: '/v1/harness/agents/retriever', method: 'GET' }
        ]);
        expect(instructionBox().value).toBe(retrieverDefault);
        // R4: the added member's FULL prompt — identity AND its guideline bullet — lands in the
        // one box, and nothing else is rendered for comparison.
        expect(document.querySelector('.agent-detail')).toBeNull();

        // Moving between two filled tabs is free, in both directions.
        byClass('.agent-dialog-tab[data-agent="instruct"]', 'button').click();
        byClass('.agent-dialog-tab[data-agent="retriever"]', 'button').click();
        await flush();

        expect(server.agentDials()).toEqual([
            { url: '/v1/harness/agents/instruct', method: 'GET' },
            { url: '/v1/harness/agents/summarizer', method: 'GET' },
            { url: '/v1/harness/agents/retriever', method: 'GET' }
        ]);
        expect(instructionBox().value).toBe(retrieverDefault);
    });
});
