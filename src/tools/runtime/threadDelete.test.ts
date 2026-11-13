// tools/runtime/threadDelete.test.ts — the pure entry contract behind `threadDelete`.
//
// WHY AN ENTRY TEST HERE (issue 0027)
// -----------------------------------
// The sibling thread entries have no entry tests of their own: `threadSend`,
// `threadList` and `threadFork` are covered through the behavioural suites
// (src/harness.threads.test.ts / src/harness.thread-runtime.test.ts) plus the
// literal matrix in src/core/metadata.ownership.test.ts, and the only
// tools/runtime/*.test.ts that exists today (threadRead.test.ts) tests the PURE
// helper the entry delegates to. `threadDelete` has no separate helper — its whole
// body is metadata + the identity-forcing call into `runtime.threadDelete` — so the
// entry itself is what can be tested in isolation, and this is that file.
//
// What is pinned here:
//   - the metadata literal: name, tags, visibility, and the FULL parameter schema
//     with its exact description text (a model's only view of the contract);
//   - the description's behavioural promises: the issue-0027 reason, permanence,
//     the descendant scope, the five refusals, the cascade, and both receipt fields;
//   - the registration literal, exactly, including `order: 255` — the descending
//     `threads`-group rule at src/harness.ts ~1157-1168 makes that number the
//     guarantee that the roster is still declared before the tool that names it;
//   - the entry's import discipline: type-only imports only, no value import of
//     ../../core (that closes a cycle through core/metadata.ts) and no import of
//     core/metadata at all (the same rule metadata.ownership.test.ts applies to the
//     other entries — asserted here because this file is new and that matrix only
//     learns about it in the manifest/pin step);
//   - `execute` wiring: the CALLER's `context.threadId` and the trimmed `thread`
//     argument reach `runtime.threadDelete` in that order, the runtime receipt is
//     returned untouched, and every invalid `thread` is an entry-side error that
//     never reaches the runtime;
//   - BOTH argument shapes: a tool with exactly ONE property has its arguments
//     UNWRAPPED to that value (`threadDelete` arrives as the bare id string on the model
//     path AND on `executeTool`), so the unwrapped string and the `{ thread }` wrapper are
//     each pinned through the same entry — before this case only the wrapper was exercised,
//     which is the shape the entry does NOT receive in production.
//
// Deliberate omissions: `threadRead.tool.ts` is NOT imported, so this file loads
// without the parallel transcript change, and the read/send orders are asserted by
// number rather than by import.
//
// Deterministic throughout: every assertion is an exact value or an exact object.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../types';
import * as threadDeleteEntry from './threadDelete.tool';
import * as threadListEntry from './threadList.tool';
import * as threadSendEntry from './threadSend.tool';

const sourceOf = (file: string): string =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

// The `thread` row, restated in full so a wording change has to be a deliberate one.
const THREAD_PARAMETER = {
    type: 'string',
    minLength: 1,
    description:
        'Id of the finished thread to release, as reported by threadList - one of YOUR descendants. A running thread, this agent\'s default conversation (agent:<name>), a thread outside your lineage, and a deleted or unknown id all fail. There is no default: your own current thread is never the target.'
};

// The two errors the entry can raise itself. The runtime owns every other refusal
// (running thread, default conversation, foreign lineage, unknown id).
const NEEDS_HARNESS = 'threadDelete requires the live harness reference.';
const NEEDS_THREAD = 'threadDelete needs a thread: pass "thread" (see threadList).';

// A runtime stub that records exactly what the entry forwarded and hands back the
// contracted receipt shape (`{ deleted, removedThreadIds }`, cascade included).
const stubRuntime = (deleted: string, removedThreadIds: readonly string[]) => {
    const threadDelete = vi.fn(
        async (_callerThreadId: string | undefined, _threadId: string): Promise<unknown> => ({
            deleted,
            removedThreadIds: [...removedThreadIds]
        })
    );

    return {
        threadDelete,
        context: (parameters?: Record<string, unknown>, threadId?: string): ToolContext =>
            ({
                harness: { runtime: { threadDelete } },
                ...(threadId === undefined ? {} : { threadId }),
                parameters
            }) as unknown as ToolContext
    };
};

