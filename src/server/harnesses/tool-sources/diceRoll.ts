// Independently compilable source entry for the `diceRoll` app tool.
//
// R2: imports only the shared `tool` helper. The schema and implementation state
// the same default (6) and the same domain (a whole number 2..1000); an
// out-of-range argument is rejected, never silently clamped (R8).
//
// Cross-references:
//   - ./tools.ts (app catalogue re-export)
//   - app tests pin the exact schema and edge values

// `core` is the harness-internal live helper entry (see ./timeNow.ts): the source
// compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// Demo-tool bounds. These are validation limits, not knobs: the demo tools exist
// to be predictable examples.
const DEFAULT_DICE_SIDES = 6;
const MIN_DICE_SIDES = 2;
const MAX_DICE_SIDES = 1_000;

// diceRoll — a fair die, so the random path is exercised without a network call.
const diceRoll = tool<number | undefined, { sides: number; value: number }>({
    description: `Roll a fair die and return the value. Sides must be a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}; defaults to ${DEFAULT_DICE_SIDES} sides.`,
    tags: ['random', 'dice', 'chance'],
    parameters: {
        type: 'object',
        properties: {
            sides: {
                type: 'integer',
                minimum: MIN_DICE_SIDES,
                maximum: MAX_DICE_SIDES,
                default: DEFAULT_DICE_SIDES,
                description: `Number of faces on the die, a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}. Defaults to ${DEFAULT_DICE_SIDES}.`
            }
        },
        // Optional: the default is part of the documented contract, so the schema
        // must not claim the argument is required.
        required: [],
        additionalProperties: false
    },
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
