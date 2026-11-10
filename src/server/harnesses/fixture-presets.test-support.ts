// TEST SUPPORT (not production, not collected by vitest: the file name ends in
// `.test-support.ts`, while `src/**/*.{test,spec}.{ts,tsx}` is the include pattern in
// ../../vitest.config.ts).
//
// WHY THIS EXISTS
// The shipped catalogue used to carry two example presets that were not production
// configurations:
//
//   demo   — a scripted transport. It never called a model, so it needed no endpoint,
//            and its answer was a fixed transcript about `timeNow`.
//   flaky  — the shared toolbox plus `testFlaky`, a tool that throws on two calls out
//            of three, so the recoverable-failure path was visible.
//
// Both were fixtures, and a fixture in the production catalogue is a card a user can
// pick that does not do what a card promises. They are deleted from `./presets.ts`,
// along with the `demo`/`flaky` entries in the trusted agent registry — an agent id is
// a role a harness selects, and neither of these was one.
//
// A dozen suites still need exactly what they provided: an offline loop to drive
// without a provider, and a toolbox with an extra tool to exercise the failure path
// and the template-rebuild rules. That need is TEST-owned, so it lives here: a test
// builds its own agents and its own preset next to itself instead of the product
// carrying a permanent example tier.
//
// WHAT IS DIFFERENT FROM THE DELETED PRESETS
//   - The ids stay `demo` and `flaky` so a suite still reads as "run the demo loop" and
//     a frozen session record still names a harness that exists in the registry it is
//     restored into. But NOTHING in this build resolves those names by default: they are
//     not in `presets`, not in `findPreset`'s default catalogue, and not in
//     `AGENT_PROFILES`. A test sees them only because it injected them.
//   - Neither has an `AgentProfile` of its own, and BOTH select the real `general` role as
//     their agent. A harness's agent names are what the wire reports (a session roster's
//     `profile`, an event's `agent`, the instruction provenance a definition read answers),
//     and a name with no profile answers `chars: 0` / `guidelines: []` — a projection that
//     reads like a bug. The scripted transport ignores the instruction text anyway, so
//     borrowing a real profile costs nothing and keeps every read honest.
//   - `builtin: true` is kept deliberately, even though nothing ships these rows. The
//     suites that use them are testing the registry's BUILT-IN behaviour — a deleted
//     built-in leaves a tombstone, a saved built-in row refreshes against the shipped
//     template, an injected row that is absent on restore is skipped rather than
//     re-created. Provenance is informational (./types.ts), and the registry never
//     validates it against the shipped catalogue, so an injected preset can carry it.
//   - `testFlaky` is a `tool()` DEFINITION passed through `extraTools`, not a scanned
//     `*.tool.ts` source entry. The `src/server/tools/examples` folder existed only to
//     hold that one file, and a scanned folder is load-bearing — `resolveToolFolders`
//     rejects one that is missing — so an empty examples folder would have been worse
//     than no folder at all. A test that wants a SOURCE-backed extra tool passes its own
//     `extraToolSources` entry, which `createToolboxHarness` still accepts.
//
// HOW A TEST USES THEM
//   createHarnessRegistry([...presets, SCRIPTED_FIXTURE])   // the offline loop
//   createHarnessRegistry([...presets, FLAKY_FIXTURE])      // the failure path
//   createHarnessRegistry(FIXTURE_PRESETS)                  // fixtures only
//
// Cross-references:
//   - ./presets.ts        — the production catalogue (seven live roles, no fixtures)
//   - ./toolbox.ts        — createToolboxHarness / extraTools / extraToolSources
//   - ../../agents        — the trusted profiles; `demo`/`flaky` are no longer among them

import { agent, harness, tool } from '../../harness';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '../../harness';
import { agentInstruction, AGENT_PROFILES } from '../../agents';
import { presets } from './presets';
import {
    SHARED_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createToolboxHarness
} from './toolbox';
import type { HarnessPreset } from './types';

// ---------------------------------------------------------------------------
// The scripted transport
// ---------------------------------------------------------------------------

