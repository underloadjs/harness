// The ONE place the browser turns a LAZY detail body into view data (R2/R8).
//
// Two surfaces, one module, because the rule is the same for both: the request already
// named ONE thing by id, the server returned exactly that thing, and the user asked for it
// by CLICK. Reading it is not "compiling the transcript" — this module only unwraps fields
// that already exist. Everything else in the browser stays event-free, which is why the
// mapping lives here: a reader can prove the default path never touches it, because
// nothing else imports it.
//
//   - `TurnStepDetail`  (GET .../turns/:turnId/steps/:stepId)  — the verbatim recorded
//     PAIR of a step: the event that opened it and the event that settled it.
//   - `TurnBlockDetail` (GET .../turns/:turnId/blocks/:blockId) — ONE context-bar segment
//     plus its exact recorded bytes (T11/R8), for every kind: a prompt, an instruction
//     set, a reasoning window, a superseded answer, or a tool call's arguments+result.
//
// Rules:
//   - NO re-pairing and NO re-derivation: the server paired `callId` within the
//     opening event's own invocation (turn-display.ts:297), and concatenated a block's
//     `eventFrom..eventTo` (turn-display.ts:469), so this module only unwraps fields
//     that already exist.
//   - Missing pieces stay missing (`settled: false`, no `result`), never a
//     synthesized answer.
//   - Durations prefer the server's measured `durationMs` (types/index.ts:1845) and
//     fall back to nothing at all — the same "never invent a span" rule ui/tools.ts
//     applies to a legacy record.
//   - The two events are carried VERBATIM (`opening`/`resultEvent`) so a details
//     dialog can offer "copy the raw event" without a second request.
//
// Cross-references:
//   - ./view-api.ts `getStepDetail`/`getBlockDetail` — the two routes
//   - ./ui/turns.ts                  — the only caller (a tool chip's expand, a bar click)
//   - ./ui/tools.ts                  — the card that paints a step payload
//   - ./ui/context-detail.ts         — the dialog that paints a block payload
//   - ./view-context.ts              — the bar's segment model (shared duration rule)
//   - ./contract.ts                  — the field accessors reused here

import type { HarnessEvent, HarnessToolOutcome, HarnessActionRequest, HarnessActionAnswer, ToolMediaDescriptor, ToolUiPanel } from '../types';
import type { ContextBlock, ContextBlockKind, TurnBlockDetail, TurnStepDetail } from '../shared/turn-display';
import { actionAnswerEventOf, toolDurationOf } from './contract';
import { contextBlockDurationOf } from './view-context';

export type StepDetailPayload = {
    /** Which kind of step this is, from the OPENING event, not from a name. */
    kind: 'tool' | 'action';
    /** Tool name (or the action's question title) — display only. */
    name: string;
    /**
     * The raw `tool_call.arguments` JSON string exactly as the model sent it
     * (types/index.ts:100). Empty string when the opening event carries none.
     */
    arguments: string;
    /** False when the recorded turn has no settled event for this step. */
    settled: boolean;
    /** The full `tool_result.content`, present only when the call settled. */
    result?: string;
    /** Authoritative classification; absent only on a pre-`outcome` recording. */
    outcome?: HarnessToolOutcome;
    /** Server-measured span; absent = never measured (never a local guess here). */
    durationMs?: number;
    /** Every `ToolUiPanel` the result contributed — FULL cells/rows (detail-only). */
    panels?: ToolUiPanel[];
    /** Every media descriptor the result contributed (never base64). */
    media?: ToolMediaDescriptor[];
    /** Kind `action` only: the recorded question. */
    request?: HarnessActionRequest;
    /** Kind `action` only: the recorded answer, once there is one. */
    answer?: HarnessActionAnswer;
    /** `eventTimes` entries the server echoed with the pair. */
    openedAt?: number;
    settledAt?: number;
    /** The step's tool-call identity, when both events carry one. */
    callId?: string;
    /** The verbatim events, for the dialog's raw copy. */
    opening: HarnessEvent;
    resultEvent?: HarnessEvent;
};

// The tool name of an opening event: `tool_call.call.name`, the action's question title,
// or the NAME a result-only recording carries on the result itself (mirroring how
// `DisplayStep.name` is described at turn-display.ts:321 — the compact row's name and this
// payload's are read from the same event, so they can only agree).
const nameOfOpening = (event: HarnessEvent): string => {
    if (event.type === 'tool_call') return event.call.name;
    if (event.type === 'tool_result') return event.name;
    if (event.type === 'action_request') return event.request.question;

    return '';
};

