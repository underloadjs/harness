// writeFile — write UTF-8 text, creating parent directories.
//
// No sandbox: the path is resolved against the process working directory and used
// as given.
//
// Executable on its own and registerable on a harness:
//
//     await writeFile({ path: 'notes.md', content: '# Notes' });

import { mkdir, writeFile as writeTextFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';

export type WriteFileResult = {
    // The absolute path that was written.
    path: string;
    // Size of the written UTF-8 payload, in bytes.
    bytes: number;
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const writeFile = tool<{ path: string; content: string }, WriteFileResult>({
    ...PRESET_TOOLS.writeFile,
    execute: async ({ parameters: { path, content } }) => {
        const target = resolve(path);

        // Agents write into directories that do not exist yet far more often
        // than not; failing on that wastes a round trip.
        await mkdir(dirname(target), { recursive: true });
        await writeTextFile(target, content, 'utf8');

        return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
    }
});
