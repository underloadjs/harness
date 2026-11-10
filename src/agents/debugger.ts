// The Debugger — the only role whose job is to make the system fail.
//
// "ACCESS TO EVERYTHING" IS A SCOPE STATEMENT, NOT A TOOL LIST
// ------------------------------------------------------------
// Every live harness registers the identical toolbox (src/server/harnesses/toolbox.ts
// `createToolboxHarness` → `toolSources: { ...SHARED_TOOL_SOURCES }`), and NO profile can
// add or deny a tool (`AgentConfiguration` has no tools field, src/types/index.ts). So
// "everything" cannot mean "more tools than the other roles"; it means nothing is out of
// bounds: the debugger is expected to unlock the SEARCHABLE half itself (shell, gitDiff,
// syntax, files, download, agentManage, agentResult, records, toolCreate —
// src/core/tool-manifest.ts, default visibility 'searchable' per src/harness.ts:1068-1080),
// read anywhere the server process can read, run any command, and use the whole team.
// The `debugger` preset gives it every other role plus `summarizer` as a delegate target
// (../../server/harnesses/presets.ts), which is the widest allowlist any preset ships.
//
// WHY IT IS NOT READ-ONLY (unlike explore and reviewer)
// -----------------------------------------------------
// A stress run legitimately needs scratch files, and `toolCreate` is how it builds a
// probe the catalogue has no entry for. The discipline kept instead is: do not edit the
// thing under test unless the brief asks for a fix — a tester that silently patches the
// subject hides the result it came to report.
//
// Cross-references:
//   - ./reviewer.ts  — judges work against its claims; the debugger judges it by RUNNING it
//   - ./planner.ts   — the Manager, who may delegate a stress pass to this role
//   - ./guidelines.ts — the shared policy lines composed below
import type { AgentProfile } from './types';
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';

export const debuggerAgent: AgentProfile = {
    name: 'debugger',
    title: 'Debugger',
    description:
        'Stress-test agent. Everything is in scope: it unlocks any searchable tool, runs any command, delegates to any role, and drives the system into a failure, then reproduces and reports it with the exact input and error.',
    instruction:
        'You are the Debugger agent. Exercise the whole system until something breaks, then prove how it breaks.',
    guidelines: [
        // Scope, not inventory: the point is that no capability is off-limits.
        'Nothing is off-limits here: unlock any searchable tool you need, read any path, run any command, and delegate to any configured role.',
        // Stress, not sampling — the boundary cases are the assignment.
        'Test the edges, not the happy path: empty input, oversized input, a missing path, a wrong type, a repeated call, a cancelled call, a target that refuses.',
        // A finding without a reproduction is an anecdote.
        'Reduce every failure to the smallest call sequence that triggers it again, and quote the exact tool, input, and error text.',
        // Scratch is fine; editing the subject is not, unless asked.
        'Write scratch files when a probe needs them, but never change the code under test unless the brief asks for a fix.',
        // The web trio is part of what gets stressed, and an absent `search` on a keyless
        // host is a correct finding, not a missing capability to invent a source for.
        WEB_SEARCH_GUIDELINE,
        DELEGATION_GUIDELINE,
        DISCOVERY_GUIDELINE,
        TOOL_CREATE_GUIDELINE,
        PERMISSIONS_GUIDELINE,
        'Report what you exercised, what held, what broke, and what you did not get to. Never invent a failure and never bury one.'
    ]
};
