// The transport-neutral canonical API, reached through the @underload/service adapter.
//
// T34: rewritten against the FINAL target contract (harness.swagger.yaml + the generated
// ../shared/harness-api.ts routes), NOT against the old bootstrap/SSE surface. Nothing here
// asks the server for a compatibility alias: `/api`, `/presets`, `/tools/bootstrap`,
// `POST /sessions/:id/messages` and the SSE submit are pinned as GONE (404/400), which is the
// acceptance criterion (no back-compat shims).
//
// What the file pins:
//   1. ROOT/CONFIG     - `GET /v1/harness` is a constant-size identity/links/limits document;
//                        provider defaults live on `GET /config` (the only writable settings doc).
//   2. CATALOGUE READS - harness cards, agent profiles and tool rows are PAGED SUMMARIES with
//                        exact key sets; the heavy members (one definition, one instruction text,
//                        one tool schema) are each exactly one named read away.
//   3. SESSIONS        - a session resource is metadata + counters (never turns or messages); the
//                        frozen definition, usage fold, roster, toolbox and conversations are
//                        separate reads.
//   4. TASKS           - a submit answers 202 + `TaskReceipt`; completion is proven by re-reading
//                        the turn (deterministic polling), and the recorded history is the PAGED
//                        events read - not a response-owned stream.
//   5. LAZY DISPLAY    - the compiled display tree, one step and one context block are explicit
//                        reads (the old `/views` frame is gone).
//   6. EXECUTION       - global `POST /tools/{id}/executions` vs session-scoped
//                        `POST /sessions/{id}/tools/{id}/executions`; the gate is advertised on the
//                        detail read, and a 403 is a policy refusal rather than an absence.
//   7. ADAPTER         - origin gate, route-aware body caps, loader query forwarding, and the
//                        epoch/revision headers the contract stamps on every response.
//
// Determinism: every status, key list, count, and message below is an EXACT value taken from the
// contract or from the scripted demo's own recorded numbers. Timestamps are never compared to
// literals. No network: `settings`/`defaults` are injected, search keys are stubbed empty, and
// only the scripted templates run.
//
// Cross-references:
//   - ./api.ts                       - the dispatcher (route table at :3783, 405 wording at :3870)
//   - ./api-paging.ts:148            - `limit` echoes the RETURNED row count (asserted below)
//   - ../shared/harness-api.ts       - routes, limits, capabilities quoted here
//   - ./canonical-reads.test-support.ts - the composed read helpers this file binds to the adapter
//   - ./api-canonical.test.ts        - the sibling file that pins the same contract at `runtime.api`

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createHarnessRegistry,
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    WEBSEARCH_UNCONFIGURED_HINT
} from './harnesses';
import { PRODUCTION_WITH_FIXTURES } from './harnesses/fixture-presets.test-support';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
// The shared policy lines of the trusted catalogue (src/agents/guidelines.ts). Profile-specific
// sentences are hardcoded below; these are IMPORTED so the arrays asserted here can never
// disagree with the single source they compose from.
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    READ_ONLY_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from '../agents/guidelines';
import { MAX_API_BODY_BYTES, bodyLimitFor } from './api';
import type { HarnessApiResult } from './api';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { createHarnessServiceHandler } from './service';
import type { ServiceEndpointContext, ServiceEndpointParameters, ServiceEndpointResult } from './service';
import { SessionStore } from './sessions';
import { HarnessPersistence } from './persistence';
import {
    HARNESS_PAGE_LIMIT,
    HARNESS_ROUTES,
    HARNESS_SERVICE_CAPABILITIES,
    HARNESS_SERVICE_LIMITS
} from '../shared/harness-api';
// The shared composition layer for the canonical reads (assertion-neutral by design: this file
// still decides every expected value).
import {
    allTurnEvents,
    listTurns,
    readBlockDetail,
    readDisplay,
    readOk,
    readStepDetail,
    readTurn,
    readTurnEvents,
    submitTask,
    waitForTurnStatus,
    type CanonicalCall
} from './canonical-reads.test-support';

const MOUNT = '/v1/harness';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = { baseURL: 'http://provider.test/v1', model: 'demo-model', hasApiKey: true };

// The ten cards this file sees: the eight shipped production templates PLUS the two scripted
// fixtures injected by `createRuntime`. `general` is FIRST because it is the default card
// (DEFAULT_CLI_PRESET), and the live order mirrors `AGENT_PROFILE_NAMES` in ../agents/index.ts
// except for the trailing `chat` card, which is not a role: it reuses the `general` profile with
// NO toolbox (issue 0005-D, src/server/harnesses/presets.ts).
// A runtime built without an injection lists only the first eight - pinned by 'ships only the
// production cards without an injected registry'.
const CARD_NAMES = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger',
    'chat',
    'demo',
    'flaky'
];

// The head of `CARD_NAMES`: the eight shipped production templates, i.e. what a runtime with NO
// injected registry lists (`presets` in src/server/harnesses/presets.ts). The two fixtures are the
// tail and only reachable through the explicit injection `createRuntime` performs.
const LIVE_CARD_NAMES = CARD_NAMES.slice(0, 8);

// The seven ROLE cards inside `LIVE_CARD_NAMES`: every production card except the trailing
// tool-less `chat` card, whose registered tool list is empty by design (issue 0005-D). Assertions
// about "the shared toolbox on every card" range over this list, and chat is pinned separately.
const ROLE_CARD_NAMES = CARD_NAMES.slice(0, 7);

// The exact card row `GET /harnesses` answers (`HarnessCard` in ../shared/harness-api.ts). Pinned
// once at module scope so a projection change is a visible diff, not a renamed field nobody
// noticed. A card carries NO definition text and NO per-agent instruction map.
const CARD_KEY_SET = [
    'agents',
    'builtin',
    'definition_revision',
    'description',
    'name',
    'primary',
    'requires_endpoint',
    'subagents',
    'title',
    'tools'
];

// The trusted agent registry (src/agents): seven roles, then the delegated summarizer. That is
// the whole roster — `AGENT_PROFILE_NAMES` verbatim — because the `demo`/`flaky` fixture PROFILES
// are deleted: the two injected fixture CARDS exist, but the agents inside them are real roles.
// The registry also renders this list into the `Known agents: ...` validation messages asserted
// below, so one list pins both.
const AGENT_NAMES = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger',
    'summarizer'
];

// The whole catalogue, in the order the route emits it: the fourteen harness-owned core rows,
// then the package/app tools, then the two environment-backed rows (search, fetch).
const TOOL_NAMES = [
    'toolRegistry',
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
    'agentResult',
    'delegate',
    'actionRequest',
    'threadFork',
    'syntax',
    'read',
    'write',
    'edit',
    'files',
    'glob',
    'grep',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize',
    'search',
    'fetch'
];

// The shared toolbox every real card registers, and the two rows the environment decides. On a
// keyless host `fetch` still registers (the native provider needs no credential); `search` only
// appears once a web-search key exists.
const TOOLBOX = [
    'syntax',
    'read',
    'write',
    'edit',
    'files',
    'glob',
    'grep',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize'
];

// The declared core of a live card WITH subagents (R9-R11 visibility): the bootstrap pair, the
// session plan, delegation, the five file tools, and the credential-free fetch row.
const LIVE_CORE_TOOLS = ['toolRequest', 'tasks', 'delegate', 'read', 'write', 'edit', 'glob', 'grep', 'fetch'];

// The `general` card is the one live card with NO team (`subagents: []`), and the runtime therefore
// never registers `delegate` for it (src/harness.ts `activation: 'subagents'`). Pinning the whole
// core list rather than "does not include delegate" is what makes the omission a contract: adding a
// team to the default card, or registering the tool anyway, fails here.
const GENERAL_CORE_TOOLS = ['toolRequest', 'tasks', 'read', 'write', 'edit', 'glob', 'grep', 'fetch'];

// ---------------------------------------------------------------------------
// The trusted prompt text (src/agents), as it reaches the wire.
//
// `GET /agents/{id}` and `GET /harnesses/{name}/instructions/{agent}` expose the RAW profile
// fields: the identity sentence and the guidelines array, unjoined. The runtime composition
// (src/agents/index.ts `agentInstruction()`) joins them into ONE system message, and that joined
// text is what the session-scoped instruction read answers - both shapes are pinned below,
// because a client renders the raw halves and the model receives the join.
//
// IDS ARE STABLE, TITLES ARE NOT. `research`/`workspace`/`planner` keep their registry ids while
// their titles read Explore/Analyst/Manager (src/agents/index.ts explains why: the id is
// persisted and `agentProfile()` has no alias fallback), so every assertion below addresses an
// agent by its id and never by its display title.
// ---------------------------------------------------------------------------

// Mirrors the single documented join rule in src/agents/index.ts `agentInstruction()`.
const joinedPrompt = (identity: string, guidelines: readonly string[]): string =>
    [identity, '', 'Guidelines:', ...guidelines.map((line) => `- ${line}`)].join('\n');

// General: the DEFAULT profile, and the only one whose guidelines forbid handing work out at all
// (no delegation line, because its harness configures no subagents and the tool is unregistered).
// The lone-agent bullet names the two ways a step could still escape WITHOUT `delegate` —
// `threadFork` and `threadSend` — so it is pinned as one literal, exactly as src/agents/general.ts ships it.
const GENERAL_IDENTITY = 'You are the General agent, the default. Do every step of the task yourself, in this conversation, and never hand work to another agent.';
const GENERAL_GUIDELINES = [
    'Treat the brief as the specification: do exactly what it asks, keep the scope it states, and say plainly when it is ambiguous or when a claim cannot be checked.',
    'You work alone: no subagent exists here, so a step you cannot do is a step to unlock with toolRequest, never a step to pass on. Do not spawn a branch with threadFork, and do not hand the step to another conversation with threadSend.',
    DISCOVERY_GUIDELINE,
    WEB_SEARCH_GUIDELINE,
    'Prefer a tool result over memory when a declared tool can answer more accurately, and name the tool you used.',
    PERMISSIONS_GUIDELINE,
    'Be concise: no preamble, no restating the question.'
];

// Instruct: a worker that delegates ONLY the context-burning steps, which is the one sentence
// separating it from the Manager (delegates everything) and from General (delegates nothing).
const INSTRUCT_IDENTITY = 'You are the Instruct agent. Do the work yourself, and delegate only a step that would cost more context than it is worth to perform.';
const INSTRUCT_GUIDELINES = [
    'Treat the brief as the specification: keep the scope it states, and say plainly when it is ambiguous or when a claim cannot be checked.',
    'Delegate only context-burning steps that change nothing: research, exploration, a long read, a review. Anything you would then have to write, edit, or run, you do yourself.',
    'Never delegate to a Manager: it does not run as a delegate. Send an investigation to research and a challenge to reviewer, and keep the build.',
    DELEGATION_GUIDELINE,
    'Verify a delegated result before relying on it; the final answer stays yours.',
    DISCOVERY_GUIDELINE,
    WEB_SEARCH_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    'Be concise: no preamble, no restating the question.'
];

// Research, titled Explore: the read-only investigator. The read-only rule is policy, not a tool
// denial, so it reaches the prompt through READ_ONLY_GUIDELINE (src/agents/guidelines.ts).
const RESEARCH_IDENTITY = 'You are the Explore agent. Establish what is actually there and how it works, and report only what you can point to.';
const RESEARCH_GUIDELINES = [
    READ_ONLY_GUIDELINE,
    'Survey before you read: glob returns paths, grep({ pattern, patterns, paths }) returns lines with file and line numbers, so sweep the whole tree before quoting one file.',
    'Answer from the repository when it can; use the web only for what it cannot hold — current behaviour, an external API — and cite the URL.',
    'Cross-check any claim that decides the answer against a second source — another file, a test, another search result — and say when only one supports it.',
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    WEB_SEARCH_GUIDELINE,
    'Finish with the answer: cite the file and line, tool, or URL behind each claim, and label what you could not verify.'
];

// Debugger: the newest role, and the only shipped profile that carries TOOL_CREATE_GUIDELINE (it is
// the role expected to author a probe the catalogue has no entry for). It also carries WEB_SEARCH,
// immediately above DELEGATION: the web trio is part of what it stresses, so the wire array below
// has to keep that position (src/agents/debugger.ts).
const DEBUGGER_IDENTITY = 'You are the Debugger agent. Exercise the whole system until something breaks, then prove how it breaks.';
const DEBUGGER_GUIDELINES = [
    'Nothing is off-limits here: unlock any searchable tool you need, read any path, run any command, and delegate to any configured role.',
    'Test the edges, not the happy path: empty input, oversized input, a missing path, a wrong type, a repeated call, a cancelled call, a target that refuses.',
    'Reduce every failure to the smallest call sequence that triggers it again, and quote the exact tool, input, and error text.',
    'Write scratch files when a probe needs them, but never change the code under test unless the brief asks for a fix.',
    WEB_SEARCH_GUIDELINE,
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    'Report what you exercised, what held, what broke, and what you did not get to. Never invent a failure and never bury one.'
];

// The scripted fixture card runs the REAL `general` profile (its transport is scripted, but the
// agent inside it is a role this build ships), so every prompt assertion below about a `demo`
// session is an assertion about the General prompt — GENERAL_IDENTITY/GENERAL_GUIDELINES above.

// Filesystem fixtures live under a `Temp/` directory INSIDE the checkout (never OS temp). The
// location is resolved by walking the tree instead of counting `..` segments: this package is both
// a workspace member (`<repo>/packages/underload/harness/src/server`) and its own standalone GitHub
// repository (`<checkout>/src/server`), so any fixed depth lands outside the repository in one of
// the two layouts - that is exactly how CI ended up calling `mkdtemp('/home/runner/Temp/...')` and
// failing with ENOENT.
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

// Nearest ancestor (inclusive) satisfying `matches`; undefined at the filesystem root. Bounded by
// the parent-equals-self check so it can never loop.
const findAncestor = (start: string, matches: (directory: string) => boolean): string | undefined => {
    let directory = start;

    for (;;) {
        if (matches(directory)) return directory;

        const parent = dirname(directory);
        if (parent === directory) return undefined;

        directory = parent;
    }
};

// Package root: nearest ancestor holding `package.json` (the same answer as
// src/server/package-root.ts).
const PACKAGE_ROOT =
    findAncestor(MODULE_DIRECTORY, (directory) => existsSync(join(directory, 'package.json'))) ?? MODULE_DIRECTORY;

// Workspace root: nearest ancestor ABOVE the package that carries the shared agent rules (root
// AGENTS.md), a `package.json`, AND a `workspaces` manifest that actually covers this package.
// Present in the monorepo, absent in a standalone checkout. The manifest check keeps a vendored
// copy from inheriting some other repository's `Temp/`.
const workspaceCovers = (workspaceRoot: string, packageRoot: string): boolean => {
    try {
        const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
            workspaces?: string[] | { packages?: string[] };
        };
        const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
        const relativePath = relative(workspaceRoot, packageRoot).split(sep).join('/');

        // Glob -> anchored regex: '**' spans separators, '*' stays within one segment.
        return patterns.some((pattern) => {
            const expression = pattern
                .split('**')
                .map((part) => part.split('*').map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
                .join('.*');
            return new RegExp(`^${expression}$`).test(relativePath);
        });
    } catch {
        // Unreadable/invalid manifest is not a workspace we can trust.
        return false;
    }
};

const WORKSPACE_ROOT = findAncestor(
    dirname(PACKAGE_ROOT),
    (directory) =>
        existsSync(join(directory, 'AGENTS.md')) && existsSync(join(directory, 'package.json')) && workspaceCovers(directory, PACKAGE_ROOT)
);

// Scratch root for this file's fixtures: the workspace `Temp/` in the monorepo, otherwise the
// package `Temp/`. Both answers sit directly under a directory holding `package.json`, i.e.
// inside the checkout. Same policy as scripts/scratch.mjs.
const CHECKOUT_ROOT = WORKSPACE_ROOT ?? PACKAGE_ROOT;
const TEMP_LIST_ROOT = join(CHECKOUT_ROOT, 'Temp');

// One unique fixture directory under TEMP_LIST_ROOT. The recursive mkdir is the CI fix: `mkdtemp`
// does not create its parent, so a clean checkout failed with ENOENT. Callers own removal.
// `root` is a parameter only so the regression test can point the same behaviour at a nested,
// definitely-absent parent without touching the shared root.
const createFixture = async (prefix: string, root: string = TEMP_LIST_ROOT): Promise<string> => {
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, prefix));
};

// files reports posix separators on every platform, so an absolute Windows fixture path has to
// be compared in that same form.
const posix = (value: string): string => value.split(sep).join('/');

// Stub search keys so `search` is deterministically listed as unconfigured regardless of the
// machine/.env running the suite.
const stubEmptySearchKeys = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('LINKUP_API_KEY', '');
};

// A runtime holding the shipped catalogue PLUS the two scripted fixtures: this file's HTTP
// contract needs a harness that runs with NO provider (the scripted demo) and it also pins the
// failure example's descriptors, so the fixtures are injected EXPLICITLY here, exactly as a host
// that wants them does.
const createRuntime = (
    settings: RunnerSettings = SETTINGS,
    defaults: { baseURL: string; model: string; hasApiKey: boolean } = DEFAULTS,
    extraPresets: HarnessPreset[] = []
): HarnessRuntime => {
    stubEmptySearchKeys();

    return createHarnessRuntime({
        settings,
        defaults,
        registry: createHarnessRegistry([...PRODUCTION_WITH_FIXTURES, ...extraPresets]),
        loadEnvironment: false
    });
};

// A runtime whose catalogue was built with an explicit web-search key, so the configured half of
// the environment-backed rows is pinned without reading or mutating the real process environment.
const createConfiguredRuntime = (): HarnessRuntime => {
    stubEmptySearchKeys();

    return createHarnessRuntime({
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(PRODUCTION_WITH_FIXTURES),
        loadEnvironment: false,
        catalogue: createToolCatalogue({
            websearch: createWebSearchCatalogueEntry({ configuration: { env: { EXA_API_KEY: 'configured-exa-key' } } })
        })
    });
};

// ---------------------------------------------------------------------------
// The adapter harness
//
// Requests go through `createHarnessServiceHandler`, i.e. the structurally-typed service
// endpoint: `req.path` is the full URL path, `req.header` is the case-insensitive lookup Hono
// provides, `req.raw.method` carries the verb, and the loader's pre-parsed `{ query, body }` is
// handed over exactly as the gateway builds it. That is what makes this file the pin for the
// ADAPTER (origin, caps, query, headers) while api-canonical.test.ts pins the dispatcher.
// ---------------------------------------------------------------------------

type CallOptions = { body?: unknown; headers?: Record<string, string>; query?: Record<string, string> };

const callHandler = (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    options: CallOptions = {}
): Promise<ServiceEndpointResult> => {
    const handler = createHarnessServiceHandler({ runtime });
    const headers = options.headers ?? {};
    const context: ServiceEndpointContext = {
        req: {
            path: pathname,
            header: (name) => headers[name.toLowerCase()],
            raw: { method, signal: new AbortController().signal }
        }
    };
    const parameters: ServiceEndpointParameters = {
        // `body: undefined` is the loader's "raw stream" signal, so a JSON-mode call always sets it.
        body: options.body === undefined ? {} : options.body,
        ...(options.query === undefined ? {} : { query: options.query })
    };

    return handler(context, parameters);
};

// The JSON arm of an adapter result. `raw` is only ever the WebSocket/SSE arm, which no canonical
// REST route returns any more.
const jsonOf = async (result: ServiceEndpointResult): Promise<{ status: number; body: any; headers?: Record<string, string> }> => {
    expect(result.raw).toBeUndefined();

    return { status: result.status, body: result.response as any, ...(result.headers === undefined ? {} : { headers: result.headers }) };
};

// A normal call: status + body. The contract headers are a separate concern (see
// `callWithHeaders`), so an exact `toEqual` over a response never depends on whether this
// particular route happened to stamp a revision.
const call = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {},
    query?: Record<string, string>
) => {
    const { status, body: payload } = await jsonOf(await callHandler(runtime, method, pathname, { body, ...(query === undefined ? {} : { query }) }));

    return { status, body: payload };
};

// The same call, with the stamped epoch/revision headers kept for the assertions that pin them.
const callWithHeaders = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {},
    query?: Record<string, string>
) => jsonOf(await callHandler(runtime, method, pathname, { body, ...(query === undefined ? {} : { query }) }));

// The same mount, expressed as the `CanonicalCall` the shared read helpers take: a path may carry
// a query string, and the adapter's query channel is a record, so the split happens here (never
// inside the helpers, which stay mount-agnostic).
const canonicalCall = (runtime: HarnessRuntime): CanonicalCall => async (method, pathname, body) => {
    const mark = pathname.indexOf('?');
    const path = mark === -1 ? pathname : pathname.slice(0, mark);
    const query = mark === -1 ? undefined : Object.fromEntries(new URLSearchParams(pathname.slice(mark + 1)));
    const result = await callHandler(runtime, method, path, { body: body ?? {}, query });

    if (result.raw !== undefined) {
        throw new Error(`${method} ${pathname} answered a non-JSON arm.`);
    }

    const mapped: HarnessApiResult = {
        kind: 'json',
        status: result.status,
        body: result.response,
        ...(result.headers === undefined ? {} : { headers: result.headers })
    };

    return mapped;
};

// A scripted preset whose run waits on a gate, so "the session is busy" is a fact the test
// controls instead of a race against a provider or a scripted delay.
const gatedPreset = (gate: Promise<void>): HarnessPreset => ({
    name: 'gated',
    title: 'Gated',
    description: 'Scripted gated preset for busy-session policy',
    requiresEndpoint: false,
    primary: 'gated',
    subagents: [],
    agents: ['gated'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                gated: agent({
                    model: settings.model,
                    instruction: 'Gated test agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'half' };
                        await gate;
                        yield { type: 'text', delta: ' done' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'gated',
            presets: false,
            // The store hands its recorder in as `progress`; without it the run records no events.
            report: { progress }
        })
});

const createDemo = async (runtime: HarnessRuntime): Promise<Record<string, any>> => {
    const result = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'demo' });
    expect(result.status).toBe(201);
    return result.body.session;
};

