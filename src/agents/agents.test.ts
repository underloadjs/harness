// The trusted agent registry (src/agents).
//
// These tests pin the catalogue the server advertises as AgentDescriptor and the
// composition rule that makes guidelines affect the runtime prompt: the profile IS
// the source of the system prompt, so adding a guideline cannot silently become
// documentation that never reaches a model.
//
// ROSTER (seven real roles + the delegated summarizer), in picker order:
//   general, instruct, research, workspace, reviewer, planner, debugger, summarizer
// `general` leads because it is the DEFAULT entry point. Order is pinned so a new profile
// is an explicit addition, and so the frontend colour palette (which assigns tones by this
// order) only shifts on purpose.
//
// EVERY ENTRY IS A PRODUCTION ROLE. The roster used to end with the `demo` and `flaky`
// FIXTURE profiles — a scripted transport's identity text and a retry example's. They are
// deleted: an `AgentProfile` is a role a harness can select and a client can list, and a
// test that needs an offline loop builds its own agent instead (see
// ../server/harnesses/fixture-presets.test-support.ts). The two rows those profiles held in
// `PROMPT_LENGTHS` and `SHARED_COMPOSITION` below are gone with them.
//
// IDS ARE STABLE, TITLES ARE NOT (regression pin). `research` → Explore, `workspace` →
// Analyst and `planner` → Manager keep their registry ids, because the id is persisted in
// harness records, the per-harness agentModels/agentInstructions/agentColors maps, the
// global agents.json overlay and every frozen session record, and `agentProfile()` has no
// alias fallback — a renamed id would abort server startup over an old row. The prompt
// prose therefore routes by ID, never by title, and the `delegate` target enum holds ids.
//
// `debugger` is an ECMAScript reserved word, so its module exports `debuggerAgent`; the
// registry id is still `debugger` (the key in AGENT_PROFILES and the profile's `name`).
//
// The later blocks pin what the model-visible text may contain: the POLICY a tool
// declaration cannot express (routing stance, read-only policy, verification ownership),
// never a copy of the declaration list itself.
//
// WHY `agentInstruction` RETURNS ONE STRING (regression pin)
// ----------------------------------------------------------
// It used to return `[instruction, guidelines]`, and `agent({ instruction })` seeds
// one `system` message per array entry (src/core/agent.ts `seed`). Several
// OpenAI-compatible gateways accept only ONE system turn — or keep only the first or
// last one — so those models silently ran on the identity sentence alone and lost the
// guidelines. The composition is therefore joined at the single place that builds it
// (src/agents/index.ts), which is what the `agentInstruction` block below pins: one
// string, one `Guidelines:` section, a blank line as the identity/rules split.
//
// A NARROWER RULE THAN AN OVERRIDE IS THE COMPLETE PROMPT: an explicit
// `instructionOverride` is the whole prompt and is returned verbatim, with no guideline
// block appended, so the box the operator edits (one textarea holding the full effective
// instruction) round-trips without duplicating the guidelines.

import { describe, expect, it } from 'vitest';
import type { AgentProfile } from './index';
import {
    AGENT_PROFILES,
    AGENT_PROFILE_NAMES,
    agentInstruction,
    agentProfile,
    agentProfiles,
    isAgentProfileName
} from './index';
import { general } from './general';
import { summarizer } from './summarizer';
import { instruct } from './instruct';
import { reviewer } from './reviewer';
import { planner } from './planner';
import { research } from './research';
import { workspace } from './workspace';
// Reserved word: the export is `debuggerAgent`, the registry id is `debugger`.
import { debuggerAgent } from './debugger';
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    READ_ONLY_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';
import { BUILTIN_TOOL_DESCRIPTORS } from '../core/tool-manifest';
// The one place that decides whether a role actually HAS a team: `delegate` registers only
// when the harness's allowlist is non-empty (src/harness.ts `activation: 'subagents'`), so a
// prompt line about delegating is only true while the matching preset agrees.
import { presets } from '../server/harnesses/presets';

// The exact error text a client sees for a bad id: the message lists the known set
// in picker order, so this is also a roster pin.
const KNOWN =
    'general, instruct, research, workspace, reviewer, planner, debugger, summarizer';

// The seven roles a picker offers as usable work, in roster order (the summarizer is a
// delegated condenser, not a selectable entry point for a real task).
const REAL_ROLES = [general, instruct, research, workspace, reviewer, planner, debuggerAgent];

