// profiles — the `profiles` COLLECTION SPECIFICATION (records-engine T2/T3).
//
// The store, its bounds, its pagination and its validation all live once in
// ./records.ts. What remains here is the field spec, i.e. the answer to "what is a
// profile". The F1 audit measured profile.ts and location.ts as 1,720 lines of one
// template instantiated three times; after the engine landed, the normalized diff
// between this file and ./location.ts is EXACTLY the `traits` field — which is the
// check T2 states.
//
// This wrapper is `searchable` (Decision I / F14): the story collections cost
// context only when an agent asks for them, unlike the core `tasks` list.
//
// Cross-references:
//   - ./records.ts                        — the engine
//   - ../tools/runtime/profiles.tool.ts   — PROFILES_NAME / PROFILES_METADATA
//   - ../types                            — RecordCollectionDefinition

import type { RecordCollectionDefinition } from '../types';

// R9 bounds, unchanged by the redesign: 200 records, 200-character names, 4000
// characters of prose, and at most 32 traits of 200 characters each.
export const PROFILE_MAX_RECORDS = 200;
export const PROFILE_MAX_NAME = 200;
export const PROFILE_MAX_TEXT = 4000;
export const PROFILE_MAX_TRAITS = 32;
export const PROFILE_MAX_TRAIT = 200;

// `traits` is the one field this collection has that `locations` does not: a
// trimmed, de-duplicated string array. De-duplication and the array cap are engine
// rules for any `strings` field, so the old `readTraits` helper is gone — and the order
// is the point: the engine NORMALIZES first (trim, drop blanks, collapse duplicates)
// and caps the SURVIVOR count, so 32 traits written as 40 entries with 8 repeats still
// stores. A flood of duplicates that survives normalization is rejected, and the
// refusal quotes BOTH counts — sent and normalized — so the caller can see what the
// cap actually saw. Blank entries are refused outright (`invalid-field`): a normalized
// array cannot contain a value the cap was not written to bound.
export const PROFILES_COLLECTION: RecordCollectionDefinition = {
    name: 'profiles',
    maxRecords: PROFILE_MAX_RECORDS,
    responseBudgetBytes: 64 * 1024,
    wrapper: { tool: 'profiles', plural: 'profiles', singular: 'profile', style: 'action' },
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: PROFILE_MAX_NAME },
        { key: 'description', type: 'text', required: true, maxLength: PROFILE_MAX_TEXT },
        {
            key: 'traits',
            type: 'strings',
            maxItems: PROFILE_MAX_TRAITS,
            maxLength: PROFILE_MAX_TRAIT,
            default: []
        },
        // Optional prose that may be CLEARED by an empty string (the historical
        // contract: omitting `notes` on update leaves it unchanged, `''` empties it).
        { key: 'notes', type: 'text', maxLength: PROFILE_MAX_TEXT, default: '' }
    ]
};
