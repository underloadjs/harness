// Automatic `.env` loading for the Node entry points (CLI, standalone server).
//
// Scope: imported only by `src/server/cli/index.ts`, `src/server/start.ts` (which
// `src/server/dev.ts` and the service runtime use) and the server runtime, never by
// a browser module. The library itself must never import it: importing
// `@underload/harness` must not read a user's files, and the browser build must not
// reach a `node:fs` graph. The frontend imports only types from `./protocol`, so
// this module never reaches the Vite browser graph. `yarn dev:frontend` is plain
// Vite and does not load this file.
//
// Location: the default file is package-relative (the package root detected by
// `./package-root.ts`), not cwd-relative. `yarn dev:server` runs
// `vite-node src/server/dev.ts` from the package directory, but a workspace-root
// launch (or a script run from another directory) still reads the same file:
//
//     packages/underload/harness/.env
//
// The path is deliberately NOT written as `new URL('../../.env', import.meta.url)`:
// Vite rewrites that pattern at build time and would inline the `.env` (with its
// keys) into the published bundle. `package-root.ts` walks up to `package.json`
// instead, which keeps one answer for the source tree and for `dist/`.
//
// Precedence: dotenv's default (`override: false`) leaves an existing process.env
// key untouched, including an explicitly empty one. Shell/exported values and CLI
// flags therefore remain authoritative; the file only fills gaps. A missing file
// is harmless because every setting has a fallback and the search keys are
// optional.
//
// Cross-references:
//   - ./config.ts           — reads HARNESS_BASE_URL / HARNESS_API_KEY / HARNESS_MODEL
//   - ../tools/websearch/index.ts — reads EXA_API_KEY / TAVILY_API_KEY once at
//                             harness construction, so loading must happen first
//   - ../../.env.example    — placeholders; `.env` itself is git-ignored

import { config } from 'dotenv';
import { packagePath } from './package-root';

// Package-root `.env`, resolved from this module rather than process.cwd(). The
// walk in ./package-root.ts makes the source tree and the bundle agree.
export const ENVIRONMENT_PATH = packagePath('.env');

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
