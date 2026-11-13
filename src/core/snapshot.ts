// Harness snapshot schema and validation (R3a).
//
// `harness.snapshot()` produces the value described by HarnessSnapshot in
// ../types; `harness.restore()` calls readHarnessSnapshot() first, so JSON read
// back from disk is validated in ONE place before any live state is touched.
//
// Design constraints:
//   - JSON only: no functions, no undefined, no bigint/symbol, no non-finite
//     numbers. That is what lets a server write the value under DATABASE_ROOT.
//   - no secrets: this module never sees provider configuration, API keys, or
//     headers — the harness configuration is not part of the snapshot.
//   - no execution: a created tool's source is retained as text. Compilation is
//     the caller's next step (../harness.ts -> createDynamicTool), and compiling
//     never runs the body (see ./creation.ts).
//   - no silent loss: unknown fields, missing fields, wrong types, duplicate ids,
//     and mismatched counters are errors. A file that this version cannot
//     represent in full is refused, not partially accepted.
//   - backward compatibility: additive state joins the EXISTING version as an OPTIONAL
//     key rather than bumping it. Two fields work that way: the terminal agent-result
//     archive (`agentResults`) and the conversation's tool switches
//     (`discovery.withheld`, see ./harness.ts `withheldTools`). Both are written only when
//     non-empty and read as "nothing recorded" when absent, so every pre-feature v2 file
//     (and every fixture) still validates and restores with its exact prior meaning.
//     The same mechanism serves a key INSIDE one section: the two forensic fields of an
//     unfinished agent result (`agentResults[].partialContent` / `.cancelledAtMessage`,
//     issue 0033) are optional ROW fields, so a file written before them — and every
//     fixture that has since pinned an agent-result row — keeps restoring unchanged.
//
// Cross-references:
//   - ../types            — HarnessSnapshot and its parts
//   - ./snapshot-validation — primitive readers shared with the store modules
//   - ./todo.ts / profile.ts / chapter.ts / location.ts — record state readers
//   - ./agent-limits.ts   - AGENT_RESULT_RETENTION (the archive bound)
//   - ../harness.ts       — snapshot()/restore() implementation
//   - ./creation.ts       — compileToolSource, the trusted-source compiler

import { HarnessError } from '../util';
import { DOWNLOAD_ATTACHMENT_LIMITS, validateAttachments } from '../shared/attachments';
// Stable transcript addresses (context T1.3): the reader-side id rule — carry an id that
// is already there, backfill one that is not. A leaf (types-only) import, like the
// `./agent-limits` leaf below.
import { createMessageIdAllocator } from './message-id';
// The outcome vocabulary + validation used by `applyOutcome` below. Direct module import
// (no barrel), the same convention as ./message-id above.
import { TOOL_OUTCOMES, isToolOutcome } from './tool-outcome';
import type {
    HarnessAgentResultSnapshot,
    HarnessAgentSnapshot,
    HarnessDiscoveryOffsetSnapshot,
    HarnessMessage,
    HarnessSnapshot,
    HarnessThreadSnapshot,
    HarnessToolCall,
    ToolCreation
} from '../types';
// Leaf import, not the compatibility facade: `./metadata` now projects the
// generated manifest, and the snapshot reader only needs this bound. Importing the
// leaf keeps a snapshot read free of any catalogue projection.
import { AGENT_RESULT_RETENTION } from './agent-limits';
import { MAX_THREAD_LABEL_CHARS, MAX_THREAD_RECORDS, THREAD_HOST_PREFIX } from './thread';
import {
    isSnapshotRecord,
    readSnapshotArray,
    readSnapshotBoolean,
    readSnapshotInteger,
    readSnapshotJsonValue,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';
import { readRecordsStoreState } from './records';

// The only schema this build reads. A snapshot from a future build is rejected by
// version rather than guessed at: migration belongs to whoever changes the shape.
//
// v2 is the records-engine shape change (T3): `records` was FOUR sibling stores
// (`todos`, `profiles`, `chapters`, `locations`), each with its own id counter, and
// it is now ONE collection map with one global counter (F3) plus a persisted
// definition per collection (Decision M). The version moved rather than the reader
// accepting both shapes because R5 says nothing is in production: a v1 file is
// refused with the version message below, and nobody has to lose data to a
// half-migrated read.
export const HARNESS_SNAPSHOT_VERSION = 2 as const;

// The model-facing message union is small and closed. Validate every branch and
// copy it, so a live array can never be shared with a saved object.
const readToolCalls = (value: unknown, label: string): HarnessToolCall[] =>
    readSnapshotArray(value, label).map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, entryLabel);
        readSnapshotKeys(record, ['id', 'name', 'arguments'], entryLabel);

        return {
            id: readSnapshotString(record.id, `${entryLabel}.id`, { min: 1 }),
            name: readSnapshotString(record.name, `${entryLabel}.name`, { min: 1 }),
            // Raw JSON text: malformed arguments are a replayable fact, not a
            // reason to reject the transcript. An empty string is allowed.
            arguments: readSnapshotString(record.arguments, `${entryLabel}.arguments`)
        };
    });

