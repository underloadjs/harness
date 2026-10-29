// Declaration-specifier fixer for the published `dist/` tree.
//
// WHY THIS EXISTS
// `tsc -p tsconfig.build.json` emits declarations that preserve the SOURCE
// specifier text, which is extensionless (`./harness`, `../server/protocol`,
// `./ui/turns`). Node's ESM resolver — and therefore any consumer using
// `moduleResolution: node16 | nodenext` — rejects those emitted files with TS2834
// ("Relative import paths need explicit file extensions"), because the package is
// `"type": "module"` and every declaration is ESM.
//
// The library is ESM-only, so the fix is to post-process the emitted declarations
// and point every relative specifier at its sibling declaration's JS name:
//
//     export * from './harness';          ->  export * from './harness.js';
//     export * from './ui/turns';         ->  export * from './ui/turns.js';   (turns.d.ts)
//     export * from './harnesses';        ->  export * from './harnesses/index.js';
//
// `.js` is the specifier TypeScript itself prescribes: under NodeNext it resolves
// `./harness.js` to `./harness.d.ts` (the JS file need not exist; the published JS
// is bundled). This is a build-layer concern only — no source file carries an
// extension, so no source text changes.
//
// ALGORITHM (deterministic, fails loudly)
//   1. Walk the declaration tree for `*.d.ts` (sorted, for stable output).
//   2. On every non-comment line, rewrite relative specifiers in the three
//      syntactic positions declarations can use: `from '…'`, `import '…'` and
//      `import('…')`.
//   3. Resolve each one against the EMITTED tree: `<spec>.d.ts`, else
//      `<spec>/index.d.ts`. Anything that resolves is rewritten to `<spec>.js`;
//      anything that does not is reported and the CLI exits non-zero (silent
//      omission would ship a package that cannot be type-checked).
//   4. An already-`.js` specifier is verified, never rewritten, so a second run is
//      a no-op (idempotent) and `--check` is a CI-able assertion.
//
// USAGE
//     node scripts/fix-declaration-specifiers.mjs            # <package>/dist
//     node scripts/fix-declaration-specifiers.mjs <dir>       # any emitted tree
//     node scripts/fix-declaration-specifiers.mjs <dir> --check   # report only
//
// Cross-references:
//   - ../tsconfig.build.json     — the declaration emit this post-processes
//   - ./check-package-types.mjs  — asserts a built package with real consumers
//   - ../package.json            — `build:types` runs this after the emit

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The package root: this file lives in `<package>/scripts/`.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Explicit non-declaration extensions that must be left alone (they are not
// relative declaration references, and rewriting them would break resolution).
const EXPLICIT_EXTENSION = /\.(?:mjs|cjs|json|css|node|wasm)$/i;

// `from '…'`, `import '…'` and `import('…')` — the only positions a declaration can
// use for a module reference. Group 1 is the lead-in, 2 the quote, 3 the specifier
// (its backreference keeps the closing quote identical). The specifier may be a bare
// `.`/`..` (a directory reference, e.g. `import("..").Tool`) or a path. Comment lines
// are skipped by the callers, so prose cannot match.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g;

// Lines that are comments in emitted declarations (JSDoc bodies, `//` notes).
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

// A relative specifier: only these are this script's business.
const RELATIVE = /^\.{1,2}(?:\/|$)/;

/**
 * Every module specifier a declaration text references (`from '…'`, `import '…'`,
 * `import('…')`), in source order. Comment lines are excluded, exactly as in the
 * rewrite, so "what this file points at" has one definition.
 * @param {string} text
 * @returns {string[]}
 */
export const declarationSpecifiers = (text) =>
    text
        .split(/\r?\n/)
        .filter((line) => !COMMENT_LINE.test(line))
        .flatMap((line) => [...line.matchAll(SPECIFIER)].map((match) => match[3]));

/**
 * Every `*.d.ts` under `directory`, sorted so output is stable across platforms.
 * @param {string} directory
 * @returns {string[]}
 */
export const listDeclarationFiles = (directory) => {
    if (!existsSync(directory)) return [];

    /** @type {string[]} */
    const files = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listDeclarationFiles(full));
        } else if (entry.name.endsWith('.d.ts')) {
            files.push(full);
        }
    }

    return files.sort();
};

