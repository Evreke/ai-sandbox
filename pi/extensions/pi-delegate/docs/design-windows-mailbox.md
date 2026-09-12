# Design — Windows paths + pluggable mailbox store (pi-delegate)

Author: worker `winpath-research` (research/design, read-only).
Code base: worktree of `/root/projects/ai-sandbox` @ branch `delegate/host-impl`
(HEAD `48ef57e` — WorkerHost seam + `exchangeRoot()` env override present).
All `file:line` references below are against that branch; deviations on
`feature/release-1.16.0` are called out where they matter.

---

## 1. POSIX-path coupling inventory (exhaustive, classified)

Classification key: **[ROOT]** exchange-root constant/derivation ·
**[CONCAT]** string-built paths (`/` in template literals) ·
**[SPLIT]** POSIX-shaped parsing (split/startsWith/regex on `/`) ·
**[HOME]** homedir/`~` layouts · **[SOCK]** herdr transport specifics ·
**[SESSION]** pi session JSONL layout · **[PROMPT]** prompt-embedded paths ·
**[MANIFEST]** persisted paths · **[TEXT]** prose/guidance strings (cosmetic,
but they teach users and models POSIX paths).

### 1.1 The exchange root and its consumers

| Ref | Kind | Notes |
|---|---|---|
| `src/exchange.ts:136–138` — `exchangeRoot()` | **[ROOT]** | `process.env.PI_DELEGATE_EXCHANGE_ROOT \|\| "/tmp/exchange"` — hardcoded POSIX absolute default. The env override already exists on this branch. |
| `src/exchange.ts:279–290` — `ensureExchangeDir` | **[ROOT]** | `resolve(parent) !== exchangeRoot()` string compare; error text interpolates `${exchangeRoot()}/<task>/`. On Windows, `resolve()` does NOT normalize drive-letter or component casing → a `c:\…` brief against a `C:\…` root env var would spuriously fail E_BRIEF (case-normalization risk, §2). |
| `src/exchange.ts:662` — `scanAllManifests` | **[ROOT]** | `readdirSync(root)` — the only root-level scan; migration story in §3 must hook here. |
| `src/spawn.ts:553–557` — `probeDir()` | **[ROOT]+[CONCAT]** | `` `${exchangeRoot()}/_probe` `` — string concat with `/`. |
| `src/observe.ts:206`, `src/observe.ts:839`, `index.ts:234` | **[SPLIT]** | `v.dir.endsWith("/_probe")` — POSIX separator assumption; a Windows probe dir `<root>\_probe` is not detected. |
| `src/fleet.ts:1003–1006` — `slugOf` | **[SPLIT]** | `dir.split("/")` — on Windows returns the whole `C:\tmp\exchange\task` string as the slug (or mangles it); breaks fleet grouping keys and display. |
| `src/fleet.ts:682`, `index.ts:129` | **[CONCAT]** | `` `${dir}/manifest.json` `` (watcher/refresh manifest read). |
| `src/exchange.ts` manifestPath (`manifestPath(dir)` uses `resolve(dir, "manifest.json")`) | ok | node:path — correct. |

### 1.2 String path building with `/` vs `node:path`

All sites that assemble a path with a literal `/` instead of `path.join`. On a
Windows runtime these produce mixed-separator paths (`C:\x\y/report-1.json`) —
mostly *resolvable* by Win32, but they poison comparisons, displays, and
`endsWith`/`split` logic, and violate the single-builder rule proposed in §3.

| Ref | Expression |
|---|---|
| `src/exchange.ts:540` — `reportPathFor` | `` `${dir}/report-${name}.json` `` |
| `src/exchange.ts:781` — `questionPathFor` | `` `${dir}/q-${name}.json` `` |
| `src/exchange.ts:785` — `answerPathFor` | `` `${dir}/a-${name}.json` `` |
| `src/exchange.ts:794` — `nudgeFailedPathFor` | `` `${dir}/nudge-failed-${name}.json` `` |
| `src/exchange.ts:848` — `releasePathFor` | `` `${dir}/release-${name}.json` `` |
| `src/exchange.ts:1119` — `progressPathFor` | `` `${dir}/p-${name}.jsonl` `` |
| `src/exchange.ts:381–384` — `atomicWriteFileSync` | tmp name `` `${path}.tmp-${pid}-${rand}` `` — no separator, fine, but the rename semantics it relies on are POSIX (§2). |
| `src/fleet.ts:682` | `` `${dir}/manifest.json` `` |
| `src/fleet.ts:728,730` — mailbox mtimes | `` `${dir}/q-${name}.json` `` / `` `${dir}/a-${name}.json` `` |
| `src/spawn.ts:414` — question archive | `` `${dir}/q-${params.name}.answered-${Date.now()}.json` `` (also a `rename()` — Windows EPERM semantics, §2) |
| `src/spawn.ts:556` — probe dir | `` `${exchangeRoot()}/_probe` `` |
| `src/spawn.ts:628`, `src/observe.ts:1731` — teardown audit | `` `${dir}/teardown.log` `` |
| `index.ts:129` | `` `${dir}/manifest.json` `` |

