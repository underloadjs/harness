// Tool creation — compile a tool from source at runtime.
//
// This is the small, explicit "the agent writes a tool" capability behind the
// harness's model-facing `toolCreate` tool and the host-side
// `harness.toolCreate()` method.
//
// Two-phase on purpose:
//   1. register(): validate the shape, then COMPILE the source. Nothing runs.
//   2. call():     the compiled body executes, with `args` and `context`.
//
// Registering never executes the source, so a model cannot smuggle work into the
// registration step. The source runs only when the tool is actually called.
//
// Trust model
// -----------
// Compilation uses the host realm's Function constructor (`new AsyncFunction`).
// A created tool therefore has the full permissions of the process: filesystem,
// network, child processes. That is the same trust model as `commandRun` in
// src/tools — this package has no sandbox and no isolation, and nothing here
// should ever be described as sandboxing. What this module DOES guarantee:
//   - a bounded name/description/tag/source shape,
//   - a compile error (HarnessError) when the body does not parse,
//   - no execution at registration.
// The harness adds registry rules on top: no overwriting an existing or reserved
// name, and a bounded number of created tools per harness (see src/harness.ts).
//
// Source shape
// ------------
// `source` is the BODY of an async function, not an expression:
//
//     "return args.path.toUpperCase();"                       // args = parameters
//     "return context.agents ? Object.keys(context.agents) : [];"
//
// It is compiled as `async function (args, context) { <source> }`, so `return` is
// required for a value. A function expression (an arrow function passed whole)
// does not parse as a body and is reported as a compile error.
//
// Cross-references:
//   - ../types        — ToolCreation, ToolCreationResult, ToolContext
//   - ./tool          — the Tool factory every created tool is built with
//   - ./schema-validation — the depth/size gate on a created schema (R11)
//   - ../harness      — registry checks, toolCreate tool, harness.toolCreate(),
//                       and the lifetime creation budget
//   - ../util         — HarnessError, toErrorInfo

import { HarnessError, toErrorInfo } from '../util';
import type { Tool, ToolContext, ToolCreation } from '../types';
import { tool } from './tool';
import { checkToolSchemaComplexity } from './schema-validation';

// A wire-safe tool name: one letter first, then letters/digits/_/-, at most 64
// characters. The OpenAI function-name alphabet is the practical constraint.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Bounds on one creation. They keep a single toolCreate round from dumping an
// unbounded schema, description, or program into the registry/context window.
const MAX_SOURCE_LENGTH = 20_000;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 64;

// The default LIFETIME creation budget for one harness (R12). Registration is
// cheap but not free, and an unbounded registry defeats the point of discovery.
//
// Semantics that matter and are easy to get wrong:
//   - the budget is per HARNESS INSTANCE and is NOT restored by reset(): created
//     tools stay registered after a reset (only their enabled/discovery state is
//     cleared), so restoring the counter would let a session grow the registry
//     without bound over its lifetime;
//   - it is counted in successful registrations, so a rejected creation (bad
//     name, collision, compile error) costs nothing;
//   - a harness may raise or lower it with `maxCreatedTools`.
export const DEFAULT_CREATED_TOOLS_LIMIT = 32;


// `AsyncFunction` is not a global binding, so it is reached through the prototype
// of an async function. The cast is variadic because the constructor takes the
// body's parameter names followed by the body itself (`'args', 'context', source`).
const AsyncFunction = Object.getPrototypeOf(async function () {
    return;
}).constructor as unknown as new (
    ...parameters: string[]
) => (args: unknown, context: ToolContext) => Promise<unknown>;

// The compiled body signature. `args` mirrors `execute({ parameters })`: the
// value for a single-property schema, the object otherwise.
export type ToolBody = (args: unknown, context: ToolContext) => Promise<unknown>;