// R3 durability: validate the OPTIONAL terminal agent-result records. This runs
// inside readHarnessSnapshot, before the harness mutates anything, so a corrupt
// result array rejects the whole restore. Connections to live state are checked
// here too: every record names an agent present in snapshot.agents, ids/orders are
// globally unique, and the list is bounded by the same retention as the runtime.
const readAgentResults = (
    value: unknown,
    label: string,
    agentNames: ReadonlySet<string>
): HarnessAgentResultSnapshot[] => {
    const entries = readSnapshotArray(value, label);

    if (entries.length > AGENT_RESULT_RETENTION) {
        throw new HarnessError(
            `${label} contains ${entries.length} records; at most ${AGENT_RESULT_RETENTION} are retained.`
        );
    }

    const ids = new Set<string>();
    const sequences = new Set<number>();
    const completionOrders = new Set<number>();

    return entries.map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, entryLabel);
        readSnapshotKeys(
            record,
            [
                'invocationId',
                'sequence',
                'completedOrder',
                'agent',
                'role',
                'kind',
                'status',
                'content',
                'error',
                'partialContent',
                'cancelledAtMessage',
                // Issue 0033/0024: the conversation an archived result belongs to. The key was
                // already accepted by `HarnessInvocationArchiveInput` and is what
                // `purgeThread`'s delete cascade matches on, but it was NOT part of the
                // persisted row: the projection dropped it and this reader would have REFUSED a
                // row that carried it, so after one restart the archived results of a deleted
                // conversation were unreachable to the cascade — the lane/inline divergence the
                // stress report found, moved onto the durability path.
                'threadId'
            ],
            entryLabel,
            // Issue 0033: the two forensic keys join `error` as MAY-BE-ABSENT, which is
            // exactly the backwards-compatibility mechanism. An old-generation row that
            // never carried them is still valid (they are in `optional`, so nothing
            // demands them) and restores with its exact prior meaning; a current row that
            // carries them is read, not dropped. `threadId` joins the same list for the same
            // reason: the writers spread it only when the invocation resolved no conversation
            // at all (src/harness.ts:12277 `runThreadId`), so absence is a fact about that row,
            // not a defect — while an old file that simply never carried the key stays valid.
            ['error', 'partialContent', 'cancelledAtMessage', 'threadId']
        );

        const invocationId = readSnapshotString(record.invocationId, `${entryLabel}.invocationId`, {
            min: 1
        });
        const sequence = readSnapshotInteger(record.sequence, `${entryLabel}.sequence`, { min: 1 });
        const completedOrder = readSnapshotInteger(
            record.completedOrder,
            `${entryLabel}.completedOrder`,
            { min: 1 }
        );
        const agent = readSnapshotString(record.agent, `${entryLabel}.agent`, { min: 1 });
        const role = readSnapshotString(record.role, `${entryLabel}.role`, { min: 1 });
        const kind = readSnapshotString(record.kind, `${entryLabel}.kind`, { min: 1 });
        const status = readSnapshotString(record.status, `${entryLabel}.status`, { min: 1 });
        const content = readSnapshotString(record.content, `${entryLabel}.content`);

        if (!agentNames.has(agent)) {
            throw new HarnessError(
                `${entryLabel}.agent names "${agent}", which is not present in snapshot.agents.`
            );
        }

        if (role !== 'primary' && role !== 'subagent') {
            throw new HarnessError(`${entryLabel}.role must be one of: primary, subagent.`);
        }

        if (kind !== 'root' && kind !== 'delegation' && kind !== 'fork' && kind !== 'autoanswer') {
            throw new HarnessError(
                `${entryLabel}.kind must be one of: root, delegation, fork, autoanswer.`
            );
        }

        if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
            throw new HarnessError(
                `${entryLabel}.status must be one of: completed, failed, cancelled (running is not persisted).`
            );
        }

        if (ids.has(invocationId)) {
            throw new HarnessError(
                `${label} contains the duplicate invocationId "${invocationId}".`
            );
        }
        if (sequences.has(sequence)) {
            throw new HarnessError(`${label} contains the duplicate sequence ${sequence}.`);
        }
        if (completionOrders.has(completedOrder)) {
            throw new HarnessError(
                `${label} contains the duplicate completedOrder ${completedOrder}.`
            );
        }

        ids.add(invocationId);
        sequences.add(sequence);
        completionOrders.add(completedOrder);

        const result: HarnessAgentResultSnapshot = {
            invocationId,
            sequence,
            completedOrder,
            agent,
            role,
            kind,
            status,
            content
        };

        if (record.error !== undefined) {
            result.error = readSnapshotString(record.error, `${entryLabel}.error`, { min: 1 });
        }

        if (status === 'completed' && result.error !== undefined) {
            throw new HarnessError(`${entryLabel}.error must be absent on a completed result.`);
        }

        if (status !== 'completed' && result.error === undefined) {
            throw new HarnessError(
                `${entryLabel}.error is required when status is ${status}.`
            );
        }

        // Issue 0033 — the forensic pair of an unfinished run, read under exactly the
        // rules `error` already sets, because they are the same kind of field: optional
        // on the row, never blank on a row that carries one, and meaningless once the
        // run completed.
        //
        //   * `min: 1` mirrors the writer. `finishInvocation` stores the partial only
        //     when it trims to something (src/harness.ts:3887-3889), so an
        //     empty-string partial on disk is not a fact this build can produce — it is
        //     a hand edit, and accepting it would restore an `agentResult` shape
        //     (`partialContent: ""`) that the runtime never answers with.
        //   * `cancelledAtMessage` may legitimately be 0: the counter is
        //     `Math.max(0, brain.messages.length - commitIndex)` (src/harness.ts:11471),
        //     so a run stopped before it appended anything reports zero.
        //   * The two are NOT required to appear together, and no rule here says they
        //     must: a run cancelled inside its first tool round commits messages without
        //     committing substantive TEXT, which is exactly 0020's open case.
        //   * Both must be ABSENT on a completed result, like `error`. A completed row
        //     that carried them would restore a record the snapshot projection then
        //     re-drops, so `restore -> snapshot` would stop being idempotent — the same
        //     reason `error` is refused there.
        if (record.partialContent !== undefined) {
            result.partialContent = readSnapshotString(
                record.partialContent,
                `${entryLabel}.partialContent`,
                { min: 1 }
            );
        }

        if (record.cancelledAtMessage !== undefined) {
            result.cancelledAtMessage = readSnapshotInteger(
                record.cancelledAtMessage,
                `${entryLabel}.cancelledAtMessage`,
                { min: 0 }
            );
        }

        // The owning conversation, read under the same "never blank on a row that carries one"
        // rule as `error`/`partialContent`: the writer stores the key only when the invocation
        // HAS a thread (`archiveInvocation` and the snapshot projection both spread
        // conditionally), so `threadId: ""` on disk is a hand edit, and restoring one would give
        // `purgeThread` an owner that matches no conversation. Unlike the forensic pair, this key
        // is legal on a COMPLETED result — a finished turn of a host thread still belongs to that
        // thread.
        if (record.threadId !== undefined) {
            result.threadId = readSnapshotString(record.threadId, `${entryLabel}.threadId`, {
                min: 1
            });
        }

        if (
            status === 'completed' &&
            (result.partialContent !== undefined || result.cancelledAtMessage !== undefined)
        ) {
            throw new HarnessError(
                `${entryLabel}.partialContent and .cancelledAtMessage must be absent on a completed result.`
            );
        }

        return result;
    });
};

