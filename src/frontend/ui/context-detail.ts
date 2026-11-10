// The full-detail dialog for ONE context-bar segment (T11: R8).
//
// One click on one segment, one request for that segment, and the answer is the EXACT
// recorded bytes — for ANY kind, not only tools: a user prompt, a system instruction set, a
// reasoning window, a superseded answer, or a tool call's arguments plus its result
// (../shared/turn-display.ts:494-530). This is the whole reason the bar can stay compact: the
// default wire carries the metadata, and this dialog pays for the text only when a reader
// asks for it.
//
// WHY A DIALOG, AND WHY THIS ONE
// ------------------------------
// `ui/dialog.ts` is the shell every payload surface in this app already uses (stacking, focus
// trap, restored focus, the counted scroll lock, the shared Copy machinery). The tool card's
// inline `<details>` expansion is the wrong shape here: a bar segment is 8px wide, there is
// nothing beside it to expand into, and a turn can hold hundreds of segments — so the payload
// appears where the reader is already looking, at full width, and disappears when they are
// done.
//
// THE STATE MACHINE (each state is one painted surface, never a silent fallback)
// -----------------------------------------------------------------------------
//   'cached'   a settled block whose metadata has not moved since this browser last read it
//              -> the answer renders synchronously and NO request is made;
//   'loading'  the one request is in flight;
//   'full'     the exact bytes are on screen, one pane per payload field;
//   'error'    the request failed: the message is shown IN the body with a Retry that re-arms
//              the same loader — a dropped detail must never look like "there was nothing",
//              the rule ./tools.ts already enforces for a step;
//   'unwired'  no loader was injected (a standalone embed, a test): the dialog says so and
//              issues no request rather than pretending to hold the payload.
//
// STALENESS, THREE WAYS
// ---------------------
//   1. a RETRY or a live refresh supersedes the previous attempt: every response carries a
//      ticket, and a response whose ticket is old is dropped;
//   2. CLOSING the dialog drops a late answer (`destroyed`), so a resolved promise cannot
//      resurrect a detached modal or move focus — the guard ./file-preview.ts documents;
//   3. the CACHE is keyed by session + turn + block and carries the METADATA FINGERPRINT it
//      was written from. A block whose characters/state/event range moved since is a MISS by
//      construction, so a call that was still running when the reader peeked at it can never
//      be served as a finished one. A running block is not cached at all.
//
// THE ONE CONTROL, AND THE COLOUR THAT GOES WITH IT (T5: R5/R6)
// --------------------------------------------------------------
// Everything above this line is READ-ONLY by design; the dialog has exactly one write, the
// inclusion chip. Two facts on the meta line carry a STATE — the kind chip (the only fact
// that carries `state`) and the inclusion chip — and those two, and only those two, get a
// tone token and a glyph, because the report this answers is "a wall of identical grey pills"
// (R8: the panes, the copy buttons and every other chip stay exactly as they were). The
// heading keeps the state in WORDS regardless: the modal covers the segment the colour came
// from, and a screen reader never sees a glyph.
//
// The inclusion chip is a `<button aria-pressed>` and its own row of behaviour: click, await
// the route, repaint from the RECEIPT (never from the click — a tool unit can move under the
// dialog while the request is out), and on a refusal state the failure IN the body using the
// note vocabulary the payload failure already uses, with the persisted chip untouched.
//
// Cross-references:
//   - ../view-api.ts `readBlockDetail` — the lazy read the tile injects for this dialog
//   - ../api.ts `patchBlockInclusion` — the inclusion write, when the tile injects none;
//     ../view-api.ts `writeBlockInclusion` is the same call for a caller that goes through the
//     facade instead of the transport
//   - ../view-detail.ts                — `blockDetailPayloadOf` / `isBlockDetail` (the unwrap)
//   - ../view-context.ts               — the segment model and the shared duration/char rules
//   - ./context-bar.ts                 — the widget whose click opens this
//   - ./turns.ts                       — the tile that owns one open segment per turn
//   - ./dialog.ts / ./dialog.css       — the modal shell
//   - ./tools.ts                       — `createCodeBlock`, the line-numbered payload viewer

