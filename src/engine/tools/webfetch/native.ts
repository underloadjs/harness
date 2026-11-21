// fetch `native` provider — a direct GET plus a dependency-free conversion.
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
//   - <sup>/<sub> become explicit `^`/`_` markers in BOTH markdown and text
//     output, so an exponent survives as an exponent instead of joining its
//     base (`10<sup>12</sup>` → `10^12`);
//   - any math markup that had to be flattened is reported on
//     `ConvertedPage.mathFlattened`, together with the sentence to say
//     (`MATH_FLATTENED_NOTE`) — this is the one lossy boundary a reader cannot
//     see for themselves, so it is the one that must be stated. ./index reads the
//     flag and puts that sentence on the result as `note`
//     (src/tools/webfetch/index.ts, `loadNative()` → `MATH_FLATTENED_NOTE`), so the
//     disclosure reaches the model and not only this module (issue 0012 in
//     docs/issues, fixed 2026-11-11);
//   - a `>` inside a quoted attribute value does not end a tag, and the
//     MediaWiki `data-mw` round-trip attributes are dropped before conversion,
//     so editing metadata never appears mid-prose;
//   - text output strips all markup and decodes entities;
//   - html output is the raw body, unconverted.
//
// Cross-references:
//   - ./request — the GET, the bounds, the error sentences
//   - ./index   — dispatch + redaction + the character bound

import { requestPage } from './request';
import type { DnsLookup, PageFetch } from './request';

export type ConvertedPage = {
    content: string;
    title?: string;
    // True when the response was HTML, so ./index knows the format conversion
    // applied and a non-HTML body is passed through untouched.
    wasHtml: boolean;
    // True when the conversion flattened math markup — a <sup>, <sub>, <math>,
    // or MathML node in PROSE (not inside a <pre>, which is code and stripped
    // by design). The numbers it produces still look wrong to a reader who
    // cannot see the markup that was there, so this is the fact ./index needs in
    // order to attach MATH_FLATTENED_NOTE to the result, and it is the flag it
    // reads: ./index carries it onto the model-facing `note` for both the window
    // answer and the `query` answer (src/tools/webfetch/index.ts, the
    // `mathFlattenedNote` spreads). Always false for
    // `format: "html"` and for a non-HTML body, where nothing was converted.
    mathFlattened: boolean;
};

// The disclosure text for flattened math, exported so ./index quotes the
// wording verbatim instead of inventing a second sentence for the same fact.
// It is the issue's own sentence, with `format="html"` in the double-quote style
// the other notes in ./index use for a tool argument. Every other lossy boundary
// in this tool family is reported (the offset clamp and the proximity fallback
// each set a `note`); math flattening used to be the silent one, which is how
// `10<sup>12</sup>` reached a model as "1012".
export const MATH_FLATTENED_NOTE = 'Math markup flattened; use format="html" for exact values.';

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

// Page CHROME: navigation and sidebars, whose text a reader never wanted but
// which survive the pass above because they are legitimate content elements.
// Measured: a Wikipedia article returned its entire 321-entry interlanguage list
// (`Аԥсшәа / Acèh / Адыгабзэ / Afrikaans …`) plus the sidebar menu before the
// lead paragraph, and a footer-only offset window came back as nothing but
// "Privacy policy / About Wikipedia / Disclaimers". That is a third of a 64 KiB
// budget spent on links.
//
// A SEPARATE regex from NON_CONTENT, not another name in its alternation: that
// pattern's lazy body stops at the first closing tag of ANY of its elements, so
// folding `nav` in would let a `</aside>` inside a `<nav>` end the match early
// and leave half the navigation behind as stray text. Its own alternation makes
// nav/aside nest correctly against their own kind.
//
// `header` and `footer` are deliberately NOT pruned. On article and docs pages a
// `<header>` routinely carries the page's own heading and summary, and dropping
// it would lose real content to save a few lines — a worse trade than the noise
// it keeps. `format: "html"` is the inspector's view and stays untouched.
//
// KNOWN LIMIT, stated rather than oversold: chrome built from generic `<div>`s
// with class names survives. Measured on the same article, the 321-entry
// interlanguage list lives in `<div class="vector-dropdown mw-portlet">`, not in
// a landmark element. Pruning it would mean matching `<div>` with a lazy close,
// and divs NEST — the first `</div>` ends the match early, so a regex pass
// cannot tell chrome divs from content divs without a real parser. Pruning by
// class name is also how a site's own rename silently changes what the tool
// returns. Verified effect on that page: 40,760 bytes of markup inside the 12
// `<nav>` elements is dropped, and the main menu/sidebar block is gone from the
// output; the language list remains.
const CHROME = /<(nav|aside)\b[^>]*>[\s\S]*?<\/(?:nav|aside)>/gi;

