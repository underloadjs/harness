// File tools: read, write, list. The minimum a coding agent needs.
//
// Paths are resolved against the process working directory and used as given —
// these presets hold NO sandbox. They are the same shape as the tools shipped by
// other CLI harnesses: powerful by default, and meant to be run under whatever
// process-level boundary the host provides (a container, a worktree, a scoped
// cwd). Narrow them by wrapping `execute` if a harness needs a fence.
//
// All three are executable on their own:
//
//     await readFile('package.json');
//     await writeFile({ path: 'notes.md', content: '# Notes' });
//     await listFiles('src');

import { mkdir, readFile as readTextFile, readdir, writeFile as writeTextFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tool } from '../core';

// Resolve once so every tool agrees on what a relative path means, and so an
// error message can show the absolute path that was actually touched.
const absolute = (path: string): string => resolve(path);

export const readFile = tool<string, string>({
    name: 'readFile',
    description:
        'Read a UTF-8 text file from disk and return its contents. Throws when the file does not exist or is not readable.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' }
        },
        required: ['path'],
        additionalProperties: false
    },
    execute: ({ parameters: path }) => readTextFile(absolute(path), 'utf8')
});

export type WriteFileResult = {
    // The absolute path that was written.
    path: string;
    // Size of the written UTF-8 payload, in bytes.
    bytes: number;
};

export const writeFile = tool<{ path: string; content: string }, WriteFileResult>({
    name: 'writeFile',
    description:
        'Write UTF-8 text to a file, creating parent directories as needed and overwriting an existing file. Returns the absolute path and the number of bytes written.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' },
            content: { type: 'string', description: 'Full text to write. Replaces the previous contents.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
    },
    execute: async ({ parameters: { path, content } }) => {
        const target = absolute(path);

        // Agents write into directories that do not exist yet far more often
        // than not; failing on that wastes a round trip.
        await mkdir(dirname(target), { recursive: true });
        await writeTextFile(target, content, 'utf8');

        return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
    }
});

export const listFiles = tool<string | undefined, string[]>({
    name: 'listFiles',
    description:
        'List the immediate entries of a directory. Directories are returned with a trailing slash so they are distinguishable from files. Returns a sorted list of entry names, not full paths.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Directory to list, absolute or relative to the working directory. Defaults to ".".'
            }
        },
        additionalProperties: false
    },
    execute: async ({ parameters: path }) => {
        const entries = await readdir(absolute(path ?? '.'), { withFileTypes: true });

        return entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort((left, right) => left.localeCompare(right));
    }
});
