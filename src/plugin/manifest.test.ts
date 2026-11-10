// The generated plugin manifest and its scanner (scripts/plugin-manifest-scan.mjs,
// scripts/plugin-manifest-render.mjs, src/plugin/manifest.ts).
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
import { discoverPluginEntries, PluginScanError } from '../../scripts/plugin-manifest-scan.mjs';
import { renderManifest } from '../../scripts/plugin-manifest-render.mjs';

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
                description: 'Watches each agent conversation against a context limit and, when the limit is reached, compacts the conversation at the turn boundary before the next model request is sent. In the default "summarize" mode the conversation does the work: the thread is parked, an instruction the plugin commits into the transcript is answered by this same agent with a summary of what is done, what it is working on and where it left off, and everything before that instruction (and the turns between it and the answer) stops being sent. The thread resumes with a nudge to continue, and the context is small again: the instruction plus the agent\'s own summary. The older "exclude" mode prunes only the tool units a later success already answered. Neither mode deletes anything: a withheld unit keeps its place in history and can be switched back on. The limit is the firing point: compaction starts as soon as the estimate reaches the effective limit, which is the per-model override for the model the conversation is running, capped by that model\'s declared context window when one is declared.',
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
                        step: 1000,
                        description: 'The firing point: estimated tokens a conversation may reach before this plugin compacts it, measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost. There is no separate headroom: the estimate at or above this number fires the pass on that turn. It is this value unless modelLimits overrides it for the model this conversation runs, or caps it at that model\'s declared context window. Set to 0 to turn compaction off for every model.'
                    },
                    {
                        key: 'modelLimits',
                        label: 'Per-model limits (JSON)',
                        type: 'string',
                        default: '{}',
                        description: 'A JSON object keyed by model id, each value `{ "limit": number, "window": number }` — both optional. `limit` replaces contextLimit for that model, for an operator who is willing to pay more (or less) for one model than for the rest. `window` states the model\'s HARD context window: it caps whatever limit is in force, so a 512000 ceiling on a 262144-token model still compacts around the 256k behaviour rather than waiting for a size the provider never accepts. Example: `{"gpt-4o": {"limit": 512000, "window": 131072}, "llama-8b": {"window": 8192}}`. The model id is read live from the agent, so switching models changes the ceiling on the next turn. Anything malformed — broken JSON, a value that is not an object, a non-positive or non-numeric limit — is ignored and the global limit applies, never an error.'
                    },
                    {
                        key: 'enabled',
                        label: 'Compact conversations',
                        type: 'boolean',
                        default: true,
                        description: 'Runs compaction on or off, in either mode. Off changes nothing else: the limit is still read, the context bar still measures, and no other plugin is affected. It is the switch an operator expects when they want the behaviour gone without removing the built-in.'
                    },
                    {
                        key: 'minTokens',
                        label: 'Minimum saving per pass (tokens)',
                        type: 'number',
                        default: 200,
                        min: 0,
                        step: 50,
                        description: 'A pass must withhold at least this many estimated tokens, or it does nothing at all — no flag write, no persistence notification, no save. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes running on every turn cheap. Measured as a difference of the same estimate, so any provider anchor cancels out of it and only the withheld characters count. In "summarize" mode the same number is read the other way round, as a trivial floor on the LIVE estimate: a conversation smaller than this is never worth a compaction round trip, so the pass refuses rather than paying for a summary of a handful of turns. Set it to 0 to remove the floor, which a small per-model limit needs: a floor above that limit would never be crossed.'
                    },
                    {
                        key: 'safetyTurns',
                        label: 'Recent units to protect',
                        type: 'number',
                        default: 6,
                        min: 0,
                        step: 1,
                        description: 'How many units at the END of the conversation no pass may touch. A unit is one assistant tool-call block plus its results, or one standalone message. The horizon counts UNITS from the end, never the per-run turn counter: a failure the model has not moved past yet is the highest-signal thing in the window, and pruning it is how an agent repeats the call it just watched fail. 0 removes the horizon. It belongs to "exclude" mode; "summarize" mode needs no horizon because the recent tail is exactly what the agent is summarizing.'
                    },
                    {
                        key: 'mode',
                        label: 'Compaction mode',
                        type: 'string',
                        default: 'summarize',
                        description: 'Which compaction runs when the limit is reached. "summarize" — the default since the 2026-11-10 context-compaction ruling — parks the conversation at the turn boundary and lets its NEXT model turn write the summary: the agent condenses what is done, what it is working on and where it left off, everything before that instruction stops being sent, and the conversation resumes with a nudge. "exclude" is the earlier behaviour: a superseded tool unit keeps its place in canonical history and simply stops being sent, which is the reversible option the evidence favours and the cheaper one — no extra model turn. "annotate" — replace the result with a one-line handle back to the full text — is the planned SECOND WRITER over the same candidate list the policy already computes before writing anything, and any value other than these two (including that one) behaves as "exclude", the flow that cannot spend a model turn by accident. The value actually used is reported in the pass diagnostic.'
                    }
                ]
            },
            {
                name: 'context-trimmer',
                title: 'Context Trimmer',
                description: 'At the start of each assistant turn, finds tool calls that failed or were rejected and were later replaced by a successful call to the same tool, and excludes those paired call+result units from the context. Nothing is deleted: a trimmed unit keeps its place in history and can be switched back on.',
                version: '1.0.0',
                tags: ['context', 'trimming', 'lifecycle'],
                builtin: true,
                hooks: ['turn.before'],
                settings: [
                    {
                        key: 'enabled',
                        label: 'Trim superseded tool calls',
                        type: 'boolean',
                        default: true,
                        description: 'Runs the trimming pass on or off. Off changes nothing else: units an earlier turn already trimmed stay trimmed until they are switched back on from the context view, no other plugin is affected, and the transcript is never rewritten. It is the switch an operator expects when they want the behaviour gone without removing the built-in.'
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
