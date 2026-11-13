// R5b — THE SESSION TOOL SWITCH, REACHING A LIVE LANE IN REAL TIME.
//
// WHAT THIS FILE PINS
// -------------------
// The requirement is two sentences: a tool toggle "can be in real time (when the agent's thread
// is still running)", and the panel's toggle "is global session level, affecting all threads".
// On an INLINE session the kernel already does both — `declared()` rebuilds the declaration list
// per model request (src/harness.ts:4701) and the launch gate is read per launch
// (src/harness.ts:8017 / :8040), both from live state. A WORKER lane owns a REPLICA with its own
// copy of that state, and until the `sync.tools` frame existed the copy could only ever GAIN
// names: `applySync` replays the authority's `sync.enabled` as a union, no operation withdrew
// one, and the switch set crossed only at `hello`. So a warm lane kept declaring — and launching
// — a tool its user had already switched off, for as long as that lane lived.
//
// Three layers, in the order that makes a failure localisable:
//
//   1. THE APPLIER  — `applyToolStateSync` against a REAL harness, no thread: the reconcile is
//      wholesale (both lists, set not merged), tolerant (a name this replica cannot register is
//      DROPPED, never a throw), and CONVERGENT (the same frame twice lands the same state).
//   2. THE CANONICAL READ — `authority.toolStateNow()`: the payload is the coordinator's own
//      live state, including a core name that no `enabled` list can carry, and it is a copy.
//   3. THE WIRE     — real `node:worker_threads` lanes, real turns, and the tool list the stub
//      provider was actually SENT. The headline claim ("a disable of a core name reaches a warm,
//      idle lane and its next request omits it") is asserted on the bytes the replica offered the
//      model, with the lane's EPOCH held constant across the turns so nobody can read the result
//      as "a rebuilt lane picked it up from the blueprint".
//
// WHAT THIS FILE DOES NOT CLAIM
// -----------------------------
// That the kernel honours a withheld name inline (src/harness.tool-settings.test.ts and the
// session-switch suite pin that), or that the blueprint carries the values at lane CREATION
// (./lane-tool-settings.test.ts pins that chain).
//
// LEVEL 4 (T10) CLOSES THE CLAIM THIS FILE USED TO MAKE ABSENCE OF. The cases below fire the
// toggle through the OPERATOR's route (`PATCH /v1/harness/sessions/:id/tools/:tool_id
// {enabled}` -> ../api.ts `setSessionToolEnabled` -> ../sessions.ts `pushToolState`) and through
// the MODEL's door (a routed `runtime.manageTool` request -> ./lane-authority.ts
// `notifyToolStateChange` -> the `onToolStateChange` wiring in ../sessions.ts `authorityOf`), and
// assert the consequence on a warm lane. Neither case hand-posts a frame; where a hand-posted
// frame is still used (the `pushToolState` helper above) it is only to isolate ordering.
//
// THE OPERATOR DOOR IS FOUR CALL SITES, not one (../api.ts): the gate-only PATCH (:4150), the
// combined PATCH (:4446), a registration — POST create and PATCH-with-content alike (:4308), and
// the un-registration DELETE (:4535). Each of them moves canonical state, and the three beyond the
// gate are measured, not assumed: Temp/t10/probe-create2.ts read the live store's two lists across
// a create (23 to 24 names, the new one at the head), a re-registration (an order-only move) and a
// removal (25 to 24, the name gone, `withheld` untouched). Which write fires WHICH frame is pinned
// by ../api-session-tool-writes.test.ts `R5b (T10)`; the warm-lane effect of a move on either axis
// is pinned here, because the sibling-lane case drives the `enabled` axis and the operator case
// drives the `withheld` one.
//
// Cross-references:
//   - ./protocol.ts            `sync.tools`, `LaneToolStateSync`, `LaneBlueprint.withheldTools`
//   - ./lane-authority.ts      `toolStateNow()` (the canonical read), `notifyToolStateChange`
//                              (the model door), `onToolStateChange` (its seam)
//   - ./lane-host.ts           `broadcastTools()` (the session-wide push)
//   - ./lane-worker-loop.ts    `applyToolStateSync` (the applier), `applySync` (the flag heal),
//                              `sayHello` (the same applier for the blueprint + a deferred frame)
//   - ../sessions.ts           `pushToolState` (the operator door), `authorityOf` (the model door)
//   - ../api.ts                PATCH /sessions/:id/tools/:tool_id — the write that fires the push
//   - ../../harness.ts         :4701 declarations, :8017/:8040 launch gates, :1957 the switch
//                              kernel, :13149/:13165 the two reads this frame carries
//   - ../api.ts                PATCH /sessions/:id/tools/:tool_id — the write that must trigger
//                              the push

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { Harness, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { createHarnessRegistry } from '../harnesses';
import { PRODUCTION_WITH_FIXTURES } from '../harnesses/fixture-presets.test-support';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import { createHarnessApi } from '../api';
import type { HarnessApiRequest, HarnessApiResult } from '../api';
import { SessionStore } from '../sessions';
import type { RunnerSettings } from '../harnesses/types';
import type { SessionTurn } from '../protocol';
import { createLaneAuthority } from './lane-authority';
import type { LaneAuthority, LaneAuthorityRequest } from './lane-authority';
import type { LaneHost } from './lane-host';
import { applyToolStateSync } from './lane-worker-loop';
import type { LaneToolStateReconcile } from './lane-worker-loop';
import type { LaneToolStateSync } from './protocol';

// ---------------------------------------------------------------------------
// Level 1 + 2: the applier and the canonical read, on a real harness, no thread.
// ---------------------------------------------------------------------------

// A stream that never reaches a provider: these cases are about the two discovery sets, and a
// run would only add latency. Same shape as ./lane-authority.test.ts `coreOf`.
const quiet = (): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: 'unused' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// THREE tools, because the reconcile has three distinguishable cases and a two-tool fixture
// cannot tell them apart:
//   - `probeCore`   — `visibility: 'core'`: ALWAYS declared, NEVER a cap slot, so it can never
//     appear in `discoveredTools`. The exact shape of the gap R5b closes: an `enabled` list on
//     its own cannot say "this name is off", and this is the name the headline wire test uses.
//   - `probeSearch` / `probeOther` — searchable: they hold cap slots, so they are the names the
//     `enabled` axis (and therefore the WITHDRAWAL step, the direction the protocol never had)
//     is about.
const coreOf = (): Harness =>
    harness({
        agents: { primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() }) },
        presets: false,
        tools: {
            probeCore: tool({ name: 'probeCore', description: 'A core declaration.', visibility: 'core', tags: ['probe'], execute: () => 'core' }),
            probeSearch: tool({ name: 'probeSearch', description: 'A searchable tool.', tags: ['probe'], execute: () => 'search' }),
            probeOther: tool({ name: 'probeOther', description: 'Another searchable tool.', tags: ['probe'], execute: () => 'other' })
        }
    } as never) as Harness;

// THE CAP-BOUND TWIN of `coreOf`, for the cases its default cap cannot reach: THREE searchable
// names and `maxEnabledTools: 2`, so every frame below lands with the cap BINDING. `enabled` is the
// CAPPED set (`discoveredTools`, src/harness.ts:13149), so a replica can be told more names than it
// has slots, and step 3's own newest-first `requestTools` insertion then evicts one of them in
// silence — the difference between what a frame asks for and what this replica ends up holding,
// which the applier's return value does NOT report (see the two cases that use this fixture).
const cappedOf = (): Harness =>
    harness({
        agents: { primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() }) },
        presets: false,
        maxEnabledTools: 2,
        tools: {
            probeCore: tool({ name: 'probeCore', description: 'A core declaration.', visibility: 'core', tags: ['probe'], execute: () => 'core' }),
            probeSearch: tool({ name: 'probeSearch', description: 'A searchable tool.', tags: ['probe'], execute: () => 'search' }),
            probeOther: tool({ name: 'probeOther', description: 'Another searchable tool.', tags: ['probe'], execute: () => 'other' }),
            probeThird: tool({ name: 'probeThird', description: 'A third searchable tool.', tags: ['probe'], execute: () => 'third' })
        }
    } as never) as Harness;

// The applier's `runtime` argument: the replica's OWN kernel seams. On a real lane these are the
// `localRuntime` pair captured in `installAuthorityRuntime` BEFORE the routed replacements, and
// passing the routed ones here would be the bug this parameter exists to make visible — the
// replica would ask the authority to change the canonical harness instead of mirroring it.
const seamsOf = (core: Harness) => ({
    requestTools: core.runtime.requestTools,
    manageTool: core.runtime.manageTool
});

// The replica's two discovery sets, in one exact value. `withheld` is sorted by the kernel's own
// getter (src/harness.ts:13165) and `enabled` is newest-selection-first
// (src/harness.ts:13149), so BOTH orders are determined by the kernel and can be asserted whole.
const setsOf = (core: Harness): { enabled: string[]; withheld: readonly string[] } => ({
    enabled: core.discoveredTools,
    withheld: core.withheldTools
});

