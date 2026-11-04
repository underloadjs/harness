// R1 — EVERY dialog payload view is the same code-editor surface: syntax highlighting
// where a language is known, a line-number gutter, SOFT WRAP, and a byte-exact text
// payload behind it.
//
// Why one test for four modules: the defect this pass removes is per-surface (each of
// these panels hand-rolled its own `<pre>`, and `ui/dialog.css .dialog-body pre`
// `white-space: pre` (0,1,1) silently beat each single-class rule in styles.css, so the
// payload scrolled sideways instead of wrapping). The fix is also per-surface — every
// surface keeps its own host class, because styles.css sizes/frames/caps it by that name —
// so what has to be pinned is the PAIRING: host class + `tool-code` on one `<pre>`, built
// by `createCodeBlock`, with the numbers as CSS generated content.
//
// Pinned here, per surface, with exact values:
//   1. `createPayloadViewer` itself (ui/tools.ts) — the class pairing, the row model, and
//      `pre.textContent` byte-identical to the payload (copy + every consumer read it);
//   2. the context-bar segment dialog's PROSE panes (ui/context-detail.ts): prompt /
//      answer / thinking and one pane per recorded system instruction;
//   3. the think chip's reasoning pane (ui/tools.ts `createReasoningCard`): repainted IN
//      PLACE on the one `.reasoning` host, which stays the host across a stream;
//   4. the thread transcript read surface (ui/thread-transcript.ts): identity, tabindex and
//      the Copy payload are unchanged while the box becomes the numbered viewer;
//   5. the manual runner's response host class composes the same way (`card-body` +
//      `tool-code`), which is what `src/frontend/main.ts setResponse` now builds;
//   6. the ui/dialog.css stylesheet contract: the preview frame WRAPS (no sideways scroll,
//     no sticky gutter), the shell trap is still documented in place, and the harness
//     details divider rule exists for the `<hr>` R3 inserts.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/dialog-payload-viewer.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ContextBlock } from '../../shared/turn-display';
import type { BlockDetailPayload } from '../view-detail';
import { BLOCK_DETAIL_TEXT_CLASS, blockDetailPanesFor } from './context-detail';
import {
    createPayloadViewer,
    createReasoningCard,
    renderResultBlock,
    REASONING_VIEWER_CLASS,
    TOOL_CODE_CLASS
} from './tools';
import { threadTranscriptContent, THREAD_TRANSCRIPT_JSON_CLASS } from './thread-transcript';
import type { ThreadTranscriptJson } from './thread-transcript';

// Lets the shared copy path's promise chain (`writeText` -> feedback paint) settle.
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

// jsdom's navigator has no clipboard by default (ui/dialog-copy.test.ts), so each test
// states which write path exists and reads back exactly what was handed to it.
const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

// The shared control writes through `navigator.clipboard` when it exists (the stub
// above); clicking it and letting the promise chain settle is the whole gesture, so the
// caller asserts the exact string the clipboard received.
const clickCopy = async (button: Element | null | undefined): Promise<void> => {
    if (button === null || button === undefined) throw new Error('missing copy control');
    (button as HTMLButtonElement).click();
    await flush();
};

// --- the viewer's own contract ------------------------------------------------
//
// The row model belongs to `createCodeBlock` and is already pinned line-by-line by
// ui/tool-code-viewer.test.ts. What is pinned here is the NEW half: the host class that
// styles.css addresses plus the wrap class, on ONE node.

