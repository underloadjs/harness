// @underload/harness tools/syntax — parse a snippet without running it.
//
// One public tool, `syntaxCheck({ code, language })`. The language-specific
// parsers (./javascript, ./python) are internal and loaded on demand by the tool.
//
// TYPE-ONLY BARREL (T21): the tool VALUE is reached through the generated
// descriptor loader (../descriptors) so importing this barrel never evaluates
// `node:vm` / the Python probe.
export type { SyntaxCheckLanguage, SyntaxCheckParameters } from './syntaxCheck.tool';
