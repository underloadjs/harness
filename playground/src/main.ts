// Playground shell.
//
// Renders the harness presets, streams their `report.progress` events into a
// transcript log, and runs the selected harness from the composer. Nothing here
// is part of the published package: `package.json` ships `dist/` only.

import './styles.css';
import type { Harness, HarnessAssistantMessage, HarnessEvent } from '@underload/harness';
import { presets, type HarnessPreset, type PlaygroundSettings } from './presets';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const prettyArguments = (raw: string): string => {
    if (raw.trim().length === 0) return '(no arguments)';

    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
};

const describeDone = (message: HarnessAssistantMessage): string => {
    const parts = [message.model, message.stopReason];

    if (message.toolCalls.length > 0) {
        parts.push(`${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? '' : 's'}`);
    }

    if (message.usage !== undefined) {
        parts.push(`${message.usage.total} tokens`);
    }

    return parts.join(' · ');
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'underload-harness-playground:settings';

const DEFAULT_SETTINGS: PlaygroundSettings = {
    baseURL: 'http://localhost:5500/providers/private/v1',
    apiKey: '',
    model: 'merge/ds4-flash'
};

const loadSettings = (): PlaygroundSettings => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { ...DEFAULT_SETTINGS };

        const parsed = JSON.parse(raw) as Partial<PlaygroundSettings>;

        return {
            baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : DEFAULT_SETTINGS.baseURL,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_SETTINGS.apiKey,
            model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_SETTINGS.model
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
};

const settings = loadSettings();

const saveSettings = (): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Private browsing and blocked storage are not worth a dialog here.
    }
};

const signatureOf = (value: PlaygroundSettings): string =>
    `${value.baseURL}|${value.apiKey}|${value.model}`;

// ---------------------------------------------------------------------------
// One view per harness
// ---------------------------------------------------------------------------
//
// Each preset keeps its own log, so switching presets never destroys a
// conversation you wanted to compare against.

type Bubble = {
    body: HTMLElement;
    reasoning: HTMLElement;
    text: HTMLElement;
    meta: HTMLElement;
};

type View = {
    pane: HTMLElement;
    apply: (event: HarnessEvent) => void;
    clear: () => void;
    notice: (text: string) => void;
    setTranscript: (text: string) => void;
};

