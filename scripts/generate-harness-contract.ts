// Generates the shared TypeScript contract (REST DTOs + WebSocket frames) straight from
// src/server/harness.swagger.yaml, so the client/server vocabulary can never drift from the
// canonical spec. The spec is the single source of truth; this file is the projector.
//
// Cross-references:
//   - src/server/harness.swagger.yaml        - target contract (48 paths / 68 ops / 193 component schemas)
//   - src/shared/harness-api.ts              - OUTPUT: resource + request/response DTO types, route table, constants
//   - src/shared/harness-stream.ts           - OUTPUT: WebSocket frame unions + stream constants
//   - scripts/generate-tool-manifest.ts     - same shape of tool (vite-node, `--check` for CI)
//
// Run:   yarn vite-node --script scripts/generate-harness-contract.ts
// Check: yarn vite-node --script scripts/generate-harness-contract.ts --check  (exit 1 if stale)
//
// Split rule (stable, so parallel owners can predict where a type lands):
//   - schema name starts with `Ws`, or the name is in STREAM_EXTRA -> harness-stream.ts
//   - everything else                                              -> harness-api.ts
// Names that are verbatim re-exports of an existing in-repo camelCase model (projector /
// domain types) are listed in ALIASES below; they are emitted as `import type` re-exports
// instead of duplicates, and each alias is guarded by the assignability probe in
// src/shared/harness-api.test.ts so a future spec edit that changes the shape fails loudly.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');
const SPEC_PATH = join(PKG_ROOT, 'src', 'server', 'harness.swagger.yaml');
const API_OUT = join(PKG_ROOT, 'src', 'shared', 'harness-api.ts');
const STREAM_OUT = join(PKG_ROOT, 'src', 'shared', 'harness-stream.ts');

// Schemas that must live in the stream file even though their name has no `Ws` prefix,
// because they are stream vocabulary (kinds/ops) rather than REST resources.
const STREAM_EXTRA = new Set(['StreamResourceKind', 'TurnDisplayOp', 'HarnessEventType']);

// specName -> { from: '<relative module>', as: 'ExportedName' }
// Verified structurally identical (mutual assignability, probed with tsc before committing) to
// an existing in-repo model, so the model stays the single definition and the contract file only
// re-exports it. Guarded by the assignability probe in src/shared/harness-api.test.ts.
// Deliberately NOT aliased to src/server/protocol.ts (SessionStatus, SessionTurnStatus,
// ToolAvailability, and every legacy `Session*` wire type): `shared/` must not type-depend on
// `server/`, so those three tiny unions are generated standalone here instead.
const ALIASES = {
    // Display projection models (src/shared/turn-display.ts) - identical shapes.
    DisplayState: { from: './turn-display', as: 'TurnDisplayState' },
    SectionDisplayState: { from: './turn-display', as: 'SectionDisplayState' },
    StepDisplayState: { from: './turn-display', as: 'StepDisplayState' },
    DisplayBlockSummary: { from: './turn-display', as: 'DisplayBlockSummary' },
    DisplayAttachmentSummary: { from: './turn-display', as: 'DisplayAttachmentSummary' },
    DisplayTail: { from: './turn-display', as: 'DisplayTail' },
    // Domain models (src/types/index.ts) - the verbatim records the stream and REST both ship.
    HarnessMessage: { from: '../types', as: 'HarnessMessage' },
    HarnessUsage: { from: '../types', as: 'HarnessUsage' },
    HarnessToolCall: { from: '../types', as: 'HarnessToolCall' },
    HarnessPendingTool: { from: '../types', as: 'HarnessPendingTool' },
    HarnessThread: { from: '../types', as: 'HarnessThread' },
    HarnessAttachment: { from: '../types', as: 'HarnessAttachment' },
    HarnessActionRequest: { from: '../types', as: 'HarnessActionRequest' },
    HarnessActionOption: { from: '../types', as: 'HarnessActionOption' },
    HarnessErrorInfo: { from: '../types', as: 'HarnessErrorInfo' },
    ToolMediaDescriptor: { from: '../types', as: 'ToolMediaDescriptor' },
    // Subagent result reference (src/shared/agent-results.ts).
    AgentResultReference: { from: './agent-results', as: 'AgentResultReference' },
};

