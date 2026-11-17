// Provider-target diagnosis (T9): the exact strings the UI now prints.
//
// Everything here is a PURE formatter (./provider-diagnostics.ts) — no DOM, no fetch — so
// the assertions are the literal text the reader sees. The three questions the module
// answers are the three the user could not answer while a thread was stuck:
//   1. which provider is this conversation dialling (AC1),
//   2. what is the retry ladder doing about it (AC2),
//   3. what did the provider actually fail with (AC3),
// plus the optional `providerTimeouts` config field (AC4), whose contract is ABSENCE.
//
// The honesty rule AC2/AC3 share: a `retry`/`error` frame with NO provider diagnostics
// must yield `undefined`, so the caller keeps the wording it has always used. Those cases
// are pinned here as loudly as the classified ones, because a fabricated port is the bug.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts src/frontend/provider-diagnostics.test.ts

import {
    providerFailureOf,
    providerHostOf,
    providerRetryNote,
    providerTargetNote,
    providerTimeoutsNote,
    providerTimeoutsOf
} from './provider-diagnostics';

// The stuck run, verbatim from the recorded event log: eleven attempts against a provider
// that is not listening, 32s apart, while the UI said nothing but `fetch failed`.
const STUCK_URL = 'http://localhost:5500/providers/private/v1';

describe('the effective provider target (AC1)', () => {
    it('names host:port from the session endpoint, explicit port included', () => {
        expect(providerHostOf(STUCK_URL)).toBe('localhost:5500');
        expect(providerHostOf('http://127.0.0.1:6660/providers/private/v1')).toBe('127.0.0.1:6660');
    });

    it('fills the scheme default for a URL that parses but states no port', () => {
        // A fact of the scheme, not a guess: an https authority IS port 443.
        expect(providerHostOf('https://api.example.com/v1')).toBe('api.example.com:443');
        expect(providerHostOf('http://box.local')).toBe('box.local:80');
    });

    it('refuses a target for a blank or unparseable base URL', () => {
        // A row page reports `base_url: ''` (./view-api.ts:232) — "not reported", not
        // "the empty endpoint", so the UI must print nothing rather than `localhost:80`.
        expect(providerHostOf('')).toBeUndefined();
        expect(providerHostOf('   ')).toBeUndefined();
        expect(providerHostOf(undefined)).toBeUndefined();
        expect(providerHostOf('not a url')).toBeUndefined();
    });

    it('renders the header line as provider host + model', () => {
        expect(providerTargetNote({ baseUrl: STUCK_URL, model: 'basalt-8k' })).toBe(
            'provider localhost:5500 · model basalt-8k'
        );
    });

    it('drops whichever half is unknown, and the whole line when nothing is known', () => {
        expect(providerTargetNote({ baseUrl: '', model: 'basalt-8k' })).toBe('model basalt-8k');
        expect(providerTargetNote({ baseUrl: STUCK_URL, model: '' })).toBe('provider localhost:5500');
        expect(providerTargetNote({})).toBeUndefined();
        expect(providerTargetNote({ baseUrl: undefined, model: undefined })).toBeUndefined();
    });
});

describe('the live provider retry line (AC2)', () => {
    it('renders attempt, budget, backoff, errno and dial target', () => {
        expect(
            providerRetryNote({
                attempt: 6,
                maxAttempts: 11,
                delayMs: 32_000,
                error: {
                    message:
                        'Request to http://localhost:5500/providers/private/v1/chat/completions failed: fetch failed'
                },
                provider: {
                    errorClass: 'provider-connection',
                    url: STUCK_URL,
                    port: 5500,
                    errno: 'ECONNREFUSED'
                }
            })
        ).toBe(
            'attempt 6 of 11 failed · retrying in 32.0s · ECONNREFUSED · http://localhost:5500/providers/private/v1'
        );
    });

    it('falls back to the error message as the reason when no errno was reported', () => {
        expect(
            providerRetryNote({
                attempt: 1,
                maxAttempts: 3,
                delayMs: 1_000,
                error: { message: 'HTTP 503: provider overloaded' },
                provider: { errorClass: 'provider-timeout', url: STUCK_URL, phase: 'first-token', timeoutMs: 90_000 }
            })
        ).toBe('attempt 1 of 3 failed · retrying in 1.0s · HTTP 503: provider overloaded · http://localhost:5500/providers/private/v1');
    });

    it('states a bare port when the frame names a port but no url', () => {
        expect(
            providerRetryNote({
                attempt: 2,
                maxAttempts: 4,
                delayMs: 2_000,
                error: { message: 'socket hang up' },
                provider: { errorClass: 'provider-connection', url: '', port: 5500 }
            })
        ).toBe('attempt 2 of 4 failed · retrying in 2.0s · socket hang up · port 5500');
    });

    it('answers undefined for a retry WITHOUT provider — the generic rendering is kept', () => {
        // AC2's other half: an unclassified retry mints no line at all (T19/R19 silence).
        expect(
            providerRetryNote({
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'HTTP 500: overloaded' }
            })
        ).toBeUndefined();
    });

    it('answers undefined when the frame numbers are unusable', () => {
        expect(
            providerRetryNote({
                attempt: undefined,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'x' },
                provider: { errorClass: 'provider-connection', url: STUCK_URL }
            })
        ).toBeUndefined();
    });
});

