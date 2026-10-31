// Tool scan — the AST half of discovery, with NO dependency on the manifest.
//
// WHY THIS IS A SEPARATE MODULE (T19 / R8-R9)
// ------------------------------------------
// `./tool-discovery.ts` exposes `discoverToolMetadata()` and answers a browser with
// the GENERATED manifest (`./tool-manifest.ts`). That means discovery statically
// imports the manifest, and the manifest's generator (`scripts/generate-tool-manifest.mjs`)
// must therefore be able to scan WITHOUT loading discovery — otherwise the first
// generation would need a manifest that does not exist yet, and every regeneration
// would read the stale table it is about to replace.
//
// This module is that scan, and it is a LEAF: it imports only `../util`, the shape
// types in `./tool-metadata`, and (at call time) `node:fs`/`node:path`/`node:url`/
// `typescript`. Folder resolution/scanning is INJECTED by the caller so this module
// never reaches `./tool-source` (which does import the manifest).
//
// Nothing here evaluates candidate code and nothing here imports a `.tool` module:
// the entry is read as TEXT and parsed with the TypeScript parser.
//
// Cross-references:
//   - ./tool-discovery.ts — public API + browser manifest fallback
//   - ./tool-metadata.ts  — the shapes this module produces
//   - ../tools/**/*.tool.ts — the authoritative metadata owners

import { HarnessError } from '../util';
import type {
    DiscoveredTool,
    DiscoveredToolOptions,
    ToolActivation,
    ToolGroup,
    ToolMetadata,
    ToolOrigin,
    ToolRegistration
} from './tool-metadata';

// The entry extension. Part of the contract: a folder tool entry MUST end in
// `.tool.ts`; other `.ts` helpers beside it are ordinary captured dependencies.
export const TOOL_ENTRY_EXTENSION = '.tool.ts';

// Wire-name alphabet, identical to the registration gate in core/tool-source.ts.
const WIRE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const ACTIVATIONS: readonly ToolActivation[] = [
    'always',
    'creation',
    'subagents',
    'interaction',
    'forks',
    'threads',
    'websearch',
    'webfetch'
];

const GROUPS: readonly ToolGroup[] = ['runtime', 'preset', 'external'];

// ---------------------------------------------------------------------------
// Node runtime (guarded, bundler-invisible dynamic import)
// ---------------------------------------------------------------------------

// The slice of the TypeScript API this module uses. Typing it structurally keeps
// this module's declaration free of the compiler's own types, and the AST is
// inspected through SyntaxKind numbers rather than the per-node `is*` helpers so a
// future compiler version cannot silently drop one.
type TsNode = { kind: number; getStart: (source: unknown) => number };
type TsExpression = TsNode;
type TsSourceFile = TsNode & {
    statements: readonly TsNode[];
    getLineAndCharacterOfPosition: (position: number) => { line: number; character: number };
};

type TsSyntaxKind = {
    VariableStatement: number;
    VariableDeclaration: number;
    Identifier: number;
    ObjectLiteralExpression: number;
    PropertyAssignment: number;
    ArrayLiteralExpression: number;
    StringLiteral: number;
    NumericLiteral: number;
    NoSubstitutionTemplateLiteral: number;
    PrefixUnaryExpression: number;
    MinusToken: number;
    ParenthesizedExpression: number;
    AsExpression: number;
    SatisfiesExpression: number;
    TypeAssertionExpression: number;
    TrueKeyword: number;
    FalseKeyword: number;
    NullKeyword: number;
};

type ScanRuntime = {
    readdirSync: (
        path: string,
        options: { withFileTypes: true }
    ) => {
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
        isSymbolicLink: () => boolean;
    }[];
    readFileSync: (path: string, encoding: 'utf8') => string;
    existsSync: (path: string) => boolean;
    join: (...parts: string[]) => string;
    relative: (from: string, to: string) => string;
    dirname: (path: string) => string;
    fileURLToPath: (url: string | URL) => string;
    ts: {
        createSourceFile: (
            name: string,
            text: string,
            target: unknown,
            setParentNodes: boolean,
            kind: unknown
        ) => TsSourceFile;
        ScriptTarget: { Latest: unknown };
        ScriptKind: { TS: unknown };
        SyntaxKind: TsSyntaxKind;
    };
};

