// Canonical metadata for the harness-owned CORE tools.
//
// R18 note: the harness also declares core tools that are NOT harness-owned - the
// four everyday file tools (metadata in ../tools/catalogue.ts) and configured
// webSearch (../tools/websearch/index.ts). Their metadata lives with their real
// implementations; this file stays the single source for the session-bound
// harness-owned set (toolRequest/toolCreate/todoManage/profileManage/
// chapterManage/locationManage/agentManage/agentResult/agentDelegate, plus the
// CONDITIONAL actionRequest and threadFork added by N3), which is also what
// harnesses/core.ts exports to the server with sessionBound: true.
//
// N3 conditional tools: actionRequest is registered only when `interaction` is
// configured, threadFork only when `forks` is enabled. Like TOOL_CANCEL they are
// exported individually and deliberately omitted from coreToolMetadata(), which
// stays the always-registered set.
//
// WHY THIS FILE EXISTS (single source of truth)
// ---------------------------------------------
// The core tools are built in two very different places:
//   - src/harness.ts registers toolRequest, toolCreate, and (when the harness has
//     subagents) agentDelegate on the live harness;
//   - src/core/todo.ts builds todoManage from its factory closure, and
//     src/core/profile.ts, chapter.ts, and location.ts do the same for the
//     session record tools.
// A SERVER also has to *describe* those same tools without building a harness:
// the Tools tab lists them for review and manual execution (R8), and a descriptor
// must never advertise a name, description, tag list, or schema that the runtime
// does not actually use. Keeping the metadata here - and having both the runtime
// registration and the server catalogue read it - makes that drift impossible.
//
// NAMING (T14): every tool is `<namespace><action>` - toolRequest, toolCreate,
// todoManage, profileManage, chapterManage, locationManage, agentManage,
// agentResult, agentDelegate - and the preset tools follow the same rule
// (fileRead, fileWrite, fileEdit, fileList, fileGlob, commandRun, webSearch,
// timeNow, textCount, diceRoll, noteSearch, textSummarize, testFlaky). The
// namespace is what groups related tools in discovery; the action is what the
// model calls. There are no compatibility aliases: the old names are gone.
//
// This module is deliberately data + one function: no agent, no transport, no
// harness, so the server can import it cheaply and a descriptor stays purely
// declarative.
//
// The DISCOVERY cap (R7) lives in core/discovery.ts as MAX_DISCOVERY_MATCHES; the
// toolRequest schema below imports it so the advertised maximum and the enforced
// cap are the same number.
//
// Cross-references:
//   - ./discovery.ts     - MAX_DISCOVERY_MATCHES, the enforced cap
//   - ../harness.ts      - registers these definitions as core tools
//   - ./todo.ts          - builds todoManage from TODO_MANAGE_METADATA
//   - ./profile.ts / ./chapter.ts / ./location.ts - build the session record tools
//   - ../../harnesses/core.ts - server catalogue entries for the same names

import type { ToolVisibility } from '../types';
import { MAX_DISCOVERY_MATCHES } from './discovery';
import { ACTION_REQUEST_LIMITS } from './action';

// Wire names. They are part of the harness contract: a model (and an operator)
// calls these exact strings, and the harness reserves them against every other
// tool source.
export const TOOL_REQUEST_NAME = 'toolRequest';
export const TOOL_CREATE_NAME = 'toolCreate';
export const TODO_MANAGE_NAME = 'todoManage';
export const PROFILE_MANAGE_NAME = 'profileManage';
export const CHAPTER_MANAGE_NAME = 'chapterManage';
export const LOCATION_MANAGE_NAME = 'locationManage';
// Agent inspection (R3). agentManage lists every configured agent plus truncated
// result previews; agentResult reads one completed result in pages. Both are
// ALWAYS-registered core tools: a subagent has the same view of the session's
// other agents as the primary, so a delegated worker can inspect what its
// siblings already produced.
export const AGENT_MANAGE_NAME = 'agentManage';
export const AGENT_RESULT_NAME = 'agentResult';
export const AGENT_DELEGATE_NAME = 'agentDelegate';
// N3 owner interaction and private history forks. Both are CONDITIONAL core
// tools (registered only when interaction/forks are configured), like
// toolCancel, so they are deliberately not part of coreToolMetadata().
export const ACTION_REQUEST_NAME = 'actionRequest';
export const THREAD_FORK_NAME = 'threadFork';
// Targeted cancellation for background tool calls (T3/R4). Not part of
// coreToolMetadata(): it is declared to the model ONLY while that agent actually
// has calls in flight, so it costs no context on ordinary requests and a server
// catalogue that lists standing capabilities does not advertise a control that
// has nothing to cancel.
export const TOOL_CANCEL_NAME = 'toolCancel';

