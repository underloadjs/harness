// Plugins catalogue + settings editor (T7 / R2-R3).
//
// R2 asked for a Plugins button NEXT TO the tools icon that lists what the server ships;
// R3 makes the shipped Context Compaction plugin's `contextLimit` editable there. What
// this file pins:
//
//   catalogue toggles (R2, relocated onto the session line)
//     - `.plugins-toggle` is the tools toggle's IMMEDIATE next sibling inside the
//       `.harness-title-tools` group, which is the LAST child of `.harness-title-row` (the
//       line with the harness title, the session id chip and the `+`) — each pane sits with
//       the session display because it is presented for the session in view, while the
//       topbar corner is app-wide (the switches inside the panes are themselves
//       deployment-wide, see main.ts beside `titleRow.append`); the group keeps the same
//       accessible-name / `aria-pressed` / `aria-controls` contract as before the move;
//     - it is disabled before boot has answered and after the server is lost, exactly
//       like the tools toggle;
//   view switching (R2)
//     - the Plugins pane replaces the centre column, the composer and the agent control
//       are hidden while it owns it, and a second press restores the chat whole;
//     - the two catalogues are mutually exclusive in BOTH directions: opening Plugins
//       closes Tools, opening Tools closes Plugins (main.ts `setPluginsView` /
//       `setToolsView`), and at most one toggle is ever `aria-pressed="true"`;
//   the catalogue read (R2/R3)
//     - `GET /plugins` is dialled on the FIRST open and never at boot, then cached: a
//       second open costs no traffic, and `.plugins-refresh` is the explicit re-read;
//     - a failed read renders the server's sentence plus a Retry that re-dials;
//     - every row carries its title, registry name, description, hook count, settings
//       badge and its effective settings line;
//   the detail dialog (R3)
//     - Context Compaction opens the shared modal with a numeric Context limit input
//       defaulted to 100000 and carrying the declared `min`/`step` (no ceiling);
//     - editing to 150000 and pressing Save sends EXACTLY
//       `PATCH /plugins/context-compaction` `{ settings: { contextLimit: 150000 } }`
//       (changed keys only), the answer is merged into the cache, the row's settings line
//       moves with it, and reopening shows 150000 with no extra read;
//     - the Save control is NEVER disabled (first frame, mid-write, after a save, after a
//       refusal) and sits flush RIGHT in its own row; a press with nothing changed is a
//       silent no-op, because the server refuses an empty settings patch with a 400
//       (../server/plugins.ts) and sending every field anyway would pin each untouched
//       default as an explicit stored override;
//     - a refusal shows the server's message verbatim, keeps the typed value, and re-arms
//       the write control;
//     - a plugin with no declared settings renders read-only: no control, no Save;
//   the read-only system prompt (2026-11-12)
//     - a row that carries `system_prompt` gets a `System prompt` section BETWEEN Hooks and
//       Settings, with the text verbatim (newlines included) in a styled `<p>` — never a
//       `<pre>`, which ui/dialog.css forces onto one line;
//     - a row without the field renders EXACTLY the sections it rendered before: the field
//       is optional on the wire, and only the plugin that prompts declares it. Pinned twice,
//       on the synthetic read-only row AND on the real shipped `async-ping` row;
//     - a row whose `system_prompt` is an EMPTY string renders the same two sections: the
//       contract declares `minLength: 1` and nothing enforces it, so the pane reads a blank
//       as "no prompt declared" instead of opening a section over an empty `<p>`.
//
// The GROUPED and GATED settings form (2026-11-13, T5/R3) — the request was that the settings
// pane "looks highly unorganised", and the target shape was
//
//     [[tick] Automatic trim invalid tools]
//        Trim after (tool turns): [ 2 ]
//
// with the indented row present ONLY while the tick is on. Two optional descriptor fields drive
// it (`group: { id, title }` and `parentKey`, ../shared/harness-api.ts `PluginSetting`), and what
// this file pins:
//   - each run of one `group.id` is a `role="group"` block whose accessible name is its VISIBLE
//     caption (`aria-labelledby` → the block's own `h4`), the blocks in manifest order, and every
//     gated setting inside that parent's own indented host — including a setting declared BEFORE
//     its gate, which still renders UNDER it;
//   - the reveal is SEEDED from the values on the row (an OFF gate opens with its children gone)
//     and moves with the tick in the SAME turn, no re-open and no request; a parent with a number
//     child and a string child hides BOTH;
//   - a hidden row is hidden by `hidden` on the ROW, never by dropping the field: the control
//     stays registered, keeps its value, and its key still reaches the `PATCH` on Save;
//   - an indent host hides ITSELF the moment every gated row inside it is hidden (2026-11-13): a
//     0-height host is still a flex item in the `gap: 8px` column of a block, so a collapsed
//     branch used to leave a dead gap under its parent, and `:empty` cannot match a host whose
//     rows are merely HIDDEN;
//   - a GATED setting is a parent candidate like an ungated one, so a gated switch with a child of
//     its own keeps that grandchild inside the same block and the same indent at every tick state
//     — not flushed to the form root behind its block;
//   - a `parentKey` naming a NON-boolean setting behaves exactly like one naming NOTHING: the
//     child renders SHOWN, because a number box has no tick that could ever bring the row back;
//   - Save refusing a value that lives in a hidden row REVEALS that row's whole gate chain and
//     focuses the box, keeping the same sentence and sending no `PATCH`;
//   - the plugin's own `enabled` row DIMS the blocks (`plugin-settings-groups--off` on the single
//     wrapper) and hides NOTHING — every block, caption and control stays on screen. The dim sits
//     on each row's OWN label and hint, never on `.plugin-setting`, because opacity applies to a
//     subtree and no descendant can undo an ancestor's value (D1/D2, 2026-11-13);
//   - a plugin that declares neither field keeps the pre-contract DOM exactly: rows are direct
//     children of `.plugin-settings-form` in declared order, and NO wrapper, block, caption or
//     indent element is built at all;
//   - the CSS half (jsdom runs no cascade): the named 18px indent step and its 600px narrowing, a
//     block caption one size BELOW `.plugin-detail-section-title`, the off-dim as a TWO-ENTRY
//     selector list aimed at the row's own label and hint at the app's own 0.82 step — with no
//     rule left anywhere trying to "restore" a control that sits under it, and a `forced-colors`
//     fallback — the tick-beside-label row built with `:has()` on the markup that already exists,
//     and `[hidden] { display: none !important }` still the reveal's only authority.
//
// R2 (this pass) FLIPPED the enablement half of that memo: there IS one tick box per
// row, in the row's top-right corner, and this file pins it end to end —
//   - every row carries an `input[type=checkbox]` beside the dialog trigger (a SIBLING
//     inside `.plugin-tab-row`: a `<button>` cannot contain a control, and CSS pins the
//     box to the corner above the tile so its click never opens the dialog), painted
//     from the TOP-LEVEL `PluginSummary.enabled` and never from `values.enabled` (which
//     carries declared settings only, so an undeclared plugin would read as off);
//   - one click sends `PATCH /plugins/{id}` `{ settings: { enabled: <next> } }` (the
//     framework's reserved key, accepted for every plugin) and repaints that ONE row from
//     the row the server answered, with no second catalogue read;
//   - a refusal prints the server's sentence in the pane's own live line and pulls the
//     tick back to the state the server has (a native checkbox flipped itself on click);
//   - R1: the pane, its rows and its tick boxes are usable WHILE A RUN IS PENDING, and a
//     run that settles underneath the open pane neither throws nor tears the pane down.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/plugins-tab.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionStreamItem, ToolDescriptor } from '../server/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionToolPage, sessionToolRow } from './session-config-test-support';
// `bumpFixtureEpoch` is the double's documented "the record moved OUTSIDE the request
// stream" signal: it drops the adapter's memoized GET answers, which is what makes a
// Retry/reload actually reach the fixture instead of re-reading the cached answer.
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

// A catalogue row WITH the enablement figure (R3). `ToolDescriptor`
// (../server/protocol.ts:414) predates that field, so the fixture states it the way
// `GET /tools` does and `toolRowOf` maps it through (./api.ts `toolRowOf`) — a row
// without it would render NO tick box. No pinned-set flag any more: every tool row,
// core entries included, carries a working box.
const fileReadTool: ToolDescriptor & { enabled: boolean } = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files', 'read'],
    visibility: 'searchable',
    enabled: true,
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths']
    }
};

