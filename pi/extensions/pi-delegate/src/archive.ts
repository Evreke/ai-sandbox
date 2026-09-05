/**
 * pi-delegate — report archive (DESIGN.md §19.3).
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A6 (impl-settle). Worker B6 imports, never edits this file.
 *
 * Durability: collected reports are mirrored OUT of /tmp (which dies on
 * reboot — supervip_epic lost every artifact of three phases) into
 * ~/.pi/agent/delegate-archive/<task>/.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ARCHIVE_DIR = ".pi/agent/delegate-archive";

/** Absolute archive root. */
export function archiveRoot(): string {
	return path.join(process.env.HOME ?? os.homedir(), ARCHIVE_DIR);
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
		// observes a half-written manifest.json.
		const manifestPath = path.join(dir, "manifest.json");
		const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, "\t")}\n`);
			fs.renameSync(tmp, manifestPath);
		} finally {
			// Best-effort tmp cleanup if rename failed.
			try {
				fs.unlinkSync(tmp);
			} catch {
				// tmp already gone (renamed) — nothing to do.
			}
		}
		return dest;
	} catch {
		// Best-effort by contract: ANY failure → null, never throw.
		return null;
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
