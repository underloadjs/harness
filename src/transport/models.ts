// Model catalogue lookup for OpenAI-compatible providers.
//
// A provider describes what it can serve at `GET {baseURL}/models`. Every
// endpoint this workspace targets implements the standard envelope
// `{ object: 'list', data: [{ id, ... }] }`; a few gateways answer with a bare
// array instead, so both shapes are accepted here. The harness UI needs ids for
// a dropdown, and the server needs to perform the request because it is the
// only party that can hold the provider key.
//
// Why this lives next to openai.ts:
//   - it is the second (and only other) HTTP call the package makes, so the same
//     rules must hold: dependency-free `fetch`, a getter-capable key, extra
//     headers, and a trailing-slash-normalized base URL;
//   - the server imports it directly, and `./index.ts` re-exports it so a
//     consumer that reaches the package through `src/harness.ts` can use it as
//     soon as the public surface is updated.
//
// Security notes (see server/handler.ts for the credential-owning caller):
//   - the API key is only ever placed in the `authorization` header; it is never
//     appended to the URL, the path, or a query string;
//   - error messages are scrubbed of the key and built from a display URL that
//     drops any userinfo and query string, so a thrown error is safe to return
//     over HTTP and safe to log.
//
// Cross-references:
//   - ./openai.ts      — the sibling transport and its error/message conventions
//   - ./index.ts       — the transport barrel
//   - server/handler.ts — POST /api/models, the only caller that matters
//   - server/protocol.ts — the wire type of that route

import { toErrorInfo } from '../util';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

// The minimum needed to ask a provider what it serves. Mirrors
// `HarnessProviderConfiguration` (types/index.ts) but is local so this helper
// does not depend on sampling or agent configuration.
export type ModelListConfiguration = {
    // Base URL without the /models suffix, e.g.
    // 'http://localhost:5500/providers/private/v1'. Trailing slashes are ignored.
    baseURL: string;
    // A static key, or a getter so rotating credentials stay live per request.
    apiKey?: string | (() => string);
    // Extra headers merged over the generated ones (accept, authorization).
    headers?: Record<string, string>;
    // Optional cancellation. The server sets a timeout; tests and CLIs may pass
    // their own signal.
    signal?: AbortSignal;
};

// Why the lookup failed. The server maps these onto HTTP statuses:
//   - 'configuration' — the caller's settings cannot be used (blank/invalid URL)
//     and no request was attempted, so 400;
//   - 'request'       — the network request itself failed (DNS, TLS, abort), 502;
//   - 'response'      — the provider answered, but not with a usable catalogue,
//     so 502.
// Keeping the distinction in a field (not in the message) lets the caller stay
// deterministic without parsing strings.
export type ModelListErrorKind = 'configuration' | 'request' | 'response';

// A dedicated error so callers can branch on `kind` instead of message text.
export class ModelListError extends Error {
    constructor(
        message: string,
        readonly kind: ModelListErrorKind
    ) {
        super(message);
        this.name = 'ModelListError';
    }
}

// ---------------------------------------------------------------------------
// URL and message helpers
// ---------------------------------------------------------------------------

// Provider error bodies are arbitrary text. Cap what is echoed back so a huge
// HTML error page never becomes the UI's error string (same rule as openai.ts).
const MAX_DETAIL_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

// Replace the key anywhere it appears in a message. Provider bodies sometimes
// echo request headers, and an echoed secret must not reach the browser or a
// log line. A short key would over-redact, so only keys of a usable length are
// scrubbed; credential-shaped keys are far longer than this.
const redact = (message: string, key: string | undefined): string => {
    if (!key || key.length === 0) return message;
    return message.split(key).join('[redacted]');
};

// A URL safe to quote in an error: no userinfo, no query string, no fragment.
// The request URL itself never carries a key (it lives in a header), so this is
// defence in depth against a base URL that embeds credentials.
const displayUrl = (url: URL): string => `${url.origin}${url.pathname}`;

// Resolve `{baseURL}/models`, validating it is an absolute http(s) URL.
//
// Rules:
//   - trim, so a trailing newline from an env var does not poison the request;
//   - absolute only: `fetch` on the server needs a scheme and host, and a
//     relative base would silently target the harness server itself;
//   - http/https only: `file:`, `data:`, and friends must never be reachable
//     from a settings field;
//   - append `/models` to the pathname, not to the raw string, so a base URL
//     that already has a query string cannot swallow the suffix.
const modelsUrl = (baseURL: string): URL => {
    const trimmed = baseURL.trim();
    if (trimmed.length === 0) {
        throw new ModelListError('A provider base URL is required to list models.', 'configuration');
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new ModelListError(`"${trimmed}" is not an absolute URL.`, 'configuration');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ModelListError(
            `"${displayUrl(url)}" must use http or https to list models.`,
            'configuration'
        );
    }

    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
    return url;
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

// Extract ids from either supported catalogue shape:
//   { object: 'list', data: [{ id: 'x' }, ...] }   (standard)
//   ['x', ...]                                     (bare array tolerance)
//
// Entries are trimmed, empty ids are dropped, and duplicates are removed while
// preserving the provider's order — that order is often the provider's own
// preference, and a dropdown should not reshuffle it. A non-string `id` is
// ignored rather than stringified: `{ id: 5 }` is not a model a provider can
// serve, and coercing it would put a nonexistent id in the UI.
const modelIds = (payload: unknown): string[] => {
    const entries = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data
          : undefined;

    if (entries === undefined) {
        throw new ModelListError(
            "The provider's /models response did not include a model list.",
            'response'
        );
    }

    const ids: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        const raw = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined;
        if (raw === undefined) continue;

        const id = raw.trim();
        if (id.length === 0 || seen.has(id)) continue;

        seen.add(id);
        ids.push(id);
    }

    return ids;
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

// GET {baseURL}/models and return the ids the provider advertises.
//
// Resolves `[]` when the provider answered successfully with an empty list: an
// empty catalogue is a state the UI must render, not an error. Every other
// outcome throws `ModelListError`, so a caller can never mistake "the request
// failed" for "the provider serves nothing".
export const listModels = async (configuration: ModelListConfiguration): Promise<string[]> => {
    const url = modelsUrl(configuration.baseURL);

    // Resolve the key per call, exactly like openAICompatible: a getter may
    // rotate credentials without rebuilding the caller.
    const resolved = typeof configuration.apiKey === 'function' ? configuration.apiKey() : configuration.apiKey;
    const key = typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;

    let response: Response;
    try {
        response = await fetch(url.href, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                // Only when a key exists; `Bearer ` with an empty token is worse
                // than no header at all.
                ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
                ...configuration.headers
            },
            signal: configuration.signal
        });
    } catch (error) {
        throw new ModelListError(
            redact(`Request to ${displayUrl(url)} failed: ${toErrorInfo(error).message}`, key),
            'request'
        );
    }

    if (!response.ok) {
        // Providers frequently explain the failure in the body; use it when it
        // is short text, otherwise fall back to the status line.
        const detail = (await response.text().catch(() => '')).trim().slice(0, MAX_DETAIL_LENGTH);
        throw new ModelListError(
            redact(`HTTP ${response.status}: ${detail || response.statusText}`, key),
            'response'
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch (error) {
        throw new ModelListError(
            redact(`The provider returned a model list that is not JSON: ${toErrorInfo(error).message}`, key),
            'response'
        );
    }

    return modelIds(payload);
};
