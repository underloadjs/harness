// T13 metadata ownership + consistency.
//
// This test pins the post-migration contract, not the old central table:
//   - every runtime-tools/<name>.tool.ts entry owns its metadata, and the
//     core/metadata.ts compatibility path re-exports the SAME object;
//   - every preset *.tool.ts entry owns a local metadata constant, and the
//     synchronous catalogue projection deep-equals it;
//   - no runtime entry imports core/metadata.ts and no preset entry imports the
//     catalogue's PRESET_TOOLS value (either would break the cycle/lazy rules);
//   - the cross-contract toolManage persistence schema and toolRequest wording are
//     present in the authoritative entry modules.
//
// The preset checks deliberately import the real entry modules. This is a Node
// test: loading node:fs here does NOT weaken the package's lazy/browser contract,
// which is asserted statically against catalogue.ts below.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Tool } from '../types';
import * as catalogue from '../tools/catalogue';
import { PRESET_TOOL_NAMES, PRESET_TOOLS } from '../tools/catalogue';
import * as syntaxEntry from '../tools/syntax/syntaxCheck.tool';
import * as fileReadEntry from '../tools/files/fileRead.tool';
import * as fileWriteEntry from '../tools/files/fileWrite.tool';
import * as fileEditEntry from '../tools/files/fileEdit.tool';
import * as fileListEntry from '../tools/files/fileList.tool';
import * as fileGlobEntry from '../tools/files/fileGlob.tool';
import * as commandRunEntry from '../tools/command/commandRun.tool';
import * as gitDiffEntry from '../tools/command/gitDiff.tool';
import * as coreMetadata from './metadata';
import { ACTION_REQUEST_LIMITS } from './action';
import {
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION,
    TOOL_MANAGE_METADATA,
    TOOL_REQUEST_METADATA,
    coreToolMetadata
} from './metadata';
import * as toolRequestEntry from '../runtime-tools/toolRequest.tool';
import * as toolListEntry from '../runtime-tools/toolList.tool';
import * as toolManageEntry from '../runtime-tools/toolManage.tool';
import * as toolCreateEntry from '../runtime-tools/toolCreate.tool';
import * as toolRegistryEntry from '../runtime-tools/toolRegistry.tool';
import * as todoManageEntry from '../runtime-tools/todoManage.tool';
import * as profileManageEntry from '../runtime-tools/profileManage.tool';
import * as chapterManageEntry from '../runtime-tools/chapterManage.tool';
import * as locationManageEntry from '../runtime-tools/locationManage.tool';
import * as agentManageEntry from '../runtime-tools/agentManage.tool';
import * as agentResultEntry from '../runtime-tools/agentResult.tool';
import * as agentDelegateEntry from '../runtime-tools/agentDelegate.tool';
import * as toolCancelEntry from '../runtime-tools/toolCancel.tool';
import * as actionRequestEntry from '../runtime-tools/actionRequest.tool';
import * as threadForkEntry from '../runtime-tools/threadFork.tool';
import * as threadSendEntry from '../runtime-tools/threadSend.tool';
import * as threadListEntry from '../runtime-tools/threadList.tool';

const sourceOf = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

type MetadataRow = {
    name: string;
    description: string;
    tags: readonly string[];
    visibility?: string;
    parameters: Record<string, unknown>;
};

type RuntimeEntry = {
    wireName: string;
    sourcePath: string;
    metadataName: string;
    metadata: MetadataRow;
    moduleMetadata: MetadataRow;
    aggregated: MetadataRow;
};

