// Panel-kind registry (T5/R1): the seam a typed panel renderer plugs into, and the
// fallback that keeps the board identical when nothing is registered.
//
// Every assertion is an EXACT value (the whole dataset, the whole outerHTML), because
// the point of this seam is that a plugin either takes the card over completely or
// changes nothing. The "changes nothing" half is pinned by comparing rendered HTML
// against the standard card captured with an EMPTY registry.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANEL_LIMITS, applyPanels, createPanelHost, sanitizePanel, sanitizePanels } from '../ui/panels';
import type { PanelMedia } from '../ui/panels';
import {
    PANEL_KIND_BLOCKS,
    applyPanelCardData,
    clearPanelKinds,
    createPanelCard,
    getPanelKind,
    isPanelKindRegistered,
    listPanelKinds,
    panelKindErrors,
    panelKindOf,
    panelToolOf,
    registerPanelKind,
    renderPanelOfKind,
    unregisterPanelKind
} from './panel-kinds';

// One media entry, built the way the shell builds it: through the sanitizer, under a
// scoped key. Handing `applyPanels` the wire shape keeps these tests honest about
// what a renderer can actually receive.
const mediaOf = (tool: string, panel: Record<string, unknown>): Map<string, PanelMedia> => {
    const media = new Map<string, PanelMedia>();
    applyPanels(media, tool, [panel]);

    return media;
};

const entryOf = (media: Map<string, PanelMedia>): PanelMedia => {
    const entry = media.values().next().value as PanelMedia | undefined;
    if (entry === undefined) throw new Error('no media entry — the panel was dropped');

    return entry;
};

const textPanel = {
    id: 'status',
    slot: 'scratch',
    title: 'Status',
    blocks: [{ type: 'text', text: 'ready' }]
};

// `[0, 1, ... n-1]` or `[f(0), f(1), ...]` — the readable way to build a payload big
// enough to hit a clamp.
const loop = <T = number>(count: number, factory?: (index: number) => T): T[] =>
    Array.from({ length: count }, (_unused, index) => (factory ?? ((i: number) => i as unknown as T))(index));

beforeEach(() => {
    document.body.innerHTML = '';
    clearPanelKinds();
});

afterEach(() => {
    clearPanelKinds();
});

describe('registerPanelKind', () => {
    it('registers, replaces, lists and unregisters by name', () => {
        const first = registerPanelKind({ kind: 'tasks', render: () => undefined });
        registerPanelKind({ kind: 'records', render: () => undefined });

        // Sorted by NAME: two hosts that register in different import orders publish
        // the same catalogue.
        expect(listPanelKinds()).toEqual(['records', 'tasks']);
        expect(isPanelKindRegistered('tasks')).toBe(true);
        expect(isPanelKindRegistered('  tasks  ')).toBe(true);
        expect(isPanelKindRegistered('diff')).toBe(false);
        expect(getPanelKind('tasks')).toEqual({ kind: 'tasks', render: expect.any(Function) });

        first();
        expect(listPanelKinds()).toEqual(['records']);
        expect(isPanelKindRegistered('tasks')).toBe(false);

        // Replacing a kind keeps the NEW registration alive when the displaced one's
        // teardown runs (the hot-reload loop).
        const displaced = registerPanelKind({ kind: 'diff', render: () => undefined });
        registerPanelKind({ kind: 'diff', render: () => document.createElement('div') });
        displaced();
        expect(listPanelKinds()).toEqual(['diff', 'records']);
        expect(unregisterPanelKind('diff')).toBe(true);
        expect(unregisterPanelKind('diff')).toBe(false);
        expect(listPanelKinds()).toEqual(['records']);
    });

    it('refuses a malformed registration with an authoring-time error', () => {
        // A silent no-op would hide behind the fallback card and look like a missing
        // panel; a throw points at the `registerPanelKind` call that caused it.
        expect(() => registerPanelKind({ kind: '   ', render: () => undefined })).toThrow(
            'registerPanelKind: `kind` must be a non-empty string'
        );
        expect(() => registerPanelKind({ kind: 'tasks' } as never)).toThrow(
            "registerPanelKind('tasks'): `render` must be a function"
        );
        expect(listPanelKinds()).toEqual([]);
    });
});

