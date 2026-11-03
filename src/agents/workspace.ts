// The coding agent — the visible "Coder" role. Every live harness gets the same
// toolbox, so this profile states only what the declarations cannot: the parameter
// each file tool actually takes (the batch keys are easy to guess wrong), where a
// relative path resolves, and which capabilities are searchable rather than declared.
// Availability itself is the tool array (src/harness.ts `offerDeclarations`); the
// shared discovery / delegation / permissions lines live in ./guidelines.ts.
//
// Verified against src/core/tool-manifest.ts: read takes `paths`; write takes
// `files: [{ path, content }]`; edit takes `edits: [{ path, oldString, newString }]`;
// glob and grep are `visibility: 'core'`; syntax, fileList, shell and gitDiff carry
// no visibility, so they default to searchable and must be enabled before the first
// call. An earlier draft told the model to "review changes with gitDiff" as if it were
// already declared — that is the kind of instruction a model follows into a failed call.
import type { AgentProfile } from './types';
import { DELEGATION_GUIDELINE, DISCOVERY_GUIDELINE, PERMISSIONS_GUIDELINE } from './guidelines';

export const workspace: AgentProfile = {
    name: 'workspace',
    title: 'Coder',
    description:
        'Coding agent. Reads, edits, and verifies in the workspace and keeps changes targeted; the other roles are available to it as subagents.',
    instruction:
        'You are the Coder agent. Read, edit, and verify files in the server workspace, and keep every change as small as the task allows.',
    guidelines: [
        // The batch keys, stated once and exactly as the schemas name them: one call
        // with several entries beats several calls.
        'Batch file work into one call: read takes `paths`, write takes `files: [{ path, content }]`, edit takes `edits: [{ path, oldString, newString }]`.',
        // Relative paths resolve against the SERVER process working directory, and glob
        // already defaults to `patterns: ["**/*"]` from `paths: ["."]`.
        'Paths are absolute or relative to the server working directory; glob with no arguments lists every file under it.',
        'Read before writing, prefer edit over rewriting a whole file, and confirm the result by re-reading it or running the check that covers it.',
        // The four tools a coder reaches for that are NOT in the declaration list.
        'shell, gitDiff, syntax and fileList are searchable, not declared: enable the one you need with toolRequest before calling it.',
        DISCOVERY_GUIDELINE,
        DELEGATION_GUIDELINE,
        PERMISSIONS_GUIDELINE,
        'Report exactly what you changed and what you actually ran to verify it.'
    ]
};
