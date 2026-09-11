# DESIGN — `pi-delegate` extension v1

Status: **APPROVED 2026-09-05** · Owner: root tech lead (pi orchestrator) · Date: 2026-09-05

> **Document status** (2026-09-11): the module map (§4.1) and the architecture sections
> are verified against the actual file tree and `pi/extensions/pi-delegate/package.json`
> v1.16.1. Sections §5–§24 are the historical design log — file paths inside them predate
> layout v2; §4.1 is the current map.

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
| Worker model | named tiers in ~/.pi/agent/pi-delegate.config.json: `{"tiers": {"<name>": {"provider", "model", "thinking"}}, "defaults": {"tier": "<name>"}}`; explicit `tier`/`provider`/`model`/`thinking` params win per key; **no built-in tier since v1.9.2** — unconfigured → E_TIER (the llm-platform-alpha/glm-5.3-flash hardcode was removed) |
| Call semantics | `delegate` **blocks** until worker settles; Esc detaches (worker keeps running, recoverable via `delegate_status`); fan-out = parallel tool calls |
| Report contract | **Strict**: fixed JSON schema enforced by the tool on collect (format chosen by tech lead: JSON over XML — native model emission, trivial validation) |
| Placement modes | `worktree` + `tab` only; pane splits cut (leaky geometry, no isolation; sub-orchestrator tab support is the valuable half) |
| Smoke probe | Explicit `mode: "probe"` param — no magic |

## 4. Architecture

### 4.1 Module layout

Verified against the file tree on 2026-09-11 (v1.16.1). Canonical term for the backend
seam is **WorkerHost**; the TypeScript interface keeps its historical frozen type name
`Transport` — same thing, an alias, not a second concept.

```
pi-delegate/
├── DESIGN.md                 # this document
├── index.ts                  # composition root: reads the config "host" key (default
│                             #   herdr), binds ONE WorkerHost adapter and injects it;
│                             #   the ONLY module allowed to import a backend adapter
├── src/
│   ├── spawn.ts              # what the orchestrator DOES: delegate + mailbox tools,
│   │                         #   the spawn pipeline (place → manifest → start → brief
│   │                         #   → settle → collect), budget governor, LLM-facing
│   │                         #   prompt contract. Must never observe (no watcher) and
│   │                         #   never read other sessions' fleets
│   ├── observe.ts            # what the orchestrator KNOWS: delegate_status (read-only),
│   │                         #   the event-driven watcher, the §23 retire engine,
│   │                         #   the durable delivered-facts policy (stage B: key
│   │                         #   shape, tick order, commit-after-send, GC),
│   │                         #   watch/collect config resolution, /delegate-fleet +
│   │                         #   /delegate-teardown commands. Must never spawn or
│   │                         #   mutate a worker outside the retire/teardown contracts
│   ├── fleet.ts              # all pixels: ownership classification, text primitives,
│   │                         #   ambient widget, tool-result rendering, the fleet
│   │                         #   overlay, worker-view aggregation. Read-only by
│   │                         #   contract; owns line-width clamping
│   ├── exchange.ts           # everything durable on disk: exchange-dir conventions,
│   │                         #   manifests, reports, schemas, mailbox files, archive,
│   │                         #   the watcher satellites (retire stamps + the durable
│   │                         #   delivered-facts store, stage B). Owns
│   │                         #   append-before-start (file side), atomic
│   │                         #   serialized manifest writes, answer-consumed mtime
│   ├── host.ts               # the WorkerHost seam: the Transport interface (frozen
│   │                         #   type name), req/result types, the E_* taxonomy +
│   │                         #   guidance, report/mailbox contracts, briefPrompt,
│   │                         #   budget constants. Imports node builtins ONLY —
│   │                         #   bottom of the graph, never imports another src/ module
│   ├── host/fake.ts          # in-memory WorkerHost adapter (tests): statusScript-driven
│   │                         #   settle, `fake:<n>` refs. Imports only the seam + exchange
│   ├── herdr/host.ts         # the herdr adapter: CLI plumbing (runHerdr + SIGKILL
│   │                         #   escalation), NDJSON socket client, the mutation queue,
│   │                         #   result mappers, adapter-private id codec. Imported
│   │                         #   ONLY by index.ts
│   ├── usage.ts              # the gauge layer: the ONLY session-JSONL parser (one-parser
│   │                         #   law); budget/context math (§20), tolerant config
│   │                         #   resolvers. Stateless and read-only
│   ├── lifecycle.ts          # the worker lifecycle: state as a discriminated union,
│   │                         #   the TOTAL transition reducer, embodiment identity
│   │                         #   (name + run ordinal + placementRef), validate-then-patch
│   │                         #   manifest stamps. Every stamp write is a reducer
│   │                         #   transition — illegal ones are structured refusals
│   └── expaths.ts            # portable (Windows + POSIX) path builders for the exchange
│                             #   layer; node:path only, never imports another src/ module
└── test/                     # QA harness (regression checks per field incident; see
                              #   docs/THREATS.md for the threat catalog)
```

Each module is the single owner of the invariants named in its MODULE_CONTRACT header and
must not reach into a neighbor's: `spawn.ts` never observes, `observe.ts` never spawns,
only `index.ts` imports an adapter, only `usage.ts` parses session JSONL, only
`exchange.ts`/`expaths.ts` build exchange paths.

Dependency rule (enforced by test/static-check.ts): no src/ module imports a backend
adapter (`src/herdr/host.ts`, `src/host/fake.ts`) — the adapter is bound and injected once
in `index.ts`.

### 4.2 WorkerHost interface (the seam — historical type name `Transport`)

The seam lives in `src/host.ts` (§4.1); "Transport" is the frozen type name, the canonical
term is WorkerHost:

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
The boundary path is resolved at RUNTIME (`os.homedir()`, user-reported fix: a hardcoded
`/root/.herdr/worktrees` broke every non-root user) — a static check pins that no
`/root/` literal remains in `src/`.

Terminology: "worktree" names the isolation mechanism (the placement kind), "checkout"
names the run path (`checkoutPath`) — complementary, never synonyms. A herdr
worktree-backed workspace is a **wt-workspace**; the repo's main checkout is the
**master checkout**; herdr's UI groups workspaces by `repo_key` (**repo group**).
Full glossary: [AGENTS.md](./AGENTS.md).

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
| `tier` | string | `defaults.tier` in config | names an entry in the `tiers` table; unknown → E_TIER |
| `provider` | string | tier/defaults-resolved | no built-in |
| `model` | string | tier/defaults-resolved | no built-in |
| `thinking` | string | tier/defaults-resolved | no built-in |
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
`teardown.log` in the exchange dir. Never runs automatically on its own — EXCEPT the
collect-time auto-teardown of §22 (v1.12.1, user-decided default ON): a worker whose report
was strictly collected is torn down right after the collect result is built, with the same
audit format and the same advisory contract.

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
| `E_TIER` | unknown requested tier, or no provider/model/thinking resolvable — there is NO built-in worker tier (v1.9.2) | add `tiers`/`defaults` to ~/.pi/agent/pi-delegate.config.json or pass provider/model/thinking |
| `E_PLACE` | worktree/tab/pane creation failed | herdr stderr attached; reconcile via `herdr workspace list` (skill §6.3) |
| `E_START` | agent start failed | check pane readiness; retry is a new `delegate` call |
| `E_PROMPT_STALLED` | no state change within 5 s of submit | worker pane not at prompt; inspect via status |
| `E_TIMEOUT` | settle wait exceeded | worker still running; poll `delegate_status` |
| `E_TEARDOWN` | teardown operation failed (worktree remove / tab close / workspace reconcile); the authority rejection stays `E_PLACE` | backend stderr attached — reconcile manually via `/delegate-teardown` or the host listing, then retry the close |
| `E_STATUS` | status read from the backend failed (worker may have exited / backend unreachable) | reconcile via the host's status listing before trusting a lifecycle decision |
| `E_REPORT_MISSING` | settled but no report file | treat as failed spawn; diagnosed retry is the orchestrator's move |
| `E_REPORT_INVALID` | report exists but fails JSON schema | attach validator output; treated identically to missing |

