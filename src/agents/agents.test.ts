// The trusted agent registry (src/agents).
//
// These tests pin the catalogue the server advertises as AgentDescriptor and the
// composition rule that makes guidelines affect the runtime prompt: the profile IS
// the source of the system prompt, so adding a guideline cannot silently become
// documentation that never reaches a model.
//
// T3 roster: the five real roles (instruct, research, workspace, reviewer,
// planner) come first in picker order, then the delegated summarizer, then the two
// fixtures. Order is pinned so a new profile is an explicit addition.
//
// The later blocks pin what the model-visible text may contain: the policy a tool
// declaration cannot express, never a copy of the declaration list itself.
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
// T6 NARROWS THAT RULE TO THE TRUSTED DEFAULT: an explicit `instructionOverride` is
// the complete prompt and is returned verbatim, with no guideline block appended, so
// the box the operator edits (one textarea holding the full effective instruction)
// round-trips without duplicating the guidelines.

import { describe, expect, it } from 'vitest';
import {
    AGENT_PROFILES,
    AGENT_PROFILE_NAMES,
    agentInstruction,
    agentProfile,
    agentProfiles,
    isAgentProfileName
} from './index';
import { summarizer } from './summarizer';
import { instruct } from './instruct';
import { reviewer } from './reviewer';
import { planner } from './planner';
import { research } from './research';
import { workspace } from './workspace';
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';
import { BUILTIN_TOOL_DESCRIPTORS } from '../core/tool-manifest';

// The exact error text a client sees for a bad id: the message lists the known set
// in picker order, so this is also a roster pin.
const KNOWN = 'instruct, research, workspace, reviewer, planner, summarizer, demo, flaky';

// The exact identity sentence of each real role. `agentInstruction` puts this first,
// above the guideline block, so a reworded role is a deliberate edit, not drift.
const IDENTITY = {
    instruct: 'You are the Instruct agent. Follow the brief exactly, answer directly, and do only what was asked.',
    research: 'You are the Research agent. Investigate before you answer, and keep what you found separate from what you inferred.',
    workspace: 'You are the Coder agent. Read, edit, and verify files in the server workspace, and keep every change as small as the task allows.',
    reviewer: 'You are the Reviewer agent. Find real defects in the work you are given, and report only what you can point to.',
    planner: 'You are the Planner agent. Plan before you build, route each step to the narrowest configured specialist, and verify the result yourself.'
};

// Measured length of the ONE composed system prompt, per profile, in registry order.
// Exact equality (not a range): growth has to be intentional, so adding a bullet to a
// shared guideline line is a visible diff here. 1500 characters is room for a policy
// bullet, not for a tool manual — the ceiling below is the budget that keeps it true.
const PROMPT_LENGTHS = [
    { name: 'instruct', length: 1367 },
    { name: 'research', length: 1391 },
    { name: 'workspace', length: 1351 },
    { name: 'reviewer', length: 1372 },
    { name: 'planner', length: 1434 },
    { name: 'summarizer', length: 141 },
    { name: 'demo', length: 294 },
    { name: 'flaky', length: 344 }
];

