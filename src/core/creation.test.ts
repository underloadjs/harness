// createDynamicTool() / compileToolSource() — the core behind createTool.
//
// These are the unit-level contracts the harness relies on, with no harness and no
// transport: shape validation, reserved names, compilation, the deferred body, and
// the `args` + `context` signature. The security posture (no sandbox) is documented
// in ../core/creation.ts; nothing here claims isolation.

import { describe, expect, it } from 'vitest';
import { compileToolSource, createDynamicTool } from '@underload/harness';
import type { ToolCreation } from '@underload/harness';

const creation: ToolCreation = {
    name: 'double',
    description: 'Double a number.',
    tags: ['math'],
    parameters: { type: 'object', properties: { n: { type: 'number' } } },
    source: 'return args * 2;'
};

describe('createDynamicTool', () => {
    it('builds a searchable tool that runs the compiled body on call', async () => {
        const made = createDynamicTool(creation);

        expect(made.name).toBe('double');
        expect(made.description).toBe('Double a number.');
        expect(made.tags).toEqual(['math']);
        expect(made.visibility).toBe('searchable');
        expect(made.parameters).toEqual(creation.parameters);
        await expect(made(21)).resolves.toBe(42);
    });

    it('normalizes tags the same way tool() does', () => {
        const made = createDynamicTool({ ...creation, tags: ['  Math  ', 'math', 'Numbers'] });

        expect(made.tags).toEqual(['math', 'numbers']);
    });

    it('passes the direct-call value as args and the ToolContext as context', async () => {
        const made = createDynamicTool({
            ...creation,
            name: 'probe',
            description: 'Probe.',
            tags: ['probe'],
            parameters: undefined,
            source: 'return { keys: Object.keys(context).sort(), args };'
        });

        expect(await made({ a: 1 })).toEqual({ keys: ['parameters'], args: { a: 1 } });
    });

    it('does not execute the source at registration', async () => {
        const made = createDynamicTool({ ...creation, source: "throw new Error('boom');" });

        expect(made.name).toBe('double');
        await expect(made(1)).rejects.toThrow('boom');
    });

    it('rejects reserved names case-insensitively', () => {
        expect(() => createDynamicTool({ ...creation, name: 'GetTools' }, { reserved: ['getTools'] })).toThrow(
            'Tool name "GetTools" is reserved by the harness.'
        );
    });

    it('validates the name pattern', () => {
        expect(() => createDynamicTool({ ...creation, name: 'bad name' })).toThrow(
            'Tool name "bad name" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.'
        );

        expect(() => createDynamicTool({ ...creation, name: 5 as unknown as string })).toThrow(
            'Tool name "5" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.'
        );
    });

    it('validates description, tags, parameters, and source bounds', () => {
        expect(() => createDynamicTool({ ...creation, description: '   ' })).toThrow(
            'Tool "double" requires a description.'
        );

        expect(() => createDynamicTool({ ...creation, description: 'x'.repeat(2001) })).toThrow(
            'Tool "double" description is longer than 2000 characters; shorten it.'
        );

        expect(() => createDynamicTool({ ...creation, tags: [] })).toThrow(
            'Tool "double" requires at least one tag, so getTools can find it.'
        );

        expect(() =>
            createDynamicTool({ ...creation, tags: Array.from({ length: 17 }, (_, index) => `tag${index}`) })
        ).toThrow('Tool "double" has more than 16 tags; keep only the useful ones.');

        expect(() => createDynamicTool({ ...creation, tags: ['   '] })).toThrow(
            'Tool "double" tags must be non-empty strings of at most 64 characters.'
        );

        expect(() => createDynamicTool({ ...creation, tags: ['t'.repeat(65)] })).toThrow(
            'Tool "double" tags must be non-empty strings of at most 64 characters.'
        );

        expect(() => createDynamicTool({ ...creation, parameters: [] as unknown as Record<string, unknown> })).toThrow(
            'Tool "double" parameters must be a JSON Schema object.'
        );

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(() => createDynamicTool({ ...creation, parameters: circular })).toThrow(
            'Tool "double" parameters must be JSON-serialisable.'
        );

        expect(() => createDynamicTool({ ...creation, source: '   ' })).toThrow(
            'Tool "double" requires a source body.'
        );

        expect(() => createDynamicTool({ ...creation, source: 'x'.repeat(20_001) })).toThrow(
            'Tool "double" source is longer than 20000 characters; split the work instead.'
        );
    });
});

describe('compileToolSource', () => {
    it('compiles an async function body with args and context', async () => {
        const body = compileToolSource('return `${args}:${context.parameters}`;');

        await expect(body('a', { parameters: 'b' })).resolves.toBe('a:b');
    });

    it('reports a syntax error as a HarnessError', () => {
        expect(() => compileToolSource('return (')).toThrow(/^Tool source could not be compiled: /);
    });
});
