// Built-in slash commands — the harness's own operations, exposed as commands.
//
// WHY THESE FIVE
// -------------
// `/help` and `/tools` are discovery: an operator has to be able to ask a session
// what it can do without reading source. `/task`, `/websearch` and `/webfetch`
// are pass-throughs to tools that ALREADY own the behaviour (`task`, `search`,
// `fetch`), so the command layer adds argument shaping and readable output — it
// never reimplements a store or a provider.
//
// PASS-THROUGH MEANS THE LIVE TOOL
// --------------------------------
// Each pass-through calls `context.harness.executeTool(name, parameters)`, so the
// command mutates THIS harness's task list and uses THIS harness's configured web
// credentials, exactly like a model tool call or the UI's Tools tab would. It
// also inherits the tool's own bounds (the 200/4000/20-per-page task caps, the
// fetch content-type gate) instead of duplicating them here.
//
// The parameter objects below are the tools' real schemas — NOT guesses:
//   - `tasks`   -> { tasks?, remove?, ids?, expects?, offset?, limit? }
//                                            (tools/runtime/tasks.tool.ts, patch/CAS
//                  semantics in core/records.ts — Decision P deleted the ownership
//                  verbs, so there is no claim to pass through)
//   - `search`  -> { query, maxResults?, provider? }      (tools/websearch/index.ts)
//   - `fetch`   -> { url, format?, provider? }            (tools/webfetch/index.ts)
//
// THE TASK COMMAND READS BEFORE IT WRITES (T1/Phase 2, still required by the engine)
// ----------------------------------------------------
// The record engine requires an `expects: [{ id, rev }]` token for every content
// patch or removal made by a caller that HAS an agent identity, and `executeTool`
// always gives one (`agent: primary`). So `/task complete|reopen|remove` reads the
// store first and sends the real revisions; it never invents a rev. There are no
// ownership verbs left to skip the token (Decision P), which is why exactly THREE
// subcommands do the read dance and `/task add` does not (a new record has no rev to
// guard). The cost is one extra read (and its `tool_execute` notification) per
// guarded command — a debounced save, not a model turn.
//
// CONDITIONAL TOOLS, HONEST ERRORS
// --------------------------------
// `search` exists only when a provider key resolved, and `fetch` only when
// `webfetch` is enabled. A command for an unregistered tool answers a helpful
// `{ content, isError: true }` that names the configuration field and the key
// names, rather than throwing `Tool "search" is not registered` at an operator
// who cannot read the registry.
//
// NOTHING HERE THROWS
// -------------------
// A command runs in a REPL/HTTP handler where an exception is a bad user story.
// Usage mistakes come back as `{ content: usage, isError: true }`, and a tool
// rejection (an unknown task id, a failed provider call, a non-text page) is
// caught and reported the same way. Only `executeCommand` itself throws — for a
// non-command line or an unknown name, which are host bugs, not user input.
//
// Cross-references:
//   - ./command.ts                 — COMMAND_NAME_PATTERN, formatCommandHelp
//   - ./result-budget.ts           — MODEL_TOOL_RESULT_BUDGET_BYTES, utf8ByteLength
//   - ../harness.ts                — registers these first, before configuration
//   - ../tools/runtime/tasks.tool.ts / websearch / webfetch — the tools called here

// `toErrorInfo` is the harness's total thrown-value formatter (a compiled or
// host-supplied tool may throw a primitive); reusing it keeps a command's error
// text identical to what the model path would have shown.
import { toErrorInfo } from '../util';
import { MODEL_TOOL_RESULT_BUDGET_BYTES, utf8ByteLength } from './result-budget';
import { formatCommandHelp, normalizeCommandName } from './command';
import type {
    Harness,
    HarnessCommand,
    HarnessCommandContext,
    HarnessCommandResult,
    TaskCounts,
    TaskExpect,
    TaskItem,
    TaskPageInfo,
    WebSearchMatch,
    WebFetchResult
} from '../types';

