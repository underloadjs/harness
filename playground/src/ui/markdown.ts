// Markdown + syntax highlighting for the harness UI.
//
// The assistant streams raw Markdown. Rendering it ourselves would be a
// security bug waiting to happen (hand-rolled parsers miss XSS vectors), so this
// module leans on two established libraries that are already in the workspace:
//
//   - `marked` (GFM) turns a Markdown string into HTML, including fenced code.
//   - `DOMPurify` is the security boundary: model output is untrusted text, and
//     everything below is inserted with `innerHTML`, so it is *always* sanitized
//     first. Raw HTML emitted by a model therefore survives only if it is inert
//     markup from DOMPurify's allow-list; scripts, event handlers, `javascript:`
//     URLs, embedded frames and media are removed.
//
// `highlight.js` (core + the languages registered below) styles fenced code.
// Registering individual languages keeps the bundle to the handful a harness
// conversation actually produces instead of the ~190 language bundle.
//
// Cross-references:
//   - stylised tokens: playground/src/styles.css (`.hljs-*`)
//   - consumers: playground/src/ui/turns.ts (assistant text, tool arguments)
//   - precedent for marked + DOMPurify in this repo:
//     distribution/ScriptingSpaceScribble/src/features/markdownViewer/MarkdownViewerFeature.tsx

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Config as SanitizeConfig } from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Registering by canonical name means a fence can say `ts`, `typescript` or
// `application/typescript` — `normalizeLanguage` resolves all of those to the
// same registered id.
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLanguage);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// Aliases a fence info string may use. Values are the registered names above;
// `undefined` means "known input, but render it as plain text" (e.g. ```text).
//
// Cross-reference: the model writes whatever its provider prompt suggests, so
// this map is deliberately generous instead of erroring on an unknown tag.
const LANGUAGE_ALIASES: Readonly<Record<string, string | undefined>> = {
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    terminal: 'bash',
    cmd: 'bash',
    powershell: 'bash',
    ps1: 'bash',
    css: 'css',
    scss: 'css',
    less: 'css',
    diff: 'diff',
    patch: 'diff',
    js: 'javascript',
    javascript: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    node: 'javascript',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    ts: 'typescript',
    typescript: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    py: 'python',
    python: 'python',
    python3: 'python',
    sql: 'sql',
    postgres: 'sql',
    postgresql: 'sql',
    sqlite: 'sql',
    html: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    text: undefined,
    txt: undefined,
    plain: undefined,
    plaintext: undefined,
    output: undefined
};

// Fence tags that Markdown authors use for prose, not code: rendering them as
// highlighted code would invent colours for a config dump.
const ALIAS_LOOKUP = (raw: string): string | undefined => {
    const key = raw.trim().toLowerCase();
    if (key.length === 0) return undefined;

    // A fence may carry a full mime type or a `language:js` prefix; keep only
    // the interesting tail so ```application/json still highlights as JSON.
    const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    const cleaned = tail.startsWith('language-') ? tail.slice('language-'.length) : tail;

    return Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, cleaned) ? LANGUAGE_ALIASES[cleaned] : cleaned;
};

// Escape text before it is handed to `innerHTML` outside of DOMPurify (fence
// fallbacks). Kept local because it is only used while building Markdown HTML.
const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Languages considered for `highlightAuto` when a fence has no info string.
// Unknown-language fences stay plain: guessing wrong is worse than plain text,
// and auto-detection over every registered language is both slow and noisy.
const AUTO_LANGUAGES = [
    'typescript',
    'javascript',
    'json',
    'bash',
    'python',
    'sql',
    'xml',
    'css',
    'yaml',
    'diff',
    'markdown'
];

// Maximum characters highlighted in one block. Tool results can be megabytes
// (a directory listing, a log file); past this size highlighting costs more than
// it communicates, so the tail is shown as escaped text with a note.
const MAX_HIGHLIGHT_CHARS = 40_000;

// Highlight a code block and return HTML. Every branch escapes or highlights the
// input, so the caller may insert the result directly (it is still passed through
// DOMPurify when it comes from model output — see `sanitizeHtml`).
export const highlightCode = (code: string, language?: string): string => {
    const requested = language === undefined ? undefined : ALIAS_LOOKUP(language);
    const truncated = code.length > MAX_HIGHLIGHT_CHARS;
    const body = truncated ? code.slice(0, MAX_HIGHLIGHT_CHARS) : code;

    // A language that is not registered (Rust, Go, …) cannot be highlighted, but
    // the block is still code: keep it escaped rather than dropping the fence.
    if (requested !== undefined && hljs.getLanguage(requested) !== undefined) {
        try {
            return hljs.highlight(body, { language: requested, ignoreIllegals: true }).value;
        } catch {
            return escapeHtml(body);
        }
    }

    // No info string and a short block: let highlight.js pick. Long unlabelled
    // blocks skip detection (it is O(languages × length)).
    if (language === undefined && body.trim().length > 0 && body.length <= 4_000) {
        try {
            const detected = hljs.highlightAuto(body, AUTO_LANGUAGES);
            if (detected.language !== undefined) return detected.value;
        } catch {
            // Fall through to plain escaped text.
        }
    }

    return escapeHtml(body);
};

