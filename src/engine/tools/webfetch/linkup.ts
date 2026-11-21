// fetch `linkup` provider — page content through Linkup's /v1/fetch endpoint.
//
// Loaded by `import()` from ./index on the first `provider: "linkup"` call, so
// constructing a harness, fetching a native page, or using the `exa` provider
// never touches this module or the network.
//
// Wire contract (https://docs.linkup.so/pages/documentation/endpoints/fetch/reference):
//   POST https://api.linkup.so/v1/fetch
//   Authorization: Bearer <key>          (header only — never JSON or the URL)
//   { url }
//   { markdown, favicon }
//
// Linkup renders the page server-side and answers with markdown, so this is the
// same higher-quality path as `exa`: it costs API credits, which is why `native`
// stays the default and this provider is opt-in per call. The response has no
// title field, so `title` is simply absent (./index reports the page's own
// content type as `text/markdown`).
//
// There is no server-side character knob on this endpoint, so the character
// bound is applied once, locally, in ./index — unlike the Exa adapter, which can
// ask for `text.maxCharacters`. The request still reuses ../websearch/request's
// `requestSearch`: same fixed endpoint policy, same no-redirect rule, same
// streaming byte budget, same sanitized status errors. The label is "Linkup", so
// a failure reads "Linkup search ..." — the provider-error vocabulary the Exa
// fetch adapter already uses for its hosted call.
//
// Cross-references:
//   - ../websearch/request — requestSearch, excerpt, the shared bounds/errors
//   - ./exa                — the sibling hosted adapter
//   - ./index              — dispatch + key resolution + the character bound

import { HarnessError } from '../../util';
import { excerpt, requestSearch } from '../websearch/request';

const ENDPOINT = 'https://api.linkup.so/v1/fetch';
const LABEL = 'Linkup';

export type LinkupFetch = (fetch: {
    url: string;
    apiKey: string;
}) => Promise<{ content: string; title?: string }>;

export const fetchLinkup: LinkupFetch = async ({ url, apiKey }) => {
    const payload = await requestSearch({
        label: LABEL,
        endpoint: ENDPOINT,
        // The key travels in a header on purpose: headers are not logged in the
        // URL and not present in any redirect target (redirects are disabled by
        // requestSearch).
        headers: { authorization: `Bearer ${apiKey}` },
        body: { url }
    });

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HarnessError('Linkup fetch returned an unexpected response.');
    }

    // `markdown` is the document; `favicon` is an icon URL with no place in a
    // WebFetchResult, so it is dropped rather than echoed as content.
    const content = excerpt((payload as Record<string, unknown>).markdown);

    if (content.trim().length === 0) {
        // An empty markdown is Linkup's "could not read that page" answer, and the
        // provider body is never quoted (it can echo the request or an account
        // name), so this is one fixed sentence.
        throw new HarnessError('Linkup could not fetch that page.');
    }

    return { content };
};
