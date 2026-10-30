// Composer state helpers (R9/R10).
//
// The behavior layer (src/frontend/main.ts, "centre: ... composer" block) owns the
// DOM. This module owns the two decisions that must hold in every state, so they can
// be pinned without a browser:
//   - which SINGLE in-field action exists: submit, stop, or none at all;
//   - how tall the auto-grown field is: one row minimum, capped, scroll past the cap.
//
// Attachment markers/counters are a separate concern (ui/attachments.ts); this
// module only learns whether a READY attachment exists, so an attachment-only turn
// paints the same submit action as typed text.
//
// R5 moves the cap from a fixed stylesheet pixel box to a TEXT-LINE budget: 3 lines
// on a phone viewport and 5 on desktop. It is derived from the field's live computed
// line-height/padding/borders at call time (main.ts autoGrow), so a zoomed or
// restyled field still caps at the same number of readable lines. styles.css
// `.composer-field .composer-input` therefore sets `max-height: none`: the script is
// the only cap writer and a stale pixel box must not clip the last line.

// The three states of the single action button. There is deliberately no fourth
// state: Reset is gone (R10) and Run/Stop are never both visible.
export type ComposerActionKind = 'submit' | 'stop' | 'none';

// Derive the action from the field's text/attachments and whether work is pending.
//
// R10 matrix:
//   text or ready attachments present, idle      -> submit
//   text or ready attachments present, running   -> submit (submitting queues)
//   empty, running/pending                       -> stop
//   empty, idle                                  -> none (no control at all)
//
// Text ALWAYS wins over pending: while a task runs the same control submits the
// next task, which is how the existing queue behavior is preserved.
//
// Whitespace-only text is treated as empty: run() trims and refuses it, so painting
// a submit icon over spaces alone would promise an action that cannot happen.
//
// ATTACHMENTS (clip/attach): the server accepts an attachment-only turn, so a
// draft with a READY file (its marker inserted, bytes encoded) is submittable even
// with an empty prompt. Pending reads are excluded by the caller: until every file
// has encoded, the draft is not ready and this must not promise a send.
export const composerActionOf = (
    value: string,
    pending: boolean,
    attachments = 0
): ComposerActionKind => {
    if (value.trim().length > 0 || attachments > 0) return 'submit';

    return pending ? 'stop' : 'none';
};

// Whether the SECOND control — the session-wide STOP-ALL `×` — is visible.
//
// R5/R7: with independent threads running, stopping everything must stay reachable
// even while the reader has a draft in the field. The inline action already does
// that job when the field is empty (`composerActionOf` returns 'stop'), so the extra
// button is shown only when the action is NOT already stop: submit + a separate
// stop. Two stop controls in the same corner would be a misclick waiting to happen,
// so exactly one of them is ever visible.
export const composerStopOf = (action: ComposerActionKind, pending: boolean): boolean =>
    pending && action !== 'stop';

// Compute the inline height for the auto-grown textarea.
//
// `scrollHeight` is the content height (padding included, border excluded). Under the
// global `box-sizing: border-box` the border must be added back, or a two-line field
// would measure 2px short on every keystroke and slowly ratchet its own height.
//
// Returns 0 for "no layout information" (jsdom and detached nodes report 0 for every
// box metric). The caller then removes the inline height and keeps the stylesheet's
// one-row default instead of collapsing the field to nothing.
//
// `maxHeight` <= 0 (or NaN from a `max-height: none` computed style) means no cap:
// the field grows freely. Past a real cap the stylesheet's `overflow-y: auto` takes
// over, which is the requested "grow reasonably, then scroll".
export const composerFieldHeight = (
    scrollHeight: number,
    borders: number,
    maxHeight: number
): number => {
    if (!(scrollHeight > 0)) return 0;

    const wanted = scrollHeight + (borders > 0 ? borders : 0);

    return maxHeight > 0 ? Math.min(wanted, maxHeight) : wanted;
};

// Phone/desktop split for the line cap. 860px is the SAME breakpoint the shell's
// layout media query uses (styles.css `@media (max-width: 860px)`), so the composer
// switches cap and layout together instead of at a second, drifting threshold.
export const COMPOSER_MOBILE_WIDTH = 860;

// `window.innerWidth` is what CSS media queries match against (viewport width), so
// this stays consistent with COMPOSER_MOBILE_WIDTH. A non-finite width (detached
// node, exotic embed) falls back to the roomier desktop cap rather than a 3-line
// phone cap that would clip a desktop draft.
export const composerMaxLines = (viewportWidth: number): number =>
    Number.isFinite(viewportWidth) && viewportWidth <= COMPOSER_MOBILE_WIDTH ? 3 : 5;

// Values from `.composer-input` in styles.css, used ONLY when the browser reports
// something unparseable (no layout yet, `line-height: normal`, detached node).
// jsdom reports exactly those (`normal` / `medium`), so tests that do not stub the
// metrics still get a stable, intentional cap instead of NaN.
export const COMPOSER_FONT_SIZE_FALLBACK = 13.5;
export const COMPOSER_LINE_HEIGHT_RATIO = 1.45;

// Normalize one computed-style metric (`"10px"`, `"normal"`, `"medium"`, number).
// Anything non-finite or negative reads as 0, the same convention composerFieldHeight
// uses for an unreadable border width.
const composerMetric = (value: string | number): number => {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

// Resolve one LINE BOX height in px. A unitless `line-height` is already resolved to
// px by getComputedStyle in a real browser; `"normal"` is not, so it falls back to the
// stylesheet's own font-size * 1.45 (13.5px * 1.45 = 19.575px) rather than inventing a
// new ratio. Numeric inputs are accepted so callers/tests can pass raw metrics.
export const composerLineHeight = (
    lineHeight: string | number,
    fontSize: string | number
): number => {
    const explicit = composerMetric(lineHeight);
    if (explicit > 0) return explicit;

    const size = composerMetric(fontSize);

    return (size > 0 ? size : COMPOSER_FONT_SIZE_FALLBACK) * COMPOSER_LINE_HEIGHT_RATIO;
};

// The metrics autoGrow reads off the live element before asking for the cap.
export type ComposerHeightMetrics = {
    // Viewport width in CSS px (window.innerWidth); selects 3 vs 5 lines.
    viewportWidth: number;
    // `getComputedStyle(input).lineHeight` / `.fontSize`.
    lineHeight: string | number;
    fontSize: string | number;
    // `getComputedStyle(input).paddingTop` / `.paddingBottom` (border-box padding).
    paddingTop: string | number;
    paddingBottom: string | number;
    // Vertical border widths ALREADY summed by the caller (same value it hands to
    // composerFieldHeight), so the border is counted exactly once overall.
    borders: number;
};

// Cap in px for a line budget: the text lines themselves PLUS the field's real
// padding and borders, i.e. the outer height of N readable lines in a border-box
// textarea. `Math.ceil` keeps a fractional line-height (19.575px) from clipping the
// bottom pixel row of the last line; it can reveal at most 1px of the next line but
// never cuts text. `overflow-y: auto` in styles.css turns anything past it into a
// scroll, which is the requested "grow until the cap, then scroll".
export const composerMaxHeight = (metrics: ComposerHeightMetrics): number => {
    const content = composerMaxLines(metrics.viewportWidth) * composerLineHeight(
        metrics.lineHeight,
        metrics.fontSize
    );
    const padding = composerMetric(metrics.paddingTop) + composerMetric(metrics.paddingBottom);

    return Math.ceil(content + padding + composerMetric(metrics.borders));
};
