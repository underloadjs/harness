// The click-time full-detail dialog for ONE context-bar segment (T11: R8).
//
// Every rule this file pins is a promise the compact wire makes by OMITTING something: the
// bar carries metadata and no text, so the text has to come from somewhere, exactly once,
// and only when a reader asks. The fixtures are hand-written `TurnBlockDetail` bodies —
// `ContextBlock` plus its per-kind payload fields (../shared/turn-display.ts:494-530) —
// because the assertions are about what the dialog paints from a frozen contract, not about
// how the server derived it.
//
// The failure modes are the interesting ones: a request that fails is a stated failure with
// a Retry (never an empty pane), a late answer is DROPPED (a retry and a close both
// supersede it), and the cache may only serve bytes whose segment has not moved since.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-detail.test.ts

import type { ContextBlock, TurnBlockDetail } from '../../shared/turn-display';
import {
    blockDetailCacheSize,
    blockDetailCacheKeyOf,
    blockDetailFactsOf,
    blockDetailFingerprintOf,
    clearBlockDetailCache,
    isBlockDetailCacheable,
    openBlockDetail
} from './context-detail';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Hand-written block details, one per kind
// ---------------------------------------------------------------------------

// The recorded tool halves and their EXACT lengths: the metadata figures the bar is sized
// from are defined here as the same numbers the payload carries, so an assertion about
// "46 characters" is about the fixture, not about a count the test invented.
const ARGS = '{"path":"notes.md","max":20}';
const RESULT = 'the whole recorded file body';
const TOOL_CHARS = ARGS.length + RESULT.length;

const PROMPT_TEXT = 'read the notes';
const THINK_TEXT = 'first the path, then the max';
const ANSWER_TEXT = 'here are the notes';
const ENTRIES = ['Answer directly.', 'Use the tools you have.'];
const ENTRY_CHARS = ENTRIES.reduce((sum, entry) => sum + entry.length, 0);

const meta = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    chars: TOOL_CHARS,
    argsChars: ARGS.length,
    resultChars: RESULT.length,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
    ...overrides
});

const toolDetail = (): TurnBlockDetail => ({
    ...meta(),
    sessionId: 's1',
    args: ARGS,
    result: RESULT
});

const promptDetail = (): TurnBlockDetail => ({
    ...meta({
        kind: 'user',
        id: '0-user-prompt',
        name: 'prompt',
        chars: PROMPT_TEXT.length,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        eventFrom: undefined,
        eventTo: undefined,
        endedAt: undefined
    }),
    sessionId: 's1',
    text: PROMPT_TEXT
});

const thinkDetail = (): TurnBlockDetail => ({
    ...meta({
        kind: 'reasoning',
        id: '0-reasoning-3',
        name: 'reasoning',
        chars: THINK_TEXT.length,
        argsChars: undefined,
        resultChars: undefined,
        inPrompt: false
    }),
    sessionId: 's1',
    text: THINK_TEXT
});

const answerDetail = (): TurnBlockDetail => ({
    ...meta({
        kind: 'assistant',
        id: '0-assistant-4',
        name: 'answer',
        chars: ANSWER_TEXT.length,
        argsChars: undefined,
        resultChars: undefined
    }),
    sessionId: 's1',
    text: ANSWER_TEXT
});

const systemDetail = (): TurnBlockDetail => ({
    ...meta({
        kind: 'system',
        id: '0-system-instructions',
        name: 'instructions',
        chars: ENTRY_CHARS,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        eventFrom: undefined,
        eventTo: undefined
    }),
    sessionId: 's1',
    entries: ENTRIES
});

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// The dialog surface
// ---------------------------------------------------------------------------

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('.dialog') as HTMLElement;
const body = (): HTMLElement => document.querySelector<HTMLElement>('.block-detail') as HTMLElement;
const panes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.block-detail-pane'));
const paneText = (name: string): string => {
    const pane = panes().find((node) => node.dataset.pane === name);
    if (pane === undefined) throw new Error(`missing pane ${name}`);

    return (pane.querySelector('code') ?? pane.querySelector('.block-detail-text'))?.textContent ?? '';
};
const note = (): HTMLElement | null => document.querySelector('.block-detail-note');
// The message alone, without the Retry button's own word inside it.
const noteText = (): string | null => {
    const node = note();
    if (node === null) return null;

    return node.querySelector('.block-detail-note-text')?.textContent ?? node.textContent;
};
const facts = (): { fact: string; text: string }[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.block-detail-fact')).map((node) => ({
        fact: node.dataset.fact as string,
        text: node.textContent as string
    }));
