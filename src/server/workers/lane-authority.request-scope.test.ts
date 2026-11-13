// T11 (RR4 loop): a routed `toolRequest` must carry the CALLING RUN's tool scope to the
// authority, so a scoped lane gets the same honest `forbidden` answer an inline scoped
// child gets (R4: worker-lane execution parity).
//
// Contract pinned here, against a REAL canonical harness (the same pattern as
// ./lane-authority.test.ts — these are claims about canonical session state, not mock
// plumbing):
//   - a routed request with `scope` excluding the match answers with `forbidden`
//     (name + reason + allowed list), enables NOTHING, and leaves the canonical
//     enabled set (`core.discoveredTools`) and the `sync.enabled` replay untouched —
//     so the denial can neither pollute the session nor be replayed into any replica;
//   - the denial is deterministic: two identical routed rounds answer identically;
//   - a routed request whose scope INCLUDES the match keeps the historical success
//     shape byte for byte (no `forbidden` key) and the grant DOES sync, exactly like
//     the inline path;
//   - a routed request with NO scope (every pre-T11 lane, every unscoped lane turn) is
//     unchanged: the old lying-free unrestricted answer, exact.
//
// 2026-11-13 (independent review, finding 2): the same PAYLOAD-then-CONSEQUENCE discipline,
// applied to the two CONVERSATION-level routed operations that carry a caller —
// `thread:read` and the routed `threadDelete`. Both are caller-scoped at the canonical
// harness (`isAddressVisible` / `threadDeleteFor` in ../../harness.ts), and the read used to
// travel with `identity: {}`, so the coordinator answered it UNSCOPED: a lane's `threadRead`
// of a foreign-lineage thread returned the whole transcript where the identical call INLINE
// answers "not visible to thread …". The new block below pins the request body a lane raises
// AND what the authority does with it, so the caller id cannot be dropped again in silence.
//
// Cross-references:
//   - ./lane-authority.ts:111            - the optional `scope` on the routed request
//   - ./lane-authority.ts ~710           - the coordinator forwarding it (selfCallId
//                                          deliberately NOT forwarded)
//   - ./lane-authority.ts ~800           - the `thread:read` answer, scoped by `identity.threadId`
//   - ./lane-authority.ts ~751           - the routed `threadDelete` (caller from `identity`)
//   - ./lane-worker-loop.ts ~360         - the replica routing `context.toolScope`
//   - ./lane-worker-loop.ts:361          - `threadReadRoutePayload`, pinned at payload level below
//   - ../../harness.ts ~5576 / ~6062     - `isAddressVisible` and
//                                          `threadMessages(threadId, callerThreadId?)`, the two
//                                          seams the routed read answers through
//   - ../../harness.ts `requestToolsFor` - the single scope-aware implementation
//   - ../harness.delegation.test.ts      - the inline halves of the same contract

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { Harness, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { createLaneAuthority } from './lane-authority';
import type { LaneAuthorityRequest } from './lane-authority';
// T14 gap (d): the lane's OWN request builder (the function `installAuthorityRuntime`
// registers for the `requestTools` route), pinned below at payload level.
import { requestToolsRoutePayload, threadReadRoutePayload } from './lane-worker-loop';

// A scripted stream that never talks to a provider: like ./lane-authority.test.ts, the
// assertions here are about state the authority owns, and a real model turn would only
// add latency.
const quiet = (): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: 'unused' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// The canonical harness: one searchable capability (`shell`) plus one core tool
// (`read`), mirroring the RR4 situation — a reviewer brain scoped WITHOUT the shell
// tool it wanted.
const coreOf = (): Harness =>
    harness({
        agents: {
            primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() })
        },
        tools: {
            read: tool({
                description: 'Read.',
                tags: ['files'],
                visibility: 'core',
                execute: () => 'contents'
            }),
            shell: tool({
                description: 'Run shell commands.',
                tags: ['shell', 'exec'],
                visibility: 'searchable',
                execute: () => ''
            })
        },
        presets: false
    });

const EPOCH_A = 1;

