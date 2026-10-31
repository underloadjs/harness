// profileManage — standalone source entry; state lives in the harness record store.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

export const PROFILE_MANAGE_NAME = 'profileManage';

// Session character/people profiles. Same factory-closure lifecycle as todos
// (../core/profile.ts), and the same action set as the other two record tools. The
// description documents the partial-update contract because the model reads the
// description, not this file.
export const PROFILE_MANAGE_METADATA: CoreToolMetadata = {
    name: PROFILE_MANAGE_NAME,
    description:
        'Manage character and people profiles for this harness session. Actions: "add" (requires name and description; optional traits and notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and "remove" (requires id). Traits are trimmed and deduplicated. Ids are stable strings returned by "add". Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { profile, counts }; "add"/"update" return { profile, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each.',
    tags: ['profile', 'profiles', 'character', 'characters', 'person', 'people'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Profile id returned by "add". Required for get/update/remove.'
            },
            name: {
                type: 'string',
                maxLength: 200,
                description:
                    'Profile name for "add", or a replacement name for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            description: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Profile description for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters.'
            },
            traits: {
                type: 'array',
                items: { type: 'string', maxLength: 200 },
                maxItems: 32,
                description:
                    'Optional traits for "add" or "update", e.g. ["brave", "loyal"]. Entries are trimmed and deduplicated; omitting the field leaves traits unchanged on update. At most 32 traits of 200 characters each.'
            },
            notes: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Optional free-form notes for "add" or "update". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first profile. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const metadata = PROFILE_MANAGE_METADATA;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('profileManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('profileManage', context);
