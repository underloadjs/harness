// R10/R11 transcript integration: inline attachment chips and file links.
//
// These tests go through createTurnBoard (the same code path optimistic and
// replayed turns use), so they pin:
//   - markers become inline chips in the prompt flow, with NO separate chip row;
//   - optimistic -> merge -> replay refresh the chips without duplicates/stale DOM;
//   - unmatched attachments are appended at the prompt end exactly once;
//   - clicking an inline image chip opens the shared preview dialog;
//   - a file mention opens the bounded preview request, while external links and
//     traversal text stay untouched.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-attachments.test.ts

import { describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '../../server/protocol';
import type { HarnessAttachment } from '../../types';
import type { FilePreviewReader } from './file-preview';
import { createTurnBoard } from './turns';

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

const record = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'look at [Image 1] now',
        status: 'done',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        events: [],
        ...overrides
    }) as SessionTurn;

const withAttachments = (turn: SessionTurn, attachments: HarnessAttachment[]): SessionTurn =>
    ({ ...turn, attachments } as SessionTurn & { attachments: HarnessAttachment[] });

const mount = (readFile?: FilePreviewReader) => {
    const board = createTurnBoard(readFile === undefined ? {} : { readFile });
    document.body.replaceChildren(board.element);
    return board;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('inline attachment chips', () => {
    it('replaces the typed marker in the prompt flow without a second chip row', () => {
        const board = mount();
        const turn = board.begin('look at [Image 1] now', [attachment()]);

        expect(turn.element.querySelector('.turn-attachments')).toBeNull();
        const chips = [...turn.element.querySelectorAll<HTMLButtonElement>('.turn-prompt .attachment-inline')];
        expect(chips).toHaveLength(1);
        expect(chips[0]?.dataset.marker).toBe('[Image 1]');
        expect(chips[0]?.querySelector('.attachment-name')?.textContent).toBe('holiday.png');
        expect(chips[0]?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(chips[0]?.getAttribute('aria-label')).toBe('Open holiday.png ([Image 1])');
        // The marker was replaced in place: prose on both sides is unchanged.
        expect(turn.element.querySelector('.turn-prompt')?.textContent).toBe(
            'look at Image[Image 1]holiday.png now\n'
        );
        // The payload never becomes a text node.
        expect(turn.element.textContent).not.toContain(PNG_BASE64);
    });

    it('appends an unmatched attachment once, at the end of the prompt', () => {
        const board = mount();
        const turn = board.begin('no marker here', [attachment()]);

        const chips = [...turn.element.querySelectorAll<HTMLButtonElement>('.turn-prompt .attachment-inline')];
        expect(chips).toHaveLength(1);
        expect(chips[0]?.parentElement?.classList.contains('turn-prompt')).toBe(true);
        expect(chips[0]?.previousElementSibling?.nodeName).toBe('P');
        expect(turn.element.querySelector('.turn-attachments')).toBeNull();
    });

    it('refreshes optimistic chips on merge and clears stale ones when the record has none', () => {
        const board = mount();
        const turn = board.begin('look at [Image 1] now', [attachment()]);
        expect(turn.element.querySelectorAll('.attachment-inline')).toHaveLength(1);

        // The authoritative record replaces the optimistic draft list.
        turn.merge(withAttachments(record(), [attachment({ name: 'server.png' })]));
        const chips = [...turn.element.querySelectorAll<HTMLButtonElement>('.attachment-inline')];
        expect(chips).toHaveLength(1);
        expect(chips[0]?.querySelector('.attachment-name')?.textContent).toBe('server.png');

        // A record with no attachments clears every chip (no stale draft DOM).
        turn.merge(record());
        expect(turn.element.querySelectorAll('.attachment-inline')).toHaveLength(0);
        expect(turn.element.querySelector('.turn-prompt')?.textContent).toBe('look at [Image 1] now\n');
    });

    it('adopts a replayed turn with the same inline placement', () => {
        const board = mount();
        const turn = board.adopt(withAttachments(record(), [attachment()]));

        expect(turn.element.querySelectorAll('.turn-prompt .attachment-inline')).toHaveLength(1);
        expect(turn.element.querySelector('.turn-prompt')?.textContent).toBe(
            'look at Image[Image 1]holiday.png now\n'
        );
    });

    it('opens the shared image dialog from an inline chip and restores focus on close', () => {
        const board = mount();
        const turn = board.begin('look at [Image 1] now', [attachment()]);
        const chip = turn.element.querySelector<HTMLButtonElement>('.attachment-inline');
        if (chip === null) throw new Error('missing chip');

        // The dialog captures the focused trigger, not the composer.
        chip.focus();
        chip.click();

        const dialog = document.querySelector<HTMLElement>('.dialog');
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('holiday.png');
        expect(dialog?.querySelector<HTMLImageElement>('.preview-image img')?.src).toBe(
            `data:image/png;base64,${PNG_BASE64}`
        );

        dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(document.activeElement).toBe(chip);
    });
});

describe('file links in the transcript', () => {
    it('opens a bounded preview for a plain path via Enter/Space activation', async () => {
        const readFile = vi.fn<FilePreviewReader>(async () => ({
            files: [{ content: 'export const answer = 42;\n', startLine: 1, endLine: 1, truncated: false }],
            truncated: false
        }));
        const board = mount(readFile);
        const turn = board.begin('read src/frontend/main.ts please');

        const link = turn.element.querySelector<HTMLButtonElement>('.turn-prompt button.file-link');
        expect(link?.dataset.path).toBe('src/frontend/main.ts');
        link?.click();
        await flush();

        expect(readFile).toHaveBeenCalledWith({
            path: 'src/frontend/main.ts',
            startLine: 1,
            maxLines: 200
        });

        const dialog = document.querySelector<HTMLElement>('.dialog');
        expect(dialog?.querySelector('.preview-code code')?.textContent).toBe('export const answer = 42;\n');
        dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
    });

    it('links file paths in assistant prose but leaves URLs and traversal untouched', () => {
        const board = mount();
        const turn = board.begin('ask');
        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({
            type: 'text',
            agent: 'writer',
            delta: 'Read src/a.ts, not [b](https://example.com/b.ts) or ../secret.ts.'
        });
        turn.flush();

        const text = turn.element.querySelector<HTMLElement>('.agent-text');
        const links = [...(text?.querySelectorAll<HTMLButtonElement>('button.file-link') ?? [])];
        expect(links.map((link) => link.dataset.path)).toEqual(['src/a.ts']);
        expect(text?.querySelector('a[href="https://example.com/b.ts"]')).not.toBeNull();
        expect(text?.textContent).toContain('../secret.ts');
    });

    it('opens a markdown image in the shared preview dialog', () => {
        const board = mount();
        const turn = board.begin('ask');
        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'text', agent: 'writer', delta: '![Chart](https://example.com/chart.png)' });
        turn.flush();

        const button = turn.element.querySelector<HTMLButtonElement>('.agent-text button.image-link');
        expect(button?.getAttribute('aria-label')).toBe('Open image: Chart');
        button?.click();

        const dialog = document.querySelector<HTMLElement>('.dialog');
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('Chart');
        expect(dialog?.querySelector<HTMLImageElement>('.preview-image img')?.src).toBe(
            'https://example.com/chart.png'
        );
        dialog?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
    });
});
