/**
 * pi-delegate — observe module: everything the extension KNOWS about workers
 * (DESIGN.md §21 background watcher, §22 staleness, §23 retire) plus the
 * watch/collect config resolution that feeds it and the teardown commands
 * that drive it.
 * <p>
 * MODULE_CONTRACT: observation layer — the `delegate_status` tool (read-only
 * by contract), the event-driven background watcher (wake-up delivery, §23
 * retire engine, manifest clock stamping), the tolerant watch/collect config
 * resolution, and the /delegate-fleet + /delegate-teardown commands
 * (registerCommands, moved verbatim from index.ts in W6 — this module owns
 * the watcher/teardown state they drive). W2 refactor: verbatim
 * concatenation of the old src/state.ts, src/tools/status.ts and src/watch.ts.
 * W6: the worker-view aggregation (WorkerView + buildWorkerView) moved out
 * to fleet.ts — it is view-building and now lives with the other view code
 * (this broke the fleet<->observe import cycle; observe → fleet is one-way).
 * Dependencies: exchange.ts (manifest + report + mailbox protocol), usage.ts
 * (session JSONL usage), archive exports of exchange.ts (resume hint),
 * fleet.ts (status-tool render helpers + buildWorkerView + fleet-UI
 * mount/overlay), transport.ts (Transport seam + gauge constants), typebox.
 * Never imports the transport implementation
 * (dependency rule, DESIGN.md §4.1 — the Transport instance is injected from
 * index.ts).
 * Exported surface: registerStatusTool |
 * WATCH_DEFAULT_INTERVAL_MS, WATCH_DEFAULT_SETTLE_GATE_MS,
 * WATCH_MIN_INTERVAL_MS, WATCH_DEFAULT_STALE_AFTER_MS,
 * WATCH_MIN_STALE_AFTER_MS, RETIRE_DEFAULT_TTL_MS, RETIRE_DEFAULT_ENABLED,
 * WatchConfig, resolveWatchConfig, COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT,
 * CollectConfig, resolveCollectConfig, WatchEventKind, WatchEvent, eventKey,
 * WatchWorker, WatchSnapshot, WATCH_LOOKBACK_MS, WATCH_DEAD_GRACE_MS,
 * SESSION_TAIL_BYTES, GRILL_DECK_TOOL, SelfIdentity, isWorkerSession,
 * ownsChildManifests, workersFromManifests, readStatusesTolerant, collectSnapshot, DetectOptions,
 * detectWorkerEvents, detectEvents, RetireReason, RetireDecision, RetireEval,
 * mailboxDrained, evaluateRetire, RetirePassOptions, retirePass,
 * formatEventBatch, WatcherDeps, WatcherHandle, createWatcher, stopWatcher,
 * makeSender, startWatcher, registerCommands, formatFleetUsageLine (F1).
 * Critical invariants (owned here, per report-ref-map.json hiddenInvariants):
 *   - collectedAt-dedup (reader side): report-ready/report-invalid are SILENT
 *     once the manifest records collectedAt — the watcher `seen` dedup is
 *     session memory only, so a fresh session would re-wake on old reports
 *     without the stamp. Observe only READS the stamp; collect (spawn flow,
 *     W4) writes it.
 *   - mismatch-fired-marker (D3, the ONE deliberate watcher write): the tick
 *     persists mismatch-fired-<name>.json after a SUCCESSFUL report-mismatch
 *     delivery, keyed by startedAtMs — a watcher session restart must not
 *     re-fire the wake for the same worker run (in-memory `seen` dies with
 *     the session). A new same-name spawn (new startedAt) re-arms the event.
 *   - answer-consumed-mtime: no worker-side ack for mailbox answers exists;
 *     an answer counts as consumed iff the worker's report mtime postdates
 *     the a-<name>.json file (mailboxDrained) — otherwise the mailbox is not
 *     drained and the worker is never retirable.
 *   - retire-ack-consume: release-<name>.json is CONSUMED (deleted) on
 *     successful retire, else a leftover ACK would instantly close a fresh
 *     same-name retry on its first retirable tick; retirableSince/retiredAt
 *     persist in the manifest, never in memory only.
 *   - F1 fleet usage (delegate_status): the aggregate line comes from
 *     aggregateTaskUsage WITHOUT persist — delegate_status stays read-only
 *     by contract; the usage snapshot cache is written only by writers
 *     (collect, via persistTaskUsageSnapshot). Missing/corrupt session
 *     files degrade to a partial marker on the line, never an error.
 *   - watcher advisory-by-contract: a watcher failure must NEVER affect a
 *     spawn or a collect — every read tolerant, every delivery guarded, and
 *     a failed send rolls the batch's keys back out of `seen` so events
 *     re-fire. One batch = one wake-up message (§21) — never one message
 *     per event.
 * External runtime dependencies (ZCS, ported from the bundle's watcher
 * contract): ~/.pi/agent/pi-delegate.config.json (watch/collect config —
 * readDelegateConfig); the worker session JSONL files on disk (gauges +
 * tool-call scan); herdr reachability through the INJECTED Transport (this
 * module never imports the herdr implementation); pi.sendUserMessage for
 * delivery (guarded — absent → inert).
 *   (settle-before-start-race-d3, aged-finish-blind-spot,
 *   fresh-session-assumption and abort-detaches-never-kills do NOT land
 *   here — their true owners are the transport waitSettle contract (W3) and
 *   the spawn flow (W4).)
 * Error modes: none thrown to callers — observation degrades (unknown
 * statuses, empty event batches, logged-and-retried retire stamps); the E_*
 * error taxonomy lives in transport.ts.
 */

import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "typebox";
import {
	aggregateTaskUsage,
	archiveReport,
	archiveRoot,
	listArchivedTasks,
	readManifest,
	type TaskUsageSnapshot,
} from "./exchange.ts";
import {
	answerPathFor,
	mismatchFiredPathFor,
	nudgeFailedPathFor,
	parseBriefSchema,
	progressPathFor,
	questionPathFor,
	readLastProgress,
	readMismatchFiredMarker,
	readNudgeFailedMarker,
	readQuestion,
	releasePathFor,
	scanAllManifests,
	scanReportCandidates,
	updateManifest,
	validateReport,
	validateReportAgainstSchema,
	writeMismatchFiredMarker,
	type ExchangeManifest,
} from "./exchange.ts";
import {
	buildWorkerView,
	clampLines,
	disposeFleetUI,
	fmtK,
	openFleetOverlay,
	renderDelegateLines,
	type WorkerView,
} from "./fleet.ts";
import { contextPct, formatTokens, parseSessionUsage, resolveContextWindow } from "./usage.ts";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_TURNS_WARN,
	type AgentStatus,
	type AgentStatusName,
	type DelegateError,
	type Placement,
	type Transport,
} from "./host.ts";

// ===========================================================================
// SECTION 1/3 — `delegate_status` tool
// (verbatim move of the old src/tools/status.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `delegate_status` tool (DESIGN.md §5.2).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * READ-ONLY by contract: observes workers from manifests + live herdr statuses.
 * Contains no mutating calls (verified in review — DESIGN.md §8).
 */

/** Budget governor display data (DESIGN.md §14), read-only: name → session
 *  JSONL path and recorded effective budget from every manifest, plus the
 *  resolved default budget for workers without a recorded one. */
function usageSource(): {
	sessionPathByName: Map<string, string>;
	modelByName: Map<string, string>;
} {
	const sessionPathByName = new Map<string, string>();
	const modelByName = new Map<string, string>();
	for (const manifest of scanAllManifests()) {
		for (const w of manifest.workers) {
			if (w.sessionPath) sessionPathByName.set(w.name, w.sessionPath);
			if (typeof w.model === "string") modelByName.set(w.name, w.model);
		}
	}
	return { sessionPathByName, modelByName };
}

