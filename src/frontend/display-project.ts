// Wire display record -> internal projector model (T14).
//
// WHY THIS FILE EXISTS (the deltas the generated contract itself declares):
// ../shared/harness-api.ts says the spec models `DisplayNode`, `DisplayStep`,
// `ContextBlock`, `TurnSection`, `TurnSummary` and friends as ONE closed record
// whose kind-specific fields are optional, while ../shared/turn-display.ts emits a
// DISCRIMINATED UNION of narrower members. "A projector member satisfies the wire
// record, but the wire record does not narrow back to the member." So the browser
// cannot cast a wire record into the render model — a cast would silently hand the
// reducers `undefined` where they read a required field. Every function here fills
// exactly the fields the union member requires, from what the wire DOES guarantee,
// and says nothing about the rest.
//
// The three places the wire is genuinely narrower than the projector, and what
// this module does about each (escalated in the T14 report as contract gaps):
//
//   1. `DisplayStep.detail` (the internal `DisplayStepDetailRef`) is NOT a wire
//      field. The detail route's key IS `step.id` (the opening event's index — the
//      contract states that identity in `DisplayStep`), so the ref is rebuilt from
//      the addressing the wire guarantees: `stepId = step.id`, `hasResult =
//      state !== 'running'`, `truncated` from the preview bounds the row carries.
//   2. `DisplayStep.panels` is a full `ToolUiPanel[]` on the wire and a bounded
//      `DisplayPanelSummary[]` in the render model. `summarizePanels` performs the
//      same reduction the projector does, so the board never paints a full table it
//      received bytes for.
//   3. `DisplayStep.outcome` / `startedAt` / `endedAt` / `action` are not wire
//      fields at all. They are left ABSENT rather than invented: the renderers
//      already treat an absent outcome as "the frame says nothing", which is the
//      honest statement, and a synthesized one would be a claim about a run this
//      client did not observe.
//
// A FOURTH gap, escalated in the same report and now CLOSED: the wire `ContextBlock`
// declared a required `label`, a required `state`, and none of the recorded times, spans,
// or the `inPrompt` verdict, while the routes transport the projector's record verbatim
// (`name`, `at`, `endedAt`, `durationMs`, `argsChars`, `resultChars`, `inPrompt`). See
// `projectBlock` below for the one mapping that reads them.
import type {
    ContextBlock as WireContextBlock,
    DisplayBlockSummary,
    DisplayNode as WireNode,
    DisplaySteerSummary as DisplaySteerSummaryWire,
    DisplayStep as WireStep,
    DisplayTail as WireTail,
    HarnessPendingTool,
    ToolUiPanel,
    TurnDisplay as WireTurnDisplay,
    TurnSection as WireTurnSection,
    TurnSummary as WireTurnSummary
} from '../shared/harness-api';
import type {
    ContextBlock,
    DisplayNode,
    DisplaySteerSummary,
    DisplayPanelBlockSummary,
    DisplayPanelSummary,
    DisplayStep,
    DisplayTail,
    // The section-vocabulary union, kept only so `segmentStateOf` can type its tolerant
    // input (see the comment above it); the wire's own ref is `StepDisplayState`.
    SectionDisplayState,
    TurnDisplay,
    TurnSection
} from '../shared/turn-display';
import { DISPLAY_PANEL_PREVIEW_CHARS, DISPLAY_PANEL_TITLE_CHARS } from '../shared/turn-display';
import type { TurnRowView } from './view-model';

// Panels the compact render model holds per step, mirroring the projector's own
// bound (../shared/turn-display.ts `DISPLAY_PANELS_PER_STEP`) so "+N more panels"
// stays truthful when the wire sent more than the board can draw.
const PANELS_PER_STEP = 4;

