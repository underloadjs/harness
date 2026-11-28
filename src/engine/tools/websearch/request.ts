// Shared HTTP plumbing for the search adapters.
//
// WHY THIS FILE EXISTS
// --------------------
// Exa, Tavily and Linkup differ only in endpoint, auth header, body keys, and
// result field names. Everything that is a *policy* — how long a request may take,
// how much of a response is accepted, what an error may say, how a URL is
// validated, how a snippet is truncated, how a configured key is redacted — lives
// here once so the adapters cannot drift. Every adapter is loaded by `import()`
// from ../websearch/index (and the fetch tool's hosted providers reuse this file),
// so importing this module costs no SDK and no network.
//
// Bounds (S1: "bounded normalized results"). These are constants, not knobs: the
// harness promises a small, predictable tool result, so a provider cannot flood
// the context or the process:
//   - 5 results by default, 20 maximum (the tool clamps the model's request);
//   - 1,000 characters of snippet per result, 300 of title, 64 of publication
//     date, and 2,048 characters of URL (a longer URL drops the row instead of
//     being truncated into a different link);
//   - 512 KiB of response body, enforced while streaming so an oversized body is
//     never allocated in full, plus a content-length pre-check. This is the
//     *provider transfer* budget and deliberately not the fetch tool's native page
//     budget (../webfetch/request caps a page GET at 1 MiB — `MAX_RESPONSE_BYTES`
//     there, 1,048,576): a search API returns a JSON list whose size it controls,
//     while a native GET faces the open web;
//   - 32 KiB (32,768 bytes) of DELIVERED result, enforced by ./index after
//     normalization (MAX_SEARCH_RESULT_BYTES + fitRowsToResultBudget below). The
//     transfer budget is 16x this number on purpose, and the ratio is the whole
//     point of the fit: a provider may hand back far more than the harness is
//     willing to put in front of a model, and READING it is not the same as being
//     able to DELIVER it. Without the fit, measured against the real core helpers:
//     20 rows with 1,000-character snippets and 1,000-character URLs serialize at
//     41,650 payload bytes, and 20 rows at every per-row cap at once (300-char
//     title, 2,048-char URL, 1,000-char snippet) at 67,970 — both over 32,768, so
//     the harness REFUSED the call outright (an oversized JSON document is never
//     slice-cut: core/result-budget.ts `boundToolResult` marks it
//     `rejected: { reason: 'oversized-json' }` and the run reports the call as
//     failed) — 16x the transfer cap looked safe and was not;
//   - 15 s per request, enforced with AbortController and cleaned up in `finally`,
//     and LINKED to the caller's per-call `ToolContext.signal` (F10) so a
//     `toolCancel` stops the request rather than only its delivery.
//
// Redaction order is a security property, not a style choice: every field is
// redacted FIRST and bounded second. Bounding first (the old behaviour) could cut
// a configured credential in half, leaving a prefix of the secret in the result at
// the truncation boundary. The delivery fit (fitRowsToResultBudget) preserves that
// property by construction: it runs LAST, on a result whose every field has already
// been redacted, and it removes content in only two ways — a row leaves WHOLE, or
// the last row's snippet is cut at a CODE-UNIT boundary. Either way the secret is
// long gone, replaced by `[redacted]`; at worst the marker itself is cut, which is
// the same property the per-field bounds already state (a marker is not a secret).
//
// Errors are sanitized on purpose: a provider status is reported, a provider
// body never is (it could echo the key or an unrelated secret), and a network
// failure is reduced to one fixed sentence. There is no retry and no failover:
// a 401/402/432/433 (auth/quota), 429, 5xx, or timeout is returned to the caller
// once, so a model cannot multiply spend by repeating a call it should not make.
//
// Returned excerpts are untrusted data from the open web. The tool marks them as
// excerpts in its description; it does not interpret them.
//
// Cross-references:
//   - ./exa        — Exa request body and result mapping
//   - ./tavily     — Tavily request body and result mapping
//   - ./linkup     — Linkup request body and result mapping
//   - ./index      — createWebsearchTool: key resolution, validation, dispatch,
//                    and the delivery fit that spends MAX_SEARCH_RESULT_BYTES
//   - ../webfetch/request — the fetch tool's own (1 MiB) page budget
//   - ../../core/result-budget.ts — MODEL_TOOL_RESULT_BUDGET_BYTES, the 32,768-byte
//                    cap this file's MAX_SEARCH_RESULT_BYTES is kept equal to, and
//                    boundToolResult, which REFUSES an oversized JSON document
//   - ../../core/payload-bytes.ts — modelPayloadBytes, the escaped-byte currency BOTH
//                    budgets are counted in (imported here rather than re-declared:
//                    this file is not a compiled tool entry, so the standalone-source
//                    rule that makes ../files/read.tool.ts write its literal does not
//                    apply, and one currency measured by one function cannot drift)
//   - ../tools/webdownload/download.tool.ts — the caller-signal linking pattern
//                    requestSearch copies for F10
//   - ../../util   — HarnessError (the message the model ends up reading)

