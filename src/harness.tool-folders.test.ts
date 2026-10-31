// External tool folders + toolManage (R1/R2/R3).
//
// Contract pinned here:
//   - `toolFolders` accepts absolute and cwd-relative directories, scans recursively
//     in deterministic order, and later folders win by tool name;
//   - every discovered entry is a self-contained `*.tool.ts` module (metadata +
//     execute) compiled through the normal kernel;
//   - an invalid folder or module fails construction with the failing path;
//   - toolManage create/update persist to configured folders by default; explicit
//     paths are fenced against traversal/symlink escape and a failed registration
//     rolls the file back;
//   - a pathless create writes <name>.tool.ts in the LAST configured root, and a
//     pathless update reuses the owning sourcePath; both survive restart;
//   - `persist: "runtime"` is the explicit no-disk mode;
//   - `reload` re-reads a disk-backed revision through the same kernel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { HarnessStream } from '@underload/harness';

// Repo-root Temp/ keeps every probe out of the OS temp directory (AGENTS.md).
const TEMP_ROOT = fileURLToPath(new URL('../../../../Temp/', import.meta.url));

const moduleText = (name: string, description: string, value: string): string => `// Canonical *.tool.ts example: declarative metadata + execute.
export const metadata = {
    name: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    tags: ['fixture', ${JSON.stringify(name)}],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const execute = () => ${JSON.stringify(value)};
`;

const stream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const writer = () => agent({ model: 'test/model', stream });

const scratch = (): string => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_ROOT, 'harness-tool-folders-'));
};

const write = (file: string, text: string): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return file;
};

const created: string[] = [];

