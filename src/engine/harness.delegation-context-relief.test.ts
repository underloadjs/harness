// T6 (2026-11-17) — WHAT A SPAWNER IS ANSWERED, AND WHAT ITS NEXT REQUEST CARRIES.
//
// Two spawner-facing rules, pinned as OBSERVABLE facts about messages the parent can see (never
// about a private helper), so they survive refactors:
//
//   D-1  THE ANSWER THAT CROSSES THE DELEGATION DOOR IS THE TASK ANSWER, never one of the child's
//        own context-relief notes. A summarize pass commits a tool-free prose turn (the structured
//        summary the compaction instruction asked for) — byte-for-byte the shape the run loop exits
//        terminally on. Three doors used to hand that prose to the spawner: the blank-turn rescue
//        (`resolveRunAnswer`, ../harness.ts:13066/:13096), the answer-so-far recording (:13519) and
//        the cancellation report (`run.partialContent`, :13654 → `lastSubstantiveText`, :13001,
//        whose compaction skip is :13018). The compaction ENTRY stays in the child's own transcript
//        — `threadRead` / `agentResult` still answer for it — it is simply not what the child said
//        about the task, and the parent has no business seeing that its child compacted.
//
//   D-3  A RUN'S OWN REQUEST IS BOUNDED BY WHAT IT JUST RECEIVED. A spawner that fans out parks in
//        `waitForWork` while its children work, so NO `turn.before` boundary runs during the wait
//        and every answer of the round lands in ONE step function the estimate could not price
//        (each in-flight call projects a ~200-byte `status:'pending'` placeholder). At the boundary
//        of the request that would carry the pile, `relieveDeliveryWeight` (../harness.ts:9560,
//        wired into `requestOf` at :12544) measures the `tool` entries inserted since
//        `run.deliveryMark` (:12773) and takes the excess out of THAT REQUEST with the shipped
//        planner (`planCompactionRequest`, ./plugins/context-compaction.plugin.ts:1396).
//        Request-only means: nothing is deleted, no inclusion flag moves, the canonical transcript
//        keeps every byte, and the newest round — the answers the run delegated — is verbatim.
//
// WHY THE D-1 SCENARIOS RUN ON A HOST THREAD. The plugin only queues its continuation INTO the run
// that is still running when that run reports `depth >= 2` (./plugins/context-compaction.plugin.ts
// `turnAfter`), and a delegated child of a HOST-thread parent is exactly that
// (./harness.compaction-delegation.test.ts:671 pins `run.started:<child>:researcher:d2`). From the
// entry agent's own DEFAULT conversation the child run is `d1`, the nudge arrives as a separate
// out-of-band run, and the summarize turn terminates it — the main-thread half that is deliberately
// UNCHANGED. So a mid-task compaction is only reachable here through `createThread`.
//
// NOT pinned here on purpose: the child's compaction mechanics (the summarize pass, the park, the
// in-run continuation) belong to ./harness.compaction-delegation.test.ts and
// ./plugin/context-compaction.test.ts. This file reads consequences at the parent's door.
//
// Cross-references:
//   - ./harness.ts                             — the loop, the delegation doors, the relief pass
//   - ./plugins/context-compaction.plugin.ts   — COMPACTION_MARKER (:565), isCompactionAnswerTurn
//     (:1241), planCompactionRequest (:1396)
//   - ./harness.compaction-delegation.test.ts  — the SEED/LIMIT/`summarizeSettings` fixtures copied here
//   - ./core/result-budget.ts                  — MODEL_TOOL_RESULT_BUDGET_TOKENS / MODEL_TOKEN_BYTES,
//     the two constants `DELIVERY_RELIEF_ALLOWANCE_CHARS` (../harness.ts:602) is derived from

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    HarnessPluginSettingsProvider,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// Rank letters for the fan-out roster below come from the kernel's own type, the same
// relative specifier ./harness.delegation.test.ts:54 uses.
import type { AgentRank } from './types';

// The protocol strings are imported, never re-pasted, so a protocol change moves these pins too.
import { COMPACTION_INSTRUCTION } from './plugins/context-compaction.plugin';

// ---------------------------------------------------------------------------
// Scripted transport + transcript readers (the shapes ./harness.compaction-delegation.test.ts and
// ./harness.delegation.test.ts use; none are exported there, so they are copied, not imported)
// ---------------------------------------------------------------------------

const MODEL = 'merge/ds4-flash';

// One scripted frame list per PROVIDER REQUEST (the last list repeats), recording every request.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);

        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// A tool round is ONE frame list. `prose` is what the model said WHILE asking: assistant TEXT is the
// only thing a cancellation report may quote (../harness.ts:12996-13000), so a call with no prose
// would leave the run with nothing substantive to report and the pin could not tell `WORKING` from
// an absent field.
const callTool = (id: string, name: string, args: string, prose?: string): HarnessStreamEvent[] => [
    ...(prose === undefined ? [] : ([{ type: 'text', delta: prose }] as HarnessStreamEvent[])),
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// ONE assistant frame asking for SEVERAL children at once — the fan-out whose delivery lands on the
// spawner as one step function between two provider requests.
const callTools = (calls: [string, string, string][]): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: calls.map(([id, name, arguments_]) => ({ id, name, arguments: arguments_ }))
    }
];

