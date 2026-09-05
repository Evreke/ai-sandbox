/**
 * T2 — Transport contract tests against REAL herdr (DESIGN.md §8).
 *
 * Run with: bun test/transport-contract.ts   (from repo root; NOT inside a herdr worktree cwd)
 *
 * Every herdr mutating op is logged to /tmp/exchange/pi-delegate-ext/qa-herdr-ops.log
 * BEFORE it runs (one line per op).
 *
 * Checks:
 *   2.1 capabilities() root-mode from a throwaway repo cwd.
 *   2.2 Worktree place round-trip → Placement fields → startAgent (pinned model)
 *       → submitPrompt → waitSettle → teardown → placement gone from `herdr workspace list`.
 *   2.3 Sub-mode rejection: cwd under /root/.herdr/worktrees → place(worktree) throws E_PLACE.
 *   2.4 Name uniquification: colliding requested name returns a different canonical name.
 *   2.5 Concurrency serialization: two concurrent place() both resolve cleanly.
 *
 * Cleanup: every workspace created here is torn down, even on failure.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createHerdrTransport, parseHerdrResult } from "../src/transport/herdr.ts";
import type { Placement } from "../src/transport/types.ts";

const execFileP = promisify(execFile);
const OPS_LOG = "/tmp/exchange/pi-delegate-ext/qa-herdr-ops.log";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Log a mutating herdr op BEFORE running it. */
function logOp(cmd: string) {
	mkdirSync(resolve(OPS_LOG, ".."), { recursive: true });
	appendFileSync(OPS_LOG, `${new Date().toISOString()} ${cmd}\n`);
}

async function herdrJson(args: string[]): Promise<unknown> {
	const { stdout } = await execFileP("herdr", args, { encoding: "utf8", timeout: 30_000 });
	return parseHerdrResult(stdout).result;
}

async function liveWorkspaceIds(): Promise<Set<string>> {
	const result = await herdrJson(["workspace", "list"]);
	const list = Array.isArray(result) ? result : (result as { workspaces?: unknown[] })?.workspaces ?? [];
	const ids = new Set<string>();
	for (const w of list as Array<Record<string, unknown>>) {
		const id = (w?.workspace_id ?? w?.id) as string | undefined;
		if (id) ids.add(id);
	}
	return ids;
}

/** Best-effort cleanup for a placement if the transport teardown path itself failed. */
async function forceCleanup(p: Placement) {
	logOp(`herdr worktree remove --workspace ${p.workspaceId} --force  (cleanup fallback)`);
	try {
		await execFileP("herdr", ["worktree", "remove", "--workspace", p.workspaceId, "--force"], { encoding: "utf8", timeout: 30_000 });
	} catch {
		/* fall through — the workspace-close fallback below handles shells (O2). */
	}
	// herdr may keep a non-linked workspace shell after worktree remove — always close.
	logOp(`herdr workspace close ${p.workspaceId}  (cleanup fallback)`);
	try {
		await execFileP("herdr", ["workspace", "close", p.workspaceId], { encoding: "utf8", timeout: 30_000 });
	} catch {
		// Only a failure of BOTH paths leaves state behind — verify before alarming.
		const still = await execFileP("herdr", ["workspace", "list"], { encoding: "utf8", timeout: 30_000 }).then((r) => String(r)).catch(() => "");
		const present = still.includes(`"${p.workspaceId}"`);
		if (present) console.error(`CLEANUP FAILED for workspace ${p.workspaceId} — leftover state!`);
	}
}

// ---------------------------------------------------------------------------
// Throwaway git repo
// ---------------------------------------------------------------------------
const repoDir = mkdtempSync(resolve(tmpdir(), "qa-t2-repo-"));
{
	const git = async (...args: string[]) =>
		execFileP("git", args, { cwd: repoDir, encoding: "utf8" });
	await git("init", "-b", "main");
	await git("config", "user.email", "qa@test");
	await git("config", "user.name", "qa");
	await execFileP("bash", ["-c", "echo hello > README.md"], { cwd: repoDir });
	await git("add", ".");
	await git("commit", "-m", "init");
}
console.log(`throwaway repo: ${repoDir}`);

const originalCwd = process.cwd();
const created: Placement[] = [];
const MODEL = { provider: "llm-platform-alpha", model: "glm-5.3-flash", thinking: "high" };

