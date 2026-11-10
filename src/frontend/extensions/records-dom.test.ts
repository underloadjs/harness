/**
 * Records panel DOM helpers tests (records-dom.ts).
 *
 * Pins the accessibility and real-time surface the two scratch-board panels are built
 * from: relative/absolute stamps, the truncation bound, the actor badge, the pre-mounted
 * live region and its batching announcer, the reading-position controller and its
 * "N new" pill, the FLIP animator's keyed enter/reorder bookkeeping, the "just landed"
 * marker, and the corner state box / state-note surfaces. Geometry the panels need is faked per element
 * (a detached jsdom node reports an all-zero rect), so every assertion is about the
 * attribute, label or offset the helper actually writes.
 *
 * Run: npx vitest run --config src/frontend/vitest.config.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    RECORDS_JUST_NOW_MS,
    RECORDS_LIVE_EDGE_THRESHOLD,
    RECORDS_TEXT_PREVIEW,
    createRecordsAnnouncer,
    createRecordsFollow,
    createRecordsFlip,
    createRecordsFreshMarker,
    recordsActorBadgeOf,
    recordsElement,
    recordsIsoOf,
    recordsLiveRegionOf,
    recordsNewPillOf,
    recordsReducedMotion,
    recordsRelativeOf,
    recordsStampOf,
    recordsStateOf,
    recordsStatusOf,
    recordsTruncate,
    refreshRecordsStamps,
    type RecordsSchedule
} from './records-dom';

// -----------------------------------------------------------------------------
// Shared seams
// -----------------------------------------------------------------------------

const AT = '2026-11-10T09:00:00.000Z';
const BASE = Date.parse(AT);

// A schedule that records its callbacks instead of arming a real timer: every timing
// rule below is then something a test fires, never something it waits for.
const captureSchedule = () => {
    const armed: { run: () => void; delayMs: number; signal?: AbortSignal }[] = [];

    const schedule: RecordsSchedule = (run, delayMs, signal) => {
        armed.push({ run, delayMs, ...(signal === undefined ? {} : { signal }) });
    };

    return {
        schedule,
        armed,
        /** Fires the i-th armed callback (in the order it was armed). */
        fire: (index = 0) => {
            const entry = armed[index];
            if (entry === undefined) throw new Error(`no timer armed at ${index}`);
            entry.run();
        },
        delays: () => armed.map((entry) => entry.delayMs)
    };
};

// The rectangular patch jsdom lacks: every detached node reports an all-zero rect, so a
// test states the geometry it means to test.
const setRect = (node: HTMLElement, rect: Partial<DOMRect>): void => {
    node.getBoundingClientRect = () =>
        ({
            top: 0,
            left: 0,
            bottom: 0,
            right: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
            ...rect
        }) as DOMRect;
};

const setBox = (node: HTMLElement, scrollHeight: number, clientHeight: number): void => {
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => clientHeight });
};

const mount = (node: HTMLElement): HTMLElement => {
    node.remove();
    document.body.append(node);

    return node;
};

const originalMatchMedia = globalThis.matchMedia;

