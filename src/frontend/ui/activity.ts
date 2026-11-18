// Per-agent activity: which agent tiles draw the rotating border.
//
// The harness emits ONE `HarnessEvent` stream and every event names its agent
// (`agent`). The UI keeps a live set of agent names per *instance* (and therefore
// per selected harness view) and updates it with this reducer:
//
//   - `start`                              → that agent is active;
//   - `text` / `reasoning` / `tool_call` / `tool_result` → reactivate it, because a
//     delegated member can speak again after an intermediate `done`-less gap and
//     a parent waiting on a delegated tool is still working;
//   - `done` / `error`                     → only that agent leaves the set —
//     EXCEPT a `done` whose `pending` list is non-empty (R6): the response is
//     complete but its own calls are still running, so the agent is not idle; a
//     later `wakeup` resumes it and the ring must not blink off in between;
//   - `wakeup`                             → the agent resumed, so it is active
//     again (the wake is the only frame that says "background work progressed").
//
// N3 interaction/branch frames are part of the same running turn: `action_request`
// (paused on an answer) and `action_answer` keep the agent lit, `branch_start`
// activates the branch agent, and `branch_end` ends only that branch.
//
// A parent may stay active while a delegated agent runs (the parent's last event
// is the `tool_call` that started the delegation). Both spinning is the accepted
// signal: both agents are part of the active turn.
//
// Quiet grading (`gradeActivityOfTurn`/`gradeActivityOfTurns`, and the optional
// `grades` argument of `paintActivity`) is the honesty half of that claim: an agent
// whose newest SERVER frame is seconds old is no longer visibly spinning. It is a
// WEAKER claim, never a stronger one: the name stays busy, only the sweep stops.
//
// T4 WIRED the live half. `gradeActivityOfTurn(s)` read the age off a journaled
// `SessionTurn.eventTimes`, which the display wire never delivers — the live app folds
// `TurnDisplayOp`s into a `TurnSummary` document and has no event list to walk. So the
// live grades come from `gradeActivityFromStamps` below: the SAME thresholds, applied to a
// per-agent RECEIPT stamp this app keeps beside the active set (`stampActivityFromOps`
// marks the agents an ops frame names; `syncActivityStamps` seeds an un-known name from
// the journaled stamps of that agent's own sections, which is what makes a mid-run reload
// grade the way the live view did). `main.ts` arms a 1 s clock while any agent is active,
// because a quiet grade has to be re-taken from a CLOCK to appear during the silence it
// describes — the two ring repaints that already exist (a settling row, a document patch)
// both happen exactly when nothing arrives, i.e. never. The turn board's tile (`data-quiet`,
// ui/turns.ts) owns its own 250 ms tick; there is no shared clock to reuse.
//
// Persistence across a rebuild: `renderAgents` reads the live set rather than
// replaying history, so re-rendering the row (after a PATCH, a snapshot, a lock
// change) never drops the ring of an agent that is still working.
//
// Hydration/polling rule: a browser that reloaded mid-run only sees the server's
// recorded turns. `activityOfTurns` derives the set from the events of a turn whose
// status is STILL `running`; a settled turn never lights anything, so replaying a
// completed transcript can not make old agents look busy.
//
// Cross-references:
//   - src/frontend/main.ts — live frames, terminal frames, polling, reset
//   - src/frontend/ui/agents.ts — `data-activity` / `aria-busy` on the tile
//   - src/frontend/styles.css — `@property --agent-ring-angle`, the ring
//
// The style reference is distribution/comfy-dashboard global.ts:69-105: a
// conic-gradient arc rotated by a registered custom property and masked into a 1px
// ring.

import type { HarnessEvent, SessionTurn } from '../../server/protocol';
import type { TurnDisplay, TurnDisplayOp, TurnSection } from '../../shared/turn-display';
import { eventTimesOf, pendingOf, wakeupOf } from '../contract';
import { sectionsOf } from '../view-state';
import { elapsedBetween, quietGradeOf, type QuietGrade } from './time';

