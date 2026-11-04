// The configuration dialog reads the definition it edits (T11).
//
// A `/views` frame types `harnessDefinition` as a `HarnessDescriptor` but OMITS
// `agentInstructions` (../server/protocol.ts:655-663): per-agent instruction TEXT would
// otherwise ride every view frame, which is exactly the payload class the display wire exists
// to remove. So the shell may not assume the text the dialog's textarea is seeded with is the
// stored text — it has to ask, once, when the reader opens the dialog.
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
//     the view omitted would be silently wiped.
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
        coreTools: ['toolRequest', 'toolCreate', 'task', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

// The trusted library (GET /agents): what a member with NO stored override runs.
const agents = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer directly.', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', instruction: 'Compress notes into two sentences.', guidelines: [] }
];

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

/**
 * One stub for every test. `stored` is the definition only the GET route knows: the boot
 * document and every `/views` frame carry the descriptor WITHOUT `agentInstructions`, which is
 * what the real display wire does.
 */
const stub = (input: { stored?: Record<string, string>; status?: number; patches?: Record<string, unknown>[] } = {}) => {
    const { stored = {}, status = 200 } = input;
    const patches = input.patches ?? [];
    const reads: { url: string; method: string }[] = [];
    const bare = descriptor();
    // The frame the browser is given on boot: no instruction text anywhere.
    delete (bare as { agentInstructions?: unknown }).agentInstructions;

    vi.stubGlobal(
        'fetch',
        vi.fn(
            viewAwareFetch(async (url: string, init?: RequestInit) => {
                const method = init?.method ?? 'GET';
                reads.push({ url, method });

                if (url === '/api') return json({ rootPath: '/api', presets: [bare], tools: [], defaults, sessions: [], agents });
                if (url === '/api/models') return json({ models: ['m1'] });

                if (url === '/api/harnesses/instruct' && method === 'GET') {
                    if (status !== 200) return json({ error: { message: 'Use PATCH or DELETE for /api/harnesses/:name.' } }, status);

                    return json({ harness: descriptor({ agentInstructions: stored }) });
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
            })
        )
    );

    return { reads, patches, harnessReads: () => reads.filter((call) => call.method === 'GET' && call.url === '/api/harnesses/instruct') };
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
