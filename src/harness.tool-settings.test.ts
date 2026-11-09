// R3 — the GLOBAL tool switch at the library boundary (src/harness.ts + HarnessConfiguration.toolSettings).
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. DECLARED  - a globally disabled name is absent from the tool list a model request is
//                  given, and comes back on the NEXT request after the switch is flipped,
//                  with no rebuild and no re-registration (the provider is read live).
//   2. CALLABLE  - the launch gate denies a disabled name with one stable, readable tool
//                  RESULT (a rejected call, not a failed run), and only after the
//                  per-run scope gate, so an out-of-scope call keeps its existing answer.
//   3. DISCOVERY - `toolRequest` reports a disabled match under `forbidden` with the real
//                  reason and NEVER writes it into the session-wide enabled set (one
//                  thread's search cannot undo the operator's decision for every other).
//   4. COMPOSES  - the switch layers on the two gates that already exist (a delegation's
//                  `scope.tools`, the session's enabled set) and changes neither, and an
//                  absent provider leaves every one of those lists byte-identical.
//
// Determinism: every expected array, object and sentence below is an EXACT value. The model
// is scripted (no provider, no network), and the request capture (`seen`) IS the observation
// of `declared()`, because `offerDeclarations` builds the request's tool list from it.
//
// Cross-references:
//   - ../harness.ts                    — `isToolGloballyDisabled`, `declared`, the launch gate, `requestToolsFor`
//   - ./types/index.ts                 — `HarnessToolSettingsProvider`, `HarnessConfiguration.toolSettings`
//   - ./server/tool-settings.ts        — the server's store behind the provider (unit-tested there)
//   - ./harness.delegation.test.ts     — the sibling `forbidden` contract for a scoped run (T11)
import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolSettingsProvider
} from '@underload/harness';

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);

        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'test/model', stream });

// Two searchable capabilities, named so the selection order is obvious, plus one CORE
// capability — the switch is a pure deny list, so a core name is switchable like any other.
const capabilities = {
    read: tool({
        description: 'Read a file.',
        tags: ['files'],
        visibility: 'searchable',
        execute: () => 'contents'
    }),
    write: tool({
        description: 'Write a file.',
        tags: ['files'],
        visibility: 'searchable',
        execute: () => 'written'
    }),
    glob: tool({
        description: 'Glob files.',
        tags: ['files'],
        visibility: 'core',
        execute: () => 'a.ts'
    })
};

/** A provider over a live Set — the exact shape `./server/tool-settings.ts` hands the harness. */
const switchOf = (disabled: Set<string>): { provider: HarnessToolSettingsProvider; names: () => string[] } => ({
    provider: { isToolDisabled: (name: string) => disabled.has(name) },
    names: () => [...disabled]
});

/** The tool names one captured request was given, in declaration order. */
const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((entry) => entry.name);

/** The content of one tool result in an agent's transcript, by call id. */
const toolResult = (messages: readonly unknown[], callId: string): string => {
    const found = (messages as { role: string; toolCallId?: string; content?: string }[]).find(
        (message) => message.role === 'tool' && message.toolCallId === callId
    );

    return found?.content ?? '';
};

describe('R3 — the global tool switch: declarations', () => {
    it('hides a disabled name from the request and puts it back on the very next one', async () => {
        const disabled = new Set<string>();
        const { provider } = switchOf(disabled);
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([callTool('r1', 'toolRequest', '{"names":["write","read"]}'), answer('one')], seen)) },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false,
            toolSettings: provider
        });

        await writer('go');

        // Request 1: nothing discovered yet, so only the runtime control + the core entry.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'tasks', 'glob']);

        // Request 2: discovery enabled BOTH searchable names, newest-selected-first.
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'tasks', 'glob', 'write', 'read']);

        // The operator click: `write` goes off. Same harness object, same registration,
        // and the NEXT request is rebuilt from live state (`declared()` in ../harness.ts).
        disabled.add('write');

        await writer('again');

        expect(declaredNames(seen[2])).toEqual(['toolRequest', 'tasks', 'glob', 'read']);

        // Back on, and the session-wide enabled set still holds it: nothing was lost by the
        // switch, because a disabled tool stays REGISTERED.
        disabled.delete('write');

        await writer('back');

        expect(declaredNames(seen[3])).toEqual(['toolRequest', 'tasks', 'glob', 'write', 'read']);
    });

    it('leaves the declaration list identical when no provider is wired', async () => {
        const withSwitch: HarnessStreamRequest[] = [];
        const withoutSwitch: HarnessStreamRequest[] = [];

        const script = (): HarnessStreamEvent[][] => [
            callTool('r1', 'toolRequest', '{"names":["write","read"]}'),
            answer('one')
        ];

        const plain = harness({
            agents: { writer: brain(scripted(script(), withoutSwitch)) },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false
        });

        const switched = harness({
            agents: { writer: brain(scripted(script(), withSwitch)) },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false,
            toolSettings: switchOf(new Set<string>()).provider
        });

        await plain('go');
        await switched('go');

        // An EMPTY disabled set answers exactly like an absent provider: the pre-R3 shape.
        expect(declaredNames(withSwitch[1])).toEqual(declaredNames(withoutSwitch[1]));
        expect(declaredNames(withoutSwitch[1])).toEqual(['toolRequest', 'tasks', 'glob', 'write', 'read']);
    });
});

