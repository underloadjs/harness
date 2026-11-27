// T6 REPRO — Context Compaction strands a DELEGATED subthread (the "green but not done" bug).
//
// THE REPORT BEING PINNED
// -----------------------
// When Context Compaction fires, the thread is marked done (green in the UI) although it is
// NOT done. A MAIN thread recovers on its own; a SUBTHREAD spawned by another thread stops,
// so the parent sits in limbo waiting for a child that never completes.
//
// This file is the smallest deterministic reproduction, written BEFORE the fix: every assertion
// states what a HEALTHY system must do, and every assertion MESSAGE carries the full OBSERVED
// picture, so one run of this file also answers the two competing explanations:
//
//   (a) the delegated child's run comes to rest PARKED → `thread.idle` is suppressed
//       (src/harness.ts:13821 fires it only `if (record.status === 'idle'`) → the shipped
//       continuation nudge never fires (src/plugins/context-compaction.plugin.ts:1740, its only
//       producer) → the child's tool body never returns (src/harness.ts:4995
//       `message = await run(target, …)`) → the parent waits forever
//       (`waitForWork`, src/harness.ts:12353-12365, has no timer and no abort).
//       Signature: parent never settles; child record stays 'paused'; NO `thread.resumed` for
//       the child; ONE invocation and ONE summarize turn on the child and nothing after it.
//
//   (b) the child's run TERMINATES CONCLUDED on the summary text, because the summarize turn is
//       an ordinary tool-free assistant turn and the loop exits terminally (src/harness.ts:12789
//       → :12828 `emit {type:'done'}` → :12841 `resolveRunAnswer`; `run.answer` was stamped with
//       the summary at :12780-12787 because this is a delegated run). The parent IS answered —
//       with the SUMMARY, i.e. the wrong answer — and the continuation run that produces the
//       real answer loses the delegation identity (src/harness.ts:13556-13561), so nothing
//       further reaches the parent.
//       Signature: parent settles; its `delegate` tool result carries the SUMMARY; the child
//       gets a SECOND invocation whose answer lands only in the child's own transcript.
//
// WHAT THIS REPRO OBSERVES (post-fix, run 2026-11-16)
// ---------------------------------------------------
// Hypothesis (b) was the observed shape, and the plugin no longer leaves that shape reachable:
// `turnAfter` queues the continuation nudge INTO the run that is still running whenever the answer
// is owed to a parent (`payload.depth >= 2`, plugin:1625-1693), so the run does NOT terminate on
// the summary. The trace this file now prints is:
//
//   thread.paused:thread-2 → turn.before:thread-2:2 → thread.resumed:thread-2
//   → turn.after:thread-2:2:SUMMARY → turn.before:thread-2:3
//   → turn.after:thread-2:3:THE REAL ANSWER → run.finished:thread-2:researcher:THE REAL ANSWER
//   → thread.idle:thread-2 → turn.before:thread-1:2      ← ONE child run, at d2, all the way
//
// i.e. ONE `run.started:thread-2:…:d2` (no second, host-shaped `d1` invocation), THREE child
// provider requests (task → instruction → nudge), the fold written on the continuation turn
// (`turn.before:thread-2:3` is the boundary `finalizeInRequest` withholds the superseded range
// at), and the single `done` frame of the child carries 'THE REAL ANSWER' — which is what the
// parent's `delegate` tool result carries back (`parentDelegatedAnswer: "THE REAL ANSWER
// [status=completed]"`). No `done` frame ends on the summary, so the green fold the report is
// about has nothing to fold: `greenOnSummary` is empty because the summary is no longer a run's
// answer, not because the projector stopped folding.
//
// The host/main-thread half of the flow is deliberately UNCHANGED (a `depth 1` run still resolves
// its submission on the summary and takes the nudge as a second run — pinned by
// src/plugin/context-compaction.test.ts:2592-2599, :2613-2617 and :2713).
//
// (a) was ruled out by measurement, not by reading: the child's `thread.resumed` and
// `thread.idle` DO fire, and the nudge run DID start. The one genuinely observed hang in this
// file's development was a provider-retry backoff (`retry … delayMs=1000`) while a parked
// subthread waited — the parent waits on `waitForWork` with no timer and no abort
// (src/harness.ts:12353-12365) for as long as the child's request stays unfinished, so the waits
// below are paced past that backoff and assert `providerRetries: 0` as a precondition.
//
// WHY THE SCENARIO IS SHAPED THIS WAY
// ------------------------------------
// The parent runs on a HOST thread (`createThread` + `sendThreadInput`), so its delegated child
// becomes its OWN host thread with `ownerThreadId` (src/harness.ts:13344-13362) — a durable,
// parkable, compactable conversation with its own transcript.
//
// The child overflows its own context with a TOOL RESULT rather than with the delegation input:
// keeping the 2100-character seed out of the parent's transcript matters, because the token
// estimate counts tool-call arguments too, and an input-sized seed would make the PARENT's fold
// carry 2,100 characters of payload it never produced. With the seed inside the child's
// conversation, the overflow that parks a thread is the CHILD's, the pass is the one that has to
// resume inside the delegated run, and every park/answer pin below is child-scoped — which is what
// the report is about. (The parent's own turn.before estimate crosses the same limit from ITS
// catalogue floor, so a parent pass runs at its first boundary as well; see the sizing block. That
// is a property of pricing the catalogue into the estimate, not of this fixture.)
//
// The scripted replies make "healthy" unambiguous: the compaction pass gets a scripted SUMMARY
// (a tool-free prose answer — the compaction answer the instruction asked for) and the child's
// continuation gets a scripted REAL ANSWER, the answer the parent is owed. A healthy system
// settles the parent with the REAL ANSWER.
//
// Every wait is BOUNDED — a missing transition fails an assertion instead of hanging until
// vitest's timeout kills the file — which is what makes "was the parent's delegation call ever
// answered?" an OBSERVATION rather than a hang.
//
// Fixtures mirror the accepted coverage map rather than inventing new ones:
//   - src/plugin/context-compaction.test.ts, the T9 block (SEED 2100 chars, the summarize
//     settings, the bounded `settle` waiter; its LIMIT is now `CATALOGUE + 520` because the tool
//     catalogue is priced into every boundary estimate — the same reason this file's LIMIT is
//     derived off the child's catalogue floor below) and its `settingsOf` helper, which turns the
//     OTHER shipped `turn.before` pass — `context-trimmer` — OFF, mandatory so this measures
//     exactly one plugin; also its awaited-gate-inside-a-request case (the park window) and its
//     lineage-correct child case
//   - src/harness.thread-park-queue.test.ts:132-163 (`flush`, and the bounded `waitStatus` shape
//     that fails rather than hangs)
//   - src/harness.delegation.test.ts:821-851 (a parent that calls `delegate` and gets only the
//     child's answer back)
//   - src/harness.threads.test.ts:245-308 (a paused child keeps one thread id; a `done` frame
//     carries `pending`)
//
// The UI-adjacent half is pinned at the frame level too: src/server/turn-projector.ts:2615-2623
// and src/frontend/ui/turns.ts:9414-9430 fold a non-root thread row to `done` when the `done`
// frame's `pending` array is absent or empty — so "the child row went green while its
// continuation was still owed" is asserted from the frames this harness actually reported.
//
// Cross-references:
//   - ./plugins/context-compaction.plugin.ts — the shipped pass under test (:1228-1302 park +
//     instruction, :1611-1716 `turn.after` un-park + the IN-RUN continuation this fix added,
//     :1720-1748 `thread.idle` finalize + out-of-band nudge, :1770-1868 / :1870-1940 the
//     run-terminal nets that now carry a committed pass to the idle finalize)
//   - ./harness.ts                                    — the loop, the park, the delegation body
//   - ./plugin/context-compaction.test.ts              — the single-thread summarize flow that
//                                                        DOES work: the control for this file

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    Harness,
    HarnessEvent,
    HarnessPlugin,
    HarnessPluginSettingsProvider,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// The protocol strings, imported (never re-pasted) so this repro keeps measuring the real
