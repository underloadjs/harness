// tool() — define an action the model can request, or a human can call.
//
// A tool is data plus one function. It holds no state and no policy: the harness
// decides when to execute it, how to serialize the result, and what to feed back
// to the model. Keeping tools inert is what makes them safe to share, reuse, and
// test in isolation.
//
// Executable object
// -----------------
// `tool()` returns a callable, not a passive descriptor. The same implementation
// therefore has two entry points:
//
//     const pythonSyntax = tool<string, boolean>({ ... });
//
//     await pythonSyntax('print(1)');         // direct: no agent, no harness
//     harness({ tools: { pythonSyntax } });   // the model calls it
//
// Naming: `name` is optional. Inside a harness the registry key names the tool,
// so `tools: { pythonSyntax }` is enough and the model calls `pythonSyntax`. The
// harness overwrites `name` with the key on registration.
//
// Parameters: `parameters` is a JSON Schema, which is what the OpenAI
// function-calling format actually wants. A TypeBox schema can be passed
// directly: TypeBox emits JSON Schema, so this package needs no schema
// dependency to interop with it.
//
// Single-property rule
// --------------------
// The value in `execute({ parameters })` is:
//
//   - the whole arguments object when the schema declares several properties;
//   - the single property's value when it declares exactly one.
//
// That is what makes `pythonSyntax('print(1)')` natural for a human and
// `python_syntax({ "code": "print(1)" })` natural for a model — both reach the
// implementation as the string. The harness unwraps using `toolParameterKey()`.
//
// Cross-references:
//   - ../types        — Tool, ToolConfiguration, ToolContext
//   - ../harness      — registration and the execution loop
//   - ../tools        — the preset tools built with this factory

import { HarnessError } from '../util';
import type { Tool, ToolConfiguration, ToolContext } from '../types';

// The property a single-property schema declares, if that is what it is.
//
// Used by both sides of the single-property rule: the harness unwraps arguments
// with it, and callers can inspect a tool to see which parameter it takes.
export const toolParameterKey = (parameters: Record<string, unknown> | undefined): string | undefined => {
    if (!parameters || parameters.type !== 'object') return undefined;

    const properties = parameters.properties;
    if (!properties || typeof properties !== 'object') return undefined;

    const keys = Object.keys(properties as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : undefined;
};

export const tool = <TParameters = any, TResult = any>(
    configuration: ToolConfiguration<TParameters, TResult>
): Tool<TParameters, TResult> => {
    const { description, parameters, execute } = configuration;

    if (!description) {
        throw new HarnessError('A tool requires a description.');
    }

    if (typeof execute !== 'function') {
        throw new HarnessError('A tool requires an execute function.');
    }

    // Normalize the return type so callers always get a promise, whether the
    // implementation is sync or async.
    const run = async (context: ToolContext<TParameters>): Promise<TResult> => execute(context);

    // The direct entry point. The argument IS the parameter value, so it is
    // handed to `execute` untouched — no wrapping, no schema lookup.
    const callable = ((value: TParameters) => run({ parameters: value })) as Tool<TParameters, TResult>;

    // `name` is a read-only property of every function, so it must be defined
    // rather than assigned. It stays writable because a harness renames the tool
    // to its registry key.
    Object.defineProperty(callable, 'name', {
        value: configuration.name ?? 'tool',
        writable: true,
        enumerable: true,
        configurable: true
    });

    callable.description = description;
    callable.parameters = parameters;
    callable.execute = run;

    return callable;
};
