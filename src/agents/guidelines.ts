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
//     `offerDeclarations` :6063 builds the list from `declared()` :6010, whose core half
//     comes from `visibleCoreTools` :2563 plus the per-turn enabled searchable set), so the
//     meta-capability has to be stated.
//     The selector's own contract — the uncapped names/regex/tags union, the
//     `maxEnabledTools` bound, newest-request precedence, `matched`/`omitted` — lives in
//     toolRequest's description and is read with that declaration, so it is deliberately
//     NOT restated here.
//   - WEB_SEARCH — the web trio is asymmetric in a way no schema states: `search` is
//     core but only registered when the host configured a key
//     (src/tools/websearch/index.ts), `fetch` is core and needs no key
//     (src/tools/webfetch/index.ts + the `webfetch` flag every live factory passes —
//     src/server/harnesses/toolbox.ts:746 `webfetch: useSharedToolbox`, true unless the
//     caller opts out of the shared toolbox at :693), and `download` is searchable. Its
//     absence is therefore a real answer that must
//     produce an honest statement, not invented sources.
//   - DELEGATION — the declaration already states the GATE ("Delegation follows the harness
//     RANK model: you may delegate only to an agent ranked strictly below you (a Rank A agent
//     may delegate to Rank B and below), a same-rank or a higher-rank target is refused with an
//     error naming your rank and the legal targets, and a harness registers this tool only
//     while at least one of its agents has a lower-ranked peer" — src/tools/runtime/
//     delegate.tool.ts:139, and src/harness.ts' `delegation` activation arm :1712 +
//     `rosterHasDelegation()` :1579), and the valid target ids are the `agent`
//     enum of the declaration itself, which is projected onto the CALLER's own legal set. So
//     this line carries only what the schema cannot say: self-contained briefs,
//     caller-owned verification, and follow-up delegations continuing the same child
//     conversation. It is still one sentence that has to read correctly for a Rank A agent
//     with a team, a junior agent that also has juniors, and an agent with nobody below
//     it, and ../server/harnesses/presets.test.ts:272 pins that wording.
//   - PERMISSIONS / TOOL_CREATE — facts no schema states: nothing is sandboxed, and a
//     missing capability can be authored.
//   - READ_ONLY — `AgentConfiguration` has no tool list, so no profile can DENY
//     write/edit (src/types/index.ts); "change nothing" is a policy the agent follows, and
//     it must say how a change stays honest when a brief does authorise one.
//
// A profile composes these with `agentInstruction()` (./index.ts) into its ONE system
// prompt, so one edit reaches every role that uses the line and the wording cannot drift.
// Not every role composes every line — ./general.ts has no delegation line because that
// harness has nobody ranked below its entry agent, and ./research.ts + ./reviewer.ts carry
// READ_ONLY while the build roles do not — and every tool named below must match the
// visibility in src/core/tool-manifest.ts: a line that claims a tool is (or is not)
// declared is only trustworthy while the manifest says so.
//
// Cross-references:
//   - ./types.ts        — AgentProfile (instruction + guidelines)
//   - ./index.ts        — `agentInstruction()`, the composition rule
//   - ../harness.ts     — the declaration boundary this text assumes

// Tools outside the declaration list are searchable, not missing.
//
// CONDITIONAL ON PURPOSE (`when toolRequest is in it`): the user of a conversation can now
// switch ANY registered name off for its agents (../harness.ts `withheldTools` :2346, read at
// the declaration boundary by `visibleCoreTools` :2563), and a
// switched-off `toolRequest` is not declared at all — so an unconditional "call
// toolRequest" line would send that model hunting for a tool it was never given, which is
// the failure this line exists to prevent. Same reasoning as ./guidelines.ts's web line:
// a prompt may only name a tool the declaration boundary actually hands over.
export const DISCOVERY_GUIDELINE =
    'Your declared tool list is not the whole catalogue: when toolRequest is in it, call it (exact names, a regex, or capability tags) to enable a searchable tool before concluding a capability is missing.';

