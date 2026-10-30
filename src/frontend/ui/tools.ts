// Tool-call chips with dialog-only details.
//
// Every harness tool call arrives as two SSE events — `tool_call` (name +
// arguments) and later `tool_result` (name + content + isError) — and the result
// names the call it answers when the server sends `callId` (name+order is the
// documented fallback for an older server). This module owns one card per call,
// keeps its status in sync, and exposes the status in *text* so the colour is
// decoration rather than the only signal.
//
// Concurrency (R6): calls are scheduled concurrently, so a card can stay
// `running` after its agent has already answered (`done` with a non-empty
// `pending` list). Such a card is NOT an error: it keeps ticking until its own
// `tool_result` arrives. Only a terminal turn or an explicit cancel closes it,
// through `abandon()`: pending work is interrupted on cancel/restart, never
// resumed, so a settled tile must not leave a live-looking call behind.
//
// R12 — details are a MODAL, never an inline expansion:
//   - the summary is still the compact chip (arrow + name; state colour, state
//     word, duration and argument preview live in the DOM and in the aria-label);
//   - activating it (mouse, Enter or Space) calls `openDialog` from ui/dialog.ts;
//     the dialog adopts the very same `.tool-body` node, so arguments, the full
//     available result/error and live updates share one DOM source of truth;
//   - the native `<details>` toggle is cancelled (`preventDefault`) and a
//     `toggle` guard closes it again, so a stray default activation can never
//     reveal the body inline;
//   - while open the body has MOVED into the overlay (no duplicate, no clone, no
//     stale click handlers); on close it is appended back into the closed
//     `<details>`, which keeps it out of layout and keeps transcript consumers
//     (`turns.test.ts`) able to read `.tool-result` from the card;
//   - `resolve`/`abandon` write to that shared body, so a dialog opened before
//     completion updates live; the dialog title tracks `name · state` too.
//
// FILE LINKS (R11/R12): the argument/result code blocks are the same readable
// surfaces a user inspects in the modal, so local paths inside them use the SAME
// `enhanceFileLinks` transform as transcript prose. The transform is applied to the
// highlighted DOM BEFORE it is wrapped in `<pre><code>`: `file-links.ts` correctly
// treats code as literal text, but wrapping a path in a button inside a highlight
// span keeps every other token highlighted and adds no HTML parse path. A click is
// the only trigger: `openFilePreview` requests one bounded `fileRead` window.
// Tool content is NOT Markdown and is never parsed for images/markup; a literal
// image URL stays inert text (there is no sanitized `<img>` to enhance here).
//
// Accessibility: `<summary>` keeps its implicit keyboard activation; an explicit
// Enter/Space handler also works where a synthetic keydown is not turned into a
// click (jsdom, embedded webviews). `aria-haspopup="dialog"` advertises the modal,
// and `returnFocus` is the summary, so closing restores focus to that chip and
// never to the composer (ui/dialog.ts has no shell fallback).
//
// Consecutive calls are still grouped by turns.ts (`.tool-group`), which makes the
// chips flow horizontally and wrap.
//
// Cross-references:
//   - created by: src/frontend/ui/turns.ts (per-agent flow)
//   - modal shell/focus: src/frontend/ui/dialog.ts
//   - file links/preview: src/frontend/ui/file-links.ts, src/frontend/ui/file-preview.ts
//   - highlighting/sanitizing: src/frontend/ui/markdown.ts
//   - styles: src/frontend/styles.css (`.tool`, `.tool-*`, `.file-link`) and ui/dialog.css

import { callTool } from '../api';
import type { HarnessToolOutcome } from '../../types';
import { openDialog, type DialogHandle } from './dialog';
import { enhanceFileLinks } from './file-links';
import { openFilePreview, type FilePreviewReader, type FilePreviewResult } from './file-preview';
import { highlightCode, looksLikeJson, prettyJson } from './markdown';
import { formatDuration } from './time';

export type ToolState = 'running' | 'ok' | 'error' | 'cancelled';

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

// Optional collaborators for `createToolCallCard`. The transcript consumer
// (turns.ts) passes nothing and gets the browser adapter below; tests inject a
// deterministic stub so no request is issued.
export type ToolCallCardOptions = {
    // Bounded reader used by `openFilePreview` when a file link inside the modal's
    // argument/result code block is activated. Same contract as the transcript
    // reader in ui/turns.ts (`FilePreviewReader`).
    readFile?: FilePreviewReader;
};

