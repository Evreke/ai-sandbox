# Changelog

All notable changes to `@evreke/pi-grill-deck` are documented here.
Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