const bootstrap = (fixture: Fixture = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: fixture.presets ?? [descriptor()],
    tools: [fileReadTool],
    defaults,
    // T4: the panes describe the CONVERSATION on screen, and with no conversation bound main.ts
    // HIDES both toggles (main.ts `sessionIsBound`), so this fixture always boots with s1 open.
    // `running` only decides whether that conversation is mid-run (the state R1 pins) or already
    // settled; every other test just needs a subject for the pane to describe.
    //
    // R1: the RUNNING conversation the catalogue gates used to hide behind.
    sessions: [fixture.running ? runningSession() : settledSession(), ...(fixture.extraSessions ?? [])],
    agents: []
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

// The rows `GET /plugins` serves, in the contract's wire spelling. `async-ping` is the
// real shipped row (src/plugins/async-ping.plugin.ts) so every figure asserted for it is
// the real one. `context-compaction` is the shipped plugin TRIMMED to the one setting the
// R3 request is about: the real descriptor declares six
// (contextLimit/modelLimits/enabled/minTokens/safetyTurns/mode — pinned against
// the generated catalogue in src/plugin/manifest.test.ts and src/server/plugins.test.ts),
// and a six-control form is not what this pane's contract is about. The third declares
// nothing, which is the read-only case, and the fourth carries a boolean + a string so
// both remaining control types are pinned.
//
// `enabled` is the TOP-LEVEL row field R2's switch paints from (../shared/harness-api.ts
// `PluginSummary`:676-689). `values` carries DECLARED settings only, so a row that does
// not declare `enabled` has no such key in the map while its switch is still stated —
// which is exactly why the pane must never read `values.enabled`.
type Row = {
    name: string;
    title: string;
    description: string;
    // The read-only system prompt (2026-11-12), OPTIONAL like the contract says
    // (../shared/harness-api.ts `PluginSummary.system_prompt`): only a plugin that prompts
    // declares one, and a row without it renders no prompt section at all — which is what
    // keeps every other plugin's panel the same as it was.
    system_prompt?: string;
    version: string;
    tags: string[];
    hooks: string[];
    builtin: boolean;
    enabled: boolean;
    settings: Record<string, unknown>[];
    values: Record<string, unknown>;
};

const asyncPingRow = (): Row => ({
    name: 'async-ping',
    title: 'Background Ping',
    description:
        'Keeps a conversation waiting on background tool work moving by emitting a periodic ping with the calls that are still running, replacing the fixed scheduler heartbeat.',
    version: '1.0.0',
    tags: ['background', 'async', 'lifecycle'],
    hooks: ['async.pending', 'async.drained', 'run.failed', 'thread.stopped', 'thread.deleted', 'harness.dispose'],
    builtin: true,
    // R2: the shipped row's switch state. `async-ping` declares NO `enabled` setting, so
    // the top-level field is the ONLY place this figure exists for it.
    enabled: true,
    settings: [
        {
            key: 'intervalMs',
            label: 'Ping interval (ms)',
            type: 'number',
            default: 600000,
            min: 1000,
            step: 1000,
            description: 'How often a still-running background tool is reported while work is pending.'
        }
    ],
    values: { intervalMs: 600000 }
});

const compactionRow = (): Row => ({
    name: 'context-compaction',
    title: 'Context Compaction',
    // The shipped one-sentence summary (src/plugins/context-compaction.plugin.ts
    // `metadata.description`, pinned byte-for-byte in
    // src/plugin/context-compaction.test.ts). The 2026-11-12 cleanup replaced the old
    // paragraph-length paraphrase with this single sentence, and the pane shows it verbatim
    // as `.plugin-detail-description`.
    description: 'Compacts the thread context when the conversation reaches a configured token threshold.',
    // Trimmed the same way the settings list below is (the shipped prompt is 1714 characters
    // and 21 lines, pinned byte-for-byte in src/plugin/context-compaction.test.ts). What
    // this fixture HAS to keep is the shape the pane's contract is about: a multi-line value
    // with the plugin's own marker, so a renderer that flattens newlines or parses the text
    // as markup fails here instead of in the browser.
    system_prompt:
        '[context compaction] Compact your knowledge now.\n1. DONE — work that is still relevant.\n2. PENDING — everything else, in order.',
    version: '1.0.0',
    tags: ['context', 'compaction', 'lifecycle'],
    hooks: ['turn.before'],
    builtin: true,
    enabled: true,
    settings: [
        {
            key: 'contextLimit',
            label: 'Context limit (tokens)',
            type: 'number',
            default: 100000,
            min: 1000,
            step: 1000,
            description:
                'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost.'
        }
    ],
    values: { contextLimit: 100000 }
});

const quietRow = (): Row => ({
    name: 'quiet-observer',
    title: 'Quiet Observer',
    description: 'Counts turns for the log and declares nothing to edit.',
    version: '0.2.0',
    tags: ['telemetry'],
    hooks: ['turn.after'],
    builtin: true,
    // OFF, and with NO declared setting: the switch still works, because `enabled` is the
    // framework's reserved key and the row's own field (../server/plugins.ts).
    enabled: false,
    settings: [],
    values: {}
});

// Mixed-type rows for the control-by-type rule: the shipped set declares numbers only.
const mixedRow = (): Row => ({
    name: 'extras',
    title: 'Extras',
    description: 'A host plugin that declares a boolean and a string setting.',
    version: '2.1.0',
    tags: ['extras'],
    hooks: ['turn.after'],
    builtin: true,
    enabled: true,
    settings: [
        { key: 'verbose', label: 'Verbose logging', type: 'boolean', default: false },
        {
            key: 'prefix',
            label: 'Log prefix',
            type: 'string',
            default: 'run',
            description: 'Prefix every line this plugin writes.'
        }
    ],
    values: { verbose: false, prefix: 'run' }
});

// The 2026-11-13 shape the settings-UI request is about: a plugin that DECLARES groups and
// parent-gated children. The field spellings are the plugin-settings contract's
// (`group: { id, title }` and `parentKey`, ../shared/harness-api.ts `PluginSetting`), and the
// row covers every branch of the renderer on purpose:
//   - `enabled` with NO group — the reserved master switch, and the proof that a grouped
//     plugin still renders an ungrouped row at the ROOT of the form, exactly as a plugin
//     without any grouping does;
//   - three blocks, and each gated child declared next to (or, for `truncateTurns`, BEFORE)
//     the row that gates it, so nesting cannot depend on declaration order;
//   - gated NUMBERS and a gated STRING, so the reveal is pinned as not a boolean-only trick;
//   - two seeded states at once — `trimInvalidTools` ON (children on screen when the dialog
//     opens) and `trimThoughts` OFF (child already gone when it opens), which pins the SEED,
//     not only the click path.
const trimmerRow = (): Row => ({
    name: 'context-trimmer',
    title: 'Context Trimmer',
    description: 'Withholds the parts of a conversation the model no longer needs.',
    version: '0.4.0',
    tags: ['context', 'trimming'],
    hooks: ['turn.before'],
    builtin: true,
    enabled: true,
    settings: [
        {
            key: 'enabled',
            label: 'Automatic trimming',
            type: 'boolean',
            default: true,
            description: 'Turns each policy off from the next turn; entries already withheld stay out.'
        },
        { key: 'trimInvalidTools', label: 'Automatic trim invalid tools', type: 'boolean', default: true, group: { id: 'invalid', title: 'Invalid tool calls' } },
        {
            key: 'invalidToolTurns',
            label: 'Trim after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1,
            group: { id: 'invalid', title: 'Invalid tool calls' },
            parentKey: 'trimInvalidTools'
        },
        {
            key: 'invalidOutcomes',
            label: 'Outcomes that count as invalid',
            type: 'string',
            default: 'failed,rejected',
            description: 'Comma-separated subset of failed, rejected, cancelled, empty.',
            group: { id: 'invalid', title: 'Invalid tool calls' },
            parentKey: 'trimInvalidTools'
        },
        { key: 'trimThoughts', label: 'Trim recorded thinking', type: 'boolean', default: false, group: { id: 'thoughts', title: 'Recorded thinking' } },
        {
            key: 'thoughtTurns',
            label: 'Trim after (thought entries)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            group: { id: 'thoughts', title: 'Recorded thinking' },
            parentKey: 'trimThoughts'
        },
        // Declared BEFORE its gate on purpose — the pane still nests it UNDER that gate.
        {
            key: 'truncateTurns',
            label: 'Truncate after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            group: { id: 'truncate', title: 'Truncate requests' },
            parentKey: 'truncateToolRequests'
        },
        { key: 'truncateToolRequests', label: 'Truncate tool requests', type: 'boolean', default: true, group: { id: 'truncate', title: 'Truncate requests' } }
    ],
    values: {
        enabled: true,
        trimInvalidTools: true,
        invalidToolTurns: 2,
        invalidOutcomes: 'failed,rejected',
        trimThoughts: false,
        thoughtTurns: 2,
        truncateTurns: 2,
        truncateToolRequests: true
    }
});

// The NESTED case (D5, 2026-11-13): a setting that is GATED and gates a row of its own. The
// manifest above only ever has a gated setting's siblings as children, so nothing pinned what
// happens when `parentKey` points at a row that is itself inside another row's indent — while
// the renderer registered only UNGATED rows in its placement map, the grandchild's host stayed
// detached and the closing flush dumped that row at the FORM ROOT, outside the block that
// declares it and outside the indent it belongs to.
//
// `innerTurns` is declared BEFORE `middle`, the gated switch that gates it, on purpose: the
// host has to be relocated under a row that did not exist yet, and that relocation only exists
// in the walk path a gated parent now shares with an ungated one.
const nestedRow = (): Row => ({
    name: 'nested-gates',
    title: 'Nested Gates',
    description: 'A gated switch that gates a horizon of its own.',
    version: '1.0.0',
    tags: ['context'],
    hooks: ['turn.before'],
    builtin: false,
    enabled: true,
    settings: [
        { key: 'outer', label: 'Outer switch', type: 'boolean', default: true, group: { id: 'block', title: 'One block' } },
        {
            key: 'middleTurns',
            label: 'Outer horizon',
            type: 'number',
            default: 3,
            min: 0,
            max: 10,
            group: { id: 'block', title: 'One block' },
            parentKey: 'outer'
        },
        // Declared BEFORE the gated switch that gates it — the ordering that used to strand it.
        {
            key: 'innerTurns',
            label: 'Inner horizon',
            type: 'number',
            default: 5,
            min: 0,
            max: 10,
            group: { id: 'block', title: 'One block' },
            parentKey: 'middle'
        },
        // Gated AND a parent: the row whose children host used to never be attached.
        { key: 'middle', label: 'Middle switch', type: 'boolean', default: true, group: { id: 'block', title: 'One block' }, parentKey: 'outer' },
        { key: 'tail', label: 'Plain row', type: 'number', default: 1, min: 0, max: 10, group: { id: 'block', title: 'One block' } }
    ],
    values: { outer: true, middleTurns: 3, innerTurns: 5, middle: true, tail: 1 }
});

// A gate pointing at the WRONG KIND of setting (D6, 2026-11-13). `underLimit` names a NUMBER
// setting and `underGhost` names nothing: both are manifest bugs, and before the fix only the
// second one was survivable. A `parentKey` on a number row read `input.checked` off a text
// box — `undefined`, so `!== true` — and hid its child forever with no tick anywhere to bring
// it back, while a dangling key rendered its child shown. Both now mean "no gate".
const wrongGateRow = (): Row => ({
    name: 'wrong-gate',
    title: 'Wrong Gate',
    description: 'A child gated by a number, and a child gated by nothing.',
    version: '1.0.0',
    tags: ['manifest'],
    hooks: ['turn.before'],
    builtin: false,
    enabled: true,
    settings: [
        { key: 'limit', label: 'Request limit', type: 'number', default: 4, min: 0, max: 10 },
        {
            key: 'underLimit',
            label: 'Under the limit',
            type: 'number',
            default: 2,
            min: 0,
            max: 10,
            parentKey: 'limit'
        },
        {
            key: 'underGhost',
            label: 'Under nothing',
            type: 'number',
            default: 1,
            min: 0,
            max: 10,
            parentKey: 'ghost'
        }
    ],
    values: { limit: 4, underLimit: 2, underGhost: 1 }
});

// Realistic epoch stamps (the same reason main.test.ts:73-75 states them): the UI formats
// server milliseconds, and a tiny value would read like a clock-skew bug.
const T = 1_700_000_000_000;

// One recorded turn of a conversation, in the shape the raw fixture double folds.
const runningTurn = () =>
    ({
        id: 't1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 2_000,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    }) as unknown as Record<string, unknown>;

// The RUNNING conversation R1 is about: boot embeds it, so the shell opens it and the
// whole shell enters its pending state (`running === true`) before anything is clicked.
const runningSession = () =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: T,
        updatedAt: T + 2_000,
        messages: [],
        turns: [runningTurn()],
        harnessDefinition: descriptor()
    }) as unknown as Record<string, unknown>;

// The SAME conversation after its work settled — the record the bounded fallback refresh
// brings back while a catalogue owns the centre column (A5). The shell paints it into the
// transcript pane even though that pane is off screen, and returning to the chat must
// show the settled tile rather than a frozen one.
const settledSession = () =>
    ({
        ...runningSession(),
        status: 'idle',
        updatedAt: 3,
        turns: [
            {
                ...runningTurn(),
                status: 'done',
                updatedAt: 1_700_000_004_000,
                // The recorded shape of a finished answer, exactly as main.test.ts states
                // it: the `done` frame carries the assistant MESSAGE (the projector reads
                // `event.message.content`), not a bare stop reason.
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    { type: 'text', agent: 'instruct', delta: 'all done' },
                    {
                        type: 'done',
                        agent: 'instruct',
                        message: {
                            role: 'assistant',
                            content: 'all done',
                            reasoning: '',
                            toolCalls: [],
                            model: 'm1',
                            stopReason: 'stop'
                        }
                    }
                ]
            }
        ]
    }) as unknown as Record<string, unknown>;

// The conversation the OTHER harness opens on (T4's harness-switch case). It is the settled
// figure with a different id and owner: the shell picks the newest conversation OF THE HARNESS
// on screen, so `harness: 'research'` is what makes the moved card open THIS record, and
// `harnessDefinition` is the definition that conversation runs under (frozen at create).
const researchSession = (): Record<string, unknown> =>
    ({
        ...settledSession(),
        id: 's2',
        harness: 'research',
        updatedAt: T + 1_000,
        harnessDefinition: descriptor({ name: 'research', title: 'Research', agents: ['research'], primary: 'research' })
    }) as unknown as Record<string, unknown>;

type Call = { url: string; method: string | undefined; body: unknown };

type Fixture = {
    // The harness roster the boot document reports (one by default).
    presets?: HarnessDescriptor[];
    // The rows `GET /plugins` answers, in page order.
    rows?: () => Row[];
    // Fail the first N catalogue reads with this server sentence.
    readFailures?: number;
    readMessage?: string;
    // Refuse every settings write with this message/status instead of applying it.
    patchMessage?: string;
    patchStatus?: number;
    // R1: boot with a conversation that is STILL RUNNING, so every assertion in the test
    // is made with the shell's pending lock held — the state the catalogues used to hide
    // themselves in.
    running?: boolean;
    // T4: conversations on OTHER harnesses. Moving the card to a second harness is only a real
    // conversation switch when that harness HAS a conversation of its own (with none, main.ts
    // hides both configuration toggles), which is what the harness-switch test is about.
    extraSessions?: readonly Record<string, unknown>[];
};

// The plugin half of the server, for the CONVERSATION on screen: `GET /sessions/:id/plugins`
// answers the whole page (descriptor plus this session's effective values) and `PATCH
// /sessions/:id/plugins/{id}` applies the settings map and returns the row — exactly the two
// routes the pane dials (../shared/harness-api.ts `PluginSummaryPage` / `PluginDetailResponse`,
// and ./api.ts `listSessionPlugins` / `updateSessionPluginSettings`). T4 moved the panes off the
// deployment spellings (`/plugins`, `/plugins/{id}`), which is why the urls below carry the
// session id: the SAME rows, read about one conversation.
const pluginRoutes = (
    fixture: Fixture,
    calls: Call[],
    state: { reads: number }
): ((url: string, method: string | undefined, body: unknown) => Response | undefined) => {
    // A MUTABLE store, so a saved value is what the next read answers as well (the server
    // persists overrides; the client normally never re-reads them, but a Retry must see
    // them). Row objects are cloned so a write cannot leak into another test's fixture.
    let store: Row[] = (fixture.rows ?? (() => [asyncPingRow(), compactionRow(), quietRow()]))().map((row) => ({
        ...row,
        values: { ...row.values }
    }));

    return (url, method, body) => {
        // A paged read arrives WITH its query string (`?limit=25`, ./api.ts `pageParams`), and
        // these fixtures match pathnames, so the query comes off first.
        const path = url.split('?')[0];

        // A GET arrives with the method OMITTED (this double's convention).
        //
        // The conversation is a VARIABLE here, not `s1`: the harness-switch test moves the card to
        // a second conversation and the pane re-reads for THAT id. One store answers both, because
        // what these tests pin is the descriptor/settings contract, not a per-conversation
        // difference in plugin state.
        if (path.match(/^\/api\/sessions\/[^/]+\/plugins$/) !== null && method === undefined) {
            state.reads += 1;
            calls.push({ url, method, body });

            if (fixture.readFailures !== undefined && state.reads <= fixture.readFailures) {
                return json({ error: { message: fixture.readMessage ?? 'The plugin catalogue is unavailable.' } }, 500);
            }

            return json({ items: store, limit: 25, next_cursor: null, observed_at: state.reads, revision: state.reads });
        }

        const patch = path.match(/^\/api\/sessions\/[^/]+\/plugins\/([^/]+)$/);

        if (patch !== null && method === 'PATCH') {
            calls.push({ url, method, body });

            const name = decodeURIComponent(patch[1]);
            const row = store.find((candidate) => candidate.name === name);

            if (row === undefined) return json({ error: { message: `Unknown plugin ${name}` } }, 404);

            if (fixture.patchMessage !== undefined) {
                return json({ error: { message: fixture.patchMessage } }, fixture.patchStatus ?? 400);
            }

            const settings = (body as { settings: Record<string, unknown> }).settings;

            // R2: the framework's RESERVED `enabled` key is a write on the TOP LEVEL of the
            // row, not another entry in `values` — `values` reports DECLARED settings only
            // (../server/plugins.ts:47-50, and the same rule the shipped `GET /plugins`
            // answers by). Every other key is an ordinary settings override.
            const { enabled, ...declared } = settings;

            if (enabled !== undefined) row.enabled = enabled === true;
            Object.assign(row.values, declared);
            store = store.map((candidate) => (candidate.name === name ? row : candidate));

            return json({ plugin: row });
        }

        return undefined;
    };
};

