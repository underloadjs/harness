// Error type shared by the harness and its plugins.
//
// One class is enough while the surface is small: callers either catch it for
// the message or let it fail the process. `cause` is preserved so a transport
// failure keeps its original fetch/parse error for debugging.

export class HarnessError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'HarnessError';

        // `ErrorOptions` needs lib es2022.error, which this package does not
        // pull in. Assign the cause directly instead of widening the lib just
        // for one field.
        if (options?.cause !== undefined) {
            (this as { cause?: unknown }).cause = options.cause;
        }
    }
}

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
export const toErrorInfo = (error: unknown): { message: string } => {
    try {
        if (error instanceof Error) {
            return { message: messageOf(error) };
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