describe('panelKindOf', () => {
    it('names the wire kind, and falls back to the built-in name when there is none', () => {
        const unkinded = entryOf(mediaOf('statusTool', textPanel));
        expect(panelKindOf(unkinded)).toBe(PANEL_KIND_BLOCKS);

        // The media entry wins over the panel field, so a caller that resolves the
        // kind itself (a summary projection) is not second-guessed.
        const onMedia = { ...unkinded, kind: 'tasks' };
        expect(panelKindOf(onMedia)).toBe('tasks');

        const onPanel = entryOf(mediaOf('statusTool', { ...textPanel, kind: 'tasks' }));
        expect(onPanel.kind).toBe('tasks');
        expect(panelKindOf(onPanel)).toBe('tasks');

        // Whitespace is not a kind.
        expect(panelKindOf({ ...unkinded, kind: '  ' })).toBe(PANEL_KIND_BLOCKS);
    });
});

describe('renderPanelOfKind', () => {
    it('hands the registered renderer the sanitized panel and the card contract', () => {
        const seen: unknown[] = [];

        registerPanelKind({
            kind: 'tasks',
            render: (input) => {
                seen.push(input.kind, input.slot, input.media.key, input.panel.id, input.blocks);

                const card = createPanelCard(input);
                const line = input.document.createElement('p');
                line.textContent = `tasks:${input.panel.title}`;
                card.append(line);

                return card;
            }
        });

        const media = mediaOf('taskTool', {
            id: 'open',
            slot: 'right',
            title: 'Tasks',
            kind: 'tasks',
            // A shape the block sanitizer does not know, kept because the kind is
            // registered (that is the whole point of a typed panel).
            blocks: [{ type: 'taskRow', label: 'write tests', done: false }]
        });
        const entry = entryOf(media);

        const card = renderPanelOfKind('scratch', entry);

        expect(seen).toEqual([
            'tasks',
            'scratch',
            'taskTool\u001fopen',
            'open',
            [{ type: 'taskRow', label: 'write tests', done: false }]
        ]);

        expect(card?.outerHTML).toBe(
            '<article class="panel" data-panel-id="open" data-panel-slot="scratch" data-panel-state="full" ' +
                'data-panel-tool="taskTool" data-panel-kind="tasks"><p>tasks:Tasks</p></article>'
        );
    });

    it('declines an unkinded panel and an unknown kind', () => {
        registerPanelKind({ kind: 'tasks', render: () => document.createElement('div') });

        expect(renderPanelOfKind('scratch', entryOf(mediaOf('t', textPanel)))).toBeUndefined();
        expect(
            renderPanelOfKind('scratch', entryOf(mediaOf('t', { ...textPanel, kind: 'records' })))
        ).toBeUndefined();
    });

    it('falls back when a renderer declines or throws, and records the error', () => {
        const declining = entryOf(mediaOf('t', { ...textPanel, kind: 'declining' }));
        const throwing = entryOf(mediaOf('t', { ...textPanel, kind: 'throwing' }));
        const nonElement = entryOf(mediaOf('t', { ...textPanel, kind: 'not-element' }));

        registerPanelKind({ kind: 'declining', render: () => undefined });
        registerPanelKind({
            kind: 'throwing',
            render: () => {
                throw new Error('boom');
            }
        });
        registerPanelKind({ kind: 'not-element', render: () => undefined as unknown as HTMLElement });

        expect(renderPanelOfKind('scratch', declining)).toBeUndefined();
        expect(renderPanelOfKind('scratch', throwing)).toBeUndefined();
        expect(renderPanelOfKind('scratch', nonElement)).toBeUndefined();
        expect(panelKindErrors()).toEqual({ throwing: 'boom' });

        // The recorded failure is diagnostic only: the very next paint still works.
        expect(renderPanelOfKind('scratch', throwing)).toBeUndefined();
    });
});