// The persisted context-inclusion flag (types/index.ts, `HarnessMessage`).
//
// Only the literal `false` is ever STORED: absent means included, so every
// pre-flag transcript, snapshot and branch record keeps restoring byte-for-byte,
// and a writer that re-enables a turn DELETES the key instead of writing true.
// A snapshot that does carry `included: true` (hand-edited, or written by a host
// that ignored the omit rule) is accepted and NORMALIZED to the absent form, so
// `restore -> snapshot` stays idempotent instead of re-adding a key the runtime
// never writes. A non-boolean value is refused like any other mistyped field.
const applyIncluded = (
    message: HarnessMessage,
    record: Record<string, unknown>,
    label: string
): void => {
    if (record.included === undefined) return;

    if (readSnapshotBoolean(record.included, `${label}.included`) === false) {
        message.included = false;
    }
};

// The persisted THINKING-inclusion flag (trimmer uplift T6 — `HarnessMessage.reasoningIncluded`).
//
// The same minimal-delta contract as `included` immediately above, and the reason it has to be:
// the withheld-thinking decision is transcript state, so a snapshot → restore → continue round must
// carry it or the model silently gets the reasoning of every older turn back after a restart.
// Only the literal `false` is stored; a snapshot that carries `reasoningIncluded: true` (a host
// that round-trips its own JSON, or a hand-edited file) is accepted and NORMALIZED to the absent
// form, so `restore -> snapshot` stays idempotent. A non-boolean value is refused like any other
// mistyped field.
//
// It is assistant-only, exactly like `reasoning` itself: the assistant whitelist below is the only
// place that admits the key, so a `reasoningIncluded` on a user or tool entry is refused rather
// than quietly dropped — the same treatment `reasoning` on a non-assistant entry gets.
const applyReasoningIncluded = (
    message: HarnessMessage,
    record: Record<string, unknown>,
    label: string
): void => {
    if (record.reasoningIncluded === undefined) return;

    if (readSnapshotBoolean(record.reasoningIncluded, `${label}.reasoningIncluded`) === false) {
        (message as Extract<HarnessMessage, { role: 'assistant' }>).reasoningIncluded = false;
    }
};

// The persisted tool outcome (compaction T1.4 — the reader side of core/tool-outcome.ts).
//
// Same minimal-delta contract as `included` directly above: ABSENT means `completed`, so
// every snapshot written before this field existed restores byte-for-byte and no fixture
// needs a migration. A snapshot that does carry `outcome: "completed"` (hand-edited, or
// written by a host that ignored the omit rule) is accepted and NORMALIZED to the absent
// form, exactly like `included: true`, so `restore -> snapshot` stays idempotent instead
// of re-adding a key the runtime never writes.
//
// A value OUTSIDE the union is REFUSED rather than dropped: silently reading a mistyped
// `"fail"` as `completed` would hide a real failure from every later policy, and this
// reader's whole rule is that a corrupt document fails loudly (file header). There is no
// fallback that re-derives an outcome from the result TEXT — the omit rule is a deliberate
// migration decision, not a bridge (T1.5).
const applyOutcome = (
    message: Extract<HarnessMessage, { role: 'tool' }>,
    record: Record<string, unknown>,
    label: string
): void => {
    if (record.outcome === undefined) return;

    if (!isToolOutcome(record.outcome)) {
        throw new HarnessError(
            `${label}.outcome must be one of: ${TOOL_OUTCOMES.join(', ')} (or be omitted).`
        );
    }

    // `completed` is stored as nothing at all; only the three non-healthy values are kept.
    if (record.outcome !== 'completed') {
        message.outcome = record.outcome;
    }
};

