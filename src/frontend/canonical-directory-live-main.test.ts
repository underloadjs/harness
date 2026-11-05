// T38: the four behaviours the canonical directory + live surface must actually deliver.
//
// These are the product rules the shell had broken while the wire moved from the one legacy
// boot document to the composed canonical surface:
//
//   1. BOOT PICKS THE NEWEST CONVERSATION. `GET /sessions` answers `SessionSummary` rows —
//      snake_case stamps, NO turns (../shared/harness-api.ts:807-825). The shell ranks
//      "latest" with `recencyOf` (./main.ts:6809) on `updatedAt`/`createdAt`; those fields
//      only exist after the row is normalized, so an embedded row that was cast instead of
//      mapped ranked every conversation at recency 0 and the page's LAST row won.
//   2. A RESTORED RUNNING CONVERSATION IS WATCHED. `pendingOf` (./main.ts:7350) decides
//      whether `openSession` starts the observer, and the canonical live surface is the
//      `harness.v1` WebSocket (./view-shell.ts `observeView`; ./stream.ts:40-43 states there
//      is no SSE fallback). A row whose `queue_depth` never became `queueDepth` left the
//      session unwatched, which is what "reloaded a running chat and nothing streams" meant.
//   3. THE LIVE FRAME RELEASES THE PENDING LOCK. While work is pending the composer offers
//      STOP and `+ New session` is disabled (R4); the `session.updated` patch a settled
//      snapshot produces is what clears it. The case also pins the agent dialog's lifecycle
//      rule the old SSE-shaped fixture could never reach: starting a new conversation
//      dismisses the dialog instead of carrying it into an empty session.
//   4. THE AGENT WRITE USES THE CONTRACT'S FIELD NAMES. `UpdateHarnessRequest`
//      (../shared/harness-api.ts:488-499) is a CLOSED object whose maps are `agent_models`
//      and `agent_instructions`. Test 4 therefore bypasses the view adapter entirely: it
//      asserts the bytes the browser put on the wire, in the contract's own mount and
//      spelling, against an answer shaped like the server's.
//
// Run (focused):
//   npx vitest run --config src/frontend/vitest.config.ts canonical-directory-live-main.test.ts

import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

// T38: the stream double is resolved by a DYNAMIC import inside each live case, never
// statically. `vi.resetModules()` clears the registry, so a static import would configure the
// PREVIOUS `./stream` module instance while `main.ts` — imported after the reset — dials a
// fresh singleton that has no factory at all. That mismatch is indistinguishable from "the
// shell never subscribed", which is exactly the behaviour these cases assert (the same
// discipline `main-lazy-display.test.ts:521-525` documents). The TYPES are static: they are
// erased at compile time, so they cannot pin a stale instance.
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';

const installLiveStream = (options: HarnessStreamOptions): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

// The twin of that import: the singleton is process-wide, so the double is released through
// the SAME module instance the shell used, or it leaks into the next file's boot.
const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const SESSION_KEY = 'underload-harness-app:session';

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'summarizer'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'task', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer directly.', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', instruction: 'Compress notes.', guidelines: [] }
];

// A raw conversation record, in the shape the stubbed server's OWN route answers it; the
// adapter re-expresses it as the compiled document the shell consumes.
const snapshot = (id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id,
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        harnessDefinition: descriptor(),
        ...overrides
    }) as SessionSnapshot;

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

const newSessionButton = (): HTMLButtonElement => byClass('.new-session', 'button');

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
    // The stream singleton is process-wide (./stream.ts:647): leaving this file's double
    // configured hands the next test file's shell a socket that was never its own.
    await releaseLiveStream();
});

