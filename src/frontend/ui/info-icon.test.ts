// The shared glyphs (./info-icon.ts) — the mark the Tools Catalogue's corner INFO control wears
// (`../styles.css .tool-tab-info`), the mark the Plugins pane's row control wears
// (`../styles.css .plugin-tab-info`), and the WARNING mark either of them swaps to while a
// refused enablement switch is outstanding on its row (R4 — `../main.ts setToolToggleFailure` /
// `setPluginToggleFailure`, painted by `.tool-tab-info[data-toggle='error']`).
//
// Why such a small module is pinned at all: the sheet paints these elements from their CLASS NAME
// and their geometry alone. `../styles.css .info-icon` supplies `stroke: currentColor`,
// `stroke-width` and the round joins, and the element itself carries `fill="none"` — so if this
// factory renames the class, moves the glyph outside the `viewBox`, or stops setting
// `fill="none"`, the mark silently loses its stroke (or fills in as a black disc) in EVERY pane
// at once, and no DOM test of a pane would say why. `tools-tab.test.ts` and `plugins-tab.test.ts`
// pin the buttons AROUND these glyphs; this file pins the glyphs.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts info-icon.test.ts

import { INFO_ICON_CLASS, INFO_ICON_PATH, WARNING_ICON_PATH, createInfoIcon, createWarningIcon } from './info-icon';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// The attributes both factories must set, in the same order, on the same element — ONE drawing
// routine (./info-icon.ts `createGlyph`), so a drift in one glyph is a drift in both and the pin
// runs against both.
const GLYPH_ATTRIBUTES = [
    `class=${INFO_ICON_CLASS}`,
    'viewBox=0 0 24 24',
    'aria-hidden=true',
    'focusable=false'
];

