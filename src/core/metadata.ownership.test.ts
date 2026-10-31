// T19 metadata ownership + discovery contract.
//
// What this file pins (replacing the T13 "same object identity" contract):
//   - every entry (runtime AND preset) owns a PURE-LITERAL `metadata` export and a
//     separate PURE-LITERAL `registration` policy export, under the consolidated
//     `src/tools/` tree (R7: the old top-level `runtime-tools/` folder is gone);
//   - `core/metadata.ts` is a DATA PROJECTION of the generated manifest: it never
//     imports a `.tool` module (R9), so the object identities are deliberately
//     independent of the entry modules;
//   - the projection still deep-equals the authoritative entry literals, so a
//     descriptor cannot advertise metadata the entry does not declare;
//   - the historical `coreToolMetadata()` order and the conditional-tool exclusions
//     are preserved through `registration.order` / `registration.alwaysDeclared`;
//   - the cross-contract toolManage persistence schema and toolRequest wording are
//     present in the authoritative entry modules.
//
// The entry checks deliberately import the real entry modules. This is a Node test:
// loading node:fs here does NOT weaken the package's lazy/browser contract, which is
// asserted separately (src/core/tool-discovery.test.ts + tools/laziness.test.ts).

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
import * as toolRequestEntry from '../tools/runtime/toolRequest.tool';
import * as toolListEntry from '../tools/runtime/toolList.tool';
import * as toolManageEntry from '../tools/runtime/toolManage.tool';
import * as toolCreateEntry from '../tools/runtime/toolCreate.tool';
import * as toolRegistryEntry from '../tools/runtime/toolRegistry.tool';
import * as todoManageEntry from '../tools/runtime/todoManage.tool';
import * as profileManageEntry from '../tools/runtime/profileManage.tool';
import * as chapterManageEntry from '../tools/runtime/chapterManage.tool';
import * as locationManageEntry from '../tools/runtime/locationManage.tool';
import * as agentManageEntry from '../tools/runtime/agentManage.tool';
import * as agentResultEntry from '../tools/runtime/agentResult.tool';
import * as agentDelegateEntry from '../tools/runtime/agentDelegate.tool';
import * as toolCancelEntry from '../tools/runtime/toolCancel.tool';
import * as actionRequestEntry from '../tools/runtime/actionRequest.tool';
import * as threadForkEntry from '../tools/runtime/threadFork.tool';
import * as threadSendEntry from '../tools/runtime/threadSend.tool';
import * as threadListEntry from '../tools/runtime/threadList.tool';

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
    metadata: MetadataRow;
    moduleMetadata: MetadataRow;
    aggregated: MetadataRow;
};

