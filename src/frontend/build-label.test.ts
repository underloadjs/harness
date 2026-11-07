// The topbar brand label ("Harness UI v2.3.0(261108)") is composed at build time
// by src/frontend/vite.config.ts from package.json's version and the build
// machine's local date. These tests pin the two pure pieces, constructing Dates
// from local calendar fields so they never depend on the machine's zone or on
// when the suite runs.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { describe, expect, it } from 'vitest';
import { formatBuildStamp, formatHarnessUiLabel } from './build-label';

describe('formatBuildStamp', () => {
    it('formats a date as two-digit year, month and day', () => {
        // Local-field construction: the stamp reads the same fields, so these
        // expectations hold in every timezone.
        expect(formatBuildStamp(new Date(2026, 10, 24, 12, 0, 0))).toBe('261124');
        expect(formatBuildStamp(new Date(2026, 10, 8, 23, 59, 59))).toBe('261108');
    });

    it('pads single-digit months and days and keeps the two-digit year', () => {
        expect(formatBuildStamp(new Date(2030, 0, 5, 12, 0, 0))).toBe('300105');
        expect(formatBuildStamp(new Date(2027, 11, 31, 12, 0, 0))).toBe('271231');
    });

    it('uses the day of the build machine, not a UTC-shifted one', () => {
        // 00:30 local is still that calendar day, whatever the zone offset is.
        expect(formatBuildStamp(new Date(2026, 10, 9, 0, 30, 0))).toBe('261109');
    });
});

describe('formatHarnessUiLabel', () => {
    it('renders the version and build stamp in the brand label shape', () => {
        expect(formatHarnessUiLabel('2.3.0', '261108')).toBe('Harness UI v2.3.0(261108)');
    });
});