// Browser adapter for the only file request this module can make. It mirrors
// main.ts's `readFileForPreview`: one POST to the existing direct tool endpoint,
// with the dialog's bounded window. It runs ONLY from a click on a file link; no
// path is read while building or replaying a card, and the browser never touches
// the filesystem itself.
const readFileForToolPreview: FilePreviewReader = async ({ path, startLine, maxLines }) => {
    const response = await callTool('fileRead', [{ path, startLine, maxLines }]);
    if (!response.ok) throw new Error(response.error.message);

    // ui/file-preview.ts reads the documented `files[]` shape structurally, so the
    // cast only carries the generic tool result across the endpoint boundary.
    return response.result as FilePreviewResult;
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
    // same call is ignored instead of overwriting the first answer. `outcome` is
    // the structured classification from the runtime (R1): a cancelled call shows
    // "cancelled", not "error". `durationMs` overrides the local measurement (used
    // when replaying `eventTimes`).
    resolve: (content: string, outcome: HarnessToolOutcome, durationMs?: number) => void;
    // Close a call that will never produce a result — the turn was cancelled,
    // failed, or ended while the call was still running (R6: pending work is
    // INTERRUPTED, never resumed). Without this the card kept saying `running`
    // and "Waiting for the harness…" on a settled tile, which was a lie.
    // Idempotent, and a no-op on a card that already resolved.
    abandon: (reason?: string) => void;
    // Stop the live timer. Called when the owning turn is cleared or the page is
    // hidden; a resolved card also stops it itself.
    destroy: () => void;
};

// A 250ms cadence keeps the tenth-of-a-second label honest while staying cheap:
// the label shows a sub-second value, so a one-second tick would visibly lag.
const DURATION_TICK_MS = 250;

const formatKnown = (milliseconds: number | undefined): string =>
    milliseconds === undefined ? '' : formatDuration(milliseconds);

// A direct-call result can be a whole file or a command log. `renderResultBlock`
// (the direct-call runner, not the transcript card) still caps its inline block
// past this size and shows the head plus a truncation note. The tool card itself
// no longer truncates (R12): its result only renders inside the modal dialog,
// where the body scrolls, so "full available result/error" means the whole text.
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
    error: 'error',
    cancelled: 'cancelled'
};

// The collapsed chip hides the visible state word (styles.css `.tool:not([open])`),
// so the summary carries an accessible equivalent. An `aria-label` replaces the
// summary's visible text for assistive technology, hence the tool name is repeated
// here verbatim — casing is preserved because it is the model-reported name.
const summaryLabel = (name: string, state: ToolState): string => `${name}: ${STATE_TEXT[state]}`;

// The glyph is `aria-hidden`: the adjacent text carries the meaning.
const STATE_GLYPH: Readonly<Record<ToolState, string>> = {
    running: '→',
    ok: '✓',
    error: '✕',
    // A call that was cut off: neither success nor tool failure, so it gets its
    // own muted glyph instead of borrowing the red error mark.
    cancelled: '⊘'
};

// `markdown.ts` (MAX_HIGHLIGHT_CHARS) stops highlighting past 40k and returns the
// head only. The modal is the ONLY place a result is readable (R12), so a longer
// payload must not silently lose its tail: above this size the block carries the
// complete text via `textContent` (automatically escaped, no HTML path) instead of
// asking the highlighter for a truncated render.
const MAX_HIGHLIGHT_CHARS = 40_000;

