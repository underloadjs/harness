// The interrupted-tool-result marker is duplicated across the engine/server boundary.
//
// `engine/core/transcript-repair.ts` may not import the server tree, so it carries a
// BYTE-EXACT copy of `server/persistence.ts`'s `INTERRUPTED_TOOL_RESULT_TEXT`. The engine
// behaviour test uses the literal; this side owns the parity pin that a change to either
// producer cannot pass unnoticed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const readConstant = (file: string, name: string): string => {
    const source = readFileSync(join(SRC, file), 'utf8');
    const match = source.match(new RegExp(`const ${name} =\\s*\\n\\s*'((?:[^'\\\\]|\\\\.)*)'`));

    if (match === undefined || match[1] === undefined) {
        throw new Error(`Could not read ${name} out of ${file}.`);
    }

    return match[1];
};

describe('interrupted tool-result marker parity', () => {
    it('keeps the engine duplicate byte-identical to the server marker', () => {
        expect(readConstant('engine/core/transcript-repair.ts', 'PERSISTENCE_INTERRUPTED_TOOL_RESULT_TEXT')).toBe(
            readConstant('server/persistence.ts', 'INTERRUPTED_TOOL_RESULT_TEXT')
        );
    });
});