const NODE_RUNTIME =
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: unknown } }).versions?.node === 'string';

// INDIRECT dynamic import — deliberate, and load-bearing for the browser build.
//
// This module is reachable from the browser root (through `./tool-discovery`). A
// literal `import('node:fs')` / `import('typescript')` would make Rollup emit a
// browser chunk that imports them, which the browser build must not contain.
// Passing the specifier as a runtime string keeps it out of the static graph;
// `NODE_RUNTIME` guarantees it never executes where it could not resolve.
const loadRuntimeModule = async (specifier: string): Promise<Record<string, unknown>> =>
    (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;

let scanRuntime: ScanRuntime | undefined;
let scanRuntimeError: string | undefined;

if (NODE_RUNTIME) {
    try {
        const [fs, pathApi, urlApi, tsModule] = await Promise.all([
            loadRuntimeModule('node:fs'),
            loadRuntimeModule('node:path'),
            loadRuntimeModule('node:url'),
            loadRuntimeModule('typescript')
        ]);

        // TypeScript ships CommonJS; Node's ESM interop exposes the API on
        // `default` as well as named exports. Normalising here keeps the calls
        // direct, exactly like core/tool-source.ts does.
        const ts = ((tsModule as { default?: unknown }).default ?? tsModule) as ScanRuntime['ts'];

        scanRuntime = {
            readdirSync: fs.readdirSync as ScanRuntime['readdirSync'],
            readFileSync: fs.readFileSync as ScanRuntime['readFileSync'],
            existsSync: fs.existsSync as ScanRuntime['existsSync'],
            join: pathApi.join as ScanRuntime['join'],
            relative: pathApi.relative as ScanRuntime['relative'],
            dirname: pathApi.dirname as ScanRuntime['dirname'],
            fileURLToPath: urlApi.fileURLToPath as ScanRuntime['fileURLToPath'],
            ts
        };
    } catch (error) {
        // Keep the module importable so a host gets an actionable diagnostic from
        // the scan call rather than a module-evaluation crash.
        scanRuntimeError = error instanceof Error ? error.message : String(error);
    }
}

// Whether a real scan is possible in this process. `./tool-discovery` combines this
// with the compiler capability flag from `./tool-source`.
export const supportsToolScan = scanRuntime !== undefined;

const runtime = (): ScanRuntime => {
    if (scanRuntime !== undefined) return scanRuntime;

    throw new HarnessError(
        scanRuntimeError === undefined
            ? 'Tool discovery requires a Node runtime with node:fs, node:path, node:url, and TypeScript. This environment cannot scan tool source; use the generated manifest instead.'
            : `Tool discovery runtime is unavailable: ${scanRuntimeError}`
    );
};

// ---------------------------------------------------------------------------
// Literal extraction (never evaluation)
// ---------------------------------------------------------------------------

// The initializer name of a `const` declaration, if it is a simple identifier.
const declarationName = (node: TsNode): string | undefined => {
    const api = runtime();
    const record = node as unknown as { name?: TsNode };

    if (record.name === undefined || record.name.kind !== api.ts.SyntaxKind.Identifier) {
        return undefined;
    }

    return (record.name as unknown as { text: string }).text;
};

// Strip the type-level wrappers a source author may put around a literal. All of
// them are erased at transpile, so a reader must look through them to see the
// object the runtime would build.
const unwrapExpression = (node: TsExpression): TsExpression => {
    const kinds = runtime().ts.SyntaxKind;
    let current = node;

    for (let depth = 0; depth < 8; depth++) {
        if (
            current.kind === kinds.ParenthesizedExpression ||
            current.kind === kinds.AsExpression ||
            current.kind === kinds.SatisfiesExpression ||
            current.kind === kinds.TypeAssertionExpression
        ) {
            current = (current as unknown as { expression: TsExpression }).expression;
            continue;
        }

        return current;
    }

    return current;
};

const positionOf = (sourceFile: TsSourceFile, node: TsNode, label: string): string => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${label}:${position.line + 1}:${position.character + 1}`;
};

// Object keys a literal may use. Computed keys are rejected for the same reason
// expressions are: they are code, not data.
const propertyKey = (sourceFile: TsSourceFile, name: TsNode, label: string): string => {
    const kinds = runtime().ts.SyntaxKind;

    if (
        name.kind === kinds.Identifier ||
        name.kind === kinds.StringLiteral ||
        name.kind === kinds.NumericLiteral
    ) {
        return (name as unknown as { text: string }).text;
    }

    throw new HarnessError(
        `Tool entry ${positionOf(sourceFile, name, label)} uses a computed object key. Metadata must be a pure literal with static keys.`
    );
};

// Turn one literal expression into plain JSON-shaped data. Everything that is not
// a literal is REJECTED with the exact file position: a computed description or a
// spread would make the descriptor depend on code this module must not run, and
// silently skipping it would publish a half-true catalogue.
//
// SAME-FILE IDENTIFIERS ARE ALLOWED, AND ONLY SAME-FILE ONES (T19). Every runtime
// entry writes `name: TOOL_REQUEST_NAME` and every preset writes
// `name: 'fileRead'`; both must read the same way. An identifier is therefore
// resolved through `findTopLevelConst` in THIS file — the same bounded alias walk
// the `metadata`/`registration` exports use — and never through an import. A name
// that is not a top-level literal here is an error naming the alias, so the failure
// is "inline it" rather than a silently wrong descriptor.
const literalValue = (
    sourceFile: TsSourceFile,
    node: TsExpression,
    label: string,
    depth = 0,
    aliases: ReadonlySet<string> = new Set<string>()
): unknown => {
    const kinds = runtime().ts.SyntaxKind;
    const expression = unwrapExpression(node);

    if (depth > 16) {
        throw new HarnessError(
            `Tool entry ${positionOf(sourceFile, expression, label)} nests literals too deeply (more than 16 levels).`
        );
    }

    switch (expression.kind) {
        case kinds.StringLiteral:
        case kinds.NoSubstitutionTemplateLiteral:
            return (expression as unknown as { text: string }).text;
        case kinds.NumericLiteral:
            return Number((expression as unknown as { text: string }).text);
        case kinds.TrueKeyword:
            return true;
        case kinds.FalseKeyword:
            return false;
        case kinds.NullKeyword:
            return null;
        case kinds.Identifier: {
            const alias = (expression as unknown as { text: string }).text;

            if (aliases.has(alias)) {
                throw new HarnessError(
                    `Tool entry ${label} references \`${alias}\` cyclically. Metadata must resolve to plain literals.`
                );
            }

            const next = findTopLevelConst(sourceFile, alias, label);

            if (next === undefined) {
                throw new HarnessError(
                    `Tool entry ${positionOf(sourceFile, expression, label)} references \`${alias}\`, which is not a top-level literal in the same file. Discovery never imports another module to resolve metadata; inline the literal here.`
                );
            }

            return literalValue(sourceFile, next, label, depth + 1, new Set([...aliases, alias]));
        }
        case kinds.ArrayLiteralExpression: {
            const elements = (expression as unknown as { elements: TsExpression[] }).elements;
            return elements.map((element) =>
                literalValue(sourceFile, element, label, depth + 1, aliases)
            );
        }
        case kinds.ObjectLiteralExpression: {
            const properties = (expression as unknown as { properties: TsNode[] }).properties;
            const record: Record<string, unknown> = {};

            for (const property of properties) {
                if (property.kind !== kinds.PropertyAssignment) {
                    throw new HarnessError(
                        `Tool entry ${positionOf(sourceFile, property, label)} uses a non-literal object member (shorthand, method, spread, or accessor). Metadata must be a pure literal with explicit \`key: value\` pairs.`
                    );
                }

                const assignment = property as unknown as {
                    name: TsNode;
                    initializer: TsExpression;
                };
                const key = propertyKey(sourceFile, assignment.name, label);
                record[key] = literalValue(
                    sourceFile,
                    assignment.initializer,
                    label,
                    depth + 1,
                    aliases
                );
            }

            return record;
        }
        case kinds.PrefixUnaryExpression: {
            const unary = expression as unknown as { operator: number; operand: TsExpression };

            // Only a negative number is representable as a literal; `!x`, `~x`
            // and `+x` would all be computation.
            if (unary.operator !== kinds.MinusToken) {
                throw new HarnessError(
                    `Tool entry ${positionOf(sourceFile, expression, label)} uses a unary operator that is not a numeric literal. Metadata must be a pure literal.`
                );
            }

            const operand = literalValue(sourceFile, unary.operand, label, depth + 1, aliases);

            if (typeof operand !== 'number') {
                throw new HarnessError(
                    `Tool entry ${positionOf(sourceFile, expression, label)} negates a non-number in metadata. Metadata must be a pure literal.`
                );
            }

            return -operand;
        }
        default:
            throw new HarnessError(
                `Tool entry ${positionOf(sourceFile, expression, label)} uses an expression that is not a literal (SyntaxKind ${expression.kind}). Metadata must be a pure literal: no calls, no template interpolation, no spreads, no identifiers other than a same-file literal alias.`
            );
    }
};

