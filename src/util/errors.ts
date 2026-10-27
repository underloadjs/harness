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

// Narrow an unknown thrown value into the event-shaped error payload. Events are
// consumed by CLIs and (later) RPC clients, so they carry data, not exceptions.
export const toErrorInfo = (error: unknown): { message: string } => {
    if (error instanceof Error) {
        return { message: error.message };
    }

    if (typeof error === 'string') {
        return { message: error };
    }

    return { message: 'Unknown harness error' };
};
