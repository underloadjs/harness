// Import-safety contract for the reusable browser client.
//
// `import ... from '@underload/harness/frontend'` (and the browser root) is an
// ordinary package import, so it must not apply CSS, mount the app shell, or
// create any element. This file runs in the frontend's jsdom config
// (./vitest.config.ts), which is the strictest environment available for
// detecting a DOM side effect.
//
// Cross-references:
//   - ./index.ts — the barrel under test (must not export ./main)
//   - ./main.ts  — the app shell; the only module that imports styles.css
//   - ../structure.test.ts — the Node-side equivalent for the root entries

import { describe, expect, it } from 'vitest';

describe('frontend barrel', () => {
    it('imports without touching the document or applying a stylesheet', async () => {
        // Baseline before the module graph is evaluated.
        const headBefore = document.head.innerHTML;
        const bodyBefore = document.body.innerHTML;
        const stylesBefore = document.querySelectorAll('style').length;

        const client = await import('./index');

        expect(document.head.innerHTML).toBe(headBefore);
        expect(document.body.innerHTML).toBe(bodyBefore);
        expect(document.querySelectorAll('style')).toHaveLength(stylesBefore);

        // The client is the same one the app shell uses.
        expect(client.API_ROOT).toBe('/api');
        expect(typeof client.loadBootstrap).toBe('function');
        expect(typeof client.callTool).toBe('function');
        expect(typeof client.createTurnBoard).toBe('function');
        expect(typeof client.applyPanels).toBe('function');
        expect(typeof client.sanitizePanels).toBe('function');
        expect(typeof client.agentsFromDescriptors).toBe('function');
        expect(typeof client.markdownFragment).toBe('function');
        // No shell export: the barrel must not re-export the DOM-booting entry.
        expect(Object.keys(client)).not.toContain('default');
        expect(Object.keys(client)).not.toContain('mount');
    });
});
