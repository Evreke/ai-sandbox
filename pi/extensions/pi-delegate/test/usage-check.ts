/**
 * A8 — Gauge unit checks (DESIGN.md §20, v1.7 dual-gauge contract).
 *
 * Run with: bun test/usage-check.ts   (from repo root)
 *
 * Covers:
 *   1. parseSessionUsage — sums + turns + lastTotalTokens (LAST assistant
 *      totalTokens wins, even when an EARLY line was larger); missing file →
 *      zeros + lastTotalTokens null; corrupt lines skipped; non-assistant
 *      lines ignored; assistant without usage counted as a turn only;
 *      invalid (non-positive/non-finite) usage values filtered.
 *   2. resolveContextWindow — config override (pi-delegate.config.json
 *      {"contextWindow": N}) beats the model map; exact match
 *      (glm-5.3-flash → 524300); contains-match; default 250100; corrupt /
 *      invalid config falls through. NOTE: bun caches os.homedir(), so every
 *      resolveContextWindow scenario runs in a child bun process with HOME
 *      set at spawn time (the documented POSIX override path) — this also
 *      isolates the tests from any real operator config.
 *   3. contextPct / overContext — null-safe (lastTotalTokens null → pct
 *      null → overContext false); ≥ semantics at the 80% boundary; 999 cap;
 *      non-positive window → null.
 *   4. overOutputBudget — unset/invalid budget → false; strict > boundary;
 *      only output counts (input/cache never).
 *   5. formatGaugeLine — exact "ctx 34% ↑12k ↓3.4k" shape; null → "ctx ?%".
 *
 * Exit 0 only if all checks pass.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contextPct,
	formatBudgetLine,
	formatGaugeLine,
	overContext,
	overOutputBudget,
	parseSessionUsage,
	resolveContextWindow,
	resolveSpawnDefaults,
	resolveTierTable,
} from "../src/usage.ts";
import { CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW } from "../src/transport/types.ts";

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

const dir = mkdtempSync(join(tmpdir(), "usage-check-"));

// ---------------------------------------------------------------------------
// 1. parseSessionUsage
// ---------------------------------------------------------------------------

// 1a. sums + turns + lastTotalTokens (last assistant totalTokens wins)
const p1 = join(dir, "s1.jsonl");
writeFileSync(
	p1,
	[
		JSON.stringify({ type: "session", id: "x" }),
		JSON.stringify({ message: { role: "user", content: [] } }),
		JSON.stringify({
			message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 } },
		}),
		JSON.stringify({ other: "noise" }),
		JSON.stringify({ message: { role: "assistant" } }), // no usage block
		JSON.stringify({
			message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 } },
		}),
	].join("\n"),
);
check(
	"1a sums + turns + lastTotalTokens (last wins)",
	eq(parseSessionUsage(p1), {
		input: 101, output: 22, cacheRead: 33, cacheWrite: 9, turns: 3, lastTotalTokens: 10,
	}),
	JSON.stringify(parseSessionUsage(p1)),
);

// 1b. EARLY line has larger totalTokens — LAST still wins (state, not max)
const p2 = join(dir, "s2.jsonl");
writeFileSync(
	p2,
	[
		JSON.stringify({ message: { role: "assistant", usage: { input: 9000, output: 100, totalTokens: 9100 } } }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 50, output: 1, totalTokens: 51 } } }),
	].join("\n"),
);
check(
	"1b early larger totalTokens — last wins, not max",
	eq(parseSessionUsage(p2), {
		input: 9050, output: 101, cacheRead: 0, cacheWrite: 0, turns: 2, lastTotalTokens: 51,
	}),
	JSON.stringify(parseSessionUsage(p2)),
);

// 1c. missing file → zeros + lastTotalTokens null, never throws
check(
	"1c missing file → zeroed + null",
	eq(parseSessionUsage(join(dir, "does-not-exist.jsonl")), {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, lastTotalTokens: null,
	}),
);

// 1d. corrupt lines skipped, valid ones around them kept
const p3 = join(dir, "s3.jsonl");
writeFileSync(
	p3,
	[
		"{corrupt json",
		JSON.stringify({ message: { role: "assistant", usage: { input: 7, totalTokens: 7 } } }),
		"\x00\x01not json at all",
		JSON.stringify({ message: { role: "assistant", usage: { input: 8, totalTokens: 8 } } }),
	].join("\n"),
);
check(
	"1d corrupt lines skipped",
	eq(parseSessionUsage(p3), {
		input: 15, output: 0, cacheRead: 0, cacheWrite: 0, turns: 2, lastTotalTokens: 8,
	}),
	JSON.stringify(parseSessionUsage(p3)),
);

// 1e. non-assistant lines ignored (user, tool, bare noise)
const p4 = join(dir, "s4.jsonl");
writeFileSync(
	p4,
	[
		JSON.stringify({ message: { role: "user", usage: { input: 5, totalTokens: 5 } } }),
		JSON.stringify({ message: { role: "toolResult", usage: { input: 5, totalTokens: 5 } } }),
		JSON.stringify({ usage: { input: 5, totalTokens: 5 } }),
	].join("\n"),
);
check(
	"1e non-assistant lines ignored",
	eq(parseSessionUsage(p4), {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, lastTotalTokens: null,
	}),
	JSON.stringify(parseSessionUsage(p4)),
);

// 1f. assistant without usage block: counts as a turn, doesn't touch sums/last
const p5 = join(dir, "s5.jsonl");
writeFileSync(
	p5,
	[
		JSON.stringify({ message: { role: "assistant", usage: { totalTokens: 12 } } }),
		JSON.stringify({ message: { role: "assistant" } }),
	].join("\n"),
);
check(
	"1f assistant without usage → turn only, lastTotalTokens kept",
	eq(parseSessionUsage(p5), {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 2, lastTotalTokens: 12,
	}),
	JSON.stringify(parseSessionUsage(p5)),
);

// 1g. invalid usage values filtered (num(): finite, > 0)
const p6 = join(dir, "s6.jsonl");
writeFileSync(
	p6,
	[
		JSON.stringify({ message: { role: "assistant", usage: { input: -5, output: NaN, totalTokens: 0 } } }),
		JSON.stringify({ message: { role: "assistant", usage: { input: 4, totalTokens: -9 } } }),
	].join("\n"),
);
check(
	"1g invalid usage values filtered, null totalTokens preserved",
	eq(parseSessionUsage(p6), {
		input: 4, output: 0, cacheRead: 0, cacheWrite: 0, turns: 2, lastTotalTokens: null,
	}),
	JSON.stringify(parseSessionUsage(p6)),
);

// 1h. empty file → zeroed
writeFileSync(join(dir, "empty.jsonl"), "");
check(
	"1h empty file → zeroed",
	eq(parseSessionUsage(join(dir, "empty.jsonl")), {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, lastTotalTokens: null,
	}),
);

// ---------------------------------------------------------------------------
// 2. resolveContextWindow — every scenario in a child bun process with HOME
// set at spawn time (bun caches os.homedir(); mid-process $HOME change is NOT
// honored, so the config branch is exercised via the spawn seam).
// ---------------------------------------------------------------------------

const MOD = new URL("../src/usage.ts", import.meta.url).pathname;

function resolveWindowInHome(home: string, modelArg: string): number {
	const src = `import {resolveContextWindow} from ${JSON.stringify(MOD)}; console.log(resolveContextWindow(${modelArg}))`;
	const res = spawnSync("bun", ["-e", src], {
		env: { ...process.env, HOME: home },
		encoding: "utf8",
	});
	return Number(res.stdout.toString().trim());
}

function homeWithConfig(configJson: string): string {
	const home = mkdtempSync(join(tmpdir(), "usage-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	return home;
}

// 2a. config override wins over everything (even an exact model match)
{
	const home = homeWithConfig(JSON.stringify({ contextWindow: 123456 }));
	let w = resolveWindowInHome(home, JSON.stringify("glm-5.3-flash"));
	check("2a config override beats model map", w === 123456, `got ${w}`);
	w = resolveWindowInHome(home, "undefined");
	check("2a' config override applies with no model too", w === 123456, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}

// 2b. exact match: glm-5.3-flash → 524300 (no config present)
{
	const home = homeWithConfig("");
	const w = resolveWindowInHome(home, JSON.stringify("glm-5.3-flash"));
	check("2b exact match glm-5.3-flash → 524300", w === CONTEXT_WINDOWS["glm-5.3-flash"] && w === 524300, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}

// 2c. contains-match: full tensorzero id containing the key
{
	const home = homeWithConfig("");
	const w = resolveWindowInHome(home, JSON.stringify("tensorzero::function_name::glm-5.3-flash"));
	check("2c contains-match → 524300", w === 524300, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}

// 2d/2e. unknown model / no model → default
{
	const home = homeWithConfig("");
	let w = resolveWindowInHome(home, JSON.stringify("some-unknown-model"));
	check("2d unknown model → default", w === DEFAULT_CONTEXT_WINDOW && w === 250100, `got ${w}`);
	w = resolveWindowInHome(home, "undefined");
	check("2e no model → default", w === DEFAULT_CONTEXT_WINDOW, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}

// 2f/2g. corrupt / invalid config → falls through to model resolution
{
	const home = homeWithConfig("not json{");
	const w = resolveWindowInHome(home, JSON.stringify("glm-5.3-flash"));
	check("2f corrupt config falls through to model map", w === 524300, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}
{
	const home = homeWithConfig(JSON.stringify({ contextWindow: -1 }));
	const w = resolveWindowInHome(home, JSON.stringify("glm-5.3-flash"));
	check("2g invalid config value falls through to model map", w === 524300, `got ${w}`);
	rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. contextPct / overContext — null-safe, ≥ boundary, 999 cap
// ---------------------------------------------------------------------------

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

// 3a. null lastTotalTokens → pct null → overContext false (post-compaction)
check("3a null lastTotalTokens → pct null", contextPct({ ...zero, lastTotalTokens: null }, 100000) === null);
check("3a' null lastTotalTokens → overContext false", overContext({ ...zero, lastTotalTokens: null }, 100000, 80) === false);

// 3b. non-positive window → null / false
check("3b non-positive window → pct null", contextPct({ ...zero, lastTotalTokens: 50000 }, 0) === null);
check("3b' non-positive window → overContext false", overContext({ ...zero, lastTotalTokens: 50000 }, 0, 80) === false);

// 3c. ≥ semantics at the operator's restart line (80%)
check(
	"3c exactly 80% → overContext true",
	overContext({ ...zero, lastTotalTokens: 80000 }, 100000, 80) === true &&
		contextPct({ ...zero, lastTotalTokens: 80000 }, 100000) === 80,
);
check(
	"3c' below 80% → overContext false",
	overContext({ ...zero, lastTotalTokens: 79000 }, 100000, 80) === false &&
		contextPct({ ...zero, lastTotalTokens: 79000 }, 100000) === 79,
);

// 3d. 999 cap (absurd window overflow can't render a 5-digit pct)
check(
	"3d 999 cap",
	contextPct({ ...zero, lastTotalTokens: 9_999_000 }, 100_000) === 999,
);

// 3e. real-window smoke: 240k of 250,100 ≈ 96%
check(
	"3e 240000/250100 → 96%",
	contextPct({ ...zero, lastTotalTokens: 240_000 }, DEFAULT_CONTEXT_WINDOW) === 96,
	contextPct({ ...zero, lastTotalTokens: 240_000 }, DEFAULT_CONTEXT_WINDOW),
);

// ---------------------------------------------------------------------------
// 4. overOutputBudget — unset → false; strict > boundary; output only
// ---------------------------------------------------------------------------

check("4a unset budget → false", overOutputBudget({ ...zero, output: 999_999 }) === false);
check("4b undefined → false", overOutputBudget({ ...zero, output: 999_999 }, undefined) === false);
check("4c invalid budget (NaN) → false", overOutputBudget({ ...zero, output: 999_999 }, NaN) === false);
check("4d non-positive budget (0) → false", overOutputBudget({ ...zero, output: 999_999 }, 0) === false);
check("4e non-positive budget (-5) → false", overOutputBudget({ ...zero, output: 999_999 }, -5) === false);
check("4f output == budget → false (strict >)", overOutputBudget({ ...zero, output: 1000 }, 1000) === false);
check("4g output > budget → true", overOutputBudget({ ...zero, output: 1001 }, 1000) === true);
check(
	"4h input/cache never trip the output budget",
	overOutputBudget({ ...zero, input: 999_999, cacheRead: 999_999, cacheWrite: 999_999 }, 1000) === false,
);

// ---------------------------------------------------------------------------
// 5. formatGaugeLine — exact shape
// ---------------------------------------------------------------------------

check(
	"5a exact 'ctx 34% ↑12k ↓3.4k' shape",
	formatGaugeLine({ ...zero, input: 12_000, output: 3_400, lastTotalTokens: 34_000 }, 100_000)
		=== "ctx 34% ↑12k ↓3.4k",
	formatGaugeLine({ ...zero, input: 12_000, output: 3_400, lastTotalTokens: 34_000 }, 100_000),
);
check(
	"5b null pct → 'ctx ?%'",
	formatGaugeLine({ ...zero, input: 12_000, output: 3_400, lastTotalTokens: null }, 100_000)
		=== "ctx ?% ↑12k ↓3.4k",
	formatGaugeLine({ ...zero, input: 12_000, output: 3_400, lastTotalTokens: null }, 100_000),
);
check(
	"5c sub-1k tokens render bare",
	formatGaugeLine({ ...zero, input: 999, output: 12, lastTotalTokens: 50_000 }, 100_000)
		=== "ctx 50% ↑999 ↓12",
	formatGaugeLine({ ...zero, input: 999, output: 12, lastTotalTokens: 50_000 }, 100_000),
);
check(
	"5d large values integer-k",
	formatGaugeLine({ ...zero, input: 250_000, output: 150_000, lastTotalTokens: 240_000 }, DEFAULT_CONTEXT_WINDOW)
		=== "ctx 96% ↑250k ↓150k",
	formatGaugeLine({ ...zero, input: 250_000, output: 150_000, lastTotalTokens: 240_000 }, DEFAULT_CONTEXT_WINDOW),
);

// ---------------------------------------------------------------------------
// 6. formatBudgetLine — heartbeat budget progress (v1.9b): "budget 45%
// ↓67.5k/150k"; unset/invalid budget → ""; 999% cap; output is the budgeted
// quantity (input/cache never appear).
// ---------------------------------------------------------------------------

check(
	"6a exact 'budget 45% ↓67.5k/150k' shape",
	formatBudgetLine({ ...zero, output: 67_500 }, 150_000) === "budget 45% ↓67.5k/150k",
	formatBudgetLine({ ...zero, output: 67_500 }, 150_000),
);
check("6b unset budget → empty", formatBudgetLine({ ...zero, output: 67_500 }, undefined) === "");
check(
	"6c invalid budgets → empty (0 / NaN / negative)",
	formatBudgetLine({ ...zero, output: 67_500 }, 0) === "" &&
		formatBudgetLine({ ...zero, output: 67_500 }, Number.NaN) === "" &&
		formatBudgetLine({ ...zero, output: 67_500 }, -5) === "",
);
check(
	"6d zero output → 0%",
	formatBudgetLine({ ...zero }, 150_000) === "budget 0% ↓0/150k",
	formatBudgetLine({ ...zero }, 150_000),
);
check(
	"6e over-budget clamps at 999% (and keeps the exact cap rendering)",
	formatBudgetLine({ ...zero, output: 500_000 }, 150_000) === "budget 333% ↓500k/150k",
	formatBudgetLine({ ...zero, output: 500_000 }, 150_000),
);
check(
	"6f input/cache never leak into the budget line",
	formatBudgetLine({ ...zero, input: 999_999, cacheRead: 999_999, cacheWrite: 999_999 }, 150_000)
		=== "budget 0% ↓0/150k",
	formatBudgetLine({ ...zero, input: 999_999, cacheRead: 999_999, cacheWrite: 999_999 }, 150_000),
);

// ---------------------------------------------------------------------------
// 7. resolveSpawnDefaults — worker tier config (v1.9.1), child-process with
// $HOME set at spawn time (bun caches os.homedir(), same seam as section 2).
// ---------------------------------------------------------------------------

function spawnDefaultsInHome(configJson: string): unknown {
	const home = mkdtempSync(join(tmpdir(), "usage-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveSpawnDefaults} from ${JSON.stringify(MOD)}; console.log(JSON.stringify(resolveSpawnDefaults()))`;
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	rmSync(home, { recursive: true, force: true });
	try {
		return JSON.parse(res.stdout.toString().trim());
	} catch {
		return `SPAWN FAILED: ${res.stderr.toString().slice(0, 200)}`;
	}
}

check(
	"7a no config → all undefined",
	JSON.stringify(spawnDefaultsInHome("")) === "{}",
	JSON.stringify(spawnDefaultsInHome("")),
);
check(
	"7b full defaults object → all three keys",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: "zai", model: "glm-5.3-flash", thinking: "medium" } })))
		=== JSON.stringify({ provider: "zai", model: "glm-5.3-flash", thinking: "medium" }),
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: "zai", model: "glm-5.3-flash", thinking: "medium" } }))),
);
check(
	"7c partial defaults → only present keys",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: "zai" } }))) === JSON.stringify({ provider: "zai" }),
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: "zai" } }))),
);
check(
	"7d non-string values filtered",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: 42, model: null, thinking: true } }))) === "{}",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { provider: 42, model: null, thinking: true } }))),
);
check(
	"7e corrupt config → {} (never throws)",
	JSON.stringify(spawnDefaultsInHome("not json{")) === "{}",
	JSON.stringify(spawnDefaultsInHome("not json{")),
);
check(
	"7f defaults not an object → {}",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: "zai" }))) === "{}",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: "zai" }))),
);
check(
	"7h defaults.tier surfaced for the tiers table",
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { tier: "flash" } }))) === JSON.stringify({ tier: "flash" }),
	JSON.stringify(spawnDefaultsInHome(JSON.stringify({ defaults: { tier: "flash" } }))),
);

// ---------------------------------------------------------------------------
// 8. resolveTierTable — multiple named worker tiers (v1.9.2), child-process
// with $HOME at spawn time (same seam as sections 2 and 7).
// ---------------------------------------------------------------------------

function tierTableInHome(configJson: string): unknown {
	const home = mkdtempSync(join(tmpdir(), "usage-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveTierTable} from ${JSON.stringify(MOD)}; console.log(JSON.stringify(resolveTierTable()))`;
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	rmSync(home, { recursive: true, force: true });
	try {
		return JSON.parse(res.stdout.toString().trim());
	} catch {
		return `SPAWN FAILED: ${res.stderr.toString().slice(0, 200)}`;
	}
}

check(
	"8a no config → no tiers",
	JSON.stringify(tierTableInHome("")) === "{}",
	JSON.stringify(tierTableInHome("")),
);
const multiTierCfg = JSON.stringify({
	tiers: {
		flash: { provider: "zai", model: "glm-5.3-flash", thinking: "high" },
		frontier: { provider: "zai", model: "glm-5.6", thinking: "high" },
	},
});
check(
	"8b multiple tiers round-trip verbatim",
	JSON.stringify(tierTableInHome(multiTierCfg)) === JSON.stringify(tierTableInHome(multiTierCfg)) &&
		(() => {
			const t = tierTableInHome(multiTierCfg) as Record<string, Record<string, string>>;
			return t.flash?.provider === "zai" && t.flash?.model === "glm-5.3-flash" && t.frontier?.model === "glm-5.6";
		})(),
	JSON.stringify(tierTableInHome(multiTierCfg)),
);
check(
	"8c partial tier entries kept, empty ones dropped",
	(() => {
		const t = tierTableInHome(
			JSON.stringify({ tiers: { cheap: { provider: "zai" }, broken: {}, alsoBad: { model: 42 } } }),
		) as Record<string, Record<string, string>>;
		return JSON.stringify(t) === JSON.stringify({ cheap: { provider: "zai" } });
	})(),
	JSON.stringify(tierTableInHome(JSON.stringify({ tiers: { cheap: { provider: "zai" }, broken: {} } }))),
);
check(
	"8d corrupt config → {} (never throws)",
	JSON.stringify(tierTableInHome("not json{")) === "{}",
	JSON.stringify(tierTableInHome("not json{")),
);
check(
	"8e tiers not an object → {}",
	JSON.stringify(tierTableInHome(JSON.stringify({ tiers: "flash" }))) === "{}",
	JSON.stringify(tierTableInHome(JSON.stringify({ tiers: "flash" }))),
);
check(
	"7g contextWindow key coexists (shared file)",
	(() => {
		const home = mkdtempSync(join(tmpdir(), "usage-check-home-"));
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "pi-delegate.config.json"),
			JSON.stringify({ contextWindow: 123456, defaults: { provider: "zai" } }),
		);
		const src =
			`import {resolveContextWindow, resolveSpawnDefaults} from ${JSON.stringify(MOD)}; ` +
			`console.log(JSON.stringify([resolveContextWindow(undefined), resolveSpawnDefaults()]))`;
		const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8" });
		rmSync(home, { recursive: true, force: true });
		return res.stdout.toString().trim() === JSON.stringify([123456, { provider: "zai" }]);
	})(),
);

// ---------------------------------------------------------------------------

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL GAUGE CHECKS PASSED");
