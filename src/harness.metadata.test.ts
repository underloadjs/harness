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
                'records',
                'tasks',
                'profiles',
                'chapters',
                'locations',
                'agentManage',
                'agentResult'
            ].map((name) => writer.tools[name].visibility)
        ).toEqual([
            'core', // toolRequest — the discovery bootstrap stays declared
            'searchable', // toolList
            'searchable', // toolManage
            'searchable', // toolCreate
            // R4: the engine is the escalation surface, so it is searchable — an agent
            // reaches it by name/tag when a wrapper's schema is what stops it, and it
            // never costs context in the bootstrap.
            'searchable', // records
            'core', // tasks — the session plan stays declared
            'searchable', // profiles
            'searchable', // chapters
            'searchable', // locations
            'searchable', // agentManage
            'searchable' // agentResult
        ]);

        expect(writer.tools.toolCreate.description).toEqual(
            "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` - the body really does hold the whole tool context, including `callTool` and `harness`, and not only the agent/agents/run fields a standalone body needs. A created tool must be PURELY STANDALONE: it computes its own result from its own arguments, deterministically, because the reason to create one is to replace a model turn with something repeatable. It is NOT a proxy for another tool - if your body would just call an existing tool, call that tool yourself instead, and do not create a second name for it. Nothing forbids the forwarding call (this package has no sandbox), but a session that runs threads on worker lanes reports it under the code `created-tool-proxy` so you learn what you built. Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small."
        );
        expect(writer.tools.toolCreate.parameters).toEqual(
            {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Wire name: a letter first, then letters, digits, \"_\" or \"-\", at most 64 characters."
                    },
                    "description": {
                        "type": "string",
                        "description": "What the tool does, shown to toolRequest and the model."
                    },
                    "tags": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "Capability tags, e.g. [\"text\", \"upper\"]. Required so toolRequest can find it."
                    },
                    "parameters": {
                        "type": "object",
                        "description": "Optional JSON Schema for the new tool's arguments."
                    },
                    "source": {
                        "type": "string",
                        "description": "Async function body, e.g. \"return args.trim().toUpperCase();\"."
                    }
                },
                "required": [
                    "name",
                    "description",
                    "tags",
                    "source"
                ],
                "additionalProperties": false
            }
        );
        expect(writer.tools.toolCreate.tags).toEqual(
            [
                "tools",
                "create",
                "extension",
                "dynamic"
            ]
        );
    });

    it('declares the task patch shape and the one result contract', () => {
        const writer = solo();

        // R9-R11: one optional patch replaces the action enum. T1 adds the
        // concurrency half of the contract. Nothing is required, because the
        // documented empty call is the READ: an entry without `id` adds a task, an
        // entry with a known `id` patches it, and `remove` deletes. `expects` is
        // the compare-and-swap token a guarded write needs, `claim`/`release`/
        // `takeover` (+ `leaseMs`) are the ownership verbs, `since` asks for the
        // change feed, `afterId` is the keyset cursor, and `mergeDisjoint` is the
        // opt-in stale-merge escape — the model has to be able to send all of them,
        // so every one of those keys must be in this schema.
        expect(writer.tools.tasks.parameters).toEqual(
            {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "Changes to apply, in order. Omit \"id\" to add a task (its \"text\" is required); give a known \"id\" to patch that task, leaving omitted fields unchanged. An empty list is a read. A patch of an existing id needs its \"expects\" token.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Existing task id to patch. Omit it to add a new task. Unknown ids are rejected."
                                },
                                "text": {
                                    "type": "string",
                                    "description": "Task text: required to add, and an optional rename when patching an \"id\". Trimmed, maximum 4000 characters, never blank."
                                },
                                "completed": {
                                    "type": "boolean",
                                    "description": "true marks the task done, false reopens it. Omitted leaves the stored flag unchanged."
                                }
                            },
                            "additionalProperties": false
                        }
                    },
                    "remove": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "Exact task ids to delete. Every id must exist; an id may not also appear in \"tasks\". A deletion needs its \"expects\" token."
                    },
                    "ids": {
                        "type": "array",
                        "items": {
                            "type": "string"
                        },
                        "description": "Task ids to read, for when you want one record rather than a page. One id answers with \"entry\", several with \"entries\"."
                    },
                    "expects": {
                        "type": "array",
                        "description": "The revisions you READ, one { id, rev } per id this call patches or removes (required for those writes). A rev that no longer matches rejects the whole call AND returns the current task, so you re-read in the same step rather than overwriting their work; or pass `mergeDisjoint: true` when the concurrent change touched only fields your patch leaves out. An id may carry at most one token.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Task id you read."
                                },
                                "rev": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "The \"rev\" that record had when you read it, copied from an earlier result."
                                }
                            },
                            "required": [
                                "id",
                                "rev"
                            ],
                            "additionalProperties": false
                        }
                    },
                    "since": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Asks for the task change log after this revision: the result also carries \"changes\" (at most 50 entries, oldest first) with \"changesHasMore\" and \"changesTruncated\". Pass the \"storeRev\" of your last read. Must not be ahead of the store."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "0-based index of the first returned task. Defaults to 0; use page.nextOffset from the previous page. Cannot be combined with \"afterId\"."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "Page size, 1-100. Defaults to 20."
                    },
                    "afterId": {
                        "type": "string",
                        "pattern": "^[0-9]+$",
                        "description": "Keyset cursor: the last id of the previous page. Returns the tasks with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike \"offset\". Sets page.nextAfterId while page.hasMore."
                    },
                    "mergeDisjoint": {
                        "type": "boolean",
                        "description": "true applies a stale content patch anyway when every concurrent change since your read touched only fields your patch does not set; an overlapping field still rejects. Never merges a removal."
                    }
                },
                "additionalProperties": false
            }
        );
        expect(writer.tools.tasks.tags).toEqual(
            [
                "task",
                "tasks",
                "todo",
                "todos",
                "checklist",
                "plan"
            ]
        );
        // The exact description (src/tools/runtime/tasks.tool.ts). It is what the
        // model reads, so the SHARED-list warning, the `rev`/`expects` compare-and-
        // swap rule, the `mergeDisjoint` escape, the claim/release/takeover lease
        // and the `storeRev`/`afterId`/`since` result contract all have to be
        // stated here as well as in the schema above.
        expect(writer.tools.tasks.description).toEqual(
            "Maintain the task list for this harness session (the `tasks` collection of the session store). Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no \"id\" ADDS a task and must carry \"text\"; an entry with a known \"id\" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete; `ids` reads specific tasks. Unknown ids are invalid, one id may appear in only ONE of `tasks`/`remove`/`ids` per call, and the whole call is validated before anything changes - a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls, and unique across every collection in the session. THE LIST IS SHARED: every agent and thread in this harness writes the same records, and another agent may change one while you work. There are no locks and no claims: any thread may write any task at any time. Each record carries `rev`, its content revision (starts at 1; only a real text/completed change bumps it), plus who last edited it and when. Send `expects: [{ id, rev }]` with the rev you READ for every id you patch or remove - a call from an agent must send it, or the write is refused as a guarded write. If the rev moved, the WHOLE call is rejected AND the refusal returns the CURRENT TASK (its fields and values), so you can retry in one step instead of re-reading; when the concurrent change touched only fields your patch leaves out, pass `mergeDisjoint: true` and your patch applies anyway. EVERY successful call returns the SAME bounded page: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId? }, storeRev } - 20 items by default, at most 100, and a serialized page budget below the result cap. Page by `offset`/`limit`, or by `afterId` (the last id of the previous page) when tasks may be removed mid-walk. Pass `since: storeRev` to also get `changes` with `changesHasMore`/`changesTruncated`: the task events since that revision (add/update/remove) instead of re-reading the list. Caps: 200 tasks, 4000 characters of text. If this tool is what stops you - a field you cannot name, a cap you need to escape - the same records are open through the `records` store tool (tags: records, store, collection) with no field-level restriction at all."
        );
    });

    it('declares the record tools: CRUD actions, partial updates, and chapter bodies', () => {
        const writer = solo();

        // profiles: same action set for every record wrapper.
        expect(writer.tools.profiles.parameters).toEqual(
            {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "add",
                            "list",
                            "get",
                            "update",
                            "remove"
                        ],
                        "description": "One of: add, list, get, update, remove."
                    },
                    "id": {
                        "type": "string",
                        "description": "Profile id returned by \"add\". Required for get/update/remove."
                    },
                    "name": {
                        "type": "string",
                        "maxLength": 200,
                        "description": "Profile name for \"add\", or a replacement name for \"update\". Required for \"add\"; trimmed. Maximum 200 characters."
                    },
                    "description": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Profile description for \"add\", or a replacement for \"update\". Required for \"add\"; trimmed. Maximum 4000 characters."
                    },
                    "traits": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "maxLength": 200
                        },
                        "maxItems": 32,
                        "description": "Optional traits for \"add\" or \"update\", e.g. [\"brave\", \"loyal\"]. Entries are trimmed and deduplicated; omitting the field leaves traits unchanged on update. At most 32 traits of 200 characters each."
                    },
                    "notes": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Optional free-form notes for \"add\" or \"update\". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters."
                    },
                    "expects": {
                        "type": "array",
                        "description": "The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current profile.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Profile id you read."
                                },
                                "rev": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "The \"rev\" that record had when you read it, copied from an earlier result."
                                }
                            },
                            "required": [
                                "id",
                                "rev"
                            ],
                            "additionalProperties": false
                        }
                    },
                    "mergeDisjoint": {
                        "type": "boolean",
                        "description": "true applies a stale update anyway when every concurrent change since your read touched only fields your update does not set."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "For \"list\" only: 0-based index of the first profile. Defaults to 0; use page.nextOffset from the previous page."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "For \"list\" only: page size, 1-100. Defaults to 20."
                    }
                },
                "required": [
                    "action"
                ],
                "additionalProperties": false
            }
        );
        expect(writer.tools.profiles.tags).toEqual(
            [
                "profile",
                "profiles",
                "character",
                "characters",
                "person",
                "people"
            ]
        );
        expect(writer.tools.profiles.description).toEqual(
            "Manage character and people profiles for this harness session (the `profiles` collection of the session store). Actions: \"add\" (requires name and description; optional traits and notes), \"list\", \"get\" (requires id), \"update\" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and \"remove\" (requires id). Traits are trimmed and deduplicated, and an empty string clears notes. Ids are stable strings returned by \"add\", unique across every collection in the session. Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. \"list\" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. \"get\" and \"add\"/\"update\" return { profile, counts } and \"remove\" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any profile - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current profile, and \"mergeDisjoint\": true applies your update anyway when the concurrent change touched only fields you left out. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection)."
        );

        // chapterManage: the schema states the summary/body split and the order
        // sort, which is what the model relies on instead of reading the source.
        expect(writer.tools.chapters.parameters).toEqual(
            {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "add",
                            "list",
                            "get",
                            "update",
                            "remove"
                        ],
                        "description": "One of: add, list, get, update, remove."
                    },
                    "id": {
                        "type": "string",
                        "description": "Chapter id returned by \"add\". Required for get/update/remove."
                    },
                    "title": {
                        "type": "string",
                        "maxLength": 200,
                        "description": "Chapter title for \"add\", or a replacement for \"update\". Required for \"add\"; trimmed. Maximum 200 characters."
                    },
                    "summary": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Chapter summary for \"add\", or a replacement for \"update\". Required for \"add\"; trimmed. Maximum 4000 characters. Lists show this, never the body."
                    },
                    "content": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Optional chapter body for \"add\" or \"update\". Omitting it leaves the stored body unchanged; an empty string clears it. Returned only by \"get\". Maximum 4000 characters."
                    },
                    "status": {
                        "type": "string",
                        "enum": [
                            "planned",
                            "draft",
                            "complete"
                        ],
                        "description": "Lifecycle state. \"add\" defaults to planned; omitting it on \"update\" leaves the state unchanged."
                    },
                    "order": {
                        "type": "integer",
                        "minimum": -1000000,
                        "maximum": 1000000,
                        "description": "Optional sort position for \"add\" or \"update\"; a list sorts ordered chapters ascending, then unordered ones by insertion. There is no move action and no way to clear it - set a new value."
                    },
                    "expects": {
                        "type": "array",
                        "description": "The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current chapter.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Chapter id you read."
                                },
                                "rev": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "The \"rev\" that record had when you read it, copied from an earlier result."
                                }
                            },
                            "required": [
                                "id",
                                "rev"
                            ],
                            "additionalProperties": false
                        }
                    },
                    "mergeDisjoint": {
                        "type": "boolean",
                        "description": "true applies a stale update anyway when every concurrent change since your read touched only fields your update does not set."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "For \"list\" only: 0-based index of the first chapter. Defaults to 0; use page.nextOffset from the previous page."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "For \"list\" only: page size, 1-100. Defaults to 20."
                    }
                },
                "required": [
                    "action"
                ],
                "additionalProperties": false
            }
        );
        expect(writer.tools.chapters.tags).toEqual(
            [
                "chapter",
                "chapters",
                "story",
                "outline",
                "scene",
                "writing"
            ]
        );
        expect(writer.tools.chapters.description).toEqual(
            "Manage the chapter tracker for this harness session (the `chapters` collection of the session store). Actions: \"add\" (requires title and summary; optional content, status and order), \"list\", \"get\" (requires id), \"update\" (requires id and at least one of title, summary, content, status, order; fields you omit are unchanged), and \"remove\" (requires id). Status is one of planned, draft or complete and defaults to planned; ids are stable strings returned by \"add\"; order is an optional integer sort position - a list returns ordered chapters first (ascending) and unordered ones in insertion order, so updating \"order\" IS the move. Records are shared by every agent in this harness, kept across turns, and cleared by reset. LIST AND MUTATION RESULTS CARRY SUMMARIES, NEVER THE BODY: \"content\" appears only in \"get\", so ten chapters never cost ten bodies. \"list\" returns ONE PAGE: { chapters, counts { total, planned, draft, complete }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. \"get\" and \"add\"/\"update\" return { chapter, counts } and \"remove\" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any chapter - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current chapter, and \"mergeDisjoint\": true applies your patch anyway when the concurrent change touched only fields you left out. Caps: 200 chapters, 200-character titles, 4000-character summary and content. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection)."
        );

        // locationManage: the small record shape, no summary/body split.
        expect(writer.tools.locations.parameters).toEqual(
            {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "add",
                            "list",
                            "get",
                            "update",
                            "remove"
                        ],
                        "description": "One of: add, list, get, update, remove."
                    },
                    "id": {
                        "type": "string",
                        "description": "Location id returned by \"add\". Required for get/update/remove."
                    },
                    "name": {
                        "type": "string",
                        "maxLength": 200,
                        "description": "Location name for \"add\", or a replacement name for \"update\". Required for \"add\"; trimmed. Maximum 200 characters."
                    },
                    "description": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Location description for \"add\", or a replacement for \"update\". Required for \"add\"; trimmed. Maximum 4000 characters."
                    },
                    "notes": {
                        "type": "string",
                        "maxLength": 4000,
                        "description": "Optional free-form notes for \"add\" or \"update\". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters."
                    },
                    "expects": {
                        "type": "array",
                        "description": "The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current location.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Location id you read."
                                },
                                "rev": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "description": "The \"rev\" that record had when you read it, copied from an earlier result."
                                }
                            },
                            "required": [
                                "id",
                                "rev"
                            ],
                            "additionalProperties": false
                        }
                    },
                    "mergeDisjoint": {
                        "type": "boolean",
                        "description": "true applies a stale update anyway when every concurrent change since your read touched only fields your update does not set."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "For \"list\" only: 0-based index of the first location. Defaults to 0; use page.nextOffset from the previous page."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "For \"list\" only: page size, 1-100. Defaults to 20."
                    }
                },
                "required": [
                    "action"
                ],
                "additionalProperties": false
            }
        );
        expect(writer.tools.locations.tags).toEqual(
            [
                "location",
                "locations",
                "place",
                "places",
                "setting",
                "settings",
                "world"
            ]
        );
        expect(writer.tools.locations.description).toEqual(
            "Manage places and settings for this harness session (the `locations` collection of the session store). Actions: \"add\" (requires name and description; optional notes), \"list\", \"get\" (requires id), \"update\" (requires id and at least one of name, description, notes; fields you omit are unchanged), and \"remove\" (requires id). Ids are stable strings returned by \"add\", unique across every collection in the session. Omitting notes on \"update\" leaves them unchanged; an empty string clears them. Locations are shared by every agent in this harness, kept across turns, and cleared by reset. \"list\" returns ONE PAGE: { locations, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. \"get\" and \"add\"/\"update\" return { location, counts } and \"remove\" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any location - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current location, and \"mergeDisjoint\": true applies your update anyway when the concurrent change touched only fields you left out. Caps: 200 locations, 200-character names, 4000-character descriptions and notes. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection)."
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