describe('routed toolRequest: the run scope reaches the canonical harness (T11 lane parity)', () => {
    let core: Harness;
    let authority: ReturnType<typeof createLaneAuthority>;

    beforeEach(() => {
        core = coreOf();
        authority = createLaneAuthority({ harness: core });
        authority.openLane(EPOCH_A);
    });

    const request = (scope?: readonly string[]): LaneAuthorityRequest => ({
        op: 'runtime',
        method: 'requestTools',
        parameters: { names: ['shell'] },
        ...(scope === undefined ? {} : { scope }),
        identity: { agent: 'primary', threadId: 'thread-1', runDepth: 2 }
    });

    it('answers an out-of-scope lane request with the allowed list and enables nothing', async () => {
        // The lane variant of required test 1: the request carried `scope: ["read"]`,
        // so `shell` is DENIED at the canonical harness — never enabled there, and
        // `sync.enabled` (what every replica replays) stays empty, so the denial
        // cannot leak into this or any sibling lane either.
        const first = await authority.answer(EPOCH_A, request(['read']));

        expect(first.value).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'shell',
                    reason:
                        "Tool \"shell\" is outside this run's scope. Allowed: read. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read']
                }
            ]
        });

        // No session-wide pollution at the single writer of the enabled set.
        expect(core.discoveredTools).toEqual([]);
        expect(first.sync?.enabled).toEqual([]);

        // Determinism across rounds (the loop-prevention regression, lane side): the
        // second identical request answers identically — no state changed underneath.
        const second = await authority.answer(EPOCH_A, request(['read']));

        expect(second.value).toEqual(first.value);
        expect(core.discoveredTools).toEqual([]);
    });

    it('enables an in-scope lane request exactly like the historical success shape', async () => {
        // The lane variant of required test 2: the scope NAMES the tool, so the answer
        // is the pre-T11 success object — no `forbidden` key (this `toEqual` is exact,
        // so a stray field fails it) — and the grant flows into the canonical enabled
        // set plus the sync replay, exactly as an inline enable does.
        const granted = await authority.answer(EPOCH_A, request(['read', 'shell']));

        expect(granted.value).toEqual({
            enabled: ['shell'],
            tools: [{ name: 'shell', description: 'Run shell commands.', tags: ['shell', 'exec'] }],
            matched: 1,
            omitted: 0
        });

        expect(core.discoveredTools).toEqual(['shell']);
        expect(granted.sync?.enabled).toEqual(['shell']);
    });

    it('keeps an unscoped routed request byte-for-byte historical (R3 wire compat)', async () => {
        // Every pre-T11 lane request (and every unscoped lane turn) carries NO scope
        // field. The answer must be exactly the historical shape — proving the new
        // union member and coordinator pass-through changed nothing when absent.
        const legacy = await authority.answer(EPOCH_A, request(undefined));

        expect(legacy.value).toEqual({
            enabled: ['shell'],
            tools: [{ name: 'shell', description: 'Run shell commands.', tags: ['shell', 'exec'] }],
            matched: 1,
            omitted: 0
        });

        expect(core.discoveredTools).toEqual(['shell']);
    });

    // ------------------------------------------------------------------------
    // T14 gap (d): the LANE SIDE of the same contract, pinned at PAYLOAD level.
    //
    // The tests above enter at `authority.answer(...)`, so the worker loop's own
    // request builder — ./lane-worker-loop.ts `requestToolsRoutePayload`, which
    // `installAuthorityRuntime` registers for the `requestTools` route — could drop
    // `scope` and this suite would stay green: the authority would simply answer the
    // historical UNRESTRICTED shape and a scoped lane would keep the old lie. These
    // two cases pin the body a lane raises, and feed it straight back into the
    // authority so the payload and its consequence are asserted together.
    // ------------------------------------------------------------------------

    // A caller shaped like the real `ToolContext` the replica hands the route: `agent` is a
    // live brain (the identity the authority resolves by NAME), plus the conversation and the
    // run depth the route forwards.
    const laneCaller = () => ({
        agent: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() }),
        threadId: 'thread-1',
        runDepth: 2
    });

    it('raises a scoped lane request whose body carries the scope and drops the call id', () => {
        // The exact wire body: `scope` forwarded (the R1 denial the lane must be able to
        // get), the `toolRequest` call's own id DROPPED (a lane id in that slot could mask a
        // real canonical pending task in the `toolCancel` report), and the identity derived
        // from the caller — asserted whole, so an extra or missing key fails.
        expect(requestToolsRoutePayload(laneCaller(), { names: ['shell'] }, 'call-7', ['read'])).toEqual({
            parameters: { names: ['shell'] },
            scope: ['read'],
            identity: { agent: 'primary', threadId: 'thread-1', runDepth: 2 }
        });

        // An UNRESTRICTED run (every pre-T11 lane, and every unscoped lane turn) keeps the
        // key absent rather than present-and-undefined: the request must be byte-for-byte the
        // historical body, which is what the compat test above answers.
        expect(
            requestToolsRoutePayload(laneCaller(), { names: ['shell'] }, 'call-7', undefined)
        ).toEqual({
            parameters: { names: ['shell'] },
            identity: { agent: 'primary', threadId: 'thread-1', runDepth: 2 }
        });
    });

    it('answers the payload a lane raises with the forbidden shape (payload to consequence)', async () => {
        // The end of the chain the payload exists for: raise EXACTLY what
        // `requestToolsRoutePayload` builds, and the canonical harness answers the scoped
        // lane with `forbidden` and enables nothing. Drop `scope` in the mapping and this
        // same object answers the unrestricted `enabled: ['shell']` shape instead.
        const raised = requestToolsRoutePayload(laneCaller(), { names: ['shell'] }, 'call-7', ['read']);
        const answer = await authority.answer(EPOCH_A, {
            op: 'runtime',
            method: 'requestTools',
            ...raised
        } as LaneAuthorityRequest);

        expect(answer.value).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'shell',
                    reason:
                        "Tool \"shell\" is outside this run's scope. Allowed: read. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read']
                }
            ]
        });
        expect(core.discoveredTools).toEqual([]);
        expect(answer.sync?.enabled).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 2026-11-13 independent review, finding 2: a routed CONVERSATION READ is a