// One core tool's declarative half: everything a request declaration or a server
// catalogue needs, and nothing that could execute.
export type CoreToolMetadata = {
    name: string;
    description: string;
    tags: readonly string[];
    parameters: Record<string, unknown>;
    // Always 'core': every entry is declared on every request. Typed rather than
    // literal so a catalogue entry can copy it without a widening cast.
    visibility: ToolVisibility;
};

// Discovery. The description itself carries the R7 contract - at most five
// matches, and `remaining` as the count of further ones - because the model reads
// the description, not this file. It also explains direct core calls and the
// `alreadyAvailable` report (R1): a query naming an already-declared capability
// (agentDelegate in a harness with subagents is the motivating case) must not look
// like a miss, and those tools need no enabling.
export const TOOL_REQUEST_METADATA: CoreToolMetadata = {
    name: TOOL_REQUEST_NAME,
    description:
        `Find tools by capability tag and enable them, and check which tools you already have. The searchable catalogue holds the list, shell, git, syntax, time, text, notes, and other tools; the everyday file tools (fileRead, fileWrite, fileEdit, fileGlob) are already available, as is webSearch when the host configured it. Pass the tags you need (for example ["files", "list"] or ["shell"] or ["git", "diff"]) and up to ${MAX_DISCOVERY_MATCHES} of the closest matches become available on your next turn. The result's "remaining" field counts any further tools that matched but were not listed, so add a more specific tag to drill into the rest. The "alreadyAvailable" list names the tools you can call directly right now without enabling anything - for example agentDelegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. Call this before concluding that something cannot be done.`,
    tags: ['discovery', 'tools', 'catalogue'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capability tags to look for, e.g. ["files", "read", "shell"].'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_DISCOVERY_MATCHES,
                description: `How many matches to enable: 1-${MAX_DISCOVERY_MATCHES}. Defaults to ${MAX_DISCOVERY_MATCHES} (the maximum); a lower value gives a tighter shortlist.`
            }
        },
        required: ['tags'],
        additionalProperties: false
    }
};

// Runtime creation (R2b). The text is the security statement the model is given:
// a created tool runs with the process's permissions and there is no sandbox.
export const TOOL_CREATE_METADATA: CoreToolMetadata = {
    name: TOOL_CREATE_NAME,
    description:
        "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` (agent, agents, run). Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small.",
    tags: ['tools', 'create', 'extension', 'dynamic'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description:
                    'Wire name: a letter first, then letters, digits, "_" or "-", at most 64 characters.'
            },
            description: {
                type: 'string',
                description: 'What the tool does, shown to toolRequest and the model.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capability tags, e.g. ["text", "upper"]. Required so toolRequest can find it.'
            },
            parameters: {
                type: 'object',
                description: "Optional JSON Schema for the new tool's arguments."
            },
            source: {
                type: 'string',
                description: 'Async function body, e.g. "return args.trim().toUpperCase();".'
            }
        },
        required: ['name', 'description', 'tags', 'source'],
        additionalProperties: false
    }
};