afterEach(() => {
    if (originalMatchMedia === undefined) delete (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
    else globalThis.matchMedia = originalMatchMedia;
});

// -----------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------

describe('records stamps', () => {
    it('renders the relative ladder exactly, and never invents a label', () => {
        expect(recordsRelativeOf(undefined, BASE)).toBe('');
        expect(recordsRelativeOf('', BASE)).toBe('');
        expect(recordsRelativeOf('not a date', BASE)).toBe('');
        // The future is now: a client clock behind the store still reads honestly.
        expect(recordsRelativeOf(new Date(BASE + 5_000).toISOString(), BASE)).toBe('just now');
        expect(recordsRelativeOf(new Date(BASE + 59_999).toISOString(), BASE)).toBe('just now');
        expect(recordsRelativeOf(AT, BASE + RECORDS_JUST_NOW_MS)).toBe('1m');
        expect(recordsRelativeOf(AT, BASE + 59 * 60_000)).toBe('59m');
        expect(recordsRelativeOf(AT, BASE + 60 * 60_000)).toBe('1h');
        expect(recordsRelativeOf(AT, BASE + 23 * 3_600_000)).toBe('23h');
        expect(recordsRelativeOf(AT, BASE + 24 * 3_600_000)).toBe('1d');
        expect(recordsRelativeOf(AT, BASE + 72 * 3_600_000)).toBe('3d');
    });

    it('keeps the absolute form for the tooltip, raw bytes when the stamp is unreadable', () => {
        expect(recordsIsoOf(AT)).toBe(AT);
        expect(recordsIsoOf('2026-11-10T09:00:00Z')).toBe(AT);
        expect(recordsIsoOf('not a date')).toBe('not a date');
        expect(recordsIsoOf(undefined)).toBe('');
    });

    it('builds a <time> that carries datetime and title, and ages only the stamped ones', () => {
        const root = recordsElement('div', 'panel-tasks-list');
        const stamp = recordsStampOf(AT, BASE + 5 * 60_000);
        const untracked = document.createElement('time');
        untracked.setAttribute('datetime', AT);
        untracked.textContent = 'fixed';

        root.append(stamp, untracked);
        mount(root);

        expect(stamp.tagName).toBe('TIME');
        expect(stamp.className).toBe('panel-stamp');
        expect(stamp.dataset.stamp).toBe('true');
        expect(stamp.getAttribute('datetime')).toBe(AT);
        expect(stamp.title).toBe(AT);
        expect(stamp.textContent).toBe('5m');

        refreshRecordsStamps(root, BASE + 3 * 3_600_000);

        expect(stamp.textContent).toBe('3h');
        expect(untracked.textContent).toBe('fixed');
        // The absolute fact never moves — only the relative label re-ages.
        expect(stamp.getAttribute('datetime')).toBe(AT);

        // An unknown stamp is an empty label, not a guess.
        const blank = recordsStampOf(undefined, BASE, 'panel-feed-stamp');
        expect(blank.className).toBe('panel-feed-stamp');
        expect(blank.textContent).toBe('');
        expect(blank.hasAttribute('datetime')).toBe(false);
        expect(blank.title).toBe('');
    });
});

// -----------------------------------------------------------------------------
// Text bounds and actor badges
// -----------------------------------------------------------------------------

describe('records text and actor surface', () => {
    it('truncates at the preview bound and says so, exactly', () => {
        const whole = 'x'.repeat(RECORDS_TEXT_PREVIEW);
        expect(recordsTruncate(whole)).toEqual({ text: whole, truncated: false });
        expect(recordsTruncate(`${whole}y`)).toEqual({ text: `${whole}…`, truncated: true });
        expect(recordsTruncate('short')).toEqual({ text: 'short', truncated: false });
        expect(recordsTruncate('abcdef', 3)).toEqual({ text: 'abc…', truncated: true });
    });

    it('marks the badge by kind, never by label text', () => {
        const agent = recordsActorBadgeOf({ name: 'agent', kind: 'agent' });
        expect(agent.tagName).toBe('SPAN');
        expect(agent.className).toBe('panel-actor');
        expect(agent.textContent).toBe('agent');
        expect(agent.dataset.actor).toBe('agent');
        expect(agent.title).toBe('Last changed by agent');

        const system = recordsActorBadgeOf({ name: 'system', kind: 'system' }, 'panel-feed-actor');
        expect(system.className).toBe('panel-feed-actor');
        expect(system.dataset.actor).toBe('system');
        expect(system.title).toBe('Changed without an agent identity (a restored store, or a caller with no agent context)');
    });

    it('reads reduced motion from the host, and survives a host without matchMedia', () => {
        const stub = (matches: boolean) => {
            globalThis.matchMedia = ((query: string) => ({
                matches,
                media: query
            })) as unknown as typeof globalThis.matchMedia;
        };

        delete (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
        expect(recordsReducedMotion()).toBe(false);

        stub(false);
        expect(recordsReducedMotion()).toBe(false);

        stub(true);
        expect(recordsReducedMotion()).toBe(true);

        globalThis.matchMedia = (() => {
            throw new Error('hostile host');
        }) as unknown as typeof globalThis.matchMedia;
        expect(recordsReducedMotion()).toBe(false);
    });
});

// -----------------------------------------------------------------------------
// The live region and its announcer
// -----------------------------------------------------------------------------

describe('records live region and announcer', () => {
    it('pre-mounts one polite, non-atomic status region', () => {
        const region = recordsLiveRegionOf('Tasks updates');

        expect(region.tagName).toBe('DIV');
        expect(region.className).toBe('panel-live');
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.getAttribute('aria-atomic')).toBe('false');
        expect(region.getAttribute('aria-label')).toBe('Tasks updates');
    });

    it('coalesces a burst into ONE region write, oldest-dropped past the cap', () => {
        const region = recordsLiveRegionOf('Panel updates');
        const timers = captureSchedule();
        const announcer = createRecordsAnnouncer({ region, schedule: timers.schedule, delay: 400, limit: 3 });

        announcer.say('Added task Write the tests');
        announcer.say('Completed task Ship it');
        announcer.say('Added task Review the diff');

        // One timer for the whole burst, at the declared delay.
        expect(timers.armed).toHaveLength(1);
        expect(timers.delays()).toEqual([400]);
        expect(announcer.pending()).toEqual(['Added task Write the tests', 'Completed task Ship it', 'Added task Review the diff']);
        expect(region.children).toHaveLength(0);

        timers.fire();

        expect([...region.children].map((node) => `${node.className}:${node.textContent}`)).toEqual([
            'panel-live-line:Added task Write the tests',
            'panel-live-line:Completed task Ship it',
            'panel-live-line:Added task Review the diff'
        ]);
        expect(announcer.pending()).toEqual([]);

        // A fourth line drops the oldest: the region never becomes a re-read document.
        announcer.say('Removed task Old news');
        // The settled burst armed exactly one more timer, not one per line.
        expect(timers.armed).toHaveLength(2);
        timers.fire(1);

        expect([...region.children].map((node) => node.textContent)).toEqual([
            'Completed task Ship it',
            'Added task Review the diff',
            'Removed task Old news'
        ]);
    });

    it('drops a cancelled queue, and lets a manual flush win the race against the timer', () => {
        const region = recordsLiveRegionOf('Panel updates');
        const timers = captureSchedule();
        const announcer = createRecordsAnnouncer({ region, schedule: timers.schedule });

        announcer.say('gone');
        announcer.cancel();
        expect(announcer.pending()).toEqual([]);

        timers.fire();
        expect(region.children).toHaveLength(0);

        announcer.say('queued');
        expect(announcer.flush()).toBeUndefined();
        expect([...region.children].map((node) => node.textContent)).toEqual(['queued']);

        // The timer that is still in flight must not write the same line twice.
        timers.fire();
        expect(region.children).toHaveLength(1);
    });

    it('ignores empty sentences, and stops writing once destroyed', () => {
        const region = recordsLiveRegionOf('Panel updates');
        const timers = captureSchedule();
        const announcer = createRecordsAnnouncer({ region, schedule: timers.schedule });

        announcer.say('');
        expect(timers.armed).toHaveLength(0);

        announcer.say('Task 1 landed');
        announcer.destroy();
        expect(announcer.pending()).toEqual([]);

        timers.fire();
        expect(region.children).toHaveLength(0);

        announcer.say('too late');
        expect(timers.armed).toHaveLength(1);
        expect(region.children).toHaveLength(0);
    });

    it('creates its nodes through the region document, so a flush after teardown cannot throw', () => {
        const region = recordsLiveRegionOf('Panel updates');
        const foreign = document.implementation.createHTMLDocument('host');
        // The region lives in another document (an iframe host); the announcer must not
        // fall back to the global one, which may already be gone.
        foreign.body.append(region);

        const announcer = createRecordsAnnouncer({ region, schedule: () => {} });
        announcer.say('Task 1 landed');
        announcer.flush();

        expect(region.children).toHaveLength(1);
        expect(region.children[0]?.ownerDocument).toBe(foreign);
        region.remove();
    });
});

// -----------------------------------------------------------------------------
// Reading position
// -----------------------------------------------------------------------------

describe('records follow controller and pill', () => {
    it('follows only at the live edge and freezes the reader everywhere else', () => {
        const scroller = mount(recordsElement('div', 'panel-tasks-list'));
        setBox(scroller, 1_000, 200);
        const pill = recordsNewPillOf();

        const changes: [boolean, number][] = [];
        const controller = createRecordsFollow({
            scroller,
            pill,
            liveEdge: 'bottom',
            onChange: (following, pending) => {
                changes.push([following, pending]);
            }
        });

        // Start pinned to the newest row.
        scroller.scrollTop = 800;
        controller.sync();
        expect(controller.following()).toBe(true);
        expect(pill.hidden).toBe(true);
        expect(pill.textContent).toBe('0 new');

        // The reader scrolls away.
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));
        expect(controller.following()).toBe(false);

        // Two rows land above them: the reading position holds, the pill counts.
        const mark = controller.begin(40);
        expect(mark).toEqual({ scrollTop: 0, shift: 40 });
        controller.commit(mark, 2);

        expect(scroller.scrollTop).toBe(40);
        expect(controller.pending()).toBe(2);
        expect(pill.hidden).toBe(false);
        expect(pill.textContent).toBe('2 new');
        expect(pill.dataset.pending).toBe('2');
        expect(pill.getAttribute('aria-label')).toBe('2 new changes above. Activate to jump to the newest.');

        // A second batch accumulates on the same pill.
        const second = controller.begin(40);
        controller.commit(second, 3);
        expect(scroller.scrollTop).toBe(80);
        expect(pill.textContent).toBe('5 new');
        expect(controller.pending()).toBe(5);

        // The pill is the way back: it jumps to the edge and clears itself.
        pill.click();

        expect(scroller.scrollTop).toBe(800);
        expect(controller.pending()).toBe(0);
        expect(controller.following()).toBe(true);
        expect(pill.hidden).toBe(true);
        expect(changes).toEqual([
            [true, 0],
            [false, 0],
            [false, 2],
            [false, 5],
            [true, 0]
        ]);
    });

    it('auto-follows a new batch while the reader is at the edge', () => {
        const scroller = mount(recordsElement('div', 'panel-records-list'));
        setBox(scroller, 1_000, 200);
        const pill = recordsNewPillOf();
        const controller = createRecordsFollow({ scroller, pill });

        // Newest-first feed: the live edge is the top.
        scroller.scrollTop = 0;
        controller.sync();
        expect(controller.following()).toBe(true);

        const mark = controller.begin(25);
        controller.commit(mark, 1);

        expect(scroller.scrollTop).toBe(0);
        expect(controller.pending()).toBe(0);
        expect(pill.hidden).toBe(true);

        // Anything inside the rounding threshold still counts as the edge.
        scroller.scrollTop = RECORDS_LIVE_EDGE_THRESHOLD;
        scroller.dispatchEvent(new Event('scroll'));
        expect(controller.following()).toBe(true);

        scroller.scrollTop = RECORDS_LIVE_EDGE_THRESHOLD + 1;
        scroller.dispatchEvent(new Event('scroll'));
        expect(controller.following()).toBe(false);
    });

    it('scrolling back to the edge is the follow gesture: the waiting count clears', () => {
        const scroller = mount(recordsElement('div', 'panel-tasks-list'));
        setBox(scroller, 1_000, 200);
        const pill = recordsNewPillOf();
        const controller = createRecordsFollow({ scroller, pill, liveEdge: 'bottom' });

        scroller.scrollTop = 0;
        controller.sync();

        const mark = controller.begin(40);
        controller.commit(mark, 4);
        expect(pill.textContent).toBe('4 new');

        scroller.scrollTop = 800;
        scroller.dispatchEvent(new Event('scroll'));

        expect(controller.pending()).toBe(0);
        expect(pill.hidden).toBe(true);
        expect(pill.dataset.pending).toBe('0');
    });

    it('treats a zero-height insert as nothing to hold, and re-reads the edge', () => {
        const scroller = mount(recordsElement('div', 'panel-records-list'));
        setBox(scroller, 1_000, 200);
        const pill = recordsNewPillOf();
        const controller = createRecordsFollow({ scroller, pill });

        scroller.scrollTop = 500;
        controller.sync();

        const mark = controller.begin(0);
        controller.commit(mark, 0);

        expect(scroller.scrollTop).toBe(500);
        expect(controller.pending()).toBe(0);
        expect(pill.hidden).toBe(true);
    });

    it('falls back to the live-edge row height when the caller cannot state the insert height', () => {
        const scroller = mount(recordsElement('div', 'panel-tasks-list'));
        setBox(scroller, 1_000, 200);
        const row = recordsElement('div', 'panel-task-row');
        setRect(row, { height: 44 });
        scroller.append(row);

        const controller = createRecordsFollow({ scroller, pill: recordsNewPillOf(), liveEdge: 'top' });
        expect(controller.begin()).toEqual({ scrollTop: 0, shift: 44 });
    });

    it('releases both listeners when the owner signal aborts', () => {
        const scroller = mount(recordsElement('div', 'panel-tasks-list'));
        setBox(scroller, 1_000, 200);
        const pill = recordsNewPillOf();
        const controller = new AbortController();
        const changes: [boolean, number][] = [];

        const follow = createRecordsFollow({
            scroller,
            pill,
            liveEdge: 'bottom',
            signal: controller.signal,
            onChange: (following, pending) => {
                changes.push([following, pending]);
            }
        });

        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));
        expect(changes).toEqual([[false, 0]]);

        controller.abort();

        // A scroll or a click after teardown moves nothing: the panel is gone.
        scroller.scrollTop = 800;
        scroller.dispatchEvent(new Event('scroll'));
        pill.click();
        expect(changes).toEqual([[false, 0]]);
        expect(follow.following()).toBe(false);
    });

    it('builds the pill as a hidden button that carries its own count', () => {
        const pill = recordsNewPillOf();

        expect(pill.tagName).toBe('BUTTON');
        expect(pill.className).toBe('panel-new-pill');
        expect(pill.type).toBe('button');
        expect(pill.hidden).toBe(true);
        expect(pill.dataset.pending).toBe('0');
        expect(pill.textContent).toBe('');
    });
});