`path.join` coverage is otherwise good: `usage.ts`, `exchange.ts` archive
section (`join`), `observe.ts:464,1687`, `herdr/host.ts:70,386` all use
`join(homedir(), …)`.

**Regexes containing `/` or POSIX absolute patterns:**

| Ref | Kind | Notes |
|---|---|---|
| `src/usage.ts:215` — session-dir munge | **[SPLIT]+[SESSION]** | `workerCwd.replace(/^\//,"").replace(/\//g,"-")` — POSIX munge. On Windows a cwd `C:\repo` yields `--C:\repo--`, which will never match pi's actual Windows store layout (pi-side dependency — open question, §5 Phase 3). |
| `src/usage.ts:224` | ok | filename regex (timestamped `.jsonl`) — separator-free. |
| `src/herdr/host.ts:133` — `herdr:pane:(.+)` | ok | no path. |
| `src/exchange.ts:771` | ok | JSON-pointer massaging, not a path. |
| `src/usage.ts:191` (doc comment) | **[TEXT]** | documents the POSIX munge rule. |

### 1.3 `homedir()` usage and `.pi/agent/...` layouts

| Ref | Kind | Notes |
|---|---|---|
| `src/exchange.ts:946,1019` — schema library | **[HOME]** | `join(homedir(), ".pi/agent/pi-delegate-schemas")` — join-based, portable; dir content platform-neutral. |
| `src/exchange.ts:1174–1178` — `archiveRoot()` | **[HOME]** | `path.join(process.env.HOME ?? os.homedir(), ARCHIVE_DIR)`. **[ROOT]**-adjacent risk: `HOME` is a Unix convention; on Windows `HOME` is usually unset (→ `os.homedir()` = `USERPROFILE`, correct) but if some environment sets `HOME` to a POSIX-style string the archive silently lands in the wrong place. Prefer `os.homedir()` first on win32. |
| `src/observe.ts:464` — config file | **[HOME]** | `join(homedir(), ".pi/agent/pi-delegate.config.json")` — portable. |
| `src/observe.ts:1687` — watch log | **[HOME]** | portable. |
| `src/usage.ts:167,280,307` — config reads | **[HOME]** | portable. |
| `src/usage.ts:209` — sessions root | **[SESSION]** | `join(homedir(), ".pi/agent/sessions")` — portable join; the *layout* under it is POSIX-munged (§1.2). |
| `src/herdr/host.ts:70` — `WORKTREE_DIR` | **[HOME]** | `join(homedir(), ".herdr", "worktrees")` — portable join; the *comparison* against it is not (§1.4). |
| `src/herdr/host.ts:386` — `DEFAULT_HERDR_SOCK` | **[SOCK]** | `join(homedir(), ".config/herdr/herdr.sock")` — a Unix-socket file under `~/.config`; Windows needs a named pipe (§1.4). |

### 1.4 herdr / transport specifics