// Schemas whose spec shape is NOT the existing in-repo shape: the target type is generated
// standalone here, and the projector owner decides later how to produce it. Emitted as a
// comment block so the delta is visible without reading the generator.
const PROJECTION_DELTAS = [
    'DisplayNode / DisplayStep / ContextBlock / TurnSection / TurnDisplay / TurnSummary /',
    'TurnBlockDetail / TurnStepDetail / DisplaySteerSummary: the spec models each of these as ONE',
    'closed record whose kind-specific fields are optional, while src/shared/turn-display.ts emits a',
    'discriminated union of narrower member types. A projector member therefore satisfies the wire',
    'record, but the wire record does not narrow back to the member. Read the spec shape as the wire',
    'contract and keep the projector union as the internal render model.',
    'ModelIndex: spec adds discovery metadata the legacy `protocol.ts` model does not carry.',
];

// One OpenAPI/WSDL schema node as the YAML parser returns it. The projector reads a
// moving set of keywords (`$ref`, `type`, `oneOf`, `discriminator`, `additionalProperties`,
// per-property `description`, ...), and the spec is data rather than a checked module, so
// the node is modelled as an open `any`-valued record: keyword lookups stay terse, and the
// generated FILE is the artifact the tests verify byte-for-byte.
type SchemaNode = Record<string, any>;

// `ALIASES` is keyed by spec schema name, so a plain string lookup needs the cast; a name
// that is not aliased simply resolves to `undefined`.
const aliasOf = (name: string): { from: string; as: string } | undefined =>
    ALIASES[name as keyof typeof ALIASES];

const aliasLocal = (name: string): string => `${(aliasOf(name) as { as: string }).as}Model`;

// Types whose spec description is replaced by a short note in the output header (none today).
const INDENT = '    ';

/* ---------------------------------------------------------------------------
 * Load the spec
 * ------------------------------------------------------------------------- */

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: { schemas?: Record<string, SchemaNode>; parameters?: Record<string, any> };
    paths?: Record<string, any>;
};
const schemas: Record<string, SchemaNode> = spec.components?.schemas ?? {};
const schemaNames = Object.keys(schemas);

/** True when a schema belongs in harness-stream.ts. */
const isStreamSchema = (name: string): boolean => name.startsWith('Ws') || STREAM_EXTRA.has(name);

// Every alias must point at a schema that actually exists, and its binding must not shadow one.
for (const [specName, alias] of Object.entries(ALIASES)) {
    if (!schemaNames.includes(specName)) {
        throw new Error(`alias target is not a spec schema: ${specName}`);
    }
    if (schemaNames.includes(`${alias.as}Model`)) {
        throw new Error(`alias binding collides with a schema name: ${alias.as}Model (${specName})`);
    }
}

/** Resolve `#/components/schemas/Foo` to `Foo`. */
const refName = (ref: string): string => ref.split('/').pop() ?? '';

/* ---------------------------------------------------------------------------
 * Type emitter
 * ------------------------------------------------------------------------- */

/**
 * True when a schema node contributes a TYPE of its own: a ref, a declared scalar/array/object
 * type, an enum, an inline field map, `additionalProperties`, array `items`, or a nested
 * composite. A member that carries ONLY validation keywords — `required` above all, which is how
 * OpenAPI spells "at least ONE of these fields must be present" — contributes a CONSTRAINT and no
 * type, so `baseType` can only answer `unknown` for it. Telling the two apart is what keeps a
 * body shaped like `PatchTurnBlockRequest` (src/server/harness.swagger.yaml:8415-8440: an `anyOf`
 * pair whose members carry nothing but `required`, sitting beside the real `properties:` map) from
 * collapsing to `unknown | unknown` and silently dropping every field of the request.
 */
function carriesType(node: SchemaNode | undefined): boolean {
    if (!node) return false;
    return Boolean(
        node.$ref ??
            node.type ??
            node.enum ??
            node.properties ??
            node.additionalProperties ??
            node.items ??
            node.allOf ??
            node.oneOf ??
            node.anyOf,
    );
}

/** Collects every schema name referenced while emitting one definition. */
class Emitter {
    /** Emitted type per top-level schema: name -> Set<referenced schema names>. */
    refs: Map<string, Set<string>>;
    /** Reference set of the schema currently being emitted (`null` between emissions). */
    current: Set<string> | null;

    constructor() {
        this.refs = new Map(); // name -> Set<referenced schema names>
        this.current = null;
    }

    begin(name: string): void {
        this.current = new Set();
        this.refs.set(name, this.current);
    }