// protocol after it changes.
import { COMPACTION_INSTRUCTION, CONTINUATION_NUDGE } from './plugins/context-compaction.plugin';

// ---------------------------------------------------------------------------
// Sizing (derived from the documented estimator: core/payload-bytes.ts prices the serialized
// request, core/context-estimate.ts divides those bytes by 4, and src/harness.ts:12406-12410 +
// :12512-12533 add the bytes of the thread's declared tool schema to every `turn.before` estimate)
// ---------------------------------------------------------------------------

// 2100 characters = 526 transcript-only tokens (1,920 real + 2 escaped newlines + 4 quotes), the
// same seed the single-thread summarize fixture uses. It lands in the CHILD's transcript as a tool
// result, and it is what carries the child's estimate past the limit on round 2 (see the sizing
// block below: the limit now sits above the child's catalogue floor, so no single turn crosses it by
// itself any more).
const SEED = 'x'.repeat(2100);
// The tool catalogue is now INSIDE every unanchored `turn.before` estimate (harness.ts:12406-12410
// serializes each declared tool and 12512-12533 hands those bytes to the estimator;
// core/payload-bytes.ts prices them and core/context-estimate.ts:392-418 adds them to the payload
// before the /4), so a limit can
// no longer sit below a thread's catalogue floor. With `presets: false` the two floors differ,
// because `turn.before` carries the thread's OWN declared tools and the delegated child prices
// ITS OWN catalogue (no `delegate` row):
//   parent catalogue = 47,214 serialized bytes / 4 = 11,803.5 -> 11,804 tokens
//   child  catalogue = 38,333 serialized bytes / 4 =  9,583.25 ->  9,584 tokens
// probe: Temp/fix-f5/probe-floors.ts (shape C), re-measured 2026-11-25 for the +1,976 B that
// F1's threadList (+1,038) and threadSend (+938) disclosure added to every declared catalogue.
// The figures this block used to carry (39,785 / 9,947 and 32,379 / 8,095) were already stale at
// pristine HEAD, where the SAME probe measured 41,851 and 34,139 bytes; the case still passed
// because it only needs the inequalities below, but a constant that claims to be the floor has to
// BE the floor, so both are restated from the measurement and the margins fall out as designed.
// THE TWO MOVES SINCE THAT NOTE, both re-measured on shape C of the same probe against pristine
// `e66bce8` (child 36,691 B / 9,173, parent 45,425 B / 11,357) and against this tree, which is what
// makes them arithmetic rather than claims:
//   - the reserved per-call `async` switch (2026-11-27, ../core/tool.ts `withToolAsyncSwitch`):
//     +1,074 B on the child and +1,221 B on the parent — one declared row wider, one more +147. At
//     `e66bce8` the child stood at 36,691 B, i.e. the 9,029 this block carried was ALREADY 144
//     tokens under the floor before either finding landed, exactly the staleness the note above
//     calls out; it is restated here rather than patched around.
//   - F1, the branch write doors (2026-11-27): +568 B on BOTH rosters, from the two PARAMETER
//     copies `threadSend` (+362) and `threadDelete` (+206) gained; `threadFork`'s own description
//     is on a SEARCHABLE row, never declared, so it prices nothing here.
//     36,691 + 1,074 + 568 = 38,333 for the child, and 45,425 + 1,221 + 568 = 47,214 for the
//     parent.
// The fixture is therefore sized off the CHILD's floor: the child must stay under the limit while
// its round-1 estimate (floor + 7 = 9,591) and cross it when the seed tool result lands (round 2 =
// floor + 534 = 10,118), and the parent still crosses the same limit from its own floor (11,804 + 1
// = 11,805 on its first request). Both transcript terms are MEASURED, not hand-counted: probe
// Temp/fix-f5/probe-transcript.ts arms the shipped plugin at an unreachable limit and reads every
// `turn.before` estimate off the fixture itself (9,591 / 10,118 for the child, 11,805 / 11,879 for
// the parent, i.e. floor + 7 / floor + 534 and floor + 1 / floor + 75).
// THE DEAD-RUN GUARD (./plugins/context-compaction.plugin.ts `turnBefore`) is what keeps this case
// to ONE pass: the PARENT's summarize pass is refused outright — its 11,804-token floor is above the
// 10,114 ceiling, so no ladder rung could build a request the provider would take — and reported
// once as `stage: 'unreachable-target'`, while the CHILD's floor (9,584) sits under the ceiling, so
// its clipped compaction request fits and its pass runs. The two boundaries the case walks, sampled
// from the guard:
//   writer    11 805 = floor 11 804 + transcript 1     → refused (floor >= ceiling)
//   researcher 10 118 = floor  9 584 + transcript 534  → the pass, the only one in the case
// F1b (2026-11-27, the branch-seed findings) — both floors moved by the SAME measured +616 B / +154 tokens:
// probe `Temp/fix-f5/probe-floors.ts` shape C now measures child 38,949 B / 9,738 and parent 47,830 B /
// 11,958. The two sentences are `threadSend`'s no-redirect note (+277 B) and `threadDelete`'s
// discovery-pointer sentence (+339 B) — declared rows on both sides. The transcript terms are unchanged
// (`Temp/fix-f5/probe-transcript.ts`: child floor + 6 then + 534, parent floor + 0 then + 75), so every
// estimate in the block above shifts by the same +154 and the structure this case walks is intact at the new
// numbers: round 1 = 9,744 < LIMIT 10,268 <= round 2 = 10,272, and the parent's 11,958 floor is still above
// the 10,268 ceiling, so its pass is still refused as unreachable.
const CHILD_CATALOGUE = 9_738;
const LIMIT = CHILD_CATALOGUE + 530;
const MODEL = 'merge/ds4-flash';

