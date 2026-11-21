// knowledge — the model-facing door to the cross-session knowledge base (T6).
//
// WHAT THIS FILE IS. The thin half of the pair: wire name, description, JSON Schema,
// registration row, argument normalization, and a bounded model projection. The brain is
// `src/core/knowledge.ts` (the T4 engine) and the durable half is
// `src/server/knowledge-file-store.ts` (T7); NEITHER is duplicated here. Every rule a model
// can break — the id shape, the CAS token, every size bound, every byte cap — is enforced by
// the engine, and this entry adds exactly two behaviours of its own:
//
//   1. `list` is the default operation, so an argument-less call is a listing rather than a
//      refusal (see NORMALIZING THE ARGUMENTS);
//   2. the result is returned through `toolText(content, projection)` so the model pays for a
//      summary while the API/UI still get the engine's full result (see BOUNDING THE PROJECTION).
//
// THE SEAM, and why the lookup looks the way it does. `Harness.knowledge` (src/types/index.ts
// :4934) is documented as the handle the knowledge tool writes through:
//
//     context.harness?.knowledge  ->  HarnessKnowledge  (src/types/index.ts:2798)
//                                   = KnowledgeEngine | HarnessKnowledgeStore
//
// It is passed through BY REFERENCE, so identity is the proof of sharing: two sessions of one
// server hold the SAME store and one session's article is the other's to read. The union is
// deliberate (src/types/index.ts:2753-2797) and the entry has to honor both halves:
//
//   - a DURABLE store-shaped member carries `engine` (plus `root`/`directory`/`commit`/`flush`/
//     `dispose`, the durability signal — presence, never a flag);
//   - a BARE engine (what `harness({})` builds for itself, and what a server hands over before
//     its store has loaded: src/server/runtime.ts builds the engine synchronously and awaits
//     the load after it) IS the engine, and is ephemeral.
//
// So the engine is `seam.engine` when the seam carries one and the seam itself otherwise
// (`'engine' in seam` is the exact narrowing, because `KnowledgeEngine` declares no `engine`
// member — src/types/index.ts:2724-2750). An absent `context.harness` (a bare
// `toolCall(knowledge, …)` without a harness) is the ONLY case this entry refuses itself:
// `EKNOWLEDGE_INPUT`, the code the engine uses for "this call cannot run as shaped"
// (src/core/knowledge.ts:246-249). It never fabricates a store, because a silently-empty base
// would read as "nothing is written down here" instead of "this host has no base".
//
// A lane WORKER gets the replica `harness()` built for it rather than the host's live store —
// a live object cannot cross `worker_threads`, exactly as `pluginSettings`/`toolSettings`
// document (src/types/index.ts:4925-4927). Nothing in this file depends on that: it routes
// through whatever seam it was handed.
//
// ERRORS ARE THE ENGINE'S. Engine refusals are thrown `HarnessError`s whose message starts
// with the code and whose `details` carry the recovery payload (src/core/knowledge.ts:269-288,
// `isKnowledgeRejection`), and the harness surfaces both (`src/harness.ts:13069`). This entry
// therefore does NOT catch-and-relabelling: relabelling would launder `EKNOWLEDGE_REV`'s
// payload into a guessed message, which is the mistake `translateRecordRejection`
// (src/core/records.ts:4326-4348) exists to avoid. Records' entry is the same precedent
// (src/tools/runtime/records.tool.ts:315-319 registers a pass-through and catches nothing).
//
// NORMALIZING THE ARGUMENTS — three real harness behaviours decide the shape here.
// (a) THE OPERATION IS WHAT `execute` RECEIVES, never the wrapper. A schema with exactly ONE
//     object-valued property hits the single-property rule (`toolParameterKey`,
//     src/core/tool.ts:65-73): the model sends the wrapper `{ "operation": { verb: "list" } }`,
//     the validator checks it, and `resolveToolParameters` delivers `raw[key]` — the operation
//     itself (src/core/schema-validation.ts:383-386). A direct caller passes the unwrapped value,
//     which the DIRECT path tries first and re-wraps only when that fails
//     (src/core/schema-validation.ts:405-418), so both spellings land in the same place. The
//     description still teaches the wrapper, because that is what the SCHEMA shows the model.
// (b) AN ARGUMENT-LESS CALL IS THE DEFAULT CASE, not an error. `{}` (and a missing `parameters`)
//     resolves to the single property's value — `undefined` — by an explicit rule: "an EMPTY object
//     is the 'nothing filled in' argument box … `execute` receives the single property's value
//     (undefined), which every implementation treats as 'use the default'"
//     (src/core/schema-validation.ts:400-410). `knowledge()` is the cheapest call a model can make
//     — "what do you know?" — so `{}` means `list`, and this entry never refuses it.
// (c) `operation` IS NOT `required`, for the same reason: `required` is enforced by the validator
//     (src/core/schema-validation.ts:200), so requiring it would turn (b) into a protocol failure
//     before the tool ever saw the call.
// (d) A SIX-VERB UNION CANNOT BE ENCODED AS PER-VERB REQUIRED KEYS. `validateSchemaValue`
//     (src/core/schema-validation.ts:122) implements `type`, `enum`, `oneOf`, numeric/string/array
//     bounds, `items`, `required` and `additionalProperties: false` (:200, :221) — and NOTHING
//     conditional: `if`/`then`/`allOf`/`anyOf` are simply unknown keywords, which the walker
//     ignores. So the schema is one flat object carrying every verb's keys, strict at both levels,
//     with the enum and the bounds the engine enforces; which keys a verb needs is the engine's
//     job, and it refuses a missing or impossible one BY NAME (the accepted-key sets are
//     `OPERATION_KEYS`, src/core/knowledge.ts:316-333). A flat schema plus a refusal that names the
//     verb is also the better model experience: `$.modify requires "id"` would not say which verb
//     asked, and a model that guessed the verb wrong gets one useful line either way.
//
// BOUNDING THE PROJECTION. `content` is the engine result, untouched (a stale write keeps
// `details.article`, a create keeps every paragraph body it just wrote, a read keeps its window).
// The PROSE the model pays for is cut to the same figure the engine caps its own answers at —
// `KNOWLEDGE_RESPONSE_BUDGET_BYTES = 24576` (src/core/knowledge.ts:199-211) — measured in the
// currency every budget in this package uses: the ESCAPED payload bytes the model is billed, via
// `modelPayloadBytes` (src/core/payload-bytes.ts:72, which takes the SERIALIZED string;
// src/core/result-budget.ts:78-118 — "measuring text bytes while capping payload bytes is the bug
// T3 kills"). The engine already trims its own READS to that cap; the prose needs its own bound
// because the engine's WRITE results are unbounded prose-side: a `create` of 64 × 4000-character
// paragraphs answers with the whole article (src/types/index.ts:2596-2605) — 256 KiB of text the
// model just wrote and does not need handed back. Budget arithmetic: 24576 − 512 (cut-note
// reserve) = 24064 is what rows may occupy, and at least ONE row always survives (a 4000-character
// paragraph is ~4 KiB escaped, so one row cannot break the cap by itself). A projection still over
// the cap after that (one gigantic field, no rows to drop) is passed through and the harness's
// per-result cap, `MODEL_TOOL_RESULT_BUDGET_BYTES` (src/core/result-budget.ts:192), is the last
// line — stated because it is the honest limit of what one tool can promise.
//
// THE LITERALS THE SCANNER READS. `core/tool-scan.ts` evaluates `metadata` and `registration`
// through the TypeScript AST — it never executes this module — and rejects a non-literal member
// (src/core/tool-scan.ts:323-326, pinned by src/core/tool-discovery.test.ts:409-447). So both
// exports are pure literals: no identifier values, no spread, and no template INTERPOLATION in
// `description` (only a no-substitution template literal is scanner-evaluable,
// src/core/tool-scan.ts:281-284). That is why the description and the schema state their bounds as
// DIGITS (100, 64, 4000, 24576 …) instead of naming the engine constants, and why the projection's
// cap is a local literal too: knowledge.test.ts asserts those digits against the engine's own
// exports, which turns drift into a failing assertion instead of prose (the
// FILE_READ_ERROR_CODES precedent, src/tools/files/read.tool.ts:961).
//
// IMPORTS. `tool`/`toolText`/`modelPayloadBytes` come from the `../../core` barrel and
// `HarnessError` from `../../util` — the exact shape src/tools/files/read.tool.ts:623-625 uses,
// which matters because a `.tool.ts` is not plain ESM here: the runtime compiler resolves those
// specifiers to the LIVE framework namespace instead of re-reading their source
// (`LIVE_MODULE_KEYS`, src/core/tool-source.ts:504-523 — `core`, `core/tool`, `core/tool-text`,
// `util`, `types` are all listed, so one `tool()` factory and one `HarnessError` class survive a
// source edit). Two consequences are load-bearing for this file:
//   - anything imported from `../../core` must exist in the hand-assembled live namespace
//     (src/core/tool-source.ts:463-499), which does NOT include `core/knowledge` — hence the local
//     budget literal above rather than an engine import; `modelPayloadBytes` IS reachable because
//     `result-budget` re-exports it (src/core/result-budget.ts:116-118);
//   - `../../types` and `CoreToolMetadata` are type-only and erased, so they cannot create the
//     core → tools → core edge (`core/tool-source.ts:143` imports `../tools/catalogue`).
// No engine module is imported for BEHAVIOUR: the articles arrive through the T7 seam.