// caller-scoped operation, and nothing in any suite could see the caller id being dropped.
//
// `installAuthorityRuntime` answers `handle.threadMessages` / `handle.thread` for a thread
// this lane did not create by raising `thread:read`, and the authority reads through the SAME
// two core seams the inline tool path uses — `src/harness.ts` `thread(id, callerThreadId?)`
// (the handle member, ~12667) and `threadMessages(threadId, callerThreadId?)` (~6062). Both
// switch on the caller: `isAddressVisible` (~5576) admits the caller's own conversation, its
// ancestors, its descendants and the default conversations its family spans, and refuses
// anything else that still exists. With `identity: {}` the gate stayed OFF at the coordinator,
// so a lane's `threadRead` of a foreign-lineage thread returned the whole canonical transcript
// where the identical call INLINE answers "not visible to thread …" — the two execution modes
// gave opposite answers to the same request, while src/tools/runtime/threadRead.tool.ts states
// the inline rule as the contract.
//
// The same discipline covers the routed `threadDelete`: `identity.threadId` is the CALLER and
// `threadId` the TARGET, and the authority scopes the release to that caller's own descendants
// (`src/harness.ts` `threadDeleteFor`, ~5824). Every case below is pinned at PAYLOAD level
// where a builder exists and at CONSEQUENCE level always, so a caller id that stops riding
// fails here rather than silently in production.
// ---------------------------------------------------------------------------

