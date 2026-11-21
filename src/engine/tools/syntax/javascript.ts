// JavaScript half of syntax — parse a snippet without running it.
//
// Compiling (not running) is the cheapest honest syntax check: node:vm's Script
// parses exactly what V8 would parse, and never evaluates. Classic scripts only:
// import/export and top-level await are module syntax and report false. That is the
// published contract of the "javascript" (alias "js") language name and is UNCHANGED
// by the tool rename; a snippet that uses module syntax is checked as "typescript"
// (alias "ts"), which parses modules, or accepted as classic-script-invalid here.
//
// This module is loaded through `import()` by ./syntax.tool.ts only when the caller
// asks for a JavaScript check, so a Python or TypeScript check never pays for node:vm
// (and the reverse). Metadata lives in ./syntax.tool.ts.

import { Script } from 'node:vm';

// Compiling (not running) is the cheapest honest syntax check: it parses exactly
// what V8 would parse. Any parse error means "invalid syntax" — never an
// execution failure, because nothing runs.
export const checkJavaScript = (code: string): boolean => {
    try {
        new Script(code);
        return true;
    } catch {
        return false;
    }
};