    use(name: string): void {
        this.current?.add(name);
    }

    /** Render a schema node as a TS type expression. `depth` drives indentation. */
    type(node: SchemaNode | undefined, depth = 0): string {
        if (!node) return 'unknown';
        if (node.$ref) {
            const name = refName(node.$ref);
            this.use(name);
            return name;
        }

        // oneOf / anyOf -> discriminated (or plain) union. TS narrows on the literal tag
        // field the spec marks as `discriminator`, so no runtime helper is needed.
        const variants = node.oneOf ?? node.anyOf;
        if (variants) {
            // Only members that carry a type join the union. A `required`-only member states a
            // rule over the SIBLING `properties` map instead, so letting it in as `unknown` would
            // absorb the whole schema (`unknown | X` is `unknown` to TS).
            const typed = variants.filter(carriesType).map((v: SchemaNode) => this.type(v, depth).replace(/\s+/g, ' '));
            // Sibling `properties` fold into the result the way the `allOf` branch below already
            // folds them; ignoring them is what dropped the fields of `PatchTurnBlockRequest`.
            const extra = node.properties || node.required ? this.objectBody(node, depth + 1) : null;

            // A union of nothing but constraints beside a field map: the field map IS the type,
            // and the "at least one of these" rule stays normative prose in the schema
            // description the declaration's JSDoc already carries verbatim.
            if (!typed.length) return extra ?? 'unknown';
            if (!extra) return typed.join(' | ');

            // Typed members PLUS sibling fields: intersect, parenthesising the union so `&`
            // binds to the whole union and not to its last member only.
            const union = typed.length === 1 && !typed[0].includes('|') ? typed[0] : `(${typed.join(' | ')})`;
            return `${union}\n    & ${extra}`;
        }

        // allOf -> intersection; a single ref collapses to that ref.
        if (node.allOf) {
            const inner = node.allOf.map((v: SchemaNode) => this.type(v, depth));
            const extra = node.properties || node.required ? this.objectBody(node, depth + 1) : null;
            const list = extra ? [...inner, extra] : inner;
            return list.length === 1 ? list[0] : list.join('\n    & ');
        }

        const base = this.baseType(node, depth);
        if (node.nullable === true) return `${base} | null`;
        return base;
    }

    /** Scalars, enums, arrays, and inline objects. */
    baseType(node: SchemaNode, depth: number): string {
        if (node.enum) return node.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');

        switch (node.type) {
            case 'string':
                return 'string';
            case 'integer':
            case 'number':
                return 'number';
            case 'boolean':
                return 'boolean';
            case 'null':
                return 'null';
            case 'array': {
                const item = node.items ? this.type(node.items, depth) : 'unknown';
                // Union element types get parenthesised (and flattened) so `|` cannot bind
                // wrongly; inline object elements stay multi-line as written.
                if (item.includes(' | ')) return `(${item.replace(/\s*\n\s*/g, ' ')})[]`;
                return `${item}[]`;
            }
            case 'object':
            default:
                if (node.properties || node.additionalProperties || node.type === 'object') {
                    return this.objectBody(node, depth);
                }
                return node.$ref ? this.type(node) : 'unknown';
        }
    }

    /** Inline object literal type honouring `required` and `additionalProperties`. */
    objectBody(node: SchemaNode, depth: number): string {
        const pad = INDENT.repeat(depth);
        const inner = INDENT.repeat(depth + 1);
        const props: Record<string, SchemaNode> = node.properties ?? {};
        const required = new Set<string>(node.required ?? []);
        const lines: string[] = [];

        for (const [key, schema] of Object.entries(props)) {
            // Per-property `description` is normative spec prose too, so it renders here as an
            // indented JSDoc block instead of being dropped (the shipped contract carries that
            // prose, e.g. `TurnBlockWriteReceipt.included` at src/server/harness.swagger.yaml:8458).
            const doc = jsdoc(schema?.description, undefined, inner);
            // A property whose schema is a bare ref/inline object is rendered inline; long
            // expressions are broken onto their own line for readability.
            const rendered = this.type(schema, depth + 1).split('\n');
            const optional = required.has(key) ? '' : '?';
            if (rendered.length === 1) {
                lines.push(`${doc}${inner}${key}${optional}: ${rendered[0]};`);
            } else {
                const head = `${inner}${key}${optional}:`;
                const body = rendered.map((l) => l.trim()).join(`\n${inner}  `);
                lines.push(`${doc}${head} ${body};`);
            }
        }

        // `additionalProperties: false` is the contract default (closed objects). The only
        // thing TS can express is the open case, so record it as an index signature.
        const open = node.additionalProperties;
        if (open && typeof open === 'object') {
            lines.push(`${inner}[key: string]: ${this.type(open, depth + 1)};`);
        } else if (open === true) {
            lines.push(`${inner}[key: string]: unknown;`);
        }

        if (!lines.length) return 'Record<string, never>';
        return `{\n${lines.join('\n')}\n${pad}}`;
    }
}

