// One session subscription, shared by every live panel (T6/R5).
//
// WHY A BROKER EXISTS
// -------------------
// A `records.updated` frame carries the store's two watermarks and NOTHING else
// (../../shared/harness-stream.ts `WsUpdateRecords`), so delivering it to two panels
// costs nothing and the content is one delta read away for each of them. The expensive
// things are the subscription itself and the CONNECTION bookkeeping: a client may hold
// 64 registrations (../server/stream/broker.ts) and a reconnect replays every entry in
// its map (./stream.ts), which is exactly the leak ./view-shell.ts:772-784 blames for
// "random drops". Two panels dialling their own session registration would double that
// bookkeeping for the SAME frames, and a third live panel would triple it.
//
// So the panels share ONE registration per conversation and fan the frames out here:
//
//     channel(s1).addWake(handlers)   ← each panel attaches its own client
//     …one subscribe() on the plane…
//     channel(s1).dispose()           ← when the LAST panel lets go, unsubscribe
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not merge the panels' STATE. Each panel still owns a `createRecordsClient`
// (./records-client.ts) with its own watermarks, feed and reads, because that is what
// makes one panel's failure contained: a throwing render, a rejected read or a client
// that died mid-burst takes nothing else down (./runtime.ts mounts each panel in its
// own try/catch for the same reason). Two bounded delta reads per burst is the price
// of that isolation, and it is a price paid in REST reads, not in registrations.
//
// Cross-references:
//   - ./records-panels.ts — the only consumers today
//   - ./context.ts        — `PanelSubscribe`, the seam this dials through
//   - ./view-shell.ts     — the baseline/reconciliation rules this mirrors

import type { RecordsSignal } from '../../shared/harness-api';
import type { WsResyncRequired, WsSubscriptionState, WsUpdate } from '../../shared/harness-stream';
import { defaultPanelSubscribe } from './context';
import type { PanelSubscriptionSpec } from './context';
import { clipRecordError } from './records-client';
import type { StreamSubscription } from '../stream';

// What a panel asks to hear about, in the panel's own words. Every member is optional:
// a panel that has no use for one signal (an app-scoped view that never re-reads) simply
// does not implement it.
export type RecordsWakeHandlers = {
    /** A `records.updated` frame — the two watermarks, never a record. */
    onSignal?: (signal: RecordsSignal) => void;
    /** The subscription is (re-)registered; `replayedFrames` says whether the outage self-healed. */
    onBaseline?: (state: WsSubscriptionState) => void;
    /** A gap: the socket dropped, or the server says this registration must re-anchor. */
    onGap?: (frame: WsResyncRequired) => void;
    /** The registration was REFUSED (unknown_resource, unsupported_filter) — final for this page. */
    onRefused?: (message: string) => void;
    /** No plane at all, or the seam threw: the panel is on its own until something changes. */
    onUnavailable?: (message: string) => void;
    /** The shared registration was retired (the last panel let go, or the page is going away). */
    onReleased?: () => void;
};

export type RecordsWakeChannel = {
    /** The conversation this channel watches. */
    sessionId: () => string;
    /** True while a registration is held on the plane. */
    live: () => boolean;
    /** How many panels are attached (the release rule's only input). */
    attached: () => number;
    /** How many frames this channel has broadcast (diagnostics and tests). */
    frames: () => number;
    /** Attaches a panel; the returned function detaches it. Idempotent. */
    attach: (handlers: RecordsWakeHandlers) => () => void;
    /** Retires the registration for EVERY attached panel. Safe to call twice. */
    dispose: () => void;
};

export type RecordsWakeBroker = {
    /** The channel for one conversation, dialled on the first attach. */
    channel: (sessionId: string) => RecordsWakeChannel;
    /** Retires every channel (a shell teardown). */
    disposeAll: () => void;
    /** How many channels are open. */
    size: () => number;
};

// The subscribe seam: the same `PanelContext.subscribe` a panel would use, minus the
// panel's own bookkeeping. Injectable so a test can hand back a double that records
// exactly one registration no matter how many panels attach.
type Subscribe = (spec: PanelSubscriptionSpec) => StreamSubscription | undefined;

const asRecordsSignal = (update: WsUpdate): RecordsSignal | undefined => {
    if (update.kind !== 'records.updated') return undefined;

    return update.records;
};

// A message for a failed/unavailable plane. The reader sees this in a rail, and the
// client's own clipper is what enforces this app's shortened-id text rule
// (./records-client.ts `clipRecordError`) — every message that reaches a panel goes
// through it, so a transport error naming a full uuid cannot leak into a 320px rail.