describe('createInfoIcon', () => {
    it('builds one detached <svg> in the SVG namespace, sized and stroked by the shared class', () => {
        const icon = createInfoIcon();

        // The namespace is not decoration: an `svg` made by `document.createElement` has the HTML
        // namespace and renders NOTHING in a browser, which is why ./ui never parses HTML.
        expect(icon.namespaceURI).toBe(SVG_NAMESPACE);
        expect(icon.tagName).toBe('svg');
        // Attribute SET, in construction order — `class` first, because that is the hook
        // `.info-icon` (styles.css:1134) hangs every visual property on.
        expect([...icon.attributes].map((attr) => `${attr.name}=${attr.value}`)).toEqual(GLYPH_ATTRIBUTES);
        // The class name is part of the contract with the sheet, so it is pinned literally here
        // as well as through the export a caller might rename.
        expect(INFO_ICON_CLASS).toBe('info-icon');
        // The geometry is the sheet's sizing contract: `.info-icon` is 13x13 CSS pixels, and the
        // glyph only stays upright if its coordinates live in the 24-unit box it scales from.
        expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
        // A caller appends the mark to a button that names itself, so the glyph must contribute
        // nothing to that name and must not be a tab stop of its own.
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(icon.getAttribute('focusable')).toBe('false');
        // Nothing is attached by the factory: the control owns placement (and the tools-tab
        // registration paints the row in document order).
        expect(icon.parentElement).toBeNull();
        expect(icon.parentNode).toBeNull();
    });

    it('draws the mark as ONE stroked path, and nothing else', () => {
        const icon = createInfoIcon();

        // One child, one <path>: three SUB-PATHS of a single `d` (ring, stem, dot) so the whole
        // glyph shares one stroke — the form `COPY_ICONS` uses in ./dialog.ts.
        expect(icon.childElementCount).toBe(1);

        const path = icon.firstElementChild as SVGPathElement;

        expect(path.namespaceURI).toBe(SVG_NAMESPACE);
        expect(path.tagName).toBe('path');
        expect([...path.attributes].map((attr) => `${attr.name}=${attr.value}`)).toEqual([
            'fill=none',
            `d=${INFO_ICON_PATH}`
        ]);
        // `fill="none"` rides the ELEMENT rather than the sheet, because a filled ring would be a
        // disc at 13px; the stroke is the sheet's business (`stroke: currentColor`).
        expect(path.getAttribute('fill')).toBe('none');
    });

    it('states the geometry exactly: a 9-unit ring centred at (12,12), a stem and a capped dot', () => {
        // The published data, pinned as a string so a "harmless" redraw that moves the glyph by a
        // unit is a failing test rather than a visual diff someone has to notice.
        expect(INFO_ICON_PATH).toBe('M12 3a9 9 0 0 1 0 18a9 9 0 0 1 0-18Z M12 11.2v5.3 M12 7.4v0.9');
        // Three sub-paths, each absolute-M: ring, stem, dot.
        expect(INFO_ICON_PATH.split(' M')).toHaveLength(3);
        // The ring's extremes (3 and 21 inside a 24 box) leave 3 units of margin, which is what
        // keeps the 1.7-unit stroke of `.info-icon` from being clipped by the viewBox edge.
        expect(INFO_ICON_PATH).toContain('M12 3');
        expect(INFO_ICON_PATH).toContain('a9 9 0 0 1 0 18');
        // The stem sits on the vertical centre line, and the dot above it is a zero-length-looking
        // segment that `stroke-linecap: round` turns into the dot.
        expect(INFO_ICON_PATH).toContain('M12 11.2v5.3');
        expect(INFO_ICON_PATH).toContain('M12 7.4v0.9');
    });

    it('lets a caller re-size the mark from its own class without redrawing it', () => {
        // The Plugins pane (or any later caller) owns its own footprint: it swaps the class and
        // keeps the drawing, which is the whole reason the class is a parameter rather than a
        // constant baked into the path.
        const icon = createInfoIcon({ className: 'plugin-tab-info-icon' });

        expect(icon.getAttribute('class')).toBe('plugin-tab-info-icon');
        expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
        expect((icon.firstElementChild as SVGPathElement).getAttribute('d')).toBe(INFO_ICON_PATH);
        // An explicit `className` of `''` is a REAL value, not "omit it": the factory merges with
        // `??`, so a caller that sizes the mark from its parent's selector can drop the shared
        // class entirely rather than inherit `.info-icon`'s 13px.
        expect(createInfoIcon({ className: '' }).getAttribute('class')).toBe('');
    });

    it('returns a fresh element per call, so two panes can never share one node', () => {
        const first = createInfoIcon();
        const second = createInfoIcon();

        expect(first).not.toBe(second);
        expect(first.firstElementChild).not.toBe(second.firstElementChild);

        // Appending one and mutating it leaves the other untouched — a moved node inside a live
        // document would otherwise repaint the OTHER pane's mark.
        const host = document.createElement('button');

        host.append(first);
        first.setAttribute('class', 'repainted');

        expect(second.parentElement).toBeNull();
        expect(second.getAttribute('class')).toBe(INFO_ICON_CLASS);
        expect(host.children).toHaveLength(1);
    });
});

