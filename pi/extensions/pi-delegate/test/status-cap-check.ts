/**
 * status-cap-check — Law 1 truncation duty regression for `delegate_status`
 * (Wave 4 item 2).
 *
 * Run with: bun test/status-cap-check.ts   (from repo root; no live herdr —
 * the transport is a stub).
 *
 * Covers:
 *   1. A status listing over a synthetic manifest with > STATUS_MAX_ROWS
 *      workers renders ≤ STATUS_MAX_ROWS worker ROWS plus the
 *      "N more omitted" note (display cap).
 *   2. details.workers still carries the FULL worker list (display cap only —
 *      the machine-readable payload stays honest).
 *   3. Ordering: live workers (working/blocked) render before drained ones.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateManifest, type ManifestWorker } from "../src/exchange.ts";
import { registerStatusTool, STATUS_MAX_ROWS } from "../src/status-tool.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Fixture hygiene (host-fake-check pattern): the exchange root is SANDBOXED
// via $PI_DELEGATE_EXCHANGE_ROOT → a mkdtemp dir.
const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `status-cap-exchange-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const DIR = join(EXCHANGE_SANDBOX, `status-cap-${process.pid}`);
mkdirSync(DIR, { recursive: true });

const TOTAL = STATUS_MAX_ROWS + 30; // > cap → the omission note must fire
const placement = {
	kind: "tab",
	checkoutPath: "/tmp/status-cap-nowhere",
	placementRef: "tmux:s1",
} as const;

const workers: ManifestWorker[] = [];
for (let i = 0; i < TOTAL; i++) {
	const name = `capw-${String(i).padStart(3, "0")}`;
	workers.push({
		name,
		placement: { ...placement } as ManifestWorker["placement"],
		briefPath: join(DIR, `brief-${name}.md`),
		reportPath: join(DIR, `report-${name}.json`),
		provider: "p",
		model: "m",
		thinking: "low",
		// Stagger recency: worker 0 is the NEWEST (startedAt now, others older).
		startedAt: new Date(Date.now() - i * 60_000).toISOString(),
	});
}
await updateManifest(DIR, (m) => ({ ...m, workers }));

// Two LIVE workers (working) — they must render before the drained ones
// regardless of the manifest order / recency of the drained tail.
const LIVE = ["capw-000", "capw-001"];

const transport = {
	place: async () => placement,
	startAgent: async () => ({ name: "x" }),
	submitPrompt: async () => {},
	waitSettle: async () => ({ kind: "settled", status: "idle" }),
	getStatus: async () => null,
	listStatuses: async () =>
		LIVE.map((name) => ({ name, status: "working" as const })),
	teardown: async () => ({ alreadyGone: false }),
	capabilities: () => ({ worktrees: true, authority: "root" }),
	backendName: () => "herdr",
} as unknown as Transport;

let captured: { execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> } | undefined;
registerStatusTool({ registerTool: (t: never) => (captured = t as never) } as never, transport);
const result = await captured!.execute("t1", {}, undefined, () => {}, {});
const text = result.content
	.filter((c) => c.type === "text")
	.map((c) => (c as { text: string }).text)
	.join("\n");
const lines = text.split("\n");

// 1. Row cap: exactly STATUS_MAX_ROWS worker rows rendered, plus the note.
const rowRe = /^capw-\d+ /;
const rowLines = lines.filter((l) => rowRe.test(l));
check(
	`SC1 row cap: >${STATUS_MAX_ROWS} workers → exactly ${STATUS_MAX_ROWS} rendered rows`,
	rowLines.length === STATUS_MAX_ROWS,
	`rows=${rowLines.length}`,
);
check("SC2 the omission note is present with the right count", lines.some((l) => l.includes(`${TOTAL - STATUS_MAX_ROWS} more omitted`)), lines.slice(-6).join(" | "));

// 2. Details stay honest: the FULL list is in details.workers.
const detailWorkers = (result.details.workers as Array<{ name: string }>) ?? [];
check("SC3 details.workers carries the full list (display cap only)", detailWorkers.length === TOTAL, `details=${detailWorkers.length}`);

// 3. Live-first ordering: the first rendered row is a live worker.
check("SC4 live workers render before drained ones", rowRe.test(lines[0]) && LIVE.includes(lines[0].split(" ")[0]), `firstRow="${lines[0]}"`);

// 4. Single-worker query is unaffected by the cap (name parameter bypasses).
const single = await captured!.execute("t2", { name: "capw-000" }, undefined, () => {}, {});
const singleText = single.content.map((c) => (c as { text: string }).text).join("\n");
check("SC5 single-worker query renders that worker, no omission note", singleText.includes("capw-000") && !singleText.includes("more omitted"));

// --- self cleanup -----------------------------------------------------------
rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} STATUS-CAP CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL STATUS-CAP CHECKS PASSED");
