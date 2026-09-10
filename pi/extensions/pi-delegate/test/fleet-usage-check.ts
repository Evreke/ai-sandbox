/**
 * F1 — fleet usage accounting checks (FEATURE-usage-accounting.md).
 *
 * Run with: bun test/fleet-usage-check.ts   (from repo root)
 *
 * Covers:
 *   1. describeFleet — the documented naive derivation rule: first meaningful
 *      line (headings/fences/HTML comments/bare markers skipped), markdown
 *      decoration stripped, ≤10 words; empty input → "".
 *   2. applyFleetTaskFields — set-once semantics: the first spawn's
 *      description/masterSessionPath stick; later spawns never overwrite;
 *      empty-string candidates never set anything.
 *   3. aggregateTaskUsage — the roll-up math over fixture JSONLs (reuses the
 *      parseSessionUsage sums): output/cacheRead/sent(input)/turns totals
 *      across workers; corrupt manifest → null.
 *   4. Tolerance — worker without sessionPath, worker with a missing session
 *      file, corrupt JSONL lines → partial markers + totals from the good
 *      files, never throws.
 *   5. Persistence ("restart") — persistTaskUsageSnapshot stamps m.usage
 *      with computedAt; a FRESH readManifest (the restart path) still sees
 *      description, masterSessionPath and the snapshot; aggregateTaskUsage
 *      itself never writes (read-only contract).
 *   6. formatFleetUsageLine — the exact delegate_status fleet line shape
 *      (description quoted, partial marker appended).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aggregateTaskUsage,
	applyFleetTaskFields,
	describeFleet,
	persistTaskUsageSnapshot,
	readManifest,
	updateManifest,
	type ExchangeManifest,
	type TaskUsageSnapshot,
} from "../src/exchange.ts";
import { formatFleetUsageLine } from "../src/observe.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const dir = mkdtempSync(join(tmpdir(), "fleet-usage-check-"));

// ---------------------------------------------------------------------------
// 1. describeFleet — the derivation rule (documented in exchange.ts)
// ---------------------------------------------------------------------------

check(
	"1a first meaningful line wins (heading + blank + fence skipped)",
	describeFleet("# Task\n\n```bash\nnoise\n```\nFix the login race in the auth module\nLater line") ===
		"Fix the login race in the auth module",
	describeFleet("# Task\n\n```bash\nnoise\n```\nFix the login race in the auth module\nLater line"),
);

check(
	"1b compressed to ≤10 words",
	describeFleet("one two three four five six seven eight nine ten eleven twelve").split(" ").length === 10,
	describeFleet("one two three four five six seven eight nine ten eleven twelve"),
);

check(
	"1c markdown decoration stripped",
	describeFleet("- **Fix** the `login` race") === "Fix the login race",
	describeFleet("- **Fix** the `login` race"),
);

check("1d empty brief → empty string", describeFleet("") === "" && describeFleet("   \n  \n") === "");

check(
	"1e HTML comment / bare marker lines skipped",
	describeFleet("<!-- meta -->\n-\nImplement the rollout plan") === "Implement the rollout plan",
	describeFleet("<!-- meta -->\n-\nImplement the rollout plan"),
);

// ---------------------------------------------------------------------------
// 2. applyFleetTaskFields — set-once semantics
// ---------------------------------------------------------------------------

const baseManifest: ExchangeManifest = {
	task: "t",
	dir: "/tmp/exchange/t",
	workers: [],
};

const first = applyFleetTaskFields(baseManifest, {
	description: "first spawn description",
	masterSessionPath: "/home/x/master.jsonl",
});
check(
	"2a first spawn sets description + masterSessionPath",
	first.description === "first spawn description" && first.masterSessionPath === "/home/x/master.jsonl",
);

const second = applyFleetTaskFields(first, {
	description: "SECOND spawn must not win",
	masterSessionPath: "/home/x/other.jsonl",
});
check(
	"2b later spawns never overwrite (set-once)",
	second.description === "first spawn description" && second.masterSessionPath === "/home/x/master.jsonl",
);

const third = applyFleetTaskFields(baseManifest, { description: "", masterSessionPath: "" });
check(
	"2c empty candidates never set anything",
	third.description === undefined && third.masterSessionPath === undefined,
);

check("2d pure — input manifest untouched", baseManifest.description === undefined && baseManifest.masterSessionPath === undefined);

// ---------------------------------------------------------------------------
// 3.+4. aggregateTaskUsage — math + tolerance over fixture JSONLs
// ---------------------------------------------------------------------------

// Fixture JSONLs (same shape usage-check.ts pins for parseSessionUsage).
const sessionA = join(dir, "worker-a.jsonl");
writeFileSync(
	sessionA,
	[
		JSON.stringify({ message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 5000, totalTokens: 6200 } } }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 500, output: 100, cacheRead: 3000, totalTokens: 3600 } } }),
	].join("\n"),
);
const sessionB = join(dir, "worker-b.jsonl");
writeFileSync(
	sessionB,
	[
		JSON.stringify({ message: { role: "assistant", usage: { input: 2000, output: 50, cacheRead: 100, totalTokens: 2150 } } }),
		"this line is { corrupt",
		JSON.stringify({ message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 20, totalTokens: 130 } } }),
	].join("\n"),
);

const fleetDir = join(dir, "fleet-task");
mkdirSync(fleetDir, { recursive: true });
writeFileSync(
	join(fleetDir, "manifest.json"),
	JSON.stringify({
		task: "fleet-task",
		dir: fleetDir,
		description: "fix the login race",
		masterSessionPath: "/home/x/master.jsonl",
		workers: [
			{ name: "a", sessionPath: sessionA },
			{ name: "b", sessionPath: sessionB },
			{ name: "no-session" }, // herdr exposed no sessionPath
			{ name: "gone", sessionPath: join(dir, "deleted.jsonl") }, // file missing
		],
	}),
);

const snap = aggregateTaskUsage(fleetDir);
check(
	"3a roll-up math: output/cacheRead/sent/turns across workers",
	snap !== null &&
		snap.outputTokens === 200 + 100 + 50 + 10 &&
		snap.cacheReadTokens === 5000 + 3000 + 100 + 20 &&
		snap.sentTokens === 1000 + 500 + 2000 + 100 &&
		snap.turns === 4,
	JSON.stringify(snap),
);
check(
	"3b workers counts every manifest entry (entries never deleted)",
	snap !== null && snap.workers === 4,
);
check(
	"4a tolerance: uncountable workers → partial markers, not errors",
	snap !== null && eq(snap.partial, ["no-session", "gone"]),
	JSON.stringify(snap?.partial),
);
check("4b computedAt is ISO 8601", snap !== null && !Number.isNaN(Date.parse(snap.computedAt)));

check("4c no manifest → null (no fleet yet)", aggregateTaskUsage(join(dir, "no-such-task")) === null);

const corruptDir = join(dir, "corrupt-task");
mkdirSync(corruptDir, { recursive: true });
writeFileSync(join(corruptDir, "manifest.json"), "{ not json");
check("4d corrupt manifest → null, never throws", aggregateTaskUsage(corruptDir) === null);

// ---------------------------------------------------------------------------
// 5. Persistence — cache write + "restart" re-read; read paths never write
// ---------------------------------------------------------------------------

if (snap) {
	await persistTaskUsageSnapshot(fleetDir, snap);
}

// Simulated restart: a brand-new readManifest from disk (same call path a
// fresh watcher process takes) must still see every persisted task field.
const reloaded = readManifest(fleetDir);
check(
	"5a restart: description + masterSessionPath survive (manifest is the store)",
	reloaded?.description === "fix the login race" && reloaded?.masterSessionPath === "/home/x/master.jsonl",
	JSON.stringify(reloaded),
);
check(
	"5b restart: usage snapshot cached with computedAt",
	reloaded?.usage !== undefined &&
		reloaded.usage.outputTokens === snap?.outputTokens &&
		!Number.isNaN(Date.parse(reloaded.usage.computedAt)),
	JSON.stringify(reloaded?.usage),
);

// Read paths must not write: manifest content before/after a bare aggregate.
const before = readFileSync(join(fleetDir, "manifest.json"), "utf8");
aggregateTaskUsage(fleetDir);
const after = readFileSync(join(fleetDir, "manifest.json"), "utf8");
check("5c aggregateTaskUsage never writes (read-only contract)", before === after);

// The cache is advisory: stale snapshot survives even after totals would
// change — the next recompute (5c's read) is the authority, the cache is
// only the durability copy.
check(
	"5d snapshot is a cache, totals recomputed on read",
	eq(aggregateTaskUsage(fleetDir)?.outputTokens, snap?.outputTokens),
);

// ---------------------------------------------------------------------------
// 6. formatFleetUsageLine — the delegate_status surface shape
// ---------------------------------------------------------------------------

const demoSnap: TaskUsageSnapshot = {
	workers: 4,
	outputTokens: 12400,
	cacheReadTokens: 890000,
	sentTokens: 1200000,
	turns: 42,
	partial: ["no-session", "gone"],
	computedAt: new Date().toISOString(),
};
check(
	"6a fleet line shape (description quoted, partial marker appended)",
	formatFleetUsageLine("fleet-task", demoSnap, "fix the login race") ===
		'fleet fleet-task "fix the login race": ↓12.4k out · cache 890k · sent 1200k · 4 workers · partial: no-session, gone',
	formatFleetUsageLine("fleet-task", demoSnap, "fix the login race"),
);
check(
	"6b no description → unquoted label; no partial → no marker",
	formatFleetUsageLine("t", { ...demoSnap, partial: [] }, undefined) ===
		"fleet t: ↓12.4k out · cache 890k · sent 1200k · 4 workers",
	formatFleetUsageLine("t", { ...demoSnap, partial: [] }, undefined),
);

// ---------------------------------------------------------------------------
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nfleet-usage-check: ${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nfleet-usage-check: all checks passed");
