// The routed lane door's half of the missing-thread refusal (issue 0034, F2).
//
// The inline doors are pinned with the engine in
// `../../engine/harness.thread-runtime.test.ts`. This file owns the two facts that need
// the server worker: the lane authority's exact refusal text, and the cross-tree source
// scan that proves the sentence exists in exactly the three doors that write it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agent, harness } from '../../engine/index';
import type { Agent, HarnessStream, HarnessStreamEvent } from '../../engine/index';
import { createLaneAuthority } from './lane-authority';

const SENTENCE = 'is not available in this harness; it was never created';

const missingThread = (threadId: string): string =>
    `Thread "${threadId}" is not available in this harness; it was never created, or it was deleted.`;

const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;
    return async function* stream() {
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const brain = (stream: HarnessStream): Agent => agent({ model: 'merge/ds4-flash', stream });

const quiet = (entry: Agent) => harness({ agents: { writer: entry }, presets: false });

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');

const PRODUCTION_SOURCES: Record<string, string> = {
    'engine/harness.ts': join(SRC, 'engine', 'harness.ts'),
    'server/workers/lane-authority.ts': join(SRC, 'server', 'workers', 'lane-authority.ts'),
    'engine/tools/runtime/threadRead.tool.ts': join(SRC, 'engine', 'tools', 'runtime', 'threadRead.tool.ts')
};

const productionSources = (): string[] => {
    const files: string[] = [];
    const collect = (absolute: string, relative: string): void => {
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
            const next = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) collect(join(absolute, entry.name), next);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(next);
        }
    };
    collect(SRC, '');
    return files.sort();
};

const spellings = (file: string, source: string): { copies: number; file: string } => ({
    copies: source.split(SENTENCE).length - 1,
    file
});

describe('the routed lane door raises the one missing-thread sentence', () => {
    it('raises that sentence from the routed door too, where the message is the whole record', async () => {
        const laneEpoch = 1;
        const missing = 'thread-999';
        // An id no conversation lane has ever created, answered from an authority opened the
        // way ./lane-host.ts opens one. A lane holds no thread registry of its own: the
        // canonical harness is the only thing that can answer, which is what made the
        // session-phrased head wrong at this door.
        const core = quiet(brain(scripted([answer('unused')])));
        const authority = createLaneAuthority({ harness: core });
        authority.openLane(laneEpoch);
        const rejection = (await authority
            .answer(laneEpoch, { op: 'thread:read', threadId: missing, identity: {} })
            .catch((error: unknown) => error)) as Error;

        // Exact string, not a loose fragment of one variant. The id has to be inside the
        // sentence: a lane rejection crosses the boundary as `error: <message>` text alone
        // (./lane-worker-loop.ts, the reply that stringifies an Error), so NOTHING else
        // survives the hop to say which thread was refused. That is why unifying the wording
        // is not cosmetic — the message is the entire record of the fact on this door.
        expect(rejection.message).toBe(missingThread(missing));
    });

    it('leaves exactly three production sources able to write the sentence, each exactly once', () => {
        const CORE = readFileSync(PRODUCTION_SOURCES['engine/harness.ts']!, 'utf8');
        const AUTHORITY = readFileSync(PRODUCTION_SOURCES['server/workers/lane-authority.ts']!, 'utf8');
        const READ_TOOL = readFileSync(PRODUCTION_SOURCES['engine/tools/runtime/threadRead.tool.ts']!, 'utf8');

        // One sentence means one wording, and the files allowed to spell it out are exactly
        // the three doors. A fourth file is a drift that has started; a second copy inside one
        // file means a call site stopped routing through the copy that file already has.
        expect(productionSources().filter((file) => readFileSync(join(SRC, file), 'utf8').includes(SENTENCE))).toEqual([
            'engine/harness.ts',
            'engine/tools/runtime/threadRead.tool.ts',
            'server/workers/lane-authority.ts'
        ]);
        expect([spellings('harness.ts', CORE), spellings('lane-authority.ts', AUTHORITY), spellings('threadRead.tool.ts', READ_TOOL)]).toEqual([
            { copies: 1, file: 'harness.ts' },
            { copies: 1, file: 'lane-authority.ts' },
            { copies: 1, file: 'threadRead.tool.ts' }
        ]);

        // WHERE each copy lives is part of the contract: the core keeps its sentence in
        // `threadStateOf`, the guard every inline thread operation resolves the id through,
        // the routed door restates it because a worker module has no core import to borrow
        // from, and the model-facing door raises it from its missing-RECORD tail — which only
        // runs after the visibility answer has already been given, so a wrong-but-visible id
        // never reaches it.
        expect(CORE).toMatch(/const threadStateOf = \(threadId: string\): ThreadState => \{/);
        expect(CORE).toMatch(/throw new HarnessError\(\s*.Thread "\$\{threadId\}" is not available in this harness/);
        expect(AUTHORITY).toMatch(/throw new Error\(`Thread "\$\{request\.threadId\}" is not available in this harness/);
        expect(READ_TOOL).toMatch(/if \(record === undefined\) \{/);
        expect(READ_TOOL).toMatch(/throw new Error\(\s*.Thread "\$\{threadId\}" is not available in this harness/);
    });
});
