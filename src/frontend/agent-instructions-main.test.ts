// Instruction-save wiring in the LIVE shell (T5 coverage gap: F2, R4/R6 in T7b).
//
// `ui/agent-dialog.test.ts` pins the dialog layer (drafts, deltas, action labels) and
// `main.ts`'s `applyAgentConfiguration` is private, so the rule that actually matters
// — what ONE explicit apply puts on the wire — was only reviewed, never executed.
// These tests drive the real composer button, the real dropdown, the real textarea and
// the real action against a stubbed server, and assert the exact request:
//
//   - HARNESS TEMPLATE (no conversation open): editing the selected agent's instruction and
//     pressing the action is ONE `PATCH /harnesses/:name` whose `agentInstructions` carries the
//     new text MERGED with every other member's stored override (the server replaces the map, so
//     a partial map would silently wipe the others); clearing a stored override deletes that key,
//     and clearing the LAST one sends an explicit `{}` — not an omitted field, which would leave
//     the stale override stored forever;
//   - A SAVED CONVERSATION (T7b / R6): the same edit goes to
//     `PATCH /sessions/{id}/agents/{agent}` with the FULL text, the box is seeded from this
//     conversation's own live prompt (one read per roster member), a cleared box sends `null`
//     (restore the inherited prompt), and the harness template is NEVER written;
//   - selecting an agent and typing sends nothing, and closing the dialog (Escape, backdrop, or
//     the close button) stays a no-op with the server's text restored on the next open.
//
// R4 (T7a) removed the read-only "preset instruction" block and its revert control: there is ONE
// box, it holds the complete prompt the agent runs, and clearing its text by hand is the undo.

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
        coreTools: ['toolRequest', 'toolCreate', 'tasks', 'delegate'],
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

// The roster as the dialog lists it, and the agent its configuration panel describes. Same
// contract `main.test.ts` pins: the strip is the ONLY team listing, and `[+]` is the only route
// to an agent the team does not select (its press drafts the membership and moves the view).
const agentEntries = (): string[] => {
    openDialog();
    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map(
        (tab) => tab.dataset.agent ?? ''
    );
};
const configuredAgent = (): string | undefined => {
    openDialog();
    return document.querySelector<HTMLElement>('.agent-dialog-config')?.dataset.agent;
};
const selectConfigured = (name: string): void => {
    openDialog();
    byClass(`.agent-dialog-tab[data-agent="${name}"]`, 'button').click();
};
const addAgent = (name: string): void => {
    openDialog();
    byClass('.agent-dialog-add', 'button').click();
    byClass(`.agent-dialog-add-option[data-agent="${name}"]`, 'button').click();
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
        }, { root: '/api' }))
    );

    return { patches, updated: () => current };
};

