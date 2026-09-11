/**
 * pi-delegate — gauges (DESIGN.md §20).
 * <p>
 * MODULE_CONTRACT: gauge layer — the ONLY place that parses worker session
 * JSONL files and turns them into budget/context numbers (§20 dual gauge),
 * plus the tolerant config resolvers for spawn defaults and tier tables.
 * Stateless and read-only: every function is a pure projection of its
 * arguments (files are read, never written).
 * Dependencies: ./host.ts (the seam — SessionUsage/SpawnTier types +
 * CONTEXT_WINDOWS/DEFAULT_CONTEXT_WINDOW constants + BUDGET_CONFIG_PATH; the
 * E_* taxonomy lives there too), node:fs/os/path. No other src/ module
 * may parse session JSONL (one parser law).
 * Exported surface: contextPct, overContext, overOutputBudget,
 * parseSessionUsage, resolveContextWindow, resolvePiSessionCandidates,
 * formatGaugeLine, formatBudgetLine, formatTokens, resolveSpawnDefaults,
 * resolveTierTable, WATCH_DEFAULT_STALE_AFTER_MS.
 * Critical invariants (owned here):
 *   - dual-gauge semantics (§20, v1.7): PRIMARY ctx% is a STATE — the LAST
 *     assistant message's usage.totalTokens ÷ contextWindow (mirrors pi's
 *     ctx.getContextUsage(); never a sum across turns); SECONDARY out = Σ
 *     output ÷ budgetTokens (honest effort; cache never in a tripwire);
 *     TERTIARY turns = assistant-message count (loop/thrash detector).
 *   - tolerant-by-contract: missing file, unreadable/corrupt/partial JSONL
 *     lines, absent usage blocks → zeroed entry / defaults — NEVER throws to
 *     a caller (gauge failures must not affect spawn/collect/watch).
 *   - config precedence: pi-delegate.config.json overrides beat model-id
 *     matching (exact CONTEXT_WINDOWS key first, then substring, then
 *     DEFAULT_CONTEXT_WINDOW).
 *   - bun caches os.homedir(): tests must set $HOME at child-process spawn
 *     time (not process.env mid-run) — the resolver reads homedir() once.
 * Error modes: none thrown to callers — every read degrades (zeroed usage,
 * default window/defaults); the E_* error taxonomy lives in transport.ts.
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A8 (impl-gauges). Worker B8 imports, never edits this file.
 *
 * v1.7 semantics — dual gauge, both from the worker's session JSONL:
 *   PRIMARY   ctx%  = last assistant usage.totalTokens ÷ contextWindow
 *                     (mirrors pi's ctx.getContextUsage(); a STATE, not a sum)
 *   SECONDARY out   = Σ output across assistant messages ÷ budgetTokens
 *                     (the honest effort measure; cache never in a tripwire)
 *   TERTIARY  turns = assistant-message count (loop/thrash detector)
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUsage, SpawnTier } from "./host.ts";

/** Canonical worker-stale default (§22): a collected worker still mounted
 *  after this long wakes its owner ("tear it down or keep"), and the fleet
 *  overlay's `s` flag marks the row stale after the SAME threshold.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none
 * Output: 30 minutes in ms — the ONE staleness threshold
 * Guarantees:
 *   - lives in THIS module (a layer both observe.ts and fleet.ts already
 *     import) so watcher and fleet read one value with no import cycle:
 *     observe.ts re-exports it (WATCH_DEFAULT_STALE_AFTER_MS), fleet.ts
 *     aliases it (FLEET_STALE_AFTER_MS). Before the migration the literal
 *     was duplicated by hand in both files (fleet.ts could not import
 *     observe.ts — observe imports fleet's render helpers).
 * Raises: never */
export const WATCH_DEFAULT_STALE_AFTER_MS = 30 * 60_000;
import {
	CONTEXT_WINDOWS,
	DEFAULT_CONTEXT_WINDOW,
} from "./host.ts";



/**
 * PRIMARY gauge: context % of window, from usage.lastTotalTokens.
 * Returns null when lastTotalTokens is null (pi: unknown right after
 * compaction) — display `ctx ?%`, never trip.
 */
export function contextPct(usage: SessionUsage, contextWindow: number): number | null {
	if (usage.lastTotalTokens === null || contextWindow <= 0) return null;
	return Math.min(999, Math.round((usage.lastTotalTokens / contextWindow) * 100));
}

/** True when context % has reached the refusal line (≥ maxPct). */
export function overContext(usage: SessionUsage, contextWindow: number, maxPct: number): boolean {
	const pct = contextPct(usage, contextWindow);
	return pct !== null && pct >= maxPct;
}

/**
 * SECONDARY gauge: output tokens vs budget. budgetTokens unset (undefined/
 * non-positive) → no cap, always false. Strictly greater-than.
 */
export function overOutputBudget(usage: SessionUsage, budgetTokens?: number): boolean {
	if (budgetTokens === undefined || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
		return false;
	}
	return usage.output > budgetTokens;
}

