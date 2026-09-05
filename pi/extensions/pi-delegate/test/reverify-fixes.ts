/**
 * Re-verification of QA defects D1/D2 + observations O1/O2 after master fixes
 * (commits 16f4596, 0bf4ac6, merged via main → impl/qa).
 *
 * Run with: bun test/reverify-fixes.ts   (from repo root; cwd = sub-orchestrator worktree)
 *
 *   D1  getStatus/listStatuses/waitSettle against LIVE herdr agents:
 *       - getStatus("qa") (this very pane, live) must report a REAL status, not "unknown"
 *       - listStatuses() entries must carry real statuses + non-empty names
 *       - waitSettle on an ALREADY-IDLE live agent must settle <5s (not burn the timeout)
 *   D2  startAgent with colliding live name "qa" → E_NAME with candidates guidance
 *       (real herdr call, fails immediately on the name-taken check)
 *   O2  teardown reconciliation, PATH-stubbed herdr:
 *       - worktree remove ok + workspace shell survives → close → re-verify → success
 *       - unclosable shell → E_PLACE "still present after herdr workspace close"
 *       - sub-authority worktree teardown rejected with E_PLACE before any herdr call
 */

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createHerdrTransport, DelegateErrorImpl } from "../src/transport/herdr.ts";

// State dependency: this historical script verifies fixes against a LIVE agent
// named "qa" (the v1.2 QA worker). That agent no longer exists; when absent,
// SKIP with an explanation instead of failing (the assertions it protected are
// permanently covered by test/transport-contract.ts, which is self-sufficient).
const liveQa = (() => {
	try {
		const out = execFileSync("herdr", ["agent", "list"], { encoding: "utf8" });
		return JSON.parse(out).result.agents.some((a: { name?: string }) => a.name === "qa");
	} catch {
		return false;
	}
})();
if (!liveQa) {
	console.log("SKIP: reverify-fixes requires a live agent named 'qa' (legacy v1.2 state).");
	console.log("SKIP: its assertions are permanently covered by test/transport-contract.ts.");
	process.exit(0);
}
import type { Transport } from "../src/transport/types.ts";

const execFileP = promisify(execFile);
const OPS_LOG = "/tmp/exchange/pi-delegate-ext/qa-herdr-ops.log";
const logOp = (cmd: string) =>
	appendFileSync(OPS_LOG, `${new Date().toISOString()} ${cmd}\n`);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function errShape(e: unknown): { code?: string; message?: string; guidance?: string } {
	return (e ?? {}) as { code?: string; message?: string; guidance?: string };
}

// ---------------------------------------------------------------------------
// D1 — live status parsing (real herdr; read-only ops)
// ---------------------------------------------------------------------------
const t = createHerdrTransport(); // cwd is a herdr worktree → sub authority (fine for read-only)

{
	const st = await t.getStatus("qa"); // THIS live agent (the qa pane itself)
	check(
		"D1a getStatus('qa') on THIS live agent returns a real status + name",
		st?.name === "qa" && ["idle", "working", "blocked", "done"].includes(st.status),
		JSON.stringify(st),
	);

	const list = await t.listStatuses();
	const qaEntry = list.find((a) => a.name === "qa");
	const anyReal = list.some((a) => ["idle", "working", "blocked", "done"].includes(a.status));
	const noneUnknown = list.every((a) => a.status !== "unknown");
	check(
		"D1b listStatuses(): 'qa' entry present with real status; every entry's status parsed (no 'unknown' leaks)",
		!!qaEntry && anyReal && noneUnknown,
		`entries=${list.length} qa=${JSON.stringify(qaEntry)}` +
			(noneUnknown ? "" : ` unknown=${list.filter((a) => a.status === "unknown").length}`),
	);

	// waitSettle on an already-idle live agent (not our own pane).
	const idle = list.find(
		(a) => a.status === "idle" && a.name !== "qa" && a.name.length > 0 && a.name !== "unknown",
	);
	if (idle) {
		logOp(`herdr agent wait ${idle.name} --until idle --until done --until blocked --timeout 3000  (D1c waitSettle on live idle agent)`);
		const t0 = Date.now();
		const settle = await t.waitSettle({ name: idle.name, timeoutMs: 60_000 });
		const elapsed = Date.now() - t0;
		check(
			"D1c waitSettle on live IDLE agent settles <5s (not timeout-burned)",
			!settle.timedOut && settle.status === "idle" && elapsed < 5_000,
			`status=${settle.status} timedOut=${settle.timedOut} elapsed=${elapsed}ms agent=${idle.name}`,
		);
	} else {
		check("D1c waitSettle on live IDLE agent settles <5s", false, "no live idle agent found to test against");
	}
}

// ---------------------------------------------------------------------------
// D2 — colliding live name → E_NAME with candidates guidance (real, fast-failing herdr call)
// ---------------------------------------------------------------------------
{
	const myPane = process.env.HERDR_PANE_ID ?? "w4B:p1";
	logOp(`herdr agent start qa --kind pi --pane ${myPane} --timeout 5000 -- ...  (D2 collision probe — expected to fail immediately)`);
	let err: unknown;
	try {
		await t.startAgent({
			name: "qa",
			paneId: myPane,
			provider: "llm-platform-alpha",
			model: "glm-5.3-flash",
			thinking: "high",
			timeoutMs: 5_000,
		});
	} catch (e) {
		err = e;
	}
	const e = errShape(err);
	const all = `${e.message ?? ""} ${e.guidance ?? ""}`;
	check(
		"D2 colliding live name 'qa' → E_NAME with candidates guidance",
		e.code === "E_NAME" && /candidat/i.test(all),
		err instanceof DelegateErrorImpl || err
			? `code=${e.code} msg=${(e.message ?? "").slice(0, 160)}`
			: "no error thrown — unexpectedly succeeded!",
	);
}

