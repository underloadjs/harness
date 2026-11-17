// T-W10 — the CLIENT fold splits a run on the process EPOCH, so the live board and the
// reload agree.
//
// THE GAP (T-W8's finding, in its own words): "the browser runs its own fold keyed by
// invocation id — `threads.get(meta.id)` → `createThread({key: meta.id})`, `.thread-row` gets
// `data-thread-id = options.key` and dedupes on it. It has no epoch rule, so in the live
// browser a post-restart child wearing a recycled invocation id still merges into one row,
// while the server's cold fold now correctly mints two."
//
// The wire value is `HarnessThread.epoch` (../../types/index.ts:3042 — the per-process minting
// epoch, `HARNESS_PROCESS_EPOCH` from ../../core/agent-limits.ts, aliased on the REST by
// ../server/api-events.ts), stamped on every frame by `threadIdentity` (../harness.ts). The
// frontend reads it structurally in `threadOf` (../contract.ts) — without that copy the browser
// fold could never see it — and applies the SAME rule the accepted server fold uses
// (../server/turn-projector.ts:599 `isEpochBoundary`, applied as rule (0) of `isRunBoundary`).
//
// What each test is accountable for:
//   SPLIT    a recycled invocation id AND a recycled spawn call id, with two known epochs,
//            becomes TWO rows on the live board — each row answers to one process, and neither
//            run's prose lands in the other's card.
//   KEYING   the two rows share ONE invocation id (the server's own sections do the same), so
//            the row key / `data-thread-id` has to disambiguate: `id\0epoch` (`runKeyOf`), with
//            the epoch also painted plainly as `data-run-epoch`.
//   PARITY   a live streamed fold and a RELOAD (hydrate from the record) produce the same rows
//            — the acceptance bar. The compiled plane's half of the same claim is in
//            ./turns-compiled-run-epoch.test.ts.
//   LEGACY   every epoch-less frame — a turn recorded before the field existed, a hand-written
//            reporter — folds EXACTLY as before: bare keys, no `data-run-epoch`, and a
//            one-sided comparison (only the later frames name a process) is the SAME run.
//
// The file also carries T-W15 (2026-11-17), the plane this fold LEFT OPEN: "Rows now agree; a
// card-level `(epoch, callId)` key is still needed." The tool cards are deduped and matched by
// `callKeyOf(callId, epoch)` — `runKeyOf` again, one rule for every plane — so a call id the
// restarted process re-mints gets its own card and its own `tool_result`. Those tests are
// `T-W15 — the epoch splits the tool-card plane`.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-run-epoch.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import { createTurnBoard, type TurnBoard } from './turns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The two processes of the live artifact: the run that died, and the one that restarted and
// began its invocation counter again — which is why `inv-16` and `call-1` each appear TWICE.
const E1 = 'proc-4a13';
const E2 = 'proc-9f20';

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread }) as unknown as HarnessEvent;

// The turn's OWN conversation: an invocation id and the task, nothing else (no parent, no
// spawn call, no kind, no branch) — the shape BOTH folds read as the conversation root.
const hostThread = (invocationId: string, epoch: string | undefined): Record<string, unknown> => ({
    id: invocationId,
    input: 'stress test the tools',
    ...(epoch === undefined ? {} : { epoch })
});

// A delegated run: it names its parent invocation AND the spawning call, and — once the
// runtime stamps it — the process that minted both.
const childThread = (invocationId: string, callId: string, epoch: string | undefined): Record<string, unknown> => ({
    id: invocationId,
    parentId: 'inv-13',
    callId,
    kind: 'delegation',
    input: 'review the read tool',
    ...(epoch === undefined ? {} : { epoch })
});

// One delegated run: the PARENT's `delegate` call (which opens the row the child then adopts),
// the child's `start`, one prose frame that identifies THIS run unambiguously, and its `done`.
const delegatedRun = (
    invocationId: string,
    callId: string,
    epoch: string | undefined,
    prose: string
): HarnessEvent[] => {
    const meta = childThread(invocationId, callId, epoch);

    return [
        {
            type: 'tool_call',
            agent: 'one',
            call: {
                id: callId,
                name: 'delegate',
                arguments: JSON.stringify({ agent: 'Workspace', input: 'review the read tool' })
            }
        } as HarnessEvent,
        withThread({ type: 'start', agent: 'Workspace', model: 'w1' }, meta),
        withThread({ type: 'text', agent: 'Workspace', delta: prose }, meta),
        withThread({ type: 'done', agent: 'Workspace', message: doneMessage('Workspace') }, meta)
    ];
};