// The command names. They are part of the public surface (a host can override one
// by name through a plugin), so they are exported instead of being literals.
export const HELP_COMMAND_NAME = 'help';
export const TOOLS_COMMAND_NAME = 'tools';
export const TASK_COMMAND_NAME = 'task';
export const WEBSEARCH_COMMAND_NAME = 'websearch';
export const WEBFETCH_COMMAND_NAME = 'webfetch';

// The tool names each pass-through addresses. Quoting the tools' own wire names
// here (rather than importing their modules) keeps this file dependency-free:
// importing `tools/websearch` for one constant would pull a provider adapter into
// every harness build, including the browser one.
// Decision J: the TOOL is plural (`tasks` manages a collection) while the slash
// command stays singular `/task` (the act is one task). This constant is the ONLY
// place the command resolves its tool, so the tool rename is one line here — and the
// COMMAND name above it is a separate literal that must NOT become `/tasks`.
const TASK_TOOL_NAME = 'tasks';
const SEARCH_TOOL_NAME = 'search';
const FETCH_TOOL_NAME = 'fetch';

// This package deliberately has no runtime dependency, so the one-character
// separator the tokenizer output is rejoined with is spelled out here.
const SPACE_STRING = ' ';

// `/tools` previews one line per tool. The real descriptions run to ~1.5 KB
// (`task` alone), so a full dump is unreadable in a terminal and can push the
// listing toward the command cap. A preview keeps the inventory scannable; the
// full text is one `/help`-level detail away (it lives on the Tool itself).
const TOOL_DESCRIPTION_PREVIEW_CHARS = 200;

// One shared cap for every command body. A command result is HUMAN-facing (a CLI
// prints it, a panel shows it), so unlike `boundToolResult` (which emits a JSON
// envelope for the MODEL) this appends a plain marker and keeps the text readable.
// The byte budget itself is the same constant the model path uses.
const capText = (content: string): string => {
    const originalBytes = utf8ByteLength(content);

    if (originalBytes <= MODEL_TOOL_RESULT_BUDGET_BYTES) return content;

    const marker = `\n… truncated: ${content.length} characters, ${originalBytes} bytes (64 KiB command cap).`;
    let keep = Math.min(content.length, MODEL_TOOL_RESULT_BUDGET_BYTES);
    let text = content.slice(0, keep) + marker;

    // Geometric shrink, so the marker itself can never overflow the cap. Each
    // step strictly reduces `keep`, so this terminates at 0.
    while (keep > 0 && utf8ByteLength(text) > MODEL_TOOL_RESULT_BUDGET_BYTES) {
        keep = Math.floor(keep * 0.9);
        text = content.slice(0, keep) + marker;
    }

    return text;
};

// The usage-error shape every built-in shares: the command's own usage line plus
// a reason, never an exception.
const usageError = (command: HarnessCommand, reason: string): HarnessCommandResult => ({
    content: `/${command.name}: ${reason}\nusage: ${command.usage ?? `/${command.name}`}`,
    isError: true
});

// Normalize an `executeTool` throw into a result. `toErrorInfo` is the total
// formatter the harness uses for the same purpose, so a compiled/host tool that
// throws a non-Error still produces readable text.
const failure = (error: unknown, label: string): HarnessCommandResult => ({
    content: `${label}: ${toErrorInfo(error).message}`,
    isError: true
});

// True when the tool is present in THIS harness. `executeTool` would throw the
// same information as an exception; the command layer turns it into guidance.
const hasTool = (context: HarnessCommandContext, name: string): boolean =>
    context.harness.tools[name] !== undefined;

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

// The page every successful `task` call returns (core/task.ts): the requested
// slice, the derived counts, the cursor, and the store revision. Typed locally
// because the tool's raw result arrives as `unknown` through executeTool.
type TaskPage = {
    tasks: TaskItem[];
    counts: TaskCounts;
    page: TaskPageInfo;
    storeRev: number;
};

// The tool's page ceiling (core/task.ts `TASK_LIST_MAX_LIMIT`): asking for more is
// clamped, so one request per page is the widest walk available.
const TASK_READ_PAGE_LIMIT = 100;

