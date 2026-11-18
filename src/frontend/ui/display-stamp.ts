// The cheap change stamp of ONE compiled display tree (T23/C1).
//
// WHAT IT IS FOR: `ui/turns.ts` `syncCompiledDisplay` (:8321) skips its whole node-level
// pass when the tree an applied document carries is the tree the tile is ALREADY painted
// from. The gate needs a CONTENT comparison, not a reference comparison, because the
// stream-ops fold mutates the very object a tile was painted from, IN PLACE
// (../view-state.ts:396 `sections.push`, :443 `node.text += op.delta`, :509
// `sections.splice`, :623 the `context:add` verdict carry-over). It runs per painted tile
// per applied document — every stream frame (./main.ts:13832) and every 1 s poll tick —
// over trees up to ~1 MB.
//
// THE CONTRACT (both directions, pinned in ./display-stamp.test.ts and at the DOM level in
// ./turns-compiled.test.ts:1089):
//   unchanged content ⇒ SAME stamp    (the skip fires: no Markdown re-parse, no lost selection)
//   any change        ⇒ DIFFERENT stamp (an in-place mutation is never frozen)
//
// WHY NOT `JSON.stringify` (what T23/C1 replaced): it was byte-exact, which is the right
// safety property, but its cost is proportional to the tree's BYTES. Measured with
// Temp/coding-t23/stamp-bench.ts on the real 974 KB tree another writer captured
// (Temp/coding-t13/display-1.json — 3 sections, 1099 nodes, 1100 context blocks): one
// stringify is 1.9-2.5 ms, and the gate pays it per tile per applied document. A first
// attempt that kept V1's generic key-by-key walk and bounded only long strings was 8.05 ms
// — SLOWER, because `Object.keys` per object and one array push per property cost more than
// V8's native stringify. A second attempt that hashed the leaf sub-values
// (`pending`/`panels`/`media`/`action`) through `JSON.stringify` was 4.17 ms. What is fast
// here is knowing the model and memoizing the repeated vocabulary: the tree has three shapes
// (section, node, context block), so this file walks them directly, reads only the fields
// that can change what a tile paints, never materialises a key list, and digests each
// distinct short string once (`digestOf`). Measured on the same tree: 1.6-1.9 ms, ~1.2x
// under the signature it replaces — and, unlike the signature, independent of how many BYTES
// that tree carries, which is the case a long streaming answer is.
//
// HOW A SCALAR-ONLY WALK STILL SEES EVERY CHANGE: two independent 32-bit accumulators are
// mixed with every value in tree order (a different mixer per accumulator, so a collision
// has to land on both), alongside an explicit IDENTITY string of the turn id and every
// section / node / block id in order. The identity part is exact — it pins structure,
// ordering, insertion and removal — and the pair pins the content and the counters. A
// missed change would need both accumulators to collide on the same input, and its cost is
// one stale frame that the next differing document corrects; a false change costs one
// redundant repaint, which is always safe.
//
// WHY LONG STRINGS ARE SAMPLED: a streaming prose body, a tool payload and a redacted
// preview are the tree's bytes, and their characters are exactly what must not be hashed one
// by one per frame. Above `SHORT_STRING_CHARS` a string contributes its length plus its head
// and tail characters — the parts every real mutation touches: `node:append`
// (../view-state.ts:443) grows the length and moves the tail; a redaction or un-redaction
// (:494/:495) swaps the body and flips the `redacted` marker; a `node:set` preview swap
// (:478) changes the length. The ONE case a byte-exact signature sees and this does not is a
// middle edit of a long string that keeps its length and both ends identical — the stream
// contract never sends it, and the server's own designation stamp `tailStampOf`
// (../server/turn-projector.ts:1834) makes the same deliberate trade by excluding prose
// length. It is pinned as the boundary in ./display-stamp.test.ts rather than left implicit.
//
// WHY `revision` IS IN HERE AND WHY IT IS NOT ENOUGH ALONE: the wire carries the server's
// per-tree counter (../shared/harness-api.ts:3596, served at src/server/api.ts:5174) and
// ./display-project.ts:444 now passes it through instead of dropping it, so a fresh read of
// a tree repaints deterministically. The ops fold never restamps it on the object it just
// mutated, so the content walk above remains the mechanism.
//
// MAINTENANCE RULE (the price of the typed walk, stated so it cannot drift silently): a new
// display field that can change what a tile paints must be added to the field list that
// covers its shape, and to ./display-stamp.test.ts's mutation set. Fields of shapes this
// file does not type out (`pending`, `panels`, `media`, `action`, and any future object a
// wire value carries inside a step) go through the bounded digest, which sees them all.
import type { ContextBlock, DisplayNode, DisplayTail, TurnDisplay, TurnSection } from '../../shared/turn-display';

