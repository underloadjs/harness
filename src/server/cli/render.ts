// Terminal rendering for harness progress events.
//
// The harness reports the same `HarnessEvent`s a UI receives; this module is the
// CLI's projection of them. `--json` replaces it with one JSON object per line, so
// another program can consume the stream without parsing prose.
//
// Concurrency (R6): tools run concurrently, an agent's response can complete while
// its calls are still in flight, and a `wakeup` resumes it once outcomes land. The
// CLI therefore prints the authoritative `durationMs` on a result, a `pending`
// line for calls still running, and a wake line. It never treats `done` with a
// non-empty `pending` list as the end of the work.
//
// Tool-composition visibility (T2/R5, and F4 of the 2026-11-19 review): the `progress`
// heartbeat has an EXPLICIT arm below, not an implicit fall-through. It is the only frame
// that says the model is still writing while a tool block composes, so the terminal prints
// it as one dim line when the counters move — the same event the tile turns into
// `composing N tool calls · M chars`.

import type { HarnessAssistantMessage, HarnessEvent, HarnessPendingTool } from '../../harness';

// Validate the background-tool fields. The canonical shape is
// `HarnessPendingTool` (src/types/index.ts); the CLI still validates entries
// because persisted/older frames are untrusted input, and the browser has the
// equivalent accessors in src/frontend/contract.ts (the entries stay separate, so
// the small validator is repeated rather than shared through a new module).
const pendingListOf = (value: unknown): HarnessPendingTool[] | undefined => {
    if (!Array.isArray(value)) return undefined;

    const result: HarnessPendingTool[] = [];
    for (const item of value) {
        if (item === null || typeof item !== 'object') continue;

        const candidate = item as { callId?: unknown; name?: unknown; elapsedMs?: unknown };
        if (typeof candidate.callId !== 'string' || candidate.callId.length === 0) continue;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) continue;

        const elapsed = candidate.elapsedMs;
        if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) continue;

        result.push({ callId: candidate.callId, name: candidate.name, elapsedMs: elapsed });
    }

    return result;
};

const pendingOf = (event: HarnessEvent): HarnessPendingTool[] | undefined => {
    if (event.type !== 'tool_result' && event.type !== 'done') return undefined;
    return pendingListOf(event.pending);
};

// One model-request retry, validated (F6). A persisted/older/hand-written frame
// is untrusted input: a missing `error`, a non-numeric `attempt` or a NaN
// `delayMs` would print "retry NaN/undefined in NaNms · undefined" or throw on
// `event.error.message`. The rules mirror src/frontend/contract.ts `retryOf`
// (the browser's accessor) so the terminal and the tile accept exactly the same
// frames; a malformed frame prints NOTHING rather than a fabricated notice.
const retryOf = (
    event: HarnessEvent
): { agent: string; attempt: number; maxAttempts: number; delayMs: number; message: string } | undefined => {
    if (event.type !== 'retry') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;

    const attempt = event.attempt;
    const maxAttempts = event.maxAttempts;
    const delayMs = event.delayMs;

    if (typeof attempt !== 'number' || !Number.isFinite(attempt) || attempt < 1) return undefined;
    if (typeof maxAttempts !== 'number' || !Number.isFinite(maxAttempts) || maxAttempts < attempt) {
        return undefined;
    }
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) return undefined;

    const message = (event.error as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string') return undefined;

    return { agent: event.agent, attempt, maxAttempts, delayMs, message };
};

const durationOf = (event: HarnessEvent): number | undefined => {
    if (event.type !== 'tool_result') return undefined;

    const duration = event.durationMs;
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
};

// (T2 / F4) The tool-composition heartbeat, VALIDATED. A `progress` frame is untrusted
// input like every other frame this file reads (a persisted/older/hand-written journal is
// replayed verbatim), so the rules mirror src/server/turn-projector.ts `toolProgressOf`
// and src/frontend/contract.ts: shape first, then a real phase, then non-negative integer
// counters. `undefined` = "paint nothing": an unknown phase, an `idle` frame (that spelling
// is the DISPLAY plane's clear, the transport never sends it), a zero-slot frame (F3 — the
// same reason the transport stopped emitting it: `composing 0 tool calls · 0 chars` claims
// work and contradicts itself, and PRE-F3 journals on disk really do contain those frames),
// or a malformed counter. Nothing is ever printed as a guess.
const progressOf = (event: HarnessEvent): { agent: string; slots: number; chars: number } | undefined => {
    if (event.type !== 'progress') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;
    if (event.phase !== 'tool-composition') return undefined;

    const slots = event.toolCallSlots;
    const chars = event.argumentChars;

    if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 1) return undefined;
    if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0) return undefined;

    return { agent: event.agent, slots, chars };
};

