// R7/R8/R9 — lossless JSON thread transcript, responsive action bars and
// confirmed thread deletion.
//
// Pins:
//   - the JSON document contains the EXACT raw thread (messages included), every
//     owned turn (failed/error turns included, never filtered), and the delegated
//     child invocation events recorded inside OTHER turns with turn/event
//     provenance;
//   - no sibling thread event leaks in, and no raw provider HTTP log is invented
//     (the limitations array states that honestly);
//   - dialog body and Copy action are the SAME pretty JSON string;
//   - refresh updates an open dialog from a newer snapshot, ignores a stale
//     session and CLOSES when the thread vanished;
//   - expanded tile / nested card / focus panel toolbars put Transcript left and
//     Delete right, with desktop labels, mobile glyphs and accessible names;
//   - delete is two-step (no request before confirm), deduped while in flight,
//     disabled for default/running/queued/descendant work, keeps data on failure
//     and closes focus/transcript on success.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-transcript.test.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    DeleteThreadResult,
    HarnessEvent,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { SessionThreadEntry } from './threads';
import { sessionThreadsOf } from './threads';
import { threadDeleteProtectionOf, threadSubtreeIdsOf } from './turns';
import type { TurnBoard, TurnHandle } from './turns';
import { createTurnBoard } from './turns';
import {
    THREAD_TRANSCRIPT_LIMITATIONS,
    buildThreadTranscriptJson,
    closeThreadTranscript,
    openThreadTranscript,
    refreshOpenThreadTranscript,
    serializeThreadTranscript,
    threadTranscriptCopyText
} from './thread-transcript';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

const setExecCommand = (implementation: ((command: string) => boolean) | undefined): void => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: implementation });
};

const snapshotOf = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 10,
    messages: [],
    turns: [],
    threads: [],
    ...overrides
});

const threadOf = (overrides: Partial<SessionThread> & { id: string }): SessionThread => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    messages: [],
    ...overrides
});

const turnOf = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [],
    ...overrides
});

const invocation = (id: string, parentId?: string): { id: string; parentId?: string } => ({
    id,
    ...(parentId === undefined ? {} : { parentId })
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread } as unknown as HarnessEvent);

// A target CHILD conversation plus its owner, a grandchild and an unrelated
// sibling. The parent turn contains the runtime events of the child subtree (the
// child has no turn of its own for that first invocation).
const parentThread = threadOf({
    id: 'thread-parent',
    sequence: 1,
    label: 'RR1',
    invocationIds: ['inv-parent']
});

const childThread = threadOf({
    id: 'thread-child',
    agent: 'Helper',
    sequence: 2,
    label: 'RR2',
    ownerThreadId: 'thread-parent',
    invocationId: 'inv-child-resume',
    originInvocationId: 'inv-child',
    invocationIds: ['inv-child', 'inv-child-resume'],
    messages: [
        { role: 'system', content: 'child system instruction' },
        {
            role: 'user',
            content: 'child task [Image 1]',
            attachments: [{ marker: '[Image 1]', name: 'pixel.png', kind: 'image', data: 'AAAA' }]
        },
        { role: 'assistant', content: 'child answer' }
    ]
});

const grandThread = threadOf({
    id: 'thread-grand',
    agent: 'Grand',
    sequence: 4,
    label: 'RR4',
    ownerThreadId: 'thread-child',
    invocationIds: ['inv-grand']
});

const siblingThread = threadOf({
    id: 'thread-sibling',
    agent: 'Researcher',
    sequence: 3,
    label: 'RR3',
    invocationIds: ['inv-sibling']
});

const childStart = withThread(
    { type: 'start', agent: 'Helper', model: 'h1' },
    invocation('inv-child', 'inv-parent')
);
const childToolCall = withThread(
    {
        type: 'tool_call',
        agent: 'Helper',
        call: { id: 'call-child', name: 'fileRead', arguments: '{"path":"a.ts"}' }
    },
    invocation('inv-child', 'inv-parent')
);
const childError = withThread(
    { type: 'error', agent: 'Helper', error: { message: 'child failed' } },
    invocation('inv-child', 'inv-parent')
);
const grandStart = withThread(
    { type: 'start', agent: 'Grand', model: 'g1' },
    { ...invocation('inv-grand', 'inv-child'), input: 'grandchild task' }
);
const grandResult = withThread(
    {
        type: 'tool_result',
        agent: 'Grand',
        name: 'fileRead',
        callId: 'call-grand',
        content: 'grand result',
        isError: false,
        outcome: 'completed'
    },
    invocation('inv-grand', 'inv-child')
);
const siblingStart = withThread(
    { type: 'start', agent: 'Researcher', model: 'r1' },
    invocation('inv-sibling')
);
const siblingError = withThread(
    { type: 'error', agent: 'Researcher', error: { message: 'sibling failed' } },
    invocation('inv-sibling')
);

