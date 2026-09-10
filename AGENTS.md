# ai-sandbox — repo instructions

## Workflow — trunk-based development (TBD)

`main` is the trunk: always green, always releasable. **No direct commits to
`main`** (the only exception: bootstrap/meta commits that establish these
rules themselves). All work happens in short-lived branches:

- `feature/<topic>` — new behavior,
- `fix/<topic>` — bug fixes.

Merge to `main` **only via PR, squash-merge only** (one clean commit per
PR; the branch dies after the merge). CI gates every PR (bun check suite +
package.json version sync). History rewrites of `main` are FORBIDDEN — the
one-time NDA scrub (orphan squash, 2026-09) was an explicit operator
exception and sets no precedent.

## Release command

When the user says **"release"** (in this repo), run the release ritual — no
further confirmation needed.

**Gate first — what is actually being released.** Diff the last release
commit against HEAD and look at WHAT changed:

- **Application changes** (anything under `pi/extensions/pi-delegate/src`,
  `test`, `index.ts`, skills/bundle manifest, root `package.json`) → full
  ritual below.
- **Docs / repo-meta only** (`AGENTS.md`, `README*`, prose `*.md`, scratch
  files) → **NO version inc, NO changelog** — the application did not
  change. Report "nothing to release" and stop.

Full ritual (TBD edition — release is a PR, not a push):

1. **Branch** `feature/release-x.y.z` from `main`.
2. **Inc version** in BOTH files — they ship together and must never diverge:
   - `pi/extensions/pi-delegate/package.json`
   - `package.json` (bundle root)
   Bump level follows the changelog content: new behavior → minor (`1.x.0`),
   fixes only → patch (`1.14.x`).
3. **Changelog**: prepend a `## [x.y.z] — YYYY-MM-DD` section to
   `pi/extensions/pi-delegate/CHANGELOG.md` (Keep a Changelog format; the
   section covers exactly the changes going out in this release).
4. **Commit, push the branch, open a PR** into `main`, let CI pass, then
   **squash-merge**.
5. **Tagging is CI's job, not yours**: the release workflow on `main` reruns
   the suite, sees the version is higher than the latest `v*` tag, creates
   the semver tag `v{x.y.z}` and a GitHub Release whose notes come from the
   fresh CHANGELOG section. If the version was not bumped, no tag is
   created (safe default — the merge just lands without a release).

Never open a release PR with uncommitted unrelated changes mixed into the
release commit — park them in a separate commit first. A mistaken release
is corrected by a forward `git revert` (via its own `fix/` PR), never a
force-push.

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
 * Schedules delegate worker spawns and collects their reports.
 * <p>
 * MODULE_CONTRACT: spawn/settle/report lifecycle for pi-delegate workers.
 * Dependencies: herdr socket API (panes), exchange dir on disk (briefs,
 * manifests, reports).
 * Critical invariants: one report file per worker; manifest entries are
 * never removed while a pane may still be live.
 */
import { ... } from "...";

/**
 * Spawns one worker pane and waits for its report.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - name: worker name, matches [a-z][a-z0-9_-]{0,31}, unique among live
 *     workers
 *   - briefPath: path to an existing brief file under /tmp/exchange/<task>/
 * Output: the worker's validated report (parsed JSON)
 * Guarantees:
 *   - the report is schema-validated before being returned
 *   - the manifest entry exists while the pane may still be live
 * Raises:
 *   - E_START if herdr cannot start the agent (name taken, no pane)
 *   - E_REPORT_INVALID if the report fails schema validation
 */
export async function spawnWorker(name: string, briefPath: string) {
  // EXTERNAL_DEPENDENCY: HERDR socket at $HERDR_SOCK (herdr agent prompt)
  const sock = process.env.HERDR_SOCK;
  // ...
}
```
