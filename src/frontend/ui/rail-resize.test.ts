// The draggable seams between the chat column and the two rails (ui/rail-resize.ts).
//
// Contract, in the order the file asserts it:
//   - DOM/ARIA: each seam is ONE focusable `role="separator"` grid sibling of the rails,
//     named by the rail it resizes, and it states its own value range;
//   - the shell, not the rail, carries the width: the drag writes one inline custom
//     property on `.shell` and never touches a rail's own style, because in a grid it is
//     the TRACK that sizes the rail;
//   - drag: left edge follows the pointer, right edge mirrors it, the seam's state class
//     and the body's cursor/selection lock live only for the duration, a drag that ends
//     stops moving the panel, and only the primary button starts one;
//   - clamp: never past a track's own min/max, and (when the shell is measurable) never
//     past what leaves the chat column its minimum;
//   - keyboard: arrows size the rail in the direction it sits, Home returns the default;
//   - reset: a double-click removes the inline property, which is exactly the no-drag
//     state — nothing is persisted anywhere, so a reload does the same;
//   - CSS: the stylesheet's fallback widths ARE the module's defaults, the seams are
//     hidden on a phone (the rails are drawers there) and only the right one is hidden on
//     a tablet (the scratch board is a strip there). jsdom resolves no media queries, so
//     the sheet is read as text like the other style tests.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RAIL_TRACKS, createRailResizers } from './rail-resize';

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

const mount = (onWidthChange = vi.fn()) => {
    document.body.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'shell';

    const leftRail = document.createElement('aside');
    leftRail.className = 'rail rail-left';
    const rightRail = document.createElement('aside');
    rightRail.className = 'rail rail-right';

    const resizers = createRailResizers({ shell, onWidthChange });

    shell.append(leftRail, resizers.left, document.createElement('main'), resizers.right, rightRail);
    document.body.append(shell);

    return { shell, resizers, rails: { left: leftRail, right: rightRail }, onWidthChange };
};

const pointer = (type: string, init: PointerEventInit): PointerEvent =>
    new PointerEvent(type, { bubbles: true, ...init });

/** Press the seam at `from`, pull to `to`, release. */
const drag = (handle: HTMLElement, from: number, to: number, pointerId = 1): void => {
    handle.dispatchEvent(pointer('pointerdown', { pointerId, clientX: from, button: 0, pointerType: 'mouse' }));
    document.dispatchEvent(pointer('pointermove', { pointerId, clientX: to }));
    document.dispatchEvent(pointer('pointerup', { pointerId, clientX: to }));
};

