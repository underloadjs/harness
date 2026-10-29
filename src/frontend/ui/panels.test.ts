// Declarative panel renderer (R21.3): validation, clamping, stable upsert and the
// data-only DOM.
//
// Every assertion is an EXACT value. The point of this module is that hostile or
// malformed wire data can produce only a bounded, inert card in a declared slot, so
// the tests pin the exact sanitized output, the exact keys, and the exact text that
// reaches the DOM (a script/img string must stay a string).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { SessionTurn } from '../../server/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    PANEL_LIMITS,
    applyPanels,
    createPanelHost,
    isPanelSlot,
    mediaOfTurns,
    panelKeyOf,
    resolveSlot,
    sanitizeBlock,
    sanitizePanel,
    sanitizePanels
} from './panels';
import type { PanelMedia } from './panels';

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('slot resolution', () => {
    it('accepts only the mounted slots, with the documented right alias', () => {
        expect(isPanelSlot('scratch')).toBe(true);
        expect(isPanelSlot('center')).toBe(true);
        expect(isPanelSlot('left')).toBe(true);
        // The backend contract documents 'right' as the default mount point.
        expect(isPanelSlot('right')).toBe(true);
        expect(resolveSlot('right')).toBe('scratch');
        expect(isPanelSlot('sidebar')).toBe(false);
        expect(resolveSlot('sidebar')).toBeUndefined();
        expect(isPanelSlot(7)).toBe(false);
    });
});

describe('sanitizePanel', () => {
    it('keeps a text panel exactly', () => {
        expect(
            sanitizePanel({
                id: 'status',
                slot: 'scratch',
                title: 'Status',
                blocks: [{ type: 'text', text: 'ready' }]
            })
        ).toEqual({
            id: 'status',
            slot: 'scratch',
            title: 'Status',
            blocks: [{ type: 'text', text: 'ready' }]
        });
    });

    it('normalizes a table to a rectangle of exactly its columns', () => {
        // Extra cell dropped, missing cell padded: the header and body line up
        // without trusting the producer.
        expect(
            sanitizePanel({
                id: 'files',
                slot: 'scratch',
                title: '',
                blocks: [
                    {
                        type: 'table',
                        columns: ['name', 'size'],
                        rows: [['a.txt', '10'], ['b.txt'], ['c.txt', '1', 'extra']]
                    }
                ]
            })
        ).toEqual({
            id: 'files',
            slot: 'scratch',
            title: '',
            blocks: [
                {
                    type: 'table',
                    columns: ['name', 'size'],
                    rows: [
                        ['a.txt', '10'],
                        ['b.txt', ''],
                        ['c.txt', '1']
                    ]
                }
            ]
        });
    });

    it('keeps only key/value items with a readable label', () => {
        expect(
            sanitizePanel({
                id: 'todos',
                slot: 'center',
                title: 'Todos',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'open', value: '2' },
                            { label: '', value: 'no label' },
                            { label: 'done', value: 3 },
                            'not an item'
                        ]
                    }
                ]
            })
        ).toEqual({
            id: 'todos',
            slot: 'center',
            title: 'Todos',
            blocks: [
                {
                    type: 'keyValue',
                    items: [
                        { label: 'open', value: '2' },
                        { label: 'done', value: '' }
                    ]
                }
            ]
        });
    });

    it('drops unknown slots, empty ids, non-objects and unknown block types', () => {
        expect(sanitizePanel(null)).toBeUndefined();
        expect(sanitizePanel('panel')).toBeUndefined();
        expect(sanitizePanel({ id: 'x', slot: 'sidebar', title: '', blocks: [] })).toBeUndefined();
        expect(sanitizePanel({ id: '', slot: 'scratch', title: '', blocks: [] })).toBeUndefined();
        expect(sanitizePanel({ slot: 'scratch', title: '', blocks: [] })).toBeUndefined();

        // An unknown block is dropped individually; known siblings survive.
        expect(
            sanitizePanel({
                id: 'mixed',
                slot: 'left',
                title: 'Mixed',
                blocks: [
                    { type: 'html', html: '<b>no</b>' },
                    { type: 'text', text: 'kept' },
                    { type: 'table' }
                ]
            })
        ).toEqual({
            id: 'mixed',
            slot: 'left',
            title: 'Mixed',
            blocks: [{ type: 'text', text: 'kept' }]
        });

        // A table with no columns cannot be headed, so it is not a block at all.
        expect(sanitizeBlock({ type: 'table', columns: [], rows: [['x']] })).toBeUndefined();
    });

    it('keeps an empty blocks array: it is the documented removal signal', () => {
        expect(sanitizePanel({ id: 'gone', slot: 'scratch', title: '', blocks: [] })).toEqual({
            id: 'gone',
            slot: 'scratch',
            title: '',
            blocks: []
        });
    });

    it('clamps ids, titles, text, counts, cells and rows to the documented limits', () => {
        const panel = sanitizePanel({
            id: 'i'.repeat(100),
            slot: 'scratch',
            title: 't'.repeat(200),
            blocks: [
                { type: 'text', text: 'x'.repeat(5000) },
                ...Array.from({ length: 20 }, () => ({ type: 'text', text: 'b' }))
            ]
        });

        expect(panel?.id).toBe('i'.repeat(PANEL_LIMITS.idLength));
        expect(panel?.title).toBe('t'.repeat(PANEL_LIMITS.titleLength));
        expect(panel?.blocks).toHaveLength(PANEL_LIMITS.blocksPerPanel);
        expect(panel?.blocks[0]).toEqual({
            type: 'text',
            text: 'x'.repeat(PANEL_LIMITS.textLength)
        });

        const table = sanitizeBlock({
            type: 'table',
            columns: Array.from({ length: 10 }, (_value, index) => `c${index}`),
            rows: Array.from({ length: 60 }, () => ['v'.repeat(300)])
        });

        expect(table?.type).toBe('table');
        if (table?.type !== 'table') throw new Error('expected a table block');
        expect(table.columns).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
        expect(table.rows).toHaveLength(PANEL_LIMITS.rows);
        // One supplied cell clamped; the other seven columns padded to the header.
        expect(table.rows[0]).toEqual([
            'v'.repeat(PANEL_LIMITS.cellLength),
            '',
            '',
            '',
            '',
            '',
            '',
            ''
        ]);

        const keyValue = sanitizeBlock({
            type: 'keyValue',
            items: Array.from({ length: 40 }, () => ({
                label: 'l'.repeat(100),
                value: 'v'.repeat(700)
            }))
        });

        expect(keyValue?.type).toBe('keyValue');
        if (keyValue?.type !== 'keyValue') throw new Error('expected a keyValue block');
        expect(keyValue.items).toHaveLength(PANEL_LIMITS.keyValueItems);
        expect(keyValue.items[0]).toEqual({
            label: 'l'.repeat(PANEL_LIMITS.keyValueLabelLength),
            value: 'v'.repeat(PANEL_LIMITS.keyValueValueLength)
        });
    });

    it('bounds one message to the documented panel count', () => {
        const panels = Array.from({ length: 10 }, (_value, index) => ({
            id: `p${index}`,
            slot: 'scratch',
            title: '',
            blocks: [{ type: 'text', text: 'x' }]
        }));

        expect(sanitizePanels(panels).map((panel) => panel.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
        // Anything that is not an array contributes nothing.
        expect(sanitizePanels(undefined)).toEqual([]);
        expect(sanitizePanels({ panels })).toEqual([]);
    });
});

