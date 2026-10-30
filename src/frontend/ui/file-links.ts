// Transcript file links: local file paths become keyboard-activatable buttons.
//
// R11 asks the transcript to treat file mentions as first-class affordances:
// clicking one opens a reusable preview dialog instead of a separate transcript
// pane. This module owns the PURE, browser-safe decisions:
//
//   - what counts as a local relative path (`localFilePathOf`);
//   - which extensions are file-like enough to linkify (`FILE_LINK_EXTENSIONS`);
//   - the post-sanitization DOM transform (`enhanceFileLinks`) covering:
//       * explicit relative Markdown links  `[x](./src/a.ts)`;
//       * `@path` mentions                  `@src/frontend/main.ts`;
//       * inline code paths                 `` `src/frontend/main.ts` ``;
//       * clearly file-like plain text      `src/frontend/main.ts`, `foo.ts`.
//
// SECURITY MODEL
// --------------
// Every transform below runs AFTER `markdown.ts` has sanitized the HTML. Nothing
// here parses or injects HTML: paths are read from text/attributes and written
// back with createElement/textContent, so the sanitizer's output remains the only
// markup in the transcript.
//
// `localFilePathOf` is UI HYGIENE, not a sandbox. It refuses what can escape the
// harness working directory before a request is even formed:
//   - absolute POSIX paths (`/etc/passwd`), protocol-relative (`//host`) and UNC
//     (`\\host\share`) forms;
//   - Windows drive paths (`C:\x`, `C:/x`) and backslashes in general;
//   - URL schemes (`http:`, `file:`, `javascript:`, `data:`, …);
//   - traversal segments (`..`) and ambiguous query/fragment text;
//   - control characters and over-long values.
// The existing server-side `fileRead` tool has NO sandbox of its own (it resolves
// against the process cwd). This check therefore prevents an obvious cross-root
// request from the browser but must not be described as a hard server boundary.
//
// Cross-references:
//   - preview dialog: ./file-preview.ts (`openFilePreview`)
//   - sanitized markdown source: ./markdown.ts
//   - consumers: ./turns.ts (prompt + assistant markdown), ui/tools.ts (result body)
//   - styles: src/frontend/styles.css (`.file-link`)

// Long enough for a real repository path, short enough that a hostile text node
// cannot make the validator scan an unbounded string.
const MAX_LOCAL_PATH_LENGTH = 400;

// Extensions treated as text files this UI can preview. Deliberately TEXT-ish:
// `fileRead` rejects binary content, and images are handled by attachment chips
// instead. Keep this list in sync with the preview language map below.
export const FILE_LINK_EXTENSIONS: ReadonlySet<string> = new Set([
    'astro',
    'bash',
    'bat',
    'c',
    'cc',
    'cfg',
    'cmd',
    'conf',
    'cpp',
    'cs',
    'css',
    'csv',
    'env',
    'go',
    'gql',
    'graphql',
    'h',
    'hpp',
    'htm',
    'html',
    'ini',
    'java',
    'js',
    'json',
    'jsonc',
    'jsx',
    'kt',
    'kts',
    'less',
    'lock',
    'log',
    'markdown',
    'md',
    'mjs',
    'cjs',
    'mts',
    'cts',
    'php',
    'ps1',
    'py',
    'rb',
    'rs',
    'scss',
    'sh',
    'sql',
    'svelte',
    'swift',
    'toml',
    'ts',
    'tsx',
    'txt',
    'vue',
    'xml',
    'yaml',
    'yml',
    'zsh'
]);

// File name suffix -> highlight.js alias (see markdown.ts LANGUAGE_ALIASES). An
// unknown extension falls back to plain escaped text, never a guess that would
// colour ordinary prose.
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
    bash: 'bash',
    bat: 'bash',
    c: 'cpp',
    cc: 'cpp',
    cfg: 'ini',
    cmd: 'bash',
    conf: 'ini',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    gql: 'graphql',
    graphql: 'graphql',
    h: 'cpp',
    hpp: 'cpp',
    htm: 'xml',
    html: 'xml',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonc: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    kts: 'kotlin',
    less: 'css',
    markdown: 'markdown',
    md: 'markdown',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    php: 'php',
    ps1: 'powershell',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'css',
    sh: 'bash',
    sql: 'sql',
    svelte: 'xml',
    swift: 'swift',
    toml: 'ini',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'xml',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash'
};

// Lowercase extension of the LAST path segment; '' for dotfiles/no extension.
// `dot > 0` intentionally excludes `.gitignore` (a name, not an extension).
export const extensionOfPath = (path: string): string => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
};

