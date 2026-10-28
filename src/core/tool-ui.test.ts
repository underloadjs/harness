// Declarative tool UI normalization (R20.2).
//
// These tests pin the safety contract at the helper/unwrapping boundary: a tool
// (or a hand-built envelope) may pass anything, but only bounded, well-shaped
// DATA reaches a client. Nothing here is HTML/script/action data.
//
// Deterministic by construction: every expected panel below is written out in
// full, and count bounds are asserted with the exact cap values.

import { describe, expect, it } from 'vitest';
import { TOOL_UI_LIMITS, normalizeToolUiPanels, toolUi, toolUiOf } from '../harness';
import type { ToolUiPanel } from '../harness';

const panel = (overrides: Partial<ToolUiPanel> = {}): ToolUiPanel => ({
    id: 'p1',
    slot: 'right',
    title: 'Panel',
    blocks: [{ type: 'text', text: 'hello' }],
    ...overrides
});

describe('toolUi', () => {
    it('builds a branded envelope with the ordinary content untouched', () => {
        const content = { answer: 42 };
        const envelope = toolUi(content, [panel()]);

        expect(envelope.content).toBe(content);
        expect(envelope.__toolUi).toEqual([panel()]);
        // The brand is an own property, so a value can be recognized without
        // trusting a prototype or a user-supplied field.
        expect(Object.prototype.hasOwnProperty.call(envelope, '__toolUi')).toBe(true);
    });

    it('normalizes panels at the helper, not just at unwrapping', () => {
        const envelope = toolUi('content', [
            // Missing id: dropped.
            { slot: 'right', title: 'No id', blocks: [{ type: 'text', text: 'x' }] } as never,
            // Unknown block type: dropped, and the panel survives with its valid block.
            {
                id: 'mixed',
                slot: 'right',
                title: 'Mixed',
                blocks: [
                    { type: 'html', html: '<script>alert(1)</script>' } as never,
                    { type: 'text', text: 'kept' }
                ]
            }
        ]);

        expect(envelope.__toolUi).toEqual([
            { id: 'mixed', slot: 'right', title: 'Mixed', blocks: [{ type: 'text', text: 'kept' }] }
        ]);
    });

    it('caps panels, blocks, table rows/columns, key/value items, and text lengths', () => {
        const manyPanels = normalizeToolUiPanels(
            Array.from({ length: TOOL_UI_LIMITS.panels + 5 }, (_, index) =>
                panel({ id: `p${index}` })
            )
        );
        expect(manyPanels).toHaveLength(TOOL_UI_LIMITS.panels);

        const manyBlocks = normalizeToolUiPanels([
            panel({
                blocks: Array.from({ length: TOOL_UI_LIMITS.blocksPerPanel + 3 }, () => ({
                    type: 'text',
                    text: 'b'
                }))
            })
        ]);
        expect(manyBlocks[0].blocks).toHaveLength(TOOL_UI_LIMITS.blocksPerPanel);

        const table = normalizeToolUiPanels([
            panel({
                blocks: [
                    {
                        type: 'table',
                        columns: Array.from({ length: TOOL_UI_LIMITS.tableColumns + 2 }, (_, i) => `c${i}`),
                        rows: Array.from({ length: TOOL_UI_LIMITS.tableRows + 2 }, () =>
                            Array.from({ length: TOOL_UI_LIMITS.tableColumns + 2 }, () => 'x')
                        )
                    }
                ]
            })
        ]);
        const tableBlock = table[0].blocks[0];
        if (tableBlock.type !== 'table') throw new Error('expected a table block');
        expect(tableBlock.columns).toHaveLength(TOOL_UI_LIMITS.tableColumns);
        expect(tableBlock.rows).toHaveLength(TOOL_UI_LIMITS.tableRows);
        expect(tableBlock.rows[0]).toHaveLength(TOOL_UI_LIMITS.tableColumns);

        const keyValue = normalizeToolUiPanels([
            panel({
                blocks: [
                    {
                        type: 'keyValue',
                        items: Array.from({ length: TOOL_UI_LIMITS.keyValueItems + 2 }, (_, i) => ({
                            label: `l${i}`,
                            value: `v${i}`
                        }))
                    }
                ]
            })
        ]);
        const kvBlock = keyValue[0].blocks[0];
        if (kvBlock.type !== 'keyValue') throw new Error('expected a keyValue block');
        expect(kvBlock.items).toHaveLength(TOOL_UI_LIMITS.keyValueItems);
        expect(kvBlock.items[0]).toEqual({ label: 'l0', value: 'v0' });

        const longText = normalizeToolUiPanels([
            panel({ blocks: [{ type: 'text', text: 'a'.repeat(TOOL_UI_LIMITS.textLength + 50) }] })
        ]);
        const textBlock = longText[0].blocks[0];
        if (textBlock.type !== 'text') throw new Error('expected a text block');
        expect(textBlock.text).toHaveLength(TOOL_UI_LIMITS.textLength);
    });

    it('makes ragged and non-string table cells safe and rectangular', () => {
        const normalized = normalizeToolUiPanels([
            panel({
                blocks: [
                    {
                        type: 'table',
                        columns: ['a', 'b'],
                        rows: [
                            ['1', 2 as never, 'ignored'],
                            'not-a-row' as never,
                            []
                        ]
                    }
                ]
            })
        ]);

        expect(normalized).toEqual([
            {
                id: 'p1',
                slot: 'right',
                title: 'Panel',
                blocks: [
                    {
                        type: 'table',
                        columns: ['a', 'b'],
                        rows: [
                            ['1', ''],
                            ['', '']
                        ]
                    }
                ]
            }
        ]);
    });

    it('drops an entire panel that exceeds the total byte cap', () => {
        // One panel with the maximum number of maximum-length text blocks is well
        // over the total cap. Keeping a truncated block list would misrepresent
        // the tool's panel, so the safe answer is no panel at all.
        const normalized = normalizeToolUiPanels([
            panel({
                blocks: Array.from({ length: TOOL_UI_LIMITS.blocksPerPanel }, () => ({
                    type: 'text',
                    text: 'a'.repeat(TOOL_UI_LIMITS.textLength)
                }))
            })
        ]);

        expect(normalized).toEqual([]);
    });
});

describe('toolUiOf', () => {
    it('returns undefined for every ordinary tool value', () => {
        expect(toolUiOf('text')).toBeUndefined();
        expect(toolUiOf(42)).toBeUndefined();
        expect(toolUiOf(null)).toBeUndefined();
        expect(toolUiOf(undefined)).toBeUndefined();
        expect(toolUiOf([{ content: 'x' }])).toBeUndefined();
        // A lookalike without the brand is NOT an envelope: the harness must feed
        // its content through unchanged.
        expect(toolUiOf({ content: 'x', panels: [] })).toBeUndefined();
    });

    it('extracts content and re-normalizes a hand-built envelope', () => {
        const forged = {
            __toolUi: [
                panel(),
                { id: 'bad', slot: 'right', title: 'Bad', blocks: [{ type: 'script', code: 'x' }] }
            ],
            content: { ok: true }
        };

        expect(toolUiOf(forged)).toEqual({
            content: { ok: true },
            panels: [panel()]
        });
    });

    it('returns the original content by reference so the model sees the tool value', () => {
        const content = { nested: ['value'] };
        const extracted = toolUiOf(toolUi(content, [panel()]));

        expect(extracted?.content).toBe(content);
        expect(extracted?.panels).toEqual([panel()]);
    });
});
