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
// T7 adds the one fact on this line a reader can CHANGE: the segment's inclusion. The rules
// pinned below are that a control appears only where the server published a verdict (three
// spellings, three answers: absent / on / off), that the chip paints the state the SERVER
// answered rather than the one that was clicked, that a refusal leaves the stated state exactly
// where it was and says so, that a metadata refresh may not silently undo the reader's switch,
// and that a switch makes the cached answer stale on the spot.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-detail.test.ts

import type { ContextBlock, StepDisplayState, TurnBlockDetail } from '../../shared/turn-display';
import type { BlockInclusionWriteInput } from './context-detail';
import {
    blockDetailCacheSize,
    blockDetailCacheKeyOf,
    blockDetailFactsOf,
    blockDetailFingerprintOf,
    blockInclusionIsSwitchable,
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

// T7: the same tool detail with the server's inclusion verdict published. This is the ONE
// fact on the facts line the reader can CHANGE, so it gets its own fixture instead of being
// folded into `toolDetail()`: every other test in this file pins the ABSENT verdict, which is
// what the bar's own segment model carries (../server/api.ts `getSessionTurnBlock` is the only
// producer). The three spellings — absent, `true`, `false` — are three different answers, and
// the dialog must not conflate any two of them.
const switchedDetail = (included: boolean): TurnBlockDetail => ({ ...toolDetail(), included });

// Uplift T7 (F8): the same three verdicts on a THINKING window, where the field addresses the
// entry's `reasoningIncluded` flag rather than an exclusion unit (../server/api.ts
// `getSessionTurnBlock` joins it through the recorded thinking text). Three answers, and the
// absent one is the case F8 changed: the bar's model carries no verdict, so the chip may not
// claim the thinking is out of the prompt.
const thinkSwitchedDetail = (included: boolean): TurnBlockDetail => ({ ...thinkDetail(), included });

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
/**
 * The facts line as a reader reads it: the CLAIM of each chip. A state glyph paints inside its
 * own `aria-hidden` sibling (./context-detail.ts `createFact`), so these strings never carry a
 * decoration character — which is the point R8 makes about colour and glyph being an ADDITION
 * to the words, not a replacement for them.
 */
const facts = (): { fact: string; text: string }[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.block-detail-fact')).map((node) => ({
        fact: node.dataset.fact as string,
        text: (node.querySelector('.block-detail-fact-text') as HTMLElement).textContent as string
    }));
/**
 * R5/R8: the visual state each chip carries, in DOM order — the `[data-tone]` `styles.css`
 * paints from, and the glyph a screen reader never hears. Every entry but the state-bearing
 * ones must be `null`/`null`: this dialog stays a wall of quiet pills, and only a chip whose
 * whole job IS a state gets coloured.
 */
const factStates = (): { fact: string; tone: string | null; glyph: string | null; hidden: boolean }[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.block-detail-fact')).map((node) => {
        const glyph = node.querySelector('.block-detail-fact-glyph');

        return {
            fact: node.dataset.fact as string,
            tone: node.dataset.tone ?? null,
            glyph: glyph?.textContent ?? null,
            hidden: glyph?.getAttribute('aria-hidden') === 'true'
        };
    });
/** The one chip that is a control: the inclusion switch, whatever state it is in. */
const inclusionChip = (): HTMLElement | null => document.querySelector('.block-detail-fact[data-fact="prompt"]');
/** The toggle's own refusal line, named apart from the payload note so neither can stand in for the other. */
const inclusionNoteText = (): string | null =>
    document.querySelector('.block-detail-note[data-note="inclusion"]')?.textContent ?? null;
const closeDialog = (): void => {
    (document.querySelector('.dialog-close') as HTMLButtonElement).click();
};

/** One writer per test: it records its exact input and answers with the state the server held. */
const writerFor = (
    persisted: (input: BlockInclusionWriteInput, attempt: number) => boolean | Promise<boolean>
) => {
    const inputs: BlockInclusionWriteInput[] = [];

    return {
        inputs,
        write: async (input: BlockInclusionWriteInput) => {
            inputs.push(input);

            return persisted(input, inputs.length);
        }
    };
};