import { modelPayloadBytes, tool, toolText } from '../../core';
import type { CoreToolMetadata } from '../../core';
import { HarnessError } from '../../util';
import type {
    KnowledgeArticle,
    KnowledgeArticleSummary,
    KnowledgeEngine,
    KnowledgeModifyResult,
    KnowledgeOperation,
    KnowledgePageInfo,
    KnowledgePageResult,
    KnowledgeReadResult,
    KnowledgeRemoveResult,
    KnowledgeResult,
    KnowledgeSearchResult,
    ToolContext,
    ToolTextEnvelope
} from '../../types';

// The wire name. `KNOWLEDGE_METADATA.name` is the literal the scanner reads; this exported
// constant is for a HOST that registers the entry by name (the `*_NAME` pattern every runtime
// entry follows, e.g. src/core/metadata.ts:1099 THREAD_DELETE_NAME) and is pinned equal to it
// by knowledge.test.ts.
export const KNOWLEDGE_NAME = 'knowledge';

// ---------------------------------------------------------------------------
// The metadata the model reads
// ---------------------------------------------------------------------------

// BOUNDS CITED (the engine owns each figure; the schema restates it as a literal, and
// knowledge.test.ts asserts every one against the engine's own constant):
//   KNOWLEDGE_MAX_ARTICLES 100 · KNOWLEDGE_MAX_PARAGRAPHS 64 · KNOWLEDGE_MAX_TEXT 4000
//   KNOWLEDGE_MAX_TITLE 200 · KNOWLEDGE_MAX_NOTE 500 · KNOWLEDGE_MAX_TAGS 16 /
//   KNOWLEDGE_MAX_TAG 64 · KNOWLEDGE_MAX_REFS 16 · KNOWLEDGE_MAX_ITEMS 64 ·
//   KNOWLEDGE_MAX_SEARCH 50 (rank window) · KNOWLEDGE_LIST_DEFAULT_LIMIT 20 /
//   KNOWLEDGE_LIST_MAX_LIMIT 100 · KNOWLEDGE_RESPONSE_BUDGET_BYTES 24576
//   (src/core/knowledge.ts:180-232, exported through src/core/index.ts:225-241).
// HOW A PER-VERB DIFFERENCE IS RESOLVED — the rule the three shared properties follow, because
// the validator has no `if`/`then` vocabulary (src/core/schema-validation.ts:122, :200, :221) and
// ONE flat schema has to serve all six verbs:
//   1. The schema must never be MORE permissive than the engine (that is a late, confusing
//      refusal after the door already said yes). Where two verbs share a property and the engine
//      bounds them differently, the shared ceiling is the SMALLEST bound that is safe for every
//      verb: `limit` is 64 — read's window (KNOWLEDGE_MAX_PARAGRAPHS, :496-507), not list's 100
//      (KNOWLEDGE_LIST_MAX_LIMIT, :467-478); `tag` is KNOWLEDGE_MAX_TAGS 16, the same reader that
//      checks create's `tags` (:557-569, reached from :1923), not the 64 id-list bound.
//   2. Being STRICTER than the engine is allowed when it is deliberate and documented, and there
//      is exactly one such property: `expects` carries 1 entry where the engine parses up to 64,
//      because a call guards one article (see the block on that property).
// The verbs are `KNOWLEDGE_OPERATION_VERBS` (src/types/index.ts:2494-2501, derived from
// `KnowledgeOperation` at :2474-2490 so the type and the refusal cannot drift); the enum below
// is the same six, pinned equal in knowledge.test.ts.
export const KNOWLEDGE_METADATA: CoreToolMetadata = {
    name: KNOWLEDGE_NAME,
    description: `Shared reference store: the cross-session knowledge base every thread of this deployment reads and writes — tagged articles of paragraph-addressed text that outlive this session. Six verbs, ONE operation object per call, sent as { operation: { ... } } (or that object's own keys at the top level, which the harness unwraps for you).

DRILL IN, NEVER FLOOD. list and search answer with article METADATA ONLY (id, title, tags, rev, paragraphCount) - never paragraph bodies. Read the outline before you read text, and read text a window at a time:
  list    { operation: { verb: "list" } }  ...  { operation: { verb: "list", search: "render budget", tag: ["costs"], limit: 10, offset: 0 } }
  search  { operation: { verb: "search", query: "how are token budgets computed", limit: 20 } }
  read    { operation: { verb: "read", id: "<article id>", outline: true } }  ->  every paragraph id with its rev, size and tags, NO text
          { operation: { verb: "read", id: "<article id>", paragraphs: ["<paragraph id>"] } }  ...  { operation: { verb: "read", id: "<article id>", from: 0, limit: 5 } }
  create  { operation: { verb: "create", title: "Token budgets", tags: ["costs"], content: ["first paragraph", { text: "second paragraph", tags: ["detail"], refs: [{ articleId: "<article id>", note: "why" }] }] } }
  modify  { operation: { verb: "modify", id: "<article id>", expects: [{ id: "<article id>", rev: 3 }], title: "New title", addTags: ["costs"], removeTags: ["old"], addContent: ["a new paragraph"], setParagraphs: [{ id: "<paragraph id>", text: "rewritten" }], moveParagraphs: [{ id: "<paragraph id>", before: "<paragraph id>" }], removeParagraphs: ["<paragraph id>"] } }
  remove  { operation: { verb: "remove", id: "<article id>", expects: [{ id: "<article id>", rev: 4 }] } }

THE RULES, because the engine refuses them all and a refusal names the exact field:
- IDS ARE UUIDS THE STORE GAVE YOU. Never invent one: an unknown article id is EKNOWLEDGE_NOT_FOUND, and the remedy is always list or search first. A paragraph id comes from read (a page row's paragraphCount only tells you how big the drill in is).
- WRITES NEED THE TOKEN. modify and remove pass expects: [{ id, rev }] with the rev your last read reported - ONE token, article grain, because a paragraph edit moves the article rev too. A stale token is refused EKNOWLEDGE_REV and the refusal quotes the CURRENT rev and article: re-read, then retry against that rev. A write with no expects still writes, and can overwrite what another thread changed.
- BOUNDS: 100 articles; 64 paragraphs per article; 4000 characters per paragraph; 200 per title; 500 per reference note; 16 tags per article or paragraph and at most 16 in a "tag" filter, at 64 characters each; 16 references per paragraph; 64 entries per list argument, and exactly 1 in expects (one call guards one article). limit is 1-64 on EVERY verb, because one property serves list, search and read and the read window is the tightest (list/search default to 20); search ranks at most the first 50 rows (offset + limit <= 50) while list pages the whole store; read answers at most 64 paragraphs per call.
- THE RESPONSE CAP CUTS, IT DOES NOT FAIL: 24576 bytes of what you pay for. read reports truncated / budgetTruncated and answers with totalParagraphs; list/search set page.hasMore and page.budgetTruncated, and this tool's own summary says "projection cut". Ask for the next window (from/limit, offset) - never retry the same call expecting more.
- list with NO "search" key is an unfiltered listing; the "search" KEY is a free-text filter and is NOT the search verb. search needs a non-empty query, and answers matchedIn: "title" (the title lane matched, so the text was never scanned for that term) or "text".
- create mints the paragraph ids you see in createdIds, in order; a pinned id in content must be a uuid the store does not already hold. In setParagraphs, ABSENT means UNCHANGED: rewrite text alone and the paragraph keeps its stored tags and refs; send tags: [] or refs: [] to clear them. modify answers one key per KIND of change that happened (changedIds / noopIds / movedIds / createdIds / removedIds / articleFields) and noop: true when nothing moved.
- remove answers with the deleted article plus danglingRefs, and that list is the WHOLE store's unresolvable reference targets - every link that no longer resolves, including links that were already dangling before this call. Read it as a survey of the base ("what points at what is missing"), not as a count of what this removal broke.

CODES: EKNOWLEDGE_INPUT (wrong type, unknown key, impossible combination, missing required key), EKNOWLEDGE_ID (not a uuid, or one id named twice), EKNOWLEDGE_REV (stale expects), EKNOWLEDGE_LIMIT (a bound: store size, text, tags, refs, items, limit, or paged past rank 50), EKNOWLEDGE_REF (a reference target does not exist), EKNOWLEDGE_NOT_FOUND (no such article or paragraph).`,
    tags: ['knowledge', 'article', 'articles', 'search', 'read', 'edit', 'reference'],
    // `searchable`, exactly like the other store entries (records.tool.ts:51, locations.tool.ts:21):
    // it is NOT in the always-declared projection (`alwaysDeclared: false` below), so a model reaches
    // it by name through `toolRequest` discovery — these tags are how that query matches — instead
    // of the provider paying this entry's description and schema on every request of every session.
    // The entries that must be callable on turn one are `core` (tasks.tool.ts:53,
    // toolRequest.tool.ts:27); a base the agent asks for when it wants one is not that kind of tool.
    // The value is stated rather than defaulted: absent means the same thing (src/core/tool.ts:130),
    // and `CoreToolMetadata` requires a core entry to name it (src/core/tool-metadata.ts:52).
    visibility: 'searchable',
    parameters: {
        type: 'object',
        // ONE object-valued property: that is what makes the harness unwrap it
        // (src/core/schema-validation.ts:1148-1164), so BOTH `{ operation: {...} }` and the
        // operation's own keys at the top level arrive at the engine. `operation` is
        // deliberately NOT `required`: an argument-less call is `{}`, which means `list`.
        properties: {
            operation: {
                type: 'object',
                description:
                    'The operation to run. Its verb selects the rules; the engine refuses an unknown key by name rather than dropping it. An omitted operation lists the newest articles.',
                properties: {
                    verb: {
                        type: 'string',
                        enum: ['list', 'search', 'read', 'create', 'modify', 'remove'],
                        description:
                            'Which operation. Omitted means "list" - the newest articles first. Keys that belong to another verb are refused by name (EKNOWLEDGE_INPUT), never ignored.'
                    },
                    // --- list (a page of article metadata) ---
                    // `search` is a FILTER KEY of list and `search` is also a VERB: that collision
                    // is the engine's (src/types/index.ts:2471-2476) and the description above
                    // teaches it, because the schema cannot say "required when verb is search".
                    search: {
                        type: 'string',
                        description:
                            'list only: case-insensitive substring of a title or paragraph text. Not the search verb; search needs "query".'
                    },
                    // The engine's own query bound: `KNOWLEDGE_MAX_TEXT` characters (4000,
                    // src/core/knowledge.ts:1905-1911) — "search for a phrase, not for a document".
                    // Both lanes are declared, because this union schema is what the validator
                    // CLOSES: with `additionalProperties: false` (src/core/schema-validation.ts:221)
                    // a missing `query` here would reject the `search` verb's REQUIRED field before
                    // the engine ever saw the call.
                    query: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 4000,
                        description:
                            'search only: required, 1-4000 characters — the words to rank against titles and paragraph text. "list" takes no query; it has the "search" filter key instead.'
                    },
                    // `tag` (singular, an array) is the engine's key on BOTH page verbs
                    // (`OPERATION_KEYS`, src/core/knowledge.ts:316-333) — the accepted-key list
                    // forbids `tags` here. `tags` belongs to create, and addTags/removeTags to
                    // modify (the same list).
                    // BOUND: KNOWLEDGE_MAX_TAGS (16) / KNOWLEDGE_MAX_TAG (64). The `tag` filter is
                    // read by the SAME reader as create's `tags` — `readTags(label, 'tag', …)`
                    // (src/core/knowledge.ts:1923 → :557-569) — so a 17th entry is an
                    // EKNOWLEDGE_LIMIT the engine pays for, not a schema rejection. It used to say
                    // 64 (KNOWLEDGE_MAX_ITEMS, the id-list bound), which is a different axis.
                    tag: {
                        type: 'array',
                        items: { type: 'string', maxLength: 64 },
                        maxItems: 16,
                        description:
                            'list/search only: keep articles carrying one of these tags (case-folded). At most 16 entries, 64 characters each — the same 16 an article may carry.'
                    },
                    // ONE property serves THREE verbs (`limit` is in OPERATION_KEYS.list, .search
                    // AND .read, src/core/knowledge.ts:316-334), and the validator has no `if`/
                    // `then` vocabulary (src/core/schema-validation.ts:122, :200, :221; the same
                    // note at src/tools/files/read.tool.ts:53), so ONE number must be right for all
                    // three. The engine's two bounds differ:
                    //   - list/search: `readLimitArgument` accepts 1-100 (KNOWLEDGE_LIST_MAX_LIMIT,
                    //     src/core/knowledge.ts:467-478);
                    //   - read:        `readWindowLimitArgument` accepts 1-64 (KNOWLEDGE_MAX_PARAGRAPHS,
                    //     src/core/knowledge.ts:496-507), because a read window is a slice of ONE
                    //     article and an article holds 64 paragraphs.
                    // The shared ceiling is therefore the SMALLEST bound that is safe for every
                    // verb: 64. Reading 65-100 paragraphs in one call is impossible anyway (the
                    // article does not hold them), so nothing a caller could act on is lost, while
                    // the previous 100 let a `read { limit: 65 }` pass the schema and then be
                    // refused late by the engine — the one direction this schema may not go.
                    // `list` is the verb that gives up rows here (100 → 64 per call); it is the
                    // least costly loss, because the store holds 100 articles and a 24576-byte
                    // response cannot carry a 100-row page of metadata anyway.
                    // rank ≤ 50 is KNOWLEDGE_MAX_SEARCH, a WINDOW (`offset + limit <= 50`) that
                    // `checkSearchDepth` runs for the SEARCH verb ONLY (src/core/knowledge.ts:1927);
                    // it is not a row count, which is why the description spells the relation out.
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 64,
                        description:
                            'list/search/read: rows (page verbs) or paragraphs (read) per call, 1-64 — one bound, because one property serves all three and the read window is the tightest. list/search default to 20; `search` also keeps offset + limit within the 50-row rank window.'
                    },
                    offset: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'list/search only: rows to skip. On `search`, offset + limit must stay within the 50-row rank window; `list` has no rank ceiling — it pages the whole store.'
                    },
                    // --- read ---
                    id: {
                        type: 'string',
                        description:
                            'read/modify/remove only: the article id, exactly as list, search or create reported it (uuid, case-folded).'
                    },
                    // `paragraphs` is a SELECTION (a set of ids, unordered); `from`/`limit` are an
                    // ordered window (src/types/index.ts:2479). A selection names ids and therefore
                    // reports `truncated` without inventing an offset (types/index.ts:2574-2578).
                    paragraphs: {
                        type: 'array',
                        items: { type: 'string' },
                        maxItems: 64,
                        description:
                            'read only: whole paragraphs by paragraph id (a selection, not a window). Unknown paragraph ids are refused. At most 64.'
                    },
                    from: {
                        type: 'integer',
                        minimum: 0,
                        description: 'read only: paragraph index to start the window at (0 is the first).'
                    },
                    outline: {
                        type: 'boolean',
                        description:
                            'read only: answer with one row per paragraph (id, rev, chars, tags) and NO text - the step between a page row and the text itself.'
                    },
                    // --- create ---
                    title: {
                        type: 'string',
                        maxLength: 200,
                        description: 'create: required, 1-200 characters. modify: optional replacement title.'
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string', maxLength: 64 },
                        maxItems: 16,
                        description:
                            'create only: at most 16 tags, 64 characters each (case-preserved, matched case-folded).'
                    },
                    // The engine takes a bare string OR an object carrying text/tags/refs/id
                    // (KnowledgeContentInput, src/types/index.ts:2462-2470); a bare object is not
                    // refused — empty fields drop and a non-empty unknown key is
                    // EKNOWLEDGE_INPUT (src/core/knowledge.ts:756-777, :839).
                    content: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    properties: {
                                        text: { type: 'string', maxLength: 4000 },
                                        tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 16 },
                                        refs: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    articleId: { type: 'string' },
                                                    paragraphId: { type: 'string' },
                                                    note: { type: 'string', maxLength: 500 }
                                                },
                                                required: ['articleId'],
                                                additionalProperties: false
                                            },
                                            maxItems: 16
                                        },
                                        id: { type: 'string' }
                                    },
                                    additionalProperties: false
                                }
                            ]
                        },
                        maxItems: 64,
                        description:
                            'create only: the paragraphs, in order — a bare string, or { text, tags, refs, id }. At most 64; `id` pins an id the store does not hold yet. modify uses addContent instead.'
                    },
                    // --- modify ---
                    addTags: {
                        type: 'array',
                        items: { type: 'string', maxLength: 64 },
                        maxItems: 64,
                        description: 'modify only: tags to add (the result still has to fit 16 tags of 64 characters).'
                    },
                    removeTags: {
                        type: 'array',
                        items: { type: 'string', maxLength: 64 },
                        maxItems: 64,
                        description:
                            'modify only: tags to remove; unknown tags are reported in noopIds-style refusals rather than failing the call.'
                    },
                    addContent: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    properties: {
                                        text: { type: 'string', maxLength: 4000 },
                                        tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 16 },
                                        refs: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    articleId: { type: 'string' },
                                                    paragraphId: { type: 'string' },
                                                    note: { type: 'string', maxLength: 500 }
                                                },
                                                required: ['articleId'],
                                                additionalProperties: false
                                            },
                                            maxItems: 16
                                        },
                                        id: { type: 'string' }
                                    },
                                    additionalProperties: false
                                }
                            ]
                        },
                        maxItems: 64,
                        description:
                            'modify only: paragraphs to APPEND, same item shape as content. At most 64, and the article still has to fit 64 paragraphs.'
                    },
                    setParagraphs: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                text: { type: 'string', maxLength: 4000 },
                                tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 16 },
                                refs: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            articleId: { type: 'string' },
                                            paragraphId: { type: 'string' },
                                            note: { type: 'string', maxLength: 500 }
                                        },
                                        required: ['articleId'],
                                        additionalProperties: false
                                    },
                                    maxItems: 16
                                }
                            },
                            required: ['id'],
                            additionalProperties: false
                        },
                        maxItems: 64,
                        // ABSENT ≠ EMPTY, and the model has to be told: the engine keeps an omitted
                        // `tags`/`refs` exactly as stored and CLEARS it only when the key is present
                        // with `[]` (`readSetItems` carries absent-vs-present through as
                        // `hasTags`/`hasRefs`, src/core/knowledge.ts:799-847, applied at :2138-2165).
                        // "Replaces that paragraph" would teach the opposite — a text-only rewrite
                        // that silently dropped the stored tags.
                        description:
                            'modify only: rewrite a paragraph by id. `text`, `tags` and `refs` are each optional, and ABSENT means UNCHANGED: send only `text` and the paragraph keeps its stored tags and refs; send `tags: []` or `refs: []` to CLEAR them. A rewrite that changes nothing reports the id in noopIds and bumps no rev. At most 64.'
                    },
                    moveParagraphs: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                before: { type: 'string' }
                            },
                            required: ['id'],
                            additionalProperties: false
                        },
                        maxItems: 64,
                        description:
                            'modify only: MOVE a paragraph before another one (`before` omitted means last). A move bumps no paragraph rev — movedIds is the only place it is visible. At most 64.'
                    },
                    removeParagraphs: {
                        type: 'array',
                        items: { type: 'string' },
                        maxItems: 64,
                        description: 'modify only: paragraph ids to delete. At most 64.'
                    },
                    // `expects` is the CAS token list — article grain, one entry per article
                    // (KnowledgeExpect, src/types/index.ts:2452-2454).
                    // THE ONE PLACE THE SCHEMA IS THE TIGHTER HALF, and it is deliberate: the
                    // engine's own array bound is KNOWLEDGE_MAX_ITEMS (64) —
                    // `readExpects`, src/core/knowledge.ts:893-905 — but a CALL writes exactly one
                    // article, so more than one token can only ever be (a) a duplicate of the same
                    // id, which `readExpects` collapses to one entry (:930-942), or (b) a token for
                    // a DIFFERENT id, which `checkExpects` refuses with EKNOWLEDGE_INPUT, "One
                    // article per call — send a second call for the other"
                    // (src/core/knowledge.ts:2020-2036, called at :2062 and :2363). So exactly one
                    // entry is everything the engine will honour through one call: a multi-paragraph
                    // CAS is ONE token here, not several, because a paragraph edit moves the
                    // article's `rev` too. No expressible intent is lost; what the schema gives up is
                    // only inputs the engine would fold or refuse.
                    expects: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                // minimum 1 mirrors the engine's own floor: rev 0 is refused as
                                // "not a revision the engine ever mints" (core/knowledge.ts:925), so the
                                // schema rejects it up front instead of paying for a runtime round-trip.
                                rev: { type: 'integer', minimum: 1 }
                            },
                            required: ['id', 'rev'],
                            additionalProperties: false
                        },
                        // Deliberately TIGHTER than the engine's array bound (64, `readExpects`,
                        // src/core/knowledge.ts:900): one call guards one article, so one token is
                        // the whole engine-honoured capability here (see the block above).
                        maxItems: 1,
                        description:
                            'modify/remove only: [{ id: <article id>, rev: <the rev you last read> }] — one token, article grain. A stale token is refused EKNOWLEDGE_REV with the CURRENT article attached; omit it to write unconditionally and risk another thread.'
                    }
                },
                additionalProperties: false
            }
        },
        additionalProperties: false
    }
};

