// syntax — parse a snippet without running it, for the languages this package has a
// real parser for.
//
// WHAT CHANGED (rename + widened parser set)
// ------------------------------------------
// This entry used to be `syntaxCheck` and understood exactly two languages, with a
// schema `enum` on `language`. It is now `syntax` and parses JavaScript, Python, and
// (new) TypeScript / TSX / JSX / JSON through parsers that are already in this
// package's dependency graph:
//
//     javascript  node:vm Script          a V8 CLASSIC-SCRIPT parse (import/export and
//                                                       top-level await are module syntax, so
//                                                       they parse false — unchanged behavior)
//     typescript  typescript transpileModule (syntax diagnostics only)
//     tsx         typescript transpileModule with a .tsx file name
//     jsx         typescript transpileModule with a .jsx file name
//     json        JSON.parse              strict RFC 8259
//     python      CPython compile()       an async, bounded child-process run
//
// The `enum` is gone because `language` is a NAME, and callers spell names loosely:
// "TS", "Python3", ".tsx". The implementation normalizes those (trim + casefold + a
// leading dot), and a name outside the table is an ERROR that lists the supported set.
// That is the whole contract of this tool: it never reports a language it cannot read
// as valid or invalid, and `false` always means "this snippet did not parse".
//
// WHY NOT "any language"
// ----------------------
// There is no universal parser here, and claiming one would be a lie a model acts on:
// a Go or Ruby snippet has no parser in this package, so it is rejected with the list
// of what IS supported. Each checker below is chosen because it only PARSES — no type
// checking, no execution, no file writes — so the verdict is a syntax verdict.
//
// LAZINESS (unchanged, and the reason the checkers stay separate modules)
// -----------------------------------------------------------------------
// Every language module is reached through `import()`, so `node:vm` never loads for a
// Python check, `node:child_process` never loads for a JavaScript check, and the
// TypeScript compiler (a multi-megabyte module) never loads for a JSON or Python
// check. The dispatch below is the only place that decides.
//
// Executable on its own and registerable on a harness:
//
//     await syntax({ code: 'const a = 1;', language: 'javascript' }); // true
//     await syntax({ code: 'const a: number = 1;', language: 'ts' }); // true
//     harness({ tools: { syntax } });                                 // model calls it
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';

// Every language this tool can actually parse, in the order the description lists
// them. Exported so the schema text, the alias table, the implementation, and a test
// that asserts "the docs and the table agree" all read one source of truth.
export const SYNTAX_LANGUAGES = ['javascript', 'typescript', 'tsx', 'jsx', 'json', 'python'] as const;

// The canonical names. Retained as a public type name (it used to be the whole
// parameter type when only two languages existed) so consumers that constrain their
// own calls to parsed languages keep compiling; a caller may also pass any alias
// string, which is why `SyntaxCheckParameters.language` is the wider `string`.
export type SyntaxCheckLanguage = (typeof SYNTAX_LANGUAGES)[number];

// Two properties, so the harness passes this whole object to execute (the
// single-property rule does not apply).
export type SyntaxCheckParameters = {
    code: string;
    // A language NAME, not a closed set: `language: string` is deliberate, because
    // the contract is "unsupported name -> error", not "unsupported name -> schema
    // rejection". Every accepted name resolves to a SyntaxCheckLanguage below.
    language: string;
};

// Accepted spellings, keyed by their NORMALIZED form (trimmed, casefolded, leading dot
// removed). Every value is a member of SYNTAX_LANGUAGES, so the table cannot advertise
// a language the dispatch below does not handle.
//
// Deliberately narrow: `node`/`deno` are NOT aliases for javascript, because that
// checker parses a classic script (no import/export), and a caller who means "a module"
// should get an honest false rather than an implied runtime.
const LANGUAGE_ALIASES: Readonly<Record<string, SyntaxCheckLanguage>> = {
    javascript: 'javascript',
    js: 'javascript',
    ecmascript: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    json: 'json',
    python: 'python',
    python3: 'python',
    py: 'python',
    py3: 'python'
};

// The human-readable support list, exported so the runtime error, the schema text, a
// UI, and a test that asserts "the docs and the language table agree" all read one
// definition. The metadata literal below spells the same list (the tool scanner
// requires metadata to be a PURE literal - no template interpolation - see
// src/core/tool-scan.ts), so the focused test compares this string against
// SYNTAX_LANGUAGES and against the description to keep them from drifting.
export const SYNTAX_LANGUAGE_SUMMARY = 'javascript (js), typescript (ts), tsx, jsx, json, python (py, python3)';

