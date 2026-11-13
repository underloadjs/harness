// threadRead — standalone source entry for reading one thread's transcript.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';
import { readThreadTranscript } from './threadRead';

export const THREAD_READ_NAME = 'threadRead';

// R2/R4 transcript reading. The third half of the thread trio: `threadList` shows
// which conversations exist, `threadSend` writes into one, and this tool READS one
// back. It is available to EVERY agent, not only the primary or the thread's owner:
// the point is that a model can see the conversation a tool result only hinted at
// (a delegation it launched, a chat it received, a sibling thread its owner asked
// it to inspect).
//
// The thread id is an ADDRESS, never authority: it comes from `threadList`, and an
// unknown or deleted id is an honest error. The calling run's own thread is supplied
// by the runtime (`context.threadId`), never by the model, so omitting `thread`
// reads the conversation the model is actually in.
//
// `context.threadId` is passed to the read seams as the CALLER thread, which is what
// lets a finished fork's `branch-N` transcript be resolved: that id is not in the live
// thread table, and only the caller's own record carries its fork history. A read of
// an id the harness cannot resolve is still the same honest error.
//
// Reading is bounded three ways, and every bound is reported as metadata rather
// than as a silent cut: the filtered message list pages with `offset`/`limit`, each
// message's text pages with `contentOffset`/`contentLimit`, and the whole page is
// held under a 32 KiB text budget — an EIGHTH of the harness's serialized
// tool-result bound (`MODEL_TOOL_RESULT_BUDGET_BYTES`, 256 KiB in
// ../../core/result-budget.ts), which leaves the envelope, the per-field JSON
// overhead and any escaping inflation room to stay inside it — so the answer never
// degrades into an opaque truncation envelope. (The "64 KiB result cap" this comment
// used to cite was that constant's value before the read budget was raised 4x; the
// 32 KiB page budget itself is unchanged.) Attachment bytes stay out of the result
// entirely: a transcript read reports descriptors, because base64 in a tool result
// costs the context window and tells the model nothing.
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
        `Read ONE PAGE of the committed transcript of one thread in this session: your own conversation, another agent's default conversation (agent:<name>), a host thread you were given by threadList, or a finished fork's branch-N transcript. With no arguments you get the FIRST page, never the whole thread: up to 20 messages ("limit"), each field cut at 4000 characters ("contentLimit"), the whole page held under 32768 UTF-8 bytes ("contentBudget"). Nothing is withheld silently - when anything is, "truncated" is true and "hasMore"/"nextOffset"/"nextContentOffset" give the exact continuation: pass nextOffset back as "offset" while hasMore is true, and nextContentOffset back as "contentOffset" to finish one long message. "thread" names the conversation and defaults to the thread you are running in; an unknown or deleted id is an error. Scope is exactly what threadList shows you: your own thread, an ancestor, one of your descendants, or any default conversation (agent:<name>) in your family - an id that exists OUTSIDE that set is refused as not visible, which is a roster problem rather than a typo, so re-read threadList instead of correcting the id. "message" instead reads ONE raw message by 0-based transcript index and bypasses the filters and list pagination (out of range is an error; index 0 is the system seed). "regex" keeps only the messages that match: by default it is tested against each message's content, assistant reasoning, every tool call's name and raw arguments, and a tool message's name, case-sensitively unless you pass "flags" such as "i"; the "/pattern/flags" spelling is accepted and its flags win over "flags". "regexFields" narrows WHICH of those fields are searched, and every returned message then names its hits in "matchedFields" - including a hit in a field the page does not display, which is how you tell a real finding from your own tool-call arguments merely repeating the pattern you just sent. "includeSystem" (default false) leaves the system seed out of both the pages and the matching; pass true to read it. "role" narrows to one role. A tool call is shown as { id, name, argumentsLength } - a reference, so a page never re-pays for arguments text - and "toolArgs": "full" returns that text, paged like any other. Set "includeReasoning" to also return assistant reasoning, flagged when truncated. Attachments are reported as descriptors only (id, kind, name, mime, size) - never base64 bytes.`,
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
                    'Thread id to read, as reported by threadList: a host thread, agent:<name>, a delegated child, or a finished fork branch-N transcript. Defaults to the thread you are running in.'
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
    // this harness" error for an id that never existed or was deleted, and returns a DETACHED
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
    const record = await context.harness.thread(threadId, context.threadId);

    if (record === undefined) {
        throw new Error(
            `Thread "${threadId}" has no record in this harness; it was never created, or it was deleted.`
        );
    }

    return readThreadTranscript(record, messages, parameters);
};