// `file-links.ts` scans candidate paths with a backtracking-friendly pattern. A
// pathological single token (a 40k run without whitespace/punctuation) makes that
// scan quadratic, so the tool dialog only enables links when every token is
// path-sized. Normal source/log/JSON text has short tokens; an oversized blob
// stays complete and readable, it simply gets no inline links.
const MAX_FILE_LINK_TOKEN_CHARS = 500;
const hasLinkSizedTokens = (text: string): boolean =>
    text
        .split(/[\s"'`<>()\[\]{},;:]+/)
        .every((token) => token.length <= MAX_FILE_LINK_TOKEN_CHARS);

// `openFile` is supplied only for the tool dialog's argument/result blocks. The
// transform runs on a detached highlighter host first (never inside `pre`/`code`,
// which `file-links.ts` deliberately treats as literal), then the SAME highlight
// spans are moved into `<code>`. Result: paths become real buttons without losing
// token highlighting, and no Markdown/HTML parser is introduced.
const createCodeBlock = (
    code: string,
    language: string | undefined,
    openFile?: (path: string) => void
): HTMLElement => {
    const pre = document.createElement('pre');
    pre.className = 'code-block';

    const block = document.createElement('code');
    block.className = language === undefined ? 'hljs' : `hljs language-${language}`;

    // Host for highlight nodes. It is off-document and NOT a `<pre>`/`<code>` so
    // `enhanceFileLinks` can see the text; every node it creates is safe DOM
    // (escaped text / buttons), so moving the children into `<code>` is safe.
    const highlighted = document.createElement('div');
    if (code.length > MAX_HIGHLIGHT_CHARS) {
        highlighted.textContent = code;
    } else {
        // `highlightCode` always escapes (or highlights) its input, so this
        // innerHTML never contains model-written markup.
        highlighted.innerHTML = highlightCode(code, language);
    }

    if (openFile !== undefined && hasLinkSizedTokens(highlighted.textContent ?? '')) {
        enhanceFileLinks(highlighted, { open: openFile });
    }

    block.replaceChildren(...highlighted.childNodes);
    pre.append(block);

    return pre;
};

export const createToolCallCard = (
    name: string,
    rawArguments: string,
    timing: ToolTiming = {},
    options: ToolCallCardOptions = {}
): ToolCallCard => {
    // Resolve the reader once per card. `openFile` is the only network path here:
    // it runs from a file-link click inside the modal, never from card creation,
    // `resolve`, replay or hydration.
    const readFile = options.readFile ?? readFileForToolPreview;
    const openFile = (path: string): void => {
        openFilePreview(path, { read: readFile });
    };

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
    summary.setAttribute('aria-label', summaryLabel(name, 'running'));
    // R12: activating the chip opens a modal, not an inline disclosure. The
    // attribute is what tells assistive technology which kind of popup to expect.
    summary.setAttribute('aria-haspopup', 'dialog');
    // `<summary>` is natively focusable, but an explicit tab stop makes focus
    // restoration deterministic in jsdom/embedded webviews too. It does not add a
    // second tab stop in browsers.
    summary.tabIndex = 0;

    // The detail body is built ONCE and lives inside the closed `<details>` while no
    // dialog is open (a closed details renders only its summary, so this is not an
    // in-flow detail area). Opening MOVES this exact node into the dialog; closing
    // moves it back. No cloning means no duplicate ids and no stale handlers, and
    // `resolve`/`abandon` always mutate the same live nodes.
    const body = document.createElement('div');
    body.className = 'tool-body';

    const argsSection = document.createElement('section');
    argsSection.className = 'tool-section';
    const argsLabel = document.createElement('div');
    argsLabel.className = 'tool-label';
    argsLabel.textContent = 'arguments';
    const argsCode = createCodeBlock(
        prettyJson(rawArguments),
        looksLikeJson(rawArguments) ? 'json' : undefined,
        openFile
    );
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

    // The open dialog handle, if any. Cleared in `onClose` so a close via Escape,
    // backdrop or the close button is indistinguishable from `handle.close()`.
    let dialog: DialogHandle | undefined;

    // Dialog heading doubles as the live status: `fileRead · running` ->
    // `fileRead · ok`. The chip remains the compact surface for scanning; the
    // modal title repeats the state in text because the modal covers the chip.
    const dialogTitle = (): string => `${name} · ${STATE_TEXT[current]}`;

    // Open (or re-focus) the shared detail dialog. The summary is the explicit
    // return-focus target: it exists for the whole life of the card, so focus can
    // never fall back to the composer (ui/dialog.ts has no shell fallback).
    const openDetails = (): void => {
        if (dialog !== undefined && dialog.isOpen) {
            dialog.element.focus({ preventScroll: true });
            return;
        }

        const handle = openDialog({
            title: dialogTitle(),
            // `dialog.ts` ADOPTS this node: the live body moves into `.dialog-body`.
            content: body,
            returnFocus: summary,
            onClose: () => {
                if (dialog === handle) dialog = undefined;
                // The overlay (and the body inside it) was removed. Return the body
                // to the closed card so `resolve`/`abandon` keep working while no
                // dialog is open and a reopen adopts the same up-to-date node.
                // A closed `<details>` renders only its summary, so this is never an
                // inline expansion.
                if (!element.contains(body)) element.append(body);
            }
        });

        dialog = handle;
    };

    // R12: a click on the chip opens the modal. Cancelling the default action stops
    // the native `<details>` toggle; `toggle` below is the second guard for a
    // synthetic/programmatic activation that never went through this listener.
    summary.addEventListener('click', (event) => {
        event.preventDefault();
        openDetails();
    });

    // Keyboard parity where a keydown is not translated into a click (jsdom,
    // embedded webviews). Real browsers fire a click for Enter/Space on `<summary>`;
    // `openDetails` is idempotent while a dialog is open, so a double activation
    // cannot stack two dialogs.
    summary.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        openDetails();
    });

    // Guard: whatever opened the `<details>` inline (legacy synthetic activation or
    // a stray `.open = true`), close it again immediately. The chip is always
    // compact; only the dialog shows details.
    element.addEventListener('toggle', () => {
        if (element.open) element.open = false;
    });

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

    // The card's visible state is the OUTCOME, not a boolean: a cancelled call is a
    // control outcome and must not borrow the red error mark (R1). `rejected` and
    // `failed` both read as "error" because both mean this call produced nothing
    // usable, while their difference stays in the result text and the event.
    const stateOfOutcome = (outcome: HarnessToolOutcome): ToolState => {
        if (outcome === 'completed') return 'ok';
        if (outcome === 'cancelled') return 'cancelled';

        return 'error';
    };

    const resolve = (content: string, outcome: HarnessToolOutcome, durationMs?: number): void => {
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

        current = stateOfOutcome(outcome);
        element.dataset.state = current;
        glyph.textContent = STATE_GLYPH[current];
        state.textContent = STATE_TEXT[current];
        summary.setAttribute('aria-label', summaryLabel(name, current));
        resultLabel.textContent =
            outcome === 'completed'
                ? 'result'
                : outcome === 'cancelled'
                  ? 'result · cancelled'
                  : 'result · error';

        // R12: the result only renders in the modal, which scrolls, so the whole
        // available payload/error is shown — no display truncation. An empty answer
        // still gets an explicit placeholder rather than an empty code block.
        const text = content.length > 0 ? content : '(empty result)';

        // Mutating the shared body is what makes an ALREADY-OPEN dialog update while
        // the call finishes: the node is inside `.dialog-body` at this moment.
        resultHolder.replaceChildren();

        // JSON results (most schema-shaped tools) get pretty-printed; anything
        // else is shown as-is with short-block language detection.
        resultHolder.append(
            createCodeBlock(prettyJson(text), looksLikeJson(text) ? 'json' : undefined, openFile)
        );

        // Recompute the summary so the compact card still answers "did it work and
        // what did it touch?" without opening the dialog. A cancelled call says so
        // instead of reporting a character count it does not have.
        peek.textContent =
            outcome === 'completed'
                ? `${previewArguments(rawArguments)} · ${text.length.toLocaleString()} chars`
                : `${previewArguments(rawArguments)} · ${
                      outcome === 'cancelled' ? 'cancelled' : 'failed'
                  }`;

        // A modal opened while the call was running now shows the settled state in
        // its title. The body was updated in place above, so no `update({content})`
        // is needed (which would have to re-adopt the same node anyway).
        if (dialog !== undefined && dialog.isOpen) dialog.update({ title: dialogTitle() });
    };

    // Interrupted call: freeze whatever span the card measured, then state WHY
    // there is no result. No server duration exists for a call that never
    // returned, so an unknown span stays hidden instead of becoming 0ms.
    const abandon = (reason = 'Interrupted before the call returned.'): void => {
        if (settled) return;
        settled = true;

        measured =
            timing.startedAt === undefined ? undefined : Math.max(0, Date.now() - timing.startedAt);

        stopTicker();
        paintDuration();

        current = 'cancelled';
        element.dataset.state = current;
        glyph.textContent = STATE_GLYPH[current];
        state.textContent = STATE_TEXT[current];
        // The collapsed chip hides the state word, so the accessible label carries
        // it (same rule as resolve).
        summary.setAttribute('aria-label', summaryLabel(name, current));
        resultLabel.textContent = 'result · cancelled';

        // Replace the "Waiting for the harness to run this call…" placeholder: a
        // card on a settled tile must not claim the harness may still run it.
        const note = document.createElement('p');
        note.className = 'tool-pending';
        note.textContent = reason;
        resultHolder.replaceChildren(note);

        peek.textContent = `${previewArguments(rawArguments)} · cancelled`;

        // Same live-update rule as `resolve`: an open dialog switches to the
        // cancelled title while the body already shows the interruption reason.
        if (dialog !== undefined && dialog.isOpen) dialog.update({ title: dialogTitle() });
    };

    return {
        element,
        name,
        ...(timing.callId === undefined ? {} : { callId: timing.callId }),
        state: () => current,
        durationMs: () => measured,
        resolve,
        abandon,
        destroy: () => {
            // Stop the live label first, then drop any dialog owned by this card. A
            // dialog left behind by a cleared turn would be an orphaned modal with a
            // stale focus trap; `onClose` also restores the body into the card.
            stopTicker();
            if (dialog !== undefined && dialog.isOpen) dialog.close();
        }
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