// Canonical discovery export: an alias in the same file, which the AST scanner follows
// (core/tool-discovery.ts, and src/tools/runtime/threadDelete.tool.ts:256-259 for the idiom).
export const metadata = KNOWLEDGE_METADATA;

// Harness registration policy (T19/R9). A SEPARATE literal from `metadata`: these fields are
// harness bookkeeping, never part of the Tool wire contract. The row is the record-family row
// (src/tools/runtime/records.tool.ts:305-312 order 55, tasks 60, profiles 70, chapters 80,
// locations.tool.ts:180-187 order 90) — same group, activation, and flags — because knowledge is
// the same kind of entry: it needs the live session harness to answer at all. Field meanings are
// the ones src/core/tool-metadata.ts:95-131 declares; the bullets below say why THIS value is
// right for this tool, and the generator copies them into src/core/tool-manifest.ts verbatim
// (`yarn tools:manifest`, enforced by `yarn tools:manifest:check`).
//
//   group 'runtime'    — the entry reads `context.harness`, so it is a harness-owned entry, not a
//                        preset (the two package groups core/tool-metadata.ts allows; presets carry
//                        no session context).
//   activation 'always'— registered in every build, whatever the host configures: the base exists
//                        whether or not a session has used it, and `harness()` always has an engine
//                        behind the seam (src/types/index.ts:4821-4824).
//   alwaysDeclared false— NOT part of the always-declared projection, which is exactly
//                        `BUILTIN_TOOL_DESCRIPTORS.filter(d => d.alwaysDeclared === true)`
//                        (src/core/metadata.ts:282). Paired with `visibility: 'searchable'` this is
//                        the records/tasks discovery posture: the model enables it by name through
//                        `toolRequest` when it wants the base, and every other session keeps paying
//                        nothing for a store it never touches.
//   sessionBound true  — "needs a live session harness; the server gates manual calls on a
//                        sessionId" (core/tool-metadata.ts:116-117). The base itself is
//                        deployment-scoped and is never session state (src/types/index.ts:4833-4843
//                        — no snapshot, no reset, no dispose by one session), but the CALL needs a
//                        harness to get the seam from, so a session-less global call is refused with
//                        the pointer to the session route (src/server/api.ts:2749-2754) rather than
//                        running against a harness that does not exist.
//   listed true        — the server's direct-call catalogue row (core/tool-metadata.ts:118-119),
//                        like records' and tasks': an operator can read and write the base from the
//                        Tools UI through a session, and a knowledge article is meaningful outside
//                        the session that wrote it — which is precisely why threadDelete is NOT
//                        listed (threadDelete.tool.ts:116-117: its release needs caller lineage).
//   order 95           — after the five record stores (55/60/70/80/90) and before agentManage 100:
//                        the per-session stores first, the cross-session store last among them, in
//                        the reading order an operator wants when listing /tools. Registration order
//                        only (core/tool-metadata.ts:106-108); it changes no budget and no
//                        capability, and the gap after 90 exists for exactly this insertion.
//   `mode` omitted      — the documented default IS 'sync' (src/core/tool.ts:85
//                        DEFAULT_TOOL_MODE), which is what the engine is: `KnowledgeEngine.execute`
//                        never awaits anything (src/types/index.ts:2725-2729 — the file layer is a
//                        SUBSCRIBER), so the answer is in the tool message of the same turn. The
//                        record family omits it the same way; the entries that state it
//                        (read/edit/download/search/fetch/threadDelete) do so to argue for 'sync'
//                        against an await, which is not a question this call raises.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 95,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

