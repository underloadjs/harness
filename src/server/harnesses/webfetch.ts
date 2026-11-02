// The catalogue view of web fetch.
//
// WHY THIS IS A SEPARATE MODULE (and why it differs from ./websearch.ts)
// ----------------------------------------------------------------------
// `fetch` is the second environment-backed core tool (R9-R11). Its activation is
// the host's `webfetch` OPT-IN, not a credential: the `native` provider needs no
// key, so `createWebFetchTool()` always returns a runnable tool (see
// ../../tools/webfetch/index.ts). The catalogue therefore needs a second axis than
// search's: `enabled` says whether this deployment asks for the tool at all, while
// `configuration` still carries the optional hosted-provider keys.
//
// This module is what makes the server's advertisement honest. `describeHarness`
// only lists an environment-backed name when the runtime catalogue carries an
// executable definition for it, and `coreToolNames` only advertises a core name
// that is registered. Before this module existed, the live preset factories
// (./toolbox.ts passes `webfetch: true`) registered AND declared `fetch`, while no
// catalogue entry could see it — so a card advertised a core declaration it never
// showed. The entry below closes that gap.
//
// Like search, the entry is ALWAYS listed. A host that has not opted into webfetch
// sees `availability: 'unconfigured'` plus the actionable hint instead of a silent
// absence, and it gets no `tool`, so nothing can call a provider it never enabled.
//
// No key ever appears in the entry, the hint, or the environment list (names
// only): the credential stays inside the tool closure built by createWebFetchTool.
//
// Cross-references:
//   - ../../tools/webfetch/index.ts       — createWebFetchTool + WEB_FETCH_METADATA
//   - ../harnesses                        — createToolCatalogue, the runtime builder
//   - ./descriptor.ts                     — registered / coreTools projection
//   - ./toolbox.ts                        — CORE_ENVIRONMENT_TOOL_NAMES + `webfetch: true`
//   - ../../tools/runtime/fetch.tool.ts   — the discovery row (same visibility)

import { createWebFetchTool, WEB_FETCH_METADATA, WEB_FETCH_TOOL_NAME } from '../../harness';
import type { Tool, WebFetchConfiguration } from '../../harness';
import type { CatalogueEntry, ToolAvailability } from './types';

// Variable names only, for the two hosted providers `fetch` can use. The `native`
// provider needs no key, so a keyless host still runs the tool — these names are
// the *optional* upgrades, advertised so an operator knows what would widen it.
export const WEBFETCH_ENVIRONMENT = ['EXA_API_KEY', 'LINKUP_API_KEY'] as const;

// One sentence, safe to render anywhere. It names the setting, never a value, and
// says a restart is required because webfetch is resolved once per harness.
export const WEBFETCH_UNCONFIGURED_HINT =
    'Web fetch is not enabled on this server. Set `webfetch: true` (optionally with EXA_API_KEY or LINKUP_API_KEY for a hosted provider) and restart the harness server; the native provider needs no key.';

export type WebFetchCatalogueOptions = {
    // Whether this deployment asks for the tool at all. Defaults to enabled, which
    // is what the shipped preset factories do (./toolbox.ts passes `webfetch: true`
    // for every live harness). A host that never opts into webfetch passes
    // `enabled: false` and gets the listed-but-not-callable state.
    enabled?: boolean;
    // Forwarded to createWebFetchTool: `env` or explicit provider keys. The default
    // is `process.env`, read when this function runs (never at import).
    configuration?: WebFetchConfiguration;
};

// The configured tool (if any) and the always-present catalogue entry.
export type WebFetchCatalogueEntry = {
    entry: CatalogueEntry;
    tool?: Tool;
};

const availabilityOf = (enabled: boolean): ToolAvailability =>
    enabled
        ? { state: 'available', environment: [...WEBFETCH_ENVIRONMENT] }
        : {
              state: 'unconfigured',
              environment: [...WEBFETCH_ENVIRONMENT],
              hint: WEBFETCH_UNCONFIGURED_HINT
          };

export const createWebFetchCatalogueEntry = (
    options: WebFetchCatalogueOptions = {}
): WebFetchCatalogueEntry => {
    const enabled = options.enabled !== false;

    // Read the environment now, not at import: same rule as websearch, because the
    // server loads `.env` after its imports. An invalid explicit credential still
    // throws (HarnessError) rather than becoming a silently disabled entry.
    const tool = enabled ? createWebFetchTool(options.configuration ?? {}) : undefined;

    // Copy metadata out of the tool when enabled so the descriptor and the callable
    // definition cannot disagree. When disabled, WEB_FETCH_METADATA is the same
    // native-shaped copy without an execute function or a credential.
    const entry: CatalogueEntry = tool
        ? {
              name: tool.name,
              group: 'Web fetch',
              tool,
              description: tool.description,
              tags: [...tool.tags],
              // The factory carries `core` visibility (R9-R11): a host that enabled
              // webfetch declares fetch on every request, so the advertisement and
              // the declaration come from the same object.
              visibility: tool.visibility,
              parameters: tool.parameters ?? { type: 'object', properties: {} },
              availability: availabilityOf(enabled)
          }
        : {
              name: WEB_FETCH_TOOL_NAME,
              group: 'Web fetch',
              description: WEB_FETCH_METADATA.description,
              tags: [...WEB_FETCH_METADATA.tags],
              visibility: WEB_FETCH_METADATA.visibility,
              parameters: WEB_FETCH_METADATA.parameters,
              availability: availabilityOf(enabled)
          };

    return tool === undefined ? { entry } : { entry, tool };
};