// True when the path names a text-like file this UI can preview.
export const isFileLikePath = (
    path: string,
    extensions: ReadonlySet<string> = FILE_LINK_EXTENSIONS
): boolean => extensions.has(extensionOfPath(path));

// Normalize/validate a browser-originated path. Returns the relative path that
// may be sent to `fileRead`, or undefined when the value is not a safe local
// relative path. See the module header for the (non-)sandbox framing.
export const localFilePathOf = (raw: string): string | undefined => {
    const value = raw.trim();
    if (value.length === 0 || value.length > MAX_LOCAL_PATH_LENGTH) return undefined;

    // Control characters can hide a second path or break logs/requests.
    if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;

    // Backslash is a Windows separator and is also how a UNC path starts. Both
    // are refused; Markdown/URL paths are written with forward slashes.
    if (value.includes('\\')) return undefined;

    // Absolute POSIX path, protocol-relative URL, or home-relative path.
    if (value.startsWith('/') || value.startsWith('~')) return undefined;

    // Windows drive path (`C:`, `C:/x`, `C:\x`).
    if (/^[A-Za-z]:/.test(value)) return undefined;

    // Any URL/file/data/javascript scheme. Checked before segment splitting so
    // `https://host/a.ts` can never be mistaken for `host/a.ts`.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined;

    // Query/fragment syntax is not part of a filesystem path. Refusing it keeps
    // `src/a.ts?raw` from silently previewing a different path.
    if (/[?#]/.test(value)) return undefined;

    const segments = value.split('/');
    // Empty segment = `//`, leading/trailing slash, or an unresolved `.`-only
    // path. `..` is traversal and is refused outright (never normalised away).
    if (segments.some((segment) => segment.length === 0 || segment === '..')) return undefined;

    // Drop harmless `.` segments so repeated renders produce one stable request.
    const normalized = segments.filter((segment) => segment !== '.').join('/');
    if (normalized.length === 0) return undefined;

    return normalized;
};

// Language alias for syntax highlighting a previewed path.
export const languageOfPath = (path: string): string | undefined =>
    LANGUAGE_BY_EXTENSION[extensionOfPath(path)];

export type FileLinkOptions = {
    // Called on click/Enter/Space with the NORMALIZED local path. The caller owns
    // the request (see ./file-preview.ts) so this module stays network-free.
    open: (path: string) => void;
};

// Containers whose text must not be re-linked: code is literal text, an anchor
// already has its own semantics, and a button/previous link is interactive.
const BLOCKED_SELECTOR = 'pre, code, a, button, .file-link, .attachment-chip';

// Plain text is the ambiguous middle ground: `foo.ts` should link, but a product
// name such as "node.js" is prose, not a file. A short, explicit deny-list of
// well-known `<name>.js` products keeps that distinction from becoming a guessing
// game; it never applies to explicit links, @mentions or inline code.
const NON_FILE_BASENAMES: ReadonlySet<string> = new Set([
    'angular.js',
    'backbone.js',
    'd3.js',
    'deno.js',
    'ember.js',
    'express.js',
    'jquery.js',
    'moment.js',
    'next.js',
    'node.js',
    'nuxt.js',
    'react.js',
    'three.js',
    'vue.js'
]);

// Boundary characters that may precede/follow a plain path token. This is what
// stops `https://host/a.ts` (preceded by `/`/`:`) and `foo.ts.extra` (followed by
// `.`) from producing a partial bogus link.
const LEADING_BOUNDARY = /[\s([{"'`>]/;
const TRAILING_BOUNDARY = /[\s)\]},."'`;:!?]/;

// One candidate token: optional `@`, optional `./`/`../` prefix, path segments,
// and a short alphanumeric extension. `.`/`..` are validated later (and refused).
const CANDIDATE_PATTERN = /@?(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}/g;

const isBoundary = (text: string, start: number, end: number, pattern: RegExp): boolean => {
    const before = start === 0 || pattern.test(text[start - 1]);
    const after = end >= text.length || TRAILING_BOUNDARY.test(text[end]);
    return before && after;
};

// Build the interactive element for one path. Using a real <button> gives
// keyboard activation for free; the visible label stays exactly the transcript's
// text (so a link never rewrites prose), while `data-path` carries the value the
// dialog will request.
const createFileLink = (
    label: string,
    path: string,
    options: FileLinkOptions,
    className = 'file-link'
): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.path = path;
    button.title = `Open ${path}`;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', `Open ${path}`);
    button.textContent = label;
    button.addEventListener('click', () => options.open(path));
    return button;
};

// Replace the plain path tokens inside one text node, preserving all surrounding
// text. `label` is the original token (including a leading `@`), so the rendered
// transcript reads identically before and after enhancement.
const linkifyTextNode = (node: Text, options: FileLinkOptions): number => {
    const text = node.data;
    const matches = [...text.matchAll(CANDIDATE_PATTERN)];
    if (matches.length === 0) return 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let count = 0;

    for (const match of matches) {
        const token = match[0];
        const start = match.index ?? 0;
        const end = start + token.length;

        if (start < cursor) continue;
        if (!isBoundary(text, start, end, LEADING_BOUNDARY)) continue;

        const mentioned = token.startsWith('@');
        const path = localFilePathOf(mentioned ? token.slice(1) : token);
        if (path === undefined || !isFileLikePath(path)) continue;

        // Bare prose that happens to look like a filename (`node.js`) stays text;
        // a path with a directory or an explicit mention/code/link is unambiguous.
        if (!mentioned && !path.includes('/') && NON_FILE_BASENAMES.has(path.toLowerCase())) continue;

        // Only token-level replacement: keep the text before the link verbatim.
        fragment.append(text.slice(cursor, start));
        fragment.append(createFileLink(token, path, options));
        cursor = end;
        count += 1;
    }

    if (count === 0) return 0;

    fragment.append(text.slice(cursor));
    node.parentNode?.replaceChild(fragment, node);
    return count;
};

// Convert an inline `<code>path</code>` (NOT inside a fenced block) into a file
// link. The code element is reused as the button's child so the code styling is
// preserved.
const linkifyInlineCode = (code: HTMLElement, options: FileLinkOptions): number => {
    // Code inside a fenced block is a literal listing; code already inside an
    // interactive link/button must not produce a nested button.
    if (code.closest('pre') !== null) return 0;
    if (code.closest('button, a, .file-link') !== null) return 0;

    const text = code.textContent ?? '';
    const path = localFilePathOf(text);
    if (path === undefined || !isFileLikePath(path)) return 0;

    const button = createFileLink(text, path, options, 'file-link file-link-code');
    code.replaceWith(button);
    button.replaceChildren(code);
    return 1;
};

// Convert a relative Markdown link whose target is a local file into a file link.
// Absolute URLs, fragments and mailto are deliberately untouched: external links
// keep their normal browser behaviour (see markdown.ts `hardenLinks`).
const linkifyAnchor = (anchor: HTMLAnchorElement, options: FileLinkOptions): number => {
    if (anchor.closest('pre') !== null) return 0;

    const href = (anchor.getAttribute('href') ?? '').trim();
    if (href.length === 0) return 0;

    // Anything with a scheme, protocol-relative host, or pure fragment is not a
    // local file link. `localFilePathOf` also refuses these; this early exit keeps
    // the intent explicit and avoids touching external anchors at all.
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|#)/.test(href)) return 0;
    if (href.startsWith('/') || href.startsWith('\\')) return 0;

    const path = localFilePathOf(href);
    if (path === undefined || !isFileLikePath(path)) return 0;

    const label = anchor.textContent ?? path;
    const button = createFileLink(label, path, options, 'file-link file-link-anchor');
    // Move the anchor's children so inline markup (e.g. `<code>`) is preserved.
    button.replaceChildren(...Array.from(anchor.childNodes));
    anchor.replaceWith(button);
    return 1;
};

// Public post-sanitization transform. Returns the number of links created (useful
// for tests and for a caller that wants to know whether a body changed).
//
// ORDER MATTERS:
//   1. anchors first, because a Markdown file link is explicit;
//   2. inline code next, because code is explicitly a literal;
//   3. plain text last, so no level re-processes a link created above.
// Every created button is in BLOCKED_SELECTOR, so a second call is idempotent.
export const enhanceFileLinks = (root: ParentNode, options: FileLinkOptions): number => {
    let count = 0;

    const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));
    for (const anchor of anchors) count += linkifyAnchor(anchor, options);

    const codes = Array.from(root.querySelectorAll<HTMLElement>('code'));
    for (const code of codes) count += linkifyInlineCode(code, options);

    // Snapshot text nodes: replacements split/insert nodes while iterating.
    const document = (root as Node).ownerDocument ?? globalThis.document;
    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        textNodes.push(node as Text);
    }

    for (const node of textNodes) {
        const parent = node.parentElement;
        if (parent !== null && parent.closest(BLOCKED_SELECTOR) !== null) continue;
        count += linkifyTextNode(node, options);
    }

    return count;
};
