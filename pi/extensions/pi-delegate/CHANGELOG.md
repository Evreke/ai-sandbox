# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version numbers align with the iteration numbering in DESIGN.md (v1.x sections).

## [Unreleased]

### Changed

- **Watcher wake-up delivery is fail-closed by default (watcher stage A).**
  A manifest with no owner fields anywhere (legacy) no longer delivers
  wake-ups to every mounted watcher; only a proven owner session is woken.
  The single rollback is the explicit config key `watch.legacyFailOpen:
  true`, which restores the old legacy delivery and is unsafe on a machine
  with several sessions (bystander wakes return). A session that cannot read
  its own identity delivers nothing unconditionally — this edge has no
  configuration escape. Skipped deliveries are recorded in the watcher audit
  file (`~/.pi/agent/delegate-watch.log`) with the reason; a spawn that
  could not record an owner path warns the orchestrator explicitly.

## [1.16.1] — 2026-09-11

### Changed

- Migration stage 1 (architecture-audit steps 1–4, behavior-preserving hardening):
  - Shared conventions extracted to exported constants: staleness threshold
    (duplicate copies in observe.ts and fleet.ts replaced by one import),
    config path, probes directory, teardown journal format, repeat-mandate text.
  - Error codes are now carried on typed error objects instead of being parsed
    from message text; new codes for teardown failure and status-read failure;
    guidance hints produced by a single factory with adapter-supplied detail.
  - Teardown results carry a structured `alreadyGone` field — closing an
    absent worker is no longer an error; regex-based "not found" detection
    removed; adapter parity check extended to cover the new field.

## [1.16.0] — 2026-09-10

### Changed

- **WorkerHost inversion (migration complete)**: the herdr boundary is now a
  backend-neutral seam (`src/host.ts`, type name `Transport` kept) plus a
  herdr adapter (`src/herdr/host.ts`) bound once in `index.ts` from the
  config's `"host"` key (default `herdr`; unknown value → structured error).
  The `src/transport.ts` re-export shim is deleted. Zero behavior change on
  the herdr path; the in-memory fake (`src/host/fake.ts`) ships as the
  second adapter (PoC promoted).
- **Opaque `placementRef` threading**: `StartReq` is keyed by an
  adapter-defined `placementRef` (herdr ids left the seam read model —
  `AgentStatus` is `{name, status, placementRef?}`); spawn manifest
  dedup/rollback matches on name+placementRef with a legacy-paneId fallback;
  the retire closeability gate is ref-aware.
- **Neutralized texts**: all 19 model/user-facing herdr-specific command
  names in tool descriptions, event messages and error guidance replaced
  with backend-neutral phrasing (retry/mailbox/escalation semantics
  unchanged); herdr CLI recipes stay inside adapter error messages.
- **Watcher log UX**: routine watcher bookkeeping (e.g. retire successes) no
  longer surfaces in the pane — every line goes to the audit file
  `~/.pi/agent/delegate-watch.log`; the pane shows only errors and anomalies.

### Fixed

- **Duplicate report-ready wake-ups (true defect, diag D1)**: the watcher's
  dedup state reset treated a no-observation tick (transient report ENOENT)
  as "condition stopped being true" and forgot fingerprinted seen-keys —
  the same report fired twice with an UNCHANGED mtime. Fingerprinted kinds
  keep their key until the worker vanishes or the fingerprint changes
  (regression: W16.16).
- **Foreign-fleet wake broadcast narrowed (diag B1)**: the ownership gate
  consults the manifest-level `masterSessionPath` when a worker entry lacks
  `orchestratorSessionPath` — a known foreign owner stays silent; fail-open
  remains only for manifests with no owner field anywhere (W14.18–W14.23).
- **Archive-at-retire**: a TTL auto-retire of an UNCOLLECTED worker no
  longer orphans its report — retirePass archives the report + manifest
  snapshot before teardown (idempotent; retire-check R7).
- **herdr tab-id drift (implement-osb field report)**: herdr renamed the
  tab-create result key `tab.id` → `tab.tab_id`; the parser missed the new
  spelling and recorded the PANE id as `tabId`, so every autonomous tab close
  failed `tab_not_found` while the agent stayed alive (the paneId fallback
  also masked the failure as an idempotent retire). The parser now reads the
  current spelling (legacy accepted), `AgentStatus` carried `tabId` during
  the transition, and teardown re-resolves the live tab id from the herdr
  registry when the recorded one carries the broken paneId-fallback signature.
