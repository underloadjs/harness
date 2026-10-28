// tool() — defining an action the model can request, or a human can call.
//
// Three contracts are pinned here, because everything else builds on them:
//   - a tool is an executable object: calling it runs the same implementation the
//     harness runs, with no agent and no registry;
//   - the single-property rule: a schema with exactly one property delivers that
//     property's value to `execute`, so a direct call and a model call agree;
//   - tags and visibility: every tool is tagged (that is how toolRequest finds it)
//     and searchable by default (that is what keeps a big catalogue out of the
//     context window).

import { describe, expect, it } from 'vitest';
import { tool, HarnessError } from '@underload/harness';

describe('tool', () => {
    it('carries name, description, parameters, and tags', () => {
        const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

        const webSearch = tool({
            name: 'webSearch',
            description: 'Search the web.',
            tags: ['search', 'web'],
            parameters,
            execute: ({ parameters: args }) => `results for ${args.q}`
        });

        expect(webSearch.name).toBe('webSearch');
        expect(webSearch.description).toBe('Search the web.');
        expect(webSearch.parameters).toBe(parameters);
        expect(webSearch.tags).toEqual(['search', 'web']);
    });

    it('normalizes tags so discovery can compare them directly', () => {
        const search = tool({
            description: 'Search.',
            tags: ['  Files ', 'files', 'READ', '', 'read'],
            execute: () => 'ok'
        });

        expect(search.tags).toEqual(['files', 'read']);
    });

    it('is searchable by default and core on request', () => {
        const hidden = tool({ description: 'Hidden.', tags: ['x'], execute: () => 'ok' });
        const visible = tool({
            description: 'Visible.',
            tags: ['x'],
            visibility: 'core',
            execute: () => 'ok'
        });

        expect(hidden.visibility).toBe('searchable');
        expect(visible.visibility).toBe('core');
    });

    it('defaults the name when none is given (a harness sets it from the key)', () => {
        const webSearch = tool({ description: 'Search.', tags: ['search'], execute: () => 'ok' });
        expect(webSearch.name).toBe('tool');
    });

    it('is callable directly, without a harness', async () => {
        const contexts: unknown[] = [];

        const pythonSyntax = tool<string, boolean>({
            name: 'pythonSyntax',
            description: 'Check Python syntax.',
            tags: ['code', 'python'],
            parameters: {
                type: 'object',
                properties: { code: { type: 'string' } },
                required: ['code']
            },
            execute: (context) => {
                contexts.push(context);
                return !context.parameters.includes('syntax error');
            }
        });

        // The whole point: `pythonSyntax('...')`, not `pythonSyntax({...})`.
        await expect(pythonSyntax('print(1)')).resolves.toBe(true);
        await expect(pythonSyntax('syntax error')).resolves.toBe(false);

        // A direct call supplies the parameter value and nothing else: no agent,
        // no registry, no run().
        expect(contexts[0]).toEqual({ parameters: 'print(1)' });
    });

    it('passes multi-property parameters through as the object', async () => {
        const fileWrite = tool<{ path: string; content: string }, string>({
            description: 'Write a file.',
            tags: ['files', 'write'],
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content']
            },
            execute: ({ parameters }) => `${parameters.path}:${parameters.content}`
        });

        await expect(fileWrite({ path: 'a.txt', content: 'hi' })).resolves.toBe('a.txt:hi');
    });

    it('always resolves execute as a promise, even for sync implementations', async () => {
        const now = tool({ description: 'Current time.', tags: ['time'], execute: () => 'noon' });

        const result = now.execute({ parameters: {} });

        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBe('noon');
    });

    it('exposes the same implementation as `.execute` for the harness to call', async () => {
        const echo = tool<string, string>({
            description: 'Echo.',
            tags: ['echo'],
            execute: ({ parameters }) => parameters
        });

        const agents = {};
        const result = await echo.execute({ parameters: 'hi', agent: {} as any, agents, run: async () => ({}) as any });

        expect(result).toBe('hi');
        // Direct call and harness call produce the same value.
        await expect(echo('hi')).resolves.toBe('hi');
    });

    it('can be renamed, so a harness can key it by registry name', () => {
        const search = tool({ description: 'Search.', tags: ['search'], execute: () => 'ok' });

        search.name = 'webSearch';

        expect(search.name).toBe('webSearch');
    });

    it('requires a description', () => {
        expect(() => tool({ description: '', tags: ['x'], execute: () => 'ok' })).toThrow(HarnessError);
        expect(() => tool({ description: '', tags: ['x'], execute: () => 'ok' })).toThrow(
            'A tool requires a description.'
        );
    });

    it('requires at least one tag', () => {
        expect(() => tool({ description: 'x', tags: [], execute: () => 'ok' })).toThrow(
            'A tool requires at least one tag.'
        );
        expect(() => tool({ description: 'x', tags: ['  ', ''], execute: () => 'ok' })).toThrow(
            'A tool requires at least one tag.'
        );
        expect(() => tool({ description: 'x', tags: undefined as any, execute: () => 'ok' })).toThrow(
            'A tool requires at least one tag.'
        );
    });

    it('rejects an unknown visibility', () => {
        expect(() =>
            tool({ description: 'x', tags: ['x'], visibility: 'sometimes' as any, execute: () => 'ok' })
        ).toThrow('A tool visibility must be one of: core, searchable. Received "sometimes".');
    });

    it('requires an execute function', () => {
        expect(() => tool({ description: 'x', tags: ['x'], execute: undefined as any })).toThrow(
            'A tool requires an execute function.'
        );
    });
});
