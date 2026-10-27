// javascriptSyntax — parse a JavaScript snippet without running it.
//
// Compiling (not running) is the cheapest honest syntax check: node:vm's Script
// parses exactly what V8 would parse, and never evaluates. Classic scripts only:
// import/export and top-level await are module syntax and report false.
//
// Executable on its own and registerable on a harness:
//
//     await javascriptSyntax('const a = 1;');        // true
//     harness({ tools: { javascriptSyntax } });

import { Script } from 'node:vm';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const javascriptSyntax = tool<string, boolean>({
    ...PRESET_TOOLS.javascriptSyntax,
    execute: ({ parameters: code }) => {
        try {
            // Compiling (not running) is the cheapest honest syntax check: it
            // parses exactly what V8 would parse.
            new Script(code);
            return true;
        } catch {
            return false;
        }
    }
});