const contentOf = (message: unknown): string => {
    const raw = message as { content?: unknown };

    return typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '');
};

const roleOf = (message: unknown): string => String((message as { role?: unknown }).role ?? '');

const entriesOf = (request: HarnessStreamRequest | undefined): unknown[] =>
    (request?.messages ?? []) as unknown[];

// The `tool` entries of one provider request, in order — exactly what the model was told about the
// work it asked for. This is the parent-facing surface, so a pin here needs no thread-id guessing.
const fedResults = (request: HarnessStreamRequest | undefined): string[] =>
    entriesOf(request)
        .filter((message) => roleOf(message) === 'tool')
        .map((message) => contentOf(message));

// Attach handlers immediately so a rejection never becomes unhandled, and expose the settled state
// so a test can prove a submission is STILL PENDING at an instant (./harness.delegation.test.ts:159).
const probe = <T,>(promise: Promise<T>) => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
        status: 'pending'
    };

    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );

    return state;
};

// `threads()` is how a test OBSERVES ids (the runtime's rule: ids are never invented), and
// `agentResult` is the durable terminal record for one invocation
// (./harness.delegation.test.ts:253-270).
const recordOf = async (instance: any, agentName: string, invocationId: string) =>
    (await instance.executeTool('agentResult', { agent: agentName, invocationId })) as Record<string, any>;

// ---------------------------------------------------------------------------
// Bounded waits — every one of them FAILS rather than hangs
// ---------------------------------------------------------------------------

const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (
    predicate: () => boolean,
    options: { attempts?: number; stable?: number; tickMs?: number } = {}
): Promise<boolean> => {
    const attempts = options.attempts ?? 80;
    const stable = options.stable ?? 1;
    const tickMs = options.tickMs ?? 10;
    let streak = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await flush();
        if (tickMs > 0) await sleep(tickMs);

        streak = predicate() ? streak + 1 : 0;
        if (streak >= stable) return true;
    }

    return false;
};

// A transition that never happens becomes `false` (a failed assertion), never a hung file.
const reachedWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    await Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

const deferred = <T,>() => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

// `context-trimmer` OFF is mandatory: it is the other shipped `turn.before` pass, and leaving it on
// measures two plugins at once (./plugin/context-compaction.test.ts:572-582).
//
// `headroomRatio: 0` is the documented opt-out, and both describe blocks need it for the same
// reason their sizing block derives `LIMIT` against the plain number the operator typed (X2, F3 took
// the buffer off the "declared window only" gate, so it now comes off EVERY binding ceiling): the
// D-1 case wants the child's compaction to be caused by the SEEDED tool round — the file's whole
// "the overflow is the child's" premise — and the F4 control wants no compaction in flight AT ALL.
// On the declared 0.15 both premises break (the child's opening round, 8,102 unanchored tokens, is
// already over 8,625 − 4,312, so its first request would be the compaction instruction). Where the
// buffer itself is pinned: the `resolveContextHeadroom` / `resolveContextTrigger` tables and the
// handler-level F3 case in ./plugin/context-compaction.test.ts.
const summarizeSettings = (limit: number): HarnessPluginSettingsProvider => {
    const stored: Record<string, number | string | boolean> = {
        contextLimit: limit,
        minTokens: 0,
        headroomRatio: 0,
        mode: 'summarize',
        recentTokens: 400,
        recentRounds: 1,
        summaryChars: 200
    };

    return {
        get: (plugin, key) => {
            if (plugin === 'context-trimmer' && key === 'enabled') return false;

            return plugin === 'context-compaction' ? stored[key] : undefined;
        }
    };
};

// ---------------------------------------------------------------------------
// D-1 — a compaction note is the CHILD'S context business, never the parent's answer
// ---------------------------------------------------------------------------

// 2100 characters = 526 transcript-only tokens (1,920 real + 2 escaped newlines + 4 quotes), the
// same seed the single-thread summarize fixture uses. The seed rides in the CHILD's transcript as a
// tool result, which is what carries the CHILD's estimate past the limit on its second round.
const SEED = 'x'.repeat(2100);
// THE SAME SIZING as ./harness.compaction-delegation.test.ts:143-176, re-derived here (the tool
// catalogue is inside every unanchored `turn.before` estimate — harness.ts serializes the declared
// tools and core/context-estimate.ts adds those bytes before the /4), so a limit can no longer sit
// below a thread's catalogue floor:
//   parent (writer)    catalogue = 43,827 serialized bytes / 4 -> 10,957 tokens
//   child  (researcher) catalogue = 36,115 serialized bytes / 4 ->  9,029 tokens
// floors: probe Temp/fix-f5/probe-floors.ts (shape C — the same `presets: false` writer/researcher
// roster with ranks A/B and the one `seed` tool this file builds), re-measured 2026-11-25 for the
// +1,976 B F1's threadList/threadSend disclosure added to every declared catalogue. The floors this
// block used to quote (9,946 / 8,095) were already stale at pristine HEAD, where that probe
// measured 41,851 and 34,139 bytes.
// probe: src/plugins/context-compaction.plugin.ts `turnBefore`, sampled per boundary
//   writer    10 958 = floor 10 957 + transcript 1      (parent, round 1)
//   researcher  9 036 = floor  9 029 + transcript 7      (child, round 1)
//   researcher  9 570 = floor  9 029 + transcript 541    (child, round 2 — the seed tool result)
//   writer    11 031 = floor 10 957 + transcript 74      (parent, round 2)
// `LIMIT` therefore sits ABOVE the child's floor (so its clipped compaction request can fit, and
// the dead-run guard in ./plugins/context-compaction.plugin.ts lets the pass run) and BELOW its
// seeded round (9 570), so exactly ONE summarize pass runs — on the subthread. The parent crosses
// the same limit from its own 10 957 floor and its pass is REFUSED by that guard, which is what keeps
// the case at one pass and three child requests; the parent's estimate is not what stops it.
const CHILD_CATALOGUE = 9_029;
const LIMIT = CHILD_CATALOGUE + 530;