// Boot routes plus the plugin routes, with BOTH request logs: `calls` is what the fixture
// answered (with parsed bodies), and `dialed` is what the BROWSER sent — the canonical
// `/v1/harness/*` urls, which is the half that proves "exactly one catalogue read".
const stub = (fixture: Fixture = {}): { calls: Call[]; dialed: string[]; settleRun: () => void } => {
    const calls: Call[] = [];
    const dialed: string[] = [];
    // `settled` is A5's knob: the bounded fallback refresh answers with the terminal
    // record once the test flips it, which is the run completing WHILE the pane is open.
    const state = { reads: 0, settled: false };
    const plugins = pluginRoutes(fixture, calls, state);

    const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> => {
        const url = String(input);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

        if (url === '/api') return json(bootstrap(fixture));
        if (url === '/api/models') return json({ models: ['m1'] });

        // T4/R1: the conversations the directory reports. `sessionRecord` is the one the card opens
        // on boot — `settled` is A5's knob, so its record moves only for the running case, while
        // every other test boots on the settled figure (the same conversation, work done) — and
        // `extraSessions` is a SECOND harness's conversation for the test that moves the card.
        // Every canonical read of a record (the view open, the row page, the definition, the
        // metadata refresh) is COMPOSED by the shared double from the one raw figure, which is why
        // each conversation costs this fixture exactly one route.
        const sessionRecord = (): Record<string, unknown> =>
            fixture.running === true ? (state.settled ? settledSession() : runningSession()) : settledSession();
        const roster = (): Record<string, unknown>[] => [sessionRecord(), ...(fixture.extraSessions ?? [])];

        if (url === '/api/sessions' && method === undefined) return json({ sessions: roster() });

        const readOne = /^\/api\/sessions\/([^/?]+)$/.exec(url);

        if (readOne !== null && method === undefined) {
            const record = roster().find((candidate) => candidate.id === readOne[1]);

            if (record !== undefined) return json({ session: record });
        }

        // T4: the ⚒ pane describes the CONVERSATION on screen, so it dials
        // `GET /sessions/{id}/tools`. The only tool these fixtures describe is `read` (the boot
        // document's `tools` page above), and the row shape is the SERVER's rule for `protected`,
        // `declared` and `origin` — `sessionToolRow` states src/server/api-reads.ts:959-994, so the
        // pane paints a discovered, switchable name rather than a fixture invention.
        if (url.match(/^\/api\/sessions\/[^/]+\/tools(\?limit=25)?$/) !== null && method === undefined) {
            return json(
                sessionToolPage([
                    sessionToolRow({
                        name: 'read',
                        group: 'Files',
                        description: 'Read one or more files.',
                        tags: ['files', 'read'],
                        visibility: 'searchable',
                        enabled: true
                    })
                ])
            );
        }

        // A toolbox row carries NO argument schema (../shared/harness-api.ts `SessionToolSummary`),
        // so the manual runner pays the deployment's identified detail read (`GET /tools/read`,
        // ./api.ts `getTool`). T4 left EXECUTION global: the row still runs against the playground
        // conversation, not the one the pane describes.
        if (url === '/api/tools/read' && method === undefined) {
            return json({
                tool: { ...fileReadTool, session_bound: false, execution: { scope: 'global', manual: true } }
            });
        }

        const answered = plugins(url, method, body);

        if (answered !== undefined) return answered;

        // A route nobody declared is a FAILURE, not an empty pane: the shell's every
        // "no extra traffic" count depends on the double being strict.
        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    };

    const adapter = viewAwareFetch(raw, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            dialed.push(`${init?.method ?? 'GET'} ${String(input)}`);

            const answer = adapter(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return {
        calls,
        dialed,
        // The test's statement that the SERVER's record moved: flip the record and drop the
        // double's memoized reads, which is what lets the bounded refresh see the terminal
        // document (./view-test-support `bumpFixtureEpoch`).
        settleRun: () => {
            state.settled = true;
            bumpFixtureEpoch();
        }
    };
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);

    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const toolsToggle = (): HTMLButtonElement => byClass('.tools-toggle', 'button');
const pluginsToggle = (): HTMLButtonElement => byClass('.plugins-toggle', 'button');

const openPlugins = (): void => {
    if (pluginsToggle().getAttribute('aria-pressed') !== 'true') pluginsToggle().click();
};

const openTools = (): void => {
    if (toolsToggle().getAttribute('aria-pressed') !== 'true') toolsToggle().click();
};

const pluginRow = (name: string): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(`.plugin-tab-button[data-plugin="${name}"]`);

    if (found === null) throw new Error(`missing plugin row ${name}`);

    return found;
};

// The corner tick box of one plugin row. `input`, not the old `role="switch"` button:
// the native control carries the state in `checked` and needs no ARIA mirror.
const pluginBox = (name: string): HTMLInputElement =>
    byClass(`.plugin-tab-enable[data-plugin="${name}"]`, 'input');

// The rows the pane is showing, in server order — stated as the rows' own keys rather
// than as their rendered text.
const pluginNames = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('.plugin-tab-button')].map((node) => node.dataset.plugin ?? '');

const texts = (selector: string): string[] =>
    [...document.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '');

// --- the grouped/gated form probes (T5/R3) ----------------------------------

// The ROW a control belongs to — the element the reveal puts `hidden` on. A control can be
// reachable while its row is hidden (that is the whole point: the value is still editable
// and still savable), so "is the setting shown" is a question about the row, never the input.
const settingRow = (key: string): HTMLElement => {
    const input = byClass(`.plugin-setting-input[data-setting="${key}"]`, 'input');
    const row = input.closest('.plugin-setting');

    if (row === null) throw new Error(`setting ${key} has no .plugin-setting row`);

    return row as HTMLElement;
};

// The tick of one setting, PRESSED — the way a reader flips it, so the events a real click
// fires are the events the reveal has to answer.
const tickOf = (key: string): void => {
    byClass(`.plugin-setting-input[data-setting="${key}"]`, 'input').click();
};

// Which rows the form is hiding, stated as the keys they hold (empty when all are shown).
const hiddenSettingKeys = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('.dialog .plugin-setting')]
        .filter((row) => row.hidden)
        .map((row) => row.querySelector('input')?.dataset.setting ?? '');

// The indent host of one parent, by the `data-parent` main.ts writes on it. The ROW is the
// element `hidden` goes on for a gated setting; the HOST is the element that hides itself once
// every row inside it is hidden (D3) — the two are different assertions and the host is the one
// that decides whether a collapsed branch leaves a dead gap under its parent.
const childHostOf = (parentKey: string): HTMLElement =>
    byClass(`.plugin-setting-children[data-parent="${parentKey}"]`, 'div');

// One indent host as DATA: its `data-parent`, then an entry per thing it holds, RECURSING into
// a nested host — D5 makes that real, because a gated setting is a parent too and its own
// children host hangs inside the host it lives in.
const childHostTree = (host: HTMLElement): unknown[] => [
    `children:${host.dataset.parent ?? ''}`,
    ...[...host.children].map((child) =>
        child.className === 'plugin-setting-children' ? childHostTree(child as HTMLElement) : child.querySelector('input')?.dataset.setting
    )
];

// The settings form as DATA rather than as prose: one entry per child of
// `.plugin-settings-form`, a block expanded into its caption, its own rows and, for each
// gated child host, `children:<parentKey>` plus the keys it holds. One exact structural
// assertion pins the heading order, the nesting, the indent host and the flat row's place at
// the root all at once — "the child is somewhere under the parent" would also pass on a form
// that flattened everything.
const settingsFormTree = (): unknown[] =>
    [...byClass('.plugin-settings-form', 'div').children].map((node) => {
        if (node.className === 'plugin-setting') return node.querySelector('input')?.dataset.setting;
        // A host whose parent is dangling or wrong-typed is flushed to the form ROOT, and a
        // nested host is always inside another host, so this branch is the flushed case.
        if (node.className === 'plugin-setting-children') return childHostTree(node as HTMLElement);
        if (node.className !== 'plugin-settings-groups') return node.className;

        return [...node.children].map((block) =>
            [...block.children].map((row) => {
                if (row.tagName === 'H4') return row.textContent;
                if (row.className === 'plugin-setting') return row.querySelector('input')?.dataset.setting;

                return childHostTree(row as HTMLElement);
            })
        );
    });

// Every plugins-page read the browser dialled, WHICHEVER conversation it was dialled for. T4
// scoped the pane to the conversation on screen, so its url carries that id — and a card move is
// a new subject, which makes "did the cache ride along?" a question about two different urls.
const pluginCountReads = (dialed: readonly string[]): number =>
    dialed.filter((line) => /^GET \/v1\/harness\/sessions\/[^/]+\/plugins/.test(line)).length;

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// --- the catalogue control (R2, relocated onto the session line) ---------------

