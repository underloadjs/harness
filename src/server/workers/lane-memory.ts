// Shared harness memory across lanes: faithful transfer, explicit capability, and
// compare-and-set against the AUTHORITY's value - never a lost sibling update.
//
// WHY JSON WAS WRONG HERE (T3 finding F4)
// ---------------------------------------
// `HarnessMemory` accepts ANY JS value (types/index.ts ~729). The first design
// normalised memory with `JSON.parse(JSON.stringify(...))`, and the reviewer's probe
// showed what that does to a real session:
//
//   - a function-valued key DISAPPEARED from the projection, so the
//     "cannot transfer" fault could never fire;
//   - a `Date` came back as an ISO STRING and a `Set` came back as `{}` - shapes the
//     tool then read back wrong;
//   - a cyclic value (structured-cloneable, legal in memory) THREW `TypeError` inside
//     the state-change observer, and harness.ts SWALLOWS observer exceptions, so the
//     loss was invisible;
//   - `BigInt` threw `Do not know how to serialize a BigInt`;
//   - and because a `sync` advanced the replica's BASE without writing its live map,
//     the lane's next projection saw a sibling key as REMOVED and deleted it.
//
// THE RULES THIS MODULE ENFORCES
// ------------------------------
//   1. transfer uses `structuredClone` - faithful for Date / Set / Map / BigInt /
//      typed arrays / cycles - and a value that cannot be cloned is reported as
//      UNSUPPORTED naming the key: never dropped, never coerced;
//   2. digests come from a cycle-safe, tag-distinguishing serializer, so a `Date` and
//      its ISO string never share a digest, and a cycle never throws;
//   3. a lane only ever commits keys it DECLARED. An undeclared key is invisible to
//      it, so it cannot be deleted by it - which is what lost the sibling update;
//   4. every write carries the digest of the value the lane READ. The authority
//      compares it with the canonical value and refuses a mismatch, so the first
//      writer wins by receipt instead of the last message winning by arrival;
//   5. nothing here throws on hostile input. Every entry point returns a result the
//      caller turns into a receipt or a capability error, because a swallowed
//      observer exception is exactly how F4 became invisible.
//
// Cross-references:
//   - ./lane-commit.ts  - the `memory:set` / `memory:delete` compare-and-set ops
//   - ./capability.ts   - `assessWorkerToolSurface` (dynamic keys => whole map, or reject)
//   - ../../harness.ts ~1150 - the live memory map this module mirrors
//   - ../../types/index.ts ~729 - HarnessMemory (arbitrary values, never snapshotted)

// The digest marker for "this key did not exist when the lane read it". A write that
// expects ABSENT and finds any value is refused, so two lanes minting the same key
// cannot both believe they created it.
export const ABSENT_DIGEST = '@absent';

// A present key whose stored value IS `undefined` digests to ABSENT_DIGEST too. That
// is deliberate: `has()` and a read both behave like "no value", and the CAS rule is
// about the value a tool observed, not about property bookkeeping.
export type MemoryValueSupport = {
    transferable: boolean;
    // 'structured-cloneable' | 'function' | 'symbol' | 'clone-rejected'
    kind: string;
    reason?: string;
};

// Classify one memory value WITHOUT throwing. `structuredClone` is the authority on
// what may cross the boundary: it keeps Date / Set / Map / BigInt / cycles faithful
// and rejects functions and symbols, which is exactly the split a tool needs to know.
export const classifyMemoryValue = (value: unknown): MemoryValueSupport => {
    if (typeof value === 'function') {
        return { transferable: false, kind: 'function', reason: 'a function is local to one thread' };
    }

    if (typeof value === 'symbol') {
        return { transferable: false, kind: 'symbol', reason: 'a symbol has no transferred identity' };
    }

    try {
        structuredClone(value);

        return { transferable: true, kind: 'structured-cloneable' };
    } catch (error) {
        return {
            transferable: false,
            kind: 'clone-rejected',
            reason: error instanceof Error ? error.message : String(error)
        };
    }
};

