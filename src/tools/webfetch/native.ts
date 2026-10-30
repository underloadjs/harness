// webFetch `native` provider — a direct GET plus a dependency-free conversion.
//
// Loaded by `import()` from ./index on the first native call, so constructing a
// harness never touches this module. There is no SDK and no parser package: the
// transport is global `fetch` (see ./request) and the HTML handling below is a
// bounded regex pass, in the same zero-dependency spirit as the websearch
// adapters. It is not a DOM: it will not resolve CSS, run scripts, or preserve
// nesting perfectly. It converts the text of ordinary server-rendered pages —
// which is what a model needs — and anything fancier is a reason to configure
// the `exa` provider, whose crawler renders and extracts server-side.
//
// Conversion rules (deliberately small):
//   - script/style/noscript/template/head/svg and comments disappear;
//   - a <title> becomes the result's `title`, never body text;
//   - markdown output keeps headings, links, images, emphasis, code, list
//     items, blockquotes, and rules as markdown syntax;
//   - text output strips all markup and decodes entities;
//   - html output is the raw body, unconverted.
//
// Cross-references:
//   - ./request — the GET, the bounds, the error sentences
//   - ./index   — dispatch + redaction + the character bound

import { requestPage } from './request';
import type { PageFetch } from './request';

export type ConvertedPage = {
    content: string;
    title?: string;
    // True when the response was HTML, so ./index knows the format conversion
    // applied and a non-HTML body is passed through untouched.
    wasHtml: boolean;
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    bull: '•',
    middot: '·',
    deg: '°',
    laquo: '«',
    raquo: '»',
    times: '×',
    divide: '÷'
};

// Numeric first, then the named table. `&#12;`-style control codes collapse to
// nothing rather than emitting an unprintable character.
const decodeEntities = (value: string): string =>
    value
        .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => {
            const code = Number.parseInt(hex, 16);
            return Number.isFinite(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        })
        .replace(/&#(\d+);?/g, (_, decimal: string) => {
            const code = Number.parseInt(decimal, 10);
            return Number.isFinite(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        })
        .replace(/&([a-zA-Z]+);?/g, (whole: string, name: string) => {
            const entity = NAMED_ENTITIES[name.toLowerCase()];

            return entity === undefined ? whole : entity;
        });

// ---------------------------------------------------------------------------
// Structural passes
// ---------------------------------------------------------------------------

// Drop comments and the elements whose text a reader never wants. The lazy body
// match stops at the first closing tag of ANY non-content element: an opening
// tag whose attribute value contains a foreign close tag (rare) then leaves a
// little stray text, which is safer than a backreference match that could
// swallow the rest of the document.
const NON_CONTENT =
    /<(script|style|noscript|template|head|svg|canvas)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|head|svg|canvas)>/gi;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;

// <pre> blocks become fenced code. The placeholder is a private-use codepoint
// pair, so page text can never collide with it, and the block's content skips
// every later inline pass (a `<b>` inside code stays literal text).
const PRE_OPEN = /<pre\b[^>]*>/i;

const extractPreBlocks = (html: string, fenced: boolean): { html: string; blocks: string[] } => {
    const blocks: string[] = [];
    let output = html;

    for (;;) {
        const open = PRE_OPEN.exec(output);
        if (!open) break;

        const start = open.index;
        const afterOpen = start + open[0].length;
        const closeIndex = output.toLowerCase().indexOf('</pre', afterOpen);
        const end = closeIndex === -1 ? output.length : closeIndex;
        const raw = output.slice(afterOpen, end);

        const decoded = decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n')).replace(/^\r?\n/, '');
        const fence = fenced ? `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n` : `\n\n${decoded}\n\n`;

        blocks.push(fence);
        output = output.slice(0, start) + '\uE000' + (blocks.length - 1) + '\uE001' + output.slice(end + (closeIndex === -1 ? 0 : '</pre>'.length));
    }

    return { html: output, blocks };
};

const restorePreBlocks = (text: string, blocks: readonly string[]): string =>
    text.replace(/\uE000(\d+)\uE001/g, (_, index: string) => blocks[Number(index)] ?? '');

// Pull the document title out before any tag stripping destroys it.
const extractTitle = (html: string): string | undefined => {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!match) return undefined;

    const title = decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

    return title.length > 0 ? title : undefined;
};

// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------