// ---------------------------------------------------------------------------
// O2 — teardown reconciliation via PATH stub (no real herdr ops here)
// ---------------------------------------------------------------------------
{
	const stubDir = "/tmp/qa-o2-stub";
	rmSync(stubDir, { recursive: true, force: true });
	mkdirSync(stubDir, { recursive: true });
	const shim = `#!/usr/bin/env bash
STATE="${stubDir}/state.json"
LOG="${stubDir}/calls.log"
echo "$*" >> "$LOG"
close_target="$(jq -r .close_target "$STATE" 2>/dev/null)"
shell="$(jq -r .shell "$STATE" 2>/dev/null)"
closed="$(jq -r .closed "$STATE" 2>/dev/null)"
if [ "$1 $2" = "worktree remove" ]; then echo '{"id":"x","result":{"type":"ok"}}'; exit 0; fi
if [ "$1 $2" = "workspace list" ]; then
  if [ "$shell" = "true" ] && [ "$closed" != "true" ]; then
    echo "{\\"id\\":\\"x\\",\\"result\\":{\\"workspaces\\":[{\\"workspace_id\\":\\"$close_target\\"}]}}"
  else
    echo '{"id":"x","result":{"workspaces":[]}}'
  fi
  exit 0
fi
if [ "$1 $2" = "workspace close" ]; then
  if [ "$(jq -r .unclosable "$STATE" 2>/dev/null)" = "true" ]; then echo '{"id":"x","result":{"type":"ok"}}'; exit 0; fi
  jq '.closed = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  echo '{"id":"x","result":{"type":"ok"}}'
  exit 0
fi
echo "{\\"error\\":{\\"code\\":\\"stub_unhandled\\",\\"message\\":\\"$*\\"}}" >&2; exit 1
`;
	writeFileSync(resolve(stubDir, "herdr"), shim, { mode: 0o755 });
	writeFileSync(resolve(stubDir, "state.json"), JSON.stringify({ shell: "true", close_target: "wSHELL", closed: "false", unclosable: "false" }));

	const fakePlacement = {
		kind: "worktree" as const,
		workspaceId: "wSHELL",
		paneId: "wSHELL:p1",
		branch: "stub",
		checkoutPath: "/tmp/stub",
		isLinkedWorktree: true,
	};

	const savedPath = process.env.PATH ?? "";
	process.env.PATH = `${stubDir}:${savedPath}`;
	process.chdir("/tmp"); // root authority
	try {
		const tStub = createHerdrTransport();
		await tStub.teardown({ name: "x", placement: fakePlacement, force: true });
		const calls = readFileSync(resolve(stubDir, "calls.log"), "utf8").trim().split("\n");
		check(
			"O2a teardown reconciles surviving workspace shell: remove → list → close → re-verify",
			calls.length === 4 &&
				calls[0].startsWith("worktree remove") &&
				calls[1].startsWith("workspace list") &&
				calls[2].startsWith("workspace close") &&
				calls[3].startsWith("workspace list"),
			calls.join(" | "),
		);

		// Unclosable shell → must surface E_PLACE instead of silent success.
		writeFileSync(
			resolve(stubDir, "state.json"),
			JSON.stringify({ shell: "true", close_target: "wSTUCK", closed: "false", unclosable: "true" }),
		);
		let stuckErr: unknown;
		try {
			await tStub.teardown({
				name: "x",
				placement: { ...fakePlacement, workspaceId: "wSTUCK" },
				force: true,
			});
		} catch (e) {
			stuckErr = e;
		}
		const se = errShape(stuckErr);
		check(
			"O2b unclosable workspace shell → E_PLACE 'still present after herdr workspace close'",
			se.code === "E_PLACE" && /still present/.test(se.message ?? ""),
			`code=${se.code} msg=${(se.message ?? "").slice(0, 120)}`,
		);

		// Sub-authority worktree teardown guard (no herdr call may happen).
		process.env.PATH = savedPath;
		process.chdir("/root/.herdr/worktrees/pi-delegate/impl-qa");
		const tSub = createHerdrTransport();
		rmSync(resolve(stubDir, "calls.log"), { force: true });
		let subErr: unknown;
		try {
			await tSub.teardown({ name: "x", placement: fakePlacement, force: true });
		} catch (e) {
			subErr = e;
		}
		const sube = errShape(subErr);
		const stubTouched = (() => {
			try {
				return readFileSync(resolve(stubDir, "calls.log"), "utf8").length > 0;
			} catch {
				return false;
			}
		})();
		check(
			"O2c sub-authority worktree teardown rejected E_PLACE before any herdr call",
			sube.code === "E_PLACE" && /sub-orchestrator/i.test(`${sube.message} ${sube.guidance}`) && !stubTouched,
			`code=${sube.code} stubTouched=${stubTouched}`,
		);
	} finally {
		process.env.PATH = savedPath;
		process.chdir("/root/.herdr/worktrees/pi-delegate/impl-qa");
		rmSync(stubDir, { recursive: true, force: true });
	}
}

console.log(failures === 0 ? "\nALL RE-VERIFICATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
