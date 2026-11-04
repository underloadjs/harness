// Instruction-save wiring in the LIVE shell (T5 coverage gap: F2).
//
// `ui/agent-dialog.test.ts` pins the dialog layer (drafts, deltas, action labels) and
// `main.ts`'s `applyAgentConfiguration` is private, so the rule that actually matters
// — what ONE explicit apply puts on the wire — was only reviewed, never executed.
// These tests drive the real composer button, the real dropdown, the real textarea and
// the real action against a stubbed server, and assert the exact PATCH body:
//
//   - editing the selected agent's instruction and pressing the action is ONE
//     `PATCH /harnesses/:name` whose `agentInstructions` carries the new text MERGED
//     with every other member's stored override (the server replaces the map, so a
//     partial map would silently wipe the others);
//   - reverting an override to the trusted preset deletes that key, and clearing the
//     LAST override sends an explicit `{}` — not an omitted field, which would leave
//     the stale override stored forever;
//   - selecting an agent and typing sends nothing, and closing the dialog (Escape,
//     backdrop, or the close button) stays a no-op with the server's text restored on
//     the next open;
//   - a saved conversation refuses an instruction delta instead of reporting a save it
//     never made.

import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

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

// The TRUSTED library (GET /agents). An agent with no stored override runs exactly
// this text, so these strings are the revert targets the assertions below name.
const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'General agent.',
        instruction: 'Answer directly.',
        guidelines: []
    },
    {
        name: 'summarizer',
        title: 'Summarizer',
        description: 'Compresses notes.',
        instruction: 'Compress notes into at most two sentences.',
        guidelines: []
    },
    {
        name: 'critic',
        title: 'Critic',
        description: 'Reviews the answer.',
        instruction: 'Find problems.',
        guidelines: []
    }
];

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The dialog is reached the way a reader reaches it: the single composer button.
const openDialog = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

const instructionBox = (): HTMLTextAreaElement => {
    openDialog();
    return byClass('.agent-dialog-instruction', 'textarea');
};

const applyAction = (): HTMLButtonElement => {
    openDialog();
    return byClass('.agent-dialog-apply', 'button');
};

// Types the way the real editor does: the value moves first, then one `input` event.
// The dialog only DRAFTS on input, so nothing may reach the network here.
const typeInstruction = (text: string): void => {
    const box = instructionBox();
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
};

// The server's answer to a harness PATCH, shaped the way the real route answers: the
// descriptor with the posted maps, primary first in `agents`. `agentInstructions` is
// only echoed when the request carried it, which is exactly what makes the `{}` case
// observable — an omitted field must NOT look like a cleared map.
const patchedHarness = (body: Record<string, unknown>): HarnessDescriptor =>
    descriptor({
        agents: [body.primary as string, ...(body.subagents as string[])],
        primary: body.primary as string,
        subagents: body.subagents as string[],
        ...(body.agentModels === undefined ? {} : { agentModels: body.agentModels as Record<string, string> }),
        ...(body.agentInstructions === undefined
            ? {}
            : { agentInstructions: body.agentInstructions as Record<string, string> })
    });

// One stub for every test: boot + catalogue, plus a recording harness PATCH. Anything
// else (a premature write, a session PATCH, a second request) throws, which fails the
// test with the URL in the message instead of hiding the surprise.
const stubHarnessWrites = (initial: HarnessDescriptor) => {
    let current = initial;
    const patches: Record<string, unknown>[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [current] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2', 'm3'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                const body = JSON.parse(String(init.body)) as Record<string, unknown>;
                patches.push(body);
                current = patchedHarness(body);

                return json({ harness: current });
            }

            // T11: opening the configuration dialog reads ONE definition, because a `/views`
            // frame omits `agentInstructions` (../server/protocol.ts:655-663). The answer is
            // the same authoritative descriptor the catalogue holds, so a test that never opens
            // the dialog never sees this branch.
            if (url === '/api/harnesses/instruct' && init === undefined) return json({ harness: current });

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }))
    );

    return { patches, updated: () => current };
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    // A leaked modal owns the next test's Escape/focus handling.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    vi.unstubAllGlobals();
});

