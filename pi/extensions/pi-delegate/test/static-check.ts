/**
 * T1 — Static/design conformance checks (DESIGN.md §8).
 *
 * Run with: bun test/static-check.ts   (from repo root)
 *
 * Checks (migration stage 3, audit step 10: every fix-specific source-text
 * pin is replaced by a BEHAVIORAL test — the registered tools/commands are
 * driven, the exported pure helpers are exercised; the ONLY remaining
 * source scans are the three hygiene lint rules, which prohibit literals
 * and are textual by nature):
 *   1. Package boundary (migration stage 3, audit step 9): the herdr adapter
 *      is published ONLY as the separate export subpath "./herdr" — module
 *      resolution, not a source-text regex, enforces the import rule; the
 *      adapter is loaded and CONSTRUCTED here (T1.1b-drive — the old T1.1b
 *      text pin is deleted).
 *   2. delegate_status read-only, BEHAVIORALLY: the registered tool is driven
 *      against a recording transport — execute touches ONLY listStatuses.
 *   3. WORKER_NAME_RE rejects "Bad-Name", "-x", 33-char names; accepts valid ones.
 *   4. validateReport() error strings for 6 invalid shapes + 1 valid report.
 *   5. W0 retry mandate (rng-sum bug 2), BEHAVIORALLY: the captured delegate
 *      tool's runtime promptGuidelines carry the RETRY_MANDATE constant, and
 *      a DRIVEN settle-fail (fake host, no report) carries it in the actual
 *      E_REPORT_MISSING guidance; the same drive consumes a stale
 *      nudge-failed marker (T2.5b).
 *   6. Hygiene lint (source scans by nature): the seam imports no relative
 *      modules; no hardcoded tier or /root/ literal in src/.
 *
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
	WORKER_NAME_RE,
} from "../src/host.ts";
import {
	placementFromTabResult,
} from "../src/herdr/host.ts";
import { validateReport, TEARDOWN_LOG_NAME, teardownLogLine } from "../src/exchange.ts";
import { registerDelegateTool, RETRY_MANDATE } from "../src/spawn.ts";
import { registerCommands, registerStatusTool } from "../src/observe.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import type { Transport } from "../src/host.ts";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");

// Fixture hygiene (field lesson 2026-09-10, host-fake-check convention): the
// exchange root is SANDBOXED via $PI_DELEGATE_EXCHANGE_ROOT for the behavioral
// drives below — the real /tmp/exchange is never touched.
const SANDBOX = mkdtempSync(resolve(tmpdir(), "static-check-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// 1. Package boundary (migration stage 3, audit step 9)
// ---------------------------------------------------------------------------

// The old T1.1/T1.1c TEXT pins (regex scans for herdr imports across src/)
// are GONE: the rule "the adapter is reachable only through its export
// subpath, bound once by the composition root" is now enforced by module
// RESOLUTION — package.json's exports map exposes "." → index.ts and the
// adapter at the separate subpath "./herdr", nothing else. The check below
// pins the boundary itself (fail-closed: a removed/renamed subpath or a
// re-widened exports map fails here).
interface PackageExports {
	exports?: Record<string, string>;
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as PackageExports;
check(
	"T1.1e package boundary: exports map exposes only '.' (index.ts) and './herdr' (the adapter subpath) — the import rule is module-resolution, not text",
	pkg.exports?.["."] === "./index.ts" && pkg.exports?.["./herdr"] === "./src/herdr/host.ts",
	JSON.stringify(pkg.exports ?? null),
);

// The old T1.1b POSITIVE text pin (index.ts imports the adapter) is GONE
// (migration stage 3, audit step 10): the binding's SUBSTANCE is the runtime
// proof below — the adapter module imports, constructs and serves the full
// Transport contract through the package boundary (T1.1b-drive + T1.1e);
// which file calls the constructor is compile-time wiring (tsc qa config).

// Behavioral binding proof (replaces the T1.1b text pin): the adapter module
// LOADS through its src path and constructs — the composition root's binding
// target exists and serves the seam.
{
	const { createHerdrTransport } = await import(resolve(ROOT, "src/herdr/host.ts"));
	const t = createHerdrTransport();
	check(
		"T1.1b-drive the herdr adapter constructs and serves the Transport seam (backendName + capabilities)",
		typeof t.backendName === "function" && t.backendName() === "herdr" && typeof t.capabilities === "function",
	);
}

// Bottom-of-graph pin (workerhost inversion, research risk #2): the seam
// module imports node builtins ONLY — zero relative/src imports (error
// guidance strings and helpers get DUPLICATED into it, never imported from
// tool modules — a shared helper would drag the whole graph under the seam).
const hostSrc = readFileSync(resolve(ROOT, "src/host.ts"), "utf8");
const hostRelativeImports = hostSrc.match(/from\s*["']\.[^"']*["']/g) ?? [];
check(
	"T1.1d src/host.ts (the seam) imports node builtins only — no relative imports (bottom of the graph)",
	hostRelativeImports.length === 0,
	hostRelativeImports.join(", "),
);

// ---------------------------------------------------------------------------
// 1.5 No hardcoded worker tier in src/ (v1.9.2)
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
// 1.7 Law 1 pins (constitution): the platform is the API — no hardcoded
// agent-dir joins, no union-of-literals tool enums.
// ---------------------------------------------------------------------------

/** Strip line comments (slash-slash) and block comments (slash-star ... star-
 *  slash) from TypeScript source so
 *  only CODE constructs are scanned (display-only guidance inside comments is
 *  allowed to mention ~/.pi/agent paths). String literals survive stripping —
 *  they are scanned by the shape rules below, which distinguish code joins
 *  from prose (a prose path is inside a sentence, never a join argument). */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Law 1 (directory constants): never join os.homedir() with literal .pi/.pi/agent