// True when a value looks like JSON — used for tool arguments and results so
// they render highlighted instead of as an uncoloured wall of text.
export const looksLikeJson = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
};

// Render a JSON string with `JSON.stringify` formatting when it parses, so a
// single-line tool payload becomes readable in the log. Returns the input
// unchanged when it is not JSON at all.
export const prettyJson = (value: string): string => {
    if (!looksLikeJson(value)) return value;

    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return value;
    }
};

// Fenced code renderer. `marked` calls this with the fence's text and info
// string; the `language-*` class is what our stylesheet and the copy affordance
// key off, and `hljs` adds the token spans.
const markdownRenderer = new Marked({ gfm: true, breaks: false });

markdownRenderer.use({
    renderer: {
        code({ text, lang }: { text: string; lang?: string | null }) {
            const requested = lang === undefined || lang === null ? undefined : lang.split(/\s+/)[0];
            const resolved = requested === undefined ? undefined : ALIAS_LOOKUP(requested);
            const highlighted = highlightCode(text, requested);
            const label = requested === undefined || requested.trim().length === 0 ? '' : requested.trim();
            const languageClass =
                resolved === undefined || resolved === null || resolved.length === 0
                    ? ''
                    : ` class="hljs language-${escapeHtml(resolved)}"`;

            // `data-language` is the *author's* label so the UI can print it even
            // when the alias resolved to a different registered language.
            return `<pre class="code-block"${
                label.length === 0 ? '' : ` data-language="${escapeHtml(label)}"`
            }><code${languageClass}>${highlighted}</code></pre>`;
        }
    }
});

// DOMPurify configuration.
//
// `USE_PROFILES: { html: true }` keeps the standard text/table/list vocabulary
// that Markdown needs and drops SVG/MathML parsing (the classic XSS smuggling
// route). The forbidden lists remove what a chat log never needs: forms,
// embedded documents, media, and inline styling that could hide content.
//
// `ALLOWED_URI_REGEXP` is the link allow-list: http(s), mailto and in-page or
// relative targets only. Anything else (`javascript:`, `data:`, `vbscript:`) is
// dropped by DOMPurify before it reaches the DOM.
const SANITIZE_OPTIONS: SanitizeConfig = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
        'style',
        'form',
        'input',
        'button',
        'select',
        'textarea',
        'iframe',
        'frame',
        'object',
        'embed',
        'video',
        'audio',
        'source',
        'track',
        'link',
        'meta'
    ],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping', 'onerror', 'onload'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[#/]|\.{0,2}\/)/i,
    ADD_ATTR: ['target', 'rel', 'loading', 'referrerpolicy']
};

// Turn sanitized HTML into a fragment that can be inserted directly. Links are
// hardened after sanitizing: a model-supplied href must not be able to run code
// in this page's origin, and `noopener` stops the new tab from touching us.
const hardenLinks = (root: ParentNode): void => {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const href = anchor.getAttribute('href') ?? '';
        const isSafe = /^(?:(?:https?|mailto):|[#/]|\.{0,2}\/)/i.test(href.trim());

        if (!isSafe) {
            anchor.removeAttribute('href');
            continue;
        }

        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    // Images are allowed but never used as a tracking channel: no referrer, and
    // deferred loading keeps a long transcript cheap.
    for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
        image.setAttribute('loading', 'lazy');
        image.setAttribute('referrerpolicy', 'no-referrer');
    }
};

// Public entry point for model/user text. Returns sanitized HTML.
export const markdownHtml = (text: string): string => {
    const parsed = markdownRenderer.parse(text) as string;
    const clean = DOMPurify.sanitize(parsed, SANITIZE_OPTIONS);

    // `template` parses without executing anything (no scripts, no image loads).
    const template = document.createElement('template');
    template.innerHTML = clean;
    hardenLinks(template.content);

    return template.innerHTML;
};

// Streaming path. A `DocumentFragment` avoids re-parsing HTML a second time when
// the caller replaces a node's children on every animation frame.
export const markdownFragment = (text: string): DocumentFragment => {
    const template = document.createElement('template');
    template.innerHTML = markdownHtml(text);
    return template.content;
};

// Compact tiles show a one-glance preview of the answer. Stripping Markdown
// markers keeps the tile readable; the full rendered body returns as soon as the
// tile is expanded.
export const plainPreview = (text: string, limit = 180): string => {
    const flattened = text
        // Fences and their info strings
        .replace(/```[^\n]*\n?/g, ' ')
        // Images before links (so `![alt](url)` does not leave `!alt`)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Inline code, then emphasis/list markers, then table pipes and rules
        .replace(/`/g, '')
        .replace(/[*_~>#]+/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-=]{3,}\s*$/gm, ' ')
        .replace(/\s+/g, ' ')
        // A stripped marker must not leave " ." behind.
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim();

    return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1).trimEnd()}…`;
};
