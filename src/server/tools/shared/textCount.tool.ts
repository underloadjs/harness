// Independently compilable source entry for the `textCount` app tool.
//
// T25 MOVE: moved from `server/harnesses/tool-sources/textCount.ts` into the
// dedicated server tools folder (`server/tools`). The file name now follows the
// discovery contract (`.tool.ts`) so `core/tool-scan.ts` can read its `metadata`
// and `registration` literals WITHOUT importing the module; the old `.ts` name had
// to be imported statically by ../harnesses/tools.ts, which was the last app-level
// exception to the metadata-first rule.
//
// Character count stays UTF-16 code units (`String.prototype.length`), the unit
// JavaScript strings use; switching to code points would change existing answers.
//
// Cross-references:
//   - ../harnesses/tools.ts — discovers this folder, builds the lazy proxy
//   - ../../core            — `tool` (mapped to the LIVE module by the compiler)

// `core` is the harness-internal live helper entry (see ./timeNow.tool.ts): the
// source compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// Declarative half (T19/R9): pure literal, read by the AST scanner.
export const metadata = {
    name: 'textCount',
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
    }
};

// Harness policy. `order` preserves the historical shared-toolbox order
// (timeNow, textCount, diceRoll, noteSearch, textSummarize) even though folder
// discovery sorts byte-wise by relative path.
export const registration = {
    group: 'external',
    activation: 'always',
    order: 1010,
    listed: true
} as const;

// textCount — words and characters, so a model can check a length claim.
const textCount = tool<string, { words: number; characters: number }>({
    ...metadata,
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