// Find one top-level `const <name> = <initializer>` in the file. Entries keep all
// of their declarations at module scope, so a top-level-only walk is exact.
const findTopLevelConst = (
    sourceFile: TsSourceFile,
    name: string,
    label: string
): TsExpression | undefined => {
    const kinds = runtime().ts.SyntaxKind;

    for (const statement of sourceFile.statements) {
        if (statement.kind !== kinds.VariableStatement) continue;

        const declarations = (statement as unknown as {
            declarationList: { declarations: TsNode[] };
        }).declarationList.declarations;

        for (const declaration of declarations) {
            if (declaration.kind !== kinds.VariableDeclaration) continue;
            if (declarationName(declaration) !== name) continue;

            const initializer = (declaration as unknown as { initializer?: TsExpression })
                .initializer;

            if (initializer === undefined) {
                throw new HarnessError(
                    `Tool entry ${label} declares \`${name}\` without an initializer; a metadata export must be a literal.`
                );
            }

            return initializer;
        }
    }

    return undefined;
};

// Resolve an exported literal, following same-file aliases
// (`export const metadata = FILE_READ_METADATA;`). Alias chains are bounded so a
// self-referential file fails with a diagnostic instead of hanging.
const exportedLiteral = (sourceFile: TsSourceFile, exportName: string, label: string): unknown => {
    const kinds = runtime().ts.SyntaxKind;
    let initializer = findTopLevelConst(sourceFile, exportName, label);

    if (initializer === undefined) {
        throw new HarnessError(
            `Tool entry ${label} has no top-level \`export const ${exportName} = ...\` declaration. Every entry must export a literal \`metadata\`; a package entry must also export a literal \`registration\`.`
        );
    }

    const seen = new Set<string>([exportName]);

    for (let depth = 0; depth < 8; depth++) {
        const expression = unwrapExpression(initializer);

        if (expression.kind !== kinds.Identifier) {
            return literalValue(sourceFile, expression, label);
        }

        const alias = (expression as unknown as { text: string }).text;

        if (seen.has(alias)) {
            throw new HarnessError(
                `Tool entry ${label} aliases \`${exportName}\` back to itself (through \`${alias}\`). Metadata must resolve to one object literal.`
            );
        }

        seen.add(alias);

        const next = findTopLevelConst(sourceFile, alias, label);

        if (next === undefined) {
            throw new HarnessError(
                `Tool entry ${label} aliases \`${exportName}\` to \`${alias}\`, which is not a top-level literal in the same file. Discovery never imports another module to resolve metadata; inline the literal here.`
            );
        }

        initializer = next;
    }

    throw new HarnessError(
        `Tool entry ${label} resolves \`${exportName}\` through too many aliases (more than 8).`
    );
};

