// Independently compilable source entry for the `textCount` app tool.
//
// R2: this entry imports only the shared `tool` helper, so it can be compiled and
// replaced without rebuilding another tool or the harness application.
//
// The implementation is moved verbatim from ./tools.ts. Character count stays
// UTF-16 code units (`String.prototype.length`), the unit JavaScript strings use;
// switching to code points would change existing answers.

// `core` is the harness-internal live helper entry (see ./timeNow.ts): the source
// compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// textCount — words and characters, so a model can check a length claim.
const textCount = tool<string, { words: number; characters: number }>({
    description:
        'Count the words and characters in a text. Useful before claiming a length. Characters are UTF-16 code units (JavaScript string length), so characters outside the basic plane, such as many emoji, count as two.',
    tags: ['text', 'words', 'count'],
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to measure. Characters are counted in UTF-16 code units.' }
        },
        required: ['text'],
        additionalProperties: false
    },
    execute: ({ parameters: text }) => {
        const trimmed = text.trim();

        return {
            words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
            characters: text.length
        };
    }
});

export { textCount };
export default textCount;