/* ---------------------------------------------------------------------------
 * File writers
 * ------------------------------------------------------------------------- */

/**
 * JSDoc block carrying the spec description verbatim (it is the normative prose).
 * `indent` places the block at a property's own column (schema-level blocks pass the default
 * `''`). The hard-wrap budget is measured on the block's TEXT lines and shrinks by the indent, so
 * a property block at indent 4 renders to the same right edge (3 columns of `/**` + ` * ` gutter)
 * as a schema-level block does today - which keeps every existing schema-level block byte-identical.
 */
function jsdoc(description?: unknown, closedNote?: string, indent = ''): string {
    const text = String(description ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const lines: string[] = [];
    const width = 110 - indent.length;
    if (text) {
        // Hard-wrap so the generated file stays readable in a diff.
        const words = text.split(' ');
        let line = '';
        for (const w of words) {
            if (line.length + w.length + 1 > width) {
                lines.push(line.trimEnd());
                line = '';
            }
            line += `${w} `;
        }
        if (line.trim()) lines.push(line.trimEnd());
    }
    if (closedNote) lines.push(closedNote);
    if (!lines.length) return '';
    if (lines.length === 1) return `${indent}/** ${lines[0].replace(/\*\//g, '*\\/')} */\n`;
    return `${indent}/**\n${lines
        .map((l) => `${indent} * ${l}`.replace(/\*\//g, '*\\/'))
        .join('\n')}\n${indent} */\n`;
}

const emitter = new Emitter();

/** Emit one top-level schema (looked up by name) as a declaration string. */
function emitSchema(name: string): string {
    return emitDeclaration(name, schemas[name]);
}

/**
 * Render one schema NODE as a declaration string. The node is a parameter (not read out of
 * `schemas`) so a fixture test can drive the same rules the shipped spec goes through without
 * touching the real spec or the real output files.
 */
function emitDeclaration(name: string, node: SchemaNode): string {
    const alias = aliasOf(name);
    if (alias) {
        // The imported binding is namespaced with a `Model` suffix so it can never collide with
        // another schema name; the exported name stays the spec's.
        return `${jsdoc(`Verbatim alias of the in-repo model \`${alias.as}\` from ${alias.from}; shape equivalence is probed in src/shared/harness-api.test.ts.`, 'Not a duplicate: the model stays the single definition of this shape.')}export type ${name} = ${aliasLocal(name)};\n`;
    }

    emitter.begin(name);

    // Interfaces read better than aliases for the resource shapes; unions/intersections and
    // scalars must be type aliases. A union whose members ALL carry only constraints (a `required`
    // pair beside the real field map) adds no type, so the schema is still an object shape and
    // stays an interface: that is the `PatchTurnBlockRequest` shape
    // (src/server/harness.swagger.yaml:8415-8440), and an interface carrying the field map is
    // exactly what `src/server/api.ts` reads its `body.<axis>` fields off (api.ts:4600-4662).
    const variants = node.oneOf ?? node.anyOf;
    const constraintOnlyUnion = Array.isArray(variants) && !variants.some(carriesType);
    const isPlainObject =
        !node.$ref && !node.allOf && (!variants || constraintOnlyUnion) && !!node.properties;
    const body = isPlainObject ? emitter.objectBody(node, 0) : emitter.type(node, 0);

    // Top-level unions read as a one-per-line list; nested ones stay inline. An INTERSECTION
    // body (`X\n    & Y`, which both the `allOf` branch and a typed union with sibling fields
    // return) must NOT be split on ` | `: its members are already parenthesised, and splitting
    // would push the `&` onto the last member only, silently re-associating `(A | B) & C` into
    // `A | (B & C)` - a type that reads fine and means something else.
    const isIntersection = body.includes('\n    & ');
    const isUnion = !isPlainObject && !isIntersection && body.includes(' | ');
    const finalBody = isUnion
        ? `\n${body.split(' | ').map((v) => `    | ${v}`).join('\n')}\n`
        : body;

    if (isPlainObject && node.additionalProperties === false) {
        const inner = body
            .split('\n')
            .slice(1, -1)
            .join('\n');
        return `${jsdoc(node.description, 'Closed object: the server sends no property outside this set (additionalProperties: false).')}export interface ${name} {\n${inner}\n}\n`;
    }
    if (isPlainObject) {
        const inner = body
            .split('\n')
            .slice(1, -1)
            .join('\n');
        return `${jsdoc(node.description)}export interface ${name} {\n${inner}\n}\n`;
    }
    return `${jsdoc(node.description)}export type ${name} = ${isUnion ? finalBody.trimEnd() : body};\n`;
}

/* ---------------------------------------------------------------------------
 * Constants + route table (sourced from the spec, never hand-typed)
 * ------------------------------------------------------------------------- */

const limitParam: Record<string, any> = spec.components?.parameters?.Limit?.schema ?? {};
const pageMin = limitParam.minimum ?? 1;
const pageDefault = limitParam.default ?? 25;
const pageMax = limitParam.maximum ?? 100;

// The boot document example is the one canonical set of contract numbers.
const infoExample =
    spec.paths?.['/v1/harness']?.get?.responses?.['200']?.content?.['application/json']?.example ??
    {};

/**
 * camelCase id for a path template. Static segments are joined; every `{param}` segment adds
 * `By<Param>` so `/harnesses` and `/harnesses/{harness_name}` never collide.
 */
function routeKey(path: string): string {
    const words: string[] = [];
    for (const segment of path.replace(/^\/v1\/harness\/?/, '').split('/')) {
        if (!segment) continue;
        const param = segment.match(/^\{([a-z_]+)\}$/)?.[1];
        if (param) {
            words.push(`By${toPascal(param)}`);
        } else {
            words.push(toPascal(segment));
        }
    }
    return words.length ? lowerFirst(words.join('')) : 'root';
}

function toPascal(snake: string): string {
    return snake
        .split(/[_-]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}

function lowerFirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
}

const pathIds = Object.keys(spec.paths ?? {});
// route id -> the path template that produced it, for the collision message.
const seenKeys = new Map<string, string>();
for (const p of pathIds) {
    const k = routeKey(p);
    if (seenKeys.has(k)) throw new Error(`route id collision: ${k} for ${p} and ${seenKeys.get(k)}`);
    seenKeys.set(k, p);
}

// `HARNESS_PATH_TEMPLATES`: id -> `{param}` template, for the router side.
const routeEntries = pathIds.map((path) => `    ${routeKey(path)}: '${path}',`);

// `HARNESS_ROUTES`: id -> builder taking the path params in order, for the client side.
const routeBuilders = pathIds.map((path) => {
    const params = [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    const args = params.map(toCamelArg);
    let body = path;
    params.forEach((p, i) => {
        body = body.replace(`{${p}}`, `\${${args[i]}}`);
    });
    const signature = `(${args.map((a) => `${a}: string`).join(', ')})`;
    // Compose from HARNESS_API_ROOT so the root is spelled in exactly one place.
    const literal = body.startsWith('/v1/harness')
        ? '\${HARNESS_API_ROOT}' + body.slice('/v1/harness'.length)
        : body;
    return `    /** \`${path}\` */\n    ${routeKey(path)}: ${signature} => \`${literal}\`,`;
});

