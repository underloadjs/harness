// Per-agent activity reduction for the tile ring.
//
// The ring must mean "this agent is working in the turn on screen". These tests
// pin the accept/reject rules as exact sets:
//   - start activates; text/reasoning/tool/usage events reactivate (a `usage`
//     report arrives mid-run, before the tools the agent asked for have run);
//   - done/error remove ONLY that agent (delegated siblings keep spinning) —
//     except a done with calls still in flight, which keeps the agent lit (R6);
//   - a wakeup reactivates the agent that resumed because background work
//     progressed;
//   - only a RUNNING recorded turn contributes activity, so replaying history can
//     never light an old tile;
//   - renderAgents rebuilds read the live set, and painting sets/removes both
//     data-activity and aria-busy.
//
// T3 (frontend liveness honesty) adds the GRADED fold: the same membership, plus the
// age of each agent's newest JOURNALED frame, which is what lets the UI tell a run that
// is silent (a model composing a tool call sends no frames at all) from one that is
// streaming. A graded name keeps `aria-busy` and loses only the sweeping ring.
//
// T4 WIRES that grade into the live shell (main.ts): the display wire carries no event
// times, so the live grades come from per-agent RECEIPT stamps kept next to the active set.
// The last describe block pins that fold — it is the difference between the quiet-ring CSS
// existing and the quiet-ring CSS ever being painted.

import type { HarnessEvent, SessionTurn } from '../../server/protocol';
import type { TurnDisplay, TurnDisplayOp, TurnSection } from '../../shared/turn-display';
import {
    activityOfTurn,
    activityOfTurns,
    applyActivity,
    gradeActivityFromStamps,
    gradeActivityOfTurn,
    gradeActivityOfTurns,
    newestAgentStampsOf,
    paintActivity,
    stampActivityFromOps,
    syncActivityStamps
} from './activity';
import { createAgentRow } from './agents';

const start = (agent: string): HarnessEvent => ({ type: 'start', agent, model: 'm1' });
const text = (agent: string): HarnessEvent => ({ type: 'text', agent, delta: 'x' });
const reasoning = (agent: string): HarnessEvent => ({ type: 'reasoning', agent, delta: 'think' });
const toolCall = (agent: string): HarnessEvent => ({
    type: 'tool_call',
    agent,
    call: { id: 'c1', name: 'read', arguments: '{}' }
});
const toolResult = (agent: string): HarnessEvent => ({
    type: 'tool_result',
    agent,
    name: 'read',
    content: 'ok',
    isError: false
});
const done = (agent: string): HarnessEvent => ({
    type: 'done',
    agent,
    message: {
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: [],
        model: 'm1',
        stopReason: 'stop'
    }
});
const failed = (agent: string): HarnessEvent => ({ type: 'error', agent, error: { message: 'boom' } });
// Per-request token accounting: emitted mid-run (right after the request settles,
// before its tools run), so it must keep the agent's ring lit.
const usage = (agent: string): HarnessEvent => ({
    type: 'usage',
    agent,
    usage: { input: 10, output: 5, total: 15 }
});

// R6 additive frames. A response can complete while its own calls still run, and a
// `wakeup` resumes the agent; both must be readable before the `HarnessEvent` union
// re-exports them, hence the `unknown` cast.
const doneWithPending = (agent: string, pending: unknown[]): HarnessEvent =>
    ({
        type: 'done',
        agent,
        message: { role: 'assistant', content: '', reasoning: '', toolCalls: [], model: 'm1', stopReason: 'stop' },
        pending
    }) as unknown as HarnessEvent;

const wakeup = (agent: string, pending: unknown[] = []): HarnessEvent =>
    ({ type: 'wakeup', agent, reason: 'pending-tools', pending }) as unknown as HarnessEvent;

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'running',
    startedAt: 1000,
    updatedAt: 2000,
    events: [],
    ...overrides
});

const reduce = (events: readonly HarnessEvent[]): string[] => {
    const active = new Set<string>();
    for (const event of events) applyActivity(active, event);
    return [...active];
};