describe('routed conversation read and delete: the caller travels with the request (independent review 2026-11-13)', () => {
    let core: Harness;
    let authority: ReturnType<typeof createLaneAuthority>;

    beforeEach(() => {
        core = coreOf();
        authority = createLaneAuthority({ harness: core });
        authority.openLane(EPOCH_A);
    });

    it('sends the caller as identity.threadId, and an empty identity for a threadless caller', () => {
        // Payload level: `threadReadRoutePayload` is what the two handle reads raise, so this is
        // the one place a dropped caller id becomes a failing test — before the fix both call
        // sites passed `identity: {}` literally, and no suite could see the drop. The CALLER
        // travels inside `identity` and the TARGET as `threadId`, the same carrier `threadList`
        // (./lane-worker-loop.ts ~429) and `threadDelete` (~444) use, because the caller is a
        // runtime fact and never a model argument (src/harness.ts ~3337 states that rule).
        expect(threadReadRoutePayload('thread-9', 'thread-1')).toEqual({
            threadId: 'thread-9',
            identity: { threadId: 'thread-1' }
        });

        // A threadless caller keeps the historical byte shape: an EMPTY identity object, which
        // the authority reads as the unscoped host view. Present-but-undefined would be a
        // different wire object, hence `toEqual` on the whole payload rather than a field check.
        expect(threadReadRoutePayload('thread-9')).toEqual({ threadId: 'thread-9', identity: {} });
    });

    it('answers a routed read of a conversation in the caller lineage with the canonical record and transcript', async () => {
        const caller = core.createThread('primary', { label: 'lane conversation' });
        const child = core.createThread('primary', { label: 'my descendant', ownerThreadId: caller.id });

        core.appendThreadMessages(child.id, [{ role: 'user', content: 'ours' }], 0);

        const ours = await authority.answer(EPOCH_A, {
            op: 'thread:read',
            ...threadReadRoutePayload(child.id, caller.id)
        } as LaneAuthorityRequest);

        // The WHOLE answer, stated exactly. The lane's own tool body builds its page from this
        // object — `readThreadTranscript(record, messages, parameters)` in
        // src/tools/runtime/threadRead.tool.ts still runs inside the lane — so every field the
        // page reads has to be here: record, transcript, length. `messageId` is part of the
        // canonical entry: `appendThreadMessages` mints an address for an unaddressed message
        // (src/harness.ts ~6181), and the routed read ships canonical entries, not a stripped
        // projection — which is exactly why the lane can page over it unchanged.
        expect((ours.value as { messages: unknown[] }).messages).toEqual([
            { role: 'user', content: 'ours', messageId: 'msg-1' }
        ]);
        expect(ours.value).toMatchObject({
            threadId: child.id,
            length: 1,
            record: { id: child.id, agent: 'primary', label: 'my descendant', ownerThreadId: caller.id }
        });
    });

    it('refuses a routed read of a conversation outside the caller lineage with the INLINE refusal sentence', async () => {
        const caller = core.createThread('primary', { label: 'lane conversation' });
        const stranger = core.createThread('primary', { label: 'someone else' });

        core.appendThreadMessages(stranger.id, [{ role: 'user', content: 'not yours' }], 0);

        // The exact message `threadNotVisibleError` (src/harness.ts ~5606) produces, so a lane
        // tells the model what an inline run tells it — a roster problem, not a typo — instead of
        // handing back the transcript the gate exists to withhold. Asserted as the full sentence:
        // the previous behaviour was a SILENT success, so only an exact pin on the refusal text
        // distinguishes the two.
        await expect(
            authority.answer(EPOCH_A, {
                op: 'thread:read',
                ...threadReadRoutePayload(stranger.id, caller.id)
            } as LaneAuthorityRequest)
        ).rejects.toThrow(
            `Thread "${stranger.id}" is not visible to thread "${caller.id}": a read reaches your own thread, an ` +
                'ancestor, one of your descendants, or a default conversation (agent:<name>) your roster lists (see ' +
                'threadList). The id exists — it is simply outside your lineage.'
        );

        // The caller's own conversation stays reachable — the gate withholds the stranger, not
        // the lane's own state.
        core.appendThreadMessages(caller.id, [{ role: 'user', content: 'mine' }], 0);

        expect(
            (await authority.answer(EPOCH_A, {
                op: 'thread:read',
                ...threadReadRoutePayload(caller.id, caller.id)
            } as LaneAuthorityRequest)).value
        ).toMatchObject({ threadId: caller.id, length: 1 });
    });

    it('answers a threadless routed read with the unscoped host view (compat)', async () => {
        const stranger = core.createThread('primary', { label: 'someone else' });

        core.appendThreadMessages(stranger.id, [{ role: 'user', content: 'not yours' }], 0);

        // The pre-fix wire shape (`identity: {}`) is what a caller WITH NO conversation sends, and
        // it must keep working: no caller id means no gate, so the coordinator answers the whole
        // thread. ./lane-authority.test.ts's S1 case sends the same shape; pinning it here as well
        // keeps that arm a contract instead of an accident.
        expect(
            (await authority.answer(EPOCH_A, { op: 'thread:read', threadId: stranger.id, identity: {} })).value
        ).toMatchObject({
            threadId: stranger.id,
            record: { id: stranger.id, label: 'someone else' },
            messages: [{ role: 'user', content: 'not yours', messageId: 'msg-1' }],
            length: 1
        });
    });

    it('releases a lane-owned conversation through the canonical harness and reports every id it took', async () => {
        const caller = core.createThread('primary', { label: 'lane conversation' });
        const child = core.createThread('primary', { label: 'my descendant', ownerThreadId: caller.id });
        const grandchild = core.createThread('primary', { label: 'two levels down', ownerThreadId: child.id });

        // The body `route('threadDelete', …)` raises (./lane-worker-loop.ts ~444): the TARGET in
        // `threadId`, the CALLER in `identity`. A delete is a WRITE the coordinator owns (id
        // reuse, the roster, persistence), so the lane never applies it to a replica copy.
        const released = await authority.answer(EPOCH_A, {
            op: 'runtime',
            method: 'threadDelete',
            threadId: child.id,
            identity: { agent: 'primary', threadId: caller.id }
        });

        // The receipt is the harness's own `HarnessThreadDeleteResult`, stated whole: `deleted`
        // is the id the caller named, `removedThreadIds` everything that actually went, the
        // cascade included (the named owner first, then descendants in creation order), and the
        // two purge sets (2026-11-14) name the invocation and branch lookups that left with them
        // — empty here, because neither conversation ever ran a turn. It must arrive as an
        // OBJECT with `deleted` in it, because src/tools/runtime/threadDelete.tool.ts unwraps on
        // `('deleted' in result)` and would otherwise coerce a primitive into
        // `{ deleted: <primitive> }` — the bug the live tool test pins from the other side.
        expect(released.value).toEqual({
            deleted: child.id,
            removedThreadIds: [child.id, grandchild.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });

        // Canonical state agrees: both conversations are gone and the caller survives.
        expect(core.threads().map((thread) => thread.id)).toEqual([`agent:primary`, caller.id]);
        expect(core.thread(child.id)).toBeUndefined();
        expect(core.thread(grandchild.id)).toBeUndefined();
    });

    it('refuses a routed threadDelete of a conversation the lane caller never created', async () => {
        const caller = core.createThread('primary', { label: 'lane conversation' });
        const stranger = core.createThread('primary', { label: 'someone else' });

        // The gate the host-side tool enforces is the gate routing must not launder away: with
        // `identity.threadId` as the caller, a lane cannot release a sibling subtree. Exact
        // sentence from `threadDeleteFor` (src/harness.ts ~5850).
        await expect(
            authority.answer(EPOCH_A, {
                op: 'runtime',
                method: 'threadDelete',
                threadId: stranger.id,
                identity: { agent: 'primary', threadId: caller.id }
            })
        ).rejects.toThrow(
            `Thread "${stranger.id}" is not one of the conversations "${caller.id}" created; ` +
                'threadDelete releases your own descendants (see threadList) — never your current thread, ' +
                "an ancestor, a sibling, or another agent's conversation."
        );

        // Nothing moved: a refusal is not a partial delete.
        expect(core.threads().map((thread) => thread.id)).toContain(stranger.id);
    });

    it('keeps a threadless routed threadDelete on the host view (compat)', async () => {
        const stranger = core.createThread('primary', { label: 'someone else' });

        // A caller with NO conversation is the host view — `threadDeleteFor` short-circuits to
        // `deleteThread` when `callerThreadId` is undefined — so it still reaches any terminal
        // conversation: the pre-B5 behaviour, unchanged on purpose.
        expect(
            (await authority.answer(EPOCH_A, {
                op: 'runtime',
                method: 'threadDelete',
                threadId: stranger.id,
                identity: {}
            })).value
        ).toMatchObject({ deleted: stranger.id, removedThreadIds: [stranger.id] });
    });

    // THE WIRING THE PAYLOAD PIN CANNOT SEE. `threadReadRoutePayload` is proven above, but the
    // two replica handle members that CALL it live inside `installAuthorityRuntime`, whose
    // `raise` is bound to the lane transport — so no unit test can call them without a live
    // worker. This source pin closes exactly that gap: it fails the moment a call site stops
    // forwarding its own `callerThreadId` argument (the R2-F14 defect), which is the only way
    // the builder's correctness can still be lost in production.
    it('forwards the caller argument at BOTH routed handle reads, and raises no caller-less read', () => {
        const loopSource = readFileSync(new URL('./lane-worker-loop.ts', import.meta.url), 'utf8');

        // Both members, exactly twice, and never with the historical empty identity.
        expect(loopSource.match(/threadReadRoutePayload\(threadId, callerThreadId\)/g)).toHaveLength(2);
        expect(loopSource).not.toContain("{ op: 'thread:read', threadId, identity: {} }");

        // The lane's own conversation stays LOCAL (no request at all): that read is the one
        // place the replica is the authority, because its uncommitted tail exists nowhere else.
        expect(loopSource).toContain('threadId === state.targetId ? localMessages(threadId)');
        expect(loopSource).toContain('threadId === state.targetId ? localRecord(threadId)');
    });
});