describe('R5b reconcile: applyToolStateSync sets both discovery sets on a real harness', () => {
    it('installs a core-name switch that the enabled list cannot carry', () => {
        const core = coreOf();

        // Start from the shape a lane replica actually has: `probeSearch` enabled (a cap slot),
        // `probeCore` declared-but-uncapped, nothing switched off.
        core.runtime.requestTools(undefined, { names: ['probeSearch'] });

        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: [] });

        const reconcile = applyToolStateSync({ enabled: ['probeSearch'], withheld: ['probeCore'] }, { replica: core, runtime: seamsOf(core) });

        // The applier's own report is exact, and it is the report the wire tests below cannot
        // produce on a foreign thread - so this is where "what did the frame do" is pinned.
        expect(reconcile).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore'], dropped: [] });
        // THE POINT: `probeCore` is switched off while its cap entry never existed. The kernel
        // records the switch in the withheld set alone (src/harness.ts:1957), which is the only
        // place a core or pending-only name's decision lives (src/harness.ts:13154).
        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore'] });
        // And it stayed REGISTERED: a switch is not an unregister, so the name is one frame away
        // from coming back, and the operator's manual execution door still reaches it.
        expect(Object.keys(core.tools)).toContain('probeCore');
    });

    it('returns a name on re-enable, and re-takes the cap slot of a searchable one', () => {
        const core = coreOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch'] });
        applyToolStateSync({ enabled: ['probeSearch'], withheld: ['probeCore', 'probeSearch'] }, { replica: core, runtime: seamsOf(core) });

        expect(setsOf(core)).toEqual({ enabled: [], withheld: ['probeCore', 'probeSearch'] });

        // The reconcile that says "the user switched it back on": `withheld` is the WHOLE set, so
        // a name missing from it is un-flagged, and a searchable one re-takes a slot through the
        // kernel's own newest-first insertion (src/harness.ts:1974) - the same insertion a
        // `toolRequest` match uses, which is why the cap arithmetic does not change.
        const reconcile = applyToolStateSync({ enabled: ['probeSearch'], withheld: [] }, { replica: core, runtime: seamsOf(core) });

        expect(reconcile).toEqual({ enabled: ['probeSearch'], withheld: [], dropped: [] });
        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: [] });
    });

    it('withdraws a capped name canonical no longer holds — the direction the protocol never had', () => {
        const core = coreOf();

        // Both searchables enabled: the state a replica reaches today through the ADDITIVE
        // replay alone (`applySync` unions `sync.enabled`, and nothing has ever subtracted).
        core.runtime.requestTools(undefined, { names: ['probeSearch'] });
        core.runtime.requestTools(undefined, { names: ['probeOther'] });

        expect(setsOf(core)).toEqual({ enabled: ['probeOther', 'probeSearch'], withheld: [] });

        // Canonical now holds ONE capped name - it evicted, or the user disabled and the frame
        // carries it as uncapped. The replica must end up with exactly that list.
        applyToolStateSync({ enabled: ['probeSearch'], withheld: [] }, { replica: core, runtime: seamsOf(core) });

        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: ['probeOther'] });
        // THE RESIDUE, pinned rather than wished away: freeing a cap slot is only reachable
        // through `disable`, which also sets the switch flag, so `probeOther` ends flagged. It is
        // the redundant-but-safe direction - flagged AND uncapped is undeclared and refused at the
        // launch gate, which is what canonical does with it - and it cannot make the lane more
        // permissive than canonical, only never more. The next case pins that it converges.
    });

    it('converges: the same frame twice, and a re-run after a withdraw, land identical state', () => {
        const core = coreOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch'] });
        core.runtime.requestTools(undefined, { names: ['probeOther'] });

        const frame = { enabled: ['probeSearch'], withheld: ['probeCore'] };

        // A frame is one-way: the host may post it twice (two clicks, or a broadcast that raced a
        // second lane joining), and "harmless" has to mean IDEMPOTENT, not merely non-fatal.
        const first = applyToolStateSync(frame, { replica: core, runtime: seamsOf(core) });
        const afterFirst = setsOf(core);
        const second = applyToolStateSync(frame, { replica: core, runtime: seamsOf(core) });

        expect(second).toEqual(first);
        expect(first).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore'], dropped: [] });
        // The withdrawn `probeOther` sits in the flag set - the documented residue, and the
        // reason this case exists: a residue that MOVED between two identical frames would be an
        // oscillation, and an oscillation would make "the last frame wins" meaningless.
        expect(afterFirst).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore', 'probeOther'] });
        expect(setsOf(core)).toEqual(afterFirst);

        // A canonical write between two frames must not drift the landing state either: this is
        // the ONE order in which a stale replica could disagree with the coordinator, and the
        // reconcile still ends at the frame's state.
        core.runtime.manageTool(undefined, { operation: 'enable', name: 'probeOther' });

        applyToolStateSync(frame, { replica: core, runtime: seamsOf(core) });

        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore', 'probeOther'] });
    });

    // -------------------------------------------------------------------------
    // THE CAP-BOUND CASES (T-FIX1). Everything above runs on `coreOf()`, whose default cap of 32
    // never binds, so "the frame's ask" and "what this replica holds" coincide and the applier's
    // return can be read as the replica's state. On `cappedOf()` (three searchable names, cap 2)
    // they do NOT coincide, and the user-visible consequence is what these two cases pin: a warm
    // lane can be MISSING a name canonical still lists as discoverable. The applier's own report is
    // the frame's pruned ask, so it does not say so - which is exactly why the sets are asserted
    // beside it.
    // -------------------------------------------------------------------------

    it('reports the frame\'s ask, not this replica\'s holdings, once the cap binds', () => {
        const core = cappedOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch'] });
        core.runtime.requestTools(undefined, { names: ['probeOther'] });

        expect(setsOf(core)).toEqual({ enabled: ['probeOther', 'probeSearch'], withheld: [] });

        // Canonical lists THREE capped names (a wider cap, or a host that raised it); this replica
        // has TWO slots. Nothing here is a throw and nothing is `dropped`: the pruner asks whether a
        // name is REGISTERED and SWITCHABLE here, which all three are - it cannot know that the
        // kernel's own insertion will not fit the third.
        const reconcile = applyToolStateSync(
            { enabled: ['probeSearch', 'probeOther', 'probeThird'], withheld: [] },
            { replica: core, runtime: seamsOf(core) }
        );

        // THE REPORT: the frame's list, whole.
        expect(reconcile).toEqual({
            enabled: ['probeSearch', 'probeOther', 'probeThird'],
            withheld: [],
            dropped: []
        });
        // THE REPLICA: two names, and `probeSearch` is gone - evicted by step 3's newest-first
        // insertion (src/harness.ts:1974), not withheld, so the flag set cannot report it either.
        // `dropped` is empty, so a caller that reads this return as the replica's `enabled` list
        // believes a name this lane never declares.
        expect(setsOf(core)).toEqual({ enabled: ['probeThird', 'probeOther'], withheld: [] });
    });

    it('with the cap bound, a name canonical still lists can be undeclared here — and the residue flag is a fixed point, not a clear', () => {
        // CANONICAL, on the same fixture and cap, so the comparison is against a real capped
        // harness rather than a hand-written list: four grants, two evictions, nothing switched off.
        const canonical = cappedOf();

        canonical.runtime.requestTools(undefined, { names: ['probeSearch'] });
        canonical.runtime.requestTools(undefined, { names: ['probeOther'] });
        canonical.runtime.requestTools(undefined, { names: ['probeThird'] });
        canonical.runtime.requestTools(undefined, { names: ['probeSearch'] });

        expect(setsOf(canonical)).toEqual({ enabled: ['probeSearch', 'probeThird'], withheld: [] });

        const replica = cappedOf();

        replica.runtime.requestTools(undefined, { names: ['probeSearch'] });
        replica.runtime.requestTools(undefined, { names: ['probeOther'] });

        // FRAME 1 — the withdraw that leaves the residue. Canonical holds ONE capped name; the
        // replica held two, and step 4 frees the extra through the only seam that can, `disable`,
        // which flags it on the way out.
        const first = applyToolStateSync({ enabled: ['probeSearch'], withheld: [] }, { replica, runtime: seamsOf(replica) });

        // The report says NOTHING was withheld...
        expect(first).toEqual({ enabled: ['probeSearch'], withheld: [], dropped: [] });
        // ... while the replica flags `probeOther`. Same shape as the uncapped case two tests above
        // (whose return says `withheld: ['probeCore']` while the replica holds
        // `['probeCore', 'probeOther']`), reached here through cap pressure rather than a user
        // switch, which is the direction nobody clicks.
        expect(setsOf(replica)).toEqual({ enabled: ['probeSearch'], withheld: ['probeOther'] });

        // THE FIXED POINT, pinned rather than assumed. The flag is NOT self-clearing: an identical
        // frame runs step 2 (which enables `probeOther`, clearing the flag and re-taking the slot)
        // and step 4 (which hands it straight back to `disable`), and lands EXACTLY where it started
        // - report and sets both. Only a frame that lists the name under `enabled` again, or a grant
        // for it replayed by `applySync`, dissolves it.
        const repeated = applyToolStateSync({ enabled: ['probeSearch'], withheld: [] }, { replica, runtime: seamsOf(replica) });

        expect(repeated).toEqual(first);
        expect(setsOf(replica)).toEqual({ enabled: ['probeSearch'], withheld: ['probeOther'] });

        // FRAME 2 — canonical's current state, the list asserted at the top of this case. The
        // replica's step 2 re-enable of the flagged `probeOther` spends a slot before step 3 can
        // take `probeThird`, so step 4 withdraws... and the lane ends up declaring ONE of the two
        // names canonical declares.
        const second = applyToolStateSync({ enabled: ['probeSearch', 'probeThird'], withheld: [] }, { replica, runtime: seamsOf(replica) });

        expect(second).toEqual({ enabled: ['probeSearch', 'probeThird'], withheld: [], dropped: [] });
        // THE USER-VISIBLE CONSEQUENCE: `probeSearch` is on canonical's capped set and is NOT
        // declared to this lane's model - `declared()` reads the same capped set (src/harness.ts:4701),
        // and `toolRequest`'s catalogue on this lane selects out of it (src/harness.ts:3439). The
        // return names both, so the pane and the lane can disagree while both are "converged".
        expect(setsOf(replica)).toEqual({ enabled: ['probeThird'], withheld: ['probeOther'] });

        // THE SAME FRAME AGAIN moves WHICH name survives (the cap-bound shape of "converges": the
        // sets alternate rather than settle), and the report still claims both.
        const third = applyToolStateSync({ enabled: ['probeSearch', 'probeThird'], withheld: [] }, { replica, runtime: seamsOf(replica) });

        expect(third).toEqual(second);
        expect(setsOf(replica)).toEqual({ enabled: ['probeSearch'], withheld: ['probeOther'] });

        // THE INVARIANT THAT NEVER BREAKS, spelled as exact values at this point of the cycle: the
        // replica is never MORE permissive than canonical. Everything it declares is something
        // canonical declares, and the flag it holds names a name canonical does NOT declare either.
        // Being LESS is the direction this applier may drift, and it is the safe one: an undeclared
        // name costs the model a call it can ask for again, a declared-but-refused one costs a
        // faulted turn.
        expect(canonical.discoveredTools).toEqual(['probeSearch', 'probeThird']);
        expect(replica.discoveredTools).toEqual(['probeSearch']);
        expect(replica.discoveredTools.filter((name) => !canonical.discoveredTools.includes(name))).toEqual([]);
        expect(replica.withheldTools).toEqual(['probeOther']);
        expect(replica.withheldTools.filter((name) => canonical.discoveredTools.includes(name))).toEqual([]);
    });

    it('drops names this replica cannot register instead of throwing', () => {
        const core = coreOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch'] });

        // THREE kinds of unresolvable entry in ONE frame, all of which a live lane can genuinely
        // receive: a name that does not exist here at all (a `tool()` object a preset passed
        // cannot cross a thread - the `testFlaky` case in ./lane-tool-settings.test.ts; a nested
        // run tool `refuseNestedRuns` deletes), a core name named under `enabled` (a cap list
        // cannot hold it), and a name the coordinator has since removed.
        const reconcile = applyToolStateSync(
            {
                enabled: ['probeCore', 'ghostEnabled', 'probeSearch'],
                withheld: ['ghostWithheld', 'probeCore']
            },
            { replica: core, runtime: seamsOf(core) }
        );

        // DROPPED, with the reason - and the installed lists are the frame minus the drops. A
        // throw here would fault the frame and take the lane's live turn with it, which is the
        // opposite of what a settings push may do.
        expect(reconcile).toEqual({
            enabled: ['probeSearch'],
            withheld: ['probeCore'],
            dropped: [
                { name: 'probeCore', list: 'enabled', reason: 'not-switchable' },
                { name: 'ghostEnabled', list: 'enabled', reason: 'not-registered' },
                { name: 'ghostWithheld', list: 'withheld', reason: 'not-registered' }
            ]
        });

        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore'] });
    });

    it('tolerates wire junk: blank and duplicate members do not reach the kernel', () => {
        const core = coreOf();

        const reconcile = applyToolStateSync(
            {
                enabled: ['probeSearch', 'probeSearch', '', '   '],
                withheld: ['probeCore', 'probeCore']
            },
            { replica: core, runtime: seamsOf(core) }
        );

        // The empty string is not a name at all and is skipped in silence (there is nothing to
        // report); `   ` IS name-shaped, and the routed door this applier calls does NOT refuse it
        // as blank — that guard is `values.name.length === 0`, and its sentence is `toolManage
        // ${operation} requires \`name\`.` (src/harness.ts `manageTool` case 'enable' / 'disable');
        // a whitespace-only name walks past it and is refused as UNREGISTERED
        // (`Tool "   " is not registered in this harness.`). The prune mirrors that test exactly, so
        // `'   '` is dropped and REPORTED here like any other unresolvable name rather than skipped.
        // (The blank-name sentence a plugin sees, `A tool switch requires a non-empty tool name.`,
        // belongs to `requireSwitchableTool` — the plugin seam — and is NOT what this path throws.)
        // Duplicates collapse to one installation, which is what keeps a repeated name out of
        // `dropped`: it was installed, not refused.
        expect(reconcile).toEqual({
            enabled: ['probeSearch'],
            withheld: ['probeCore'],
            dropped: [{ name: '   ', list: 'enabled', reason: 'not-registered' }]
        });

        expect(setsOf(core)).toEqual({ enabled: ['probeSearch'], withheld: ['probeCore'] });
    });

    it('says "not now" rather than faulting when no replica exists yet', () => {
        // This process never ran `sayHello`, so the module's replica is still undefined - exactly
        // the handshake window a `sync.tools` frame can land in (the message listener does not
        // await `handle`). `undefined` is the applier's "there was nothing to apply this to",
        // which the caller turns into the deferral in LaneWorkerState `.pendingToolSync`; a FRAME
        // FAULT there would fail the handshake over a settings push.
        expect(applyToolStateSync({ enabled: [], withheld: [] })).toBeUndefined();
    });
});

