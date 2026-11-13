// Foundation tests for the generated harness contract (src/shared/harness-api.ts and
// src/shared/harness-stream.ts). Two jobs:
//   1. Pin the shared constants/route tables to the exact values the spec states, so a spec edit
//      that changes a number, a path, or a discriminator tag fails here loudly.
//   2. Assert at COMPILE time that every "verbatim alias" still equals the in-repo model it points
//      at, and that the WS unions really are discriminated (narrowing works). Run through
//      `npx tsc` as well as vitest: tsconfig excludes test files from `npm run typecheck`, so the
//      scoped command recorded in the task report is what proves the type assertions.
import { describe, expect, it } from 'vitest';

import {
    HARNESS_API_ROOT,
    HARNESS_EPOCH_HEADER,
    HARNESS_PAGE_LIMIT,
    HARNESS_PATH_TEMPLATES,
    HARNESS_REVISION_HEADER,
    HARNESS_ROUTES,
    HARNESS_SERVICE_CAPABILITIES,
    HARNESS_SERVICE_LIMITS,
    HARNESS_WS_SUBPROTOCOL,
} from './harness-api';
import {
    HARNESS_STREAM_RESOURCE_KINDS,
    HARNESS_WS_CLIENT_MESSAGE_TYPES,
    HARNESS_WS_PROTOCOL_CODES,
    HARNESS_WS_SCOPES,
    HARNESS_WS_SERVER_MESSAGE_TYPES,
    HARNESS_WS_STREAM_LIMITS,
    HARNESS_WS_UPDATE_KINDS,
    isHarnessServerFrame,
} from './harness-stream';
import type {
    AnswerActionResult,
    CreateSessionRequest,
    DisplayState,
    HarnessUsage,
    PageMeta,
    PatchTurnBlockRequest,
    PluginDetailResponse,
    PluginSettingsUpdate,
    PluginSummary,
    PluginSummaryPage,
    SessionDefinitionResource,
    SessionResponse,
    SessionSummaryPage,
    TaskReceipt,
    TranscriptWriteReceipt,
    TurnBlockWriteReceipt,
    TurnDisplay,
    TurnSummaryPage,
    UpdateThreadTranscriptRequest,
} from './harness-api';
import type * as Projector from './turn-display';
import type * as Domain from '../types';
import type {
    WsSubscribe,
    WsSubscribeSession,
    WsUpdate,
    WsUpdateDisplayOps,
    WsUpdateTurnRemoved,
    WsWelcome,
} from './harness-stream';

/** Structural equality (mutual assignability) used for the compile-time alias guards. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time assertion: the declared type must be exactly `true`. */
type Expect<T extends true> = T;

// A replacement value per path parameter name, used to render every template into a concrete URL.
const PARAM_SAMPLES: Record<string, string> = {
    harness_name: 'demo',
    agent_id: 'research',
    tool_id: 'shell',
    plugin_id: 'context-compaction',
    session_id: 'ses_1',
    thread_id: 'thr_1',
    turn_id: 'turn_1',
    step_id: '7',
    block_id: '2-tool-7',
    attachment_id: 'att_1',
    request_id: 'act_1',
};

describe('harness contract root and headers', () => {
    it('exposes /v1/harness as the single root with no /api anywhere', () => {
        expect(HARNESS_API_ROOT).toBe('/v1/harness');
        const roots = Object.values(HARNESS_PATH_TEMPLATES);
        expect(roots.every((path) => path.startsWith('/v1/harness'))).toBe(true);
        expect(roots.some((path) => path.includes('/api'))).toBe(false);
    });

    it('names the epoch and revision headers and the stream subprotocol exactly', () => {
        expect(HARNESS_EPOCH_HEADER).toBe('X-Harness-Epoch');
        expect(HARNESS_REVISION_HEADER).toBe('X-Harness-Revision');
        expect(HARNESS_WS_SUBPROTOCOL).toBe('harness.v1');
    });

    it('states the one paging envelope every collection route shares', () => {
        expect(HARNESS_PAGE_LIMIT).toEqual({ min: 1, default: 25, max: 100 });
        // The published ServiceLimits numbers must agree with the paging constants.
        expect(HARNESS_SERVICE_LIMITS.page_limit_default).toBe(HARNESS_PAGE_LIMIT.default);
        expect(HARNESS_SERVICE_LIMITS.page_limit_max).toBe(HARNESS_PAGE_LIMIT.max);
    });
});

