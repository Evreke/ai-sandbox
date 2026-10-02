# Changelog

All notable changes to `@evreke/pi-grill-deck` are documented here.
Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.15.0] — 2026-10-02

### Added

- **Text-path rounds (stage 2).** When `grill_deck` is unavailable, the model
  ends a round with one fenced ```grill-round XML block (`<question>` with
  `<body>`/`<choice>`/`<recommendation>` or `<open/>`). The extension
  intercepts `agent_before_settle`, parses the block (own stack parser,
  entity-aware, line-numbered errors), applies the 1.5.0 shape contract and
  the tool-path sanitizing/limits, opens the deck TUI, appends the same
  round record (so `/grill` replay works), and returns the answers as a
  `custom_message` with `continue: true` — the session becomes a
  user-paced deck loop that ends when the model emits no block.
- **Transport-dependent answer tail.** `answersToText` takes a transport
  (`"tool" | "text"`): the text tail points the model at the block contract
  instead of the (nonexistent) tool call.

- **Skill coexistence binding.** Users with the upstream `grilling` skill
  installed keep it untouched: the `grill_deck` system-prompt guideline now
  names `grilling-fork` as the session protocol and prefers it over other
  grilling-style skills, and the fork's description carries an explicit
  precedence marker. `/skill:grilling-fork` forces the fork deterministically.

### Fixed

- **Fence-line attributes (found by the live in-vitro test §6.3).** The
  skill example puts `topic="…"` on the fence line (`` ```grill-round
  topic="…" ``), but the parser required the fence line to end right after
  the anchor — a block following the skill example failed to parse
  (NO-BLOCK). Now: the fence line may carry attributes; the
  `<grill-round>` wrapper element is optional (questions may sit directly
  in the fence); topic precedence is wrapper attribute > fence-line
  attribute.

### Policies

- Invalid block: one repair attempt per run (`custom_message` with the
  parse error); second failure leaves the block as text.
- Gate is `ctx.mode === "tui"` **and** `outcome === "completed"` (not
  `hasUI` — it is true in RPC too); boundary `entries` are spread, not
  replaced; user-cancelled deck disables block parsing for the run.
- Skill fallback section rewritten to the block contract (co-versioned).

## [1.5.0] — 2026-10-02

### Changed

- **Round shape contract: options are always selectable.** `choices` is now a
  REQUIRED field on every question: a non-empty array for a choice question,
  an EMPTY array as the explicit open-question marker. A `recommendation` is
  only allowed with non-empty choices (an open question has nothing to
  recommend). Calls that violate the contract are rejected with `isError: true`
  and a regeneration hint — body-embedded options are not selectable, so a
  deck built from them is unusable. No heuristic repair: the model re-issues
  the call. Schema descriptions, `promptGuidelines`, and the bundled grilling
  skill text state the contract; `lib.ts` gains `questionShapeError` /
  `roundShapeError` (pure, unit-tested).

## [1.4.1] — 2026-09-04

### Fixed

- **TUI crash on narrow terminals.** The deck header line
  (` grill deck · N questions · N answered · model-authored — verify before
  accepting`, ~81 visible chars) was pushed as a single untruncated line. On
  terminals narrower than ~82 columns, pi's `TuiMainScreen.doRender` invariant
  (`visibleWidth(line) <= width`) threw `uncaughtException` and the whole pi
  process exited mid-tool-call:
  `Error: Rendered line 57 exceeds terminal width (81 > 63)`.
  The header is now passed through `wrapTextWithAnsi(header, w)` — the same
  wrapper every other deck line already uses. Overflow flows onto a
  continuation line; ANSI styling is preserved across the wrap and no text is
  lost (truncation would have dropped the static suffix). Verified: 63 cols →
  2 lines (max visible width 57), ≥82 cols → identical single line.

## [1.4.0] — 2026-08-30

- Enter opens options, auto-submit when the deck settles, status widget
  removed.

## [1.3.1] — 2026-08-30

- Security hardening, unit tests, npm publish.

## [1.2.1] — 2026-08-29

- Initial interactive question deck extension for pi.

---

## Skill divergence from upstream

The bundled `grilling-fork` skill is adapted from Matt Pocock's `grilling`
skill ([mattpocock/skills](https://github.com/mattpocock/skills), upstream
commit `8b78b53`, MIT — see [ATTRIBUTION.md](./ATTRIBUTION.md)). Because the
package ships the modified skill, this section inventories every divergence.

Kept verbatim from upstream: the methodology core — the design tree, working
in rounds, the frontier definition, sub-agent fact-finding ("finding facts is
your job, never the user's"), and the confirmation gate ("do not act until
the user confirms shared understanding").

| Area | Upstream | Fork | Since |
|---|---|---|---|
| Round presentation | markdown questions (`❓` title — body, `➡️` recommended answer) | one `grill_deck` tool call per round, carrying the whole frontier | 1.2.1 (initial adaptation) |
| Question fields | free-form markdown text | typed fields `topic` / `id` / `title` / `body` / `choices` / `recommendation`, each with rendering rules | 1.2.1 (initial adaptation) |
| Deferred answers | not modelled | a DEFERRED answer is a still-open decision and re-enters a later round's frontier | 1.2.1 (initial adaptation) |
| Round shape contract | — | `choices` is required: a non-empty array for a choice question, an empty array marks an open question; options are never embedded in the body; a `recommendation` is only allowed with choices and is worded exactly as one of them | 1.5.0 |
| Compound decisions | — | mutually dependent decisions merge into one question whose options are the coherent combinations; a decision enters the frontier only when every one of its prerequisites is settled | 1.15.0 |
| Termination guard | the session is done when the frontier is empty | …and no exploration is still running — a sub-agent fact-finding run must not race the session close | 1.15.0 |
| Fallback presentation (tool unavailable) | markdown (`❓` / `➡️`) | one fenced ` ```grill-round ` XML block: every question carries `<choice>` entries or `<open/>` (never both), XML entity escaping, no nested fences; an empty frontier emits no block | 1.15.0 |
| Skill name | `grilling` | `grilling-fork` — coexists with an upstream install; the description carries an explicit precedence marker | 1.15.0 |
