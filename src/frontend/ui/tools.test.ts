// Tool-chip tests: status, the compact summary and the pairing of a call with its
// result. The card is the only place a user learns whether a tool ran and what it
// returned, so both the text and the `data-state` attribute are asserted.
//
// R12 moved the detail view into a modal (see tool-dialog.test.ts). These tests
// keep pinning the chip and the shared body that the dialog adopts; they assert
// exact text/HTML and never open an inline `<details>` panel.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { createToolCallCard } from './tools';

// A failed fake-timer assertion must not leak the fake clock into the next test.
afterEach(() => {
    vi.useRealTimers();
});

describe('createToolCallCard', () => {
    it('starts collapsed and reports a running state in text', () => {
        const card = createToolCallCard('fileRead', '{"paths":["package.json"]}');

        expect(card.element.tagName).toBe('DETAILS');
        expect(card.element.open).toBe(false);
        expect(card.element.getAttribute('data-state')).toBe('running');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('running');
        expect(card.element.querySelector('.tool-name')?.textContent).toBe('fileRead');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe('fileRead: running');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(card.element.querySelector<HTMLElement>('.tool-summary')?.tabIndex).toBe(0);
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe('{"paths":["package.json"]}');
        expect(card.element.querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · pending');
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Waiting for the harness to run this call…'
        );
        expect(card.state()).toBe('running');
    });

    it('keeps the argument/result body in the closed card for the dialog to adopt', () => {
        const card = createToolCallCard('fileRead', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', 'completed');

        const summary = card.element.querySelector('.tool-summary');
        expect(summary?.getAttribute('aria-label')).toBe('fileRead: ok');

        const argumentsText = '{\n  "paths": [\n    "package.json"\n  ]\n}';
        const resultText = '{\n  "ok": true\n}';

        // R12: the body never becomes an inline panel. It lives inside the always-
        // closed `<details>` (which renders only its summary) until the dialog
        // adopts it, so transcript consumers can still read the detail.
        expect(card.element.open).toBe(false);
        expect(card.element.querySelector('.tool-body')).not.toBeNull();
        expect(card.element.querySelectorAll('.tool-section code')[0]?.textContent).toBe(argumentsText);
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe(resultText);
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"paths":["package.json"]} · 11 chars'
        );
    });

    it('resolves a successful result, highlighting JSON and summarising the size', () => {
        const card = createToolCallCard('fileRead', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', 'completed');

        expect(card.state()).toBe('ok');
        expect(card.element.getAttribute('data-state')).toBe('ok');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('ok');
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"paths":["package.json"]} · 11 chars'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result');
        expect(card.element.querySelector('.tool-result code')?.innerHTML).toBe(
            '<span class="hljs-punctuation">{</span>\n  <span class="hljs-attr">"ok"</span><span class="hljs-punctuation">:</span> <span class="hljs-literal"><span class="hljs-keyword">true</span></span>\n<span class="hljs-punctuation">}</span>'
        );
    });

    it('marks failures and never overwrites a settled card', () => {
        const card = createToolCallCard('commandRun', '{"command":"false"}');
        card.resolve('exit code 1', 'failed');

        expect(card.state()).toBe('error');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('error');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'commandRun: error'
        );
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"command":"false"} · failed'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · error');

        const before = card.element.querySelector('.tool-result')?.innerHTML;
        card.resolve('second result', 'completed');

        expect(card.state()).toBe('error');
        expect(card.element.querySelector('.tool-result')?.innerHTML).toBe(before);
    });

    it('shows a cancelled call as a control outcome, not a failure', () => {
        // R1: the runtime classifies a toolCancel release as `cancelled`; the card
        // must reflect that instead of borrowing the red error state.
        const card = createToolCallCard('fileRead', '{"paths":["a.txt"]}', {
            callId: 'k1'
        });
        card.resolve('Tool call "fileRead" (k1) was cancelled before it completed; no result is available.', 'cancelled');

        expect(card.state()).toBe('cancelled');
        expect(card.element.getAttribute('data-state')).toBe('cancelled');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('cancelled');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'fileRead: cancelled'
        );
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"paths":["a.txt"]} · cancelled'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · cancelled');
    });

    it('shows a rejected invocation as an error, exactly like a failed execution', () => {
        // R1: the card surface only needs "no usable value"; the distinction between
        // rejected (never ran) and failed (ran and threw) lives in the event.
        const rejected = createToolCallCard('missing', '{"value":"M"}');
        rejected.resolve('Tool "missing" is not registered.', 'rejected');
        expect(rejected.state()).toBe('error');
        expect(rejected.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"value":"M"} · failed'
        );

        const failed = createToolCallCard('broken', '{"value":"F"}');
        failed.resolve('Tool "broken" failed: kaput', 'failed');
        expect(failed.state()).toBe('error');
    });

    it('shows a placeholder for an empty result', () => {
        const card = createToolCallCard('timeNow', '');
        card.resolve('', 'completed');

        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '(no arguments) · 14 chars'
        );
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe('(empty result)');
    });

    it('ticks a live duration and freezes the final span', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const card = createToolCallCard('commandRun', '{"command":"slow"}', { startedAt: T });
        const label = card.element.querySelector<HTMLElement>('.tool-duration');

        expect(label?.hidden).toBe(false);
        expect(label?.textContent).toBe('0ms');

        vi.advanceTimersByTime(1500);
        expect(label?.textContent).toBe('1.5s');

        vi.advanceTimersByTime(500);
        card.resolve('done', 'completed');
        expect(card.durationMs()).toBe(2000);
        expect(label?.textContent).toBe('2.0s');

        // Settled: the interval is gone, so the label cannot keep counting.
        vi.advanceTimersByTime(10_000);
        expect(label?.textContent).toBe('2.0s');
        vi.useRealTimers();
    });

    it('uses an authoritative recorded duration when one is supplied', () => {
        const card = createToolCallCard('fileRead', '{}');
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);

        card.resolve('ok', 'completed', 1500);
        expect(card.durationMs()).toBe(1500);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.5s');
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(false);
    });

    it('stops the live ticker when destroyed', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const card = createToolCallCard('timeNow', '', { startedAt: T });
        vi.advanceTimersByTime(1000);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.0s');

        card.destroy();
        vi.advanceTimersByTime(5000);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.0s');
        vi.useRealTimers();
    });

    // R6: pending work is interrupted on cancel/restart, never resumed. A card on
    // a settled tile must stop claiming the harness may still run it.
    it('abandons an interrupted call with a reason and freezes its span', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const card = createToolCallCard('commandRun', '{"command":"slow"}', { startedAt: T });
        vi.advanceTimersByTime(1500);

        card.abandon('Cancelled before the call returned.');

        expect(card.state()).toBe('cancelled');
        expect(card.element.getAttribute('data-state')).toBe('cancelled');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('cancelled');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'commandRun: cancelled'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · cancelled');
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Cancelled before the call returned.'
        );
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"command":"slow"} · cancelled'
        );
        expect(card.durationMs()).toBe(1500);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.5s');

        // Frozen: the ticker is stopped, so the abandoned span cannot keep growing.
        vi.advanceTimersByTime(10_000);
        expect(card.durationMs()).toBe(1500);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.5s');
        vi.useRealTimers();
    });

    it('keeps an unknown span hidden when abandoning a card with no start stamp', () => {
        const card = createToolCallCard('fileRead', '{}');
        card.abandon();

        expect(card.state()).toBe('cancelled');
        expect(card.durationMs()).toBeUndefined();
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Interrupted before the call returned.'
        );
    });

    it('never overwrites a resolved card and is idempotent', () => {
        const card = createToolCallCard('fileRead', '{}');
        card.resolve('{"ok":true}', 'completed');

        const settled = card.element.querySelector('.tool-result')?.innerHTML;
        card.abandon('too late');

        expect(card.state()).toBe('ok');
        expect(card.element.querySelector('.tool-pending')).toBeNull();
        expect(card.element.querySelector('.tool-result')?.innerHTML).toBe(settled);

        // A second abandon keeps the FIRST reason (settled is final either way).
        const pending = createToolCallCard('fileRead', '{}');
        pending.abandon('first reason');
        pending.abandon('second reason');
        expect(pending.state()).toBe('cancelled');
        expect(pending.element.querySelector('.tool-pending')?.textContent).toBe('first reason');
    });
});
