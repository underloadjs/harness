// JSON half of syntax — validate JSON text without evaluating it.
//
// WHY JSON.parse and not the TypeScript parser
// --------------------------------------------
// The TypeScript compiler can also read a .json file, but `transpileModule` cannot EMIT
// one (it fails with a Debug "Output generation failed" for a JSON source file), and the
// compiler's JSON reader is deliberately lenient — it accepts comments and trailing
// commas, i.e. JSONC. This tool promises a JSON syntax verdict, and `JSON.parse` IS the
// ECMAScript definition of that grammar: exact, dependency-free, and it agrees with every
// consumer of the parsed value. So:
//
//   - true  -> the text is a single valid JSON value;
//   - false -> it is not: a comment, a trailing comma, a single-quoted string, two
//              top-level values, or any other deviation from RFC 8259 / ECMA-262 JSON.
//
// A leading byte-order mark is stripped before parsing. The spec allows an
// implementation to ignore a BOM, and files on disk carry one often enough that treating
// it as a syntax error would be a misleading `false` (the TypeScript parser used by the
// ts/tsx/jsx half ignores it too, so the two halves agree).
//
// A thrown parse is therefore ALWAYS a verdict (JSON.parse throws only for malformed
// text), which is why this half needs no infrastructure-error path: nothing runs and no
// external process is involved.
//
// This module is loaded through `import()` by ./syntax.tool.ts alongside the other
// language halves, keeping the dispatch uniform.
//
// Cross-references:
//   - ./syntax.tool.ts   — the public tool, the language table and the dispatch
//   - ./typescript.ts    — the ts/tsx/jsx half (syntax diagnostics, not strict JSON)

// Drop one leading byte-order mark (U+FEFF), which the grammar allows an
// implementation to ignore. Compared by code unit so no escape sequence is needed in
// this source file, and only index 0 is ever touched.
const stripByteOrderMark = (value: string): string =>
    value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;

// Whether `code` is one valid JSON document.
export const checkJson = (code: string): boolean => {
    try {
        JSON.parse(stripByteOrderMark(code));
        return true;
    } catch {
        // Every JSON.parse failure is a syntax failure — the parser never runs code
        // and never reports an environmental problem.
        return false;
    }
};
