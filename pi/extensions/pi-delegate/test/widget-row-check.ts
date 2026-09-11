/**
 * T-widget-row — the ONE widget row assembly (Wave 2, Law 9).
 *
 * Run with: bun test/widget-row-check.ts   (from the extension dir)
 *
 * Wave 2 moved the ambient widget's row mapping verbatim from index.ts's
 * inline FleetUIDeps.getRows into fleet.ts's buildWidgetRows (the index.ts
 * copy of readManifestExtras + the mapping is deleted — one implementation
 * for widget and overlay). This check pins the widget path's field-by-field
 * behavior so the move cannot drift:
 *   R1  field mapping: name/status/kind/branch/reportExists come from the
 *       WorkerView; inputTokens/outputTokens from the worker's session JSONL
 *       (usage gauges); budgetPct = contextPct against the model's context
 *       window (unknown model → DEFAULT_CONTEXT_WINDOW); task = the exchange
 *       task slug (dir basename).
 *   R2  isProbe comes from isProbeDir(dir) — the dir-basename contract (the
 *       dir's basename must equal PROBE_DIR_SUFFIX exactly); the overlay's
 *       buildRow derives its probe flag from briefPath "" — the two paths
 *       are pinned separately and this check pins the WIDGET's.
 *   R3  lastPing = the newest parseable progress line (absent/corrupt file →
 *       undefined, never a throw).
 *   R4  ownership = classifyOwnership's fail-closed verdict: a manifest with
 *       the entry's orchestratorSessionPath === self.sessionFile is "mine";
 *       no owner data anywhere → NOT "mine".
 *   R5  tolerance: absent manifest / absent session file / absent ping →
 *       zeroed gauges, budgetPct still computed, never throws.
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { buildWidgetRows, type WorkerView } from "../src/fleet.ts";
import { progressPathFor, reportPathFor, PROBE_DIR_SUFFIX } from "../src/exchange.ts";
import { DEFAULT_CONTEXT_WINDOW, type Placement } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "widget-row-check-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;

const SELF = "/tmp/widget-row-self.jsonl";

const placement: Placement = {
	kind: "worktree",
	workspaceId: "w1",
	paneId: "w1:p1",
	branch: "delegate/w1",
	checkoutPath: "/tmp/wt/w1",
};

function view(dir: string, name: string, over: Partial<WorkerView> = {}): WorkerView {
	return {
		name,
		dir,
		status: "working",
		placement: { ...placement, checkoutPath: `/tmp/wt/${name}` },
		kind: "worktree",
		branch: `delegate/${name}`,
		reportPath: reportPathFor(dir, name),
		reportExists: true,
		startedAt: new Date().toISOString(),
		elapsedMs: 1000,
		...over,
	} as WorkerView;
}

function writeManifest(dir: string, task: string, workers: unknown[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ task, dir, workers }));
}

// --- R1/R2/R3/R4: the full happy path --------------------------------------

{
	const task = "t-main";
	const dir = join(SANDBOX, task);
	const sessionJsonl = join(dir, "session-w1.jsonl");
	mkdirSync(dir, { recursive: true });
	// One assistant turn with known usage (parseSessionUsage's input shape).
	writeFileSync(
		sessionJsonl,
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				model: "unknown-model", // → DEFAULT_CONTEXT_WINDOW
				usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
			},
		}) + "\n",
	);
	writeManifest(dir, task, [
		{
			name: "w1",
			sessionPath: sessionJsonl,
			orchestratorSessionPath: SELF,
			briefPath: `${dir}/brief-w1.md`,
			model: "unknown-model",
			placement,
			brief: "b",
			startedAt: new Date().toISOString(),
		},
	]);
	writeFileSync(
		progressPathFor(dir, "w1"),
		JSON.stringify({ worker: "w1", ts: new Date().toISOString(), phase: "working", pct: 42 }) + "\n",
	);

	const rows = await buildWidgetRows([view(dir, "w1")], { sessionFile: SELF, cwd: SANDBOX });
	const r = rows[0];
	check("R0 exactly one row per view, same order", rows.length === 1);
	check(
		"R1a identity fields come from the WorkerView (name/status/kind/branch/reportExists)",
		r?.name === "w1" && r?.status === "working" && r?.kind === "worktree" && r?.branch === "delegate/w1" && r?.reportExists === true,
		JSON.stringify(r),
	);
	check(
		"R1b usage gauges come from the worker's session JSONL",
		r?.inputTokens === 1000 && r?.outputTokens === 200,
		JSON.stringify({ in: r?.inputTokens, out: r?.outputTokens }),
	);
	check(
		"R1c budgetPct = contextPct against the model context window (unknown model → DEFAULT_CONTEXT_WINDOW), nullable",
		r?.budgetPct === Math.round((1200 / DEFAULT_CONTEXT_WINDOW) * 100),
		`${String(r?.budgetPct)} vs ${Math.round((1200 / DEFAULT_CONTEXT_WINDOW) * 100)}`,
	);
	check("R1d task = the exchange task slug (dir basename)", r?.task === task, String(r?.task));
	check(
		"R2 isProbe follows the DIR contract (basename *_probe) — a plain dir is no probe",
		r?.isProbe === false,
	);
	{
		// isProbeDir's contract: the dir's BASENAME equals PROBE_DIR_SUFFIX
		// ("_probe") exactly — one probe sandbox dir in this check.
		const pdir = join(SANDBOX, PROBE_DIR_SUFFIX);
		writeManifest(pdir, PROBE_DIR_SUFFIX, [
			{ name: "w-p", placement, briefPath: `${pdir}/brief-w-p.md`, startedAt: new Date().toISOString() },
		]);
		const prows = await buildWidgetRows([view(pdir, "w-p")], { sessionFile: SELF, cwd: SANDBOX });
		check("R2b a *_probe dir renders isProbe=true", prows[0]?.isProbe === true, JSON.stringify(prows[0]));
	}
	check(
		"R3 lastPing = the newest parseable progress event",
		r?.lastPing?.phase === "working" && r?.lastPing?.pct === 42,
		JSON.stringify(r?.lastPing),
	);
	check(
		"R4 ownership is the fail-closed verdict: the entry's orchestratorSessionPath === self → mine",
		r?.ownership === "mine",
		String(r?.ownership),
	);
}

// --- R4b: no owner data anywhere → NOT mine (fail-closed) -------------------

{
	const dir = join(SANDBOX, "t-orphan");
	writeManifest(dir, "t-orphan", [
		{ name: "w-orphan", placement, briefPath: `${dir}/brief.md`, startedAt: new Date().toISOString() },
	]);
	const rows = await buildWidgetRows([view(dir, "w-orphan")], { sessionFile: SELF, cwd: SANDBOX });
	check("R4b a worker with no owner fields never renders as mine", rows[0]?.ownership !== "mine", String(rows[0]?.ownership));
}

// --- R5: tolerance — absent everything --------------------------------------

{
	const dir = join(SANDBOX, "t-empty");
	mkdirSync(dir, { recursive: true }); // no manifest.json at all
	const rows = await buildWidgetRows([view(dir, "w-ghost")], { sessionFile: SELF, cwd: SANDBOX });
	const r = rows[0];
	check(
		"R5 absent manifest/session/ping → zeroed gauges, no ping marker, never throws",
		rows.length === 1 && r?.inputTokens === 0 && r?.outputTokens === 0 && r?.lastPing === undefined && r?.budgetPct !== undefined,
		JSON.stringify(r),
	);
}

rmSync(SANDBOX, { recursive: true, force: true });
if (failures > 0) {
	console.error(`\n${failures} widget-row check(s) FAILED`);
	process.exit(1);
}
console.log("\nALL WIDGET-ROW CHECKS PASSED");
