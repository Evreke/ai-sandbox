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
 *   B3  Prose mismatch fails: brief text naming report-impl.md (bare prose,
 *       the incident shape) with requested impl-ff2 → ok:false, the error
 *       quotes report-impl.md AND the canonical report-impl-ff2.json path.
 *       (D2 narrowing: a mention embedded in a filesystem path or URL is no
 *       longer a violation — see B11.4.)
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
 *   B9  A brief NOT following the brief-<stem>.md convention (e.g.
 *       task-notes.md) passes the stem check for any requested name — the
 *       deliberate skip is pinned so a future "strict stem for all .md
 *       briefs" change is a conscious decision.
 *   B10 Case rules (D5): a case-variant of the CANONICAL mention
 *       (report-impl-ff2.JSON) is VALID — it resolves to the canonical
 *       report; a case-variant of a NON-canonical name (report-OTHER.JSON)
 *       is a violation.
 *   B11 Legitimate context passes (D2): mentions inside a fenced code block,
 *       inside a URL, inside an inline backtick span, and embedded in a
 *       filesystem path are documentation/reference, not a report
 *       destination → ok:true.
 *   B12 Sibling-carve-out boundary: a report-<word>.json mention whose word
 *       is NOT a valid worker name (leading digit, uppercase) is a
 *       violation — the carve-out is exactly WORKER_NAME_RE.
 *   B14 Single-derivation invariant (D6): ensureExchangeDir no longer
 *       derives a report path — reportPathFor is the only derivation.
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
		"# task\n\nOUTPUT: write your report to report-impl.md\n",
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
		// D7 (report-mismatch critique): the loose 400-char proximity pin let an
		// unwired call site through (a comment or an unrelated fail("E_BRIEF")
		// block within 400 chars satisfied it). Pin the actual wiring shape:
		// the exact call signature, the contract.ok check, the E_BRIEF fail.
		"B8.2 a rejected contract returns the structured E_BRIEF failure (call signature + fail wiring pinned)",
		/validateBriefReportContract\(briefPath, params\.name, manifestDir\)[\s\S]{0,200}?!contract\.ok[\s\S]{0,200}?fail\(\s*"E_BRIEF"/.test(spawnSrc),
	);
}

// ---------------------------------------------------------------------------
// B9. A non-conventional brief filename passes the stem check
// ---------------------------------------------------------------------------

{
	const brief = writeBrief("task-notes.md", "# task\n\nOUTPUT: write the report.\n");
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check(
		"B9.1 a brief NOT following brief-<stem>.md passes the stem check for any requested name",
		v.ok,
		JSON.stringify(v),
	);
}

// ---------------------------------------------------------------------------
// B10. Case rules (D5): case-variant canonical is valid, non-canonical is not
// ---------------------------------------------------------------------------

{
	const okBrief = writeBrief("brief-impl-ff2.md", "# task\n\nOUTPUT: write report-impl-ff2.JSON\n");
	const v1 = validateBriefReportContract(okBrief, "impl-ff2", ROOT);
	check(
		"B10.1 a case-variant of the canonical mention is VALID (resolves to the canonical report)",
		v1.ok,
		JSON.stringify(v1),
	);
	const badBrief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: also read report-OTHER.JSON for the context table.\n",
	);
	const v2 = validateBriefReportContract(badBrief, "impl-ff2", ROOT);
	check(
		"B10.2 a case-variant of a NON-canonical report name is a violation",
		!v2.ok,
		JSON.stringify(v2),
	);
	check(
		"B10.3 the violation error quotes the case-variant mention verbatim",
		!v2.ok && v2.error.includes("report-OTHER.JSON"),
		!v2.ok ? v2.error : "",
	);
}

// ---------------------------------------------------------------------------
// B11. Legitimate prose context passes (D2 narrowing)
// ---------------------------------------------------------------------------

{
	const brief = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: write report-impl-ff2.json\n\n" +
			"Example report shape:\n```json\n{ \"file\": \"report-template.json\" }\n```\n\n" +
			"Full spec: https://example.com/report-summary.json\n" +
			"Quoted for later: `report-quoted.md`\n" +
			"The archive copy lives at /tmp/exchange/t/report-bydir.json\n",
	);
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check("B11.1 a mention inside a fenced code block passes (an example, not a destination)", v.ok, JSON.stringify(v));
	check("B11.2 a mention inside a URL passes", v.ok, JSON.stringify(v));
	check("B11.3 a mention inside an inline backtick span passes (a quoted path)", v.ok, JSON.stringify(v));
	check(
		"B11.4 a path-embedded mention (…/report-x.json) passes — the lookbehind rule (deliberate: layers 3+4 still catch a misdirected write)",
		v.ok,
		JSON.stringify(v),
	);
}

// ---------------------------------------------------------------------------
// B12. Sibling-carve-out boundary: the word must be a VALID worker name
// ---------------------------------------------------------------------------

{
	const brief = writeBrief("brief-impl-ff2.md", "# task\n\nOUTPUT: compare with report-2fast.json\n");
	const v = validateBriefReportContract(brief, "impl-ff2", ROOT);
	check(
		"B12.1 a sibling-shaped mention that is not a valid worker name (leading digit) → ok:false",
		!v.ok,
		JSON.stringify(v),
	);
	check(
		"B12.2 the error quotes the offending mention",
		!v.ok && v.error.includes("report-2fast.json"),
		!v.ok ? v.error : "",
	);
	const briefUpper = writeBrief(
		"brief-impl-ff2.md",
		"# task\n\nOUTPUT: compare with report-Upper_SIBLING.json\n",
	);
	const vUpper = validateBriefReportContract(briefUpper, "impl-ff2", ROOT);
	check(
		"B12.3 an uppercase-first name is not a valid sibling either (the carve-out is exactly [a-z][a-z0-9_-]{0,31})",
		!vUpper.ok,
		JSON.stringify(vUpper),
	);
}

// ---------------------------------------------------------------------------
// B14. Single-derivation invariant (D6): ensureExchangeDir derives no report path
// ---------------------------------------------------------------------------

{
	const exchangeSrc = readFileSync(resolve(import.meta.dir, "..", "src", "exchange.ts"), "utf8");
	const start = exchangeSrc.indexOf("export function ensureExchangeDir");
	const end = exchangeSrc.indexOf("// Manifest", start);
	const ensureBody = start >= 0 && end > start ? exchangeSrc.slice(start, end) : "";
	check(
		"B14.1 ensureExchangeDir no longer derives a report path (reportPathFor is the only derivation)",
		ensureBody.length > 0 && !/reportPathFor|reportPath/.test(ensureBody),
		ensureBody.slice(-300),
	);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL BRIEF-CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
