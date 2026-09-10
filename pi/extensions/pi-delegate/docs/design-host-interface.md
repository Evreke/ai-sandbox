# Design doc — `WorkerHost` inversion: gap analysis (research, read-only)

Worker: host-research · Repo: `/root/projects/ai-sandbox` @ `feature/release-1.16.0`
(worktree `/root/.herdr/worktrees/ai-sandbox/delegate-host-research`).
All `file:line` references are relative to `pi/extensions/pi-delegate/` unless noted.
Verified against the tree at commit `79e84c9`.

Approved design being verified (not re-derived): interface `WorkerHost`; placement kinds
`worktree`/`tab` frozen; herdr ids leave the interface → opaque `placementRef`; manifests
write `backend:"herdr"` + `placementRef` ALONGSIDE legacy id fields; file split
`src/host.ts` (interface) + `src/herdr/host.ts` (herdr adapter) + `src/host/fake.ts`
(in-memory fake); `transport.ts` → thin re-export shim; user-facing texts neutralized;
frozen surface (tool names, `/delegate-*`, kind values, herdr CLI strings inside adapter)
preserved.

---

## 1. Coupling inventory

Every `herdr` mention in `src/` + `index.ts` + `test/`, classified.
(a) = adapter-internal (fine, moves into `src/herdr/host.ts`);
(b) = interface-shape leak (types/params that assume herdr);
(c) = user/model-facing text leak;
(d) = test coupling.

### 1a. Adapter-internal — moves into `src/herdr/host.ts`

All of `src/transport.ts` SECTION 2 (lines ~417–2090) is herdr implementation:

| Item | file:line | Note |
|---|---|---|
| `WORKTREE_DIR` (`~/.herdr/worktrees`) | src/transport.ts:502 | authority root |
| `WORKSPACE_ID_ENV` (`HERDR_WORKSPACE_ID`) | src/transport.ts:505 | tab placement env |
| CLI timing constants (`CLI_TIMEOUT_MS`, `WAIT_SLICE_MS`, `SIGKILL_GRACE_MS`…) | src/transport.ts:508–526 | |
| `sessionHasReply` | src/transport.ts:556 | ⚠ pi-session JSONL reader, NOT herdr — see note below |
| `GUIDANCE` map — herdr-flavored strings | src/transport.ts:598–620 | ⚠ also (c): `E_PLACE` text says "Reconcile via \`herdr workspace list\`" (603–604) |
| `runHerdr` / `spawnHerdr` (SIGKILL escalation) | src/transport.ts:630–790 | |
| `parseHerdrResult` | src/transport.ts:798 | |
| `isSubOrchestratorCwd` | src/transport.ts:819 | |
| `HerdrSocketClient` + `DEFAULT_HERDR_SOCK`, env kill-switch | src/transport.ts:838–1135 | |
| `HerdrTransport` class (queue, enqueue deadline, all `*Inner` bodies) | src/transport.ts:1140–1918 | |
| `resolveLiveTabId` (drift guard) | src/transport.ts:1845 | |
| `closeWorkspaceIfPresent` / `workspaceExists` | src/transport.ts:1878–1918 | |
| `HerdrPlacement` (tabId extension) | src/transport.ts:1923 | |
| result mappers (`agentStatusFromResult`, `normalizeStatus`, `placementFromWorktreeResult`, `placementFromTabResult`, `extractAgentName`, `pick`, `asString`, `isNotFound`) | src/transport.ts:1925–2060 | |
| `createHerdrTransport` | src/transport.ts:2066 | binding helper, called once in index.ts:110 |

Note on `sessionHasReply`: it reads the worker's **pi session JSONL** — no herdr
dependency. It only *lives* in the herdr section because `waitSettle` uses it. It belongs
in a neutral module (e.g. `src/host.ts` helpers or its own file); the aged-finish proof
concept is backend-neutral.

### 1b. Interface-shape leaks (types/params that assume herdr)

