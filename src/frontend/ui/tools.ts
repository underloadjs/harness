// Tool-call chips with dialog-only details, plus the reasoning ("think") chip that
// shares that exact anatomy.
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
//   - the summary is still the compact chip (arrow + name); the state word and the
//     argument preview live in the DOM and in the aria-label, and styles.css keeps
//     them hidden while the chip is collapsed;
//   - R2/T2: EVERY chip carries its OWN elapsed-duration label INLINE, right after the
//     name, so the collapsed chip reads `[Search 1.3s]` at its intrinsic width. It used to
//     be an absolutely positioned corner overlay, which forced the summary to reserve
//     ~76px of dead space so the pill could never paint over the name — that reservation
//     is what made every chip look stretched. In flow, the label's own width is the only
//     width the chip has; `formatToolDuration` keeps the value at a fixed character count
//     for any given magnitude (and styles.css uses tabular figures), so the only reflow is
//     the rare digit-count step (`9.9s` -> `10.0s`). The pill is padded clear of the name
//     by the summary's flex gap, is never clipped, and stays `[hidden]` when there is no
//     honest span (never an invented `0.0s`);
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
// R3 — the tool dialog has NO whole-dialog Copy. Each pane heading is
//   `arguments [icon]` / `result [icon]`, and an icon copies ONLY that pane's
//   ORIGINAL payload (full, untruncated, click-time fresh): the arguments exactly as
//   the model sent them and the whole result/error/interruption text. Nothing is
//   concatenated with the tool name, the state word or the other pane. The control
//   itself is `createTextCopyButton` from ui/dialog.ts — the shared icon button whose
//   clipboard write also works on the insecure LAN origin (textarea fallback with the
//   modal focus trap held open), which is the part every hand-rolled copy got wrong.
//
// R4 — the two panes are framed, syntax-highlighted code views with a NUMBER GUTTER
//   and SOFT WRAP (`white-space: normal` on the block, `pre-wrap` per row), so a long
//   line or URL wraps instead of pushing a horizontal scrollbar onto the dialog on
//   any width. Vertical scrolling stays. See `splitIntoLines`/`CODE_LINE_CLASS` for
//   how one logical line stays one numbered row however many visual rows it wraps
//   into, and why `<code> textContent` (hence every consumer and every copy) is still
//   byte-identical to the payload. The rules are scoped to `.tool-code`, so Markdown
//   fences keep their existing sideways-scroll behaviour.
//
// FILE LINKS (R11/R12): the argument/result code blocks are the same readable
// surfaces a user inspects in the modal, so local paths inside them use the SAME
// `enhanceFileLinks` transform as transcript prose. The transform is applied to the
// highlighted DOM BEFORE it is wrapped in `<pre><code>`: `file-links.ts` correctly
// treats code as literal text, but wrapping a path in a button inside a highlight
// span keeps every other token highlighted and adds no HTML parse path. A click is
// the only trigger: `openFilePreview` requests one bounded `read` window.
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
// THE THINK CHIP (`createReasoningCard`): a streamed reasoning round uses the SAME
//   chip-plus-dialog anatomy as a tool call, so it sits INLINE in the `.tool-group` row
//   instead of being a full-width block that breaks it. It is labelled `think` (the
//   requested word, not `reasoning`), is painted amber, and its pill shows the share of
//   the block's accumulated CONTEXT the round occupies — not a character count, because
//   what matters is how much context the thinking is using. Its whole text is readable in
//   the dialog with its own per-pane Copy. See the section above `THINK_LABEL`.
//
// Cross-references:
//   - created by: src/frontend/ui/turns.ts (per-agent flow)
//   - modal shell/focus: src/frontend/ui/dialog.ts
//   - file links/preview: src/frontend/ui/file-links.ts, src/frontend/ui/file-preview.ts
//   - highlighting/sanitizing: src/frontend/ui/markdown.ts
//   - styles: src/frontend/styles.css (`.tool`, `.tool-*`, `.file-link`) and ui/dialog.css

import { callTool } from '../api';
import type { HarnessToolOutcome } from '../../types';
import { createTextCopyButton, openDialog, type DialogHandle } from './dialog';
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
    const response = await callTool('read', [{ path, startLine, maxLines }]);
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

