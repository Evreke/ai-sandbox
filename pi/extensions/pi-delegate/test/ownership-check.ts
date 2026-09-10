/**
 * fleet-UX wave 2, stage 1 — ownership display contract checks.
 *
 * Run with: bun test/ownership-check.ts   (from extensions/pi-delegate)
 *
 * Covers:
 *   - classifyOwnership (src/fleet.ts, SECTION 1): the ~8 cases pinned by
 *     report-ux-own.json — fail-closed display (unknown never mine), the
 *     degraded-self-id worktree fallback, tabs never matched by cwd.
 *   - foldLiveByOwnership + renderLiveRows (src/fleet.ts, SECTION 3): the
 *     attention-gated widget fold — fixture-shaped input (2 foreign working,
 *     ~60% ctx) renders NOTHING; blocked or ctx≥80 earns exactly one line
 *     per class (≤2 total); idle/done excluded; all-mine fleet byte-identical.
 */

import { classifyOwnership, OWNERSHIP_GLYPH, foldLiveByOwnership, renderLiveRows } from "../src/fleet.ts";
import { clampLines, visibleWidth, type FleetWidgetRow as FleetRow } from "../src/fleet.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Fake theme, same shape as test/render-ui-check.ts: returns [color]text[/].
function fakeTheme() {
	return {
		fg(color: string, text: string) {
			return `[${color}]${text}[/]`;
		},
	};
}

const MINE = "/home/u/.pi/agent/sessions/--home-u-proj--/s-orch.jsonl";
const OTHER = "/home/u/.pi/agent/sessions/--home-u-other--/s-other.jsonl";

// ---------------------------------------------------------------------------
// classifyOwnership — per report-ux-own.json case list
// ---------------------------------------------------------------------------

{
	const worktree = { kind: "worktree", checkoutPath: "/home/u/proj" };
	const tab = { kind: "tab", checkoutPath: "/home/u/proj" };
	const self = { sessionFile: MINE, cwd: "/home/u/proj" };

	check("O1 equal → mine", classifyOwnership(MINE, self, worktree) === "mine");
	check("O2 present+different → foreign", classifyOwnership(OTHER, self, worktree) === "foreign");
	check(
		"O3 undefined (legacy) → unknown",
		classifyOwnership(undefined, self, worktree) === "unknown",
	);
	check("O4 empty string (legacy) → unknown", classifyOwnership("", self, worktree) === "unknown");
	check(
		"O5 degraded self-id + worktree checkoutPath===cwd → mine",
		classifyOwnership(undefined, { cwd: "/home/u/proj" }, worktree) === "mine",
	);
	check(
		"O6 tab + cwd match is NOT mine (tabs never matched by cwd)",
		classifyOwnership(undefined, { cwd: "/home/u/proj" }, tab) === "unknown",
	);
	check("O7 tab + different session → foreign", classifyOwnership(OTHER, self, tab) === "foreign");
	check(
		"O8 long/odd paths: exact compare, no normalization",
		classifyOwnership(`/deep/${"x".repeat(200)}/s.jsonl`, { sessionFile: `/deep/${"x".repeat(200)}/s.jsonl` }, tab) ===
			"mine" && classifyOwnership(`${MINE} `, self, tab) === "foreign",
	);
	check(
		"O9 owner present but self.sessionFile unknown → UNKNOWN (fail-closed)",
		classifyOwnership(OTHER, { cwd: "/home/u/proj" }, tab) === "unknown" &&
			classifyOwnership(OTHER, {}, worktree) === "unknown",
	);
	check(
		"O10 degraded self + worktree checkoutPath DIFFERENT cwd → unknown",
		classifyOwnership(undefined, { cwd: "/elsewhere" }, worktree) === "unknown",
	);
	check(
		"O11 glyphs are 1 column each (outside text.ts wide ranges)",
		[OWNERSHIP_GLYPH.mine, OWNERSHIP_GLYPH.foreign, OWNERSHIP_GLYPH.unknown].every(
			(g) => visibleWidth(g) === 1,
		),
	);
}

// ---------------------------------------------------------------------------
// foldLiveByOwnership — attention-gated widget fold
// ---------------------------------------------------------------------------

/** Fixture-shaped rows (prod-prep): 2 foreign live, working, ~60% ctx. */
function fixtureRows(): FleetRow[] {
	return [
		{ name: "sec-impl", status: "working", kind: "worktree", inputTokens: 38_400, outputTokens: 21_700, budgetPct: 44, ownership: "foreign", task: "prod-prep" },
		{ name: "ux-impl", status: "working", kind: "worktree", inputTokens: 41_200, outputTokens: 18_900, budgetPct: 63, ownership: "foreign", task: "prod-prep" },
	];
}

{
	// THE fixture case: quiet foreign fleet → widget shows NOTHING foreign.
	check(
		"F1 fixture-shaped input (working, ~60%) → no fold line",
		foldLiveByOwnership(fixtureRows()).length === 0,
		JSON.stringify(foldLiveByOwnership(fixtureRows())),
	);
	check(
		"F1b …and renderLiveRows renders nothing (no mine rows either)",
		renderLiveRows(fixtureRows(), fakeTheme() as never).length === 0,
	);
}

