// The declarative half of the harness-owned core tools, asserted through the
// PUBLIC surface.
//
// These are the facts a model and an operator actually see: the toolRequest
// schema (the R7 five-match cap and the `remaining` count), the toolCreate
// security statement, the todoManage actions, the record tools' schemas and
// partial-update contract, and the agentDelegate allowlist. The server describes
// the same tools in its catalogue from `src/core/metadata.ts` - the copy these
// registrations use - so pinning the registered text here also pins what a
// descriptor advertises; `server/api.test.ts` asserts that projection end to end.
//
// T14: the wire names are toolRequest / toolCreate / todoManage / profileManage /
// chapterManage / locationManage / agentDelegate.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';

// A harness needs agents, and an agent needs a transport. A provider URL is enough:
// nothing here runs a turn, so no request is ever made.
const provider = { baseURL: 'http://provider.test/v1' };

const solo = () => harness({ agents: { solo: agent({ model: 'test/model', provider }) } });

describe('core tool metadata', () => {
    it('advertises the five-match discovery cap and the remaining count', () => {
        const writer = solo();

        expect(writer.tools.toolRequest.parameters).toEqual({
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
                    maximum: 5,
                    description:
                        'How many matches to enable: 1-5. Defaults to 5 (the maximum); a lower value gives a tighter shortlist.'
                }
            },
            required: ['tags'],
            additionalProperties: false
        });

        // The model reads the description, not this file: the cap and `remaining`
        // have to be stated there too.
        expect(writer.tools.toolRequest.description).toBe(
            'Find tools by capability tag and enable them. The searchable catalogue holds the list, shell, git, syntax, time, text, notes, and other tools; the everyday file tools (fileRead, fileWrite, fileEdit, fileGlob) are already available, as is webSearch when the host configured it. Pass the tags you need (for example ["files", "list"] or ["shell"] or ["git", "diff"]) and up to 5 of the closest matches become available on your next turn. The result\'s "remaining" field counts any further tools that matched but were not listed, so add a more specific tag to drill into the rest. Call this before concluding that something cannot be done.'
        );
        expect(writer.tools.toolRequest.tags).toEqual(['discovery', 'tools', 'catalogue']);
        expect(writer.tools.toolRequest.visibility).toBe('core');
    });

    it('keeps every core tool core and declares the toolCreate security statement', () => {
        const writer = solo();

        expect(
            ['toolRequest', 'toolCreate', 'todoManage', 'profileManage', 'chapterManage', 'locationManage'].map(
                (name) => writer.tools[name].visibility
            )
        ).toEqual(['core', 'core', 'core', 'core', 'core', 'core']);

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
        expect(team.tools.agentDelegate.tags).toEqual(['agents', 'delegate', 'subagent', 'team']);
    });
});
