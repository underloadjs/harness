// Shared HTTP plumbing and bounds for the fetch tool.
//
// WHY THIS FILE EXISTS
// --------------------
// fetch has three providers — `native` (a direct GET), `exa` (Exa's /contents
// POST) and `linkup` (Linkup's /v1/fetch POST) — but only the GET policy lives
// here: how long a fetch may take, how much of a response is accepted, which
// content types are readable, what an error may say, and how a URL is validated.
// The two hosted adapters reuse ../websearch/request's JSON plumbing instead,
// because that file already owns the provider-request policy for api.exa.ai and
// api.linkup.so (fixed endpoint, no redirects, sanitized statuses).
//
// Bounds (S1, same philosophy as websearch): these are constants, not knobs. A
// tool result must stay small and predictable no matter what the open web
// returns:
//   - 100 KiB of response body, enforced while streaming so an oversized page
//     is never allocated in full, plus a content-length pre-check that rejects
//     (and cancels) before a single byte is read;
//   - 24,000 characters of returned content (the character budget is what the
//     model actually pays; the byte bound is what the process is exposed to);
//   - 15 s per request, enforced with AbortController and cleaned up in
//     `finally`; one attempt per user agent, plus a single honest-UA retry when
//     Cloudflare challenges the browser-impersonating one.
//
// 100 KiB (not the 512 KiB the provider requests in ../websearch/request allow)
// is deliberate: this GET faces arbitrary hosts, and a page that does not fit is
// a file, not an article. A non-text content type and an oversized body are both
// refusals, and the tool description points the model at the host's download tool
// for them instead of raising the bound here.
//
// Redirects are FOLLOWED here (up to fetch's implementation default), unlike
// the fixed-endpoint search requests: a page URL legitimately redirects, and
// the result reports the final URL so the model cites where the content
// actually came from. The credential never rides along — the key is only ever
// sent to api.exa.ai, never to a fetched page.
//
// Errors are sanitized on purpose: a page status is reported, a page body
// never is (error pages are HTML), and a network failure is reduced to one
// fixed sentence. There is no retry beyond the Cloudflare UA swap, so a model
// cannot multiply spend by hammering a slow host.
//
// Cross-references:
//   - ./native      — the GET flow and the HTML conversion
//   - ./exa         — Exa /contents wire body + result mapping
//   - ./linkup      — Linkup /v1/fetch wire body + result mapping
//   - ./index       — createWebFetchTool: key resolution, validation, dispatch
//   - ../websearch/request — createRedactor (reused), the search-side twin

import { HarnessError } from '../../util';

// Per-request budget. One attempt (plus the Cloudflare UA retry), then reported.
export const FETCH_TIMEOUT_MS = 15_000;

// Response ceiling, in bytes (1 MiB). The body is read through a stream and
// the budget is checked per chunk, so a host cannot force a full allocation.
// Content-length is checked too, when the host sends it, and an advertised size
// over this bound is rejected before the body is read at all. Network chunks are
// not size-guaranteed, so the counter is checked after every chunk and the
// reader is cancelled the moment the budget is crossed: bytes beyond the budget
// are never consumed.
//
// WHY 1 MiB AND NOT THE OLD 100 KiB: the byte cap is a TRANSFER budget, but the
// old 100 KiB was acting as a CONTENT budget. A measured run over the top ten
// results of a real search found 5 of 8 pages unreadable purely because their
// raw HTML was over 100 KiB — GitHub, a13n.dev, arxiv, a docs site and
// Wikipedia — each costing a wasted model turn. Those pages convert to far less
// text than their HTML weighs, so the cap was refusing content the tool could
// have returned inside its own character bound. 1 MiB is 10x the old figure and
// still refuses the pathological case (a 1.6 MiB Wikipedia article is readable
// now; a 20 MiB HTML dump is not).
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// Returned-content ceiling, in characters (10x the previous 24,000). This is
// what the model pays; MAX_RESPONSE_BYTES is what the process is exposed to.
export const MAX_CONTENT_CHARS = 240_000;

// The ceiling on the SERIALIZED tool result. The harness caps every model-facing
// tool result at MODEL_TOOL_RESULT_BUDGET_BYTES (core/result-budget.ts) and
// replaces an over-budget value with a generic envelope that DROPS this tool's
// own metadata (url, title, contentType, characters, truncated, nextOffset).
// So ./index bounds the content to fit inside that cap itself: the tool does the
// truncating, keeps its shape, and reports `nextOffset` instead of being
// silently re-wrapped by the harness. A 240,000-character page is therefore
// reachable, but never in one result that the harness would flatten.
export const MAX_RESULT_BYTES = 64 * 1024;