// ---------------------------------------------------------------------------
// The saved-conversation stub (T7b / R5 + R6 + R7)
// ---------------------------------------------------------------------------
//
// The fixture declares ONLY the raw documents the shared double cannot invent: the boot page, the
// session record, and the harness card. Everything the conversation OWNS — its roster, each
// member's live prompt, the create/patch/delete answers, and the definition read that reflects
// them — is composed by ./view-test-support.ts's session-agent routes from the state the WRITES
// left behind. That is what makes these tests honest rather than self-confirming: the assertion
// "the added member is on screen afterwards" is answered by a roster/definition read that only
// knows the member because the POST moved it, exactly like the server
// (src/server/sessions.ts:5038-5091, src/server/api-session-agents.test.ts:341/663).
//
// `dials` is recorded OUTSIDE the adapter, on the function the browser actually called, so an
// assertion names the URL the SHELL sent (the contract mount `/v1/harness/...`) and not the raw
// probe the double re-read to compose its answer — the placement rule `main.test.ts:173-183`
// states. `extra` lets one test declare a route the composition would otherwise answer, which is
// how the 409 removal race is staged.
const stubSession = (
    frozen: HarnessDescriptor,
    input: {
        session?: SessionSnapshot;
        extra?: (url: string, method: string | undefined, body: unknown) => Response | undefined;
    } = {}
): { dials: { url: string; method: string; body: unknown }[] } => {
    const saved =
        input.session ??
        (snapshot({
            id: 's9',
            status: 'idle',
            model: 'm1',
            agentModels: { instruct: 'm2', summarizer: 'm1' },
            harnessDefinition: frozen
        }) as SessionSnapshot);

    const dials: { url: string; method: string; body: unknown }[] = [];

    const answer = viewAwareFetch(async (input2: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input2);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        const declared = input.extra?.(url, method, body);

        if (declared !== undefined) return declared;

        if (url === '/api') return json(bootstrap({ presets: [frozen], sessions: [saved] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2', 'm3'] });

        if (url === '/api/sessions/s9' && method === undefined) return json({ session: saved });

        // The live model map is the one field of the record a model save replaces (R2); the
        // conversation's team and prompts travel through the agent routes below instead.
        if (url === '/api/sessions/s9' && method === 'PATCH') {
            const patched = body as { agent_models?: Record<string, string> };

            return json({
                session: { ...saved, agentModels: patched.agent_models ?? saved.agentModels, updatedAt: 3 }
            });
        }

        // The template card: read for its colour map (T4) and never written by a conversation.
        if (url === '/api/harnesses/instruct' && method === undefined) return json({ harness: frozen });

        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input2: RequestInfo | URL, init?: RequestInit) => {
            dials.push({
                url: String(input2),
                method: init?.method ?? 'GET',
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            const resolved = answer(input2, init);

            return resolved instanceof Promise ? await resolved : resolved;
        })
    );

    return { dials };
};

// One dial of one canonical route, in the browser's own spelling. `?query` is dropped because the
// contract pages some reads and the assertions below are about WHICH resource moved, not the page.
const dials = (
    server: { dials: { url: string; method: string; body: unknown }[] },
    method: string,
    path: string
): { url: string; method: string; body: unknown }[] =>
    server.dials.filter(
        (call) => call.method === method && call.url.split('?')[0] === `/v1/harness${path}`
    );

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

    // Confirmed on screen: the refreshed box reads the SERVER's answer, R4 leaves no separate
    // revert affordance (the box's own text is the undo), and the action is asleep again because
    // nothing is pending any more.
    expect(instructionBox().value).toBe('Answer in one sentence.');
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
    expect(applyAction().disabled).toBe(true);
});

it('clears one stored override when the box is emptied and keeps the other member intact', async () => {
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

    // The editor shows the STORED override, not the default, when one exists. R4: the unlocked
    // sentence names the scope this write reaches, because a harness edit is a template edit.
    const box = instructionBox();
    expect(box.value).toBe('Answer in two paragraphs.');
    expect(box.getAttribute('title')).toBe(
        'The instruction this agent runs. Saved on this harness template for new sessions.'
    );
    expect(applyAction().disabled).toBe(true);

    // The undo is the box's own text: clearing it is a draft, exactly like typing into it.
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
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

    // Instruct runs its DEFAULT again: the editor falls back to the library's full prompt, and
    // there is nothing left to clear.
    expect(instructionBox().value).toBe('Answer directly.');
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
});

it('sends an explicit empty agentInstructions map when the last override is cleared', async () => {
    const { patches, updated } = stubHarnessWrites(
        descriptor({ agentInstructions: { instruct: 'Answer in two paragraphs.' } })
    );

    await import('./main');
    await flush();
    await flush();

    // The dialog opens on the primary, whose stored override the reader can clear by hand.
    openDialog();
    expect(instructionBox().value).toBe('Answer in two paragraphs.');

    const box = instructionBox();
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    applyAction().click();
    await flush();
    await flush();

    // `{}` is MEANINGFUL: it clears the stored map. Omitting the field would leave the override
    // in place while the UI claimed the default was running again.
    expect(patches).toEqual([
        { primary: 'instruct', subagents: ['summarizer'], agentInstructions: {} }
    ]);
    expect(Object.keys(patches[0])).toEqual(['primary', 'subagents', 'agentInstructions']);
    expect(updated().agentInstructions).toEqual({});
    // The refreshed dialog shows the default, with nothing left to clear.
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

it('saves an instruction on a saved conversation on the session agent, never on the harness', async () => {
    // T7b (R6): the conversation's own prompt is what the box holds, and the save writes it back
    // through `PATCH /sessions/{id}/agents/{agent}`. The harness template is a DIFFERENT fact —
    // its stored map says 'Template words.', and must never reach this conversation's editor or
    // receive this conversation's write.
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const server = stubSession(frozen, {
        // The only route declared beyond the base record: the template's stored instruction map,
        // which the identified read publishes and the session read must not inherit.
        extra: (url, method) =>
            url === '/api/harnesses/instruct' && method === undefined
                ? json({ harness: descriptor({ agentInstructions: { instruct: 'Template words.' } }) })
                : undefined
    });

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    // R6: opening the dialog is the explicit action that reads THIS conversation's roster, and
    // then one live prompt per member — never the template's map.
    openDialog();
    await flush();
    await flush();

    expect(dials(server, 'GET', '/sessions/s9/agents').length).toBe(1);
    expect(dials(server, 'GET', '/sessions/s9/agents/instruct/instruction').length).toBe(1);
    expect(dials(server, 'GET', '/sessions/s9/agents/summarizer/instruction').length).toBe(1);
    // The template read that fires on the same open is for its COLOUR map only (T4): a
    // conversation never inherits the template's stored prompts.
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);

    // The box is editable (a conversation edits its own prompts now), and its text is this
    // conversation's — the profile default, because nothing was stored here. The template's
    // 'Template words.' is absent from the screen.
    const box = instructionBox();
    expect(box.disabled).toBe(false);
    expect(box.value).toBe('Answer directly.');
    expect(box.getAttribute('title')).toBe('The instruction this agent runs in this conversation.');

    box.value = 'Answer in one sentence.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(dials(server, 'PATCH', '/sessions/s9/agents/instruct')).toEqual([]);

    applyAction().click();
    await flush();
    await flush();
    await flush();

    // ONE write, the full text verbatim (T6: the instruction IS the complete prompt), addressed to
    // this conversation's member.
    const writes = dials(server, 'PATCH', '/sessions/s9/agents/instruct');
    expect(writes).toEqual([
        { url: '/v1/harness/sessions/s9/agents/instruct', method: 'PATCH', body: { instruction: 'Answer in one sentence.' } }
    ]);
    // The harness template was read for its colours but NEVER written: a conversation's save does
    // not change the sessions the next reader starts.
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);
    expect(dials(server, 'PATCH', '/sessions/s9')).toEqual([]);

    // The scope is stated where the reader looks: the footer note and the app pill both say which
    // conversation this landed on.
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to this conversation'
    );
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(byClass('.status', 'span').getAttribute('title')).toBe(
        'agent configuration saved · applies to this conversation'
    );
    expect(byClass('.agent-dialog-error', 'p').textContent).toBe('');

    // And the refreshed box reads the CONVERSATION's new text back from the live route, not the
    // draft it held in flight.
    expect(instructionBox().value).toBe('Answer in one sentence.');
    expect(applyAction().disabled).toBe(true);
});