function toCamelArg(snake: string): string {
    const parts = snake.split('_');
    return parts
        .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join('');
}

const limitsExampleEntries = Object.entries(infoExample.limits ?? {}).map(
    ([k, v]) => `    ${k}: ${v},`,
);
const capabilitiesExampleEntries = Object.entries(infoExample.capabilities ?? {}).map(
    ([k, v]) => `    ${k}: ${v},`,
);

// WsStreamLimits carries `default` per property, which is the contract value in force.
const streamLimitProperties: Record<string, SchemaNode> = schemas.WsStreamLimits?.properties ?? {};
const streamLimitsDefaults = Object.entries(streamLimitProperties)
    .filter(([, s]) => s.default !== undefined)
    .map(([k, s]) => `    ${k}: ${s.default},`);

const subprotocol =
    spec.paths?.['/v1/harness/stream']?.get?.['x-websocket']?.subprotocol ?? 'harness.v1';

/** Single-value enum literals for one schema, used to mint the closed keyword tables. */
function enumValues(name: string, field?: string): string[] {
    const node = schemas[name];
    if (!node) return [];
    const target = field ? node.properties?.[field] : node;
    return (target?.enum ?? []).map((v: unknown) => JSON.stringify(v));
}

/** The literal discriminator tags of every member of a Ws* union, deduped, in spec order. */
function unionTags(name: string, propOrder: string[] = ['type', 'kind']): string[] {
    const node: SchemaNode = schemas[name] ?? {};
    const disc =
        typeof node.discriminator === 'string'
            ? node.discriminator
            : node.discriminator?.propertyName;
    const order = disc ? [disc, ...propOrder.filter((p) => p !== disc)] : propOrder;

    // A `discriminator.mapping` is the authoritative tag list for that union.
    const mapping = typeof node.discriminator === 'object' ? node.discriminator.mapping : undefined;
    if (mapping && disc) return [...new Set(Object.keys(mapping).map((k) => JSON.stringify(k)))];

    const variants = node.oneOf ?? node.anyOf ?? [];
    const tags: string[] = [];
    for (const raw of variants) {
        const variant: SchemaNode | undefined = raw.$ref ? schemas[refName(raw.$ref)] : raw;
        if (!variant) continue;
        // Nested unions (e.g. WsServerMessage -> WsUpdate) carry their tags on their own
        // members, so recurse with the remaining tag names.
        if (variant.oneOf || variant.anyOf) {
            tags.push(...collectNested(variant, order));
            continue;
        }
        for (const prop of order) {
            const list = variant.properties?.[prop]?.enum;
            if (list?.length) {
                tags.push(...list.map((x: unknown) => JSON.stringify(x)));
                break;
            }
        }
    }
    return [...new Set(tags)];
}

