/**
 * T-double-mount — Wave 2 regression checks for the session-lifecycle double-
 * delivery class (ARCHITECTURE.md Law 3, audit findings D2 + B1-family).
 *
 * Run with: bun test/double-mount-check.ts   (from the extension dir)
 *
 * The double-delivery mechanism is a DOUBLE MODULE LOAD: two copies of
 * src/observe.ts each keep their own module-global watcher registry, so two
 * startWatcher calls for the SAME session silently run TWO watchers with
 * independent dedup — every wake delivered twice. The fix keys mounts by
 * session file in a globalThis registry (shared across module copies) and
 * REFUSES a second mount for an already-mounted session. To exercise exactly
 * that, the check simulates the double module load for real: it copies
 * src/observe.ts to a second specifier inside src/ and imports BOTH.
 *
 * The watcher interval has a 1 s floor (WATCH_MIN_INTERVAL_MS) and the config
 * path is bound at import time, so — like watcher-check W2 — the timed
 * scenarios run in CHILD bun processes with $HOME set at spawn time.
 *
 * Checks:
 *   DM1  Double module load, same session: two startWatcher calls over the
 *        same session file produce EXACTLY ONE delivery per event (the second
 *        mount is refused, logs why, keeps the first instance, starts NO
 *        second interval) and both calls return the FIRST instance's handle.
 *        Fails on pre-fix code: two live watchers → two deliveries.
 *   DM2  Handle-based shutdown isolation: mounting session A then session B
 *        (one module copy), BOTH watchers deliver their own workers' wakes;
 *        stopping A's handle stops A and only A — B still receives a new
 *        wake. Fails on pre-fix code: the second mount REPLACED the first
 *        (module-global double-start-replaces), so A never delivers at all.
 * Exit 0 only if all checks pass.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { reportPathFor } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname2(import.meta.url), "..");

function dirname2(url: string): string {
	return new URL(".", url).pathname.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// The child script: runs the two timed scenarios against REAL timers.
// ---------------------------------------------------------------------------

const CHILD = `
// Child of double-mount-check — see the parent file for the scenario docs.
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const { reportPathFor } = require(process.env.DM_EXCHANGE_MOD);
const OBSERVE = process.env.DM_OBSERVE;
const COPY = process.env.DM_COPY;
const ROOT_DIR = process.env.DM_ROOT;
const SESSION_A = process.env.DM_SESSION_A;
const SESSION_B = process.env.DM_SESSION_B;

const sent = [];
const refusalLogs = [];
const realConsoleError = console.error.bind(console);
console.error = (...args) => {
	const line = args.map(String).join(" ");
	if (line.includes("refused")) refusalLogs.push(line);
	realConsoleError(...args);
};

const o1 = await import(OBSERVE);
const o2 = await import(COPY); // the SECOND module copy — the double-load simulation

const transport = { backendName: () => "herdr", listStatuses: async () => [{ name: "dm1-w", status: "working" }, { name: "dm2-a", status: "working" }, { name: "dm2-b", status: "working" }] };
const fakePi = { sendUserMessage: (content) => { sent.push(content); } };
const sm = (f) => ({ getSessionFile: () => f });

async function waitFor(cond, what, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("timeout waiting for " + what);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const out = {};
try {
	// --- DM1: double module load, same session → exactly ONE delivery ------
	const s1 = o1.startWatcher(fakePi, transport, { cwd: ROOT_DIR, sessionManager: sm(SESSION_A) });
	const s2 = o2.startWatcher(fakePi, transport, { cwd: ROOT_DIR, sessionManager: sm(SESSION_A) });
	out.dm1HandlesAreFunctions = typeof s1 === "function" && typeof s2 === "function";
	out.dm1RefusedSecondMountReturnsFirstHandle = s1 === s2;
	out.dm1RefusalLogged = refusalLogs.length > 0;
	await waitFor(() => sent.some((t) => t.includes("dm1-w")), "first dm1-w delivery");
	// One full extra interval window: the dedup must keep holding — a second
	// live watcher (independent dedup) would deliver a second copy here.
	await new Promise((r) => setTimeout(r, 2600));
	out.dm1Deliveries = sent.filter((t) => t.includes("dm1-w")).length;
	out.dm1SentLog = sent.slice();
	s1(); // handle unregister — frees SESSION_A for DM2
	s1(); // idempotent
	await new Promise((r) => setTimeout(r, 100));

	// --- DM2: handle-based shutdown isolation (A stopped, B keeps firing) ---
	// NOTE: durable delivery dedup means a re-mounted session does NOT re-fire
	// already-committed facts — so both phases below write NEW report
	// fingerprints (rewritten report = new mtime) to give each watcher a
	// genuinely new fact to deliver.
	const before = sent.length;
	const stopA = o1.startWatcher(fakePi, transport, { cwd: ROOT_DIR, sessionManager: sm(SESSION_A) });
	const stopB = o1.startWatcher(fakePi, transport, { cwd: ROOT_DIR, sessionManager: sm(SESSION_B) });
	out.dm2BothMounted = typeof stopA === "function" && typeof stopB === "function" && stopA !== stopB;
	const rewrite = (name, dir) => {
		writeFileSync(reportPathFor(dir, name), JSON.stringify({ worker: name, status: "pass", summary: "done v" + Date.now(), artifacts: [], evidence: [{ claim: "c", file: "f.ts:1" }] }));
	};
	rewrite("dm2-a", join(ROOT_DIR, "exchange", "t-dm2-a"));
	rewrite("dm2-b", join(ROOT_DIR, "exchange", "t-dm2-b"));
	await waitFor(
		() => sent.slice(before).some((t) => t.includes("dm2-a")) && sent.slice(before).some((t) => t.includes("dm2-b")),
		"both dm2 sessions delivering their new facts",
	);
	const bDeliveriesBefore = sent.filter((t) => t.includes("dm2-b")).length;
	stopA(); // session A shuts down — must not touch B's watcher
	rewrite("dm2-a", join(ROOT_DIR, "exchange", "t-dm2-a"));
	rewrite("dm2-b", join(ROOT_DIR, "exchange", "t-dm2-b"));
	await new Promise((r) => setTimeout(r, 2600));
	out.dm2bNewDeliveries = sent.filter((t) => t.includes("dm2-b")).length - bDeliveriesBefore;
	out.dm2aDeliveries = sent.slice(before).filter((t) => t.includes("dm2-a")).length;
	out.dm2SentLog = sent.slice(before);
	out.dm2Logs = refusalLogs.length;
	stopB();
	stopB();
	console.log("CHILD_RESULT " + JSON.stringify(out));
	process.exit(0);
} catch (err) {
	out.error = String(err && err.stack ? err.stack : err);
	out.dm1SentLog = sent.slice();
	console.log("CHILD_RESULT " + JSON.stringify(out));
	process.exit(1);
}
`;

// ---------------------------------------------------------------------------
// Fixture: one task dir per scenario, each worker owned by its session.
// ---------------------------------------------------------------------------

function writeManifest(dir: string, task: string, workers: unknown[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ task, dir, workers }));
}

function writeValidReport(dir: string, name: string): void {
	writeFileSync(
		reportPathFor(dir, name),
		JSON.stringify({ worker: name, status: "pass", summary: "done", artifacts: [], evidence: [{ claim: "c", file: "f.ts:1" }] }),
	);
}

function worker(name: string, ownerSession: string, dir: string): Record<string, unknown> {
	return {
		name,
		orchestratorSessionPath: ownerSession,
		placement: { kind: "worktree", workspaceId: "w1", paneId: "w1:p1", branch: `delegate/${name}`, checkoutPath: join(dir, "wt-" + name) },
		briefPath: join(dir, `brief-${name}.md`),
		reportPath: reportPathFor(dir, name),
		provider: "p",
		model: "unknown-model",
		thinking: "low",
		startedAt: new Date(Date.now() - 60_000).toISOString(),
	};
}

function runChild(env: Record<string, string>): Record<string, unknown> {
	const res = spawnSync("bun", ["-e", CHILD], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 25_000,
		cwd: ROOT,
	});
	const stdout = res.stdout ?? "";
	const line = stdout.split("\n").find((l) => l.startsWith("CHILD_RESULT "));
	if (!line) {
		return { error: `no CHILD_RESULT line (rc=${res.status})\nstdout:${stdout}\nstderr:${res.stderr}` };
	}
	try {
		return JSON.parse(line.slice("CHILD_RESULT ".length)) as Record<string, unknown>;
	} catch (e) {
		return { error: `unparseable CHILD_RESULT: ${String(e)} — ${line}` };
	}
}

// ---------------------------------------------------------------------------
// DM1 + DM2 in one child (shared fixture; DM1 stops its watcher before DM2).
// ---------------------------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), "double-mount-check-"));
const HOME = join(SANDBOX, "home");
const EXCHANGE = join(SANDBOX, "exchange");
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
// 1 s — the WATCH_MIN_INTERVAL_MS floor (anything lower falls back to the
// 10 s default, which would blow the check's time budget).
writeFileSync(join(HOME, ".pi", "agent", "pi-delegate.config.json"), JSON.stringify({ watch: { intervalMs: 1000 } }));

const SESSION_A = join(HOME, "session-a.jsonl");
const SESSION_B = join(HOME, "session-b.jsonl");

const dir1 = join(EXCHANGE, "t-dm1");
const dirA = join(EXCHANGE, "t-dm2-a");
const dirB = join(EXCHANGE, "t-dm2-b");
writeManifest(dir1, "t-dm1", [worker("dm1-w", SESSION_A, dir1)]);
writeManifest(dirA, "t-dm2-a", [worker("dm2-a", SESSION_A, dirA)]);
writeManifest(dirB, "t-dm2-b", [worker("dm2-b", SESSION_B, dirB)]);
writeValidReport(dir1, "dm1-w");
writeValidReport(dirA, "dm2-a");
writeValidReport(dirB, "dm2-b");

// The double module load, simulated for real: a second copy of observe.ts
// under a DIFFERENT specifier (same directory so its relative imports
// resolve). Removed again in finally — a leftover would pollute src/ (and the
// QA tsc glob).
const OBSERVE = join(ROOT, "src", "observe.ts");
const COPY = join(ROOT, "src", "observe-double-load-copy.ts");
cpSync(OBSERVE, COPY);

let out: Record<string, unknown>;
try {
	out = runChild({
		HOME,
		PI_DELEGATE_EXCHANGE_ROOT: EXCHANGE,
		DM_OBSERVE: OBSERVE,
		DM_COPY: COPY,
		DM_EXCHANGE_MOD: join(ROOT, "src", "exchange.ts"),
		DM_ROOT: SANDBOX,
		DM_SESSION_A: SESSION_A,
		DM_SESSION_B: SESSION_B,
	});
} finally {
	rmSync(COPY, { force: true });
}

const err = out.error as string | undefined;
check("DM0 child ran to completion", err === undefined, err ?? "");
if (err !== undefined) {
	console.error(JSON.stringify(out, null, 2));
} else {
	const sentLog = (out.dm1SentLog as string[]) ?? [];
	const sentLog2 = (out.dm2SentLog as string[]) ?? [];
	check(
		"DM1.1 both mounts returned usable handles",
		out.dm1HandlesAreFunctions === true,
		JSON.stringify(out.dm1HandlesAreFunctions),
	);
	check(
		"DM1.2 the refused second mount returns the FIRST instance's handle (Law 3: keep the first)",
		out.dm1RefusedSecondMountReturnsFirstHandle === true,
		`same=${String(out.dm1RefusedSecondMountReturnsFirstHandle)}`,
	);
	check(
		"DM1.3 the refusal is logged with its reason (auditable, not silent)",
		out.dm1RefusalLogged === true,
		"no 'refused' line captured",
	);
	check(
		"DM1.4 exactly ONE delivery per event across both module copies (no second interval)",
		out.dm1Deliveries === 1,
		`deliveries=${String(out.dm1Deliveries)} sent=${JSON.stringify(sentLog)}`,
	);
	check(
		"DM2.1 sessions A and B mount SEPARATE watchers (distinct handles)",
		out.dm2BothMounted === true,
		`same=${String(out.dm2BothMounted)}`,
	);
	check(
		"DM2.2 both sessions deliver their own workers' wakes before shutdown",
		sentLog2.some((t) => t.includes("dm2-a")) && sentLog2.some((t) => t.includes("dm2-b")),
		JSON.stringify(sentLog2),
	);
	check(
		"DM2.3 shutting down A does NOT stop B — B receives the new wake (isolation)",
		Number(out.dm2bNewDeliveries) >= 1,
		`b-new=${String(out.dm2bNewDeliveries)} sent=${JSON.stringify(sentLog2)}`,
	);
	check(
		"DM2.4 shutting down A DOES stop A — A's new fact stays silent",
		Number(out.dm2aDeliveries) === 1,
		`a-deliveries=${String(out.dm2aDeliveries)} (expected exactly the one pre-stop wake) sent=${JSON.stringify(sentLog2)}`,
	);
}

rmSync(SANDBOX, { recursive: true, force: true });
if (failures > 0) {
	console.error(`\n${failures} double-mount check(s) FAILED`);
	process.exit(1);
}
console.log("\nALL DOUBLE-MOUNT CHECKS PASSED");