// -----------------------------------------------------------------------------
// FLIP and freshness
// -----------------------------------------------------------------------------

describe('records FLIP animator', () => {
    it('keys rows by their record id and marks only the ones that moved', () => {
        const root = mount(recordsElement('ol', 'panel-records-feed'));
        const steady = recordsElement('li', 'panel-feed-row');
        const moved = recordsElement('li', 'panel-feed-row');
        steady.dataset.rowKey = 'rec_a';
        moved.dataset.rowKey = 'rec_b';
        setRect(steady, { top: 100 });
        setRect(moved, { top: 120 });
        root.append(steady, moved);

        const timers = captureSchedule();
        const animator = createRecordsFlip({ schedule: timers.schedule, duration: 180 });

        animator.measure(root);

        // The reconciliation moves rec_b up 20px and leaves rec_a where it was.
        setRect(steady, { top: 100 });
        setRect(moved, { top: 100 });
        animator.play(root);

        expect(steady.dataset.flip).toBe('steady');
        expect(moved.dataset.flip).toBe('moved');
        expect(moved.style.transform).toBe('translateY(20px)');
        expect(moved.style.transition).toBe('transform 0s');

        // The invert plays back on the next frame, then the transition is dropped.
        timers.fire(0);
        expect(moved.style.transition).toBe('transform 180ms ease-out');
        expect(moved.style.transform).toBe('');

        timers.fire(1);
        expect(moved.style.transition).toBe('');
        expect(timers.delays()).toEqual([0, 180]);
    });

    it('writes the flip state but no transform under prefers-reduced-motion', () => {
        globalThis.matchMedia = ((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query })) as unknown as typeof globalThis.matchMedia;

        const root = mount(recordsElement('ol', 'panel-records-feed'));
        const row = recordsElement('li', 'panel-feed-row');
        row.dataset.rowKey = 'rec_a';
        setRect(row, { top: 10 });
        root.append(row);

        const timers = captureSchedule();
        const animator = createRecordsFlip({ schedule: timers.schedule });

        animator.measure(root);
        setRect(row, { top: 0 });
        animator.play(root);

        expect(row.dataset.flip).toBe('moved');
        expect(row.style.transform).toBe('');
        expect(timers.armed).toHaveLength(0);
    });

    it('animates only its own root, and forgets its geometry on reset and destroy', () => {
        const mine = mount(recordsElement('ol', 'panel-records-feed'));
        const theirs = mount(recordsElement('ol', 'panel-tasks-list'));
        const rowA = recordsElement('li', 'panel-feed-row');
        const rowB = recordsElement('li', 'panel-task-row');
        rowA.dataset.rowKey = 'rec_a';
        rowB.dataset.rowKey = 'rec_a';
        setRect(rowA, { top: 40 });
        setRect(rowB, { top: 90 });
        mine.append(rowA);
        theirs.append(rowB);

        const timers = captureSchedule();
        const animator = createRecordsFlip({ schedule: timers.schedule });

        animator.measure(mine);
        setRect(rowA, { top: 0 });
        setRect(rowB, { top: 0 });
        animator.play(mine);

        expect(rowA.dataset.flip).toBe('moved');
        // The other panel's row shares the key and the document: it must stay untouched.
        expect(rowB.dataset.flip).toBeUndefined();

        animator.reset();
        animator.measure(mine);
        animator.reset();
        animator.play(mine);
        expect(rowA.dataset.flip).toBe('moved');

        const fresh = recordsElement('li', 'panel-feed-row');
        fresh.dataset.rowKey = 'rec_c';
        setRect(fresh, { top: 10 });
        mine.append(fresh);
        animator.measure(mine);
        animator.destroy();
        animator.play(mine);
        expect(fresh.dataset.flip).toBeUndefined();
    });
});

