/**
 * T-rel — v1.14 early release (watch.releaseOn=started), DESIGN.md §20.5.
 *
 * Run with: bun test/release-on-started-check.ts   (from repo root)
 *
 * Verifies, against a STUB herdr CLI on PATH (no live herdr needed):
 *   1. waitSettle({releaseOnStarted:true}) returns on the FIRST working
 *      observation with {status:"working", startedConfirmed:true, timedOut:false}
 *      — fast (<10 s), not a timeout-burn of the full gate.
 *   2. waitSettle without the flag keeps the old behavior: blocks the full
 *      (short, test-sized) gate and reports timedOut with the last status.
 *   3. resolveWatchConfig parses "releaseOn":"started" from the config file
 *      (via $HOME seam, same caveat as usage.ts).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createHerdrTransport,
} from "../src/herdr/host.ts";
import { resolveWatchConfig } from "../src/observe.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// -- Stub herdr CLI: `agent wait <name> --until ...` always reports working --
const stubDir = mkdtempSync(join(tmpdir(), "rel-on-started-"));
const binDir = join(stubDir, "bin");
mkdirSync(binDir, { recursive: true });
const stub = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"agent wait"*) echo '{"result":{"status":"working"}}' ;;
  *"agent get"*)  echo '{"result":{"agent":{"status":"working"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`;
const stubPath = join(binDir, "herdr");
writeFileSync(stubPath, stub, { mode: 0o755 });

const envPathBackup = process.env.PATH;
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

try {
	const t = createHerdrTransport();

	// 1. Early release: first working observation returns startedConfirmed, fast.
	{
		const t0 = Date.now();
		const settle = await t.waitSettle({ name: "rel-worker", timeoutMs: 60_000, releaseOnStarted: true });
		const elapsed = Date.now() - t0;
		check(
			"T-rel.1 waitSettle(releaseOnStarted) returns startedConfirmed on first working",
			settle.startedConfirmed === true && settle.status === "working" && settle.timedOut === false,
			JSON.stringify(settle),
		);
		check("T-rel.1b early release is fast (<10 s, not a gate burn)", elapsed < 10_000, `${elapsed} ms`);
	}

	// 2. Without the flag: old behavior — blocks the (test-sized) gate, timedOut.
	{
		const settle = await t.waitSettle({ name: "rel-worker", timeoutMs: 4_000 });
		check(
			"T-rel.2 without the flag the gate blocks to timeout (status working)",
			settle.timedOut === true && settle.status === "working" && settle.startedConfirmed === undefined,
			JSON.stringify(settle),
		);
	}

	// 3. Config parsing via $HOME seam.
	{
		const home = mkdtempSync(join(tmpdir(), "rel-cfg-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(home, ".pi", "agent", "pi-delegate.config.json"),
			JSON.stringify({ watch: { releaseOn: "started" } }),
		);
		const child = Bun.spawnSync(["bun", "-e", `import { resolveWatchConfig } from ${JSON.stringify(join(import.meta.dir, "..", "src", "observe.ts"))}; console.log(JSON.stringify(resolveWatchConfig().releaseOn))`], { env: { ...process.env, HOME: home }, stdout: "pipe" });
		const out = child.stdout.toString().trim();
		check("T-rel.3 resolveWatchConfig parses releaseOn=started", out === '"started"', out || child.stderr.toString());
		rmSync(home, { recursive: true, force: true });
	}
} finally {
	process.env.PATH = envPathBackup;
	rmSync(stubDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL RELEASE-ON-STARTED CHECKS PASSED");