const createView = (preset: HarnessPreset): View => {
    const pane = el('div', 'pane');
    const logWrap = el('div', 'log-wrap');
    const log = el('div', 'log');

    const empty = el('div', 'empty');
    empty.append(
        el('h2', 'empty-title', preset.title),
        el('p', 'empty-text', preset.description),
        el('p', 'empty-hint', 'Send a prompt below. Every progress event the harness reports appears here.')
    );
    log.append(empty);

    const details = el('details', 'transcript');
    details.append(el('summary', 'transcript-summary', 'Entry agent transcript (agent.messages)'));
    const transcriptBody = el('pre', 'transcript-body', '[]');
    details.append(transcriptBody);

    logWrap.append(log);
    pane.append(logWrap, details);

    let bubbles = new Map<string, Bubble>();
    let started = false;

    const scroll = (): void => {
        logWrap.scrollTop = logWrap.scrollHeight;
    };

    const markStarted = (): void => {
        if (started) return;

        started = true;
        empty.remove();
    };

    const append = (node: HTMLElement): void => {
        markStarted();
        log.append(node);
        scroll();
    };

    const ensureBubble = (agentName: string): Bubble => {
        const existing = bubbles.get(agentName);
        if (existing !== undefined) return existing;

        const body = el('article', 'bubble');
        const head = el('div', 'bubble-head');
        head.append(el('span', 'bubble-agent', agentName));

        const reasoning = el('div', 'reasoning');
        const text = el('div', 'text');
        const meta = el('div', 'meta');

        body.append(head, reasoning, text, meta);
        markStarted();
        log.append(body);

        const bubble: Bubble = { body, reasoning, text, meta };
        bubbles.set(agentName, bubble);
        return bubble;
    };

    const divider = (label: string): HTMLElement => {
        const node = el('div', 'divider');
        node.append(el('span', 'divider-label', label));
        return node;
    };

    const apply = (event: HarnessEvent): void => {
        switch (event.type) {
            case 'start': {
                // A new turn begins; agent bubbles are per turn, not per harness.
                bubbles = new Map();
                append(divider(`${event.agent} · ${event.model}`));
                break;
            }

            case 'reasoning': {
                const bubble = ensureBubble(event.agent);
                bubble.reasoning.textContent += event.delta;
                scroll();
                break;
            }

            case 'text': {
                const bubble = ensureBubble(event.agent);
                bubble.text.textContent += event.delta;
                scroll();
                break;
            }

            case 'tool_call': {
                const card = el('div', 'card');
                card.append(el('div', 'card-head', `→ ${event.call.name}`));
                card.append(el('pre', 'card-body', prettyArguments(event.call.arguments)));
                append(card);
                break;
            }

            case 'tool_result': {
                const card = el('div', event.isError ? 'card is-error' : 'card');
                card.append(el('div', 'card-head', `← ${event.name}${event.isError ? ' (error)' : ''}`));
                card.append(el('pre', 'card-body', event.content.length > 0 ? event.content : '(empty result)'));
                append(card);
                break;
            }

            case 'done': {
                const bubble = ensureBubble(event.agent);
                bubble.body.classList.add('is-done');
                bubble.meta.textContent = describeDone(event.message);
                scroll();
                break;
            }

            case 'error': {
                const card = el('div', 'card is-error');
                card.append(el('div', 'card-head', 'error'));
                card.append(el('pre', 'card-body', event.error.message));
                append(card);
                break;
            }
        }
    };

    const clear = (): void => {
        bubbles = new Map();
        started = false;
        log.replaceChildren(empty);
        logWrap.scrollTop = 0;
    };

    const notice = (text: string): void => {
        append(divider(text));
    };

    return {
        pane,
        apply,
        clear,
        notice,
        setTranscript: (text) => {
            transcriptBody.textContent = text;
        }
    };
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('The playground needs an #app element.');

const topbar = el('header', 'topbar');
const brand = el('div', 'brand');
brand.append(
    el('span', 'brand-mark', '◍'),
    el('span', 'brand-name', '@underload/harness'),
    el('span', 'brand-sub', 'playground')
);

const statusPill = el('span', 'status', 'idle');
statusPill.dataset.state = 'idle';
topbar.append(brand, statusPill);

const layout = el('div', 'layout');

const sidebar = el('aside', 'sidebar');
sidebar.append(el('h2', 'sidebar-head', 'Harnesses'));

const presetList = el('div', 'presets');

const main = el('main', 'main');
const head = el('div', 'main-head');
const headTitle = el('h1', 'main-title', '');
const headDescription = el('p', 'main-description', '');
const headBadges = el('div', 'badges');
head.append(headTitle, headDescription, headBadges);

const stage = el('div', 'stage');

const composer = el('form', 'composer');
const input = el('textarea', 'input composer-input');
input.rows = 3;
input.placeholder = 'Ask the harness something…  (Enter to run, Shift+Enter for a newline)';
input.spellcheck = false;

const actions = el('div', 'composer-actions');
const runButton = el('button', 'button primary', 'Run');
runButton.type = 'submit';
const stopButton = el('button', 'button', 'Stop');
stopButton.type = 'button';
stopButton.disabled = true;
const resetButton = el('button', 'button', 'Reset');
resetButton.type = 'button';
actions.append(runButton, stopButton, resetButton);
composer.append(input, actions);

main.append(head, stage, composer);

const endpoint = el('section', 'endpoint');
endpoint.append(el('h2', 'sidebar-head', 'Endpoint'));

const field = (
    label: string,
    key: keyof PlaygroundSettings,
    type: string,
    placeholder: string
): HTMLElement => {
    const wrapper = el('label', 'field');
    wrapper.append(el('span', 'field-label', label));

    const control = el('input', 'field-input');
    control.type = type;
    control.value = settings[key];
    control.placeholder = placeholder;
    control.spellcheck = false;
    control.autocomplete = 'off';
    control.addEventListener('input', () => {
        settings[key] = control.value;
        saveSettings();
    });

    wrapper.append(control);
    return wrapper;
};

endpoint.append(
    field('Base URL', 'baseURL', 'text', 'http://localhost:5500/providers/private/v1'),
    field('API key', 'apiKey', 'password', 'optional'),
    field('Model', 'model', 'text', 'merge/ds4-flash'),
    el(
        'p',
        'field-hint',
        'Used by live presets. Changing it starts a fresh conversation on the next run. Values are saved in this browser only.'
    )
);

sidebar.append(presetList, endpoint);
layout.append(sidebar, main);
app.append(topbar, layout);

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

type Instance = {
    preset: HarnessPreset;
    view: View;
    harness?: Harness;
    signature?: string;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;

const ensureInstance = (preset: HarnessPreset): Instance => {
    const existing = instances.get(preset.name);
    if (existing !== undefined) return existing;

    const instance: Instance = { preset, view: createView(preset) };
    instances.set(preset.name, instance);
    return instance;
};

const ensureHarness = (instance: Instance): Harness => {
    const wanted = signatureOf(settings);
    if (instance.harness !== undefined && instance.signature === wanted) return instance.harness;

    const rebuilt = instance.harness !== undefined;

    // Reporting only happens while the harness is being called, so
    // `instance.harness` is always set by the time the sink runs.
    const built = instance.preset.create(settings, (event) => {
        instance.view.apply(event);

        if (instance.harness !== undefined) {
            instance.view.setTranscript(JSON.stringify(instance.harness.agent.messages, null, 2));
        }
    });

    instance.harness = built;
    instance.signature = wanted;

    if (rebuilt) {
        instance.view.notice('endpoint settings changed — new conversation');
        instance.view.setTranscript(JSON.stringify(built.agent.messages, null, 2));
    }

    return built;
};

// ---------------------------------------------------------------------------
// Preset selection
// ---------------------------------------------------------------------------

const buttons = new Map<string, HTMLButtonElement>();

const badge = (text: string): HTMLElement => el('span', 'badge', text);

const select = (instance: Instance): void => {
    current = instance;

    for (const [name, button] of buttons) {
        button.setAttribute('aria-pressed', name === instance.preset.name ? 'true' : 'false');
    }

    const { preset } = instance;
    headTitle.textContent = preset.title;
    headDescription.textContent = preset.description;
    headBadges.replaceChildren(
        badge(`agents: ${preset.agents.join(', ')}`),
        badge(`tools: ${preset.tools.length > 0 ? preset.tools.join(', ') : 'none'}`),
        badge(preset.requiresEndpoint ? 'needs endpoint' : 'offline')
    );

    stage.replaceChildren(instance.view.pane);
    stage.dataset.preset = preset.name;
    setStatus('idle');
};

for (const preset of presets) {
    const button = el('button', 'preset');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.append(
        el('span', 'preset-title', preset.title),
        el('span', 'preset-name', preset.name),
        el('span', 'preset-meta', preset.requiresEndpoint ? 'live' : 'offline · no endpoint')
    );
    button.addEventListener('click', () => select(ensureInstance(preset)));

    buttons.set(preset.name, button);
    presetList.append(button);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

let running = false;
let controller: AbortController | undefined;

const setBusy = (value: boolean): void => {
    running = value;
    runButton.disabled = value;
    stopButton.disabled = !value;
};

const setStatus = (state: 'idle' | 'running' | 'done' | 'error', detail?: string): void => {
    statusPill.dataset.state = state;
    statusPill.textContent = detail === undefined ? state : `${state} · ${detail}`;
};

const run = async (): Promise<void> => {
    const prompt = input.value.trim();
    if (running || prompt.length === 0) return;

    const instance = current;
    if (instance === undefined) return;

    if (instance.preset.requiresEndpoint && settings.baseURL.trim().length === 0) {
        instance.view.notice('set a base URL in Endpoint, then run again');
        setStatus('error', 'no endpoint');
        return;
    }

    let active: Harness;
    try {
        active = ensureHarness(instance);
    } catch (error) {
        instance.view.notice(`could not build the harness: ${messageOf(error)}`);
        setStatus('error', 'harness not built');
        return;
    }

    input.value = '';
    controller = new AbortController();
    setBusy(true);
    setStatus('running', instance.preset.name);

    try {
        const message = await active(prompt, { signal: controller.signal });
        setStatus('done', `${message.model} · ${message.stopReason}`);
    } catch (error) {
        setStatus('error', messageOf(error));
    } finally {
        controller = undefined;
        setBusy(false);
        input.focus();
    }
};

composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void run();
});

input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void run();
    }
});

stopButton.addEventListener('click', () => {
    controller?.abort();
});

resetButton.addEventListener('click', () => {
    const instance = current;
    if (instance === undefined) return;

    instance.harness?.reset();
    instance.view.clear();
    instance.view.setTranscript('[]');
    setStatus('idle');
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

select(ensureInstance(presets[0]));
input.focus();
