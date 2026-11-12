// Focused tests for the contract generator's type renderer (scripts/generate-harness-contract.ts).
//
// Run with:
//     yarn vitest run scripts/generate-harness-contract.test.ts
//
// They pin the two rules issue 0018 item 2 recorded as missing, both with EXACT expected output:
//   1. a schema whose `anyOf`/`oneOf` members carry only `required` (the OpenAPI spelling of "at
//      least ONE of these fields must be present") must fold the SIBLING `properties` map into the
//      result instead of rendering `unknown | unknown` - the collapse that made a regeneration of
//      src/shared/harness-api.ts drop every field of `PatchTurnBlockRequest` and take 13 tsc errors
//      with it (src/server/api.ts:4600-4662);
//   2. a property's `description` renders as a JSDoc block at the property's own column, the prose
//      the shipped contract used to carry only as hand edits (e.g. TurnBlockWriteReceipt.included,
//      spec src/server/harness.swagger.yaml:8458-8470).
//
// The renderer is imported, not re-implemented here, and importing it has no side effect on the
// shipped files: the write/exit pass only runs when the module is the process entry
// (generate-harness-contract.ts, `invokedDirectly`). The last test then runs the real `--check`
// guard as a subprocess, which is what pins the shipped contract to this generator.
//
// Ported from `node:test` to vitest (root AGENTS.md: tests use vitest, never `node --test`).
// Every case and every exact assertion survived the port 1:1: strict `assert.equal` -> `toBe`,
// `assert.deepEqual` -> `toEqual`, `assert.ok(!x, msg)` -> `expect(x, msg).toBe(false)`.
//
// Scratch lives under the repository-root Temp/ (root AGENTS.md); this test writes nothing.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Emitter, SPEC_SCHEMAS, carriesType, emitDeclaration, jsdoc } from './generate-harness-contract.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');
const GENERATOR = join(SCRIPT_DIR, 'generate-harness-contract.ts');

// AGENTS.md bans `process.execPath` on a repo file, and bans raw `node <file>.ts` outright
// (this Node cannot load `.ts`), so the guard subprocess has to be vite-node. Resolving the
// `vite-node` package's own CLI through the package manifest keeps the standalone-repo layout
// (where node_modules sits next to the package) and the hoisted workspace layout identical, and
// running `<node> node_modules/vite-node/dist/cli.mjs` IS vite-node, which is what the policy
// requires. `--script` is vite-node's documented script-runner mode: it is the only form that
// puts the script path in `process.argv[1]`, which is exactly what the generator's
// `invokedDirectly()` guard compares. Without it the guard never fires under vite-node and
// `--check` would silently exit 0 having asserted nothing.
const require = createRequire(import.meta.url);
const VITE_NODE_CLI = require.resolve('vite-node/cli');

/* ---------------------------------------------------------------------------
 * 1. `anyOf` of `required`-only members + sibling `properties`
 * ------------------------------------------------------------------------- */

// The exact shape of `PatchTurnBlockRequest` (src/server/harness.swagger.yaml:8415-8440): a
// `type: object` with the real field map, an `anyOf` pair naming nothing but `required`, and
// `additionalProperties: false`.
const patchShapedSchema = {
    type: 'object',
    description:
        'The fields a context segment has, on two independent axes; at least ONE of them must be present (a body naming neither is a 400).',
    additionalProperties: false,
    anyOf: [{ required: ['included'] }, { required: ['reasoningIncluded'] }],
    properties: {
        included: { type: 'boolean', description: 'The segment OWN prompt axis.' },
        reasoningIncluded: { type: 'boolean' },
    },
};

describe('anyOf of required-only members beside a sibling field map', () => {
    it('folds the sibling field map into an anyOf of required-only members', () => {
        // EXACT declaration: an interface (not `export type = unknown | unknown`), both axes optional
        // (the `required` pair lives on the members, so neither key is required), the described axis
        // documented, the undescribed one bare, and the closed-object note kept.
        expect(
            emitDeclaration('PatchAxesRequest', patchShapedSchema),
        ).toBe(
            [
                '/**',
                ' * The fields a context segment has, on two independent axes; at least ONE of them must be present (a body',
                ' * naming neither is a 400).',
                ' * Closed object: the server sends no property outside this set (additionalProperties: false).',
                ' */',
                'export interface PatchAxesRequest {',
                '    /** The segment OWN prompt axis. */',
                '    included?: boolean;',
                '    reasoningIncluded?: boolean;',
                '}',
                '',
            ].join('\n'),
        );
    });
});

/* ---------------------------------------------------------------------------
 * 2. Per-property `description` as JSDoc
 * ------------------------------------------------------------------------- */

