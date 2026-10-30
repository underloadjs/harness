// Shared HTTP plumbing and bounds for the webFetch tool.
//
// WHY THIS FILE EXISTS
// --------------------
// webFetch has two providers — `native` (a direct GET) and `exa` (Exa's
// /contents POST) — but only the GET policy lives here: how long a fetch may
// take, how much of a response is accepted, which content types are readable,
// what an error may say, and how a URL is validated. The Exa adapter reuses
// ../websearch/request's JSON plumbing instead, because that file already owns
// the provider-request policy for api.exa.ai (fixed endpoint, no redirects,
// sanitized statuses).
//
// Bounds (S1, same philosophy as websearch): these are constants, not knobs. A
// tool result must stay small and predictable no matter what the open web
// returns:
//   - 512 KiB of response body, enforced while streaming so an oversized page
//     is never allocated in full, plus a content-length pre-check;
//   - 24,000 characters of returned content (the character budget is what the
//     model actually pays; the byte bound is what the process is exposed to);
//   - 15 s per request, enforced with AbortController and cleaned up in
//     `finally`; one attempt per user agent, plus a single honest-UA retry when
//     Cloudflare challenges the browser-impersonating one.
//
// Redirects are FOLLOWED here (up to fetch's implementation default), unlike
// the fixed-endpoint search requests: a page URL legitimately redirects, and
// the result reports the final URL so the model cites where the content
// actually came from. The credential never rides along — the key is only ever
// sent to api.exa.ai, never to a fetched page.
//
// Errors are sanitized on purpose: a page status is reported, a page body
// never is (error pages are HTML), and a network failure is reduced to one
// fixed sentence. There is no retry beyond the Cloudflare UA swap, so a model
// cannot multiply spend by hammering a slow host.
//
// Cross-references:
//   - ./native      — the GET flow and the HTML conversion
//   - ./exa         — Exa /contents wire body + result mapping
//   - ./index       — createWebFetchTool: key resolution, validation, dispatch
//   - ../websearch/request — createRedactor (reused), the search-side twin

import { HarnessError } from '../../util';

// Per-request budget. One attempt (plus the Cloudflare UA retry), then reported.
export const FETCH_TIMEOUT_MS = 15_000;

// Response ceiling, in bytes (512 KiB). The body is read through a stream and
// the budget is checked per chunk, so a host cannot force a full allocation.
// Content-length is checked too, when the host sends it.
export const MAX_RESPONSE_BYTES = 512 * 1024;

// Returned-content ceiling, in characters. A cut page sets `truncated`.
export const MAX_CONTENT_CHARS = 24_000;

// A <title> is a label, not free text: anything longer is dropped.
export const MAX_TITLE_CHARS = 300;

// A fetchable URL is bounded like a cited one: longer is rejected, not sliced.
export const MAX_URL_CHARS = 2_048;

// The content-type header is echoed into the result; a megabyte of parameters
// would not be information.
export const MAX_CONTENT_TYPE_CHARS = 200;

// The user agents. The first impersonates a browser (many hosts 403 an
// unidentified client); the second is honest and is tried once when Cloudflare
// challenges the impersonation — a bot with a fake UA and a mismatched TLS
// fingerprint is exactly what `cf-mitigated: challenge` answers.
export const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
export const HONEST_USER_AGENT = 'underload-harness';

// The Accept header steers format negotiation: a server that can serve the
// requested format directly (markdown files, plain-text endpoints) skips HTML
// entirely, which is both faster and cleaner than converting.
export const acceptHeader = (format: 'markdown' | 'text' | 'html'): string => {
    switch (format) {
        case 'markdown':
            return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
        case 'text':
            return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
        case 'html':
            return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
    }
};

// One fixed sentence per failure class. Page bodies are deliberately absent:
// an error page is HTML noise the model does not need.
const statusFailure = (status: number): HarnessError => {
    if (status === 404) return new HarnessError('webFetch could not find the page (HTTP 404).');
    if (status === 401 || status === 403) {
        return new HarnessError(`webFetch was denied access to the page (HTTP ${status}).`);
    }
    if (status === 429) return new HarnessError('webFetch is rate limited by the host (HTTP 429). Try again later.');

    return new HarnessError(`webFetch failed (HTTP ${status}).`);
};

const oversizedResponse = (): HarnessError =>
    new HarnessError(`webFetch received a response larger than ${MAX_RESPONSE_BYTES} bytes.`);

