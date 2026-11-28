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
//   - 1 MiB of response body (see MAX_RESPONSE_BYTES below for why it was raised
//     from 100 KiB), enforced while streaming so an oversized page is never
//     allocated in full, plus a content-length pre-check that rejects (and
//     cancels) before a single byte is read;
//   - 240,000 characters of returned CONTENT, across all of a page's windows
//     (the character budget is what the model actually pays; the byte bound is
//     what the process is exposed to);
//   - ONE result sized to the harness's model-facing cap (see MAX_RESULT_BYTES
//     below), so the tool truncates itself instead of being re-wrapped — and,
//     since F1, sized in the harness's own ESCAPED-byte currency, because a
//     result measured in raw UTF-8 was still over the cap and got refused whole;
//   - 15 s per request, enforced with AbortController and cleaned up in
//     `finally`; one attempt per user agent, plus a single honest-UA retry when
//     Cloudflare challenges the browser-impersonating one.
//
// The transfer cap is 1 MiB against the 512 KiB the fixed provider endpoints in
// ../websearch/request allow (see MAX_RESPONSE_BYTES for the measurement that
// raised it): this GET faces arbitrary hosts, and a page that does not fit is
// still a file, not an article. A non-text content type and an oversized body are
// both refusals, and the tool description points the model at the host's download
// tool for them instead of raising the bound here.
//
// Redirects are FOLLOWED here (up to fetch's implementation default), unlike
// the fixed-endpoint search requests: a page URL legitimately redirects, and
// the result reports the final URL so the model cites where the content
// actually came from. The credential never rides along — the key is only ever
// sent to api.exa.ai, never to a fetched page.
//
// Errors are sanitized on purpose: a page status is reported, a page body
// never is (error pages are HTML), and a network failure is reduced to one
// fixed sentence PER CAUSE CLASS (see the transport classification below) — the
// class, never the Node error text. There is no retry beyond the Cloudflare UA
// swap, so a model cannot multiply spend by hammering a slow host; the class is
// what tells a caller whether a retry could have helped at all.
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

// Returned-content ceiling, in characters (10x the previous 24,000). This is what
// the model pays ACROSS the windows of one page; one RESULT is capped lower, by
// MAX_RESULT_BYTES, and a longer page is reached by paging with `offset`.
// MAX_RESPONSE_BYTES is what the process is exposed to.
export const MAX_CONTENT_CHARS = 240_000;

// The ceiling on the SERIALIZED tool result, in the currency the cap is enforced
// in: the JSON-ESCAPED bytes of `JSON.stringify(result)` as it sits inside the
// model message. The harness caps every model-facing tool result at
// `MODEL_TOOL_RESULT_BUDGET_BYTES` (core/result-budget.ts) and, because a fetch
// result IS a JSON document, an over-budget value is not sliced — it is REFUSED
// whole (`reason: 'oversized-json'`) and the delivery site reports the call as
// FAILED (harness.ts `boundDelivery` → `delivered.rejected ? 'failed'`).
//
// F1 is the reason this constant is written in escaped bytes and not in raw UTF-8.
// The number used to be DOUBLE the harness cap, so a page that filled fetch's own
// content ceiling was, by construction, over the cap: the tool truncated, reported
// `nextOffset`, and the harness threw the whole result away — a successful read
// delivered as a failed tool call.
//
// The value is a LITERAL rather than an import from ../../core: a relative VALUE
// import becomes a captured source dependency of a compiled tool entry (the same
// rule read.tool.ts:682-693 states for the preset, and the same reason
// ./index re-declares its byte helpers), so the number is spelled out here and
// webfetch.test.ts pins it against `MODEL_TOOL_RESULT_BUDGET_BYTES` instead.
export const MAX_RESULT_BYTES = 32 * 1024;

// The MINIMUM room the tool always leaves for the fields that ride beside
// `content` (provider, url, contentType, format, characters, truncated,
// pageCharacters, offset, nextOffset, title, query, matches, totalSections,
// totalMatches, matchMode, stopReason, note, redirects), plus JSON punctuation and
// escaping. ./index MEASURES the real overhead of the result it is about to return
// and spends whichever allowance is larger, so this constant is only the floor: a
// short URL and no title still deliver the full MAX_RESULT_CONTENT_BYTES, while a
// 2,048-character URL plus a 300-character title shrinks the content instead of
// the result.
export const RESULT_OVERHEAD_BYTES = 2_048;

