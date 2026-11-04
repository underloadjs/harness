// T13: one tiny module owning the HTTP error type the dispatcher and every helper throw.
//
// It lives apart from ./api.ts so the read/paging/projection helpers can throw a real
// status without importing the dispatcher back (a cycle across five modules would make
// load order matter for no reason). ./api.ts re-exports `HttpError` verbatim because
// ./handler.ts and ./index.ts already import it from there.
//
// Cross-references: ./api.ts (maps it to `{ kind: 'json', status, body: { error } }`).

/** An error with an HTTP status. The dispatcher maps it to the contract's error envelope. */
export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

/** 403 with the capability that is off, so a refusal states WHY rather than just "no". */
export const capabilityDenied = (capability: string, operation: string): HttpError =>
    new HttpError(403, `${operation} is not available: this deployment does not support ${capability}.`);
