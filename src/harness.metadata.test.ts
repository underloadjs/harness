// The declarative half of the harness-owned core tools, asserted through the
// PUBLIC surface.
//
// These are the facts a model and an operator actually see: the toolRequest
// schema (names/regex/tags, uncapped selection, an optional per-query limit), the
// toolList inventory contract, the toolManage operations, the toolCreate security
// statement, the todoManage actions, the record tools' schemas and partial-update
// contract, and the agentDelegate allowlist. The server describes the same tools
// in its catalogue from `src/core/metadata.ts` - the copy these registrations use
// - so pinning the registered text here also pins what a descriptor advertises;
// `server/api.test.ts` asserts that projection end to end.
//
// T14: the wire names are toolRequest / toolList / toolManage / toolCreate /
// todoManage / profileManage / chapterManage / locationManage / agentManage /
// agentResult / agentDelegate.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';

// A harness needs agents, and an agent needs a transport. A provider URL is enough:
// nothing here runs a turn, so no request is ever made.
const provider = { baseURL: 'http://provider.test/v1' };

const solo = () => harness({ agents: { solo: agent({ model: 'test/model', provider }) } });

describe('core tool metadata', () => {
    it('advertises names/regex/tags selection with only a per-query limit', () => {
        const writer = solo();

        expect(writer.tools.toolRequest.parameters).toEqual({
            type: 'object',
            properties: {
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Exact wire names to enable, case-sensitive (e.g. ["fileList"]).'
                },
                regex: {
                    type: 'string',
                    description:
                        'JavaScript regex tested against tool names; bare source or /source/flags.'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Capability tags to look for, e.g. ["files", "read", "shell"].'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description:
                        "Optional per-query narrowing: return at most this many of THIS query's matches. It is not a global request cap."
                }
            },
            required: [],
            additionalProperties: false
        });

        // The model reads the description, not this file: uncapped selection, the
        // host-configured enabled bound, and newest-request precedence have to be
        // stated there too.
        expect(writer.tools.toolRequest.description).toBe(
            'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example agentDelegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.'
        );
        expect(writer.tools.toolRequest.tags).toEqual(['discovery', 'tools', 'catalogue']);
        expect(writer.tools.toolRequest.visibility).toBe('core');

        expect(writer.tools.toolList.parameters).toEqual({
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false
        });
        expect(writer.tools.toolList.tags).toEqual([
            'tools',
            'list',
            'catalogue',
            'inventory'
        ]);
        expect((writer.tools.toolManage.parameters as any).properties.operation).toEqual({
            type: 'string',
            enum: ['list', 'details', 'source', 'path', 'create', 'update', 'reload'],
            description: 'What to do.'
        });
        expect((writer.tools.toolManage.parameters as any).required).toEqual(['operation']);
    });

    it('keeps every core tool core and declares the toolCreate security statement', () => {
        const writer = solo();

        expect(
            [
                'toolRequest',
                'toolList',
                'toolManage',
                'toolCreate',
                'todoManage',
                'profileManage',
                'chapterManage',
                'locationManage',
                'agentManage',
                'agentResult'
            ].map((name) => writer.tools[name].visibility)
        ).toEqual([
            'core',
            'core',
            'core',
            'core',
            'core',
            'core',
            'core',
            'core',
            'core',
            'core'
        ]);

        expect(writer.tools.toolCreate.description).toBe(
            "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` (agent, agents, run). Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small."
        );
        expect(writer.tools.toolCreate.parameters).toEqual({
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
                    description:
                        'Capability tags, e.g. ["text", "upper"]. Required so toolRequest can find it.'
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
        });
        expect(writer.tools.toolCreate.tags).toEqual(['tools', 'create', 'extension', 'dynamic']);
    });

    it('declares the todoManage actions and result contract', () => {
        const writer = solo();

        // The enum is the accepted action list; ./todo.ts validates against the same
        // values and owns their order in error messages. R9 adds the paging cursor
        // and the text cap to the schema the model reads.
        expect(writer.tools.todoManage.parameters).toEqual({
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
        });
        expect(writer.tools.todoManage.tags).toEqual([
            'todo',
            'todos',
            'task',
            'tasks',
            'checklist',
            'plan'
        ]);
        expect(writer.tools.todoManage.description).toBe(
            'Manage the todo list for this harness session. Actions: "add" (requires text), "remove" (requires id), "check" (requires id; completed defaults to true, false unchecks), "uncheck" (requires id), and "list". Ids are stable strings returned by "add". The list is shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { todos, counts { total, completed, remaining }, page { offset, limit, hasMore, nextOffset? } } - 20 items by default, at most 100, and a 64 KiB serialized page budget, so pass page.nextOffset back as offset while page.hasMore. Every mutation returns { todo|removed, counts } with NO list, so call "list" to read it. Caps: 200 todos, 4000 characters of text each.'
        );
    });

    it('declares the record tools: CRUD actions, partial updates, and chapter bodies', () => {
        const writer = solo();

        // profileManage: same action set for every record tool.
        expect(writer.tools.profileManage.parameters).toEqual({
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
        });
        expect(writer.tools.profileManage.tags).toEqual([
            'profile',
            'profiles',
            'character',
            'characters',
            'person',
            'people'
        ]);
        expect(writer.tools.profileManage.description).toBe(
            'Manage character and people profiles for this harness session. Actions: "add" (requires name and description; optional traits and notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and "remove" (requires id). Traits are trimmed and deduplicated. Ids are stable strings returned by "add". Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { profile, counts }; "add"/"update" return { profile, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each.'
        );

        // chapterManage: the schema states the summary/body split and the order
        // sort, which is what the model relies on instead of reading the source.
        expect(writer.tools.chapterManage.parameters).toEqual({
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
        });
        expect(writer.tools.chapterManage.tags).toEqual([
            'chapter',
            'chapters',
            'story',
            'writing',
            'outline',
            'book'
        ]);
        expect(writer.tools.chapterManage.description).toBe(
            'Manage chapters for this harness session. Actions: "add" (requires title and summary; optional content, status and order), "list", "get" (requires id), "update" (requires id and at least one of title, summary, content, status, order; fields you omit are unchanged), and "remove" (requires id). Status is planned, draft or complete and defaults to planned. The optional integer order sorts list: ordered chapters first ascending, unordered ones after in insertion order. Ids are stable strings returned by "add". Lists and mutation results carry summaries without the body; only "get" returns content. Chapters are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { chapters, counts { total, planned, draft, complete }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { chapter, content, counts }; "add"/"update" return { chapter, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 chapters, 200-character titles, 4000-character summaries and content.'
        );

        // locationManage: the small record shape, no summary/body split.
        expect(writer.tools.locationManage.parameters).toEqual({
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
        });
        expect(writer.tools.locationManage.tags).toEqual([
            'location',
            'locations',
            'place',
            'places',
            'setting',
            'world'
        ]);
        expect(writer.tools.locationManage.description).toBe(
            'Manage locations for this harness session. Actions: "add" (requires name and description; optional notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, notes; fields you omit are unchanged), and "remove" (requires id). Ids are stable strings returned by "add". Locations are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { locations, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { location, counts }; "add"/"update" return { location, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 locations, 200-character names, 4000-character descriptions and notes.'
        );
    });

    it('registers agentDelegate from the allowlist, and never without subagents', () => {
        // No subagents: no agentDelegate tool at all, which is why the server's
        // agentDelegate descriptor is session-dependent.
        expect(solo().tools.agentDelegate).toBeUndefined();

        const team = harness({
            agents: {
                lead: agent({ model: 'test/model', provider }),
                helper: agent({ model: 'test/model', provider })
            },
            subagents: ['helper']
        });

        // The runtime declaration names the exact allowlist in its enum, and the
        // description states the one-level rule.
        expect(team.tools.agentDelegate.parameters).toEqual({
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    enum: ['helper'],
                    description: 'Subagent name, one of the configured allowlist.'
                },
                input: { type: 'string', description: 'The full brief the subagent should act on.' }
            },
            required: ['agent', 'input'],
            additionalProperties: false
        });
        expect(team.tools.agentDelegate.description).toBe(
            'Delegate a self-contained task to a configured subagent and return its answer. Subagents: helper. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.'
        );
        expect(team.tools.agentDelegate.visibility).toBe('core');
        expect(team.tools.agentDelegate.tags).toEqual(['agents', 'delegate', 'delegation', 'subagent', 'team']);
    });
});