// The MAXIMUM content one result may carry, in the harness's escaped-byte currency:
// the result cap minus the minimum overhead above. It is the number the tool
// description quotes, and it is the bound the fit loop starts from. BYTES and not
// characters on purpose — the budget this protects is measured in bytes, so a page
// full of multi-byte text carries FEWER characters than this number and the tool
// must not claim otherwise. Exported because a test must assert the real bound
// rather than re-derive the arithmetic.
export const MAX_RESULT_CONTENT_BYTES = MAX_RESULT_BYTES - RESULT_OVERHEAD_BYTES;

// The slack the fit loop keeps on top of the measured overhead, for the two figures
// whose serialized width depends on the fit itself and therefore cannot be in the
// skeleton it measures: `characters` (the delivered length) and the digits of a
// `nextOffset` that only exists because the fit cut. Both placeholders in the
// skeleton are at their widest possible value, so this is a second belt, not the
// whole guarantee — 64 bytes covers a `stopReason` key the skeleton already
// includes optimistically plus the digit spread of every number in the object.
export const RESULT_FIT_SAFETY_BYTES = 64;

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

// Sections a HEADING-mode `query` may return — the cap is a heading-mode limit
// only, because proximity mode returns exactly ONE window (see ./sections). It is
// exported so ./index compares the real cap when it decides whether anything was
// withheld, instead of inferring a cap hit from `totalMatches > matches.length`
// (F4: in proximity mode `totalMatches` counts OCCURRENCES, so that comparison
// reported a cap that never fired). Bounded so a one-word query against a huge
// page cannot smuggle the whole document back past the result bound.
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

// ---------------------------------------------------------------------------
// Transport failure classification (issue 0015)
// ---------------------------------------------------------------------------
//
// Everything below exists because ONE sentence was doing the work of three
// situations. A typo'd hostname, a host that refuses the connection, and a
// certificate the chain does not trust are different conditions with different
// remedies, and a caller cannot choose one without knowing which it has.
//
// The sanitization rule (see the header of this file) still holds: the class is
// reported, never the Node error text. `error.cause.code` is a machine-readable
// errno name, not page content, so naming the class adds no transcript noise.
// The no-retry rule is untouched (:39-40 — classification is not a retry); what
// changed is that a message can now say honestly whether a retry could have
// helped at all.
type TransportCause = 'dns' | 'connection' | 'tls' | 'unknown';

// The name behind the host never resolved. `ENOTFOUND` is a definitive NXDOMAIN
// style answer; `EAI_AGAIN` is getaddrinfo failing to get one at all. Both are
// reported as one class because the caller's action is the same: the request
// never reached a host, so repeating it unchanged buys nothing.
const DNS_CAUSE_CODES: readonly string[] = ['ENOTFOUND', 'EAI_AGAIN'];

// The host was reached (or at least addressed) and the connection itself failed:
// refused port, reset mid-handshake/mid-body, or a broken pipe. A retry is
// plausible here, which is exactly what the DNS class is saying it is not.
const CONNECTION_CAUSE_CODES: readonly string[] = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'];

// Certificate and TLS-protocol failures, by their exact OpenSSL/undici names.
// The prefix rules below catch the long tail (`ERR_TLS_*`, `ERR_SSL_*`, and the
// `ALERT_*` codes a peer sends), so a handshake problem never falls back into the
// unclassified sentence.
const TLS_CAUSE_CODES: readonly string[] = [
    'EPROTO',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'CERT_UNTRUSTED',
    'CERT_HAS_REVOKED_SIGNED_CERT'
];

// One sentence per class. Each says whether retrying is plausible, because that
// is the decision the class exists to inform. `provider: "exa"` is named in the
// two classes where a different client can genuinely help: it fetches from
// Exa's own crawler, which reached `httpbin.org/html` on 2026-11-10 in the exact
// situation where the direct GET failed 5 times out of 5 (issue 0015 evidence).
// The `unknown` sentence keeps the historical wording as its first clause, so a
// caller matching on the old string still recognizes the failure.
const TRANSPORT_FAILURE_MESSAGES: Record<TransportCause, string> = {
    dns: 'fetch could not resolve this hostname (DNS found no address for it). Check the URL — the host was never reached, so retrying will not help.',
    connection:
        'fetch could not keep a connection to this host (refused or reset). The host was reached, so a retry may help; "provider": "exa" fetches through a different client and may work where the direct GET does not.',
    tls: 'fetch could not complete the TLS handshake with this host (certificate or protocol error). Retrying will not help: the same handshake fails; "provider": "exa" connects separately and may work.',
    unknown:
        'fetch could not be reached (network error). The cause is not one this tool can classify, so a retry may help; "provider": "exa" fetches through a different client.'
};