describe('applyActivity', () => {
    it('activates on start and every content event', () => {
        expect(reduce([start('instruct')])).toEqual(['instruct']);
        expect(reduce([start('instruct'), text('instruct')])).toEqual(['instruct']);
        expect(reduce([text('instruct')])).toEqual(['instruct']);
        expect(reduce([reasoning('instruct')])).toEqual(['instruct']);
        expect(reduce([toolCall('instruct')])).toEqual(['instruct']);
        expect(reduce([toolResult('instruct')])).toEqual(['instruct']);
        expect(reduce([usage('instruct')])).toEqual(['instruct']);
    });

    it('adds the agent to an empty set on a usage event', () => {
        const active = new Set<string>();
        applyActivity(active, usage('instruct'));
        expect(active).toEqual(new Set(['instruct']));
    });

    it('removes only the agent that finished, not a delegated sibling', () => {
        expect(reduce([start('instruct'), toolCall('instruct'), start('helper'), text('helper')])).toEqual([
            'instruct',
            'helper'
        ]);
        expect(reduce([start('instruct'), start('helper'), done('helper')])).toEqual(['instruct']);
        expect(reduce([start('instruct'), start('helper'), failed('instruct')])).toEqual(['helper']);
    });

    it('reactivates an agent after an intermediate done (a second agent run)', () => {
        expect(reduce([start('instruct'), done('instruct'), text('instruct')])).toEqual(['instruct']);
    });

    it('does not resurrect a finished agent when a usage follows the done', () => {
        // A usage is emitted mid-run (before the tools it asked for run), so a usage
        // that lands after done is out of order; the reducer follows event order, so
        // the trailing done still leaves the set empty.
        expect(reduce([start('instruct'), usage('instruct'), done('instruct')])).toEqual([]);
    });

    it('removes only the agent whose done follows its usage', () => {
        const active = new Set<string>(['instruct', 'helper']);
        applyActivity(active, usage('instruct'));
        applyActivity(active, done('instruct'));
        expect(active).toEqual(new Set(['helper']));
    });

    it('keeps an agent active when its done still has calls in flight', () => {
        expect(
            reduce([
                start('instruct'),
                toolCall('instruct'),
                doneWithPending('instruct', [{ callId: 'c1', name: 'read', elapsedMs: 1200 }])
            ])
        ).toEqual(['instruct']);

        // A present-but-empty list IS an idle agent: the response ended the work.
        expect(reduce([start('instruct'), doneWithPending('instruct', [])])).toEqual([]);
    });

    it('activates an agent on a wakeup frame', () => {
        expect(reduce([wakeup('instruct')])).toEqual(['instruct']);
        // The ring comes back after the interim done, without a new start/text event.
        expect(
            reduce([
                start('instruct'),
                doneWithPending('instruct', [{ callId: 'c1', name: 'read', elapsedMs: 1 }]),
                wakeup('instruct', [{ callId: 'c1', name: 'read', elapsedMs: 1200 }])
            ])
        ).toEqual(['instruct']);
    });
});

describe('activityOfTurn / activityOfTurns', () => {
    it('derives activity from a still-running turn only', () => {
        const running = turn({ events: [start('instruct'), text('instruct')] });
        expect([...activityOfTurn(running)]).toEqual(['instruct']);
    });

    it('never lights a settled turn when replaying history', () => {
        for (const status of ['done', 'error', 'cancelled'] as const) {
            expect([...activityOfTurn(turn({ status, events: [start('instruct'), text('instruct')] }))]).toEqual(
                []
            );
        }

        // A finished turn with an active-looking final event is still history:
        // only the status decides.
        const finished = turn({ status: 'done', events: [start('instruct')] });
        expect([...activityOfTurn(finished)]).toEqual([]);
    });

    it('unions only the running turns of a snapshot', () => {
        const older = turn({ id: 't1', status: 'done', events: [start('instruct'), text('instruct')] });
        const current = turn({ id: 't2', index: 1, events: [start('helper')] });

        expect([...activityOfTurns([older, current])]).toEqual(['helper']);
        expect([...activityOfTurns([older])]).toEqual([]);
    });

    it('keeps a usage-reporting agent lit while its turn is running', () => {
        // Mid-run usage (the request settled, its tools have not run yet) must keep
        // the tile spinning; the same events on a settled turn stay history.
        const usageEvents = [start('instruct'), usage('instruct')];

        const running = turn({ events: usageEvents });
        expect(activityOfTurns([running])).toEqual(new Set(['instruct']));

        const settled = turn({ status: 'done', events: usageEvents });
        expect(activityOfTurns([settled])).toEqual(new Set<string>());
    });

    it('leaves an empty set for a finished turn whose last event is a done', () => {
        const running = turn({ events: [start('instruct'), done('instruct')] });
        expect([...activityOfTurn(running)]).toEqual([]);
    });
});