Note (migration stage 1, 2026-09-11): the deferred backlog item below is
CLOSED — `E_TEARDOWN` and `E_STATUS` are first-class taxonomy entries, and
intercepts read the code off the typed error (DelegateErrorImpl.code) instead
of re-flattening it positionally:

> Note (taxonomy backlog, deferred 2026-09-05): dedicated codes for teardown failures
> (`E_TEARDOWN`) and for the read-status failure shapes currently surfaced as status
> `unknown` are a documented backlog item — today they degrade into existing codes /
> unknown-status rather than first-class taxonomy entries.

## 8. Testing strategy (Phase QA)

- **Static/design conformance**: dependency-rule check (tools never import herdr.ts),
  read-only check on `delegate_status`, name validation, authority-mode unit tests
  (fake cwd under worktrees dir).
- **Watcher checks** (`test/watcher-check.ts`, §21): dependency rule + lifecycle wiring,
  config resolution (child process with `$HOME`), every event detection from temp-dir
  fixtures, dedup/reset (including the keys of vanished workers), one-send-per-batch
  delivery, failed-delivery rollback + re-fire, inert headless sender, self-mute.
  The dependency rule for `src/observe.ts` (which owns the watcher engine since layout v2) is pinned twice on purpose: here (W1.1) and
  in the canonical `static-check.ts` T1.1 list.
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
- **Ownership glyph column (v1.12.0, fleet-UX stage 1)**: the row's lead space
  became glyph+space — `●` mine (accent), `○` foreign (muted), `◌`
  legacy/unknown (dim) — classified by pure `classifyOwnership()`
  (src/ownership.ts) against THIS session's live `getSessionFile()` (degraded
  self-id falls back to the worktree `checkoutPath === cwd` match; tab workers
  are NEVER matched by cwd). Display is FAIL-CLOSED: unknown never renders as
  mine (deliberate asymmetry vs the watcher's fail-open, §21.1 F1). Legend
  gains `● mine ○ foreign ◌ legacy`. Fitter `layoutFleetRows` fixed cost is
  now exact: 18 (glyph+space lead 2, plus the formerly-latent missing double
  space before usage — fixed from the wrong 15 to the real 17, then +1 for
  the glyph column); floors and shrink priority unchanged. Glyphs are 1 col
  each (U+25CF/25CB/25CC are outside text.ts wide ranges).
- **Task tree + Tab fold (v1.12.0 stage 2, fleet-UX wave 2)**: overlay rows
  group by `manifest.dir :: orchestratorSessionPath` (pure
  `groupWorkerViews`); legacy manifests (field absent) land in the dir's
  UNKNOWN bucket, tagged `owner?` — never labeled "foreign" (a display
  convention only: an unproven owner is never LABELED foreign; the bucket
  asserts nothing — delivery meanwhile is fail-closed, §21.1 F1 stage-A
  update). MINE rows render FLAT exactly as stage 1 — no header, no tree
  glyphs, no fold — so the single-session case is byte-identical (zero
  regression). FOREIGN/`owner?` groups render an expanded full-width dim
  header `▼ slug · live/total live · owner · ctx↑max%` (ctx is the MAX
  across members — the restart cliff E_CONTEXT cares about — segment
  dropped when unknown; fitRow degrades it left-to-right at the 40-col box
  minimum) with inline tree glyphs `├ `/`└ ` in the name column (V1: the
  fitter is untouched, glyph truncates as one unit with the name). Groups
  FOLD BY DEFAULT to one SELF-DESCRIBING line (fleet-UX wave 4, v1.13.0 —
  report-lex: the letter alphabet `xN -- L B ! Q v s` is retired)
  `~ <class> <slug> · N workers · counts… · idle <age>`: the class token is
  SPACE-separated from the slug (the dot-join read as a hostname), counts
  are words a stranger can parse, non-zero only, in the old flag order —
  live / blocked / hot-ctx (≥80) / question / rep — and identity (class +
  slug + worker count) LEADS so fitRow's left-to-right degrade keeps it
  under width pressure; more than 6 foldable groups → one mega-line
  `~ foreign · N workers in M tasks · …`, mixed collapses say
  `foreign+owner?`). Tab (0x09) toggles (single byte,
  never an ESC-sequence prefix; no-op when nothing is foldable), state is
  a module-level session-scoped boolean (`fleetFoldToggle`/
  `fleetFoldUnfolded`) — folded on first open, survives close/reopen,
  never persisted — and the header hint swaps `Tab unfold`/`Tab fold`.
  Per-group sort replaces the global status sort (`rankGroups`): groups
  ranked by their most actionable member (STATUS_ORDER), ties
  mine < owner? < foreign, then fully-stale groups below otherwise-equal
  fresh ones (v1.13.0), then slug; within-group order unchanged; the
  height window is GROUP-ATOMIC — a header never shows without its
  children (a block that does not fit hides whole, its workers counted
  into `… and N more`) — and STALE-AWARE (v1.13.0, report-pulse fix 2):
  fresh blocks fill the window first; fully-stale blocks are admitted only
  after every fresh block is shown, so a live (working/blocked) row is
  never hidden while a stale-group row is visible. No admission changes:
  every manifest worker still renders. Rendering lives in pure `renderFleet` (headless
  goldens at innerW 58/78/98 + fold/window/width contract checks in
  `test/fleet-tree-check.ts`); per-row ownership glyphs stay on every row
  (width-pressure fallback to spaces NOT taken). Legends (v1.13.0): while
  folded the legend is a WORKED EXAMPLE of the folded grammar plus a
  minimal key (`e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep ·
  idle 31m — live=working/blocked · rep=report landed · idle=collected
  ≥30m`), not a token list; the expanded legend keys every token its
  surface renders — `owner?` untraceable, the `—` probe dash, `├└ group`,
  `↑↓ in/out` (report-lex fix 3). Each legend greedily packs into at most
  TWO physical dim lines (one when it fits). When any foreign/`owner?`
  group is on screen, one dim framing line states the viewer's role:
  `○ ◌ = another session's fleet — informational; only its owner can act`
  (report-act fix 1 — affirms the §22 foreign-immutable canon). Widget
  untouched; no transport/seam changes.
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

## 19. Fix D3/D4 + the human UI layer (field findings)

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
- **Attention-gated ownership fold (v1.12.0, fleet-UX stage 1, user-decided
  policy)**: MY live rows render exactly as above (byte-identical). Foreign and
  legacy LIVE workers are FOLDED into at most one summary line PER CLASS
  (≤2 total): `○ N foreign live (task1, task2)` (muted) / `◌ N legacy live
  (…)` (dim). A class line appears IFF at least one of its live workers is
  `blocked` OR at `ctx% ≥ CONTEXT_WARN_PCT (80)` — no signals → no line (a
  quiet foreign fleet renders NOTHING above the editor; the live fixture: 2
  foreign working at ~60% → widget shows nothing foreign). No new fs reads
  (no mailbox joins); fold lines are short by construction AND routed through
  clampLines (v1.8b guard). `getRows` wires the self session path via the live
  `sessionManager.getSessionFile()` getter (same as watch.ts); absent self-id
  degrades to UNKNOWN, never "mine". Watcher stage A note (ownership fold):
  the fold classifies through the SAME canonical verdict as delivery and the
  mount gate (src/watch-role.ts, classifyOwnership → workerAudienceMatch) —
  the display-only degraded-self worktree fallback (checkoutPath === cwd →
  "mine") NEVER feeds delivery: a degraded self-id delivers nothing
  unconditionally (§21.1 F1, stage-A update).
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

