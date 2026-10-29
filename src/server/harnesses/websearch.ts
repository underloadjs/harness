// The catalogue view of web search.
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// A search tool needs a provider key, so unlike a preset it cannot be constructed
// at module evaluation: `src/server/start.ts` and `src/server/cli/index.ts` load `.env` after
// their imports, and a module-level factory would capture an empty environment.
// `createWebSearchCatalogueEntry()` is therefore called at runtime, once per
// catalogue, after the environment is ready.
//
// The entry is always listed — configured or not. That is the point of C1: a host
// that has no key should see *why* web search is unavailable instead of wondering
// whether the capability exists. Only the configured case carries a `tool`; the
// unconfigured case carries static metadata plus a non-secret hint.
//
// No key ever appears in the entry, the hint, the environment list (names only),
// or a descriptor: the credential stays inside the tool closure built by
// createWebSearchTool (see src/tools/websearch/index.ts).
//
// Cross-references:
//   - ../src/tools/websearch/index.ts — createWebSearchTool + WEB_SEARCH_METADATA
//   - ./index                          — createToolCatalogue, the runtime builder
//   - ../handler.ts             — GET /api/tools, POST /api/tools/:name
//   - ../src/frontend/main.ts        — disabled/configured rendering

import { createWebSearchTool, WEB_SEARCH_METADATA, WEB_SEARCH_TOOL_NAME } from '../../harness';
import type { Tool, WebsearchConfiguration } from '../../harness';
import type { CatalogueEntry, ToolAvailability } from './types';

// Variable names only. These are advertised to the UI/CLI so an operator knows
// what to set; the values are never read here (createWebSearchTool reads them).
export const WEBSEARCH_ENVIRONMENT = ['EXA_API_KEY', 'TAVILY_API_KEY'] as const;

// One sentence, safe to render anywhere. It names variables, never values, and
// says that a restart is required because search keys are captured once when a
// harness (or this entry) is constructed.
export const WEBSEARCH_UNCONFIGURED_HINT =
    'Web search is not configured on this server. Set EXA_API_KEY or TAVILY_API_KEY in packages/underload/harness/.env (or the process environment) and restart the harness server.';

export type WebSearchCatalogueOptions = {
    // Forwarded to createWebSearchTool. Tests (and hosts with a secret store)
    // pass `env` or explicit keys here; the default is `process.env`, read when
    // this function runs.
    configuration?: WebsearchConfiguration;
};

// The configured tool (if any) and the always-present catalogue entry.
export type WebSearchCatalogueEntry = {
    entry: CatalogueEntry;
    tool?: Tool;
};

const availabilityOf = (tool: Tool | undefined): ToolAvailability =>
    tool === undefined
        ? {
              state: 'unconfigured',
              environment: [...WEBSEARCH_ENVIRONMENT],
              hint: WEBSEARCH_UNCONFIGURED_HINT
          }
        : { state: 'available', environment: [...WEBSEARCH_ENVIRONMENT] };

export const createWebSearchCatalogueEntry = (
    options: WebSearchCatalogueOptions = {}
): WebSearchCatalogueEntry => {
    // Read the environment now, not at import. An invalid explicit credential is a
    // configuration bug and still throws (HarnessError) rather than becoming a
    // silently disabled entry.
    const tool = createWebSearchTool(options.configuration ?? {});

    // Copy metadata out of the tool when configured so a descriptor and the
    // callable definition cannot disagree. When unconfigured, WEB_SEARCH_METADATA
    // provides the same shape without an execute function or a credential.
    const entry: CatalogueEntry = tool
        ? {
              name: tool.name,
              group: 'Web search',
              tool,
              description: tool.description,
              tags: [...tool.tags],
              visibility: tool.visibility,
              parameters: tool.parameters ?? { type: 'object', properties: {} },
              availability: availabilityOf(tool)
          }
        : {
              name: WEB_SEARCH_TOOL_NAME,
              group: 'Web search',
              description: WEB_SEARCH_METADATA.description,
              tags: [...WEB_SEARCH_METADATA.tags],
              visibility: WEB_SEARCH_METADATA.visibility,
              parameters: WEB_SEARCH_METADATA.parameters,
              availability: availabilityOf(tool)
          };

    return tool === undefined ? { entry } : { entry, tool };
};