import type { ContextBlock, StepDisplayState, TurnBlockDetail } from '../../shared/turn-display';
// T7: the segment dialog is the ONE surface where a reader switches a segment in or out of
// the prompt, and `./tools.ts:107` is the precedent for a `ui/` module holding its own
// transport call: the tile may still INJECT a writer (the way it injects `loadBlockDetail`),
// and a standalone embed then reaches the route itself instead of silently doing nothing.
import { patchBlockInclusion } from '../api';
import { contextBlockDurationOf, contextBlockIsRunning, formatContextCharCount } from '../view-context';
import { blockDetailPayloadOf, isBlockDetail } from '../view-detail';
import type { BlockDetailPayload } from '../view-detail';
import { createTextCopyButton, openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import { formatDuration } from './time';
import { createCodeBlock, createPayloadViewer } from './tools';

// The one transport, injected by the shell (../view-api.ts `getBlockDetail`) exactly like
// `loadStepDetail`, so this module owns no network code of its own.
export type BlockDetailLoadInput = {
    turnId: string;
    blockId: string;
    sessionId?: string;
};

export type BlockDetailLoader = (input: BlockDetailLoadInput) => Promise<TurnBlockDetail>;

export type BlockDetailStatus = 'cached' | 'loading' | 'full' | 'error' | 'unwired';

/**
 * T7: the inclusion write (../api.ts `patchBlockInclusion`, route
 * `PATCH .../turns/{t}/blocks/{b}`). It resolves the state the server PERSISTED — the whole
 * tool-call unit's verdict — never the value it was handed, because the dialog paints from
 * the answer rather than from the click.
 */
export type BlockInclusionWriteInput = {
    turnId: string;
    blockId: string;
    sessionId?: string;
    included: boolean;
};

export type BlockInclusionWriter = (input: BlockInclusionWriteInput) => Promise<boolean>;

// The transport this module falls back to when the tile injects none. `ui/tools.ts` calls
// `../api` directly for the same reason (a dialog opened outside the shell still works), and
// a board with NO session id cannot address a session-scoped route at all, so that case is
// a stated refusal rather than a request to `/sessions//…`.
const defaultInclusionWriter: BlockInclusionWriter = ({ sessionId, turnId, blockId, included }) => {
    if (sessionId === undefined || sessionId.length === 0) {
        return Promise.reject(new Error('this board has no session, so no segment can be switched'));
    }

    return patchBlockInclusion(sessionId, turnId, blockId, included).then((receipt) => receipt.included);
};

export type BlockDetailOptions = {
    /** The segment the reader clicked: identity, timing and counts for the header. */
    block: ContextBlock;
    turnId: string;
    sessionId?: string;
    /** The lazy route. Absent => the dialog reports it is unwired and asks for nothing. */
    load?: BlockDetailLoader;
    /**
     * T7: the inclusion toggle's transport. Absent => `defaultInclusionWriter` above, which
     * is why the chip is a control only when the SERVER published an inclusion verdict —
     * a segment nobody can switch never grows a button that does nothing.
     */
    write?: BlockInclusionWriter;
    /** Explicit focus return on close; omitted => whatever opened it. */
    returnFocus?: HTMLElement | null;
};

export type BlockDetailDialog = {
    /** The `role="dialog"` panel (./dialog.ts). */
    element: HTMLElement;
    blockId: string;
    isOpen: () => boolean;
    close: () => void;
    /**
     * The tile calls this when a `context:set` moves THIS block while the dialog is open.
     * A block that was still running is re-read (its bytes grew since the last answer); a
     * settled block only repaints its facts, because its recorded text cannot change.
     */
    refresh: (block: ContextBlock) => void;
    status: () => BlockDetailStatus;
};

// ---------------------------------------------------------------------------
// The cache: module-scoped, bounded, fingerprint-guarded
// ---------------------------------------------------------------------------

// A reader who walks a long turn opens dozens of segments; 40 holds the last screens' worth
// of payloads without keeping a whole session's text in the browser. `Map` iteration order is
// insertion order, so the oldest entry is exactly the one that goes.
export const BLOCK_DETAIL_CACHE_LIMIT = 40;

const blockDetails = new Map<string, { fingerprint: string; payload: BlockDetailPayload }>();

/** The cache scope: a block id is unique within a TURN, and a turn within a SESSION. */
export const blockDetailCacheKeyOf = (sessionId: string | undefined, turnId: string, blockId: string): string =>
    `${sessionId ?? ''}|${turnId}|${blockId}`;

/**
 * Everything that would change this segment's answer.
 *
 * `chars`/`argsChars`/`resultChars` move while a call streams, `state` flips once it settles,
 * `eventTo` extends while a prose window is still receiving deltas, and `endedAt`/`durationMs`
 * arrive with the result. A block that matches on every one of them IS the same recorded bytes,
 * which is the only thing the cache may serve twice.
 *
 * T7 adds `included`, and it is not optional to include: the inclusion is part of what this
 * segment IS (an excluded call answers "excluded from context"), the reader changes it from
 * inside the dialog, and nothing else in the metadata moves when it does. Without it, a
 * toggle would leave the cached answer — chip text and all — looking untouched on the next
 * open, which is exactly the stale-serve this fingerprint exists to prevent. The value is
 * spelled out (`included`/`excluded`/absent) so an ABSENT verdict — the bar's own segment
 * model, which never carries the field — cannot collide with either published state.
 */
export const blockDetailFingerprintOf = (block: ContextBlock): string =>
    [
        block.kind,
        block.name,
        String(block.chars),
        block.argsChars ?? '',
        block.resultChars ?? '',
        block.state ?? '',
        block.eventFrom ?? '',
        block.eventTo ?? '',
        block.at ?? '',
        block.endedAt ?? '',
        contextBlockDurationOf(block) ?? '',
        block.inPrompt === true ? 'prompt' : 'streamed',
        block.included === undefined ? '' : block.included ? 'included' : 'excluded'
    ].join(':');

/** A running call's bytes are still arriving, so its answer is never cacheable. */
export const isBlockDetailCacheable = (block: ContextBlock): boolean => !contextBlockIsRunning(block);

/** A hit only when the fingerprint still matches (an exact read, never a fuzzy reuse). */
export const cachedBlockDetail = (key: string, fingerprint: string): BlockDetailPayload | undefined => {
    const entry = blockDetails.get(key);

    return entry !== undefined && entry.fingerprint === fingerprint ? entry.payload : undefined;
};

export const rememberBlockDetail = (key: string, fingerprint: string, payload: BlockDetailPayload): void => {
    if (blockDetails.size >= BLOCK_DETAIL_CACHE_LIMIT && !blockDetails.has(key))
        blockDetails.delete(blockDetails.keys().next().value as string);

    blockDetails.set(key, { fingerprint, payload });
};

/** Drop one entry: the hook for "this block's metadata just moved". */
export const invalidateBlockDetail = (key: string): void => {
    blockDetails.delete(key);
};

/** Board teardown and tests: the cache belongs to the browser, not to one document. */
export const clearBlockDetailCache = (): void => {
    blockDetails.clear();
};

export const blockDetailCacheSize = (): number => blockDetails.size;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** One labelled fact on the dialog's meta line. */
export type BlockDetailFact = {
    fact: string;
    text: string;
    /**
     * R5: the state tone, painted by `styles.css` off `[data-tone]`. ONLY the two
     * state-bearing facts ever set it — the kind chip and the inclusion chip — because the
     * complaint this answers is "a wall of identical grey pills": recolouring the character
     * counts too would put the reader back to square one, just in a louder palette.
     */
    tone?: BlockDetailTone;
    /** R5: the glyph that goes with the tone, painted in an `aria-hidden` span — the WORD
     *  beside it stays the meaning, exactly as `./tools.ts:307-315` rules for a tool card. */
    glyph?: string;
};

/** The four tones the dialog can paint, named after the tokens `styles.css` maps them to. */
export type BlockDetailTone = 'ok' | 'danger' | 'warn' | 'muted';

// The kind chip's tone and glyph per settled state: the same four characters and the same
// colour assignment `./tools.ts:307-315` uses on a tool card, so a call reads identically in
// the strip, on its card, and here. Green for a settled success, red for a tool FAILURE,
// warn for bytes that are still arriving (nothing failed), and a MUTED `⊘` for a call that
// was cut off — a control outcome, so it borrows neither the green nor the red. `running`
// keeps an arrow so the chip never reflows when the call settles, and a block with NO state
// (a prompt, an instruction set, a thinking window) paints no glyph at all: there is no
// state to signal, and R8 says this dialog stays quiet everywhere the state is not the story.
const STATE_FACTS: Readonly<Record<StepDisplayState, { tone: BlockDetailTone; glyph: string }>> = {
    running: { tone: 'warn', glyph: '→' },
    ok: { tone: 'ok', glyph: '✓' },
    error: { tone: 'danger', glyph: '✕' },
    cancelled: { tone: 'muted', glyph: '⊘' }
};

/**
 * T7/R6: the inclusion chip, which answers three different questions and must not blur them.
 *
 *   - `included === false` — the reader's OWN exclusion: the transcript unit is withheld from
 *     the requests that follow, and this verdict WINS over any per-kind reading, because it
 *     is the one state a human set (../shared/turn-display.ts:541 documents the tri-state);
 *   - `included === true` — the same control switched the other way, phrased as the positive
 *     "in the prompt" so the pair reads as one switch rather than as two different questions;
 *   - ABSENT — a different question again: the server could not name ONE transcript entry
 *     behind this segment (a thinking window streams several entries, an instruction block
 *     joins several messages, a legacy record has no call id), so there is nothing to switch
 *     and the chip states what the PROJECTOR knows — the static per-kind `inPrompt` verdict,
 *     the same words it carried before this control existed.
 */
const inclusionFactOf = (block: ContextBlock): BlockDetailFact => {
    if (block.included === false) {
        return { fact: 'prompt', text: 'excluded from context', tone: 'danger', glyph: '✕' };
    }

    if (block.included === true) return { fact: 'prompt', text: 'in the prompt', tone: 'ok', glyph: '✓' };

    return { fact: 'prompt', text: block.inPrompt === true ? 'in the prompt' : 'not replayed into the prompt' };
};

/**
 * True exactly when the inclusion chip is a CONTROL rather than a statement: the server
 * published a verdict, so there is a transcript entry behind this segment to switch.
 */
export const blockInclusionIsSwitchable = (block: ContextBlock): boolean => block.included !== undefined;

/**
 * The facts line, one entry per claim (exact strings, pinned by ./context-detail.test.ts).
 *
 * It renders from the METADATA, so the dialog answers "what am I looking at" before any
 * response arrives and even when the response fails. `payload` is present only after an
 * answer, and the event range is what lets a reader tell a block that came from the turn
 * record (prompt, instructions — no event evidence) from one that came from recorded deltas.
 *
 * Every figure is the server's. The unit is always CHARACTERS, never tokens.
 */
export const blockDetailFactsOf = (block: ContextBlock, payload?: BlockDetailPayload): BlockDetailFact[] => {
    // R5: the state rides on the kind chip — the ONE fact that carries it — as a tone plus a
    // glyph. An UNSET state (every non-tool kind) contributes neither.
    const state = block.state === undefined ? {} : STATE_FACTS[block.state];

    const facts: BlockDetailFact[] = [
        { fact: 'kind', text: `${block.kind}${block.state !== undefined ? ` · ${block.state}` : ''}`, ...state },
        { fact: 'chars', text: `${formatContextCharCount(block.chars)} characters recorded` }
    ];

    if (block.kind === 'tool') {
        if (block.argsChars !== undefined && block.resultChars !== undefined)
            facts.push({ fact: 'split', text: `args ${formatContextCharCount(block.argsChars)} + result ${formatContextCharCount(block.resultChars)}` });
        else if (block.argsChars !== undefined)
            facts.push({ fact: 'split', text: `args ${formatContextCharCount(block.argsChars)}, no result recorded` });
        else if (block.resultChars !== undefined)
            facts.push({ fact: 'split', text: `result ${formatContextCharCount(block.resultChars)}` });
    }

    if (payload !== undefined)
        facts.push({ fact: 'answer', text: `answer ${formatContextCharCount(payload.detailChars)} characters` });

    const span = contextBlockDurationOf(block);
    facts.push(span === undefined ? { fact: 'time', text: 'no time recorded' } : { fact: 'time', text: `time taken ${formatDuration(span)}` });

    if (block.at !== undefined) facts.push({ fact: 'at', text: `recorded ${formatRecordedTime(block.at)}` });
    if (block.endedAt !== undefined) facts.push({ fact: 'endedAt', text: `settled ${formatRecordedTime(block.endedAt)}` });

    if (block.eventFrom !== undefined && block.eventTo !== undefined)
        facts.push({ fact: 'events', text: `events ${block.eventFrom}-${block.eventTo}` });
    else if (block.eventFrom !== undefined) facts.push({ fact: 'events', text: `event ${block.eventFrom}` });
    else facts.push({ fact: 'events', text: 'from the turn record' });

    facts.push(inclusionFactOf(block));
    facts.push({ fact: 'section', text: `section ${block.sectionId}` });
    facts.push({ fact: 'block', text: `block ${block.id}` });

    return facts;
};

// Absolute stamps in UTC: every other clock in this UI is a SPAN (./time.ts), and a local
// wall-clock string would depend on the reader's timezone. `at`/`endedAt` are epoch stamps,
// so the ISO form is the same instant on every host and in every test.
const formatRecordedTime = (at: number): string => (Number.isFinite(at) ? new Date(at).toISOString() : 'unknown');

// The dialog heading repeats the state in TEXT, exactly like the tool card's heading
// (./tools.ts:797): the modal covers the segment, so colour alone would lose the signal.
const detailTitleOf = (block: ContextBlock): string =>
    `${block.name} · ${block.kind}${block.state !== undefined ? ` · ${block.state}` : ''}`;

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

// A pane: its label plus a Copy button for THAT pane only (the tool dialog's rule — a whole
// -dialog copy of stitched fields is what made copying the result need cutting).
const createDetailPane = (label: string, pane: string, body: HTMLElement, text: () => string): HTMLElement => {
    const section = document.createElement('div');
    section.className = 'block-detail-pane';
    section.dataset.pane = pane;

    const heading = document.createElement('div');
    heading.className = 'tool-heading';

    const name = document.createElement('div');
    name.className = 'tool-label';
    name.textContent = label;

    heading.append(name, createTextCopyButton({ label: `Copy ${label.toLowerCase()}`, text, className: 'tool-copy' }));
    section.append(heading, body);

    return section;
};

// A stated absence: the record holds no such bytes, which is an ANSWER, not a blank.
const createAbsenceNote = (text: string, detail: string): HTMLElement => {
    const note = document.createElement('p');
    note.className = 'block-detail-note';
    note.dataset.detail = detail;
    note.textContent = text;

    return note;
};

// R1 (payload views): a recorded prose payload is shown with the SAME editor-style
// viewer as a tool pane — line numbers, soft wrap, its own scroller — instead of a bare
// `<pre>`. Two reasons it is the shared builder and not a hand-rolled box:
//   - the shell rule `ui/dialog.css .dialog-body pre { white-space: pre }` (0,1,1) outranks
//     a single-class surface, so a plain `pre.reasoning` silently LOSES its wrap inside a
//     dialog; `createPayloadViewer` carries `.tool-code` (0,2,0) and wins;
//   - `pre.textContent` stays byte-identical to the payload (the gutter is CSS generated
//     content), so the pane's Copy button — which closes over the original string, not the
//     DOM — and every consumer still get the exact recorded bytes.
// `block-detail-text` stays on the node because styles.css caps the pane's height through
// it (`.block-detail-text { max-height: min(58vh, 620px) }`); the old `reasoning` class is
// dropped, because an italic quote box is not what a payload surface looks like any more.
export const BLOCK_DETAIL_TEXT_CLASS = 'block-detail-text';

const createTextHost = (value: string): HTMLElement =>
    createPayloadViewer(value, undefined, BLOCK_DETAIL_TEXT_CLASS);

// A JSON-ish argument string gets the JSON highlighter; anything else stays literal.
const looksLikeJson = (value: string): boolean => {
    const trimmed = value.trim();

    return trimmed.startsWith('{') || trimmed.startsWith('[');
};

/**
 * The panes for one answered block: per kind, and only the fields the record actually carries.
 * Exported because the tile re-paints an open dialog from a refreshed payload, and because the
 * pane layout is the part a reader navigates.
 */
export const blockDetailPanesFor = (payload: BlockDetailPayload): HTMLElement[] => {
    const panes: HTMLElement[] = [];

    if (payload.kind === 'tool') {
        if (payload.args === undefined)
            panes.push(createDetailPane('Arguments', 'args', createAbsenceNote('no arguments recorded for this call', 'empty'), () => ''));
        else {
            const args = payload.args;
            panes.push(createDetailPane('Arguments', 'args', createCodeBlock(args, looksLikeJson(args) ? 'json' : undefined), () => args));
        }

        if (payload.result === undefined) {
            // A call with no recorded result is RUNNING or abandoned; either way the answer is
            // "not there yet", which is what the segment's own state already said.
            panes.push(
                createDetailPane('Result', 'result', createAbsenceNote('no result recorded for this call yet', 'pending'), () => '')
            );

            return panes;
        }

        const result = payload.result;
        panes.push(createDetailPane('Result', 'result', createCodeBlock(result, undefined), () => result));

        return panes;
    }

    if (payload.kind === 'system') {
        const entries = payload.entries ?? [];

        if (entries.length === 0) {
            panes.push(
                createDetailPane('Instructions', 'entries', createAbsenceNote('no system instruction entries were recorded', 'empty'), () => '')
            );

            return panes;
        }

        // One pane per recorded system message, in send order. The join the transport applies
        // BETWEEN messages is not part of any entry, so this is the exact set
        // (../shared/turn-display.ts:520).
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            panes.push(createDetailPane(`Instruction ${index + 1}`, `entry-${index + 1}`, createTextHost(entry), () => entry));
        }

        return panes;
    }

    const label = payload.kind === 'user' ? 'Prompt' : payload.kind === 'reasoning' ? 'Thinking' : 'Answer';
    const body = payload.text === undefined
        ? createAbsenceNote('no recorded text for this block', 'empty')
        : createTextHost(payload.text);
    const text = payload.text ?? '';

    panes.push(createDetailPane(label, 'text', body, () => text));

    return panes;
};