const closeDialog = (): void => {
    (document.querySelector('.dialog-close') as HTMLButtonElement).click();
};

/** One loader per test: it records its exact input and answers with a fixed body. */
const loaderFor = (detail: TurnBlockDetail | (() => TurnBlockDetail)) => {
    const inputs: { turnId: string; blockId: string; sessionId?: string }[] = [];

    return {
        inputs,
        load: async (input: { turnId: string; blockId: string; sessionId?: string }) => {
            inputs.push(input);

            return typeof detail === 'function' ? detail() : detail;
        }
    };
};

beforeEach(() => {
    clearBlockDetailCache();
    document.body.innerHTML = '<div id="app"></div>';
});

// ---------------------------------------------------------------------------
// R8: one click, one request, the whole payload
// ---------------------------------------------------------------------------

describe('opening a segment', () => {
    it('fires exactly one request for the segment that was clicked', async () => {
        const loader = loaderFor(toolDetail());

        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: loader.load });
        await settled();

        expect(loader.inputs).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '0-tool-7' }]);
        expect(body().dataset.status).toBe('full');
    });

    it('names the segment in the heading, with its state spelled out', () => {
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1' });

        expect(dialog().getAttribute('role')).toBe('dialog');
        expect(document.querySelector('.dialog-title')?.textContent).toBe('read · tool · ok');
        expect(body().dataset.kind).toBe('tool');
        expect(body().dataset.blockId).toBe('0-tool-7');
    });

    it('answers a tool with BOTH recorded halves, verbatim and separately copyable', async () => {
        const loader = loaderFor(toolDetail());
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: loader.load });
        await settled();

        expect(panes().map((pane) => pane.dataset.pane)).toEqual(['args', 'result']);
        expect(paneText('args')).toBe('{"path":"notes.md","max":20}');
        expect(paneText('result')).toBe('the whole recorded file body');
        expect(
            Array.from(document.querySelectorAll<HTMLButtonElement>('.block-detail-pane .tool-copy')).map((button) => button.getAttribute('aria-label'))
        ).toEqual(['Copy arguments', 'Copy result']);
        // The payload keeps its exact byte count, so a truncation anywhere is visible.
        expect(facts()).toContainEqual({ fact: 'answer', text: `answer ${TOOL_CHARS} characters` });
    });

    it('states a running call as pending instead of showing an empty result pane', async () => {
        const running: TurnBlockDetail = {
            ...meta({ state: 'running', chars: 20, resultChars: undefined, endedAt: undefined, eventTo: 7 }),
            sessionId: 's1',
            args: '{"path":"notes.md","max":20}'
        };
        const loader = loaderFor(running);
        openBlockDetail({ block: running, turnId: 't1', sessionId: 's1', load: loader.load });
        await settled();

        expect(paneText('args')).toBe('{"path":"notes.md","max":20}');
        expect(noteText()).toBe('no result recorded for this call yet');
        expect(note()?.dataset.detail).toBe('pending');
    });

    it('renders a prompt, an answer and a thinking window as their exact recorded text', async () => {
        for (const [detail, pane, label] of [
            [promptDetail(), 'text', 'Prompt'],
            [answerDetail(), 'text', 'Answer'],
            [thinkDetail(), 'text', 'Thinking']
        ] as const) {
            document.body.innerHTML = '<div id="app"></div>';
            clearBlockDetailCache();

            const loader = loaderFor(detail);
            openBlockDetail({ block: detail, turnId: 't1', sessionId: 's1', load: loader.load });
            await settled();

            expect(panes().map((node) => node.dataset.pane)).toEqual([pane]);
            expect(paneText(pane)).toBe(detail.text);
            expect(document.querySelector('.block-detail-pane .tool-label')?.textContent).toBe(label);
            closeDialog();
        }
    });

    it('renders one pane per recorded system message, in send order', async () => {
        const loader = loaderFor(systemDetail());
        openBlockDetail({ block: systemDetail(), turnId: 't1', sessionId: 's1', load: loader.load });
        await settled();

        expect(panes().map((pane) => pane.dataset.pane)).toEqual(['entry-1', 'entry-2']);
        expect(panes().map((pane) => pane.querySelector('.tool-label')?.textContent)).toEqual(['Instruction 1', 'Instruction 2']);
        expect(paneText('entry-1')).toBe('Answer directly.');
        expect(paneText('entry-2')).toBe('Use the tools you have.');
        // The instruction entries are the exact strings, joined nowhere.
        expect(facts()).toContainEqual({ fact: 'answer', text: `answer ${ENTRY_CHARS} characters` });
    });

    it('says when the record holds no bytes at all, instead of an empty box', async () => {
        const empty: TurnBlockDetail = { ...systemDetail(), entries: [] };
        const loader = loaderFor(empty);
        openBlockDetail({ block: systemDetail(), turnId: 't1', sessionId: 's1', load: loader.load });
        await settled();

        expect(noteText()).toBe('no system instruction entries were recorded');
        expect(note()?.dataset.detail).toBe('empty');
    });
});

