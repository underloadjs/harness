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
//   - 1,000 characters of snippet per result, 300 of title;
//   - 512,000 characters of response body, checked by content-length and again
//     after read;
//   - 15 s per request, enforced with AbortController and cleaned up in `finally`.
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

// Response ceiling. Exa highlights and Tavily content are the only large fields
// we ask for, and both are capped again per result, so this is defence in depth
// against a provider (or a proxy) returning something far larger than requested.
export const MAX_RESPONSE_CHARS = 512 * 1024;

export const MAX_TITLE_CHARS = 300;
export const MAX_SNIPPET_CHARS = 1_000;

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
const validUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;

    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        return parsed.toString();
    } catch {
        return undefined;
    }
};

// Turn provider rows into the stable result shape: slice to the requested count,
// drop rows without a valid URL, bound every field, and redact every string.
// Invalid rows are skipped rather than failing the whole search: one bad row is
// not a reason to lose the good ones.
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

        const match: WebSearchMatch = {
            // Fall back to the URL so a result never has an empty title.
            title: redact(text(fields.title, MAX_TITLE_CHARS) || url),
            url: redact(url),
            snippet: redact(text(fields.snippet, MAX_SNIPPET_CHARS))
        };

        const published = date(fields.published);
        if (published !== undefined) match.published = redact(published);

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

        // Reject an oversized declared body before reading it. The post-read check
        // below still applies when the header is absent or wrong.
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
            throw new HarnessError(
                `${request.label} search returned a response larger than ${MAX_RESPONSE_CHARS} characters.`
            );
        }

        let body: string;

        try {
            body = await response.text();
        } catch {
            throw networkFailure();
        }

        if (body.length > MAX_RESPONSE_CHARS) {
            throw new HarnessError(
                `${request.label} search returned a response larger than ${MAX_RESPONSE_CHARS} characters.`
            );
        }

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