// The fixed keys of a fetch result (provider, url, contentType, format,
// characters, truncated, pageCharacters, offset, nextOffset, title) plus JSON
// punctuation and escaping. Measured well under this; the fit loop is exact
// regardless, so this only decides where the shrink starts.
export const RESULT_OVERHEAD_BYTES = 2_048;

// The content ceiling for ONE result, in UTF-8 BYTES: the harness cap minus the
// object's own overhead. BYTES and not characters on purpose — the harness budget
// this protects (core/result-budget.ts) is measured in bytes, so a page full of
// multi-byte text carries FEWER characters than this number and the tool must not
// claim otherwise. Exported because a test must assert the real bound rather than
// re-derive the arithmetic.
export const MAX_RESULT_CONTENT_BYTES = MAX_RESULT_BYTES - RESULT_OVERHEAD_BYTES;

// A <title> is a label, not free text: anything longer is dropped.
export const MAX_TITLE_CHARS = 300;

// A fetchable URL is bounded like a cited one: longer is rejected, not sliced.
export const MAX_URL_CHARS = 2_048;

// The content-type header is echoed into the result; a megabyte of parameters
// would not be information.
export const MAX_CONTENT_TYPE_CHARS = 200;

// Redirect hops to follow by hand. Bounded so a host cannot park the tool in a
// cycle for the whole 15 s budget.
export const MAX_REDIRECTS = 5;

// A `query` argument is a search phrase, not a document: anything longer is
// almost certainly the model pasting the page back.
export const MAX_QUERY_CHARS = 200;

// Sections a `query` may return. Bounded so a one-word query against a huge
// page cannot smuggle the whole document back past the character bound.
export const MAX_QUERY_BLOCKS = 20;

// The user agents. The first impersonates a browser (many hosts 403 an
// unidentified client); the second is honest and is tried once when Cloudflare
// challenges the impersonation — a bot with a fake UA and a mismatched TLS
// fingerprint is exactly what `cf-mitigated: challenge` answers.
export const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
export const HONEST_USER_AGENT = 'underload-harness';

// The Accept header steers format negotiation: a server that can serve the
// requested format directly (markdown files, plain-text endpoints) skips HTML
// entirely, which is both faster and cleaner than converting.
export const acceptHeader = (format: 'markdown' | 'text' | 'html'): string => {
    switch (format) {
        case 'markdown':
            return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
        case 'text':
            return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
        case 'html':
            return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
    }
};

// One fixed sentence per failure class. Page bodies are deliberately absent:
// an error page is HTML noise the model does not need.
const statusFailure = (status: number): HarnessError => {
    if (status === 404) return new HarnessError('fetch could not find the page (HTTP 404).');
    if (status === 401 || status === 403) {
        return new HarnessError(`fetch was denied access to the page (HTTP ${status}).`);
    }
    if (status === 429) return new HarnessError('fetch is rate limited by the host (HTTP 429). Try again later.');

    return new HarnessError(`fetch failed (HTTP ${status}).`);
};

// The cap itself is a deliberate design (2 tests pin it): a page that will not
// fit is a file, not an article, and the tool refuses rather than streaming an
// arbitrary host into memory. What was missing is the REMEDY. The binary path
// already names `download`; the size path just said "too big" and left the model
// to guess. Measured in this session, that meant three real pages — an RFC in
// .html, the same RFC's 1.1 MB sibling, and a 1.6 MB Project Gutenberg text —
// were simply unfetchable with no way forward offered, even though the tool can
// serve 240,000 characters of a page it would accept.
const oversizedResponse = (): HarnessError =>
    new HarnessError(
        `fetch received a response larger than ${MAX_RESPONSE_BYTES} bytes. Try the plain-text or raw source form of the page if the host offers one (for example .txt, or a "?action=raw" / print view), ask for fewer characters with "query", or use the \`download\` tool to save the bytes and read them with grep and read.`
    );

// ---------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------

// The `charset` parameter of a Content-Type header, or undefined. The body was
// previously decoded with a default-constructed TextDecoder, which is always
// UTF-8, so a declared `charset=windows-1252` page came back as mojibake (a
// probe of the bytes for "Café" in cp1252 returned "Caf"). The label is passed
// straight to TextDecoder, which owns the WHATWG label table and its aliases;
// an unrecognised label throws there and falls back to UTF-8 rather than
// failing the fetch.
export const charsetFrom = (contentType: string): string | undefined => {
    const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();

    return value.length > 0 ? value.slice(0, 64) : undefined;
};

