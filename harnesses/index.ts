// The catalogue shared by the CLI and the HTTP server.
//
// Nothing here is exported from the package root: the published surface stays
// `src/harness.ts`. This folder is the application built on top of that surface —
// it defines the presets the app can run and the tools it can call directly.

import { presetTools } from '../src/harness';
import type { Tool } from '../src/harness';
import { harnessTools } from './tools';
import { presets } from './presets';
import type { CatalogueEntry, HarnessPreset, ToolGroup } from './types';

export { presets, harnessTools };
export { scriptedDemo } from './demo';
export type { CatalogueEntry, HarnessPreset, RunnerSettings, ToolGroup } from './types';

// Every tool a session or a direct call can reach, keyed by the name the model
// calls. Package presets come first so a harness-level tool can never silently
// shadow one of them.
export const allTools: Readonly<Record<string, Tool>> = { ...presetTools, ...harnessTools };

const buildCatalogue = (): CatalogueEntry[] => {
    const entries: CatalogueEntry[] = [];
    const seen = new Set<string>();

    const add = (group: ToolGroup, tools: Readonly<Record<string, Tool>>): void => {
        for (const [name, tool] of Object.entries(tools)) {
            if (seen.has(name)) {
                throw new Error(`The tool catalogue has two entries named "${name}".`);
            }

            seen.add(name);
            entries.push({ name, tool, group });
        }
    };

    add('Package presets', presetTools);
    add('Harness tools', harnessTools);

    return entries;
};

// The direct-call catalogue. The order is stable so the UI can group it without
// sorting heuristics.
export const catalogue: readonly CatalogueEntry[] = buildCatalogue();

export const findPreset = (name: string): HarnessPreset | undefined =>
    presets.find((preset) => preset.name === name);

export const findTool = (name: string): Tool | undefined => allTools[name];
