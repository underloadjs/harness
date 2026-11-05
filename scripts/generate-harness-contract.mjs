// Generates the shared TypeScript contract (REST DTOs + WebSocket frames) straight from
// src/server/harness.swagger.yaml, so the client/server vocabulary can never drift from the
// canonical spec. The spec is the single source of truth; this file is the projector.
//
// Cross-references:
//   - src/server/harness.swagger.yaml        - target contract (45 paths / 63 ops / 185 component schemas)
//   - src/shared/harness-api.ts              - OUTPUT: resource + request/response DTO types, route table, constants
//   - src/shared/harness-stream.ts           - OUTPUT: WebSocket frame unions + stream constants
//   - scripts/generate-tool-manifest.mjs     - same shape of tool (plain node, `--check` mode for CI)
//
// Run:   node scripts/generate-harness-contract.mjs
// Check: node scripts/generate-harness-contract.mjs --check   (exit 1 when output is stale)
//
// Split rule (stable, so parallel owners can predict where a type lands):
//   - schema name starts with `Ws`, or the name is in STREAM_EXTRA -> harness-stream.ts
//   - everything else                                              -> harness-api.ts
// Names that are verbatim re-exports of an existing in-repo camelCase model (projector /
// domain types) are listed in ALIASES below; they are emitted as `import type` re-exports
// instead of duplicates, and each alias is guarded by the assignability probe in
// src/shared/harness-api.test.ts so a future spec edit that changes the shape fails loudly.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

/** Local binding used for an aliased model import (never clashes with a schema name). */
const aliasLocal = (name) => `${ALIASES[name].as}Model`;

// Types whose spec description is replaced by a short note in the output header (none today).
const INDENT = '    ';

/* ---------------------------------------------------------------------------
 * Load the spec
 * ------------------------------------------------------------------------- */

const spec = parse(readFileSync(SPEC_PATH, 'utf8'));
const schemas = spec.components?.schemas ?? {};
const schemaNames = Object.keys(schemas);

/** True when a schema belongs in harness-stream.ts. */
const isStreamSchema = (name) => name.startsWith('Ws') || STREAM_EXTRA.has(name);

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
const refName = (ref) => ref.split('/').pop();

/* ---------------------------------------------------------------------------
 * Type emitter
 * ------------------------------------------------------------------------- */

/** Collects every schema name referenced while emitting one definition. */
class Emitter {
    constructor() {
        this.refs = new Map(); // name -> Set<referenced schema names>
        this.current = null;
    }

    begin(name) {
        this.current = new Set();
        this.refs.set(name, this.current);
    }

    use(name) {
        this.current?.add(name);
    }

    /** Render a schema node as a TS type expression. `depth` drives indentation. */
    type(node, depth = 0) {
        if (!node) return 'unknown';
        if (node.$ref) {
            const name = refName(node.$ref);
            this.use(name);
            return name;
        }

        // oneOf / anyOf -> discriminated (or plain) union. TS narrows on the literal tag
        // field the spec marks as `discriminator`, so no runtime helper is needed.
        const variants = node.oneOf ?? node.anyOf;
        if (variants) return variants.map((v) => this.type(v, depth).replace(/\s+/g, ' ')).join(' | ');

        // allOf -> intersection; a single ref collapses to that ref.
        if (node.allOf) {
            const inner = node.allOf.map((v) => this.type(v, depth));
            const extra = node.properties || node.required ? this.objectBody(node, depth + 1) : null;
            const list = extra ? [...inner, extra] : inner;
            return list.length === 1 ? list[0] : list.join('\n    & ');
        }

        const base = this.baseType(node, depth);
        if (node.nullable === true) return `${base} | null`;
        return base;
    }

