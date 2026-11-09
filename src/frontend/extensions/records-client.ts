// The record store client: the ONE data plane the live shell panels read (T6/R2-R4).
//
// WHY A CLIENT AND NOT A FETCH IN EACH PANEL
// ------------------------------------------
// The store's REST reads answer with watermarks (`store_rev`, `collections_rev`,
// `revision`) and a bounded feed window, and the stream's `records.updated` frame
// carries those watermarks and NEVER a record (../shared/harness-stream.ts
// `WsUpdateRecords`). So a live view has exactly three moves:
//
//     bootstrap  `GET .../records`           every collection + the retained feed
//     delta      `GET .../records?since=N`   the feed rows after position N
//     re-fetch   the bootstrap again         a `reset`, or `collections_rev` moved
//
// and it must decide which one a given frame asks for. Doing that per panel would
// duplicate the ordering rules, double the requests, and let the two panels disagree
// about what the store holds. This module is those rules in one place: DOM-free, with
// an injectable reader, so it is testable against the exact wire shapes the server
// produces (../server/api-reads.ts `recordsSnapshotOf` / `recordsDeltaOf`).
//
// THE ONE HONEST GAP IN THE WIRE — AND HOW THIS CLIENT CLOSES IT
// --------------------------------------------------------------
// A feed row names a record (`id`), the event (`op`), who did it (`by`/`thread_id`/
// `at`) and, for an `update`, WHICH fields changed (`fields: string[]`) plus the
// record's new content revision (`item_rev`). What it never carries is the VALUES
// (`RecordChangeRow`, ../shared/harness-api.ts) — the bodies live only in a
// collection's `entries`. So:
//
//   - `remove`  is fully applicable from the row alone: the entry leaves the local
//               list, and the text the feed shows for it comes from the body this
//               client still held at that instant (a tombstone);
//   - `add` / `update` announce an identity, not a state. The row is applied at once
//               (a new task appears immediately, a revision and an actor update land
//               immediately), the entry is marked `pending`, and ONE DEBOUNCED
//               bootstrap read fills the bodies of everything that moved.
//
// That is a watermark-driven event read, not a poll: one bounded request per burst,
// coalesced through `RECORDS_BODY_REFRESH_MS`, and only when the store actually
// changed. Nothing in this file re-reads on a timer.
//
// ORDERING AND STALENESS
// ----------------------
// `seq` is store-wide and monotonic (one bump per event), so the accumulated feed is
// ordered by `seq` alone, and any row at or below the position already applied is a
// replay of something painted — including every `records.updated` frame a read has
// already covered, which is the ordinary case, not an anomaly (a burst publishes one
// frame per committed mutation while one delta read consumes them all). `rev` inside a
// row is the COLLECTION's revision (the CAS domain, never a cursor here) and
// `item_rev` is the record's content revision.
//
// `collections_rev` moves ONLY for a `define`/`drop` (a collection-set change), which
// appends no record events at all. That is not a feed gap, so the answer is a
// bootstrap re-fetch, never a "we missed something" recovery.
//
// A `reset: true` delta says this client's position is no longer answerable — the
// window trimmed past it, or the store was replaced by a reset/restore/restart. It is
// HTTP 200, it discards local state, and the partial `changes` it still carries are
// skipped: the snapshot that follows is the authority, and applying both would
// double-paint rows.
//
// THE REALTIME PLANE
// ------------------
// `linkUp` / `linkDown` / `linkError` are what a panel calls from the three
// `harnessStream()` callbacks, and they follow ./stream.ts's own rule: a loss is
// acted on at the BASELINE, not at the resync, because only the baseline can say
// whether the missing frames were replayed (the identical discipline in
// ./view-shell.ts's `pendingBaseline`). Nothing is re-read while that answer is
// outstanding.
//
// Cross-references:
//   - ../view-api.ts            — `readRecordsSnapshot` / `readRecordsDelta` (the reads)
//   - ../stream.ts              — the one shared socket a panel subscribes on
//   - ../shared/harness-api.ts  — the closed wire rows this consumes
//   - ./records-panels.ts       — the two panels that mount a client each
//   - ./records-dom.ts          — the shared live-panel DOM helpers

import type {
    RecordChangeRow,
    RecordEntryRow,
    RecordFieldDescriptor,
    RecordsDeltaResponse,
    RecordsSnapshotResponse
} from '../../shared/harness-api';
import { readRecordsDelta, readRecordsSnapshot } from '../view-api';

// The client-side cap on the accumulated feed. The STORE retains 200 events
// (engine-owned); a client keeps what it has seen across frames up to this bound, so
// a long session shows a longer history than one bootstrap could, and the panel
// discloses when the surface is a window rather than the whole log.
export const RECORDS_FEED_LIMIT = 1000;

