# 0012 — The markdown converter drops `<sup>`/`<sub>` markers and leaks `data-mw` metadata into prose

> **Status:** Open
> **Severity:** Significant
> **Area:** `src/tools/webfetch/native.ts` (the markdown and text conversion passes)
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `fetch` against Wikipedia and physics reference pages. The tool
advertises "STRUCTURED CONTENT as markdown … readable text, not raw bytes", so a model
treats the output as authoritative and cites it. Two classes of output break that trust, and
both come from one line: the conversion is a regex pass that ends with a blanket tag strip.

The first is **silent and value-changing**. `10<sup>12</sup>` becomes `1012`, so "quantum
electrodynamics agrees with experiment to within 1 part in 10<sup>12</sup>" reads as "1 part
in 1012". On `physics.nist.gov/cgi-bin/cuu/Value?hbar` the Planck constant renders as
`1.054 571 817… x 10-34 J s` — the exponent's minus sign is glued to the mantissa, so the
line reads as a subtraction and the value is wrong by 34 orders of magnitude.

The second is **noisy**: Parsoid round-trip metadata appears mid-prose as `{{rp|100–105}}"}},"i":0}}]}'>`,
including ~1.4 KB of `{{cite journal |…}}` fields dumped into the *Philosophical implications*
section. It costs context and reads like article text.

## Gap

A caller that asks for readable content gets readable content **plus silently wrong numbers**,
and has no way to know. Specifically the consumer needs:

- **Superscript and subscript markers preserved**, so an exponent survives as an exponent
  rather than being concatenated into the base.
- **A disclosure when math markup was flattened**, so a model that needs the exact value can
  re-fetch rather than cite a corrupted one. The tool already has a `note` field for exactly
  this kind of disclosure.
- **Attribute metadata kept out of the text stream**, so a tag boundary is a tag boundary.

## Why it is the way it is