// `clipPrefix` is the pair-safe bound every text field here passes through (T3, the
// lone-surrogate defect): the caps below are code-unit counts, so a plain `slice` could
// end a title or snippet on half of an emoji.
import { modelPayloadBytes } from '../../core';
import { clipPrefix, HarnessError } from '../../util';
import type { WebSearchMatch } from '../../types';

// Default result count when the model (or a direct caller) does not ask.
export const DEFAULT_MAX_RESULTS = 5;

// Hard ceiling. A larger `maxResults` is clamped, not rejected, so a model that
// asks for 100 still gets a useful answer instead of an error turn.
export const MAX_RESULTS_LIMIT = 20;

// Per-request budget. No retry: a timeout is reported once.
export const SEARCH_TIMEOUT_MS = 15_000;

// Response ceiling, in bytes (512 KiB). The body is read through a stream and the
// budget is checked per chunk, so a provider cannot force a full allocation first.
// Content-length is checked too, when the provider sends it.
//
// This is what is READ off the provider. It is NOT what can be delivered: that is
// MAX_SEARCH_RESULT_BYTES below, 16x smaller. The two numbers answer different
// questions (how much may this process ingest vs how much may a model read), and
// keeping only the big one is exactly what left the F2 defect latent: every shape
// the per-row caps allow could pass the transfer check and still be refused at
// delivery.
export const MAX_RESPONSE_BYTES = 512 * 1024;

// F2 — the DELIVERABLE ceiling, in model-facing (JSON-escaped) bytes.
//
// KEEP THIS EQUAL to `MODEL_TOOL_RESULT_BUDGET_BYTES` in ../../core/result-budget.ts
// (32,768): that is the cap the harness enforces on every tool result at delivery,
// and it measures an oversized JSON document by REFUSING it whole — no envelope, no
// slice, and the call reported as `isError`. A search result that exceeds it is
// therefore not "cut down", it is LOST, so ./index spends this budget itself and
// hands the harness something it cannot refuse.
//
// The value is written out rather than imported on purpose, following the
// ../files/read.tool.ts precedent (`FILE_READ_WIRE_BUDGET`): the number is a
// decision the tool must be able to state on its own, and websearch.test.ts pins the
// two constants equal (the same drift pin read.test.ts uses) instead of letting the
// equality rest on an import that a future refactor could drop. The CURRENCY, by
// contrast, is imported (`modelPayloadBytes` above): a re-declared byte table could
// drift silently, and a fit measured in the wrong unit is a fit that either wastes
// rows or still gets refused.
export const MAX_SEARCH_RESULT_BYTES = 32 * 1024;

export const MAX_TITLE_CHARS = 300;
export const MAX_SNIPPET_CHARS = 1_000;

// A provider date is a label, not free text: anything longer is dropped rather
// than emitted as a misleading "publication date".
export const MAX_PUBLISHED_CHARS = 64;

// A URL is a link the model is expected to cite. A URL longer than this cannot be
// truncated without corrupting it, so `validUrl` rejects the row instead.
export const MAX_URL_CHARS = 2_048;

// How a configured key is replaced when a provider echoes it back inside a
// snippet, title, or URL. Fixed text: the replacement must not hint at the value.
export const REDACTED = '[redacted]';