const blockSummaryOf = (panel: ToolUiPanel): DisplayPanelBlockSummary[] =>
    (panel.blocks ?? []).map((block) => {
        if (block.type === 'table') {
            return { type: 'table', rows: (block.rows ?? []).length, columns: (block.columns ?? []).length };
        }

        if (block.type === 'keyValue') return { type: 'keyValue', items: (block.items ?? []).length };

        return { type: 'text', length: (block.text ?? '').length };
    });

// One readable line, bounded exactly like the projector bounds it, so a summary
// never claims more than the board has room for.
const previewOf = (panel: ToolUiPanel): string | undefined => {
    for (const block of panel.blocks ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            const line = block.text.split('\n')[0] ?? '';

            return line.length > DISPLAY_PANEL_PREVIEW_CHARS ? `${line.slice(0, DISPLAY_PANEL_PREVIEW_CHARS)}…` : line;
        }
    }

    return undefined;
};

// A wire panel entry arrives in one of two shapes, and the difference decides how it
// is bounded:
//
//   1. a FULL `ToolUiPanel` (what the generated contract declares,
//      ../shared/harness-api.ts:1792 `DisplayStep.panels?: ToolUiPanel[]`) — its blocks
//      carry CONTENT (`text`, `rows`, `items`);
//   2. an already-bounded `DisplayPanelSummary` (what the projector ACTUALLY ships on the
//      display route, ../server/turn-projector.ts:383 `panelSummaryOf`, transported
//      verbatim by ../server/api.ts `getSessionTurnDisplay`) — its blocks carry COUNTS
//      (`length`/`rows`/`items` figures) and it carries `truncated` + `totalPanels`.
//
// `totalPanels` exists on neither a `ToolUiPanel` nor a `ToolUiBlock`, so it is the one
// honest discriminator. Re-summarizing shape (2) used to run the summary through the
// shape-(1) reducer, which read `block.text` (absent on a summary) and therefore dropped
// the preview line and zeroed every count — so the scratch board drew nothing at all.
const isPanelSummary = (panel: ToolUiPanel | DisplayPanelSummary): panel is DisplayPanelSummary =>
    typeof (panel as DisplayPanelSummary).totalPanels === 'number';

// One FULL panel -> the bounded summary the render model holds.
const summaryOfPanel = (panel: ToolUiPanel): DisplayPanelSummary => {
    const blocks = blockSummaryOf(panel);
    const droppedBlocks = (panel.blocks ?? []).length > blocks.length;
    const preview = previewOf(panel);

    return {
        id: panel.id,
        slot: panel.slot,
        // The wire title is already bounded at `DISPLAY_PANEL_TITLE_CHARS`; this
        // guard only matters for a producer that sent more.
        title: panel.title.length > DISPLAY_PANEL_TITLE_CHARS
            ? `${panel.title.slice(0, DISPLAY_PANEL_TITLE_CHARS)}…`
            : panel.title,
        blocks,
        ...(preview === undefined ? {} : { preview }),
        truncated: droppedBlocks,
        totalPanels: 0
    };
};

export const summarizePanels = (
    panels: readonly (ToolUiPanel | DisplayPanelSummary)[] | undefined
): DisplayPanelSummary[] | undefined => {
    if (!Array.isArray(panels) || panels.length === 0) return undefined;

    const kept = panels.slice(0, PANELS_PER_STEP);

    return kept.map((panel) => {
        // Shape (2): the server already bounded it — keep its figures verbatim, because
        // `truncated` and `totalPanels` are the server's statement of what it left out
        // and a client may not restate them (turn-display.ts:229-234).
        if (isPanelSummary(panel)) return panel;

        return { ...summaryOfPanel(panel), totalPanels: panels.length };
    });
};

