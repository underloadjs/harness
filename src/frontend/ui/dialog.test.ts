// Reusable modal dialog (T17 R9): exact DOM contract, focus/restore rules,
// Escape/backdrop dismissal, focus trap, stacking, scroll-lock balance and the
// data-only content rule.
//
// Every assertion is an exact expected value. The focus assertions are the point
// of R9: closing a preview must return focus to what was ACTUALLY focused before
// (or to nothing when `returnFocus: null`), never to the composer by default.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/ui/dialog.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDialogHost, openDialog } from './dialog';
import type { DialogHost } from './dialog';

// Exact glyph rendered by the close button (see CLOSE_GLYPH in dialog.ts).
const CLOSE_GLYPH = '\u00d7';

let host: DialogHost;

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    host = createDialogHost();
});

afterEach(() => {
    host.closeAll();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
});

// --- DOM fixtures -----------------------------------------------------------

const paragraph = (text: string): HTMLElement => {
    const node = document.createElement('p');
    node.textContent = text;
    return node;
};

const button = (label: string): HTMLButtonElement => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    return node;
};

const query = <T extends HTMLElement>(root: ParentNode, selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (node === null) throw new Error(`missing ${selector}`);
    return node;
};

// Dispatch a keydown the way a browser would: on the focused node, bubbling to
// document. The dialog listens in the capture phase at document.
const press = (target: EventTarget, key: string, shiftKey = false): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
};

const overlayOf = (panel: HTMLElement): HTMLElement => {
    const overlay = panel.parentElement;
    if (overlay === null) throw new Error('dialog panel has no overlay');
    return overlay;
};

// --- structure --------------------------------------------------------------

describe('open: structure and accessible wiring', () => {
    it('builds the exact overlay, dialog, header, body and close button', () => {
        const content = paragraph('Preview body');
        const handle = host.open({ title: 'Turn 2', content });

        const overlays = document.querySelectorAll<HTMLElement>('.dialog-overlay');
        expect(overlays).toHaveLength(1);

        const overlay = overlays[0];
        const panel = handle.element;

        expect(overlay.parentElement).toBe(document.body);
        expect(overlay.firstElementChild).toBe(panel);
        expect(panel.className).toBe('dialog');
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-modal')).toBe('true');
        expect(panel.getAttribute('tabindex')).toBe('-1');

        const head = query<HTMLElement>(panel, '.dialog-head');
        const title = query<HTMLElement>(panel, '.dialog-title');
        const closeButton = query<HTMLButtonElement>(panel, '.dialog-close');
        const body = query<HTMLElement>(panel, '.dialog-body');

        // Title is the visible heading AND the accessible name: the panel must
        // point at the exact id that the h2 carries.
        expect(title.tagName).toBe('H2');
        expect(title.textContent).toBe('Turn 2');
        expect(title.id).toBe(panel.getAttribute('aria-labelledby'));

        expect(closeButton.type).toBe('button');
        expect(closeButton.getAttribute('aria-label')).toBe('Close');
        expect(closeButton.textContent).toBe(CLOSE_GLYPH);

        expect(panel.children).toHaveLength(2);
        expect(panel.children[0]).toBe(head);
        expect(panel.children[1]).toBe(body);
        expect(head.children).toHaveLength(2);
        expect(head.children[0]).toBe(title);
        expect(head.children[1]).toBe(closeButton);

        // The caller's node is adopted verbatim, not cloned or stringified.
        expect(body.children).toHaveLength(1);
        expect(body.firstElementChild).toBe(content);
        expect(content.parentElement).toBe(body);
        expect(body.textContent).toBe('Preview body');

        expect(handle.isOpen).toBe(true);
        expect(host.count).toBe(1);
        expect(host.top).toBe(handle);
    });

    it('keeps caller-built text inert: a markup-looking string is never parsed', () => {
        const payload = '<img src=x onerror="alert(1)">';
        const content = paragraph(payload);
        const handle = host.open({ title: 'Inert', content });

        expect(handle.element.querySelector('img')).toBeNull();
        expect(query<HTMLElement>(handle.element, '.dialog-body').textContent).toBe(payload);
    });
});

// --- focus ------------------------------------------------------------------

