// Tavily adapter.
//
// Loaded by `import()` from ./index on the first `search` call, so constructing
// a harness or listing tools never touches this module or the network.
//
// Wire contract (https://docs.tavily.com/documentation/api-reference/endpoint/search):
//   POST https://api.tavily.com/search
//   Authorization: Bearer <key>            (header only — never JSON or the URL)
//   { query, max_results: n, search_depth: "basic", include_answer: false,
//     include_raw_content: false }
//   { results: [{ title, url, content, score?, published_date? }] }
//
// The answer and raw-content switches are pinned to false: the tool returns
// excerpts only, and a provider-generated answer would be model output presented
// as if it were a search result. There is no retry and no `search_depth: advanced`
// upgrade — both would raise cost without being asked for.
//
// Cross-references:
//   - ./request   — requestSearch, normalizeMatches, the shared bounds/errors
//   - ./index     — dispatch + key resolution

import type { WebSearchMatch } from '../../types';
import {
    excerpt,
    date,
    normalizeMatches,
    requestSearch,
    resultsArray
} from './request';
import type { MatchFields, ProviderSearch } from './request';

const ENDPOINT = 'https://api.tavily.com/search';
const LABEL = 'Tavily';

export const searchTavily = async (search: ProviderSearch): Promise<WebSearchMatch[]> => {
    const payload = await requestSearch({
        label: LABEL,
        endpoint: ENDPOINT,
        headers: { authorization: `Bearer ${search.apiKey}` },
        body: {
            query: search.query,
            // Set explicitly so the provider default cannot exceed the tool bound.
            max_results: search.maxResults,
            // `basic` is already Tavily's cheap tier (`advanced` reranks and costs
            // more), so `speed: "fast"` changes nothing here — stated rather than
            // written as a no-op ternary that would read like a bug.
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            // Snake_case field names are Tavily's own. Sent only when supplied.
            ...(search.includeDomains ? { include_domains: search.includeDomains } : {}),
            ...(search.excludeDomains ? { exclude_domains: search.excludeDomains } : {}),
            ...(search.since ? { start_date: search.since } : {}),
            ...(search.until ? { end_date: search.until } : {})
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
            snippet: excerpt(row.content),
            published: date(row.published_date)
        })
    );
};