// <pre> blocks become fenced code. The placeholder is a private-use codepoint
// pair, so page text can never collide with it, and the block's content skips
// every later inline pass (a `<b>` inside code stays literal text).
const PRE_OPEN = /<pre\b[^>]*>/i;

// The wrapper elements a syntax highlighter puts INSIDE a <pre>, and the only
// tags stripped there (D3). Measured: every code fence on a real docs page came
// back as `<code><span class="line"><span style="color:#79B8FF">cd</span>…`, so
// roughly 200 characters of styling noise was returned per line of actual code.
//
// Deliberately NARROW. A blanket `<[^>]*>` strip would corrupt the common
// unescaped comparison inside a sample — `if (a<b && c>d)` — because `<b && c>`
// looks like a tag. These names are the ones a highlighter emits and are very
// unlikely to be a bare tag name in code; `b`, `i`, `a`, `p` are NOT stripped, so
// `a<b` survives intact. In valid HTML a code sample escapes its angle brackets
// anyway, so anything matching here was markup.
const PRE_WRAPPER_TAGS = /<\/?(?:span|code|font|mark|kbd|samp|var|sub|sup)\b[^>]*>/gi;

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

        const decoded = decodeEntities(
            raw.replace(PRE_WRAPPER_TAGS, '').replace(/<br\s*\/?>/gi, '\n')
        ).replace(/^\r?\n/, '');
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
// Tag boundaries and math markup (shared by both conversion passes)
// ---------------------------------------------------------------------------

// The attribute run used by the tag patterns that can meet a quoted `>`.
//
// Every tag pattern in this module spelled its attributes `[^>]*`, which ends a
// tag at the FIRST `>` — including one inside a quoted attribute value. A
// spec-compliant tokenizer does not stop there, and the difference is visible:
// MediaWiki's Parsoid puts its round-trip metadata in `data-mw='{…}'`, escaping
// `<` as `&lt;` but leaving a literal `>` inside the quoted value. A `[^>]*`
// boundary ends the tag mid-value and the remainder — `}}'>`, `{{rp|100–105}}`,
// `"i":0`, ~1.4 KB of `{{cite journal |…}}` — is emitted as PROSE, mid-article.
// Measured 2026-11-10 against live pages: the same HTML through a real parser
// yields 0 occurrences of those fragments, while `re.sub(r'<[^>]*>',' ',html)`
// reproduces them byte for byte. The trigger is common, not a `{{refn}}` edge
// case: `data-mw` attributes containing a literal `>` counted per page as
// Photosynthesis 34, General_relativity 6, Quantum_mechanics 5, DNA 3.
//
// The fix is the run itself: inside a tag, a `"…"` or `'…'` group is consumed
// verbatim (it may contain `>`), while a bare `>` still ends the tag. The three
// alternatives are disjoint on their first character and each consumes at least
// one, so the scan stays linear — an unterminated quote fails fast instead of
// backtracking across the document.
const ATTR_RUN = String.raw`(?:"[^"]*"|'[^']*'|[^'"<>])*`;

// The catch-all strip that runs after the named passes, in BOTH passes: the
// markdown pass deletes what is left, the text pass swaps it for a space so
// words on either side of a stripped tag are not glued together.
const TAG_STRIP = new RegExp(`<${ATTR_RUN}>`, 'g');

