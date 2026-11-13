// The generated plugin manifest and its scanner (scripts/plugin-manifest-scan.ts,
// scripts/plugin-manifest-render.ts, src/plugin/manifest.ts).
//
// WHY THIS TEST EXISTS
// --------------------
// Auto-discovery is only trustworthy if the COMMITTED manifest is the current scan
// result. `npm test` already runs `plugins:manifest:check`, but that is a subprocess
// outside the suite; this file asserts the same equality in-process (parity), and then
// proves the two halves of the contract the requirement asks for:
//
//   - a NEW `*.plugin.ts` really is discovered (fixture scan, no src/ writes, so a
//     concurrent workstream adding a plugin can never make this test flaky);
//   - the scan REJECTS the shapes that would silently produce a bad manifest.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, BUILTIN_PLUGIN_DESCRIPTORS } from './manifest';
// The prompt constant, for the ONE string in the compaction entry below that is not a
// hand copy: `metadata.systemPrompt` duplicates it (the constant is declared after
// `metadata`, so the literal cannot reference it), and context-compaction.test.ts pins
// those two as identical, so this file asserts the third leg — the manifest carries that
// same prompt — without adding a fourth copy of the prose.
import { COMPACTION_INSTRUCTION } from '../plugins/context-compaction.plugin';
import { discoverPluginEntries, PluginScanError } from '../../scripts/plugin-manifest-scan.ts';
import { renderManifest } from '../../scripts/plugin-manifest-render.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANIFEST_PATH = `${PACKAGE_ROOT}src/plugin/manifest.ts`;
const PLUGIN_ROOT = `${PACKAGE_ROOT}src/plugins`;
// Repo-root scratch (git-ignored), per the repository's scratch-space rule. Five levels
// up from src/plugin/.
const FIXTURE_ROOT = fileURLToPath(new URL('../../../../../Temp/T2/manifest-fixtures', import.meta.url));

// One valid plugin file body, parameterised only by the two fields the scan reads.
const pluginFile = (name: string, title: string): string => `import type {
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata
} from '../../types';

export const metadata = {
    name: '${name}',
    title: '${title}',
    builtin: true
} satisfies HarnessPluginMetadata;

export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    void api;
};
`;

