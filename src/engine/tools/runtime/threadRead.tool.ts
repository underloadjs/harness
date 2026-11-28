// threadRead — standalone source entry for reading one thread's transcript.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';
import { readThreadTranscript } from './threadRead';

export const THREAD_READ_NAME = 'threadRead';

// R2/R4 transcript reading. The third half of the thread trio: `threadList` shows
// which conversations exist, `threadSend` writes into one, and this tool READS one
// back. It is registered and declared for EVERY agent in the session at EVERY rank —
// not only the entry agent, and not only the thread's owner. THREADING IS NOT
// RANK-GATED: a bottom-of-the-ladder worker reads exactly the transcripts the
// entry agent reads (rank moves DELEGATION authority, never transcript access).
// The point is that a model can see the conversation a tool result only hinted at
// (a delegation it launched, a chat it received, a sibling thread its owner asked
// it to inspect).
//
// The thread id is an ADDRESS, never authority: it comes from `threadList`, and an
// unknown id is an honest error (a DELETED one is refused only outside the lineage that
// deleted it — see the IT19/F1 paragraph below). The calling run's own thread is supplied
// by the runtime (`context.threadId`), never by the model, so omitting `thread`
// reads the conversation the model is actually in.
//
// WHICH ERROR, SINCE 2026-11-15 (IT19 R2 soft delete), NARROWED 2026-11-27 (F1 of the
// branch/write-door wave): "unknown" and "deleted" are two different facts, and
// `threadMessages` says so. A SOFT-DELETED (`inactive`) conversation answers a stranger with
// its own refusal sentence, because nothing in the retained bytes says the conversation is
// inactive and a caller that reads them concludes it is live. What the IT19 sentence got wrong
// is the WHO: a soft delete is SCOPED, so the conversation that ran `threadDelete` — and any
// conversation in that same lineage — is the one reader with a reason to still ask (issue
// 0027's whole flow is "read the child, then release it"), and it gets the retained
// transcript. The gate is therefore the SAME lineage test the write doors use
// (`familyOfCaller`, applied in ONE place — `refuseUnreadableThread`, src/engine/harness.ts —
// which both read seams now call): inside the family the bytes are
// served, outside it — or when the caller id resolves to nothing, which `familyOfCaller`
// answers as unscoped and the gate reads as "not in your lineage" — the refusal is thrown. An
// id nothing has keeps the canonical not-found sentence (issue 0034's one sentence, three
// doors), and the host view (no caller thread) is unchanged: it is the door that still reads a
// released transcript for the server's own surfaces. R1 (2026-11-27) CLOSED THE OTHER HALF of
// that promise: F1 moved the gate onto the transcript seam only, while this entry still sourced
// its identity block from `thread()` — a DISCOVERY door that voids every `inactive` row — so
// the reads the seam admitted were refused here, by the tool, with the not-found sentence. The
// entry now asks the record half of the SAME door (`harness.threadReadRecord`), so admitting a
// transcript and serving its rows are one decision, and the only caller left with a refusal is
// the stranger the sentence describes.
//
// SCOPE (2026-11-15): the read is SESSION-WIDE. It used to be narrowed to the
// caller's thread family, which was consistent while all three thread doors refused
// everything outside it - but a prompt quotes a conversation by NAME, and the
// conversation a user names is usually a sibling, which the family excludes by design
// (issue 0027). A read discloses nothing the caller could not have been told, so the
// asymmetry is deliberate: READ any conversation in the session, WRITE (threadSend /
// threadDelete) only the ids `threadList` reports in `actOn`. The caller id is still
// passed to the seams, because it is what resolves a finished fork's `branch-N`.
//
// `context.threadId` is passed to the read seams as the CALLER thread, which is what
// lets a finished fork's `branch-N` transcript be resolved: that id is not in the live
// thread table, and only the caller's own record carries its fork history. A read of
// an id the harness cannot resolve is still the same honest error.
//
// Reading is bounded three ways, and every bound is reported as metadata rather
// than as a silent cut: the filtered message list pages with `offset`/`limit`, each
// message's text pages with `contentOffset`/`contentLimit`, and the whole page is
// held under a 32 KiB budget that is THE SAME SIZE and the SAME CURRENCY as the
// harness's serialized tool-result bound (`MODEL_TOOL_RESULT_BUDGET_BYTES`,
// ../../core/result-budget.ts). Since F8 the two are the same number in the same
// unit, and the reader reserves its own scaffolding against it:
//   - the budget is spent in ESCAPED payload bytes (core/payload-bytes.ts), the unit
//     the harness bills — not in raw UTF-8 text bytes, which is what it counted
//     before and the reason an escaping-heavy page was refused rather than sliced;
//   - `threadReadResultOverhead` measures the result's envelope (identity block,
//     counters, flags) and every message/tool-call/attachment receipt is charged its
//     measured shell, so the text allowance `threadReadPageAllowance` is what is left
//     after the document's own bookkeeping is paid for;
//   - the guarantee: a page the reader returns is DELIVERED, never replaced by the
//     envelope's truncation stub, whatever the text contains. The old "sharp edge /
//     open risk" wording described the F8 defect this reader used to carry, and it is
//     gone. (The "64 KiB result cap" and "256 KiB bound" this comment once cited were
//     earlier values of that constant; the constant is the contract, so no fixed
//     figure belongs in this sentence.) Attachment BYTES stay out of the result
//     entirely — a transcript read reports descriptors, because base64 in a tool
//     result costs the context window and tells the model nothing — but each
//     descriptor's own id/kind/name/mime text IS charged, because it is in the
//     document the cap measures.
//
// The description below states the DEFAULTS EXPLICITLY (20 messages, 4000 characters
// per field, 32768 bytes per page) because the old "omit every argument to read the
// whole thread from the start" promised a full read that this tool has never
// performed: an argument-less call returns the FIRST PAGE, and a model that believed
// the promise stopped reading after it. (I1)
//
// The pure reading/filtering/paging logic lives in ./threadRead (a non-entry
// helper, so the AST scanner ignores it); this entry only resolves the identity and
// fetches the transcript through the live harness handle.
export const THREAD_READ_METADATA: CoreToolMetadata = {
    name: THREAD_READ_NAME,
    description:
        `Read ONE PAGE of the committed transcript of one thread in this session: your own conversation, another agent's default conversation (agent:<name>), a host thread you were given by threadList, or a finished fork's branch-N transcript. With no arguments you get the FIRST page, never the whole thread: up to 20 messages ("limit"), each field cut at 4000 characters ("contentLimit"), the whole page held under a 32768-byte budget counted in the ESCAPED payload bytes the harness cap uses - that byte budget is a FIXED reader limit, reported back as "contentBudget" and NOT an argument you can set. Nothing is withheld silently, but the two kinds of cut are reported separately: "truncated" is true only when that byte BUDGET cut text or dropped messages, while a cut made by "contentLimit" is reported per message as "contentHasMore" plus "nextContentOffset" and leaves "truncated" false. "hasMore"/"nextOffset"/"nextContentOffset" still give the exact continuation: pass nextOffset back as "offset" while hasMore is true, and nextContentOffset back as "contentOffset" to finish one long message. The page also reports the counts and flags behind that: "total" (messages in the raw transcript BEFORE any filter, which INCLUDES the system seed), "matched" (the count that survives the filters, and the list "offset"/"limit" page through), "bytes" (what this page charged against that budget, in the same escaped bytes the harness cap counts - every message receipt, tool-call receipt and attachment descriptor included, not only the text), and per message "contentLength" plus the "argumentsTruncated" and "reasoningTruncated" flags. "thread" names the conversation and defaults to the thread you are running in; an unknown id is an error, and a DELETED id is an error for any conversation outside the lineage that deleted it. READING IS SESSION-WIDE: any conversation this session still holds resolves whatever its lineage - your own thread, an ancestor, a descendant, a SIBLING, another agent's default (agent:<name>), or a finished fork's branch-N - because a read discloses nothing the caller could not already be told; a conversation someone already DELETED is the one narrowing, and it reads back only for the conversation that deleted it and any conversation in that same lineage. What stays lineage-scoped is WRITING: threadSend and threadDelete reach only the ids threadList reports in "actOn". "thread" is an ADDRESS, so it takes an ID (thread-N, agent:<name>, branch-N) or the conversation's LABEL (IT14) and the two name the same conversation: an id wins when they collide, a label is matched exactly after trimming (no case folding, no prefix, no fuzzy match), a label held by two conversations is refused rather than guessed, and an address nothing answers is an error naming what you typed. "message" instead reads ONE raw message by 0-based transcript index and bypasses the filters and list pagination (out of range is an error; index 0 is the system seed). "regex" keeps only the messages that match: by default it is tested against each message's content, assistant reasoning, every tool call's name and raw arguments, and a tool message's name, case-sensitively unless you pass "flags" such as "i"; the "/pattern/flags" spelling is accepted and its flags win over "flags". "regexFields" narrows WHICH of those fields are searched, and every returned message then names its hits in "matchedFields" - including a hit in a field the page does not display, which is how you tell a real finding from your own tool-call arguments merely repeating the pattern you just sent. "includeSystem" (default false) leaves the system seed out of both the pages and the matching; pass true to read it. "role" narrows to one role. A tool call is shown as { id, name, argumentsLength } - a reference, so a page never re-pays for arguments text - and "toolArgs": "full" returns that text, paged like any other. Set "includeReasoning" to also return assistant reasoning, flagged when truncated. Attachments are reported as descriptors only (id, kind, name, mime, size) - never base64 bytes.`,
    tags: ['thread', 'threads', 'read', 'transcript', 'history', 'messages', 'conversation', 'regex'],
    // Same visibility as the rest of the thread trio: registered on the first
    // thread, then declared for every agent in the session (not searchable,
    // because a model cannot discover a tool whose ids it needs in order to use it).
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            thread: {
                type: 'string',
                minLength: 1,
                description:
                    'Address of the conversation to read: an id as reported by threadList (a host thread, agent:<name>, a delegated child, or a finished fork branch-N), or that conversation\'s LABEL (IT14) - the two name the same conversation, and a label is matched exactly after trimming. Reading is session-wide, so a live thread outside your lineage resolves too; a DELETED thread answers only for a caller in the lineage that deleted it, and a host reads it by id whatever the caller; only threadSend/threadDelete are lineage-scoped. Defaults to the thread you are running in.'
            },
            message: {
                type: 'integer',
                minimum: 0,
                description:
                    'Read only this one message, by 0-based index in the raw transcript. Bypasses regex/role/includeSystem filtering and list pagination; contentOffset/contentLimit still page its text. Index 0 is the system seed.'
            },
            regex: {
                type: 'string',
                minLength: 1,
                description:
                    'Keep only messages matching this JavaScript regular expression. By default tested against each message content, assistant reasoning, tool-call name and raw arguments, and a tool message name; "regexFields" narrows that set. Every returned message reports which fields hit as matchedFields. "/pattern/flags" is accepted.'
            },
            flags: {
                type: 'string',
                description:
                    'Regex flags for a bare "regex" (for example "i" or "m"). Ignored when "regex" is written as /pattern/flags. A malformed pattern is an error.'
            },
            regexFields: {
                type: 'array',
                items: { type: 'string', enum: ['content', 'reasoning', 'toolArguments', 'toolName'] },
                minItems: 1,
                description:
                    'Which fields "regex" searches: "content", assistant "reasoning", tool-call "toolArguments", and "toolName" (a tool call name or the tool a tool result answers). Defaults to all four. This narrows MATCHING only - what the page shows is governed by role, includeReasoning and toolArgs. Duplicates are ignored.'
            },
            role: {
                type: 'string',
                enum: ['system', 'user', 'assistant', 'tool'],
                description:
                    'Keep only messages with this role. Omit it to include every role the other filters allow - system messages need "includeSystem": true, so "role": "system" alone returns an empty page.'
            },
            includeSystem: {
                type: 'boolean',
                description:
                    'Include system-role messages in the pages AND in regex matching. Defaults to false: the seed is usually known already, and re-returning it cost budget on every page. Pass true to read it, or "message": 0 for that one message.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based position into the filtered message list. Defaults to 0; use nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'How many messages to return, 1-100. Defaults to 20.'
            },
            contentOffset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based character offset into each returned message content. Defaults to 0; use nextContentOffset to continue a long message.'
            },
            contentLimit: {
                type: 'integer',
                minimum: 1,
                maximum: 32000,
                description:
                    'Maximum characters of text returned per message (content, reasoning, and each tool-call arguments string when toolArgs is "full"). Defaults to 4000.'
            },
            includeReasoning: {
                type: 'boolean',
                description:
                    'Also return assistant reasoning for the returned messages. Defaults to false. Reasoning is searchable by "regex" whether or not you ask for it here.'
            },
            toolArgs: {
                type: 'string',
                enum: ['full', 'reference'],
                description:
                    'How assistant tool calls are displayed. "reference" (the default) lists each call as { id, name, argumentsLength } with NO arguments text, so a page does not spend budget on payload a model rarely needs. "full" returns the arguments string, paged by contentLimit and flagged when cut. "regex" searches the raw arguments either way.'
            }
        },
        additionalProperties: false
    }
};

