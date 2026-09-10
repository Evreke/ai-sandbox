/**
 * host-fake-check — PoC end-to-end drive of the WorkerHost seam on the fake
 * (workerhost inversion, design-host-interface.md §7 charter + brief items 3,
 * 4, 6). Run with: bun run test/host-fake-check.ts
 *
 * Proves (the brief's «Must prove» items 2 and 4):
 *   1. The seam works with an OPAQUE placementRef end-to-end — place →
 *      manifest round-trip → teardown — with the fake's internal ids confined
 *      to the "adapter" (src/host/fake.ts imports no herdr code; the tool
 *      flow below is the REAL registerDelegateTool/spawn.ts code path).
 *   2. Manifest records written on the new shape (backend:"fake" +
 *      placementRef ALONGSIDE legacy kind/checkoutPath/paneId) round-trip
 *      through the tolerant reader AND parse under the OLD reader semantics
 *      (version-skew fixture: kind/checkoutPath/paneId present as strings).
 *   3. Teardown idempotency: the second teardown resolves ok (no-op success).
 *   4. Ref-based dedup: the spawn-style "entry THIS call appended" identity
 *      works on name+placementRef equality (replicating the manifest dedup
 *      logic of src/spawn.ts with refs instead of herdr pane ids).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, scanAllManifests, updateManifest, type ManifestWorker } from "../src/exchange.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NAME = `hf-${process.pid}`;
// Fixture hygiene (field lesson 2026-09-10): the exchange root is SANDBOXED
// via $PI_DELEGATE_EXCHANGE_ROOT → a mkdtemp dir. Test manifests are never
// written into the live /tmp/exchange root (a bystander orchestrator's
// fail-open legacy scan used to wake on them). ensureExchangeDir validates
// against the overridden root — same code path as production.
const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), `host-fake-exchange-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const ROOT = join(EXCHANGE_SANDBOX, `host-fake-${process.pid}`);
const repoDir = mkdtempSync(join(tmpdir(), `host-fake-repo-`));
const briefPath = join(ROOT, `brief-${NAME}.md`);
const reportPath = join(ROOT, `report-${NAME}.json`);
mkdirSync(ROOT, { recursive: true });
writeFileSync(briefPath, `# brief ${NAME}\n\nDo the thing. OUTPUT: report-${NAME}.json\n`);
// The worker's report pre-exists (collect-teardown-driver "valid" fixture
// style) so the real collect path succeeds and fires the auto-teardown.
writeFileSync(
	reportPath,
	JSON.stringify({
		worker: NAME,
		status: "pass",
		summary: "one-paragraph outcome",
		artifacts: ["a.ts"],
		evidence: [{ claim: "c", file: "f.ts:1" }],
	}),
);

// ---------------------------------------------------------------------------
// Part A — direct seam drive on the fake (place → manifest → teardown)
// ---------------------------------------------------------------------------

const fake = new FakeWorkerHost({
	repoPath: repoDir,
	manifestDir: ROOT,
	briefPath,
	reportPath,
	statusScript: ["working", "done"],
});

const caps = fake.capabilities();
check("A1 capabilities: the fake fakes no filesystem isolation (worktrees:false, root authority)", caps.worktrees === false && caps.authority === "root");

const placement = await fake.place({ mode: "tab", repoPath: repoDir, branch: "", label: NAME });
check(
	"A2 place synthesizes an opaque placementRef fake:<n> + backend tag",
	/^fake:\d+$/.test(placement.placementRef ?? "") && placement.backend === "fake",
	JSON.stringify(placement),
);
check(
	"A3 placement keeps the legacy-shaped fields (kind/checkoutPath/paneId/workspaceId)",
	placement.kind === "tab" &&
		typeof placement.checkoutPath === "string" &&
		typeof placement.paneId === "string" &&
		typeof placement.workspaceId === "string",
	JSON.stringify(placement),
);

// Worktree rejection on worktrees:false (authority model, seam contract).
let rejectedWorktree = false;
try {
	await fake.place({ mode: "worktree", repoPath: repoDir, branch: "x", label: "nope" });
} catch {
	rejectedWorktree = true;
}
check("A4 place() rejects worktree requests when capabilities().worktrees is false", rejectedWorktree);

const start = await fake.startAgent({
	name: NAME,
	placementRef: placement.placementRef ?? placement.paneId,
	provider: "p",
	model: "m",
	thinking: "low",
	timeoutMs: 1000,
});
check("A5 startAgent reads back the canonical name (seam contract)", start.name === NAME);

// Name-taken → E_NAME (D4 seam contract the fake must reproduce).
let nameTaken = false;
try {
	await fake.startAgent({ name: NAME, placementRef: placement.placementRef ?? placement.paneId, provider: "p", model: "m", thinking: "low", timeoutMs: 1000 });
} catch (err) {
	nameTaken = (err as { code?: string }).code === "E_NAME";
}
check("A6 name collision maps to E_NAME (D4)", nameTaken);

// Manifest round-trip: the entry the fake appended is readable through the
// tolerant reader with BOTH new (placementRef/backend) and legacy fields.
const manifest = readManifest(ROOT);
const entry = manifest?.workers.find((w) => w.name === NAME);
check(
	"A7 manifest round-trip: placementRef + backend alongside legacy fields",
	!!entry &&
		entry.placement.placementRef === placement.placementRef &&
		entry.placement.backend === "fake" &&
		typeof entry.placement.paneId === "string" &&
		typeof entry.placement.checkoutPath === "string",
	JSON.stringify(entry?.placement),
);

await fake.submitPrompt({ name: NAME, text: "read the brief", timeoutMs: 1000 });
check("A8 submitPrompt records the accepted prompt", fake.prompts.length === 1);

const settle = await fake.waitSettle({
	name: NAME,
	timeoutMs: 5000,
	onPoll: () => {},
	proofSettled: async () => false,
});
check("A9 scripted waitSettle settles done, no timeout, started (two-phase D3 shape)", settle.status === "done" && settle.timedOut === false && !settle.neverStarted, JSON.stringify(settle));

const status = await fake.getStatus(NAME);
check("A10 getStatus: not-found → null contract + scripted head", status !== null && status.status === "done" && status.placementRef === placement.placementRef, JSON.stringify(status));

await fake.teardown({ name: NAME, placement, force: true });
await fake.teardown({ name: NAME, placement, force: true }); // second close
check("A11 teardown idempotency: second teardown resolves ok (no-op success), both calls counted", fake.teardownCalls === 2);

// Ref-based dedup — replicate the spawn.ts manifest-dedup identity with refs:
// "the entry THIS call appended" = (name, placementRef) match.
const OTHER = `${NAME}-other`;
await updateManifest(ROOT, (m) => ({
		...m,
		workers: [
			...m.workers,
			{
				name: NAME, // SAME name, DIFFERENT ref — a same-name worker from an earlier run
				placement: { kind: "tab", workspaceId: "fake-ws-old", paneId: "fake:pold", checkoutPath: repoDir, backend: "fake", placementRef: "fake:999" },
				briefPath,
				reportPath,
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: new Date(0).toISOString(),
				sessionPath: join(repoDir, "old-session.jsonl"), // a real prior session → must survive dedup
			} satisfies (typeof m.workers)[number],
		],
}));
const m2 = readManifest(ROOT);
const before = m2?.workers.filter((w) => w.name === NAME).length ?? 0;
// spawn.ts:1159 logic, ref-swapped: w.name === name && w.placement.paneId === paneId
// becomes w.name === name && w.placement.placementRef === ref.
const REF = placement.placementRef ?? "";
const deduped = (m2?.workers ?? []).filter((w) => !(w.name === NAME && w.placement.placementRef === REF));
check(
	"A12 dedup by ref: removes exactly THIS call's entry (name+placementRef), preserves the same-name other-ref worker",
	before === 2 && deduped.length === (m2?.workers.length ?? 0) - 1 && deduped.some((w) => w.name === NAME && w.placement.placementRef === "fake:999"),
	`before=${before} after=${deduped.length}`,
);

// ---------------------------------------------------------------------------
// Part B — version-skew fixture: the manifest the fake wrote parses under the
// OLD reader semantics (pre-change Placement expectations: kind/checkoutPath/
// paneId present as strings; tolerant top-level shape task/dir/workers).
// ---------------------------------------------------------------------------

const raw = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as {
	task?: unknown;
	dir?: unknown;
	workers?: Array<{ placement?: Record<string, unknown> }>;
};
const skew =
	typeof raw.task === "string" &&
	typeof raw.dir === "string" &&
	Array.isArray(raw.workers) &&
	raw.workers.length > 0 &&
	raw.workers.every(
		(w) =>
			typeof w.placement?.kind === "string" &&
			typeof w.placement?.checkoutPath === "string" &&
			typeof w.placement?.paneId === "string",
	);
check("B1 version skew: new-shape manifest parses under OLD reader semantics (kind/checkoutPath/paneId present)", skew, JSON.stringify(raw).slice(0, 300));

// ---------------------------------------------------------------------------
// Part C — tool-level e2e: the REAL delegate tool flow on the fake
// (collect-teardown-driver style): place → manifest write (production code) →
// prompt → settle → collect → auto-teardown — all through the seam.
// ---------------------------------------------------------------------------

const ROOT2 = join(EXCHANGE_SANDBOX, `host-fake-tool-${process.pid}`);
const brief2 = join(ROOT2, `brief-${NAME}.md`);
const report2 = join(ROOT2, `report-${NAME}.json`);
mkdirSync(ROOT2, { recursive: true });
writeFileSync(brief2, `# brief ${NAME}\n\nDo the thing. OUTPUT: report-${NAME}.json\n`);
writeFileSync(
	report2,
	JSON.stringify({
		worker: NAME,
		status: "pass",
		summary: "one-paragraph outcome",
		artifacts: [],
		evidence: [{ claim: "c", file: "f.ts:1" }],
	}),
);
const toolFake = new FakeWorkerHost({ repoPath: repoDir, statusScript: ["working", "done"] });
let captured!: { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
registerDelegateTool({ registerTool: (t: never) => (captured = t as never) } as never, toolFake as unknown as Transport);
const result = await captured.execute(
	"t1",
	{ name: NAME, briefPath: brief2, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir, mode: "tab" },
	undefined,
	() => {},
	{ cwd: repoDir, hasUI: false },
);
const details = result.details;
const manifest2 = readManifest(ROOT2);
const toolEntry = manifest2?.workers.find((w) => w.name === NAME);
check(
	"C1 real delegate flow succeeds on the fake (ok verdict, settled, report collected)",
	details.ok === true && typeof details.report === "object",
	JSON.stringify(result.content.map((c) => c.text).join("\n")).slice(0, 300),
);
check(
	"C2 the tool flow persisted the fake's opaque placementRef + backend into the manifest (ALONGSIDE legacy fields)",
	!!toolEntry &&
		toolEntry.placement.placementRef?.startsWith("fake:") === true &&
		toolEntry.placement.backend === "fake" &&
		typeof toolEntry.placement.paneId === "string",
	JSON.stringify(toolEntry?.placement),
);
check(
	"C3 auto-teardown fired through the seam exactly once after the valid collect",
	toolFake.teardownCalls === 1,
	`teardownCalls=${toolFake.teardownCalls}`,
);
check(
	"C4 tool flow consumed the brief prompt via submitPrompt",
	toolFake.prompts.length === 1 && toolFake.prompts[0]?.includes(brief2),
	JSON.stringify(toolFake.prompts).slice(0, 200),
);
// Idempotency through the tool path: a second teardown command on the SAME
// placement (already torn down) is a no-op success.
if (toolEntry) {
	await toolFake.teardown({ name: NAME, placement: toolEntry.placement, force: true });
	check("C5 second teardown after auto-teardown resolves ok (idempotent, tool path)", toolFake.teardownCalls === 2);
}

// ---------------------------------------------------------------------------
// Part D — watcher-scan backend gate (fixture hygiene, field lesson
// 2026-09-10): a manifest entry whose placement carries backend:"fake" must
// NEVER wake a herdr session through scanAllManifests; legacy entries (no
// backend) keep their fail-open semantics.
// ---------------------------------------------------------------------------

{
	const droot = join(EXCHANGE_SANDBOX, `scan-gate-${process.pid}`);
	mkdirSync(droot, { recursive: true });
	const legacyEntry: ManifestWorker = {
		name: "legacy-worker",
		placement: { kind: "tab", workspaceId: "ws-l", paneId: "pane-l", checkoutPath: repoDir },
		briefPath: "",
		reportPath: "",
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: new Date().toISOString(),
	};
	const fakeEntry: ManifestWorker = {
		...legacyEntry,
		name: "fake-worker",
		placement: { kind: "tab", workspaceId: "ws-f", paneId: "pane-f", checkoutPath: repoDir, backend: "fake", placementRef: "fake:1" },
	};
	await updateManifest(droot, (m) => ({ ...m, workers: [legacyEntry, fakeEntry] }));
	const scanned = scanAllManifests().find((m) => m.dir === droot);
	const names = scanned?.workers.map((w) => w.name) ?? [];
	check(
		"D1 scan backend gate: backend:\"fake\" entries are skipped, legacy (no backend) fail open",
		!!scanned && names.includes("legacy-worker") && !names.includes("fake-worker"),
		JSON.stringify(names),
	);
}

// --- self cleanup -----------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
rmSync(ROOT2, { recursive: true, force: true });
rmSync(repoDir, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} HOST-FAKE CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL HOST-FAKE CHECKS PASSED");
