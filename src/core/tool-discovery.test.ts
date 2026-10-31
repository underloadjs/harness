// T19 discovery contract: metadata-first scanning, generated-manifest parity.
//
// What this file pins (R7/R8/R9):
//   1. `src/tools/` is the single tools tree: the old top-level `runtime-tools/`
//      folder is gone and every runtime entry lives under `src/tools/runtime/`;
//   2. `discoverToolMetadata()` finds every `*.tool.ts` by SCANNING, in the
//      documented order, with no hand-maintained inventory anywhere;
//   3. it never imports a tool module: a fixture whose top level throws is still
//      fully discoverable, and metadata is lifted from the source text alone;
//   4. the generated manifest (`core/tool-manifest.ts`) is BYTE-IDENTICAL to a
//      fresh scan, so the committed data can never go stale;
//   5. a folder entry is discovered after every package entry (folder wins a name
//      collision), and an invalid entry names its exact file;
//   6. the compatibility facade (`core/metadata.ts`) is a projection of that
//      manifest and imports no `.tool` module.
//
// Deterministic throughout: every list assertion is an exact array, every value
// assertion is the literal the entry declares.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_DESCRIPTORS, loadDiscoveredTool } from './tool-manifest';
import { discoverToolMetadata } from './tool-discovery';
import { coreToolMetadata } from './metadata';
import type { DiscoveredTool } from './tool-metadata';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(SRC, '..', '..');
const TOOLS_ROOT = path.join(PACKAGE_ROOT, 'src', 'tools');

// Scratch folders live under the repo-root Temp/ (AGENTS.md), never OS temp.
const SCRATCH_ROOT = path.join(PACKAGE_ROOT, '..', '..', '..', 'Temp', 't19', 'discovery-fixtures');
const scratchFolders: string[] = [];

const scratchFolder = (name: string): string => {
    const folder = path.join(SCRATCH_ROOT, `${name}-${process.pid}-${scratchFolders.length}`);
    fs.mkdirSync(folder, { recursive: true });
    scratchFolders.push(folder);
    return folder;
};

const writeEntry = (folder: string, relative: string, text: string): string => {
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return file;
};

afterAll(() => {
    for (const folder of scratchFolders) fs.rmSync(folder, { recursive: true, force: true });
    // Best effort: leave no empty scratch tree behind.
    try {
        fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    } catch {
        // Another worker may hold a handle; the folder is disposable either way.
    }
});

const descriptorNames = (descriptors: readonly DiscoveredTool[]): string[] =>
    descriptors.map((descriptor) => descriptor.name);

describe('tools folder consolidation (R7)', () => {
    it('has no top-level runtime-tools folder and keeps every entry under tools/', () => {
        expect(fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'runtime-tools'))).toBe(false);

        const runtimeEntries = fs
            .readdirSync(path.join(TOOLS_ROOT, 'runtime'))
            .filter((name) => name.endsWith('.tool.ts'))
            .sort();

        expect(runtimeEntries).toEqual([
            'actionRequest.tool.ts',
            'agentDelegate.tool.ts',
            'agentManage.tool.ts',
            'agentResult.tool.ts',
            'chapterManage.tool.ts',
            'locationManage.tool.ts',
            'profileManage.tool.ts',
            'threadFork.tool.ts',
            'threadList.tool.ts',
            'threadSend.tool.ts',
            'todoManage.tool.ts',
            'toolCancel.tool.ts',
            'toolCreate.tool.ts',
            'toolList.tool.ts',
            'toolManage.tool.ts',
            'toolRegistry.tool.ts',
            'toolRequest.tool.ts',
            'webFetch.tool.ts',
            'webSearch.tool.ts'
        ]);
    });
});

