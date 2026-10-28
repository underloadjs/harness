// Token-count formatting for the turn header.
//
// The header prints the SERVER's running tally for the turn in the same shape the
// gateway logs a request (see runtime/endpoint/provider/private/chat-completion/
// private-chat-completion.ts formatTokenLine):
//
//     122,111 (100,301)      total input tokens, cached (replayed) part in brackets
//
// Why input only: `input` is the cumulative figure that grows with every request
// a run makes — request n+1 re-sends the whole transcript — so its sum answers
// "how much has this run pushed through the model so far?". `output` is a
// per-request figure and would need its own label; the tile keeps it in the tally
// (`SessionTurn.usage`) but does not print it.
//
// Cross-references:
//   - playground/src/ui/turns.ts    — `.tile-tokens`, setUsage()
//   - playground/src/contract.ts    — usageOf / frameUsageOf, the wire validation
//   - server/protocol.ts            — SessionTurn.usage, the tally this renders

import type { HarnessUsage } from '../../../server/protocol';

// en-US grouping is what the gateway log uses, and pinning the locale keeps the
// output identical on every host and every Node/host default (tests assert exact
// text: `122,111`, never `122.111` or `122 111`).
const formatter = new Intl.NumberFormat('en-US');

const count = (value: number): string => formatter.format(Math.trunc(value));

// `undefined` renders as an empty string: the caller hides the label rather than
// printing "0" for a turn whose provider never reported usage at all. The bracket
// is only added when the provider reported a cache figure — absent is unknown, not
// zero (see HarnessUsage.cached).
export const formatTokens = (usage: HarnessUsage | undefined): string => {
    if (usage === undefined) return '';

    const input = count(usage.input);
    if (usage.cached === undefined) return input;

    return `${input} (${count(usage.cached)})`;
};