const BRIEF_TASK = 'dig into the seeded report';

// The scripted replies: the compaction answer, the answer the parent is owed, the parent's own
// conclusion.
const SUMMARY = 'SUMMARY';
const REAL_ANSWER = 'THE REAL ANSWER';
const PARENT_FINAL = 'PARENT FINAL';

// ---------------------------------------------------------------------------
// Scripted transport + transcript readers
// ---------------------------------------------------------------------------

// One scripted frame list per PROVIDER REQUEST (the last list repeats), recording every request
// so "how many times was this conversation asked, and with what" is an exact assertion.
const scripted = (turns: HarnessStreamEvent[][], seen: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen.push(request);

        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// The summarize settings, spelled out (the limit, the savings floor off, the mode), plus
// `context-trimmer` OFF — the other shipped `turn.before` context pass, whose rule is a superset
// of compaction's and would otherwise run its own pass on these transcripts.
// `headroomRatio: 0` is the documented opt-out (X2, F3 took the headroom buffer off the "declared
// window only" gate, so it now comes off EVERY binding ceiling), and this file needs it: the whole
// sizing block above derives `LIMIT` against the plain number the operator typed — the child's
// seeded round (9,563) crosses it and its opening round (9,036) does not, which is what makes the
// overflow THIS case is about a TOOL RESULT rather than the delegation input. Left on the declared
// 0.15 the child would compact on its opening turn instead, and the scenario would stop being the
// one this file describes (the request-count-keyed transport, the AC7 inclusion table, and the
// "the seed round is what pushed the child over" narrative below all move with it). Where the
// buffer itself is pinned: the `resolveContextHeadroom` / `resolveContextTrigger` tables and the
// handler-level F3 case in ./plugin/context-compaction.test.ts.
const summarizeSettings = (): HarnessPluginSettingsProvider => {
    const stored: Record<string, number | string | boolean> = {
        contextLimit: LIMIT,
        minTokens: 0,
        headroomRatio: 0,
        mode: 'summarize'
    };

    return {
        get: (plugin, key) => {
            if (plugin === 'context-trimmer' && key === 'enabled') return false;

            return plugin === 'context-compaction' ? stored[key] : undefined;
        }
    };
};

// A compact view of a transcript: role, brief content, and only the pairing/withholding keys that
// matter here. `brief` keeps a 2100-character seed from drowning the failure message.
const brief = (text: string): string =>
    text.length <= 48 ? text : `${text.slice(0, 20)}…(${text.length} chars)`;

const transcriptOf = (host: Harness, threadId: string): unknown[] =>
    host.threadMessages(threadId).map((message) => {
        const raw = message as unknown as Record<string, unknown>;
        const view: Record<string, unknown> = {
            role: String(raw.role),
            content: brief(String(raw.content ?? ''))
        };

        if (raw.included === false) view.included = false;
        if (typeof raw.toolCallId === 'string') view.toolCallId = raw.toolCallId;
        if (typeof raw.name === 'string') view.name = raw.name;

        const calls = raw.toolCalls;
        if (Array.isArray(calls) && calls.length > 0) {
            view.toolCalls = calls.map((call) => (call as Record<string, unknown>)?.name);
        }

        return view;
    });

// The last USER message of one provider request, named: the compaction instruction, the
// continuation nudge, or the literal (briefed) text — "neither" is exactly what asserting this
// distinguishes (a continuation that never arrives is a request whose last user message is a
// repeat of the summary turn's instruction, or no third request at all).
const lastUserLabel = (request: HarnessStreamRequest | undefined): string => {
    const messages = (request?.messages ?? []) as unknown as { role: string; content: unknown }[];

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role !== 'user') continue;

        const content = String(messages[index].content ?? '');

        if (content === COMPACTION_INSTRUCTION) return 'instruction';
        if (content === CONTINUATION_NUDGE) return 'nudge';

        return `neither(${brief(content)})`;
    }

    return 'none';
};

