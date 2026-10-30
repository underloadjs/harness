// Transcript file-link contract (R11).
//
// The transform is a post-sanitization DOM pass, so these tests pin both halves:
//   1. what may ever become a request (local relative paths only), and
//   2. which transcript shapes become keyboard buttons (explicit relative links,
//      @mentions, inline code, clearly file-like plain text) without touching
//      external links, fenced code or traversal.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-links.test.ts

import { describe, expect, it } from 'vitest';
import { enhanceFileLinks, isFileLikePath, languageOfPath, localFilePathOf } from './file-links';

describe('localFilePathOf', () => {
    it('accepts and normalizes local relative paths', () => {
        expect(localFilePathOf('src/frontend/main.ts')).toBe('src/frontend/main.ts');
        expect(localFilePathOf('./src/frontend/main.ts')).toBe('src/frontend/main.ts');
        expect(localFilePathOf('src/./frontend/./main.ts')).toBe('src/frontend/main.ts');
        expect(localFilePathOf('  src/a.ts  ')).toBe('src/a.ts');
        expect(localFilePathOf('package.json')).toBe('package.json');
    });

    it('refuses absolute, drive, UNC, home, scheme and traversal forms', () => {
        expect(localFilePathOf('/etc/passwd')).toBeUndefined();
        expect(localFilePathOf('//host/share/a.ts')).toBeUndefined();
        expect(localFilePathOf('C:/secret.ts')).toBeUndefined();
        expect(localFilePathOf('C:\\secret.ts')).toBeUndefined();
        expect(localFilePathOf('\\\\server\\share\\a.ts')).toBeUndefined();
        expect(localFilePathOf('~/secret.ts')).toBeUndefined();
        expect(localFilePathOf('../secret.ts')).toBeUndefined();
        expect(localFilePathOf('src/../../secret.ts')).toBeUndefined();
        expect(localFilePathOf('https://example.com/a.ts')).toBeUndefined();
        expect(localFilePathOf('file:///etc/passwd')).toBeUndefined();
        expect(localFilePathOf('javascript:alert(1)')).toBeUndefined();
        expect(localFilePathOf('data:text/html,<script>x</script>')).toBeUndefined();
    });

    it('refuses control characters, queries, fragments and empty segments', () => {
        expect(localFilePathOf('src/a\u0000.ts')).toBeUndefined();
        expect(localFilePathOf('src/a.ts?raw')).toBeUndefined();
        expect(localFilePathOf('src/a.ts#L10')).toBeUndefined();
        expect(localFilePathOf('src//a.ts')).toBeUndefined();
        expect(localFilePathOf('src/')).toBeUndefined();
        expect(localFilePathOf('.')).toBeUndefined();
        expect(localFilePathOf('')).toBeUndefined();
    });

    it('only treats known text extensions as previewable files', () => {
        expect(isFileLikePath('src/main.ts')).toBe(true);
        expect(isFileLikePath('README.md')).toBe(true);
        expect(isFileLikePath('package.json')).toBe(true);
        expect(isFileLikePath('src/photo.png')).toBe(false);
        expect(isFileLikePath('src/.gitignore')).toBe(false);
        expect(languageOfPath('src/main.ts')).toBe('typescript');
        expect(languageOfPath('src/photo.png')).toBeUndefined();
    });
});

// Mount a root exactly as ui/turns.ts does: after markdown has been sanitized.
const mountRoot = (html: string): HTMLElement => {
    const root = document.createElement('div');
    root.className = 'turn-prompt markdown';
    root.innerHTML = html;
    return root;
};

describe('enhanceFileLinks', () => {
    it('links explicit relative links, mentions, inline code and plain paths only', () => {
        const opened: string[] = [];
        const root = mountRoot(
            [
                '<p>Open <a href="./src/a.ts"><code>src/a.ts</code></a></p>',
                '<p>Ask @src/b.ts about <code>src/c.ts</code> and plain src/d.ts.</p>',
                '<p>External <a href="https://example.com/e.ts">https://example.com/e.ts</a>,',
                ' traversal ../secret.ts and product node.js stay text.</p>',
                '<pre><code>src/f.ts</code></pre>'
            ].join('')
        );

        const count = enhanceFileLinks(root, { open: (path) => opened.push(path) });

        // Four links: the anchor, the mention, the inline code and the plain path.
        expect(count).toBe(4);

        const links = [...root.querySelectorAll<HTMLButtonElement>('button.file-link')];
        expect(links.map((link) => link.dataset.path)).toEqual([
            'src/a.ts',
            'src/b.ts',
            'src/c.ts',
            'src/d.ts'
        ]);
        expect(links.map((link) => link.textContent)).toEqual([
            'src/a.ts',
            '@src/b.ts',
            'src/c.ts',
            'src/d.ts'
        ]);

        // The explicit link keeps its code element inside the button.
        expect(links[0]?.querySelector('code')?.textContent).toBe('src/a.ts');
        expect(links[0]?.className).toBe('file-link file-link-anchor');
        expect(links[2]?.className).toBe('file-link file-link-code');

        // External links and fenced code are untouched.
        const external = root.querySelector<HTMLAnchorElement>('a[href="https://example.com/e.ts"]');
        expect(external?.getAttribute('href')).toBe('https://example.com/e.ts');
        expect(root.querySelector('pre code')?.textContent).toBe('src/f.ts');
        expect(root.querySelector('pre button')).toBeNull();

        // Refused traversal and a product name remain ordinary text.
        const text = root.textContent ?? '';
        expect(text).toContain('../secret.ts');
        expect(text).toContain('node.js');

        // Activation sends the NORMALIZED path exactly once.
        links[1]?.click();
        expect(opened).toEqual(['src/b.ts']);

        // Idempotent: a second pass finds no new text candidates.
        expect(enhanceFileLinks(root, { open: (path) => opened.push(path) })).toBe(0);
    });

    it('does not link a URL-shaped token embedded in a sentence', () => {
        const root = mountRoot('<p>See https://example.com/docs/setup.ts for details.</p>');
        expect(enhanceFileLinks(root, { open: () => undefined })).toBe(0);
        expect(root.querySelector('button')).toBeNull();
    });

    it('leaves a relative link with an unknown extension as a normal anchor', () => {
        const root = mountRoot('<p><a href="./photo.png">photo</a></p>');
        expect(enhanceFileLinks(root, { open: () => undefined })).toBe(0);
        expect(root.querySelector('a')?.getAttribute('href')).toBe('./photo.png');
        expect(root.querySelector('button')).toBeNull();
    });
});
