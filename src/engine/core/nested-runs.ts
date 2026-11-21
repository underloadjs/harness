// T14: the nested-run POLICY — one place for the limitation's code, its sentence, and its
// validated arm, so the core runtime guard, the lane worker, the capability report and the docs
// cannot drift apart.
//
// WHY THE POLICY LIVES IN THE CORE
// --------------------------------
// A lane worker can already close the two doors IT owns: `refuseNestedRuns` deletes the
// `delegate`/`threadFork` registry entries and replaces `harness.runtime.delegate` with a thrower
// (../server/workers/lane-worker-loop.ts). What that does NOT reach is the door a tool body
// actually holds: `context.run(name, input)` — plus its destructured/aliased spellings — is built
// by the CORE at every tool invocation (../harness.ts), so only the core can refuse it before a
// child exists. This module is that seam: the worker ARMS the policy on its replica, and the core
// closes every door the arm covers.
//
// WHY REFUSE RATHER THAN RUN IT PRIVATELY
// ---------------------------------------
// A nested conversation started inside a lane is invisible to the canonical session: its thread
// record and its transcript live only in that lane's replica, and a lane commit publishes just the
// target conversation's tail, its declared memory window and its terminal result archives
// (../server/workers/lane-worker-loop.ts `deriveOperations`). Adopting a thread by an EXISTING id
// needs a core seam the authority does not have. So the honest answer is a NAMED refusal raised
// before the child, its transcript or its provider request exist — the same reasoning that makes
// `delegate`/`threadFork` refusions rather than private copies (see
// ../server/workers/capability.ts `NESTED_RUN_TOOL_NAMES`).
//
// WHAT THE ARM COVERS, AND WHAT IT DOES NOT CLAIM
// -----------------------------------------------
// The arm is a runtime guard on the SURFACES, not a sandbox. A refusing instance builds every tool
// context out of guarded members (`toolHandleView`, `toolAgentsView`, the guarded `run` closure in
// ../harness.ts), so each door throws whenever it is reached — including from a callback, a timer or
// a module-scope capture the body kept after its own invocation settled. That is what makes the
// refusal permanent rather than a stack window, and it is why the capability report's per-body door
// scan (../server/workers/capability.ts) is a LENS and not the guarantee: a computed member or a
// renamed context parameter misses the pattern, and the armed surfaces refuse it anyway.
//
// The one surface no context view can wrap is a RAW handle a HOST-DEFINED closure captured in its
// own scope (a preset factory's tool, whose body is never scanned — reported as `closure-definition`
// and covered by the `toolBodiesRunning` backstop while a body runs). A harness that is only a
// factory closure cannot be rebuilt on a lane at all, so worker mode refuses it outright
// (`preset-not-rebuildable`) instead of running it with an unknown policy.
//
// Cross-references:
//   - ../types/index.ts                        NestedRunPolicy, Harness.nestedRuns, ToolContext.nestedRuns
//   - ../harness.ts                            the doors that raise `nestedRunUnsupportedError`
//   - ../server/workers/lane-worker-loop.ts    who arms 'refuse' (and what it removes first)
//   - ../server/workers/capability.ts          the hello report + the textual door scan

import { HarnessError } from '../util';
import type { NestedRunPolicy } from '../types';

// The stable machine name of the limitation. It is the capability code in the lane handshake, the
// error `name` of every refusal, and the first token of every refusal message, so the model, the
// HTTP surface, the worker report and the operator all quote ONE identifiable name.
export const NESTED_RUN_LIMITATION_CODE = 'nested-run-unsupported';

// The accepted policy values, as data (the type is `NestedRunPolicy` in ../types).
export const NESTED_RUN_POLICIES = ['allow', 'refuse'] as const;

// The refusal sentence. `door` names WHAT was refused in the words the reader holds:
// `Tool "delegate"` for a registry entry, `context.run("summarizer")` for a tool body,
// `harness.agents.writer.turn()` for a sibling brain. One formatter means the hello warning, the
// capability limitation and the thrown refusal cannot state three different guarantees.
export const nestedRunRefusalMessage = (door: string): string =>
    `${NESTED_RUN_LIMITATION_CODE}: ${door} starts a nested conversation, and worker mode does not centralise nested conversation state: the child thread record and its transcript would live only in this lane's replica. Run this session with threadExecution "inline" to use it. Cross-thread work stays available in worker mode (threadRead, threadSend, threadList).`;

// The error every armed door throws. The message is named (the code is its first token) so a tool
// result that reaches the model still says WHICH limitation fired and what to change; `name` is
// set too, so a host that catches it can classify without parsing prose.
export const nestedRunUnsupportedError = (door: string): HarnessError => {
    const error = new HarnessError(nestedRunRefusalMessage(door));

    error.name = NESTED_RUN_LIMITATION_CODE;

    return error;
};

// Validate a policy written through `harness.nestedRuns`. Values are checked, never coerced: an
// armed replica whose typo read back as 'allow' would silently run nested children against a
// private copy of the session, which is the exact defect this seam closes.
export const assertNestedRunPolicy = (value: unknown): NestedRunPolicy => {
    if (!(NESTED_RUN_POLICIES as readonly unknown[]).includes(value)) {
        throw new HarnessError(
            `nestedRuns must be one of: ${NESTED_RUN_POLICIES.map((entry) => `"${entry}"`).join(', ')}; received ${String(value)}.`
        );
    }

    return value as NestedRunPolicy;
};
