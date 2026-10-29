// Composer @ file mentions and # agent-block references (T5 R1/R2).
//
// Pure logic only (no DOM, no network): the popup, lookup controller and submit
// path in main.ts are thin wrappers around these decisions, so every rule can be
// pinned in jsdom-free tests.
//
// TWO TOKEN GRAMMARS
// ------------------
//   @path            an existing file, relative to the server working directory.
//                    The chip serializes back to the same token; NO bytes are
//                    attached (a mention is a pointer, not an upload).
//   #LABEL           a block (agent invocation) in this conversation, e.g. `#IT1`
//                    = first `instruct` invocation (ui/agent-label.ts). A chip
//                    carries the EXACT `{ turnId, threadId?, label }` binding so a
//                    later submit references the block the user picked, even when
//                    another turn later allocates the same label.
//
// LABEL RESOLUTION (agreed server contract)
// -----------------------------------------
// Plain `#LABEL` text is still supported: the server resolves the LATEST turn that
// allocated that label. The UI's `latestReferenceBlock` mirrors that rule for the
// popup/lookup, so selecting a typed-looking label binds the same block the server
// would resolve at execution time.
//
// Cross-references:
//   - ui/turns.ts      — `blocks()` supplies the real root+nested descriptors
//   - ui/editor.ts     — chips serialize to these labels
//   - main.ts          — popup, debounced fileGlob lookup, submit references

import type { InlineChip } from './editor';
import type { AgentResultBlock } from '../../shared/agent-results';

// One block a user can reference. This is EXACTLY the shared descriptor
// (shared/agent-results.ts `AgentResultBlock`) so the popup, the submitted
// reference and the server's persisted projection cannot drift:
//   - `turnId` selects the turn;
//   - `threadId` is absent for the turn's ROOT invocation and is the stable
//     runtime id / synthetic alias (`call:<callId>`, `inline:<agent>`) for nested;
//   - `content` is the terminal answer when the block completed.
export type AgentBlockDescriptor = AgentResultBlock;

// Referenceable statuses: completed answers and work still in progress. A failed
// or cancelled block has no usable result and must not be offered in the picker.
export const isReferenceableBlock = (block: Pick<AgentBlockDescriptor, 'status'>): boolean =>
    block.status === 'done' || block.status === 'running' || block.status === 'queued';

// Wire contract (T4): SubmitTaskRequest.references and SessionTurn.references.
// `threadId` undefined means the turn's root block.
export type HarnessTurnReference = {
    turnId: string;
    threadId?: string;
    label: string;
};

const LABEL_TOKEN = /^#?\s*([\p{L}\p{N}]+)$/u;

// Normalize a typed label (`#it1`, `IT1`) to the allocator's uppercase form. The
// occurrence digits are part of the label, so this only upper-cases the code.
export const normalizeReferenceLabel = (value: string): string => {
    const match = LABEL_TOKEN.exec(value.trim());
    const label = match?.[1] ?? value.trim().replace(/^#/, '');
    return label.toUpperCase();
};

export const referenceToken = (label: string): string => `#${normalizeReferenceLabel(label)}`;

export const fileToken = (path: string): string => `@${path}`;

// Latest matching label wins: the board is oldest→newest, so the LAST match is the
// block the server will resolve at execution time. Exact (normalized) label match
// only — `IT1` must not match `IT10`.
export const latestReferenceBlock = (
    blocks: readonly AgentBlockDescriptor[],
    label: string
): AgentBlockDescriptor | undefined => {
    const wanted = normalizeReferenceLabel(label);
    let found: AgentBlockDescriptor | undefined;

    for (const block of blocks) {
        if (normalizeReferenceLabel(block.label) === wanted) found = block;
    }

    return found;
};

// Turn/thread/label binding for the wire. Root blocks omit `threadId` (undefined
// is the documented "root" signal), so the object stays byte-identical for them.
export const referenceOfBlock = (block: AgentBlockDescriptor): HarnessTurnReference => ({
    turnId: block.turnId,
    ...(block.threadId === undefined || block.threadId.length === 0 ? {} : { threadId: block.threadId }),
    label: normalizeReferenceLabel(block.label)
});

// A stable chip id per binding. Two chips for the same block intentionally share
// the id (the submit de-duplicates them); different blocks never collide.
export const referenceChipId = (reference: HarnessTurnReference): string =>
    `reference:${reference.turnId}:${reference.threadId ?? ''}:${normalizeReferenceLabel(reference.label)}`;

// The inline chip for a # popup selection. Data attributes mirror the wire so a
// submit can rebuild the payload from the DOM alone.
export const referenceChipOf = (block: AgentBlockDescriptor): InlineChip => {
    const reference = referenceOfBlock(block);
    return {
        kind: 'reference',
        id: referenceChipId(reference),
        label: referenceToken(reference.label),
        data: {
            'referenceTurn': reference.turnId,
            ...(reference.threadId === undefined ? {} : { 'referenceThread': reference.threadId }),
            'referenceLabel': reference.label
        }
    };
};

// The file chip for an @ selection. `path` is exactly what the server returned
// (posix, root-relative); the chip id is the path so a duplicate pick is one chip.
export const fileChipOf = (path: string): InlineChip => ({
    kind: 'file',
    id: path,
    label: fileToken(path)
});

const chipString = (chip: { dataset: Record<string, string | undefined> }, key: string): string | undefined => {
    const value = chip.dataset[key];
    return value === undefined || value.length === 0 ? undefined : value;
};

// Rebuild references from reference chips, in document order, de-duplicated by
// binding. A chip without a turn or label is ignored: a plain typed `#LABEL` is
// deliberately text, not metadata (the server resolves it).
export const referencesOfChips = (chips: readonly { kind: string; dataset: Record<string, string | undefined> }[]): HarnessTurnReference[] => {
    const references: HarnessTurnReference[] = [];
    const seen = new Set<string>();

    for (const chip of chips) {
        if (chip.kind !== 'reference') continue;

        const turnId = chipString(chip, 'referenceTurn');
        const label = chipString(chip, 'referenceLabel');
        if (turnId === undefined || label === undefined) continue;

        const threadId = chipString(chip, 'referenceThread');
        const reference: HarnessTurnReference = {
            turnId,
            ...(threadId === undefined ? {} : { threadId }),
            label
        };
        const id = referenceChipId(reference);
        if (seen.has(id)) continue;

        seen.add(id);
        references.push(reference);
    }

    return references;
};

// --- @ lookup ----------------------------------------------------------------

// Canonical form of a typed @ path query, used by BOTH the glob and the client
// filter. Without one normalizer `@./src/frontend` searched correctly but the
// returned `src/frontend/...` paths failed the raw `./` substring filter (T11).
// Backslashes are accepted because a Windows user may type them.
export const normalizeFileQuery = (query: string): string =>
    query
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+$/, '');