describe('R5b canonical read: authority.toolStateNow() is the payload, not the caller\'s guess', () => {
    it('states both sets, live, as copies', () => {
        const core = coreOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch'] });

        const authority = createLaneAuthority({ harness: core });

        expect(authority.toolStateNow()).toEqual({ enabled: ['probeSearch'], withheld: [] });

        // LIVE, not a snapshot taken at authority creation - which is what "real time" needs from
        // the coordinator's side: the route reads this AFTER the write, and the lane must land on
        // the state the write produced.
        core.runtime.manageTool(undefined, { operation: 'disable', name: 'probeSearch' });

        expect(authority.toolStateNow()).toEqual({ enabled: [], withheld: ['probeSearch'] });

        // COPIES: the frame is structured-cloned on the way out, and a caller that sorts or
        // splices must not move the canonical harness.
        const payload = authority.toolStateNow();

        payload.enabled.push('injected');
        payload.withheld.length = 0;

        expect(authority.toolStateNow()).toEqual({ enabled: [], withheld: ['probeSearch'] });
    });

    it('names a switched-off core tool that no enabled list can mention', () => {
        const core = coreOf();
        const authority = createLaneAuthority({ harness: core });

        core.runtime.manageTool(undefined, { operation: 'disable', name: 'probeCore' });

        // `probeCore` is absent from BOTH sides of `enabled` before and after - a core name never
        // holds a cap slot (src/harness.ts:13149) - so a reconcile built from `enabled` alone
        // would tell a replica nothing and it would go on declaring the hidden tool.
        expect(authority.toolStateNow()).toEqual({ enabled: [], withheld: ['probeCore'] });
        expect(core.discoveredTools).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Level 3: a REAL lane worker, REAL turns, and the tool list the provider was sent.
//
// Same shape as the deepest level of ./lane-tool-settings.test.ts: the `flaky` preset is
// rebuildable FROM A RECORD (a scripted factory is a closure a thread cannot receive) and has a
// live transport, so the replica's `declared()` output arrives at a loopback stub as BYTES.
// `workerIdleMs: 0` disables the reclaim timer (./lane-host.ts `armIdle` returns on <= 0), so a
// lane stays WARM between dispatches - and "warm" is the entire subject here: a cold lane would
// prove only the blueprint path.
// ---------------------------------------------------------------------------

const WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

const SETTINGS: RunnerSettings = { baseURL: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test/model' };

const LANE_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    workerEntry: WORKER_ENTRY,
    workerIdleMs: 0,
    maxLaneWorkers: 8,
    workerHandshakeMs: 120_000
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;

const textRound = (content: string): string => sse({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

const callRound = (id: string, name: string, args: string): string =>
    sse({
        choices: [
            {
                delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
                finish_reason: 'tool_calls'
            }
        ]
    });

// A stub provider that can HOLD one response open. The hold is what turns "the switch moved
// while the thread was still running" into an observable moment rather than a hope: the test
// waits until the replica has ASKED its next question, flips the switch mid-stream, and only
// then lets the answer arrive - so the tool launch that request produces is provably AFTER the
// frame, and the launch that produced the request is provably before it. Without the hold the
// two sides of that ordering are a race against a worker thread.
type Stub = { origin: string; requests: Record<string, any>[]; held: () => boolean; release: () => void; close: () => Promise<void> };

const stubs: Stub[] = [];
const stores: SessionStore[] = [];

// `holdIndex` is the 0-based REQUEST to hold; every other round is answered as it arrives, and
// the last round repeats for an unexpected extra request so a runaway run still settles.
const startProvider = async (rounds: string[], options: { holdIndex?: number } = {}): Promise<Stub> => {
    const requests: Record<string, any>[] = [];
    const scripted = rounds.slice();

    let releaseHeld: () => void = () => undefined;
    let holding = false;

    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const index = requests.length;
            const round = scripted[Math.min(index, scripted.length - 1)];

            requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));

            const answer = (): void => {
                response.setHeader('Content-Type', 'text/event-stream');
                response.statusCode = 200;
                response.end(round);
            };

            if (options.holdIndex === index && !holding) {
                holding = true;

                releaseHeld = () => {
                    holding = false;
                    answer();
                };

                return;
            }

            answer();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const stub: Stub = {
        origin: `http://127.0.0.1:${port}`,
        requests,
        held: () => holding,
        release: () => releaseHeld(),
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };

    stubs.push(stub);

    return stub;
};

// The tool names one captured request offered the model, in declaration order. The OpenAI wire
// format nests the definition under `function` (src/transport/openai.ts), so this IS the
// replica's `declared()` output and nothing else.
const requestedTools = (request: Record<string, any> | undefined): string[] =>
    ((request?.tools ?? []) as { function?: { name?: string } }[]).map((entry) => String(entry.function?.name));

const settledTurn = async (store: SessionStore, sessionId: string, turnId: string, limitMs = 120_000): Promise<SessionTurn> => {
    const started = Date.now();

    for (;;) {
        const turn = store.get(sessionId).turns.find((entry) => entry.id === turnId);

        if (turn !== undefined && turn.status !== 'running' && turn.status !== 'queued') return turn;

        if (Date.now() - started > limitMs) {
            throw new Error(`Turn ${turnId} did not settle within ${limitMs}ms (last status: ${turn?.status ?? 'missing'}).`);
        }

        await sleep(25);
    }
};

// The two host/authority handles the ROUTE will use, reached the way the existing lane tests
// reach the private ones. As of T10 the store has a PUBLIC wrapper for this exact composition —
// ../sessions.ts `pushToolState`, called by ../api.ts on the operator door — and level 4 below
// proves the requirement through it. This hand-composed helper stays for the ordering cases, which
// need a push WITHOUT a write (and, in the boot-window case, one that lands between `lanes.set`
// and the worker's hello install, where the route could not be awaited).
// `host` is UNDEFINED until the store's first worker-mode dispatch creates it, exactly why the
// store's own call site uses `this.host?.` (../sessions.ts `onRegistryChange`) - so the push is
// optional-chained here too. A toggle made before a session ever had a lane must answer 200, not
// crash the route.
const hostOf = (store: SessionStore): LaneHost | undefined => (store as unknown as { host?: LaneHost }).host;

const authorityOf = (store: SessionStore, sessionId: string): LaneAuthority =>
    (store as unknown as { authorityOf: (session: unknown) => LaneAuthority }).authorityOf(store.liveSession(sessionId));

// THE PUSH ON ITS OWN, because the ordering cases need it without a write. The payload is the
// AUTHORITY's read (`toolStateNow`), never a caller's guess, and the target is EVERY lane of the
// session - which is the wire form of "the panel toggle is global session level".
const pushToolState = (store: SessionStore, sessionId: string): void => {
    hostOf(store)?.broadcastTools(sessionId, authorityOf(store, sessionId).toolStateNow());
};

// THE LIVE WRITE ITSELF: `toolManage enable|disable` on the canonical harness - the exact call
// ../api.ts `setSessionToolEnabled` makes - followed by the push. No route involved, so no
// route-level gate (403 `protected` / 409 idle) can soften what is being asserted here.
const switchAndPush = (store: SessionStore, sessionId: string, name: string, enabled: boolean): void => {
    store.liveSession(sessionId).harness.runtime.manageTool(undefined, { operation: enabled ? 'enable' : 'disable', name });

    pushToolState(store, sessionId);
};

// The live lanes of one session. Role-AGNOSTIC on purpose: what this file proves is that the SAME
// worker served two turns, and the EPOCH is that proof. The role spelling is the store's business
// (a legacy dispatch and a thread dispatch name their lane differently), so pinning it here would
// turn a store-side rename into an apparent R5b regression.
const lanesOf = (store: SessionStore, sessionId: string): { role: string; epoch: number; busy: boolean }[] =>
    (hostOf(store)?.lanes() ?? [])
        .filter((lane) => lane.sessionKey === sessionId)
        .map(({ role, epoch, busy }) => ({ role, epoch, busy }));

const newLaneStore = async (stub: Stub): Promise<SessionStore> => {
    const store = new SessionStore(
        { ...SETTINGS, baseURL: `${stub.origin}/v1` },
        createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
        undefined,
        { runtime: LANE_RUNTIME }
    );

    stores.push(store);

    return store;
};

afterAll(async () => {
    for (const store of stores) store.dispose();

    for (const stub of stubs) await stub.close();

    await sleep(250);
});

describe('R5b real time: a toggle reaches the WARM lane that is already serving this session', () => {
    // `glob` is the name for ONE reason: it is a `visibility: 'core'` declaration of the shared
    // toolbox, so it is on every request without a discovery round, and it is NOT a member of
    // `discoveredTools` at all. A reconcile that carried only the `enabled` list - which is what
    // the protocol could carry before R5b - leaves this name declared forever.
    const CORE = 'glob';

    it('drops a core name on the next request of every warm lane, and brings it back on a re-enable', async () => {
        const provider = await startProvider([
            textRound('one'),
            textRound('two'),
            textRound('three'),
            textRound('four'),
            textRound('five'),
            textRound('six')
        ]);

        const store = await newLaneStore(provider);
        const session = await store.create('flaky');

        // One turn, one captured request, and the lane row that served it. Every turn here is a
        // SINGLE model request (a text round, no tools), so request N belongs to turn N.
        let served = 0;

        const runOn = async (prompt: string, threadId?: string): Promise<{ tools: string[]; threadId?: string }> => {
            const submitted = await store.dispatch(session.id, prompt, undefined, undefined, threadId);
            const turn = await settledTurn(store, session.id, submitted.turn.id);

            expect(turn.status).toBe('done');
            expect(store.workerExecution).toBe(true);

            served += 1;

            expect(provider.requests).toHaveLength(served);

            return { tools: requestedTools(provider.requests[served - 1]), threadId: turn.threadId };
        };

        // TWO conversations, so "affects all threads" is a claim about two live lanes rather
        // than a sentence about one. A dispatch with no `threadId` mints a new conversation and
        // therefore a new lane (./lane-host.ts keys a lane by session PLUS target).
        const first = await runOn('first');
        const second = await runOn('second');

        expect(first.threadId).toBeDefined();
        expect(second.threadId).toBeDefined();
        expect(first.threadId).not.toBe(second.threadId);

        const warmBefore = lanesOf(store, session.id);

        expect(warmBefore).toHaveLength(2);
        // Both lanes are warm and idle: `workerIdleMs: 0` disables the reclaim timer
        // (./lane-host.ts `armIdle` returns on <= 0), so neither turn below can be reading a
        // blueprint it just received.
        expect(warmBefore.map((lane) => lane.busy)).toEqual([false, false]);
        expect(new Set(warmBefore.map((lane) => lane.epoch)).size).toBe(2);

        const before = first.tools;

        expect(before).toContain(CORE);
        expect(second.tools).toEqual(before);

        // THE TOGGLE, on the canonical harness, while BOTH lanes are warm.
        switchAndPush(store, session.id, CORE, false);

        // TURN 3 - the SAME conversation, hence the SAME worker. The epoch is the proof: a lane
        // that had been reclaimed and rebuilt would report a NEW epoch, and would then prove only
        // the blueprint path, which ./lane-tool-settings.test.ts already covers.
        const onFirst = await runOn('third', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warmBefore);

        // EXACTLY one name removed - no neighbour, no slot, no order change. Had the frame
        // arrived and been ignored, this would still equal `before`.
        expect(onFirst.tools).not.toContain(CORE);
        expect(onFirst.tools).toEqual(before.filter((name) => name !== CORE));

        // TURN 4 - the OTHER warm lane, which never made the request that triggered the push.
        // This is the second half of the requirement: one panel switch, EVERY thread of the
        // session, including the ones that were already running conversations of their own.
        const onSecond = await runOn('fourth', second.threadId);

        expect(lanesOf(store, session.id)).toEqual(warmBefore);
        expect(onSecond.tools).toEqual(onFirst.tools);

        // A DUPLICATE FRAME: the host may post the same state twice (two clicks, a second
        // conversation toggled in the same panel), and a one-way frame means nobody learns
        // whether the lane saw the first one. So the second must be a no-op, not a double
        // withdrawal and not a fault.
        pushToolState(store, session.id);
        pushToolState(store, session.id);

        const repeated = await runOn('fifth', first.threadId);

        expect(repeated.tools).toEqual(onFirst.tools);

        // THE RE-ENABLE on the same warm lane: the name comes back EXACTLY - the core declaration
        // is restored in its original position, and no neighbour was disturbed by the round trip.
        switchAndPush(store, session.id, CORE, true);

        const reEnabled = await runOn('sixth', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warmBefore);
        expect(reEnabled.tools).toEqual(before);
    }, 300_000);

    it('does not abort the turn that is running, and refuses only the launch that follows it', async () => {
        // The requirement's other half: "real time (when the agent's thread is still running)".
        // The kernel's rule - which the frame has to preserve, not merely avoid breaking - is
        // that the switch is read at LAUNCH (src/harness.ts:8040). So a call already scheduled
        // when the frame lands keeps running, and the NEXT call of the SAME live turn is refused.
        //
        // `timeNow` is the name for that job: searchable, so it is declared only because this
        // session enabled it, and instant to execute. Round 1 launches it BEFORE the frame,
        // round 2 launches it AFTER, and the only difference between the two calls is the frame.
        // Round 2's response is HELD while the switch is written and pushed, so "after" is a
        // construction rather than a hope.
        const NAME = 'timeNow';
        const SESSION_REFUSAL = `Tool "${NAME}" is switched off for this conversation by its user. Calling toolRequest will not find it and asking again will not change this answer.`;

        const provider = await startProvider(
            [callRound('call_before', NAME, '{"timezone":"UTC"}'), callRound('call_after', NAME, '{"timezone":"UTC"}'), textRound('adapted')],
            { holdIndex: 1 }
        );

        const store = await newLaneStore(provider);
        const session = await store.create('flaky');

        // Enable canonically BEFORE the lane exists, so the replica restores the name and both
        // calls below are launched by a thread that legitimately holds it.
        store.liveSession(session.id).harness.runtime.manageTool(undefined, { operation: 'enable', name: NAME });

        const submitted = await store.dispatch(session.id, 'twice, please');

        // Park in the held response: the FIRST tool call has already run (its result is in the
        // transcript this second request carries), and the turn is still live.
        const started = Date.now();

        while (!provider.held()) {
            if (Date.now() - started > 120_000) {
                throw new Error(`The lane never parked in the held request (saw ${provider.requests.length} of 2).`);
            }

            await sleep(20);
        }

        // THE TOGGLE, mid-turn, on the still-running conversation.
        switchAndPush(store, session.id, NAME, false);

        provider.release();

        const turn = await settledTurn(store, session.id, submitted.turn.id);

        expect(turn.status).toBe('done');
        // The frame is a settings push, not a control: it must not have cancelled or faulted the
        // run that was in flight when it landed. `done` (not `failed`/`cancelled`) IS that
        // statement - a lane turn that ends in a fault surfaces a different status, and the
        // worker's own `fault` frame settles the turn rather than continuing it.
        expect(store.workerExecution).toBe(true);
        expect(provider.requests).toHaveLength(3);

        const events = (turn as unknown as { events?: { type: string; name?: string; content?: string }[] }).events ?? [];
        const calls = events.filter((event) => event.type === 'tool_result' && event.name === NAME);

        expect(calls).toHaveLength(2);
        // LAUNCH 1: it RAN. A reconcile that aborted the turn, or re-checked an already scheduled
        // call at its boundary, would have refused this one with the switch sentence too.
        expect(calls[0]?.content).not.toBe(SESSION_REFUSAL);
        expect(String(calls[0]?.content ?? '')).toContain('UTC');
        // LAUNCH 2: refused, by the REPLICA's copy of the switch, inside the same live turn.
        expect(calls[1]?.content).toBe(SESSION_REFUSAL);
    }, 240_000);
});

describe('R5b real time: a toggle made while NO lane exists still lands on the lane created after it', () => {
    // The ordering case the frame cannot cover by itself: a one-way push to zero lanes is
    // received by nobody. What makes the requirement true anyway is that the SAME two lists are
    // also the blueprint's (./protocol.ts `LaneBlueprint.withheldTools`, and the snapshot's own
    // `discovery.withheld`), and `sayHello` installs them through the applier this frame uses.
    // One carrier for a live lane, one for a lane not yet born, ONE applier for both.
    const CORE = 'glob';

    it('lands the switch on a cold lane whose session was switched off while it had no worker', async () => {
        const provider = await startProvider([textRound('first'), textRound('second')]);

        const store = await newLaneStore(provider);
        const session = await store.create('flaky');

        // The session exists; its lane does not yet. This is the state a panel toggle made in
        // the window between the previous lane's reclaim and the next turn.
        store.liveSession(session.id).harness.runtime.manageTool(undefined, { operation: 'disable', name: CORE });

        // The push happens with NO lane to receive it. It must not throw, and it must not be
        // needed: the state below lands through the blueprint, which is the same two lists.
        expect(() => pushToolState(store, session.id)).not.toThrow();

        expect(lanesOf(store, session.id)).toEqual([]);

        const first = await store.dispatch(session.id, 'first');

        expect((await settledTurn(store, session.id, first.turn.id)).status).toBe('done');
        expect(provider.requests).toHaveLength(1);

        const cold = requestedTools(provider.requests[0]);

        expect(cold).not.toContain(CORE);
        expect(cold).toContain('toolRequest');

        // And the warm lane the session now has keeps the same answer for the next frame-free
        // turn: the state landed on the replica, it did not merely ride on one request.
        const second = await store.dispatch(session.id, 'second');

        expect((await settledTurn(store, session.id, second.turn.id)).status).toBe('done');
        expect(requestedTools(provider.requests[1])).toEqual(cold);
    }, 240_000);

    it('cannot lose a toggle that lands while the lane it belongs to is still booting', async () => {
        // THE BOOT WINDOW, the one case neither carrier above covers. The host posts the `hello`
        // blueprint and registers the lane row in the same tick (./lane-host.ts:872-874 - `post
        // (lane, { kind: 'hello', ... blueprint })`, then `lanes.set(key, lane)`), and the worker
        // still has a whole harness bootstrap to run before it installs that snapshot
        // (./lane-worker-loop.ts `sayHello`, :1637). A switch written inside that window is too
        // LATE for the blueprint - the snapshot is already taken, with `glob` enabled - and too
        // EARLY for the live path, so the frame is STASHED instead of dropped
        // (./lane-worker-loop.ts `.pendingToolSync`: field :206, stash :1947-1956, install
        // :1640-1647, after the blueprint so the newer figure wins).
        //
        // The assertion is timing-TOLERANT on purpose: on a slower boot the push can land after the
        // hello, and then the ordinary live path applies it. What must never happen is the toggle
        // VANISHING, and that is exactly what a missing stash produces whenever the push does land
        // in the window - which it does here, because the row appears long before the worker's
        // bootstrap ends. Turn 2's OWN request list is therefore not asserted: whether it still
        // carries `glob` depends on where in the window the push fell.
        const provider = await startProvider([textRound('boot-warm'), textRound('boot-window'), textRound('boot-after')]);

        const store = await newLaneStore(provider);
        const session = await store.create('flaky');

        // One warm lane first, so the epoch that appears next is provably a NEW worker rather than
        // the existing one being reused.
        const warm = await store.dispatch(session.id, 'boot-warm');

        expect((await settledTurn(store, session.id, warm.turn.id)).status).toBe('done');

        const before = lanesOf(store, session.id);

        expect(before).toHaveLength(1);

        const knownEpochs = new Set(before.map((lane) => lane.epoch));

        // A dispatch with no thread id mints a new conversation, hence a new lane (lane-host.ts
        // keys a lane by session PLUS target). It is deliberately NOT awaited yet: the push has to
        // land while that lane is between `lanes.set` and its hello install.
        const pending = store.dispatch(session.id, 'boot-window');

        const limit = Date.now() + 120_000;

        for (;;) {
            if (lanesOf(store, session.id).some((lane) => !knownEpochs.has(lane.epoch))) break;

            if (Date.now() > limit) throw new Error('The second lane never registered with the host.');

            await sleep(5);
        }

        // THE TOGGLE, inside the window: canonical write, then the session-wide push.
        switchAndPush(store, session.id, CORE, false);

        const submitted = await pending;
        const booted = await settledTurn(store, session.id, submitted.turn.id);

        expect(booted.status).toBe('done');

        const bootEpoch = lanesOf(store, session.id).find((lane) => lane.epoch !== before[0]!.epoch);

        expect(bootEpoch).toBeDefined();

        // The NEXT request of THAT lane, with no push of its own - the state has to be on the
        // replica, not merely have rode in on one frame.
        const after = await store.dispatch(session.id, 'boot-after', undefined, undefined, booted.threadId);

        expect((await settledTurn(store, session.id, after.turn.id)).status).toBe('done');

        // The same worker, un-rebuilt: the booting lane's epoch is still in the pool, and the
        // original warm lane is untouched.
        const rows = lanesOf(store, session.id);

        expect(rows.some((lane) => lane.epoch === bootEpoch!.epoch)).toBe(true);
        expect(rows.some((lane) => lane.epoch === before[0]!.epoch)).toBe(true);

        const declared = requestedTools(provider.requests[provider.requests.length - 1]);

        // One request per turn: three text rounds, three captures.
        expect(provider.requests).toHaveLength(3);
        expect(declared).not.toContain(CORE);
        // Compared against the BOOTING lane's own previous request, which is timing-dependent only
        // about `CORE`: every other name has to be identical, so the frame removed its name and
        // nothing else on that replica.
        expect(declared).toEqual(requestedTools(provider.requests[1]).filter((name) => name !== CORE));
    }, 300_000);
});

// ---------------------------------------------------------------------------
// T10 — THE TRIGGER, which is the half of R5b the requirement is actually about. Everything above
// proves the FRAME converges a lane once somebody posts it, and every case above posts it by hand
// (`pushToolState` / `switchAndPush`). Nothing above proves that a real toggle posts it:
//
//   "toggling tools is purely for agents/threads of that session, and it can be in real time
//    (when the agent's thread is still running)."
//
// TWO doors move the canonical switch, and each one now has a caller:
//   - the OPERATOR door: `PATCH /sessions/{id}/tools/{tool_id} {enabled}` → ../api.ts
//     `setSessionToolEnabled` → ../sessions.ts `pushToolState` → ./lane-host.ts `broadcastTools`;
//   - the MODEL door: a routed `manageTool enable|disable|remove`, or a `requestTools` grant →
//     ./lane-authority.ts `onToolStateChange` (wired by ../sessions.ts `authorityOf`) → the same
//     `broadcastTools`.
//
// LEVEL 2b pins WHEN the hook fires and with WHAT payload, on the 3-tool fixture harness every
// level-1 case above already uses, so both discovery sets are hand-knowable and every assertion is
// an exact expected value. LEVEL 4 pins the requirement through the REAL route with REAL warm lanes,
// which is the only place "the operator's switch moved the model's toolbox" is an observed fact
// rather than a composition of correct parts.
// ---------------------------------------------------------------------------

// The API mount (../api.ts addresses sessions under it), spelled as ../api-session-tool-writes
// .test.ts:88 spells it.
const MOUNT = '/v1/harness';

// A routed request as a lane raises it: the same shape ./lane-authority.request-scope.test.ts
// :96-104 uses. The routing of THIS frame across the worker boundary is T5's contract and already
// proven with a real worker; what is under test here is what the authority does with it.
const routed = (method: string, parameters: Record<string, unknown>, threadId = 'thread-probe'): LaneAuthorityRequest =>
    ({ op: 'runtime', method, parameters, identity: { agent: 'primary', threadId } }) as LaneAuthorityRequest;

const LANE_EPOCH = 1;

// A model-door authority over a fixture harness, with the hook under test attached. `openLane` is
// not decoration: an epoch the coordinator never opened is a DEAD one (./lane-commit.ts:466) and
// `answer` refuses it, and opening it at attach is exactly what ./lane-host.ts does in production.
const modelDoor = (core: Harness, onPush: (tools: LaneToolStateSync) => void): LaneAuthority => {
    const authority = createLaneAuthority({ harness: core, onToolStateChange: onPush });

    authority.openLane(LANE_EPOCH);

    return authority;
};

// The state a session's toolbox is in once the model has been granted BOTH searchable names: the
// capped set in grant order, nothing switched off. Every payload asserted below is stated relative
// to this, and `probeCore` never appears on the enabled axis at all (a core declaration holds no
// cap slot) — which is the whole reason the frame carries a second list.
const doorOpen = (): { core: Harness; pushes: LaneToolStateSync[]; authority: LaneAuthority } => {
    const core = coreOf();

    core.runtime.requestTools(undefined, { names: ['probeSearch', 'probeOther'] });

    const pushes: LaneToolStateSync[] = [];

    return { core, pushes, authority: modelDoor(core, (tools) => { pushes.push(tools); }) };
};

describe('R5b trigger, level 2b: the model door posts exactly what moved, and nothing else', () => {
    it('posts both sets for a disable, answers an idempotent repeat with no frame, and posts the re-enable', async () => {
        const { core, pushes, authority } = doorOpen();

        // The hook is on the AUTHORITY's door, not a harness observer: the state reached here
        // through the core's own seam must not have posted anything yet.
        expect(pushes).toEqual([]);
        expect(authority.toolStateNow()).toEqual({ enabled: ['probeSearch', 'probeOther'], withheld: [] });

        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeSearch' }));

        // EXACT: the capped set lost its newest entry, the switch set gained it. Both lists, always
        // — the applier replays them wholesale (./lane-worker-loop.ts `applyToolStateSync`).
        expect(pushes).toEqual([{ enabled: ['probeOther'], withheld: ['probeSearch'] }]);

        const repeated = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeSearch' }));

        // The kernel's own idempotence figure (src/harness.ts:3003) and the silence that follows it.
        // A live turn can ask for the same switch every step, and each one would otherwise post a
        // session-wide frame whose effect is provably nothing.
        expect(repeated.value).toEqual({ name: 'probeSearch', operation: 'disable', enabled: false, changed: false });
        expect(pushes).toHaveLength(1);

        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'enable', name: 'probeSearch' }));

        // The re-enable comes back newest-first (src/harness.ts:1934ff), which is the order the
        // frame has to carry — see the order-only case below.
        expect(pushes).toEqual([
            { enabled: ['probeOther'], withheld: ['probeSearch'] },
            { enabled: ['probeSearch', 'probeOther'], withheld: [] }
        ]);
        expect(core.discoveredTools).toEqual(['probeSearch', 'probeOther']);
        expect(core.withheldTools).toEqual([]);
    });

    it('posts a switched-off CORE name that the enabled list can never mention', async () => {
        const { core, pushes, authority } = doorOpen();

        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeCore' }));

        // The enabled axis is byte-identical to the base: a reconcile built from `enabled` alone —
        // which is all the protocol could carry before R5b — would tell every sibling lane nothing,
        // and they would go on declaring a tool this conversation has hidden.
        expect(pushes).toEqual([{ enabled: ['probeSearch', 'probeOther'], withheld: ['probeCore'] }]);
        expect(core.discoveredTools).toEqual(['probeSearch', 'probeOther']);

        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'enable', name: 'probeCore' }));

        expect(pushes).toHaveLength(2);
        expect(pushes[1]).toEqual({ enabled: ['probeSearch', 'probeOther'], withheld: [] });
        expect(core.withheldTools).toEqual([]);
    });

    it('keeps every read silent, including the read the kernel refuses', async () => {
        const { core, pushes, authority } = doorOpen();
        const base = authority.toolStateNow();

        const listed = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'list' }));

        expect((listed.value as { tools: { name: string }[] }).tools.map((entry) => entry.name)).toContain('probeSearch');

        const detailed = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'details', name: 'probeSearch' }));

        expect(detailed.value).toMatchObject({ name: 'probeSearch', enabled: true });

        // A read that ERRORS is still a read: `manageTool source` on a prepared definition throws
        // (no editable revision), and nothing moved before the throw either.
        await expect(authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'source', name: 'probeSearch' }))).rejects.toThrow('has no editable source revision');

        expect(pushes).toEqual([]);
        expect(authority.toolStateNow()).toEqual(base);
        expect(core.withheldTools).toEqual([]);
    });

    it('says nothing for a switch the kernel refused, and never reaches the state after it', async () => {
        const { core, pushes, authority } = doorOpen();

        // Both refusals are the kernel's own sentences (src/harness.ts:3048 and the not-registered
        // guard): an unregistered name, and a core entry that cannot be unregistered.
        await expect(authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeGhost' }))).rejects.toThrow('Tool "probeGhost" is not registered in this harness.');

        // The push lives AFTER the canonical write, so a throw on the way in cannot post a frame —
        // and the state it would have described is the state that was already true.
        expect(pushes).toEqual([]);
        expect(authority.toolStateNow()).toEqual({ enabled: ['probeSearch', 'probeOther'], withheld: [] });

        const listed = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'list' }));

        expect((listed.value as { tools: { name: string }[] }).tools.map((entry) => entry.name)).toContain('probeSearch');
        expect(core.withheldTools).toEqual([]);
    });

    it('treats an order-only move of the capped set as the change it is', async () => {
        const { core, pushes, authority } = doorOpen();

        // `probeOther` is already enabled and already in this set — the ONLY thing the grant changes
        // is its position (newest-selection-first, src/harness.ts:13149). A set comparison would
        // swallow this and leave every sibling lane declaring the old order, which is precisely the
        // drift the frame exists to prevent; `sameToolList` compares element by element for THIS.
        await authority.answer(LANE_EPOCH, routed('requestTools', { names: ['probeOther'] }));

        expect(pushes).toEqual([{ enabled: ['probeOther', 'probeSearch'], withheld: [] }]);
        expect(core.discoveredTools).toEqual(['probeOther', 'probeSearch']);

        // The same request again: it still MATCHES (the model is told the tool it holds), and now
        // nothing moves at all — so the second one is silent, on a hot path inside a live turn.
        const again = await authority.answer(LANE_EPOCH, routed('requestTools', { names: ['probeOther'] }));

        expect(again.value).toMatchObject({ matched: 1, enabled: ['probeOther'] });
        expect(pushes).toHaveLength(1);

        // A grant that matches nothing (the shape a model gets when the name is hidden or unknown)
        // cannot move the state, and posts nothing either.
        const missed = await authority.answer(LANE_EPOCH, routed('requestTools', { names: ['probeGhost'] }));

        expect(missed.value).toMatchObject({ matched: 0, enabled: [] });
        expect(pushes).toHaveLength(1);
    });

    it('posts a remove, whose withheld entry leaves with the registration', async () => {
        const { core, pushes, authority } = doorOpen();

        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeOther' }));
        await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'remove', name: 'probeOther' }));

        // Two frames, in order: the switch, then the un-publish that CLEARS the switch (an
        // unregistered name must not stay withheld — src/harness.ts:3071). A sibling lane that
        // missed the second one would keep a row for a tool that no longer exists.
        expect(pushes).toEqual([
            { enabled: ['probeSearch'], withheld: ['probeOther'] },
            { enabled: ['probeSearch'], withheld: [] }
        ]);
        expect(core.discoveredTools).toEqual(['probeSearch']);
        expect(core.withheldTools).toEqual([]);

        // A second remove, of the LAST searchable name: the frame must say the capped set is empty
        // as well as the switch set, or a sibling lane keeps declaring a tool that no longer exists.
        const last = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'remove', name: 'probeSearch' }));

        expect((last.value as { removed?: boolean }).removed).toBe(true);
        expect(pushes).toHaveLength(3);
        expect(pushes[2]).toEqual({ enabled: [], withheld: [] });
    });

    it('cannot be defeated by a lane that is gone: the write stands and the answer is still sent', async () => {
        const core = coreOf();

        core.runtime.requestTools(undefined, { names: ['probeSearch', 'probeOther'] });

        // THE HOOK'S FAILURE CONTRACT, driven through the real door: the listener is the host's
        // broadcast, and a lane whose thread died between the write and the post must not fault the
        // routed REQUEST that the write already settled.
        const authority = modelDoor(core, () => {
            throw new Error('the lane worker is gone');
        });

        const answer = await authority.answer(LANE_EPOCH, routed('manageTool', { operation: 'disable', name: 'probeSearch' }));

        expect(answer.value).toEqual({ name: 'probeSearch', operation: 'disable', enabled: false, changed: true });
        // The reply's own fast path for the REQUESTING lane is untouched by the swallowed push.
        expect(answer.sync).toEqual({ enabled: ['probeOther'] });
        // And canonical state moved, which is what every OTHER lane will be told next time.
        expect(core.withheldTools).toEqual(['probeSearch']);
        expect(core.discoveredTools).toEqual(['probeOther']);
    });
});