| Leak | file:line | What assumes herdr |
|---|---|---|
| `Placement.workspaceId` | src/transport.ts:144 | herdr workspace id, doc literally says "herdr workspace id" |
| `Placement.paneId` | src/transport.ts:149 | herdr pane id |
| `Placement.isLinkedWorktree` | src/transport.ts:152 | herdr worktree-linkage flag (only used for repo-group prose/teardown reconcile) |
| `StartReq.paneId` | src/transport.ts:165 | `startAgent` is keyed on a herdr pane — must become `placementRef` |
| `AgentStatus.paneId/tabId/workspaceId` | src/transport.ts:219–222 | herdr ids in the read model; `tabId` doc mentions herdr build history |
| `TeardownReq.placement: Placement` | src/transport.ts:226–231 | teardown body consumes `workspaceId` (1786), `tabId ?? paneId` (1816–1818) |
| `ManifestWorker.placement: Placement` | src/exchange.ts:125 | herdr ids persisted into every manifest |
| `WorkerView.workspaceId/paneId` | src/fleet.ts:1619–1620, 1679–1680 | projections of placement for consumers |
| manifest dedup by `placement.paneId` | src/spawn.ts:1093, 1159 | entry-identity by herdr pane id (works with any opaque unique ref) |
| step/progress message shows `paneId` | src/spawn.ts:1063–1072 | cosmetic |
| auto-teardown plan log shows ids | src/spawn.ts:1313 | cosmetic (audit log) |
| retire closeability gate `placement.paneId` non-empty | src/observe.ts:1405 | treats paneId presence as "closeable placement" proxy |
| teardown audit log shows ids | src/observe.ts:1782 | cosmetic |
| `capabilities()` root/sub derivation from herdr worktree root | src/transport.ts:819, 502 (impl of seam `TransportCapabilities` src/transport.ts:233) | authority model = "cwd vs ~/.herdr/worktrees" — herdr-root-specific derivation behind a neutral shape |
| static pins match the literal path `transport/herdr` | test/static-check.ts:51–63, 294–297; test/watcher-check.ts:106–117 | test-layer path coupling; breaks/vacates on the file split |

### 1c. User/model-facing text leaks (tool descriptions, event messages, error guidance)

| Text | file:line | Facing |
|---|---|---|
| delegate tool description "Spawn one herdr worker…" / promptSnippet "Spawn a herdr worker…" | src/spawn.ts:753, 756 | model (tool description) |
| steer nudge "re-prompt the pane manually (herdr) or retry the steer" | src/spawn.ts:486 | model |
| E_NAME guidance "use the canonical name herdr returns when retrying" | src/spawn.ts:879 | model |
| E_PLACE guidance "Reconcile via \`herdr workspace list\`, then retry…" | src/spawn.ts:993 | model |
| "clean it up manually via \`herdr workspace list\`" | src/spawn.ts:1107 | model |
| "herdr uniquified the requested name …" | src/spawn.ts:1122 | model |
| "worker may have exited or herdr is unreachable" (×2) | src/spawn.ts:1688, 1844 | model |
| probe verdict "inspect via herdr agent read" | src/spawn.ts:1758 | model |
| collect note "…while herdr recorded the canonical one" | src/spawn.ts:1955 | model |
| "Read the worker's pane via herdr before retrying" | src/spawn.ts:2010 | model |
| delegate_status description "…herdr status… (from manifests + live herdr)" | src/observe.ts:269–270 | model |
| status promptGuideline "read the pane via herdr" | src/observe.ts:274 | model |
| status output "read the pane via herdr, then answer or re-brief" | src/observe.ts:346 | model |
| mailbox answer-fail "re-prompt the pane manually (herdr agent prompt)" | src/observe.ts:1126 | model |
| answer guidance "open the pane (herdr)" | src/observe.ts:1141 | model |
| worker-dead event "no live herdr status… read the pane (herdr agent read)" | src/observe.ts:1177–1178 | model |
| stale event text (herdr reachability prose) | src/observe.ts:1184–1189 | model |
| teardown advice "reconcive via \`herdr workspace list\`; … \`herdr workspace close <ID>\`" | src/observe.ts:1804 | user+model |
| `GUIDANCE.E_PLACE` "…Reconcile via \`herdr workspace list\`…" | src/transport.ts:603–604 | model (error guidance embedded in typed errors) |