// Everything one adapter needs. `redact` is the harness-wide redactor built from
// every configured key (not just this provider's), so a response cannot leak a
// key belonging to the other provider either.
export type ProviderSearch = {
    query: string;
    maxResults: number;
    apiKey: string;
    redact: (text: string) => string;
    // F10 — the CALLER's per-call cancellation signal (`ToolContext.signal`, the
    // controller a `toolCancel` or a run abort fires). Optional because a direct
    // `search({ query })` call has none; an adapter passes it straight to
    // `requestSearch`, which links it into its own timeout controller. An adapter
    // that ignored it would keep a cancelled search running, and paying for it.
    signal?: AbortSignal;
    // Filters the caller asked for. Every adapter receives them; an adapter whose
    // provider has no equivalent sends what it can and ignores the rest, so one
    // argument surface works across providers rather than leaking one vendor's
    // vocabulary into the tool.
    includeDomains?: string[];
    excludeDomains?: string[];
    since?: string;
    until?: string;
    category?: string;
    speed: 'balanced' | 'fast';
};

// The request shape `requestSearch` accepts. `body` is JSON; `headers` are added
// to the JSON content type (or replace it, for a provider that wants another).
type SearchRequest = {
    // Display name for error messages: "Exa", "Tavily", "Linkup".
    label: string;
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    // F10 — the caller's signal, linked into the request's own AbortController.
    // Named `callerSignal` (not `signal`) so it can never be mistaken for the
    // controller's signal in the fetch call below: the two are different objects,
    // and which one fired decides whether the caller sees a cancellation, a
    // timeout, or a network failure.
    callerSignal?: AbortSignal;
};

// A provider row mapped to our stable field names, still unvalidated. Adapters
// pass this through `normalizeMatches`, which owns URL validation and bounds.
export type MatchFields = {
    title: unknown;
    url: unknown;
    snippet: string;
    published?: string;
};

// The result of reading a provider row. `read` returns untrusted raw fields; the
// shared normalization below is what makes a WebSearchMatch safe to emit.
export type MatchReader = (row: Record<string, unknown>) => MatchFields;

// Build a redactor over every configured key. The returned function is applied to
// every string that leaves the tool: title, URL, snippet, and published date.
//
// Every non-empty key is redacted, however short. There is deliberately no minimum
// length: an explicit or test credential can be a handful of characters, and
// skipping it would leave the whole value in a provider excerpt. For a very short
// key the cost is over-redaction of ordinary text, which is the safe direction.
//
// Longer keys are replaced first so that a configured key containing another
// configured key is removed whole instead of leaving a suffix behind. Duplicates
// are dropped so a shared key is scanned once.
//
// Why split/join instead of a RegExp: keys are opaque and may contain regex
// metacharacters, and a global RegExp would have to be recompiled per key.
export const createRedactor = (secrets: readonly string[]) => {
    const targets = [...new Set(secrets)]
        .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
        .sort((left, right) => right.length - left.length);

    return (text: string): string => {
        let output = text;

        for (const secret of targets) {
            output = output.split(secret).join(REDACTED);
        }

        return output;
    };
};

// Collapse whitespace, trim, and bound one text field. Titles and snippets often
// arrive with newlines and runs of spaces; one line is what a tool result wants.
//
// The bound is a CODE-UNIT count, so a plain `slice` could end a title or snippet on
// half of an emoji (T3, the lone-surrogate defect); `clipPrefix` backs that cut off one
// unit, and a `Number.POSITIVE_INFINITY` bound still means "no bound".
export const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';

    return clipPrefix(value.replace(/\s+/g, ' ').trim(), max);
};

// Redact the RAW provider string, then collapse and bound it.
//
// This order matters: redacting after truncation can leave the first characters of
// a configured key at the cut (the old `redact(text(raw, max))` bug). A redaction
// marker itself may be cut by the bound, but a marker is not secret.
export const bounded = (value: unknown, max: number, redact: (text: string) => string): string =>
    typeof value === 'string' ? text(redact(value), max) : '';

// `bounded` plus the truth of whether it cut anything.
//
// A snippet that ends mid-word is indistinguishable from a snippet that ended at
// the source's own last character, and the difference decides whether the caller
// should `fetch` the page. Measured across real searches in this session:
// several 1,000-character snippets were cut mid-word ("...call `workflow` with the
// argumen") with no marker at all. Reported only when true, so an uncut result
// keeps its exact existing shape and the flag never costs bytes on the common
// short-snippet path.
export const boundedFlagged = (
    value: unknown,
    max: number,
    redact: (text: string) => string
): { value: string; truncated: boolean } => {
    if (typeof value !== 'string') return { value: '', truncated: false };

    const collapsed = text(redact(value), Number.POSITIVE_INFINITY);

    // The same pair-safe bound as `text`; `truncated` stays a statement about the SOURCE
    // being longer than `max`, so backing the cut off one unit cannot flip the flag.
    return { value: clipPrefix(collapsed, max), truncated: collapsed.length > max };
};

