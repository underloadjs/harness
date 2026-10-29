// Token-count formatting for the turn header.
//
// The header shows TWO different scopes on purpose (see ui/turns.ts):
//
//     150 (140)      latest model request's INPUT, total CACHE sent in brackets
//
//   - primary: the `input`/context size of the LATEST model request in the turn
//     (provider `prompt_tokens`, which INCLUDES that request's cached subset).
//     This is a context-size gauge, not a sum: re-sending the transcript on every
//     tool round must not inflate it.
//   - bracket: the total cached (replayed) input sent across the WHOLE turn,
//     summed per request from the server's running `SessionTurn.usage.cached`
//     (or from the recorded `usage` events when a legacy record has no tally).
//
// The different scopes are intentional and are exposed as a title/description by
// the tile so the numbers cannot be mistaken for the same unit (R2). `output` is
// kept in the tally but never printed; the formatter only ever receives input and
// cached counts.
//
// Cross-references:
//   - src/frontend/ui/turns.ts    — `.tile-tokens`, setUsage(), latest-input tracking
//   - src/frontend/contract.ts    — usageOf / frameUsageOf, the wire validation
//   - src/server/protocol.ts            — SessionTurn.usage, the cumulative tally

// en-US grouping is what the gateway log uses, and pinning the locale keeps the
// output identical on every host and every Node/host default (tests assert exact
// text: `122,111`, never `122.111` or `122 111`).
const formatter = new Intl.NumberFormat('en-US');

const count = (value: number): string => formatter.format(Math.trunc(value));

// `input` undefined renders as an empty string: the caller hides the label rather
// than printing "0" for a turn whose provider never reported usage at all. The
// bracket is only added when a cache figure was reported — absent is unknown, not
// zero (see HarnessUsage.cached).
//
// No cached<=input clamp here: the two figures have DIFFERENT scopes, so the
// cumulative cache can legitimately exceed the latest request's context (many
// tool rounds replaying a large transcript). Only negatives are clamped.
export const formatTokens = (input: number | undefined, cached?: number): string => {
    if (input === undefined) return '';

    const primary = count(Math.max(input, 0));

    if (cached === undefined) return primary;

    return `${primary} (${count(Math.max(cached, 0))})`;
};
