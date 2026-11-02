// TypeScript family half of syntax — parse TS/TSX/JSX without running or type-checking.
//
// WHY transpileModule (and not a Program, not createSourceFile)
// -------------------------------------------------------------
// `typescript` is already a RUNTIME dependency of this package (src/core/tool-source.ts
// compiles editable tool sources with it), so reusing it adds no dependency and no
// bundle weight for the checks that already need it. `transpileModule` is the public,
// single-file entry point: it parses one snippet and emits, with NO program, NO module
// resolution and NO type checking. `reportDiagnostics: true` hands back exactly the
// syntax diagnostics, which is the verdict this tool promises.
//
// `ts.createSourceFile(...).parseDiagnostics` would be marginally cheaper, but
// `parseDiagnostics` is not part of the published typings (it is absent from
// typescript.d.ts), so depending on it would make this checker lean on an internal
// field of a dependency. The public API is worth the transpile pass.
//
// WHAT THE VERDICT MEANS
// ----------------------
//   - true  -> the snippet parses as that dialect;
//   - false -> the parser reported at least one ERROR-category diagnostic;
//   - a thrown parser (an emit failure rather than a diagnostic) is an INFRASTRUCTURE
//     failure and becomes a HarnessError, never a false. "false" must mean "your code
//     did not parse", exactly like the Python half's exit-code protocol.
//
// Deliberate, documented limits (the tool description says the same):
//   - type errors are NOT syntax errors, so `const x: number = "s"` is true;
//   - the dialect decides the grammar through the file NAME below, because that is how
//     the compiler picks a ScriptKind: `<div/>` parses in tsx/jsx and does not parse
//     in typescript;
//   - a byte-order mark is ignored by the parser, as it is by the JSON half.
//
// This module is loaded through `import()` by ./syntax only when a TypeScript-family
// language is asked for, so the compiler module never loads for a JavaScript, JSON or
// Python check. Metadata lives in ./syntax.tool.ts.
//
// Cross-references:
//   - ./syntax.tool.ts       — the language table and the dispatch
//   - ../core/tool-source.ts — the other consumer of the `typescript` dependency

import type * as TypeScriptApi from 'typescript';
import { HarnessError } from '../../util';

// The three dialects this checker covers. The keys double as the canonical language
// names, so ./syntax.tool.ts's dispatch cannot name a dialect this table lacks.
export type TypeScriptDialect = 'typescript' | 'tsx' | 'jsx';

// The compiler picks the grammar from the file EXTENSION, so each dialect gets its own
// name and nothing else about the path matters (no file is ever written).
const DIALECT_FILE_NAMES: Readonly<Record<string, string>> = {
    typescript: 'snippet.ts',
    tsx: 'snippet.tsx',
    jsx: 'snippet.jsx'
};

// The API is a multi-megabyte CommonJS module. It is loaded once per process, on the
// first TypeScript-family check, and the PROMISE is cached so two concurrent checks
// share one load.
let api: Promise<typeof TypeScriptApi> | undefined;

const loadApi = (): Promise<typeof TypeScriptApi> => {
    api ??= import('typescript').then(
        (module) =>
            // TypeScript ships CommonJS; Node's ESM interop exposes the API on
            // `default` as well as named exports. Normalizing here keeps the calls
            // below direct (same handling as src/core/tool-source.ts).
            ((module as { default?: typeof TypeScriptApi }).default ?? module) as typeof TypeScriptApi
    );

    return api;
};

// Whether one snippet parses as `dialect`.
export const checkTypeScript = async (code: string, dialect: TypeScriptDialect): Promise<boolean> => {
    // Awaited BEFORE the try: a failed module load must surface as the loader's own
    // error and must not be re-described as a parse failure.
    const ts = await loadApi();

    try {
        const output = ts.transpileModule(code, {
            // The extension is the dialect (see DIALECT_FILE_NAMES).
            fileName: DIALECT_FILE_NAMES[dialect],
            // Syntax diagnostics are the whole verdict; the emitted JavaScript is
            // discarded.
            reportDiagnostics: true,
            compilerOptions: {
                // Parse against the newest grammar the compiler knows, so a modern
                // snippet is not rejected for using newer syntax.
                languageVersion: ts.ScriptTarget.Latest,
                // JSX-family dialects keep their JSX in the output instead of
                // transforming it, which makes the emit a pure parse-and-print and
                // removes any dependence on a configured JSX runtime. Ignored for a
                // plain .ts file, so one option set covers all three dialects.
                jsx: ts.JsxEmit.Preserve
            }
        });

        // Only ERROR diagnostics refute the syntax. Warnings and suggestions (the
        // compiler also reports those categories) are advice, not a parse failure.
        return (output.diagnostics ?? []).every(
            (diagnostic) => diagnostic.category !== ts.DiagnosticCategory.Error
        );
    } catch (error) {
        // The compiler failed to produce output at all — a Debug failure inside the
        // emit rather than a diagnostic (that is how it behaves for a grammar it
        // cannot emit, e.g. JSON). That is not "invalid syntax", so it must not be
        // reported as a verdict: the caller has to know the checker itself broke.
        throw new HarnessError(`syntax could not parse the ${dialect} snippet.`, { cause: error });
    }
};
