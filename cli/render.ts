// Terminal rendering for harness progress events.
//
// The harness reports the same `HarnessEvent`s a UI receives; this module is the
// CLI's projection of them. `--json` replaces it with one JSON object per line, so
// another program can consume the stream without parsing prose.

import type { HarnessAssistantMessage, HarnessEvent } from '../src/harness';

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

const describeDone = (message: HarnessAssistantMessage): string => {
    const parts = [message.model, message.stopReason];

    if (message.toolCalls.length > 0) {
        parts.push(`${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? '' : 's'}`);
    }

    if (message.usage !== undefined) {
        parts.push(`${message.usage.total} tokens`);
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
                const head = event.isError ? red(`← ${event.name} (error)`) : green(`← ${event.name}`);
                process.stdout.write(`${head}\n${indent(truncate(event.content.length > 0 ? event.content : '(empty result)'))}\n`);
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
                process.stdout.write(`${dim(`  ${describeDone(event.message)}`)}\n`);
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