export const metadata = THREAD_READ_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
//
// `activation: 'threads'` registers this entry with the rest of the thread trio on
// the FIRST createThread (or when a restore carries host threads), so an ordinary
// agent gains it without any configuration. `order: 265` sits between
// threadSend (260) and threadList (270) because that group registers in DESCENDING
// order (src/harness.ts ~872-883): the declarations become threadList, threadRead,
// threadSend — the roster first, so an id is always discoverable before the tool
// that addresses it.
export const registration = {
    group: 'runtime',
    activation: 'threads',
    order: 265,
    sessionBound: true,
    alwaysDeclared: false,
    listed: false
} as const;

export const execute = async (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('threadRead requires the live harness reference.');
    }

    const parameters = (context.parameters ?? {}) as Record<string, unknown>;

    // The id is the model's ONLY choice here: an explicit `thread` from threadList,
    // otherwise the conversation this run belongs to. `context.threadId` is set by
    // the runtime from RunState, so a model cannot point it at another conversation.
    // A manual `executeTool` call has no threadId at all, and then `thread` is
    // required — there is no honest default to guess.
    const requested = typeof parameters.thread === 'string' ? parameters.thread.trim() : '';
    const threadId = requested.length > 0 ? requested : context.threadId;

    if (threadId === undefined || threadId.length === 0) {
        throw new Error(
            'threadRead needs a thread: pass "thread" (see threadList), or call it from inside a conversation.'
        );
    }

    // `threadMessages` is the canonical read: it throws the harness's own "not available in
    // this harness" error for an id that never existed, and returns a DETACHED
    // copy, so a page cannot mutate live state.
    //
    // T10 finding S1 (why this is awaited): in worker mode a replica's copy of a conversation
    // is a hello snapshot plus this lane's own work, so a synchronous handle read would answer
    // from a PRIVATE projection - stale for a thread a sibling moved, and missing for a thread
    // another lane created. ./workers/lane-worker-loop.ts replaces these two members on a
    // replica with routed reads answered by the canonical harness, which are promises. Inline
    // the same calls stay synchronous, and awaiting a non-promise is the identical value, so
    // one source serves both modes and neither one gets an answer from the wrong side.
    //
    // `context.threadId` is the CALLER thread, passed so the seams can resolve an id that is
    // not in the live thread table — a finished fork's `branch-N` transcript, whose only
    // pointer lives in the caller's own fork history. It is never model-supplied, so it cannot
    // widen what a model may read; an id that resolves for nobody still errors.
    const messages = await context.harness.threadMessages(threadId, context.threadId);
    // R1 (2026-11-27) — THE DOOR FOLLOWS THE SEAM. This used to read the identity block from
    // `harness.thread()`, and `thread()` is a DISCOVERY door: IT19 R2 makes it answer
    // `undefined` for ANY `inactive` row, so a released conversation was refused HERE even when
    // the transcript read one line above had just admitted it - the lineage that released it,
    // and a host, both read it through the seam and then got "it was never created, or it was
    // deleted" from the tool, contradicting this entry's own description, the engine's refusal
    // sentence and `threadDelete`'s receipt. `threadReadRecord` is the record half of the SAME
    // door: same tables, same admission test, so the metadata can never out-vote the transcript.
    //
    // What stays exactly as it was: a never-created id is refused by the line above, with the
    // core's canonical sentence (this tail keeps it byte-for-byte for the routed door and for any
    // address that resolves for the transcript but not for the record), and a stranger to an
    // inactive conversation is refused by the seam with the lineage sentence.
    const record = await context.harness.threadReadRecord(threadId, context.threadId);

    if (record === undefined) {
        // The core's OWN sentence for this fact, byte-for-byte (issue 0034, src/harness.ts:5404 and the
        // routed `thread:read` refusal in ./workers/lane-authority.ts). One missing record is
        // one message, whichever door finds it; this tail used to say "has no record in this
        // harness", so the same id read through the tool and through `threadMessages`
        // disagreed.
        throw new Error(
            `Thread "${threadId}" is not available in this harness; it was never created, or it was deleted.`
        );
    }

    return readThreadTranscript(record, messages, parameters);
};
