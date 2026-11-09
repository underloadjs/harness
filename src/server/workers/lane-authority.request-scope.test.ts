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
// Cross-references:
//   - ./lane-authority.ts:111            - the optional `scope` on the routed request
//   - ./lane-authority.ts ~710           - the coordinator forwarding it (selfCallId
//                                          deliberately NOT forwarded)
//   - ./lane-worker-loop.ts ~360         - the replica routing `context.toolScope`
//   - ../../harness.ts `requestToolsFor` - the single scope-aware implementation
//   - ../harness.delegation.test.ts      - the inline halves of the same contract

import { beforeEach, describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { Harness, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { createLaneAuthority } from './lane-authority';
import type { LaneAuthorityRequest } from './lane-authority';
// T14 gap (d): the lane's OWN request builder (the function `installAuthorityRuntime`
// registers for the `requestTools` route), pinned below at payload level.
import { requestToolsRoutePayload } from './lane-worker-loop';

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
