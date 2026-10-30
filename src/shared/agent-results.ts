// Result references shared by the server and the browser client.
//
// A "block" is ONE agent invocation inside a submitted turn: the turn's root
// invocation (the entry agent) or a nested/subagent invocation identified by the
// runtime's `HarnessThread.id`. The UI renders each block with a compact label
// (`IT1`, `RH2`, … — first+last letter of the agent id plus its occurrence, see
// ui/agent-label.ts). Occurrence numbering is CONVERSATION-scoped: it continues
// across the session's turns in recorded order, so two distinct invocations of the
// same agent never share a label (`RR1`/`RR2`), even across turns.
//
// A user can type `#IT1` in a NEW prompt to reference the completed result of a
// prior block. The reference is resolved against the SERVER's recorded turns (not
// the live agent transcript), and the completed `done` content is appended to the
// run prompt inside a clearly delimited section. This module is the one definition
// of:
//   - the label allocator (same deterministic rules the UI uses),
//   - the block projection from recorded `HarnessEvent`s,
//   - label-token parsing from a typed prompt,
//   - structural validation of a persisted/submitted reference list,
//   - the delimited prompt composition.
//
// It is isomorphic (types only + pure functions), so `src/shared/index.ts` can
// re-export it to both the Node server and the browser frontend. The frontend's
// existing `ui/agent-label.ts` still owns its DOM allocation; it can adopt
// `createAgentLabels` from here without changing its public behaviour.
//
// Cross-references:
//   - ../server/protocol.ts        — SessionTurn.references / SubmitTaskRequest
//   - ../server/sessions.ts        — binds references at enqueue, expands at execution
//   - ../server/persistence.ts     — validates persisted references through here
//   - ../frontend/ui/agent-label.ts — the UI allocator whose rules this mirrors
//   - ../frontend/ui/turns.ts      — the block projection this mirrors

import type { HarnessEvent } from '../harness';

// One reference a client submits with a task (or the server derives from a typed
// `#LABEL`). `threadId` omitted means the ROOT block of `turnId`; a nested block
// names the runtime thread id recorded on its events.
export type AgentResultReference = {
    turnId: string;
    threadId?: string;
    // Normalised display label, e.g. `IT1`. Uppercase two letters (the fallback
    // `AG`) followed by the occurrence; occurrences are conversation-scoped (they
    // continue across the session's turns), so a label identifies one block.
    label: string;
};

// Status of one block. `queued` is included because a turn can be recorded before
// execution (the queue) and the UI may want to list it; a block only exists once
// the turn has events, which normally means it is running or terminal.
export type AgentResultStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

// One listable block. This is the descriptor the frontend/UI needs for a result
// picker, and the shape the server resolves a reference against.
export type AgentResultBlock = {
    turnId: string;
    // Absent for the root invocation. A nested invocation carries its CURRENT
    // identity: the runtime `thread.id` once known, otherwise the UI's stable
    // synthetic key (`call:<callId>` for a pending delegation, `inline:<agent>`
    // for a threadless legacy stream). Lookups also accept aliases the block used
    // earlier (e.g. `call:<callId>` after adoption).
    threadId?: string;
    label: string;
    // The agent id that produced the block (never displayed raw by the UI).
    agent: string;
    status: AgentResultStatus;
    // The terminal `done` assistant content, present only for a `done` block that
    // actually recorded one. A failed/cancelled block has no usable content.
    content?: string;
};

// The minimal turn shape the helpers need. `SessionTurn` is structurally
// assignable, so the server and frontend can pass their recorded turns directly.
export type AgentResultTurn = {
    id: string;
    status: AgentResultStatus;
    events: readonly HarnessEvent[];
    // R6 deletion: the conversation-scoped label counters AT THE START of this
    // turn (code -> last occurrence), as recorded when the turn was created (see
    // `collectAgentLabelCounters`). Optional because a legacy turn (and every
    // record persisted before threads) has none; such a turn simply continues the
    // chained allocator, which is the pre-deletion behaviour.
    //
    // WHY: occurrence numbering normally continues from every EARLIER turn, so
    // deleting a thread (and its turns) would renumber the surviving blocks
    // (`RR2` becoming `RR1`) and break a typed `#LABEL`. Seeding the allocator from
    // the recorded start state keeps a surviving turn's labels stable, and
    // `seed()` never lowers a counter, so a normal (undeleted) prefix is unaffected.
    labels?: Readonly<Record<string, number>>;
};