const BRIEF_TASK = 'dig into the seeded report';
const SUMMARY = 'SUMMARY';
// THE STREAMED HALF of it (X2, F4): the fragment that sits in `run.streamedText` when the cut
// lands between the instruction commit and the summary's `done` frame. Spelled so it shares no
// substring with `SUMMARY`, which keeps "the buffer won" (`partialContent === SUMMARY_HALF`)
// distinguishable from "the committed-text walk won" (`partialContent === WORKING`).
const SUMMARY_HALF = 'RELIEF NOTE, half written';
const REAL_ANSWER = 'THE REAL ANSWER';
const PARENT_FINAL = 'PARENT_FINAL';

// The child's own statement about the WORK, spoken while it asked for the seeded report: the oldest
// substantive assistant prose in the run, and the value a cancellation report must carry once the
// summary that came after it is passed over.
const WORKING = 'WORKING: opening the report';

const seedTool = () =>
    tool({
        description: 'Return the oversized report body.',
        tags: ['test'],
        visibility: 'core',
        execute: () => SEED
    });

const delegationArguments = JSON.stringify({ agent: 'researcher', input: BRIEF_TASK });

describe('a compacting child answers its spawner with the task answer (T6 D-1)', () => {
    it('keeps the summary out of the cancellation report when the child was cut after a summarize pass', async () => {
        // THE DOOR THIS PINS: `run.partialContent = streamedText || lastSubstantiveText(...)` on the
        // abort exit (../harness.ts:13654). The child is cut inside an OPEN request, so nothing was
        // streamed and the committed-text walk is what produces the report. Without the
        // `isCompactionAnswerTurn` skip (:13018) that walk lands on `SUMMARY`, and the spawner reads
        // a context-relief note as if it were the work. With the skip it lands on `WORKING`, which
        // really is about the task.
        //
        // It is ALSO the D-2 surface: the same stop is what the parent is told about, so the
        // envelope released for the call is pinned here in the same run.
        const summarized = deferred<void>();
        const continuationOpen = deferred<void>();

        // The child's requests, keyed by REQUEST COUNT — exactly how the scripted transports key them
        // (./harness.compaction-delegation.test.ts:152-163), and required here: a summarize pass
        // WITHHOLDS the seed round from the projection (its own inclusion flags), so content-based
        // identification sees request 2 as a bare task and re-issues the tool call. The sequence this
        // scenario produces is the one that file pins: task → instruction → nudge.
        //   1. task      → the seed round, with prose about the work.
        //   2. instruction → the SUMMARY (the compaction answer).
        //   3. nudge     → never answers: the host stop is the only exit, and that is the point.
        let asked = 0;

        const childStream: HarnessStream = async function* stream() {
            asked += 1;

            if (asked === 1) {
                for (const frame of callTool('k1', 'seed', '{}', WORKING)) yield frame;

                return;
            }

            if (asked === 2) {
                // Resolved at BRANCH ENTRY, before any yield: a transport driver that stops pulling
                // when it sees the `done` frame would otherwise leave a resolve() after the loop
                // unreached, and the wait below would time out on a scenario that is actually fine.
                // What the SUMMARY COMMITTED is proven by the continuation request arriving at all.
                summarized.resolve();

                for (const frame of answer(SUMMARY)) yield frame;

                return;
            }

            continuationOpen.resolve();
            await new Promise<void>(() => undefined); // never settles
        };

        const host = harness({
            agents: {
                writer: agent({
                    model: MODEL,
                    stream: scripted([callTool('c1', 'delegate', delegationArguments), answer(PARENT_FINAL)])
                }),
                researcher: agent({ model: MODEL, stream: childStream })
            },
            entry: 'writer',
            ranks: { writer: 'A', researcher: 'B' },
            tools: { seed: seedTool() },
            pluginSettings: summarizeSettings(LIMIT),
            presets: false
        });

        // A HOST parent, so the child is its own parkable subthread at depth 2 (file header).
        const parent = host.createThread('writer', { label: 'Parent' });
        const submission = probe(host.sendThreadInput(parent.id, 'go'));

        expect(await reachedWithin(summarized.promise, 3000)).toBe(true);
        expect(await reachedWithin(continuationOpen.promise, 3000)).toBe(true);

        const listed = await waitUntil(
            () =>
                (host.threads() as any[]).some(
                    (record) => record.ownerThreadId === parent.id && record.agent === 'researcher'
                ),
            { attempts: 40, stable: 2 }
        );

        expect(listed).toBe(true);

        const child = (host.threads() as any[]).find(
            (record) => record.ownerThreadId === parent.id && record.agent === 'researcher'
        );

        // THE CUT: a host stop, while the continuation request is still open and the newest committed
        // prose in that conversation is the summary.
        expect(host.stopThread(child.id, 'the report moved on')).toBe(true);

        const settled = await waitUntil(() => submission.status !== 'pending', { attempts: 60, stable: 2 });

        expect(settled).toBe(true);

        // The child's record leaves `running` — a host stop rests it at its own resting status, which
        // is NOT necessarily `idle` (the parent's standing rows and the child's rows rest differently),
        // so the wait is on the one record this scenario cuts, not on the whole roster.
        const stopped = await waitUntil(
            () => (host.threads() as any[]).find((record) => record.id === child.id)?.status !== 'running',
            { attempts: 40, stable: 2 }
        );

        expect(stopped).toBe(true);

        const childRecord = (host.threads() as any[]).find((record) => record.id === child.id);
        const report = await recordOf(host, 'researcher', childRecord.invocationId);

        // The child really was cut, and the ledger says WHY in one word the parent can act on.
        expect([report.status, childRecord.stopReason]).toEqual(['cancelled', 'user-stopped']);

        // THE PIN: the cut child reports its own work — never the digest it wrote to relieve itself.
        expect(report.partialContent).toBe(WORKING);

        // The summary is still the CHILD'S record: `threadRead` answers for it in that conversation.
        expect((host.threadMessages(child.id) as unknown[]).map(contentOf)).toContain(SUMMARY);

        // D-2 HALF: the parent is answered with an envelope that names the halt (not a bare abort
        // string) and carries the partial account the child really produced — and no summary text.
        const parentToolEntry = (host.threadMessages(parent.id) as unknown[]).find(
            (message) =>
                roleOf(message) === 'tool' &&
                (message as { toolCallId?: string }).toolCallId === 'c1'
        );
        const envelope = JSON.parse(contentOf(parentToolEntry)) as Record<string, any>;

        expect(envelope.status).toBe('cancelled');
        expect(String(envelope.error)).not.toContain('aborted');
        expect(contentOf(parentToolEntry)).toContain(WORKING);
        expect(contentOf(parentToolEntry)).not.toContain(SUMMARY);

        // The parent's own turn still concluded: a cut child is an answer, not a stranded call.
        expect(submission.status).toBe('resolved');
        expect((submission.value as any)?.content).toBe(PARENT_FINAL);
    });

    it('keeps a half-streamed compaction answer out of the cancellation report (X2 F4)', async () => {
        // THE DOOR THE SIBLING ABOVE LEFT OPEN. Same rule ("a context-relief note is never the
        // spawner's answer"), different lane: the sibling cuts the child INSIDE an open request, so
        // nothing had streamed and the committed-text walk produced the report. This case cuts the
        // child WHILE IT IS STREAMING the compaction answer, which is the state
        // `run.streamedText += event.delta` (../harness.ts:12907, issue 0020) was built for — and
        // the buffer rule is "the in-flight buffer is the FRESHER evidence and wins". Applied
        // blindly, the fresher evidence here is the relief note: the summarize pass commits its
        // instruction at the boundary (../plugins/context-compaction.plugin.ts `beginSummarize`),
        // the model streams its structured summary, and an abort halfway through that stream made
        // the spawner's `partialContent` — and the parent's delegate envelope — carry the summary.
        // That is D-1 arriving by a door D-1 never closed.
        //
        // THE FIX AS PINNED: `isCompactionAnswerStream(brain.messages)` asks the plugin, from the
        // transcript POSITION alone (the placeholder carries no text), whether the turn being
        // streamed is the one the compaction instruction asked for. When it is, the buffer is
        // dropped and the report comes from `lastSubstantiveText`, which already skips every
        // committed compaction turn.
        const summaryStreaming = deferred<void>();

        let asked = 0;

        const childStream: HarnessStream = async function* stream() {
            asked += 1;

            // 1. the task round: prose about the WORK, then the seeded report the child asks for.
            //    This is what pushes the CHILD's estimate past `LIMIT` and arms the summarize pass.
            if (asked === 1) {
                for (const frame of callTool('k1', 'seed', '{}', WORKING)) yield frame;

                return;
            }

            // 2. the compaction instruction round: the summary STARTS and never finishes. The
            //    resolve runs on the consumer's next pull, i.e. after the delta reached the
            //    in-flight buffer and its `emit` settled (the reasoning the sibling case documents).
            if (asked === 2) {
                for (const frame of [{ type: 'text', delta: SUMMARY_HALF }] as HarnessStreamEvent[]) {
                    yield frame;
                }

                summaryStreaming.resolve();
                await new Promise<void>(() => undefined); // never settles
            }
        };

        const host = harness({
            agents: {
                writer: agent({
                    model: MODEL,
                    stream: scripted([callTool('c1', 'delegate', delegationArguments), answer(PARENT_FINAL)])
                }),
                researcher: agent({ model: MODEL, stream: childStream })
            },
            entry: 'writer',
            ranks: { writer: 'A', researcher: 'B' },
            tools: { seed: seedTool() },
            pluginSettings: summarizeSettings(LIMIT),
            presets: false
        });

        const parent = host.createThread('writer', { label: 'Parent' });
        const submission = probe(host.sendThreadInput(parent.id, 'go'));

        expect(await reachedWithin(summaryStreaming.promise, 3000)).toBe(true);

        const listed = await waitUntil(
            () =>
                (host.threads() as any[]).some(
                    (record) => record.ownerThreadId === parent.id && record.agent === 'researcher'
                ),
            { attempts: 40, stable: 2 }
        );

        expect(listed).toBe(true);

        const child = (host.threads() as any[]).find(
            (record) => record.ownerThreadId === parent.id && record.agent === 'researcher'
        );

        // THE CUT, landing between the instruction commit and the summary's `done` frame — the
        // window in which the half-streamed summary IS `run.streamedText` and nothing else about the
        // pass has happened (no answer turn, no finalize, no nudge).
        expect(host.stopThread(child.id, 'the report moved on')).toBe(true);

        const settled = await waitUntil(() => submission.status !== 'pending', { attempts: 60, stable: 2 });

        expect(settled).toBe(true);

        const stopped = await waitUntil(
            () => (host.threads() as any[]).find((record) => record.id === child.id)?.status !== 'running',
            { attempts: 40, stable: 2 }
        );

        expect(stopped).toBe(true);

        const childRecord = (host.threads() as any[]).find((record) => record.id === child.id);
        const report = await recordOf(host, 'researcher', childRecord.invocationId);

        expect([report.status, childRecord.stopReason]).toEqual(['cancelled', 'user-stopped']);

        // THE PIN: whatever the report says, it does not say the summary. The half-streamed relief
        // note is the child's own context business, and this is the lane through which it used to
        // reach the spawner as "the answer it had in hand".
        expect(String(report.partialContent ?? '')).not.toContain(SUMMARY_HALF);

        // What the report DOES carry is `WORKING` — the task prose the child committed in its FIRST
        // round, which is what `lastSubstantiveText` lands on once the compaction lane is skipped
        // (the sibling case above walks the same list and reports the same string). The flow that
        // produces this cut is the one the sizing block above and ./harness.compaction-delegation.test.ts
        // pin: the task round (whose prose is `WORKING`) is under the ceiling, the 2,100-character
        // seed result pushes the CHILD over it, the summarize pass commits its instruction at that
        // boundary, and the next request is the instruction round — the one whose summary is still
        // only half out when the stop lands. The ruling is "its last task sentence, or no partial at
        // all"; this is the sentence.
        expect(report.partialContent).toBe(WORKING);

        // THE DOOR THAT MATTERS: the parent's `delegate` tool result. A cancelled child is still an
        // answer to the call, and the account inside it must be the work, not the digest.
        const parentToolEntry = (host.threadMessages(parent.id) as unknown[]).find(
            (message) =>
                roleOf(message) === 'tool' &&
                (message as { toolCallId?: string }).toolCallId === 'c1'
        );
        const envelope = JSON.parse(contentOf(parentToolEntry)) as Record<string, any>;

        expect(envelope.status).toBe('cancelled');
        expect(contentOf(parentToolEntry)).toContain(WORKING);
        expect(contentOf(parentToolEntry)).not.toContain(SUMMARY_HALF);

        // And the parent still concluded its own turn: the cut child never strands the call.
        expect(submission.status).toBe('resolved');
        expect((submission.value as any)?.content).toBe(PARENT_FINAL);
    });

    it('reports the in-flight prose when the cut is NOT a compaction answer (X2 F4 control)', async () => {
        // THE CONTROL for the case above, and the reason its assertion is not vacuous: the
        // in-flight buffer DOES reach `partialContent` when what was streaming was the child's own
        // answer (issue 0020, "interrupted with an answer in hand"). Same fixture, same cut, no
        // compaction in flight (the child's first round is under `LIMIT`, so no instruction is
        // committed and `isCompactionAnswerStream` is false) — and the fragment arrives verbatim. If
        // this case stopped passing, the pin above would be proving nothing.
        const streaming = deferred<void>();
        const HALF = 'HALF AN ANSWER: ';

        let asked = 0;

        const childStream: HarnessStream = async function* stream() {
            asked += 1;

            if (asked === 1) {
                for (const frame of [{ type: 'text', delta: HALF }] as HarnessStreamEvent[]) {
                    yield frame;
                }

                streaming.resolve();
                await new Promise<void>(() => undefined); // never settles
            }
        };

        const host = harness({
            agents: {
                writer: agent({
                    model: MODEL,
                    stream: scripted([callTool('c1', 'delegate', delegationArguments), answer(PARENT_FINAL)])
                }),
                researcher: agent({ model: MODEL, stream: childStream })
            },
            entry: 'writer',
            ranks: { writer: 'A', researcher: 'B' },
            tools: { seed: seedTool() },
            // The helper's `headroomRatio: 0` is what makes this control work: with the declared
            // 0.15 the child's opening round would already be over the buffered trigger, the pass
            // would fire at the first boundary, and the prose being streamed WOULD be a compaction
            // answer. Opted out, 8,102 stays under the 8,625 ceiling, no pass runs, and the run is
            // cut inside an ordinary task round — the issue-0020 shape whose in-flight buffer must
            // still win.
            pluginSettings: summarizeSettings(LIMIT),
            presets: false
        });

        const parent = host.createThread('writer', { label: 'Parent' });
        const submission = probe(host.sendThreadInput(parent.id, 'go'));

        expect(await reachedWithin(streaming.promise, 3000)).toBe(true);

        const child = (host.threads() as any[]).find(
            (record) => record.ownerThreadId === parent.id && record.agent === 'researcher'
        );

        expect(child).toBeDefined();
        expect(host.stopThread(child.id, 'the report moved on')).toBe(true);

        const settled = await waitUntil(() => submission.status !== 'pending', { attempts: 60, stable: 2 });

        expect(settled).toBe(true);

        const childRecord = (host.threads() as any[]).find((record) => record.id === child.id);
        const report = await recordOf(host, 'researcher', childRecord.invocationId);

        expect(report.status).toBe('cancelled');
        expect(report.partialContent).toBe(HALF);
    });

    it('feeds the parent the task answer across a mid-task summarize pass', async () => {
        // The healthy shape, pinned at the parent's DOOR (./harness.compaction-delegation.test.ts
        // pins the same run from the child's side). A summarize pass that answers with prose is the
        // shape the loop exits terminally on, so before the D-1 fix this entry could be `SUMMARY`.
        const childSeen: HarnessStreamRequest[] = [];

        const host = harness({
            agents: {
                writer: agent({
                    model: MODEL,
                    stream: scripted([callTool('c1', 'delegate', delegationArguments), answer(PARENT_FINAL)])
                }),
                researcher: agent({
                    model: MODEL,
                    stream: scripted([callTool('k1', 'seed', '{}', WORKING), answer(SUMMARY), answer(REAL_ANSWER)], childSeen)
                })
            },
            entry: 'writer',
            ranks: { writer: 'A', researcher: 'B' },
            tools: { seed: seedTool() },
            pluginSettings: summarizeSettings(LIMIT),
            presets: false
        });

        const parent = host.createThread('writer', { label: 'Parent' });
        const submission = probe(host.sendThreadInput(parent.id, 'go'));

        const settled = await waitUntil(() => submission.status !== 'pending', { attempts: 80, stable: 2 });

        expect(settled).toBe(true);

        const quiet = await waitUntil(() => (host.threads() as any[]).every((record) => record.status === 'idle'), {
            attempts: 60,
            stable: 6
        });

        expect(quiet).toBe(true);

        // Precondition: the summarize pass really ran on the child — three provider requests, and the
        // second one carries the compaction instruction. Without this the test would pin a plain
        // delegation and prove nothing about compaction.
        expect((process.env.XPROBE ?? '').split('|').filter(Boolean)).toEqual([]); // TEMP-PROBE
        expect(childSeen.length).toBe(3);
        expect(
            entriesOf(childSeen[1]).filter(
                (message) => roleOf(message) === 'user' && contentOf(message) === COMPACTION_INSTRUCTION
            ).length
        ).toBe(1);

        const parentToolEntry = (host.threadMessages(parent.id) as unknown[]).find(
            (message) =>
                roleOf(message) === 'tool' && (message as { toolCallId?: string }).toolCallId === 'c1'
        );
        // The T28 delegate result is an identity envelope, not bare prose: the answer is the `content`
        // field and the status is its own field. `./harness.compaction-delegation.test.ts:240-320`
        // reads the same envelope; the `[status=completed]` string pinned THERE is that file's own
        // projection of these two fields, so the pin here is on the fields themselves.
        const envelope = JSON.parse(contentOf(parentToolEntry)) as Record<string, any>;

        // THE PIN: the entry the parent's own next request carries for the delegation call. Before
        // the D-1 fix this could be the SUMMARY — the summarize turn is tool-free prose, so it exits
        // the loop terminally and used to become the run's answer.
        expect([envelope.content, envelope.status]).toEqual([REAL_ANSWER, 'completed']);

        // And the relief note is nowhere in the parent's account of the call — the parent never learns
        // its child compacted (the summary stays in the CHILD'S transcript, where `threadRead` answers
        // for it).
        expect(contentOf(parentToolEntry)).not.toContain(SUMMARY);
        expect((host.threadMessages(childOfResearcher(host, parent.id).id) as unknown[]).map(contentOf)).toContain(
            SUMMARY
        );
    });
});