// The stable transcript address (context T1.3): `messageId` is OPTIONAL on read, so a
// `state.json` written before ids existed keeps restoring byte-for-bit.
//
// BACKFILL-ON-READ, the option this file picks (the task left both open): every path
// INTO canonical state goes through this reader — `snapshot()` uses it to project live
// messages, and `restore()`/`setThreadMessages`/`appendThreadMessages` use it to build
// them — so minting here is the one place that guarantees canonical state always has
// ids WITHOUT touching any of those call sites. The alternative (minting on write into
// canonical state) would leave a pre-id transcript id-less until the next snapshot, and
// `entries` would report `messageId` absent for a turn that is perfectly addressable.
//
// Idempotence is the property this choice has to keep, and it does: an id that is
// ALREADY there is carried verbatim (never re-minted, the rule in core/message-id.ts),
// and only an entry with no id consumes the next free number. So restoring a document
// and snapshotting it again returns THE SAME document, which is what `applyIncluded`
// already guarantees for the flag (see the comment above).
//
// A present-but-unsuitable id is refused like any other mistyped field — a non-string,
// or an empty string — rather than silently re-minted, because the caller (a server
// transcript PUT, a hand-edited file) needs to know its address was dropped. The
// runtime's own spelling is `msg-<n>`; a host may carry any other non-empty string, and
// it survives as an opaque address (core/message-id.ts header).
const readMessageId = (record: Record<string, unknown>, label: string): string | undefined =>
    record.messageId === undefined
        ? undefined
        : readSnapshotString(record.messageId, `${label}.messageId`, { min: 1 });

const applyMessageId = (message: HarnessMessage, allocated: string): void => {
    // Written LAST, so the key order of a read message matches the order a runtime
    // creation point produces (`assignMessageId`) and a flagged entry keeps `included`
    // before `messageId` in both directions.
    message.messageId = allocated;
};

export const readHarnessMessages = (
    value: unknown,
    label: string,
    // THE TRANSCRIPT THESE ENTRIES ARE JOINING — only for an APPEND (src/harness.ts
    // `appendThreadMessages`, the lane-worker seam), where the array being read is a
    // slice rather than a whole conversation. Backfilling an absent address must count
    // against everything the conversation already owns, or the appended entry would be
    // minted an id the transcript holds (and `setIncluded(id)` would name two turns).
    // `snapshot()`, `restore()` and `setThreadMessages` pass nothing: the array each of
    // them reads IS the whole transcript, so its own ids are the ceiling.
    surrounding?: readonly HarnessMessage[]
): HarnessMessage[] => {
    const entries = readSnapshotArray(value, label);

    // One allocator per read: it scans the list ONCE for the highest id it already
    // carries, then hands out increasing ids for the entries that have none, so ids
    // cannot collide with a host-authored one and a mixed document (some entries ided,
    // some not) reads sanely.
    const allocate = createMessageIdAllocator(
        surrounding === undefined ? entries : [...surrounding, ...entries]
    );

    return entries.map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, entryLabel);
        const role = readSnapshotString(record.role, `${entryLabel}.role`, { min: 1 });

        switch (role) {
            case 'system': {
                // `included` and `messageId` are the optional system keys, both listed as
                // OPTIONAL so a pre-flag / pre-id snapshot (role+content only) still
                // passes — and `messageId` is then BACKFILLED on the way in (see
                // `applyMessageId` above), which is what makes a transcript restored from
                // such a file addressable by id from its very next round.
                readSnapshotKeys(
                    record,
                    ['role', 'content', 'included', 'messageId'],
                    entryLabel,
                    ['included', 'messageId']
                );

                const message: Extract<HarnessMessage, { role: 'system' }> = {
                    role,
                    content: readSnapshotString(record.content, `${entryLabel}.content`)
                };

                applyIncluded(message, record, entryLabel);
                applyMessageId(message, allocate(readMessageId(record, entryLabel)));
                return message;
            }

            case 'user': {
                // Attachments are OPTIONAL: a pre-attachment snapshot has only
                // role+content and must keep restoring byte-for-byte. When
                // present, the shared validator re-checks every field (MIME,
                // canonical base64, decoded size, magic signature) and returns
                // detached copies, so a live transcript never aliases a saved
                // object.
                readSnapshotKeys(
                    record,
                    ['role', 'content', 'attachments', 'included', 'messageId'],
                    entryLabel,
                    ['attachments', 'included', 'messageId']
                );

                const message: Extract<HarnessMessage, { role: 'user' }> = {
                    role: 'user',
                    content: readSnapshotString(record.content, `${entryLabel}.content`)
                };

                if (record.attachments !== undefined) {
                    try {
                        message.attachments = validateAttachments(record.attachments);
                    } catch (error) {
                        // Keep restore's single error type: HarnessError.
                        throw new HarnessError(
                            `${entryLabel}.attachments ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }

                applyIncluded(message, record, entryLabel);
                applyMessageId(message, allocate(readMessageId(record, entryLabel)));
                return message;
            }

            case 'assistant': {
                readSnapshotKeys(
                    record,
                    // `reasoningIncluded` is the second context flag (trimmer uplift T6): it must
                    // be listed beside `reasoning`/`included` or a transcript with a withheld
                    // thinking turn refuses to restore at all — this reader's key whitelist IS the
                    // persistence contract for a per-message field.
                    ['role', 'content', 'toolCalls', 'reasoning', 'included', 'reasoningIncluded', 'messageId'],
                    entryLabel,
                    ['toolCalls', 'reasoning', 'included', 'reasoningIncluded', 'messageId']
                );

                const message: Extract<HarnessMessage, { role: 'assistant' }> = {
                    role: 'assistant',
                    content: readSnapshotString(record.content, `${entryLabel}.content`)
                };

                if (record.toolCalls !== undefined) {
                    message.toolCalls = readToolCalls(record.toolCalls, `${entryLabel}.toolCalls`);
                }

                if (record.reasoning !== undefined) {
                    message.reasoning = readSnapshotString(
                        record.reasoning,
                        `${entryLabel}.reasoning`
                    );
                }

                applyIncluded(message, record, entryLabel);
                // AFTER `applyIncluded`, so a restored message's key order matches what the
                // control writes onto a canonical message (`included` first, then
                // `reasoningIncluded`) and a byte comparison of a live transcript against its own
                // restore stays honest.
                applyReasoningIncluded(message, record, entryLabel);
                applyMessageId(message, allocate(readMessageId(record, entryLabel)));
                return message;
            }

            case 'tool': {
                // `attachments` is OPTIONAL: a medialess tool result (and every
                // snapshot written before download media existed) has exactly the
                // four historical keys and restores byte-for-byte. When present,
                // the bytes are re-checked with the DOWNLOAD profile — a
                // 20 MiB file is legal here and would be rejected by the upload
                // limits, and a corrupted payload must fail the restore loudly
                // rather than replay garbage to the provider.
                readSnapshotKeys(
                    record,
                    ['role', 'content', 'toolCallId', 'name', 'attachments', 'outcome', 'included', 'messageId'],
                    entryLabel,
                    ['attachments', 'outcome', 'included', 'messageId']
                );

                const message: Extract<HarnessMessage, { role: 'tool' }> = {
                    role: 'tool',
                    content: readSnapshotString(record.content, `${entryLabel}.content`),
                    toolCallId: readSnapshotString(record.toolCallId, `${entryLabel}.toolCallId`, { min: 1 }),
                    name: readSnapshotString(record.name, `${entryLabel}.name`, { min: 1 })
                };

                if (record.attachments !== undefined) {
                    try {
                        message.attachments = validateAttachments(
                            record.attachments,
                            DOWNLOAD_ATTACHMENT_LIMITS
                        );
                    } catch (error) {
                        // Keep restore's single error type: HarnessError.
                        throw new HarnessError(
                            `${entryLabel}.attachments ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }

                applyOutcome(message, record, entryLabel);
                applyIncluded(message, record, entryLabel);
                applyMessageId(message, allocate(readMessageId(record, entryLabel)));
                return message;
            }

            default:
                throw new HarnessError(
                    `${entryLabel}.role must be one of: system, user, assistant, tool.`
                );
        }
    });
};