describe('createPayloadViewer', () => {
    it('puts the host class and the wrap class on one framed pre', () => {
        const pane = createPayloadViewer('{\n  "ok": true\n}', 'json', 'card-body');

        // Order matters: `code-block` first (the shared frame), then the host class the
        // surface is addressed by, then `tool-code` — the class whose pair
        // `.tool-code.code-block` outranks `.dialog-body pre`.
        expect(pane.tagName).toBe('PRE');
        expect(pane.className).toBe(`code-block card-body ${TOOL_CODE_CLASS}`);
        expect(pane.getAttribute('data-code-lines')).toBe('3');
        // Numbers are CSS counters, so nothing in the text carries one.
        expect(pane.querySelector('code')?.textContent).toBe('{\n  "ok": true\n}');
        expect(pane.querySelector('code')?.getAttribute('style')).toBe('--code-gutter: 2ch;');
        expect(pane.querySelector('.hljs-keyword')).not.toBeNull();
    });

    it('carries an unparseable payload byte-exact with model markup kept inert', () => {
        // No language: the text is escaped, never parsed — `<b>` stays text, so no surface
        // can turn a payload into markup by containing a tag.
        const pane = createPayloadViewer('line 1\n\n<b>x</b>', undefined, 'thread-transcript-json');

        expect(pane.className).toBe(`code-block thread-transcript-json ${TOOL_CODE_CLASS}`);
        expect(pane.getAttribute('data-code-lines')).toBe('3');
        expect([...pane.querySelectorAll<HTMLElement>('.code-line')].map((row) => row.textContent)).toEqual([
            'line 1',
            '',
            '<b>x</b>'
        ]);
        expect(pane.querySelector('b')).toBeNull();
        expect(pane.querySelector('code')?.textContent).toBe('line 1\n\n<b>x</b>');
    });
});

// --- the context-bar segment dialog ------------------------------------------

const segmentBlock = (kind: ContextBlock['kind'], id: string, chars: number): ContextBlock =>
    ({
        id,
        kind,
        name: kind,
        chars,
        sectionId: 't1:0'
    }) as ContextBlock;

const prosePane = (payload: BlockDetailPayload): HTMLElement => {
    const panes = blockDetailPanesFor(payload);
    const pane = panes.find((node) => node.dataset.pane === 'text');
    if (pane === undefined) throw new Error('missing prose pane');

    return pane;
};

describe('context-detail prose panes', () => {
    it('renders a recorded prompt through the viewer with the pane class intact', () => {
        const text = 'first line\n  indented second\n\nfourth';
        const pane = prosePane({
            kind: 'user',
            name: 'prompt',
            block: segmentBlock('user', '1-user-prompt', text.length),
            sessionId: 's1',
            turnId: 't1',
            blockId: '1-user-prompt',
            text,
            complete: true
        } as BlockDetailPayload);

        // `block-detail-text` is styles.css's height cap for this pane; `tool-code` is what
        // makes the box wrap inside a dialog.
        expect(pane.dataset.pane).toBe('text');
        expect(pane.querySelector('pre')?.className).toBe(
            `code-block ${BLOCK_DETAIL_TEXT_CLASS} ${TOOL_CODE_CLASS}`
        );
        expect(pane.querySelector('pre')?.getAttribute('data-code-lines')).toBe('4');
        expect([...pane.querySelectorAll<HTMLElement>('.code-line')].map((row) => row.textContent)).toEqual([
            'first line',
            '  indented second',
            '',
            'fourth'
        ]);
        // The Copy provider closes over the ORIGINAL string, and the rendered text matches
        // it byte for byte, so the two cannot disagree.
        expect(pane.querySelector('code')?.textContent).toBe(text);
        expect(pane.querySelector('.tool-copy')).not.toBeNull();
    });

    it('renders every recorded system instruction as its own numbered pane', () => {
        const entries = ['rule one\nrule two', 'second message'];
        const panes = blockDetailPanesFor({
            kind: 'system',
            name: 'instructions',
            block: segmentBlock('system', '0-system-instructions', 28),
            sessionId: 's1',
            turnId: 't1',
            blockId: '0-system-instructions',
            entries,
            complete: true
        } as BlockDetailPayload);

        expect(panes.map((pane) => pane.dataset.pane)).toEqual(['entry-1', 'entry-2']);
        expect(panes.map((pane) => pane.querySelector('pre')?.className)).toEqual([
            `code-block ${BLOCK_DETAIL_TEXT_CLASS} ${TOOL_CODE_CLASS}`,
            `code-block ${BLOCK_DETAIL_TEXT_CLASS} ${TOOL_CODE_CLASS}`
        ]);
        expect(panes.map((pane) => pane.querySelector('pre')?.getAttribute('data-code-lines'))).toEqual([
            '2',
            '1'
        ]);
        expect(panes.map((pane) => pane.querySelector('code')?.textContent)).toEqual(entries);
    });

    it('keeps the tool panes on the same builder', () => {
        const [args, result] = blockDetailPanesFor({
            kind: 'tool',
            name: 'read',
            block: segmentBlock('tool', '0-tool-9', 40),
            sessionId: 's1',
            turnId: 't1',
            blockId: '0-tool-9',
            args: '{"path":"a.ts"}',
            result: 'one\ntwo',
            complete: true
        } as BlockDetailPayload);

        // The tool panes were already the reference surface; their class pairing (a bare
        // `tool-code`, no host class) is the one every other pane now matches. The argument
        // pane carries the RAW `tool_call.arguments` string (`ui/context-detail.ts` does not
        // re-print it), so the copied bytes are the model's own.
        expect(args?.querySelector('pre')?.className).toBe(`code-block ${TOOL_CODE_CLASS}`);
        expect(args?.querySelector('pre')?.getAttribute('data-code-lines')).toBe('1');
        expect(args?.querySelector('code')?.textContent).toBe('{"path":"a.ts"}');
        expect(result?.querySelector('pre')?.className).toBe(`code-block ${TOOL_CODE_CLASS}`);
        expect(result?.querySelector('code')?.textContent).toBe('one\ntwo');
    });
});