describe('focus on open and close', () => {
    it('focuses the panel on open, then restores the actual triggering element', () => {
        const trigger = button('Open preview');
        document.body.append(trigger);
        trigger.focus();
        expect(document.activeElement).toBe(trigger);

        const onClose = vi.fn();
        const handle = host.open({ title: 'Preview', content: paragraph('x'), onClose });

        // Panel (not the close button) owns initial focus, so Enter/Space cannot
        // accidentally dismiss the preview.
        expect(document.activeElement).toBe(handle.element);
        expect(document.body.style.overflow).toBe('hidden');

        query<HTMLButtonElement>(handle.element, '.dialog-close').click();

        expect(handle.isOpen).toBe(false);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(host.count).toBe(0);
        expect(host.top).toBeNull();
        expect(document.body.style.overflow).toBe('');

        // Idempotent close: no second callback, no DOM churn.
        handle.close();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('never focuses the composer when returnFocus is null', () => {
        const composer = document.createElement('textarea');
        document.body.append(composer);
        composer.focus();
        expect(document.activeElement).toBe(composer);

        const handle = host.open({ title: 'Preview', content: paragraph('x'), returnFocus: null });
        expect(document.activeElement).toBe(handle.element);

        handle.close();

        // Removing the focused panel hands focus to <body>; the composer is
        // untouched because the caller suppressed restoration.
        expect(document.activeElement).toBe(document.body);
        expect(document.activeElement).not.toBe(composer);
    });

    it('prefers an explicit returnFocus over the previously focused element', () => {
        const trigger = button('trigger');
        const target = button('target');
        document.body.append(trigger, target);
        trigger.focus();

        const handle = host.open({ title: 'Preview', content: paragraph('x'), returnFocus: target });
        handle.close();

        expect(document.activeElement).toBe(target);
    });

    it('restores nothing when only <body> was focused at open time', () => {
        expect(document.activeElement).toBe(document.body);

        const handle = host.open({ title: 'Preview', content: paragraph('x') });
        handle.close();

        expect(document.activeElement).toBe(document.body);
    });

    it('detaches its document listeners when the last dialog closes', () => {
        const handle = host.open({ title: 'Preview', content: paragraph('x') });
        handle.close();

        // Escape/Tab and focus containment must be completely dormant again.
        const escape = press(document.body, 'Escape');
        expect(escape.defaultPrevented).toBe(false);

        const tab = press(document.body, 'Tab');
        expect(tab.defaultPrevented).toBe(false);

        const outside = button('outside');
        document.body.append(outside);
        outside.focus();
        expect(document.activeElement).toBe(outside);
    });

    it('cleans up when the overlay was removed by someone else', () => {
        const onClose = vi.fn();
        const handle = host.open({ title: 'Preview', content: paragraph('x'), onClose });
        overlayOf(handle.element).remove();

        handle.close();

        expect(handle.isOpen).toBe(false);
        expect(host.count).toBe(0);
        expect(document.body.style.overflow).toBe('');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// --- dismissal --------------------------------------------------------------

describe('dismissal', () => {
    it('closes on Escape and stops the press from reaching the shell', () => {
        const trigger = button('Open');
        document.body.append(trigger);
        trigger.focus();

        const handle = host.open({ title: 'Preview', content: paragraph('x') });

        // Bubble-phase listener stands in for the app shell (rails in main.ts).
        const shellEscape = vi.fn();
        document.addEventListener('keydown', shellEscape);

        const event = press(document.activeElement!, 'Escape');

        expect(event.defaultPrevented).toBe(true);
        expect(shellEscape).not.toHaveBeenCalled();
        expect(handle.isOpen).toBe(false);
        expect(document.activeElement).toBe(trigger);

        document.removeEventListener('keydown', shellEscape);
    });

    it('closes on a backdrop click but not on clicks inside the panel', () => {
        const content = paragraph('inside');
        const handle = host.open({ title: 'Preview', content });
        const overlay = overlayOf(handle.element);

        // Panel itself, and content, are both inside the dialog.
        handle.element.click();
        expect(handle.isOpen).toBe(true);
        content.click();
        expect(handle.isOpen).toBe(true);

        overlay.click();
        expect(handle.isOpen).toBe(false);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
    });
});

// --- focus trap -------------------------------------------------------------

describe('focus trap', () => {
    it('cycles Tab through tabbable descendants and skips disabled/hidden ones', () => {
        const content = document.createElement('div');
        const first = button('first');
        const last = button('last');
        const disabled = button('disabled');
        disabled.disabled = true;
        const hidden = button('hidden');
        hidden.hidden = true;
        content.append(first, last, disabled, hidden);

        const handle = host.open({ title: 'Trap', content });
        const closeButton = query<HTMLButtonElement>(handle.element, '.dialog-close');

        // Initial focus is the panel; Tab enters the cycle at the first control
        // (the close button, which precedes the body in DOM order).
        expect(document.activeElement).toBe(handle.element);
        const fromPanel = press(handle.element, 'Tab');
        expect(fromPanel.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(closeButton);

        // A middle step is left to the browser (not prevented).
        const middle = press(closeButton, 'Tab');
        expect(middle.defaultPrevented).toBe(false);

        // Last -> first (disabled/hidden are excluded, so `last` is the end).
        last.focus();
        const wrap = press(last, 'Tab');
        expect(wrap.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(closeButton);

        // First -> last in reverse.
        const reverse = press(closeButton, 'Tab', true);
        expect(reverse.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(last);

        // Programmatic focus outside the modal is pulled back in.
        const outside = button('outside');
        document.body.append(outside);
        outside.focus();
        expect(document.activeElement).toBe(closeButton);
    });
});

// --- stacking ---------------------------------------------------------------

describe('stacking and cleanup', () => {
    it('stacks dialogs, closes only the top on Escape, and keeps the scroll lock', () => {
        const trigger = button('Open');
        document.body.append(trigger);
        trigger.focus();

        const lower = host.open({ title: 'Lower', content: paragraph('lower') });
        const upper = host.open({ title: 'Upper', content: paragraph('upper') });

        expect(host.count).toBe(2);
        expect(host.top).toBe(upper);
        expect(document.activeElement).toBe(upper.element);
        expect(document.body.style.overflow).toBe('hidden');

        // DOM order is bottom -> top, which is also the paint order.
        expect([...document.querySelectorAll('.dialog-overlay')]).toEqual([
            overlayOf(lower.element),
            overlayOf(upper.element)
        ]);

        press(upper.element, 'Escape');

        expect(upper.isOpen).toBe(false);
        expect(lower.isOpen).toBe(true);
        expect(host.count).toBe(1);
        expect(document.activeElement).toBe(lower.element);
        // Still one layer open, so the body stays locked.
        expect(document.body.style.overflow).toBe('hidden');

        press(lower.element, 'Escape');

        expect(lower.isOpen).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(document.body.style.overflow).toBe('');
        expect(document.querySelector('.dialog-overlay')).toBeNull();
    });

    it('closing a lower dialog does not take focus from the top one', () => {
        const lower = host.open({ title: 'Lower', content: paragraph('lower') });
        const upper = host.open({ title: 'Upper', content: paragraph('upper') });

        lower.close();

        expect(lower.isOpen).toBe(false);
        expect(upper.isOpen).toBe(true);
        expect(document.activeElement).toBe(upper.element);
        expect(host.count).toBe(1);
        expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(1);
    });

    it('closeAll closes top-down exactly once per dialog and restores focus', () => {
        const trigger = button('Open');
        document.body.append(trigger);
        trigger.focus();

        const calls: string[] = [];
        const lower = host.open({ title: 'Lower', content: paragraph('lower'), onClose: () => calls.push('lower') });
        const upper = host.open({ title: 'Upper', content: paragraph('upper'), onClose: () => calls.push('upper') });

        host.closeAll();

        expect(calls).toEqual(['upper', 'lower']);
        expect(upper.isOpen).toBe(false);
        expect(lower.isOpen).toBe(false);
        expect(host.count).toBe(0);
        expect(host.top).toBeNull();
        expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
        expect(document.body.style.overflow).toBe('');
        expect(document.activeElement).toBe(trigger);
    });

    it('coordinates separate hosts through one global layer order', () => {
        const other = createDialogHost();
        const lower = host.open({ title: 'Lower', content: paragraph('lower') });
        const upper = other.open({ title: 'Upper', content: paragraph('upper') });

        expect(document.activeElement).toBe(upper.element);
        expect(document.body.style.overflow).toBe('hidden');

        press(upper.element, 'Escape');

        expect(other.count).toBe(0);
        expect(host.count).toBe(1);
        expect(document.activeElement).toBe(lower.element);
        expect(document.body.style.overflow).toBe('hidden');

        press(lower.element, 'Escape');

        expect(host.count).toBe(0);
        expect(document.body.style.overflow).toBe('');
    });
});

// --- scroll lock ------------------------------------------------------------

describe('body scroll lock', () => {
    it('restores the previous inline overflow value, not a hardcoded empty string', () => {
        document.body.style.overflow = 'auto';

        const handle = host.open({ title: 'Preview', content: paragraph('x') });
        expect(document.body.style.overflow).toBe('hidden');

        handle.close();
        expect(document.body.style.overflow).toBe('auto');
    });
});

// --- update / guards --------------------------------------------------------

describe('update and runtime guards', () => {
    it('replaces title and content in place while keeping the accessible wiring', () => {
        const first = paragraph('one');
        const second = paragraph('two');
        const handle = host.open({ title: 'One', content: first });

        const title = query<HTMLElement>(handle.element, '.dialog-title');
        const body = query<HTMLElement>(handle.element, '.dialog-body');
        const titleId = title.id;

        handle.update({ title: 'Two', content: second });

        expect(title.textContent).toBe('Two');
        expect(title.id).toBe(titleId);
        expect(handle.element.getAttribute('aria-labelledby')).toBe(titleId);
        expect(body.children).toHaveLength(1);
        expect(body.firstElementChild).toBe(second);
        expect(first.isConnected).toBe(false);

        // A partial update leaves the omitted field alone.
        handle.update({ title: 'Three' });
        expect(title.textContent).toBe('Three');
        expect(body.firstElementChild).toBe(second);
    });

    it('update is a no-op after close', () => {
        const content = paragraph('one');
        const handle = host.open({ title: 'One', content });
        const title = query<HTMLElement>(handle.element, '.dialog-title');
        const body = query<HTMLElement>(handle.element, '.dialog-body');

        handle.close();
        handle.update({ title: 'Two', content: paragraph('two') });

        expect(title.textContent).toBe('One');
        expect(body.textContent).toBe('one');
    });

    it('rejects non-Node content and non-string titles at the boundary', () => {
        expect(() => host.open({ title: 'Bad content', content: '<b>x</b>' as unknown as Node })).toThrow(
            'openDialog: content must be a DOM Node'
        );
        expect(() => host.open({ title: 7 as unknown as string, content: paragraph('x') })).toThrow(
            'openDialog: title must be a string'
        );

        expect(host.count).toBe(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(document.body.style.overflow).toBe('');

        const handle = host.open({ title: 'Good', content: paragraph('kept') });
        const body = query<HTMLElement>(handle.element, '.dialog-body');
        expect(() => handle.update({ content: 'nope' as unknown as Node })).toThrow(
            'openDialog: content must be a DOM Node'
        );
        expect(body.textContent).toBe('kept');
    });
});

// --- default entry point ----------------------------------------------------

describe('openDialog', () => {
    it('opens on the shared host and closes through its handle', () => {
        const handle = openDialog({ title: 'Shared', content: paragraph('shared') });

        expect(handle.element.getAttribute('role')).toBe('dialog');
        expect(document.activeElement).toBe(handle.element);
        expect(document.body.style.overflow).toBe('hidden');

        handle.close();

        expect(handle.isOpen).toBe(false);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(document.body.style.overflow).toBe('');
    });
});

// --- stylesheet contract ----------------------------------------------------

// jsdom cannot compute layout, so the same source-reading approach as the other
// `*-style.test.ts` files pins the properties that carry the design: a fixed
// full-viewport backdrop, a capped flex column, and one scrollable body.
describe('dialog.css contract', () => {
    const stylesheet = ['src/frontend/ui/dialog.css', 'ui/dialog.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));

    if (stylesheet === undefined) throw new Error('dialog.css not found');
    const css = readFileSync(stylesheet, 'utf8');

    const blockOf = (selector: string): string => {
        const start = css.indexOf(selector);
        if (start < 0) throw new Error(`missing selector ${selector}`);
        const open = css.indexOf('{', start);
        const close = css.indexOf('}', open);
        return css.slice(open + 1, close);
    };

    it('floats a fixed full-viewport overlay above shell chrome', () => {
        const overlay = blockOf('.dialog-overlay {');
        expect(overlay).toContain('position: fixed');
        expect(overlay).toContain('inset: 0');
        expect(overlay).toContain('z-index: 1000');
        expect(overlay).toContain('align-items: center');
        expect(overlay).toContain('justify-content: center');
    });

    it('caps the panel and scrolls only the body', () => {
        const panel = blockOf('.dialog {');
        expect(panel).toContain('display: flex');
        expect(panel).toContain('flex-direction: column');
        expect(panel).toContain('max-height: min(82vh, 900px)');
        expect(panel).toContain('overflow: hidden');

        const body = blockOf('.dialog-body {');
        expect(body).toContain('flex: 1 1 auto');
        expect(body).toContain('min-height: 0');
        expect(body).toContain('overflow: auto');
        expect(body).toContain('overscroll-behavior: contain');
    });

    it('sizes preview images and code blocks inside the scroll area', () => {
        expect(blockOf('.dialog-body img {')).toContain('max-width: 100%');
        const pre = blockOf('.dialog-body pre {');
        expect(pre).toContain('overflow: auto');
        expect(pre).toContain('white-space: pre');
        expect(pre).toContain('font: 12px/1.6 var(--mono)');
    });

    it('goes edge-to-edge on phone widths', () => {
        const phone = css.slice(css.indexOf('@media (max-width: 720px) {'));
        expect(phone).toContain('align-items: stretch');
        expect(phone).toContain('padding: 10px');
        expect(phone).toContain('max-height: calc(100vh - 20px)');
    });
});
