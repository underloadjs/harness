// Tool-chip tests: status, the compact summary, the duration badge and the pairing
// of a call with its result. The card is the only place a user learns whether a tool
// ran, how long it took and what it returned, so the text, the `data-state`
// attribute and the badge formatting are all asserted exactly.
//
// R12 moved the detail view into a modal (see tool-dialog.test.ts). These tests
// keep pinning the chip and the shared body that the dialog adopts; they assert
// exact text/HTML and never open an inline `<details>` panel.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { createToolCallCard, formatToolDuration } from './tools';

// A failed fake-timer assertion must not leak the fake clock into the next test.
afterEach(() => {
    vi.useRealTimers();
});

describe('createToolCallCard', () => {
    it('starts collapsed and reports a running state in text', () => {
        const card = createToolCallCard('read', '{"paths":["package.json"]}');

        expect(card.element.tagName).toBe('DETAILS');
        expect(card.element.open).toBe(false);
        expect(card.element.getAttribute('data-state')).toBe('running');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('running');
        expect(card.element.querySelector('.tool-name')?.textContent).toBe('read');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe('read: running');
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
        const card = createToolCallCard('read', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', 'completed');

        const summary = card.element.querySelector('.tool-summary');
        expect(summary?.getAttribute('aria-label')).toBe('read: ok');

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
        const card = createToolCallCard('read', '{"paths":["package.json"]}');
        card.resolve('{"ok":true}', 'completed');

        expect(card.state()).toBe('ok');
        expect(card.element.getAttribute('data-state')).toBe('ok');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('ok');
        expect(card.element.querySelector('.tool-peek')?.textContent).toBe(
            '{"paths":["package.json"]} · 11 chars'
        );
        expect(card.element.querySelectorAll('.tool-label')[1]?.textContent).toBe('result');
        // R4: the pane is laid out as one `.code-line` per LOGICAL line, joined by
        // `.code-break` separators that carry the payload's own '\n'. The numbers are
        // CSS counters (generated content), so they appear nowhere in this markup —
        // `code.textContent` stays exactly the pretty-printed payload.
        expect(card.element.querySelector('.tool-result code')?.innerHTML).toBe(
            [
                '<span class="code-line"><span class="hljs-punctuation">{</span></span>',
                '<span class="code-break">\n</span>',
                '<span class="code-line">  <span class="hljs-attr">"ok"</span>',
                '<span class="hljs-punctuation">:</span> ',
                '<span class="hljs-literal"><span class="hljs-keyword">true</span></span></span>',
                '<span class="code-break">\n</span>',
                '<span class="code-line"><span class="hljs-punctuation">}</span></span>'
            ].join('')
        );
    });

    it('marks failures and never overwrites a settled card', () => {
        const card = createToolCallCard('shell', '{"command":"false"}');
        card.resolve('exit code 1', 'failed');

        expect(card.state()).toBe('error');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('error');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'shell: error'
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
        const card = createToolCallCard('read', '{"paths":["a.txt"]}', {
            callId: 'k1'
        });
        card.resolve('Tool call "read" (k1) was cancelled before it completed; no result is available.', 'cancelled');

        expect(card.state()).toBe('cancelled');
        expect(card.element.getAttribute('data-state')).toBe('cancelled');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('cancelled');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'read: cancelled'
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

        const card = createToolCallCard('shell', '{"command":"slow"}', { startedAt: T });
        const label = card.element.querySelector<HTMLElement>('.tool-duration');

        expect(label?.hidden).toBe(false);
        // R6: a sub-second span is seconds with one decimal, never `0ms`; zero is a
        // real measurement and paints `0.0s`.
        expect(label?.textContent).toBe('0.0s');

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
        const card = createToolCallCard('read', '{}');
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);

        card.resolve('ok', 'completed', 1500);
        expect(card.durationMs()).toBe(1500);
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.5s');
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(false);
    });

    // R2/R6: the corner badge shows the server's own measurement in seconds
    // (`0.8s`) as an overlay on every chip. styles.css positions it absolutely (see
    // tool-chip-style.test.ts), so the only thing that decides whether it exists at
    // all is whether an honest span is known.
    it('badges an authoritative sub-second server span in seconds', () => {
        const card = createToolCallCard('toolList', '{}');
        card.resolve('{"tools":[]}', 'completed', 800);

        const badge = card.element.querySelector<HTMLElement>('.tool-duration');
        expect(badge?.textContent).toBe('0.8s');
        expect(badge?.hidden).toBe(false);

        // The badge is visible text on the collapsed chip, and `aria-label` replaces
        // the summary's text for assistive technology, so the accessible name
        // repeats the span once the call settles.
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'toolList: ok · 0.8s'
        );

        // A rejected/failed call still reports how long the attempt took.
        const failed = createToolCallCard('toolRequest', '{"tags":["nope"]}');
        failed.resolve('No tools matched.', 'failed', 400);
        expect(failed.element.querySelector('.tool-duration')?.textContent).toBe('0.4s');
        expect(failed.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(false);
        expect(failed.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'toolRequest: error · 0.4s'
        );

        // Zero is a measurement (a sub-millisecond call), not a missing span.
        const instant = createToolCallCard('toolRequest', '{"tags":["files"]}');
        instant.resolve('{}', 'completed', 0);
        expect(instant.element.querySelector('.tool-duration')?.textContent).toBe('0.0s');
        expect(instant.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(false);
    });

    // R2: one badge PER CHIP. Consecutive calls share a `.tool-group` row and run
    // concurrently, so each card ticks, settles and freezes on its own span, and the
    // overlay is anchored to that card's own box (tool-chip-style.test.ts pins the
    // positioning; this pins that there is exactly one pill inside each chip).
    it('gives every chip its own badge, independent of its neighbours', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const group = document.createElement('div');
        const cards = ['read', 'shell', 'websearch'].map((name, index) => {
            const card = createToolCallCard(name, '{}', { startedAt: T + index * 1_000 });
            group.append(card.element);
            return card;
        });

        const spans = (): string[] =>
            [...group.querySelectorAll('.tool-duration')].map((node) => node.textContent ?? '');

        for (const card of cards) {
            expect(card.element.querySelectorAll('.tool-duration')).toHaveLength(1);
        }

        vi.advanceTimersByTime(2_000);
        // Elapsed since each card's own start: 2s, 1s, and a real 0ms.
        expect(spans()).toEqual(['2.0s', '1.0s', '0.0s']);

        // One call answers with the server's span: it freezes on that value while the
        // others keep measuring.
        cards[1]?.resolve('done', 'completed', 400);
        vi.advanceTimersByTime(1_000);
        expect(spans()).toEqual(['3.0s', '0.4s', '1.0s']);

        // The last one is interrupted: it reports the span it actually measured (it
        // started 1s before the interruption), and that value is now frozen too.
        cards[2]?.abandon();
        expect(spans()).toEqual(['3.0s', '0.4s', '1.0s']);

        // Time passes for the ONE card still running; the settled and the abandoned
        // spans cannot drift.
        vi.advanceTimersByTime(5_000);
        expect(spans()).toEqual(['8.0s', '0.4s', '1.0s']);
        vi.useRealTimers();
    });

    // R6 (history/legacy): hydration replays with a known span, and a record with no
    // timing data at all must stay silent. The `unknown -> hidden` path is pinned in
    // turns.test.ts and in the `abandon` case below.
    it('keeps a supplied negative or non-finite span hidden instead of printing NaN', () => {
        // A malformed frame is not a duration: the card falls back to its own clock,
        // and with no start stamp there is nothing honest to show.
        for (const span of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const card = createToolCallCard('read', '{}');
            card.resolve('ok', 'completed', span);

            expect(card.durationMs()).toBeUndefined();
            expect(card.element.querySelector('.tool-duration')?.textContent).toBe('');
            expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);
            expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
                'read: ok'
            );
        }
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

        const card = createToolCallCard('shell', '{"command":"slow"}', { startedAt: T });
        vi.advanceTimersByTime(1500);

        card.abandon('Cancelled before the call returned.');

        expect(card.state()).toBe('cancelled');
        expect(card.element.getAttribute('data-state')).toBe('cancelled');
        expect(card.element.querySelector('.tool-state')?.textContent).toBe('cancelled');
        expect(card.element.querySelector('.tool-summary')?.getAttribute('aria-label')).toBe(
            'shell: cancelled · 1.5s'
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
        const card = createToolCallCard('read', '{}');
        card.abandon();

        expect(card.state()).toBe('cancelled');
        expect(card.durationMs()).toBeUndefined();
        expect(card.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);
        expect(card.element.querySelector('.tool-pending')?.textContent).toBe(
            'Interrupted before the call returned.'
        );
    });

    it('never overwrites a resolved card and is idempotent', () => {
        const card = createToolCallCard('read', '{}');
        card.resolve('{"ok":true}', 'completed');

        const settled = card.element.querySelector('.tool-result')?.innerHTML;
        card.abandon('too late');

        expect(card.state()).toBe('ok');
        expect(card.element.querySelector('.tool-pending')).toBeNull();
        expect(card.element.querySelector('.tool-result')?.innerHTML).toBe(settled);

        // A second abandon keeps the FIRST reason (settled is final either way).
        const pending = createToolCallCard('read', '{}');
        pending.abandon('first reason');
        pending.abandon('second reason');
        expect(pending.state()).toBe('cancelled');
        expect(pending.element.querySelector('.tool-pending')?.textContent).toBe('first reason');
    });
});

