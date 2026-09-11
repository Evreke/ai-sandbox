# pi-delegate — agent glossary

> **Binding constitution.** `ARCHITECTURE.md` (in this directory) binds every
> agent that touches this extension; the ten laws there are the layer above
> DESIGN.md. Where ARCHITECTURE.md and the prose conventions in this file or in
> DESIGN.md conflict, ARCHITECTURE.md outranks them.

Vocabulary for this extension. One rule: **"worktree" names the isolation mechanism, "checkout" names the path.** They are complementary, never synonyms — code pairs them deliberately (`Placement.kind: "worktree"` carries a `checkoutPath`).

## Terms

- **git worktree** — git's native extra-checkout of one repo (registered in `.git/worktrees/`, has a branch). Exists with no herdr involvement. Do not confuse with a herdr workspace.
- **wt-workspace** — a herdr workspace whose cwd is backed by a git worktree. What `herdr worktree create`/`worktree open` makes and what `Placement.kind === "worktree"` means. Always has a tab + root pane; an agent occupies the pane only after `agent start`. A bare git worktree (plain `git worktree add`) has no herdr UI presence at all.
- **master checkout** — the repo's main checkout (herdr's `repo_root` / source-of-truth for `--cwd`). herdr refuses a *linked* worktree as a `--cwd` source (`not_linked_worktree` guard) — master only.
- **checkout / `checkoutPath`** — the directory an agent runs in. A wt-workspace has its own; a `tab` shares the orchestrator's. Never use "checkout" as a name for the placement kind.
- **repo group** — herdr's UI grouping of workspaces by `repo_key` (one git repo → one tree in the sidebar). Spans master + all its wt-workspaces, nested or flat. Not a parent/child concept — herdr has no workspace hierarchy in its data model; the tree is render-time derivation from `repo_key` + `is_linked_worktree` (operator-verified in UI 2026-09-07: the master workspace is the tree node, wt-workspaces render as its leaves; a leaf workspace cannot be mouse-dragged out of the tree, the master workspace can). `repo_key` is the ONLY grouping mechanism: plain workspaces with identical cwd and label stay separate sidebar rows (operator-verified 2026-09-07 with two identical non-worktree workspaces).
- **leaf** — a wt-workspace placed under an orchestrator's worktree in a nested topology (planned; not yet implemented). Physically nested leaves require `--cwd <master-root> --path <orchestrator-wt>/<name>`. UI-wise every wt-workspace of the repo is already a leaf of the repo tree — no group creation exists or is needed.

## WorkerHost / host / backend (workerhost inversion, DESIGN.md §24)

- **WorkerHost** — the backend-neutral seam every tool talks to; the seam
  type is `Transport` in `src/host.ts` (historical name, frozen methods).
  Places workers (worktree/tab), starts/prompts/settles/tears them down, and
  reports status through an opaque **placementRef** — never backend ids.
- **host** — the configured backend implementation ("which WorkerHost is
  bound"). Chosen ONCE in index.ts from the config's `"host"` key
  (default `"herdr"`; unknown value → structured error). Currently:
  `herdr` (real) and `fake` (in-memory, tests).
- **backend** — the `placement.backend` tag persisted in manifest records
  (`"herdr"` / `"fake"`), written ALONGSIDE the legacy id fields. The
  watcher's manifest scan skips entries whose backend names another host —
  a fake fixture can never wake a herdr session (fail-open for legacy
  entries without a backend).
- **placementRef** — opaque, adapter-defined, unique per live placement
  (`herdr:pane:<paneId>` / `fake:<n>`). Only the owning adapter decodes it;
  everything else does opaque equality matching.

## Authority model

- Session cwd outside `~/.herdr/worktrees/` → **root orchestrator**: may place/teardown wt-workspaces.
- Session cwd inside a wt-workspace → **sub-orchestrator**: worktree placement/teardown rejected (transport guards); tabs only.
- Guard lives in the herdr adapter `src/herdr/host.ts` (`capabilities()`, `isSubOrchestratorCwd()`, `placeInner()`, `teardownInner()`).

## Frozen surface — never rename

Frozen surface note: everything below stays true INSIDE the herdr adapter (`src/herdr/host.ts`); the seam above it is backend-neutral.

`herdr worktree <verb>` CLI strings · herdr JSON fields (`workspace.worktree.*`, `is_linked_worktree`) · `not_linked_worktree` token · manifest `kind: "worktree"` value · journal events (`delegate-fleet`, `spawn`/`collect`) · `/delegate-*` command names · tool names/params.

The word "worktree" appears in several syntactic positions (placement kind value, physical dir `/root/.herdr/worktrees`, herdr CLI verb, herdr JSON fields). These are one concept seen from four vantage points, each unambiguous by position — a census (2026-09-07) found zero genuine overloads. Keep the word; disambiguate with the terms above when writing prose.