/**
 * Resolve one relative specifier against the emitted tree.
 *
 * Returns the replacement specifier, or `null` when no declaration answers it (the
 * caller treats that as a build failure). A specifier already ending in `.js` is
 * returned unchanged when its `.d.ts` sibling exists.
 *
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | null}
 */
const resolveSpecifier = (fromFile, specifier) => {
    const directory = path.dirname(fromFile);
    const cleaned = specifier.replace(/\/+$/, '');
    const resolved = path.resolve(directory, cleaned);

    // Already in JS form: valid only if the sibling declaration is really there.
    if (/\.js$/i.test(cleaned)) {
        return existsSync(resolved.replace(/\.js$/i, '.d.ts')) ? specifier : null;
    }

    // A non-JS explicit extension (`.json`, `.css`) is not a declaration reference.
    if (EXPLICIT_EXTENSION.test(cleaned)) {
        return existsSync(resolved) ? specifier : null;
    }

    // `<spec>.d.ts`  -> `<spec>.js`
    if (existsSync(`${resolved}.d.ts`)) return `${cleaned}.js`;

    // `<spec>/index.d.ts` -> `<spec>/index.js`
    if (existsSync(path.join(resolved, 'index.d.ts'))) return `${cleaned}/index.js`;

    return null;
};

/**
 * Pure rewrite of one declaration's TEXT (no I/O).
 *
 * @param {string} text
 * @param {string} filePath  used only to resolve specifiers and in the report
 * @param {{ file: string, specifier: string }[]} unresolved
 * @returns {{ text: string, changed: boolean }}
 */
export const rewriteDeclarationText = (text, filePath, unresolved) => {
    let changed = false;

    const lines = text.split(/\r?\n/).map((line) => {
        // Comments can mention paths (`./main.ts`) without being references.
        if (COMMENT_LINE.test(line)) return line;

        return line.replace(SPECIFIER, (match, lead, quote, specifier) => {
            if (!RELATIVE.test(specifier)) return match;

            const replacement = resolveSpecifier(filePath, specifier);

            if (replacement === null) {
                unresolved.push({ file: filePath, specifier });
                return match;
            }

            if (replacement === specifier) return match;

            changed = true;
            return `${lead}${quote}${replacement}${quote}`;
        });
    });

    // Preserve the emit's line endings byte-for-byte.
    return { text: lines.join(text.includes('\r\n') ? '\r\n' : '\n'), changed };
};

/**
 * Fix (or, with `checkOnly`, only inspect) every declaration under `directory`.
 *
 * @param {{ directory?: string, checkOnly?: boolean }} [options]
 * @returns {{
 *   directory: string,
 *   scanned: number,
 *   rewritten: string[],
 *   unresolved: { file: string, specifier: string }[]
 * }}
 */
export const fixDeclarationSpecifiers = (options = {}) => {
    // Default target is this package's own build output.
    const directory = path.resolve(options.directory ?? path.join(PACKAGE_ROOT, 'dist'));
    const checkOnly = options.checkOnly ?? false;
    const files = listDeclarationFiles(directory);

    /** @type {{ file: string, specifier: string }[]} */
    const unresolved = [];
    /** @type {string[]} */
    const rewritten = [];

    for (const file of files) {
        const original = readFileSync(file, 'utf8');
        const result = rewriteDeclarationText(original, file, unresolved);

        if (!result.changed) continue;

        rewritten.push(file);
        // `--check` reports what a real run would change and leaves the tree alone.
        if (!checkOnly) writeFileSync(file, result.text, 'utf8');
    }

    return { directory, scanned: files.length, rewritten, unresolved };
};

// CLI: fail loudly on an unresolvable specifier, and on a `--check` that would rewrite.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const checkOnly = process.argv.includes('--check');
    const directory = process.argv[2]?.startsWith('--') === true ? undefined : process.argv[2];
    const result = fixDeclarationSpecifiers({ directory, checkOnly });

    if (result.unresolved.length > 0) {
        for (const item of result.unresolved) {
            console.error(`unresolved declaration specifier: '${item.specifier}' in ${item.file}`);
        }
        process.exit(1);
    }

    if (checkOnly && result.rewritten.length > 0) {
        for (const file of result.rewritten) {
            console.error(`declaration needs an explicit .js specifier: ${file}`);
        }
        process.exit(1);
    }

    console.log(
        `declarations: ${checkOnly ? 'checked' : 'rewrote'} ${result.rewritten.length}/${result.scanned} file(s) in ${result.directory}`
    );
}