// ---------------------------------------------------------------------------
// The projection budget
// ---------------------------------------------------------------------------

// The cap the prose is cut to. It is `KNOWLEDGE_RESPONSE_BUDGET_BYTES` (
// src/core/knowledge.ts:199-211) restated as a literal, and the reason it cannot be imported is
// the source compiler's live-module boundary: a `.tool.ts` entry resolves `../../core` to the LIVE
// framework namespace the compiler assembles by hand (`LIVE_MODULE_KEYS`,
// src/core/tool-source.ts:504-523; the namespace itself :463-499), and that namespace covers
// agent/tool/discovery/creation/result-budget/schema-validation/task/profile/chapter/location/
// snapshot/tool-ui/tool-media/tool-text/scheduler/metadata/action/branch/thread — NOT
// `core/knowledge`. An engine constant the compiled entry cannot link is worse than a literal it
// can, so knowledge.test.ts pins this figure against the engine's own export, which turns drift
// into a failing assertion instead of prose (the FILE_READ_ERROR_CODES precedent,
// src/tools/files/read.tool.ts:961). The other three imports used here (`tool`, `toolText`,
// `modelPayloadBytes`) ARE in that namespace: `toolApi`, `toolTextApi`, and `resultBudgetApi`,
// which re-exports `modelPayloadBytes` (src/core/result-budget.ts:116-118).
const KNOWLEDGE_PROJECTION_BUDGET_BYTES = 24 * 1024;

