// T24: the ONE sanctioned fallback of the live Node catalogue.
//
// `./descriptors` scans the package tools tree at module (process) initialisation.
// Two very different failures are possible there, and they must not be treated the
// same way:
//
//   1. the tools ROOT is not reachable (a dist-only deployment, a relocated bundle)
//      → fall back to the GENERATED manifest, so importing the library still works;
//   2. an entry is INVALID (bad literal, unreadable metadata, bad registration)
//      → RETHROW. `harness({})` scans the same tree and fails on construction, so
//        publishing stale manifest rows here would recreate the exact
//        catalogue/harness disagreement T24 fixed.
//
// Both branches are pinned here by mocking `../core/tool-scan`'s scan function; the
// generated manifest itself stays real, so the fallback rows are the shipped data.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Which failure the mocked scanner throws on the next call.
const scanState = vi.hoisted(() => ({ failure: 'missing-root' as 'missing-root' | 'invalid-entry' }));

// The real error type: `descriptors` classifies the MESSAGE, so the class must be
// the package's own (a bare Error would work too, but this keeps the fixture honest).
const { HarnessError } = await import('../util');

vi.mock('../core/tool-scan', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/tool-scan')>();

    return {
        ...actual,
        scanToolMetadata: () => {
            if (scanState.failure === 'missing-root') {
                throw new HarnessError(
                    'Tool discovery could not locate the @underload/harness package root. Construct the harness on Node with the package source tree installed, or use the generated manifest.'
                );
            }

            throw new HarnessError(
                'Tool entry tools/files/fileRead.tool.ts metadata.tags must be a non-empty string array.'
            );
        }
    };
});

const { BUILTIN_TOOL_DESCRIPTORS } = await import('../core/tool-manifest');

// Each branch needs a FRESH module instance: the snapshot is taken once, at module
// evaluation, which is the documented process-level contract.
const freshDescriptors = async (failure: 'missing-root' | 'invalid-entry') => {
    scanState.failure = failure;
    vi.resetModules();
    return import('./descriptors');
};

describe('live catalogue scan failures (T24)', () => {
    beforeEach(() => {
        scanState.failure = 'missing-root';
    });

    it('falls back to the generated manifest when the tools root is unavailable', async () => {
        const { TOOL_DESCRIPTORS, PRESET_DESCRIPTORS } = await freshDescriptors('missing-root');

        expect(TOOL_DESCRIPTORS).toEqual([...BUILTIN_TOOL_DESCRIPTORS]);
        expect(TOOL_DESCRIPTORS).toHaveLength(27);
        expect(PRESET_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
            'syntaxCheck',
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileList',
            'fileGlob',
            'commandRun',
            'gitDiff'
        ]);
    });

    it('rethrows an invalid-entry diagnostic instead of publishing stale rows', async () => {
        await expect(freshDescriptors('invalid-entry')).rejects.toThrow(
            'Tool entry tools/files/fileRead.tool.ts metadata.tags must be a non-empty string array.'
        );
    });
});