it('saves an edited instruction as one harness PATCH that keeps every other override', async () => {
    // A second member already carries an override. The PATCH must restate BOTH: the
    // server replaces the whole map, so a map without `summarizer` would wipe it.
    const { patches } = stubHarnessWrites(
        descriptor({ agentInstructions: { summarizer: 'Compress into one paragraph.' } })
    );

    await import('./main');
    await flush();
    await flush();

    const box = instructionBox();

    expect(box.getAttribute('aria-label')).toBe('Instruction for Instruct');
    expect(box.disabled).toBe(false);
    // No stored override for Instruct, so the editor is seeded with the trusted text.
    expect(box.value).toBe('Answer directly.');

    // Typing is a draft: the action wakes up, the network stays silent.
    typeInstruction('Answer in one sentence.');
    expect(patches).toEqual([]);

    const apply = applyAction();
    expect(apply.textContent).toBe('Save configuration');
    expect(apply.disabled).toBe(false);

    apply.click();
    await flush();
    await flush();

    // ONE request, and it carries the merged map plus the untouched team.
    expect(patches).toEqual([
        {
            primary: 'instruct',
            subagents: ['summarizer'],
            agentInstructions: {
                instruct: 'Answer in one sentence.',
                summarizer: 'Compress into one paragraph.'
            }
        }
    ]);

    // Confirmed: the dialog stays open, the note is the save line, no refusal is
    // painted, and the pill states the promise (new sessions, not this one).
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to new sessions'
    );
    expect(byClass('.agent-dialog-error', 'p').textContent).toBe('');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(byClass('.status', 'span').getAttribute('title')).toBe(
        'agent configuration saved · applies to new sessions'
    );

    // The refreshed dialog reads the SERVER's answer, and the stored override now has
    // an explicit revert affordance.
    expect(instructionBox().value).toBe('Answer in one sentence.');
    expect(byClass('.agent-dialog-revert', 'button').textContent).toBe('Use the preset instruction');
    expect(applyAction().disabled).toBe(true);
});

it('reverts one stored override to the trusted preset and keeps the other member intact', async () => {
    const { patches, updated } = stubHarnessWrites(
        descriptor({
            agentInstructions: {
                instruct: 'Answer in two paragraphs.',
                summarizer: 'Compress into one paragraph.'
            }
        })
    );

    await import('./main');
    await flush();
    await flush();

    // The editor shows the STORED override, not the preset, when one exists.
    expect(instructionBox().value).toBe('Answer in two paragraphs.');
    expect(byClass('.agent-dialog-instruction', 'textarea').getAttribute('title')).toBe(
        'This harness overrides the preset instruction. Clear the text to run the preset instruction again.'
    );
    expect(applyAction().disabled).toBe(true);

    byClass('.agent-dialog-revert', 'button').click();

    // The revert is a draft too: the box is cleared for the reader, nothing is sent.
    expect(instructionBox().value).toBe('');
    expect(patches).toEqual([]);
    expect(applyAction().disabled).toBe(false);

    applyAction().click();
    await flush();
    await flush();

    // The cleared key drops out of the map while the other member's override survives.
    expect(patches).toEqual([
        {
            primary: 'instruct',
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'Compress into one paragraph.' }
        }
    ]);
    expect(updated().agentInstructions).toEqual({ summarizer: 'Compress into one paragraph.' });

    // Instruct runs its trusted preset again: the editor falls back to the library
    // text and the revert control is gone because nothing is overridden any more.
    expect(instructionBox().value).toBe('Answer directly.');
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
});

it('sends an explicit empty agentInstructions map when the last override is reverted', async () => {
    const { patches, updated } = stubHarnessWrites(
        descriptor({ agentInstructions: { instruct: 'Answer in two paragraphs.' } })
    );

    await import('./main');
    await flush();
    await flush();

    // The dialog opens on the primary, whose stored override the reader can revert.
    openDialog();
    expect(instructionBox().value).toBe('Answer in two paragraphs.');

    byClass('.agent-dialog-revert', 'button').click();
    applyAction().click();
    await flush();
    await flush();

    // `{}` is MEANINGFUL: it clears the stored map. Omitting the field would leave the
    // override in place while the UI claimed the preset was running again.
    expect(patches).toEqual([
        { primary: 'instruct', subagents: ['summarizer'], agentInstructions: {} }
    ]);
    expect(Object.keys(patches[0])).toEqual(['primary', 'subagents', 'agentInstructions']);
    expect(updated().agentInstructions).toEqual({});
    // The refreshed dialog shows the trusted preset again, with nothing left to revert.
    expect(instructionBox().value).toBe('Answer directly.');
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
});