// Every runtime entry that historically imported TOOL_*_METADATA from
// core/metadata.ts. webSearch/webFetch already owned local metadata before T13.
const runtimeEntries: RuntimeEntry[] = [
    {
        wireName: 'toolRequest',
        sourcePath: '../runtime-tools/toolRequest.tool.ts',
        metadataName: 'TOOL_REQUEST_METADATA',
        metadata: toolRequestEntry.TOOL_REQUEST_METADATA,
        moduleMetadata: toolRequestEntry.metadata,
        aggregated: coreMetadata.TOOL_REQUEST_METADATA
    },
    {
        wireName: 'toolList',
        sourcePath: '../runtime-tools/toolList.tool.ts',
        metadataName: 'TOOL_LIST_METADATA',
        metadata: toolListEntry.TOOL_LIST_METADATA,
        moduleMetadata: toolListEntry.metadata,
        aggregated: coreMetadata.TOOL_LIST_METADATA
    },
    {
        wireName: 'toolManage',
        sourcePath: '../runtime-tools/toolManage.tool.ts',
        metadataName: 'TOOL_MANAGE_METADATA',
        metadata: toolManageEntry.TOOL_MANAGE_METADATA,
        moduleMetadata: toolManageEntry.metadata,
        aggregated: coreMetadata.TOOL_MANAGE_METADATA
    },
    {
        wireName: 'toolCreate',
        sourcePath: '../runtime-tools/toolCreate.tool.ts',
        metadataName: 'TOOL_CREATE_METADATA',
        metadata: toolCreateEntry.TOOL_CREATE_METADATA,
        moduleMetadata: toolCreateEntry.metadata,
        aggregated: coreMetadata.TOOL_CREATE_METADATA
    },
    {
        wireName: 'toolRegistry',
        sourcePath: '../runtime-tools/toolRegistry.tool.ts',
        metadataName: 'TOOL_REGISTRY_METADATA',
        metadata: toolRegistryEntry.TOOL_REGISTRY_METADATA,
        moduleMetadata: toolRegistryEntry.metadata,
        aggregated: coreMetadata.TOOL_REGISTRY_METADATA
    },
    {
        wireName: 'todoManage',
        sourcePath: '../runtime-tools/todoManage.tool.ts',
        metadataName: 'TODO_MANAGE_METADATA',
        metadata: todoManageEntry.TODO_MANAGE_METADATA,
        moduleMetadata: todoManageEntry.metadata,
        aggregated: coreMetadata.TODO_MANAGE_METADATA
    },
    {
        wireName: 'profileManage',
        sourcePath: '../runtime-tools/profileManage.tool.ts',
        metadataName: 'PROFILE_MANAGE_METADATA',
        metadata: profileManageEntry.PROFILE_MANAGE_METADATA,
        moduleMetadata: profileManageEntry.metadata,
        aggregated: coreMetadata.PROFILE_MANAGE_METADATA
    },
    {
        wireName: 'chapterManage',
        sourcePath: '../runtime-tools/chapterManage.tool.ts',
        metadataName: 'CHAPTER_MANAGE_METADATA',
        metadata: chapterManageEntry.CHAPTER_MANAGE_METADATA,
        moduleMetadata: chapterManageEntry.metadata,
        aggregated: coreMetadata.CHAPTER_MANAGE_METADATA
    },
    {
        wireName: 'locationManage',
        sourcePath: '../runtime-tools/locationManage.tool.ts',
        metadataName: 'LOCATION_MANAGE_METADATA',
        metadata: locationManageEntry.LOCATION_MANAGE_METADATA,
        moduleMetadata: locationManageEntry.metadata,
        aggregated: coreMetadata.LOCATION_MANAGE_METADATA
    },
    {
        wireName: 'agentManage',
        sourcePath: '../runtime-tools/agentManage.tool.ts',
        metadataName: 'AGENT_MANAGE_METADATA',
        metadata: agentManageEntry.AGENT_MANAGE_METADATA,
        moduleMetadata: agentManageEntry.metadata,
        aggregated: coreMetadata.AGENT_MANAGE_METADATA
    },
    {
        wireName: 'agentResult',
        sourcePath: '../runtime-tools/agentResult.tool.ts',
        metadataName: 'AGENT_RESULT_METADATA',
        metadata: agentResultEntry.AGENT_RESULT_METADATA,
        moduleMetadata: agentResultEntry.metadata,
        aggregated: coreMetadata.AGENT_RESULT_METADATA
    },
    {
        wireName: 'toolCancel',
        sourcePath: '../runtime-tools/toolCancel.tool.ts',
        metadataName: 'TOOL_CANCEL_METADATA',
        metadata: toolCancelEntry.TOOL_CANCEL_METADATA,
        moduleMetadata: toolCancelEntry.metadata,
        aggregated: coreMetadata.TOOL_CANCEL_METADATA
    },
    {
        wireName: 'actionRequest',
        sourcePath: '../runtime-tools/actionRequest.tool.ts',
        metadataName: 'ACTION_REQUEST_METADATA',
        metadata: actionRequestEntry.ACTION_REQUEST_METADATA,
        moduleMetadata: actionRequestEntry.metadata,
        aggregated: coreMetadata.ACTION_REQUEST_METADATA
    },
    {
        wireName: 'threadFork',
        sourcePath: '../runtime-tools/threadFork.tool.ts',
        metadataName: 'THREAD_FORK_METADATA',
        metadata: threadForkEntry.THREAD_FORK_METADATA,
        moduleMetadata: threadForkEntry.metadata,
        aggregated: coreMetadata.THREAD_FORK_METADATA
    },
    {
        wireName: 'threadSend',
        sourcePath: '../runtime-tools/threadSend.tool.ts',
        metadataName: 'THREAD_SEND_METADATA',
        metadata: threadSendEntry.THREAD_SEND_METADATA,
        moduleMetadata: threadSendEntry.metadata,
        aggregated: coreMetadata.THREAD_SEND_METADATA
    },
    {
        wireName: 'threadList',
        sourcePath: '../runtime-tools/threadList.tool.ts',
        metadataName: 'THREAD_LIST_METADATA',
        metadata: threadListEntry.THREAD_LIST_METADATA,
        moduleMetadata: threadListEntry.metadata,
        aggregated: coreMetadata.THREAD_LIST_METADATA
    }
];

