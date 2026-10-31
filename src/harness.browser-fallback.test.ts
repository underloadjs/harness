// Browser capability boundary — source-level adapter for the aliased browser
// build. The real build aliases core/tool-source to the Node-free stub; this test
// simulates that exact contract (empty source roots + prepare rejects) while the
// rest of the kernel is real, so construction/fallback behavior is testable
// without a build.
import { describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

vi.mock('./core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./core')>();

    return {
        ...actual,
        supportsToolCompilation: false,
        TOOL_SOURCE_ROOTS: [] as readonly string[],
        TOOL_SOURCE_PACKAGE_ROOT: '',
        prepareToolCandidate: () => {
            throw new Error(
                'Tool source compilation is unavailable in the browser build; run the harness on Node to compile or register editable source revisions.'
            );
        }
    };
});

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const scripted = (): HarnessStream =>
    async function* () {
        for (const frame of answer('browser-ok')) yield frame;
    };

describe('browser baseline fallback', () => {
    it('constructs the baseline harness from prepared definitions when source compilation is unavailable', async () => {
        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream: scripted() }) }
        });

        // Harness-owned controls and presets are seedable without compiling.
        expect(writer.tools.toolRegistry).toBeDefined();
        expect(writer.tools.toolRequest.visibility).toBe('core');
        expect(writer.tools.toolList.visibility).toBe('core');
        expect(writer.tools.toolManage.visibility).toBe('core');
        expect(writer.tools.toolCreate.visibility).toBe('core');
        expect(writer.tools.todoManage.visibility).toBe('core');
        expect(writer.tools.fileRead.name).toBe('fileRead');
        expect(writer.tools.fileRead.visibility).toBe('core');
        // No source record is claimed for a prepared-definition fallback.
        expect(writer.toolSource('fileRead')).toBeUndefined();

        // Existing browser harness semantics remain: model turns and discovery
        // metadata are available.
        const result = await writer('go');
        expect(result.content).toBe('browser-ok');
        expect(await writer.executeTool('toolRequest', { tags: ['files'] })).toMatchObject({
            enabled: ['fileList']
        });
    });

    it('keeps runtime source registration explicitly unsupported in this environment', async () => {
        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream: scripted() }) },
            tools: {
                custom: tool({
                    description: 'Configured definition.',
                    tags: ['test'],
                    execute: () => 'configured'
                })
            }
        });

        await expect(writer.executeTool('custom', {})).resolves.toBe('configured');
        await expect(
            writer.registerTool({
                name: 'fromSource',
                moduleText:
                    "export const metadata = { name: 'fromSource', description: 'x', tags: ['x'] }; export const execute = () => 1;"
            })
        ).rejects.toThrow(/unavailable in the browser build/);

        expect(() =>
            harness({
                agents: { writer: agent({ model: 'test/model', stream: scripted() }) },
                toolSources: { fromMap: 'tools/files/fileList.tool.ts' }
            })
        ).toThrow(/unavailable in the browser build/);

        // A folder configuration is an explicit Node capability request; the
        // browser build rejects it rather than silently scanning nothing.
        expect(() =>
            harness({
                agents: { writer: agent({ model: 'test/model', stream: scripted() }) },
                toolFolders: ['/tmp/does-not-matter']
            })
        ).toThrow(/toolFolders require the Node source compiler/);
    });
});
