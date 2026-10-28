// Shared HTTP plumbing for the webSearch adapters.
//
// WHY THIS FILE EXISTS
// --------------------
// Exa and Tavily differ only in endpoint, auth header, body keys, and result
// field names. Everything that is a *policy* — how long a request may take, how
// much of a response is accepted, what an error may say, how a URL is validated,
// how a snippet is truncated, how a configured key is redacted — lives here once
// so the two adapters cannot drift. Both adapters are loaded by `import()` from
// ../websearch/index, so importing this module costs no SDK and no network.
//
// Bounds (S1: "bounded normalized results"). These are constants, not knobs: the
// harness promises a small, predictable tool result, so a provider cannot flood
// the context or the process:
//   - 5 results by default, 20 maximum (the tool clamps the model's request);
//   - 1,000 characters of snippet per result, 300 of title, 64 of publication
//     date, and 2,048 characters of URL (a longer URL drops the row instead of
//     being truncated into a different link);
//   - 512 KiB of response body, enforced while streaming so an oversized body is
//     never allocated in full, plus a content-length pre-check;
//   - 15 s per request, enforced with AbortController and cleaned up in `finally`.
//
// Redaction order is a security property, not a style choice: every field is
// redacted FIRST and bounded second. Bounding first (the old behaviour) could cut
// a configured credential in half, leaving a prefix of the secret in the result at
// the truncation boundary.
//
// Errors are sanitized on purpose: a provider status is reported, a provider
// body never is (it could echo the key or an unrelated secret), and a network
// failure is reduced to one fixed sentence. There is no retry and no failover:
// a 401/402/432/433 (auth/quota), 429, 5xx, or timeout is returned to the caller
// once, so a model cannot multiply spend by repeating a call it should not make.
//
// Returned excerpts are untrusted data from the open web. The tool marks them as
// excerpts in its description; it does not interpret them.
//
// Cross-references:
//   - ./exa        — Exa request body and result mapping
//   - ./tavily     — Tavily request body and result mapping
//   - ./index      — createWebsearchTool: key resolution, validation, dispatch
//   - ../../util   — HarnessError (the message the model ends up reading)

import { HarnessError } from '../../util';
import type { WebSearchMatch } from '../../types';

// Default result count when the model (or a direct caller) does not ask.
export const DEFAULT_MAX_RESULTS = 5;

// Hard ceiling. A larger `maxResults` is clamped, not rejected, so a model that
// asks for 100 still gets a useful answer instead of an error turn.
export const MAX_RESULTS_LIMIT = 20;

// Per-request budget. No retry: a timeout is reported once.
export const SEARCH_TIMEOUT_MS = 15_000;

// Response ceiling, in bytes (512 KiB). The body is read through a stream and the
// budget is checked per chunk, so a provider cannot force a full allocation first.
// Content-length is checked too, when the provider sends it.
export const MAX_RESPONSE_BYTES = 512 * 1024;

export const MAX_TITLE_CHARS = 300;
export const MAX_SNIPPET_CHARS = 1_000;

// A provider date is a label, not free text: anything longer is dropped rather
// than emitted as a misleading "publication date".
export const MAX_PUBLISHED_CHARS = 64;

// A URL is a link the model is expected to cite. A URL longer than this cannot be
// truncated without corrupting it, so `validUrl` rejects the row instead.
export const MAX_URL_CHARS = 2_048;

// How a configured key is replaced when a provider echoes it back inside a
// snippet, title, or URL. Fixed text: the replacement must not hint at the value.
export const REDACTED = '[redacted]';

// Everything one adapter needs. `redact` is the harness-wide redactor built from
// every configured key (not just this provider's), so a response cannot leak a
// key belonging to the other provider either.
export type ProviderSearch = {
    query: string;
    maxResults: number;
    apiKey: string;
    redact: (text: string) => string;
};

// The request shape `requestSearch` accepts. `body` is JSON; `headers` are added
// to the JSON content type (or replace it, for a provider that wants another).
type SearchRequest = {
    // Display name for error messages: "Exa", "Tavily".
    label: string;
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
};

// A provider row mapped to our stable field names, still unvalidated. Adapters
// pass this through `normalizeMatches`, which owns URL validation and bounds.
export type MatchFields = {
    title: unknown;
    url: unknown;
    snippet: string;
    published?: string;
};

// The result of reading a provider row. `read` returns untrusted raw fields; the
// shared normalization below is what makes a WebSearchMatch safe to emit.
export type MatchReader = (row: Record<string, unknown>) => MatchFields;

