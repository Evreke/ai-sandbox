# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version numbers align with the iteration numbering in DESIGN.md (v1.x sections).

## [Unreleased]

### Fixed

- **Watcher ownership — one orchestrator per wake-up** (two-layer fix, §21.1 F1):
  the watcher mounts into EVERY pi session, but manifests in /tmp/exchange are
  global — so (a) worker sessions received their orchestrator's
  "DELEGATE WATCHER — …" wake-ups and mounted their own redundant watchers, and
  (b) every mounted watcher delivered copies of events from OTHER orchestrators'
  tasks (N sessions = N copies). Now:
  - **Worker gate**: `isWorkerSession(self, manifests)` in `src/watch.ts` — a
    session that is itself a manifest worker (exact worker `sessionPath`, or a
    worktree `checkoutPath` — the `isSelf` strictness, no 24 h lookback) mounts
    NO watcher at `session_start` (`pruneArchive` still runs). Tolerant: garbage
    manifests read as "not a worker", never throw.
  - **Ownership by orchestrator session path**: spawn records
    `orchestratorSessionPath` (the LIVE `sessionManager.getSessionFile()` at
    manifest-write time — never a captured constant: /new and /resume change the
    path, and a new session inheriting no wake-ups is the desired behavior).
    `detectWorkerEvents` emits NOTHING for a worker whose recorded owner differs
    from the watcher's own session (`DetectOptions.selfSessionFile`, threaded
    from `WatcherDeps.self`). Fail-open on both edges: legacy manifests without
    the field and degraded self-ids keep the old behavior — a lost report-ready
    is worse than a duplicate. `collectedAt` logic, report validation, mailbox,
    settle and the `seen` dedup are untouched; the watcher remains a
    manifest-reader (spawn's own record write is unchanged as the only writer).
- **No re-wake on already-collected reports** (field fix): successful collect now
  stamps `collectedAt` (ISO) on the worker's manifest record (best-effort — a
  failure warns, never fails the collect). The watcher treats a `collectedAt`
  worker as delivered and emits no `report-ready`/`report-invalid` for it — the
  watcher's `seen` dedup lives only inside a session, so fresh sessions used to
  re-wake on reports collected in earlier ones (14 stale wake-ups observed in
  the field, v1.11.0 preprod run). Only collect writes the field; other event
  kinds are unaffected.
- **Archive retention**: `pruneArchive(maxAgeMs?)` in `src/archive.ts` deletes
  archived task dirs older than 30 days (folder mtime), best-effort, never
  throws; called once at watcher start (`session_start` in `index.ts`) so the
  archive stops growing without bound.

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
