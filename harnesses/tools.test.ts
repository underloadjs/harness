// The harness-level demo tools (`./harnessTools`).
//
// These are the small, offline tools every live harness shares. The tests pin the
// R8 fixes: accurate schema defaults for diceRoll, explicit rejection of
// out-of-domain arguments instead of silent clamping, a bounded timezone label,
// the documented UTF-16 unit for textCount, bounded/stated note truncation for
// textSummarize, and per-session (per-agent) state for testFlaky.
//
// Every assertion is exact. The only randomness (diceRoll) is pinned by stubbing
// Math.random, and time is pinned with fake timers, so no test depends on the
// wall clock, the network, or a host environment.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolUiOf } from '../src/harness';
import { harnessTools } from './tools';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// The fixed instant used by the timeNow tests: 2026-01-02T03:04:05.678Z.
const FIXED_TIME = new Date('2026-01-02T03:04:05.678Z');
const FIXED_UNIX = 1767323045;

describe('timeNow', () => {
    it('returns the exact content and panel for a label', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_TIME);

        const envelope = await harnessTools.timeNow('UTC');

        expect(toolUiOf<{ timezone: string; iso: string; unix: number }>(envelope)).toEqual({
            content: {
                timezone: 'UTC',
                iso: '2026-01-02T03:04:05.678Z',
                unix: FIXED_UNIX
            },
            panels: [
                {
                    id: 'timeNow',
                    slot: 'right',
                    title: 'Current time',
                    blocks: [
                        {
                            type: 'keyValue',
                            items: [
                                { label: 'Timezone', value: 'UTC' },
                                { label: 'ISO 8601', value: '2026-01-02T03:04:05.678Z' },
                                { label: 'Unix', value: String(FIXED_UNIX) }
                            ]
                        },
                        { type: 'text', text: 'Read from the server clock at execution time.' }
                    ]
                }
            ]
        });
    });

    it('defaults a missing label to UTC and keeps a present label verbatim', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_TIME);

        const missing = toolUiOf<{ timezone: string }>(await harnessTools.timeNow(undefined));
        const labelled = toolUiOf<{ timezone: string }>(await harnessTools.timeNow('Europe/Paris'));

        expect(missing?.content.timezone).toBe('UTC');
        expect(labelled?.content.timezone).toBe('Europe/Paris');
    });

    it('rejects a blank, oversized, or non-string label', async () => {
        await expect(harnessTools.timeNow('   ')).rejects.toThrow(
            'timeNow timezone must be a non-empty string of at most 64 characters.'
        );
        await expect(harnessTools.timeNow('a'.repeat(65))).rejects.toThrow(
            'timeNow timezone must be a non-empty string of at most 64 characters.'
        );
        await expect(harnessTools.timeNow(42 as never)).rejects.toThrow(
            'timeNow timezone must be a non-empty string of at most 64 characters.'
        );

        // Exactly the bound is accepted.
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_TIME);
        const atBound = toolUiOf<{ timezone: string }>(await harnessTools.timeNow('a'.repeat(64)));

        expect(atBound?.content.timezone).toBe('a'.repeat(64));
    });
});

describe('textCount', () => {
    it('counts words by whitespace and characters in UTF-16 code units', async () => {
        // 5 ASCII letters + a space + one astral emoji (2 code units) = 8.
        expect(await harnessTools.textCount('héllo 😀')).toEqual({ words: 2, characters: 8 });

        // Trimming affects the word split only; characters are the raw length.
        expect(await harnessTools.textCount('  one  two  ')).toEqual({ words: 2, characters: 12 });
        expect(await harnessTools.textCount('   ')).toEqual({ words: 0, characters: 3 });
        expect(await harnessTools.textCount('')).toEqual({ words: 0, characters: 0 });
    });
});

