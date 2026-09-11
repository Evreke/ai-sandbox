/**
 * pi-delegate — src/watch-config.ts (Wave 3a: extracted from src/observe.ts).
 *
 * MODULE_CONTRACT — the watch/collect CONFIG resolution.
 *
 * Purpose: everything read from ~/.pi/agent/pi-delegate.config.json's
 * "watch" and "collect" sections — the tuning constants (WATCH_* defaults
 * + floors, RETIRE_* defaults, COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT,
 * DURABLE_DELIVERY_DEFAULT_ENABLED, the detection tuning constants
 * WATCH_LOOKBACK_MS / WATCH_DEAD_GRACE_MS), the WatchConfig/CollectConfig
 * shapes, the shared tolerant config reader (readDelegateConfig) and the
 * resolvers (resolveWatchConfig, resolveCollectConfig) with their four
 * warn-once bad-value flags.
 *
 * This extraction KILLS the spawn→observe dependency edge (the last
 * layering violation): src/spawn.ts imported resolveWatchConfig/
 * resolveCollectConfig from observe.ts; both sides now import THIS module.
 * A static pin in test/static-check.ts enforces that no src/ module imports
 * observe.ts except compose.ts and index.ts (ARCHITECTURE.md Law 6 —
 * layering enforced by machine).
 *
 * Dependencies: node builtins, ./host.ts (BUDGET_CONFIG_PATH — the ONE
 * config path constant), ./usage.ts (WATCH_DEFAULT_STALE_AFTER_MS — the
 * stale threshold is canonically owned there; re-exported so the
 * watch-config API surface and its tests keep resolving it).
 *
 * EXTERNAL_DEPENDENCY: the config file at BUDGET_CONFIG_PATH (pi's
 * getAgentDir(), honors PI_CODING_AGENT_DIR). NOTE: bun caches os.homedir()
 * — tests must set $HOME at child-process spawn time (the caveat documented
 * in usage.ts).
 *
 * Guarantees: every resolver is total — missing/corrupt/partial config →
 * defaults, never throws; a PRESENT-but-bad value warns ONCE per process
 * and still uses the default (a silent fallback would leave a
 * misconfigured operator wondering).
 *
 * All bodies are byte-verbatim moves from src/observe.ts (Wave 3a).
 */

import { readFileSync } from "node:fs";
import { BUDGET_CONFIG_PATH } from "./host.ts";
import { WATCH_DEFAULT_STALE_AFTER_MS } from "./usage.ts";

// ---------------------------------------------------------------------------
// Config — {"watch": {"intervalMs": 10000, "settleGateMs": 15000}} from
// ~/.pi/agent/pi-delegate.config.json. Same tolerant style as
// resolveSpawnDefaults(): missing/corrupt/partial → defaults, never throws.
// NOTE: bun caches os.homedir() — tests must set $HOME at child-process spawn
// time (the caveat documented in usage.ts).
// ---------------------------------------------------------------------------

export const WATCH_DEFAULT_INTERVAL_MS = 10_000;
/** §20.1's 120 s blocking window shrinks to this (explicit waitMs still wins). */
export const WATCH_DEFAULT_SETTLE_GATE_MS = 15_000;
/** Floor for intervalMs — a typo like 1 must not hammer herdr every ms. */
export const WATCH_MIN_INTERVAL_MS = 1_000;
/** worker-stale threshold (§22): a collected worker still mounted after this
 *  long wakes its owner ("tear it down or keep"). The overlay's `s` flag
 *  shares the same 30-min default — ONE constant, canonically owned by
 *  src/usage.ts (the layer both this module and fleet.ts import; see the
 *  FUNCTION_CONTRACT there). Re-exported so the watch-config API surface
 *  (and its tests) keep resolving it from observe.ts. */