it('sends null for a cleared instruction so the conversation restores its default', async () => {
    // R4 + T6: an empty box is not "a prompt of nothing" — it is "no override here". The contract's
    // three states (../shared/harness-api.ts:1002-1011) say an explicit `null` clears the session
    // override and restores what the binding inherits, so that is the body the shell must send.
    const frozen = descriptor({ agentInstructions: { instruct: 'Answer in two paragraphs.' } });
    const server = stubSession(frozen);

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    const box = instructionBox();

    // The live read states this conversation's own text, which is what its member was created with.
    expect(box.value).toBe('Answer in two paragraphs.');

    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    applyAction().click();
    await flush();
    await flush();
    await flush();

    expect(dials(server, 'PATCH', '/sessions/s9/agents/instruct')).toEqual([
        { url: '/v1/harness/sessions/s9/agents/instruct', method: 'PATCH', body: { instruction: null } }
    ]);
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);

    // Cleared: the box shows what the binding INHERITS, not a blank and not the draft the reader
    // left behind. This member came from the harness definition, so the inherited prompt is the
    // definition's stored text — `null` restores a binding, it does not delete a prompt
    // (../shared/harness-api.ts:1002-1011).
    expect(instructionBox().value).toBe('Answer in two paragraphs.');
});

it('adds a catalogue agent to a saved conversation through the session roster', async () => {
    // T7b (R5/R7) with a trusted profile: membership is a SESSION write. One POST with the profile
    // name; the harness template keeps its two-member team.
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const server = stubSession(frozen);

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    addAgent('critic');
    expect(agentEntries()).toEqual(['instruct', 'summarizer', 'critic']);
    expect(dials(server, 'POST', '/sessions/s9/agents')).toEqual([]);

    applyAction().click();
    await flush();
    await flush();
    await flush();

    expect(dials(server, 'POST', '/sessions/s9/agents')).toEqual([
        { url: '/v1/harness/sessions/s9/agents', method: 'POST', body: { name: 'critic', profile: 'critic' } }
    ]);
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);

    // The roster the server now has is the roster on screen: the added member keeps its tab after
    // the refresh, and the composer's team follows it (T4: with its own deterministic tone).
    expect(agentEntries()).toEqual(['instruct', 'summarizer', 'critic']);
    expect(configuredAgent()).toBe('critic');
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to this conversation'
    );
});