## 20.1 Blocking window capped (v1.8b, field: "still present")

The delegate call's default blocking window is capped at 120 s (waitMs
overrides explicitly; probe keeps its 120 s). A large legacy timeoutMs no
longer holds the orchestrator session hostage: at the cap the call
auto-detaches through the existing E_TIMEOUT path ("worker still running —
poll delegate_status"), and monitoring continues via the fleet widget.
Rationale (field report, delegate tab): a 1800 s block parked the
orchestrator for half an hour while the widget already showed the truth —
the same "waiting while the truth is visible" failure as the probe report
wait. Long blocking is explicit opt-in (waitMs), never a side effect of a
stale large timeoutMs.

> **v1.11 annotation.** The DEFAULT blocking window is no longer 120 s — it is
> `watch.settleGateMs` (default 15 s, §21). The 120 s figure survives only as the
> cap on a legacy `timeoutMs` and as the probe's smoke window; everything else in
> this section (auto-detach through `E_TIMEOUT`, explicit `waitMs` opt-in) still
> holds.
>
> **v1.14 annotation — early release (`watch.releaseOn: "started"`).** The
> settle gate's only job after the spawn is catching an inline fast settle;
> once the worker is OBSERVED working, spawn failures (E_PLACE/E_START/E_NAME)
> are ruled out and blocking the rest of the gate buys nothing. With
> `"watch": { "releaseOn": "started" }` (or per-call `releaseOn: "started"`)
> the delegate call returns a success-shaped "orchestrator released" result on
> the first working observation — the §21 end-your-turn discipline applies
> immediately, not at timeout. Fast finishes are still caught inline: a worker
> that settles before the first working observation (within one wait slice)
> returns its report synchronously as before. Probes are exempt — their full
> window IS the verdict.

### 19.6 v1.10 — report contract canon moves into the code (field 2026-09-06)
Field: workers kept writing schema-invalid reports (string `evidence`, missing
`artifacts`) — not worker error: briefs TAUGHT the wrong shape. Hand-pasted
report JSON in brief OUTPUT sections had drifted from `baseValidate` and the
drift propagated by template copy (stale briefs in /tmp/exchange used as
models). Fix: the canon lives in code, briefs carry none. `REPORT_EXAMPLE`
(types.ts) is the canonical example (WorkerReport, worker placeholder);
`briefPrompt` appends a report-contract block — required fields with the
canonical name substituted, verbatim "Extra fields allowed" (canon = minimum,
not a whitelist), and the example JSON. Since v1.5 a brief-declared
`reportSchema` fragment (§16–§17) is echoed verbatim after the base block when
present, so the worker sees the exact schema its report is validated against at
settle. Sentinel `test/report-contract-check.ts` validates REPORT_EXAMPLE
through the real `validateReport` and pins the regression class (string evidence
rejected): any future drift between prompt canon and validator fails the suite. `skills/delegate/SKILL.md` Brief step now
reads "OUTPUT: acceptance criteria only" — report path/shape come from the
tool's fixed prompt, never pasted into a brief. Delegate run: worker
`contract` (worktree, flash tier) built it; orchestrator verified diff + full
test suite before the ff-merge.

## 21. Event-driven background watcher (v1.11, field: improvised `sleep 1500`)

**Field report.** After `E_TIMEOUT` the orchestrator had no sanctioned way to
wait. §20.1 removed the long blocking window but left only "poll
`delegate_status`" behind — and polling is not something a model can do while
idle. So it improvised: `sleep 1500` in a bash tool call. The session sat
parked for 25 minutes inside a shell command — invisible to the fleet widget,
no gauges, no abort short of Esc, and the worker had finished long before.
The fix is not a better sleep; it is removing the need to wait: the extension
wakes the orchestrator when a worker actually needs attention.

**Module.** `src/observe.ts` — the watcher engine (a background poller independent of the fleet UI
(no `ctx.hasUI` guard: the wake-up matters headless too). Mounted on
`session_start`, stopped on `session_shutdown` (module-level registry, exactly
the `mountFleetUI`/`disposeFleetUI` shape; double-start replaces). It takes the
`Transport` injected by `index.ts` and imports `transport/types.ts` +
`exchange.ts` + `usage.ts` only — the dependency rule holds (pinned by
`test/watcher-check.ts` W1).

**Each tick** aggregates `transport.listStatuses()` (tolerant — unreachable →
statuses *unknown*, which is NOT "everyone died"), `scanAllManifests()` and the
workers' session JSONL (usage gauges + a tail-window tool-call scan).

| Event | Trigger | Wake-up text (the concrete next action) |
|---|---|---|
| `report-ready` | readable report at manifest `reportPath`, passes `validateReport` | report path + verdict + "read it and verify against the brief" |
| `report-invalid` | report file exists but fails validation (the distinct message of the same detection) | quoted validation error + "read the pane, diagnose, diagnosed retry" |
| `mailbox-question` | `q-<name>.json` holds a valid envelope | question text + options + "answer via `delegate_mailbox` (action 'answer')" |
| `grill-deck` | worker's session JSONL contains a `grill_deck` toolCall | "blocked on an interactive deck in its OWN pane — only a human there can answer (or steer it to the mailbox)" |
| `context-critical` | `contextPct ≥ CONTEXT_CRITICAL_PCT` (90) vs `resolveContextWindow(model)` | pct + "steer it to wrap up now / plan a fresh-name retry" |
| `worker-dead` | herdr knows the agent is gone (no live status) AND no report on disk | "exited without producing anything — read the pane, then diagnosed retry" |
| `worker-stale` (v1.12.1, §22) | manifest `collectedAt` older than `watch.staleAfterMs` AND the worker still live in herdr | "collected N min ago and still mounted — tear it down (/delegate-teardown) or keep" |

**Dedup (watcher stage B — memory is a cache, disk is the truth).** Every kind
carries a fingerprint, and the delivery key exists in two canonical views of
ONE scheme — a JSON-array string, never a delimiter-split string (task-dir
paths and session paths are unvalidated and may contain any separator; the old
right-to-left `#`-split survived only while the dir was the single
unvalidated component):

- **in-memory key** (`eventKey`): `JSON.stringify([dir, worker, kind, fingerprint])` —
  the watcher's cache map holds the PARSED key structure, and the state-reset
  loop reads the structure instead of re-splitting a string;
- **durable record key** (`deliveryRecordKey`, exchange.ts):
  `JSON.stringify([worker, kind, fingerprint])` — the task dir and the
  audience are given by the STORE FILE's location, not by key components.

An event fires **at most once** per key. A key survives a tick with no
observation of its condition (a transient ENOENT on the report must not
resurrect the event); it is forgotten only when the worker VANISHED from the
manifests (a real removal — manifest writes are atomic) or the same
worker+kind is observed with a DIFFERENT fingerprint (a new episode / a new
fact). The durable committed records are removed ONLY by garbage collection
when a worker really disappears — never on a skipped observation, a herdr
status flap or a transient read error. One `sendUserMessage` per **batch**
(per tick), never per event. The full fingerprint rules per kind — including
the episode rules for the gauge/absence kinds — live in the delivered-store
subsection below. See §21.1b for the durable store itself.

**Suppressions** (each pinned by a test): `worker-dead` never fires while herdr
is unreachable (statuses unknown ≠ dead), inside the 60 s placement grace
window, for probe runs (probes write no report, §19.4), or when a report
exists. Manifests older than the 24 h lookback are dropped — a fresh session
must not be woken for last week's fleet.

**Self-mute.** Every pi session runs this extension, workers included, so the
watcher identifies *itself* in the manifests (session JSONL path, or the unique
worktree checkout path) and (a) never delivers events about its own worker and
(b) stays silent altogether when it is a leaf **worktree** worker — that fleet
belongs to whoever spawned it. Sub-orchestrators (tab placements, per the skill)
keep their watcher; tab workers are never muted on cwd alone, because a tab
shares the orchestrator's checkout and cwd cannot tell them apart.

**Delivery.** `pi.sendUserMessage(text, { deliverAs: "followUp" })` — it wakes
an idle orchestrator and never interrupts a turn in flight. The tick AWAITED
the sink and, since watcher stage B, the sink reports a structured outcome
(`SendOutcome`): a real send (`mode "sent"`) or **silent mode** (no usable
`pi.sendUserMessage` — old/headless builds). Silent mode is NOT a delivery:
nothing is committed to the durable store, and the memory keys are not rolled
back either (a rollback would re-fire the batch every tick forever — endless
noise from a session that can never deliver; the "headless watcher is silent
but unbroken" contract). A throw (or a rejected promise) rolls the batch's
dedup keys back out of `seen` — a transient send error must never permanently
swallow a wake-up, which is the failure this module exists to prevent
(W9.13–W9.13c) — and writes NOTHING to the store. Full delivery CONFIRMATION
would require changes on the pi side (out of scope for stage B): the runtime
swallows asynchronous send failures, so "no synchronous exception" is the only
honest signal — therefore every real send is also recorded as a line in the
watcher audit log with the batch content (the recovery trail after an
incident). Nothing is buffered: an event whose condition has already reset is
simply gone. **Advisory by contract**: no watcher failure — bad manifest, dead
herdr, throwing sink — can affect a spawn or a collect; the report file
remains the only completion criterion.

**Config** (`~/.pi/agent/pi-delegate.config.json`, tolerant, never throws):

```json
{ "watch": { "intervalMs": 10000, "settleGateMs": 15000, "staleAfterMs": 1800000, "releaseOn": "started" } }
```

`intervalMs` (default 10 000, floor 1 000) is the poll period; `settleGateMs`
(default 15 000) is `delegate`'s new DEFAULT blocking window — a spawn now
proves "the worker started" and hands over. Explicit `waitMs` still wins
(uncapped opt-in), the legacy `timeoutMs` cap of 120 s stays, probe keeps its
120 s smoke window. `staleAfterMs` (v1.12.1, default 1 800 000 = 30 min, floor
60 000) is the `worker-stale` threshold (§22); the overlay's stale age tail
(§22.3) shares the 30-min default.

**Result texts.** `E_TIMEOUT` and the detached result now carry the discipline
in one line: *end your turn — the watcher wakes you*. `delegate_status` polling
remains valid (it is the tool for "look now"), bash sleep is stated as a
fallback **only** when the watcher is absent (old extension build). Same wording
in `promptGuidelines` of both tools and in `skills/delegate/SKILL.md`.

### 21.1 Backlog — deferred after the §21 review + QA run (2026-09-06)

Found by `report-code-review.json` / `qa-findings.md`, deliberately NOT fixed in
the polish commit (each is bigger than a polish, and the watcher is advisory —
none of them can corrupt a spawn or a collect result). One fix shape each:

- **F1 — wake-ups are not scoped to the owning session.** Every pi session scans
  every manifest under `/tmp/exchange`, so a bystander orchestrator is woken for
  foreign fleets (measured: 7 events about 3 unrelated tasks on a new session's
  first tick, worded imperatively). Fix shape: record the owner session id in the
  manifest at spawn and filter wake-ups to it — failing that, split the batch into
  "your fleet" vs "other exchange tasks (informational)" and shrink the lookback
  to "since this session started".
  **DONE in v1.11.1** (field: a worker pane received its orchestrator's wake-up
  and got confused; every session mounted its own watcher over the global
  manifests). Two layers: `isWorkerSession` gate — a manifest worker session
  mounts NO watcher (`index.ts` session_start); spawn records
  `orchestratorSessionPath` (live `getSessionFile()` getter) and
  `detectWorkerEvents` silences workers owned by another session.
  **Watcher stage A — delivery is FAIL-CLOSED** (normative source:
  WATCHER-ARCHITECTURE-GUIDELINE.md §3.5/§3.6): the old fail-open on legacy
  manifests (no owner field anywhere) and degraded self-ids is GONE. One
  canonical verdict (`workerAudienceMatch` in src/watch-role.ts — a leaf
  module with zero production imports, shared by delivery, the mount gate
  and the UI) decides per worker × session: deliver ONLY on a proven owner
  ("mine"); a legacy no-owner manifest delivers ONLY under the explicit
  config rollback `watch.legacyFailOpen: true` (default false — UNSAFE on a
  multi-session machine: bystander wakes return); a degraded self-id
  delivers NOTHING unconditionally — that edge has no configuration escape
  (§3.6), and every skip is auditable in `~/.pi/agent/delegate-watch.log`
  (reason: no owner, or no self id). The spawn side signals a degraded
  write: a manifest entry recorded WITHOUT an owner path returns an
  explicit warning to the orchestrator and an audit line (full fail-spawn
  is a separate decision, not made here). **Display side DONE in v1.12.0**
  (fleet-UX stage 1): the same field now also drives ownership GLYPHS
  (classifyOwnership — since stage A a display mapping over the canonical
  verdict; unknown never renders as mine) on the
  overlay and the attention-gated widget fold (§19.4). Companion fix in the
  same release: collect stamps `collectedAt` and the watcher stays silent
  about delivered reports (fresh sessions no longer re-wake on earlier
  sessions' 14 stale reports); `pruneArchive` gives the archive a 30-day TTL.

  **The role table (guideline §3.4, mandatory in code AND design) — one
  table implemented by `sessionRole` (src/watch-role.ts) and folded by the
  mount gate (src/compose.ts), delivery (src/observe.ts detectWorkerEvents)
  and the UI (src/fleet.ts classifyOwnership):**

  | Role | Definition | Mount local watcher? | Receives wake for worker W? |
  |------|------------|----------------------|------------------------------|
  | Pure orchestrator | Is not a worker entry in any live manifest; is the owner of its own workers | Yes | Yes, when the owner of W is this session |
  | Pure worker | Is a worker entry; owns no child workers | No | No (not a fleet audience) |
  | Worker-orchestrator (tier-1) | Is a worker entry of the parent AND the owner of its own child workers | Yes | Yes only for W whose owner is this session; never for the parent's other workers |
  | Foreign | Any other session | Does not matter | Never for W with a foreign owner |

  In natural language: a session either appears as a worker entry in some
  live manifest or it does not. A session that is nobody's worker is a pure
  orchestrator: it mounts a watcher and is woken for the workers it owns.
  A session that appears as a worker entry and owns no children is a pure
  worker: it mounts no watcher and is never woken for fleet events. A
  session that appears as a worker entry AND is recorded as the owner of
  child workers (a tier-1 worker-orchestrator) mounts a watcher scoped to
  its own children only — never for its siblings in the parent's manifest.
  Everything a session can neither prove as its own worker nor be proven
  the owner of is foreign: no wake. A session whose own identity is
  unreadable (degraded self-id) is delivery-silent regardless of role — it
  owns nothing and receives nothing; a degraded tier-1 lead therefore loses
  its child wakes (a documented known behavior, pinned in
  test/composer-check.ts, check M7).
### 21.1b The durable delivered-facts store (watcher stage B, guideline §5)

Before stage B the dedup lived only in the memory of ONE watcher mount: a
session restart forgot everything, and on the same files on disk the events
were delivered AGAIN. The store closes that class: the wake-up dedup survives
a session restart.

**Where the records live.** One satellite file per task dir per audience
session: `delivered-<watcherKey>.json` next to the manifest (watcherKey = the
existing 8-hex FNV-1a hash of the audience session's JSONL path — the same
convention as the retire-stamp satellites, `watch-<key>.json`). One file per
session-audience per task dir. There is exactly ONE writer per file BY
CONSTRUCTION — the file name carries the audience key, so two sessions never
write the same file (the in-process file-mutation queue serializes only
inside one process; inter-process safety comes from the file NAME, not from a
lock). I/O reuses the shared blocks: atomic write via temp file + rename,
tolerant read — a missing, corrupt or torn file reads as an EMPTY store
(worst case one repeated wake-up, never a throw). Policy (key shape, tick
algorithm, commits) lives in `src/observe.ts`; the file I/O lives in
`src/exchange.ts` — the same split as the retire stamps.

**File schema.** `{ schemaVersion: 1, audienceSessionPath, records }` where
`records` maps the canonical record key
`JSON.stringify([worker, kind, fingerprint])` to
`{ worker, kind, fingerprint, deliveredAt (ISO), deliveryMode }`. The task
dir and the audience are given by the FILE's location, not by key components.

**Tick order (normative, guideline §5.3).** 1) snapshot; 2) the retire pass
(before delivery); 3) detection against the memory cache; 4) the self-event
filter and the leaf-worker check happen BEFORE any durable write — a leaf
worker session writes NOTHING to disk; 5) canonical keys for the batch;
6) keys already present in the store are dropped (they STAY in memory and
are never rolled back); 7) an empty batch ends the tick silently; 8) ONE
send; 9) only on a successful send — an atomic records commit per task dir;
10) a failed send → nothing on disk, the batch's memory keys roll back.

