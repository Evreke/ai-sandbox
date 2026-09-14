# ai-sandbox — repo instructions

## pi-delegate moved out

pi-delegate lives in its own standalone repository now:
**https://github.com/Evreke/delegate** (extracted from this repo, 2026-09).
All pi-delegate work — extension code, tests, docs, releases — happens there
and is bound by that repo's own constitution (`AGENTS.md` + `ARCHITECTURE.md`
inside it; ten laws, details and enforcement in the documents themselves).
This repo keeps no copy of it: one artifact, one source of truth.

## Workflow — trunk-based development (TBD)

`main` is the trunk: always green. **No direct commits to `main`** (the only
exception: bootstrap/meta commits that establish these rules themselves). All
work happens in short-lived branches:

- `feature/<topic>` — new behavior,
- `fix/<topic>` — bug fixes.

Merge to `main` **only via PR, squash-merge only** (one clean commit per
PR; the branch dies after the merge). History rewrites of `main` are FORBIDDEN — the
one-time NDA scrub (orphan squash, 2026-09) was an explicit operator
exception and sets no precedent.

There is no CI in this repo: the workflows it used to have gated pi-delegate
and moved out with it (grill-deck was never gated). "Always green" is
enforced by convention — run the relevant checks locally before merging a PR.

## Zero-Context Survival (self-sufficient files) — MANDATORY for production code

Scenario: an agent loads a single file and reads it. No chat history, no
previous files.

Scope: production `.ts` code under `pi/extensions/` (extension `src/`
directories, `index.ts`, `lib.ts`). Out of scope: tests (`*.test.ts`,
`test/`, `*-check.ts`, fixtures), generated code, prose docs. Covers new and
modified files.

1. **MODULE_CONTRACT** — file-level JSDoc block at the top of the file (above
   imports): what the module does, its external dependencies, critical
   invariants.
2. **FUNCTION_CONTRACT** — inside the function's JSDoc, for every significant
   function (exported + significant non-exported; trivial getters/one-liners
   excluded). Sections: `Input` / `Output` / `Guarantees` / `Raises`.
3. **BUG_FIX_CONTEXT** — where needed: any non-obvious fix (races, operation
   order, data protection). Format: symptom → why the old solution did not
   work → what was done. Placed as a comment at the fix site.
4. **EXTERNAL_DEPENDENCY** — if a function depends on something outside this
   module (env variable, config file, socket/socket-API, filesystem path,
   downstream process), state it explicitly at the point of use
   (`process.env.X`, config read, IPC/API call), not only in the module
   header.

Contracts live in JSDoc and must not break TypeScript compilation or the
repo's checks; keep them syntactically valid JSDoc (plain prose inside, no
annotations required).

Skeleton:

```ts
/**
 * Renders interactive question decks and collects structured answers.
 * <p>
 * MODULE_CONTRACT: deck lifetime — build, present, collect answers.
 * Dependencies: TUI components, exchange dir on disk (deck state files).
 * Critical invariants: one answers file per deck; a deck is never mutated
 * after presentation begins.
 */
import { ... } from "...";

/**
 * Presents one deck and blocks until the user answers every question.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - questions: non-empty array; every question has a stable id unique
 *     within the deck
 * Output: the collected answers, keyed by question id, DEFERRED marks
 *   preserved
 * Guarantees:
 *   - the answers file is written before the call returns
 *   - re-presentation after a crash resumes from the persisted state
 * Raises:
 *   - E_INVALID_DECK if two questions share an id or the array is empty
 */
export async function presentDeck(questions: Question[]) {
  // EXTERNAL_DEPENDENCY: deck state dir at $DECK_STATE_DIR (filesystem)
  const stateDir = process.env.DECK_STATE_DIR;
  // ...
}
```
