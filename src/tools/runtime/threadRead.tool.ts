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
// Reading is bounded three ways, and every bound is reported as metadata rather
// than as a silent cut: the filtered message list pages with `offset`/`limit`, each
// message's text pages with `contentOffset`/`contentLimit`, and the whole page is
// held under a 32 KiB text budget so the harness's 64 KiB result cap never turns the
// answer into an opaque truncation envelope. Attachment bytes stay out of the result
// entirely: a transcript read reports descriptors, because base64 in a tool result
// costs the context window and tells the model nothing.
//
// The pure reading/filtering/paging logic lives in ./threadRead (a non-entry
// helper, so the AST scanner ignores it); this entry only resolves the identity and
// fetches the transcript through the live harness handle.
export const THREAD_READ_METADATA: CoreToolMetadata = {
    name: THREAD_READ_NAME,
    description:
        `Read the committed transcript of one thread in this session: your own conversation, another agent's default conversation (agent:<name>), or a host thread you were given by threadList. Omit every argument to read the whole thread from the start. "thread" names the conversation and defaults to the thread you are running in; an unknown or deleted id is an error. "message" instead reads ONE raw message by 0-based transcript index and bypasses the filters and list pagination (out of range is an error). "regex" keeps only the messages that match: it is tested against each message's content, plus assistant reasoning, plus every tool call's name and arguments, case-sensitively unless you pass "flags" such as "i"; the "/pattern/flags" spelling is accepted and its flags win over "flags". "role" narrows to one role - system messages ARE included unless you filter them out. Pagination applies to the filtered list: "offset"/"limit" (default 20, maximum 100) page over "matched" (the filtered count), so pass nextOffset back as offset while hasMore is true; one message's text pages with "contentOffset"/"contentLimit" (default 4000, maximum 32000) using contentHasMore and nextContentOffset. The text a page returns is capped at 32768 UTF-8 bytes (contentBudget): when that cap cuts anything, truncated is true and hasMore/nextOffset/nextContentOffset say exactly how to continue. Attachments are reported as descriptors only (id, kind, name, mime, size) - never base64 bytes. Set "includeReasoning" to also return assistant reasoning, flagged when truncated. Tool calls are always listed with their id and name, and their arguments are paged like text.`,
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
                    'Thread id to read, as reported by threadList (a host thread, agent:<name>, or a delegated child). Defaults to the thread you are running in.'
            },
            message: {
                type: 'integer',
                minimum: 0,
                description:
                    'Read only this one message, by 0-based index in the raw transcript. Bypasses regex/role filtering and list pagination; contentOffset/contentLimit still page its text.'
            },
            regex: {
                type: 'string',
                minLength: 1,
                description:
                    'Keep only messages matching this JavaScript regular expression. Tested against each message content, assistant reasoning, and tool-call name/arguments. "/pattern/flags" is accepted.'
            },
            flags: {
                type: 'string',
                description:
                    'Regex flags for a bare "regex" (for example "i" or "m"). Ignored when "regex" is written as /pattern/flags. A malformed pattern is an error.'
            },
            role: {
                type: 'string',
                enum: ['system', 'user', 'assistant', 'tool'],
                description:
                    'Keep only messages with this role. Omit it to include every role, system messages included.'
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
                    'Maximum characters of text returned per message (content, each tool-call arguments string, and reasoning). Defaults to 4000.'
            },
            includeReasoning: {
                type: 'boolean',
                description:
                    'Also return assistant reasoning for the returned messages. Defaults to false.'
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

export const execute = (context: ToolContext) => {
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

    // `threadMessages` is the canonical read: it throws the harness's own
    // "not available in this harness" error for an id that never existed or was
    // deleted, and returns a DETACHED copy, so a page cannot mutate live state.
    const messages = context.harness.threadMessages(threadId);
    const record = context.harness.thread(threadId);

    if (record === undefined) {
        throw new Error(
            `Thread "${threadId}" has no record in this harness; it was never created, or it was deleted.`
        );
    }

    return readThreadTranscript(record, messages, parameters);
};
