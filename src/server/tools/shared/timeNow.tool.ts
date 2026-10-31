// Independently compilable source entry for the `timeNow` app tool.
//
// T25 MOVE: this file used to live at `server/harnesses/tool-sources/timeNow.ts` and
// was statically imported by `server/harnesses/tools.ts`. That import was the last
// app-level exception to "every tool definition lives in a tools folder and is read
// metadata-first". The entry now lives in the dedicated server tools folder
// (`server/tools`, i.e. `<package>/src/server/tools`), which is NOT the package
// default tools root (`<package>/src/tools`), so the library harness still cannot
// discover it by accident: only the server opts into this folder through
// `toolFolders` / a discovered source map (see ../harnesses/tools.ts).
//
// WHAT THE SCANNER READS
// ----------------------
// `core/tool-scan.ts` reads the `metadata` and `registration` literals below through
// the TypeScript AST and never imports this module. Both must therefore be PURE
// literals: no template interpolation, no calls, no spreads, no cross-file
// identifiers. That is why the timezone bound appears twice (literal + constant):
// the literal is the authority the catalogue publishes, the constant is what the
// implementation enforces.
//
// The implementation is unchanged from the R2 extraction. Keep the content shape
// `{ timezone, iso, unix }` stable: the scripted demo, the HTTP contract, and the
// declarative panel all depend on it.
//
// Cross-references:
//   - ../harnesses/tools.ts  — discovers this folder, builds the lazy catalogue proxy
//   - ../harnesses/toolbox.ts — SHARED_TOOL_SOURCES / toolFolders opt-in
//   - ../../core             — `tool` / `toolUi` (mapped to the LIVE module by the compiler)

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
// text sink. Must equal `metadata.parameters.properties.timezone.maxLength`.
const MAX_TIMEZONE_CHARS = 64;

// Declarative half (T19/R9). Discovery reads this literal, so the catalogue can
// describe the tool without evaluating this module.
export const metadata = {
    name: 'timeNow',
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
                maxLength: 64,
                description: 'Label for the timezone being asked about, e.g. "UTC".'
            }
        },
        required: ['timezone'],
        additionalProperties: false
    }
};

// Harness policy for a folder entry. `order` is what preserves the historical app
// tool order (timeNow, textCount, diceRoll, noteSearch, textSummarize) even though
// folder discovery sorts byte-wise by relative path; `discoverToolMetadata` sorts
// by this value inside one folder. `listed: true` states that this tool is part of
// the server's direct-call catalogue (it is reachable through POST /tools/:name).
export const registration = {
    group: 'external',
    activation: 'always',
    order: 1000,
    listed: true
} as const;

// timeNow — the current time. The timezone argument is only a label for the answer.
//
// R20.2 DEMONSTRATION: returns `toolUi(content, panels)` so:
//   - the MODEL receives exactly the JSON of `{ timezone, iso, unix }`;
//   - a chat client gets one `right`-slot key/value panel on the tool_result;
//   - the manual/direct server call unwraps to the same content plus `panels`.
const timeNow = tool<string | undefined, ToolUiEnvelope<{ timezone: string; iso: string; unix: number }>>({
    ...metadata,
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
