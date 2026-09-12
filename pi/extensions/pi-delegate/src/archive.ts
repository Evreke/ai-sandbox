
/**
 * pi-delegate — report archive.
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
 * atomic writer (atomicWriteFileSync) imported from ./manifest-store.ts
 * (extracted in Wave 3a; the writer's single home — the archive's only
 * coupling to the remainder of the exchange layer).
 *
 * Critical invariants: archive is best-effort by contract — any failure →
 * null/0/[] — never throws past its callers.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFileSync } from "./manifest-store.ts";

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
 * Best-effort by contract: return the archive report path on success; on
 * ANY failure dest=null + the human-readable error (Wave 4 item 6: the
 * reason is surfaced — the caller renders it in the collect note — never a
 * throw, never a bare silent null).
 */
/** Outcome of the best-effort report archive (Wave 4 item 6 — silent-catch
 *  surfacing): dest is the archived report path, or null when the archive
 *  failed; error carries the human-readable WHY (never thrown). */
export interface ArchiveOutcome {
	dest: string | null;
	/** The failure reason (e.g. the fs error message) when dest is null. */
	error?: string;
}

export function archiveReport(
	taskDir: string,
	reportPath: string,
	manifest: Record<string, unknown>,
): ArchiveOutcome {
	try {
		const task = path.basename(taskDir);
		if (task.length === 0) return { dest: null };
		const dir = path.join(archiveRoot(), task);
		fs.mkdirSync(dir, { recursive: true });

		const reportName = path.basename(reportPath);
		if (reportName.length === 0) return { dest: null };
		const dest = path.join(dir, reportName);
		fs.copyFileSync(reportPath, dest);

		// Manifest snapshot: atomic tmp+rename so a concurrent reader never
		// observes a half-written manifest.json. Migration stage 2 (audit step 5):
		// the archive path's SECOND hand-rolled atomic-write implementation is
		// deleted — the shared atomicWriteFileSync (same file, ONE protocol) is
		// used instead, so the write protocol has exactly one implementation.
		const manifestPath = path.join(dir, "manifest.json");
		atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return { dest };
	} catch (err) {
		// Best-effort by contract: ANY failure → { dest: null, error }, never
		// throw. Wave 4 item 6 (reliability finding 7): the reason is SURFACED
		// (the collect note renders it) instead of collapsing to a bare null.
		return { dest: null, error: err instanceof Error ? err.message : String(err) };
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