// A wire step -> the `DisplayStep` union member. `detail` is rebuilt from the
// identity the contract guarantees (see the header); everything the wire does not
// publish stays absent.
export const projectStep = (
    step: WireStep & { turnId?: string; sectionId?: string },
    fallback: { turnId: string; sectionId: string }
): DisplayStep => {
    const turnId = step.turnId ?? fallback.turnId;
    const sectionId = step.sectionId ?? fallback.sectionId;
    const settled = step.state !== 'running';
    const preview = step.preview;
    const argsPreview = step.argsPreview;

    return {
        kind: step.kind,
        id: step.id,
        turnId,
        sectionId,
        ...(step.callId === undefined ? {} : { callId: step.callId }),
        name: step.name,
        ...(argsPreview === undefined ? {} : { argsPreview }),
        ...(preview === undefined ? {} : { preview }),
        state: step.state,
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
        ...(step.media === undefined ? {} : { media: step.media }),
        ...(summarizePanels(step.panels) === undefined ? {} : { panels: summarizePanels(step.panels) }),
        detail: {
            stepId: step.id,
            hasResult: settled,
            // A preview that hit either bound means the detail route holds strictly
            // more; absent previews say nothing, so they are not "truncated".
            truncated:
                (preview?.length ?? 0) >= 200 ||
                (argsPreview?.length ?? 0) >= 200
        }
    };
};

// A wire node -> the node union member, discriminated on `kind`. A record with an
// unknown `kind` is data to tolerate: it becomes nothing, and the reducer already
// ignores an op whose payload is missing.
export const projectNode = (node: WireNode): DisplayNode | undefined => {
    const id = node.id;
    const text = node.text ?? '';

    // A `step` node inside a section's flow is the same record as `DisplayStep`;
    // the section supplies the addressing the wire omits.
    //
    // THE REAL NODE VOCABULARY. The generated contract spells a step node `kind: 'step'`
    // (../shared/harness-api.ts:1774), but the display route transports the projector's
    // record VERBATIM (../server/api.ts `getSessionTurnDisplay`), and the projector mints
    // its flow nodes in the STEP vocabulary — `kind: 'tool' | 'action'`
    // (../shared/turn-display.ts:675, emitted by ../server/turn-projector.ts). A tool row
    // therefore arrives inside `section.nodes` under its own kind. Accepting only `'step'`
    // dropped every tool node on the floor: the panel summaries ride on those nodes
    // (`DisplayStep.panels`), so the scratch board and every step-addressed action died with
    // them. Both spellings map to the same projection; neither is invented.
    if (node.kind === 'step' || node.kind === ('tool' as WireNode['kind']) || node.kind === ('action' as WireNode['kind'])) {
        return projectStep(node as unknown as WireStep, { turnId: '', sectionId: '' });
    }

    if (node.kind === 'notice') {
        return {
            kind: 'notice',
            id,
            tone: node.tone ?? 'info',
            text,
            ...(node.at === undefined ? {} : { at: node.at }),
            ...(node.stepId === undefined ? {} : { stepId: node.stepId })
        };
    }

    if (node.kind === 'reasoning') {
        return {
            kind: 'reasoning',
            id,
            text,
            ...(node.share === undefined ? {} : { share: node.share }),
            ...(node.chars === undefined ? {} : { chars: node.chars }),
            ...(node.redacted === true ? { redacted: true as const } : {})
        };
    }

    if (node.kind === 'text') {
        return {
            kind: 'text',
            id,
            text,
            committed: node.committed === true,
            ...(node.chars === undefined ? {} : { chars: node.chars }),
            ...(node.redacted === true ? { redacted: true as const } : {})
        };
    }

    return undefined;
};