// What the cut note may cost. The byte estimate below prices a note field of roughly this length
// into EVERY projection, so adding the real note afterwards cannot push the object back over the
// cap — the reserve is what makes "cut to the budget" and "say that it was cut" compatible.
const KNOWLEDGE_PROJECTION_NOTE_RESERVE_BYTES = 512;

// A representative cut note, used only to price the note field inside the byte estimate.
const KNOWLEDGE_PROJECTION_NOTE_SAMPLE =
    'Projection cut for the 24576-byte model budget: 12 of 64 articles not shown (the tail was dropped); narrow the call or ask for the next window.';

// One row always survives the cut. A paragraph body is at most KNOWLEDGE_MAX_TEXT characters
// (4000, src/core/knowledge.ts), i.e. ~4 KiB escaped, so a single row can never break the cap
// by itself and "keep at least one" costs the model nothing it did not already pay.
const KNOWLEDGE_PROJECTION_MIN_ROWS = 1;

// One reference, with the link target but not the prose reason: `note` is up to
// KNOWLEDGE_MAX_NOTE characters of commentary the model did not ask for
// (src/types/index.ts:2418-2424), and `content` keeps it.
const refTargetsOf = (refs: { articleId: string; paragraphId?: string }[] | undefined) =>
    refs === undefined
        ? undefined
        : refs.map((ref) => ({
              articleId: ref.articleId,
              ...(ref.paragraphId === undefined ? {} : { paragraphId: ref.paragraphId })
          }));

