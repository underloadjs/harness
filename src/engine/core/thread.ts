// Persistent agent threads (R2).
//
// TERMINOLOGY (R1). The package has three levels, and this module owns the
// middle one:
//   - HARNESS — the callable execution loop. It provides AGENTS; it is not a
//     session and it does not own memory by itself.
//   - SESSION — server-controlled shared memory (one harness instance + the
//     record stores + snapshot/restore). See server/sessions.ts (downstream).
//   - THREAD  — one persistent, agent-owned conversation. A thread has a stable
//     id and its OWN transcript, while sharing this harness's tools, todo list,
//     profiles, chapters, locations, discovery state, and creation budget.
//
// Two kinds of thread exist at runtime (../harness.ts owns the records):
//   - 'agent' — the agent's default conversation, whose transcript IS the
//     registry Agent's `messages`. Delegation and ctx.run keep writing there, so
//     historical behaviour (a delegated agent accumulates its conversation across
//     delegations) is preserved, and `sendThreadInput` resumes it.
//
// THREADS ARE NEVER RANK-GATED. Threading is the SAME agent running more than one
// conversation in parallel, not a delegation to another agent, so nothing in this
// module (or in ../harness.ts' thread doors) consults an agent's rank: a Rank C agent
// opens threads exactly as a Rank A one does. Rank only PROPAGATES — a thread's, a
// branch's, a fork's or a restored conversation's agent carries its source's rank.
//   - 'host'  — an ADDITIONAL, independent conversation created by
//     `harness.createThread`. It is backed by a fresh Agent instance built from
//     the same configuration (instructions + seed messages + transport + current
//     model), so two host threads of the SAME agent run concurrently without
//     touching each other's history.
//
// Cross-references:
//   - ./agent.ts        — registers the internal thread factory on every Agent
//   - ../types/index.ts — HarnessThreadRecord / HarnessThreadSnapshot
//   - ../harness.ts     — thread records, scheduling, steering, stop, delete
//   - ./metadata.ts     — THREAD_SEND_METADATA (the cross-thread chat tool)

import { HarnessError } from '../util';
import type { Agent } from '../types';

// Thread ids are prefixed by kind so a reader can tell a default conversation
// from an explicitly created one without a lookup.
export const THREAD_AGENT_PREFIX = 'agent:';
export const THREAD_HOST_PREFIX = 'thread-';

// Display-label bound shared with the branch labels (core/branch.ts). Long
// enough for a short title, short enough that a persisted record stays small.
export const MAX_THREAD_LABEL_CHARS = 120;

// Snapshot bound: a session that opens more conversations than this cannot be
// persisted in one snapshot. It is deliberately generous (a thread is a whole
// conversation, so a real session is orders of magnitude below it) and exists so a
// corrupt or adversarial snapshot cannot force unbounded validation work.
export const MAX_THREAD_RECORDS = 256;

// The id of an agent's DEFAULT conversation. Stable for the lifetime of the
// harness and relative to the agent NAME, so a snapshot/restore does not need to
// persist the default records at all: they are rebuilt from `agents` on restore.
export const defaultThreadIdOf = (agentName: string): string => `${THREAD_AGENT_PREFIX}${agentName}`;

// Normalize a host-provided thread label. `undefined` stays undefined so the
// record keeps its minimal shape; an explicit blank label is a caller mistake and
// is reported instead of being silently dropped.
export const normalizeThreadLabel = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new HarnessError('A thread label must be a string.');

    const label = value.trim();
    if (label.length === 0) throw new HarnessError('A thread label must not be blank.');
    if (label.length > MAX_THREAD_LABEL_CHARS) {
        throw new HarnessError(
            `A thread label is at most ${MAX_THREAD_LABEL_CHARS} characters; received ${label.length}.`
        );
    }

    return label;
};

