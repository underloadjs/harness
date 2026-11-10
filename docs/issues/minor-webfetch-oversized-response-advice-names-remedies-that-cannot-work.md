# 0014 — The oversized-response error names two remedies that cannot work in the situation that triggers it

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/tools/webfetch/request.ts` (the `oversizedResponse` message)
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `fetch` against pages just over the 1 MiB body cap. The error message
is unusually helpful in shape — it offers three concrete ways forward — but two of the three
cannot succeed, and the message is the only guidance a caller gets at that point.

## Gap

The message is:

> *"fetch received a response larger than 1048576 bytes. Try the plain-text or raw source form
> of the page if the host offers one (for example .txt, or a `?action=raw` / print view), ask
> for fewer characters with `query`, or use the `download` tool to save the bytes and read them
> with grep and read."*

Measured against each remedy:

| Remedy | Outcome |
|---|---|
| `.txt` / `?action=raw` | **Works.** `rfc-editor.org/rfc/rfc9110.txt` (502,906 B) fetched successfully. |
| `query` | **Cannot work.** Identical error, character for character, with or without it. |
| `download` + **`grep`** | **Cannot work.** `grep` refuses files over 1 MiB, and the size error only fires when the body exceeds 1 MiB — so the recommended combination is self-contradictory *by construction*. |
| `download` + `read` | Works (`read` handles large files with windowed continuation). |

The `grep` leg is the more serious of the two, because it fails **silently**: `grep` returns
`matches: []` with the reason only in `note`. A caller that skims the note concludes "the page
does not contain that string" — a wrong answer, not a visible failure.

## Why it is the way it is

The 1 MiB body cap itself is deliberate and should not move. `request.ts:25-29` argues it (the bound's current rationale
is the `WHY 1 MiB AND NOT THE OLD 100 KiB` note at `:62-70`; the block quoted below still
names the retired 100 KiB figure — that staleness is 0007's, not this issue's):
*"a page that does not fit is a file, not an article … the tool description points the model at
the host's download tool for them instead of raising the bound here."* The pre-check is
enforced from `content-length` before a byte is read (`:700-707`) so an oversized page is never
allocated — the cap exists to bound process exposure, and moving the check post-conversion
would forfeit that.

The `query` suggestion is simply wrong about where `query` runs: `sections.ts:6-7` states *"The
selection runs on CONVERTED content"*, so it cannot reduce a body that was rejected before
conversion. The message was written as a list of generic fetch remedies rather than as advice
scoped to this specific failure.

## Evidence

| Fact | Source |
|---|---|
| The message text | `src/tools/webfetch/request.ts:165-168` (`oversizedResponse`; the string itself is `:167`) |
| The cap and its rationale | `src/tools/webfetch/request.ts:71` (`MAX_RESPONSE_BYTES = 1024 * 1024`), `:25-29`, with the current-bound note at `:62-70` |
| The pre-check rejects before reading any byte | `src/tools/webfetch/request.ts:700-707` |
| `query` filters converted content, after the body is accepted | `src/tools/webfetch/sections.ts:6-7` |
| `grep` skips files over 1 MiB | `src/tools/files/grep.test.ts:312`, `:418` (`'1 file(s) larger than 1048576 bytes were not searched'`), with `matches: []` and `skipped.tooLarge` |
| Runtime 2026-11-10: `rfc-editor.org/rfc/rfc9110.html` (1,187,554 B) → the size error; the same URL **with `query="field name"`** → the identical error | live fetch |
| Runtime: `rfc-editor.org/rfc/rfc9110.xml` (1,223,686 B) with `query` → identical error | live fetch |
| Runtime: `ru.wikipedia.org/wiki/Квантовая_механика` (1,196,795 B by curl) → size error, with and without `query` | live fetch + curl |
| Runtime: that page's `?action=raw` wikitext is 185,358 bytes / 123,456 characters, so it would convert small | curl, measured twice |
| Runtime: `grep` over the downloaded 1,196,795 B file returns `matches: []`, `skipped.tooLarge: 1` | live grep |
| Runtime: `en.wikipedia.org/wiki/General_relativity` (1,559,621 B) → the size error | live fetch + curl |
| The remedy the message lists first does work | `rfc9110.txt` (502,906 B) fetched successfully, 63,488 chars, `truncated: true` |

## Proposal

**Message-only.** Scope each remedy to the failure and drop the two that cannot apply:

> "…Try the plain-text or raw source form of the page if the host offers one (.txt, a
> `?action=raw` / print view) — that is the only remedy that reduces the transferred body;
> `query` and `format` cannot help, because they apply after this size check. Or use the
> `download` tool to save the bytes and read them with `read` (`grep` skips files over 1 MiB)."

**Alternatives considered.**

- *Move the size check after conversion.* Rejected here: it forfeits the pre-read rejection
  that `:700-707` exists to provide, and raises unresolved questions (which budget applies,
  does it apply to `format=html`, does it change the documented contract). Worth its own
  proposal, not bundled into a wording fix.
- *Raise the cap.* Rejected: `:25-29` argues the bound deliberately, and `download` is the
  intended path for a page that is really a file.
- *Drop the `download` suggestion entirely.* Rejected: it works via `read`; only the `grep`
  half is wrong.

## Acceptance criteria

1. The message no longer offers `query` as a remedy for this error.
2. The message names `read`, not `grep`, as the tool to use on the downloaded file — or warns
   that `grep` skips files over 1 MiB.
3. Every remedy the message lists is verified to work in the situation that triggers it.

## Tests to add

- `src/tools/webfetch/webfetch.test.ts` — the existing oversize assertions (`:546-564`,
  `:566-589`; the message assertions themselves are `:556-558` and `:580-582`) pin only the
  first clause today; extend one to pin the remedy wording, so the
  advice cannot silently regress back to `query`/`grep`.

## Out of scope

- Changing `MAX_RESPONSE_BYTES`, or moving the check after conversion.
- The separate misclassification that an oversize page can surface as "network error" (0015).

## Update (2026-11-11)

- **Re-anchored**: `oversizedResponse` is `src/tools/webfetch/request.ts:165-168` (the quoted
  string is `:167`), the rationale block the issue quotes is `:25-29`, and the
  "selection runs on CONVERTED content" line is `src/tools/webfetch/sections.ts:6-7` (the
  issue cited `:8`). The two existing oversize tests are `src/tools/webfetch/webfetch.test.ts:546-564`
  and `:566-589`; their message assertions are `:556-558` and `:580-582`, and they still pin
  only the first clause — the hole the "Tests to add" section describes is exactly today's state.
- **One clarification the tree now forces**: the block at `:25-29` still argues for the retired
  **100 KiB** bound, while the live `MAX_RESPONSE_BYTES = 1024 * 1024` (`:71`) is justified by
  the note at `:62-70`. The quoted sentence this issue leans on ("a page that does not fit is a
  file, not an article … points the model at the host's download tool") is still there at
  `:26-29` and still supports the issue's position, but the stale figure around it is tracked
  in 0007 — do not let a reader conclude the cap is 100 KiB.
- **Re-verified exact, no edit needed**: the content-length pre-check at `:700-707` (with
  `cancelBody` at `:704`), and `grep`'s skip policy as pinned at
  `src/tools/files/grep.test.ts:312` and `:418` (`'… larger than 1048576 bytes were not
  searched'`, `matches: []`, `skipped.tooLarge`). The `grep` leg of the message is still
  self-contradictory, since the error only fires above 1 MiB and `grep` skips files above 1 MiB.
- The live-fetch rows are left **as recorded** (2026-11-10 measurements).
- Status stays **Open**.
