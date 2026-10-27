// editFile — replace text in an existing file.
//
// This is the edit-shaped companion to writeFile: it never creates a file, and it
// refuses an ambiguous match. The safety property comes from the contract, not
// from a sandbox:
//
//   - oldString must be found, or the call throws (no silent no-op);
//   - oldString must appear exactly once, or the call throws (no "which one did
//     you mean?" guessing) — pass replaceAll to opt into every occurrence.
//
// No sandbox: the path is resolved against the process working directory and used
// as given.
//
// Executable on its own and registerable on a harness:
//
//     await editFile({ path: 'notes.md', oldString: '# Notes', newString: '# Log' });
//
// Metadata comes from ../catalogue so the description a model reads cannot drift
// from the tool that runs (see the note at the top of ../catalogue.ts).

import { readFile as readTextFile, writeFile as writeTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

export type EditFileParameters = {
    path: string;
    oldString: string;
    newString: string;
    // Opt into replacing every occurrence instead of requiring uniqueness.
    replaceAll?: boolean;
};

export type EditFileResult = {
    // The absolute path that was edited.
    path: string;
    // How many occurrences were replaced (1 unless replaceAll matched more).
    replacements: number;
    // Size of the resulting UTF-8 payload, in bytes.
    bytes: number;
};

// Count non-overlapping occurrences without touching the file twice. split/join is
// used throughout the write path instead of String.replace so a "$&"-like
// sequence in newString is written literally rather than expanded.
const countOccurrences = (content: string, search: string): number => content.split(search).length - 1;

export const editFile = tool<EditFileParameters, EditFileResult>({
    ...PRESET_TOOLS.editFile,
    execute: async ({ parameters: { path, oldString, newString, replaceAll } }) => {
        // An empty oldString matches everywhere (including between every pair of
        // characters), so it is never a meaningful edit.
        if (oldString.length === 0) {
            throw new HarnessError('editFile requires a non-empty oldString.');
        }

        // Rejecting a no-op keeps "the edit applied" an honest claim: a model that
        // passes the same text twice has not changed anything.
        if (oldString === newString) {
            throw new HarnessError('editFile did not change the file: oldString and newString are identical.');
        }

        const target = resolve(path);

        // A missing or unreadable file throws straight out of readFile: editing is
        // for existing files, and writeFile is the tool that creates.
        const content = await readTextFile(target, 'utf8');
        const occurrences = countOccurrences(content, oldString);

        if (occurrences === 0) {
            throw new HarnessError(
                `editFile found no match for oldString in ${target}. Read the file first and copy the text exactly, including indentation.`
            );
        }

        if (occurrences > 1 && !replaceAll) {
            throw new HarnessError(
                `editFile found ${occurrences} matches for oldString in ${target}. Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            );
        }

        let updated: string;

        if (replaceAll) {
            updated = content.split(oldString).join(newString);
        } else {
            // occurrences === 1 here, so indexOf finds the only match.
            const at = content.indexOf(oldString);
            updated = content.slice(0, at) + newString + content.slice(at + oldString.length);
        }

        // No mkdir: the parent must already exist, because the file did.
        await writeTextFile(target, updated, 'utf8');

        return {
            path: target,
            replacements: replaceAll ? occurrences : 1,
            bytes: Buffer.byteLength(updated, 'utf8')
        };
    }
});
