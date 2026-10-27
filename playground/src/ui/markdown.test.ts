// Markdown + highlighting tests.
//
// The point of these tests is the security boundary and the exact rendering
// contract: `markdownHtml` output is inserted with `innerHTML`, so every
// assertion here is about the *complete* string that reaches the DOM. The
// expected values were captured from a real render and then reviewed — a failure
// means the sanitizer or the renderer changed behaviour.
//
// Run: npx vitest run --config playground/vitest.config.ts
import {
    highlightCode,
    looksLikeJson,
    markdownFragment,
    markdownHtml,
    plainPreview,
    prettyJson
} from './markdown';

describe('markdownHtml', () => {
    it('renders headings, emphasis and links', () => {
        expect(markdownHtml('# Title\n\nSome **bold** and a [link](https://example.com).')).toBe(
            '<h1>Title</h1>\n<p>Some <strong>bold</strong> and a <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">link</a>.</p>\n'
        );
    });

    it('renders GFM tables', () => {
        expect(markdownHtml('| a | b |\n| - | - |\n| 1 | 2 |')).toBe(
            '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table>\n'
        );
    });

    // The XSS boundary: raw model HTML may pass through `marked`, but nothing
    // executable may survive sanitizing. Script tags, event handlers and
    // javascript: URLs are all removed; the surrounding Markdown still renders.
    it('strips scripts, event handlers and javascript: links', () => {
        expect(
            markdownHtml(
                '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[bad](javascript:alert(3))'
            )
        ).toBe('<img loading="lazy" referrerpolicy="no-referrer"><p><a>bad</a></p>\n');
    });

    it('highlights a fenced code block and records the author language', () => {
        expect(markdownHtml('```ts\nconst answer = 42;\n```')).toBe(
            '<pre class="code-block" data-language="ts"><code class="hljs language-typescript"><span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>;</code></pre>'
        );
    });

    it('escapes an unlabelled fence instead of guessing', () => {
        expect(markdownHtml('```\nplain <tag>\n```')).toBe(
            '<pre class="code-block"><code>plain &lt;tag&gt;</code></pre>'
        );
    });

    it('returns a fragment with the same sanitized content', () => {
        const fragment = markdownFragment('<b>safe</b>');
        expect(fragment.textContent).toBe('safe\n');
        expect(fragment.firstElementChild?.tagName).toBe('P');
    });
});

describe('highlightCode', () => {
    it('highlights registered languages', () => {
        expect(highlightCode('const answer = 42;', 'typescript')).toBe(
            '<span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>;'
        );
    });

    it('escapes markup for unknown languages', () => {
        expect(highlightCode('<div>', 'rust')).toBe('&lt;div&gt;');
    });

    it('escapes markup when no language is given and detection has no answer', () => {
        expect(highlightCode('   ', undefined)).toBe('   ');
    });
});

describe('prettyJson / looksLikeJson', () => {
    it('formats JSON payloads', () => {
        expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
        expect(looksLikeJson('{"a":1}')).toBe(true);
    });

    it('leaves non-JSON alone', () => {
        expect(prettyJson('not json')).toBe('not json');
        expect(looksLikeJson('not json')).toBe(false);
        expect(looksLikeJson('')).toBe(false);
    });

    it('rejects malformed JSON that merely starts like JSON', () => {
        expect(looksLikeJson('{oops')).toBe(false);
    });
});

describe('plainPreview', () => {
    it('flattens Markdown to a single readable line', () => {
        expect(plainPreview('## Head\n\nSome **bold** text and `code`.\n\n- one\n- two')).toBe(
            'Head Some bold text and code. - one - two'
        );
    });

    it('truncates with an ellipsis at the limit', () => {
        expect(plainPreview('abcdefghij', 5)).toBe('abcd…');
    });
});