// The whole turn: the host run, one delegated run, then — after the process death — the SAME
// invocation id and the SAME spawn call id worn by a NEW process (the artifact the gap
// describes). `epochs` is the pair the two runs carry.
const recycledTurn = (epochs: [string | undefined, string | undefined]): HarnessEvent[] => [
    withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', epochs[0])),
    withThread({ type: 'text', agent: 'one', delta: 'planning the run' }, hostThread('inv-13', epochs[0])),
    ...delegatedRun('inv-16', 'call-1', epochs[0], 'pre-restart lane'),
    ...delegatedRun('inv-16', 'call-1', epochs[1], 'post-restart lane'),
    withThread({ type: 'text', agent: 'one', delta: 'the report' }, hostThread('inv-13', epochs[1])),
    withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', epochs[1]))
];

// One stamp per event, so a duration is a figure the reader can count and neither fold has a
// reason to order rows by anything but their recorded sequence.
const timesOf = (events: HarnessEvent[]): number[] => events.map((_event, index) => 1_000 + index * 10);

const recordOf = (events: HarnessEvent[]): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'stress test the tools',
    status: 'done',
    startedAt: 1_000,
    updatedAt: timesOf(events).at(-1) ?? 1_000,
    threadId: 'thread-13',
    threadLabel: 'IT4',
    events,
    eventTimes: timesOf(events)
});

const mount = (): TurnBoard => {
    const board = createTurnBoard({});
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return board;
};

// THE LIVE DOOR: one `TurnHandle.apply` per streamed frame, exactly the shell's SSE path.
const streamFold = (events: HarnessEvent[]): TurnBoard => {
    const board = mount();
    const handle = board.begin('stress test the tools', [], 'thread-13');
    const stamps = timesOf(events);

    events.forEach((event, index) => handle.apply(event, stamps[index], 'live'));
    handle.flush();

    return board;
};

// THE RELOAD DOOR: a fresh board handed the complete record, which is what a page refresh
// serves (`hydrate` applies every recorded event, in recorded order).
const replayFold = (events: HarnessEvent[]): TurnBoard => {
    const board = mount();
    board.hydrate([recordOf(events)]);

    return board;
};

// Every prose block a surface owns, in order, trimmed. Listing BLOCKS (rather than one joined
// string) keeps the assertion exact without depending on how Markdown paragraph breaks are
// painted — and a MERGE shows up as ONE row holding BOTH runs' blocks, which is the failure
// this pins. Rows are flat siblings (R18), so nothing outside the card is counted.
const proseOf = (host: Element | null | undefined): string[] =>
    [...(host?.querySelectorAll<HTMLElement>('.agent-text') ?? [])].map((node) => (node.textContent ?? '').trim());

// The row projection in the terms the requirement is written in: the row KEY (the same value
// `.thread-row[data-thread-id]` carries), the process it answers to, and the prose inside it.
const rowsOf = (board: TurnBoard): Array<[string | undefined, string | undefined, string[]]> =>
    [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => [
        row.dataset.threadId,
        row.dataset.runEpoch,
        proseOf(row.querySelector('.thread-flow'))
    ]);

// The conversation card's own flow: a post-restart host frame must land here, never inside the
// dead child's row.
const rootFlowText = (board: TurnBoard): string[] => proseOf(board.element.querySelector('.tile-flow'));

// T-W15 — the TOOL-CARD projection of one surface, in DOM order. A card's identity for the
// reader is `(data-call-id, state)`, and the text it prints is the exact answer its OWN
// `tool_result` carried: a settled card shows the content in the result code view, an abandoned
// one shows the interruption note instead (`tools.ts` `paintResult(reason, 'cancelled', reason)`
// writes `p.tool-pending` and removes the code view). Listing cards rather than joining text
// keeps the failure readable: a swallowed result shows up as a `running`/`cancelled` card, which
// is exactly the bug this pins, and never as a fuzzy substring.
const cardsOf = (host: Element | null | undefined): Array<Array<string | undefined>> =>
    [...(host?.querySelectorAll<HTMLElement>('.tool') ?? [])].map((card) => [
        card.dataset.callId,
        card.dataset.state,
        card.querySelector('.tool-name')?.textContent ?? undefined,
        card.querySelector('.tool-result code')?.textContent ??
            card.querySelector('.tool-result .tool-pending')?.textContent ??
            undefined
    ]);