it('places the Plugins toggle immediately after the Tools toggle with the same contract', async () => {
    stub();
    await boot();

    const toggle = pluginsToggle();

    // The session-line group is tools then plugins, and the plugin icon is the tools
    // icon's IMMEDIATE next sibling — the pairing this control always had, now to the RIGHT
    // of the session display (this pane is presented for the session in view) instead of in
    // the app-wide topbar corner.
    const group = byClass('.harness-title-tools', 'div');
    expect([...group.children]).toEqual([toolsToggle(), toggle]);
    expect(toolsToggle().nextElementSibling).toBe(toggle);
    expect(toggle.parentElement).toBe(group);
    // The group is the LAST child of the title row, so the line reads
    // title · id chip · `+` · id span · ⚒ ⚙ with the icons flush right.
    expect([...byClass('.harness-title-row', 'div').children].at(-1)).toBe(group);
    expect(byClass('.harness-head', 'header').contains(toggle)).toBe(true);
    // The corner cluster is the status pill ALONE, and neither toggle is in the topbar.
    expect([...byClass('.topbar-right', 'div').children]).toEqual([
        byClass('.status-button', 'button')
    ]);
    expect(byClass('.topbar', 'header').contains(toggle)).toBe(false);

    // Icon-only toggle with an accessible name: a decorative glyph, `aria-pressed` for
    // the closed view, and `aria-controls` naming the centre region it replaces.
    expect(toggle.type).toBe('button');
    expect(toggle.id).toBe('plugins-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Plugins');
    expect(toggle.getAttribute('aria-controls')).toBe('harness-stage');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toBe('Show the plugin catalogue');
    expect(toggle.textContent).toBe('⚙');
    expect(toggle.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚙');
    expect(byClass('.stage', 'div').id).toBe('harness-stage');

    // Boot reached a selected harness, so both catalogue controls are usable — and the
    // chat still owns the stage: nothing was opened and the tools view is untouched.
    expect(toggle.disabled).toBe(false);
    expect(toolsToggle().disabled).toBe(false);
    expect(toolsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);
});

it('keeps both catalogue toggles disabled while the server is unreachable', async () => {
    // A REAL transport failure, not an unwired route double. The double composes canonical
    // answers on its own — a synthesized `ServiceInfo` for the root read and empty pages for
    // the catalogue reads (./view-test-support.ts:1449-1456) — so `viewAwareFetch` over a
    // throwing handler RESOLVES the bootstrap with no harnesses. Since T3 that answer is the
    // healthy empty-catalogue state, not the offline pane, so the old fixture could no longer
    // reach R3; only a rejected fetch can.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        })
    );

    await boot();

    expect(document.querySelector('.empty-title')?.textContent).toBe('Harness server unavailable');
    expect(pluginsToggle().disabled).toBe(true);
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(toolsToggle().disabled).toBe(true);

    // A programmatic press of a disabled control still opens nothing.
    pluginsToggle().click();
    await flush();

    expect(document.querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
});

// --- the pane and its catalogue read -----------------------------------------

it('opens the pane from the toggle, reads the catalogue on first open, and lists every plugin', async () => {
    const { dialed } = stub();
    await boot();

    // No plugin traffic before the reader asks for it: this view adds NOTHING to boot.
    expect(dialed.filter((line) => line.includes('/plugins'))).toEqual([]);

    openPlugins();

    // The loading state lands with the swap, before the answer does.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(byClass('.plugins-loading', 'p').textContent).toBe('Reading the plugin catalogue…');

    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    // The read is THIS conversation's — `{root}/sessions/s1/plugins` — and the DEPLOYMENT
    // catalogue route (`{root}/plugins`) is never dialled at all: T4 moved the pane's subject, it
    // did not add a second surface next to the old one.
    expect(dialed.filter((line) => line.startsWith('GET /v1/harness/sessions/s1/plugins'))).toEqual([
        'GET /v1/harness/sessions/s1/plugins?limit=25'
    ]);
    expect(dialed.filter((line) => /^GET \/v1\/harness\/plugins/.test(line))).toEqual([]);

    // The head describes the catalogue, not the selected harness.
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(byClass('.harness-id', 'span').hidden).toBe(false);
    expect(byClass('.harness-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save for this conversation'
    );
    expect(byClass('.plugins-tab-title', 'h2').textContent).toBe('Plugins');
    // The pane's DESCRIPTIVE copy is gone (2026-11-13): the "Auto-scanned · tick to enable…"
    // paragraph (`.plugins-tab-hint`) and the count line that repeated the view head's own
    // subtitle (`.plugins-tab-note`) were deleted from main.ts, and their rules went with them
    // (pinned in compact-ui.test.ts). The head column is the bare `h2`, exactly like the Tools
    // pane's `toolsTabHead`.
    expect(document.querySelector('.plugins-tab-hint')).toBeNull();
    expect(document.querySelector('.plugins-tab-note')).toBeNull();
    expect(document.body.textContent).not.toContain('Auto-scanned · tick to enable');

    const head = byClass('.plugins-tab-head', 'div');

    expect([...head.children]).toEqual([byClass('.plugins-tab-title', 'h2')]);
    // NOTHING was lost by deleting the pane's count line: `pluginsCountNote` has one writer,
    // and the single surviving copy of that sentence is the `.harness-note` subtitle pinned
    // immediately above — the pane and the head could never have disagreed, and now they
    // cannot duplicate either.
    // The re-read control is the pane's FOOTER action now, not another line of the head copy:
    // `.plugins-tab-footer` is the LAST child `.plugins-pane` appends, so the button renders
    // AFTER the list and `.plugins-tab-footer`'s `justify-content: flex-end` (styles.css) puts
    // it in the bottom-right corner. The move RE-PARENTS the element — exactly one is in the
    // document, it is no longer inside `.plugins-tab-head`, and it is still the footer's ONLY
    // button. The enablement line joined that strip in front of it once the head lost its copy
    // (the head assertions above): a `<p>` of feedback, never a second control.
    const refresh = byClass('.plugins-refresh', 'button');
    const statusLine = byClass('.plugins-tab-status', 'p');
    const pane = byClass('.plugins-pane', 'div');
    const footer = byClass('.plugins-tab-footer', 'div');

    expect(refresh.textContent).toBe('Reload plugins');
    expect(document.querySelectorAll('.plugins-refresh')).toHaveLength(1);
    expect(refresh.closest('.plugins-tab-head')).toBeNull();
    expect(statusLine.parentElement).toBe(footer);
    // Sentence first, button LAST, so the right-most element of the strip stays the control.
    expect([...footer.children]).toEqual([statusLine, refresh]);
    expect(footer.querySelectorAll('button')).toHaveLength(1);
    expect(footer.lastElementChild).toBe(refresh);
    expect([...pane.children]).toEqual([head, byClass('.plugin-tab-list', 'div'), footer]);
    expect(pane.lastElementChild).toBe(footer);

    // Every shipped plugin is a row, in the page order the server sent.
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(texts('.plugin-tab-title')).toEqual(['Background Ping', 'Context Compaction', 'Quiet Observer']);

    // Title, registry name, description, hook count + settings badge, and the effective
    // settings line the Context Compaction request is about.
    const compaction = pluginRow('context-compaction');

    expect(compaction.querySelector('.plugin-tab-name')?.textContent).toBe('context-compaction');
    expect(compaction.querySelector('.plugin-tab-desc')?.textContent).toBe(compactionRow().description);
    expect(compaction.querySelector('.plugin-tab-meta')?.textContent).toBe('1 hook · 1 setting · built-in');
    expect(compaction.querySelector('.plugin-tab-values')?.textContent).toBe('contextLimit: 100000');
    expect(compaction.getAttribute('aria-haspopup')).toBe('dialog');
    expect(compaction.getAttribute('aria-pressed')).toBe('false');
    expect(compaction.disabled).toBe(false);

    expect(pluginRow('async-ping').querySelector('.plugin-tab-meta')?.textContent).toBe(
        '6 hooks · 1 setting · built-in'
    );
    expect(pluginRow('async-ping').querySelector('.plugin-tab-values')?.textContent).toBe('intervalMs: 600000');
    // R3: a settings-free built-in is labelled read-only in the LIST, not only in its dialog.
    expect(pluginRow('quiet-observer').querySelector('.plugin-tab-meta')?.textContent).toBe(
        '1 hook · read-only · built-in'
    );
    expect(pluginRow('quiet-observer').querySelector('.plugin-tab-values')?.textContent).toBe('no settings');

    // R2: every row carries its tick box BESIDE the trigger, in the wrapper's corner (the
    // row is a `.plugin-tab-row`: a `<button>` cannot contain a control). `enabled` is the
    // TOP-LEVEL row field, and quiet-observer is the row the server reports as OFF — its
    // settings map is empty, so a painter that read `values.enabled` would paint this row
    // on by accident.
    expect(pluginRow('context-compaction').parentElement?.className).toBe('plugin-tab-row');
    expect(pluginRow('context-compaction').nextElementSibling?.className).toBe('plugin-tab-enable is-on');
    expect(pluginRow('context-compaction').dataset.enabled).toBe('true');

    const compactionSwitch = pluginBox('context-compaction');

    // A real checkbox: `checked` is the state (no `role`, no `aria-checked`), the
    // accessible name is the ACTION, and the box sits OUTSIDE the tile so its click can
    // never open the dialog.
    expect(compactionSwitch.type).toBe('checkbox');
    expect(compactionSwitch.checked).toBe(true);
    expect(compactionSwitch.dataset.enabled).toBe('true');
    expect(compactionSwitch.getAttribute('role')).toBeNull();
    expect(compactionSwitch.getAttribute('aria-checked')).toBeNull();
    expect(compactionSwitch.getAttribute('aria-label')).toBe('Disable Context Compaction');
    expect(compactionSwitch.title).toBe(
        'Enabled for this conversation · click to switch context-compaction off'
    );
    expect(compactionSwitch.disabled).toBe(false);
    expect(compactionSwitch.closest('.plugin-tab-row')?.contains(compactionSwitch)).toBe(true);
    expect(compactionSwitch.closest('.plugin-tab-button')).toBeNull();

    // The OFF row states OFF, and no row is ever nested in another control.
    const quietSwitch = pluginBox('quiet-observer');

    expect(quietSwitch.checked).toBe(false);
    expect(quietSwitch.className).toBe('plugin-tab-enable is-off');
    expect(quietSwitch.getAttribute('aria-label')).toBe('Enable Quiet Observer');
    expect(pluginRow('quiet-observer').dataset.enabled).toBe('false');
    expect(document.querySelector('.plugin-tab-button .plugin-tab-button')).toBeNull();
    // One box per row, and nothing left of the pill it replaced.
    expect(document.querySelectorAll('.plugin-tab-enable')).toHaveLength(3);
    expect(document.querySelectorAll('.plugin-tab-toggle')).toHaveLength(0);

    // The composer and the agent control are hidden while the pane owns the column.
    expect(byClass('.composer', 'form').hidden).toBe(true);
    expect(byClass('.agent-slot', 'div').hidden).toBe(true);

    // Second press closes it, and the chat comes back whole.
    pluginsToggle().click();
    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);
    expect(byClass('.main-title', 'h1').textContent).toBe('Instruct');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);

    // Reopening paints from the cache: still exactly ONE catalogue read for the visit.
    openPlugins();
    await flush();

    expect(pluginNames()).toHaveLength(3);
    expect(pluginCountReads(dialed)).toBe(1);
});

it('keeps the plugins view and the tools view mutually exclusive in both directions', async () => {
    const { dialed } = stub();
    await boot();

    // Tools first.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();

    // Plugins wins the column and Tools reports closed: one centre view, one owner.
    openPlugins();
    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(toolsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(document.querySelector('.tool-tab-button')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.composer', 'form').hidden).toBe(true);

    // And the way back: Tools closes Plugins rather than stacking a second catalogue.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Tools Catalogue');

    // Closing Tools from its own toggle returns the chat, not the plugin pane.
    toolsToggle().click();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.main-title', 'h1').textContent).toBe('Instruct');

    // The whole dance cost one plugin read: the pane was opened once, and the tools view
    // never dialled it.
    expect(pluginCountReads(dialed)).toBe(1);
});

// --- the row tick box (R2) ---------------------------------------------------

it('switches a plugin off and back on with one click, and repaints the row from the server answer', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');
    const control = pluginBox('context-compaction');

    control.click();

    // In flight: the native box has flipped itself, the control is locked (one PATCH per
    // press), and it says so on itself.
    expect(control.checked).toBe(false);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-busy')).toBe('true');

    await flush();
    await flush();

    // Exactly one write, and it carries the reserved key as the whole settings map: the
    // framework accepts `enabled` for every plugin (../shared/harness-api.ts
    // `PluginSettingsUpdate`), and an omitted key is no change.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-compaction', method: 'PATCH', body: { settings: { enabled: false } } }
    ]);
    expect(dialed.filter((line) => line === 'PATCH /v1/harness/sessions/s1/plugins/context-compaction')).toHaveLength(1);

    // The answer IS the new state: the SAME nodes are repainted in place (the row stays
    // the trigger the dialog would hand focus back to), and the box now reads off — box,
    // `data-enabled` and the tile's green `--ok-line` edge move together, so a tick and a
    // green-edged row can never disagree.
    expect(pluginRow('context-compaction')).toBe(row);
    expect(row.dataset.enabled).toBe('false');
    expect(byClass('.plugin-tab-enable[data-plugin="context-compaction"]', 'input')).toBe(control);
    expect(control.className).toBe('plugin-tab-enable is-off');
    expect(control.checked).toBe(false);
    expect(control.dataset.enabled).toBe('false');
    expect(control.getAttribute('aria-label')).toBe('Enable Context Compaction');
    expect(control.disabled).toBe(false);
    expect(control.getAttribute('aria-busy')).toBe('false');

    // The switch line states the accepted figure, the COUNT line keeps counting, and the
    // other rows were not touched.
    expect(byClass('.plugins-tab-status', 'p').textContent).toBe(
        'Context Compaction is now disabled for this conversation.'
    );
    expect(byClass('.plugins-tab-status', 'p').hidden).toBe(false);
    expect(byClass('.plugins-tab-status', 'p').className).toBe('plugins-tab-status field-hint');
    // The count sentence survives ONLY in the view head subtitle now (the pane's own copy is
    // deleted), and an enablement write does not repaint the switch line away: the two
    // channels stay independent, exactly as they were when the pane carried its own line.
    expect(byClass('.harness-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save for this conversation'
    );
    expect(pluginRow('async-ping').dataset.enabled).toBe('true');
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // The cache took the answer, so a reopen shows the server's state and the visit still
    // costs exactly ONE catalogue read.
    row.click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(pluginCountReads(dialed)).toBe(1);

    // A second press inverts what the SERVER last reported, not what this list frame was
    // built from: the round trip goes back on.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'PATCH')[1]).toEqual({
        url: '/api/sessions/s1/plugins/context-compaction',
        method: 'PATCH',
        body: { settings: { enabled: true } }
    });
    expect(control.checked).toBe(true);
    expect(control.className).toBe('plugin-tab-enable is-on');
    expect(row.dataset.enabled).toBe('true');
});

it('states a refused switch with the server sentence and leaves the row exactly as the server has it', async () => {
    // The shipped row is enabled, and this refusal is the settings save's own shape: the
    // server's sentence verbatim, nothing reset, and the control re-armed.
    const message = 'context-compaction cannot be switched off while a run is held.';
    const { calls, dialed } = stub({ patchMessage: message, patchStatus: 403 });

    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');
    const control = pluginBox('context-compaction');

    control.click();
    // The native box flipped itself on the click. A refusal wrote nothing, so this is the
    // tick the repaint has to pull back.
    expect(control.checked).toBe(false);

    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-compaction', method: 'PATCH', body: { settings: { enabled: false } } }
    ]);

    // Nothing moved: the row and its box still state the figure the server has, and the
    // refusal is on the switch line, classed as a failure as well as coloured.
    expect(byClass('.plugins-tab-status', 'p').textContent).toBe(message);
    expect(byClass('.plugins-tab-status', 'p').className).toBe('plugins-tab-status plugins-tab-status-error');
    expect(control.checked).toBe(true);
    expect(control.className).toBe('plugin-tab-enable is-on');
    expect(control.dataset.enabled).toBe('true');
    expect(control.getAttribute('aria-label')).toBe('Disable Context Compaction');
    expect(control.disabled).toBe(false);
    expect(row.dataset.enabled).toBe('true');
    // The cache was not touched, so the head subtitle still describes the same three rows
    // (it is the only place that sentence renders since the pane's own copy was deleted).
    expect(byClass('.harness-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save for this conversation'
    );
    expect(byClass('.status-text', 'span').textContent).toBe('error');

    // And the failed write is not memoized: the next press dials again.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(pluginCountReads(dialed)).toBe(1);
});