describe('applyPanels (stable upsert)', () => {
    const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value });

    const panel = (id: string, title: string, value: string, slot = 'scratch'): unknown => ({
        id,
        slot,
        title,
        blocks: [text(value)]
    });

    it('scopes the key to the tool, replaces in place and removes on empty blocks', () => {
        const target = new Map<string, PanelMedia>();

        expect(applyPanels(target, 'alpha', [panel('status', 'Alpha status', 'one')])).toBe(1);
        // An unrelated tool may reuse the id without replacing alpha's panel.
        expect(applyPanels(target, 'beta', [panel('status', 'Beta status', 'two')])).toBe(1);

        expect([...target.keys()]).toEqual([
            panelKeyOf('alpha', { id: 'status' }),
            panelKeyOf('beta', { id: 'status' })
        ]);
        expect([...target.values()].map((entry) => entry.panel.title)).toEqual([
            'Alpha status',
            'Beta status'
        ]);

        // Replacement keeps the original position (stable ordering per slot).
        expect(applyPanels(target, 'alpha', [panel('status', 'Alpha again', 'three')])).toBe(1);
        expect([...target.keys()]).toEqual([
            panelKeyOf('alpha', { id: 'status' }),
            panelKeyOf('beta', { id: 'status' })
        ]);
        expect([...target.values()].map((entry) => entry.panel.title)).toEqual([
            'Alpha again',
            'Beta status'
        ]);

        // Empty blocks remove only that tool's panel.
        expect(applyPanels(target, 'alpha', [{ id: 'status', slot: 'scratch', title: '', blocks: [] }])).toBe(1);
        expect([...target.keys()]).toEqual([panelKeyOf('beta', { id: 'status' })]);

        // Removing something absent changes nothing.
        expect(applyPanels(target, 'alpha', [{ id: 'status', slot: 'scratch', title: '', blocks: [] }])).toBe(0);
        // Unknown data is a no-op, never an error.
        expect(applyPanels(target, 'beta', undefined)).toBe(0);
    });
});

