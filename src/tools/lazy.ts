// @underload/harness tools/lazy — a Tool that loads its body on first execution.
//
// R1b: the preset catalogue must stay enumerable without paying for the
// implementations. `tool()` (../core/tool) builds a fully-realized callable, which
// is exactly what the harness and direct callers use; this factory produces the
// same shape from static metadata plus a loader.
//
// What stays eager (read without touching disk or spawning anything):
//   name, description, tags, visibility, parameters
//
// What is deferred until the model or a caller invokes the tool:
//   the implementation module, and therefore every `node:` built-in it imports
//
// Shape compatibility (do not regress this — T3's createTool registration and the
// server's direct-call path depend on it):
//   - the proxy is callable: `readFile('a.txt')` runs the real tool's direct path;
//   - `execute(context)` exists and runs the real tool's execute path, because
//     harness.ts calls `definition.execute(...)` directly;
//   - `name` is a writable, enumerable own property, so `definition.name = key`
//     during registration does not throw in strict mode;
//   - tags are normalized exactly like tool() normalizes them, so requestTools ranks
//     a lazy preset identically to an eager one.
//
// Failure behaviour: a failed import clears the cache so a later call retries
// instead of replaying the same rejection forever. The proxy itself never throws
// synchronously — calling it always returns a promise, matching Tool.
//
// Cross-references:
//   - ./catalogue     — metadata + dynamic import table
//   - ../core/tool    — normalizeTags and the eager tool() this mirrors
//   - ../../types     — the Tool contract

import { normalizeTags } from '../core/tool';
import type { Tool } from '../types';
import { loadPresetTool, PRESET_TOOLS } from './catalogue';
import type { PresetToolMetadata, PresetToolName } from './catalogue';

// Build the callable proxy for one catalogue entry.
//
// The explicit generics let each named export keep its parameter/result types
// (`lazyTool<string, string>('readFile')`) even though the loader is untyped: the
// metadata table is schema plumbing, not the public type surface.
export const lazyTool = <TParameters = any, TResult = any>(
    name: PresetToolName
): Tool<TParameters, TResult> => {
    // Widen to the row type: the table's literal union does not have a
    // `visibility` property on every row, and only the contract matters here.
    const metadata: PresetToolMetadata = PRESET_TOOLS[name];

    // One import per proxy, shared by every call. undefined = not started,
    // resolved promise = loaded, cleared on rejection so a retry can succeed.
    let loading: Promise<Tool> | undefined;

    const resolve = (): Promise<Tool> => {
        if (loading) return loading;

        loading = loadPresetTool(name).catch((error: unknown) => {
            loading = undefined;
            throw error;
        });

        return loading;
    };

    // Direct-call entry point: same argument contract as an eager Tool — the
    // argument IS the parameter value (single-property rule already applied by
    // the harness). Delegating to the loaded tool keeps execute semantics in one
    // place instead of duplicating argument handling here.
    const callable = ((parameters: TParameters) =>
        resolve().then((tool) => tool(parameters))) as Tool<TParameters, TResult>;

    // `name` is a non-writable own property of every function, so it must be
    // defined rather than assigned. Writable because the harness renames a tool to
    // its registry key; enumerable because tool()'s is.
    Object.defineProperty(callable, 'name', {
        value: metadata.name,
        writable: true,
        enumerable: true,
        configurable: true
    });

    callable.description = metadata.description;
    callable.tags = normalizeTags(metadata.tags);
    callable.visibility = metadata.visibility ?? 'searchable';
    callable.parameters = metadata.parameters;

    // The harness executes through this property, not through the callable, so it
    // has to defer as well. Once loaded, the real tool's execute is used so the
    // context (agent/agents/run) travels untouched.
    callable.execute = (context) => resolve().then((tool) => tool.execute(context));

    return callable;
};