// At or below this length a string contributes its characters VERBATIM: every field the
// renderer paints from a bounded wire value (a notice line, a name, a state word, an id, a
// short preview) sits in this band, so an in-place rewrite of it cannot be missed.
const SHORT_STRING_CHARS = 96;

// The head and tail window sampled from a longer string: two slices plus a length read, so
// a 400 KB answer body costs the same as a 400 byte one.
const SAMPLE_CHARS = 24;

// Memoized string digests. A change stamp hashes the SAME small vocabulary over and over —
// `done`, `tool`, `streaming`, a tool name, a wire key name — and hashing the characters of
// a string that a previous frame already hashed is pure waste. A `Map` keyed by the string
// itself is EXACT (a hit means the strings are equal by value), so this is a speed device
// with no collision cost at all. Ids and prose samples are unique, so they miss; the cap
// stops the cache growing without bound on a long-lived session, after which a new string is
// hashed directly and never stored.
const DIGEST_CACHE_LIMIT = 8192;
const digestCache = new Map<string, number>();

const digestOf = (value: string): number => {
    const cached = digestCache.get(value);

    if (cached !== undefined) return cached;

    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;

    if (digestCache.size < DIGEST_CACHE_LIMIT) digestCache.set(value, hash);

    return hash;
};

// A value that fits a 32-bit int without losing high bits: display timestamps are epoch ms,
// which exceed int32, so both halves are mixed and 1.7e12 cannot alias 6.3e9.
const mixNumber = (value: number, mixInt: (bits: number) => void): void => {
    const whole = Math.trunc(value);

    mixInt(whole | 0);
    mixInt(Math.floor(whole / 0x80000000) | 0);
    mixInt(Math.trunc((value - whole) * 1e6));
};