describe('records fresh marker', () => {
    it('marks a row, lets the newest mark own the expiry, and never stacks timers', () => {
        const timers = captureSchedule();
        const marker = createRecordsFreshMarker({ schedule: timers.schedule, ttl: 1_200 });
        const row = recordsElement('li', 'panel-feed-row');

        marker.mark(row);
        expect(row.dataset.fresh).toBe('true');
        expect(row.dataset.freshToken).toBe('1');
        expect(timers.delays()).toEqual([1_200]);

        // Re-marking moves the deadline instead of arming a second expiry.
        marker.mark(row);
        expect(row.dataset.freshToken).toBe('2');
        expect(timers.delays()).toEqual([1_200, 1_200]);

        timers.fire(0);
        expect(row.dataset.fresh).toBe('true');

        timers.fire(1);
        expect(row.dataset.fresh).toBeUndefined();
    });

    it('clears everything on demand and on destroy, and ignores a late mark', () => {
        const timers = captureSchedule();
        const marker = createRecordsFreshMarker({ schedule: timers.schedule });
        const one = recordsElement('li', 'panel-feed-row');
        const two = recordsElement('li', 'panel-task-row');

        marker.mark(one);
        marker.mark(two);
        marker.clearAll();

        expect(one.dataset.fresh).toBeUndefined();
        expect(two.dataset.fresh).toBeUndefined();
        // The retired timers stay armed but are inert: the generation check owns expiry.
        expect(timers.armed).toHaveLength(2);
        timers.fire(0);
        expect(one.dataset.fresh).toBeUndefined();

        marker.mark(one);
        marker.destroy();
        expect(one.dataset.fresh).toBeUndefined();

        marker.mark(two);
        expect(two.dataset.fresh).toBeUndefined();
    });

    it('defaults to the ~1.5s window the design asks for', () => {
        const timers = captureSchedule();
        const marker = createRecordsFreshMarker({ schedule: timers.schedule });
        marker.mark(recordsElement('li', 'panel-feed-row'));
        expect(timers.delays()).toEqual([1_500]);
    });
});