// Steer audit records live on the turn that owned the running lane. These target
// the child/grandchild and a sibling; the owner turn itself is not the target.
const childSteer = {
    at: 25,
    prompt: 'steer the child',
    threadId: 'thread-child',
    references: [{ turnId: 'turn-parent', threadId: 'thread-parent', label: 'RR1' }]
};
const grandSteer = {
    at: 26,
    prompt: 'steer the grandchild',
    threadId: 'thread-grand',
    references: [{ turnId: 'turn-parent', threadId: 'thread-parent', label: 'RR1' }]
};
const ownerSteer = {
    at: 27,
    prompt: 'owner-only steer'
};
const siblingSteer = {
    at: 28,
    prompt: 'steer the sibling',
    threadId: 'thread-sibling'
};

const parentTurn = turnOf({
    id: 'turn-parent',
    index: 0,
    threadId: 'thread-parent',
    prompt: 'parent prompt',
    events: [
        { type: 'start', agent: 'Researcher', model: 'r1' },
        {
            type: 'tool_call',
            agent: 'Researcher',
            call: {
                id: 'call-delegate',
                name: 'agentDelegate',
                arguments: '{"agent":"Helper","input":"child task"}'
            }
        },
        childStart,
        childToolCall,
        childError,
        grandStart,
        grandResult
    ],
    eventTimes: [1, 20, 30, 40, 50, 60, 70],
    steers: [childSteer, grandSteer, ownerSteer]
});

const childUsageMessage = {
    role: 'assistant' as const,
    content: 'resumed answer',
    reasoning: 'thinking',
    toolCalls: [],
    model: 'h1',
    stopReason: 'stop' as const,
    usage: { input: 11, output: 7, total: 18 }
};

const childTurn = turnOf({
    id: 'turn-child',
    index: 1,
    threadId: 'thread-child',
    prompt: 'resume child',
    startedAt: 100,
    updatedAt: 140,
    events: [
        withThread({ type: 'start', agent: 'Helper', model: 'h1' }, invocation('inv-child-resume')),
        withThread(
            { type: 'text', agent: 'Helper', delta: 'resumed answer' },
            invocation('inv-child-resume')
        ),
        withThread(
            { type: 'done', agent: 'Helper', message: childUsageMessage },
            invocation('inv-child-resume')
        )
    ],
    eventTimes: [100, 120, 140],
    usage: { input: 11, output: 7, total: 18 },
    steers: [
        {
            at: 110,
            prompt: 'steered text',
            threadId: 'thread-child',
            references: [{ turnId: 'turn-parent', threadId: 'thread-parent', label: 'RR1' }]
        }
    ]
});

const failedChildTurn = turnOf({
    id: 'turn-child-failed',
    index: 3,
    threadId: 'thread-child',
    prompt: 'this prompt failed',
    status: 'error',
    startedAt: 200,
    updatedAt: 230,
    events: [
        withThread({ type: 'start', agent: 'Helper', model: 'h1' }, invocation('inv-child-resume')),
        withThread(
            { type: 'error', agent: 'Helper', error: { message: 'provider exploded' } },
            invocation('inv-child-resume')
        )
    ],
    eventTimes: [200, 230]
});

const siblingTurn = turnOf({
    id: 'turn-sibling',
    index: 2,
    threadId: 'thread-sibling',
    prompt: 'sibling prompt',
    events: [siblingStart, siblingError],
    eventTimes: [80, 90],
    steers: [siblingSteer]
});

const transcriptSnapshot = snapshotOf({
    lastError: 'provider exploded',
    threads: [parentThread, childThread, siblingThread, grandThread],
    turns: [parentTurn, childTurn, siblingTurn, failedChildTurn]
});

const childTranscript = buildThreadTranscriptJson(transcriptSnapshot, 'thread-child', {
    generatedAt: 123
});

const childRelatedSteers = [
    {
        threadId: 'thread-child',
        turnId: 'turn-parent',
        turnIndex: 0,
        steerIndex: 0,
        steer: childSteer
    },
    {
        threadId: 'thread-grand',
        turnId: 'turn-parent',
        turnIndex: 0,
        steerIndex: 1,
        steer: grandSteer
    }
];

