# STABILIZATION — from the 1.16.1 line to a stable release in 10 days

> The execution plan for the healing audit (2026-09-11). Companion to
> `ARCHITECTURE.md` (the laws) — this file is the schedule. One wave = one
> feature branch = one PR = one review gate. Each wave ends with the canonical
> check suite green; from Wave 1 onward, also `tsc --noEmit` green.
>
> **Hard rule: no release without the operator's explicit approval.** The agent
> team prepares everything up to the merge-ready release PR and stops; the
> operator tests the candidate personally; only then does the tag get created
> by the release workflow.

## Definition of stable (the exit criteria)

1. `tsc --noEmit` (repo QA config) is clean on `src/` and `test/`, and both
   workflows run it as a gate.
2. The canonical runner `test/run-checks.sh` is green (0 FAIL, 0 unexplained
   ENV-FAIL) and is the exact command both CI and the release workflow execute.
3. Zero critical pi-compliance findings outstanding (Google-model enum shape,
   agent-dir paths, truncation duty, typebox packaging — all resolved).
4. The double-delivery bug class is closed: session-keyed lifecycle mounts,
   accept-then-log fixed, collectedAt race fixed — each with a regression check
   that fails on the pre-fix code.
5. The delegate skill exists in exactly one place; both install layouts load
   the same text.
6. `exchange.ts` and `observe.ts` are decomposed per the plan; `spawn.ts`
   helper modules extracted; new layering pins present in `static-check.ts`.
   (The `fleet.ts` / `herdr` splits and the big `execute()` shrink are
   explicitly planned for the next cycle — written down, not forgotten.)
7. Docs truthful: README/DESIGN spot-checked, ARCHITECTURE.md landed,
   ROADMAP.md refreshed with the post-release debt ledger, CHANGELOG complete
   for the release version, version bumped in both `package.json` files.
8. A fresh compliance re-audit on the release branch reports no critical and
   no major finding that is not explicitly waived in writing.

## The team

Orchestrator (the architect) owns decomposition, review gates, and the merge
queue. Per wave: one tech-lead worker (translates the wave brief into
file-level changes, supervises), implementer workers (worktree-isolated,
one branch per wave to avoid cross-worker conflicts), a QA worker (runs the
canonical runner + tsc, reports evidence), and at the end a fresh compliance
auditor. All workers produce strict JSON reports with `file:line` evidence;
all budgets are the configured defaults; all spawns go through the extension
itself (the dogfooding rule).

## Wave 0 — Compliance & correctness (days 1–2) · branch `fix/heal-compliance`

Mechanical fixes, each small, each with evidence; where the repo discipline
demands it, each lands with its regression check.

- Replace the `Type.Union([Type.Literal("started"), Type.Literal("settle")])`
  shape of the `releaseOn` parameter with `StringEnum` (the `mode`/`action`
  parameters already show the pattern). Verify no other enum-shaped tool
  parameter uses `Type.Union`/`Type.Literal`.
- Migrate all seven hardcoded agent-dir sites to pi exports: config path,
  watcher audit log (both copies), user schema library dir, archive root,
  pi-sessions root, project-local schema dir — `getAgentDir()` for
  `~/.pi/agent` destinations, `CONFIG_DIR_NAME` for the project-local `.pi`
  path. Add the static-check pin banning literal `.pi/agent` joins in `src/`.
- Fix the six production TypeScript errors (the lifecycle `collected` union
  comparisons need the reachable-vs-dead-code decision made explicit; the
  herdr adapter's possibly-undefined deref; the `string | undefined` →
  `string | null` assignment), and clean the test-side errors enough that the
  repo QA config typechecks (mostly `@types/bun` / `import.meta.dir` config).
- Move `typebox` from `dependencies` to `peerDependencies` with `*` (optional
  meta), refresh the lockfile, fix the stale "typebox is a peerDependency" CI
  comment to become true.