// The delegated child of a host-thread parent, addressed by LINEAGE (the record the parent thread
// owns) — `agent:researcher` in the roster is the researcher's DEFAULT conversation and never runs.
const childOfResearcher = (host: any, ownerId: string) => {
    const record = (host.threads() as any[]).find(
        (entry) => entry.ownerThreadId === ownerId && entry.agent === 'researcher'
    );

    if (record === undefined) throw new Error(`no delegated thread owned by ${ownerId}`);

    return record as { id: string; invocationId?: string; status: string; stopReason?: string };
};

// ---------------------------------------------------------------------------
// D-3 — the request that would carry a fan-out is bounded by the fan-out itself
// ---------------------------------------------------------------------------

// The relief note the shipped planner writes for a clipped payload. A clipped entry is exactly
// `240 chars + NOTE` = 267 characters, which is why "was this entry clipped?" is a decidable
// question here and not a length heuristic.
const TRUNCATION_NOTE = '… [truncated by compaction]';
const CLIP_PREFIX = 240;

// The window the relief measures is the sum of the `tool` entries inserted since `run.deliveryMark`,
// and a delegate result is the child's payload INSIDE the delegation envelope
// (`{"agent":…,"content":…,"threadId":…,"status":"completed","durationMs":…}` ≈ 194 characters of
// envelope around the page). NOTE the page itself is capped: `delegate`'s `maxChars` defaults to 8000
// (./tools/runtime/delegate.tool.ts:152), so an 8008-character answer arrives as exactly 8000
// characters plus `truncated`/`nextOffset` — a bound on ONE entry that says nothing about the SUM of
// a round, which is what the relief exists for. Payload size is therefore the switch across
// `DELIVERY_RELIEF_ALLOWANCE_CHARS` = 16384 characters (../harness.ts:602-610, derived from
// `MODEL_TOOL_RESULT_BUDGET_TOKENS / 2 * MODEL_TOKEN_BYTES` in ./core/result-budget.ts — the
// allowance is deliberately one default page wide, so ONE answer never triggers relief):
//   3 x 7900 → 3 x ~8094 = ~24282 characters  → over the allowance,  relief expected
//   2 x 7000 → 2 x ~7194 = ~14388 characters  → under it by ~1996,   relief expected NONE
const PROMPT = 'P'.repeat(20_000);