// Web access is asymmetric, and only the prompt can say so honestly:
//   - `search` is `visibility: 'core'` but its ACTIVATION is `websearch`, so a
//     keyless host never registers it and it is simply absent from the declaration
//     list (src/tools/websearch/index.ts, src/server/harnesses/websearch.ts);
//   - `fetch` is core with activation `webfetch`, which every live factory turns on,
//     and its native provider needs no credential — so it IS declared even without a
//     key (src/server/harnesses/toolbox.ts:746 passes `webfetch: useSharedToolbox`, and
//     that flag is true for every factory that does not opt out of the shared toolbox
//     at :693);
//   - `download` is the only web capability that is `visibility: 'searchable'`
//     (tags include "web" and "url"), so it has to be enabled before it can be used.
// Naming all three prevents the two opposite failures: claiming a keyless host has
// search, and ignoring a fetch that is sitting in the declaration list.
export const WEB_SEARCH_GUIDELINE =
    'search is declared only when the host configured a web-search key; when it is not declared, say so instead of inventing sources. fetch is declared without a key, and download is searchable under "web" or "url".';

// One wording for every role that MAY delegate. The gate itself is already declared:
// `delegate`'s own description states the rank rule — verbatim, from the zero-allowlist
// literal in src/tools/runtime/delegate.tool.ts:139: "Delegation follows the harness RANK
// model: you may delegate only to an agent ranked strictly below you (a Rank A agent may
// delegate to Rank B and below), a same-rank or a higher-rank target is refused with an error
// naming your rank and the legal targets, and a harness registers this tool only while at
// least one of its agents has a lower-ranked peer" — and its `agent` enum IS the caller's own
// legal target set, projected per agent by `delegateDeclarationFor` (src/harness.ts:2623,
// applied per request inside `offerDeclarations` :6079 and reported to discovery by
// `declaredForDiscovery` :2640). What no
// schema can say is the three policies below, so this line now carries ONLY those:
//   1. a brief must be SELF-CONTAINED, because the child starts with no knowledge of the
//      parent conversation, and (since 0028) no knowledge of the previous child either —
//      a delegation from a conversation mints its own transcript (src/harness.ts:14589-14593,
//      the delegation thread header);
//   2. the caller OWNS the verification — a child's "done" is a claim (see
//      ./planner.ts, which turns this into a per-step review);
//   3. a FOLLOW-UP goes through the handle, not through a second delegation
//      (0028, corrected 2026-11-14). The old text promised that "a later delegation
//      continues that agent's conversation", and the runtime does not do that for a
//      conversation parent: EVERY delegation from a thread mints its own child
//      conversation (src/harness.ts:14589-14593,
//      `createThreadState(brain.name, { ownerThreadId: parent.threadId }, true)`),
//      so the second brief arrives in a transcript that has never seen the first. Only a
//      delegation from the HOST reuses the target's default conversation (the host call
//      carries `hostRank()` — src/harness.ts:1602 — rather than a conversation's, and that
//      branch at :14588 is what takes the default). The real
//      continuation door is `threadSend` into the `threadId` the envelope reported, so
//      this line names that handle instead of a continuity that is not there.
// It reads correctly for a Rank A agent with juniors (it has the tool), a junior agent that
// has juniors of its own (rank is intrinsic, so it has one too — it just cannot reach upward
// or sideways), and an agent with nobody below it. That last case has two halves, and both are
// honest absences: a roster whose members all share one rank registers the row NOT AT ALL
// (`rosterHasDelegation()` :1579 is `distinctRankCount >= 2`, and the `delegation` activation
// arm at :1712 reads it), and in a roster that DOES span ranks the lowest-ranked caller still
// gets no declaration, because `offerDeclarations` :6079 projects the `agent` enum onto that
// caller's own legal set and an empty set drops the row outright
// (`visibleCoreTools` :2588-2589).
export const DELEGATION_GUIDELINE =
    'When you delegate, give ONE target a self-contained brief because the agent you delegate to never sees this conversation and every delegation starts a NEW one, verify its answer before relying on it, and continue a child you already used with threadSend on the threadId it returned rather than assuming it remembers the last brief.';

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
// the standalone case (it chooses not to write) and the delegated case (a caller may still
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
//
// THE SAME CONDITIONAL AS THE DISCOVERY LINE ABOVE: `toolRequest` is a registered name the
// user of this conversation can switch off, and a switched-off name is not declared, so the
// route "enable it with toolRequest" only exists while toolRequest is in the list.
export const TOOL_CREATE_GUIDELINE =
    'toolCreate is searchable, not declared: while toolRequest is declared, enable it there before using it to add a small missing capability to this session.';
