// CLI argument parsing, kept separate from the executable entry.
//
// WHY A MODULE: `index.ts` runs `main()` at import time (it IS the process), so a
// test cannot import it to pin the preset default. The parser is pure, so the
// product decision "no args means the real Instruct role, never the scripted
// fixture" is asserted directly instead of by parsing help text.
//
// The default is a LIVE role. `demo` remains available as an explicit
// `--preset demo` for hosts without a provider; there is deliberately no silent
// fallback to it, because a scripted answer is not a useful general harness.
//
// Cross-references:
//   - ./index.ts        - uses parseCliOptions() and applies the endpoint check
//   - ../../agents      - the trusted roles the preset ids select
//   - ../../harnesses   - findPreset / presets (demo is the offline exception)

import { parseArgs } from 'node:util';

// The entry preset for `harness` with no `--preset`. Instruct is the general
// role the catalogue lists first and the UI selects first; the CLI must agree.
export const DEFAULT_CLI_PRESET = 'instruct';

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
