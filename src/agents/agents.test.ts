// The trusted agent registry (src/agents).
//
// These tests pin the catalogue the server advertises as AgentDescriptor and the
// composition rule that makes guidelines affect the runtime prompt: the profile IS
// the source of the system messages, so adding a guideline cannot silently become
// documentation that never reaches a model.

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

describe('agent profiles', () => {
    it('lists the trusted agents in picker order', () => {
        expect([...AGENT_PROFILE_NAMES]).toEqual([
            'instruct',
            'research',
            'summarizer',
            'workspace',
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

    it('resolves ids and rejects unknown ones', () => {
        expect(agentProfile('summarizer')).toBe(summarizer);
        expect(isAgentProfileName('workspace')).toBe(true);
        expect(isAgentProfileName('nope')).toBe(false);
        expect(() => agentProfile('nope')).toThrow(
            'Unknown agent "nope". Known agents: instruct, research, summarizer, workspace, demo, flaky.'
        );
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