describe('paintActivity', () => {
    const row = (activity: readonly string[]): HTMLElement =>
        createAgentRow({
            members: ['instruct', 'helper'],
            entry: 'instruct',
            // The row states a rank per member; this test only paints activity rings, so the
            // ladder is the plain two-rank team the tile would show anyway.
            ranks: { instruct: 'A', helper: 'B' },
            agents: [],
            editable: true,
            activity,
            onAdd: () => undefined,
            onRemove: () => undefined
        });

    it('marks only the active tiles and clears the rest on a repaint', () => {
        const element = row(['instruct']);
        document.body.replaceChildren(element);

        const tiles = [...element.querySelectorAll<HTMLElement>('.agent-tile')];
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual(['active', undefined]);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual(['true', null]);

        // A `done` for instruct removes exactly its ring.
        paintActivity(element, new Set(['helper']));
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual([undefined, 'active']);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, 'true']);

        paintActivity(element, new Set<string>());
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual([undefined, undefined]);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, null]);
    });

    it('preserves a live set across a row rebuild', () => {
        // What renderAgents does: the set lives on the instance, the rebuilt row
        // reads it, so a PATCH/snapshot repaint never drops a working agent.
        const active = new Set(['helper']);
        document.body.replaceChildren(row([...active]));

        expect(
            document.querySelector<HTMLElement>('.agent-tile[data-agent="helper"]')?.dataset.activity
        ).toBe('active');
        expect(
            document.querySelector<HTMLElement>('.agent-tile[data-agent="instruct"]')?.dataset.activity
        ).toBeUndefined();
    });
});