// The engine's own retention (`RECORD_MAX_CHANGES` in ../core/records.ts), restated
// here because the footer copy has to be honest about it: events older than this are
// not retained by the session at all.
export const RECORDS_FEED_WINDOW = 200;

// How long the client waits after a burst of identity-only rows before re-reading the
// bodies: one request per burst, not one per event.
export const RECORDS_BODY_REFRESH_MS = 150;

// The built-in collection the tasks panel draws. The other built-ins (`chapters`,
// `profiles`, `locations`) and anything an agent `define`s are records-panel content.
export const TASKS_COLLECTION = 'tasks';

// ---------------------------------------------------------------------------
// The local state this client owns
// ---------------------------------------------------------------------------

// One stored record, as this client holds it. `values` carries ONLY what the read
// published: a `getOnly` field (a chapter body) is excluded from every list
// projection, and an absent key is a different fact from an empty one — a renderer
// must not paint a cell for it. `pending` is this client's flag, never the server's:
// a feed row announced this record before any read carried its body.
export type RecordsEntry = {
    id: string;
    values: Record<string, unknown>;
    rev: number;
    by?: string;
    threadId?: string;
    at?: string;
    pending: boolean;
};

// One collection: its declared field spec (canonical order — the order the store
// itself emits entries and change rows in), its watermark, its count and its entries.
export type RecordsCollection = {
    name: string;
    storeRev: number;
    count: number;
    fields: RecordFieldDescriptor[];
    entries: RecordsEntry[];
};

// One task, read off the `tasks` collection (`id`, `text`, `completed`, `rev` plus the
// attribution triple). The list is SHARED and has no owner and no claim concept by
// design, so nothing here invents one: order comes from the store, and the panel's
// tiebreak is the id.
export type RecordsTask = {
    id: string;
    text: string;
    completed: boolean;
    rev: number;
    by?: string;
    threadId?: string;
    at?: string;
    pending: boolean;
};

// What one `update` row says about one field. `before`/`after` are the values THIS
// client can vouch for, and each stays absent when it cannot: a row applied live knows
// the value the record held BEFORE (it was on screen) and not the one after (the row
// carries no bodies), and the debounced bootstrap backfills `after` for the newest row
// of that record only. A mid-burst row's intermediate value is not knowable, and
// inventing one would be a fabricated history.
export type RecordsFieldChange = {
    field: string;
    before?: string;
    after?: string;
};

// One feed entry, resolved against local state AT THE MOMENT it was applied.
export type RecordsFeedRow = {
    seq: number;
    collection: string;
    id: string;
    op: RecordChangeRow['op'];
    /** The collection's revision at this event (a CAS figure, never a cursor). */
    rev: number;
    itemRev?: number;
    /** Absent when the caller had no identity — the panel then shows a neutral actor. */
    by?: string;
    threadId?: string;
    at: string;
    /** Best-known display text of the record at event time ('' = never known). */
    label: string;
    /** Whether `label` is backed by a body this client actually held. */
    known: boolean;
    changes: RecordsFieldChange[];
    /**
     * `live` — applied from a delta row in `seq` order and resolved against the state
     * BEFORE the event. `snapshot` — seeded or merged from a bootstrap, where the
     * state on screen is already the state AFTER the event (so only `after` is
     * knowable, and the entry needs no body read).
     */
    source: 'live' | 'snapshot';
};

export type RecordsPhase = 'loading' | 'ready' | 'error';

export type RecordsLinkState = 'unknown' | 'live' | 'down';

// What a panel is told on every state change. `reason` is the client's account of what
// happened; `rows` are the feed entries this update ADDED (in `seq` order); `touched`
// names the collections whose entries or counts moved; `replaced` means the
// collections were rebuilt wholesale (a bootstrap, a reset or a `define`/`drop`), so a
// panel must re-render its lists instead of patching the rows it holds.
export type RecordsNotice = {
    reason: 'boot' | 'delta' | 'reset' | 'collections' | 'bodies' | 'link' | 'error';
    phase: RecordsPhase;
    stale: boolean;
    link: RecordsLinkState;
    rows: RecordsFeedRow[];
    touched: string[];
    replaced: boolean;
    error?: string;
};

export type RecordsReader = {
    snapshot: (sessionId: string) => Promise<RecordsSnapshotResponse>;
    delta: (sessionId: string, since: number) => Promise<RecordsDeltaResponse>;
};

export type RecordsClientOptions = {
    /** The conversation whose record store this client reads. */
    sessionId: string;
    /** Override the REST reads (the default is ../view-api.ts's two records reads). */
    reader?: RecordsReader;
    /** Feed cap. */
    feedLimit?: number;
    /** Body-refresh debounce. Pass 0 to re-read the store per applied batch (a test). */
    bodyRefreshMs?: number;
    /** Injectable timer so a test fires the debounce instead of sleeping. */
    schedule?: (run: () => void, ms: number) => () => void;
    /** Paint hook: called once per state change, after the state has moved. */
    onNotice?: (notice: RecordsNotice) => void;
    /** Injectable clock for `lastSyncAt` (the panel's "last updated Xs ago"). */
    now?: () => number;
};

