// The runtime direct-call catalogue.
//
// These tests pin the C1 contract: websearch is ALWAYS listed, is executable
// only when a provider key was resolved at catalogue-build time, and never puts a
// key value into an entry. They also prove the catalogue is built at call time
// (not module evaluation), which is what makes `.env` startup ordering safe.
//
// Every assertion is exact: catalogue order, availability objects, metadata, and
// the complete schema. No network and no host environment: the keyed entries use
// an injected environment, and the default-entry tests stub process.env.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBSEARCH_METADATA } from '../src/harness';
import { createToolCatalogue } from './index';
import {
    createWebsearchCatalogueEntry,
    WEBSEARCH_ENVIRONMENT,
    WEBSEARCH_UNCONFIGURED_HINT
} from './websearch';

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
        }
    },
    required: ['query'],
    additionalProperties: false
};

const keyless = () => createWebsearchCatalogueEntry({ configuration: { env: {} } });

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('tool catalogue', () => {
    it('lists websearch with exact keyless metadata when no provider is configured', () => {
        const catalogue = createToolCatalogue({ websearch: keyless() });
        const entry = catalogue.find('websearch');

        // Always listed, first because a client has to be able to discover it.
        expect(entry).toBeDefined();
        expect(entry).toEqual({
            name: 'websearch',
            group: 'Web search',
            description: WEBSEARCH_METADATA.description,
            tags: TAGS,
            visibility: 'searchable',
            parameters: UNCONFIGURED_PARAMETERS,
            availability: {
                state: 'unconfigured',
                environment: ['EXA_API_KEY', 'TAVILY_API_KEY'],
                hint: WEBSEARCH_UNCONFIGURED_HINT
            }
        });

        // No definition means nothing can execute it — listed is not callable.
        expect(entry?.tool).toBeUndefined();
        expect(catalogue.tools.websearch).toBeUndefined();
    });

    it('exposes the configured tool, availability, and no secret in the entry', () => {
        const catalogue = createToolCatalogue({
            websearch: createWebsearchCatalogueEntry({
                configuration: { env: { EXA_API_KEY: 'exa-secret-key' } }
            })
        });
        const entry = catalogue.find('websearch');

        expect(entry?.tool).toBeDefined();
        expect(entry?.tool).toBe(catalogue.tools.websearch);
        expect(entry?.group).toBe('Web search');
        expect(entry?.description).toBe(entry?.tool?.description);
        expect(entry?.tags).toEqual(TAGS);
        expect(entry?.visibility).toBe('searchable');
        expect(entry?.parameters).toBe(entry?.tool?.parameters);
        expect(entry?.availability).toEqual({
            state: 'available',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY']
        });

        // Only a single key is configured, so no provider choice is offered.
        const properties = (entry?.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['query', 'maxResults']);

        // The credential lives in the tool closure; the catalogue is safe to log.
        expect(JSON.stringify(catalogue.entries)).not.toContain('exa-secret-key');
        expect(JSON.stringify(entry?.availability)).not.toContain('exa-secret-key');
    });

    it('keeps the preset and harness groups intact, then appends web search', () => {
        const catalogue = createToolCatalogue({ websearch: keyless() });

        expect(catalogue.entries.map((entry) => entry.name)).toEqual([
            'syntaxCheck',
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'searchFiles',
            'globFiles',
            'runCommand',
            'gitDiff',
            'clock',
            'wordCount',
            'roll',
            'searchNotes',
            'summarize',
            'flaky',
            'websearch'
        ]);

        // Existing tools keep working exactly as before; only websearch carries
        // availability, so a client that ignores the field sees no change.
        expect(catalogue.tools.clock).toBeDefined();
        expect(catalogue.find('clock')?.availability).toBeUndefined();
        expect(catalogue.find('websearch')?.availability?.state).toBe('unconfigured');
    });

    it('reads the environment when built, not when the module was imported', () => {
        // The module was imported at the top of this file, before these stubs.
        // A module-level websearch singleton would have captured nothing; a
        // runtime factory sees the key and builds the executable tool.
        vi.stubEnv('EXA_API_KEY', 'runtime-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        const catalogue = createToolCatalogue();

        expect(catalogue.tools.websearch).toBeDefined();
        expect(catalogue.find('websearch')?.availability).toEqual({
            state: 'available',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY']
        });
        expect(JSON.stringify(catalogue.entries)).not.toContain('runtime-exa-key');
    });

    it('defaults to keyless when both provider variables are blank', () => {
        vi.stubEnv('EXA_API_KEY', '   ');
        vi.stubEnv('TAVILY_API_KEY', '');

        const catalogue = createToolCatalogue();

        expect(catalogue.tools.websearch).toBeUndefined();
        expect(catalogue.find('websearch')?.availability).toEqual({
            state: 'unconfigured',
            environment: [...WEBSEARCH_ENVIRONMENT],
            hint: WEBSEARCH_UNCONFIGURED_HINT
        });
    });
});