// Every errno-style code reachable on one transport rejection. undici rejects
// with `TypeError('fetch failed')` carrying the system error as `cause`, so the
// code is one level down; a dual-stack (happy-eyeballs) failure nests it once
// more inside `cause.errors`; and a failure raised on the response BODY stream
// (a reset mid-download) carries the code on the error itself. Nothing else is
// read — no message, no stack.
const transportCodesOf = (error: unknown): string[] => {
    if (error === undefined || error === null || typeof error !== 'object') return [];

    const shaped = error as { code?: unknown; cause?: unknown };
    const cause = shaped.cause;
    const nested =
        cause !== undefined && cause !== null && typeof cause === 'object'
            ? [
                  (cause as { code?: unknown }).code,
                  ...(Array.isArray((cause as { errors?: unknown }).errors)
                      ? (cause as { errors: unknown[] }).errors.map(
                            (entry) => (entry as { code?: unknown } | undefined)?.code
                        )
                      : [])
              ]
            : [];

    return [shaped.code, ...nested].filter((code): code is string => typeof code === 'string');
};

// The class a transport rejection belongs to; `unknown` when its code is not one
// of the three groups, which keeps the historical sentence reachable rather than
// inventing a fourth guess.
const transportCause = (error: unknown): TransportCause => {
    for (const code of transportCodesOf(error)) {
        if (DNS_CAUSE_CODES.includes(code)) return 'dns';
        if (CONNECTION_CAUSE_CODES.includes(code)) return 'connection';
        if (
            TLS_CAUSE_CODES.includes(code) ||
            code.startsWith('ERR_TLS') ||
            code.startsWith('ERR_SSL') ||
            code.startsWith('ALERT_')
        ) {
            return 'tls';
        }
    }

    return 'unknown';
};

// Exported for the test suite: the classification is a contract (issue 0015
// acceptance criteria 1, 2 and 4), and pinning it directly keeps the tool-level
// tests from having to fabricate a whole GET around it.
export const transportFailureMessage = (error: unknown): string =>
    TRANSPORT_FAILURE_MESSAGES[transportCause(error)];