describe('host delegation through the kind registry', () => {
    // The card the shell draws by itself, captured with an EMPTY registry. Every
    // fallback assertion below compares against this exact string: an extension that
    // declines must not move a single byte of another panel's chrome.
    const standardCard = (): string => {
        const host = createPanelHost('scratch');
        host.apply([...mediaOf('statusTool', textPanel).values()]);

        return host.element.innerHTML;
    };

    it('renders the standard card byte-for-byte when no kind owns the panel', () => {
        const expected = standardCard();

        // A registered kind that is not this panel's, plus a kind that declines this
        // one — in both cases the board is the pre-registry board.
        registerPanelKind({ kind: 'tasks', render: () => document.createElement('div') });
        const host = createPanelHost('scratch');
        host.apply([...mediaOf('statusTool', textPanel).values()]);
        expect(host.element.innerHTML).toBe(expected);
        expect(host.ids()).toEqual(['status']);

        registerPanelKind({ kind: 'blocks', render: () => undefined });
        const declined = createPanelHost('scratch');
        declined.apply([...mediaOf('statusTool', textPanel).values()]);
        expect(declined.element.innerHTML).toBe(expected);
    });

    it('lets a registered kind replace only its own card', () => {
        registerPanelKind({
            kind: 'tasks',
            render: (input) => {
                const card = input.document.createElement('article');
                card.className = 'panel';
                applyPanelCardData(card, input.slot, input.media);
                card.append(input.document.createTextNode('custom'));

                return card;
            }
        });

        const media = new Map<string, PanelMedia>();
        applyPanels(media, 'statusTool', [
            textPanel,
            { id: 'open', slot: 'scratch', title: 'Tasks', kind: 'tasks', blocks: [{ type: 'taskRow' }] }
        ]);

        const host = createPanelHost('scratch');
        const drawn = host.apply([...media.values()]);

        expect(drawn).toBe(2);
        expect(host.ids()).toEqual(['status', 'open']);
        expect(host.element.innerHTML).toBe(
            '<article class="panel" data-panel-id="status" data-panel-slot="scratch" data-panel-state="full" ' +
                'data-panel-tool="statusTool"><h3 class="panel-title">Status</h3>' +
                '<div class="panel-blocks"><p class="panel-text">ready</p></div></article>' +
                '<article class="panel" data-panel-id="open" data-panel-slot="scratch" data-panel-state="full" ' +
                'data-panel-tool="statusTool" data-panel-kind="tasks">custom</article>'
        );

        // An unkinded card carries no `data-panel-kind` at all (not an empty one).
        expect(host.element.querySelector('[data-panel-id="status"]')?.hasAttribute('data-panel-kind')).toBe(false);
    });
});

