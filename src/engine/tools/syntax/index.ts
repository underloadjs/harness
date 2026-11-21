// @underload/harness tools/syntax — parse a snippet without running it.
//
// One public tool, `syntax({ code, language })`. The language-specific checkers
// (./javascript, ./typescript, ./json, ./python) are internal and loaded on demand by
// the tool, so importing this barrel evaluates `node:vm`, the TypeScript compiler, or
// the Python interpreter probe for none of them.
//
// WHAT CHANGED WITH THE RENAME: `syntaxCheck` is now `syntax`, and the language set
// grew from javascript/python to javascript, typescript, tsx, jsx, json and python.
// `language` is a free-text NAME (the schema `enum` is gone) because a name is spelled
// loosely: aliases are normalized, and a language outside the table is an error, never
// a verdict. See ./syntax.tool.ts for the table.
//
// TYPE-ONLY BARREL (T21): the tool VALUE is reached through the generated descriptor
// loader (../descriptors) so importing this barrel never evaluates `node:vm` / the
// TypeScript compiler / the Python probe. The public type names keep their historical
// spelling (`SyntaxCheck*`) so a consumer's imports survive the wire rename.
export type { SyntaxCheckLanguage, SyntaxCheckParameters } from './syntax.tool';
