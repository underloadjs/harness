// Collapsible tool-call cards.
//
// Every harness tool call arrives as two SSE events — `tool_call` (name +
// arguments) and later `tool_result` (name + content + isError) — and neither
// shares a call id with the other on the wire. This module owns one card per
// call, keeps its status in sync, and exposes the status in *text* so the colour
// is decoration rather than the only signal.
//
// Semantics: `details/summary` gives collapse/expand, keyboard support and
// screen-reader semantics for free. Nothing is auto-opened: a log with fifty
// tool calls must stay scannable, and each summary already answers "what ran and
// did it work?".
//
// Cross-references:
//   - created by: playground/src/ui/turns.ts (per-agent flow)
//   - highlighting/sanitizing: playground/src/ui/markdown.ts
//   - styles: playground/src/styles.css (`.tool`, `.tool-*`)

import { highlightCode, looksLikeJson, prettyJson } from './markdown';
import { formatDuration } from './time';

export type ToolState = 'running' | 'ok' | 'error';

// Timing for one call:
//   - `callId` comes from `tool_call.call.id` and is what a server that sends
//     `tool_result.callId` matches on;
//   - `startedAt` is the epoch-ms the call was observed (server `at` for a live
//     frame, an `eventTimes` entry on hydration, or the local clock as fallback);
//   - passing `startedAt` starts the live ticking label. Hydration resolves the
//     card immediately, so the interval never survives the replay.
export type ToolTiming = {
    callId?: string;
    startedAt?: number;
};

export type ToolCallCard = {
    // The card itself, appended to the agent's flow.
    element: HTMLDetailsElement;
    // Tool name, as reported by the model.
    name: string;
    // Call id when the server supplied one; matching falls back to the name.
    callId?: string;
    // Current state; also mirrored into `data-state` for CSS.
    state: () => ToolState;
    // Final duration in ms, once known. Undefined for a legacy record with no
    // timing data — never NaN.
    durationMs: () => number | undefined;
    // Attach the matching `tool_result`. Idempotent: a duplicate result for the
    // same call is ignored instead of overwriting the first answer. `durationMs`
    // overrides the local measurement (used when replaying `eventTimes`).
    resolve: (content: string, isError: boolean, durationMs?: number) => void;
    // Stop the live timer. Called when the owning turn is cleared or the page is
    // hidden; a resolved card also stops it itself.
    destroy: () => void;
};

// A 250ms cadence keeps the tenth-of-a-second label honest while staying cheap:
// the label shows a sub-second value, so a one-second tick would visibly lag.
const DURATION_TICK_MS = 250;

const formatKnown = (milliseconds: number | undefined): string =>
    milliseconds === undefined ? '' : formatDuration(milliseconds);

// A tool result can be a whole file or a command log. Past this size the card
// shows the head plus a truncation note: the transcript stays responsive and the
// full answer is still available in the entry-agent transcript pane.
const MAX_RESULT_CHARS = 20_000;

// One-line argument preview for the collapsed summary. Uses the compact JSON form
// (no indentation) so wide payloads lose as little as possible, then trims.
const previewArguments = (raw: string, limit = 96): string => {
    const compact = raw.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return '(no arguments)';

    return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
};

// Human-readable status text. This is what makes the state accessible without
// relying on the glyph colour.
const STATE_TEXT: Readonly<Record<ToolState, string>> = {
    running: 'running',
    ok: 'ok',
    error: 'error'
};

// The glyph is `aria-hidden`: the adjacent text carries the meaning.
const STATE_GLYPH: Readonly<Record<ToolState, string>> = {
    running: '→',
    ok: '✓',
    error: '✕'
};

const createCodeBlock = (code: string, language: string | undefined): HTMLElement => {
    const pre = document.createElement('pre');
    pre.className = 'code-block';

    const block = document.createElement('code');
    // `highlightCode` always escapes (or highlights) its input, so this innerHTML
    // never contains model-written markup.
    block.className = language === undefined ? 'hljs' : `hljs language-${language}`;
    block.innerHTML = highlightCode(code, language);
    pre.append(block);

    return pre;
};