describe('the sanitizer and kind routing', () => {
    it('carries the wire kind and keeps unknown blocks only for a registered kind', () => {
        const wire = {
            id: 'open',
            slot: 'right',
            title: 'Tasks',
            kind: 'tasks',
            blocks: [
                { type: 'text', text: 'plain' },
                { type: 'taskRow', label: 'write tests', done: false }
            ]
        };

        // Not registered: today's rule, an unknown block is dropped and the card is
        // the standard one. The kind itself still survives, so the card is marked.
        expect(sanitizePanels([wire])).toEqual([
            { id: 'open', slot: 'scratch', title: 'Tasks', blocks: [{ type: 'text', text: 'plain' }], kind: 'tasks' }
        ]);

        registerPanelKind({ kind: 'tasks', render: () => undefined });

        // Registered: the typed block is kept structurally, the known one is still
        // sanitized (a hostile `<img onerror>` string stays a string).
        expect(sanitizePanels([{ ...wire, blocks: [{ type: 'taskRow', label: 'write tests', done: false }] }])).toEqual(
            [
                {
                    id: 'open',
                    slot: 'scratch',
                    title: 'Tasks',
                    blocks: [{ type: 'taskRow', label: 'write tests', done: false }],
                    kind: 'tasks'
                }
            ]
        );

        expect(
            sanitizePanels([
                {
                    ...wire,
                    blocks: [
                        { type: 'text', text: '<img onerror=x>' },
                        { type: 'table', columns: ['a', 'b'], rows: [['1'], ['2', '3', 'extra']] }
                    ]
                }
            ])[0].blocks
        ).toEqual([
            { type: 'text', text: '<img onerror=x>' },
            { type: 'table', columns: ['a', 'b'], rows: [['1', ''], ['2', '3']] }
        ]);
    });

    it('bounds the kind name like every other wire string, and needs a usable block type', () => {
        expect(sanitizePanel({ id: 'x', slot: 'scratch', title: '', kind: 'k'.repeat(100) })?.kind).toBe(
            'k'.repeat(64)
        );
        // No usable `type` is not a block, even for a registered kind.
        expect(sanitizePanel({ id: 'x', slot: 'scratch', title: '', kind: 'tasks', blocks: [{ label: 'a' }] })).toEqual(
            { id: 'x', slot: 'scratch', title: '', blocks: [], kind: 'tasks' }
        );
        expect(sanitizePanel({ id: 'x', slot: 'scratch', title: '', blocks: [{ label: 'a' }] })).toEqual({
            id: 'x',
            slot: 'scratch',
            title: '',
            blocks: []
        });
    });

    it('treats an unknown kind with only typed blocks as empty, exactly like an unknown block type', () => {
        // Nothing registered this kind, so its opaque blocks are dropped and the
        // panel has no blocks: `applyPanels` reads that as the removal signal, so no
        // half-panel lands. This is today's rule, unchanged.
        const media = mediaOf('taskTool', {
            id: 'open',
            slot: 'scratch',
            title: 'Tasks',
            kind: 'records',
            blocks: [{ type: 'recordRow', cells: ['a'] }]
        });
        expect(media.size).toBe(0);
    });

    it('clamps a registered kind with the same limits as an unkinded panel', () => {
        registerPanelKind({
            kind: 'tasks',
            render: (input) => {
                const card = createPanelCard(input);
                const line = input.document.createElement('p');
                line.textContent = String(input.blocks.length);

                card.append(line);

                return card;
            }
        });

        // 20 typed blocks in, `blocksPerPanel` out: opting into a renderer does not
        // opt out of the bound that stops one payload building a huge DOM.
        const wide = sanitizePanels([
            {
                id: 'open',
                slot: 'scratch',
                title: 'Tasks',
                kind: 'tasks',
                blocks: loop(20, (index) => ({ type: 'taskRow', index }))
            }
        ])[0];
        expect(wide.blocks).toHaveLength(PANEL_LIMITS.blocksPerPanel);
        expect(wide.blocks.map((block) => (block as { index?: number }).index)).toEqual(loop(12, (i) => i));

        // A kinded card still counts against the per-slot cap, and the cap keeps its
        // first-come order.
        // A single message is capped too — `panelsPerMessage` — so a tool cannot
        // contribute ten kinded cards at once.
        const many = loop(10, (index) => ({
            id: `p${index}`,
            slot: 'scratch',
            title: `P${index}`,
            kind: 'tasks',
            blocks: [{ type: 'taskRow' }]
        }));
        expect(sanitizePanels(many)).toHaveLength(PANEL_LIMITS.panelsPerMessage);

        // Ten upserts from ten messages DO accumulate, and the per-slot cap keeps the
        // first six: opting into a renderer does not lift the host's bound either.
        const media = new Map<string, PanelMedia>();
        for (const panel of many) applyPanels(media, 'taskTool', [panel]);

        const host = createPanelHost('scratch');
        document.body.append(host.element);

        expect(media.size).toBe(10);
        expect(host.apply([...media.values()])).toBe(PANEL_LIMITS.panelsPerSlot);
        expect(host.ids()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
        expect(host.element.querySelectorAll('[data-panel-kind="tasks"]')).toHaveLength(PANEL_LIMITS.panelsPerSlot);
    });

    it('records the kind on the media entry as well as the panel', () => {
        // Registered first: the typed block only survives the sanitizer when a kind
        // this build can render owns it (the rule the test above pins).
        registerPanelKind({ kind: 'tasks', render: () => undefined });

        const media = mediaOf('taskTool', {
            id: 'open',
            slot: 'left',
            title: 'Tasks',
            kind: 'tasks',
            blocks: [{ type: 'taskRow', label: 'a' }]
        });

        expect([...media.entries()]).toEqual([
            [
                'taskTool\u001fopen',
                {
                    key: 'taskTool\u001fopen',
                    slot: 'left',
                    kind: 'tasks',
                    panel: {
                        id: 'open',
                        slot: 'left',
                        title: 'Tasks',
                        blocks: [{ type: 'taskRow', label: 'a' }],
                        kind: 'tasks'
                    }
                }
            ]
        ]);

        // An unkinded entry has neither key — the map entries the pipeline always
        // produced, byte for byte.
        expect([...mediaOf('statusTool', textPanel).values()][0]).toEqual({
            key: 'statusTool\u001fstatus',
            slot: 'scratch',
            panel: { id: 'status', slot: 'scratch', title: 'Status', blocks: [{ type: 'text', text: 'ready' }] }
        });
    });
});

describe('panelToolOf / applyPanelCardData', () => {
    it('attributes a card from its scoped key, separator or not', () => {
        expect(panelToolOf('statusTool\u001fstatus')).toBe('statusTool');
        expect(panelToolOf('hand-built')).toBe('hand-built');

        const card = document.createElement('article');
        applyPanelCardData(card, 'center', {
            key: 'hand-built',
            slot: 'center',
            panel: { id: 'p', slot: 'center', title: '', blocks: [] },
            detail: { open: () => {} }
        });

        expect(card.outerHTML).toBe(
            '<article data-panel-id="p" data-panel-slot="center" data-panel-state="summary" ' +
                'data-panel-tool="hand-built"></article>'
        );
    });
});