// Parsoid round-trip metadata: `data-mw` carries the template source (that is
// where the `{{rp|…}}` and `{{cite journal |…}}` text lives), `data-mw-dt` its
// datetime annotations, `data-parsoid` the older equivalent. They are editing
// bookkeeping no reader wants, they are the single most common carrier of a
// quoted `>`, and dropping them makes every name-anchored pass below (`<li>`,
// `<a>`, `<p>`, `<div>` — all still spelled `[^>]*`) safe on MediaWiki without
// rewriting each of them.
//
// It runs AFTER `extractPreBlocks`, so a code sample whose text mentions
// `data-mw="…"` is not rewritten, and it is deliberately absent from
// `format: "html"`, which is the lossless inspector's view.
const MW_METADATA = /\s(?:data-mw|data-mw-dt|data-parsoid)=(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

// Superscripts and subscripts, converted to an explicit marker instead of being
// deleted with their text. Without this, `10<sup>12</sup>` becomes `1012` and a
// reader has no way to know the number is wrong: measured on
// physics.nist.gov/cgi-bin/cuu/Value?hbar the Planck constant came back as
// `x 10-34 J s`, i.e. a subtraction, from source HTML `10<sup>-34</sup>`.
//
// Prefix-only markers (`10^12`, `H_2O`) rather than wrapping ones, because a
// closing `^`/`_` has no meaning anyone reads and `_n_` would collide with
// markdown's underscore emphasis. `<sup>`/`<sub>` INSIDE a `<pre>` stay stripped
// by PRE_WRAPPER_TAGS — that is a code sample, not prose, and it is what the
// wrapper list at the top of this module decided on purpose.
//
// The `\b` matters: MathML spells its variants `<msup>`/`<msub>`, and an open
// tag without it would match those mid-name. MathML is not converted here (its
// semantics are out of scope); it is only disclosed, below.
const SUP_SUB = new RegExp(`<(sup|sub)\\b${ATTR_RUN}>([\\s\\S]*?)<\\/\\1>`, 'gi');

// What counts as math markup being flattened. `<sup>`/`<sub>` are converted, so
// they are reported because the MARKER is a lossy notation, not because the
// value vanished; `<math>` and the MathML element set are flattened into
// juxtaposition (`\frac{\hbar}{2}` → `ℏ2`), which a reader cannot recover.
// `\b` keeps `<main>` from matching `mi` and `<mod>` from matching `mo`.
const MATH_MARKUP =
    /<(?:sup|sub|math|mrow|mi|mn|mo|mtext|mspace|msup|msub|msubsup|mmultiscripts|mfrac|msqrt|mroot|munder|mover|munderover|mpadded|mstyle|mphantom|mtable|maction)\b/i;

// The math handling both passes share, in the one order that is correct:
//   1. drop the round-trip metadata FIRST, because a `data-mw` value can hold
//      wikitext that mentions `<sup>` literally (`10<sup>12</sup>` is what
//      `&action=raw` returns for that same Wikipedia article), and counting that
//      as flattened prose math would raise the note on a page with no math;
//   2. THEN look for math markup, while the tags are still present;
//   3. THEN convert `<sup>`/`<sub>`, so the marker survives every later strip.
const flattenMathMarkup = (html: string): { html: string; mathFlattened: boolean } => {
    const withoutMetadata = html.replace(MW_METADATA, '');
    const mathFlattened = MATH_MARKUP.test(withoutMetadata);

    const text = withoutMetadata.replace(
        SUP_SUB,
        (_whole: string, tag: string, inner: string) =>
            // The marker hugs its base: `10^12`, not `10 ^ 12`. Inner whitespace
            // collapses so a `<sup>` written across lines cannot split a
            // paragraph in the markdown output.
            (tag.toLowerCase() === 'sup' ? '^' : '_') + inner.replace(/\s+/g, ' ').trim()
    );

    return { html: text, mathFlattened };
};

// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------

const convertHtmlToMarkdown = (
    html: string
): { text: string; title?: string; mathFlattened: boolean } => {
    // Read the title BEFORE the structural passes: <title> normally lives in
    // <head>, and <head> is one of the stripped containers.
    const title = extractTitle(html);

    let output = html.replace(COMMENTS, '').replace(NON_CONTENT, '').replace(CHROME, '');

    const { html: withoutPre, blocks } = extractPreBlocks(output, true);
    output = withoutPre;

    // Inline code spans: swap to a placeholder so the emphasis passes below do
    // not mangle backticked text, then restore.
    const spans: string[] = [];
    output = output.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
        spans.push('`' + decodeEntities(inner.replace(/<[^>]*>/g, '')).trim() + '`');

        return `\uE002${spans.length - 1}\uE003`;
    });

    // Math markup, handled beside the emphasis pass below and for the same
    // reason: it has to happen while the tags are still there. Placed after the
    // <pre> and <code> extractions on purpose — a code fence and a code span are
    // meant to come back as written, so a `<sup>` inside them is text and stays
    // stripped rather than marker-ised or flagged.
    const math = flattenMathMarkup(output);
    output = math.html;

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

    // Block boundaries become blank lines, everything else disappears. The
    // named passes above still spell their attributes `[^>]*`: the only
    // attribute that realistically carries an unescaped `>` is `data-mw`, and
    // `flattenMathMarkup` has already removed it, so the quoted-`>` run is spent
    // on the catch-all, where unlabelled elements (`<span>`, `<i>`, `<cite>`,
    // `<bdi>`) are the ones that actually hold the metadata on a Wikipedia page.
    output = output.replace(
        /<\/?(?:p|div|section|article|aside|main|header|footer|nav|figure|figcaption|table|thead|tbody|tr|form|fieldset|details|summary|dl)\b[^>]*>/gi,
        '\n\n'
    );
    output = output.replace(TAG_STRIP, '');

    output = decodeEntities(output);
    output = restorePreBlocks(output, blocks);
    output = output.replace(/\uE002(\d+)\uE003/g, (_, index: string) => spans[Number(index)] ?? '');

    // Whitespace collapse: runs of spaces per line, then at most one blank line.
    output = output
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text: output, title, mathFlattened: math.mathFlattened };
};