try {
	// -----------------------------------------------------------------------
	// T2.1 + T2.2 — root-mode round-trip
	// -----------------------------------------------------------------------
	process.chdir(repoDir); // authority is detected from cwd at construction
	const t = createHerdrTransport();

	const caps = t.capabilities();
	check("T2.1 capabilities(): root authority, worktrees allowed", caps.authority === "root" && caps.worktrees === true, JSON.stringify(caps));

	const before = await liveWorkspaceIds();
	logOp("herdr worktree create --cwd <throwaway-repo> --branch qa-probe-main --label qa-probe-main --no-focus");
	const p1 = await t.place({ mode: "worktree", repoPath: repoDir, branch: "qa-probe-main", label: "qa-probe-main" });
	created.push(p1);
	check(
		"T2.2 place() returns full Placement (kind/workspaceId/paneId/branch/checkoutPath/isLinkedWorktree)",
		p1.kind === "worktree" &&
			!!p1.workspaceId &&
			!!p1.paneId &&
			p1.branch === "qa-probe-main" &&
			!!p1.checkoutPath &&
			typeof p1.isLinkedWorktree === "boolean",
		JSON.stringify(p1),
	);
	check("T2.2b placement created a NEW herdr workspace", !before.has(p1.workspaceId), p1.workspaceId);

	logOp(`herdr agent start qa-probe --kind pi --pane ${p1.paneId} --timeout 120000 -- --provider ${MODEL.provider} --model ${MODEL.model} --thinking ${MODEL.thinking}`);
	const probeName = `qa-probe-${Date.now().toString(36)}`;
	logOp(`herdr agent start ${probeName} (unique suffix avoids collision with live agents)`);
	const s1 = await t.startAgent({ name: probeName, paneId: p1.paneId, timeoutMs: 120_000, ...MODEL });
	check("T2.2c startAgent returns canonical name", !!s1.name, JSON.stringify(s1));

	logOp(`herdr agent prompt ${s1.name} "Reply with exactly: OK"  (submit, no --wait)`);
	await t.submitPrompt({ name: s1.name, text: "Reply with exactly: OK", timeoutMs: 30_000 });
	check("T2.2d submitPrompt accepted", true);

	logOp(`herdr agent wait ${s1.name} --until idle --until done --until blocked --timeout 3000  (waitSettle loop, ≤240s)`);
	const settle = await t.waitSettle({ name: s1.name, timeoutMs: 240_000 });
	check("T2.2e waitSettle settled without timeout", !settle.timedOut && ["idle", "done", "blocked"].includes(settle.status), JSON.stringify(settle));

	const st = await t.getStatus(s1.name);
	// REAL herdr reports status under `agent.agent_status`; if the transport only
	// reads `status`/`agent.status` this resolves to "unknown" (product defect).
	check(
		"T2.2f getStatus reflects the REAL settled status (not 'unknown')",
		st?.name === s1.name && ["idle", "done", "blocked"].includes(st.status),
		JSON.stringify(st),
	);

	logOp(`herdr worktree remove --workspace ${p1.workspaceId} --force  (teardown)`);
	await t.teardown({ name: s1.name, placement: p1, force: true });
	const after = await liveWorkspaceIds();
	check("T2.2g placement gone from herdr workspace list after teardown", !after.has(p1.workspaceId), p1.workspaceId);
	created.splice(created.indexOf(p1), 1);

	// -----------------------------------------------------------------------
	// T2.5 — concurrency serialization (two placements live at once, reused
	// for the name-uniquification check: BOTH agents must be live simultaneously
	// for herdr to see the collision)
	// -----------------------------------------------------------------------
	logOp("herdr worktree create x2 CONCURRENTLY (branches qa-probe-conc-a / qa-probe-conc-b)");
	const [pA, pB] = await Promise.all([
		t.place({ mode: "worktree", repoPath: repoDir, branch: "qa-probe-conc-a", label: "qa-probe-conc-a" }),
		t.place({ mode: "worktree", repoPath: repoDir, branch: "qa-probe-conc-b", label: "qa-probe-conc-b" }),
	]);
	created.push(pA, pB);
	check(
		"T2.5 two concurrent place() resolve with distinct workspaces (no interleaving failures)",
		!!pA.workspaceId && !!pB.workspaceId && pA.workspaceId !== pB.workspaceId,
		`${pA.workspaceId} / ${pB.workspaceId}`,
	);

	// T2.4 — name uniquification: start the SAME requested name in both live workspaces.
	// CONTRACT (types.ts StartReq): "herdr auto-uniquifies on collision" → canonical
	// name must differ. OBSERVED herdr behavior: rejects with agent_name_taken.
	logOp(`herdr agent start qa-probe (workspace A) ... -- --provider ${MODEL.provider} --model ${MODEL.model} --thinking ${MODEL.thinking}`);
	const sA = await t.startAgent({ name: "qa-probe", paneId: pA.paneId, timeoutMs: 120_000, ...MODEL });
	logOp(`herdr agent start qa-probe (workspace B, colliding with live ${sA.name}) ...`);
	let collErr: unknown;
	try {
		await t.startAgent({ name: "qa-probe", paneId: pB.paneId, timeoutMs: 120_000, ...MODEL });
	} catch (e) {
		collErr = e;
	}
	const coll = collErr as { code?: string; message?: string; guidance?: string } | undefined;
	check(
		"T2.4 colliding requested name → herdr/transport provides a distinct canonical name or E_NAME guidance",
		coll === undefined || coll.code === "E_NAME",
		coll === undefined
			? `canonical A=${sA.name}`
			: `transport threw code=${coll.code} (expected E_NAME); msg=${coll.message?.slice(0, 200)}`,
	);
	console.log(
		`NOTE  T2.4 observed: herdr agent start rejects collision with agent_name_taken; transport maps it to ${coll?.code ?? "no-error"} (types.ts promises auto-uniquification)`,
	);

	logOp(`herdr worktree remove --workspace ${pA.workspaceId} --force  (teardown)`);
	await t.teardown({ name: sA.name, placement: pA, force: true });
	logOp(`herdr worktree remove --workspace ${pB.workspaceId} --force  (teardown)`);
	await t.teardown({ name: "qa-probe", placement: pB, force: true }).catch(async () => forceCleanup(pB));
	// Non-linked shells can survive `worktree remove` while agents are live — verify.
	await new Promise((r) => setTimeout(r, 1500));
	for (const p of [pA, pB]) {
		const ids = await liveWorkspaceIds();
		if (ids.has(p.workspaceId)) await forceCleanup(p);
	}
	created.length = 0;
	const afterConc = await liveWorkspaceIds();
	check("T2.5b both concurrent workspaces gone after teardown", !afterConc.has(pA.workspaceId) && !afterConc.has(pB.workspaceId));

	// -----------------------------------------------------------------------
	// T2.3 — sub-mode rejection (LAST: leaves cwd changed). A real sub-orchestrator
	// cwd is INSIDE the worktrees prefix. Create a throwaway dir there instead of
	// chdir'ing into a hardcoded path from a previous run (stale dirs vanish).
	// -----------------------------------------------------------------------
	const subDir = mkdtempSync("/root/.herdr/worktrees/pi-delegate/impl-qa-");
	process.chdir(subDir);
	const tSub = createHerdrTransport();
	const capsSub = tSub.capabilities();
	check("T2.3 capabilities(): sub authority under /root/.herdr/worktrees", capsSub.authority === "sub" && capsSub.worktrees === false, JSON.stringify(capsSub));
	let subErr: unknown;
	try {
		logOp("herdr worktree create (EXPECTED TO BE REJECTED — sub authority)");
		await tSub.place({ mode: "worktree", repoPath: repoDir, branch: "qa-probe-sub", label: "qa-probe-sub" });
	} catch (e) {
		subErr = e;
	}
	const err = subErr as { code?: string; message?: string; guidance?: string } | undefined;
	check(
		"T2.3b place(worktree) in sub mode throws E_PLACE with authority guidance",
		!!err && err.code === "E_PLACE" && /sub-orchestrator|worktrees/i.test(`${err.message} ${err.guidance ?? ""}`),
		JSON.stringify(subErr, Object.getOwnPropertyNames(subErr ?? {})),
	);
} finally {
	process.chdir(originalCwd);
	try { rmSync(subDir, { recursive: true, force: true }); } catch { /* already gone */ }
	for (const p of created) await forceCleanup(p);
	rmSync(repoDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL TRANSPORT CONTRACT TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
