// Independently compilable source entry for the `timeNow` app tool.
//
// R2 (task-harness-self-modifying-tools): every shipped application tool needs an
// editable entry point that can be compiled on its own. This file is that entry —
// it imports only the shared `tool`/`toolUi` helpers from the harness library, so
// replacing `timeNow` never requires rebuilding another tool or the app.
//
// The implementation is moved verbatim from ./tools.ts. Keep the content shape
// `{ timezone, iso, unix }` stable: the scripted demo, the HTTP contract, and the
// declarative panel all depend on it.
//
// Cross-references:
//   - ../../harnesses/tools.ts — app catalogue that re-exports this definition
//   - ../presets.ts           — demo preset registers this exact definition

// Import the framework helper through the harness-internal `core` entry, not the
// package root: the synchronous source compiler maps a source-root-relative
// `core` import to the LIVE helper module, so a compiled revision shares the same
// `tool()` identity. Importing the package root would capture a second copy of the
// whole harness as editable source instead.
import { tool, toolUi } from '../../../core';
// Type-only import: erased at runtime, and mapped to the live `types` module by
// the same compiler when present.
import type { ToolUiEnvelope } from '../../../types';

// Validation bound for the label (R8). The timezone is a LABEL only (it does not
// change the clock); capping it keeps the demo panel from becoming an arbitrary
// text sink.
const MAX_TIMEZONE_CHARS = 64;

// timeNow — the current time. The timezone argument is only a label for the answer.
//
// R20.2 DEMONSTRATION: returns `toolUi(content, panels)` so:
//   - the MODEL receives exactly the JSON of `{ timezone, iso, unix }`;
//   - a chat client gets one `right`-slot key/value panel on the tool_result;
//   - the manual/direct server call unwraps to the same content plus `panels`.
const timeNow = tool<string | undefined, ToolUiEnvelope<{ timezone: string; iso: string; unix: number }>>({
    description:
        'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
    tags: ['time', 'clock', 'date'],
    parameters: {
        type: 'object',
        properties: {
            timezone: {
                type: 'string',
                // The label is echoed into a panel block, so it is bounded here and
                // validated again for direct callers (who skip JSON Schema).
                maxLength: MAX_TIMEZONE_CHARS,
                description: 'Label for the timezone being asked about, e.g. "UTC".'
            }
        },
        required: ['timezone'],
        additionalProperties: false
    },
    execute: ({ parameters: timezone }) => {
        // `?? 'UTC'` keeps the documented default for a direct call that omits the
        // label. Any present label must be a bounded, non-blank string: a non-string
        // (direct callers bypass the schema) or an oversized one is refused rather
        // than coerced into the panel.
        const label = timezone ?? 'UTC';

        if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_TIMEZONE_CHARS) {
            throw new Error(`timeNow timezone must be a non-empty string of at most ${MAX_TIMEZONE_CHARS} characters.`);
        }

        const now = new Date();
        const content = {
            timezone: label,
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000)
        };

        return toolUi(content, [
            {
                id: 'timeNow',
                // 'right' is the default mount point; slot names are open strings.
                slot: 'right',
                title: 'Current time',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'Timezone', value: content.timezone },
                            { label: 'ISO 8601', value: content.iso },
                            { label: 'Unix', value: String(content.unix) }
                        ]
                    },
                    { type: 'text', text: 'Read from the server clock at execution time.' }
                ]
            }
        ]);
    }
});

export { timeNow };
export default timeNow;