// A decoder for one declared charset, UTF-8 on anything unusable. Never throws:
// a hostile or malformed charset must degrade to the old behaviour, not lose the
// page.
export const decoderFor = (charset: string | undefined): TextDecoder => {
    if (charset === undefined) return new TextDecoder();

    try {
        return new TextDecoder(charset.toLowerCase());
    } catch {
        return new TextDecoder();
    }
};

// ---------------------------------------------------------------------------
// Binary gate
// ---------------------------------------------------------------------------

// Extensions whose bytes are never readable as text. `fetch` is the STRUCTURED
// CONTENT path: it returns text the model can read, cite and search. Anything
// that is fundamentally a file — an image, video, audio, an archive, a font, an
// office document, an executable — belongs to `download`, which hands over real
// bytes. Refusing on the extension is a cheap pre-flight check that saves a
// 15 s transfer and a 1 MiB read for a page that would only be rejected later by
// the content-type gate anyway (or, worse, decoded as binary garbage when a
// misconfigured host labels it `text/plain`).
//
// Deliberately absent: .md .txt .json .jsonl .yaml .yml .xml .csv .tsv .html
// .htm .svg .tex .rtf — all text. `.svg` in particular is text and often carries
// readable content, which is why `readableMime` already makes that exception.
const BINARY_EXTENSIONS = new Set([
    // images
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.apng', '.bmp', '.dib', '.tif', '.tiff', '.ico', '.cur', '.heic', '.heif', '.psd', '.xcf',
    // video
    '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp',
    // audio
    '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.aiff', '.mid', '.midi',
    // documents that are containers, not text
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.epub',
    // archives
    '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.tar', '.cab', '.iso', '.dmg',
    // fonts
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    // binaries
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.war', '.pyc', '.o', '.a', '.wasm', '.elf', '.msi', '.apk', '.deb', '.rpm'
]);

// The extension of a URL's last path segment, lowercased, or undefined when the
// path has none. Query strings and fragments are already gone (the URL is parsed
// before this runs), so `?download=1` cannot hide an extension.
export const binaryExtension = (url: string): string | undefined => {
    let pathname: string;

    try {
        pathname = new URL(url).pathname;
    } catch {
        return undefined;
    }

    const leaf = pathname.split('/').filter((segment) => segment.length > 0).pop() ?? '';
    const dot = leaf.lastIndexOf('.');

    if (dot <= 0) return undefined;

    const extension = leaf.slice(dot).toLowerCase();

    return BINARY_EXTENSIONS.has(extension) ? extension : undefined;
};

// ---------------------------------------------------------------------------
// Redirect target validation (SSRF)
// ---------------------------------------------------------------------------

// Hosts that are never a public page. `fetch` follows redirects by default, so
// before this check a public URL could 302 the harness to loopback or to a cloud
// metadata endpoint and the response body came back as tool output. Measured: a
// local server on 127.0.0.1 answered a fetch and its 404 was reported, which is
// both an internal read and a port-open oracle.
//
// This validates the address form, not the route: an IP literal is checked
// against the non-public ranges, and `localhost`/`.localhost` by name. A DNS name
// that RESOLVES to a private address is not caught here, because the platform
// fetch exposes no hook between a redirect and the connection — stated plainly
// rather than oversold. Blocking IP literals plus loopback names closes the two
// shapes that matter in practice (metadata endpoints and local services reached
// through a redirect) without adding a DNS dependency to a zero-dependency tool.
const PRIVATE_IPV4 = /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.0\.|192\.168\.|198\.1[89]\.|0\.)/;
const PRIVATE_IPV6 = /^(?:(?:fe80|fc|fd)[0-9a-f:]*|::1?|::ffff:(?:7f00:1|0?0?0?0?0?1)(?::0)?|64:ff9b::)/i;

export const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');

    if (host.length === 0) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    // IPv4 literal (including the dotted form a browser accepts).
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        return PRIVATE_IPV4.test(host) || host.startsWith('100.64.');
    }

    // IPv6 literal: anything with a colon. Also covers the mapped IPv4 forms.
    if (host.includes(':')) {
        const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
        if (mapped !== null) return PRIVATE_IPV4.test(mapped[1]);

        return PRIVATE_IPV6.test(host);
    }

    return false;
};