const rootCards = (board: TurnBoard): Array<Array<string | undefined>> =>
    cardsOf(board.element.querySelector('.tile-flow'));

// Rows with the cards INSIDE them: the row fold and the card fold have to agree at the same
// time, which is the whole claim (`rowsOf` above only sees the rows).
const rowsWithCards = (
    board: TurnBoard
): Array<[string | undefined, string | undefined, Array<Array<string | undefined>>]> =>
    [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => [
        row.dataset.threadId,
        row.dataset.runEpoch,
        cardsOf(row.querySelector('.thread-flow'))
    ]);

// One `tool_call` / `tool_result` pair, stamped with the frame's own run identity. Both doors of
// the harness attach `thread` to EVERY frame of a non-root run (`harness.ts` `emit` →
// `withThread` → `threadIdentity`), so a tool call carries the process exactly like prose does —
// and a root run carries no `thread` at all, which is the legacy-by-construction case.
const toolCall = (
    agent: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
    thread: Record<string, unknown>
): HarnessEvent =>
    withThread({ type: 'tool_call', agent, call: { id: callId, name, arguments: JSON.stringify(args) } }, thread);

const toolResult = (
    agent: string,
    callId: string,
    name: string,
    content: string,
    thread: Record<string, unknown>
): HarnessEvent => withThread({ type: 'tool_result', agent, name, content, callId, isError: false }, thread);

// The interruption note a card carries when the tile went terminal with the call still
// unresolved (`turns.ts` `setState` → `tool.abandon`, the `done` wording).
const INTERRUPTED = 'Interrupted when the turn ended without a result.';

// What an UNRESOLVED card shows on a tile that is still open: `tools.ts` seeds the result pane
// with this placeholder, so a call whose `tool_result` was dropped reads as "still coming" until
// the tile settles. The two doors differ here by construction — a streamed tile is still open
// after the last frame, while `hydrate` applies the record's terminal `status` — and that
// difference is pre-existing (see ./turns.test.ts `abandons an unmatched call when a turn ends
// without its result`), so each door is pinned with its own exact wording below.
const RUNNING = 'Waiting for the harness to run this call…';

// A delegated run that ISSUES ITS OWN TOOL CALL: the parent's `delegate` call (which opens the
// row the child then adopts), the child's `start`, the child's `read` call and its result, the
// child's `done`, and the parent's authoritative answer for the spawn call. `spawnCallId` is the
// parent's call id; `toolCallId` is the CHILD's, and both come from the same per-process counter
// — which is why a restart re-mints them together.
const delegatedToolRun = (
    invocationId: string,
    spawnCallId: string,
    toolCallId: string,
    epoch: string | undefined,
    output: string,
    answer: string
): HarnessEvent[] => {
    const meta = childThread(invocationId, spawnCallId, epoch);
    const parent = hostThread('inv-13', epoch);

    return [
        toolCall('one', spawnCallId, 'delegate', { agent: 'Workspace', input: 'review the read tool' }, parent),
        withThread({ type: 'start', agent: 'Workspace', model: 'w1' }, meta),
        toolCall('Workspace', toolCallId, 'read', { path: 'src/a.ts' }, meta),
        toolResult('Workspace', toolCallId, 'read', output, meta),
        withThread({ type: 'done', agent: 'Workspace', message: doneMessage('Workspace') }, meta),
        toolResult('one', spawnCallId, 'delegate', answer, parent)
    ];
};

// The turn the T-W10 worker described, one tool call deeper: a delegated run whose tool-call id
// is re-minted by the process that restarts after it died. `epochs` is what the two runs carry.
const recycledToolTurn = (epochs: [string | undefined, string | undefined]): HarnessEvent[] => [
    withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', epochs[0])),
    ...delegatedToolRun('inv-16', 'call-1', 'call-2', epochs[0], 'pre-restart output', 'pre-restart answer'),
    ...delegatedToolRun('inv-16', 'call-1', 'call-2', epochs[1], 'post-restart output', 'post-restart answer'),
    withThread({ type: 'text', agent: 'one', delta: 'the report' }, hostThread('inv-13', epochs[1])),
    withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', epochs[1]))
];

