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
//
// Cross-references:
//   - ../types            — HarnessSnapshot and its parts
//   - ./snapshot-validation — primitive readers shared with the store modules
//   - ./todo.ts / profile.ts / chapter.ts / location.ts — record state readers
//   - ../harness.ts       — snapshot()/restore() implementation
//   - ./creation.ts       — compileToolSource, the trusted-source compiler

import { HarnessError } from '../util';
import { validateAttachments } from '../shared/attachments';
import type {
    HarnessAgentSnapshot,
    HarnessDiscoveryOffsetSnapshot,
    HarnessMessage,
    HarnessSnapshot,
    HarnessToolCall,
    ToolCreation
} from '../types';
import { readChapterStoreState } from './chapter';
import { readLocationStoreState } from './location';
import { readProfileStoreState } from './profile';
import {
    isSnapshotRecord,
    readSnapshotArray,
    readSnapshotInteger,
    readSnapshotJsonValue,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';
import { readTodoStoreState } from './todo';

// The only schema this build reads. A snapshot from a future build is rejected by
// version rather than guessed at: migration belongs to whoever changes the shape.
export const HARNESS_SNAPSHOT_VERSION = 1 as const;

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

export const readHarnessMessages = (value: unknown, label: string): HarnessMessage[] =>
    readSnapshotArray(value, label).map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, entryLabel);
        const role = readSnapshotString(record.role, `${entryLabel}.role`, { min: 1 });

        switch (role) {
            case 'system':
                readSnapshotKeys(record, ['role', 'content'], entryLabel);
                return {
                    role,
                    content: readSnapshotString(record.content, `${entryLabel}.content`)
                };

            case 'user': {
                // Attachments are OPTIONAL: a pre-attachment snapshot has only
                // role+content and must keep restoring byte-for-byte. When
                // present, the shared validator re-checks every field (MIME,
                // canonical base64, decoded size, magic signature) and returns
                // detached copies, so a live transcript never aliases a saved
                // object.
                readSnapshotKeys(record, ['role', 'content', 'attachments'], entryLabel, [
                    'attachments'
                ]);

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

                return message;
            }

            case 'assistant': {
                readSnapshotKeys(
                    record,
                    ['role', 'content', 'toolCalls', 'reasoning'],
                    entryLabel,
                    ['toolCalls', 'reasoning']
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

                return message;
            }

            case 'tool': {
                readSnapshotKeys(record, ['role', 'content', 'toolCallId', 'name'], entryLabel);

                return {
                    role: 'tool',
                    content: readSnapshotString(record.content, `${entryLabel}.content`),
                    toolCallId: readSnapshotString(
                        record.toolCallId,
                        `${entryLabel}.toolCallId`,
                        { min: 1 }
                    ),
                    name: readSnapshotString(record.name, `${entryLabel}.name`, { min: 1 })
                };
            }

            default:
                throw new HarnessError(
                    `${entryLabel}.role must be one of: system, user, assistant, tool.`
                );
        }
    });

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
    source: creation.source
});

// Validate one persisted creation record. Field bounds (name pattern, tag caps,
// schema complexity, source length) stay in createDynamicTool, which the restore
// path calls next; this reader only guarantees a JSON-shaped record that can be
// handed to it.
const readToolCreation = (value: unknown, label: string): ToolCreation => {
    const record = readSnapshotRecord(value, label);
    readSnapshotKeys(record, ['name', 'description', 'tags', 'parameters', 'source'], label, [
        'parameters'
    ]);

    const tags = readSnapshotArray(record.tags, `${label}.tags`).map((tag, index) =>
        readSnapshotString(tag, `${label}.tags[${index}]`, { min: 1 })
    );

    const creation: ToolCreation = {
        name: readSnapshotString(record.name, `${label}.name`, { min: 1 }),
        description: readSnapshotString(record.description, `${label}.description`, { min: 1 }),
        tags,
        source: readSnapshotString(record.source, `${label}.source`, { min: 1 })
    };

    if (record.parameters !== undefined) {
        const parameters = readSnapshotJsonValue(record.parameters, `${label}.parameters`);

        if (!isSnapshotRecord(parameters)) {
            throw new HarnessError(`${label}.parameters must be a JSON Schema object.`);
        }

        creation.parameters = parameters;
    }

    return creation;
};

// Read and validate a complete snapshot, returning a detached copy. This is the
// pure half of restore: the harness compiles created tools and checks
// target-specific facts (agent identity, registry collisions, budget) after this
// returns, and only then mutates anything.
export const readHarnessSnapshot = (value: unknown): HarnessSnapshot => {
    const root = readSnapshotRecord(value, 'snapshot');
    readSnapshotKeys(
        root,
        ['version', 'agents', 'discovery', 'createdTools', 'createdToolCount', 'records'],
        'snapshot'
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
    const discoveryRecord = readSnapshotRecord(root.discovery, 'snapshot.discovery');
    readSnapshotKeys(discoveryRecord, ['enabled', 'offsets'], 'snapshot.discovery');

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

    // Record stores: each reader validates its own bounds and returns copies.
    const records = readSnapshotRecord(root.records, 'snapshot.records');
    readSnapshotKeys(records, ['todos', 'profiles', 'chapters', 'locations'], 'snapshot.records');

    return {
        version: HARNESS_SNAPSHOT_VERSION,
        agents,
        discovery: { enabled, offsets },
        createdTools,
        createdToolCount,
        records: {
            todos: readTodoStoreState(records.todos),
            profiles: readProfileStoreState(records.profiles),
            chapters: readChapterStoreState(records.chapters),
            locations: readLocationStoreState(records.locations)
        }
    };
};
