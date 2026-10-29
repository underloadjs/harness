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

const durationOf = (event: HarnessEvent): number | undefined => {
    if (event.type !== 'tool_result') return undefined;

    const duration = event.durationMs;
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
};

// Mirror of `formatDuration` in src/frontend/ui/time.ts (tests assert exact text):
// <1s in whole ms, <1min in tenths, otherwise minutes plus zero-padded seconds.
const formatMs = (milliseconds: number): string => {
    const rounded = Math.round(milliseconds);
    if (rounded < 1000) return `${rounded}ms`;

    if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)}s`;

    const seconds = Math.floor(rounded / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

// `name 1.2s, webSearch 900ms` — deterministic order: the server's array order.
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
                const head = event.isError ? red(`← ${label} (error)`) : green(`← ${label}`);
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
                endLine();
                process.stdout.write(`${dim(`  ${describeDone(event.message, pendingOf(event))}`)}\n`);
                break;
            }

            case 'error': {
                endLine();
                process.stderr.write(`${red(`error: ${event.error.message}`)}\n`);
                break;
            }
        }
    };
};