function formatElapsed(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	if (m === 0) return `${s}s`;
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** v1.2 mailbox markers (DESIGN.md §12), read-only: q-file exists → "Q?";
 *  a-file exists and is newer than the question → "A→" (answered/steered). */
async function mailboxMarkers(dir: string, name: string): Promise<string> {
	// EXTERNAL_DEPENDENCY: mailbox files at /tmp/exchange/<task>/q-<name>.json
	// and a-<name>.json — existence + mtime ordering only, contents never read.
	let qMtime = -1;
	let aMtime = -1;
	try {
		qMtime = (await stat(questionPathFor(dir, name))).mtimeMs;
	} catch {
		// no question file
	}
	try {
		aMtime = (await stat(answerPathFor(dir, name))).mtimeMs;
	} catch {
		// no answer file
	}
	return [qMtime >= 0 ? "Q?" : "", aMtime >= 0 && aMtime > qMtime ? "A→" : ""]
		.filter(Boolean)
		.join(" ");
}

/** v1.5 progress ping display (DESIGN.md §18), read-only: last valid ping in
 *  p-<name>.jsonl → " p:<phase>[ <pct>%] (<age>s)"; absent/unreadable → "".
 *  Advisory: never throws past the tool (read failures swallowed). */
async function pingMarker(dir: string, name: string): Promise<string> {
	try {
		const ping = readLastProgress(progressPathFor(dir, name));
		if (!ping) return "";
		const pctPart = typeof ping.pct === "number" ? ` ${ping.pct}%` : "";
		const tsMs = Date.parse(ping.ts);
		const ageS = Number.isNaN(tsMs) ? "?" : String(Math.max(0, Math.round((Date.now() - tsMs) / 1000)));
		return ` p:${ping.phase}${pctPart} (${ageS}s)`;
	} catch {
		return ""; // advisory only — absent → nothing (backward compatible)
	}
}

/** Probe runs place under /tmp/exchange/_probe — no report is expected there,
 *  so a missing report must render `report —`, never `report✗` (DESIGN.md
 *  §19.4 probe honesty). */
function isProbeView(v: WorkerView): boolean {
	return v.dir.endsWith("/_probe");
}

/**
 * F1 fleet-usage line for delegate_status (the chosen surface — smallest one
 * that makes the aggregate visible; the fleet overlay already shows per-
 * worker gauges). One line per task, e.g.
 *   fleet my-task "fix the login race": ↓12.4k out · cache 890k · sent 1.2m · 3 workers
 * with a partial marker appended when some workers could not be counted.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - task: task slug (exchange dir basename) — the fleet label
 *   - snap: aggregateTaskUsage's snapshot (recomputed from session files)
 *   - description: optional manifest task description (quoted when present)
 * Output: one-line human string; token counts via usage.ts formatTokens
 * Guarantees: pure formatting, no I/O; partial list appended when non-empty
 * Raises: none
 */
export function formatFleetUsageLine(task: string, snap: TaskUsageSnapshot, description?: string): string {
	const desc = description ? ` "${description}"` : "";
	const partial = snap.partial.length > 0 ? ` · partial: ${snap.partial.join(", ")}` : "";
	return (
		`fleet ${task}${desc}: ↓${formatTokens(snap.outputTokens)} out` +
		` · cache ${formatTokens(snap.cacheReadTokens)}` +
		` · sent ${formatTokens(snap.sentTokens)}` +
		` · ${snap.workers} workers${partial}`
	);
}

/** Resume hint (DESIGN.md §19.3/§19.4): live fleet empty + non-empty archive
 *  → point at the last archived tasks. Advisory: read failures swallowed. */
async function resumeHint(): Promise<string> {
	try {
		const tasks = listArchivedTasks();
		if (tasks.length === 0) return "";
		return `last archived task(s): ${tasks.slice(-3).join(", ")} — archive at ${archiveRoot()}`;
	} catch {
		return "";
	}
}

/**
 * Register the `delegate_status` tool on the orchestrator's extension API.
 * <p>
 * FUNCTION_CONTRACT (tool `execute`):
 * Input:
 *   - name (optional): worker name; omitted → every worker in every manifest
 * Output: ToolResult — one formatted status line per worker (+ blocked list,
 *   resume hint when the live fleet is empty) and details.workers = WorkerView[]
 * Guarantees:
 *   - READ-ONLY: manifest reads, fs existence/mtime stats, progress/session
 *     JSONL parses — no mutating herdr or fs call anywhere
 *   - unknown worker name → "No delegate worker named …" + known-worker list,
 *     never a throw
 *   - probe honesty (§19.4): a probe run renders `report —`, never `report✗`
 * Raises: none (read failures are swallowed by the tolerant helpers)
 */
export function registerStatusTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate_status",
		label: "Delegate Status",
		description:
			"Read-only status of delegate workers: name, live status, placement kind, branch, report presence, elapsed. " +
			"Pass name for one worker; omit to see all known workers (from manifests + the live host). Never mutates anything.",
		promptSnippet: "Read-only status of delegate workers (never mutates)",
		promptGuidelines: [
			"Use delegate_status to check a specific worker after a timed-out or detached delegate call instead of repeating delegate — but do NOT poll it in a loop: the background watcher (DESIGN.md §21) wakes you on report-ready / mailbox-question / grill-deck / context-critical / worker-dead.",
			"When delegate_status shows a worker as blocked, read the worker's pane and either answer the worker's question or send a re-brief.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Worker name; omit for all known workers" })),
		}),
		renderCall(args, theme) {
			const name = typeof args?.name === "string" ? args.name : "(all)";
			const head = theme.fg("toolTitle", theme.bold("delegate_status "));
			return {
				render: (width?: number) => clampLines([`${head} ${theme.fg("accent", name)}`], width),
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate_status", resultText, theme);
			return { render: (width?: number) => clampLines(lines, width), invalidate: () => {} };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const views = await buildWorkerView(transport);
			const { sessionPathByName, modelByName } = usageSource();
			const selected = params.name
				? views.filter((v) => v.name === params.name)
				: views;

			if (selected.length === 0) {
				const hint = params.name
					? `No delegate worker named "${params.name}" (known workers: ${views.map((v) => v.name).join(", ") || "none"}).`
					: "No delegate workers known (no manifests under /tmp/exchange).";
				const archiveHint = await resumeHint();
				return {
					content: [{ type: "text", text: archiveHint ? `${hint}\n${archiveHint}` : hint }],
					details: { workers: [] },
				};
			}

			const lines = await Promise.all(
				selected.map(async (v: WorkerView) => {
					const mailbox = await mailboxMarkers(v.dir, v.name);
					const mailboxPart = mailbox ? ` ${mailbox}` : "";
					// v1.5 (DESIGN.md §18): last progress ping when present, e.g.
					// " p:implementing 40% (12s)"; absent → nothing (backward compatible).
					const pingPart = await pingMarker(v.dir, v.name);
					// Dual gauge (DESIGN.md §20): parse the recorded session JSONL when the
					// manifest holds a session path → "ctx P% ↑Xk ↓Yk" — context % primary
					// (pi's own formula), tokens display-only. Tolerant; no path → no column.
					const sessionPath = sessionPathByName.get(v.name);
					let usagePart = "";
					if (sessionPath) {
						// EXTERNAL_DEPENDENCY (via usage.ts): the worker's session JSONL on
						// disk (manifest `sessionPath`) is read synchronously for the gauge.
						const u = parseSessionUsage(sessionPath);
						const window = resolveContextWindow(modelByName.get(v.name));
						const pct = contextPct(u, window);
						usagePart = ` ctx ${pct === null ? "?" : pct + "%"} ↑${fmtK(u.input)} ↓${fmtK(u.output)}` +
							(u.turns > CONTEXT_TURNS_WARN ? ` (${u.turns} turns!)` : "");
					}
					// Probe honesty (§19.4): probes never render report✗.
					const reportPart = v.reportExists
						? "report✓"
						: isProbeView(v)
							? "report —"
							: "report✗";
					return `${v.name} ${v.status} ${v.kind} ${v.branch ?? "-"} ${reportPart}${mailboxPart}${pingPart}${usagePart} ${formatElapsed(v.elapsedMs)}`;
				}),
			);
			const blocked = selected.filter((v) => v.status === "blocked");
			if (blocked.length > 0) {
				lines.push(
					`Blocked: ${blocked.map((v) => v.name).join(", ")} — read the pane, then answer or re-brief.`,
				);
			}
			// Resume hint (§19.3/§19.4): live fleet empty + non-empty archive.
			const liveCount = selected.filter((v) => v.status === "working" || v.status === "blocked").length;
			if (liveCount === 0) {
				const archiveHint = await resumeHint();
				if (archiveHint) lines.push(archiveHint);
			}
			// F1 fleet usage accounting: one aggregate line per task dir of the
			// selected workers — description, master-orchestrator link and the
			// recomputed token/cache/sent roll-up. aggregateTaskUsage is called
			// WITHOUT persist (read-only tool contract); missing/corrupt session
			// files degrade to a partial marker on the line, never an error.
			const fleetDirs = [...new Set(selected.map((v) => v.dir))];
			for (const dir of fleetDirs) {
				const snap = aggregateTaskUsage(dir);
				if (!snap) continue; // no readable manifest → no fleet line
				lines.push(formatFleetUsageLine(basename(dir), snap, readManifest(dir)?.description));
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { workers: selected },
			};
		},
	});
}


// ===========================================================================
// SECTION 2/3 — background watcher, event detection, §23 retire, config resolution
// (verbatim move of the old src/watch.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — event-driven background watcher (DESIGN.md §21).
 *
 * Field motivation: §20.1 removed the long blocking wait but left NO sanctioned
 * way to wait after `E_TIMEOUT` — so the orchestrator improvised `sleep 1500`
 * in bash (parked session, invisible to the fleet UI, no gauges). The watcher
 * replaces that improvisation: it polls out-of-band and WAKES the orchestrator
 * with one `pi.sendUserMessage(text, { deliverAs: "followUp" })` per batch of
 * events, so the orchestrator's turn can simply END after a detach.
 *
 * Advisory by contract: a watcher failure must NEVER affect spawn or collect
 * outcomes. Every read is tolerant, every delivery is guarded — a build without
 * `sendUserMessage` (headless/old) stays inert, never throws.
 *
 * Independent of the fleet UI: no `ctx.hasUI` guard, works headless.
 *
 * Dependency rule (DESIGN.md §4.1): imports transport.ts, exchange.ts and
 * usage.ts only — NEVER transport/herdr.ts. The Transport instance is injected
 * from index.ts, exactly like the tools get it.
 */

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
 *  shares the same 30-min default (fleet.ts FLEET_STALE_AFTER_MS). */
export const WATCH_DEFAULT_STALE_AFTER_MS = 30 * 60_000;
/** Floor for staleAfterMs — same rationale as the interval floor. */
export const WATCH_MIN_STALE_AFTER_MS = 60_000;
/** §23 retire: how long a RETIRABLE worker (valid report + drained mailbox +
 *  done/idle) may keep its pane before the watcher closes it on its own —
 *  the TTL half of the close rule (the ACK half is the release marker).
 *  0 is legal (close on the first retirable tick). Inactive unless the
 *  master switch watch.retire is explicitly true — auto-teardown is OPT-IN. */
export const RETIRE_DEFAULT_TTL_MS = 900_000;
/** report-mismatch grace (report-path mismatch incident, 2026-09): how long a
 *  LIVE worker that has SPOKEN but produced no report at the watched path
 *  stays un-woken before the mismatch event fires. Conservative: long enough
 *  that every genuinely slow worker (thinking, tooling) clears it without a
 *  wake, short enough that a finished-but-misdirected worker cannot hang the
 *  orchestrator for long. */
export const WATCH_DEFAULT_MISMATCH_GRACE_MS = 120_000;
/** Floor for mismatchGraceMs — a typo like 5 must not wake per tick. */
export const WATCH_MIN_MISMATCH_GRACE_MS = 10_000;
/** §23 master switch default: FALSE — the watcher never closes panes unless
 *  the operator opted in via watch.retire:true (user decision, mandatory). */
export const RETIRE_DEFAULT_ENABLED = false;

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
	/** report-mismatch grace (default 2 min, floor 10 s): a live worker that
	 *  has spoken but produced no report at the watched path fires the
	 *  mismatch event once this long after startedAt. */
	mismatchGraceMs: number;
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
 *   (via homedir(); the single config file for watch + collect + spawn
 *   defaults across the extension).
 */
