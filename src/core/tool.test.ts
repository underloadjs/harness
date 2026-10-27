// tool() — defining an action the model can request, or a human can call.
//
// Two contracts are pinned here, because everything else builds on them:
//   - a tool is an executable object: calling it runs the same implementation the
//     harness runs, with no agent and no registry;
//   - the single-property rule: a schema with exactly one property delivers that
//     property's value to `execute`, so a direct call and a model call agree.

import { describe, expect, it } from 'vitest';
import { tool, HarnessError } from '@underload/harness';

describe('tool', () => {
    it('carries name, description, and parameters', () => {
        const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

        const websearch = tool({
            name: 'websearch',
            description: 'Search the web.',
            parameters,
            execute: ({ parameters: args }) => `results for ${args.q}`
        });

        expect(websearch.name).toBe('websearch');
        expect(websearch.description).toBe('Search the web.');
        expect(websearch.parameters).toBe(parameters);
    });

    it('defaults the name when none is given (a harness sets it from the key)', () => {
        const websearch = tool({ description: 'Search.', execute: () => 'ok' });
        expect(websearch.name).toBe('tool');
    });

    it('is callable directly, without a harness', async () => {
        const contexts: unknown[] = [];

        const pythonSyntax = tool<string, boolean>({
            name: 'pythonSyntax',
            description: 'Check Python syntax.',
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
        const writeFile = tool<{ path: string; content: string }, string>({
            description: 'Write a file.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content']
            },
            execute: ({ parameters }) => `${parameters.path}:${parameters.content}`
        });

        await expect(writeFile({ path: 'a.txt', content: 'hi' })).resolves.toBe('a.txt:hi');
    });

    it('always resolves execute as a promise, even for sync implementations', async () => {
        const now = tool({ description: 'Current time.', execute: () => 'noon' });

        const result = now.execute({ parameters: {} });

        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBe('noon');
    });

    it('exposes the same implementation as `.execute` for the harness to call', async () => {
        const echo = tool<string, string>({
            description: 'Echo.',
            execute: ({ parameters }) => parameters
        });

        const agents = {};
        const result = await echo.execute({ parameters: 'hi', agent: {} as any, agents, run: async () => ({}) as any });

        expect(result).toBe('hi');
        // Direct call and harness call produce the same value.
        await expect(echo('hi')).resolves.toBe('hi');
    });

    it('can be renamed, so a harness can key it by registry name', () => {
        const search = tool({ description: 'Search.', execute: () => 'ok' });

        search.name = 'websearch';

        expect(search.name).toBe('websearch');
    });

    it('requires a description', () => {
        expect(() => tool({ description: '', execute: () => 'ok' })).toThrow(HarnessError);
        expect(() => tool({ description: '', execute: () => 'ok' })).toThrow('A tool requires a description.');
    });

    it('requires an execute function', () => {
        expect(() => tool({ description: 'x', execute: undefined as any })).toThrow(
            'A tool requires an execute function.'
        );
    });
});
