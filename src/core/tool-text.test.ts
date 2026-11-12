// core/tool-text.ts — the model-projection seam a tool returns instead of a bare value.
//
// Pinned contract:
//   - an ordinary value is NOT an envelope: `toolTextOf` returns `undefined` for it and
//     `unwrapToolResult` answers `{ content }` with NO `text` key, so every standard
//     tool stays byte-for-byte stable at the delivery boundary;
//   - `toolText()` validates at the tool (a non-string projection is a bug, and
//     `[object Object]` in a transcript is the silent form of it);
//   - a hand-built envelope is checked at the boundary too, and a forged brand is
//     REJECTED rather than dropped — prose the model never sees is a quiet omission;
//   - a brand key without a `content` field is not an envelope either, so an ordinary
//     result that happens to carry a `__toolText` property still travels untouched;
//   - composition is ORDER-INDEPENDENT: text, media and panels peel in any nesting.
//
// Why the seam exists at all (a `read` result serialized into the transcript pays
// escaping and per-entry metadata with the caller's context window) is in the module
// header; `../../../tools/files/read.test.ts` pins the projection that uses it.

import { describe, expect, it } from 'vitest';
import { toolMedia, toolText, toolTextOf, toolUi, unwrapToolResult } from '@underload/harness';
import type { HarnessAttachment, ToolUiPanel } from '@underload/harness';

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

const image: HarnessAttachment = {
    id: 'dl-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: Buffer.from(PNG_BYTES).toString('base64')
};

const panel: ToolUiPanel = {
    id: 'p1',
    slot: 'right',
    title: 'Panel',
    blocks: [{ type: 'text', text: 'body' }]
};

describe('toolText', () => {
    it('keeps the machine value and the model prose apart', () => {
        const content = { files: [{ path: '/x', content: 'a\n' }] };
        const envelope = toolText(content, '/x  1 lines\na\n');

        // The brand is an own-property string, like the other two brands, and `content`
        // is the SAME reference the tool returned - not a copy, not a projection.
        expect(envelope.content).toBe(content);
        expect(envelope.__toolText).toBe('/x  1 lines\na\n');
    });

    it('refuses a projection that is not a string', () => {
        // The message names what it received, because the usual cause is a template that
        // produced an object or a `String(...)` left off.
        expect(() => toolText({ a: 1 }, undefined as never)).toThrow(
            'toolText expects a string projection; received undefined.'
        );
        expect(() => toolText({ a: 1 }, null as never)).toThrow('toolText expects a string projection; received null.');
        expect(() => toolText({ a: 1 }, 7 as never)).toThrow('toolText expects a string projection; received number.');
        // An EMPTY projection is allowed: a tool that renders nothing for an empty result
        // means that, and the boundary distinguishes "" from "no projection" by the brand.
        expect(toolText({ a: 1 }, '')).toMatchObject({ __toolText: '', content: { a: 1 } });
    });

    it('recognizes only its own brand, and only with content attached', () => {
        expect(toolTextOf('a string')).toBeUndefined();
        expect(toolTextOf(null)).toBeUndefined();
        expect(toolTextOf(undefined)).toBeUndefined();
        expect(toolTextOf([1, 2])).toBeUndefined();
        // An ordinary result that merely HAS a `content` field.
        expect(toolTextOf({ content: { a: 1 } })).toBeUndefined();
        // A `__toolText` property with nothing to carry is not an envelope either: the
        // value travels untouched rather than having its "content" invented.
        expect(toolTextOf({ __toolText: 'forged' })).toBeUndefined();
        expect(toolTextOf({ __toolText: 'ok', content: { a: 1 } })).toEqual({ text: 'ok', content: { a: 1 } });
        // A forged NON-string brand throws at the boundary rather than delivering
        // `[object Object]` to the model.
        expect(() => toolTextOf({ __toolText: { nested: true }, content: { a: 1 } })).toThrow(
            'toolText projection must be a string; received object.'
        );
        expect(() => toolTextOf({ __toolText: null, content: { a: 1 } })).toThrow(
            'toolText projection must be a string; received null.'
        );
    });
});

describe('unwrapToolResult with a text projection', () => {
    it('leaves an ordinary tool value exactly as it was', () => {
        // THE regression this file exists for: the seam must be invisible to every tool
        // that does not use it. `text` is ABSENT, not undefined, so a consumer can tell
        // "no projection" from "a projection of nothing".
        const plain = { matches: [1, 2, 3] };

        expect(unwrapToolResult(plain)).toEqual({ content: plain });
        expect('text' in unwrapToolResult(plain)).toBe(false);
        expect('text' in unwrapToolResult(toolText({ a: 1 }, ''))).toBe(true);
    });

    it('peels text, media and panels in any nesting order', () => {
        const content = { ok: true };

        const expected = { content, media: [image], panels: [panel], text: 'prose' };

        expect(unwrapToolResult(toolText(toolMedia(toolUi(content, [panel]), [image]), 'prose'))).toEqual(expected);
        expect(unwrapToolResult(toolMedia(toolUi(toolText(content, 'prose'), [panel]), [image]))).toEqual(expected);
        expect(unwrapToolResult(toolUi(toolText(toolMedia(content, [image]), 'prose'), [panel]))).toEqual(expected);

        // Two text layers cannot both be true, and the OUTERMOST one wins: it is the
        // rendering the tool chose last, and the inner one is still reachable as content.
        const nested = unwrapToolResult(toolText(toolText(content, 'inner'), 'outer'));

        expect(nested.text).toBe('outer');
        expect(unwrapToolResult(nested.content as never).text).toBe('inner');
    });
});