**Commit granularity.** A batch may span several task dirs; the commit is
atomic WITHIN each dir's file, so between dirs a partial commit is possible
(one dir committed, another failed). This is documented behavior, not a bug:
a partially committed batch may repeat for the failed dirs only.

**Failure edges.**
- *Send failed* → no store write, memory keys rolled back (re-fires while
  the condition still holds).
- *Send succeeded, store commit failed* → NOT a failed delivery: memory keys
  STAY (a rollback would re-fire the batch EVERY tick while the store is
  unwritable — endless retry noise, worse than one possible repeat after a
  restart); the audit log gets the line "durable delivery record not
  written … the same fact may repeat after a session restart".
- *Store read failed / torn file* → empty store, never a throw; the memory
  cache still suppresses within the session; durable keys are NEVER erased
  by a failed read.

**No seeding on the first tick with an empty store.** Seeding would GUESS
what was delivered — an ad-hoc marker without the general key schema
(forbidden by guideline §5.2), and a skipped wake-up is exactly the failure
class this module exists to prevent. The one-time volley of repeated
wake-ups after upgrading on a RESUMED session is bounded by the stage-A
ownership gate (a brand-new session owns nothing → no volley at all) and the
24 h manifest lookback; it happens at most once. Old builds neither read nor
write the new files (reads go by file-name pattern), so the versions are
compatible by construction — on a shared machine the behaviors may differ
between sessions until all sessions are updated.

