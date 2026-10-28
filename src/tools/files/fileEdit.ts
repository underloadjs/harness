// fileEdit — replace text in one or more existing files in a single call.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A rename or a signature change touches several files. The schema declares ONE
// property, `edits`, so the single-property rule (see ../core/tool.ts) hands
// `execute` the array itself — `fileEdit([{ path, oldString, newString }])` — while
// a model call carries `{ "edits": [...] }` and reaches the same code.
//
// The safety property comes from the contract, not from a sandbox:
//
//   - oldString must be found, or the call fails (no silent no-op);
//   - oldString must appear exactly once, or the call fails (no "which one did you
//     mean?" guessing) — pass replaceAll to opt into every occurrence;
//   - oldString and newString must differ, or nothing was edited.
//
// PREFLIGHT — ALL-OR-NOTHING (this is what makes batching safe)
// ------------------------------------------------------------
// Before the first byte is written, EVERY edit is validated (shape, non-empty
// oldString, distinct oldString/newString, no NUL, UNIQUE resolved target path) and
// EVERY file is read and match-checked. A failure anywhere — including on the last
// entry — therefore leaves every file untouched, which is why the batch can be
// trusted. Duplicate targets are rejected rather than merged: two edits to one file
// would both be computed from the same original text, so the second write would
// silently discard the first.
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes happen after the preflight, sequentially. An OS error during the write
// phase may leave earlier files edited: there is NO transaction and NO rollback, and
// the error names the completed paths and the failing one.
//
// No sandbox: paths are resolved against the process working directory and used as
// given.
//
// Executable on its own and registerable on a harness:
//
//     await fileEdit([{ path: 'notes.md', oldString: '# Notes', newString: '# Log' }]);
//
// Metadata comes from ../catalogue so the description a model reads cannot drift
// from the tool that runs (see the note at the top of ../catalogue.ts).

import { readFile as readTextFile, writeFile as writeTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

// One replacement to apply.
export type FileEditEntry = {
    // Path to an existing file, absolute or relative to the working directory.
    path: string;
    // Exact text to replace. Must be unique unless replaceAll is true.
    oldString: string;
    // Replacement text. May be empty to delete the matched text.
    newString: string;
    // Opt into replacing every occurrence instead of requiring uniqueness.
    replaceAll?: boolean;
};

// The value `execute` receives: the `edits` array itself (single-property rule).
export type FileEditParameters = FileEditEntry[];

// One applied edit, in request order.
export type FileEditResultEntry = {
    // The absolute path that was edited.
    path: string;
    // How many occurrences were replaced (1 unless replaceAll matched more).
    replacements: number;
    // Size of the resulting UTF-8 payload, in bytes.
    bytes: number;
};

// The ordered result: one entry per requested edit, never a subset.
export type FileEditResult = FileEditResultEntry[];

// Count non-overlapping occurrences without touching the file twice. split/join is
// used throughout the write path instead of String.replace so a "$&"-like sequence
// in newString is written literally rather than expanded.
const countOccurrences = (content: string, search: string): number => content.split(search).length - 1;

// A validated, match-checked edit: everything the write phase needs.
type PreparedEdit = {
    target: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    // The file's text as read during the preflight.
    content: string;
    // Occurrences of oldString in `content`; always >= 1 after the preflight.
    occurrences: number;
};

// Validate the shape of every entry, resolve every target, and reject duplicates.
// Kept separate from the read/match pass so shape errors are reported before any
// filesystem work at all.
const normalizeEdits = (edits: FileEditParameters): { target: string; oldString: string; newString: string; replaceAll: boolean }[] => {
    if (!Array.isArray(edits)) {
        throw new HarnessError(
            'fileEdit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
    }

    if (edits.length === 0) {
        throw new HarnessError('fileEdit received an empty edits array; pass at least one edit.');
    }

    const normalized: { target: string; oldString: string; newString: string; replaceAll: boolean }[] = [];
    const seen = new Set<string>();

    for (const entry of edits) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError(
                'fileEdit edits must be objects with "path", "oldString", and "newString" strings.'
            );
        }

        const { path, oldString, newString, replaceAll } = entry as Partial<FileEditEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileEdit edits require a non-empty "path" string.');
        }

        if (path.includes('\u0000')) {
            throw new HarnessError('fileEdit paths must not contain NUL characters.');
        }

        if (typeof oldString !== 'string' || oldString.length === 0) {
            // An empty oldString matches everywhere (including between every pair of
            // characters), so it is never a meaningful edit.
            throw new HarnessError('fileEdit requires a non-empty oldString.');
        }

        if (typeof newString !== 'string') {
            throw new HarnessError('fileEdit requires a "newString" string.');
        }

        // Rejecting a no-op keeps "the edit applied" an honest claim: a model that
        // passes the same text twice has not changed anything.
        if (oldString === newString) {
            throw new HarnessError(
                'fileEdit did not change the file: oldString and newString are identical.'
            );
        }

        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
            throw new HarnessError('fileEdit replaceAll must be a boolean when provided.');
        }

        const target = resolve(path);

        // Two edits to one file would both be computed from the same original text,
        // so the second write would discard the first. Reject rather than guess.
        if (seen.has(target)) {
            throw new HarnessError(
                `fileEdit received the same target path twice (${target}); make one edit per file per call.`
            );
        }

        seen.add(target);
        normalized.push({ target, oldString, newString, replaceAll: replaceAll === true });
    }

    return normalized;
};