/**
 * Parse per-session usage from a session JSONL file.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - sessionPath: absolute path to a pi session JSONL file (may not exist)
 * Output: SessionUsage — summed input/output/cacheRead/cacheWrite across
 *   assistant messages, turns = assistant-message count, lastTotalTokens =
 *   usage.totalTokens of the LAST assistant message (pi's getContextUsage()
 *   basis; null when no assistant message carries it — empty session /
 *   post-compaction edge)
 * Guarantees:
 *   - tolerant: missing file, unreadable lines, absent usage blocks → zeroed
 *     entry; NEVER throws
 *   - pure read: the file is opened read-only, nothing is written
 * Raises: none (all failures are swallowed into the zeroed entry)
 */

export function parseSessionUsage(sessionPath: string): SessionUsage {
	const usage: SessionUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
		lastTotalTokens: null,
	};
	let raw: string;
	try {
		// EXTERNAL_DEPENDENCY: worker session JSONL on disk (pi writes it at
		// ~/.pi/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl); the path comes
		// from the spawn manifest (`sessionPath`), not from env.
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return usage; // missing/unreadable → zeroed, never throw
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e: {
			message?: { role?: unknown; usage?: Record<string, unknown> };
		};
		try {
			e = JSON.parse(line);
		} catch {
			continue; // corrupt/partial line — skip
		}
		const m = e.message;
		if (!m || m.role !== "assistant") continue;
		usage.turns += 1;
		const u = m.usage;
		if (!u || typeof u !== "object") continue;
		usage.input += num(u.input);
		usage.output += num(u.output);
		usage.cacheRead += num(u.cacheRead);
		usage.cacheWrite += num(u.cacheWrite);
		const tt = num(u.totalTokens);
		if (tt > 0) usage.lastTotalTokens = tt; // last assistant totalTokens wins
	}
	return usage;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Context window for a model id: exact match in CONTEXT_WINDOWS first,
 * then a model whose id CONTAINS a key (e.g. "tensorzero::…:glm-5.3-flash"),
 * else DEFAULT_CONTEXT_WINDOW. Config override
 * (pi-delegate.config.json {"contextWindow": N}) wins over everything
 * when present and a positive finite number. Never throws.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - modelId: provider-qualified model id (optional; undefined → default)
 * Output: context-window size in tokens (positive integer)
 * Guarantees:
 *   - precedence: config override > exact id match > contains-match > default
 *   - never throws (unreadable/corrupt config falls through to the table)
 * Raises: none
 */