// A wire context segment -> the render-model block.
//
// THE NAME. The render model's `name` is required (../shared/turn-display.ts:475) and
// the wire now publishes it under that same spelling: the display and block routes
// transport the projector's record verbatim (../server/api.ts:3741-3768
// `getSessionTurnDisplay` and :3807-3823 `getSessionTurnBlock` cast it, never restate
// it), so the field on the wire IS `name` — proven by the closed key set the server
// answers with for a system segment, `name` present and `label` absent
// (../server/api.test.ts:2195-2208). `label` stays in the contract as an OPTIONAL older
// spelling (../server/harness.swagger.yaml `ContextBlock`) for a producer that publishes
// it, so the read order is exactly `name` -> `label` -> `kind`: the recorded name wins, a
// legacy label still answers, and only a record with NEITHER falls back to the kind
// (never an empty string, because `ContextBlock.name` is required downstream).
//
// THE TIMES AND SPANS. `at` / `endedAt` / `durationMs` / `argsChars` / `resultChars`
// travel when the record supports them, and ABSENCE IS THE ANSWER: a call that never
// settled, a `user`/`system` segment with no recorded span, and an event with no
// timestamp each report nothing (../shared/turn-display.ts:476-522), so each key is
// copied only when the wire stated it. A synthesized `0` would be drawn as "12:00:00 AM"
// or "0ms" and read as a measurement (`view-context.ts:293` `contextBlockDurationOf`
// distinguishes an absent figure from a zero one, and `contextBlockCharsOf` likewise).
//
// `inPrompt` is the one field this client used to derive. The projector tracks it per
// block (../server/turn-projector.ts:1401/1887/1933/2021/2138/2195), the routes carry it,
// so the wire's value is used whenever present; the old per-kind rule survives ONLY as
// the fallback for a producer that omits the flag (the projector's rule is total:
// `reasoning` is never replayed, every other kind always is,
// ../shared/turn-display.ts:523-536), which keeps a thinking segment out of the bar's
// replayed figure either way (`view-context.ts:356` `unpromptedChars`, :441 "not replayed
// into the prompt").
//
// A segment's state travels in the STEP vocabulary the projector mints (`running` /
// `ok` / `error` / `cancelled`, ../server/turn-projector.ts:2022 and :2482, and now the
// declared wire ref too: ../server/harness.swagger.yaml `ContextBlock.state` refs
// `StepDisplayState`), and it is ABSENT for every non-tool kind and for a call that has
// not settled (../server/api.test.ts:2195-2206 shows a system segment answering with no
// `state` key at all). A record that carries a SECTION-vocabulary value anyway (`open` /
// `streaming` / `done`, ../shared/turn-display.ts:189) is still mapped here rather than
// passed through, so no renderer ever compares the two vocabularies.
const segmentStateOf = (
    state: WireContextBlock['state'] | SectionDisplayState
): 'running' | 'ok' | 'error' | 'cancelled' | undefined => {
    if (state === undefined) return undefined;
    if (state === 'open' || state === 'streaming') return 'running';
    if (state === 'done') return 'ok';

    return state;
};

export const projectBlock = (block: WireContextBlock): ContextBlock => {
    const state = segmentStateOf(block.state);

    return {
        kind: block.kind,
        id: block.id,
        turnId: block.turnId,
        sectionId: block.sectionId,
        // C2: the DISPLAY LANE, copied ONLY when the wire stated it — the same idiom as every
        // optional field here. Absent means lane 0 and `view-context.ts` owns that reading
        // (`contextBlockLaneOf`); a projection that defaulted it to 0 would be synthesizing a
        // number the server never sent, which the contract forbids
        // (../shared/turn-display.ts:479-483). It is metadata only, so nothing downstream
        // rewrites it: `ContextBlockPatch` has no `lane` key, so `context:set` cannot move a
        // block between rows (that is a remove + add pair).
        ...(block.lane === undefined ? {} : { lane: block.lane }),
        // `name` is the projector's spelling and the one this server sends; `label` is
        // the optional older spelling; `kind` is the last resort, never an empty string.
        name: block.name ?? block.label ?? block.kind,
        chars: block.chars,
        // Wire figure when published, projector's total rule as the fallback only.
        inPrompt: block.inPrompt ?? block.kind !== 'reasoning',
        ...(state === undefined ? {} : { state }),
        // Each figure below is copied ONLY when the wire stated it - the same idiom this
        // module uses for every optional field, and the reason "unknown" never reaches a
        // renderer as `0` (see "THE TIMES AND SPANS" above).
        ...(block.at === undefined ? {} : { at: block.at }),
        ...(block.endedAt === undefined ? {} : { endedAt: block.endedAt }),
        ...(block.durationMs === undefined ? {} : { durationMs: block.durationMs }),
        ...(block.argsChars === undefined ? {} : { argsChars: block.argsChars }),
        ...(block.resultChars === undefined ? {} : { resultChars: block.resultChars }),
        ...(block.eventFrom === undefined ? {} : { eventFrom: block.eventFrom }),
        ...(block.eventTo === undefined ? {} : { eventTo: block.eventTo }),
        ...(block.callId === undefined ? {} : { callId: block.callId }),
        // T7: the reader-facing inclusion, copied when a producer published it and left
        // ABSENT otherwise. Absent is not "included": it means "no transcript entry behind
        // this segment" (../shared/turn-display.ts:541), and a client that defaulted it to
        // `true` would hand every segment a toggle for a flag nothing can write. The bar
        // itself ignores this field; the segment dialog is what acts on it
        // (./ui/context-detail.ts), and today the block detail route is the only producer.
        ...(block.included === undefined ? {} : { included: block.included })
    };
};