// Read and match-check every file. Nothing is written here, so a failure on the
// last entry still leaves the first file untouched.
const prepareEdits = async (
    edits: ReturnType<typeof normalizeEdits>
): Promise<PreparedEdit[]> => {
    const prepared: PreparedEdit[] = [];

    for (const edit of edits) {
        // A missing or unreadable file throws straight out of the read: editing is
        // for existing files, and fileWrite is the tool that creates.
        const content = await readTextFile(edit.target, 'utf8');
        const occurrences = countOccurrences(content, edit.oldString);

        if (occurrences === 0) {
            throw new HarnessError(
                `fileEdit found no match for oldString in ${edit.target}. Read the file first and copy the text exactly, including indentation.`
            );
        }

        if (occurrences > 1 && !edit.replaceAll) {
            throw new HarnessError(
                `fileEdit found ${occurrences} matches for oldString in ${edit.target}. Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            );
        }

        prepared.push({ ...edit, content, occurrences });
    }

    return prepared;
};

// Apply one prepared edit to its preflight text. Pure: the write phase does not
// re-read, so the checked content is exactly what is rewritten.
const applyEdit = (edit: PreparedEdit): { updated: string; replacements: number } => {
    if (edit.replaceAll) {
        return {
            updated: edit.content.split(edit.oldString).join(edit.newString),
            replacements: edit.occurrences
        };
    }

    // occurrences === 1 here, so indexOf finds the only match.
    const at = edit.content.indexOf(edit.oldString);

    return {
        updated: edit.content.slice(0, at) + edit.newString + edit.content.slice(at + edit.oldString.length),
        replacements: 1
    };
};

export const fileEdit = tool<FileEditParameters, FileEditResult>({
    ...PRESET_TOOLS.fileEdit,
    execute: async ({ parameters: edits }) => {
        const normalized = normalizeEdits(edits);
        const prepared = await prepareEdits(normalized);
        const results: FileEditResultEntry[] = [];

        for (const edit of prepared) {
            const { updated, replacements } = applyEdit(edit);

            try {
                // No mkdir: the parent must already exist, because the file did.
                await writeTextFile(edit.target, updated, 'utf8');
            } catch (error) {
                // Partial success is reported honestly: the completed paths are
                // named, and there is no claim of a transaction or rollback.
                const completed = results.length === 0 ? 'none' : results.map((entry) => entry.path).join(', ');
                const reason = error instanceof Error ? error.message : String(error);

                throw new HarnessError(
                    `fileEdit failed on ${edit.target}: ${reason} Edits already applied: ${completed}. No rollback was performed.`
                );
            }

            results.push({
                path: edit.target,
                replacements,
                bytes: Buffer.byteLength(updated, 'utf8')
            });
        }

        return results;
    }
});