// Tool-call ids must be unique across a CONVERSATION (the harness rejects a reused id
// before executing anything). A scripted fixture is reused by successive tasks in one
// session and by a restored session, so a per-process or per-call counter is not enough.
// Derive the next free id from the transcript itself: it survives a restart (the ids are
// persisted with the messages), survives a restore, and cannot collide with a foreign id
// already present in the conversation.
const usedCallIds = (request: HarnessStreamRequest): ReadonlySet<string> => {
    const used = new Set<string>();

    for (const message of request.messages) {
        if (message.role !== 'assistant') continue;
        for (const call of message.toolCalls ?? []) used.add(call.id);
    }

    return used;
};

const nextCallId = (used: ReadonlySet<string>, base: string): string => {
    for (let index = 1; ; index++) {
        const candidate = `${base}_${index}`;
        if (!used.has(candidate)) return candidate;
    }
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('The run was aborted.'));
            return;
        }

        const timer = setTimeout(resolve, ms);

        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('The run was aborted.'));
        });
    });

async function* speak(
    text: string,
    type: 'text' | 'reasoning',
    signal?: AbortSignal
): AsyncGenerator<HarnessStreamEvent> {
    for (const piece of text.split(/(\s+)/)) {
        if (piece.length === 0) continue;

        await sleep(16, signal);
        yield { type, delta: piece };
    }
}

const SCRIPTED_REASONING =
    'No endpoint is attached to this preset, so the transport is scripted. ' +
    'Only toolRequest is declared, so I have to discover timeNow before I can read the time.';

const SCRIPTED_DISCOVERY = 'Asking the catalogue for time-related tools first, since only toolRequest is visible.';

const SCRIPTED_PREAMBLE = 'Found it. Calling timeNow now.';

// The scripted transport reads the request to decide which round it is in. The harness
// appends a `tool` message before re-requesting, and that message's `name` says which
// round just finished:
//
//   1. user prompt          -> toolRequest(["time"])   (the only declared tool)
//   2. toolRequest result   -> timeNow                 (now declared, so callable)
//   3. timeNow result       -> the answer
//
// The usage figures follow the shape a real gateway reports: every request re-sends the
// transcript, so `input` grows round over round and the cached part of it is the previous
// round's whole prompt plus results (A+B, then A+B+C). No provider is involved, yet the
// UI's token tally fills in exactly as it does live — which is why the exact numbers
// below are pinned by the suites that assert on usage.
export const scriptedFixture = (): HarnessStream =>
    async function* (request): AsyncGenerator<HarnessStreamEvent> {
        const last = request.messages[request.messages.length - 1];
        const afterTool = last !== undefined && last.role === 'tool' ? last : undefined;
        // One scan per request; both rounds mint from the same live conversation.
        const used = usedCallIds(request);

        if (afterTool !== undefined && afterTool.name === 'timeNow') {
            const text =
                `timeNow returned ${afterTool.content}. ` +
                'That is the whole loop: the harness ran the tool, appended its result, and re-requested ' +
                'until the model answered with text. Switch to a live preset and set an endpoint to try ' +
                'this against a real model.';

            yield* speak(text, 'text', request.signal);
            yield {
                type: 'done',
                stopReason: 'stop',
                toolCalls: [],
                // Third request: the whole transcript is a cached prefix; only the
                // new timeNow result above is fresh input.
                usage: { input: 148, output: 64, total: 212, cached: 120 }
            };
            return;
        }

        if (afterTool !== undefined && afterTool.name === 'toolRequest') {
            yield* speak(SCRIPTED_PREAMBLE, 'reasoning', request.signal);
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [
                    {
                        id: nextCallId(used, 'call_time_now'),
                        name: 'timeNow',
                        arguments: '{"timezone":"UTC"}'
                    }
                ],
                // Second request: the first prompt is now a cached prefix.
                usage: { input: 96, output: 22, total: 118, cached: 48 }
            };
            return;
        }

        yield* speak(SCRIPTED_REASONING, 'reasoning', request.signal);
        yield* speak(SCRIPTED_DISCOVERY, 'text', request.signal);
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                {
                    id: nextCallId(used, 'call_tool_request'),
                    name: 'toolRequest',
                    arguments: '{"tags":["time"]}'
                }
            ],
            // First request: no prefix to reuse yet, so nothing is cached.
            usage: { input: 48, output: 18, total: 66, cached: 0 }
        };
    };