// `watchPushes` patches a live host method, and the mocks are per-case state: an un-restored spy
// would make the NEXT case deliver through the previous case's recorder.
afterEach(() => {
    vi.restoreAllMocks();
});

// The store's OWN host, watched rather than replaced: every frame the doors post below is still
// delivered to the real lanes, so a level-4 assertion about a model request proves the whole chain,
// while the recorder says exactly how many frames left the server and what they carried.
const watchPushes = (store: SessionStore): { sessionId: string; tools: LaneToolStateSync }[] => {
    const host = hostOf(store);

    expect(host).toBeDefined();

    const seen: { sessionId: string; tools: LaneToolStateSync }[] = [];
    const deliver = host!.broadcastTools.bind(host!);

    vi.spyOn(host!, 'broadcastTools').mockImplementation((sessionKey: string, tools: LaneToolStateSync) => {
        seen.push({ sessionId: sessionKey, tools });

        deliver(sessionKey, tools);
    });

    return seen;
};

// One turn, and the tool list it put on the wire. Every round here is a text round with no tool
// call, so exactly one model request belongs to each turn — the same accounting the cases above use.
const runTurn = async (
    store: SessionStore,
    provider: Stub,
    sessionId: string,
    prompt: string,
    threadId?: string
): Promise<{ tools: string[]; threadId?: string }> => {
    const served = provider.requests.length;
    const submitted = await store.dispatch(sessionId, prompt, undefined, undefined, threadId);
    const turn = await settledTurn(store, sessionId, submitted.turn.id);

    expect(turn.status).toBe('done');
    expect(store.workerExecution).toBe(true);
    expect(provider.requests).toHaveLength(served + 1);

    return { tools: requestedTools(provider.requests[served]), threadId: turn.threadId };
};

