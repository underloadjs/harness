// T19: the global AGENT write surface (`PATCH`/`DELETE /v1/harness/agents/{agent_id}`).
//
// What is pinned, exactly:
//   1. a PATCH is a REAL write: the effective profile changes, the receipt names the fields the
//      global layer replaced, and the following read reports `instruction_source: "global"`
//      (never the pre-T19 constant `"catalogue"`);
//   2. an explicit `null` restores the shipped catalogue text for ONE field, and the durable
//      record then drops that field - the file is a list of decisions, not a copy of the
//      catalogue;
//   3. a DELETE retires the profile: the list loses it, the identified read 404s, a NEW harness
//      selection is refused, a NEW session on a harness that names it is refused, and an
//      EXISTING session keeps exactly the text its agents were seeded with;
//   4. durability: `<root>/harness/agents.json` carries the decision, and a SECOND runtime over
//      the same root replays both the override and the tombstone;
//   5. a refused write changes nothing, in memory or on disk;
//   6. the boot document no longer withholds a capability this build performs.
//
// Cross-references:
//   - ./harnesses/agent-state.ts  — the overlay (patch/retire/records/snapshot)
//   - ./harnesses/registry.ts     — the agent ops and the snapshot that rolls them back
//   - ./persistence.ts            — `HarnessAgentRecord`, `read/writeHarnessAgentRecords`
//   - ./api.ts                    — `patchAgent`, `deleteAgent`, `commitAgentEdit`
//   - ./api-reads.ts              — `agentSummaryOf`, `agentProfileOf`, roster provenance
//   - ./harnesses/toolbox.ts      — where a NEW session resolves the effective profile text

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentInstruction, agentProfile } from '../agents';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { HARNESS_AGENT_FILE, readHarnessAgentRecords } from './persistence';
import type { HarnessApiRequest, HarnessApiResult } from './api';

const ROOT = path.join(process.cwd(), 'Temp', 't19');

const SETTINGS = {
    baseURL: 'http://agentwrites.invalid/v1',
    apiKey: 'server-secret',
    model: 'agentwrites/model'
};

const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

const MOUNT = '/v1/harness';