describe('diceRoll', () => {
    it('declares the same default and domain the implementation enforces', () => {
        expect(harnessTools.diceRoll.parameters).toEqual({
            type: 'object',
            properties: {
                sides: {
                    type: 'integer',
                    minimum: 2,
                    maximum: 1000,
                    default: 6,
                    description: 'Number of faces on the die, a whole number from 2 to 1000. Defaults to 6.'
                }
            },
            required: [],
            additionalProperties: false
        });
    });

    it('defaults to six sides and returns an exact value', async () => {
        const random = vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(await harnessTools.diceRoll(undefined)).toEqual({ sides: 6, value: 1 });

        // The lowest and highest legal dice, with the roll pinned to each edge.
        expect(await harnessTools.diceRoll(2)).toEqual({ sides: 2, value: 1 });

        random.mockReturnValue(0.999999);
        expect(await harnessTools.diceRoll(1000)).toEqual({ sides: 1000, value: 1000 });
    });

    it('rejects a non-finite, fractional, or out-of-range side count instead of clamping', async () => {
        const message = 'diceRoll sides must be a whole number from 2 to 1000.';

        for (const sides of [1, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '6']) {
            await expect(harnessTools.diceRoll(sides as never)).rejects.toThrow(message);
        }
    });
});

describe('textSummarize', () => {
    it('condenses locally to the first two sentences when no summarizer exists', async () => {
        expect(await harnessTools.textSummarize('One. Two. Three.')).toBe('One. Two.');
        expect(await harnessTools.textSummarize('  ')).toBe('');
    });

    it('bounds the delegated prompt and states the truncation in prompt and result', async () => {
        const notes = `${'A'.repeat(20_000)}TAIL`;
        let prompt = '';

        const result = await harnessTools.textSummarize.execute({
            parameters: notes,
            agents: { summarizer: {} },
            run: async (_agent: string, input: string) => {
                prompt = input;
                return { content: 'Short summary.' };
            }
        } as never);

        const marker = '[notes truncated to 20000 characters]';

        expect(prompt).toBe(`Summarise these notes in at most two sentences:\n\n${'A'.repeat(20_000)}\n\n${marker}`);
        expect(result).toBe(`Short summary.\n\n${marker}`);
    });

    it('states the truncation in the local summary too', async () => {
        const result = await harnessTools.textSummarize(`${'A'.repeat(20_000)}TAIL`);

        expect(result).toBe(`${'A'.repeat(20_000)}\n\n[notes truncated to 20000 characters]`);
    });

    it('leaves a short delegated note untouched', async () => {
        let prompt = '';

        const result = await harnessTools.textSummarize.execute({
            parameters: 'N.',
            agents: { summarizer: {} },
            run: async (_agent: string, input: string) => {
                prompt = input;
                return { content: 'Short summary.' };
            }
        } as never);

        expect(prompt).toBe('Summarise these notes in at most two sentences:\n\nN.');
        expect(result).toBe('Short summary.');
    });
});

describe('testFlaky', () => {
    // Two distinct agent objects stand in for two sessions. `{}` is enough because
    // the tool only uses the agent's identity as a WeakMap key.
    const agentA = {} as never;
    const agentB = {} as never;

    const attempt = (agent: never) => harnessTools.testFlaky.execute({ parameters: {}, agent });

    it('keeps the attempt counter isolated per agent/session', async () => {
        // Interleaved calls: each agent fails twice and succeeds on its third call,
        // independently of the other agent's progress.
        await expect(attempt(agentA)).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(attempt(agentB)).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(attempt(agentA)).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(attempt(agentB)).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(attempt(agentA)).resolves.toBe('Success on attempt 3.');
        await expect(attempt(agentB)).resolves.toBe('Success on attempt 3.');
    });

    it('uses one explicit fallback counter for direct calls with no agent', async () => {
        await expect(harnessTools.testFlaky({})).rejects.toThrow('Temporary failure (attempt 1). Retry the same call.');
        await expect(harnessTools.testFlaky({})).rejects.toThrow('Temporary failure (attempt 2). Retry the same call.');
        await expect(harnessTools.testFlaky({})).resolves.toBe('Success on attempt 3.');
    });
});