// A URL the tool may actually request: absolute http(s), no userinfo, bounded,
// and not a private/loopback target. Returns the normalized URL, or undefined.
// Used for the FIRST hop and for every redirect target.
export const safeFetchUrl = (value: unknown): string | undefined => {
    const normalized = fetchableUrl(value);
    if (normalized === undefined) return undefined;

    try {
        return isPrivateHost(new URL(normalized).hostname) ? undefined : normalized;
    } catch {
        return undefined;
    }
};

// ---------------------------------------------------------------------------
// Resolved-address SSRF (F5)
// ---------------------------------------------------------------------------
//
// `isPrivateHost` validates the ADDRESS FORM. A public-looking DNS name that
// RESOLVES to a private address sailed through it, and that is exactly how the
// cloud metadata service gets read from a text tool: `169-254-169-254.nip.io`
// and `127.0.0.1.nip.io` are public names (verified by lookup) whose A records
// are 169.254.169.254 and 127.0.0.1. Measured in this session: the literal
// `http://127.0.0.1/` was refused by the filter, while `http://127.0.0.1.nip.io/`
// was not refused at all and reached the network — two different error classes
// proving the address check never saw the resolved IP.
//
// So the gate is applied twice: lexically on the URL (fast, always), and again
// on the resolved address when a resolver is configured. The second pass is
// deliberately OPTIONAL and FAIL-OPEN, for three reasons:
//   1. Node's `dns` is not available to a browser/bun runtime, and this tool
//      must not stop working there;
//   2. a resolver failure must not be reported as "this URL is private";
//   3. the offline test suite stubs `fetch` and never stubs DNS, so an
//      un-injected resolver must not turn a green suite red.
// A host that injects `resolve` closes the rebinding hole; a host that does not
// keeps today's behaviour and the documented limitation stays honest.
export type DnsLookup = (hostname: string) => Promise<string[]>;

// Bound the lookup so a slow or hostile DNS answer cannot consume the fetch
// budget before the fetch itself has started.
const RESOLVE_TIMEOUT_MS = 2_000;

export const resolvePublicHost = async (
    hostname: string,
    resolve?: DnsLookup
): Promise<{ blocked: boolean; address?: string }> => {
    if (resolve === undefined) return { blocked: false };

    // An IP literal needs no lookup, and looking one up would be a wasted query.
    if (isPrivateHost(hostname)) return { blocked: true };
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return { blocked: false };

    let addresses: string[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // The watchdog is cleared in `finally`: an un-cleared timer would hold the
        // event loop open after the answer arrived and delay process exit.
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('dns timeout')), RESOLVE_TIMEOUT_MS);
        });

        addresses = await Promise.race([resolve(hostname), deadline]);
    } catch {
        // No answer, a timeout, or a resolver that is not a function: not a
        // security verdict, so proceed and let the connection decide.
        return { blocked: false };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }

    for (const address of addresses ?? []) {
        if (isPrivateHost(address)) return { blocked: true, address };
    }

    return { blocked: false };
};

// Best-effort release of a body that is rejected before it is read (a failing
// status, a declared size over the budget, or an unreadable content type).
// Without it the connection stays busy downloading bytes the tool has already
// decided to throw away.
//
// Deliberately NOT awaited: cancelling the body of a `Response.clone()` never
// settles while its sibling branch is unread, and an await here would put the
// model's error message behind a stream that can outlive the 15 s budget. The
// source `cancel()` callback still runs synchronously (measured), so "the body
// was released, and nothing was consumed" remains observable and exact.
const cancelBody = (response: Response): void => {
    try {
        void response.body?.cancel().catch(() => {
            // The stream may already be closed; the caller's error is the one
            // that matters.
        });
    } catch {
        // A runtime without a cancellable body: the error path is unaffected.
    }
};

// Read a response body without ever holding more than MAX_RESPONSE_BYTES.
// Same streaming budget as ../websearch/request's reader: chunk-by-chunk byte
// counting, stream-cancel on overflow, and a TextDecoder that carries partial
// multi-byte characters across chunk boundaries.
const readBody = async (
    response: Response,
    failure: () => HarnessError,
    charset?: string
): Promise<string> => {
    const stream = response.body;

    if (!stream || typeof stream.getReader !== 'function') {
        let body: string;

        try {
            // `response.text()` uses the charset the platform can see; this path
            // only runs on a runtime with no readable stream, and the byte check
            // below still bounds it.
            body = await response.text();
        } catch {
            throw failure();
        }

        if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw oversizedResponse();

        return body;
    }

    const reader = stream.getReader();
    const decoder = decoderFor(charset);
    const parts: string[] = [];
    let received = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            received += value.byteLength;

            // Stop the transfer before throwing: returning while the host is
            // still sending would leave the socket busy for the rest of the budget.
            if (received > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // The stream may already be closed; the size error is the one
                    // the caller needs.
                }

                throw oversizedResponse();
            }

            parts.push(decoder.decode(value, { stream: true }));
        }

        parts.push(decoder.decode());

        return parts.join('');
    } catch (error) {
        if (error instanceof HarnessError) throw error;

        throw failure();
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Ignore: the stream is already done or cancelled.
        }
    }
};

