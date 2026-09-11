/**
 * pi-delegate — fs-probe: the ONE implementation of the tolerant filesystem
 * probes (Wave 3, step 5 — audit finding 7: the isFile/mtimeOf-style
 * wrappers were duplicated across modules with the same "missing/unreadable
 * degrades, never throws" contract). Every probe is read-only and advisory:
 * an absent or unreadable path yields the probe's empty answer (null / 0 /
 * false), never a throw — observation code (watcher, fleet UI, status tool)
 * is advisory by contract and must never fail on a vanished file.
 * <p>
 * MODULE_CONTRACT: leaf module — node:fs only, no project imports.
 * Consumers: watch-detect.ts / watch-retire.ts (fileMtimeMs — report,
 * answer, release mtimes), fleet.ts (mtimeOf — overlay mailbox cell;
 * fileExists — report presence), spawn.ts (fileExists — the grace loop's
 * reportExists injection).
 */

import { statSync } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * File mtime in ms, or null when missing/unreadable (sync probe).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — any filesystem path
 * Output: the file's mtimeMs, or null when stat fails (absent/unreadable)
 * Guarantees: tolerant — never throws; read-only
 * Raises: never
 */
export function fileMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * File mtime in ms, or 0 when missing/unreadable (async probe — the fleet
 * overlay's row-model tolerance). Derived from fileMtimeMs: the tolerance
 * decision (missing → empty answer, never a throw) is single-sourced there;
 * this wrapper only remaps the sentinel (0 instead of null) for callers
 * that compare mtimes arithmetically.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — any filesystem path
 * Output: the file's mtimeMs, or 0 when stat fails
 * Guarantees: tolerant — never throws; read-only
 * Raises: never
 */
export async function mtimeOf(path: string): Promise<number> {
	return fileMtimeMs(path) ?? 0;
}

/**
 * File existence probe: true when stat succeeds, false on any error (async).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — any filesystem path
 * Output: true iff the path stats successfully
 * Guarantees: tolerant — never throws; read-only (the single implementation
 *   behind spawn's reportExists grace-loop injection and fleet's
 *   report-presence column)
 * Raises: never
 */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