export { WATCH_DEFAULT_STALE_AFTER_MS } from "./usage.ts";
/** Floor for staleAfterMs — same rationale as the interval floor. */
export const WATCH_MIN_STALE_AFTER_MS = 60_000;
/** §23 retire: how long a RETIRABLE worker (valid report + drained mailbox +
 *  done/idle) may keep its pane before the watcher closes it on its own —
 *  the TTL half of the close rule (the ACK half is the release marker).
 *  0 is legal (close on the first retirable tick). Inactive unless the
 *  master switch watch.retire is explicitly true — auto-teardown is OPT-IN. */
export const RETIRE_DEFAULT_TTL_MS = 900_000;
/** §23 master switch default: FALSE — the watcher never closes panes unless
 *  the operator opted in via watch.retire:true (user decision, mandatory). */
export const RETIRE_DEFAULT_ENABLED = false;

/** Watcher stage B master default: TRUE — committing the durable delivered
 *  facts is the safe value (it only ever SUPPRESSES a repeated wake-up; the
 *  memory-only rollback is the emergency exit, not the default). */
export const DURABLE_DELIVERY_DEFAULT_ENABLED = true;

export interface WatchConfig {
	intervalMs: number;
	settleGateMs: number;
	/** worker-stale threshold (default 30 min, floor 60 s). */
	staleAfterMs: number;
	/** v1.14: when to release a blocking delegate call. "settle" (default)
	 *  blocks the full settle gate unless the worker settles inline; "started"
	 *  releases as soon as the worker is proven started and working — the
	 *  background watcher owns the rest of the wait (§21). */
	releaseOn: "started" | "settle";
	/** §23 retire TTL (default 15 min): elapsed-since-retirable threshold for
	 *  the watcher's autonomous pane close. Inactive unless retire is true. */
	retireTtlMs: number;
	/** §23 master switch (default FALSE): when false, the retire pass is a
	 *  no-op — panes NEVER close, no retirableSince is ever stamped. */
	retire: boolean;
	/** Watcher stage A rollback for the missing-owner edge ONLY (default
	 *  FALSE): legacy manifests that carry no owner field anywhere (no
	 *  worker-level orchestratorSessionPath, no manifest-level
	 *  masterSessionPath) deliver NOTHING unless the operator explicitly sets
	 *  this true — which is UNSAFE on a machine with several sessions
	 *  (bystander wakes return). This flag NEVER touches the missing self-id
	 *  edge: a session whose identity is unreadable delivers nothing with or
	 *  without the flag (guideline §3.6 — no configuration escape). */
	legacyFailOpen: boolean;
	/** Watcher stage B (guideline §5, default TRUE): commit delivered-facts
	 *  records to the durable per-task store after a successful send, so the
	 *  dedup survives a session restart. false is the emergency rollback to
	 *  the pre-stage-B memory-only dedup (repeated wake-ups after a restart
	 *  return) without shipping a new version. */
	durableDelivery: boolean;
}

/** Shared tolerant config read (v1.12.1): null when absent/corrupt/not an
 *  object — resolvers decide per-key defaults, never throw.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: the parsed config object, or null
 * Guarantees:
 *   - tolerant: missing/corrupt/non-object config → null, never throws
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — ~/.pi/agent/pi-delegate.config.json
 *   (via pi's getAgentDir(), which honors PI_CODING_AGENT_DIR; the single
 *   config file for watch + collect + spawn defaults across the extension).
 */
function readDelegateConfig(): Record<string, unknown> | null {
	try {
		const raw = readFileSync(BUDGET_CONFIG_PATH, "utf8");
		const cfg = JSON.parse(raw) as unknown;
		return cfg !== null && typeof cfg === "object" ? (cfg as Record<string, unknown>) : null;
	} catch {
		return null; // no config / corrupt config → callers use defaults
	}
}