// Read a response body without ever holding more than MAX_RESPONSE_BYTES.
// Same streaming budget as ../websearch/request's reader: chunk-by-chunk byte
// counting, stream-cancel on overflow, and a TextDecoder that carries partial
// multi-byte characters across chunk boundaries.
const readBody = async (response: Response, failure: () => HarnessError): Promise<string> => {
    const stream = response.body;

    if (!stream || typeof stream.getReader !== 'function') {
        let body: string;

        try {
            body = await response.text();
        } catch {
            throw failure();
        }

        if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw oversizedResponse();

        return body;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let received = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            received += value.byteLength;

            // Stop the transfer before throwing: returning while the host is
            // still sending would leave the socket busy for the rest of the budget.
            if (received > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // The stream may already be closed; the size error is the one
                    // the caller needs.
                }

                throw oversizedResponse();
            }

            parts.push(decoder.decode(value, { stream: true }));
        }

        parts.push(decoder.decode());

        return parts.join('');
    } catch (error) {
        if (error instanceof HarnessError) throw error;

        throw failure();
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Ignore: the stream is already done or cancelled.
        }
    }
};

// A fetched page is only useful to the model as text. Images and binary
// documents are rejected with one sentence rather than returned as mojibake;
// svg+xml counts as text because it IS text and often carries readable content.
const IMAGE_MIMES = /^(image|audio|video)\//;

const readableMime = (mime: string): boolean => {
    if (mime.length === 0) return true; // no header: treat the body as text
    if (mime === 'application/pdf') return false;
    if (mime.startsWith('application/octet-stream')) return false;
    if (IMAGE_MIMES.test(mime)) return false;

    return (
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime.endsWith('+json') ||
        mime === 'application/xml' ||
        mime.endsWith('+xml') ||
        mime === 'application/xhtml+xml' ||
        mime === 'application/javascript' ||
        mime === 'application/x-javascript' ||
        mime === 'application/typescript' ||
        mime === 'image/svg+xml'
    );
};

export const mimeFrom = (contentType: string): string =>
    contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';

// Validate a fetch target. Absolute http(s), no userinfo (a `user:pass@host`
// URL from the model would put credentials on the wire), bounded length.
// Returns the normalized URL string, or undefined when the value is unusable.
export const fetchableUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return undefined;

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;

        const normalized = parsed.toString();
        return normalized.length > MAX_URL_CHARS ? undefined : normalized;
    } catch {
        return undefined;
    }
};

// A Cloudflare bot challenge answers 403 with `cf-mitigated: challenge`.
const isCloudflareChallenge = (response: Response): boolean =>
    response.status === 403 && response.headers.get('cf-mitigated') === 'challenge';

export type PageFetch = {
    // The URL after any redirects.
    url: string;
    contentType: string;
    body: string;
};

// One bounded GET. `format` only steers the Accept header — the body is
// returned raw and converted by the caller according to the actual content type.
export const requestPage = async (url: string, format: 'markdown' | 'text' | 'html'): Promise<PageFetch> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // `aborted` is the only way to tell our timeout from a network refusal,
    // since fetch rejects with an AbortError for both.
    const networkFailure = (): HarnessError =>
        controller.signal.aborted
            ? new HarnessError(`webFetch timed out after ${FETCH_TIMEOUT_MS} ms.`)
            : new HarnessError('webFetch could not be reached (network error).');

    const send = async (userAgent: string): Promise<Response> => {
        try {
            return await fetch(url, {
                method: 'GET',
                headers: {
                    'user-agent': userAgent,
                    accept: acceptHeader(format),
                    'accept-language': 'en-US,en;q=0.9'
                },
                signal: controller.signal
                // Redirects are followed (the default): a page legitimately moves,
                // and `response.url` reports where it landed.
            });
        } catch {
            throw networkFailure();
        }
    };

    try {
        let response = await send(BROWSER_USER_AGENT);

        // The one retry: a Cloudflare challenge means the fake-browser UA was
        // detected, so answer honestly and try once more.
        if (isCloudflareChallenge(response)) {
            try {
                await response.body?.cancel();
            } catch {
                // The body may already be consumed; the retry is what matters.
            }

            response = await send(HONEST_USER_AGENT);
        }

        if (!response.ok) throw statusFailure(response.status);

        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw oversizedResponse();

        const contentType = (response.headers.get('content-type') ?? '').slice(0, MAX_CONTENT_TYPE_CHARS);

        const mime = mimeFrom(contentType);
        if (!readableMime(mime)) {
            // Cancel so the socket is not held for a body we will never read.
            try {
                await response.body?.cancel();
            } catch {
                // Best-effort: the rejection message is what the caller needs.
            }

            throw new HarnessError(`webFetch does not support this content type (${mime || 'unknown'}).`);
        }

        const body = await readBody(response, networkFailure);

        return { url: response.url || url, contentType, body };
    } finally {
        // Clear before the controller goes out of scope so a completed fetch
        // never keeps the process alive for the rest of the budget.
        clearTimeout(timer);
    }
};