// One block plus the content to inject, as composed into a run prompt.
export type AgentResultContentEntry = {
    block: AgentResultBlock;
    content: string;
};

// Bounds. A submission may reference at most this many blocks; each block's
// injected content is truncated to the per-block bound; and the WHOLE composed
// run prompt (raw prompt + wrappers + content + truncation notices) is capped at
// MAX_REFERENCE_TOTAL_CHARS, the same ceiling as a raw prompt. Truncation is
// EXPLICIT (a visible marker), never a silent loss of text.
export const MAX_AGENT_REFERENCES = 16;
export const MAX_REFERENCE_CONTENT_CHARS = 100_000;
export const MAX_REFERENCE_TOTAL_CHARS = 200_000;

// A valid block label: exactly two ASCII LETTERS (the allocator's first+last
// letter, or `AG` for a name with no ASCII letters) plus the conversation-scoped
// occurrence count. Digits inside an agent id are ignored by the allocator, so
// every emitted label satisfies this grammar; it also keeps a typed issue number
// (`#1234`) from looking like a reference.
export const AGENT_REFERENCE_LABEL_PATTERN = /^[A-Z]{2}\d+$/;

// Delimiters of the injected context. Exported so tests and clients can assert
// the exact wire prompt without re-typing the literal.
export const REFERENCED_RESULTS_HEADER = '[referenced results - read-only context for this request]';
export const REFERENCED_RESULTS_FOOTER = '[end referenced results]';

// Exact rejection text when the raw prompt + section wrappers + content cannot be
// made to fit the combined budget. The composer never truncates the USER prompt.
export const REFERENCED_RESULTS_BUDGET_MESSAGE = `The referenced results cannot fit within the ${MAX_REFERENCE_TOTAL_CHARS}-character combined prompt limit.`;

// Normalise one typed/persisted label. Returns undefined when it is not a label
// this system can produce, so callers reject rather than "guess" a near match.
export const normalizeAgentLabel = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    // Accept the composer's typed spelling (`#it1`) as well as a bare label.
    const label = value.trim().replace(/^#/, '').trim().toUpperCase();
    return AGENT_REFERENCE_LABEL_PATTERN.test(label) ? label : undefined;
};

// Canonical identity used by the allocator: trimmed + lower-cased (identical to
// `agentKeyOf` in ../frontend/ui/agent-color.ts).
const agentKeyOf = (agent: string | undefined): string => (agent ?? '').trim().toLowerCase();

// First + last ASCII LETTER of the normalised id, uppercased. Digits and all other
// glyphs are ignored, so a digit in a name can never break the `[A-Z]{2}\d+` label
// grammar. A one-letter id yields the same letter twice (`a` → `AA`); an id with
// no ASCII letters falls back to `AG`. This is intentionally ASCII-only: a
// non-Latin name cannot produce a stable two-letter code, so it shares the
// neutral fallback sequence (the real agent id stays available on the block).
const FALLBACK_CODE = 'AG';
const ASCII_LETTER = /[a-z]/;
const codeOf = (key: string): string => {
    const letters = Array.from(key).filter((glyph) => ASCII_LETTER.test(glyph));
    if (letters.length === 0) return FALLBACK_CODE;

    return `${letters[0]}${letters[letters.length - 1]}`.toUpperCase();
};

export type AgentLabels = {
    next: (agent: string | undefined) => string;
    reset: () => void;
    // Continue an EXISTING sequence: raise every per-code occurrence to at least
    // the seeded value. Seeding never lowers a counter, so a late seed cannot
    // renumber a label an allocator already minted. Used to continue numbering
    // across turns (a new tile seeds from the previous tiles' allocations).
    seed: (counters: ReadonlyMap<string, number>) => void;
    // Snapshot of the per-code occurrence counters (code -> last used number),
    // detached so a caller can seed a later allocator without aliasing this one.
    counters: () => Map<string, number>;
};

