/**
 * A7 — fleet render/layout contract checks (quality fix).
 *
 * Run with: bun test/fleet-render-check.ts   (from repo root)
 *
 * Covers the previously untested pure layout core of ui/fleet.ts:
 *   - layoutFleetRows: wide values fit ≤ innerW; shrink priority
 *     branch → name → usage; floors respected; cells trunc/padded.
 *   - fitRow: offset-safety clip (§19) — header/legend can never push
 *     past the right border.
 *   - ui/text.ts helpers: fmtK pinned cases, trunc ellipsis + wide-char
 *     safety, stripAnsi.
 */

import {
	FLEET_FLOORS,
	fitRow,
	fleetUsageOf,
	layoutFleetRows,
	type FleetLayoutRow,
} from "../src/ui/fleet.ts";
import { fmtK, stripAnsi, trunc, visibleWidth } from "../src/ui/text.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function row(partial: Partial<FleetLayoutRow>): FleetLayoutRow {
	return {
		name: "worker-a",
		branch: "delegate/wa",
		input: 52_800,
		output: 34_900,
		percent: 62,
		budget: 110_000,
		...partial,
	};
}

/** Inner width consumed by one fitted row (must be ≤ innerW). */
function rowTotalW(l: { nameW: number; branchW: number; usageW: number }): number {
	return 1 + l.nameW + 1 + 7 + 1 + l.branchW + 1 + 1 + 1 + 2 + l.usageW;
}

// ---------------------------------------------------------------------------
// layoutFleetRows — wide values fit ≤ innerW
// ---------------------------------------------------------------------------

{
	const innerW = 78;
	const rows = [
		row({ name: "impl-fleet", branch: "impl/fleet-overlay", input: 52_800, output: 34_900, budget: 110_000 }),
		row({ name: "rev-quality", branch: "review/quality-axis", input: 959_200, output: 1_234_567, budget: 1_500_000 }),
	];
	const l = layoutFleetRows(rows, innerW);
	check(
		"L1 wide values fit ≤ innerW",
		rowTotalW(l) <= innerW,
		`total=${rowTotalW(l)} innerW=${innerW}`,
	);
	check("L1 usage compact form", l.cells[1].usage.includes("↑959k ↓1235k"), l.cells[1].usage);
	check(
		"L1 every cell visible width ≤ its column",
		l.cells.every(
			(c, i) =>
				visibleWidth(c.name) <= l.nameW &&
				visibleWidth(c.branch) <= l.branchW &&
				visibleWidth(c.usage) <= l.usageW,
		),
	);
}

// ---------------------------------------------------------------------------
// layoutFleetRows — shrink priority: branch → name → usage
// ---------------------------------------------------------------------------

{
	// Long name AND long branch: natural total = 1+18+1+7+1+18+1+1+1+2+27 = 78.
	// Narrow enough that branch must shrink but nothing else.
	const innerW = 70;
	const l = layoutFleetRows([row({ name: "impl-fleet-really-long-name", branch: "impl/very-long-branch-name" })], innerW);
	check("L2 branch shrinks first", l.branchW === 10, String(l.branchW));
	check("L2 name stays at natural cap", l.nameW === 18, String(l.nameW));
	check("L2 usage stays at natural cap", l.usageW === 27, String(l.usageW));
	check("L2 fits", rowTotalW(l) <= innerW, `total=${rowTotalW(l)} innerW=${innerW}`);
}

{
	// Narrower: branch is at its floor, so name must shrink next.
	const innerW = 65;
	const l = layoutFleetRows([row({ name: "impl-fleet-really-long-name", branch: "impl/very-long-branch-name" })], innerW);
	check("L3 branch at floor", l.branchW === FLEET_FLOORS.branch, String(l.branchW));
	check("L3 name shrinks second", l.nameW < 18 && l.nameW > FLEET_FLOORS.name, String(l.nameW));
	check("L3 usage still at cap", l.usageW === 27, String(l.usageW));
	check("L3 fits", rowTotalW(l) <= innerW, `total=${rowTotalW(l)} innerW=${innerW}`);
}

