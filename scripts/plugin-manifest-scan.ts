// The plugin-folder scanner (shared by the generator and its test).
//
// WHY A SEPARATE MODULE
// ---------------------
// `generate-plugin-manifest.ts` is a CLI: it exits the process, which makes it
// untestable in-process. The discovery rules below are the part that carries the
// contract (what counts as a plugin, what a valid name is, what order the manifest is
// in), so they live here as a pure function that either returns entries or throws. The
// generator and `src/plugin/manifest.test.ts` then read the SAME rules — there is no
// second implementation to drift, exactly like `src/core/tool-scan.ts` is shared by the
// tool generator and the runtime.
//
// THE RULES
// ---------
// Each `*.plugin.ts` under `pluginsRoot` must:
//   - export `metadata` as an OBJECT LITERAL (`export const metadata = {`). A computed
//     or imported value cannot be described without executing the plugin, and the whole
//     point of metadata is that the manifest, the server and the UI read it as data;
//   - declare a literal `name:` matching /^[a-z][a-z0-9_-]*$/ — the same shape the
//     harness uses for agent and tool names, so a plugin name is always a safe settings
//     key and a safe manifest identifier;
//   - export `setup` as a function. A plugin with no behaviour is a metadata bug.
// Names must be UNIQUE: two built-ins with one name would make the
// `configuration.plugins` replacement rule ambiguous and collide one settings
// namespace.
//
// ORDER: path-ascending, computed at discovery so the rendered manifest is identical on
// every platform regardless of readdir order.
import fs from 'node:fs';
import path from 'node:path';
import { identifierOf, type PluginManifestEntry } from './plugin-manifest-render.ts';

export const PLUGIN_SUFFIX = '.plugin.ts';
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

// A scan problem is a distinct error so the CLI can print and exit while a test can
// assert the message without matching a generic Error.
export class PluginScanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginScanError';
    }
}

// Depth-first, path-sorted file list (package-relative, forward slashes).
//
// `__tests__` and dot-folders are skipped: they are test/IDE layout, not plugin
// packages. Everything else under the root is expected to be a discoverable entry.
// The return annotation is required: the function recurses through its own
// `push(...)`, which leaves the return type circular without it.
export const collectPluginFiles = (pluginsRoot: string, relative = ''): string[] => {
    const found: string[] = [];

    for (const entry of fs
        .readdirSync(path.join(pluginsRoot, relative), { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;

        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === '__tests__') continue;
            found.push(...collectPluginFiles(pluginsRoot, childRelative));
            continue;
        }

        if (!entry.isFile() || !entry.name.endsWith(PLUGIN_SUFFIX)) continue;
        found.push(childRelative);
    }

    return found.sort();
};

// One shared regex per required export. Deliberately permissive about surrounding
// whitespace and about an `as`/`satisfies` clause after the literal, because
// `satisfies HarnessPluginMetadata` is the documented convention in these files.
const METADATA_LITERAL = /export\s+const\s+metadata\s*(?::[^=]*)?=\s*\{/;
const METADATA_NAME =
    /export\s+const\s+metadata\s*(?::[^=]*)?=\s*\{[\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/;
const SETUP_EXPORT = /export\s+const\s+setup\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

// Scans `pluginsRoot` and returns the manifest entries in render order.
//
// `manifestRelative` is the specifier prefix used to build the import path, relative to
// the generated file (default: the shipped `src/plugin/manifest.ts` -> `../plugins/...`).
// A test pointing at a fixture folder passes its own prefix, so the same scanner
// produces the same entry shape without knowing where the manifest will land.
export const discoverPluginEntries = (options: {
    pluginsRoot: string;
    /** Specifier prefix for the import path, relative to the generated manifest. */
    manifestRelative?: string;
}): PluginManifestEntry[] => {
    const { pluginsRoot, manifestRelative = '../plugins' } = options;

    if (!fs.existsSync(pluginsRoot)) {
        // A missing root fails loudly rather than emitting an empty manifest: an empty
        // manifest silently turns auto-discovery off.
        throw new PluginScanError(`plugins root is missing: ${pluginsRoot}`);
    }

    const entries: PluginManifestEntry[] = [];
    const names = new Map<string, string>();
    const identifiers = new Map<string, string>();

    for (const relativePath of collectPluginFiles(pluginsRoot)) {
        const text = fs.readFileSync(path.join(pluginsRoot, relativePath), 'utf8');
        const label = `${relativePath}`;

        if (!METADATA_LITERAL.test(text)) {
            throw new PluginScanError(`${label}: must export \`metadata\` as an object literal.`);
        }

        if (!SETUP_EXPORT.test(text)) {
            throw new PluginScanError(`${label}: must export \`setup\` as a function.`);
        }

        const match = METADATA_NAME.exec(text);

        if (match === null) {
            throw new PluginScanError(`${label}: \`metadata\` must declare a string literal \`name\`.`);
        }

        const name = match[1];

        if (!PLUGIN_NAME_PATTERN.test(name)) {
            throw new PluginScanError(
                `${label}: plugin name "${name}" must match /^[a-z][a-z0-9_-]*$/.`
            );
        }

        const clash = names.get(name);

        if (clash !== undefined) {
            throw new PluginScanError(`${label}: plugin name "${name}" is already used by ${clash}.`);
        }
        names.set(name, label);

        // Identifier uniqueness: `a-b.plugin.ts` and `aB.plugin.ts` both camel-case to
        // `aB`, which would emit two imports under one name.
        const identifier = identifierOf(relativePath);
        const other = identifiers.get(identifier);

        if (other !== undefined) {
            throw new PluginScanError(
                `${label} and ${other} render the same identifier "${identifier}".`
            );
        }
        identifiers.set(identifier, label);

        entries.push({
            relativePath,
            name,
            // Extension omitted, like every other import in this package.
            importPath: `${manifestRelative}/${relativePath.replace(/\.ts$/, '')}`,
            identifier
        });
    }

    return entries;
};
