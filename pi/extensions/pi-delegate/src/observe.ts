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
 * (session JSONL usage + tool-call names + the shared staleness constant —
 * migration stage 3, audit step 10: usage.ts is the ONLY session-JSONL
 * parser (one-parser law); observe consumes parsed numbers/names),
 * archive exports of exchange.ts (resume hint),
 * watch-role.ts (the CANONICAL ownership verdict — delivery, the mount gates
 * and the UI all fold this one table; the module is a leaf with zero
 * production imports),
 * fleet.ts (status-tool render helpers + buildWorkerView + fleet-UI
 * mount/overlay), ./host.ts (the Transport seam + gauge constants), typebox.
 * Never imports the transport implementation
 * (dependency rule, DESIGN.md §4.1 — the Transport instance is injected from
 * index.ts).
 * Exported surface: registerStatusTool |
 * WATCH_DEFAULT_INTERVAL_MS, WATCH_DEFAULT_SETTLE_GATE_MS,
 * WATCH_MIN_INTERVAL_MS, WATCH_DEFAULT_STALE_AFTER_MS,
 * WATCH_MIN_STALE_AFTER_MS, RETIRE_DEFAULT_TTL_MS, RETIRE_DEFAULT_ENABLED,
 * WatchConfig, resolveWatchConfig, COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT,
 * CollectConfig, resolveCollectConfig, WatchEventKind, WatchEvent, eventKey,
 * DeliveryKey, SendOutcome, WatchWorker, WatchSnapshot, WATCH_LOOKBACK_MS, WATCH_DEAD_GRACE_MS,
 * GRILL_DECK_TOOL, SelfIdentity, isWorkerSession,
 * ownsChildManifests, workersFromManifests, readStatusesTolerant, collectSnapshot, DetectOptions,
 * detectWorkerEvents, detectEvents, RetireReason, RetireDecision, RetireEval,
 * mailboxDrained, evaluateRetire, RetirePassOptions, retirePass,
 * formatEventBatch, formatWakeUpAuditLine, WatcherDeps, WatcherHandle, createWatcher, stopWatcher,
 * makeSender, markDeliveredBeforeThrow, startWatcher, registerCommands,
 * formatFleetUsageLine (F1).
 * Wave 2 (session lifecycle, Law 3): watcher mounts are keyed by session file
 * in a globalThis registry — a second mount for an already-mounted session is
 * REFUSED (keeps the first instance), closing the double-module-load double-
 * delivery class (audit D2). RESIDUAL, documented deliberately: two SEPARATE
 * pi processes mounting watchers over the same session file are NOT arbitrated
 * here (no cross-process lockfile in this wave) — the durable per-audience
 * delivered-facts store (delivered-<watcherKey>.json) is the cross-process
 * dedup backstop, and delivery is fail-closed on identity (stage A).
 * Critical invariants (owned here, per report-ref-map.json hiddenInvariants):
 *   - collectedAt-dedup (reader side): report-ready/report-invalid are SILENT
 *     once the manifest records collectedAt — the watcher `seen` dedup is
 *     session memory only, so a fresh session would re-wake on old reports
 *     without the stamp. Observe only READS the stamp; collect (spawn flow,
 *     W4) writes it.
 *   - answer-consumed-mtime: no worker-side ack for mailbox answers exists;
 *     an answer counts as consumed iff the worker's report mtime postdates
 *     the a-<name>.json file (mailboxDrained) — otherwise the mailbox is not
 *     drained and the worker is never retirable.
 *   - retire-ack-consume: release-<name>.json is CONSUMED (deleted) on
 *     successful retire, else a leftover ACK would instantly close a fresh
 *     same-name retry on its first retirable tick; retirableSince/retiredAt
 *     persist in the watcher's satellite file (watch-<key>.json in the task
 *     dir; readers merge layers with the manifest's legacy fields) — never in
 *     memory only.
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
 *   - ownership fail-closed (watcher stage A): delivery answers the ONE
 *     canonical verdict (src/watch-role.ts) — only a proven owner
 *     ("mine") delivers; a legacy no-owner manifest delivers only under an
 *     explicit watch.legacyFailOpen:true; a degraded self-id delivers
 *     NOTHING unconditionally (no configuration escape); skipped deliveries
 *     are auditable (onSkip → the watcher log sink).
 *   - durable delivery store (watcher stage B, guideline §5): the dedup
 *     memory (`seen`) is only a CACHE of the durable delivered-facts file
 *     (delivered-<watcherKey>.json per task dir, exchange.ts I/O). A
 *     delivery key is committed to disk ONLY after a successful send; a
 *     failed send rolls the batch's keys back out of memory only — never
 *     off disk; a failed durable WRITE is not a failed delivery (memory
 *     keys stay, an audit line notes the possible post-restart repeat); a
 *     failed read degrades to an empty store (never throws). Records are
 *     removed ONLY as garbage collection when a worker really vanishes
 *     from the manifests — never on a skipped observation.
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
 * Migration stage 2 (audit step 6): the retire stamps (retirableSince /
 * retiredAt) are lifecycle REDUCER transitions (lifecycle.ts stamp
 * adapters) — an illegal stamp is refused and logged, never a silent
 * corrupt. Migration stage 3 (audit steps 6/10, done): the observer stamps
 * live in the watcher's satellite file (exchange.ts watch-stamp section) —
 * the manifest is never written by the watcher; readers merge layers.
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
	appendDeliveredRecords,
	archiveReport,
	archiveRoot,
	deleteWorkerDeliveryRecords,
	deliveryRecordKey,
	deliveredStorePathFor,
	exchangeRoot,
	listArchivedTasks,
	readDeliveredStore,
	type TaskUsageSnapshot,
} from "./exchange.ts";
import {
	answerPathFor,
	isProbeDir,
	nudgeFailedPathFor,
	parseBriefSchema,
	progressPathFor,
	questionPathFor,
	readLastProgress,
	readNudgeFailedMarker,
	readQuestion,
	readQuestionState,
	readWatchStampLayers,
	releasePathFor,
	manifestStore,
	mergeRetireStamps,
	TEARDOWN_LOG_NAME,
	teardownLogLine,
	updateWatchStamps,
	validateReport,
	validateReportAgainstSchema,
	watcherKeyFor,
	type DeliveryRecord,
	type ExchangeManifest,
	type RetireStamps,
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
import {
	contextPct,
	countSessionToolCall,
	formatTokens,
	parseSessionUsage,
	resolveContextWindow,
	WATCH_DEFAULT_STALE_AFTER_MS,
} from "./usage.ts";
import { stampRetireClockClear, stampRetireClockStart, stampRetired } from "./lifecycle.ts";
import { sessionRole, workerAudienceMatch } from "./watch-role.ts";
import {
	BUDGET_CONFIG_PATH,
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
 *  resolved default budget for workers without a recorded one. Migration
 *  stage 3 (audit step 9): the scan takes the active backend name from the
 *  bound transport (composition root) — no implicit global. */
function usageSource(transport: Transport): {
	sessionPathByName: Map<string, string>;
	modelByName: Map<string, string>;
} {
	const sessionPathByName = new Map<string, string>();
	const modelByName = new Map<string, string>();
	for (const manifest of manifestStore.scan(transport.backendName())) {
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
	return isProbeDir(v.dir);
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
			const { sessionPathByName, modelByName } = usageSource(transport);
			const selected = params.name
				? views.filter((v) => v.name === params.name)
				: views;

			if (selected.length === 0) {
				const hint = params.name
					? `No delegate worker named "${params.name}" (known workers: ${views.map((v) => v.name).join(", ") || "none"}).`
					: `No delegate workers known (no manifests under ${exchangeRoot()}).`;
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
				lines.push(formatFleetUsageLine(basename(dir), snap, manifestStore.read(dir)?.description));
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
 *   (via homedir(); the single config file for watch + collect + spawn
 *   defaults across the extension).
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
	| "worker-stale";

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

/** One parsed delivery key — the CANONICAL in-memory shape of a dedup key
 *  (watcher stage B). Never re-parsed out of a string: the reset loop keeps
 *  this structure in the cache map, so no delimiter-splitting over
 *  unvalidated paths (task dirs and session paths may contain any
 *  separator) can ever reintroduce the ambiguity bug class. */
export interface DeliveryKey {
	dir: string;
	worker: string;
	kind: WatchEventKind;
	fingerprint: string;
}

/** In-memory dedup key: canonical JSON array of FOUR components — task dir,
 *  worker, kind, fingerprint. Same serialization scheme as the durable
 *  store's record key (which omits the dir: the task dir is given by the
 *  store FILE's location) — one scheme, no second format. */
export function eventKey(e: Pick<WatchEvent, "worker" | "dir" | "kind" | "fingerprint">): string {
	return JSON.stringify([e.dir, e.worker, e.kind, e.fingerprint ?? ""]);
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
	 *  (legacy manifest) → the canonical no-owner verdict: fail-closed
	 *  (watcher stage A) unless watch.legacyFailOpen is true. Reader-only:
	 *  spawn writes the field, the watcher never does. */
	orchestratorSessionPath?: string;
	/** Manifest-level fleet owner (F1 field, written since 1.15.0 by spawn —
	 *  the first delegate call hoists its own session path here; set-once).
	 *  B1 fallback ownership: when a worker entry carries NO worker-level
	 *  orchestratorSessionPath, a masterSessionPath different from the
	 *  watcher's own session still proves a KNOWN foreign owner →
	 *  detectWorkerEvents emits NOTHING (a bystander session must not be woken
	 *  by a foreign/legacy manifest in the shared exchange root). Absent →
	 *  the canonical no-owner verdict (fail-closed since watcher stage A;
	 *  watch.legacyFailOpen rolls it back). Reader-only. */
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
 * audience. Watcher stage A: this gate is now a THIN WRAPPER over the
 * canonical role table (sessionRole in src/watch-role.ts — one table shared
 * by the mount gate and delivery, guideline §3.4). Stage C fix: worker
 * identity is proven ONLY by the entry's OWN sessionPath
 * (`sessionPath === self.sessionFile`); the former checkoutPath === cwd
 * branch is REMOVED as ambiguous by construction — tab workers ALWAYS share
 * the orchestrator's checkout, and a historical worker entry poisoned the
 * gate for ANY future session started in that cwd (an orchestrator silently
 * lost its watcher and its child wakes). A degraded self (no sessionFile)
 * and an ownerless entry with a matching cwd both read as "not a worker" →
 * the session MOUNTS (the composer invariant "fail-open toward MOUNTING",
 * harmless since stage A: delivery is fail-closed, a spuriously mounted
 * watcher never produces a wrong wake). No lookback window: the gate asks
 * about a SESSION, which may outlive the 24 h fleet. Scans every manifest;
 * garbage anywhere degrades to false, never throws.
 */
export function isWorkerSession(self: SelfIdentity, manifests: ExchangeManifest[]): boolean {
	return sessionRole(self, manifests).isWorker;
}

/**
 * F6 (two-tier wake-up): does THIS session OWN child manifests — i.e. is it the
 * orchestrator of its own delegation fan-out? A tier-1 worker-orchestrator is a
 * worktree WORKER of the meta session (so `isWorkerSession` gates its watcher
 * off) while ALSO recording `orchestratorSessionPath` = its own session file in
 * every CHILD manifest it spawned. True when some manifest worker entry has
 * `orchestratorSessionPath === self.sessionFile` — such a session is an
 * AUDIENCE for its own children and must keep a watcher. Watcher stage A:
 * this gate is a THIN WRAPPER over the canonical role table (sessionRole in
 * src/watch-role.ts). Direction is fail-closed and stays that way: a session
 * whose self-id is degraded (no sessionFile) owns nothing — a tier-1 lead
 * whose session getter throws does not mount a watcher and loses its child
 * wake (a documented known behavior of the role table). Same tolerance style
 * as `isWorkerSession`: garbage anywhere degrades to false, never throws; plain
 * loops, no JSON parse. Matched by exact session JSONL path only (the same
 * strictness as the F1 ownership match in detectWorkerEvents).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - self: this session's identity (sessionFile is the only field consulted)
 *   - manifests: manifests from manifestStore.scan() (untyped JSON — may be garbage)
 * Output: true iff some worker entry names this session as its orchestrator
 * Guarantees:
 *   - tolerant: absent/garbage manifests and worker entries degrade to false
 *   - no throw, no side effects
 * Raises: never
 */
export function ownsChildManifests(self: SelfIdentity, manifests: ExchangeManifest[]): boolean {
	return sessionRole(self, manifests).ownsChildren;
}

/**
 * Merge manifests + live statuses into the watcher's view. `statuses === null`
 * means herdr is unreachable (statusesKnown:false). Self-identification is
 * EXACT by session path only (stage C fix — the former worktree
 * checkoutPath === cwd equivalent is removed as ambiguous: a historical
 * entry must not mute a new session that merely shares its cwd). This `self`
 * flag drives the self-event filter AND the in-loop leaf-worker suppression
 * in createWatcher — both now match the entry's own sessionPath.
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
		// Migration stage 3 (audit steps 6/10): the watcher's stamps (retirableSince
		// / retiredAt) live in per-watcher satellite files — merge the manifest
		// layer with every satellite layer here (readers merge layers; earliest
		// stamp wins). One tolerant read per manifest dir per scan.
		const stampLayers = readWatchStampLayers(manifest.dir);
		for (const w of manifest.workers) {
			if (typeof w?.name !== "string" || w.name.length === 0) continue;
			const startedAtMs = Date.parse(w.startedAt ?? "");
			if (Number.isFinite(startedAtMs) && nowMs - startedAtMs > WATCH_LOOKBACK_MS) continue;
			// Self-identity (stage C fix): the entry's OWN sessionPath only.
			// BUG_FIX_CONTEXT: the former worktree checkoutPath === cwd branch
			// muted (and leaf-suppressed) any new session that merely started
			// in a checkout where a worker once ran — identity by cwd is
			// ambiguous (tab workers share the orchestrator's checkout too).
			const isSelf =
				self.sessionFile !== undefined &&
				typeof w.sessionPath === "string" &&
				w.sessionPath === self.sessionFile;
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
				probe: isProbeDir(manifest.dir),
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
				// §23 retire stamps, MERGED across layers (manifest + satellite
				// files): the effective values drive the retire decisions.
				...((): RetireStamps => {
					const eff = mergeRetireStamps(
						{
							retirableSince: typeof w.retirableSince === "string" && w.retirableSince.length > 0 ? w.retirableSince : undefined,
							retiredAt: typeof w.retiredAt === "string" && w.retiredAt.length > 0 ? w.retiredAt : undefined,
						},
						stampLayers,
						w.name,
					);
					return eff;
				})(),
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
	return workersFromManifests(manifestStore.scan(transport.backendName()), await readStatusesTolerant(transport), self, nowMs);
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
	 *  WatcherDeps.self). A worker whose proven owner differs belongs to
	 *  another session → zero events for it. Watcher stage A — FAIL-CLOSED:
	 *  undefined (degraded self-id) → ZERO events for EVERY worker, with or
	 *  without legacyFailOpen (guideline §3.6 gives this edge no
	 *  configuration escape); each skip is auditable via onSkip (reason
	 *  "no-self-id"). */
	selfSessionFile?: string;
	/** Watcher stage A: rollback for the "no owner field anywhere on the
	 *  manifest" edge ONLY (threaded from watch.legacyFailOpen, default
	 *  false). true restores the pre-stage-A delivery for legacy manifests —
	 *  UNSAFE on a machine with several sessions (bystander wakes). NEVER
	 *  extends to the "no self-id" edge: a degraded identity delivers nothing
	 *  with or without this flag. */
	legacyFailOpen?: boolean;
	/** Audit hook (watcher stage A, guideline §9): called once per SKIPPED
	 *  delivery with the skip reason — "no-owner" (legacy manifest without any
	 *  owner field, skipped because legacyFailOpen is false) or "no-self-id"
	 *  (this session's identity is unreadable; skipped unconditionally) — and,
	 *  since watcher stage C, once per RESULT-PLANE ANOMALY that produces no
	 *  event of its own: "corrupt-question" (a q-<name>.json file exists but
	 *  fails envelope validation — guideline §6.2.5: audited with the cause,
	 *  never masked as a report event; fires every tick while the file stays
	 *  corrupt, the same cadence as the ownership skips). Foreign-owner
	 *  routing is NOT reported (it is the correct normal path, not a degraded
	 *  edge). `detail` carries the human-readable cause when one exists.
	 *  Optional so detectWorkerEvents stays a pure function; production
	 *  threads a logger from createWatcher. */
	onSkip?: (
		worker: string,
		reason: "no-owner" | "no-self-id" | "corrupt-question",
		detail?: string,
	) => void;
	/** worker-stale threshold (§22): injectable for tests; production threads
	 *  watch.staleAfterMs via startWatcher. Default WATCH_DEFAULT_STALE_AFTER_MS. */
	staleAfterMs?: number;
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

/** Episode fingerprint for worker-dead (watcher stage B, guideline §5.4):
 *  the manifest launch stamp — a new run is a new death episode. A manifest
 *  without a parseable startedAt degrades to a stable per-entry constant
 *  (one wake per dedup lifetime for that edge — documented degradation,
 *  never an empty fingerprint). */
function deathEpisodeFingerprint(w: WatchWorker): string {
	return w.startedAtMs !== undefined ? new Date(w.startedAtMs).toISOString() : "unknown-launch";
}

/** Episode fingerprint for context-critical (watcher stage B, guideline
 *  §5.4): the same launch stamp + the threshold — at most one context wake
 *  per worker launch per threshold. */
function contextEpisodeFingerprint(w: WatchWorker, threshold: number): string {
	return `${deathEpisodeFingerprint(w)}@${threshold}`;
}

/**
 * All conditions currently true for one worker (already-deduped by the caller).
 * Detection order = orchestrator priority: a landed report outranks a question,
 * which outranks a deck, which outranks the gauges, which outrank death.
 */
export function detectWorkerEvents(w: WatchWorker, opts: DetectOptions = {}): WatchEvent[] {
	// 0. Ownership (watcher stage A — the canonical fail-closed verdict):
	//    deliver ONLY on a proven owner match ("mine"). A legacy manifest with
	//    no owner field anywhere delivers only when legacyFailOpen is
	//    explicitly true; a degraded self-id (no session file) delivers NEVER —
	//    that edge is not flag-controlled (guideline §3.6). The old B1
	//    narrowing (a manifest-level masterSessionPath of a known foreign
	//    owner silences a bystander) lives INSIDE the "foreign" verdict and
	//    keeps working with the flag on.
	//    BUG_FIX_CONTEXT: symptom — bystander wakes on foreign/legacy fleets
	//    (diag-watch-crossfleet): a bystander orchestrator was woken, in
	//    imperative wording, for workers it never spawned. Why the old
	//    solution did not work: the two inline filters here were fail-open on
	//    BOTH undeliverable edges — a legacy manifest (no owner field) and a
	//    degraded self-id both sailed through ("a lost report-ready is worse
	//    than a duplicate"), so every mounted watcher heard every fleet. What
	//    was done: one canonical verdict (workerAudienceMatch in
	//    src/watch-role.ts) now shared by delivery, the mount gate and the UI;
	//    delivery is fail-closed with an explicit opt-in rollback
	//    (watch.legacyFailOpen) for the no-owner edge only, and skipped
	//    deliveries are auditable via onSkip instead of being silent.
	{
		const verdict = workerAudienceMatch(
			{ orchestratorSessionPath: w.orchestratorSessionPath, masterSessionPath: w.masterSessionPath },
			{ sessionFile: opts.selfSessionFile },
			{ legacyFailOpen: opts.legacyFailOpen === true },
		);
		if (verdict === "foreign") return [];
		if (verdict === "no-self-id") {
			opts.onSkip?.(w.name, "no-self-id");
			return [];
		}
		if (verdict === "no-owner" && opts.legacyFailOpen !== true) {
			opts.onSkip?.(w.name, "no-owner");
			return [];
		}
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
	//    Watcher stage C (guideline §6.2.5): a q-file that EXISTS but fails
	//    envelope validation is a RESULT-PLANE fact, not silence — it is
	//    audited with the cause via onSkip ("corrupt-question") and never
	//    masked as a report event. Absent stays the normal no-question state.
	const qState = readQuestionState(questionPathFor(w.dir, w.name));
	if (qState.state === "valid") {
		const q = qState.question;
		const options = q.options?.length ? ` Options: ${q.options.join(" | ")}.` : "";
		events.push(
			mk(
				"mailbox-question",
				`asks: "${truncate(q.question, 200)}"${options} Answer via delegate_mailbox ` +
					`(action 'answer', worker ${w.name}) — it is waiting for you.`,
				q.ts,
			),
		);
	} else if (qState.state === "invalid") {
		opts.onSkip?.(w.name, "corrupt-question", `${qState.error} (file kept as-is — the worker may still be mid-write; re-checked every tick)`);
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
	//    Fingerprint = the worker's launch stamp + the threshold (watcher stage
	//    B episode rule): at most ONE context wake per worker LAUNCH — a
	//    restarted worker (new startedAt) is a new episode and may wake again.
	if (w.sessionPath) {
		const pct = contextPct(parseSessionUsage(w.sessionPath), resolveContextWindow(w.model));
		const threshold = opts.contextCriticalPct ?? CONTEXT_CRITICAL_PCT;
		if (pct !== null && pct >= threshold) {
			events.push(
				mk(
					"context-critical",
					`context at ${pct}% ≥ ${threshold}% (session ${w.sessionPath}) — its next turns compact: ` +
						"steer it to wrap up NOW (delegate_mailbox action 'steer') or plan a fresh-name retry",
					contextEpisodeFingerprint(w, threshold),
				),
			);
		}
	}

	// 5. worker-dead — the worker's EPISODE ended WITHOUT a report: herdr no
	//    longer knows the agent (gone from the host), or the worker SETTLED
	//    (done/idle) without ever writing one. Both shapes are the explicit
	//    §6.2.1 "report missing" state (watcher stage C — a settled worker with
	//    no report used to be silent), they are the same failed-spawn move for
	//    the orchestrator, and they carry the same launch-stamp episode
	//    fingerprint (stage B). Skipped when herdr is unreachable (statuses
	//    unknown ≠ dead), for probes (no report expected) and inside the
	//    placement grace window (herdr may not have registered the agent yet).
	//    NOT gated on collectedAt: this branch is about an ABSENT report —
	//    unlike the report-ready/invalid branches, collect's stamp does not
	//    suppress it (guideline §6.2.1).
	const settledWithoutReport = w.status === "done" || w.status === "idle";
	if (
		!w.probe &&
		reportMtime === null &&
		opts.statusesKnown !== false &&
		(!w.live || settledWithoutReport) &&
		(w.startedAtMs === undefined || nowMs - w.startedAtMs >= (opts.deadGraceMs ?? WATCH_DEAD_GRACE_MS))
	) {
		const state = !w.live
			? `has no live host status and no report at ${w.reportPath} — it exited without producing anything`
			: `settled (${w.status}) with no report at ${w.reportPath} — it finished without producing the result`;
		events.push(
			mk(
				"worker-dead",
				`${state}. Treat as a failed spawn: read the pane, then a diagnosed retry (never verbatim).`,
				// Watcher stage B episode rule: the fingerprint is the worker's launch
				// stamp — a NEW run of the worker (new startedAt) is a new death episode
				// and wakes again; a herdr status flap within one launch does not.
				deathEpisodeFingerprint(w),
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
 * cache (watcher stage B: a CACHE of the durable delivered-facts store, not
 * the source of truth): a map from the canonical eventKey to the PARSED
 * DeliveryKey — the reset loop reads the structure, it never re-splits a
 * key string (the old right-to-left `split("#")` survived only while the
 * task dir was the single unvalidated component; the durable keys make the
 * string format gone by construction). An event fires at most once per key.
 * Every kind now carries a fingerprint (gauge/absence kinds carry an
 * EPISODE fingerprint — worker-dead the launch stamp, context-critical the
 * launch stamp + threshold), so the reset rule is uniform (D1 fix, now for
 * all kinds):
 *   - a key survives a tick with no observation of its condition (a
 *     transient ENOENT on the report, a manifest read between rewrites
 *     must not resurrect the event);
 *   - a key is forgotten when the worker VANISHED from the snapshot (a real
 *     removal — manifest writes are atomic) or the same worker+kind is
 *     observed with a DIFFERENT fingerprint (a new episode / a new fact).
 * Mutates `seen`, returns the new events.
 */
export function detectEvents(
	snap: WatchSnapshot,
	seen: Map<string, DeliveryKey>,
	opts: DetectOptions = {},
): WatchEvent[] {
	const tickOpts: DetectOptions = { ...opts, statusesKnown: snap.statusesKnown };
	const fresh: WatchEvent[] = [];
	const current = new Set<string>();
	// Fingerprint observations this tick: `dir#worker#kind` → fingerprint
	// (used by the reset below — a key is forgotten on a NEW fingerprint, not
	// on a missed observation). The `dir#worker#kind` join is a Set/Map
	// IDENTITY string built and consumed only here (kinds are fixed tokens;
	// worker names cannot contain "#"), never parsed back.
	const observedFingerprints = new Map<string, string>();
	// Workers present in THIS tick's snapshot: `dir#worker`.
	const presentWorkers = new Set<string>();
	for (const w of snap.workers) {
		presentWorkers.add(`${w.dir}#${w.name}`);
		for (const e of detectWorkerEvents(w, tickOpts)) {
			const parsed: DeliveryKey = {
				dir: e.dir,
				worker: e.worker,
				kind: e.kind,
				fingerprint: e.fingerprint ?? "",
			};
			const key = eventKey(e);
			current.add(key);
			observedFingerprints.set(`${e.dir}#${e.worker}#${e.kind}`, parsed.fingerprint);
			if (!seen.has(key)) {
				seen.set(key, parsed);
				fresh.push(e);
			}
		}
	}
	// State reset: forget every key not observed true THIS tick, EXCEPT keys
	// of workers still present whose fingerprint has not changed (see the
	// contract above). Keys of vanished workers are dropped too, and `seen`
	// cannot grow without bound: a key is bounded by one per worker+kind and
	// is replaced on a new fingerprint; the 24 h lookback
	// (WATCH_LOOKBACK_MS) drops vanished workers. Manifest writes are atomic
	// (exchange.ts atomicWriteFileSync), so a vanished worker is a real
	// removal, not a half-written read.
	for (const [key, parsed] of [...seen]) {
		if (current.has(key)) continue;
		const workerGone = !presentWorkers.has(`${parsed.dir}#${parsed.worker}`);
		const currentFp = observedFingerprints.get(`${parsed.dir}#${parsed.worker}#${parsed.kind}`);
		// BUG_FIX_CONTEXT: symptom — duplicate [report-ready] wake-ups for a
		// report whose mtime never changed (field: two deliveries, same
		// fingerprint; diag-watch-crossfleet case C5). Root cause — the old
		// reset deleted every key not observed true this tick, so ONE tick
		// with a missed observation (transient ENOENT on the report;
		// fileMtimeMs → null suppresses the event) FORGOT the fingerprinted
		// key and the restored file re-fired. Missed observation was treated
		// as condition reset. What was done: keys survive a no-observation
		// tick of a still-present worker; they are forgotten only on
		// worker-vanished or a different fingerprint. Watcher stage B: the
		// same rule now covers ALL kinds (episode fingerprints), and the
		// loop reads the parsed DeliveryKey structure instead of re-splitting
		// the key string (a task-dir path may contain any separator).
		if (!workerGone && (currentFp === undefined || currentFp === parsed.fingerprint)) continue;
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
// close stamp (retiredAt) persist in the watcher's satellite file (watch-
// <key>.json in the task dir — single writer per file; readers merge the
// manifest's legacy layer with all satellite layers), never in memory only.
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

/**
 * Migration stage 3 (audit steps 6/10): the watcher's stamps leave the
 * manifest — they are written to THIS watcher's satellite file
 * (watch-<watcherKey>.json in the task dir; key = FNV-1a of the watcher's
 * session JSONL path). BUG_FIX_CONTEXT (lost-update class, audit §3.2 item 3):
 * symptom — a watcher stamp (manifestStore.update) racing a concurrent
 * owner-side manifest write (spawn append / collect stamp) could silently
 * drop one side's fields (read-modify-write over the whole manifest from two
 * processes). Why the old solution did not work: the manifest is the
 * SPAWNING session's artifact, and every mounted watcher was a second writer.
 * What was done: each watcher session owns exactly one satellite file per
 * task dir (single writer per file — the lost update is impossible by
 * construction); readers (workersFromManifests, fleet's buildWorkerView)
 * merge the manifest layer with all satellite layers, earliest stamp wins.
 * The lifecycle reducer still adjudicates legality: it is fed the manifest
 * entry MERGED with the effective (snapshot) stamps — the same state the
 * retire decisions were made from — and only the verdict's stamp fields are
 * written to the satellite; the manifest entry is never modified here.
 * A degraded self-id (no session file) falls back to the shared "anon"
 * satellite — strictly no worse than the old shared-manifest race.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - w: the watched worker (its retirableSince/retiredAt are the MERGED
 *     effective stamps the snapshot computed)
 *   - stamp: the lifecycle stamp adapter (pure validate-then-patch)
 *   - what: short label for the refusal log line
 *   - watcherKey: this watcher's satellite key
 * Output: resolves when the (possibly refused/skipped) stamp attempt settled
 * Guarantees:
 *   - an illegal stamp NEVER corrupts anything (refusal → logged, no write)
 *   - the manifest is NEVER written by the watcher
 *   - a vanished worker (manifest read after the snapshot) → no-op
 *   - idempotent: an unchanged satellite layer costs no IO
 * Raises:
 *   - propagates filesystem errors (the retire pass treats them as advisory
 *     tick failures and retries next tick)
 */
async function stampWorkerViaSatellite(
	w: WatchWorker,
	stamp: (x: ExchangeManifest["workers"][number]) =>
		| { ok: true; entry: ExchangeManifest["workers"][number] }
		| { ok: false; error: string },
	what: string,
	log: (m: string) => void,
	watcherKey: string,
): Promise<void> {
	const manifest = manifestStore.read(w.dir);
	const entry = manifest?.workers.find((x) => x.name === w.name);
	if (!entry) return; // worker vanished between snapshot and stamp — nothing to stamp
	// Validate against the MERGED state (manifest layer + satellite layers).
	const synthetic = {
		...entry,
		...(w.retirableSince !== undefined ? { retirableSince: w.retirableSince } : {}),
		...(w.retiredAt !== undefined ? { retiredAt: w.retiredAt } : {}),
	} as ExchangeManifest["workers"][number];
	const r = stamp(synthetic);
	if (!r.ok) {
		log(`retire stamp refused (${what}) for worker ${w.name}: ${r.error}`);
		return; // advisory — the pass re-evaluates next tick
	}
	const pickStamp = (v: unknown): string | undefined =>
		typeof v === "string" && v.length > 0 ? v : undefined;
	await updateWatchStamps(w.dir, watcherKey, w.name, {
		retirableSince: pickStamp(r.entry.retirableSince),
		retiredAt: pickStamp(r.entry.retiredAt),
	});
}

/**
 * Migration stage 1 (extensibility-defect 1): the regex helper is GONE — the
 * seam's teardown result carries the structured `alreadyGone` field and the
 * callers read the FIELD, never the message text. History note (kept for the
 * record): this module used to hold TWO copies of the "not found" message
 * regex (one here, one in the herdr adapter) that had to be kept in sync by
 * hand; the structured field removes the class of bug.
 */

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
	// NO-OP — panes never close, no retirableSince is ever stamped (manifest
	// or satellite), and
	// behavior is byte-identical to pre-§23. evaluateRetire stays pure; the
	// gate lives here (and in the mailbox release action).
	const enabled = opts.retireEnabled ?? resolveWatchConfig().retire;
	if (!enabled) return [];
	const nowMs = opts.nowMs ?? Date.now();
	// Satellite key for THIS watcher (undefined self-id → shared "anon" — the
	// degraded corner keeps persisting stamps, just as the shared manifest did).
	const watcherKey = watcherKeyFor(opts.selfSessionFile);
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
				// Migration stage 2: the stamp goes through the lifecycle reducer.
				await stampWorkerViaSatellite(
					w,
					(x) => stampRetireClockStart(x, new Date(nowMs).toISOString()),
					"retire clock start",
					log,
					watcherKey,
				);
				continue;
			}
			if (!outcome.retirable && w.retirableSince !== undefined) {
				// The state broke (new question, report rewritten bad, back to
				// working…) — clear the clock; the next retirable transition
				// restarts the TTL from that moment. Migration stage 2: reducer-
				// validated (a clock clear is refused when no clock runs).
				await stampWorkerViaSatellite(w, (x) => stampRetireClockClear(x), "retire clock clear", log, watcherKey);
				continue;
			}
			if (outcome.decision) {
				let alreadyGone = false;
				try {
					// Migration stage 1 (extensibility-defect 1): an ALREADY-GONE
					// placement closes as { alreadyGone: true } — an idempotent retire,
					// read from the structured field (before this: a thrown "not found"
					// error matched by message regex).
					const res = await transport.teardown({ name: w.name, placement: w.placement, force: true });
					alreadyGone = res?.alreadyGone === true;
				} catch (err) {
					// BUG_FIX_CONTEXT: symptom — the retire pass spammed "retire pass
					// error … tab_not_found" every tick when the pane had ALREADY been
					// closed elsewhere (herdr, user, another session): the failed close
					// never stamped retiredAt, so the decision re-fired forever.
					// Why not fixed in the transport: teardown is also the interactive
					// /delegate-teardown path, where a genuinely misconfigured placement
					// must stay a visible error; only the autonomous pass needs the
					// idempotent semantics. What was done: the "not found" shape moved
					// INTO the transport as the structured alreadyGone result (migration
					// stage 1) — a thrown error is now ALWAYS a genuine failure and is
					// re-thrown (advisory retry next tick).
					throw err;
				}
				// Migration stage 2: the retiredAt stamp is a reducer transition
				// (closed, explicit watcher force) — an already-closed entry can
				// never be re-stamped into rewritten history.
				await stampWorkerViaSatellite(
					w,
					(x) => stampRetired(x, new Date(nowMs).toISOString()),
					"retired close stamp",
					log,
					watcherKey,
				);
				// Archive at retire (diag-retire-msg Q3 item 1): a TTL close of an
				// UNCOLLECTED report must not orphan it — without this, the report
				// survives in /tmp only as a silent artifact and every evidence path
				// into the worktree dies with the teardown. Same helper + naming as
				// the collect-path archive (basename preserved, manifest snapshot
				// rewritten in place) → idempotent by construction. Best-effort by
				// contract: a failure never blocks the close.
				try {
					const manifest = manifestStore.read(w.dir);
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

/**
 * Audit line for a REAL send (guideline §9.1, DESIGN.md §21 delivery).
 * <p>
 * The durable delivery store answers "what did this audience already hear";
 * this line answers the incident question the store cannot: WHAT EXACTLY was
 * considered delivered at what moment — the recovery trail after a send pi
 * may have swallowed asynchronously. One line per BATCH (not per event — the
 * watcher log already carries a lot of service noise, §9.1 forbids spamming
 * it). The line states the send FACT and the batch CONTENT: for every event
 * its task dir, worker name, event kind and fingerprint — the same four
 * components the dedup key is built from, so a post-incident reader can
 * re-derive exactly which key was committed.
 * <p>
 * The word "sent" (never "fail"/"error") is deliberate: the production sink
 * (makeWatcherLogSink) surfaces only error-shaped lines to the pane, so a
 * routine success lands in the audit FILE only — §9.1 ("routine success
 * deliver must not spam the TUI; the audit file — yes").
 * <p>
 * FUNCTION_CONTRACT:
 * Input: events — the events of one batch that was really sent (silent mode
 *   and a failed send have their own lines and never reach this formatter)
 * Output: one line, e.g.
 *   `wake-up sent: 2 event(s) — /tmp/exchange/x :: w1/report-ready#1726..., /tmp/exchange/x :: w2/report-ready#1726...`
 * Guarantees: pure formatting; no I/O; one line per batch regardless of how
 *   many task dirs the batch spans; an event without a fingerprint renders an
 *   empty `#` (the same empty component the dedup key uses)
 * Raises: never
 */
export function formatWakeUpAuditLine(events: WatchEvent[]): string {
	const content = events.map((e) => `${e.dir} :: ${e.worker}/${e.kind}#${e.fingerprint ?? ""}`).join(", ");
	return `wake-up sent: ${events.length} event(s) — ${content}`;
}

// ---------------------------------------------------------------------------
// Watcher loop
// ---------------------------------------------------------------------------

export interface WatcherDeps {
	transport: Transport;
	/** Delivery sink — pi.sendUserMessage(..., {deliverAs:"followUp"}) in
	 *  production (makeSender), injectable in tests. Throws are swallowed by
	 *  the loop. Watcher stage B internal contract: the sink REPORTS its
	 *  outcome — a SendOutcome ({delivered, mode}); a legacy injectable sink
	 *  that returns void is treated as a real send (delivered, mode
	 *  "sent"). The durable commit happens ONLY for a real send. */
	send: (text: string) => SendOutcome | void | Promise<SendOutcome | void>;
	intervalMs?: number;
	self?: SelfIdentity;
	detect?: DetectOptions;
	/** Watcher stage B (default TRUE — watch.durableDelivery): commit
	 *  delivered-facts records to the durable per-task store after a
	 *  successful send, so the dedup survives a session restart. false is
	 *  the emergency rollback to memory-only dedup. */
	durableDelivery?: boolean;
	/** Injectable durable-commit seam (tests): defaults to
	 *  appendDeliveredRecords in exchange.ts (one atomic merge per task
	 *  dir). A rejection is NOT a failed delivery — memory keys stay, an
	 *  audit line notes the possible post-restart repeat. */
	commitDelivery?: (
		dir: string,
		entries: ReadonlyArray<{ worker: string; kind: string; fingerprint: string }>,
	) => Promise<void>;
	/** Snapshot source override (tests drive fixtures; production uses
	 *  collectSnapshot over manifestStore.scan() + the injected transport). */
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
 * <p>
 * FUNCTION_CONTRACT (the tick, guideline §5.3 — exact order):
 *   1. snapshot; 2. retire pass (before delivery); 3. detection with the
 *   memory cache; 4. self-event filter + leaf-worker check BEFORE any
 *   durable write (a leaf worker never writes to disk); 5. canonical keys
 *   for the batch; 6. keys already in the durable store are dropped (they
 *   STAY in memory and are never rolled back); 7. an empty batch ends the
 *   tick silently; 8. ONE send; 9. only on a successful send — an atomic
 *   records write per task dir (a batch may span dirs: atomicity holds
 *   within each dir, a partial commit between dirs is possible and
 *   documented); 10. a failed send → nothing on disk, the batch's memory
 *   keys roll back. A failed durable WRITE is not a failed delivery:
 *   memory keys stay (a rollback would re-fire the batch EVERY tick —
 *   endless retry noise), an audit line notes the possible repeat after a
 *   restart. Silent mode (no pi.sendUserMessage) → no disk write, memory
 *   keys stay. Garbage collection: records of a worker that really
 *   vanished from the manifests are removed from this audience's store.
 */
export function createWatcher(deps: WatcherDeps): WatcherHandle {
	const seen = new Map<string, DeliveryKey>();
	const log = deps.log ?? ((m: string) => console.error(`[pi-delegate watch] ${m}`));
	let stopped = false;
	// Watcher stage B: the audience key of THIS mount — the durable store
	// file name component (delivered-<watcherKey>.json). A degraded self-id
	// degrades to the shared "anon" file (strictly no worse than the old
	// shared-manifest stamps).
	const watcherKey = watcherKeyFor(deps.self?.sessionFile);
	const audienceSessionPath = deps.self?.sessionFile ?? "";
	const durableEnabled = deps.durableDelivery !== false;
	const commit = deps.commitDelivery;
	// Content cache of this audience's store files, keyed by task dir, kept
	// fresh by the file's mtime: a tick re-reads a dir's store only when its
	// mtime moved (or the cache was invalidated by this mount's own write).
	// A negative mtime means "no file yet" and is cached too.
	const storeCache = new Map<string, { mtimeMs: number; records: Record<string, DeliveryRecord> }>();
	// Garbage-collection candidates: (dir, worker) pairs THIS mount has
	// committed records for. A worker that disappears from the snapshots is
	// really gone (manifest writes are atomic) → its records are collected.
	const gcCandidates = new Map<string, { dir: string; worker: string }>();
	// v1.11.x ownership, watcher stage A: the live self identity (the session
	// this watcher is mounted in) wins over an injected option; both absent →
	// FAIL-CLOSED: the watcher delivers nothing (every worker skips with the
	// "no-self-id" reason, audited below) — a mounted watcher without a proven
	// identity never wakes anyone. The legacyFailOpen flag (if injected) only
	// ever touches the no-owner edge — the verdict helper enforces that.
	const detectOpts: DetectOptions = {
		...(deps.detect ?? {}),
		selfSessionFile: deps.self?.sessionFile ?? deps.detect?.selfSessionFile,
		onSkip:
			deps.detect?.onSkip ??
			((worker, reason, detail) =>
				log(
					reason === "no-owner"
						? `skipped delivery worker=${worker} — no owner (legacy manifest; watch.legacyFailOpen is false)`
						: reason === "corrupt-question"
							? `result-plane worker=${worker} — corrupt q-file: ${detail ?? "unreadable"} (guideline §6.2.5: audited, not masked as a report event)`
							: `skipped delivery worker=${worker} — no self id (E_WATCH_NO_SELF_ID)`,
				)),
	};

	/** THIS audience's committed records for one task dir — mtime-cached. */
	const storeRecordsFor = (dir: string): Record<string, DeliveryRecord> => {
		let mtimeMs = -1;
		try {
			mtimeMs = statSync(deliveredStorePathFor(dir, watcherKey)).mtimeMs;
		} catch {
			// no store file yet
		}
		const cached = storeCache.get(dir);
		if (cached && cached.mtimeMs === mtimeMs) return cached.records;
		const records = readDeliveredStore(dir, watcherKey).records;
		storeCache.set(dir, { mtimeMs, records });
		return records;
	};

	/** Garbage collection over the store: a worker this mount committed
	 *  records for that is absent from the current snapshot is REALLY gone
	 *  (manifest writes are atomic) → remove its records from this
	 *  audience's file. Advisory: any failure is logged and retried next
	 *  tick — it can never affect a delivery. */
	const garbageCollect = async (snap: WatchSnapshot): Promise<void> => {
		const liveNow = new Set(snap.workers.map((w) => `${w.dir}#${w.name}`));
		for (const [id, { dir, worker }] of [...gcCandidates]) {
			if (liveNow.has(id)) continue;
			gcCandidates.delete(id);
			try {
				await deleteWorkerDeliveryRecords(dir, watcherKey, worker);
				storeCache.delete(dir); // own write → drop the cached content
				log(`collected delivery records of the vanished worker ${worker} (${dir})`);
			} catch (err) {
				log(`delivery-record garbage collection failed for ${worker} (${dir}) (${errText(err)}) — advisory, retried next tick`);
			}
		}
	};

	const tick = async (): Promise<WatchEvent[]> => {
		if (stopped) return [];
		let events: WatchEvent[];
		let leafWorker = false;
		let snapOrNull: WatchSnapshot | null = null;
		try {
			snapOrNull = deps.snapshot ? await deps.snapshot() : await collectSnapshot(deps.transport, deps.self ?? {});
			const snap = snapOrNull;
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
			// fleet is someone else's. Stage C fix: `self` is matched by the
			// entry's own sessionPath only (workersFromManifests), so the
			// suppression can no longer be triggered by a cwd/checkoutPath
			// coincidence with a historical entry. F6 exception: a worktree
			// worker that OWNS child manifests (a tier-1 worker-orchestrator)
			// keeps its watcher — its own children fire (their
			// orchestratorSessionPath equals its session file) while its
			// PARENT's manifest stays silenced by the detectWorkerEvents
			// ownership gate, so F1 scoping is intact.
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
		// Garbage collection of vanished workers — before the delivery path,
		// so a gone worker's records leave the store even on a quiet tick.
		if (durableEnabled && snapOrNull !== null) await garbageCollect(snapOrNull);
		if (leafWorker || events.length === 0) return [];
		// Watcher stage B, §5.3 step 6: drop events whose delivery key is
		// already committed to THIS audience's durable store (e.g. after a
		// session restart, where the memory cache starts empty). Dropped keys
		// STAY in memory and are never rolled back.
		if (durableEnabled) {
			const committedRecordsByDir = new Map<string, Record<string, DeliveryRecord>>();
			events = events.filter((e) => {
				let records = committedRecordsByDir.get(e.dir);
				if (records === undefined) {
					records = storeRecordsFor(e.dir);
					committedRecordsByDir.set(e.dir, records);
				}
				return records[deliveryRecordKey(e.worker, e.kind, e.fingerprint ?? "")] === undefined;
			});
		}
		if (events.length === 0) return [];
		// ONE send per batch, INSIDE the error guard, its outcome AWAITED (the
		// pre-stage-B code ignored the returned value — a silent no-op sender
		// was indistinguishable from success, and a future async failure would
		// have gone unnoticed).
		// Wave 2 (audit B4, accept-then-log): the outcome is CLASSIFIED — a
		// sink error tagged deliveredBeforeThrow (markDeliveredBeforeThrow)
		// means the wake was already queued by pi when a LATER sink step threw;
		// the batch counts as DELIVERED (keys stay, durable record commits, no
		// re-fire). Only a genuine PRE-delivery failure rolls the keys back.
		let delivered: boolean;
		try {
			const outcome = await deps.send(formatEventBatch(events));
			delivered = outcome === undefined || outcome.delivered === true;
		} catch (err) {
			if (isDeliveredBeforeThrow(err)) {
				// BUG_FIX_CONTEXT: symptom — a wake pi had already queued could be
				// re-fired on the next tick (the old tick treated ANY sink throw as
				// "not delivered" and rolled the batch's dedup keys back), so an
				// accepted-then-thrown delivery arrived twice. Why the old solution
				// did not work: the rollback path had no notion of WHERE in the
				// sink the throw happened. What was done: sinks tag post-acceptance
				// throws with markDeliveredBeforeThrow; the tick counts those as
				// delivered. Genuine pre-delivery failures (pi threw before
				// accepting) keep the rollback + re-fire behavior (W9.13 pins it).
				delivered = true;
				log(`delivery sink threw AFTER queuing the wake (${errText(err)}) — counted as delivered (accept-then-log), no re-fire`);
			} else {
				// BUG_FIX_CONTEXT: symptom — one failed send during a transient
				// delivery outage permanently silenced that wake-up (the `seen` key was
				// already recorded). Why the old behavior did not work: keys were added
				// before delivery, with no rollback path. What was done: on send failure
				// the batch's keys are deleted from `seen`, so the event re-fires on the
				// next tick while its condition still holds.
				// Delivery failed: roll the batch's keys back out of `seen`, or a single
				// transient send error would permanently swallow the wake-up. Nothing is
				// written to the durable store (a commit would claim a delivery that
				// did not happen). Still advisory, never a queue: nothing is buffered,
				// and an event whose condition already reset is simply gone.
				for (const e of events) seen.delete(eventKey(e));
				log(`delivery failed (${errText(err)}) — batch rolled back, durable store untouched, re-fires while still true (advisory)`);
				return events;
			}
		}
		if (!delivered) {
			log("delivery sink is silent (no usable pi.sendUserMessage) — wake-up suppressed in memory, nothing committed to the durable store");
			return events;
		}
		// Guideline §9.1 / DESIGN.md §21 delivery: every REAL send is recorded as
		// ONE audit line per batch with the batch content (dir :: worker/kind#fp
		// per event) — the recovery trail after an incident. Written at the send
		// SUCCESS, before the durable commit: the line describes the FACT OF
		// SENDING, so a later commit failure must not hide it (the commit-failure
		// line below then names the same batch). Silent mode and a failed send
		// returned above with their own lines — never a third line here.
		log(formatWakeUpAuditLine(events));
		// §5.3 step 9 — commit AFTER the successful send, one atomic merge per
		// task dir (a batch may span dirs: atomicity holds WITHIN each dir's
		// file; a partial commit between dirs is possible and documented). A
		// failed commit is NOT a failed delivery: the send happened, so the
		// memory keys STAY (a rollback would re-fire the whole batch EVERY
		// tick while the store is unwritable — endless retry noise, worse than
		// one possible repeat after a restart); the audit line notes it.
		if (durableEnabled) {
			const byDir = new Map<string, Array<{ worker: string; kind: string; fingerprint: string }>>();
			for (const e of events) {
				const list = byDir.get(e.dir) ?? [];
				list.push({ worker: e.worker, kind: e.kind, fingerprint: e.fingerprint ?? "" });
				byDir.set(e.dir, list);
			}
			for (const [dir, entries] of byDir) {
				try {
					if (commit) {
						await commit(dir, entries);
					} else {
						// EXTERNAL_DEPENDENCY: the delivered-facts file
						// delivered-<watcherKey>.json in the task dir (exchange.ts I/O).
						await appendDeliveredRecords(dir, watcherKey, audienceSessionPath, entries, new Date().toISOString(), "sent");
					}
					storeCache.delete(dir); // own write → the cached content is stale
					for (const e of entries) gcCandidates.set(`${dir}#${e.worker}`, { dir, worker: e.worker });
				} catch (err) {
					log(
						`durable delivery record not written for ${dir} (${errText(err)}) — ` +
							"the wake-up WAS sent; the same fact may repeat after a session restart (advisory)",
					);
				}
			}
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
// Lifecycle registry (Wave 2, Law 3): KEYED mounts live in a globalThis
// registry by session file — module copies loaded twice still share
// globalThis, so a double module load cannot silently start a second watcher
// for the same session (audit D2): the second mount is REFUSED and the first
// instance's stop handle is returned. The module-global activeStop survives
// ONLY as the fallback for mounts whose session identity is unknown
// (sessionFile undefined — cannot be keyed); those keep the legacy
// double-start-replaces semantics, scoped to anonymous mounts only.
// ---------------------------------------------------------------------------

let activeStop: (() => void) | null = null;

/** globalThis slot of the per-session watcher mount registry (survives a
 *  double module load — two copies of this module share one globalThis). */
const WATCHER_MOUNT_REGISTRY_KEY = "__piDelegateWatcherMounts";

/**
 * The per-session watcher mount registry (Wave 2, Law 3).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: the process-wide Map<sessionFile, stopHandle> — created lazily on
 *   globalThis so every module copy sees the SAME registry
 * Guarantees:
 *   - a corrupted/non-Map slot is replaced with a fresh Map (defensive)
 * Raises: never
 */
function watcherMountRegistry(): Map<string, () => void> {
	const g = globalThis as unknown as Record<string, unknown>;
	const existing = g[WATCHER_MOUNT_REGISTRY_KEY];
	if (existing instanceof Map) return existing as Map<string, () => void>;
	const fresh = new Map<string, () => void>();
	g[WATCHER_MOUNT_REGISTRY_KEY] = fresh;
	return fresh;
}

/** Stop the running anonymous watcher (idempotent, safe when nothing is
 *  running). DEPRECATED fallback kept for compatibility: production code
 *  tears watchers down through the per-session stop handles (Law 3) — the
 *  module-global registry is no longer the shutdown path. */
export function stopWatcher(): void {
	const s = activeStop;
	activeStop = null;
	try {
		s?.();
	} catch {
		// stop is advisory — never throw past session_shutdown
	}
}

/** Structured send outcome (watcher stage B, guideline §5): the INTERNAL
 *  contract of the delivery sink. `mode: "silent"` means the build has no
 *  usable `pi.sendUserMessage` (headless/old pi) — the tick treats it as
 *  "not a delivery": nothing is committed to the durable store and the
 *  memory keys are not rolled back (the existing "headless watcher is
 *  silent but unbroken" contract). Full delivery CONFIRMATION would require
 *  changes on the pi side (out of scope for stage B) — every real send is
 *  additionally recorded in the watcher audit log with the batch content,
 *  which is the recovery trail if pi ever swallows a send asynchronously. */
export interface SendOutcome {
	delivered: boolean;
	mode: "sent" | "silent";
}

/** Error-marker key for the accept-then-log contract (Wave 2, audit B4):
 *  a delivery sink that had ALREADY handed the wake to pi when a LATER step
 *  threw tags the error with this property (markDeliveredBeforeThrow) — the
 *  tick then counts the batch as DELIVERED (keys stay, durable record
 *  commits, no re-fire) instead of rolling it back. */
const DELIVERED_BEFORE_THROW = "deliveredBeforeThrow";

/**
 * Tag an error as "the wake was already queued by pi when a later sink step
 * threw" (accept-then-log, Wave 2 audit B4).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: the error a sink wants to report AFTER it has queued the send
 * Output: the (Error-coerced) error, tagged with the deliveredBeforeThrow
 *   marker the tick's send-outcome classification reads
 * Guarantees:
 *   - non-Error values are wrapped into an Error (the message is preserved)
 *   - the tick counts a batch whose send threw a tagged error as DELIVERED:
 *     dedup keys stay, the durable record commits, no re-fire next tick —
 *     a rollback would re-fire a wake pi already queued (the B4 bug class)
 * Raises: never
 */
export function markDeliveredBeforeThrow(err: unknown): Error {
	const e = err instanceof Error ? err : new Error(String(err));
	(e as Error & Record<string, unknown>)[DELIVERED_BEFORE_THROW] = true;
	return e;
}

/** The read side of the marker (see markDeliveredBeforeThrow). */
function isDeliveredBeforeThrow(err: unknown): boolean {
	return (err as Record<string, unknown> | null | undefined)?.[DELIVERED_BEFORE_THROW] === true;
}

/**
 * Delivery sink builder (§21). Guarded by design: a build without
 * `sendUserMessage` (headless/old pi) returns a SILENT outcome (mode
 * "silent", delivered false) — the watcher stays inert instead of throwing
 * on every tick, and the tick knows NOT to commit a durable record for a
 * send that never happened. `deliverAs: "followUp"` is what makes it a
 * wake-up that never interrupts a turn in flight.
 */
export function makeSender(
	pi: { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown },
): (text: string) => SendOutcome {
	return (text: string): SendOutcome => {
		if (typeof pi.sendUserMessage !== "function") return { delivered: false, mode: "silent" };
		// Wave 2 (audit B4, accept-then-log): THIS call is the ACCEPTANCE POINT.
		// A throw from it is a genuine PRE-delivery failure (pi never accepted —
		// in practice only assertActive-style refusals; the runtime binding is
		// fire-and-forget and reports async errors itself) — it propagates so
		// the tick classifies the batch as not-delivered, rolls the dedup keys
		// back and re-fires while the condition holds (preserved behavior).
		// Everything AFTER this point in a sink is POST-acceptance: once pi has
		// queued the wake, the delivery is a FACT — a later step's failure must
		// never flip the outcome back to not-delivered (the tick would roll the
		// keys back and re-fire an already-queued wake). A richer custom sink
		// with post-acceptance steps therefore catches its own later failures
		// and either returns the delivered outcome or rethrows the error tagged
		// with markDeliveredBeforeThrow(err) — the tick reads that marker.
		pi.sendUserMessage(text, { deliverAs: "followUp" });
		return { delivered: true, mode: "sent" };
	};
}

/**
 * The production watcher log sink (UX fix, 2026-09-10), extracted for
 * behavioral testing (migration stage 3, audit step 10 — replaces the
 * static-check source-text pins T4.1/T4.2): every line goes to the audit
 * file (append-only, best-effort); the pane shows ONLY lines that need a
 * human — errors and anomalies ("already gone" — the pane vanished before
 * the TTL close, the agent may still be alive detached; see
 * resolveLiveTabId's drift guard).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none (EXTERNAL_DEPENDENCY below)
 * Output: the sink (m) => void used by startWatcher
 * Guarantees:
 *   - every line is appended to ~/.pi/agent/delegate-watch.log with an ISO
 *     timestamp prefix; append failures are swallowed (advisory)
 *   - lines matching /\berror\b|\bfail|already gone|unavailable/i are ALSO
 *     surfaced to the pane via console.error with the [pi-delegate watch]
 *     prefix; routine bookkeeping never reaches the pane
 * Raises: never
 * EXTERNAL_DEPENDENCY: ~/.pi/agent/delegate-watch.log (append-only audit
 *   file under $HOME); os.homedir() is cached by bun — tests must set $HOME
 *   at child-process spawn time or redirect before the first call.
 */
export function makeWatcherLogSink(): (m: string) => void {
	return (m: string): void => {
		void appendFile(
			join(homedir(), ".pi", "agent", "delegate-watch.log"),
			`${new Date().toISOString()} ${m}\n`,
		).catch(() => undefined); // audit is advisory — never throw past the tick
		if (/\berror\b|\bfail|already gone|unavailable/i.test(m)) {
			console.error(`[pi-delegate watch] ${m}`);
		}
	};
}

/**
 * Start the watcher for this session (DESIGN.md §21: headless-safe — NO
 * ctx.hasUI guard). Returns the dispose fn.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - pi: the extension API (delivery sink via makeSender)
 *   - transport: the injected WorkerHost seam
 *   - ctx.cwd / ctx.sessionManager: the session identity (sessionFile read
 *     tolerantly — a throwing getter degrades to undefined, the mount lives)
 * Output: the stop handle for THIS mount. For an already-mounted session file
 *   the handle of the FIRST (still running) instance.
 * Guarantees:
 *   - Wave 2 (Law 3, audit D2): mounts are keyed by session file in a
 *     globalThis registry (shared across module copies). A second mount for
 *     an ALREADY-MOUNTED session file is REFUSED — logged, first instance
 *     kept, no second interval started; the first instance's stop handle is
 *     returned so the caller stays handle-complete.
 *   - a mount with an UNKNOWN session file (degraded identity) cannot be
 *     keyed — it keeps the legacy double-start-replaces semantics, scoped to
 *     anonymous mounts only (module-global activeStop fallback).
 *   - the returned stop handle is idempotent and unregisters the mount from
 *     the registry when it is still the current entry.
 * Raises: never (all failures are advisory by §21)
 */
export function startWatcher(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	transport: Transport,
	ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } },
): () => void {
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.();
	} catch {
		sessionFile = undefined; // self-identification degrades, watcher lives
	}
	// Wave 2 (Law 3, audit D2): a second mount for an already-mounted session
	// file is REFUSED — keep the first instance (its dedup state stays
	// authoritative; two live watchers for one session would deliver every
	// wake twice — the double-delivery bug class this closes).
	if (sessionFile !== undefined) {
		const existing = watcherMountRegistry().get(sessionFile);
		if (existing) {
			console.error(
				`[pi-delegate watch] second watcher mount refused for session ${sessionFile} — already mounted ` +
					"(double module-load guard, Law 3); keeping the first instance",
			);
			return existing;
		}
	} else {
		// Unknown identity: not keyable — legacy replace among anonymous mounts
		// only (never touches a keyed session's watcher).
		stopWatcher();
	}
	const cfg = resolveWatchConfig();
	const handle = createWatcher({
		transport,
		intervalMs: cfg.intervalMs,
		self: { sessionFile, cwd: ctx.cwd },
		send: makeSender(pi),
		// Watcher log sink (UX fix, 2026-09-10) — extracted to makeWatcherLogSink
		// (behaviorally tested; see that function's contract).
		log: makeWatcherLogSink(),
		// v1.12.1: the worker-stale threshold threads from watch.staleAfterMs
		// (deps.detect can still override per-mount, e.g. in tests).
		// §23: the retire TTL threads the same way.
		// Watcher stage A: the legacy fail-open rollback threads from
		// watch.legacyFailOpen (default false — fail-closed delivery).
		// Watcher stage B: the durable delivered-facts store switch threads
		// from watch.durableDelivery (default true — commit after send).
		detect: {
			staleAfterMs: cfg.staleAfterMs,
			retireTtlMs: cfg.retireTtlMs,
			legacyFailOpen: cfg.legacyFailOpen,
		},
		durableDelivery: cfg.durableDelivery,
	});
	const registry = sessionFile !== undefined ? watcherMountRegistry() : null;
	const stop = (): void => {
		handle.stop();
		if (registry && registry.get(sessionFile as string) === stop) registry.delete(sessionFile as string);
		if (activeStop === stop) activeStop = null;
	};
	if (registry) registry.set(sessionFile as string, stop);
	else activeStop = stop; // anonymous mount — legacy fallback registry only
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
		await appendFile(join(dir, TEARDOWN_LOG_NAME), teardownLogLine(line));
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
					// Migration stage 1 (extensibility-defect 1): the "already gone"
					// case is the structured alreadyGone field on the RESULT (before
					// this: a thrown error matched by the isAlreadyGone message regex).
					const res = await transport.teardown({ name: v.name, placement: v.placement, force: true });
					if (res?.alreadyGone) {
						await logTo(v.dir, `done: teardown worker=${v.name} no-op (already gone)`);
						outcomes.push(`✓ ${v.name} (${v.kind}) — already closed, no-op`);
						continue;
					}
					await logTo(v.dir, `done: teardown worker=${v.name} ok`);
					outcomes.push(`✓ ${v.name} (${v.kind}) torn down`);
				} catch (err) {
					// A throw is now ALWAYS a genuine failure (not-found shapes resolve
					// as alreadyGone inside the adapters) — parity with the retire pass.
					await logTo(v.dir, `error: teardown worker=${v.name} failed: ${errText(err)}`);
					const de = asDelegateError(err);
					const advice = de?.guidance
						? ` — ${de.guidance}`
						// No structured guidance: fall back to the generic recovery recipe.
						// Migration stage 3 (audit step 9): no herdr token in the hint —
						// the wt-directory refusal itself is the structured E_PLACE signal
						// raised at the segment boundary (expaths.isDirUnder, Windows fix);
						// backend-specific CLI tokens never reach the model-facing text.
						: " — reconcile via /delegate-teardown; for a worktree-link failure, recover via the host workspace listing/close.";
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
