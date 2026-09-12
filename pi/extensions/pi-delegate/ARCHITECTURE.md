# ARCHITECTURE — the pi-delegate constitution

> Drafted 2026-09-11 from the four-way healing audit of the 1.16.1 line
> (pi-compliance, architecture, reliability, release-ops auditors, ~40
> evidence-backed findings). This document binds every future developer agent
> — human or machine — that touches this repository. It is the layer above
> DESIGN.md: DESIGN says how the system is built, this says what we will and
> will not do to it, and why, so the next generation of agents does not have
> to rediscover these rules through incidents.

## 0. The audit verdict, in one paragraph

The architecture is fundamentally sound: the WorkerHost seam holds (only
`index.ts` imports a backend adapter — verified by reading every import), there
are no import cycles, `lifecycle.ts` is a genuine total reducer, `usage.ts`
enforces the one-parser law, `exchange.ts` has a real storage port with two
parity-pinned implementations, and the check suite (29+ deterministic files,
run through `test/run-checks.sh`) is green on HEAD. The disease found by the
audit is concentrated and specific: two critical violations of pi's extension
contract (an enum parameter shape that breaks Google models; seven hardcoded
`~/.pi/agent` paths that ignore pi's directory exports), module-global state
where session-scoped state is required (one session's shutdown can stop another
session's watcher), five god-modules whose extraction seams were already
designed but never executed, two contracts that lie about behavior, a packaging
drift (typebox bundled where pi's docs require a peer), and release machinery
that does not use the purpose-built deterministic test runner. Everything below
turns those findings into law so they cannot silently return.

## 1. The ten laws

### Law 1 — The platform is the API. Import, never reimplement.

pi is not a passive host; it is a library with exports. Before writing any
helper, grep pi's exported surface. Concretely binding:

- Directory constants: `getAgentDir()` and `CONFIG_DIR_NAME` from
  `@earendil-works/pi-coding-agent` — never join `os.homedir()` with literal
  `.pi`/`agent` segments (audit: 7 such sites; they break `PI_CODING_AGENT_DIR`
  and rebranded distributions).
- Tool parameter enums: `StringEnum` from `@earendil-works/pi-ai` — never
  `Type.Union` of string literals (breaks Google models; audit: the
  `releaseOn` parameter).
- Output truncation: `truncateHead`/`truncateTail` and the
  `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES` constants — every tool return path
  that can carry worker-written content must be bounded; the LLM must be told
  when and where content was cut.
- File conventions: `parseFrontmatter`, `withFileMutationQueue` (already in
  use — keep it that way), `pi.exec` where its semantics suffice.
- The known, documented exception: the herdr adapter's raw subprocess runner
  (it needs SIGTERM→SIGKILL escalation with stdio destruction that `pi.exec`
  does not provide). The exception is documented in the adapter header, which
  is exactly where future re-litigation should find it.
- Exchange-layer path assembly routes through the single portable builder
  (`src/expaths.ts`, `node:path`, Windows + POSIX); raw separator-shaped
  construction (template-literal `/` joins, separator-shaped `split`/`endsWith`)
  is statically pinned away.

**Enforcement:** `test/static-check.ts` grows banned-pattern pins (hardcoded
`.pi/agent` joins, `Type.Union([...Type.Literal])` on tool parameters, missing
truncation imports on the tool modules). A violation fails CI, not a review.

### Law 2 — Contracts must be true.

`MODULE_CONTRACT` / `FUNCTION_CONTRACT` blocks are how the next agent reads
this codebase without archaeology. A contract that describes a world that no
longer exists is worse than no contract (audit found two: the seam module
claiming "no I/O of its own" while a helper reads session files; the fleet
ownership section still describing the pre-stage-A fail-open world).

Rules: any commit that changes behavior updates the affected contract in the
same commit. Reviewers verify at least one random contract per PR against the
code. Where a deviation from a documented invariant is intentional (e.g. the
one I/O site in `host.ts`), the contract says so explicitly at the point of
deviation.

### Law 3 — Session lifetime owns everything mounted in it.

Everything a `session_start` handler mounts — the watcher, the ambient fleet
widget, timers, file handles — is owned by a **per-session context object**
created in that handler and torn down in the paired `session_shutdown` of the
same session. Module-global registries are deprecated as a mechanism: they made
it possible for one session's shutdown to dispose another session's watcher,
and for a double module load to run two watchers with independent dedup that
deliver every wake twice (audit: the D2 double-delivery mechanism is live in
code, and the related accept-then-log rollback re-fires delivered wakes).

Rules: mounts return handles; handles are stored on the session context; teardown
of a session touches only its own handles. A second mount for the same session
file refuses rather than silently replaces. Every double-delivery class gets a
regression check that simulates it.

### Law 4 — The seam stays deep and backend-blind.

The `Transport` interface (canonical term: WorkerHost) is the only place a
backend is visible. Rules:

- `placementRef` is the only required handle; herdr-shaped legacy fields
  (`workspaceId`, `paneId`) become optional compatibility, never requirements
  a second backend (tmux is the planned one) must fake.
- Adapters know nothing about the exchange layer: no adapter writes or reads
  manifests (the in-memory fake's manifest-mirroring branch must die before it
  is ever bound for real).
- One mutating operation per backend invocation, serialized inside the adapter.
- All backend failure shapes are translated to the E_* taxonomy at the seam;
  no herdr verb, field, or CLI string leaks above `src/herdr/host.ts`.

**Definition of done for this law:** a competent agent could write a tmux
adapter touching only `src/herdr/`'s neighbors' worth of new files plus one line
in `index.ts` — no edits in `spawn.ts`, `observe.ts`, or `fleet.ts`.

### Law 5 — Modules are responsibilities, not parking lots.

A `src/` file above roughly one thousand lines must either have a single
responsibility or carry a written decomposition plan with an owner and a target
release. SECTION banners inside a file are extraction seams designed to be
executed, not admired (audit: `exchange.ts` contains an entire planned module
inlined verbatim and never split).

The target shape (from the decomposition plan; the `exchange.ts`, `observe.ts`
and `spawn.ts` splits LANDED in 1.17.0 — layout v3; the `fleet.ts` and
`herdr/host.ts` splits and the remaining `execute()` shrink stay planned for
the next cycle):

- `exchange.ts` splits into: `archive.ts`, `manifest-store.ts`,
  `report-schema.ts`, `mailbox-store.ts`, `watch-store.ts`, with `exchange.ts`
  remaining as the exchange-root conventions plus a facade.
- `observe.ts` splits into: `watch-config.ts` (this one kills the
  spawn→observe dependency edge), `watch-detect.ts`, `watch-retire.ts`,
  `watcher.ts`, `status-tool.ts`, `commands.ts`.
- `spawn.ts` yields: `tool-result.ts`, `clock.ts`, `grace.ts`,
  `mailbox-tool.ts`; the remaining delegate-tool flow shrinks phase by phase.
- `fleet.ts` yields: `ui-text.ts`, `worker-view.ts` (the single shared
  read-model used by widget, overlay, and status tool), `fleet-widget.ts`,
  `fleet-overlay.ts`.
- `herdr/host.ts` yields: `herdr/cli.ts`, `herdr/socket.ts`, `herdr/map.ts`.

The user-visible surface never moves: tool names, parameter shapes,
`/delegate-*` command names, manifest `kind` values, journal event names stay
byte-identical through every split.

### Law 6 — Layering is enforced by machine, not by prose.

Every dependency rule this document states must have a pin in
`test/static-check.ts` (or an equivalent automated check), because prose rules
rot. Current pins to keep: only `index.ts` imports a backend adapter; the
observe→fleet one-way edge; the one-parser law. Pins added with the split
wave (1.17.0): T1.8 — no `src/` module imports `observe.ts` except
`compose.ts` (the spawn→observe edge stays dead — config lives in
`watch-config.ts`); T1.9 — `src/` builds exchange-layer paths only through
`expaths.ts`; the exchange-layer leaves (`expaths.ts`, `host.ts`) stay
leaves.

A new cross-module edge requires either a new pin or an explicit waiver
sentence in the importing module's header naming the reason.

### Law 7 — On-disk formats are versioned contracts.

Every durable file this extension writes — manifest, mailbox question/answer
envelopes, release markers, watcher satellites, the delivered-facts store — is
a protocol with a version. The delivered-facts store is the standard pattern:
an explicit `schemaVersion` the reader checks; absent means version 1; a wrong
version yields an empty-but-valid result, never a misparse. Format schemas
live in code next to their readers; prose may explain, but never carries the
only copy.

### Law 8 — Errors are structured; deviations from pi conventions are documented.

- Every refusal carries its E_* code and a recovery hint the orchestrator can
  act on. No raw `throw new Error` crosses the tool boundary (the single
  parity-wrapper exception in the herdr CLI runner is documented at the site).
- The deliberate deviation from pi's throw-to-signal-error convention
  (structured results instead of throws, because detach/timeouts are
  control flow, not failures) is stated in README and DESIGN, including which
  code classes are control flow and which are genuine failures.
- Anything that can wake or notify a session defaults to fail-closed
  (ownership gates); anything marked advisory (watcher, fleet UI, archive)
  must be structurally incapable of failing a spawn or collect.

### Law 9 — One artifact, one source of truth.

The delegate skill must exist in exactly one place (audit: two diverged copies
that even load differently per install layout — the repo bundle loaded the
stale one). One spelling per fact: the 80% budget threshold existed as three
unrelated constants. One implementation per shared mechanism: worker-row
assembly, the audit-log sink, the tolerant filesystem probes, the error-text
helpers. When two copies are discovered, deletion is the fix; "keep both in
sync by hand" is not a state, it is a bug.

### Law 10 — Every fixed bug buys a regression check.

A fix without a check is a rumor. The deterministic runner
(`test/run-checks.sh`: per-file timeout, at most one environment-flake retry,
explicit ENV-FAIL verdict) is the only test gate; CI and the release workflow
must invoke exactly it, not a re-implemented loop. Bugs found by audit (the
double-delivery pair, the collectedAt race) get their checks in the same wave
as the fix. Tests stay single-purpose, mkdtemp-isolated, machine-independent,
and self-skipping only with a printed reason.

## 2. Working agreements for developer agents

- **Trunk discipline.** `main` is always releasable. Work happens in
  `feature/<topic>` / `fix/<topic>` branches, lands via squash-merge PRs, gated
  by CI (canonical check suite + typecheck + version sync + changelog-section
  presence). No direct commits to `main`.
- **Release authority is human.** The operator is the sole release authority:
  the tag and GitHub Release are created only after the operator has
  personally tested the release candidate. Agents may prepare everything up to
  the merge-ready PR, and must stop there.
- **Dogfooding rule.** This repository builds the tool that builds this
  repository: all multi-agent work runs through pi-delegate itself (briefs in
  the exchange tree, strict JSON reports, budget caps, evidence in every
  finding). Every major release should include at least one task that was
  implemented by a fleet of its own workers.
- **Audit cadence.** Before every minor release, re-run the four-way audit
  (pi compliance, architecture, reliability, release ops) on the release
  branch. Findings are triaged into the roadmap; none are carried silently.
- **Documentation is part of the definition of done.** README, DESIGN, and
  AGENTS.md claims are contracts (Law 2). A behavior change that makes a doc
  claim false is an incomplete change.

## 3. The frozen surface (restated; never rename)

herdr CLI verb strings · herdr JSON field names (`workspace.worktree.*`,
`is_linked_worktree`) · the `not_linked_worktree` token · manifest
`kind: "worktree"` value · journal event names (`delegate-fleet`,
`spawn`/`collect`) · `/delegate-*` command names · tool names and parameter
shapes · the E_* code names. Extension happens by addition; correction happens
by deprecation with `prepareArguments`-style compatibility, never by silent
reshape.

## 4. Debt ledger (audit findings → their disposition)

Every finding from the 2026-09-11 audit lives in exactly one of: the
stabilization plan (`STABILIZATION.md`, this cycle), or the post-release
backlog (`ROADMAP.md`, next cycle) with an owner-nameable reason. The ledger
below is the map; the plans hold the detail.

| Audit cluster | Disposition |
|---|---|
| Google-breaking enum schema; hardcoded agent-dir paths | Wave 0 (compliance) |
| tsc red (6 production errors), no typecheck gate | Wave 0 + Wave 1 (gate) |
| CI bypasses deterministic runner; changelog gate late; tag race; bun pin | Wave 1 (release machinery) |
| Session-global registries (double delivery ×2); collectedAt race | Wave 2 (session lifecycle) |
| Diverged skill copies; broken skill links; typebox packaging | Wave 0 / Wave 1 |
| God-modules: exchange, observe, spawn, fleet, herdr | Wave 3 (exchange + observe + spawn helpers) and post-release backlog (fleet, herdr, execute() shrink) |
| Seam legacy fields; truncation duty; format versions; fsync; watcher tick I/O; silent catches | Wave 4 (hardening) |
| Constitution + doc truth sweep | Wave 5 (this document and its siblings) |
