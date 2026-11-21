// The Instruct agent — General PLUS one narrow licence to delegate.
//
// WHAT SEPARATES IT FROM THE OTHER TWO ROUTING ROLES
// --------------------------------------------------
//   general  (./general.ts) — never delegates; `delegate` is not even registered.
//   instruct (this file)    — a WORKER. It keeps every step that produces or changes an
//                             artefact (code, documents, config, commands) and hands out
//                             ONLY the steps that would fill its context window without it
//                             having to act: investigation, a codebase sweep, a long read,
//                             an independent review.
//   manager  (./planner.ts) — the OPPOSITE posture. It delegates every step, never works,
//                             and steers delegates against one goal.
//
// That boundary is the whole reason this profile exists, so the routing bullet states the
// test the agent applies to each step ("does this step need MY hands afterwards?"). A
// prompt that only said "delegate when useful" collapses back into the Manager's behaviour
// — or into General's, if the model decides delegation is never useful.
//
// WHY "NEVER DELEGATE TO A MANAGER" IS HERE AT ALL
// ------------------------------------------------
// The built-in teams exclude `planner` from every allowlist (see `teamOf` in
// ../../server/harnesses/presets.ts), so the delegate enum normally cannot name it. A
// USER-created team can still select it, and a Manager asked to act as a delegate refuses
// (./planner.ts states the refusal), so one cheap sentence prevents a wasted round trip.
//
// Tool availability is the declaration list (src/harness.ts `offerDeclarations`), never
// prose; the shared policy lines are ./guidelines.ts. `TOOL_CREATE_GUIDELINE` is omitted
// to keep this default-grade card inside the prompt budget — authoring a tool is a
// deliberate act the discovery line already makes reachable via `toolRequest`
// (src/core/tool-manifest.ts registers toolCreate as searchable).
import type { AgentProfile } from './types';
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';

export const instruct: AgentProfile = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'General worker that does its own building and editing and delegates only the steps that would burn its context: research, a codebase sweep, a long read, a second opinion. Unlike the Manager, it never hands out work it must still finish itself.',
    instruction:
        'You are the Instruct agent. Do the work yourself, and delegate only a step that would cost more context than it is worth to perform.',
    guidelines: [
        // The brief is the specification: no scope creep, and an unverifiable claim is
        // disclosed rather than smoothed over.
        'Treat the brief as the specification: keep the scope it states, and say plainly when it is ambiguous or when a claim cannot be checked.',
        // THE boundary line — the difference between this role and the Manager.
        'Delegate only context-burning steps that change nothing: research, exploration, a long read, a review. Anything you would then have to write, edit, or run, you do yourself.',
        // The Manager refuses to be a delegate, so routing to it is a wasted call. Targets
        // are named by REGISTRY ID because the delegate `agent` enum holds ids, not the
        // display titles: `research` is the card titled Explore, `workspace` is Analyst,
        // `planner` is Manager (./index.ts keeps ids stable for saved sessions).
        'Never delegate to a Manager: it does not run as a delegate. Send an investigation to research and a challenge to reviewer, and keep the build.',
        DELEGATION_GUIDELINE,
        // A delegate's report is a claim; the caller owns the answer either way.
        'Verify a delegated result before relying on it; the final answer stays yours.',
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        PERMISSIONS_GUIDELINE,
        'Be concise: no preamble, no restating the question.'
    ]
};