// Build a redactor over every configured key. The returned function is applied to
// every string that leaves the tool: title, URL, snippet, and published date.
//
// Every non-empty key is redacted, however short. There is deliberately no minimum
// length: an explicit or test credential can be a handful of characters, and
// skipping it would leave the whole value in a provider excerpt. For a very short
// key the cost is over-redaction of ordinary text, which is the safe direction.
//
// Longer keys are replaced first so that a configured key containing another
// configured key is removed whole instead of leaving a suffix behind. Duplicates
// are dropped so a shared key is scanned once.
//
// Why split/join instead of a RegExp: keys are opaque and may contain regex
// metacharacters, and a global RegExp would have to be recompiled per key.
export const createRedactor = (secrets: readonly string[]) => {
    const targets = [...new Set(secrets)]
        .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
        .sort((left, right) => right.length - left.length);

    return (text: string): string => {
        let output = text;

        for (const secret of targets) {
            output = output.split(secret).join(REDACTED);
        }

        return output;
    };
};

// Collapse whitespace, trim, and bound one text field. Titles and snippets often
// arrive with newlines and runs of spaces; one line is what a tool result wants.
export const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';

    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

// Redact the RAW provider string, then collapse and bound it.
//
// This order matters: redacting after truncation can leave the first characters of
// a configured key at the cut (the old `redact(text(raw, max))` bug). A redaction
// marker itself may be cut by the bound, but a marker is not secret.
export const bounded = (value: unknown, max: number, redact: (text: string) => string): string =>
    typeof value === 'string' ? text(redact(value), max) : '';

// A snippet source may be a string (Tavily content) or a list of strings (Exa
// highlights). Join highlights with a space, then let `text` bound the result.
export const excerpt = (value: unknown): string => {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string').join(' ');
    }

    return typeof value === 'string' ? value : '';
};

// Provider date fields are strings when present; anything else is ignored rather
// than stringified into a misleading value.
export const date = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

// Accept only absolute http(s) URLs. A provider is data, so a `javascript:` or
// relative value is dropped from the result instead of handed to the model.
//
// Two bounds that are not cosmetic:
//   - a URL longer than MAX_URL_CHARS is rejected, not sliced: a truncated URL
//     looks valid but points somewhere else;
//   - a URL carrying userinfo (`https://user:pass@host/`) is rejected. These are
//     links the model reads and cites, never fetches by this tool, so this is a
//     display/phishing bound rather than SSRF protection.
const validUrl = (value: unknown): string | undefined => {
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

// Turn provider rows into the stable result shape: slice to the requested count,
// drop rows without a valid URL, bound every field, and redact every string.
// Invalid rows are skipped rather than failing the whole search: one bad row is
// not a reason to lose the good ones.
//
// Order per field: validate raw -> redact -> bound. Redaction happens on the raw
// string so a credential can never be cut at a truncation boundary.
export const normalizeMatches = (
    rows: readonly unknown[],
    maxResults: number,
    redact: (text: string) => string,
    read: MatchReader
): WebSearchMatch[] => {
    const matches: WebSearchMatch[] = [];

    for (const row of rows.slice(0, maxResults)) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

        const fields = read(row as Record<string, unknown>);
        const url = validUrl(fields.url);
        if (url === undefined) continue;

        // Redaction can lengthen a URL (`[redacted]` is longer than a short key).
        // If the safe form no longer fits, drop the row rather than truncate it.
        const safeUrl = redact(url);
        if (safeUrl.length > MAX_URL_CHARS) continue;

        const match: WebSearchMatch = {
            // Fall back to the URL so a result never has an empty title.
            title: bounded(fields.title, MAX_TITLE_CHARS, redact) || safeUrl,
            url: safeUrl,
            snippet: bounded(fields.snippet, MAX_SNIPPET_CHARS, redact)
        };

        const published = bounded(date(fields.published), MAX_PUBLISHED_CHARS, redact);
        if (published.length > 0) match.published = published;

        matches.push(match);
    }

    return matches;
};

// One fixed sentence per failure class. Provider bodies are deliberately absent:
// they can contain the request (and therefore the key), an account name, or HTML.
const statusFailure = (label: string, status: number): HarnessError => {
    if (status === 401 || status === 403) {
        return new HarnessError(
            `${label} search rejected the API key (HTTP ${status}). Check the configured key and account.`
        );
    }

    // 402 is Exa's payment-required; 432/433 are Tavily's plan/quota errors.
    if (status === 402 || status === 432 || status === 433) {
        return new HarnessError(
            `${label} search reports no remaining credits or quota (HTTP ${status}). Check the provider account.`
        );
    }

    if (status === 429) {
        return new HarnessError(`${label} search is rate limited (HTTP ${status}). Try again later.`);
    }

    return new HarnessError(`${label} search failed (HTTP ${status}).`);
};