// The shared guideline block a profile composes, exactly as `agentInstruction` renders
// it: a `Guidelines:` header plus one `- ` bullet per entry, in array order. The
// parameter is `readonly` because `AgentProfile.guidelines` is a readonly tuple.
const guidelinesBlock = (guidelines: readonly string[]) =>
    `Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;

describe('agent profiles', () => {
    it('lists the trusted agents with the real roles first', () => {
        expect([...AGENT_PROFILE_NAMES]).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'summarizer',
            'demo',
            'flaky'
        ]);
        expect(agentProfiles().map((profile) => profile.name)).toEqual([...AGENT_PROFILE_NAMES]);
    });

    it('gives every profile a complete, non-empty definition', () => {
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
    });

    it('gives the visible roles the requested titles and ids', () => {
        expect(
            [instruct, research, workspace, reviewer, planner].map((profile) => ({
                name: profile.name,
                title: profile.title
            }))
        ).toEqual([
            { name: 'instruct', title: 'Instruct' },
            { name: 'research', title: 'Researcher' },
            { name: 'workspace', title: 'Coder' },
            { name: 'reviewer', title: 'Reviewer' },
            { name: 'planner', title: 'Planner' }
        ]);
    });

    // R5: the display title is the ONLY visible agent name in the picker, and every
    // profile title is ONE word. The ids (`name`) stay untouched: they are the
    // persisted harness/protocol identity, not a display string.
    it('keeps every profile display title a single word', () => {
        expect(agentProfiles().map((profile) => profile.title)).toEqual([
            'Instruct',
            'Researcher',
            'Coder',
            'Reviewer',
            'Planner',
            'Summarizer',
            'Demo',
            'Flaky'
        ]);
        // One word = exactly one whitespace-separated token per title.
        expect(agentProfiles().map((profile) => profile.title.trim().split(/\s+/).length)).toEqual([
            1, 1, 1, 1, 1, 1, 1, 1
        ]);
    });

    it('resolves ids and rejects unknown ones', () => {
        expect(agentProfile('summarizer')).toBe(summarizer);
        expect(agentProfile('reviewer')).toBe(reviewer);
        expect(agentProfile('planner')).toBe(planner);
        expect(isAgentProfileName('workspace')).toBe(true);
        expect(isAgentProfileName('critic')).toBe(false);
        expect(() => agentProfile('critic')).toThrow(`Unknown agent "critic". Known agents: ${KNOWN}.`);
    });
});

// Availability is the declaration list, not prompt prose: every model request receives
// its callable tools with name, description, and schema (src/harness.ts
// `offerDeclarations` → src/transport/openai.ts `tools`), so the old profiles spent
// hundreds of characters restating which tools exist and how the discovery selector
// works. That contract now lives ONCE, in toolRequest's own metadata, and the profiles
// carry only the policy a schema cannot say. These tests pin the boundary — and keep the
// stale claims the rewrite removed from ever coming back.
describe('profile guidance stays policy, not a tool inventory', () => {
    const REAL_ROLES = [instruct, research, workspace, reviewer, planner];

    it('composes the shared policy lines instead of copying them per profile', () => {
        for (const profile of REAL_ROLES) {
            expect(profile.guidelines).toContain(DELEGATION_GUIDELINE);
            expect(profile.guidelines).toContain(DISCOVERY_GUIDELINE);
        }

        expect(instruct.guidelines).toContain(WEB_SEARCH_GUIDELINE);
        expect(instruct.guidelines).toContain(TOOL_CREATE_GUIDELINE);
        expect(research.guidelines).toContain(WEB_SEARCH_GUIDELINE);
        expect(workspace.guidelines).toContain(PERMISSIONS_GUIDELINE);
        expect(planner.guidelines).toContain(PERMISSIONS_GUIDELINE);
    });

    it('never re-lists declared tools or re-states the discovery selector', () => {
        for (const profile of REAL_ROLES) {
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
        const toolRequest = BUILTIN_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === 'toolRequest');
        const description = toolRequest?.metadata.description ?? '';

        expect(description).toContain('maxEnabledTools');
        expect(description).toContain('newest request takes precedence');
    });

    // The rewritten web line is only correct while it matches src/core/tool-manifest.ts:
    // `fetch` is `visibility: 'core'` (declared, no key needed), `search` is core but
    // only ACTIVATED by a configured key, `download` is searchable. The old text called
    // fetch searchable, which sent the model hunting for a tool already in front of it.
    it('states the web trio the way the manifest actually declares it', () => {
        for (const profile of [instruct, research]) {
            const prompt = agentInstruction(profile);

            expect(prompt).toContain('search is declared only when the host configured a web-search key');
            expect(prompt).toContain('fetch is declared without a key');
            expect(prompt).toContain('download is searchable under "web" or "url"');
        }

        // The removed bug must stay removed, in every profile's prompt.
        for (const profile of agentProfiles()) {
            expect(agentInstruction(profile)).not.toMatch(/fetch is searchable/i);
        }
    });

    it('keeps each profile at its measured prompt size, inside the budget', () => {
        // Exact observed length per profile, so growth is a deliberate diff...
        expect(
            agentProfiles().map((profile) => ({
                name: profile.name,
                length: agentInstruction(profile).length
            }))
        ).toEqual(PROMPT_LENGTHS);

        // ...and the five real roles stay well under the 1500-character ceiling.
        for (const profile of REAL_ROLES) {
            expect(agentInstruction(profile).length).toBeLessThan(1500);
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
        expect(
            [instruct, research, workspace, reviewer, planner].map(
                (profile) => agentInstruction(profile).split('\n\n')[0]
            )
        ).toEqual([
            IDENTITY.instruct,
            IDENTITY.research,
            IDENTITY.workspace,
            IDENTITY.reviewer,
            IDENTITY.planner
        ]);
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

    // T6 EDITABLE CONFIGURATION — AN OVERRIDE IS THE COMPLETE PROMPT. The text an
    // operator saves comes back out of the one instruction box that displays the FULL
    // effective prompt, so it already holds every line the agent is meant to read.
    // Appending `profile.guidelines` underneath it rendered them twice (and rendered an
    // edited bullet two ways). A profile's guidelines are therefore the DEFAULT an
    // un-overridden member runs on, not policy that survives an override.
    it('returns a harness override verbatim as the whole instruction', () => {
        // Trimmed, then nothing else: no `Guidelines:` header, no bullets, no blank line.
        expect(agentInstruction(summarizer, 'Condense to one line.')).toBe('Condense to one line.');

        // Surrounding whitespace and a trailing newline are the only things removed.
        expect(agentInstruction(summarizer, '  Condense to one line.\n ')).toBe('Condense to one line.');

        // The same rule for a role whose shipped prompt is 1.3kB of shared policy: the
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

        // The same rule spelled out for one fixture, so a reworded fixture is a diff here.
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