// A store AND the route over it, from ONE registry: the route writes the switch on the harness the
// store's sessions live on, so the state `pushToolState` reads is the state the route just wrote.
// This is ../api-session-tool-writes.test.ts `openPair` (:223-236) with the lane runtime of
// `newLaneStore` above, and a session whose lanes are real workers.
const openLanePair = async (rounds: string[]): Promise<{ store: SessionStore; api: (request: unknown) => Promise<HarnessApiResult>; provider: Stub }> => {
    const provider = await startProvider(rounds.map(textRound));
    const registry = createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never);
    const store = new SessionStore(
        { ...SETTINGS, baseURL: `${provider.origin}/v1` },
        registry,
        undefined,
        { runtime: LANE_RUNTIME }
    );

    stores.push(store);

    // `defaults` is not optional: ../api.ts reads it to build the provider-defaults document, and a
    // store created through the route inherits the same model/base URL it was built with.
    const api = createHarnessApi({
        registry: registry as never,
        store,
        defaults: { baseURL: `${provider.origin}/v1`, model: SETTINGS.model, hasApiKey: true },
        providerBaseURL: provider.origin
    });

    return { store, api: (request: unknown) => api(request as HarnessApiRequest), provider };
};

// One call against the route, in the shape the adapters hand the dispatcher (`pathname` + `mount` +
// `readBody`, never a joined path; the query is split out, exactly as
// ../api-session-tool-writes.test.ts:238-259 does), reduced to the two figures every case below
// needs.
const callRoute = async (
    api: (request: unknown) => Promise<HarnessApiResult>,
    method: 'GET' | 'PATCH',
    rawPathname: string,
    body: unknown = {}
): Promise<{ status: number; body: Record<string, any> }> => {
    const [pathname, query] = rawPathname.split('?');
    const result = await api({
        method,
        pathname: pathname!,
        mount: MOUNT,
        ...(query === undefined ? {} : { searchParams: new URLSearchParams(query) }),
        readBody: async () => body
    } as HarnessApiRequest);

    if (result.kind !== 'json') throw new Error(`Expected a JSON answer from ${method} ${rawPathname}, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

// The row the OPERATOR sees, read back through the route (../api.ts `listSessionTools`): the switch
// the frame carries is the same figure this row states, so a lane and a pane cannot disagree.
const rowOf = async (
    api: (request: unknown) => Promise<HarnessApiResult>,
    sessionId: string,
    name: string
): Promise<Record<string, any> | undefined> => {
    const page = await callRoute(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`);

    return (page.body.items as { name: string }[]).find((entry) => entry.name === name);
};

