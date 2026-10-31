// Node capability must not be inferred from missing editable roots. The compiler
// remains explicitly supported (supportsToolCompilation=true); a missing source
// tree therefore fails startup with the compiler diagnostic instead of silently
// falling back to prepared definitions.
import { describe, expect, it, vi } from 'vitest';
import { agent, harness } from '@underload/harness';

vi.mock('./core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./core')>();

    return {
        ...actual,
        supportsToolCompilation: true,
        TOOL_SOURCE_ROOTS: [] as readonly string[],
        TOOL_SOURCE_PACKAGE_ROOT: '',
        prepareToolCandidate: () => {
            throw new Error(
                'Tool source import "runtime-tools/toolRegistry.tool.ts" could not be resolved.'
            );
        }
    };
});

const idle = () =>
    agent({
        model: 'test/model',
        stream: async function* () {
            return;
        }
    });

describe('Node missing source roots', () => {
    it('fails startup compilation instead of falling back to prepared definitions', () => {
        expect(() => harness({ agents: { writer: idle() } })).toThrow(
            /could not be resolved/
        );
    });
});