// Copy a creation record without validating it. Used at the moment of creation
// (the source has already been through createDynamicTool) and when emitting a
// snapshot, so the registry record and the emitted value never share mutable
// arrays/objects.
export const cloneToolCreation = (creation: ToolCreation): ToolCreation => ({
    name: creation.name,
    description: creation.description,
    tags: [...creation.tags],
    ...(creation.parameters === undefined
        ? {}
        : { parameters: JSON.parse(JSON.stringify(creation.parameters)) as Record<string, unknown> }),
    // Exactly one source form is required. A source-registered tool persists its
    // captured module (or path + fallback text) so restore uses the SAME shared
    // compiler as startup/runtime registration; legacy toolCreate keeps `source`.
    ...(creation.source === undefined ? {} : { source: creation.source }),
    ...(creation.moduleText === undefined ? {} : { moduleText: creation.moduleText }),
    ...(creation.sourcePath === undefined ? {} : { sourcePath: creation.sourcePath }),
    ...(creation.dependencies === undefined
        ? {}
        : {
              dependencies: creation.dependencies.map((dependency) => ({
                  path: dependency.path,
                  text: dependency.text
              }))
          }),
    ...(creation.visibility === undefined ? {} : { visibility: creation.visibility })
});

// Validate one persisted creation record. Field bounds (name pattern, tag caps,
// schema complexity, source length) stay in createDynamicTool, which the restore
// path calls next; this reader only guarantees a JSON-shaped record that can be
// handed to it.
const readToolCreation = (value: unknown, label: string): ToolCreation => {
    const record = readSnapshotRecord(value, label);
    // `source` is legacy (function body). Source registrations may instead persist
    // `moduleText` + `sourcePath` + captured local `dependencies`; all are optional
    // on the schema and validated by the shared compiler during restore.
    readSnapshotKeys(
        record,
        [
            'name',
            'description',
            'tags',
            'parameters',
            'source',
            'moduleText',
            'sourcePath',
            'dependencies',
            'visibility'
        ],
        label,
        ['parameters', 'source', 'moduleText', 'sourcePath', 'dependencies', 'visibility']
    );

    const tags = readSnapshotArray(record.tags, `${label}.tags`).map((tag, index) =>
        readSnapshotString(tag, `${label}.tags[${index}]`, { min: 1 })
    );

    const creation: ToolCreation = {
        name: readSnapshotString(record.name, `${label}.name`, { min: 1 }),
        description: readSnapshotString(record.description, `${label}.description`, { min: 1 }),
        tags
    };

    if (record.parameters !== undefined) {
        const parameters = readSnapshotJsonValue(record.parameters, `${label}.parameters`);

        if (!isSnapshotRecord(parameters)) {
            throw new HarnessError(`${label}.parameters must be a JSON Schema object.`);
        }

        creation.parameters = parameters;
    }

    if (record.source !== undefined) {
        creation.source = readSnapshotString(record.source, `${label}.source`, { min: 1 });
    }

    if (record.moduleText !== undefined) {
        creation.moduleText = readSnapshotString(record.moduleText, `${label}.moduleText`, {
            min: 1
        });
    }

    if (record.sourcePath !== undefined) {
        creation.sourcePath = readSnapshotString(record.sourcePath, `${label}.sourcePath`, {
            min: 1
        });
    }

    if (record.dependencies !== undefined) {
        creation.dependencies = readSnapshotArray(record.dependencies, `${label}.dependencies`).map(
            (entry, index) => {
                const entryLabel = `${label}.dependencies[${index}]`;
                const dependency = readSnapshotRecord(entry, entryLabel);
                readSnapshotKeys(dependency, ['path', 'text'], entryLabel);
                return {
                    path: readSnapshotString(dependency.path, `${entryLabel}.path`, { min: 1 }),
                    text: readSnapshotString(dependency.text, `${entryLabel}.text`)
                };
            }
        );
    }

    if (record.visibility !== undefined) {
        const visibility = readSnapshotString(record.visibility, `${label}.visibility`, { min: 1 });

        if (visibility !== 'core' && visibility !== 'searchable') {
            throw new HarnessError(`${label}.visibility must be one of: core, searchable.`);
        }

        creation.visibility = visibility;
    }

    // Exactly one source form is required. Enforcing this here keeps a corrupt
    // snapshot from reaching the compiler with an ambiguous revision.
    if (creation.source === undefined && creation.moduleText === undefined) {
        throw new HarnessError(
            `${label} requires a "source" (legacy body) or "moduleText" (module revision).`
        );
    }

    if (creation.source !== undefined && creation.moduleText !== undefined) {
        throw new HarnessError(`${label} cannot contain both "source" and "moduleText".`);
    }

    return creation;
};