/** Walks a nested union member and returns every discriminator tag it can produce. */
function collectNested(variant: SchemaNode, order: string[]): string[] {
    const out: string[] = [];
    for (const raw of variant.oneOf ?? variant.anyOf ?? []) {
        const member: SchemaNode | undefined = raw.$ref ? schemas[refName(raw.$ref)] : raw;
        if (!member) continue;
        for (const prop of order) {
            const list = member.properties?.[prop]?.enum;
            if (list?.length) {
                out.push(...list.map((x: unknown) => JSON.stringify(x)));
                break;
            }
        }
    }
    return out;
}

const wsClientTags = unionTags('WsClientMessage');
const wsServerTags = unionTags('WsServerMessage');
const wsUpdateTags = unionTags('WsUpdate');
const scopeValues = enumValues('WsSubscriptionScope');
const kindValues = enumValues('StreamResourceKind');
const protocolCodes = enumValues('WsProtocolError', 'code');

/* ---------------------------------------------------------------------------
 * Assemble both outputs
 * ------------------------------------------------------------------------- */

const GENERATED_NOTE = (outPath: string): string =>
    `// GENERATED by scripts/generate-harness-contract.ts from src/server/harness.swagger.yaml.\n` +
    `// Do not edit by hand: regenerate with \`yarn vite-node --script scripts/generate-harness-contract.ts\`.\n` +
    `// CI guard: \`yarn vite-node --script scripts/generate-harness-contract.ts --check\`.\n` +
    `//\n` +
    `// Contract role: the network vocabulary for the harness control plane, mounted at\n` +
    `// \${HARNESS_API_ROOT}. Every field spelling is copied from the spec verbatim: REST resources,\n` +
    `// receipts, and stream frames are snake_case, while the display subtree and the domain payloads\n` +
    `// (DisplayNode, TurnSection, TurnDisplay, TurnDisplayOp, ContextBlock, Harness*, ToolMedia*)\n` +
    `// keep the camelCase spelling the projector and domain already use, so neither side renames on\n` +
    `// the way out. All of it is shared verbatim by the server, frontend, and realtime owners.\n` +
    `// Internal domain models keep their own shapes (src/types, src/server/protocol.ts,\n` +
    `// src/shared/turn-display.ts); the projector maps between the two, and the entries marked\n` +
    `// "Verbatim alias" below ARE those models imported, not duplicated.\n` +
    `//\n` +
    `// EPOCH POLICY (shared by REST and the stream, from the spec's paging/stream sections):\n` +
    `// - one opaque server epoch string is minted per server process (boot) and is reported by\n` +
    `//   GET \${HARNESS_API_ROOT} (ServiceInfo.epoch), by health, on every response as\n` +
    `//   \${HARNESS_EPOCH_HEADER}, and in welcome/subscription_state frames;\n` +
    `// - resource and collection revisions restart at 1 for a fresh resource and are only ever\n` +
    `//   compared WITHIN one epoch - a client never compares revisions across epochs;\n` +
    `// - stream cursors are opaque base64url(epoch:sequence); a cursor from a previous epoch, or one\n` +
    `//   older than the replay window, is refused with resync_required(reason: epoch_mismatch or\n` +
    `//   cursor_expired) and the client restarts from REST reads - never from a snapshot boot.\n` +
    `//\n` +
    `// Output: ${outPath}\n`;

