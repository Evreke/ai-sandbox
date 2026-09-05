/**
 * pi-delegate — gauges (DESIGN.md §20).
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUsage } from "./transport/types.ts";
import {
	CONTEXT_WINDOWS,
	DEFAULT_CONTEXT_WINDOW,
} from "./transport/types.ts";

/**
 * Parse per-session usage from a session JSONL file.
 * - Sums input/output/cacheRead/cacheWrite across assistant messages.
 * - turns = assistant-message count.
 * - lastTotalTokens = usage.totalTokens of the LAST assistant message
 *   (pi's getContextUsage() basis); null when no assistant message carries it
 *   (empty session / post-compaction edge).
 * Tolerant: missing file, unreadable lines, absent usage blocks → zeroed
 * entry (never throws).
 */


/**
 * Context window for a model id: exact match in CONTEXT_WINDOWS first,
 * then a model whose id CONTAINS a key (e.g. "tensorzero::…:glm-5.3-flash"),
 * else DEFAULT_CONTEXT_WINDOW. Config override
 * (pi-delegate.config.json {"contextWindow": N}) wins over everything
 * when present and a positive finite number. Never throws.
 */


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
 * Human gauge line for terminal results / UI rows, e.g.
 * "ctx 34% ↑12.0k ↓3.4k" — ctx segment reads "ctx ?%" when unknown.
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

export function resolveContextWindow(modelId?: string): number {
	// 1. config override (pi-delegate.config.json {"contextWindow": N})
	try {
		const raw = readFileSync(join(homedir(), ".pi", "agent", "pi-delegate.config.json"), "utf8");
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

export function formatGaugeLine(usage: SessionUsage, contextWindow: number): string {
	const pct = contextPct(usage, contextWindow);
	return `ctx ${pct === null ? "?%" : pct + "%"} ↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}`;
}

/** k-scaled token count (1-decimal under 100, integer above). */
function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
