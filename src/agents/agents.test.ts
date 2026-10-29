// The trusted agent registry (src/agents).
//
// These tests pin the catalogue the server advertises as AgentDescriptor and the
// composition rule that makes guidelines affect the runtime prompt: the profile IS
// the source of the system messages, so adding a guideline cannot silently become
// documentation that never reaches a model.
//
// T3 roster: the five real roles (instruct, research, workspace, reviewer,
// planner) come first in picker order, then the delegated summarizer, then the two
// fixtures. Order is pinned so a new profile is an explicit addition.

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

// The exact error text a client sees for a bad id: the message lists the known set
// in picker order, so this is also a roster pin.
const KNOWN = 'instruct, research, workspace, reviewer, planner, summarizer, demo, flaky';

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

describe('agentInstruction', () => {
    it('composes the instruction and one guideline block', () => {
        expect(agentInstruction(summarizer)).toEqual([
            'You compress technical notes into at most two sentences.',
            'Guidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        ]);
    });

    it('seeds every guideline from the Instruct profile, in order', () => {
        const [instruction, guidelines = ''] = agentInstruction(instruct);

        expect(instruction).toBe(
            'You are the Instruct agent. Answer the request directly and keep the answer focused.'
        );
        expect(guidelines.split('\n')).toEqual([
            'Guidelines:',
            ...instruct.guidelines.map((line) => `- ${line}`)
        ]);
    });

    it('returns only the instruction when a profile has no guidelines', () => {
        expect(
            agentInstruction({
                name: 'bare',
                title: 'Bare',
                description: 'No rules.',
                instruction: ' You are bare. ',
                guidelines: []
            })
        ).toEqual(['You are bare.']);
    });
});