export const createRecordsWakeBroker = (subscribe: Subscribe): RecordsWakeBroker => {
    const channels = new Map<string, RecordsWakeChannel>();

    const makeChannel = (sessionId: string): RecordsWakeChannel => {
        const listeners = new Set<RecordsWakeHandlers>();

        let subscription: ReturnType<Subscribe> = undefined;
        let dialled = false;
        let released = false;
        let delivered = 0;
        // WHY this channel's plane is dead, if it is. Kept so a panel that mounts AFTER
        // the refusal is told the reason too: without it that panel waits forever for a
        // wake that can never arrive and shows a rail that reads as merely slow.
        let unavailable: string | undefined;

        const refuse = (message: string): void => {
            const reason = clipRecordError(message);

            unavailable = reason;
            for (const listener of listeners) listener.onUnavailable?.(reason);
        };

        // The registration is dialled on the FIRST attach, not on `channel()`: a
        // conversation may be named by a paint that never mounts a panel (a gate that
        // closes, a slot that is not on screen), and a registration nobody listens to
        // is exactly the leak this file exists to prevent.
        const dial = (): void => {
            if (dialled || released) return;
            dialled = true;

            const spec: PanelSubscriptionSpec = {
                scope: 'session',
                sessionId,
                onState: (state) => {
                    // The baseline belongs to every attached panel: each decides for
                    // itself whether it needs to re-read (./records-panels.ts
                    // `onBaseline` mirrors ./view-shell.ts's `pendingBaseline` rule).
                    for (const listener of listeners) listener.onBaseline?.(state);
                },
                onUpdate: (update) => {
                    const signal = asRecordsSignal(update);

                    if (signal === undefined) return;

                    delivered += 1;
                    for (const listener of listeners) listener.onSignal?.(signal);
                },
                onResync: (frame) => {
                    for (const listener of listeners) listener.onGap?.(frame);
                },
                onError: (error) => {
                    // A refusal naming this registration is final: every attached panel
                    // is told, and the channel stops pretending it is live.
                    const message = clipRecordError(error.message);

                    for (const listener of listeners) listener.onRefused?.(message);
                }
            };

            try {
                subscription = subscribe(spec);
            } catch (error) {
                subscription = undefined;
                refuse(clipRecordError(error instanceof Error ? error.message : String(error)));

                return;
            }

            if (subscription === undefined) refuse('This host has no realtime plane for record updates.');
        };

        const dispose = (): void => {
            if (released) return;
            released = true;

            channels.delete(sessionId);

            // A listener that throws must not stop the others from being released —
            // one broken panel may never strand a registration (the leak rule above).
            for (const listener of listeners) {
                try {
                    listener.onReleased?.();
                } catch {
                    // Nothing to do: the panel is going away anyway.
                }
            }

            listeners.clear();
            subscription?.unsubscribe();
            subscription = undefined;
        };

        return {
            sessionId: () => sessionId,
            live: () => subscription !== undefined,
            attached: () => listeners.size,
            frames: () => delivered,
            attach: (handlers) => {
                if (released) {
                    // A panel that attaches to a retired channel is a panel that will
                    // never be woken: say so once, through the same channel its peers
                    // would have used, rather than leaving it silently frozen.
                    handlers.onReleased?.();

                    return () => undefined;
                }

                listeners.add(handlers);
                // Captured BEFORE dialling: a fresh dial that fails notifies every
                // listener on the channel, this one included, so only a channel that was
                // ALREADY dead has a reason to replay.
                const wasDialled = dialled;
                const refusedBefore = unavailable;

                dial();

                if (wasDialled && refusedBefore !== undefined) handlers.onUnavailable?.(refusedBefore);

                return () => {
                    listeners.delete(handlers);

                    // The LAST panel to let go retires the registration. A conversation
                    // with no live panel has no business holding a slot on the plane.
                    if (listeners.size === 0) dispose();
                };
            },
            dispose
        };
    };

    return {
        channel: (sessionId) => {
            const found = channels.get(sessionId);

            if (found !== undefined) return found;

            const channel = makeChannel(sessionId);

            channels.set(sessionId, channel);

            return channel;
        },
        disposeAll: () => {
            for (const channel of [...channels.values()]) channel.dispose();
        },
        size: () => channels.size
    };
};

// ---------------------------------------------------------------------------
// The default broker, bound to the page's own context seam
// ---------------------------------------------------------------------------

// The process-wide instance. `createRecordsWakeBroker` takes the seam so a test can
// hand it a double; the default uses the SAME seam `PanelContext.subscribe` uses
// (./context.ts `defaultPanelSubscribe`), which keeps one connection and one
// subscription map for the whole page (./stream.ts:647).
let sharedBroker: RecordsWakeBroker | undefined;
// The seam the shared broker was dialled against, kept so a SECOND panel of the SAME
// host reuses it. Two live panels must share one registration; if every `subscribe`
// call replaced the broker, the first panel would be retired by the second's mount
// (a stale Tasks rail and two slots for the same frames). `PanelContext.subscribeSeam`
// is reference-stable per host for exactly this test (./context.ts).
let sharedSeam: Subscribe | null | undefined;

export const recordsWakeBroker = (subscribe?: Subscribe): RecordsWakeBroker => {
    if (subscribe === undefined) {
        if (sharedBroker === undefined) {
            sharedSeam = null;
            sharedBroker = createRecordsWakeBroker((spec) => defaultPanelSubscribe(spec));
        }

        return sharedBroker;
    }

    // The same seam this broker already speaks: nothing to replace, and the panels of
    // one host land on one channel per conversation.
    if (sharedBroker !== undefined && sharedSeam === subscribe) return sharedBroker;

    // A DIFFERENT seam means a different plane (a test host, or an embedded shell with
    // its own connection). The previous broker is released rather than orphaned, so the
    // old plane never keeps a registration nobody is listening to.
    sharedBroker?.disposeAll();
    sharedSeam = subscribe;
    sharedBroker = createRecordsWakeBroker((spec) => subscribe(spec));

    return sharedBroker;
};

/** Attaches one panel to the shared channel for `sessionId`. */
export const attachRecordsWake = (
    sessionId: string,
    handlers: RecordsWakeHandlers,
    subscribe?: Subscribe
): { channel: RecordsWakeChannel; release: () => void } => {
    const channel = recordsWakeBroker(subscribe).channel(sessionId);

    return { channel, release: channel.attach(handlers) };
};

/** Retires every shared channel (a shell teardown, or a test's last act). */
export const releaseRecordsWake = (): void => {
    sharedBroker?.disposeAll();
    // A full reset: the next mount dials its own broker, because a torn-down page's
    // registrations are gone and nothing may re-attach to a retired plane.
    sharedBroker = undefined;
    sharedSeam = undefined;
};