// The tile's own count line, which is where a hanging card is visible: an unsettled call keeps
// the tile advertising work that finished minutes ago.
const metaOf = (board: TurnBoard): string => board.element.querySelector('.tile-meta')?.textContent ?? '';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('T-W10 — the epoch splits the client fold', () => {
    it('mints one row per process when the invocation id and the call id are both recycled', () => {
        const board = streamFold(recycledTurn([E1, E2]));

        // TWO rows, both addressing `inv-16`, one per process: the key carries the epoch, and
        // `data-run-epoch` states it plainly beside it (the key is NUL-joined, which a test —
        // or an inspector — should not have to parse).
        expect(rowsOf(board)).toEqual([
            [`inv-16\u0000${E1}`, E1, ['pre-restart lane']],
            [`inv-16\u0000${E2}`, E2, ['post-restart lane']]
        ]);

        // The host run is not a child row: its own card holds the conversation's flow from BOTH
        // processes, and neither child absorbed it.
        expect(rootFlowText(board)).toEqual(['planning the run', 'the report']);
    });

    it('streams and replays the same rows — live board and reload cannot disagree', () => {
        const events = recycledTurn([E1, E2]);

        const live = rowsOf(streamFold(events));
        const reload = rowsOf(replayFold(events));

        // Live ≡ replay: the same rows, in the same order, with the same content. A rule keyed
        // on anything live-only (a clock, a connection, the apply origin) would pass the first
        // fold and show a DIFFERENT board after a refresh.
        expect(live).toEqual([
            [`inv-16\u0000${E1}`, E1, ['pre-restart lane']],
            [`inv-16\u0000${E2}`, E2, ['post-restart lane']]
        ]);
        expect(reload).toEqual(live);
        expect(rootFlowText(replayFold(events))).toEqual(rootFlowText(streamFold(events)));
    });

    it('keeps every epoch-less row exactly where it was', () => {
        // The whole pre-change wire: no `epoch` anywhere, two DIFFERENT children (the ordinary
        // legacy shape). Nothing here may move a row, or every session recorded before this
        // change would re-render differently after an upgrade — so the expected rows are the
        // pre-change ones, down to the bare adopted-placeholder keys and the absent
        // `data-run-epoch`.
        const events = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', undefined)),
            withThread({ type: 'text', agent: 'one', delta: 'planning the run' }, hostThread('inv-13', undefined)),
            ...delegatedRun('inv-14', 'call-1', undefined, 'first lane'),
            ...delegatedRun('inv-15', 'call-2', undefined, 'second lane'),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', undefined))
        ];

        expect(rowsOf(streamFold(events))).toEqual([
            ['inv-14', undefined, ['first lane']],
            ['inv-15', undefined, ['second lane']]
        ]);

        // The reload agrees.
        expect(rowsOf(replayFold(events))).toEqual(rowsOf(streamFold(events)));
    });

    it('merges a recycled id that names NO process — a legacy artifact is untouched', () => {
        // The same recycled pair as the SPLIT test, with the epochs erased: every pre-change
        // session that ever recycled an id through a restart. The rule cannot fire on frames
        // that name no process, so this is the OLD fold — one row holding both runs' prose,
        // plus the orphan placeholder the second `delegate` call opened (pre-existing
        // behavior, unchanged). A split here would rewrite history for old records.
        expect(rowsOf(streamFold(recycledTurn([undefined, undefined])))).toEqual([
            ['inv-16', undefined, ['pre-restart lane', 'post-restart lane']],
            ['call:call-1', undefined, []]
        ]);
    });

    it('treats a one-sided epoch as the same run, and only a named process can split it', () => {
        const first = delegatedRun('inv-16', 'call-1', undefined, 'pre-restart lane');
        const second = delegatedRun('inv-16', 'call-1', E1, 'second half');

        // Half the run names no process (a record whose early frames predate the field, or a
        // partially-upgraded producer). `isEpochBoundary` fires on TWO known epochs only, so the
        // row keeps its single card and takes E1 as FIRST EVIDENCE — the row keeps its bare key
        // and shows no `data-run-epoch`, because those were painted at creation by an
        // epoch-less frame; the epoch is ROW state.
        expect(
            rowsOf(
                streamFold([
                    withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', undefined)),
                    ...first,
                    ...second
                ])
            )
        ).toEqual([
            ['inv-16', undefined, ['pre-restart lane', 'second half']],
            ['call:call-1', undefined, []]
        ]);

        // Same first halves, then a THIRD run that names a DIFFERENT process: the row has
        // learned E1 from its own run, so the comparison is two-sided and the later run is a
        // row of its own — and it takes the placeholder the last call opened.
        const third = delegatedRun('inv-16', 'call-1', E2, 'post-restart lane');

        expect(rowsOf(streamFold([...first, ...second, ...third]))).toEqual([
            ['inv-16', undefined, ['pre-restart lane', 'second half']],
            [`inv-16\u0000${E2}`, E2, ['post-restart lane']]
        ]);
    });

    it('routes a post-restart host frame to the conversation card, not the dead child row', () => {
        // The F5 shape on the client: the child's invocation id is recycled by the turn's OWN
        // conversation (a ROOT-shaped frame, here with a NEW epoch). A root-shaped frame belongs
        // to the conversation's own card whichever way the epoch rule answers — the server's
        // `route` says the same, and that is what keeps a resumed conversation on its own row.
        const events = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', E1)),
            ...delegatedRun('inv-16', 'call-1', E1, 'pre-restart lane'),
            withThread({ type: 'text', agent: 'one', delta: 'the resumed answer' }, hostThread('inv-16', E2)),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-16', E2))
        ];
        const board = streamFold(events);

        // The dead child keeps its one row and its one sentence; the resumed answer lands on the
        // conversation's own flow, so the two runs never share a card.
        expect(rowsOf(board)).toEqual([[`inv-16\u0000${E1}`, E1, ['pre-restart lane']]]);
        expect(rootFlowText(board)).toEqual(['the resumed answer']);
    });
});

