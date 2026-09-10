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
 *   CS4  Same-name respawn (D4): the manifest already holds a prior entry for
 *        the name — with the canonical report STALE (mtime predates the new
 *        startedAt), collect must NOT adopt it (E_REPORT_MISSING naming the
 *        file); with a FRESH canonical report it IS adopted as before.
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

// ---------------------------------------------------------------------------
// CS4. Same-name respawn: the canonical path is fenced too (D4)
// ---------------------------------------------------------------------------

{
	const stale = drive("respawn-stale");
	check("CS4.1 respawn + stale canonical report → NOT a success", !stale.ok, stale.text.slice(0, 200));
	check(
		"CS4.2 the stale report is NOT silently adopted — the failure names it",
		stale.text.includes("report-cs-") || /report-[A-Za-z0-9_-]+\.json/.test(stale.text),
		stale.text.slice(0, 400),
	);
	check("CS4.3 the failure is a MISSING report for this run (not a silent adoption)", stale.code === "E_REPORT_MISSING", stale.code);
	check(
		"CS4.4 the failure says why: the report predates this spawn (earlier same-name run)",
		/predates this spawn|stale/.test(stale.text),
		stale.text.slice(0, 400),
	);

	const fresh = drive("respawn-fresh");
	check(
		"CS4.5 respawn + FRESH canonical report → still adopted (no behavior change)",
		fresh.ok,
		fresh.text.slice(0, 300),
	);
}

// ---------------------------------------------------------------------------
// B13. Probe spawns skip brief validation entirely (the !isProbe gate)
// ---------------------------------------------------------------------------

{
	const probe = drive("probe-mismatch");
	check(
		"B13.1 a probe with a deliberately contract-violating brief still reaches its verdict (no E_BRIEF)",
		probe.code !== "E_BRIEF" && !probe.text.includes("report contract violation"),
		`${probe.code} — ${probe.text.slice(0, 300)}`,
	);
	check("B13.2 the probe verdict is a PASS (smoke marker verified)", probe.ok && /probe OK/.test(probe.text), probe.text.slice(0, 300));
}

console.log(failures === 0 ? "\nALL COLLECT-SCAN CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
