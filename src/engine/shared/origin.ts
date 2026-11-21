// Shared origin policy for the harness HTTP boundary.
//
// One definition, several callers that must not drift:
//   - server/service.ts — decides which browser `Origin` may call the service
//     mount at all (the service loader's CORS is permissive, so this is the
//     boundary);
//   - src/frontend/api.ts — decides which ABSOLUTE API root a runtime source
//     (?apiRoot= or an injected __HARNESS_CONFIG__/meta value) may use. The UI
//     posts the saved provider key to that root, so an arbitrary origin there
//     would be a credential-exfiltration path;
//   - both of those plus src/frontend/deployment.ts — decide whether a host is a
//     GitHub Pages host, i.e. the static deployment of this UI with no API of its
//     own (see ./isPagesHostname).
//
// Loopback is matched by URL.hostname, never by string prefix: values such as
// "http://127.0.0.1.evil.test" or "http://localhost.attacker.test" must not
// pass. `URL.hostname` keeps IPv6 brackets, hence '[::1]'; the bare '::1' form
// is accepted defensively. This module is transport-free (no node: imports) so
// the frontend bundle can include it without pulling server dependencies.
//
// Cross-references:
//   - ./service.ts — inbound Origin gate (same host as the request, loopback, or
//     this package's GitHub Pages UI)
//   - ../src/frontend/api.ts — outbound API-root gate for runtime overrides
//   - ../src/frontend/deployment.ts — the local/LAN chain a Pages page dials

export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1'
]);

// True for a hostname that denotes this machine. The caller already parsed the
// URL; this only compares the normalized hostname.
export const isLoopbackHostname = (hostname: string): boolean =>
    LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

// True when `candidate` (an absolute http(s) URL) is the SAME origin as
// `pageOrigin` or a loopback host.
//
// `pageOrigin` is the page's `location.origin`, i.e. scheme + host + port. A
// missing or opaque origin (file://, a sandboxed iframe, a test without a
// location) cannot prove same-origin, so only loopback passes in that case.
// Throwing on a malformed candidate is deliberately avoided: callers treat
// "not trusted" and "unparseable" the same way.
export const isTrustedRuntimeOrigin = (candidate: string, pageOrigin: string | undefined): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(candidate);
    } catch {
        return false;
    }

    // Only web origins can be a harness API root; a scheme such as data: or
    // file: has no meaningful origin and must never be trusted.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    if (pageOrigin !== undefined && pageOrigin.length > 0 && parsed.origin === pageOrigin) return true;

    return isLoopbackHostname(parsed.hostname);
};

// A GitHub Pages host (`https://<user>.github.io/<repo>/`) is the static
// deployment target of this package's UI (`.github/workflows/ci.yml` publishes
// `src/frontend/dist` there). Two consumers must agree on what that host is:
//   - src/frontend/api.ts — a Pages-hosted page has NO API on its own origin, so
//     the client dials the compiled local/LAN service chain instead of the
//     origin-relative `/api` fallback, which 404s on github.io;
//   - src/server/service.ts — that same page must be allowed to call the service
//     cross-origin, or the deployed UI only ever sees a 403.
// The `github.io` zone is operated by GitHub, so a `*.github.io` origin is a
// known static host — a user cannot register `github.io.attacker.test` the way
// they can register `localhost.attacker.test`.
export const PAGES_HOST_SUFFIX = 'github.io';

// Hostname test, anchored on a label boundary: every `<user>.github.io` subdomain
// passes, while `github.io.attacker.test` does not. The apex `github.io` is not a
// Pages site (it is GitHub's own host), so it is deliberately excluded.
export const isPagesHostname = (hostname: string): boolean =>
    hostname.toLowerCase().endsWith(`.${PAGES_HOST_SUFFIX}`);

// True for an https GitHub Pages ORIGIN. HTTPS is required: Pages serves the
// deployed UI over https only, so an `http://<user>.github.io` Origin is a
// redirect artifact or a spoofed header, and the service gate must not widen for
// it. The frontend's own page test is the hostname form above — a page cannot
// spoof its own hostname, and the chain it dials is compiled into the bundle,
// not derived from the scheme.
export const isPagesOrigin = (origin: string | undefined): boolean => {
    if (origin === undefined || origin.length === 0) return false;

    let parsed: URL;

    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }

    return parsed.protocol === 'https:' && isPagesHostname(parsed.hostname);
};