describe('the terminal provider failure (AC3)', () => {
    it('labels a provider-connection with the dialled address and says it is the provider address', () => {
        expect(
            providerFailureOf({
                message: 'Request to http://localhost:5500/providers/private/v1/chat/completions failed: fetch failed',
                code: 'provider-connection',
                provider: { errorClass: 'provider-connection', url: STUCK_URL, port: 5500, errno: 'ECONNREFUSED' }
            })
        ).toEqual({
            label: 'provider-connection',
            text:
                'dialled http://localhost:5500/providers/private/v1 · Request to http://localhost:5500/providers/private/v1/chat/completions failed: fetch failed · this is the provider address, set in Endpoint & model settings'
        });
    });

    it('recovers the class and the host:port from the server sentence alone', () => {
        // The HISTORICAL shape: a session persisted before 2026-11-17 stored a terminal
        // record with nothing but `message` (`code` and `provider` joined `HarnessErrorInfo`
        // with the unrecoverable-timeout fix), and re-opening it must still name the class.
        // The message names both facts (T6), and the host:port is echoed, never inferred
        // from a default. NEW records take the structured path above.
        expect(
            providerFailureOf({
                message:
                    'provider-connection: nothing answered http://localhost:5500/providers/private/v1 (ECONNREFUSED); raise HARNESS_PROVIDER_CONNECTION_ATTEMPTS to wait longer'
            })
        ).toEqual({
            label: 'provider-connection',
            text:
                'dialled localhost:5500 · provider-connection: nothing answered http://localhost:5500/providers/private/v1 (ECONNREFUSED); raise HARNESS_PROVIDER_CONNECTION_ATTEMPTS to wait longer · this is the provider address, set in Endpoint & model settings'
        });
    });

    it('labels a provider-timeout with its phase and the bound that expired', () => {
        expect(
            providerFailureOf({
                message: 'The provider did not start answering within 30s (set HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS higher)',
                code: 'provider-timeout',
                provider: { errorClass: 'provider-timeout', url: STUCK_URL, phase: 'response-head', timeoutMs: 30_000 }
            })
        ).toEqual({
            label: 'provider-timeout',
            text:
                'response-head · bound 30.0s · The provider did not start answering within 30s (set HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS higher)'
        });
    });

    it('quotes the bound the message states when no structured timeout is carried', () => {
        expect(
            providerFailureOf({
                message: 'provider-timeout: first-token bound 90000ms expired while dialling localhost:5500'
            })
        ).toEqual({
            label: 'provider-timeout',
            text: 'first-token · bound 90000ms · provider-timeout: first-token bound 90000ms expired while dialling localhost:5500'
        });
    });

    it('keeps a timeout with neither phase nor bound readable, with no invented detail', () => {
        expect(
            providerFailureOf({ message: 'provider-timeout: the stream stalled', code: 'provider-timeout' })
        ).toEqual({ label: 'provider-timeout', text: 'provider-timeout: the stream stalled' });
    });

    it('answers undefined for an unclassified failure (generic rendering)', () => {
        expect(providerFailureOf({ message: 'submit rejected' })).toBeUndefined();
        expect(providerFailureOf({ message: 'HTTP 400: bad request', code: 'bad-request' })).toBeUndefined();
        expect(providerFailureOf(undefined)).toBeUndefined();
    });

    it('answers undefined for the classes this UI has no wording for, even when they are structured', () => {
        // 2026-11-17 (the unrecoverable-timeout report) put `code` and `provider` on EVERY
        // terminal record, so a refused request, a provider-side cancel and a dying stream
        // now arrive classified. They still answer `undefined`: this module's two layouts are
        // "nothing answered the port" and "a bound expired", and dressing a 401 refusal in
        // either one would tell the reader the provider is down when it is their request.
        expect(
            providerFailureOf({
                message: 'provider-rejected: the provider answered with HTTP 401 and refused the request.',
                code: 'provider-rejected'
            })
        ).toBeUndefined();

        expect(
            providerFailureOf({
                message: 'provider-aborted: the request was cancelled before it completed.',
                code: 'provider-aborted',
                provider: { errorClass: 'provider-aborted', url: STUCK_URL, port: 5500 }
            })
        ).toBeUndefined();

        // The transit class: no `code` at all (a defensive/legacy input shape — neither
        // gateway writer sends a codeless frame any more), and a 408/429/5xx
        // `upstream_status` is deliberately codeless; diagnosis only.
        expect(
            providerFailureOf({
                message: 'Upstream stream terminated',
                provider: { errorClass: 'provider-transit', url: STUCK_URL, port: 5500 }
            })
        ).toBeUndefined();
    });

    it('reads a structured terminal record before its prose, and never lets prose win', () => {
        // The order the module documents: `code`, then `provider.errorClass`, then the
        // sentence. A record whose fields and sentence disagree is served by the fields —
        // the producer's prose is endpoint-specific on purpose, so it is a fallback, not a
        // classifier.
        expect(
            providerFailureOf({
                message: 'Upstream stream terminated',
                code: 'provider-timeout',
                provider: { errorClass: 'provider-timeout', url: STUCK_URL, port: 5500, phase: 'stream-chunk', timeoutMs: 120_000 }
            })
        ).toEqual({
            label: 'provider-timeout',
            text: 'stream-chunk · bound 2m00s · Upstream stream terminated'
        });
    });
});