// The content of the parent's `delegate` tool result, as the parent's own conversation recorded
// it. Absent means the delegation call was never answered at all.
const toolResultOf = (host: Harness, threadId: string, callId: string): string | undefined => {
    for (const message of host.threadMessages(threadId)) {
        const raw = message as unknown as Record<string, unknown>;

        if (raw.role !== 'tool' || raw.toolCallId !== callId) continue;

        return typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content);
    }

    return undefined;
};

// The WHOLE view of one provider request: every message the model was actually sent, in order,
// each named. `request.messages` is the PROJECTED transcript, so an entry whose inclusion flag
// was switched off is absent from it — which is exactly what makes this the assertion defect F1
// fell through: asking "what was the last user message" cannot see a request that ALSO withheld
// the instruction and the summary and still delivered the right answer.
const labelMessage = (message: unknown): string => {
    const raw = message as Record<string, unknown>;
    const calls = raw.toolCalls;

    if (raw.role === 'user' && raw.content === COMPACTION_INSTRUCTION) return 'instruction';
    if (raw.role === 'user' && raw.content === CONTINUATION_NUDGE) return 'nudge';
    if (Array.isArray(calls) && calls.length > 0) {
        return `assistant→${calls.map((call) => String((call as Record<string, unknown>)?.name ?? '?')).join(',')}`;
    }
    if (raw.role === 'tool') return `tool:${String(raw.name ?? '?')}`;

    return `${String(raw.role)}:${brief(String(raw.content ?? ''))}`;
};

const requestViewOf = (request: HarnessStreamRequest | undefined): string[] =>
    ((request?.messages ?? []) as unknown[]).map(labelMessage);

// The durable inclusion state of a conversation: 'off' for an entry the fold withholds, 'on' for
// one that still goes. Flags are never re-enabled, so this is what the conversation looks like
// after the pass — the restart-durable half of the contract.
const inclusionOf = (host: Harness, threadId: string): string[] =>
    host
        .threadMessages(threadId)
        .map((message) => ((message as unknown as Record<string, unknown>).included === false ? 'off' : 'on'));

// The `content` field of a `delegate` envelope (it is a JSON string), or a marker naming the
// shape actually received. This is the fact that separates (a) from (b).
const delegatedAnswerOf = (result: string | undefined): string => {
    if (result === undefined) return '<no tool result: the delegation was never answered>';

    try {
        const parsed = JSON.parse(result) as Record<string, unknown>;

        return `${brief(String(parsed.content ?? ''))} [status=${String(parsed.status ?? '-')}]`;
    } catch {
        return `<not a delegate envelope: ${brief(result)}>`;
    }
};