// R4 — the failure figure. A pane's corner control swaps its ONLY child between these two glyphs,
// so the pair is pinned as a pair: same element, same attributes, same class, same stroke
// vocabulary, and a DIFFERENT path. Anything else and a swap would repaint the control's size or
// weight, and the reader would watch the button jump instead of its figure changing.
describe('createWarningIcon', () => {
    it('builds the same element as the info glyph, down to the shared paint class', () => {
        const icon = createWarningIcon();

        expect(icon.namespaceURI).toBe(SVG_NAMESPACE);
        expect(icon.tagName).toBe('svg');
        // Attribute-for-attribute identical to `createInfoIcon` (same construction order), and
        // `class` is the FIRST of them: both glyphs are painted by the ONE `.info-icon` rule, and
        // the failure colour arrives from the BUTTON's `color` through `stroke: currentColor`
        // (../styles.css `.tool-tab-info[data-toggle='error']`), not from a second glyph rule.
        expect([...icon.attributes].map((attr) => `${attr.name}=${attr.value}`)).toEqual(GLYPH_ATTRIBUTES);
        expect(icon.getAttribute('class')).toBe(INFO_ICON_CLASS);
        expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
        // Decorative like its twin: the button owns the accessible name, and in the failure state
        // that name carries the reason (`Details for <name> · switch failed: …`), so the glyph must
        // not add a second announcement or become a tab stop.
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(icon.getAttribute('focusable')).toBe('false');
        expect(icon.parentElement).toBeNull();
        expect(icon.parentNode).toBeNull();
    });

    it('draws one stroked path, and nothing else', () => {
        const icon = createWarningIcon();

        expect(icon.childElementCount).toBe(1);

        const path = icon.firstElementChild as SVGPathElement;

        expect(path.namespaceURI).toBe(SVG_NAMESPACE);
        expect(path.tagName).toBe('path');
        expect([...path.attributes].map((attr) => `${attr.name}=${attr.value}`)).toEqual([
            'fill=none',
            `d=${WARNING_ICON_PATH}`
        ]);
        // `fill="none"` on the element as well: a FILLED triangle at 13px is a solid wedge, and the
        // mark is a stroke mark in this UI, not an emoji.
        expect(path.getAttribute('fill')).toBe('none');
    });

    it('states the geometry exactly: an alert triangle with a stem and a capped dot', () => {
        // Pinned as a string, same rule as the info path: a redraw that shifts the figure by a
        // unit must fail here, not become a visual diff nobody notices.
        expect(WARNING_ICON_PATH).toBe(
            'M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z M12 9v4 M12 16.8v0.9'
        );
        // Three sub-paths, each starting with an absolute `M`: triangle, stem, dot — the SAME
        // count and idiom as the info glyph, which is what makes the two read as one family.
        expect(WARNING_ICON_PATH.split(' M')).toHaveLength(3);
        expect(WARNING_ICON_PATH).not.toBe(INFO_ICON_PATH);
        // The triangle: Lucide's `triangle-alert` outline — closed (`Z`), apex near (12, 4), base
        // at y=21 from x=4 to x=20. Its extremes sit ≥2.2 units inside the viewBox, so the
        // 1.7-unit stroke is not clipped by the edge (the ring leaves 3, and both must clear).
        expect(WARNING_ICON_PATH).toContain('M21.73 18');
        expect(WARNING_ICON_PATH).toContain('A2 2 0 0 0 4 21h16');
        // Closed figure — an open triangle would read as a chevron at 13px.
        expect(WARNING_ICON_PATH).toContain('-3Z');
        // The stem and dot are centred on x=12 — the same axis the "i" uses — and the dot is a
        // short segment the round linecap turns into a dot (`v0.9`), so neither glyph needs a
        // second element to say "alert".
        expect(WARNING_ICON_PATH).toContain('M12 9v4');
        expect(WARNING_ICON_PATH).toContain('M12 16.8v0.9');
        // The stem ends at 13 and the dot starts at 16.8: they must not merge into one line,
        // because a merged glyph reads as an exclamation inside a box rather than an alert.
        expect(WARNING_ICON_PATH).not.toContain('M12 9v7');
    });

    it('takes the same className override as its twin, so either pane can size either glyph', () => {
        const icon = createWarningIcon({ className: 'plugin-tab-info-icon' });

        expect(icon.getAttribute('class')).toBe('plugin-tab-info-icon');
        expect((icon.firstElementChild as SVGPathElement).getAttribute('d')).toBe(WARNING_ICON_PATH);
        expect(createWarningIcon({ className: '' }).getAttribute('class')).toBe('');
        // Both panes mount these marks from `createInfoIcon()` / `createWarningIcon()` with NO
        // argument, so the DEFAULT is the contract that matters: the shared class, unchanged.
        expect(createWarningIcon().getAttribute('class')).toBe('info-icon');
    });

    it('returns a fresh element per call, so a swap never moves a node between rows', () => {
        const first = createWarningIcon();
        const second = createWarningIcon();

        expect(first).not.toBe(second);
        expect(first.firstElementChild).not.toBe(second.firstElementChild);

        // The real usage is `replaceChildren` on a live button (main.ts): a node returned by one
        // call must never already belong to another control, or mounting it would DISMOUNT the
        // first row's mark and leave the failure figure on the wrong row.
        expect(first.parentElement).toBeNull();
        expect(second.parentElement).toBeNull();
        // And the info glyph is not the warning glyph's node: a pane that mounts one after the
        // other replaces it, rather than relocating a shared element.
        expect(createInfoIcon().firstElementChild).not.toBe(first.firstElementChild);
    });
});