// ---------------------------------------------------------------------------
// The metadata renders before (and without) any payload
// ---------------------------------------------------------------------------

describe('the metadata line', () => {
    it('answers "what is this segment" from the metadata alone, during the request', () => {
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: async () => toolDetail() });

        expect(note()?.dataset.detail).toBe('loading');
        expect(noteText()).toBe('loading the recorded text…');
        expect(facts()).toEqual([
            { fact: 'kind', text: 'tool · ok' },
            { fact: 'chars', text: `${TOOL_CHARS} characters recorded` },
            { fact: 'split', text: `args ${ARGS.length} + result ${RESULT.length}` },
            { fact: 'time', text: 'time taken 800ms' },
            { fact: 'at', text: `recorded ${new Date(T).toISOString()}` },
            { fact: 'endedAt', text: `settled ${new Date(T + 800).toISOString()}` },
            { fact: 'events', text: 'events 7-9' },
            { fact: 'prompt', text: 'in the prompt' },
            { fact: 'section', text: 'section t1:0' },
            { fact: 'block', text: 'block 0-tool-7' }
        ]);
    });

    it('names the source of a block that came from the record, not from events', () => {
        expect(blockDetailFactsOf(promptDetail())).toEqual([
            { fact: 'kind', text: 'user' },
            { fact: 'chars', text: `${PROMPT_TEXT.length} characters recorded` },
            { fact: 'time', text: 'no time recorded' },
            { fact: 'at', text: `recorded ${new Date(T).toISOString()}` },
            { fact: 'events', text: 'from the turn record' },
            { fact: 'prompt', text: 'in the prompt' },
            { fact: 'section', text: 'section t1:0' },
            { fact: 'block', text: 'block 0-user-prompt' }
        ]);
    });

    it('marks thinking as bytes the prompt never carried', () => {
        const factsOfThink = blockDetailFactsOf(thinkDetail());

        expect(factsOfThink).toContainEqual({ fact: 'prompt', text: 'not replayed into the prompt' });
        expect(factsOfThink).toContainEqual({ fact: 'events', text: 'events 7-9' });
    });
});

// ---------------------------------------------------------------------------
// Failure, retry, and the responses that arrived too late
// ---------------------------------------------------------------------------

