// syntaxCheck — parse a JavaScript or Python snippet without running it.
//
// One registered preset replaces the old javascriptSyntax/pythonSyntax pair: the
// caller names the language, and the matching parser is imported only when that
// language is actually checked. `node:vm` therefore never loads for a Python
// check, and `node:child_process` never loads for a JavaScript check.
//
// Executable on its own and registerable on a harness:
//
//     await syntaxCheck({ code: 'const a = 1;', language: 'javascript' }); // true
//     harness({ tools: { syntaxCheck } });                                // model calls it
//
// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.

import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

// The two languages the tool understands. Exported so the wire schema, the
// implementation, and consumers all describe the same union.
export type SyntaxCheckLanguage = 'javascript' | 'python';

// Two properties, so the harness passes this whole object to execute (the
// single-property rule does not apply).
export type SyntaxCheckParameters = {
    code: string;
    language: SyntaxCheckLanguage;
};

export const syntaxCheck = tool<SyntaxCheckParameters, boolean>({
    ...PRESET_TOOLS.syntaxCheck,
    execute: async (context) => {
        const parameters = context.parameters;

        // context.signal is being added to ToolContext by a parallel change; read
        // it structurally so this module works with or without that field typed.
        // Only the Python checker consumes it — the JS check never yields.
        const signal = (context as { signal?: AbortSignal }).signal;

        // The schema constrains `language`, but a direct call bypasses it. Reject
        // an unknown language as a setup error rather than returning a silent
        // "false" that would look like a syntax verdict.
        switch (parameters?.language) {
            case 'javascript': {
                // Loaded on demand: this keeps node:vm out of a Python check.
                const { checkJavaScript } = await import('./javascript');
                return checkJavaScript(parameters.code);
            }

            case 'python': {
                // Loaded on demand: this keeps node:child_process (and the
                // interpreter probe) out of a JavaScript check.
                const { checkPython } = await import('./python');
                return checkPython(parameters.code, signal);
            }

            default:
                throw new HarnessError(
                    `syntaxCheck requires language to be "javascript" or "python"; received "${String(
                        parameters?.language
                    )}".`
                );
        }
    }
});
