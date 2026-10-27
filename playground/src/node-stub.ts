// Browser stand-in for the Node built-ins the package's preset tools import.
//
// The playground bundles the real package source (`../src/harness.ts`). Its
// barrel re-exports the preset tools, and those statically import `node:fs`,
// `node:path`, `node:child_process`, and `node:vm`. Vite aliases every `node:`
// specifier here (see ../vite.config.ts) so the graph resolves in a browser.
//
// Nothing in this module works: each entry throws when touched, and the harness
// reports that throw as a tool result. The playground's own harnesses use
// browser-safe tools only, so this path exists purely to keep the import valid.

const unavailable = (name: string): never => {
    throw new Error(`${name} is not available in the browser playground.`);
};

export class Script {
    constructor() {
        unavailable('node:vm Script');
    }
}

// node:child_process
export const spawn = (..._arguments: unknown[]): never => unavailable('node:child_process spawn');
export const spawnSync = (..._arguments: unknown[]): never => unavailable('node:child_process spawnSync');

// node:fs/promises
export const mkdir = (..._arguments: unknown[]): never => unavailable('node:fs/promises mkdir');
export const readFile = (..._arguments: unknown[]): never => unavailable('node:fs/promises readFile');
export const readdir = (..._arguments: unknown[]): never => unavailable('node:fs/promises readdir');
export const writeFile = (..._arguments: unknown[]): never => unavailable('node:fs/promises writeFile');

// node:path
export const dirname = (..._arguments: unknown[]): never => unavailable('node:path dirname');
export const resolve = (..._arguments: unknown[]): never => unavailable('node:path resolve');
