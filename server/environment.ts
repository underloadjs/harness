// Automatic `.env` loading for the Node entry points (CLI, server, playground dev).
//
// Scope: imported only by `cli/index.ts` and `server/index.ts` (which
// `playground/dev.ts` uses). The published library (`src/`) must never import it:
// the package stays dependency-free at runtime and importing `@underload/harness`
// must not read a user's files. The browser UI imports only types from
// `server/protocol.ts`, so this module never reaches the Vite browser graph.
//
// Location: the default file is module-relative (`../.env` from this file), not
// cwd-relative. `yarn start` runs `vite-node playground/dev.ts` from the package
// directory, but a workspace-root launch (or a script run from another directory)
// still reads the same package-root file:
//
//     packages/underload/harness/.env
//
// Precedence: dotenv's default (`override: false`) leaves an existing process.env
// key untouched, including an explicitly empty one. Shell/exported values and CLI
// flags therefore remain authoritative; the file only fills gaps. A missing file
// is harmless because every setting has a fallback and the search keys are
// optional.
//
// Cross-references:
//   - server/config.ts      — reads HARNESS_BASE_URL / HARNESS_API_KEY / HARNESS_MODEL
//   - src/tools/websearch/index.ts — reads EXA_API_KEY / TAVILY_API_KEY once at
//                             harness construction, so loading must happen first
//   - .env.example          — placeholders; `.env` itself is git-ignored

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Package-root `.env`, resolved from this module rather than process.cwd().
export const ENVIRONMENT_PATH = fileURLToPath(new URL('../.env', import.meta.url));

export type EnvironmentFileOptions = {
    // Defaults to ENVIRONMENT_PATH. Tests pass a fixture under the repo Temp/ dir.
    path?: string;
    // Defaults to process.env. Tests pass an object so they can assert precedence
    // without mutating the test runner's environment.
    environment?: Record<string, string | undefined>;
    // Escape hatch for tooling; application startup always keeps shell values.
    override?: boolean;
};

export type EnvironmentFileResult = {
    path: string;
    // True only when the file was read and parsed. Deliberately carries no parsed
    // values: callers cannot accidentally log a secret alongside the result.
    loaded: boolean;
};

export const loadEnvironmentFile = (options: EnvironmentFileOptions = {}): EnvironmentFileResult => {
    const path = options.path ?? ENVIRONMENT_PATH;

    // `quiet: true` suppresses dotenv's "injected env (n) from ..." startup line:
    // loading must not print counts, paths, or values. The error is reduced to the
    // boolean below so a missing or unreadable file cannot crash a cold start.
    const result = config({
        path,
        override: options.override ?? false,
        quiet: true,
        processEnv: options.environment ?? process.env
    });

    return { path, loaded: result.error === undefined };
};
