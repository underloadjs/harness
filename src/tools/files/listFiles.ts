// listFiles — list the immediate entries of a directory.
//
// No sandbox: the path is resolved against the process working directory and used
// as given, defaulting to ".".
//
// Executable on its own and registerable on a harness:
//
//     await listFiles('src');

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const listFiles = tool<string | undefined, string[]>({
    ...PRESET_TOOLS.listFiles,
    execute: async ({ parameters: path }) => {
        const entries = await readdir(resolve(path ?? '.'), { withFileTypes: true });

        return entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort((left, right) => left.localeCompare(right));
    }
});