// Cycle-safe, tag-distinguishing canonical serialization - the digest input. Two
// values share a digest only when they are the same shape AND the same content, so a
// Date never matches its ISO string, and a Set never matches an object.
export const serializeMemoryValue = (value: unknown): string => {
    const active = new Set<object>();

    const walk = (input: unknown): string => {
        if (input === null) return 'null';
        if (input === undefined) return 'undef';

        switch (typeof input) {
            case 'string':
                return `s:${JSON.stringify(input)}`;
            case 'number':
                // -0 and 0 are different bits, and NaN has no JSON form at all.
                if (Number.isNaN(input)) return 'n:NaN';
                if (Object.is(input, -0)) return 'n:-0';

                return `n:${input}`;
            case 'bigint':
                return `b:${input}n`;
            case 'boolean':
                return `t:${input}`;
            case 'symbol':
                return `y:${String(input)}`;
            case 'function':
                return `f:${input.name || 'anonymous'}`;
            default:
                break;
        }

        if (typeof input !== 'object') return `u:${typeof input}`;

        const object = input as object;

        if (active.has(object)) return 'r:<cycle>';

        active.add(object);

        try {
            if (Array.isArray(object)) return `a:[${object.map(walk).join(',')}]`;
            if (input instanceof Date) return `d:${input.getTime()}`;
            if (input instanceof RegExp) return `g:${input.source}/${input.flags}`;
            if (input instanceof Error) return `e:${input.name}:${input.message}`;

            if (input instanceof Map) {
                const entries = [...(input as Map<unknown, unknown>)].map(([key, value]) => `${walk(key)}=>${walk(value)}`);
                entries.sort();

                return `m:{${entries.join(',')}}`;
            }

            if (input instanceof Set) {
                const members = [...(input as Set<unknown>)].map(walk);
                members.sort();

                return `q:{${members.join(',')}}`;
            }

            if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
                const bytes =
                    input instanceof ArrayBuffer
                        ? new Uint8Array(input)
                        : new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength);
                let rolling = 0;

                for (const byte of bytes) rolling = (rolling * 31 + byte) % 1_000_000_007;

                return `v:${bytes.byteLength}:${rolling}`;
            }

            const record = input as Record<string, unknown>;
            const keys = Object.keys(record).sort();

            return `o:{${keys.map((name) => `${JSON.stringify(name)}:${walk(record[name])}`).join(',')}}`;
        } finally {
            active.delete(object);
        }
    };

    return walk(value);
};

// Two independent 32-bit FNV-1a lanes over the canonical text, plus its length: a
// 64-bit digest with a length guard. The reviewer's objection was a single 32-bit
// lane over LOSSY JSON; the input here is faithful, and a length change alone already
// breaks a collision.
export const digestMemoryValue = (value: unknown): string => {
    if (value === undefined) return ABSENT_DIGEST;

    const text = serializeMemoryValue(value);
    let laneA = 0x811c9dc5;
    let laneB = 0x01000193;

    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        laneA = Math.imul(laneA ^ code, 0x01000193) >>> 0;
        laneB = Math.imul(laneB + code + 0x9e3779b9, 0x85ebca6b) >>> 0;
    }

    return `${laneA.toString(16).padStart(8, '0')}${laneB.toString(16).padStart(8, '0')}:${text.length}`;
};

export type MemoryWindowEntry = {
    key: string;
    // The faithful clone the lane works on. `present: false` means the key did not
    // exist; `transferable: false` means the authority holds something this lane
    // cannot receive, and the tool call that touches it must fail naming the key.
    present: boolean;
    value: unknown;
    digest: string;
    transferable: boolean;
    reason?: string;
};

