// Shared origin policy: the loopback list and the runtime API-root trust rule.
//
// Both the service's inbound Origin gate and the frontend's outbound API-root
// gate consume this module, so these cases pin the semantics for both:
// - loopback is a HOSTNAME match, never a string prefix;
// - same-origin is scheme + host + port, not just a shared hostname;
// - only http(s) is a usable web origin.

import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, isTrustedRuntimeOrigin, LOOPBACK_HOSTNAMES } from '../shared/origin';

describe('isLoopbackHostname', () => {
    it('accepts the documented loopback spellings', () => {
        expect([...LOOPBACK_HOSTNAMES]).toEqual(['localhost', '127.0.0.1', '[::1]', '::1']);

        expect(isLoopbackHostname('localhost')).toBe(true);
        expect(isLoopbackHostname('LOCALHOST')).toBe(true);
        expect(isLoopbackHostname('127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('[::1]')).toBe(true);
        expect(isLoopbackHostname('::1')).toBe(true);
    });

    it('rejects lookalike hosts and other private addresses', () => {
        // A prefix test would wrongly accept these; hostname equality does not.
        expect(isLoopbackHostname('127.0.0.1.evil.test')).toBe(false);
        expect(isLoopbackHostname('localhost.attacker.test')).toBe(false);
        expect(isLoopbackHostname('192.168.1.20')).toBe(false);
        expect(isLoopbackHostname('0.0.0.0')).toBe(false);
        expect(isLoopbackHostname('')).toBe(false);
    });
});

describe('isTrustedRuntimeOrigin', () => {
    it('accepts the exact page origin', () => {
        expect(isTrustedRuntimeOrigin('https://ui.example/v1/harness', 'https://ui.example')).toBe(true);
        expect(isTrustedRuntimeOrigin('http://127.0.0.1:5180/v1', 'http://127.0.0.1:5180')).toBe(true);
    });

    it('rejects a different scheme or port on the same hostname', () => {
        // Same host is not same origin: an https page must not downgrade to http,
        // and a port difference is a different origin.
        expect(isTrustedRuntimeOrigin('http://ui.example/v1', 'https://ui.example')).toBe(false);
        expect(isTrustedRuntimeOrigin('https://ui.example:8443/v1', 'https://ui.example')).toBe(false);
    });

    it('accepts loopback regardless of the page origin', () => {
        expect(isTrustedRuntimeOrigin('http://localhost:5000/v1/harness', 'https://ui.example')).toBe(true);
        expect(isTrustedRuntimeOrigin('http://127.0.0.1:5000/v1/harness', undefined)).toBe(true);
        expect(isTrustedRuntimeOrigin('https://[::1]:5000/v1/harness', undefined)).toBe(true);
    });

    it('rejects public origins, lookalikes, and non-web schemes', () => {
        expect(isTrustedRuntimeOrigin('https://evil.example/api', 'https://ui.example')).toBe(false);
        expect(isTrustedRuntimeOrigin('https://localhost.attacker.test/api', 'https://ui.example')).toBe(false);
        expect(isTrustedRuntimeOrigin('https://127.0.0.1.evil.test/api', 'https://ui.example')).toBe(false);
        expect(isTrustedRuntimeOrigin('ftp://127.0.0.1/api', undefined)).toBe(false);
        expect(isTrustedRuntimeOrigin('javascript:alert(1)', undefined)).toBe(false);
        expect(isTrustedRuntimeOrigin('not a url', undefined)).toBe(false);
    });

    it('cannot prove same-origin without a page origin', () => {
        // file:// or a sandboxed/opaque page: only loopback is trustworthy.
        expect(isTrustedRuntimeOrigin('https://ui.example/v1', undefined)).toBe(false);
        expect(isTrustedRuntimeOrigin('https://ui.example/v1', '')).toBe(false);
    });
});
