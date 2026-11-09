// R3 — the GLOBAL tool switch store (src/server/tool-settings.ts).
//
// WHAT THIS FILE PROVES:
//   1. DEFAULTS  - an empty store disables nothing, and the provider object handed to the
//                  harness is identity-stable (that reference is the live feature).
//   2. SWITCH    - disable/enable are idempotent plain writes to a deny list, `disabled()`
//                  and `snapshot()` are sorted, and a blank name is the store's 400.
//   3. PROTECTED - a harness-owned name can NEVER be disabled: 403 at the write edge,
//                  dropped at restore, and reported enabled by `isEnabled` either way
//                  (the same predicate a session row's `protected` field uses).
//   4. DURABLE   - the snapshot is the whole persisted shape (a deny list, or `{}` when
//                  nothing is off), and a restored store reads back exactly it.
//   5. LIVE      - the provider answers a write made AFTER a harness captured it, which is
//                  what makes the change reach a running session (../harness.ts).
//
// Determinism: every expected value below is exact (`toEqual`/`toBe`), and every status is
// asserted as a number, not as "an error".
//
// Cross-references:
//   - ./tool-settings.ts        — the module under test
//   - ./harnesses/toolbox.ts    — `CORE_TOOL_NAMES`, the protected set
//   - ./persistence.ts          — `HarnessToolSettingsRecord`, the durable shape asserted here
//   - ../harness.ts             — the provider's three consumers
import { describe, expect, it } from 'vitest';

import { CORE_TOOL_NAMES } from './harnesses/toolbox';
import {
    HarnessToolSettingsError,
    createToolSettingsStore,
    isProtectedToolName,
    toolSettingsProviderOf
} from './tool-settings';
import type { HarnessToolSettingsRecord } from './persistence';

/** One rejected switch, as the message + status the route would answer. */
const failureOf = (run: () => unknown): { status: number; message: string } => {
    try {
        run();
    } catch (error) {
        if (error instanceof HarnessToolSettingsError) return { status: error.status, message: error.message };

        throw error;
    }

    throw new Error('Expected the switch to be rejected; it was accepted.');
};

describe('tool settings store — the default state', () => {
    it('disables nothing and stores nothing', () => {
        const tools = createToolSettingsStore();

        expect(tools.disabled()).toEqual([]);
        expect(tools.isDisabled('read')).toBe(false);
        expect(tools.isEnabled('read')).toBe(true);
        expect(tools.revision()).toBe(0);

        // The persisted projection of "the operator never touched the Tools pane" is an
        // EMPTY record, which the document builder omits entirely.
        expect(tools.snapshot()).toEqual({});
    });

    it('hands out ONE stable provider object, read live', () => {
        const tools = createToolSettingsStore();
        const provider = toolSettingsProviderOf(tools);

        expect(tools.provider).toBe(provider);

        // A harness built NOW keeps this exact reference (../sessions.ts `buildHarness`)...
        const builtAt = { isToolDisabled: provider.isToolDisabled };

        // ...so a write made afterwards is what its next request sees.
        tools.setEnabled('write', false);

        expect(provider.isToolDisabled('write')).toBe(true);
        expect(builtAt.isToolDisabled('write')).toBe(true);
        expect(tools.provider).toBe(provider);
    });
});

describe('tool settings store — a switch', () => {
    it('records a deny list, sorted, and answers every name against it', () => {
        const tools = createToolSettingsStore();

        tools.setEnabled('write', false);
        tools.setEnabled('browser', false);
        tools.setEnabled('read', false);

        expect(tools.disabled()).toEqual(['browser', 'read', 'write']);
        expect(tools.isDisabled('write')).toBe(true);
        expect(tools.isDisabled('read')).toBe(true);
        expect(tools.isDisabled('glob')).toBe(false);
        expect(tools.isEnabled('write')).toBe(false);
        expect(tools.isEnabled('glob')).toBe(true);

        // One bump per accepted write, so a page's `revision` is a staleness test.
        expect(tools.revision()).toBe(3);

        // Sorted, and nothing else — the document shape is a name list, not a per-tool record.
        expect(tools.snapshot()).toEqual({ disabled: ['browser', 'read', 'write'] });
    });

    it('is idempotent in both directions and never errors on the state it already has', () => {
        const tools = createToolSettingsStore();

        tools.setEnabled('write', false);
        tools.setEnabled('write', false);

        expect(tools.disabled()).toEqual(['write']);

        tools.setEnabled('write', true);
        tools.setEnabled('write', true);

        expect(tools.disabled()).toEqual([]);
        expect(tools.snapshot()).toEqual({});

        // Repeating a write is accepted (it is a declarative switch, like every other
        // enable route here), so the counter moves even when the set does not.
        expect(tools.revision()).toBe(4);
    });

    it('refuses a blank name with 400 and mutates nothing', () => {
        const tools = createToolSettingsStore();

        expect(failureOf(() => tools.setEnabled('   ', false))).toEqual({
            status: 400,
            message: 'A tool switch requires a non-empty tool name.'
        });

        expect(failureOf(() => tools.setEnabled('', true))).toEqual({
            status: 400,
            message: 'A tool switch requires a non-empty tool name.'
        });

        expect(tools.snapshot()).toEqual({});
        expect(tools.revision()).toBe(0);
    });

    it('trims the name it stores, so " write " and "write" are one entry', () => {
        const tools = createToolSettingsStore();

        tools.setEnabled('  write  ', false);

        expect(tools.disabled()).toEqual(['write']);
        expect(tools.isDisabled('write')).toBe(true);
    });
});

