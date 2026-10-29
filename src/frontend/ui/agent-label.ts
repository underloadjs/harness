// Compact agent labels for the transcript (R2/R3).
//
// The allocator is SHARED with the server/persistence layer (T7/T8):
// `../../shared/agent-results.ts` owns the rules so a label shown in the UI and a
// label resolved from a persisted turn can never drift. This module only re-exports
// it under the frontend's historical import path (`ui/agent-label`), keeping
// `ui/turns.ts` and its tests unchanged.
//
// Shared rules (see shared/agent-results.ts):
//   - code = uppercase first + last ASCII LETTER (digits/punctuation ignored), or
//     the neutral fallback `AG` when the id has no ASCII letters;
//   - occurrence numbering is PER TURN and keyed by the two-letter CODE, so two
//     different ids with the same code cannot mint duplicate labels;
//   - `next()` is called once per invocation, `reset()` re-numbers a rebuilt turn.
//
// Cross-references:
//   - ../../shared/agent-results.ts — single owner of createAgentLabels;
//   - ui/turns.ts — allocates labels (root section, thread entries, legacy inline
//     sections) and writes them into block headers;
//   - ui/agent-color.ts `agentKeyOf` — shared identity normalisation.

export { createAgentLabels } from '../../shared/agent-results';
export type { AgentLabels } from '../../shared/agent-results';
