# DESIGN — `pi-delegate` extension v1

Status: **APPROVED 2026-09-05** · Owner: root tech lead (pi orchestrator) · Date: 2026-09-05

---

## 1. Problem

The delegate skill is prose discipline: the orchestrator model must re-derive and faithfully
execute a ~100-line ritual (transport choice, brief files, worktree creation, agent spawn,
prompt pointing at the brief, poll-based collection, teardown) on every run. Each ritual step
is a failure-rate source: wrong flags, forgotten smoke tests, `--wait` misuse, panes read
instead of report files, verbatim retries.

## 2. Goal

Compile the ritual into code. The orchestrator model calls **`delegate`** (spawn + brief +
collect) and **`delegate_status`** (observe) instead of hand-typing herdr incantations.
Judgment stays with the model: decomposition, brief content, verification, merge decisions.

**Non-goals for v1:** budget governor, enforced diagnosed-retry, typed report schemas
(these are extensions #4/#2 territory), merge-gate enforcement (#3), mission-control
overlay (#5).

## 3. Locked decisions (user-approved)

| Decision | Choice |
|---|---|
| v1 scope | Medium: `delegate` + read-only `delegate_status` |
| Transport | Thin `Transport` interface; herdr is impl #1 |
| Code home | Local-only git repo `/root/projects/pi-delegate`; symlinked to `~/.pi/agent/extensions/pi-delegate/` |
| DoD | Design approved → live end-to-end demo: extension spawns a real worker that completes a task |
| Worker model | `--provider llm-platform-alpha --model glm-5.3-flash` built-in; per-run override via ~/.pi/agent/pi-delegate.config.json `{"defaults": {"provider", "model", "thinking"}}` (v1.9.1) or explicit tool params (user override of default tier table, 2026-09-05) |
| Call semantics | `delegate` **blocks** until worker settles; Esc detaches (worker keeps running, recoverable via `delegate_status`); fan-out = parallel tool calls |
| Report contract | **Strict**: fixed JSON schema enforced by the tool on collect (format chosen by tech lead: JSON over XML — native model emission, trivial validation) |
| Placement modes | `worktree` + `tab` only; pane splits cut (leaky geometry, no isolation; sub-orchestrator tab support is the valuable half) |
| Smoke probe | Explicit `mode: "probe"` param — no magic |

## 4. Architecture

### 4.1 Module layout

```
pi-delegate/
├── DESIGN.md                 # this document
├── index.ts                  # entry: registers tools + commands; wires transport
├── src/
│   ├── transport/
│   │   ├── types.ts          # Transport interface, WorkerHandle, WorkerStatus (the seam)
│   │   └── herdr.ts          # HerdrTransport: child_process → herdr CLI, JSON parsing
│   ├── exchange.ts           # exchange dir conventions + manifest (deep module)
│   ├── state.ts              # worker registry persisted via pi.appendEntry (survives restarts)
│   ├── usage.ts              # session-JSONL usage parsing + budget math
│   ├── archive.ts            # report archive (§19.3)
│   ├── tools/
│   │   ├── delegate.ts       # delegate tool
│   │   ├── status.ts         # delegate_status tool
│   │   └── mailbox.ts        # delegate_mailbox tool (§12)
│   ├── ui/
│   │   ├── fleet-ui.ts       # ambient fleet widget + footer chip + render hooks (§19.4)
│   │   └── fleet.ts          # /delegate-fleet overlay (§15)
│   └── commands.ts           # /delegate-teardown command
└── test/                     # QA harness (live spawn tests, design-conformance checks)
```

Dependency rule (enforced by test/static-check.ts): `tools/`, `ui/` and `commands.ts` never
import `transport/herdr.ts` directly. The transport is injected in `index.ts`.

### 4.2 Transport interface (the seam)

```ts
interface Transport {
  place(req: PlacementReq): Promise<Placement>;         // worktree workspace | tab
  startAgent(req: StartReq): Promise<{ name: string }>; // returns canonical name (herdr 0.8.x rejects collisions → E_NAME; canonical = requested)
  submitPrompt(req: PromptReq): Promise<void>;          // submission only, no settle wait
  waitSettle(req): Promise<SettleResult>;               // poll-based settle observation
  getStatus(name: string): Promise<AgentStatus | null>;
  listStatuses(): Promise<AgentStatus[]>;
  teardown(req: TeardownReq): Promise<void>;
  capabilities(): { worktrees: boolean; authority: "root" | "sub" };
}
```

`PlacementReq` carries `mode: "worktree" | "tab"`, `repoPath`, `branch`, `label`, `base?`.
The interface is deliberately narrow: every herdr verb the tools need is reachable through
its 8 methods (`place`, `startAgent`, `submitPrompt`, `waitSettle`, `getStatus`,
`listStatuses`, `teardown`, `capabilities`; `submitPrompt` was split from the old combined
prompt+settle call in v1.2). Implementations must honor the **one mutating op per
invocation** rule internally.

### 4.3 Worktree authority rule — enforced in code

On load, the extension inspects cwd: if under `~/.herdr/worktrees/`, the session is a
**sub-orchestrator**: `place()` only ever issues `tab create` (workers share the checkout);
`teardown()` only closes tabs. Root mode (elsewhere) may use `worktree create/remove`.
This turns the skill's most safety-critical prose rule into a structural invariant.

## 5. Tool contracts

### 5.1 `delegate` — spawn one worker, brief it, wait for settle

Parameters (typebox):

| Param | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | `[a-z][a-z0-9_-]{0,31}`; validated; collision → herdr **rejects with E_NAME** (no auto-uniquify); canonical name = requested name and is returned |
| `briefPath` | string | required | must exist and be non-empty; must live under an exchange dir (validated, absolute path resolved; leading `@` stripped) |
| `mode` | `"worktree" \| "tab" \| "probe"` | `"worktree"` | `tab` = shared checkout (file-slice fan-outs, sub-orchestrators); `probe` = smoke gate (§5.1 step 4) |
| `repoPath` | string | cwd | base for worktree/tab placement |
| `branch` | string | `delegate/<name>` | worktree branch name |
| `base` | string | HEAD | non-HEAD base ref |
| `provider` | string | `defaults.provider` in config, else `llm-platform-alpha` | |
| `model` | string | `defaults.model` in config, else `glm-5.3-flash` | |
| `thinking` | string | `defaults.thinking` in config, else `high` | |
| `timeoutMs` | number | 900000 | settle timeout for prompt (`agent wait`) |
| `extraArgs` | string[] | `[]` | appended after `--` (e.g. `--session`) |

Behavior:

1. **Validate** name + brief file (reject missing/empty brief before touching herdr).
2. **Ensure exchange dir** from brief path; write/append `manifest.json` (task slug, worker
   name, placement ids, branch, started-at, model). Manifest is the teardown + audit source.
3. **Place**: `worktree create` (root) / `tab create` (sub or `tab` mode). Record
   workspace/pane ids. **Manifest record is written immediately after place() succeeds,
   BEFORE startAgent** — placements are tracked even on E_START, so
   /delegate-teardown can always clean them up.
4. **Smoke gate**: explicit `mode: "probe"` spawn — worker prompted to reply exactly
   `OUTPUT: OK`; catches dead panes/flags before a ≥3 fan-out. No automatic probing (locked).
5. **Start**: `herdr agent start <name> --kind pi --pane <id> --timeout <120000> -- --provider
   <p> --model <m> --thinking <t>`. A name collision is rejected by herdr (E_NAME) — the
   canonical name equals the requested name; the return states it so callers can rely on it.
6. **Brief**: prompt = `Read <briefPath> and follow its instructions exactly. Reply with only
   the file path.` Submitted with short `--timeout` (no indefinite `--wait`); settle observed
   via `herdr agent wait --until idle,done,blocked --timeout <timeoutMs>` in a poll loop
   (clock-instability mitigation; abort signal cancels the *wait*, never the worker).
7. **Collect probe**: check the report file declared in the manifest (report-<name>.json
   convention; on name collision, check both canonical and requested names).
   Existence — not `done` status — is the criterion.
8. **Return** (structured, also human-readable): canonical name, placement ids, branch,
   final status, report file: `exists | missing (treat as failed spawn)`, elapsed, warnings
   (name uniquified, timeout hit, status `blocked` → "read pane / answer or re-brief").

Streaming: `onUpdate` emits placement → started → prompting → settled transitions so the
orchestrator's TUI shows progress. Abort (Esc) detaches: worker keeps running, recoverable
via `delegate_status`.

### 5.2 `delegate_status` — observe, never mutate

Params: `name?` (one worker) or omitted (all known workers from manifest + `herdr agent list`).
Returns per worker: name, status (`idle|working|blocked|done|unknown`), placement kind,
branch, workspace/pane ids, report file exists, started-at, elapsed. Read-only by contract:
the tool contains no mutating calls (verified in review).

### 5.3 `/delegate-teardown` command

Interactive: lists workers from manifest, confirms, then per worker: tab close (sub mode) or
`worktree remove --force` (root mode), one mutating op per invocation, sequence pre-logged to
`teardown.log` in the exchange dir. Never runs automatically.

## 6. Exchange dir conventions (compiled from skill §1–§2)

```
/tmp/exchange/{TASK}/
├── manifest.json        # written by extension; source of truth for teardown/audit
├── brief-<name>.md      # written by orchestrator (model), validated by tool
└── report-<name>.json   # written by worker; validated against fixed schema on collect
```

**Report schema (fixed, v1 — strict contract):**

```json
{
  "worker":   "<canonical worker name>",
  "status":   "pass" | "fail",
  "summary":  "one-paragraph outcome",
  "artifacts": ["path/or/id", "…"],
  "evidence": [{"claim": "…", "file": "path:line", "note": "…"}]
}
```

Enforcement on collect: report must exist, parse as JSON, and validate against this schema
(`worker` matching the canonical name; `status` enum; non-empty `summary`). Anything else →
`E_REPORT_INVALID` → failed spawn → diagnosed retry is the orchestrator's move. Completion
criterion is **valid report**, never `done` status — the tool's return text states this so the
orchestrator model inherits the discipline without having read the skill.

## 7. Error taxonomy (all surfaced as structured tool results, never thrown raw)

| Code | Meaning | Guidance embedded in return |
|---|---|---|
| `E_BRIEF` | brief missing/empty/outside exchange dir | write brief first |
| `E_NAME` | invalid/colliding name | use returned canonical name |
| `E_PLACE` | worktree/tab/pane creation failed | herdr stderr attached; reconcile via `herdr workspace list` (skill §6.3) |
| `E_START` | agent start failed | check pane readiness; retry is a new `delegate` call |
| `E_PROMPT_STALLED` | no state change within 5 s of submit | worker pane not at prompt; inspect via status |
| `E_TIMEOUT` | settle wait exceeded | worker still running; poll `delegate_status` |
| `E_REPORT_MISSING` | settled but no report file | treat as failed spawn; diagnosed retry is the orchestrator's move |
| `E_REPORT_INVALID` | report exists but fails JSON schema | attach validator output; treated identically to missing |

Note (taxonomy backlog, deferred 2026-09-05): dedicated codes for teardown failures
(`E_TEARDOWN`) and for the read-status failure shapes currently surfaced as status
`unknown` are a documented backlog item — today they degrade into existing codes /
unknown-status rather than first-class taxonomy entries.

## 8. Testing strategy (Phase QA)

- **Static/design conformance**: dependency-rule check (tools never import herdr.ts),
  read-only check on `delegate_status`, name validation, authority-mode unit tests
  (fake cwd under worktrees dir).
- **Transport contract tests** against real herdr, cheap: `capabilities()`, placement+
  teardown round-trip in a throwaway repo, name uniquification.
- **Live E2E (the DoD demo)**: from a pi session with the extension loaded, call `delegate`
  with a tiny brief (worker writes `report-e2e.md` containing a fixed marker); assert report
  exists and return is structured correctly. Run in this sandbox, not anywhere precious.

## 9. Risks / mitigations

| Risk | Mitigation |
|---|---|
| Host clock churn (10+ 'Clock change'/5 min observed) | settle via `agent wait` poll loop, short timeouts, never indefinite waits |
| herdr output JSON drift between versions | herdr parsing isolated in `herdr.ts`; contract tests catch drift; skill §6.3 reconcile logic embedded in E_PLACE guidance |
| Parallel mutating herdr ops hang the pane process group | transport serializes mutating ops internally (queue), one per call |
| Workers spawned from sub-orchestrator remove worktrees | authority mode detected at load; sub mode structurally cannot place worktrees |
| glm-5.3-flash behavior differs from flash tier | demo runs against the real model before sign-off |

## 10. Phase plan

1. **D (this doc)** → user approval.
2. **I**: parallel workers — `transport/herdr.ts` + `exchange.ts` (worker A), `tools/` +
   `index.ts` (worker B), disjoint files, both in worktrees off this repo. Types in
   `transport/types.ts` authored by me (tech lead) first — the seam is the review artifact.
3. **QA**: worker C runs §8 test plan in its own worktree.
4. **Review**: axis fan-out (design conformance / security-authority / error-path review).
5. **Demo**: end-to-end run orchestrated through the extension itself.

---

# v1.2 — typed mailbox (approved 2026-09-05, round-5 grill)

## 11. New capability: brief-declared report schemas

- Brief markdown gains YAML frontmatter; key `reportSchema` holds a JSON-Schema
  fragment. Absent frontmatter → v1 base schema only (backward compatible).
- Collect validates each report against **base ∩ brief fragment**. Validator:
  typebox `Value.Check` (already available via the symlinked typebox package —
  no new dependencies; JSON-Schema-compatible subset documented in code).
- Base schema remains the floor: worker/status/summary/artifacts/evidence are
  always required; fragments may constrain further (types, required extras, enums).

## 12. New capability: two-way file mailbox

```
/tmp/exchange/{TASK}/q-<name>.json   # worker → orchestrator question
/tmp/exchange/{TASK}/a-<name>.json   # orchestrator → worker answer/steering
```

- Question envelope: `{ worker, ts, question, context?, options? }`.
- Answer envelope: `{ from: "orchestrator", ts, answer }`.
- **Prompt template** gains one standing line: if blocked on a decision the brief
  does not resolve, write `q-<name>.json` and go idle; an answer will appear at
  `a-<name>.json`; between steps, poll it when the brief says steering is expected.
- **AWAITING_ANSWER semantics**: settle + `q-<name>.json` present + no valid report
  → structured "awaiting answer" tool result carrying the question — NOT a failure.
  The orchestrator answers (or relays to the human via an interactive question deck
  when one is available; file answer is the fallback), then re-prompts via
  `delegate_mailbox`.
- **New tool `delegate_mailbox`** (orchestrator-facing):
  - `action: "read" | "answer" | "steer"`, `name`, `text?`.
  - `read` → pending question(s), never mutates.
  - `answer` → write `a-<name>.json` + nudge prompt ("mailbox answer posted — read
    a-<name>.json and continue"); same for `steer` (mid-run guidance).
- `delegate_status` shows pending Q/A per worker.

## 13. v1.2 DoD

Live demo impossible without the channel: worker hits a brief ambiguity mid-run,
asks via mailbox; orchestrator resolves (relaying through an interactive question
deck if available); worker completes with a brief-declared-schema report that v1
collect would have rejected.

---

# v1.3 — budget governor (approved 2026-09-05, round-6 grill)

## 14. Enforced budgets, config-driven defaults, per-session accounting

- **Accounting**: per-SESSION totals parsed from the worker's session JSONL
  (`usage` blocks of assistant messages) — workers are one-task-per-session by
  construction. The session path is captured from the `herdr agent start` result
  (`result.agent.agent_session.value`) and recorded in the manifest.
- **Enforcement** (new error code `E_BUDGET`):
  1. Pre-spawn: if the manifest already holds a session for the same worker whose
     recorded usage exceeds the budget, `delegate` refuses to spawn → E_BUDGET
     ("worker over budget — diagnosed retry requires a NEW worker name or an
     explicit higher budget; budget decline is your policy, the tool only
     enforces what you pass").
  2. Post-settle: actual usage is read and embedded in every terminal result
     ("usage: ↑in ↓out (P% of budget B)"), with a warning line above 80%.
- **Declaration**: `delegate` gains optional `budgetTokens`. Default resolution:
  `~/.pi/agent/pi-delegate.config.json` → `{"defaults": {"budgetTokens": N}}`,
  falling back to the code constant (150_000, per the skill's execution-tier rule).
  Config missing/corrupt → fallback, never an error.
- **declining-retry support**: the tool enforces the budget it is given; declining
  budgets across diagnosed retries remain orchestrator policy — the result text
  reminds of the remaining headroom to make that easy.
- **delegate_status** gains per-worker `usage/budget` display.
- **DoD**: live refusal demo — a worker run with a deliberately tiny budget
  (exceeded by any real run), then a second `delegate` for the same name refused
  with E_BUDGET deterministically.

---

# v1.4 — mission-control overlay (approved 2026-09-05; built as the dogfood run)

## 15. /delegate-fleet — live fleet overlay

- `pi.registerCommand("delegate-fleet")` opens a full-screen TUI overlay via
  `ctx.ui.custom()`; nothing auto-opens; read-only by contract.
- Rows: one per worker from `buildWorkerView()` (state.ts) merged with
  `parseSessionUsage()` + `resolveBudget()` (usage.ts):
  `name  status  kind  branch  report✓/✗  Q?/A→  ↑in ↓out (P% of budget)`.
- Refresh: 2 s interval re-render while open; `q`/Esc closes; no mutations ever.
- Files: `src/ui/fleet.ts` (new, the overlay component — deep module: one
  `openFleetOverlay(ctx, deps)` entry), `src/commands.ts` (registers the command),
  `index.ts` (import). No transport/seam changes.
- DoD: live TUI demo — overlay opened in a real interactive pi session (herdr
  pane), shows ≥1 live worker row with correct status + budget burn, closes on `q`.
- Process note (dogfood): this feature is built entirely through the pi-delegate
  tool itself — all worker spawns/collections via `delegate` headless calls;
  hand-typed herdr is allowed only for teardown/audit/reconciliation. Metrics
  (retries, budget warnings, contract violations) recorded in the final report.

---

# v1.5 — schema composition, versioning, progress pings (approved 2026-09-05)

## 16. Reusable report types (schema library + inheritance)

- Named schema types live as JSON files in a schema library, searched in order:
  1. project-local `.pi/delegate-schemas/<name>.json`
  2. user-level `~/.pi/agent/pi-delegate-schemas/<name>.json`
  First match wins (project overrides user — mirrors pi agent-scope convention).
- File shape: a JSON-Schema object with optional reserved key `"$extends"`:
  `"$extends": "<parentName>"` — parent resolved recursively (cycle → error at
  resolve time). Merge: parent properties ∪ child properties; required = union;
  everything else taken from the child when present, else parent.
- Brief frontmatter may reference by name (`reportSchema: impl-report`) or inline
  a fragment (v1.2 behavior, unchanged). Inline wins if both appear.
- Resolution failures (unknown name, broken parent chain, invalid JSON) → the
  brief is rejected BEFORE spawn (E_BRIEF with the resolution error) — a bad
  schema must never waste a worker.

## 17. Versioning = recorded provenance

- Resolved schema provenance (name(s) + chain + the merged fragment) is written
  into the manifest per worker at spawn.
- Collect failures quote the manifest-recorded fragment — the audit trail answers
  "what schema was this report held to" without any migration machinery.

## 18. Progress pings (worker → orchestrator liveness)

- Worker may append to `/tmp/exchange/{TASK}/p-<name>.jsonl` — one JSON event per
  line: `{ worker, ts, phase, pct?, note? }` (append-only; never rewritten).
- `delegate_status` shows the last ping per worker (`phase/pct` + age).
- During the settle grace loop, `delegate` streams the latest ping via onUpdate —
  long workers become observable without opening panes.
- Pings are advisory: a worker that never pings behaves exactly like v1.4.

---

# v1.6 — honest settle, durable reports, ambient fleet UI (approved 2026-09-05)

## 19. Fix D3/D4 + the human UI layer (supervip_epic findings)

### 19.1 D3 — settle-before-start race (blocker)
`waitSettle` must not accept idle/done until the agent has been observed in a
non-idle state (working/blocked) at least once SINCE SUBMISSION. Phases:
  1. start-up phase: accept only working/blocked; idle/unknown → keep polling.
     A `done` observation also proves life (a fast worker can start AND finish
     within one poll slice — "done proves life", R6 fix, commit 8948566):
     done with no prior working/blocked observation is treated as settled,
     never as neverStarted. If the whole budget expires without ever
     observing working → return
     {status:"unknown", timedOut:true, neverStarted:true}; delegate maps that to
     E_PROMPT_STALLED ("prompt never consumed — worker never started; inspect via
     delegate_status / herdr agent read").
  2. settled phase (after first working/blocked observation): current behavior.
The probe flow inherits this: a probe that never started is probe FAIL, not OK.

### 19.1b v1.8 — aged-finish blind spot (live-reproduced 2026-09-05)
herdr AGES `done → idle` within minutes (observed on probe / probe-retry /
fresh-probe-x), so a watcher that attaches after the worker finished — fast
flash probes, abort/detach recovery, slow start — can NEVER observe
working/done. Pre-v1.8 it spun the FULL timeout against a visibly finished
worker (120 s probe / 900 s normal) and then false-reported `neverStarted`
while the pane showed a passed smoke gate. Field shape: "probe is done but
orchestrator stuck" — operators kill the healthy wait.
Fix: in the start-up phase, an unexplained idle is checked against the worker's
session JSONL (path from `herdr agent get` → agent.agent_session.value): an
assistant message proves the prompt was consumed → settle as
`{status:"idle", timedOut:false, finishedBeforeWatch:true}` (success, not
failure). No reply / missing / corrupt session → no proof → keep polling →
neverStarted stays honest. The D3.1–D3.6 protections are unchanged.
Companion fixes: (a) probe salvage on abort — probes write no report file, so
the abort path now recovers the smoke-gate verdict from the session JSONL
(`parseSessionUsage(...).turns > 0`) and returns `probe OK (detached after
settle)` instead of a bare Detached; (b) `waitSettle` accepts `onPoll` and
delegate emits a ~10 s heartbeat (status + elapsed + "Esc detaches safely") so
a blocking wait never looks frozen.

### 19.1c v1.9 — herdr builds that never report working (field 2026-09-05,
m03-search-investigation)
The §19.1b salvage assumed herdr exposes the worker's session path. Field run
on the promobile workspace falsified BOTH halves of the detection chain for
`--kind pi` workers:
  1. herdr NEVER reported working/blocked/done — not during the work, not at
     completion (agents sat at `idle` from spawn to finish; the orchestrator
     itself showed "⠴ Working" while `agent list` said `idle`). The §19.1
     start-up gate therefore never opened.
  2. `agent get` / `agent start` carry NO `agent_session` on this build —
     `resolveSessionPath` always returned undefined, so the session-reply
     salvage was dead code (and the gauges/budget governor silently off).
Net effect: three finished fan-out workers (reports on disk at minutes 9–11)
kept their watchers spinning the FULL budget (1500 s) at `status=idle (prompt
not yet observed consumed)`, then false-reported neverStarted E_TIMEOUT —
workers done, delegate "waiting for workers". search-be had already burned
25 min the same way.
Fix (two independent layers, either alone is sufficient):
  - `waitSettle` accepts `proofSettled?: () => Promise<boolean>` — a
    caller-owned completion proof, polled in the start-up phase on EVERY slice
    whose observation cannot prove life (idle/unknown/unresolved, not just
    idle). True → settle `{status:"idle", finishedBeforeWatch:true}`. Throws
    are treated as false; the observation gate keeps precedence (a normally
    observed working→…→settled run never consults the proof).
  - delegate supplies the proof: report file mtime ≥ spawn time (the tool
    contract: "the worker's report file is the completion criterion") with
    collectReport's canonical→requested path fallback; session reply
    (`parseSessionUsage(...).turns > 0`) as the backup for probes. mtime ≥
    spawn keeps stale same-name reports from false-settling a fresh worker.
  - `resolvePiSessionCandidates` (usage.ts) restores the session path from
    pi's own storage (`~/.pi/agent/sessions/--<munged-cwd>--/<created>_<uuid>.jsonl`,
    creation within [spawn−5 s, spawn+10 min], closest-first) when herdr
    exposes none; the resolved path is backfilled into the manifest so
    gauges, budget accounting and probe salvage work again. Parallel same-cwd
    fan-outs can share a window — attribution is best-effort; the report
    proof is the exact criterion.
neverStarted stays honest: proof requires evidence written after spawn, so a
worker that never consumed the prompt still times out to E_PROMPT_STALLED.
UX companion (v1.9b): the ~10 s wait heartbeat now carries the live dual gauge
(ctx% ↑in ↓out) and budget progress (`budget 45% ↓67.5k/150k`) parsed from the
worker's session JSONL each beat — the wait is an observable burn-down. The
budget is shown against the call's budgetTokens, else the §14 default
(150k, `budgetSource: "call" | "default"` in details); DISPLAY only —
enforcement (overOutputBudget) still requires an explicit budget. The
misleading "(prompt not yet observed consumed)" prose was dropped: on builds
that never report working (above) it rendered on every beat and read as an
error. All heartbeat lines flow through renderResult's clampLines (§19.5).

### 19.5 v1.8b — transcript/widget line-width clamping (field crash)
pi-tui passes the available width to `component.render(width)` and CRASHES the
whole process (uncaughtException "Rendered line N exceeds terminal width") when
any returned line exceeds it. Field crash 2026-09-05: the new v1.8 heartbeat
headline rendered 150 cols into a 139-col terminal and killed pi
(pi-tui-crash.log line 13185). Rule: EVERY custom render closure in this
extension — renderCall/renderResult of delegate/mailbox/status, both fleet
widgets — accepts the width param and routes its lines through
`clampLines(lines, width)` (ui/text.ts: visibleWidth-aware, wide-char safe,
ANSI-tolerant, ellipsis via trunc). No-width calls (headless, session replay)
are identity. Regression checks: render-ui-check.ts W1–W6 (W1 replays the
exact crashing headline at width 139).

### 19.2 D4 — second name-taken CLI shape
herdr `agent start` failure text variant "name taken by a live agent (candidates:
…)" maps to E_NAME + candidate guidance, same as the `agent_name_taken` code path
(match on message substring, case-insensitive; keep both shapes mapped).

### 19.3 Report archive (durability)
On every successful collect (pass OR fail verdict), copy the report to
`~/.pi/agent/delegate-archive/<task>/report-<name>.json` (+ manifest.json snapshot
per task, updated on each collect). Archive writes are best-effort: failure →
warning in result text, never an error. Post-reboot, `/delegate_status` notes
archived tasks ("last task: <task> — N archived reports — ~/.pi/agent/delegate-archive").

### 19.4 Ambient fleet UI (pi TUI primitives; all guarded by ctx.hasUI, all read-only)
- **Fleet widget** (`ctx.ui.setWidget`, above editor): appears when ≥1 live worker
  (status working/blocked), one line each:
  `▲ <name> <status> ↑in ↓out <P>% of budget [ping: phase]`; auto-clears when no
  live workers remain; refresh 2 s interval; timer cleared on empty. DEVIATION
  (deliberate, 2026-09-05 — see fleet-ui.ts header): the widget is cleared when
  no live workers remain, but the 2 s interval KEEPS RUNNING while idle (only
  dispose clears it) so the widget can re-mount on the next spawn without
  re-registering a timer.
- **Placed-count chip — REMOVED (v1.8, user decision)**: the global cross-session
  count + pessimistic burn were confusing. `ctx.ui.setFooter` itself is also banned
  (it REPLACES pi's native footer — context %, model, cost, cwd). Only the live-rows
  widget remains ambient; `/delegate-fleet` is the single deep view.
- **renderCall/renderResult** for delegate + delegate_status + delegate_mailbox:
  themed structured rendering — status-colored badges (E_* as warning/error),
  one-line verdict, herdr internals ONLY in collapsed details. Headline never
  contains terminal_id/pane_id-style internals.
- **Probe honesty**: probe rows/status render `report —` (no report expected),
  never `report✗`.
- **Tier-mismatch guard**: when the brief text declares a tier ("frontier tier"/
  "flash tier") and the spawn params differ, append a warning line to the result:
  "brief declares <X> tier but worker runs <model> — tier mismatch".
- **Nudges**: on last live worker settle → ctx.ui.notify("fleet idle —
  /delegate-teardown to clean up N tabs", "info"). On budget exceed → notify.
- **Fleet journal**: on each spawn/collect, pi.appendEntry("delegate-fleet", …) —
  survives reboots; /delegate_status shows last-journal summary when live fleet
  is empty (resume hint, §19.3 archive path included).

---

# v1.7 — dual-gauge: context % (pi's own formula) + output budget (approved 2026-09-05)

## 20. Gauge redefinition — state, not accumulation

**Primary gauge — context % (mirrors pi's `ctx.getContextUsage()` exactly):**
- Value: the LAST assistant message's `usage.totalTokens` in the worker's session
  JSONL ÷ the model's contextWindow. Never a sum across turns.
- pi semantics honored: right after compaction the value may be stale/null →
  display `ctx ?%`, keep last known as informational only.
- Thresholds: warn 80% (operator's restart line), critical 90% (notify + error color).
  pi's own compaction line = window − 16384 reserve (≈96.9% for glm-5.3-flash,
  250,100 windows: ≈93.5%) — refusal always fires before it.
- **Refusal `E_CONTEXT`** (new code): re-spawning a worker whose recorded session
  ended ≥ maxContextPct (default 80) → "worker session near compaction (ctx P%) —
  start a NEW worker name; its next prompt would compact".
- Context window resolution: per-model map (glm-5.3-flash: 524_300; default 250_100)
  + config override `pi-delegate.config.json {"contextWindow": N}`.

**Secondary gauge — output budget (semantics corrected):**
- `budgetTokens` param redefined: max **output** tokens (Σ output across assistant
  messages) — the honest effort measure. input/cacheRead/cacheWrite NEVER in any
  tripwire (display-only).
- Exceeded → warning + `E_BUDGET` refusal on re-spawn (existing mechanism, new math).
  Not set → no output cap; context gauge alone governs.

**Tertiary tripwire — turns:** >40 assistant messages in a session → warning
(catches research-loop thrash at low output; F1 shape). Informational.

**UI relabel:** gauge renders `ctx P%` (widget, footer, overlay, status lines);
tokens `↑in ↓out` stay display-only. Refusal guidance names which gauge tripped.

**Manifest additions:** `lastTotalTokens`, `contextWindow`, `turns` recorded at
collect (provenance for the refusal decision).