// Bound for the revision walk below. The store holds at most 200 records
// (TASK_MAX_RECORDS), so a normal walk is ONE request; the 64 KiB response budget
// can cut a page to ~15 records when texts are near TASK_MAX_TEXT, which is the
// worst case this bound has to cover. It exists only so a cursor that stops
// advancing cannot spin — a complete store never needs it.
const TASK_READ_MAX_PAGES = 16;

// Readable rendering of one page: `#<id> [x]/[ ] <text>`, then counts, then the
// cursor. Ids are shown with "#" so an operator can copy `/task complete <id>`
// straight out of the listing.
//
// Decision P (round 7) deleted the claim, so the listing no longer annotates a
// holder: the old `(claimed by X until Y)` suffix described a lock that can no longer
// exist. `rev` and the attribution still ride in `data` — the exact machine-readable
// records — which is what an operator or a host uses to send the next `expects` token.
const formatTaskPage = (result: unknown): string => {
    const page = (result ?? {}) as Partial<TaskPage>;
    const tasks = Array.isArray(page.tasks) ? page.tasks : [];
    const counts = page.counts ?? { total: 0, completed: 0, pending: 0 };
    const info = page.page ?? { offset: 0, limit: 0, hasMore: false };

    const lines = tasks.map(
        (task) => `#${task.id} [${task.completed ? 'x' : ' '}] ${task.text}`
    );

    if (lines.length === 0) lines.push('No tasks.');

    lines.push(`${counts.total} total, ${counts.completed} completed, ${counts.pending} pending`);
    lines.push(
        `page: offset ${info.offset}, limit ${info.limit}, showing ${tasks.length}${
            info.hasMore ? `, next offset ${info.nextOffset ?? info.offset + tasks.length}` : ''
        }`
    );

    return capText(lines.join('\n'));
};

// Reads the store and answers `id -> rev`, the token every guarded write needs.
//
// WHY A READ FIRST: `harness.executeTool` always hands the tool an agent identity
// (`agent: primary`, src/harness.ts `executeToolInternal`), and core/task.ts
// requires an `expects: [{ id, rev }]` entry for EVERY record an identified caller
// patches or removes. A blind command would die on `guarded write: pass expects
// [...]`; the read is what makes `/task complete 1` legal again. It is also the
// compare-and-swap window: if another agent changed the record between the read
// and the write, the tool rejects the whole call instead of silently dropping
// their edit.
//
// The walk follows `page.nextOffset` while `page.hasMore`; the store's own caps,
// not the operator, decide how many requests that is.
const readTaskRevisions = async (harness: Harness): Promise<Map<string, number>> => {
    const revisions = new Map<string, number>();
    let offset = 0;

    for (let pass = 0; pass < TASK_READ_MAX_PAGES; pass += 1) {
        const result = (await harness.executeTool(TASK_TOOL_NAME, {
            offset,
            limit: TASK_READ_PAGE_LIMIT
        })) as Partial<TaskPage>;

        const tasks = Array.isArray(result.tasks) ? result.tasks : [];

        for (const task of tasks) revisions.set(task.id, task.rev);

        const info = result.page;
        // A page that reports `hasMore` without a usable cursor would loop forever;
        // falling back to "one more page than we just saw" keeps the walk honest.
        const next = info?.nextOffset ?? offset + tasks.length;

        if (info?.hasMore !== true || next <= offset) break;
        offset = next;
    }

    return revisions;
};

// Builds the `expects` array for a guarded write, skipping ids the read did not
// see. A token is only legal for a record that still exists AND is being changed
// (core/task.ts rejects both a removed id and an untouched one), so an unknown id
// gets no entry and the tool's own `task has no task with id "99"` message is what
// the operator reads — inventing a rev would replace it with a CAS error.
const expectsFor = (
    ids: readonly string[],
    revisions: Map<string, number>
): TaskExpect[] =>
    ids.flatMap((id) => {
        const rev = revisions.get(id);
        return rev === undefined ? [] : [{ id, rev }];
    });

