/**
 * Transcript repair for a run whose output was RETAINED instead of rolled back (IT19 R1).
 *
 * When a harness run ends without concluding — user stop, caller release, wall-clock timeout,
 * turn cap, provider failure — the harness now keeps every committed turn in `brain.messages`
 * rather than truncating the array back to the run's root user message. The cost of keeping that
 * tail is that the LAST assistant turn may have asked for tool calls whose results never arrived:
 * the run was cut off mid-flight, so no real `tool` result was ever produced for one or more of
 * the ids it named.
 *
 * A transcript in that shape is not merely ugly, it is replay-poisoned. A provider rejects a
 * history whose `assistant` entry names tool calls without a matching `tool` result for each of
 * them, so the conversation could not be sent again at all — and the unanswered call also stays
 * forever "in flight" to anything that pairs calls with results (`hasToolResult`,
 * harness.ts:8616, is the double-answer guard at harness.ts:8652, and a call whose result was
 * never written is permanently unanswered). So the retained tail has to be made well-formed
 * before it can be reused: one synthesized result per dangling call, in the position a real
 * result would have landed.
 *
 * This is the in-run sibling of the crash-repair pass in `server/persistence.ts:1752`
 * (`repairInterruptedToolCalls`), deliberately a SEPARATE implementation with SEPARATE wording:
 * that one scans a whole persisted thread document, its text is byte-pinned by restart tests, and
 * the wording is part of its contract. The marker below names BOTH causes this module covers —
 * cancellation (user stop, plugin stop, caller release) AND interruption (provider failure) —
 * because what is being repaired here is not always a crash.
 *
 * THE DUPLICATION, stated because it is load-bearing and it already caused one defect. Two text
 * constants exist for the same shape, and they MUST stay distinct:
 *   - `SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT` (this file) — a run cancelled or interrupted
 *     inside a LIVE session. It says "re-issue the call", because the conversation continues here
 *     and the tool may or may not have run;
 *   - `INTERRUPTED_TOOL_RESULT_TEXT` (`server/persistence.ts:1674`) — a call left dangling by a
 *     SERVER CRASH, written while restoring the document. It says the call has NOT been executed
 *     since, which is a different claim and must not be conflated with the first.
 * `core/` may not import `server/`, so the second is DUPLICATED here by value
 * (`PERSISTENCE_INTERRUPTED_TOOL_RESULT_TEXT`) purely so `isInterruptedToolResult` recognises both
 * producers. That copy is byte-pinned against the server module's own source in
 * `core/transcript-repair.test.ts`; the earlier paraphrase of it silently missed every crash row.
 *
 * TWO INVARIANTS every caller here relies on, both pinned by test:
 *   - IDEMPOTENCE — one pass answers every dangling call, so a second pass over the repaired array
 *     finds nothing and writes nothing (a repair that grew the transcript on every restore is the
 *     failure mode the persistence pass documents at :1670-1672);
 *   - ANSWER POSITION — "already answered" is decided across the WHOLE array, not the block that
 *     follows the call, because a real result can legitimately sit anywhere (the owed-account path
 *     can answer a call later, a thread split moves tail rows into a child, a merged subagent
 *     transcript appends what it adopted). Adjacency-only scanning fabricates a second result for
 *     one call id, which is exactly what a provider request schema rejects.
 */

import type { HarnessMessage } from '../types';

/**
 * The exact marker the persistence-layer crash repair writes (persistence.ts:1674,
 * `INTERRUPTED_TOOL_RESULT_TEXT`). Reference only — this module never writes it, it only recognises
 * it so the two producers are treated identically by whoever reads the transcript afterwards.
 *
 * BYTE-EXACTNESS IS THE CONTRACT, and it is pinned by test (core/transcript-repair.test.ts reads
 * the server module's own source to do it): this file is in `core/` and must not import from
 * `server/` (the browser/lazy contract), so the string is duplicated here by value rather than
 * imported by name. When it was first written it carried a paraphrase of the server sentence, and
 * every row that repair actually produces was therefore UNRECOGNISED — the owed-account upgrade
 * (harness.ts `deliverOwedAccounts`, :9470) kept a "no outcome recorded" placeholder in front of a
 * real account for a call the server had already answered. Changing either sentence in
 * persistence.ts without changing this one re-opens that hole.
 */
const PERSISTENCE_INTERRUPTED_TOOL_RESULT_TEXT =
    'The server restarted before this tool call completed. The call was interrupted and has NOT been executed since; no result is available.';

/**
 * Content of a synthesized result standing in for a tool call that was never answered because the
 * run was cancelled or interrupted.
 *
 * Prose, not a JSON envelope, on purpose: the tool errored no more than a cancelled request did,
 * and a fabricated `{"error":...}` payload would claim a failure mode that never happened. It also
 * has to read as unfinished business, so an agent resuming the conversation re-issues the call
 * instead of trusting an answer that was never given.
 */
export const SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT =
    'Tool execution was cancelled or interrupted before it produced a result, so this call has no recorded outcome. The tool may or may not have run; re-issue the call if its result is needed.';