// The default plugin set with `context-trimmer` OFF: it is the other shipped `turn.before` pass and
// it clips tool payloads in the request on its own token threshold. Left on, a D-3 measurement would
// be reading TWO passes at once and the "verbatim" pins below would be false for reasons that have
// nothing to do with the delivery relief.
const trimmerOff: HarnessPluginSettingsProvider = {
    get: (plugin, key) => (plugin === 'context-trimmer' && key === 'enabled' ? false : undefined)
};

const fanout = (children: number, payloadChars: number) => {
    const parentSeen: HarnessStreamRequest[] = [];
    const names = Array.from({ length: children }, (_, index) => `worker${index + 1}`);

    const agents: Record<string, any> = {
        lead: agent({
            model: MODEL,
            name: 'lead',
            instruction: 'Fan out to every worker at once, then answer once.',
            stream: scripted(
                [
                    callTools(
                        names.map(
                            (name, index) =>
                                [`c${index + 1}`, 'delegate', JSON.stringify({ agent: name, input: `task ${name}` })] as [
                                    string,
                                    string,
                                    string
                                ]
                        )
                    ),
                    answer('ALL SETTLED')
                ],
                parentSeen
            )
        })
    };

    names.forEach((name) => {
        agents[name] = agent({
            model: MODEL,
            name,
            stream: scripted([answer(`${'A'.repeat(payloadChars)}|${name}`)])
        });
    });

    // Rank roster: `lead` is the Rank A entry and EVERY fanned-out child is Rank B. The map
    // is built for every name on purpose — `ranks` REPLACES the whole map, and a child left
    // out of it silently takes the fallback rank (one below the lowest rank written), so an
    // omitted name would still be reachable but would no longer be pinned as a Rank B peer of
    // its siblings. The fan-out under test is one Rank A caller over N Rank B children.
    const ranks: Record<string, AgentRank> = { lead: 'A' };
    for (const name of names) ranks[name] = 'B';

    const lead = harness({ entry: 'lead', ranks, agents, presets: false });

    // The parent's own conversation id, READ back rather than invented (the runtime's rule).
    const leadThread = () => (lead.threads() as any[]).find((record) => record.agent === 'lead');

    return { lead, parentSeen, names, leadThread };
};