// Badge text for one measured span: SECONDS with one decimal (`0.8s`), which is the
// unit a tool call is judged in. `formatDuration` (ui/time.ts) renders sub-second
// spans as whole milliseconds (`812ms`); that is right for the turn clock and the
// retry line, and changing it would move those unrelated surfaces — so the badge
// gets its own formatter here instead.
//
// Exact contract (R6):
//   - `undefined` (no honest span)          -> ''  — the caller hides the badge;
//   - non-finite / negative (clock skew, a malformed frame) -> ''  — never "NaN";
//   - 0 (a real, sub-millisecond call)     -> '0.0s' — zero is a measurement, not a gap;
//   - 1..999ms                             -> tenths of a second, e.g. 800 -> '0.8s';
//   - 1s..59.999s                          -> '2.0s' (delegates, already tenths);
//   - >=60s                                -> '4m12s' (delegates), so a long call
//     never becomes an unreadable `252.0s`.
//
// Width contract for the inline label (R2/T2): the delegated minutes form has NO
// hours unit, so the string keeps growing with the minutes — 6 chars `59m59s`,
// 7 chars `600m00s` (10h), 8 chars `5999m00s` (99.98h). The label flows inside the chip,
// so a pathological run past 99 hours simply takes more of the chip (the tool NAME is the
// item that ellipsises, and the chip is capped at the row's width); the format itself is
// shared with the turn clock and the retry line, so it is deliberately NOT shortened here
// (that would move those surfaces).
export const formatToolDuration = (milliseconds: number | undefined): string => {
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
    if (milliseconds < 1000) return `${(milliseconds / 1000).toFixed(1)}s`;

    return formatDuration(milliseconds);
};

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
//
// The duration badge is part of the VISIBLE collapsed chip (R5), so the label
// repeats it once the call settles (`read: ok · 0.8s`). A RUNNING span is left out
// on purpose: it changes every 250ms, and an accessible name that churns that often
// is chatter, not information.
const summaryLabel = (name: string, state: ToolState, spanText = ''): string =>
    spanText.length === 0
        ? `${name}: ${STATE_TEXT[state]}`
        : `${name}: ${STATE_TEXT[state]} · ${spanText}`;

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

// --- Code-pane layout (R4) -------------------------------------------------
//
// The viewer is pure DOM assembly (`createElement` / `createTextNode`), so the
// formatted view adds NO HTML parse path of its own: whatever escaping
// `highlightCode` applied stays applied, and model-written markup can never become
// an element here. That is the same security model ui/markdown.ts documents
// (highlight-then-sanitize), narrowed to the one surface that needs line rows.

// One logical line of a pane. styles.css makes it a block, gives it the hanging
// gutter, and prints its number with a CSS counter (`::before`):
//   - generated content is not a text node, so it never lands in `textContent` and
//     never lands in a mouse selection — "line numbers are not copied";
//   - the counter is per ELEMENT, so a line that soft-wraps into three visual rows
//     is numbered exactly once, and the wrapped rows stay in the text column.
const CODE_LINE_CLASS = 'code-line';

// The separator between two rows. It exists ONLY so `<code> textContent` reproduces
// the payload (`row0 + "\n" + row1 + …`); `display: none` in styles.css takes it out
// of layout, which keeps a block row from doubling its own line height and removes
// any dependence on how a browser collapses whitespace between block boxes.
const CODE_BREAK_CLASS = 'code-break';

// A gutter narrower than two characters looks broken next to one- and two-digit
// numbers; wider gutters are what the row count actually needs.
const MIN_GUTTER_DIGITS = 2;

const createLineBreak = (): HTMLElement => {
    const separator = document.createElement('span');
    separator.className = CODE_BREAK_CLASS;
    // The character itself, kept out of layout by the class above.
    separator.textContent = '\n';
    return separator;
};

