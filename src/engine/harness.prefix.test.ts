// U6 — THE SEEDED PREFIX BAND (preset history), engine level.
//
// A prefix is the run of transcript entries `agent()` seeds from `AgentConfiguration.prefix`: the
// preset history immediately AFTER the instruction block and BEFORE the legacy
// `configuration.messages` seed and every accumulated turn. This file pins the three lives a band
// has, because a server that edits preset history has to move all three at once:
//   L1 the CURRENT transcript's band, replaced IN PLACE (no rebuild ⇒ no lost conversation, and
//      every accumulated turn keeps its object identity);
//   L2 the `reset()` baseline, so a reset returns to the band the last write installed;
//   L3 the thread factory, so the NEXT host thread of that agent seeds the new band.
//
// Everything below goes through the PUBLIC surface (`agent()`, `harness()`,
// `harness.setAgentPrefix`) plus the two internal seam helpers the server reads through
// (./core/agent.ts `agentPrefixOf` / `writeAgentPrefix`, the same pair
// ../../../server/api.ts `getSessionAgentPrefix` calls), so the assertions are exactly what a
// host observes — no mocks of the runtime.
//
// Clock policy: no fake timers; every transport is scripted, so every assertion is an exact value.

import { describe, expect, it } from 'vitest';
import { agent, harness } from './index';
import type {
    HarnessMessage,
    HarnessPrefixTurn,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// The prefix-band seam: the writer behind `harness.setAgentPrefix`, and the read behind the
// server's `GET …/agents/{agent_id}/prefix`. Both are reached by object identity through a
// WeakMap, so the public `Agent` type carries no mutable configuration field.
import { agentPrefixOf, writeAgentPrefix } from './core';

// Replay scripted frames; the last list repeats so a request count never changes the answer.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);

        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// The band every case below seeds, and the replacement bands it is swapped for. Written as the
// closed wire shape (`role` + text `content`), because that is the one shape shared by the
// contract, the server, and this runtime.
const BAND: HarnessPrefixTurn[] = [
    { role: 'system', content: 'Cite every figure.' },
    { role: 'user', content: 'Draft the summary.' },
    { role: 'assistant', content: 'Summary drafted.' }
];

const INSTRUCTION = 'You write briefings.';

// A brain with the band seeded, plus an optional legacy seed message so the assertions can show
// the band sitting BETWEEN the instruction block and the legacy history.
const banded = (stream: HarnessStream, legacy = false) =>
    agent({
        model: 'test/model',
        instruction: INSTRUCTION,
        prefix: BAND,
        ...(legacy ? { messages: [{ role: 'user', content: 'Legacy seed.' }] } : {}),
        stream
    });

// `role` + `content` only: every transcript entry also carries a minted `id`, which is derived from
// the whole transcript and therefore not a value this file wants to hard-code. The pair is still an
// EXACT assertion of the seed the provider reads.
const textOf = (messages: readonly HarnessMessage[]) =>
    messages.map((entry) => ({ role: entry.role, content: entry.content }));

describe('harness preset history (U6)', () => {
    it('seeds the band between the instruction block and the legacy seed history', () => {
        const brain = banded(scripted([answer('ok')]), true);

        // THE EXACT ORDER, and the exact bytes: `content` is verbatim (never trimmed), the legacy
        // `messages` seed stays behind the band, and the instruction block keeps its single-system-
        // message spelling.
        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'system', content: 'Cite every figure.' },
            { role: 'user', content: 'Draft the summary.' },
            { role: 'assistant', content: 'Summary drafted.' },
            { role: 'user', content: 'Legacy seed.' }
        ]);

        // The seam read returns the band ALONE, in the closed shape — the document the server's
        // prefix route answers with.
        expect(agentPrefixOf(brain)).toEqual(BAND);
    });

    it('answers an empty band for a brain that was seeded with none', () => {
        const plain = agent({
            model: 'test/model',
            instruction: INSTRUCTION,
            stream: scripted([answer('ok')])
        });

        expect(textOf(plain.messages)).toEqual([{ role: 'system', content: INSTRUCTION }]);
        expect(agentPrefixOf(plain)).toEqual([]);
    });

    it('replaces only the band and keeps every accumulated turn by identity', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        // One committed turn, kept BY REFERENCE through the write — the reason this is a splice and
        // not a rebuild: rebuilding to retune a seed is what deletes the conversation.
        brain.user('Ask something.');
        const committed = brain.messages[brain.messages.length - 1];

        writer.setAgentPrefix('writer', [{ role: 'user', content: 'Fresh band.' }]);

        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'user', content: 'Fresh band.' },
            { role: 'user', content: 'Ask something.' }
        ]);
        expect(brain.messages[2]).toBe(committed);

        // The registered brain and the handle are the SAME object, so the server reading the
        // roster's brain sees the band the write installed — no second source to refresh.
        expect(agentPrefixOf(writer.agents.writer!)).toEqual([{ role: 'user', content: 'Fresh band.' }]);
    });

    it('moves the reset baseline so a reset returns to the new band', () => {
        const brain = banded(scripted([answer('ok')]), true);
        const writer = harness({ agents: { writer: brain }, presets: false });

        brain.user('A turn the reset drops.');
        writer.setAgentPrefix('writer', [{ role: 'assistant', content: 'Baseline band.' }]);
        writer.reset();

        // L2: `reset()` re-seeds instructions + the CURRENT band + the legacy seed — the legacy
        // history survives (it is part of the seed), the accumulated turn does not, and the OLD
        // three-turn band is gone because the write replaced the baseline.
        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'assistant', content: 'Baseline band.' },
            { role: 'user', content: 'Legacy seed.' }
        ]);
        expect(agentPrefixOf(brain)).toEqual([{ role: 'assistant', content: 'Baseline band.' }]);
    });

    it('treats an empty array as "remove the band", not as an omitted argument', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        brain.user('Keep me.');
        writer.setAgentPrefix('writer', []);

        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'user', content: 'Keep me.' }
        ]);
        expect(agentPrefixOf(brain)).toEqual([]);
    });

    it('seeds a NEW host thread with the band the last write installed', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = banded(scripted([answer('threaded')], seen));
        const writer = harness({ agents: { writer: brain }, presets: false });

        writer.setAgentPrefix('writer', [{ role: 'user', content: 'Thread band.' }]);

        // L3: the thread factory reads `prefixOverride` first, so a conversation opened after the
        // write starts from the NEW history — which is what makes a preset edit reach the next
        // conversation without rewriting the one already running.
        const thread = writer.createThread('writer');

        await writer.sendThreadInput(thread.id, 'Open a second conversation.');

        const request = seen[0]!;
        const seed = textOf(request.messages as unknown as HarnessMessage[]).slice(0, 2);

        expect(seed).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'user', content: 'Thread band.' }
        ]);

        // And the write did NOT rewrite the default conversation's history: the two lives are
        // independent by design (the same limitation `setAgentInstruction` states).
        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'user', content: 'Thread band.' }
        ]);
    });

    it('refuses a band that is not an array, and says what to send instead', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        expect(() => writer.setAgentPrefix('writer', undefined as unknown as HarnessPrefixTurn[])).toThrow(
            'Agent "writer" needs an ARRAY of prefix turns. Send [] to remove the seeded band; the runtime has no layer to inherit from.'
        );

        // Refusal BEFORE anything moved.
        expect(agentPrefixOf(brain)).toEqual(BAND);
    });

    it('refuses an agent that is not in the roster, naming the roster', () => {
        const writer = harness({ agents: { writer: banded(scripted([answer('ok')])) }, presets: false });

        expect(() => writer.setAgentPrefix('ghost', [])).toThrow(
            'Agent "ghost" is not registered. Configured agents: writer.'
        );
    });

    it('refuses a tool-role turn naming its position, and leaves the band in place', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        // Typed as the CLOSED union on purpose, so the only escape hatch in the literal is the one
        // turn this assertion is about: the `tool` role is unrepresentable by type, and `as unknown
        // as` is what smuggles it past the compiler to reach the RUNTIME guard.
        const mixed: HarnessPrefixTurn[] = [
            { role: 'user', content: 'Fine.' },
            // A tool turn answers a `tool_calls` block a preset never carries, so the runtime
            // refuses the position rather than putting an unpaired result in front of a model.
            { role: 'tool', content: 'Orphan.' } as unknown as HarnessPrefixTurn
        ];

        expect(() => writer.setAgentPrefix('writer', mixed)).toThrow(
            'Agent "writer" prefix turn 1 must have role "system", "user", or "assistant"; a tool turn belongs to a conversation, not to a preset history.'
        );

        expect(agentPrefixOf(brain)).toEqual(BAND);
        expect(textOf(brain.messages).length).toBe(1 + BAND.length);
    });

    it('refuses to splice a band the transcript no longer holds where the seed put it', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        // The band's guard is content-based (a snapshot round trip copies every entry and must still
        // pass), so the case that HAS to fail is a band entry that says something else — here, a
        // host that overwrote the first seeded turn in place.
        (brain.messages as HarnessMessage[])[1] = { role: 'system', content: 'Rewritten by hand.' };

        expect(() => writer.setAgentPrefix('writer', [{ role: 'user', content: 'Fresh.' }])).toThrow(
            'Agent "writer" no longer carries its seeded prefix band at position 0; refusing to splice unrelated history.'
        );
    });

    it('refuses a forked conversation, whose transcript is its own baseline', () => {
        const brain = banded(scripted([answer('ok')]));
        const branch = brain.fork();

        // A branch starts from its source's MATERIALIZED transcript, which already carries these
        // turns, so injecting a band again would put them in front twice. Roster writes address the
        // registered brain, never a branch — this is the backstop. The name in the sentence is the
        // branch's own (`agent()` defaults to "agent" until a harness registers it), which is why
        // the refusal is written out in full rather than derived from the source.
        expect(() => writeAgentPrefix(branch, [{ role: 'user', content: 'Branch band.' }])).toThrow(
            'Agent "agent" is a forked conversation: its transcript is its own baseline, so it has no seeded prefix band to rewrite.'
        );
        expect(agentPrefixOf(branch)).toEqual([]);
    });

    it('drops every extra field a caller sends on a turn, and never adopts the caller object', () => {
        const brain = banded(scripted([answer('ok')]));
        const writer = harness({ agents: { writer: brain }, presets: false });

        // A caller reusing one enriched object (an id, a toolCalls block, an attachments array)
        // across two agents must not have either transcript hold the same reference.
        const enriched = {
            role: 'user',
            content: '  padded  ',
            id: 99,
            toolCalls: [{ id: 'call_1', name: 'threadRead', arguments: '{}' }],
            attachments: []
        } as unknown as HarnessPrefixTurn;

        writer.setAgentPrefix('writer', [enriched]);

        const band = agentPrefixOf(brain);

        // EXACT: only `role` and `content` survive, and content keeps its spaces (verbatim).
        expect(band).toEqual([{ role: 'user', content: '  padded  ' }]);
        expect(textOf(brain.messages)).toEqual([
            { role: 'system', content: INSTRUCTION },
            { role: 'user', content: '  padded  ' }
        ]);
    });
});