// R2's click separation: the corner box and the tile are two controls in one row, and
// each owns exactly one action.
it('writes enablement from the corner box without opening the dialog, and the tile click still opens it', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    // The box is the tile's SIBLING, absolutely positioned over its corner (styles.css
    // `.plugin-tab-enable`), so a click on the box cannot reach the trigger's handler.
    expect(pluginBox('context-compaction').closest('button')).toBeNull();

    pluginBox('context-compaction').click();
    await flush();
    await flush();

    // The write went, and NO dialog layer was opened over the list.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-compaction', method: 'PATCH', body: { settings: { enabled: false } } }
    ]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(pluginBox('context-compaction').checked).toBe(false);
    expect(pluginRow('context-compaction').getAttribute('aria-pressed')).toBe('false');

    // The tile click is the other action: it opens the dialog and writes nothing.
    pluginRow('context-compaction').click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    byClass('.dialog-close', 'button').click();
    await flush();

    // The list came back with the server's figure on both readings, and the whole visit
    // still cost exactly one catalogue read.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(pluginBox('context-compaction').checked).toBe(false);
    expect(pluginRow('context-compaction').dataset.enabled).toBe('false');
    expect(pluginCountReads(dialed)).toBe(1);
});

// --- R1: the catalogues are always reachable ---------------------------------

it('keeps the plugins and tools pages, their rows and their switches usable while a run is pending', async () => {
    const { dialed } = stub({ running: true });
    await boot();
    await flush();

    // The conversation the shell opened on boot still holds work, so the shell IS in its
    // pending state — the state that used to hide both catalogues.
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');

    // The chat's OWN protection stays locked: the composer offers STOP for this conversation's
    // pending queue. The session surface is not locked any more — a run never blocks switching
    // or creating, because leaving a conversation only unsubscribes its observer (R4).
    expect(byClass('.new-session', 'button').disabled).toBe(false);
    expect(byClass('.session-cycle', 'button').disabled).toBe(false);

    // The two catalogue controls answer only to `booted`, and boot has answered.
    expect(pluginsToggle().disabled).toBe(false);
    expect(toolsToggle().disabled).toBe(false);

    openPlugins();
    await flush();

    // The pane took the centre column mid-run, with its rows and switches live.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(pluginRow('context-compaction').disabled).toBe(false);
    expect(pluginBox('context-compaction').disabled).toBe(false);

    // A row is clickable mid-run: its detail dialog opens over the list.
    pluginRow('context-compaction').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')?.isConnected).toBe(true);

    // And the global tick box WRITES mid-run — the server's route has no idle window, and
    // the answer repaints the row.
    pluginBox('context-compaction').click();
    await flush();
    await flush();

    expect(
        dialed.filter((line) => line === 'PATCH /v1/harness/sessions/s1/plugins/context-compaction')
    ).toHaveLength(1);
    expect(pluginBox('context-compaction').checked).toBe(false);

    // The other catalogue is reachable from here too: Tools closes Plugins (the exclusive
    // centre column survives R1), its rows are clickable and its tick box is live.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').disabled).toBe(false);

    const toolSwitch = byClass('.tool-tab-enable[data-tool="read"]', 'input');

    // T4: that row is THIS conversation's toolbox, and the server answers 409 for any session tool
    // write outside an idle window (src/server/api-session-tool-writes.ts), so EVERY tool switch is
    // locked while the conversation works — the opposite of the plugin tick boxes above it, whose
    // route has no idle gate and which stay live. The figure is still painted from the row, and the
    // row itself still opens its runner (execution stayed deployment-scoped).
    expect(toolSwitch.disabled).toBe(true);
    expect(toolSwitch.title).toBe('This conversation is working · the switch unlocks when its run ends');
    expect(toolSwitch.checked).toBe(true);

    // A tool row opens its runner mid-run as well.
    byClass('.tool-tab-button[data-tool="read"]', 'button').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    byClass('.dialog-close', 'button').click();
    await flush();
});

it('lets a pending run settle underneath the open plugins pane without disturbing it', async () => {
    // The live plane is the canonical `harness.v1` socket, so this case installs the shared
    // double (./view-test-support `installHarnessStream`) BEFORE the shell boots, and drives
    // the run's end with the same terminal `snapshot` frame the server sends when the queue
    // drains. That is the path R1 made reachable: the run completes while the plugin
    // catalogue owns the centre column, so every transcript painter runs against a pane that
    // is OFF the document.
    // The socket double is installed BEFORE the shell boots: `harnessStream()` caches the
    // client built from the first configured factory, so the shell must dial THIS socket
    // (main.test.ts:238-252). `host` is the one record both surfaces read, so the wire and
    // a REST re-read can never disagree about what the conversation is.
    const support = await import('./view-test-support');

    let host = runningSession() as unknown as SessionSnapshot;
    const live = support.installHarnessStream({
        sessionId: 's1',
        snapshot: () => host,
        record: () => host
    });

    const { settleRun } = stub({ running: true });

    await boot();
    await flush();

    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');

    openPlugins();
    await flush();

    const stage = byClass('.stage', 'div');

    expect(stage.querySelector('.plugins-pane')).not.toBeNull();
    // The transcript pane is OFF the document while the catalogue owns the column, which is
    // exactly the state the stream painters used never to see.
    expect(stage.querySelector('.log-wrap')).toBeNull();

    // The queue drains: the terminal snapshot frame lands with the pane still open. The
    // REST record moves with it (`settleRun`), which is what a `turn.removed`/re-read the
    // frame can trigger has to agree with.
    host = settledSession() as unknown as SessionSnapshot;
    settleRun();

    const frame: SessionStreamItem[] = [{ type: 'snapshot', session: host }];

    live.push(frame);

    await flush();
    await flush();

    // The run settled with the pane still on screen: nothing threw, nothing navigated, and
    // the catalogue kept its rows, its switches and its head.
    expect(byClass('.composer-action', 'button').dataset.action).not.toBe('stop');
    expect(stage.querySelector('.plugins-pane')?.isConnected).toBe(true);
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(byClass('.composer', 'form').hidden).toBe(true);

    // Back to the chat: the transcript was painted the whole time — the settled tile is
    // there, so the off-screen painters ran against the live document and did not throw.
    pluginsToggle().click();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.tile', 'article').dataset.state).toBe('done');
    expect(byClass('.composer', 'form').hidden).toBe(false);
});

// --- the detail dialog (R3) ---------------------------------------------------

it('opens the Context Compaction dialog with the declared hooks and a numeric limit', async () => {
    stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');

    row.click();

    // The shared modal, named after the plugin's own title.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog', 'div').getAttribute('role')).toBe('dialog');
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    expect(row.getAttribute('aria-pressed')).toBe('true');

    // Identity facts plus the declared hooks: existing metadata only.
    expect(byClass('.plugin-detail-description', 'p').textContent).toBe(compactionRow().description);
    expect(texts('.plugin-detail-fact')).toEqual([
        'context-compaction',
        'v1.0.0',
        'built-in',
        'tags: context, compaction, lifecycle'
    ]);
    expect(texts('.plugin-hook-chip')).toEqual(['turn.before']);

    // The read-only system prompt (2026-11-12): ONE new section, between the hooks and the
    // settings, and only because THIS row carries `system_prompt`.
    expect(texts('.plugin-detail-section-title')).toEqual(['Hooks', 'System prompt', 'Settings']);

    // A `<p>`, never a `<pre>`: ui/dialog.css `.dialog-body pre { white-space: pre }`
    // (specificity 0,1,1) would force the prompt onto one un-wrapped line and scroll it out
    // of the dialog. The newlines are part of the VALUE and must survive verbatim — the
    // pane writes it through `textContent`, so markup in a plugin's prompt stays inert.
    const prompt = byClass('.plugin-detail-prompt', 'p');

    expect(prompt.tagName).toBe('P');
    expect(prompt.textContent).toBe(compactionRow().system_prompt);
    expect(prompt.textContent).toContain('\n');

    // Position is part of the request: the prompt belongs to the plugin's identity facts,
    // so it reads AFTER the hooks and BEFORE the switches, and the body's child order is
    // exactly that (nothing else moved).
    const promptSection = byClass('.plugin-detail-prompt-section', 'div');

    expect(promptSection.contains(prompt)).toBe(true);
    expect([...(promptSection.parentElement?.children ?? [])].map((node) => node.className)).toEqual([
        'plugin-detail-description',
        'plugin-detail-facts',
        'plugin-detail-hooks',
        'plugin-detail-prompt-section',
        'plugin-detail-settings'
    ]);
    // No control, no affordance: the section is prose an operator reads, not something the
    // pane can edit, and the plugin row's own write surface is untouched.
    expect(promptSection.querySelectorAll('button, input')).toHaveLength(0);

    // The head names the plugin whose layer is open — the contract the tool runner has.
    expect(byClass('.main-title', 'h1').textContent).toBe('Context Compaction');
    expect(byClass('.harness-id', 'span').textContent).toBe('context-compaction');
    expect(byClass('.harness-note', 'p').textContent).toBe('v1.0.0 · 1 hook · 1 setting · built-in');

    // R3: the editable figure. A number box holding the effective value, with the shipped
    // floor (1000) and cadence (1000) as the declared hints; the manifest states no ceiling.
    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    expect(input.type).toBe('number');
    expect(input.value).toBe('100000');
    expect(input.min).toBe('1000');
    expect(input.step).toBe('1000');
    expect(input.getAttribute('max')).toBeNull();
    expect(input.id).toBe('plugin-setting-context-compaction-contextLimit');
    expect(input.disabled).toBe(false);

    const label = byClass('.plugin-setting-label', 'label');

    expect(label.textContent).toBe('Context limit (tokens)');
    expect(label.htmlFor).toBe(input.id);
    expect(byClass('.plugin-setting-hint', 'p').textContent).toBe(compactionRow().settings[0]?.description);

    // The write control is always live: it exists, it is ENABLED on the first frame, and a
    // press with nothing changed sends nothing (pinned by its own test below).
    expect(byClass('.plugin-setting-save', 'button').textContent).toBe('Save');
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('');

    // Escape dismisses the layer, resets the row, re-describes the catalogue, and hands
    // focus back to the row that opened it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.dialog')).toBeNull();
    expect(row.getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(document.activeElement).toBe(row);
    // The list stayed on the stage the whole time: one modal over one list.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')?.isConnected).toBe(true);
});

it('saves only the changed key, repaints from the server row, and reopens with the saved figure', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');

    row.click();

    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    input.value = '150000';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // The control is enabled before the press AND while the write is in flight: the handler's
    // own `saving` guard is what keeps a double press from sending the patch twice, not a
    // greyed-out button.
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    byClass('.plugin-setting-save', 'button').click();

    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saving…');

    await flush();
    await flush();

    // Exactly one write, and it carries ONLY the changed key: an omitted key is documented
    // as "no change" (../shared/harness-api.ts `PluginSettingsUpdate`), so untouched
    // settings are never rewritten by an unrelated save.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-compaction', method: 'PATCH', body: { settings: { contextLimit: 150000 } } }
    ]);
    expect(
        dialed.filter((line) => line === 'PATCH /v1/harness/sessions/s1/plugins/context-compaction')
    ).toHaveLength(1);

    // The answer IS the new state: the form takes the server's figure, the row's settings
    // line moves with it, and the dialog says so.
    expect(input.value).toBe('150000');
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(byClass('.plugin-setting-status', 'p').className).toBe('plugin-setting-status field-hint');
    // Still pressable: the form now holds the server's own figures, so the next press would
    // send nothing at all — the control does not grey itself out to say so.
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    expect(pluginRow('context-compaction').querySelector('.plugin-tab-values')?.textContent).toBe(
        'contextLimit: 150000'
    );
    // The row button was repainted in place, so it is still the SAME node — a rebuilt list
    // would replace the trigger the dialog hands focus back to.
    expect(pluginRow('context-compaction')).toBe(row);
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // Close and reopen: the merged cache row is what the form shows, so a reopen answers
    // 150000 with NO extra traffic.
    byClass('.dialog-close', 'button').click();
    pluginRow('context-compaction').click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    expect(byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input').value).toBe('150000');
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    expect(pluginCountReads(dialed)).toBe(1);
});

it('keeps Save pressable and sends nothing when no setting changed', async () => {
    // The control is never disabled, so "there is nothing to write" has to be a no-op in the
    // handler rather than a greyed-out button. Two reasons the no-op is the right shape: the
    // server REFUSES an empty settings patch (`400` — "A plugin settings patch must change at
    // least one setting", ../server/plugins.ts:545-553), and sending EVERY field instead
    // would pin each untouched default as an explicit stored override.
    const { calls, dialed } = stub();

    await boot();
    openPlugins();
    await flush();

    pluginRow('context-compaction').click();

    const save = byClass('.plugin-setting-save', 'button');

    expect(save.disabled).toBe(false);

    save.click();
    await flush();

    // Nothing changed, so nothing left the browser: no write, no second catalogue read, and
    // no invented success line — the status stays empty because nothing happened.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(dialed.filter((line) => line.startsWith('PATCH'))).toEqual([]);
    expect(pluginCountReads(dialed)).toBe(1);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('');
    expect(save.disabled).toBe(false);

    // The very same control writes the moment a figure differs from the server's.
    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    input.value = '120000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    save.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-compaction', method: 'PATCH', body: { settings: { contextLimit: 120000 } } }
    ]);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(save.disabled).toBe(false);
    expect(pluginCountReads(dialed)).toBe(1);
});

