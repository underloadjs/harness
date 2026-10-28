// Shared origin policy for the harness HTTP boundary.
//
// One definition, two callers that must not drift:
//   - server/service.ts — decides which browser `Origin` may call the service
//     mount at all (the service loader's CORS is permissive, so this is the
//     boundary);
//   - playground/src/api.ts — decides which ABSOLUTE API root a runtime source
//     (?apiRoot= or an injected __HARNESS_CONFIG__/meta value) may use. The UI
//     posts the saved provider key to that root, so an arbitrary origin there
//     would be a credential-exfiltration path.
//
// Loopback is matched by URL.hostname, never by string prefix: values such as
// "http://127.0.0.1.evil.test" or "http://localhost.attacker.test" must not
// pass. `URL.hostname` keeps IPv6 brackets, hence '[::1]'; the bare '::1' form
// is accepted defensively. This module is transport-free (no node: imports) so
// the playground bundle can include it without pulling server dependencies.
//
// Cross-references:
//   - ./service.ts — inbound Origin gate (same host as the request, or loopback)
//   - ../playground/src/api.ts — outbound API-root gate for runtime overrides

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
