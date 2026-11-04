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

export const summarizePanels = (panels: readonly ToolUiPanel[] | undefined): DisplayPanelSummary[] | undefined => {
    if (!Array.isArray(panels) || panels.length === 0) return undefined;

    const kept = panels.slice(0, PANELS_PER_STEP);

    return kept.map((panel) => {
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
            truncated: droppedBlocks || panels.length > kept.length,
            totalPanels: panels.length
        };
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

    if (node.kind === 'step') {
        // A `step` node inside a section's flow is the same record as `DisplayStep`;
        // the section supplies the addressing the wire omits.
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

// A wire context segment -> the render-model block. Two renames, both escalated:
//   - the wire's `label` IS the render model's `name` (the server-decided display
//     name: the recorded tool name for a tool block, `prompt`/`answer`/`instructions`
//     /`reasoning`/`steer` for the others). `ContextBlock.name` is required in the
//     render model, so an absent label becomes the kind, never an empty string.
//   - the wire publishes NO `inPrompt`. That flag tells the bar whether the segment
//     was part of what the model actually ran; with no figure on the wire the client
//     states the optimistic reading (every listed segment is part of the bar the
//     server built) and says so here rather than inventing a per-kind rule.
// A segment's state travels as a SECTION state on the wire (`SectionDisplayState`)
// and as a STEP state in the render model, because a bar segment mirrors the thing
// it names (a settled call is `ok`, an in-flight one is `running`). One mapping,
// applied here so no renderer compares two vocabularies.
const segmentStateOf = (state: WireContextBlock['state']): 'running' | 'ok' | 'error' | 'cancelled' | undefined => {
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
        name: block.label ?? block.kind,
        chars: block.chars,
        // Derived, not assumed: the projector's rule is total — `reasoning` is never
        // replayed into the next request, every other kind always is
        // (../shared/turn-display.ts:523-536). A flat `true` would mislabel every
        // thinking segment in the bar (`view-context.ts:356` counts `unpromptedChars`
        // and `:441` prints "not replayed into the prompt").
        inPrompt: block.kind !== 'reasoning',
        ...(state === undefined ? {} : { state }),
        ...(block.eventFrom === undefined ? {} : { eventFrom: block.eventFrom }),
        ...(block.eventTo === undefined ? {} : { eventTo: block.eventTo }),
        ...(block.callId === undefined ? {} : { callId: block.callId })
    };
};

// A steered submit: the wire carries `promptPreview` + `promptChars`, the render
// model names the bounded text `prompt`. Same shape of delta as the row's prompt,
// so the same rule: the preview stands in, and the verbatim text is the block this
// row's id keys.
const projectSteers = (
    steers: readonly DisplaySteerSummaryWire[] | undefined
): DisplaySteerSummary[] | undefined => {
    if (!Array.isArray(steers) || steers.length === 0) return undefined;

    return steers.map((steer) => ({
        ...(steer.id === undefined ? {} : { id: steer.id }),
        at: steer.at,
        prompt: steer.promptPreview,
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
