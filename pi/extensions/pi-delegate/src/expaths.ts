/**
 * pi-delegate — src/expaths.ts — the ONE exchange-layer path builder.
 *
 * MODULE_CONTRACT: portable (Windows + POSIX) path assembly for the
 * exchange dir layer. Every path the exchange layer builds by string
 * concatenation goes through a builder here — never through template
 * literals with a hardcoded "/" separator (a Windows runtime would produce
 * mixed-separator paths like `C:\x\y/report-1.json`, poisoning comparisons,
 * displays and endsWith/split parsing).
 *
 * Dependencies: node:path ONLY (bottom of the src/ import graph — this
 * module must never import another src/ module, or the layer inverts).
 *
 * Platform injection: every builder takes an optional trailing `p`
 * parameter — the node:path platform module to build with. The default is
 * the process's own platform path (`node:path`), so production behavior is
 * unchanged; tests on a POSIX host pass `node.path.win32` explicitly and
 * assert backslash outputs with `C:\…` fixture strings (no Windows machine
 * needed — these are pure string functions).
 *
 * Critical invariants:
 *   - POSIX behavior is byte-for-byte identical to the pre-extraction
 *     template-literal code (join(dir, "report-x.json") === `${dir}/…`
 *     when the platform separator is "/").
 *   - Single source for the shared exchange-dir name conventions
 *     (PROBE_DIR_SUFFIX, TEARDOWN_LOG_NAME — migration stage 1 constants,
 *     relocated here so the builder and the classifiers read ONE spelling;
 *     exchange.ts re-exports them, its export surface is unchanged).
 *   - The manifest.json on-disk format and stored path strings are DATA —
 *     never rewritten or normalized here (readers are tolerant; stored
 *     paths keep the separators of the machine that wrote them).
 */

import * as nodePath from "node:path";

/** The node:path module shape builders accept (nodePath default, or
 *  nodePath.win32 / nodePath.posix in tests). */
export type PathPlatform = typeof nodePath;

/** Probe-run dir name convention (DESIGN.md §5.1 step 4, §19.4 probe
 *  honesty): probe runs exchange under <exchangeRoot>/_probe — no report is
 *  ever expected there. One name, imported by spawn (dir builder), observe
 *  and index (dir classification). Before the Windows-path fix the literal
 *  was owned by exchange.ts; it moved here so the builder and the
 *  classifier (isProbeDir) share one spelling.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none
 * Output: the "_probe" dir name
 * Guarantees: never changes value without a migration note — fixture dirs
 *   and classification across tests depend on the exact spelling.
 * Raises: never */
export const PROBE_DIR_SUFFIX = "_probe";

/** Teardown audit trail file name — <exchange dir>/teardown.log, shared by
 *  the /delegate-teardown command (observe.ts logTo) and the collect-time
 *  auto-teardown (spawn.ts logTeardownAudit) so both close paths write ONE
 *  trail per task dir. Owned here (single spelling); exchange.ts re-exports
 *  it and a text pin (test/collect-teardown-check.ts C4.4) verifies both
 *  call sites use the shared constant + teardownLogLine.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none
 * Output: "teardown.log"
 * Guarantees: exact spelling — the file is a shared append-only artifact.
 * Raises: never */
export const TEARDOWN_LOG_NAME = "teardown.log";

/** manifest.json inside a task dir. */
export function manifestPathFor(dir: string, p: PathPlatform = nodePath): string {
	return p.join(dir, "manifest.json");
}

/** Conventional report path: report-<name>.json next to the brief. */
export function reportPathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `report-${name}.json`);
}

/** Conventional pending-question mailbox path: q-<name>.json. */
export function questionPathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `q-${name}.json`);
}

/** Conventional answer mailbox path: a-<name>.json. */
export function answerPathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `a-${name}.json`);
}

/** Conventional nudge-failed marker path: nudge-failed-<name>.json. */
export function nudgeFailedPathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `nudge-failed-${name}.json`);
}

/** Conventional release (retire ACK) marker path: release-<name>.json. */
export function releasePathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `release-${name}.json`);
}

/** Conventional progress-ping path: p-<name>.jsonl. */
export function progressPathFor(dir: string, name: string, p: PathPlatform = nodePath): string {
	return p.join(dir, `p-${name}.jsonl`);
}

/** Archived pending-question path: q-<name>.answered-<ts>.json (the rename
 *  target when a posted answer consumes the question — spawn.ts mailbox
 *  answer/steer flow). */