const apiHeader = `${GENERATED_NOTE('src/shared/harness-api.ts')}
/*
 * PROJECTION DELTAS (verified, not guesses):
${PROJECTION_DELTAS.map((l) => ` * ${l}`).join('\n')}
 */

/** The one API root. \`/api\` is gone: standalone and gateway-mounted deployments share this path. */
export const HARNESS_API_ROOT = '/v1/harness';

/** Negotiated WebSocket subprotocol advertised by \`GET \${HARNESS_API_ROOT}/stream\`. */
export const HARNESS_WS_SUBPROTOCOL = '${subprotocol}';

/** Response header carrying the server epoch (changes on every restart; invalidates cursors). */
export const HARNESS_EPOCH_HEADER = 'X-Harness-Epoch';

/** Response header carrying the resource revision a read landed at. */
export const HARNESS_REVISION_HEADER = 'X-Harness-Revision';

/** Paging bounds for every paginated route, from \`components.parameters.Limit\`. */
export const HARNESS_PAGE_LIMIT = { min: ${pageMin}, default: ${pageDefault}, max: ${pageMax} } as const;

/** Every path template in the contract, keyed by a generated route id. The router side mounts these. */
export const HARNESS_PATH_TEMPLATES = {
${routeEntries.join('\n')}
} as const;

/** Client-side builders for the same routes, one argument per path parameter, in path order. */
export const HARNESS_ROUTES = {
${routeBuilders.join('\n')}
} as const;

/** Contract limits published by \`GET \${HARNESS_API_ROOT}\` (spec example = the numbers in force). */
export const HARNESS_SERVICE_LIMITS = {
${limitsExampleEntries.join('\n')}
} satisfies ServiceLimits;

/** Capability advertisement shape the boot document promises. */
export const HARNESS_SERVICE_CAPABILITIES = {
${capabilitiesExampleEntries.join('\n')}
} satisfies ServiceCapabilities;
`;

const streamHeader = `${GENERATED_NOTE('src/shared/harness-stream.ts')}
/** The stream numbers in force, from \`WsStreamLimits.default\` (welcome frame carries these). */
export const HARNESS_WS_STREAM_LIMITS = {
${streamLimitsDefaults.join('\n')}
} satisfies WsStreamLimits;

/** Closed vocabulary of subscription scopes. */
export const HARNESS_WS_SCOPES = [${scopeValues.join(', ')}] as const satisfies readonly WsSubscriptionScope[];

/** Closed list of \`StreamResourceKind\` values (the revision-counter vocabulary), for baseline iteration. */
export const HARNESS_STREAM_RESOURCE_KINDS = [${kindValues.join(', ')}] as const satisfies readonly StreamResourceKind[];

/** Frame tags a client may send. */
export const HARNESS_WS_CLIENT_MESSAGE_TYPES = [${wsClientTags.join(', ')}] as const satisfies readonly WsClientMessage['type'][];

/** Frame tags a client must handle. */
export const HARNESS_WS_SERVER_MESSAGE_TYPES = [${wsServerTags.join(', ')}] as const satisfies readonly WsServerMessage['type'][];

/** Update kinds inside \`update\` frames (\`WsUpdate.kind\`, the second-level discriminator). */
export const HARNESS_WS_UPDATE_KINDS = [${wsUpdateTags.join(', ')}] as const satisfies readonly WsUpdate['kind'][];

/** Protocol error codes (\`WsProtocolError.code\`). */
export const HARNESS_WS_PROTOCOL_CODES = [${protocolCodes.join(', ')}] as const satisfies readonly WsProtocolError['code'][];

/**
 * Narrows an inbound JSON-parsed value to a client frame by its \`type\` tag. The stream union is
 * discriminated on \`type\`; this helper exists so owners never hand-roll a tag switch, and it keeps
 * \`unknown\` -> \`WsServerMessage\` in one auditable place.
 */
export function isHarnessServerFrame(value: unknown): value is WsServerMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { type?: unknown }).type === 'string' &&
        (HARNESS_WS_SERVER_MESSAGE_TYPES as readonly string[]).includes(
            (value as { type: string }).type,
        )
    );
}
`;