// The exact identity sentence of each real role. `agentInstruction` puts this first,
// above the guideline block, so a reworded role is a deliberate edit, not drift.
const IDENTITY = {
    general:
        'You are the General agent, the default. Do every step of the task yourself, in this conversation, and never hand work to another agent.',
    instruct:
        'You are the Instruct agent. Do the work yourself, and delegate only a step that would cost more context than it is worth to perform.',
    research:
        'You are the Explore agent. Establish what is actually there and how it works, and report only what you can point to.',
    workspace:
        'You are the Analyst agent. Implement the work in the codebase at the standard its surrounding code already sets, and prove it works.',
    reviewer:
        'You are the Reviewer agent, a strict judge. Test the work against what it claims, and report only what you can point to.',
    planner:
        'You are the Manager agent. Hold the whole goal, plan it, and steer specialists through every step; you delegate the work and never do it yourself.',
    debugger:
        'You are the Debugger agent. Exercise the whole system until something breaks, then prove how it breaks.'
};

// The one contract bullet each role exists to carry, copied verbatim out of its profile.
// These are the sentences that separate the seven roles: without them the roster collapses
// into three near-identical "use your tools" briefs. Pinned as whole strings, so a reword
// is a visible diff and the policy cannot be quietly softened.
const CONTRACT = {
    // General: alone by contract, and BOTH loopholes the runtime does not close are named here.
    // A lone agent can still hand a step away without `delegate`, two ways: `threadFork`
    // (searchable; activation 'forks' is on by default) or `threadSend` (core, lazily registered
    // once the host has a second conversation — a server session always does). The bullet bans
    // each by name, so the prompt matches the rule the profile exists to state.
    generalWorksAlone:
        'You work alone: no subagent exists here, so a step you cannot do is a step to unlock with toolRequest, never a step to pass on. Do not spawn a branch with threadFork, and do not hand the step to another conversation with threadSend.',
    // Instruct: the worker stance — only context-burning, non-mutating steps leave it.
    instructDelegatesOnlyReads:
        'Delegate only context-burning steps that change nothing: research, exploration, a long read, a review. Anything you would then have to write, edit, or run, you do yourself.',
    // A Manager refuses to run as a delegate, so routing to it is a wasted child run.
    instructNeverManager:
        'Never delegate to a Manager: it does not run as a delegate. Send an investigation to research and a challenge to reviewer, and keep the build.',
    // Manager rule 1: no team, no Manager — and it must not degrade into a worker.
    plannerStopsWithoutATeam:
        'If `delegate` is not declared to you, stop and say why: with no one to delegate to a Manager cannot manage, and it must not quietly become a worker.',
    // Manager rule 2: a Manager that was delegated to returns the reason, not the work.
    plannerRefusesToBeADelegate:
        'If this brief reached you because another agent delegated to you, reply that a Manager does not run as a delegate, and stop without starting the task.',
    // Manager routing: registry IDS, because the delegate `agent` enum holds ids.
    plannerRoutesByIds:
        'Delegate every step to the narrowest id that fits: research to investigate, workspace to implement, reviewer to challenge, debugger to stress-test, general for a whole self-contained job, summarizer to condense.',
    // Manager acceptance: author and judge are never the same agent.
    plannerNeedsAnIndependentReview:
        "Accept nothing on its author's word: after each step, delegate the result to reviewer for an independent check against the acceptance criteria, and re-delegate until it passes or you can state what remains wrong.",
    // Debugger: scope, not an inventory — nothing is off-limits.
    debuggerEverythingInScope:
        'Nothing is off-limits here: unlock any searchable tool you need, read any path, run any command, and delegate to any configured role.',
    debuggerStressesEdges:
        'Test the edges, not the happy path: empty input, oversized input, a missing path, a wrong type, a repeated call, a cancelled call, a target that refuses.',
    // A finding without a reproduction is an anecdote.
    debuggerReproducesFailures:
        'Reduce every failure to the smallest call sequence that triggers it again, and quote the exact tool, input, and error text.',
    // Scratch files are fine; silently editing the subject hides the result.
    debuggerDoesNotTouchTheSubject:
        'Write scratch files when a probe needs them, but never change the code under test unless the brief asks for a fix.'
};

// Measured length of the ONE composed system prompt, per profile, in registry order
// (`yarn vite-node Temp/opencode/prompt-size.ts` prints this table). Exact equality (not a range):
// growth has to be intentional, so adding a bullet to a shared guideline line is a visible
// diff here. The seven real roles get their own, higher ceiling below.
//
// +18 on every profile that composes DISCOVERY_GUIDELINE (and +38 on the debugger, which
// composes TOOL_CREATE_GUIDELINE as well): both shared lines are now CONDITIONAL on
// `toolRequest` being declared, because the user of a conversation can switch that name off
// and a prompt that orders the model to call an undeclared tool is the exact loop these
// lines were written to prevent. `workspace` and `summarizer` are unmoved — the first names
// its own searchable tools instead of the shared line, the second composes none.
const PROMPT_LENGTHS = [
    // 1245: 1227 + the conditional `toolRequest` clause (see the block above); before that
    // it grew from 1168 because the "works alone" bullet now names BOTH ways a lone agent
    // could still offload a step (`threadFork` and `threadSend`) instead of only the fork.
    { name: 'general', length: 1245 },
    { name: 'instruct', length: 1534 },
    { name: 'research', length: 1605 },
    { name: 'workspace', length: 1521 },
    { name: 'reviewer', length: 1493 },
    { name: 'planner', length: 1634 },
    // 1728: the widest prompt on the roster, because the debugger composes every shared line
    // (web + delegation + discovery + toolCreate + permissions) on top of its own five bullets.
    { name: 'debugger', length: 1728 },
    { name: 'summarizer', length: 141 }
];