describe('threadDelete metadata literal', () => {
    it('owns one pure literal, aliased under the historical name', () => {
        expect(threadDeleteEntry.THREAD_DELETE_NAME).toBe('threadDelete');
        // Same-file alias: the module's `metadata` IS the constant the scanner reads.
        expect(threadDeleteEntry.metadata).toBe(threadDeleteEntry.THREAD_DELETE_METADATA);

        const metadata = threadDeleteEntry.THREAD_DELETE_METADATA;

        expect(metadata.name).toBe('threadDelete');
        expect(metadata.visibility).toBe('core');
        expect(metadata.tags).toEqual([
            'thread',
            'threads',
            'delete',
            'remove',
            'release',
            'cleanup',
            'roster'
        ]);
        // Harness bookkeeping must never reach the model-facing schema, and nothing
        // else may be in the literal either.
        expect(Object.keys(metadata).sort()).toEqual([
            'description',
            'name',
            'parameters',
            'tags',
            'visibility'
        ]);
    });

    it('declares one required thread id and nothing else', () => {
        expect(threadDeleteEntry.THREAD_DELETE_METADATA.parameters).toEqual({
            type: 'object',
            properties: { thread: THREAD_PARAMETER },
            required: ['thread'],
            additionalProperties: false
        });
    });

    it('states the contract the model cannot infer from the schema', () => {
        const { description } = threadDeleteEntry.THREAD_DELETE_METADATA;

        // Why the tool exists: reclaiming a one-shot delegation's own thread, and the
        // issue that tracks it (the roster cap is what makes it an availability bug).
        // The claim is scoped to a delegation FROM A CONVERSATION: a root delegation
        // reuses the subagent's DEFAULT conversation (`src/harness.ts:10987`,
        // `defaultThreadOf(brain)`), which this tool refuses to release, so "every
        // delegation mints its own thread" was promising a slot that never got minted.
        expect(description).toContain('A delegation FROM A CONVERSATION mints its own thread');
        expect(description).toContain("reuses that subagent's default conversation");
        expect(description).toContain('issue 0027');
        // Read first: deletion is not a close, it is a purge.
        expect(description).toContain('read what you still need with threadRead or agentResult first');
        expect(description).toContain('Deletion is PERMANENT');
        expect(description).toContain(
            'the transcript, its invocation record and its branch lookups all go with it'
        );
        // A deleted id is an error everywhere, which is the promise 0027's review pinned.
        expect(description).toContain(
            'a deleted id becomes unknown to threadList, threadRead, threadSend and this tool'
        );
        // Scope and refusals — ALL FIVE, in the order the runtime reaches them
        // (`threadDeleteFor` lineage gate, then `deleteThread`: default conversation,
        // live target, live descendant, unknown id). The running-descendant refusal is the
        // one a description used to omit, and it is the one that saves a caller from
        // believing a delete was half-applied: `deleteThread`'s descendant pass in
        // `src/harness.ts` throws with the CHILD's id and removes nothing.
        expect(description).toContain('one of YOUR DESCENDANTS that is no longer running');
        expect(description).toContain('Five things are refused');
        expect(description).toContain('a thread that is RUNNING (stop it first)');
        expect(description).toContain('a finished target that still has a RUNNING descendant');
        expect(description).toContain('nothing is half-deleted');
        expect(description).toContain("this agent's default conversation (agent:<name>)");
        expect(description).toContain('a thread outside your lineage');
        // The cascade, and both receipt fields.
        expect(description).toContain('Deleting cascades');
        expect(description).toContain(
            'The receipt reports `deleted` (the id you named) and `removedThreadIds`'
        );
        expect(description).toContain('the cascaded ones included');
    });
});

describe('threadDelete registration literal', () => {
    it('registers with the thread trio, sync, listed like threadSend', () => {
        expect(threadDeleteEntry.registration).toEqual({
            group: 'runtime',
            activation: 'threads',
            mode: 'sync',
            order: 255,
            sessionBound: true,
            alwaysDeclared: false,
            listed: false
        });
    });

    it('keeps the roster declared first under the descending threads-group rule', () => {
        // src/harness.ts ~1157-1168 sorts the `activation: 'threads'` group by
        // DESCENDING `order`, so a LOWER order declares LATER. 255 must therefore stay
        // below the other three, or this tool would be declared before the roster that
        // supplies its only argument.
        //
        // threadRead.tool.ts is a parallel change, so its order is pinned by number
        // (265) rather than by importing that entry.
        const declarationOrder = {
            threadList: threadListEntry.registration.order,
            threadRead: 265,
            threadSend: threadSendEntry.registration.order,
            threadDelete: threadDeleteEntry.registration.order
        };

        expect(declarationOrder).toEqual({
            threadList: 270,
            threadRead: 265,
            threadSend: 260,
            threadDelete: 255
        });
        expect(
            Object.entries(declarationOrder)
                .sort(([, left], [, right]) => right - left)
                .map(([name]) => name)
        ).toEqual(['threadList', 'threadRead', 'threadSend', 'threadDelete']);
    });
});