function readDelegateConfig(): Record<string, unknown> | null {
	try {
		const raw = readFileSync(join(homedir(), ".pi", "agent", "pi-delegate.config.json"), "utf8");
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
		mismatchGraceMs: WATCH_DEFAULT_MISMATCH_GRACE_MS,
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
		return {
			intervalMs: num(w.intervalMs, fallback.intervalMs, WATCH_MIN_INTERVAL_MS),
			settleGateMs: num(w.settleGateMs, fallback.settleGateMs, 1),
			staleAfterMs: num(w.staleAfterMs, fallback.staleAfterMs, WATCH_MIN_STALE_AFTER_MS),
			releaseOn: w.releaseOn === "started" ? "started" : "settle",
			retireTtlMs,
			retire,
			mismatchGraceMs: num(w.mismatchGraceMs, fallback.mismatchGraceMs, WATCH_MIN_MISMATCH_GRACE_MS),
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

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What the watcher can notice. `report-invalid` is the distinct MESSAGE of the
 * report-ready detection (§21 event 1): the file is readable but fails
 * validateReport — the orchestrator's move differs (diagnose, not verify).
 */
export type WatchEventKind =
	| "report-ready"
	| "report-invalid"
	| "mailbox-question"
	| "nudge-failed"
	| "grill-deck"
	| "context-critical"
	| "worker-dead"
	| "worker-stale"
	| "report-mismatch";

export interface WatchEvent {
	worker: string;
	dir: string;
	kind: WatchEventKind;
	/** Concrete next action for the orchestrator — the whole point of the wake-up. */
	message: string;
	/** Payload identity. Dedup is per worker+kind, but a worker that asks a
	 *  SECOND question, rewrites its report or opens a SECOND deck states a NEW
	 *  fact, so those kinds carry the payload identity here (report mtime /
	 *  question ts / deck invocation count). Gauge- and absence-shaped kinds
	 *  (context-critical, worker-dead) omit it — they must fire exactly once.
	 *  worker-stale fingerprints by collectedAt: a RE-COLLECT writes a new
	 *  stamp, which re-arms the wake-up (§22). */
	fingerprint?: string;
}

/** Dedup key: dir#worker#kind[#fingerprint]. */
export function eventKey(e: Pick<WatchEvent, "worker" | "dir" | "kind" | "fingerprint">): string {
	return `${e.dir}#${e.worker}#${e.kind}${e.fingerprint ? `#${e.fingerprint}` : ""}`;
}

// ---------------------------------------------------------------------------
// Snapshot — manifests + live statuses + self-identification, no judgement
// ---------------------------------------------------------------------------

export interface WatchWorker {
	name: string;
	dir: string;
	reportPath: string;
	sessionPath?: string;
	model?: string;
	/** Parsed manifest startedAt (undefined when absent/unparseable). */
	startedAtMs?: number;
	/** True when herdr currently knows this agent (status ≠ unknown). */
	live: boolean;
	/** Placement kind (probe dirs are tabs by construction). */
	kind: "worktree" | "tab";
	/** This very session IS that worker (self-event filter, §21). */
	self: boolean;
	/** Probe run (dir /tmp/exchange/_probe) — no report is ever expected. */
	probe: boolean;
	/** Manifest collectedAt (ISO, written by COLLECT on successful delivery):
	 *  report-ready/report-invalid must not fire for this worker — a fresh
	 *  session's `seen` dedup cannot remember the earlier wake-up. Reader-only:
	 *  collect writes the field, the watcher never does. */
	collectedAt?: string;
	/** Session JSONL path of the orchestrator that spawned this worker (written
	 *  by spawn at manifest-record time). Set + different from the watcher's own
	 *  session → this worker belongs to ANOTHER session's fleet and
	 *  detectWorkerEvents emits NOTHING for it (ownership, v1.11.x). Absent
	 *  (legacy manifest) → legacy behavior. Reader-only: spawn writes the
	 *  field, the watcher never does. */
	orchestratorSessionPath?: string;
	/** Manifest-level fleet owner (F1 field, written since 1.15.0 by spawn —
	 *  the first delegate call hoists its own session path here; set-once).
	 *  B1 fallback ownership: when a worker entry carries NO worker-level
	 *  orchestratorSessionPath, a masterSessionPath different from the
	 *  watcher's own session still proves a KNOWN foreign owner →
	 *  detectWorkerEvents emits NOTHING (a bystander session must not be woken
	 *  by a foreign/legacy manifest in the shared exchange root). Absent →
	 *  fail-open (true legacy, no owner field anywhere). Reader-only. */
	masterSessionPath?: string;
	/** §23 retire inputs/outputs, threaded from the manifest (reader-only for
	 *  the clock fields — the retire pass writes them, the snapshot stays a
	 *  view): brief path + resolved report-schema fragment (condition 1
	 *  validates base + brief fragment), the placement (closing needs it),
	 *  the observed herdr status this tick, and the persisted clock stamps. */
	briefPath?: string;
	reportSchemaFragment?: Record<string, unknown>;
	placement?: Placement;
	status?: AgentStatusName;
	retirableSince?: string;
	retiredAt?: string;
}

export interface WatchSnapshot {
	workers: WatchWorker[];
	/** False when listStatuses() failed: herdr unreachable means NOBODY is
	 *  known-live, which must NOT be read as "everyone died". */
	statusesKnown: boolean;
}

/** Noise guard: workers older than this are history, not a fleet — manifests
 *  outlive sessions, and a fresh orchestrator must not be woken for last
 *  week's teardown. */
export const WATCH_LOOKBACK_MS = 24 * 60 * 60_000;
/** A worker placed seconds ago is not dead: herdr may not have registered it
 *  yet (and startAgent itself takes time). */
export const WATCH_DEAD_GRACE_MS = 60_000;
/** Session JSONL scan cap: only the tail can hold a NEW tool call, and a
 *  10 s poll must not re-parse 50 MB per worker. */
export const SESSION_TAIL_BYTES = 1_000_000;

/** The grill-deck tool name — a worker that invoked it is blocked on a HUMAN
 *  at its own pane, not on the mailbox. */
export const GRILL_DECK_TOOL = "grill_deck";

export interface SelfIdentity {
	/** This session's JSONL path (ctx.sessionManager.getSessionFile()). */
	sessionFile?: string;
	/** This session's cwd (ctx.cwd). */
	cwd?: string;
}

/**
 * Worker gate (v1.11.x): is THIS session one of the manifest's workers? A
 * worker session mounts no watcher — it is someone's fleet row, not an
 * audience. Same strictness as the `isSelf` match below — exact session JSONL
 * path, or a worktree worker's unique checkout path (tab workers share the
 * repo cwd, so cwd never identifies them; the checkoutPath branch also covers
 * the spawn race, where the manifest record predates the worker's
 * sessionPath) — but with NO lookback window: the gate asks about a SESSION,
 * which may outlive the 24 h fleet. Scans every manifest; garbage anywhere
 * degrades to false, never throws.
 */
export function isWorkerSession(self: SelfIdentity, manifests: ExchangeManifest[]): boolean {
	for (const m of manifests) {
		const workers = m?.workers;
		if (!Array.isArray(workers)) continue;
		for (const w of workers) {
			if (w === null || typeof w !== "object") continue;
			if (
				self.sessionFile !== undefined &&
				typeof w.sessionPath === "string" &&
				w.sessionPath === self.sessionFile
			) {
				return true;
			}
			if (
				w.placement?.kind === "worktree" &&
				self.cwd !== undefined &&
				typeof w.placement.checkoutPath === "string" &&
				w.placement.checkoutPath === self.cwd
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * F6 (two-tier wake-up): does THIS session OWN child manifests — i.e. is it the
 * orchestrator of its own delegation fan-out? A tier-1 worker-orchestrator is a
 * worktree WORKER of the meta session (so `isWorkerSession` gates its watcher
 * off) while ALSO recording `orchestratorSessionPath` = its own session file in
 * every CHILD manifest it spawned. True when some manifest worker entry has
 * `orchestratorSessionPath === self.sessionFile` — such a session is an
 * AUDIENCE for its own children and must keep a watcher. Same tolerance style
 * as `isWorkerSession`: garbage anywhere degrades to false, never throws; plain
 * loops, no JSON parse. Matched by exact session JSONL path only (the same
 * strictness as the F1 ownership match in detectWorkerEvents).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - self: this session's identity (sessionFile is the only field consulted)
 *   - manifests: manifests from scanAllManifests() (untyped JSON — may be garbage)
 * Output: true iff some worker entry names this session as its orchestrator
 * Guarantees:
 *   - tolerant: absent/garbage manifests and worker entries degrade to false
 *   - no throw, no side effects
 * Raises: never
 */
export function ownsChildManifests(self: SelfIdentity, manifests: ExchangeManifest[]): boolean {
	if (self.sessionFile === undefined) return false;
	for (const m of manifests) {
		const workers = m?.workers;
		if (!Array.isArray(workers)) continue;
		for (const w of workers) {
			if (w === null || typeof w !== "object") continue;
			if (
				typeof w.orchestratorSessionPath === "string" &&
				w.orchestratorSessionPath.length > 0 &&
				w.orchestratorSessionPath === self.sessionFile
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Merge manifests + live statuses into the watcher's view. `statuses === null`
 * means herdr is unreachable (statusesKnown:false). Self-identification is
 * exact by session path, or — for worktree placements only — by the unique
 * per-worker checkout path (tab workers share the repo cwd, so they are never
 * muted on cwd alone).
 */
export function workersFromManifests(
	manifests: ExchangeManifest[],
	statuses: AgentStatus[] | null,
	self: SelfIdentity = {},
	nowMs: number = Date.now(),
): WatchSnapshot {
	const liveNames = new Set(
		(statuses ?? []).filter((s) => s && s.status !== "unknown").map((s) => s.name),
	);
	// §23: the observed status per name (a retirable worker must be done/idle —
	// a bare `live` boolean cannot tell done/idle from working/blocked).
	const statusByName = new Map(
		(statuses ?? [])
			.filter((s) => s && typeof s?.name === "string")
			.map((s) => [s.name as string, s.status]),
	);
	const workers: WatchWorker[] = [];
	for (const manifest of manifests) {
		for (const w of manifest.workers) {
			if (typeof w?.name !== "string" || w.name.length === 0) continue;
			const startedAtMs = Date.parse(w.startedAt ?? "");
			if (Number.isFinite(startedAtMs) && nowMs - startedAtMs > WATCH_LOOKBACK_MS) continue;
			const checkoutPath = w.placement?.checkoutPath;
			const isSelf =
				(self.sessionFile !== undefined &&
					typeof w.sessionPath === "string" &&
					w.sessionPath === self.sessionFile) ||
				(w.placement?.kind === "worktree" &&
					self.cwd !== undefined &&
					typeof checkoutPath === "string" &&
					checkoutPath === self.cwd);
			workers.push({
				name: w.name,
				dir: manifest.dir,
				reportPath: w.reportPath,
				...(typeof w.sessionPath === "string" && w.sessionPath.length > 0
					? { sessionPath: w.sessionPath }
					: {}),
				...(typeof w.model === "string" && w.model.length > 0 ? { model: w.model } : {}),
				...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
				live: liveNames.has(w.name),
				kind: w.placement?.kind === "tab" ? "tab" : "worktree",
				self: isSelf,
				probe: manifest.dir.endsWith("/_probe"),
				...(typeof w.collectedAt === "string" && w.collectedAt.length > 0
					? { collectedAt: w.collectedAt }
					: {}),
				...(typeof w.orchestratorSessionPath === "string" && w.orchestratorSessionPath.length > 0
					? { orchestratorSessionPath: w.orchestratorSessionPath }
					: {}),
				// B1 fallback ownership — manifest-level field, threaded per manifest
				// (the fleet owner is the same for every worker in this manifest).
				...(typeof manifest.masterSessionPath === "string" && manifest.masterSessionPath.length > 0
					? { masterSessionPath: manifest.masterSessionPath }
					: {}),
				// §23 retire threading — every field tolerant: a manifest is untyped
				// JSON, garbage reads as absent (legacy behavior).
				...(typeof w.briefPath === "string" && w.briefPath.length > 0 ? { briefPath: w.briefPath } : {}),
				...(isPlainRecord(w.reportSchemaFragment)
					? { reportSchemaFragment: w.reportSchemaFragment }
					: {}),
				...(isPlainRecord(w.placement) ? { placement: w.placement as unknown as Placement } : {}),
				...(statusByName.has(w.name) ? { status: statusByName.get(w.name) } : {}),
				...(typeof w.retirableSince === "string" && w.retirableSince.length > 0
					? { retirableSince: w.retirableSince }
					: {}),
				...(typeof w.retiredAt === "string" && w.retiredAt.length > 0 ? { retiredAt: w.retiredAt } : {}),
			});
		}
	}
	return { workers, statusesKnown: statuses !== null };
}

/** Read live statuses tolerantly: herdr unreachable → null (statuses unknown).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: transport — the injected Transport seam
 * Output: AgentStatus[], or null when herdr is unreachable
 * Guarantees:
 *   - any transport failure → null (never throws); the snapshot then carries
 *     statusesKnown:false so death cannot be inferred
 * Raises: never
 */
export async function readStatusesTolerant(transport: Transport): Promise<AgentStatus[] | null> {
	try {
		return await transport.listStatuses();
	} catch {
		return null;
	}
}

export async function collectSnapshot(
	transport: Transport,
	self: SelfIdentity = {},
	nowMs: number = Date.now(),
): Promise<WatchSnapshot> {
	return workersFromManifests(scanAllManifests(), await readStatusesTolerant(transport), self, nowMs);
}

// ---------------------------------------------------------------------------
// Session JSONL scan — tool-call names (accompanies parseSessionUsage, which
// deliberately knows nothing about tools). Tolerant: unreadable/corrupt/partial
// → [] (a half-written last line is skipped, never thrown).
// ---------------------------------------------------------------------------

/** Tail-reads a worker's session JSONL (whole file when it fits the cap).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — session JSONL path; maxBytes — tail cap (default
 *   SESSION_TAIL_BYTES = 1 MB)
 * Output: the whole file, or its last maxBytes bytes
 * Guarantees:
 *   - the fd-based tail read never loads a >1 MB session fully; the first
 *     (partial) line fails to parse and is skipped by callers
 *   - unreadable file → "" (no tool calls known), never throws
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the worker's pi session JSONL
 *   (path comes from the manifest's sessionPath / pi session storage).
 */
function readSessionTail(path: string, maxBytes: number = SESSION_TAIL_BYTES): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		if (size <= maxBytes) return readFileSync(path, "utf8");
		// Tail read (the first, partial line fails to parse and is skipped) —
		// explicit fd read: @types/node types position/length only on the Buffer
		// overload of readFileSync, and no new dependencies are allowed.
		fd = openSync(path, "r");
		const start = size - maxBytes;
		const len = size - start;
		const buf = Buffer.allocUnsafe(len);
		readSync(fd, buf, 0, len, start);
		return buf.toString("utf8");
	} catch {
		return ""; // unreadable → no tool calls known, never throw
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed — advisory scan, nothing to recover
			}
		}
	}
}

/** Names of every toolCall in a worker session (duplicates preserved — the
 *  count is a useful fingerprint). Empty when the session is unknown/corrupt.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: sessionPath — worker session JSONL path (undefined → [])
 * Output: toolCall block names in order, duplicates preserved
 * Guarantees:
 *   - reads only the session TAIL (readSessionTail) — a 10 s poll must not
 *     re-parse 50 MB; corrupt/partial lines are skipped
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the worker's pi session JSONL.
 */
export function sessionToolCallNames(sessionPath?: string): string[] {
	if (!sessionPath) return [];
	const names: string[] = [];
	for (const line of readSessionTail(sessionPath).split("\n")) {
		if (!line.trim()) continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // corrupt/partial line — skip
		}
		const content = (e as { message?: { content?: unknown } })?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				block !== null &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "toolCall" &&
				typeof (block as { name?: unknown }).name === "string"
			) {
				names.push((block as { name: string }).name);
			}
		}
	}
	return names;
}

/** How many times a worker invoked a tool (0 when unreadable).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: sessionPath (may be undefined), toolName
 * Output: exact invocation count in the session tail (0 when unreadable)
 * Raises: never
 */
export function countSessionToolCall(sessionPath: string | undefined, toolName: string): number {
	return sessionToolCallNames(sessionPath).filter((n) => n === toolName).length;
}

// ---------------------------------------------------------------------------
// Detection — pure functions over a WatchWorker; every read tolerant
// ---------------------------------------------------------------------------

export interface DetectOptions {
	/** Default CONTEXT_CRITICAL_PCT (90) — the operator restart line. */
	contextCriticalPct?: number;
	/** Grace before worker-dead fires (default WATCH_DEAD_GRACE_MS). */
	deadGraceMs?: number;
	/** Injectable clock (tests). */
	nowMs?: number;
	/** False when herdr was unreachable this tick → worker-dead is suppressed
	 *  (statuses unknown ≠ dead). detectEvents sets it from the snapshot; a
	 *  standalone detectWorkerEvents call defaults to "statuses are known". */
	statusesKnown?: boolean;
	/** v1.11.x ownership: THIS watcher's session JSONL path (threaded from
	 *  WatcherDeps.self). A worker whose orchestratorSessionPath is set and
	 *  differs belongs to another session → zero events for it. Undefined
	 *  (degraded self-id) → fail-open: ownership cannot be disproven, events
	 *  fire as before. */
	selfSessionFile?: string;
	/** worker-stale threshold (§22): injectable for tests; production threads
	 *  watch.staleAfterMs via startWatcher. Default WATCH_DEFAULT_STALE_AFTER_MS. */
	staleAfterMs?: number;
	/** report-mismatch grace (report-path mismatch incident, 2026-09):
	 *  injectable for tests; production threads watch.mismatchGraceMs via
	 *  startWatcher. Default WATCH_DEFAULT_MISMATCH_GRACE_MS (2 min, floor 10 s). */
	mismatchGraceMs?: number;
	/** §23 retire TTL (ms since the worker became retirable): injectable for
	 *  tests; production threads watch.retireTtlMs via startWatcher. Consumed
	 *  by the retire pass (createWatcher tick), not by detectWorkerEvents. */
	retireTtlMs?: number;
}

function truncate(s: string, max = 220): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function fileMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * All conditions currently true for one worker (already-deduped by the caller).
 * Detection order = orchestrator priority: a landed report outranks a question,
 * which outranks a deck, which outranks the gauges, which outrank death.
 */
export function detectWorkerEvents(w: WatchWorker, opts: DetectOptions = {}): WatchEvent[] {
	// 0. Ownership (v1.11.x): a worker spawned by a DIFFERENT session is that
	//    session's fleet — emit nothing for it, or N mounted watchers would wake
	//    N orchestrators for the same event. Exact session-path match only, and
	//    fail-open on both edges: a legacy manifest carries no
	//    orchestratorSessionPath, and a degraded self-id (no session file) must
	//    never swallow a real wake-up — a lost report-ready is worse than a
	//    duplicate.
	if (
		w.orchestratorSessionPath !== undefined &&
		opts.selfSessionFile !== undefined &&
		w.orchestratorSessionPath !== opts.selfSessionFile
	) {
		return [];
	}
	// B1 fallback ownership (diag-watch-crossfleet C1): a worker entry with NO
	// orchestratorSessionPath on a manifest that carries masterSessionPath ≠ my
	// session has a KNOWN owner and it is not me → silent. Fail-open only when
	// NO owner field exists anywhere on the manifest (true legacy) or the
	// self-id is degraded (a lost report-ready is worse than a duplicate).
	if (
		w.orchestratorSessionPath === undefined &&
		w.masterSessionPath !== undefined &&
		opts.selfSessionFile !== undefined &&
		w.masterSessionPath !== opts.selfSessionFile
	) {
		return [];
	}
	// §23 retire: a retired worker is HISTORY — the pane is already gone, so
	// every event kind would be noise (worker-dead above all: the close itself
	// is the expected cause of any herdr absence). The manifest entry stays.
	if (w.retiredAt !== undefined) return [];
	const nowMs = opts.nowMs ?? Date.now();
	const events: WatchEvent[] = [];
	const mk = (kind: WatchEventKind, message: string, fingerprint?: string): WatchEvent => ({
		worker: w.name,
		dir: w.dir,
		kind,
		message,
		...(fingerprint !== undefined ? { fingerprint } : {}),
	});

	// 1. report-ready / report-invalid (§21) — SILENT when the manifest records
	//    collectedAt: collect already DELIVERED this report, and the `seen`
	//    dedup is session-scoped, so a fresh session would re-wake on it. Only
	//    collect writes collectedAt; the watcher is a reader. Other event kinds
	//    are unaffected (a collected worker can still ask questions etc.).
	const reportMtime = fileMtimeMs(w.reportPath);
	if (reportMtime !== null && w.collectedAt === undefined) {
		const verdict = validateReport(w.reportPath, w.name);
		if (verdict.ok) {
			events.push(
				mk(
					"report-ready",
					`report landed at ${w.reportPath} (status=${verdict.report.status}) — read it and verify ` +
						`against the brief: ${truncate(verdict.report.summary, 160)}`,
					`${reportMtime}`,
				),
			);
		} else if (!verdict.error.includes("not readable")) {
			// readable-but-invalid is a DISTINCT message: the move is diagnose, not verify
			events.push(
				mk(
					"report-invalid",
					`report at ${w.reportPath} exists but fails validation: ${truncate(verdict.error, 160)} — ` +
						"read the pane, find the root cause, then a diagnosed retry (never verbatim)",
					`${reportMtime}`,
				),
			);
		}
	}

	// 2. mailbox-question (§12) — fingerprinted by the envelope ts, so a worker
	//    that asks AGAIN after an answer wakes the orchestrator again.
	const q = readQuestion(questionPathFor(w.dir, w.name));
	if (q) {
		const options = q.options?.length ? ` Options: ${q.options.join(" | ")}.` : "";
		events.push(
			mk(
				"mailbox-question",
				`asks: "${truncate(q.question, 200)}"${options} Answer via delegate_mailbox ` +
					`(action 'answer', worker ${w.name}) — it is waiting for you.`,
				q.ts,
			),
		);
	}

	// 2b. nudge-failed (F6) — a mailbox answer/steer whose PANE nudge failed
	//    after bounded retries. The mailbox tool (spawn.ts) wrote the marker;
	//    the watcher delivers the wake-up instead of the socket. Fingerprint =
	//    the marker ts. Consume discipline: the marker is deleted by a
	//    SUBSEQUENT successful nudge AND by a fresh same-name spawn (both in
	//    spawn.ts) — so a leftover can only re-fire ONCE for a new watcher
	//    session, and only as an advisory wake (dedup is per-watcher-lifetime).
	const nudgeMarker = readNudgeFailedMarker(nudgeFailedPathFor(w.dir, w.name));
	if (nudgeMarker) {
		events.push(
			mk(
				"nudge-failed",
				`pane nudge failed after retries (${truncate(nudgeMarker.error, 160)}) — the answer IS posted at ` +
					`${answerPathFor(w.dir, w.name)}; re-prompt the pane manually or retry the ` +
					"steer — a successful nudge clears this marker.",
				nudgeMarker.ts,
			),
		);
	}

	// 3. grill-deck — the worker blocked itself on an INTERACTIVE deck; only a
	//    human at that pane can answer, so say exactly that.
	const decks = countSessionToolCall(w.sessionPath, GRILL_DECK_TOOL);
	if (decks > 0) {
		events.push(
			mk(
				"grill-deck",
				`invoked grill_deck (${decks}×) — it is blocked on an interactive question deck in its OWN ` +
					`pane and only a human can answer there: open the pane, or steer it to use the ` +
					`mailbox (q-${w.name}.json) instead.`,
				`${decks}`,
			),
		);
	}

	// 4. context-critical — pi's own gauge (last assistant totalTokens ÷ window).
	if (w.sessionPath) {
		const pct = contextPct(parseSessionUsage(w.sessionPath), resolveContextWindow(w.model));
		const threshold = opts.contextCriticalPct ?? CONTEXT_CRITICAL_PCT;
		if (pct !== null && pct >= threshold) {
			events.push(
				mk(
					"context-critical",
					`context at ${pct}% ≥ ${threshold}% (session ${w.sessionPath}) — its next turns compact: ` +
						"steer it to wrap up NOW (delegate_mailbox action 'steer') or plan a fresh-name retry",
				),
			);
		}
	}

	// 5. worker-dead — herdr no longer knows the agent AND nothing landed. Skipped
	//    when herdr is unreachable (statuses unknown ≠ dead), for probes (no report
	//    expected) and inside the placement grace window (herdr may not have
	//    registered the agent yet).
	if (
		!w.live &&
		opts.statusesKnown !== false &&
		reportMtime === null &&
		!w.probe &&
		(w.startedAtMs === undefined || nowMs - w.startedAtMs >= (opts.deadGraceMs ?? WATCH_DEAD_GRACE_MS))
	) {
		events.push(
			mk(
				"worker-dead",
				`has no live host status and no report at ${w.reportPath} — it exited without producing ` +
					"anything. Treat as a failed spawn: read the pane, then a diagnosed retry.",
			),
		);
	}

	// 5b. report-mismatch (report-path mismatch incident, 2026-09) — a LIVE
	//     worker that has SPOKEN (≥1 assistant turn in its session JSONL) but
	//     produced NO report at the watched path past the mismatch grace.
	//     BUG_FIX_CONTEXT: symptom — an orchestrator's brief pointed the worker
	//     at report-impl.md; the worker obeyed, finished real work and went
	//     IDLE, and the watcher stayed silent forever because the only
	//     missing-report salvage (worker-dead) requires !live and the watcher
	//     stats exactly one path. Why the old shape did not work — a live idle
	//     finished worker is precisely the state no salvage covered. What was
	//     done — this branch fires ONCE per worker lifetime (key-only dedup,
	//     same semantics as worker-dead) and lists every report-* file newer
	//     than startedAt in the task dir, so the orchestrator sees exactly what
	//     landed instead of the watched path. A later landing report still
	//     fires the ordinary fingerprinted report-ready on top.
	//     BUG_FIX_CONTEXT (D3, report-mismatch critique): symptom — after a
	//     watcher session restart a fresh `seen` set re-fired report-mismatch
	//     for every still-missing worker (the key-only dedup was per SESSION,
	//     not per worker lifetime). Why the in-memory set cannot work — a new
	//     session starts with an empty `seen`; disk facts are the only
	//     cross-session memory. What was done — the event carries a startedAtMs
	//     fingerprint (stateless identity: a new same-name spawn has a new
	//     startedAt and re-arms), and the watcher tick persists a
	//     mismatch-fired-<name>.json marker after a SUCCESSFUL delivery;
	//     detection suppresses the event while a marker with the SAME
	//     startedAtMs exists (the invariant "the watcher is a reader, never a
	//     writer" is amended for this absence-kind only — see exchange.ts).
	//     W-MM4: a worker whose only activity is a PENDING mailbox question is
	//     already covered by the mailbox-question wake — report-mismatch stays
	//     silent while a question is pending (once the question is answered and
	//     still no report lands, the mismatch wake fires). One stall, one wake.
	//     Invariant: for every non-probe live worker that has produced output,
	//     exactly one of report-ready, report-invalid or report-mismatch is
	//     eventually firable — an indefinitely silent finished worker is
	//     unreachable.
	const mismatchMarker = readMismatchFiredMarker(mismatchFiredPathFor(w.dir, w.name));
	const mismatchAlreadyFired =
		mismatchMarker !== null && w.startedAtMs !== undefined && mismatchMarker.startedAtMs === w.startedAtMs;
	if (
		w.live &&
		!w.probe &&
		w.collectedAt === undefined &&
		reportMtime === null &&
		!q &&
		!mismatchAlreadyFired &&
		w.sessionPath !== undefined &&
		parseSessionUsage(w.sessionPath).turns > 0 &&
		w.startedAtMs !== undefined &&
		nowMs - w.startedAtMs >= (opts.mismatchGraceMs ?? WATCH_DEFAULT_MISMATCH_GRACE_MS)
	) {
		const strays = scanReportCandidates(w.dir, w.startedAtMs, w.name).filter((p) => p !== w.reportPath);
		events.push(
			mk(
				"report-mismatch",
				`worker is live and has spoken but no report landed at ${w.reportPath} (past the mismatch grace) — ` +
					(strays.length > 0
						? `report files newer than start in ${w.dir}: ${strays.join(", ")} (siblings' reports belong to their own workers) — `
						: `no report-* file newer than start in ${w.dir} either — `) +
						"read the pane, salvage the work, collect manually or do a diagnosed retry",
				String(w.startedAtMs),
			),
		);
	}

	// 6. worker-stale (§22, v1.12.1) — a COLLECTED worker (valid report was
	//    delivered) that herdr still lists as live after the stale window:
	//    teardown-after-collect missed it (config off, advisory failure, older
	//    build) — surface it instead of letting panes pile up. Fires only for
	//    the OWNING session (the ownership gate above already silences foreign
	//    fleets — do not bypass it), only while genuinely live (an unreachable
	//    herdr reads live:false → silent, the same "statuses unknown ≠ dead"
	//    rule as worker-dead). Fingerprint = collectedAt, so a re-collect
	//    re-arms; an unparseable stamp reads as absent → silent (a flag is a
	//    claim). Probes never get a collectedAt → structurally silent.
	const collectedMs = w.collectedAt !== undefined ? Date.parse(w.collectedAt) : Number.NaN;
	const staleAfterMs = opts.staleAfterMs ?? WATCH_DEFAULT_STALE_AFTER_MS;
	if (w.live && Number.isFinite(collectedMs) && nowMs - collectedMs > staleAfterMs) {
		events.push(
			mk(
				"worker-stale",
				`collected ${Math.round((nowMs - collectedMs) / 60_000)} min ago and still mounted — ` +
					"tear it down (/delegate-teardown) or keep",
				w.collectedAt,
			),
		);
	}

	return events;
}

/**
 * Deduped detection over a whole snapshot. `seen` is the watcher's memory
 * (worker+kind[+fingerprint] fired since the last reset): an event fires at
 * most once per key. State reset is split by fingerprint presence (D1 fix):
 *   - keys WITHOUT a fingerprint (gauge/absence kinds: worker-dead,
 *     context-critical) are forgotten when not observed true this tick —
 *     re-arming is the point (fire exactly once per episode);
 *   - keys WITH a fingerprint (report-ready, report-invalid, mailbox-question,
 *     grill-deck, nudge-failed, worker-stale) are forgotten ONLY when the
 *     worker vanished from the snapshot or the same worker+kind is observed
 *     with a DIFFERENT fingerprint. A tick with no observation (transient
 *     ENOENT on the report, a manifest read between rewrites) must not
 *     resurrect the event.
 * Mutates `seen`, returns the new events.
 */
export function detectEvents(
	snap: WatchSnapshot,
	seen: Set<string>,
	opts: DetectOptions = {},
): WatchEvent[] {
	const tickOpts: DetectOptions = { ...opts, statusesKnown: snap.statusesKnown };
	const fresh: WatchEvent[] = [];
	const current = new Set<string>();
	// Fingerprinted-kind observations this tick: `dir#worker#kind` → fingerprint
	// (used by the reset below — a key is forgotten on a NEW fingerprint, not on
	// a missed observation).
	const observedFingerprints = new Map<string, string>();
	// Workers present in THIS tick's snapshot: `dir#worker`.
	const presentWorkers = new Set<string>();
	for (const w of snap.workers) {
		presentWorkers.add(`${w.dir}#${w.name}`);
		for (const e of detectWorkerEvents(w, tickOpts)) {
			const key = eventKey(e);
			current.add(key);
			if (e.fingerprint !== undefined) {
				observedFingerprints.set(`${w.dir}#${w.name}#${e.kind}`, e.fingerprint);
			}
			if (!seen.has(key)) {
				seen.add(key);
				fresh.push(e);
			}
		}
	}
	// State reset: forget every key not observed true THIS tick, EXCEPT
	// fingerprinted keys of workers still present (see the contract above).
	// Gauge keys of vanished workers are dropped too, and `seen` cannot grow
	// without bound: a fingerprinted key is bounded by one per worker+kind and
	// is replaced on a new fingerprint; the 24 h lookback (WATCH_LOOKBACK_MS)
	// drops vanished workers. Manifest writes are atomic
	// (exchange.ts atomicWriteFileSync), so a vanished worker is a real removal,
	// not a half-written read.
	for (const key of [...seen]) {
		if (current.has(key)) continue;
		// Parse from the right: dir#worker#kind[#fingerprint] — kind and worker
		// never contain '#' (kinds are fixed tokens; worker names are
		// [a-z][a-z0-9_-]{0,31}), so the dir can safely be re-joined.
		const parts = key.split("#");
		const fp = parts.length > 3 ? parts.pop() : undefined;
		const kind = parts.pop() ?? "";
		const name = parts.pop() ?? "";
		const dir = parts.join("#");
		if (fp !== undefined) {
			const workerGone = !presentWorkers.has(`${dir}#${name}`);
			const currentFp = observedFingerprints.get(`${dir}#${name}#${kind}`);
			// BUG_FIX_CONTEXT: symptom — duplicate [report-ready] wake-ups for a
			// report whose mtime never changed (field: two deliveries, same
			// fingerprint; diag-watch-crossfleet case C5). Root cause — the old
			// reset deleted every key not observed true this tick, so ONE tick
			// with a missed observation (transient ENOENT on the report;
			// fileMtimeMs → null suppresses the event) FORGOT the fingerprinted
			// key and the restored file re-fired. Missed observation was treated
			// as condition reset. What was done: fingerprinted keys survive a
			// no-observation tick of a still-present worker; they are forgotten
			// only on worker-vanished or a different fingerprint.
			if (!workerGone && (currentFp === undefined || currentFp === fp)) continue;
		}
		seen.delete(key);
	}
	return fresh;
}

// ---------------------------------------------------------------------------
// §23 retire — extension-side auto-teardown of drained worker panes.
// RETIRABLE = valid report (base + brief fragment) AND drained mailbox AND
// herdr status done/idle. CLOSE on ACK (release-<name>.json) or TTL
// (watch.retireTtlMs since retirable). EXCEPTIONS: invalid/missing report,
// pending worker question — never close; probes close IMMEDIATELY once
// settled (they never write reports). The clock (retirableSince) and the
// close stamp (retiredAt) live in the manifest, never in memory only.
// ---------------------------------------------------------------------------

export type RetireReason = "ack" | "ttl" | "probe";

export interface RetireDecision {
	worker: string;
	dir: string;
	reason: RetireReason;
}

export interface RetireEval {
	retirable: boolean;
	decision?: RetireDecision;
}

/**
 * Mailbox drained (retirable condition 2): no pending q-<name>.json AND no
 * UNANSWERED a-<name>.json. There is no worker-side ack for answers, so an
 * answer counts as consumed once the worker produced output after it — its
 * final report postdating the answer file proves the mail was picked up. An
 * answer newer than the report (or any report absence) keeps the mailbox
 * conservative: not drained → never retirable (the ACK release is the
 * orchestrator's explicit override for the Q&A flow).
 */
export function mailboxDrained(dir: string, name: string, reportMtimeMs: number): boolean {
	if (readQuestion(questionPathFor(dir, name))) return false; // pending question
	const aMtime = fileMtimeMs(answerPathFor(dir, name));
	if (aMtime === null) return true; // no answer ever posted
	return aMtime <= reportMtimeMs; // consumed: the worker's report postdates the answer
}

/**
 * One worker's retire evaluation (§23) — fs reads only, no writes, no
 * transport. `nowMs`/`ttlMs` injectable for tests.
 */
export function evaluateRetire(
	w: WatchWorker,
	opts: { nowMs?: number; ttlMs?: number } = {},
): RetireEval {
	const nowMs = opts.nowMs ?? Date.now();
	const ttlMs = opts.ttlMs ?? resolveWatchConfig().retireTtlMs;

	// EXCEPTION — probes: they never write reports, so condition 1 can never
	// hold for them; the probe VERDICT (returned inline to the orchestrator)
	// is the smoke gate's completion. A settled probe (done/idle, no pending
	// question) closes IMMEDIATELY — no stamp, no TTL wait.
	if (w.probe) {
		const settled = w.status === "done" || w.status === "idle";
		if (!settled || readQuestion(questionPathFor(w.dir, w.name))) return { retirable: false };
		return { retirable: true, decision: { worker: w.name, dir: w.dir, reason: "probe" } };
	}

	// Condition 1 — report exists and is schema-VALID (base + brief fragment).
	// Invalid/missing NEVER retires: that is the diagnosis window for a
	// diagnosed retry.
	const reportMtime = fileMtimeMs(w.reportPath);
	if (reportMtime === null) return { retirable: false };
	const schema = w.reportSchemaFragment ?? (w.briefPath ? parseBriefSchema(w.briefPath) : null);
	if (!validateReportAgainstSchema(w.reportPath, w.name, schema).ok) return { retirable: false };

	// Condition 2 — mailbox drained (pending question = the exception above).
	if (!mailboxDrained(w.dir, w.name, reportMtime)) return { retirable: false };

	// Condition 3 — herdr status done or idle (NOT working/blocked; an unknown
	// status — herdr unreachable or the agent gone — is never retirable).
	if (w.status !== "done" && w.status !== "idle") return { retirable: false };

	// Retirable → CLOSE on either ACK or TTL.
	if (fileMtimeMs(releasePathFor(w.dir, w.name)) !== null) {
		return { retirable: true, decision: { worker: w.name, dir: w.dir, reason: "ack" } };
	}
	const sinceMs = w.retirableSince !== undefined ? Date.parse(w.retirableSince) : Number.NaN;
	if (Number.isFinite(sinceMs) && nowMs - sinceMs >= ttlMs) {
		return { retirable: true, decision: { worker: w.name, dir: w.dir, reason: "ttl" } };
	}
	return { retirable: true };
}

export interface RetirePassOptions {
	nowMs?: number;
	retireTtlMs?: number;
	/** §23 MASTER SWITCH override (tests): undefined → resolveWatchConfig().retire
	 *  (default FALSE — auto-teardown is opt-in). False → the whole pass is a
	 *  no-op: no stamp, no clear, no close — byte-identical to pre-§23 behavior. */
	retireEnabled?: boolean;
	/** THIS watcher's session JSONL path — retire is a MUTATION, so unlike the
	 *  wake-up events it fails CLOSED on a degraded self-id: a worker that
	 *  declares an owner is retired only by that owner. Legacy manifests (no
	 *  field) stay fail-open, and a worker session never retires itself. */
	selfSessionFile?: string;
}

async function stampWorkerField(
	w: WatchWorker,
	patch: (x: ExchangeManifest["workers"][number]) => ExchangeManifest["workers"][number],
): Promise<void> {
	await updateManifest(w.dir, (m) => ({
		...m,
		workers: m.workers.map((x) => (x.name === w.name ? patch(x) : x)),
	}));
}

/**
 * A teardown that reports "not found" means the pane/workspace is ALREADY
 * gone (herdr dropped it, another session closed it, the user closed the
 * pane) — an IDEMPOTENT close, not a failure. Matched on the message text:
 * herdr's error JSON carries code "tab_not_found"/"workspace_not_found" and
 * the transport wraps it verbatim into the DelegateError message; there is
 * no dedicated E_* code for it.
 */
function isAlreadyGone(err: unknown): boolean {
	return /not[\s_-]?found/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * One retire pass over a snapshot (§23): stamp/clear `retirableSince` on
 * state transitions (persisted — watcher restarts must not lose the clock),
 * close retirable workers via the Transport (the same teardown path the
 * collect hook and /delegate-teardown use — verified: herdr has no
 * `pane close`; the real verbs are `tab close` / `worktree remove` +
 * `workspace close`), and stamp `retiredAt` on success. The manifest entry
 * is NEVER deleted (history stays). Advisory by contract: any failure is
 * logged and retried next tick — it can never affect a spawn or a collect.
 * Returns the decisions actually closed.
 */
export async function retirePass(
	transport: Transport,
	snap: WatchSnapshot,
	opts: RetirePassOptions = {},
	log: (m: string) => void = () => {},
): Promise<RetireDecision[]> {
	// §23 MASTER SWITCH (default FALSE): with the feature off the pass is a
	// NO-OP — panes never close, the manifest never gains retirableSince, and
	// behavior is byte-identical to pre-§23. evaluateRetire stays pure; the
	// gate lives here (and in the mailbox release action).
	const enabled = opts.retireEnabled ?? resolveWatchConfig().retire;
	if (!enabled) return [];
	const nowMs = opts.nowMs ?? Date.now();
	const decisions: RetireDecision[] = [];
	for (const w of snap.workers) {
		try {
			// Never retire THIS session's own worker (a worker session mounts no
			// watcher, but a fixture/hostile snapshot must not self-close either).
			if (w.self) continue;
			// Ownership, fail-closed for declared owners (see RetirePassOptions).
			if (
				w.orchestratorSessionPath !== undefined &&
				w.orchestratorSessionPath !== opts.selfSessionFile
			) {
				continue;
			}
			// Already retired → history, never re-closed.
			if (w.retiredAt !== undefined) continue;
			// A placement without a closable handle cannot be closed (corrupt
			// manifest entry). Ref-aware (workerhost inversion, design §3): a
			// placementRef OR a legacy paneId counts — old manifests (paneId only)
			// stay closeable, ref-only entries would too.
			if (
				!w.placement ||
				!(
					(typeof w.placement.placementRef === "string" && w.placement.placementRef.length > 0) ||
					(typeof w.placement.paneId === "string" && w.placement.paneId.length > 0)
				)
			) {
				continue;
			}

			const outcome = evaluateRetire(w, { nowMs, ttlMs: opts.retireTtlMs });
			if (outcome.retirable && !outcome.decision && w.retirableSince === undefined) {
				// Became retirable THIS tick — start the TTL clock, persisted.
				await stampWorkerField(w, (x) => ({ ...x, retirableSince: new Date(nowMs).toISOString() }));
				continue;
			}
			if (!outcome.retirable && w.retirableSince !== undefined) {
				// The state broke (new question, report rewritten bad, back to
				// working…) — clear the clock; the next retirable transition
				// restarts the TTL from that moment.
				await stampWorkerField(w, (x) => ({ ...x, retirableSince: undefined }));
				continue;
			}
			if (outcome.decision) {
				let alreadyGone = false;
				try {
					await transport.teardown({ name: w.name, placement: w.placement, force: true });
				} catch (err) {
					// BUG_FIX_CONTEXT: symptom — the retire pass spammed "retire pass
					// error … tab_not_found" every tick when the pane had ALREADY been
					// closed elsewhere (herdr, user, another session): the failed close
					// never stamped retiredAt, so the decision re-fired forever.
					// Why not fixed in the transport: teardown is also the interactive
					// /delegate-teardown path, where a genuinely misconfigured placement
					// must stay a visible error; only the autonomous pass needs the
					// idempotent semantics. What was done: "not found" from the close is
					// treated as a successful retire (stamp retiredAt, log the variance).
					if (!isAlreadyGone(err)) throw err;
					alreadyGone = true;
				}
				await stampWorkerField(w, (x) => ({ ...x, retiredAt: new Date(nowMs).toISOString() }));
				// Archive at retire (diag-retire-msg Q3 item 1): a TTL close of an
				// UNCOLLECTED report must not orphan it — without this, the report
				// survives in /tmp only as a silent artifact and every evidence path
				// into the worktree dies with the teardown. Same helper + naming as
				// the collect-path archive (basename preserved, manifest snapshot
				// rewritten in place) → idempotent by construction. Best-effort by
				// contract: a failure never blocks the close.
				try {
					const manifest = readManifest(w.dir);
					if (manifest) archiveReport(w.dir, w.reportPath, manifest as unknown as Record<string, unknown>);
				} catch {
					// archive is advisory — the retiredAt stamp already guards history
				}
				// CONSUME the ACK marker: a leftover release-<name>.json would ACK-close
				// a fresh same-name retry (spawn appends into the SAME task dir, §23.3
				// sanctions the retry) on its FIRST retirable tick — silently skipping
				// its TTL diagnosis window. Best-effort, like every marker handling.
				try {
					rmSync(releasePathFor(w.dir, w.name), { force: true });
				} catch {
					// marker cleanup is advisory — the retiredAt stamp already guards the history
				}
				log(
					`retired worker ${w.name} (${outcome.decision.reason}${alreadyGone ? ", pane was already gone — idempotent close" : ""}) — ` +
						"herdr name freed for a same-name retry",
				);
				decisions.push(outcome.decision);
			}
		} catch (err) {
			// Advisory by contract (§21): a failed stamp/teardown only costs this
			// worker this tick — next tick retries (the missing retiredAt makes
				// the decision re-fire).
			log(
				`retire pass error for ${w.name} (${err instanceof Error ? err.message : String(err)}) — advisory, retried next tick`,
			);
		}
	}
	return decisions;
}

// ---------------------------------------------------------------------------
// Delivery text
// ---------------------------------------------------------------------------

/** One batch = one wake-up message (§21).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: events — the fresh events of one tick
 * Output: a single multi-line message with a header and one `- [kind] worker:`
 *   line per event
 * Guarantees:
 *   - pure formatting; no truncation beyond what detect already applied
 * Raises: never
 */
export function formatEventBatch(events: WatchEvent[]): string {
	const head =
		`DELEGATE WATCHER — ${events.length} event(s) need attention (you do not need to poll ` +
		`delegate_status for these):`;
	return [head, ...events.map((e) => `- [${e.kind}] ${e.worker}: ${e.message}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Watcher loop
// ---------------------------------------------------------------------------

export interface WatcherDeps {
	transport: Transport;
	/** Delivery sink — pi.sendUserMessage(..., {deliverAs:"followUp"}) in
	 *  production, injectable in tests. Throws are swallowed by the loop. */
	send: (text: string) => void | Promise<void>;
	intervalMs?: number;
	self?: SelfIdentity;
	detect?: DetectOptions;
	/** Snapshot source override (tests drive fixtures; production uses
	 *  collectSnapshot over scanAllManifests + the injected transport). */
	snapshot?: () => Promise<WatchSnapshot>;
	/** Advisory log sink (console.error by default). */
	log?: (msg: string) => void;
}

export interface WatcherHandle {
	/** One poll+deliver cycle — exposed so tests drive it without timers. */
	tick: () => Promise<WatchEvent[]>;
	stop: () => void;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Build the poller. Never throws; every cycle is wrapped so a bad manifest, an
 * unreachable herdr or a throwing sink only costs that cycle.
 */
export function createWatcher(deps: WatcherDeps): WatcherHandle {
	const seen = new Set<string>();
	const log = deps.log ?? ((m: string) => console.error(`[pi-delegate watch] ${m}`));
	let stopped = false;
	// v1.11.x ownership: the live self identity (the session this watcher is
	// mounted in) wins over an injected option; both absent → fail-open.
	const detectOpts: DetectOptions = {
		...(deps.detect ?? {}),
		selfSessionFile: deps.self?.sessionFile ?? deps.detect?.selfSessionFile,
	};

	const tick = async (): Promise<WatchEvent[]> => {
		if (stopped) return [];
		let events: WatchEvent[];
		let leafWorker = false;
		// D3: the tick's snapshot view — consumed by the post-delivery marker
		// write (report-mismatch fired-marker keyed by startedAtMs). Null when
		// the snapshot itself failed (no events, no marker).
		let tickSnap: WatchSnapshot | null = null;
		try {
			const snap = deps.snapshot ? await deps.snapshot() : await collectSnapshot(deps.transport, deps.self ?? {});
			tickSnap = snap;
			// §23 retire pass — BEFORE event delivery and fully guarded: a stamp/
			// teardown failure is logged and retried next tick; it can never affect
			// spawn/collect outcomes or this tick's wake-ups.
			try {
				await retirePass(
					deps.transport,
					snap,
					{
						retireTtlMs: detectOpts.retireTtlMs,
						selfSessionFile: detectOpts.selfSessionFile,
					},
					log,
				);
			} catch (err) {
				log(`retire pass skipped (${errText(err)}) — advisory, no outcome affected`);
			}
			events = detectEvents(snap, seen, detectOpts);
			// A worker never needs to be woken for its own events…
			events = events.filter((e) => !snap.workers.some((w) => w.self && w.dir === e.dir && w.name === e.worker));
			// …and a LEAF (worktree) worker session is not an orchestrator: its
			// fleet is someone else's. F6 exception: a worktree worker that OWNS
			// child manifests (a tier-1 worker-orchestrator) keeps its watcher —
			// its own children fire (their orchestratorSessionPath equals its
			// session file) while its PARENT's manifest stays silenced by the
			// detectWorkerEvents ownership gate, so F1 scoping is intact.
			const selfOwnsChildren =
				detectOpts.selfSessionFile !== undefined &&
				snap.workers.some(
					(w) =>
						typeof w.orchestratorSessionPath === "string" &&
						w.orchestratorSessionPath.length > 0 &&
						w.orchestratorSessionPath === detectOpts.selfSessionFile,
				);
			leafWorker = snap.workers.some((w) => w.self && w.kind === "worktree") && !selfOwnsChildren;
		} catch (err) {
			log(`tick skipped (${errText(err)}) — advisory, no outcome affected`);
			return [];
		}
		if (leafWorker || events.length === 0) return [];
		try {
			await deps.send(formatEventBatch(events));
			// D3 (report-mismatch critique): persist the fired-marker AFTER a
			// successful delivery — a fresh watcher session (empty `seen`) must not
			// re-fire the wake for the same worker run; the marker keyed by
			// startedAtMs is the cross-session memory. Written only on success: a
			// failed send rolls the batch's keys back out of `seen` AND leaves no
			// marker, so the wake re-fires while its condition still holds.
			// Advisory: a marker-write failure costs at most one extra wake after a
			// watcher restart, never a spawn/collect outcome.
			for (const e of events) {
				if (e.kind !== "report-mismatch" || tickSnap === null) continue;
				const mismatched = tickSnap.workers.find((x) => x.dir === e.dir && x.name === e.worker);
				if (!mismatched || mismatched.startedAtMs === undefined) continue;
				try {
					await writeMismatchFiredMarker(mismatchFiredPathFor(e.dir, e.worker), e.worker, mismatched.startedAtMs);
				} catch (err) {
					log(`mismatch-fired marker write failed (${errText(err)}) — at most one extra wake after a watcher restart`);
				}
			}
		} catch (err) {
			// BUG_FIX_CONTEXT: symptom — one failed send during a transient
			// delivery outage permanently silenced that wake-up (the `seen` key was
			// already recorded). Why the old behavior did not work: keys were added
			// before delivery, with no rollback path. What was done: on send failure
			// the batch's keys are deleted from `seen`, so the event re-fires on the
			// next tick while its condition still holds.
			// Delivery failed: roll the batch's keys back out of `seen`, or a single
			// transient send error would permanently swallow the wake-up — the exact
			// failure this module exists to prevent (a gauge-shaped event has no
			// fingerprint, so its key would never fire again). Still advisory, never a
			// queue: nothing is buffered, and an event whose condition already reset is
			// simply gone (detectEvents forgets keys it did not see this tick).
			for (const e of events) seen.delete(eventKey(e));
			log(`delivery failed (${errText(err)}) — batch rolled back, re-fires while still true (advisory)`);
		}
		return events;
	};

	const intervalMs = deps.intervalMs ?? WATCH_DEFAULT_INTERVAL_MS;
	const timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Never keep a dying process alive for an advisory poller (bun/node differ on
	// the timer shape — unref is optional on both).
	(timer as unknown as { unref?: () => void }).unref?.();

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};

	return { tick, stop };
}

// ---------------------------------------------------------------------------
// Lifecycle registry (mirrors fleet.ts mount/dispose: module-level, so
// session_shutdown can stop what session_start started; double-start replaces)
// ---------------------------------------------------------------------------

let activeStop: (() => void) | null = null;

/** Stop the running watcher (idempotent, safe when nothing is running). */
export function stopWatcher(): void {
	const s = activeStop;
	activeStop = null;
	try {
		s?.();
	} catch {
		// stop is advisory — never throw past session_shutdown
	}
}

/**
 * Delivery sink builder (§21). Guarded by design: a build without
 * `sendUserMessage` (headless/old pi) returns a NO-OP — the watcher stays inert
 * instead of throwing on every tick. `deliverAs: "followUp"` is what makes it a
 * wake-up that never interrupts a turn in flight.
 */
export function makeSender(
	pi: { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown },
): (text: string) => void {
	return (text: string): void => {
		if (typeof pi.sendUserMessage !== "function") return;
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	};
}

/**
 * Start the watcher for this session (DESIGN.md §21: headless-safe — NO
 * ctx.hasUI guard). Returns the dispose fn; also reachable via stopWatcher().
 */
export function startWatcher(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	transport: Transport,
	ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } },
): () => void {
	stopWatcher(); // idempotent double-start replaces the previous mount
	const cfg = resolveWatchConfig();
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.();
	} catch {
		sessionFile = undefined; // self-identification degrades, watcher lives
	}
	const handle = createWatcher({
		transport,
		intervalMs: cfg.intervalMs,
		self: { sessionFile, cwd: ctx.cwd },
		send: makeSender(pi),
		// Watcher log sink (UX fix, 2026-09-10): the default console.error sink
		// surfaced INTERNAL bookkeeping (routine retire successes) into the user's
		// pane. Every line now goes to the audit file (append-only, best-effort);
		// the pane shows ONLY lines that need a human: errors and anomalies
		// ("already gone" — the pane vanished before the TTL close, the agent may
		// still be alive detached; see resolveLiveTabId's drift guard).
		log: (m: string) => {
			void appendFile(
				join(homedir(), ".pi", "agent", "delegate-watch.log"),
				`${new Date().toISOString()} ${m}\n`,
			).catch(() => undefined); // audit is advisory — never throw past the tick
			if (/\berror\b|\bfail|already gone|unavailable/i.test(m)) {
				console.error(`[pi-delegate watch] ${m}`);
			}
		},
		// v1.12.1: the worker-stale threshold threads from watch.staleAfterMs
		// (deps.detect can still override per-mount, e.g. in tests).
		// §23: the retire TTL threads the same way.
		detect: { staleAfterMs: cfg.staleAfterMs, retireTtlMs: cfg.retireTtlMs, mismatchGraceMs: cfg.mismatchGraceMs },
	});
	const stop = (): void => {
		handle.stop();
		if (activeStop === stop) activeStop = null;
	};
	activeStop = stop;
	return stop;
}

// ===========================================================================
// SECTION 3/3 — /delegate-fleet + /delegate-teardown commands
// (verbatim move from index.ts in W6 — ex src/commands.ts, absorbed there in
// W5; this module owns the watcher/teardown state these commands drive. The
// commands.ts errText copy is NOT re-duplicated: observe already has an
// identical errText (watcher loop), so the moved code uses that one.)
// ===========================================================================

/**
 * Interactive teardown: lists workers, confirms, then tears each down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport). Every planned op is pre-logged to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 */

function asDelegateError(err: unknown): DelegateError | null {
	if (err instanceof Error && typeof (err as DelegateError).code === "string") {
		return err as DelegateError;
	}
	return null;
}

async function logTo(dir: string, line: string): Promise<void> {
	try {
		await appendFile(`${dir}/teardown.log`, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// best-effort audit log — never block teardown on logging failure
	}
}

export function registerCommands(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerCommand("delegate-fleet", {
		description: "Mission-control overlay: live worker fleet status, reports, mailbox, budget burn (read-only)",
		async handler(_args, ctx) {
			await openFleetOverlay(ctx, { transport });
		},
	});

	pi.registerCommand("delegate-teardown", {
		description: "Confirm + sequentially tear down all delegate workers (pre-logged, never automatic)",
		async handler(_args, ctx) {
			const views = await buildWorkerView(transport);
			if (views.length === 0) {
				ctx.ui.notify("No delegate workers to tear down.", "info");
				// Nothing left to observe — also clear the ambient fleet UI (restore
				// footer) so no stale chip/widget survives an empty fleet.
				disposeFleetUI();
				return;
			}

			// Manifest history vs actionable workers (UX fix, 2026-09-10): manifest
			// worker entries are NEVER deleted, so the scan returns every worker
			// ever spawned — the wall of “✗ tab_not_found” for long-closed workers
			// looked like a catastrophe while meaning “nothing to close”. Retired
			// entries are HISTORY: skipped with a count, never attempted.
			const retiredViews = views.filter((v) => v.retired === true);
			const actionable = views.filter((v) => v.retired !== true);
			if (actionable.length === 0) {
				ctx.ui.notify(
					`Nothing to tear down — all ${views.length} manifest entries are retired history.`,
					"info",
				);
				disposeFleetUI();
				return;
			}

			const list = actionable
				.map((v) => `${v.name} (${v.kind}${v.branch ? `, branch ${v.branch}` : ""})`)
				.join(", ");
			const retiredNote = retiredViews.length > 0 ? ` (plus ${retiredViews.length} retired history entries skipped)` : "";
			const confirmed = await ctx.ui.confirm(
				"Tear down delegate workers?",
				`${actionable.length} worker(s): ${list}${retiredNote}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Teardown cancelled — workers left running.", "info");
				return;
			}

			const outcomes: string[] = [];
			for (const v of actionable) {
				// Pre-log the planned mutating op BEFORE executing it (audit trail).
				await logTo(
					v.dir,
					`plan: teardown worker=${v.name} kind=${v.kind} workspace=${v.placement.workspaceId} pane=${v.placement.paneId}`,
				);
				try {
					// EXTERNAL_DEPENDENCY: herdr teardown via the injected transport
					// (mutating pane/workspace IPC — the only mutating call here).
					await transport.teardown({ name: v.name, placement: v.placement, force: true });
					await logTo(v.dir, `done: teardown worker=${v.name} ok`);
					outcomes.push(`✓ ${v.name} (${v.kind}) torn down`);
				} catch (err) {
					// Idempotent close (parity with the retire pass): a "not found"
					// teardown means the pane/workspace is ALREADY gone — a success for
					// bookkeeping, not an error. Only genuine failures stay ✗.
					if (isAlreadyGone(err)) {
						await logTo(v.dir, `done: teardown worker=${v.name} no-op (already gone)`);
						outcomes.push(`✓ ${v.name} (${v.kind}) — already closed, no-op`);
						continue;
					}
					await logTo(v.dir, `error: teardown worker=${v.name} failed: ${errText(err)}`);
					const de = asDelegateError(err);
					const advice = de?.guidance
						? ` — ${de.guidance}`
						// No structured guidance: fall back to the generic recovery recipe.
						: " — reconcile via /delegate-teardown; for a not_linked_worktree answer, recover via the host workspace listing/close.";
					outcomes.push(`✗ ${v.name}: ${errText(err)}${advice}`);
				}
			}

			// Teardown emptied the fleet: clear the ambient widget + restore the
			// default footer via the module-level mount registry in fleet.ts
			// (DESIGN.md §19.4 — the mount registry is documented in report-impl-ui.json).
			disposeFleetUI();
			ctx.ui.notify(`Teardown finished:\n${outcomes.join("\n")}`, "info");
		},
	});
}