afterEach(() => {
    for (const directory of created.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

const folder = (name: string): string => {
    const directory = path.join(scratch(), name);
    fs.mkdirSync(directory, { recursive: true });
    if (!created.includes(path.dirname(directory))) created.push(path.dirname(directory));
    return directory;
};

describe('toolFolders discovery', () => {
    it('scans recursively, supports cwd-relative folders, and lets later folders win', async () => {
        const one = folder('one');
        const two = folder('two');

        write(path.join(one, 'alpha.tool.ts'), moduleText('alpha', 'alpha from one', 'one'));
        write(path.join(one, 'nested', 'beta.tool.ts'), moduleText('beta', 'beta from one', 'beta'));
        // Not the required extension: ignored even though it is a valid module.
        write(path.join(one, 'ignored.ts'), moduleText('ignored', 'not a folder entry', 'no'));
        // Later folder wins this name.
        write(path.join(two, 'alpha.tool.ts'), moduleText('alpha', 'alpha from two', 'two'));

        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            // One absolute folder and one cwd-relative folder: both are supported.
            toolFolders: [one, path.relative(process.cwd(), two)]
        });

        expect(writerHandle.tools.ignored).toBeUndefined();
        expect(writerHandle.tools.beta.description).toBe('beta from one');
        expect(writerHandle.tools.alpha.description).toBe('alpha from two');
        expect(await writerHandle.executeTool('alpha', {})).toBe('two');
        expect(await writerHandle.executeTool('beta', {})).toBe('beta');

        // The later registration leaves one captured revision: the winning folder.
        expect(writerHandle.toolSource('alpha')?.sourcePath).toBe(
            path.join(two, 'alpha.tool.ts').replace(/\\/g, '/')
        );
        expect(
            writerHandle
                .toolSources()
                .filter((source) => source.sourcePath?.includes('harness-tool-folders-'))
                .map((source) => source.name)
        ).toEqual(['alpha', 'beta']);
    });

    it('fails construction clearly for an invalid folder or module', () => {
        const root = folder('invalid');
        const missing = path.join(root, 'does-not-exist');

        expect(() =>
            harness({
                agents: { writer: writer() },
                presets: false,
                toolFolders: [missing]
            })
        ).toThrow(/toolFolders entry .*does not exist/);

        const broken = folder('broken');
        write(path.join(broken, 'broken.tool.ts'), 'export const metadata = (\n');

        expect(() =>
            harness({
                agents: { writer: writer() },
                presets: false,
                toolFolders: [broken]
            })
        ).toThrow(/Tool folder module .*broken\.tool\.ts.*could not be registered/);
    });
});

describe('toolManage writes and reloads', () => {
    it('creates and updates only explicit paths inside a configured folder', async () => {
        const one = folder('writes-one');
        const two = folder('writes-two');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one, two]
        });

        // A relative path uses the first configured folder by default.
        const createdResult = await writerHandle.executeTool('toolManage', {
            operation: 'create',
            path: 'created.tool.ts',
            moduleText: moduleText('created', 'created v1', 'v1')
        });

        expect(createdResult).toMatchObject({
            name: 'created',
            created: true,
            replaced: false,
            operation: 'create',
            persisted: true,
            path: path.join(one, 'created.tool.ts'),
            folder: one
        });
        expect(fs.existsSync(path.join(one, 'created.tool.ts'))).toBe(true);
        expect(await writerHandle.executeTool('created', {})).toBe('v1');
        expect(writerHandle.toolSource('created')?.sourcePath).toBe(
            path.join(one, 'created.tool.ts').replace(/\\/g, '/')
        );

        // Create never overwrites an existing file.
        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                path: 'created.tool.ts',
                moduleText: moduleText('created', 'created duplicate', 'duplicate')
            })
        ).rejects.toThrow(/already exists; use operation "update"/);

        // Update writes the explicit file and atomically replaces the definition.
        const updated = await writerHandle.executeTool('toolManage', {
            operation: 'update',
            path: 'created.tool.ts',
            moduleText: moduleText('created', 'created v2', 'v2')
        });

        expect(updated).toMatchObject({
            name: 'created',
            created: false,
            replaced: true,
            operation: 'update',
            persisted: true,
            path: path.join(one, 'created.tool.ts'),
            folder: one
        });
        expect(await writerHandle.executeTool('created', {})).toBe('v2');

        // The `folder` argument can target the second configured folder.
        await writerHandle.executeTool('toolManage', {
            operation: 'create',
            folder: two,
            path: 'elsewhere.tool.ts',
            moduleText: moduleText('elsewhere', 'second folder', 'second')
        });
        expect(fs.existsSync(path.join(two, 'elsewhere.tool.ts'))).toBe(true);
        expect(await writerHandle.executeTool('elsewhere', {})).toBe('second');

        // A failed compile rolls the file back: the previous bytes and tool remain.
        const before = fs.readFileSync(path.join(one, 'created.tool.ts'), 'utf8');
        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'update',
                path: 'created.tool.ts',
                moduleText: 'export const metadata = (\n'
            })
        ).rejects.toThrow(/could not be transpiled/);
        expect(fs.readFileSync(path.join(one, 'created.tool.ts'), 'utf8')).toBe(before);
        expect(await writerHandle.executeTool('created', {})).toBe('v2');
    });

    it('persists pathless create in the last root, updates through the owning path, and survives restart', async () => {
        const one = folder('persist-one');
        const two = folder('persist-two');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one, two]
        });

        const created = await writerHandle.executeTool('toolManage', {
            operation: 'create',
            name: 'persisted',
            moduleText: moduleText('persisted', 'persisted v1', 'persisted-v1')
        });

        expect(created).toMatchObject({
            name: 'persisted',
            created: true,
            operation: 'create',
            persisted: true,
            path: path.join(two, 'persisted.tool.ts'),
            folder: two
        });
        expect(fs.existsSync(path.join(two, 'persisted.tool.ts'))).toBe(true);
        expect(fs.existsSync(path.join(one, 'persisted.tool.ts'))).toBe(false);
        expect(await writerHandle.executeTool('persisted', {})).toBe('persisted-v1');

        // No `path`: update resolves the captured owning path (the last root).
        const updated = await writerHandle.executeTool('toolManage', {
            operation: 'update',
            name: 'persisted',
            moduleText: moduleText('persisted', 'persisted v2', 'persisted-v2')
        });
        expect(updated).toMatchObject({
            name: 'persisted',
            replaced: true,
            operation: 'update',
            persisted: true,
            path: path.join(two, 'persisted.tool.ts'),
            folder: two
        });
        expect(await writerHandle.executeTool('persisted', {})).toBe('persisted-v2');

        // Disk-backed mutations are not runtime creations: no snapshot duplicate
        // and no creation-budget record.
        const snapshot = writerHandle.snapshot();
        expect(snapshot.createdTools).toEqual([]);
        expect(snapshot.createdToolCount).toBe(0);

        // details exposes a detached clone of the installed schema.
        const details = (await writerHandle.executeTool('toolManage', {
            operation: 'details',
            name: 'persisted'
        })) as { parameters: Record<string, unknown> };
        expect(details.parameters).toEqual({
            type: 'object',
            properties: {},
            additionalProperties: false
        });

        // `path` for an unowned name reports the deterministic create target
        // without writing or creating the file.
        expect(
            await writerHandle.executeTool('toolManage', {
                operation: 'path',
                name: 'planned'
            })
        ).toEqual({
            folders: [one, two],
            name: 'planned',
            createPath: path.join(two, 'planned.tool.ts').replace(/\\/g, '/')
        });
        expect(fs.existsSync(path.join(two, 'planned.tool.ts'))).toBe(false);

        // Restart: folder discovery is the persistence source.
        const restarted = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one, two]
        });
        expect(await restarted.executeTool('persisted', {})).toBe('persisted-v2');
        expect(restarted.toolSource('persisted')?.sourcePath).toBe(
            path.join(two, 'persisted.tool.ts').replace(/\\/g, '/')
        );
    });

    it('does not spend maxCreatedTools on disk-backed creates', async () => {
        const one = folder('persist-budget');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one],
            maxCreatedTools: 1
        });

        await writerHandle.executeTool('toolManage', {
            operation: 'create',
            name: 'diskTool',
            moduleText: moduleText('diskTool', 'disk tool', 'disk')
        });

        // The disk-backed create consumed no runtime budget, so one real runtime
        // creation still fits, and the second is rejected.
        writerHandle.createTool({
            name: 'runtimeOne',
            description: 'runtime one',
            tags: ['runtime'],
            source: 'return args;'
        });
        expect(writerHandle.tools.runtimeOne).toBeDefined();
        expect(() =>
            writerHandle.createTool({
                name: 'runtimeTwo',
                description: 'runtime two',
                tags: ['runtime'],
                source: 'return args;'
            })
        ).toThrow(/already created 1 tools/);
    });

    it('requires a configured root unless runtime mode is explicit, and rejects ambiguous options', async () => {
        const noFolders = harness({ agents: { writer: writer() }, presets: false });

        await expect(
            noFolders.executeTool('toolManage', {
                operation: 'create',
                name: 'noRoot',
                moduleText: moduleText('noRoot', 'no root', 'no-root')
            })
        ).rejects.toThrow(/no toolFolders are configured/);

        await expect(
            noFolders.executeTool('toolManage', {
                operation: 'update',
                name: 'toolRegistry',
                moduleText: moduleText('toolRegistry', 'replacement', 'replacement')
            })
        ).rejects.toThrow(/no toolFolders are configured/);

        const runtimeOnly = await noFolders.executeTool('toolManage', {
            operation: 'create',
            name: 'runtimeOnly',
            persist: 'runtime',
            moduleText: moduleText('runtimeOnly', 'runtime only', 'runtime')
        });
        expect(runtimeOnly).toMatchObject({
            name: 'runtimeOnly',
            operation: 'create',
            persisted: false
        });
        expect(await noFolders.executeTool('runtimeOnly', {})).toBe('runtime');

        await expect(
            noFolders.executeTool('toolManage', {
                operation: 'create',
                name: 'ambiguous',
                persist: 'runtime',
                path: 'ambiguous.tool.ts',
                moduleText: moduleText('ambiguous', 'ambiguous', 'ambiguous')
            })
        ).rejects.toThrow(/cannot be combined with `path` or `folder`/);

        const one = folder('persist-errors');
        const folded = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one]
        });

        // A package-relative built-in is not silently mapped into the first folder.
        await expect(
            folded.executeTool('toolManage', {
                operation: 'update',
                name: 'toolRegistry',
                moduleText: moduleText('toolRegistry', 'replacement', 'replacement')
            })
        ).rejects.toThrow(/package source .* not a configured toolFolders file/);

        await expect(
            folded.executeTool('toolManage', {
                operation: 'create',
                name: '../unsafe',
                moduleText: moduleText('unsafe', 'unsafe', 'unsafe')
            })
        ).rejects.toThrow(/not safe for a \*\.tool\.ts file name/);

        await expect(
            folded.executeTool('toolManage', {
                operation: 'create',
                name: 'folderWithoutPath',
                folder: one,
                moduleText: moduleText('folderWithoutPath', 'folder', 'folder')
            })
        ).rejects.toThrow(/folder.*requires an explicit `path`/);
    });

    it('rolls back failed pathless create/update and reports no dangling file', async () => {
        const one = folder('persist-rollback');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one]
        });

        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                name: 'broken',
                moduleText: 'export const metadata = (\n'
            })
        ).rejects.toThrow(/could not be transpiled/);
        expect(fs.existsSync(path.join(one, 'broken.tool.ts'))).toBe(false);

        await writerHandle.executeTool('toolManage', {
            operation: 'create',
            name: 'stable',
            moduleText: moduleText('stable', 'stable v1', 'stable-v1')
        });
        const before = fs.readFileSync(path.join(one, 'stable.tool.ts'), 'utf8');

        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'update',
                name: 'stable',
                moduleText: 'export const metadata = (\n'
            })
        ).rejects.toThrow(/could not be transpiled/);
        expect(fs.readFileSync(path.join(one, 'stable.tool.ts'), 'utf8')).toBe(before);
        expect(await writerHandle.executeTool('stable', {})).toBe('stable-v1');

        // A pathless create never overwrites an existing deterministic target.
        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                name: 'stable',
                moduleText: moduleText('stable', 'duplicate', 'duplicate')
            })
        ).rejects.toThrow(/already exists; use operation "update"/);
    });

    it('rejects traversal, symlink escape, and non-.tool.ts paths', async () => {
        const one = folder('fence-one');
        const outside = folder('fence-outside');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one]
        });

        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                path: '../escape.tool.ts',
                moduleText: moduleText('escape', 'escape', 'escape')
            })
        ).rejects.toThrow(/outside the configured toolFolders/);
        expect(fs.existsSync(path.join(outside, 'escape.tool.ts'))).toBe(false);

        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                path: 'wrong-extension.ts',
                moduleText: moduleText('wrong', 'wrong extension', 'wrong')
            })
        ).rejects.toThrow(/must end in "\.tool\.ts"/);

        // A directory symlink/junction inside the folder must not become a write
        // escape. `junction` is the unprivileged Windows directory link.
        fs.symlinkSync(outside, path.join(one, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

        await expect(
            writerHandle.executeTool('toolManage', {
                operation: 'create',
                path: 'link/symlink-escape.tool.ts',
                moduleText: moduleText('symlinkEscape', 'escape', 'escape')
            })
        ).rejects.toThrow(/escapes the configured toolFolders/);
        expect(fs.existsSync(path.join(outside, 'symlink-escape.tool.ts'))).toBe(false);
    });

    it('supports runtime-only updates and reloads disk-backed revisions', async () => {
        const one = folder('reload-one');
        const writerHandle = harness({
            agents: { writer: writer() },
            presets: false,
            toolFolders: [one]
        });

        await writerHandle.executeTool('toolManage', {
            operation: 'create',
            path: 'reload.tool.ts',
            moduleText: moduleText('reload', 'disk v1', 'disk-v1')
        });

        // Explicit runtime-only mode: no disk write.
        const runtimeCreated = await writerHandle.executeTool('toolManage', {
            operation: 'create',
            name: 'runtimeOnly',
            persist: 'runtime',
            moduleText: moduleText('runtimeOnly', 'runtime only create', 'runtime-create')
        });
        expect(runtimeCreated).toMatchObject({
            name: 'runtimeOnly',
            created: true,
            operation: 'create',
            persisted: false
        });
        expect(await writerHandle.executeTool('runtimeOnly', {})).toBe('runtime-create');
        expect(fs.existsSync(path.join(one, 'runtimeOnly.tool.ts'))).toBe(false);

        const details = await writerHandle.executeTool('toolManage', {
            operation: 'details',
            name: 'reload'
        });
        expect(details).toMatchObject({
            name: 'reload',
            description: 'disk v1',
            tags: ['fixture', 'reload'],
            visibility: 'searchable',
            enabled: true,
            hasSource: true,
            sourcePath: path.join(one, 'reload.tool.ts').replace(/\\/g, '/'),
            format: 'module',
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });

        const source = await writerHandle.executeTool('toolManage', {
            operation: 'source',
            name: 'reload'
        });
        expect(source).toMatchObject({
            name: 'reload',
            sourcePath: path.join(one, 'reload.tool.ts').replace(/\\/g, '/'),
            moduleText: moduleText('reload', 'disk v1', 'disk-v1'),
            dependencies: [],
            format: 'module'
        });

        // Edit the file outside the harness, then reload: the disk bytes win.
        fs.writeFileSync(
            path.join(one, 'reload.tool.ts'),
            moduleText('reload', 'disk v2', 'disk-v2'),
            'utf8'
        );
        const reloaded = await writerHandle.executeTool('toolManage', {
            operation: 'reload',
            name: 'reload'
        });
        expect(reloaded).toMatchObject({
            name: 'reload',
            replaced: true,
            operation: 'reload',
            reloaded: true,
            fromDisk: true
        });
        expect(await writerHandle.executeTool('reload', {})).toBe('disk-v2');

        // `path` reports the fence and the installed source path without writing.
        expect(
            await writerHandle.executeTool('toolManage', { operation: 'path', name: 'reload' })
        ).toEqual({
            folders: [one],
            name: 'reload',
            sourcePath: path.join(one, 'reload.tool.ts').replace(/\\/g, '/')
        });

        // Explicit runtime-only mode: no disk write, despite a successful
        // replacement. The new revision has no disk sourcePath.
        const runtimeOnly = await writerHandle.executeTool('toolManage', {
            operation: 'update',
            name: 'reload',
            persist: 'runtime',
            moduleText: moduleText('reload', 'runtime only', 'runtime')
        });
        expect(runtimeOnly).toMatchObject({
            name: 'reload',
            replaced: true,
            operation: 'update',
            persisted: false
        });
        expect(await writerHandle.executeTool('reload', {})).toBe('runtime');
        expect(fs.readFileSync(path.join(one, 'reload.tool.ts'), 'utf8')).toContain(
            'disk v2'
        );

        // The captured revision is honest (runtime moduleText, no disk sourcePath)
        // while the owning folder file stays associated for a later default update.
        expect(
            await writerHandle.executeTool('toolManage', { operation: 'path', name: 'reload' })
        ).toEqual({
            folders: [one],
            name: 'reload',
            owningPath: path.join(one, 'reload.tool.ts').replace(/\\/g, '/')
        });

        // A later default update still lands on the owning file and restores a
        // disk-backed revision.
        const reattached = await writerHandle.executeTool('toolManage', {
            operation: 'update',
            name: 'reload',
            moduleText: moduleText('reload', 'disk v3', 'disk-v3')
        });
        expect(reattached).toMatchObject({
            name: 'reload',
            operation: 'update',
            persisted: true,
            path: path.join(one, 'reload.tool.ts')
        });
        expect(fs.readFileSync(path.join(one, 'reload.tool.ts'), 'utf8')).toContain('disk v3');
        expect(await writerHandle.executeTool('reload', {})).toBe('disk-v3');
    });
});