describe('N3 interaction and branch frames', () => {
    const request = {
        requestId: 'req-1',
        question: 'Which file?',
        recommended: 'a',
        options: [{ id: 'a', label: 'Alpha' }],
        allowCustom: true as const
    };
    const actionRequest = (agent: string): HarnessEvent => ({
        type: 'action_request',
        agent,
        callId: 'call-1',
        request
    });
    const actionAnswer = (agent: string): HarnessEvent => ({
        type: 'action_answer',
        agent,
        requestId: 'req-1',
        answer: {
            requestId: 'req-1',
            choice: { kind: 'option', optionId: 'a' },
            source: 'auto'
        }
    });
    const branch = (branchId: string, kind: 'fork' | 'autoanswer', agent: string) => ({
        branchId,
        kind,
        agent,
        rank: 'B' as const,
        forkDepth: 1,
        model: 'm1',
        tools: []
    });
    const branchStart = (branchId: string, kind: 'fork' | 'autoanswer', agent: string): HarnessEvent => ({
        type: 'branch_start',
        agent,
        branch: branch(branchId, kind, agent)
    });
    const branchEnd = (branchId: string, agent: string): HarnessEvent => ({
        type: 'branch_end',
        agent,
        branchId,
        status: 'completed'
    });

    it('keeps the asking agent active while a question is pending and after it is answered', () => {
        expect(reduce([start('instruct'), actionRequest('instruct')])).toEqual(['instruct']);
        expect(reduce([start('instruct'), actionRequest('instruct'), actionAnswer('instruct')])).toEqual([
            'instruct'
        ]);
    });

    it('lights the branch agent on branch_start and leaves the requester ring alone on branch_end', () => {
        expect(reduce([start('instruct'), branchStart('b1', 'fork', 'helper')])).toEqual([
            'instruct',
            'helper'
        ]);

        // `branch_end` names the REQUESTER (the source of the fork), not the branch
        // agent; it must not unfinish the source's still-running ring. The branch's
        // own done settles the branch agent.
        const ended = reduce([
            start('instruct'),
            branchStart('b1', 'fork', 'helper'),
            branchEnd('b1', 'instruct')
        ]);
        expect(ended).toEqual(['instruct', 'helper']);
        expect([...ended].sort()).toEqual(['helper', 'instruct']);

        expect(
            reduce([
                start('instruct'),
                branchStart('b1', 'fork', 'helper'),
                branchEnd('b1', 'instruct'),
                done('helper')
            ])
        ).toEqual(['instruct']);
    });

    it('contributes no activity for a settled replay even with N3 frames', () => {
        const settled = turn({
            status: 'done',
            events: [start('instruct'), actionRequest('instruct'), branchStart('b1', 'fork', 'helper')]
        });
        expect([...activityOfTurn(settled)]).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T3 — frontend liveness honesty: the GRADED side of the fold.
// ---------------------------------------------------------------------------
//
// `applyActivity` is event-latched, so an agent whose run has said NOTHING for a
// minute still owned a sweeping ring (the incident: a model composing a tool call
// emits no frames at all, and 62s of silence looked like a hang). Grading adds the
// journaled clock WITHOUT touching membership: the same names, plus how loudly the UI
// may say so. `now` is an argument (not `Date.now()`), so every age below is exact and
// the fold stays pure.
describe('graded activity (T3 liveness honesty)', () => {
    const T = 1_700_000_000_000;

    // A branch frame names the agent it FORKS, which is not its sender — the grade
    // follows the same attribution `applyActivity` uses, so this is pinned explicitly.
    const forkStart = (agent: string): HarnessEvent =>
        ({
            type: 'branch_start',
            agent: 'instruct',
            branch: { id: 'b1', kind: 'fork', agent }
        }) as unknown as HarnessEvent;

    it('grades a name by the age of its own newest journaled frame', () => {
        const running = turn({
            events: [start('instruct'), text('instruct')],
            eventTimes: [T - 90_000, T - 9_000]
        });

        // 9s since the last frame: past the 5s presentation threshold, not the 30s one
        // (ui/time.ts QUIET_AFTER_MS / SILENT_AFTER_MS).
        expect([...gradeActivityOfTurn(running, T).entries()]).toEqual([['instruct', 'quiet']]);

        // 4s: frames are still arriving at the cadence the tile can honestly claim.
        const fresh = turn({ events: [start('instruct')], eventTimes: [T - 4_000] });
        expect([...gradeActivityOfTurn(fresh, T).entries()]).toEqual([['instruct', 'active']]);

        // 30s on the nose: the stronger grade, which is what the ring renders as a
        // still, dimmer arc (styles.css `[data-activity='silent']`).
        const long = turn({ events: [start('instruct')], eventTimes: [T - 30_000] });
        expect([...gradeActivityOfTurn(long, T).entries()]).toEqual([['instruct', 'silent']]);

        // The newest frame wins: a 90s-old start may not quiet an agent that spoke 9s ago.
        expect([...gradeActivityOfTurn(running, T).entries()]).toEqual([['instruct', 'quiet']]);
    });

    it('never claims silence without a stamp to measure from', () => {
        // A recording from before the server stamped per-event times: the fold may say
        // the agent is working (it always could) but NOT that it has been quiet.
        const unstamped = turn({ events: [start('instruct'), text('instruct')] });
        expect([...gradeActivityOfTurn(unstamped, T).entries()]).toEqual([['instruct', 'active']]);

        // A partially stamped record grades on the newest stamp that EXISTS.
        const partial = turn({
            events: [start('instruct'), text('instruct')],
            eventTimes: [T - 9_000, undefined]
        });
        expect([...gradeActivityOfTurn(partial, T).entries()]).toEqual([['instruct', 'quiet']]);
    });

    it('grades exactly the names the ungraded fold lights — and nothing for a settled turn', () => {
        const events = [start('instruct'), start('helper'), done('instruct')];
        const running = turn({ events, eventTimes: events.map((_event, index) => T - 9_000 + index) });

        // Membership parity: grading cannot add or drop a worker.
        expect([...gradeActivityOfTurn(running, T).keys()].sort()).toEqual([...activityOfTurn(running)]);
        expect([...gradeActivityOfTurn(running, T).entries()].sort()).toEqual([
            ['helper', 'quiet']
        ]);

        // A settled turn contributes nothing, graded or not (the existing status guard).
        const settled = turn({ status: 'done', events, eventTimes: events.map(() => T - 41_000) });
        expect([...gradeActivityOfTurn(settled, T)]).toEqual([]);
    });

    it('grades a branch by the branch agent, never by its sender', () => {
        // `branch_start` comes FROM the requester and lights the FORKED agent, so the
        // 9s-old branch frame may only grade `helper`. The requester's own frame is
        // recent, and it is what the parent tile is waiting on — grading it quiet from a
        // branch stamp would be a new lie.
        const running = turn({
            events: [start('instruct'), forkStart('helper')],
            eventTimes: [T - 1_000, T - 9_000]
        });

        expect([...gradeActivityOfTurn(running, T).entries()].sort()).toEqual([
            ['helper', 'quiet'],
            ['instruct', 'active']
        ]);
    });

    it('takes the loudest answer across turns, because any recent frame is evidence of work', () => {
        const stale = turn({
            id: 't1',
            events: [start('instruct')],
            eventTimes: [T - 62_000]
        });
        const recent = turn({
            id: 't2',
            index: 1,
            events: [start('instruct')],
            eventTimes: [T - 1_000]
        });

        expect([...gradeActivityOfTurns([stale, recent], T).entries()]).toEqual([['instruct', 'active']]);
        expect([...gradeActivityOfTurns([stale], T).entries()]).toEqual([['instruct', 'silent']]);
    });

    it('paints a quiet name as a still ring that is STILL marked busy', () => {
        const element = createAgentRow({
            members: ['instruct', 'helper'],
            entry: 'instruct',
            ranks: { instruct: 'A', helper: 'B' },
            agents: [],
            editable: true,
            activity: ['instruct', 'helper'],
            onAdd: () => undefined,
            onRemove: () => undefined
        });
        document.body.replaceChildren(element);

        const tiles = [...element.querySelectorAll<HTMLElement>('.agent-tile')];

        // The quiet claim is WEAKER, not different: the run is unfinished, so `aria-busy`
        // stays `true` and only the sweeping grade is withdrawn. An assistive reader must
        // not hear "idle" for a turn the server still reports running.
        paintActivity(element, new Set(['instruct', 'helper']), new Map([['instruct', 'quiet']]));
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual(['quiet', 'active']);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual(['true', 'true']);

        // A frame lands: the grade disappears and the ring sweeps again. Grading is
        // optional by design — a caller with no clock paints exactly the old 'active'.
        paintActivity(element, new Set(['instruct', 'helper']));
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual(['active', 'active']);

        // Settled: both the grade and the busy flag go, as before.
        paintActivity(element, new Set<string>());
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual([undefined, undefined]);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, null]);
    });
});

// ---------------------------------------------------------------------------
// T4 — the LIVE half of the same honesty: per-agent receipt stamps, and the
// grades main.ts paints them into.
// ---------------------------------------------------------------------------
//
// `gradeActivityOfTurn(s)` above measures the age off a recorded `SessionTurn.eventTimes`.
// The live app has no such figure: it folds `display.ops` into a `TurnSummary` document, so
// the only clock available is WHEN A FRAME REACHED THIS VIEW — the same rule the turn board
// applies in `frameStampOf` (ui/turns.ts:822). These cases pin that fold, because it is
// what makes `.agent-tile[data-activity='quiet']` (styles.css:3978) reachable at all:
// before T4 every ring repaint happened on an arriving frame, i.e. never during the silence
// the grade describes.
describe('live grading from per-agent receipt stamps (T4 ring wiring)', () => {
    const NOW = 1_700_000_000_000;

    const section = (overrides: Partial<TurnSection> = {}): TurnSection => ({
        id: 't1:0',
        rank: 'A',
        agent: 'instruct',
        agentLabel: 'IT4',
        state: 'streaming',
        nodes: [],
        ...overrides
    });

    const displayOf = (sections: TurnSection[]): TurnDisplay =>
        ({ turnId: 't1', sections }) as unknown as TurnDisplay;

    const rowOp = (activeAgents: string[]): TurnDisplayOp =>
        ({
            op: 'turn',
            turnId: 't1',
            summary: {
                id: 't1',
                index: 0,
                prompt: 'go',
                status: 'running',
                state: 'streaming',
                updatedAt: NOW,
                sectionCount: 1,
                stepCount: 0,
                activeAgents,
                blocks: []
            }
        }) as TurnDisplayOp;

    const progressOp = (sectionId: string): TurnDisplayOp => ({
        op: 'section:set',
        turnId: 't1',
        sectionId,
        patch: { toolProgress: { phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6512 } }
    });

    it('grades on the tile\u2019s own thresholds, and never invents a silence it cannot measure', () => {
        const active = new Set(['instruct']);

        // 4.999s: still inside the live window (QUIET_AFTER_MS, ui/time.ts:52).
        expect([
            ...gradeActivityFromStamps(active, new Map([['instruct', NOW - 4_999]]), NOW).entries()
        ]).toEqual([['instruct', 'active']]);

        // 5.000s exactly, and the stronger word at exactly 30.000s.
        expect([
            ...gradeActivityFromStamps(active, new Map([['instruct', NOW - 5_000]]), NOW).entries()
        ]).toEqual([['instruct', 'quiet']]);
        expect([
            ...gradeActivityFromStamps(active, new Map([['instruct', NOW - 30_000]]), NOW).entries()
        ]).toEqual([['instruct', 'silent']]);

        // No stamp at all is UNKNOWN, not silent — the same rule the journaled fold and the
        // tile follow. A stamp in the future (a server clock ahead of this one) is a FRESH
        // frame, never a silence.
        expect([...gradeActivityFromStamps(active, new Map(), NOW).entries()]).toEqual([
            ['instruct', 'active']
        ]);
        expect([
            ...gradeActivityFromStamps(active, new Map([['instruct', NOW + 250]]), NOW).entries()
        ]).toEqual([['instruct', 'active']]);

        // A grade never widens the claim about WHO works: only names in `active` are graded.
        expect([...gradeActivityFromStamps(new Set<string>(), new Map([['instruct', NOW - 62_000]]), NOW).entries()]).toEqual([]);
    });

    it('credits only the agents an ops frame addresses, and never the row op', () => {
        const stamps = new Map<string, number>();
        const tree = displayOf([
            section(),
            section({ id: 't1:1', parentSectionId: 't1:0', rank: 'B', agent: 'helper' })
        ]);

        // A progress patch on the delegated lane credits the LANE, not the turn's own agent:
        // crediting everyone the row names is how a 60s composition would keep a stale ring
        // sweeping forever.
        stampActivityFromOps(stamps, tree, [rowOp(['instruct', 'helper']), progressOp('t1:1')], NOW);
        expect([...stamps.entries()]).toEqual([['helper', NOW]]);

        // `section:open` names its agent on the op itself, so it credits without a lookup.
        stampActivityFromOps(
            stamps,
            tree,
            [{ op: 'section:open', turnId: 't1', section: section() }],
            NOW + 1_000
        );
        expect([...stamps.entries()].sort()).toEqual([
            ['helper', NOW],
            ['instruct', NOW + 1_000]
        ]);

        // A display this client does not hold yet resolves to nothing, and an empty frame
        // writes nothing: no stamp is ever invented from an absent tree.
        const cold = new Map<string, number>();
        stampActivityFromOps(cold, undefined, [rowOp(['instruct'])], NOW);
        stampActivityFromOps(cold, tree, [], NOW);
        expect([...cold.entries()]).toEqual([]);
    });

    it('takes the seed from journaled stamps, prefers the row stamp, and prunes a name that left', () => {
        // The agent's own section is older than the row: the row is the stronger figure, and
        // it is exactly what the tile seeds its quiet line from (ui/turns.ts:1021), so the
        // two affordances cannot disagree after a reload.
        expect([
            ...newestAgentStampsOf([section({ startedAt: NOW - 700 })], NOW - 400).entries()
        ]).toEqual([['instruct', NOW - 400]]);
        expect([...newestAgentStampsOf([section({ startedAt: NOW - 700 })], NOW - 900).entries()]).toEqual([
            ['instruct', NOW - 700]
        ]);
        // A section with no stamps carries no age, and a settled document simply has nothing
        // to say.
        expect([...newestAgentStampsOf([section()]).entries()]).toEqual([]);

        const stamps = new Map([['helper', NOW - 62_000]]);
        const journaled = newestAgentStampsOf([section({ startedAt: NOW - 41_000 })], NOW - 41_000);

        // `helper` left the active set (its `done` landed): its minutes-old age must NOT be
        // inherited the next time it wakes, so it is dropped. `instruct` arrives with no
        // stamp and takes the journaled age — a reload of a run that has been silent for 41s
        // goes quiet immediately instead of sweeping for 5 more seconds.
        syncActivityStamps(stamps, new Set(['instruct']), journaled, NOW);
        expect([...stamps.entries()]).toEqual([['instruct', NOW - 41_000]]);

        // A name nothing journals an age for takes NOW: unknown is never quiet.
        syncActivityStamps(stamps, new Set(['instruct', 'late']), new Map(), NOW + 1_000);
        expect([...stamps.entries()]).toEqual([
            ['instruct', NOW - 41_000],
            ['late', NOW + 1_000]
        ]);

        // And the grade that comes out of it, painted: a quiet name keeps `aria-busy` and
        // loses only the sweep.
        const element = createAgentRow({
            members: ['instruct'],
            entry: 'instruct',
            ranks: { instruct: 'A' },
            agents: [],
            editable: true,
            activity: ['instruct'],
            onAdd: () => undefined,
            onRemove: () => undefined
        });
        document.body.replaceChildren(element);

        paintActivity(
            element,
            new Set(['instruct']),
            gradeActivityFromStamps(new Set(['instruct']), stamps, NOW + 1_000)
        );

        const tile = element.querySelector<HTMLElement>('.agent-tile');
        expect(tile?.dataset.activity).toBe('silent');
        expect(tile?.getAttribute('aria-busy')).toBe('true');
    });
});