// Whether the file declares `registration` at all. A folder entry may omit it;
// distinguishing "absent" from "empty" keeps the documented fallback honest.
const declaresRegistration = (sourceFile: TsSourceFile): boolean => {
    const kinds = runtime().ts.SyntaxKind;

    for (const statement of sourceFile.statements) {
        if (statement.kind !== kinds.VariableStatement) continue;

        const declarations = (statement as unknown as {
            declarationList: { declarations: TsNode[] };
        }).declarationList.declarations;

        for (const declaration of declarations) {
            if (declaration.kind !== kinds.VariableDeclaration) continue;
            if (declarationName(declaration) === 'registration') return true;
        }
    }

    return false;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Validate the extracted `metadata` literal. The bounds mirror the registration
// contract in core/tool-source.ts so discovery cannot publish a descriptor the
// kernel would reject at registration time.
const readMetadata = (value: unknown, label: string): ToolMetadata => {
    if (!isRecord(value)) {
        throw new HarnessError(
            `Tool entry ${label} exports \`metadata\` that is not an object literal.`
        );
    }

    const name = value.name;

    if (typeof name !== 'string' || !WIRE_NAME_PATTERN.test(name)) {
        throw new HarnessError(
            `Tool entry ${label} metadata.name must be a wire name (one letter, then letters/digits/_/-, at most 64 characters); received ${JSON.stringify(name)}.`
        );
    }

    const description = value.description;

    if (typeof description !== 'string' || description.trim().length === 0) {
        throw new HarnessError(
            `Tool entry ${label} metadata.description must be a non-empty string.`
        );
    }

    const tags = value.tags;

    if (!Array.isArray(tags) || tags.length === 0 || tags.some((tag) => typeof tag !== 'string')) {
        throw new HarnessError(`Tool entry ${label} metadata.tags must be a non-empty string array.`);
    }

    const parameters = value.parameters;

    if (!isRecord(parameters)) {
        throw new HarnessError(`Tool entry ${label} metadata.parameters must be an object literal.`);
    }

    const visibility = value.visibility;

    if (visibility !== undefined && visibility !== 'core' && visibility !== 'searchable') {
        throw new HarnessError(
            `Tool entry ${label} metadata.visibility must be "core" or "searchable"; received ${JSON.stringify(visibility)}.`
        );
    }

    return {
        name,
        description,
        tags: tags as string[],
        parameters: parameters as Record<string, unknown>,
        ...(visibility === undefined ? {} : { visibility })
    };
};

// Validate the extracted `registration` literal. Package entries MUST declare it;
// a host folder entry may omit it and inherits the documented defaults.
const readRegistration = (
    value: unknown,
    label: string,
    fallback: ToolRegistration
): ToolRegistration => {
    if (value === undefined) return fallback;

    if (!isRecord(value)) {
        throw new HarnessError(
            `Tool entry ${label} exports \`registration\` that is not an object literal.`
        );
    }

    const group = value.group ?? fallback.group;

    if (!GROUPS.includes(group as ToolGroup)) {
        throw new HarnessError(
            `Tool entry ${label} registration.group must be one of ${GROUPS.join(', ')}; received ${JSON.stringify(group)}.`
        );
    }

    const activation = value.activation ?? fallback.activation;

    if (!ACTIVATIONS.includes(activation as ToolActivation)) {
        throw new HarnessError(
            `Tool entry ${label} registration.activation must be one of ${ACTIVATIONS.join(', ')}; received ${JSON.stringify(activation)}.`
        );
    }

    const order = value.order ?? fallback.order;

    if (typeof order !== 'number' || !Number.isFinite(order)) {
        throw new HarnessError(
            `Tool entry ${label} registration.order must be a finite number; received ${JSON.stringify(order)}.`
        );
    }

    const control = value.control;

    if (control !== undefined && control !== 'cancel' && control !== 'fork' && control !== 'action') {
        throw new HarnessError(
            `Tool entry ${label} registration.control must be "cancel", "fork", or "action"; received ${JSON.stringify(control)}.`
        );
    }

    // Optional booleans: absent stays absent so a consumer can distinguish "not
    // applicable" from an explicit false.
    const flag = (key: string): boolean | undefined => {
        const candidate = value[key];
        if (candidate === undefined) return undefined;
        if (typeof candidate !== 'boolean') {
            throw new HarnessError(
                `Tool entry ${label} registration.${key} must be a boolean; received ${JSON.stringify(candidate)}.`
            );
        }
        return candidate;
    };

    const registration: ToolRegistration = {
        group: group as ToolGroup,
        activation: activation as ToolActivation,
        order
    };

    const pendingOnly = flag('pendingOnly');
    if (pendingOnly !== undefined) registration.pendingOnly = pendingOnly;
    if (control !== undefined) registration.control = control as ToolRegistration['control'];
    const primaryOnly = flag('primaryOnly');
    if (primaryOnly !== undefined) registration.primaryOnly = primaryOnly;
    const answerExtraction = flag('answerExtraction');
    if (answerExtraction !== undefined) registration.answerExtraction = answerExtraction;
    const sessionBound = flag('sessionBound');
    if (sessionBound !== undefined) registration.sessionBound = sessionBound;
    const listed = flag('listed');
    if (listed !== undefined) registration.listed = listed;
    const alwaysDeclared = flag('alwaysDeclared');
    if (alwaysDeclared !== undefined) registration.alwaysDeclared = alwaysDeclared;

    return registration;
};

// ---------------------------------------------------------------------------
// Package tools root
// ---------------------------------------------------------------------------

// Walk up from this module to the owning package, then prefer the editable
// `src/tools` tree (development and the published `src` payload) and fall back to
// `tool-sources/tools` (a deployed copy). Same convention as core/tool-source.ts.
const packageToolsRoot = (): string => {
    const api = runtime();
    let directory = api.dirname(api.fileURLToPath(import.meta.url));

    for (let depth = 0; depth < 8; depth++) {
        const manifest = api.join(directory, 'package.json');

        if (api.existsSync(manifest)) {
            let packageName: string | undefined;

            try {
                packageName = (JSON.parse(api.readFileSync(manifest, 'utf8')) as { name?: string })
                    .name;
            } catch {
                // A malformed manifest is not this reader's concern; keep walking.
                packageName = undefined;
            }

            if (packageName === '@underload/harness') {
                for (const candidate of [
                    api.join(directory, 'src', 'tools'),
                    api.join(directory, 'tool-sources', 'tools')
                ]) {
                    if (api.existsSync(candidate)) return candidate;
                }

                throw new HarnessError(
                    `Tool discovery could not find a tools root beside ${api.join(directory, 'package.json').replace(/\\/g, '/')}: expected src/tools or tool-sources/tools.`
                );
            }
        }

        const parent = api.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }

    throw new HarnessError(
        'Tool discovery could not locate the @underload/harness package root. Construct the harness on Node with the package source tree installed, or use the generated manifest.'
    );
};

// Recursively collect `*.tool.ts` entries, sorted byte-wise by relative POSIX
// path. Symlinks are skipped for the same reason core/tool-source.ts skips them:
// discovery order must not depend on an external link.
const collectEntries = (root: string): { absolute: string; relative: string }[] => {
    const api = runtime();
    const found: { absolute: string; relative: string }[] = [];

    const walk = (directory: string): void => {
        const entries = api.readdirSync(directory, { withFileTypes: true });
        entries.sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        );

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;

            const absolute = api.join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith(TOOL_ENTRY_EXTENSION)) {
                found.push({
                    absolute,
                    relative: api.relative(root, absolute).replace(/\\/g, '/')
                });
            }
        }
    };

    walk(root);
    found.sort((left, right) =>
        left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
    );

    return found;
};

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