export function questionArchivePathFor(
	dir: string,
	name: string,
	ts: number,
	p: PathPlatform = nodePath,
): string {
	return p.join(dir, `q-${name}.answered-${ts}.json`);
}

/** Probe-run exchange dir: <root>/_probe (spawn.ts probeExchangeDir). */
export function probeDirPathFor(root: string, p: PathPlatform = nodePath): string {
	return p.join(root, PROBE_DIR_SUFFIX);
}

/**
 * True when an exchange dir is the probe dir. Basename compare — works for
 * any separator shape (`/tmp/exchange/_probe`, `C:\exchange\_probe`), unlike
 * the old endsWith("/_probe") which was blind to backslash paths.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — exchange dir path (absolute in production)
 * Output: true iff the dir's basename equals "_probe"
 * Guarantees:
 *   - pure string test, no fs access
 *   - single classifier for probe dirs (observe view building, index tool
 *     result field, watcher skip logic all read it)
 * Raises: never
 */
export function isProbeDir(dir: string, p: PathPlatform = nodePath): boolean {
	return p.basename(dir) === PROBE_DIR_SUFFIX;
}

/**
 * Task slug from a task dir — the basename, separator-agnostic. Replaces the
 * old dir.split("/") which mangled drive-letter dirs (a Windows
 * `C:\tmp\exchange\task` came back whole — no usable fleet grouping key).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — task dir path
 * Output: the last path segment; the input itself when there is none
 *   (bare root like "/" or "C:\" — basename is "")
 * Guarantees:
 *   - pure; on POSIX paths the result equals the old split-based slug
 * Raises: never
 */
export function taskSlug(dir: string, p: PathPlatform = nodePath): string {
	return p.basename(dir) || dir;
}

/**
 * Canonical comparison key for a dir path. Pure string rules — no realpath
 * (a syscall per manifest, and it throws on vanished dirs).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — a dir path
 * Output: the key to compare/group by:
 *   - posix: the input byte-for-byte (case-sensitive FS — no folding)
 *   - win32-shaped platform (p.sep === "\\"): both separator kinds folded
 *     to "\\", case-folded (NTFS is case-insensitive), trailing separators
 *     stripped (root shapes like "C:\" keep theirs)
 * Guarantees: equal dirs on disk get equal keys (the fleet-grouping /
 *   dedup / root-membership compare never splits them again)
 * Raises: never
 */
export function normalizeDirKey(dir: string, p: PathPlatform = nodePath): string {
	if (p.sep !== "\\") return dir; // posix — byte-for-byte
	const folded = dir.replace(/[\\/]+/g, "\\").toLowerCase();
	const stripped = folded.replace(/\\+$/, "");
	// Keep the bare root shapes intact ("\", "c:\") — stripping their only
	// separator would make them collide with driveless/drive-relative forms.
	if (stripped === "" || /^[a-z]:$/.test(stripped)) return folded;
	return stripped;
}

/**
 * Dir equality under the platform's case/separator rules.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: two dir paths
 * Output: true iff normalizeDirKey(a) === normalizeDirKey(b)
 * Guarantees:
 *   - posix: strict equality (identical to the old raw string compares)
 *   - win32-shaped: `c:\x` and `C:\x/` compare equal
 * Raises: never
 */
export function sameDir(a: string, b: string, p: PathPlatform = nodePath): boolean {
	return normalizeDirKey(a, p) === normalizeDirKey(b, p);
}

/**
 * Segment-aware "dir is parent-or-equal" containment check (boundary — not a
 * raw prefix startsWith, which would accept `…/worktrees-extra` for parent
 * `…/worktrees` and misses backslash children on Windows).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir, parent — dir paths
 * Output: true iff dir === parent or dir lies directly under parent (any
 *   nesting depth), compared on normalized keys with a separator boundary
 * Guarantees:
 *   - posix: byte-identical to the old `cwd === WORKTREE_DIR ||
 *     cwd.startsWith(WORKTREE_DIR + "/")` shape for non-degenerate inputs
 *   - win32-shaped: accepts both separator kinds via the folded keys
 * Raises: never
 */
export function isDirUnder(dir: string, parent: string, p: PathPlatform = nodePath): boolean {
	const d = normalizeDirKey(dir, p);
	const par = normalizeDirKey(parent, p);
	if (d === par) return true;
	const sep = p.sep;
	return d.startsWith(par.endsWith(sep) ? par : par + sep);
}