// --- the think chip's reasoning pane -----------------------------------------

describe('reasoning pane', () => {
    it('numbers a streamed round and keeps the reasoning class hook', () => {
        const card = createReasoningCard();
        card.setText('one\ntwo\nthree');

        const host = card.body.querySelector<HTMLElement>(`.${REASONING_VIEWER_CLASS}`);
        if (host === null) throw new Error('missing reasoning host');

        expect(host.className).toBe(`code-block ${REASONING_VIEWER_CLASS} ${TOOL_CODE_CLASS}`);
        expect(host.getAttribute('data-code-lines')).toBe('3');
        // Prose: no highlight token, and the text is the round byte for byte.
        expect(host.querySelector('span.hljs-string')).toBeNull();
        expect(host.querySelector('code')?.textContent).toBe('one\ntwo\nthree');
    });

    it('repaints the SAME host on the next paint instead of leaving a stale one', () => {
        const card = createReasoningCard();

        card.setText('one\ntwo\nthree');
        // R2: the host is captured BEFORE the next paint, because that is how every
        // consumer reads this pane — the transcript and an open dialog go through
        // `.tool.think .reasoning`, so the node a paint wrote into has to be the node the
        // next paint still writes into (ui/tools.ts `paintCodeBlock`).
        const host = card.body.querySelector<HTMLElement>(`.${REASONING_VIEWER_CLASS}`);
        if (host === null) throw new Error('missing reasoning host');

        card.setText('grown\n');

        // One host, repainted in place: `grown\n` is two logical lines (the trailing
        // newline leaves an empty last row), so a stale 3-row viewer would still say
        // data-code-lines=3 — and a swapped host would make this reference stale.
        expect(card.body.querySelectorAll(`.${REASONING_VIEWER_CLASS}`)).toHaveLength(1);
        expect(card.body.querySelector(`.${REASONING_VIEWER_CLASS}`)).toBe(host);
        expect(host.getAttribute('data-code-lines')).toBe('2');
        expect(host.textContent).toBe('grown\n');
        expect([...(host.querySelectorAll<HTMLElement>('.code-line') ?? [])].map((row) => row.textContent)).toEqual([
            'grown',
            ''
        ]);
    });

    it('writes the whole round through the shared clipboard path', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const card = createReasoningCard();
        const round = 'plan the **read**\nthen <script>alert(1)</script>';
        card.setText(round);

        // Markup stays data, and the pane's Copy hands over the FULL round, not the view.
        expect(card.body.querySelector('script')).toBeNull();
        await clickCopy(card.body.querySelector('.tool-section > .tool-heading .tool-copy'));
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText.mock.calls[0]?.[0]).toBe(round);

        setClipboard(undefined);
    });

    it('keeps an empty round as one blank numbered row', () => {
        const card = createReasoningCard();
        const host = card.body.querySelector<HTMLElement>(`.${REASONING_VIEWER_CLASS}`);

        expect(host?.getAttribute('data-code-lines')).toBe('1');
        expect(host?.textContent).toBe('');
        expect(host?.querySelector('.code-line:empty')).not.toBeNull();
    });
});