// Shared label allocator. SEMANTICS (conversation-scoped as of the duplicate-label
// fix; the per-code rules are frozen from T7):
//   - the code is the first+last ASCII LETTER (or `AG`);
//   - occurrence numbering is keyed by that TWO-LETTER CODE, not by the full agent
//     name, so id collisions share one sequence (`research` → `RH1`, `rhesearch`
//     → `RH2`) instead of silently producing duplicate labels;
//   - `next()` is called once per invocation (never per event) and `reset()` starts
//     a fresh sequence;
//   - `seed()` CONTINUES a sequence. The reference namespace is the whole
//     conversation (typed `#LABEL` resolves across turns), so the UI seeds each
//     turn's allocator from the turns before it and the projection chains one
//     allocator over the turn list. Two distinct threads of one agent therefore
//     read `RR1`/`RR2` instead of both restarting at `RR1`.
export const createAgentLabels = (initial?: ReadonlyMap<string, number>): AgentLabels => {
    const occurrences = new Map<string, number>();

    const adopt = (counters: ReadonlyMap<string, number>): void => {
        for (const [code, used] of counters) {
            if (used > (occurrences.get(code) ?? 0)) occurrences.set(code, used);
        }
    };

    if (initial !== undefined) adopt(initial);

    return {
        next(agent: string | undefined): string {
            const code = codeOf(agentKeyOf(agent));
            const occurrence = (occurrences.get(code) ?? 0) + 1;
            occurrences.set(code, occurrence);

            return `${code}${occurrence}`;
        },

        reset(): void {
            occurrences.clear();
        },

        seed(counters: ReadonlyMap<string, number>): void {
            adopt(counters);
        },

        counters(): Map<string, number> {
            return new Map(occurrences);
        }
    };
};

// One invocation while a turn is being replayed. The mutable fields mirror what
// the UI derives from the same events; the exported block is a detached copy.
type ReplayBlock = {
    agent: string;
    label: string;
    // The identity a UI descriptor would carry RIGHT NOW: the runtime `thread.id`
    // once known, otherwise the stable synthetic key (`call:<callId>` for a
    // pending delegation, `inline:<agent>` for a threadless legacy block).
    threadId: string | undefined;
    // Set only when the runtime actually named this invocation. Adoption tests
    // this (not `threadId`, which already holds the synthetic alias).
    runtimeThreadId: string | undefined;
    callId: string | undefined;
    // Every identity this block has ever had. A reference bound while the block
    // was pending (`call:<callId>`) still resolves after adoption to `thread.id`.
    aliases: string[];
    started: boolean;
    status: AgentResultStatus;
    terminal: boolean;
    content: string | undefined;
    lastDone: string | undefined;
};

// A projected block plus its non-wire alias list. Public helpers strip `aliases`,
// but lookups use them so an old stable binding keeps working.
type ProjectedBlock = AgentResultBlock & { aliases: string[] };

// Parse `agentDelegate` arguments for the legacy placeholder: a delegation's
// spawning call is the only evidence of the child block when its `thread` metadata
// is absent. Only a complete `{agent, input}` pair is usable.
const delegateOf = (rawArguments: string): { agent: string; input: string } | undefined => {
    try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

        const agent = (parsed as { agent?: unknown }).agent;
        const input = (parsed as { input?: unknown }).input;
        if (typeof agent !== 'string' || agent.length === 0) return undefined;
        if (typeof input !== 'string') return undefined;

        return { agent, input };
    } catch {
        return undefined;
    }
};

