/**
 * Collect-teardown matrix DRIVER (v1.12.1, §22) — runs in a child bun process
 * spawned by test/collect-teardown-check.ts, which sets $HOME at spawn time
 * (bun caches os.homedir(); the collect config must resolve against the
 * parent's temp HOME) and passes the scenario name as argv[2].
 *
 * Drives the REAL registerDelegateTool().execute() against a mock transport
 * over a real /tmp/exchange/<task>/ dir (ensureExchangeDir validates the
 * real root), prints ONE JSON line:
 *   { case, ok, code, teardownCalls, collectedStamped, teardownLog, text }
 * then removes its own exchange dir. Probe runs also remove their worker row
 * from the shared /tmp/exchange/_probe manifest.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, reportPathFor, updateManifest } from "../src/exchange.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import type { Transport } from "../src/transport.ts";

const CASE = process.argv[2] ?? "valid";
const NAME = `ct-${process.pid}`;
const ROOT = `/tmp/exchange/ct-${process.pid}`;
const PROBE_DIR = "/tmp/exchange/_probe";

// --- fixture setup -----------------------------------------------------------

mkdirSync(ROOT, { recursive: true });
const repoDir = mkdtempSync(join(tmpdir(), `ct-repo-${CASE}-`));
const briefPath = join(ROOT, `brief-${NAME}.md`);
writeFileSync(briefPath, `# brief ${NAME}\n\nDo the thing. OUTPUT: report-${NAME}.json\n`);

const reportPath = reportPathFor(ROOT, NAME);
const validReport = JSON.stringify({
	worker: NAME,
	status: "pass",
	summary: "one-paragraph outcome",
	artifacts: ["a.ts"],
	evidence: [{ claim: "c", file: "f.ts:1" }],
});
if (CASE === "valid" || CASE === "q-pending" || CASE === "teardown-throws" || CASE === "probe") {
	if (CASE !== "probe") writeFileSync(reportPath, validReport); // probes never write reports
}
if (CASE === "invalid") {
	writeFileSync(reportPath, JSON.stringify({ worker: NAME, status: "PASS", summary: "s", artifacts: [], evidence: [] }));
}
if (CASE === "q-pending") {
	writeFileSync(join(ROOT, `q-${NAME}.json`), JSON.stringify({ worker: NAME, ts: "T0", question: "keep me mounted?" }));
}
if (CASE === "start-throws") {
	// W0 pin (rng-sum bug 3): pre-seed a SAME-NAME worker from an "earlier run"
	// (own pane, real sessionPath). The refused start must roll back ONLY the
	// entry THIS call appends (name + this paneId + no sessionPath) and must
	// NOT wipe the pre-existing same-name entry (name-only rollback would).
	await updateManifest(ROOT, (m) => ({
		...m,
		workers: [
			...m.workers,
			{
				name: NAME,
				placement: { kind: "worktree", workspaceId: "ws-0", paneId: "pane-old", checkoutPath: join(repoDir, "old") },
				briefPath,
				reportPath,
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: new Date(0).toISOString(),
				sessionPath: join(repoDir, "old-session.jsonl"),
			},
		],
	}));
}

// --- mock transport ----------------------------------------------------------

let teardownCalls = 0;
const transport = (opts: { teardownShouldThrow: boolean; startShouldThrow: boolean }): Transport =>
	({
		place: async (req) => ({
			kind: req.mode,
			workspaceId: "ws-1",
			paneId: "pane-1",
			branch: req.branch,
			checkoutPath: join(repoDir, "checkout"),
		}),
		startAgent: async (req) => {
			if (opts.startShouldThrow) throw new Error("pane dead"); // refused start, rng-sum bug 3 class
			return { name: req.name };
		},
		submitPrompt: async () => {},
		waitSettle: async () => ({ status: "idle", timedOut: false }),
		getStatus: async () => ({ name: NAME, status: "idle" }),
		listStatuses: async () => [],
		teardown: async () => {
			teardownCalls++;
			if (opts.teardownShouldThrow) throw new Error("herdr exploded");
		},
		capabilities: () => ({ worktrees: true, authority: "root" }),
	}) as Transport;

// --- drive the real tool -----------------------------------------------------

let captured: { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
const fakePi = {
	registerTool: (t: never) => {
		captured = t as never;
	},
};
registerDelegateTool(fakePi as never, transport({ teardownShouldThrow: CASE === "teardown-throws", startShouldThrow: CASE === "start-throws" }));

const params =
	CASE === "probe"
		? { name: NAME, mode: "probe", provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir }
		: {
				name: NAME,
				briefPath,
				provider: "p",
				model: "m",
				thinking: "low",
				waitMs: 1000,
				repoPath: repoDir,
			};

const result = await captured.execute("t1", params, undefined, () => {}, { cwd: repoDir, hasUI: false });
const text = result.content.map((c) => c.text).join("\n");
const manifest = readManifest(ROOT);
const worker = manifest?.workers.find((x) => x.name === NAME);

const readLog = (): string => {
	try {
		return readFileSync(join(ROOT, "teardown.log"), "utf8");
	} catch {
		return "";
	}
};

let teardownLog = readLog();
let collectedStamped = typeof worker?.collectedAt === "string" && worker.collectedAt.length > 0;

const out = {
	case: CASE,
	ok: result.details.ok === true,
	code: typeof result.details.code === "string" ? result.details.code : "",
	probe: result.details.probe ?? "",
	phase: result.details.phase ?? "",
	teardownCalls,
	collectedStamped,
	teardownLog,
	workers: (manifest?.workers ?? []).map((w) => ({
		name: w.name,
		paneId: w.placement?.paneId ?? "",
		hasSession: typeof w.sessionPath === "string" && w.sessionPath.length > 0,
	})),
	text,
};
console.log(JSON.stringify(out));

// --- self cleanup -------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
rmSync(repoDir, { recursive: true, force: true });
if (CASE === "probe") {
	// Remove this run's row from the SHARED probe manifest (scratch dir by
	// design, but a test must not leave fleet rows behind).
	try {
		await updateManifest(PROBE_DIR, (m) => ({ ...m, workers: m.workers.filter((w) => w.name !== NAME) }));
	} catch {
		// cleanup is best-effort; the dir ages out via the 24 h lookback anyway
	}
}
