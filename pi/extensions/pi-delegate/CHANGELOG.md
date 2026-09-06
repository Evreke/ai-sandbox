# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version numbers align with the iteration numbering in DESIGN.md (v1.x sections).

## [1.11.0] — 2026-09-06

### Added

- **Event-driven background watcher** (`src/watch.ts`, DESIGN.md §21): polls every
  `watch.intervalMs` (default 10 s), aggregates manifests + live herdr statuses +
  worker session JSONL, and wakes the idle orchestrator via
  `pi.sendUserMessage(..., { deliverAs: "followUp" })` when a worker needs attention.
  Five deduped event kinds: report-ready, report-invalid, mailbox-question,
  grill-deck (toolCall detected in the worker session), context-critical (≥ 90 %),
  worker-dead. Lifecycle mounted on `session_start` / stopped on `session_shutdown`;
  headless-safe; advisory-only (a watcher failure never affects spawn/collect).
- **Backlog section** (DESIGN.md §21.1): fleet scoping of wake-ups (F1),
  report-invalid mtime grace + brief schema (F2), teardown stops worker-dead (F3),
  dedup I/O cost (F5), pre-existing test type errors (P1).

### Changed

- **Spawn settle gate default 120 s → 15 s** (`watch.settleGateMs`, explicit
  `waitMs` still overrides; legacy `timeoutMs` keeps its 120 s cap). After
  detach the orchestrator ends its turn — the watcher wakes it; bash/python
  sleep is an acceptable fallback only when the watcher is unavailable
  (SKILL.md + tool texts updated, DESIGN.md §20.1 annotated).
- **Failed delivery re-fires**: event keys of a dropped batch are rolled back
  from the dedup set, so a transient send error can never permanently swallow
  a wake-up.
- **Dedup state reset**: keys of workers no longer present in any manifest are
  forgotten (code now matches the documented behavior).

### Fixed

- `test/static-check.ts`: `src/watch.ts` added to the canonical dependency-rule
  restricted list.
- `test/transport-contract.ts`: `subDir` hoisted above `try` — the `finally`
  cleanup `rmSync` actually runs now (was leaking temp dirs).

### Tests

- New `test/watcher-check.ts` (95 checks): event detection, dedup/fingerprints,
  reset, delivery rollback, config tolerance, self-mute, lifecycle.
- All pre-existing suites pass unchanged.
