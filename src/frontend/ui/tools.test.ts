// Tool-card tests: status, collapsible summary and the pairing of a call with its
// result. The card is the only place a user learns whether a tool ran and what it
// returned, so both the text and the `data-state` attribute are asserted.
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
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe('{"paths":["package.json"]}');
        expect(card.element.querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · pending');
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Waiting for the harness to run this call…'
        );
        expect(card.state()).toBe('running');
    });

    it('keeps arguments and result available when a chip is expanded', () => {
        const card = createToolCallCard('fileRead', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', false);

        const summary = card.element.querySelector('.tool-summary');
        expect(summary?.getAttribute('aria-label')).toBe('fileRead: ok');

        const argumentsText = '{\n  "paths": [\n    "package.json"\n  ]\n}';
        const resultText = '{\n  "ok": true\n}';

        // Collapsed chip markup still contains the full detail; styles.css is what
        // hides the verbose summary pieces, not the DOM.
        expect(card.element.querySelectorAll('.tool-section code')[0]?.textContent).toBe(argumentsText);
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe(resultText);

        card.element.open = true;
        expect(card.element.open).toBe(true);
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"paths":["package.json"]} · 11 chars'
        );

        card.element.open = false;
        expect(card.element.querySelectorAll('.tool-section code')[0]?.textContent).toBe(argumentsText);
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe(resultText);
    });

    it('resolves a successful result, highlighting JSON and summarising the size', () => {
        const card = createToolCallCard('fileRead', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', false);

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
        card.resolve('exit code 1', true);

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
        card.resolve('second result', false);

        expect(card.state()).toBe('error');
        expect(card.element.querySelector('.tool-result')?.innerHTML).toBe(before);
    });

    it('shows a placeholder for an empty result', () => {
        const card = createToolCallCard('timeNow', '');
        card.resolve('', false);

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
        card.resolve('done', false);
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

        card.resolve('ok', false, 1500);
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
});
