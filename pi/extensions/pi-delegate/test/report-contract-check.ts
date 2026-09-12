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
 *   4. briefPrompt echoes a brief-declared reportSchema fragment (§16–§17):
 *      absent/null fragment → prompt identical to base-only; present fragment →
 *      serialized schema + task-specific mandate appended, base intact.
 *   5. W0 pin (rng-sum bug 1): the precedence clause — the report contract
 *      ALWAYS overrides the brief on format/shape — is present verbatim, with
 *      and without a schema fragment, and positioned BEFORE the example and
 *      the schema echo (the worker must read the override first).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport } from "../src/exchange.ts";
import {
	REPORT_EXAMPLE,
	WORKER_NAME_RE,
	briefPrompt,
} from "../src/host.ts";

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
	// fix-report-heal (2026-09-12, the dice-two incident): flash-class models
	// drift to the conversational "done" despite the enum rule — the prompt
	// names the anti-examples explicitly and states the consequence.
	check(
		"briefPrompt: status anti-example pins done/ok/success as rejected at collect",
		prompt.includes(
			'(never "done"/"ok"/"success" — a report with any other status is rejected at collect and wakes your orchestrator)',
		),
		prompt.slice(prompt.indexOf('"status"'), prompt.indexOf('"status"') + 220),
	);
}

// ---------------------------------------------------------------------------
// 4. briefPrompt echoes a brief-declared reportSchema fragment (v1.5)
// ---------------------------------------------------------------------------

{
	const fragment = {
		type: "object",
		properties: { changes: { type: "array", minItems: 1 } },
		required: ["changes"],
	};
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const withSchema = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, fragment);
	const withNull = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, null);
	const example = JSON.stringify({ ...REPORT_EXAMPLE, worker: NAME });

	check(
		"briefPrompt without fragment: identical to base-only prompt",
		withSchema !== base && withNull === base,
	);
	check(
		"briefPrompt with fragment: serialized schema echoed verbatim",
		withSchema.includes(JSON.stringify(fragment)),
	);
	check(
		"briefPrompt with fragment: task-specific mandate present",
		withSchema.includes("MUST also satisfy this JSON schema") && withSchema.includes("Extra fields still allowed unless the fragment says otherwise"),
	);
	check(
		"briefPrompt with fragment: base contract still intact (worker name + canonical example)",
		withSchema.includes(`"worker" must be exactly "${NAME}"`) && withSchema.includes(example),
	);
}

// ---------------------------------------------------------------------------
// 5. W0 pin (rng-sum bug 1): the precedence clause in briefPrompt —
//    the contract ALWAYS overrides the brief on report format/shape
// ---------------------------------------------------------------------------

{
	const CLAUSE =
		"Report contract — this contract ALWAYS overrides the brief on report format/shape: " +
		"if the brief's OUTPUT section specifies a different report shape, keep ALL required contract fields " +
		"anyway and put the brief-specific data in extra fields.";
	const fragment = { type: "object", properties: { changes: { type: "array" } } };
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const withSchema = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, fragment);

	check("briefPrompt: precedence clause present verbatim (contract ALWAYS overrides the brief)", base.includes(CLAUSE));
	check("briefPrompt: precedence clause survives a brief-declared schema fragment", withSchema.includes(CLAUSE));
	check(
		"briefPrompt: clause positioned BEFORE the canonical example (override read first)",
		base.indexOf(CLAUSE) !== -1 && base.indexOf(CLAUSE) < base.indexOf("Canonical example"),
	);
	check(
		"briefPrompt: clause positioned BEFORE the task-specific schema echo (base contract always first)",
		withSchema.indexOf(CLAUSE) !== -1 && withSchema.indexOf(CLAUSE) < withSchema.indexOf("Task-specific report schema"),
	);
	check(
		"briefPrompt: clause carries the escape hatch (extra fields) + the override trigger (brief OUTPUT section)",
		/keep ALL required contract fields anyway/.test(base) && /brief-specific data in extra fields/.test(base),
	);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