const childRelatedEvents = [
    {
        threadId: 'thread-child',
        invocationId: 'inv-child',
        relation: 'target' as const,
        turnId: 'turn-parent',
        turnIndex: 0,
        eventIndex: 2,
        eventTime: 30,
        event: childStart
    },
    {
        threadId: 'thread-child',
        invocationId: 'inv-child',
        relation: 'target' as const,
        turnId: 'turn-parent',
        turnIndex: 0,
        eventIndex: 3,
        eventTime: 40,
        event: childToolCall
    },
    {
        threadId: 'thread-child',
        invocationId: 'inv-child',
        relation: 'target' as const,
        turnId: 'turn-parent',
        turnIndex: 0,
        eventIndex: 4,
        eventTime: 50,
        event: childError
    },
    {
        threadId: 'thread-grand',
        invocationId: 'inv-grand',
        relation: 'descendant' as const,
        turnId: 'turn-parent',
        turnIndex: 0,
        eventIndex: 5,
        eventTime: 60,
        event: grandStart
    },
    {
        threadId: 'thread-grand',
        invocationId: 'inv-grand',
        relation: 'descendant' as const,
        turnId: 'turn-parent',
        turnIndex: 0,
        eventIndex: 6,
        eventTime: 70,
        event: grandResult
    }
];

beforeEach(() => {
    document.body.innerHTML = '';
    setClipboard(undefined);
    setExecCommand(undefined);
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.replaceChildren();
    setClipboard(undefined);
    setExecCommand(undefined);
});

