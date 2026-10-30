// Independently compilable source entry for the `testFlaky` app tool.
//
// R2: imports only the shared `tool` helper. The harness id stays `flaky`; only the
// TOOL is testFlaky.
//
// Deliberately unreliable: fails twice, succeeds on the third call. It exists so
// the recoverable-failure path is visible — the harness feeds the error back as a
// tool result and the model gets another turn.
//
// STATE AND REPLACEMENT (task-harness-self-modifying-tools §2/§3):
// The attempt store is per AGENT and lives in HARNESS-OWNED MEMORY whenever the
// tool runs inside a harness (`context.harness.memory`). A runtime-compiled
// replacement therefore keeps counting the same agents instead of starting over;
// only an already-captured old invocation keeps its old implementation.
//
// A standalone direct `testFlaky()` call has no harness, so it falls back to this
// module's WeakMap/direct counter. That fallback is documented and deliberate: a
// direct call is not part of a harness registry, so there is no stable harness
// memory to attach to. It is deliberately not a factory: the preset/toolbox
// registry shares this singleton on purpose, and the WeakMap is what makes sharing
// safe across agents of an imported entry.

// `core` is the harness-internal live helper entry (see ./timeNow.ts): the source
// compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// Memory slot for the WeakMap itself (not for per-agent counters directly), so the
// existing WeakMap semantics and automatic garbage collection are preserved while
// the MAP is owned by the harness and survives implementation replacement.
const FLAKY_ATTEMPTS_MEMORY_KEY = 'testFlaky:attempts';

// Fallback state when there is no harness (direct calls, and the standalone
// imported app entry used by tests before a harness runs it).
const moduleFlakyAttempts = new WeakMap<object, number>();
let directFlakyAttempts = 0;

// Minimal structural view of the harness memory used by this source entry. It
// avoids importing the whole Harness type into an independently compiled module.
type HarnessMemoryView = {
    memory: {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => void;
    };
};

// Resolve the per-harness attempt store. The WeakMap is created once per harness
// and cached in harness-owned memory; a replacement module reads the SAME object
// because memory belongs to the harness, not to the module instance.
const attemptsOf = (harness: HarnessMemoryView | undefined): WeakMap<object, number> => {
    if (harness === undefined) return moduleFlakyAttempts;

    const stored = harness.memory.get(FLAKY_ATTEMPTS_MEMORY_KEY);

    if (stored instanceof WeakMap) return stored as WeakMap<object, number>;

    const created = new WeakMap<object, number>();
    harness.memory.set(FLAKY_ATTEMPTS_MEMORY_KEY, created);
    return created;
};

// Count one attempt for this caller: the agent object inside a harness, or the
// single module fallback for a direct call (and for any future context that does
// not carry an agent). State is per AGENT, not per process (R8): a process-wide
// counter made two sessions share one attempt count, so session A's failures could
// "heal" session B's first call.
const nextFlakyAttempt = (agent: unknown, harness: HarnessMemoryView | undefined): number => {
    const key = agent !== null && (typeof agent === 'object' || typeof agent === 'function') ? agent : undefined;

    if (key === undefined) {
        directFlakyAttempts += 1;
        return directFlakyAttempts;
    }

    const attempts = attemptsOf(harness);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return attempt;
};

const testFlaky = tool<Record<string, never>, string>({
    description:
        'A deliberately unreliable tool. It throws on the first two calls of every three. Call it again after a failure; the error is returned to you as a tool result.',
    tags: ['reliability', 'retry', 'testing'],
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    },
    execute: ({ agent, harness }) => {
        const attempt = nextFlakyAttempt(agent, harness);

        if (attempt % 3 !== 0) {
            throw new Error(`Temporary failure (attempt ${attempt}). Retry the same call.`);
        }

        return `Success on attempt ${attempt}.`;
    }
});

export { testFlaky };
export default testFlaky;