type PresetEntry = {
    key: keyof typeof PRESET_TOOLS;
    metadataName: string;
    sourcePath: string;
    metadata: MetadataRow;
    tool: Tool;
};

const presetEntries: PresetEntry[] = [
    {
        key: 'syntaxCheck',
        metadataName: 'SYNTAX_CHECK_METADATA',
        sourcePath: '../tools/syntax/syntaxCheck.tool.ts',
        metadata: syntaxEntry.SYNTAX_CHECK_METADATA,
        tool: syntaxEntry.syntaxCheck
    },
    {
        key: 'fileRead',
        metadataName: 'FILE_READ_METADATA',
        sourcePath: '../tools/files/fileRead.tool.ts',
        metadata: fileReadEntry.FILE_READ_METADATA,
        tool: fileReadEntry.fileRead
    },
    {
        key: 'fileWrite',
        metadataName: 'FILE_WRITE_METADATA',
        sourcePath: '../tools/files/fileWrite.tool.ts',
        metadata: fileWriteEntry.FILE_WRITE_METADATA,
        tool: fileWriteEntry.fileWrite
    },
    {
        key: 'fileEdit',
        metadataName: 'FILE_EDIT_METADATA',
        sourcePath: '../tools/files/fileEdit.tool.ts',
        metadata: fileEditEntry.FILE_EDIT_METADATA,
        tool: fileEditEntry.fileEdit
    },
    {
        key: 'fileList',
        metadataName: 'FILE_LIST_METADATA',
        sourcePath: '../tools/files/fileList.tool.ts',
        metadata: fileListEntry.FILE_LIST_METADATA,
        tool: fileListEntry.fileList
    },
    {
        key: 'fileGlob',
        metadataName: 'FILE_GLOB_METADATA',
        sourcePath: '../tools/files/fileGlob.tool.ts',
        metadata: fileGlobEntry.FILE_GLOB_METADATA,
        tool: fileGlobEntry.fileGlob
    },
    {
        key: 'commandRun',
        metadataName: 'COMMAND_RUN_METADATA',
        sourcePath: '../tools/command/commandRun.tool.ts',
        metadata: commandRunEntry.COMMAND_RUN_METADATA,
        tool: commandRunEntry.commandRun
    },
    {
        key: 'gitDiff',
        metadataName: 'GIT_DIFF_METADATA',
        sourcePath: '../tools/command/gitDiff.tool.ts',
        metadata: gitDiffEntry.GIT_DIFF_METADATA,
        tool: gitDiffEntry.gitDiff
    }
];