// ---------------------------------------------------------------------------
// The scripted fixture preset
// ---------------------------------------------------------------------------

// The offline loop, with no endpoint. `template: 'scripted'` is what lets a suite keep
// exercising the registry's scripted-template rules (a metadata-only patch keeps the
// script; an executable patch upgrades to a live profiled harness and corrects the
// descriptor) now that no SHIPPED preset uses that template.
export const SCRIPTED_FIXTURE_NAME = 'demo';

export const SCRIPTED_FIXTURE: HarnessPreset = {
    name: SCRIPTED_FIXTURE_NAME,
    title: 'Scripted fixture',
    description:
        'Test fixture: runs a scripted transport — a reasoning stream, a toolRequest discovery round, one tool call, and a final answer. No endpoint needed. Not a production configuration.',
    requiresEndpoint: false,
    // The real `general` profile, not `demo`: see the header. The PRESET is named `demo` (a
    // frozen session record names it, and `presetFromRecord` matches on the preset name), but
    // the AGENT inside it is a role this build actually has.
    primary: 'general',
    subagents: [],
    agents: ['general'],
    tools: ['timeNow'],
    // See the header: `builtin: true` keeps the built-in registry paths exercisable.
    builtin: true,
    editable: true,
    template: 'scripted',
    // Metadata an executable patch adopts once the script is replaced by a live factory.
    live: {
        title: 'Live fixture',
        description:
            'A live harness built from the selected agents with the shared toolbox, running against the session provider. This entry started as the scripted fixture and no longer uses the offline script.'
    },
    create: (settings, progress, report) =>
        harness({
            agents: {
                general: agent({
                    model: settings.model.trim().length > 0 ? settings.model : 'scripted/fixture',
                    // The composition path a real agent uses, kept identical so the
                    // fixture cannot drift from it. The scripted transport ignores the
                    // text; the point is that the prompt is the trusted `general` one.
                    instruction: agentInstruction(AGENT_PROFILES.general),
                    stream: scriptedFixture()
                })
            },
            // Compiled through the same startup kernel as every shipped entry rather than
            // passed in as a prebuilt definition (T19/F1), and through the DISCOVERED
            // shared path so a move of the file cannot leave a stale literal here.
            toolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow },
            presets: false,
            primary: 'general',
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange }),
                ...(report?.diagnostic === undefined ? {} : { diagnostic: report.diagnostic })
            },
            ...(report?.interaction === undefined ? {} : { interaction: report.interaction }),
            ...(report?.pluginSettings === undefined ? {} : { pluginSettings: report.pluginSettings }),
            ...(report?.toolSettings === undefined ? {} : { toolSettings: report.toolSettings })
        })
};

// ---------------------------------------------------------------------------
// The failure-path fixture preset
// ---------------------------------------------------------------------------

// Deliberately unreliable: fails twice, succeeds on the third call, so the recoverable
// failure path is visible — the harness feeds the error back as a tool result and the
// model gets another turn.
//
// STATE IS PER AGENT, not per process: a process-wide counter made two sessions share one
// attempt count, so session A's failures could "heal" session B's first call. Inside a
// harness the store is harness-owned memory (`context.harness.memory`), so a
// runtime-compiled replacement keeps counting the same agents. A bare `testFlaky()` call
// has no harness and falls back to the module counters below.
const FLAKY_ATTEMPTS_MEMORY_KEY = 'testFlaky:attempts';

const moduleFlakyAttempts = new WeakMap<object, number>();
let directFlakyAttempts = 0;

// Minimal structural view of the harness memory, so this module does not import the whole
// Harness type for one field.
type HarnessMemoryView = {
    memory: {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => void;
    };
};