// `other` describes the SIBLING output file: the module to import from, and the schema
// names it owns (only those become cross-file imports).
function buildFile(
    names: string[],
    header: string,
    other: { module: string; owns: Set<string> },
): string {
    const blocks = names.map(emitSchema);

    // Model imports (aliases) are hoisted into one block at the top of the file.
    const byModule = new Map<string, string[]>();
    for (const n of names) {
        const alias = aliasOf(n);
        if (!alias) continue;
        if (!byModule.has(alias.from)) byModule.set(alias.from, []);
        byModule.get(alias.from)!.push(`${alias.as} as ${aliasLocal(n)}`);
    }
    const modelImports = [...byModule.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
            ([mod, bindings]) =>
                `import type {\n${bindings.map((b) => `    ${b},`).join('\n')}\n} from '${mod}';`,
        )
        .join('\n');

    // Only import names actually referenced from the sibling file (avoids unused imports).
    const used = new Set<string>();
    for (const n of names)
        for (const r of emitter.refs.get(n) ?? []) if (other.owns.has(r)) used.add(r);
    const importList = [...used].sort();
    const imports = importList.length
        ? `\nimport type {\n${importList.map((n) => `    ${n},`).join('\n')}\n} from '${other.module}';\n`
        : '';
    const modelBlock = modelImports
        ? `\n// In-repo models the contract reuses verbatim instead of duplicating.\n${modelImports}\n`
        : '';
    return `${header}${modelBlock}${imports}\n${blocks.join('\n')}`;
}

const apiNames = schemaNames.filter((n) => !isStreamSchema(n));
const streamNames = schemaNames.filter((n) => isStreamSchema(n));

const apiSet = new Set(apiNames);
const streamSet = new Set(streamNames);

const apiText = buildFile(apiNames, apiHeader, { module: './harness-stream', owns: streamSet });
const streamText = buildFile(streamNames, streamHeader, { module: './harness-api', owns: apiSet });

const targets = new Map([
    [API_OUT, apiText],
    [STREAM_OUT, streamText],
]);

/**
 * True when this module is the process entry. The generator reads the spec and builds both
 * outputs at import time (read-only), but the write/exit pass below must NOT run on import:
 * `scripts/generate-harness-contract.test.ts` imports the renderer to pin its rules, and a
 * stray write there would rewrite the shipped contract from a test run.
 */
const invokedDirectly = () => {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return fileURLToPath(import.meta.url) === resolve(entry);
    } catch {
        return false;
    }
};

/** The CLI pass: compare both outputs against disk, write when not checking, exit 1 when stale. */
function runCli() {
    const check = process.argv.includes('--check');
    const stale: string[] = [];
    for (const [path, text] of targets) {
        const next = text.endsWith('\n') ? text : `${text}\n`;
        let current = '';
        try {
            current = readFileSync(path, 'utf8');
        } catch {
            current = '';
        }
        if (current === next) continue;
        stale.push(relative(PKG_ROOT, path));
        if (!check) writeFileSync(path, next, 'utf8');
    }

    if (check) {
        if (stale.length) {
            console.error(
                `harness contract types are stale: ${stale.join(', ')} - run \`yarn vite-node --script scripts/generate-harness-contract.ts\``,
            );
            process.exit(1);
        }
        console.log('harness contract types are up to date');
    } else {
        console.log(
            `generated ${apiNames.length} REST types -> src/shared/harness-api.ts, ${streamNames.length} stream types -> src/shared/harness-stream.ts (${Object.keys(spec.paths ?? {}).length} paths)`,
        );
    }
}

if (invokedDirectly()) runCli();

export { Emitter, schemas as SPEC_SCHEMAS, carriesType, emitDeclaration, jsdoc };
