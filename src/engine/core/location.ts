// locations — the `locations` COLLECTION SPECIFICATION (records-engine T2/T3).
//
// Deliberately the smallest collection (name, description, optional notes). The
// F1 audit normalized this file against ./profile.ts and diffed them: the ONLY
// real difference was the `traits` array, which is exactly the delta still visible
// between the two specs now that both are pure field declarations.
//
// Cross-references:
//   - ./records.ts                        — the engine
//   - ../tools/runtime/locations.tool.ts  — LOCATIONS_NAME / LOCATIONS_METADATA
//   - ../types                            — RecordCollectionDefinition

import type { RecordCollectionDefinition } from '../types';

// R9 bounds, unchanged by the redesign: 200 records, 200-character names, 4000
// characters of prose.
export const LOCATION_MAX_RECORDS = 200;
export const LOCATION_MAX_NAME = 200;
export const LOCATION_MAX_TEXT = 4000;

export const LOCATIONS_COLLECTION: RecordCollectionDefinition = {
    name: 'locations',
    maxRecords: LOCATION_MAX_RECORDS,
    responseBudgetBytes: 64 * 1024,
    wrapper: { tool: 'locations', plural: 'locations', singular: 'location', style: 'action' },
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: LOCATION_MAX_NAME },
        { key: 'description', type: 'text', required: true, maxLength: LOCATION_MAX_TEXT },
        { key: 'notes', type: 'text', maxLength: LOCATION_MAX_TEXT, default: '' }
    ]
};
