// Compact agent labels for the transcript (R2/R3).
//
// A block header names its agent with a short CODE instead of the raw agent id:
// the UPPERCASE first and last letter of the id plus the 1-based occurrence of that
// agent WITHIN the turn, e.g. `research` → `RH1`, the second research invocation of
// the same turn → `RH2`. The root invocation is an invocation too, so a turn whose
// entry agent is `instruct` labels its main block `IT1` and a delegated `research`
// child `RH1`.
//
// Why a counter instead of the runtime id: the label has to stay readable and
// compact in a one-line header, and the id itself is an internal identifier that
// must not appear in the UI (R3). The occurrence number still distinguishes two
// invocations of the SAME agent, which is what makes repeated delegations legible
// (the blocks also differ by position/colour).
//
// Determinism rules (R2):
//   - `next()` is called ONCE per invocation, when its block is created — never per
//     event — so a long stream cannot inflate the number;
//   - replaying a recorded turn creates the blocks in the recorded event order, so
//     the same turn always yields the same labels (the caller resets the counter in
//     `resetProjection`, then re-creates from the record);
//   - identity is normalised exactly like the colour (`agentKeyOf`: trimmed,
//     lower-cased), so `Research` and `research ` are the same agent and share one
//     occurrence sequence.
//
// Cross-references:
//   - ui/turns.ts — allocates the labels (root section, thread entries, legacy
//     inline sections) and writes them into the block headers;
//   - ui/agent-color.ts `agentKeyOf` — the shared identity normalisation;
//   - styles.css `.agent-name` / `.thread-name` — uppercase mono register.

import { agentKeyOf } from './agent-color';

// Per-turn label allocator. One instance belongs to one turn tile (`ui/turns.ts`
// `create`), because occurrence numbering is per turn, not per page.
export type AgentLabels = {
    // Allocate the next occurrence for `agent` and return its display label. Call
    // once per invocation (never per event).
    next: (agent: string | undefined) => string;
    // Forget every occurrence. Used when a turn's projection is rebuilt from a
    // superseding record, so the replay numbers the agents from 1 again instead of
    // continuing a discarded pass.
    reset: () => void;
};

// Label for an id with no letters or digits at all (an empty/`???` name). The two
// letters still identify "an agent we cannot name", and the occurrence keeps the
// blocks apart, so such a block is never confused with a real profile code.
const FALLBACK_CODE = 'AG';

// First + last letter/digit of the normalised id, uppercased. Non-alphanumeric
// glyphs (spaces, punctuation) are skipped rather than displayed: the header has no
// room for them and they would make the code ambiguous. A one-character id yields
// the same letter twice (`a` → `AA`), which is the literal "first and last letter"
// rule and stays deterministic.
const codeOf = (key: string): string => {
    const glyphs = Array.from(key).filter((glyph) => /[\p{L}\p{N}]/u.test(glyph));
    if (glyphs.length === 0) return FALLBACK_CODE;

    return `${glyphs[0]}${glyphs[glyphs.length - 1]}`.toUpperCase();
};

// A fresh allocator. Deliberately tiny and synchronous: the caller owns the
// lifecycle (one per turn, reset on rebuild) so the mapping can never leak between
// turns or sessions.
export const createAgentLabels = (): AgentLabels => {
    // Normalised agent key → highest occurrence handed out so far. A plain Map keeps
    // the allocation order-independent of iteration: only `next` calls increment.
    const occurrences = new Map<string, number>();

    return {
        next(agent: string | undefined): string {
            const key = agentKeyOf(agent);
            // An id with NO letters/digits cannot produce a code, so every such block
            // shares one neutral sequence (`AG1`, `AG2`, …). Bucketing them together
            // (instead of per raw key) is what keeps the labels distinct; a real id
            // that merely LOOKS like the fallback (`ag`) still has its own bucket.
            const hasGlyphs = /[\p{L}\p{N}]/u.test(key);
            const bucket = hasGlyphs ? key : '';
            const occurrence = (occurrences.get(bucket) ?? 0) + 1;
            occurrences.set(bucket, occurrence);

            return `${codeOf(key)}${occurrence}`;
        },

        reset(): void {
            occurrences.clear();
        }
    };
};
