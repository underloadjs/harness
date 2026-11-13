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
import * as syntaxEntry from '../tools/syntax/syntax.tool';
import * as fileReadEntry from '../tools/files/read.tool';
import * as writeEntry from '../tools/files/write.tool';
import * as fileEditEntry from '../tools/files/edit.tool';
import * as filesEntry from '../tools/files/files.tool';
import * as globEntry from '../tools/files/glob.tool';
import * as grepEntry from '../tools/files/grep.tool';
import * as commandRunEntry from '../tools/command/shell.tool';
import * as gitDiffEntry from '../tools/command/gitDiff.tool';
import * as downloadEntry from '../tools/webdownload/download.tool';
import * as coreMetadata from './metadata';
import { ACTION_REQUEST_LIMITS } from './action';
import {
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION,
    // 2026-11-13 (findings B5/C1): the bounds a MODEL may set. `core/agent-limits.ts`
    // is the canonical value; `core/metadata.ts` re-exports it so this file has ONE
    // import site, exactly like `DELEGATE_TIMEOUT_MS` above.
    DELEGATE_MAX_TURNS_MAX,
    DELEGATE_TIMEOUT_MS,
    FORK_TIMEOUT_MS,
    MODEL_TIMEOUT_MAX_MS,
    TOOL_MANAGE_METADATA,
    TOOL_REQUEST_METADATA,
    coreToolMetadata
} from './metadata';
import * as toolRequestEntry from '../tools/runtime/toolRequest.tool';
import * as toolListEntry from '../tools/runtime/toolList.tool';
import * as toolManageEntry from '../tools/runtime/toolManage.tool';
import * as toolCreateEntry from '../tools/runtime/toolCreate.tool';
import * as toolRegistryEntry from '../tools/runtime/toolRegistry.tool';
import * as tasksEntry from '../tools/runtime/tasks.tool';
// The engine's own entry (T3): authoritative like the wrappers, so it belongs in this
// matrix — its literals are owned by the entry and projected by core/metadata.ts.
import * as recordsEntry from '../tools/runtime/records.tool';
import * as profilesEntry from '../tools/runtime/profiles.tool';
import * as chaptersEntry from '../tools/runtime/chapters.tool';
import * as locationsEntry from '../tools/runtime/locations.tool';
import * as agentManageEntry from '../tools/runtime/agentManage.tool';
import * as agentResultEntry from '../tools/runtime/agentResult.tool';
import * as agentDelegateEntry from '../tools/runtime/delegate.tool';
import * as toolCancelEntry from '../tools/runtime/toolCancel.tool';
import * as actionRequestEntry from '../tools/runtime/actionRequest.tool';
import * as threadForkEntry from '../tools/runtime/threadFork.tool';
import * as threadSendEntry from '../tools/runtime/threadSend.tool';
import * as threadReadEntry from '../tools/runtime/threadRead.tool';
import * as threadListEntry from '../tools/runtime/threadList.tool';
// Issue 0027: the release door for a finished conversation. Projected through the
// facade now that the generated manifest carries the row (see core/metadata.ts).
import * as threadDeleteEntry from '../tools/runtime/threadDelete.tool';

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
        wireName: 'records',
        sourcePath: '../tools/runtime/records.tool.ts',
        metadata: recordsEntry.RECORDS_METADATA,
        moduleMetadata: recordsEntry.metadata,
        aggregated: coreMetadata.RECORDS_METADATA
    },
    {
        wireName: 'tasks',
        sourcePath: '../tools/runtime/tasks.tool.ts',
        metadata: tasksEntry.TASKS_METADATA,
        moduleMetadata: tasksEntry.metadata,
        aggregated: coreMetadata.TASKS_METADATA
    },
    {
        wireName: 'profiles',
        sourcePath: '../tools/runtime/profiles.tool.ts',
        metadata: profilesEntry.PROFILES_METADATA,
        moduleMetadata: profilesEntry.metadata,
        aggregated: coreMetadata.PROFILES_METADATA
    },
    {
        wireName: 'chapters',
        sourcePath: '../tools/runtime/chapters.tool.ts',
        metadata: chaptersEntry.CHAPTERS_METADATA,
        moduleMetadata: chaptersEntry.metadata,
        aggregated: coreMetadata.CHAPTERS_METADATA
    },
    {
        wireName: 'locations',
        sourcePath: '../tools/runtime/locations.tool.ts',
        metadata: locationsEntry.LOCATIONS_METADATA,
        moduleMetadata: locationsEntry.metadata,
        aggregated: coreMetadata.LOCATIONS_METADATA
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
        wireName: 'threadRead',
        sourcePath: '../tools/runtime/threadRead.tool.ts',
        metadata: threadReadEntry.THREAD_READ_METADATA,
        moduleMetadata: threadReadEntry.metadata,
        aggregated: coreMetadata.THREAD_READ_METADATA
    },
    {
        wireName: 'threadList',
        sourcePath: '../tools/runtime/threadList.tool.ts',
        metadata: threadListEntry.THREAD_LIST_METADATA,
        moduleMetadata: threadListEntry.metadata,
        aggregated: coreMetadata.THREAD_LIST_METADATA
    },
    // The release door (issue 0027). Declared in the same 'threads' activation group,
    // so it belongs in this matrix as soon as the manifest carries it — the manifest
    // regeneration is what made the `aggregated` half resolvable at all.
    {
        wireName: 'threadDelete',
        sourcePath: '../tools/runtime/threadDelete.tool.ts',
        metadata: threadDeleteEntry.THREAD_DELETE_METADATA,
        moduleMetadata: threadDeleteEntry.metadata,
        aggregated: coreMetadata.THREAD_DELETE_METADATA
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
        key: 'syntax',
        metadataName: 'SYNTAX_METADATA',
        sourcePath: '../tools/syntax/syntax.tool.ts',
        metadata: syntaxEntry.SYNTAX_METADATA,
        tool: syntaxEntry.syntax
    },
    {
        key: 'read',
        metadataName: 'FILE_READ_METADATA',
        sourcePath: '../tools/files/read.tool.ts',
        metadata: fileReadEntry.FILE_READ_METADATA,
        tool: fileReadEntry.read
    },
    {
        // Renamed from `fileWrite`; the metadata constant follows the new wire name.
        key: 'write',
        metadataName: 'WRITE_METADATA',
        sourcePath: '../tools/files/write.tool.ts',
        metadata: writeEntry.WRITE_METADATA,
        tool: writeEntry.write
    },
    {
        key: 'edit',
        metadataName: 'FILE_EDIT_METADATA',
        sourcePath: '../tools/files/edit.tool.ts',
        metadata: fileEditEntry.FILE_EDIT_METADATA,
        tool: fileEditEntry.edit
    },
    {
        key: 'files',
        metadataName: 'FILES_METADATA',
        sourcePath: '../tools/files/files.tool.ts',
        metadata: filesEntry.FILES_METADATA,
        tool: filesEntry.files
    },
    {
        // The two halves of the old `fileGlob`: names here, contents in grep below.
        key: 'glob',
        metadataName: 'GLOB_METADATA',
        sourcePath: '../tools/files/glob.tool.ts',
        metadata: globEntry.GLOB_METADATA,
        tool: globEntry.glob
    },
    {
        key: 'grep',
        metadataName: 'GREP_METADATA',
        sourcePath: '../tools/files/grep.tool.ts',
        metadata: grepEntry.GREP_METADATA,
        tool: grepEntry.grep
    },
    {
        key: 'shell',
        metadataName: 'COMMAND_RUN_METADATA',
        sourcePath: '../tools/command/shell.tool.ts',
        metadata: commandRunEntry.COMMAND_RUN_METADATA,
        tool: commandRunEntry.shell
    },
    {
        key: 'gitDiff',
        metadataName: 'GIT_DIFF_METADATA',
        sourcePath: '../tools/command/gitDiff.tool.ts',
        metadata: gitDiffEntry.GIT_DIFF_METADATA,
        tool: gitDiffEntry.gitDiff
    },
    {
        // R3/R4: byte retrieval with the `toolMedia()` hand-off. Core like the
        // file tools, and the same single-owner metadata literal contract.
        key: 'download',
        metadataName: 'DOWNLOAD_METADATA',
        sourcePath: '../tools/webdownload/download.tool.ts',
        metadata: downloadEntry.DOWNLOAD_METADATA,
        tool: downloadEntry.download
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

    it('keeps delegate metadata literal and pins the inlined bounds', () => {
        // The facade's factory and the entry's factory are different module
        // instances on purpose (the facade must not import a .tool module), so the
        // contract is behavioural equality, not object identity.
        expect(agentDelegateEntry.AGENT_DELEGATE_NAME).toBe('delegate');
        expect(agentDelegateEntry.agentDelegateMetadata().name).toBe('delegate');
        expect(agentDelegateEntry.metadata.name).toBe('delegate');
        // The zero-allowlist form is the entry literal, projected through the facade.
        expect(coreMetadata.AGENT_DELEGATE_NAME).toBe('delegate');
        expect(coreMetadata.agentDelegateMetadata()).toEqual({
            name: 'delegate',
            description: agentDelegateEntry.metadata.description,
            tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
            visibility: 'core',
            parameters: agentDelegateEntry.metadata.parameters
        });
        // The allowlist form is the ONE set-projection function.
        expect(coreMetadata.agentDelegateMetadata(['alpha', 'beta'])).toEqual(
            agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])
        );
        // T28: the allowlist form is DERIVED from the entry's own literal, so this
        // pins the derivation rather than restating the schema by hand. Restating it
        // is what let the catalogue advertise a smaller surface than the runtime every
        // time an argument was added.
        expect(agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])).toEqual({
            name: 'delegate',
            description: expect.stringContaining('Subagents: alpha, beta.'),
            tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    ...(agentDelegateEntry.metadata.parameters.properties as Record<string, unknown>),
                    agent: {
                        type: 'string',
                        enum: ['alpha', 'beta'],
                        description: 'Subagent name, one of the configured allowlist.'
                    }
                },
                required: ['agent', 'input'],
                additionalProperties: false
            }
        });
        // The full argument surface is declared ONCE, in the literal, and both forms
        // carry it.
        expect(Object.keys(agentDelegateEntry.metadata.parameters.properties)).toEqual([
            'agent',
            'input',
            'maxChars',
            'requireClarification',
            'timeoutMs',
            // C1 (2026-11-13): the optional turn cap, declared between the wall clock
            // and `scope` so the two optional bounds sit together.
            'maxTurns',
            'scope'
        ]);
        // The entry annotates the factory with the leaf type through a TYPE-ONLY
        // import of '../core' (erased at transpile, resolves to the LIVE core
        // module), so the captured revision keeps `dependencies: []`.
        expect(sourceOf('../tools/runtime/delegate.tool.ts')).toContain(
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

    it('pins DELEGATE_TIMEOUT_MS by number and keeps the schema prose honest', () => {
        // POLICY DOC T5.6 (2026-11-09). `core/agent-limits.ts` claimed the equality
        // list above pinned this constant, and it did NOT — only the four AGENT_*
        // bounds were in it, so the wall-clock default was specified by prose alone.
        // It is pinned by NUMBER here, which also makes the comment true.
        //
        // The value is `Number.POSITIVE_INFINITY` on purpose: "no limit" is one
        // readable fact rather than an absent fallback, and `delegateFor` arms its
        // timer only when the resolved value is finite (see the source-shape guard in
        // src/harness.delegation.test.ts, policy doc T5.5).
        //
        // The entry cannot value-import this constant — scripts/check-package-tools.mjs
        // requires `dependencies: []` for a runtime entry — so the literal ceiling in
        // its schema is duplicated BY NECESSITY and this pin is the fix. Do not
        // "solve" the duplication with an import.
        expect(DELEGATE_TIMEOUT_MS).toBe(Number.POSITIVE_INFINITY);
        expect(coreMetadata.DELEGATE_TIMEOUT_MS).toBe(DELEGATE_TIMEOUT_MS);

        const timeout = (agentDelegateEntry.metadata.parameters.properties as Record<string, any>)
            .timeoutMs;
        expect([timeout.type, timeout.minimum, timeout.maximum]).toEqual([
            'integer',
            1,
            3600000
        ]);

        // The prose and the runtime agree in both directions: the description names
        // the range the schema enforces, states the unbounded default, points at the
        // recovery, and no longer claims the retired finite default.
        expect(timeout.description).toContain('1-3600000');
        expect(timeout.description).toContain('OMIT IT FOR NO TIME LIMIT');
        expect(timeout.description).toContain('toolCancel');
        expect(timeout.description).not.toContain('Defaults to 300000');

        // The catalogue projection (core/metadata.ts, generated manifest) carries the
        // same row, so the server-facing description cannot lag the live one.
        expect(
            (coreMetadata.agentDelegateMetadata().parameters as Record<string, any>).properties
                .timeoutMs
        ).toEqual(timeout);
        expect(sourceOf('./tool-manifest.ts')).toContain('OMIT IT FOR NO TIME LIMIT');
        expect(sourceOf('./tool-manifest.ts')).not.toContain('Defaults to 300000 (5 minutes)');
    });

    it('pins the model-settable run bounds against the entry literals (B5/C1)', () => {
        // 2026-11-13. Three bounds entered the model-facing surface in this step: the
        // shared wall-clock ceiling, the fork default, and the turn cap. Every entry
        // restates them as LITERALS (a runtime entry keeps zero captured local
        // dependencies and must not value-import ../core — see the header of
        // delegate.tool.ts), so the equality is only real because it is asserted.
        // A drift here means the schema and the runtime disagree about what a caller
        // may ask for, which is exactly the failure class this file exists to catch.
        const delegateProps = agentDelegateEntry.metadata.parameters.properties as Record<
            string,
            any
        >;
        const threadForkProps = threadForkEntry.THREAD_FORK_METADATA.parameters.properties as Record<
            string,
            any
        >;

        // THE SHARED CEILING. `delegate.timeoutMs` and `threadFork.timeoutMs` advertise
        // the same 1-3600000 range, so both literals equal ONE constant.
        expect(MODEL_TIMEOUT_MAX_MS).toBe(3600000);
        expect([
            delegateProps.timeoutMs.type,
            delegateProps.timeoutMs.minimum,
            delegateProps.timeoutMs.maximum
        ]).toEqual(['integer', 1, MODEL_TIMEOUT_MAX_MS]);
        expect([
            threadForkProps.timeoutMs.type,
            threadForkProps.timeoutMs.minimum,
            threadForkProps.timeoutMs.maximum
        ]).toEqual(['integer', 1, MODEL_TIMEOUT_MAX_MS]);

        // THE FORK DEFAULT IS "NO LIMIT", spelled as one constant and restated in the
        // entry's prose. The entry declares NO schema `default` on purpose: an omitted
        // argument must fall through to the harness option (`threadForkTimeoutMs`), not
        // to a number the schema invented — see `resolveForkTimeoutMs` in src/harness.ts.
        expect(FORK_TIMEOUT_MS).toBe(Number.POSITIVE_INFINITY);
        expect(threadForkProps.timeoutMs).not.toHaveProperty('default');
        expect(threadForkProps.timeoutMs.description).toContain('1-3600000');
        expect(threadForkProps.timeoutMs.description).toContain('OMIT IT FOR NO TIME LIMIT');
        // The harness mirrors the same fact as its own literal default.
        expect(sourceOf('../harness.ts')).toContain(
            'const FORK_TIMEOUT_DEFAULT_MS = Number.POSITIVE_INFINITY;'
        );

        // THE TURN CAP. `delegate.maxTurns` may only ever LOWER the harness-wide
        // `maxIterations` bound, and the entry's `64` is the same number.
        expect(DELEGATE_MAX_TURNS_MAX).toBe(64);
        expect([
            delegateProps.maxTurns.type,
            delegateProps.maxTurns.minimum,
            delegateProps.maxTurns.maximum
        ]).toEqual(['integer', 1, DELEGATE_MAX_TURNS_MAX]);
        expect(delegateProps.maxTurns.description).toContain('1-64');

        // The catalogue projection carries the identical rows, so the server-facing
        // schema cannot advertise a smaller surface than the live entry.
        const projected = (coreMetadata.agentDelegateMetadata().parameters as Record<
            string,
            any
        >).properties;
        expect(projected.maxTurns).toEqual(delegateProps.maxTurns);
        expect(projected.timeoutMs).toEqual(delegateProps.timeoutMs);
        expect(sourceOf('./tool-manifest.ts')).toContain('OMIT IT to use the harness-wide limit');
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
        'tasks',
        'search',
        'fetch',
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
            'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example delegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. In a scoped run (a delegation with `scope.tools`), tools outside your run scope are reported under `forbidden` with the allowed list instead of `enabled`: they cannot be enabled or called here, the answer is stable, and requesting one again will not change it - adapt to the allowed tools or report the limitation. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.'
        );
    });
});
