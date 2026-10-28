// Activity-ring CSS contract.
//
// The visual is CSS, so jsdom cannot compute it; this test reads the stylesheet
// source and pins the properties that make the ring work and stay accessible:
//   - a registered `--agent-ring-angle` so the conic gradient can animate;
//   - the accepted 0–250deg transparent / 330deg accent / 360deg light-accent arc;
//   - a 1px masked ring with pointer-events: none and the tile border as the track;
//   - reduced motion keeps the static ring but removes the animation;
//   - forced colors replaces the ring with a system-colour outline.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// `import.meta.url` is not a file: URL under jsdom. Resolve the stylesheet from
// the package root (`npm test`) or the playground root (vitest.config.ts `root`).
const stylesheet = ['playground/src/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

it('registers the ring angle and draws the accepted conic arc', () => {
    expect(blockOf('@property --agent-ring-angle')).toContain("syntax: '<angle>'");
    expect(blockOf('@property --agent-ring-angle')).toContain('initial-value: 0deg');

    const ring = blockOf(".agent-tile[data-activity='active']::before {");
    expect(ring).toContain('from var(--agent-ring-angle, 0deg)');
    expect(ring).toContain('transparent 0deg');
    expect(ring).toContain('transparent 250deg');
    expect(ring).toContain('var(--accent) 330deg');
    expect(ring).toContain('#b9cdff 360deg');
    expect(ring).toContain('padding: 1px');
    expect(ring).toContain('mask-composite: exclude');
    expect(ring).toContain('pointer-events: none');
    expect(ring).toContain('animation: agent-ring-spin 900ms linear infinite');
    expect(ring).toContain('position: absolute');

    expect(blockOf('@keyframes agent-ring-spin')).toContain('--agent-ring-angle: 360deg');
    // The tile's own border is the dim track the arc sweeps around.
    expect(blockOf('.agent-tile {')).toContain('border: 1px solid var(--border)');
});

it('keeps a static ring under reduced motion and an outline under forced colors', () => {
    // The reduced-motion block must include the ring's animation, not just dots.
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.agent-tile\[data-activity='active'\]::before[\s\S]*?animation: none !important;/
    );

    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?\.agent-tile\[data-activity='active'\] \{[\s\S]*?outline: 2px solid CanvasText;/
    );
});
