// Response-typography CSS contract.
//
// jsdom cannot compute most of what makes rendered Markdown readable, so — as
// with turn-tile-style.test.ts — this test reads the stylesheet source and pins
// the properties that carry the design:
//   - the response palette is scoped to `.markdown` (not `:root`), so rails,
//     tiles and the composer keep their own muted tokens;
//   - body copy is larger and lighter than the chrome, inline code has its own
//     warm accent, and list markers are accent-coloured;
//   - the fenced-code language caption is CSS-only (`[data-language]::before`),
//     so the renderer's markup contract does not grow a wrapper element;
//   - highlight.js comments (the dimmest token layer) clear 4.5:1 on the code
//     surface rather than sitting at ~3.4:1.
//
// Run: npx vitest run --config playground/vitest.config.ts src/ui/markdown-style.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// `import.meta.url` is not a file: URL under jsdom. Resolve from the package
// root (`npm test`) or the playground root (vitest.config.ts `root`).
const stylesheet = ['playground/src/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Selectors in this section are plain (no `{`/`}` inside pseudo-class arguments),
// so the first `{` after the selector opens the rule and the first `}` closes it.
const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

// Compare `#rrggbb` colours by WCAG relative luminance. The palette comments in
// styles.css claim 4.5:1, so the test checks the claim instead of trusting it.
const channels = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

const luminance = (hex: string): number => {
    const [r, g, b] = channels(hex).map((channel) => {
        const srgb = channel / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (foreground: string, background: string): number => {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

it('scopes a high-contrast response palette to .markdown', () => {
    const base = blockOf('.markdown {');

    expect(base).toContain('--md-body: #e6ecf7');
    expect(base).toContain('--md-heading: #f3f7ff');
    expect(base).toContain('--md-code: #f0c98d');
    expect(base).toContain('--md-link: #a7c2ff');
    expect(base).toContain('--md-rule: #26303f');
    expect(base).toContain('color: var(--md-body)');
    expect(base).toContain('font-size: 14px');
    expect(base).toContain('line-height: 1.68');

    // The shell tokens stay untouched: another author owns rails/tiles, and a
    // global body-colour change would silently restyle them.
    expect(css).not.toContain('--text: #e6ecf7');
});

it('gives prose, inline code and list markers their own accents', () => {
    const inlineCode = blockOf('.markdown :not(pre) > code {');
    expect(inlineCode).toContain('color: var(--md-code)');
    expect(inlineCode).toContain('background: var(--md-inline-bg)');
    expect(inlineCode).toContain('font-size: 0.92em');

    // Scoped with `:not(pre)`: fenced blocks inherit `.code-block` instead.
    expect(css).toContain('.markdown :not(pre) > code {');

    expect(blockOf('.markdown li::marker {')).toContain('color: var(--md-accent)');
    expect(blockOf('.markdown h2 {')).toContain('border-bottom: 1px solid var(--md-rule)');
    expect(blockOf('.markdown strong {')).toContain('color: var(--md-heading)');
    expect(blockOf('.markdown blockquote {')).toContain('border-left: 3px solid rgba(122, 162, 255, 0.45)');
    expect(blockOf('.markdown tbody tr:nth-child(even) {')).toContain(
        'background: rgba(255, 255, 255, 0.025)'
    );
});

it('prints the fence language as a CSS caption without a wrapper element', () => {
    const caption = blockOf('.markdown .code-block[data-language]::before {');

    expect(caption).toContain('content: attr(data-language)');
    expect(caption).toContain('position: sticky');
    expect(caption).toContain('text-overflow: ellipsis');
    expect(caption).toContain('text-transform: uppercase');
    // Model-controlled text must never widen the scroll area.
    expect(caption).toContain('max-width: 100%');
});

it('keeps every syntax token above 4.5:1 on the code surface', () => {
    const surface = '#0c1017';

    expect(blockOf('.markdown .code-block {')).toContain('background: #0c1017');

    const tokens: Array<[string, string]> = [
        ['.hljs-comment,', '#8b98ad'],
        ['.hljs-keyword,', '#c792ea'],
        ['.hljs-string,', '#a5d6a7'],
        ['.hljs-number,', '#f2b880'],
        ['.hljs-title,', '#82aaff'],
        ['.hljs-meta {', '#9aa7bb'],
        ['.hljs-punctuation {', '#9aa5b6']
    ];

    for (const [selector, colour] of tokens) {
        expect(blockOf(selector)).toContain(`color: ${colour}`);
        expect(contrast(colour, surface)).toBeGreaterThan(4.5);
    }
});