- Guard both command handlers with `ctx.hasUI` before any dialog/notify call.
- Rewrite the unnamed `promptGuidelines` bullets so each names its tool.
- Fix the two lying contracts (`host.ts` module header, `fleet.ts` stale
  fail-open paragraph) and delete the dead `BUDGET_WARN_FRACTION` (or wire the
  three "80%" spellings through one constant — prefer wiring).
- Add the missing `prepareArguments` shim on the delegate tool folding
  `timeoutMs` legacy calls into `waitMs` (schema stays strict).

Gate: suite green, `tsc --noEmit` green, new static pins pass.

## Wave 1 — Release machinery (day 3, half day) · branch `fix/heal-release-infra`

- Both workflows invoke `./test/run-checks.sh` instead of the ad-hoc loop
  (removes the `|| bun test` fallback that silently retries failures and erodes
  the FAIL/ENV-FAIL distinction).
- Add the changelog-section check to the PR gate (conditional on a version
  bump vs the base branch), so a bump-without-changelog fails before merge.
- Serialize release runs with a concurrency group; treat "tag already exists"
  on push as a no-op success.
- Pin the bun version in both workflows (deliberate bumps only).
- Add `DESIGN.md` to the extension `files` array (the shipped skill links to
  it), or de-link the two references — prefer shipping it.

Gate: a real PR run of both workflows is green end to end.

## Wave 2 — Session lifecycle (days 3–5) · branch `fix/heal-session-lifecycle`

- Introduce the per-session context object in `index.ts`: `session_start`
  builds it (session file, transport, self-identity), mounts return handles,
  `session_shutdown` tears down exactly that object's watcher handle and fleet
  dispose. Keep module registries only as the render-time fallback they still
  need to be.
- Refuse a second watcher mount for the same session file (the double module
  load case) — plus the regression check simulating two watcher instances over
  one snapshot.
- Fix accept-then-log in the delivery sender: "accepted by pi" counts as
  delivered; rollback survives only for genuine pre-delivery failures — plus
  its regression check.