// T-W15 (2026-11-17) — THE TOOL-CARD PLANE OF THE SAME RULE.
//
// The row fold landed and left its own disclosure: "Rows now agree; a card-level
// `(epoch, callId)` key is still needed." The raw fold's card dedupe (`turns.ts`
// `settledCalls`, matched through `resolveTool`) was keyed by the BARE `callId`, and the
// call-id counter is per process just like the invocation counter
// (`../core/agent-limits.ts`), so after the row split the NEW run's row held a card whose
// `tool_result` was thrown away as a duplicate of the DEAD run's settled call. The reader saw
// a chip stuck `running` — and, once the tile went terminal, abandoned as "interrupted" — for
// a call that had in fact answered.
//
// THE KEY: `callKeyOf(callId, epoch)` = `runKeyOf`, i.e. `callId\0epoch` when the frame names
// a process and the BARE `callId` when it does not. One rule, three planes (rows, placeholder
// lookups, cards), so they cannot drift.
//
// What each test is accountable for:
//   ROOT SPLIT  a re-minted call id inside the CONVERSATION'S OWN card — the case the row rule
//               cannot reach, because a resumed conversation deliberately keeps one row — gives
//               TWO cards, each settled by its own `tool_result`.
//   ROW SPLIT   the artifact the disclosure names: the child row's card settles in each row.
//   PARITY      the live stream and the reload fold the same cards.
//   LEGACY      every epoch-less frame keeps EXACTLY the pre-change projection, including the
//               pre-change defect: a rule that needs two named processes cannot improve a
//               recording that names none, and it must not move it either.
//   DEDUPE      a duplicate result for one process is still one card — the dedupe did not
//               weaken, it only learned which process it belongs to.
//   ISOLATION   a result from a process that did not mint the call cannot settle that card.
describe('T-W15 — the epoch splits the tool-card plane', () => {
    it('settles one card per process when the conversation root re-mints a call id', () => {
        // Both runs stream into the SAME conversation card (`entryFor` sends a root-shaped frame
        // to the root entry whichever way the epoch rule answers — the rule that keeps a resumed
        // conversation on its own row), so the row plane has nothing to split here: only the
        // card key can tell the two calls apart.
        const events = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'pre.ts' }, hostThread('inv-13', E1)),
            toolResult('one', 'call-9', 'read', 'pre-restart output', hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'post.ts' }, hostThread('inv-13', E2)),
            toolResult('one', 'call-9', 'read', 'post-restart output', hostThread('inv-13', E2)),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', E2))
        ];
        const board = streamFold(events);

        // TWO chips under one call id, each holding ITS OWN answer — the second one settled, not
        // left hanging. `data-call-id` alone cannot express this pair; `(epoch, callId)` can.
        expect(rootCards(board)).toEqual([
            ['call-9', 'ok', 'read', 'pre-restart output'],
            ['call-9', 'ok', 'read', 'post-restart output']
        ]);

        // Nothing about the row fold moved: a root-shaped frame still owns one conversation card.
        expect(rowsOf(board)).toEqual([]);
        expect(metaOf(board)).toBe('1 agent · 2 tool calls');
    });

    it('settles the card inside each row when a delegated run re-mints its tool-call id', () => {
        const board = streamFold(recycledToolTurn([E1, E2]));

        // THE GAP, CLOSED: two rows (T-W10) AND one settled card in each (T-W15). With the bare
        // key the second row's card is `cancelled`/`running` and holds no output at all.
        expect(rowsWithCards(board)).toEqual([
            [`inv-16\u0000${E1}`, E1, [['call-2', 'ok', 'read', 'pre-restart output']]],
            [`inv-16\u0000${E2}`, E2, [['call-2', 'ok', 'read', 'post-restart output']]]
        ]);

        // The same rule reaches the parent's spawn call: each run's `delegate` chip is settled by
        // its own authoritative answer, so a re-minted `call-1` no longer swallows the answer of
        // the run that restarted.
        expect(rootCards(board)).toEqual([
            ['call-1', 'ok', 'delegate', 'pre-restart answer'],
            ['call-1', 'ok', 'delegate', 'post-restart answer']
        ]);
        expect(metaOf(board)).toBe('3 agents · 4 tool calls');
    });

    it('streams and replays the same cards — the live board and the reload cannot disagree', () => {
        const events = recycledToolTurn([E1, E2]);

        const live = streamFold(events);
        const reload = replayFold(events);

        // Live ≡ replay on the CARD plane (the row plane's half of the claim is pinned above). The
        // key is a pure function of the frames folded so far and both doors replay the same
        // frames, so a card that settles while streaming is settled after a refresh too.
        expect(rowsWithCards(live)).toEqual(rowsWithCards(reload));
        expect(rootCards(live)).toEqual(rootCards(reload));
        expect(metaOf(reload)).toBe(metaOf(live));

        // And the shared value is the settled pair, not merely "the same on both doors": a rule
        // that hung the card in BOTH folds would still pass a parity-only assertion.
        expect(rowsWithCards(reload)).toEqual([
            [`inv-16\u0000${E1}`, E1, [['call-2', 'ok', 'read', 'pre-restart output']]],
            [`inv-16\u0000${E2}`, E2, [['call-2', 'ok', 'read', 'post-restart output']]]
        ]);
    });

    it('leaves a re-minted legacy call id exactly as it was — the pre-change projection, defect included', () => {
        // The identical artifact with every `epoch` erased: what a session recorded before
        // `HarnessThread.epoch` exists. Nothing may improve here either — a comparison that needs
        // two named processes says nothing about a recording that names none — so these are
        // today's cards, in today's order, with today's outcomes.
        const events = recycledToolTurn([undefined, undefined]);
        const board = streamFold(events);

        expect(rowsWithCards(board)).toEqual([
            [
                'inv-16',
                undefined,
                [
                    ['call-2', 'ok', 'read', 'pre-restart output'],
                    // The second run's answer was ALREADY a duplicate of the first under the bare
                    // id, so this card is still waiting — today's outcome, one streamed tile deep.
                    ['call-2', 'running', 'read', RUNNING]
                ]
            ],
            // The orphan placeholder the second `delegate` call opened (pre-existing behavior).
            ['call:call-1', undefined, []]
        ]);

        expect(rootCards(board)).toEqual([
            ['call-1', 'ok', 'delegate', 'pre-restart answer'],
            ['call-1', 'running', 'delegate', RUNNING]
        ]);
        expect(metaOf(board)).toBe('3 agents · 4 tool calls');

        // The reload shows the SAME projection and the same waiting cards; the only difference is
        // the wording of the cards nothing answered, because the record's `status: 'done'` makes
        // that tile terminal and the abandoned-card rule replaces the placeholder (pre-existing,
        // unchanged by this change — see ./turns.test.ts).
        expect(rowsWithCards(replayFold(events))).toEqual([
            [
                'inv-16',
                undefined,
                [
                    ['call-2', 'ok', 'read', 'pre-restart output'],
                    ['call-2', 'cancelled', 'read', INTERRUPTED]
                ]
            ],
            ['call:call-1', undefined, []]
        ]);

        expect(rootCards(replayFold(events))).toEqual([
            ['call-1', 'ok', 'delegate', 'pre-restart answer'],
            ['call-1', 'cancelled', 'delegate', INTERRUPTED]
        ]);
    });

    it('pairs each card with its own answer when a call is left unsettled by the run that died', () => {
        // The F5 shape on the card plane: the dead run's call never answered, and the restarted
        // process re-mints the SAME id for its own call. Both doors must put the answer on the
        // NEW run's card. Under the bare key the result walked to the FIRST running card — the
        // dead run's — so the old card claimed an answer it never got while the live one hung.
        const events = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'pre.ts' }, hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'post.ts' }, hostThread('inv-13', E2)),
            toolResult('one', 'call-9', 'read', 'post-restart output', hostThread('inv-13', E2))
        ];

        // The reload door, where the record's terminal status also settles the orphaned call: the
        // dead run's card is INTERRUPTED (never the other run's answer) and the live one is ok.
        expect(rootCards(replayFold(events))).toEqual([
            ['call-9', 'cancelled', 'read', INTERRUPTED],
            ['call-9', 'ok', 'read', 'post-restart output']
        ]);

        // The live door is still open at the last frame, so the same pairing shows without the
        // terminal wording: the card that answered is the E2 one.
        expect(rootCards(streamFold(events))).toEqual([
            ['call-9', 'running', 'read', RUNNING],
            ['call-9', 'ok', 'read', 'post-restart output']
        ]);
    });

    it('keeps one card for a duplicate result, whether or not the frames name a process', () => {
        // The dedupe must not have WEAKENED: a repeated frame (replay overlap, retried event) is
        // still ignored and must not overwrite the first answer or mint a second chip.
        const legacy = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', undefined)),
            toolCall('one', 'call-9', 'read', { path: 'a.ts' }, hostThread('inv-13', undefined)),
            toolResult('one', 'call-9', 'read', 'first answer', hostThread('inv-13', undefined)),
            toolResult('one', 'call-9', 'read', 'duplicate answer', hostThread('inv-13', undefined)),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', undefined))
        ];

        expect(rootCards(streamFold(legacy))).toEqual([['call-9', 'ok', 'read', 'first answer']]);

        // Same frames, now stamped with ONE process: the duplicate is the SAME run's duplicate, so
        // the qualified key matches and the answer is unchanged.
        const stamped = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'a.ts' }, hostThread('inv-13', E1)),
            toolResult('one', 'call-9', 'read', 'first answer', hostThread('inv-13', E1)),
            toolResult('one', 'call-9', 'read', 'duplicate answer', hostThread('inv-13', E1)),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', E1))
        ];

        expect(rootCards(streamFold(stamped))).toEqual([['call-9', 'ok', 'read', 'first answer']]);
    });

    it("refuses to settle another process's card with a same-callId result", () => {
        // A frame that names E2 meeting a call E1 minted: the requirement's second invariant. The
        // dead run's card is NOT resolved by it (that was today's silent mis-settle — the new
        // process's answer pasted onto the old process's call), and the frame is still shown as
        // what it is: a result this fold never saw a call for.
        const events = [
            withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread('inv-13', E1)),
            toolCall('one', 'call-9', 'read', { path: 'pre.ts' }, hostThread('inv-13', E1)),
            toolResult('one', 'call-9', 'read', 'post-restart output', hostThread('inv-13', E2)),
            withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread('inv-13', E1))
        ];

        // The streamed tile is still open after the last frame (`done` closes one AGENT turn, not
        // the user turn — see `turns.ts` case `done`), so E1's card is plainly still waiting.
        expect(rootCards(streamFold(events))).toEqual([
            // E1's card carries no output at all, let alone the other process's.
            ['call-9', 'running', 'read', RUNNING],
            // No call id of its own: nothing in this recording called it.
            [undefined, 'ok', 'read', 'post-restart output']
        ]);

        // Same frames, terminal record: the abandoned-card pass closes E1's card, and the card
        // key it records is `call-9\0E1` (`entry.epoch`) — the qualification is what keeps a call
        // the NEXT process mints under this id settleable instead of pre-settled as a duplicate.
        expect(rootCards(replayFold(events))).toEqual([
            ['call-9', 'cancelled', 'read', INTERRUPTED],
            [undefined, 'ok', 'read', 'post-restart output']
        ]);
    });
});