// A steered submit: the wire carries `promptPreview` + `promptChars`, the render
// model names the bounded text `prompt`. Same shape of delta as the row's own
// prompt, so the same rule: the preview stands in, and the verbatim text is the
// block this row's id keys.
//
// ONE spelling now, the contract's: the server row serializer renames each steer entry's
// text exactly as it renames the row's own prompt (../server/api-reads.ts `turnRowOf` /
// `steerRowOf`), so the client reads `promptPreview` and nothing else. (The dual read this
// replaces was a workaround for a serializer that shipped the projector's internal
// `prompt` while the spec (../shared/harness-api.ts:1718-1726) requires `promptPreview`.)
const projectSteers = (
    steers: readonly DisplaySteerSummaryWire[] | undefined
): DisplaySteerSummary[] | undefined => {
    if (!Array.isArray(steers) || steers.length === 0) return undefined;

    return steers.map((steer) => ({
        ...(steer.id === undefined ? {} : { id: steer.id }),
        at: steer.at,
        // The closed contract REQUIRES this field, so the only reason it can be missing is a
        // producer outside the spec; `''` keeps the render model total (a tile that renders
        // `steer.prompt` never sees `undefined`) instead of reinstating the old spelling.
        prompt: steer.promptPreview ?? '',
        ...(steer.sectionId === undefined ? {} : { sectionId: steer.sectionId }),
        ...(steer.threadId === undefined ? {} : { threadId: steer.threadId }),
        ...(steer.references === undefined ? {} : { references: steer.references })
    }));
};

export const projectTail = (tail: WireTail): DisplayTail => ({ ...tail });

export const projectPending = (pending: HarnessPendingTool[] | undefined): HarnessPendingTool[] | undefined =>
    Array.isArray(pending) ? pending : undefined;