describe('R5b trigger, level 4: the operator PATCH through the route is the toggle the requirement names', () => {
    // `glob`, chosen for the reason T7 chose it (see the header): a `visibility: 'core'` declaration
    // of the shared toolbox, so it is declared on every request, holds no cap slot, and can ONLY be
    // carried by the withheld axis of the frame.
    const CORE = 'glob';

    it('moves the core names `glob` and `write` out of the next request of every warm lane and back, and heals a repeated click', async () => {
        const { store, api, provider } = await openLanePair(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
        // The SAME fixture preset every wire case above uses (`SessionStore.create` takes the HARNESS
        // name, not a session label): it is the one whose toolbox declares `glob` as a core entry,
        // and its worker capability is what ./lane-tool-settings.test.ts and the cases above run on.
        const session = await store.create('flaky');

        // TWO conversations, hence TWO warm lanes, before anything is toggled: the requirement says
        // "agents/threads of that session", plural, and "still running" means the lanes are already
        // up. `workerIdleMs: 0` (LANE_RUNTIME above) keeps them that way for the whole case.
        const first = await runTurn(store, provider, session.id, 'first');
        const second = await runTurn(store, provider, session.id, 'second');

        expect(first.threadId).toBeDefined();
        expect(second.threadId).toBeDefined();
        expect(first.threadId).not.toBe(second.threadId);

        const warm = lanesOf(store, session.id);

        expect(warm).toHaveLength(2);
        expect(warm.map((lane) => lane.busy)).toEqual([false, false]);

        const before = first.tools;

        expect(before).toContain(CORE);
        expect(second.tools).toEqual(before);

        const pushes = watchPushes(store);
        const beforeState = authorityOf(store, session.id).toolStateNow();

        // THE OPERATOR DOOR, through the route: the exact request the tool pane sends.
        const off = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/${CORE}`, { enabled: false });

        expect(off.status).toBe(200);
        // The envelope says what the kernel did (a gate change, not a source change) and the ROW
        // states the switch the frame carries — one figure, two readers.
        expect(off.body.registration).toMatchObject({ name: CORE, created: false, replaced: false });
        expect(await rowOf(api, session.id, CORE)).toMatchObject({ name: CORE, enabled: false, visibility: 'core' });

        // ONE frame, for THIS session, carrying the canonical state the route just wrote — not the
        // route's guess of it. And the delta is exactly the one name, on the axis only a core name
        // uses: `enabled` is byte-identical, so a frame that could carry only `enabled` (pre-R5b)
        // would have said nothing here at all.
        const canonical = authorityOf(store, session.id).toolStateNow();

        expect(pushes).toEqual([{ sessionId: session.id, tools: canonical }]);
        expect(canonical.withheld).toContain(CORE);
        expect(beforeState.withheld).not.toContain(CORE);
        expect(canonical.enabled).toEqual(beforeState.enabled);

        // TURN 3, the conversation the toggle did NOT come from, on the SAME worker: the epoch is
        // the proof, because a reclaimed-and-rebuilt lane would report a new one and prove only the
        // blueprint path.
        const onFirst = await runTurn(store, provider, session.id, 'third', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(onFirst.tools).not.toContain(CORE);
        expect(onFirst.tools).toEqual(before.filter((name) => name !== CORE));

        // TURN 4, the OTHER warm lane — the one that never sent the request that triggered the push.
        const onSecond = await runTurn(store, provider, session.id, 'fourth', second.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(onSecond.tools).toEqual(onFirst.tools);

        // A SECOND CLICK of the same switch. The route pushes UNCONDITIONALLY (a repeat click is how
        // an operator heals a lane that missed a frame), so this posts a second frame whose payload
        // is byte-identical to the first: the reconcile is wholesale and convergent, and a lane that
        // applies the same state twice cannot land anywhere other than where it already is.
        const clicked = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/${CORE}`, { enabled: false });

        expect(clicked.status).toBe(200);
        expect(pushes).toHaveLength(2);
        expect(pushes[1]).toEqual(pushes[0]);

        const repeated = await runTurn(store, provider, session.id, 'fifth', first.threadId);

        expect(repeated.tools).toEqual(onFirst.tools);

        // THE RE-ENABLE, same door, same warm lane: the name comes back in its original position and
        // no neighbour was disturbed by the round trip.
        const on = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/${CORE}`, { enabled: true });

        expect(on.status).toBe(200);
        expect(on.body.registration).toMatchObject({ name: CORE, created: false, replaced: false });
        expect(await rowOf(api, session.id, CORE)).toMatchObject({ name: CORE, enabled: true, visibility: 'core' });
        expect(pushes).toHaveLength(3);

        const reEnabled = await runTurn(store, provider, session.id, 'sixth', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(reEnabled.tools).toEqual(before);

        // THE SAME DOOR ON A SECOND CORE NAME, because the acceptance names `write`: it is the same
        // class as `glob` — a `visibility: 'core'` declaration of the shared toolbox that holds NO
        // cap slot (probe: the fixture's capped set is 23 names and contains neither), so the
        // withheld axis of this frame is the only thing on the wire that can withdraw it from a
        // replica. Both directions, same warm lane, exact lists.
        const WRITE = 'write';

        expect(reEnabled.tools).toContain(WRITE);

        const writeOff = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/${WRITE}`, { enabled: false });

        expect(writeOff.status).toBe(200);
        expect(await rowOf(api, session.id, WRITE)).toMatchObject({ name: WRITE, enabled: false });

        const withoutWrite = await runTurn(store, provider, session.id, 'seven', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(withoutWrite.tools).not.toContain(WRITE);
        // Exactly one name gone, every survivor in its original position.
        expect(withoutWrite.tools).toEqual(before.filter((name) => name !== WRITE));

        const writeOn = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/${WRITE}`, { enabled: true });

        expect(writeOn.status).toBe(200);
        expect(await rowOf(api, session.id, WRITE)).toMatchObject({ name: WRITE, enabled: true });

        const withWrite = await runTurn(store, provider, session.id, 'eight', first.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(withWrite.tools).toEqual(before);
        // FIVE accepted writes, FIVE frames, one per request that moved the switch — and each payload
        // is the canonical state as of its own write, which is why the round trip on `glob` cannot
        // leak into the one on `write`. The `withheld` order is the kernel's own (../harness.ts:13165
        // sorts on every read); the `enabled` axis never moves for a name with no cap slot.
        const withheldWith = (names: string[]): string[] => [...names].sort((left, right) => left.localeCompare(right));

        expect(pushes).toHaveLength(5);
        expect(pushes.map((entry) => entry.sessionId)).toEqual([session.id, session.id, session.id, session.id, session.id]);
        expect(pushes[3]!.tools.withheld).toEqual(withheldWith([...beforeState.withheld, WRITE]));
        expect(pushes[3]!.tools.enabled).toEqual(beforeState.enabled);
        expect(pushes[4]!.tools).toEqual(beforeState);
    }, 300_000);

    it('reconciles the SIBLING lane of the conversation whose model made the switch', async () => {
        // THE MODEL DOOR, end to end. One conversation's agent switches a tool off for ITSELF (the
        // kernel scopes a switch to the conversation's harness — R5a), the authority pushes the
        // session-wide frame through the hook ../sessions.ts wires, and a DIFFERENT warm lane of the
        // same session stops declaring the name on its very next request. This is the case the
        // blueprint cannot cover: the sibling lane is already up and was never restarted.
        const { store, provider } = await openLanePair(['solo', 'asked', 'sibling', 'after']);
        const session = await store.create('flaky');

        const mine = await runTurn(store, provider, session.id, 'solo');
        const theirs = await runTurn(store, provider, session.id, 'other');

        const warm = lanesOf(store, session.id);

        expect(warm).toHaveLength(2);
        expect(mine.threadId).toBeDefined();
        expect(theirs.threadId).toBeDefined();
        expect(theirs.threadId).not.toBe(mine.threadId);

        const before = theirs.tools;

        expect(before).toContain('timeNow');

        const pushes = watchPushes(store);

        // The routed frame one lane raises when its model calls `toolManage disable`. `timeNow` is
        // the searchable name: it holds a cap slot, so the switch moves BOTH lists, and the sibling
        // lane's declared set is where that becomes visible. The epoch is a live lane of THIS
        // session (the host's own rows are the proof), and a switch the authority applies is
        // session-scoped by construction — one canonical harness per conversation, R5a.
        const authority = authorityOf(store, session.id);
        const beforeState = authority.toolStateNow();
        const answer = await authority.answer(
            warm[0].epoch,
            routed('manageTool', { operation: 'disable', name: 'timeNow' }, mine.threadId!)
        );

        expect((answer.value as { changed?: boolean }).changed).toBe(true);

        const canonical = authority.toolStateNow();

        // The store's own wiring: authority hook → host.broadcastTools, addressed to this session,
        // payload read from canonical state. One frame, not two — the requesting lane also gets the
        // state back in its reply (`answer.sync`), which is the fast path ./lane-worker-loop.ts
        // already applies.
        expect(pushes).toEqual([{ sessionId: session.id, tools: canonical }]);
        expect(canonical.enabled).toEqual(beforeState.enabled.filter((name) => name !== 'timeNow'));
        expect(canonical.withheld).toContain('timeNow');

        // The sibling's NEXT turn, with no frame of its own: it held `timeNow` and it no longer
        // declares it, and nothing else on its replica moved.
        const after = await runTurn(store, provider, session.id, 'sibling', theirs.threadId);

        expect(lanesOf(store, session.id)).toEqual(warm);
        expect(after.tools).toEqual(before.filter((name) => name !== 'timeNow'));
    }, 300_000);

    it('answers 200 for a session that has no lane, and the switch still lands on the lane born after it', async () => {
        // The other half of "never fail the operator": a one-way push to zero lanes is RECEIVED BY
        // NOBODY, so the route must not treat that as a fault — and the toggle must still reach the
        // thread that starts later. That is not the frame doing it: it is the SAME two lists riding
        // the blueprint (./protocol.ts `LaneBlueprint.withheldTools`), which is why one read at the
        // store's door feeds both carriers.
        const { store, api, provider } = await openLanePair(['late']);
        const session = await store.create('flaky');

        // No host at all: an operator toggle made before this store ever ran a worker turn. The
        // store's own call site is `this.host?.` for exactly this state.
        expect(hostOf(store)).toBeUndefined();
        expect(lanesOf(store, session.id)).toEqual([]);

        const off = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/glob`, { enabled: false });

        expect(off.status).toBe(200);
        expect(off.body.registration).toMatchObject({ name: 'glob', created: false, replaced: false });
        expect(await rowOf(api, session.id, 'glob')).toMatchObject({ name: 'glob', enabled: false });

        // THE LANE BORN AFTER THE TOGGLE. The push reached nobody — there was nobody to reach — and
        // the switch still lands, because the same two lists ride the blueprint
        // (./protocol.ts `LaneBlueprint.withheldTools`). A thread started after the operator's click
        // is a thread of that session too.
        const served = await runTurn(store, provider, session.id, 'late');

        expect(served.tools).not.toContain('glob');
        expect(lanesOf(store, session.id)).toHaveLength(1);
    }, 240_000);

    it('answers 200 when the broadcast itself explodes, and a repeat click heals the lane that missed it', async () => {
        // THE ROUTE'S FAILURE TOLERANCE, all the way down: not "there were no lanes", but "the post
        // itself threw" — a thread that exited between the `closed` check and the `postMessage`, a
        // payload that will not clone. The switch is canonical the moment the kernel accepts it, so a
        // push that explodes is a LOST PUSH and must not become a 500 telling the operator the
        // toggle failed (../sessions.ts `pushToolState` swallows it and reports it on stderr).
        const { store, api, provider } = await openLanePair(['warm', 'healed']);
        const session = await store.create('flaky');

        await runTurn(store, provider, session.id, 'warm');

        const host = hostOf(store);

        expect(host).toBeDefined();

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {
            /* the store's own stderr convention, asserted below rather than printed */
        });

        vi.spyOn(host!, 'broadcastTools').mockImplementation(() => {
            throw new Error('the lane thread exited mid-post');
        });

        const off = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/glob`, { enabled: false });

        expect(off.status).toBe(200);
        expect(off.body.registration).toMatchObject({ name: 'glob', created: false, replaced: false });
        expect(await rowOf(api, session.id, 'glob')).toMatchObject({ name: 'glob', enabled: false });

        // ONE report, naming the session and the reason: the lost push is a fact the server states,
        // not a silence. Anything else that ever throws in there is reported the same way.
        const reported = errors.mock.calls.filter((entry) => String(entry[0]).includes('did not reach its lanes'));

        expect(reported).toHaveLength(1);
        expect(String(reported[0]![0])).toContain(`session "${session.id}"`);
        expect(String(reported[0]![0])).toContain('the lane thread exited mid-post');

        errors.mockRestore();
        vi.restoreAllMocks();

        // THE HEALING, which is why the operator's door is UNCONDITIONAL while the model's door is
        // gated: a second click on the same switch answers 200 with the same state and pushes the
        // frame again — and this time the warm lane, whose worker is still the same one, lands on it.
        const healed = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/glob`, { enabled: false });

        expect(healed.status).toBe(200);

        const served = await runTurn(store, provider, session.id, 'healed');

        expect(served.tools).not.toContain('glob');
    }, 240_000);

    it('answers 200 when the lane it is pushing to is gone, and the session keeps serving turns', async () => {
        // A lane reclaimed between the write and the post: `broadcastTools` skips a closed lane
        // (./lane-host.ts), and anything else that throws is a LOST PUSH, not a lost write — the
        // operator's switch is canonical the moment the kernel accepts it, and an HTTP 500 would
        // tell them the opposite.
        const { store, api, provider } = await openLanePair(['warm', 'after']);
        const session = await store.create('flaky');

        await runTurn(store, provider, session.id, 'warm');

        expect(lanesOf(store, session.id)).toHaveLength(1);

        const host = hostOf(store);

        expect(host).toBeDefined();

        // The lane goes away under the session — the reclaim, a crash, an operator closing the
        // conversation. The session itself stays live.
        host!.closeSession(session.id, 'test: lane gone');

        expect(lanesOf(store, session.id)).toEqual([]);

        const off = await callRoute(api, 'PATCH', `${MOUNT}/sessions/${session.id}/tools/glob`, { enabled: false });

        expect(off.status).toBe(200);
        expect(off.body.registration).toMatchObject({ name: 'glob', created: false, replaced: false });

        // The session is still a session: the next turn builds a lane, and that lane knows the
        // switch (the blueprint carries it) whether or not the frame ever reached the lane that died.
        const served = await runTurn(store, provider, session.id, 'after');

        expect(served.tools).not.toContain('glob');
    }, 240_000);
});