const convertHtmlToMarkdown = (html: string): { text: string; title?: string } => {
    // Read the title BEFORE the structural passes: <title> normally lives in
    // <head>, and <head> is one of the stripped containers.
    const title = extractTitle(html);

    let output = html.replace(COMMENTS, '').replace(NON_CONTENT, '');

    const { html: withoutPre, blocks } = extractPreBlocks(output, true);
    output = withoutPre;

    // Inline code spans: swap to a placeholder so the emphasis passes below do
    // not mangle backticked text, then restore.
    const spans: string[] = [];
    output = output.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
        spans.push('`' + decodeEntities(inner.replace(/<[^>]*>/g, '')).trim() + '`');

        return `\uE002${spans.length - 1}\uE003`;
    });

    // Emphasis. Nested markers collapse harmlessly: markdown tolerates it.
    output = output
        .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
        .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
        .replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');

    // Links and images. The anchor text may still contain tags; strip them.
    output = output.replace(
        /<a\b[^>]*?href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
        (_, double: string, single: string, bare: string, inner: string) => {
            const href = (double ?? single ?? bare ?? '').trim();
            const label = (inner.replace(/<[^>]*>/g, '') || href).trim();

            return `[${label}](${href})`;
        }
    );
    output = output.replace(
        /<img\b[^>]*?src=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*?(?:\/?>)/gi,
        (_, double: string, single: string, bare: string) => `![image](${(double ?? single ?? bare ?? '').trim()})`
    );

    // Headings.
    output = output.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
        const label = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

        return `\n\n${'#'.repeat(Number(level))} ${label}\n\n`;
    });

    // Blockquotes: prefix every line of the quoted region.
    output = output.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) => {
        const body = inner.replace(/<[^>]*>/g, '').trim();

        return `\n\n${body.split('\n').map((line) => `> ${line.trim()}`).join('\n')}\n\n`;
    });

    // Lists: items become bullets; the wrappers themselves vanish. Nesting is
    // flattened — a known limit of a regex pass, and readable anyway.
    output = output.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
        const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

        return `\n- ${label}`;
    });
    output = output.replace(/<\/?(?:ul|ol|dl|dt|dd)\b[^>]*>/gi, '\n');

    // Rules and line breaks.
    output = output.replace(/<hr\b[^>]*?(?:\/?>)/gi, '\n\n---\n\n');
    output = output.replace(/<br\s*\/?>/gi, '\n');

    // Block boundaries become blank lines, everything else disappears.
    output = output.replace(
        /<\/?(?:p|div|section|article|aside|main|header|footer|nav|figure|figcaption|table|thead|tbody|tr|form|fieldset|details|summary|dl)\b[^>]*>/gi,
        '\n\n'
    );
    output = output.replace(/<[^>]*>/g, '');

    output = decodeEntities(output);
    output = restorePreBlocks(output, blocks);
    output = output.replace(/\uE002(\d+)\uE003/g, (_, index: string) => spans[Number(index)] ?? '');

    // Whitespace collapse: runs of spaces per line, then at most one blank line.
    output = output
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text: output, title };
};

// ---------------------------------------------------------------------------
// Text conversion
// ---------------------------------------------------------------------------

const convertHtmlToText = (html: string): { text: string; title?: string } => {
    // Same ordering rule as the markdown pass: title first, then strip <head>.
    const title = extractTitle(html);

    let output = html.replace(COMMENTS, '').replace(NON_CONTENT, '');

    const { html: withoutPre, blocks } = extractPreBlocks(output, false);

    output = withoutPre
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(
            /<\/?(?:p|div|section|article|aside|main|header|footer|nav|figure|table|tr|form|li)\b[^>]*>/gi,
            '\n'
        )
        .replace(/<[^>]*>/g, ' ');

    output = decodeEntities(output);
    output = restorePreBlocks(output, blocks);

    output = output
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text: output, title };
};

// ---------------------------------------------------------------------------
// Provider entry
// ---------------------------------------------------------------------------

export type NativeFetch = (
    url: string,
    format: 'markdown' | 'text' | 'html'
) => Promise<{ page: PageFetch; converted: ConvertedPage }>;

// Fetch and convert. The decision of WHAT to return is driven by the response's
// actual content type, not the requested format: a markdown request against a
// JSON API returns the JSON, not a conversion of it.
export const fetchNative: NativeFetch = async (url, format) => {
    const page = await requestPage(url, format);

    const isHtml = page.contentType.includes('text/html') || page.contentType.includes('application/xhtml+xml');

    if (!isHtml) {
        return { page, converted: { content: page.body, wasHtml: false } };
    }

    if (format === 'html') {
        return { page, converted: { content: page.body, title: extractTitle(page.body), wasHtml: true } };
    }

    const converted = format === 'markdown' ? convertHtmlToMarkdown(page.body) : convertHtmlToText(page.body);

    return {
        page,
        converted: { content: converted.text, title: converted.title, wasHtml: true }
    };
};
