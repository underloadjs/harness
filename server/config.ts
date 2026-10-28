// Server configuration.
//
// The server can run with no configuration at all: the scripted demo needs no
// provider. Live presets read these defaults, and the UI can override the base URL
// and model per session. The API key is never sent to a client.
//
// CREDENTIAL RULE (the reason mergeSettings is not a plain spread):
// the server's configured key belongs to ONE provider — the origin and base path
// of `defaults.baseURL`. A client may point a model listing or a session at any
// base URL it likes, but an omitted/blank key then means "no key", never "use
// the server key". Without this rule a foreign base URL plus a blank key would
// send the server's credential to a host of the caller's choosing.
//
// Cross-references:
//   - ./api.ts      — POST /models merges over the STORE's live settings
//   - ./sessions.ts — SessionStore.create merges over the same settings
//   - server/api.ts — maps SettingsError to its 400 status

import type { RunnerSettings } from '../harnesses/types';
import type { HarnessIndex } from './protocol';

export type ServerConfiguration = {
    settings: RunnerSettings;
    defaults: HarnessIndex['defaults'];
};

const DEFAULT_BASE_URL = 'http://localhost:5500/providers/private/v1';
const DEFAULT_MODEL = 'merge/ds4-flash';

// Shared bounds for client-supplied settings. A base URL is a URL, not a
// document; a model name is an id. Both caps are generous (an OpenAI-compatible
// gateway URL with a long provider path still fits) and exist so a settings body
// cannot smuggle an unbounded string into every provider request.
export const MAX_BASE_URL_LENGTH = 2048;
export const MAX_MODEL_LENGTH = 256;

// A rejected settings value. Carries an HTTP status so the dispatcher can map it
// without knowing which field was wrong, exactly like HttpError/SessionError.
export class SettingsError extends Error {
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'SettingsError';
    }
}

// Settings arrive as parsed JSON, so a field can be any JSON value. `.trim()` on
// a number would be a TypeError → 500, so every optional string is checked here
// once instead of at each call site.
const optionalString = (value: unknown, field: keyof RunnerSettings): string | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'string') {
        throw new SettingsError(`\`settings.${field}\` must be a string when present.`);
    }

    return value;
};

// Canonical comparison form for a provider URL: scheme + host + base path, with
// trailing slashes removed. Query and hash are KEPT on purpose — a client that
// appends `?redirect=…` to the configured base URL is not asking for the same
// provider endpoint, so it must not receive the configured key.
//
// `new URL` also lowercases the host and normalizes a default port, which is why
// `http://Provider.test:80/v1/` and `http://provider.test/v1` compare equal. A
// value the URL parser rejects falls back to trimmed, slash-normalized text so
// the comparison never throws.
export const normalizeProviderURL = (value: string): string => {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) return '';

    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.replace(/\/+$/, '');
        return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
    } catch {
        return trimmed;
    }
};

// True when both values describe the same provider endpoint. An empty base URL
// never matches: "no provider configured" is not a provider.
export const isSameProvider = (left: string, right: string): boolean => {
    const a = normalizeProviderURL(left);
    const b = normalizeProviderURL(right);

    return a.length > 0 && a === b;
};

export const loadConfiguration = (): ServerConfiguration => {
    const baseURL = process.env.HARNESS_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const apiKey = process.env.HARNESS_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    const model = process.env.HARNESS_MODEL?.trim() || DEFAULT_MODEL;

    return {
        settings: { baseURL, apiKey, model },
        defaults: {
            baseURL,
            model,
            hasApiKey: apiKey.trim().length > 0
        }
    };
};

// Merge a client's per-session settings over the server defaults.
//
// Key resolution, in order:
//   1. an explicit non-blank client key is used as given (trimmed);
//   2. otherwise the server key is used ONLY when the effective base URL is the
//      configured provider (same origin + base path, trailing slashes ignored);
//   3. otherwise the key is empty — the request goes out unauthenticated.
//
// `baseURL: ''` is kept as empty, which is how a live preset reports that it
// needs one. `model: ''` falls back to the server model, like before.
export const mergeSettings = (
    defaults: RunnerSettings,
    input: Partial<RunnerSettings> | undefined
): RunnerSettings => {
    const requestedBaseURL = optionalString(input?.baseURL, 'baseURL');
    const requestedModel = optionalString(input?.model, 'model');
    const requestedApiKey = optionalString(input?.apiKey, 'apiKey');

    const baseURL = requestedBaseURL !== undefined ? requestedBaseURL.trim() : defaults.baseURL;
    const model = requestedModel?.trim() || defaults.model;

    // Validate before returning: both the model listing and session creation use
    // the result, so one cap here covers every provider request path.
    if (baseURL.length > MAX_BASE_URL_LENGTH) {
        throw new SettingsError(`A provider base URL cannot exceed ${MAX_BASE_URL_LENGTH} characters.`);
    }

    if (model.length > MAX_MODEL_LENGTH) {
        throw new SettingsError(`A model name cannot exceed ${MAX_MODEL_LENGTH} characters.`);
    }

    const explicitKey = requestedApiKey?.trim() ?? '';
    const apiKey =
        explicitKey.length > 0
            ? explicitKey
            : isSameProvider(baseURL, defaults.baseURL)
              ? defaults.apiKey.trim()
              : '';

    return { baseURL, model, apiKey };
};