describe('failure and staleness', () => {
    it('shows a failed read IN the dialog with a Retry that re-arms the same route', async () => {
        let attempt = 0;
        const load = vi.fn(async () => {
            attempt += 1;

            if (attempt === 1) throw new Error('the harness server is unreachable');

            return toolDetail();
        });

        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load });
        await settled();

        expect(note()?.dataset.detail).toBe('error');
        expect(noteText()).toBe('the recorded text could not be loaded: the harness server is unreachable');

        (document.querySelector('.block-detail-retry') as HTMLButtonElement).click();
        await settled();

        expect(load).toHaveBeenCalledTimes(2);
        expect(panes()).toHaveLength(2);
        expect(note()).toBeNull();
    });

    it('unwired says so and asks for nothing', () => {
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1' });

        expect(note()?.dataset.detail).toBe('unwired');
        expect(noteText()).toBe('this board has no block detail route');
        expect(body().dataset.status).toBe('unwired');
    });

    it('refuses a 200 that is not a block detail', async () => {
        const load = vi.fn(async () => ({ id: 'x' }) as unknown as TurnBlockDetail);
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load });
        await settled();

        expect(body().dataset.status).toBe('error');
        expect(noteText()).toBe(
            'the recorded text could not be loaded: the harness server answered with something that is not a block detail'
        );
    });

    it('drops an answer that arrived after the reader closed the dialog', async () => {
        let resolveLoad: ((detail: TurnBlockDetail) => void) | undefined;
        const load = vi.fn(
            () =>
                new Promise<TurnBlockDetail>((resolve) => {
                    resolveLoad = resolve;
                })
        );

        const handle = openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load });
        closeDialog();
        resolveLoad?.(toolDetail());
        await settled();

        expect(handle.isOpen()).toBe(false);
        expect(document.querySelector('.dialog')).toBeNull();
        expect(handle.status()).toBe('loading');
    });

    it('drops the first answer when a refresh superseded it', async () => {
        let attempt = 0;
        let release: ((detail: TurnBlockDetail) => void)[] = [];

        const load = vi.fn(
            () =>
                new Promise<TurnBlockDetail>((resolve) => {
                    attempt += 1;
                    release.push(resolve);
                })
        );

        const handle = openBlockDetail({ block: meta({ state: 'running', resultChars: undefined, endedAt: undefined }), turnId: 't1', sessionId: 's1', load });
        expect(attempt).toBe(1);

        // The call settles while the dialog is open, so the dialog re-asks; then BOTH
        // answers land, first the stale one.
        handle.refresh(meta({ state: 'ok' }));
        expect(attempt).toBe(2);

        release[0](toolDetail());
        await settled();
        expect(handle.status()).toBe('loading');

        release[1]({ ...toolDetail(), result: 'the settled body, complete' });
        await settled();

        expect(handle.status()).toBe('full');
        expect(paneText('result')).toBe('the settled body, complete');
    });

    it('repaints a settled segment from new metadata without asking again', async () => {
        const load = loaderFor(toolDetail());
        const handle = openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: load.load });
        await settled();
        expect(load.inputs).toHaveLength(1);

        // The server renamed the tool (a duplicate result re-stamps nothing, but a settled
        // name change is legal): the facts move, the payload does not.
        handle.refresh(meta({ name: 'read_file' }));

        expect(load.inputs).toHaveLength(1);
        expect(document.querySelector('.dialog-title')?.textContent).toBe('read_file · tool · ok');
        expect(facts()).toContainEqual({ fact: 'block', text: 'block 0-tool-7' });
        expect(handle.status()).toBe('full');
    });

    it('closes the dialog a discarded attempt belongs to', async () => {
        const load = loaderFor(toolDetail());
        const handle = openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: load.load });
        await settled();

        handle.close();
        expect(handle.isOpen()).toBe(false);
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The cache: scoped by session+turn+block, and only for bytes that cannot move
// ---------------------------------------------------------------------------