**Emergency rollback.** `watch.durableDelivery: false` (default TRUE — the
safe value: the store only ever SUPPRESSES a repeated wake-up) reverts to the
pre-stage-B memory-only dedup without shipping a new version. A non-boolean
value warns once and stays true. No paths in the config: the location is
convention (like the retire stamps).

**Fingerprint rules per kind (guideline §5.4 — every kind MUST have a
documented rule; episode kinds fingerprint by an episode id, never by an
empty constant):**

| Kind | Fingerprint | Repeat on the same fingerprint |
|------|-------------|-------------------------------|
| `report-ready` | report file mtime | No |
| `report-invalid` | report file mtime | No for the same mtime |
| `mailbox-question` | question envelope `ts` | No; a new question → a new fingerprint |
| `nudge-failed` | marker `ts` | No for the same marker |
| `grill-deck` | deck invocation count | A second deck → a new fingerprint |
| `context-critical` | EPISODE: worker launch stamp (`startedAt`) + the threshold | One wake per launch per threshold; a restarted worker is a new episode |
| `worker-dead` | EPISODE: worker launch stamp (`startedAt`); a manifest without a parseable stamp degrades to a stable constant (one wake per dedup lifetime for that edge) | One wake per launch: a herdr status flap within one launch does NOT re-fire; a NEW run (new `startedAt`) is a new death episode |
| `worker-stale` | the `collectedAt` value | A re-collect writes a new stamp → a new fingerprint |

**collectedAt vs the store (guideline §5.5) — two different facts, one rule.**
`collectedAt` means "the collect tool ACCEPTED the report" (a product fact,
written by collect into the manifest); the delivered store means "the wake-up
was REALLY SENT to this audience" (a watcher fact, written only by the
watcher, only after a successful send). The rule: detection sees collectedAt
and emits NO report events — collect NEVER writes to the delivery store
(`src/spawn.ts` is untouched by stage B). Re-writing a report after collect
therefore does not produce a new report wake (existing product behavior,
pinned by a test that asserts the store holds no report-kind records when
collectedAt is set).

**Garbage collection.** Records are removed ONLY when a worker really
disappears from the manifests (a watcher that committed records for it
notices the disappearance on a later tick and deletes the worker's records
from ITS OWN store file). Records are never removed on a skipped observation
or a transient error. A worker re-spawned with the same name starts with
fresh fingerprints (a new launch stamp, new report mtimes), so stale records
do not suppress its new facts.

- **F2 — `report-invalid` fires on half-written reports and on brief-declared
  schemas.** The watcher validates with the BASE `validateReport` and has no mtime
  grace, so a worker mid-write is called invalid (and a §17 `reportSchema` report
  is called invalid for 24 h). Fix shape: an mtime grace like delegate's
  `GRACE_RECHECKS`, resolve the manifest's recorded schema fragment before calling
  a report invalid, and soften the text when the error is "not valid JSON"/"is
  empty" to "may still be writing — re-check next tick".
- **F3 — torn-down workers keep firing `worker-dead` for 24 h.** Nothing removes a
  worker from `manifest.json` on teardown, so an intentionally closed worker looks
  like a failed spawn in every new session. Fix shape: stamp `tornDownAt` on the
  manifest worker after a successful teardown and skip those in
  `workersFromManifests` (same for collected-and-archived workers).