// The cap itself is a deliberate design (2 tests pin it): a page that will not
// fit is a file, not an article, and the tool refuses rather than streaming an
// arbitrary host into memory. What was missing is the REMEDY. The binary path
// already names `download`; the size path just said "too big" and left the model
// to guess. Measured in this session, that meant three real pages — an RFC in
// .html, the same RFC's 1.1 MB sibling, and a 1.6 MB Project Gutenberg text —
// were simply unfetchable with no way forward offered, even though the tool can
// serve 240,000 characters of a page it would accept.
//
// SCOPED TO THE STATE THAT TRIGGERS IT (issue 0014). The first wording offered
// three generic fetch remedies and two of them cannot work HERE:
//   - `query` selects sections of the CONVERTED document (see ./sections:6-7),
//     and this error fires from the content-length pre-check BEFORE a byte is
//     read (:700-707), so `query` never runs — measured, the identical error came
//     back with and without it. `format` only steers the Accept header (:134-143),
//     which a host is free to ignore; neither is a lever on this body.
//   - `download` + `grep` is self-contradictory BY CONSTRUCTION: this error only
//     fires above 1 MiB and `grep` skips files above 1 MiB
//     (./files/glob.ts:81 `MAX_SEARCH_FILE_BYTES = 1024 * 1024`), and it fails
//     SILENTLY there — `matches: []` with the reason only in `note`.
// `read` is the tool that does handle a large file (windowed continuation via
// `nextByte`/`nextLine`, ./files/read.tool.ts:152-165), and a plain-text or raw
// source URL is the one remedy that shrinks the transferred body — verified
// 2026-11-10 against rfc-editor.org/rfc/rfc9110.txt (502,906 B, fetched fine).
// Every remedy named below was checked in the state that produces this error.
const oversizedResponse = (): HarnessError =>
    new HarnessError(
        `fetch received a response larger than ${MAX_RESPONSE_BYTES} bytes. Try the plain-text or raw source form of the page if the host offers one (.txt, a "?action=raw" / print view) — that is the only remedy that reduces the transferred body; "query" and "format" cannot help, because they apply after this size check. Or use the \`download\` tool to save the bytes and read them with \`read\` (\`grep\` skips files over 1 MiB).`
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
// This validates the address FORM, not the route: an IP literal is checked against
// the non-public ranges, and `localhost`/`.localhost` by name. A DNS name whose A
// record is private is NOT caught here — that needs a lookup, which is the second
// gate below (`resolvePublicHost`), and that gate runs only when a resolver is
// wired (see `WebFetchConfiguration.dns`). Stated plainly rather than oversold:
// with no resolver configured — which is the state of a browser/bun runtime, of a
// host that passes `dns: { off: true }`, and of the offline test suite — the ONLY
// SSRF protection in force is this address-form check plus the redirect re-check
// that uses it. Blocking IP literals plus loopback names closes the two shapes
// that matter in practice without adding a DNS dependency to a zero-dependency
// tool; closing the rebinding hole is the host's opt-in.
//
// WHICH ADDRESS FORMS (the review's security intent, made explicit). A gate that
// only reads dotted quads is a gate you can walk past by writing the same address
// differently, and the address a fetch was built from is not always a dotted quad:
// `new URL()` normalizes the IPv4 notations it recognizes (`http://2130706433/`
// becomes `127.0.0.1` — measured), but a caller that hands `isPrivateHost` or an
// injected `dns.lookup` address TEXT gets the text verbatim, and every form the URL
// parser leaves alone used to be answered "public". So the check now decodes:
//   - IPv4 in the `inet_aton` notations — bare decimal (`2130706433`), hex
//     (`0x7f000001`), octal (`017700000001`), and the 1-3-part shorthands whose last
//     number absorbs the rest (`127.1`, `0x7f.1`);
//   - IPv6 with an IPv4 embedded in it, whatever the text looks like: mapped
//     (`::ffff:7f00:1` AND the uncompressed `0:0:0:0:0:ffff:7f00:1`), compatible
//     (`::7f00:1`), IPv4-translated (`64:ff9b::7f00:1` AND
//     `64:ff9b:0:0:0:0:7f00:1`), 6to4 (`2002:VVVV:VVVV::`, RFC 3056 §5.1 — the
//     tunnel's IPv4 is the SECOND AND THIRD groups, NOT inverted, so `2002:7f00:1::`
//     is 127.0.0.1 and `2002:a9fe:a9fe::` is the metadata address, in compressed,
//     longhand, zero-padded, uppercase, and trailing-host spellings), and Teredo —
//     `2001::/32`, where the client IPv4 is stored BITWISE INVERTED in the last 32
//     bits, so `2001::200:0:ff00:fffe` is 127.0.0.1 without ever containing `7f00:1`.
// Decoding is ADDITIVE: every rule that refused an address before this pass still
// refuses it, including the blanket `64:ff9b::` and `::` prefixes, which are wider
// than /96 and therefore also refuse some PUBLIC addresses. Erring wide is the
// point; narrowing a working fetch tool is not what a security fix should do.
//
// DECIDED AGAINST, so the next reader does not "fix" an omission: prefixes whose
// text LOOKS like it carries an IPv4 but whose specification puts none at that bit
// position. The ORCHID family is defined away — RFC 4843 §2 builds the address by
// prepending "the 28-bit ORCHID prefix" to a 100-bit cryptographic hash, and the
// registered prefixes are `2001:20::/28` (RFC 7194) and ORCHIDv2 `2001:30::/28`
// (RFC 7360) — so `2001:10::7f00:1` "decoding" to 127.0.0.1 is a low-32-bit guess,
// not a documented embedding, and the same holds for the 6VTEL `2620::/27` forms
// (`2620::7f00:1`, `2620:1000:7f00:1::`). Measured (`Temp/t1-webfetch/probe14.ts`):
// those texts DO reach the network, so the class is real; what is missing is a cited
// bit position, and a block without one is a speculative refusal. For 6VTEL that is a
// MISSING-CITATION caveat rather than a disproof — RFC 3964, the document that discusses
// embedded-address refusal, is 6to4's security analysis and does not mention `2620`.
// An IPv6 zone id (`fe80::1%25eth0`) needs no rule at all: `new URL()` refuses that host
// text, so it never reaches the gate (measured).
//
// Still NOT caught, and no decode can catch it: a DNS name whose A/AAAA record is
// private (the `.nip.io` shape, measured above) while no resolver is wired, and any
// address reached through a public anycast/Teredo relay whose tunnel endpoint is
// private but whose address text is public. Both are stated in the description.
const PRIVATE_IPV4 = /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.0\.|192\.168\.|198\.1[89]\.|0\.)/;
const PRIVATE_IPV6 = /^(?:(?:fe80|fc|fd)[0-9a-f:]*|::1?|::ffff:(?:7f00:1|0?0?0?0?0?1)(?::0)?|64:ff9b::)/i;

