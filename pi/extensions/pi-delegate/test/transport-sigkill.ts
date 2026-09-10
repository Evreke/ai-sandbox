/**
 * T-SK — SIGKILL escalation in runHerdr (2026-09-09 herdr incident follow-up).
 *
 * Run with: bun test/transport-sigkill.ts   (from repo root; NO live herdr
 * needed — every case runs against stub `herdr` CLIs on a prepended PATH).
 *
 * Problem: the old promisified-execFile runHerdr sent SIGTERM on timeout only.
 * A herdr build with a graceful-shutdown SIGTERM handler survives the timeout
 * forever → the runHerdr promise NEVER settles → the HerdrTransport
 * serialized-mutations queue stalls behind it (reproduced: h3-queue-stall).
 *
 * Checks:
 *   SK.1 Normal path: zero-exit stub with a JSON line → resolves, result parses.
 *   SK.2 Hang stub, default SIGTERM disposition → rejects at ~timeoutMs (execFile
 *        parity: SIGTERM kills it, wrapper error shape preserved).
 *   SK.3 THE FIX: silent-trap stub (graceful-shutdown-handler shape — ignores
 *        SIGTERM) → still rejected: SIGTERM at timeoutMs, SIGKILL at
 *        timeoutMs+SIGKILL_GRACE_MS, promise rejected shortly after the timeout,
 *        stub process verified DEAD (escalation actually landed).
 *
 * Cleanup: every stub it spawns is verified dead or killed in `finally`;
 * the stub dir is removed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHerdr, parseHerdrResult, SIGKILL_GRACE_MS } from "../src/transport.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ART = mkdtempSync(`${tmpdir()}/pi-delegate-sigkill-`);
const STUB_DIR = join(ART, "bin");
mkdirSync(STUB_DIR, { recursive: true });
const PIDFILE = join(ART, "stub.pid");

// Dispatcher: the test's PATH points here; $STUB_SCRIPT picks the stub shape.
writeFileSync(join(STUB_DIR, "herdr"), `#!/usr/bin/env node\nrequire(process.env.STUB_SCRIPT);\n`, { mode: 0o755 });
// SK.1: prints a valid herdr JSON result, exits 0.
writeFileSync(
	join(STUB_DIR, "ok.js"),
	`process.stdout.write(JSON.stringify({ id: "s", result: { agent: { name: "ok", agent_status: "idle" } } }) + "\\n");\n`,
);
// SK.2: hangs (default SIGTERM disposition kills it at the timeout).
writeFileSync(join(STUB_DIR, "hang.js"), `setInterval(() => {}, 1 << 30);\n`);
// SK.3: traps SIGTERM SILENTLY (graceful-handler shape), writes its pid, never exits.
writeFileSync(
	join(STUB_DIR, "trap.js"),
	[
		`const fs = require("node:fs");`,
		`fs.writeFileSync(process.env.SK_PIDFILE, String(process.pid));`,
		`process.on("SIGTERM", () => { fs.appendFileSync(process.env.SK_PIDFILE, "\\nTRAPPED"); });`,
		`setInterval(() => {}, 1 << 30);`,
	].join("\n"),
);

// PATH override BEFORE any spawn: runHerdr resolves `herdr` at spawn time.
process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
process.env.STUB_SCRIPT = "";
process.env.SK_PIDFILE = PIDFILE;

const stubPid = (): number | null => {
	try {
		const raw = readFileSync(PIDFILE, "utf8").split("\n")[0];
		return raw ? Number(raw) : null;
	} catch {
		return null;
	}
};
const stubAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const setStub = (name: string) => {
	process.env.STUB_SCRIPT = join(STUB_DIR, name);
	try {
		rmSync(PIDFILE, { force: true });
	} catch { /* absent is fine */ }
};

async function run() {
	const T = 2_000;

	// SK.1 — normal path unchanged
	{
		setStub("ok.js");
		const t0 = Date.now();
		const { stdout } = await runHerdr(["agent", "list"], T);
		const { result } = parseHerdrResult(stdout);
		check(
			"SK.1 zero-exit stub resolves and parses",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle" && Date.now() - t0 < T,
		);
	}

	// SK.2 — default-SIGTERM hang: parity with the old execFile timeout
	{
		setStub("hang.js");
		const t0 = Date.now();
		let rejectedAt = -1;
		let killedFlag: unknown;
		try {
			await runHerdr(["agent", "list"], T);
		} catch (err) {
			rejectedAt = Date.now() - t0;
			// killed/signal live on the CAUSE (exec-like error), same as the old
			// promisified-execFile shape (the wrapper adds message/details on top)
			killedFlag = (err as { cause?: { killed?: boolean } }).cause?.killed;
		}
		check("SK.2 hang stub rejects near the timeout", rejectedAt >= T && rejectedAt < T + 1_500, `rejectedAt=${rejectedAt}`);
		check("SK.2 rejection carries killed=true", killedFlag === true);
	}

	// SK.3 — THE FIX: SIGTERM-trapping stub is still terminated (SIGKILL escalation)
	{
		setStub("trap.js");
		const t0 = Date.now();
		let rejectedAt = -1;
		let message = "";
		try {
			await runHerdr(["agent", "list"], T);
		} catch (err) {
			rejectedAt = Date.now() - t0;
			message = (err as Error).message;
		}
		check(
			`SK.3 trap stub rejects at ~timeoutMs (not ${T}+${SIGKILL_GRACE_MS} later)`,
			rejectedAt >= T && rejectedAt < T + 1_500,
			`rejectedAt=${rejectedAt} message=${message.slice(0, 80)}`,
		);
		// the escalated SIGKILL lands SIGKILL_GRACE_MS after the timeout —
		// fire-and-forget: give it the grace plus a small slop, then verify DEATH.
		await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS + 1_000));
		const pid = stubPid();
		const trapped = pid !== null && readFileSync(PIDFILE, "utf8").includes("TRAPPED");
		check("SK.3 trap stub actually trapped SIGTERM (fixture valid)", trapped, `pid=${pid}`);
		check("SK.3 trap stub is DEAD after the escalation window", pid === null || !stubAlive(pid), `pid=${pid} still alive`);
	}

	// cleanup: no stub survivor may outlive the test
	const pid = stubPid();
	if (pid !== null && stubAlive(pid)) process.kill(pid, "SIGKILL");
	rmSync(ART, { recursive: true, force: true });

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("driver error:", err);
	process.exit(1);
});