// A fetched page is only useful to the model as text. Images and binary
// documents are rejected with one sentence rather than returned as mojibake;
// svg+xml counts as text because it IS text and often carries readable content.
// A host that wants the bytes (an image, a PDF, an archive) uses a download tool
// instead — that is what the fetch description tells the model to do, so this
// gate and that sentence are one policy stated twice.
const IMAGE_MIMES = /^(image|audio|video)\//;

// The one image type that IS text, and it has to be checked BEFORE the family
// rejection: an `image/svg+xml` string matches IMAGE_MIMES, so the exception
// that used to sit at the bottom of this function was unreachable and a real
// SVG document was reported as an unsupported content type. Narrow on purpose —
// every other image/audio/video type still falls through to the rejection, so
// "non-text is refused" is exactly as strong as before.
const TEXT_IMAGE_MIME = 'image/svg+xml';

const readableMime = (mime: string): boolean => {
    if (mime.length === 0) return true; // no header: treat the body as text
    if (mime === TEXT_IMAGE_MIME) return true;
    if (mime === 'application/pdf') return false;
    if (mime.startsWith('application/octet-stream')) return false;
    if (IMAGE_MIMES.test(mime)) return false;

    return (
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime.endsWith('+json') ||
        mime === 'application/xml' ||
        mime.endsWith('+xml') ||
        mime === 'application/xhtml+xml' ||
        mime === 'application/javascript' ||
        mime === 'application/x-javascript' ||
        mime === 'application/typescript'
    );
};

export const mimeFrom = (contentType: string): string =>
    contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';

// Validate a fetch target. Absolute http(s), no userinfo (a `user:pass@host`
// URL from the model would put credentials on the wire), bounded length.
// Returns the normalized URL string, or undefined when the value is unusable.
export const fetchableUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return undefined;

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;

        const normalized = parsed.toString();
        return normalized.length > MAX_URL_CHARS ? undefined : normalized;
    } catch {
        return undefined;
    }
};

// A Cloudflare bot challenge answers 403 with `cf-mitigated: challenge`.
const isCloudflareChallenge = (response: Response): boolean =>
    response.status === 403 && response.headers.get('cf-mitigated') === 'challenge';

export type PageFetch = {
    // The URL after any redirects.
    url: string;
    contentType: string;
    body: string;
    // Redirect hops actually taken, so a caller can report a long chain.
    redirects: number;
};

// A redirect Location header resolved against the URL that produced it. A
// relative Location is legal and common, so it is resolved rather than rejected;
// the result still has to pass the same gate as the original target.
const redirectTarget = (location: string | null, from: string): string | undefined => {
    if (location === null || location.trim().length === 0) return undefined;

    try {
        return new URL(location.trim(), from).toString();
    } catch {
        return undefined;
    }
};