export type MemoryWindow = {
    laneEpoch: number;
    entries: MemoryWindowEntry[];
    // Keys the authority holds that this lane never declared. Reported, never sent:
    // a lane may not write what it was not given (rule 3 above).
    undeclared: string[];
};

// Ship the declared keys to a lane (or fold a lane's window back into the authority).
// Cloning is per-key and NEVER throws: an un-transferable value is reported with its
// reason so the caller can fail that one tool call explicitly.
export const captureMemoryWindow = (
    memory: Record<string, unknown>,
    declaredKeys: readonly string[],
    laneEpoch: number
): MemoryWindow => {
    const declared = new Set(declaredKeys);
    const entries: MemoryWindowEntry[] = [];

    for (const key of declared) {
        const present = Object.prototype.hasOwnProperty.call(memory, key);

        if (!present) {
            entries.push({ key, present: false, value: undefined, digest: ABSENT_DIGEST, transferable: true });
            continue;
        }

        const support = classifyMemoryValue(memory[key]);

        if (!support.transferable) {
            entries.push({
                key,
                present: true,
                value: undefined,
                digest: 'untransferable',
                transferable: false,
                reason: support.reason
            });
            continue;
        }

        entries.push({
            key,
            present: true,
            value: structuredClone(memory[key]),
            digest: digestMemoryValue(memory[key]),
            transferable: true
        });
    }

    return { laneEpoch, entries, undeclared: Object.keys(memory).filter((key) => !declared.has(key)) };
};

// The digests a lane must present when it commits this window back.
export const digestsOfWindow = (window: MemoryWindow): Record<string, string> =>
    Object.fromEntries(window.entries.map((entry) => [entry.key, entry.digest]));

// Clone a window into the shape a worker stores as its live map. The worker writes
// THROUGH this object, so a sibling key that arrives later must be written into the
// SAME map the tools read - the mistake that produced F4's lost delete.
export const memoryMapFromWindow = (window: MemoryWindow): Record<string, unknown> => {
    const map: Record<string, unknown> = {};

    for (const entry of window.entries) {
        if (entry.present && entry.transferable) map[entry.key] = structuredClone(entry.value);
    }

    return map;
};

// Replace the declared keys of a live worker map with an authoritative window,
// returning the per-key result so the caller can advance its diff base ONLY for keys
// that actually moved (F7: never advance on state nobody accepted).
export const syncMemoryMap = (
    live: Record<string, unknown>,
    window: MemoryWindow
): { key: string; status: 'set' | 'deleted' | 'untransferable' }[] =>
    window.entries.map((entry) => {
        if (!entry.transferable) return { key: entry.key, status: 'untransferable' };

        if (!entry.present) {
            delete live[entry.key];

            return { key: entry.key, status: 'deleted' };
        }

        live[entry.key] = structuredClone(entry.value);

        return { key: entry.key, status: 'set' };
    });

export type MemoryWriteOutcome = {
    key: string;
    applied: boolean;
    // 'applied' | 'deleted' | 'stale' | 'untransferable' | 'undeclared'
    status: string;
    // The canonical digest AFTER this call, so the lane re-bases its expectation on
    // the authority's value rather than its own guess.
    digest: string;
    reason?: string;
};