export type RecordsClient = {
    sessionId: () => string;
    /** `loading` until the first read lands; `error` only when NOTHING was read. */
    phase: () => RecordsPhase;
    error: () => string | undefined;
    /** True while the last sync attempt failed or the realtime plane is down. */
    stale: () => boolean;
    linkState: () => RecordsLinkState;
    /** Epoch ms of the last successful read; 0 when there has been none. */
    lastSyncAt: () => number;
    /** The three watermarks, exactly as the last successful read stated them. */
    watermarks: () => { storeRev: number; collectionsRev: number; revision: number };
    /** Every collection, in the order the store published them. */
    collections: () => RecordsCollection[];
    collection: (name: string) => RecordsCollection | undefined;
    /** The accumulated feed, oldest first (the panel renders it newest-first). */
    feed: () => RecordsFeedRow[];
    /**
     * Whether the visible feed is a window rather than the whole log: the store
     * trimmed events away, or this client capped its own accumulation.
     */
    feedTruncated: () => boolean;
    /** The tasks collection, projected for the tasks panel ([] when absent). */
    tasks: () => RecordsTask[];
    /**
     * The locally accumulated history of one record, newest first, with the honest
     * disclosure of whether older events exist that this client never saw.
     */
    historyOf: (collection: string, id: string) => { items: RecordsFeedRow[]; truncated: boolean };
    /** The first read (a bootstrap). Idempotent while one is in flight. */
    boot: () => Promise<void>;
    /** The delta read from the current position. */
    pull: (reason?: RecordsNotice['reason']) => Promise<void>;
    /** A wholesale re-read (a reset, a `define`/`drop`, a Retry press). */
    refresh: (reason?: RecordsNotice['reason']) => Promise<void>;
    /**
     * The `records.updated` frame's payload — the only wake this client accepts. Both
     * watermarks are optional because a wake carries no data at all: a payload with
     * neither is ignored, and a payload naming only `collections_rev` is a re-read,
     * never a gap recovery.
     */
    frame: (signal: { store_rev?: number; collections_rev?: number }) => void;
    /** The subscription is (re)registered: the plane is live again. */
    linkUp: (revision?: number) => void;
    /** The connection dropped; the reconciliation waits for the next baseline. */
    linkDown: () => void;
    /**
     * True while the answer to an outage is outstanding: the next baseline owns that
     * reconciliation (./view-shell.ts's `pendingBaseline` rule), so a panel that also
     * re-reads here would pay for the same answer twice.
     */
    resyncPending: () => boolean;
    /** The subscription was refused outright (`unknown_resource`, an unsupported filter). */
    linkError: (message: string) => void;
    dispose: () => void;
    disposed: () => boolean;
};

// ---------------------------------------------------------------------------
// Small pure helpers (exported: the panels and their tests read the same rules)
// ---------------------------------------------------------------------------

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// A server error message is a URL deep: `unexpected request: GET
// /v1/harness/sessions/3f2a9c1b-7788-…-5d6e/records`. This app's own text rule is that
// a conversation is identified SHORTENED on screen — `shortId` in ./main.ts:9315 draws
// the pills as `3f2a9c1b` — and a rail is ~320px wide, so an unclipped message would
// wrap a whole uuid into the panel's chrome. Shortening the ID-shaped substrings (any
// group of hyphen-joined hex runs of 9+ characters, which covers a uuid, an arbitrary
// conversation id and a turn id alike) keeps the sentence readable and loses nothing a
// reader could act on; the full text stays available in the note's `title`, which is why
// this is honest rather than lossy.
const RECORDS_ID_SHAPE = /[0-9a-f]{4,}(?:-[0-9a-f]+)+/gi;

export const RECORDS_ERROR_CLIP = 160;

export const clipRecordError = (message: string): string => {
    const shortened = message.replace(RECORDS_ID_SHAPE, (id) => id.slice(0, 8));

    return shortened.length <= RECORDS_ERROR_CLIP ? shortened : `${shortened.slice(0, RECORDS_ERROR_CLIP)}…`;
};

const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// A field value as a reader should see it. `undefined` means "this read did not
// publish the field" (a `getOnly` body, or a field the record never set) — deliberately
// different from an empty string.
export const recordsDisplayValueOf = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);

    if (Array.isArray(value)) {
        const parts = value.filter((item): item is string => typeof item === 'string');

        return parts.length === 0 ? undefined : parts.join(', ');
    }

    if (value === null) return undefined;

    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
};