/** One dangling call found while scanning, plus where its synthesized result has to go. */
export type InterruptedToolCallEntry = {
    /** The `tool_calls[].id` left unanswered — also the id the synthesized result must carry. */
    callId: string;
    /**
     * The tool the call named (`tool_calls[].name`). A real result message carries it
     * (`src/harness.ts insertToolMessage` writes `name: call.name`), and the scanner already has
     * the call in hand, so the caller that BUILDS the replacement message never has to re-scan the
     * transcript for it — which matters because indices move while the repair splices.
     */
    callName: string;
    /** Index of the `assistant` message that asked for the call (position in the ORIGINAL array). */
    assistantIndex: number;
    /**
     * Index in the ORIGINAL array where the result belongs: immediately after the last existing
     * result of that assistant message. Mirrors `resultInsertIndex` (harness.ts:8569) — appending
     * at the end instead would leave a `user` message between the call and its answer. Entries
     * from the same assistant message share this index and stack in call order.
     */
    insertAt: number;
};

/**
 * Whether a message is a result synthesized for an unanswered call: either this module's marker or
 * the persistence layer's. The owed-delivery path (harness.ts `deliverOwedAccounts`) uses this to
 * upgrade such a placeholder into a real account when it learns the call actually was paid for.
 */
export const isInterruptedToolResult = (message?: HarnessMessage): boolean => {
    if (!message || message.role !== 'tool') return false;
    if (typeof message.content !== 'string') return false;
    return (
        message.content === SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT ||
        message.content === PERSISTENCE_INTERRUPTED_TOOL_RESULT_TEXT
    );
};

/**
 * Scan `messages[from..]` for tool calls that have no `tool` result, oldest first, describing
 * where each missing result belongs.
 *
 * Answered ids are collected from the WHOLE array rather than only the window, because a run's
 * tail can legitimately answer a call made earlier in the conversation and a window-local scan
 * would then fabricate a duplicate. The scan BOUND is the window: only turns this run wrote are
 * eligible for repair, so a dangling call parked by another subsystem stays untouched.
 *
 * @param messages Transcript array (read-only here).
 * @param from Index to start scanning from — the run's own root message.
 */
export const findInterruptedToolCalls = (messages: HarnessMessage[], from = 0): InterruptedToolCallEntry[] => {
    const answered = new Set<string>();
    for (const message of messages) {
        // A `tool` message answers its call by id — the same pairing `hasToolResult`
        // (harness.ts:8616) and the stored-outcome lookup (core/tool-outcome.ts:74) rely on.
        if (message.role === 'tool' && typeof message.toolCallId === 'string') answered.add(message.toolCallId);
    }

    const entries: InterruptedToolCallEntry[] = [];
    let cursor = Math.max(0, Math.floor(from));
    while (cursor < messages.length) {
        const message = messages[cursor];
        if (message?.role !== 'assistant') {
            cursor += 1;
            continue;
        }
        // Results of one assistant message sit directly after it; walk to the end of that run of
        // results to find where a missing one belongs (the `resultInsertIndex` walk).
        let insertAt = cursor + 1;
        while (insertAt < messages.length && messages[insertAt]?.role === 'tool') insertAt += 1;
        const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
        for (const call of calls) {
            const callId = call?.id;
            if (typeof callId !== 'string' || !callId) continue;
            if (answered.has(callId)) continue;
            // The name travels with the entry so the caller never re-scans for it — indices move
            // while the repair splices. Defensive like the id check above: a malformed live entry
            // can carry no name, and the empty string is what the live write path
            // (`insertToolMessage`, harness.ts) records for a nameless call anyway.
            const callName = typeof call?.name === 'string' ? call.name : '';
            entries.push({ callId, callName, assistantIndex: cursor, insertAt });
        }
        // The next round of calls can only come after this assistant message and its results.
        cursor = insertAt;
    }
    return entries;
};

/**
 * Make a RETAINED run tail well-formed: synthesize one `tool` result for every tool call in the
 * run's own range that has no result.
 *
 * @param messages Transcript array — mutated in place, exactly as the run's own write path mutates it.
 * @param from Start of the range owned by the run being repaired (its root user message). Entries
 *             before this index are left EXACTLY as they are.
 * @param createMessage Builds the replacement message for one dangling call. A callback so the
 *             caller keeps ownership of id allocation, `toolName`, and the `outcome` stamp —
 *             inventing those is the caller's contract, not this module's.
 * @returns The entries that were repaired, oldest first, each with the index its synthesized result
 *          occupies in the FINAL array and the message that was written.
 */
export const repairInterruptedToolCalls = <T>(
    messages: HarnessMessage[],
    from: number,
    createMessage: (entry: InterruptedToolCallEntry) => T,
): Array<InterruptedToolCallEntry & { index: number; message: T }> => {
    const entries = findInterruptedToolCalls(messages, from);
    if (!entries.length) return [];
    const repaired: Array<InterruptedToolCallEntry & { index: number; message: T }> = [];
    // Splice FIRST entry first, at its FINAL position (`insertAt` shifted by how many entries
    // precede it). Every earlier entry lands at or before this position, so after those
    // insertions the element originally at `insertAt` has been pushed to exactly
    // `insertAt + index` — inserting there puts the synthesized result in front of it, which is
    // where a real result would have gone. Forward order also mints `messageId`s in transcript
    // order (core/message-id.ts derives each id from the highest id already in the array), so a
    // repaired tail reads `msg-…` in position order like any other tail.
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) continue;
        const position = entry.insertAt + index;
        const message = createMessage(entry);
        messages.splice(position, 0, message as unknown as HarnessMessage);
        repaired.push({ ...entry, index: position, message });
    }
    return repaired;
};