// One section. Three adaptations, each because the wire record is wider in shape
// and narrower in guarantees than the projector's member:
//   - the wire splits the flow into `nodes` and `steps`; the render model keeps ONE
//     flow array (`nodes`, whose members include the `DisplayStep` kind). Merging
//     by the id the contract guarantees — both are the decimal index of the event
//     that OPENED the entry — restores recorded order without touching arrival
//     order or position;
//   - `nodes`/`context`/`tail` are optional on the wire and `nodes` is required in
//     the member, so an absent flow becomes an explicit empty flow ("this section
//     produced nothing"), which is what the renderers already draw;
//   - `section.pending` has no home in the render model (a live tree carries it in
//     `pending:set` ops, and `view-state.ts` keeps it in a side map). It is
//     collected by `pendingSectionsOf` so a cold tree can seed that map instead of
//     losing which background calls were still open.
export const projectSection = (section: WireTurnSection): TurnSection => {
    const nodes = (section.nodes ?? [])
        .map(projectNode)
        .filter((node): node is DisplayNode => node !== undefined);

    const steps = (section.steps ?? []).map((step) => projectStep(step, { turnId: '', sectionId: section.id }));

    // Both id spaces are event indices, so a numeric merge is the recorded order.
    // An id that is not a number (a hand-built fixture) keeps its relative position
    // at the end rather than sorting to NaN-first.
    const merged = [...nodes, ...steps].sort((left, right) => {
        const a = Number(left.id);
        const b = Number(right.id);

        if (Number.isNaN(a) || Number.isNaN(b)) return 0;

        return a - b;
    });

    const projected: TurnSection = {
        id: section.id,
        role: section.role,
        agent: section.agent,
        agentLabel: section.agentLabel,
        state: section.state,
        nodes: merged
    };

    const copy = <K extends keyof TurnSection>(key: K, value: TurnSection[K] | undefined): void => {
        if (value !== undefined) (projected as Record<string, unknown>)[key as string] = value;
    };

    copy('parentSectionId', section.parentSectionId);
    copy('model', section.model);
    copy('invocationId', section.invocationId);
    copy('threadId', section.threadId);
    copy('threadLabel', section.threadLabel);
    copy('branchId', section.branchId);
    copy('startedAt', section.startedAt);
    copy('endedAt', section.endedAt);
    copy('latestInput', section.latestInput);
    copy('cachedInput', section.cachedInput);
    copy('answerNodeId', section.answerNodeId);

    if (section.context !== undefined) projected.context = (section.context ?? []).map(projectBlock);
    if (section.tail !== undefined) projected.tail = projectTail(section.tail);

    return projected;
};

export const projectDisplay = (display: WireTurnDisplay): TurnDisplay => ({
    turnId: display.turnId,
    sections: (display.sections ?? []).map(projectSection),
    ...(display.lastSectionOrdinal === undefined ? {} : { lastSectionOrdinal: display.lastSectionOrdinal })
});

// The background calls a cold tree reports per section, addressed the way
// `view-state.ts` addresses them (`pendingKeyOf(turnId, sectionId)`), so a tree read
// seeds the same side map the live `pending:set` ops maintain.
export const pendingSectionsOf = (
    display: WireTurnDisplay
): { sectionId: string; pending: HarnessPendingTool[] }[] =>
    (display.sections ?? [])
        .filter((section) => Array.isArray(section.pending) && section.pending.length > 0)
        .map((section) => ({ sectionId: section.id, pending: section.pending ?? [] }));

// One row. The wire carries `promptPreview` + `promptChars`; the render model names
// the field `prompt`, so the preview travels under BOTH spellings and
// `promptIsPreview` states which one it is. A tile that must show the verbatim text
// reads the turn metadata route — never a silent full-prompt assumption.
export const projectRow = (row: WireTurnSummary): TurnRowView => {
    const projected: TurnRowView = {
        id: row.id,
        index: row.index,
        // The preview stands in for the verbatim prompt, marked as such below.
        prompt: row.promptPreview,
        status: row.status,
        state: row.state,
        updatedAt: row.updatedAt,
        sectionCount: row.sectionCount,
        stepCount: row.stepCount,
        activeAgents: row.activeAgents ?? [],
        blocks: row.blocks ?? [],
        promptPreview: row.promptPreview,
        promptChars: row.promptChars,
        promptIsPreview: true
    };

    const copy = <K extends keyof TurnRowView>(key: K, value: TurnRowView[K] | undefined): void => {
        if (value !== undefined) (projected as Record<string, unknown>)[key as string] = value;
    };

    copy('threadId', row.threadId);
    copy('threadLabel', row.threadLabel);
    copy('startedAt', row.startedAt);
    copy('usage', row.usage);
    copy('latestInput', row.latestInput);
    copy('cachedInput', row.cachedInput);
    copy('detail', row.detail);
    copy('attachments', row.attachments);
    copy('references', row.references);
    copy('steers', projectSteers(row.steers));

    return projected;
};