// Apply one event to an activity set. Mutates the set (per-instance state is
// intentionally a live `Set`, not a value the renderer has to reconcile).
export const applyActivity = (active: Set<string>, event: HarnessEvent): void => {
    // Background-tool wakeup (R6), before the switch: the event is additive, so an
    // older server/record never reaches this branch and the reducer below keeps its
    // exact old behaviour. A wake means the agent is working again.
    const wakeup = wakeupOf(event);
    if (wakeup !== undefined) {
        active.add(wakeup.agent);
        return;
    }

    switch (event.type) {
        case 'start':
        case 'text':
        case 'reasoning':
        case 'tool_call':
        case 'tool_result':
        // A usage report is emitted while the agent is still mid-run (right after
        // its request settles, before any tool it asked for runs), so it keeps the
        // ring lit exactly like the other in-flight events.
        case 'usage':
        // R1: a retried model request is still this agent working (it abandoned one
        // attempt and re-sent the same request), so the ring stays lit. R3: a
        // committed request is likewise mid-run (the harness may still launch its
        // tools), and a tool-calling round has no `done` to fall back on.
        case 'retry':
        case 'attempt_commit':
            active.add(event.agent);
            return;

        case 'done': {
            // `done` closes the agent's RESPONSE. With concurrent tools that does
            // not make it idle: a non-empty `pending` list means its own calls are
            // still running and it will be woken. Keeping the ring lit avoids a
            // blink that would suggest the work stopped (R6). An absent `pending`
            // field is the pre-concurrency response: the agent is done.
            const pending = pendingOf(event);
            if (pending !== undefined && pending.length > 0) {
                active.add(event.agent);
                return;
            }

            // Only this agent finished; a delegated sibling keeps its ring.
            active.delete(event.agent);
            return;
        }

        // N3: the owner is asked a bounded question and the run is paused on that
        // answer, so the agent has NOT gone idle. An answer (owner or automatic) is
        // part of the same running turn and keeps the ring lit.
        case 'action_request':
        case 'action_answer':
            active.add(event.agent);
            return;

        // N3: a fork/autoanswer branch is a nested invocation doing real work. Its
        // own events also light the agent; `branch_start` is the earliest signal.
        // `branch_end` is emitted by the REQUESTER (event.agent is the source), so
        // it must NOT delete that agent's ring; the branch's own `done`/`error`
        // settles the branch agent through the normal cases above.
        case 'branch_start':
            active.add(event.branch.agent);
            return;

        case 'branch_end':
            return;

        case 'error':
            // Only this agent finished; a delegated sibling keeps its ring.
            active.delete(event.agent);
            return;
    }
};

// Activity visible for one recorded turn. A settled turn (done/error/cancelled) is
// history: replaying it must never light a tile, which is the whole point of the
// status guard.
export const activityOfTurn = (turn: SessionTurn): Set<string> => {
    const active = new Set<string>();
    if (turn.status !== 'running') return active;

    for (const event of turn.events) applyActivity(active, event);
    return active;
};

// Activity for a whole snapshot: every RUNNING turn contributes, settled turns
// contribute nothing. A session normally has at most one running turn; the union
// is still correct if a server ever reports more.
export const activityOfTurns = (turns: readonly SessionTurn[]): Set<string> => {
    const active = new Set<string>();

    for (const turn of turns) {
        if (turn.status !== 'running') continue;
        for (const event of turn.events) applyActivity(active, event);
    }

    return active;
};

// T3 (frontend liveness honesty): the GRADED side of the same fold.
//
// WHY: `applyActivity` is an EVENT-LATCHED fold — the last `start`/`text`/`reasoning`/
// `usage`/`attempt_commit` keeps a name in the set with no time component, so during a
// 62s request in which the transport emits NOTHING (a model composing a tool call —
// ../../transport/openai.ts:1761-1773, ../../harness.ts:10887) the ring still swept as
// frames were arriving. The grade adds the one missing fact, "how recently did THIS
// agent's own frame arrive", read off the journaled clock at paint time.
//
// Grades are a WEAKER claim, never a stronger one: a name stays in the set (the run is
// still unfinished, so `aria-busy` stays `true`) and only the 'active' wording/animation
// is withdrawn. No grade is asserted without a stamp to measure from.
//
// Membership comes from `activityOfTurn` itself, so the two folds can never disagree
// about WHO is working — only about how LOUDLY the UI may say so.
export type ActivityGrade = 'active' | QuietGrade;

// The agent `applyActivity` lights for one frame. `branch_start` is the ONLY frame that
// names someone other than its sender (`event.branch.agent`), and the grade follows the
// same attribution so a quiet branch cannot quiet the parent that merely waits on it.
const activityAgentOf = (event: HarnessEvent): string | undefined =>
    event.type === 'branch_start' ? event.branch.agent : event.agent;