// `/task` — the session task list, mapped onto the tool's one-patch-call shape.
const taskCommand: HarnessCommand = {
    name: TASK_COMMAND_NAME,
    description: 'Read and change this session\'s task list.',
    usage:
        '/task [list | add <text> | complete <id> | reopen <id> | remove <id>...]',
    execute: async (context) => {
        const [subcommand, ...rest] = context.args;

        // Read: `/task`, `/task list`. Anything after `list` is a typo worth
        // reporting rather than silently reading a different page.
        if (subcommand === undefined || subcommand === 'list') {
            if (rest.length > 0) {
                return usageError(taskCommand, `"list" takes no arguments (got ${rest.length}).`);
            }

            if (!hasTool(context, TASK_TOOL_NAME)) {
                return usageError(taskCommand, 'the "tasks" tool is not registered in this harness.');
            }

            try {
                const result = await context.harness.executeTool(TASK_TOOL_NAME, {});
                return { content: formatTaskPage(result), data: result };
            } catch (error) {
                return failure(error, '/task');
            }
        }

        if (subcommand === 'add') {
            // `<text...>` joins the remaining tokens with single spaces: the
            // tokenizer already removed the quotes, so `"fix: the build"` and
            // `fix: the build` both arrive as one intended string.
            const text = rest.join(SPACE_STRING).trim();

            if (text.length === 0) {
                return usageError(taskCommand, '"add" needs the task text.');
            }

            if (!hasTool(context, TASK_TOOL_NAME)) {
                return usageError(taskCommand, 'the "tasks" tool is not registered in this harness.');
            }

            try {
                // No `id` => ADD (core/task.ts patch semantics); the tool mints
                // the id and answers with the current page.
                const result = await context.harness.executeTool(TASK_TOOL_NAME, {
                    tasks: [{ text }]
                });

                return { content: formatTaskPage(result), data: result };
            } catch (error) {
                return failure(error, '/task add');
            }
        }

        if (subcommand === 'complete' || subcommand === 'reopen') {
            const id = rest[0];

            if (id === undefined) {
                return usageError(taskCommand, `"${subcommand}" needs a task id.`);
            }

            if (rest.length > 1) {
                return usageError(
                    taskCommand,
                    `"${subcommand}" takes one id (got ${rest.length}).`
                );
            }

            if (!hasTool(context, TASK_TOOL_NAME)) {
                return usageError(taskCommand, 'the "tasks" tool is not registered in this harness.');
            }

            try {
                // `completed` is a PATCH by an IDENTIFIED caller (executeTool always
                // supplies `agent: primary`), so it needs the rev that is stored right
                // now — see readTaskRevisions. An id the read did not see gets NO
                // token, and the tool's own unknown-id rejection is what surfaces.
                const revisions = await readTaskRevisions(context.harness);
                const expects = expectsFor([id], revisions);
                const result = await context.harness.executeTool(TASK_TOOL_NAME, {
                    // `completed` is the only field sent, so the stored text stays
                    // untouched (core/task.ts partial-patch semantics).
                    tasks: [{ id, completed: subcommand === 'complete' }],
                    ...(expects.length === 0 ? {} : { expects })
                });

                return { content: formatTaskPage(result), data: result };
            } catch (error) {
                return failure(error, `/task ${subcommand}`);
            }
        }

        if (subcommand === 'remove') {
            if (rest.length === 0) {
                return usageError(taskCommand, '"remove" needs at least one task id.');
            }

            if (!hasTool(context, TASK_TOOL_NAME)) {
                return usageError(taskCommand, 'the "tasks" tool is not registered in this harness.');
            }

            try {
                // A removal is a guarded write too: one token per id that still
                // exists. The whole call is atomic (core/task.ts), so a stale token
                // removes nothing rather than half a batch, and an unknown id still
                // reports itself as `task has no task with id "N"`.
                const revisions = await readTaskRevisions(context.harness);
                const expects = expectsFor(rest, revisions);
                const result = await context.harness.executeTool(TASK_TOOL_NAME, {
                    remove: rest,
                    ...(expects.length === 0 ? {} : { expects })
                });

                return { content: formatTaskPage(result), data: result };
            } catch (error) {
                return failure(error, '/task remove');
            }
        }

        // Decision P (round 7): `/task claim|release|takeover` are deleted with the
        // lock they addressed — the three verbs, the tool's `leaseMs` parameter and its
        // ownership block. An operator who types one now falls through to the
        // `unknown action` line below, which is the honest answer: there is no ownership
        // state to move, and every write is guarded by its `expects` token instead. The
        // COMMAND name is unaffected (Decision J), and `/task claim 1` reporting an
        // unknown action is this deletion's check.

        return usageError(taskCommand, `unknown action "${subcommand}".`);
    }
};