// The paging fields, projected as the engine answers them: `hasMore` always, `nextOffset` and
// `budgetTruncated` only when set (src/types/index.ts:2540-2548). Dropping `hasMore` would be
// the classic lossy projection — it is the field that tells the model the listing continues.
const pageInfoOf = (page: KnowledgePageInfo) => ({
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    ...(page.budgetTruncated === undefined ? {} : { budgetTruncated: page.budgetTruncated })
});

// Halving cut: keeps the FIRST `kept` projected rows (the engine's own order, which for the page
// verbs is the rank order the caller paged through, so a cut page still reads as a prefix of it)
// until the projection — priced WITH a note and WITH the verb's other fields (`shell`) — fits the
// cap. Rows are always dropped from the TAIL, and the count is reported, because a projection
// that silently drops a row is a projection the model misreads as the whole result.
const fitProjectionRows = <TItem>(
    items: readonly TItem[],
    rowOf: (item: TItem) => unknown,
    listKey: string,
    shell: Record<string, unknown>
): { rows: unknown[]; omitted: number } => {
    const rows = items.map(rowOf);
    let kept = rows.length;

    // The estimate is the REAL projection object (the verb's other fields plus the list), priced
    // in `modelPayloadBytes` — the ESCAPED payload bytes, the only figure the model pays, and the
    // currency the engine measures its own cap in. It takes a serialized string
    // (src/core/payload-bytes.ts:72), hence `JSON.stringify`. The sample note is always counted,
    // so a projection that needs no note has already reserved the bytes it will never spend.
    const estimate = (count: number): number =>
        modelPayloadBytes(
            JSON.stringify({
                ...shell,
                [listKey]: rows.slice(0, count),
                note: KNOWLEDGE_PROJECTION_NOTE_SAMPLE
            })
        );

    // Halving converges in log2(rows) steps — at most 6 measurements at the 64-row bound.
    while (
        kept > KNOWLEDGE_PROJECTION_MIN_ROWS &&
        estimate(kept) > KNOWLEDGE_PROJECTION_BUDGET_BYTES - KNOWLEDGE_PROJECTION_NOTE_RESERVE_BYTES
    ) {
        kept = Math.max(KNOWLEDGE_PROJECTION_MIN_ROWS, Math.floor(kept / 2));
    }

    return { rows: rows.slice(0, kept), omitted: rows.length - kept };
};

// The cut note itself. It names the remedy, because "ask for less" without the knob that does it
// sends the model back through the description mid-turn.
const cutNoteOf = (omitted: number, total: number, listKey: string, remedy: string) =>
    `Projection cut for the ${KNOWLEDGE_PROJECTION_BUDGET_BYTES}-byte model budget: ${omitted} of ${total} ${listKey} not shown (the tail was dropped); ${remedy}`;

// ---------------------------------------------------------------------------
// Per-verb projections
// ---------------------------------------------------------------------------
//
// Each takes the narrowed engine result and answers the model's next question, keeping the
// fields a caller ACTS on (ids, revs, counts, paging) and dropping the fields it merely reads
// (timestamps, reference notes, bodies the call did not ask for). Everything dropped is still in
// `content`, which is the untouched engine result.

// `list` — one row per article plus the whole-matched-set count (`counts.total` is the engine's
// F9 rule: paging must not hide how much is out there, src/types/index.ts:2549-2553).
const projectPage = (result: KnowledgePageResult, matchedIn?: string) => {
    const shell = {
        ...(matchedIn === undefined ? {} : { matchedIn }),
        total: result.counts.total,
        page: pageInfoOf(result.page)
    };
    const fitted = fitProjectionRows(
        result.articles,
        (article: KnowledgeArticleSummary) => ({
            id: article.id,
            title: article.title,
            tags: article.tags,
            rev: article.rev,
            paragraphCount: article.paragraphCount
        }),
        'articles',
        shell
    );

    return {
        ...shell,
        ...(fitted.omitted === 0
            ? {}
            : {
                  note: cutNoteOf(
                      fitted.omitted,
                      result.articles.length,
                      'articles',
                      'narrow the call or ask for the next window (offset)'
                  ),
                  omitted: fitted.omitted
              }),
        articles: fitted.rows
    };
};

// `read` — the article identity first (id + rev are the write guard), then whatever text the
// call asked for. The three response modes are distinguished exactly as the engine shapes them:
// an `outline` (no text), a window/selection (which reports `truncated`/`totalParagraphs`), or
// the whole article (src/types/index.ts:2566-2598). `paragraphCount` is ALWAYS the article's
// total; `totalParagraphs` is the same figure in the shape a paging loop reads, and only for a
// subset — restating it in the projection would be two numbers for one fact, so the projection
// keeps the engine's own pair and adds nothing.
const projectRead = (result: KnowledgeReadResult) => {
    const identity = {
        id: result.id,
        title: result.title,
        tags: result.tags,
        rev: result.rev,
        paragraphCount: result.paragraphCount,
        ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
        ...(result.budgetTruncated === undefined ? {} : { budgetTruncated: result.budgetTruncated }),
        ...(result.totalParagraphs === undefined ? {} : { totalParagraphs: result.totalParagraphs }),
        ...(result.from === undefined ? {} : { from: result.from }),
        ...(result.limit === undefined ? {} : { limit: result.limit }),
        ...(result.danglingRefs === undefined || result.danglingRefs.length === 0
            ? {}
            : { danglingRefs: result.danglingRefs })
    };

    // An outline answer: ids, revs and sizes only — that IS the point of the mode
    // (src/types/index.ts:2527-2534), so the rows are already minimal and an outline of 64 rows
    // is ~1 KiB. The fit is still applied so the cap means the same thing for every verb.
    if (result.outline !== undefined) {
        const fitted = fitProjectionRows(
            result.outline,
            (entry) => ({
                id: entry.id,
                rev: entry.rev,
                chars: entry.chars,
                ...(entry.tags === undefined ? {} : { tags: entry.tags })
            }),
            'outline',
            identity
        );

        return {
            ...identity,
            ...(fitted.omitted === 0
                ? {}
                : {
                      note: cutNoteOf(
                          fitted.omitted,
                          result.outline.length,
                          'outline rows',
                          'read paragraphs by id or with from/limit'
                      ),
                      omitted: fitted.omitted
                  }),
            outline: fitted.rows
        };
    }

    // A text answer: the paragraph bodies are the payload, and one paragraph can be 4000
    // characters, so this is the projection that actually needs the cut. `chars` is dropped
    // (the model can count the text it is being handed); `refs` keeps only its targets.
    const paragraphs = result.paragraphs ?? [];
    const fitted = fitProjectionRows(
        paragraphs,
        (paragraph) => {
            const refs = refTargetsOf(paragraph.refs);

            return {
                id: paragraph.id,
                rev: paragraph.rev,
                text: paragraph.text,
                ...(paragraph.tags === undefined ? {} : { tags: paragraph.tags }),
                ...(refs === undefined ? {} : { refs })
            };
        },
        'paragraphs',
        identity
    );

    return {
        ...identity,
        ...(fitted.omitted === 0
            ? {}
            : {
                  note: cutNoteOf(
                      fitted.omitted,
                      paragraphs.length,
                      'paragraphs',
                      'ask for the next window (from/limit) or the paragraph ids you still need'
                  ),
                  omitted: fitted.omitted
              }),
        ...(result.paragraphs === undefined ? {} : { paragraphs: fitted.rows })
    };
};

