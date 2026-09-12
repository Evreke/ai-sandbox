/**
 * T-WIN — Windows launch policy + tree-kill escalation in runHerdr (TZ §3.6).
 *
 * Run with: bun test/transport-win-check.ts   (from repo root; NO live herdr,
 * NO Windows machine needed — the win32 spawn/kill policy is driven via the
 * injected `platform: "win32"` parameter against stub CLIs on a prepended
 * PATH, including a stub `cmd.exe` that de-quotes per the Windows convention).
 *
 * Problem (1.16.x): on Windows the herdr CLI is typically an npm shim
 * (`herdr.cmd`); modern Node refuses to spawn .cmd/.bat shell-less
 * (CVE-2024-27980 → EINVAL) and a bare spawn does not resolve it (ENOENT) —
 * every herdr CLI call failed before herdr was reached. The kill escalation
 * child.kill("SIGKILL") killed only the direct child, leaving herdr's agent
 * processes as orphans.
 *
 * Checks:
 *   W.1 POSIX default policy (no platform arg): the spawned command is
 *       `herdr` with the RAW argv (regression pin — byte-identical launch);
 *       cmd.exe is never involved.
 *   W.2 Win32 launch (injected platform "win32"): the stub cmd.exe receives
 *       `/d /s /c herdr …`; per-arg quoting round-trips — an arg with spaces
 *       arrives as ONE argv element, an arg with embedded quotes survives.
 *   W.3 Win32 escalation (hang stub + injected win32): at the timeout the
 *       promise rejects with the SAME shape as POSIX (killed:true, signal
 *       SIGTERM); after SIGKILL_GRACE_MS the stub `taskkill` receives
 *       `/pid <stubPid> /T /F` and actually kills the stub tree process.
 *   W.4 winQuoteArg unit cases: space, embedded quotes, plain, empty.
 *
 * Cleanup: every stub it spawns is verified dead or killed in the end; the
 * stub dir is removed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runHerdr,
	parseHerdrResult,
	winQuoteArg,
	SIGKILL_GRACE_MS,
} from "../src/herdr/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ART = mkdtempSync(`${tmpdir()}/pi-delegate-win-`);
const STUB_DIR = join(ART, "bin");
mkdirSync(STUB_DIR, { recursive: true });
const ARGVFILE = join(ART, "herdr-argv.json");
const CMDLOG = join(ART, "cmd-argv.log");
const TKLOG = join(ART, "taskkill-argv.log");
const PIDFILE = join(ART, "stub.pid");

// The `herdr` shim on the test PATH: dispatches on $WIN_STUB_SCRIPT.
writeFileSync(join(STUB_DIR, "herdr"), `#!/usr/bin/env node\nrequire(process.env.WIN_STUB_SCRIPT);\n`, { mode: 0o755 });
// Recorder: writes its argv (beyond node+script), prints a valid herdr JSON line, exits 0.
writeFileSync(
	join(STUB_DIR, "record.js"),
	[
		`const fs = require("node:fs");`,
		`fs.writeFileSync(process.env.WIN_ARGVFILE, JSON.stringify(process.argv.slice(2)));`,
		`process.stdout.write(JSON.stringify({ id: "s", result: { agent: { name: "ok", agent_status: "idle" } } }) + "\\n");`,
	].join("\n"),
);
// Stub cmd.exe: dual-mode.
//   exec mode (default): logs its raw argv, expects the `/d /s /c` shape,
//     de-quotes each following arg per the Windows convention (strip outer
//     quotes, "" → ") and executes the command with the parsed argv (what
//     real cmd.exe does).
//   hang mode (WIN_CMD_HANG=1, for W.3): when the launched command is
//     `herdr`, the stub BECOMES the hang fixture instead of exec'ing — it
//     writes its own pid (the pid production later passes to `taskkill /pid`),
//     traps SIGTERM (simulating a direct child that survives the first kill
//     — the exact case the escalation exists for), hangs forever. The
//     escalation's own cmd.exe call (command `taskkill`) always takes the
//     exec branch, so the tree-kill actually runs.
writeFileSync(
	join(STUB_DIR, "cmd.exe"),
	[
		`#!/usr/bin/env node`,
		`const fs = require("node:fs");`,
		`const argv = process.argv.slice(2);`,
		`if (process.env.WIN_CMD_HANG === "1" && argv[3] === "herdr") {`,
		`  fs.writeFileSync(process.env.WIN_PIDFILE, String(process.pid));`,
		`  process.on("SIGTERM", () => { fs.appendFileSync(process.env.WIN_PIDFILE, "\\nTRAPPED"); });`,
		`  setInterval(() => {}, 1 << 30);`,
		`} else {`,
		`  fs.appendFileSync(process.env.WIN_CMDLOG, JSON.stringify(argv) + "\\n");`,
		`  if (argv[0] !== "/d" || argv[1] !== "/s" || argv[2] !== "/c") process.exit(87);`,
		`  const { spawnSync } = require("node:child_process");`,
		`  const deq = (s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1).replace(/""/g, '"') : s;`,
		`  const cmd = deq(argv[3]);`,
		`  const rest = argv.slice(4).map(deq);`,
		`  const r = spawnSync(cmd, rest, { stdio: "inherit" });`,
		`  process.exit(r.status ?? 1);`,
		`}`,
	].join("\n"),
	{ mode: 0o755 },
);
// Stub taskkill: logs its argv and force-kills the /pid target (tree kill
// simulated by killing the recorded process directly).
writeFileSync(
	join(STUB_DIR, "taskkill"),
	[
		`#!/usr/bin/env node`,
		`const fs = require("node:fs");`,
		`const argv = process.argv.slice(2);`,
		`fs.appendFileSync(process.env.WIN_TKLOG, JSON.stringify(argv) + "\\n");`,
		`const i = argv.indexOf("/pid");`,
		`if (i !== -1 && argv[i + 1]) { try { process.kill(Number(argv[i + 1]), "SIGKILL"); } catch {} }`,
		`process.exit(0);`,
	].join("\n"),
	{ mode: 0o755 },
);
// PATH override BEFORE any spawn: runHerdr resolves `herdr`/`cmd.exe` at spawn time.
process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
process.env.WIN_STUB_SCRIPT = "";
process.env.WIN_ARGVFILE = ARGVFILE;
process.env.WIN_CMDLOG = CMDLOG;
process.env.WIN_TKLOG = TKLOG;
process.env.WIN_PIDFILE = PIDFILE;

const resetArtifacts = () => {
	for (const f of [ARGVFILE, CMDLOG, TKLOG, PIDFILE]) {
		try {
			rmSync(f, { force: true });
		} catch { /* absent is fine */ }
	}
};
const readJson = (path: string): unknown | null => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};
const cmdLines = (): string[][] =>
	existsSync(CMDLOG)
		? readFileSync(CMDLOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[])
		: [];
