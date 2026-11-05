// The runtime direct-call catalogue.
//
// These tests pin the C1 contract for the two environment-backed core tools:
// `search` and `fetch` are ALWAYS listed, each is executable only when its own
// gate resolved (a provider key for search, the `webfetch` opt-in for fetch), and no
// key value ever enters an entry. They also prove the catalogue is built at call
// time (not module evaluation), which is what makes `.env` startup ordering safe.
//
// Every assertion is exact: catalogue order, availability objects, metadata, and
// the complete schema. No network and no host environment: the keyed entries use
// an injected environment, and the default-entry tests stub process.env.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_FETCH_METADATA, WEB_SEARCH_METADATA } from '../../harness';
import { createToolCatalogue, describeHarness, findPreset } from './index';
import {
    createWebSearchCatalogueEntry,
    WEBSEARCH_ENVIRONMENT,
    WEBSEARCH_UNCONFIGURED_HINT
} from './websearch';
import {
    createWebFetchCatalogueEntry,
    WEBFETCH_ENVIRONMENT,
    WEBFETCH_UNCONFIGURED_HINT
} from './webfetch';

const TAGS = ['web', 'search', 'internet', 'news', 'research'];

// The schema a keyless host renders. It is the configured schema minus the
// provider property: there is no legal provider to choose from.
const UNCONFIGURED_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'What to search for, e.g. "harness tool discovery".' },
        maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description:
                'How many results to return. Defaults to 5; larger values are clamped to 20.'
        },
        // The provider filters are part of the tool, not of a provider, so a
        // keyless host lists them too: the listing describes the schema a host
        // would run, and it must not drift from the configured one.
        includeDomains: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description: 'Only return results from these domains (hostnames, no scheme). Up to 20.'
        },
        excludeDomains: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description: 'Never return results from these domains. Up to 20.'
        },
        since: {
            type: 'string',
            description: 'Only results published on or after this ISO-8601 date, e.g. "2026-01-01".'
        },
        until: {
            type: 'string',
            description: 'Only results published on or before this ISO-8601 date.'
        },
        category: {
            type: 'string',
            maxLength: 64,
            description: 'Source category to favour, e.g. "news", "company", "publication" or "people".'
        },
        speed: {
            type: 'string',
            enum: ['balanced', 'fast'],
            description:
                '"fast" asks the provider for its low-latency, lower-cost mode (results come from its index rather than live page fetches). Defaults to "balanced".'
        }
    },
    required: ['query'],
    additionalProperties: false
};

