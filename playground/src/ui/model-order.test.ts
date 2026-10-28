// Alphabetical model-id order for the per-agent dropdowns (ui/model-order.ts).
// These tests pin the exact output for a deliberately unsorted catalogue so the
// dropdown cannot silently drift back to provider order.

import { sortModelIds } from './model-order';

describe('sortModelIds', () => {
    it('sorts case-insensitively, keeps a deterministic tie-break and does not mutate input', () => {
        const catalogue = ['zeta-2', 'Alpha', 'beta-10', 'beta-2', 'alpha'];

        // `Alpha`/`alpha` fold equal under the case-insensitive collator; the raw
        // codepoint tie-break puts the uppercase variant first deterministically.
        // `beta-2` precedes `beta-10` because the collator is numeric-aware.
        expect(sortModelIds(catalogue)).toEqual([
            'Alpha',
            'alpha',
            'beta-2',
            'beta-10',
            'zeta-2'
        ]);
        expect(catalogue).toEqual(['zeta-2', 'Alpha', 'beta-10', 'beta-2', 'alpha']);
    });

    it('is deterministic for ids that differ only by case', () => {
        // The collator folds these equal; the raw codepoint tie-break orders the
        // uppercase variant first regardless of input order.
        expect(sortModelIds(['model-a', 'Model-A', 'MODEL-A'])).toEqual([
            'MODEL-A',
            'Model-A',
            'model-a'
        ]);
        expect(sortModelIds(['MODEL-A', 'model-a', 'Model-A'])).toEqual([
            'MODEL-A',
            'Model-A',
            'model-a'
        ]);
    });

    it('preserves duplicates and sorts an empty list to empty', () => {
        expect(sortModelIds(['b', 'a', 'b'])).toEqual(['a', 'b', 'b']);
        expect(sortModelIds([])).toEqual([]);
    });
});