// Newest journaled stamp of each agent's OWN events for one recorded turn.
// `SessionTurn.eventTimes` is the server clock, parallel to `events`
// (../contract.ts `eventTimesOf`). An event with no stamp contributes nothing: silence
// is never invented from a missing clock, and a settled turn has no stamps to grade.
export const lastFrameAtOfTurn = (turn: SessionTurn): Map<string, number> => {
    const stamps = new Map<string, number>();
    if (turn.status !== 'running') return stamps;

    const times = eventTimesOf(turn);
    if (times === undefined) return stamps;

    const events = Array.isArray(turn.events) ? turn.events : [];

    for (let position = 0; position < events.length; position += 1) {
        const at = times[position];
        if (at === undefined) continue;

        const agent = activityAgentOf(events[position]);
        if (agent === undefined) continue;

        const known = stamps.get(agent);
        if (known === undefined || at > known) stamps.set(agent, at);
    }

    return stamps;
};

// Graded activity for one recorded turn at the instant `now`. A name whose newest own
// frame is older than the quiet threshold grades 'quiet'/'silent'; everything else —
// including an agent with NO stamp at all — keeps 'active'.
export const gradeActivityOfTurn = (
    turn: SessionTurn,
    now: number
): Map<string, ActivityGrade> => {
    const stamps = lastFrameAtOfTurn(turn);
    const grades = new Map<string, ActivityGrade>();

    for (const agent of activityOfTurn(turn)) {
        const grade = quietGradeOf(elapsedBetween(stamps.get(agent), now));
        grades.set(agent, grade ?? 'active');
    }

    return grades;
};

// Same grading across a whole snapshot. One agent can appear in more than one running
// turn (a parent and its delegated member); the LOUDEST answer wins, because any recent
// frame from that agent is evidence it is still producing — a stale sibling may not
// quiet it.
export const gradeActivityOfTurns = (
    turns: readonly SessionTurn[],
    now: number
): Map<string, ActivityGrade> => {
    const merged = new Map<string, ActivityGrade>();

    for (const turn of turns) {
        for (const [agent, grade] of gradeActivityOfTurn(turn, now)) {
            if (merged.get(agent) === 'active') continue;
            merged.set(agent, grade);
        }
    }

    return merged;
};

// --- T4: the LIVE grades, from per-agent receipt stamps ----------------------
//
// WHY A SECOND GRADING SOURCE: `gradeActivityOfTurn` measures the age off a recorded
// `SessionTurn.eventTimes`, and the display wire never delivers one — the live app folds
// `TurnDisplayOp`s into a `TurnSummary` document (`view-state.ts`), so there is no event
// list to walk and no per-agent clock on the wire. What IS available is the moment an
// addressed mutation for that agent REACHED THIS VIEW, which is the same honesty rule the
// turn board's tile applies to its own quiet line (`frameStampOf`, ui/turns.ts:822: the
// frame's server stamp when the wire carries one, otherwise the local receipt time).
//
// The stamps live in a per-`Instance` Map next to the active set, never in a module global:
// two harness views must not share who is busy (the `activity` set already follows that
// rule).
//
// Newest journaled stamp each agent's OWN sections carry (the recorded span endpoints,
// which is all a cold document has). Used to seed a name this view has not seen a frame
// for yet — a mid-run reload, or a poll that re-derives the set — so the ring does not
// sweep for another 5 s after a reload of a run that has already been silent for 60.
// `frameStampOf`'s `Math.max` discipline applies to the caller: seeding never moves a
// stamp that real frames already advanced.
export const newestAgentStampsOf = (
    sections: readonly TurnSection[],
    rowUpdatedAt?: number
): Map<string, number> => {
    const stamps = new Map<string, number>();
    // The ROW's own stamp is the strongest figure the wire carries for every section of
    // that turn — the tile treats it exactly the same way (`noteFrame(finiteOf(summary
    // .updatedAt))`, ui/turns.ts:1021), and seeding a ring any other way would have the
    // two affordances disagree the moment a browser reloads mid-run.
    const row = typeof rowUpdatedAt === 'number' && Number.isFinite(rowUpdatedAt) ? rowUpdatedAt : undefined;

    for (const section of sections) {
        const agent = section.agent;
        if (typeof agent !== 'string' || agent.length === 0) continue;

        for (const value of [section.startedAt, section.endedAt, row]) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;

            const known = stamps.get(agent);
            if (known === undefined || value > known) stamps.set(agent, value);
        }
    }

    return stamps;
};