// Unwrap one fetched step detail. Total: a detail whose opening event is not a step
// opener (a malformed or unexpected frame) still yields a payload — with empty
// arguments and `settled: false` — rather than throwing inside an open dialog.
export const stepDetailPayloadOf = (detail: TurnStepDetail): StepDetailPayload => {
    const opening = detail.opening.event;
    const resultEvent = detail.result?.event;

    // A RESULT-ONLY recording (a protocol that reports results without calls, or a missed
    // `tool_call`, ../server/turn-projector.ts:1159) carries the settled content ON the
    // opening event: `DisplayStep.detail.stepId` is that result's own index, and the
    // projector documents "the RESULT event is this step's own opening, so detail answering
    // it alone is exact". Unwrapping the opening's own fields is not re-pairing — the
    // server already addressed this step by that index — and without it a result-only
    // tool's panel document would never reach the reader at all.
    const settledEvent = resultEvent ?? (opening.type === 'tool_result' ? opening : undefined);

    const payload: StepDetailPayload = {
        kind: opening.type === 'action_request' ? 'action' : 'tool',
        name: nameOfOpening(opening),
        arguments: opening.type === 'tool_call' ? (opening.call.arguments ?? '') : '',
        settled: settledEvent !== undefined,
        opening,
        ...(detail.opening.at === undefined ? {} : { openedAt: detail.opening.at }),
        ...(detail.callId === undefined ? {} : { callId: detail.callId })
    };

    if (opening.type === 'action_request') payload.request = opening.request;

    if (settledEvent === undefined) return payload;

    // The settled event VERBATIM, so a details dialog can offer "copy the raw response"
    // without a second request (the field the payload type promises). A result-only
    // recording has no second event, so it stays absent there rather than repeating the
    // opening under two names.
    if (resultEvent !== undefined) payload.resultEvent = resultEvent;

    const settledAt = detail.result?.at ?? (resultEvent === undefined ? detail.opening.at : undefined);
    if (settledAt !== undefined) payload.settledAt = settledAt;

    if (settledEvent.type === 'tool_result') {
        payload.result = settledEvent.content;
        // R1: `outcome` is authoritative when present; `isError` is its boolean
        // projection on an older recording (the same rule ui/turns.ts:5125 applies).
        payload.outcome = settledEvent.outcome ?? (settledEvent.isError ? 'failed' : 'completed');

        const duration = toolDurationOf(settledEvent);
        if (duration !== undefined) payload.durationMs = duration;

        if (Array.isArray(settledEvent.ui)) payload.panels = settledEvent.ui;
        if (Array.isArray(settledEvent.media)) payload.media = settledEvent.media;

        return payload;
    }

    if (settledEvent.type === 'action_answer') {
        const frame = actionAnswerEventOf(settledEvent);
        if (frame !== undefined) payload.answer = frame.answer;
    }

    return payload;
};

// Guard for a fetched body: the route's answer is `{ detail }`, and a proxy that
// answers 200 with something else must not make the renderer read `.opening.event`
// blindly (the same "a 200 is not proof of the contract" rule api.ts applies to
// every JSON answer).
export const isStepDetail = (value: unknown): value is TurnStepDetail =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as TurnStepDetail).stepId === 'string' &&
    (value as TurnStepDetail).opening !== null &&
    typeof (value as TurnStepDetail).opening === 'object' &&
    (value as TurnStepDetail).opening.event !== null &&
    typeof (value as TurnStepDetail).opening.event === 'object';

// ---------------------------------------------------------------------------
// The SECOND lazy surface: ONE context-bar segment (T11, R8)
// ---------------------------------------------------------------------------
//
// `TurnBlockDetail` (src/shared/turn-display.ts:524) is `ContextBlock` PLUS the exact
// recorded bytes of that block. Unwrapping it is again pure field access: the server
// already concatenated `eventFrom..eventTo`, already split a tool call into its recorded
// `arguments` and `result`, and already echoed the metadata the segment shows, so this
// module adds no pairing, no measuring and no wording. Absent payload fields stay absent
// — "the record holds no such bytes" is the answer, never a synthesized empty string.
//
// Cross-references:
//   - ./view-api.ts `getBlockDetail` — the route (GET /views/:id/turns/:t/blocks/:b)
//   - ./ui/context-detail.ts         — the dialog that paints this payload
//   - ./view-context.ts              — the segment metadata this must agree with

