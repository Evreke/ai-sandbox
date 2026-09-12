/**
 * silent-catch-check — Wave 4 item 6 regression (reliability finding 7):
 * silent catches are surfaced instead of collapsing.
 *
 * Run with: bun test/silent-catch-check.ts   (from repo root; no live herdr).
 *
 * Covers:
 *   1. Start-failure manifest rollback: when the best-effort rollback of the
 *      appended entry ITSELF throws, the start-failure result says so
 *      ("Manifest rollback FAILED …" + details.rollbackFailed) instead of
 *      silence.
 *   2. Watcher audit-log appends: a failed append is COUNTED and emits ONE
 *      warn-once incident line (not per-tick spam, not silence).
 *   (The third surfacing — archiveReport's reason — is pinned by
 *   settle-archive.ts A.11.)
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDelegateTool } from "../src/spawn.ts";
import { manifestStore } from "../src/manifest-store.ts";
import { appendWatcherAudit, watcherAuditAppendFailureCount } from "../src/watcher.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `silent-catch-exchange-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;

// --- 1. start-failure rollback surfacing -------------------------------------
{
	const DIR = join(EXCHANGE_SANDBOX, `rollback-${process.pid}`);
	mkdirSync(DIR, { recursive: true });
	const NAME = "sc-worker";
	const briefPath = join(DIR, `brief-${NAME}.md`);
	writeFileSync(briefPath, `# brief ${NAME}\n\nDo the thing.\n`);

	const placement = { kind: "tab", checkoutPath: "/tmp/sc-nowhere", placementRef: "tmux:s1" } as const;
	const transport = {
		place: async () => placement,
		startAgent: async () => {
			throw new Error("herdr exploded (simulated)");
		},
		submitPrompt: async () => {},
		waitSettle: async () => ({ kind: "settled", status: "idle" }),
		getStatus: async () => null,
		listStatuses: async () => [],
		teardown: async () => ({ alreadyGone: false }),
		capabilities: () => ({ worktrees: true, authority: "root" }),
		backendName: () => "herdr",
	} as unknown as Transport;

	// The FIRST manifest update (append-before-start) succeeds; every LATER
	// one (the rollback lands second) throws — simulating a manifest-write
	// failure exactly at the rollback step.
	const origUpdate = manifestStore.update.bind(manifestStore);
	let updateCalls = 0;
	(manifestStore as { update: typeof manifestStore.update }).update = async (dir, mutate) => {
		updateCalls++;
		if (updateCalls === 1) return origUpdate(dir, mutate);
		throw new Error("disk full (simulated rollback failure)");
	};

	try {
		let captured: { execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> } | undefined;
		registerDelegateTool({ registerTool: (t: never) => (captured = t as never) } as never, transport);
		const result = await captured!.execute(
			"t1",
			{ name: NAME, briefPath, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: "/tmp/sc-nowhere", mode: "tab", releaseOn: "settle" },
			undefined,
			() => {},
			{ cwd: "/tmp/sc-nowhere", hasUI: false },
		);
		const text = result.content.map((c) => (c as { text: string }).text).join("\n");
		check("SC1 start failure reported as a failed result (E_START)", result.details.ok === false && result.details.code === "E_START", JSON.stringify(result.details).slice(0, 200));
		check(
			"SC2 the rollback FAILURE is surfaced in the start-failure text (not silence)",
			text.includes("Manifest rollback FAILED") && text.includes("disk full (simulated rollback failure)"),
			text.slice(-300),
		);
		check("SC3 details.rollbackFailed carries the reason", typeof result.details.rollbackFailed === "string" && (result.details.rollbackFailed as string).includes("disk full"));
	} finally {
		(manifestStore as { update: typeof manifestStore.update }).update = origUpdate;
	}
}

// --- 2. watcher audit-log append failure: counted + warn-once ----------------
{
	// Point pi's agent dir at a FILE — every append fails with ENOTDIR.
	const agentDirFile = join(EXCHANGE_SANDBOX, "agent-dir-is-a-file");
	writeFileSync(agentDirFile, "not a dir");
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirFile;

	const errSpy: string[] = [];
	const origErr = console.error;
	console.error = (...args: unknown[]) => {
		errSpy.push(args.map(String).join(" "));
	};
	try {
		const before = watcherAuditAppendFailureCount();
		appendWatcherAudit("probe line one");
		appendWatcherAudit("probe line two");
		// The append is a fire-and-forget promise — give the event loop a beat.
		await new Promise((r) => setTimeout(r, 50));
		const after = watcherAuditAppendFailureCount();
		check("SC4 failed audit appends are COUNTED (not swallowed silently)", after === before + 2, `before=${before} after=${after}`);
		const warns = errSpy.filter((m) => m.includes("audit-log append FAILED"));
		check("SC5 exactly ONE warn-once incident line (no per-tick spam)", warns.length === 1, JSON.stringify(errSpy));
	} finally {
		console.error = origErr;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
}

// --- self cleanup ------------------------------------------------------------
rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} SILENT-CATCH CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL SILENT-CATCH CHECKS PASSED");