// `create` / `modify` — the committed identity plus the id lists. The article BODIES are not in
// the projection at all: the engine answers writes with the whole article (create
// src/types/index.ts:2599-2605, modify :2626-2635), which is up to 64 × 4000 characters of text
// the model just wrote — 256 KiB in the worst case, 10× the cap the tool exists to protect. The
// model needs `id`, the fresh `rev` (the next write's token), `paragraphCount`, and which
// paragraphs moved; `content.article` carries every body for the API and for a host that wants
// the receipt.
const projectWrite = (article: KnowledgeArticle, changes: Record<string, unknown>, createdIds?: readonly string[]) => {
    const identity = {
        id: article.id,
        title: article.title,
        tags: article.tags,
        rev: article.rev,
        paragraphCount: article.content.length
    };
    const shell = { ...identity, ...changes };

    // The change lists are id lists (at most 64 uuids each), so the projection is bounded by the
    // engine's own item caps — the fit exists to prove it rather than to assert it.
    const fitted = fitProjectionRows(createdIds ?? [], (id: string) => id, 'createdIds', shell);

    return {
        ...shell,
        ...(createdIds === undefined
            ? {}
            : {
                  ...(fitted.omitted === 0
                      ? {}
                      : {
                            note: cutNoteOf(
                                fitted.omitted,
                                createdIds.length,
                                'createdIds',
                                'read the article for the rest'
                            ),
                            omitted: fitted.omitted,
                            createdCount: createdIds.length
                        }),
                  createdIds: fitted.rows
              })
    };
};

// `modify` answers ONE KEY PER KIND of change, present whenever that kind happened at all
// (src/types/index.ts:2616-2635: a caller branches on the key, never on a count). The projection
// keeps that discipline exactly — it forwards the keys rather than flattening them into counts,
// because "which kind of change happened" IS the answer.
const projectModify = (result: KnowledgeModifyResult) =>
    projectWrite(
        result.article,
        {
            ...(result.articleFields === undefined ? {} : { articleFields: result.articleFields }),
            ...(result.changedIds === undefined ? {} : { changedIds: result.changedIds }),
            ...(result.noopIds === undefined ? {} : { noopIds: result.noopIds }),
            ...(result.movedIds === undefined ? {} : { movedIds: result.movedIds }),
            ...(result.removedIds === undefined ? {} : { removedIds: result.removedIds }),
            noop: result.noop,
            ...(result.danglingRefs === undefined || result.danglingRefs.length === 0
                ? {}
                : { danglingRefs: result.danglingRefs })
        },
        result.createdIds
    );

// `remove` — the deleted article as a summary, plus the store's WHOLE standing set of
// unresolvable reference targets. `danglingRefs` is the part a caller cannot get any other way
// (the targets live in OTHER articles, src/types/index.ts:2627-2630), so it is projected even
// though it is noise-shaped: uuids. Read it as a survey, not as a diff: the engine computes it
// over EVERY article (`danglingAcrossStore`, src/core/knowledge.ts:1543-1548, called at :2375),
// so it also lists links that were already dangling before this call removed anything — which is
// the useful reading, because the caller's next question is "what else in this base points at
// what I just deleted?". It is bounded by the store, and the fit cuts its tail with a note if it
// is huge.
const projectRemove = (result: KnowledgeRemoveResult) => {
    const removed = result.removed;
    const shell = {
        removed: {
            id: removed.id,
            title: removed.title,
            tags: removed.tags,
            rev: removed.rev,
            paragraphCount: removed.paragraphCount
        },
        danglingCount: result.danglingRefs.length
    };
    const fitted = fitProjectionRows(result.danglingRefs, (target: string) => target, 'danglingRefs', shell);

    return {
        ...shell,
        ...(fitted.omitted === 0
            ? {}
            : {
                  note: cutNoteOf(
                      fitted.omitted,
                      result.danglingRefs.length,
                      'danglingRefs',
                      'the full list is in the machine result'
                  ),
                  omitted: fitted.omitted
              }),
        ...(result.danglingRefs.length === 0 ? {} : { danglingRefs: fitted.rows })
    };
};

// The router: engine result -> the prose the transcript carries. Casts here are the narrowing
// the OPERATION already performed — the engine answers a verb with its own result type
// (`KnowledgeResultFor`, src/types/index.ts:2645-2658), so a verb switch on the operation
// determines the result shape; the union type cannot see it.
const projectResult = (operation: KnowledgeOperation, result: KnowledgeResult): string => {
    switch (operation.verb) {
        case 'list':
            return JSON.stringify(projectPage(result as KnowledgePageResult));
        case 'search':
            // `matchedIn` is the honest statement of WHICH lane answered (title matches
            // short-circuit the text scan, src/types/index.ts:2556-2561) — never drop it.
            return JSON.stringify(
                projectPage(result as KnowledgeSearchResult, (result as KnowledgeSearchResult).matchedIn)
            );
        case 'read':
            return JSON.stringify(projectRead(result as KnowledgeReadResult));
        case 'create': {
            const created = result as { article: KnowledgeArticle; createdIds: string[] };

            return JSON.stringify(projectWrite(created.article, {}, created.createdIds));
        }
        case 'modify':
            return JSON.stringify(projectModify(result as KnowledgeModifyResult));
        default:
            return JSON.stringify(projectRemove(result as KnowledgeRemoveResult));
    }
};

// ---------------------------------------------------------------------------
// The routed call
// ---------------------------------------------------------------------------