// CGNAT (RFC 6598) is `100.64.0.0/10`, and a /10 is the SECOND octet 64-127 — not the /16 a
// `startsWith('100.64.')` prefix test sees. `100.127.255.255` is therefore inside the block
// and used to be answered public; so was every CGNAT address whose second octet was not `64`.
// It is its own regular expression rather than an arm of `PRIVATE_IPV4` above: the /10
// arithmetic (`6[4-9]|[7-9]\d|1[01]\d|12[0-7]`) is unreadable inline in that prefix list, and
// ../webdownload/download.tool.ts RESTATES this predicate character-for-character, so one
// named constant per range is what keeps the two copies comparable line by line.
const PRIVATE_IPV4_CGNAT = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

// The one IPv4 predicate the whole gate shares, so a decoded address is refused by exactly the
// rule its dotted-quad twin is refused by. EVERY IPv4 verdict comes through here — the dotted
// quads, the `inet_aton` decodes, the embedded-address decode, and the raw `::ffff:<dotted>`
// text shortcut in `isPrivateHost` — which is what makes a mapped spelling answer the same as
// its dotted twin. Widening a range means widening ONE predicate; an earlier pass carried
// CGNAT as a `100.64.` prefix here while the text shortcut tested `PRIVATE_IPV4` alone, so
// `100.64.0.1` was refused and `::ffff:100.64.0.1` was not.
const privateIPv4 = (address: string): boolean =>
    PRIVATE_IPV4.test(address) || PRIVATE_IPV4_CGNAT.test(address);

// ---------------------------------------------------------------------------
// Address-form decoding for the SSRF gate (no DNS, no dependencies)
// ---------------------------------------------------------------------------
//
// Everything below is pure text handling, and every helper answers a question the
// gate already asked — it only asks it about forms the old regular expressions
// could not see. A helper that is unsure returns `undefined`, and `isPrivateHost`
// then falls back to the verdict the regular expressions give, so an unexpected
// address string can never turn a public page into a refusal by failing to parse.

// One number in the grammar `inet_aton` accepts and the WHATWG URL host parser
// copies: decimal, `0x`-prefixed hex, or a leading-`0` octal. Length-capped before
// `parseInt` so a 20-digit label cannot quietly round into a valid byte.
const ipv4Number = (label: string): number | undefined => {
    if (label.length === 0) return undefined;

    const hex = /^0x([0-9a-f]{1,8})$/.exec(label);

    if (hex !== null) return Number.parseInt(hex[1], 16);

    // `0` on its own is decimal zero, not octal; `08`/`09` are not numbers at all in
    // this grammar (a stack that cannot parse them treats the host as a name).
    if (label.length > 1 && label.startsWith('0')) {
        if (!/^0[0-7]{1,11}$/.test(label)) return undefined;

        return Number.parseInt(label.slice(1), 8);
    }

    if (!/^\d{1,10}$/.test(label)) return undefined;

    return Number.parseInt(label, 10);
};