// Read one entry file. Pure text + AST: no import, no evaluation, no side effect.
//
// `sourcePath` is the package-relative label for a package entry and the absolute
// POSIX path for a folder entry; `origin` says which. `requireRegistration` is true
// for package entries (their order/policy is part of the shipped contract).
const readEntry = (
    absolutePath: string,
    label: string,
    sourcePath: string,
    origin: ToolOrigin,
    fallback: ToolRegistration,
    requireRegistration: boolean
): DiscoveredTool => {
    const api = runtime();
    const text = api.readFileSync(absolutePath, 'utf8');
    const sourceFile = api.ts.createSourceFile(
        label,
        text,
        api.ts.ScriptTarget.Latest,
        true,
        api.ts.ScriptKind.TS
    );

    const metadata = readMetadata(exportedLiteral(sourceFile, 'metadata', label), label);

    if (requireRegistration && !declaresRegistration(sourceFile)) {
        throw new HarnessError(
            `Tool entry ${label} has no \`registration\` export. Every package entry must declare its group/activation/order as a literal.`
        );
    }

    const registration = readRegistration(
        declaresRegistration(sourceFile)
            ? exportedLiteral(sourceFile, 'registration', label)
            : undefined,
        label,
        fallback
    );

    return {
        name: metadata.name,
        metadata,
        sourcePath,
        label,
        origin,
        group: registration.group,
        activation: registration.activation,
        order: registration.order,
        ...(registration.pendingOnly === undefined ? {} : { pendingOnly: registration.pendingOnly }),
        ...(registration.control === undefined ? {} : { control: registration.control }),
        ...(registration.primaryOnly === undefined ? {} : { primaryOnly: registration.primaryOnly }),
        ...(registration.answerExtraction === undefined
            ? {}
            : { answerExtraction: registration.answerExtraction }),
        ...(registration.sessionBound === undefined
            ? {}
            : { sessionBound: registration.sessionBound }),
        ...(registration.listed === undefined ? {} : { listed: registration.listed }),
        ...(registration.alwaysDeclared === undefined
            ? {}
            : { alwaysDeclared: registration.alwaysDeclared })
    };
};