export const execute = (context: ToolContext) => {
    // The seam (see the header). The union is resolved by SHAPE, exactly as the type layer
    // documents it: a store-shaped member carries `engine` (the durable half,
    // src/types/index.ts:2779-2796), and a bare `KnowledgeEngine` — which declares no `engine`
    // member (src/types/index.ts:2724-2750) — IS the engine. `'engine' in seam` is the exact
    // discriminator, but it needs the object guard FIRST: `in` against `null` throws a bare
    // TypeError, and a tool that crashes on a configuration shape is worse than one that refuses
    // it by name. `harness()` never sets `knowledge: null` (the member is `readonly` and always
    // built), but a hand-built context can, and a lane worker's guarded view passes the seam
    // through untouched (src/types/index.ts:4925-4927). Durability itself is not this entry's
    // concern: it writes through the engine either way.
    const seam = context.harness?.knowledge;
    // A seam is USABLE when it is an object; anything else (no harness, `knowledge: undefined`,
    // `null`, a string a host mis-assigned) means "this host has no base" and gets the first
    // sentence. `Array.isArray` is part of the guard because an array is `typeof 'object'` and
    // would otherwise reach `engine.execute` and fail as a TypeError. The condition is INLINED in
    // the ternary (rather than reusing the const) so TypeScript narrows `seam` to an object before
    // `'engine' in seam`, which is the one place the discriminator needs the narrowing.
    const seamIsObject = typeof seam === 'object' && seam !== null && !Array.isArray(seam);
    const engine: KnowledgeEngine | undefined =
        typeof seam === 'object' && seam !== null && !Array.isArray(seam)
            ? 'engine' in seam
                ? seam.engine
                : (seam as KnowledgeEngine)
            : undefined;

    // The one refusal this entry owns: no seam means no base, which is a host-configuration
    // statement, not an empty store. `EKNOWLEDGE_INPUT` is the engine's own argument-shape code
    // (src/core/knowledge.ts:241-250) — reusing it keeps every knowledge refusal greppable under
    // one prefix, which is what the model's description promises.
    if (!seamIsObject) {
        throw new HarnessError(
            'knowledge requires a knowledge base, and this harness has none (no Harness.knowledge seam).',
            { code: 'EKNOWLEDGE_INPUT' }
        );
    }

    // The seam OBJECT exists but does not carry a callable engine: `{ engine: null }`, a store
    // built without one, or a plain `{}` handed to a hand-built context. The second sentence names
    // the difference, because "no base" and "a base with nothing behind it" need different fixes —
    // the first is the harness configuration, the second is whatever mounted the store. Checking
    // `execute` rather than `undefined` is what makes this total: a store-shaped seam whose
    // `engine` is `null` would otherwise crash inside the engine call as an uncoded TypeError,
    // and the harness can only relay a code to the model when the error carries one.
    const resolved = engine as KnowledgeEngine | null | undefined;

    if (
        resolved === undefined ||
        resolved === null ||
        typeof (resolved as { execute?: unknown }).execute !== 'function'
    ) {
        throw new HarnessError(
            'knowledge requires a knowledge base, and this harness has none (Harness.knowledge carries no engine).',
            { code: 'EKNOWLEDGE_INPUT' }
        );
    }

    // WHICH OBJECT IS THE OPERATION. With ONE object-valued property, `toolParameterKey`
    // (src/core/tool.ts:65-73) names `operation`, and `resolveToolParameters` hands `execute` the
    // UNWRAPPED value on every path:
    //   - model:   `{ "operation": { verb: "list" } }` is validated as the wrapper and delivered as
    //              `raw[key]`, so `execute` sees `{ verb: 'list' }` (src/core/schema-validation.ts
    //              :383-386) — the wrapper NEVER reaches this function from the model;
    //   - direct:  the legacy unwrapped value is tried FIRST and re-wrapped only when that fails,
    //              so `executeTool('knowledge', { verb: 'list' })` and
    //              `executeTool('knowledge', { operation: { verb: 'list' } })` arrive identically
    //              (src/core/schema-validation.ts:405-418);
    //   - nothing: an empty argument box returns the single property's value, i.e. `undefined`
    //              (src/core/schema-validation.ts:400-410) — precisely the "use the default" case,
    //              which this tool answers with a listing.
    // So the object in `context.parameters` IS the operation. A nested `operation` key is the
    // defensive shape only: a host that calls `execute` directly with the wrapper, bypassing the
    // validator. Preferring it is unambiguous because `operation` is a key of NO verb
    // (`OPERATION_KEYS`, src/core/knowledge.ts:316-333) — the engine would refuse it as a field, so
    // unwrapping is the only reading that can mean anything.
    //
    // A non-object is dropped rather than forwarded, which keeps the entry's behaviour total:
    // `knowledge(7)` and `knowledge([])` answer with a listing instead of reaching
    // `readOperationRecord`'s `knowledge takes a JSON object; received number.`
    // (src/core/knowledge.ts:364-374) — that refusal is right for a DIRECT engine caller, but the
    // harness validator has already rejected those shapes before this point, and a tool that
    // invents its own crash path for an argument it cannot receive is a tool that crashes on a
    // future refactor.
    const provided = context.parameters as unknown;
    const source =
        typeof provided === 'object' && provided !== null && !Array.isArray(provided)
            ? (provided as Record<string, unknown>)
            : {};
    const nested = source.operation;
    const fields = (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : source) as unknown as KnowledgeOperation;

    // `verb` is OPTIONAL on the wire but never on the way in: the engine routes only a verb in
    // `KNOWLEDGE_OPERATION_VERBS` and refuses anything else with `knowledge operations have a
    // "verb" of list | search | read | create | modify | remove; received undefined.`
    // (src/core/knowledge.ts:2384-2392). The tool's published default for an omitted verb is
    // `list` — the cheapest thing to answer, and the question an argument-less call asks — so the
    // default is applied HERE, one step before the engine, and every other key rides along
    // untouched: `{ verb: 'list', limit: 10 }` pages exactly 10 rows.
    const normalized: KnowledgeOperation =
        typeof fields.verb === 'string'
            ? fields
            : ({ ...(fields as unknown as Record<string, unknown>), verb: 'list' } as unknown as KnowledgeOperation);

    // SYNCHRONOUS: `KnowledgeEngine.execute` never awaits anything (src/types/index.ts:2720-2729
    // — the file layer is a SUBSCRIBER, not a dependency), so this entry stays sync like the
    // default tool mode is (src/core/tool.ts:85).
    //
    // The CONTEXT travels with the operation: `execute(operation, context?)` accepts a ToolContext
    // and documents this entry as its caller (src/core/knowledge.ts). ONE trusted field is read:
    // `harness.knowledgeOwner` (the host-supplied canonical build identity) is stamped as
    // `KnowledgeArticle.harness` by `create`. `modify` edits a stored copy, so it PRESERVES the
    // original owner; every other verb ignores the context. This is attribution, not a model
    // input: `harness` is neither an operation key nor on the published schema, so the model can
    // neither forge an owner nor reassign an article.
    //
    // No try/catch: an engine refusal is a coded HarnessError whose `details` carry the recovery
    // payload — the current article for EKNOWLEDGE_REV (src/core/knowledge.ts:1305-1320), bounded
    // by KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES = 8192 (src/core/knowledge.ts:219) — and the harness
    // reports the code, the message and the details as the model's tool error
    // (src/harness.ts:13069). Catching here to re-word would destroy exactly the payload that makes
    // a stale write recoverable, and relabelling is what `translateRecordRejection`
    // (src/core/records.ts:4326-4348) exists to avoid doing correctly.
    const result = resolved.execute(normalized, context) as KnowledgeResult;

    // The branded pair (src/core/tool-text.ts:65, and src/tools/files/read.tool.ts:5142 for the
    // shipped shape): `content` is the machine view — the server response, a UI card, a host
    // threading the next `offset` — and the projection is what the transcript pays for.
    return toolText(result, projectResult(normalized, result));
};

// The callable form. A standalone/host registration (and the generated catalogue) resolves THIS
// export: `descriptors.ts:472` prefers `module[name]`, then `default`, then `tool`, and
// `core/tool.ts`'s builder is what makes it callable with either the wrapper shape or the bare
// operation object (`{ verb: 'list', limit: 10 }`) — the single-property unwrap resolves both to
// the same operation (src/core/tool.ts:592, :617-623, :852).
//
// One caveat the callable carries: the builder's callable takes the PARAMETER VALUE ONLY and builds
// its own context, `{ parameters: value }` (src/core/tool.ts:152-157). A direct call therefore has
// no `harness` member to read, and lands on the host-configuration refusal below — the same sentence
// a session with no knowledge base gets. Only the harness path (`executeTool`, and this file's
// `execute` when the framework hands it a real ToolContext) can carry a seam.
export const knowledge = tool<KnowledgeOperation, ToolTextEnvelope<KnowledgeResult>>({
    ...KNOWLEDGE_METADATA,
    execute
});
