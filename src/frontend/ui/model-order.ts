// Display order for model ids in the per-agent "model" dropdowns.
//
// Why this exists separately from the global model <select> in main.ts:
//   - the per-agent dropdowns are a pick-one list of the provider catalogue, so a
//     stable alphabetic scan is easier than the provider's mixed ordering;
//   - the global dropdown deliberately keeps the provider's order because its
//     first entry is the provider's preferred default (main.ts renderModelOptions).
//     Sorting that one would change which model a "first match" user lands on.
//
// Ordering rules:
//   1. case-insensitive, locale-aware compare, so `Claude` and `claude` do not
//      split the list into two case groups;
//   2. a deterministic tie-break on the raw id (codepoint compare) when the
//      case-insensitive compare says they are equal (e.g. `model-a` / `Model-A`),
//      so the output does not depend on catalogue input order;
//   3. never mutates the caller's array — main.ts may hold the fetched catalogue.
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

// Compare two ids using the rules above. `localeCompare` with an explicit locale
// keeps CI machines consistent; the raw compare makes equal-folded ids stable.
const compareModelIds = (left: string, right: string): number => {
    const folded = collator.compare(left, right);
    if (folded !== 0) return folded;
    if (left === right) return 0;
    return left < right ? -1 : 1;
};

// Return a sorted copy of `ids`. Callers keep their original ordering (the global
// dropdown uses it in place); duplicates are left untouched because the per-agent
// code already dedupes only the synthetic "(current)" id against the catalogue.
export const sortModelIds = (ids: readonly string[]): string[] => [...ids].sort(compareModelIds);