// Fresh fixture directory per case: a scan must never see a previous case's files.
const fixture = (label: string, files: Record<string, string>): string => {
    const root = `${FIXTURE_ROOT}/${label}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    for (const [name, text] of Object.entries(files)) {
        const target = `${root}/${name}`;

        if (name.includes('/')) {
            mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
        }

        writeFileSync(target, text, 'utf8');
    }

    return root;
};

describe('plugin manifest parity', () => {
    it('the committed manifest is exactly what the scanner plus renderer produce today', () => {
        // The same two pure modules the CLI uses, run here. A stale manifest fails this
        // test with a diff of the two texts rather than as a mysterious runtime gap.
        const entries = discoverPluginEntries({ pluginsRoot: PLUGIN_ROOT });
        const rendered = renderManifest(entries);

        expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(rendered);
    });

    it('the generated wiring and the descriptors are the same plugin set, in the same order', () => {
        expect(BUILTIN_PLUGINS.map((plugin) => plugin.name)).toEqual(
            BUILTIN_PLUGIN_DESCRIPTORS.map((descriptor) => descriptor.name)
        );

        // Every runnable entry is the descriptor itself (identity, not a copy), so the UI
        // and the loader cannot disagree about what a plugin declared.
        BUILTIN_PLUGINS.forEach((plugin, index) => {
            expect(plugin.metadata).toBe(BUILTIN_PLUGIN_DESCRIPTORS[index]);
            expect(typeof plugin.setup).toBe('function');
        });
    });

    it('ships the three preset plugins with their declared settings', () => {
        // Exact catalogue. A new `src/plugins/*.plugin.ts` changes this list ON PURPOSE,
        // which is the point: adding a preset is a visible, reviewed edit.
        expect(BUILTIN_PLUGIN_DESCRIPTORS).toEqual([
            // Scan order is path-ascending: async-ping, context-compaction, context-trimmer.
            // Every string below is copied from the plugin's own `metadata` export, because
            // the plugin file is the single owner of its description (see the header memo).
            {
                name: 'async-ping',
                title: 'Background Ping',
                description: 'Keeps a conversation waiting on background tool work moving by emitting a periodic ping with the calls that are still running, replacing the fixed scheduler heartbeat.',
                version: '1.0.0',
                tags: ['background', 'async', 'lifecycle'],
                builtin: true,
                hooks: ['async.pending', 'async.drained', 'run.failed', 'thread.stopped', 'thread.deleted', 'harness.dispose'],
                settings: [
                    {
                        key: 'intervalMs',
                        label: 'Ping interval (ms)',
                        type: 'number',
                        default: 600000,
                        min: 1000,
                        step: 1000,
                        description: 'How often a still-running background tool is reported while work is pending. Defaults to the historical 10-minute wake.'
                    }
                ]
            },
            {
                name: 'context-compaction',
                title: 'Context Compaction',
                description: 'Compacts the thread context when the conversation reaches a configured token threshold.',
                // The read-only prompt the details panel shows (2026-11-12). Its presence in
                // the GENERATED wiring is the point: the panel reads it off the descriptor the
                // server hands the UI, so a manifest that dropped the field would silently
                // drop the section.
                systemPrompt: COMPACTION_INSTRUCTION,
                version: '1.0.0',
                tags: ['context', 'compaction', 'lifecycle'],
                builtin: true,
                hooks: ['turn.before', 'turn.after', 'thread.idle', 'run.finished', 'run.failed'],
                settings: [
                    {
                        key: 'contextLimit',
                        label: 'Context limit (tokens)',
                        type: 'number',
                        default: 200000,
                        min: 1000,
                        step: 1000
                    },
                    {
                        key: 'modelLimits',
                        label: 'Per-model limits (JSON)',
                        type: 'string',
                        default: '{}'
                    },
                    {
                        key: 'enabled',
                        label: 'Compact conversations',
                        type: 'boolean',
                        default: true
                    },
                    {
                        key: 'minTokens',
                        label: 'Minimum saving per pass (tokens)',
                        type: 'number',
                        default: 200,
                        min: 0,
                        step: 50
                    },
                    {
                        key: 'safetyTurns',
                        label: 'Recent units to protect',
                        type: 'number',
                        default: 6,
                        min: 0,
                        step: 1
                    },
                    {
                        key: 'mode',
                        label: 'Compaction mode',
                        type: 'string',
                        default: 'summarize'
                    }
                ]
            },
            {
                // FIX 1 (2026-11-13) cut the trimmer's published copy down to compaction's size:
                // one 83-character sentence and NINE hints out of seventeen rows. The eight rows that
                // are self-evident from their label plus `min`/`max` declare no `description` at all,
                // so the renderer emits no hint line for them — hence no key here, not an empty string.
                name: 'context-trimmer',
                title: 'Context Trimmer',
                description: 'Withholds superseded tool units, stale tool requests and thinking; deletes nothing.',
                version: '1.0.0',
                tags: ['context', 'trimming', 'lifecycle'],
                builtin: true,
                hooks: ['turn.before'],
                settings: [
                    {
                        key: 'enabled',
                        label: 'Context trimming',
                        type: 'boolean',
                        default: true,
                        description:
                            'Turns each policy off from the next turn; entries already withheld stay out.'
                    },
                    // The 2026-11-13 grouping (R1/R2): `group` files a row under a named category
                    // and `parentKey` nests it under the boolean that reveals it. Display-only
                    // metadata, and it is part of the descriptor the manifest carries verbatim, so
                    // the GENERATED wiring's shape changes with it — hence it is pinned here as part
                    // of the exact catalogue (see the parity case above for the byte-identical file).
                    {
                        key: 'trimInvalidTools',
                        group: { id: 'invalid-tools', title: 'Invalid Tools' },
                        label: 'Automatic Trim Invalid Tools',
                        type: 'boolean',
                        default: true,
                        description:
                            'Trims nothing until a later included completed call answers every tool name it called.'
                    },
                    {
                        key: 'invalidToolTurns',
                        group: { id: 'invalid-tools', title: 'Invalid Tools' },
                        parentKey: 'trimInvalidTools',
                        label: 'Invalid tools · trim after (tool turns)',
                        type: 'number',
                        default: 2,
                        min: 0,
                        max: 4096,
                        step: 1,
                        description:
                            'Protects the newest N tool turns; 0 protects none.'
                    },
                    {
                        key: 'invalidOutcomes',
                        group: { id: 'invalid-tools', title: 'Invalid Tools' },
                        parentKey: 'trimInvalidTools',
                        label: 'Outcomes that count as invalid',
                        type: 'string',
                        default: 'failed,rejected',
                        description:
                            'Comma-separated subset of failed, rejected, cancelled, empty; empty means a blank result.'
                    },
                    {
                        key: 'trimThoughts',
                        group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
                        label: 'Automatic Trim Thoughts',
                        type: 'boolean',
                        default: true
                    },
                    {
                        key: 'thoughtTurns',
                        group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
                        parentKey: 'trimThoughts',
                        label: 'Thoughts · trim after (thoughts)',
                        type: 'number',
                        default: 2,
                        min: 0,
                        max: 4096,
                        step: 1
                    },
                    // Filed with the thinking rule it gates, not with the economy knobs.
                    {
                        key: 'minThoughtChars',
                        group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
                        parentKey: 'trimThoughts',
                        label: 'Minimum thinking saved per pass (characters)',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 1000000,
                        step: 50
                    },
                    {
                        key: 'dropSupersededToolCalls',
                        group: { id: 'superseded-tools', title: 'Superseded Tools' },
                        label: 'Automatic Trim Superseded Tools',
                        type: 'boolean',
                        default: true
                    },
                    {
                        key: 'supersededTurns',
                        group: { id: 'superseded-tools', title: 'Superseded Tools' },
                        parentKey: 'dropSupersededToolCalls',
                        label: 'Superseded tools · trim after (tool turns)',
                        type: 'number',
                        default: 2,
                        min: 0,
                        max: 4096,
                        step: 1
                    },
                    {
                        key: 'supersedeMatch',
                        group: { id: 'superseded-tools', title: 'Superseded Tools' },
                        parentKey: 'dropSupersededToolCalls',
                        label: 'Supersession match',
                        type: 'string',
                        default: 'name',
                        description:
                            "'name' matches any later call of the tool; 'fingerprint' needs identical arguments."
                    },
                    {
                        key: 'dropDuplicateCalls',
                        group: { id: 'duplicate-tools', title: 'Duplicate Tools' },
                        label: 'Automatic Trim Duplicate Tools',
                        type: 'boolean',
                        default: false,
                        description:
                            'Needs an exact re-run with identical arguments; supersedeMatch does not widen it.'
                    },
                    {
                        key: 'duplicateTurns',
                        group: { id: 'duplicate-tools', title: 'Duplicate Tools' },
                        parentKey: 'dropDuplicateCalls',
                        label: 'Duplicate tools · trim after (tool turns)',
                        type: 'number',
                        default: 2,
                        min: 0,
                        max: 4096,
                        step: 1
                    },
                    {
                        key: 'truncateToolRequests',
                        group: { id: 'tool-requests', title: 'Tool Requests' },
                        label: 'Automatic Truncate Tool Requests',
                        type: 'boolean',
                        default: false,
                        description:
                            'Drops the request entry only; its tool results stay in the request.'
                    },
                    {
                        key: 'truncateTurns',
                        group: { id: 'tool-requests', title: 'Tool Requests' },
                        parentKey: 'truncateToolRequests',
                        label: 'Truncate tool requests after (tool turns)',
                        type: 'number',
                        default: 2,
                        min: 0,
                        max: 4096,
                        step: 1
                    },
                    // The three knobs that gate no policy of their own: a group, no parent.
                    {
                        key: 'minTokens',
                        group: { id: 'global-limits', title: 'Global Limits' },
                        label: 'Minimum saving per pass (tokens)',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 1000000,
                        step: 50,
                        description:
                            'Each tool axis must save this many tokens, or it writes nothing; thinking is never gated.'
                    },
                    {
                        key: 'safetyUnits',
                        group: { id: 'global-limits', title: 'Global Limits' },
                        label: 'Recent units to protect',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 4096,
                        step: 1
                    },
                    {
                        key: 'maxUnits',
                        group: { id: 'global-limits', title: 'Global Limits' },
                        label: 'Maximum units per pass',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 4096,
                        step: 1,
                        description:
                            'Tool units one axis may withhold per pass; 0 is unbounded, not disabled.'
                    }
                ]
            }
        ]);
    });
});

describe('plugin discovery', () => {
    it('finds a new plugin file, including one in a subfolder, in path order', () => {
        const root = fixture('discovery', {
            'b-second.plugin.ts': pluginFile('b-second', 'Second'),
            'a-first.plugin.ts': pluginFile('a-first', 'First'),
            // A nested package still resolves: the import path carries the folder.
            'nested/c-third.plugin.ts': pluginFile('c-third', 'Third'),
            // Not a plugin entry, so invisible to the scan.
            'helpers.ts': 'export const helper = 1;',
            'README.md': '# notes'
        });

        expect(discoverPluginEntries({ pluginsRoot: root, manifestRelative: '../fixtures' })).toEqual([
            {
                relativePath: 'a-first.plugin.ts',
                name: 'a-first',
                importPath: '../fixtures/a-first.plugin',
                identifier: 'aFirst'
            },
            {
                relativePath: 'b-second.plugin.ts',
                name: 'b-second',
                importPath: '../fixtures/b-second.plugin',
                identifier: 'bSecond'
            },
            {
                relativePath: 'nested/c-third.plugin.ts',
                name: 'c-third',
                importPath: '../fixtures/nested/c-third.plugin',
                identifier: 'nestedCThird'
            }
        ]);

        // And the render really emits it, which is what makes "add a file, get a plugin"
        // true rather than a hope.
        const rendered = renderManifest(
            discoverPluginEntries({ pluginsRoot: root, manifestRelative: '../fixtures' })
        );
        expect(rendered).toContain(
            "import { metadata as aFirstMetadata, setup as aFirstSetup } from '../fixtures/a-first.plugin';"
        );
        expect(rendered).toContain('    aFirstMetadata');
        expect(rendered).toContain('        name: aFirstMetadata.name,');

        rmSync(root, { recursive: true, force: true });
    });

    it('rejects a metadata export that is not a literal, a bad name, a duplicate, and a missing setup', () => {
        const notLiteral = fixture('not-literal', {
            'loose.plugin.ts': 'export const metadata = compute();\nexport const setup = () => {};'
        });
        expect(() => discoverPluginEntries({ pluginsRoot: notLiteral })).toThrow(PluginScanError);
        expect(() => discoverPluginEntries({ pluginsRoot: notLiteral })).toThrow(
            'loose.plugin.ts: must export `metadata` as an object literal.'
        );

        const badName = fixture('bad-name', { 'upper.plugin.ts': pluginFile('Upper Case', 'Upper') });
        expect(() => discoverPluginEntries({ pluginsRoot: badName })).toThrow(
            'upper.plugin.ts: plugin name "Upper Case" must match /^[a-z][a-z0-9_-]*$/.'
        );

        const duplicate = fixture('duplicate', {
            'one.plugin.ts': pluginFile('dup', 'One'),
            'two.plugin.ts': pluginFile('dup', 'Two')
        });
        expect(() => discoverPluginEntries({ pluginsRoot: duplicate })).toThrow(
            'two.plugin.ts: plugin name "dup" is already used by one.plugin.ts.'
        );

        const noSetup = fixture('no-setup', {
            'quiet.plugin.ts': "export const metadata = { name: 'quiet', title: 'Quiet' };"
        });
        expect(() => discoverPluginEntries({ pluginsRoot: noSetup })).toThrow(
            'quiet.plugin.ts: must export `setup` as a function.'
        );

        for (const root of [notLiteral, badName, duplicate, noSetup]) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails loudly when the plugins root is missing instead of emitting an empty manifest', () => {
        const absent = `${FIXTURE_ROOT}/does-not-exist`;
        expect(existsSync(absent)).toBe(false);

        expect(() => discoverPluginEntries({ pluginsRoot: absent })).toThrow(
            /plugins root is missing: /
        );
    });
});