/** Which recorded bytes this block's answer carries, per kind, all exact and verbatim. */
export type BlockDetailPayload = {
    kind: ContextBlockKind;
    /** The server-decided label (`read`, `instructions`, `answer`, …). */
    name: string;
    /**
     * The metadata AS THE ROUTE ANSWERED it. The route embeds the segment's own values,
     * so rendering the header from here (rather than from the local block) is what makes
     * "the dialog and its segment cannot disagree" true even after a restart.
     */
    block: ContextBlock;
    sessionId: string;
    turnId: string;
    blockId: string;
    /** `user` / `assistant` / `reasoning`: the exact recorded text. Absent when the
     *  record holds none (never ''), and absent for a tool or an instruction set. */
    text?: string;
    /** `tool`: the raw `tool_call.arguments` string the model sent. */
    args?: string;
    /** `tool`: the recorded `tool_result.content`. Absent while no result is recorded. */
    result?: string;
    /** `system`: one entry per recorded system message, in send order. */
    entries?: readonly string[];
    /** True when this block's bytes are complete: a settled tool, or a prose window that
     *  the server has stopped growing. A running call answers `false` and is re-fetched. */
    settled: boolean;
    /** The server's span, or undefined when the record cannot say (never a local guess). */
    durationMs?: number;
    /**
     * Characters this ANSWER actually carries, measured from the payload itself
     * (`args + result`, the entries, or `text`). The bar's own figure stays on `block`,
     * so the dialog can show both: the count the segment was sized from, and the number
     * of characters this response delivered. They agree by invariant 5; if a proxy ever
     * truncates the answer, the difference is visible instead of silent.
     */
    detailChars: number;
};

// A string field is present only when the server sent a string: `null`, a number or an
// object from a malformed 200 reads as absent rather than as `String(value)`, which would
// invent text the record never held.
const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const entriesOf = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value) ? (value as unknown[]).filter((entry): entry is string => typeof entry === 'string') : undefined;

/**
 * Unwrap one fetched block detail. Total: an unexpected body still yields a payload the
 * dialog can render (an empty pane plus the metadata) instead of throwing inside an open
 * modal.
 */
export const blockDetailPayloadOf = (detail: TurnBlockDetail): BlockDetailPayload => {
    const text = textOf(detail.text);
    const args = textOf(detail.args);
    const result = textOf(detail.result);
    const entries = entriesOf(detail.entries);

    const payload: BlockDetailPayload = {
        kind: detail.kind,
        name: detail.name,
        block: detail,
        sessionId: detail.sessionId,
        turnId: detail.turnId,
        blockId: detail.id,
        settled: false,
        detailChars: 0
    };

    if (text !== undefined) payload.text = text;
    if (args !== undefined) payload.args = args;
    if (result !== undefined) payload.result = result;
    if (entries !== undefined) payload.entries = entries;

    const span = contextBlockDurationOf(detail);
    if (span !== undefined) payload.durationMs = span;

    if (detail.kind === 'tool') {
        // A tool's bytes are its two halves; `resultChars` present-but-undefined in the
        // metadata is the server's "no result recorded", which is the running answer.
        payload.detailChars = (args?.length ?? 0) + (result?.length ?? 0);
        payload.settled =
            detail.state === 'ok' || detail.state === 'error' || detail.state === 'cancelled';

        return payload;
    }

    if (detail.kind === 'system') {
        payload.detailChars = (entries ?? []).reduce((sum, entry) => sum + entry.length, 0);
        payload.settled = entries !== undefined;

        return payload;
    }

    payload.detailChars = text?.length ?? 0;
    payload.settled = text !== undefined;

    return payload;
};

/**
 * Guard for a fetched body: `GET .../blocks/:blockId` answers `{ block }`
 * (`SessionBlockDetailResponse`, ../server/protocol.ts:712). A 200 that is not a block
 * (a proxy's HTML page parsed as JSON, an error body) must not make the dialog read
 * `.kind` blindly.
 */
export const isBlockDetail = (value: unknown): value is TurnBlockDetail => {
    if (value === null || typeof value !== 'object') return false;

    const candidate = value as TurnBlockDetail;

    return (
        typeof candidate.id === 'string' &&
        typeof candidate.turnId === 'string' &&
        typeof candidate.sectionId === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.chars === 'number' &&
        (candidate.kind === 'user' ||
            candidate.kind === 'system' ||
            candidate.kind === 'reasoning' ||
            candidate.kind === 'assistant' ||
            candidate.kind === 'tool')
    );
};