describe('harness contract route tables', () => {
    it('covers all 51 spec paths', () => {
        expect(Object.keys(HARNESS_PATH_TEMPLATES)).toHaveLength(51);
        expect(Object.keys(HARNESS_ROUTES)).toHaveLength(51);
        // R1: the stop's counterpart is addressable with the same two ids, in the same
        // order, so a client builds it exactly the way it builds `cancel`.
        expect(HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdResume('ses_1', 'thr_3')).toBe(
            '/v1/harness/sessions/ses_1/threads/thr_3/resume',
        );
        // T4: the record store read is session-addressed only — its continuation cursor is
        // the `?since=` query, never a path segment, so the builder takes ONE value.
        expect(HARNESS_ROUTES.sessionsBySessionIdRecords('ses_1')).toBe(
            '/v1/harness/sessions/ses_1/records',
        );
    });

    it('renders every path template into the builder output with no leftover placeholders', () => {
        // One rule for both tables: substituting PARAM_SAMPLES into a template must equal the
        // builder called with the same values in path order.
        const mismatches: string[] = [];
        const builders = HARNESS_ROUTES as unknown as Record<string, (...values: string[]) => string>;
        for (const [id, template] of Object.entries(HARNESS_PATH_TEMPLATES)) {
            const params = [...template.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
            const args = params.map((name) => {
                if (!(name in PARAM_SAMPLES)) mismatches.push(`missing sample for {${name}}`);
                return PARAM_SAMPLES[name];
            });
            const rendered = template.replace(/\{([a-z_]+)\}/g, (_m, name) => PARAM_SAMPLES[name]);
            if (typeof builders[id] !== 'function') {
                mismatches.push(`${id}: no builder for this template id`);
            } else {
                const value = builders[id](...args);
                if (value !== rendered) mismatches.push(`${id}: ${value} != ${rendered}`);
            }
            if (rendered.includes('{') || rendered.includes('}')) {
                mismatches.push(`${id}: unresolved placeholder in ${rendered}`);
            }
        }
        expect(mismatches).toEqual([]);
    });

    it('builds the deep addressable reads one level at a time', () => {
        expect(HARNESS_ROUTES.root()).toBe('/v1/harness');
        expect(HARNESS_ROUTES.health()).toBe('/v1/harness/health');
        expect(HARNESS_ROUTES.stream()).toBe('/v1/harness/stream');
        expect(HARNESS_ROUTES.sessionsBySessionIdTasks('ses_1')).toBe(
            '/v1/harness/sessions/ses_1/tasks',
        );
        expect(HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdDisplay('ses_1', 'turn_9')).toBe(
            '/v1/harness/sessions/ses_1/turns/turn_9/display',
        );
        expect(HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages('ses_1', 'thr_3')).toBe(
            '/v1/harness/sessions/ses_1/threads/thr_3/transcript/messages',
        );
        expect(
            HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId('ses_1', 'turn_9', 'att_2'),
        ).toBe('/v1/harness/sessions/ses_1/turns/turn_9/attachments/att_2');
        expect(
            HARNESS_ROUTES.sessionsBySessionIdActionsByRequestIdAnswer('ses_1', 'act_4'),
        ).toBe('/v1/harness/sessions/ses_1/actions/act_4/answer');
        expect(
            HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId('demo', 'research'),
        ).toBe('/v1/harness/harnesses/demo/instructions/research');
        // T5 (R2/R3): the plugin catalogue, and its settings-only item route.
        expect(HARNESS_ROUTES.plugins()).toBe('/v1/harness/plugins');
        expect(HARNESS_ROUTES.pluginsByPluginId('context-compaction')).toBe(
            '/v1/harness/plugins/context-compaction',
        );
        // R4: the SESSION-scoped pair. Same item shape as the global pair, addressed by the
        // session first — and the row/body schemas are the same generated types, which is why
        // the regenerated contract grew by exactly these two templates and no new schema.
        expect(HARNESS_ROUTES.sessionsBySessionIdPlugins('ses_1')).toBe('/v1/harness/sessions/ses_1/plugins');
        expect(HARNESS_ROUTES.sessionsBySessionIdPluginsByPluginId('ses_1', 'context-compaction')).toBe(
            '/v1/harness/sessions/ses_1/plugins/context-compaction',
        );
    });
});

describe('harness contract published numbers', () => {
    it('publishes the exact ServiceLimits block from the boot document', () => {
        expect(HARNESS_SERVICE_LIMITS).toEqual({
            body_bytes: 1000000,
            submit_body_bytes: 16777216,
            input_chars: 200000,
            pending_tasks: 100,
            thread_records: 256,
            attachments_per_turn: 4,
            attachment_bytes: 4194304,
            total_attachment_bytes: 8388608,
            result_references: 16,
            pending_actions: 4,
            steer_records: 64,
            created_tools: 32,
            tool_result_bytes: 262144,
            page_limit_default: 25,
            page_limit_max: 100,
        });
    });

    it('publishes a tool_result_bytes that matches the cap the server enforces', async () => {
        // The published limit is a literal (this module is shared with the browser and
        // imports only types), so nothing but this assertion stops it drifting from the
        // value `boundToolValue` actually applies. A client that trusts a stale number
        // would truncate results the server was happy to send.
        const { MODEL_TOOL_RESULT_BUDGET_BYTES } = await import('../core/result-budget');

        expect(HARNESS_SERVICE_LIMITS.tool_result_bytes).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES);
    });

    it('advertises all nine capabilities as booleans', () => {
        expect(HARNESS_SERVICE_CAPABILITIES).toEqual({
            websocket_stream: true,
            tool_execution: true,
            tool_registration: true,
            transcript_editing: true,
            command_dispatch: true,
            model_discovery: true,
            harness_definition_writes: true,
            agent_writes: true,
            persistent_threads: true,
        });
    });
});