// A host written as 1-4 `inet_aton` numbers — where the LAST number holds the
// remaining bytes, which is what makes `127.1` and a bare `2130706433` addresses
// rather than names — as a dotted quad. `undefined` means "not that shape", which is
// the answer for every ordinary hostname: a single non-numeric label (`example`)
// stops the decode.
const atonToIPv4 = (host: string): string | undefined => {
    // A trailing dot is the root label, not a part: `127.0.0.1.` is the same host.
    const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
    if (labels.length > 4) return undefined;

    const numbers: number[] = [];

    for (const label of labels) {
        const value = ipv4Number(label);
        if (value === undefined) return undefined;
        numbers.push(value);
    }

    // The leading parts are single bytes; the last one is 1-4 bytes wide and may not
    // overflow them (`4294967296` is not an address, `4294967295` is 255.255.255.255).
    const width = 5 - numbers.length;
    const last = numbers[numbers.length - 1] ?? 0;

    if (last >= 256 ** width) return undefined;
    if (numbers.slice(0, -1).some((value) => value > 255)) return undefined;

    const bytes = numbers.slice(0, -1);

    // The last number's bytes come out most-significant first, so `shift` steps from
    // (width-1)*8 down to 0 and the loop runs exactly `width` times (bytes.length
    // reaches 4 on the shift-0 step). `shift` counts BITS: 2**24 is the 16,777,216 that
    // extracts the leading 127 of `2130706433`. Writing `256 ** shift` here reads like
    // the same thing and is not — it floors every byte but the last to zero, turning the
    // PUBLIC decimal `134744072` (8.8.8.8) into `0.0.0.8` and refusing a public page.
    for (let shift = (width - 1) * 8; bytes.length < 4; shift -= 8) {
        bytes.push(Math.floor(last / 2 ** shift) % 256);
    }

    return bytes.join('.');
};

// The eight 16-bit groups of an IPv6 text form: one `::` run, 1-4 hex digits per
// group, and the IPv4 tail (dotted, or in the `inet_aton` notations) that the address
// grammar allows in place of the last two groups. `undefined` = not IPv6 text.
const ipv6Groups = (host: string): number[] | undefined => {
    const halves = host.split('::');
    if (halves.length > 2) return undefined;

    const readHalf = (text: string, allowIPv4Tail: boolean): number[] | undefined => {
        if (text.length === 0) return [];

        const labels = text.split(':');
        const groups: number[] = [];

        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index];
            const isEnd = index === labels.length - 1;

            if (isEnd && allowIPv4Tail && label.includes('.')) {
                const embedded = atonToIPv4(label);
                if (embedded === undefined) return undefined;

                const bytes = embedded.split('.').map(Number);
                groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
            } else if (/^[0-9a-f]{1,4}$/.test(label)) {
                groups.push(Number.parseInt(label, 16));
            } else return undefined;
        }

        return groups;
    };

    // An IPv4 tail is only an IPv4 tail at the very END of the address.
    const head = readHalf(halves[0], halves.length === 2 ? halves[1].length === 0 : true);

    if (head === undefined) return undefined;

    let groups = head;

    if (halves.length === 2) {
        const tail = readHalf(halves[1], true);
        if (tail === undefined) return undefined;

        // `::` stands for at least one zero group; accepting the 8-group slop keeps a
        // legal-looking text from escaping the decode entirely.
        if (head.length + tail.length > 8) return undefined;

        groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
    } else if (groups.length !== 8) return undefined;

    return groups;
};