it('adds an agent the catalogue never advertised, from a typed name', async () => {
    // T7b (R7): the `[+]` "New agent" form is the only way a conversation gains a member no profile
    // describes. Its typed instruction rides the CREATE (the server stores it as the whole prompt),
    // and the tab/header label is the name the reader typed (R4/T7b label rule).
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const server = stubSession(frozen);

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    openDialog();
    byClass('.agent-dialog-add', 'button').click();
    byClass('.agent-dialog-add-input', 'input').value = 'note-taker';
    byClass('.agent-dialog-add-create', 'button').click();

    expect(byClass('.agent-dialog-tab[data-agent="note-taker"] .agent-dialog-agent-name', 'span').textContent).toBe(
        'note-taker'
    );
    expect(instructionBox().value).toBe('');

    const box = instructionBox();
    box.value = 'Take verbatim notes.';
    box.dispatchEvent(new Event('input', { bubbles: true }));

    applyAction().click();
    await flush();
    await flush();
    await flush();

    // One create for a brand-new member — no separate instruction PATCH, and no harness write.
    expect(dials(server, 'POST', '/sessions/s9/agents')).toEqual([
        {
            url: '/v1/harness/sessions/s9/agents',
            method: 'POST',
            body: { name: 'note-taker', profile: 'note-taker', instruction: 'Take verbatim notes.' }
        }
    ]);
    expect(dials(server, 'PATCH', '/sessions/s9/agents/note-taker')).toEqual([]);
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);

    // The invented member survives the refresh as a real tab, with its own live prompt.
    expect(agentEntries()).toEqual(['instruct', 'summarizer', 'note-taker']);
    selectConfigured('note-taker');
    expect(instructionBox().value).toBe('Take verbatim notes.');
});