describe('the canonical directory', () => {
    it('opens the conversation the rows say is newest, not the row the page put last', async () => {
        // Three conversations, deliberately out of stamp order: the NEWEST is `s-newest`,
        // while the directory's own order ends on `s-oldest`. A row that was cast into the
        // shell's record instead of normalized ranks 0 (no camel stamps), and a rank-0 walk
        // with `>=` lands on the LAST row — the bug this test exists to keep fixed.
        const rows = [
            snapshot('s-middle', { updatedAt: 200, createdAt: 40 }),
            snapshot('s-newest', { updatedAt: 300, createdAt: 10 }),
            snapshot('s-oldest', { updatedAt: 100, createdAt: 5 })
        ];
        const opened: string[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: rows, agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });

                    for (const row of rows) {
                        if (url === `/api/sessions/${row.id}`) {
                            opened.push(row.id);

                            return json({ session: row });
                        }
                    }

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();

        // The newest conversation is the one the shell opened — first, and only.
        expect(opened[0]).toBe('s-newest');
        expect([...new Set(opened)]).toEqual(['s-newest']);
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-newest');
    });

    it('watches a restored conversation that is still running, over the canonical stream', async () => {
        const running = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        localStorage.setItem(SESSION_KEY, 's-live');
        // The live surface is the `harness.v1` socket; the double records exactly what the
        // shell subscribed to and folds any frame it is given through the server's projector.
        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => running });

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: [running], agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });
                    if (url === '/api/sessions/s-live') return json({ session: running });

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        // Exactly one session-scoped subscription, addressed to THIS conversation: an
        // unnormalized row left `pendingOf` false and the shell never dialed at all.
        expect(stream.subscriptions).toHaveLength(1);
        expect(stream.subscriptions[0]).toMatchObject({ scope: 'session', session_id: 's-live' });
        expect(stream.status()).toBe('open');

        // The pending lock is visible while the run is live: `+ New session` is disabled,
        // which is R4's rule and the state the case below releases.
        expect(newSessionButton().disabled).toBe(true);
    });

    it('releases the pending lock on the live frame that settles the run', async () => {
        // The conversation as the SERVER holds it. A settled frame is followed by a header
        // re-read (`session.updated` reconciles through `GET /sessions/:id`,
        // ./view-shell.ts:515-529), so the document and the frame have to move together —
        // exactly what a real server does, and what makes "pending cleared" a fact about the
        // shell rather than about a fixture that never changed its answer.
        let current = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        localStorage.setItem(SESSION_KEY, 's-live');
        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => current });

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: [current], agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });
                    if (url === '/api/sessions/s-live') return json({ session: current });

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        expect(newSessionButton().disabled).toBe(true);

        // The settled document: the same conversation, now idle. The double turns that raw
        // frame into the `session.updated` patch the real server puts on the wire, and the
        // header re-read that follows answers from the document the server now holds.
        current = snapshot('s-live', { status: 'idle', updatedAt: 900, createdAt: 1, turns: [] });
        stream.push([{ type: 'snapshot', session: current }]);
        await flush();
        await flush();

        // Pending is gone, so the create control is live again — and the agent dialog, which
        // belongs to the conversation being left, is dismissed by starting a fresh one.
        expect(newSessionButton().disabled).toBe(false);

        byClass('.agent-control-button', 'button').click();
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);

        newSessionButton().click();
        await flush();

        expect(document.querySelector('.dialog')).toBeNull();
    });
});