// Session todos (R1/R2). Session state, not catalogue state, which is why it is a
// factory closure (./todo.ts) rather than a module singleton - but its public
// description and schema are stable, so they live here with the rest. The
// `action` enum repeats ./todo.ts's ACTIONS list (that module validates and owns
// the order); keep the two in step when adding an action.
export const TODO_MANAGE_METADATA: CoreToolMetadata = {
    name: TODO_MANAGE_NAME,
    description:
        'Manage the todo list for this harness session. Actions: "add" (requires text), "remove" (requires id), "check" (requires id; completed defaults to true, false unchecks), "uncheck" (requires id), and "list". Ids are stable strings returned by "add". The list is shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { todos, counts { total, completed, remaining }, page { offset, limit, hasMore, nextOffset? } } - 20 items by default, at most 100, and a 64 KiB serialized page budget, so pass page.nextOffset back as offset while page.hasMore. Every mutation returns { todo|removed, counts } with NO list, so call "list" to read it. Caps: 200 todos, 4000 characters of text each.',
    tags: ['todo', 'todos', 'task', 'tasks', 'checklist', 'plan'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'remove', 'check', 'uncheck', 'list'],
                description: 'One of: add, remove, check, uncheck, list.'
            },
            text: {
                type: 'string',
                description:
                    'Todo text for "add". Required for that action; trimmed. Maximum 4000 characters.'
            },
            id: {
                type: 'string',
                description: 'Todo id returned by "add". Required for remove/check/uncheck.'
            },
            completed: {
                type: 'boolean',
                description:
                    'For "check" only: true (default) marks complete, false unchecks. "uncheck" is the same as false.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first item. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// Session character/people profiles. Same factory-closure lifecycle as todos
// (./profile.ts), and the same action set as the other two record tools. The
// description documents the partial-update contract because the model reads the
// description, not this file.
export const PROFILE_MANAGE_METADATA: CoreToolMetadata = {
    name: PROFILE_MANAGE_NAME,
    description:
        'Manage character and people profiles for this harness session. Actions: "add" (requires name and description; optional traits and notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and "remove" (requires id). Traits are trimmed and deduplicated. Ids are stable strings returned by "add". Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { profile, counts }; "add"/"update" return { profile, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each.',
    tags: ['profile', 'profiles', 'character', 'characters', 'person', 'people'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Profile id returned by "add". Required for get/update/remove.'
            },
            name: {
                type: 'string',
                maxLength: 200,
                description:
                    'Profile name for "add", or a replacement name for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            description: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Profile description for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters.'
            },
            traits: {
                type: 'array',
                items: { type: 'string', maxLength: 200 },
                maxItems: 32,
                description:
                    'Optional traits for "add" or "update", e.g. ["brave", "loyal"]. Entries are trimmed and deduplicated; omitting the field leaves traits unchanged on update. At most 32 traits of 200 characters each.'
            },
            notes: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Optional free-form notes for "add" or "update". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first profile. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// Session chapters. The description states the two chapter-specific rules the
// model must know: summaries in lists/results, and the body only from "get".
export const CHAPTER_MANAGE_METADATA: CoreToolMetadata = {
    name: CHAPTER_MANAGE_NAME,
    description:
        'Manage chapters for this harness session. Actions: "add" (requires title and summary; optional content, status and order), "list", "get" (requires id), "update" (requires id and at least one of title, summary, content, status, order; fields you omit are unchanged), and "remove" (requires id). Status is planned, draft or complete and defaults to planned. The optional integer order sorts list: ordered chapters first ascending, unordered ones after in insertion order. Ids are stable strings returned by "add". Lists and mutation results carry summaries without the body; only "get" returns content. Chapters are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { chapters, counts { total, planned, draft, complete }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { chapter, content, counts }; "add"/"update" return { chapter, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 chapters, 200-character titles, 4000-character summaries and content.',
    tags: ['chapter', 'chapters', 'story', 'writing', 'outline', 'book'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Chapter id returned by "add". Required for get/update/remove.'
            },
            title: {
                type: 'string',
                maxLength: 200,
                description:
                    'Chapter title for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            summary: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Short summary for "add", or a replacement for "update". Required for "add"; trimmed. Returned by list. Maximum 4000 characters.'
            },
            content: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Chapter body for "add" or "update". Optional; trimmed. Never returned by list or mutation results - use "get" to read it. Maximum 4000 characters.'
            },
            status: {
                type: 'string',
                enum: ['planned', 'draft', 'complete'],
                description:
                    'Chapter status. Defaults to "planned" on add; omitting it on update leaves it unchanged.'
            },
            order: {
                type: 'integer',
                description:
                    'Optional sort position. Lower values list first; chapters without one follow in insertion order. Omitting it on update leaves it unchanged.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first chapter. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// Session locations/places. Deliberately small: every result carries the whole
// record, so there is no summary/body split.
export const LOCATION_MANAGE_METADATA: CoreToolMetadata = {
    name: LOCATION_MANAGE_NAME,
    description:
        'Manage locations for this harness session. Actions: "add" (requires name and description; optional notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, notes; fields you omit are unchanged), and "remove" (requires id). Ids are stable strings returned by "add". Locations are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { locations, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { location, counts }; "add"/"update" return { location, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 locations, 200-character names, 4000-character descriptions and notes.',
    tags: ['location', 'locations', 'place', 'places', 'setting', 'world'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Location id returned by "add". Required for get/update/remove.'
            },
            name: {
                type: 'string',
                maxLength: 200,
                description:
                    'Location name for "add", or a replacement name for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            description: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Location description for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters.'
            },
            notes: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Optional free-form notes for "add" or "update". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first location. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// Agent inspection (R3). These bounds are the declared contract AND the runtime
// values (the harness imports them), so the descriptions cannot advertise a
// preview/page size the implementation does not use.
//
//   - PREVIEW: how many characters of each completed answer agentManage shows;
//   - LIST_PER_AGENT: how many recent invocations per agent agentManage lists;
//   - RETENTION: how many completed invocation results the harness keeps
//     (active runs are always retained regardless of this cap);
//   - PAGE / PAGE_MAX: the default and maximum characters agentResult returns
//     per page. The page cap is deliberately far below the 64 KiB serialized
//     tool-result bound even with JSON escaping, so a long result is paged
//     explicitly instead of being silently truncated by boundToolResult.
export const AGENT_MANAGE_PREVIEW_CHARS = 200;
export const AGENT_MANAGE_LIST_PER_AGENT = 5;
export const AGENT_RESULT_RETENTION = 64;
export const AGENT_RESULT_PAGE_CHARS = 4000;
export const AGENT_RESULT_PAGE_MAX_CHARS = 8000;

// Listing. No arguments: the session already defines the agent set, so a
// parameter would only invite the model to filter it.
export const AGENT_MANAGE_METADATA: CoreToolMetadata = {
    name: AGENT_MANAGE_NAME,
    description:
        `List every configured agent in this harness session with previews of recent results. Each entry carries the agent's name, role (primary/subagent), model, invocationCount, and up to ${AGENT_MANAGE_LIST_PER_AGENT} recent invocations - roots, delegations, and forks - newest first. A result preview is at most ${AGENT_MANAGE_PREVIEW_CHARS} characters, flags whether it was truncated, and reports the full contentLength; a running invocation has status "running" and no content. Use agentResult with the agent name and optional invocationId to read a full completed result. Only completed answer text is ever exposed here: never system instructions, transcript messages, tool arguments, or tool bodies.`,
    tags: ['agents', 'results', 'preview', 'subagent', 'team', 'inspect'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

// Full retrieval. `agent` is required; omitting `invocationId` selects that
// agent's latest completed result. `offset`/`limit` page a long answer without
// relying on the harness's 64 KiB result cap.
export const AGENT_RESULT_METADATA: CoreToolMetadata = {
    name: AGENT_RESULT_NAME,
    description:
        `Read the completed result of one agent invocation. Pass "agent"; optionally pass "invocationId" from agentManage (omit it for that agent's latest completed result). The result contains content, contentLength, offset, limit, hasMore, and nextOffset when more remains; page through by passing nextOffset back as offset. Each page is at most ${AGENT_RESULT_PAGE_MAX_CHARS} characters (default ${AGENT_RESULT_PAGE_CHARS}), so a long answer is returned in full across pages instead of being silently truncated. A running invocation returns status "running" with no content, a failed or cancelled invocation reports its error and no content, an unknown invocation is an error, and an agent that has not run yet returns status "empty". Only completed answer text is exposed - never system instructions, transcripts, tool arguments, or tool bodies.`,
    tags: ['agents', 'result', 'answer', 'output', 'subagent', 'inspect'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            agent: {
                type: 'string',
                minLength: 1,
                description: 'Configured agent name whose result to read.'
            },
            invocationId: {
                type: 'string',
                minLength: 1,
                description:
                    'Invocation id from agentManage. Omit to read that agent\'s latest completed result.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based character offset into the result. Defaults to 0; use nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: AGENT_RESULT_PAGE_MAX_CHARS,
                description: `Page size in characters, 1-${AGENT_RESULT_PAGE_MAX_CHARS}. Defaults to ${AGENT_RESULT_PAGE_CHARS}.`
            }
        },
        required: ['agent'],
        additionalProperties: false
    }
};

// Delegation (R4). Capability-by-configuration: the harness registers agentDelegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - a catalogue-only description (the server lists the capability and
//     a session without subagents answers a clear 404 when it is called).
export const agentDelegateMetadata = (subagents: readonly string[] = []): CoreToolMetadata => {
    const listed = [...subagents];

    return {
        name: AGENT_DELEGATE_NAME,
        description:
            listed.length > 0
                ? `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`
                : 'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404.',
        tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                agent:
                    listed.length > 0
                        ? {
                              type: 'string',
                              enum: listed,
                              description: 'Subagent name, one of the configured allowlist.'
                          }
                        : {
                              type: 'string',
                              description: 'Subagent name, one of the session harness allowlist.'
                          },
                input: { type: 'string', description: 'The full brief the subagent should act on.' }
            },
            required: ['agent', 'input'],
            additionalProperties: false
        }
    };
};

// The core set a harness without subagents registers: discovery, creation, todos,
// the three session record tools, and agent inspection. Order is the
// registration order the harness uses, so this list is also what a catalogue
// projection reads.
export const coreToolMetadata = (): CoreToolMetadata[] => [
    TOOL_REQUEST_METADATA,
    TOOL_CREATE_METADATA,
    TODO_MANAGE_METADATA,
    PROFILE_MANAGE_METADATA,
    CHAPTER_MANAGE_METADATA,
    LOCATION_MANAGE_METADATA,
    AGENT_MANAGE_METADATA,
    AGENT_RESULT_METADATA
];

// Targeted cancellation (T3/R4). The harness declares this ONLY while the calling
// agent has a background call pending, which is exactly when it can succeed, so
// the description is written for that moment: it explains that the call keeps
// running unless it observes its abort signal, and that the harness stops waiting
// either way. `callId` is the id from the `tool_call` event / pending list.
export const TOOL_CANCEL_METADATA: CoreToolMetadata = {
    name: TOOL_CANCEL_NAME,
    description:
        'Cancel one background tool call you started. Pass the callId shown in the pending list (tool_call events, tool_result.pending, or a wakeup). The harness releases the call immediately and ignores any later result, so you can continue without waiting for it. A tool that watches its abort signal also stops its own work; JavaScript cannot be preempted, so a tool that ignores the signal may still finish in the background. Cancelling an id that is not pending is an error.',
    tags: ['tool', 'tools', 'cancel', 'background', 'abort'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            callId: {
                type: 'string',
                minLength: 1,
                description: 'The callId of the pending tool call to cancel.'
            }
        },
        required: ['callId'],
        additionalProperties: false
    }
};

// N3 owner interaction. The model MUST offer alternatives and a recommendation,
// and the owner can ALWAYS answer with free text; there is deliberately no
// `allowCustom` argument for the model to switch off. The description states the
// recommendation contract because the model reads the description, not this file.
export const ACTION_REQUEST_METADATA: CoreToolMetadata = {
    name: ACTION_REQUEST_NAME,
    description:
        'Ask the owner a bounded question when the request is genuinely ambiguous and guessing would be unsafe or wasteful. Supply ONE question, 2-8 distinct options (each an id plus a short label and optional description), and `recommended` set to the id of the option you suggest. The owner may still answer with free text, so never assume your recommendation was accepted; the tool result tells you exactly which answer was chosen. Ask at most one focused question at a time, and never use this for a decision you can make safely yourself.',
    tags: ['question', 'ask', 'clarify', 'owner', 'user', 'choice', 'interaction'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                minLength: 1,
                maxLength: ACTION_REQUEST_LIMITS.question,
                description:
                    'The one question to ask. Be specific about the decision and why it matters. Maximum 4000 characters.'
            },
            recommended: {
                type: 'string',
                minLength: ACTION_REQUEST_LIMITS.optionIdMin,
                maxLength: ACTION_REQUEST_LIMITS.optionIdMax,
                pattern: '^[A-Za-z0-9_-]+$',
                description:
                    'Id of the option you recommend. MUST exactly match one of the supplied option ids; an unknown id is rejected (there is no automatic fallback).'
            },
            options: {
                type: 'array',
                minItems: ACTION_REQUEST_LIMITS.optionsMin,
                maxItems: ACTION_REQUEST_LIMITS.optionsMax,
                description:
                    'Alternative answers, 2-8 entries with unique ids. The owner can still reply with free text.',
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            minLength: ACTION_REQUEST_LIMITS.optionIdMin,
                            maxLength: ACTION_REQUEST_LIMITS.optionIdMax,
                            pattern: '^[A-Za-z0-9_-]+$',
                            description:
                                'Stable id, 1-32 characters of letters, digits, "_" or "-". Unique within this request.'
                        },
                        label: {
                            type: 'string',
                            minLength: ACTION_REQUEST_LIMITS.optionLabelMin,
                            maxLength: ACTION_REQUEST_LIMITS.optionLabelMax,
                            description: 'Short human-visible label, 1-120 characters.'
                        },
                        description: {
                            type: 'string',
                            maxLength: ACTION_REQUEST_LIMITS.optionDescriptionMax,
                            description:
                                'Optional supporting detail, at most 500 characters.'
                        }
                    },
                    required: ['id', 'label'],
                    additionalProperties: false
                }
            }
        },
        required: ['question', 'recommended', 'options'],
        additionalProperties: false
    }
};

// N3 private history fork. The model names the task for the forked thread; the
// runtime copies the owner transcript itself, so the model neither supplies nor
// sees raw history here. `label` is display-only.
export const THREAD_FORK_METADATA: CoreToolMetadata = {
    name: THREAD_FORK_NAME,
    description:
        'Fork a private thread that reads the ENTIRE current conversation independently and returns one final summary. Use it when a self-contained investigation benefits from isolated reasoning without polluting this transcript. The new thread cannot see later messages and never receives this agent\'s tools automatically beyond the runtime grant. Pass the task as `input`; `label` is an optional short display name. The fork shares this process and any external side effects, so it is not a sandbox.',
    tags: ['fork', 'thread', 'branch', 'history', 'summarize', 'research'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                minLength: 1,
                description:
                    'The complete task for the forked thread. It reads the full current history, so refer to that context rather than repeating it.'
            },
            label: {
                type: 'string',
                minLength: 1,
                maxLength: ACTION_REQUEST_LIMITS.forkLabelMax,
                description:
                    'Optional short display label. Maximum 120 characters; it grants no authority.'
            }
        },
        required: ['input'],
        additionalProperties: false
    }
};