const key = (handle: HTMLElement, init: KeyboardEventInit): void => {
    handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

const widthOf = (shell: HTMLElement, edge: 'left' | 'right'): number =>
    Number.parseFloat(shell.style.getPropertyValue(RAIL_TRACKS[edge].property));

describe('the seam handles', () => {
    it('are focusable separators that name the rail they resize', () => {
        const { shell, resizers } = mount();

        for (const edge of ['left', 'right'] as const) {
            const handle = resizers[edge];
            const track = RAIL_TRACKS[edge];

            expect(handle.className).toBe(`rail-resizer rail-resizer-${edge}`);
            expect(handle.tagName).toBe('DIV');
            expect(handle.getAttribute('role')).toBe('separator');
            expect(handle.getAttribute('aria-orientation')).toBe('vertical');
            expect(handle.getAttribute('aria-label')).toBe(`Resize the ${track.label} panel`);
            expect(handle.tabIndex).toBe(0);
            // The value range is the handle's own, so a screen reader states the same
            // limits the pointer is clamped to.
            expect(handle.getAttribute('aria-valuemin')).toBe(String(track.min));
            expect(handle.getAttribute('aria-valuemax')).toBe(String(track.max));
            expect(handle.getAttribute('aria-valuenow')).toBe(String(track.fallback));
            expect(handle.title).toContain('Drag to resize');

            // A handle starts with no opinion: the shell carries no inline width, so CSS
            // paints its fallback and a reload lands there.
            expect(shell.style.getPropertyValue(track.property)).toBe('');
        }
    });

    it('size the shell tracks, never the rails', () => {
        const { shell, resizers, rails, onWidthChange } = mount();

        drag(resizers.left, 248, 348);

        expect(widthOf(shell, 'left')).toBe(348);
        // The rail element's own style is untouched: a `width` there could not widen the
        // grid track that owns it anyway.
        expect(rails.left.getAttribute('style')).toBeNull();
        expect(rails.right.getAttribute('style')).toBeNull();
        // The other rail keeps the default (its fallback), so a drag is one track, not two.
        expect(shell.style.getPropertyValue(RAIL_TRACKS.right.property)).toBe('');
        // The host re-measures the chat column it just re-sized (composer height,
        // scratch-button anchor, notched label).
        expect(onWidthChange).toHaveBeenCalledTimes(1);
    });

    it('mirror the right rail so the seam follows the pointer', () => {
        const { shell, resizers } = mount();

        // The right rail grows LEFTwards: pulling the seam to 220 from a 320px rail means
        // the pointer moved 100px left and the rail gained 100px.
        drag(resizers.right, 1000, 900);

        expect(widthOf(shell, 'right')).toBe(420);
        expect(resizers.right.getAttribute('aria-valuenow')).toBe('420');
    });

    it('keep the drag alive for the whole pointer sequence and end it on release', () => {
        const { shell, resizers } = mount();
        const handle = resizers.left;

        handle.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 248, button: 0, pointerType: 'mouse' }));
        expect(handle.classList.contains('is-resizing')).toBe(true);
        // The seam the reader is holding takes focus, so the arrow keys continue what the
        // pointer started (and `preventDefault` alone would have suppressed that focus).
        expect(document.activeElement).toBe(handle);
        // The cursor and the "do not select the transcript" lock live on <body>, because
        // the pointer leaves a 6px strip within the first move.
        expect(document.body.classList.contains('is-resizing-rail')).toBe(true);

        // The pointer is still down but the move lands on a node inside the rail: the
        // listeners are on the document, so the drag keeps up.
        document.body.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 300 }));
        expect(widthOf(shell, 'left')).toBe(300);

        // A different pointer (a second finger) is not this drag.
        document.dispatchEvent(pointer('pointermove', { pointerId: 7, clientX: 999 }));
        expect(widthOf(shell, 'left')).toBe(300);

        document.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 300 }));
        expect(handle.classList.contains('is-resizing')).toBe(false);
        expect(document.body.classList.contains('is-resizing-rail')).toBe(false);

        // Released: the document listeners are gone, so a stray move cannot move the panel.
        document.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 640 }));
        expect(widthOf(shell, 'left')).toBe(300);

        // A cancelled drag gives the page its cursor and its text selection back too.
        handle.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 300, button: 0, pointerType: 'touch' }));
        document.dispatchEvent(pointer('pointercancel', { pointerId: 2, clientX: 320 }));
        expect(handle.classList.contains('is-resizing')).toBe(false);
        expect(document.body.classList.contains('is-resizing-rail')).toBe(false);
    });

    it('ignore every pointer but the primary one', () => {
        const { shell, resizers } = mount();

        // Right-click is a context menu, middle-click a paste: neither drags.
        resizers.left.dispatchEvent(
            pointer('pointerdown', { pointerId: 1, clientX: 10, button: 2, pointerType: 'mouse' })
        );
        document.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 400 }));

        expect(shell.style.getPropertyValue(RAIL_TRACKS.left.property)).toBe('');
        expect(document.body.classList.contains('is-resizing-rail')).toBe(false);
    });

    it('clamp a drag to the track limits', () => {
        const { shell, resizers } = mount();
        const track = RAIL_TRACKS.left;

        // jsdom measures nothing (`clientWidth` 0), so only the track's own cap binds —
        // an unmeasurable shell has no room to ration.
        drag(resizers.left, 248, 4_000);
        expect(widthOf(shell, 'left')).toBe(track.max);

        drag(resizers.left, 4_000, -4_000);
        expect(widthOf(shell, 'left')).toBe(track.min);

        expect(resizers.left.getAttribute('aria-valuenow')).toBe(String(track.min));
    });

    it('stop at the chat column once the shell can be measured', () => {
        const { shell, resizers } = mount();
        // A 1234px shell (the width the layout-containment test describes) with the
        // scratch board at its 320px default leaves the harness rail 1234 - 320 - 320 - 12.
        Object.defineProperty(shell, 'clientWidth', { configurable: true, value: 1234 });

        drag(resizers.left, 248, 4_000);

        expect(widthOf(shell, 'left')).toBe(1234 - 320 - 320 - 12);
        expect(resizers.left.getAttribute('aria-valuenow')).toBe(String(582));
    });

    it('resize from the keyboard in the direction the rail sits', () => {
        const { shell, resizers } = mount();

        key(resizers.left, { key: 'ArrowRight' });
        expect(widthOf(shell, 'left')).toBe(248 + 16);

        key(resizers.left, { key: 'ArrowRight', shiftKey: true });
        expect(widthOf(shell, 'left')).toBe(248 + 16 + 64);

        key(resizers.left, { key: 'ArrowLeft' });
        expect(widthOf(shell, 'left')).toBe(248 + 16 + 64 - 16);

        // The right rail widens leftwards, so ArrowLeft is its "bigger".
        key(resizers.right, { key: 'ArrowLeft' });
        expect(widthOf(shell, 'right')).toBe(320 + 16);
        key(resizers.right, { key: 'ArrowRight' });
        expect(widthOf(shell, 'right')).toBe(320);

        // Home is the keyboard's reset, and an unrelated key is left to the page.
        key(resizers.left, { key: 'Home' });
        expect(shell.style.getPropertyValue(RAIL_TRACKS.left.property)).toBe('');
        expect(resizers.left.getAttribute('aria-valuenow')).toBe('248');

        // An unrelated key is left to the page (no width is written).
        key(resizers.left, { key: 'a' });
        expect(shell.style.getPropertyValue(RAIL_TRACKS.left.property)).toBe('');
    });

    it('return to the default on double-click, storing nothing', () => {
        const { shell, resizers } = mount();

        drag(resizers.left, 248, 400);
        expect(widthOf(shell, 'left')).toBe(400);

        resizers.left.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        // No inline property at all — the same state the page boots in, so the stylesheet
        // fallback is the reset value and there is no saved layout to disagree with.
        expect(shell.style.getPropertyValue(RAIL_TRACKS.left.property)).toBe('');
        expect(shell.style.cssText).toBe('');
        expect(resizers.left.getAttribute('aria-valuenow')).toBe(String(RAIL_TRACKS.left.fallback));
    });
});

