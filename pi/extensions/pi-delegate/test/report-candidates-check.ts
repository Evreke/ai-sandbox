/**
 * Report-candidate scan checks (report-path mismatch incident, 2026-09) —
 * the loose collect/settle candidate discovery (design option e).
 *
 * Run with: bun test/report-candidates-check.ts   (from the extension dir)
 *
 * Covers:
 *   S1  Canonical first: report-<name>.json existing → always the first
 *       candidate.
 *   S2  Strays discovered: any other report-*.json / report-*.md in the task
 *       dir NEWER than startedAt follows the canonical entry, newest first.
 *   S3  Stale fence: stray files OLDER than startedAt are excluded (a stale
 *       report from an earlier same-name attempt can never be adopted).
 *   S4  Non-report files excluded (briefs, manifests, q-/a- envelopes…).
 *   S5  Unreadable dir degrades to the canonical entry when it exists, and to
 *       an empty list otherwise — never throws.
 *   S6  Never throws on unreadable/odd entries (a directory named report-x.json).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportPathFor, scanReportCandidates } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = mkdtempSync(join(tmpdir(), "report-candidates-check-"));
const STARTED_AT = Date.parse("2026-09-06T12:00:00.000Z");

function taskDir(name: string): string {
	const dir = join(ROOT, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function seed(dir: string, file: string, mtimeMs: number): string {
	const p = join(dir, file);
	writeFileSync(p, "{}\n");
	utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
	return p;
}

// ---------------------------------------------------------------------------
// S1+S2. Canonical first, strays newest-first
// ---------------------------------------------------------------------------

{
	const dir = taskDir("order");
	const canonical = seed(dir, "report-w.json", STARTED_AT - 1000);
	const strayJson = seed(dir, "report-impl.json", STARTED_AT + 5_000);
	const strayMd = seed(dir, "report-impl.md", STARTED_AT + 60_000);
	const strayOld = seed(dir, "report-old.json", STARTED_AT - 60_000);
	const scanned = scanReportCandidates(dir, STARTED_AT, "w");
	check(
		"S1.1 canonical is the first candidate even when older than strays",
		scanned[0] === canonical,
		scanned.join(", "),
	);
	check(
		"S2.1 fresh strays follow, sorted by mtime descending",
		scanned[1] === strayMd && scanned[2] === strayJson,
		scanned.join(", "),
	);
	check("S3.1 a stray older than startedAt is excluded (stale fence)", !scanned.includes(strayOld), scanned.join(", "));
	// The canonical entry stays first even without any stray.
	const solo = taskDir("solo");
	const soloCanonical = seed(solo, "report-w.json", STARTED_AT - 1000);
	const alone = scanReportCandidates(solo, STARTED_AT, "w");
	check("S1.2 canonical-only dir → exactly the canonical candidate", alone.length === 1 && alone[0] === soloCanonical, alone.join(", "));
}

// ---------------------------------------------------------------------------
// S3b. No canonical on disk → strays only
// ---------------------------------------------------------------------------

{
	const dir = taskDir("nocanonical");
	const stray = seed(dir, "report-impl.json", STARTED_AT + 1000);
	const scanned = scanReportCandidates(dir, STARTED_AT, "w");
	check("S3.2 canonical absent → the fresh stray is discovered", scanned.length === 1 && scanned[0] === stray, scanned.join(", "));
}

// ---------------------------------------------------------------------------
// S4. Non-report files excluded
// ---------------------------------------------------------------------------

{
	const dir = taskDir("noise");
	seed(dir, "brief-w.md", STARTED_AT + 1000);
	seed(dir, "manifest.json", STARTED_AT + 1000);
	seed(dir, "q-w.json", STARTED_AT + 1000);
	seed(dir, "a-w.json", STARTED_AT + 1000);
	seed(dir, "report-notes.txt", STARTED_AT + 1000);
	const scanned = scanReportCandidates(dir, STARTED_AT, "w");
	check("S4.1 briefs/manifests/mailbox/non-report files are never candidates", scanned.length === 0, scanned.join(", "));
}

// ---------------------------------------------------------------------------
// S5+S6. Tolerant reads — never throws
// ---------------------------------------------------------------------------

{
	check(
		"S5.1 unreadable dir → empty list (canonical cannot be probed), never throws",
		scanReportCandidates(join(ROOT, "no-such-dir"), STARTED_AT, "w").length === 0,
	);
	const dir = taskDir("odd");
	mkdirSync(join(dir, "report-dir.json"), { recursive: true }); // a DIRECTORY with a report name
	const scanned = scanReportCandidates(dir, STARTED_AT, "w");
	check("S6.1 a directory with a report name is skipped, never throws", scanned.length === 0, scanned.join(", "));
	check(
		"S6.2 canonical still first when it coexists with odd entries",
		scanReportCandidates(join(ROOT, "order"), STARTED_AT, "w")[0] === reportPathFor(join(ROOT, "order"), "w"),
	);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL REPORT-CANDIDATES CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