    /** Scalars, enums, arrays, and inline objects. */
    baseType(node, depth) {
        if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');

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
    objectBody(node, depth) {
        const pad = INDENT.repeat(depth);
        const inner = INDENT.repeat(depth + 1);
        const props = node.properties ?? {};
        const required = new Set(node.required ?? []);
        const lines = [];

        for (const [key, schema] of Object.entries(props)) {
            // A property whose schema is a bare ref/inline object is rendered inline; long
            // expressions are broken onto their own line for readability.
            const rendered = this.type(schema, depth + 1).split('\n');
            const optional = required.has(key) ? '' : '?';
            if (rendered.length === 1) {
                lines.push(`${inner}${key}${optional}: ${rendered[0]};`);
            } else {
                const head = `${inner}${key}${optional}:`;
                const body = rendered.map((l) => l.trim()).join(`\n${inner}  `);
                lines.push(`${head} ${body};`);
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

/** JSDoc block carrying the spec description verbatim (it is the normative prose). */
function jsdoc(description, closedNote) {
    const text = String(description ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const lines = [];
    if (text) {
        // Hard-wrap so the generated file stays readable in a diff.
        const words = text.split(' ');
        let line = '';
        for (const w of words) {
            if (line.length + w.length + 1 > 110) {
                lines.push(line.trimEnd());
                line = '';
            }
            line += `${w} `;
        }
        if (line.trim()) lines.push(line.trimEnd());
    }
    if (closedNote) lines.push(closedNote);
    if (!lines.length) return '';
    if (lines.length === 1) return `/** ${lines[0].replace(/\*\//g, '*\\/')} */\n`;
    return `/**\n${lines.map((l) => ` * ${l}`.replace(/\*\//g, '*\\/')).join('\n')}\n */\n`;
}

const emitter = new Emitter();

/** Emit one top-level schema as a declaration string. */
function emitSchema(name) {
    const node = schemas[name];
    const alias = ALIASES[name];
    if (alias) {
        // The imported binding is namespaced with a `Model` suffix so it can never collide with
        // another schema name; the exported name stays the spec's.
        return `${jsdoc(`Verbatim alias of the in-repo model \`${alias.as}\` from ${alias.from}; shape equivalence is probed in src/shared/harness-api.test.ts.`, 'Not a duplicate: the model stays the single definition of this shape.')}export type ${name} = ${aliasLocal(name)};\n`;
    }

    emitter.begin(name);

    // Interfaces read better than aliases for the resource shapes; unions/intersections and
    // scalars must be type aliases.
    const isPlainObject =
        !node.$ref && !node.oneOf && !node.anyOf && !node.allOf && !!node.properties;
    const body = isPlainObject ? emitter.objectBody(node, 0) : emitter.type(node, 0);

    // Top-level unions read as a one-per-line list; nested ones stay inline.
    const isUnion = !isPlainObject && body.includes(' | ');
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

const limitParam = spec.components?.parameters?.Limit?.schema ?? {};
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
function routeKey(path) {
    const words = [];
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

function toPascal(snake) {
    return snake
        .split(/[_-]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}

function lowerFirst(value) {
    return value.charAt(0).toLowerCase() + value.slice(1);
}

const pathIds = Object.keys(spec.paths ?? {});
const seenKeys = new Map();
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

function toCamelArg(snake) {
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
const streamLimitsDefaults = Object.entries(schemas.WsStreamLimits?.properties ?? {})
    .filter(([, s]) => s.default !== undefined)
    .map(([k, s]) => `    ${k}: ${s.default},`);

const subprotocol =
    spec.paths?.['/v1/harness/stream']?.get?.['x-websocket']?.subprotocol ?? 'harness.v1';

/** Single-value enum literals for one schema, used to mint the closed keyword tables. */
function enumValues(name, field) {
    const node = schemas[name];
    if (!node) return [];
    const target = field ? node.properties?.[field] : node;
    return (target?.enum ?? []).map((v) => JSON.stringify(v));
}

/** The literal discriminator tags of every member of a Ws* union, deduped, in spec order. */
function unionTags(name, propOrder = ['type', 'kind']) {
    const node = schemas[name] ?? {};
    const disc =
        typeof node.discriminator === 'string'
            ? node.discriminator
            : node.discriminator?.propertyName;
    const order = disc ? [disc, ...propOrder.filter((p) => p !== disc)] : propOrder;

    // A `discriminator.mapping` is the authoritative tag list for that union.
    const mapping = typeof node.discriminator === 'object' ? node.discriminator.mapping : undefined;
    if (mapping && disc) return [...new Set(Object.keys(mapping).map((k) => JSON.stringify(k)))];

    const variants = node.oneOf ?? node.anyOf ?? [];
    const tags = [];
    for (const raw of variants) {
        const variant = raw.$ref ? schemas[refName(raw.$ref)] : raw;
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
                tags.push(...list.map((x) => JSON.stringify(x)));
                break;
            }
        }
    }
    return [...new Set(tags)];
}

/** Walks a nested union member and returns every discriminator tag it can produce. */
function collectNested(variant, order) {
    const out = [];
    for (const raw of variant.oneOf ?? variant.anyOf ?? []) {
        const member = raw.$ref ? schemas[refName(raw.$ref)] : raw;
        if (!member) continue;
        for (const prop of order) {
            const list = member.properties?.[prop]?.enum;
            if (list?.length) {
                out.push(...list.map((x) => JSON.stringify(x)));
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

const GENERATED_NOTE = (outPath) =>
    `// GENERATED by scripts/generate-harness-contract.mjs from src/server/harness.swagger.yaml.\n` +
    `// Do not edit by hand: regenerate with \`node scripts/generate-harness-contract.mjs\`.\n` +
    `// CI guard: \`node scripts/generate-harness-contract.mjs --check\`.\n` +
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

function buildFile(names, header, other) {
    const blocks = names.map(emitSchema);

    // Model imports (aliases) are hoisted into one block at the top of the file.
    const byModule = new Map();
    for (const n of names) {
        const alias = ALIASES[n];
        if (!alias) continue;
        if (!byModule.has(alias.from)) byModule.set(alias.from, []);
        byModule.get(alias.from).push(`${alias.as} as ${aliasLocal(n)}`);
    }
    const modelImports = [...byModule.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
            ([mod, bindings]) =>
                `import type {\n${bindings.map((b) => `    ${b},`).join('\n')}\n} from '${mod}';`,
        )
        .join('\n');

    // Only import names actually referenced from the sibling file (avoids unused imports).
    const used = new Set();
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

const check = process.argv.includes('--check');
let stale = [];
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
            `harness contract types are stale: ${stale.join(', ')} - run \`node scripts/generate-harness-contract.mjs\``,
        );
        process.exit(1);
    }
    console.log('harness contract types are up to date');
} else {
    console.log(
        `generated ${apiNames.length} REST types -> src/shared/harness-api.ts, ${streamNames.length} stream types -> src/shared/harness-stream.ts (${Object.keys(spec.paths ?? {}).length} paths)`,
    );
}