{
	// Extremely narrow: all three columns end at their floors.
	const innerW = rowTotalW({ nameW: 8, branchW: 6, usageW: 12 });
	const l = layoutFleetRows([row({ name: "impl-fleet-really-long-name", branch: "impl/very-long-branch-name" })], innerW);
	check(
		"L4 all floors respected",
		l.nameW === FLEET_FLOORS.name &&
			l.branchW === FLEET_FLOORS.branch &&
			l.usageW === FLEET_FLOORS.usage,
		`${l.nameW}/${l.branchW}/${l.usageW}`,
	);
	check("L4 fits exactly", rowTotalW(l) === innerW, `total=${rowTotalW(l)} innerW=${innerW}`);
	check("L4 usage truncated with ellipsis", l.cells[0].usage.endsWith("…"), l.cells[0].usage);
}

// ---------------------------------------------------------------------------
// fitRow — header/legend offset safety (§19)
// ---------------------------------------------------------------------------

{
	const innerW = 60;
	const longHeader = "pi-delegate fleet — 12 worker(s) — q to close — extra tail that overflows";
	const fitted = fitRow(longHeader, innerW);
	check("F1 header clipped to innerW", visibleWidth(fitted) === innerW, String(visibleWidth(fitted)));
	check("F1 header ellipsis", fitted.trimEnd().endsWith("…"), fitted);
	check(
		"F1 header fits before right border",
		visibleWidth(fitRow("short header", innerW)) === innerW,
	);
	const legend = "blocked→working→idle→done→unknown · ✓/✗ report on disk · Q?/A→ mailbox · 2s refresh";
	check("F2 legend clipped", visibleWidth(fitRow(legend, 40)) === 40, fitRow(legend, 40));
	// ANSI-colored content is clipped by visible width, not byte length.
	const ansi = "\x1b[36mcolored header text that is quite long and should be clipped\x1b[0m";
	check("F3 ANSI-aware clip", visibleWidth(fitRow(ansi, 20)) === 20, fitRow(ansi, 20));
	check("F3 ANSI bytes preserved", stripAnsi(fitRow(ansi, 20)).includes("colored"), fitRow(ansi, 20));
}

// ---------------------------------------------------------------------------
// fleetUsageOf — compact usage string
// ---------------------------------------------------------------------------

{
	check(
		"U1 usage string shape",
		fleetUsageOf({ input: 52_800, output: 34_900, percent: 62, budget: 110_000 }) ===
			"↑52.8k ↓34.9k (62% of 110k)",
		fleetUsageOf({ input: 52_800, output: 34_900, percent: 62, budget: 110_000 }),
	);
}

// ---------------------------------------------------------------------------
// ui/text.ts — fmtK pinned cases (divergent-duplicates unified)
// ---------------------------------------------------------------------------

{
	check("T1 fmtK 836", fmtK(836) === "836", fmtK(836));
	check("T2 fmtK 9592", fmtK(9592) === "9.6k", fmtK(9592));
	check("T3 fmtK 18517", fmtK(18_517) === "18.5k", fmtK(18_517));
	check("T4 fmtK 150000", fmtK(150_000) === "150k", fmtK(150_000));
	check("T5 fmtK 0", fmtK(0) === "0", fmtK(0));
	check("T6 fmtK 999", fmtK(999) === "999", fmtK(999));
	check("T7 fmtK 1000", fmtK(1000) === "1k", fmtK(1000));
	check("T8 fmtK negative", fmtK(-5) === "0", fmtK(-5));
	check("T9 fmtK non-finite", fmtK(Number.NaN) === "0", fmtK(Number.NaN));
}

// ---------------------------------------------------------------------------
// ui/text.ts — trunc (wide-char safe) + stripAnsi
// ---------------------------------------------------------------------------

{
	check("V1 trunc short", trunc("hello", 10) === "hello", trunc("hello", 10));
	check("V2 trunc ellipsis", trunc("hello world", 8) === "hello w…", trunc("hello world", 8));
	check("V3 trunc zero width", trunc("hello", 0) === "", trunc("hello", 0));
	check("V4 trunc wide chars", trunc("日本語", 3) === "日…", trunc("日本語", 3));
	check("V5 trunc wide exact fit", trunc("日本", 4) === "日本", trunc("日本", 4));
	check(
		"V6 trunc never exceeds width (wide)",
		visibleWidth(trunc("日本語テスト", 5)) <= 5,
		String(visibleWidth(trunc("日本語テスト", 5))),
	);
	check("V7 stripAnsi", stripAnsi("\x1b[31mred\x1b[0m plain") === "red plain", stripAnsi("\x1b[31mred\x1b[0m plain"));
	check("V8 visibleWidth wide", visibleWidth("日本") === 4, String(visibleWidth("日本")));
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