describe('runtime-tools metadata ownership', () => {
    it('declares each metadata object in its own entry and re-exports the same identity', () => {
        for (const entry of runtimeEntries) {
            expect(entry.metadata.name).toBe(entry.wireName);
            expect(entry.moduleMetadata).toBe(entry.metadata);
            expect(entry.aggregated).toBe(entry.metadata);
            expect(sourceOf(entry.sourcePath)).toContain(
                `export const ${entry.metadataName}`
            );
        }
    });

    it('does not import the core/metadata aggregator from any runtime entry', () => {
        for (const entry of runtimeEntries) {
            // An entry may MENTION the historical path in a comment; what must not
            // exist is a module import of it, which would re-create the cycle.
            expect(sourceOf(entry.sourcePath)).not.toMatch(
                /^\s*(import|export)[^;]*from\s+'[^']*core\/metadata'/m
            );
        }
    });

    it('keeps agentDelegate metadata local and pins the inlined bounds', () => {
        expect(coreMetadata.agentDelegateMetadata).toBe(agentDelegateEntry.agentDelegateMetadata);
        expect(agentDelegateEntry.AGENT_DELEGATE_NAME).toBe('agentDelegate');
        expect(agentDelegateEntry.agentDelegateMetadata().name).toBe('agentDelegate');
        expect(agentDelegateEntry.metadata.name).toBe('agentDelegate');
        // The entry annotates the factory with the leaf type, so a missing type
        // import would fail type-checking (TS2304) rather than silently widening.
        //
        // The type is imported from '../core' rather than '../core/tool-metadata':
        // a type-only import is erased at transpile and resolves to the LIVE core
        // module, so the captured revision keeps `dependencies: []` (the shipped
        // packaging contract in scripts/check-package-tools.mjs). A leaf import
        // would be captured as a local dependency.
        expect(sourceOf('../runtime-tools/agentDelegate.tool.ts')).toContain(
            "import type { CoreToolMetadata } from '../core';"
        );

        expect([
            AGENT_MANAGE_PREVIEW_CHARS,
            AGENT_MANAGE_LIST_PER_AGENT,
            AGENT_RESULT_RETENTION,
            AGENT_RESULT_PAGE_CHARS,
            AGENT_RESULT_PAGE_MAX_CHARS
        ]).toEqual([200, 5, 64, 4000, 8000]);

        // The entries inline these numbers; they must stay equal to the canonical
        // constants the harness and the server catalogue read.
        const agentManage = agentManageEntry.AGENT_MANAGE_METADATA.parameters as any;
        const agentResult = agentResultEntry.AGENT_RESULT_METADATA.parameters as any;
        expect(agentManage.properties).toEqual({});
        expect(agentManage.additionalProperties).toBe(false);
        expect(agentResult.properties.limit.maximum).toBe(AGENT_RESULT_PAGE_MAX_CHARS);
        expect(agentResult.properties.limit.description).toBe(
            `Page size in characters, 1-${AGENT_RESULT_PAGE_MAX_CHARS}. Defaults to ${AGENT_RESULT_PAGE_CHARS}.`
        );
        expect(agentManageEntry.AGENT_MANAGE_METADATA.description).toContain(
            `up to ${AGENT_MANAGE_LIST_PER_AGENT} recent invocations`
        );
        expect(agentManageEntry.AGENT_MANAGE_METADATA.description).toContain(
            `at most ${AGENT_MANAGE_PREVIEW_CHARS} characters`
        );
        expect(agentResultEntry.AGENT_RESULT_METADATA.description).toContain(
            `at most ${AGENT_RESULT_PAGE_MAX_CHARS} characters (default ${AGENT_RESULT_PAGE_CHARS})`
        );
    });

    it('inlines the actionRequest/threadFork bounds equal to ACTION_REQUEST_LIMITS', () => {
        // Same reason as the agent bounds: the entries may not value-import
        // ../core, so the schema numbers are literals pinned against the one gate
        // that validates them at runtime (core/action.ts).
        const actionRequest = actionRequestEntry.ACTION_REQUEST_METADATA.parameters as any;
        const threadFork = threadForkEntry.THREAD_FORK_METADATA.parameters as any;

        expect(actionRequest.properties.question).toEqual({
            type: 'string',
            minLength: 1,
            maxLength: ACTION_REQUEST_LIMITS.question,
            description:
                'The one question to ask. Be specific about the decision and why it matters. Maximum 4000 characters.'
        });
        expect(actionRequest.properties.recommended).toMatchObject({
            minLength: ACTION_REQUEST_LIMITS.optionIdMin,
            maxLength: ACTION_REQUEST_LIMITS.optionIdMax
        });
        expect(actionRequest.properties.options).toMatchObject({
            minItems: ACTION_REQUEST_LIMITS.optionsMin,
            maxItems: ACTION_REQUEST_LIMITS.optionsMax
        });
        expect(actionRequest.properties.options.items.properties.id).toMatchObject({
            minLength: ACTION_REQUEST_LIMITS.optionIdMin,
            maxLength: ACTION_REQUEST_LIMITS.optionIdMax
        });
        expect(actionRequest.properties.options.items.properties.label).toMatchObject({
            minLength: ACTION_REQUEST_LIMITS.optionLabelMin,
            maxLength: ACTION_REQUEST_LIMITS.optionLabelMax
        });
        expect(actionRequest.properties.options.items.properties.description).toMatchObject({
            maxLength: ACTION_REQUEST_LIMITS.optionDescriptionMax
        });
        expect(threadFork.properties.label).toMatchObject({
            minLength: 1,
            maxLength: ACTION_REQUEST_LIMITS.forkLabelMax
        });
    });

    it('keeps the always-registered projection in its historical order', () => {
        expect(coreToolMetadata().map((metadata) => metadata.name)).toEqual([
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
});

describe('preset metadata ownership', () => {
    it('declares every preset metadata constant in its own entry', () => {
        for (const entry of presetEntries) {
            expect(entry.metadata).toEqual(PRESET_TOOLS[entry.key]);
            expect(sourceOf(entry.sourcePath)).toContain(`export const ${entry.metadataName}`);
            expect(sourceOf(entry.sourcePath)).not.toContain('PRESET_TOOLS');
        }
    });

    it('spreads the local metadata into the executable Tool', () => {
        for (const entry of presetEntries) {
            expect(entry.tool.description).toBe(entry.metadata.description);
            expect(entry.tool.tags).toEqual([...entry.metadata.tags]);
            expect(entry.tool.parameters).toEqual(entry.metadata.parameters);
            expect(entry.tool.visibility).toBe(entry.metadata.visibility ?? 'searchable');
        }
    });

    it('keeps catalogue.ts a data-only projection with dynamic implementation loads', () => {
        const source = sourceOf('../tools/catalogue.ts');

        expect(PRESET_TOOL_NAMES).toEqual(presetEntries.map((entry) => entry.key));
        expect(source).not.toMatch(/from '\.\/(files|command|syntax)\//);
        expect(source).toContain("import('./files/fileRead.tool')");
        expect(Object.keys(catalogue.PRESET_TOOLS)).toEqual(PRESET_TOOL_NAMES);
    });
});

describe('T13/T12 declarative cross-contract', () => {
    it('offers persist folder/runtime with folder as the default', () => {
        const schema = TOOL_MANAGE_METADATA.parameters;
        const properties = schema.properties as Record<string, any>;

        expect(properties.operation.enum).toEqual([
            'list',
            'details',
            'source',
            'path',
            'create',
            'update',
            'reload'
        ]);
        expect(properties.persist).toEqual({
            type: 'string',
            enum: ['folder', 'runtime'],
            default: 'folder',
            description:
                'Where create/update persist the module. "folder" (default) writes it to disk: a safe `<name>.tool.ts` in the last configured toolFolders entry for create, or the owning source path for update. "runtime" explicitly keeps it in this session\'s registry only and cannot be combined with `path` or `folder`.'
        });
        expect(properties.path.description).toBe(
            'Explicit *.tool.ts file path, absolute or relative to `folder`. Overrides the default create filename or the update owning path; not allowed with persist "runtime".'
        );
        expect(properties.folder.description).toBe(
            'Configured toolFolders entry that a relative `path` resolves against; requires `path`. A pathless create targets the LAST configured entry.'
        );
        expect(schema.required).toEqual(['operation']);
        expect(schema.additionalProperties).toBe(false);
    });

    it('describes newest-request replacement for every selector and exact omitted counts', () => {
        expect(TOOL_REQUEST_METADATA.description).toBe(
            'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example agentDelegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.'
        );
    });
});
