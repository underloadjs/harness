// Invocation-thread metadata accessor (frozen runtime contract).
//
// `thread` is additive on HarnessEvent and emitted for NON-ROOT events only. The
// browser must treat it structurally: a server that predates the field sends
// nothing (legacy-by-agent routing), and a malformed block must degrade to
// "no metadata" rather than throw or fabricate ancestry.

import { threadOf } from './contract';

describe('threadOf', () => {
    it('returns the complete child-start record verbatim', () => {
        expect(
            threadOf({ thread: { id: 'inv-1', parentId: 'inv-0', callId: 'call-9', input: 'read the files' } })
        ).toEqual({ id: 'inv-1', parentId: 'inv-0', callId: 'call-9', input: 'read the files' });
    });

    it('accepts the id-only form later events are allowed to carry', () => {
        expect(threadOf({ thread: { id: 'inv-1' } })).toEqual({ id: 'inv-1' });
    });

    it('drops a self-referencing parent instead of creating a cycle', () => {
        expect(threadOf({ thread: { id: 'inv-1', parentId: 'inv-1' } })).toEqual({ id: 'inv-1' });
    });

    it('drops every malformed optional field but keeps a valid id', () => {
        expect(threadOf({ thread: { id: 'inv-1', parentId: 7, callId: '', input: 42 } })).toEqual({
            id: 'inv-1'
        });
    });

    it('treats a missing, blank or non-string id as no metadata', () => {
        expect(threadOf({})).toBeUndefined();
        expect(threadOf({ thread: undefined })).toBeUndefined();
        expect(threadOf({ thread: null })).toBeUndefined();
        expect(threadOf({ thread: 'inv-1' })).toBeUndefined();
        expect(threadOf({ thread: [] })).toBeUndefined();
        expect(threadOf({ thread: { id: '' } })).toBeUndefined();
        expect(threadOf({ thread: { id: 3 } })).toBeUndefined();
    });

    it('is safe on a non-object source', () => {
        expect(threadOf(undefined)).toBeUndefined();
        expect(threadOf(null)).toBeUndefined();
        expect(threadOf('event')).toBeUndefined();
    });
});