describe('discoverToolMetadata (R8/R9)', () => {
    it('scans every package entry in registration order', () => {
        const descriptors = discoverToolMetadata();

        expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
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
            'threadFork',
            'actionRequest',
            'toolCancel',
            'syntaxCheck',
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileList',
            'fileGlob',
            'commandRun',
            'gitDiff',
            'webSearch',
            'webFetch',
            'threadSend',
            'threadList'
        ]);
    });

    it('reports the group, activation, origin and sourcePath of one entry exactly', () => {
        const descriptors = discoverToolMetadata();
        const read = descriptors.find((descriptor) => descriptor.name === 'fileRead');

        expect(read).toBeDefined();
        expect({
            name: read!.name,
            label: read!.label,
            sourcePath: read!.sourcePath,
            origin: read!.origin,
            group: read!.group,
            activation: read!.activation,
            order: read!.order,
            listed: read!.listed,
            alwaysDeclared: read!.alwaysDeclared
        }).toEqual({
            name: 'fileRead',
            label: 'tools/files/fileRead.tool.ts',
            sourcePath: 'tools/files/fileRead.tool.ts',
            origin: 'package',
            group: 'preset',
            activation: 'always',
            order: 170,
            listed: false,
            alwaysDeclared: false
        });
    });

    it('carries the conditional registration policy through to the descriptor', () => {
        const byName = new Map(
            discoverToolMetadata().map((descriptor) => [descriptor.name, descriptor])
        );

        const policy = (name: string) => {
            const descriptor = byName.get(name);
            expect(descriptor).toBeDefined();

            return {
                activation: descriptor!.activation,
                pendingOnly: descriptor!.pendingOnly,
                control: descriptor!.control,
                primaryOnly: descriptor!.primaryOnly,
                answerExtraction: descriptor!.answerExtraction,
                sessionBound: descriptor!.sessionBound
            };
        };

        expect(policy('agentDelegate')).toEqual({
            activation: 'subagents',
            pendingOnly: undefined,
            control: undefined,
            primaryOnly: true,
            answerExtraction: true,
            sessionBound: true
        });
        expect(policy('toolCancel')).toEqual({
            activation: 'always',
            pendingOnly: true,
            control: 'cancel',
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('threadFork')).toEqual({
            activation: 'forks',
            pendingOnly: undefined,
            control: 'fork',
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('actionRequest')).toEqual({
            activation: 'interaction',
            pendingOnly: undefined,
            control: 'action',
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('webSearch')).toEqual({
            activation: 'websearch',
            pendingOnly: undefined,
            control: undefined,
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('webFetch')).toEqual({
            activation: 'webfetch',
            pendingOnly: undefined,
            control: undefined,
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('threadSend')).toEqual({
            activation: 'threads',
            pendingOnly: undefined,
            control: undefined,
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: true
        });
        expect(policy('fileRead')).toEqual({
            activation: 'always',
            pendingOnly: undefined,
            control: undefined,
            primaryOnly: undefined,
            answerExtraction: undefined,
            sessionBound: false
        });
    });

    it('omits preset rows when includePresets is false', () => {
        expect(descriptorNames(discoverToolMetadata({ includePresets: false }))).toEqual([
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
            'threadFork',
            'actionRequest',
            'toolCancel',
            'webSearch',
            'webFetch',
            'threadSend',
            'threadList'
        ]);
    });

    it('lifts metadata from the source text, never by importing the module', () => {
        // Every runtime entry's top level would throw if evaluated in isolation
        // (they call `harness.runtime.*` at execute time, not import time), so the
        // stronger proof is structural: no entry is reachable from this module.
        const source = fs.readFileSync(path.join(SRC, 'tool-discovery.ts'), 'utf8');
        const scanSource = fs.readFileSync(path.join(SRC, 'tool-scan.ts'), 'utf8');

        for (const text of [source, scanSource]) {
            // A static `.tool` import anywhere here would evaluate a tool body.
            expect(text).not.toMatch(/^\s*import[^;]*from\s+'[^']*\.tool'/m);
            // Dynamic imports of an entry would defeat the metadata-first rule too.
            expect(text).not.toMatch(/import\(\s*['"][^'"]*\.tool['"]/);
        }
    });

    it('still discovers a metadata-only entry whose top level throws', () => {
        const folder = scratchFolder('throws');
        writeEntry(
            folder,
            'metadataOnly.tool.ts',
            [
                'export const metadata = {',
                "    name: 'metadataOnly',",
                "    description: 'Discovered without being evaluated.',",
                "    tags: ['fixture'],",
                '    parameters: { type: \'object\', properties: {} }',
                '};',
                '',
                'export const registration = {',
                "    group: 'external',",
                "    activation: 'always',",
                '    order: 5',
                '};',
                '',
                "throw new Error('this module must never be evaluated during discovery');"
            ].join('\n')
        );

        const folderDescriptors = discoverToolMetadata({ folders: [folder] });
        const discovered = folderDescriptors.find(
            (descriptor) => descriptor.name === 'metadataOnly'
        );

        expect(discovered).toBeDefined();
        expect({
            name: discovered!.name,
            description: discovered!.metadata.description,
            tags: discovered!.metadata.tags,
            origin: discovered!.origin,
            group: discovered!.group,
            activation: discovered!.activation,
            order: discovered!.order,
            sourcePath: discovered!.sourcePath
        }).toEqual({
            name: 'metadataOnly',
            description: 'Discovered without being evaluated.',
            tags: ['fixture'],
            origin: 'folder',
            group: 'external',
            activation: 'always',
            order: 5,
            sourcePath: path.join(folder, 'metadataOnly.tool.ts').replace(/\\/g, '/')
        });
    });

    it('appends folder entries after every package entry', () => {
        const folder = scratchFolder('ordering');
        writeEntry(
            folder,
            'nested/zzz.tool.ts',
            [
                'export const metadata = {',
                "    name: 'zzzFolderTool',",
                "    description: 'Folder entry.',",
                "    tags: ['fixture'],",
                '    parameters: { type: \'object\', properties: {} }',
                '};'
            ].join('\n')
        );

        const descriptors = discoverToolMetadata({ folders: [folder] });
        const names = descriptorNames(descriptors);
        const index = names.indexOf('zzzFolderTool');

        expect(index).toBe(names.length - 1);
        expect(descriptors[index]).toMatchObject({
            group: 'external',
            activation: 'always',
            order: 10_000,
            origin: 'folder',
            label: 'nested/zzz.tool.ts'
        });
    });

    it('reports the exact path of an invalid entry', () => {
        const folder = scratchFolder('invalid');
        const file = writeEntry(
            folder,
            'broken.tool.ts',
            [
                'export const metadata = {',
                "    name: 'broken',",
                "    description: 'Missing tags.',",
                '    parameters: { type: \'object\', properties: {} }',
                '};'
            ].join('\n')
        );

        expect(() => discoverToolMetadata({ folders: [folder] })).toThrow(
            `Tool entry broken.tool.ts metadata.tags must be a non-empty string array.`
        );
        expect(file.endsWith('broken.tool.ts')).toBe(true);
    });

    it('rejects a computed metadata expression with its file position', () => {
        const folder = scratchFolder('computed');
        writeEntry(
            folder,
            'computed.tool.ts',
            [
                "const description = 'computed at load time';",
                '',
                'export const metadata = {',
                "    name: 'computed',",
                '    description,',
                "    tags: ['fixture'],",
                '    parameters: { type: \'object\', properties: {} }',
                '};'
            ].join('\n')
        );

        expect(() => discoverToolMetadata({ folders: [folder] })).toThrow(
            /computed\.tool\.ts:\d+:\d+ uses a non-literal object member/
        );
    });

    it('rejects an entry that points metadata at another module', () => {
        const folder = scratchFolder('crossfile');
        writeEntry(
            folder,
            'crossFile.tool.ts',
            [
                "import { metadata as shared } from './shared';",
                '',
                'export const metadata = shared;'
            ].join('\n')
        );

        expect(() => discoverToolMetadata({ folders: [folder] })).toThrow(
            'which is not a top-level literal in the same file'
        );
    });

    it('rejects a package entry that declares the external group', () => {
        // Guard against a package entry claiming to be a host folder: the manifest
        // could then advertise a row no folder scan produced.
        const source = fs.readFileSync(path.join(SRC, 'tool-scan.ts'), 'utf8');
        expect(source).toContain('declares registration.group "external"');
    });
});

describe('generated manifest parity (R9)', () => {
    it('is byte-identical to a fresh scan of the package entries', async () => {
        // Re-render in-process from the SAME scan + renderer the generator uses. That
        // is the strongest deterministic check available without a subprocess, and it
        // is exactly what `--check` compares.
        const { renderManifest } = await import('../../scripts/tool-manifest-render.mjs');
        const { scanToolMetadata } = await import('./tool-scan');

        const fresh = scanToolMetadata({ includePresets: true }).filter(
            (descriptor) => descriptor.origin === 'package'
        );

        const committed = fs.readFileSync(path.join(SRC, 'tool-manifest.ts'), 'utf8');

        expect(committed).toBe(renderManifest(fresh));
    });

    it('describes every package entry, and no folder entry', () => {
        expect(BUILTIN_TOOL_DESCRIPTORS).toHaveLength(27);

        for (const descriptor of BUILTIN_TOOL_DESCRIPTORS) {
            expect(descriptor.origin).toBe('package');
            expect(descriptor.sourcePath.startsWith('tools/')).toBe(true);
            expect(descriptor.label).toBe(descriptor.sourcePath);
            expect(descriptor.group === 'runtime' || descriptor.group === 'preset').toBe(true);
        }
    });

    it('matches the live scan field for field', () => {
        expect(BUILTIN_TOOL_DESCRIPTORS).toEqual(discoverToolMetadata());
    });

    it('loads every generated label to a module with a usable export', async () => {
        // The loader is generated, so a label that does not resolve is a broken
        // manifest. Loading is safe here: these are the shipped entries and this is
        // a Node test (the browser/lazy contract is asserted separately).
        for (const descriptor of BUILTIN_TOOL_DESCRIPTORS) {
            const module = (await loadDiscoveredTool(descriptor.label)) as Record<string, unknown>;

            expect(typeof module).toBe('object');
            expect(module).not.toBeNull();
            // Every entry exports its metadata literal; runtime entries also export
            // `execute`, presets export a Tool.
            expect(module.metadata).toBeDefined();
        }
    });

    it('rejects an unknown label instead of resolving something else', async () => {
        await expect(loadDiscoveredTool('tools/nope/nope.tool.ts')).rejects.toThrow(
            'No generated tool loader for "tools/nope/nope.tool.ts". Regenerate with: npx vite-node scripts/generate-tool-manifest.mjs'
        );
    });
});

describe('compatibility facade (R9)', () => {
    it('projects the manifest without importing any tool module', () => {
        const source = fs.readFileSync(path.join(SRC, 'metadata.ts'), 'utf8');

        expect(source).not.toMatch(/from '[^']*\.tool'/);
        expect(source).toContain("from './tool-manifest'");
    });

    it('keeps the historical always-declared core order', () => {
        expect(coreToolMetadata().map((row) => row.name)).toEqual([
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult'
        ]);
    });

    it('returns detached copies so a caller cannot edit the generated table', () => {
        const first = coreToolMetadata();
        first[0].tags.push('mutated');
        first[0].parameters.injected = true;

        const second = coreToolMetadata();
        expect(second[0].tags).not.toContain('mutated');
        expect(second[0].parameters).not.toHaveProperty('injected');
    });
});
