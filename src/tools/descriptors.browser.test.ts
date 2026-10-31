// T24 browser boundary: without a scanner, the catalogue is the GENERATED manifest
// and nothing else. A browser cannot read `tools/**/*.tool.ts` or parse TypeScript,
// so the live-scan path must be unreachable there and the generated rows must be
// served verbatim (as detached copies).
//
// T27: this is also the ONE place `loadPresetTool` still resolves a body through the
// generated `import()`, because the rows and the chunk come from the same build
// artifact. The loader is counted (not replaced) so that is asserted, not assumed.
//
// The capability flags are mocked so both branches run on Node, where the real
// filesystem/compiler exist. `tool-manifest` stays REAL apart from the counter: the
// assertions are against the shipped data, which is the only inventory a browser has.
import { describe, expect, it, vi } from 'vitest';

// Every generated-loader label this process resolves, in call order.
const generatedLoads = vi.hoisted(() => [] as string[]);

// No scanner: `../core/tool-scan` reports the browser capability boundary.
vi.mock('../core/tool-scan', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/tool-scan')>();

    return { ...actual, supportsToolScan: false };
});

// No source compiler either (the aliased browser stub). A live-only entry could not
// be loaded here, so the catalogue must never invent one.
vi.mock('../core/tool-source', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/tool-source')>();

    return { ...actual, supportsToolCompilation: false };
});

// Count generated resolutions while keeping the real data and loader behaviour.
vi.mock('../core/tool-manifest', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/tool-manifest')>();

    return {
        ...actual,
        loadDiscoveredTool: (label: string) => {
            generatedLoads.push(label);
            return actual.loadDiscoveredTool(label);
        }
    };
});

const { BUILTIN_TOOL_DESCRIPTORS } = await import('../core/tool-manifest');
const { PRESET_DESCRIPTORS, RUNTIME_DESCRIPTORS, TOOL_DESCRIPTORS, loadPresetTool } = await import(
    './descriptors'
);
const { PRESET_TOOL_NAMES } = await import('./catalogue');
const { presetTools } = await import('./index');

describe('browser catalogue fallback (T24)', () => {
    it('serves exactly the generated rows, in generated order', () => {
        expect(TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(
            BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)
        );
        // Field for field: no live row may sneak in, and no generated row may be
        // rewritten by the projection.
        expect(TOOL_DESCRIPTORS).toEqual([...BUILTIN_TOOL_DESCRIPTORS]);
        expect(TOOL_DESCRIPTORS).toHaveLength(27);
    });

    it('derives the preset and runtime groups from the generated data', () => {
        expect(PRESET_TOOL_NAMES).toEqual([
            'syntaxCheck',
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileList',
            'fileGlob',
            'commandRun',
            'gitDiff'
        ]);
        expect(PRESET_DESCRIPTORS).toEqual(
            BUILTIN_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.group === 'preset')
        );
        expect(Object.keys(presetTools)).toEqual(PRESET_TOOL_NAMES);

        // The runtime projection keeps its own documented rule (listed !== false,
        // activation ordering) over the generated rows.
        expect(RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'agentDelegate',
            'actionRequest',
            'threadFork'
        ]);
    });

    it('hands out detached copies of the generated rows', () => {
        expect(TOOL_DESCRIPTORS[0]).not.toBe(BUILTIN_TOOL_DESCRIPTORS[0]);
        expect(TOOL_DESCRIPTORS[0].metadata).not.toBe(BUILTIN_TOOL_DESCRIPTORS[0].metadata);
        expect(TOOL_DESCRIPTORS[0].metadata.tags).not.toBe(
            BUILTIN_TOOL_DESCRIPTORS[0].metadata.tags
        );

        TOOL_DESCRIPTORS[0].metadata.tags.push('mutated');
        expect(BUILTIN_TOOL_DESCRIPTORS[0].metadata.tags).not.toContain('mutated');
    });

    // T27: the generated loader is used ONLY where the rows themselves are generated.
    // This is the one place the two halves of a row provably come from the same build
    // artifact, so it must stay reachable here even though Node never uses it.
    it('loads a known preset through the generated loader in a generated catalogue', async () => {
        const loaded = await loadPresetTool('syntaxCheck');

        // The row and the body are both the generated artifact: name/description come
        // from the generated descriptor, the callable from the generated import().
        expect(loaded.name).toBe('syntaxCheck');
        expect(loaded.description).toBe(
            BUILTIN_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === 'syntaxCheck')!
                .metadata.description
        );
        expect(typeof loaded.execute).toBe('function');
        expect(generatedLoads).toEqual(['tools/syntax/syntaxCheck.tool.ts']);
    });
});