// Project ONE recorded turn into its listable blocks.
//
// `labels` is passed in so a caller can CHAIN the allocator across turns: the
// reference namespace is the whole conversation, so occurrence numbers continue
// from the previous turn rather than restarting at 1. A single-turn caller gets a
// fresh allocator (its labels start at 1).
//
// The replay follows the event order the UI uses, because labels depend on it:
//   - the root block is created by the first event routed to it and consumes the
//     first occurrence of the entry agent;
//   - an `agentDelegate` tool_call creates its child placeholder IMMEDIATELY (the
//     label is allocated when the call is seen), and the child `start` ADOPTS that
//     placeholder when it carries the same `callId`;
//   - an explicit `thread` start without a placeholder allocates a block then;
//   - legacy events without `thread` metadata keep one flat `inline:<agent>`
//     block per agent, exactly like the UI's fallback.
//
// Status rules: a `done` with no pending work is terminal; an `error` is terminal;
// a `branch_end` maps completed/failed/cancelled; the parent's `tool_result` for a
// spawning call completes an unstarted/queued child. At the end the TURN status is
// authoritative for the root (and closes children the record left running).
const blocksOfTurn = (
    turn: AgentResultTurn,
    labels: AgentLabels = createAgentLabels()
): ProjectedBlock[] => {
    // Deletion-safe numbering (R6): continue from THIS turn's recorded start
    // counters. `seed` only raises a counter, so a live/undeleted prefix (whose
    // chained allocator is already at or above this state) is unchanged, while a
    // surviving turn whose earlier turns were deleted keeps its original labels.
    if (turn.labels !== undefined) labels.seed(new Map(Object.entries(turn.labels)));

    const blocks: ReplayBlock[] = [];
    const byThread = new Map<string, ReplayBlock>();
    const byCall = new Map<string, ReplayBlock>();
    const byInline = new Map<string, ReplayBlock>();

    let root: ReplayBlock | undefined;
    let primaryAgent: string | undefined;

    const createBlock = (
        agent: string,
        threadId: string | undefined,
        callId: string | undefined,
        aliases: string[] = []
    ): ReplayBlock => {
        const block: ReplayBlock = {
            agent,
            label: labels.next(agent),
            threadId,
            runtimeThreadId: undefined,
            callId,
            aliases: [...aliases],
            started: threadId !== undefined,
            status: 'running',
            terminal: false,
            content: undefined,
            lastDone: undefined
        };

        blocks.push(block);
        return block;
    };

    const rootBlock = (agent: string): ReplayBlock => {
        if (root !== undefined) return root;

        primaryAgent = agent;
        root = createBlock(agent, undefined, undefined);
        root.started = true;
        return root;
    };

    const inlineBlock = (agent: string): ReplayBlock => {
        const existing = byInline.get(agent);
        if (existing !== undefined) return existing;

        // The first flat agent of an unknown stream with no root yet IS the entry
        // agent (the pre-thread UI behaviour).
        if (root === undefined && primaryAgent === undefined) return rootBlock(agent);

        // A threadless legacy block keeps the UI's synthetic key, so a descriptor
        // captured from the transcript is a valid reference identity.
        const key = `inline:${agent}`;
        const block = createBlock(agent, key, undefined, [key]);
        block.started = true;
        byInline.set(agent, block);
        return block;
    };

    // Explicit `thread` metadata is authoritative.
    const blockForThread = (event: HarnessEvent): ReplayBlock => {
        const thread = event.thread;
        if (thread === undefined) throw new Error('unreachable: event has no thread');

        const known = byThread.get(thread.id);
        if (known !== undefined) return known;

        // Adopt a delegation placeholder created by the spawning tool call. The
        // placeholder was visible as `call:<callId>`; after adoption its CURRENT
        // identity is the runtime id, while the call key stays an alias.
        const placeholder = thread.callId === undefined ? undefined : byCall.get(thread.callId);
        if (placeholder !== undefined && placeholder.runtimeThreadId === undefined) {
            placeholder.threadId = thread.id;
            placeholder.runtimeThreadId = thread.id;
            byThread.set(thread.id, placeholder);
            placeholder.started = true;
            return placeholder;
        }

        const block = createBlock(event.agent, thread.id, thread.callId);
        block.runtimeThreadId = thread.id;
        byThread.set(thread.id, block);
        return block;
    };

    // Legacy routing (no `thread` metadata), mirroring ui/turns.ts entryForLegacy.
    const blockForLegacy = (event: HarnessEvent): ReplayBlock => {
        if (root !== undefined && event.agent === root.agent) return root;

        if (event.type === 'start') {
            // Oldest unstarted delegation placeholder for this agent is adopted by
            // a threadless child start (the UI keeps its call key in that case).
            for (const block of blocks) {
                if (block.started || block.callId === undefined) continue;
                if (block.runtimeThreadId !== undefined) continue;
                if (block.agent !== event.agent) continue;
                block.started = true;
                return block;
            }

            return inlineBlock(event.agent);
        }

        let found: ReplayBlock | undefined;
        let count = 0;
        for (const block of blocks) {
            if (block === root || !block.started) continue;
            if (block.agent !== event.agent) continue;
            if (block.terminal) continue;
            found = block;
            count += 1;
        }

        if (count === 1 && found !== undefined) return found;

        return inlineBlock(event.agent);
    };

    const route = (event: HarnessEvent): ReplayBlock => {
        // A `thread` field is present only for non-root INVOCATIONS, but TypeScript
        // knows the union variant; a plain property read keeps this simple and
        // honest.
        const thread = (
            event as {
                thread?: {
                    id: string;
                    parentId?: string;
                    callId?: string;
                    kind?: string;
                    branchId?: string;
                };
            }
        ).thread;
        if (thread === undefined) return blockForLegacy(event);

        // R1-R6: a HOST-thread run carries its invocation identity on EVERY frame
        // (that id maps the persistent thread to its events), but it is still the
        // turn's own ROOT conversation — not a nested child. Such an identity has
        // no parent, no spawning call, and no branch marker, so it routes to the
        // root block exactly like a threadless root event. Without this, the root
        // would never be allocated and the entry agent's answer would appear as a
        // child block under an id no reference uses.
        if (
            thread.parentId === undefined &&
            thread.callId === undefined &&
            thread.kind === undefined &&
            thread.branchId === undefined
        ) {
            return rootBlock(event.agent);
        }

        return blockForThread(event);
    };

    const complete = (block: ReplayBlock, status: AgentResultStatus, content?: string): void => {
        block.status = status;
        if (status === 'done') {
            if (content !== undefined) block.content = content;
        } else {
            block.content = undefined;
        }
        block.terminal = true;
    };

    for (const event of turn.events) {
        const block = route(event);

        switch (event.type) {
            case 'start':
                block.started = true;
                break;

            case 'tool_call': {
                // Queue a delegation placeholder when the call is made, so its
                // label is allocated in the same order the UI allocates it.
                if (event.call.name === 'agentDelegate') {
                    const delegate = delegateOf(event.call.arguments);
                    if (delegate !== undefined && !byCall.has(event.call.id)) {
                        // The pending descriptor identity is `call:<callId>` (what
                        // the UI shows); the same string is kept as an alias after
                        // adoption so a reference bound now still resolves.
                        const key = `call:${event.call.id}`;
                        const placeholder = createBlock(delegate.agent, key, event.call.id, [key]);
                        placeholder.started = false;
                        byCall.set(event.call.id, placeholder);
                    }
                }
                break;
            }

            case 'done': {
                const pending = event.pending;
                if (pending === undefined || pending.length === 0) {
                    complete(block, 'done', event.message.content);
                } else {
                    // Paused response: the run continues, so this is NOT terminal.
                    block.lastDone = event.message.content;
                }
                break;
            }

            case 'error':
                complete(block, 'error');
                break;

            case 'branch_end': {
                const status: AgentResultStatus =
                    event.status === 'completed' ? 'done' : event.status === 'failed' ? 'error' : 'cancelled';
                complete(block, status);
                break;
            }

            case 'tool_result': {
                // The parent's result for the spawning call is the authoritative
                // outcome of a child that never reported its own terminal event.
                if (event.callId === undefined) break;
                const child = byCall.get(event.callId);
                if (child === undefined) break;
                if (child.terminal) break;

                complete(child, event.isError ? 'error' : 'done');
                break;
            }

            default:
                break;
        }
    }

    // Turn status is authoritative for the root and closes an unfinished child.
    if (root !== undefined) {
        const status = turn.status;
        root.status = status;
        root.terminal = status !== 'queued' && status !== 'running';
        if (status !== 'done') root.content = undefined;
        else if (root.content === undefined && root.lastDone !== undefined) root.content = root.lastDone;
    }

    for (const block of blocks) {
        if (block === root || block.terminal) continue;
        if (turn.status === 'queued' || turn.status === 'running') {
            block.status = turn.status;
            continue;
        }

        block.status = turn.status;
        block.content = undefined;
    }

    return blocks.map((block) => ({
        turnId: turn.id,
        ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
        label: block.label,
        agent: block.agent,
        status: block.status,
        ...(block.status === 'done' && block.content !== undefined ? { content: block.content } : {}),
        aliases: [...block.aliases]
    }));
};