describe('tool settings store — protected (harness-owned) names', () => {
    it('refuses to disable any core tool with 403, naming the reason', () => {
        const tools = createToolSettingsStore();

        // The shipped control plane, taken from the catalogue rather than retyped here: the
        // set is `CORE_TOOL_NAMES` (./harnesses/toolbox.ts), the same list a session row's
        // `protected` field is computed from (./api-reads.ts).
        expect(CORE_TOOL_NAMES.length).toBeGreaterThan(0);

        for (const name of CORE_TOOL_NAMES) {
            expect(isProtectedToolName(name)).toBe(true);

            expect(failureOf(() => tools.setEnabled(name, false))).toEqual({
                status: 403,
                message: `Tool "${name}" is harness-owned; it is part of the control plane every session runs on and cannot be disabled.`
            });
        }

        expect(tools.disabled()).toEqual([]);
        expect(tools.revision()).toBe(0);
    });

    it('accepts enabling a protected name, because that is the state it is already in', () => {
        const tools = createToolSettingsStore();

        tools.setEnabled(CORE_TOOL_NAMES[0], true);

        expect(tools.isDisabled(CORE_TOOL_NAMES[0])).toBe(false);
        expect(tools.isEnabled(CORE_TOOL_NAMES[0])).toBe(true);
    });

    it('answers enabled for a protected name even when a hand-edited document listed it', () => {
        const tools = createToolSettingsStore({ values: { disabled: [CORE_TOOL_NAMES[0], 'write'] } });

        // Restore drops the protected entry and keeps the real one: the invariant "the
        // control plane is always on" survives a hand-edited `state.json`.
        expect(tools.disabled()).toEqual(['write']);
        expect(tools.isEnabled(CORE_TOOL_NAMES[0])).toBe(true);
        expect(tools.isDisabled(CORE_TOOL_NAMES[0])).toBe(false);
    });
});

describe('tool settings store — restore', () => {
    it('reads back exactly what the snapshot wrote', () => {
        const tools = createToolSettingsStore();

        tools.setEnabled('write', false);
        tools.setEnabled('browser', false);

        const saved = tools.snapshot();

        expect(saved).toEqual({ disabled: ['browser', 'write'] });

        const reopened = createToolSettingsStore({ values: saved });

        expect(reopened.disabled()).toEqual(['browser', 'write']);
        expect(reopened.isEnabled('write')).toBe(false);
        expect(reopened.isEnabled('read')).toBe(true);

        // A restore is a boot, not a write: the revision counter is epoch-local.
        expect(reopened.revision()).toBe(0);

        // Round-stable: the same document written again is the same bytes-in-order.
        expect(reopened.snapshot()).toEqual(saved);
    });

    it('tolerates a malformed or hostile document instead of aborting the boot', () => {
        // [restored document, the set the store ends up with]. Blanks, duplicates,
        // non-members, and an absent key are all normalized away; nothing throws, and a
        // boot is never aborted by a stale entry (./persistence.ts validates the SHAPE,
        // this store decides what is still meaningful).
        const cases: Array<[HarnessToolSettingsRecord, string[]]> = [
            [{}, []],
            [{ disabled: [] }, []],
            [{ disabled: undefined }, []],
            [{ disabled: ['', '  ', 'write'] }, ['write']],
            [{ disabled: ['write', 'write'] }, ['write']],
            [{ disabled: [42 as unknown as string, 'read'] }, ['read']]
        ];

        for (const [values, expected] of cases) {
            expect(createToolSettingsStore({ values }).disabled()).toEqual(expected);
        }

        // `restore` is the same body, so a later reload behaves identically to a seed.
        const tools = createToolSettingsStore();

        tools.restore({ disabled: ['write'] });
        expect(tools.disabled()).toEqual(['write']);

        tools.restore(undefined);
        expect(tools.disabled()).toEqual([]);
    });

    it('never lets a stale name become a live disable, and never reports one as unknown', () => {
        // A tool this build no longer ships is KEPT: re-adding it in a later release
        // restores the operator's decision, and the runtime simply never consults the name.
        const tools = createToolSettingsStore({ values: { disabled: ['retired-tool'] } });

        expect(tools.isDisabled('retired-tool')).toBe(true);
        expect(tools.isDisabled('read')).toBe(false);
        expect(tools.snapshot()).toEqual({ disabled: ['retired-tool'] });
    });
});
