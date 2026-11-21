// Error type shared by the harness and its plugins.
//
// One class is enough while the surface is small: callers either catch it for
// the message or let it fail the process. `cause` is preserved so a transport
// failure keeps its original fetch/parse error for debugging.
//
// MACHINE CODES (records-engine Decision O / F17). A rejection that a caller must
// *act* on carries a stable code. `code` is the machine name and `name` is set to
// the same value, following the `nested-runs.ts` precedent (`error.name =
// NESTED_RUN_LIMITATION_CODE`): "so the model, the HTTP surface, the worker report
// and the operator all quote ONE identifiable name", and "a host that catches it
// can classify without parsing prose". Prose is the human half; a wrapper switches
// on the code and re-words the message (it never swallows the rejection). The code
// is ALSO the first token of the message, because `harness.ts` renders a thrown
// error as `Tool "<name>" failed: <message>` and only the message reaches the
// model, an event consumer or a worker report.

export class HarnessError extends Error {
    // Stable machine name of the rejection class (e.g. `stale-record`). Absent for
    // the plain "this call is malformed" errors that have always existed.
    readonly code?: string;
    // Structured payload for the caller that has to recover (e.g. R9's current
    // entry on a stale write). Optional, and never a substitute for the message.
    readonly details?: unknown;

    constructor(
        message: string,
        options?: { cause?: unknown; code?: string; details?: unknown }
    ) {
        super(message);
        this.name = options?.code ?? 'HarnessError';

        if (options?.code !== undefined) this.code = options.code;
        if (options?.details !== undefined) this.details = options.details;

        // `ErrorOptions` needs lib es2022.error, which this package does not
        // pull in. Assign the cause directly instead of widening the lib just
        // for one field.
        if (options?.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }
}

// Total classifier for a coded rejection (records-engine Decision O): a wrapper
// must be able to switch on the code of an engine error it caught WITHOUT becoming
// a new crash path, and a thrown value may be hostile (see `isInstanceOf` above).
// Returns `undefined` when the thrown value carries no code, so the caller falls
// back to the message exactly as before.
export const errorCodeOf = (error: unknown): string | undefined => {
    try {
        if (!isInstanceOf(error, HarnessError)) return undefined;

        const code = error.code;

        return typeof code === 'string' && code.length > 0 ? code : undefined;
    } catch {
        // Reporting an error must never throw another one.
        return undefined;
    }
};

// The one fallback message. Kept stable because it is a wire value on an error
// event, not an internal diagnostic.
const UNKNOWN_ERROR_MESSAGE = 'Unknown harness error';

// `instanceof` is NOT a total operation: a thrown Proxy with a throwing
// `getPrototypeOf` trap can make it throw. Classification catches on the error
// path must never fail, so every `instanceof` on an unknown thrown value goes
// through this guard. Returns false when the value cannot be classified.
export const isInstanceOf = <T>(
    error: unknown,
    constructor: new (...args: any[]) => T
): error is T => {
    try {
        return error instanceof constructor;
    } catch {
        return false;
    }
};

// Read an Error's message without trusting it. A host can throw an object whose
// `message` accessor (or a revoked proxy's `instanceof` trap) throws; the error
// reporter must never turn one bad thrown value into a second uncaught failure.
const messageOf = (error: Error): string => {
    const message = error.message;
    // An Error with no message is still identifiable by its name; an empty
    // "Tool ... failed: " tells the model nothing actionable.
    return typeof message === 'string' && message.length > 0 ? message : error.name;
};

// Narrow an unknown thrown value into the event-shaped error payload. Events are
// consumed by CLIs and (later) RPC clients, so they carry data, not exceptions.
//
// COMPILED TOOL SAFETY: a runtime-compiled module is arbitrary JavaScript and may
// `throw` a primitive, a symbol, a plain object, or a proxy with hostile traps.
// The old implementation answered "Unknown harness error" for every non-Error,
// which hid the failure from the model. This formatter is deliberately total:
// every branch is guarded, so a catch handler that calls it cannot itself throw.
export const toErrorInfo = (error: unknown): { message: string; code?: string } => {
    // Decision O: the code travels beside the message so an RPC/CLI consumer can
    // branch without parsing prose. Read through `errorCodeOf` (total), and only
    // added when present, so every pre-existing `{ message }` payload is unchanged.
    const code = errorCodeOf(error);
    const withCode = (message: string): { message: string; code?: string } =>
        code === undefined ? { message } : { message, code };

    try {
        if (error instanceof Error) {
            return withCode(messageOf(error));
        }

        if (typeof error === 'string') {
            return { message: error };
        }

        // Primitives are cheap and exact: `throw 42` becomes "42".
        if (
            typeof error === 'number' ||
            typeof error === 'boolean' ||
            typeof error === 'bigint' ||
            typeof error === 'symbol'
        ) {
            return { message: String(error) };
        }

        // A thrown plain object commonly carries `{ message }` or structured
        // details. Prefer a real message, then fall back to its JSON shape so the
        // caller sees WHAT failed rather than a generic sentence. JSON.stringify
        // may invoke a hostile toJSON or hit a cycle/BigInt; the guard below turns
        // that into the stable fallback instead of escaping this function.
        if (typeof error === 'object' && error !== null) {
            const message = (error as { message?: unknown }).message;
            if (typeof message === 'string' && message.length > 0) return { message };

            const serialized = JSON.stringify(error);
            if (typeof serialized === 'string' && serialized.length > 0) {
                return { message: serialized };
            }
        }
    } catch {
        // Deliberately empty: reporting an error must never throw another one.
        // The fallback below is the honest answer when the value cannot be read.
    }

    return { message: UNKNOWN_ERROR_MESSAGE };
};