export function resolveContextWindow(modelId?: string): number {
	// 1. config override (pi-delegate.config.json {"contextWindow": N})
	try {
		const raw = readFileSync(BUDGET_CONFIG_PATH, "utf8");
		const cfg = JSON.parse(raw) as { contextWindow?: unknown };
		if (typeof cfg.contextWindow === "number" && Number.isFinite(cfg.contextWindow) && cfg.contextWindow > 0) {
			return cfg.contextWindow;
		}
	} catch {
		/* no config → fall through */
	}
	if (!modelId) return DEFAULT_CONTEXT_WINDOW;
	// 2. exact id match
	if (CONTEXT_WINDOWS[modelId] !== undefined) return CONTEXT_WINDOWS[modelId];
	// 3. contains-match (e.g. "tensorzero::…:glm-5.3-flash")
	for (const [key, value] of Object.entries(CONTEXT_WINDOWS)) {
		if (modelId.includes(key)) return value;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

/**
 * v1.9 (DESIGN.md §19.1c): resolve candidate pi session JSONL paths for a
 * worker that was spawned at startedAtMs with working directory workerCwd.
 *
 * pi stores sessions at
 *   ~/.pi/agent/sessions/<munged-cwd>/<createdISO>_<uuid>.jsonl
 * (munge: leading "/" stripped, "/" → "-", other chars preserved, wrapped in
 * "--…--"; e.g. /home/x/pro → --home-x-pro--). herdr builds without
 * agent_session in their agent get/start results leave the transport's
 * sessionPath undefined — this filesystem fallback restores the session-reply
 * proof, the gauges and probe salvage.
 *
 * Candidates: creation timestamp within [startedAt - 5s, startedAt + windowMs]
 * (the orchestrator's own older session is excluded by the window), sorted
 * closest-to-startedAt first. Parallel same-cwd fan-outs can share a window —
 * callers must treat the list as best-effort attribution (the report file
 * proof is the exact completion criterion). Tolerant: missing/unreadable dir,
 * unparseable names → [] (never throws).
 */
export function resolvePiSessionCandidates(
	workerCwd: string,
	startedAtMs: number,
	opts?: { sessionsRoot?: string; windowMs?: number },
): string[] {
	const sessionsRoot = opts?.sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
	const windowMs = opts?.windowMs ?? 10 * 60_000;
	const munged = workerCwd.replace(/^\//, "").replace(/\//g, "-");
	let entries: string[];
	try {
		// EXTERNAL_DEPENDENCY: pi's on-disk session store at
		// $HOME/.pi/agent/sessions/--<munged-cwd>--/ (munge rule documented
		// above); readdir is the fallback's sole source of candidates.
		entries = readdirSync(join(sessionsRoot, `--${munged}--`));
	} catch {
		return [];
	}
	const candidates: Array<{ path: string; delta: number }> = [];
	for (const name of entries) {
		// <YYYY-MM-DD>T<HH-MM-SS-mmm>Z_<uuid>.jsonl — pi's session file names.
		const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_.+\.jsonl$/.exec(name);
		if (!m) continue;
		const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
		if (!Number.isFinite(ts)) continue;
		const delta = ts - startedAtMs;
		if (delta < -5_000 || delta > windowMs) continue;
		candidates.push({ path: join(sessionsRoot, `--${munged}--`, name), delta });
	}
	return candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).map((c) => c.path);
}

/**
 * Human gauge line for terminal results / UI rows, e.g.
 * "ctx 34% ↑12.0k ↓3.4k" — ctx segment reads "ctx ?%" when unknown.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: usage (parsed session usage), contextWindow (resolved window size)
 * Output: one-line gauge string; pure formatting, no I/O
 * Guarantees: unknown context (null pct) renders as "ctx ?%", never a number
 * Raises: none
 */
export function formatGaugeLine(usage: SessionUsage, contextWindow: number): string {
	const pct = contextPct(usage, contextWindow);
	return `ctx ${pct === null ? "?%" : pct + "%"} ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
}

/**
 * Human budget-progress line for the settle heartbeat (v1.9b), e.g.
 * "budget 45% ↓67.5k/150k". Output tokens are the budgeted quantity
 * (DESIGN.md §14/§20). Empty when no cap is set (nothing to progress
 * against) — callers resolve the §14 default themselves for display.
 */
export function formatBudgetLine(usage: SessionUsage, budgetTokens?: number): string {
	if (budgetTokens === undefined || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return "";
	const pct = Math.min(999, Math.round((usage.output / budgetTokens) * 100));
	return `budget ${pct}% ↓${formatTokens(usage.output)}/${formatTokens(budgetTokens)}`;
}

/**
 * Worker spawn defaults (v1.9.1, tier key added v1.9.2): optional
 * `{"defaults": {"tier", "provider", "model", "thinking"}}` from
 * ~/.pi/agent/pi-delegate.config.json — the same file as the contextWindow
 * override (resolveContextWindow). Precedence in delegate: explicit tool
 * param → tiers[defaults.tier] → these per-key defaults. There is NO built-in
 * tier — an unconfigured environment fails with E_TIER. Tolerant:
 * missing/corrupt/partial config → {} (never throws). NOTE: bun caches
 * os.homedir() — tests must spawn a child process with $HOME set at spawn
 * time (same as section 2).
 */
export function resolveSpawnDefaults(): {
	provider?: string;
	model?: string;
	thinking?: string;
	tier?: string;
} {
	try {
		const raw = readFileSync(BUDGET_CONFIG_PATH, "utf8");
		const cfg = JSON.parse(raw) as { defaults?: Record<string, unknown> };
		const d = cfg.defaults;
		const str = (v: unknown): string | undefined =>
			typeof v === "string" && v.trim().length > 0 ? v : undefined;
		return d !== null && typeof d === "object"
			? {
					provider: str(d.provider),
					model: str(d.model),
					thinking: str(d.thinking),
					tier: str(d.tier),
				}
			: {};
	} catch {
		return {}; // no config / corrupt config → built-in defaults, never throw
	}
}

/**
 * Named worker tiers (v1.9.2): the `"tiers"` table from
 * ~/.pi/agent/pi-delegate.config.json — multiple provider/model/thinking
 * combinations the operator maintains in one place. Entries with no valid
 * field are dropped; corrupt config → {} (never throws). Same $HOME caching
 * caveat as resolveSpawnDefaults.
 */
export function resolveTierTable(): Record<string, SpawnTier> {
	try {
		const raw = readFileSync(BUDGET_CONFIG_PATH, "utf8");
		const cfg = JSON.parse(raw) as { tiers?: unknown };
		if (cfg.tiers === null || typeof cfg.tiers !== "object") return {};
		const str = (v: unknown): string | undefined =>
			typeof v === "string" && v.trim().length > 0 ? v : undefined;
		const out: Record<string, SpawnTier> = {};
		for (const [name, entry] of Object.entries(cfg.tiers as Record<string, unknown>)) {
			if (name.trim().length === 0 || entry === null || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			const tier: SpawnTier = {
				provider: str(e.provider),
				model: str(e.model),
				thinking: str(e.thinking),
			};
			if (tier.provider !== undefined || tier.model !== undefined || tier.thinking !== undefined) {
				out[name] = tier;
			}
		}
		return out;
	} catch {
		return {}; // no config / corrupt config → no tiers, never throw
	}
}

/**
 * k-scaled token count (1-decimal under 100, integer above), e.g. 950 →
 * "950", 3400 → "3.4k", 120000 → "120k". Exported for F1 fleet-usage
 * lines (observe.ts) so every token count in the UI shares one formatter.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: n — a token count (any number; negative/NaN renders via String)
 * Output: human token string; pure formatting, no I/O
 * Raises: none
 */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