describe('a spawner is relieved of the payload it just received (T6 D-3)', () => {
    it('digests its own older history and keeps every answer verbatim, over the allowance', async () => {
        const { lead, parentSeen, leadThread, names } = fanout(3, 7900);

        const result = await lead(PROMPT);

        expect(result.content).toBe('ALL SETTLED');
        expect(parentSeen.length).toBe(2);

        const second = entriesOf(parentSeen[1]);

        // THE PIN (1): the parent's OWN 20000-character prompt — the biggest entry the run owns and
        // the oldest payload in the request — is what comes back clipped, exactly as the planner
        // clips: a 240-character prefix plus the note that names the truncation. (The shipped request
        // puts the agent instruction at index 0, so the prompt is the first USER entry.)
        const promptEntry = second.filter((message) => roleOf(message) === 'user');

        expect(promptEntry.map(contentOf)).toEqual([`${'P'.repeat(CLIP_PREFIX)}${TRUNCATION_NOTE}`]);

        // THE PIN (2): every delegate result in the request is VERBATIM — the newest round is the
        // protected tail, so the answers a run delegated are the last thing relief would ever digest.
        // Each envelope carries its child's whole page, marker included.
        const clipped = second.filter((message) => contentOf(message).endsWith(TRUNCATION_NOTE));
        const fed = fedResults(parentSeen[1]);

        expect(clipped).toEqual([second[1]]);
        expect(fed.map((text) => text.endsWith(TRUNCATION_NOTE))).toEqual([false, false, false]);
        expect(names.map((_, index) => fed[index].includes(`${'A'.repeat(7900)}|worker${index + 1}`))).toEqual([
            true,
            true,
            true
        ]);

        // THE PIN (3): REQUEST-ONLY, verifiable. The durable conversation still holds the whole
        // prompt, no inclusion flag moved, and its delegate entries are byte-for-byte the ones this
        // request carried — so the next request re-projects the truth and `threadRead` can still
        // answer for every clipped character.
        const durable = lead.threadMessages(String(leadThread()?.id)) as unknown[];
        const durableUser = durable.filter((message) => roleOf(message) === 'user');

        expect(durableUser.map(contentOf)).toEqual([PROMPT]);
        expect(durable.map((message) => (message as { included?: boolean }).included === false)).toEqual(
            durable.map(() => false)
        );
        expect(
            durable.filter((message) => roleOf(message) === 'tool').map(contentOf)
        ).toEqual(fedResults(parentSeen[1]));
    });

    it('keeps a host-seeded leading system entry verbatim in the relieved request', async () => {
        // THE STANDING INSTRUCTION IS NOT RELIEF. A host that seeds a `system` entry stated an
        // instruction the model must hold on every turn — a brief, a contract, a routing rule — and
        // relief is about the payload that just ARRIVED, never about it. The planner used to clip
        // that entry with everything else in Pass A, which replaced the instruction with 240
        // characters and the truncation note while leaving the request "attributable" nothing: the
        // measured case (2026-11-23) is Storyline, whose whole brief IS its leading system entry —
        // five Reader threads died on the request after the clip.
        const { lead, parentSeen } = fanout(3, 7900);
        const brief = `SEEDED BRIEF ${'b'.repeat(1_200)}`;
        const thread = lead.createThread('lead');

        // The same two entries a host briefs a conversation with: the standing instruction, then the
        // run's own opening prompt (which IS reliefable — it is content the run owns).
        lead.setThreadMessages(thread.id, [
            { role: 'system', content: brief },
            { role: 'user', content: PROMPT }
        ]);

        const result = await lead.sendThreadInput(thread.id, 'go');

        expect(result.content).toBe('ALL SETTLED');
        expect(parentSeen.length).toBe(2);

        const second = entriesOf(parentSeen[1]);

        // THE PIN (1): the instruction travels byte-for-byte. A clip here is not a shorter
        // instruction, it is a DIFFERENT one, and nothing in the request says so.
        expect(roleOf(second[0])).toBe('system');
        expect(contentOf(second[0])).toBe(brief);

        // THE PIN (2): the relief still happened around it — the oversized prompt is clipped exactly
        // as the planner clips every non-leading entry.
        expect(
            second
                .filter((message) => roleOf(message) === 'user')
                .map(contentOf)
                .filter((text) => text !== 'go')
        ).toEqual([`${'P'.repeat(CLIP_PREFIX)}${TRUNCATION_NOTE}`]);

        // THE PIN (3): request-only, so the durable conversation still holds the brief and the whole
        // prompt, and no inclusion flag moved.
        const durable = lead.threadMessages(thread.id) as unknown[];

        expect(durable.filter((message) => roleOf(message) === 'system').map(contentOf)).toEqual([brief]);
        expect(durable.filter((message) => roleOf(message) === 'user').map(contentOf)).toEqual([PROMPT, 'go']);
        expect(durable.map((message) => (message as { included?: boolean }).included === false)).toEqual(
            durable.map(() => false)
        );
    });

    it('sends the request byte-identical while the round stays inside the allowance', async () => {
        // The other side of the same boundary: the measurement runs, the excess is <= 0, and the
        // request that goes out IS the projection — prompt whole. Without this control the test above
        // cannot show the relief is SIZED rather than unconditional.
        const { lead, parentSeen, leadThread } = fanout(2, 7000);

        const result = await lead(PROMPT);

        expect(result.content).toBe('ALL SETTLED');
        expect(parentSeen.length).toBe(2);

        const second = entriesOf(parentSeen[1]);

        expect(second.filter((message) => contentOf(message).endsWith(TRUNCATION_NOTE))).toEqual([]);
        expect(contentOf(second[1])).toBe(PROMPT);
        expect(
            fedResults(parentSeen[1]).map((text, index) => text.includes(`${'A'.repeat(7000)}|worker${index + 1}`))
        ).toEqual([true, true]);

        const durable = lead.threadMessages(String(leadThread()?.id)) as unknown[];

        expect(durable.filter((message) => roleOf(message) === 'user').map(contentOf)).toEqual([PROMPT]);
    });
});