afterEach(() => {
    vi.unstubAllEnvs();
});

// Regression guard for the CI failure (GitHub Actions, ubuntu, standalone checkout): the
// fixture-using tests below used to call `mkdtemp('/home/runner/Temp/...')` because a fixed
// `../../../../../Temp` counted levels correct only inside the monorepo. `mkdtemp` does not create
// its parent, so a clean checkout died with ENOENT. These two assertions pin the fix.
describe('fixture scratch root', () => {
    it('resolves Temp/ inside the checkout, not outside it', () => {
        expect(basename(TEMP_LIST_ROOT)).toBe('Temp');
        expect(existsSync(join(CHECKOUT_ROOT, 'package.json'))).toBe(true);
        expect(relative(CHECKOUT_ROOT, TEMP_LIST_ROOT)).toBe('Temp');
    });

    it('creates the Temp/ parent chain on a clean checkout before making a fixture', async () => {
        const root = join(TEMP_LIST_ROOT, `harness-clean-parent-${randomUUID()}`);
        const absentParent = join(root, 'missing', 'deeper');

        try {
            // The old code path, kept as the failure being regressed.
            await expect(mkdtemp(join(absentParent, 'fixture-'))).rejects.toMatchObject({ code: 'ENOENT' });

            const fixture = await createFixture('fixture-', absentParent);

            expect(dirname(fixture)).toBe(absentParent);
            expect(basename(fixture).startsWith('fixture-')).toBe(true);
            expect(existsSync(absentParent)).toBe(true);
            expect(existsSync(fixture)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }

        expect(existsSync(root)).toBe(false);
    });
});
// The boot document, the health line, and the writable provider document.
//
// Replaces the old 'canonical bootstrap document' block: the fat `{ rootPath, presets, agents,
// tools, defaults, sessions }` aggregate is gone, and each of those five families now has its own
// route (`/harnesses`, `/agents`, `/tools`, `/config`, `/sessions`). The defaults the boot document
// used to carry live on `GET /config`.
describe('canonical root and provider document', () => {
    it('answers GET /v1/harness as a constant-size identity document', async () => {
        const runtime = createRuntime();

        // History exists, and the boot document still does not carry any of it.
        await createDemo(runtime);

        const result = await callWithHeaders(runtime, 'GET', MOUNT);

        expect(result.status).toBe(200);
        expect(Object.keys(result.body).sort()).toEqual([
            'api_root',
            'api_version',
            'capabilities',
            'epoch',
            'limits',
            'links',
            'server_time',
            'service'
        ]);
        expect(result.body.api_root).toBe(MOUNT);
        expect(result.body.api_version).toBe('v1');
        expect(result.body.service).toBe('noobscript-harness');
        expect(result.body.limits).toEqual(HARNESS_SERVICE_LIMITS);
        expect(result.body.capabilities).toEqual(HARNESS_SERVICE_CAPABILITIES);
        // The epoch the boot document reports is the runtime's own hub epoch - the same value the
        // WebSocket transport welcomes with (./api-events.ts).
        expect(result.body.epoch).toBe(runtime.events.epoch);

        // Links are named pointers only; nothing catalogued rides along.
        expect(result.body.links).toEqual({
            self: MOUNT,
            health: `${MOUNT}/health`,
            config: `${MOUNT}/config`,
            harnesses: `${MOUNT}/harnesses`,
            agents: `${MOUNT}/agents`,
            tools: `${MOUNT}/tools`,
            // T5 (R2/R3): the built-in plugin catalogue (the Plugins pane's only read).
            plugins: `${MOUNT}/plugins`,
            models: `${MOUNT}/models`,
            sessions: `${MOUNT}/sessions`,
            stream: `${MOUNT}/stream`
        });

        // The acceptance number: one session with a scripted history, and the boot document is
        // still under 2 KB. The legacy bootstrap carried every descriptor, every session and every
        // recorded turn of the same state.
        expect(Buffer.byteLength(JSON.stringify(result.body), 'utf8')).toBeLessThan(2_048);
        expect(result.headers).toEqual({ 'X-Harness-Epoch': runtime.events.epoch });
    });

    it('rejects a verb the root does not declare, naming the one it does', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'POST', MOUNT)).toEqual({
            status: 405,
            body: { error: { message: 'Use GET for /v1/harness.' } }
        });
    });

    it('answers health with the live session count and the epoch', async () => {
        const runtime = createRuntime();

        expect(await callWithHeaders(runtime, 'GET', `${MOUNT}/health`)).toEqual({
            status: 200,
            body: { ok: true, sessions: 0, epoch: runtime.events.epoch },
            headers: { 'X-Harness-Epoch': runtime.events.epoch }
        });

        await createDemo(runtime);

        const after = await call(runtime, 'GET', `${MOUNT}/health`);
        expect(after.body).toEqual({ ok: true, sessions: 1, epoch: runtime.events.epoch });
    });

    it('reads global config as a bounded defaults document with a revision', async () => {
        const runtime = createRuntime();

        const before = await callWithHeaders(runtime, 'GET', `${MOUNT}/config`);

        expect(before.status).toBe(200);
        expect(Object.keys(before.body).sort()).toEqual(['defaults', 'revision', 'runtime', 'writable_fields']);
        expect(before.body.revision).toBe(0);
        // snake_case on the wire, and key-free: `has_api_key` is an advertisement, not a secret.
        expect(before.body.defaults).toEqual({
            base_url: 'http://provider.test/v1',
            model: 'demo-model',
            has_api_key: true
        });
        expect(before.body.runtime).toEqual({
            thread_execution: 'inline',
            worker_idle_ms: 120_000,
            max_lane_workers: 16,
            worker_handshake_ms: 60_000
        });
        expect(before.body.writable_fields).toEqual(['settings.base_url', 'settings.model', 'settings.api_key']);
        expect(before.headers).toEqual({ 'X-Harness-Epoch': runtime.events.epoch, 'X-Harness-Revision': '0' });

        const patched = await call(runtime, 'PATCH', `${MOUNT}/config`, { settings: { model: 'next/model' } });

        expect(patched.status).toBe(200);
        expect(patched.body.revision).toBe(1);
        expect(patched.body.defaults.model).toBe('next/model');

        // The write landed: a reload reports it, and the revision header moved with it.
        const reload = await callWithHeaders(runtime, 'GET', `${MOUNT}/config`);
        expect(reload.body.defaults.model).toBe('next/model');
        expect(reload.body.revision).toBe(1);
        expect(reload.headers).toEqual({ 'X-Harness-Epoch': runtime.events.epoch, 'X-Harness-Revision': '1' });

        // A credential write never echoes the secret back: `defaults` stays key-free.
        const keyed = await call(runtime, 'PATCH', `${MOUNT}/config`, { settings: { api_key: 'client-key' } });
        expect(keyed.status).toBe(200);
        expect(keyed.body.defaults).toEqual({
            base_url: 'http://provider.test/v1',
            model: 'next/model',
            has_api_key: true
        });
        expect(JSON.stringify(keyed.body)).not.toContain('client-key');
    });

    it('refuses a config field the contract does not allow to be written', async () => {
        const runtime = createRuntime();

        // A capability the wire does not name is a 400 that lists what it does.
        expect(await call(runtime, 'PATCH', `${MOUNT}/config`, { settings: { temperature: 1 } })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "temperature". Allowed fields: base_url, model, api_key.' } }
        });

        // camelCase is NOT accepted on a request body: the contract is snake_case, so the legacy
        // spelling is an unknown field rather than a quietly-coerced alias.
        expect(await call(runtime, 'PATCH', `${MOUNT}/config`, { settings: { baseURL: 'http://x.test/v1' } })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "baseURL". Allowed fields: base_url, model, api_key.' } }
        });

        expect(await call(runtime, 'PATCH', `${MOUNT}/config`, {})).toEqual({
            status: 400,
            body: { error: { message: 'A config patch requires a "settings" object.' } }
        });

        expect(await call(runtime, 'PATCH', `${MOUNT}/config`, [])).toEqual({
            status: 400,
            body: { error: { message: 'The request body must be a JSON object.' } }
        });

        // Only GET and PATCH are mounted here.
        expect(await call(runtime, 'DELETE', `${MOUNT}/config`)).toEqual({
            status: 405,
            body: { error: { message: 'Use GET, PATCH for /v1/harness/config.' } }
        });
    });

    it('discovers models through the route-aware settings body and never leaks the key', async () => {
        const runtime = createRuntime();

        // The provider call is stubbed: the contract pin is the response shape and the fact that
        // the ids come back in the provider's own order (no server-side sorting).
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
            )
        );

        try {
            const ok = await call(runtime, 'POST', `${MOUNT}/models`, {
                settings: { base_url: 'http://provider.test/v1', api_key: 'client-key' }
            });

            expect(ok.status).toBe(200);
            expect(Object.keys(ok.body).sort()).toEqual(['models', 'observed_at']);
            expect(ok.body.models).toEqual(['z-model', 'a-model']);
            expect(JSON.stringify(ok.body)).not.toContain('client-key');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('maps shared settings validation to 400 with the exact message', async () => {
        const runtime = createRuntime();

        // The shared settings validator still owns these bounds; only the field spelling moved.
        expect(
            await call(runtime, 'POST', `${MOUNT}/models`, { settings: { base_url: 'x'.repeat(2_049) } })
        ).toEqual({
            status: 400,
            body: { error: { message: 'A provider base URL cannot exceed 2048 characters.' } }
        });

        expect(
            await call(runtime, 'POST', `${MOUNT}/models`, { settings: { model: 'x'.repeat(257) } })
        ).toEqual({ status: 400, body: { error: { message: 'A model name cannot exceed 256 characters.' } } });

        expect(
            await call(runtime, 'POST', `${MOUNT}/models`, { settings: { base_url: 5 } })
        ).toEqual({ status: 400, body: { error: { message: '"body.settings.base_url" must be a string.' } } });

        expect(
            await call(runtime, 'POST', `${MOUNT}/models`, { settings: { baseURL: 'http://x.test/v1' } })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "baseURL". Allowed fields: base_url, api_key, model.' } }
        });

        // The models route merges over the STORE's live settings, not the key-free defaults
        // advertised to clients; a blank base URL is rejected before any network call.
        const blank = createRuntime(
            { baseURL: '', apiKey: '', model: 'demo-model' },
            { baseURL: '', model: 'demo-model', hasApiKey: false }
        );

        expect(await call(blank, 'POST', `${MOUNT}/models`, {})).toEqual({
            status: 400,
            body: { error: { message: 'Set a provider base URL before listing models.' } }
        });
    });

    it('lists nothing for a GET on a write-only route and refuses an undeclared verb', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'GET', `${MOUNT}/models`)).toEqual({
            status: 405,
            body: { error: { message: 'Use POST for /v1/harness/models.' } }
        });

        expect(await call(runtime, 'DELETE', `${MOUNT}/tools`)).toEqual({
            status: 405,
            body: { error: { message: 'Use GET for /v1/harness/tools.' } }
        });

        expect(await call(runtime, 'DELETE', `${MOUNT}/sessions`)).toEqual({
            status: 405,
            body: { error: { message: 'Use GET, POST for /v1/harness/sessions.' } }
        });
    });
});

// Issue 0005 (C): `POST /sessions` may START with a transcript instead of an empty one, so a
// client that already holds the conversation does not have to replay it through the transcript
// PUT after the session exists. THE semantics this pins (./api.ts postSession, and the JSDoc on
// `CreateSessionRequest.messages` in ./harness.swagger.yaml):
//   - the seed is validated BEFORE anything is created, so a bad row is a 400 and no session;
//   - it is a whole-document REPLACE of the entry agent's default conversation (`agent:<primary>`),
//     which is why a seed with no `system` row drops the profile prompt (see `role_counts` below);
//   - the write goes through the same store signal as a transcript PUT, so the optimistic lock and
//     the persistence layer are unchanged - the seeded document simply starts at revision 1.
describe('seeded transcript on session create', () => {
    // The seed, spelled once. Deliberately NO `system` row: the row below that says the prompt is
    // gone is the assertion, not an accident of this fixture.
    const SEED = [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4.' }
    ];

    // The conversation a `general` session seeds: the entry agent's default thread, id derived
    // from the card's primary (./sessions.ts `THREAD_AGENT_PREFIX`). It is NOT a user thread, so
    // `GET /sessions/:id/threads` stays empty - pinned below so a future "seed creates a thread"
    // change is a visible decision here.
    const ENTRY_THREAD = 'agent:general';

    it('writes the seed into the entry conversation and reads back exactly those rows', async () => {
        const runtime = createRuntime();

        const created = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'general', messages: SEED });

        expect(created.status).toBe(201);
        // A seeded create bumps the session record once more than a plain one (revision 1), because
        // the seed commits a thread revision alongside it (./api.ts postSession).
        expect(created.body.session).toEqual({
            ...created.body.session,
            harness: 'general',
            status: 'idle',
            turn_count: 0,
            thread_count: 0,
            revision: 2,
            definition_revision: 1
        });

        const sessionId = created.body.session.id as string;

        // The seed does not create a listed conversation.
        expect((await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdThreads(sessionId))).body).toEqual({
            limit: 0,
            next_cursor: null,
            observed_at: expect.any(Number),
            revision: 1,
            items: []
        });

        // The metadata read: two rows, and `role_counts.system` is ZERO - the profile prompt the
        // card would have seeded is gone, exactly as the replace semantics promise.
        const meta = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(sessionId, ENTRY_THREAD));

        expect(meta.status).toBe(200);
        expect(meta.body.transcript).toEqual({
            session_id: sessionId,
            thread_id: ENTRY_THREAD,
            agent: 'general',
            transcript_state: 'ok',
            message_count: 2,
            chars: 14,
            bytes: 118,
            revision: 1,
            role_counts: { system: 0, user: 1, assistant: 1, tool: 0 }
        });

        // THE row-level proof: the transcript the next provider request will send is byte-for-byte
        // the seed, ids minted from `msg-1` like any fresh transcript.
        const messages = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages(sessionId, ENTRY_THREAD)
        );

        expect(messages.status).toBe(200);
        expect(messages.body).toEqual({
            limit: 2,
            next_cursor: null,
            observed_at: expect.any(Number),
            revision: 1,
            items: [
                { role: 'user', content: 'What is 2+2?', messageId: 'msg-1' },
                { role: 'assistant', content: '4.', messageId: 'msg-2' }
            ],
            thread_id: ENTRY_THREAD,
            agent: 'general',
            transcript_state: 'ok',
            total: 2
        });
    });

    it('a plain create still carries the profile prompt the seed replaces', async () => {
        // The contrast that makes the assertion above mean something: with NO seed the same
        // conversation opens with the General system message, so `system: 0` above is the seed's
        // doing and not the default.
        const runtime = createRuntime();
        const session = await createDemo(runtime);
        const threadId = 'agent:general';

        const meta = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(session.id, threadId));

        // `demo` runs the real General profile, so this is the General prompt: one system row and
        // an empty transcript apart from it.
        expect(meta.body.transcript.agent).toBe('general');
        expect(meta.body.transcript.message_count).toBe(1);
        expect(meta.body.transcript.role_counts).toEqual({ system: 1, user: 0, assistant: 0, tool: 0 });
        expect(meta.body.transcript.revision).toBe(0);
    });

    it('refuses a seed the transcript reader rejects, and creates nothing', async () => {
        const runtime = createRuntime();

        const before = await call(runtime, 'GET', HARNESS_ROUTES.sessions());

        expect(before.body.items).toHaveLength(0);

        // THE one validator: the message names the offending path and the accepted roles, the same
        // wording a transcript PUT uses (./api.ts reads the seed with `readHarnessMessages`).
        const rejected = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), {
            harness: 'general',
            messages: [{ role: 'nope', content: 'x' }]
        });

        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({
            error: { message: 'body.messages[0].role must be one of: system, user, assistant, tool.' }
        });

        const after = await call(runtime, 'GET', HARNESS_ROUTES.sessions());

        expect(after.body.items).toEqual([]);
    });

    it('keeps the transcript optimistic lock honest after a seed', async () => {
        const runtime = createRuntime();
        const created = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'general', messages: SEED });
        const sessionId = created.body.session.id as string;
        const transcriptRoute = HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(sessionId, ENTRY_THREAD);

        // The seeded document is ALREADY at revision 1, so the write a client would have sent
        // against an empty transcript (`if_revision: 0`) is now a stale write, refused with the
        // current revision named - the lock survives seeding rather than resetting.
        const stale = await call(runtime, 'PUT', transcriptRoute, {
            messages: [{ role: 'user', content: 'stale' }],
            if_revision: 0
        });

        expect(stale.status).toBe(409);
        expect(stale.body).toEqual({
            error: { message: 'This transcript is at revision 1; the write expected 0. Re-read before writing.' }
        });

        // The correct guard writes, and the revision moves exactly once.
        const fresh = await call(runtime, 'PUT', transcriptRoute, {
            messages: [{ role: 'user', content: 'fresh' }],
            if_revision: 1
        });

        expect(fresh.status).toBe(200);
        expect(fresh.body).toEqual({
            session_id: sessionId,
            thread_id: ENTRY_THREAD,
            accepted_as: 'transcript',
            message_count: 1,
            revision: 2,
            links: {
                transcript: transcriptRoute,
                messages: `${transcriptRoute}/messages?limit=25`,
                document: `${transcriptRoute}/document`
            }
        });

        // And the replace really replaced the SEED, not just the prompt.
        const messages = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages(sessionId, ENTRY_THREAD)
        );

        expect(messages.body.items).toEqual([{ role: 'user', content: 'fresh', messageId: 'msg-1' }]);
        expect(messages.body.total).toBe(1);
    });

    it('runs the tool-less chat card over the wire with no catalogue tool', async () => {
        // Issue 0005 (D) through the same surface a client uses: the card lists in the catalogue,
        // declares no tool, and creates a session like any other card.
        const runtime = createRuntime();

        const definition = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('chat'));

        expect(definition.status).toBe(200);
        expect(definition.body.harness.name).toBe('chat');
        expect(definition.body.harness.title).toBe('Chat');
        expect(definition.body.harness.primary).toBe('general');
        expect(definition.body.harness.agents).toEqual(['general']);
        // THE picker contract: an empty tool list, and the only declarations the harness makes are
        // the kernel's bootstrap pair - which is how the model is told to unlock a tool later.
        expect(definition.body.harness.tools).toEqual([]);
        expect(definition.body.harness.core_tools).toEqual(['toolRequest', 'tasks']);
        expect(definition.body.harness.instruction_summary).toEqual([
            { agent: 'general', source: 'catalogue', overridden: false, chars: 135 }
        ]);

        const created = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'chat' });

        expect(created.status).toBe(201);
        expect(created.body.session.harness).toBe('chat');
        // Unseeded, so the record revision is the plain create figure (1, not the seed's 2).
        expect(created.body.session.revision).toBe(1);
        expect(created.body.session.agent_models).toEqual({ general: 'demo-model' });

        // A chat session can also be seeded, the same as any other card.
        const seeded = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'chat', messages: SEED });

        expect(seeded.status).toBe(201);
        expect(seeded.body.session.harness).toBe('chat');
    });
});

