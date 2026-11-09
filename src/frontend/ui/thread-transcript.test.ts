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
//   - dialog body and Copy action are the SAME pretty JSON string, resolved at CLICK
//     time from the rendered surface (T1/R3), including through the insecure-origin
//     execCommand fallback the LAN deployment depends on;
//   - T1 layout contract: the JSON `<pre>` is the dialog's only vertical scroller (the
//     body is opened in the shell's `dialog-body--fill` mode), so the identity line and
//     the "Edit transcript" row are SIBLINGS around it and never scroll away; and the
//     copy icon lives at the right end of the identity line ("… · JSON snapshot"),
//     not in the modal header. T3 adds what that scroller owes the keyboard: the `<pre>`
//     is focusable (`tabindex="0"`) with the shell's `:focus-visible` ring, and the two
//     disclosure rows keep a non-shrinking, self-capped height so a short viewport
//     neither collapses them nor clips the action row. T4 finishes the original request:
//     the read-mode row ends its line, so "Edit transcript" sits on the right edge under
//     the copy icon (scoped `justify-content: flex-end`, edit mode unchanged).
//   - refresh updates an open dialog from a newer snapshot, ignores a stale
//     session and CLOSES when the thread vanished;
//   - T26 action-bar anatomy (the controls SWAPPED homes): ONE bar per surface — an
//     expanded turn tile, an expanded nested child card and the roster-only focus
//     panel — whose children are EXACTLY, in order, `Delete` and `Transcript` (T6/R5
//     retired the third child, the inline confirmation row, and moved that step into the
//     shared dialog). Delete leads the bar at the left edge and Transcript closes
//     it (styles.css `margin-left: auto`), i.e. exactly where each other one used to
//     be painted; there is NO header control host any more (`.tile-header-action`,
//     `.thread-header-action` and `.thread-focus-head-action` are gone from the DOM
//     and from the stylesheet) and the header's freed right edge carries the
//     elapsed|tokens measurement line ON the badge's own line (row-wrap header).
//     Labels are desktop text, mobile glyphs, and `aria-label` always carries the
//     accessible name;
//   - visibility is the BAR's own `hidden` (it follows the surface: a collapsed tile
//     or card hides it, expansion/focus reveals it) — the paired header host that
//     used to toggle alongside it no longer exists. Delete's own `hidden` is the
//     default-conversation protection, and it never hides the bar's Transcript;
//   - delete is confirmed before it is sent, and the confirmation is responsive (T6/R5):
//     a proven wide fine-pointer desktop deletes on the first press, every other surface
//     (narrow, coarse, `none`, or an engine without `matchMedia` — which is what this
//     jsdom is) opens the SHARED dialog layer with `Delete thread` and `Cancel`. The
//     action bar itself owns no inline confirmation row any more. Deletion stays
//     deduped while in flight, disabled for default/running/queued/descendant work, keeps
//     data on failure and closes focus/transcript on success.
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
        call: { id: 'call-child', name: 'read', arguments: '{"path":"a.ts"}' }
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
        name: 'read',
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
                name: 'delegate',
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

        const copy = document.querySelector<HTMLButtonElement>('.dialog .thread-transcript-meta-copy');
        if (copy === null) throw new Error('missing transcript meta copy button');
        copy.click();
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(pre?.textContent);
        // The shared control's feedback: the hidden live word announces the outcome and
        // the button keeps its stable accessible name (ui/dialog.ts, pinned in
        // ui/dialog-copy.test.ts for the header variant).
        expect(copy.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
        expect(copy.getAttribute('aria-label')).toBe('Copy the transcript JSON');
    });

    // T1: the copy icon moved OUT of the modal header and onto the identity line, right
    // after the "… · JSON snapshot" text. This pins the anatomy the layout depends on:
    // the header has no copy control, the meta row is text-then-icon, and the visible
    // label is unchanged.
    it('puts the copy icon on the meta row instead of the dialog header (T1)', () => {
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 456 });
        if (handle === undefined) throw new Error('transcript did not open');

        expect(handle.element.querySelectorAll('.dialog-copy')).toHaveLength(0);
        // The header is exactly the title and the dismiss control, like every dialog
        // without the shell's opt-in `copy` source (ui/dialog.test.ts pins the default).
        const head = handle.element.querySelector<HTMLElement>('.dialog-head');
        if (head === null) throw new Error('missing dialog head');
        expect([...head.children].map((node) => node.className)).toEqual(['dialog-title', 'dialog-close']);

        const meta = handle.element.querySelector<HTMLElement>('.thread-transcript-meta');
        if (meta === null) throw new Error('missing transcript meta row');
        expect([...meta.children].map((node) => node.className)).toEqual([
            'thread-transcript-meta-text',
            'text-copy thread-transcript-meta-copy'
        ]);
        // The exact visible label, and the icon is the LAST child of the row: immediately
        // after the "… JSON snapshot" text, at its right edge.
        expect(meta.querySelector<HTMLElement>('.thread-transcript-meta-text')?.textContent).toBe(
            'RR2 · Helper · idle · 2 turns · JSON snapshot'
        );
        expect(meta.querySelector('.thread-transcript-meta-copy')?.lastElementChild?.className).toBe(
            'dialog-copy-feedback'
        );
    });

    // T1: the scrolling contract as DOM structure (jsdom has no layout, so the CSS side is
    // pinned by the stylesheet test below). The document and the "Edit transcript" row are
    // SIBLINGS under one host: the action row is not inside the scrollable <pre>, so a
    // filling body plus `flex: 0 0 auto` on the row keeps it visible at the panel's cap.
    it('keeps the action row outside the scrolling document, after it', () => {
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 456 });
        if (handle === undefined) throw new Error('transcript did not open');

        // The body is opted into the shell's fill mode: it no longer scrolls (styles.css /
        // dialog.css keep the scrollbar inside the JSON area).
        const body = handle.element.querySelector<HTMLElement>('.dialog-body');
        if (body === null) throw new Error('missing dialog body');
        expect(body.className).toBe('dialog-body dialog-body--fill');

        const host = handle.element.querySelector<HTMLElement>('.thread-transcript');
        if (host === null) throw new Error('missing transcript host');
        // R1: the document is the app's payload viewer, so the box carries ITS host class
        // (the flex chain, the cap and the focus ring in styles.css address it) plus the
        // viewer's classes — `code-block` for the line machinery and `tool-code` for the
        // soft wrap that outranks `ui/dialog.css` `.dialog-body pre { white-space: pre }`.
        // Exact and complete: one `<pre>`, three classes, in this order.
        expect([...host.children].map((node) => node.className)).toEqual([
            'thread-transcript-meta',
            'code-block thread-transcript-json tool-code',
            'thread-transcript-actions thread-transcript-read-actions'
        ]);
        expect(body.children).toHaveLength(1);
        expect(body.firstElementChild).toBe(host);

        // The document is the only element that scrolls; the rows around it are not.
        expect(handle.element.querySelectorAll('.thread-transcript-json')).toHaveLength(1);
        const actions = host.querySelector<HTMLElement>('.thread-transcript-read-actions');
        if (actions === null) throw new Error('missing read-mode action row');
        // `previousElementSibling` (not `...ElementChild`): the sibling relation is what
        // "immediately after the document" means, and it is the property this repo's
        // jsdom supports (see ui/turns-attachments.test.ts).
        expect(actions.previousElementSibling).toBe(host.querySelector('.thread-transcript-json'));
        expect(actions.parentElement).toBe(host);
        expect(actions.querySelector<HTMLButtonElement>('.thread-transcript-edit')?.textContent).toBe(
            'Edit transcript'
        );
    });

    // T1/R3: the plain-HTTP LAN host (src/frontend/deployment.ts, vite.config.ts) has
    // NO `navigator.clipboard`, so the transcript dialog's copy must work through the
    // execCommand fallback — and must write what is DISPLAYED. `navigator.clipboard` is
    // absent here (jsdom defines nothing unless a test installs it), which is exactly
    // that deployment.
    it('copies the displayed JSON through the insecure-origin fallback', async () => {
        let copied: string | undefined;
        let focusedHelper = false;
        setExecCommand((command) => {
            const area = document.querySelector<HTMLTextAreaElement>('.dialog-copy-buffer');
            copied = area?.value;
            focusedHelper = document.activeElement === area;
            return command === 'copy';
        });

        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 789 });
        if (handle === undefined) throw new Error('transcript did not open');
        const pre = handle.element.querySelector<HTMLElement>('.thread-transcript-json');
        if (pre === null) throw new Error('missing transcript surface');

        const copy = document.querySelector<HTMLButtonElement>('.dialog .thread-transcript-meta-copy');
        if (copy === null) throw new Error('missing transcript meta copy button');
        copy.click();
        await flush();

        // Byte-identical to the rendered document, copied from a focused helper so the
        // selection actually belongs to the copy command.
        expect(copied).toBe(pre.textContent);
        expect(copied).toContain('"schema": "underload.harness.thread-transcript"');
        expect(focusedHelper).toBe(true);
        expect(copy.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');

        setExecCommand(undefined);
    });

    // T1/R3: Copy is a CLICK-TIME provider. A refresh replaces both the surface and the
    // source, so a stale pre can never be reported as the current transcript.
    it('copies the refreshed document, not the one first rendered', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const scope = {};
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', scope, { generatedAt: 1 });
        if (handle === undefined) throw new Error('transcript did not open');
        const first = handle.element.querySelector<HTMLElement>('.thread-transcript-json')?.textContent;

        expect(
            refreshOpenThreadTranscript(
                snapshotOf({
                    updatedAt: 42,
                    status: 'error',
                    lastError: 'provider exploded',
                    threads: transcriptSnapshot.threads,
                    turns: transcriptSnapshot.turns
                }),
                scope
            )
        ).toBe('updated');

        await copyDialog();

        const current = handle.element.querySelector<HTMLElement>('.thread-transcript-json')?.textContent;
        expect(current).not.toBe(first);
        expect(writeText).toHaveBeenLastCalledWith(current);
        expect(current).toContain('"lastError": "provider exploded"');
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

// --- T1: the scrolling + copy-icon layout, pinned in the stylesheet sources ----------
//
// jsdom computes no layout, so the "only the JSON area scrolls" and "the icon sits at
// the right end of the meta row" claims are pinned the way every other layout test in
// this package does: by reading the CSS the browser will actually apply
// (layout-containment.test.ts, tool-chip-style.test.ts, dialog.test.ts).
describe('transcript dialog layout contract', () => {
    const sourceOf = (candidates: string[]): string => {
        const path = candidates
            .map((candidate) => resolve(process.cwd(), candidate))
            .find((candidate) => {
                try {
                    readFileSync(candidate);
                    return true;
                } catch {
                    return false;
                }
            });
        if (path === undefined) throw new Error(`${candidates[0]} not found`);
        return readFileSync(path, 'utf8');
    };

    const styles = sourceOf(['src/frontend/styles.css', 'src/styles.css']);
    const shell = sourceOf(['src/frontend/ui/dialog.css', 'ui/dialog.css']);

    // Rule body by brace matching, anchored to a selector that STARTS a line so a
    // descendant selector ending in the same class cannot be sliced instead (the
    // `.thread-transcript-actions` group below is exactly that case). Comments are
    // stripped first: they NAME the selectors under test, and an assertion about a
    // "gone" declaration must run against declarations only.
    const blockOf = (css: string, selector: string): string => {
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const start = rules.indexOf(`\n${selector}`);
        if (start < 0) throw new Error(`missing selector ${selector}`);

        const open = rules.indexOf('{', start);
        if (open < 0) throw new Error(`missing body for ${selector}`);

        let depth = 0;
        for (let index = open; index < rules.length; index += 1) {
            if (rules[index] === '{') depth += 1;
            if (rules[index] === '}') {
                depth -= 1;
                if (depth === 0) return rules.slice(open + 1, index);
            }
        }

        throw new Error(`unbalanced block for ${selector}`);
    };

    it('hands the vertical scroll to the JSON area and never to the dialog body', () => {
        // The shell half: fill mode turns the body into a NON-scrolling stretched column,
        // and it is a separate rule so the default body (every other dialog) keeps its
        // historical `overflow: auto` scroll container.
        const fill = blockOf(shell, '.dialog-body--fill {');
        expect(fill).toContain('overflow: hidden');
        expect(blockOf(shell, '.dialog-body {')).toContain('overflow: auto');

        // The chain: the host fills the body and may shrink below its content height...
        const host = blockOf(styles, '.dialog-body--fill > .thread-transcript {');
        expect(host).toContain('flex: 1 1 auto');
        expect(host).toContain('min-height: 0');

        // ...the document takes what is left and scrolls its own overflow, which puts the
        // scrollbar at the right edge of the JSON box instead of the panel's far edge.
        const pre = blockOf(styles, '.dialog-body--fill > .thread-transcript > .thread-transcript-json {');
        expect(pre).toContain('flex: 1 1 auto');
        expect(pre).toContain('min-height: 0');
        expect(pre).toContain('max-height: none');
        const base = blockOf(styles, '.thread-transcript-json {');
        expect(base).toContain('overflow: auto');
        expect(base).toContain('overscroll-behavior: contain');

        // ...and the rows around it are intrinsic, so a long document shrinks the <pre>,
        // never the identity line or the Edit control.
        expect(blockOf(styles, '.dialog-body--fill > .thread-transcript > .thread-transcript-actions {')).toContain(
            'flex: 0 0 auto'
        );
        expect(blockOf(styles, '.thread-transcript-meta {')).toContain('flex: 0 0 auto');

        // T3: the row gaps are the first thing that gives way, because at innerHeight 266
        // the four 14px gaps were part of what pushed a capped panel past its own body.
        expect(host).toContain('gap: clamp(6px, 1.6vh, 14px)');

        // T3: the disclosure rows are disclosure, not filler. With a shrinking basis,
        // headless Chrome measured the scope note at ~0.94px (innerHeight 306) and the
        // banner at ~18.5px (266) — a content box of about nothing. Both rows are now
        // intrinsic and cap their OWN height instead, then scroll, so a long provider
        // message can neither collapse into a sliver nor push the clipped action row out.
        const disclosure = blockOf(
            styles,
            '.dialog-body--fill > .thread-transcript > :is(.thread-transcript-note, .thread-transcript-error) {'
        );
        expect(disclosure).toContain('flex: 0 0 auto');
        expect(disclosure).toContain('max-height: clamp(34px, 20vh, 132px)');
        expect(disclosure).toContain('overflow: auto');
        expect(disclosure).not.toContain('flex: 0 1 auto');

        // T3: and one short-panel tier, because at innerHeight 168 the FIXED chrome
        // (head + body inset + four gaps + meta + action row) already measured 155px
        // against a 134px capped panel: only compaction that does not touch the banner,
        // the note, the field or the buttons can keep the action row inside the body.
        const shortTier = blockOf(styles, '@media (max-height: 560px) {');
        expect(shortTier).toContain('.dialog-body--fill {');
        expect(shortTier).toContain('padding: 8px 12px;');
        expect(shortTier).toContain('.dialog-body--fill > .thread-transcript {');
        expect(shortTier).toContain('gap: 6px;');
        expect(shortTier).toContain('max-height: clamp(30px, 11vh, 72px);');

        // Edit mode keeps the same contract: the textarea fills the space the identity
        // line, the banner, the note and the action row leave, and scrolls its own text
        // (the standalone 60vh cap is what used to push the row below the fold).
        const editor = blockOf(
            styles,
            '.dialog-body--fill > .thread-transcript-editing > .thread-transcript-editor {'
        );
        expect(editor).toContain('flex: 1 1 auto');
        expect(editor).toContain('min-height: 0');
        expect(editor).toContain('max-height: none');
        expect(editor).toContain('overflow: auto');
    });

    // T3: the document became the dialog's ONLY vertical scroller, so it has to be
    // keyboard-reachable (arrows / PageUp / PageDown scroll an `overflow: auto` box only
    // once that box can take focus) and the keyboard focus has to be painted with the
    // ring the rest of the shell already uses.
    it('makes the sole scroller focusable with the shell focus ring', () => {
        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 456 });
        if (handle === undefined) throw new Error('transcript did not open');

        const pre = handle.element.querySelector<HTMLElement>('.thread-transcript-json');
        if (pre === null) throw new Error('missing transcript surface');
        expect(pre.getAttribute('tabindex')).toBe('0');
        // It joins the modal's Tab cycle: ui/dialog.ts drops only `tabIndex < 0` from the
        // focusable set, so `-1` would have stranded the keyboard outside the document.
        expect(pre.tabIndex).toBe(0);

        // The ring is the shell's existing token pair, and it is `:focus-visible` only so
        // selecting text with the mouse does not paint a ring nobody asked for.
        const ring = blockOf(styles, '.thread-transcript-json:focus-visible {');
        expect(ring).toContain('outline: 2px solid var(--accent)');
        expect(ring).toContain('outline-offset: 2px');

        // Edit mode is untouched: the field was already the tabbable surface, and it has
        // its own focus styling in the standalone rule.
        actionButton(handle.element, '.thread-transcript-edit').click();
        expect(handle.element.querySelector('.thread-transcript-editor')?.getAttribute('tabindex')).toBeNull();
    });

    // T4: the user asked for the "Edit transcript" action ON THE RIGHT SIDE of the modal.
    // jsdom computes no layout, so the pin is the declaration the browser will apply plus
    // the row's own anatomy: the read row ends its line, the shared row and the EDIT row
    // keep the arrangement they were designed with, and the row still carries one real,
    // enabled control inside the non-scrolling part of the fill chain.
    it('flushes the read-mode action row right and leaves the edit row alone', () => {
        const read = blockOf(styles, '.thread-transcript-read-actions {');
        expect(read).toContain('justify-content: flex-end');

        // Scoped on purpose: the shared row has no two-ended alignment of its own, so the
        // edit row (Save, Cancel, then Copy pushed right by its OWN margin) is untouched by
        // this rule.
        expect(blockOf(styles, '.thread-transcript-actions {')).not.toContain('justify-content');
        expect(blockOf(styles, '.thread-transcript-copy {')).toContain('margin-left: auto');

        // Vertical sizing is unchanged: the row stays intrinsic in the fill chain, so
        // right-aligning it cannot make it the thing that shrinks or scrolls away.
        expect(blockOf(styles, '.dialog-body--fill > .thread-transcript > .thread-transcript-actions {')).toContain(
            'flex: 0 0 auto'
        );

        const handle = openThreadTranscript(transcriptSnapshot, 'thread-child', {}, { generatedAt: 456 });
        if (handle === undefined) throw new Error('transcript did not open');

        const actions = handle.element.querySelector<HTMLElement>('.thread-transcript-read-actions');
        if (actions === null) throw new Error('missing read-mode action row');
        expect(actions.className).toBe('thread-transcript-actions thread-transcript-read-actions');
        expect([...actions.children].map((node) => node.className)).toEqual(['thread-transcript-edit']);
        const edit = actions.querySelector<HTMLButtonElement>('.thread-transcript-edit');
        if (edit === null) throw new Error('missing Edit transcript control');
        expect(edit.textContent).toBe('Edit transcript');
        expect(edit.disabled).toBe(false);

        // Entering the editor swaps in the OTHER row class, so `flex-end` cannot leak onto
        // the Save/Cancel/Copy arrangement.
        edit.click();
        expect(handle.element.querySelector('.thread-transcript-read-actions')).toBeNull();
        const editRow = handle.element.querySelector<HTMLElement>('.thread-transcript-edit-actions');
        if (editRow === null) throw new Error('missing edit-mode action row');
        expect([...editRow.children].map((node) => node.className)).toEqual([
            'thread-transcript-save',
            'thread-transcript-cancel',
            'text-copy thread-transcript-copy'
        ]);
    });

    it('lays the meta row out as text-then-icon with the icon flush right', () => {
        const meta = blockOf(styles, '.thread-transcript-meta {');
        expect(meta).toContain('display: flex');
        expect(meta).toContain('align-items: center');
        expect(meta).toContain('justify-content: space-between');
        expect(meta).toContain('gap: 10px');

        // The label shrinks and wraps rather than pushing the icon out of the panel.
        expect(blockOf(styles, '.thread-transcript-meta-text {')).toContain('min-width: 0');

        // The icon is an intrinsic square at the row's right edge, sized for an 11px mono
        // caption line (the shared `.dialog-copy-icon` glyph is restated here, exactly as
        // the tool pane's caption copy does).
        const copy = blockOf(styles, '.thread-transcript-meta-copy {');
        expect(copy).toContain('flex: 0 0 auto');
        expect(copy).toContain('width: 18px');
        expect(copy).toContain('height: 18px');
        expect(blockOf(styles, '.thread-transcript-meta-copy .dialog-copy-icon {')).toContain('width: 12px');

        // The state reinforcement (tick / exclamation colours) is painted from
        // `data-state` by the shared control, so the announcement is never colour-only.
        expect(blockOf(styles, ".thread-transcript-meta-copy[data-state='success'] {")).toContain(
            'color: var(--ok)'
        );
        expect(blockOf(styles, ".thread-transcript-meta-copy[data-state='error'] {")).toContain(
            'color: var(--danger)'
        );
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

// T1: the transcript's copy control lives on the meta row (`.thread-transcript-meta-copy`),
// not in the shared modal header. One helper so every copy assertion presses the icon the
// reader actually sees.
const copyDialog = async (): Promise<void> => {
    const button = document.querySelector<HTMLButtonElement>('.dialog .thread-transcript-meta-copy');
    if (button === null) throw new Error('missing transcript meta copy button');
    button.click();
    await flush();
};

const openTranscriptFrom = (bar: HTMLElement): void => {
    actionButton(bar, '.transcript-open').click();
};

describe('responsive thread action bar', () => {
    it('leads the bar with Delete and closes it with Transcript on an expanded turn tile (T26)', () => {
        const board = mount();
        const snapshot = snapshotOf({
            threads: [threadOf({ id: 'thread-a', label: 'RR1', messages: [] })],
            turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' })]
        });
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);
        board.expand(turn);

        // R2 half one: the header's FIRST line is the identity — the persistent-thread
        // badge ALONE (R3 took the state word off this line).
        const identity = turn.element.querySelector<HTMLElement>('.tile-identity');
        expect(identity).not.toBeNull();
        expect([...(identity?.children ?? [])].map((node) => node.className)).toEqual(['tile-thread']);
        expect(identity?.firstElementChild?.textContent).toBe('RR1');
        expect(identity?.querySelector('.tile-status-text')).toBeNull();
        // R3/T2: the measurement line carries the clock, the tally and, LAST, the state box
        // — the reader's line is `34.2s | 18,654 (37,376)` and the box is the state's
        // accessible name (styles.css clips the word to screen-reader-only in both header
        // states, so `- done` is never painted). The ` | ` between the figures is generated
        // CSS, so no value's own text node carries any decoration: the word stays exactly
        // `done` and each figure stays copy-pastable.
        expect([...(turn.element.querySelectorAll('.tile-top > *') ?? [])].map((node) => node.className)).toEqual([
            'tile-elapsed',
            'tile-tokens',
            'tile-status'
        ]);
        expect(turn.element.querySelector('.tile-top > .tile-status > .tile-status-text')?.textContent).toBe('done');

        // T26: the measurement line took the header's right-edge CONTROL slot, so it shares
        // the badge's ONE line (styles.css `.tile.is-expanded .tile-select` is a row-wrap:
        // identity `order: 0`, this line `order: 1; margin-left: auto`, meta `order: 2`
        // forced onto its own line) and no control floats over it any more.
        expect(turn.element.querySelector('.tile-header-action')).toBeNull();
        // The card is exactly header → bar → body: the bar sits between them, so both of
        // its actions are reachable without scrolling and vanish with expansion.
        expect([...turn.element.children].map((node) => node.className)).toEqual([
            'tile-select',
            'tile-transcript-action',
            'tile-body'
        ]);

        // T26: the bar holds BOTH actions now, in the requested order — destructive first,
        // transcript last. T6/R5 removed the third child it used to own, the inline
        // confirmation row: that step is the shared dialog now. T4/R2 adds the Resume
        // control as a PERMANENT middle child (hidden unless the roster says `stopped`), so
        // the DOM anatomy of a bar is three children on every surface, and the two actions
        // this thread needs are still the visible ones.
        const bar = tileAction(turn);
        expect(bar.hidden).toBe(false);
        expect(bar.classList.contains('tile-transcript-action')).toBe(true);
        expect([...bar.children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);

        const barDelete = actionButton(bar, '.thread-delete');
        expect(barDelete.querySelector('.action-label')?.textContent).toBe('Delete');
        expect(barDelete.querySelector('.action-glyph')?.textContent).toBe('X');
        expect(barDelete.getAttribute('aria-label')).toBe('Delete thread RR1');
        // This standalone board has no DELETE transport; the control is honest
        // about that instead of pretending the action is wired.
        expect(barDelete.title).toBe('Thread deletion is not wired in this host.');

        const barTranscript = actionButton(bar, '.transcript-open');
        expect(barTranscript.querySelector('.action-label')?.textContent).toBe('Transcript');
        expect(barTranscript.querySelector('.action-glyph')?.textContent).toBe('{}');
        expect(barTranscript.getAttribute('aria-label')).toBe('Open the JSON transcript of RR1');

        // T4/R2: this fixture's thread is `idle` — live but not halted — so the third child
        // is in the DOM and NOT painted. Visibility is the roster's decision alone.
        const barResume = actionButton(bar, '.resume-open');
        expect(barResume.hidden).toBe(true);
        expect(barResume.classList.contains('action-resume')).toBe(true);

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

        // The line block helper: exact rule body of the FIRST rule whose selector starts a
        // line (`\n` keeps `blockOf('.tile-top {')` off `.tile-top`-prefixed variants).
        // Line endings are normalised because the contract is the declarations, not the
        // file's newline style.
        const blockOf = (selector: string): string => {
            const at = css.indexOf(selector);
            if (at < 0) throw new Error(`missing selector ${selector}`);
            return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).replace(/\r\n/g, '\n');
        };

        const barStart = css.indexOf(
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) {'
        );
        expect(barStart).toBeGreaterThan(-1);
        const barBlock = css.slice(barStart, css.indexOf('}', barStart));
        expect(barBlock).toContain('flex-wrap: wrap');
        // T1/R2 + T26: the bar never uses a two-ended `justify-content`; the trailing
        // action is pushed right by its own `margin-left: auto` (below), which also keeps
        // Transcript flush right when Delete is hidden on an undeletable conversation.
        expect(barBlock).not.toContain('justify-content');

        // T26 → T4/R2: Transcript is still the TRAILING action, but the flush-right
        // `margin-left: auto` moved ONCE onto Resume — the first button of the right-hand
        // group `[Delete … gap … Resume Transcript]`, which is what puts Resume literally
        // next to Transcript with Transcript rightmost. The trailing button takes the auto
        // margin back ONLY while Resume is `hidden` (a thread that is not stopped, where a
        // `[hidden] { display: none !important }` box contributes no margin at all), so an
        // undeletable default conversation keeps Transcript pinned to the right edge. Both
        // rules stay ONE declaration each, and no standalone `.transcript-open` rule is
        // left holding the old auto margin.
        expect(blockOf('\n.resume-open {')).toBe('\n    margin-left: auto;\n');
        expect(blockOf('\n.resume-open[hidden] + .transcript-open {')).toBe(
            '\n    margin-left: auto;\n'
        );
        expect(/\n\.transcript-open \{/.test(css)).toBe(false);
        // T26: Delete is the LEADING action, so its ONLY own rule is the destructive colour
        // pair — the `margin-left: auto` that used to push it to the bar's right edge (and
        // the compact 92px header-slot sizing) is gone from every `.thread-delete` rule.
        const deleteRules = (css.match(/^\.thread-delete \{[^}]*\}/gm) ?? []).map((block) =>
            block.replace(/\r\n/g, '\n')
        );
        expect(deleteRules).toEqual([
            '.thread-delete {\n    padding: 4px 10px;\n    border: 1px solid var(--border-strong);\n    border-radius: var(--radius-sm);\n    background: var(--bg-elevated);\n    color: var(--text);\n    font: 500 11.5px/1.4 var(--sans);\n    cursor: pointer;\n}',
            '.thread-delete {\n    border-color: rgba(248, 113, 113, 0.45);\n    color: var(--danger);\n}'
        ]);

        // T1/R2: the state word is no longer right-aligned, and the identity pair is a
        // single order-0 line of the header.
        const statusRule = css.match(/:is\(\.tile-status, \.thread-status\) \{[\s\S]*?\}/)?.[0];
        expect(statusRule).toBeDefined();
        expect(statusRule).not.toContain('margin-left: auto');
        // T2 (identifier sizing): the identity line is INTRINSIC (`flex: 0 0 auto`), so a
        // narrow column shrinks the prompt instead of squeezing the badge wrapper — the
        // shrinkable wrapper was what turned `IT1`/`IT2`/`IT3` into `I…`, because the
        // badge's own `max-width` percentage resolved against it. T26: the cap now reserves
        // the MEASUREMENT CLUSTER the badge shares its line with (`4m09s | 42,212
        // (358,448)` ≈ 165px of 10.5px tabular mono + the 10px column gap), with a 120px
        // `max()` floor so a narrow nested column still reads; the old 92px reserve was
        // the absolutely positioned header Delete button.
        const identityRule = css.match(/\.tile-identity \{[\s\S]*?\}/)?.[0];
        expect(identityRule).toContain('order: 0');
        expect(identityRule).toContain('display: inline-flex');
        expect(identityRule).toContain('flex: 0 0 auto');
        expect(identityRule).toContain('max-width: max(120px, calc(100% - 176px))');
        expect(identityRule).toContain('min-width: 0');

        // R3/T2: the state word is no longer a VISIBLE suffix of the measurement line, so
        // the generated ' - ' that joined it to the figures is gone from the stylesheet
        // entirely (in either header state). `textContent` still holds the whole word, and
        // the sr-only clip below is what hides it, so the state is never colour-only for
        // assistive tech. Comments NAME the removed decoration (and the removed header
        // slots), so the "gone" assertions run against the stylesheet with comments
        // stripped.
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(rules).not.toContain("content: ' - '");
        expect(rules).not.toContain(':is(.tile-status, .thread-status)::before');
        // The line still renders EXACTLY as it reads: one spaced ` | ` between the two
        // figures, generated (never part of either value), and NO flex gap on the line —
        // a gap would leave dead space wherever a hidden label used to be.
        expect(
            blockOf(
                ':is(.tile-elapsed, .thread-elapsed):not([hidden]) + :is(.tile-tokens, .thread-tokens):not([hidden])::before {'
            )
        ).toContain("content: ' | '");
        expect(blockOf('\n.tile-top {')).toContain('gap: 0');
        expect(blockOf('\n.thread-top {')).toContain('gap: 0');
        // T2: the state word is clipped in BOTH header states by ONE rule, and the two
        // figures keep their ` | ` separator whether the block is collapsed or expanded.
        expect(
            blockOf(':is(.tile, .thread-tile) :is(.tile-status-text, .thread-status-text) {')
        ).toContain('clip-path: inset(50%)');

        // T26: the three header control hosts are gone from the DOM, so every rule that
        // positioned, sized or reserved room for them is gone too (`.tile-header-action`
        // on a turn tile, `.thread-header-action` on a nested card,
        // `.thread-focus-head-action` on the roster panel, plus the 92px/84px reserves
        // and the 17px/16px compact-slot sizing that used to centre the button on the
        // badge line).
        expect(rules).not.toContain('.tile-header-action');
        expect(rules).not.toContain('.thread-header-action');
        expect(rules).not.toContain('.thread-focus-head-action');
        expect(rules).not.toContain('> .thread-delete');
        expect(rules).not.toContain('padding-right: 92px');
        expect(rules).not.toContain('padding-right: 84px');
        expect(rules).not.toContain('max-width: calc(100% - 92px)');

        // T26: an expanded header is a flex ROW-WRAP — that is the whole mechanism that
        // puts the measurement line where Delete used to be: identity (`order: 0`) leads,
        // the figures (`order: 1`, `margin-left: auto`) close the SAME line flush right and
        // the meta (`order: 2`, `flex: 1 0 100%`) is pushed onto its own line by its basis.
        expect(css).toMatch(
            /\.tile\.is-expanded \.tile-select \{\s*flex-flow: row wrap;\s*align-items: baseline;\s*column-gap: 10px;\s*row-gap: 4px;/
        );
        expect(css).toMatch(/\.tile\.is-expanded \.tile-top \{\s*order: 1;\s*margin-left: auto;/);
        expect(css).toMatch(/\.tile\.is-expanded \.tile-meta \{\s*order: 2;\s*flex: 1 0 100%;/);
        // The nested card was ALWAYS one row with its line flush right (this is the
        // anatomy the main tile now matches), so nothing about it needed a reserve.
        expect(css).toMatch(/\n\.thread-top \{\s*order: 2;[\s\S]*?margin-left: auto;/);

        // The mobile glyph swap is ONE list of the three bars; the three header-slot
        // variants are gone, because those hosts no longer exist. Each swap rule is pinned
        // as the ONLY `:is(...) .action-*` override in the stylesheet, so a phone still
        // gets `X`/`{}` and nothing else can hide a desktop label.
        //
        // T4/R2: these are DESCENDANT rules over the whole bar, so the third action
        // (`Resume`, `▶`) inherits the swap with NO resume-specific selector — the pinned
        // "exactly one rule per node kind" list is what proves the mobile play icon comes
        // from the same mechanism, not from a copy that can drift.
        expect(css).toMatch(
            /@media \(max-width: 600px\) \{[\s\S]*?:is\(\.tile-transcript-action, \.thread-transcript-action, \.thread-focus-actions\) \.action-label \{\s*display: none;/
        );
        expect(rules.match(/:is\([^)]*\) \.action-label \{/g)).toEqual([
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) .action-label {'
        ]);
        expect(rules.match(/:is\([^)]*\) \.action-glyph \{/g)).toEqual([
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) .action-glyph {'
        ]);
        // Desktop default: the glyph exists in the DOM but is not painted (the accessible
        // name comes from `aria-label`, never from CSS).
        expect(blockOf('\n.action-glyph {')).toContain('display: none');

        // T26: no disclosure chevron anywhere — `<summary>` is neutralised as a BASE
        // element, so every `<details>` control (tool chip, think chip, anything added
        // later) inherits it; the per-chip `::before` triangles are deleted rather than
        // overridden. T4/R4 removed the last one with the endpoint accordion: the
        // settings open from the status-pill dialog now, whose TITLE is the label, so the
        // base rule is a plain marker reset with nothing left to override.
        expect(css).toMatch(/\nsummary \{\s*list-style: none;/);
        expect(css).toMatch(/\nsummary::-webkit-details-marker \{\s*display: none;/);
        expect(rules).not.toContain('.tool-summary::before');
        expect(css).not.toContain('.endpoint-summary');
    });

    // T2: the state word is not visible in EITHER header state, so the T5 clip machinery
    // that protected the Delete slot from a long word is gone — a word clipped into a 1px
    // box cannot paint over a neighbour. What the header still needs (and keeps) is a
    // SHRINKABLE line whose FIGURES clip, because on an expanded tile that line now shares
    // one row with the identity badge: the same overflow property the browser probes
    // measured (real Chrome, `Temp/t5/probe-status.html` and
    // `Temp/t2/probe-t2-header.html`: an un-shrinkable line ran 50px past a 300px nested
    // card's own border, and an unclipped word put 111px of ink in a 63px box).
    it('keeps the state word screen-reader-only and the measurement line shrinkable', () => {
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
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

        // ONE unscoped rule: the word is clipped in the collapsed row AND the expanded
        // header, and it is clipped rather than removed (`display: none` would drop it
        // from the accessibility tree, which is the whole point of keeping it).
        const word = css.match(
            /:is\(\.tile, \.thread-tile\) :is\(\.tile-status-text, \.thread-status-text\) \{([^}]*)\}/
        )?.[1];
        expect(word).toBeDefined();
        expect(word).toContain('position: absolute');
        expect(word).toContain('clip-path: inset(50%)');
        expect(word).not.toContain('display: none');

        // The per-state word rules must stay gone, including the `min-width: 1.5em`
        // legibility floor: a floor on a box that holds only a clipped word is dead space
        // at the END of the measurement line, which is now the line that owns the header's
        // right edge.
        expect(rules).not.toMatch(
            /:is\(\.tile\.is-expanded, \.thread-tile\.is-expanded\) :is\(\.tile-status(-text)?, \.thread-status(-text)?\) \{/
        );
        expect(rules).not.toContain('min-width: 1.5em');

        // R3/T26: the line has to be able to SHRINK and its numbers have to clip inside
        // their own boxes. T26 changed the reason, not the need: the figures no longer share
        // the header's right edge with an absolutely positioned Delete button, they share it
        // with the IDENTITY LINE on the same wrapped row, and an un-shrinkable
        // `34.2s | 18,654 (37,376)` still ran past the card's own border on a 300px nested
        // column. Clipping never rewrites `textContent`, so the figures stay selectable.
        const line = css.match(
            /:is\(\.tile\.is-expanded, \.thread-tile\.is-expanded\) :is\(\.tile-top, \.thread-top\) \{([^}]*)\}/
        )?.[1];
        expect(line).toBeDefined();
        expect(line).toContain('flex: 0 1 auto');
        expect(line).toContain('min-width: 0');
        const figures = css.match(
            /:is\(\.tile\.is-expanded, \.thread-tile\.is-expanded\)\s*:is\(\.tile-elapsed, \.thread-elapsed, \.tile-tokens, \.thread-tokens\) \{([^}]*)\}/
        )?.[1];
        expect(figures).toBeDefined();
        expect(figures).toContain('min-width: 0');
        expect(figures).toContain('overflow: hidden');
        expect(figures).toContain('text-overflow: ellipsis');

        // The line's colour is still the only VISIBLE state cue (the word is clipped), on
        // both block owners, and the reserve that used to defend the header slot is gone:
        // no `padding-right` on either header, because the row layout itself places the
        // figures and nothing floats over them.
        expect(css).toMatch(
            /:is\(\.tile, \.thread-tile\)\[data-state='done'\] :is\(\.tile-elapsed, \.tile-tokens, \.thread-elapsed, \.thread-tokens\) \{\s*color: var\(--ok\);/
        );
        expect(rules).not.toMatch(/\.tile\.is-expanded \.tile-top \{[^}]*padding-right:/);
        expect(rules).not.toMatch(/\.thread-tile\.is-expanded > \.thread-select \{[^}]*padding-right:/);
    });

    it('gives an expanded nested child conversation the same action bar', () => {
        const board = mount();
        useSnapshot(board, transcriptSnapshot);
        const parent = board.adopt(parentTurn);

        const childRow = parent.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        expect(childRow).not.toBeNull();
        // Scoped to THIS card: thread-child owns a grandchild row below it, and that row
        // carries its own bar of the same class.
        const tile = childRow?.querySelector<HTMLElement>(':scope > .thread-tile');
        const childBar = childRow?.querySelector<HTMLElement>(
            ':scope > .thread-tile > .thread-transcript-action'
        );
        // T26: a collapsed card has exactly ONE action surface and it is hidden; the header
        // control host that used to hide with it no longer exists at all.
        expect(tile?.querySelector('.thread-header-action')).toBeNull();
        expect(childBar?.hidden).toBe(true);

        expect(board.focusThread('thread-child')).toBe(true);
        expect(childBar?.hidden).toBe(false);
        // T26: header → bar → body, and the bar is Delete, Transcript, confirmation — the
        // identical anatomy of the main tile. T7 removed the card's header chevron again:
        // the collapsed row is itself the expander, so the card owns ONE control per slot
        // and the Collapse chevron lives in the section's footer, inside `.thread-body`
        // (rendered only in exactly this expanded state).
        // T26: header → bar → body, and the bar is its two actions — the identical
        // anatomy of the main tile (T6/R5: no inline confirmation row anywhere).
        expect([...(tile?.children ?? [])].map((node) => node.className)).toEqual([
            'thread-select',
            'thread-transcript-action',
            'thread-body'
        ]);
        expect([...(childBar?.children ?? [])].map((node) => node.className)).toEqual([
            'thread-delete',
            // T4/R2: the shared bar means the nested card gets the Resume slot for free
            // (rev2: it is PAINTED here — this conversation's newest row, `turn-child-failed`,
            // ended `error`, which is an answer that never arrived whatever the roster says),
            // with Transcript still rightmost.
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        // R3: the nested card's identity half is its conversation code alone; the state
        // word sits at the END of the nested measurement line, exactly as it does on the
        // main tile, so the two headers read as one component. That line was ALWAYS flush
        // right (`.thread-top` is `order: 2; margin-left: auto`) — the anatomy the
        // expanded tile now copies instead of an absolutely positioned Delete slot.
        const nestedSelect = childRow?.querySelector<HTMLElement>(':scope > .thread-tile > .thread-select');
        expect(
            [...(nestedSelect?.children ?? [])]
                .filter((node) => !node.classList.contains('thread-kind'))
                .map((node) => node.className)
        ).toEqual(['thread-name', 'thread-preview', 'thread-top']);
        expect(
            [...(nestedSelect?.querySelectorAll<HTMLElement>(':scope > .thread-top > *') ?? [])].map(
                (node) => node.className
            )
        ).toEqual(['thread-elapsed', 'thread-tokens', 'thread-status']);
        expect(nestedSelect?.querySelector('.thread-top > .thread-status')?.lastElementChild?.className).toBe(
            'thread-status-text'
        );
        // T26: Delete reaches the child conversation from the bar now, still named by its
        // own conversation code.
        const nestedDelete = actionButton(childBar as HTMLElement, '.thread-delete');
        expect(nestedDelete.getAttribute('aria-label')).toBe('Delete thread RR2');
        expect(nestedDelete.querySelector('.action-label')?.textContent).toBe('Delete');
        // This board has no DELETE transport, so the bar's Delete is honest about that
        // rather than pretending to be wired (the shell test pins the wired case).
        expect(nestedDelete.title).toBe('Thread deletion is not wired in this host.');
        expect(
            childBar?.querySelector('.transcript-open .action-label')?.textContent
        ).toBe('Transcript');
        // T4/R2: same anatomy as the tile's bar — the Resume control exists here too. REV2 is
        // what paints it: this nested conversation's NEWEST row (`turn-child-failed`, index 3)
        // ended `error`, so its answer never arrived, and the roster's `idle` no longer hides the
        // control. `ui/thread-resume.test.ts` owns the full status × row matrix.
        expect(actionButton(childBar as HTMLElement, '.resume-open').hidden).toBe(false);
    });

    it('gives a roster-only focused thread the same action bar', () => {
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
        // T26: the panel head is ONE identity line (agent, name, state) and holds no control
        // whatsoever — its former `.thread-focus-head-action` host is gone, so the head is
        // pure text and the bar underneath owns both actions.
        expect(
            [...(panel?.querySelector<HTMLElement>('.thread-focus-head')?.children ?? [])].map(
                (node) => node.className
            )
        ).toEqual(['thread-focus-agent', 'thread-focus-name', 'thread-focus-status']);
        expect(panel?.querySelector('.thread-focus-head-action')).toBeNull();
        expect([...(panel?.children ?? [])].map((node) => node.className)).toEqual([
            'thread-focus-head',
            'thread-transcript-action thread-focus-actions',
            'thread-focus-messages'
        ]);

        const bar = panel?.querySelector<HTMLElement>('.thread-focus-actions');
        expect(bar?.hidden).toBe(false);
        // The roster bar keeps its panel-specific transcript class and the same child
        // order as a tile's bar: Delete leads, Resume sits next to Transcript, Transcript
        // closes (T6/R5: no inline confirmation row; T4/R2: Resume is the permanent middle
        // child and is hidden for a thread that is not `stopped`).
        expect([...(bar?.children ?? [])].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript thread-focus-transcript'
        ]);
        const rosterDelete = actionButton(bar as HTMLElement, '.thread-delete');
        expect(rosterDelete.querySelector('.action-label')?.textContent).toBe('Delete');
        expect(rosterDelete.getAttribute('aria-label')).toBe('Delete thread RR8');
        // Same honesty as the other two surfaces: this board wires no DELETE transport.
        expect(rosterDelete.title).toBe('Thread deletion is not wired in this host.');
        const rosterTranscript = actionButton(bar as HTMLElement, '.transcript-open');
        expect(rosterTranscript.querySelector('.action-label')?.textContent).toBe('Transcript');
        expect(rosterTranscript.getAttribute('aria-label')).toBe('Open the JSON transcript of RR8');

        openTranscriptFrom(bar as HTMLElement);
        expect(document.querySelector('.dialog-title')?.textContent).toBe(
            'Transcript · RR8 · Researcher'
        );
    });

    // T3/R2 (reviewer finding 2) + T26: the bar IS the action surface now, and it is
    // appended to the card BEFORE its first `sync` decides visibility, so it must be
    // CREATED hidden — or a collapsed card paints one frame of a stray enabled
    // Delete/Transcript pair. `adopt` never expands, so it exposes the creation state.
    it('creates the action bar hidden and reveals it only with the visible surface', () => {
        const board = mount();
        const snapshot = snapshotOf({
            threads: [threadOf({ id: 'thread-slot', label: 'RR3', messages: [] })],
            turns: [turnOf({ id: 'turn-slot', index: 0, threadId: 'thread-slot' })]
        });
        useSnapshot(board, snapshot);
        const turn = board.adopt(snapshot.turns[0]);

        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        expect(tileAction(turn).hidden).toBe(true);

        // Expansion reveals the whole surface (there is no second half to toggle).
        board.expand(turn);
        expect(tileAction(turn).hidden).toBe(false);

        // And collapsing hides it again — the bar's own `hidden` is the mechanism that the
        // removed header host used to mirror.
        board.collapse();
        expect(tileAction(turn).hidden).toBe(true);

        // A nested child card is created collapsed too: hidden bar, revealed by focus.
        const nested = mount();
        useSnapshot(nested, transcriptSnapshot);
        const parent = nested.adopt(parentTurn);
        const childRow = parent.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        // `parentElement` is nullable, so the guard narrows both halves (the board always
        // wraps the card in a `.turn-row` with the child row under it).
        if (!(childRow instanceof HTMLElement)) throw new Error('missing nested child row');
        const childBar = childRow.querySelector<HTMLElement>(
            ':scope > .thread-tile > .thread-transcript-action'
        );
        if (childBar === null) throw new Error('missing nested child action bar');
        expect(childBar.hidden).toBe(true);
        expect(nested.focusThread('thread-child')).toBe(true);
        expect(childBar.hidden).toBe(false);

        // The roster-only panel has no collapse state: its own sync reveals the bar.
        const roster = mount();
        useSnapshot(
            roster,
            snapshotOf({ threads: [threadOf({ id: 'thread-roster-slot', label: 'RR7', messages: [] })] })
        );
        expect(roster.focusThread('thread-roster-slot')).toBe(true);
        expect(document.querySelector<HTMLElement>('.thread-focus-actions')?.hidden).toBe(false);
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

// T26: there is ONE action surface per card — the bar. It is a direct child of the tile
// (`.tile-transcript-action`), of the nested card (`:scope > .thread-tile >
// .thread-transcript-action`, scoped so a grandchild row's own bar can never answer
// instead) or of the roster panel (`:scope > .thread-focus-actions`), and T6/R5 it holds
// its TWO actions and nothing else — the inline confirmation row is gone. That step is
// the shared dialog layer now, so `confirmDialogs()` selects by CONTENT: an open
// transcript is a second `.dialog` in the same document and must never answer here.
// These bar helpers still take the SURFACE element (`turn.element`, a `.thread-row`, or
// the `.thread-focus-panel`).
const threadBarOf = (surface: ParentNode): HTMLElement => {
    const bar = surface.querySelector<HTMLElement>(
        ':scope > .tile-transcript-action, :scope > .thread-transcript-action, :scope > .thread-tile > .thread-transcript-action'
    );
    if (bar === null) throw new Error('missing thread action bar');
    return bar;
};

const deleteButton = (surface: HTMLElement): HTMLButtonElement =>
    actionButton(threadBarOf(surface), '.thread-delete');

const confirmDialogs = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
        (panel) => panel.querySelector('.thread-delete-confirm') !== null
    );

const confirmDialog = (): HTMLElement => {
    const open = confirmDialogs();
    if (open.length !== 1) throw new Error(`expected one delete confirmation, found ${open.length}`);
    return open[0];
};

const dialogTitleOf = (panel: ParentNode): string =>
    panel.querySelector<HTMLElement>('.dialog-title')?.textContent ?? '';

const confirmWarning = (panel: ParentNode): string =>
    panel.querySelector<HTMLElement>('.thread-delete-confirm-body')?.textContent ?? '';

// The confirmation's own buttons, in DOM order: the shell's `×` close lives in
// `.dialog-head`, so the body carries exactly the two actions.
const confirmActions = (panel: ParentNode): (string | null)[] =>
    Array.from(panel.querySelectorAll<HTMLButtonElement>('.dialog-body button')).map(
        (button) => button.textContent
    );

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
        const card = turn.element;

        // T26: Delete first (it is clickable from the bar, no header host needed) and
        // Transcript last. T6/R5: those are the bar's ONLY ACTIONS — an accidental
        // second press has no inline row to confirm any more. T4/R2: the third child is
        // the always-present Resume control, hidden because this thread is not stopped.
        expect([...bar.children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);

        // This jsdom has no `matchMedia`, so the press takes the fail-safe branch: the
        // shared confirmation layer opens and the API is still untouched.
        deleteButton(card).click();
        const dialog = confirmDialog();
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialogTitleOf(dialog)).toBe('Delete thread');
        expect(confirmWarning(dialog)).toBe(
            'Delete thread RR1 permanently? Its turns and transcript are removed.'
        );
        expect(confirmActions(dialog)).toEqual(['Delete thread', 'Cancel']);
        expect(calls).toEqual([]);

        actionButton(dialog, '.thread-delete-confirm-cancel').click();
        expect(confirmDialogs()).toHaveLength(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(calls).toEqual([]);

        deleteButton(card).click();
        const yes = actionButton(confirmDialog(), '.thread-delete-confirm-delete');
        expect(yes.textContent).toBe('Delete thread');
        yes.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(confirmDialogs()).toHaveLength(0);
        expect(deleteButton(card).disabled).toBe(true);

        // A second confirm/pointer event while the DELETE is in flight is a no-op: the
        // spent dialog body cannot re-send, and the disabled bar cannot re-arm.
        yes.click();
        deleteButton(card).click();
        await flush();
        expect(calls).toHaveLength(1);
        expect(confirmDialogs()).toHaveLength(0);

        resolveDelete?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();
        // Success collapses the edited surface (focus is cleared) and the DELETE is
        // no longer in flight; re-expanding paints a usable toolbar again.
        expect(bar.hidden).toBe(true);
        board.expand(turn);
        expect(deleteButton(card).disabled).toBe(false);
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

        deleteButton(turn.element).click();
        actionButton(confirmDialog(), '.thread-delete-confirm-delete').click();
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

        deleteButton(turn.element).click();
        actionButton(confirmDialog(), '.thread-delete-confirm-delete').click();
        await flush();

        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(tileAction(turn).hidden).toBe(false);
        expect(deleteButton(turn.element).disabled).toBe(false);
        const notice = document.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe(
            'delete thread: Thread "thread-a" still has live work; wait for it to stop before deleting it.'
        );

        // T6/R5 error recovery: the failed request spent its dialog and changed nothing,
        // so the very next press arms a fresh confirmation and can try again.
        deleteButton(turn.element).click();
        expect(confirmDialogs()).toHaveLength(1);
        actionButton(confirmDialog(), '.thread-delete-confirm-delete').click();
        await flush();

        // One board-level notice per failed attempt (`notice()` appends to the board
        // element and never replaces an earlier one).
        expect(board.element.querySelectorAll(':scope > .notice')).toHaveLength(2);
        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(confirmDialogs()).toHaveLength(0);
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
        expect(defaultBar.hidden).toBe(false);
        expect(deleteButton(defaultTurn.element).hidden).toBe(true);
        // T26: an undeletable default conversation hides ONLY the Delete button — the bar
        // stays (Transcript is still owed) and `margin-left: auto` keeps that trailing
        // action flush right instead of sliding it into the destructive action's place.
        // T4/R2: this thread is not `stopped` either, so Resume is hidden as well and the
        // `.resume-open[hidden] + .transcript-open { margin-left: auto }` rule is what hands
        // the flush-right slot back to Transcript.
        expect(
            [...defaultBar.children]
                .filter((node) => !(node instanceof HTMLElement && node.hidden))
                .map((node) => node.className)
        ).toEqual(['transcript-open action-transcript']);
        expect(actionButton(defaultBar, '.transcript-open').hidden).toBe(false);
        expect(actionButton(defaultBar, '.transcript-open').disabled).toBe(false);
        // The Resume node survives the `hidden` with its accessible name intact (a reader
        // that reaches it can still tell what it would do), and an unwired host says so.
        const defaultResume = actionButton(defaultBar, '.resume-open');
        expect(defaultResume.hidden).toBe(true);
        expect(defaultResume.getAttribute('aria-label')).toBe('Resume thread RR5');
        expect(defaultResume.title).toBe('Thread resume is not wired in this host.');
        // The control is still there (just not painted), so its accessible name and honest
        // reason survive the `hidden`.
        expect(deleteButton(defaultTurn.element).getAttribute('aria-label')).toBe(
            'Delete thread RR5'
        );
        expect(deleteButton(defaultTurn.element).title).toBe(
            'The default agent conversation cannot be deleted; reset the session instead.'
        );

        const runningTurn = board.adopt(snapshot.turns[1]);
        board.expand(runningTurn);
        const runningBar = tileAction(runningTurn);
        // R1: a live thread's destructive action is STOP, not a disabled Delete. It is
        // still the SAME single button and it still carries `.thread-delete` (the
        // `.thread-stop` modifier is additive), so the bar's anatomy, its order and every
        // existing selector are unchanged. T6/R5 still holds: no confirmation dialog of any
        // kind is reachable from a live conversation. T4/R2: the third child is the Resume
        // control, and a RUNNING thread is not `stopped`, so it stays unpainted.
        expect([...runningBar.children].map((node) => node.className)).toEqual([
            'thread-delete thread-stop',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        expect(actionButton(runningBar, '.resume-open').hidden).toBe(true);
        const runningStop = deleteButton(runningTurn.element);
        expect(runningStop.hidden).toBe(false);
        // This standalone board has no STOP transport either; the control says so instead
        // of pretending the action is wired (same honesty rule as an unwired Delete).
        expect(runningStop.disabled).toBe(true);
        expect(runningStop.querySelector('.action-label')?.textContent).toBe('Stop');
        expect(runningStop.querySelector('.action-glyph')?.textContent).toBe('■');
        expect(runningStop.getAttribute('aria-label')).toBe('Stop thread RR6');
        expect(runningStop.title).toBe('Thread stop is not wired in this host.');

        runningStop.click();
        expect(confirmDialogs()).toHaveLength(0);
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
                                name: 'delegate',
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
        // T1/R2: the protected state is stated by the HEADER control now.
        expect(deleteButton(childRow as HTMLElement).disabled).toBe(true);
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
        deleteButton(firstTurn.element).click();
        actionButton(confirmDialog(), '.thread-delete-confirm-delete').click();
        await flush();

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ sessionId: 's1', threadId: 'thread-a' });
        expect(deleteButton(firstTurn.element).disabled).toBe(true);

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
        deleteButton(secondTurn.element).click();
        actionButton(confirmDialog(), '.thread-delete-confirm-delete').click();
        await flush();

        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ sessionId: 's2', threadId: 'thread-a' });
        expect(deleteButton(secondTurn.element).disabled).toBe(true);

        // The OLD request resolves: its finally must remove only its own composite
        // key/suppression token, not the new session's in-flight delete.
        requests[0].resolve({ deleted: true, session: first });
        await flush();

        expect(deleteButton(secondTurn.element).disabled).toBe(true);
        expect(confirmDialogs()).toHaveLength(0);

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
        // T6/R5: the bar carries no inline confirmation row at all, and an unwired host
        // cannot open a dialog that would only ever say it is unwired.
        expect(bar.querySelector('.thread-delete-confirm')).toBeNull();
        expect(deleteButton(turn.element).disabled).toBe(true);
        expect(deleteButton(turn.element).title).toBe('Thread deletion is not wired in this host.');
        deleteButton(turn.element).click();
        expect(confirmDialogs()).toHaveLength(0);
    });
});