// The IDENTITY half of the same envelope: which agent answered, which conversation the answer
// came from, which ledger invocation the parent may page for the rest, and the run's terminal
// status. The ids are minted, so `invocationId` is observed as present/absent rather than
// literal (harness.ts:5085-5099: both are ABSENT, never invented, when the child's record was
// purged or evicted — which is the failure this pins).
const envelopeOf = (result: string | undefined): unknown => {
    if (result === undefined) return '<no tool result>';

    try {
        const parsed = JSON.parse(result) as Record<string, unknown>;

        return {
            agent: parsed.agent,
            status: parsed.status ?? '<absent>',
            threadId: parsed.threadId ?? '<absent>',
            invocationId:
                typeof parsed.invocationId === 'string' && parsed.invocationId.length > 0
                    ? 'present'
                    : '<absent>'
        };
    } catch {
        return '<not a delegate envelope>';
    }
};

// One readable line per reported frame. `retry` carries the provider error verbatim (a failed
// attempt would otherwise look like a stalled conversation), and `done` carries the content, the
// stop reason and the `pending` length the server's green-fold rule reads.
const eventLine = (event: HarnessEvent): string => {
    const raw = event as unknown as Record<string, unknown>;
    const extras: string[] = [];

    if (event.type === 'retry') {
        extras.push(
            `attempt=${String(raw.attempt)}/${String(raw.maxAttempts)}`,
            `delayMs=${String(raw.delayMs)}`,
            `error=${brief(String((raw.error as Record<string, unknown> | undefined)?.message ?? ''))}`
        );
    }

    if (event.type === 'done') {
        const message = raw.message as Record<string, unknown> | undefined;
        const pending = raw.pending;

        extras.push(
            `content=${brief(String(message?.content ?? ''))}`,
            `stopReason=${String(message?.stopReason ?? '-')}`,
            `pending=${Array.isArray(pending) ? String(pending.length) : 'absent'}`
        );
    }

    return `${event.agent}:${event.type}${extras.length === 0 ? '' : ` ${extras.join(' ')}`}`;
};

// ---------------------------------------------------------------------------
// Bounded waits — every one of them FAILS rather than hangs
// ---------------------------------------------------------------------------

// Drain microtasks plus one zero-delay timer so a fire-and-forget run reaches its next resting
// point without depending on wall-clock time.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
};

// Poll a condition with a hard attempt bound. `stable` asks for N consecutive quiet polls, which
// is what lets a detached run (the continuation nudge) count as started instead of being missed
// by a snapshot taken one poll too early. `tickMs` paces the polls so the bound also covers a
// provider retry's backoff, and a missing transition still FAILS after the bound instead of
// hanging the file.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (
    predicate: () => boolean,
    options: { attempts?: number; stable?: number; tickMs?: number } = {}
): Promise<boolean> => {
    const attempts = options.attempts ?? 40;
    const stable = options.stable ?? 1;
    const tickMs = options.tickMs ?? 0;
    let streak = 0;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await flush();
        if (tickMs > 0) await sleep(tickMs);

        streak = predicate() ? streak + 1 : 0;
        if (streak >= stable) return true;
    }

    return false;
};