describe('per-property `description` as JSDoc', () => {
    it('renders a property description as a JSDoc block at the property column', () => {
        // A described top-level key, plus a described key INSIDE an inline object body: the nested
        // block lines up with its own property column (6 spaces, the column the inline body uses).
        expect(
            emitDeclaration('LinkReceipt', {
                type: 'object',
                description: 'Receipt carrying a described link map.',
                additionalProperties: false,
                required: ['block_id'],
                properties: {
                    block_id: {
                        type: 'string',
                        description: 'Echoed so a late answer can be matched to its click.',
                    },
                    links: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            block: { type: 'string', description: 'The read that shows the row.' },
                        },
                    },
                },
            }),
        ).toBe(
            [
                '/**',
                ' * Receipt carrying a described link map.',
                ' * Closed object: the server sends no property outside this set (additionalProperties: false).',
                ' */',
                'export interface LinkReceipt {',
                '    /** Echoed so a late answer can be matched to its click. */',
                '    block_id: string;',
                '    links?: {',
                '      /** The read that shows the row. */',
                '      block?: string;',
                '      };',
                '}',
                '',
            ].join('\n'),
        );
    });

    it('keeps schema-level doc blocks byte-stable while property blocks follow the same right edge', () => {
        const prose =
            'Advertised capability flags, stated as booleans so a client hides an affordance instead of discovering it by clicking at a route that answers 403 for that shape.';

        // The schema-level block (no indent) is byte-for-byte what the shipped contract carries today,
        // including where the hard wrap lands: the 110-column budget is measured on the text lines.
        expect(
            jsdoc(prose),
        ).toBe(
            [
                '/**',
                ' * Advertised capability flags, stated as booleans so a client hides an affordance instead of discovering it by',
                ' * clicking at a route that answers 403 for that shape.',
                ' */',
                '',
            ].join('\n'),
        );

        // The same prose at the property column keeps the same rendered right edge (indent + ` * `).
        expect(
            jsdoc(prose, undefined, '    '),
        ).toBe(
            [
                '    /**',
                '     * Advertised capability flags, stated as booleans so a client hides an affordance instead of discovering it',
                '     * by clicking at a route that answers 403 for that shape.',
                '     */',
                '',
            ].join('\n'),
        );

        // No description, no block (a key with nothing to say stays bare, as it does today).
        expect(jsdoc(undefined)).toBe('');
    });
});

/* ---------------------------------------------------------------------------
 * 3. Typed union members + sibling `properties` (allOf parity)
 * ------------------------------------------------------------------------- */

const taggedUnionSchema = {
    type: 'object',
    description: 'Common fields beside a tagged union of two refs.',
    oneOf: [{ $ref: '#/components/schemas/WsWelcome' }, { $ref: '#/components/schemas/WsError' }],
    properties: { epoch: { type: 'string' }, at: { type: 'integer' } },
    required: ['epoch'],
};

describe('typed union members intersected with the sibling field map', () => {
    it('intersects typed union members with the sibling field map', () => {
        const emitter = new Emitter();
        // The union is parenthesised so `&` binds to the whole union, not to its last member.
        expect(
            emitter.type(taggedUnionSchema, 0),
        ).toBe(
            ['(WsWelcome | WsError)', '    & {', '        epoch: string;', '        at?: number;', '    }'].join('\n'),
        );

        // As a declaration: an intersection keeps its shape instead of being re-split into a `|` list,
        // which would move the `&` onto the last member and silently re-associate the type.
        expect(
            emitDeclaration('TaggedUnion', taggedUnionSchema),
        ).toBe(
            [
                '/** Common fields beside a tagged union of two refs. */',
                'export type TaggedUnion = (WsWelcome | WsError)',
                '    & {',
                '        epoch: string;',
                '        at?: number;',
                '    };',
                '',
            ].join('\n'),
        );
    });
});

/* ---------------------------------------------------------------------------
 * 4. The type/constraint split the fold depends on
 * ------------------------------------------------------------------------- */

describe('the type/constraint split the fold depends on', () => {
    it('separates a member that carries a type from one that carries only a constraint', () => {
        expect(
            [
                // `required` alone is a constraint over the sibling field map: no type to render.
                carriesType({ required: ['included'] }),
                carriesType({ $ref: '#/components/schemas/Foo' }),
                carriesType({ type: 'object', properties: { a: { type: 'string' } } }),
                carriesType({ type: 'string', description: 'text' }),
                carriesType({ items: { type: 'string' } }),
                carriesType(undefined),
            ],
        ).toEqual([false, true, true, true, true, false]);
    });
});

/* ---------------------------------------------------------------------------
 * 5. The shipped body the two rules exist for
 * ------------------------------------------------------------------------- */

describe('the shipped body the two rules exist for', () => {
    it('renders the shipped PatchTurnBlockRequest with both axes instead of unknown', () => {
        // The real spec schema (src/server/harness.swagger.yaml:8415-8440), not a fixture: its `anyOf`
        // pair carries nothing but `required`, so its declaration must carry the field map. Only the
        // CODE lines are asserted here (the prose lines are the spec's, and the `--check` guard below
        // pins them byte-for-byte against the shipped file), stripped the same way the emitter's own
        // comment blocks are laid out.
        const declaration = emitDeclaration('PatchTurnBlockRequest', SPEC_SCHEMAS.PatchTurnBlockRequest);
        const code = declaration
            .split('\n')
            .filter((line) => {
                const text = line.trim();
                return text !== '' && !text.startsWith('/**') && !text.startsWith('*') && !text.startsWith('*/');
            })
            .join('\n');

        expect(
            code,
        ).toBe(
            [
                'export interface PatchTurnBlockRequest {',
                '    included?: boolean;',
                '    reasoningIncluded?: boolean;',
                '}',
            ].join('\n'),
        );
        // The collapse this issue recorded, asserted as an absence so a regression names itself.
        expect(
            declaration.includes('unknown'),
            'the required-only anyOf members must not enter the union',
        ).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * 6. The shipped contract matches this generator
 * ------------------------------------------------------------------------- */

describe('the shipped contract matches this generator', () => {
    it('the CI guard reports the shipped contract as up to date', { timeout: 120_000 }, () => {
        // `--check` is read-only (it never writes); exit 0 means both generated files on disk are
        // byte-identical to what this renderer produces, i.e. no hand edits are left in them.
        const result = spawnSync(process.execPath, [VITE_NODE_CLI, '--script', GENERATOR, '--check'], {
            cwd: resolve(PKG_ROOT),
            encoding: 'utf8',
        });

        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('harness contract types are up to date\n');
        expect(result.status).toBe(0);
    });
});