// A snippet source may be a string (Tavily content) or a list of strings (Exa
// highlights). Join highlights with a space, then let `text` bound the result.
export const excerpt = (value: unknown): string => {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string').join(' ');
    }

    return typeof value === 'string' ? value : '';
};

// Provider date fields are strings when present; anything else is ignored rather
// than stringified into a misleading value.
export const date = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

// Accept only absolute http(s) URLs. A provider is data, so a `javascript:` or
// relative value is dropped from the result instead of handed to the model.
//
// Two bounds that are not cosmetic:
//   - a URL longer than MAX_URL_CHARS is rejected, not sliced: a truncated URL
//     looks valid but points somewhere else;
//   - a URL carrying userinfo (`https://user:pass@host/`) is rejected. These are
//     links the model reads and cites, never fetches by this tool, so this is a
//     display/phishing bound rather than SSRF protection.
const validUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return undefined;

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;

        const normalized = parsed.toString();
        return normalized.length > MAX_URL_CHARS ? undefined : normalized;
    } catch {
        return undefined;
    }
};

// What one provider call produced: the rows that survived validation, and the
// count of rows that did not.
//
// The count is not decoration (F5). Before this, a provider row with no usable URL
// was skipped AFTER the requested count had been sliced off, so an invalid row
// silently consumed a slot a valid row could have used, and a call that returned
// `results: []` looked identical to "the web has nothing". `dropped` is the number
// the caller needs to tell those two sentences apart, and ./index surfaces it as
// `droppedResults` plus a `note` when nothing usable is left.
export type NormalizedResults = {
    matches: WebSearchMatch[];
    dropped: number;
};

// Turn provider rows into the stable result shape: VALIDATE THEN COUNT, dropping
// rows without a valid URL, bounding every field, and redacting every string.
// Invalid rows are skipped rather than failing the whole search: one bad row is
// not a reason to lose the good ones.
//
// F5 — the iteration deliberately does NOT slice to `maxResults` first. Slicing
// first let the provider's junk decide how much of the request was filled: five
// `ftp://` rows ahead of fifteen valid ones and `maxResults: 5` produced ZERO
// results, and the caller had no way to know the provider had actually answered.
// Now every row is examined and the loop stops as soon as `maxResults` VALID rows
// are collected, so the count the caller asked for is the count it gets whenever
// the provider can supply it. The scan is still bounded by the response cap
// (MAX_RESPONSE_BYTES) — 512 KiB of JSON is a few thousand rows, so validating the
// whole list costs nothing the transfer check has not already paid for.
//
// Order per field: validate raw -> redact -> bound. Redaction happens on the raw
// string so a credential can never be cut at a truncation boundary. A row is
// dropped WHOLE, never half, which is what keeps that property true for the
// delivery fit that runs after this.
export const normalizeMatches = (
    rows: readonly unknown[],
    maxResults: number,
    redact: (text: string) => string,
    read: MatchReader
): NormalizedResults => {
    const matches: WebSearchMatch[] = [];
    let dropped = 0;

    for (const row of rows) {
        // Stopping at the requested count keeps the promise intact in both
        // directions: the caller gets `maxResults` usable rows, and a provider that
        // sends 500 of them cannot make this loop walk all 500.
        if (matches.length >= maxResults) break;

        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            dropped += 1;
            continue;
        }

        const fields = read(row as Record<string, unknown>);
        const url = validUrl(fields.url);
        if (url === undefined) {
            dropped += 1;
            continue;
        }

        // Redaction can lengthen a URL (`[redacted]` is longer than a short key).
        // If the safe form no longer fits, drop the row rather than truncate it.
        const safeUrl = redact(url);
        if (safeUrl.length > MAX_URL_CHARS) {
            dropped += 1;
            continue;
        }

        const snippet = boundedFlagged(fields.snippet, MAX_SNIPPET_CHARS, redact);

        const match: WebSearchMatch = {
            // Fall back to the URL so a result never has an empty title.
            title: bounded(fields.title, MAX_TITLE_CHARS, redact) || safeUrl,
            url: safeUrl,
            snippet: snippet.value
        };

        if (snippet.truncated) match.snippetTruncated = true;

        const published = bounded(date(fields.published), MAX_PUBLISHED_CHARS, redact);
        if (published.length > 0) match.published = published;

        matches.push(match);
    }

    return { matches, dropped };
};