const keyless = () => createWebSearchCatalogueEntry({ configuration: { env: {} } });

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('tool catalogue', () => {
    it('lists search with exact keyless metadata when no provider is configured', () => {
        const catalogue = createToolCatalogue({ websearch: keyless() });
        const entry = catalogue.find('search');

        // Always listed, first because a client has to be able to discover it.
        expect(entry).toBeDefined();
        expect(entry).toEqual({
            name: 'search',
            group: 'Web search',
            description: WEB_SEARCH_METADATA.description,
            tags: TAGS,
            visibility: 'core',
            parameters: UNCONFIGURED_PARAMETERS,
            availability: {
                state: 'unconfigured',
                environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY'],
                hint: WEBSEARCH_UNCONFIGURED_HINT
            }
        });

        // No definition means nothing can execute it — listed is not callable.
        expect(entry?.tool).toBeUndefined();
        expect(catalogue.tools.search).toBeUndefined();
    });

    it('exposes the configured tool, availability, and no secret in the entry', () => {
        const catalogue = createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({
                configuration: { env: { EXA_API_KEY: 'exa-secret-key' } }
            })
        });
        const entry = catalogue.find('search');

        expect(entry?.tool).toBeDefined();
        expect(entry?.tool).toBe(catalogue.tools.search);
        expect(entry?.group).toBe('Web search');
        expect(entry?.description).toBe(entry?.tool?.description);
        expect(entry?.tags).toEqual(TAGS);
        expect(entry?.visibility).toBe('core');
        expect(entry?.parameters).toBe(entry?.tool?.parameters);
        expect(entry?.availability).toEqual({
            state: 'available',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY']
        });

        // Only a single key is configured, so no provider choice is offered — but
        // the filter arguments are, and they match the keyless listing above.
        const properties = (entry?.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(Object.keys((UNCONFIGURED_PARAMETERS.properties as Record<string, unknown>)));

        // The credential lives in the tool closure; the catalogue is safe to log.
        expect(JSON.stringify(catalogue.entries)).not.toContain('exa-secret-key');
        expect(JSON.stringify(entry?.availability)).not.toContain('exa-secret-key');
    });

    it('keeps the preset and harness groups intact, then appends the web pair', () => {
        const catalogue = createToolCatalogue({ websearch: keyless() });

        expect(catalogue.entries.map((entry) => entry.name)).toEqual([
            'syntax',
            'read',
            'write',
            'edit',
            'fileList',
            'glob',
            'grep',
            'shell',
            'gitDiff',
            'download',
            'timeNow',
            'textCount',
            'diceRoll',
            'noteSearch',
            'textSummarize',
            'testFlaky',
            'search',
            // R9-R11: the fetch entry rides with search. It is the second half of the
            // environment-backed core pair, so a card can only advertise the
            // declaration its harness will really make because this entry exists.
            'fetch'
        ]);

        // Existing tools keep working exactly as before; only the two web rows carry
        // availability, so a client that ignores the field sees no change.
        expect(catalogue.tools.timeNow).toBeDefined();
        expect(catalogue.find('timeNow')?.availability).toBeUndefined();
        expect(catalogue.find('search')?.availability?.state).toBe('unconfigured');
        // Fetch needs no key: the default entry is executable (native provider).
        expect(catalogue.find('fetch')?.availability?.state).toBe('available');
        expect(catalogue.tools.fetch).toBeDefined();
    });

    it('advertises fetch on a live card only while the catalogue can run it', () => {
        // The exact pairing R9-R11 needs: a card's advertised core set must equal the
        // declarations its harness makes. `fetch` is declared whenever the toolbox
        // opts into webfetch (every live preset does), so the card advertises it only
        // when this catalogue carries an executable definition.
        const keylessSearch = createWebSearchCatalogueEntry({ configuration: { env: {} } });
        const instruct = findPreset('instruct');
        expect(instruct).toBeDefined();

        const enabled = describeHarness(instruct!, createToolCatalogue({ websearch: keylessSearch }));
        // Keyless search never registers, so the only advertised web row is fetch.
        expect(enabled.coreTools).toEqual([
            'toolRequest',
            'task',
            'delegate',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'fetch'
        ]);
        expect(enabled.tools).toContain('fetch');

        const disabled = describeHarness(
            instruct!,
            createToolCatalogue({
                websearch: keylessSearch,
                webfetch: createWebFetchCatalogueEntry({ enabled: false })
            })
        );
        // The entry is still LISTED in the global catalogue (an actionable
        // 'unconfigured' state), but no card claims a tool it cannot run.
        expect(disabled.coreTools).not.toContain('fetch');
        expect(disabled.tools).not.toContain('fetch');
        expect(
            createToolCatalogue({
                websearch: keylessSearch,
                webfetch: createWebFetchCatalogueEntry({ enabled: false })
            })
                .find('fetch')
                ?.availability?.state
        ).toBe('unconfigured');
    });

    it('lists fetch as unconfigured, with the native metadata and no callable tool', () => {
        const catalogue = createToolCatalogue({
            websearch: keyless(),
            webfetch: createWebFetchCatalogueEntry({ enabled: false })
        });

        expect(catalogue.find('fetch')).toEqual({
            name: 'fetch',
            group: 'Web fetch',
            description: WEB_FETCH_METADATA.description,
            tags: [...WEB_FETCH_METADATA.tags],
            // Core either way: the visibility is the capability's policy, the
            // availability says whether THIS host can run it today.
            visibility: 'core',
            parameters: WEB_FETCH_METADATA.parameters,
            availability: {
                state: 'unconfigured',
                environment: [...WEBFETCH_ENVIRONMENT],
                hint: WEBFETCH_UNCONFIGURED_HINT
            }
        });
        expect(catalogue.tools.fetch).toBeUndefined();

        // A credential is never part of the listing.
        const keyed = createToolCatalogue({
            websearch: keyless(),
            webfetch: createWebFetchCatalogueEntry({ configuration: { env: { EXA_API_KEY: 'exa-secret-key' } } })
        });
        expect(JSON.stringify(keyed.entries)).not.toContain('exa-secret-key');
        expect(
            Object.keys((keyed.find('fetch')?.parameters as { properties: Record<string, unknown> }).properties)
        ).toEqual(['url', 'format', 'query', 'offset', 'provider']);
    });

    it('reads the environment when built, not when the module was imported', () => {
        // The module was imported at the top of this file, before these stubs.
        // A module-level search singleton would have captured nothing; a
        // runtime factory sees the key and builds the executable tool.
        vi.stubEnv('EXA_API_KEY', 'runtime-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        // Stubbed too, so a Linkup key in the machine/.env environment cannot
        // change which providers this catalogue offers.
        vi.stubEnv('LINKUP_API_KEY', '');

        const catalogue = createToolCatalogue();

        expect(catalogue.tools.search).toBeDefined();
        expect(catalogue.find('search')?.availability).toEqual({
            state: 'available',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY']
        });
        expect(JSON.stringify(catalogue.entries)).not.toContain('runtime-exa-key');
    });

    it('defaults to keyless when every provider variable is blank', () => {
        vi.stubEnv('EXA_API_KEY', '   ');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '  ');

        const catalogue = createToolCatalogue();

        expect(catalogue.tools.search).toBeUndefined();
        expect(catalogue.find('search')?.availability).toEqual({
            state: 'unconfigured',
            environment: [...WEBSEARCH_ENVIRONMENT],
            hint: WEBSEARCH_UNCONFIGURED_HINT
        });
    });
});