// The badge's own formatter, asserted as a table of exact outputs (R6). This is the
// surface the user reads (`✓ toolList 0.8s`), so every branch is pinned numerically.
// `formatDuration` (ui/time.ts) is NOT changed by it — the turn clock and the retry
// line keep their millisecond form; time.test.ts pins those.
describe('formatToolDuration', () => {
    it('renders every sub-second span as seconds with one decimal', () => {
        // Zero and the tiny end of the range round to `0.0s`, never `0ms`.
        expect(formatToolDuration(0)).toBe('0.0s');
        expect(formatToolDuration(1)).toBe('0.0s');
        expect(formatToolDuration(49)).toBe('0.0s');

        // The requested form: one decimal, rounded to the nearest tenth.
        expect(formatToolDuration(50)).toBe('0.1s');
        expect(formatToolDuration(400)).toBe('0.4s');
        expect(formatToolDuration(750)).toBe('0.8s');
        expect(formatToolDuration(800)).toBe('0.8s');
        expect(formatToolDuration(900)).toBe('0.9s');

        // A tenth that rounds up still reads as a second, and the two branches
        // agree exactly at the boundary.
        expect(formatToolDuration(999)).toBe('1.0s');
        expect(formatToolDuration(1000)).toBe('1.0s');
    });

    it('keeps one-minute-plus spans in the shared readable form', () => {
        expect(formatToolDuration(1500)).toBe('1.5s');
        expect(formatToolDuration(59_949)).toBe('59.9s');
        expect(formatToolDuration(60_000)).toBe('1m00s');
        expect(formatToolDuration(252_000)).toBe('4m12s');
    });

    it('says nothing when there is no honest span', () => {
        // undefined = no server duration and no start stamp (a legacy record, or a
        // call that never returned); negative / non-finite = clock skew or a
        // malformed frame. All of them hide the badge instead of inventing a number.
        expect(formatToolDuration(undefined)).toBe('');
        expect(formatToolDuration(-1)).toBe('');
        expect(formatToolDuration(Number.NaN)).toBe('');
        expect(formatToolDuration(Number.POSITIVE_INFINITY)).toBe('');
    });
});
