// Attachment preview dialog contract (R10/R11).
//
// The modal must show a safe, fitted image or plain metadata — never the base64
// payload, never an active SVG/HTML source.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/preview.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessAttachment } from '../../types';
import {
    attachmentPreviewContent,
    enhanceImages,
    openAttachmentDialog,
    openImageDialog,
    safeImageSource
} from './preview';

// Canonical base64 of a 12-byte PNG header. Same fixture the shared validator's
// magic-signature check accepts.
const PNG_BASE64 = 'iVBORw0KGgoAAAAA';

const attachment = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'a1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'holiday.png',
    mime: 'image/png',
    size: 12,
    data: PNG_BASE64,
    ...overrides
});

const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('.dialog');
    if (found === null) throw new Error('missing dialog');
    return found;
};

describe('attachment preview', () => {
    it('renders a safe fitted image and metadata, never the payload text', () => {
        const handle = openAttachmentDialog(attachment());

        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('holiday.png');
        const image = dialog().querySelector<HTMLImageElement>('.preview-image img');
        expect(image?.src).toBe(`data:image/png;base64,${PNG_BASE64}`);
        expect(image?.alt).toBe('holiday.png');

        const facts = [...dialog().querySelectorAll('.preview-facts dt')].map((node) => node.textContent);
        expect(facts).toEqual(['File', 'Kind', 'MIME', 'Size']);
        expect(dialog().querySelector('.preview-facts dd')?.textContent).toBe('holiday.png');

        // The base64 payload is only inside the img src attribute, never text.
        expect(dialog().textContent).not.toContain(PNG_BASE64);
        handle.close();
    });

    it('refuses an active image MIME as an <img> and keeps only metadata', () => {
        const host = attachmentPreviewContent(
            attachment({
                id: 'a2',
                marker: '[Image 2]',
                name: 'vector.svg',
                mime: 'image/svg+xml'
            })
        );

        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('.preview-note')?.textContent).toBe(
            'This image type is not previewed inline for safety.'
        );
        expect(host.textContent).not.toContain(PNG_BASE64);
    });

    it('shows safe text/media metadata for a generic file attachment', () => {
        const host = attachmentPreviewContent(
            attachment({
                id: 'a3',
                kind: 'file',
                marker: '[File 1]',
                name: 'notes.txt',
                mime: 'text/plain'
            })
        );

        expect(host.querySelector('img')).toBeNull();
        const values = [...host.querySelectorAll('.preview-facts dd')].map((node) => node.textContent);
        expect(values).toEqual(['notes.txt', 'File', 'text/plain', '12 B']);
        expect(host.textContent).not.toContain(PNG_BASE64);
    });

    it('closes through the shared dialog handle', () => {
        const handle = openAttachmentDialog(
            attachment({ id: 'a4', kind: 'file', marker: '[File 1]', name: 'data.bin', mime: 'application/octet-stream' })
        );
        expect(document.querySelector('.dialog')).not.toBeNull();
        handle.close();
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

describe('markdown image preview', () => {
    it('refuses scriptable and SVG sources', () => {
        expect(safeImageSource('javascript:alert(1)')).toBeUndefined();
        expect(safeImageSource('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined();
        expect(safeImageSource('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined();
        expect(safeImageSource('https://example.com/chart.png')).toBe('https://example.com/chart.png');
        expect(safeImageSource('./chart.png')).toBe('./chart.png');
        expect(safeImageSource('data:image/png;base64,iVBORw0KGgoAAAAA')).toBe(
            'data:image/png;base64,iVBORw0KGgoAAAAA'
        );
    });

    it('opens a fitted image dialog with the alt text as its title', () => {
        const handle = openImageDialog('https://example.com/chart.png', { alt: 'Revenue chart' });

        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('Revenue chart');
        const image = dialog().querySelector<HTMLImageElement>('.preview-image img');
        expect(image?.src).toBe('https://example.com/chart.png');
        expect(image?.alt).toBe('Revenue chart');
        handle.close();
    });

    it('wraps a sanitized markdown image in one dialog trigger', () => {
        const root = document.createElement('div');
        root.innerHTML = '<p><img src="https://example.com/chart.png" alt="Chart"></p>';
        const opened: Array<[string, string]> = [];

        expect(enhanceImages(root, { open: (source, alt) => opened.push([source, alt]) })).toBe(1);

        const button = root.querySelector<HTMLButtonElement>('button.image-link');
        expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(button?.getAttribute('aria-label')).toBe('Open image: Chart');
        expect(button?.querySelector('img')?.getAttribute('src')).toBe('https://example.com/chart.png');

        button?.click();
        expect(opened).toEqual([['https://example.com/chart.png', 'Chart']]);
        // Idempotent: an already wrapped image is not wrapped twice.
        expect(enhanceImages(root, { open: () => undefined })).toBe(0);
    });

    it('leaves an unsafe image out of the clickable set', () => {
        const root = document.createElement('div');
        // Built by hand to prove the transform itself re-checks the source.
        root.innerHTML = '<p><img src="javascript:alert(1)" alt="bad"></p>';
        expect(enhanceImages(root, { open: () => undefined })).toBe(0);
        expect(root.querySelector('button.image-link')).toBeNull();
    });
});
