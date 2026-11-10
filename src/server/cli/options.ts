// CLI argument parsing, kept separate from the executable entry.
//
// WHY A MODULE: `index.ts` runs `main()` at import time (it IS the process), so a
// test cannot import it to pin the preset default. The parser is pure, so the
// product decision "no args means a real live role" is asserted directly instead of
// by parsing help text.
//
// Every selectable preset is a LIVE role. The scripted `demo` preset used to be the
// one endpoint-free option and was deleted along with its transport, so `--preset`
// now only ever names a real configuration and a missing base URL is an error rather
// than a cue to fall back to a scripted transcript.
//
// Cross-references:
//   - ./index.ts        - uses parseCliOptions() and applies the endpoint check
//   - ../../agents      - the trusted roles the preset ids select
//   - ../../harnesses   - findPreset / presets (all live, all need a provider)

import { parseArgs } from 'node:util';

// The entry preset for `harness` with no `--preset`. `general` is the default role the
// catalogue lists first and the UI selects first, so the CLI must agree — see `presets`
// order in ../harnesses/presets.ts and AGENT_PROFILE_NAMES in ../../agents/index.ts.
// `instruct` remains a live role one flag away for a run that should delegate its
// reading; it is simply no longer the entry point.
export const DEFAULT_CLI_PRESET = 'general';

// Parse argv (without the node/script prefix). Every option keeps its original
// short/long form and type; only the default preset changed, so callers that
// never passed `--preset` now get the real role instead of the fixture.
//
// `args` is copied because parseArgs accepts a mutable array and a caller may
// hold a readonly list.
export const parseCliOptions = (args: readonly string[] = process.argv.slice(2)) =>
    parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
            preset: { type: 'string', short: 'p', default: DEFAULT_CLI_PRESET },
            model: { type: 'string', short: 'm' },
            'base-url': { type: 'string', short: 'b' },
            'api-key': { type: 'string', short: 'k' },
            list: { type: 'boolean', short: 'l', default: false },
            tools: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            serve: { type: 'boolean', default: false },
            port: { type: 'string' },
            host: { type: 'string' },
            'no-color': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false }
        }
    });