// ---------------------------------------------------------------------------
// F2 — the delivery fit
// ---------------------------------------------------------------------------
//
// WHY THIS LIVES HERE AND IS GIVEN A `measure` CALLBACK
// ----------------------------------------------------
// The number that matters is the size of the WHOLE result the tool returns: the
// rows, plus the echoed query, provider, maxResults and filters, plus whatever
// `resultsTruncated`/`droppedResults`/`note` the fit itself adds. Only ./index holds
// that object, so ./index supplies the measurement and this file owns the rule — one
// place decides "what to drop", one function decides "what it costs", and the
// currency is core's `modelPayloadBytes` on both sides.
//
// WHY DROPPING TRAILING ROWS IS THE RIGHT CUT
// -------------------------------------------
// The provider's order is its ranking, so a prefix keeps the rows the caller was
// most likely to cite. Cutting a snippet in every row instead would leave twenty
// rows each too thin to act on and would still need a flag; dropping rows is
// reversible by the caller (lower `maxResults`, or narrow the query) in a way that a
// uniformly shredded list is not.
//
// INVARIANT: the returned rows always satisfy `measure(rows) <= budget`, or the rows
// are empty. A result the harness would refuse is never handed back.
export const fitRowsToResultBudget = <TRow extends { snippet: string; snippetTruncated?: boolean }>(
    rows: readonly TRow[],
    measure: (candidate: readonly TRow[]) => number,
    budget: number = MAX_SEARCH_RESULT_BYTES
): { rows: TRow[]; truncated: boolean; clipped: boolean } => {
    const fitted = [...rows];

    // The common path: a default 5-row search is ~1.6 KiB, nowhere near the budget,
    // so it returns untouched and the caller adds no flag and no note at all.
    if (fitted.length === 0 || measure(fitted) <= budget) {
        return { rows: fitted, truncated: false, clipped: false };
    }

    // Drop from the end until the serialized result fits, keeping at least one row
    // for the clip step below to work on.
    while (fitted.length > 1 && measure(fitted) > budget) fitted.pop();

    let clipped = false;

    // One row still over the budget is clipped rather than thrown away: a single
    // short excerpt with a real URL beats "no results".
    if (fitted.length === 1 && measure(fitted) > budget) {
        const original = fitted[0];

        // A clipped row is a row whose excerpt no longer reaches the source's own
        // end, which is exactly what `snippetTruncated` declares — and the flag is
        // payload as well, so the bisection measures the row WITH it. Bisection
        // without the flag lands ~23 bytes over the cap and the row then gets thrown
        // away for nothing.
        const clipTo = (units: number): TRow => {
            // `clipPrefix` is pair-safe, so the cut cannot end on half of an emoji
            // (the same T3 rule every other bound in this file follows).
            const clippedRow = { ...original, snippet: clipPrefix(original.snippet, units) };

            if (clippedRow.snippet.length > 0) clippedRow.snippetTruncated = true;

            return clippedRow;
        };

        // Escaping is per character, so `measure` is monotone in the snippet and the
        // largest fitting prefix falls out of a bisection over code units (at most
        // ~10 measures for a 1,000-character snippet). Guessing a character count
        // instead would be wrong by the escaped width of every quote, control
        // character and non-ASCII letter in the excerpt.
        let low = 0;
        let high = original.snippet.length;

        while (low < high) {
            // Upper midpoint: `mid` is always > `low`, so the loop cannot stall when
            // the answer is `low + 1`.
            const mid = (low + high + 1) >>> 1;

            if (measure([clipTo(mid)]) <= budget) low = mid;
            else high = mid - 1;
        }

        fitted[0] = clipTo(low);
        clipped = true;

        // Safety net rather than the normal path: `low` is only the answer while
        // `measure` is monotone, and a row whose title and URL ALONE exceed the
        // budget cannot be rescued by clipping its excerpt. Dropping it is still
        // better than a result the harness refuses.
        if (measure(fitted) > budget) fitted.length = 0;
    }

    return { rows: fitted, truncated: true, clipped };
};

