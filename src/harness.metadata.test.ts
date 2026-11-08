// The declarative half of the harness-owned core tools, asserted through the
// PUBLIC surface.
//
// These are the facts a model and an operator actually see: the toolRequest
// schema (names/regex/tags, uncapped selection, an optional per-query limit), the
// toolList inventory contract, the toolManage operations, the toolCreate security
// statement, the task actions, the record tools' schemas and partial-update
// contract, and the delegate allowlist. The server describes the same tools
// in its catalogue from `src/core/metadata.ts` - the copy these registrations use
// - so pinning the registered text here also pins what a descriptor advertises;
// `server/api.test.ts` asserts that projection end to end.
//
// T14: the wire names are toolRequest / toolList / toolManage / toolCreate /
// task / profileManage / chapterManage / locationManage / agentManage /
// agentResult / delegate.

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
                        'Exact wire names to enable, case-sensitive (e.g. ["files"]).'
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
            'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example delegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.'
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
                'task',
                'profileManage',
                'chapterManage',
                'locationManage',
                'agentManage',
                'agentResult'
            ].map((name) => writer.tools[name].visibility)
        ).toEqual([
            'core', // toolRequest — the discovery bootstrap stays declared
            'searchable', // toolList
            'searchable', // toolManage
            'searchable', // toolCreate
            'core', // task — the session plan stays declared
            'searchable', // profileManage
            'searchable', // chapterManage
            'searchable', // locationManage
            'searchable', // agentManage
            'searchable' // agentResult
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

    it('declares the task patch shape and the one result contract', () => {
        const writer = solo();

        // R9-R11: one optional patch replaces the action enum. Nothing is required,
        // because the documented empty call is the READ: an entry without `id` adds
        // a task, an entry with a known `id` patches it, and `remove` deletes.
        expect(writer.tools.task.parameters).toEqual({
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    description:
                        'Changes to apply, in order. Omit "id" to add a task (its "text" is required); give a known "id" to patch that task, leaving omitted fields unchanged. An empty list is a read.',
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description:
                                    'Existing task id to patch. Omit it to add a new task. Unknown ids are rejected.'
                            },
                            text: {
                                type: 'string',
                                description:
                                    'Task text: required to add, and an optional rename when patching an "id". Trimmed, maximum 4000 characters, never blank.'
                            },
                            completed: {
                                type: 'boolean',
                                description:
                                    'true marks the task done, false reopens it. Omitted leaves the stored flag unchanged.',
                            }
                        },
                        additionalProperties: false
                    }
                },
                remove: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Exact task ids to delete. Every id must exist; an id may not also appear in "tasks".'
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        '0-based index of the first returned task. Defaults to 0; use page.nextOffset from the previous page.'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                    description: 'Page size, 1-100. Defaults to 20.'
                }
            },
            additionalProperties: false
        });
        expect(writer.tools.task.tags).toEqual([
            'task',
            'tasks',
            'todo',
            'todos',
            'checklist',
            'plan'
        ]);
        expect(writer.tools.task.description).toBe(
            "Maintain the task list for this harness session. Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no \"id\" ADDS a task and must carry \"text\"; an entry with a known \"id\" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete. Unknown ids are invalid, an id may not appear twice in `tasks` or in both `tasks` and `remove`, and the whole call is validated before anything changes - so a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls. The list is shared by every agent in this harness, kept across turns, and cleared by reset. EVERY successful call returns the SAME bounded page of the current list: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? } } - 20 items by default, at most 100, and a 64 KiB serialized page budget, so pass page.nextOffset back as `offset` while page.hasMore, or set `offset`/`limit` to choose the page. Caps: 200 tasks, 4000 characters of text each."
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

    it('registers delegate from the allowlist, and never without subagents', () => {
        // No subagents: no delegate tool at all, which is why the server's
        // delegate descriptor is session-dependent.
        expect(solo().tools.delegate).toBeUndefined();

        const team = harness({
            agents: {
                lead: agent({ model: 'test/model', provider }),
                helper: agent({ model: 'test/model', provider })
            },
            subagents: ['helper']
        });

        // The runtime declaration names the exact allowlist in its enum, and the
        // description states the one-level rule. T28: the argument surface is derived
        // from the entry's own literal, so this pins the DERIVATION (only `agent` is
        // replaced) rather than restating a schema that would drift.
        const parameters = team.tools.delegate.parameters as {
            properties: Record<string, any>;
            required: string[];
            additionalProperties: boolean;
        };

        expect(parameters.properties.agent).toEqual({
            type: 'string',
            enum: ['helper'],
            description: 'Subagent name, one of the configured allowlist.'
        });
        expect(parameters.properties.input).toEqual({
            type: 'string',
            description: 'The full brief the subagent should act on.'
        });
        // The T28 arguments are declared on the live tool, not only in the
        // catalogue row.
        expect(Object.keys(parameters.properties)).toEqual([
            'agent',
            'input',
            'maxChars',
            'requireClarification',
            'timeoutMs',
            'scope'
        ]);
        expect(parameters.required).toEqual(['agent', 'input']);
        expect(parameters.additionalProperties).toBe(false);
        expect(team.tools.delegate.description).toContain(
            'Delegate a self-contained task to a configured subagent and return its answer. Subagents: helper.'
        );
        expect(team.tools.delegate.description).toContain('cannot delegate further');
        // The result contract is stated where the model reads it.
        expect(team.tools.delegate.description).toContain('invocationId');
        expect(team.tools.delegate.description).toContain('partialContent');
        expect(team.tools.delegate.visibility).toBe('core');
        expect(team.tools.delegate.tags).toEqual(['agents', 'delegate', 'delegation', 'subagent', 'team']);
    });
});