// ---------------------------------------------------------------------------
// Text conversion
// ---------------------------------------------------------------------------

const convertHtmlToText = (
    html: string
): { text: string; title?: string; mathFlattened: boolean } => {
    // Same ordering rule as the markdown pass: title first, then strip <head>.
    const title = extractTitle(html);

    let output = html.replace(COMMENTS, '').replace(NON_CONTENT, '').replace(CHROME, '');

    const { html: withoutPre, blocks } = extractPreBlocks(output, false);

    // Same math handling as the markdown pass, including the reason: `format=text`
    // used to fix nothing, because its own catch-all deleted `<sup>` exactly like
    // markdown's did — the same defect one space apart. `10<sup>12</sup>` came
    // back as `10 12`, which is no exponent either.
    const math = flattenMathMarkup(withoutPre);

    output = math.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(
            /<\/?(?:p|div|section|article|aside|main|header|footer|nav|figure|table|tr|form|li)\b[^>]*>/gi,
            '\n'
        )
        .replace(TAG_STRIP, ' ');

    output = decodeEntities(output);
    output = restorePreBlocks(output, blocks);

    output = output
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text: output, title, mathFlattened: math.mathFlattened };
};

// ---------------------------------------------------------------------------
// Provider entry
// ---------------------------------------------------------------------------
//
// Section selection for the optional `query` argument lives in ./sections: it
// runs on converted content, so it serves the hosted providers too without
// dragging this module's GET transport onto their call path.

export type NativeFetch = (
    url: string,
    format: 'markdown' | 'text' | 'html',
    // Optional DNS resolver forwarded to requestPage for the resolved-address SSRF
    // gate (see ./request). Absent means address-form checking only.
    resolve?: DnsLookup
) => Promise<{ page: PageFetch; converted: ConvertedPage }>;

// Fetch and convert. The decision of WHAT to return is driven by the response's
// actual content type, not the requested format: a markdown request against a
// JSON API returns the JSON, not a conversion of it.
export const fetchNative: NativeFetch = async (url, format, resolve?) => {
    const page = await requestPage(url, format, resolve);

    const isHtml = page.contentType.includes('text/html') || page.contentType.includes('application/xhtml+xml');

    if (!isHtml) {
        return { page, converted: { content: page.body, wasHtml: false, mathFlattened: false } };
    }

    if (format === 'html') {
        return {
            page,
            converted: { content: page.body, title: extractTitle(page.body), wasHtml: true, mathFlattened: false }
        };
    }

    const converted = format === 'markdown' ? convertHtmlToMarkdown(page.body) : convertHtmlToText(page.body);

    return {
        page,
        converted: {
            content: converted.text,
            title: converted.title,
            wasHtml: true,
            // The one fact the reader cannot verify from the text itself: the
            // numbers in front of them went through a notation change. This is
            // what MATH_FLATTENED_NOTE describes, and issue 0012 in docs/issues
            // is the open step of putting it on the model-facing result.
            mathFlattened: converted.mathFlattened
        }
    };
};
