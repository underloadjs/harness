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
// Data-only import of the GENERATED descriptor table — the same table `./metadata.ts`
// projects, one row per package entry. Importing it evaluates no tool body (every row's
// implementation sits behind a dynamic `import()` in the generated loader), and it is
// the authoritative inventory of what `runtimeEntries` plus `unprojectedRuntimeEntries`
// must account for. Read by the coverage guard below.
import { BUILTIN_TOOL_DESCRIPTORS } from './tool-manifest';
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
    // 0032 (2026-11-26): the cap on `toolActivity.byName` (./agent-limits.ts). The engine sorts and
    // slices by this number; the four tool descriptions restate it as the literal `up-to-8`, and the
    // pin below is what keeps the two from drifting apart.
    TOOL_ACTIVITY_NAME_CAP,
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
// C2 (2026-11-26): the cap `threadFork`'s description now states. Imported from the module that
// OWNS it (./result-budget.ts:231), not from the barrel, so the pin below compares the prose
// against the number the delivery gate actually enforces.
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from './result-budget';
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
//
// MEMBERSHIP RULE (stated because the matrix was being read wrongly). A runtime row
// belongs HERE when all three legs of `RuntimeEntry` exist:
//   1. the entry's own metadata literal,
//   2. the same-file `metadata` alias (the identity leg), and
//   3. a NAMED `*_METADATA` projection constant in `core/metadata.ts` (the leg the
//      field is literally called `aggregated` for, and the one that makes a facade
//      projection assertable at all).
// Anything missing leg 3 is listed in `unprojectedRuntimeEntries` below with its reason,
// and the coverage guard ('accounts for every runtime row the generated manifest
// carries') fails if a runtime row from the generated table lands in neither list.
//
// This is NOT "the matrix projects only always-declared rows" — that justification is
// wrong in both directions and should not be repeated: `toolList`, `toolManage`,
// `toolCreate`, `records`, `profiles`, `chapters`, `locations`, `agentManage` and
// `agentResult` are rows here with `alwaysDeclared: false` (see the generated table),
// while the always-declared `search` (240) and `fetch` (250) are not rows here at all.
// Order and activation decide nothing here; the facade projection does.
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