// One bounded GET. `format` only steers the Accept header — the body is
// returned raw and converted by the caller according to the actual content type.
//
// REDIRECTS ARE FOLLOWED BY HAND (D2). The platform default follows them
// invisibly, which means a public URL can 302 the harness to `http://127.0.0.1/`
// or to a cloud metadata IP and the body lands in the transcript. Measured: a
// local server on 127.0.0.1 answered a fetch and its 404 came back as the tool's
// own error. Following manually lets every hop be re-validated, keeps the
// `redirects` count honest, and still reports the final URL.
export const requestPage = async (
    url: string,
    format: 'markdown' | 'text' | 'html',
    // Optional DNS resolver (see resolvePublicHost). Injected by a host that wants
    // the rebinding hole closed; absent means address-form checking only.
    resolve?: DnsLookup
): Promise<PageFetch> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // `aborted` is the only way to tell our timeout from a network refusal,
    // since fetch rejects with an AbortError for both.
    const networkFailure = (): HarnessError =>
        controller.signal.aborted
            ? new HarnessError(`fetch timed out after ${FETCH_TIMEOUT_MS} ms.`)
            : new HarnessError('fetch could not be reached (network error).');

    // A binary extension is a `download` job before a single byte is paid for.
    const extension = binaryExtension(url);
    if (extension !== undefined) {
        throw new HarnessError(
            `fetch does not read ${extension} files: use the \`download\` tool for binary content.`
        );
    }

    const send = async (target: string, userAgent: string): Promise<Response> => {
        try {
            return await fetch(target, {
                method: 'GET',
                headers: {
                    'user-agent': userAgent,
                    accept: acceptHeader(format),
                    'accept-language': 'en-US,en;q=0.9'
                },
                signal: controller.signal,
                // Followed by hand so each hop is validated (see above).
                redirect: 'manual'
            });
        } catch {
            throw networkFailure();
        }
    };

    // Refusal wording shared by the first hop and every redirect, so a blocked
    // target always says which address was the problem when a resolver found one.
    const refuse = (detail?: string): HarnessError =>
        new HarnessError(
            `fetch refuses this URL: it is not a public absolute http(s) address (loopback and private addresses are not fetched)${
                detail === undefined ? '' : ` — ${detail} resolves to a non-public address`
            }.`
        );

    try {
        let target = safeFetchUrl(url);

        if (target === undefined) {
            throw refuse();
        }

        // Second gate: the name may be public while the address behind it is not.
        const firstHop = await resolvePublicHost(new URL(target).hostname, resolve);
        if (firstHop.blocked) {
            throw refuse(firstHop.address ?? new URL(target).hostname);
        }

        let response: Response | undefined;
        let redirects = 0;

        for (;;) {
            response = await send(target, BROWSER_USER_AGENT);

            // The one retry: a Cloudflare challenge means the fake-browser UA was
            // detected, so answer honestly and try once more.
            if (isCloudflareChallenge(response)) {
                try {
                    await response.body?.cancel();
                } catch {
                    // The body may already be consumed; the retry is what matters.
                }

                response = await send(target, HONEST_USER_AGENT);
            }

            // A 3xx is a hop, not an answer. Follow it while the target stays safe.
            if (response.status >= 300 && response.status < 400) {
                const next = redirectTarget(response.headers.get('location'), target);

                try {
                    await response.body?.cancel();
                } catch {
                    // A redirect body is rarely worth reading.
                }

                if (next === undefined) {
                    throw new HarnessError(`fetch followed a redirect to an unusable location (HTTP ${response.status}).`);
                }

                const safe = safeFetchUrl(next);
                if (safe === undefined) {
                    throw new HarnessError(
                        `fetch refused a redirect to a non-public address (HTTP ${response.status}).`
                    );
                }

                // A redirect is the attacker's turn: re-run the resolved check on the
                // new host, not just its spelling.
                const hop = await resolvePublicHost(new URL(safe).hostname, resolve);
                if (hop.blocked) {
                    throw new HarnessError(
                        `fetch refused a redirect to a non-public address (HTTP ${response.status})${
                            hop.address === undefined ? '' : ` — ${hop.address}`
                        }.`
                    );
                }

                redirects += 1;

                if (redirects > MAX_REDIRECTS) {
                    throw new HarnessError(`fetch stopped after ${MAX_REDIRECTS} redirects.`);
                }

                target = safe;
                continue;
            }

            break;
        }

        if (!response.ok) {
            // An error page is HTML noise we never read: release the body so the
            // connection is not held for it.
            cancelBody(response);

            throw statusFailure(response.status);
        }

        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            // Nothing is read on this path: the advertised size alone is the
            // rejection, and cancelling stops the download of an oversized page.
            cancelBody(response);

            throw oversizedResponse();
        }

        const contentType = (response.headers.get('content-type') ?? '').slice(0, MAX_CONTENT_TYPE_CHARS);

        const mime = mimeFrom(contentType);
        if (!readableMime(mime)) {
            // Cancel so the socket is not held for a body we will never read.
            cancelBody(response);

            throw new HarnessError(
                `fetch does not support this content type (${mime || 'unknown'}): use the \`download\` tool for binary content.`
            );
        }

        // The declared charset drives the decode (D4); a missing or unrecognised
        // label falls back to UTF-8, which is the previous behaviour.
        const body = await readBody(response, networkFailure, charsetFrom(contentType));

        return { url: response.url || target, contentType, body, redirects };
    } finally {
        // Clear before the controller goes out of scope so a completed fetch
        // never keeps the process alive for the rest of the budget.
        clearTimeout(timer);
    }
};
