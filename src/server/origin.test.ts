// Shared origin policy: the loopback list, the GitHub Pages host rule, and the
// runtime API-root trust rule.
//
// The service's inbound Origin gate, the frontend's outbound API-root gate, and
// the frontend's static-host detection all consume this module, so these cases pin
// the semantics for all three:
// - loopback is a HOSTNAME match, never a string prefix;
// - a Pages host is a `*.github.io` SUBDOMAIN over https, never a lookalike;
// - same-origin is scheme + host + port, not just a shared hostname;
// - only http(s) is a usable web origin.

import { describe, expect, it } from 'vitest';
import {
    isLoopbackHostname,
    isPagesHostname,
    isPagesOrigin,
    isTrustedRuntimeOrigin,
    LOOPBACK_HOSTNAMES,
    PAGES_HOST_SUFFIX
} from '../shared/origin';

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

describe('isPagesHostname', () => {
    it('accepts every Pages subdomain of the zone it publishes to', () => {
        expect(PAGES_HOST_SUFFIX).toBe('github.io');

        // The deployment target of this package's UI (ci.yml).
        expect(isPagesHostname('underloadjs.github.io')).toBe(true);
        expect(isPagesHostname('UNDERLOADJS.GITHUB.IO')).toBe(true);
        expect(isPagesHostname('any-user.github.io')).toBe(true);
    });

    it('rejects the apex, lookalikes, and every other host', () => {
        // The apex is GitHub's own host, not a Pages site.
        expect(isPagesHostname('github.io')).toBe(false);
        // A prefix/suffix test without a label boundary would accept these.
        expect(isPagesHostname('github.io.attacker.test')).toBe(false);
        expect(isPagesHostname('underloadjs.github.io.attacker.test')).toBe(false);
        expect(isPagesHostname('mygithub.io')).toBe(false);
        expect(isPagesHostname('localhost')).toBe(false);
        expect(isPagesHostname('192.168.50.109')).toBe(false);
        expect(isPagesHostname('')).toBe(false);
    });
});

describe('isPagesOrigin', () => {
    it('accepts an https Pages origin whatever path the UI is served under', () => {
        expect(isPagesOrigin('https://underloadjs.github.io')).toBe(true);
        expect(isPagesOrigin('https://underloadjs.github.io/harness/')).toBe(true);
    });

    it('rejects an http Pages origin', () => {
        // Pages serves the deployed UI over https only, so an http Pages Origin is
        // a redirect artifact or a spoofed header, and the gate must not widen for it.
        expect(isPagesOrigin('http://underloadjs.github.io')).toBe(false);
    });

    it('rejects a missing, opaque, malformed, or foreign origin', () => {
        expect(isPagesOrigin(undefined)).toBe(false);
        expect(isPagesOrigin('')).toBe(false);
        expect(isPagesOrigin('null')).toBe(false);
        expect(isPagesOrigin('https://evil.example')).toBe(false);
        expect(isPagesOrigin('https://localhost:5180')).toBe(false);
    });
});