describe('the seam stylesheet', () => {
    it('defaults the rail tracks to the same widths the module reports', () => {
        const shell = blockOf('.shell {').replace(/\s+/g, ' ');

        for (const edge of ['left', 'right'] as const) {
            const declared = shell.match(new RegExp(`var\\(--rail-${edge}-width, (\\d+)px\\)`));
            expect(declared, `no ${edge} rail track in .shell`).not.toBeNull();
            expect(Number.parseInt(declared![1], 10)).toBe(RAIL_TRACKS[edge].fallback);
        }
    });

    it('paints a real drag affordance on each seam', () => {
        const seam = blockOf('.rail-resizer {');
        expect(seam).toContain('cursor: col-resize');
        // A touch drag has to claim the strip, or the page pans and the pointer sequence dies.
        expect(seam).toContain('touch-action: none');

        // The grip lights on hover and for the whole drag, and the hit area is wider than
        // the 6px track it lives in.
        expect(rules).toContain('.rail-resizer:hover::after,\n.rail-resizer.is-resizing::after {');
        expect(blockOf('.rail-resizer::before {')).toContain('inset: 0 -5px');

        // The body carries the cursor and the selection lock while a seam is held.
        const body = blockOf('body.is-resizing-rail {');
        expect(body).toContain('cursor: col-resize');
        expect(body).toContain('user-select: none');
    });

    it('takes the seams out of the layouts that have no edge to drag', () => {
        // Phone: both rails are off-canvas drawers of a fixed width, so NO seam is shown —
        // and the rails' own collapse stays the rule the rail-toggle contract pins.
        const phone = blockOf('@media (max-width: 860px)');
        expect(phone).toContain('.rail-left,\n    .rail-right {\n        display: none;\n    }');
        expect(phone).toContain('.rail-resizer {\n        display: none;\n    }');

        // Tablet: the harness rail is still a column, so its seam survives; the scratch
        // board is a full-width strip, so only its seam goes.
        const tablet = blockOf('@media (max-width: 1180px)');
        expect(tablet).toContain('.rail-resizer-right {\n        display: none;\n    }');
        expect(tablet).not.toContain('.rail-resizer-left {');
    });
});

// Slice a rule/at-rule body by brace matching, exactly like the other CSS-contract
// tests, so a nested `@media` block cannot be cut short by the first `}`.
function blockOf(selector: string): string {
    const start = rules.indexOf(`\n${selector}`);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = rules.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
}