describe('the optional providerTimeouts config field (AC4)', () => {
    it('reads a full block into three bounds', () => {
        expect(
            providerTimeoutsOf({
                providerTimeouts: { responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 }
            })
        ).toEqual({ responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 });
    });

    it('keeps the bounds that are valid and drops the rest', () => {
        expect(
            providerTimeoutsOf({
                providerTimeouts: { responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: '90000', streamChunkTimeoutMs: -1 }
            })
        ).toEqual({ responseHeadTimeoutMs: 30_000 });
    });

    it('answers undefined for every shape of absence — never a throw, never zeros', () => {
        // The field is optional by contract (the server side lands in parallel), so a
        // missing, null, non-object or all-invalid block is one answer: nothing known.
        expect(providerTimeoutsOf({})).toBeUndefined();
        expect(providerTimeoutsOf({ providerTimeouts: undefined })).toBeUndefined();
        expect(providerTimeoutsOf({ providerTimeouts: null })).toBeUndefined();
        expect(providerTimeoutsOf({ providerTimeouts: [] })).toBeUndefined();
        expect(providerTimeoutsOf({ providerTimeouts: { responseHeadTimeoutMs: null } })).toBeUndefined();
        expect(providerTimeoutsOf(null)).toBeUndefined();
        expect(providerTimeoutsOf(undefined)).toBeUndefined();
        expect(providerTimeoutsOf('config')).toBeUndefined();
    });

    it('renders one settings line, or nothing at all', () => {
        expect(
            providerTimeoutsNote({ responseHeadTimeoutMs: 30_000, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 20_000 })
        ).toBe('provider timeouts · response head 30.0s · first token 1m30s · stream chunk 20.0s');
        expect(providerTimeoutsNote({ streamChunkTimeoutMs: 20_000 })).toBe('provider timeouts · stream chunk 20.0s');
        expect(providerTimeoutsNote(undefined)).toBeUndefined();
        expect(providerTimeoutsNote({})).toBeUndefined();
    });

    it('prints a disabled bound as `off`, never as 0ms', () => {
        // The contract's own meaning of `0` (../shared/harness-api.ts
        // `GlobalConfigDocument.providerTimeouts`): that leg is DISABLED and waits forever.
        // Rendering it as `0ms` is the single number a reader is guaranteed to misread.
        expect(
            providerTimeoutsNote({ responseHeadTimeoutMs: 0, firstTokenTimeoutMs: 90_000, streamChunkTimeoutMs: 0 })
        ).toBe('provider timeouts · response head off · first token 1m30s · stream chunk off');
        // A disabled bound is still a bound the server reported, so it survives the read.
        expect(providerTimeoutsOf({ providerTimeouts: { responseHeadTimeoutMs: 0 } })).toEqual({
            responseHeadTimeoutMs: 0
        });
    });
});