export const displayStampOf = (display: TurnDisplay): string => {
    // The exact part: ids and counts, in tree order. Insertion, removal and reordering all
    // move this string, so a hash collision can never hide a STRUCTURAL change.
    const ids: string[] = [];

    // Two independent accumulators. `mixInt` is the only writer, so no field can reach one
    // without reaching the other; they use different multipliers and different mixing
    // constants, so a collision must satisfy both.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;

    const mixInt = (bits: number): void => {
        h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + (bits ^ 0x85ebca6b), 0xc2b2ae35) >>> 0;
    };

    // The sampled window's digest, then the length, then the band bit: `abc` and `abcd`
    // cannot alias, and a string crossing the sampling boundary is a signal in itself. The
    // digest is memoized (see `digestOf`), which is what keeps the ~25k short-string fields of
    // a 1000-node tree from costing a character loop each, per frame.
    const mixText = (value: string): void => {
        const window =
            value.length <= SHORT_STRING_CHARS
                ? value
                : `${value.slice(0, SAMPLE_CHARS)}${value.slice(-SAMPLE_CHARS)}`;

        mixInt(digestOf(window));
        mixInt(value.length);
        mixInt(value.length <= SHORT_STRING_CHARS ? 0 : 1);
    };

    // A field of the model, whatever its declared kind. `undefined` (absent OR explicitly
    // absent, the contract's "this frame says nothing") has its own constant, which is how a
    // verdict appearing or disappearing is seen: `pending`/`included`/`redacted` all move
    // between "no statement" and a value (../view-state.ts:495/:657).
    const mixField = (value: unknown): void => {
        if (value === undefined) {
            mixInt(-0x3e3779b9);
            return;
        }

        if (value === null) {
            mixInt(-0x51ed2701);
            return;
        }

        if (typeof value === 'boolean') {
            mixInt(value ? 1 : 0);
            return;
        }

        if (typeof value === 'number') {
            mixNumber(value, mixInt);
            return;
        }

        if (typeof value === 'string') {
            mixText(value);
            return;
        }

        mixAny(value);
    };

    // The safety net for shapes this file does not type out: `pending` snapshots, panel and
    // media summaries, an action card, and anything a future wire value adds inside a step.
    // Generic, and deliberately WITHOUT `JSON.stringify`: the measured payload carries a
    // pending snapshot per running call, and serializing those leaf structures is what made
    // an earlier revision of this file cost 4.17 ms instead of the ~1 ms it now costs
    // (Temp/coding-t23/stamp-bench.ts). A long string inside one of them lands in `mixText`,
    // i.e. a length read plus both ends, which is what keeps a streaming argument cheap.
    function mixAny(value: unknown): void {
        if (value === undefined) {
            mixInt(-0x3e3779b9);
            return;
        }

        if (value === null) {
            mixInt(-0x51ed2701);
            return;
        }

        if (typeof value === 'boolean') {
            mixInt(value ? 1 : 0);
            return;
        }

        if (typeof value === 'number') {
            mixNumber(value, mixInt);
            return;
        }

        if (typeof value === 'string') {
            mixText(value);
            return;
        }

        if (Array.isArray(value)) {
            mixInt(value.length);

            for (const item of value) mixAny(item);

            return;
        }

        if (typeof value !== 'object') {
            mixInt(-0x1234567);
            return;
        }

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);

        mixInt(keys.length);

        for (const key of keys) {
            // Key NAMES are a fixed, tiny vocabulary per shape, so they are digested through
            // the memo (a rename is still seen, and a value that moved under the same name is
            // seen by the value below).
            mixInt(digestOf(key));
            mixAny(record[key]);
        }
    }

    ids.push(`t${display.turnId}[s${display.sections.length}`);
    // The wire counter (see the header): read structurally because `TurnDisplay`
    // (../../shared/turn-display.ts:1149) is the fold model and does not name the field —
    // src/shared is another writer's surface, so the frontend carries it, not the type.
    mixField((display as TurnDisplay & { revision?: number }).revision);
    mixField(display.lastSectionOrdinal);

    for (const section of display.sections as TurnSection[]) {
        ids.push(`s${section.id}`);

        // Identity and measurement figures of one invocation block: every one of these is
        // painted into a header, a label or the token line, and every one can move in place
        // (`section:set`, ../view-state.ts:411-423).
        mixField(section.rank);
        mixField(section.agent);
        mixField(section.agentLabel);
        mixField(section.state);
        mixField(section.parentSectionId);
        mixField(section.model);
        mixField(section.invocationId);
        mixField(section.threadId);
        mixField(section.threadLabel);
        mixField(section.branchId);
        mixField(section.startedAt);
        mixField(section.endedAt);
        mixField(section.latestInput);
        mixField(section.cachedInput);
        mixField(section.answerNodeId);

        // The ONE designated full-text body (../../shared/turn-display.ts:1094): its identity
        // and payload sizes, on the same terms `tailStampOf` uses (../server/turn-projector.ts
        // :1834) — a call that settles changes the bytes the reader sees, prose length alone
        // is deliberately not a reason to repaint here (it is already in the node below).
        const tail = section.tail as DisplayTail | undefined;

        if (tail !== undefined) {
            mixField(tail.kind);
            mixField(tail.nodeId);
            mixField(tail.blockId);
            mixField((tail as { args?: string }).args?.length);
            mixField((tail as { result?: string }).result?.length);
            mixField((tail as { chars?: number }).chars);
            mixField((tail as { truncated?: boolean }).truncated);
        }

        const nodes = section.nodes as DisplayNode[];

        ids.push(`[n${nodes.length}`);

        for (const node of nodes) {
            ids.push(`${node.kind}${node.id}`);

            if (node.kind === 'notice') {
                // A notice line is server-written status prose, short by construction, and
                // `node:set` rewrites it IN PLACE (../view-state.ts:478) — often with the
                // same length ("pending · read 1.2s" -> "...1.8s"), which is why it stays in
                // the verbatim band instead of a length.
                mixField(node.tone);
                mixField(node.text);
                mixField(node.at);
                mixField(node.stepId);
                continue;
            }

            if (node.kind === 'tool' || node.kind === 'action') {
                mixField(node.name);
                mixField(node.state);
                mixField(node.outcome);
                mixField(node.durationMs);
                mixField(node.startedAt);
                mixField(node.endedAt);
                mixField(node.callId);
                // The compact panes the card prints without a click.
                mixField(node.argsPreview);
                mixField(node.preview);
                // The one-click pointer: `hasResult`/`truncated` decide whether the card offers
                // the detail at all (../view-state.ts:538 replaces the whole step object).
                mixField(node.detail?.hasResult);
                mixField(node.detail?.truncated);
                mixField(node.detail?.resultStepId);
                // `pending` is load-bearing and can stream while the count stays the same (a
                // running call's argument bytes accumulate), so its items go through the
                // bounded digest rather than a count.
                mixField(node.pending);
                mixField(node.panels);
                mixField(node.media);
                mixField(node.action);
                continue;
            }

            // `text` and `reasoning`: the streamed prose and thinking windows. Each flag
            // belongs to one of the two kinds (`committed` is a prose/attempt flag, `share` is
            // the think chip's token share), so they are read structurally — the stamp must
            // see whichever one the node carries without narrowing per kind.
            mixField((node as { committed?: boolean }).committed);
            mixField((node as { share?: number }).share);
            // Read structurally for the same reason: `chars` and `redacted` exist on both
            // prose kinds, and `DisplayNode` as a union also carries the step member, which
            // the kind checks above do not remove.
            mixField((node as { chars?: number }).chars);
            // `redacted` travels true / absent / (via `unredacted`) deleted, and the renderer
            // switches between a preview and a whole body on it (../view-state.ts:494/:495).
            mixField((node as { redacted?: true }).redacted);
            mixField((node as { text?: string }).text);
        }

        ids.push(']');

        // The one context bar of this section (../../shared/turn-display.ts:1112). 1100 of
        // these in the measured payload, i.e. the majority of the tree's PROPERTY count, and
        // `context:set` patches its counters and the reader's inclusion verdict in place
        // (../view-state.ts:637-668) — which is exactly why a stamp has to read them.
        const blocks = (section.context as ContextBlock[] | undefined) ?? [];

        ids.push(`[c${blocks.length}`);

        for (const block of blocks) {
            ids.push(`b${block.id}`);
            mixField(block.kind);
            mixField(block.name);
            mixField(block.state);
            mixField(block.chars);
            mixField(block.argsChars);
            mixField(block.resultChars);
            mixField(block.inPrompt);
            mixField(block.included);
            mixField(block.at);
            mixField(block.endedAt);
            mixField(block.eventFrom);
            mixField(block.eventTo);
            // Read structurally: the patcher writes it before the shared type names it
            // (../view-state.ts:665).
            mixField((block as ContextBlock & { durationMs?: number }).durationMs);
        }

        ids.push(']');
    }

    ids.push(']');

    return `${ids.join('')}|${h1.toString(36)}${h2.toString(36)}`;
};