// Apply one lane write to the AUTHORITY map under compare-and-set.
//
// `expected` is the digest the lane read. A mismatch means another writer (a sibling
// lane or an operator edit) moved the key first: the write is refused and the caller
// gets the canonical digest back, so the lane re-reads instead of guessing.
//
// `declared: false` refuses a write to a key this lane was never given, which is the
// rule that keeps a lane from deleting a sibling's bookkeeping key.
export const applyMemoryWrite = (
    memory: Record<string, unknown>,
    write: { key: string; expected: string; value?: unknown; remove?: boolean; declared?: boolean }
): MemoryWriteOutcome => {
    const present = Object.prototype.hasOwnProperty.call(memory, write.key);
    const current = present ? digestMemoryValue(memory[write.key]) : ABSENT_DIGEST;

    if (write.declared === false) {
        return { key: write.key, applied: false, status: 'undeclared', digest: current, reason: 'this lane never read the key' };
    }

    if (current !== write.expected) {
        return { key: write.key, applied: false, status: 'stale', digest: current };
    }

    if (write.remove) {
        delete memory[write.key];

        return { key: write.key, applied: true, status: 'deleted', digest: ABSENT_DIGEST };
    }

    const support = classifyMemoryValue(write.value);

    if (!support.transferable) {
        return {
            key: write.key,
            applied: false,
            status: 'untransferable',
            digest: current,
            reason: `harness.memory[${JSON.stringify(write.key)}] holds a ${support.kind} (${support.reason ?? 'it cannot be transferred'}); use a cloneable value or run this session with threadExecution "inline".`
        };
    }

    memory[write.key] = structuredClone(write.value);

    return { key: write.key, applied: true, status: 'applied', digest: digestMemoryValue(memory[write.key]) };
};

// Fold a whole window into the authority (a lane's write-set at a commit boundary).
// Each key is CAS-checked on its own, and the per-key outcomes come back so the
// caller can build a receipt naming exactly what was refused.
export const applyMemoryWindow = (
    memory: Record<string, unknown>,
    window: MemoryWindow,
    readDigests: Record<string, string> = digestsOfWindow(window)
): MemoryWriteOutcome[] =>
    window.entries.map((entry) =>
        applyMemoryWrite(memory, {
            key: entry.key,
            expected: readDigests[entry.key] ?? entry.digest,
            ...(entry.present && entry.transferable ? { value: entry.value } : entry.value === undefined ? { remove: true } : { value: entry.value })
        })
    );

// ---------------------------------------------------------------------------
// Static capability scan
// ---------------------------------------------------------------------------

export type MemoryAccess = {
    // Literally-named keys the tool reads or writes. These become the lane's bounded
    // window; nothing else is reachable by it.
    keys: string[];
    // True when the tool reaches the map structurally (`memory.data`, `memory.keys()`,
    // `memory.clear()`, a computed or interpolated key), i.e. its read-set cannot be
    // bounded. Such a tool needs the whole map or is unsupported in worker mode.
    dynamic: boolean;
};

const LITERAL_ACCESS = /\.memory\s*\.\s*(?:get|set|has|delete)\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
const STRUCTURAL_ACCESS = /\.memory\s*\.\s*(?:data|keys|clear)\b/;
const COMPUTED_ACCESS = /\.memory\s*\[/;

// Which memory keys does this tool module touch, and does it touch them DYNAMICALLY?
//
// Deliberately a SOURCE scan, not a runtime interception: `harness.memory` is a live
// object a synchronous tool body reads at will, so the only honest moment to decide
// is before the run. A scanned literal is a promise about the source, and the CAS
// rules above make an unexpected value a refused write rather than a lost update.
export const assessMemoryAccess = (source: string): MemoryAccess => {
    const keys = new Set<string>();
    let dynamic = false;

    let match: RegExpExecArray | null;

    while ((match = LITERAL_ACCESS.exec(source)) !== null) {
        // An interpolated key is dynamic even though it looks literal.
        if (match[2].includes('${')) {
            dynamic = true;
            continue;
        }

        keys.add(match[2]);
    }

    // Reset the stateful global regex for the next caller.
    LITERAL_ACCESS.lastIndex = 0;

    if (STRUCTURAL_ACCESS.test(source)) dynamic = true;
    if (COMPUTED_ACCESS.test(source)) dynamic = true;
    // A backtick key with an expression inside it (`k${n}`) is computed too.
    if (/\.memory\s*\.\s*(?:get|set|has|delete)\s*\(\s*`[^`]*\$\{/.test(source)) dynamic = true;

    return { keys: [...keys].sort(), dynamic };
};