// Splits a highlighted/enhanced fragment into LOGICAL lines, in payload order.
//
// Two rules make this both faithful and cheap:
//   1. A node whose own text contains no newline is MOVED, never cloned. That is
//      what keeps a `file-link` button's click handler (and its `data-path`) alive
//      through the re-layout — the button is one atomic run of text on one line.
//   2. Only an ancestor whose text spans several lines is rebuilt per line, as a
//      bare clone (tag + attributes) opened lazily on the row that needs it. A token
//      span must not cross a row boundary: an unclosed span would break both the
//      soft wrap and the numbering, and the gutter would land in the wrong place.
//
// Document order is preserved even when a text node ends mid-line and a following
// sibling continues the next line (the case a naive per-parent merge gets wrong).
// Returns one DocumentFragment per logical line, so the caller's row count is
// exactly `code.split('\n').length`.
const splitIntoLines = (host: HTMLElement): DocumentFragment[] => {
    const rows: DocumentFragment[] = [document.createDocumentFragment()];
    // The chain of multi-line ancestors the cursor is currently inside, outermost
    // first. Every append resolves it, because the row (and therefore the clone
    // chain) moves underneath it while a multi-line token is being laid out.
    const chain: Element[] = [];
    // The last clone opened for one ancestor on one row. The walk is monotonic in
    // row order, so one entry per element is enough to reuse that row's clone.
    const openClones = new Map<Element, { row: number; clone: HTMLElement }>();
    let row = 0;

    const ensureRow = (index: number): void => {
        while (rows.length <= index) rows.push(document.createDocumentFragment());
    };

    // A tag + attributes copy with no children: enough to keep token colours (and
    // `class`/`data-*`) while letting each row own a balanced subtree.
    const shellOf = (element: Element): HTMLElement => {
        const copy = document.createElement(element.tagName);
        for (const attribute of Array.from(element.attributes)) {
            copy.setAttribute(attribute.name, attribute.value);
        }
        return copy;
    };

    const append = (node: Node): void => {
        let target: ParentNode = rows[row];
        for (const ancestor of chain) {
            const entry = openClones.get(ancestor);
            if (entry === undefined || entry.row !== row) {
                const clone = shellOf(ancestor);
                openClones.set(ancestor, { row, clone });
                target.append(clone);
                target = clone;
                continue;
            }
            target = entry.clone;
        }
        target.append(node);
    };

    const place = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const segments = (node.textContent ?? '').split('\n');
            segments.forEach((segment, index) => {
                // The newline itself is not placed here: `createLineBreak` puts it
                // between the finished rows, which keeps the payload byte-exact while
                // leaving the row content free of stray breaks.
                if (index > 0) {
                    row += 1;
                    ensureRow(row);
                }
                if (segment.length === 0) return;
                append(document.createTextNode(segment));
            });
            return;
        }

        const element = node as Element;
        if ((element.textContent ?? '').indexOf('\n') < 0) {
            append(element);
            return;
        }

        chain.push(element);
        for (const child of Array.from(element.childNodes)) place(child);
        chain.pop();
    };

    for (const child of Array.from(host.childNodes)) place(child);

    return rows;
};

// --- Panes (R3/R4) ---------------------------------------------------------

// The heading row of one pane: its label plus an icon button that copies ONLY this
// pane's payload. The label element is passed in (not created here) because
// `resolve`/`abandon` keep painting the state word into it, while the button's
// accessible name is fixed to the PANE — what changes over the call's life is its
// content, not what it is.
const createPaneHeading = (label: HTMLElement, copyLabel: string, text: () => string): HTMLElement => {
    const heading = document.createElement('div');
    heading.className = 'tool-heading';

    // R3: no whole-dialog copy for a tool call. Each heading carries its own control,
    // built by ui/dialog.ts so the clipboard path (and the LAN fallback that needs
    // the modal focus trap held open) is shared rather than re-invented here.
    heading.append(label, createTextCopyButton({ label: copyLabel, text, className: 'tool-copy' }));

    return heading;
};

// Exact accessible names for the two per-pane controls. They stay stable across the
// call's life so the announced state ("Copied") is the only thing that changes.
const COPY_ARGUMENTS_LABEL = 'Copy arguments';
const COPY_RESULT_LABEL = 'Copy result';
// The think chip has ONE pane, so its copy control names that pane's text; the label is
// fixed (not `think · 1,234 chars`) for the same reason the two above are.
const COPY_THINK_LABEL = 'Copy thinking';