// Strip the internal alias list from a projected block before it leaves this
// module. The wire/UI descriptor shape stays exactly {turnId, threadId?, label,
// agent, status, content?}.
const publicBlock = (block: ProjectedBlock): AgentResultBlock => {
    const { aliases: _aliases, ...descriptor } = block;
    return descriptor;
};

// The allocator counters AFTER replaying every given turn, chained in recorded
// order — i.e. the state the NEXT turn starts from. The server records this as a
// turn's `labels` at creation, which is what lets a later deletion keep the
// surviving turns' labels stable (see AgentResultTurn.labels).
//
// Pass the conversation PREFIX up to (not including) the turn being created. The
// caller must supply turns in recorded order; `turns.labels` values already on the
// list are honoured, so computing a seed over a history that already carries seeds
// yields the same counters a live replay would.
export const collectAgentLabelCounters = (
    turns: readonly AgentResultTurn[]
): Map<string, number> => {
    const labels = createAgentLabels();
    for (const turn of turns) blocksOfTurn(turn, labels);

    return labels.counters();
};

// List every block across turns, oldest turn first and each turn's blocks in
// creation (label-allocation) order. ONE allocator is chained across the turns, so
// the labels are the conversation-scoped ones the UI shows (`RR1`, then `RR2` in a
// later turn) rather than each turn restarting at 1.
export const listAgentResultBlocks = (turns: readonly AgentResultTurn[]): AgentResultBlock[] => {
    const labels = createAgentLabels();

    return turns.flatMap((turn) => blocksOfTurn(turn, labels).map(publicBlock));
};

