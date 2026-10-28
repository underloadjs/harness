// Per-agent activity: which agent tiles draw the rotating border.
//
// The harness emits ONE `HarnessEvent` stream and every event names its agent
// (`agent`). The UI keeps a live set of agent names per *instance* (and therefore
// per selected harness view) and updates it with this reducer:
//
//   - `start`                              → that agent is active;
//   - `text` / `reasoning` / `tool_call` / `tool_result` → reactivate it, because a
//     delegated subagent can speak again after an intermediate `done`-less gap and
//     a parent waiting on a delegated tool is still working;
//   - `done` / `error`                     → only that agent leaves the set.
//
// A parent may stay active while a delegated agent runs (the parent's last event
// is the `tool_call` that started the delegation). Both spinning is the accepted
// signal: both agents are part of the active turn.
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
//   - playground/src/main.ts — live frames, terminal frames, polling, reset
//   - playground/src/ui/agents.ts — `data-activity` / `aria-busy` on the tile
//   - playground/src/styles.css — `@property --agent-ring-angle`, the ring
//
// The style reference is distribution/comfy-dashboard global.ts:69-105: a
// conic-gradient arc rotated by a registered custom property and masked into a 1px
// ring.

import type { HarnessEvent, SessionTurn } from '../../../server/protocol';

// Apply one event to an activity set. Mutates the set (per-instance state is
// intentionally a live `Set`, not a value the renderer has to reconcile).
export const applyActivity = (active: Set<string>, event: HarnessEvent): void => {
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
            active.add(event.agent);
            return;

        case 'done':
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

// Paint an activity set onto the rendered agent row.
//
// The tile owns `data-activity` (CSS hook) and `aria-busy` (assistive signal);
// both are removed for a member that is not active, so a stale ring can never
// survive a `done`/`error` event. `ParentNode` keeps this usable on the agent slot
// and on a detached wrapper in tests.
export const paintActivity = (root: ParentNode, active: ReadonlySet<string>): void => {
    for (const tile of root.querySelectorAll<HTMLElement>('.agent-tile[data-agent]')) {
        const name = tile.dataset.agent ?? '';

        if (active.has(name)) {
            tile.dataset.activity = 'active';
            tile.setAttribute('aria-busy', 'true');
            continue;
        }

        delete tile.dataset.activity;
        tile.removeAttribute('aria-busy');
    }
};
