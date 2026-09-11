
/**
 * pi-delegate — report archive (DESIGN.md §19.3).
 *
 * MODULE_CONTRACT — the durable report archive.
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A6 (impl-settle). Worker B6 imports, never edits this file.
 *
 * Purpose: collected reports are mirrored OUT of /tmp (which dies on
 * reboot — a field task lost every artifact of three phases) into
 * ~/.pi/agent/delegate-archive/<task>/; retention TTL pruning and the
 * archived-task listing live here too.
 *
 * Dependencies: pi's getAgentDir(), node builtins, and the ONE shared
 * atomic writer (atomicWriteFileSync) — extracted from src/exchange.ts in
 * Wave 3a (audit: the archive's only coupling to the remainder). The
 * writer temporarily lives HERE until the manifest-store module lands in
 * the next commit, then moves there and this module imports it — ONE
 * implementation only, never two.
 *
 * Critical invariants: archive is best-effort by contract — any failure →
 * null/0/[] — never throws past its callers.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Atomic file write (tmp + rename) — the ONE shared writer protocol of the
 * exchange layer (moved verbatim from src/exchange.ts in Wave 3a).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — the target file path; content — the full file content
 * Output: none (the file at `path` holds `content`)
 * Guarantees:
 *   - atomic: content lands via tmp file + rename (atomic on the same
 *     filesystem); a concurrent reader never sees a half-written file
 * Raises:
 *   - propagates filesystem errors (callers decide tolerance)
 */
export function atomicWriteFileSync(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path); // rename is atomic on the same filesystem
}

/** Absolute archive root.
 * <p>
 * EXTERNAL_DEPENDENCY: pi's getAgentDir() (honors PI_CODING_AGENT_DIR) — the
 * archive lives at <agentDir>/delegate-archive/, OUTSIDE /tmp (which dies on
 * reboot; see the module header's durability note).
 * BUG_FIX_CONTEXT (Windows HOME misdirection): symptom — on Windows a
 * POSIX-style $HOME (some environments set it) silently redirected the
 * archive outside the real profile. Why the old code failed: HOME-first
 * lookup is a Unix convention, os.homedir() (USERPROFILE) is the Windows
 * truth. Fix: pi's getAgentDir() resolves from os.homedir() on every
 * platform (the Windows truth) — the HOME-misdirection class is gone by
 * construction; in the default environment the resolved path is identical
 * to the old $HOME/.pi/agent/delegate-archive.
 */
export function archiveRoot(): string {
	return path.join(getAgentDir(), "delegate-archive");
}

/**
 * Archive one collected report: copy source →
 * <archiveRoot>/<task>/<basename of reportPath> (basename preserved AS-IS —
 * no "report-" prefix; R6 fix: collected reports are already named
 * report-<worker>.json, a prefix here double-prefixed them), and (re)write
 * <archiveRoot>/<task>/manifest.json from the given manifest object.
 * Best-effort by contract: return the archive report path on success,
 * null on ANY failure (caller shows a warning, never an error).
 */
export function archiveReport(
	taskDir: string,
	reportPath: string,
	manifest: Record<string, unknown>,
): string | null {
	try {
		const task = path.basename(taskDir);
		if (task.length === 0) return null;
		const dir = path.join(archiveRoot(), task);
		fs.mkdirSync(dir, { recursive: true });

		const reportName = path.basename(reportPath);
		if (reportName.length === 0) return null;
		const dest = path.join(dir, reportName);
		fs.copyFileSync(reportPath, dest);

		// Manifest snapshot: atomic tmp+rename so a concurrent reader never
		// observes a half-written manifest.json. Migration stage 2 (audit step 5):
		// the archive path's SECOND hand-rolled atomic-write implementation is
		// deleted — the shared atomicWriteFileSync (same file, ONE protocol) is
		// used instead, so the write protocol has exactly one implementation.
		const manifestPath = path.join(dir, "manifest.json");
		atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return dest;
	} catch {
		// Best-effort by contract: ANY failure → null, never throw.
		return null;
	}
}

/** Retention TTL: archived task dirs older than this are pruned (30 days). */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Retention: delete archived task dirs whose mtime is older than the TTL
 * (ARCHIVE_TTL_MS = 30 days by default; the folder mtime is the age source).
 * Best-effort by contract: ANY failure — missing/unreadable archive root,
 * undeletable task dir — is skipped, never thrown. A broken ttl input
 * (NaN/negative/Infinity) falls back to the default instead of wiping the
 * archive. Returns the number of task dirs removed.
 */
export function pruneArchive(maxAgeMs: number = ARCHIVE_TTL_MS): number {
	const ttl = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : ARCHIVE_TTL_MS;
	try {
		const root = archiveRoot();
		const cutoffMs = Date.now() - ttl;
		let pruned = 0;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue; // stray files are not task dirs
			const dir = path.join(root, entry.name);
			try {
				if (fs.statSync(dir).mtimeMs >= cutoffMs) continue; // fresh — keep
				fs.rmSync(dir, { recursive: true, force: true });
				pruned++;
			} catch {
				// unreadable/undeletable task dir → skip it, keep pruning the rest
			}
		}
		return pruned;
	} catch {
		return 0; // archiveRoot missing/unreadable → nothing to prune, never throw
	}
}

/** List archived tasks (dir names under archiveRoot with a manifest.json). */
export function listArchivedTasks(): string[] {
	try {
		const root = archiveRoot();
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.filter((name) => {
				try {
					return fs.statSync(path.join(root, name, "manifest.json")).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		// archiveRoot missing or unreadable → no archived tasks.
		return [];
	}
}