// --- the thread transcript read surface -------------------------------------

// One document, written out in full so the expected row count, the expected text and the
// expected clipboard payload are all knowable from the fixture itself.
const TRANSCRIPT = {
    schema: 'underload.harness.thread-transcript',
    version: 1,
    generatedAt: 1_700_000_000_000,
    session: { id: 's1', harness: 'Instruct', status: 'idle', updatedAt: 1_700_000_000_001 },
    thread: { id: 'thread-1', agent: 'instruct', status: 'done', label: 'Alpha' },
    turns: [],
    relatedEvents: [],
    relatedSteers: [],
    limitations: []
} as unknown as ThreadTranscriptJson;

const TRANSCRIPT_JSON = [
    '{',
    '  "schema": "underload.harness.thread-transcript",',
    '  "version": 1,',
    '  "generatedAt": 1700000000000,',
    '  "session": {',
    '    "id": "s1",',
    '    "harness": "Instruct",',
    '    "status": "idle",',
    '    "updatedAt": 1700000000001',
    '  },',
    '  "thread": {',
    '    "id": "thread-1",',
    '    "agent": "instruct",',
    '    "status": "done",',
    '    "label": "Alpha"',
    '  },',
    '  "turns": [],',
    '  "relatedEvents": [],',
    '  "relatedSteers": [],',
    '  "limitations": []',
    '}'
].join('\n');

describe('thread transcript read surface', () => {
    it('renders the document as the numbered viewer and keeps the surface contract', () => {
        // `onEdit` is what makes this the read surface WITH its action row (the same call
        // shape ui/thread-transcript.test.ts pins the DOM order on).
        const host = threadTranscriptContent(TRANSCRIPT, () => undefined);

        // DOM order is unchanged (T1): meta row, the document, the action row.
        expect([...host.children].map((node) => node.className)).toEqual([
            'thread-transcript-meta',
            `code-block ${THREAD_TRANSCRIPT_JSON_CLASS} ${TOOL_CODE_CLASS}`,
            'thread-transcript-actions thread-transcript-read-actions'
        ]);

        const pre = host.querySelector<HTMLElement>(`.${THREAD_TRANSCRIPT_JSON_CLASS}`);
        // 21 logical lines -> 21 rows, one number each, wrapped inside each row.
        expect(pre?.getAttribute('data-code-lines')).toBe('21');
        expect(pre?.querySelectorAll('.code-line')).toHaveLength(21);
        // The accessible reading surface and the keyboard scroller are unchanged.
        expect(pre?.getAttribute('aria-label')).toBe('JSON transcript of thread Alpha');
        expect(pre?.tabIndex).toBe(0);
        // The JSON is highlighted, and `textContent` — the Copy source — is byte-exact.
        expect(pre?.querySelector('.hljs-attr')?.textContent).toBe('"schema"');
        expect(pre?.querySelector('code')?.textContent).toBe(TRANSCRIPT_JSON);
        expect(pre?.textContent).toBe(TRANSCRIPT_JSON);
    });

    it('copies exactly the rendered document', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const host = threadTranscriptContent(TRANSCRIPT, () => undefined);
        await clickCopy(host.querySelector('.thread-transcript-meta-copy'));
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText.mock.calls[0]?.[0]).toBe(TRANSCRIPT_JSON);

        setClipboard(undefined);
    });
});

