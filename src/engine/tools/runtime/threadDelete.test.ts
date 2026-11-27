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
//   - the description's behavioural promises: the issue-0027 reason, release-is-a-MARK
//     (what survives, what stops being listed, and the idempotent re-delete), the
//     descendant scope, the six refusals, the cascade, and both receipt fields;
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
// IT19 R2: the last sentence changed with the soft-delete rule — a released id is not
// part of the failure list any more, because re-deleting one restates its receipt.
// F1 (2026-11-27): the sentence about a branch run was APPENDED, not rewritten — inside a
// `threadFork` branch the door refuses every release, because the threads it could name belong
// to the conversation that forked the branch (./harness.ts `branchFamilyWriteRefusal`).
const THREAD_PARAMETER = {
    type: 'string',
    minLength: 1,
    description:
        'Id of the finished thread to release, as reported by threadList - one of YOUR descendants. A running thread, a finished target with a running descendant, this agent\'s default conversation (agent:<name>), a thread outside your lineage, a fork\'s branch-N id, and an unknown id all fail; re-deleting a descendant you have already released instead restates its receipt, because a released thread is inactive rather than destroyed. There is no default: your own current thread is never the target. A threadFork branch may not release anything at all from inside its run - a branch\'s threads are the threads of the conversation that forked it - unless that threadFork call passed allowFamilyWrites: true.'
};

// The two errors the entry can raise itself. The runtime owns every other refusal
// (running thread, default conversation, foreign lineage, unknown id).
const NEEDS_HARNESS = 'threadDelete requires the live harness reference.';
const NEEDS_THREAD = 'threadDelete needs a thread: pass "thread" (see threadList).';

// A runtime stub that records exactly what the entry forwarded and hands back a receipt
// (`{ deleted, removedThreadIds }`, cascade included). The four-field shape a current runtime
// returns — `removedInvocationIds` and `removedBranchIds` too — is pinned whole by its own case
// below, so this stub stays the minimal one the argument-wiring assertions need.
// F1 (2026-11-27): the context builder takes the CALLING BRAIN as its third argument, because that
// is the slot `../harness.ts` `threadDeleteFor` reads to recognise a `threadFork` branch run. An
// omitted agent is the host/legacy shape, and it is pinned as `undefined` rather than guessed.
const CALLER_BRAIN = { name: 'writer' };