// R2 persistent threads. Only HOST threads are persisted (an agent's default
// conversation is the agent transcript, and its id derives from the agent name).
// The reader enforces the whole shape up front: bounded count, unique ids and
// sequences, a configured owner agent, a durable status, a linked parent that is
// also present, and a transcript for every record. `threadSequence` must be a
// high-water mark for the ids it accompanies, so a restore can never mint a
// colliding id later.
const readThreads = (
    value: unknown,
    label: string,
    agentNames: ReadonlySet<string>
): HarnessThreadSnapshot[] => {
    const entries = readSnapshotArray(value, label);

    if (entries.length > MAX_THREAD_RECORDS) {
        throw new HarnessError(
            `${label} contains ${entries.length} records; at most ${MAX_THREAD_RECORDS} can be persisted.`
        );
    }

    const records: HarnessThreadSnapshot[] = [];
    const ids = new Set<string>();
    const sequences = new Set<number>();

    for (const [index, entry] of entries.entries()) {
        const entryLabel = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, entryLabel);
        readSnapshotKeys(
            record,
            [
                'id',
                'agent',
                'status',
                'sequence',
                'ownerThreadId',
                'label',
                'invocationId',
                'contextLane',
                'messages'
            ],
            entryLabel,
            ['ownerThreadId', 'label', 'invocationId', 'contextLane']
        );

        const id = readSnapshotString(record.id, `${entryLabel}.id`, { min: 1 });

        // Host ids only, and in the generated form: a persisted 'agent:<name>'
        // thread would duplicate the agent transcript this snapshot already
        // carries, and an arbitrary id could collide with a future mint.
        if (!new RegExp(`^${THREAD_HOST_PREFIX}[1-9][0-9]*$`).test(id)) {
            throw new HarnessError(
                `${entryLabel}.id must be a generated host thread id ("${THREAD_HOST_PREFIX}N"); received "${id}".`
            );
        }

        if (ids.has(id)) {
            throw new HarnessError(`${label} contains the duplicate thread id "${id}".`);
        }

        const agent = readSnapshotString(record.agent, `${entryLabel}.agent`, { min: 1 });

        if (!agentNames.has(agent)) {
            throw new HarnessError(
                `${entryLabel}.agent names "${agent}", which is not present in snapshot.agents.`
            );
        }

        const status = readSnapshotString(record.status, `${entryLabel}.status`, { min: 1 });

        if (status !== 'idle' && status !== 'stopped') {
            throw new HarnessError(
                `${entryLabel}.status must be one of: idle, stopped (a running thread is not persisted).`
            );
        }

        const sequence = readSnapshotInteger(record.sequence, `${entryLabel}.sequence`, { min: 1 });

        if (sequences.has(sequence)) {
            throw new HarnessError(`${label} contains the duplicate thread sequence ${sequence}.`);
        }

        const thread: HarnessThreadSnapshot = {
            id,
            agent,
            status,
            sequence,
            messages: readHarnessMessages(record.messages, `${entryLabel}.messages`)
        };

        if (record.ownerThreadId !== undefined) {
            thread.ownerThreadId = readSnapshotString(record.ownerThreadId, `${entryLabel}.ownerThreadId`, {
                min: 1
            });
        }

        if (record.label !== undefined) {
            const label = readSnapshotString(record.label, `${entryLabel}.label`, { min: 1 });

            // Same bound as createThread (core/thread.ts): a hand-edited snapshot
            // must not smuggle an oversized display label into a live record.
            if (label.length > MAX_THREAD_LABEL_CHARS) {
                throw new HarnessError(
                    `${entryLabel}.label is longer than ${MAX_THREAD_LABEL_CHARS} characters.`
                );
            }

            thread.label = label;
        }

        if (record.invocationId !== undefined) {
            thread.invocationId = readSnapshotString(record.invocationId, `${entryLabel}.invocationId`, {
                min: 1
            });
        }

        // DISPLAY LANE (C1). OPTIONAL: a document written before lanes exist restores to
        // lane 0, and an absent key is kept absent so the record's shape matches what
        // `snapshot()` writes. A non-integer or negative lane is refused — a renderer
        // cannot sort one, and `ContextBlock.lane` (../shared/turn-display.ts) promises
        // integer >= 0 — while a written `0` is NORMALIZED AWAY, because a lane of 0 is
        // what absence already means and `snapshot()` never emits the key for it.
        if (record.contextLane !== undefined) {
            const contextLane = readSnapshotInteger(record.contextLane, `${entryLabel}.contextLane`, {
                min: 0
            });

            if (contextLane !== 0) thread.contextLane = contextLane;
        }

        ids.add(id);
        sequences.add(sequence);
        records.push(thread);
    }

    // Owner links are resolved AFTER every id is known, so a snapshot may list a
    // child before its parent without becoming order-dependent.
    for (const [index, thread] of records.entries()) {
        if (thread.ownerThreadId === undefined) continue;

        if (thread.ownerThreadId === thread.id) {
            throw new HarnessError(`${label}[${index}].ownerThreadId must not name the thread itself.`);
        }

        if (!ids.has(thread.ownerThreadId)) {
            throw new HarnessError(
                `${label}[${index}].ownerThreadId names "${thread.ownerThreadId}", which is not present in ${label}.`
            );
        }
    }

    return records;
};

