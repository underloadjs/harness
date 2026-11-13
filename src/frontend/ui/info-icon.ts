// The shared marks for the two catalogues' corner controls.
//
// Why this module exists
// ----------------------
// The Tools Catalogue puts an INFO BUTTON in the top-right corner of every row — exactly
// the footprint the enablement tick box used to hold (./main.ts `toolInfoButtonOf`) — and
// the Plugins catalogue needs the identical mark for its row dialog. This frontend has no
// icon library and adding a dependency for one glyph is not worth it, so every glyph in
// this UI is a hand-declared inline <path>: see `createCopyIcon` (./dialog.ts:398) and
// `createCollapseIcon` (./turns.ts:1242). Those two live inside their own modules; this one
// is extracted because the SAME mark is needed by two panes, and a duplicated path drifts.
//
// It is deliberately generic: no tool/plugin/row vocabulary, no state, no label. The caller
// owns the accessible name, the tooltip and every state attribute; this factory only builds
// a decorative <svg> so the control it is appended to keeps ONE accessible name.
//
// The second export, `createWarningIcon`, is the SAME control's failure figure (R4): when a
// row's enablement PATCH is refused, main.ts swaps the mark's child from the info glyph to
// this one and puts `data-toggle='error'` on the button, which is the state the sheet paints
// red (./styles.css `.tool-tab-info[data-toggle='error']` / `.plugin-tab-info[data-toggle='error']`).
// Two factories rather than one stateful one because the glyph carries no state itself — the
// BUTTON does — so a caller can never mount a warning mark that disagrees with its attribute.
//
// Cross-references:
//   - ./main.ts `toolInfoButtonOf`      — the Tools Catalogue's corner control (class `tool-tab-info`)
//   - ./main.ts `pluginInfoButtonOf`    — the Plugins Catalogue's corner control (class `plugin-tab-info`)
//   - ../styles.css `.info-icon`        — the single rule that paints BOTH glyphs
//   - ./dialog.ts:218-227, 398-413      — the data-only inline-SVG precedent this follows

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// The class both glyphs carry by default. ONE rule (styles.css `.info-icon`) paints every
// copy of either mark — `stroke: currentColor` and the line joins — and each pane sizes its
// own instance from its own control, so restyling one catalogue can never move the other.
// The warning glyph deliberately reuses this class instead of a twin: size, stroke and joins
// are the same figure, and the FAILURE colour arrives from the button's own `color`, which
// `currentColor` already follows. A second class would be a second rule to keep in step.
export const INFO_ICON_CLASS = 'info-icon';

// Lucide-style "info" geometry inside a 24x24 box, as three SUB-PATHS of one <path>
// (one element, one shared stroke — the same form `COPY_ICONS` uses in ./dialog.ts:220):
//   - the ring: two 180-degree arcs of r=9 around (12,12). The radius leaves 3 units of
//     room on every side, so the 1.7px stroke of `.info-icon` is never clipped by the
//     viewBox edge (a r=10 ring would sit 0.15 units from the boundary);
//   - the stem of the "i": `M12 11.2v5.3`, centred in the lower half of the ring;
//   - the dot: a short vertical segment (`v0.9`) that the glyph's `stroke-linecap: round`
//     turns into a round dot — the exact idiom `COPY_ICONS.error` uses (./dialog.ts:226).
export const INFO_ICON_PATH = 'M12 3a9 9 0 0 1 0 18a9 9 0 0 1 0-18Z M12 11.2v5.3 M12 7.4v0.9';

// Lucide-style "triangle-alert" geometry, same 24x24 box, same three sub-paths (outline,
// stem, dot) so the failure figure is legible as a SHAPE and not only as a colour:
//   - the triangle: Lucide's own `triangle-alert` outline — a rounded-corner apex at (12, ~4)
//     and a base at y=21 across x 4…20. Its extremes sit 2.27 units inside the viewBox, so
//     the 1.7-unit stroke (`./styles.css .info-icon`, ≈0.9 CSS px at the rendered 13px) still
//     clears the edge;
//   - the stem `M12 9v4` and the dot `M12 16.8v0.9` are centred on the same vertical axis the
//     "i" uses, and the dot is again a short segment the round linecap turns into one — so
//     both glyphs share one drawing idiom and swap without changing apparent weight.
export const WARNING_ICON_PATH = 'M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z M12 9v4 M12 16.8v0.9';

export type InfoIconOptions = {
    // Override for a caller that must size the mark from its own class name. Omit it and
    // the glyph carries `INFO_ICON_CLASS`, which is already sized and stroked.
    className?: string;
};

// The one drawing routine: both glyphs differ ONLY by their `d`, so they cannot drift in any
// other respect. Created in the SVG namespace because this module (like every module in ./ui)
// never parses HTML — data-only DOM construction. `aria-hidden` and `focusable='false'` keep
// the mark out of the accessible name of the control it is appended to and out of the tab
// order, which is what lets an icon-only button stay named by its own `aria-label` alone.
const createGlyph = (d: string, options: InfoIconOptions): SVGSVGElement => {
    const icon = document.createElementNS(SVG_NAMESPACE, 'svg');

    icon.setAttribute('class', options.className ?? INFO_ICON_CLASS);
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');

    const path = document.createElementNS(SVG_NAMESPACE, 'path');

    path.setAttribute('fill', 'none');
    path.setAttribute('d', d);
    icon.append(path);

    return icon;
};

// Build one decorative info glyph — the resting figure of both corner controls.
export const createInfoIcon = (options: InfoIconOptions = {}): SVGSVGElement =>
    createGlyph(INFO_ICON_PATH, options);

// Build one decorative warning glyph — the SAME footprint and stroke, used by a corner control
// whose row has a refused enablement write outstanding (./main.ts `setToolToggleFailure` for a
// tool row, `setPluginToggleFailure` for a plugin row). Nothing here says "error": the caller
// sets `data-toggle='error'`, which is what paints the red, and the two must be written in one
// pass.
export const createWarningIcon = (options: InfoIconOptions = {}): SVGSVGElement =>
    createGlyph(WARNING_ICON_PATH, options);
