// T19 browser fallback contract (R10: preserve the browser/package surface).
//
// The browser build aliases `core/tool-source` to its stub, so
// `supportsToolCompilation` is false there and no filesystem or TypeScript compiler
// exists. Discovery must then answer from the GENERATED manifest (data only) and
// refuse a folder scan with an actionable error instead of pretending it scanned.
//
// This file mocks BOTH capability flags so the two branches are exercised on Node,
// where the real compiler is present. Everything else (`tool-manifest`) is real, so
// the assertions are against the shipped data.

import { describe, expect, it, vi } from 'vitest';

// The browser capability boundary: no source compiler, no scanner.
vi.mock('./tool-source', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./tool-source')>();

    return {
        ...actual,
        supportsToolCompilation: false,
        resolveToolFolders: (): never => {
            throw new Error('browser build must not resolve tool folders');
        },
        discoverToolFolderSources: (): never => {
            throw new Error('browser build must not scan tool folders');
        }
    };
});

vi.mock('./tool-scan', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./tool-scan')>();

    return { ...actual, supportsToolScan: false };
});

const { discoverToolMetadata } = await import('./tool-discovery');
const { BUILTIN_TOOL_DESCRIPTORS } = await import('./tool-manifest');

describe('browser discovery fallback', () => {
    it('returns the generated manifest as data', () => {
        const descriptors = discoverToolMetadata();

        expect(descriptors.map((descriptor) => descriptor.name)).toEqual(
            BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)
        );
        expect(descriptors).toHaveLength(27);
    });

    it('returns detached copies, not the manifest rows themselves', () => {
        const descriptors = discoverToolMetadata();

        expect(descriptors[0]).not.toBe(BUILTIN_TOOL_DESCRIPTORS[0]);
        expect(descriptors[0].metadata).not.toBe(BUILTIN_TOOL_DESCRIPTORS[0].metadata);
        expect(descriptors[0].metadata.tags).not.toBe(BUILTIN_TOOL_DESCRIPTORS[0].metadata.tags);
    });

    it('honours includePresets without touching the filesystem', () => {
        expect(discoverToolMetadata({ includePresets: false })).toHaveLength(19);
    });

    it('rejects a folder request with a clear unsupported error', () => {
        expect(() => discoverToolMetadata({ folders: ['/tmp/does-not-matter'] })).toThrow(
            'discoverToolMetadata cannot scan tool folders in this build: the browser root exposes prebuilt descriptors only. Construct the harness on Node to scan *.tool.ts folders.'
        );
    });
});
