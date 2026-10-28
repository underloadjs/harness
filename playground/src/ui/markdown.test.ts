// Markdown + highlighting tests.
//
// The point of these tests is the security boundary and the exact rendering
// contract: `markdownHtml` output is inserted with `innerHTML`, so every
// assertion here is about the *complete* string that reaches the DOM. The
// expected values were captured from a real render and then reviewed — a failure
// means the sanitizer or the renderer changed behaviour.
//
// Visual properties of the response (palette, inline-code colour, language
// caption, list markers) are CSS and are pinned separately in
// markdown-style.test.ts, which reads styles.css the same way the other
// *-style tests do.
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

    it('keeps http(s) links but strips data: targets', () => {
        expect(markdownHtml('[y](https://e.com) [z](data:text/html,hi)')).toBe(
            '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer nofollow">y</a> <a>z</a></p>\n'
        );
    });

    // GFM task lists render a real checkbox. It is the only form control the
    // sanitizer lets through, and it is rebuilt as an inert disabled checkbox:
    // the `[x]` state survives, nothing else does.
    it('renders GFM task lists with inert checkboxes', () => {
        expect(markdownHtml('- [ ] open\n- [x] done')).toBe(
            '<ul>\n<li><input type="checkbox" disabled=""> open</li>\n<li><input type="checkbox" disabled="" checked=""> done</li>\n</ul>\n'
        );
    });

    it('drops form controls outside a task-list item', () => {
        // Inline text input: the control disappears, the prose around it stays.
        expect(markdownHtml('type this <input type="text" value="secret"> ok')).toBe(
            '<p>type this  ok</p>\n'
        );
        // Raw checkbox outside an <li> is not a task list.
        expect(markdownHtml('<input type="checkbox" checked onclick="alert(1)">')).toBe('');
        // A form's payload survives as text, the form and its button do not.
        expect(markdownHtml('<form><input type="checkbox" checked><button>go</button></form>')).toBe(
            'go'
        );
    });

    it('highlights a fenced code block and records the author language', () => {
        expect(markdownHtml('```ts\nconst answer = 42;\n```')).toBe(
            '<pre class="code-block" data-language="ts"><code class="hljs language-typescript"><span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>;</code></pre>'
        );
    });

    // Rust/Go/PowerShell are registered now; before this they fell back to plain
    // escaped text even though a coding answer emits them constantly.
    it('highlights the extended grammars', () => {
        expect(markdownHtml('```rust\nfn main() { println!("hi"); }\n```')).toBe(
            '<pre class="code-block" data-language="rust"><code class="hljs language-rust"><span class="hljs-keyword">fn</span> <span class="hljs-title function_">main</span>() { <span class="hljs-built_in">println!</span>(<span class="hljs-string">"hi"</span>); }</code></pre>'
        );
        expect(markdownHtml('```go\nfunc main() { fmt.Println("hi") }\n```')).toBe(
            '<pre class="code-block" data-language="go"><code class="hljs language-go"><span class="hljs-function"><span class="hljs-keyword">func</span> <span class="hljs-title">main</span><span class="hljs-params">()</span></span> { fmt.Println(<span class="hljs-string">"hi"</span>) }</code></pre>'
        );
    });

    it('resolves aliases to the registered language', () => {
        // `ps1` used to be treated as bash; it is PowerShell.
        expect(markdownHtml('```ps1\nGet-ChildItem\n```')).toBe(
            '<pre class="code-block" data-language="ps1"><code class="hljs language-powershell"><span class="hljs-built_in">Get-ChildItem</span></code></pre>'
        );
        // TOML has no grammar in this highlight.js build, so it borrows ini's.
        expect(markdownHtml('```toml\nkey = "value"\n```')).toBe(
            '<pre class="code-block" data-language="toml"><code class="hljs language-ini"><span class="hljs-attr">key</span> = <span class="hljs-string">"value"</span></code></pre>'
        );
    });

    it('escapes an unlabelled fence instead of guessing', () => {
        expect(markdownHtml('```\nplain <tag>\n```')).toBe(
            '<pre class="code-block"><code>plain &lt;tag&gt;</code></pre>'
        );
    });

    it('keeps an unregistered language as escaped text with the author label', () => {
        expect(markdownHtml('```cobol\nIDENTIFICATION DIVISION.\n```')).toBe(
            '<pre class="code-block" data-language="cobol"><code class="hljs language-cobol">IDENTIFICATION DIVISION.</code></pre>'
        );
    });

    // The fence info string is concatenated into two attributes, so a hostile
    // label must not be able to close the attribute or inject markup. Only the
    // safe character subset survives, and both `class` and `data-language` stay
    // inside their quotes.
    it('sanitises the fence info string before it reaches an attribute', () => {
        expect(markdownHtml('```foo"><script>alert(1)</script>\nx\n```')).toBe(
            '<pre class="code-block" data-language="fooscriptalert1/script"><code>x</code></pre>'
        );
    });

    it('caps the author label length', () => {
        expect(markdownHtml(`\`\`\`${'a'.repeat(60)}\nx\n\`\`\``)).toBe(
            `<pre class="code-block" data-language="${'a'.repeat(32)}"><code>x</code></pre>`
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

    it('highlights Rust through its canonical name', () => {
        expect(highlightCode('fn main() { let x: u8 = 1; }', 'rust')).toBe(
            '<span class="hljs-keyword">fn</span> <span class="hljs-title function_">main</span>() { <span class="hljs-keyword">let</span> <span class="hljs-variable">x</span>: <span class="hljs-type">u8</span> = <span class="hljs-number">1</span>; }'
        );
    });

    it('escapes markup for unknown languages', () => {
        expect(highlightCode('<div>', 'cobol')).toBe('&lt;div&gt;');
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