it('keeps the typed value editable and states the server refusal verbatim', async () => {
    // The server validator's own sentence (a value under the declared `min`).
    const message = 'contextLimit must be at least 1000.';
    const { calls, dialed } = stub({ patchMessage: message, patchStatus: 400 });

    await boot();
    openPlugins();
    await flush();

    pluginRow('context-compaction').click();

    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    // The refusal is the server's text, not a client guess, and it is marked as a failure
    // by class as well as by colour.
    const status = byClass('.plugin-setting-status', 'p');

    expect(status.textContent).toBe(message);
    expect(status.className).toBe('plugin-setting-status plugin-setting-status-error');

    // Nothing was reset: the reader fixes the number they typed, and the control was never
    // taken away in the first place.
    expect(input.value).toBe('500');
    expect(input.disabled).toBe(false);
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);

    // The cache is untouched, so the list still states the last figure the server had.
    expect(pluginRow('context-compaction').querySelector('.plugin-tab-values')?.textContent).toBe(
        'contextLimit: 100000'
    );
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(pluginCountReads(dialed)).toBe(1);

    // The topbar pill reports the failed config write, and the form is still on screen.
    expect(byClass('.status-text', 'span').textContent).toBe('error');
    expect(document.querySelector('.dialog')).not.toBeNull();
});

