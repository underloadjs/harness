// Published-shape helper shared by the packaging checks.
//
// WHY THIS EXISTS
// `package.json` `files` now publishes the editable source tree (`src`) beside the
// build (`dist`). Production tools must stay inspectable/editable, and the runtime
// compiler consumes TypeScript sources — generated `dist/` modules are not the
// editable source model (tasks/task-harness-self-modifying-tools.md §2/§8).
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
// The installed source-root contract is intentionally path-based, because it works
// in development and from the bundled ESM entries:
//
//   fileURLToPath(new URL('../src/', import.meta.url))  // from any dist/*.mjs
//
// Both `dist/` and `src/` are siblings inside `<package>/`, so the runtime never
// needs a manifest lookup to find editable tool sources.
//
// The glob subset is deliberately small: `*`, `**`, and `?` — exactly what the
// manifest uses. Extend it only together with the manifest.
//
// Cross-references:
//   - ../package.json                — `files` allow-list + negation rules
//   - ./check-package-types.mjs      — copies the published shape, checks source layout
//   - ./check-package-runtime.mjs    — checks the source tree ships beside dist
//   - ./scratch.mjs                  — scratch root under repository Temp/

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The two sibling roots the installed package must expose. Kept here so the
// scripts and the runtime owner share one spelling.
export const BUILD_ROOT = 'dist';
export const EDITABLE_SOURCE_ROOT = 'src';

// npm never packs VCS/dependency directories. `Temp` is this repository's agent
// scratch convention (root AGENTS.md); it must never leak into a package.
const NEVER_PACKED_DIRECTORIES = new Set(['.git', 'node_modules', 'Temp']);

const normalize = (value) => value.replace(/\\/g, '/').replace(/^\.\//, '');

export const isNegativePattern = (pattern) => pattern.startsWith('!');
export const stripNegation = (pattern) => (isNegativePattern(pattern) ? pattern.slice(1) : pattern);

const hasGlob = (pattern) => /[*?]/.test(pattern);

// Convert `*`, `**`, and `?` into a regexp over a normalized POSIX relative path.
// `**/` may match zero directories, so `src/**/*.test.ts` accepts both
// `src/a.test.ts` and `src/tools/a.test.ts` — the same meaning npm-packlist uses.
const globToRegExp = (pattern) => {
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

const matchesGlob = (pattern, relative) => globToRegExp(pattern).test(relative);

// A positive `files` entry is either a directory root (`dist`, `src`) or a glob.
// Directory roots include the directory itself and every descendant.
const matchesPositiveRoot = (pattern, relative) => {
    const root = stripNegation(pattern);
    if (hasGlob(root)) return matchesGlob(root, relative);
    return relative === root || relative.startsWith(`${root}/`);
};

// Negative entries exclude a file, or a directory and its subtree when the rule
// has no glob (`!src/frontend/dist`). Regular npm usage writes `dir/**`; both are
// accepted so a manifest edit does not silently stop excluding generated output.
const matchesNegativeRule = (rule, relative) => {
    const pattern = stripNegation(rule);
    if (hasGlob(pattern)) return matchesGlob(pattern, relative);
    return relative === pattern || relative.startsWith(`${pattern}/`);
};

export const readPackageManifest = (root = PACKAGE_ROOT) =>
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

export const publishedRoots = (manifest) => (manifest.files ?? []).filter((entry) => !isNegativePattern(entry));

const negativeRules = (manifest) => (manifest.files ?? []).filter(isNegativePattern);

// Walk a positive root. Directories npm always ignores are pruned, so even a
// mistakenly narrow `files` list cannot publish a cached dependency tree.
const walkFiles = (absolute, relative, visit) => {
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
 *
 * @param {{ root?: string, manifest?: { files?: string[] } }} [options]
 * @returns {string[]}
 */
export const publishedFiles = ({ root = PACKAGE_ROOT, manifest = readPackageManifest(root) } = {}) => {
    const positives = publishedRoots(manifest);
    const negatives = negativeRules(manifest);
    const files = new Set();

    const include = (relative) => {
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
 *
 * @param {string} target
 * @param {{ root?: string, manifest?: { files?: string[] } }} [options]
 */
export const isPublished = (target, { root = PACKAGE_ROOT, manifest = readPackageManifest(root) } = {}) => {
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
 *
 * @param {{ sourceRoot?: string, targetRoot: string, manifest?: { files?: string[] }, entries?: string[] }} options
 * @returns {string[]} the copied relative paths
 */
export const copyPublishedPackage = ({
    sourceRoot = PACKAGE_ROOT,
    targetRoot,
    manifest = readPackageManifest(sourceRoot),
    entries = publishedFiles({ root: sourceRoot, manifest })
}) => {
    mkdirSync(targetRoot, { recursive: true });

    for (const relative of entries) {
        const destination = path.join(targetRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(sourceRoot, relative), destination);
    }

    return entries;
};
