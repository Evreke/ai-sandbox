# Roadmap — pi-delegate

Milestone list. Done items stay for context; open items carry a short design
note (what/why/risks) so a fresh session can pick any of them up without
archaeology.

## Epic: healing 1.16.1 — waves 0–4 — DONE (2026-09-12)

The stabilization plan (STABILIZATION.md) executed on the 2026-09-11 four-way
audit (ARCHITECTURE.md §0). What landed, wave by wave:

- **Wave 0 — compliance & correctness:** `StringEnum` tool-parameter enums
  (Google-model shape), all agent-dir sites migrated to pi's `getAgentDir()`/
  `CONFIG_DIR_NAME` exports with a static pin, tsc green (QA config), typebox
  moved to peerDependencies, `ctx.hasUI` guards on both commands, named
  `promptGuidelines` bullets, the two lying contracts fixed, the
  `prepareArguments` shim folding legacy `timeoutMs` into `waitMs`.
- **Wave 1 — release machinery:** both workflows invoke the deterministic
  `test/run-checks.sh` (no `|| bun test` fallback), changelog-section PR gate,
  release-run concurrency group, bun version pin.
- **Wave 2 — session lifecycle:** per-session context object (Law 3),
  session-keyed watcher mounts with the second mount REFUSED, accept-then-log
  delivery classification, the watcher-vs-collect `collectedAt` race closed,
  the delegate skill single-sourced (the stale repo-root copy deleted — both
  install layouts load the extension's copy), one shared `buildFleetRow`.
- **Wave 3 — decomposition (layout v3, DESIGN.md):** exchange.ts → archive.ts /
  manifest-store.ts / report-schema.ts / mailbox-store.ts / watch-store.ts
  (exchange.ts = root conventions + facade); observe.ts → watch-config.ts /
  watch-detect.ts / watch-retire.ts / watcher.ts / status-tool.ts / commands.ts
  (observe.ts = facade); spawn.ts → tool-result.ts / clock.ts / grace.ts /
  mailbox-tool.ts (plus the tier/schema pure-function lifts); the six duplicate
  helper clusters deduplicated (fs-probe.ts, text-cap.ts, one mailbox-state
  reader, one audit sink).
- **Wave 4 — seam & hardening:** placementRef-only seam (`workspaceId`/`paneId`
  optional), Law 1 truncation caps on every worker-content return path,`
  schemaVersion` stamped on the manifest + mailbox/release envelopes, fsync
  before rename in the one atomic writer, mtime-cached watcher tick (stamp
  layers + fingerprint-gated tail parse), silent-catch residue surfaced
  (archive-failure reason, rollback-failure logging, counted audit-append
  failures).

Regression evidence (the checks that fail on the pre-fix code):
`test/double-mount-check.ts` (D2 double-mount refusal),
`test/watcher-check.ts` W19 (accept-then-log, B4) + W20 (collectedAt race),
`test/schema-version-check.ts`, `test/status-cap-check.ts`,
`test/text-cap-check.ts`, `test/watch-tick-cost-check.ts`,
`test/silent-catch-check.ts`, `test/composer-check.ts` (behavioral mount
decision), `test/host-parity-check.ts` (placementRef-only seam parity),
`test/lifecycle-check.ts`.

Also FIXED from the former open-candidates list:

- **D2 double-mount watcher arbitration: FIXED (Wave 2).** The mount registry
  is session-keyed; a second mount for the same session file is refused with a
  logged note instead of silently running two watchers with independent dedup
  (regression: `test/double-mount-check.ts`).
- **B4 accept-then-log in makeSender: FIXED (Wave 2).** "Accepted by pi"
  (queued-then-thrown) counts as DELIVERED — the durable record commits and the
  batch does not re-fire; rollback survives only for genuine pre-delivery
  failures (regression: `test/watcher-check.ts` W19).

## Epic: WorkerHost inversion (in flight, 2026-09-10)

Hide herdr behind a backend-agnostic `WorkerHost` interface so the backend is
swappable (tmux / other). Approved design: interface + herdr adapter +
in-memory fake (second adapter = real seam), opaque `placementRef` in
Placement/manifests (`backend` field alongside legacy ids for version skew),
neutral user-facing texts, binding via config (`host: "herdr"` default).
Design doc: `docs/design-host-interface.md` (re-derived from the gap analysis,
committed with the epic). Pipeline: research → PoC → impl → e2e ∥ QA → fix wave → review — ALL DONE (merged here).

## Milestone: provider/model selection for workers AND orchestrators

**Status: workers — done (v1.9.2); orchestrators — open, needs design.**

- **Workers (exists).** Named tiers in `~/.pi/agent/pi-delegate.config.json`
  (`tiers: {flash: {provider, model, thinking}}, defaults.tier`) + per-call
  `provider`/`model`/`thinking` overrides on the delegate tool; explicit call
  params beat tier, tier beats defaults; unresolved → `E_TIER` with guidance.
- **Orchestrators (gap).** The orchestrator IS the pi session — its model is
  pi-level state (`settings.json` defaultProvider/defaultModel, per-session
  PI_MODEL), invisible to pi-delegate. What the mechanism must decide:
  1. whether pi-delegate should manage orchestrator models at all (it cannot
     restart its own session) or only (a) recommend/pin them in task
     manifests (`masterSessionPath` + model stamp) and (b) cover
     SUB-orchestrators (tier-1 leads) — those ARE spawned workers today, so
     tiers already apply to them;
  2. per-TASK model policy (e.g. brief frontmatter `orchestratorModel`) vs
     config-level policy;
  3. what happens on mismatch (warn in /delegate-fleet? refuse spawn?).
- **Constraints:** tier table shape is config-frozen surface; herdr-host
  refactor (above) must not gate this — model selection is transport-neutral.

## Milestone: Windows path support + pluggable mailbox store

**Status: research/design done (docs/design-windows-mailbox.md); implementation open.**

- **Problem:** pi-delegate is POSIX-bound — the mailbox/delegation does not work on
  Windows (~40 coupling points: hard-coded /tmp/exchange, 13 template-literal path
  assemblies, POSIX-shaped parsing regexes, unix-socket transport, SIGKILL escalation,
  prompt-embedded file paths).
- **Design highlights:** exchange root priority env > config > per-OS default
  (%LOCALAPPDATA% on win32, /tmp/exchange unchanged on unix) + legacy-root dual-scan;
  single path-builder (expaths.ts) with a static no-concat pin; explicit POSIX-only v1
  list (herdr socket transport, SIGKILL escalation — Windows needs taskkill shape);
  watcher is a poller — portable as-is.
- **Mailbox store seam:** orchestrator-side `ExchangeStore` interface (FileStore now,
  SqliteStore sketch in the doc); the agent-facing wire format STAYS the q-/a- files
  (workers read paths from prompts — fs-by-protocol), a DB adapter MIRRORS to files.
  Full protocol replacement would require an agent-side shim — rejected for now.
- **Phases:** six, each independently shippable; most verifiable without a Windows host
  (path-builder property tests, C:\\ fixtures, static pin) — manual QA checklist for a
  real Windows machine in the doc.

## Fix wave 2026-09-10 (watch-fix, on top of the WorkerHost impl) — DONE

Diagnosed by watch-leak-diag + retire-msg-diag (`/tmp/exchange/workerhost-refactor/diag-*.md`):

- **D1 — duplicate wake on an unchanged fingerprint: FIXED.** The watcher's
  dedup state reset treated "no observation this tick" (transient ENOENT on a
  report) as "condition stopped being true" and forgot fingerprinted seen-keys
  → the same report-ready fired twice with an unchanged mtime. Fingerprinted
  kinds now keep their key until the worker vanishes or the fingerprint
  changes; gauge kinds keep the reset semantics (regression: W16.16).
- **B1 — legacy fail-open wake broadcast: CLOSED (mostly).** The ownership
  gate now consults the manifest-level `masterSessionPath` (F1 field, written
  since 1.15.0) when a worker entry lacks `orchestratorSessionPath`: a known
  foreign owner stays silent; fail-open remains only for manifests with NO
  owner field anywhere (regression: W14.18–W14.23).
- **Archive-at-retire: DONE.** A TTL auto-retire of an UNCOLLECTED worker no
  longer orphans the report — retirePass archives the report + manifest
  snapshot before teardown (idempotent; regression: retire-check R7).

## Open candidates (untriaged)

- tmux adapter — now **UNBLOCKED**: the placementRef-only seam is done
  (Wave 4), so a second backend needs no edits outside `src/herdr/`'s
  neighborhood plus one line in `index.ts` (ARCHITECTURE.md Law 4 definition of
  done).
- CI green on GitHub runner end-to-end (typebox install fixed on the release
  branch; transport-contract skip-guard in place — needs a real PR run).
- F6 legacy fail-open: consider failing CLOSED for legacy manifests once all
  writers stamp `orchestratorSessionPath` (review minor #3 follow-up; the B1
  masterSessionPath fallback above already scopes most of the surface).

## Post-release backlog (plans written, execution next cycle)

- **fleet.ts decomposition** (ARCHITECTURE.md Law 5): `ui-text.ts`,
  `worker-view.ts` (the single shared read-model for widget, overlay and status
  tool), `fleet-widget.ts`, `fleet-overlay.ts`. The user-visible surface stays
  byte-identical through the split.
- **herdr/host.ts decomposition**: `herdr/cli.ts` (runHerdr + SIGKILL
  escalation), `herdr/socket.ts` (the NDJSON client), `herdr/map.ts` (result
  mappers + the id codec).
- **The execute() shrink**: the remaining spawn-pipeline phases beyond the
  lifted tier/schema resolvers become injectable state machines phase by phase
  (the grace.ts pattern), without changing the tool contract.

