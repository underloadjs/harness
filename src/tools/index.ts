// @underload/harness tools — preset tools the agent can use.
//
// Every preset is a standard `tool()`: a name, a description, a JSON Schema, and
// one implementation. Each is also an executable object, so it works with no
// harness at all:
//
//     import { pythonSyntax, readFile } from '@underload/harness';
//
//     await pythonSyntax('print(1)');                 // true
//     await readFile('package.json');                 // the file, as text
//
//     harness({ tools: { pythonSyntax, readFile } }); // the model calls them
//
// They are deliberately opinionated about *shape* and unopinionated about
// *policy*: no sandboxing, no confirmation prompts, no allowlists. A harness that
// needs a fence wraps `execute`, or runs the process inside one.
export { javascriptSyntax, pythonSyntax } from './syntax';
export { readFile, writeFile, listFiles } from './files';
export type { WriteFileResult } from './files';
export { runCommand } from './command';
export type { RunCommandResult } from './command';