{
	// blocked → exactly ONE line, muted, correct count + task list.
	const rows = fixtureRows();
	rows[0].status = "blocked";
	const fold = foldLiveByOwnership(rows);
	check(
		"F2 blocked foreign → exactly 1 line",
		fold.length === 1 && fold[0].text === "○ 2 foreign live (prod-prep)" && fold[0].color === "muted",
		JSON.stringify(fold),
	);
}

{
	// ctx ≥ CONTEXT_WARN_PCT (80) → exactly ONE line.
	const rows = fixtureRows();
	rows[1].budgetPct = 80;
	const fold = foldLiveByOwnership(rows);
	check(
		"F3 ctx≥80 foreign → exactly 1 line",
		fold.length === 1 && fold[0].text === "○ 2 foreign live (prod-prep)",
		JSON.stringify(fold),
	);
}

{
	// idle/done foreign workers never fold in (live set only).
	const idle: FleetRow = { name: "sec-audit", status: "idle", kind: "tab", inputTokens: 0, outputTokens: 0, budgetPct: null, ownership: "foreign", task: "prod-prep" };
	const done: FleetRow = { name: "ux-research", status: "done", kind: "tab", inputTokens: 0, outputTokens: 0, budgetPct: null, ownership: "foreign", task: "prod-prep" };
	check(
		"F4 idle/done excluded — even idle+blocked-flag-free sets render nothing",
		foldLiveByOwnership([idle, done]).length === 0,
	);
	const rows = fixtureRows();
	rows[0].status = "blocked";
	rows.push(idle, done);
	const lines = renderLiveRows(rows, fakeTheme() as never);
	check(
		"F4b blocked line counts LIVE workers only (2, not 4) — via renderLiveRows",
		lines.length === 1 && lines[0] === "[muted]○ 2 foreign live (prod-prep)[/]",
		JSON.stringify(lines),
	);
}

{
	// Legacy (unknown) class: own dim line; both classes together → ≤2 lines.
	const legacy: FleetRow[] = [
		{ name: "old-a", status: "blocked", kind: "worktree", inputTokens: 0, outputTokens: 0, budgetPct: null, task: "legacy-task" },
		{ name: "old-b", status: "working", kind: "worktree", inputTokens: 0, outputTokens: 0, budgetPct: null, ownership: "unknown", task: "legacy-task" },
	];
	const fold = foldLiveByOwnership(legacy);
	check(
		"F5 legacy blocked → dim line (ownership absent degrades to legacy class)",
		fold.length === 1 && fold[0].text === "◌ 2 legacy live (legacy-task)" && fold[0].color === "dim",
		JSON.stringify(fold),
	);
	const both = [...fixtureRows(), ...legacy];
	both[0].status = "blocked";
	const fold2 = foldLiveByOwnership(both);
	check(
		"F5b both classes → exactly 2 lines (≤2 total), foreign before legacy",
		fold2.length === 2 && fold2[0].text === "○ 2 foreign live (prod-prep)" && fold2[1].text === "◌ 2 legacy live (legacy-task)",
		JSON.stringify(fold2),
	);
	const quietBoth = [...fixtureRows(), ...legacy.slice(1)]; // legacy worker quiet
	check(
		"F5c quiet classes stay silent even when both present",
		foldLiveByOwnership([...fixtureRows(), { ...legacy[1], status: "working" }]).length === 0,
	);
}

{
	// All-mine fleet: rows byte-identical to the pre-fold renderer (goldens).
	const th = fakeTheme();
	const mine: FleetRow[] = [
		{ name: "impl-a", status: "working", kind: "worktree", inputTokens: 52_800, outputTokens: 34_900, budgetPct: 44, ownership: "mine", task: "fleet-ux" },
		{ name: "impl-b", status: "blocked", kind: "tab", inputTokens: 9_592, outputTokens: 1_817, budgetPct: 83, lastPing: { phase: "coding" }, ownership: "mine", task: "fleet-ux" },
	];
	const expected = [
		"[accent]▲ impl-a working ↑52.8k ↓34.9k 44% of budget[/]",
		"[error]▲ impl-b blocked ↑9.6k ↓1.8k 83% of budget [ping: coding][/]",
	];
	const lines = renderLiveRows(mine, th as never);
	check(
		"F6 all-mine fleet → byte-identical rows (goldens), no fold lines",
		lines.length === 2 && lines[0] === expected[0] && lines[1] === expected[1],
		JSON.stringify(lines),
	);
	// Foreign rows present but quiet → mine rows unchanged, nothing added.
	const mixed = [...mine, ...fixtureRows()];
	const mixedLines = renderLiveRows(mixed, th as never);
	check(
		"F6b mixed fleet, no signals → mine rows byte-identical + no fold lines",
		mixedLines.length === 2 && mixedLines[0] === expected[0] && mixedLines[1] === expected[1],
		JSON.stringify(mixedLines),
	);
}

{
	// Width safety: fold lines route through the widget's clampLines (v1.8b).
	const rows = fixtureRows();
	rows[0].status = "blocked";
	rows[0].task = "an-extremely-long-task-slug-that-keeps-going";
	const fold = foldLiveByOwnership(rows);
	const clamped = clampLines(fold.map((f) => f.text), 30);
	check(
		"F7 fold line clamps to terminal width, never throws",
		clamped.length === 1 && visibleWidth(clamped[0]) <= 30,
		JSON.stringify(clamped),
	);
	check("F8 degenerate widths never throw", clampLines(fold.map((f) => f.text), 0).length === 1);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL OWNERSHIP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
