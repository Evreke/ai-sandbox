/**
 * T1 — Static/design conformance checks (DESIGN.md §8).
 *
 * Run with: bun test/static-check.ts   (from repo root)
 *
 * Checks:
 *   1. Dependency rule: no module under src/ may import the transport
 *      IMPLEMENTATION (transport/herdr) — only index.ts binds it.
 *   2. src/observe.ts (delegate_status tool section) contains no mutating herdr calls.
 *   3. WORKER_NAME_RE rejects "Bad-Name", "-x", 33-char names; accepts valid ones.
 *   4. validateReport() error strings for 6 invalid shapes + 1 valid report.
 *   5. W0 pin (rng-sum bug 2): the E_REPORT_MISSING/E_REPORT_INVALID retry
 *      guidance mandates a NEW suffixed worker name — verbatim, at BOTH sites
 *      (promptGuidelines + the settle-fail text). Pure-text pin: the fix is
 *      prose and a reword would silently drop the mandate.
 *
 * Exit 0 only if all checks pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WORKER_NAME_RE, placementFromTabResult } from "../src/transport.ts";
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

const restricted = listTsFiles(resolve(ROOT, "src"));
// Match actual import statements (from "...transport/herdr(.ts)"), not doc-comment mentions.
const IMPORT_HERDR_RE = /(import[\s\S]*?from\s*["']|\bimport\s*["'])([^"']*transport\/herdr)["']/;
const offenders = restricted.filter((f) => IMPORT_HERDR_RE.test(readFileSync(f, "utf8")));
check(
	"T1.1 dependency rule: no src/ module ever imports transport/herdr.ts (herdr impl bound in index.ts only)",
	offenders.length === 0,
	offenders.join(", "),
);

const indexImportsHerdr = readFileSync(resolve(ROOT, "index.ts"), "utf8").includes(
	"./src/transport.ts",
);
check("T1.1b index.ts DOES import src/transport.ts (transport injection point)", indexImportsHerdr);

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
// 1.6 No hardcoded /root/ path literal in src/ (user-reported: WORKTREE_DIR
// broke every non-root user — all host paths resolve via os.homedir())
// ---------------------------------------------------------------------------

const rootPathOffenders = listTsFiles(resolve(ROOT, "src")).filter((f) =>
	readFileSync(f, "utf8").includes("/root/"),
);
check(
	"T1.6 src/ contains no /root/ path literal (homedir()-resolved paths instead)",
	rootPathOffenders.length === 0,
	rootPathOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 2. delegate_status tool read-only (section slice: observe.ts SECTION 1/3)
// ---------------------------------------------------------------------------

const observeSrc = readFileSync(resolve(ROOT, "src/observe.ts"), "utf8");
const statusSrc = observeSrc.slice(
	observeSrc.indexOf("SECTION 1/3"),
	observeSrc.indexOf("SECTION 2/3"),
);
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
// 5. W0 pin (rng-sum bug 2) — retry guidance mandates a NEW suffixed name
// ---------------------------------------------------------------------------

const delegateSrc = readFileSync(resolve(ROOT, "src/spawn.ts"), "utf8");
const RETRY_SENTENCE =
	"The retry MUST use a NEW worker name (e.g. <name>-r2) — the original name stays taken by the settled agent.";
const retryHits = delegateSrc.split(RETRY_SENTENCE).length - 1;
check(
	"T2.1 the NEW-suffixed-name retry mandate appears verbatim at BOTH guidance sites (≥2 occurrences)",
	retryHits >= 2,
	`verbatim hits: ${retryHits}`,
);
check(
	"T2.2 the mandate sits inside the delegate promptGuidelines (model-facing guidance, not just an error string)",
	(() => {
		// W5: spawn.ts holds BOTH tools' promptGuidelines (mailbox + delegate);
		// the mandate must live in one of the model-facing blocks.
		const blocks = delegateSrc.match(/promptGuidelines: \[[\s\S]*?\],/g) ?? [];
		return blocks.some((b) => b.includes(RETRY_SENTENCE));
	})(),
);
check(
	"T2.3 the mandate sits in the settle-fail guidance (the E_REPORT_MISSING/E_REPORT_INVALID text after 'Treat as a failed spawn')",
	(() => {
		const idx = delegateSrc.indexOf("Treat as a failed spawn: do a diagnosed retry");
		const hit = idx === -1 ? -1 : delegateSrc.indexOf(RETRY_SENTENCE, idx);
		return hit !== -1 && hit - idx < 400;
	})(),
);
check(
	"T2.4 the mandate names the suffixed shape explicitly (<name>-r2) — a same-name retry must read as impossible",
	/<name>-r2/.test(delegateSrc) && /name stays taken/.test(delegateSrc),
);

// ---------------------------------------------------------------------------
// 7. herdr drift pins (2026-09-10 implement-osb field report): herdr renamed
// tab-create result tab.id → tab.tab_id; the old probe list missed it and the
// paneId fallback recorded pane ids as tabId — every tab close failed
// tab_not_found while the agent stayed alive.
// ---------------------------------------------------------------------------

const CURRENT_TAB_SHAPE = {
	id: "cli:tab:create",
	result: {
		root_pane: { pane_id: "wKD:p4", tab_id: "wKD:t4", workspace_id: "wKD" },
		tab: { tab_id: "wKD:t4", label: "shape-probe", number: 4, pane_count: 1, workspace_id: "wKD" },
		type: "tab_created",
	},
};
const LEGACY_TAB_SHAPE = { result: { root_pane: { pane_id: "wKD:p4" }, tab: { id: "wKD:t4" } } };

const tabPlacement = placementFromTabResult(CURRENT_TAB_SHAPE.result, "wKD", "raw");
check("T3.1 current herdr shape: tabId parsed from tab.tab_id (NOT the paneId fallback)", tabPlacement.tabId === "wKD:t4" && tabPlacement.paneId === "wKD:p4", JSON.stringify(tabPlacement));
const legacyTabPlacement = placementFromTabResult(LEGACY_TAB_SHAPE.result, "wKD", "raw");
check("T3.2 legacy herdr shape (tab.id) still parses", legacyTabPlacement.tabId === "wKD:t4");
check(
	"T3.3 teardown reconciles the paneId-fallback signature: transport resolves the live tab id when recorded tabId === paneId",
	(() => {
		const transportSrc = readFileSync(resolve(ROOT, "src/transport.ts"), "utf8");
		return /resolveLiveTabId\(req\.name\)/.test(transportSrc) && /recordedTabId === req\.placement\.paneId/.test(transportSrc);
	})(),
);

// ---------------------------------------------------------------------------
// 8. Watcher log UX pin (2026-09-10): the production log sink must write an
// audit file and surface to the pane ONLY errors/anomalies — routine retire
// bookkeeping must never reach the user's UI again.
// ---------------------------------------------------------------------------

const observeSrcAll = readFileSync(resolve(ROOT, "src/observe.ts"), "utf8");
check(
	"T4.1 startWatcher's log sink audits to delegate-watch.log",
	/log: \(m: string\) => \{[\s\S]{0,400}?delegate-watch\.log/.test(observeSrcAll),
);
check(
	"T4.2 the sink filters: the pane shows only error/fail/already-gone/unavailable lines",
	/log: \(m: string\) => \{[\s\S]{0,400}?already gone[\s\S]{0,200}?console\.error/.test(observeSrcAll),
);
check(
	"T4.3 /delegate-teardown skips retired history instead of erroring tab_not_found on it",
	/actionsble = views\.filter\(\(v\) => v\.retired !== true\)/.test(observeSrcAll) ||
		/actionable = views\.filter\(\(v\) => v\.retired !== true\)/.test(observeSrcAll),
);
check(
	"T4.4 the teardown command treats a not-found close as an idempotent no-op success",
	/isAlreadyGone\(err\)[\s\S]{0,200}?already closed, no-op/.test(observeSrcAll),
);
check(
	"T4.5 WorkerView carries the retired flag (manifest history marker)",
	readFileSync(resolve(ROOT, "src/fleet.ts"), "utf8").includes("retired: typeof worker.retiredAt"),
);

// ---------------------------------------------------------------------------
// 6. F6 review-fix pin — same-name spawn clears a stale nudge-failed marker
// (review minor #1): the spawn flow deletes nudge-failed-<name>.json right
// after appending the manifest entry, or a fresh watcher session would
// re-fire the previous worker's marker once.
// ---------------------------------------------------------------------------

check(
	"T2.5 the spawn flow removes a stale nudge-failed marker for the same name right after the manifest append",
	/updateManifest\(manifestDir,[\s\S]{0,900}?rm\(nudgeFailedPathFor\(manifestDir, params\.name\), \{ force: true \}\)/.test(delegateSrc),
);
check(
	"T2.6 nudge-failed path convention lives in exchange.ts (module boundary — exchange-dir artifacts are exchange.ts conventions)",
	/\.\/exchange\.ts"/.test(readFileSync(resolve(ROOT, "src/spawn.ts"), "utf8")) &&
		readFileSync(resolve(ROOT, "src/exchange.ts"), "utf8").includes("export function nudgeFailedPathFor"),
);

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL STATIC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