describe('threadDelete entry import discipline', () => {
    it('imports nothing at run time, so discovery never evaluates a dependency', () => {
        const source = sourceOf('./threadDelete.tool.ts');

        // A runtime entry keeps zero captured local dependencies
        // (scripts/check-package-tools.ts) and must not value-import ../../core, which
        // would close a cycle through core/metadata.ts. Both rules are the same fact:
        // every import line in this file is type-only.
        expect(source.split('\n').filter((line) => line.startsWith('import '))).toEqual([
            "import type { CoreToolMetadata } from '../../core';",
            "import type { ToolContext } from '../../types';"
        ]);
        // The metadata.ownership.test.ts rule for every entry, applied to the new one.
        expect(source).not.toMatch(/^\s*(import|export)[^;]*from\s+'[^']*core\/metadata'/m);
        // The AST reader needs both literals declared as object literals in this file.
        expect(source).toContain('export const registration = {');
    });
});

describe('threadDelete execute', () => {
    it('forwards the runtime-supplied caller thread and the trimmed id, and returns the receipt untouched', async () => {
        const { threadDelete, context } = stubRuntime('thread-7', ['thread-7', 'thread-9']);

        await expect(
            threadDeleteEntry.execute(context({ thread: '  thread-7  ' }, 'thread-3'))
        ).resolves.toEqual({ deleted: 'thread-7', removedThreadIds: ['thread-7', 'thread-9'] });

        // Argument ORDER and content are the contract: caller first, target second,
        // and the runtime receives the trimmed id, not the padded one.
        expect(threadDelete.mock.calls).toEqual([['thread-3', 'thread-7']]);
    });

    it('passes an undefined caller thread through for a threadless host view', async () => {
        const { threadDelete, context } = stubRuntime('thread-1', ['thread-1']);

        await expect(threadDeleteEntry.execute(context({ thread: 'thread-1' }))).resolves.toEqual({
            deleted: 'thread-1',
            removedThreadIds: ['thread-1']
        });
        // The runtime reads `undefined` as "no calling conversation" and leaves that
        // caller unscoped; the entry never substitutes a guess.
        expect(threadDelete.mock.calls).toEqual([[undefined, 'thread-1']]);
    });

    // THE SHAPE THE LIVE CALL ACTUALLY HANDS OVER. `threadDelete` declares exactly ONE
    // schema property, so `toolParameterKey` (src/core/tool.ts:65-73) names `thread` and
    // `resolveToolParameters` UNWRAPS the model's `{ "thread": "…" }` to that property's
    // VALUE on both the model path and the direct `executeTool` path. Every other case in
    // this file builds the wrapper object — the shape the schema advertises and a
    // hand-built context produces — so without this case the entry could have read only
    // the wrapper and passed every test here while the real call delivered `undefined`
    // ("threadDelete needs a thread"). Pinned against the entry's own comment at
    // src/tools/runtime/threadDelete.tool.ts:113-118.
    it('accepts the single-property UNWRAPPED id the harness actually delivers', async () => {
        const { threadDelete, context } = stubRuntime('thread-7', ['thread-7', 'thread-9']);

        // `parameters` is the BARE STRING, not `{ thread: 'thread-7' }`, and the caller
        // thread still travels first. The receipt is returned untouched.
        await expect(threadDeleteEntry.execute(context('  thread-7  ' as never, 'thread-3'))).resolves.toEqual({
            deleted: 'thread-7',
            removedThreadIds: ['thread-7', 'thread-9']
        });
        expect(threadDelete.mock.calls).toEqual([['thread-3', 'thread-7']]);

        // Both shapes are read, so the wrapper a hand-built context produces still works
        // in the same build — asserted as one call list to pin the order too.
        const both = stubRuntime('thread-8', ['thread-8']);

        await threadDeleteEntry.execute(both.context({ thread: 'thread-8' }, 'thread-4'));
        expect(both.threadDelete.mock.calls).toEqual([['thread-4', 'thread-8']]);

        // A bare non-string (the unwrap of a wrong-typed argument) is still the entry's own
        // refusal, and the runtime is not called.
        const wrong = stubRuntime('thread-1', ['thread-1']);

        expect(() => threadDeleteEntry.execute(wrong.context(42 as never, 'thread-3'))).toThrow(NEEDS_THREAD);
        expect(wrong.threadDelete.mock.calls).toEqual([]);
    });

    it('refuses a call with no live harness', () => {
        expect(() =>
            threadDeleteEntry.execute({ parameters: { thread: 'thread-1' } } as unknown as ToolContext)
        ).toThrow(NEEDS_HARNESS);
    });

    it('refuses every empty or non-string thread without touching the runtime', () => {
        const missing: unknown[] = [
            undefined,
            {},
            { thread: '' },
            { thread: '   ' },
            { thread: 42 },
            { thread: null }
        ];

        for (const parameters of missing) {
            const { threadDelete, context } = stubRuntime('thread-1', ['thread-1']);

            expect(() => threadDeleteEntry.execute(context(parameters as any, 'thread-3'))).toThrow(
                NEEDS_THREAD
            );
            // An invalid id is a refusal, not a delete of "whatever the runtime would
            // have defaulted to".
            expect(threadDelete.mock.calls).toEqual([]);
        }
    });
});
