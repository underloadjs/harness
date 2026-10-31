// @underload/harness tools/syntax — parse a snippet without running it.
//
// One public tool, `syntaxCheck({ code, language })`. The language-specific
// parsers (./javascript, ./python) are internal and loaded on demand by the tool.
export { syntaxCheck } from './syntaxCheck.tool';
export type { SyntaxCheckLanguage, SyntaxCheckParameters } from './syntaxCheck.tool';
