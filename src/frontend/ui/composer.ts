// Composer state helpers (R9/R10).
//
// The behavior layer (src/frontend/main.ts, "centre: ... composer" block) owns the
// DOM. This module owns the two decisions that must hold in every state, so they can
// be pinned without a browser:
//   - which SINGLE in-field action exists: submit, stop, or none at all;
//   - how tall the auto-grown field is: one row minimum, capped, scroll past the cap.
//
// The cap is read from styles.css `.composer-field .composer-input` (max-height) at
// call time, so the two files cannot drift into different limits.

// The three states of the single action button. There is deliberately no fourth
// state: Reset is gone (R10) and Run/Stop are never both visible.
export type ComposerActionKind = 'submit' | 'stop' | 'none';

// Derive the action from the field's text and whether work is pending.
//
// R10 matrix:
//   text present, idle      -> submit
//   text present, running   -> submit (submitting queues the task)
//   empty, running/pending  -> stop
//   empty, idle             -> none (no control at all)
//
// Whitespace-only input is treated as empty: run() trims and refuses it, so painting
// a submit icon over spaces would promise an action that cannot happen. Text ALWAYS
// wins over pending: while a task runs the same control submits the next task, which
// is how the existing queue behavior is preserved.
export const composerActionOf = (value: string, pending: boolean): ComposerActionKind => {
    if (value.trim().length > 0) return 'submit';

    return pending ? 'stop' : 'none';
};

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