- **F5 — dedup does not skip I/O.** Every tick re-reads every worker's session
  JSONL, and `parseSessionUsage` is a full `readFileSync` (measured ~47 ms/tick
  for a 10-worker fleet, ~4.7 MB of JSONL; the tool-call scan alone is tail-capped
  at 1 MB). Fix shape: skip a worker whose `(size, mtimeMs)` signature is unchanged
  since the previous tick, and tail-cap the usage read like the deck scan.
- **P1 — type hygiene in `test/` (22 tsc errors at 91f6e0f, ZERO introduced by
  §21).** `usage-check.ts:275` `zero` lacks `lastTotalTokens` (→ 20 errors at
  314–387), `usage-check.ts:307` passes `number | null` where a `string` detail is
  expected. Schedule a pass: annotate `zero: SessionUsage`, wrap the detail in
  `String(...)`. (The third error of that set — `transport-contract.ts` `subDir`
  out of scope in `finally`, which also leaked one `impl-qa-*` dir per run — IS
  fixed here, so the count is 21 from this commit on.)

Also deferred, the review minors outside the QA F-list (same reasoning):

- **R4** — `worker-dead` infers death from "no live herdr status" alone, so a herdr
  daemon restart (registry emptied, `listStatuses` reachable) looks like a fleet
  wipe. Fix shape: require the dead condition on two consecutive ticks.
- **R5** — the grill-deck scan is tail-window-only (1 MB), so a deck call deep in a
  long session is invisible. Documented in §21 and pinned by W5.5, but never
  declared as a deviation. Fix shape: declare it, or regex-scan the whole file for
  the tool name (no JSON parse needed).
- **R6** — `readManifest` validates the top level only, so a worker entry with a
  name but no `reportPath` can produce a `worker-dead` wake pointing at a garbage
  path. Fix shape: skip entries lacking a non-empty string `reportPath`, same
  guard style as the existing name check.
- **R7** — `session_shutdown` runs `disposeFleetUI()` before `stopWatcher()`
  unguarded; if the UI dispose throws, the poll timer outlives the session (it is
  `unref`'d, so the process still exits). Fix shape: stop the watcher first.

---

# v1.12.1 — lifecycle hygiene (fleet-UX wave 3, user-approved 2026-09-07)

## 22. Teardown-after-collect + worker-stale + the `s` flag

**Field motivation.** After v1.11.1, collect stamps `collectedAt` — and then
nothing ever happens: collected workers stay mounted in herdr forever until
somebody remembers `/delegate-teardown`. A long fan-out day ends with a pile
of idle panes holding live worktrees. The gap closes from both ends: collect
now tears its worker down automatically, and whatever slips past that (config
off, an advisory teardown failure, an older build) becomes VISIBLE instead of
silent. USER DECISIONS locked: teardown default **ON**, grace **0**, only on
**VALID** collect, foreign fleets never mutated (they are not mutated anyway —
collect is own-fleet by construction).

### 22.1 Teardown-after-collect (`src/spawn.ts`)

After a successful strict collect — report valid, `collectedAt` stamped, the
result text already built — the tool calls `transport.teardown({ name,
placement, force: true })` with the worker's recorded placement. Guards, in
order (each pinned by the C-matrix in `test/collect-teardown-check.ts`):

1. **Probe** → skip (probes write no report and keep their panes this wave).
2. **Config off** (`collect.teardownAfterCollect: false`) → skip.
3. **Pending mailbox question** (`q-<name>.json` exists) → skip — the worker
   is still in a conversation; the question must survive the pane.
4. **Collection failed or report invalid** → unreachable by construction: the
   hook lives inside `successResult`, so an `E_REPORT_*` path never reaches it
   (the pane is needed for diagnose anyway).

**Advisory by contract (§21, sacred):** the hook can only append an advisory
line to the already-decided collect result — `Auto-teardown: …` on success,
`Warning: auto-teardown after collect failed (…) — collect unaffected` on
failure — and write the audit trail. No teardown failure path can alter a
collect outcome, and nothing throws past the tool boundary. The audit lines
MIRROR the `/delegate-teardown` command's `logTo` format
(`[ISO] plan/done/error: teardown worker=… kind=… workspace=… pane=…`) into
the same `<exchange dir>/teardown.log`, suffixed `(auto-after-collect)` so the
automatic path is distinguishable from manual sweeps.

**Config** (same tolerant style as `resolveWatchConfig` — missing/corrupt/
partial → defaults, never throws, `resolveCollectConfig` in `src/observe.ts`):

```json
{ "collect": { "teardownAfterCollect": true } }
```

Default TRUE (user-locked); only an explicit boolean moves off the default.

### 22.2 `worker-stale` watcher event (`src/observe.ts`)

New kind in the §21 union. Fires when the manifest records `collectedAt`,
`now − collectedAt > watch.staleAfterMs` (default 30 min, floor 60 s), and the
worker is STILL live in herdr — i.e. teardown-after-collect missed it. The
message carries the age and both moves: *"collected N min ago and still
mounted — tear it down (/delegate-teardown) or keep"* (keeping is legitimate:
a worker can be re-briefed after a collect). Fingerprint = `collectedAt`, so a
re-collect (new stamp) re-arms the wake-up; an unparseable stamp reads as
absent. The ownership gate upstream already silences foreign fleets — the
event deliberately does not bypass it, so a stale worker wakes ONLY its owner
(pinned by W15.13/14). Not live (already torn down, or herdr unreachable) →
silent. This is F3's visible-half complement: torn-down-and-gone workers stay
invisible, collected-but-still-mounted workers become loud.

### 22.3 The stale age tail (`src/ui/fleet.ts`)

v1.12.1 rendered this condition as the folded group's `s` letter; **v1.13.0
(fleet-UX wave 4) retires the letter and spells the claim out** — the
CONDITION is unchanged: **every** member collected ≥30 min ago (stale-idle
group; one fresh or never-collected member suppresses the group-level
claim). When it holds, the folded/mega line gains an age tail carrying the
OLDEST member's `collectedAt` age in human form (`idle 31m`, `idle 3h46m`),
with an OWNERSHIP-SCOPED remedy (report-act: `/delegate-teardown` is a
global sweep with no ownership filter — never advertised on foreign lines):
mine groups read `… · idle 31m (/delegate-teardown)`, foreign/`owner?`
groups read `… · idle 34m · owner can tear down`. The same condition
demotes otherwise-equal groups in `rankGroups` and seats them last in the
height window (report-pulse fix 2). Threshold still shares the watcher's
30-min default (`FLEET_STALE_AFTER_MS` = `WATCH_DEFAULT_STALE_AFTER_MS`).
`isFleetStale` stays pure (absent/empty/garbage/future stamps → never
stale — a flag is a claim); `renderFleet` takes an injectable clock so
goldens stay deterministic. No new fs reads: `collectedAt` rides the
manifest the overlay already reads. The widget (fleet-ui.ts) is untouched.

**Tests.** `test/collect-teardown-check.ts` (+ driver, real `execute()` over
a mock transport, child-process `$HOME` for config): the C1 config matrix,
C2 valid→torn-down-exactly-once / invalid / q-pending / probe / teardown-
throws→collect-still-ok, C3 config-off, C4 static pins. `watcher-check.ts`
W15: fires once, re-arms on a new `collectedAt`, silent below threshold /
without stamp / when not live / unreachable / foreign; key hygiene;
`staleAfterMs` default/override/floor (W2.8–W2.10). `fleet-tree-check.ts`
S1–S6 + V11/V12 goldens. All suites green except `transport-contract`
(known env-broken: live herdr spawn).

---

# v1.15 — retire: auto-teardown of drained worker panes (user-approved design)

## 23. The retire state machine (watcher-side close, ACK or TTL)