// The field a record is recognised by: `text` for tasks, then the naming fields the
// built-in collections use, then the first declared field that is not a `strings` list
// (a tag list names nothing), then the first declared field at all. A record whose
// display field is absent from the read renders as its id alone — never a body this
// read did not publish.
export const RECORDS_PREFERRED_DISPLAY_FIELDS = Object.freeze(['text', 'title', 'name', 'label', 'summary', 'question']);

export const recordsDisplayFieldOf = (collection: RecordsCollection): string | undefined => {
    const declared = collection.fields.map((field) => field.key);

    for (const key of RECORDS_PREFERRED_DISPLAY_FIELDS) if (declared.includes(key)) return key;

    for (const field of collection.fields) if (field.type !== 'strings') return field.key;

    return declared[0];
};

// The text one record is shown by, and whether a body actually backs it.
export const recordsLabelOf = (
    collection: RecordsCollection | undefined,
    entry: RecordsEntry | undefined
): { label: string; known: boolean } => {
    if (collection === undefined || entry === undefined) return { label: '', known: false };

    const field = recordsDisplayFieldOf(collection);
    if (field === undefined) return { label: '', known: false };

    const value = recordsDisplayValueOf(entry.values[field]);
    if (value === undefined || value.length === 0) return { label: '', known: false };

    return { label: value, known: true };
};

// The actor a badge renders: an agent name, or the neutral `system` when the store has
// no identity for the event (an engine restored from a snapshot, or a caller with no
// agent context). The attribution keys are ABSENT in that case, and inventing a name
// there is the failure mode this helper exists to prevent.
export const recordsActorOf = (row: { by?: string; threadId?: string }): { name: string; kind: 'agent' | 'system' } => {
    const name = asString(row.by);

    return name === undefined || name.length === 0
        ? { name: 'system', kind: 'system' }
        : { name, kind: 'agent' };
};

// The wire keys that are metadata rather than a record's own fields. A stored entry's
// key set is OPEN (the fields belong to its collection), so these are removed by name
// and everything else the read published is the record's values.
const RECORDS_META_KEYS = Object.freeze(['id', 'rev', 'updated_by', 'updated_thread_id', 'updated_at']);

// One wire entry row -> the local entry. A body read from the store is a body, so
// `pending` is false here by construction.
export const recordsEntryOf = (row: RecordEntryRow): RecordsEntry => {
    const values: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (RECORDS_META_KEYS.includes(key)) continue;
        values[key] = value;
    }

    const by = asString(row.updated_by);
    const threadId = asString(row.updated_thread_id);
    const at = asString(row.updated_at);

    return {
        id: row.id,
        values,
        rev: asNumber(row.rev) ?? 0,
        ...(by === undefined ? {} : { by }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(at === undefined ? {} : { at }),
        pending: false
    };
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
    const timer = globalThis.setTimeout(run, ms);

    return () => globalThis.clearTimeout(timer);
};

