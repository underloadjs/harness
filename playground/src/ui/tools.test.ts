// Tool-card tests: status, collapsible summary and the pairing of a call with its
// result. The card is the only place a user learns whether a tool ran and what it
// returned, so both the text and the `data-state` attribute are asserted.
//
// Run: npx vitest run --config playground/vitest.config.ts
import { createToolCallCard } from './tools';

describe('createToolCallCard', () => {
    it('starts collapsed and reports a running state in text', () => {
        const card = createToolCallCard('readFile', '{"path":"package.json"}');

        expect(card.element.tagName).toBe('DETAILS');
        expect(card.element.open).toBe(false);
        expect(card.element.getAttribute('data-state')).toBe('running');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('running');
        expect(card.element.querySelector('.tool-name')?.textContent).toBe('readFile');
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe('{"path":"package.json"}');
        expect(card.element.querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · pending');
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Waiting for the harness to run this call…'
        );
        expect(card.state()).toBe('running');
    });

    it('resolves a successful result, highlighting JSON and summarising the size', () => {
        const card = createToolCallCard('readFile', '{"path":"package.json"}');
        card.resolve('{"ok":true}', false);

        expect(card.state()).toBe('ok');
        expect(card.element.getAttribute('data-state')).toBe('ok');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('ok');
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"path":"package.json"} · 11 chars'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result');
        expect(card.element.querySelector('.tool-result code')?.innerHTML).toBe(
            '<span class="hljs-punctuation">{</span>\n  <span class="hljs-attr">"ok"</span><span class="hljs-punctuation">:</span> <span class="hljs-literal"><span class="hljs-keyword">true</span></span>\n<span class="hljs-punctuation">}</span>'
        );
    });

    it('marks failures and never overwrites a settled card', () => {
        const card = createToolCallCard('runCommand', '{"command":"false"}');
        card.resolve('exit code 1', true);

        expect(card.state()).toBe('error');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('error');
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
        const card = createToolCallCard('clock', '');
        card.resolve('', false);

        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '(no arguments) · 14 chars'
        );
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe('(empty result)');
    });
});
