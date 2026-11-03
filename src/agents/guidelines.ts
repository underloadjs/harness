// Shared guideline lines for the trusted profiles.
//
// WHY THESE ARE ONE SHORT STRING EACH
// -----------------------------------
// Every model request already receives its callable tools as declarations — name,
// description, parameter schema (src/harness.ts `offerDeclarations` →
// src/transport/openai.ts `tools`). So a guideline that only repeats WHICH tools exist
// duplicates the tool array, pays for the same context twice, and goes stale the moment
// a visibility or a tool name changes. What a declaration cannot say is the policy
// around it, and that is what these lines carry:
//
//   - DISCOVERY  — the catalogue is bigger than the declaration list. Searchable tools
//     are registered but not declared until toolRequest enables them (src/harness.ts
//     `visibleCoreTools` plus the enabled set), so the meta-capability has to be stated.
//     The selector's own contract — the uncapped names/regex/tags union, the
//     `maxEnabledTools` bound, newest-request precedence, `matched`/`omitted` — lives in
//     toolRequest's description and is read with that declaration, so it is deliberately
//     NOT restated here.
//   - WEB_SEARCH — the web trio is asymmetric in a way no schema states: `search` is
//     core but only registered when the host configured a key
//     (src/tools/websearch/index.ts), `fetch` is core and needs no key
//     (src/tools/webfetch/index.ts + the `webfetch: true` every live factory passes),
//     and `download` is searchable. Its absence is therefore a real answer that must
//     produce an honest statement, not invented sources.
//   - DELEGATION — `delegate` is declared to a PRIMARY only when the harness has
//     subagents, and delegation is one level deep (src/harness.ts
//     `primaryOnlyDefinitions`). One sentence therefore has to be correct for a primary,
//     a subagent, and a lone agent, which is the wording
//     ../server/harnesses/presets.test.ts pins. The valid target ids need no prose: they
//     are the `agent` enum of the declaration itself.
//   - PERMISSIONS / TOOL_CREATE — facts no schema states: nothing is sandboxed, and a
//     missing capability can be authored.
//
// A profile composes these with `agentInstruction()` (./index.ts) into its ONE system
// prompt, so one edit reaches all five real roles and the wording cannot drift. Every
// tool named below must match the visibility in src/core/tool-manifest.ts: a line that
// claims a tool is (or is not) declared is only trustworthy while the manifest says so.
//
// Cross-references:
//   - ./types.ts        — AgentProfile (instruction + guidelines)
//   - ./index.ts        — `agentInstruction()`, the composition rule
//   - ../harness.ts     — the declaration boundary this text assumes

// Tools outside the declaration list are searchable, not missing.
export const DISCOVERY_GUIDELINE =
    'Your declared tool list is not the whole catalogue: call toolRequest (exact names, a regex, or capability tags) to enable a searchable tool before concluding a capability is missing.';

// Web access is asymmetric, and only the prompt can say so honestly:
//   - `search` is `visibility: 'core'` but its ACTIVATION is `websearch`, so a
//     keyless host never registers it and it is simply absent from the declaration
//     list (src/tools/websearch/index.ts, src/server/harnesses/websearch.ts);
//   - `fetch` is core with activation `webfetch`, which every live factory turns on,
//     and its native provider needs no credential — so it IS declared even without a
//     key (src/server/harnesses/toolbox.ts sets `webfetch: true`);
//   - `download` is the only web capability that is `visibility: 'searchable'`
//     (tags include "web" and "url"), so it has to be enabled before it can be used.
// Naming all three prevents the two opposite failures: claiming a keyless host has
// search, and ignoring a fetch that is sitting in the declaration list.
export const WEB_SEARCH_GUIDELINE =
    'search is declared only when the host configured a web-search key; when it is not declared, say so instead of inventing sources. fetch is declared without a key, and download is searchable under "web" or "url".';

// One wording for all five real roles: correct for a primary, a subagent, and a lone agent.
export const DELEGATION_GUIDELINE =
    'If you are the primary agent and this harness configures subagents, delegate is declared to you: give ONE target a self-contained brief (a subagent never sees this conversation) and verify its answer. A subagent never receives delegate and cannot delegate further; otherwise do the work yourself.';

// No sandbox: side effects land on the machine running the harness.
export const PERMISSIONS_GUIDELINE =
    'File and command tools run unsandboxed with the server process permissions, so inspect before you change anything.';

// The self-extending escape hatch, one line rather than a tool manual. `toolCreate`
// is itself searchable (src/core/tool-manifest.ts), so the line states the order:
// discover it through toolRequest first, then author the missing capability.
export const TOOL_CREATE_GUIDELINE =
    'toolCreate is searchable, not declared: enable it with toolRequest before using it to add a small missing capability to this session.';