// Normalize one requested language into a canonical name, or reject it.
//
// `undefined` and a non-string go through the same rejection, because "no language"
// and "the wrong type of language" are the same caller mistake here: the tool has to
// refuse rather than guess a parser. The received value is echoed with String() so a
// caller sees what it actually sent.
const resolveLanguage = (value: unknown): SyntaxCheckLanguage => {
    if (typeof value === 'string') {
        // A leading dot is how a caller often names a language by its extension
        // (".ts", ".tsx"); everything else is the plain name.
        const requested = value.trim().toLowerCase().replace(/^\./, '');
        const resolved = LANGUAGE_ALIASES[requested];

        if (resolved !== undefined) return resolved;
    }

    throw new HarnessError(
        `syntax supports ${SYNTAX_LANGUAGE_SUMMARY}; received "${String(value)}". A language outside that list has no parser here, so it is reported as an error rather than answered with a syntax verdict.`
    );
};

// Validate `code` before any parser sees it.
//
// Every checker below treats "the snippet did not parse" as `false`. A value that is
// not source text at all (a number, an object, undefined) is therefore a malformed
// request, not a verdict — without this check node:vm would turn `code: 7` into a
// misleading `false`.
const requireCode = (value: unknown): string => {
    if (typeof value !== 'string') {
        throw new HarnessError(`syntax code must be a string; received "${String(value)}".`);
    }

    return value;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const SYNTAX_METADATA: PresetToolMetadata = {
    name: 'syntax',
    description:
        'Check whether a code snippet PARSES, without executing it. `language` names one of the parsers this tool actually has, and any other name is an error that lists them - never a syntax verdict. Supported: "javascript" (alias "js"; a V8 classic-script parse, so import/export and top-level await parse false), "typescript" ("ts"), "tsx", "jsx" (parsed by the TypeScript compiler reporting syntax diagnostics only - no type checking, so a type error is still true), "json" (strict RFC 8259: comments, trailing commas and single quotes are false, one leading byte-order mark is ignored), and "python" ("py" or "python3"; parsed by a real CPython 3 interpreter through compile(), which must be on PATH). Returns true when the snippet parses and false when it does not. Names are matched case-insensitively, trimmed, and a leading dot (".ts") means the same as "ts". A missing Python interpreter, a cancelled or timed-out Python check, a non-string `code`, and an unsupported language are all ERRORS, so `false` always means this snippet did not parse. Nothing here does semantic analysis, and there is no parser for any other language.',
    tags: ['code', 'syntax', 'javascript', 'typescript', 'json', 'python', 'validation'],
    // Two properties, so the single-property rule does not apply: execute
    // receives the whole { code, language } object, exactly what a direct
    // call passes.
    parameters: {
        type: 'object',
        properties: {
            code: { type: 'string', description: 'Source code to check.' },
            language: {
                type: 'string',
                minLength: 1,
                // A plain literal, not a template string: the tool scanner reads this
                // object as DATA (src/core/tool-scan.ts). SYNTAX_LANGUAGE_SUMMARY above
                // spells the identical list, and the focused test proves they agree.
                description:
                    'Language to parse the snippet as. Parsers exist for javascript (js), typescript (ts), tsx, jsx, json, python (py, python3); an alias is matched case-insensitively and a leading dot is allowed. Any other name is an error.'
            }
        },
        required: ['code', 'language'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = SYNTAX_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // Keeps the slot `syntaxCheck` held, so renaming changes no discovery order.
    order: 160,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const syntax = tool<SyntaxCheckParameters, boolean>({
    ...SYNTAX_METADATA,
    execute: async (context) => {
        // A direct caller may hand nothing at all; both reads below are defensive for
        // that case and produce a named error instead of a TypeError.
        const parameters = (context.parameters ?? {}) as Partial<SyntaxCheckParameters>;

        // context.signal is being added to ToolContext by a parallel change; read it
        // structurally so this module works with or without that field typed.
        // Only the Python checker consumes it — the other checks never yield.
        const signal = (context as { signal?: AbortSignal }).signal;

        const code = requireCode(parameters.code);
        const language = resolveLanguage(parameters.language);

        switch (language) {
            case 'javascript': {
                // Loaded on demand: this keeps node:vm out of every other check.
                const { checkJavaScript } = await import('./javascript');
                return checkJavaScript(code);
            }

            case 'typescript':
            case 'tsx':
            case 'jsx': {
                // Loaded on demand: this keeps the TypeScript compiler out of a
                // JavaScript, JSON or Python check.
                const { checkTypeScript } = await import('./typescript');
                return checkTypeScript(code, language);
            }

            case 'json': {
                // Loaded on demand for symmetry with the other checkers; this one is
                // only ever `JSON.parse`, so it costs nothing either way.
                const { checkJson } = await import('./json');
                return checkJson(code);
            }

            case 'python': {
                // Loaded on demand: this keeps node:child_process (and the
                // interpreter probe) out of every other check.
                const { checkPython } = await import('./python');
                return checkPython(code, signal);
            }
        }
    }
});
