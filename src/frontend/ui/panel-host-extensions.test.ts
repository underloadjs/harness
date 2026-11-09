// The host half of the extension seam (T5/R1): `createPanelHost` now composes two
// node sources — the tool cards it has always drawn, and the extension nodes the
// runtime owns — and it must do that WITHOUT moving a live node on a tool repaint.
//
// This is the file that pins "an empty registry changes nothing": the DOM a host
// produces with no extension content is compared against the exact HTML the
// pre-seam host produced.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { beforeEach, describe, expect, it } from 'vitest';
import { applyPanels, createPanelHost } from './panels';
import type { PanelMedia } from './panels';

const mediaOf = (tool: string, panels: Record<string, unknown>[]): PanelMedia[] => {
    const media = new Map<string, PanelMedia>();
    applyPanels(media, tool, panels);

    return [...media.values()];
};

const card = (id: string, text: string): Record<string, unknown> => ({
    id,
    slot: 'scratch',
    title: id,
    blocks: [{ type: 'text', text }]
});

// A node the extension runtime would hand over: any element, with the marker the
// runtime writes. The host has no opinion about its contents.
const extensionNode = (id: string): HTMLElement => {
    const element = document.createElement('div');
    element.className = 'panel panel-extension';
    element.dataset.panelExtension = id;

    return element;
};

// The exact card `panels.ts` draws for `card(id, text)` — the baseline every
// "nothing changed" assertion below compares against.
const cardHtml = (id: string, text: string): string =>
    `<article class="panel" data-panel-id="${id}" data-panel-slot="scratch" data-panel-state="full" ` +
    `data-panel-tool="statusTool"><h3 class="panel-title">${id}</h3>` +
    `<div class="panel-blocks"><p class="panel-text">${text}</p></div></article>`;

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('an empty extension registry', () => {
    it('produces the pre-seam host, byte for byte', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);

        expect(host.apply(mediaOf('statusTool', [card('status', 'ready')]))).toBe(1);
        expect(host.element.outerHTML).toBe(
            `<div class="panel-host" data-slot="scratch" aria-live="polite" aria-label="Tool panels (scratch)">` +
                `${cardHtml('status', 'ready')}</div>`
        );

        // Repainting other slots' data empties this host the same way it always did.
        expect(host.apply(mediaOf('statusTool', [{ ...card('other', 'x'), slot: 'center' }]))).toBe(0);
        expect(host.element.hidden).toBe(true);
        expect(host.element.innerHTML).toBe('');
        expect(host.extensionIds()).toEqual([]);
    });
});

describe('setExtensions', () => {
    it('places extension nodes around the tool cards, in the order handed over', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);

        const before = extensionNode('top');
        const after = extensionNode('bottom');

        host.setExtensions({ before: [before], after: [after] });
        host.apply(mediaOf('statusTool', [card('status', 'ready')]));

        expect([...host.element.children]).toEqual([before, host.element.children[1], after]);
        expect(host.element.children[1]?.getAttribute('data-panel-id')).toBe('status');
        expect(host.element.outerHTML).toBe(
            `<div class="panel-host" data-slot="scratch" aria-live="polite" aria-label="Tool panels (scratch)">` +
                `<div class="panel panel-extension" data-panel-extension="top"></div>` +
                `${cardHtml('status', 'ready')}` +
                `<div class="panel panel-extension" data-panel-extension="bottom"></div></div>`
        );

        // The two id lists stay separate: `ids()` is the tool pipeline's view (the
        // scratch note counts it), `extensionIds()` is the runtime's.
        expect(host.ids()).toEqual(['status']);
        expect(host.extensionIds()).toEqual(['top', 'bottom']);
        expect(host.apply(mediaOf('statusTool', [card('status', 'ready')]))).toBe(1);
    });

    it('never moves an extension node while the tool cards are rebuilt', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);

        const extension = extensionNode('live');
        host.setExtensions({ after: [extension] });

        // Focus inside a live panel is the property at stake: a `replaceChildren`
        // repaint would throw it away (and its scroll position with it) on every
        // stream frame, even one that changes nothing about the extension.
        const marker = document.createElement('input');
        extension.append(marker);
        marker.focus();
        expect(document.activeElement).toBe(marker);

        const firstCard = host.element.querySelector<HTMLElement>('[data-panel-id="one"]');
        host.apply(mediaOf('statusTool', [card('one', 'first')]));
        host.apply(mediaOf('statusTool', [card('two', 'second')]));

        expect(host.element.children[1]).toBe(extension);
        expect(document.activeElement).toBe(marker);
        expect(host.element.querySelector('[data-panel-id="one"]')).toBeNull();
        expect(host.element.children[0]).not.toBe(firstCard);
    });

    it('replaces, reorders and removes extension nodes without touching the cards', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);
        host.apply(mediaOf('statusTool', [card('status', 'ready')]));

        const cardNode = host.element.children[0];
        const a = extensionNode('a');
        const b = extensionNode('b');

        host.setExtensions({ before: [a, b] });
        expect([...host.element.children]).toEqual([a, b, cardNode]);

        host.setExtensions({ before: [b, a] });
        expect([...host.element.children]).toEqual([b, a, cardNode]);

        host.setExtensions({});
        expect([...host.element.children]).toEqual([cardNode]);
        expect(host.extensionIds()).toEqual([]);
        expect(host.ids()).toEqual(['status']);
        expect(host.element.hidden).toBe(false);
    });

    it('reveals a host that holds only extension content', () => {
        const host = createPanelHost('left');

        expect(host.element.hidden).toBe(true);
        host.setExtensions({ after: [extensionNode('summary')] });

        expect(host.element.hidden).toBe(false);
        expect(host.ids()).toEqual([]);
        expect(host.extensionIds()).toEqual(['summary']);

        // `clear` is the TOOL-panel reset. Extension content leaves through
        // `setExtensions`, so a panel clear can never unmount another module's view.
        host.apply(mediaOf('statusTool', [card('note', 'aside')]));
        host.clear();

        expect(host.ids()).toEqual([]);
        expect(host.extensionIds()).toEqual(['summary']);
        expect(host.element.hidden).toBe(false);

        host.setExtensions({ after: [] });
        expect(host.element.hidden).toBe(true);
        expect(host.element.innerHTML).toBe('');
    });

    it('renders exactly the list it is given, even when a plugin moved a node', () => {
        const host = createPanelHost('scratch');
        document.body.append(host.element);

        const gone = extensionNode('gone');
        host.setExtensions({ before: [gone] });
        expect(host.element.children[0]).toBe(gone);

        // A plugin (or the runtime) may detach the element behind the host's back; the
        // next tool paint puts the LIST back, because the list is the contract. What
        // takes a panel out of the DOM is leaving the list — exactly how the runtime
        // disposes an instance (remove the node, then stop naming it).
        gone.remove();
        host.apply(mediaOf('statusTool', [card('status', 'ready')]));
        expect([...host.element.children]).toEqual([gone, host.element.children[1]]);

        host.setExtensions({ before: [] });
        expect(host.element.innerHTML).toBe(cardHtml('status', 'ready'));

        host.apply([]);
        expect(host.element.hidden).toBe(true);
        expect(host.element.innerHTML).toBe('');
    });
});