// `openFile` is supplied only for the tool dialog's argument/result blocks. The
// transform runs on a detached highlighter host first (never inside `pre`/`code`,
// which `file-links.ts` deliberately treats as literal), then the SAME highlight
// spans are moved into `<code>`. Result: paths become real buttons without losing
// token highlighting, and no Markdown/HTML parser is introduced.
//
// R4 then lays that fragment out as ONE BLOCK PER LOGICAL LINE (`.code-line`) inside
// `<code>`. The wrapper class `tool-code` is what scopes the whole viewer: the shared
// `.code-block` keeps `overflow: auto / white-space: pre` for Markdown fences
// (layout-containment.test.ts pins that), and only `.tool-code` gets soft wrap plus
// the line-number gutter.
const createCodeBlock = (
    code: string,
    language: string | undefined,
    openFile?: (path: string) => void
): HTMLElement => {
    const pre = document.createElement('pre');
    pre.className = 'code-block tool-code';

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

    // Lay the fragment out as logical lines and join them with the payload's own
    // newlines, so `<code> textContent` stays byte-identical to `code`: the exact
    // payload is what the transcript consumers read and what the pane's Copy button
    // writes, independently of the formatted view (R4). The gutter numbers are CSS
    // generated content, never text nodes, so they cannot enter that text.
    const rows = splitIntoLines(highlighted);
    rows.forEach((content, index) => {
        if (index > 0) block.append(createLineBreak());

        const row = document.createElement('span');
        row.className = CODE_LINE_CLASS;
        // Appending the fragment MOVES its nodes into the row, so each logical line
        // owns a balanced subtree of the highlighted fragment.
        row.append(content);
        block.append(row);
    });

    // The gutter is only as wide as the largest number it has to hold, so a two-line
    // argument pane does not lose a third of its width to an empty column. `ch` is
    // measured in the pane's own monospace font, and styles.css reads the property
    // for both the number column and the text indent.
    const digits = Math.max(MIN_GUTTER_DIGITS, String(rows.length).length);
    block.style.setProperty('--code-gutter', `${digits}ch`);
    // The logical line count, for the stylesheet contract and for a test that wants
    // to prove a soft-wrapped payload is still numbered once per source line.
    pre.dataset.codeLines = String(rows.length);

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

    // The measured span as its own element, painted as the chip's inline duration label
    // (`read 0.8s`); styles.css owns HOW it looks (a pill after the name, inside the chip's
    // own content width). It ticks live while running and freezes on the server's duration
    // when one arrives. Always text, never colour-only, and an unknown span is `[hidden]`,
    // never an invented `0.0s`.
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

    // The complete result text (or the pending/interruption note) shown in the
    // dialog. Declared BEFORE the panes because the result pane's Copy button closes
    // over it: R3 copies the payload that exists at CLICK time, so a call that
    // settles while its dialog is open yields the settled result, never the earlier
    // placeholder.
    let resultText = 'Waiting for the harness to run this call…';

    // The detail body is built ONCE and lives inside the closed `<details>` while no
    // dialog is open (a closed details renders only its summary, so this is not an
    // in-flow detail area). Opening MOVES this exact node into the dialog; closing
    // moves it back. No cloning means no duplicate ids and no stale handlers, and
    // `resolve`/`abandon` always mutate the same live nodes.
    const body = document.createElement('div');
    body.className = 'tool-body';

    // R3/R4: each pane is `heading (label + its own copy icon)` over a framed,
    // line-numbered code view. The copy provider hands over the pane's ORIGINAL
    // payload verbatim — `rawArguments` exactly as the model sent it, and the whole
    // result content — so the clipboard is independent of the pretty-printed,
    // soft-wrapped, numbered view on screen and is never truncated.
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
    argsSection.append(
        createPaneHeading(argsLabel, COPY_ARGUMENTS_LABEL, () => rawArguments),
        argsCode
    );

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
    resultSection.append(
        createPaneHeading(resultLabel, COPY_RESULT_LABEL, () => resultText),
        resultHolder
    );

    body.append(argsSection, resultSection);
    element.append(summary, body);

    let current: ToolState = 'running';
    let settled = false;

    // The open dialog handle, if any. Cleared in `onClose` so a close via Escape,
    // backdrop or the close button is indistinguishable from `handle.close()`.
    let dialog: DialogHandle | undefined;

    // Dialog heading doubles as the live status: `read · running` ->
    // `read · ok`. The chip remains the compact surface for scanning; the
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
            // R3: NO dialog-level `copy` here. A whole-call payload that stitches
            // tool name + state + arguments + result together is exactly what made
            // "copy the result" require pasting-and-cutting, so the tool dialog drops
            // the centered header action entirely and each pane heading carries its
            // own icon (see `createPaneHeading`). Every OTHER dialog (transcript,
            // file preview, the manual tool runner) still passes `copy` and keeps its
            // header button.
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
        // One source decides both what the badge says and whether it exists at all:
        // an empty string means "no honest span" and hides the pill, so a legacy
        // record (no `eventTimes`) or an abandoned call never paints `0.0s`.
        const text = formatToolDuration(live);
        duration.textContent = text;
        duration.hidden = text.length === 0;
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
        // The visible badge above is frozen at this same span, so the accessible
        // name repeats it (unknown span -> no span in the label).
        summary.setAttribute('aria-label', summaryLabel(name, current, formatToolDuration(measured)));
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
        resultText = text;

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
    // returned, so an unknown span stays hidden instead of becoming `0.0s`.
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
        // it plus the frozen span (same rule as resolve).
        summary.setAttribute('aria-label', summaryLabel(name, current, formatToolDuration(measured)));
        resultLabel.textContent = 'result · cancelled';

        // Replace the "Waiting for the harness to run this call…" placeholder: a
        // card on a settled tile must not claim the harness may still run it.
        const note = document.createElement('p');
        note.className = 'tool-pending';
        note.textContent = reason;
        resultHolder.replaceChildren(note);
        resultText = reason;

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

// --- Reasoning chip ("think") ----------------------------------------------
//
// One streamed `reasoning` round of ONE model request, rendered with the SAME anatomy as
// a tool call: a compact chip that stays INLINE in the `.tool-group` row and whose full
// text is only ever readable in the dialog (the R12 modal contract above). It is labelled
// `think`, not `reasoning`, and it is painted AMBER so the eye can tally how much of a run
// was thinking at a glance.
//
// The pill is a PERCENTAGE OF THE CONTEXT, not a character count. Nobody reads the
// thinking or cares how intricate it was; what is worth seeing is how much of the
// context the conversation now carries went into it. The denominator is the block's own
// latest-request context — the same figure the header tally prints (`blockMeta`) — so one
// chip answers "how much of what this conversation currently costs did this round add?",
// every chip in one block stays comparable, and the shares sum to the thinking budget.
// The exact character count is not lost: it is in the hover title and in the dialog
// title, which is where a reader who wants it looks.
//
// Why not the old full-width `.thinking` block: it broke the chip row on every round and
// turned `[glob][read]` into alternating rows of chips and wide grey bars.
//
// Live contract (owned by ui/turns.ts, which appends the deltas):
//   - `setText` is called with the CUMULATIVE buffer, never a delta, so the pill, the
//     dialog body, the accessible name and an OPEN dialog all repaint from one source;
//   - `setContext` is called with the block's freshest context figure. turns.ts repaints
//     EVERY chip of a block when a `usage` event advances that figure, so a percentage can
//     never be measured against a denominator the header has already moved past;
//   - the pill is `[hidden]` — never `0%`, never a dash — while there is no honest
//     denominator (a provider that reports no usage) or no text yet, exactly like the tool
//     chip's duration pill;
//   - `destroy` only closes a dialog this card owns (a retry discards the chip, and an
//     orphaned modal with a stale focus trap is the bug that prevents it).
export const THINK_LABEL = 'think';

// Rough token estimate behind the share. Providers report usage per REQUEST, never per
// message, so the only figure this module owns is a character count and the ratio uses the
// ~4-characters-per-token rule of thumb for Latin-script text. It is therefore labelled an
// estimate (`≈` in the hover title) and is only ever shown as a PERCENTAGE of a context
// that is itself an approximation — a share of a fraction of a point is a decision cue,
// not a number anyone adds up.
const CHARS_PER_TOKEN = 4;

// Pinned locale, the same rule ui/tokens.ts documents: these figures must be identical on
// every host and every Node default (`12,108`, never `12.108` or `12 108`).
const THINK_NUMBER = new Intl.NumberFormat('en-US');
const thinkCount = (value: number): string => THINK_NUMBER.format(Math.trunc(Math.max(value, 0)));

const thinkTokens = (characters: number): number =>
    Math.max(1, Math.ceil(Math.max(characters, 0) / CHARS_PER_TOKEN));

// Exact pill text for one round:
//   - no text, or no honest denominator (undefined / non-finite / <= 0) -> '' and the
//     caller hides the pill (an unknown context must not become a fabricated `0%`);
//   - a real share below 0.1% reads `<0.1%`, because `0.0%` would claim the model never
//     thought at all;
//   - below 10% keeps one decimal — that is the range where the comparison happens — and
//     anything larger rounds to whole percent, so the pill stays three or four characters
//     and never twitches a decimal place while the round streams.
export const formatThinkShare = (
    characters: number,
    contextTokens: number | undefined
): string => {
    if (characters <= 0) return '';
    if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0)
        return '';

    const percent = (thinkTokens(characters) / contextTokens) * 100;
    if (percent < 0.1) return '<0.1%';

    return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
};