export const createRecordsClient = (options: RecordsClientOptions): RecordsClient => {
    const sessionId = options.sessionId;
    const reader: RecordsReader = options.reader ?? {
        snapshot: readRecordsSnapshot,
        delta: readRecordsDelta
    };
    const feedLimit = options.feedLimit ?? RECORDS_FEED_LIMIT;
    const bodyRefreshMs = options.bodyRefreshMs ?? RECORDS_BODY_REFRESH_MS;
    const schedule = options.schedule ?? defaultSchedule;
    const now = options.now ?? ((): number => Date.now());

    const collections = new Map<string, RecordsCollection>();
    const feed: RecordsFeedRow[] = [];
    // The last known body of a record that left the store, so a `removed …` row can
    // still name what was removed. Bounded: a display cache, not a journal.
    const tombstones = new Map<string, RecordsEntry>();

    let phase: RecordsPhase = 'loading';
    let errorMessage: string | undefined;
    let stale = false;
    let link: RecordsLinkState = 'unknown';
    let lastSyncAt = 0;
    let booted = false;
    let storeRev = 0;
    let collectionsRev = 0;
    let revision = 0;
    // Rows this client capped away (its own 1000-entry bound), and the lowest store
    // position the accumulated feed reaches. Together they answer "is this a window?".
    let dropped = 0;
    let oldestSeq = 0;
    // A resync may only be acted on by the BASELINE that follows it, and only once
    // (the ./view-shell.ts `pendingBaseline` discipline).
    let resyncPending = false;
    let disposed = false;
    // Bumped when the local state is thrown away (a reset) or the owner goes away; an
    // in-flight read of a superseded generation never paints.
    let generation = 0;

    let pulling = false;
    let pullAgain = false;
    let refreshing = false;
    let refreshAgain = false;
    let bodyCancel: (() => void) | undefined;

    const notice = (reason: RecordsNotice['reason'], extra: Partial<RecordsNotice> = {}): void => {
        if (disposed || options.onNotice === undefined) return;

        options.onNotice({
            reason,
            phase,
            stale,
            link,
            rows: extra.rows ?? [],
            touched: extra.touched ?? [],
            replaced: extra.replaced ?? false,
            ...(extra.error === undefined ? {} : { error: extra.error })
        });
    };

    const keyOf = (collection: string, id: string): string => `${collection}\u001f${id}`;

    const remember = (collection: string, entry: RecordsEntry): void => {
        tombstones.set(keyOf(collection, entry.id), entry);

        while (tombstones.size > 400) {
            const oldest = tombstones.keys().next();
            if (oldest.done === true) break;
            tombstones.delete(oldest.value);
        }
    };

    const collectionOf = (name: string): RecordsCollection | undefined => collections.get(name);

    // A live record first, then a body this client held until the record was removed.
    const entryOf = (collection: string, id: string): RecordsEntry | undefined =>
        collections.get(collection)?.entries.find((entry) => entry.id === id) ?? tombstones.get(keyOf(collection, id));

    // The position the accumulated feed reaches. A bootstrap with no events answers
    // `store_rev` with an empty window, so the fallback is the store's own position.
    const feedSeq = (): number => (feed.length === 0 ? storeRev : feed[feed.length - 1].seq);

    // --- feed resolution -----------------------------------------------------

    // Turns one wire row into a display row. `late` says which side of the event the
    // state on screen is: false for a live apply (the prior value is knowable), true
    // for a snapshot seed/merge (the current value is). Neither may claim the other.
    const resolveRow = (row: RecordChangeRow, late: boolean): RecordsFeedRow => {
        const collection = collectionOf(row.collection);
        const entry = entryOf(row.collection, row.id);
        const changes: RecordsFieldChange[] = [];
        const by = asString(row.by);
        const threadId = asString(row.thread_id);
        const itemRev = asNumber(row.item_rev);

        for (const field of row.fields ?? []) {
            const value = recordsDisplayValueOf(entry?.values[field]);
            const half = value === undefined ? {} : late ? { after: value } : { before: value };

            changes.push({ field, ...half });
        }

        const resolved = recordsLabelOf(collection, entry);

        return {
            seq: row.seq,
            collection: row.collection,
            id: row.id,
            op: row.op,
            rev: row.rev,
            ...(itemRev === undefined ? {} : { itemRev }),
            ...(by === undefined ? {} : { by }),
            ...(threadId === undefined ? {} : { threadId }),
            at: row.at,
            label: resolved.label,
            known: resolved.known,
            changes,
            source: late ? 'snapshot' : 'live'
        };
    };

    // Appends in `seq` order and caps the accumulation.
    const pushRow = (row: RecordsFeedRow): void => {
        feed.push(row);

        if (oldestSeq === 0) oldestSeq = row.seq;

        while (feed.length > feedLimit) {
            feed.shift();
            dropped += 1;
            oldestSeq = feed.length > 0 ? feed[0].seq : storeRev;
        }
    };

    // Applies one row to the local ENTRY state. Returns whether the collection's
    // bodies still need reading — the `add`/`update` case in the header note.
    const applyEntry = (row: RecordChangeRow): boolean => {
        const collection = collections.get(row.collection);

        if (collection === undefined) {
            // A row naming a collection no read has carried yet (an agent defined it
            // between two reads): the set moved, so the bodies are one bootstrap away
            // whatever the op.
            return row.op !== 'remove';
        }

        collection.storeRev = Math.max(collection.storeRev, row.rev);

        if (row.op === 'remove') {
            const index = collection.entries.findIndex((entry) => entry.id === row.id);

            if (index >= 0) {
                // Keep the body the feed row was resolved from, for the "removed X" line.
                remember(row.collection, collection.entries[index]);
                collection.entries.splice(index, 1);
            }

            collection.count = Math.max(0, collection.entries.length);
            tombstones.delete(keyOf(row.collection, row.id));

            return false;
        }

        const itemRev = asNumber(row.item_rev);
        const by = asString(row.by);
        const threadId = asString(row.thread_id);
        const existing = collection.entries.find((entry) => entry.id === row.id);

        if (existing === undefined) {
            if (row.op !== 'add') {
                // An update for a record this client has no body for (it predates the
                // store's retained window, or a cap trimmed it): do not stage a
                // half-known record — the bootstrap that follows brings the real one.
                return true;
            }

            // A brand-new record. The identity is the story ("it appeared just now"),
            // so the row is staged at once, text still unknown.
            collection.entries.push({
                id: row.id,
                values: {},
                rev: itemRev ?? 0,
                ...(by === undefined ? {} : { by }),
                ...(threadId === undefined ? {} : { threadId }),
                at: row.at,
                pending: true
            });
            collection.count = collection.entries.length;

            return true;
        }

        tombstones.delete(keyOf(row.collection, existing.id));

        if (itemRev !== undefined) existing.rev = itemRev;
        if (by !== undefined) existing.by = by;
        if (threadId !== undefined) existing.threadId = threadId;
        existing.at = row.at;

        // An `update` never says which VALUE a field took, so the body stays whatever
        // the last read stated — and the collection stays dirty until it is re-read.
        return true;
    };

    // Applies a batch in `seq` order, skipping anything at or below `since` (a replay,
    // or rows a read already covered). The caller passes the cursor explicitly: the
    // watermarks move before the rows are applied, and a skip test that read them
    // afterwards would drop the whole window.
    const applyRows = (
        rows: readonly RecordChangeRow[],
        late: boolean,
        since: number
    ): { added: RecordsFeedRow[]; touched: string[]; bodies: boolean } => {
        const added: RecordsFeedRow[] = [];
        const touched: string[] = [];
        let bodies = false;
        let position = since;

        for (const row of [...rows].sort((left, right) => left.seq - right.seq)) {
            if (row.seq <= position) continue;

            const resolved = resolveRow(row, late);
            const needsBodies = late ? false : applyEntry(row);

            pushRow(resolved);
            added.push(resolved);
            position = row.seq;

            if (!touched.includes(row.collection)) touched.push(row.collection);
            if (needsBodies) bodies = true;
        }

        return { added, touched, bodies };
    };

    // Backfills the value an update row could not carry. Only the NEWEST row of a
    // record gets it: for every older row the value that follows belongs to a later
    // event as well, and attributing it to the earlier one would be an invention. It
    // also resolves a staged `add` placeholder (the row that appeared before its body
    // was readable) and clears `pending` on everything the read carried.
    const backfillBodies = (): void => {
        const newest = new Map<string, RecordsFeedRow>();

        for (const row of feed) if (row.op !== 'remove') newest.set(keyOf(row.collection, row.id), row);

        for (const [key, row] of newest) {
            const collection = collectionOf(row.collection);
            if (collection === undefined) continue;

            const entry = collection.entries.find((candidate) => candidate.id === row.id);
            if (entry === undefined) continue;

            entry.pending = false;

            for (const change of row.changes) {
                const value = recordsDisplayValueOf(entry.values[change.field]);
                if (value !== undefined) change.after = value;
            }

            const resolved = recordsLabelOf(collection, entry);

            if (resolved.known) {
                row.label = resolved.label;
                row.known = true;
            }

            tombstones.delete(key);
        }
    };

    // --- the two reads -------------------------------------------------------

    // The first snapshot of a conversation: its retained window IS the feed.
    const seedFeed = (rows: readonly RecordChangeRow[]): RecordsFeedRow[] => {
        feed.length = 0;
        dropped = 0;
        oldestSeq = 0;

        return applyRows(rows, true, 0).added;
    };

    // Adopts a whole snapshot. The collections are rebuilt (they are the authority for
    // the bodies, the counts, the field specs and the collection set); the accumulated
    // feed is KEPT, because the snapshot's own window is only 200 events and replacing
    // the log would shorten a panel's history every time a body needed reading. Rows
    // the snapshot carries beyond the applied position are merged in, which is what
    // closes a gap without a second read.
    const adoptSnapshot = (body: RecordsSnapshotResponse, reason: RecordsNotice['reason']): void => {
        const reRead = booted;
        // Captured before the watermarks move: the position the local state describes.
        const since = reRead ? feedSeq() : 0;

        collections.clear();
        tombstones.clear();

        for (const row of body.collections) {
            collections.set(row.name, {
                name: row.name,
                storeRev: row.store_rev,
                count: row.count,
                fields: row.fields.map((field) => ({
                    ...field,
                    ...(field.values === undefined ? {} : { values: [...field.values] })
                })),
                entries: row.entries.map(recordsEntryOf)
            });
        }

        storeRev = body.store_rev;
        collectionsRev = body.collections_rev;
        revision = body.revision;
        lastSyncAt = now();
        stale = false;
        errorMessage = undefined;
        booted = true;
        phase = 'ready';

        if (reRead) {
            const merged = applyRows(body.changes, true, since);
            backfillBodies();

            notice(reason, {
                rows: merged.added,
                touched: [...collections.keys()],
                replaced: true
            });

            return;
        }

        seedFeed(body.changes);

        notice(reason, { rows: [...feed], touched: [...collections.keys()], replaced: true });
    };

    const refresh = async (reason: RecordsNotice['reason'] = 'boot'): Promise<void> => {
        if (disposed) return;

        if (refreshing) {
            // A wholesale re-read asked for while one is in flight is remembered, not
            // dropped: the frame that arrived mid-read describes a store the answer
            // cannot show (a `define`, or a reset).
            if (reason === 'collections' || reason === 'reset' || reason === 'boot') refreshAgain = true;

            return;
        }

        refreshing = true;
        const owner = generation;

        try {
            const body = await reader.snapshot(sessionId);
            if (disposed || owner !== generation) return;

            adoptSnapshot(body, reason);
        } catch (error) {
            if (disposed || owner !== generation) return;
            fail(error, reason);
        } finally {
            refreshing = false;

            if (refreshAgain && !disposed) {
                refreshAgain = false;
                await refresh('collections');
            }
        }
    };

    const pull = async (reason: RecordsNotice['reason'] = 'delta'): Promise<void> => {
        if (disposed) return;

        // A delta needs a position a bootstrap stated.
        if (!booted) {
            await refresh('boot');

            return;
        }

        if (pulling) {
            // A wake during a read: one more pass afterwards, so a burst is never
            // swallowed by the request that happened to be in flight.
            pullAgain = true;

            return;
        }

        pulling = true;
        const owner = generation;
        const since = feedSeq();
        const previousCollectionsRev = collectionsRev;

        try {
            const body = await reader.delta(sessionId, storeRev);
            if (disposed || owner !== generation) return;

            // The honest "your cursor is dead" answer (200, not an error): discard and
            // re-bootstrap. `generation` moves so nothing from before paints.
            if (body.reset) {
                generation += 1;
                feed.length = 0;
                collections.clear();
                tombstones.clear();
                dropped = 0;
                oldestSeq = 0;
                booted = false;
                storeRev = 0;
                phase = 'loading';

                await refresh('reset');

                return;
            }

            const applied = applyRows(body.changes, false, since);

            storeRev = Math.max(storeRev, body.store_rev, feedSeq());
            collectionsRev = body.collections_rev;
            revision = body.revision;
            lastSyncAt = now();
            stale = false;
            errorMessage = undefined;

            notice('delta', { rows: applied.added, touched: applied.touched });

            // A collection-set move carries no record events, so it is not a gap:
            // re-fetch the snapshot for the new field specs and counts.
            if (body.collections_rev !== previousCollectionsRev) {
                await refresh('collections');

                return;
            }

            // An `add`/`update` announced identities without bodies: one coalesced
            // read for the whole burst.
            if (applied.bodies) scheduleBodies();
        } catch (error) {
            if (disposed || owner !== generation) return;
            fail(error, reason);
        } finally {
            pulling = false;

            if (pullAgain && !disposed) {
                pullAgain = false;
                await pull('delta');
            }
        }
    };

    const scheduleBodies = (): void => {
        if (disposed || bodyCancel !== undefined) return;

        if (bodyRefreshMs <= 0) {
            void refresh('bodies');

            return;
        }

        bodyCancel = schedule(() => {
            bodyCancel = undefined;

            if (!disposed) void refresh('bodies');
        }, bodyRefreshMs);
    };

    const fail = (error: unknown, reason: RecordsNotice['reason']): void => {
        const message = clipRecordError(error instanceof Error ? error.message : String(error));

        stale = true;
        errorMessage = message;

        // A first read that failed is the panel's error state; a later one keeps the
        // rows on screen and reads as STALE, because they are still the last honest
        // answer this client has.
        if (!booted) phase = 'error';

        // The published message is the clipped one, so the panel's live region and its
        // visible note carry the same shortened text (see `clipRecordError` above).
        notice(reason === 'delta' || reason === 'bodies' ? 'error' : reason, { error: message });
    };

    // --- the realtime plane --------------------------------------------------

    const frame = (signal: { store_rev?: number; collections_rev?: number }): void => {
        if (disposed) return;

        // A wake that names neither watermark carries nothing this client can act on
        // (the contract's `RecordsSignal` always sends both, so this is a hostile
        // payload, not a normal frame).
        const storeRevSeen = typeof signal.store_rev === 'number' && Number.isFinite(signal.store_rev);
        const collectionsRevSeen =
            typeof signal.collections_rev === 'number' && Number.isFinite(signal.collections_rev);

        if (!storeRevSeen && !collectionsRevSeen) return;

        // A wake before the first read (a socket that was down at mount): bootstrap.
        if (!booted) {
            void refresh('boot');

            return;
        }

        // `collections_rev` moves only for a define/drop, which appends no rows: a
        // snapshot re-read, never a gap recovery.
        if (collectionsRevSeen && signal.collections_rev !== collectionsRev) {
            void refresh('collections');

            return;
        }

        // At or below the position a read already stated: covered. The ordinary case.
        if (typeof signal.store_rev !== 'number' || !Number.isFinite(signal.store_rev)) return;
        if (signal.store_rev <= storeRev) return;

        void pull('delta');
    };

    const linkUp = (hubRevision?: number): void => {
        if (disposed) return;

        const changed = link !== 'live';
        link = 'live';

        if (typeof hubRevision === 'number' && Number.isFinite(hubRevision)) {
            // The baseline's `records` revision: the same counter a read answers in
            // `revision`, kept so a frame can always be ordered against a response
            // (../shared/harness-stream.ts, the reconciliation note).
            revision = Math.max(revision, hubRevision);
        }

        // THE OUTAGE'S ANSWER ARRIVES HERE. A resumed baseline replayed the missing
        // frames (the delta then finds nothing new); a fresh one means they are gone
        // and the delta recovers exactly what the retained window still holds.
        if (resyncPending) {
            resyncPending = false;
            // THE CONNECTION IS NEWS EVEN WHEN A RE-READ FOLLOWS IT. The pull's notice
            // only ever speaks of rows, and a delta that finds nothing new says nothing
            // at all — without this the reader who was told "disconnected" never hears
            // the plane come back.
            if (changed) notice('link');
            void pull('delta');

            return;
        }

        if (!booted) {
            void refresh('boot');

            return;
        }

        // Nothing was re-read and no data moved: repaint only the connection hint.
        if (changed) notice('link');
    };

    const linkDown = (): void => {
        if (disposed) return;

        link = 'down';
        resyncPending = true;
        // The rows on screen stay: they are the last honest answer. What changes is the
        // panel's notice that they may not be current.
        stale = true;
        notice('link');
    };

    const linkError = (message: string): void => {
        if (disposed) return;

        link = 'down';
        stale = true;
        errorMessage = clipRecordError(message);

        if (!booted) phase = 'error';

        // Same clipped text the panel's note shows: one sentence, one shape, on screen
        // and in the live region.
        notice('error', { error: errorMessage });
    };

    const dispose = (): void => {
        if (disposed) return;

        disposed = true;
        // Any read still in flight belongs to a panel that is gone.
        generation += 1;
        collections.clear();
        tombstones.clear();
        feed.length = 0;

        if (bodyCancel !== undefined) {
            bodyCancel();
            bodyCancel = undefined;
        }
    };

    // --- derived views -------------------------------------------------------

    const tasks = (): RecordsTask[] => {
        const collection = collectionOf(TASKS_COLLECTION);
        if (collection === undefined) return [];

        return collection.entries.map((entry) => ({
            id: entry.id,
            text: typeof entry.values.text === 'string' ? entry.values.text : '',
            completed: entry.values.completed === true,
            rev: entry.rev,
            ...(entry.by === undefined ? {} : { by: entry.by }),
            ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
            ...(entry.at === undefined ? {} : { at: entry.at }),
            pending: entry.pending
        }));
    };

    const historyOf = (
        collection: string,
        id: string
    ): { items: RecordsFeedRow[]; truncated: boolean } => {
        const items = feed.filter((row) => row.collection === collection && row.id === id).reverse();
        const entry = entryOf(collection, id);

        // `rev` starts at 1 and bumps once per real content change, so a record at
        // `rev` N has N events behind it (its add plus N-1 updates). Fewer rows here
        // than that means older events exist that this client never saw — the store's
        // 200-event window, or this client's own cap.
        const expected = entry === undefined ? items.length : Math.max(1, entry.rev);
        const windowed = dropped > 0 || (feed.length === 0 ? storeRev > 0 : oldestSeq > 1);

        return { items, truncated: items.length < expected || windowed };
    };

    return {
        sessionId: () => sessionId,
        phase: () => phase,
        error: () => errorMessage,
        stale: () => stale,
        linkState: () => link,
        lastSyncAt: () => lastSyncAt,
        watermarks: () => ({ storeRev, collectionsRev, revision }),
        collections: () => [...collections.values()],
        collection: collectionOf,
        feed: () => [...feed],
        // A window rather than the whole log: this client capped rows away, or the
        // accumulated feed does not reach event 1 while the store has emitted events.
        feedTruncated: () => dropped > 0 || (feed.length === 0 ? storeRev > 0 : oldestSeq > 1),
        tasks,
        historyOf,
        boot: () => refresh('boot'),
        pull: (reason) => pull(reason ?? 'delta'),
        refresh: (reason) => refresh(reason ?? 'boot'),
        frame,
        linkUp,
        linkDown,
        // Whether the answer to an outage is still outstanding. A panel that also
        // re-reads on the next baseline would pay twice for one answer, so it asks
        // this before pulling (./extensions/records-panels.ts `onBaseline`).
        resyncPending: () => resyncPending,
        linkError,
        dispose,
        disposed: () => disposed
    };
};
