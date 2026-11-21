// @underload/harness tools/files/cancellation — the ONE way the four filesystem tools
// (`read`, `write`, `edit`, `files`) answer a cancelled call.
//
// WHY THIS IS A SEPARATE MODULE (and why it is NOT named `*.tool.ts`)
// -------------------------------------------------------------------
// Cancellation is one decision with four call sites. Before this module, `read` rejected
// with whatever the host's `AbortSignal` carried (measured: a DOMException whose `name` is
// `AbortError` and whose `code` is the NUMBER 20 — not a string errno, and not a member of
// any published set), while `write`, `edit` and `files` did not read `context.signal` at
// all, so a cancelled call simply performed its side effects and reported success. A
// mapping forked per tool is how the four codes drift apart; one module keeps the code,
// the `rawCode` rule, and the `cause` rule identical everywhere.
//
// The file deliberately does not end in `.tool.ts`: ../../core/tool-discovery.ts and
// ../../../scripts/generate-tool-manifest.ts AST-scan `*.tool.ts` for `metadata` and
// `registration` literals, so a helper with that suffix would be read as a new tool.
// Same convention as ./identity.ts, ./lock.ts, ./search.ts, ./gitignore.ts,
// ./bounded-regex.ts and ./atomic-publish.ts.
//
// WHY `ECANCELED` — AND WHY IT IS A CALL-LEVEL CODE
// -------------------------------------------------
// `src/types/index.ts:2349-2364` is the harness cancellation contract: the `signal` a tool
// receives is the PER-CALL controller of the run that invoked it, a tool SHOULD observe it,
// and "the harness releases a cancelled call logically even if the implementation ignores
// the signal; a late result is discarded". So a cancelled call has no consumer for a
// RESULT — which is exactly why the answer has to travel as an error, not as data.
//
// `src/harness.ts` then decides what the caller finally sees. `RunState.abortError` and
// `throwIfAborted` (harness.ts:5303-5315, 7804-7816) say it outright: "A tool that observed
// the abort and threw supplies a more specific error, which is the historical contract", and
// the scheduler records the tool's own rejection (harness.ts:8382-8384) instead of the
// generic AbortError. That IS the existing repo convention for cancellation: the tool
// explains its own cancellation, and the harness prefers that explanation. This module makes
// the explanation CODED rather than a platform exception, which is what `src/util/errors.ts`
// demands of any rejection a caller must act on ("a host that catches it can classify
// without parsing prose").
//
// Why `ECANCELED` and not a code that was already published:
//   - `EIO` is the harness's TRANSIENT code — the fold every unknown errno lands on, and the
//     one the descriptions tell a model to retry. A cancelled call is permanent by
//     construction (the caller is gone), so answering EIO invites a retry loop, and
//     `read.test.ts`'s cancellation pin already refuses that fold by name;
//   - `ETIMEDOUT` / `EAGAIN` both mean "ask again", which is a deadline/stream, not a
//     cancellation;
//   - `EBINARY`, `EACCES`, `EISDIR` … blame a FILE for what the caller did.
// `ECANCELED` is the POSIX name for exactly this condition ("operation canceled"), it
// implies neither retryability nor corruption, and it is a member of every published set
// this wave already exposes: `FILE_PUBLISH_ERROR_CODES` (hence `FILE_WRITE_ERROR_CODES` and
// `FILE_EDIT_ERROR_CODES`, which spread it), `FILES_ERROR_CODES`, and `FILE_READ_ERROR_CODES`.
//
// THE CHANNEL IS THE CALL, NOT THE ENTRY, FOR ALL FOUR TOOLS. Cancellation is not a fact
// about one path: `read` already documents that split (its per-file `ETIMEDOUT` stays one
// entry, its cancellation rejects the call — knowledge.md and `read.test.ts` "rejects the
// whole call when the harness cancels it … (H2)"), and `write`/`edit`/`files` already reject
// the call for every other call-level failure with `code` + structured `details`. So a host
// that aborts any of the four sees the same thing: one `HarnessError` whose `code` is
// `ECANCELED`, whose `details` name where work stopped and what had already landed, and
// whose `cause` is the reason the host itself passed to `abort()`.
//
// `rawCode` keeps its published meaning (same rule as ./read.tool.ts, ./files.tool.ts and
// ./atomic-publish.ts): present ONLY when it differs from `code`. For a cancellation it
// always does — the signal's own reason name (`AbortError`, or whatever a host aborted with)
// against the published `ECANCELED` — so nothing about the host's reason is lost.