- **Worktree teardown idempotency (parity-pin find)**: a SECOND teardown of
  an already-removed worktree failed E_PLACE with herdr
  `workspace_not_found`; the seam contract (and the fake, and the tool
  layer's already-gone handling) requires a no-op success. Not-found-shaped
  removal errors are now idempotent in the herdr adapter.
- **`/delegate-teardown` output**: manifest history entries (retired workers
  are never deleted) are skipped with a count instead of being attempted —
  no more wall of `tab_not_found` errors for long-closed workers; a
  not-found close inside the command is a clean "already closed, no-op".
- **Stale nudge-failed marker**: a same-name retry deletes any leftover
  marker at spawn (a fresh watcher session would re-fire it once).
- **Fixture hygiene / manifest scan backend gate** (field lesson
  2026-09-10): a test manifest written into the live /tmp/exchange root
  woke a bystander orchestrator through the fail-open legacy scan. The scan
  now drops entries whose placement declares a non-empty backend other than
  the active host; the exchange root is overridable via
  `$PI_DELEGATE_EXCHANGE_ROOT` and all test fixtures sandbox under mkdtemp
  dirs.
- Root `package.json` version synced to the extension's (1.15.1 divergence).

### Added

- **F6 — two-tier delegation wake-up**: a session that is a worker of a parent
  manifest AND the orchestrator of its own child manifests (a tier-1 lead)
  now mounts a watcher scoped to ITS OWN children — tier-2 report-ready/
  mailbox-question wakes the lead without meta-orchestrator nudges. The
  pre-existing `createWatcher` leafWorker mute is scoped the same way.
- **Mailbox nudge resilience**: the answer/steer pane nudge retries with
  backoff (3 attempts); on repeated failure a watcher-visible
  `nudge-failed-<name>.json` marker delivers the wake-up on the next tick
  instead of the socket (kind `nudge-failed`, fingerprint = marker ts).
- **Trunk-based development + CI**: PR-gated squash-only flow (AGENTS.md);
  GitHub Actions — `ci.yml` (bun check suite + package.json version sync on
  every PR) and `release.yml` (on main: rerun suite → semver tag → GitHub
  Release with notes from the fresh CHANGELOG section).
- **host-parity pin** (`test/host-parity-check.ts`): one place → manifest →
  teardown flow asserted on BOTH adapters — fake always (CI), real herdr
  behind the existing `herdr --version` skip guard.
- Static pins re-targeted after the split: T1.1d (the seam imports node
  builtins only), T1.1c positive pin (only index.ts imports the adapter).

### Fixed

- **herdr tab-id drift (implement-osb field report)**: herdr renamed the
  tab-create result key `tab.id` → `tab.tab_id`; the parser missed the new
  spelling and recorded the PANE id as `tabId`, so every autonomous tab close
  failed `tab_not_found` while the agent stayed alive (the paneId fallback
  also masked the failure as an idempotent retire). The parser now reads the
  current spelling (legacy accepted), `AgentStatus` carries `tabId`, and
  teardown re-resolves the live tab id from the herdr registry when the
  recorded one carries the broken paneId-fallback signature.
- **Retire pass idempotency**: a herdr "not found" during the autonomous
  close (pane already gone) is treated as a successful retire — no more
  `tab_not_found` error spam every tick; genuine teardown failures keep the
  advisory retry.
- **`/delegate-teardown` output**: manifest history entries (retired workers
  are never deleted) are skipped with a count instead of being attempted —
  the command no longer prints a wall of `tab_not_found` errors for
  long-closed workers; a not-found close inside the command is a clean
  "already closed, no-op" success (parity with the retire pass).
- **Stale nudge-failed marker**: a same-name retry deletes any leftover
  marker at spawn (a fresh watcher session would re-fire it once).
- `nudgeFailedPathFor`/`readNudgeFailedMarker` moved to `exchange.ts`
  (module boundary — exchange-dir conventions live there).
- Root `package.json` version synced to the extension's (1.15.1 divergence).
- Legacy fail-open ownership for worker-orchestrators is pinned by tests
  (W16.14/W16.15) — a deliberate policy, now a conscious one.

### Changed

- README rebuilt bilingual (EN/RU) with header cross-links; the field case
  study and client identifiers removed from the public surface (NDA scrub).
- **Watcher log UX**: routine watcher bookkeeping (e.g. routine retire
  successes) no longer surfaces in the pane — every line goes to the audit
  file `~/.pi/agent/delegate-watch.log`; the pane shows only errors and
  anomalies (close failures, "pane was already gone").

## [1.15.0] — 2026-09-09

### Added

- **Fleet usage accounting (F1)** — persistent per-task accounting for every
  delegate fleet: total output tokens, prompt-cache hits, sent volume (input-
  token proxy), worker count; a fleet description (3–10 words, derived once
  from the first brief of the task) and a link to the master orchestrator's
  session log (`masterSessionPath`) are stored in the task manifest and never
  overwritten. Aggregates are recomputed from worker session files on read
  (cached snapshot in the manifest with `computedAt`); missing or corrupt
  session files yield partial totals with a marker instead of an error.

#### How to use fleet usage accounting

After a fleet has run, call `delegate_status` (or `/delegate-fleet`) — each
task dir now prints one aggregate line after the per-worker rows:

```
fleet rng-sum "delegate random number summation": ↓1.2k out · cache 840 · sent 3.1k · 8 workers
```

`↓out` = total output tokens, `cache` = prompt-cache reads, `sent` = input-
token proxy for data sent. `[partial: …]` names workers whose session files
were missing/corrupt. Totals are read-only — no config needed; the numbers
live in the task's `manifest.json` (`usage` section) and survive restarts.

### Changed

- **Layout v2: 7 flat modules** — the src/{tools,transport,ui} taxonomy is
gone; src/ is now `index.ts` (wiring only) + `spawn.ts` (delegate+mailbox
pipeline), `observe.ts` (status tool, watcher, config), `fleet.ts` (all
UI + ownership + worker views), `exchange.ts` (report/manifest/mailbox
lifecycle + archive), `transport.ts` (herdr boundary, E_* taxonomy),
`usage.ts` (unchanged). Every module opens with a ZCS MODULE_CONTRACT
header naming the invariants it owns (DESIGN.md "layout v2").

### Fixed

- **Report-contract precedence** — the injected report contract now
explicitly overrides a conflicting brief OUTPUT section (rng-sum incident:
a worker wrote `{"number": 6}` and failed schema validation).
- **Retriable E_REPORT_INVALID/E_REPORT_MISSING** — retry guidance now
mandates a NEW suffixed worker name (`<name>-r2`); the original name stays
taken by the settled agent.
- **Phantom manifest entries** — a refused spawn (E_START) no longer leaves a
manifest entry without `sessionPath` (rollback in the startAgent catch,
append-before-start teardown invariant preserved).
- **Mailbox reaches Done workers** — `delegate_mailbox` steer/answer now
wakes a settled worker via a new turn instead of silently dropping the
mail; honest no-op warning for unknown status.
- **`reportSchema` echo** — a brief-declared report JSON Schema is echoed
into the worker prompt, so workers write against the schema they are
validated against.
- **§23 retire (opt-in)** — auto-teardown of drained worker panes, disabled
by default: enable `watch.retire: true` (+ `watch.retireTtlMs`, default
900000); off by default, behavior unchanged when off.
- **Portable worktree paths** — `WORKTREE_DIR` resolved via `os.homedir()`
instead of a hardcoded `/root/...`; new static check bans `/root/` literals
in src/.

### Tests

- Regression pins for all four fixes above (red/green proven), new
`fleet-usage-check.ts` (21 checks), `mailbox-check.ts` (17), retire
R1–R6 matrix; 14 runnable suites + tsc green.

## [1.14.2] — 2026-09-08

### Fixed

- **No more duplicate `report-ready` wake-ups across session restarts** —
  field incident (2026-09-08): an orchestrator
  verified a landed report WITHOUT a formal collect (manual read + commit
  verification), so no `collectedAt` was ever stamped; every session restart
  re-fired report-ready for the same accepted report — the watcher's `seen`
  dedup is session-scoped memory, and the gap is cross-session. Fix in
  `src/watch.ts` + `src/exchange.ts` (DESIGN.md §21):
  - New manifest field `notifiedReportMtime` (stringified report mtimeMs):
    after a SUCCESSFUL batch send the watcher stamps the delivered report
    fingerprint into the manifest worker. The watcher — reader of every other
    manifest field — becomes a writer of exactly this one; `collect` leaves it
    untouched.
  - Detection gates `report-ready`/`report-invalid` on
    `String(reportMtime) !== notifiedReportMtime` alongside the `collectedAt`
    gate: a fresh session no longer re-wakes on an already-announced report.
  - Fingerprint-keyed, so a REWRITTEN report (new mtime) re-arms normally;
    `collectedAt` still outranks (collected reports stay silent regardless).
  - Advisory by contract: stamping is mutation-queue-serialized, idempotent,
    failure-logged and swallowed (can only cost a duplicate wake, never a
    lost one); a FAILED delivery stamps nothing — the batch re-fires while
    still true.
- **Tests**: new `test/watcher-notify-check.ts` (N1–N8, 17 checks): fire →
  stamp → fresh-session silence, rewritten-report re-arm, collectedAt
  precedence, failed-delivery rollback, mixed-batch stamping (question +
  report), report-invalid symmetry. Verified live against the incident
  manifest: tick 1 wakes and stamps, a fresh-session tick stays silent.

## [1.14.1] — 2026-09-07

### Fixed

- **Skill no longer pulls the orchestrator into the manual herdr ritual** —
  field: asking the model to delegate sometimes loaded the skill and followed
  REFERENCE.md's manual herdr CLI spawn ritual instead of calling the
  `delegate` tool. Two causes fixed in `pi/skills/delegate`:
  - REFERENCE.md carried skill frontmatter with the same aggressive trigger
    description — a competing pseudo-skill whose body IS the manual ritual;
    frontmatter removed (it is a sub-doc, not a skill).
  - SKILL.md buried the tool-first rule mid-paragraph; now a non-negotiable
    lead rule: tool in the tool list → the ONLY spawn/collect path; the
    ritual is for sessions where the extension is missing; topologies and
    anti-patterns stay valid reading. E_TIMEOUT row updated to the v1.14
    watcher discipline (end turn, watcher wakes).

### Added

- **Bundle manifest** — the repo root is now an installable pi package
  (`pi.extensions` + `pi.skills`): pi-delegate extension and the delegate
  skill ship together from one source of truth. The loose copies under
  `~/.pi/agent/{extensions,skills}` are retired to
  `delegate-archive/*-prebundle`; `pi install git:github.com/Evreke/ai-sandbox`
  (or the local path) replaces manual syncing.

## [1.14.0] — 2026-09-07

### Added

- **Early release on started worker (`watch.releaseOn: "started"`)** — field
  (delegate tab obpl-fix/calc-fix, 2026-09-07): the delegate call blocked the
  full settle gate even after the worker was already observed working — the
  orchestrator sat parked for 15–20 s per fan-out while the only remaining
  outcome was the §21 handoff. New `watch.releaseOn` config (values `settle`
  default / `started`) plus a per-call `releaseOn` param: once `waitSettle`
  observes the worker working, the call returns a success-shaped
  "orchestrator released" result (`startedConfirmed: true`) and the
  end-your-turn discipline applies immediately. Spawn failures are still
  caught (they precede the first working observation); fast inline settles
  (within one wait slice) still return the report synchronously; probes are
  exempt — their full window IS the verdict. DESIGN.md §20.5/§22.

## [1.13.0] — 2026-09-07

### Added

- **Fleet overlay self-describing fold + stale ordering + legend parity
  (fleet-UX wave 4)** — read-only-display fixes from the verified UX
  investigation (report-lex/report-act/report-pulse); DESIGN.md §15/§22.3:
  - **Self-describing folded lines** (report-lex fix 1): the folded grammar
    `~ owner.slug xN -- L B ! Q v s` (memorization burden 11) is retired for
    `~ <class> <slug> · N workers · counts… · idle <age>` — class token
    space-separated from the slug (the dot-join read as a hostname), no bare
    `xN`, no `--` separator, no letter flags; counts are words (live /
    blocked / hot-ctx (≥CONTEXT_WARN_PCT) / question / rep), non-zero only,
    old flag order. Identity (class + slug + worker count) LEADS the line so
    fitRow's left-to-right degrade keeps it under width pressure. Mega-line
    uses the same vocabulary, stays one line, mixed tag stays truthful
    (`foreign+owner?`).
  - **Stale age tail with ownership-scoped remedy** (report-lex fix 2 ∘
    report-act fix 3): the `s` letter's exact condition (isFleetStale —
    every member collected ≥30 min, semantics unchanged) now renders as
    `idle <age>` carrying the OLDEST member's collectedAt age (`31m`,
    `3h46m`); no stamp → no tail. Remedy is scoped: mine groups read
    `… (/delegate-teardown)`, foreign/`owner?` groups read `… · owner can
    tear down` — the global sweep is never advertised to bystanders.
  - **Foreign-fleet framing line** (report-act fix 1): when any
    foreign/`owner?` group is on screen, one dim legend line states the
    viewer's role: `○ ◌ = another session's fleet — informational; only its
    owner can act` (affirms the §22 canon).
  - **Legend parity** (report-lex fix 3): FLAT legend gains keys for tokens
    its surface renders but never explained — `owner?` untraceable, the `—`
    probe dash, `├└ group`, `↑↓ in/out`. FOLD legend becomes a one-line
    WORKED EXAMPLE of the new grammar plus a minimal key (live=working/
    blocked · rep=report landed · idle=collected ≥30m). Each legend packs
    greedily into at most two physical dim lines (`packLegend`, one when it
    fits).
  - **Stale-aware ordering + window trim** (report-pulse fix 2): ONE new
    `rankGroups` tiebreak layer — fully-stale groups sort below
    otherwise-equal groups (after class rank, before slug); in the height
    window, fresh blocks fill first and fully-stale blocks are admitted
    only after every fresh block is shown, so a live (working/blocked) row
    is never hidden while a stale-group row is visible. Group-atomic
    guarantee kept; NO admission changes — every manifest worker still
    renders (archived tier explicitly out of scope).

### Changed

- Expanded MY flat rows are byte-identical (verified against the regenerated
  goldens); widget (fleet-ui.ts), watch.ts, commands.ts, tools/* untouched.
  Chrome grows by up to 2 lines (second legend line + framing), shrinking
  the height window accordingly; window goldens moved to terminalRows 12.

### Tests

- `test/fleet-tree-check.ts`: folded-grammar expectations updated to the new
  grammar (H3–H5, G3b, S2–S5, W2b) and new cases added — W5 age formatting,
  W6 mine-vs-foreign remedy scoping, W7/W7b stale ordering tiebreak (and
  class-rank precedence), W8/W8b/W8c stale-aware trim priority, W9–W9e
  legend parity + framing line + packLegend two-line cap. All goldens
  deliberately regenerated (the diff is the review artifact).
- All check scripts green except `transport-contract` (known env-broken:
  live herdr spawn — unchanged).

## [1.12.1] — 2026-09-07

### Added

- **Lifecycle hygiene — teardown-after-collect + `worker-stale` + fleet `s`
  flag (fleet-UX wave 3; user decisions locked: default ON, grace 0, only on
  VALID collect, foreign fleets never mutated)** — DESIGN.md §22:
  - **Teardown-after-collect** (`delegate` tool): after a successful strict
    collect (report valid, `collectedAt` stamped) the worker is torn down
    automatically via the transport with its recorded placement. Skips:
    probes (panes stay this wave), `collect.teardownAfterCollect: false`, and
    a pending `q-<name>.json` (the worker is still in a conversation).
    Invalid/failed collects never reach the hook (the pane is needed for
    diagnose). **Advisory by contract**: the hook can only append a note —
    `Auto-teardown: …` or `Warning: … collect unaffected` — to the already-
    decided result; no failure alters a collect outcome or throws past the
    tool boundary. Audit lines mirror the `/delegate-teardown` format into
    the same `<dir>/teardown.log`, suffixed `(auto-after-collect)`.
  - **`resolveCollectConfig`** (`src/watch.ts`, beside `resolveWatchConfig`):
    `collect.teardownAfterCollect`, default **true**, tolerant — missing/
    corrupt/non-boolean → default, never throws.
  - **`worker-stale` watcher event** (§21 union): manifest `collectedAt`
    older than `watch.staleAfterMs` (new key, default 30 min, floor 60 s) and
    the worker still live → "collected N min ago and still mounted — tear it
    down (/delegate-teardown) or keep". Fingerprint = `collectedAt` (a
    re-collect re-arms); silent when not live / herdr unreachable / stamp
    unparseable; the ownership gate already silences foreign fleets and is
    not bypassed. `startWatcher` threads the config threshold.
  - **`s` flag in the fleet overlay** (folded group grammar): appended after
    `L B ! Q v`, non-zero-only, = EVERY member collected ≥30 min ago
    (stale-idle; one fresh member suppresses the group claim). Pure
    `isFleetStale` + injectable render clock; shares the watcher's 30-min
    default; legend gains `s stale`; no new fs reads (rides the manifest the
    overlay already reads). Widget untouched.

### Tests

- New `test/collect-teardown-check.ts` + `collect-teardown-driver.ts`: the
  C1 config matrix, C2 valid → torn down exactly once / invalid / q-pending /
  probe / teardown-throws → collect still succeeds (real `execute()` over a
  mock transport, child-process `$HOME`), C3 config-off, C4 static pins
  (guard order, advisory shape, commands.ts audit mirror).
- `watcher-check.ts`: W15 (fires once, re-arms on re-collect, suppressions,
  foreign-owner silence, key fingerprint, threshold config W2.8–W2.10).
- `fleet-tree-check.ts`: S1–S6 (`s` threshold matrix, every-member rule,
  flag order, mega threading) + folded goldens regenerated for the `s stale`
  legend + V11/V12 `s`-flag goldens (fixed clock).
- All check scripts green except `transport-contract` (known env-broken:
  live herdr spawn — unchanged).

## [1.12.0] — 2026-09-07

### Added

- **Ownership display — fleet-UX stage 1 (glyph + attention-gated fold +
  fitter fix)**: /tmp/exchange manifests are cross-session, so both fleet
  surfaces now say whose workers they are showing. Variant A "Glyph & fold"
  from the fleet-UX design wave (report-ux-own.json), widget policy per user
  decision (attention-gated):
  - **classifyOwnership** (new `src/ownership.ts`, pure): manifest
    `orchestratorSessionPath` === this session's `getSessionFile()` → mine;
    present+different → foreign; absent/empty (legacy manifest) → UNKNOWN.
    Degraded self-id falls back to the worktree `checkoutPath === cwd` match
    (mirrors watch.ts isSelf); tab workers are NEVER matched by cwd. Display
    is FAIL-CLOSED — unknown never renders as mine (deliberate asymmetry vs
    the watcher's fail-open).
  - **Overlay** (`/delegate-fleet`): the row's lead space became an ownership
    glyph column — ● mine (accent), ○ foreign (muted), ◌ legacy (dim) — and
    the legend gained `● mine ○ foreign ◌ legacy`.
  - **Widget** (ambient live rows): MY live rows are byte-identical to
    before; foreign/legacy live workers fold into at most one line per class
    (≤2 total): `○ N foreign live (task1, task2)` / `◌ N legacy live (…)`.
    A class line appears ONLY when that class has a `blocked` worker or one
    at ≥80% context burn (CONTEXT_WARN_PCT) — a quiet foreign fleet renders
    NOTHING above the editor. No new fs reads.
  - **Fitter latent-bug fix**: `layoutFleetRows`' fixed cost ignored the
    double space before the usage column (15 → real 17) and now also carries
    the glyph column (+1 → 18, verified against the rendered row shape);
    floors and shrink priority unchanged. `test/fleet-render-check.ts`
    updated mechanically (rowTotalW helper, L2 expected branch width).
  - New tests: `test/ownership-check.ts` (classifyOwnership case matrix +
    fold-policy cases incl. the fixture-shaped no-line case and an all-mine
    byte-identical golden).
- **Task tree + Tab fold — fleet-UX stage 2 (overlay only)**:
  `/delegate-fleet` rows now group by task + owning session
  (`manifest.dir :: orchestratorSessionPath`, pure `groupWorkerViews`);
  legacy manifests fail open into a per-dir `owner?` bucket that is never
  labeled foreign. Foreign/unknown groups get a one-line dim header
  (`▼ prod-prep · 2/4 live · foreign · ctx↑63%` — ctx is the MAX burn
  across members, dropped when unknown) with `├`/`└` tree glyphs inline in
  the name column (fitter untouched), and fold BY DEFAULT to
  `~ foreign.prod-prep x4 -- L2 v2` (flags: L live, B blocked, ! ctx≥80,
  Q mail, v report; >6 groups collapse into one mega-line). Tab toggles
  fold/unfold (session-scoped memory, folded on first open, no-op when
  nothing is foldable; header hint swaps). Groups sort by their most
  actionable member (mine < owner? < foreign on ties, then slug) and the
  height window is group-atomic — a header never appears without its
  children. MY OWN rows render exactly as stage 1: flat, byte-identical.
  While folded the legend shows the flag key. Per-row ownership glyphs
  stay on every row. Widget untouched. New pure helpers unit-tested in
  `test/fleet-tree-check.ts` (group key, fail-open, two-session split,
  rank ties, flag matrix, fold state machine, pinned goldens at innerW
  58/78/98 folded+expanded, group-atomic window, exact innerW+2 line
  width regression, single-width glyphs).

## [1.11.1] — 2026-09-06

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