describe('harness stream contract', () => {
    it('carries the exact WsStreamLimits defaults in force', () => {
        expect(HARNESS_WS_STREAM_LIMITS).toEqual({
            subscriptions_per_connection: 64,
            ops_per_update_frame: 32,
            delta_chars_per_append_op: 2000,
            events_per_update_frame: 16,
            ids_per_invalidation_frame: 64,
            max_client_frame_bytes: 16384,
            max_server_frame_bytes: 65536,
            client_messages_per_second: 32,
            heartbeat_interval_ms: 15000,
            heartbeat_timeout_intervals: 3,
            heartbeat_timeout_close_code: 4408,
            replay_frames: 512,
            replay_seconds: 60,
            send_queue_frames: 256,
            send_queue_bytes: 1048576,
            sustained_stall_ms: 10000,
            ack_timeout_ms: 5000,
            // Pinned to `x-websocket.limits.revision_records_per_state` in
            // src/server/harness.swagger.yaml, which equals the `StreamResourceKind` count —
            // the assertion under this one is the machine check that the two cannot drift.
            revision_records_per_state: 21,
        });
        // The constant-size guarantee the stream rests on: one revision record per published kind.
        expect(HARNESS_WS_STREAM_LIMITS.revision_records_per_state).toBe(
            HARNESS_STREAM_RESOURCE_KINDS.length,
        );
    });

    it('enumerates the closed client and server frame vocabularies', () => {
        expect(HARNESS_WS_CLIENT_MESSAGE_TYPES).toEqual([
            'hello',
            'subscribe',
            'unsubscribe',
            'ack',
            'ping',
            'bye',
        ]);
        expect(HARNESS_WS_SERVER_MESSAGE_TYPES).toEqual([
            'welcome',
            'subscription_state',
            'update',
            'resync_required',
            'error',
            'heartbeat',
            'pong',
        ]);
        expect(HARNESS_WS_SCOPES).toEqual(['global', 'session', 'thread', 'turn']);
    });

    it('enumerates the sixteen update kinds in spec order', () => {
        expect(HARNESS_WS_UPDATE_KINDS).toEqual([
            'session.updated',
            'turn.upsert',
            'turn.removed',
            'display.ops',
            'usage.updated',
            'action.opened',
            'action.closed',
            'thread.upsert',
            'thread.removed',
            'transcript.updated',
            // T4: the record store's wake-up kind. Its place in this array is the yaml's
            // `WsUpdateKind.enum` order (src/server/harness.swagger.yaml), and it sits with
            // the other session-scoped identity kinds, right after the transcript.
            'records.updated',
            'tool.registry_updated',
            'agent.registry_updated',
            'run.event',
            'catalogue.updated',
            'config.updated',
        ]);
    });

    it('enumerates the nine protocol error codes', () => {
        expect(HARNESS_WS_PROTOCOL_CODES).toEqual([
            'invalid_payload',
            'unknown_subscription',
            'unknown_resource',
            'unsupported_filter',
            'late_hello',
            'too_many_subscriptions',
            'frame_too_large',
            'rate_limited',
            'internal',
        ]);
    });

    it('accepts only frames whose tag is in the server vocabulary', () => {
        expect(isHarnessServerFrame({ type: 'welcome', epoch: '9f2c17a4', limits: HARNESS_WS_STREAM_LIMITS })).toBe(true);
        expect(isHarnessServerFrame({ type: 'update', kind: 'turn.removed' })).toBe(true);
        expect(isHarnessServerFrame({ type: 'made_up_frame' })).toBe(false);
        expect(isHarnessServerFrame({ type: 1 })).toBe(false);
        expect(isHarnessServerFrame({})).toBe(false);
        expect(isHarnessServerFrame(null)).toBe(false);
        expect(isHarnessServerFrame('update')).toBe(false);
        expect(isHarnessServerFrame(7)).toBe(false);
    });
});

