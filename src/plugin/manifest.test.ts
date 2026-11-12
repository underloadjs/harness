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
                name: 'context-trimmer',
                title: 'Context Trimmer',
                description: 'The posture this built-in exists to hold: the engine core trims nothing by default — every recorded message stays in the provider request — and this plugin is the one place trimming happens, one rule per switch. At the start of each assistant turn it finds tool calls that failed or were rejected and were later replaced by a successful call to the same tool, and excludes those paired call+result units from the context. Which outcomes count as invalid, whether supersession matches the tool name or the exact call fingerprint, whether thinking from earlier turns stops being replayed, and how much a pass must save before it writes anything are each a separate switch, and every one of them defaults to today\'s behaviour. A unit is withheld whole or not at all, an unanswered call is never touched, and a completed result is never invalid on its own unless dropDuplicateCalls is on and the fingerprints match. Nothing is deleted: a withheld unit keeps its place in canonical history and can be switched back on, and a switch flipped off stops new writes without restoring what an earlier turn already withheld.',
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
                            'Runs every trimming policy this plugin has, on or off. Off stops the pass, so none of the switches below is consulted and nothing is withheld from that turn on; it changes nothing else: units an earlier turn already trimmed stay trimmed until they are switched back on from the context view, no other plugin is affected, and the transcript is never rewritten. This is the framework\'s own key, so the switch in the Plugins row and this read are one stored value with one write path. Off is NOT the engine\'s posture: the engine\'s posture is every policy below off, which sends everything that was recorded.'
                    },
                    {
                        key: 'dropSupersededToolCalls',
                        label: 'Drop superseded tool calls',
                        type: 'boolean',
                        default: true,
                        description:
                            'The shipped rule, verbatim. A tool-call unit whose every committed result was failed or rejected, that is FULLY answered, and where EVERY tool name it called has a completed answer in some later unit that is still included, stops being sent as a whole unit: the assistant block and every result answering one of its calls leave together, so the request stays pair-clean. Every name must be answered, so a block that called A and B where only A was retried successfully stays whole — half a unit leaving is worse than the whole unit staying, and the failed half\'s result is what the model would lose. Flipping this off stops new writes and restores nothing an earlier turn already withheld. An unanswered unit is never touched, and a completed result is never invalid on its own: only dropDuplicateCalls can withhold a healthy unit, and only on an exact fingerprint match.'
                    },
                    {
                        key: 'dropInvalidToolCallsOnceAnswered',
                        label: 'Drop invalid tool calls once answered',
                        type: 'boolean',
                        default: true,
                        description:
                            'The same rule generalised over what counts as an invalid result, which is what invalidOutcomes decides. It is INDEPENDENT of dropSupersededToolCalls: turning one off leaves the other running, and with both off no tool unit is ever withheld, so the request carries every recorded tool call the harness has — the engine\'s posture. Like the shipped rule it withholds only a fully answered unit, only as a whole unit, and only once a still-included later unit has answered every name it called; a resolver that is itself withheld is not evidence, because then the model would see neither the failure nor the answer. Off stops new writes and restores nothing.'
                    },
                    {
                        key: 'invalidOutcomes',
                        label: 'Outcomes that count as invalid',
                        type: 'string',
                        default: 'failed,rejected',
                        description:
                            'Which committed results count as invalid for dropInvalidToolCallsOnceAnswered, as a comma-separated set drawn from failed, rejected, cancelled, empty. failed and rejected are the shipped rule. cancelled is opt-in only: the agent CHOSE to stop there, and a healthy control outcome is not garbage in this package — a unit mixing a cancelled answer with a healthy one is a keep either way. empty is opt-in and dangerous: it treats a completed result whose text is blank as invalid, and a legitimately empty answer — a grep with no matches, a zero-hit search — is indistinguishable from a stub, so withholding it removes the one fact that proves the agent already looked. Unknown names (including completed, which is only ever reachable through dropDuplicateCalls) are dropped and the pass says so; a set that resolves to nothing disables the generalisation, leaving dropSupersededToolCalls as the only tool policy. The set actually used is reported in the pass diagnostic.'
                    },
                    {
                        key: 'dropOldThoughts',
                        label: 'Drop old thinking',
                        type: 'string',
                        default: 'turn',
                        description:
                            'Which of the model\'s own thinking stops being replayed. "off": nothing is ever withheld and every recorded thought stays eligible for replay — the engine\'s posture, and the right value for a backend whose template concatenates historical thinking. "turn" (the default): the OPEN turn keeps its thinking — every committed assistant entry after the last user entry, which is why a mailbox or autoanswer user message legitimately moves the boundary — and the thinking of every CLOSED turn is withheld; it is the only tier every strict provider contract accepts at once, and it pins the provider\'s cache divergence point one turn back forever instead of walking it backwards through history. "all": every committed thought is withheld, including the open turn\'s — only sane on a transport that replays nothing, and it costs the current-turn continuity that every measured failure mode blames for re-deciding and for thin tool calls. Any other string behaves as "turn" and the diagnostic says so. The write is a per-entry FLAG on the assistant entry, never an edit of the text: the entry still travels, with its content and tool calls intact, and only its request copy drops the thinking, so provider pairing is untouched and canonical history keeps every thought — including of an entry this pass flagged. An entry with no recorded thinking, one that is already flagged, and one whose whole unit is already withheld are never candidates, so a second pass over an unchanged transcript writes nothing. The estimator does not count reasoning, so a withheld thought registers as zero saved tokens; measure the effect in characters with minThoughtChars. Withhold-only: switching to "off" stops new writes and restores nothing.'
                    },
                    {
                        key: 'thoughtKeepUnits',
                        label: 'Earlier units that keep thinking',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 32,
                        step: 1,
                        description:
                            'How many otherwise-withheld thinking entries, counted from the NEWEST entry backwards, additionally keep their thinking — the recent-N tier, for the backends that are trained on their own reasoning (local Qwen/GLM/Kimi, DeepSeek with tools, the keep-all Claude generations). Only consulted while dropOldThoughts is "turn" or "all"; it counts only entries that actually carry recorded thinking, and it never re-enables thinking an earlier turn already withheld. Every value ABOVE 0 is documented as cache-hostile: a sliding window walks the provider\'s divergence point backwards through previously-stable history on every eviction, which is strictly worse than 0 on both the window and the cache — use "off" if the whole history is wanted. 0 keeps exactly one turn: the open one. It runs BEFORE minThoughtChars, which measures what the rescue leaves behind.'
                    },
                    {
                        key: 'supersedeMatch',
                        label: 'Supersession match',
                        type: 'string',
                        default: 'name',
                        description:
                            'What makes a later call the answer to an earlier one. "name" is the shipped rule: the tool NAME alone, deliberately looser than compaction\'s fingerprint, because a failed call followed later by a successful call of the same tool is almost always superseded work whether or not the retry used the same arguments (read("a.ts") failing and read("b.ts") answering the question the agent actually had). "fingerprint" is compaction\'s exact rule — tool name AND canonical arguments must match — which makes the two passes agree by construction instead of by comment and is the value that makes compaction\'s failure-retry pruning redundant. Any other string behaves as "name" and the diagnostic says so. Neither value relaxes granularity: the unit still leaves whole, and every name the block called still has to be answered.'
                    },
                    {
                        key: 'dropDuplicateCalls',
                        label: 'Drop duplicate tool calls',
                        type: 'boolean',
                        default: false,
                        description:
                            'Withhold an EARLIER unit when a later, still-included unit re-ran the SAME work and answered it — matched on the exact fingerprint (tool name plus canonical arguments), NEVER on name alone — whatever the earlier unit\'s own outcome, so a unit the model read and used is reachable. Off by default: this is the one switch here that can withhold work the model actually used, and it is the largest class of redundant context in a long trajectory. It never touches an unanswered unit, never acts on a name-only match, and only ever withholds a unit whose re-run produced completed answers.'
                    },
                    {
                        key: 'minTokens',
                        label: 'Minimum saving per pass (tokens)',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 1000000,
                        step: 50,
                        description:
                            'A pass must withhold at least this many estimated tokens of TOOL-UNIT text, or it writes nothing at all: no flag, no notification, no save, no diagnostic. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes trimming on every turn cheap. 0 (the default) is the shipped posture: the rule only ever removes pure noise, so no floor was needed. The scoping to tool writes is not a detail — the estimator does not count reasoning, so a floor shared with the thinking writes would silently disable the thoughts switch whenever it was above zero.'
                    },
                    {
                        key: 'minThoughtChars',
                        label: 'Minimum thinking saved per pass (characters)',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 1000000,
                        step: 50,
                        description:
                            'The thinking twin of minTokens, measured in CHARACTERS of withheld thinking — the only measure available for text the estimator does not count. A thinking pass below this floor writes nothing at all. 0 (the default) removes the floor. Do not convert this number into tokens: while the estimator is not reasoning-aware the two figures cannot be compared, and a tokens-saved number that includes thinking would disagree with the context bar the operator is reading.'
                    },
                    {
                        key: 'safetyUnits',
                        label: 'Recent units to protect',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 4096,
                        step: 1,
                        description:
                            'How many units at the END of the transcript no tool trim may touch. A unit is one assistant tool-call block plus its results, or one standalone message, and the horizon counts UNITS from the end — never the per-run turn counter, which counts model steps inside one run and cannot express a conversation-level position. 0 (the default) removes the horizon, which is the shipped argument: a failure the model just replaced with a success is exactly the pair that is safe to drop from the NEXT request. Raise it when re-sending the last few units is cheaper than re-prefilling from the oldest trimmed position in the provider\'s cache.'
                    },
                    {
                        key: 'maxUnits',
                        label: 'Maximum units per pass',
                        type: 'number',
                        default: 0,
                        min: 0,
                        max: 4096,
                        step: 1,
                        description:
                            'Cap on how many tool units ONE pass may withhold; 0 (the default) is unbounded. It exists for the first pass over a conversation restored weeks ago: unbounded, that single turn withholds every superseded unit at once and the provider\'s cached prefix diverges at the oldest trimmed position. Withholding is oldest-first, so a cap removes the oldest noise now and leaves the newest superseded units for a later turn.'
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
