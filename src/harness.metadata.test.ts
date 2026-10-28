// The declarative half of the harness-owned core tools, asserted through the
// PUBLIC surface.
//
// These are the facts a model and an operator actually see: the requestTools
// schema (the R7 five-match cap and the `remaining` count), the createTool
// security statement, the todoTools actions, and the delegate allowlist. The server
// describes the same tools in its catalogue from `src/core/metadata.ts` — the copy
// these registrations use — so pinning the registered text here also pins what a
// descriptor advertises; `server/api.test.ts` asserts that projection end to end.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';

// A harness needs agents, and an agent needs a transport. A provider URL is enough:
// nothing here runs a turn, so no request is ever made.
const provider = { baseURL: 'http://provider.test/v1' };

const solo = () => harness({ agents: { solo: agent({ model: 'test/model', provider }) } });

describe('core tool metadata', () => {
    it('advertises the five-match discovery cap and the remaining count', () => {
        const writer = solo();

        expect(writer.tools.requestTools.parameters).toEqual({
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
        expect(writer.tools.requestTools.description).toBe(
            'Find tools by capability tag and enable them. The whole catalogue is searchable (including the file and command tools). Pass the tags you need (for example ["files", "read"] or ["shell"] or ["git", "diff"]) and up to 5 of the closest matches become available on your next turn. The result\'s "remaining" field counts any further tools that matched but were not listed, so add a more specific tag to drill into the rest. Call this before concluding that something cannot be done.'
        );
        expect(writer.tools.requestTools.tags).toEqual(['discovery', 'tools', 'catalogue']);
        expect(writer.tools.requestTools.visibility).toBe('core');
    });

    it('keeps every core tool core and declares the createTool security statement', () => {
        const writer = solo();

        expect(
            ['requestTools', 'createTool', 'todoTools'].map((name) => writer.tools[name].visibility)
        ).toEqual(['core', 'core', 'core']);

        expect(writer.tools.createTool.description).toBe(
            "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` (agent, agents, run). Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small."
        );
        expect(writer.tools.createTool.parameters).toEqual({
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description:
                        'Wire name: a letter first, then letters, digits, "_" or "-", at most 64 characters.'
                },
                description: {
                    type: 'string',
                    description: 'What the tool does, shown to requestTools and the model.'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Capability tags, e.g. ["text", "upper"]. Required so requestTools can find it.'
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
        expect(writer.tools.createTool.tags).toEqual(['tools', 'create', 'extension', 'dynamic']);
    });

    it('declares the todoTools actions and result contract', () => {
        const writer = solo();

        // The enum is the accepted action list; ./todo.ts validates against the same
        // values and owns their order in error messages.
        expect(writer.tools.todoTools.parameters).toEqual({
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
                        'Todo text for "add". Required for that action; trimmed before storage.'
                },
                id: {
                    type: 'string',
                    description: 'Todo id returned by "add". Required for remove/check/uncheck.'
                },
                completed: {
                    type: 'boolean',
                    description:
                        'For "check" only: true (default) marks complete, false unchecks. "uncheck" is the same as false.'
                }
            },
            required: ['action'],
            additionalProperties: false
        });
        expect(writer.tools.todoTools.tags).toEqual([
            'todo',
            'todos',
            'task',
            'tasks',
            'checklist',
            'plan'
        ]);
        expect(writer.tools.todoTools.description).toBe(
            'Manage the todo list for this harness session. Actions: "add" (requires text), "remove" (requires id), "check" (requires id; completed defaults to true, false unchecks), "uncheck" (requires id), and "list". Ids are stable strings returned by "add". The list is shared by every agent in this harness, kept across turns, and cleared by reset. Returns todos plus counts { total, completed, remaining }, and the affected todo (or removed item).'
        );
    });

    it('registers delegate from the allowlist, and never without subagents', () => {
        // No subagents: no delegate tool at all, which is why the server's delegate
        // descriptor is session-dependent.
        expect(solo().tools.delegate).toBeUndefined();

        const team = harness({
            agents: {
                lead: agent({ model: 'test/model', provider }),
                helper: agent({ model: 'test/model', provider })
            },
            subagents: ['helper']
        });

        // The runtime declaration names the exact allowlist in its enum, and the
        // description states the one-level rule.
        expect(team.tools.delegate.parameters).toEqual({
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
        expect(team.tools.delegate.description).toBe(
            'Delegate a self-contained task to a configured subagent and return its answer. Subagents: helper. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.'
        );
        expect(team.tools.delegate.visibility).toBe('core');
        expect(team.tools.delegate.tags).toEqual(['agents', 'delegate', 'subagent', 'team']);
    });
});
