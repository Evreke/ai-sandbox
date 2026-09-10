/**
 * Collect-scan matrix (report-path mismatch incident, 2026-09) — the loose
 * candidate scan wired into collectReport/settleProof (design option e).
 *
 * Run with: bun test/collect-scan-check.ts   (from the extension dir)
 *
 * The matrix drives the REAL delegate tool execute() against a mock transport
 * (test/collect-scan-driver.ts, a child bun process per scenario so the
 * exchange root sandboxes via $PI_DELEGATE_EXCHANGE_ROOT):
 *
 *   CS1  Sibling safety: with the canonical report absent and a sibling
 *        worker's VALID report-sib.json present, collect does NOT adopt it
 *        (the worker-field check rejects it) and the failure message NAMES
 *        report-sib.json as found evidence — loud, never adopted.
 *   CS2  Incident shape: with a Markdown report-<name>.md present instead of
 *        the canonical JSON, the failure message NAMES the .md file — the
 *        found-but-unvalidatable artifact is evidence, not silence.
 *   CS3  Fallback via the scan: with the host-uniquified canonical name and
 *        the worker having written report-<requested>.json, collect adopts it
 *        (worker field = canonical) with the fallback note — same behavior as
 *        before the fix, now through the directory scan.
 *
 * Exit 0 only if all checks pass.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const DRIVER = join(ROOT, "test", "collect-scan-driver.ts");

interface DriverOut {
	case: string;
	ok: boolean;
	code: string;
	text: string;
}

/** Run one driver scenario with $HOME set at spawn time. */
function drive(scenario: string): DriverOut {
	const home = mkdtempSync(join(tmpdir(), "cs-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	const res = spawnSync("bun", [DRIVER, scenario], {
		env: { ...process.env, HOME: home },
		encoding: "utf8",
		timeout: 120_000,
	});
	rmSync(home, { recursive: true, force: true });
	const line = (res.stdout.toString().split("\n").find((l) => l.startsWith("{")) ?? "").trim();
	try {
		return JSON.parse(line) as DriverOut;
	} catch {
		return {
			case: scenario,
			ok: false,
			code: "DRIVER_CRASH",
			text: `spawn failed: ${res.stderr.toString().slice(0, 400)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// CS1. Sibling report is named, never adopted
// ---------------------------------------------------------------------------

{
	const r = drive("sibling");
	check("CS1.1 sibling report present + canonical absent → NOT a success", !r.ok, r.text.slice(0, 200));
	check(
		"CS1.2 the failure names the sibling report as found evidence",
		r.text.includes("report-sib.json"),
		r.text.slice(0, 400),
	);
	check("CS1.3 it is a structured report-invalid failure (found but not adopted)", r.code === "E_REPORT_INVALID", r.code);
}

// ---------------------------------------------------------------------------
// CS2. Markdown stray is named, loudly
// ---------------------------------------------------------------------------

{
	const r = drive("stray-md");
	check("CS2.1 stray .md + canonical absent → NOT a success", !r.ok, r.text.slice(0, 200));
	check(
		"CS2.2 the failure is report-invalid and names a stray .md report (found evidence, never silence)",
		r.code === "E_REPORT_INVALID" && /report-[A-Za-z0-9_-]+\.md/.test(r.text),
		`${r.code} — ${r.text.slice(0, 400)}`,
	);
}

// ---------------------------------------------------------------------------
// CS3. Fallback adoption through the scan
// ---------------------------------------------------------------------------

{
	const r = drive("fallback");
	check("CS3.1 uniquified name + requested-name report → collect succeeds", r.ok, r.text.slice(0, 300));
	check(
		"CS3.2 the success notes the fallback path",
		/report collected from/.test(r.text),
		r.text.slice(0, 400),
	);
}

console.log(failures === 0 ? "\nALL COLLECT-SCAN CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