/**
 * The whole payload as ONE string, for a caller that wants a single Copy (a clipboard, a
 * debug dump). The dialog itself copies per pane, which is the convention the tool dialog set.
 */
export const blockDetailCopyTextOf = (payload: BlockDetailPayload): string => {
    if (payload.kind === 'tool') {
        const args = payload.args ?? '';

        return payload.result === undefined ? args : `${args}\n\n${payload.result}`;
    }

    if (payload.kind === 'system') return (payload.entries ?? []).join('\n\n');

    return payload.text ?? '';
};

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * Open one segment's full detail. At most one request per open (and per Retry), every state
 * painted, and a handle the tile closes on teardown so a discarded attempt cannot leave a
 * modal showing bytes its turn no longer holds.
 */
export const openBlockDetail = (options: BlockDetailOptions): BlockDetailDialog => {
    const { turnId, sessionId, load, returnFocus } = options;

    // T7: injected by the tile when it has one, otherwise this module's own transport. The
    // chip is only ever a button when the server published a verdict, so an unwired board
    // never shows a control that would reject on click.
    const write = options.write ?? defaultInclusionWriter;

    // The route's answer replaces this (see `request`): the facts are the SERVER's figures,
    // and the block the segment carried is only the pre-response copy of them.
    let block = options.block;

    const key = blockDetailCacheKeyOf(sessionId, turnId, block.id);

    const body = document.createElement('div');
    body.className = 'block-detail';
    body.dataset.kind = block.kind;
    body.dataset.blockId = block.id;
    body.dataset.turnId = turnId;

    const meta = document.createElement('p');
    meta.className = 'block-detail-meta';

    const panes = document.createElement('div');
    panes.className = 'block-detail-panes';

    body.append(meta, panes);

    // The toggle's failure surface: the SAME note vocabulary a failed payload uses
    // (`data-detail='error'`, and the same text-copying child), but appended AFTER the panes
    // instead of replacing them — a reader who cannot switch a segment still needs the
    // arguments and the result on screen to know what they were looking at. Added and removed
    // rather than `hidden`, because `styles.css` gives `.block-detail-note` a `display: flex`,
    // which outranks the attribute default.
    const inclusionNote = document.createElement('p');

    inclusionNote.className = 'block-detail-note';
    inclusionNote.dataset.detail = 'error';
    inclusionNote.dataset.note = 'inclusion';

    /** Show (or clear) the toggle's own error line. */
    const syncInclusionNote = (): void => {
        if (inclusionError.length === 0) {
            if (inclusionNote.parentElement === body) body.removeChild(inclusionNote);

            return;
        }

        inclusionNote.textContent = `the inclusion could not be switched: ${inclusionError}`;

        if (inclusionNote.parentElement !== body) body.append(inclusionNote);
    };

    let status: BlockDetailStatus = 'loading';
    let message = '';
    let payload: BlockDetailPayload | undefined;
    // Stale-response ticket: one increment per attempt, so only the LATEST answer paints.
    let ticket = 0;
    let destroyed = false;
    // One inclusion write at a time: a double click would otherwise queue two writes of the
    // SAME flipped value and the second would land as a no-op against the first's receipt.
    let busy = false;
    let inclusionError = '';

    const paintMeta = (): void => {
        meta.replaceChildren(...blockDetailFactsOf(block, payload).map(createFact));

        body.dataset.kind = block.kind;
        body.dataset.status = status;
    };

    /**
     * T7: the toggle itself. Await the server, THEN paint — no optimistic state, because the
     * unit this click addresses may already have moved (a plugin's `setIncluded`, another
     * tab, a run that committed the result in between), and the receipt is the verdict the
     * transcript actually holds.
     */
    const toggleInclusion = async (): Promise<void> => {
        if (busy) return;

        const wanted = block.included !== true;

        busy = true;
        inclusionError = '';
        // Repaint FIRST: the chip is the button that is disabled while the request is out,
        // which is the only honest answer a click can have before the receipt lands.
        paintMeta();
        syncInclusionNote();

        try {
            const persisted = await write({
                ...(sessionId === undefined ? {} : { sessionId }),
                turnId,
                blockId: block.id,
                included: wanted
            });

            block = { ...block, included: persisted };
            // R4: the fingerprint now covers the inclusion, so the entry cached under the old
            // one is stale by construction. Drop it explicitly as well: this dialog may have
            // served from it, and the next open must ask the route rather than re-serve the
            // state this click just replaced.
            invalidateBlockDetail(blockDetailCacheKeyOf(sessionId, turnId, block.id));
        } catch (error) {
            // Nothing moved and nothing was painted ahead: the chip keeps stating the state
            // the server holds, and the refusal is stated beside the panes.
            inclusionError = error instanceof Error ? error.message : String(error);
        } finally {
            busy = false;
            // Only the meta line, not the panes: a reader mid-scroll through a 200k-character
            // result must not lose their place because they toggled a chip.
            paintMeta();
            syncInclusionNote();
        }
    };

    /**
     * One chip on the facts line.
     *
     * A plain `<span>` for every fact but one: R8 keeps this dialog quiet, so colour and
     * glyph appear only where a STATE is the claim (the kind chip, the inclusion chip), and
     * the character counts, stamps and ids stay the neutral pills they always were.
     *
     * The inclusion fact is a real `<button>` with `aria-pressed` (R6), never a clickable
     * looking like a control: this is the one claim on the line a reader can CHANGE, and a
     * span would leave a screen reader with no state to announce and no action to take.
     */
    const createFact = (fact: BlockDetailFact): HTMLElement => {
        const switchable = fact.fact === 'prompt' && blockInclusionIsSwitchable(block);
        const node = document.createElement(switchable ? 'button' : 'span');

        node.className = 'block-detail-fact';
        node.dataset.fact = fact.fact;

        if (fact.tone !== undefined) node.dataset.tone = fact.tone;

        if (fact.glyph !== undefined) {
            // `aria-hidden`, because the text beside it already says `ok` / `error` /
            // `excluded from context`: the glyph is for the eye, not the announcement
            // (./tools.ts:307-315, same rule for the same characters).
            const glyph = document.createElement('span');

            glyph.className = 'block-detail-fact-glyph';
            glyph.setAttribute('aria-hidden', 'true');
            glyph.textContent = fact.glyph;
            node.append(glyph);
        }

        // The words of the fact in their OWN element: the glyph above is a sibling, so a
        // consumer that wants the CLAIM (`tool · ok`, `in the prompt`) reads one node rather
        // than subtracting a decoration from the chip's text.
        const text = document.createElement('span');

        text.className = 'block-detail-fact-text';
        text.textContent = fact.text;
        node.append(text);

        if (!switchable) return node;

        const button = node as HTMLButtonElement;

        button.type = 'button';
        // `aria-pressed` states which way the switch is set: PRESSED means this segment IS
        // in the prompt, which is the affirmative reading of the chip's own label.
        button.setAttribute('aria-pressed', block.included === true ? 'true' : 'false');
        button.title = block.included === true
            ? 'Exclude this segment from the requests that follow'
            : 'Include this segment in the requests that follow';
        button.disabled = busy;
        button.addEventListener('click', () => void toggleInclusion());

        return node;
    };

    const paintPanes = (): void => {
        if (payload !== undefined && (status === 'full' || status === 'cached')) {
            panes.replaceChildren(...blockDetailPanesFor(payload));

            return;
        }

        const note = document.createElement('p');
        note.className = 'block-detail-note';
        note.dataset.detail = status;

        // The message is its OWN node: a Retry button inside the note would otherwise become
        // part of the text a reader (or a test) reads as the failure reason.
        const text = document.createElement('span');
        text.className = 'block-detail-note-text';
        note.append(text);

        if (status === 'loading') text.textContent = 'loading the recorded text…';
        else if (status === 'unwired') text.textContent = 'this board has no block detail route';
        else {
            text.textContent = `the recorded text could not be loaded: ${message}`;

            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'button small block-detail-retry';
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => void request());
            note.append(retry);
        }

        panes.replaceChildren(note);
    };

    const paint = (): void => {
        paintMeta();
        paintPanes();

        // A dialog that HAS the answer re-titles itself from the route's metadata, so the
        // heading and the segment agree even if a `context:set` renamed the tool.
        handle?.update({ title: detailTitleOf(block) });
    };

    const request = async (): Promise<void> => {
        if (load === undefined) {
            status = 'unwired';
            paint();

            return;
        }

        const current = ++ticket;
        status = 'loading';
        message = '';
        paint();

        try {
            const detail = await load({ ...(sessionId === undefined ? {} : { sessionId }), turnId, blockId: block.id });

            // Dropped, in order of importance: the dialog was closed, or a retry/refresh
            // started after this request. Painting either answer would show bytes the reader
            // never asked for.
            if (destroyed || current !== ticket) return;

            if (!isBlockDetail(detail)) {
                status = 'error';
                message = 'the harness server answered with something that is not a block detail';
                paint();

                return;
            }

            payload = blockDetailPayloadOf(detail);
            block = payload.block;

            if (isBlockDetailCacheable(block)) rememberBlockDetail(key, blockDetailFingerprintOf(block), payload);

            status = 'full';
            paint();
        } catch (error) {
            if (destroyed || current !== ticket) return;

            status = 'error';
            message = error instanceof Error ? error.message : String(error);
            paint();
        }
    };

    // The dialog itself, opened once and held for the dialog's whole life: `paint` and the
    // handle's own methods close over it, and every paint happens after this line — the first
    // one is below, once the payload is known or the route has been asked.
    const handle: DialogHandle = openDialog({
        title: detailTitleOf(block),
        content: body,
        ...(returnFocus === undefined ? {} : { returnFocus }),
        onClose: () => {
            // A late answer must not resurrect a closed modal, and cannot move focus.
            destroyed = true;
        }
    });

    // Paint from the metadata first, then resolve the payload — from the cache (no request) or
    // from the route (exactly one request).
    const cached = load !== undefined && isBlockDetailCacheable(block)
        ? cachedBlockDetail(key, blockDetailFingerprintOf(block))
        : undefined;

    if (cached !== undefined) {
        payload = cached;
        block = cached.block;
        status = 'cached';
        paint();
    } else if (load === undefined) {
        status = 'unwired';
        paint();
    } else {
        void request();
    }

    return {
        element: handle.element,
        blockId: options.block.id,
        isOpen: () => handle?.isOpen === true,
        close: () => {
            destroyed = true;
            ticket += 1;
            handle?.close();
        },
        refresh: (next: ContextBlock) => {
            const wasPartial = contextBlockIsRunning(block);

            // T7: the bar's segment model is compiled from the turn's EVENTS and never
            // carries `included` — the detail route is the only producer (../server/api.ts
            // `getSessionTurnBlock`) — so a metadata refresh must not silently un-exclude a
            // segment the reader switched off a moment ago. A published value on the incoming
            // block always wins; absence means "no news", not "back on".
            block = next.included === undefined && block.included !== undefined
                ? { ...next, included: block.included }
                : next;

            invalidateBlockDetail(blockDetailCacheKeyOf(sessionId, turnId, next.id));

            if (wasPartial || contextBlockIsRunning(next)) {
                // Its bytes were (or still are) growing, so the previous answer is stale by
                // construction: ask again rather than repaint a truncated payload.
                void request();

                return;
            }

            // A settled block's recorded text cannot change; only its stamps/state figures can
            // be re-stamped, and those live on the facts line.
            paint();
        },
        status: () => status
    };
};