export type ReasoningCard = {
    // The chip itself, appended into the agent's `.tool-group` row by turns.ts.
    element: HTMLDetailsElement;
    // The clickable surface (`aria-haspopup="dialog"`, the dialog's return-focus target).
    summary: HTMLElement;
    // `think` — the visible name of the control.
    label: HTMLElement;
    // The share pill (`0.4%`), hidden while the block has no honest context figure.
    count: HTMLElement;
    // The reasoning text as a plain-text block; adopted by the dialog while one is open.
    body: HTMLElement;
    // Paint the CUMULATIVE text of this round.
    setText: (text: string) => void;
    // Repaint against the block's freshest context figure (the denominator above). Safe to
    // call repeatedly; an unchanged figure repaints identically.
    setContext: (tokens: number | undefined) => void;
    // The text currently held (the dialog's Copy button reads it at CLICK time, so it is
    // always the whole round, never a streaming prefix of it).
    text: () => string;
    // The denominator currently in force, for a caller that wants to batch repaints.
    context: () => number | undefined;
    // The exact pill text, for tests and for a caller composing its own label.
    share: () => string;
    // Close a dialog this card owns. Called when the card leaves the DOM (a discarded
    // attempt or a superseded projection), never when the round merely finishes.
    destroy: () => void;
};