describe('harness contract DTO shapes', () => {
    it('pages carry limit, next_cursor, observed_at and revision', () => {
        // Exact PageMeta fields: `next_cursor` is nullable, never absent-by-design.
        type PageShape = Required<Omit<PageMeta, 'next_cursor'>> & Pick<PageMeta, 'next_cursor'>;
        const page: PageShape = { limit: 25, next_cursor: null, observed_at: 1762250000000, revision: 0 };
        const filled: PageShape = {
            limit: 100,
            next_cursor: 'eyJlIjoiOWYyYzE3YTQiLCJzIjo0Mn0',
            observed_at: 1762250000001,
            revision: 42,
        };
        expect(page.next_cursor).toBeNull();
        expect(filled.limit).toBe(100);
        expect(filled.revision).toBe(42);
    });

    it('writes answer with receipts, never an aggregate tree', () => {
        // A submit answers one receipt: the minted turn, its thread, and the session revision it landed at.
        const receipt: TaskReceipt = {
            session_id: 'ses_1',
            turn_id: 'turn_1',
            thread_id: 'thr_1',
            status: 'queued',
            session_revision: 7,
            accepted_at: 1762250000000,
            links: {
                turn: HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId('ses_1', 'turn_1'),
                turns: HARNESS_ROUTES.sessionsBySessionIdTurns('ses_1'),
                thread: HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadId('ses_1', 'thr_1'),
                stream: HARNESS_ROUTES.stream(),
            },
        };
        expect(receipt.status).toBe('queued');
        expect(receipt.links.stream).toBe('/v1/harness/stream');

        const transcriptWrite: TranscriptWriteReceipt = {
            session_id: 'ses_1',
            thread_id: 'thr_1',
            accepted_as: 'transcript',
            message_count: 12,
            revision: 4,
        };
        expect(transcriptWrite.revision).toBe(4);

        const actionAnswer: AnswerActionResult = {
            ok: true,
            request_id: 'act_1',
            resolved_at: 1762250000001,
        };
        expect(actionAnswer.ok).toBe(true);
    });

    it('sends no eager history when creating or paging a session', () => {
        // CreateSessionRequest carries the definition name and settings only: no transcript, no turns.
        const create: CreateSessionRequest = { harness: 'demo' };
        expect(create).toEqual({ harness: 'demo' });

        // A session page carries summaries; `SessionResponse` carries one resource, no tree.
        type SessionPageKeys = keyof SessionSummaryPage;
        const pageKeys: SessionPageKeys[] = ['items', 'limit', 'next_cursor', 'observed_at', 'revision'];
        expect(pageKeys).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        type TurnPageKeys = keyof TurnSummaryPage;
        const turnKeys: TurnPageKeys[] = ['items', 'limit', 'next_cursor', 'observed_at', 'revision'];
        expect(turnKeys).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        // The one optimistic lock in the contract lives on transcript replacement.
        type TranscriptWriteFields = keyof UpdateThreadTranscriptRequest;
        const fields: TranscriptWriteFields[] = ['messages', 'if_revision'];
        expect(fields).toEqual(['messages', 'if_revision']);
    });

    // R2/R3: the frozen-definition read is the resource a SAVED session paints swatches from, so
    // `agent_colors` has to be part of `SessionDefinitionResource`, not only of `HarnessDefinition`.
    // The spec gets there through the schema's `allOf` branch, so the guard is a type probe: a
    // future spec edit that drops the field, renames it, or changes its value shape fails to
    // COMPILE here (this file is excluded from `npm run typecheck`, so `npx tsc` on it is the
    // proving command).
    it('carries the per-agent display colors on both definition reads', () => {
        type CardColors = import('./harness-api').HarnessDefinition['agent_colors'];
        type FrozenColors = import('./harness-api').SessionDefinitionResource['agent_colors'];

        // The session copy names the SAME optional map (agent id -> hex string) as the global
        // identified read; `Equal` is mutual assignability, so a rename or a narrowed value type
        // on either side fails the declaration below.
        const sameMapOnBothReads: Expect<Equal<FrozenColors, CardColors>> = true;

        expect(sameMapOnBothReads).toBe(true);

        // A wire-shaped frozen read that states colors is assignable, and the map keys are plain
        // agent ids. Required fields are spelled out so a spec edit that makes one optional (or
        // adds one) surfaces here rather than in a `Partial`.
        const frozen: SessionDefinitionResource = {
            name: 'painted',
            title: 'Painted',
            description: 'Two-member fixture with one configured swatch.',
            requires_endpoint: false,
            primary: 'research',
            subagents: ['summarizer'],
            agents: ['research', 'summarizer'],
            tools: ['timeNow'],
            builtin: false,
            definition_revision: 3,
            agent_colors: { summarizer: '#4ade80' },
            session_id: 'ses_1',
            revision: 3,
            frozen_at: 1762250000000,
            source_revision: 3,
            current_revision: 3,
            current: true
        };

        // Byte-for-byte the map the server emits: `sessionDefinitionOf` (src/server/api-reads.ts)
        // copies the frozen `HarnessDescriptor.agentColors` map, and OMITS the key entirely when
        // that map is empty, so an uncolored session keeps the exact pre-R2 row.
        expect(frozen.agent_colors).toEqual({ summarizer: '#4ade80' });

        const uncolored: SessionDefinitionResource = { ...frozen };

        delete uncolored.agent_colors;
        expect(Object.hasOwn(uncolored, 'agent_colors')).toBe(false);
    });

    // T5 (R2/R3): the Plugins pane edits a plugin's settings from ONE read, so the row must
    // carry the declared descriptor (with its `default`, the reset target) beside the effective
    // `values`. The patch body uses the same key spelling as `values`, which is what makes the
    // pane's write a "send back what you edited" round trip rather than a second vocabulary.
    it('carries a plugin row with its declared settings and effective values', () => {
        // Closed object: the row's key set is the contract's set and nothing else. The list
        // below names ALL 11 keys the generated `PluginSummary` declares
        // (../shared/harness-api.ts), in that same generated order — `system_prompt`
        // (2026-11-12) and `enabled` (R2) included, because a list that omits one of them is a
        // subset, not the contract. It is a hand-maintained mirror: a key the schema adds and
        // this list forgets still compiles, so the list has to grow with the schema.
        type PluginRowKeys = keyof PluginSummary;
        const rowKeys: PluginRowKeys[] = [
            'name',
            'title',
            'description',
            'system_prompt',
            'version',
            'tags',
            'hooks',
            'builtin',
            'enabled',
            'settings',
            'values'
        ];

        expect(rowKeys).toEqual([
            'name',
            'title',
            'description',
            'system_prompt',
            'version',
            'tags',
            'hooks',
            'builtin',
            'enabled',
            'settings',
            'values'
        ]);

        // A wire-shaped row for the shipped context-compaction plugin: the descriptor states the
        // bounds an editor offers, and `values` states what the runtime reads right now.
        const row: PluginSummary = {
            name: 'context-compaction',
            title: 'Context Compaction',
            description: 'Compacts a conversation at the turn boundary.',
            version: '1.0.0',
            tags: ['context', 'compaction'],
            hooks: ['turn.before'],
            builtin: true,
            settings: [
                {
                    key: 'contextLimit',
                    label: 'Context limit (tokens)',
                    type: 'number',
                    default: 100000,
                    min: 1000,
                    step: 1000
                }
            ],
            values: { contextLimit: 200000 }
        };

        // `step` stays an EDITOR hint on the wire: the server accepts an off-step value, so the
        // DTO must not imply otherwise, and an unset optional is absent rather than null.
        expect(Object.hasOwn(row.settings[0], 'max')).toBe(false);
        expect(row.settings[0].default).toBe(100000);
        expect(row.values.contextLimit).toBe(200000);

        const page: PluginSummaryPage = {
            limit: 2,
            next_cursor: null,
            observed_at: 1762250000000,
            revision: 1,
            items: [row]
        };

        expect(page.items[0].name).toBe('context-compaction');
        expect(page.revision).toBe(1);

        const write: PluginSettingsUpdate = { settings: { contextLimit: 200000 } };
        const reset: PluginSettingsUpdate = { settings: { contextLimit: null } };

        expect(write).toEqual({ settings: { contextLimit: 200000 } });
        expect(reset.settings.contextLimit).toBeNull();

        const detail: PluginDetailResponse = { plugin: row };

        expect(detail.plugin.settings).toHaveLength(1);
    });
});

