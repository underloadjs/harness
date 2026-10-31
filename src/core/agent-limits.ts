// Agent inspection (R3). These bounds are the declared contract AND the runtime
// values (the harness imports them), so the descriptions cannot advertise a
// preview/page size the implementation does not use.
//
//   - PREVIEW: how many characters of each completed answer agentManage shows;
//   - LIST_PER_AGENT: how many recent invocations per agent agentManage lists;
//   - RETENTION: how many completed invocation results the harness keeps
//     (active runs are always retained regardless of this cap);
//   - PAGE / PAGE_MAX: the default and maximum characters agentResult returns
//     per page. The page cap is deliberately far below the 64 KiB serialized
//     tool-result bound even with JSON escaping, so a long result is paged
//     explicitly instead of being silently truncated by boundToolResult.
//
// T13 note: agentManage.tool.ts / agentResult.tool.ts write these same numbers as
// LITERALS inside their schemas. A runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// ./metadata.ts), so it cannot import this leaf. core/metadata.ownership.test.ts
// asserts the literals equal these constants — change both together.
export const AGENT_MANAGE_PREVIEW_CHARS = 200;

export const AGENT_MANAGE_LIST_PER_AGENT = 5;

export const AGENT_RESULT_RETENTION = 64;

export const AGENT_RESULT_PAGE_CHARS = 4000;

export const AGENT_RESULT_PAGE_MAX_CHARS = 8000;