// The IPv4 addresses an IPv6 address carries inside it, as dotted quads. Each form
// contributes the embedding its own specification defines, plus the one a sloppy
// writer may mean, because the question this answers is "could this address end up at
// a private host?" and a refusal costs a fetch while a miss costs an internal read.
//   - IPv4-mapped `::ffff:a.b.c.d` (RFC 4291 §2.5.5.2) and IPv4-compatible
//     `::a.b.c.d` (the deprecated §2.5.5.1): the embedded address, as written;
//   - IPv4-translated `64:ff9b::a.b.c.d` (RFC 6052 §2.1, well-known /96): likewise;
//   - 6to4 `2002:VVVV:VVVV::` (RFC 3056 §5.1): the tunnel's IPv4 in bits 16-47, as
//     written — the destination a fetch to that address is encapsulated toward;
//   - Teredo `2001::/32` (RFC 4380 §5.1): the CLIENT IPv4 sits in the low 32 bits
//     bitwise inverted (`ff00:fffe` = 127.0.0.1) and the relay's IPv4 in the 32 bits
//     above it, also inverted; the non-inverted low half is checked too, because a
//     compatibility-mode writer puts the embedded address there plain.
const embeddedIPv4 = (groups: number[]): string[] => {
    const dotted = (high: number, low: number, invert: boolean): string => {
        const bytes = [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];

        return (invert ? bytes.map((byte) => 255 - byte) : bytes).join('.');
    };

    const zeros = (start: number, end: number): boolean =>
        groups.slice(start, end).every((group) => group === 0);

    if (groups[5] === 0xffff && zeros(0, 5)) return [dotted(groups[6], groups[7], false)];
    if (zeros(0, 6)) return [dotted(groups[6], groups[7], false)];
    // The well-known /96: the 64 groups come first, then SIX zero groups before the
    // embedded address — a prefix test on the whole string cannot see that when the
    // text is written out longhand (`64:ff9b:0:0:0:0:7f00:1`).
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && zeros(2, 6))
        return [dotted(groups[6], groups[7], false)];
    // 6to4 `2002:VVVV:VVVV::` (RFC 3056 §5.1, RFC 4291 §2.5.7): the tunnel's IPv4 sits
    // in bits 16-47 — the SECOND and THIRD groups — and is written as-is, not inverted.
    // Unlike the other forms this one is not merely an encoding of an IPv4 host: a
    // packet to `2002:7f00:1::` is ENCAPSULATED and delivered to 127.0.0.1, so the
    // embedded address is the destination a fetch actually reaches. RFC 3964 §3.1/§3.2
    // (6to4's own security analysis) tells a 6to4 router and a 6to4 relay to "disallow
    // traffic that has private, broadcast or certain specific reserved IPv4 addresses
    // in tunnels, or the matching 6to4 prefixes" — this branch is that check, applied
    // to a text form the platform parser accepts and hands us verbatim.
    if (groups[0] === 0x2002) return [dotted(groups[1], groups[2], false)];
    if (groups[0] === 0x2001 && groups[1] === 0x0000)
        return [
            dotted(groups[6], groups[7], false),
            dotted(groups[6], groups[7], true),
            dotted(groups[2], groups[3], true),
        ];

    return [];
};

