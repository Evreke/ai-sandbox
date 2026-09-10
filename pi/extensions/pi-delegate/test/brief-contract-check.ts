/**
 * Brief report-contract checks (report-path mismatch incident, 2026-09) —
 * the spawn-time fail-fast validation (design option a).
 *
 * Run with: bun test/brief-contract-check.ts   (from the extension dir)
 *
 * Bug class being fixed: an orchestrator hand-wrote a brief whose OUTPUT
 * section told the worker to write its report to a filename (report-impl.md)
 * different from the canonical name-derived path (report-<name>.json). Nothing
 * validated the mismatch; the worker obeyed the brief and every layer below
 * the prose responded with silence. Layer 1 makes the divergence impossible
 * at spawn time: a brief whose FILENAME stem or whose report-filename mentions
 * disagree with the canonical report-<name>.json is rejected with E_BRIEF
 * before any pane exists.
 *
 * Covers:
 *   B1  Stem mismatch fails: brief-impl.md vs requested name impl-ff2 →
 *       ok:false, the error names BOTH names.
 *   B2  Stem match passes: brief-impl-ff2.md + requested impl-ff2, no report
 *       mentions → ok:true.
 *   B3  Prose mismatch fails: brief text naming report-impl.md with requested
 *       impl-ff2 → ok:false, the error quotes report-impl.md AND the canonical
 *       report-impl-ff2.json path.
 *   B4  Canonical + sibling mentions pass: text naming report-impl-ff2.json
 *       plus a SIBLING worker's report-other.json (fan-out example) → ok:true
 *       — foreign worker reports are not this worker's concern.
 *   B5  Missing/unreadable brief never throws: ok:false with a readable error.
 *   B6  Non-canonical extension fails: report-impl-ff2.md (same stem, wrong
 *       extension) → ok:false — the canonical report is JSON only.
 *   B7  Sibling allowance boundary: report-other.md (a .md mention of another
 *       worker) is NOT a valid sibling report (reports are .json) → ok:false.
 *   B8  Spawn gate wiring (static pin): src/spawn.ts calls
 *       validateBriefReportContract BEFORE transport.place and rejects with
 *       E_BRIEF — the guard cannot be silently dropped.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateBriefReportContract } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = mkdtempSync(join(tmpdir(), "brief-contract-check-"));

function writeBrief(name: string, text: string): string {
	const p = join(ROOT, name);
	writeFileSync(p, text);
	return p;
}

// ---------------------------------------------------------------------------
// B1. Filename stem mismatch fails
// ---------------------------------------------------------------------------

{
	const brief = writeBrief("brief-impl.md", "# task\n\nOUTPUT: write the report.\n");
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B1.1 stem mismatch → ok:false", !v.ok, JSON.stringify(v));
	check(
		"B1.2 the error names BOTH the brief stem and the requested name",
		!v.ok && v.error.includes("impl") && v.error.includes("impl-ff2"),
		!v.ok ? v.error : "",
	);
}

// ---------------------------------------------------------------------------
// B2. Stem match passes
// ---------------------------------------------------------------------------

{
	const brief = writeBrief("brief-impl-ff2.md", "# task\n\nOUTPUT: write the report.\n");
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B2.1 stem match + no report mentions → ok:true", v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// B3. Prose mismatch fails (the incident shape)
// ---------------------------------------------------------------------------

{
	const brief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: write your report to /tmp/exchange/t/report-impl.md\n",
	);
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B3.1 prose naming a foreign report file → ok:false", !v.ok, JSON.stringify(v));
	check(
		"B3.2 the error quotes the offending mention AND the canonical path",
		!v.ok && v.error.includes("report-impl.md") && v.error.includes("report-impl-ff2.json"),
		!v.ok ? v.error : "",
	);
}

// ---------------------------------------------------------------------------
// B4. Canonical + sibling mentions pass
// ---------------------------------------------------------------------------

{
	const brief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: write report-impl-ff2.json. " +
			"For the shape, see the sibling worker's report-other.json (it collected first).\n",
	);
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B4.1 canonical mention + sibling .json mention → ok:true", v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// B5. Missing brief never throws
// ---------------------------------------------------------------------------

{
	const v = validateBriefReportContract(join(ROOT, "brief-nowhere.md"), "w", ROOT);
	check("B5.1 missing brief → ok:false, never throws", !v.ok, JSON.stringify(v));
	check("B5.2 the error is readable (names the path)", !v.ok && v.error.includes("brief-nowhere.md"), !v.ok ? v.error : "");
}

// ---------------------------------------------------------------------------
// B6. Wrong extension on the own name fails
// ---------------------------------------------------------------------------

{
	const brief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: write your report to report-impl-ff2.md\n",
	);
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B6.1 own-stem .md mention → ok:false (canonical report is .json)", !v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// B7. Sibling allowance is .json-only
// ---------------------------------------------------------------------------

{
	const brief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: see report-other.md for the narrative form.\n",
	);
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B7.1 a .md mention of another worker is not a valid sibling report → ok:false", !v.ok, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// B8. Spawn gate wiring (static pin)
// ---------------------------------------------------------------------------

{
	const spawnSrc = readFileSync(resolve(import.meta.dir, "..", "src", "spawn.ts"), "utf8");
	check(
		"B8.1 spawn.ts calls validateBriefReportContract before placement",
		/validateBriefReportContract\(/.test(spawnSrc) &&
			spawnSrc.indexOf("validateBriefReportContract(") < spawnSrc.indexOf("transport.place("),
	);
	check(
		"B8.2 a rejected contract returns the structured E_BRIEF failure",
		/validateBriefReportContract\([\s\S]{0,400}?E_BRIEF/.test(spawnSrc),
	);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL BRIEF-CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
