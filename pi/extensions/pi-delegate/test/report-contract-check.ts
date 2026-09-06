/**
 * Report contract sentinel — the canon of the report shape lives in the code
 * (REPORT_EXAMPLE + briefPrompt), never in briefs; the validator (baseValidate)
 * is the enforcement reference.
 *
 * Run with: bun test/report-contract-check.ts   (from repo root)
 *
 * Covers:
 *   1. REPORT_EXAMPLE with the canonical worker name substituted for the
 *      placeholder passes validateReport (the extension's own validator).
 *   2. Regression (the failure class this contract fixes): a report whose
 *      evidence is an array of STRINGS must be rejected with an error naming
 *      the evidence item.
 *   3. briefPrompt carries the report contract: required-field rules, the
 *      verbatim "Extra fields allowed", and the canonical example with the
 *      worker name substituted.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport } from "../src/exchange.ts";
import { REPORT_EXAMPLE, WORKER_NAME_RE, briefPrompt } from "../src/transport/types.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NAME = "contract-w1";
check("sanity: test name matches WORKER_NAME_RE", WORKER_NAME_RE.test(NAME));

const root = mkdtempSync(join(tmpdir(), "report-contract-check-"));

// ---------------------------------------------------------------------------
// 1. canonical example (name substituted) passes validateReport
// ---------------------------------------------------------------------------

{
	// Substitute the canonical name for the placeholder, write to a temp file.
	const report = { ...REPORT_EXAMPLE, worker: NAME };
	const path = join(root, `report-${NAME}.json`);
	writeFileSync(path, JSON.stringify(report, null, "\t"), "utf8");
	const r = validateReport(path, NAME);
	check(
		"REPORT_EXAMPLE (worker substituted) → validateReport ok",
		r.ok && r.report.worker === NAME && r.report.status === "pass",
		JSON.stringify(r),
	);
}

// ---------------------------------------------------------------------------
// 2. regression: evidence as an array of strings must fail on the evidence item
// ---------------------------------------------------------------------------

{
	const bad = { ...REPORT_EXAMPLE, worker: NAME, evidence: ["did the thing"] };
	const path = join(root, "bad-evidence.json");
	writeFileSync(path, JSON.stringify(bad, null, "\t"), "utf8");
	const r = validateReport(path, NAME);
	check(
		"string evidence → rejected with evidence-item error",
		!r.ok && /evidence item/i.test(r.error),
		JSON.stringify(r),
	);
}

// ---------------------------------------------------------------------------
// 3. briefPrompt embeds the report contract
// ---------------------------------------------------------------------------

{
	const prompt = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const example = JSON.stringify({ ...REPORT_EXAMPLE, worker: NAME });

	check("briefPrompt: worker-name rule carries the canonical name", prompt.includes(`"worker" must be exactly "${NAME}"`));
	check("briefPrompt: status enum rule", prompt.includes('"status" strictly "pass" or "fail"'));
	check("briefPrompt: summary rule", prompt.includes('"summary" a non-empty string'));
	check("briefPrompt: artifacts rule", prompt.includes('"artifacts" an array of strings'));
	check("briefPrompt: evidence rule names claim+file", prompt.includes('"evidence" an array of objects, each with non-empty string "claim" and "file"'));
	check("briefPrompt: verbatim 'Extra fields allowed'", prompt.includes("Extra fields allowed"));
	check("briefPrompt: canonical example embedded, worker substituted", prompt.includes(example), `expected ${example}`);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