// -----------------------------------------------------------------------------
// The non-ready states
// -----------------------------------------------------------------------------

describe('records corner state box and state-note surfaces', () => {
    it('builds one fixed box that names the state, and carries the state twice', () => {
        // The box REPLACED the skeleton: a panel that is reading used to insert a block of
        // shimmering bars over its list and pull them out again when the read landed, which
        // on a card that re-reads a delta every few seconds read as the whole tile
        // flickering. This is one element that never enters and never leaves — only its
        // word and its attribute change (./records-panels.ts `paintChrome`).
        const box = recordsStatusOf('loading', 'reading');

        expect(box.tagName).toBe('SPAN');
        expect(box.className).toBe('panel-status');
        expect(box.textContent).toBe('reading');
        // The word is for the eye; `data-state` is the fact the stylesheet, the tests and
        // a forced-colours mode read, so the label and the colour cannot drift apart.
        expect(box.dataset.state).toBe('loading');
        expect(box.dataset.role).toBe('status');
        // NOT `aria-hidden` and not a live region of its own: the panel's pre-mounted
        // region already announces, and a second region would say it twice.
        expect(box.getAttribute('aria-hidden')).toBeNull();
        expect(box.getAttribute('aria-live')).toBeNull();
    });

    it('paints a state note, with the retry action as a real button', () => {
        const empty = recordsStateOf('panel-tasks-state', 'empty', 'No tasks yet.');
        expect(empty.tagName).toBe('P');
        expect(empty.className).toBe('panel-tasks-state');
        expect(empty.dataset.state).toBe('empty');
        expect(empty.getAttribute('role')).toBeNull();
        expect(empty.textContent).toBe('No tasks yet.');
        expect(empty.querySelector('button')).toBeNull();

        const run = vi.fn();
        const error = recordsStateOf('panel-records-state', 'error', 'The records read failed.', { label: 'Retry', run });

        expect(error.dataset.state).toBe('error');
        const button = error.querySelector('button');
        expect(button?.className).toBe('panel-records-state-action');
        expect(button?.getAttribute('type')).toBe('button');
        expect(button?.textContent).toBe('Retry');

        button?.dispatchEvent(new Event('click', { bubbles: true }));
        expect(run).toHaveBeenCalledTimes(1);
    });
});