it('sends nothing while configuring and discards the drafts on every dismissal', async () => {
    const { patches } = stubHarnessWrites(
        descriptor({ agentInstructions: { summarizer: 'Compress into one paragraph.' } })
    );

    await import('./main');
    await flush();
    await flush();

    // R3: clicking a badge is a LOCAL view change (it neither promotes nor writes), and
    // typing on the way back is local too.
    openDialog();

    byClass('.agent-dialog-tab[data-agent="summarizer"]', 'button').click();
    expect(instructionBox().value).toBe('Compress into one paragraph.');
    // Viewing a teammate is not a team edit: the action has nothing to send.
    expect(patches).toEqual([]);
    expect(applyAction().disabled).toBe(true);

    byClass('.agent-dialog-tab[data-agent="instruct"]', 'button').click();
    typeInstruction('Answer in one sentence.');

    // The armed action states what closing costs, so the no-op is not a guess.
    expect(applyAction().getAttribute('title')).toBe(
        'Save this configuration. Closing the dialog saves nothing.'
    );
    expect(patches).toEqual([]);

    // --- dismissal 1: Escape ------------------------------------------------
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(byClass('.agent-control-button', 'button'));
    expect(patches).toEqual([]);

    // Reopening reads the server again: the typed draft is gone, not queued.
    openDialog();
    expect(instructionBox().value).toBe('Answer directly.');
    expect(applyAction().disabled).toBe(true);

    // --- dismissal 2: the backdrop ------------------------------------------
    typeInstruction('Answer in one sentence.');
    byClass('.dialog-overlay', 'div').click();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(patches).toEqual([]);

    // --- dismissal 3: the close button --------------------------------------
    openDialog();
    expect(instructionBox().value).toBe('Answer directly.');
    typeInstruction('Answer in one sentence.');
    byClass('.dialog-close', 'button').click();
    expect(document.querySelector('.dialog')).toBeNull();

    openDialog();
    expect(instructionBox().value).toBe('Answer directly.');
    expect(patches).toEqual([]);
});

it('refuses an instruction delta on a saved conversation instead of reporting it applied', async () => {
    // The frozen definition is what this conversation runs, overrides included. The
    // editor is rendered DISABLED, so the delta below can only come from a caller that
    // ignores the lock — and the write path must say so rather than save the models and
    // claim the whole draft landed.
    const frozen = descriptor({
        agentModels: { instruct: 'm2' },
        agentInstructions: { instruct: 'Answer in two paragraphs.' }
    });
    const saved = snapshot({
        id: 's9',
        status: 'idle',
        model: 'm1',
        agentModels: { instruct: 'm2', summarizer: 'm1' },
        harnessDefinition: frozen
    });

    localStorage.setItem(SESSION_KEY, 's9');

    const calls: { url: string; method: string | undefined; body: unknown }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({
                url,
                method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            if (url === '/api') return json(bootstrap({ presets: [frozen], sessions: [saved] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2', 'm3'] });
            if (url === '/api/sessions/s9') return json({ session: saved });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }))
    );

    await import('./main');
    await flush();
    await flush();

    // The lock is visible before anything is attempted: read-only instruction text,
    // no revert affordance, and the note that names the frozen conversation.
    const box = instructionBox();
    expect(box.disabled).toBe(true);
    expect(box.value).toBe('Answer in two paragraphs.');
    expect(box.getAttribute('title')).toBe(
        'A saved conversation runs the instructions it was created with. Edit them on the harness to use them in a new session.'
    );
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
    expect(applyAction().disabled).toBe(true);

    // A forbidden delta reaches the draft layer (a disabled control cannot be typed
    // into, so this is how a stale/foreign caller would hand one over).
    box.value = 'Answer in one sentence.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(applyAction().disabled).toBe(false);

    applyAction().click();
    await flush();
    await flush();

    // Nothing was written: neither the session's models nor the harness.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);

    // And the dialog is still open, still holding the draft, saying exactly why.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
        'This conversation keeps the instructions it was created with · save on the harness to use them in a new session.'
    );
    expect(instructionBox().value).toBe('Answer in one sentence.');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
});