// Read and validate a complete snapshot, returning a detached copy. This is the
// pure half of restore: the harness compiles created tools and checks
// target-specific facts (agent identity, registry collisions, budget) after this
// returns, and only then mutates anything.
export const readHarnessSnapshot = (value: unknown): HarnessSnapshot => {
    const root = readSnapshotRecord(value, 'snapshot');
    readSnapshotKeys(
        root,
        [
            'version',
            'agents',
            'discovery',
            'createdTools',
            'createdToolCount',
            'agentResults',
            'threads',
            'threadSequence',
            'records'
        ],
        'snapshot',
        ['agentResults', 'threads', 'threadSequence']
    );

    const version = readSnapshotInteger(root.version, 'snapshot.version', { min: 1 });

    if (version !== HARNESS_SNAPSHOT_VERSION) {
        throw new HarnessError(
            `Snapshot version ${version} is not supported; this harness reads version ${HARNESS_SNAPSHOT_VERSION}.`
        );
    }

    // Agents: keyed by registry identity. An empty map cannot describe a harness
    // (construction requires at least one agent), so it is a corrupt snapshot.
    const agentRecord = readSnapshotRecord(root.agents, 'snapshot.agents');
    const agentNames = Object.keys(agentRecord);

    if (agentNames.length === 0) {
        throw new HarnessError('snapshot.agents must contain at least one agent.');
    }

    const agents: Record<string, HarnessAgentSnapshot> = {};

    for (const name of agentNames) {
        if (name.trim().length === 0) {
            throw new HarnessError('snapshot.agents has an empty agent name.');
        }

        const label = `snapshot.agents[${JSON.stringify(name)}]`;
        const entry = readSnapshotRecord(agentRecord[name], label);
        readSnapshotKeys(entry, ['model', 'messages'], label);

        agents[name] = {
            model: readSnapshotString(entry.model, `${label}.model`, { min: 1 }),
            messages: readHarnessMessages(entry.messages, `${label}.messages`)
        };
    }

    // Discovery: enabled names keep their order, and each progressive-discovery
    // key is unique so replaying it after a restart is deterministic.
    //
    // `withheld` is the conversation's switch set (names its user has switched off for
    // the agents) and is OPTIONAL: a v2 file written before the feature has no key and
    // restores as "nothing switched off", which is why the version number did not move.
    const discoveryRecord = readSnapshotRecord(root.discovery, 'snapshot.discovery');
    readSnapshotKeys(
        discoveryRecord,
        ['enabled', 'offsets', 'withheld'],
        'snapshot.discovery',
        ['withheld']
    );

    const enabled = readSnapshotArray(discoveryRecord.enabled, 'snapshot.discovery.enabled').map(
        (entry, index) =>
            readSnapshotString(entry, `snapshot.discovery.enabled[${index}]`, { min: 1 })
    );

    const seenEnabled = new Set<string>();

    for (const name of enabled) {
        if (seenEnabled.has(name)) {
            throw new HarnessError(
                `snapshot.discovery.enabled contains the duplicate tool "${name}".`
            );
        }

        seenEnabled.add(name);
    }

    // The conversation's switches, validated LENIENTLY by SHAPE (a non-empty string list)
    // and deduplicated. Unlike `enabled`, an unknown or duplicated name here costs nothing
    // — ../harness.ts `restore` drops what the rebuilt harness cannot register instead of
    // throwing, because a whole conversation must not be lost over a switch that refers to
    // a tool this build no longer has. A list of switches is a SET, so a duplicate is
    // collapsed rather than refused.
    const withheld: string[] =
        discoveryRecord.withheld === undefined
            ? []
            : [
                  ...new Set(
                      readSnapshotArray(discoveryRecord.withheld, 'snapshot.discovery.withheld').map(
                          (entry, index) =>
                              readSnapshotString(entry, `snapshot.discovery.withheld[${index}]`, {
                                  min: 1
                              })
                      )
                  )
              ];

    const offsets: HarnessDiscoveryOffsetSnapshot[] = readSnapshotArray(
        discoveryRecord.offsets,
        'snapshot.discovery.offsets'
    ).map((entry, index) => {
        const label = `snapshot.discovery.offsets[${index}]`;
        const record = readSnapshotRecord(entry, label);
        readSnapshotKeys(record, ['query', 'offset'], label);

        return {
            query: readSnapshotString(record.query, `${label}.query`, { min: 1 }),
            offset: readSnapshotInteger(record.offset, `${label}.offset`, { min: 0 })
        };
    });

    const seenQueries = new Set<string>();

    for (const entry of offsets) {
        if (seenQueries.has(entry.query)) {
            throw new HarnessError(
                `snapshot.discovery.offsets has the duplicate query ${entry.query}.`
            );
        }

        seenQueries.add(entry.query);
    }

    // Created tools: registry order is significant (it decides declaration order),
    // so the array is preserved. Duplicate names are rejected case-insensitively,
    // matching the registry's own collision rule. Compilation happens later.
    const createdTools = readSnapshotArray(root.createdTools, 'snapshot.createdTools').map(
        (entry, index) => readToolCreation(entry, `snapshot.createdTools[${index}]`)
    );

    const seenCreations = new Set<string>();

    for (const creation of createdTools) {
        const key = creation.name.toLowerCase();

        if (seenCreations.has(key)) {
            throw new HarnessError(
                `snapshot.createdTools contains the duplicate tool "${creation.name}".`
            );
        }

        seenCreations.add(key);
    }

    const createdToolCount = readSnapshotInteger(
        root.createdToolCount,
        'snapshot.createdToolCount',
        { min: 0 }
    );

    if (createdToolCount !== createdTools.length) {
        throw new HarnessError(
            `snapshot.createdToolCount is ${createdToolCount}, but snapshot.createdTools has ${createdTools.length} records.`
        );
    }

    // R3 durability: OPTIONAL terminal results. An old snapshot (field absent)
    // restores to an empty registry. The reader validates every record against
    // snapshot.agents and the retention bound, so nothing is accepted partially.
    const agentResults =
        root.agentResults === undefined
            ? undefined
            : readAgentResults(root.agentResults, 'snapshot.agentResults', new Set(agentNames));

    // R2 persistent threads. OPTIONAL pair: both fields are absent (an implicit
    // per-agent default conversation only) or both present. `threadSequence` is
    // the id high-water mark, so it must be at least the largest persisted
    // sequence.
    let threads: HarnessThreadSnapshot[] | undefined;
    let threadSequence: number | undefined;

    if (root.threads !== undefined || root.threadSequence !== undefined) {
        if (root.threads === undefined || root.threadSequence === undefined) {
            throw new HarnessError(
                'snapshot.threads and snapshot.threadSequence must be present together.'
            );
        }

        threads = readThreads(root.threads, 'snapshot.threads', new Set(agentNames));
        threadSequence = readSnapshotInteger(root.threadSequence, 'snapshot.threadSequence', {
            min: 1
        });

        // `threadSequence` is the ID high-water mark (independent of creation
        // order), so it must cover every persisted id's number. An id above the
        // mark would be minted again after a restart.
        for (const thread of threads) {
            const idNumber = Number(thread.id.slice(THREAD_HOST_PREFIX.length));

            if (idNumber > threadSequence) {
                throw new HarnessError(
                    `snapshot.threadSequence is ${threadSequence}, but thread "${thread.id}" is numbered ${idNumber}.`
                );
            }
        }
    }

    // The ONE record store. The key list is NOT checked here: the engine owns the
    // shape (a collection map whose membership is data, because an agent can `define`
    // a collection), so validation is DELEGATED to its reader, which validates every
    // collection against the definition stored beside it (T3).
    const records = readSnapshotRecord(root.records, 'snapshot.records');

    return {
        version: HARNESS_SNAPSHOT_VERSION,
        agents,
        discovery: {
            enabled,
            offsets,
            // Mirrors the writer in ../harness.ts `snapshot()`: the key is present only
            // while something is actually switched off, so a read of a pre-feature file
            // produces the exact document that file held (and a read-modify-write cycle
            // never invents an empty list a byte-diff would have to explain).
            ...(withheld.length === 0 ? {} : { withheld })
        },
        createdTools,
        createdToolCount,
        ...(agentResults === undefined || agentResults.length === 0 ? {} : { agentResults }),
        ...(threads === undefined || threadSequence === undefined
            ? {}
            : { threads, threadSequence }),
        records: readRecordsStoreState(records)
    };
};