describe('the harness agent write', () => {
    it('PATCHes the definition with the contract field names, in the contract mount', async () => {
        const stored = descriptor({
            agentModels: { instruct: 'm2' },
            agentInstructions: { summarizer: 'Compress into one paragraph.' }
        }) as unknown as Record<string, unknown>;

        const calls: { url: string; method?: string; body: Record<string, unknown> }[] = [];

        // NO view adapter here on purpose: this is the byte-level contract check, so the
        // assertion sees the URL and body the browser itself produced.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

                calls.push({ url, method: init?.method, body });

                if (url === '/v1/harness') {
                    return json({
                        api_root: '/v1/harness',
                        service: 'harness',
                        api_version: 'v1',
                        server_time: 1,
                        epoch: 'e1',
                        capabilities: {},
                        limits: { page_limit: { default: 25, max: 100 } },
                        links: {}
                    });
                }
                if (url === '/v1/harness/config') {
                    return json({ defaults: { base_url: '', model: 'm1', has_api_key: false }, writable_fields: [], revision: 1 });
                }
                if (url.startsWith('/v1/harness/harnesses?')) return json({ items: [harnessCard(stored)], total: 1, has_more: false, next_cursor: null, revision: 1 });
                if (url.startsWith('/v1/harness/tools?')) return json({ items: [], total: 0, has_more: false, next_cursor: null, revision: 1 });
                if (url.startsWith('/v1/harness/agents?')) {
                    return json({
                        items: agents.map((agent) => ({ ...agent, has_instruction_override: false, has_global_override: false })),
                        total: agents.length,
                        has_more: false,
                        next_cursor: null,
                        revision: 1
                    });
                }
                if (url.startsWith('/v1/harness/sessions?')) return json({ items: [], total: 0, has_more: false, next_cursor: null, revision: 1 });
                if (url === '/v1/harness/models') return json({ models: ['m1', 'm2', 'm3'] });
                if (url === '/v1/harness/harnesses/instruct' && init?.method === undefined) {
                    return json({ harness: harnessDefinition(stored) });
                }
                if (url === '/v1/harness/harnesses/instruct/instructions/summarizer') {
                    return json({
                        harness_name: 'instruct',
                        agent: 'summarizer',
                        source: 'harness',
                        instruction: 'Compress into one paragraph.',
                        guidelines: [],
                        chars: 31
                    });
                }
                if (url === '/v1/harness/harnesses/instruct' && init?.method === 'PATCH') {
                    // The server replaces both maps wholesale, so the answer restates them.
                    return json({ harness: harnessDefinition({ ...stored, agentModels: { instruct: 'm3' } }, body) });
                }

                throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
            })
        );

        await import('./main');
        await flush();
        await flush();

        byClass('.agent-control-button', 'button').click();
        await flush();

        const select = byClass<HTMLSelectElement>('.agent-model-select[aria-label="Model for Instruct"]', 'select');
        // The stored override arrives from the identified read, not from the card.
        expect(select.value).toBe('m2');

        select.value = 'm3';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        byClass('.agent-dialog-apply', 'button').click();
        await flush();
        await flush();

        const writes = calls.filter((call) => call.method === 'PATCH');

        // ONE write, to the contract's own resource...
        expect(writes).toHaveLength(1);
        expect(writes[0]?.url).toBe('/v1/harness/harnesses/instruct');
        // ...and its body carries the contract's names, with the team restated and every
        // stored override kept (the server replaces the map, it does not merge it).
        expect(writes[0]?.body).toEqual({
            primary: 'instruct',
            subagents: ['summarizer'],
            agent_models: { instruct: 'm3' },
            agent_instructions: { summarizer: 'Compress into one paragraph.' }
        });

        byClass('.dialog-close', 'button').click();
    });
});

// A definition CARD, in the contract's snake_case spelling: identity, membership and the
// resolved tool set, and deliberately NOT `agent_models` / instruction text
// (../shared/harness-api.ts:418-433).
function harnessCard(definition: Record<string, unknown>): Record<string, unknown> {
    return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        requires_endpoint: definition.requiresEndpoint,
        primary: definition.primary,
        subagents: definition.subagents,
        agents: definition.agents,
        tools: definition.tools,
        builtin: definition.builtin,
        definition_revision: 1
    };
}

// The identified read of the same definition: the card plus the model map, the resolved
// core tools, and the instruction SUMMARY (provenance + length, never the text —
// ../shared/harness-api.ts:449-460), which is what tells the client whose prompt to fetch.
function harnessDefinition(definition: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown> {
    const models = (patch?.agent_models ?? definition.agentModels) as Record<string, string> | undefined;
    const instructions = (patch?.agent_instructions ?? definition.agentInstructions) as Record<string, string> | undefined;
    const members = (patch?.subagents ? [String(patch.primary), ...(patch.subagents as string[])] : (definition.agents as string[]));

    return {
        ...harnessCard({ ...definition, ...(patch === undefined ? {} : { agents: members }) }),
        core_tools: (definition.coreTools as string[]) ?? [],
        ...(models === undefined || Object.keys(models).length === 0 ? {} : { agent_models: models }),
        instruction_summary: members.map((agent: string) => {
            const override = instructions?.[agent];

            return {
                agent,
                source: override === undefined ? 'catalogue' : 'harness',
                overridden: override !== undefined,
                chars: (override ?? (agents.find((entry) => entry.name === agent)?.instruction ?? '')).length
            };
        })
    };
}