export const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');

    if (host.length === 0) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    // IPv4 literal (including the dotted form a browser accepts).
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return privateIPv4(host);

    // The same address in the other notations a stack accepts. This runs AFTER the
    // dotted-quad test above so that check keeps exactly its old behaviour, and it
    // only ever ADDS a refusal: an address that decodes to a public quad still falls
    // through to `false`.
    const shorthand = atonToIPv4(host);

    if (shorthand !== undefined) return privateIPv4(shorthand);

    // IPv6 literal: anything with a colon. Also covers the mapped IPv4 forms.
    if (host.includes(':')) {
        // The dotted-tail mapped text is the ONE branch that already holds a dotted quad, so
        // it goes through `privateIPv4` rather than testing `PRIVATE_IPV4` directly: routed
        // that way, `::ffff:100.64.0.1` gets the CGNAT refusal its twin `100.64.0.1` has always
        // gotten, and `::ffff:8.8.8.8` stays public for the same reason its twin does. Testing
        // the prefix table alone here was the divergence — a mapped spelling of a range only
        // `privateIPv4` knew about answered "public".
        const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
        if (mapped !== null) return privateIPv4(mapped[1]);

        // The blanket rules first, unchanged — they refuse the whole `::` and
        // `64:ff9b::` families, which is wider than those prefixes but was the
        // behaviour before this pass and errs on the safe side.
        if (PRIVATE_IPV6.test(host)) return true;

        // Then the decode, for the text forms those prefixes miss: an uncompressed
        // mapped/translated address, and Teredo's inverted client address.
        const groups = ipv6Groups(host);

        if (groups !== undefined) {
            for (const address of embeddedIPv4(groups)) {
                if (privateIPv4(address)) return true;
            }
        }

        return false;
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
//
// WHAT "OPTIONAL" MEANS EXACTLY (F16, honesty only — no behaviour change):
// `resolve === undefined` returns `{ blocked: false }` as the FIRST statement of
// `resolvePublicHost`, so with no resolver wired the second gate does not run at
// all — a private A record is not "checked and passed", it is never checked. That
// is the state of every `dns: { off: true }` construction (the whole offline
// suite), of `dns.lookup` failing, and of a runtime where the lazy
// `node:dns/promises` import in ./index throws. In all of them a public name whose
// A record is 127.0.0.1 or 169.254.169.254 still reaches the network, and neither
// the tool description nor these comments may promise more than that.
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
    // Any ADDRESS form is an address, in whichever notation it was written: the
    // dotted quad, an IPv6 text form, or an `inet_aton` shorthand. Querying DNS for
    // `134744072` would ask for a name that is not a name, and the answer would not
    // change the verdict — `isPrivateHost` above already decoded it.
    if (
        hostname.includes(':') ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
        atonToIPv4(hostname) !== undefined
    )
        return { blocked: false };

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
//
// `failure` takes the caught error so a reset that lands MID-BODY is reported as
// the same transport class as one that lands on the request (issue 0015): the
// host was reached, so the caller's answer is "a retry may help", not the generic
// sentence. The size error stays its own class — the `HarnessError` passthrough
// below is what keeps it that way.
//
// The return type is `unknown`, not `HarnessError`, because of F10: when the
// CALLER aborted, `failure` hands back the caller's own abort reason rather than a
// sentence of this tool's, and rewriting a cancellation into a tool error is what
// makes the harness report `failed` where `cancelled` is the truth. Everything it
// produces besides that reason is still a HarnessError.
const readBody = async (
    response: Response,
    failure: (error?: unknown) => unknown,
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
        } catch (error) {
            throw failure(error);
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

        // A stream error is a transport failure: hand the error over so its code
        // picks the right sentence (issue 0015).
        throw failure(error);
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
// `callerSignal` (F10) is the harness's PER-CALL AbortSignal (`ToolContext.signal`,
// types/index.ts:3381, whose own doc says a tool SHOULD observe it). It is
// OPTIONAL because `requestPage` is also called directly by tests and by any host
// that imports this module outside a run; absent means "timeout only", exactly as
// before. It is LINKED into the tool's own controller rather than passed to fetch
// directly, so the one signal the request carries still discriminates our timeout
// (see `aborted` below) and the caller's cancellation still cancels the transfer
// rather than only its delivery — the same shape download.tool.ts:637-667 uses.
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
    resolve?: DnsLookup,
    // Optional caller signal (F10, see the note above).
    callerSignal?: AbortSignal
): Promise<PageFetch> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // `aborted` is the only way to tell our timeout from a network refusal,
    // since fetch rejects with an AbortError for both. Beyond that one
    // discriminator the CAUSE CLASS is reported (issue 0015): a name that does
    // not resolve, a host that drops the connection, and a failed TLS handshake
    // are three situations with opposite remedies, and the class — never the
    // Node error text — is what a caller needs in order to pick one.
    //
    // The caller's cancellation outranks BOTH discriminators (F10, mirroring
    // download.tool.ts:658-667): a signal abort lands as an AbortError, and
    // reporting it as "fetch timed out after 15000 ms." would be a lie about
    // what happened. Its reason is rethrown untouched so the harness still
    // classifies the outcome as cancelled whichever phase the abort landed in.
    const abortedReasonOf = (error?: unknown): unknown =>
        callerSignal?.aborted === true ? callerSignal.reason ?? error : undefined;

    const networkFailure = (error?: unknown): unknown => {
        const aborted = abortedReasonOf(error);
        if (aborted !== undefined) return aborted;

        return controller.signal.aborted
            ? new HarnessError(`fetch timed out after ${FETCH_TIMEOUT_MS} ms.`)
            : new HarnessError(TRANSPORT_FAILURE_MESSAGES[transportCause(error)]);
    };

    // Linked, not passed through: `forwardAbort` folds the caller's cancellation
    // into the controller the request already carries, and `once` means the
    // listener cannot outlive the one abort it was registered for. An already-
    // aborted signal is handled synchronously, so a call that arrives cancelled
    // never opens a connection at all.
    const forwardAbort = (): void => controller.abort(callerSignal?.reason);

    if (callerSignal !== undefined) {
        if (callerSignal.aborted) forwardAbort();
        else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }

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
        } catch (error) {
            // The caught error is passed on, not discarded (issue 0015): its
            // `cause.code` is the only thing that can tell a name that does not
            // resolve from a refused port, and the catch used to throw it away.
            throw networkFailure(error);
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