const stubRuntime = (deleted: string, removedThreadIds: readonly string[]) => {
    const threadDelete = vi.fn(
        async (
            _callerThreadId: string | undefined,
            _threadId: string,
            _caller?: unknown
        ): Promise<unknown> => ({
            deleted,
            removedThreadIds: [...removedThreadIds]
        })
    );

    return {
        threadDelete,
        context: (
            parameters?: Record<string, unknown>,
            threadId?: string,
            agent?: unknown
        ): ToolContext =>
            ({
                harness: { runtime: { threadDelete } },
                ...(threadId === undefined ? {} : { threadId }),
                ...(agent === undefined ? {} : { agent }),
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
        // The claim is scoped to a delegation FROM A CONVERSATION: a delegation from the
        // host re-enters the target agent's DEFAULT conversation (`agent:<name>`,
        // `defaultThreadOf(brain)` at src/harness.ts:14596), which this tool refuses to
        // release, so "every delegation mints its own thread" was promising a slot that
        // never got minted. Rank wording (2026-11-18): the description says "that agent's",
        // not "that subagent's" — the rank model has no subagent role.
        expect(description).toContain('A delegation FROM A CONVERSATION mints its own thread');
        expect(description).toContain(
            "reuses that agent's default conversation (agent:<name>)"
        );
        expect(description).toContain('issue 0027');
        // Read first: releasing closes the doors, so the answer has to be in hand already.
        expect(description).toContain('read what you still need with threadRead or agentResult first');
        // WHAT DELETION DOES NOW (IT19 R2). The shipped promise was "Deletion is PERMANENT
        // — the transcript, its invocation record and its branch lookups all go with it",
        // and R2 changed the runtime behind that sentence: `purgeThread` marks the record
        // `inactive`, and the transcript plus the invocation rows SURVIVE. So the
        // description says MARK, names what survives, and states the one real destruction.
        expect(description).toContain('Releasing is a MARK, not an erasure');
        expect(description).toContain('while its transcript and its result records are RETAINED');
        // Re-deleting a released descendant restates the receipt instead of throwing, and
        // only the session itself destroys a conversation — the two claims that replace the
        // old "a deleted id becomes unknown everywhere" sentence.
        expect(description).toContain(
            're-deleting a descendant you have already released is not an error - it restates the same receipt and changes nothing'
        );
        expect(description).toContain(
            'the only thing that destroys one is deleting the session itself'
        );
        // THE BOUND, stated inside the SAME sentence (honesty pass, 2026-11-15). "Nothing an agent
        // does destroys a conversation" is only true of the agent-facing doors: the session document
        // holds `MAX_THREAD_RECORDS` (256, src/core/thread.ts:46) rows, and past that bound
        // `capThreadRecords` (src/server/sessions.ts:4787) retires the OLDEST inactive rows with
        // their transcripts. The caveat is APPENDED to the pinned sentence rather than rewritten
        // over it, so the two pins above stay byte-exact.
        expect(description).toContain('which keeps a bounded roster of 256 thread records');
        expect(description).toContain(
            'past that bound the OLDEST released rows are retired with their transcripts'
        );
        // Scope and refusals — ALL SIX, in the order the runtime reaches them
        // (`threadDeleteFor` lineage gate, then `deleteThread`: default conversation,
        // live target, live descendant, unknown id). The running-descendant refusal is the
        // one a description used to omit, and it is the one that saves a caller from
        // believing a delete was half-applied: `deleteThread`'s descendant pass in
        // `src/harness.ts` throws with the CHILD's id and removes nothing.
        //
        // THE SIXTH (T4 / stress report #5, 2026-11-14): a fork `branch-N` id. It resolves
        // on the READ seams, so the delete door resolves the branch ledger first
        // (`branchRecordOf`, ahead of `threadStateOf`) and refuses with its own sentence
        // (`branchDeleteRefusal`) instead of the false "never created, or it was deleted".
        expect(description).toContain('one of YOUR DESCENDANTS that is no longer running');
        expect(description).toContain('Six things are refused');
        expect(description).toContain('a thread that is RUNNING (stop it first)');
        expect(description).toContain('a finished target that still has a RUNNING descendant');
        expect(description).toContain('nothing is half-deleted');
        expect(description).toContain("this agent's default conversation (agent:<name>)");
        expect(description).toContain('a thread outside your lineage');
        expect(description).toContain('a fork\'s `branch-N` id');
        expect(description).toContain('it holds no thread slot, so there is nothing to release');
        expect(description).toContain('it goes when the conversation that forked it is deleted');
        // The cascade, and all FOUR receipt fields. `removedInvocationIds` and
        // `removedBranchIds` are required on `HarnessThreadDeleteResult` (src/types/index.ts
        // ~1213-1215): the purge computes them, and an empty array has to be distinguishable
        // from a build that says nothing (stress report #6).
        expect(description).toContain('Deleting cascades');
        expect(description).toContain(
            'The receipt reports `deleted` (the id you named), `removedThreadIds`'
        );
        expect(description).toContain('the cascaded ones included');
        expect(description).toContain('`removedInvocationIds`');
        expect(description).toContain('`removedBranchIds`');
        // Deleting a conversation stops LISTING its RESULT records. Under the old permanent
        // purge this was the silent symptom (`agentResult` could no longer read the id);
        // after IT19 R2 the rows are retained, so the honest claim is that an id you already
        // hold still answers and `removedInvocationIds` means "no longer listed".
        expect(description).toContain(
            '`agentResult` still answers an `invocationId` you already hold by that id'
        );
        // F-A Defect 3 (2026-11-15): the receipt prose now states ONE rule per field instead of
        // one rule for three fields. `removedThreadIds`/`removedInvocationIds` describe RETAINED
        // state that is hidden, so a re-delete restates them (that is what "it restates the same
        // receipt" promised); `removedBranchIds` alone means "newly unlisted by this call",
        // because a branch row lives in the bounded ledger and really does go. Pinned so the
        // sentence cannot drift back over the code in `src/harness.ts`'s idempotent branch.
        expect(description).toContain(
            'Those two id sets mean HID BEHIND the conversation you named, not destroyed'
        );
        expect(description).toContain(
            '`removedBranchIds` is the one set that means NEWLY UNLISTED BY THIS CALL'
        );
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
            threadDeleteEntry.execute(context({ thread: '  thread-7  ' }, 'thread-3', CALLER_BRAIN))
        ).resolves.toEqual({ deleted: 'thread-7', removedThreadIds: ['thread-7', 'thread-9'] });

        // Argument ORDER and content are the contract: caller first, target second,
        // and the runtime receives the trimmed id, not the padded one.
        // F1 (2026-11-27) — the calling BRAIN rides third, by reference: `threadDeleteFor`
        // recognises a `threadFork` branch run from its branch metadata, which no thread id can
        // carry (a branch's persistent thread IS its requester's conversation).
        expect(threadDelete.mock.calls).toEqual([['thread-3', 'thread-7', CALLER_BRAIN]]);
    });

    it('passes an undefined caller thread through for a threadless host view', async () => {
        const { threadDelete, context } = stubRuntime('thread-1', ['thread-1']);

        await expect(threadDeleteEntry.execute(context({ thread: 'thread-1' }))).resolves.toEqual({
            deleted: 'thread-1',
            removedThreadIds: ['thread-1']
        });
        // The runtime reads `undefined` as "no calling conversation" and leaves that
        // caller unscoped; the entry never substitutes a guess.
        expect(threadDelete.mock.calls).toEqual([[undefined, 'thread-1', undefined]]);
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
        // The third slot stays `undefined` here: this context carries no `agent`, which is the
        // host/`executeTool` shape, and the runtime reads it as "no calling brain" (F1, 2026-11-27).
        expect(threadDelete.mock.calls).toEqual([['thread-3', 'thread-7', undefined]]);

        // Both shapes are read, so the wrapper a hand-built context produces still works
        // in the same build — asserted as one call list to pin the order too.
        const both = stubRuntime('thread-8', ['thread-8']);

        await threadDeleteEntry.execute(both.context({ thread: 'thread-8' }, 'thread-4'));
        expect(both.threadDelete.mock.calls).toEqual([['thread-4', 'thread-8', undefined]]);

        // A bare non-string (the unwrap of a wrong-typed argument) is still the entry's own
        // refusal, and the runtime is not called.
        const wrong = stubRuntime('thread-1', ['thread-1']);

        expect(() => threadDeleteEntry.execute(wrong.context(42 as never, 'thread-3'))).toThrow(NEEDS_THREAD);
        expect(wrong.threadDelete.mock.calls).toEqual([]);
    });

    // STRESS REPORT #6 (2026-11-14) — THE TWO PURGE SETS TRAVEL THE SAME WAY.
    //
    // `removedInvocationIds` and `removedBranchIds` are part of the runtime's receipt, and this
    // entry must hand the object over WITHOUT reshaping it: the point of the fields is that a
    // reaping caller can see which `agentResult` lookups left with the conversation, and an
    // entry that rebuilt the object field by field would drop them exactly where a model reads
    // the answer. Pinned with the whole four-field object, cascade and purge both non-empty.
    it('returns a receipt that names the purged invocations and branches, field for field', async () => {
        const threadDelete = vi.fn(
            async (): Promise<unknown> => ({
                deleted: 'thread-7',
                removedThreadIds: ['thread-7', 'thread-9'],
                removedInvocationIds: ['12', 'branch-3'],
                removedBranchIds: ['branch-3']
            })
        );
        const context = {
            harness: { runtime: { threadDelete } },
            threadId: 'thread-3',
            parameters: { thread: 'thread-7' }
        } as unknown as ToolContext;

        await expect(threadDeleteEntry.execute(context)).resolves.toEqual({
            deleted: 'thread-7',
            removedThreadIds: ['thread-7', 'thread-9'],
            removedInvocationIds: ['12', 'branch-3'],
            removedBranchIds: ['branch-3']
        });
        expect(threadDelete.mock.calls).toEqual([['thread-3', 'thread-7', undefined]]);
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
