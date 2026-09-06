/**
 * T1 — Static/design conformance checks (DESIGN.md §8).
 *
 * Run with: bun test/static-check.ts   (from repo root)
 *
 * Checks:
 *   1. Dependency rule: src/tools/*.ts, src/commands.ts, src/state.ts,
 *      src/watch.ts must NOT import ./transport/herdr.ts — only index.ts may.
 *   2. src/tools/status.ts contains no mutating herdr calls.
 *   3. WORKER_NAME_RE rejects "Bad-Name", "-x", 33-char names; accepts valid ones.
 *   4. validateReport() error strings for 6 invalid shapes + 1 valid report.
 *
 * Exit 0 only if all checks pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WORKER_NAME_RE } from "../src/transport/types.ts";
import { validateReport } from "../src/exchange.ts";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// 1. Dependency rule
// ---------------------------------------------------------------------------

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = resolve(dir, e.name);
		if (e.isDirectory()) out.push(...listTsFiles(p));
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const restricted = [
	...listTsFiles(resolve(ROOT, "src/tools")),
	resolve(ROOT, "src/commands.ts"),
	resolve(ROOT, "src/state.ts"),
	// §21 watcher: the canonical dependency-rule list covers watch.ts too (the
	// review's point — §8 implies ONE enforcement point; watcher-check W1.1 keeps
	// its own copy as the watcher-suite guard).
	resolve(ROOT, "src/watch.ts"),
];
// Match actual import statements (from "...transport/herdr(.ts)"), not doc-comment mentions.
const IMPORT_HERDR_RE = /(import[\s\S]*?from\s*["']|\bimport\s*["'])([^"']*transport\/herdr)["']/;
const offenders = restricted.filter((f) => IMPORT_HERDR_RE.test(readFileSync(f, "utf8")));
check(
	"T1.1 dependency rule: tools/commands/state/watch never import transport/herdr.ts",
	offenders.length === 0,
	offenders.join(", "),
);

const indexImportsHerdr = readFileSync(resolve(ROOT, "index.ts"), "utf8").includes(
	"transport/herdr.ts",
);
check("T1.1b index.ts DOES import transport/herdr.ts (transport injection point)", indexImportsHerdr);

// ---------------------------------------------------------------------------
// 1.5 No hardcoded worker tier in src/ (v1.9.2)
// ---------------------------------------------------------------------------

const tierOffenders = listTsFiles(resolve(ROOT, "src")).filter((f) =>
	readFileSync(f, "utf8").includes("llm-platform-alpha"),
);
check(
	"T1.5 src/ contains no hardcoded worker tier provider (config tiers/defaults + E_TIER instead)",
	tierOffenders.length === 0,
	tierOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 2. status.ts read-only
// ---------------------------------------------------------------------------

const statusSrc = readFileSync(resolve(ROOT, "src/tools/status.ts"), "utf8");
const mutatingPatterns = [
	/\bplace\s*\(/,
	/\bstartAgent\s*\(/,
	/\bsubmitPrompt\s*\(/,
	/\bteardown\s*\(/,
	/"agent"\s*,\s*"(start|prompt)"/,
	/"worktree"\s*,\s*"create"/,
	/"tab"\s*,\s*"create"/,
	/"worktree"\s*,\s*"remove"/,
	/"tab"\s*,\s*"close"/,
	/"workspace"\s*,\s*"close"/,
];
const statusHits = mutatingPatterns.map((re) => re.test(statusSrc));
check(
	"T1.2 status.ts contains no mutating herdr calls",
	statusHits.every((h) => !h),
	`pattern hits at indices ${statusHits.flatMap((h, i) => (h ? [i] : [])).join(",")}`,
);

// ---------------------------------------------------------------------------
// 3. Name validation
// ---------------------------------------------------------------------------

const rejected = ["Bad-Name", "-x", "a".repeat(33), "with space", "Агент", "", "1abc", "café"];
const accepted = ["qa", "e2e-worker", "a".repeat(32), "w_1", "w-1"];
check(
	"T1.3 WORKER_NAME_RE rejects invalid names",
	rejected.every((n) => !WORKER_NAME_RE.test(n)),
	rejected.filter((n) => WORKER_NAME_RE.test(n)).join(","),
);
check(
	"T1.3b WORKER_NAME_RE accepts valid names",
	accepted.every((n) => WORKER_NAME_RE.test(n)),
	accepted.filter((n) => !WORKER_NAME_RE.test(n)).join(","),
);

// ---------------------------------------------------------------------------
// 4. Report schema — validateReport()
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const tmp = mkdtempSync(resolve(tmpdir(), "qa-reports-"));

function writeReport(name: string, content: unknown): string {
	const p = resolve(tmp, name);
	writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
	return p;
}

const valid = {
	worker: "w",
	status: "pass",
	summary: "all good",
	artifacts: ["test/x.ts"],
	evidence: [{ claim: "c", file: "f.ts:1" }],
};

const cases: Array<[string, string, string, string]> = [
	// [label, path, canonicalName, expectedErrorSubstring]
	[
		"missing file",
		resolve(tmp, "nope.json"),
		"w",
		"Report file not readable",
	],
	["empty file", writeReport("empty.json", ""), "w", "Report file is empty"],
	[
		"invalid JSON",
		writeReport("badjson.json", "{nope"),
		"w",
		"Report is not valid JSON",
	],
	[
		"array instead of object",
		writeReport("arr.json", []),
		"w",
		"Report must be a JSON object",
	],
	[
		"missing worker",
		writeReport("noworker.json", { ...valid, worker: undefined }),
		"w",
		'Report field "worker" must be a non-empty string',
	],
	[
		"worker name mismatch",
		writeReport("mismatch.json", { ...valid, worker: "other" }),
		"w",
		'Report "worker" is "other" but canonical name is "w"',
	],
	[
		"bad status",
		writeReport("badstatus.json", { ...valid, status: "PASS" }),
		"w",
		'Report "status" must be "pass" or "fail"',
	],
	[
		"empty summary",
		writeReport("nosummary.json", { ...valid, summary: "" }),
		"w",
		'Report field "summary" must be a non-empty string',
	],
	[
		"artifacts not array of strings",
		writeReport("badartifacts.json", { ...valid, artifacts: [1] }),
		"w",
		'Report field "artifacts" must be an array of strings',
	],
	[
		"evidence missing",
		writeReport("noevidence.json", { worker: "w", status: "pass", summary: "s", artifacts: [] }),
		"w",
		'Report field "evidence" must be an array',
	],
	[
		"evidence item missing file",
		writeReport("badevidence.json", { ...valid, evidence: [{ claim: "c" }] }),
		"w",
		'must have non-empty string "claim" and "file"',
	],
];

for (const [label, p, canonical, expected] of cases) {
	const res = validateReport(p, canonical);
	check(
		`T1.4 validateReport rejects: ${label}`,
		!res.ok && res.error.includes(expected),
		res.ok ? "unexpectedly accepted" : res.error,
	);
}

const goodPath = writeReport("good.json", valid);
const good = validateReport(goodPath, "w");
check("T1.4b validateReport accepts a valid report", good.ok, good.ok ? "" : good.error);

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL STATIC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
