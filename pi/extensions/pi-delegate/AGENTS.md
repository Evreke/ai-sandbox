# pi-delegate — agent glossary

> **Binding constitution.** `ARCHITECTURE.md` (in this directory) binds every
> agent that touches this extension; its ten laws are the binding layer for
> all work on the codebase. Where ARCHITECTURE.md and the prose conventions in
> this file conflict, ARCHITECTURE.md outranks them.

## Documentation — closed set (operator law)

Documents are read by agents: they cost tokens and rot. The extension's documentation is a CLOSED set — behavior truth lives in code:

- **ZSDoc in code** (MODULE_CONTRACT / FUNCTION_CONTRACT / BUG_FIX_CONTEXT at the point of use) — the primary truth about behavior.
- **ARCHITECTURE.md** — the strict guideline: binding rules and their enforcement, no behavioral narrative.
- **README.md** — what the extension is, how to install and configure it, operational notes. Nothing else.
- **CHANGELOG.md** — release history (Keep a Changelog; released sections immutable).

Everything else is garbage — do NOT create it in this repo: no plans, TL;DRs, acceptance records, session instructions, stage guides, notes, design logs/chronicles or decision archaeology. Agent-to-agent artifacts (briefs, reports, plans) go to the exchange dir, never the repo. Documents carry ONLY current truth and plans: no rejected approaches, no interim states, no who-decided-what — history lives in git commits and CHANGELOG. Do not write rottable status prose into living docs; prefer the code's own state. A new `.md` file requires the operator's explicit decision.

One rule: **"worktree" names the isolation mechanism, "checkout" names the path.** They are complementary, never synonyms — code pairs them deliberately (`Placement.kind: "worktree"` carries a `checkoutPath`).

## Terms

- **git worktree** — git's native extra-checkout of one repo (registered in `.git/worktrees/`, has a branch). No herdr involvement. Do not confuse with a herdr workspace.
- **wt-workspace** — a herdr workspace whose cwd is backed by a git worktree: what `herdr worktree create`/`open` makes and what `Placement.kind === "worktree"` means. Has a tab + root pane; a bare git worktree has no herdr UI presence at all.
- **master checkout** — the repo's main checkout (herdr's `repo_root`, the source-of-truth for `--cwd`). herdr refuses a *linked* worktree as a `--cwd` source (`not_linked_worktree` guard) — master only.
- **checkout / `checkoutPath`** — the directory an agent runs in. A wt-workspace has its own; a `tab` shares the orchestrator's. Never use "checkout" as a name for the placement kind.
- **repo group** — herdr's UI grouping of workspaces by `repo_key`: one git repo → one tree in the sidebar (master = tree node, wt-workspaces = its leaves). Not parent/child — herdr has no workspace hierarchy; the tree is render-time derivation from `repo_key` + `is_linked_worktree`, and `repo_key` is the ONLY grouping mechanism (operator-verified 2026-09-07).
- **leaf** — a wt-workspace nested under an orchestrator's worktree (planned; not yet implemented). Nested leaves need `--cwd <master-root> --path <orchestrator-wt>/<name>`. UI-wise every wt-workspace of the repo is already a leaf of the repo tree.
- **WorkerHost** — the backend-neutral seam every tool talks to; the seam type is `Transport` in `src/host.ts`. **host** — the configured backend implementation, chosen ONCE in `index.ts` from the config's `"host"` key (default `"herdr"`). **backend** — the `placement.backend` tag persisted in manifest records (`"herdr"` / `"fake"`), alongside the legacy id fields. **placementRef** — the opaque, adapter-defined placement handle (`herdr:pane:<id>` / `fake:<n>`): only the owning adapter decodes it; no raw backend id crosses the seam. Behavioral truth lives in the `src/host.ts` and `src/herdr/host.ts` module contracts.

## Authority model

- Session cwd outside `~/.herdr/worktrees/` → **root orchestrator**: may place/teardown wt-workspaces.
- Session cwd inside a wt-workspace → **sub-orchestrator**: worktree placement/teardown rejected (transport guards); tabs only.
- Guard lives in the herdr adapter `src/herdr/host.ts` (`capabilities()`, `isSubOrchestratorCwd()`, `placeInner()`, `teardownInner()`).

## Frozen surface — never rename

True INSIDE the herdr adapter (`src/herdr/host.ts`); the seam above it is backend-neutral. `herdr worktree <verb>` CLI strings · herdr JSON fields (`workspace.worktree.*`, `is_linked_worktree`) · `not_linked_worktree` token · manifest `kind: "worktree"` value · journal events (`delegate-fleet`, `spawn`/`collect`) · `/delegate-*` command names · tool names/params.

The word "worktree" appears in several syntactic positions (placement kind value, physical dir, herdr CLI verb, herdr JSON fields) — one concept, four vantage points, each unambiguous by position (census 2026-09-07: zero genuine overloads). Keep the word; disambiguate with the terms above when writing prose.