// Exact lookup for a submitted reference: `turnId` + `threadId` (or root) + label.
// `threadId` may be the block's CURRENT identity OR any stable alias it carried
// (`call:<callId>` for a delegation that has since adopted a runtime id,
// `inline:<agent>` for a threadless legacy block). A genuinely wrong id matches
// nothing and the caller rejects it.
//
// `turns` MUST be the conversation prefix in recorded order (all turns up to and
// including the target): occurrence numbering is conversation-scoped, so a block's
// label depends on the turns BEFORE it. Passing only the target turn numbers it as
// if it were the first turn and would resolve the wrong block (or none).
//
// A reference with NO threadId is the root signal. For compatibility with
// descriptors produced before aliases existed, a threadless reference whose label
// matches exactly ONE nested block resolves to that block; it never guesses when
// several match. The label must always match exactly.
export const findAgentResultBlock = (
    turns: readonly AgentResultTurn[],
    reference: Pick<AgentResultReference, 'turnId' | 'threadId' | 'label'>
): AgentResultBlock | undefined => {
    // Project the ordered prefix through the target: later turns cannot change an
    // earlier turn's labels, so they are not needed (and may be absent).
    const targetIndex = turns.findIndex((candidate) => candidate.id === reference.turnId);
    if (targetIndex === -1) return undefined;

    const label = normalizeAgentLabel(reference.label);
    if (label === undefined) return undefined;

    // One chained allocator across the prefix, exactly like listAgentResultBlocks.
    const labels = createAgentLabels();
    let blocks: ProjectedBlock[] = [];
    for (let index = 0; index <= targetIndex; index++) {
        blocks = blocksOfTurn(turns[index], labels);
    }

    const labelled = blocks.filter((block) => block.label === label);

    if (reference.threadId === undefined) {
        const root = labelled.find((block) => block.threadId === undefined);
        if (root !== undefined) return publicBlock(root);

        // Legacy/threadless fallback: only an unambiguous single match.
        if (labelled.length === 1) return publicBlock(labelled[0]);
        return undefined;
    }

    const wanted = reference.threadId;
    const match = labelled.find(
        (block) => block.threadId === wanted || block.aliases.includes(wanted)
    );

    return match === undefined ? undefined : publicBlock(match);
};