describe('lossless JSON document', () => {
    it('copies the exact thread messages, every owned turn and child invocation provenance', () => {
        expect(childTranscript).toEqual({
            schema: 'underload.harness.thread-transcript',
            version: 1,
            generatedAt: 123,
            session: {
                id: 's1',
                harness: 'instruct',
                status: 'idle',
                updatedAt: 10,
                lastError: 'provider exploded'
            },
            thread: childThread,
            turns: [childTurn, failedChildTurn],
            relatedEvents: childRelatedEvents,
            relatedSteers: childRelatedSteers,
            limitations: [...THREAD_TRANSCRIPT_LIMITATIONS]
        });

        // Sibling events/thread fields and steers never leak into this conversation.
        expect(JSON.stringify(childTranscript)).not.toContain('sibling prompt');
        expect(JSON.stringify(childTranscript)).not.toContain('sibling failed');
        expect(JSON.stringify(childTranscript)).not.toContain('steer the sibling');
        expect(JSON.stringify(childTranscript)).not.toContain('owner-only steer');
        expect(childTranscript?.turns.map((turn) => turn.id)).toEqual([
            'turn-child',
            'turn-child-failed'
        ]);
        expect(childTranscript?.thread.messages).toEqual(childThread.messages);
        expect(childTranscript?.turns[1]).toBe(failedChildTurn);
        // Related steer audit is raw and complete: timestamp, prompt and references.
        expect(childTranscript?.relatedSteers).toEqual(childRelatedSteers);
        expect(childTranscript?.relatedSteers[0].steer).toMatchObject({
            at: 25,
            prompt: 'steer the child',
            threadId: 'thread-child',
            references: [{ turnId: 'turn-parent', threadId: 'thread-parent', label: 'RR1' }]
        });
        // The target's OWN turn keeps its raw `steers` unchanged and is not duplicated
        // into relatedSteers.
        expect(childTranscript?.turns[0].steers).toEqual(childTurn.steers);
        expect(childTranscript?.relatedSteers.map((entry) => entry.steer.prompt)).toEqual([
            'steer the child',
            'steer the grandchild'
        ]);
        expect(serializeThreadTranscript(childTranscript as NonNullable<typeof childTranscript>)).toBe(
            JSON.stringify(childTranscript, null, 2)
        );
        expect(threadTranscriptCopyText(transcriptSnapshot, 'thread-child', { generatedAt: 123 })).toBe(
            JSON.stringify(childTranscript, null, 2)
        );
    });

    it('states the harness tracing limits instead of fabricating API logs', () => {
        const transcript = buildThreadTranscriptJson(transcriptSnapshot, 'thread-child', {
            generatedAt: 1
        });

        expect(transcript?.limitations).toEqual([
            'No raw provider HTTP request/response bodies, headers, retries or network logs are recorded by this harness; only the events and usage values in this document exist.',
            'messages is the thread\'s committed transcript; while a thread is running, its newest messages may not be committed yet.',
            'session.lastError is session-scoped and may describe a failure that did not run in this thread.'
        ]);
    });

    it('returns undefined for an unknown thread (no fabricated identity)', () => {
        expect(buildThreadTranscriptJson(transcriptSnapshot, 'missing')).toBeUndefined();
        expect(threadTranscriptCopyText(transcriptSnapshot, 'missing')).toBeUndefined();
        expect(openThreadTranscript(transcriptSnapshot, 'missing')).toBeUndefined();
        expect(document.querySelector('.dialog')).toBeNull();
    });

    it('keeps a running snapshot honest and includes even zero-message threads', () => {
        const running = snapshotOf({
            status: 'running',
            threads: [
                threadOf({ id: 'thread-running', label: 'RR7', status: 'running', messages: [] })
            ],
            turns: [turnOf({ id: 'turn-running', index: 0, threadId: 'thread-running', status: 'running' })]
        });
        const transcript = buildThreadTranscriptJson(running, 'thread-running', { generatedAt: 9 });

        expect(transcript).toMatchObject({
            generatedAt: 9,
            session: { status: 'running' },
            thread: { id: 'thread-running', messages: [] },
            turns: [{ id: 'turn-running', status: 'running' }]
        });
        expect(transcript?.limitations).toContain(
            'messages is the thread\'s committed transcript; while a thread is running, its newest messages may not be committed yet.'
        );
    });

    it('renders the pretty JSON in the dialog and Copy writes the exact same text', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 456 });
        expect(handle).toBeDefined();
        expect(handle?.element.querySelector('.dialog-title')?.textContent).toBe(
            'Transcript · RR2 · Helper'
        );
        expect(handle?.element.querySelector('.thread-transcript-meta')?.textContent).toBe(
            'RR2 · Helper · idle · 2 turns · JSON snapshot'
        );
        const pre = handle?.element.querySelector<HTMLElement>('.thread-transcript-json');
        const transcript = buildThreadTranscriptJson(transcriptSnapshot, 'thread-child', {
            generatedAt: 456
        });
        expect(pre?.textContent).toBe(serializeThreadTranscript(transcript as NonNullable<typeof transcript>));
        expect(pre?.getAttribute('aria-label')).toBe('JSON transcript of thread RR2');

        const copy = document.querySelector<HTMLButtonElement>('.dialog .dialog-copy');
        if (copy === null) throw new Error('missing dialog copy button');
        copy.click();
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(pre?.textContent);
    });

    it('refreshes an open dialog from a newer snapshot and ignores stale/wrong sessions', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const scope = {};
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        const updated = snapshotOf({
            updatedAt: 99,
            status: 'error',
            lastError: 'provider exploded',
            threads: transcriptSnapshot.threads,
            turns: transcriptSnapshot.turns
        });
        expect(refreshOpenThreadTranscript(updated, scope)).toBe('updated');
        expect(handle.element.querySelector('.thread-transcript-meta')?.textContent).toBe(
            'RR2 · Helper · idle · 2 turns · JSON snapshot'
        );
        await copyDialog();
        expect(writeText).toHaveBeenCalledWith(
            handle.element.querySelector('.thread-transcript-json')?.textContent
        );

        // Same board, DIFFERENT session id: thread ids are session-scoped, so this
        // late answer must not rewrite the dialog.
        const before = handle.element.querySelector('.thread-transcript-json')?.textContent;
        expect(
            refreshOpenThreadTranscript({ ...updated, id: 'other-session' }, scope)
        ).toBe('ignored');
        expect(handle.element.querySelector('.thread-transcript-json')?.textContent).toBe(before);

        // A snapshot that no longer names the thread closes the dialog instead of
        // leaving stale JSON labelled as that conversation.
        expect(
            refreshOpenThreadTranscript(
                snapshotOf({ threads: [parentThread], turns: [] }),
                scope
            )
        ).toBe('closed');
        expect(handle.isOpen).toBe(false);
        expect(document.querySelector('.dialog')).toBeNull();
    });

    it('closes only the tracked transcript for the requested scope/threads', () => {
        const scope = {};
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        expect(closeThreadTranscript({}, ['thread-child'])).toBe(false);
        expect(closeThreadTranscript(scope, ['thread-parent'])).toBe(false);
        expect(handle.isOpen).toBe(true);
        expect(closeThreadTranscript(scope, ['thread-child'])).toBe(true);
        expect(handle.isOpen).toBe(false);
    });
});