export const createToolCallCard = (
    name: string,
    rawArguments: string,
    timing: ToolTiming = {}
): ToolCallCard => {
    const element = document.createElement('details');
    element.className = 'tool';
    element.dataset.state = 'running';
    if (timing.callId !== undefined) element.dataset.callId = timing.callId;

    const summary = document.createElement('summary');
    summary.className = 'tool-summary';

    const glyph = document.createElement('span');
    glyph.className = 'tool-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = STATE_GLYPH.running;

    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = name;

    const state = document.createElement('span');
    state.className = 'tool-state';
    state.textContent = STATE_TEXT.running;

    // Elapsed time is its own element: `running · 1.2s`, then the frozen final
    // span once the result lands. Always text, never colour-only.
    const duration = document.createElement('span');
    duration.className = 'tool-duration';

    const peek = document.createElement('span');
    peek.className = 'tool-peek';
    peek.textContent = previewArguments(rawArguments);

    summary.append(glyph, label, state, duration, peek);

    const body = document.createElement('div');
    body.className = 'tool-body';

    const argsSection = document.createElement('section');
    argsSection.className = 'tool-section';
    const argsLabel = document.createElement('div');
    argsLabel.className = 'tool-label';
    argsLabel.textContent = 'arguments';
    const argsCode = createCodeBlock(prettyJson(rawArguments), looksLikeJson(rawArguments) ? 'json' : undefined);
    argsSection.append(argsLabel, argsCode);

    const resultSection = document.createElement('section');
    resultSection.className = 'tool-section';
    const resultLabel = document.createElement('div');
    resultLabel.className = 'tool-label';
    resultLabel.textContent = 'result · pending';
    const resultHolder = document.createElement('div');
    resultHolder.className = 'tool-result';
    const pending = document.createElement('p');
    pending.className = 'tool-pending';
    pending.textContent = 'Waiting for the harness to run this call…';
    resultHolder.append(pending);
    resultSection.append(resultLabel, resultHolder);

    body.append(argsSection, resultSection);
    element.append(summary, body);

    let current: ToolState = 'running';
    let settled = false;

    // Live label. Only starts when the caller supplied a start stamp; a recorded
    // replay without `eventTimes` passes none, so no duration is invented.
    let measured: number | undefined;
    let ticker: number | undefined;

    const paintDuration = (): void => {
        const now = Date.now();
        const live = measured ?? (timing.startedAt === undefined ? undefined : Math.max(0, now - timing.startedAt));
        duration.textContent = formatKnown(live);
        duration.hidden = live === undefined;
    };

    const stopTicker = (): void => {
        if (ticker !== undefined) {
            window.clearInterval(ticker);
            ticker = undefined;
        }
    };

    if (timing.startedAt !== undefined) {
        paintDuration();
        ticker = window.setInterval(paintDuration, DURATION_TICK_MS);
    } else {
        duration.hidden = true;
    }

    const resolve = (content: string, isError: boolean, durationMs?: number): void => {
        if (settled) return;
        settled = true;

        // Prefer the caller's authoritative span (server `eventTimes`); otherwise
        // freeze the local measurement at the moment the result arrived.
        measured =
            durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
                ? durationMs
                : timing.startedAt === undefined
                  ? undefined
                  : Math.max(0, Date.now() - timing.startedAt);

        stopTicker();
        paintDuration();

        current = isError ? 'error' : 'ok';
        element.dataset.state = current;
        glyph.textContent = STATE_GLYPH[current];
        state.textContent = STATE_TEXT[current];
        resultLabel.textContent = isError ? 'result · error' : 'result';

        const text = content.length > 0 ? content : '(empty result)';
        const shown = text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text;

        resultHolder.replaceChildren();

        // JSON results (most schema-shaped tools) get pretty-printed; anything
        // else is shown as-is with short-block language detection.
        resultHolder.append(
            createCodeBlock(prettyJson(shown), looksLikeJson(shown) ? 'json' : undefined)
        );

        if (shown.length < text.length) {
            const note = document.createElement('p');
            note.className = 'tool-note-inline';
            note.textContent = `Truncated display: showing ${shown.length.toLocaleString()} of ${text.length.toLocaleString()} characters. The full result is in the transcript below.`;
            resultHolder.append(note);
        }

        // Recompute the summary so the collapsed card still answers "did it work
        // and what did it touch?" without expanding.
        peek.textContent = isError
            ? `${previewArguments(rawArguments)} · failed`
            : `${previewArguments(rawArguments)} · ${text.length.toLocaleString()} chars`;
    };

    return {
        element,
        name,
        ...(timing.callId === undefined ? {} : { callId: timing.callId }),
        state: () => current,
        durationMs: () => measured,
        resolve,
        destroy: stopTicker
    };
};

// Small helper the direct-call runner reuses so its JSON result looks exactly
// like a tool result inside a turn.
export const renderResultBlock = (value: unknown, isError: boolean): HTMLElement => {
    const wrapper = document.createElement('div');
    wrapper.className = isError ? 'tool-result is-error' : 'tool-result';

    let text: string;
    try {
        text = value === undefined ? 'undefined' : (JSON.stringify(value, null, 2) ?? String(value));
    } catch {
        text = String(value);
    }

    const shown = text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text;
    wrapper.append(createCodeBlock(shown, looksLikeJson(shown) ? 'json' : undefined));

    if (shown.length < text.length) {
        const note = document.createElement('p');
        note.className = 'tool-note-inline';
        note.textContent = `Truncated display: showing ${shown.length.toLocaleString()} of ${text.length.toLocaleString()} characters.`;
        wrapper.append(note);
    }

    return wrapper;
};