it('renders a plugin with no declared settings read-only, with no write control', async () => {
    const { calls } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('quiet-observer');

    expect(row.querySelector('.plugin-tab-values')?.textContent).toBe('no settings');

    row.click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Quiet Observer');
    // No control and no Save: an action that could only ever send an empty patch.
    expect(document.querySelectorAll('.dialog .plugin-setting-input')).toHaveLength(0);
    expect(document.querySelector('.dialog .plugin-setting-save')).toBeNull();
    expect(document.querySelector('.dialog .plugin-settings-form')).toBeNull();
    expect(texts('.dialog .plugin-detail-empty')).toEqual(['This plugin declares no settings · read-only.']);
    // The declared hooks still render: read-only covers SETTINGS, not the facts.
    expect(texts('.plugin-hook-chip')).toEqual(['turn.after']);
    // 2026-11-12: a row WITHOUT `system_prompt` renders exactly the sections it rendered
    // before the field existed — no empty section, no empty box. This is the byte-identical
    // claim for every plugin that never prompts.
    expect(texts('.dialog .plugin-detail-section-title')).toEqual(['Hooks', 'Settings']);
    expect(document.querySelector('.dialog .plugin-detail-prompt')).toBeNull();
    expect(document.querySelector('.dialog .plugin-detail-prompt-section')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Quiet Observer');
    expect(byClass('.harness-note', 'p').textContent).toBe('v0.2.0 · 1 hook · read-only · built-in');

    byClass('.dialog-close', 'button').click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
});

it('renders no System prompt section for a row whose declared prompt is empty', async () => {
    // The 2026-11-12 edge the contract declares but never enforces: `system_prompt` carries
    // `minLength: 1` (src/server/harness.swagger.yaml `PluginSummary`), yet src/server/api.ts
    // `pluginRowOf` projects whatever the plugin declared, so an empty string CAN reach the
    // pane. main.ts therefore gates the section on NON-EMPTY, and this pins that a blank prompt
    // reads as "no prompt declared" — no `System prompt` heading over an empty <p>.
    // Same shipped row, settings and all, with only the prompt blanked: everything else the
    // field's presence bought has to survive unchanged.
    stub({ rows: () => [{ ...compactionRow(), system_prompt: '' }] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-compaction').click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    // The two sections of a row that never prompts — nothing empty-shaped between them.
    expect(texts('.dialog .plugin-detail-section-title')).toEqual(['Hooks', 'Settings']);
    expect(document.querySelector('.dialog .plugin-detail-prompt')).toBeNull();
    expect(document.querySelector('.dialog .plugin-detail-prompt-section')).toBeNull();
    // The prose and the editor are untouched by the blank value.
    expect(byClass('.plugin-detail-description', 'p').textContent).toBe(compactionRow().description);
    expect(byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input').value).toBe('100000');
});

it('renders each declared setting as its own control and sends only the changed one', async () => {
    // The shipped set declares numbers only, so the boolean/string branches are pinned
    // against a row that declares both types.
    const { calls } = stub({ rows: () => [mixedRow()] });
    await boot();
    openPlugins();
    await flush();

    expect(pluginNames()).toEqual(['extras']);
    pluginRow('extras').click();

    const verbose = byClass('.plugin-setting-input[data-setting="verbose"]', 'input');
    const prefix = byClass('.plugin-setting-input[data-setting="prefix"]', 'input');

    expect(verbose.type).toBe('checkbox');
    expect(verbose.checked).toBe(false);
    expect(prefix.type).toBe('text');
    expect(prefix.value).toBe('run');
    expect(texts('.plugin-setting-label')).toEqual(['Verbose logging', 'Log prefix']);
    expect(texts('.plugin-setting-hint')).toEqual(['Prefix every line this plugin writes.']);

    verbose.checked = true;
    verbose.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    // The checkbox became `true` and the untouched text setting is NOT in the patch.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/extras', method: 'PATCH', body: { settings: { verbose: true } } }
    ]);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(byClass('.plugin-setting-input[data-setting="verbose"]', 'input').checked).toBe(true);
    expect(byClass('.plugin-setting-input[data-setting="prefix"]', 'input').value).toBe('run');
    expect(pluginRow('extras').querySelector('.plugin-tab-values')?.textContent).toBe(
        'verbose: true · prefix: run'
    );
});

it('replaces the open detail when another row is activated instead of stacking a second dialog', async () => {
    stub();
    await boot();
    openPlugins();
    await flush();

    const compaction = pluginRow('context-compaction');
    const ping = pluginRow('async-ping');

    compaction.click();
    ping.click();

    // One layer, and it describes the row that was pressed LAST (the catalogue's own
    // replacement rule, the same one the tool runner follows).
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Background Ping');

    // 2026-11-12: the `async-ping` row above IS the shipped row (its figures come from
    // src/plugins/async-ping.plugin.ts), and it declares no prompt — so this dialog, which
    // REPLACED the compaction one, still renders exactly the two sections it rendered before
    // `system_prompt` existed. "Panels without the field are unchanged", pinned on a real
    // shipped plugin and not only on the synthetic read-only row further up.
    expect(texts('.dialog .plugin-detail-section-title')).toEqual(['Hooks', 'Settings']);
    expect(document.querySelector('.dialog .plugin-detail-prompt-section')).toBeNull();
    expect(document.querySelector('.dialog .plugin-detail-prompt')).toBeNull();

    expect(compaction.getAttribute('aria-pressed')).toBe('false');
    expect(ping.getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.main-title', 'h1').textContent).toBe('Background Ping');
    expect(byClass('.harness-note', 'p').textContent).toBe('v1.0.0 · 6 hooks · 1 setting · built-in');

    // Dismissing the replacement lands on the row that opened it, and the head returns to
    // the catalogue.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(ping.getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(document.activeElement).toBe(ping);
});

it('leaves the plugins pane when the reader selects another harness', async () => {
    // Two harnesses, so the switch is a real selection and not a repaint of the same one. And the
    // second harness has a conversation of its own (s2): T4 hides BOTH configuration toggles for a
    // harness with no conversation, so without s2 the second half of this test would have no pane
    // to re-enter.
    const { dialed } = stub({
        presets: [descriptor(), descriptor({ name: 'research', title: 'Research', agents: ['research'], primary: 'research' })],
        extraSessions: [researchSession()]
    });

    await boot();

    openPlugins();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(pluginCountReads(dialed)).toBe(1);

    const rows = document.querySelectorAll<HTMLElement>('.harness-item');

    expect(rows).toHaveLength(2);
    rows[1]?.click();
    await flush();

    // The chat owns the column again, with the NEW harness's head, and the toggle reports
    // the closed view (`selectHarness` closes every catalogue).
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Research');
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);

    // The moved card points at ANOTHER conversation (s2, the one `research` owns), and the pane's
    // rows belong to a conversation — they are no longer a server-wide cache. So re-entering pays
    // a SECOND read, dialled under s2, and paints the rows that read returned.
    openPlugins();

    // The frame BEFORE the answer is the proof the cache went with the conversation: the pane
    // re-opens on its loading line with NO rows at all, never with s1's three still on screen.
    expect(byClass('.plugins-loading', 'p').textContent).toBe('Reading the plugin catalogue…');
    expect(pluginNames()).toEqual([]);

    await flush();

    expect(pluginNames()).toHaveLength(3);
    expect(pluginCountReads(dialed)).toBe(2);
    expect(dialed.filter((line) => line === 'GET /v1/harness/sessions/s2/plugins?limit=25')).toHaveLength(1);
});

// --- the read failure, the retry, and the refresh ----------------------------

it('states a failed catalogue read with the server sentence and reloads on Retry', async () => {
    const message = 'The plugin service is not responding.';
    const { calls, dialed } = stub({ readFailures: 1, readMessage: message });

    await boot();
    openPlugins();
    await flush();

    // A failure is a real state: the server's own sentence plus the one action that can
    // fix it, and no rows pretending the read succeeded. The sentence is stated TWICE on
    // purpose and nowhere else — inside the list (`.plugins-error`, the one place the pane
    // body speaks for itself) and in the view head subtitle. The pane's old third copy
    // (`.plugins-tab-note`) is gone with the rest of the pane's descriptive copy.
    expect(byClass('.plugins-error', 'p').textContent).toBe(message);
    expect(document.querySelector('.plugins-tab-note')).toBeNull();
    expect(byClass('.harness-note', 'p').textContent).toBe(
        `The plugin catalogue could not be read: ${message}`
    );
    expect(byClass('.plugins-retry', 'button').textContent).toBe('Retry');
    expect(pluginNames()).toEqual([]);

    // A failed read is NOT cached: Retry re-dials, and the rows land this time. (The
    // fixture epoch bump is the double's own "the record moved" signal.)
    bumpFixtureEpoch();
    byClass('.plugins-retry', 'button').click();
    await flush();
    await flush();

    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    // The head subtitle moved back to the loaded figure with the retry — the one writer
    // (`pluginsCountNote` → `paintPluginsHead`) is what makes that recovery automatic now
    // that the pane carries no copy of its own.
    expect(byClass('.harness-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save for this conversation'
    );
    expect(document.querySelector('.plugins-error')).toBeNull();
    expect(calls.filter((call) => call.url === '/api/sessions/s1/plugins?limit=25')).toHaveLength(2);
    expect(pluginCountReads(dialed)).toBe(2);
});

it('re-reads the catalogue from the pane control instead of trusting the cache', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    expect(pluginCountReads(dialed)).toBe(1);

    bumpFixtureEpoch();
    byClass('.plugins-refresh', 'button').click();
    await flush();
    await flush();

    // The explicit refresh is the only way a second read leaves the browser, and the rows
    // are repainted from the fresh page (still wired afterwards).
    expect(pluginCountReads(dialed)).toBe(2);
    expect(calls.filter((call) => call.url === '/api/sessions/s1/plugins?limit=25')).toHaveLength(2);
    expect(pluginNames()).toHaveLength(3);

    pluginRow('context-compaction').click();
    expect(byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input').value).toBe('100000');
});

// --- the grouped and gated settings form (T5/R3, 2026-11-13) ----------------

it('draws each declared group as a titled block with its gated settings nested under their own tick', async () => {
    stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    // The manifest order the renderer must NOT reorder at the top level, and the one case
    // it must reorder inside a block: `truncateTurns` is declared BEFORE the switch that
    // gates it, and the tree below shows it rendered UNDER that switch.
    expect(trimmerRow().settings.map((setting) => setting.key)).toEqual([
        'enabled',
        'trimInvalidTools',
        'invalidToolTurns',
        'invalidOutcomes',
        'trimThoughts',
        'thoughtTurns',
        'truncateTurns',
        'truncateToolRequests'
    ]);

    // The whole form, as one exact structure. Read it as the operator does: one ungrouped
    // row (`enabled`) at the root, then three blocks, each a caption plus its rows, with
    // every dependent setting inside that parent's own indented host.
    expect(settingsFormTree()).toEqual([
        'plugin-settings-form-label',
        'enabled',
        [
            ['Invalid tool calls', 'trimInvalidTools', ['children:trimInvalidTools', 'invalidToolTurns', 'invalidOutcomes']],
            ['Recorded thinking', 'trimThoughts', ['children:trimThoughts', 'thoughtTurns']],
            ['Truncate requests', 'truncateToolRequests', ['children:truncateToolRequests', 'truncateTurns']]
        ]
    ]);

    // The captions are the block headings IN ORDER, and nothing else in the dialog took the
    // caption class — `Settings` is still the `h3` above, which the test below pins.
    expect(texts('.dialog .plugin-setting-group-title')).toEqual([
        'Invalid tool calls',
        'Recorded thinking',
        'Truncate requests'
    ]);
    expect(texts('.dialog .plugin-detail-section-title')).toEqual(['Hooks', 'Settings']);

    // Each block is a real `role="group"` whose accessible name is the VISIBLE caption:
    // `aria-labelledby` names that caption's own id, and the caption is the block's first
    // child, so a screen reader and a sighted reader get the same words in the same order.
    expect(
        [...document.querySelectorAll<HTMLElement>('.dialog .plugin-settings-group')].map((block) => {
            const title = block.querySelector('.plugin-setting-group-title');

            return [
                block.getAttribute('role'),
                block.getAttribute('aria-labelledby'),
                title?.id,
                title?.tagName,
                block.firstElementChild === title
            ];
        })
    ).toEqual([
        ['group', 'plugin-setting-group-context-trimmer-invalid-0', 'plugin-setting-group-context-trimmer-invalid-0', 'H4', true],
        ['group', 'plugin-setting-group-context-trimmer-thoughts-1', 'plugin-setting-group-context-trimmer-thoughts-1', 'H4', true],
        ['group', 'plugin-setting-group-context-trimmer-truncate-2', 'plugin-setting-group-context-trimmer-truncate-2', 'H4', true]
    ]);

    // A gated row keeps the SAME anatomy as any other row — real `<label for>`, control,
    // hint under it — so nesting is placement, not a second kind of field, and the save
    // handler's `input[data-setting]` walk is untouched.
    const horizon = byClass('.plugin-setting-input[data-setting="invalidToolTurns"]', 'input');

    expect(horizon.type).toBe('number');
    expect(horizon.value).toBe('2');
    expect(horizon.min).toBe('0');
    expect(horizon.max).toBe('4096');
    expect(settingRow('invalidToolTurns').querySelector('label')?.htmlFor).toBe(horizon.id);

    // Seeded visibility, taken from the VALUES on the row and not from a click: the ON
    // parent shows both of its children (a number AND a string), the OFF parent hides its
    // one child, and the flat master row is never hidden.
    expect(hiddenSettingKeys()).toEqual(['thoughtTurns']);
});

it('reveals a gated setting the same turn its parent tick is pressed, and hides it again', async () => {
    const { calls } = stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    // `trimThoughts` is OFF on the row the server sent, so its horizon starts gone.
    expect(settingRow('thoughtTurns').hidden).toBe(true);

    // One press, and the dependent row is there in the SAME turn — no re-open, no re-read,
    // no second dialog, and the control arrives holding its own effective value.
    tickOf('trimThoughts');

    expect(settingRow('thoughtTurns').hidden).toBe(false);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.plugin-setting-input[data-setting="thoughtTurns"]', 'input').value).toBe('2');
    expect(hiddenSettingKeys()).toEqual([]);

    // Pressing it back off takes the row away again — and it takes the row, not the control:
    // the input is still in the form, still holding 2, which is what keeps it savable.
    tickOf('trimThoughts');

    expect(settingRow('thoughtTurns').hidden).toBe(true);
    expect(byClass('.plugin-setting-input[data-setting="thoughtTurns"]', 'input').value).toBe('2');
    expect(hiddenSettingKeys()).toEqual(['thoughtTurns']);

    // A parent with TWO children gates both of them, whatever their types — the number
    // horizon and the string outcome list move together with one tick.
    tickOf('trimInvalidTools');

    expect(hiddenSettingKeys()).toEqual(['invalidToolTurns', 'invalidOutcomes', 'thoughtTurns']);

    tickOf('trimInvalidTools');

    expect(hiddenSettingKeys()).toEqual(['thoughtTurns']);

    // Toggling a policy is not a write: the form only sends what the reader Saves.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
});

it('keeps a hidden setting registered and savable, and re-takes the reveal from the saved row', async () => {
    const { calls } = stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    // The row is hidden by its OFF parent, and the value on it is still editable.
    expect(settingRow('thoughtTurns').hidden).toBe(true);

    const horizon = byClass('.plugin-setting-input[data-setting="thoughtTurns"]', 'input');

    horizon.value = '7';
    horizon.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    // Hiding a dependent row does not drop it from the write: `thoughtTurns` is in the patch
    // on its own, and nothing else rode along with it.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-trimmer', method: 'PATCH', body: { settings: { thoughtTurns: 7 } } }
    ]);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(byClass('.plugin-setting-input[data-setting="thoughtTurns"]', 'input').value).toBe('7');

    // And the reveal is re-taken from the SERVER's answer after the save: the parent is still
    // OFF, so the row is still hidden — `paintValues` writes `checked` programmatically, which
    // fires no event, so an explicit re-paint is the only thing that can keep the two honest.
    expect(settingRow('thoughtTurns').hidden).toBe(true);
});

// --- the gate fixes (D3/D4/D5/D6, 2026-11-13) --------------------------------

// The `--off` mark and the host/hidden pair in one place, stated as DATA. A host's `hidden` is
// the D3 claim, and the master switch's mark is the D1/D2 claim — both are attributes jsdom CAN
// observe; the layout they produce (no dead gap, no dimmed control) cannot be measured here and
// is pinned as stylesheet text in the CSS contract test below.
const hostState = (): unknown[] =>
    [...document.querySelectorAll<HTMLElement>('.dialog .plugin-setting-children')].map((host) => [host.dataset.parent, host.hidden]);

it('hides the indent host itself once every row inside it is hidden, leaving no dead gap', async () => {
    stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    // Seeded state, from the VALUES on the server's row: two parents are ON, so their hosts are
    // shown, and `trimThoughts` is OFF with its one child hidden — so that host hides itself.
    expect(hostState()).toEqual([
        ['trimInvalidTools', false],
        ['trimThoughts', true],
        ['truncateToolRequests', false]
    ]);

    // Hiding the LAST visible row of a branch hides the branch. A 0-height host is still a flex
    // ITEM inside the `gap: 8px` column of `.plugin-settings-group`, so a host that only holds
    // hidden rows used to leave ~8px of dead rail under its parent — and `.plugin-setting-
    // children:empty` can never match, because hidden rows are still DOM children.
    tickOf('trimInvalidTools');

    expect(hiddenSettingKeys()).toEqual(['invalidToolTurns', 'invalidOutcomes', 'thoughtTurns']);
    expect(hostState()).toEqual([
        ['trimInvalidTools', true],
        ['trimThoughts', true],
        ['truncateToolRequests', false]
    ]);

    // ONE visible child is enough to keep an indent on screen: the tally is over the gated rows of
    // that host, not over every row of the block.
    tickOf('trimThoughts');

    expect(hostState()).toEqual([
        ['trimInvalidTools', true],
        ['trimThoughts', false],
        ['truncateToolRequests', false]
    ]);

    tickOf('trimInvalidTools');

    expect(hostState()).toEqual([
        ['trimInvalidTools', false],
        ['trimThoughts', false],
        ['truncateToolRequests', false]
    ]);

    // The master switch is a DIM and never a hide: switching the plugin off marks the ONE wrapper
    // element and takes nothing out of the tree — no row, no host, no block.
    tickOf('enabled');

    expect(byClass('.plugin-settings-groups', 'div').classList.contains('plugin-settings-groups--off')).toBe(true);
    expect(hostState()).toEqual([
        ['trimInvalidTools', false],
        ['trimThoughts', false],
        ['truncateToolRequests', false]
    ]);
    expect([...document.querySelectorAll<HTMLElement>('.dialog .plugin-settings-group')].map((block) => block.hidden)).toEqual([
        false,
        false,
        false
    ]);
});

it('keeps a nested reveal inside its own block when a gated setting is itself a parent', async () => {
    stub({ rows: () => [nestedRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('nested-gates').click();

    // The whole form, exactly. The load-bearing entry is `['children:middle','innerTurns']`
    // INSIDE `['children:outer', …]`: the grandchild sits immediately after its own parent row, in
    // that parent's indent, which sits in the block that declares it. Before the fix the gated
    // branch never registered the row it emitted, so that nested host stayed detached and the
    // closing flush appended it — and the row with it — to the FORM ROOT, outside the block and
    // outside the indent.
    const expectedTree = [
        'plugin-settings-form-label',
        [['One block', 'outer', ['children:outer', 'middleTurns', 'middle', ['children:middle', 'innerTurns']], 'tail']]
    ];

    expect(settingsFormTree()).toEqual(expectedTree);

    // The same claim in DOM terms: three levels of ancestry from the grandchild's row lead to the
    // block, and the form's own children are only the sr-only name and the wrapper — every setting
    // of this manifest is grouped, so there is no flat row at the root and, above all, no stray
    // indent host appended there.
    const block = byClass('.dialog .plugin-settings-group', 'div');

    expect(settingRow('innerTurns').closest('.plugin-settings-group')).toBe(block);
    expect(settingRow('innerTurns').parentElement).toBe(childHostOf('middle'));
    expect(childHostOf('middle').parentElement).toBe(childHostOf('outer'));
    expect([...byClass('.plugin-settings-form', 'div').children].map((node) => node.className)).toEqual([
        'plugin-settings-form-label',
        'plugin-settings-groups'
    ]);

    // Both switches are ON on the row the server sent, so nothing is hidden anywhere and the
    // grandchild holds its own seeded figure.
    expect(hiddenSettingKeys()).toEqual([]);
    expect([childHostOf('outer').hidden, childHostOf('middle').hidden]).toEqual([false, false]);
    expect(byClass('.plugin-setting-input[data-setting="innerTurns"]', 'input').value).toBe('5');

    // The grandchild answers to its OWN parent, and only to it: `middle` off takes `innerTurns`
    // away and hides its own host, while the outer branch stays open because it still shows
    // `middleTurns`.
    tickOf('middle');

    expect(hiddenSettingKeys()).toEqual(['innerTurns']);
    expect(childHostOf('middle').hidden).toBe(true);
    expect(childHostOf('outer').hidden).toBe(false);
    expect(settingRow('middleTurns').hidden).toBe(false);

    // Back on: the same row, in the same host — a reveal changes visibility, never placement.
    tickOf('middle');

    expect(hiddenSettingKeys()).toEqual([]);
    expect(settingRow('innerTurns').parentElement).toBe(childHostOf('middle'));

    // `outer` off collapses the WHOLE branch: the two rows it gates carry `hidden`, its host
    // carries `hidden` (D3), and the nested host goes with it, because `display: none` on an
    // ancestor takes the subtree out of the render tree. jsdom evaluates no cascade, so what this
    // pins is the attribute on the host plus the fact that the grandchild's OWN flag never moved
    // — it is hidden by the collapsed branch, not by its own gate.
    tickOf('outer');

    expect(hiddenSettingKeys()).toEqual(['middleTurns', 'middle']);
    expect(childHostOf('outer').hidden).toBe(true);
    expect(settingRow('innerTurns').hidden).toBe(false);

    // And the branch reopens exactly where it was.
    tickOf('outer');

    expect(hiddenSettingKeys()).toEqual([]);
    expect(childHostOf('outer').hidden).toBe(false);
    expect(settingsFormTree()).toEqual(expectedTree);
});

it('shows a child gated by a non-boolean setting exactly like one gated by nothing', async () => {
    const { calls } = stub({ rows: () => [wrongGateRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('wrong-gate').click();

    // Both children are SHOWN. `underLimit`'s `parentKey` names a NUMBER setting, and a number box
    // has no `checked`: reading `undefined !== true` used to decide that gate, so the row hid
    // forever with no tick anywhere that could bring it back — while a `parentKey` naming nothing
    // already rendered its child shown. A wrong-typed gate now means the same no-gate does.
    expect(hiddenSettingKeys()).toEqual([]);
    expect([settingRow('underLimit').hidden, settingRow('underGhost').hidden]).toEqual([false, false]);

    // Placement is not what the fix touched, and it stays legible in the DOM: a wrong-typed parent
    // keeps its own indent host under its row, and a dangling one is flushed to the form root so
    // its row can never be edited out of sight.
    expect(settingsFormTree()).toEqual(['plugin-settings-form-label', 'limit', ['children:limit', 'underLimit'], ['children:ghost', 'underGhost']]);

    // Editing the number box the `parentKey` names cannot hide the child either: that key IS a
    // trigger, so `paintGates` really does run on its `input` event — and the answer stays SHOWN.
    const limit = byClass('.plugin-setting-input[data-setting="limit"]', 'input');

    limit.value = '7';
    limit.dispatchEvent(new Event('input', { bubbles: true }));

    expect(hiddenSettingKeys()).toEqual([]);
    expect([settingRow('underLimit').hidden, settingRow('underGhost').hidden]).toEqual([false, false]);

    // And both rows stay registered and savable, which is the entire reason they are rendered.
    const orphan = byClass('.plugin-setting-input[data-setting="underGhost"]', 'input');

    orphan.value = '3';
    orphan.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/wrong-gate', method: 'PATCH', body: { settings: { limit: 7, underGhost: 3 } } }
    ]);
});

it('reveals and focuses the hidden row whose value Save refuses, and still sends nothing', async () => {
    const { calls } = stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    // The refusal case D4 is about: the row is off screen because its own tick is OFF, and the
    // number box inside it is emptied.
    const horizon = byClass('.plugin-setting-input[data-setting="thoughtTurns"]', 'input');

    expect(settingRow('thoughtTurns').hidden).toBe(true);
    horizon.value = '';
    horizon.dispatchEvent(new Event('input', { bubbles: true }));

    byClass('.plugin-setting-save', 'button').click();
    await flush();

    // The SAME sentence, word for word — and it now names a row the reader can look at, with the
    // cursor already in the box to fix.
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Trim after (thought entries) needs a number.');
    expect(settingRow('thoughtTurns').hidden).toBe(false);
    expect(document.activeElement).toBe(horizon);

    // Revealing is all that happened: the gate that was hiding the row is ticked (that is what
    // revealing MEANS), the typed text is still in the box, and nothing was coerced to 0, dropped
    // or written.
    expect(byClass('.plugin-setting-input[data-setting="trimThoughts"]', 'input').checked).toBe(true);
    expect(horizon.value).toBe('');
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);

    // Fixing the box and Saving again writes, and the patch carries the tick the reveal turned on
    // along with the value — the honest consequence of revealing a gate, pinned so nobody
    // "restores" the old behaviour by hiding the row again behind the reader's back.
    horizon.value = '9';
    horizon.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/plugins/context-trimmer', method: 'PATCH', body: { settings: { trimThoughts: true, thoughtTurns: 9 } } }
    ]);
});

it('dims the declared blocks while the plugin switch is off without hiding anything', async () => {
    stub({ rows: () => [trimmerRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-trimmer').click();

    const groups = byClass('.plugin-settings-groups', 'div');

    expect(groups.className).toBe('plugin-settings-groups');

    // The plugin's own `enabled` row is a setting like any other, so the dialog can read the
    // master state off it. Switching it off marks the ONE wrapper element.
    tickOf('enabled');

    expect(groups.className).toBe('plugin-settings-groups plugin-settings-groups--off');

    // NOTHING is hidden by the master switch: every block, every caption and every control is
    // still on screen, so an operator can set the policy up and switch the plugin back on
    // without reopening anything. The only hidden row is still the one its own tick hides.
    expect([...document.querySelectorAll<HTMLElement>('.dialog .plugin-settings-group')].map((block) => block.hidden)).toEqual([
        false,
        false,
        false
    ]);
    expect(texts('.dialog .plugin-setting-group-title')).toEqual(['Invalid tool calls', 'Recorded thinking', 'Truncate requests']);
    expect(document.querySelectorAll('.dialog .plugin-setting-input')).toHaveLength(8);
    expect(hiddenSettingKeys()).toEqual(['thoughtTurns']);

    tickOf('enabled');

    expect(groups.className).toBe('plugin-settings-groups');
});

it('keeps a plugin that declares no grouping byte-for-byte flat, with no group chrome at all', async () => {
    // Both ungrouped fixtures in one run: a single-setting plugin and a two-setting one, so
    // "flat" is pinned for one row and for the order of several.
    stub({ rows: () => [compactionRow(), mixedRow()] });
    await boot();
    openPlugins();
    await flush();

    pluginRow('context-compaction').click();

    // The pre-contract DOM exactly: the sr-only form name, then one row per setting, direct
    // children of the form, in the declared order.
    expect([...byClass('.plugin-settings-form', 'div').children].map((node) => node.className)).toEqual([
        'plugin-settings-form-label',
        'plugin-setting'
    ]);

    // No wrapper, no blocks, no captions, no indent hosts — not even empty ones. A plugin
    // that declares neither field must not acquire any of the new structure.
    expect(document.querySelector('.dialog .plugin-settings-groups')).toBeNull();
    expect(document.querySelector('.dialog .plugin-settings-group')).toBeNull();
    expect(document.querySelector('.dialog .plugin-setting-group-title')).toBeNull();
    expect(document.querySelector('.dialog .plugin-setting-children')).toBeNull();

    // The hooks the save path walks are the ones that were always there.
    expect(texts('.plugin-setting-label')).toEqual(['Context limit (tokens)']);
    expect(texts('.plugin-setting-hint')).toEqual([String(compactionRow().settings[0]?.description)]);

    byClass('.dialog-close', 'button').click();
    await flush();

    // The two-setting mixed row: two rows, still in declared order, still no chrome.
    pluginRow('extras').click();

    expect([...byClass('.plugin-settings-form', 'div').children].map((node) => node.className)).toEqual([
        'plugin-settings-form-label',
        'plugin-setting',
        'plugin-setting'
    ]);
    expect(texts('.plugin-setting-label')).toEqual(['Verbose logging', 'Log prefix']);
    expect(document.querySelector('.dialog .plugin-settings-groups')).toBeNull();
    expect(document.querySelector('.dialog .plugin-setting-children')).toBeNull();
    expect(hiddenSettingKeys()).toEqual([]);
});

// The CSS half of the grouped form (2026-11-13). jsdom runs no cascade, so what gets pinned here
// is the declaration itself: the indent token, the caption grammar ONE step below the section
// headings, and the off-dim — whose SELECTOR LIST is the contract, because a dim written on an
// ancestor of a control cannot be undone by that control no matter what a later rule declares.
it('styles the settings blocks, the indent and the off dim from the existing grammar', () => {
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));

    if (stylesheet === undefined) throw new Error('styles.css not found');

    const css = readFileSync(stylesheet, 'utf8');
    const ruleOf = (selector: string): string => {
        const at = css.indexOf(`\n${selector} {`);

        if (at < 0) throw new Error(`${selector} is missing from styles.css`);

        return css.slice(at, css.indexOf('}', at) + 1);
    };

    // The off-dim is a TWO-SELECTOR rule and its forced-colours twin is nested inside a media
    // block, so neither is findable by the exact `\n<selector> {` match `ruleOf` performs. This one
    // takes a fragment and counts braces to the end of its body — the recipe
    // `records-style.test.ts` `blockOf` uses — and returns the SELECTORS too, which is the part the
    // dim contract actually lives in.
    const ruleBodyOf = (fragment: string): string => {
        const at = css.indexOf(fragment);

        if (at < 0) throw new Error(`${fragment} is missing from styles.css`);

        const open = css.indexOf('{', at);

        if (open < 0) throw new Error(`${fragment} has no declaration block`);

        let depth = 0;

        for (let index = open; index < css.length; index += 1) {
            if (css[index] === '{') depth += 1;

            if (css[index] === '}') {
                depth -= 1;
                if (depth === 0) return css.slice(at, index + 1);
            }
        }

        throw new Error(`${fragment} has no closing brace`);
    };

    // The indent is ONE named step, the transcript's own 18px, and it is what the rail is
    // drawn with — `padding-left`, never a margin on the child, so a hidden child cannot
    // shift the rail.
    const children = ruleOf('.plugin-setting-children');

    expect(children).toContain('--setting-indent: 18px');
    expect(children).toContain('padding-left: var(--setting-indent)');
    expect(children).toContain('border-left: 1px solid var(--border)');
    // Narrow screens take the same 10px step `.thread-children` takes.
    expect(css).toContain('.plugin-setting-children {\n        --setting-indent: 10px;');

    // A block caption speaks the caption grammar, at ONE STEP BELOW the section headings:
    // 9.5px against `.plugin-detail-section-title`'s 10.5px, so a group reads as below
    // `SETTINGS` instead of competing with it.
    expect(ruleOf('.plugin-setting-group-title')).toContain('font-family: var(--mono)');
    expect(ruleOf('.plugin-setting-group-title')).toContain('text-transform: uppercase');
    expect(ruleOf('.plugin-setting-group-title')).toContain('color: var(--muted)');
    expect(ruleOf('.plugin-setting-group-title')).toContain('font-size: 9.5px');
    expect(ruleOf('.plugin-detail-section-title')).toContain('font-size: 10.5px');

    // The off-dim (D1/D2, 2026-11-13) sits on the row's OWN text elements. That shape is the
    // contract: opacity applies to a whole subtree and no descendant can undo an ancestor's
    // value, so while the rule was written on `.plugin-setting` it covered the row's own checkbox,
    // and the `opacity: 1` that followed it was a declaration no browser could honour — the old
    // assertion grepped for that text and passed anyway. The sheet's own precedent has always had
    // it right (`panel-tasks-row[data-completed='true'] .panel-tasks-row-text`): dim and restore on
    // the SAME element, so nothing in between needs rescuing.
    const dim = ruleBodyOf('.plugin-settings-groups--off .plugin-setting > .plugin-setting-label');

    // The selector list EXACTLY: two entries, each aimed one step below the row at a text element.
    // Anything higher up re-instates D1, and pulling `.plugin-setting-group-title` into this list
    // would strip a block of the caption that names it.
    expect(dim.slice(0, dim.indexOf('{')).split(',').map((entry) => entry.trim())).toEqual([
        '.plugin-settings-groups--off .plugin-setting > .plugin-setting-label',
        '.plugin-settings-groups--off .plugin-setting > .plugin-setting-hint'
    ]);

    // 0.82 is the step that precedent already uses, and it is the contrast half of the fix:
    // `--muted` (#8b94a7) over `--bg` (#0b0d12) is 6.4:1 undimmed and 4.6:1 at 0.82, which is still
    // WCAG AA for body text, against the ≈3.1:1 the 0.62 this replaces put the hint at. jsdom
    // composites nothing, so only the STEP is pinned here; the arithmetic lives in the comment
    // above the rule in styles.css.
    expect(dim).toContain('opacity: 0.82');

    // Nothing may dim an ancestor of a control any more, and no "restore the control" rule may
    // survive to look like it works. Both greps run over the WHOLE sheet, so re-adding the
    // row-level dim, or the checkbox rule that tried to cancel it, fails here even with the correct
    // rule sitting beside it — which is precisely the hole that let the no-op through once.
    expect(css).not.toContain('.plugin-settings-groups--off .plugin-setting {');
    expect(css).not.toContain(".plugin-settings-groups--off .plugin-setting-input");
    expect(css).not.toContain('opacity: 0.62');

    // D8: this mode repaints text from the system palette, so a translucent step is a cue the
    // platform is not obliged to preserve. The sheet's other five forced-colours blocks each give
    // the state a system colour instead, and this one does the same: `GrayText` is the mode's own
    // insensitive-text colour, i.e. "declared, not in force" without pretending the row is dead.
    const forced = ruleBodyOf('@media (forced-colors: active) {\n    .plugin-settings-groups--off');

    expect(forced).toContain('> .plugin-setting-label');
    expect(forced).toContain('> .plugin-setting-hint');
    expect(forced).toContain('color: GrayText');
    expect(forced).toContain('opacity: 1');

    // A tick and its label on ONE line, description underneath — done with `:has()` on the
    // DOM the renderer already emits, so an ungrouped plugin's markup is untouched.
    expect(ruleOf(".plugin-setting:has(> .plugin-setting-input[type='checkbox'])")).toContain('flex-wrap: wrap');
    expect(ruleOf(".plugin-setting:has(> .plugin-setting-input[type='checkbox']) > .plugin-setting-input")).toContain('order: -1');
    expect(ruleOf(".plugin-setting:has(> .plugin-setting-input[type='checkbox']) > .plugin-setting-hint")).toContain(
        'flex-basis: 100%'
    );

    // The reveal's authority is still the one global hiding rule, not a class this form owns:
    // `hidden` on a row means `display: none` whatever the row's own display is.
    expect(ruleOf('[hidden]')).toContain('display: none !important');
});

// The CSS half of the read-only prompt (2026-11-12), pinned against the stylesheet rather
// than a browser — jsdom runs no cascade here, and what this really guards is a
// specificity trap: ui/dialog.css `.dialog-body pre { white-space: pre }` (0,1,1) would
// beat any element selector, so main.ts paints a `<p>` and styles.css owns the wrapping,
// exactly the way `.agent-instruction` does and exactly the trap ui/tool-code-viewer.test.ts
// records for the tool pane.
it('styles the prompt block so its newlines survive and nothing clips horizontally', () => {
    // Same resolution as the other CSS-source tests: package root (`yarn test:frontend`)
    // or the frontend root (vitest.config.ts `root`).
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));

    if (stylesheet === undefined) throw new Error('styles.css not found');

    const css = readFileSync(stylesheet, 'utf8');
    const at = css.indexOf('\n.plugin-detail-prompt {');

    if (at < 0) throw new Error('.plugin-detail-prompt is missing from styles.css');

    const rule = css.slice(at, css.indexOf('}', at) + 1);

    // The prompt's own newlines stay, and a line still wraps at the dialog's width.
    expect(rule).toContain('white-space: pre-wrap');
    // `overflow: auto` alone would SCROLL a too-long word out of view; breaking it is what
    // means no part of the prompt is ever clipped.
    expect(rule).toContain('overflow-wrap: break-word');
    expect(rule).toContain('overflow: auto');
    expect(rule).toContain('max-height: 160px');
    // The new section keeps the dialog's divider grammar. An unstyled class here is how a
    // section quietly becomes an invisible band between the two it sits between.
    expect(css).toContain('.plugin-detail-hooks,\n.plugin-detail-prompt-section,\n.plugin-detail-settings {');
});

// The placement half of the settings form (2026-11-13): the Save control sits on the RIGHT
// edge of the dialog, like the single control of every other action row in this app
// (`.thread-transcript-read-actions`). jsdom lays nothing out, so the declaration itself is
// what gets pinned.
it('right-aligns the settings save control', () => {
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));

    if (stylesheet === undefined) throw new Error('styles.css not found');

    const css = readFileSync(stylesheet, 'utf8');
    const at = css.indexOf('\n.plugin-setting-actions {');

    if (at < 0) throw new Error('.plugin-setting-actions is missing from styles.css');

    const rule = css.slice(at, css.indexOf('}', at) + 1);

    expect(rule).toContain('justify-content: flex-end');
});