// Compile one source body. Pure apart from the Function constructor: no registry,
// no validation of names — that is `createDynamicTool`'s job.
//
// A syntax error is turned into a HarnessError here because both entry points
// (model tool result and host exception) need the same readable message.
export const compileToolSource = (source: string): ToolBody => {
    try {
        const compiled = new AsyncFunction('args', 'context', source);
        return (args, context) => compiled(args, context);
    } catch (error) {
        throw new HarnessError(`Tool source could not be compiled: ${toErrorInfo(error).message}`);
    }
};

// Validate a creation request and return a callable Tool. Throws HarnessError for
// anything a model can get wrong, so the harness can surface the text as a tool
// result instead of crashing the run.
//
// `options.reserved` is the registry's own name list (toolRequest/toolCreate/agentDelegate
// in the harness). Comparison is case-insensitive so a near-collision cannot make
// the catalogue ambiguous.
export const createDynamicTool = (
    configuration: ToolCreation,
    options: { reserved?: readonly string[] } = {}
): Tool => {
    const { name, description, tags, parameters, source } = configuration;

    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw new HarnessError(
            `Tool name "${String(name)}" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.`
        );
    }

    const reserved = new Set((options.reserved ?? []).map((entry) => entry.toLowerCase()));

    if (reserved.has(name.toLowerCase())) {
        throw new HarnessError(`Tool name "${name}" is reserved by the harness.`);
    }

    if (typeof description !== 'string' || description.trim().length === 0) {
        throw new HarnessError(`Tool "${name}" requires a description.`);
    }

    if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new HarnessError(
            `Tool "${name}" description is longer than ${MAX_DESCRIPTION_LENGTH} characters; shorten it.`
        );
    }

    if (!Array.isArray(tags) || tags.length === 0) {
        throw new HarnessError(`Tool "${name}" requires at least one tag, so toolRequest can find it.`);
    }

    if (tags.length > MAX_TAGS) {
        throw new HarnessError(`Tool "${name}" has more than ${MAX_TAGS} tags; keep only the useful ones.`);
    }

    // Raw tag length is checked before `tool()` normalizes (trims/lowercases), so
    // a padded tag cannot slip through the bound.
    if (tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0 || tag.length > MAX_TAG_LENGTH)) {
        throw new HarnessError(
            `Tool "${name}" tags must be non-empty strings of at most ${MAX_TAG_LENGTH} characters.`
        );
    }

    // Parameters are forwarded to the transport as JSON Schema, so they must be a
    // JSON-serialisable object. A string or array is a model mistake worth naming.
    if (parameters !== undefined) {
        if (typeof parameters !== 'object' || !parameters || Array.isArray(parameters)) {
            throw new HarnessError(`Tool "${name}" parameters must be a JSON Schema object.`);
        }

        try {
            JSON.stringify(parameters);
        } catch {
            throw new HarnessError(`Tool "${name}" parameters must be JSON-serialisable.`);
        }

        // R11: a created schema is also validated at runtime, so bound its depth
        // and size now. A 500-level or 10k-node schema would be a context bomb on
        // every future request as well as a validation cost.
        const complexity = checkToolSchemaComplexity(parameters);

        if (!complexity.valid) {
            throw new HarnessError(`Tool "${name}" parameters ${complexity.message}.`);
        }
    }

    if (typeof source !== 'string' || source.trim().length === 0) {
        throw new HarnessError(`Tool "${name}" requires a source body.`);
    }

    if (source.length > MAX_SOURCE_LENGTH) {
        throw new HarnessError(
            `Tool "${name}" source is longer than ${MAX_SOURCE_LENGTH} characters; split the work instead.`
        );
    }

    // Compile now, execute later. This is the whole "no autoexecute" rule.
    const body = compileToolSource(source);

    return tool({
        name,
        description,
        tags,
        // Created tools are always searchable: core is the harness's own tiny set,
        // and a model-created tool must not change what every future request pays.
        visibility: 'searchable',
        parameters,
        // The body receives the same `args` a normal tool implementation would get
        // as `parameters` (single-property rule already applied by the harness),
        // plus the full context so it can inspect the agent and call `run`.
        execute: (context: ToolContext) => body(context.parameters, context)
    });
};