/** A writer that has not answered yet, so "nothing was painted ahead" is observable. */
const pendingWriter = () => {
    const inputs: BlockInclusionWriteInput[] = [];
    let settleWrite: ((persisted: boolean | Error) => void) | undefined;
    const promise = new Promise<boolean>((resolve, reject) => {
        settleWrite = (value) => (value instanceof Error ? reject(value) : resolve(value));
    });

    return {
        inputs,
        settle: (value: boolean | Error) => settleWrite?.(value),
        write: async (input: BlockInclusionWriteInput) => {
            inputs.push(input);

            return promise;
        }
    };
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

        // R5/R8: the state rides on the ONE chip whose job it is — a colour `styles.css` paints
        // off `[data-tone]`, plus a glyph that is `aria-hidden` because the words beside it
        // already say `ok`. `hidden: true` only ever appears beside a glyph, and every other
        // chip is the neutral pill it always was. The inclusion chip is uncoloured here because
        // its verdict is ABSENT on this block: with no published verdict there is no switch, so
        // the chip states `in the prompt` — the projector's recorded claim — and nothing else.
        expect(factStates()).toEqual([
            { fact: 'kind', tone: 'ok', glyph: '✓', hidden: true },
            { fact: 'chars', tone: null, glyph: null, hidden: false },
            { fact: 'split', tone: null, glyph: null, hidden: false },
            { fact: 'time', tone: null, glyph: null, hidden: false },
            { fact: 'at', tone: null, glyph: null, hidden: false },
            { fact: 'endedAt', tone: null, glyph: null, hidden: false },
            { fact: 'events', tone: null, glyph: null, hidden: false },
            { fact: 'prompt', tone: null, glyph: null, hidden: false },
            { fact: 'section', tone: null, glyph: null, hidden: false },
            { fact: 'block', tone: null, glyph: null, hidden: false }
        ]);
    });

    it('carries every state as a tone and a glyph on the kind chip, and no state at all on a chip that has none', () => {
        // The four characters and the four tokens, pinned against the shared state union
        // (../../shared/turn-display.ts `StepDisplayState`): a reader who cannot read the words
        // still gets which of the four this is, and a colour-blind reader gets a shape.
        const kindFact = (state: StepDisplayState) => {
            const fact = blockDetailFactsOf({ ...toolDetail(), state }).find((candidate) => candidate.fact === 'kind');

            return { tone: fact?.tone, glyph: fact?.glyph };
        };

        expect([kindFact('ok'), kindFact('error'), kindFact('running'), kindFact('cancelled')]).toEqual([
            { tone: 'ok', glyph: '✓' },
            { tone: 'danger', glyph: '✕' },
            { tone: 'warn', glyph: '→' },
            { tone: 'muted', glyph: '⊘' }
        ]);

        // An UNSET state paints nothing: a prompt, an instruction set and a thinking window have
        // no outcome to colour, and a green tick on a user prompt would be a claim nobody made.
        expect(
            blockDetailFactsOf(promptDetail()).map((fact) => [fact.fact, fact.tone, fact.glyph])
        ).toEqual([
            ['kind', undefined, undefined],
            ['chars', undefined, undefined],
            ['time', undefined, undefined],
            ['at', undefined, undefined],
            ['events', undefined, undefined],
            ['prompt', undefined, undefined],
            ['section', undefined, undefined],
            ['block', undefined, undefined]
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

    // Uplift T7 (F8): the static `inPrompt: false` the projector stamps on a thinking window is
    // the FALLBACK verdict for a server that cannot name the transcript entry behind it, not a
    // claim about the segment class. Whether a window's thinking rides in the requests that
    // follow is decided per entry by the trimmer's thinking policy (T6's `reasoningIncluded`
    // flag; `turn` withholds a closed turn's thinking and keeps the open one, `all` withholds
    // every thought, `off` sends all of them). So when no verdict was published, the chip states
    // WHERE the decision lives — no absolute, because an absolute about thinking is what this
    // fix removed (../shared/turn-display.ts documents the same rule on the field).
    it('states where a thinking window is decided when the server published no verdict', () => {
        const factsOfThink = blockDetailFactsOf(thinkDetail());

        expect(factsOfThink).toContainEqual({ fact: 'prompt', text: 'replay decided by the thinking policy' });
        expect(factsOfThink).toContainEqual({ fact: 'events', text: 'events 7-9' });
        // Every OTHER kind still answers with the projector's recorded claim, unchanged: this is
        // a thinking-window fix, not a rewording of the whole facts line.
        expect(blockDetailFactsOf(meta({ inPrompt: false }))).toContainEqual({ fact: 'prompt', text: 'not replayed into the prompt' });
        expect(blockDetailFactsOf(promptDetail())).toContainEqual({ fact: 'prompt', text: 'in the prompt' });
        expect(blockDetailFactsOf(systemDetail())).toContainEqual({ fact: 'prompt', text: 'in the prompt' });
        expect(blockDetailFactsOf(answerDetail())).toContainEqual({ fact: 'prompt', text: 'in the prompt' });
    });
});

// ---------------------------------------------------------------------------
// The inclusion switch (T5/R6/R7): the one fact on this line a reader can CHANGE
// ---------------------------------------------------------------------------

describe('the inclusion switch', () => {
    /** The chip's words, without the glyph that paints beside them. */
    const chipText = (): string | undefined =>
        inclusionChip()?.querySelector('.block-detail-fact-text')?.textContent;

    it('paints a published verdict as a real control, and an absent one as a plain fact', () => {
        // ON: pressed, phrased in the affirmative, ok tone and a tick. `aria-pressed="true"` is
        // the reading of the chip's own label — this segment IS in the requests that follow.
        const on = openBlockDetail({ block: meta({ included: true }), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('BUTTON');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');
        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.dataset.tone).toBe('ok');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.textContent).toBe('✓');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.getAttribute('aria-hidden')).toBe('true');
        on.close();

        // OFF: the reader's OWN exclusion, phrased as what it is, danger tone and a cross, and
        // not pressed. A screen reader gets `excluded from context, not pressed, button`.
        const off = openBlockDetail({ block: meta({ included: false }), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('BUTTON');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('false');
        expect(chipText()).toBe('excluded from context');
        expect(inclusionChip()?.dataset.tone).toBe('danger');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.textContent).toBe('✕');
        off.close();

        // ABSENT: no verdict from the server means NO control. The bar's own segment model never
        // carries the field, so a switch here would be a chip that looks live and changes
        // nothing — worse than no chip. The chip states the projector's recorded claim instead,
        // uncoloured, as the plain span it has always been.
        openBlockDetail({ block: meta(), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('SPAN');
        expect(inclusionChip()?.hasAttribute('aria-pressed')).toBe(false);
        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.dataset.tone).toBeUndefined();
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')).toBeNull();

        // The model rule the DOM follows, stated once: addressable exactly when the server named
        // the transcript entry behind the segment.
        expect([meta(), meta({ included: true }), meta({ included: false })].map(blockInclusionIsSwitchable)).toEqual([
            false,
            true,
            true
        ]);
    });

    // Uplift T7 (F8): the same control on a THINKING window, where `included` is that entry's
    // thinking axis. A published verdict means the server named the ONE entry whose `reasoning`
    // is exactly this window's recorded bytes, so the switch has something to switch; the static
    // `inPrompt: false` these windows carry does not, and silence now says "the thinking policy
    // decides" instead of restating that fallback.
    it('switches a thinking window through its thinking, and says who decides when it cannot', () => {
        // VERDICT `true`: the thinking rides in the requests that follow. The chip reads exactly
        // like the tool chip in that state — one switch, one pair of wordings — which is the
        // point of routing both axes through the same field.
        const on = openBlockDetail({ block: thinkSwitchedDetail(true), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('BUTTON');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');
        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.dataset.tone).toBe('ok');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.textContent).toBe('✓');
        on.close();

        // VERDICT `false`: this thinking is withheld from the requests that follow while the
        // entry itself keeps travelling (../types reasoningIncluded).
        const off = openBlockDetail({ block: thinkSwitchedDetail(false), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('BUTTON');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('false');
        expect(chipText()).toBe('excluded from context');
        expect(inclusionChip()?.dataset.tone).toBe('danger');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.textContent).toBe('✕');
        off.close();

        // NO VERDICT: plain span, no tone, no glyph — and the WORDING is about the policy, not
        // about the prompt. The assertion that pins F8 itself is that no absolute survives here:
        // a closed window is out under `turn`, in under `off`, and the chip cannot tell which.
        openBlockDetail({ block: thinkDetail(), turnId: 't1', sessionId: 's1' });

        expect(inclusionChip()?.tagName).toBe('SPAN');
        expect(inclusionChip()?.hasAttribute('aria-pressed')).toBe(false);
        expect(chipText()).toBe('replay decided by the thinking policy');
        expect(inclusionChip()?.dataset.tone).toBeUndefined();
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')).toBeNull();
        expect(chipText() ?? '').not.toMatch(/never|always|not replayed/i);

        // Addressability follows the published verdict alone — a thinking window is a control
        // exactly when the server named its entry, and the static `inPrompt: false` never makes
        // one on its own.
        expect([thinkDetail(), thinkSwitchedDetail(true), thinkSwitchedDetail(false)].map(blockInclusionIsSwitchable)).toEqual([
            false,
            true,
            true
        ]);
    });

    it('paints the state the server answered, never the state that was clicked', async () => {
        const loader = loaderFor(switchedDetail(true));
        // The server answers each click with the verdict the transcript ENDS UP holding — here
        // the two clicks land on opposite states, which is what proves the chip follows the
        // receipt rather than the click.
        const writer = writerFor((_input, attempt) => attempt === 1 ? false : true);

        const handle = openBlockDetail({
            block: meta({ included: true }),
            turnId: 't1',
            sessionId: 's1',
            load: loader.load,
            write: writer.write
        });

        await settled();

        expect(loader.inputs).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '0-tool-7' }]);
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');

        (inclusionChip() as HTMLButtonElement).click();
        await settled();

        // The write names THIS segment in THIS session and the flipped value — and the payload
        // route is not asked again: switching a fact is not a reason to re-read the record.
        expect(writer.inputs).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '0-tool-7', included: false }]);
        expect(loader.inputs).toHaveLength(1);
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('false');
        expect(chipText()).toBe('excluded from context');
        expect(inclusionChip()?.dataset.tone).toBe('danger');
        expect(inclusionChip()?.querySelector('.block-detail-fact-glyph')?.textContent).toBe('✕');
        // Nothing failed, so the refusal line is absent, and the recorded halves are still on
        // screen — a toggle repaints the facts line, never the body of the dialog.
        expect(inclusionNoteText()).toBeNull();
        expect(paneText('args')).toBe(ARGS);
        expect(paneText('result')).toBe(RESULT);
        expect(handle.status()).toBe('full');

        (inclusionChip() as HTMLButtonElement).click();
        await settled();

        expect(writer.inputs).toHaveLength(2);
        expect(writer.inputs[1]).toEqual({ sessionId: 's1', turnId: 't1', blockId: '0-tool-7', included: true });
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');
        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.dataset.tone).toBe('ok');
        expect(loader.inputs).toHaveLength(1);

        handle.close();
    });

    it('paints nothing ahead of the answer, and keeps the stated state when the switch is refused', async () => {
        const loader = loaderFor(switchedDetail(true));
        const writer = pendingWriter();

        const handle = openBlockDetail({
            block: meta({ included: true }),
            turnId: 't1',
            sessionId: 's1',
            load: loader.load,
            write: writer.write
        });

        await settled();

        (inclusionChip() as HTMLButtonElement).click();
        await settled();

        // No optimistic paint: the chip still states the state the SERVER holds, and the control
        // is disabled, which is the only honest answer a second click can get while the first is
        // still in flight.
        expect(writer.inputs).toHaveLength(1);
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');
        expect(chipText()).toBe('in the prompt');
        expect((inclusionChip() as HTMLButtonElement).disabled).toBe(true);

        (inclusionChip() as HTMLButtonElement).click();
        expect(writer.inputs).toHaveLength(1);

        // Refused. Nothing moved on the server, so nothing moves here either; the refusal is
        // stated where the reader is looking, in the same note vocabulary a failed payload uses
        // (`data-detail="error"`) but as its OWN line, appended after the panes rather than in
        // place of them.
        writer.settle(new Error('the run owns this transcript'));
        await settled();

        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');
        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.dataset.tone).toBe('ok');
        expect((inclusionChip() as HTMLButtonElement).disabled).toBe(false);
        expect(inclusionNoteText()).toBe('the inclusion could not be switched: the run owns this transcript');
        expect(document.querySelector('.block-detail-note[data-note="inclusion"]')?.getAttribute('data-detail')).toBe('error');
        expect(panes()).toHaveLength(2);
        expect(paneText('result')).toBe(RESULT);
        expect(handle.status()).toBe('full');

        handle.close();

        // A later attempt that succeeds clears the line: it reports the last attempt, not the
        // last time anything went wrong — and a reader who retried and got a receipt must not be
        // left staring at a refusal that no longer stands.
        const succeeded = writerFor(() => false);
        const again = openBlockDetail({
            block: meta({ included: true }),
            turnId: 't1',
            sessionId: 's1',
            load: loader.load,
            write: succeeded.write
        });

        await settled();
        (inclusionChip() as HTMLButtonElement).click();
        await settled();

        expect(chipText()).toBe('excluded from context');
        expect(inclusionNoteText()).toBeNull();
        again.close();
    });

    it('drops the cached answer the moment the segment stops being what it was', async () => {
        const loader = loaderFor(switchedDetail(true));
        const writer = writerFor(() => false);
        const open = () =>
            openBlockDetail({
                block: meta({ included: true }),
                turnId: 't1',
                sessionId: 's1',
                load: loader.load,
                write: writer.write
            });

        const first = open();

        await settled();
        expect(loader.inputs).toHaveLength(1);
        first.close();

        // The same segment, untouched: one entry, served from memory, no second request.
        const cached = open();

        expect(cached.status()).toBe('cached');
        expect(loader.inputs).toHaveLength(1);
        expect(blockDetailCacheSize()).toBe(1);

        // The switch changes what the segment IS, so the entry that dialog just served is stale
        // by construction and goes immediately — the next open has to state the new verdict
        // rather than re-serve the old chip text out of memory.
        (inclusionChip() as HTMLButtonElement).click();
        await settled();

        expect(blockDetailCacheSize()).toBe(0);

        const after = open();

        await settled();
        expect(loader.inputs).toHaveLength(2);
        expect(after.status()).toBe('full');
        after.close();
    });

    it('keeps a segment the reader switched off across a metadata refresh', async () => {
        const loader = loaderFor(switchedDetail(false));

        const handle = openBlockDetail({ block: meta({ included: false }), turnId: 't1', sessionId: 's1', load: loader.load });

        await settled();

        expect(chipText()).toBe('excluded from context');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('false');

        // The bar re-published the SAME segment, and its own model never carries the field.
        // Silence means "no news", not "back on": the chip may not flip itself into the prompt.
        handle.refresh(meta());

        expect(chipText()).toBe('excluded from context');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('false');
        expect(inclusionChip()?.dataset.tone).toBe('danger');

        // A published verdict on the incoming segment DOES win: the server knows more than this
        // dialog's memory does (another tab, or a plugin's own `setIncluded`).
        handle.refresh(meta({ included: true }));

        expect(chipText()).toBe('in the prompt');
        expect(inclusionChip()?.getAttribute('aria-pressed')).toBe('true');

        handle.close();
    });

    it('treats the switch as part of what the segment is', () => {
        // The cache may only serve a segment that is still exactly what it was, and the inclusion
        // is now one of the things it IS. The three verdicts are three fingerprints, and an
        // ABSENT one — the bar's own model — cannot collide with either published state.
        const [absent, on, off] = [meta(), meta({ included: true }), meta({ included: false })].map(blockDetailFingerprintOf);

        expect([absent.split(':').pop(), on.split(':').pop(), off.split(':').pop()]).toEqual(['', 'included', 'excluded']);
        expect(new Set([absent, on, off]).size).toBe(3);

        // T7: the same rule has to hold for a THINKING window, because that is the segment whose
        // published verdict arrived after this cache was written. Nothing changed in the field
        // list — the thinking axis rides on the SAME `included` figure the tool axis uses — so
        // invalidation is automatic; this pins it, because a withheld thought served from a
        // riding thought's entry would put the old chip text back on screen after a click.
        const [thinkAbsent, thinkOn, thinkOff] = [thinkDetail(), thinkSwitchedDetail(true), thinkSwitchedDetail(false)].map(
            blockDetailFingerprintOf
        );

        expect([thinkAbsent.split(':').pop(), thinkOn.split(':').pop(), thinkOff.split(':').pop()]).toEqual([
            '',
            'included',
            'excluded'
        ]);
        expect(new Set([thinkAbsent, thinkOn, thinkOff]).size).toBe(3);
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
