// readFile — return a UTF-8 text file from disk.
//
// Paths are resolved against the process working directory and used as given:
// these presets hold NO sandbox. Run the harness under whatever process boundary
// the host provides (a container, a worktree, a scoped cwd), or wrap `execute`.
//
// Executable on its own and registerable on a harness:
//
//     await readFile('package.json');

import { readFile as readTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const readFile = tool<string, string>({
    ...PRESET_TOOLS.readFile,
    execute: ({ parameters: path }) => readTextFile(resolve(path), 'utf8')
});