**Field motivation.** §22's teardown-after-collect fires once, inline at
collect — but a worker that detaches (E_TIMEOUT / releaseOn=started), gets
answered via the mailbox, or is simply never collected again leaves its pane
mounted forever. The watcher already sees every fact needed to know a worker
is DONE; the missing piece is permission to act. §23 grants it: the watcher
closes a worker's pane when its purpose is drained — automatically, on the
owner's terms (ACK), or on a leash (TTL).

**OPT-IN (user decision, mandatory).** The whole machine is gated by a MASTER
SWITCH, `watch.retire` — default **FALSE**. Absent key → false; a present
non-boolean warns once and stays false (a typo must never silently ENABLE
auto-teardown). With the switch off the retire pass is a strict NO-OP: panes
NEVER close, the manifest never gains `retirableSince`, and behavior is
byte-identical to pre-§23. A `delegate_mailbox` release posted while disabled
is an honest no-op ("auto-teardown is disabled via watch.retire=false") and
any existing `release-<name>.json` is DELETED with the no-op note — a stale
marker must not fire a close once the feature is enabled later. When the
switch is true, everything below operates as specified.

### 23.1 RETIRABLE (all three, evaluated by the watcher)

1. **Report valid** — the worker report exists and is schema-VALID against the
   BASE schema **+ the brief fragment** (the manifest's recorded
   `reportSchemaFragment`, falling back to the brief's own `reportSchema`):
   `status: "pass"` and `"fail"` BOTH count — an honest failure is a drained
   worker. Invalid/missing NEVER retires (that is the diagnosis window for a
   diagnosed retry).
2. **Mailbox drained** — no pending `q-<name>.json` AND no UNANSWERED
   `a-<name>.json`. There is no worker-side ack for answers, so an answer
   counts as consumed once the worker produced output after it: its report
   postdating the answer file proves the mail was picked up. An answer newer
   than the report keeps the mailbox conservative (never retirable) — the
   explicit ACK below is the orchestrator's override for the Q&A flow.
3. **Settled** — herdr agent status is `done` or `idle` (NOT
   working/blocked; an unknown status — herdr unreachable or the agent gone —
   is never retirable).

### 23.2 CLOSE (either)

- **ACK** — the orchestrator posts a release: `delegate_mailbox` action
  `"release"` writes `release-<name>.json` next to the brief (a bare
  `{from:"orchestrator", ts}` envelope, no text, no nudge — release is a
  retirement signal, not worker mail). The watcher sees it → close
  immediately. The release closes a retirable worker only: the exceptions
  below still hold.
- **TTL** — `watch.retireTtlMs` (default 900 000) elapsed since the moment
  the worker became retirable.

EXCEPTIONS (never close): report invalid/missing (diagnosis window), a
pending worker question, and — the inverted case — **probes**: a probe has no
report by contract, so condition 1 can never hold; a probe whose smoke verdict
is in (settled done/idle, no pending question) closes IMMEDIATELY, no stamp,
no TTL wait.

### 23.3 Mechanics (`src/observe.ts` — retire pass, `src/exchange.ts` — release markers, `src/spawn.ts` — mailbox tool actions)

- **Close capability.** herdr has NO `pane close` verb (verified against the
  CLI: panes close only via their container). The real verbs are `tab close`
  and `worktree remove` + `workspace close` reconcile — exactly what
  `Transport.teardown({ name, placement, force: true })` already encapsulates
  (including the sub-orchestrator worktree authority guard). The retire pass
  reuses it; no new transport method, no duplication.
- **Persisted clock.** The first tick all three conditions hold stamps
  `retirableSince` (ISO) into the manifest worker entry — NEVER memory-only
  (a watcher restart must not lose the TTL clock). When the state breaks
  (a new question, the report rewritten invalid, back to working), the stamp
  clears; the next retirable transition restarts the TTL.
- **The close stamp.** On successful close the entry gains `retiredAt` — the
  entry is NEVER deleted (history stays), and a retired entry silences every
  watcher event kind (worker-dead above all: the close itself is the expected
  cause of any herdr absence). The close also CONSUMES the ACK marker
  (`release-<name>.json` is deleted, best-effort): a leftover marker would
  ACK-close a fresh same-name retry (spawn appends into the SAME task dir) on
  its FIRST retirable tick, silently skipping its TTL diagnosis window. This
  also means a close FREES the herdr name —
  a same-name retry becomes possible after retire, which completes the
  E_REPORT_INVALID/E_BUDGET guidance ("retry MUST use a NEW name") with a
  sanctioned way to reclaim the original name.
- **Ownership (mutation discipline, stricter than the wake-ups).** Retire is
  a mutation, so it fails CLOSED where the wake-ups used to fail open: a worker that
  declares an `orchestratorSessionPath` is retired only by that session
  (a degraded self-id mutates nothing); legacy manifests (no field) stay
  fail-open so old fleets still drain; a worker never retires itself.
  Watcher stage A note: with wake-up delivery now fail-closed (§21.1 F1),
  this legacy fail-open RETIRE is a CONSCIOUS REMAINING EXCEPTION on the
  mutation side — deliberately not fixed in the same change as delivery
  (the guideline forbids unrelated fixes in one change); a follow-up may
  gate it behind the same `watch.legacyFailOpen` flag or fail it closed.
- **Advisory by contract (§21, sacred).** The pass runs inside the watcher
  tick, fully guarded: a failed stamp or teardown is logged and retried next
  tick (the missing `retiredAt` re-fires the decision). No retire failure can
  ever affect a spawn or a collect outcome.

**Config** (same tolerant style as the other watch keys, `resolveWatchConfig`):

```json
{ "watch": { "retire": true, "retireTtlMs": 900000 } }
```

`watch.retire` — the master switch, default FALSE (opt-in; non-boolean →
warn-once + false). `watch.retireTtlMs` — the TTL, default 900 000, inactive
unless `retire` is true; an explicit `0` is legal (close on the first
retirable tick); a bad value warns ONCE per process and uses the default.

**Tests.** `test/retire-check.ts` (R0–R6): the DEFAULT-OFF gate first-class
(R0: disabled → no close even on ACK/TTL, no stamps, marker unconsumed;
R6.5–R6.7 static pins incl. the mailbox disabled branch's stale-marker
delete); config matrix incl. both keys' warn-once (child `$HOME`); every
condition/exception in `evaluateRetire`; manifest threading; retired-silent
detection; `retirePass` stamp/clear/close-exactly-once/teardown-throw-retry/
ACK/probe/ownership/corrupt-manifest (all with `retireEnabled: true` —
hermetic). `watcher-check.ts` W15.15 pins the config threading.

# layout v2 — 7-file flat layout: index.ts + 6 modules (refactor waves W0–W6, 2026-09-07)

The old `src/{tools,transport,ui}/` taxonomy is deleted; every module is a
top-level file under `src/`, `index.ts` is the only exporter, and each module
opens with a ZCS MODULE_CONTRACT header naming its owned invariants. One line
each — where the invariants live:

- **index.ts** — wiring-only composition root, only exporter of the
  extension. Binds the configured WorkerHost adapter exactly once
  (config `"host"` key, default herdr — §24.1) and injects it (dependency
  rule, pinned by static-check T1.1/T1.1b/T1.1c); calls
  `registerCommands` for the command wiring (/delegate-fleet,
  /delegate-teardown — absorbed from src/commands.ts in W5, moved to
  src/observe.ts in W6), fleet-UI mount, watcher mount, archive prune.
- **src/host.ts** (seam) + **src/herdr/host.ts** (herdr adapter) — the old
  single src/transport.ts split by the workerhost inversion (§24): the seam
  owns the contracts, the adapter the herdr CLI/socket implementation.
- **src/exchange.ts** — everything durable on disk: exchange-dir conventions,
  manifests, reports, schemas, mailbox files, archive, the watcher satellites
  (retire stamps + the durable delivered-facts store — stage B: the I/O half,
  one atomic tolerant read/merge per file). Owns
  append-before-start (file side), collectedAt-dedup (write side),
  answer-consumed-mtime, atomic serialized manifest writes.
- **src/spawn.ts** — everything the orchestrator DOES: delegate + mailbox
  tools, one straight pipeline. Owns append-before-start (execution side),
  collectedAt-dedup (write side), abort-detaches (flow side),
  no-direct-herdr-for-reportless-verdicts, advisory-by-contract (spawn side).
- **src/observe.ts** — everything the orchestrator KNOWS: status tool,
  event-driven watcher, §23 retire engine, the durable delivered-facts POLICY
  (stage B: canonical key, tick order, commit-after-send, garbage collection),
  watch/collect config, and the
  /delegate-fleet + /delegate-teardown commands (`registerCommands`, moved
  here from index.ts in W6 — this module owns the watcher/teardown state
  they drive). Owns collectedAt-dedup (reader side), answer-consumed-mtime
  (mailboxDrained), retire-ack-consume, watcher advisory-by-contract.
- **src/fleet.ts** — all pixels: ownership classification, text primitives,
  ambient widget, tool-result rendering, /delegate-fleet overlay, and the
  worker-view aggregation (`buildWorkerView` — moved here from observe.ts in
  W6: view-building is view code; the move broke the runtime-benign
  fleet<->observe import cycle, the graph is a DAG again with observe →
  fleet as the only edge between the two). Owns line-width-clamping,
  fail-closed ownership display, UI advisory-by-contract, read-only overlay.
  `FLEET_STALE_AFTER_MS` remains a deliberate keep-in-sync duplicate of
  observe's `WATCH_DEFAULT_STALE_AFTER_MS` — importing it would re-create
  the fleet<->observe cycle with its module-eval TDZ hazard (see the fleet
  header).
- **src/usage.ts** — session-JSONL gauges (§20); unchanged bodies, ZCS
  MODULE_CONTRACT header added in W6.

# workerhost inversion — the WorkerHost seam (unreleased)

## 24. WorkerHost: the backend-neutral seam (workerhost migration, 2026-09)

The herdr boundary is split into a backend-neutral SEAM and a herdr ADAPTER,
so a second backend (the in-memory fake ships first) can serve the same tool
layer. The seam interface keeps its historical type name `Transport`
(design prose says "WorkerHost" — same thing); its method names are frozen.

### 24.1 File layout and the binding rule

- **`src/host.ts`** — the seam: `Transport` interface + req/result types, the
  E_* taxonomy (+ `GUIDANCE`), report/mailbox/progress contracts, `briefPrompt`,
  budget constants, and `sessionHasReply`. Imports node builtins ONLY — bottom
  of the graph (pinned fail-closed by static-check T1.1d). Backend ids
  (workspaceId/paneId/tabId) are absent from the OPERATION types: `StartReq`/
  `TeardownReq` key on the opaque, adapter-defined `placementRef`, and the read
  model `AgentStatus` carries only `{name, status, placementRef?}`. The legacy
  id fields survive ONLY as deprecated-compat: `Placement` keeps `workspaceId`
  and `paneId` (no `tabId`), and manifest records may carry them alongside
  `backend` + `placementRef` — the ALONGSIDE rule (§24.2 invariant 4) keeps
  them for the 1.15.x version-skew cohort; do not delete them.
- **`src/herdr/host.ts`** — the herdr adapter: CLI plumbing (`runHerdr` with
  SIGKILL escalation), the NDJSON socket client, the mutation queue, result
  mappers, and the adapter-private id codec (`herdr:pane:<paneId>` refs).
  Imported ONLY by `index.ts` (pinned by T1.1/T1.1c; watcher-check W1.1).
- **`src/host/fake.ts`** — the in-memory fake (statusScript-driven settle,
  `fake:<n>` refs). Confinement: imports only the seam + exchange.
- **`index.ts`** — the composition root and the ONLY adapter importer: it
  reads the config's `"host"` key (default `"herdr"`; unknown value →
  structured E_START error) and injects the chosen adapter into every tool.