// Every harness-owned runtime entry, now under tools/runtime (R7). The aggregated
// row comes from the compatibility facade, which projects the generated manifest.
const runtimeEntries: RuntimeEntry[] = [
    {
        wireName: 'toolRequest',
        sourcePath: '../tools/runtime/toolRequest.tool.ts',
        metadata: toolRequestEntry.TOOL_REQUEST_METADATA,
        moduleMetadata: toolRequestEntry.metadata,
        aggregated: coreMetadata.TOOL_REQUEST_METADATA
    },
    {
        wireName: 'toolList',
        sourcePath: '../tools/runtime/toolList.tool.ts',
        metadata: toolListEntry.TOOL_LIST_METADATA,
        moduleMetadata: toolListEntry.metadata,
        aggregated: coreMetadata.TOOL_LIST_METADATA
    },
    {
        wireName: 'toolManage',
        sourcePath: '../tools/runtime/toolManage.tool.ts',
        metadata: toolManageEntry.TOOL_MANAGE_METADATA,
        moduleMetadata: toolManageEntry.metadata,
        aggregated: coreMetadata.TOOL_MANAGE_METADATA
    },
    {
        wireName: 'toolCreate',
        sourcePath: '../tools/runtime/toolCreate.tool.ts',
        metadata: toolCreateEntry.TOOL_CREATE_METADATA,
        moduleMetadata: toolCreateEntry.metadata,
        aggregated: coreMetadata.TOOL_CREATE_METADATA
    },
    {
        wireName: 'toolRegistry',
        sourcePath: '../tools/runtime/toolRegistry.tool.ts',
        metadata: toolRegistryEntry.TOOL_REGISTRY_METADATA,
        moduleMetadata: toolRegistryEntry.metadata,
        aggregated: coreMetadata.TOOL_REGISTRY_METADATA
    },
    {
        wireName: 'todoManage',
        sourcePath: '../tools/runtime/todoManage.tool.ts',
        metadata: todoManageEntry.TODO_MANAGE_METADATA,
        moduleMetadata: todoManageEntry.metadata,
        aggregated: coreMetadata.TODO_MANAGE_METADATA
    },
    {
        wireName: 'profileManage',
        sourcePath: '../tools/runtime/profileManage.tool.ts',
        metadata: profileManageEntry.PROFILE_MANAGE_METADATA,
        moduleMetadata: profileManageEntry.metadata,
        aggregated: coreMetadata.PROFILE_MANAGE_METADATA
    },
    {
        wireName: 'chapterManage',
        sourcePath: '../tools/runtime/chapterManage.tool.ts',
        metadata: chapterManageEntry.CHAPTER_MANAGE_METADATA,
        moduleMetadata: chapterManageEntry.metadata,
        aggregated: coreMetadata.CHAPTER_MANAGE_METADATA
    },
    {
        wireName: 'locationManage',
        sourcePath: '../tools/runtime/locationManage.tool.ts',
        metadata: locationManageEntry.LOCATION_MANAGE_METADATA,
        moduleMetadata: locationManageEntry.metadata,
        aggregated: coreMetadata.LOCATION_MANAGE_METADATA
    },
    {
        wireName: 'agentManage',
        sourcePath: '../tools/runtime/agentManage.tool.ts',
        metadata: agentManageEntry.AGENT_MANAGE_METADATA,
        moduleMetadata: agentManageEntry.metadata,
        aggregated: coreMetadata.AGENT_MANAGE_METADATA
    },
    {
        wireName: 'agentResult',
        sourcePath: '../tools/runtime/agentResult.tool.ts',
        metadata: agentResultEntry.AGENT_RESULT_METADATA,
        moduleMetadata: agentResultEntry.metadata,
        aggregated: coreMetadata.AGENT_RESULT_METADATA
    },
    {
        wireName: 'toolCancel',
        sourcePath: '../tools/runtime/toolCancel.tool.ts',
        metadata: toolCancelEntry.TOOL_CANCEL_METADATA,
        moduleMetadata: toolCancelEntry.metadata,
        aggregated: coreMetadata.TOOL_CANCEL_METADATA
    },
    {
        wireName: 'actionRequest',
        sourcePath: '../tools/runtime/actionRequest.tool.ts',
        metadata: actionRequestEntry.ACTION_REQUEST_METADATA,
        moduleMetadata: actionRequestEntry.metadata,
        aggregated: coreMetadata.ACTION_REQUEST_METADATA
    },
    {
        wireName: 'threadFork',
        sourcePath: '../tools/runtime/threadFork.tool.ts',
        metadata: threadForkEntry.THREAD_FORK_METADATA,
        moduleMetadata: threadForkEntry.metadata,
        aggregated: coreMetadata.THREAD_FORK_METADATA
    },
    {
        wireName: 'threadSend',
        sourcePath: '../tools/runtime/threadSend.tool.ts',
        metadata: threadSendEntry.THREAD_SEND_METADATA,
        moduleMetadata: threadSendEntry.metadata,
        aggregated: coreMetadata.THREAD_SEND_METADATA
    },
    {
        wireName: 'threadList',
        sourcePath: '../tools/runtime/threadList.tool.ts',
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

describe('runtime entry metadata ownership', () => {
    it('declares a literal metadata export and aliases it from the same file', () => {
        for (const entry of runtimeEntries) {
            expect(entry.metadata.name).toBe(entry.wireName);
            // Same-file alias: the module's `metadata` IS the historical constant.
            expect(entry.moduleMetadata).toBe(entry.metadata);
            // The facade is a manifest PROJECTION, so it is a different object that
            // must still deep-equal the entry's literal.
            expect(entry.aggregated).toEqual(entry.metadata);
        }
    });

    it('does not import core/metadata from any runtime entry', () => {
        for (const entry of runtimeEntries) {
            // An entry may MENTION the historical path in a comment; what must not
            // exist is a module import of it, which would re-create the cycle.
            expect(sourceOf(entry.sourcePath)).not.toMatch(
                /^\s*(import|export)[^;]*from\s+'[^']*core\/metadata'/m
            );
        }
    });

    it('declares a literal registration policy on every runtime entry', () => {
        for (const entry of runtimeEntries) {
            const source = sourceOf(entry.sourcePath);
            expect(source).toContain('export const registration = {');
            // Harness policy must not reach the model-facing schema.
            expect(entry.metadata).not.toHaveProperty('group');
            expect(entry.metadata).not.toHaveProperty('activation');
            expect(entry.metadata).not.toHaveProperty('order');
        }
    });

    it('keeps agentDelegate metadata literal and pins the inlined bounds', () => {
        // The facade's factory and the entry's factory are different module
        // instances on purpose (the facade must not import a .tool module), so the
        // contract is behavioural equality, not object identity.
        expect(agentDelegateEntry.AGENT_DELEGATE_NAME).toBe('agentDelegate');
        expect(agentDelegateEntry.agentDelegateMetadata().name).toBe('agentDelegate');
        expect(agentDelegateEntry.metadata.name).toBe('agentDelegate');
        // The zero-allowlist form is the entry literal, projected through the facade.
        expect(coreMetadata.AGENT_DELEGATE_NAME).toBe('agentDelegate');
        expect(coreMetadata.agentDelegateMetadata()).toEqual({
            name: 'agentDelegate',
            description: agentDelegateEntry.metadata.description,
            tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
            visibility: 'core',
            parameters: agentDelegateEntry.metadata.parameters
        });
        // The allowlist form is the ONE set-projection function.
        expect(coreMetadata.agentDelegateMetadata(['alpha', 'beta'])).toEqual(
            agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])
        );
        expect(agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])).toEqual({
            name: 'agentDelegate',
            description:
                'Delegate a self-contained task to a configured subagent and return its answer. Subagents: alpha, beta. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.',
            tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    agent: {
                        type: 'string',
                        enum: ['alpha', 'beta'],
                        description: 'Subagent name, one of the configured allowlist.'
                    },
                    input: {
                        type: 'string',
                        description: 'The full brief the subagent should act on.'
                    }
                },
                required: ['agent', 'input'],
                additionalProperties: false
            }
        });
        // The entry annotates the factory with the leaf type through a TYPE-ONLY
        // import of '../core' (erased at transpile, resolves to the LIVE core
        // module), so the captured revision keeps `dependencies: []`.
        expect(sourceOf('../tools/runtime/agentDelegate.tool.ts')).toContain(
            "import type { CoreToolMetadata } from '../../core';"
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

    it('never imports a .tool module from the compatibility facade', () => {
        // R9: the facade projects the generated manifest, so a catalogue can be
        // enumerated without evaluating a single tool body.
        const source = sourceOf('./metadata.ts');
        expect(source).not.toMatch(/from '[^']*\.tool'/);
        expect(source).toContain("from './tool-manifest'");
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

    it('aliases `metadata` to the local constant and declares a preset registration', () => {
        for (const entry of presetEntries) {
            const source = sourceOf(entry.sourcePath);
            expect(source).toContain(`export const metadata = ${entry.metadataName};`);
            expect(source).toContain('export const registration = {');
            expect(source).toContain("group: 'preset'");
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

    it('keeps catalogue.ts a data-only projection with generated implementation loads', () => {
        const source = sourceOf('../tools/catalogue.ts');

        expect(PRESET_TOOL_NAMES).toEqual(presetEntries.map((entry) => entry.key));
        // No static import of an implementation module: the bodies are reached
        // through the GENERATED loader (T19/T21), never named here.
        expect(source).not.toMatch(/from '\.\/(files|command|syntax)\//);
        expect(source).toContain('loadPresetTool');
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
