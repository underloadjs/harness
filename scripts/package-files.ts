// Published-shape helper shared by the packaging checks.
//
// WHY THIS EXISTS
// `package.json` `files` publishes the editable source tree and NOTHING ELSE. This
// package is a source-only library (root AGENTS.md §c): `exports`, `main`, `module`
// and `types` all name `src/*.ts`, there is no `dist/` build, no `.mjs`/`.cjs`, and
// no declaration emit. Production tools stay inspectable/editable, and the runtime
// compiler consumes exactly the TypeScript sources a consumer installs — there is no
// generated twin to keep in sync (tasks/task-harness-self-modifying-tools.md §2/§8).
//
// Because `files` also contains negation patterns (`!src/**/*.test.ts`, ...), the
// raw array can no longer be passed to `cpSync`: those entries are rules, not
// paths. This module is the single interpretation of the manifest:
//
//   - `publishedFiles()` resolves every positive root and applies the negation
//     rules, producing the packed file set. npm additionally always includes the
//     root manifest/README/LICENSE; the checks write `package.json` explicitly and
//     do not need those extras.
//   - `copyPublishedPackage()` materialises that list into a scratch package so
//     the type/runtime consumers are checked against the INSTALLED layout.
//   - `isPublished()` answers "is this export target inside `files`?".
//
// The installed source-root contract is path-based, because it works for a workspace
// run and for an installed consumer alike:
//
//   fileURLToPath(new URL('../src/', import.meta.url))  // from any src/** module
//
// `src/` IS the package payload, so the runtime never needs a manifest lookup to
// find editable tool sources — the sibling `dist/` this helper used to model is gone.
//
// The glob subset is deliberately small: `*`, `**`, and `?` — exactly what the
// manifest uses. Extend it only together with the manifest.
//
// Cross-references:
//   - ../package.json                — `files` allow-list + negation rules
//   - ./check-package-types.ts      — copies the published shape, checks the source-only manifest
//   - ./check-package-runtime.ts    — runs the PUBLISHED source entries (installed-layout smoke)
//   - ./scratch.ts                  — scratch root under repository Temp/

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The single root the installed package exposes, kept here so the scripts and the
// runtime owner share one spelling. There is deliberately NO build root any more:
// this package publishes `src/*.ts` only (root AGENTS.md §c), so the sibling
// `dist/` directory this constant used to name does not exist and must not come back.
export const EDITABLE_SOURCE_ROOT = 'src';

// The ONE non-TypeScript file the published tree is allowed to carry, and the only
// exception to `BUILD_ARTIFACT`: the plain-JS worker-thread bootstrap. `node:
// worker_threads` loads its entry with raw Node, which cannot parse this repo's
// TypeScript, so the spawn entry has to be JS — everything it runs is `.ts`, fetched
// through Vite's ModuleRunner (see that file's header for the full reasoning).
export const PERMITTED_BUILD_ARTIFACT = `${EDITABLE_SOURCE_ROOT}/server/workers/worker-boot.mjs`;

// A built artifact by extension — the shape a stray `tsc`/`vite build` emit would
// leave inside the published tree. Source-only publishing ships none of these; the
// packaging checks fail the release on any of them (the shared spelling behind
// check-package-types.ts and check-package-runtime.ts).
//
// `.d.ts` is deliberately NOT in this list: two hand-written AMBIENT declarations ship
// as source (`src/frontend/vite-env.d.ts` for `import.meta.env`, and
// `src/frontend/ui/highlight-core.d.ts` for the `highlight.js/lib/core` subpath the
// dependency's own `exports` map leaves untyped). They are authored input, not emit,
// and a consumer needs them to type-check the published source. What IS an artifact is
// an emitted declaration TWIN — a `foo.d.ts` next to `foo.ts` — so that rule lives in
// `isBuiltArtifact()` below, where both sides of the pair are visible.
export const BUILD_ARTIFACT = /\.(?:mjs|cjs|js|map)$/iu;

// One half of an emitted declaration pair (`index.d.ts` beside `index.ts`).
export const EMITTED_DECLARATION = /\.d\.ts$/iu;

/**
 * Is a packed file a build artifact rather than authored source?
 *
 * `packed` is the full published path set, which is what makes the twin rule
 * possible: a lone `.d.ts` is an ambient declaration (source), a `.d.ts` with a
 * `.ts`/`.tsx` sibling is something `tsc` wrote.
 */
export const isBuiltArtifact = (file: string, packed: ReadonlySet<string>): boolean => {
    if (file === PERMITTED_BUILD_ARTIFACT) return false;
    if (BUILD_ARTIFACT.test(file)) return true;
    if (!EMITTED_DECLARATION.test(file)) return false;

    const source = file.slice(0, -'.d.ts'.length);
    return packed.has(`${source}.ts`) || packed.has(`${source}.tsx`);
};

// npm never packs VCS/dependency directories. `Temp` is this repository's agent
// scratch convention (root AGENTS.md); it must never leak into a package.
const NEVER_PACKED_DIRECTORIES = new Set(['.git', 'node_modules', 'Temp']);

// The manifest subset this module interprets. `files` is the only field it reads;
// the parsed `package.json` object carries much more, and callers (the three
// `check-package-*` scripts) read `type`/`exports`/`dependencies` off the SAME object,
// so those fields are declared here and the index signature keeps every other real
// manifest field reachable without weakening the shape this helper depends on.
export type PackageManifest = {
    files?: string[];
    type?: string;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    [key: string]: unknown;
};

/** Options that resolve against a package root: defaults to this package. */
export type PublishedFileOptions = { root?: string; manifest?: PackageManifest };