// ---------------------------------------------------------------------------
// Thread ADDRESSES (session-wide read/lookup)
// ---------------------------------------------------------------------------
//
// WHY A LABEL IS AN ADDRESS
// -------------------------
// A conversation has two names. `thread-32` is the machine id the runtime mints;
// `IT14` is the label the SERVER mints for it (a per-agent two-letter code plus a
// per-agent conversation ordinal — see `server/sessions.ts` `mintThreadLabel`), and
// it is the name a human — and therefore a prompt — actually uses. Until now only
// the id was addressable: a model told to "review the IT14 thread" had no door to
// IT14 through, because the label lived in the server's `SessionRecord.threadLabels`
// map, which no harness read consulted, and the roster it was pointed at did not
// even list the conversation (a sibling is outside its lineage by design).
//
// THE RULE, stated exactly:
//   - an address is an id (`thread-N`, `agent:<name>`, `branch-N`) or a label;
//   - an ID WINS. It is matched first and verbatim, so a label that happens to
//     equal another conversation's id can never shadow it;
//   - a label is matched EXACTLY after trimming — no case folding, no prefix, no
//     fuzzy match. `it14` does not find `IT14`, and `IT1` does not find `IT14`.
//     Parameter values are never fuzzy-matched anywhere else in this system
//     (discovery fuzziness applies to tool NAMES only), and a prefix rule would
//     silently pick one of two labels a caller cannot see apart;
//   - a label that matches NOTHING is reported as an unknown address, not as a
//     bad label: "no such conversation" and "no such label" are the same fact to a
//     caller holding a name it was given.
//
// UNIQUENESS is a property of the label SPACE, not of this function: the server
// mints `<code><ordinal>` from a monotonic per-code high-water that deletion never
// lowers (`threadLabelHighWater`), so two live conversations cannot share a label.
// A hand-set label is NOT guaranteed unique, so a lookup that finds more than one
// candidate refuses rather than guessing — the same "never pick one arbitrarily"
// rule the record store applies to an ambiguous id.
export type ThreadAddressCandidate = { id: string; label?: string };

// Resolve one address to a thread id, or `undefined` when nothing matches.
// `ambiguous` is reported through the callback rather than as a throw so the
// caller can phrase its own refusal with the ids it actually holds.
export const resolveThreadAddressOf = (
    address: string,
    candidates: Iterable<ThreadAddressCandidate>,
    onAmbiguous?: (address: string, ids: string[]) => void
): string | undefined => {
    const wanted = address.trim();
    if (wanted.length === 0) return undefined;

    // (1) An id, verbatim. First, so a label can never shadow an id.
    for (const candidate of candidates) {
        if (candidate.id === wanted) return candidate.id;
    }

    // (2) A label, exact after trimming. Collect every match before deciding, so a
    // duplicate label is refused instead of resolved to whichever record came first.
    const matches: string[] = [];
    for (const candidate of candidates) {
        if (candidate.label !== undefined && candidate.label.trim() === wanted) matches.push(candidate.id);
    }

    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];

    onAmbiguous?.(wanted, matches);
    // Ambiguous is NOT a resolution: the caller's callback throws. Returning the
    // first id keeps this function total for a caller that passed no callback.
    return matches[0];
};

// ---------------------------------------------------------------------------
// Thread-agent factory
// ---------------------------------------------------------------------------

// A thread needs an Agent with the SAME brain definition and an EMPTY
// conversation. The configuration (provider credentials, stream, seed messages)
// lives in the agent closure, so the factory is registered there and looked up
// through a WeakMap: no field is added to the public Agent shape, exactly like the
// branch forker in core/branch.ts.
type ThreadAgentFactory = () => Agent;

const threadFactories = new WeakMap<Agent, ThreadAgentFactory>();

export const registerAgentThreader = (agent: Agent, factory: ThreadAgentFactory): void => {
    threadFactories.set(agent, factory);
};

// Build the backing Agent for a NEW host thread. Throws for an Agent that was not
// produced by this package's factory (a hand-built object), because a thread can
// only be isolated if the runtime can construct a sibling brain.
export const createThreadAgent = (source: Agent): Agent => {
    const factory = threadFactories.get(source);

    if (factory === undefined) {
        throw new HarnessError(
            `Agent "${source.name}" cannot own an independent thread: it was not created by agent().`
        );
    }

    return factory();
};