Per the approved design these become neutral ("read the pane", "reconcile via the backend's
workspace listing" → e.g. "reconcile via /delegate-teardown or the host CLI"); the herdr CLI
recipes, where still true, move INTO adapter error messages (adapter may append herdr-specific
recovery text to its own errors — the seam guidance stays neutral).

### 1d. Test coupling

| Test | Coupling | Class |
|---|---|---|
| test/transport-contract.ts | REAL herdr binary; skip gate on `herdr --version` (~lines 60–70); drives worktree create/remove + `workspace list` reconciliation | (d) real-herdr |
| test/reverify-fixes.ts:24–46 | D1 against LIVE herdr; O2 via PATH-stubbed herdr CLI | (d) mixed |
| test/transport-guards.ts | stub `herdr` CLIs on PATH, `HERDR_SOCKET_TRANSPORT=cli` | (d) adapter test, herdr-free |
| test/settle-archive.ts:31–50 | herdr PATH shim | (d) adapter test, herdr-free |
| test/release-on-started-check.ts:34–47 | stub herdr CLI (`agent wait` reports working) | (d) adapter test, herdr-free |
| test/transport-socket.ts | stub NDJSON socket server | (d) adapter-internal |
| test/static-check.ts:51–63, 294–297 | source-text pins on `transport/herdr` path + `src/transport.ts` content | (d) pin, breaks on split |
| test/watcher-check.ts:106–117 | W1.1/W1.1c regex `transport\/herdr` | (d) pin, breaks on split |
| test/retire-check.ts:368+ (`fakeTransport`), test/collect-teardown-driver.ts:97, test/mailbox-check.ts, test/fleet-*.ts, test/ownership-check.ts, test/schema-check.ts, test/report-contract-check.ts, test/usage-check.ts | herdr-free fakes / pure functions | already seam-level |

---

## 2. Placement usage map (who consumes paneId/tabId/workspaceId and why)

| Consumer | Why | Opaque ref sufficient? |
|---|---|---|
| `transport.ts` `startAgentInner` (src/transport.ts:1706–1712) | builds `agent start --pane <paneId>` | YES — adapter decodes its own ref; seam passes `placementRef` |
| `transport.ts` `teardownInner` (1786, 1816–1818) | worktree remove by `workspaceId`; tab close by `tabId ?? paneId` | YES — adapter-internal decode |
| `transport.ts` `resolveLiveTabId` (1845) | drift guard: manifest `tabId` is herdr-volatile (renamed `tab.id`→`tab.tab_id`; fallback recorded paneId) | adapter concern; the drift bug (BUG_FIX_CONTEXT at src/transport.ts:1837 area) is the strongest argument FOR opaque refs + adapter-side live resolution |
| `spawn.ts` manifest dedup (1093, 1159) | identify "the entry THIS call appended" by name+paneId | YES — string equality on `placementRef` works identically |
| `spawn.ts` step/progress + plan log (1063–1072, 1313) | display/audit | YES — cosmetic; print opaque ref or drop |
| `observe.ts:1405` retire gate | "placement without a pane cannot be closed" | YES — switch proxy to `placementRef` presence (with legacy fallback to `paneId` for old manifests) |
| `observe.ts:1782` teardown audit log | audit | YES — cosmetic |
| `fleet.ts` `WorkerView.workspaceId/paneId` (1619–1620, 1679–1680) | projections; fleet UI deliberately strips herdr ids from visible lines (`HERD_ID_RE` src/fleet.ts:518, placeholder 519) | YES — ids already never rendered; nothing genuinely needs structure outside the adapter |
| `observe.ts` ownership (src/fleet.ts:114–153, observe.ts:792–830) | self-identification uses `placement.kind === "worktree"` + `checkoutPath === cwd` | unaffected — uses kind + checkoutPath, both stay |
| `usage.ts` / `resolvePiSessionCandidates` (src/spawn.ts:1531, 1585, 1656) | session JSONL guessing from `checkoutPath` | unaffected — checkoutPath stays in Placement |

**Verdict:** no consumer outside the herdr adapter genuinely needs id structure. All external
uses are (i) opaque equality matching, (ii) cosmetic display (already suppressed in UI), or
(iii) presence checks replaceable by `placementRef` presence.

---

## 3. Interface inventory (Transport methods × callers; herdr-inevitable vs backend-neutral)

Callers: `spawn.ts` (delegate tool flow, steer, collect), `observe.ts` (status tool, watcher,
teardown command), `fleet.ts` (buildWorkerView), `index.ts` (binding only).

| Method | Callers | Backend-neutral? | Notes / flags |
|---|---|---|---|
| `place` | spawn.ts:982 | YES (kinds frozen) | `HERDR_WORKSPACE_ID` env dependency (transport.ts:505, 1640s) is adapter-internal |
| `startAgent` | spawn.ts (delegate flow, after place) | YES once `StartReq` takes `placementRef` instead of `paneId` | name-taken→E_NAME mapping (D4, both failure shapes) is a SEAM contract — the fake must reproduce it; `sessionPath` extraction is adapter work (spawn has a pi-side fallback, spawn.ts:1531) |
| `submitPrompt` | spawn.ts delegate+steer | YES | E_PROMPT_STALLED mapping is seam semantics; keep |
| `waitSettle` | spawn.ts delegate flow | **HARD** | the two-phase state machine is generic, but the observation model — `AgentStatusName` vocabulary, herdr aging done→idle, "never reports working for pi workers" (§19.1b/c) — is herdr-shaped. The STATUS VOCABULARY stays in the seam (watcher/fleet logic depends on it); the quirks stay adapter behavior. `proofSettled` (caller-owned) and `releaseOnStarted` are backend-neutral — keep in seam. `sessionHasReply` helper moves out of the adapter |
| `getStatus` | observe watcher, fleet | YES | "not found → null" contract is seam |
| `listStatuses` | fleet.ts:1654, observe watcher | YES | in-flight dedup (W2 pile-up guard) is adapter-internal |
| `readPane` (optional) | spawn probe verdicts (spawn.ts:1758 text; transport method) | YES as optional | optionality contract ("callers fall back to status-based verdicts") stays; fake may reject to pin the fallback path |
| `teardown` | spawn auto-after-collect (1316), observe retire (1425) + command (1783) | YES | `force` semantic (worktree removal) stays; not-found→idempotent is seam-level (already pinned in tests) |
| `capabilities` | spawn (authority gates), adapter internals | shape YES, derivation is adapter-side | root/sub authority derives from herdr's worktree root (transport.ts:819); a tmux backend must define its own authority story — the seam keeps `{worktrees, authority}` and the frozen AGENTS.md authority model text |

Non-method seam pieces that stay backend-neutral: `PlacementMode`, `AuthorityMode`,
`AgentStatusName`, `SettleResult`, `DelegateError`/E_* taxonomy, report contract,
envelopes, budget constants, `briefPrompt`. All of SECTION 1 of transport.ts (types.ts
verbatim, ~lines 90–414) moves to `src/host.ts` unchanged except `Placement`/`StartReq`/
`AgentStatus`/`TeardownReq` gaining `placementRef` / losing herdr id fields.

---

## 4. Manifest compat (placement persistence)

How manifests are read/written today:
- `readManifest` (src/exchange.ts:312–334): **tolerant** — missing/unreadable/corrupt or
  shape-missing (`task`/`dir`/`workers`) → `null`, never throws. No per-field validation.
- Worker entries are read **tolerantly everywhere**: `workersFromManifests` threads fields
  with per-field typeof/isPlainRecord guards (src/observe.ts:830–861); unknown fields are
  simply ignored (manifest is untyped JSON beyond the top-level shape check).
- `updateManifest` (src/exchange.ts:347–366): read-modify-write under `withFileMutationQueue`,
  atomic rename. Existing worker entries are passed through **by reference** — extra fields on
  entries survive round-trips; `spawn.ts` appends new entries and only rewrites the entry it
  owns (matched by name+paneId, spawn.ts:1093/1159).

Compat strategy (fits the approved decision):

1. **New entries (new code):** write `placement: { kind, checkoutPath, branch?, backend:"herdr", placementRef:"<opaque>", workspaceId, paneId, tabId?, isLinkedWorktree? }` — legacy ids ALWAYS alongside (the approved "ALONGSIDE" rule).
2. **Old extension reading new manifest:** TS type ignores unknown fields; old teardown uses `workspaceId`/`paneId`/`tabId` — present → works. Old retire gate (observe.ts:1405) checks `paneId` — present → works. Nothing breaks.
3. **New extension reading old manifest:** `backend` absent → default `"herdr"` (every legacy entry is herdr by definition); `placementRef` absent → the herdr adapter **synthesizes** the ref from legacy ids (and may resolve the live tab id via the existing `resolveLiveTabId` drift-guard pattern, src/transport.ts:1845, when the recorded signature is the known-broken `tabId === paneId` fallback).
4. **Never delete legacy fields** while any 1.15.x session may still read/close (version skew both directions). Legacy fields may be dropped only after a full cohort rotation.
5. **What breaks if legacy fields disappeared:** old `/delegate-teardown` → `tab_not_found` storm masked as idempotent no-ops while agents stay alive (the exact F6/2026-09-10 drift incident); old watcher retire pass skips every entry (observe.ts:1405 gate) → panes never auto-closed.

Type change needed: `ManifestWorker.placement` (src/exchange.ts:125) widens from
`Placement` to `Placement & { backend?: string; placementRef?: string }` (or a
`PlacementRecord` alias in `src/host.ts`) so TS permits writing the new fields.

---

## 5. Test strategy

Already herdr-free (run on fakes/pure code — keep): watcher-check, retire-check
(`fakeTransport`, test/retire-check.ts:368+), mailbox-check, fleet-*, collect-teardown-*,
ownership-check, schema-check, report-contract-check, usage-check, static-check.

Adapter-specific, herdr-free via stub CLI/socket (keep, they become `src/herdr/host.ts`
tests): transport-guards (queue serialization + deadline), settle-archive (PATH shim),
release-on-started-check (stub `agent wait`), transport-socket (stub NDJSON server),
reverify-fixes O2.

Needs REAL herdr (keep, skip-guarded): transport-contract.ts — this is the herdr leg of
parity; its skip gate (herdr --version, ~lines 60–70) is already the right guard.

What the file split breaks in the test layer:
- `static-check.ts:51–63` (T1.1: regex `transport\/herdr`; T1.1b: index imports
  `src/transport.ts`) and `:294–297` (T3.3 reads `src/transport.ts` source);
- `watcher-check.ts:106–117` (W1.1/W1.1c same regex).
These must be updated IN THE SAME COMMIT as the split — note the "no offender" direction
fails OPEN: after a rename the regex matches nothing and the pin passes vacuously.

New tests the seam needs:
1. **Parity pin:** one scripted scenario — place → startAgent (name-taken case) →
   submitPrompt (stalled case) → waitSettle (normal settle / neverStarted /
   finishedBeforeWatch / startedConfirmed) → teardown (idempotent not-found) — run against
   the fake adapter AND the herdr adapter, asserting identical seam-level outcomes
   (E_* codes, `SettleResult` shapes, manifest placement fields written). Herdr leg behind
   the existing skip gate; fake leg always runs (CI).
2. **Fake adapter simulation requirements** (so watcher/mailbox tests run herdr-free):
   statuses idle/working/blocked/done/unknown with scripted transitions; **done→idle aging**
   and the "never reports working" shape (to exercise proofSettled/finishedBeforeWatch);
   prompt-consumption timing (D3 false-settle shape); abort-detaches-never-kills; teardown
   not-found idempotency; name-taken→E_NAME with candidates; prompt-stalled; optional
   `sessionPath` exposure (absent → budget partial accounting path) and `readPane` that can
   either serve a tail or reject (pins the caller fallback).

---

## 6. Risk list + migration order (for the impl worker)

### Risks
1. **Vacuous static pins after rename** — `transport\/herdr` regexes (static-check T1.1,
   watcher-check W1.1) fail open. Update pins in the same commit as the split; add a
   positive pin: `src/herdr/host.ts` exists and ONLY `index.ts` imports it.
2. **Circular imports.** Current graph is acyclic and layered:
   `transport` (bottom, node-builtins only) ← `usage` ← `exchange` ← `fleet` ← `observe` ←
   `spawn` ← `index` (imports verified: src/transport.ts:83–87; src/usage.ts:45–52;
   src/exchange.ts:78–100; src/fleet.ts:64–73; src/observe.ts:76–122; src/spawn.ts:86–146).
   The risk the brief names (fleet↔observe, spawn↔observe) does NOT exist today — spawn→observe
   (src/spawn.ts:127) and observe→fleet (src/observe.ts:112) are one-directional. It appears
   only if shared helpers migrate wrongly: keep `src/host.ts` bottom-of-graph (node builtins
   only, zero src/ imports); error guidance strings and `sessionHasReply` go into `host.ts`
   or the adapter, NEVER by importing spawn/observe utilities (`errText` etc. — duplicate a
   3-line helper instead).
3. **`ManifestWorker.placement` type** — TS will reject writing `backend`/`placementRef`
   into a `Placement`-typed field; widen the type first (§4) or the write silently narrows
   (excess-property checks only trigger on literals — a spread can silently drop nothing,
   but a `Placement`-typed variable cannot CARRY the new fields).
4. **Retire gate regression** — observe.ts:1405 must become ref-aware (`placementRef ||
   paneId` non-empty) or new-style manifests without paneId would become uncloseable, and
   old-manifest entries must stay closeable (fallback).
5. **Serialized-mutations invariant** — the enqueue/deadline machinery
   (transport.ts:1140–1215, pinned by transport-guards) is herdr-incident-derived; it moves
   WITH the adapter. The seam doc keeps the requirement ("implementations must serialize
   mutating ops"), the fake keeps FIFO ordering so parity tests mean the same thing.
6. **Shim must be complete** — `transport.ts` re-exports BOTH host seam and herdr adapter
   during transition (tests import `createHerdrTransport`, `parseHerdrResult`,
   `placementFromTabResult`, `SIGKILL_GRACE_MS`, `sessionHasReply` from `../src/transport.ts`).
   T1.1b ("index.ts DOES import src/transport.ts") must be updated or kept true deliberately.
7. **Silent behavior change in texts** — neutralizing (c) texts touches tool descriptions the
   model reads; keep every semantic instruction (retry policy, mailbox etiquette), only swap
   herdr-specific command names; changelog + version bump per release ritual.

### Migration order (each step leaves the suite green)
1. **Extract `src/host.ts`**: move SECTION 1 verbatim (seam + contracts + error taxonomy +
   report contract + envelopes + budget constants). `transport.ts` becomes a full re-export
   shim. Zero behavior change; all tests pass unchanged.
2. **Extract `src/herdr/host.ts`**: move SECTION 2 + socket client + mappers verbatim;
   `transport.ts` shim re-exports it too; update static-check/watcher-check path pins +
   T1.1b in the same commit. Add the positive-existence pin.
3. **placementRef + backend field**: widen `ManifestWorker.placement` (exchange.ts:125);
   `Placement`/`StartReq`/`AgentStatus`/`TeardownReq` gain `placementRef` (StartReq) and
   manifest records gain the alongside fields; herdr adapter writes+synthesizes refs;
   observe.ts:1405 gate becomes ref-aware with legacy fallback; spawn dedup switches to ref
   equality. Old manifests still readable (backend defaults "herdr").
4. **`src/host/fake.ts`** + parity pin test (§5).
5. **Text neutralization** (§1c list) — one PR, changelog minor bump.
6. **Binding swap + shim dies**: `index.ts:110` chooses adapter (config/env; default herdr);
   delete `transport.ts` shim, update remaining imports; final pin update.

---

## 7. PoC charter (smallest spike that de-risks the impl)

Scope: migration steps 1–2 + a minimal fake adapter + 3 verbs end-to-end.

Must do:
- `src/host.ts` extracted (seam verbatim), `src/herdr/host.ts` extracted (impl verbatim),
  `transport.ts` = re-export shim; full existing suite green with NO test edits except the
  static-pin path updates (proves the split is mechanical).
- Minimal `src/host/fake.ts` implementing `place`, `startAgent`, `teardown` (+ just enough
  `waitSettle` to return scripted settles) writing manifests with
  `backend:"herdr"`-style `backend:"fake"` + `placementRef` alongside legacy-shaped fields.
- Drive the 3 verbs end-to-end through the existing `collect-teardown-driver`-style flow on
  the fake: manifest record round-trip, teardown idempotency, ref-based dedup matching.

Must prove:
1. The split is byte-mechanical: no src/ behavior change, only pin-path edits.
2. The seam works with an opaque `placementRef` end-to-end (place→manifest→teardown) with
   the herdr ids confined to the adapter.
3. The updated static pins CATCH a deliberately reintroduced adapter import from a tool
   module (pin efficacy, not vacuous pass).
4. A manifest written by the PoC is readable by the PRE-change reader semantics (parse with
   the old `Placement` expectations: kind/checkoutPath/paneId present) — version-skew both
   ways demonstrated on a fixture.

De-risks skipped by the PoC (defer to impl): waitSettle parity leg on real herdr
(transport-contract already covers), full text neutralization, binding/config swap.