// ---------------------------------------------------------------------------
// websearch
// ---------------------------------------------------------------------------

// Guidance for a session without the `search` tool: the field and the key names,
// because "no results" and "cannot search" are different answers.
const NO_SEARCH_TOOL =
    '/websearch needs the "search" tool, which this harness does not register. Set websearch: true (or a websearch configuration object) and provide a provider key: EXA_API_KEY, TAVILY_API_KEY, or LINKUP_API_KEY.';

const formatSearchResults = (result: unknown): string => {
    const payload = (result ?? {}) as { results?: WebSearchMatch[]; query?: string; provider?: string };
    const matches = Array.isArray(payload.results) ? payload.results : [];

    if (matches.length === 0) {
        return `No results${payload.query === undefined ? '' : ` for "${payload.query}"`}.`;
    }

    const lines = [
        `${matches.length} result(s)${payload.provider === undefined ? '' : ` via ${payload.provider}`}:`
    ];

    matches.forEach((match, index) => {
        const title = match.title && match.title.length > 0 ? match.title : '(untitled)';
        lines.push(`${index + 1}. ${title}`);
        lines.push(`   ${match.url}`);

        // Snippets arrive as provider excerpts with embedded newlines; flattening
        // keeps one result = a readable block instead of a wall of wrapped text.
        if (match.snippet) lines.push(`   ${match.snippet.replace(/\s+/g, SPACE_STRING)}`);
        if (match.published) lines.push(`   published: ${match.published}`);
    });

    return capText(lines.join('\n'));
};

const websearchCommand: HarnessCommand = {
    name: WEBSEARCH_COMMAND_NAME,
    description: 'Search the web with this session\'s configured search tool.',
    usage: '/websearch <query>',
    execute: async (context) => {
        // The RAW tail is the query: a search string is free text, and re-joining
        // tokens would lose the quoting the operator used for an exact phrase.
        const query = context.rest.trim();

        if (query.length === 0) {
            return usageError(websearchCommand, 'a query is required.');
        }

        if (!hasTool(context, SEARCH_TOOL_NAME)) {
            return { content: NO_SEARCH_TOOL, isError: true };
        }

        try {
            const result = await context.harness.executeTool(SEARCH_TOOL_NAME, { query });
            return { content: formatSearchResults(result), data: result };
        } catch (error) {
            return failure(error, '/websearch');
        }
    }
};

// ---------------------------------------------------------------------------
// webfetch
// ---------------------------------------------------------------------------

const NO_FETCH_TOOL =
    '/webfetch needs the "fetch" tool, which this harness does not register. Set webfetch: true (or a webfetch configuration object) to enable it; its native provider needs no key, and exa/linkup read EXA_API_KEY / LINKUP_API_KEY.';

const formatFetchResult = (result: unknown): string => {
    const page = (result ?? {}) as Partial<WebFetchResult>;
    const lines: string[] = [];

    if (page.title) lines.push(`title: ${page.title.replace(/\s+/g, SPACE_STRING)}`);
    lines.push(`url: ${page.url ?? ''}`);
    lines.push(`content type: ${page.contentType ?? 'unknown'}`);
    lines.push(
        `characters: ${page.characters ?? (page.content ?? '').length}${
            page.truncated ? ' (truncated by the fetch tool)' : ''
        }`
    );
    lines.push('');
    lines.push(page.content ?? '');

    return capText(lines.join('\n'));
};

