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
//     historical behaviour (a subagent accumulates its conversation across
//     delegations) is preserved, and `sendThreadInput` resumes it.
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
