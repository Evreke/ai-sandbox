/**
 * TG — W2 pile-up guards in HerdrTransport (2026-09-09 herdr incident follow-up).
 *
 * Run with: bun test/transport-guards.ts   (from repo root; NO live herdr
 * needed — every case runs against stub `herdr` CLIs on a prepended PATH, and
 * the socket read-only path is disabled via HERDR_SOCKET_TRANSPORT=cli so the
 * CLI listStatuses body is what the guards wrap).
 *
 * Checks:
 *   TG.1 Tick de-dup: 4 CONCURRENT listStatuses calls while one is in flight →
 *        exactly ONE stub invocation (no overlapping listStatuses).
 *   TG.2 De-dup is per-flight, not memoized: a call in a distinct time window
 *        hits the stub again.
 *   TG.3 Queue deadline: a never-settling mutating op rejects the CALLER with a
 *        structured E_TIMEOUT DelegateError at ~deadline (queue no longer
 *        stalls forever).
 *   TG.4 Queue proceeds after the deadline: the next mutating op resolves.
 *   TG.5 Serialization preserved: a second mutating op enqueued while the
 *        first is still running starts only after the first ends.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrTransport } from "../src/transport.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ART = mkdtempSync(`${tmpdir()}/pi-delegate-guards-`);
const STUB_DIR = join(ART, "bin");
mkdirSync(STUB_DIR, { recursive: true });

// Dispatcher: the test's PATH points here; $STUB_SCRIPT picks the stub shape.
writeFileSync(join(STUB_DIR, "herdr"), `#!/usr/bin/env node\nrequire(process.env.STUB_SCRIPT);\n`, { mode: 0o755 });

// Counter helpers: the stub appends one line per agent-list invocation.
const LIST_COUNT = join(ART, "list.count");
const SER_LOG = join(ART, "ser.log");
function count(f: string): number {
	try {
		return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

// slow-list: sleep $TG_DELAY_MS, count the invocation, print a valid list line.
writeFileSync(
	join(STUB_DIR, "slow-list.js"),
	[
		`const fs = require("node:fs");`,
		`fs.appendFileSync(process.env.TG_COUNT, "1\\n");`,
		`setTimeout(() => {`,
		`  process.stdout.write(JSON.stringify({ id: "s", result: { agents: [{ name: "alpha", agent_status: "idle", pane_id: "w:p1", workspace_id: "w" }] } }) + "\\n");`,
		`}, Number(process.env.TG_DELAY_MS || 300));`,
	].join("\n"),
);

// trap: mutating-op hang shape — silently traps SIGTERM and NEVER exits (the
// never-settling op source the queue deadline exists for).
writeFileSync(
	join(STUB_DIR, "trap.js"),
	`process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1 << 30);\n`,
);

// logop: mutating op that logs start/end with argv tag ($TG_TAG) and exits 0.
writeFileSync(
	join(STUB_DIR, "logop.js"),
	[
		`const fs = require("node:fs");`,
		`const tag = process.env.TG_TAG || "op";`,
		`fs.appendFileSync(process.env.TG_SERLOG, "start " + tag + " " + Date.now() + "\\n");`,
		`setTimeout(() => {`,
		`  fs.appendFileSync(process.env.TG_SERLOG, "end " + tag + " " + Date.now() + "\\n");`,
		`  process.stdout.write(JSON.stringify({ id: "s", result: {} }) + "\\n");`,
		`}, Number(process.env.TG_DELAY_MS || 200));`,
	].join("\n"),
);

const savedPath = process.env.PATH;
const savedTransportMode = process.env.HERDR_SOCKET_TRANSPORT;
process.env.HERDR_SOCKET_TRANSPORT = "cli"; // exercise the CLI listStatuses body under the guards
process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;

try {
	// -- TG.1 + TG.2: listStatuses in-flight de-dup --------------------------------
	process.env.STUB_SCRIPT = join(STUB_DIR, "slow-list.js");
	process.env.TG_COUNT = LIST_COUNT;
	process.env.TG_DELAY_MS = "300";
	{
		const t = new HerdrTransport();
		const results = await Promise.all([t.listStatuses(), t.listStatuses(), t.listStatuses(), t.listStatuses()]);
		check("TG.1 four concurrent listStatuses all resolve", results.length === 4 && results.every((r) => r.length === 1 && r[0].name === "alpha"));
		check("TG.1 four concurrent listStatuses hit the stub exactly ONCE", count(LIST_COUNT) === 1, `count=${count(LIST_COUNT)}`);
		await t.listStatuses();
		check("TG.2 distinct-time call hits the stub again (no memoization)", count(LIST_COUNT) === 2, `count=${count(LIST_COUNT)}`);
	}

	// -- TG.3 + TG.4: per-op queue deadline ----------------------------------------
	{
		process.env.STUB_SCRIPT = join(STUB_DIR, "trap.js");
		const t = new HerdrTransport({ queueOpDeadlineMs: 500 });
		const t0 = Date.now();
		let code = "";
		let timedOut = false;
		try {
			await t.submitPrompt({ name: "w1", text: "hi" });
		} catch (err) {
			code = String((err as { code?: string }).code ?? "");
			timedOut = Date.now() - t0 < 2000; // rejected near the 500ms deadline, not hung
		}
		check("TG.3 never-settling op rejects with structured E_TIMEOUT", code === "E_TIMEOUT");
		check("TG.3 rejection lands near the deadline (≤2s for a 500ms deadline)", timedOut);

		process.env.STUB_SCRIPT = join(STUB_DIR, "slow-list.js");
		process.env.TG_DELAY_MS = "50";
		const next = await t.startAgent({ name: "w2", tier: undefined } as never).catch((e) => e);
		check("TG.4 queue proceeds after the deadline (next mutating op resolves)", !(next instanceof Error), `${next}`);
	}

	// -- TG.5: serialization still holds -------------------------------------------
	{
		process.env.STUB_SCRIPT = join(STUB_DIR, "logop.js");
		process.env.TG_SERLOG = SER_LOG;
		const t = new HerdrTransport({ queueOpDeadlineMs: 10_000 });
		process.env.TG_TAG = "A";
		process.env.TG_DELAY_MS = "200";
		const a = t.submitPrompt({ name: "w1", text: "a" });
		await new Promise((r) => setTimeout(r, 30));
		process.env.TG_TAG = "B";
		process.env.TG_DELAY_MS = "20";
		const b = t.submitPrompt({ name: "w1", text: "b" });
		await Promise.all([a, b]);
		const lines = readFileSync(SER_LOG, "utf8").trim().split("\n");
		const aEnd = lines.find((l) => l.startsWith("end A"));
		const bStart = lines.find((l) => l.startsWith("start B"));
		check("TG.5 serialization: B starts only after A ends", Boolean(aEnd && bStart && Number(bStart.split(" ")[2]) >= Number(aEnd.split(" ")[2])), lines.join(" | "));
	}
} finally {
	process.env.PATH = savedPath;
	if (savedTransportMode === undefined) delete process.env.HERDR_SOCKET_TRANSPORT;
	else process.env.HERDR_SOCKET_TRANSPORT = savedTransportMode;
	rmSync(ART, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