// Folder entries inherit this policy when they do not declare one: always
// registered, ordered after every package entry so package rows keep their
// historical positions.
const FOLDER_REGISTRATION: ToolRegistration = {
    group: 'external',
    activation: 'always',
    order: 10_000
};

// Folder scanning is INJECTED (see the header): `./tool-source` owns the fence and
// the deterministic order, and this module must not depend on it.
export type ToolFolderScan = {
    // Canonical folder roots, in configuration order.
    roots: readonly string[];
    // Every `*.tool.ts` file under those roots, in registration order.
    sources: readonly string[];
};

// Scan every package entry (and, when supplied, every folder entry).
//
// ORDER (R8): package entries first, then folder entries — always. Within each
// origin, `registration.order` ascending, then `label` byte-wise, so two
// installations with the same sources produce byte-identical descriptor lists.
//
// Why origin outranks `order`: the harness registers in the order this list
// returns and last-registration-wins, so a configured folder MUST come after every
// package entry to win a name collision. A folder entry that declares a small
// `order` therefore only reorders it against OTHER folder entries; it can never
// jump ahead of a package tool. `order` is scoped to its origin.
const originRank = (origin: ToolOrigin): number => (origin === 'package' ? 0 : 1);

export const scanToolMetadata = (
    options: DiscoveredToolOptions,
    folders?: ToolFolderScan
): DiscoveredTool[] => {
    const includePresets = options.includePresets ?? true;
    const api = runtime();
    const root = packageToolsRoot();
    const descriptors: DiscoveredTool[] = [];

    for (const entry of collectEntries(root)) {
        const label = `tools/${entry.relative}`;
        const descriptor = readEntry(
            entry.absolute,
            label,
            label,
            'package',
            FOLDER_REGISTRATION,
            true
        );

        if (descriptor.group === 'external') {
            throw new HarnessError(
                `Tool entry ${label} declares registration.group "external"; a package entry must be "runtime" or "preset".`
            );
        }

        if (!includePresets && descriptor.group === 'preset') continue;

        descriptors.push(descriptor);
    }

    // Configured folders come AFTER the package entries, in configuration order,
    // so a later folder wins a name collision exactly like startup registration.
    if (folders !== undefined) {
        for (let index = 0; index < folders.sources.length; index++) {
            const absolute = folders.sources[index];
            const owner = folders.roots.find((candidate) => {
                const relative = api.relative(candidate, absolute);
                return relative.length > 0 && !relative.startsWith('..');
            });
            const label =
                owner === undefined
                    ? absolute.replace(/\\/g, '/')
                    : api.relative(owner, absolute).replace(/\\/g, '/');

            descriptors.push(
                readEntry(
                    absolute,
                    label,
                    absolute.replace(/\\/g, '/'),
                    'folder',
                    { ...FOLDER_REGISTRATION, order: FOLDER_REGISTRATION.order + index },
                    false
                )
            );
        }
    }

    descriptors.sort((left, right) => {
        const rank = originRank(left.origin) - originRank(right.origin);
        if (rank !== 0) return rank;
        if (left.order !== right.order) return left.order - right.order;
        return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
    });

    return descriptors;
};

export type {
    DiscoveredTool,
    DiscoveredToolOptions,
    ToolActivation,
    ToolGroup,
    ToolMetadata,
    ToolOrigin,
    ToolRegistration
} from './tool-metadata';