const tkLines = (): string[][] =>
	existsSync(TKLOG)
		? readFileSync(TKLOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[])
		: [];
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
	process.env.WIN_STUB_SCRIPT = join(STUB_DIR, name);
	resetArtifacts();
};

async function run() {
	const T = 2_000;

	// W.1 — POSIX default policy: raw argv, no cmd.exe (regression pin)
	{
		setStub("record.js");
		const { stdout } = await runHerdr(["agent", "list", "--label", "hello world"], T);
		const { result } = parseHerdrResult(stdout);
		const argv = readJson(ARGVFILE);
		check(
			"W.1 default policy spawns `herdr` with the RAW argv (spaces stay one element)",
			JSON.stringify(argv) === JSON.stringify(["agent", "list", "--label", "hello world"]),
			`argv=${JSON.stringify(argv)}`,
		);
		check(
			"W.1 default policy result parses (unchanged herdr shape)",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle",
		);
		check("W.1 default policy never touches cmd.exe", cmdLines().length === 0, `cmd=${JSON.stringify(cmdLines())}`);
	}

	// W.2 — win32 launch: cmd.exe /d /s /c herdr … with per-arg quoting
	{
		setStub("record.js");
		const { stdout } = await runHerdr(
			["agent", "list", "--label", "hello world", "--note", 'say "hi"'],
			T,
			"win32",
		);
		const { result } = parseHerdrResult(stdout);
		const lines = cmdLines();
		check("W.2 win32 policy routes through exactly one cmd.exe call", lines.length === 1, `lines=${JSON.stringify(lines)}`);
		const shape = lines[0] ?? [];
		check(
			"W.2 cmd.exe receives /d /s /c then the command",
			shape[0] === "/d" && shape[1] === "/s" && shape[2] === "/c" && shape[3] === "herdr",
			`shape=${JSON.stringify(shape)}`,
		);
		check(
			"W.2 arg with spaces is quoted per-arg (one argv element with quotes)",
			shape.includes('"hello world"') && !shape.some((a) => a === "hello world"),
			`shape=${JSON.stringify(shape)}`,
		);
		const argv = readJson(ARGVFILE);
		check(
			"W.2 arg with spaces arrives as ONE argv element after de-quoting",
			JSON.stringify(argv) === JSON.stringify(["agent", "list", "--label", "hello world", "--note", 'say "hi"']),
			`argv=${JSON.stringify(argv)}`,
		);
		check(
			"W.2 embedded quotes round-trip through the quoting helper",
			(argv as string[] | null)?.includes('say "hi"') === true,
		);
		check(
			"W.2 win32 launch result parses (unchanged herdr shape)",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle",
		);
	}

	// W.3 — win32 escalation: the direct child (cmd.exe stub, hang mode)
	// survives the timeout SIGTERM (traps it); the taskkill tree-kill must
	// still land with the direct child's pid, and the promise must reject with
	// the SAME shape as POSIX.
	{
		setStub("record.js");
		process.env.WIN_CMD_HANG = "1";
		const t0 = Date.now();
		let rejectedAt = -1;
		let killedFlag: unknown;
		let signal: unknown;
		try {
			await runHerdr(["agent", "list"], T, "win32");
		} catch (err) {
			rejectedAt = Date.now() - t0;
			const cause = (err as { cause?: { killed?: boolean; signal?: string | null } }).cause;
			killedFlag = cause?.killed;
			signal = cause?.signal;
		}
		check(
			"W.3 hang stub rejects near the timeout (not after the escalation)",
			rejectedAt >= T && rejectedAt < T + 1_500,
			`rejectedAt=${rejectedAt}`,
		);
		check("W.3 rejection carries killed=true (same shape as POSIX)", killedFlag === true, `killed=${String(killedFlag)}`);
		check("W.3 rejection carries signal SIGTERM (same shape as POSIX)", signal === "SIGTERM", `signal=${String(signal)}`);
		// the escalation lands SIGKILL_GRACE_MS after the timeout — fire-and-
		// forget: give it the grace plus a small slop, then verify the shape.
		await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS + 1_000));
		process.env.WIN_CMD_HANG = "";
		const pid = stubPid();
		const trapped = pid !== null && readFileSync(PIDFILE, "utf8").includes("TRAPPED");
		check("W.3 cmd stub (direct child) actually trapped SIGTERM (fixture valid)", trapped, `pid=${pid}`);
		const tk = tkLines();
		check("W.3 escalation fires exactly one taskkill", tk.length === 1, `tk=${JSON.stringify(tk)}`);
		const tkArgs = tk[0] ?? [];
		check(
			"W.3 taskkill receives /pid <directChildPid> /T /F (tree + force)",
			JSON.stringify(tkArgs) === JSON.stringify(["/pid", String(pid), "/T", "/F"]),
			`tkArgs=${JSON.stringify(tkArgs)} pid=${pid}`,
		);
		check(
			"W.3 direct child is DEAD after the escalation window (tree kill landed)",
			pid === null || !stubAlive(pid),
			`pid=${pid} still alive`,
		);
	}

	// W.4 — winQuoteArg unit cases (space, quote, plain, empty)
	{
		check("W.4 plain arg passes through unchanged", winQuoteArg("agent") === "agent");
		check("W.4 arg with a space is wrapped in double quotes", winQuoteArg("hello world") === '"hello world"');
		check("W.4 arg with a tab is wrapped in double quotes", winQuoteArg("a\tb") === '"a\tb"');
		check("W.4 embedded quotes are doubled inside the wrapper", winQuoteArg('say "hi"') === '"say ""hi"""');
		check("W.4 empty arg stays empty (no space/tab/quote)", winQuoteArg("") === "");
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