// Attach handlers immediately so a rejection never becomes unhandled, and expose the settled
// state to a bounded assertion.
const probe = <T>(promise: Promise<T>) => {
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

describe('context compaction across a delegation (T6 repro)', () => {
    it('answers the parent with the child\'s real answer after the child compacts mid-task', async () => {
        const parentSeen: HarnessStreamRequest[] = [];
        const childSeen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];

        // The park machinery, hook by hook and thread by thread. THIS trace is what separates
        // hypothesis (a) (no `thread.resumed`/`thread.idle` for the child → no nudge) from (b)
        // (the child's run finishes concluded and a second, continuation run starts).
        const trace: string[] = [];

        const observer: HarnessPlugin = {
            name: 'compaction-delegation-observer',
            setup: (api) => {
                api.on('run.started', (payload) => {
                    trace.push(`run.started:${payload.threadId ?? '-'}:${payload.agent}:d${payload.depth}`);
                });
                api.on('run.finished', (payload) => {
                    trace.push(
                        `run.finished:${payload.threadId ?? '-'}:${payload.agent}:${brief(String(payload.message?.content ?? ''))}`
                    );
                });
                api.on('run.failed', (payload) => {
                    trace.push(`run.failed:${payload.threadId ?? '-'}:${payload.agent}`);
                });
                api.on('turn.before', (payload) => {
                    trace.push(`turn.before:${payload.threadId}:${payload.iteration}`);
                });
                api.on('turn.after', (payload) => {
                    trace.push(
                        `turn.after:${payload.threadId ?? '-'}:${payload.iteration}:${brief(String(payload.message?.content ?? ''))}`
                    );
                });
                api.on('thread.paused', (payload) => {
                    trace.push(`thread.paused:${payload.id}`);
                });
                api.on('thread.resumed', (payload) => {
                    trace.push(`thread.resumed:${payload.id}`);
                });
                api.on('thread.idle', (payload) => {
                    trace.push(`thread.idle:${payload.id}`);
                });
            }
        };

        // THE CHILD'S OWN ROUTE PAST THE LIMIT: a tool whose result is the 2100-character seed,
        // which lands in the CHILD's transcript and is what lifts the child's round-2 estimate over
        // the limit. Nothing about the seed reaches the PARENT's transcript, so the parent's fold
        // never carries it — the parent's own boundary estimate crosses the limit from its catalogue
        // floor (see the sizing block), which is the harness pricing the tool schema, not this seed.
        const seedTool = tool({
            description: 'Return the oversized report body.',
            tags: ['test'],
            visibility: 'core',
            execute: () => SEED
        });

        // THE PARENT: one turn that delegates to the researcher, one turn that concludes.
        const parentStream = scripted(
            [
                callTool('c1', 'delegate', JSON.stringify({ agent: 'researcher', input: BRIEF_TASK })),
                answer(PARENT_FINAL)
            ],
            parentSeen
        );

        // THE CHILD: request 1 runs the seed tool (a tool round is one frame LIST, so
        // `callTool` is passed UNwrapped), request 2 is the compacting turn (its last user
        // message is the compaction instruction) and answers with the SUMMARY, request 3 is the
        // continuation nudge and its answer is the one the parent is owed.
        const childStream = scripted(
            [callTool('k1', 'seed', '{}'), answer(SUMMARY), answer(REAL_ANSWER)],
            childSeen
        );

        const host = harness({
            agents: {
                writer: agent({ model: MODEL, stream: parentStream }),
                researcher: agent({ model: MODEL, stream: childStream })
            },
            entry: 'writer',
            ranks: { writer: 'A', researcher: 'B' },
            tools: { seed: seedTool },
            pluginSettings: summarizeSettings(),
            presets: false,
            plugins: [observer],
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        // A HOST parent, so the delegated child becomes its own host thread (harness.ts
        // :13344-13362). `agent:researcher` in the roster is the researcher's DEFAULT
        // conversation and never runs here, so the child is addressed by LINEAGE: the record the
        // parent thread owns.
        const parentThread = host.createThread('writer', { label: 'Parent' });
        const submission = probe(host.sendThreadInput(parentThread.id, 'go'));

        // (i) Bounded wait for the parent's turn: a parent in limbo FAILS here instead of hanging
        // the file until vitest's timeout. The bound (~1s of polling) also covers a provider
        // retry's backoff, so a stall is reported as a fact rather than waited away.
        const parentSettled = await waitUntil(() => submission.status !== 'pending', {
            attempts: 100,
            tickMs: 10
        });

        // Then let any detached run (the continuation nudge) start AND finish: quiet for eight
        // consecutive polls, so a late nudge run is never snapshot-missed.
        const allQuiet = await waitUntil(
            () => host.threads().every((record) => record.status === 'idle'),
            { attempts: 40, stable: 8, tickMs: 10 }
        );

        // --- OBSERVED FACTS -------------------------------------------------
        const childRecord = host
            .threads()
            .find((record) => record.agent === 'researcher' && record.ownerThreadId === parentThread.id);
        const childId = childRecord?.id ?? '<no child thread>';

        // Every run the subthread received, with the delegation DEPTH each reports: the compacting
        // run is a delegated child of the parent's run (`d2`). A SECOND line here at `d1` is the
        // pre-fix shape — a continuation that arrived as a host-shaped `threads.send` reports `d1`,
        // the frame-level evidence that it no longer belongs to the parent's tool call
        // (src/harness.ts:13556-13561). Post-fix the healthy shape is exactly ONE line, ending in
        // `d2`: `turnAfter` queued the nudge into the run that was still running
        // (../plugins/context-compaction.plugin.ts:1625-1693), so the same delegated invocation
        // answers the parent.
        const childRunFrames = trace.filter((line) => line.startsWith(`run.started:${childId}:`));
        const childRuns = childRunFrames.length;

        // The `done` frames the child produced, in the exact shape the server's green-fold rule
        // reads: `pending` absent or empty ⇒ that row is drawn `done`. The frame's own content is
        // kept because the symptom under test is a SPECIFIC row going green — the one that ends on
        // the compaction summary while the plugin still owes this conversation a continuation.
        const childDoneFrames = events
            .filter((event) => event.agent === 'researcher' && event.type === 'done')
            .map((event) => {
                const raw = event as unknown as { pending?: unknown[]; message?: { content?: unknown } };
                const pending = raw.pending;

                return {
                    content: brief(String(raw.message?.content ?? '')),
                    foldedGreen: pending === undefined || pending.length === 0,
                    pendingLength: pending?.length ?? 0
                };
            });

        const observed = {
            parentSettled,
            parentOutcome:
                submission.status === 'rejected'
                    ? `rejected(${String((submission.error as Error | undefined)?.message ?? submission.error)})`
                    : submission.status === 'resolved'
                      ? `resolved(${brief(String(submission.value?.content ?? ''))})`
                      : 'never settled',
            allQuiet,
            // Every roster row and its resting state: the child's row is the one the report is
            // about.
            records: host
                .threads()
                .map(
                    (record) =>
                        `${record.id}=${record.agent}:${record.status}:${record.stopReason ?? 'no-stopReason'}`
                ),
            childId,
            childRuns,
            // The depth each child run reports: the identity evidence separating a delegated
            // continuation from a detached host-shaped one.
            childRunFrames,
            childRequests: childSeen.length,
            childLastUser: childSeen.map(lastUserLabel),
            // WHAT EACH REQUEST WAS SENT (AC7). The last view is the one F1 broke: a continuation
            // request that had lost its instruction and its summary still asked the child with a
            // nudge, so `childLastUser` above was satisfied while the model had no context.
            childRequestViews: childSeen.map(requestViewOf),
            // The durable inclusion state of the child conversation (the other AC7 half).
            childInclusion: childRecord === undefined ? [] : inclusionOf(host, childRecord.id),
            // A `retry` frame means a provider attempt FAILED (a scripted transport that yields
            // a malformed frame burns a 1s backoff here and then answers the wrong turn), so the
            // scenario must be retry-free for anything below to measure the plugin at all.
            providerRetries: events.filter((event) => event.type === 'retry').length,
            childDoneFrames,
            childTranscript: childRecord === undefined ? [] : transcriptOf(host, childRecord.id),
            parentTranscript: transcriptOf(host, parentThread.id),
            parentDelegatedAnswer: delegatedAnswerOf(toolResultOf(host, parentThread.id, 'c1')),
            // The identity the answer was delivered under: the delegated child's conversation and
            // its ledger invocation, not a detached follow-up run's.
            parentEnvelope: envelopeOf(toolResultOf(host, parentThread.id, 'c1')),
            trace,
            eventShapes: events.map(eventLine)
        };

        // One message, every fact: each assertion below prints the whole picture, so a single run
        // of this file is enough to classify the failure.
        const because = () => `\nobserved: ${JSON.stringify(observed, null, 2)}`;

        // --- THE REGRESSION PIN (healthy behaviour) -------------------------
        // A soft assertion set: every check runs, and every failure is reported together.

        // PRECONDITION 1: every provider attempt succeeded, so the scenario measured the plugin
        // rather than a scripted-transport slip (see `providerRetries` above).
        expect.soft(
            observed.providerRetries,
            `the scenario must run without a provider retry (a retry answers a later scripted turn)${because()}`
        ).toBe(0);

        // PRECONDITION 2: the summarize pass really ran ON THE SUBTHREAD — the park is the event
        // the bug report is about, and without it this file would be measuring an ordinary
        // delegation.
        expect.soft(
            observed.trace.filter((line) => line.startsWith('thread.') && line.endsWith(childId)),
            `the shipped compaction pass must park the delegated subthread${because()}`
        ).toContain(`thread.paused:${childId}`);

        // (i) the parent's turn completes — it is not left waiting on its own child.
        expect.soft(
            observed.parentSettled,
            `the parent turn never settled — it is stranded on the delegated child${because()}`
        ).toBe(true);
        expect.soft(
            observed.parentOutcome,
            `the parent turn must RESOLVE with its final answer${because()}`
        ).toBe(`resolved(${PARENT_FINAL})`);

        // (i-end) and the whole harness comes to rest inside the bounded wait: a row left
        // `running` is a run blocked on a child that never lands, and one left `paused` is a park
        // nobody lifted. The exact rows and their statuses are in the message.
        expect.soft(
            observed.allQuiet,
            `no conversation may be left running or paused when the bounded wait expires${because()}`
        ).toBe(true);

        // (v) and the content the parent's tool result actually carries is the child's REAL
        // answer — not the compaction SUMMARY, and not "no result at all".
        //
        // The `[status=completed]` tail is part of the healthy shape, not noise: the delegate
        // envelope carries the child run's LEDGER STATUS (src/harness.ts:5095-5098, B2/D1 — it is
        // omitted only when the child's ledger record was purged or evicted), and `completed` is
        // the status of a child that finished its work. Pinning it here keeps the assertion exact
        // AND proves the child was not folded as an unfinished/failed invocation.
        expect.soft(
            observed.parentDelegatedAnswer,
            `the parent's delegate call must be answered with the child's real answer${because()}`
        ).toBe(`${REAL_ANSWER} [status=completed]`);

        // (ii) the child conversation is NOT left parked and NOT flagged as a plugin park.
        expect.soft(
            [childRecord?.status, childRecord?.stopReason ?? 'no-stopReason'],
            `the child thread must come to rest idle with no plugin-park cause${because()}`
        ).toEqual(['idle', 'no-stopReason']);

        // (iv) THE IDENTITY INVARIANT (primary): the answer the parent holds is tied to the
        // DELEGATED invocation — one run on the child, and that run is the `d2` child of the
        // parent's own run. The count alone under- and over-specifies: a `d1` continuation run
        // (the pre-fix shape) means the answer landed outside the parent's tool call even if the
        // count matched, and a second `d2` run would only be an implementation detail. So the
        // frame list is the assertion, and the count below is a secondary observation of it.
        expect.soft(
            observed.childRunFrames,
            `the child's answer must come from the delegated d2 invocation and no other run${because()}`
        ).toEqual([`run.started:${childId}:researcher:d2`]);

        // The same tie, read from what the PARENT was given: the envelope names the child's
        // conversation and a real ledger invocation, so "the answer" and "the delegated run" are
        // the same object rather than two things that happened to agree.
        expect.soft(
            observed.parentEnvelope,
            `the delivered answer must be attributed to the delegated child's invocation${because()}`
        ).toEqual({
            agent: 'researcher',
            status: 'completed',
            threadId: childId,
            invocationId: 'present'
        });

        // SECONDARY OBSERVATION of the invariant above: the single run also carried the
        // continuation. It was 2 pre-fix, because the continuation was started OUT OF BAND by
        // `thread.idle` as a second, host-shaped run whose delegation identity the parent had
        // already stopped awaiting — that second run is what answered 'THE REAL ANSWER' to nobody.
        // Now `turnAfter` queues the nudge INTO the run that is still running
        // (`api.threads.steer`, plugin:1625-1693). A count of 2 here means the in-run continuation
        // was skipped and the old out-of-band nudge fired again, i.e. the defect this file pins;
        // a count of 1 with the frames above is fully implied by them.
        expect.soft(
            observed.childRuns,
            `the child's one run must also own the continuation${because()}`
        ).toBe(1);

        // (iii) three provider requests, and each one's last user message is the right protocol
        // turn: the task, then the compaction instruction, then the continuation nudge.
        expect.soft(observed.childRequests, `the child must be asked exactly three times${because()}`).toBe(3);
        expect.soft(
            observed.childLastUser,
            `the child's requests must be the task, the instruction, then the continuation nudge${because()}`
        ).toEqual([`neither(${BRIEF_TASK})`, 'instruction', 'nudge']);

        // AC7 — THE CONTENT OF THOSE REQUESTS, not just their last turn (defect F1). The nudge the
        // plugin queues for a delegated child carries the SAME marker as the compaction instruction
        // (both are built from `COMPACTION_MARKER`, plugin:521/:539/:566), and it is drained into
        // the transcript BEFORE the boundary that writes the range (src/harness.ts:12669 ->
        // `emitTurnBefore` :12182). Anchoring the retention plan on the LAST marker entry therefore
        // anchored on the nudge: `answerIndex: -1`, everything up to it disabled, and the
        // continuation request reduced to the nudge alone — while every answer-level assertion above
        // stayed green. The third request must be the retained head plus the nudge.
        expect.soft(
            observed.childRequestViews,
            `AC7: each child request must carry exactly what the fold is meant to keep${because()}`
        ).toEqual([
            [`user:${BRIEF_TASK}`],
            [`user:${BRIEF_TASK}`, 'assistant→seed', 'tool:seed', 'instruction'],
            ['instruction', `assistant:${SUMMARY}`, 'nudge']
        ]);

        // AC7, the durable half: the fold switched off ONLY the superseded range (the task turn,
        // the seed call and its result) and left the instruction, the summary, the nudge and the
        // answer sending. Inclusion flags are never re-enabled, so this is the state a restart
        // reads too — a withheld instruction stays withheld forever, which is why F1 had to be
        // caught here rather than inferred from the answer.
        expect.soft(
            observed.childInclusion,
            `AC7: only the superseded range may be disabled, and the compacted head must survive${because()}`
        ).toEqual(['off', 'off', 'off', 'on', 'on', 'on', 'on']);

        // The child's real answer is the last thing in the child's own conversation.
        expect.soft(
            observed.childTranscript.at(-1),
            `the child's last transcript entry must be the real answer${because()}`
        ).toEqual({ role: 'assistant', content: REAL_ANSWER });

        // (UI contract) the server's green-fold rule (src/server/turn-projector.ts:2615-2623,
        // src/frontend/ui/turns.ts:9414-9430): a `done` frame whose `pending` array is absent or
        // empty draws that thread row `done` — green. A frame that ends on the compaction SUMMARY
        // while the plugin still owes this conversation a continuation is therefore reporting the
        // row finished mid-task, which IS the reported symptom. Either that frame carries its
        // pending continuation, or the run that owed the continuation must not have ended on the
        // summary at all (in which case no SUMMARY `done` frame exists and this stays empty).
        const greenOnSummary = childDoneFrames
            .filter((frame) => frame.content === SUMMARY && frame.foldedGreen)
            .map((frame) => `${frame.content}:${frame.foldedGreen ? 'folded-done' : 'pending'}`);

        expect.soft(
            greenOnSummary,
            `the subthread's compaction summary must not be reported as a finished (green) row while its continuation is owed${because()}`
        ).toEqual([]);
    });
});
