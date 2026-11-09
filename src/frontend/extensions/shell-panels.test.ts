// Shell-panel registration (T5/R1): normalization, validation and the deterministic
// draw order. The lifecycle that consumes this registry is ./runtime.test.ts.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    SHELL_PANEL_DEFAULT_ORDER,
    clearShellPanels,
    getShellPanel,
    listShellPanelIds,
    listShellPanels,
    registerShellPanel,
    unregisterShellPanel
} from './shell-panels';
import type { ShellPanelRegistration } from './shell-panels';

const mount = () => {};

const record = (id: string, overrides: Partial<ShellPanelRegistration> = {}) => {
    registerShellPanel({ id, mount, ...overrides });

    return getShellPanel(id);
};

beforeEach(() => {
    clearShellPanels();
});

afterEach(() => {
    clearShellPanels();
});

describe('registerShellPanel', () => {
    it('normalizes a minimal registration to the full record', () => {
        expect(record('tasks')).toEqual({
            id: 'tasks',
            title: '',
            slot: 'scratch',
            order: SHELL_PANEL_DEFAULT_ORDER,
            position: 'after',
            scope: 'session',
            requiresSession: true,
            mount: expect.any(Function)
        });

        expect(
            record('queue', {
                id: 'queue',
                title: '  Queue  ',
                slot: 'center',
                order: 5,
                position: 'before',
                scope: 'app',
                when: () => true
            })
        ).toEqual({
            id: 'queue',
            title: 'Queue',
            slot: 'center',
            order: 5,
            position: 'before',
            scope: 'app',
            requiresSession: false,
            when: expect.any(Function),
            mount: expect.any(Function)
        });

        // The session requirement is a panel's own call, in both directions.
        expect(record('directory', { id: 'directory', requiresSession: false })?.requiresSession).toBe(false);
        expect(record('chrome', { id: 'chrome', scope: 'app', requiresSession: true })?.requiresSession).toBe(true);
    });

    it('resolves the documented slot alias instead of rejecting it', () => {
        // A plugin written against the backend contract's default spelling lands on
        // the scratch board, exactly like a wire panel with `slot: 'right'`.
        expect(record('board', { id: 'board', slot: 'right' })?.slot).toBe('scratch');
    });

    it('refuses a registration this app cannot draw', () => {
        expect(() => registerShellPanel({ id: '', mount })).toThrow(
            'registerShellPanel: `id` must be a non-empty string'
        );
        expect(() => registerShellPanel({ id: 'x' } as never)).toThrow(
            "registerShellPanel('x'): `mount` must be a function"
        );
        expect(() => registerShellPanel({ id: 'x', mount, slot: 'sidebar' as never })).toThrow(
            "registerShellPanel('x'): slot 'sidebar' is not mounted"
        );
        expect(() => registerShellPanel(null as never)).toThrow(
            'registerShellPanel: a registration object is required'
        );
        // A non-finite order would corrupt the sort, so the default wins.
        expect(record('nan', { id: 'nan', order: Number.NaN })?.order).toBe(SHELL_PANEL_DEFAULT_ORDER);
        expect(listShellPanelIds()).toEqual(['nan']);
    });

    it('replaces the same id, and the displaced teardown is inert', () => {
        const first = registerShellPanel({ id: 'tasks', mount });
        const replacement = () => {};
        registerShellPanel({ id: 'tasks', mount: replacement });

        expect(getShellPanel('tasks')?.mount).toBe(replacement);
        first();
        expect(getShellPanel('tasks')?.mount).toBe(replacement);

        expect(unregisterShellPanel('tasks')).toBe(true);
        expect(unregisterShellPanel('tasks')).toBe(false);
        expect(unregisterShellPanel('')).toBe(false);
        expect(unregisterShellPanel(7)).toBe(false);
        expect(listShellPanels()).toEqual([]);
    });
});

describe('listShellPanels', () => {
    it('orders by order then id, whatever the registration order was', () => {
        // Registered worst-first on purpose: the draw order must come from the
        // registration DATA, never from the order two modules happened to import.
        registerShellPanel({ id: 'zeta', order: 100, mount });
        registerShellPanel({ id: 'alpha', order: 100, mount });
        registerShellPanel({ id: 'top', order: 0, mount });
        registerShellPanel({ id: 'middle', order: 50, mount });
        registerShellPanel({ id: 'late', order: 200, mount });

        expect(listShellPanelIds()).toEqual(['top', 'middle', 'alpha', 'zeta', 'late']);

        // Re-listing is a fresh array: a consumer cannot corrupt the registry by
        // sorting the list it was handed.
        const listed = listShellPanels();
        listed.reverse();
        expect(listShellPanelIds()).toEqual(['top', 'middle', 'alpha', 'zeta', 'late']);
    });
});