import { HarnessError, isInstanceOf } from '../../util';

// The single published cancellation code for the four filesystem tools. Exported so a test,
// a wrapper, or a host adapter can name it instead of quoting a literal.
export const FILE_CANCELLATION_CODE = 'ECANCELED' as const;

// The published set as a one-member value, so a doc or a test can enumerate the same name
// the union carries rather than re-pasting the string.
export const FILE_CANCELLATION_CODES = [FILE_CANCELLATION_CODE] as const;

// The `rawCode` half of a cancellation: the NAME of whatever the signal carried.
//
// `AbortController.abort()` with no argument gives the platform DOMException named
// `AbortError`; `abort('nope')` gives a string; `abort(new Error('x'))` gives an Error whose
// `name` is `Error`; and the harness's own `abortErrorOf` (src/harness.ts:7818) forwards the
// run's reason, which may be anything the host chose. Every one of those is total here, and
// the fallback is the platform name, because "the caller aborted" is the fact.
export const cancellationRawCodeOf = (reason: unknown): string => {
    if (typeof reason === 'string' && reason.length > 0) return reason;

    if (typeof reason === 'object' && reason !== null) {
        const name = (reason as { name?: unknown }).name;

        if (typeof name === 'string' && name.length > 0) return name;
    }

    return 'AbortError';
};

// True only for the cancellation error this module raises.
//
// `read` needs it because its scanner turns ANY `HarnessError` into that entry's `EBINARY`
// (the binary rejection is the only thing that file throws one for) — a coded cancellation
// that reached that branch would be reported as "this file is binary", the most misleading
// fold available. Every scan site therefore checks this predicate FIRST.
//
// `isInstanceOf` rather than a bare `instanceof`: a thrown Proxy with a throwing
// `getPrototypeOf` trap must not turn a cancellation report into a second failure
// (src/util/errors.ts, "instanceof is NOT a total operation").
export const isFileCancellation = (error: unknown): boolean =>
    isInstanceOf(error, HarnessError) && error.code === FILE_CANCELLATION_CODE;

// The cancellation every filesystem tool throws.
//
// `label` is the tool's wire name so the sentence names the tool the caller called (same
// rule as ./atomic-publish.ts). `stage` says what had NOT happened yet — `before publishing
// "x"`, `before any file was written`, `on "x"` — and is omitted when the tool cannot say
// which target it stopped at.
//
// `reason` becomes the `cause`, so a host that aborted with its own object still gets that
// object back after the harness re-throws this error (src/harness.ts prefers a tool's own
// abort error over the generic reason, and `cause` is what keeps the host's identity in it).
// `details` is merged AFTER `rawCode`, so a call site can add its own facts (the completed
// paths) without being able to overwrite the raw reason away.
export const fileCancelledError = (
    label: string,
    stage?: string,
    options: { reason?: unknown; details?: Record<string, unknown> } = {}
): HarnessError => {
    const { reason, details } = options;
    const stopped = stage === undefined || stage.length === 0 ? '' : ` ${stage}`;

    return new HarnessError(
        `${label} was cancelled (${FILE_CANCELLATION_CODE})${stopped}: the caller's abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended.`,
        {
            code: FILE_CANCELLATION_CODE,
            ...(reason === undefined ? {} : { cause: reason }),
            details: {
                rawCode: cancellationRawCodeOf(reason),
                ...(details ?? {})
            }
        }
    );
};

// The guard every call site uses. Checked SYNCHRONICALLY and before the operation, like
// `read`'s expired-deadline check (./read.tool.ts's `bounded`): an already-cancelled call
// must not start a syscall whose result nobody will read.
export const throwIfFileCancelled = (
    label: string,
    signal: AbortSignal | undefined,
    stage?: string,
    details?: Record<string, unknown>
): void => {
    if (signal?.aborted !== true) return;

    throw fileCancelledError(label, stage, { reason: signal.reason, details });
};
