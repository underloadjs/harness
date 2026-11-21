// Linkup adapter.
//
// Loaded by `import()` from ./index on the first `provider: "linkup"` call, so
// constructing a harness, listing tools, or searching through Exa/Tavily never
// touches this module or the network.
//
// Wire contract (https://docs.linkup.so/pages/documentation/endpoints/search/reference):
//   POST https://api.linkup.so/v1/search
//   Authorization: Bearer <key>          (header only — never JSON or the URL)
//   { q, depth: "fast", outputType: "searchResults", maxResults }
//   { results: [{ type: "text", name, url, content, favicon }] }
//
// `depth: "fast"` is the cheap tier: this tool promises a small, bounded list of
// excerpts, not a reranked deep answer, and the deeper tier costs more per call
// without changing anything the tool is allowed to show. `outputType:
// "searchResults"` asks for the structured list instead of Linkup's
// LLM-composed answer — a composed answer would be model output presented as if
// it were a search result, which is the same reason Tavily's adapter pins
// `include_answer: false`.
//
// Field mapping: `name` is Linkup's title, `content` its excerpt. The row `type`
// and `favicon` are dropped: WebSearchMatch has no place for them, and adding a
// provider-specific field would change the one shape every provider is
// normalized into. Linkup sends no publication date, so `published` is simply
// absent for this provider (normalizeMatches already treats it as optional).
//
// Cross-references:
//   - ./request   — requestSearch, normalizeMatches, the shared bounds/errors
//   - ./index     — dispatch + key resolution

import type { WebSearchMatch } from '../../types';
import { excerpt, normalizeMatches, requestSearch, resultsArray } from './request';
import type { MatchFields, ProviderSearch } from './request';

const ENDPOINT = 'https://api.linkup.so/v1/search';
const LABEL = 'Linkup';

export const searchLinkup = async (search: ProviderSearch): Promise<WebSearchMatch[]> => {
    const payload = await requestSearch({
        label: LABEL,
        endpoint: ENDPOINT,
        // The key travels in a header on purpose: headers are not logged in the
        // URL, not embedded in the body the provider may echo, and not present in
        // any redirect target (redirects are disabled by requestSearch).
        headers: { authorization: `Bearer ${search.apiKey}` },
        body: {
            // Linkup's query field is `q`, not `query`.
            q: search.query,
            depth: 'fast',
            outputType: 'searchResults',
            // Set explicitly so the provider default cannot exceed the tool bound.
            maxResults: search.maxResults
        }
    });

    const rows = resultsArray(payload, LABEL);

    return normalizeMatches(
        rows,
        search.maxResults,
        search.redact,
        (row): MatchFields => ({
            title: row.name,
            url: row.url,
            // `content` is one string (never a highlight list), but `excerpt`
            // accepts both shapes so a provider change cannot throw here.
            snippet: excerpt(row.content)
        })
    );
};