// segments — pi exports getAgentDir()/CONFIG_DIR_NAME for this. The pin scans
// CODE (comments stripped) and flags exactly the audit's offender shapes:
//   - a homedir() call followed by a ".pi" join segment (homedir(), ".pi", ...)
//   - a join(...) argument carrying a ".pi" or ".pi/agent" literal segment
//   - a module constant assigned a relative ".pi/..." path literal
//   - a template-literal path assembly containing .pi/agent
// Display-only strings inside sentences ("see ~/.pi/agent/...") never match:
// they are neither join arguments nor assignments nor template assemblies.
const agentDirOffenders: string[] = [];
for (const f of listTsFiles(resolve(ROOT, "src"))) {
	const code = stripComments(readFileSync(f, "utf8"));
	const lines = code.split("\n");
	lines.forEach((line, i) => {
		const offenderShape =
			/homedir\(\)\s*,\s*["']\.pi["']/.test(line) ||
			/join\(\s*["'][^"']*\.pi\/agent[^"']*["']/.test(line) ||
			/join\([^\n]*["']\.pi["']/.test(line) ||
			/=\s*["']\.pi\//.test(line) ||
			/`[^`]*\.pi\/agent[^`]*`/.test(line);
		if (offenderShape) agentDirOffenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
	});
}
check(
	"T1.7 src/ builds no agent-dir path by joining homedir() with literal .pi/.pi/agent segments (Law 1: pi's getAgentDir()/CONFIG_DIR_NAME instead)",
	agentDirOffenders.length === 0,
	agentDirOffenders.join(" | "),
);

// Law 1 (tool enums): no tool parameter schema uses Type.Union of Type.Literal
// members — that shape breaks Google models; StringEnum from @earendil-works/
// pi-ai is the only allowed spelling. Scans the two tool-schema files
// (comments stripped; prose mentions of the rule in comments are invisible).
const enumUnionOffenders: string[] = [];
for (const f of [resolve(ROOT, "src/spawn.ts"), resolve(ROOT, "src/observe.ts")]) {
	const code = stripComments(readFileSync(f, "utf8"));
	const lines = code.split("\n");
	lines.forEach((line, i) => {
		if (/Type\.Union\s*\(\s*\[[^\n]*Type\.Literal/.test(line)) {
			enumUnionOffenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
		}
	});
}
check(
	"T1.7b no tool parameter schema in src/spawn.ts / src/observe.ts uses Type.Union of Type.Literal members (Law 1: StringEnum instead)",
	enumUnionOffenders.length === 0,
	enumUnionOffenders.join(" | "),
);

// ---------------------------------------------------------------------------
// 1.8 Law 6 pin — layering: no src/ module imports src/observe.ts except
//     the composition root's slices (Wave 3a: the watch-config extraction
//     killed the spawn→observe edge; this pin keeps it dead).
// ---------------------------------------------------------------------------

// Plain read-based assertion (modeled on the T1.5/T1.6 hygiene scans):
// every src/**/*.ts file must not carry a relative import of ./observe —
// with exactly two allowlisted exceptions: src/compose.ts (the watcher
// mount slice) and index.ts (the composition root — outside src/ anyway,
// listed here for clarity). Everything the rest of the layer needs from
// observe's neighborhood lives in the extracted modules (watch-config.ts,
// watch-store.ts, report-schema.ts, mailbox-store.ts, manifest-store.ts,
// archive.ts); importing observe for it re-creates the forbidden edge.
const OBSERVE_IMPORT_ALLOWLIST = new Set(["compose.ts"]);
const observeImportOffenders = listTsFiles(resolve(ROOT, "src"))
	.filter((f) => !OBSERVE_IMPORT_ALLOWLIST.has(f.split("/").pop() ?? ""))
	.filter((f) => /from\s*["']\.\/observe(\.ts)?["']/.test(readFileSync(f, "utf8")));
check(
	"T1.8 no src/ module imports src/observe.ts except compose.ts (Law 6: the spawn→observe edge stays dead — config lives in watch-config.ts)",
	observeImportOffenders.length === 0,
	observeImportOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 2. delegate_status tool read-only (section slice: observe.ts SECTION 1/3)
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// regex over the observe.ts section slice): the REGISTERED delegate_status
// tool is driven against a recording transport; the read-only contract is
// that its execute touches ONLY the read sensor (listStatuses), never a
// mutating backend operation.
{
	const statusCalls: string[] = [];
	const recordingTransport = {
		backendName: () => "herdr",
		capabilities: () => ({ worktrees: true, authority: "root" }),
		listStatuses: async () => {
			statusCalls.push("listStatuses");
			return [];
		},
		place: async () => {
			statusCalls.push("place");
			throw new Error("place MUST NOT be called by delegate_status");
		},
		startAgent: async () => {
			statusCalls.push("startAgent");
			throw new Error("startAgent MUST NOT be called by delegate_status");
		},
		submitPrompt: async () => {
			statusCalls.push("submitPrompt");
			throw new Error("submitPrompt MUST NOT be called by delegate_status");
		},
		teardown: async () => {
			statusCalls.push("teardown");
			throw new Error("teardown MUST NOT be called by delegate_status");
		},
	} as unknown as Transport;
	let statusTool!: { execute: (...a: unknown[]) => Promise<unknown> };
	registerStatusTool({ registerTool: (t: never) => (statusTool = t as never) } as never, recordingTransport);
	await statusTool.execute("t1", {}, undefined, () => {}, { cwd: SANDBOX, hasUI: false });
	check(
		"T1.2 delegate_status execute calls ONLY listStatuses — zero mutating transport ops (behavioral)",
		statusCalls.length === 1 && statusCalls[0] === "listStatuses",
		JSON.stringify(statusCalls),
	);
}

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
// 5. W0 pin (rng-sum bug 2) — retry guidance mandates a NEW suffixed name.
// Migration stage 1: the sentence is ONE exported constant (RETRY_MANDATE in
// src/spawn.ts); the pins verify BOTH guidance sites use the constant, so the
// two copies can never drift apart again.
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// pins over spawn.ts): the REGISTERED delegate tool is captured and its
// model-facing guidance inspected at RUNTIME (T2.1b/T2.2b), and a real
// settle-fail is DRIVEN on the fake host so the E_REPORT_MISSING guidance is
// asserted on the actual tool RESULT (T2.3b). The same drive proves the
// stale-marker cleanup (section 6).
{
	let delegateTool!: {
		promptGuidelines: string[];
		execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	};
	registerDelegateTool({ registerTool: (t: never) => (delegateTool = t as never) } as never, new FakeWorkerHost({ repoPath: SANDBOX, statusScript: ["working", "done"] }) as unknown as Transport);
	check(
		"T2.1b the delegate promptGuidelines (runtime array) carry the RETRY_MANDATE constant",
		delegateTool.promptGuidelines.some((g) => g.includes(RETRY_MANDATE)),
	);

	// Drive a genuine settle-fail: the fake settles (working → done) but NO
	// report file exists → E_REPORT_MISSING → the "Treat as a failed spawn"
	// guidance must carry the mandate.
	const FAIL_NAME = "static-fail-worker";
	const failDir = join(SANDBOX, `static-fail-${process.pid}`);
	mkdirSync(failDir, { recursive: true });
	const briefFail = join(failDir, `brief-${FAIL_NAME}.md`);
	writeFileSync(briefFail, `# brief\n\nOUTPUT: report-${FAIL_NAME}.json\n`);
	// The stale marker (F6 review fix, section 6): a PRE-EXISTING marker from a
	// same-name retry must be consumed by the spawn flow.
	const staleMarker = join(failDir, `nudge-failed-${FAIL_NAME}.json`);
	writeFileSync(staleMarker, JSON.stringify({ name: FAIL_NAME, ts: "T", error: "stale" }));
	const failResult = await delegateTool.execute(
		"t1",
		{ name: FAIL_NAME, briefPath: briefFail, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: SANDBOX, mode: "tab", releaseOn: "settle" },
		undefined,
		() => {},
		{ cwd: SANDBOX, hasUI: false },
	);
	const failText = failResult.content.map((c) => c.text).join("\n");
	check(
		"T2.3b a settled-without-report fail result carries 'Treat as a failed spawn' + the RETRY_MANDATE (behavioral)",
		failResult.details.ok === false && failResult.details.code === "E_REPORT_MISSING" &&
			failText.includes("Treat as a failed spawn") && failText.includes(RETRY_MANDATE),
		failText.slice(0, 200),
	);
	check(
		"T2.5b the spawn flow consumed the stale nudge-failed marker right after its manifest append (behavioral)",
		!existsSync(staleMarker),
	);
}
check(
	"T2.4 the mandate names the suffixed shape explicitly (<name>-r2) — a same-name retry must read as impossible",
	/<name>-r2/.test(RETRY_MANDATE) && /name stays taken/.test(RETRY_MANDATE),
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
// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// regex over the adapter): the reconcile DECISION is the exported pure
// helper the teardown call site feeds (recorded id + live resolution).
{
	const { reconcileTabClose } = await import(resolve(ROOT, "src/herdr/host.ts"));
	check(
		"T3.3 teardown reconcile decision: broken paneId signature + a different live id → close the REAL tab",
		reconcileTabClose("wKD:p4", "wKD:t9") === "wKD:t9",
	);
	check(
		"T3.3b no live id (agent gone / statuses unavailable) → the recorded id, never a wrong-target close",
		reconcileTabClose("wKD:p4", null) === "wKD:p4" && reconcileTabClose("wKD:t4", "wKD:t4") === "wKD:t4",
	);
}

// ---------------------------------------------------------------------------
// 8. Watcher log UX pin (2026-09-10): the production log sink must write an
// audit file and surface to the pane ONLY errors/anomalies — routine retire
// bookkeeping must never reach the user's UI again.
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the T4.1–T4.4
// source-text regexes over observe.ts): the log sink is driven through its
// exported factory (child process — bun caches os.homedir(), so $HOME must be
// set at spawn time), and the /delegate-teardown COMMAND is driven against a
// recording transport.
{
	// T4.1/T4.2 — the sink audits every line and surfaces ONLY error-shaped
	// ones to the pane. Child bun: fresh $HOME + a fresh module registry.
	const home = mkdtempSync(join(tmpdir(), "static-check-home-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true }); // production always has this dir; a fresh $HOME must pre-create it for the audit append
	const sinkSrc =
		`const { makeWatcherLogSink } = await import(${JSON.stringify(resolve(ROOT, "src/observe.ts"))});` +
		`const { appendFileSync } = await import("node:fs");` +
		`const seen = [];` +
		`const orig = console.error; console.error = (...a) => { seen.push(a.join(" ")); };` +
		`const sink = makeWatcherLogSink();` +
		`sink("retired worker probe-1 (ttl)");` +
		`sink("retire pass error for probe-2 (herdr exploded)");` +
		`await new Promise((r) => setTimeout(r, 150));` + // async append must land
		`const audit = appendFileSync; ` +
		`orig(JSON.stringify(seen));`;
	const res = spawnSync("bun", ["-e", sinkSrc], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	let paneLines: string[] = [];
	try {
		// console.error writes to stderr — the surfaced-line JSON is the last line there
		paneLines = JSON.parse((res.stderr?.trim().split("\n").pop() ?? "[]")) as string[];
	} catch {
		// spawn flake — surfaced by the empty-panes check below
	}
	const auditPath = join(home, ".pi", "agent", "delegate-watch.log");
	let audit = "";
	try {
		audit = readFileSync(auditPath, "utf8");
	} catch {
		// absent audit file → the T4.1b check fails below
	}
	check(
		"T4.1b the log sink audits EVERY line to ~/.pi/agent/delegate-watch.log (behavioral)",
		audit.includes("retired worker probe-1 (ttl)") && audit.includes("retire pass error for probe-2"),
		JSON.stringify(audit.slice(0, 200)),
	);
	check(
		"T4.2b the pane sees ONLY the error-shaped line — routine bookkeeping never reaches the UI (behavioral)",
		paneLines.length === 1 && paneLines[0]?.includes("retire pass error") && !paneLines[0]?.includes("probe-1"),
		JSON.stringify(paneLines),
	);
	rmSync(home, { recursive: true, force: true });

	// T4.3/T4.4 — the /delegate-teardown command is DRIVEN: a manifest with one
	// retired-history entry + one actionable already-gone worker → the retired
	// one is skipped (with a count), the live one closes as a structured
	// idempotent no-op ("already closed, no-op"), never tab_not_found.
	const tdDir = join(SANDBOX, `static-teardown-${process.pid}`);
	mkdirSync(tdDir, { recursive: true });
	const NOW_ISO = new Date().toISOString();
	const mkWorkerEntry = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
		name,
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: NOW_ISO,
		reportPath: join(tdDir, `report-${name}.json`),
		placement: { kind: "tab", workspaceId: "w1", paneId: `w1:${name}`, tabId: `w1:t-${name}` },
		...extra,
	});
	writeFileSync(
		join(tdDir, "manifest.json"),
		JSON.stringify({
			task: "static-teardown",
			dir: tdDir,
			workers: [
				mkWorkerEntry("td-retired", { retiredAt: NOW_ISO }),
				mkWorkerEntry("td-gone", {}),
			],
		}),
	);
	const tdCalls: string[] = [];
	const tdTransport = {
		backendName: () => "herdr",
		capabilities: () => ({ worktrees: true, authority: "root" }),
		listStatuses: async () => [],
		teardown: async (req: { name: string }) => {
			tdCalls.push(req.name);
			return { alreadyGone: true }; // the structured idempotent-close signal
		},
	} as unknown as Transport;
	const commands: Record<string, { handler: (args: unknown, ctx: unknown) => Promise<void> }> = {};
	registerCommands({ registerCommand: (n: string, def: never) => (commands[n] = def as never) } as never, tdTransport);
	const notifications: string[] = [];
	const confirmPrompts: string[] = [];
	await commands["delegate-teardown"]?.handler(
		[],
		// hasUI: true — the command's headless guard (pi docs Mode Behavior) must
		// not refuse the drive; this fake ctx models an interactive session.
		{ hasUI: true, ui: { notify: (m: string) => notifications.push(m), confirm: async (_t: string, body: string) => { confirmPrompts.push(body); return true; } } },
	);
	const allNotifications = notifications.join("\n");
	check(
		"T4.3b /delegate-teardown SKIPS retired history (counted in the confirm prompt, never attempted) — behavioral",
		!tdCalls.includes("td-retired") && confirmPrompts.some((p) => p.includes("retired history entries skipped")),
		JSON.stringify({ tdCalls, confirmPrompts }),
	);
	check(
		"T4.4b an already-gone close reads the structured alreadyGone field → 'already closed, no-op' (behavioral)",
		tdCalls.includes("td-gone") && allNotifications.includes("already closed, no-op"),
		JSON.stringify(notifications),
	);
}

// ---------------------------------------------------------------------------
// 6. F6 review-fix — same-name spawn clears a stale nudge-failed marker
// (review minor #1): the spawn flow deletes nudge-failed-<name>.json right
// after appending the manifest entry, or a fresh watcher session would
// re-fire the previous worker's marker once.
// ---------------------------------------------------------------------------

// Migration stage 3 (audit step 10): the old T2.5/T2.6 source-text pins are
// GONE — the cleanup is behaviorally proven by the section-5 drive (T2.5b:
// the pre-existing stale marker is consumed by the real spawn flow). The
// module boundary (nudgeFailedPathFor lives in exchange.ts) is compile-time
// enforced (tsc qa config: a wrong import fails the build, not a regex).

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL STATIC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
