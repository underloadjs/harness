// Independently compilable source entry for the `diceRoll` app tool.
//
// T25 MOVE: moved from `server/harnesses/tool-sources/diceRoll.ts` into the
// dedicated server tools folder (`server/tools`) and renamed to the discovery
// contract (`*.tool.ts`), so the catalogue reads `metadata`/`registration` from
// the source text instead of importing this module.
//
// The schema and implementation state the same default (6) and the same domain
// (a whole number 2..1000); an out-of-range argument is rejected, never silently
// clamped (R8).
//
// Cross-references:
//   - ../harnesses/tools.ts — discovers this folder, builds the lazy proxy
//   - ../../core            — `tool` (mapped to the LIVE module by the compiler)

// `core` is the harness-internal live helper entry (see ./timeNow.tool.ts): the
// source compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// Demo-tool bounds. These are validation limits, not knobs: the demo tools exist
// to be predictable examples. `metadata` below repeats the same numbers as
// literals because discovery rejects template interpolation.
const DEFAULT_DICE_SIDES = 6;
const MIN_DICE_SIDES = 2;
const MAX_DICE_SIDES = 1_000;

// Declarative half (T19/R9): pure literal, read by the AST scanner. The bounds are
// spelled out instead of interpolated so the scanner can lift them.
export const metadata = {
    name: 'diceRoll',
    description:
        'Roll a fair die and return the value. Sides must be a whole number from 2 to 1000; defaults to 6 sides.',
    tags: ['random', 'dice', 'chance'],
    parameters: {
        type: 'object',
        properties: {
            sides: {
                type: 'integer',
                minimum: 2,
                maximum: 1000,
                default: 6,
                description: 'Number of faces on the die, a whole number from 2 to 1000. Defaults to 6.'
            }
        },
        // Optional: the default is part of the documented contract, so the schema
        // must not claim the argument is required.
        required: [],
        additionalProperties: false
    }
};

// Harness policy. Order 1020 keeps the historical shared-toolbox position (after
// textCount, before noteSearch).
export const registration = {
    group: 'external',
    activation: 'always',
    order: 1020,
    listed: true
} as const;

// diceRoll — a fair die, so the random path is exercised without a network call.
const diceRoll = tool<number | undefined, { sides: number; value: number }>({
    ...metadata,
    execute: ({ parameters: sides }) => {
        // Single-property rule: `sides` is the number itself, or undefined.
        const faces = sides ?? DEFAULT_DICE_SIDES;

        if (
            typeof faces !== 'number' ||
            !Number.isFinite(faces) ||
            !Number.isInteger(faces) ||
            faces < MIN_DICE_SIDES ||
            faces > MAX_DICE_SIDES
        ) {
            throw new Error(`diceRoll sides must be a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}.`);
        }

        return { sides: faces, value: 1 + Math.floor(Math.random() * faces) };
    }
});

export { diceRoll };
export default diceRoll;