describe('mediaOfTurns', () => {
    it('replays recorded tool_result.ui in order and ignores everything else', () => {
        const turns = [
            {
                id: 't1',
                index: 0,
                prompt: 'go',
                status: 'done',
                startedAt: 1,
                updatedAt: 2,
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    {
                        type: 'tool_result',
                        agent: 'instruct',
                        name: 'statusTool',
                        content: 'ok',
                        isError: false,
                        ui: [
                            {
                                id: 'status',
                                slot: 'scratch',
                                title: 'Status',
                                blocks: [{ type: 'text', text: 'ready' }]
                            }
                        ]
                    },
                    { type: 'text', agent: 'instruct', delta: 'done' }
                ]
            },
            {
                id: 't2',
                index: 1,
                prompt: 'again',
                status: 'done',
                startedAt: 3,
                updatedAt: 4,
                events: [
                    {
                        type: 'tool_result',
                        agent: 'instruct',
                        name: 'statusTool',
                        content: 'ok',
                        isError: false,
                        ui: [
                            {
                                id: 'status',
                                slot: 'scratch',
                                title: 'Status 2',
                                blocks: [{ type: 'text', text: 'later' }]
                            }
                        ]
                    }
                ]
            }
            // A legacy turn with no events array is tolerated.
        ] as unknown as SessionTurn[];

        const media = mediaOfTurns(turns);
        expect([...media.keys()]).toEqual([panelKeyOf('statusTool', { id: 'status' })]);
        expect([...media.values()].map((entry) => entry.panel.title)).toEqual(['Status 2']);
        expect(mediaOfTurns([]).size).toBe(0);
    });
});

describe('createPanelHost', () => {
    const media = (
        key: string,
        slot: 'scratch' | 'center' | 'left',
        panel: { id: string; title: string; blocks: unknown[] }
    ): PanelMedia => ({
        key,
        slot,
        panel: { ...panel, slot } as PanelMedia['panel']
    });

    it('renders text, table and key/value blocks as inert data only', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);

        const rendered = host.apply([
            media('statusTool\u001ftext', 'scratch', {
                id: 'text',
                title: 'Notes',
                blocks: [{ type: 'text', text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }]
            }),
            media('filesTool\u001ftable', 'scratch', {
                id: 'table',
                title: 'Files',
                blocks: [
                    {
                        type: 'table',
                        columns: ['name', 'size'],
                        rows: [['a.txt', '10'], ['b.txt', '']]
                    }
                ]
            }),
            media('todoTool\u001fkv', 'scratch', {
                id: 'kv',
                title: '',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'open', value: '2' },
                            { label: 'done', value: '5' }
                        ]
                    }
                ]
            })
        ]);

        expect(rendered).toBe(3);
        expect(host.element.hidden).toBe(false);
        expect(host.ids()).toEqual(['text', 'table', 'kv']);

        // Markup-looking text stays text: no element, no handler, no script.
        const textPanel = host.element.querySelector<HTMLElement>('[data-panel-id="text"]');
        expect(textPanel?.querySelector('.panel-title')?.textContent).toBe('Notes');
        expect(textPanel?.querySelector('.panel-text')?.textContent).toBe(
            '<img src=x onerror="alert(1)"><script>alert(2)</script>'
        );
        expect(textPanel?.querySelector('.panel-text img')).toBeNull();
        expect(textPanel?.querySelector('.panel-text script')).toBeNull();

        // Table: header + rectangular body, all textContent.
        const table = host.element.querySelector<HTMLTableElement>('[data-panel-id="table"] .panel-table');
        expect([...table!.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['name', 'size']);
        expect([...table!.querySelectorAll('tbody tr')].map((row) =>
            [...row.querySelectorAll('td')].map((cell) => cell.textContent)
        )).toEqual([
            ['a.txt', '10'],
            ['b.txt', '']
        ]);

        // Untitled panel falls back to its id; key/value pairs are exact.
        const kv = host.element.querySelector<HTMLElement>('[data-panel-id="kv"]');
        expect(kv?.querySelector('.panel-title')?.textContent).toBe('kv');
        expect([...kv!.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['open', 'done']);
        expect([...kv!.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['2', '5']);

        // Per-tool attribution, recorded for styling/diagnostics.
        expect(textPanel?.dataset.panelTool).toBe('statusTool');
        expect(textPanel?.dataset.panelSlot).toBe('scratch');
    });

    it('ignores other slots, hides when empty and caps the cards it draws', () => {
        const host = createPanelHost('center');
        document.body.append(host.element);

        expect(host.element.hidden).toBe(true);
        expect(
            host.apply([
                media('a\u001f1', 'scratch', { id: '1', title: 'S', blocks: [{ type: 'text', text: 'x' }] })
            ])
        ).toBe(0);
        expect(host.element.hidden).toBe(true);

        // Eight panels addressed to this slot: only the documented cap is drawn.
        const many = Array.from({ length: 8 }, (_value, index) =>
            media(`t\u001f${index}`, 'center', {
                id: String(index),
                title: '',
                blocks: [{ type: 'text', text: String(index) }]
            })
        );

        expect(host.apply(many)).toBe(PANEL_LIMITS.panelsPerSlot);
        expect(host.ids()).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(host.element.querySelectorAll('.panel')).toHaveLength(PANEL_LIMITS.panelsPerSlot);

        // An empty-blocks entry is never drawn (the aggregation removed it).
        expect(
            host.apply([
                media('t\u001fempty', 'center', { id: 'empty', title: '', blocks: [] })
            ])
        ).toBe(0);
        expect(host.element.hidden).toBe(true);

        host.clear();
        expect(host.ids()).toEqual([]);
        expect(host.element.hidden).toBe(true);
    });
});