// The removed surface, pinned as REMOVED. Replaces the old '/presets alias', '/tools/bootstrap'
// and 'standalone /api compatibility' blocks: an old address is a 404 that names the canonical
// root's rules, never a redirect and never a second route table.
describe('legacy surface is gone', () => {
    it('404s every old address instead of aliasing it', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        expect(await call(runtime, 'GET', '/api/harnesses')).toEqual({
            status: 404,
            body: { error: { message: 'Unknown API route: GET /api/harnesses' } }
        });
        expect(await call(runtime, 'GET', `${MOUNT}/presets`)).toEqual({
            status: 404,
            body: { error: { message: 'Unknown API route: GET /v1/harness/presets' } }
        });
        expect(await call(runtime, 'GET', `${MOUNT}/presets/instruct`)).toEqual({
            status: 404,
            body: { error: { message: 'Unknown API route: GET /v1/harness/presets/instruct' } }
        });
        // `/tools/bootstrap` now matches the identified-tool route, so the honest answer is that no
        // tool is named "bootstrap".
        expect(await call(runtime, 'GET', `${MOUNT}/tools/bootstrap`)).toEqual({
            status: 404,
            body: { error: { message: 'Unknown tool "bootstrap".' } }
        });
        // The SSE submit is gone: a task is 202 + receipt, and realtime is the WebSocket stream.
        expect(
            await call(runtime, 'POST', `${MOUNT}/sessions/${session.id}/messages`, { input: 'hi' })
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown API route: POST /v1/harness/sessions/${session.id}/messages` } }
        });
        expect(await call(runtime, 'GET', `${MOUNT}/not-a-route`)).toEqual({
            status: 404,
            body: { error: { message: 'Unknown API route: GET /v1/harness/not-a-route' } }
        });
    });

    it('answers the stream path as an upgrade the JSON pipeline never serves', async () => {
        const runtime = createRuntime();

        // The adapter owns this answer (./service.ts:472): the upgrade is taken on the raw socket by
        // `createHarnessServiceUpgrade`, so a plain GET here asked for something it did not send.
        expect(await call(runtime, 'GET', `${MOUNT}/stream`)).toEqual({
            status: 400,
            body: {
                error: {
                    message: 'GET /v1/harness/stream is a WebSocket upgrade: send Upgrade: websocket and Connection: Upgrade.'
                }
            }
        });
    });
});

// The browser access boundary. Unchanged semantics from the old file; only the URLs it is applied
// to moved.
describe('service origin gate', () => {
    it('allows requests with no Origin, same-origin, and loopback origins', async () => {
        const runtime = createRuntime();

        const noOrigin = await callWithHeaders(runtime, 'GET', `${MOUNT}/health`);
        expect(noOrigin.status).toBe(200);

        const sameOrigin = await callHandler(runtime, 'GET', `${MOUNT}/health`, {
            headers: { origin: 'http://127.0.0.1:5000', host: '127.0.0.1:5000' }
        });
        expect(sameOrigin.status).toBe(200);

        const devLoopback = await callHandler(runtime, 'GET', `${MOUNT}/health`, {
            headers: { origin: 'http://localhost:5173', host: '127.0.0.1:5000' }
        });
        expect(devLoopback.status).toBe(200);
    });

    it('rejects a non-loopback cross-origin browser request with 403', async () => {
        const runtime = createRuntime();

        const hostile = await callHandler(runtime, 'GET', MOUNT, {
            headers: { origin: 'https://evil.example', host: '127.0.0.1:5000' }
        });
        expect(await jsonOf(hostile)).toEqual({
            status: 403,
            body: { error: { message: 'Cross-origin requests are not allowed.' } }
        });

        // Loopback is allowed by design (dev UI), even on another port; a LAN origin is not.
        const sameHostDifferentPort = await callHandler(runtime, 'GET', MOUNT, {
            headers: { origin: 'http://127.0.0.1:6000', host: '127.0.0.1:5000' }
        });
        expect(sameHostDifferentPort.status).toBe(200);

        const lanOrigin = await callHandler(runtime, 'GET', MOUNT, {
            headers: { origin: 'http://192.168.1.20:8080', host: '127.0.0.1:5000' }
        });
        expect(lanOrigin.status).toBe(403);
    });

    it('allows the deployed GitHub Pages UI to dial the service cross-origin', async () => {
        const runtime = createRuntime();

        const pagesHealth = await callHandler(runtime, 'GET', `${MOUNT}/health`, {
            headers: { origin: 'https://underloadjs.github.io', host: '127.0.0.1:5000' }
        });
        expect((await jsonOf(pagesHealth)).status).toBe(200);

        // The LAN host is the chain's last entry, and the root document is the first request the
        // deployed UI makes.
        const pagesRoot = await callHandler(runtime, 'GET', MOUNT, {
            headers: { origin: 'https://underloadjs.github.io', host: '192.168.50.109:5000' }
        });
        expect(pagesRoot.status).toBe(200);
    });

    it('keeps the Pages allowance to an https github.io origin', async () => {
        const runtime = createRuntime();

        const rejected = [
            'http://underloadjs.github.io', // Pages serves the UI over https only
            'https://github.io', // the zone itself is not a Pages site
            'https://github.io.attacker.test', // label-boundary lookalike
            'https://underloadjs.github.io.attacker.test', // same, with a subdomain
            'https://evil.example' // any other public page
        ];

        for (const origin of rejected) {
            const result = await callHandler(runtime, 'GET', `${MOUNT}/health`, {
                headers: { origin, host: '127.0.0.1:5000' }
            });

            expect(result.status, origin).toBe(403);
        }
    });
});
// Catalogue reads: paged summaries on the collection routes, the heavy member one named read away.
//
// Replaces the old 'preset descriptor tool metadata' block and the old 'GET /tools' listing test.
// A card no longer carries `coreTools`, `agentModels`, `agentInstructions`, or `editable`: those
// are definition/instruction reads now, and the write field list names what a client may send.
describe('harness catalogue reads', () => {
    // The default card's own description text (`HarnessPreset.description`, NOT the agent
    // profile's shorter picker sentence - both are pinned, here and in the agents read below).
    const GENERAL_DESCRIPTION =
        'The default general-purpose agent, with the full shared toolbox and NO subagents: it does every step itself, so `delegate` is not registered and cannot be enabled. File read/write/edit/glob and a configured search are always available; call toolRequest for files, commands, diffs, syntax checks, time, text, or notes.';
    const INSTRUCT_DESCRIPTION =
        'General worker with the full shared toolbox and the other roles as direct subagents. It does its own building and editing, and delegates only the steps that would burn its context: research, exploration, a long read, a review. Unlike the Manager, it never hands out work it must still finish itself.';

    it('pages the cards as identity + tool names, with no definition text', async () => {
        const runtime = createRuntime();
        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.body.items.map((card: any) => card.name)).toEqual(CARD_NAMES);
        // The catalogue order is a contract (presets.ts: it is what a picker renders and what the
        // frontend palette assigns tones by), and the TITLES moved with the role pass while the
        // ids did not: `research` is Explore, `workspace` is Analyst, `planner` is Manager. Pinned
        // as one pair list so a renamed card or a reordered row fails instead of renumbering below.
        expect(page.body.items.map((card: any) => [card.name, card.title])).toEqual([
            ['general', 'General'],
            ['instruct', 'Instruct'],
            ['research', 'Explore'],
            ['workspace', 'Analyst'],
            ['reviewer', 'Reviewer'],
            ['planner', 'Manager'],
            ['debugger', 'Debugger'],
            ['chat', 'Chat'],
            ['demo', 'Scripted fixture'],
            ['flaky', 'Recoverable failures (fixture)']
        ]);
        // `limit` echoes the RETURNED row count (./api-paging.ts:148), and a page that is not full
        // carries no cursor.
        expect(page.body.limit).toBe(CARD_NAMES.length);
        expect(page.body.next_cursor).toBeNull();
        expect(page.body.revision).toBe(runtime.events.getRevision('harnesses'));

        for (const card of page.body.items) expect(Object.keys(card).sort()).toEqual(CARD_KEY_SET);

        // The first card, byte for byte: the DEFAULT. `requires_endpoint` is the snake_case
        // spelling of the old `requiresEndpoint`, and `editable` is gone: every template is
        // patchable now. `subagents: []` and `agents: ['general']` are load-bearing (see
        // presets.ts) - the default card has no team, so it has nothing to delegate to.
        expect(page.body.items[0]).toEqual({
            name: 'general',
            title: 'General',
            description: GENERAL_DESCRIPTION,
            requires_endpoint: true,
            primary: 'general',
            subagents: [],
            agents: ['general'],
            tools: [...TOOLBOX, 'fetch'],
            builtin: true,
            definition_revision: 0
        });

        // The first delegating card, byte for byte. Its team is every OTHER role except the
        // Manager - `planner` is excluded from every built-in team because a Manager refuses to run
        // as a delegate (src/agents/planner.ts) - plus the summarizer.
        expect(page.body.items[1]).toEqual({
            name: 'instruct',
            title: 'Instruct',
            description: INSTRUCT_DESCRIPTION,
            requires_endpoint: true,
            primary: 'instruct',
            subagents: ['general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            agents: ['instruct', 'general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
            tools: [...TOOLBOX, 'fetch'],
            builtin: true,
            definition_revision: 0
        });

        // The Manager card is the mirror image: its team holds every other role by id, because it
        // delegates everything and never works.
        expect(page.body.items[5].subagents).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'debugger',
            'summarizer'
        ]);

        // THE TOOL-LESS CARD (issue 0005-D), byte for byte. This is the wire evidence that a client
        // CAN select an empty toolbox: `tools: []` is what the card advertises, and the runtime
        // behind it registers no catalogue tool either (pinned in
        // ./harnesses/presets.test.ts, which compares this card's descriptor against
        // `harness.tools`). `primary: 'general'` is deliberate — the card selects the trusted
        // lone-wolf profile rather than inventing a prompt.
        expect(page.body.items[7]).toEqual({
            name: 'chat',
            title: 'Chat',
            description:
                'A single answer with no toolbox: the General profile on an empty catalogue (no file, search, delegation, or record tool is registered) and one model call. It cannot read or write the server host and never spends a tool round, so it is the card for a surface that only talks.',
            requires_endpoint: true,
            primary: 'general',
            subagents: [],
            agents: ['general'],
            tools: [],
            builtin: true,
            definition_revision: 0
        });

        // The offline fixture stays described, just not first, and its registry is still
        // timeNow-only (no package toolbox).
        expect(page.body.items[8]).toEqual({
            name: 'demo',
            title: 'Scripted fixture',
            description:
                'Test fixture: runs a scripted transport — a reasoning stream, a toolRequest discovery round, one tool call, and a final answer. No endpoint needed. Not a production configuration.',
            requires_endpoint: false,
            // The AGENT is a real role even though the CARD is a fixture: there is no `demo`
            // profile in this build, and a harness that named one could not be validated.
            primary: 'general',
            subagents: [],
            agents: ['general'],
            tools: ['timeNow'],
            builtin: true,
            definition_revision: 0
        });
    });

    it('pages with a cursor and refuses a bad limit by naming the parameter', async () => {
        const runtime = createRuntime();

        const first = await call(runtime, 'GET', HARNESS_ROUTES.harnesses(), {}, { limit: '2' });

        expect(first.status).toBe(200);
        expect(first.body.items.map((card: any) => card.name)).toEqual(['general', 'instruct']);
        // A page that returns exactly its limit ALWAYS carries a cursor, even when the collection
        // ends after the next row (./api-paging.ts:7).
        expect(first.body.next_cursor).toEqual(expect.any(String));

        const second = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.harnesses(),
            {},
            { limit: '2', cursor: first.body.next_cursor as string }
        );
        expect(second.body.items.map((card: any) => card.name)).toEqual(['research', 'workspace']);

        expect(await call(runtime, 'GET', HARNESS_ROUTES.harnesses(), {}, { limit: '0' })).toEqual({
            status: 400,
            body: { error: { message: `Query parameter "limit" must be an integer between 1 and ${HARNESS_PAGE_LIMIT.max}.` } }
        });

        expect(
            (await call(runtime, 'GET', HARNESS_ROUTES.harnesses(), {}, { cursor: 'not-a-cursor' })).status
        ).toBe(400);
    });

    it('reads one definition: the card plus core tools and the instruction summary', async () => {
        const runtime = createRuntime();

        const definition = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('instruct'));

        expect(definition.status).toBe(200);
        expect(Object.keys(definition.body).sort()).toEqual(['harness']);
        expect(Object.keys(definition.body.harness).sort()).toEqual(
            [...CARD_KEY_SET, 'core_tools', 'instruction_summary'].sort()
        );

        const { harness: card } = definition.body;
        expect(card.name).toBe('instruct');
        expect(card.definition_revision).toBe(runtime.events.getRevision('definition', 'instruct'));
        // The core set is what THIS host would declare: the bootstrap pair, the session plan,
        // delegation (this card has subagents), the five file tools, and the credential-free fetch.
        expect(card.core_tools).toEqual(LIVE_CORE_TOOLS);
        // Summary rows carry sizes, never text: the instruction routes below are where text lives.
        // One row per team member, in `preset.agents` order (primary first). `chars` is the identity
        // sentence length, and the roster moved every figure: seven members now that the instruct
        // team carries `general` and `debugger` and no longer `planner`.
        // NOTE (regression pin): `chars` is `profile.instruction.length` (api-reads.ts:1289), NOT
        // the composed prompt, so adding a shared guideline to a profile — e.g. WEB_SEARCH to
        // `debugger`, which grew its system prompt to 1690 — must leave these figures alone.
        expect(card.instruction_summary).toEqual([
            { agent: 'instruct', source: 'catalogue', overridden: false, chars: 132 },
            { agent: 'general', source: 'catalogue', overridden: false, chars: 135 },
            { agent: 'research', source: 'catalogue', overridden: false, chars: 116 },
            { agent: 'workspace', source: 'catalogue', overridden: false, chars: 132 },
            { agent: 'reviewer', source: 'catalogue', overridden: false, chars: 120 },
            { agent: 'debugger', source: 'catalogue', overridden: false, chars: 103 },
            { agent: 'summarizer', source: 'catalogue', overridden: false, chars: 56 }
        ]);

        // The DEFAULT card, same read. One summary row because it has no team, and `delegate` is
        // absent from its declared core - the runtime never registers it for `subagents: []`
        // (src/harness.ts `activation: 'subagents'`), so the default agent cannot split work out.
        const generalDefinition = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('general'));
        expect(generalDefinition.body.harness.subagents).toEqual([]);
        expect(generalDefinition.body.harness.agents).toEqual(['general']);
        expect(generalDefinition.body.harness.core_tools).toEqual(GENERAL_CORE_TOOLS);
        expect(generalDefinition.body.harness.instruction_summary).toEqual([
            { agent: 'general', source: 'catalogue', overridden: false, chars: 135 }
        ]);

        // The scripted fixture declares only what its own registry can run.
        const demo = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('demo'));
        expect(demo.body.harness.core_tools).toEqual(['toolRequest', 'tasks']);
        expect(demo.body.harness.tools).toEqual(['timeNow']);
        expect(demo.body.harness.instruction_summary).toEqual([
            { agent: 'general', source: 'catalogue', overridden: false, chars: 135 }
        ]);

        // An unknown card is the registry's own 404 wording, and an identified read resolves a
        // LEGACY ALIAS to the canonical card it names (the same read semantics as creation).
        expect(await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('ghost'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "ghost".' } }
        });

        const alias = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('writer'));
        expect(alias.status).toBe(200);
        expect(alias.body.harness.name).toBe('instruct');
        expect(alias.body.harness).toEqual(definition.body.harness);

        // A TITLE is not a NAME. The roster pass renamed only display titles, and deliberately added
        // no alias for one (src/server/harnesses/presets.ts header: a new reserved name could
        // collide with a user-created harness on restore), so none of the five card titles resolves
        // as a harness id — not even `General`, the default card, whose id is `general`.
        for (const title of ['General', 'Explore', 'Analyst', 'Manager', 'Debugger']) {
            expect(await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName(title))).toEqual({
                status: 404,
                body: { error: { message: `Unknown harness "${title}".` } }
            });
        }
    });

    it('summaries and instruction text agree with the trusted profile', async () => {
        const runtime = createRuntime();

        const list = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessNameInstructions('instruct'));

        expect(list.status).toBe(200);
        expect(Object.keys(list.body).sort()).toEqual(['harness_name', 'items', 'total']);
        // Seven members: the instruct team is every other role except the Manager, plus the
        // summarizer (src/server/harnesses/presets.ts `teamOf`).
        expect(list.body.total).toBe(7);
        // The rows are exactly the `instruction_summary` the definition read carries.
        expect(list.body.items).toEqual((await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('instruct'))).body.harness.instruction_summary);

        const text = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId('instruct', 'instruct')
        );

        expect(text.status).toBe(200);
        expect(Object.keys(text.body).sort()).toEqual(['agent', 'chars', 'guidelines', 'harness_name', 'instruction', 'source']);
        // RAW profile halves, unjoined: the picker renders identity and rules separately, and the
        // `chars` figure above is the identity length.
        expect(text.body.harness_name).toBe('instruct');
        expect(text.body.agent).toBe('instruct');
        expect(text.body.source).toBe('catalogue');
        expect(text.body.instruction).toBe(INSTRUCT_IDENTITY);
        expect(text.body.chars).toBe(INSTRUCT_IDENTITY.length);
        expect(text.body.guidelines).toEqual(INSTRUCT_GUIDELINES);

        // An agent outside the team is a 400-shaped 404 that names both sides.
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId('demo', 'ghost'))
        ).toEqual({ status: 404, body: { error: { message: 'Agent "ghost" is not a member of harness "demo".' } } });
    });

    it('pages the trusted agent profiles and reads one', async () => {
        const runtime = createRuntime();

        const page = await call(runtime, 'GET', HARNESS_ROUTES.agents());

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.body.items.map((agent: any) => agent.name)).toEqual(AGENT_NAMES);
        // A profile row is a picker row: identity text only, no guideline arrays.
        for (const row of page.body.items) {
            expect(Object.keys(row).sort()).toEqual(['description', 'has_global_override', 'has_instruction_override', 'name', 'title']);
        }
        expect(page.body.items[0]).toEqual({
            name: 'general',
            title: 'General',
            description:
                'The default general-purpose agent. It does the whole task itself, start to finish: this harness configures no subagents, so delegate is not even registered and it never splits work out.',
            has_instruction_override: false,
            has_global_override: false
        });
        // The picker rows carry the DISPLAY title, which is the half of an agent's identity that
        // moves freely; the row's `name` stays the persisted registry id (src/agents/index.ts
        // explains why an id cannot move). One exact list, so Explore/Analyst/Manager cannot leak
        // into a `name` and a retitle is a visible diff.
        expect(page.body.items.map((row: any) => [row.name, row.title])).toEqual([
            ['general', 'General'],
            ['instruct', 'Instruct'],
            ['research', 'Explore'],
            ['workspace', 'Analyst'],
            ['reviewer', 'Reviewer'],
            ['planner', 'Manager'],
            ['debugger', 'Debugger'],
            ['summarizer', 'Summarizer']
        ]);

        // The DEFAULT profile, read whole: id, title, and the two prompt halves. Its guidelines are
        // the only set with NO delegation line, because its harness configures no subagents and the
        // runtime never registers `delegate` (src/agents/general.ts). `referenced_by` shows the
        // other half of the roster contract: every OTHER live card CAN delegate to `general`.
        const generalProfile = await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('general'));

        expect(generalProfile.status).toBe(200);
        expect(generalProfile.body.agent.name).toBe('general');
        expect(generalProfile.body.agent.title).toBe('General');
        expect(generalProfile.body.agent.instruction).toBe(GENERAL_IDENTITY);
        expect(generalProfile.body.agent.guidelines).toEqual(GENERAL_GUIDELINES);
        expect(generalProfile.body.agent.instruction_source).toBe('catalogue');
        // EVERY card in this runtime references it — the seven shipped cards AND the two
        // injected fixture cards, whose agent is `general` because no `demo`/`flaky` profile
        // exists in this build (./harnesses/fixture-presets.test-support.ts header).
        expect(generalProfile.body.agent.referenced_by).toEqual(CARD_NAMES);

        const profile = await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('instruct'));

        expect(profile.status).toBe(200);
        expect(Object.keys(profile.body).sort()).toEqual(['agent']);
        expect(Object.keys(profile.body.agent).sort()).toEqual([
            'description',
            'guidelines',
            'instruction',
            'instruction_source',
            'name',
            'referenced_by',
            'revision',
            'title'
        ]);
        expect(profile.body.agent.instruction).toBe(INSTRUCT_IDENTITY);
        expect(profile.body.agent.guidelines).toEqual(INSTRUCT_GUIDELINES);
        expect(profile.body.agent.instruction_source).toBe('catalogue');
        // `referenced_by` is derived from the live registry, so a removal impact list cannot drift.
        // Every live card EXCEPT `general` (which has no team) and the two fixtures selects instruct.
        expect(profile.body.agent.referenced_by).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger'
        ]);

        // The renamed titles, read by their UNCHANGED ids. A saved record naming `research` still
        // resolves, and the text that reaches the model is the new Explore brief.
        const renamed = await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('research'));
        expect(renamed.body.agent.name).toBe('research');
        expect(renamed.body.agent.title).toBe('Explore');
        expect(renamed.body.agent.instruction).toBe(RESEARCH_IDENTITY);
        expect(renamed.body.agent.guidelines).toEqual(RESEARCH_GUIDELINES);

        expect((await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('workspace'))).body.agent.title).toBe('Analyst');
        expect((await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('planner'))).body.agent.title).toBe('Manager');

        // The new role, pinned on the wire rather than by a count: id, title, and the full trusted
        // prompt halves.
        const debuggerProfile = await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('debugger'));
        expect(debuggerProfile.status).toBe(200);
        expect(debuggerProfile.body.agent.name).toBe('debugger');
        expect(debuggerProfile.body.agent.title).toBe('Debugger');
        expect(debuggerProfile.body.agent.instruction).toBe(DEBUGGER_IDENTITY);
        expect(debuggerProfile.body.agent.guidelines).toEqual(DEBUGGER_GUIDELINES);
        expect(debuggerProfile.body.agent.instruction_source).toBe('catalogue');

        // A TITLE is not a name: the routes resolve ids, and nothing aliases a title.
        expect(await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('Explore'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown agent "Explore".' } }
        });

        expect(await call(runtime, 'GET', HARNESS_ROUTES.agentsByAgentId('ghost'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown agent "ghost".' } }
        });
    });

    it('pages tool rows without an argument schema and reads the schema on demand', async () => {
        const runtime = createRuntime();

        const page = await call(runtime, 'GET', HARNESS_ROUTES.tools(), {}, { limit: '100' });

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.body.items.map((tool: any) => tool.name)).toEqual(TOOL_NAMES);
        expect(page.body.limit).toBe(TOOL_NAMES.length);
        expect(page.body.next_cursor).toBeNull();

        // A row is the picker shape: description, gate and availability - the argument schema never
        // rides it, which is the size signal the whole read model exists for. R3 added the
        // `enabled` figure every Tools row carries; R5/R6 added no exception beside it, so a
        // row states no `protected` flag and every entry is switchable.
        expect(Object.keys(page.body.items[0]).sort()).toEqual([
            'availability',
            'description',
            'enabled',
            'group',
            'name',
            'session_bound',
            'tags',
            'visibility'
        ]);
        // Nothing has been switched off on this deployment. `toolRegistry` is demoted to a
        // searchable entry in this build, and the switch applies to it like every other row
        // (./tool-settings.ts).
        expect(page.body.items[0].enabled).toBe(true);
        expect(Object.hasOwn(page.body.items[0], 'protected')).toBe(false);
        expect('parameters' in page.body.items[0]).toBe(false);
        expect(page.body.items[0].name).toBe('toolRegistry');
        expect(page.body.items[0].group).toBe('Core tools');
        expect(page.body.items[0].visibility).toBe('searchable');
        expect(page.body.items[0].session_bound).toBe(true);
        expect(page.body.items[0].availability).toEqual({
            state: 'available',
            hint: 'Runs inside a session harness: send a sessionId with the call.'
        });

        const rows = new Map(page.body.items.map((tool: any) => [tool.name, tool]));
        // R9-R11 visibility stays honest in the row projection: the bootstrap pair and the session
        // plan are `core`, the demoted runtime rows are `searchable`.
        expect(rows.get('toolRequest').visibility).toBe('core');
        expect(rows.get('tasks').visibility).toBe('core');
        expect(rows.get('delegate').visibility).toBe('core');
        expect(rows.get('toolList').visibility).toBe('searchable');
        expect(rows.get('read').visibility).toBe('core');
        expect(rows.get('read').group).toBe('Package presets');
        expect(rows.get('read').session_bound).toBe(false);
        // A keyless search is still LISTED, and says so, without being falsely session-bound.
        expect(rows.get('search').availability).toEqual({
            state: 'unconfigured',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY'],
            hint: WEBSEARCH_UNCONFIGURED_HINT
        });
        // A tool with nothing to add omits `availability` rather than repeating "available",
        // and still carries the R3 `enabled` figure.
        expect(Object.keys(rows.get('timeNow')).sort()).toEqual([
            'description',
            'enabled',
            'group',
            'name',
            'session_bound',
            'tags',
            'visibility'
        ]);

        // The detail read is the row PLUS the schema and the execution gate — which
        // includes R3's `enabled`, so the identified read a PATCH answers with
        // is the same shape a client just read (./tools-api.test.ts pins the write).
        const clock = await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolId('timeNow'));
        expect(clock.status).toBe(200);
        expect(Object.keys(clock.body.tool).sort()).toEqual([
            'description',
            'enabled',
            'execution',
            'group',
            'name',
            'parameters',
            'session_bound',
            'tags',
            'visibility'
        ]);
        expect(clock.body.tool.execution).toEqual({ scope: 'global', manual: true });
        expect(clock.body.tool.parameters).toEqual({
            type: 'object',
            properties: {
                timezone: { type: 'string', maxLength: 64, description: 'Label for the timezone being asked about, e.g. "UTC".' }
            },
            required: ['timezone'],
            additionalProperties: false
        });

        // A harness-owned control tool advertises the gate that makes the global call a 403.
        const discovery = await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolId('toolRequest'));
        expect(discovery.body.tool.execution).toEqual({ scope: 'session_required', manual: false });
        expect(discovery.body.tool.parameters).toEqual({
            type: 'object',
            properties: {
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Exact wire names to enable, case-sensitive (e.g. ["files"]).'
                },
                regex: { type: 'string', description: 'JavaScript regex tested against tool names; bare source or /source/flags.' },
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

        // T12/T16: `files` declares ONE array property, and the operation discriminator
        // lives inside the item (the full item schema is pinned in ../tools/catalogue.test.ts).
        const files = await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolId('files'));
        const filesSchema = files.body.tool.parameters as {
            type: string;
            required: string[];
            additionalProperties: boolean;
            properties: {
                ops: {
                    type: string;
                    maxItems: number;
                    items: {
                        required: string[];
                        additionalProperties: boolean;
                        properties: {
                            op: { enum: string[] };
                            limit: { maximum: number };
                        };
                    };
                };
            };
        };

        expect(filesSchema.type).toBe('object');
        expect(Object.keys(filesSchema.properties)).toEqual(['ops']);
        expect(filesSchema.required).toEqual(['ops']);
        expect(filesSchema.additionalProperties).toBe(false);
        expect(filesSchema.properties.ops.type).toBe('array');
        expect(filesSchema.properties.ops.maxItems).toBe(100);
        expect(filesSchema.properties.ops.items.required).toEqual(['op']);
        expect(filesSchema.properties.ops.items.additionalProperties).toBe(false);
        expect(filesSchema.properties.ops.items.properties.op.enum).toEqual([
            'list',
            'move',
            'copy',
            'delete',
            'mkdir'
        ]);
        // Paging is a property of the list operation, not of the call, so the entry-level
        // cap is where a paged answer is bounded.
        expect(filesSchema.properties.ops.items.properties.limit.maximum).toBe(1000);

        // The unconfigured environment row is listed but not manually executable, and a name the
        // catalogue never had is a 404.
        const search = await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolId('search'));
        expect(search.body.tool.execution).toEqual({ scope: 'global', manual: false });
        expect(search.body.tool.availability).toEqual({
            state: 'unconfigured',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY'],
            hint: WEBSEARCH_UNCONFIGURED_HINT
        });

        expect(await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolId('nope'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown tool "nope".' } }
        });
    });

    it('keeps the same toolbox on every role card, adds search only with a key, and gives chat none', async () => {
        const keyless = createRuntime();
        const keylessCards = (await call(keyless, 'GET', HARNESS_ROUTES.harnesses())).body.items;
        const keylessTools = new Map(keylessCards.map((card: any) => [card.name, card.tools]));

        // R9-R11: keyless still registers `fetch` (the native provider needs no credential), so
        // every role card's registered list ends with it; only `search` is absent. No real card
        // gets a subset any more - the toolbox is not part of what a harness choice changes.
        for (const name of ROLE_CARD_NAMES) {
            expect(keylessTools.get(name)).toEqual([...TOOLBOX, 'fetch']);
        }
        expect(keylessTools.get('demo')).toEqual(['timeNow']);
        expect(keylessTools.get('flaky')).toEqual([...TOOLBOX, 'testFlaky', 'fetch']);

        // THE tool-less card (issue 0005-D): the one production card whose registered list is
        // EMPTY, in both states. `fetch` in particular registers without a credential on every
        // other card, so pinning `[]` keyless is what proves the card opted out rather than that
        // the host had no keys.
        expect(keylessTools.get('chat')).toEqual([]);

        // The configured host: the same cards, plus the environment row.
        const configured = createConfiguredRuntime();
        const configuredCards = (await call(configured, 'GET', HARNESS_ROUTES.harnesses())).body.items;
        const configuredTools = new Map(configuredCards.map((card: any) => [card.name, card.tools]));

        for (const name of ROLE_CARD_NAMES) {
            expect(configuredTools.get(name)).toEqual([...TOOLBOX, 'search', 'fetch']);
        }
        expect(configuredTools.get('demo')).toEqual(['timeNow']);
        expect(configuredTools.get('flaky')).toEqual([...TOOLBOX, 'testFlaky', 'search', 'fetch']);
        // And a web-search key does not leak onto the tool-less card either.
        expect(configuredTools.get('chat')).toEqual([]);

        // The direct catalogue agrees: the same key makes the tool callable.
        const row = (await call(configured, 'GET', HARNESS_ROUTES.tools(), {}, { limit: '100' })).body.items.find(
            (tool: any) => tool.name === 'search'
        );
        expect(row.availability).toEqual({ state: 'available', environment: ['EXA_API_KEY', 'TAVILY_API_KEY', 'LINKUP_API_KEY'] });

        // ...and the keyless host's row keeps the credential names (never values) as the hint.
        const unconfigured = (await call(keyless, 'GET', HARNESS_ROUTES.toolsByToolId('search'))).body.tool;
        expect(unconfigured.availability.hint).toBe(WEBSEARCH_UNCONFIGURED_HINT);
    });

    it('ships only the production cards without an injected registry', async () => {
        // No injected registry: exactly what `startHarnessServer` and the discovered service route
        // build. The catalogue a user sees must contain no scripted card and no failing example.
        stubEmptySearchKeys();
        const runtime = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false
        });

        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());

        expect(page.body.items.map((card: any) => card.name)).toEqual(LIVE_CARD_NAMES);
        // Every shipped card needs a provider endpoint — the tool-less `chat` card included, because
        // "no tools" removes the toolbox, never the model.
        expect(page.body.items.map((card: any) => card.requires_endpoint)).toEqual(
            LIVE_CARD_NAMES.map(() => true)
        );
        expect(page.body.items.every((card: any) => card.tools.includes('testFlaky'))).toBe(false);

        // The fixtures are not runnable by accident: the offline demo is a template this build
        // ships, but not a catalogue entry, so a session on it is a 404.
        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'demo' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "demo".' } }
        });
    });
});
// A catalogue with NO harness in it at all: what a server holds before the first create, and
// what it holds again after a reader deletes every harness from the UI.
//
// `createHarnessRegistry([])` had never been exercised here, and the frontend's healthy empty
// state depends on exactly these two answers: the list is a NORMAL paged 200 with an empty
// `items` array (not an error), and the first create needs nothing pre-existing (its primary
// only has to be a trusted agent, which the shipped catalogue always provides). A UI that read
// the empty list as "no server" would lock "+ New" and make the empty state unrecoverable.
describe('a zero-harness registry', () => {
    // The same runtime `createRuntime` builds, minus every template: search keys are stubbed
    // exactly the same way, so no provider credential is read and nothing here touches the net.
    const createEmptyRuntime = (): HarnessRuntime => {
        stubEmptySearchKeys();

        return createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry([]),
            loadEnvironment: false
        });
    };

    it('answers the harness page as an empty collection', async () => {
        const runtime = createEmptyRuntime();

        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());

        // A healthy 200 with the standard page envelope: `limit` echoes the RETURNED row count
        // (./api-paging.ts:148), so an empty catalogue is `limit: 0` with no cursor, and the
        // hub has never moved the harnesses revision.
        expect(page.status).toBe(200);
        expect(page.body).toEqual({
            items: [],
            limit: 0,
            next_cursor: null,
            observed_at: expect.any(Number),
            revision: 0
        });
    });

    it('creates its first harness with no catalogue entry to start from', async () => {
        const runtime = createEmptyRuntime();

        // The state the write starts from - and the answer the UI boots on.
        expect((await call(runtime, 'GET', HARNESS_ROUTES.harnesses())).body.items).toEqual([]);

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
            name: 'release-captain',
            title: 'Release captain',
            description: 'The first harness of an empty registry.',
            primary: 'instruct',
            subagents: []
        });

        expect(created.status).toBe(201);
        // Same card shape as a create against a full catalogue: no team means no `delegate` in
        // the core set (GENERAL_CORE_TOOLS), and the instruction summary is the trusted
        // profile's own char count.
        expect(created.body.harness).toEqual({
            name: 'release-captain',
            title: 'Release captain',
            description: 'The first harness of an empty registry.',
            requires_endpoint: true,
            primary: 'instruct',
            subagents: [],
            agents: ['instruct'],
            tools: [...TOOLBOX, 'fetch'],
            builtin: false,
            definition_revision: 1,
            core_tools: GENERAL_CORE_TOOLS,
            instruction_summary: [{ agent: 'instruct', source: 'catalogue', overridden: false, chars: 132 }]
        });
        expect(created.headers).toEqual({
            'X-Harness-Epoch': runtime.events.epoch,
            'X-Harness-Revision': '1'
        });

        // The catalogue now holds exactly that one card, with the plain card row.
        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(page.body.items.map((card: any) => card.name)).toEqual(['release-captain']);
        expect(page.body.limit).toBe(1);
        expect(page.body.next_cursor).toBeNull();
        expect(Object.keys(page.body.items[0]).sort()).toEqual(CARD_KEY_SET);
    });
});
// Sessions over HTTP: a session RESOURCE is metadata + counters, never a snapshot.
//
// Replaces the old full-snapshot assertions (`messages`, `turns`, `harnessDefinition` on one
// object). The heavy children moved to named reads - `GET /definition`, `GET /usage`,
// `GET /agents`, `GET /tools`, `GET /threads`, `GET /turns` - and the counts ride the row so a
// client knows whether a child read is worth asking for.
describe('canonical sessions', () => {
    // The exact resource shape, pinned once.
    const SESSION_KEYS = [
        'agent_models',
        'created_at',
        'created_tool_count',
        'created_tool_limit',
        'definition_revision',
        'endpoint',
        'harness',
        'id',
        'model',
        'pending_action_count',
        'revision',
        'runtime_execution',
        'status',
        'thread_count',
        'turn_count',
        'updated_at'
    ];

    it('creates, lists, reads, and deletes a session', async () => {
        const runtime = createRuntime();
        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'demo' });

        expect(created.status).toBe(201);
        expect(Object.keys(created.body).sort()).toEqual(['session']);
        expect(Object.keys(created.body.session).sort()).toEqual(SESSION_KEYS);

        const session = created.body.session;
        expect(session.harness).toBe('demo');
        expect(session.status).toBe('idle');
        expect(session.model).toBe('demo-model');
        expect(session.agent_models).toEqual({ general: 'demo-model' });
        expect(session.endpoint).toEqual({ base_url: SETTINGS.baseURL, model: 'demo-model', has_api_key: true });
        expect(session.runtime_execution).toBe('inline');
        expect(session.created_at).toBe(session.updated_at);
        // Counters, not content: a fresh session has run nothing.
        expect(session.turn_count).toBe(0);
        expect(session.thread_count).toBe(0);
        expect(session.pending_action_count).toBe(0);
        expect(session.created_tool_count).toBe(0);
        expect(session.created_tool_limit).toBe(HARNESS_SERVICE_LIMITS.created_tools);
        // `title` is absent until someone sets one, and no turn/message/definition rides the row.
        expect('title' in session).toBe(false);
        expect('turns' in session).toBe(false);
        expect('messages' in session).toBe(false);
        expect('harnessDefinition' in session).toBe(false);
        // The create response is a receipt: the epoch AND the row revision are both stamped.
        expect(created.headers).toEqual({ 'X-Harness-Epoch': runtime.events.epoch, 'X-Harness-Revision': String(session.revision) });

        const list = await call(runtime, 'GET', HARNESS_ROUTES.sessions());
        expect(list.status).toBe(200);
        expect(Object.keys(list.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        // A list row is a strict subset of the resource: identity + counters, nothing else.
        expect(Object.keys(list.body.items[0]).sort()).toEqual([
            'created_at',
            'harness',
            'id',
            'model',
            'revision',
            'status',
            'thread_count',
            'turn_count',
            'updated_at'
        ]);
        expect(list.body.items.map((row: any) => row.id)).toEqual([session.id]);
        expect(list.body.limit).toBe(1);

        // A trailing slash is the collection route, not a 404 with an empty id.
        const trailing = await call(runtime, 'GET', `${HARNESS_ROUTES.sessions()}/`);
        expect(trailing.status).toBe(200);
        expect(trailing.body.items.map((row: any) => row.id)).toEqual([session.id]);

        const read = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionId(session.id));
        expect(read.status).toBe(200);
        expect(read.body.session).toEqual(session);

        const removed = await callWithHeaders(runtime, 'DELETE', HARNESS_ROUTES.sessionsBySessionId(session.id));
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            session_id: session.id,
            aborted_turns: 0,
            dropped_queued_tasks: 0
        });
        // A delete receipt is stamped with both contract headers; WHICH revision the hub landed on
        // is the hub's own number, so it is compared to the hub rather than guessed here.
        expect(Object.keys(removed.headers ?? {}).sort()).toEqual(['X-Harness-Epoch', 'X-Harness-Revision']);

        const missing = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionId(session.id));
        expect(missing).toEqual({
            status: 404,
            body: { error: { message: `Unknown session "${session.id}".` } }
        });
    });

    it('refuses a bad limit and a stale cursor by naming the parameter', async () => {
        const runtime = createRuntime();
        await createDemo(runtime);
        await createDemo(runtime);

        const first = await call(runtime, 'GET', HARNESS_ROUTES.sessions(), {}, { limit: '1' });
        expect(first.body.items).toHaveLength(1);
        expect(first.body.limit).toBe(1);
        expect(first.body.next_cursor).toEqual(expect.any(String));

        const second = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.sessions(),
            {},
            { limit: '1', cursor: first.body.next_cursor as string }
        );
        expect(second.body.items).toHaveLength(1);
        expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
        expect(second.body.next_cursor).toBeNull();

        expect(await call(runtime, 'GET', HARNESS_ROUTES.sessions(), {}, { limit: '0' })).toEqual({
            status: 400,
            body: { error: { message: `Query parameter "limit" must be an integer between 1 and ${HARNESS_PAGE_LIMIT.max}.` } }
        });
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessions(), {}, { cursor: 'not-a-cursor' })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Query parameter "cursor" is stale or foreign; restart from the first page.' } }
        });
    });

    it('reads the frozen definition, the roster, and the instruction the session runs', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);
        const call_ = canonicalCall(runtime);

        const definition = await readOk<{ definition: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdDefinition(session.id),
            200
        );

        expect(Object.keys(definition.definition).sort()).toEqual([
            'agents',
            'builtin',
            'core_tools',
            'current',
            'current_revision',
            'definition_revision',
            'description',
            'frozen_at',
            'name',
            'primary',
            'requires_endpoint',
            'revision',
            'session_id',
            'source_revision',
            'subagents',
            'title',
            'tools'
        ].sort());
        // The frozen copy names the card it was built from and stays behind the session id.
        expect(definition.definition.session_id).toBe(session.id);
        expect(definition.definition.name).toBe('demo');
        expect(definition.definition.title).toBe('Scripted fixture');
        expect(definition.definition.requires_endpoint).toBe(false);
        expect(definition.definition.tools).toEqual(['timeNow']);
        expect(definition.definition.core_tools).toEqual(['toolRequest', 'tasks']);
        expect(definition.definition.current).toBe(true);
        // `agent_models` rides the definition ONLY when the card held an override map; the
        // effective per-agent models are stated on the session resource, and attribution of what the
        // session was BUILT with stays here.
        expect(Object.hasOwn(definition.definition, 'agent_models')).toBe(false);

        // The roster states the model each member actually runs and whether its text is editable.
        const roster = await readOk<Record<string, any>>(call_, 'GET', HARNESS_ROUTES.sessionsBySessionIdAgents(session.id), 200);
        expect(Object.keys(roster).sort()).toEqual(['agents', 'revision', 'session_id', 'total']);
        expect(roster.total).toBe(1);
        expect(Object.keys(roster.agents[0]).sort()).toEqual([
            'agent_id',
            'deletable',
            'editable',
            'guidelines_count',
            'inherited_model',
            'instruction_chars',
            'instruction_source',
            'model',
            'origin',
            'profile',
            'restorable',
            'revision',
            'role'
        ].sort());
        expect(roster.agents[0]).toEqual({
            agent_id: 'general',
            profile: 'general',
            role: 'primary',
            origin: 'definition',
            model: 'demo-model',
            inherited_model: 'demo-model',
            instruction_source: 'catalogue',
            instruction_chars: joinedPrompt(GENERAL_IDENTITY, GENERAL_GUIDELINES).length,
            // `guidelines_count` is the seeded SYSTEM-ENTRY count of the agent's brain
            // (./api-reads.ts:927 `brain.instructions.length`), i.e. the joined-prompt invariant:
            // exactly ONE entry, never identity + guidelines as two. The guideline ARRAY itself is
            // one named read away and is asserted below.
            guidelines_count: 1,
            editable: true,
            deletable: false,
            restorable: false,
            revision: 0
        });

        // The one place the FULL joined prompt the model receives is answerable over REST: identity
        // and guidelines joined by the single documented rule, never two system messages.
        const instruction = await readOk<Record<string, any>>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentIdInstruction(session.id, 'general'),
            200
        );
        expect(Object.keys(instruction).sort()).toEqual(['agent_id', 'chars', 'guidelines', 'instruction', 'session_id', 'source']);
        expect(instruction.session_id).toBe(session.id);
        expect(instruction.agent_id).toBe('general');
        expect(instruction.source).toBe('catalogue');
        expect(instruction.instruction).toBe(joinedPrompt(GENERAL_IDENTITY, GENERAL_GUIDELINES));
        expect(instruction.chars).toBe(joinedPrompt(GENERAL_IDENTITY, GENERAL_GUIDELINES).length);
        expect(instruction.guidelines).toEqual(GENERAL_GUIDELINES);

        // The live toolbox is the session registry, budgeted, with no source text on a row.
        const tools = await readOk<Record<string, any>>(
            call_,
            'GET',
            `${HARNESS_ROUTES.sessionsBySessionIdTools(session.id)}?limit=100`,
            200
        );
        expect(Object.keys(tools).sort()).toEqual(['budget', 'items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(tools.budget).toEqual({ used: 0, limit: HARNESS_SERVICE_LIMITS.created_tools });
        // A row states the live session facts; the argument schema, the source TEXT, and any tool
        // result never ride it. `source_revision` rides only for a row with an installed revision,
        // and item[0] here (toolRegistry) is a source-registered tool - the bytes themselves are one
        // named route away.
        expect(Object.keys(tools.items[0]).sort()).toEqual([
            'declared',
            'description',
            'enabled',
            'group',
            'name',
            'origin',
            'protected',
            'session_bound',
            'session_id',
            'source_available',
            'source_revision',
            'tags',
            'visibility'
        ]);
        expect('parameters' in tools.items[0]).toBe(false);
        expect('source' in tools.items[0]).toBe(false);
    });

    it('retargets an agent model over HTTP and keeps the frozen definition', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);
        const path = HARNESS_ROUTES.sessionsBySessionId(session.id);

        expect(await callWithHeaders(runtime, 'PATCH', path, { agent_models: { general: '  next/model  ' } })).toEqual({
            status: 200,
            body: {
                session: {
                    ...session,
                    model: 'next/model',
                    updated_at: expect.any(Number),
                    revision: session.revision + 1,
                    agent_models: { general: 'next/model' }
                }
            },
            headers: { 'X-Harness-Epoch': runtime.events.epoch, 'X-Harness-Revision': String(session.revision + 1) }
        });

        // A reload reports the change, and no second session was made.
        const read = await call(runtime, 'GET', path);
        expect(read.body.session.model).toBe('next/model');
        expect(read.body.session.agent_models).toEqual({ general: 'next/model' });
        // Attribution of what the session was BUILT with did not move: the frozen copy carries no
        // override map, because the card had none.
        const definition = await call(runtime, 'GET', `${path}/definition`);
        expect(Object.hasOwn(definition.body.definition, 'agent_models')).toBe(false);

        const list = await call(runtime, 'GET', HARNESS_ROUTES.sessions());
        expect(list.body.items.map((row: any) => row.id)).toEqual([session.id]);
    });

    it('rejects invalid session patches without changing anything', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);
        const path = HARNESS_ROUTES.sessionsBySessionId(session.id);
        const patch = (body: unknown) => call(runtime, 'PATCH', path, body);

        // camelCase is not an alias: the request field is `agent_models`.
        expect(await patch({ agentModels: { general: 'x' } })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "agentModels". Allowed fields: agent_models, title.' } }
        });

        // The validator keeps its own wording (it names the map it knows internally), and the key
        // space is THIS session's harness.
        expect(await patch({ agent_models: { ghost: 'x' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels` names "ghost", which is not a member of this harness. Members: general.' } }
        });
        expect(await patch({ agent_models: { general: '   ' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.general` cannot be empty.' } }
        });
        expect(await patch({ agent_models: { general: 7 } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.general` must be a model id string.' } }
        });
        expect(await patch({ agent_models: ['general'] })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels` names "0", which is not a member of this harness. Members: general.' } }
        });
        expect(await patch({ model: 'sneaky/model' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "model". Allowed fields: agent_models, title.' } }
        });
        expect(await patch({ status: 'idle' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "status". Allowed fields: agent_models, title.' } }
        });
        expect(await patch({ agent_models: { general: 'ok/model' }, harness: 'instruct' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "harness". Allowed fields: agent_models, title.' } }
        });
        // A body that names no writable field is still a 400.
        expect(await patch({})).toEqual({
            status: 400,
            body: { error: { message: 'A patch must change at least one field.' } }
        });
        // A non-object body never reaches the route's field checks.
        expect(await patch([])).toEqual({
            status: 400,
            body: { error: { message: 'The request body must be a JSON object.' } }
        });

        // T34 replacement of the old "an empty map is not a silent success" 400: on the target
        // contract an empty map is a VALID patch that replaces nothing, so it answers 200 and the
        // live map is unchanged (the store's replace-with-no-entries is a no-op).
        const emptyMap = await patch({ agent_models: {} });
        expect(emptyMap.status).toBe(200);
        expect(emptyMap.body.session.agent_models).toEqual({ general: 'demo-model' });

        // Setting a rail label is the other writable field.
        const renamed = await patch({ title: 'Rail row' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.session.title).toBe('Rail row');

        // The method surface is documented, and an unknown id is a 404 before any validation (a
        // patch cannot leak which ids exist).
        expect(await call(runtime, 'PUT', path, { agent_models: {} })).toEqual({
            status: 405,
            // The 405 quotes the CONCRETE path the caller used (./api.ts:3870), not the template.
            body: { error: { message: `Use GET, PATCH, DELETE for /v1/harness/sessions/${session.id}.` } }
        });
        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.sessionsBySessionId('missing'), { agent_models: { general: 'ok/model' } })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown session "missing".' } }
        });

        // Every rejection above left the live session untouched apart from the two accepted writes.
        const after = await call(runtime, 'GET', path);
        expect(after.body.session.model).toBe('demo-model');
        expect(after.body.session.agent_models).toEqual({ general: 'demo-model' });
    });

    // The create body's `settings` block is the SAME snake_case contract as `POST /models`: the
    // route hands it to `settingsInputOf` (./api.ts:1972), whose allow-list is
    // `['base_url', 'api_key', 'model']` (./api.ts:544). camelCase is therefore an UNKNOWN field,
    // never a coerced alias, and `requireKnownFields` throws on the first offending key in body
    // order (./api.ts:505-508) - hence the message names `baseURL`, the first key sent.
    it('refuses a camelCase settings field on a create and creates no session', async () => {
        const runtime = createRuntime();

        const before = await call(runtime, 'GET', HARNESS_ROUTES.sessions());
        expect(before.status).toBe(200);
        expect(before.body.items).toEqual([]);

        // The exact spelling the browser UI used to send: `{ baseURL, apiKey, model }`.
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessions(), {
                harness: 'demo',
                settings: { baseURL: 'http://provider.test/v1', apiKey: 'sk', model: 'm1' }
            })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "baseURL". Allowed fields: base_url, api_key, model.' } }
        });

        // The refusal happens BEFORE `store.create` (./api.ts:1991), so no row appeared: the
        // collection is identical to the read taken above.
        const after = await call(runtime, 'GET', HARNESS_ROUTES.sessions());
        expect(after.status).toBe(200);
        expect(after.body.items).toEqual([]);
    });

    // The sibling positive: the snake_case spelling the validator accepts, so the settings reach
    // the session. `endpoint` is the key-free projection of the merged settings
    // (./api-reads.ts:149-153 reads `record.settings`), and `mergeSettings` takes the client's
    // base_url/model verbatim (./config.ts:419-420) with an explicit non-blank key winning
    // (./config.ts:441-446), so all three requested values are what comes back.
    it('creates a session from a snake_case settings block and names its base URL key-free', async () => {
        const runtime = createRuntime();

        const created = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), {
            harness: 'demo',
            settings: { base_url: 'http://provider.test/v1', api_key: 'client-key', model: 'm1' }
        });

        expect(created.status).toBe(201);
        expect(Object.keys(created.body).sort()).toEqual(['session']);
        expect(created.body.session.endpoint).toEqual({
            base_url: 'http://provider.test/v1',
            model: 'm1',
            has_api_key: true
        });
        // Presence, never the secret: the credential the body sent appears nowhere in the receipt.
        expect(JSON.stringify(created.body)).not.toContain('client-key');

        // The create really did land, unlike the camelCase refusal above.
        const list = await call(runtime, 'GET', HARNESS_ROUTES.sessions());
        expect(list.body.items.map((row: any) => row.id)).toEqual([created.body.session.id]);
    });

    it('maps validation and lookup failures to exact statuses', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessions(), {})).toEqual({
            status: 400,
            body: { error: { message: 'A session requires a harness name.' } }
        });
        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'nope' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "nope".' } }
        });
        // Legacy identifiers still resolve to the canonical harness - that is a registry alias, not
        // a wire alias, so the answer names the canonical card.
        const alias = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'researcher' });
        expect(alias.status).toBe(201);
        expect(alias.body.session.harness).toBe('research');

        const session = await createDemo(runtime);
        const tasks = HARNESS_ROUTES.sessionsBySessionIdTasks(session.id);

        expect(await call(runtime, 'POST', tasks, { input: '   ' })).toEqual({
            status: 400,
            body: { error: { message: 'A task cannot be empty.' } }
        });
        expect(await call(runtime, 'POST', tasks, { input: 7 })).toEqual({
            status: 400,
            body: { error: { message: 'A task must be a string.' } }
        });
        // The character budget is its own refusal, and it is a payload size (413), not a shape (400).
        const tooLong = await call(runtime, 'POST', tasks, { input: 'x'.repeat(HARNESS_SERVICE_LIMITS.input_chars + 1) });
        expect(tooLong).toEqual({
            status: 413,
            body: { error: { message: `A task cannot exceed ${HARNESS_SERVICE_LIMITS.input_chars} characters.` } }
        });
        // A submit names its own thread field in snake_case; the camelCase spelling is unknown.
        expect(await call(runtime, 'POST', tasks, { input: 'x', threadId: 'thread-1' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "threadId". Allowed fields: input, attachments, references, thread_id.' } }
        });
        expect(await call(runtime, 'POST', tasks, [])).toEqual({
            status: 400,
            body: { error: { message: 'The request body must be a JSON object.' } }
        });
        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks('missing'), { input: 'go' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown session "missing".' } }
        });
        expect(await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionId('not-a-session'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown session "not-a-session".' } }
        });
        // A turn id is session-scoped: an unknown one says which session was searched.
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(session.id, 'not-a-turn'))
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown turn "not-a-turn" in session "${session.id}".` } }
        });
    });
});
// Task submit, recorded history, and the lazy display reads.
//
// The contract's core exchange: `POST /sessions/{id}/tasks` answers 202 + `TaskReceipt` (never the
// mutated aggregate), and everything the old SSE body streamed is now a bounded, addressable read:
// one turn resource, one paged events collection, one compiled display tree, one step, one context
// block. Completion is proven the way any REST client proves it - by re-reading the turn - so this
// block has no dependency on a response body staying open.
describe('task submit and recorded history', () => {
    const runtime = createRuntime();

    // One scripted run, shared by the assertions below: the demo transport is deterministic, so the
    // recorded event stream is a fixed fixture rather than a race. Created once to keep the file's
    // wall-clock cost to one scripted run.
    const state: {
        sessionId: string;
        turnId: string;
        receipt: Record<string, any>;
        events: Array<{ index: number; at: number; event: Record<string, any> }>;
    } = {} as never;

    beforeAll(async () => {
        const call_ = canonicalCall(runtime);
        const session = await createDemo(runtime);
        state.sessionId = session.id;

        state.receipt = await submitTask(call_, session.id, { input: '  What time is it?  ' });
        state.turnId = state.receipt.turn_id;

        // Deterministic completion: poll the identified turn read until it settles.
        await waitForTurnStatus(call_, session.id, state.turnId, ['done']);
        state.events = (await allTurnEvents(call_, session.id, state.turnId)) as never;
    });

    it('answers a submit with a slim receipt and links, never the aggregate', async () => {
        const { receipt } = state;

        // A fresh submit on a second session, so the status/revision facts below are observed
        // against a session this block has not already mutated.
        const other = await createDemo(runtime);
        const fresh = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(other.id), {
            input: '  plan the thing  '
        });

        expect(fresh.status).toBe(202);
        expect(Object.keys(fresh.body).sort()).toEqual([
            'accepted_at',
            'links',
            'session_id',
            'session_revision',
            'status',
            'thread_id',
            'turn_id'
        ]);
        // Neither `session` nor `turn` rides a receipt: the stream and the bounded pages carry it.
        expect('session' in fresh.body).toBe(false);
        expect('turn' in fresh.body).toBe(false);
        expect(fresh.body.session_id).toBe(other.id);
        expect(fresh.body.status).toBe('queued');
        expect(fresh.body.turn_id).toEqual(expect.any(String));
        expect(fresh.body.thread_id).toBe('thread-1');
        expect(fresh.body.session_revision).toBe(runtime.events.getRevision('session', other.id));
        expect(fresh.body.links).toEqual({
            turn: `${MOUNT}/sessions/${other.id}/turns/${fresh.body.turn_id}`,
            turns: `${MOUNT}/sessions/${other.id}/turns`,
            thread: `${MOUNT}/sessions/${other.id}/threads/thread-1`,
            stream: `${MOUNT}/stream`
        });
        expect(fresh.headers).toEqual({
            'X-Harness-Epoch': runtime.events.epoch,
            'X-Harness-Revision': String(fresh.body.session_revision)
        });

        // The receipt's turn settles, and the submit TRIMMED the prompt exactly as the store's own
        // validation does. Completion is proven by re-reading the turn (deterministic polling), which
        // is the target replacement for "the SSE response body ended".
        const turn = await waitForTurnStatus(
            canonicalCall(runtime),
            other.id,
            fresh.body.turn_id,
            ['done']
        );
        expect(turn.status).toBe('done');
        expect(turn.prompt).toBe('plan the thing');
        expect(state.receipt.status).toBe('queued');
    });

    it('answers the lifecycle guards the stream used to imply', async () => {
        const call_ = canonicalCall(runtime);

        // A second submit while the first is still running is NOT a 409 on this contract: each
        // submit opens its own conversation and the pump runs them. This replaces the old
        // 'rejects a second run while the first is still open with 409' assertion.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const busy = createRuntime(SETTINGS, DEFAULTS, [gatedPreset(gate)]);
        const busySession = await call(busy, 'POST', HARNESS_ROUTES.sessions(), { harness: 'gated' });
        const busyId = busySession.body.session.id as string;

        const first = await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(busyId), { input: 'first' });
        expect(first.status).toBe(202);

        const running = await call(busy, 'GET', HARNESS_ROUTES.sessionsBySessionId(busyId));
        expect(running.body.session.status).toBe('running');

        const second = await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(busyId), { input: 'second' });
        expect(second.status).toBe(202);
        expect(second.body.thread_id).toBe('thread-2');
        expect(second.body.turn_id).not.toBe(first.body.turn_id);

        // A manual mutation, though, must not race a live turn: it writes harness state the running
        // transcript depends on. 409 is preserved for exactly that case.
        expect(
            await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(busyId, 'tasks'), {
                parameters: {}
            })
        ).toEqual({ status: 409, body: { error: { message: 'A task is running in this session; try again when it finishes.' } } });
        expect(
            await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(busyId, 'toolRequest'), {
                parameters: { names: ['timeNow'] }
            })
        ).toEqual({ status: 409, body: { error: { message: 'A task is running in this session; try again when it finishes.' } } });

        // A reset while a turn is in flight is refused rather than silently discarding it, while a
        // model retarget is allowed (it changes the next request, not the running one).
        expect(await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdReset(busyId), {})).toEqual({
            status: 409,
            body: { error: { message: 'Cancel the running task before resetting the session.' } }
        });

        const patched = await call(busy, 'PATCH', HARNESS_ROUTES.sessionsBySessionId(busyId), {
            agent_models: { gated: 'later/model' }
        });
        expect(patched.status).toBe(200);
        expect(patched.body.session.model).toBe('later/model');

        // Cancel is a real operation with an honest receipt: it names the turn it aborted.
        const cancelled = await call(busy, 'POST', HARNESS_ROUTES.sessionsBySessionIdCancel(busyId), {});
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.cancelled).toBe(true);
        expect(cancelled.body.session_id).toBe(busyId);
        expect(cancelled.body.active_turn_id).toBe(first.body.turn_id);
        expect(cancelled.body.dropped_queued_tasks).toBe(0);

        release();
        await busy.store.waitForIdle(busyId);

        const rows = await listTurns(canonicalCall(busy), busyId);
        expect(rows.items.map((row: any) => row.status)).toEqual(['cancelled', 'cancelled']);

        void call_;
    });

    it('reports the counters and the usage fold instead of a fat snapshot', async () => {
        const call_ = canonicalCall(runtime);
        const session = await readOk<{ session: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionId(state.sessionId),
            200
        );

        expect(session.session.status).toBe('idle');
        expect(session.session.turn_count).toBe(1);
        expect(session.session.thread_count).toBe(1);

        const usage = await readOk<Record<string, any>>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdUsage(state.sessionId),
            200
        );
        expect(Object.keys(usage).sort()).toEqual([
            'by_thread',
            'reported_turns',
            'revision',
            'session_id',
            'truncated',
            'turn_count',
            'usage'
        ]);
        expect(usage.turn_count).toBe(1);
        expect(usage.reported_turns).toBe(1);
        expect(usage.truncated).toBe(false);
        // This REPLACES the old frame-level running tally: the fold is the sum of the three
        // reported requests, per thread, computed by the read model instead of piggybacking frames.
        expect(usage.usage).toEqual({ input: 292, output: 104, total: 396 });
        expect(usage.by_thread).toEqual([{ thread_id: 'thread-1', usage: { input: 292, output: 104, total: 396 } }]);

        const turn = await readTurn(call_, state.sessionId, state.turnId);
        expect(Object.keys(turn).sort()).toEqual([
            'attachment_count',
            'event_count',
            'event_time_count',
            'id',
            'index',
            'prompt',
            'revision',
            'session_id',
            'started_at',
            'status',
            'steer_count',
            'thread_id',
            'thread_label',
            'updated_at',
            'usage'
        ]);
        expect(turn.session_id).toBe(state.sessionId);
        expect(turn.id).toBe(state.turnId);
        expect(turn.index).toBe(0);
        expect(turn.status).toBe('done');
        expect(turn.prompt).toBe('What time is it?');
        expect(turn.thread_id).toBe('thread-1');
        expect(turn.steer_count).toBe(0);
        expect(turn.attachment_count).toBe(0);
        // The turn carries the same figure the last event did, cached part included: the sum of all
        // three reported requests.
        expect(turn.usage).toEqual({ input: 292, output: 104, total: 396, cached: 168 });
        expect(turn.event_count).toBe(state.events.length);
        expect(turn.event_time_count).toBe(state.events.length);
    });

    it('pages every recorded event verbatim, paired with its recorded time', async () => {
        const call_ = canonicalCall(runtime);

        // The stream contract the old file pinned frame by frame survives as RECORDING truth: the
        // non-delta events still come out of the transport in this exact order.
        expect(state.events.map((row) => row.event.type).filter((type) => type !== 'text' && type !== 'reasoning')).toEqual([
            'start',
            'usage',
            'tool_call',
            // R3/F1: each tool-calling request closes with `attempt_commit` (a tool round never
            // gets a `done`).
            'attempt_commit',
            'tool_result',
            'usage',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'usage',
            'done'
        ]);
        expect(state.events).toHaveLength(177);

        // Rows are ordinals paired with times, in recorded order, and the index is the position -
        // that pairing is what the old `eventTimes` array meant, now stated per row.
        expect(state.events.map((row) => row.index)).toEqual(state.events.map((_, index) => index));
        expect(state.events.every((row) => typeof row.at === 'number' && row.at > 0)).toBe(true);
        expect(state.events.every((row, index) => index === 0 || row.at >= state.events[index - 1].at)).toBe(true);

        // Each `usage` EVENT is one request's own figures (the scripted numbers the old file
        // asserted off the SSE frames): 48/18/66, then 96/22/118, then 148/64/212.
        expect(state.events.filter((row) => row.event.type === 'usage').map((row) => row.event)).toEqual([
            { type: 'usage', agent: 'general', usage: { input: 48, output: 18, total: 66, cached: 0 }, thread: { id: '1' } },
            { type: 'usage', agent: 'general', usage: { input: 96, output: 22, total: 118, cached: 48 }, thread: { id: '1' } },
            { type: 'usage', agent: 'general', usage: { input: 148, output: 64, total: 212, cached: 120 }, thread: { id: '1' } }
        ]);

        // The scripted loop's discovery call, verbatim: the dispatcher must not reshape content.
        const discovery = state.events.find((row) => row.event.type === 'tool_result' && row.event.name === 'toolRequest');
        if (discovery === undefined) throw new Error('expected a recorded toolRequest result');
        expect(JSON.parse(discovery.event.content).enabled).toEqual([
            'timeNow',
            'actionRequest',
            'threadFork',
            'toolManage',
            'toolRegistry'
        ]);
        expect(discovery.event.isError).toBe(false);
        expect(discovery.event.outcome).toBe('completed');

        // R20.2: the declarative panels ride the SAME recorded event the stream used to carry them.
        const clock = state.events.find((row) => row.event.type === 'tool_result' && row.event.name === 'timeNow');
        if (clock === undefined) throw new Error('expected a recorded timeNow result');
        const clockValue = JSON.parse(clock.event.content) as { timezone: string; iso: string; unix: number };
        expect(clockValue.timezone).toBe('UTC');
        expect(clock.event.ui).toEqual([
            {
                id: 'timeNow',
                slot: 'right',
                title: 'Current time',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'Timezone', value: clockValue.timezone },
                            { label: 'ISO 8601', value: clockValue.iso },
                            { label: 'Unix', value: String(clockValue.unix) }
                        ]
                    },
                    { type: 'text', text: 'Read from the server clock at execution time.' }
                ]
            }
        ]);

        // One page at a time: `limit` echoes the returned rows, and the cursor continues the same
        // ordinals (no re-pairing, no gaps, no duplicates).
        const page = await readTurnEvents(call_, state.sessionId, state.turnId, { limit: 2 });
        expect(Object.keys(page).sort()).toEqual([
            'items',
            'limit',
            'next_cursor',
            'observed_at',
            'partial',
            'revision',
            'total_events',
            'turn_id'
        ]);
        expect(page.turn_id).toBe(state.turnId);
        expect(page.total_events).toBe(177);
        expect(page.partial).toBe(false);
        expect(page.limit).toBe(2);
        expect(page.items.map((row: any) => row.index)).toEqual([0, 1]);
        expect(typeof page.next_cursor).toBe('string');

        const next = await readTurnEvents(call_, state.sessionId, state.turnId, {
            limit: 2,
            cursor: page.next_cursor as string
        });
        expect(next.items.map((row: any) => row.index)).toEqual([2, 3]);

        // A page request the contract cannot honour names the parameter, and a cursor from another
        // epoch is refused rather than silently restarted.
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(state.sessionId, state.turnId), {}, { limit: '0' })
        ).toEqual({
            status: 400,
            body: { error: { message: `Query parameter "limit" must be an integer between 1 and ${HARNESS_PAGE_LIMIT.max}.` } }
        });
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(state.sessionId, state.turnId), {}, { cursor: 'not-a-cursor' })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Query parameter "cursor" is stale or foreign; restart from the first page.' } }
        });
    });

    it('pages turn history as bounded previews, in order or reversed', async () => {
        const call_ = canonicalCall(runtime);

        // A second turn on the SAME session, so ordering is a fact rather than a single row.
        const receipt = await submitTask(call_, state.sessionId, { input: 'And again?' });
        await waitForTurnStatus(call_, state.sessionId, receipt.turn_id, ['done']);

        const page = await listTurns(call_, state.sessionId);
        expect(Object.keys(page).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);
        expect(page.items.map((row: any) => row.index)).toEqual([0, 1]);
        // A row states the EXACT recorded length next to a bounded preview, and counts instead of
        // content: the old snapshot copy of every turn is what this read replaces.
        expect(page.items.map((row: any) => row.promptPreview)).toEqual(['What time is it?', 'And again?']);
        expect(page.items.map((row: any) => row.promptChars)).toEqual([16, 10]);
        expect(page.items.map((row: any) => row.status)).toEqual(['done', 'done']);
        expect(page.items.map((row: any) => row.threadId)).toEqual(['thread-1', 'thread-2']);
        for (const row of page.items) {
            expect('events' in row).toBe(false);
            expect('eventTimes' in row).toBe(false);
            expect('steerTexts' in row).toBe(false);
            // `activeAgents` names agents whose run is IN FLIGHT; a settled row states none.
            expect(row.activeAgents).toEqual([]);
        }
        expect(page.items[0].stepCount).toBe(2);
        expect(page.items[0].sectionCount).toBe(1);
        expect(page.items[0].detail).toBe('demo-model');

        const reversed = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurns(state.sessionId), {}, { order: 'desc' });
        expect(reversed.body.items.map((row: any) => row.index)).toEqual([1, 0]);

        // The session counters moved with the second turn, and the fold covers both threads.
        const session = await readOk<{ session: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionId(state.sessionId),
            200
        );
        expect(session.session.turn_count).toBe(2);
        expect(session.session.thread_count).toBe(2);

        const usage = await readOk<Record<string, any>>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdUsage(state.sessionId),
            200
        );
        expect(usage.turn_count).toBe(2);
        expect(usage.reported_turns).toBe(2);
        expect(usage.usage).toEqual({ input: 584, output: 208, total: 792 });
        expect(usage.by_thread).toEqual([
            { thread_id: 'thread-1', usage: { input: 292, output: 104, total: 396 } },
            { thread_id: 'thread-2', usage: { input: 292, output: 104, total: 396 } }
        ]);
    });

    it('serves the lazy display tree and its two detail reads', async () => {
        const call_ = canonicalCall(runtime);

        // The compiled display tree (the old `/views` frame, now one named read per turn).
        const display = await readDisplay(call_, state.sessionId, state.turnId);
        expect(Object.keys(display).sort()).toEqual(['revision', 'sections', 'turnId']);
        expect(display.turnId).toBe(state.turnId);
        expect(display.revision).toBe(runtime.events.getRevision('turn', `${state.sessionId}:${state.turnId}`));
        expect(display.sections).toHaveLength(1);

        const section = display.sections[0];
        expect(Object.keys(section).sort()).toEqual([
            'agent',
            'agentLabel',
            'answerNodeId',
            'cachedInput',
            'context',
            'endedAt',
            'id',
            'invocationId',
            'latestInput',
            'model',
            'nodes',
            'role',
            // R9: the compiled tree now also states WHEN the flow started (a field the
            // contract already declared — see `TurnSection.startedAt`). Without it every
            // delegate row hides its elapsed label, because the client settles a row's
            // span from this pair only. The exact stamps are pinned in
            // ./turn-projector.test.ts (`section timing (R9)`); the canonical flow records
            // with a wall clock, so all this route-level probe can state is that BOTH
            // endpoints are on the wire and ordered.
            'startedAt',
            'state',
            'tail',
            'threadId',
            'threadLabel'
        ]);
        expect(section.agent).toBe('general');
        expect(section.role).toBe('primary');
        expect(section.state).toBe('done');
        expect(section.startedAt).toBeLessThan(section.endedAt);
        expect(section.model).toBe('demo-model');
        expect(section.threadLabel).toBe('GL1');
        expect(section.id).toBe(`${state.turnId}:0`);

        // One context block: the segment with its recorded text, one hop from the tree.
        const block = await readBlockDetail(call_, state.sessionId, state.turnId, section.context[0].id);
        expect(Object.keys(block).sort()).toEqual([
            'at',
            'chars',
            'entries',
            'id',
            'inPrompt',
            'kind',
            'name',
            'sectionId',
            'sessionId',
            'turnId'
        ].sort());
        expect(block.kind).toBe('system');
        expect(block.name).toBe('instructions');
        expect(block.turnId).toBe(state.turnId);
        expect(block.sectionId).toBe(`${state.turnId}:0`);
        expect(block.sessionId).toBe(state.sessionId);
        expect(block.inPrompt).toBe(true);
        // The stored system segment IS the joined prompt, byte for byte.
        expect(block.entries).toEqual([joinedPrompt(GENERAL_IDENTITY, GENERAL_GUIDELINES)]);
        expect(block.chars).toBe(joinedPrompt(GENERAL_IDENTITY, GENERAL_GUIDELINES).length);

        // One step: the recorded tool_call ordinal paired with its result event - the two verbatim
        // rows behind a display step.
        const toolCallIndex = state.events.find((row) => row.event.type === 'tool_call')!.index;
        const toolResultIndex = state.events.find((row) => row.event.type === 'tool_result')!.index;
        const step = await readStepDetail(call_, state.sessionId, state.turnId, String(toolCallIndex));
        expect(Object.keys(step).sort()).toEqual([
            'callId',
            'opening',
            'result',
            'sectionId',
            'sessionId',
            'stepId',
            'turnId'
        ]);
        expect(step.stepId).toBe(String(toolCallIndex));
        expect(step.turnId).toBe(state.turnId);
        expect(step.sectionId).toBe(`${state.turnId}:0`);
        expect(step.callId).toBe('call_tool_request_1');
        expect(step.opening).toEqual({
            index: toolCallIndex,
            at: expect.any(Number),
            event: {
                type: 'tool_call',
                agent: 'general',
                call: { id: 'call_tool_request_1', name: 'toolRequest', arguments: '{"tags":["time"]}' },
                thread: { id: '1' }
            }
        });
        expect(step.result.index).toBe(toolResultIndex);
        expect(step.result.event.type).toBe('tool_result');
        expect(step.result.event.name).toBe('toolRequest');
        expect(step.result.event.isError).toBe(false);

        // A step id is the OPENING ordinal only, and it must parse: a result index is 404 and prose
        // is 400, both naming the rule.
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdStepsByStepId(state.sessionId, state.turnId, String(toolResultIndex)))
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown step "${toolResultIndex}" in turn "${state.turnId}".` } }
        });
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdStepsByStepId(state.sessionId, state.turnId, 'not-a-number'))
        ).toEqual({
            status: 400,
            body: { error: { message: 'A step id must be the recorded event index of the step.' } }
        });
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdBlocksByBlockId(state.sessionId, state.turnId, 'nope'))
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown context block "nope" in turn "${state.turnId}".` } }
        });
        expect(
            await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId(state.sessionId, state.turnId, 'nope'))
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown attachment "nope" in session "${state.sessionId}".` } }
        });
    });

    it('resets and cancels with receipts, not with a copied session', async () => {
        const call_ = canonicalCall(runtime);
        const sessionId = state.sessionId;

        const reset = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdReset(sessionId), {});

        expect(reset.status).toBe(200);
        expect(Object.keys(reset.body).sort()).toEqual([
            'discarded_threads',
            'discarded_turns',
            'dropped_queued_tasks',
            'reset',
            'revision',
            'session_id'
        ]);
        expect(reset.body).toEqual({
            reset: true,
            session_id: sessionId,
            // A reset discards the two turns and the two conversations the block built.
            discarded_turns: 2,
            discarded_threads: 2,
            dropped_queued_tasks: 0,
            revision: expect.any(Number)
        });

        // The history really went away, and the counters on the row say so without a child read.
        expect((await listTurns(call_, sessionId)).items).toEqual([]);

        const counters = await readOk<{ session: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionId(sessionId),
            200
        );
        expect(counters.session.turn_count).toBe(0);
        expect(counters.session.thread_count).toBe(0);

        // Cancelling an idle session did not abort anything, and says so.
        const cancelled = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdCancel(sessionId), {});
        expect(cancelled).toEqual({
            status: 200,
            body: {
                cancelled: false,
                session_id: sessionId,
                dropped_queued_tasks: 0,
                revision: expect.any(Number)
            }
        });
    });
});
// Manual tool execution, and the two gates that decide WHICH route may run a tool.
//
// Replaces the old 'all-tools manual execution' block. The catalogue listing no longer carries the
// execution answer: the DETAIL read does, via `execution: { scope, manual }`, and the routes honour
// it - `global` runs at `POST /tools/{id}/executions`, `session_required` answers 403 there (a
// policy refusal, not an absence) and runs at `POST /sessions/{id}/tools/{id}/executions`. A call
// that executed and failed is 200 `ok:false`; a call the server cannot make is an HTTP status.
describe('manual tool execution', () => {
    it('runs a catalogue tool globally with its declarative panels', async () => {
        const runtime = createRuntime();

        const result = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'), {
            parameters: 'UTC'
        });

        expect(result.status).toBe(200);
        // `durationMs` became `duration_ms`; the payload itself is the tool's own camelCase value.
        expect(Object.keys(result.body).sort()).toEqual(['duration_ms', 'ok', 'panels', 'result']);
        expect(result.body.ok).toBe(true);

        const value = result.body.result as { timezone: string; iso: string; unix: number };
        expect(value.timezone).toBe('UTC');
        expect(value.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Number.isInteger(value.unix)).toBe(true);
        expect(result.body.panels).toEqual([
            {
                id: 'timeNow',
                slot: 'right',
                title: 'Current time',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'Timezone', value: value.timezone },
                            { label: 'ISO 8601', value: value.iso },
                            { label: 'Unix', value: String(value.unix) }
                        ]
                    },
                    { type: 'text', text: 'Read from the server clock at execution time.' }
                ]
            }
        ]);

        // T34 replacement of the old "a tool call requires a parameters property" 400: the contract
        // declares `parameters` OPTIONAL, so an absent field IS the empty argument box (exactly
        // `{"parameters": {}}`, ./api.ts:1809) and timeNow's documented default label answers.
        expect((await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'), {})).status).toBe(200);
        const emptyBox = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'), {
            parameters: {}
        });
        expect(emptyBox.status).toBe(200);
        expect((emptyBox.body.result as { timezone: string }).timezone).toBe('UTC');

        // Only POST is mounted on an execution collection.
        expect(await call(runtime, 'GET', HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'))).toEqual({
            status: 405,
            body: { error: { message: 'Use POST for /v1/harness/tools/timeNow/executions.' } }
        });
    });

    it('unwraps tool media into a descriptor list for a manual download', async () => {
        const runtime = createRuntime();

        // `download` now also saves to disk, resolved against the process working
        // directory. This test passes an explicit UNIQUE path rather than chdir-ing:
        // process.chdir() is process-global while vitest runs files concurrently, and
        // a fixed name would also make the expected path depend on how many times the
        // suite has already run (the no-clobber rule appends a suffix to a taken name).
        const scratchName = `api-download-${randomUUID()}.png`;

        // A real PNG header so the shared magic-signature check passes, served with an explicit
        // content-length so the pre-check path is exercised.
        const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                const headers = new Headers();
                headers.set('content-type', 'image/png');
                headers.set('content-length', String(png.length));

                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(Uint8Array.from(png));
                            controller.close();
                        }
                    }),
                    { status: 200, headers }
                );
            })
        );

        try {
            const { status, body } = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('download'), {
                // `download` declares two properties, so the whole object is handed to execute
                // (the single-property rule does not apply).
                parameters: { url: 'https://files.test/img/pixel.png', path: scratchName }
            });

            expect(status).toBe(200);
            expect(Object.keys(body).sort()).toEqual(['duration_ms', 'media', 'ok', 'result']);
            expect(body.result).toEqual({
                url: 'https://files.test/img/pixel.png',
                finalUrl: 'https://files.test/img/pixel.png',
                contentType: 'image/png',
                kind: 'image',
                name: 'pixel.png',
                bytes: 12,
                declaredBytes: 12,
                media: 'attached',
                mediaId: 'dl-1',
                // The disk copy the file tools can reach, at the requested path.
                saved: true,
                path: scratchName,
                searchable: false
            });
            expect(existsSync(join(process.cwd(), scratchName))).toBe(true);
            expect(body.media).toEqual([{ id: 'dl-1', kind: 'image', name: 'pixel.png', mime: 'image/png', size: 12 }]);

            // The payload itself stays out of the HTTP body: 12 bytes of PNG are `iVBORw0KGgoBAgME`
            // in canonical base64, and a manual call has no transcript to attach bytes to.
            expect(JSON.stringify(body)).not.toContain('iVBORw0KGgoBAgME');
            expect(typeof body.duration_ms).toBe('number');
            // The scratch file lives in the working directory; remove it so the run
            // leaves nothing behind.
            rmSync(join(process.cwd(), scratchName), { force: true });
        } finally {
            // This file's afterEach only unstubs envs; a leaked global fetch would break the model
            // and download tests that run after this one.
            vi.unstubAllGlobals();
        }
    });

    it('runs a bounded listing and a bounded read page from a real fixture', async () => {
        const runtime = createRuntime();
        const fixture = await createFixture('harness-list-api-');

        try {
            await mkdir(join(fixture, 'src', 'nested'), { recursive: true });
            await mkdir(join(fixture, 'tasks'), { recursive: true });
            await writeTextFile(join(fixture, 'src', 'a.ts'), 'a\n', 'utf8');
            await writeTextFile(join(fixture, 'tasks', 'b.ts'), 'b\n', 'utf8');

            // The direct runner applies the same single-property rule as the harness: `parameters`
            // IS the value of "ops", not a wrapper object (./api.ts resolveToolParameters).
            const listed = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('files'), {
                parameters: [{ op: 'list', path: [join(fixture, 'src'), join(fixture, 'tasks')] }]
            });

            // Absolute inputs keep their absolute prefix, posix-normalized, and the directory order
            // is the caller's: src (with its child) then tasks. The answer is one bounded PAGE, and
            // its cursor lives inside the `list` entry's own receipt.
            const expectedEntries = [
                `${posix(fixture)}/src/a.ts`,
                `${posix(fixture)}/src/nested/`,
                `${posix(fixture)}/tasks/b.ts`
            ];
            const expectedBytes = expectedEntries.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8'), 0);

            expect(listed.body).toEqual({
                ok: true,
                result: {
                    results: [
                        {
                            op: 'list',
                            path: `${posix(fixture)}/src`,
                            entries: expectedEntries,
                            truncated: false,
                            nextOffset: null,
                            offset: 0,
                            limit: 200,
                            bytes: expectedBytes
                        }
                    ],
                    bytes: expectedBytes,
                    contentBudget: 64 * 1024
                },
                duration_ms: expect.any(Number)
            });

            // The schema-wrapper spelling means the same request (both documented shapes resolve
            // through the shared validator in 'direct' mode).
            const wrapped = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('files'), {
                parameters: { ops: [{ op: 'list', path: join(fixture, 'tasks') }] }
            });
            const wrappedEntry = `${posix(fixture)}/tasks/b.ts`;
            expect(wrapped.body).toEqual({
                ok: true,
                result: {
                    results: [
                        {
                            op: 'list',
                            path: `${posix(fixture)}/tasks`,
                            entries: [wrappedEntry],
                            truncated: false,
                            nextOffset: null,
                            offset: 0,
                            limit: 200,
                            bytes: Buffer.byteLength(wrappedEntry, 'utf8')
                        }
                    ],
                    bytes: Buffer.byteLength(wrappedEntry, 'utf8'),
                    contentBudget: 64 * 1024
                },
                duration_ms: expect.any(Number)
            });

            // A missing directory is reported IN PLACE on the list entry (the same rule
            // `read` publishes), so the call still answers 200 + ok:true: a read-only miss
            // never throws away operations that already succeeded. `fileList` used to fail
            // the whole call here; `files` says which entry failed and why.
            const missing = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('files'), {
                parameters: [{ op: 'list', path: [join(fixture, 'src'), join(fixture, 'nope')] }]
            });
            expect(missing.status).toBe(200);
            expect(missing.body.ok).toBe(true);
            expect(missing.body.result.results[0].error.code).toBe('ENOENT');

            // `read` with a number where an array of paths belongs is a schema failure reported as
            // a tool error, never an implementation crash.
            const wrong = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('read'), { parameters: 7 });
            expect(wrong).toEqual({
                status: 200,
                body: { ok: false, error: { message: '$.paths must be of type array.' }, duration_ms: expect.any(Number) }
            });

            // A real one-file read, exactly bounded by the tool's own budget report. 'core file' is
            // one unterminated line of 9 UTF-8 bytes, so every figure below is derivable.
            const path = join(fixture, 'note.txt');
            await writeTextFile(path, 'core file', 'utf8');

            const read = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('read'), { parameters: [path] });
            expect(read.body).toEqual({
                ok: true,
                result: {
                    files: [
                        {
                            path,
                            content: 'core file',
                            startLine: 1,
                            endLine: 1,
                            truncated: false,
                            limit: null,
                            startByteAligned: null,
                            nextLine: null,
                            nextColumn: null,
                            nextByte: null,
                            bytes: 9,
                            sizeBytes: 9
                        }
                    ],
                    truncated: false,
                    bytes: 9,
                    // wireBytes is the serialized length of the response, which embeds
                    // the absolute fixture path, so it is matched rather than hardcoded.
                    wireBytes: expect.any(Number),
                    contentBudget: 262144,
                    skipped: 0
                },
                duration_ms: expect.any(Number)
            });
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('bounds a huge manual result with the shared cap instead of returning it verbatim', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // A tool with NO budget of its own. This used to be tested through `read`, but
        // read now bounds itself at exactly the wire cap and measures that budget on
        // the serialized form, so a read result can never overflow the envelope —
        // which is the point of the change. The shared cap is therefore a BACKSTOP for
        // tools that do not bound themselves, and that is what is exercised here.
        const registered = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTools(session.id), {
            name: 'dump',
            description: 'Return an unbounded string.',
            tags: ['text'],
            source: 'return "z".repeat(300000);'
        });
        expect(registered.status).toBe(201);

        const executed = await call(
            runtime,
            'POST',
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(session.id, 'dump'),
            { parameters: {} }
        );

        expect(executed.status).toBe(200);
        expect(executed.body.ok).toBe(true);

        // `boundToolValue` (./api.ts) cuts the serialized value with `boundToolResult`
        // and re-parses the envelope, so the HTTP body stays valid JSON while the
        // beginning AND the end of the tool's own text survive inside it (T5.1). The
        // manual route has no transcript call to name, so the note says only
        // "the tool call" — and it still tells the client what was cut.
        const bounded = executed.body.result as {
            truncated: boolean;
            originalBytes: number;
            budgetBytes: number;
            note: string;
            content: string;
            tail: string;
        };

        expect(Object.keys(bounded).sort()).toEqual([
            'budgetBytes',
            'content',
            'note',
            'originalBytes',
            'tail',
            'truncated'
        ]);
        expect(bounded.truncated).toBe(true);
        expect(bounded.budgetBytes).toBe(HARNESS_SERVICE_LIMITS.tool_result_bytes);
        expect(bounded.originalBytes).toBe(300_000);
        expect(bounded.content.startsWith('zzz')).toBe(true);
        expect(bounded.tail.endsWith('zzz')).toBe(true);
        expect(bounded.note).toBe(
            "Cut 64071 of 300000 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it."
        );

        // The envelope itself fits the published cap, which is the guarantee a client
        // relies on when it reads `tool_result_bytes` from the boot document.
        expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
            HARNESS_SERVICE_LIMITS.tool_result_bytes
        );
    });

    it('returns a full-budget read result verbatim, without the envelope', async () => {
        // The other half of the change above, and the regression this file pins. A
        // read that fills its own budget must arrive UNWRAPPED: previously read
        // measured 64 KiB of RAW content while the cap measured 64 KiB of SERIALIZED
        // JSON, so escaping (2-15%) always pushed it over and the envelope destroyed
        // nextLine/nextColumn — the fields the caller needs in order to continue.
        const runtime = createRuntime();
        const fixture = await createFixture('harness-fullbudget-api-');

        try {
            const path = join(fixture, 'big.txt');
            await writeTextFile(path, 'x'.repeat(300_000), 'utf8');

            const read = await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('read'), {
                parameters: [path]
            });

            expect(read.status).toBe(200);
            expect(read.body.ok).toBe(true);

            // The tool's own object, not the envelope: no budgetBytes/content keys.
            // `note` is the large-file advisory (R4, ./tools/files/read.tool.ts): a
            // 300 000-byte file cut by the envelope is exactly the case it exists for,
            // and its bytes are reserved before the split, so it joins the key set here
            // without moving the response over the cap (the assertion below).
            const result = read.body.result as Record<string, unknown>;
            expect(Object.keys(result).sort()).toEqual([
                'bytes',
                'contentBudget',
                'files',
                'note',
                'skipped',
                'truncated',
                'wireBytes'
            ]);

            expect(result.note).toContain('is 300000 bytes');

            // And the continuation fields survived, which is the whole point.
            const entry = (result.files as Record<string, unknown>[])[0];
            expect(entry.truncated).toBe(true);
            expect(entry.nextLine).toBe(1);
            expect(entry.nextByte).toBeGreaterThan(0);
            expect(result.wireBytes).toBeLessThanOrEqual(HARNESS_SERVICE_LIMITS.tool_result_bytes);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('refuses a session-bound tool at the global route, and states the route that serves it', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('toolRequest'), { parameters: {} })).toEqual({
            status: 403,
            body: {
                error: {
                    message:
                        'Tool "toolRequest" runs inside a session; call it through /v1/harness/sessions/{session_id}/tools/toolRequest/executions.'
                }
            }
        });
        expect(await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('tasks'), { parameters: {} })).toEqual({
            status: 403,
            body: {
                error: {
                    message: 'Tool "tasks" runs inside a session; call it through /v1/harness/sessions/{session_id}/tools/tasks/executions.'
                }
            }
        });

        // The global body has ONE field: the old `sessionId` channel is gone, and a stale spelling
        // is refused rather than ignored (the session belongs in the PATH).
        expect(await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('tasks'), { parameters: {}, session_id: 'x' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "session_id". Allowed fields: parameters.' } }
        });

        // Absence is a 404 at either route, with the wording that says WHICH namespace failed.
        expect(await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('nope'), { parameters: {} })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown tool "nope".' } }
        });

        const session = await createDemo(runtime);
        expect(
            await call(
                runtime,
                'POST',
                HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(session.id, 'nope'),
                { parameters: {} }
            )
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown tool "nope" in session "${session.id}".` } }
        });
        // A harness-owned row the session's own harness never registered answers the same way.
        expect(
            await call(
                runtime,
                'POST',
                HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(session.id, 'delegate'),
                { parameters: { agent: 'helper', input: 'go' } }
            )
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown tool "delegate" in session "${session.id}".` } }
        });
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions('missing', 'tasks'), {
                parameters: {}
            })
        ).toEqual({ status: 404, body: { error: { message: 'Unknown session "missing".' } } });
    });

    it('runs harness control tools against the named session and changes that session', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);
        const executions = (tool: string) =>
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(session.id, tool);

        const discovered = await call(runtime, 'POST', executions('toolRequest'), {
            parameters: { names: ['timeNow'] }
        });

        expect(discovered.status).toBe(200);
        expect(discovered.body).toEqual({
            ok: true,
            result: {
                enabled: ['timeNow'],
                tools: [
                    {
                        name: 'timeNow',
                        description:
                            'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
                        tags: ['time', 'clock', 'date']
                    }
                ],
                matched: 1,
                omitted: 0
            },
            duration_ms: expect.any(Number)
        });
        // The SESSION changed, not a detached catalogue: the store is the oracle behind the toolbox
        // read (./canonical-reads.test-support.ts header: the store stays reachable in a test).
        expect(runtime.store.get(session.id).discoveredTools).toEqual(['timeNow']);

        const added = await call(runtime, 'POST', executions('tasks'), {
            parameters: { tasks: [{ text: '  check bounds ' }] }
        });
        // T1 shape of the SAME result (src/core/task.ts project + copyItem): every
        // record carries its content `rev` (1 on add) and the write attribution, and
        // the envelope carries the monotonic `storeRev`. An execution route runs as the
        // session PRIMARY ("general") with NO thread, so `updatedBy` is set and
        // `updatedThreadId` stays absent — never `undefined`.
        //
        // This file deliberately never pins the wall clock (unlike ./sessions.test.ts),
        // so `updatedAt` is asserted BY SHAPE here and BY IDENTITY in the read below:
        // the follow-up call must report the very same instant.
        expect(added.body).toEqual({
            ok: true,
            result: {
                tasks: [
                    {
                        id: '1',
                        text: 'check bounds',
                        completed: false,
                        rev: 1,
                        updatedBy: 'general',
                        updatedAt: expect.any(String)
                    }
                ],
                counts: { total: 1, completed: 0, pending: 1 },
                // R9-R11: every successful task call returns the current bounded page.
                page: { offset: 0, limit: 20, hasMore: false },
                storeRev: 1,
                // R1/T1.1 — this POST affected exactly ONE record, so the same record
                // answers beside the page. `updatedAt` is matched BY SHAPE here exactly
                // like the page entry above, and by IDENTITY in the read below.
                entry: {
                    id: '1',
                    text: 'check bounds',
                    completed: false,
                    rev: 1,
                    updatedBy: 'general',
                    updatedAt: expect.any(String)
                }
            },
            duration_ms: expect.any(Number)
        });

        // The shape check above is not enough on its own: the value must be the exact
        // ISO instant the store wrote, which is what the next call re-reads.
        const writtenAt = (
            added.body as { result: { tasks: { updatedAt: string }[] } }
        ).result.tasks[0].updatedAt;

        expect(new Date(writtenAt).toISOString()).toBe(writtenAt);

        // A second call sees the SAME list: the tool lives in the session harness. The
        // read is not a write, so rev, attribution and storeRev are all unchanged.
        const listed = await call(runtime, 'POST', executions('tasks'), { parameters: {} });
        expect(listed.body).toEqual({
            ok: true,
            result: {
                tasks: [
                    {
                        id: '1',
                        text: 'check bounds',
                        completed: false,
                        rev: 1,
                        updatedBy: 'general',
                        updatedAt: writtenAt
                    }
                ],
                counts: { total: 1, completed: 0, pending: 1 },
                page: { offset: 0, limit: 20, hasMore: false },
                storeRev: 1
            },
            duration_ms: expect.any(Number)
        });

        // A catalogue tool through the named session needs no enabling, and does not enable itself.
        const clock = await call(runtime, 'POST', executions('timeNow'), { parameters: 'UTC' });
        expect(clock.status).toBe(200);
        expect((clock.body.result as { timezone: string }).timezone).toBe('UTC');
        expect(runtime.store.get(session.id).discoveredTools).toEqual(['timeNow']);

        // A multi-property tool with NO argument box is a readable tool error, not a 400: the
        // session route forwards the box verbatim and the schema decides.
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(session.id, 'toolCreate'), {})
        ).toEqual({
            status: 200,
            body: { ok: false, error: { message: '$ must be of type object.' }, duration_ms: expect.any(Number) }
        });
    });

    it('creates a tool through the session registration kernel and isolates it', async () => {
        const runtime = createRuntime();
        const call_ = canonicalCall(runtime);
        const owner = await createDemo(runtime);
        const sibling = await createDemo(runtime);

        const registered = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTools(owner.id), {
            name: 'shout',
            description: 'Uppercase a string.',
            tags: ['text'],
            // `source` is the BODY of an async function taking (args, context).
            source: 'return String(args ?? "").toUpperCase();'
        });

        expect(registered.status).toBe(201);
        // The receipt is metadata only: no source text, no schema, no result.
        expect(Object.keys(registered.body.registration).sort()).toEqual([
            'budget',
            'checks',
            'created',
            'name',
            'replaced',
            'source_revision'
        ]);
        expect(registered.body.registration.name).toBe('shout');
        expect(registered.body.registration.created).toBe(true);
        expect(registered.body.registration.replaced).toBe(false);
        expect(registered.body.registration.budget).toEqual({
            used: 1,
            limit: HARNESS_SERVICE_LIMITS.created_tools
        });

        // The bytes live on their own route, and quote the revision the receipt reported.
        const source = await readOk<Record<string, any>>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdSource(owner.id, 'shout'),
            200
        );
        expect(Object.keys(source).sort()).toEqual(['name', 'revision', 'session_id', 'source']);
        expect(source.session_id).toBe(owner.id);
        expect(source.name).toBe('shout');
        expect(source.revision).toBe(registered.body.registration.source_revision);
        expect(source.source).toBe('return String(args ?? "").toUpperCase();');

        // The detail read is the toolbox row PLUS the schema and the execution gate.
        const detail = await readOk<{ tool: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolId(owner.id, 'shout'),
            200
        );
        expect(detail.tool).toEqual({
            name: 'shout',
            group: 'Created tools',
            description: 'Uppercase a string.',
            tags: [],
            visibility: 'searchable',
            session_bound: false,
            session_id: owner.id,
            declared: false,
            enabled: true,
            origin: 'created',
            protected: false,
            source_available: true,
            source_revision: registered.body.registration.source_revision,
            execution: { scope: 'session_only', manual: true }
        });

        // The tool runs INSIDE its own session and nowhere else.
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(owner.id, 'shout'), {
                parameters: 'hello'
            })
        ).toEqual({ status: 200, body: { ok: true, result: 'HELLO', duration_ms: expect.any(Number) } });

        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(sibling.id, 'shout'), {
                parameters: 'hello'
            })
        ).toEqual({
            status: 404,
            body: { error: { message: `Unknown tool "shout" in session "${sibling.id}".` } }
        });
        // ...and the global route only knows the deployment catalogue.
        expect(await call(runtime, 'POST', HARNESS_ROUTES.toolsByToolIdExecutions('shout'), { parameters: 'hello' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown tool "shout".' } }
        });

        // An intentional second creation REPLACES the definition through the same guarded kernel
        // path (no "already registered" rejection). T39: `created`/`replaced` state what this write
        // did to a PRIOR REGISTRATION in this session — the kernel's own rule for the identical
        // write (../harness.ts:1292-1293 `existed = tools[name] !== undefined`, reported at
        // :1386-1399) — so overwriting the session's own earlier registration is a REPLACEMENT, not
        // a fresh creation. The old pin (created: true, replaced: false) contradicted the receipt's
        // own budget figure, which correctly did not grow, and the PATCH route, which reports the
        // kernel's `replaced` for the same operation.
        const replaced = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTools(owner.id), {
            name: 'shout',
            description: 'Again.',
            tags: ['text'],
            source: 'return 1;'
        });
        expect(replaced.status).toBe(201);
        expect(replaced.body.registration.created).toBe(false);
        expect(replaced.body.registration.replaced).toBe(true);
        // The revision this write displaced is named, so a client can tell a replacement from a
        // first registration without re-reading the source route.
        expect(replaced.body.registration.previous_revision).toBe(registered.body.registration.source_revision);
        expect(replaced.body.registration.budget).toEqual({
            used: 1,
            limit: HARNESS_SERVICE_LIMITS.created_tools
        });
        expect(replaced.body.registration.source_revision).not.toBe(registered.body.registration.source_revision);

        const reloaded = await callWithHeaders(
            runtime,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdToolsByToolId(owner.id, 'shout')
        );
        expect(reloaded.status).toBe(200);
        expect(reloaded.body.tool.description).toBe('Again.');
        expect(reloaded.body.tool.source_revision).toBe(replaced.body.registration.source_revision);

        // The NEW body is what runs.
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(owner.id, 'shout'), {
                parameters: 'hello'
            })
        ).toEqual({ status: 200, body: { ok: true, result: 1, duration_ms: expect.any(Number) } });

        // Built-in names are ordinary replaceable registrations too, and the receipt says so: the
        // live registry already had `task`, so this write REPLACED a prior registration (the same
        // `existed` test the kernel applies, ../harness.ts:1292-1293). It is not a statement about
        // the static catalogue, which this route never mutates.
        const reserved = await call(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTools(owner.id), {
            name: 'tasks',
            description: 'Mine.',
            tags: ['text'],
            source: 'return 1;'
        });
        expect(reserved.status).toBe(201);
        expect(reserved.body.registration.name).toBe('tasks');
        expect(reserved.body.registration.created).toBe(false);
        expect(reserved.body.registration.replaced).toBe(true);
    });
});

// Request policy at the adapter: what a body may be, and how large it may be.
//
// The caps are now ROUTE-aware: every route 1 MB, the submit route 16 MiB for base64 media
// (`bodyLimitFor`, shared with the Node adapter). The old single-constant 413 message quoted the
// same figure for everything; the target message quotes the cap of the route that answered.
describe('body policy and bounds', () => {
    it('requires a JSON object body on every action endpoint', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const cases: { method: string; pathname: string; body: unknown }[] = [
            { method: 'POST', pathname: HARNESS_ROUTES.models(), body: null },
            { method: 'POST', pathname: HARNESS_ROUTES.models(), body: [] },
            { method: 'POST', pathname: HARNESS_ROUTES.models(), body: 'https://provider.example/v1' },
            { method: 'POST', pathname: HARNESS_ROUTES.models(), body: 7 },
            { method: 'POST', pathname: HARNESS_ROUTES.sessions(), body: [] },
            { method: 'POST', pathname: HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), body: 'hello' },
            { method: 'POST', pathname: HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'), body: 7 },
            { method: 'PATCH', pathname: HARNESS_ROUTES.sessionsBySessionId(session.id), body: [] }
        ];

        for (const entry of cases) {
            const result = await call(runtime, entry.method, entry.pathname, entry.body);

            expect({ pathname: entry.pathname, result }).toEqual({
                pathname: entry.pathname,
                result: { status: 400, body: { error: { message: 'The request body must be a JSON object.' } } }
            });
        }
    });

    it('resolves the cap per route and quotes it in the refusal', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // Unit pin of the shared resolver both adapters call.
        expect(MAX_API_BODY_BYTES).toBe(HARNESS_SERVICE_LIMITS.body_bytes);
        expect(bodyLimitFor('POST', HARNESS_ROUTES.sessionsBySessionIdTasks('x'), MOUNT)).toBe(
            HARNESS_SERVICE_LIMITS.submit_body_bytes
        );
        expect(bodyLimitFor('POST', HARNESS_ROUTES.models(), MOUNT)).toBe(HARNESS_SERVICE_LIMITS.body_bytes);
        expect(bodyLimitFor('POST', HARNESS_ROUTES.toolsByToolIdExecutions('timeNow'), MOUNT)).toBe(
            HARNESS_SERVICE_LIMITS.body_bytes
        );

        // Honest content-length: rejected before the dispatcher inspects anything.
        const declared = await callHandler(runtime, 'POST', HARNESS_ROUTES.models(), {
            body: {},
            headers: { 'content-length': String(HARNESS_SERVICE_LIMITS.body_bytes + 1) }
        });
        expect(await jsonOf(declared)).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${HARNESS_SERVICE_LIMITS.body_bytes} bytes.` } }
        });

        // The loader pre-parses JSON, so this body is already in memory by the time the adapter
        // runs (documented residual); the adapter still refuses to dispatch it.
        const oversized = await callHandler(runtime, 'POST', HARNESS_ROUTES.models(), {
            body: { settings: { api_key: 'x'.repeat(HARNESS_SERVICE_LIMITS.body_bytes + 1_000) } }
        });
        expect((await jsonOf(oversized)).status).toBe(413);

        // On the submit route the SAME declared length is legal (16 MiB cap), and the payload stays
        // inside the task's own character budget so the route's answer is the receipt, not a 413.
        const submit = await callHandler(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), {
            body: { input: 'x'.repeat(2_000) },
            headers: { 'content-length': String(HARNESS_SERVICE_LIMITS.body_bytes + 1) }
        });
        expect(submit.status).toBe(202);

        const submitTooBig = await callHandler(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), {
            body: { input: 'x'.repeat(2_000) },
            headers: { 'content-length': String(HARNESS_SERVICE_LIMITS.submit_body_bytes + 1) }
        });
        expect(await jsonOf(submitTooBig)).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${HARNESS_SERVICE_LIMITS.submit_body_bytes} bytes.` } }
        });
    });

    it('forwards the loader query channel and stamps the contract headers', async () => {
        const runtime = createRuntime();

        await createDemo(runtime);
        await createDemo(runtime);

        // T18: the gateway hands the query over pre-split; forwarding it is what makes `?limit=1`
        // mean something on this mount instead of silently answering the default page.
        const page = await callHandler(runtime, 'GET', HARNESS_ROUTES.sessions(), { query: { limit: '1' } });
        const body = (await jsonOf(page)).body;
        expect(body.items).toHaveLength(1);
        expect(body.limit).toBe(1);

        // Every response carries the epoch; every response that has a revision carries it too.
        expect(page.headers).toEqual({
            'X-Harness-Epoch': runtime.events.epoch,
            'X-Harness-Revision': String(body.revision)
        });

        const receipt = await callHandler(runtime, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(body.items[0].id), {
            body: { input: 'stamp me' }
        });
        const settled = (await jsonOf(receipt)).body;
        expect(receipt.headers).toEqual({
            'X-Harness-Epoch': runtime.events.epoch,
            'X-Harness-Revision': String(settled.session_revision)
        });

        await runtime.store.waitForIdle(body.items[0].id);
    });
});
// The harness registry over HTTP: create, patch, read back, and the validation surface.
//
// Same guarantees as before the migration - a client may CREATE a harness by selecting trusted
// agents and PATCH a template's metadata/routing, writes affect FUTURE sessions only, and the
// frozen definition plus the effective per-agent models stay attributed to the session that was
// already running. What moved: every request field is snake_case, `editable` is gone (every
// template is patchable), and the per-agent instruction TEXT is answerable on its own routes
// instead of being smuggled through a fat card.
describe('harness registry writes over HTTP', () => {
    const SUMMARIZER_GUIDELINES = ['Keep names, numbers, and conclusions.', 'Drop preamble and repetition.'];

    it('creates a harness, lists it, and reads its definition back', async () => {
        const runtime = createRuntime();

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
            name: 'review',
            title: 'Review pair',
            description: 'Research plus a summarizer.',
            primary: 'research',
            subagents: ['summarizer']
        });

        expect(created.status).toBe(201);
        expect(Object.keys(created.body.harness).sort()).toEqual(
            [...CARD_KEY_SET, 'core_tools', 'instruction_summary'].sort()
        );
        expect(created.body.harness).toEqual({
            name: 'review',
            title: 'Review pair',
            description: 'Research plus a summarizer.',
            requires_endpoint: true,
            primary: 'research',
            subagents: ['summarizer'],
            agents: ['research', 'summarizer'],
            tools: [...TOOLBOX, 'fetch'],
            builtin: false,
            definition_revision: 1,
            core_tools: LIVE_CORE_TOOLS,
            instruction_summary: [
                { agent: 'research', source: 'catalogue', overridden: false, chars: 116 },
                { agent: 'summarizer', source: 'catalogue', overridden: false, chars: 56 }
            ]
        });
        // A write response is stamped with the definition revision the hub just moved to.
        expect(created.headers).toEqual({
            'X-Harness-Epoch': runtime.events.epoch,
            'X-Harness-Revision': String(created.body.harness.definition_revision)
        });

        // The index now lists it after the built-ins, with the same card (no definition extras).
        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(page.body.items.map((card: any) => card.name)).toEqual([...CARD_NAMES, 'review']);
        expect(page.body.items.at(-1)).toEqual({
            name: 'review',
            title: 'Review pair',
            description: 'Research plus a summarizer.',
            requires_endpoint: true,
            primary: 'research',
            subagents: ['summarizer'],
            agents: ['research', 'summarizer'],
            tools: [...TOOLBOX, 'fetch'],
            builtin: false,
            definition_revision: 1
        });

        // A session resolved by the same registry freezes the definition, and its roster is the
        // team the card selected.
        const session = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'review' });
        expect(session.status).toBe(201);
        const definition = await call(runtime, 'GET', `${HARNESS_ROUTES.sessionsBySessionId(session.body.session.id)}/definition`);
        expect(definition.body.definition.name).toBe('review');
        expect(definition.body.definition.agents).toEqual(['research', 'summarizer']);
        expect(definition.body.definition.core_tools).toEqual(LIVE_CORE_TOOLS);

        const roster = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdAgents(session.body.session.id));
        expect(roster.body.total).toBe(2);
        expect(roster.body.agents.map((row: any) => [row.agent_id, row.role, row.model])).toEqual([
            ['research', 'primary', 'demo-model'],
            ['summarizer', 'subagent', 'demo-model']
        ]);

        // The instruction text the research primary actually runs, read from the harness definition
        // routes: raw identity plus the trusted guidelines block, joined by the one documented rule.
        const instruction = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId('review', 'research')
        );
        expect(instruction.body.source).toBe('catalogue');
        expect(instruction.body.instruction).toBe(RESEARCH_IDENTITY);
        expect(instruction.body.guidelines).toEqual(RESEARCH_GUIDELINES);
        expect(instruction.body.chars).toBe(RESEARCH_IDENTITY.length);
    });

    it('applies per-agent models and freezes them per session', async () => {
        const runtime = createRuntime();

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
            name: 'modelled',
            primary: 'research',
            subagents: ['summarizer'],
            agent_models: { summarizer: 'small/fast' }
        });

        expect(created.status).toBe(201);
        // The card carries the OVERRIDE map only: the primary is absent because it uses the session
        // model, which is what a dropdown renders as "default".
        expect(created.body.harness.agent_models).toEqual({ summarizer: 'small/fast' });

        // The session resource reports the EFFECTIVE model per agent, so a reload can render every
        // dropdown without a second read.
        const session = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'modelled' });
        expect(session.body.session.model).toBe('demo-model');
        expect(session.body.session.agent_models).toEqual({
            research: 'demo-model',
            summarizer: 'small/fast'
        });

        // ...and the frozen copy keeps the map the card held at creation time.
        const definition = await call(
            runtime,
            'GET',
            `${HARNESS_ROUTES.sessionsBySessionId(session.body.session.id)}/definition`
        );
        expect(definition.body.definition.agent_models).toEqual({ summarizer: 'small/fast' });

        // A stated map on PATCH REPLACES the previous one.
        const patched = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('modelled'), {
            agent_models: { research: 'big/model' }
        });
        expect(patched.status).toBe(200);
        expect(patched.body.harness.agent_models).toEqual({ research: 'big/model' });

        // The earlier session keeps what it was built with (frozen definition AND the effective
        // per-agent models it reports).
        expect(runtime.store.get(session.body.session.id).harnessDefinition?.agentModels).toEqual({
            summarizer: 'small/fast'
        });
        expect(runtime.store.get(session.body.session.id).agentModels).toEqual({
            research: 'demo-model',
            summarizer: 'small/fast'
        });

        // An override on the primary becomes the session model, and the member the replacement map
        // dropped falls back again.
        const focused = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'modelled' });
        expect(focused.body.session.model).toBe('big/model');
        expect(focused.body.session.agent_models).toEqual({ research: 'big/model', summarizer: 'demo-model' });

        // `{}` clears every override, and the card drops the field again.
        const cleared = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('modelled'), {
            agent_models: {}
        });
        expect(Object.hasOwn(cleared.body.harness, 'agent_models')).toBe(false);
    });

    // R2 identity colors over HTTP. The wire spelling is `agent_colors` (snake_case, the
    // contract's rule for every REST field), the internal model spelling is
    // `HarnessDescriptor.agentColors`, and the value is a CSS hex color validated by the
    // registry (`normalizeAgentColors`) against the FINAL member set. A card page still
    // carries no override maps at all, so this is the resource a client paints from.
    it('applies per-agent colors, reports them on the definition read, and freezes them per session', async () => {
        const runtime = createRuntime();

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agent_colors: { summarizer: '#4ade80' }
        });

        expect(created.status).toBe(201);
        // Only the configured member is listed; an omitted member is uncolored and the
        // client applies its own derivation for it.
        expect(created.body.harness.agent_colors).toEqual({ summarizer: '#4ade80' });
        // The color is a display field, so it lands beside the model overrides on the
        // identified read and NOT on a card row (a card carries no override maps).
        const definition = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.harnessesByHarnessName('painted')
        );
        expect(definition.body.harness.agent_colors).toEqual({ summarizer: '#4ade80' });

        const list = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(Object.hasOwn(list.body.items.find((card: any) => card.name === 'painted'), 'agent_colors')).toBe(
            false
        );

        // The session freezes the colored definition, and the store's own copy proves the
        // map reached the frozen descriptor (the live `Agent.color` values that session's
        // agents run with are pinned at the factory level in ./harnesses/registry.test.ts:
        // `colors that agent only, leaves the rest uncolored`). The session resource itself
        // keeps its exact pre-R2 shape: colors are definition metadata, not session state.
        const session = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'painted' });
        const sessionId = session.body.session.id as string;
        expect(Object.hasOwn(session.body.session, 'agent_colors')).toBe(false);

        const frozen = await call(
            runtime,
            'GET',
            `${HARNESS_ROUTES.sessionsBySessionId(sessionId)}/definition`
        );
        expect(frozen.body.definition.agent_models).toBeUndefined();
        // The FROZEN copy carries the swatches, because that is the definition this
        // conversation was built with; the projected wire row stays the session shape.
        // R3: `agent_colors` rides `SessionDefinitionResource` (inherited from
        // `HarnessDefinition` through the spec's `allOf`) so the saved-session UI paints the
        // colors this conversation was built with, and `sessionDefinitionOf` reads the map off
        // the frozen `HarnessDescriptor` (./harnesses/descriptor.ts) — the same bytes
        // `runtime.store.get(...).harnessDefinition.agentColors` holds below.
        expect(frozen.body.definition.agent_colors).toEqual({ summarizer: '#4ade80' });
        expect(runtime.store.get(sessionId).harnessDefinition?.agentColors).toEqual({
            summarizer: '#4ade80'
        });

        // A stated map on PATCH REPLACES it, and `{}` clears every color so the field
        // disappears from the read again.
        const recolored = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
            agent_colors: { research: ' #F97316 ' }
        });
        expect(recolored.status).toBe(200);
        // Trimmed at the edge, casing preserved: the client's own bytes are what it paints.
        expect(recolored.body.harness.agent_colors).toEqual({ research: '#F97316' });

        // Snapshot isolation on the WIRE, not just in memory: the recolor moved the live
        // registry entry, and the frozen read still names the swatch this session's agents were
        // built with.
        expect(
            (
                await call(runtime, 'GET', `${HARNESS_ROUTES.sessionsBySessionId(sessionId)}/definition`)
            ).body.definition.agent_colors
        ).toEqual({ summarizer: '#4ade80' });

        // The earlier session is untouched by the recolor: its frozen descriptor still
        // names the color its agents were built with.
        expect(runtime.store.get(sessionId).harnessDefinition?.agentColors).toEqual({
            summarizer: '#4ade80'
        });

        const cleared = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
            agent_colors: {}
        });
        expect(Object.hasOwn(cleared.body.harness, 'agent_colors')).toBe(false);

        // The same non-empty rule on the frozen read: a session created while the definition
        // colors nothing gets NO `agent_colors` key, so an uncolored (or pre-R2) saved session
        // keeps its exact old wire shape. A member the map omits is uncolored the same way.
        const uncolored = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'painted' });
        expect(
            Object.hasOwn(
                (
                    await call(
                        runtime,
                        'GET',
                        `${HARNESS_ROUTES.sessionsBySessionId(uncolored.body.session.id)}/definition`
                    )
                ).body.definition,
                'agent_colors'
            )
        ).toBe(false);

        // A colors-only PATCH is a real change, so it is not "an empty patch".
        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
            agent_colors: { research: '#000' }
        })).toMatchObject({ status: 200 });

        // Validation, naming the agent so the UI can point at the offending swatch.
        expect(
            await call(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
                name: 'wide',
                primary: 'research',
                agent_colors: { summarizer: '#4ade80' }
            })
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`agentColors` names "summarizer", which is not a member of this harness. Members: research.'
                }
            }
        });

        // The shapes the contract's `agent_colors.pattern` refuses. `#abcd` is NOT in this
        // list: 4 digits is a valid `#rgba` (see the accepted set in
        // ./harnesses/registry.test.ts), so the length rule is 3/4/6/8, not "6 only".
        for (const value of ['red', 'rgb(1,2,3)', '#abcde', '#ab', 'aabbcc', '   ']) {
            expect(
                await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
                    agent_colors: { research: value }
                })
            ).toEqual({
                status: 400,
                body: {
                    error: {
                        message:
                            value.trim().length === 0
                                ? '`agentColors.research` cannot be empty. Omit the key to leave this agent uncolored.'
                                : `\`agentColors.research\` must be a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa). Received ${JSON.stringify(value)}.`
                    }
                }
            });
        }

        expect(
            await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
                agent_colors: ['research']
            })
        ).toEqual({
            status: 400,
            body: {
                error: { message: '`agentColors` must be an object mapping agent ids to CSS hex colors.' }
            }
        });

        // camelCase is not an alias: the request field is `agent_colors`.
        expect(
            await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('painted'), {
                agentColors: { research: '#4ade80' }
            })
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Unknown field "agentColors". Allowed fields: title, description, primary, subagents, agent_models, agent_instructions, agent_colors.'
                }
            }
        });
    });

    it('applies per-agent instructions and answers the text that a card summary only counts', async () => {
        const runtime = createRuntime();

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), {
            name: 'voiced',
            primary: 'research',
            subagents: ['summarizer'],
            agent_instructions: { summarizer: 'Condense to one line.' }
        });
        expect(created.status).toBe(201);
        // The summary states WHICH member is overridden and how long its text is - never the text.
        expect(created.body.harness.instruction_summary).toEqual([
            { agent: 'research', source: 'catalogue', overridden: false, chars: 116 },
            { agent: 'summarizer', source: 'harness', overridden: true, chars: 21 }
        ]);

        // The route the configuration dialog reads: the stored text (which since T6 IS the
        // agent's whole prompt) plus the profile's guideline RULES, reported separately.
        const text = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId('voiced', 'summarizer')
        );
        expect(text.body.source).toBe('harness');
        expect(text.body.instruction).toBe('Condense to one line.');
        expect(text.body.guidelines).toEqual(SUMMARIZER_GUIDELINES);
        expect(text.body.chars).toBe('Condense to one line.'.length);

        // A session built with it runs the override VERBATIM for that member (T6: a stored
        // override is the complete prompt, so no guideline block rides below it); the primary
        // keeps its trusted composed profile, and the store proves the words reached the
        // AGENT rather than only the card.
        const session = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'voiced' });
        const sessionId = session.body.session.id as string;
        const agents = await call(runtime, 'GET', HARNESS_ROUTES.sessionsBySessionIdAgents(sessionId));
        expect(agents.body.agents.map((row: any) => [row.agent_id, row.instruction_source, row.instruction_chars])).toEqual([
            ['research', 'catalogue', joinedPrompt(RESEARCH_IDENTITY, RESEARCH_GUIDELINES).length],
            ['summarizer', 'harness', 'Condense to one line.'.length]
        ]);

        const researchInstruction = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentIdInstruction(sessionId, 'research')
        );
        expect(researchInstruction.body.instruction).toBe(joinedPrompt(RESEARCH_IDENTITY, RESEARCH_GUIDELINES));

        // A later PATCH cannot rewrite what that session was built with, and the replacement map is
        // a replace: the member it drops is back on its trusted prompt.
        const patched = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('voiced'), {
            agent_instructions: { research: 'Ask before acting.' }
        });
        expect(patched.body.harness.instruction_summary).toEqual([
            { agent: 'research', source: 'harness', overridden: true, chars: 'Ask before acting.'.length },
            { agent: 'summarizer', source: 'catalogue', overridden: false, chars: 56 }
        ]);
        expect(runtime.store.get(sessionId).harnessDefinition?.agentInstructions).toEqual({
            summarizer: 'Condense to one line.'
        });

        const next = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'voiced' });
        const nextInstruction = await call(
            runtime,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentIdInstruction(next.body.session.id, 'research')
        );
        expect(nextInstruction.body.instruction).toBe('Ask before acting.');

        // The T6 contract, from the wire rather than the helper: a stored override reaches
        // the agent as the complete prompt, with no guideline section appended underneath.
        expect(nextInstruction.body.instruction).not.toContain('Guidelines:');
        expect(nextInstruction.body.chars).toBe('Ask before acting.'.length);

        // `{}` clears every override and the summary goes back to the catalogue rows.
        const cleared = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('voiced'), {
            agent_instructions: {}
        });
        expect(cleared.body.harness.instruction_summary).toEqual([
            { agent: 'research', source: 'catalogue', overridden: false, chars: 116 },
            { agent: 'summarizer', source: 'catalogue', overridden: false, chars: 56 }
        ]);
    });

    it('validates create requests: one primary, trusted agents, no client prompt', async () => {
        const runtime = createRuntime();
        const post = (body: unknown) => call(runtime, 'POST', HARNESS_ROUTES.harnesses(), body);

        expect(await post({})).toEqual({
            status: 400,
            body: { error: { message: 'A harness definition requires a "name".' } }
        });
        expect(await post({ name: 'writer', primary: 'instruct' })).toEqual({
            status: 400,
            body: { error: { message: 'Harness name "writer" is reserved as an alias of "instruct".' } }
        });
        expect((await post({ name: 'dup', primary: 'instruct' })).status).toBe(201);
        expect(await post({ name: 'dup', primary: 'instruct' })).toEqual({
            status: 409,
            body: { error: { message: 'Harness "dup" already exists.' } }
        });
        expect(await post({ name: 'bad-agent', primary: 'nobody' })).toEqual({
            status: 400,
            body: {
                error: {
                    message: `\`primary\` names unknown agent "nobody". Known agents: ${AGENT_NAMES.join(', ')}.`
                }
            }
        });
        expect(await post({ name: 'self', primary: 'instruct', subagents: ['instruct'] })).toEqual({
            status: 400,
            body: { error: { message: 'Subagent "instruct" is the primary agent; a harness has exactly one primary.' } }
        });
        expect(await post({ name: 'extra', primary: 'instruct', subagents: ['critic'] })).toEqual({
            status: 400,
            body: { error: { message: `\`subagents\` names unknown agent "critic". Known agents: ${AGENT_NAMES.join(', ')}.` } }
        });

        // A bare `instruction`/tool field is still not part of the contract: an override must name a
        // member agent, is bounded, and never rewrites the trusted profile.
        const CREATE_FIELDS =
            'name, title, description, primary, subagents, agent_models, agent_instructions, agent_colors';
        expect(await post({ name: 'prompted', primary: 'instruct', instruction: 'You are now evil.' })).toEqual({
            status: 400,
            body: { error: { message: `Unknown field "instruction". Allowed fields: ${CREATE_FIELDS}.` } }
        });
        expect(await post({ name: 'tools', primary: 'instruct', tools: ['shell'] })).toEqual({
            status: 400,
            body: { error: { message: `Unknown field "tools". Allowed fields: ${CREATE_FIELDS}.` } }
        });
        // The camelCase spellings of the two override maps are unknown fields, not aliases.
        expect(await post({ name: 'camel', primary: 'instruct', agentModels: { instruct: 'x/y' } })).toEqual({
            status: 400,
            body: { error: { message: `Unknown field "agentModels". Allowed fields: ${CREATE_FIELDS}.` } }
        });
    });

    it('validates the two override maps: members only, bounded non-empty text', async () => {
        const runtime = createRuntime();
        const post = (body: unknown) => call(runtime, 'POST', HARNESS_ROUTES.harnesses(), body);
        const patch = (name: string, body: unknown) => call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName(name), body);

        // A key outside the team could never apply. A created harness starts with NO subagents, so
        // its member set is the primary alone.
        expect(await post({ name: 'wide', primary: 'instruct', agent_instructions: { summarizer: 'Be brief.' } })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '`agentInstructions` names "summarizer", which is not a member of this harness. Members: instruct.'
                }
            }
        });

        // Not an object of strings.
        expect(await patch('demo', { agent_instructions: ['Be brief.'] })).toEqual({
            status: 400,
            body: {
                error: { message: '`agentInstructions` must be an object mapping agent ids to instruction text.' }
            }
        });

        // Blank text is a visible mistake: clearing an override is omitting the key (or sending
        // `{}`), never storing an empty prompt.
        expect(await patch('demo', { agent_instructions: { general: '   ' } })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '`agentInstructions.general` cannot be empty. Omit the key to run the trusted instruction.'
                }
            }
        });
        expect(await patch('demo', { agent_instructions: { general: 'a'.repeat(8_001) } })).toEqual({
            status: 400,
            body: { error: { message: '`agentInstructions.general` cannot exceed 8000 characters.' } }
        });
        expect(await patch('demo', { agent_instructions: { general: 'bad\u0000model' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentInstructions.general` contains control characters.' } }
        });

        // Multi-line prose IS legitimate prompt text (a model id, by contrast, rejects a newline).
        const accepted = await patch('demo', { agent_instructions: { general: 'Lead with the answer.\nThen cite the file.' } });
        expect(accepted.status).toBe(200);
        expect(accepted.body.harness.instruction_summary).toEqual([
            { agent: 'general', source: 'harness', overridden: true, chars: 'Lead with the answer.\nThen cite the file.'.length }
        ]);

        // Models: members only, an object of strings, bounded non-empty ids - naming the agent.
        expect(await post({ name: 'model-x', primary: 'instruct', agent_models: { demo: 'small/fast' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels` names "demo", which is not a member of this harness. Members: instruct.' } }
        });
        expect(await post({ name: 'model-y', primary: 'instruct', agent_models: ['small/fast'] })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels` must be an object mapping agent ids to model ids.' } }
        });
        expect(await post({ name: 'model-z', primary: 'instruct', agent_models: { instruct: '  ' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.instruct` cannot be empty.' } }
        });
        expect(await post({ name: 'model-w', primary: 'instruct', agent_models: { instruct: 'a'.repeat(201) } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.instruct` cannot exceed 200 characters.' } }
        });

        // The same validation applies on PATCH, against the FINAL member set.
        expect(await patch('instruct', { agent_models: { demo: 'small/fast' } })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`agentModels` names "demo", which is not a member of this harness. Members: instruct, general, research, workspace, reviewer, debugger, summarizer.'
                }
            }
        });
    });

    it('patches every template (no read-only category) and keeps invalid patches rejected', async () => {
        const runtime = createRuntime();

        // R20.1: a metadata-only PATCH is a 200 for EVERY shipped template (the formerly frozen
        // demo/flaky included). `editable` no longer exists: the definition revision is the fact a
        // client acts on, and it moves with every accepted write.
        for (const name of CARD_NAMES) {
            const result = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName(name), {
                title: `${name} patched`
            });

            expect(result.status).toBe(200);
            expect(result.body.harness.title).toBe(`${name} patched`);
            expect(result.body.harness.definition_revision).toBe(1);
            expect(Object.hasOwn(result.body.harness, 'editable')).toBe(false);
        }

        // A metadata-only write did NOT make the offline fixture live.
        const demo = await call(runtime, 'GET', HARNESS_ROUTES.harnessesByHarnessName('demo'));
        expect(demo.body.harness.requires_endpoint).toBe(false);
        expect(demo.body.harness.tools).toEqual(['timeNow']);

        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('missing'), { title: 'Nope' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "missing".' } }
        });

        const PATCH_FIELDS =
            'title, description, primary, subagents, agent_models, agent_instructions, agent_colors';
        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('instruct'), {})).toEqual({
            status: 400,
            body: { error: { message: `A patch must change at least one field.` } }
        });
        // `name` is immutable, and a client still cannot smuggle a BARE instruction.
        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('instruct'), { name: 'renamed' })).toEqual({
            status: 400,
            body: { error: { message: `Unknown field "name". Allowed fields: ${PATCH_FIELDS}.` } }
        });
        expect(await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('instruct'), { instruction: 'x' })).toEqual({
            status: 400,
            body: { error: { message: `Unknown field "instruction". Allowed fields: ${PATCH_FIELDS}.` } }
        });

        // Only the declared verbs are mounted on an identified definition.
        expect(await call(runtime, 'PUT', HARNESS_ROUTES.harnessesByHarnessName('instruct'))).toEqual({
            status: 405,
            body: { error: { message: 'Use GET, PATCH, DELETE for /v1/harness/harnesses/instruct.' } }
        });
    });

    it('keeps demo scripted through metadata edits and makes an executable edit live', async () => {
        const runtime = createRuntime();

        // A session created from the shipped template is scripted and requires no endpoint.
        const scripted = await createDemo(runtime);
        const before = await call(runtime, 'GET', `${HARNESS_ROUTES.sessionsBySessionId(scripted.id)}/definition`);
        expect(before.body.definition.requires_endpoint).toBe(false);
        expect(before.body.definition.tools).toEqual(['timeNow']);

        // Executable PATCH: demo becomes an honest live profiled harness, so the descriptor stops
        // advertising the offline script.
        const live = await call(runtime, 'PATCH', HARNESS_ROUTES.harnessesByHarnessName('demo'), {
            primary: 'workspace'
        });
        expect(live.status).toBe(200);
        expect(live.body.harness).toMatchObject({
            name: 'demo',
            requires_endpoint: true,
            primary: 'workspace',
            subagents: [],
            agents: ['workspace'],
            builtin: true
        });
        // The upgrade replaces the script with the live toolbox plus the environment rows this
        // keyless host can run: `fetch` (native, no credential) always, `search` only with a key.
        expect(live.body.harness.tools).toEqual([...TOOLBOX, 'fetch']);
        // No subagents, so no `delegate` in the declared core - the same rule a card and a frozen
        // session both follow, so they cannot disagree.
        expect(live.body.harness.core_tools).toEqual(['toolRequest', 'tasks', 'read', 'write', 'edit', 'glob', 'grep', 'fetch']);

        // A NEW session runs the live configuration; the scripted session keeps what it was built
        // with, and is still runnable offline.
        const after = await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'demo' });
        const afterDefinition = await call(
            runtime,
            'GET',
            `${HARNESS_ROUTES.sessionsBySessionId(after.body.session.id)}/definition`
        );
        expect(afterDefinition.body.definition.primary).toBe('workspace');
        expect(afterDefinition.body.definition.requires_endpoint).toBe(true);

        // The scripted session is untouched: its frozen copy still describes the offline script,
        // while the CARD moved (the wire projection and the stored copy are different shapes, so the
        // facts are compared field by field against the store oracle).
        const frozen = runtime.store.get(scripted.id).harnessDefinition;
        expect(frozen?.name).toBe('demo');
        expect(frozen?.requiresEndpoint).toBe(false);
        expect(frozen?.tools).toEqual(['timeNow']);
    });
});

// `DELETE /harnesses/{name}` takes any harness out of the catalogue - a shipped default exactly
// like a user-created one - and answers the minimal delete receipt. The authoritative record is the
// database, not a second copy of the harness.
describe('deleting a harness over HTTP', () => {
    it('deletes a user harness and drops it from every listing', async () => {
        const runtime = createRuntime();

        const created = await callWithHeaders(runtime, 'POST', HARNESS_ROUTES.harnesses(), { name: 'temporary', primary: 'instruct' });
        expect(created.status).toBe(201);

        const removed = await call(runtime, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('temporary'));

        // The exact frontend contract: 200 with the identity, and the durability truth stated.
        expect(removed).toEqual({
            status: 200,
            body: { deleted: true, harness_name: 'temporary', tombstoned: false, restored_by_restart: false }
        });

        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(page.body.items.map((card: any) => card.name)).toEqual(CARD_NAMES);

        // A new session cannot reach it any more, and a repeat delete removed nothing, so it is not
        // reported as a success.
        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'temporary' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "temporary".' } }
        });
        expect(await call(runtime, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('temporary'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "temporary".' } }
        });
    });

    it('tombstones a shipped built-in and leaves the conversation that used it', async () => {
        const runtime = createRuntime();
        const call_ = canonicalCall(runtime);

        // A real recorded conversation on the shipped fixture, created FIRST.
        const session = await createDemo(runtime);
        const receipt = await submitTask(call_, session.id, { input: 'What time is it?' });
        await waitForTurnStatus(call_, session.id, receipt.turn_id, ['done']);

        const removed = await call(runtime, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('demo'));
        // An in-memory deployment has no database to record the removal in, so the receipt says the
        // built-in WOULD come back on restart - honestly, rather than claiming durability.
        expect(removed).toEqual({
            status: 200,
            body: { deleted: true, harness_name: 'demo', tombstoned: true, restored_by_restart: false }
        });

        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(page.body.items.map((card: any) => card.name)).toEqual(CARD_NAMES.filter((name) => name !== 'demo'));

        // A NEW session on the deleted card is a 404 ...
        expect(await call(runtime, 'POST', HARNESS_ROUTES.sessions(), { harness: 'demo' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "demo".' } }
        });

        // ... while the existing conversation is untouched: it still lists, still reports the
        // harness it captured, and its turns are intact.
        const listed = await readOk<Record<string, any>>(call_, 'GET', HARNESS_ROUTES.sessions(), 200);
        expect(listed.items.map((row: any) => row.id)).toEqual([session.id]);

        const after = await readOk<{ session: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionId(session.id),
            200
        );
        expect(after.session.harness).toBe('demo');
        expect(after.session.turn_count).toBe(1);

        const definition = await readOk<{ definition: Record<string, any> }>(
            call_,
            'GET',
            HARNESS_ROUTES.sessionsBySessionIdDefinition(session.id),
            200
        );
        expect(definition.definition.name).toBe('demo');
        expect(definition.definition.title).toBe('Scripted fixture');

        const turns = await listTurns(call_, session.id);
        expect(turns.items.map((row: any) => [row.promptPreview, row.status])).toEqual([['What time is it?', 'done']]);

        // The live session is still usable: its frozen harness runs the next turn, offline, exactly
        // as before the deletion. (The old version of this assertion read the SSE frames.)
        const next = await submitTask(call_, session.id, { input: 'And again?' });
        const settled = await waitForTurnStatus(call_, session.id, next.turn_id, ['done']);
        expect(settled.status).toBe('done');

        const history = await listTurns(call_, session.id);
        expect(history.items.map((row: any) => row.promptPreview)).toEqual(['What time is it?', 'And again?']);
    });

    it('refuses to delete through a legacy alias, which is not an identity', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('writer'))).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "writer".' } }
        });

        // The target survived the attempt.
        const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
        expect(page.body.items.map((card: any) => card.name)).toEqual(CARD_NAMES);
    });

    it('answers 500 when the durable write fails', async () => {
        // The database directory cannot be created: its parent is a plain file, so the store's own
        // write fails for a real reason (no mock).
        const root = await createFixture('harness-delete-blocked-');
        const blocker = join(root, 'blocked');

        try {
            await writeTextFile(blocker, 'not a directory', 'utf8');

            const registry = createHarnessRegistry(PRODUCTION_WITH_FIXTURES);
            const store = new SessionStore(SETTINGS, registry, undefined, {
                persistence: new HarnessPersistence(join(blocker, 'nested'))
            });
            const runtime = createHarnessRuntime({
                settings: SETTINGS,
                defaults: DEFAULTS,
                loadEnvironment: false,
                store,
                registry
            });

            const failure = await call(runtime, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('demo'));

            expect(failure.status).toBe(500);
            expect(failure.body.error.message).toContain('Could not save the harness database');

            // The refusal is honest and ATOMIC: the durable write failed, so the card is still
            // listed in this process, the registry still holds it, and no tombstone was written that
            // would delete it on the next start.
            const page = await call(runtime, 'GET', HARNESS_ROUTES.harnesses());
            expect(page.body.items.map((card: any) => card.name)).toEqual(CARD_NAMES);
            expect(registry.find('demo')).toBeDefined();
            expect(registry.deletedBuiltins()).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
