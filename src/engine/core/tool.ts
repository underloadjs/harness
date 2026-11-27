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
// A multi-property tool such as syntax receives the whole argument object.
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

// ---------------------------------------------------------------------------
// THE RESERVED PER-CALL `async` SWITCH
// ---------------------------------------------------------------------------
// Every tool declaration carries ONE extra optional property, `async`, so a model can
// flip the turn policy of a SINGLE call without the tool author opting in:
//
//     { "name": "read", "arguments": { "paths": ["a.ts"], "async": true } }
//
// `true` means "this call resolves to mode 'async'", `false` means 'sync', and ABSENT
// means "use the tool's own default chain" (`modeDefinitions` -> `definition.mode` ->
// DEFAULT_TOOL_MODE, see ../harness.ts `effectiveToolMode`). The switch never changes
// what a tool DOES, only when its completion is allowed to start the next agent turn.
//
// FOUR SITES, ONE KEY. This module owns the spelling so none of them can drift:
//   1. `withToolAsyncSwitch`   — the DECLARATION copy ../harness.ts `offerDeclarations`
//                                advertises (never `definition.parameters`);
//   2. `readToolAsyncSwitch`   — the tolerant pre-read the harness uses to decide the
//                                mode, before validation runs;
//   3. `stripToolAsyncSwitch`  — the shared removal + type gate in
//                                ./schema-validation.ts `resolveToolParameters`, which
//                                every plane passes through (model wire, `callTool`,
//                                `executeTool`, and the server's manual tool route);
//   4. the delegate lone-call refinement in ../harness.ts, which reads the SAME key to
//      tell "the spawner is waiting on exactly one thing" from a real fan-out.
//
// WHY THE DECLARATION IS A COPY. `definition.parameters` is not only what the model is
// shown — it is ALSO the runtime validation schema (../harness.ts parses and validates
// against it), and for a ONE-property schema (`read`, `sleep`, `toolCancel`,
// `threadDelete`, most host tools) adding a second property would break
// `toolParameterKey()` above and hand `execute` the wrapper object instead of the
// value. So the injected key lives only on the model-facing copy, and the strip at (3)
// is what keeps it out of validation, out of `context.parameters`, and out of the
// persisted call arguments.
//
// THE KEY YIELDS TO THE TOOL. A tool whose own schema declares `async`
// (`toolOwnsAsyncParameter`) owns that property: it is not injected, not stripped, and
// never drives the mode. Without this carve-out a model-created tool
// (./creation.ts) or a host tool that legitimately takes an `async` argument would
// silently lose its field to the harness.
// ---------------------------------------------------------------------------

// The one spelling of the reserved key, shared by all four sites above.
export const TOOL_ASYNC_PARAMETER_KEY = 'async';

// The model-facing description of the reserved property. It is appended to EVERY tool
// schema on EVERY request, so it costs context on every turn: it stays ONE sentence.
export const TOOL_ASYNC_PARAMETER_DESCRIPTION =
    'Set true to run this call in async mode, false to run it in sync mode; omit it for this tool\'s default.';

// A node we may index by key: a non-null object that is not an array. Mirrors
// `isPlainObject` in ./schema-validation.ts; kept local because this package carries no
// runtime dependency on @presource/core.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Does the tool's OWN schema declare `async`? When it does, the property is the tool's
// and the reserved switch does not apply to this tool at all.
export const toolOwnsAsyncParameter = (parameters: unknown): boolean => {
    if (!isRecord(parameters)) return false;

    const properties = parameters.properties;
    return isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, TOOL_ASYNC_PARAMETER_KEY);
};

// The model-FACING copy of a tool schema: the same shape plus the reserved optional
// property. Never mutates the input, and returns it UNCHANGED (same reference) when the
// tool already owns the key. A tool with no `parameters` at all still gets the switch —
// ../transport/openai.ts `wireTool` has to answer with SOME object schema, and a
// parameterless tool is exactly the case where "wait for this one" is worth naming.
export const withToolAsyncSwitch = (
    parameters: Record<string, unknown> | undefined
): Record<string, unknown> => {
    if (toolOwnsAsyncParameter(parameters)) return parameters as Record<string, unknown>;

    const property = {
        type: 'boolean',
        description: TOOL_ASYNC_PARAMETER_DESCRIPTION
    };

    if (!isRecord(parameters)) return { type: 'object', properties: { [TOOL_ASYNC_PARAMETER_KEY]: property } };

    const properties = isRecord(parameters.properties) ? parameters.properties : {};

    return { ...parameters, properties: { ...properties, [TOOL_ASYNC_PARAMETER_KEY]: property } };
};

// The TOLERANT read used for mode resolution. It never throws and it never guesses: an
// absent key, a payload that is not an object, and any non-boolean value all answer
// "no switch". That tolerance is deliberate — this runs while COUNTING the calls of an
// assistant message, before the authoritative parse, and a malformed payload must not
// change which error the call reports later (the real parse/validation stays in
// ../harness.ts `parseToolCallArguments`). The type error for a bad value lives in
// `stripToolAsyncSwitch` below.
export const readToolAsyncSwitch = (args: unknown): boolean | undefined => {
    if (!isRecord(args)) return undefined;

    const value = args[TOOL_ASYNC_PARAMETER_KEY];
    return typeof value === 'boolean' ? value : undefined;
};

// Names a rejected value the way the model has to read it, so the message below can
// say what arrived rather than dumping JSON.
const asyncSwitchValueType = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    return typeof value;
};

// Removes the reserved key from PARSED arguments so validation, `context.parameters`,
// and the persisted arguments never see it. Two honest exits keep the common case free:
// a tool that owns the key, and a payload that does not carry it, both return the SAME
// reference. Otherwise a shallow copy is returned — shallow on purpose, since only this
// one top-level key is reserved.
//
// `owns` is `toolOwnsAsyncParameter(schema)`. This is also the ONE authoritative type
// gate for the switch: a non-boolean value throws the HarnessError the caller turns
// into a readable tool result, naming the key and the expected type. It fires the same
// way on the model path and on the direct doors, because all of them funnel through
// ./schema-validation.ts `resolveToolParameters`.
export const stripToolAsyncSwitch = (args: unknown, owns: boolean): unknown => {
    if (owns) return args;
    if (!isRecord(args)) return args;
    if (!Object.prototype.hasOwnProperty.call(args, TOOL_ASYNC_PARAMETER_KEY)) return args;

    const value = args[TOOL_ASYNC_PARAMETER_KEY];

    // `undefined` is absence for a JSON-less JS caller (the direct doors may hand a
    // live object straight in), so it strips rather than failing.
    if (value !== undefined && typeof value !== 'boolean') {
        throw new HarnessError(
            `$.${TOOL_ASYNC_PARAMETER_KEY} must be a boolean (true for async, false for sync); received ${asyncSwitchValueType(
                value
            )}.`
        );
    }

    const stripped: Record<string, unknown> = {};

    for (const key of Object.keys(args)) {
        if (key === TOOL_ASYNC_PARAMETER_KEY) continue;
        stripped[key] = args[key];
    }

    return stripped;
};

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