// Record that THIS frame reached the view for every agent it addresses.
//
// The rule is deliberately narrower than `applyOpsToActivity`'s: that fold decides WHO is
// working, this one only records when evidence for a name arrived. The `turn` op is
// skipped on purpose — the ROW is evidence about the TURN, and crediting every name in
// `summary.activeAgents` would refresh a stamp the agent has not earned (a row re-upsert
// during a 60 s composition would keep its ring sweeping forever). A terminal op is not
// special-cased either: `syncActivityStamps` prunes every name the authoritative active
// set no longer holds, so a settled agent's stamp can never make it look quiet the next
// time it wakes.
export const stampActivityFromOps = (
    stamps: Map<string, number>,
    display: TurnDisplay | undefined,
    ops: readonly TurnDisplayOp[],
    now: number
): void => {
    if (display === undefined || ops.length === 0) return;

    const sections = sectionsOf(display);

    for (const op of ops) {
        // Only `section:open` names its agent on the op itself; every other non-`turn` op
        // carries a `sectionId` that resolves through the tree the frame just mutated.
        const agent =
            op.op === 'turn'
                ? undefined
                : op.op === 'section:open'
                  ? op.section.agent
                  : sections.find((section) => section.id === op.sectionId)?.agent;

        if (typeof agent === 'string' && agent.length > 0) stamps.set(agent, now);
    }
};

// Bring the stamp map in line with the authoritative active set, at the instant `now`.
//
//   - prune: a name that is no longer active has no ring to grade, and a leftover stamp
//     would mis-grade it the moment it wakes again (a `wakeup` re-activates an agent whose
//     last frame is minutes old — that is a FRESH signal, not a silent one);
//   - seed: a newly active name with no stamp takes the newest journaled stamp of its own
//     sections (`journaled`, from `newestAgentStampsOf`), falling back to `now` when its
//     sections carry none. Absent stamps mean "unknown", and unknown is never quiet.
export const syncActivityStamps = (
    stamps: Map<string, number>,
    active: ReadonlySet<string>,
    journaled: ReadonlyMap<string, number>,
    now: number
): void => {
    for (const name of [...stamps.keys()]) {
        if (!active.has(name)) stamps.delete(name);
    }

    for (const name of active) {
        if (stamps.has(name)) continue;

        stamps.set(name, journaled.get(name) ?? now);
    }
};

// Grades for the LIVE path: the same `quietGradeOf` thresholds as the journaled fold, read
// off the receipt stamps. Membership comes from `active`, so a grade can never widen the
// claim about who is working — and a name with no stamp at all stays 'active'.
export const gradeActivityFromStamps = (
    active: ReadonlySet<string>,
    stamps: ReadonlyMap<string, number>,
    now: number
): Map<string, ActivityGrade> => {
    const grades = new Map<string, ActivityGrade>();

    for (const agent of active) {
        const grade = quietGradeOf(elapsedBetween(stamps.get(agent), now));
        grades.set(agent, grade ?? 'active');
    }

    return grades;
};

// Paint an activity set onto the rendered agent row.
//
// The tile owns `data-activity` (CSS hook) and `aria-busy` (assistive signal);
// both are removed for a member that is not active, so a stale ring can never
// survive a `done`/`error` event. `ParentNode` keeps this usable on the agent slot
// and on a detached wrapper in tests.
export const paintActivity = (
    root: ParentNode,
    active: ReadonlySet<string>,
    // T3: OPTIONAL grading of the SAME set (see `gradeActivityOfTurn`). A graded name
    // paints `data-activity='quiet'|'silent'` instead of `'active'`: the ring stays and
    // `aria-busy` stays `true` — the run really is unfinished — but the sweep stops, so
    // the pixels no longer claim frames are arriving when none are. Omitted (the caller
    // has no clock, or the data carries no stamps) paints exactly the pre-T3 `'active'`.
    grades?: ReadonlyMap<string, ActivityGrade>
): void => {
    // Both the full deck tiles (inside the composer popover) and the compact
    // composer control carry `data-agent`; painting the same state on both keeps the
    // ring visible whether the agent panel is open or closed. The agent dialog's
    // team rows (ui/agent-dialog.ts) are the third host: they are plain rows, not
    // deck tiles, so they need their own selector rather than the deck's geometry.
    for (const tile of root.querySelectorAll<HTMLElement>(
        '.agent-tile[data-agent], .agent-control[data-agent], .agent-dialog-agent[data-agent]'
    )) {
        const name = tile.dataset.agent ?? '';

        if (active.has(name)) {
            tile.dataset.activity = grades?.get(name) ?? 'active';
            tile.setAttribute('aria-busy', 'true');
            continue;
        }

        delete tile.dataset.activity;
        tile.removeAttribute('aria-busy');
    }
};
