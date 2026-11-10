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
//   - DELEGATION — the declaration already states the GATE ("only the primary agent can
//     delegate, subagents cannot delegate further, registered only when the harness has
//     subagents" — src/tools/runtime/delegate.tool.ts, and src/harness.ts
//     `primaryOnlyDefinitions` + the `subagents` activation), and the valid target ids are
//     the `agent` enum of the declaration itself. So this line carries only what the
//     schema cannot say: self-contained briefs, caller-owned verification, and follow-up
//     delegations continuing the same child conversation. It is still one sentence that
//     has to read correctly for a primary, a subagent, and a lone agent, and
//     ../server/harnesses/presets.test.ts pins that wording.
//   - PERMISSIONS / TOOL_CREATE — facts no schema states: nothing is sandboxed, and a
//     missing capability can be authored.
//   - READ_ONLY — `AgentConfiguration` has no tool list, so no profile can DENY
//     write/edit (src/types/index.ts); "change nothing" is a policy the agent follows, and
//     it must say how a change stays honest when a brief does authorise one.
//
// A profile composes these with `agentInstruction()` (./index.ts) into its ONE system
// prompt, so one edit reaches every role that uses the line and the wording cannot drift.
// Not every role composes every line — ./general.ts has no delegation line because that
// harness configures no subagents at all, and ./research.ts + ./reviewer.ts carry
// READ_ONLY while the build roles do not — and every tool named below must match the
// visibility in src/core/tool-manifest.ts: a line that claims a tool is (or is not)
// declared is only trustworthy while the manifest says so.
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

// One wording for every role that MAY delegate. The gate itself is already declared:
// `delegate`'s own description states "Only the primary agent can delegate, subagents
// cannot delegate further, and a harness registers this tool only when it has subagents"
// (src/tools/runtime/delegate.tool.ts), and its `agent` enum IS the session allowlist
// (src/harness.ts:2962-2976). What no schema can say is the three policies below, so this
// line now carries ONLY those:
//   1. a brief must be SELF-CONTAINED, because the child starts with no knowledge of the
//      parent conversation (src/core/thread.ts — the agent thread accumulates per target);
//   2. the caller OWNS the verification — a child's "done" is a claim (see
//      ./planner.ts, which turns this into a per-step review);
//   3. a FOLLOW-UP delegation continues the same child conversation, so a vague first
//      brief is not fatal — asking again is cheaper than guessing.
// It reads correctly for a primary (it has the tool), a subagent (it never does), and a
// lone agent (`subagents: []` means the row is not even registered, src/harness.ts:1101-1103).
export const DELEGATION_GUIDELINE =
    'When you delegate, give ONE target a self-contained brief because a subagent never sees this conversation, verify its answer before relying on it, and follow up with the same target instead of guessing: a later delegation continues that subagent\'s conversation.';

// No sandbox: side effects land on the machine running the harness.
export const PERMISSIONS_GUIDELINE =
    'File and command tools run unsandboxed with the server process permissions, so inspect before you change anything.';

// READ-ONLY POLICY — shared by the two roles whose OUTPUT is a report, not a diff
// (explore ./research.ts and reviewer ./reviewer.ts).
//
// WHY THIS IS PROSE AND NOT A DENIAL: `AgentConfiguration` carries no tool list
// (src/types/index.ts) — no profile can refuse `write`/`edit`, and every live harness
// registers the identical toolbox (src/server/harnesses/toolbox.ts
// `createToolboxHarness`). The per-run `scope.tools` allowlist belongs to the CALLER of
// `delegate` (src/tools/runtime/delegate.tool.ts), not to the profile. So "do not change
// anything" can only be a policy line the agent follows, and one line has to cover both
// the primary case (it chooses not to write) and the subagent case (a caller may still
// hand it a scoped toolbox).
//
// The authorisation clause is what keeps the line honest: a brief that DOES ask for a
// fix must produce the fix, not a refusal, so the ban lifts and the change must then be
// reported.
export const READ_ONLY_GUIDELINE =
    'You are read-only unless the brief authorises a change: create nothing, edit nothing, delete nothing, run no command that changes state. When a change IS authorised, keep it minimal and say what you changed.';

// The self-extending escape hatch, one line rather than a tool manual. `toolCreate`
// is itself searchable (src/core/tool-manifest.ts), so the line states the order:
// discover it through toolRequest first, then author the missing capability.
export const TOOL_CREATE_GUIDELINE =
    'toolCreate is searchable, not declared: enable it with toolRequest before using it to add a small missing capability to this session.';