// glob magic that a user's query must NOT be able to inject: an unescaped `*`,
// `?`, `[` or `{` would turn a search into a broader/different walk.
const escapeGlob = (value: string): string => value.replace(/([*?[\]{}])/g, '[$1]');

// Query-aware patterns. An EMPTY query asks for the repository overview once; a
// query always narrows the SERVER walk instead of filtering the first 100 results
// locally (which would falsely report "no match" for a file after the cap).
//
//   - basename query (`main`):      `**/*main*` — a filename substring at any depth;
//   - path query (`src/frontend`):  `**/src/frontend*/**` (descendants of a matching
//     directory) PLUS `**/src/frontend*` (the path itself / a file prefix). A bare
//     `**/src/frontend*` alone matches NO descendant file because `*` never crosses
//     a `/`, which was the T8 review finding.
//
// Glob magic in the query is escaped so a search cannot widen the walk.
export const fileGlobPattern = (query: string): string[] => {
    const trimmed = normalizeFileQuery(query);

    if (trimmed.length === 0) return ['**/*'];

    const escaped = escapeGlob(trimmed);
    if (!trimmed.includes('/')) return [`**/*${escaped}*`];

    return [`**/${escaped}*/**`, `**/${escaped}*`];
};

// Defensive client filter for a result set. The server pattern already narrowed
// the walk, but a stale/partial reply or a path from another root must never be
// offered for the exact query the user sees.
export const filterFilePathList = (files: readonly string[], query: string): string[] => {
    const needle = normalizeFileQuery(query).toLowerCase();
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const path of files) {
        if (typeof path !== 'string' || path.length === 0) continue;
        if (seen.has(path)) continue;
        if (needle.length > 0 && !path.toLowerCase().includes(needle)) continue;

        seen.add(path);
        unique.push(path);
    }

    return unique;
};

// `fileGlob` may answer either a bare filename list or a content result; the
// mention picker only consumes filenames. Bounded to the first `limit` entries
// (the server already applies its own maxResults cap).
export const filePathsOf = (result: unknown, limit = 100): string[] => {
    if (typeof result !== 'object' || result === null) return [];

    const files = (result as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];

    return files.filter((path): path is string => typeof path === 'string').slice(0, Math.max(0, limit));
};

export const fileDisplayName = (path: string): string => {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? path;
};

// --- trigger detection --------------------------------------------------------

// An active mention/reference query at the caret.
export type MentionTrigger =
    | { kind: 'file'; query: string; start: number }
    | { kind: 'reference'; query: string; start: number };

// Find the trigger that owns the caret. Rules (matching UniversalTextBox):
//   - the LAST `@`/`#` in the current whitespace-delimited word wins;
//   - a trigger glued to a letter/digit (`name@host`, `C#`) is not a trigger;
//   - `@` query ends at whitespace; `#` query is alphanumeric only.
// `start` is the plain-text offset of the trigger character; the popup replaces
// `[start, caret)` when a row is picked.
export const mentionTriggerAt = (text: string, caret: number): MentionTrigger | undefined => {
    const position = Math.max(0, Math.min(caret, text.length));
    const before = text.slice(0, position);

    const atIndex = before.lastIndexOf('@');
    const hashIndex = before.lastIndexOf('#');
    const index = Math.max(atIndex, hashIndex);
    if (index < 0) return undefined;

    const kind = index === hashIndex ? 'reference' : 'file';
    const previous = index === 0 ? '' : before.charAt(index - 1);
    if (/[\p{L}\p{N}_]/u.test(previous)) return undefined;

    const query = before.slice(index + 1);
    if (kind === 'file') {
        // Whitespace ends an @ path query; a path cannot contain spaces.
        if (/[\s]/u.test(query)) return undefined;
        return { kind: 'file', query, start: index };
    }

    // A # label is letters/digits only; any other character ends the reference.
    if (!/^[\p{L}\p{N}]*$/u.test(query)) return undefined;
    return { kind: 'reference', query, start: index };
};

// True when a reference query has enough characters to search for a block. An
// empty `#` lists every block, so the caller still opens the popup.
export const isReferenceQuery = (value: string): boolean => /^[\p{L}\p{N}]*$/u.test(value);
