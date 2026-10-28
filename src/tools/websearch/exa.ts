// Exa adapter.
//
// Loaded by `import()` from ./index on the first `websearch` call, so constructing
// a harness or listing tools never touches this module or the network.
//
// Wire contract (https://exa.ai/docs/reference/search):
//   POST https://api.exa.ai/search
//   x-api-key: <key>                       (header only — never JSON or the URL)
//   { query, type: "auto", numResults: n, contents: { highlights: true } }
//   { results: [{ title, url, highlights: string[], publishedDate? }] }
//
// `type: "auto"` lets Exa pick neural/keyword per query; `highlights` is requested
// instead of full page text because the tool only emits bounded excerpts. There is
// no `score` field in the response and nothing here depends on one.
//
// Cross-references:
//   - ./request   — requestSearch, normalizeMatches, the shared bounds/errors
//   - ./index     — dispatch + key resolution

import type { WebsearchMatch } from '../../types';
import {
    excerpt,
    date,
    normalizeMatches,
    requestSearch,
    resultsArray
} from './request';
import type { MatchFields, ProviderSearch } from './request';

const ENDPOINT = 'https://api.exa.ai/search';
const LABEL = 'Exa';

export const searchExa = async (search: ProviderSearch): Promise<WebsearchMatch[]> => {
    const payload = await requestSearch({
        label: LABEL,
        endpoint: ENDPOINT,
        // The key travels in a header on purpose: headers are not logged in the
        // URL, not embedded in the body the provider may echo, and not present in
        // any redirect target (redirects are disabled by requestSearch).
        headers: { 'x-api-key': search.apiKey },
        body: {
            query: search.query,
            type: 'auto',
            // Set explicitly: the provider must not choose its own default count,
            // because the tool's bound is what keeps the model's context small.
            numResults: search.maxResults,
            contents: { highlights: true }
        }
    });

    const rows = resultsArray(payload, LABEL);

    return normalizeMatches(
        rows,
        search.maxResults,
        search.redact,
        (row): MatchFields => ({
            title: row.title,
            url: row.url,
            // Exa returns a list of highlight fragments; join them into one line.
            snippet: excerpt(row.highlights),
            published: date(row.publishedDate)
        })
    );
};