| Ref | Kind | Notes |
|---|---|---|
| `src/herdr/host.ts:23,453…` — `HerdrSocketClient` | **[SOCK]** | NDJSON over a **unix socket** (`node:net` `connect(path)`). On Windows, `node:net` speaks named pipes only via `\\.\pipe\…` paths; the herdr server would have to listen on a pipe. **herdr's own scope** — pi-delegate can only gate the socket path (see §3 "POSIX-only v1"). |
| `src/herdr/host.ts:388–391,765–770` — `HERDR_SOCKET_TRANSPORT=cli` kill-switch | **[SOCK]** | already exists — the natural Windows v1 fallback (all-CLI, zero sockets). |
| `src/herdr/host.ts:344–350` — `isSubOrchestratorCwd` | **[SPLIT]** | `cwd.startsWith(`${WORKTREE_DIR}/`)` — hardcoded `/` separator. On Windows (`C:\Users\x\.herdr\worktrees\…`) sub-orchestrator detection fails open/closed incorrectly. Must become a segment-aware, separator-agnostic boundary compare. |
| `src/herdr/host.ts:219` — CLI spawn | **[SOCK]** | `spawn("herdr", args, { windowsHide: true })` — `windowsHide` is already right for Windows; but spawning a bare `herdr` on Windows resolves `herdr.cmd`/`herdr.ps1` shims, which modern Node refuses without `shell: true` (EINVAL, CVE-2024-27980 mitigations). Needs a Windows-aware resolution (e.g. `where herdr` → full `.cmd` path + `shell:true` with array-arg care, or document a `.exe` shim). |
| `src/herdr/host.ts:84–87,149–270` — SIGTERM→SIGKILL escalation | **[SOCK]** | POSIX-only termination shape: `SIGTERM`/`SIGKILL` have no Windows equivalents (Node maps them to `TerminateProcess`, no grace, no tree kill). Windows shape: `taskkill /pid <pid> /T /F` for the escalation step; the "grace" step can send `taskkill /pid <pid>` (WM_CLOSE) or just accept immediate termination. Isolated inside `runHerdr` — good seam. |
| `~/.herdr/worktrees` as authority prefix (`src/host.ts:62` doc, `herdr/host.ts:69–70,344–350,741`) | **[SPLIT]** | same fix as `isSubOrchestratorCwd`. |

### 1.5 Session JSONL paths (pi's own layout)

| Ref | Kind | Notes |
|---|---|---|
| `src/usage.ts:189–230` — `resolvePiSessionCandidates` | **[SESSION]** | Reconstructs pi's store path `~/.pi/agent/sessions/--<munged-cwd>--/<ts>_<uuid>.jsonl` with the POSIX munge. Two Windows problems: (a) the munge rule (§1.2); (b) pi's Windows session-store layout is pi's decision, not ours — this fallback must be derived from pi's actual rule, ideally by importing pi's own helper instead of re-implementing the munge. |
| Manifest `sessionPath` / `orchestratorSessionPath` (`src/exchange.ts:168–200`) | **[MANIFEST]** | absolute, machine-local; see §1.6. |

### 1.6 Prompt-embedded paths (functional constraint, not cosmetic)