// --- board helpers ---------------------------------------------------------

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): TurnBoard => {
    const board = createTurnBoard(options);
    document.body.replaceChildren(board.element);
    return board;
};

const useSnapshot = (board: TurnBoard, snapshot: SessionSnapshot): void => {
    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));
};

const tileAction = (turn: TurnHandle): HTMLElement => {
    const action = turn.element.querySelector<HTMLElement>('.tile-transcript-action');
    if (action === null) throw new Error('missing tile action bar');
    return action;
};

const actionButton = (root: ParentNode, selector: string): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`missing button ${selector}`);
    return button;
};

const copyDialog = async (): Promise<void> => {
    const button = document.querySelector<HTMLButtonElement>('.dialog .dialog-copy');
    if (button === null) throw new Error('missing dialog copy button');
    button.click();
    await flush();
};

const openTranscriptFrom = (bar: HTMLElement): void => {
    actionButton(bar, '.transcript-open').click();
};

describe('responsive thread action bar', () => {
    it('puts Transcript on the left and Delete on the right of an expanded tile', () => {
        const board = mount();
        const snapshot = snapshotOf({
            threads: [threadOf({ id: 'thread-a', label: 'RR1', messages: [] })],
            turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' })]
        });
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);

        const bar = tileAction(turn);
        expect(bar.hidden).toBe(false);
        expect(bar.classList.contains('tile-transcript-action')).toBe(true);
        expect([...bar.children].map((node) => node.className)).toEqual([
            'transcript-open action-transcript',
            'thread-delete',
            'thread-delete-confirm'
        ]);
        expect(bar.querySelector('.transcript-open .action-label')?.textContent).toBe('Transcript');
        expect(bar.querySelector('.transcript-open .action-glyph')?.textContent).toBe('{}');
        expect(bar.querySelector('.thread-delete .action-label')?.textContent).toBe('Delete');
        expect(bar.querySelector('.thread-delete .action-glyph')?.textContent).toBe('X');
        expect(actionButton(bar, '.transcript-open').getAttribute('aria-label')).toBe(
            'Open the JSON transcript of RR1'
        );
        expect(actionButton(bar, '.thread-delete').getAttribute('aria-label')).toBe(
            'Delete thread RR1'
        );
        // This standalone board has no DELETE transport; the control is honest
        // about that instead of pretending the action is wired.
        expect(actionButton(bar, '.thread-delete').title).toBe(
            'Thread deletion is not wired in this host.'
        );

        openTranscriptFrom(bar);
        expect(document.querySelector('.dialog-title')?.textContent).toBe(
            'Transcript · RR1 · Researcher'
        );
        expect(document.querySelector('.thread-transcript-json')).not.toBeNull();
    });

    it('shows the mobile glyphs and keeps the desktop labels in the stylesheet contract', () => {
        const stylesheetPath = ['src/frontend/styles.css', 'src/styles.css']
            .map((candidate) => resolve(process.cwd(), candidate))
            .find((candidate) => {
                try {
                    readFileSync(candidate);
                    return true;
                } catch {
                    return false;
                }
            });
        if (stylesheetPath === undefined) throw new Error('styles.css not found');
        const css = readFileSync(stylesheetPath, 'utf8');

        const barStart = css.indexOf(
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) {'
        );
        expect(barStart).toBeGreaterThan(-1);
        const barBlock = css.slice(barStart, css.indexOf('}', barStart));
        expect(barBlock).toContain('justify-content: space-between');
        expect(barBlock).toContain('flex-wrap: wrap');

        expect(css).toMatch(
            /@media \(max-width: 600px\)[\s\S]*?\.action-label \{\s*display: none;[\s\S]*?\.action-glyph \{\s*display: inline;/
        );
        expect(css).toMatch(/\.thread-delete \{\s*margin-left: auto;/);
        expect(css).toMatch(/\.action-glyph \{\s*display: none;/);
    });

    it('gives an expanded nested child conversation the same toolbar', () => {
        const board = mount();
        useSnapshot(board, transcriptSnapshot);
        const parent = board.adopt(parentTurn);

        const childRow = parent.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        expect(childRow).not.toBeNull();
        const childBar = childRow?.querySelector<HTMLElement>('.thread-transcript-action');
        expect(childBar?.hidden).toBe(true);

        expect(board.focusThread('thread-child')).toBe(true);
        expect(childBar?.hidden).toBe(false);
        expect(childBar?.querySelector('.transcript-open .action-label')?.textContent).toBe('Transcript');
        expect(actionButton(childBar as HTMLElement, '.thread-delete').getAttribute('aria-label')).toBe(
            'Delete thread RR2'
        );
    });

    it('gives a roster-only focused thread the same toolbar', () => {
        const board = mount();
        const snapshot = snapshotOf({
            threads: [
                threadOf({
                    id: 'thread-roster',
                    label: 'RR8',
                    messages: [{ role: 'user', content: 'roster question' }]
                })
            ]
        });
        useSnapshot(board, snapshot);

        expect(board.focusThread('thread-roster')).toBe(true);
        const panel = document.querySelector<HTMLElement>('.thread-focus-panel');
        expect(panel).not.toBeNull();
        const bar = panel?.querySelector<HTMLElement>('.thread-focus-actions');
        expect(bar?.hidden).toBe(false);
        expect(bar?.querySelector('.transcript-open .action-label')?.textContent).toBe('Transcript');
        expect(bar?.querySelector('.thread-delete .action-label')?.textContent).toBe('Delete');

        openTranscriptFrom(bar as HTMLElement);
        expect(document.querySelector('.dialog-title')?.textContent).toBe(
            'Transcript · RR8 · Researcher'
        );
    });

    it('keeps a JSON fallback available when a host does not provide a snapshot', () => {
        const board = mount();
        const entry: SessionThreadEntry = {
            id: 'thread-fallback',
            agent: 'Researcher',
            origin: 'host',
            status: 'idle',
            sequence: 1,
            label: 'RR9',
            messages: [{ role: 'user', content: 'fallback question' }]
        };
        board.bindSession('s1');
        board.setThreads([entry]);
        const turn = board.adopt(
            turnOf({ id: 'turn-fallback', index: 0, threadId: 'thread-fallback' })
        );
        board.expand(turn);
        openTranscriptFrom(tileAction(turn));

        const parsed = JSON.parse(
            document.querySelector<HTMLElement>('.thread-transcript-json')?.textContent ?? '{}'
        ) as { thread: { id: string; messages: unknown[] }; turns: unknown[] };
        expect(parsed.thread.id).toBe('thread-fallback');
        expect(parsed.thread.messages).toEqual([{ role: 'user', content: 'fallback question' }]);
        expect(parsed.turns).toHaveLength(1);
    });
});

// --- deletion --------------------------------------------------------------

const hostTarget = (overrides: Partial<SessionThread> = {}): SessionSnapshot =>
    snapshotOf({
        threads: [threadOf({ id: 'thread-a', label: 'RR1', ...overrides })],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' })]
    });

const deleteButton = (bar: HTMLElement): HTMLButtonElement =>
    actionButton(bar, '.thread-delete');
const confirmBox = (bar: HTMLElement): HTMLElement => {
    const box = bar.querySelector<HTMLElement>('.thread-delete-confirm');
    if (box === null) throw new Error('missing delete confirmation');
    return box;
};

describe('confirmed thread deletion', () => {
    it('sends no request before confirm, cancel sends none, confirm sends exactly one', async () => {
        const calls: [string, string][] = [];
        let resolveDelete: ((value: DeleteThreadResult) => void) | undefined;
        const board = mount({
            deleteThread: async (sessionId, threadId) => {
                calls.push([sessionId, threadId]);
                return new Promise<DeleteThreadResult>((resolve) => {
                    resolveDelete = resolve;
                });
            }
        });
        const snapshot = hostTarget();
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);
        const bar = tileAction(turn);

        deleteButton(bar).click();
        expect(confirmBox(bar).hidden).toBe(false);
        expect(calls).toEqual([]);

        actionButton(bar, '.thread-delete-confirm-cancel').click();
        expect(confirmBox(bar).hidden).toBe(true);
        expect(calls).toEqual([]);

        deleteButton(bar).click();
        const yes = actionButton(bar, '.thread-delete-confirm-delete');
        expect(yes.textContent).toBe('Delete thread');
        yes.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(confirmBox(bar).hidden).toBe(true);
        expect(deleteButton(bar).disabled).toBe(true);

        // A second confirm/pointer event while the DELETE is in flight is a no-op.
        yes.click();
        deleteButton(bar).click();
        await flush();
        expect(calls).toHaveLength(1);

        resolveDelete?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();
        // Success collapses the edited surface (focus is cleared) and the DELETE is
        // no longer in flight; re-expanding paints a usable toolbar again.
        expect(bar.hidden).toBe(true);
        board.expand(turn);
        expect(deleteButton(bar).disabled).toBe(false);
    });

    it('closes focus/transcript and removes the row on a successful shell snapshot', async () => {
        let boardRef: TurnBoard | undefined;
        const board = mount({
            deleteThread: async (_sessionId, threadId) => {
                expect(threadId).toBe('thread-a');
                const remaining = snapshotOf({ updatedAt: 20, threads: [], turns: [] });
                // The real shell applies the returned snapshot through reconcile;
                // reproduce that exact reconciliation here so tile/focus behavior is
                // exercised, not a board-local shortcut.
                boardRef?.reconcile([], {});
                boardRef?.setThreads([]);
                boardRef?.setSessionSnapshot(remaining);
                return { deleted: true, session: remaining };
            }
        });
        boardRef = board;
        const snapshot = hostTarget();
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);

        openTranscriptFrom(tileAction(turn));
        expect(document.querySelector('.dialog')).not.toBeNull();

        deleteButton(tileAction(turn)).click();
        actionButton(tileAction(turn), '.thread-delete-confirm-delete').click();
        await flush();

        expect(board.turns()).toHaveLength(0);
        expect(board.focusedThread()).toBeUndefined();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(document.querySelector('.thread-focus-panel')).toBeNull();
    });

    it('keeps the thread, focus and data when DELETE fails', async () => {
        const board = mount({
            deleteThread: async () => {
                throw new Error('Thread "thread-a" still has live work; wait for it to stop before deleting it.');
            }
        });
        const snapshot = hostTarget();
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);

        deleteButton(tileAction(turn)).click();
        actionButton(tileAction(turn), '.thread-delete-confirm-delete').click();
        await flush();

        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(tileAction(turn).hidden).toBe(false);
        expect(deleteButton(tileAction(turn)).disabled).toBe(false);
        const notice = document.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe(
            'delete thread: Thread "thread-a" still has live work; wait for it to stop before deleting it.'
        );
    });

    it('hides Delete for a default agent conversation and disables it for live work', () => {
        const board = mount();
        const defaultEntry = threadOf({ id: 'thread-agent', origin: 'agent', label: 'RR5', messages: [] });
        const running = threadOf({
            id: 'thread-running',
            status: 'running',
            label: 'RR6',
            messages: []
        });
        const snapshot = snapshotOf({
            threads: [defaultEntry, running],
            turns: [
                turnOf({ id: 'turn-agent', index: 0, threadId: 'thread-agent' }),
                turnOf({ id: 'turn-running', index: 1, threadId: 'thread-running', status: 'running' })
            ]
        });
        useSnapshot(board, snapshot);

        const defaultTurn = board.adopt(snapshot.turns[0]);
        board.expand(defaultTurn);
        const defaultBar = tileAction(defaultTurn);
        expect(deleteButton(defaultBar).hidden).toBe(true);
        expect(actionButton(defaultBar, '.transcript-open').hidden).toBe(false);

        const runningTurn = board.adopt(snapshot.turns[1]);
        board.expand(runningTurn);
        const runningBar = tileAction(runningTurn);
        expect(deleteButton(runningBar).hidden).toBe(false);
        expect(deleteButton(runningBar).disabled).toBe(true);
        expect(deleteButton(runningBar).title).toBe(
            'Stop the active or queued work in this thread before deleting it.'
        );

        deleteButton(runningBar).click();
        expect(confirmBox(runningBar).hidden).toBe(true);
    });

    it('protects a queued turn and a running descendant subtree', () => {
        const queuedEntry = threadOf({ id: 'thread-queued', label: 'RR1', messages: [] });
        const queuedTurn = turnOf({
            id: 'turn-queued',
            index: 0,
            threadId: 'thread-queued',
            status: 'queued',
            startedAt: undefined
        });
        expect(threadDeleteProtectionOf(queuedEntry, [queuedEntry], [queuedTurn])).toBe('active');

        const parent = threadOf({ id: 'thread-parent', label: 'RR1', messages: [] });
        const child = threadOf({
            id: 'thread-child',
            label: 'RR2',
            ownerThreadId: 'thread-parent',
            status: 'running',
            messages: []
        });
        expect(threadSubtreeIdsOf('thread-parent', [parent, child])).toEqual(
            new Set(['thread-parent', 'thread-child'])
        );
        expect(threadDeleteProtectionOf(parent, [parent, child], [])).toBe('active');
        expect(threadDeleteProtectionOf(child, [parent, child], [])).toBe('active');
    });

    it('shows the protected state in a nested descendant row', () => {
        const board = mount();
        const parent = threadOf({
            id: 'thread-parent',
            label: 'RR1',
            invocationId: 'inv-parent',
            messages: []
        });
        const child = threadOf({
            id: 'thread-child',
            label: 'RR2',
            agent: 'Helper',
            ownerThreadId: 'thread-parent',
            invocationId: 'inv-child',
            status: 'running',
            messages: []
        });
        const snapshot = snapshotOf({
            threads: [parent, child],
            turns: [
                turnOf({
                    id: 'turn-parent',
                    index: 0,
                    threadId: 'thread-parent',
                    events: [
                        withThread(
                            { type: 'start', agent: 'Researcher', model: 'r1' },
                            invocation('inv-parent')
                        ),
                        {
                            type: 'tool_call',
                            agent: 'Researcher',
                            call: {
                                id: 'call-1',
                                name: 'agentDelegate',
                                arguments: JSON.stringify({ agent: 'Helper', input: 'child' })
                            }
                        },
                        withThread(
                            { type: 'start', agent: 'Helper', model: 'h1' },
                            { ...invocation('inv-child', 'inv-parent'), input: 'child' }
                        )
                    ]
                })
            ]
        });
        useSnapshot(board, snapshot);
        const parentTurn = board.adopt(snapshot.turns[0]);
        board.focusThread('thread-child');

        const childRow = parentTurn.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        const childBar = childRow?.querySelector<HTMLElement>('.thread-transcript-action');
        expect(childBar?.hidden).toBe(false);
        expect(deleteButton(childBar as HTMLElement).disabled).toBe(true);
    });

    it('keeps a same-id delete in a new session in flight when the old request resolves', async () => {
        const requests: Array<{
            sessionId: string;
            threadId: string;
            resolve: (value: DeleteThreadResult) => void;
        }> = [];

        const board = mount({
            deleteThread: (sessionId, threadId) =>
                new Promise<DeleteThreadResult>((resolve) => {
                    requests.push({ sessionId, threadId, resolve });
                })
        });

        const first = snapshotOf({
            id: 's1',
            threads: [threadOf({ id: 'thread-a', label: 'RR1', messages: [] })],
            turns: [turnOf({ id: 'turn-1', index: 0, threadId: 'thread-a' })]
        });
        useSnapshot(board, first);
        const firstTurn = board.adopt(first.turns[0]);
        board.expand(firstTurn);
        deleteButton(tileAction(firstTurn)).click();
        actionButton(tileAction(firstTurn), '.thread-delete-confirm-delete').click();
        await flush();

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ sessionId: 's1', threadId: 'thread-a' });
        expect(deleteButton(tileAction(firstTurn)).disabled).toBe(true);

        // Session switch: the SAME persistent thread id is legal because thread ids
        // are only unique inside one session. The new board starts its own DELETE.
        const second = snapshotOf({
            id: 's2',
            threads: [threadOf({ id: 'thread-a', label: 'RR2', messages: [] })],
            turns: [turnOf({ id: 'turn-2', index: 0, threadId: 'thread-a' })]
        });
        useSnapshot(board, second);
        const reconciled = board.reconcile(second.turns, {});
        const secondTurn = reconciled[0];
        board.expand(secondTurn);
        deleteButton(tileAction(secondTurn)).click();
        actionButton(tileAction(secondTurn), '.thread-delete-confirm-delete').click();
        await flush();

        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ sessionId: 's2', threadId: 'thread-a' });
        expect(deleteButton(tileAction(secondTurn)).disabled).toBe(true);

        // The OLD request resolves: its finally must remove only its own composite
        // key/suppression token, not the new session's in-flight delete.
        requests[0].resolve({ deleted: true, session: first });
        await flush();

        expect(deleteButton(tileAction(secondTurn)).disabled).toBe(true);
        expect(confirmBox(tileAction(secondTurn)).hidden).toBe(true);

        requests[1].resolve({ deleted: true, session: second });
        await flush();
        expect(requests).toHaveLength(2);
    });

    it('does nothing while deletion is not wired by the embedding host', () => {
        const board = mount();
        const snapshot = hostTarget();
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);

        const bar = tileAction(turn);
        expect(deleteButton(bar).disabled).toBe(true);
        expect(deleteButton(bar).title).toBe('Thread deletion is not wired in this host.');
        deleteButton(bar).click();
        expect(confirmBox(bar).hidden).toBe(true);
    });
});