/** Resolves the watcher's tuning from the delegate config file's "watch"
 *  key.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: resolved WatchConfig (intervalMs, settleGateMs, staleAfterMs, releaseOn)
 * Guarantees:
 *   - per-key defaults with floors (intervalMs ≥ 1 s, staleAfterMs ≥ 60 s);
 *     garbage/missing keys never throw, they fall back
 * Raises: never
 * EXTERNAL_DEPENDENCY: the config file via readDelegateConfig (above).
 */
export function resolveWatchConfig(): WatchConfig {
	const fallback: WatchConfig = {
		intervalMs: WATCH_DEFAULT_INTERVAL_MS,
		settleGateMs: WATCH_DEFAULT_SETTLE_GATE_MS,
		staleAfterMs: WATCH_DEFAULT_STALE_AFTER_MS,
		releaseOn: "settle",
		retireTtlMs: RETIRE_DEFAULT_TTL_MS,
		retire: RETIRE_DEFAULT_ENABLED,
		legacyFailOpen: false,
		durableDelivery: DURABLE_DELIVERY_DEFAULT_ENABLED,
	};
	try {
		const e = readDelegateConfig()?.watch;
		if (e === null || typeof e !== "object") return fallback;
		const w = e as Record<string, unknown>;
		const num = (v: unknown, dflt: number, min: number): number =>
			typeof v === "number" && Number.isFinite(v) && v >= min ? v : dflt;
		// §23: absent key → default; a PRESENT-but-bad value warns ONCE (a silent
		// fallback would leave a misconfigured operator wondering why panes never
		// retire — or retire too fast) and still uses the default.
		let retireTtlMs = fallback.retireTtlMs;
		if (w.retireTtlMs !== undefined) {
			if (typeof w.retireTtlMs === "number" && Number.isFinite(w.retireTtlMs) && w.retireTtlMs >= 0) {
				retireTtlMs = w.retireTtlMs;
			} else {
				warnBadRetireTtl(w.retireTtlMs);
			}
		}
		// §23 master switch: absent → false (OPT-IN); a present non-boolean warns
		// once and stays false — a typo must never silently ENABLE auto-teardown.
		let retire = fallback.retire;
		if (w.retire !== undefined) {
			if (typeof w.retire === "boolean") {
				retire = w.retire;
			} else {
				warnBadRetireSwitch(w.retire);
			}
		}
		// Watcher stage A: absent key → false (fail-closed default); a present
		// boolean is used as-is; a present non-boolean warns ONCE and stays
		// false — a typo must never silently ENABLE the unsafe legacy delivery.
		let legacyFailOpen = fallback.legacyFailOpen;
		if (w.legacyFailOpen !== undefined) {
			if (typeof w.legacyFailOpen === "boolean") {
				legacyFailOpen = w.legacyFailOpen;
			} else {
				warnBadLegacyFailOpen(w.legacyFailOpen);
			}
		}
		// Watcher stage B: absent key → true (the safe value); a present boolean
		// is used as-is; a present non-boolean warns ONCE and stays true — a
		// typo must never silently switch OFF the durable dedup (that would
		// silently reintroduce repeated wake-ups after every restart).
		let durableDelivery = fallback.durableDelivery;
		if (w.durableDelivery !== undefined) {
			if (typeof w.durableDelivery === "boolean") {
				durableDelivery = w.durableDelivery;
			} else {
				warnBadDurableDelivery(w.durableDelivery);
			}
		}
		return {
			intervalMs: num(w.intervalMs, fallback.intervalMs, WATCH_MIN_INTERVAL_MS),
			settleGateMs: num(w.settleGateMs, fallback.settleGateMs, 1),
			staleAfterMs: num(w.staleAfterMs, fallback.staleAfterMs, WATCH_MIN_STALE_AFTER_MS),
			releaseOn: w.releaseOn === "started" ? "started" : "settle",
			retireTtlMs,
			retire,
			legacyFailOpen,
			durableDelivery,
		};
	} catch {
		return fallback; // defensive — readDelegateConfig already absorbs throws
	}
}