Workers are co-located agents on the same machine: the ONLY way they learn
mailbox/report locations is path text embedded in prompts and briefs. On
Windows those texts must carry Windows-valid, ideally native-separator paths —
a POSIX path in a Windows worker's prompt is not stylistically wrong, it is
**unusable** (the agent's `read`/`write` tools must open those files).

| Ref | Kind | Notes |
|---|---|---|
| `src/host.ts:362–378` — `briefPrompt` | **[PROMPT]** | Embeds `briefPath` verbatim, plus RELATIVE names `q-<name>.json` / `a-<name>.json` / `report-<name>.json` with the phrase "next to the brief". The relative names are separator-free (good — keep them relative forever); only `briefPath` itself must be rendered with the host separator. |
| Brief OUTPUT sections (authored by callers) | **[PROMPT]** | Briefs hand workers `report-<name>.json` paths as text (e.g. this very brief: `/tmp/exchange/workerhost-refactor/report-winpath-research.json`). The orchestrator cannot fix caller-authored briefs, but `briefPrompt`'s line and all guidance strings must not *add* POSIX separators on Windows. |
| `src/spawn.ts:309,333,393,404` — mailbox guidance texts | **[TEXT]+[PROMPT]** | e.g. "no readable q-<name>.json under /tmp/exchange" — file *names* relative (good), root mention POSIX (cosmetic once §3 lands; derive from `exchangeRoot()`). |
| `src/spawn.ts:762,894`, `src/observe.ts:167,202,305,655`, `src/fleet.ts:681,1184,1395,1645,1683`, `src/exchange.ts:7,51,113–115,126–129,229,261,647,657,936` | **[TEXT]** | doc comments and tool descriptions hardcoding `/tmp/exchange`. Not functional, but they are the spec surface models read — update in the same PR as §3. |

### 1.7 Manifest-persisted paths (portability)

Persisted in every manifest (`src/exchange.ts:139–216`, written by
`updateManifest`, read tolerantly everywhere):

- `dir`, `briefPath`, `reportPath` — absolute, machine-local.
- `workers[].placement.checkoutPath` (worktree placement) — absolute, under
  `~/.herdr/worktrees/<repo-slug>/…` on this branch.
- `workers[].sessionPath`, `orchestratorSessionPath` — absolute pi paths.

Risks, concrete:

1. **Machine-locality**: every path is meaningless off the machine that wrote
   it. Today that is *correct by co-location* — herdr panes are local, and no
   code reads an exchange dir across machines (verified: the only root reader
   is `scanAllManifests`, and every consumer resolves paths locally). But
   nothing *documents* or *enforces* it; if `PI_DELEGATE_EXCHANGE_ROOT` is
   pointed at a synced/share folder (tempting on Windows with UNC paths,
   `\\server\share\…`), manifests from another machine would be scanned,
   filtered only by the backend field (`filterForeignBackendWorkers`,
   `src/exchange.ts:668–703`) and would wake the wrong orchestrators. §3 adds
   a machine-owner check (hostname stamp) to the scan.
2. **Case-insensitivity**: Windows FS is case-insensitive; `resolve()` does not
   normalize case. Two manifests whose `dir` differs only by case are one dir
   on disk but two keys in fleet grouping / watcher dedup (grouping key
   `manifest.dir :: orchestratorSessionPath`, `src/fleet.ts:1010+`; `slugOf`
   §1.2). Normalize (lowercase drive + casefold, or `realpathSync.native`) at
   manifest-read boundary.
3. **Drive letters / UNC**: `isAbsolute("C:\…")` true, `isAbsolute("\\\\srv\\share\\x")`
   true on win32 — `ensureExchangeDir` works, but slug derivation, probe
   detection and grouping (§1.2) do not handle drive/UNC shapes.

### 1.8 Test fixtures (read-only note)

Tests already sandbox the root via `$PI_DELEGATE_EXCHANGE_ROOT` +
`mkdtemp` (`test/host-parity-check.ts:51`, `test/mailbox-check.ts:50`,
`test/collect-teardown-driver.ts:26`) — the harness for the §5 portability
tests exists; fixtures just need win32-shaped inputs (`C:\…` strings are valid
*strings* on any OS since we only assert on path-builder output).

---

## 2. Windows semantics risks beyond paths

1. **Case-insensitive collisions.** Worker names are enforced lowercase
   (`WORKER_NAME_RE`, `src/host.ts:349`) — mailbox filenames are safe. Task
   slugs and manifest `dir`s are not: fleet grouping, watcher dedup and
   `ensureExchangeDir`'s string compare (§1.1) all compare raw strings.
   Fix: normalize at the read boundary, compare segment-wise.
2. **Long paths (>260 chars).** Nested depth is modest (root/task/file), but
   the Windows default root matters: `C:\Users\<user>\AppData\Local\pi\exchange`
   already burns ~45+ chars before a long username; worktree checkouts under
   `~\.herdr\worktrees\<repo>\<branch>` plus node_modules-style depth in
   evidence `file` fields can cross MAX_PATH. Mitigations: keep roots short,
   declare the app long-path-aware (manifest) where we control the host
   process (pi/bun), and add a long-path fixture test (§5).
3. **Rename atomicity / file locking.** `atomicWriteFileSync`
   (`src/exchange.ts:381–384`) and the question-archive rename
   (`src/spawn.ts:414`) assume POSIX rename-over-open-file. On Windows
   `renameSync` onto a destination with ANY open handle (a reader mid-read,
   indexer, antivirus) fails `EPERM`/`EBUSY`. Required: bounded retry-with-
   backoff around rename (and around the watcher's tolerant reads — they
   already degrade to null, which is correct). Also open-with-share flags
   where we control both sides.
4. **fs.watch vs polling.** Good news: the watcher is a **10 s poller**
   (`src/observe.ts` watch section; `index.ts:286` mounts polling UI) — no
   `fs.watch` anywhere. Polling is fully portable; no work needed.
5. **Process spawning / termination.** §1.4: `herdr` resolution on PATH
   (`.cmd` shim problem), SIGTERM/SIGKILL escalation → `taskkill /T /F`
   shape. Also `execFile`-parity error mapping (`herdrSpawnError`,
   `src/herdr/host.ts:203+`) must tolerate Windows error codes
   (`ENOENT` → herdr-not-installed message stays valid).
6. **mkdtemp/tmpdir.** Tests and probe use `mkdtemp`/env override —
   `os.tmpdir()` on Windows is `%TEMP%` (per-user, path may contain spaces
   and a non-ASCII username → quote/round-trip paths through APIs, never
   through shell strings; the codebase already uses array argv everywhere —
   keep that invariant).
7. **Env-var conventions.** `HOME` vs `USERPROFILE` (§1.3); `PI_DELEGATE_EXCHANGE_ROOT`,
   `HERDR_SOCKET_PATH`, `HERDR_SOCKET_TRANSPORT` are name-based (portable);
   path *values* set by users on Windows will be Windows paths — every
   consumer must be separator-agnostic (§3 rule).
8. **Line endings / text handling.** JSONL progress reads split on `"\n"`
   (`src/exchange.ts:1122+`) — tolerate `\r\n` (trim already handles the
   stray `\r` because `.trim()` runs per line — verified). Brief frontmatter
   parsing is pi's concern.

---

## 3. Design: platform-resilient exchange layer

### 3.1 Where the exchange root comes from

Priority order (first hit wins):

1. **Explicit env**: `PI_DELEGATE_EXCHANGE_ROOT` (exists; keep semantics —
   absolute path, must be a dir).
2. **Config**: new optional key `exchangeRoot` in
   `~/.pi/agent/pi-delegate.config.json` (the config file is already read at
   `observe.ts:459–470` / `usage.ts:167` — add one accessor).
3. **Per-OS default**:
   - win32: `%LOCALAPPDATA%\pi\exchange` via
     `join(process.env.LOCALAPPDATA ?? join(os.homedir(), "AppData", "Local"), "pi", "exchange")`.
     Rationale: per-user (no cross-user mailbox collisions on shared
     machines), durable (no reboot loss — important because Windows has no
     reboot-cleans-/tmp convention), and the Windows-conventional location.
     Tradeoff noted: on unix `/tmp/exchange` is ephemeral and the archive
     compensates; on Windows the root is durable so the archive is pure
     redundancy there — acceptable.
   - all others: `/tmp/exchange` (byte-for-byte compat — do not touch unix
     behavior in v1).
   - Never `os.tmpdir()` as the Windows default: `%TEMP%` can contain spaces
     and non-ASCII usernames and some tools sanitize it; LOCALAPPDATA is the
     convention for app data.

**Migration story for existing fleets (unix):** during a transition window,
`scanAllManifests()` scans the configured root AND the legacy `/tmp/exchange`
(when they differ), dedup by normalized `dir`; workers in the legacy root keep
working (their briefs/report paths were already written there), new tasks land
in the new root. Removal of the legacy scan is a later, separately shippable
change. On Windows there is no legacy population — no migration needed.

### 3.2 The single path-builder rule

New module `src/expaths.ts` (exchange-path builder; the ONE import of
`node:path` separators for the exchange layer):

```ts
// taskDir(root, task) → join(root, task)
// manifestPath(dir) · briefPath(dir, name) · reportPath(dir, name)
// questionPath(dir, name) · answerPath(dir, name)
// questionArchivePath(dir, name, ts)  // q-<name>.answered-<ts>.json
// nudgeFailedPath · releasePath · progressPath · teardownLogPath
// probeDir(root) · isProbeDir(dir)    // basename("_probe") compare
// taskSlug(dir)                       // basename, separator-agnostic
```

Rules:
- ALL path assembly in `src/` goes through `node:path` (`join`/`resolve`/
  `basename`) or `expaths.ts`. **Ban string-concat assembly in the seam** —
  enforced by a static pin in `test/static-check.ts` (same mechanism as the
  existing dependency-rule matcher): a regex over `src/*.ts` banning
  template literals where a `${…}` is immediately followed by `/` or
  preceded by `/` inside any expression assigned to/passed as a path, plus a
  whitelist for prose strings. The pin is what keeps the layer from rotting.
- Every `…PathFor` in `exchange.ts` becomes a one-line delegation to
  `expaths.ts` (export surface unchanged — callers untouched).
- Comparisons (`endsWith("/_probe")`, `slugOf`, worktree prefix) become
  segment-aware helpers in `expaths.ts` (`basename`-based, so separators and
  drive letters stop mattering).

### 3.3 What stays POSIX-only on Windows v1 (explicitly unsupported)

> Status note (1.17.0): the exchange/path layer above this list LANDED in
> 1.17.0; the items here did not.

- **herdr unix-socket transport**: named-pipe support is herdr's scope. The
  pi-delegate-side kill-switch `HERDR_SOCKET_TRANSPORT=cli` exists, but the
  read-only socket path itself is platform-agnostic in the code — there is NO
  automatic `cli` selection on `process.platform === "win32"`; a Windows
  deployment must either give herdr a reachable socket path or set the env
  explicitly. (Correction of the original design intent, which assumed
  auto-selection; verified against `src/herdr/host.ts` in 1.17.0.)
- **Session-file fallback munge** (`src/usage.ts`): there is no explicit
  platform gate in the code; on Windows the POSIX-shaped cwd munge simply
  finds no matching session directory and the fallback returns `[]` — the
  usage gauges degrade gracefully (they are already best-effort). Still
  pending pi's Windows session layout confirmation (§5 Phase 3).
- **SIGTERM/SIGKILL escalation** is replaced (not "unsupported") — see
  Phase 4; there is no honest "graceful SIGTERM" on Windows. (Landed in
  1.17.0: the Windows escalation is `taskkill /pid … /T /F`.)

Dependency note vs branches (historical, at design time): `exchangeRoot()`
override, the WorkerHost seam (`src/host.ts`, `src/herdr/host.ts`,
`src/host/fake.ts`) and the backend-aware manifest scan existed only on
`delegate/host-impl` then; the seam and the override are on main since 1.16.0,
and the path layer landed in 1.17.0.

---

## 4. Design: pluggable mailbox store (the forward-looking interface)

### 4.1 Honest constraint FIRST

The mailbox is read by WORKERS through filesystem paths embedded in
prompts/briefs: `q-<name>.json` / `a-<name>.json` "next to the brief"
(`src/host.ts:362–378`), and workers reply with report files at embedded
paths. Agent-side access is fs-based **by protocol** — the worker is an
arbitrary agent (any model, any harness, possibly not even pi). A DB-backed
mailbox therefore CANNOT be invisible to agents without either:

- an **agent-side shim** — a helper CLI (`pi-delegate mailbox …`) or pi
  extension tool that every worker harness must have installed, translating
  DB ops to the mailbox verbs; or
- a **hybrid** — the store keeps the DB as its system of record and MIRRORS
  the agent-facing files (workers keep using plain files; orchestrator-side
  reads/writes go through the DB).

There is no third option that preserves "any agent can participate", because
the wire format *is* the prompt text.

### 4.2 Seam shape

```ts
/** ExchangeStore — orchestrator-side durable mailbox + manifest bytes.
 *  Naming: deliberately NOT "transport" (that word is taken by the herdr
 *  pane-transport seam, src/host.ts). The store owns BYTES AT REST; the
 *  host owns PANES IN FLIGHT. */
interface ExchangeStore {
  // manifest
  readManifest(taskDir): Promise<ExchangeManifest | null>;
  updateManifest(taskDir, mutate): Promise<ExchangeManifest>; // serialized
  scanAllManifests(): Promise<ExchangeManifest[]>;
  // mailbox (per worker name within a task dir)
  postQuestion(dir, name, q: QuestionEnvelope): Promise<void>;
  postAnswer(dir, name, answer: string): Promise<void>;      // + archiveQuestion
  postSteer(dir, name, text: string): Promise<void>;
  readPendingQuestion(dir, name): Promise<QuestionEnvelope | null>;
  archiveQuestion(dir, name): Promise<void>;                 // rename → answered-<ts>
  writeRelease(dir, name): Promise<void>;
  readRelease(dir, name): Promise<ReleaseEnvelope | null>;
  readNudgeFailedMarker(dir, name): Promise<NudgeFailedEnvelope | null>;
  appendProgress(dir, name, e: ProgressEvent): Promise<void>;
  readLastProgress(dir, name): Promise<ProgressEvent | null>;
  // liveness metadata for fleet/observe (mtime semantics today)
  mailboxMtimes(dir, name): Promise<{ q?: number; a?: number }>;
}
```

Two adapters:

- **`FileStore`** — current behavior, byte-compatible: same file names, same
  envelope JSON, same atomic tmp+rename, same per-path mutation queue. Every
  existing test must pass unchanged against it (parity pin, like
  `test/host-parity-check.ts` does for hosts).
- **`SqliteStore`** (sketch, hypothetical):
  - tables: `tasks(slug TEXT PK, dir TEXT, created_at)`,
    `workers(id PK, task_id FK, name, placement_json, brief_path, report_path,
    session_path, started_at, collected_at, retired_at)` (i.e. the manifest
    rows), `questions(id PK, task_id FK, worker, ts, body, status
    open|answered|archived)`, `answers(id PK, question_id FK, ts, text)`,
    `releases(task_id, worker, ts)`, `progress(task_id, worker, ts, phase,
    pct, note)`, `markers(task_id, worker, kind, ts, payload)`;
  - the agent-side shim (only for a FULL protocol replacement, not for the
    recommended mode below) would need: `get-question <dir> <name>`,
    `post-answer`, `post-progress`, `read-answer`, `report-path` — i.e. the
    exact verbs `briefPrompt` teaches, executed against the DB. It must ship
    inside pi itself and handle version skew (a worker whose shim predates a
    schema change) — that is the real cost of this mode.

### 4.3 WHERE the seam sits — recommendation

**Recommendation: orchestrator-side only.** The store abstracts orchestrator
reads/writes; the agent-facing files REMAIN the wire format; a future
`SqliteStore` MIRRORS to the q-/a-/report files (DB = system of record, files
= rendered view). Justification:

1. **Version skew**: workers are un-upgradable ad-hoc agents spawned from
   prompts. A full protocol replacement only works when every worker harness
   has the shim — you cannot guarantee that for flash-tier one-shot workers,
   external agents, or a mixed fleet mid-rollout. File mirroring means a
   DB-backed store is deployable with ZERO worker-side changes.
2. **Cross-machine reality**: verified — no code assumes remote workers; herdr
   panes are same-machine and every path consumer is local. But the *prompt
   protocol* hard-codes co-location (paths as text). A DB does not fix that
   (the worker still needs a local path or a shim); cross-machine support is
   therefore a shim-or-nothing question regardless of the store. Keeping the
   file wire format preserves the option to later run workers on other
   machines with a shared filesystem (or a future shim) without redefining
   the mailbox.
3. **Cost**: orchestrator-side-only keeps `FileStore` byte-compatible, which
   makes the seam testable by pure parity (run the existing suite against
   both adapters). Full replacement has no cheap parity story.

Concretely: `SqliteStore.postAnswer` writes the row AND renders
`a-<name>.json`; `readPendingQuestion` reads the DB but the file is what a
worker-orchestrator (non-pi) would read. Consistency rule: the mirror is
write-through, read-DB (file may lag microseconds; tolerant reads already
cover that).

### 4.4 Interaction with the WorkerHost seam

- `host.ts` owns: place/start/prompt/waitSettle/close lifecycle, idempotent
  closes, tolerant pane reads, backend binding (`createConfiguredHost`).
- The store owns: durable bytes (manifest, mailbox, reports, progress,
  markers). The host NEVER touches mailbox files; spawn/collect/watch touch
  the store, not the FS, after this refactor.
- Shared invariants to keep across both seams: **idempotent closes**
  (host) ↔ **append-only history** (store — manifest entries never deleted,
  `retiredAt` stamps); **tolerant reads** on both sides (a missing/corrupt
  pane answer and a corrupt manifest both degrade to null, never throw).
- Naming: host adapter = "backend" (herdr/fake); store adapter = "store"
  (file/sqlite). Never reuse "transport" — it already means the pane
  transport (`src/host.ts` Transport seam) and overloading it would confuse
  the static-check dependency rules.

---

## 5. Phased implementation plan + risks

Each phase is independently shippable (suite green). Order = smallest first.

**Phase 1 — path-builder extraction (mechanical, branch-independent).**
Introduce `src/expaths.ts`; replace the ~13 concat sites (§1.2 list) with
builders; `slugOf` → `basename`; `endsWith("/_probe")` → basename compare.
Add the static pin to `test/static-check.ts` (no `${…}/` path assembly in
`src/`). Verify WITHOUT Windows: pin + existing suite + new unit tests that
feed `C:\…`-style `dir` strings into the builders and assert backslash
output (pure string asserts — pass on any OS).

**Phase 2 — root derivation + migration.**
`exchangeRoot()`: env > config key > per-OS default (§3.1). Dual-root scan in
`scanAllManifests` (configured + legacy, dedup by normalized dir). Update the
`[TEXT]` guidance strings to derive the root instead of hardcoding
`/tmp/exchange`. Verify without Windows: env/config override tests (fixtures
with `C:\exchange` as the override value — already cross-platform strings),
dual-scan dedup tests.

**Phase 3 — parsing/derivation fixes that need pi/herdr coordination.**
(a) Worktree authority prefix compare → segment-aware (pure local, testable
with fake `process.cwd()`); (b) session-munge: gate to unix on non-win32,
open a question with pi's maintainers for the Windows sessions layout (or
import pi's own resolver); (c) case-normalization at the manifest-read
boundary (normalize `dir` on read; on Windows additionally lowercase for
grouping keys). Verify without Windows: all logic is string-level; Windows
real behavior needs the host.

**Phase 4 — Windows runtime shape.**
`atomicWriteFileSync` + `spawn.ts` question-archive rename: bounded
retry/backoff on `EPERM/EBUSY`; `runHerdr` escalation: platform switch
(POSIX SIGTERM/SIGKILL as-is; win32 `taskkill /pid X /T /F`); herdr CLI
resolution on win32 (`.cmd` shim handling). Verify WITHOUT Windows: retry
logic via injected failure injection (simulate EPERM); escalation via the
existing `test/transport-sigkill.ts` pattern on unix. Windows-real: manual
QA.

**Phase 5 — ExchangeStore seam.**
Extract the interface (§4.2); make `FileStore` the default; route
spawn/observe/fleet/index through it; add a store-parity check (run the
mailbox/manifest tests against both adapters, like `host-parity-check.ts`).
No behavior change. Fully verifiable without Windows.

**Phase 6 — SqliteStore (optional/future).**
Orchestrator-side DB with write-through file mirroring (§4.3). Ship behind a
config key; the parity suite doubles as its conformance suite. Only after
Phase 5 has been stable for a release.

**Windows-property tests runnable everywhere** (Phase 1–2 deliverables):
fixtures with `C:\`, `\\server\share\`, drive-letter case variants, 300-char
paths; property: for every builder output, `output.split(sep)` segments have
no empty middle members and re-joining round-trips; property: no
`src/*.ts` file (outside `expaths.ts`/whitelisted prose) contains `${…}/`
path assembly (the pin).

**Manual QA checklist (needs a real Windows host)**:
1. bun + pi + herdr installed; `herdr` resolvable from `spawn` (`.cmd` shim).
2. Probe spawn: `delegate` with mode `probe` — reply "OUTPUT: OK" readback.
3. Full delegation: brief → worktree worker → report collect → archive in
   `%USERPROFILE%\.pi\agent\delegate-archive`.
4. Mailbox round trip: worker `q-*.json` → `delegate_mailbox answer` → worker
   sees `a-*.json`; question archived (`answered-<ts>` rename survives
   Defender scanning).
5. Watcher: report-ready wake, retire ACK close, no duplicate wakes after
   watcher restart (collectedAt dedup).
6. Long-path run: exchange root under a long username; report path > 200
   chars.
7. `HERDR_SOCKET_TRANSPORT=cli` on Windows; confirm no socket code path is
   entered.
8. Worktree authority: sub-orchestrator cwd under `…\.herdr\worktrees\…`
   detected as `sub` (tab-only placement).
9. Case check: brief path typed with different drive-letter case than the
   env root — E_BRIEF must not false-fire.
10. `delegate-fleet` grouping with two task dirs differing only by case
    (should collapse to one group).

**Top risks**: (a) pi's Windows session layout unknown (Phase 3 dependency —
degrade gracefully meanwhile); (b) herdr named-pipe support undefined
(herdr scope; CLI mode is the bridge); (c) rename-retry can mask genuine
races — cap retries low (≤5, ≤250 ms total) and keep the failure surfaced;
(d) the store seam (Phase 5) touches the hottest files (`spawn.ts`,
`exchange.ts`) — land it as pure extraction with parity pins, no drive-by
fixes.