// One fixed sentence per failure class. Provider bodies are deliberately absent:
// they can contain the request (and therefore the key), an account name, or HTML.
const statusFailure = (label: string, status: number): HarnessError => {
    if (status === 401 || status === 403) {
        return new HarnessError(
            `${label} search rejected the API key (HTTP ${status}). Check the configured key and account.`
        );
    }

    // 402 is Exa's payment-required; 432/433 are Tavily's plan/quota errors.
    if (status === 402 || status === 432 || status === 433) {
        return new HarnessError(
            `${label} search reports no remaining credits or quota (HTTP ${status}). Check the provider account.`
        );
    }

    if (status === 429) {
        return new HarnessError(`${label} search is rate limited (HTTP ${status}). Try again later.`);
    }

    return new HarnessError(`${label} search failed (HTTP ${status}).`);
};

// One fixed sentence for the size bound, shared by the content-length pre-check
// and the streaming budget so both report the same thing.
const oversizedResponse = (label: string): HarnessError =>
    new HarnessError(`${label} search returned a response larger than ${MAX_RESPONSE_BYTES} bytes.`);

// Best-effort release of a body that is rejected before it is read (a failing
// status, or a declared size over the budget). Without it the connection stays
// busy downloading bytes the tool has already decided to throw away.
//
// Deliberately NOT awaited: cancelling the body of a `Response.clone()` never
// settles while its sibling branch is unread (measured: `clone().body.cancel()`
// stays pending, a fresh body's settles), and an await here would therefore put
// the model's error message behind a stream that can outlive the 15 s budget.
// The transfer is released, and only the release, on a promise nobody waits on.
const cancelBody = (response: Response): void => {
    try {
        void response.body?.cancel().catch(() => {
            // The stream may already be closed; the caller's error is the one
            // the model needs.
        });
    } catch {
        // A runtime without a cancellable body: the error path is unaffected.
    }
};

// Read a response body without ever holding more than MAX_RESPONSE_BYTES.
//
// `response.text()` allocates the whole body first, so a provider (or a proxy)
// could force a huge allocation before any check ran. Reading chunk by chunk lets
// us count bytes and cancel the stream the moment the budget is crossed. The same
// budget is checked on content-length before this is called, and again on the
// no-stream fallback so a runtime without `body` is not exempt.
//
// `failure` is the caller's request-phase classifier: a read that rejects is
// either the caller aborting, our own deadline, or a broken transport, and the
// caller is the only place that can tell them apart. It returns the value to throw
// (`unknown`, not HarnessError) precisely so a caller abort can be rethrown as the
// caller's own reason instead of being rewritten into a provider message.
const readBody = async (
    response: Response,
    label: string,
    failure: (error: unknown) => unknown
): Promise<string> => {
    const stream = response.body;

    if (!stream || typeof stream.getReader !== 'function') {
        let body: string;

        try {
            body = await response.text();
        } catch (error) {
            throw failure(error);
        }

        if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw oversizedResponse(label);

        return body;
    }

    const reader = stream.getReader();
    // TextDecoder streams across chunk boundaries so a multi-byte character split
    // between two chunks is decoded once, not turned into a replacement character.
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let received = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            received += value.byteLength;

            // Stop the transfer before throwing: returning while the provider is
            // still sending would leave the socket busy for the rest of the budget.
            if (received > MAX_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // The stream may already be closed; the size error is the one
                    // the caller needs.
                }

                throw oversizedResponse(label);
            }

            parts.push(decoder.decode(value, { stream: true }));
        }

        // Flush any bytes held back as a partial character.
        parts.push(decoder.decode());

        return parts.join('');
    } catch (error) {
        // A HarnessError here is our own size error: keep it.
        if (error instanceof HarnessError) throw error;

        throw failure(error);
    } finally {
        // Releasing the lock is best-effort: cancel() in the limit path already
        // closes the reader, and a release on a closed reader is a no-op we do not
        // want to surface.
        try {
            reader.releaseLock();
        } catch {
            // Ignore: the stream is already done or cancelled.
        }
    }
};