export const createReasoningCard = (): ReasoningCard => {
    const element = document.createElement('details');
    // `.tool` is deliberate: the chip is the SAME box vocabulary as a tool call
    // (border, radius, surface, intrinsic width, wrap behaviour). `.think` only
    // restyles the label/pill, because thinking is not an outcome.
    element.className = 'tool think';

    const summary = document.createElement('summary');
    summary.className = 'tool-summary';

    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = THINK_LABEL;

    // The share flows right after the name, exactly like `.tool-duration` does on a call
    // chip; styles.css paints both with the same pill rules (and `.think` paints it
    // amber, so a run's thinking budget is scannable without reading a single number).
    const count = document.createElement('span');
    count.className = 'think-count';
    count.hidden = true;

    summary.append(label, count);
    // Same popup vocabulary as the tool chip: activation opens a modal, never an
    // inline disclosure, so assistive tech is told which kind of popup to expect.
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.tabIndex = 0;

    // Built once, moved into the dialog while one is open and back on close — the
    // identical ownership model `createToolCallCard` documents above, which is why a
    // streaming round updates an already-open dialog without re-adopting anything.
    const body = document.createElement('div');
    body.className = 'tool-body';

    // The cumulative text of this round and the context figure it is measured against.
    // Both are declared BEFORE the panes because the pane's copy provider closes over the
    // text (`() => current`, read at click time), exactly like `resultText` in
    // `createToolCallCard`.
    let current = '';
    let contextTokens: number | undefined;

    const section = document.createElement('section');
    section.className = 'tool-section';
    const heading = document.createElement('div');
    heading.className = 'tool-label';
    heading.textContent = THINK_LABEL;
    // `.reasoning` keeps its class (and its plain-text scroll box) so the transcript's
    // long thinking text stays readable in the modal exactly as it was in the block.
    const textHost = document.createElement('div');
    textHost.className = 'reasoning';
    section.append(createPaneHeading(heading, COPY_THINK_LABEL, () => current), textHost);
    body.append(section);
    element.append(summary, body);

    let dialog: DialogHandle | undefined;

    // The dialog is the surface that still spells the figure out in full: the share, the
    // exact character count and the estimated tokens, so the compact chip can show one
    // honest number without hiding the arithmetic behind it.
    const dialogTitle = (): string => {
        if (current.length === 0) return THINK_LABEL;

        const chars = `${thinkCount(current.length)} chars`;
        const share = formatThinkShare(current.length, contextTokens);

        return share.length === 0
            ? `${THINK_LABEL} · ${chars}`
            : `${THINK_LABEL} · ${share} · ${chars}`;
    };

    // ONE paint path for every derived surface, so the pill, the accessible name, the
    // hover title and an open dialog's title cannot disagree about the same round.
    const paint = (): void => {
        const share = formatThinkShare(current.length, contextTokens);

        // An empty round or an unknown context hides the pill; the chip then keeps its
        // intrinsic `think` width instead of claiming a measurement it does not have.
        count.textContent = share;
        count.hidden = share.length === 0;

        // Plain text, never Markdown: scratch space can contain anything the model wrote,
        // and this path adds no HTML parse of its own.
        textHost.textContent = current;

        summary.setAttribute(
            'aria-label',
            share.length === 0
                ? THINK_LABEL
                : `${THINK_LABEL}: ${share} of the context so far`
        );

        // The arithmetic stays on hover. In the row it would be noise; to a reader who
        // wonders what the percentage was built from it is the whole answer.
        summary.title =
            current.length === 0
                ? THINK_LABEL
                : contextTokens === undefined
                  ? `${thinkCount(current.length)} characters ≈ ${thinkCount(thinkTokens(current.length))} tokens · no context size reported yet`
                  : `≈ ${thinkCount(thinkTokens(current.length))} of ${thinkCount(contextTokens)} context tokens (${share || '<0.1%'})`;

        // The open dialog tracks the round live, the way a running tool chip's dialog
        // tracks its state.
        if (dialog !== undefined && dialog.isOpen) dialog.update({ title: dialogTitle() });
    };

    const openDetails = (): void => {
        if (dialog !== undefined && dialog.isOpen) {
            dialog.element.focus({ preventScroll: true });
            return;
        }

        const handle = openDialog({
            title: dialogTitle(),
            content: body,
            returnFocus: summary,
            onClose: () => {
                if (dialog === handle) dialog = undefined;
                // Return the body to the closed chip so a reopen adopts the up-to-date
                // node and a later `setText` still reaches it.
                if (!element.contains(body)) element.append(body);
            }
        });

        dialog = handle;
    };

    // Chip activation opens the modal; the native toggle is cancelled and guarded,
    // exactly like the tool chip, so the chip can never expand inline.
    summary.addEventListener('click', (event) => {
        event.preventDefault();
        openDetails();
    });

    // Keyboard parity for jsdom/embedded webviews where a keydown is not turned into a
    // click. `openDetails` is idempotent while the dialog is open.
    summary.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        openDetails();
    });

    element.addEventListener('toggle', () => {
        if (element.open) element.open = false;
    });

    return {
        element,
        summary,
        label,
        count,
        body,
        setText: (text: string): void => {
            current = text;
            paint();
        },
        setContext: (tokens: number | undefined): void => {
            const finite = tokens !== undefined && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
            if (finite === contextTokens) return;

            contextTokens = finite;
            paint();
        },
        text: () => current,
        context: () => contextTokens,
        share: () => formatThinkShare(current.length, contextTokens),
        destroy: () => {
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
