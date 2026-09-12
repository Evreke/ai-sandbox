/**
 * Shared herdr-fixture hygiene helpers for the REAL-herdr QA checks
 * (transport-contract.ts, host-parity-check.ts).
 * <p>
 * MODULE_CONTRACT: this module exists because a fixture-leaking incident
 * (2026-09) accumulated 32 ghost herdr workspaces (tabs pointing at deleted
 * /tmp fixture repos, rendered as "(deleted)") and 332 orphan dirs under
 * ~/.herdr/worktrees/: run-checks.sh kills every check with `timeout 30`,
 * and on SIGTERM death a JS `finally` block never runs — signal death is not
 * an exception path. Two layers close that hole:
 *   1. sweepStaleHerdrFixtures — best-effort removal of LEFTOVER state from
 *      previous crashed/killed runs, executed at the top of each herdr-backed
 *      test before any new fixture is created;
 *   2. installSignalCleanup — a bounded SIGTERM/SIGINT handler so the tests'
 *      own cleanup DOES run when the runner kills the process mid-flight.
 * Dependencies: herdr CLI on PATH (`workspace list`, `worktree remove`,
 * `workspace close`), the ~/.herdr/worktrees/ directory layout, the herdr
 * result parser from ../src/herdr/host.ts.
 * Critical invariants:
 *   - the sweep NEVER throws: every failure is collected in `failed` and the
 *     suite stays green on hosts without herdr (same skip contract as the
 *     transport-contract herdr-absence gate);
 *   - every herdr subprocess call is individually bounded by a timeout, so a
 *     hanging herdr CLI cannot wedge either the sweep or the dying process;
 *   - the signal handler is installed at most ONCE per process and is
 *     guarded against re-entry (a second signal during cleanup is ignored).
 * Note: this file's name contains "fixture" — test/run-checks.sh skips
 * *fixture* files as standalone checks. This is a helper, not a test.
 */

import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseHerdrResult } from "../src/herdr/host.ts";

const execFileP = promisify(execFile);

/** Hard bound for every single herdr subprocess call (a hanging herdr CLI must not wedge the sweep or a dying process). */
const HERDR_CALL_TIMEOUT_MS = 15_000;

/** Minimal shape of one `herdr workspace list` record this module reads (tolerant: herdr has renamed fields before). */
interface HerdrWorkspaceRecord {
	workspace_id?: string;
	id?: string;
	label?: string;
	worktree?: { checkout_path?: string };
}

/**
 * List herdr workspaces as tolerant records.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none (talks to the real herdr CLI; EXTERNAL_DEPENDENCY: herdr on PATH)
 * Output: array of workspace records (possibly empty on any parse surprise)
 * Guarantees:
 *   - bounded by HERDR_CALL_TIMEOUT_MS — never hangs forever;
 *   - returns [] instead of throwing on unparsable output (tolerant reader).
 * Raises:
 *   - propagates spawn failures (binary missing, timeout) to the caller.
 */
async function listHerdrWorkspaces(): Promise<HerdrWorkspaceRecord[]> {
	const { stdout } = await execFileP("herdr", ["workspace", "list"], { encoding: "utf8", timeout: HERDR_CALL_TIMEOUT_MS });
	const { result } = parseHerdrResult(stdout);
	const list = Array.isArray(result) ? result : (result as { workspaces?: unknown[] } | null)?.workspaces ?? [];
	return list as HerdrWorkspaceRecord[];
}

/**
 * Does this workspace record match a stale fixture for one of the prefixes?
 * <p>
 * A workspace is stale when EITHER its checkout_path contains one of the
 * fixture prefixes (the worktree herdr created from a throwaway /tmp fixture
 * repo — herdr derives the checkout dir name from the repo name, so the
 * mkdtemp prefix shows up in the path) OR its label is suffixed "(deleted)"
 * and the label text contains one of the prefixes (herdr keeps a shell
 * workspace whose backing dir was deleted; its checkout_path is gone but the
 * label still names the dead path).
 */
