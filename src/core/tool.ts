// tool() — define an action the model can request, or a human can call.
//
// A tool is data plus one function. It holds no state and no policy: the harness
// decides when to execute it, how to serialize the result, and what to feed back.
// Keeping tools inert is what makes them safe to share, reuse, and test in
// isolation.
//
// Executable object
// -----------------
// `tool()` returns a callable, not a passive descriptor. The same implementation
// therefore has two entry points:
//
//     const readFile = tool<string, string>({ ... });
//
//     await readFile('package.json');         // direct: no harness, no harness loop
//     harness({ tools: { readFile } });       // the model calls it
//
// Naming: `name` is optional. Inside a harness the registry key names the tool,
// so `tools: { readFile }` is enough and the model calls `readFile`. The
// harness overwrites `name` with the key on registration.
//
// Tags and visibility
// -------------------
// Every tool carries tags, and every tool is either:
//
//   - 'core'       — declared on every request. Keep the set tiny: it is the
//                    context budget the model always pays.
//   - 'searchable' — hidden until the harness's requestTools tool matches its tags,
//                    then declared for the rest of the conversation. The default.
//
// That is what keeps a catalogue of thousands of tools out of the context window.
// Tags are normalized here (trimmed, lowercased, deduplicated) so matching in
// ../core/discovery.ts can compare them directly.
//
// Parameters: `parameters` is a JSON Schema, which is what the OpenAI
// function-calling format actually wants. A TypeBox schema can be passed
// directly: TypeBox emits JSON Schema, so this package needs no schema
// dependency.
//
// Single-property rule
// --------------------
// The value in `execute({ parameters })` is:
//
//   - the whole arguments object when the schema declares several properties;
//   - the single property's value when it declares exactly one.
//
// That is what makes `readFile('package.json')` natural for a human and
// `read_file({ "path": "package.json" })` natural for a model — both reach the
// implementation as the string. The harness unwraps using `toolParameterKey()`.
// A multi-property tool such as syntaxCheck receives the whole argument object.
//
// Cross-references:
//   - ../types        — Tool, ToolConfiguration, ToolContext, ToolVisibility
//   - ../harness      — registration, the core set, and the execution loop
//   - ./discovery     — tag matching behind requestTools
//   - ../tools        — the preset tools built with this factory

import { HarnessError } from '../util';
import type { Tool, ToolConfiguration, ToolContext, ToolVisibility } from '../types';

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

const VISIBILITIES: readonly ToolVisibility[] = ['core', 'searchable'];

// Trim, lowercase, deduplicate, and drop blanks. Called for a tool's own tags and
// for each requestTools query, so both sides of a comparison look the same.
export const normalizeTags = (tags: readonly string[] | undefined): string[] => {
    if (!Array.isArray(tags)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const tag of tags) {
        if (typeof tag !== 'string') continue;

        const value = tag.trim().toLowerCase();
        if (value.length === 0 || seen.has(value)) continue;

        seen.add(value);
        normalized.push(value);
    }

    return normalized;
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

    // Tags are the only way requestTools can find a searchable tool, so an untagged
    // one would be dead weight in the registry. Reject it at construction rather
    // than at the first failed discovery.
    const tags = normalizeTags(configuration.tags);

    if (tags.length === 0) {
        throw new HarnessError('A tool requires at least one tag.');
    }

    const visibility = configuration.visibility ?? 'searchable';

    if (!VISIBILITIES.includes(visibility)) {
        throw new HarnessError(
            `A tool visibility must be one of: ${VISIBILITIES.join(', ')}. Received "${String(visibility)}".`
        );
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
    callable.tags = tags;
    callable.visibility = visibility;
    callable.parameters = parameters;
    callable.execute = run;

    return callable;
};
