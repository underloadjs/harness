// Canonical metadata for the harness-owned CORE tools.
//
// R18 note: the harness also declares core tools that are NOT harness-owned — the
// four everyday file tools (metadata in ../tools/catalogue.ts) and configured
// webSearch (../tools/websearch/index.ts). Their metadata lives with their real
// implementations; this file stays the single source for the session-bound
// harness-owned set (toolRequest/toolCreate/todoManage/agentDelegate), which is
// also what harnesses/core.ts exports to the server with sessionBound: true.
//
// WHY THIS FILE EXISTS (single source of truth)
// ---------------------------------------------
// The core tools are built in two very different places:
//   - src/harness.ts registers toolRequest, toolCreate, and (when the harness has
//     subagents) agentDelegate on the live harness;
//   - src/core/todo.ts builds todoManage from its factory closure.
// A SERVER also has to *describe* those same tools without building a harness:
// the Tools tab lists them for review and manual execution (R8), and a descriptor
// must never advertise a name, description, tag list, or schema that the runtime
// does not actually use. Keeping the metadata here — and having both the runtime
// registration and the server catalogue read it — makes that drift impossible.
//
// NAMING (T14): every tool is `<namespace><action>` — toolRequest, toolCreate,
// todoManage, agentDelegate — and the preset tools follow the same rule
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
//   - ./discovery.ts     — MAX_DISCOVERY_MATCHES, the enforced cap
//   - ../harness.ts      — registers these definitions as core tools
//   - ./todo.ts          — builds todoManage from TODO_MANAGE_METADATA
//   - ../../harnesses/core.ts — server catalogue entries for the same names

import type { ToolVisibility } from '../types';
import { MAX_DISCOVERY_MATCHES } from './discovery';

// Wire names. They are part of the harness contract: a model (and an operator)
// calls these exact strings, and the harness reserves them against every other
// tool source.
export const TOOL_REQUEST_NAME = 'toolRequest';
export const TOOL_CREATE_NAME = 'toolCreate';
export const TODO_MANAGE_NAME = 'todoManage';
export const AGENT_DELEGATE_NAME = 'agentDelegate';

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

// Discovery. The description itself carries the R7 contract — at most five
// matches, and `remaining` as the count of further ones — because the model reads
// the description, not this file.
export const TOOL_REQUEST_METADATA: CoreToolMetadata = {
    name: TOOL_REQUEST_NAME,
    description:
        `Find tools by capability tag and enable them. The searchable catalogue holds the list, shell, git, syntax, time, text, notes, and other tools; the everyday file tools (fileRead, fileWrite, fileEdit, fileGlob) are already available, as is webSearch when the host configured it. Pass the tags you need (for example ["files", "list"] or ["shell"] or ["git", "diff"]) and up to ${MAX_DISCOVERY_MATCHES} of the closest matches become available on your next turn. The result's "remaining" field counts any further tools that matched but were not listed, so add a more specific tag to drill into the rest. Call this before concluding that something cannot be done.`,
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
// factory closure (./todo.ts) rather than a module singleton — but its public
// description and schema are stable, so they live here with the rest. The
// `action` enum repeats ./todo.ts's ACTIONS list (that module validates and owns
// the order); keep the two in step when adding an action.
export const TODO_MANAGE_METADATA: CoreToolMetadata = {
    name: TODO_MANAGE_NAME,
    description:
        'Manage the todo list for this harness session. Actions: "add" (requires text), "remove" (requires id), "check" (requires id; completed defaults to true, false unchecks), "uncheck" (requires id), and "list". Ids are stable strings returned by "add". The list is shared by every agent in this harness, kept across turns, and cleared by reset. Returns todos plus counts { total, completed, remaining }, and the affected todo (or removed item).',
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
                description: 'Todo text for "add". Required for that action; trimmed before storage.'
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
    }
};

// Delegation (R4). Capability-by-configuration: the harness registers agentDelegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents — the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without — a catalogue-only description (the server lists the capability and
//     a session without subagents answers a clear 404 when it is called).
export const agentDelegateMetadata = (subagents: readonly string[] = []): CoreToolMetadata => {
    const listed = [...subagents];

    return {
        name: AGENT_DELEGATE_NAME,
        description:
            listed.length > 0
                ? `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`
                : 'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents — a session whose harness has none answers 404.',
        tags: ['agents', 'delegate', 'subagent', 'team'],
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

// The core set a harness without subagents registers: discovery, creation, todos.
export const coreToolMetadata = (): CoreToolMetadata[] => [
    TOOL_REQUEST_METADATA,
    TOOL_CREATE_METADATA,
    TODO_MANAGE_METADATA
];
