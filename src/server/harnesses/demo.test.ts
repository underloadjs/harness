// scriptedDemo — conversation-wide tool-call ids.
//
// The harness rejects a tool-call id that is not unique across the conversation
// (one result must pair with exactly one call). The demo is reused by successive
// tasks in a session and by a restored session, so its ids must be derived from the
// transcript rather than a fresh counter per process/call.
//
// This file pins:
//   - a second task in the same session mints the next free ids;
//   - a harness restored from the first session's snapshot (the persisted
//     transcript) mints the next free ids again, so present AND restored runs work;
//   - all ids in the resulting conversation are unique.

import { describe, expect, it } from 'vitest';
import { presets } from './index';

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'test-model'
};

const progress = (): void => {
    // The scripted transport is the subject; events are irrelevant here.
};

const demoPreset = (): (typeof presets)[number] => {
    const preset = presets.find((entry) => entry.name === 'demo');
    if (!preset) throw new Error('demo preset is missing');
    return preset;
};

const callIds = (messages: readonly { role: string; toolCalls?: readonly { id: string }[] }[]): string[] => {
    const ids: string[] = [];
    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const call of message.toolCalls ?? []) ids.push(call.id);
    }
    return ids;
};

describe('scripted demo tool-call ids', () => {
    it('continues minting unique ids on a second task and a restored session', async () => {
        const preset = demoPreset();
        const first = preset.create(SETTINGS, progress);

        const firstMessage = await first('What time is it?');
        expect(firstMessage.content).toContain('timeNow returned');

        const snapshot = first.snapshot();
        expect(callIds(snapshot.agents.demo.messages)).toEqual([
            'call_tool_request_1',
            'call_time_now_1'
        ]);

        // A NEW harness restored from the persisted transcript stands in for a
        // server restart during the same session.
        const restored = preset.create(SETTINGS, progress);
        restored.restore(snapshot);

        const secondMessage = await restored('And once more?');
        expect(secondMessage.content).toContain('timeNow returned');

        const ids = callIds(restored.agents.demo.messages);
        expect(ids).toEqual([
            'call_tool_request_1',
            'call_time_now_1',
            'call_tool_request_2',
            'call_time_now_2'
        ]);

        // Every id is distinct: the uniqueness guard would have rejected the run
        // before any tool executed.
        expect(new Set(ids).size).toBe(ids.length);

        // The persisted view is consistent with the live transcript.
        expect(callIds(restored.snapshot().agents.demo.messages)).toEqual(ids);
    }, 30_000);
});
