/**
 * Collect-teardown matrix (v1.12.1, DESIGN.md §22) — teardown-after-collect.
 *
 * Run with: bun test/collect-teardown-check.ts   (from extensions/pi-delegate)
 *
 * The matrix drives the REAL delegate tool execute() against a mock transport
 * (test/collect-teardown-driver.ts, a child bun process per scenario so the
 * collect config resolves against a temp $HOME — bun caches os.homedir()).
 * Locked user decisions: default ON, grace 0, only on VALID collect, probes
 * keep their panes, foreign fleets never touched (collect is own-fleet by
 * construction).
 *
 *   C1  Config tolerance (child $HOME runs): missing → default TRUE;
 *       explicit false → false; explicit true → true; non-boolean garbage →
 *       default; corrupt JSON → default; coexists with the other sections.
 *   C2  Matrix (default config): valid collect → torn down EXACTLY once with
 *       plan/done audit lines + collectedAt stamped + advisory note; invalid
 *       report → never; pending mailbox question → never (collect still ok);
 *       probe → never; teardown throwing → collect STILL ok (advisory error
 *       line + audit trail, verdict untouched).
 *   C3  collect.teardownAfterCollect:false → valid collect, NOT torn down.
 *   C4  Static pins: the hook guards (probe / config / q-file) exist in the
 *       tool source and the audit mirror matches the /delegate-teardown
 *       format (same logTo shape + "(auto-after-collect)" marker).
 *   C5  W0 pin (rng-sum bug 3): startAgent throwing → E_START, the
 *       just-appended manifest entry is rolled back (no phantom row without
 *       sessionPath), a pre-seeded same-name worker survives untouched.
 * Exit 0 only if all checks pass.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT, resolveCollectConfig } from "../src/observe.ts";
import { TEARDOWN_LOG_NAME, teardownLogLine } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const DRIVER = join(ROOT, "test", "collect-teardown-driver.ts");

interface DriverOut {
	case: string;
	ok: boolean;
	code: string;
	probe: string;
	phase: string;
	teardownCalls: number;
	collectedStamped: boolean;
	teardownLog: string;
	workers: Array<{ name: string; paneId: string; hasSession: boolean }>;
	text: string;
}

/** Run one driver scenario with $HOME (and its config) set at spawn time. */
function drive(scenario: string, configJson?: string): DriverOut {
	const home = mkdtempSync(join(tmpdir(), "ct-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== undefined) writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
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
			probe: "",
			phase: "",
			teardownCalls: -1,
			collectedStamped: false,
			teardownLog: "",
			workers: [],
			text: `spawn failed: ${res.stderr.toString().slice(0, 400)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// C1. collect.teardownAfterCollect — tolerant resolution, default TRUE
// ---------------------------------------------------------------------------

{
	check("C1.0 default is TRUE (user-locked)", COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT === true);
	const home = mkdtempSync(join(tmpdir(), "ct-resolve-"));
	const mk = (configJson: string): boolean => {
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
		const src = `import {resolveCollectConfig} from ${JSON.stringify(new URL("../src/observe.ts", import.meta.url).pathname)}; console.log(JSON.stringify(resolveCollectConfig()))`;
		const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
		try {
			return (JSON.parse(res.stdout.toString().trim()) as { teardownAfterCollect: boolean }).teardownAfterCollect;
		} catch {
			return false;
		}
	};
	check("C1.1 no collect section → default true", mk("{}") === true, "");
	check("C1.2 explicit false honored", mk(JSON.stringify({ collect: { teardownAfterCollect: false } })) === false);
	check("C1.3 explicit true honored", mk(JSON.stringify({ collect: { teardownAfterCollect: true } })) === true);
	check("C1.4 non-boolean garbage → default true", mk(JSON.stringify({ collect: { teardownAfterCollect: "no" } })) === true);
	check("C1.5 corrupt JSON → default true, never throws", mk("{ not json ]") === true);
	check("C1.6 coexists with watch/tiers keys", mk(JSON.stringify({ watch: { intervalMs: 7000 }, tiers: {}, collect: { teardownAfterCollect: false } })) === false);
	rmSync(home, { recursive: true, force: true });
	// And the in-process resolver is total whatever this host's config says.
	check("C1.7 resolveCollectConfig() is total in-process", typeof resolveCollectConfig().teardownAfterCollect === "boolean");
}

// ---------------------------------------------------------------------------
// C2. The matrix (default config = ON)
// ---------------------------------------------------------------------------

{
	const valid = drive("valid");
	check(
		"C2.1 valid collect → torn down EXACTLY once",
		valid.ok && valid.teardownCalls === 1,
		`ok=${valid.ok} calls=${valid.teardownCalls} ${valid.text.slice(0, 200)}`,
	);
	check(
		"C2.2 the collect result carries the advisory auto-teardown note",
		valid.text.includes("Auto-teardown") && /torn down after collect/.test(valid.text) &&
			// Watcher stage A update (stale pin): the only allowed "Warning:" line
			// is the stage-A unrecorded-owner warning — the teardown driver's
			// sessionManager cannot produce a session id, so spawn (correctly)
			// warns that the watcher will not wake this session. Any OTHER
			// "Warning:" line is still a failure.
			!/^Warning: (?!could not read this session's id)/m.test(valid.text),
		valid.text.slice(-300),
	);
	check("C2.3 collectedAt stamped before teardown", valid.collectedStamped);
	check(
		"C2.4 audit trail: plan + done lines, commands.ts format + auto marker",
		/plan: teardown worker=\S+ kind=\S+ workspace=\S+ pane=\S+ \(auto-after-collect\)/.test(valid.teardownLog) &&
			/done: teardown worker=\S+ ok \(auto-after-collect\)/.test(valid.teardownLog),
		valid.teardownLog,
	);

	const invalid = drive("invalid");
	check(
		"C2.5 invalid report → E_REPORT_INVALID, pane kept (no teardown)",
		!invalid.ok && invalid.code === "E_REPORT_INVALID" && invalid.teardownCalls === 0 && !invalid.collectedStamped,
		`ok=${invalid.ok} code=${invalid.code} calls=${invalid.teardownCalls}`,
	);

	const qPending = drive("q-pending");
	check(
		"C2.6 pending mailbox question → collect ok, worker kept (no teardown)",
		qPending.ok && qPending.teardownCalls === 0 && qPending.collectedStamped && qPending.text.includes("Auto-teardown") === false,
		`ok=${qPending.ok} calls=${qPending.teardownCalls}`,
	);

	const probe = drive("probe");
	check(
		"C2.7 probe → terminal probe result, pane kept (no teardown, no stamp)",
		probe.probe === "fail" && probe.teardownCalls === 0 && !probe.collectedStamped,
		`probe=${probe.probe} calls=${probe.teardownCalls}`,
	);

	const boom = drive("teardown-throws");
	check(
		"C2.8 teardown throws → collect STILL succeeds (advisory contract)",
		boom.ok && boom.teardownCalls === 1 && /Warning: auto-teardown after collect failed \(herdr exploded\)/.test(boom.text),
		`ok=${boom.ok} ${boom.text.slice(-260)}`,
	);
	check(
		"C2.9 failed teardown is audited (error line) and the verdict text is untouched",
		/error: teardown worker=\S+ failed: herdr exploded \(auto-after-collect\)/.test(boom.teardownLog) &&
			/Report OK: status=pass/.test(boom.text),
		boom.teardownLog,
	);
}

// ---------------------------------------------------------------------------
// C3. Config OFF → valid collect, no teardown
// ---------------------------------------------------------------------------

{
	const off = drive("valid", JSON.stringify({ collect: { teardownAfterCollect: false } }));
	check(
		"C3.1 config off → valid collect, NOT torn down, no note",
		off.ok && off.teardownCalls === 0 && off.collectedStamped && !off.text.includes("Auto-teardown"),
		`ok=${off.ok} calls=${off.teardownCalls}`,
	);
	check("C3.2 config off → no audit lines written", off.teardownLog === "", off.teardownLog);
}

// ---------------------------------------------------------------------------
// C5. W0 pin (rng-sum bug 3): refused start rolls back the just-appended
//     phantom manifest entry; a pre-existing same-name worker survives
// ---------------------------------------------------------------------------

{
	const refused = drive("start-throws");
	check(
		"C5.1 startAgent throws → E_START",
		!refused.ok && refused.code === "E_START",
		`ok=${refused.ok} code=${refused.code}`,
	);
	check(
		"C5.2 no phantom entry: THIS call's pane (pane-1) has no manifest row",
		!refused.workers.some((w) => w.paneId === "pane-1"),
		JSON.stringify(refused.workers),
	);
	check(
		"C5.3 pre-existing same-name worker (own pane + sessionPath) survives — rollback is scoped to name+paneId, not name-only",
		refused.workers.length === 1 &&
			refused.workers[0].paneId === "pane-old" &&
			refused.workers[0].hasSession === true &&
			refused.workers[0].name.startsWith("ct-"),
		JSON.stringify(refused.workers),
	);
}

// ---------------------------------------------------------------------------
// C4. Static pins — the guards live in spawn.ts, the audit mirrors index.ts
// (commands.ts was absorbed into index.ts in W5)
// ---------------------------------------------------------------------------

{
	const src = readFileSync(resolve(ROOT, "src/spawn.ts"), "utf8");
	check(
		"C4.1 the hook skips probes, config-off and pending questions — in that order",
		/if \(isProbe\) return ""; \/\/ probes keep their panes this wave/.test(src) &&
			/!resolveCollectConfig\(\)\.teardownAfterCollect/.test(src) &&
			/readQuestion\(questionPathFor\(manifestDir, canonical\)\)/.test(src),
	);
	check(
		"C4.2 the hook runs only inside successResult (valid collect + collectedAt stamped)",
		// Migration stage 2 (audit step 6): the collectedAt write is now a
		// lifecycle REDUCER transition (stampCollected) — the pin moved from a
		// source-text ordering check to reducer ownership; the ordering itself
		// (stamp before teardown hook) is behaviorally pinned by C2 (the driver
		// asserts collectedStamped + the teardown note on the same result).
		src.includes("const teardownNote = await teardownAfterCollect();") &&
			src.includes("stampCollected(w, collectedAt)"),
	);
	check(
		"C4.3 teardown failure is advisory — no E_ code may come from the hook (try/catch, string notes)",
		/const teardownAfterCollect = async \(\): Promise<string> => \{/.test(src) &&
			/transport\.teardown\(\{ name: canonical, placement, force: true \}\);/.test(src) &&
			!/E_TEARDOWN/.test(src),
	);
	check(
		"C4.4 the teardown-audit trail is ONE shared convention: BOTH close paths (spawn auto-teardown + /delegate-teardown) append via the exchange.ts helpers (name + line format)",
		(() => {
			// Migration stage 1: the byte-identical appendFile template pin is
			// replaced by an import pin — spawn.ts and commands.ts must both append
			// with TEARDOWN_LOG_NAME + teardownLogLine from exchange.ts, so the two
			// sites cannot drift apart silently. (Wave 3 decomposition: the
			// /delegate-teardown command lives in src/commands.ts now — the pin
			// follows the code. C4.3's !/E_TEARDOWN/ stays: the
			// auto-teardown hook itself must stay advisory/no E_ code even though
			// the ADAPTER now has a dedicated E_TEARDOWN code.)
			const cmd = readFileSync(resolve(ROOT, "src/commands.ts"), "utf8");
			const usesHelper = (s: string) => s.includes("TEARDOWN_LOG_NAME") && s.includes("teardownLogLine(line)");
			return usesHelper(src) && usesHelper(cmd) && TEARDOWN_LOG_NAME === "teardown.log" && teardownLogLine("x").endsWith("x\n");
		})(),
	);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL COLLECT-TEARDOWN CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