// Mirror of `formatDuration` in src/frontend/ui/time.ts (tests assert exact text):
// <1s in whole ms, <1min in tenths, otherwise minutes plus zero-padded seconds with
// no separator (R4: `4m12s`), so the terminal and the UI agree.
const formatMs = (milliseconds: number): string => {
    const rounded = Math.round(milliseconds);
    if (rounded < 1000) return `${rounded}ms`;

    if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)}s`;

    const seconds = Math.floor(rounded / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

// `name 1.2s, search 900ms` — deterministic order: the server's array order.
const describePending = (pending: readonly HarnessPendingTool[]): string =>
    pending.map((tool) => `${tool.name} ${formatMs(tool.elapsedMs)}`).join(', ');

export type RenderOptions = {
    json: boolean;
    color: boolean;
};

export type Renderer = (event: HarnessEvent) => void;

const paint = (color: boolean, open: number, close = 0) => (text: string): string =>
    color ? `\x1b[${open}m${text}\x1b[${close}m` : text;

const MAX_TOOL_OUTPUT = 4_000;

const truncate = (text: string): string => {
    if (text.length <= MAX_TOOL_OUTPUT) return text;
    return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more characters)`;
};

const indent = (text: string): string =>
    text
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');

const describeDone = (
    message: HarnessAssistantMessage,
    pending?: readonly HarnessPendingTool[]
): string => {
    const parts = [message.model, message.stopReason];

    if (message.toolCalls.length > 0) {
        parts.push(`${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? '' : 's'}`);
    }

    if (message.usage !== undefined) {
        parts.push(`${message.usage.total} tokens`);
    }

    // A response that still waits on concurrent calls is not a finished agent:
    // say so instead of printing a line that reads terminal (R6).
    if (pending !== undefined && pending.length > 0) {
        parts.push(`${pending.length} tool${pending.length === 1 ? '' : 's'} still running`);
    }

    return parts.join(' · ');
};

export const createRenderer = ({ json, color }: RenderOptions): Renderer => {
    const dim = paint(color, 2);
    const yellow = paint(color, 33);
    const green = paint(color, 32);
    const red = paint(color, 31);

    let lineOpen = false;
    let streamKind: 'text' | 'reasoning' | undefined;

    // (T2 / F4) The composition line already on screen, so a heartbeat that repeats the
    // SAME numbers costs no line. The transport throttles to one frame per 500 ms, so
    // printing every accepted frame would be two lines per second of composition; what a
    // reader wants is the numbers MOVING. Cleared at the same four attempt boundaries the
    // projector clears its field on (`retry` / `attempt_commit` / `done` / `error`,
    // src/server/turn-projector.ts:3245, 3363, 3378, 3439 — plus the F1 terminal edges), so
    // a re-sent attempt is allowed to print the same figures again.
    let lastProgress: { agent: string; slots: number; chars: number } | undefined;

    const endLine = (): void => {
        if (!lineOpen) return;
        process.stdout.write('\n');
        lineOpen = false;
        streamKind = undefined;
    };

    return (event: HarnessEvent): void => {
        if (json) {
            process.stdout.write(`${JSON.stringify(event)}\n`);
            return;
        }

        switch (event.type) {
            case 'start': {
                endLine();
                // A new flow composes its own numbers: the previous flow's line must not
                // suppress this one's first heartbeat (a delegated child re-opening the same
                // counters is a fact worth printing).
                lastProgress = undefined;
                process.stdout.write(`\n${dim(`── ${event.agent} · ${event.model} ──`)}\n`);
                break;
            }

            // Background-tool wakeup (R6). A resume, not a completion: it prints the
            // calls still running and never closes a card. A frame without a usable
            // `pending` list is malformed and prints nothing.
            case 'wakeup': {
                const pending = pendingListOf(event.pending);
                if (pending === undefined) break;

                endLine();
                const agent = event.agent.length > 0 ? event.agent : 'agent';
                const detail =
                    pending.length === 0
                        ? 'pending tools finished · continuing'
                        : `${pending.length} still running · ${describePending(pending)}`;
                process.stdout.write(`${dim(`~ ${agent} woke · ${detail}`)}\n`);
                break;
            }

            // R1: a failed model attempt was abandoned and the same request is
            // re-sent after `delayMs`. One dim line; `--json` carries the event
            // itself for anything that tallies retries. A frame without a usable
            // attempt/delay/error is malformed and prints nothing (F6).
            case 'retry': {
                // The attempt is over: forget the line it printed (see `lastProgress` above).
                // Done BEFORE validation, because a malformed boundary frame still ends the
                // attempt even though it prints nothing.
                lastProgress = undefined;

                const frame = retryOf(event);
                if (frame === undefined) break;

                endLine();
                process.stdout.write(
                    `${dim(`~ ${frame.agent} retry ${frame.attempt}/${frame.maxAttempts} in ${formatMs(frame.delayMs)} · ${frame.message}`)}\n`
                );
                break;
            }

            // (T2 / F4) The tool-composition heartbeat, printed EXPLICITLY rather than
            // falling through to the switch's implicit default. This is the frame that makes
            // a silent 60 s of tool-block composition readable, and the terminal is exactly
            // where the reported incident was watched, so it gets the same dim status-line
            // treatment as `retry`/`wakeup`: one line, only when the counters moved. It
            // changes nothing else — no `endLine()` of the stream is skipped, no prose is
            // touched, and `--json` above still carries the event verbatim.
            case 'progress': {
                const frame = progressOf(event);
                if (frame === undefined) break;

                const same =
                    lastProgress !== undefined &&
                    lastProgress.agent === frame.agent &&
                    lastProgress.slots === frame.slots &&
                    lastProgress.chars === frame.chars;

                if (same) break;

                lastProgress = frame;

                endLine();
                process.stdout.write(
                    `${dim(
                        `~ ${frame.agent} composing ${frame.slots} tool call${frame.slots === 1 ? '' : 's'} \u00b7 ${frame.chars} chars`
                    )}\n`
                );
                break;
            }

            // R3: one model request committed its answer (a tool-calling round ends
            // with no `done`, so this is the only visible boundary it has). The
            // terminal needs no line of its own: the committed prose is already on
            // screen and `--json` carries the frame for anything that tallies
            // attempts.
            case 'attempt_commit': {
                // The attempt is over, so its composition line is stale (see above).
                lastProgress = undefined;
                break;
            }

            case 'reasoning': {
                if (streamKind === 'text') endLine();
                streamKind = 'reasoning';
                process.stdout.write(dim(event.delta));
                lineOpen = true;
                break;
            }

            case 'text': {
                if (streamKind === 'reasoning') endLine();
                streamKind = 'text';
                process.stdout.write(event.delta);
                lineOpen = true;
                break;
            }

            case 'tool_call': {
                endLine();
                process.stdout.write(`${yellow(`→ ${event.call.name}`)} ${dim(event.call.arguments)}\n`);
                break;
            }

            case 'tool_result': {
                endLine();

                // The server's `durationMs` is authoritative: with concurrent calls
                // it excludes time spent waiting behind other work. Absent on an
                // older event, in which case the name is printed alone.
                const duration = durationOf(event);
                const label = duration === undefined ? event.name : `${event.name} · ${formatMs(duration)}`;
                // R1: a cancelled call is a control outcome, not a failure, so it
                // does not get the error marker or the `(error)` suffix.
                const outcome = event.outcome ?? (event.isError ? 'failed' : 'completed');
                const head =
                    outcome === 'cancelled'
                        ? yellow(`← ${label} (cancelled)`)
                        : outcome !== 'completed'
                          ? red(`← ${label} (error)`)
                          : green(`← ${label}`);
                process.stdout.write(`${head}\n${indent(truncate(event.content.length > 0 ? event.content : '(empty result)'))}\n`);

                // Calls still running when this one finished (R6). Absent means the
                // frame predates the field: print nothing rather than "0 pending".
                const pending = pendingOf(event);
                if (pending !== undefined && pending.length > 0) {
                    process.stdout.write(`${dim(`  pending · ${describePending(pending)}`)}\n`);
                }
                break;
            }

            // Per-request token accounting. Silent on purpose: the `done` line below
            // already prints that same request's figure plus the model and stop
            // reason, so a second line per request would only add noise. `--json`
            // emits the event itself for anything that wants to tally.
            case 'usage': {
                break;
            }

            case 'done': {
                // The attempt answered: its composition line is over (see `lastProgress`).
                lastProgress = undefined;
                endLine();
                process.stdout.write(`${dim(`  ${describeDone(event.message, pendingOf(event))}`)}\n`);
                break;
            }

            case 'error': {
                // Same boundary rule as `done`: a failure ends the attempt whose line this was.
                lastProgress = undefined;
                endLine();
                process.stderr.write(`${red(`error: ${event.error.message}`)}\n`);
                break;
            }
        }
    };
};