/** A fresh scratch root per case, under the repo-root `Temp/` area (AGENTS.md). */
const tempRoot = (label: string): string => {
    const root = path.join(ROOT, `agents-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(root, { recursive: true });

    return root;
};

// One runtime per root, exactly the way a restart gets one: `createHarnessRuntime` (NOT the
// memoized `getHarnessRuntime`), so a second call over the same root is a fresh process view
// that can only know what the saved files say.
const boot = (root: string): HarnessRuntime =>
    createHarnessRuntime({ root, settings: SETTINGS, defaults: DEFAULTS, loadEnvironment: false });

const call = async (
    runtime: HarnessRuntime,
    method: string,
    rawPathname: string,
    body: unknown = {}
): Promise<{ status: number; body: Record<string, any> }> => {
    // The dispatcher reads parameters from `searchParams`, not from the pathname, so a query
    // string in the test's URL is split out here (the adapters do the same split).
    const [pathname, query] = rawPathname.split('?');
    const result = (await runtime.api({
        method,
        pathname: pathname!,
        mount: MOUNT,
        ...(query === undefined ? {} : { searchParams: new URLSearchParams(query) }),
        readBody: async () => body
    } as unknown as HarnessApiRequest)) as HarnessApiResult;

    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

/** The scratch root a runtime resolved, so no assertion guesses a generated directory name. */
const rootOf = (runtime: HarnessRuntime): string => {
    if (runtime.root === undefined) throw new Error('Expected a runtime built over a database root.');

    return runtime.root;
};

const agentFile = (root: string): string => path.join(root, 'harness', HARNESS_AGENT_FILE);

const readAgentFile = (root: string): unknown => JSON.parse(fs.readFileSync(agentFile(root), 'utf8')) as unknown;

const names = (items: unknown): string[] => (items as { name: string }[]).map((entry) => entry.name);

describe('PATCH /agents/{agent_id}', () => {
    it('replaces the profile text and states which fields the global layer overrides', async () => {
        const runtime = boot(tempRoot('patch'));
        const shipped = agentProfile('instruct');

        const before = await call(runtime, 'GET', `${MOUNT}/agents/instruct`);

        expect(before.status).toBe(200);
        expect(before.body.agent.instruction_source).toBe('catalogue');
        expect('overridden_fields' in before.body.agent).toBe(false);

        // The counter a write quotes comes from the shared per-process hub, so the expectation
        // is an exact DELTA from the value this same test just read rather than a magic
        // absolute. The delta is 2 by this hub's accounting, which every mutation route in this
        // file follows: the route bumps its resource counter, and `publish` advances the same
        // target again as it fans the change out.
        const patched = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, {
            title: ' Generalist ',
            instruction: 'Answer briefly. You are the generalist override.'
        });

        // `referenced_by` is the harnesses that select this profile; derived from the API's own
        // (unpaged) harness index so the expectation is exact without hardcoding a roster that
        // T3 widened.
        const cards = await call(runtime, 'GET', `${MOUNT}/harnesses?limit=100`);
        const referencing = (cards.body.items as { name: string; agents: string[] }[])
            .filter((card) => card.agents.includes('instruct'))
            .map((card) => card.name);

        expect(patched.status).toBe(200);
        // Trimmed, merged, and complete: the client never has to join two reads for this.
        expect(patched.body.agent).toEqual({
            name: 'instruct',
            title: 'Generalist',
            description: shipped.description,
            instruction: 'Answer briefly. You are the generalist override.',
            guidelines: shipped.guidelines,
            instruction_source: 'global',
            overridden_fields: ['title', 'instruction'],
            referenced_by: referencing,
            // A fresh runtime owns a fresh hub (verified: two `createHarnessRuntime` calls do
            // not share one), and one write advances its resource by 2: the route's own
            // `bumpRevision` plus the hub's advance as the change is published. The identified
            // read afterwards reports the same figure, which is the property that matters.
            revision: before.body.agent.revision + 2
        });

        expect(referencing).toContain('instruct');

        // The list projection states the same facts, so a picker shows the badge without a
        // second request per profile.
        const list = await call(runtime, 'GET', `${MOUNT}/agents`);
        const row = list.body.items.find((entry: Record<string, unknown>) => entry.name === 'instruct');

        expect(row).toEqual({
            name: 'instruct',
            title: 'Generalist',
            description: shipped.description,
            has_instruction_override: true,
            has_global_override: true
        });

        // The identified read after the write quotes the SAME counter the receipt carried, so a
        // client can order a stream frame against a read using either one.
        expect((await call(runtime, 'GET', `${MOUNT}/agents/instruct`)).body.agent.revision).toBe(
            patched.body.agent.revision
        );

        // The trusted catalogue object was never rewritten: `src/agents` stays the shipped
        // source, which is the whole point of an overlay (and the "no unsafe global object
        // mutation" rule).
        expect(agentProfile('instruct').title).toBe(shipped.title);
        expect(agentProfile('instruct').instruction).toBe(shipped.instruction);

        // Durable BEFORE the answer: the overlay file already carries the decision.
        expect(readAgentFile(rootOf(runtime))).toEqual([
            { name: 'instruct', title: 'Generalist', instruction: 'Answer briefly. You are the generalist override.' }
        ]);
    });

    it('restores the shipped text for one field when that field is sent as null', async () => {
        const runtime = boot(tempRoot('null-field'));
        const shipped = agentProfile('instruct');

        await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, {
            title: 'Temporary label',
            description: 'Temporary prose'
        });

        const cleared = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, { title: null });

        expect(cleared.status).toBe(200);
        expect(cleared.body.agent.title).toBe(shipped.title);
        // The other decision survives: a per-field null is not "reset the profile".
        expect(cleared.body.agent.description).toBe('Temporary prose');
        expect(cleared.body.agent.overridden_fields).toEqual(['description']);
        expect(readAgentFile(rootOf(runtime))).toEqual([{ name: 'instruct', description: 'Temporary prose' }]);
    });

    it('drops an override that equals the shipped value instead of recording a no-op', async () => {
        const runtime = boot(tempRoot('equals-shipped'));
        const shipped = agentProfile('instruct');

        const patched = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, {
            title: shipped.title,
            instruction: shipped.instruction
        });

        expect(patched.status).toBe(200);
        expect(patched.body.agent.instruction_source).toBe('catalogue');
        expect('overridden_fields' in patched.body.agent).toBe(false);
        // Nothing was decided, so the durable record says so with an empty list.
        expect(readAgentFile(rootOf(runtime))).toEqual([]);
    });

    it('refuses an invalid patch without changing the profile or the durable record', async () => {
        const runtime = boot(tempRoot('invalid'));
        const shipped = agentProfile('instruct');

        const blank = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, { title: '   ' });

        expect(blank.status).toBe(400);
        expect(blank.body.error.message).toContain('`agent.title` cannot be empty');

        const empty = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, {});

        expect(empty.status).toBe(400);
        expect(empty.body.error.message).toBe('A patch must change at least one field.');

        const unknownField = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, { model: 'x' });

        expect(unknownField.status).toBe(400);

        const tooLong = await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, {
            instruction: 'x'.repeat(8_001)
        });

        expect(tooLong.status).toBe(400);

        const after = await call(runtime, 'GET', `${MOUNT}/agents/instruct`);

        expect(after.body.agent.title).toBe(shipped.title);
        expect(after.body.agent.instruction).toBe(shipped.instruction);
        // Every refusal happened BEFORE the commit, so no file was written at all.
        expect(fs.existsSync(agentFile(rootOf(runtime)))).toBe(false);
    });

    it('answers 404 for an unknown profile', async () => {
        const runtime = boot(tempRoot('unknown'));

        expect((await call(runtime, 'PATCH', `${MOUNT}/agents/nope`, { title: 'X' })).status).toBe(404);
        expect((await call(runtime, 'DELETE', `${MOUNT}/agents/nope`)).status).toBe(404);
    });
});

describe('DELETE /agents/{agent_id}', () => {
    it('retires the profile, tombstones it durably, and refuses new selections of it', async () => {
        const root = tempRoot('retire');
        const runtime = boot(root);

        const removed = await call(runtime, 'DELETE', `${MOUNT}/agents/summarizer`);

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            agent_id: 'summarizer',
            tombstoned: true,
            // The tombstone lives in `agents.json` under this root, so a restart does NOT
            // resurrect the profile.
            restored_by_restart: false
        });

        expect((await call(runtime, 'GET', `${MOUNT}/agents/summarizer`)).status).toBe(404);
        expect(names((await call(runtime, 'GET', `${MOUNT}/agents`)).body.items)).not.toContain('summarizer');

        // A NEW harness cannot select it, and the refusal names the retirement rather than
        // pretending the id is unknown.
        const harness = await call(runtime, 'POST', `${MOUNT}/harnesses`, {
            name: 'condense',
            primary: 'summarizer'
        });

        expect(harness.status).toBe(409);
        expect(harness.body.error.message).toContain('Agent "summarizer" is retired');

        // A PATCH of a retired profile is 404 (the contract has no agent-create route that
        // could revive it: the shipped catalogue is the only source of a profile).
        expect((await call(runtime, 'PATCH', `${MOUNT}/agents/summarizer`, { title: 'Back' })).status).toBe(404);

        // An already-retired id cannot be deleted twice, either.
        const again = await call(runtime, 'DELETE', `${MOUNT}/agents/summarizer`);

        expect(again.status).toBe(404);
        expect(again.body.error.message).toContain('Unknown agent "summarizer"');

        expect(readAgentFile(root)).toEqual([{ name: 'summarizer', retired: true }]);
    });

    it('leaves an existing session on the shipped text and refuses a new session on the retired profile', async () => {
        const root = tempRoot('retire-session');
        const runtime = boot(root);

        const before = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'instruct' });

        expect(before.status).toBe(201);

        const beforeId = before.body.session.id as string;
        const shippedPrompt = agentInstruction(agentProfile('instruct'));

        expect((await call(runtime, 'DELETE', `${MOUNT}/agents/instruct`)).status).toBe(200);

        // The roster is the session's frozen definition, so every member is still there...
        const roster = await call(runtime, 'GET', `${MOUNT}/sessions/${beforeId}/agents`);
        const definition = await call(runtime, 'GET', `${MOUNT}/sessions/${beforeId}/definition`);

        expect(roster.status).toBe(200);
        expect(roster.body.agents.map((entry: { agent_id: string }) => entry.agent_id)).toEqual(
            definition.body.definition.agents as string[]
        );
        expect(roster.body.agents.map((entry: { agent_id: string }) => entry.agent_id)).toContain('instruct');

        // ...and it still RUNS the text it was seeded with: the retired profile did not reach a
        // live agent, and the read says `catalogue` because that is the layer this conversation
        // actually ran on.
        const instruction = await call(runtime, 'GET', `${MOUNT}/sessions/${beforeId}/agents/instruct/instruction`);

        expect(instruction.status).toBe(200);
        expect(instruction.body).toEqual({
            session_id: beforeId,
            agent_id: 'instruct',
            source: 'catalogue',
            instruction: shippedPrompt,
            guidelines: agentProfile('instruct').guidelines,
            chars: shippedPrompt.length
        });

        expect(roster.body.agents[0]).toMatchObject({ instruction_source: 'catalogue', instruction_chars: shippedPrompt.length });

        // A NEW session on the same (still-listed) harness cannot be built, because the profile
        // it would seed is gone from the selectable catalogue. T27 closed the status refinement
        // this test used to record as outstanding: `./sessions.ts` no longer re-wraps a build
        // failure as a generic 400 — an error that already states an HTTP status
        // (`AgentStateError`, and any registry/store error carrying one) is propagated, so the
        // refusal is the 409 policy answer, and the retirement reason still travels in the text.
        const after = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'instruct' });

        expect(after.status).toBe(409);
        expect(after.body.error.message).toContain('has been retired');

        expect(readAgentFile(root)).toEqual([{ name: 'instruct', retired: true }]);
    });
});

describe('durable agent decisions across a restart', () => {
    it('replays an override and a tombstone into a second runtime over the same root', async () => {
        const root = tempRoot('restart');
        const runtime = boot(root);

        await call(runtime, 'PATCH', `${MOUNT}/agents/research`, {
            guidelines: ['Only the operator bullet.']
        });
        await call(runtime, 'DELETE', `${MOUNT}/agents/summarizer`);

        expect(fs.existsSync(agentFile(root))).toBe(true);
        expect(readHarnessAgentRecords(root)).toEqual([
            { name: 'research', guidelines: ['Only the operator bullet.'] },
            { name: 'summarizer', retired: true }
        ]);

        // A new process over the same files: the only possible source of the next answer.
        const reopened = boot(root);

        const research = await call(reopened, 'GET', `${MOUNT}/agents/research`);

        expect(research.status).toBe(200);
        expect(research.body.agent.guidelines).toEqual(['Only the operator bullet.']);
        // The guidelines changed, the instruction did not: provenance is per field.
        expect(research.body.agent.instruction_source).toBe('catalogue');
        expect(research.body.agent.overridden_fields).toEqual(['guidelines']);

        expect((await call(reopened, 'GET', `${MOUNT}/agents/summarizer`)).status).toBe(404);
        expect(names((await call(reopened, 'GET', `${MOUNT}/agents`)).body.items)).not.toContain('summarizer');
    });

    it('applies a global instruction to a NEW session and never to an existing one', async () => {
        const runtime = boot(tempRoot('future-sessions'));

        const before = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'instruct' });
        const beforeId = before.body.session.id as string;

        expect(before.status).toBe(201);

        await call(runtime, 'PATCH', `${MOUNT}/agents/instruct`, { instruction: 'The operator instruction.' });

        const after = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'instruct' });
        const afterId = after.body.session.id as string;

        expect(after.status).toBe(201);

        // The two prompts, spelled out rather than re-derived from the helper under test:
        // the existing session keeps the shipped composition, and the new one runs the
        // OPERATOR's identity sentence with the profile's guidelines composed underneath —
        // because a `PATCH /agents/{id}` rewrites the PROFILE's `instruction` field, and an
        // un-overridden profile still gets the guideline block (T6 leaves that default alone;
        // only a harness/session instruction override skips it).
        const guidelinesBlock = (guidelines: readonly string[]) =>
            `Guidelines:\n${guidelines.map((line) => `- ${line}`).join('\n')}`;
        const shippedPrompt = `${agentProfile('instruct').instruction}\n\n${guidelinesBlock(agentProfile('instruct').guidelines)}`;
        const operatorPrompt = `The operator instruction.\n\n${guidelinesBlock(agentProfile('instruct').guidelines)}`;

        const existing = await call(runtime, 'GET', `${MOUNT}/sessions/${beforeId}/agents/instruct/instruction`);
        const fresh = await call(runtime, 'GET', `${MOUNT}/sessions/${afterId}/agents/instruct/instruction`);

        // Created before the edit: still the shipped composed prompt.
        expect(existing.body).toEqual({
            session_id: beforeId,
            agent_id: 'instruct',
            source: 'catalogue',
            instruction: shippedPrompt,
            guidelines: agentProfile('instruct').guidelines,
            chars: shippedPrompt.length
        });

        // Created after it: the operator sentence above the SAME trusted guideline bullets, and
        // the read names the layer it came from.
        expect(fresh.body).toEqual({
            session_id: afterId,
            agent_id: 'instruct',
            source: 'global',
            instruction: operatorPrompt,
            guidelines: agentProfile('instruct').guidelines,
            chars: operatorPrompt.length
        });
    });
});

describe('boot document capability', () => {
    it('advertises agent_writes now that the layer is implemented', async () => {
        const runtime = boot(tempRoot('capability'));
        const root = await call(runtime, 'GET', `${MOUNT}`);

        expect(root.status).toBe(200);
        expect(root.body.capabilities.agent_writes).toBe(true);
    });

    it('says a restart restores the profile when the deployment has no database root', async () => {
        const inMemory = createHarnessRuntime({ settings: SETTINGS, defaults: DEFAULTS, loadEnvironment: false });
        const removed = await call(inMemory, 'DELETE', `${MOUNT}/agents/summarizer`);

        expect(removed.status).toBe(200);
        expect(removed.body.restored_by_restart).toBe(true);
        expect((await call(inMemory, 'GET', `${MOUNT}/agents/summarizer`)).status).toBe(404);
    });
});
