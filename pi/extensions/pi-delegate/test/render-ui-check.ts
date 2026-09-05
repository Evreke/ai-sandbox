/**
 * T6 — fleet UI contract checks (DESIGN.md §19.4).
 *
 * Run with: bun test/render-ui-check.ts   (from repo root)
 *
 * renderDelegateLines is pure (no ctx, no mutation) so it is unit-testable
 * headless: fake theme records fg calls. mountFleetUI/notifyFleetIdle headless
 * paths are checked via a stub ExtensionContext (hasUI: false).
 */

import { mountFleetUI, notifyFleetIdle, renderDelegateLines } from "../src/ui/fleet-ui.ts";
import { archiveRoot } from "../src/archive.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Fake theme: records (color, text) pairs, returns [color]<text>[/] markers.
type Call = { color: string; text: string };
function fakeTheme() {
	const calls: Call[] = [];
	return {
		calls,
		fg(color: string, text: string) {
			calls.push({ color, text });
			return `[${color}]${text}[/]`;
		},
	};
}

// ---------------------------------------------------------------------------
// renderDelegateLines — badges
// ---------------------------------------------------------------------------

{
	const th = fakeTheme();
	const lines = renderDelegateLines("delegate", "Report OK: status=pass — done", th);
	check("R1 success badge", lines[0].includes("[OK]") && lines[0].includes("[delegate]"), lines[0]);
	check("R1 success color", th.calls.some((c) => c.color === "success" && c.text === "[OK]"));
	check("R1 one headline line", lines.length === 1, String(lines.length));
}

{
	const th = fakeTheme();
	const lines = renderDelegateLines(
		"delegate",
		"E_REPORT_MISSING — worker x settled but no report file.\nTreat as a failed spawn.",
		th,
	);
	check("R2 error badge [E_REPORT_MISSING]", lines[0].includes("[E_REPORT_MISSING]"), lines[0]);
	check("R2 error color", th.calls.some((c) => c.color === "error" && c.text === "[E_REPORT_MISSING]"));
	check("R2 verdict headline", lines[0].includes("worker x settled but no report file"), lines[0]);
	check("R2 detail line wrapped", lines.length >= 2 && lines[1].includes("Treat as a failed spawn"), lines[1]);
}

{
	const th = fakeTheme();
	const lines = renderDelegateLines(
		"delegate",
		"E_TIMEOUT — worker x did not settle within 900000 ms (status working — the worker is still running).",
		th,
	);
	check("R3 timeout badge warning color", th.calls.some((c) => c.color === "warning" && c.text === "[E_TIMEOUT]"), JSON.stringify(th.calls));
	check("R3 headline contains verdict", lines[0].includes("did not settle"), lines[0]);
}

{
	const th = fakeTheme();
	const lines = renderDelegateLines(
		"delegate",
		"AWAITING_ANSWER — worker x is blocked on a question:\nWhich base ref?",
		th,
	);
	check("R4 awaiting badge", th.calls.some((c) => c.color === "warning" && c.text === "[AWAITING_ANSWER]"), JSON.stringify(th.calls));
	check("R4 headline keeps question", lines[0].includes("blocked on a question"), lines[0]);
}

// ---------------------------------------------------------------------------
// renderDelegateLines — herdr internals stripped from visible lines
// ---------------------------------------------------------------------------

{
	const th = fakeTheme();
	const raw =
		"Report OK: status=pass — done\npane_id=abc123 workspace_id=ws-9 terminal_id=t-1 evidence line";
	const lines = renderDelegateLines("delegate", raw, th);
	const visible = lines.join("\n");
	check(
		"R5 no pane_id/workspace_id/terminal_id in visible lines",
		!visible.includes("pane_id=") && !visible.includes("workspace_id=") && !visible.includes("terminal_id="),
		visible,
	);
	check("R5 placeholder present", visible.includes("<herdr ids in details>"), visible);
}

// ---------------------------------------------------------------------------
// renderDelegateLines — detail line cap (≤3 wrapped lines)
// ---------------------------------------------------------------------------

{
	const th = fakeTheme();
	const raw = ["Report OK: status=pass — done", ...Array.from({ length: 10 }, (_, i) => `detail word ${i} `.repeat(12))].join("\n");
	const lines = renderDelegateLines("delegate", raw, th);
	check("R6 ≤4 lines total (1 headline + 3 details)", lines.length <= 4, String(lines.length));
}

// ---------------------------------------------------------------------------
// notifyFleetIdle — headless no-op
// ---------------------------------------------------------------------------

{
	let notified = 0;
	const ctx = {
		hasUI: false,
		ui: {
			notify() {
				notified++;
			},
			setWidget() {},
			setFooter() {},
		},
	} as never;
	notifyFleetIdle(ctx, 3);
	check("N1 headless notifyFleetIdle is a no-op", notified === 0);
}

// ---------------------------------------------------------------------------
// mountFleetUI — headless no-op dispose
// ---------------------------------------------------------------------------

{
	let widgetCalls = 0;
	let footerCalls = 0;
	const ctx = {
		hasUI: false,
		ui: {
			setWidget() {
				widgetCalls++;
			},
			setFooter() {
				footerCalls++;
			},
			notify() {},
		},
	} as never;
	let refreshed = 0;
	const deps = {
		getRows: async () => {
			refreshed++;
			return [];
		},
		getPlacedCount: () => 0,
	};
	const dispose = mountFleetUI(ctx, deps);
	check("M1 headless mount does not touch ui", widgetCalls === 0 && footerCalls === 0);
	dispose();
	check("M1b headless dispose is safe", refreshed === 0);
}

// ---------------------------------------------------------------------------
// archiveRoot — contract import sanity (A6 not implemented yet → throws)
// ---------------------------------------------------------------------------

{
	let threw = false;
	try {
		archiveRoot();
	} catch {
		threw = true;
	}
	check("A1 archiveRoot importable (contract stub ok to throw until A6 lands)", true);
}

if (failures > 0) {
	console.error(`\n${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL FLEET-UI CHECKS PASSED");