const attemptsOf = (harnessView: HarnessMemoryView | undefined): WeakMap<object, number> => {
    if (harnessView === undefined) return moduleFlakyAttempts;

    const stored = harnessView.memory.get(FLAKY_ATTEMPTS_MEMORY_KEY);

    if (stored instanceof WeakMap) return stored as WeakMap<object, number>;

    const created = new WeakMap<object, number>();
    harnessView.memory.set(FLAKY_ATTEMPTS_MEMORY_KEY, created);
    return created;
};

const nextFlakyAttempt = (agentSubject: unknown, harnessView: HarnessMemoryView | undefined): number => {
    const key =
        agentSubject !== null && (typeof agentSubject === 'object' || typeof agentSubject === 'function')
            ? agentSubject
            : undefined;

    if (key === undefined) {
        directFlakyAttempts += 1;
        return directFlakyAttempts;
    }

    const attempts = attemptsOf(harnessView);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return attempt;
};

export const TEST_FLAKY_TOOL_NAME = 'testFlaky';

export const testFlaky = tool<Record<string, never>, string>({
    name: TEST_FLAKY_TOOL_NAME,
    description:
        'A deliberately unreliable tool. It throws on the first two calls of every three. Call it again after a failure; the error is returned to you as a tool result.',
    tags: ['reliability', 'retry', 'testing'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: ({ agent: caller, harness: harnessView }) => {
        const attempt = nextFlakyAttempt(caller, harnessView as HarnessMemoryView | undefined);

        if (attempt % 3 !== 0) {
            throw new Error(`Temporary failure (attempt ${attempt}). Retry the same call.`);
        }

        return `Success on attempt ${attempt}.`;
    }
});

// The fixture that carries it. Same shared toolbox as every production preset, plus the
// unreliable tool — which is exactly why a suite reaches for it: it is the only harness
// shape with an extra registered tool, and the only way to exercise the registry's
// 'flaky' template branch now that no shipped preset declares one.
export const FLAKY_FIXTURE_NAME = 'flaky';

export const FLAKY_FIXTURE: HarnessPreset = {
    name: FLAKY_FIXTURE_NAME,
    title: 'Recoverable failures (fixture)',
    description:
        'Test fixture: the shared toolbox plus a tool that throws on two out of every three calls, so a run can retry instead of dying. Not a production configuration.',
    requiresEndpoint: true,
    // A REAL profile. There is no `flaky` agent profile any more, and a live harness that
    // named one would fail validation against the trusted registry.
    primary: 'general',
    subagents: [],
    agents: ['general'],
    tools: [...SHARED_TOOL_NAMES, TEST_FLAKY_TOOL_NAME],
    environmentTools: ['search', 'fetch'],
    builtin: true,
    editable: true,
    template: 'flaky',
    create: (settings, progress, report) =>
        createToolboxHarness(
            {
                // The real `general` profile, built by the same factory every live preset
                // uses, so the fixture's only difference from a production harness is the
                // extra tool.
                agents: agentsFromProfiles(['general'], settings),
                primary: 'general',
                subagents: [],
                // A DEFINITION, not a source path: see the header note on why the
                // examples folder is gone. `createToolboxHarness` registers `extraTools`
                // last, so a definition wins over a source of the same name.
                extraTools: { [TEST_FLAKY_TOOL_NAME]: testFlaky }
            },
            settings,
            progress,
            report
        )
};

// Both fixtures, in the order a test usually wants them (offline first).
export const FIXTURE_PRESETS: readonly HarnessPreset[] = [SCRIPTED_FIXTURE, FLAKY_FIXTURE];

// The production catalogue plus the fixtures: what a suite passes when it wants the real
// cards AND an offline loop in one registry.
export const withFixtures = (production: readonly HarnessPreset[]): readonly HarnessPreset[] => [
    ...production,
    ...FIXTURE_PRESETS
];

// The common case, ready to hand: the seven production cards, then the two fixtures.
// This is the direct replacement for the deleted `ALL_PRESET_TEMPLATES` export — the
// lookup/registry superset a suite used to inject when it wanted everything this build
// can build. Order is catalogue-first, so a listing still shows the real presets before
// the fixtures.
export const PRODUCTION_WITH_FIXTURES: readonly HarnessPreset[] = withFixtures(presets);