// Labels for the shared guideline lines (./guidelines.ts), keyed by the exact string so the
// composition below is measured against the real constant, not against a copy of its text.
const SHARED_LABELS = new Map<string, string>([
    [DELEGATION_GUIDELINE, 'DELEGATION'],
    [DISCOVERY_GUIDELINE, 'DISCOVERY'],
    [WEB_SEARCH_GUIDELINE, 'WEB_SEARCH'],
    [PERMISSIONS_GUIDELINE, 'PERMISSIONS'],
    [READ_ONLY_GUIDELINE, 'READ_ONLY'],
    [TOOL_CREATE_GUIDELINE, 'TOOL_CREATE']
]);

// The shared lines a profile composes, in its own declared order. An empty array means the
// profile composes none of them (only the summarizer is that self-contained).
const sharedLinesOf = (profile: AgentProfile): string[] =>
    profile.guidelines
        .map((line) => SHARED_LABELS.get(line))
        .filter((label): label is string => label !== undefined);

// THE DELEGATION-STANCE MATRIX. One row per roster entry, exactly which shared policy lines
// it composes. This is the roster's design made executable:
//   general   — no DELEGATION at all: its preset passes `subagents: []`, so `delegate` is
//               never registered and a delegation line would describe a tool it cannot call.
//   instruct  — a worker: DELEGATION plus the full discovery/web/permissions block.
//   research  — read-only investigator (READ_ONLY), delegating because a sub-agent may still
//               be handed a scoped toolbox.
//   workspace — the implementor: NO generic DISCOVERY (it names the four searchable tools it
//               actually reaches for, same policy at a fraction of the length) and NO
//               READ_ONLY (writing is the job).
//   reviewer  — read-only judge.
//   planner   — DELEGATION ONLY: it executes nothing, so discovery/web/permissions prose
//               would be context it never spends.
//   debugger  — everything, including TOOL_CREATE (it authors its own probes) and WEB_SEARCH
//               (the web trio is part of what it stresses; an absent `search` on a keyless host is
//               a finding to report, not a source to invent).
const SHARED_COMPOSITION = [
    { name: 'general', shared: ['DISCOVERY', 'WEB_SEARCH', 'PERMISSIONS'] },
    { name: 'instruct', shared: ['DELEGATION', 'DISCOVERY', 'WEB_SEARCH', 'PERMISSIONS'] },
    { name: 'research', shared: ['READ_ONLY', 'DELEGATION', 'DISCOVERY', 'WEB_SEARCH'] },
    { name: 'workspace', shared: ['DELEGATION', 'PERMISSIONS'] },
    { name: 'reviewer', shared: ['READ_ONLY', 'DELEGATION', 'DISCOVERY'] },
    { name: 'planner', shared: ['DELEGATION'] },
    // Order is the profile's own declared order, so this also pins that WEB_SEARCH sits ABOVE
    // DELEGATION for the debugger (it reads the web before it reads the team).
    { name: 'debugger', shared: ['WEB_SEARCH', 'DELEGATION', 'DISCOVERY', 'TOOL_CREATE', 'PERMISSIONS'] },
    // The summarizer composes none of them: it is a two-sentence condenser with its own
    // two bullets, and it runs on a brief, not on the tool policy of a primary.
    { name: 'summarizer', shared: [] }
];