### 24.2 Seam invariants (every adapter must honor these)

1. **Serialized mutations** — mutating ops (place/start/prompt/teardown) run
   one at a time, internally queued (DESIGN.md §9); the herdr adapter adds a
   per-op deadline (W2 pile-up guard).
2. **Opaque refs** — `Placement.placementRef` is adapter-defined and unique
   per live placement; the seam only ever does opaque equality matching.
   `StartReq` is keyed by `placementRef`; the read model `AgentStatus`
   exposes only `{name, status, placementRef?}`.
3. **Not-found → idempotent** — teardown of an already-gone placement is a
   no-op SUCCESS reported as the structured `{ alreadyGone: true }` result
   field (migration stage 1; pinned on both adapters by test/host-parity-
   check.ts P3b). Callers read the FIELD — matching "not found" out of the
   error message text is gone from the tool layer.
4. **Version-skew manifests** — new placements write `backend` +
   `placementRef` ALONGSIDE the legacy id fields (workspaceId/paneId/tabId);
   legacy fields are never deleted while any 1.15.x cohort may read/close.
   Legacy entries (no backend) read fail-open as herdr.
5. **Scan backend gate** — the manifest scan drops entries whose placement
   declares a non-empty backend ≠ the active host, so foreign-backend
   fixtures (e.g. fake manifests from tests) never wake a live session.
6. **Neutral texts** — tool descriptions, event messages and error guidance
   name no backend commands; herdr CLI recipes stay inside the adapter's own
   errors, where they are true.

### 24.3 Parity pin

`test/host-parity-check.ts` drives one scripted flow — place → manifest
round-trip → teardown ×2 (idempotent) → ref-based dedup — against the fake
(always, CI) and real herdr (skip-guarded on `herdr --version`), asserting
identical seam-level outcomes on both legs.

---

# In-flight: migration stage 3 (branch `feature/migration-stage3`, audit steps 8–10)

Work in progress, described here so the map above does not silently go stale
again. Each item changes structure, not the external tool contract; after the
stage-3 merge this section is folded into the corresponding sections above.

- **Step 8 — the completion criterion is the report file.** The settle wait
  binds to the canonical report path (run ownership proven by embodiment
  identity, not by clock comparison); the backend status becomes an advisory
  gauge; the settle result becomes a discriminated union at the seam and its
  semantics lift out of the adapter. Effect: the "build never reports working"
  and "done aged to idle" scenarios (§19.1b–§19.1c) become reproducible on the
  fake adapter, without live herdr.
- **Step 9 — the backend name comes from one point.** The manifest scan takes
  the active backend as a parameter; the `ACTIVE_HOST` constant is deleted, the
  herdr token disappears from command guidance, and the adapter is published as
  a separate export subpath. Source-text pins for the import rule are replaced
  by a package-boundary check.
- **Step 10 — laws and composition restored.** Session-tail parsing moves from
  the observation layer into the gauge layer (the single-parser law of
  `usage.ts` holds again); watcher mounting is extracted into a composition
  module with injectable dependencies; the remaining first-wave source-text
  pins are replaced by a behavioral mount test.