// --- the manual runner's result box ----------------------------------------

describe('direct-call runner result host', () => {
    it('keeps the truncation note beside the viewer it already shared', () => {
        const block = renderResultBlock({ ok: true, note: 'same builder as the runner' }, false);
        const pane = block.querySelector('pre');

        expect(pane?.className).toBe(`code-block ${TOOL_CODE_CLASS}`);
        expect(pane?.getAttribute('data-code-lines')).toBe('4');
        expect(pane?.querySelector('code')?.textContent).toBe(
            '{\n  "ok": true,\n  "note": "same builder as the runner"\n}'
        );
    });

    it('composes the runner host class with the wrap class', () => {
        // `src/frontend/main.ts setResponse` builds the response box exactly this way:
        // `.card-body` stays the class the runner chain and the consumer tests address,
        // and `tool-code` is what gives the box its wrap back.
        const box = createPayloadViewer('a\nb', 'json', 'card-body');

        expect(box.className).toBe(`code-block card-body ${TOOL_CODE_CLASS}`);
        expect(box.querySelector('code')?.textContent).toBe('a\nb');
    });

    it('composes the runner parameter-schema host class the same way', () => {
        // The schema disclosure is the runner's other payload box (`main.ts`,
        // `TRANSCRIPT_BODY_VIEWER_CLASS`): same pairing, same byte-exact text.
        const box = createPayloadViewer('{\n  "type": "object"\n}', 'json', 'transcript-body');

        expect(box.className).toBe(`code-block transcript-body ${TOOL_CODE_CLASS}`);
        expect(box.getAttribute('data-code-lines')).toBe('3');
        expect(box.querySelector('code')?.textContent).toBe('{\n  "type": "object"\n}');
    });
});

// --- the stylesheet half ------------------------------------------------------

// Mirror ui/file-preview.test.ts: resolve from the package root (`npm test`) or the
// frontend root (the frontend vitest config sets `root` to src/frontend/).
const shell = ['src/frontend/ui/dialog.css', 'ui/dialog.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (shell === undefined) throw new Error('ui/dialog.css not found');

const css = readFileSync(shell, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

describe('dialog stylesheet', () => {
    it('keeps the shell trap that made single-class payload surfaces scroll sideways', () => {
        // This rule is WHY the payload surfaces need two classes on their `<pre>`:
        // `pre` + one class (0,1,1) beats a single-class rule in styles.css, which is where
        // `.tool-code.code-block` (0,2,0) comes from. Non-payload content (a prose note, an
        // image) still gets the plain framed box.
        const trap = blockOf('.dialog-body pre {');
        expect(trap).toContain('white-space: pre');
        expect(trap).toContain('overflow: auto');
    });

    it('soft-wraps the file preview like every other payload surface', () => {
        const frame = blockOf('.preview-file .preview-code.code-block {');
        expect(frame).toContain('white-space: normal');
        expect(frame).toContain('overflow-x: hidden');
        expect(frame).not.toContain('overflow-x: auto');

        const rows = blockOf('.preview-file .preview-code .code-line {');
        expect(rows).toContain('white-space: pre-wrap');
        expect(rows).toContain('overflow-wrap: anywhere');

        // The gutter moved with the wrap: an in-padding number, not a sticky overlay.
        const gutter = blockOf('.preview-file .preview-code .code-line::before {');
        expect(gutter).toContain('position: absolute');
        expect(gutter).not.toContain('position: sticky');
    });

    it('styles the harness details divider the Sessions section sits under', () => {
        // R3: the rule is scoped through `.harness-details`, the details body's own class,
        // so it cannot repaint any other dialog.
        const divider = blockOf('.dialog-body > .harness-details > .harness-details-divider {');
        expect(divider).toContain('border: 0');
        expect(divider).toContain('border-top: 1px solid var(--border)');
    });
});
