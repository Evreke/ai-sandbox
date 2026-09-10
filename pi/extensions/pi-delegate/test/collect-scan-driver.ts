/**
 * Collect-scan DRIVER (report-path mismatch incident, 2026-09) — runs in a
 * child bun process spawned by test/collect-scan-check.ts, which sets $HOME at
 * spawn time (bun caches os.homedir()) and passes the scenario name as argv[2].
 *
 * Drives the REAL registerDelegateTool().execute() against a mock transport
 * over a sandboxed /tmp/exchange dir ($PI_DELEGATE_EXCHANGE_ROOT) and prints
 * ONE JSON line: { case, ok, code, text, usedReportPath }.
 *
 * Scenarios:
 *   sibling  — canonical report ABSENT, a SIBLING worker's valid
 *              report-sib.json present (fresh mtime): the sibling must NOT be
 *              adopted and must be NAMED in the failure text as evidence.
 *   stray-md — canonical report ABSENT, a Markdown report-<name>.md present
 *              (the incident shape): loud failure naming the .md file.
 *   fallback — host uniquified the name (canonical ≠ requested); the worker
 *              wrote report-<requested>.json (worker field = canonical):
 *              collect adopts it with the fallback note.
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, reportPathFor } from "../src/exchange.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import type { Transport } from "../src/host.ts";

const CASE = process.argv[2] ?? "sibling";
const NAME = `cs-${process.pid}`;
// Fixture hygiene: the exchange root is SANDBOXED via $PI_DELEGATE_EXCHANGE_ROOT.
const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `collect-scan-${CASE}-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const ROOT = join(EXCHANGE_SANDBOX, `cs-${process.pid}`);

mkdirSync(ROOT, { recursive: true });
const repoDir = mkdtempSync(join(tmpdir(), `cs-repo-${CASE}-`));
const briefPath = join(ROOT, `brief-${NAME}.md`);
writeFileSync(briefPath, `# brief ${NAME}\n\nDo the thing. OUTPUT: write report-${NAME}.json\n`);

// Uniquification scenario: the host renamed the agent AFTER start (canonical
// differs from the requested name); the worker wrote the REQUESTED-name report.
const CANONICAL = CASE === "fallback" ? `${NAME}u` : NAME;

const validReport = (worker: string) =>
	JSON.stringify({
		worker,
		status: "pass",
		summary: "one-paragraph outcome",
		artifacts: ["a.ts"],
		evidence: [{ claim: "c", file: "f.ts:1" }],
	});

// Seed strays with a FUTURE mtime: startedAtDate is created inside execute(),
// so any pre-seeded file must postdate it to pass the mtime fence (the fixture
// stands in for "the worker wrote this during the run").
const FRESH = Date.now() + 5 * 60_000;
const touch = (p: string) => utimesSync(p, new Date(FRESH), new Date(FRESH));

if (CASE === "sibling") {
	const p = join(ROOT, "report-sib.json");
	writeFileSync(p, validReport("sib"));
	touch(p);
}
if (CASE === "stray-md") {
	const p = join(ROOT, `report-${NAME}.md`);
	writeFileSync(p, "# report\n\nDone (markdown narrative).\n");
	touch(p);
}
if (CASE === "fallback") {
	const p = reportPathFor(ROOT, NAME); // requested-name path (canonical is NAMEu)
	writeFileSync(p, validReport(CANONICAL));
	touch(p);
}

let teardownCalls = 0;
const transport: Transport =
	({
		place: async (req) => ({
			kind: req.mode,
			workspaceId: "ws-1",
			paneId: "pane-1",
			branch: req.branch,
			checkoutPath: join(repoDir, "checkout"),
		}),
		startAgent: async (req) => ({ name: CANONICAL }),
		submitPrompt: async () => {},
		waitSettle: async () => ({ status: "idle", timedOut: false }),
		getStatus: async () => ({ name: CANONICAL, status: "idle" }),
		listStatuses: async () => [],
		teardown: async () => {
			teardownCalls++;
		},
		capabilities: () => ({ worktrees: true, authority: "root" }),
	}) as Transport;

let captured: { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
const fakePi = {
	registerTool: (t: never) => {
		captured = t as never;
	},
};
registerDelegateTool(fakePi as never, transport);

const result = await captured.execute(
	"t1",
	{ name: NAME, briefPath, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir },
	undefined,
	() => {},
	{ cwd: repoDir, hasUI: false },
);
const text = result.content.map((c) => c.text).join("\n");
const manifest = readManifest(ROOT);

const out = {
	case: CASE,
	ok: result.details.ok === true,
	code: typeof result.details.code === "string" ? result.details.code : "",
	text,
};
console.log(JSON.stringify(out));

rmSync(ROOT, { recursive: true, force: true });
rmSync(repoDir, { recursive: true, force: true });
