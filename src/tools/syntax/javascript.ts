// JavaScript half of syntaxCheck — parse a snippet without running it.
//
// Compiling (not running) is the cheapest honest syntax check: node:vm's Script
// parses exactly what V8 would parse, and never evaluates. Classic scripts only:
// import/export and top-level await are module syntax and report false.
//
// This module is loaded through `import()` by ./syntaxCheck only when the caller
// asks for language "javascript", so a Python check never pays for node:vm (and
// the reverse). Metadata lives in ../catalogue.

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
