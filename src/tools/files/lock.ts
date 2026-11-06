// @underload/harness tools/files/lock — one async mutex per REAL FILE, for the write side.
//
// WHY THIS EXISTS (D4: the lost-update race)
// ------------------------------------------
// `edit` reads a file, matches, and writes it back. Those are three separate awaits,
// so two calls that overlap in time both read the SAME original text, both find their
// oldString, both report `replacements: 1`, and the last write silently wins. Measured
// before this module existed: one file holding `VERSION-0`, three concurrent edits
// (`->A`, `->B`, `->C`) all succeeded and the file ended at `VERSION-C` — an answer no
// caller asked for and no caller was told about. `write` has the same exposure against
// a concurrent `edit` on the same path.
//
// The fix is to make "read, match, write" ONE critical section per file. A later call
// then sees the earlier call's text, so a stale `oldString` fails honestly
// ("edit found no match") instead of clobbering a change it never saw. This is exactly
// what a version guard would buy, without asking the model to carry a token it cannot
// copy correctly.
//
// WHY A MUTEX AND NOT AN mtime/hash CHECK
// ---------------------------------------
// A compare-and-swap would still leave a window between the check and the write, and it
// would push a retry loop onto the caller. Serializing per file closes the window
// outright, costs nothing when there is no contention (the common case: the map entry is
// created and dropped in the same tick), and keeps the tool's contract unchanged.
//
// WHY KEYED BY FILE IDENTITY, NOT BY PATH
// ---------------------------------------
// The whole point is to stop two SPELLINGS of one file from writing over each other, so
// the key must be the caller's canonical identity (./identity.ts: realpath, case-folded
// on win32). `a.txt` and `A.TXT` on NTFS share one lock, which is correct because they
// are one file.
//
// WHY A BATCH SORTS ITS LOCKS
// ---------------------------
// A multi-file call takes every lock it needs BEFORE writing, in one order — sorted by
// identity — and releases them in reverse. Two batches that touch overlapping files
// therefore never hold the locks the other one waits for, which is the only way a cycle
// could form. Locks are taken one at a time (each `await`ed) rather than all at once so
// a caller that arrives mid-acquisition queues behind a defined order instead of racing
// the loop.
//
// WHAT THIS IS NOT
// ----------------
// It is a per-PROCESS lock over one event loop. It cannot order writes from another
// process, another worker thread, or an editor outside the harness — nothing in this
// package can, and the tools never claimed to. It also does not make a multi-file batch
// transactional: a write that fails part-way still leaves earlier files changed
// (./write.tool.ts, ./edit.tool.ts say so).
//
// A hung tool body holds its locks until it settles, so a call that never returns would
// block later calls on the same files. That is the honest trade: the alternative is the
// silent clobber this module exists to remove, and `edit`/`write` bodies are bounded
// synchronous file work with no external dependency to hang on.

type Release = () => void;

type Chain = {
    // The promise the NEXT caller waits on: it settles when the current holder releases.
    tail: Promise<void>;
    // Callers inside the lock or queued behind it. When this reaches 0 nobody can be
    // waiting, so the map entry is dropped and the key set never grows with the number of
    // files the process has ever touched.
    waiting: number;
};

const chains = new Map<string, Chain>();

// Wait for this file, then run `run` while no other caller in this process holds it.
// Resolves (or rejects) with `run`'s outcome; the lock is released either way.
export const withFileLock = async <T>(identity: string, run: () => Promise<T>): Promise<T> => {
    const release = await acquireFileLock(identity);

    try {
        return await run();
    } finally {
        release();
    }
};

// Take every lock in `identities` (deduplicated, sorted), run, then release in reverse.
// The sort is what makes concurrent multi-file batches deadlock-free.
export const withFileLocks = async <T>(identities: readonly string[], run: () => Promise<T>): Promise<T> => {
    const ordered = [...new Set(identities)].sort();
    const held: Release[] = [];

    try {
        for (const identity of ordered) held.push(await acquireFileLock(identity));
        return await run();
    } finally {
        for (const release of held.reverse()) release();
    }
};

// Resolve with this file's release function once it is our turn.
const acquireFileLock = async (identity: string): Promise<Release> => {
    let chain = chains.get(identity);

    if (chain === undefined) {
        chain = { tail: Promise.resolve(), waiting: 0 };
        chains.set(identity, chain);
    }

    // `waiting` is incremented SYNCHRONOUSLY, before the await below, so a holder that
    // finishes and decrements can never mistake a queued caller for "nobody left" and
    // delete the chain out from under it.
    chain.waiting += 1;

    const held = chain.tail;
    let release!: Release;
    const mine = new Promise<void>((resolve) => {
        release = resolve;
    });

    // Our turn begins when the previous holder settles, and the chain itself NEVER
    // rejects: a neighbour's failure must not poison the queue behind it, and an
    // unobserved rejection would surface as an unhandled-rejection warning.
    chain.tail = held.then(() => mine, () => mine);

    await held;

    let released = false;

    return () => {
        // Idempotent: the release runs from a `finally`, and a caller must be able to
        // call it twice without handing the lock to two holders at once.
        if (released) return;
        released = true;
        release();

        chain!.waiting -= 1;

        // Drop the entry only while we are still the tail AND nobody is queued, so a
        // later caller starts a fresh chain rather than joining a stale one.
        if (chain!.waiting === 0 && chains.get(identity) === chain) chains.delete(identity);
    };
};

// How many files currently hold or queue a lock. Exported for the leak assertion in
// ./lock.test.ts: a completed batch must leave this at zero.
export const fileLockCount = (): number => chains.size;