// One fixed sentence for the size bound, shared by the content-length pre-check
// and the streaming budget so both report the same thing.
const oversizedResponse = (label: string): HarnessError =>
    new HarnessError(`${label} search returned a response larger than ${MAX_RESPONSE_BYTES} bytes.`);

// Read a response body without ever holding more than MAX_RESPONSE_BYTES.
//
// `response.text()` allocates the whole body first, so a provider (or a proxy)
// could force a huge allocation before any check ran. Reading chunk by chunk lets
// us count bytes and cancel the stream the moment the budget is crossed. The same
// budget is checked on content-length before this is called, and again on the
// no-stream fallback so a runtime without `body` is not exempt.
//
// `failure` is the caller's network/timeout classifier: a read that rejects is
// either the request signal aborting or a broken transport, and the caller is the
// only place that can tell them apart.
const readBody = async (response: Response, label: string, failure: () => HarnessError): Promise<string> => {
    const stream = response.body;

    if (!stream || typeof stream.getReader !== 'function') {
        let body: string;

        try {
            body = await response.text();
        } catch {
            throw failure();
        }

        if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw oversizedResponse(label);

        return body;
    }

    const reader = stream.getReader();
    // TextDecoder streams across chunk boundaries so a multi-byte character split
    // between two chunks is decoded once, not turned into a replacement character.
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let received = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            received += value.byteLength;

            // Stop the transfer before throwing: returning while the provider is
            // still sending would leave the socket busy for the rest of the budget.
            if (received > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // The stream may already be closed; the size error is the one
                    // the caller needs.
                }

                throw oversizedResponse(label);
            }

            parts.push(decoder.decode(value, { stream: true }));
        }

        // Flush any bytes held back as a partial character.
        parts.push(decoder.decode());

        return parts.join('');
    } catch (error) {
        // A HarnessError here is our own size error: keep it.
        if (error instanceof HarnessError) throw error;

        throw failure();
    } finally {
        // Releasing the lock is best-effort: cancel() in the limit path already
        // closes the reader, and a release on a closed reader is a no-op we do not
        // want to surface.
        try {
            reader.releaseLock();
        } catch {
            // Ignore: the stream is already done or cancelled.
        }
    }
};

// The one place a network request is made. Resolves the parsed JSON body; throws
// a HarnessError with a sanitized message for every failure. The AbortController
// and its timer are always cleaned up, including when JSON parsing throws.
export const requestSearch = async (request: SearchRequest): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    // `aborted` is the only way to tell our timeout from a network refusal, since
    // fetch rejects with an AbortError for both a signal and some transports.
    const networkFailure = (): HarnessError =>
        controller.signal.aborted
            ? new HarnessError(`${request.label} search timed out after ${SEARCH_TIMEOUT_MS} ms.`)
            : new HarnessError(`${request.label} search could not be reached (network error).`);

    try {
        let response: Response;

        try {
            response = await fetch(request.endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...request.headers },
                body: JSON.stringify(request.body),
                signal: controller.signal,
                // No redirects: a redirect would move the request somewhere the
                // fixed endpoint policy did not choose.
                redirect: 'error'
            });
        } catch {
            throw networkFailure();
        }

        if (!response.ok) throw statusFailure(request.label, response.status);

        // Reject an oversized declared body before reading it. The streaming budget
        // in `readBody` still applies when the header is absent or wrong.
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            throw oversizedResponse(request.label);
        }

        const body = await readBody(response, request.label, networkFailure);

        try {
            return JSON.parse(body) as unknown;
        } catch {
            throw new HarnessError(`${request.label} search returned a response that is not JSON.`);
        }
    } finally {
        // Clear before the controller goes out of scope so a completed request
        // never keeps the process alive for the rest of the budget.
        clearTimeout(timer);
    }
};

// Read the provider's result list, or fail with a message that names the field.
// Shared because both providers use `results`; keeping the check here means an
// unexpected body (HTML error page, truncated JSON) becomes the same readable
// error for either adapter.
export const resultsArray = (payload: unknown, label: string): readonly unknown[] => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HarnessError(`${label} search returned an unexpected response.`);
    }

    const results = (payload as Record<string, unknown>).results;

    if (!Array.isArray(results)) {
        throw new HarnessError(`${label} search returned a response without a "results" list.`);
    }

    return results;
};
