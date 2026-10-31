// toolList (R4): the live registry inventory.
//
// The result contains EVERY registered tool, enabled or not, and each row has
// EXACTLY `name` and `description`. No tags, schema, enabled flag, or source is
// leaked: toolRequest is the grant and toolManage is the rich inspection surface.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream } from '@underload/harness';

const stream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const brain = () => agent({ model: 'test/model', stream });

describe('toolList', () => {
    it('lists every live registry tool by name and description only', async () => {
        const enabledFixture = tool({
            name: 'enabledFixture',
            description: 'Already enabled fixture.',
            tags: ['fixture'],
            execute: () => 'enabled'
        });
        const disabledFixture = tool({
            name: 'disabledFixture',
            description: 'Not enabled fixture.',
            tags: ['fixture'],
            execute: () => 'disabled'
        });
        const writer = harness({
            agents: { writer: brain() },
            presets: false,
            tools: {
                enabledFixture,
                disabledFixture
            }
        });

        // Enable exactly one searchable fixture, leaving the other registered but
        // not enabled. toolList must still include both.
        await writer.executeTool('toolRequest', { names: ['enabledFixture'] });

        const result = (await writer.executeTool('toolList', {})) as {
            name: string;
            description: string;
        }[];

        // The expected inventory is the live registry itself, in insertion order.
        expect(result).toEqual(
            Object.keys(writer.tools).map((name) => ({
                name,
                description: writer.tools[name].description
            }))
        );

        // Every row is exactly the two allowed fields, and the full registry (core
        // included, plus the enabled and disabled searchable fixtures) is present.
        for (const entry of result) {
            expect(Object.keys(entry)).toEqual(['name', 'description']);
        }
        expect(result.map((entry) => entry.name)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel',
            'enabledFixture',
            'disabledFixture'
        ]);
        expect(result.find((entry) => entry.name === 'disabledFixture')).toEqual({
            name: 'disabledFixture',
            description: 'Not enabled fixture.'
        });
    });

    it('is stable across enablement and reset()', async () => {
        const writer = harness({ agents: { writer: brain() }, presets: false });
        const before = await writer.executeTool('toolList', {});

        writer.reset();
        expect(await writer.executeTool('toolList', {})).toEqual(before);
    });
});