describe('the detail cache', () => {
    it('serves a settled segment with no second request, and invalidates on a metadata move', async () => {
        const load = loaderFor(toolDetail());

        const first = openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: load.load });
        await settled();
        first.close();
        expect(load.inputs).toHaveLength(1);
        expect(blockDetailCacheSize()).toBe(1);

        // Reopening the SAME settled segment is free, and the answer is on screen at once.
        const second = openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1', load: load.load });
        expect(load.inputs).toHaveLength(1);
        expect(second.status()).toBe('cached');
        expect(paneText('result')).toBe('the whole recorded file body');
        second.close();

        // A block whose result characters moved is a different answer.
        const third = openBlockDetail({ block: meta({ resultChars: 40, chars: 60 }), turnId: 't1', sessionId: 's1', load: load.load });
        await settled();
        expect(load.inputs).toHaveLength(2);
        third.close();

        // A different session, the same block id: a separate entry, not a reused payload.
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's2', load: load.load });
        await settled();
        expect(load.inputs).toHaveLength(3);
    });

    it('never caches a call that is still running', async () => {
        const running = meta({ state: 'running', chars: 20, resultChars: undefined, endedAt: undefined, eventTo: 7 });
        const load = loaderFor({ ...running, sessionId: 's1', args: '{"path":"notes.md","max":20}' });

        expect(isBlockDetailCacheable(running)).toBe(false);

        const first = openBlockDetail({ block: running, turnId: 't1', sessionId: 's1', load: load.load });
        await settled();
        first.close();

        const second = openBlockDetail({ block: running, turnId: 't1', sessionId: 's1', load: load.load });
        await settled();
        second.close();

        expect(load.inputs).toHaveLength(2);
        expect(blockDetailCacheSize()).toBe(0);
    });

    it('scopes the key by session, turn and block, and detects a moved segment', () => {
        expect(blockDetailCacheKeyOf('s1', 't1', '0-tool-7')).toBe('s1|t1|0-tool-7');
        expect(blockDetailCacheKeyOf(undefined, 't1', '0-tool-7')).toBe('|t1|0-tool-7');

        const settledBlock = meta();
        expect(blockDetailFingerprintOf(settledBlock)).toBe(blockDetailFingerprintOf(meta()));
        expect(blockDetailFingerprintOf(meta({ chars: 47 }))).not.toBe(blockDetailFingerprintOf(settledBlock));
        expect(blockDetailFingerprintOf(meta({ state: 'error' }))).not.toBe(blockDetailFingerprintOf(settledBlock));
        expect(blockDetailFingerprintOf(meta({ eventTo: 12 }))).not.toBe(blockDetailFingerprintOf(settledBlock));
        expect(blockDetailFingerprintOf(meta({ name: 'grep' }))).not.toBe(blockDetailFingerprintOf(settledBlock));
        // A measured span that DISAGREES with the stamps is a metadata move; one that merely
        // repeats what `endedAt - at` already said is the same answer by a different field,
        // and re-reading the route for it would be a wasted request.
        expect(blockDetailFingerprintOf({ ...settledBlock, durationMs: 900 } as ContextBlock)).not.toBe(blockDetailFingerprintOf(settledBlock));
        expect(blockDetailFingerprintOf({ ...settledBlock, durationMs: 800 } as ContextBlock)).toBe(blockDetailFingerprintOf(settledBlock));
    });

    it('keeps the cache bounded instead of holding every payload the reader ever opened', async () => {
        const load = loaderFor(() => toolDetail());
        const ids = Array.from({ length: 45 }, (_, index) => `0-tool-${index}`);

        for (const id of ids) {
            const handle = openBlockDetail({ block: meta({ id }), turnId: 't1', sessionId: 's1', load: load.load });
            await settled();
            handle.close();
        }

        expect(blockDetailCacheSize()).toBe(40);

        // The OLDEST entries are gone, so the first segment has to be read again; the newest
        // one is still free.
        const oldest = openBlockDetail({ block: meta({ id: ids[0] }), turnId: 't1', sessionId: 's1', load: load.load });
        expect(oldest.status()).toBe('loading');
        oldest.close();

        const newest = openBlockDetail({ block: meta({ id: ids[44] }), turnId: 't1', sessionId: 's1', load: load.load });
        expect(newest.status()).toBe('cached');
        newest.close();
    });
});
