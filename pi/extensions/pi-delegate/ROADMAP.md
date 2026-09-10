# Roadmap — pi-delegate

Milestone list. Done items stay for context; open items carry a short design
note (what/why/risks) so a fresh session can pick any of them up without
archaeology.

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

- tmux adapter (gated on the WorkerHost epic).
- CI green on GitHub runner end-to-end (typebox install fixed on the release
  branch; transport-contract skip-guard in place — needs a real PR run).
- F6 legacy fail-open: consider failing CLOSED for legacy manifests once all
  writers stamp `orchestratorSessionPath` (review minor #3 follow-up; the B1
  masterSessionPath fallback above already scopes most of the surface).
- D2 double-mount watcher arbitration: two watcher instances over one session
  (module-copy double load, two pi processes) each keep their own dedup and
  deliver the same event twice; the mount registry is module-global, not
  session-keyed. Low likelihood; fix shape: key the registry by session file
  or persist a watcher-mounted marker (diag-watch-crossfleet C7).
- B4 accept-then-log in makeSender: a sink that QUEUES a wake-up and then
  throws re-fires it after rollback — the user sees the wake twice. Fix
  shape: treat "accepted by pi" as success, keep rollback for genuine
  pre-delivery failures (diag-watch-crossfleet C6).