// The one place a network request is made. Resolves the parsed JSON body; throws
// a HarnessError with a sanitized message for every failure. The AbortController
// and its timer are always cleaned up, including when JSON parsing throws.
//
// F10 — TWO signals, one controller. The request owns a deadline controller; the
// caller's `ToolContext.signal` (F10) is LINKED into it exactly the way
// ../tools/webdownload/download.tool.ts:663-677 links its own, so `toolCancel` or a
// run abort stops the transfer instead of only its delivery. Linking (rather than
// passing the caller's signal to fetch directly) keeps the 15 s deadline working
// when there is no caller signal at all, and keeps one abort path.
//
// The three failure classes stay distinct, because a caller that cancelled must not
// be told the provider timed out:
//   - the caller's signal fired  -> rethrow ITS reason, so the harness still
//     classifies the outcome as cancelled whatever phase the throw landed in
//     (same reasoning as download.tool.ts `abortOf`);
//   - our own deadline fired     -> the explicit timeout sentence;
//   - anything else              -> the one fixed network sentence.
// `timedOut` is why the deadline needs its own flag: `controller.signal.aborted` is
// now true for BOTH the timer and a caller abort, so it can no longer tell them apart.
export const requestSearch = async (request: SearchRequest): Promise<unknown> => {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, SEARCH_TIMEOUT_MS);

    const callerSignal = request.callerSignal;
    const forwardAbort = (): void => controller.abort(callerSignal?.reason);

    if (callerSignal !== undefined) {
        // `{ once: true }`, and no listener when the signal has already fired: a
        // listener added to an aborted signal never runs, so the abort is forwarded
        // by hand and `fetch` rejects with the caller's reason instead of hanging.
        if (callerSignal.aborted) forwardAbort();
        else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }

    const networkFailure = (): HarnessError =>
        timedOut
            ? new HarnessError(`${request.label} search timed out after ${SEARCH_TIMEOUT_MS} ms.`)
            : new HarnessError(`${request.label} search could not be reached (network error).`);

    // ONE mapping from "this request threw" to the error the caller gets, used by
    // the fetch phase AND by the streamed body (`failureOf`). Two cases are not
    // failures of the provider at all and must not be rewritten into one — the same
    // two `download.tool.ts:655-666` keeps apart:
    //   - the caller aborted (toolCancel, a run abort, or a host cancelling a direct
    //     `search(...)` call): rethrow ITS reason, so the harness still classifies
    //     the outcome as `cancelled` whatever phase the throw landed in;
    //   - anything else: the caller keeps the classifier's own message.
    const abortOf = (error: unknown): unknown => {
        if (callerSignal?.aborted === true) return callerSignal.reason ?? error;

        return undefined;
    };

    const failureOf = (error: unknown): unknown => abortOf(error) ?? networkFailure();

    try {
        let response: Response;

        try {
            response = await fetch(request.endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...request.headers },
                body: JSON.stringify(request.body),
                signal: controller.signal,
                // No redirects: a redirect would move the request somewhere the
                // fixed endpoint policy did not choose.
                redirect: 'error'
            });
        } catch (error) {
            throw failureOf(error);
        }

        if (!response.ok) {
            // An error page is HTML noise we never read: release the body so the
            // connection is not held for it.
            cancelBody(response);

            throw statusFailure(request.label, response.status);
        }

        // Reject an oversized declared body before reading it. The streaming budget
        // in `readBody` still applies when the header is absent or wrong.
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            // Nothing is read on this path: the declared size alone is the
            // rejection, and cancelling stops the download.
            cancelBody(response);

            throw oversizedResponse(request.label);
        }

        const body = await readBody(response, request.label, failureOf);

        try {
            return JSON.parse(body) as unknown;
        } catch {
            throw new HarnessError(`${request.label} search returned a response that is not JSON.`);
        }
    } finally {
        // Clear before the controller goes out of scope so a completed request
        // never keeps the process alive for the rest of the budget.
        clearTimeout(timer);
    }
};

// Read the provider's result list, or fail with a message that names the field.
// Shared because every provider answers with `results`; keeping the check here
// means an unexpected body (HTML error page, truncated JSON) becomes the same
// readable error for any adapter.
export const resultsArray = (payload: unknown, label: string): readonly unknown[] => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HarnessError(`${label} search returned an unexpected response.`);
    }

    const results = (payload as Record<string, unknown>).results;

    if (!Array.isArray(results)) {
        throw new HarnessError(`${label} search returned a response without a "results" list.`);
    }

    return results;
};
