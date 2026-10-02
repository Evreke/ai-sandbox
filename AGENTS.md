# ai-sandbox — repo instructions

## Workflow — develop-based flow

`main` is the stable branch: it reflects the state of every artifact that is
published and usable. `develop` is the working branch: **all changes land on
`develop` first**. `main` is updated from `develop` when an artifact reaches
a releasable state — via PR (`develop` → `main`), squash-merge only.

- Work directly on `develop`, or in short-lived `feature/<topic>` /
  `fix/<topic>` branches cut from fresh `develop`.
- `main` is protected by the `trunk` ruleset: PR required, linear history,
  no force-push, no deletion.
- History rewrites of `main` are forbidden; the 2026-10 fresh start was an
  explicit operator exception and sets no precedent.

## Versioning — per-artifact CHANGELOG, no git tags

The repo does not use git tags. Every artifact under `pi/extensions/` carries
its own `CHANGELOG.md` (Keep a Changelog format); the CHANGELOG version IS the
artifact's version and travels with it (the npm package version equals the
CHANGELOG version). The git history does not encode releases.

## No CI

There is no CI in this repo. "Always green" is enforced by convention — run
the relevant checks locally before pushing to `develop` or merging into
`main`.

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
