/**
 * text-cap-check — Law 1 truncation duty regression (Wave 4 item 2): the
 * worker-written text paths are bounded in the RENDERED tool result while the
 * full data stays available and the cut is announced.
 *
 * Run with: bun test/text-cap-check.ts   (from repo root; no live herdr).
 *
 * Covers:
 *   1. capWorkerText: small text passes through unchanged; oversized text is
 *      head-truncated with a bracketed notice naming the full copy.
 *   2. delegate_mailbox read: a multi-megabyte worker question renders
 *      bounded (≪ the input size), with the truncation notice + the q-file
 *      path; details.questions carries the FULL question (honest payload).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capWorkerText } from "../src/text-cap.ts";
import { updateManifest } from "../src/exchange.ts";
import { questionPathFor } from "../src/expaths.ts";
import { registerMailboxTool } from "../src/mailbox-tool.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// --- Part 1 — capWorkerText (pure helper) -----------------------------------

const small = capWorkerText("short summary", "Full report: /tmp/x/report.json.");
check("TC1 small text passes through unchanged, not flagged", small.text === "short summary" && small.truncated === false);

const big = "line\n".repeat(5000); // > DEFAULT_MAX_LINES (2000)
const bigCap = capWorkerText(big, "Full report: /tmp/x/report.json.");
check(
	"TC2 oversized text is head-truncated with a bracketed notice naming the full copy",
	bigCap.truncated === true && bigCap.text.includes("[Truncated") && bigCap.text.includes("Full report: /tmp/x/report.json."),
	`len=${bigCap.text.length}`,
);

// --- Part 2 — delegate_mailbox read caps the question body ------------------

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `text-cap-exchange-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const DIR = join(EXCHANGE_SANDBOX, `text-cap-${process.pid}`);
mkdirSync(DIR, { recursive: true });
const NAME = "capq-worker";
const placement = { kind: "tab", checkoutPath: "/tmp/text-cap-nowhere", placementRef: "tmux:s1" } as const;
await updateManifest(DIR, (m) => ({
	...m,
	workers: [
		{
			name: NAME,
			placement: placement as never,
			briefPath: join(DIR, `brief-${NAME}.md`),
			reportPath: join(DIR, `report-${NAME}.json`),
			provider: "p",
			model: "m",
			thinking: "low",
			startedAt: new Date().toISOString(),
		},
	],
}));

// A multi-megabyte worker-written question on disk.
const HUGE_QUESTION = "What about the edge case? ".repeat(200_000); // ~5 MB
const qPath = questionPathFor(DIR, NAME);
writeFileSync(
	qPath,
	JSON.stringify({ worker: NAME, ts: new Date().toISOString(), question: HUGE_QUESTION, options: ["a", "b"] }),
);

const transport = {
	place: async () => placement,
	startAgent: async () => ({ name: NAME }),
	submitPrompt: async () => {},
	waitSettle: async () => ({ kind: "settled", status: "idle" }),
	getStatus: async () => null,
	listStatuses: async () => [],
	teardown: async () => ({ alreadyGone: false }),
	capabilities: () => ({ worktrees: true, authority: "root" }),
	backendName: () => "herdr",
} as unknown as Transport;

let captured: { execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> } | undefined;
registerMailboxTool({ registerTool: (t: never) => (captured = t as never) } as never, transport);
const result = await captured!.execute("t1", { action: "read", name: NAME }, undefined, () => {}, {});
const text = result.content.map((c) => (c as { text: string }).text).join("\n");

check(
	"TC3 mailbox read renders BOUNDED text (≪ the multi-MB question) with the truncation notice",
	text.length < 200_000 && text.includes("[Truncated"),
	`rendered=${text.length} bytes for a ${HUGE_QUESTION.length}-byte question`,
);
check("TC4 the notice points at the full q-file on disk", text.includes(qPath));
const detailsQuestions = (result.details.questions as Array<{ question: string }>) ?? [];
check(
	"TC5 details.questions carries the FULL question (display cap only)",
	detailsQuestions.length === 1 && detailsQuestions[0]?.question === HUGE_QUESTION,
	`details len=${detailsQuestions[0]?.question.length}`,
);

// --- self cleanup -----------------------------------------------------------
rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} TEXT-CAP CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL TEXT-CAP CHECKS PASSED");