// The shared guideline block a profile composes, exactly as `agentInstruction` renders
// it: a `Guidelines:` header plus one `- ` bullet per entry, in array order. The
// parameter is `readonly` because `AgentProfile.guidelines` is a readonly tuple.
const guidelinesBlock = (guidelines: readonly string[]) =>
    `Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;

// One descriptor lookup, so the manifest cross-checks below read as data, not search code.
const descriptorOf = (name: string) =>
    BUILTIN_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name);

describe('agent profiles', () => {
    it('lists the trusted agents with the seven real roles first', () => {
        expect([...AGENT_PROFILE_NAMES]).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'summarizer'
        ]);
        expect(agentProfiles().map((profile) => profile.name)).toEqual([...AGENT_PROFILE_NAMES]);
    });

    it('gives every profile a complete, non-empty definition keyed by its own id', () => {
        expect(
            agentProfiles().map((profile) => ({
                name: profile.name,
                keyedByItsId: AGENT_PROFILES[profile.name as keyof typeof AGENT_PROFILES] === profile,
                title: profile.title.length > 0,
                description: profile.description.length > 0,
                instruction: profile.instruction.length > 0,
                // A blank bullet would render as a stray "- " in the prompt.
                guidelines: profile.guidelines.every((line) => line.trim().length > 0)
            }))
        ).toEqual(
            AGENT_PROFILE_NAMES.map((name) => ({
                name,
                keyedByItsId: true,
                title: true,
                description: true,
                instruction: true,
                guidelines: true
            }))
        );

        // The reserved-word profile is the one entry whose export name differs from its id:
        // `debuggerAgent` under the key (and the `name` field) `debugger`.
        expect(debuggerAgent.name).toBe('debugger');
        expect(AGENT_PROFILES.debugger).toBe(debuggerAgent);
    });

    // The id is the persisted identity, the title is the label. Three roles were retitled and
    // deliberately kept their ids (see the header), so BOTH halves are pinned together.
    it('pins each real role id to its display title', () => {
        expect(REAL_ROLES.map((profile) => ({ name: profile.name, title: profile.title }))).toEqual([
            { name: 'general', title: 'General' },
            { name: 'instruct', title: 'Instruct' },
            { name: 'research', title: 'Explore' },
            { name: 'workspace', title: 'Analyst' },
            { name: 'reviewer', title: 'Reviewer' },
            { name: 'planner', title: 'Manager' },
            { name: 'debugger', title: 'Debugger' }
        ]);
    });

    // R5: the display title is the ONLY visible agent name in the picker, and every
    // profile title is ONE word. The ids (`name`) stay untouched: they are the
    // persisted harness/protocol identity, not a display string.
    it('keeps every profile display title a single word', () => {
        expect(agentProfiles().map((profile) => profile.title)).toEqual([
            'General',
            'Instruct',
            'Explore',
            'Analyst',
            'Reviewer',
            'Manager',
            'Debugger',
            'Summarizer'
        ]);
        // One word = exactly one whitespace-separated token per title.
        expect(agentProfiles().map((profile) => profile.title.trim().split(/\s+/).length)).toEqual([
            1, 1, 1, 1, 1, 1, 1, 1
        ]);
    });

    it('resolves ids and rejects unknown ones', () => {
        expect(agentProfile('general')).toBe(general);
        expect(agentProfile('summarizer')).toBe(summarizer);
        expect(agentProfile('reviewer')).toBe(reviewer);
        expect(agentProfile('planner')).toBe(planner);
        expect(agentProfile('debugger')).toBe(debuggerAgent);
        expect(isAgentProfileName('workspace')).toBe(true);
        expect(isAgentProfileName('Explore')).toBe(false);
        expect(isAgentProfileName('critic')).toBe(false);
        expect(() => agentProfile('critic')).toThrow(`Unknown agent "critic". Known agents: ${KNOWN}.`);
    });
});

// The delegation stance is the axis the roster is organised around, and each end of it is
// enforced by the RUNTIME in a way the prompt alone cannot fake: `delegate` is registered
// only when the harness has subagents (src/harness.ts `activation: 'subagents'` + the empty
// allowlist refusal) and it is primary-only (src/tools/runtime/delegate.tool.ts
// `registration.primaryOnly`). The profile text has to match that reality for each role.
describe('delegation stance per role', () => {
    it('gives the default role no delegation line and no team at all', () => {
        const prompt = agentInstruction(general);

        // `subagents: []` means `delegate` is never registered here, so the prompt must not
        // describe a tool that does not exist — and `toolRequest` cannot surface it either.
        expect(general.guidelines).not.toContain(DELEGATION_GUIDELINE);
        expect(prompt).not.toContain(DELEGATION_GUIDELINE);
        expect(prompt.toLowerCase()).not.toContain('delegate');

        // The rule is stated positively, and closes the loopholes the runtime does not, by name.
        // Pinned as the WHOLE rendered bullet rather than as a bare tool-name check: the one
        // string below is what the model reads, and it contains `threadFork` and `threadSend`.
        expect(general.guidelines).toContain(CONTRACT.generalWorksAlone);
        expect(prompt).toContain(`- ${CONTRACT.generalWorksAlone}`);

        // The preset side of the same contract (src/server/harnesses/presets.ts): a lone
        // card, so the runtime never registers `delegate` for it.
        const generalPreset = presets.find((preset) => preset.name === 'general');
        expect(generalPreset?.primary).toBe('general');
        expect(generalPreset?.subagents).toEqual([]);
        expect(generalPreset?.agents).toEqual(['general']);
    });

    it('keeps Instruct a worker that hands out only context-burning, non-mutating steps', () => {
        const prompt = agentInstruction(instruct);

        expect(instruct.guidelines).toContain(DELEGATION_GUIDELINE);
        expect(instruct.guidelines).toContain(CONTRACT.instructDelegatesOnlyReads);
        expect(instruct.guidelines).toContain(CONTRACT.instructNeverManager);

        // The targets it names are REGISTRY IDS, never display titles: the `delegate` target
        // enum holds ids, so "send it to Explore" would be an unresolvable target.
        expect(prompt).toContain('to research');
        expect(prompt).toContain('to reviewer');
        expect(prompt).not.toContain('Explore');
        expect(prompt).not.toContain('Analyst');
    });

    it('makes the Manager orchestrate, refuse to work, and refuse to be a delegate', () => {
        const prompt = agentInstruction(planner);

        // Rule 1 and rule 2: both are prompt-level, because the runtime only ever shows the
        // agent one observable fact — whether `delegate` is declared.
        expect(planner.guidelines).toContain(CONTRACT.plannerStopsWithoutATeam);
        expect(planner.guidelines).toContain(CONTRACT.plannerRefusesToBeADelegate);

        // Acceptance is never the author's own word: every step goes to reviewer.
        expect(planner.guidelines).toContain(CONTRACT.plannerNeedsAnIndependentReview);

        // Routing names ids, and every id it names is a real registry entry.
        expect(planner.guidelines).toContain(CONTRACT.plannerRoutesByIds);
        for (const id of ['research', 'workspace', 'reviewer', 'debugger', 'general', 'summarizer']) {
            expect(isAgentProfileName(id)).toBe(true);
        }

        // It executes nothing, so it carries no discovery/permissions/web prose.
        expect(sharedLinesOf(planner)).toEqual(['DELEGATION']);
        expect(prompt).not.toContain(DISCOVERY_GUIDELINE);
        expect(prompt).not.toContain(PERMISSIONS_GUIDELINE);
        expect(prompt).not.toContain(WEB_SEARCH_GUIDELINE);
    });

    // No built-in team can name the Manager: a Manager running as a subagent has no
    // `delegate` (it is primary-only), so its own rule would fire and burn a child run. The
    // string form keeps this one exact assertion over all eight presets. The trailing
    // `chat:general:` entry is the tool-less card (issue 0005-D): it selects the trusted
    // `general` profile and declares NO team, so it is neither a delegator nor a target.
    it('keeps the Manager out of every built-in team', () => {
        expect(
            presets.map((preset) => `${preset.name}:${preset.primary}:${preset.subagents.join('+')}`)
        ).toEqual([
            'general:general:',
            'instruct:instruct:general+research+workspace+reviewer+debugger+summarizer',
            'research:research:general+instruct+workspace+reviewer+debugger+summarizer',
            'workspace:workspace:general+instruct+research+reviewer+debugger+summarizer',
            'reviewer:reviewer:general+instruct+research+workspace+debugger+summarizer',
            'planner:planner:general+instruct+research+workspace+reviewer+debugger+summarizer',
            'debugger:debugger:general+instruct+research+workspace+reviewer+summarizer',
            'chat:general:'
        ]);
    });

    it('makes the two report-producing roles read-only and the two build roles not', () => {
        // READ_ONLY is policy, not enforcement — no profile can deny write/edit — so the line
        // only works while the two report roles carry it and the lift clause stays in it.
        expect(research.guidelines).toContain(READ_ONLY_GUIDELINE);
        expect(reviewer.guidelines).toContain(READ_ONLY_GUIDELINE);
        expect(agentInstruction(research)).toContain(
            'You are read-only unless the brief authorises a change'
        );
        expect(agentInstruction(reviewer)).toContain(
            'You are read-only unless the brief authorises a change'
        );

        // The implementor and the stress-tester legitimately write, so they must not inherit
        // a blanket ban: workspace edits the codebase, the debugger writes probe scratch.
        expect(workspace.guidelines).not.toContain(READ_ONLY_GUIDELINE);
        expect(debuggerAgent.guidelines).not.toContain(READ_ONLY_GUIDELINE);
        expect(debuggerAgent.guidelines).toContain(CONTRACT.debuggerDoesNotTouchTheSubject);
    });

    it('makes the Debugger stress everything in scope without editing the subject', () => {
        expect(debuggerAgent.guidelines).toContain(CONTRACT.debuggerEverythingInScope);
        expect(debuggerAgent.guidelines).toContain(CONTRACT.debuggerStressesEdges);
        expect(debuggerAgent.guidelines).toContain(CONTRACT.debuggerReproducesFailures);
        expect(debuggerAgent.guidelines).toContain(CONTRACT.debuggerDoesNotTouchTheSubject);

        // It authors its own probes, so it is the one role that composes the toolCreate line.
        expect(debuggerAgent.guidelines).toContain(TOOL_CREATE_GUIDELINE);

        // And it composes the web line immediately above DELEGATION: the web trio is in scope for
        // a stress run, and the position is what keeps the ordering pin in SHARED_COMPOSITION (and
        // the measured 1690 in PROMPT_LENGTHS) honest about WHY the prompt grew.
        expect(debuggerAgent.guidelines).toContain(WEB_SEARCH_GUIDELINE);
        expect(sharedLinesOf(debuggerAgent)).toEqual([
            'WEB_SEARCH',
            'DELEGATION',
            'DISCOVERY',
            'TOOL_CREATE',
            'PERMISSIONS'
        ]);
    });
});

// Availability is the declaration list, not prompt prose: every model request receives
// its callable tools with name, description, and schema (src/harness.ts
// `offerDeclarations` → src/transport/openai.ts `tools`), so the old profiles spent
// hundreds of characters restating which tools exist and how the discovery selector
// works. That contract now lives ONCE, in toolRequest's own metadata, and the profiles
// carry only the policy a schema cannot say. These tests pin the boundary — and keep the
// stale claims the rewrite removed from ever coming back, for EVERY roster entry.
describe('profile guidance stays policy, not a tool inventory', () => {
    it('composes the shared policy lines instead of copying them per profile', () => {
        expect(
            agentProfiles().map((profile) => ({
                name: profile.name,
                shared: sharedLinesOf(profile)
            }))
        ).toEqual(SHARED_COMPOSITION);
    });

    it('never re-lists declared tools or re-states the discovery selector', () => {
        for (const profile of agentProfiles()) {
            // The prompt is already ONE string, so no join: this is verbatim what the
            // model reads as its single system message.
            const prompt = agentInstruction(profile);

            // No "X is always available" inventory line: the declaration says it.
            expect(prompt).not.toMatch(/always available/i);

            // The selector mechanics (uncapped union, enabled bound, page wording) are
            // toolRequest's description. The stale claims this guards against are the
            // exact forms the old prompt used.
            expect(prompt).not.toMatch(/at most 5 best matches/);
            expect(prompt).not.toMatch(/unless you pass a smaller limit/);
            expect(prompt).not.toMatch(/first discovery call returns/);
            expect(prompt).not.toMatch(/five-result/);
            expect(prompt).not.toContain('maxEnabledTools');
        }

        // The accurate contract is still advertised — where the model reads it as part of
        // the declaration, so no profile has to repeat it.
        const description = descriptorOf('toolRequest')?.metadata.description ?? '';

        expect(description).toContain('maxEnabledTools');
        expect(description).toContain('newest request takes precedence');
    });

    // THE SESSION SWITCH makes `toolRequest` itself switchable, and a switched-off name is
    // not declared at all. Both shared lines used to promise the discovery door uncondition-
    // ally, which for those two profiles is now a promise the kernel may not keep — so each
    // states its own condition, and the toolRequest description says what a switched-off
    // capability looks like from the inside (absent from every list).
    it('states the discovery door as the conditional it now is', () => {
        expect(DISCOVERY_GUIDELINE).toContain('when toolRequest is in it');
        expect(TOOL_CREATE_GUIDELINE).toContain('while toolRequest is declared');

        const description = descriptorOf('toolRequest')?.metadata.description ?? '';

        expect(description).toContain(
            'A tool the user of THIS conversation has switched off is not listed here at all'
        );
        // The bound sentence is untouched: core tools still neither count against
        // `maxEnabledTools` nor get evicted — the switch is a separate set, not a slot.
        expect(description).toContain(
            'while core tools neither count against the bound nor get evicted'
        );
    });

    // The rewritten web line is only correct while it matches src/core/tool-manifest.ts:
    // `fetch` is `visibility: 'core'` (declared, no key needed), `search` is core but
    // only ACTIVATED by a configured key, `download` is searchable. The old text called
    // fetch searchable, which sent the model hunting for a tool already in front of it.
    it('states the web trio the way the manifest actually declares it', () => {
        // EXACTLY these four roles carry the line, in roster order, and each carries the shared
        // constant verbatim rather than a per-profile paraphrase of it: the three roles that can
        // reach the web, plus `debugger`, for whom the trio is part of what gets stressed (an
        // absent `search` on a keyless host is a finding to report, not a source to invent).
        expect(
            agentProfiles()
                .filter((profile) => agentInstruction(profile).includes(WEB_SEARCH_GUIDELINE))
                .map((profile) => profile.name)
        ).toEqual(['general', 'instruct', 'research', 'debugger']);

        expect(descriptorOf('search')?.metadata.visibility).toBe('core');
        expect(descriptorOf('fetch')?.metadata.visibility).toBe('core');
        expect(descriptorOf('download')?.metadata.visibility).toBe('searchable');

        // The removed bug must stay removed, in every profile's prompt.
        for (const profile of agentProfiles()) {
            expect(agentInstruction(profile)).not.toMatch(/fetch is searchable/i);
        }
    });

    // Every tool the profile prose calls searchable really is, and every one it calls
    // declared really is — otherwise a bullet sends the model searching for a tool that is
    // already in front of it, or waiting for a tool that never arrives. A missing
    // `visibility` field is the manifest's way of saying "the runtime default applies", and
    // that default is `searchable` (src/harness.ts treats an entry with no visibility as
    // searchable), which is what the Analyst's and Debugger's bullets rely on.
    it('names each tool the way the manifest classifies it', () => {
        expect(
            ['download', 'toolCreate', 'threadFork'].map(
                (name) => `${name}:${descriptorOf(name)?.metadata.visibility}`
            )
        ).toEqual(['download:searchable', 'toolCreate:searchable', 'threadFork:searchable']);

        // The four the Analyst bullet names as "searchable, not declared".
        expect(
            ['shell', 'gitDiff', 'syntax', 'files'].map((name) => descriptorOf(name)?.metadata.visibility)
        ).toEqual([undefined, undefined, undefined, undefined]);

        // The toolCreate line is only true because toolCreate is NOT declared.
        expect(agentInstruction(debuggerAgent)).toContain(TOOL_CREATE_GUIDELINE);
    });

    it('keeps each profile at its measured prompt size, inside the budget', () => {
        // Exact observed length per profile, so growth is a deliberate diff...
        expect(
            agentProfiles().map((profile) => ({
                name: profile.name,
                length: agentInstruction(profile).length
            }))
        ).toEqual(PROMPT_LENGTHS);

        // ...and the seven real roles stay under the ceiling. It moved from 1500 to 1800
        // because the seven-role roster gives each role ONE explicit delegation-stance
        // contract line more than the five-role roster had (general works alone, Instruct
        // delegates only reads, the Manager refuses both ways). The budget is still a policy
        // brief, not a tool manual — that guard is the regex block above, which stays.
        for (const profile of REAL_ROLES) {
            expect(agentInstruction(profile).length).toBeLessThan(1800);
        }
    });
});

describe('agentInstruction', () => {
    // One string, not a pair: two entries meant two `system` messages, and gateways
    // that accept one system turn dropped the guidelines. See the header comment.
    it('composes the identity sentence and one guideline block into a single string', () => {
        const prompt = agentInstruction(summarizer);

        expect(typeof prompt).toBe('string');
        expect(prompt).toBe(
            'You compress technical notes into at most two sentences.\n\n' +
            'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        );

        // Structure, asserted exactly: two paragraphs split by a blank line, and inside
        // the second one the header plus the two bullets.
        expect(prompt.split('\n\n')).toEqual([
            'You compress technical notes into at most two sentences.',
            'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        ]);
    });

    it('seeds every guideline from the Instruct profile, in order', () => {
        const prompt = agentInstruction(instruct);

        // The blank line is the ONLY thing separating "who you are" from "rules you
        // follow", because both travel inside one system message.
        expect(prompt.split('\n\n')).toEqual([
            IDENTITY.instruct,
            guidelinesBlock(instruct.guidelines)
        ]);
    });

    it('gives every profile exactly one Guidelines section with one bullet per guideline', () => {
        for (const profile of agentProfiles()) {
            const prompt = agentInstruction(profile);
            const lines = prompt.split('\n');

            // One header, no second block appended by a second composition path.
            expect(prompt.split('\n\n').length).toBe(2);
            expect(lines.filter((line) => line === 'Guidelines:')).toEqual(['Guidelines:']);

            // One bullet per guideline entry, in declared order, with nothing extra.
            expect(lines.filter((line) => line.startsWith('- '))).toEqual(
                profile.guidelines.map((line) => `- ${line}`)
            );

            // No stray blank bullet ("- ") and no doubled blank line: the single blank
            // line is the identity/rules split and nothing else.
            expect(prompt).not.toContain('- \n');
            expect(prompt).not.toContain('\n\n\n');
            expect(prompt.endsWith('\n')).toBe(false);
        }
    });

    it('opens every real profile with its exact identity sentence', () => {
        expect(REAL_ROLES.map((profile) => agentInstruction(profile).split('\n\n')[0])).toEqual([
            IDENTITY.general,
            IDENTITY.instruct,
            IDENTITY.research,
            IDENTITY.workspace,
            IDENTITY.reviewer,
            IDENTITY.planner,
            IDENTITY.debugger
        ]);
    });

    // The retitled roles must read as their TITLE inside the prompt, while every routing
    // line and the delegate enum keep the ID — otherwise a model told it is "Explore" would
    // try to delegate to "Explore" and get an unknown-target error.
    it('retitles the prompt identity without retitling the routing ids', () => {
        expect(agentInstruction(research)).toContain('You are the Explore agent.');
        expect(agentInstruction(workspace)).toContain('You are the Analyst agent.');
        expect(agentInstruction(planner)).toContain('You are the Manager agent.');

        expect(
            [research, workspace, planner].map((profile) => profile.name)
        ).toEqual(['research', 'workspace', 'planner']);
    });

    it('returns only the instruction when a profile has no guidelines', () => {
        // No block, so no header and no blank line: a minimal profile stays valid and
        // the prompt is the trimmed identity sentence alone.
        expect(
            agentInstruction({
                name: 'bare',
                title: 'Bare',
                description: 'No rules.',
                instruction: ' You are bare. ',
                guidelines: []
            })
        ).toBe('You are bare.');
    });

    // EDITABLE CONFIGURATION — AN OVERRIDE IS THE COMPLETE PROMPT. The text an
    // operator saves comes back out of the one instruction box that displays the FULL
    // effective instruction, so it already holds every line the agent is meant to read.
    // Appending `profile.guidelines` underneath it rendered them twice (and rendered an
    // edited bullet two ways). A profile's guidelines are therefore the DEFAULT an
    // un-overridden member runs on, not policy that survives an override.
    it('returns a harness override verbatim as the whole instruction', () => {
        // Trimmed, then nothing else: no `Guidelines:` header, no bullets, no blank line.
        expect(agentInstruction(summarizer, 'Condense to one line.')).toBe('Condense to one line.');

        // Surrounding whitespace and a trailing newline are the only things removed.
        expect(agentInstruction(summarizer, '  Condense to one line.\n ')).toBe('Condense to one line.');

        // The same rule for a role whose shipped prompt is 1.5kB of shared policy: the
        // override replaces all of it, so no trusted bullet survives into the prompt.
        expect(agentInstruction(instruct, 'Lead with the answer.')).toBe('Lead with the answer.');
        expect(agentInstruction(instruct, 'Lead with the answer.')).not.toContain('Guidelines:');
    });

    it('does not duplicate the guidelines an override already states', () => {
        // The exact shape the box sends back: identity, the operator's own guideline
        // block, and no second block appended by the server.
        const full = 'You compress notes.\n\nGuidelines:\n- Keep names, numbers, and conclusions.';

        expect(agentInstruction(summarizer, full)).toBe(full);

        // One header in the text the model receives — under the old append rule this
        // prompt carried two `Guidelines:` sections.
        expect(agentInstruction(summarizer, full).split('Guidelines:')).toHaveLength(2);
    });

    it('composes the Guidelines section into the default whenever the profile has guidelines', () => {
        // Exact whole-string expectation for every shipped profile: identity, one blank
        // line, then the block. No profile here is guideline-free, so the default always
        // carries the section.
        for (const profile of agentProfiles()) {
            expect(agentInstruction(profile)).toBe(
                `${profile.instruction.trim()}\n\n${guidelinesBlock(profile.guidelines)}`
            );
        }

        // The same rule spelled out for the shortest profile, so a reworded summarizer is
        // a diff here rather than a silent change to what `textSummarize` delegates.
        expect(agentInstruction(summarizer)).toBe(
            'You compress technical notes into at most two sentences.\n\n' +
            'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        );
    });

    it('keeps the trusted instruction when the override is absent or blank', () => {
        // Absent (undefined) and a whitespace-only value are the same thing: no
        // override. The registry never stores a blank one, so a saved harness cannot
        // reach the runtime with an empty prompt by this path.
        expect(agentInstruction(summarizer, undefined)).toBe(agentInstruction(summarizer));
        expect(agentInstruction(summarizer, '   \n ')).toBe(agentInstruction(summarizer));

        // "Blank means default" still means the DEFAULT is the composed prompt: the
        // guideline block survives exactly as it does with no override at all.
        for (const blank of [undefined, '', '   \n ']) {
            expect(agentInstruction(instruct, blank)).toBe(
                `${IDENTITY.instruct}\n\n${guidelinesBlock(instruct.guidelines)}`
            );
        }
    });

    it('applies an override to a guideline-free profile without adding a block', () => {
        expect(
            agentInstruction(
                {
                    name: 'bare',
                    title: 'Bare',
                    description: 'No rules.',
                    instruction: ' You are bare. ',
                    guidelines: []
                },
                '  You are edited.  '
            )
        ).toBe('You are edited.');

        // And its un-overridden default is the trimmed identity sentence alone, which is
        // the one case where a prompt has no guideline section to begin with.
        expect(
            agentInstruction({
                name: 'bare',
                title: 'Bare',
                description: 'No rules.',
                instruction: ' You are bare. ',
                guidelines: []
            })
        ).toBe('You are bare.');
    });
});
