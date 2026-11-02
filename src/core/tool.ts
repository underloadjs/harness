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
//     const read = tool<string[], FileReadResult>({ ... });
//
//     await read(['package.json']);        // direct: no harness, no harness loop
//     harness({ tools: { read } });        // the model calls it
//
// Naming: `name` is optional. Inside a harness the registry key names the tool,
// so `tools: { read }` is enough and the model calls `read`. The
// harness overwrites `name` with the key on registration.
//
// Tags and visibility
// -------------------
// Every tool carries tags, and every tool is either:
//
//   - 'core'       — declared on every request. Keep the set tiny: it is the
//                    context budget the model always pays.
//   - 'searchable' — hidden until the harness's toolRequest tool matches its tags,
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
// That is what makes `read(['package.json'])` natural for a human and
// `read_file({ "path": "package.json" })` natural for a model — both reach the
// implementation as the string. The harness unwraps using `toolParameterKey()`.
// A multi-property tool such as syntaxCheck receives the whole argument object.
//
// Cross-references:
//   - ../types        — Tool, ToolConfiguration, ToolContext, ToolVisibility
//   - ../harness      — registration, the core set, and the execution loop
//   - ./discovery     — tag matching behind toolRequest
//   - ../tools        — the preset tools built with this factory

import { HarnessError } from '../util';
import type { Tool, ToolConfiguration, ToolContext, ToolMode, ToolVisibility } from '../types';

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

// Accepted turn modes (T2/R2). The order is the error message's order.
const MODES: readonly ToolMode[] = ['sync', 'async'];

// The mode a tool runs under when its definition does not state one. 'sync' means
// the completion joins its assistant message's sync group: the run is re-entered only
// after every sync call of that batch has settled. Long-running built-ins (shell,
// delegate, the branch controls) state 'async' in their own registration literal, so
// this default is never re-derived from a name.
export const DEFAULT_TOOL_MODE: ToolMode = 'sync';

// Trim, lowercase, deduplicate, and drop blanks. Called for a tool's own tags and
// for each toolRequest query, so both sides of a comparison look the same.
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

    // Tags are the only way toolRequest can find a searchable tool, so an untagged
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

    // T2/R2: the turn policy is DECLARED data, validated at construction exactly like
    // visibility (a typo must not silently become a different scheduling behaviour).
    // An UNDECLARED tool carries no `mode` key at all, which is how the harness knows
    // to apply DEFAULT_TOOL_MODE ('sync') — and how a deep-equality view of a Tool
    // keeps its historical shape for every tool that never opted in.
    const mode = configuration.mode;

    if (mode !== undefined && !MODES.includes(mode)) {
        throw new HarnessError(
            `A tool mode must be one of: ${MODES.join(', ')}. Received "${String(mode)}".`
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
    // Declared mode only (see the validation above): absent stays absent, so the
    // harness's DEFAULT_TOOL_MODE remains the single documented fallback and nothing
    // here claims a policy the author did not write.
    if (mode !== undefined) callable.mode = mode;
    callable.parameters = parameters;
    callable.execute = run;

    return callable;
};