describe('harness contract type wiring (compile time)', () => {
    it('aliases stay identical to the in-repo models they reuse', () => {
        // Each Expect<...> fails to COMPILE if the spec shape and the in-repo model drift apart.
        type AliasGuards = [
            Expect<Equal<DisplayState, Projector.TurnDisplayState>>,
            Expect<Equal<Projector.SectionDisplayState, import('./harness-api').SectionDisplayState>>,
            Expect<Equal<Projector.StepDisplayState, import('./harness-api').StepDisplayState>>,
            Expect<Equal<Projector.DisplayBlockSummary, import('./harness-api').DisplayBlockSummary>>,
            Expect<
                Equal<Projector.DisplayAttachmentSummary, import('./harness-api').DisplayAttachmentSummary>
            >,
            Expect<Equal<Projector.DisplayTail, import('./harness-api').DisplayTail>>,
            Expect<Equal<Domain.HarnessUsage, HarnessUsage>>,
            Expect<Equal<Domain.HarnessErrorInfo, import('./harness-api').HarnessErrorInfo>>,
            Expect<Equal<Domain.HarnessMessage, import('./harness-api').HarnessMessage>>,
            Expect<Equal<Domain.HarnessThread, import('./harness-api').HarnessThread>>,
            Expect<Equal<Domain.HarnessAttachment, import('./harness-api').HarnessAttachment>>,
            Expect<Equal<Domain.HarnessToolCall, import('./harness-api').HarnessToolCall>>,
            Expect<Equal<Domain.HarnessPendingTool, import('./harness-api').HarnessPendingTool>>,
            Expect<Equal<Domain.HarnessActionRequest, import('./harness-api').HarnessActionRequest>>,
            Expect<Equal<Domain.HarnessActionOption, import('./harness-api').HarnessActionOption>>,
            Expect<Equal<Domain.ToolMediaDescriptor, import('./harness-api').ToolMediaDescriptor>>,
            Expect<
                Equal<
                    import('./agent-results').AgentResultReference,
                    import('./harness-api').AgentResultReference
                >
            >,
        ];
        const guards: AliasGuards = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
        expect(guards.every((guard) => guard)).toBe(true);
    });

    // HAND-MAINTAINED BLOCKS (C1 follow-up): two regenerations of this file collapsed
    // `PatchTurnBlockRequest` to `unknown | unknown` and stripped the property doc blocks of
    // `TurnBlockWriteReceipt`, because the spec's `anyOf` members
    // (src/server/harness.swagger.yaml:8417-8419) carry only `required` with no `properties`,
    // which the renderer turns into `unknown` (scripts/generate-harness-contract.mjs:141-142
    // and :183). `unknown` accepts ANY value, so plain assignability cannot see the collapse —
    // hence `keyof` and indexed-access probes: both are errors on `unknown`, so the collapse
    // fails to COMPILE here (this file is excluded from `npm run typecheck`; the scoped `npx
    // tsc` run recorded in the task report is what proves it) instead of surfacing as the
    // server's two `body.<axis>` reads going red (src/server/api.ts:4602-4620). The dropped
    // doc comments are a generator gap, recorded in docs/issues/.
    it('keeps the block-detail write body and receipt reachable through their declared keys', () => {
        // EXACT KEY SETS, both directions. `keyof unknown` is `never`, so a collapsed member
        // cannot even hold the literals below; the `Equal` guards the other direction, so a
        // regenerated member that ADDS or renames a key fails too.
        type PatchFieldSet = Equal<keyof PatchTurnBlockRequest, 'included' | 'reasoningIncluded'>;
        type ReceiptFieldSet = Equal<
            keyof TurnBlockWriteReceipt,
            | 'session_id'
            | 'turn_id'
            | 'block_id'
            | 'included'
            | 'reasoning_included'
            | 'thread_id'
            | 'revision'
            | 'links'
        >;
        const fieldSets: [Expect<PatchFieldSet>, Expect<ReceiptFieldSet>] = [true, true];

        expect(fieldSets).toEqual([true, true]);

        // THE TWO AXES the route validates, with their exact declared types (an optional
        // boolean reads as `boolean | undefined`, which is what lets `api.ts` tell "absent"
        // from `false` before it picks the join).
        const axisTypes: [
            Expect<Equal<PatchTurnBlockRequest['included'], boolean | undefined>>,
            Expect<Equal<PatchTurnBlockRequest['reasoningIncluded'], boolean | undefined>>
        ] = [true, true];

        expect(axisTypes).toEqual([true, true]);

        // A wire-shaped body of each kind the route accepts. `satisfies` re-checks the literal
        // against the declared member, so a `properties`-less regeneration that lands on
        // `unknown` still has to keep these keys spelled here — and any stray key is rejected.
        const unitWrite = { included: false } satisfies PatchTurnBlockRequest;
        const thinkingWrite = { included: true, reasoningIncluded: false } satisfies PatchTurnBlockRequest;

        expect(unitWrite).toEqual({ included: false });
        expect(thinkingWrite).toEqual({ included: true, reasoningIncluded: false });

        // THE RECEIPT the route answers with (src/server/api.ts:4715-4727), spelled field by
        // field: the thinking-axis read-back and the links are optional, so both shapes must
        // stay assignable and the required four must stay required.
        const thinkingReceipt: TurnBlockWriteReceipt = {
            session_id: 'ses_1',
            turn_id: 'turn_1',
            block_id: '2-reasoning-3',
            included: true,
            reasoning_included: true,
            thread_id: 'thr_1',
            revision: 4,
            links: {
                block: HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdBlocksByBlockId('ses_1', 'turn_1', '2-reasoning-3'),
                transcript: HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript('ses_1', 'thr_1')
            }
        };
        const unitReceipt: TurnBlockWriteReceipt = {
            session_id: 'ses_1',
            turn_id: 'turn_1',
            block_id: '2-tool-7',
            included: false
        };

        // Byte-for-byte the two receipts, including the exact link strings the route builds.
        expect(thinkingReceipt).toEqual({
            session_id: 'ses_1',
            turn_id: 'turn_1',
            block_id: '2-reasoning-3',
            included: true,
            reasoning_included: true,
            thread_id: 'thr_1',
            revision: 4,
            links: {
                block: '/v1/harness/sessions/ses_1/turns/turn_1/blocks/2-reasoning-3',
                transcript: '/v1/harness/sessions/ses_1/threads/thr_1/transcript'
            }
        });
        expect(unitReceipt).toEqual({ session_id: 'ses_1', turn_id: 'turn_1', block_id: '2-tool-7', included: false });

        // The optional pair stays OPTIONAL (an unset field is ABSENT, never `null`), which is
        // what the route's conditional spread and the dialog's chip both rely on.
        expect(Object.hasOwn(unitReceipt, 'reasoning_included')).toBe(false);
        expect(Object.hasOwn(unitReceipt, 'links')).toBe(false);
        expect(unitReceipt.links).toBeUndefined();
    });

    it('narrows update frames on kind and message frames on type', () => {
        const removed: WsUpdateTurnRemoved = {
            type: 'update',
            subscription_id: 'sub_1',
            sequence: 3,
            cursor: 'c3',
            at: 1762250000003,
            kind: 'turn.removed',
            turn_id: 'turn_1',
        };
        const displayOps: WsUpdateDisplayOps = {
            type: 'update',
            subscription_id: 'sub_1',
            sequence: 4,
            cursor: 'c4',
            at: 1762250000004,
            kind: 'display.ops',
            turn_id: 'turn_1',
            ops: [{ op: 'node:append', turnId: 'turn_1', sectionId: '1', nodeId: '7', delta: 'hel' }],
        };

        // A frame typed as the union narrows on `kind`; the payload field is only reachable there.
        const frame: WsUpdate = removed;
        let seen = '';
        if (frame.kind === 'turn.removed') seen = frame.turn_id;
        expect(seen).toBe('turn_1');
        expect(displayOps.ops[0].op).toBe('node:append');

        const welcome: WsWelcome = {
            type: 'welcome',
            protocol: HARNESS_WS_SUBPROTOCOL,
            epoch: '9f2c17a4',
            at: 1762250000000,
            limits: HARNESS_WS_STREAM_LIMITS,
        };
        const message: import('./harness-stream').WsServerMessage = welcome;
        expect(message.type).toBe('welcome');

        // Subscribing is scope-discriminated, and a session scope needs only session_id.
        const subscribe: WsSubscribe = {
            type: 'subscribe',
            subscription_id: 'sub_1',
            scope: 'session',
            session_id: 'ses_1',
        } satisfies WsSubscribeSession;
        expect(subscribe.scope).toBe('session');

        // Display tree is the turn-scoped read: sections only, no recorded event array, no transcript.
        const display: TurnDisplay = {
            turnId: 'turn_1',
            revision: 2,
            sections: [],
        };
        expect(display.sections).toEqual([]);

        const response: SessionResponse = { session: { id: 'ses_1', revision: 1 } as never };
        expect(response.session.id).toBe('ses_1');
    });
});