/** Options for `copyPublishedPackage`. */
export type CopyPublishedOptions = {
    sourceRoot?: string;
    targetRoot: string;
    manifest?: PackageManifest;
    entries?: string[];
};

const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');

export const isNegativePattern = (pattern: string): boolean => pattern.startsWith('!');
export const stripNegation = (pattern: string): string => (isNegativePattern(pattern) ? pattern.slice(1) : pattern);

const hasGlob = (pattern: string): boolean => /[*?]/.test(pattern);

// Convert `*`, `**`, and `?` into a regexp over a normalized POSIX relative path.
// `**/` may match zero directories, so `src/**/*.test.ts` accepts both
// `src/a.test.ts` and `src/tools/a.test.ts` — the same meaning npm-packlist uses.
const globToRegExp = (pattern: string): RegExp => {
    let expression = '';

    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];

        if (character === '*') {
            if (pattern[index + 1] === '*') {
                if (pattern[index + 2] === '/') {
                    expression += '(?:.*/)?';
                    index += 2;
                } else {
                    expression += '.*';
                    index += 1;
                }
            } else {
                expression += '[^/]*';
            }
            continue;
        }

        if (character === '?') {
            expression += '[^/]';
            continue;
        }

        expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    return new RegExp(`^${expression}$`);
};

const matchesGlob = (pattern: string, relative: string): boolean => globToRegExp(pattern).test(relative);

// A positive `files` entry is either a directory root (`dist`, `src`) or a glob.
// Directory roots include the directory itself and every descendant.
const matchesPositiveRoot = (pattern: string, relative: string): boolean => {
    const root = stripNegation(pattern);
    if (hasGlob(root)) return matchesGlob(root, relative);
    return relative === root || relative.startsWith(`${root}/`);
};

// Negative entries exclude a file, or a directory and its subtree when the rule
// has no glob (`!src/frontend/dist`). Regular npm usage writes `dir/**`; both are
// accepted so a manifest edit does not silently stop excluding generated output.
const matchesNegativeRule = (rule: string, relative: string): boolean => {
    const pattern = stripNegation(rule);
    if (hasGlob(pattern)) return matchesGlob(pattern, relative);
    return relative === pattern || relative.startsWith(`${pattern}/`);
};

export const readPackageManifest = (root = PACKAGE_ROOT): PackageManifest =>
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

export const publishedRoots = (manifest: PackageManifest): string[] =>
    (manifest.files ?? []).filter((entry: string) => !isNegativePattern(entry));

const negativeRules = (manifest: PackageManifest): string[] => (manifest.files ?? []).filter(isNegativePattern);

// Walk a positive root. Directories npm always ignores are pruned, so even a
// mistakenly narrow `files` list cannot publish a cached dependency tree.
const walkFiles = (absolute: string, relative: string, visit: (relative: string) => void): void => {
    if (NEVER_PACKED_DIRECTORIES.has(path.basename(absolute))) return;

    const stats = statSync(absolute);
    if (stats.isDirectory()) {
        const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
            left.name.localeCompare(right.name)
        );
        for (const entry of entries) {
            walkFiles(path.join(absolute, entry.name), `${relative}/${entry.name}`, visit);
        }
        return;
    }

    if (stats.isFile()) visit(relative);
};

/**
 * Resolve `package.json#files` to the exact sorted list of packed relative paths.
 */
export const publishedFiles = ({
    root = PACKAGE_ROOT,
    manifest = readPackageManifest(root),
}: PublishedFileOptions = {}): string[] => {
    const positives = publishedRoots(manifest);
    const negatives = negativeRules(manifest);
    const files = new Set<string>();

    const include = (relative: string): void => {
        if (negatives.some((rule) => matchesNegativeRule(rule, relative))) return;
        files.add(relative);
    };

    for (const positive of positives) {
        const relativeRoot = normalize(positive);

        // A glob root has no single filesystem starting point, so walk the package
        // root and filter every file through the same root matcher.
        if (hasGlob(relativeRoot)) {
            walkFiles(root, '', (relative) => {
                if (matchesPositiveRoot(relativeRoot, relative)) include(relative);
            });
            continue;
        }

        const absolute = path.join(root, relativeRoot);
        if (!existsSync(absolute)) continue;

        walkFiles(absolute, relativeRoot, (relative) => {
            if (matchesPositiveRoot(relativeRoot, relative)) include(relative);
        });
    }

    return [...files].sort((left, right) => left.localeCompare(right));
};

/**
 * Is a relative path (export target or source file) inside the packed shape?
 */
export const isPublished = (
    target: string,
    { root = PACKAGE_ROOT, manifest = readPackageManifest(root) }: PublishedFileOptions = {},
): boolean => {
    const relative = normalize(target);
    const positives = publishedRoots(manifest);
    const negatives = negativeRules(manifest);

    return (
        positives.some((pattern) => matchesPositiveRoot(pattern, relative)) &&
        !negatives.some((rule) => matchesNegativeRule(rule, relative))
    );
};

/**
 * Copy the resolved published file list into `targetRoot`. Per-file copying (as
 * opposed to `cpSync` of `files` entries) is what makes negation rules real and
 * keeps generated output such as `src/frontend/dist` out of the consumer fixture.
 */
export const copyPublishedPackage = ({
    sourceRoot = PACKAGE_ROOT,
    targetRoot,
    manifest = readPackageManifest(sourceRoot),
    entries = publishedFiles({ root: sourceRoot, manifest })
}: CopyPublishedOptions): string[] => {
    mkdirSync(targetRoot, { recursive: true });

    for (const relative of entries) {
        const destination = path.join(targetRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(sourceRoot, relative), destination);
    }

    return entries;
};