it('removes an agent from a saved conversation with one DELETE and no harness write', async () => {
    // T7b (R6): `Remove from team` detaches THIS conversation's member. The primary stays put, so
    // the removal is exercised on the secondary.
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const server = stubSession(frozen);

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    selectConfigured('summarizer');
    expect(byClass('.agent-dialog-remove', 'button').disabled).toBe(false);

    byClass('.agent-dialog-remove', 'button').click();
    expect(agentEntries()).toEqual(['instruct']);

    applyAction().click();
    await flush();
    await flush();
    await flush();

    expect(dials(server, 'DELETE', '/sessions/s9/agents/summarizer')).toEqual([
        { url: '/v1/harness/sessions/s9/agents/summarizer', method: 'DELETE', body: undefined }
    ]);
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);

    // The team the server reports is the team on screen, and the removed member's tab is gone
    // rather than resurrected by a refresh.
    expect(agentEntries()).toEqual(['instruct']);
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to this conversation'
    );
});

it('surfaces a 409 when a conversation starts using the agent mid-save, and keeps every draft', async () => {
    // T7b (R6): the dialog disables a member an existing conversation runs, so a DELETE that comes
    // back 409 is a RACE (a thread opened between the roster read and the save). The shell's job is
    // to report the server's reason honestly and lose nothing: no false "saved", no lost draft, no
    // closed modal. The 409 here is declared by the fixture, so the composed double cannot answer it.
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const refusal =
        'Agent "summarizer" still owns 1 conversation in session "s9": "thread-7". Delete those threads before removing the agent.';
    const server = stubSession(frozen, {
        extra: (url, method) =>
            url === '/api/sessions/s9/agents/summarizer' && method === 'DELETE'
                ? json({ error: { message: refusal } }, 409)
                : undefined
    });

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    selectConfigured('summarizer');
    byClass('.agent-dialog-remove', 'button').click();
    applyAction().click();
    await flush();
    await flush();
    await flush();

    // The refusal is the server's own sentence, in the dialog and on the pill…
    expect(byClass('.agent-dialog-error', 'p').textContent).toBe(refusal);
    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(byClass('.status', 'span').getAttribute('title')).toBe(`agent configuration: ${refusal}`);

    // …and the modal is still open with the removal still armed, because nothing was applied: the
    // strip keeps previewing the roster this save WOULD produce (the dialog's own draft rule), so
    // the reader can cancel it or try again without retyping anything.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(applyAction().disabled).toBe(false);
    expect(agentEntries()).toEqual(['instruct']);

    // The server's roster never moved. Dismissing drops the drafts, and the next open reads the
    // truth back: both members are still there, with the secondary's own live prompt.
    byClass('.dialog-close', 'button').click();
    await flush();
    openDialog();
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    selectConfigured('summarizer');
    expect(instructionBox().value).toBe('Compress notes into at most two sentences.');
});

it('refuses a roster write while a run is in flight, and keeps the models-only path open', async () => {
    // R2/R6: a saved conversation's MODELS stay live mid-run (the server reads the map per
    // request), but a roster or prompt write decides who runs the NEXT request, so the shell
    // refuses it in the same window the harness path names — before spending a request the server
    // would 409 anyway (src/server/sessions.ts `assertBindingIdle`).
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const running = snapshot({
        id: 's9',
        status: 'running',
        model: 'm1',
        agentModels: { instruct: 'm2', summarizer: 'm1' },
        harnessDefinition: frozen
    });
    const server = stubSession(frozen, { session: running });

    localStorage.setItem(SESSION_KEY, 's9');

    await import('./main');
    await flush();
    await flush();

    // The lock is visible first: the instruction editor carries the run's reason, not the scope
    // sentence, because right now nothing can be written but models.
    const box = instructionBox();
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('title')).toBe('Wait for the current run to finish before changing this instruction.');

    // A foreign/stale caller can still hand over a team delta; the write path refuses it.
    box.value = 'Answer in one sentence.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    applyAction().click();
    await flush();

    expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
        'Wait for the current run to finish before saving agents.'
    );
    expect(dials(server, 'PATCH', '/sessions/s9/agents/instruct')).toEqual([]);
    expect(dials(server, 'PATCH', '/harnesses/instruct')).toEqual([]);
    expect(instructionBox().value).toBe('Answer in one sentence.');
});