// Latest block with this label across the given turns. Typed `#LABEL` resolves to
// the newest matching prior block ("latest wins"). With conversation-scoped
// numbering a label identifies exactly ONE block in the given list, so this is an
// exact lookup in practice; the newest-first scan is kept as the defensive rule for
// a record whose history was rewritten. There is deliberately NO fallback to an
// older block when the latest one failed — the caller rejects instead of silently
// injecting an outdated result.
//
// `turns` must be the conversation prefix in recorded order (same reason as
// findAgentResultBlock): the allocator is chained over the whole list.
export const findLatestAgentResultBlock = (
    turns: readonly AgentResultTurn[],
    label: string
): AgentResultBlock | undefined => {
    const wanted = normalizeAgentLabel(label);
    if (wanted === undefined) return undefined;

    // Project every turn with ONE allocator so the labels are the conversation's.
    const labels = createAgentLabels();
    const projected = turns.map((turn) => blocksOfTurn(turn, labels));

    for (let index = projected.length - 1; index >= 0; index--) {
        const match = projected[index].find((block) => block.label === wanted);
        if (match !== undefined) return publicBlock(match);
    }

    return undefined;
};

// Typed `#LABEL` tokens in a prompt, unique and in occurrence order. Requires a
// boundary before `#` and after the digits, so a markdown heading (`#Intro`) or an
// issue number (`#123`) is not treated as a reference.
const REFERENCE_TOKEN = /(?:^|[\s([{<])#([A-Za-z]{2}\d+)(?=$|[\s)\]}>.,;:!?])/gm;

export const parseAgentReferenceLabels = (prompt: string): string[] => {
    const labels: string[] = [];
    // A fresh RegExp keeps the shared constant's `lastIndex` untouched across
    // calls (a global regex is stateful).
    const pattern = new RegExp(REFERENCE_TOKEN.source, REFERENCE_TOKEN.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(prompt)) !== null) {
        const label = normalizeAgentLabel(match[1]);
        if (label === undefined) continue;
        if (!labels.includes(label)) labels.push(label);

        // Defensive: an empty match would loop forever with a global regex.
        if (match[0].length === 0) pattern.lastIndex += 1;
    }

    return labels;
};

// Structural validation for a persisted/submitted reference list. Returns detached
// copies with normalised labels; `undefined` means the key was absent (the exact
// pre-reference shape). Throws TypeError for a malformed payload so persistence can
// fail the load and the server can map it to a 400 before mutating anything.
export const readAgentResultReferenceList = (
    value: unknown,
    label = 'references'
): AgentResultReference[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
    if (value.length > MAX_AGENT_REFERENCES) {
        throw new TypeError(`${label} cannot contain more than ${MAX_AGENT_REFERENCES} entries.`);
    }

    const references: AgentResultReference[] = [];
    const keys = new Set<string>();

    for (let index = 0; index < value.length; index++) {
        const entry = value[index];
        const at = `${label}[${index}]`;

        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new TypeError(`${at} must be an object.`);
        }

        const record = entry as Record<string, unknown>;
        const turnId = record.turnId;
        if (typeof turnId !== 'string' || turnId.trim().length === 0) {
            throw new TypeError(`${at}.turnId must be a non-empty string.`);
        }

        const threadId = record.threadId;
        if (threadId !== undefined && (typeof threadId !== 'string' || threadId.trim().length === 0)) {
            throw new TypeError(`${at}.threadId must be a non-empty string when present.`);
        }

        const normalised = normalizeAgentLabel(record.label);
        if (normalised === undefined) {
            throw new TypeError(`${at}.label must be a block label such as "IT1".`);
        }

        const canonicalTurn = turnId.trim();
        const canonicalThread = typeof threadId === 'string' ? threadId.trim() : undefined;
        const key = `${canonicalTurn}\u0000${canonicalThread ?? ''}`;
        if (keys.has(key)) {
            throw new TypeError(`${at} duplicates turn "${canonicalTurn}" with the same thread.`);
        }
        keys.add(key);

        references.push({
            turnId: canonicalTurn,
            ...(canonicalThread === undefined ? {} : { threadId: canonicalThread }),
            label: normalised
        });
    }

    return references;
};

// The explicit notice appended when content is truncated. Its length is part of
// the budget, so `boundAgentResultContent` reserves room for it.
const truncationMarker = (removed: number): string => `\n...[truncated ${removed} characters]`;

// Bound one block's content to AT MOST `limit` characters INCLUDING the explicit
// truncation marker. Keeping the marker inside the bound is what lets the combined
// composer treat `limit` as a hard budget rather than an approximate one. When
// `limit` is too small for even the marker, it returns an empty string; the
// composer then rejects instead of emitting unmarked content.
export const boundAgentResultContent = (
    content: string,
    limit: number = MAX_REFERENCE_CONTENT_CHARS
): string => {
    if (content.length <= limit) return content;

    // Solve keep = limit - markerLength(content.length - keep). The marker's digit
    // count can change once, so iterate to a fixed point (bounded, no loops).
    let keep = Math.max(0, limit - truncationMarker(content.length).length);
    for (let pass = 0; pass < 6; pass++) {
        const marker = truncationMarker(content.length - keep);
        const next = Math.max(0, limit - marker.length);
        if (next === keep) break;
        keep = next;
    }

    const marker = truncationMarker(content.length - keep);
    if (marker.length > limit) return '';

    return `${content.slice(0, keep)}${marker}`;
};

// Compose the run prompt. The user-facing `prompt` is preserved verbatim at the
// start; referenced content follows inside delimiters. The TOTAL string is capped
// at MAX_REFERENCE_TOTAL_CHARS (the same 200k ceiling as a raw prompt), counting
// the raw prompt, wrappers, separators, content, and truncation notices.
//
// Policy: the user prompt is never trimmed. Reference content is truncated to the
// remaining budget; when even an empty/truncated section cannot fit, this throws
// REFERENCED_RESULTS_BUDGET_MESSAGE so the server fails the turn readably instead
// of sending an over-budget prompt or silently dropping a reference.
export const composeAgentResultPrompt = (
    prompt: string,
    entries: readonly AgentResultContentEntry[]
): string => {
    if (entries.length === 0) return prompt;

    // Layout: `${prompt}\n\n${HEADER}\n${section}\n${section}...\n${FOOTER}`.
    const prefix = `${prompt}\n\n${REFERENCED_RESULTS_HEADER}`;
    const footer = `\n${REFERENCED_RESULTS_FOOTER}`;
    let remaining = MAX_REFERENCE_TOTAL_CHARS - prefix.length - footer.length;

    if (remaining < 0) throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);

    const sections: string[] = [];

    for (let index = 0; index < entries.length; index++) {
        const { block, content } = entries[index];
        const location = block.threadId === undefined ? '' : ` | thread ${block.threadId}`;
        const start = `--- #${block.label} | agent ${block.agent} | turn ${block.turnId}${location} ---`;
        const end = `--- end #${block.label} ---`;

        // Separator before this section (header newline for the first) plus the
        // two newlines that wrap the content and the closing line.
        const separator = 1;
        const fixed = separator + start.length + 1 + 1 + end.length;

        if (remaining - fixed < 0) throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);

        const contentBudget = remaining - fixed;
        const bounded =
            contentBudget <= 0
                ? ''
                : boundAgentResultContent(content, Math.min(contentBudget, MAX_REFERENCE_CONTENT_CHARS));

        // A non-empty block that cannot even carry its truncation notice has no
        // capacity: reject rather than claim a reference that contributed nothing.
        if (content.length > 0 && bounded.length === 0) {
            throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);
        }

        sections.push(`${start}\n${bounded}\n${end}`);
        remaining -= fixed + bounded.length;
    }

    const result = `${prefix}\n${sections.join('\n')}${footer}`;

    // Defensive invariant: the accounting above must never overrun. Keeping this
    // check makes a future layout change fail loudly instead of silently sending
    // a prompt larger than the documented ceiling.
    if (result.length > MAX_REFERENCE_TOTAL_CHARS) {
        throw new Error(REFERENCED_RESULTS_BUDGET_MESSAGE);
    }

    return result;
};