// The runtime rows the generated table carries that CANNOT fill the `RuntimeEntry`
// shape, each with the reason and where its own contract is pinned instead. This list
// exists so an omission is a decision on the record rather than an accident: before it,
// the coverage in this file could stay green while a new runtime entry went uncovered
// (2026-11-19: the `sleep` entry, order 145, arrived and nothing here noticed).
//
// Every reason below is the same structural fact with different details — `core/metadata.ts`
// exports NO named `*_METADATA` constant for these names (`grep -n "SEARCH_\|FETCH_\|
// KNOWLEDGE_\|SLEEP_" src/core/metadata.ts` → no matches), so leg 3 of the row shape has
// no source object to deep-equal the entry literal against.
const unprojectedRuntimeEntries: Record<string, string> = {
    // Its metadata has two honest forms (baseline + per-caller `agent` enum), so the
    // facade projects a FACTORY (`coreMetadata.agentDelegateMetadata(targets)`), not a
    // constant. Pinned by the dedicated `keeps delegate metadata literal and pins the
    // inlined bounds` test in this file.
    delegate: 'facade projects a factory (agentDelegateMetadata), not a *_METADATA constant',
    // The always-declared web pair. They reach the facade through the manifest-filtered
    // `coreToolMetadata()` list (`core/metadata.ts:282-286`), never as named constants,
    // and their registration is option-gated (`activation: 'websearch'` / `'webfetch'`).
    // Pinned here by `keeps the always-registered projection in its historical order`.
    search: 'projected only through coreToolMetadata(); no SEARCH_METADATA constant',
    fetch: 'projected only through coreToolMetadata(); no FETCH_METADATA constant',
    // The cross-session knowledge base (order 95). No `KNOWLEDGE_METADATA` projection
    // exists, so the `aggregated` leg has no source. Its model-facing visibility IS
    // pinned, from the live registry, at `src/harness.metadata.test.ts:108` / `:133`;
    // its registration row is pinned by `src/core/tool-discovery.test.ts`.
    knowledge: 'no KNOWLEDGE_METADATA projection; visibility pinned in harness.metadata.test.ts',
    // THE 2026-11-19 ADDITION (order 145). `src/tools/runtime/sleep.tool.ts` exports
    // `metadata` with no historical `SLEEP_METADATA` alias, and the facade exports no
    // `SLEEP_METADATA` either, so legs 1+2 collapse into the same object and leg 3 does
    // not exist — adding a row here would need a new shape, not a new row. Its contract
    // is pinned where the other unprojected rows' are: `visibility: 'searchable'` from
    // `harness().tools` in `src/harness.metadata.test.ts`, the entry bounds in
    // `src/tools/runtime/sleep.test.ts`, and the registration row (`mode: 'sync'`,
    // `order: 145`) in `src/core/tool-discovery.test.ts:130-138` / `:304-312`.
    sleep: 'entry exports only `metadata`; no SLEEP_METADATA projection in core/metadata.ts'
};

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

    it('accounts for every runtime row the generated manifest carries', () => {
        // THE COVERAGE GUARD. The generated table is the authoritative inventory of
        // package-owned runtime entries, so the matrix plus the exclusion map must equal
        // it exactly. A new entry under `src/tools/runtime/` with `group: 'runtime'`
        // therefore FAILS this test until someone decides which list belongs in — the
        // decision is forced at the moment the row appears, which is precisely what did
        // not happen for `sleep` (order 145) when it landed.
        const accountedFor = [
            ...runtimeEntries.map((entry) => entry.wireName),
            ...Object.keys(unprojectedRuntimeEntries)
        ].sort();

        // Sorted so one diff names every missing AND every extra row, and so the
        // comparison is not hostage to scan order.
        const manifestRuntimeRows = BUILTIN_TOOL_DESCRIPTORS.filter(
            (descriptor) => descriptor.group === 'runtime'
        )
            .map((descriptor) => descriptor.name)
            .sort();

        expect(accountedFor).toEqual(manifestRuntimeRows);

        // A name may not be in BOTH lists: the moment `core/metadata.ts` grows a
        // `*_METADATA` constant for an excluded entry, that entry must move into
        // `runtimeEntries` and its reason string here must go. (The equality above
        // already fails on a duplicate; this names the cause.)
        expect(
            runtimeEntries
                .map((entry) => entry.wireName)
                .filter((name) =>
                    Object.prototype.hasOwnProperty.call(unprojectedRuntimeEntries, name)
                )
        ).toEqual([]);

        // The exclusion map is not a dumping ground: every entry in it is a row the
        // table really carries. Without this, a stale reason could outlive the entry.
        for (const name of Object.keys(unprojectedRuntimeEntries)) {
            expect(manifestRuntimeRows).toContain(name);
        }
    });

    it('keeps delegate metadata literal and pins the inlined bounds', () => {
        // The facade's factory and the entry's factory are different module
        // instances on purpose (the facade must not import a .tool module), so the
        // contract is behavioural equality, not object identity.
        expect(agentDelegateEntry.AGENT_DELEGATE_NAME).toBe('delegate');
        expect(agentDelegateEntry.agentDelegateMetadata().name).toBe('delegate');
        expect(agentDelegateEntry.metadata.name).toBe('delegate');
        // The no-targets form is the entry literal, projected through the facade.
        expect(coreMetadata.AGENT_DELEGATE_NAME).toBe('delegate');
        expect(coreMetadata.agentDelegateMetadata()).toEqual({
            name: 'delegate',
            description: agentDelegateEntry.metadata.description,
            tags: ['agents', 'delegate', 'delegation', 'rank', 'team'],
            visibility: 'core',
            parameters: agentDelegateEntry.metadata.parameters
        });
        // The explicit-targets form is the ONE projection function (rank-derived
        // targets come from the caller's rank; this pins the projection shape).
        expect(coreMetadata.agentDelegateMetadata(['alpha', 'beta'])).toEqual(
            agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])
        );
        // T28: the explicit-targets form is DERIVED from the entry's own literal, so this
        // pins the derivation rather than restating the schema by hand. Restating it
        // is what let the catalogue advertise a smaller surface than the runtime every
        // time an argument was added.
        expect(agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta'])).toEqual({
            name: 'delegate',
            description: expect.stringContaining('Agents you may delegate to: alpha, beta.'),
            tags: ['agents', 'delegate', 'delegation', 'rank', 'team'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    ...(agentDelegateEntry.metadata.parameters.properties as Record<string, unknown>),
                    agent: {
                        type: 'string',
                        enum: ['alpha', 'beta'],
                        description: 'Agent name, one of the lower-ranked targets listed above.'
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

    it('pins the tiny-bound warning across the entry, the generated manifest, and the Rust row (B3)', () => {
        // 2026-11-26 (delegate-defects work order, item B3 — the PROSE half only, owner decision).
        // A `timeoutMs` of a few hundred milliseconds is legal and useless at once: `minimum: 1`
        // stays because the package's own suites pass sub-second bounds on purpose
        // (`timeoutMs: 30` in harness.delegation.test.ts / harness.fork.test.ts, and 1-5 ms plugin
        // bounds), so a schema floor would break tests rather than models; and a tiny bound
        // cancels the child before it can answer while STILL minting a child conversation, STILL
        // costing a provider request, and STILL leaving the caller a thread to `threadDelete`.
        // The owner chose wording over auto-release, so no behaviour changed and the fix is the
        // sentence below, which names the cost and the release door.
        //
        // It is pinned in the RAW SOURCES, not only in the live object, because the failure class
        // is a text copy that lagged: the entry literal -> `core/tool-manifest.ts` (regenerated by
        // `yarn tools:manifest`, byte-pinned by ./tool-discovery.test.ts) -> the hand-mirrored Rust
        // row in packages/typecrate/harness/src/tools/catalogue.rs, which no `cargo` run verifies.
        // The allowlist form in ./metadata.ts COPIES this property object instead of restating it,
        // so the projection pins above carry the clause for free (timeoutMs equals the entry row).
        // Template: harness.records.test.ts:761-770 (same sentence, entry AND generated manifest).
        const TINY_BOUND =
            'A bound below roughly 1000 ms will almost always cancel the child before it can answer, and that cancellation still mints a child conversation and still costs a provider request, so the cancelled child leaves you a thread to release with threadDelete: omit the bound rather than setting a tiny one.';

        // The declaration a model reads (the catalogue/no-targets form; the per-caller form is
        // the same property object, asserted by the projection pins in this file).
        const timeout = (agentDelegateEntry.metadata.parameters.properties as Record<string, any>)
            .timeoutMs;
        expect(timeout.description).toContain(TINY_BOUND);

        // The three text copies, byte-for-byte.
        expect(sourceOf('../tools/runtime/delegate.tool.ts')).toContain(TINY_BOUND);
        expect(sourceOf('./tool-manifest.ts')).toContain(TINY_BOUND);
        expect(sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs')).toContain(
            TINY_BOUND
        );

        // AC3: wording only. The floor a suite depends on and the canonical ceiling are untouched,
        // and the sentence sits AFTER the ordered policy prose the test above pins (default, range,
        // `cancelled` envelope, `toolCancel`), so that order still reads in sequence.
        expect([timeout.minimum, timeout.maximum]).toEqual([1, MODEL_TIMEOUT_MAX_MS]);
        expect(timeout.description.indexOf('OMIT IT FOR NO TIME LIMIT')).toBeLessThan(
            timeout.description.indexOf(TINY_BOUND)
        );
    });

    it('pins the offset-clamp contract across the entry, the generated manifest, and the Rust row (B1)', () => {
        // 2026-11-26 (delegate-defects work order, item B1 follow-through). The clamp itself
        // shipped in `agentResultFor`, in the note builder `agentResultClampNote` (./harness.ts —
        // cited BY SYMBOL, because a line number here is stale the moment this file's own edits shift it)
        // and is pinned behaviourally in src/harness.agent-results.test.ts; what was missing was
        // DISCOVERABILITY — nothing in the tool surface told a caller that overshooting answers
        // with the END of the result plus `offsetClamped`/`note` instead of an empty page.
        //
        // The wording lives on the `offset` PARAMETER, and that placement is a decision, not an
        // accident: this entry is `visibility: 'searchable'` and `./discovery.ts:138` scores a
        // needle against name, tags and DESCRIPTION only (never `parameters`), while
        // src/server/api.test.ts pins the scripted discovery round verbatim and the header of
        // ../tools/runtime/agentResult.tool.ts:78-89 bans the substring `time` from that
        // description for that reason. Prose on the parameter therefore reaches the model that
        // needs it without moving a ranked shortlist. The `not.toContain` below keeps the
        // placement pinned, and the `time` check keeps the sentence safe if it is ever moved.
        const CLAMP =
            '0-based character offset into the result. Defaults to 0; use nextOffset from the previous page. An offset past the end is clamped to it and reported as "offsetClamped" with a "note" naming where the page really starts, so overshooting reads as the end of the result rather than as an empty answer; an offset exactly at "contentLength" is the empty tail it looks like and carries no flag.';

        const offset = (agentResultEntry.AGENT_RESULT_METADATA.parameters as any).properties.offset;
        expect(offset.description).toBe(CLAMP);
        expect(agentResultEntry.AGENT_RESULT_METADATA.description).not.toContain(CLAMP);
        expect(CLAMP).not.toContain('time');

        // THE THREE TEXT COPIES, byte-for-byte. Same chain B3's pin walks: entry literal ->
        // `core/tool-manifest.ts` (`yarn tools:manifest`, byte-pinned by ./tool-discovery.test.ts)
        // -> the hand-mirrored Rust row, which no `cargo` run verifies. The Rust row is a JSON
        // string inside an `r#"…"#` literal, so its embedded quotes arrive escaped.
        expect(sourceOf('../tools/runtime/agentResult.tool.ts')).toContain(CLAMP);
        expect(sourceOf('./tool-manifest.ts')).toContain(CLAMP.replace(/"/g, '\\"'));
        expect(
            sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs')
        ).toContain(CLAMP.replace(/"/g, '\\"'));

        // The clamp is a read of the SAME index the schema documents: `minimum` stays 0, and the
        // page bound the neighbouring pins own is untouched, so this is prose over behaviour that
        // already shipped — not a new contract.
        expect([offset.type, offset.minimum]).toEqual(['integer', 0]);
    });

    it('names the tool-activity tally and states its cap in every form of both descriptions (0032 AC7)', () => {
        // 2026-11-26 (delegate-defects work order, item B4 / issue 0032 AC7). `toolActivity` is a
        // field a caller can only use if the tool surface tells it the field exists, what the
        // numbers mean and where the list stops. FOUR description forms carry that prose, and they
        // are not one string: the catalogue literal, the no-targets projection, the allowlist
        // projection (the form a delegating agent actually reads) and `agentResult`'s entry. The
        // allowlist wording exists TWICE in the source (../tools/runtime/delegate.tool.ts and
        // ./metadata.ts, which may not import each other) — the equality between those two
        // projections is pinned by the pair of tests above, so this pin only has to hold the
        // CONTRACT half: every form names the key and states the bound.
        //
        // WHY THE CAP IS ASSERTED THROUGH THE CONSTANT AND NOT AS A SECOND LITERAL: the
        // description says "up-to-8" because `TOOL_ACTIVITY_NAME_CAP` is 8 (./agent-limits.ts:52).
        // Raising the constant without touching the prose fails HERE, which is the whole point —
        // a silent off-by-one between an engine bound and the number a model is told is the exact
        // failure class this file exists to catch (see the `DELEGATE_TIMEOUT_MS` and
        // `MODEL_TIMEOUT_MAX_MS` pins above for the same shape).
        expect(TOOL_ACTIVITY_NAME_CAP).toBe(8);

        const BOUND = `up-to-${TOOL_ACTIVITY_NAME_CAP}`;

        const forms: [string, string][] = [
            [
                'delegate (catalogue literal)',
                (agentDelegateEntry.metadata as { description: string }).description
            ],
            [
                'delegate (no delegable targets)',
                agentDelegateEntry.agentDelegateMetadata().description
            ],
            [
                'delegate (allowlist, the live declaration)',
                agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta']).description
            ],
            ['agentResult', agentResultEntry.AGENT_RESULT_METADATA.description]
        ];

        for (const [label, description] of forms) {
            // [form, names the key, states the cap, states that `truncated` is the CAP speaking,
            // states that the key can be absent] — one exact row per form, so a form that loses
            // half a sentence shows up by name instead of as a boolean nobody reads.
            expect([
                label,
                description.includes('toolActivity'),
                description.includes(BOUND),
                // `truncated` is the field that could be misread as "the run was cut here", so the
                // prose has to disclaim it wherever the key is named.
                description.includes('truncated'),
                description.includes('ABSENT') || description.includes('absent')
            ]).toEqual([label, true, true, true, true]);
        }

        // THE MIRRORED COPIES. The manifest row is generated from the entry literals
        // (`yarn tools:manifest`, byte-pinned by ./tool-discovery.test.ts) and the Rust row is
        // hand-mirrored with no `cargo` run to verify it — the same two-hop chain the B1 pin above
        // walks, so the same guard applies here: a description edit that skips a mirror fails.
        // Both mirrored files hold the description as an escaped JSON string, so the checks target
        // un-quoted fragments (`toolActivity`, `up-to-8`) plus the one escaped-quoted form.
        expect(sourceOf('../tools/runtime/delegate.tool.ts')).toContain(BOUND);
        expect(sourceOf('./metadata.ts')).toContain(BOUND);
        expect(sourceOf('./tool-manifest.ts')).toContain(BOUND);
        expect(sourceOf('./tool-manifest.ts')).toContain('toolActivity');
        expect(sourceOf('./tool-manifest.ts')).toContain('toolActivity\\"');
        expect(sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs')).toContain(BOUND);
        expect(sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs')).toContain(
            'toolActivity'
        );
    });

    it('pins the queued-sibling placeholder sentence in both allowlist copies and nowhere in the catalogue chain (B5)', () => {
        // 2026-11-26 (delegate-defects work order, item B5 — PROSE ONLY; the runtime is unchanged and
        // honest, and ./harness.delegation.test.ts
        // (`gives the started child both ids and the queued sibling neither…`) is the runtime half).
        //
        // WHY RAW SOURCE AND NOT ONLY THE LIVE OBJECT: the failure class here is a TEXT COPY that
        // lagged, and this paragraph lives in exactly two files — the entry factory
        // (../tools/runtime/delegate.tool.ts) and its hand-duplicated twin here (./metadata.ts), which
        // may not import each other. The live equality between those two projections is already pinned
        // above (`coreMetadata.agentDelegateMetadata(['alpha','beta'])` equals the entry's), so what
        // this pin adds is the byte-for-byte file check, which is the half a partial edit breaks.
        const QUEUED =
            'The two ids appear once the child has started: while it runs, agentResult pages it by invocationId and threadRead / threadSend address it by threadId. They are ABSENT while the call is still queued behind sibling delegations, which is not the same as never starting, so wait for the real envelope or abandon it with toolCancel on this callId.';

        // THE CLAIM THAT WAS FALSE, in its exact old wording. The ids are not absent only when "the
        // child never started", and their absence is not proof of "no run": two `delegate` calls to ONE
        // agent in one assistant message serialize, so the QUEUED sibling's child run has not begun
        // (that is why `delegatedRecordOf` in ../harness.ts has no record to project) — yet that call
        // DOES become a run, and its terminal envelope carries a real `invocationId`/`threadId`. The two
        // causes the old wording named are both wrong routes as well: a pre-dispatch refusal settles as
        // an error result and never reaches a pending projection, and `pruneInvocationRecords` skips a
        // `running` child, so eviction cannot drop an in-flight id.
        const REFUTED =
            'and both are ABSENT when the child never started, so a missing id means no run, not an unknown one';

        for (const copy of ['../tools/runtime/delegate.tool.ts', './metadata.ts']) {
            const source = sourceOf(copy);

            // [file, carries the corrected sentence, still carries the refuted one] — named rows, so a
            // copy that drifted says WHICH one instead of turning into a bare boolean.
            expect([copy, source.includes(QUEUED), source.includes(REFUTED)]).toEqual([copy, true, false]);
        }

        // Both LIVE projections too: the factory form a delegating agent actually reads.
        expect([
            agentDelegateEntry.agentDelegateMetadata(['alpha', 'beta']).description.includes(QUEUED),
            coreMetadata.agentDelegateMetadata(['alpha', 'beta']).description.includes(QUEUED)
        ]).toEqual([true, true]);

        // THE MIRROR QUESTION, answered from the files rather than from memory. The generated manifest
        // and the hand-mirrored Rust row are projections of the NO-TARGETS literal, and that literal has
        // no DELIVERY paragraph at all — so B5 is a two-file change, and the four-copy chain the header
        // of ../tools/runtime/delegate.tool.ts describes simply does not carry this sentence. Pinned
        // both ways: the refuted wording is absent from the mirrors, and the paragraph they would carry
        // it in is absent too, so a future mirror that DOES grow a DELIVERY paragraph fails HERE rather
        // than drifting one edit behind.
        const manifest = sourceOf('./tool-manifest.ts');
        const rust = sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs');

        expect([manifest.includes(REFUTED), rust.includes(REFUTED)]).toEqual([false, false]);
        expect([manifest.includes('DELIVERY:'), rust.includes('DELIVERY:')]).toEqual([false, false]);
    });

    it('names the abandoned-call tally in toolCancel\'s enumeration, in every copy of that row (F1 / 0032 AC7)', () => {
        // 2026-11-26 (independent audit of the 0032 pass, finding F1). `toolCancel`'s description
        // promises the caller that abandoning a live `delegate` call still delivers that call's terminal
        // envelope, and then ENUMERATES it — with three forensic fields while the shipped envelope
        // carries four. The tally really does ride that door (./harness.delegation.test.ts pins
        // `toolActivity: {calls: 1, settled: 0, …}` on an abandoned call), and `delegate`'s own abandon
        // sentence already lists all four, so this row was the one under-enumerating. 0032 AC7 is the
        // rule that closes it: a description names the field and the bound it stops at.
        const ENUMERATION =
            'carrying `status`, any `partialContent`/`cancelledAtMessage`/`toolActivity` (the up-to-8 name tally the `delegate` row describes), and `callCancelled: true`';

        // THE CAP IS ASSERTED THROUGH THE CONSTANT, exactly as the 0032 AC7 pin above does it: this row
        // states `up-to-8` because `TOOL_ACTIVITY_NAME_CAP` is 8 (./agent-limits.ts), and raising the
        // constant without touching the prose fails here.
        expect([TOOL_ACTIVITY_NAME_CAP, ENUMERATION.includes(`up-to-${TOOL_ACTIVITY_NAME_CAP}`)]).toEqual([
            8,
            true
        ]);

        // The live rows: the entry, and the compatibility projection the server catalogue reads.
        expect([
            (toolCancelEntry.TOOL_CANCEL_METADATA as { description: string }).description.includes(
                ENUMERATION
            ),
            (coreMetadata.TOOL_CANCEL_METADATA as { description: string }).description.includes(
                ENUMERATION
            )
        ]).toEqual([true, true]);

        // THE TEXT COPIES. Same two-hop chain the B1/B3 pins walk: the entry literal -> `./tool-manifest.ts`
        // (regenerated by `yarn tools:manifest`, byte-pinned by ./tool-discovery.test.ts) -> the
        // hand-mirrored Rust row no `cargo` run verifies. This sentence adds no quote and no backslash,
        // so it reaches both files unescaped and needs no `.replace(/"/g, '\\"')` like B1's does.
        const cancelSource = sourceOf('../tools/runtime/toolCancel.tool.ts');
        const manifestSource = sourceOf('./tool-manifest.ts');
        const rustSource = sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs');

        expect([
            cancelSource.includes(ENUMERATION),
            manifestSource.includes(ENUMERATION),
            rustSource.includes(ENUMERATION)
        ]).toEqual([true, true, true]);

        // AND THE THREE-FIELD FORM IS GONE FROM EVERY COPY. Checked as its own string, because a copy
        // that only half-updated would satisfy the check above (it would still contain the four-field
        // text somewhere else in the same file) while the row the model reads stayed short.
        const THREE_FIELDS = 'any `partialContent`/`cancelledAtMessage`, and `callCancelled: true`';

        expect([
            cancelSource.includes(THREE_FIELDS),
            manifestSource.includes(THREE_FIELDS),
            rustSource.includes(THREE_FIELDS)
        ]).toEqual([false, false, false]);
    });

    it('states the delivery cap a fork answer has to fit, in every copy of that row (C2)', () => {
        // 2026-11-26 (delegate-defects work order, finding C2). A `threadFork` answer carries NO
        // bound of its own — `HarnessForkResult` is `{ branchId, threadId, content }` with no
        // `maxChars` next to it (../types/index.ts), unlike `delegate`'s 8,000-char page or
        // `agentResult`'s 4,000 one — so the only limit it ever meets is the harness-wide
        // per-result delivery cap, and the row used to say nothing about it. The accepted probe:
        // a 40,000-char summary serialized to 40,058 bytes, refused WHOLE, with the id the model
        // still held quoted as an instruction to "re-run with narrower arguments".
        //
        // WHY THE NUMBER IS ASSERTED THROUGH THE CONSTANT. The entry restates `32768` as a literal
        // because a runtime entry may not VALUE-import ../core (the cycle rule in this file's
        // header and in ../tools/runtime/threadFork.tool.ts), so the equality lives HERE: the
        // sentence a model reads states `MODEL_TOOL_RESULT_BUDGET_BYTES` (./result-budget.ts:231),
        // and raising that constant without touching the prose fails this case — the same shape as
        // the `TOOL_ACTIVITY_NAME_CAP` and `MODEL_TIMEOUT_MAX_MS` pins in this file.
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(32_768);

        // THE THREE SENTENCES, byte for byte, in the order the entry states them: the cap, what an
        // over-cap answer costs, and the ONLY lever the caller owns. `threadFork`'s real schema
        // takes `input`, `label` and `timeoutMs` (`additionalProperties: false`), which is why the
        // third sentence names the length asked for rather than an argument that does not exist.
        const CAP = `The summary must fit the shared per-result delivery cap (${MODEL_TOOL_RESULT_BUDGET_BYTES} bytes of the serialized result).`;
        const REFUSED =
            'An over-cap answer is refused WHOLE - the call reaches you as a failed result naming the branch, ' +
            'with none of the summary delivered - while the branch record keeps it in full and stays pageable ' +
            'by that branch id through agentResult.';
        const LEVER =
            '`threadFork` takes no length argument, so your only lever is the length you ask the fork for in `input`.';

        // THE TWO LIVE FORMS: the entry literal, and the projection the server catalogue reads.
        expect([
            (threadForkEntry.THREAD_FORK_METADATA as { description: string }).description.includes(CAP),
            (threadForkEntry.THREAD_FORK_METADATA as { description: string }).description.includes(REFUSED),
            (threadForkEntry.THREAD_FORK_METADATA as { description: string }).description.includes(LEVER),
            (coreMetadata.THREAD_FORK_METADATA as { description: string }).description.includes(CAP),
            (coreMetadata.THREAD_FORK_METADATA as { description: string }).description.includes(REFUSED),
            (coreMetadata.THREAD_FORK_METADATA as { description: string }).description.includes(LEVER)
        ]).toEqual([true, true, true, true, true, true]);

        // THE TEXT COPIES, same chain the B1/B3/0032 pins walk: entry literal -> `./tool-manifest.ts`
        // (regenerated by `yarn tools:manifest`, byte-pinned by ./tool-discovery.test.ts) -> the
        // hand-mirrored Rust row no `cargo` run verifies. The added prose carries no `"` and no `\`,
        // so it reaches both files unescaped and needs no `.replace(/"/g, '\\"')`.
        const copies = [
            sourceOf('../tools/runtime/threadFork.tool.ts'),
            sourceOf('./tool-manifest.ts'),
            sourceOf('../../../../../typecrate/harness/src/tools/catalogue.rs')
        ];

        for (const copy of copies) {
            expect([copy.includes(CAP), copy.includes(REFUSED), copy.includes(LEVER)]).toEqual([true, true, true]);
        }

        // AND THE SCHEMA STILL OFFERS NO LENGTH: the sentence above is only honest while these are
        // the three properties, so the claim "takes no length argument" is pinned against the
        // schema rather than against memory.
        const properties = (threadForkEntry.THREAD_FORK_METADATA.parameters as any).properties;

        expect(Object.keys(properties)).toEqual(['input', 'label', 'timeoutMs']);
        expect((threadForkEntry.THREAD_FORK_METADATA.parameters as any).additionalProperties).toBe(false);
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
            'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example delegate when you have a strictly lower-ranked agent to hand work to; a capability that appears in neither list is genuinely unavailable. A tool the user of THIS conversation has switched off is not listed here at all - not in `enabled`, `tools`, `alreadyAvailable`, or `forbidden` - so no query can find or re-enable it. In a scoped run (a delegation with `scope.tools`), tools outside your run scope are reported under `forbidden` with the allowed list instead of `enabled`: they cannot be enabled or called here, the answer is stable, and requesting one again will not change it - adapt to the allowed tools or report the limitation. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.'
        );
    });
});