function matchesStaleFixture(w: HerdrWorkspaceRecord, prefixes: readonly string[]): boolean {
	const checkoutPath = w.worktree?.checkout_path ?? "";
	const label = w.label ?? "";
	const deletedSuffix = "(deleted)";
	const deletedLabel = label.endsWith(deletedSuffix) ? label.slice(0, label.length - deletedSuffix.length) : "";
	return prefixes.some((p) => checkoutPath.includes(p) || (deletedLabel !== "" && deletedLabel.includes(p)));
}

/**
 * Sweep leftover herdr state from previous crashed/killed fixture runs.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: prefixes — the mkdtemp fixture prefixes (e.g. "qa-t2-repo-") whose
 *   workspaces/dirs count as stale fixture state
 * Output: { closed, failed } — closed: workspace ids (and orphan dir paths)
 *   successfully cleaned; failed: workspace ids / dir paths that could not be
 *   cleaned (each individual herdr call is bounded; failures are collected,
 *   never thrown)
 * Guarantees:
 *   - NEVER throws — any unexpected error (herdr missing, unparsable list,
 *     unreadable worktrees dir) is swallowed and reported via `failed` or an
 *     empty result, so the calling test stays green on herdr-less hosts;
 *   - closes stale workspaces best-effort: `herdr worktree remove --force`
 *     first, then `herdr workspace close` (herdr may keep a non-linked shell
 *     after the remove — the close handles shells, same two-step shape as the
 *     tests' own forceCleanup fallbacks);
 *   - after the closes, removes orphan fixture dirs: directories DIRECTLY
 *     under ~/.herdr/worktrees/ whose name starts with one of the prefixes
 *     and which are no longer the registered checkout root of ANY listed
 *     workspace (the re-list after the closes guarantees just-closed
 *     fixtures' dirs count as orphans); a re-list failure SKIPS the orphan
 *     pass entirely (conservative — never rm without fresh registration data);
 *   - every herdr subprocess call is individually bounded by
 *     HERDR_CALL_TIMEOUT_MS.
 * Raises:
 *   - nothing (never throws; see Guarantees).
 */
export async function sweepStaleHerdrFixtures(prefixes: readonly string[]): Promise<{ closed: string[]; failed: string[] }> {
	const closed: string[] = [];
	const failed: string[] = [];
	try {
		// Herdr-absence gate (transport-contract shape): silently skip on hosts
		// without the binary — the suite must stay green there.
		await execFileP("herdr", ["--version"], { encoding: "utf8", timeout: HERDR_CALL_TIMEOUT_MS });

		const list = await listHerdrWorkspaces();
		const staleIds = list
			.filter((w) => matchesStaleFixture(w, prefixes))
			.map((w) => w.workspace_id ?? w.id)
			.filter((id): id is string => !!id);
		for (const id of staleIds) {
			let removed = true;
			try {
				await execFileP("herdr", ["worktree", "remove", "--workspace", id, "--force"], { encoding: "utf8", timeout: HERDR_CALL_TIMEOUT_MS });
			} catch {
				removed = false; // fall through — the workspace-close pass still runs (shell cleanup).
			}
			try {
				await execFileP("herdr", ["workspace", "close", id], { encoding: "utf8", timeout: HERDR_CALL_TIMEOUT_MS });
				closed.push(removed ? id : `${id} (closed; worktree remove failed)`);
			} catch {
				failed.push(id);
			}
		}

		// Orphan-dir pass — only with a FRESH registration list (never rm based
		// on stale data).
		let registeredPaths: string[];
		try {
			registeredPaths = (await listHerdrWorkspaces())
				.map((w) => w.worktree?.checkout_path ?? "")
				.filter((p) => p.length > 0);
		} catch {
			return { closed, failed }; // conservative: cannot verify registration → do not rm anything
		}
		const worktreesRoot = join(homedir(), ".herdr", "worktrees");
		let entries: string[];
		try {
			entries = readdirSync(worktreesRoot);
		} catch {
			return { closed, failed }; // no worktrees dir (or unreadable) — nothing to sweep
		}
		for (const entry of entries) {
			if (!prefixes.some((p) => entry.startsWith(p))) continue;
			const dir = join(worktreesRoot, entry);
			// "registered worktree of a listed workspace": any listed checkout_path
			// inside this dir means a LIVE workspace still owns it — skip.
			const registered = registeredPaths.some((cp) => cp === dir || cp.startsWith(dir + "/"));
			if (registered) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
				closed.push(dir);
			} catch {
				failed.push(dir);
			}
		}
	} catch {
		// herdr binary unavailable (or any other unexpected failure) — the skip
		// contract: silent no-op, empty result.
	}
	return { closed, failed };
}