describe('R3 — the global tool switch: the launch gate', () => {
    it('answers a call to a disabled name with one stable, readable tool result', async () => {
        const disabled = new Set<string>(['write']);
        const seen: HarnessStreamRequest[] = [];

        const primary = brain(
            scripted(
                [
                    // The model guesses `write` by name — the defence-in-depth case the
                    // declaration filter alone cannot cover.
                    callTool('c1', 'write', '{}'),
                    answer('done')
                ],
                seen
            )
        );

        const writer = harness({
            agents: { writer: primary },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false,
            toolSettings: switchOf(disabled).provider
        });

        const result = await writer('go');

        // The run SURVIVES: a disabled tool is a refusal the model can read and adapt to,
        // not a harness failure.
        expect(result.content).toBe('done');

        // The exact sentence, in one place in ../harness.ts, so discovery and this gate can
        // never state two different reasons for one name.
        expect(toolResult(primary.messages, 'c1')).toBe('Tool "write" is disabled on this server by the operator.');

        // `write` never executed: the transcript carries the refusal, not the tool's value.
        expect(primary.messages.some((message) => message.role === 'tool' && message.content === 'written')).toBe(false);
    });

    // The two gates must not disagree, and their ORDER is pinned: an out-of-scope call
    // keeps reporting its allowlist (the pre-existing answer), and a call the allowlist
    // NAMES but the operator switched off gets the switch's reason. Scope first, then the
    // global switch — the narrower (per-run) refusal wins, exactly as the declaration
    // filter composes the same two rules in ../harness.ts `declared()`.
    const scopedChild = (
    scope: string[],
    disabled: Set<string>
): { writer: ReturnType<typeof harness>; child: ReturnType<typeof brain> } => {
        const seen: HarnessStreamRequest[] = [];
        const child = brain(
            scripted([callTool('c1', 'write', '{}'), answer('adapted')], seen)
        );

        const writer = harness({
            agents: {
                writer: brain(
                    scripted([
                        callTool(
                            'd1',
                            'delegate',
                            `{"agent":"child","input":"write it","scope":{"tools":${JSON.stringify(scope)}}}`
                        ),
                        answer('outer')
                    ])
                ),
                child
            },
            primary: 'writer',
            subagents: ['child'],
            tools: { ...capabilities },
            presets: false,
            ...(disabled.size === 0 ? {} : { toolSettings: switchOf(disabled).provider })
        });

        return { writer, child };
    };

    it('reports the per-run scope refusal for a call its allowlist hides, even when the name is also disabled', async () => {
        const { writer, child } = scopedChild(['read'], new Set<string>(['write']));

        const result = await writer('go');

        expect(result.content).toBe('outer');
        // The refusal is the CHILD's, because the scoped run is the one that owns the call.
        expect(toolResult(child.messages, 'c1')).toBe('Tool "write" is outside this run\'s scope. Allowed: read.');
    });

    it('refuses a call the allowlist NAMES but the operator switched off', async () => {
        const { writer, child } = scopedChild(['read', 'write'], new Set<string>(['write']));

        const result = await writer('go');

        expect(result.content).toBe('outer');
        expect(toolResult(child.messages, 'c1')).toBe('Tool "write" is disabled on this server by the operator.');
    });

    it('lets the same in-scope call through once the switch is flipped back', async () => {
        const disabled = new Set<string>(['write']);
        const { writer, child } = scopedChild(['read', 'write'], disabled);

        // Live provider: the same harness re-decides per launch, so a re-enable needs no
        // rebuild — the delegated child's NEXT call honours it.
        const first = await writer('go');

        expect(first.content).toBe('outer');
        expect(toolResult(child.messages, 'c1')).toBe('Tool "write" is disabled on this server by the operator.');

        disabled.delete('write');

        const second = await writer('again');

        expect(second.content).toBe('outer');
    });
});

describe('R3 — the global tool switch: discovery answers honestly', () => {
    it('reports a disabled match as forbidden and never enables it session-wide', async () => {
        const disabled = new Set<string>(['write']);
        const seen: HarnessStreamRequest[] = [];

        const primary = brain(
            scripted([callTool('r1', 'toolRequest', '{"names":["write"]}'), answer('done')], seen)
        );

        const writer = harness({
            agents: { writer: primary },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false,
            toolSettings: switchOf(disabled).provider
        });

        await writer('go');

        // The exact discovery envelope: NOT `enabled: ["write"]` (the lie that made a scoped
        // child loop, T11) — an explicit denial with the switch's own reason, and the
        // session-wide enabled set untouched, which is what the NEXT request proves.
        expect(JSON.parse(toolResult(primary.messages, 'r1'))).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        'Tool "write" is disabled on this server by the operator. Requesting it again will not change this answer — adapt to the available tools or report the limitation.',
                    allowed: []
                }
            ]
        });

        // `read` is still reachable through discovery for this same session: the switch is
        // per name, and one denied match does not poison the answer beside it.
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'tasks', 'glob']);
    });

    it('keeps the in-scope path byte-identical for a name the switch does not list', async () => {
        const seen: HarnessStreamRequest[] = [];

        const primary = brain(
            scripted([callTool('r1', 'toolRequest', '{"names":["read"]}'), answer('done')], seen)
        );

        const writer = harness({
            agents: { writer: primary },
            primary: 'writer',
            tools: { ...capabilities },
            presets: false,
            toolSettings: switchOf(new Set<string>(['write'])).provider
        });

        await writer('go');

        // The historical shape: enabled + tools + matched, and NO `forbidden` key at all.
        const discovery = JSON.parse(toolResult(primary.messages, 'r1')) as Record<string, unknown>;

        expect(discovery.enabled).toEqual(['read']);
        expect(discovery.matched).toBe(1);
        expect(discovery.omitted).toBe(0);
        expect(Object.hasOwn(discovery, 'forbidden')).toBe(false);
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'tasks', 'glob', 'read']);
    });
});