- Close the watcher-vs-collect race: re-read `collectedAt` immediately before
  sending a report-ready batch (or have collect write the delivered record into
  the owning audience's store).
- Single-source the skill: delete `pi/skills/delegate/` (the stale copy), point
  the root manifest's skills entry at the extension's copy, verify both install
  layouts load identical text.
- Deduplicate row assembly: one `buildFleetRow` consumed by the widget deps and
  the overlay; delete the `index.ts` copy of `readManifestExtras`.

Gate: the three new regression checks fail on pre-fix code and pass on
post-fix; suite green; both layouts resolve the same SKILL.md.

## Wave 3 — Decomposition wave (days 5–7) · branch `refactor/heal-decompose`

Order matters: the foundation everyone imports goes first.

1. `exchange.ts` → `archive.ts`, `manifest-store.ts`, `report-schema.ts`,
   `mailbox-store.ts`, `watch-store.ts`; `exchange.ts` keeps the exchange-root
   conventions and a temporary re-export facade so ~30 import sites flip in a
   controlled follow-up instead of one big bang.
2. Extract `watch-config.ts` out of `observe.ts` — this kills the
   spawn→observe dependency edge (Law 6 pin added: spawn never imports
   observe).
3. `observe.ts` → `watch-detect.ts`, `watch-retire.ts`, `watcher.ts`,
   `status-tool.ts`, `commands.ts`; `observe.ts` remains as facade for one
   release, then import sites flip.
4. `spawn.ts` → `tool-result.ts` (also absorbed by `observe.ts`'s commands,
   killing the byte-identical helper copies), `clock.ts`, `grace.ts`,
   `mailbox-tool.ts`. The remaining ~1400-line `execute()` closure is NOT
   rewritten this cycle — only the two phases that read no closure state
   (tier resolution, schema resolution) become pure functions now; the full
   shrink is the written next-cycle plan.
5. Deduplicate the six cross-module helper clusters the audit listed
   (`errText`/`asDelegateError`, filesystem probes, mailbox-state, `fmtK`).

Rules: verbatim moves only (no behavior edits ride on refactors); every step
ends with the suite green; no frozen-surface token moves. `fleet.ts` and
`herdr/host.ts` splits are explicitly out of this cycle (they go to the
backlog with their plans already written in `ARCHITECTURE.md` §Law 5).

Gate: suite green; line-count evidence; new static pins pass.

## Wave 4 — Seam & hardening (days 7–8) · branch `fix/heal-hardening`

- `workspaceId`/`paneId` become optional in `Placement` (`placementRef` is the
  only required handle; the code already prefers `placementRef ?? paneId`).
- Truncation duty: import pi's truncation helpers; bound the delegate success
  payload (report summary + artifacts/evidence arrays), `delegate_status` rows
  (cap + "N more" note), mailbox question bodies. The LLM is told what was cut.
- Add `schemaVersion` (absent = 1, reader-tolerant) to the manifest and the
  mailbox/release envelopes, following the delivered-store pattern.
- Decide fsync: either add `fsync` before rename in the single atomic writer
  (cheap, do it) or document the degradation in DESIGN — prefer doing it.
- Watcher tick: cache satellite stamp layers per (path, mtime) like the
  delivered-store cache; stop re-tail-parsing up to 1 MB of session JSONL per
  worker per tick when the fingerprint is unchanged.
- Surface archive failures with a reason instead of a bare null; log the
  start-failure manifest-rollback failure; count failed audit-log appends.

Gate: suite green; a fleet-scale manual check that the watcher tick is cheap.

## Wave 5 — Docs & freeze (days 8–9) · branch `docs/heal-constitution`

- Land `ARCHITECTURE.md`; amend the repo and extension `AGENTS.md` to point at
  it (docs-only commits — no version bump needed).
- Truth sweep: every claim in README and DESIGN verified against HEAD; the
  structured-error deviation from pi's throw convention documented (Law 8).
- Refresh `ROADMAP.md`: post-release backlog (fleet/herdr splits, `execute()`
  shrink, tmux adapter, Windows phases, orchestrator-model milestone) with the
  already-written plans attached.
- Write the release CHANGELOG section; bump the version in BOTH `package.json`
  files in the same commit.

Gate: fresh compliance re-audit worker on the release branch — no critical, no
unwaived major findings.

## Day 10 — Release candidate & the operator gate

- Final full gate: canonical runner + `tsc --noEmit` + static pins + re-audit
  verdict, all green on the release branch.
- Open the release PR into `main`, let CI pass, squash-merge.
- **STOP. Hand the build to the operator for personal testing.** The release
  workflow will create the tag and the GitHub Release only if the version is
  higher than the latest tag — but the agent team's work ends at the merge;
  the operator decides when the candidate is good. No tag, no announcement,
  no follow-up release until the operator's explicit go.

### Manual QA gate — Windows host

Real-Windows E2E (delegate spawn → report → wake → mailbox on a Windows machine with
herdr for Windows) is NOT run on CI — only Windows-shaped path tests (`path.win32`
fixtures) run on the POSIX CI. An operator must run this gate on a real Windows host
before claiming Windows support beyond the exchange/path layer; until then the honest
claim is "the exchange/path layer is Windows-portable; the host backend on Windows
requires herdr for Windows".

## Risks and their mitigations

- **Refactor regressions (Wave 3):** verbatim moves only, one wave = one PR =
  revertable, behavior pinned by the ~900-assertion suite that already exists.
- **tsc cleanup expanding beyond estimate:** the six production errors are
  decision-work; test-file noise is config. Timeboxed: if the test-side tail
  threatens the schedule, gate `tsc` on `src/` first and extend in Wave 5.
- **The suite's blind spots** (cross-process races, crash consistency): the
  double-delivery checks close the two known live bugs; the cross-process
  manifest invariant (one task dir per session) gets asserted, and the
  remaining exposure is documented rather than silently carried.
- **herdr availability for live E2E:** transport contract checks self-skip
  without herdr; the live end-to-end demo happens at the operator gate, on
  this machine, before approval.