Partly deliberate. The module header states the conversion contract as a set of regex passes
and names its own limits (`native.ts:15-17`: markdown "keeps headings, links, images, emphasis,
code, list items, blockquotes, and rules"; `:247-248`: list "Nesting is flattened — a known
limit of a regex pass"). Math and superscripts are simply **not in the enumerated list** of
what markdown output keeps, so their loss is consistent with the documented contract.

What is *not* argued anywhere is that the loss is **unreported**. Every other lossy boundary in
this tool family is reported — `grep` emits a `note` naming what it skipped, `fetch` reports
`offsetClamped` with a `note` when an offset overshoots (`request.ts`/`index.ts:562-568`), and
`download` reports `searchable` so a model does not grep a JPEG. Math flattening is the one
degradation this tool performs silently.

## Evidence

| Fact | Source |
|---|---|
| Every inline tag is deleted with its marker, keeping only its text | `src/tools/webfetch/native.ts:263` (`output.replace(/<[^>]*>/g, '')`) — the catch-all that runs after the named passes |
| `<sup>`/`<sub>` are handled only inside `<pre>`, never in prose | `src/tools/webfetch/native.ts:146` (`PRE_WRAPPER_TAGS` strips them so a code sample survives) |
| No `<sup>`, `<sub>`, `<math>`, or MathML rule exists in the markdown pass | `src/tools/webfetch/native.ts:191-282` (the whole of `convertHtmlToMarkdown`: emphasis, links, images, headings, blockquotes, lists, rules, block boundaries) |
| The documented markdown contract does not list math | `src/tools/webfetch/native.ts:15-17` |
| The module claims to be "a real parser, not a regex hack" | `src/tools/webfetch/native.ts:4` — contradicted by the pass structure above |
| The served HTML carries the marker; the converter discards it | measured 2026-11-10: `en.wikipedia.org/wiki/Quantum_mechanics` HTML contains `10<sup id="mwZA">12</sup>`; `format=markdown` returns `within 1 part in 1012`; `&action=raw` wikitext contains `10<sup>12</sup>` |
| Plain `<sup>` on a non-MediaWiki site corrupts the same way | measured 2026-11-10: `physics.nist.gov/cgi-bin/cuu/Value?hbar` → `x 10-34 J s` (source HTML has `10<sup>-34</sup>`); no MathML, no LaTeX involved |
| Fractions flatten to juxtaposition | measured: `\sigma_X \sigma_P \geq \frac{\hbar}{2}` → `σXσP≥ℏ2`; `\tfrac12` → `12` |
| `format=text` does not fix it | measured: same sentence returns `within 1 part in 10 12` — a space, still no exponent marker |
| `format=html` is lossless | measured: returns `10<sup id="mwZA">12</sup>` intact, plus the original LaTeX verbatim in `data-mw` (`"extsrc":"\\sigma_X \\sigma_P \\geq \\frac{\\hbar}{2}."`) |
| The metadata leak is mid-prose, not in References | measured: leaks at HTML byte offsets 250857 (*Free particle*) and 369843/370233 (*Philosophical implications*), all before the References heading at 419870 |
| The leak is an attribute-boundary error, not a template-expansion failure | the raw `{{…}}` text lives in a `data-mw='{…}'` attribute on the ref element, and Parsoid escapes `<` as `&lt;` but leaves a literal `>` inside the quoted value; a tokenizer that ends the tag at the first `>` emits the remainder as text — which is why the fragment ends in the tell-tale `'>` |
| A spec-compliant parser leaks nothing from the same bytes | measured 2026-11-10: the identical HTML through `html.parser` yields 0 occurrences of `{{rp\|`, `{{cite journal`, `"i":0`; a naive `re.sub(r'<[^>]*>',' ',html)` reproduces the claim byte-for-byte |
| The trigger is common, not a `{{refn}}` edge case | counted per page in `data-mw` attributes containing a literal `>`: Photosynthesis 34, General_relativity 6, Quantum_mechanics 5, DNA 3 |

## Proposal

Three changes, in the order an implementer should take them. (1) alone removes the headline
defect.

1. **Convert `<sup>`/`<sub>` to an explicit marker** in both the markdown and text passes:
   `10<sup>12</sup>` → `10^12` (or `10¹²`), `<sub>n</sub>` → `_n`. A few lines beside the
   existing emphasis pass at `native.ts:210-213`. This fixes the numeric case everywhere,
   including the NIST page, and needs no parser change.
2. **Disclose the loss.** When any `<sup>`, `<sub>`, `<math>`, or MathML node was flattened,
   set the existing `note` to e.g. `"math markup flattened; use format=html for exact values"`.
   This turns an undisclosed corruption into a documented limitation and is the change that
   protects a model that never notices.
3. **Stop the metadata leak** by making the tag boundary attribute-aware — a `>` inside a
   quoted attribute value does not end the tag. Cheaper targeted mitigation if a tokenizer
   swap is too invasive: strip `data-mw="…"`/`data-mw='…'` before conversion, since they are
   editing metadata no reader needs.

**Alternatives considered.**

- *Tell callers to use `format=html`.* Rejected as the sole answer: it is a verified lossless
  escape hatch (4.4× the characters — 853,017 vs 193,912 on the same page), but the default
  output is the one a model will use, and it stays silently wrong.
- *Recover the LaTeX from `data-mw` `extsrc` instead of flattening MathML.* Genuinely better
  for math, and the source is already in the bytes, but it is a larger change than (1) and
  does not help plain `<sup>` on ordinary sites. Worth a follow-up.
- *Swap the regex converter for a real HTML parser.* The honest long-term fix and the only one
  that closes the attribute class properly, but it is a rewrite of `native.ts` and should not
  block (1) and (2).

## Acceptance criteria

1. `10<sup>12</sup>` in source HTML yields `10^12` (or `10¹²`), never `1012`, in both markdown
   and text output.
2. The NIST Planck-constant page yields an exponent that is not read as a subtraction.
3. A page containing `<sup>`/`<sub>`/`<math>` sets a `note` naming the flattening and the
   `format=html` remedy; a page with none sets no such note.
4. `{{rp|`, `{{cite journal`, and `"i":0` do not appear in markdown output for
   `en.wikipedia.org/wiki/Quantum_mechanics`.
5. The module header's "real parser, not a regex hack" claim is either earned or corrected.

## Tests to add

- `src/tools/webfetch/webfetch.test.ts` — stub HTML containing `10<sup>12</sup>`, `<sub>n</sub>`,
  and an `<math>` block; assert the marker survives in `markdown` and `text`, and that the
  `note` is set. Assert `format=html` still returns the markup verbatim.
- `src/tools/webfetch/webfetch.test.ts` — stub HTML with a `data-mw='{"a":"x>y"}'` attribute
  containing a literal `>`; assert nothing after the inner `>` leaks into the text.
- `src/harness.webfetch.test.ts` — the same through the tool entry point, so the `note` reaches
  the model-facing envelope.

## Out of scope

- Full MathML/LaTeX semantic rendering, or recovering `extsrc` into the text (follow-up).
- Replacing the converter wholesale (may be its own issue once (1) and (2) land).
- List nesting, which the header already declares a known limit.
