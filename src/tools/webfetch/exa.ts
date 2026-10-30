// webFetch `exa` provider — page content through Exa's /contents endpoint.
//
// Loaded by `import()` from ./index on the first `provider: "exa"` call, so
// constructing a harness or fetching a native page never touches this module.
//
// Wire contract (https://docs.exa.ai/reference/get-contents):
//   POST https://api.exa.ai/contents
//   x-api-key: <key>                       (header only — never JSON or the URL)
//   { urls: [url], text: { maxCharacters: n } }
//   { results: [{ title, url, text? }], statuses: [{ id, status, error? }] }
//
// Exa's crawler renders and extracts server-side, so this provider is the
// higher-quality path: it returns clean markdown-style text for pages the
// regex converter in ./native handles poorly. It costs API credits, which is
// why `native` is the default and this path is opt-in per call.
//
// The request reuses ../websearch/request's `requestSearch`: same fixed
// endpoint, same no-redirect policy, same streaming byte budget, same
// sanitized status errors. Only the label differs, so a failure reads
// "Exa search ..." here too — one vocabulary for every api.exa.ai call.
//
// Cross-references:
//   - ../websearch/request — requestSearch, excerpt, the shared bounds/errors
//   - ./index              — dispatch + key resolution + the character bound

import { HarnessError } from '../../util';
import { excerpt, requestSearch } from '../websearch/request';

const ENDPOINT = 'https://api.exa.ai/contents';
const LABEL = 'Exa';

export type ExaFetch = (fetch: {
    url: string;
    maxCharacters: number;
    apiKey: string;
}) => Promise<{ content: string; title?: string }>;

export const fetchExa: ExaFetch = async ({ url, maxCharacters, apiKey }) => {
    const payload = await requestSearch({
        label: LABEL,
        endpoint: ENDPOINT,
        // The key travels in a header on purpose: headers are not logged in the
        // URL and not present in any redirect target (redirects are disabled by
        // requestSearch).
        headers: { 'x-api-key': apiKey },
        body: {
            urls: [url],
            // Ask for full page text, already bounded server-side: the wire
            // budget matches the tool's own bound, so the local slice below is
            // a formality and never the thing that keeps the context small.
            text: { maxCharacters }
        }
    });

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HarnessError('Exa contents returned an unexpected response.');
    }

    const results = (payload as Record<string, unknown>).results;

    if (!Array.isArray(results) || results.length === 0) {
        throw new HarnessError('Exa contents returned no result for that URL.');
    }

    const first = results[0];

    if (!first || typeof first !== 'object' || Array.isArray(first)) {
        throw new HarnessError('Exa contents returned no result for that URL.');
    }

    const record = first as Record<string, unknown>;
    const content = excerpt(record.text);

    if (content.trim().length === 0) {
        // /contents answers per-URL statuses; surface the tag when it recorded
        // the failure, and one fixed sentence when it did not.
        const statuses = (payload as Record<string, unknown>).statuses;
        const status = Array.isArray(statuses)
            ? statuses.find((row) => row && typeof row === 'object' && !Array.isArray(row) && (row as Record<string, unknown>).status === 'error')
            : undefined;
        const error = status ? (status as Record<string, unknown>).error : undefined;
        const tag = error && typeof error === 'object' ? (error as Record<string, unknown>).tag : undefined;

        throw new HarnessError(
            `Exa could not fetch that page${typeof tag === 'string' ? ` (${tag})` : ''}.`
        );
    }

    const rawTitle = record.title;
    const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;

    return { content, title };
};
