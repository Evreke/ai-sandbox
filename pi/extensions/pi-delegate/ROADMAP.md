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
committed with the epic). Conveyer: research ✅ → PoC (in flight) → impl →
e2e ∥ QA → review.

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

## Open candidates (untriaged)

- tmux adapter (gated on the WorkerHost epic).
- CI green on GitHub runner end-to-end (typebox install fixed on the release
  branch; transport-contract skip-guard in place — needs a real PR run).
- F6 legacy fail-open: consider failing CLOSED for legacy manifests once all
  writers stamp `orchestratorSessionPath` (review minor #3 follow-up).