/** Warn-once flag for a bad watch.retireTtlMs (§23) — once per process. */
let retireTtlWarned = false;
function warnBadRetireTtl(v: unknown): void {
	if (retireTtlWarned) return;
	retireTtlWarned = true;
	console.error(
		`[pi-delegate watch] bad watch.retireTtlMs (${JSON.stringify(v) ?? "undefined"}) — ` +
			`using the default ${RETIRE_DEFAULT_TTL_MS} ms`,
	);
}

/** Warn-once flag for a bad watch.retire master switch (§23) — once per process. */
let retireSwitchWarned = false;
function warnBadRetireSwitch(v: unknown): void {
	if (retireSwitchWarned) return;
	retireSwitchWarned = true;
	console.error(
		`[pi-delegate watch] bad watch.retire (${JSON.stringify(v) ?? "undefined"}) — ` +
			"auto-teardown stays DISABLED (default false)",
	);
}

/** Warn-once flag for a bad watch.legacyFailOpen (watcher stage A) — once per process. */
let legacyFailOpenWarned = false;
function warnBadLegacyFailOpen(v: unknown): void {
	if (legacyFailOpenWarned) return;
	legacyFailOpenWarned = true;
	console.error(
		`[pi-delegate watch] bad watch.legacyFailOpen (${JSON.stringify(v) ?? "undefined"}) — ` +
			"legacy no-owner delivery stays DISABLED (default false; true is unsafe on multi-session)",
	);
}

/** Warn-once flag for a bad watch.durableDelivery (watcher stage B) — once per process. */
let durableDeliveryWarned = false;
function warnBadDurableDelivery(v: unknown): void {
	if (durableDeliveryWarned) return;
	durableDeliveryWarned = true;
	console.error(
		`[pi-delegate watch] bad watch.durableDelivery (${JSON.stringify(v) ?? "undefined"}) — ` +
			"durable delivery stays ENABLED (default true; false reverts to memory-only dedup)",
	);
}

// ---------------------------------------------------------------------------
// Collect-stage config (§22, v1.12.1): {"collect": {"teardownAfterCollect":
// true}} — teardown-after-collect is USER-LOCKED default ON. Same tolerant
// style as resolveWatchConfig: missing/corrupt/partial → defaults, never
// throws. Lives beside the watch config because it is the same file, the same
// resolution discipline, and the same child-process test seam.
// ---------------------------------------------------------------------------

export const COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT = true;

export interface CollectConfig {
	teardownAfterCollect: boolean;
}


/**
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: CollectConfig — teardownAfterCollect (user-locked default ON)
 * Guarantees:
 *   - only an explicit boolean moves off the default; garbage → default
 * Raises: never
 * EXTERNAL_DEPENDENCY: the config file via readDelegateConfig (above).
 */
export function resolveCollectConfig(): CollectConfig {
	const fallback: CollectConfig = { teardownAfterCollect: COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT };
	try {
		const e = readDelegateConfig()?.collect;
		if (e === null || typeof e !== "object") return fallback;
		const c = e as Record<string, unknown>;
		// Only an explicit boolean moves off the user-locked default; garbage → default.
		return {
			teardownAfterCollect:
				typeof c.teardownAfterCollect === "boolean"
					? c.teardownAfterCollect
					: fallback.teardownAfterCollect,
		};
	} catch {
		return fallback; // defensive — readDelegateConfig already absorbs throws
	}
}

/** Noise guard: workers older than this are history, not a fleet — manifests
 *  outlive sessions, and a fresh orchestrator must not be woken for last
 *  week's teardown. */
export const WATCH_LOOKBACK_MS = 24 * 60 * 60_000;
/** A worker placed seconds ago is not dead: herdr may not have registered it
 *  yet (and startAgent itself takes time). */
export const WATCH_DEAD_GRACE_MS = 60_000;