const webfetchCommand: HarnessCommand = {
    name: WEBFETCH_COMMAND_NAME,
    description: 'Fetch one http(s) page through this session\'s fetch tool.',
    usage: '/webfetch <url>',
    execute: async (context) => {
        // The FIRST token is the URL: URLs contain no spaces, and taking the raw
        // tail would turn `/webfetch <url> --html` into an invalid address.
        const url = context.args[0];

        if (url === undefined || url.trim().length === 0) {
            return usageError(webfetchCommand, 'a URL is required.');
        }

        if (!hasTool(context, FETCH_TOOL_NAME)) {
            return { content: NO_FETCH_TOOL, isError: true };
        }

        try {
            const result = await context.harness.executeTool(FETCH_TOOL_NAME, { url });
            return { content: formatFetchResult(result), data: result };
        } catch (error) {
            return failure(error, '/webfetch');
        }
    }
};

// ---------------------------------------------------------------------------
// help / tools
// ---------------------------------------------------------------------------

const helpCommand: HarnessCommand = {
    name: HELP_COMMAND_NAME,
    description: 'List the commands in this harness, or show one command.',
    usage: '/help [command]',
    execute: (context) => {
        const [target, ...rest] = context.args;

        if (target === undefined) {
            return { content: capText(formatCommandHelp(context.harness.commands)) };
        }

        if (rest.length > 0) {
            return usageError(helpCommand, '"help" takes at most one command name.');
        }

        // Normalized so `/help /Task` and `/help TASK` both resolve. An unknown
        // name is an answer, not an exception: /help is where operators go when
        // they have already guessed wrong.
        const name = normalizeCommandName(target);

        // OWN-KEY lookup (C8-m2), the same rule `handle.executeCommand` uses
        // (src/harness.ts line 7251). `harness.commands` is a plain object, so a
        // bare bracket read walks the prototype chain and `/help constructor` (or
        // `toString`, or `__proto__`) would print a real-looking entry for a command
        // nobody registered. Names are validated against COMMAND_NAME_PATTERN, so
        // `constructor` IS a registrable spelling and the collision is reachable.
        const command = Object.prototype.hasOwnProperty.call(context.harness.commands, name)
            ? context.harness.commands[name]
            : undefined;

        if (command === undefined) {
            return usageError(helpCommand, `unknown command "/${name}".`);
        }

        // The single-command form is the same renderer over a one-entry record, so
        // the detail and the list can never drift apart.
        return { content: capText(formatCommandHelp({ [name]: command })) };
    }
};

const toolsCommand: HarnessCommand = {
    name: TOOLS_COMMAND_NAME,
    description: 'List the tools registered in this harness.',
    usage: '/tools [filter]',
    execute: (context) => {
        // The raw tail is the filter, so a multi-word filter works. Matching the
        // name OR the description is what an operator actually means by "show me
        // the web tools".
        const filter = context.rest.trim().toLowerCase();
        const names = Object.keys(context.harness.tools).sort();
        const matched =
            filter.length === 0
                ? names
                : names.filter(
                      (name) =>
                          name.toLowerCase().includes(filter) ||
                          String(context.harness.tools[name].description ?? '')
                              .toLowerCase()
                              .includes(filter)
                  );

        if (matched.length === 0) {
            return usageError(toolsCommand, `no registered tool matches "${context.rest.trim()}".`);
        }

        const lines = matched.map((name) => {
            const description = String(context.harness.tools[name].description ?? '').replace(
                /\s+/g,
                SPACE_STRING
            );

            return description.length > TOOL_DESCRIPTION_PREVIEW_CHARS
                ? `${name} — ${description.slice(0, TOOL_DESCRIPTION_PREVIEW_CHARS)}…`
                : `${name} — ${description}`;
        });

        return { content: capText(lines.join('\n')), data: matched };
    }
};

// The built-in set, in registration order. `harness()` registers these FIRST, so
// `configuration.commands` may collide with one (a construction error) while a
// plugin or `harness.registerCommand` may replace one on purpose.
//
// The commands are STATELESS (all state lives in the harness they are handed), so
// the module-level definitions are safe to share. `harness()` does not publish
// these objects directly: installCommand() copies each one into a per-harness
// record, so two harnesses never share a registry entry.
export const createBuiltinCommands = (): HarnessCommand[] => [
    helpCommand,
    toolsCommand,
    taskCommand,
    websearchCommand,
    webfetchCommand
];