/**
 * Install a bounded SIGTERM/SIGINT cleanup handler (ONE registration per process).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: cleanup — the test's idempotent module-scope cleanup function (the
 *   same one the normal-path `finally` calls); hardExitMs — the hard ceiling
 *   for the async cleanup (default 15000 ms)
 * Output: void (registers process signal handlers)
 * Guarantees:
 *   - registers at most ONE handler per signal per process (module-scope
 *     re-registration guard) and guards against re-entry: a second SIGTERM
 *     while cleanup is running is ignored, not queued;
 *   - the cleanup runs bounded: a hard-exit timer (hardExitMs) force-exits
 *     the process with 128+signal even if a herdr call inside the cleanup
 *     hangs; the timer is cleared when the cleanup completes;
 *   - after cleanup the process exits with 128+signal (the conventional
 *     shell convention for signal death);
 *   - GNU `timeout` sends SIGTERM and then WAITS INDEFINITELY for the child
 *     to exit — so a bounded async cleanup genuinely gets its window before
 *     the process dies; that is why this handler fixes the run-checks.sh
 *     `finally`-never-runs leak.
 * Raises:
 *   - nothing (cleanup rejections are swallowed after the hard exit is armed).
 */
export function installSignalCleanup(cleanup: () => Promise<void>, hardExitMs = 15_000): void {
	const installed = (installSignalCleanup as unknown as { __installed?: boolean }).__installed;
	if (installed) return;
	(installSignalCleanup as unknown as { __installed?: boolean }).__installed = true;

	// Exit codes follow the shell convention: 128 + signal number
	// (SIGTERM=15 → 143, SIGINT=2 → 130).
	const exitCodeBySignal: Record<string, number> = { SIGTERM: 143, SIGINT: 130 };
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			const code = exitCodeBySignal[signal] ?? 143;
			// Re-entry guard: a repeated signal while the cleanup below is in
			// flight must not start a second cleanup (module-scope flag).
			if ((installSignalCleanup as unknown as { __running?: boolean }).__running) return;
			(installSignalCleanup as unknown as { __running?: boolean }).__running = true;
			// BUG_FIX_CONTEXT (run-checks timeout leak, incident 2026-09): GNU
			// `timeout` signals the whole process GROUP — the test's in-flight
			// herdr CLI children die of SIGTERM too, and the transport's pending
			// op rejects. That rejection surfaces as an uncaught error and bun
			// crashes BEFORE the async cleanup below can finish (observed: 2
			// fixture workspaces left behind by a mid-flight kill). Symptom → the
			// `finally`-extracted cleanup never got its window. Why the handler
			// alone did not work: the crash beats the cleanup's awaited herdr
			// calls. What was done: once a signal is being handled, swallow
			// uncaughtException/unhandledRejection — the process is dying with
			// 128+signal anyway (exit status is unchanged, so the normal-path
			// FAIL semantics are untouched; without a signal no handler exists
			// and genuine test crashes still fail the run).
			const swallow = (err: unknown) => {
				console.error(`NOTE  signal-cleanup swallowed uncaught error: ${(err as Error)?.message ?? err}`);
			};
			process.on("uncaughtException", swallow);
			process.on("unhandledRejection", swallow);
			void (async () => {
				const hardExit = setTimeout(() => process.exit(code), hardExitMs);
				try {
					await cleanup();
				} catch {
					/* best-effort — the hard exit below still terminates cleanly */
				}
				clearTimeout(hardExit);
				process.exit(code);
			})();
		});
	}
}
