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
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { aggregateTaskUsage, exchangeRoot } from "./exchange.ts";
import { archiveReport, archiveRoot, listArchivedTasks } from "./archive.ts";
import { type TaskUsageSnapshot } from "./manifest-store.ts";
import {
	appendDeliveredRecords,
	deleteWorkerDeliveryRecords,
	deliveryRecordKey,
	deliveredStorePathFor,
	readDeliveredStore,
} from "./watch-store.ts";
import {
	answerPathFor,
	nudgeFailedPathFor,
	questionPathFor,
	readNudgeFailedMarker,
	readQuestion,
	readQuestionState,
	releasePathFor,
} from "./mailbox-store.ts";
import { TEARDOWN_LOG_NAME } from "./expaths.ts";
import { parseBriefSchema, validateReport, validateReportAgainstSchema } from "./report-schema.ts";
import {
	isProbeDir,
	progressPathFor,
	readLastProgress,
	teardownLogLine,
} from "./exchange.ts";
import { manifestStore, type ExchangeManifest } from "./manifest-store.ts";
import {
	mergeRetireStamps,
	readWatchStampLayers,
	updateWatchStamps,
	watcherKeyFor,
	type DeliveryRecord,
	type RetireStamps,
} from "./watch-store.ts";
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
 * Dependency rule (DESIGN.md §4.1): imports transport.ts, exchange.ts,
 * usage.ts and watch-config.ts only — NEVER transport/herdr.ts. The
 * Transport instance is injected from index.ts, exactly like the tools get
 * it. (Wave 3a: the watch/collect CONFIG section moved to
 * src/watch-config.ts — this module consumes it; the facade re-export
 * below keeps the observe.ts surface unchanged for the transition.)
 */

// Wave 3a transition facade (temporary, one release per the plan): the
// watch/collect config resolution moved verbatim to src/watch-config.ts —
// re-exported here so existing import sites (the check suite) keep
// resolving unchanged. New code imports from watch-config directly.
export type { CollectConfig, WatchConfig } from "./watch-config.ts";
export {
	COLLECT_DEFAULT_TEARDOWN_AFTER_COLLECT,
	DURABLE_DELIVERY_DEFAULT_ENABLED,
	RETIRE_DEFAULT_ENABLED,
	RETIRE_DEFAULT_TTL_MS,
	resolveCollectConfig,
	resolveWatchConfig,
	WATCH_DEAD_GRACE_MS,
	WATCH_DEFAULT_INTERVAL_MS,
	WATCH_DEFAULT_SETTLE_GATE_MS,
	WATCH_LOOKBACK_MS,
	WATCH_MIN_INTERVAL_MS,
	WATCH_MIN_STALE_AFTER_MS,
} from "./watch-config.ts";
import {
	WATCH_DEAD_GRACE_MS,
	WATCH_DEFAULT_INTERVAL_MS,
	WATCH_LOOKBACK_MS,
	resolveWatchConfig,
} from "./watch-config.ts";
// Transition surface: WATCH_DEFAULT_STALE_AFTER_MS was re-exported by
// observe.ts before the extraction (canonically owned by src/usage.ts) —
// keep the re-export so existing import sites keep resolving.
export { WATCH_DEFAULT_STALE_AFTER_MS } from "./watch-config.ts";

// Wave 3 decomposition (step 1): the event model + snapshot + detection moved
// verbatim to src/watch-detect.ts — observe consumes it below (and the facade
// re-export at the bottom keeps the public surface unchanged for the
// transition).
import {
	becameCollectedOnDisk,
	collectSnapshot,
	type DeliveryKey,
	detectEvents,
	type DetectOptions,
	eventKey,
	fileMtimeMs,
	type SelfIdentity,
	type WatchEvent,
	type WatchSnapshot,
	type WatchWorker,
} from "./watch-detect.ts";
import { retirePass } from "./watch-retire.ts";

// Transition re-exports (temporary, one release per the plan): the detection
// surface moved verbatim to src/watch-detect.ts — re-exported here so existing
// import sites (compose.ts, the check suite) keep resolving unchanged. New
// code imports from watch-detect directly.
export {
	becameCollectedOnDisk,
	collectSnapshot,
	detectEvents,
	detectWorkerEvents,
	eventKey,
	fileMtimeMs,
	GRILL_DECK_TOOL,
	isWorkerSession,
	ownsChildManifests,
	readStatusesTolerant,
	workersFromManifests,
	type DeliveryKey,
	type DetectOptions,
	type SelfIdentity,
	type WatchEvent,
	type WatchEventKind,
	type WatchSnapshot,
	type WatchWorker,
} from "./watch-detect.ts";

// Wave 3 decomposition (step 2): the §23 retire engine moved verbatim to
// src/watch-retire.ts — re-exported here so existing import sites (the check
// suite) keep resolving unchanged. New code imports from watch-retire
// directly.
export {
	evaluateRetire,
	mailboxDrained,
	retirePass,
	type RetireDecision,
	type RetireEval,
	type RetirePassOptions,
	type RetireReason,
} from "./watch-retire.ts";


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
		// Wave 2 (the watcher-vs-collect race): report-kind suppression reads
		// collectedAt in the TICK SNAPSHOT — a collect that stamps between the
		// snapshot and the send produced a duplicate report-ready wake for a
		// fresh session (empty memory dedup, empty durable store).
		// BUG_FIX_CONTEXT: symptom — a fresh orchestrator session received the
		// report-ready wake even though the report had just been collected. Why
		// the old solution did not work: the collectedAt check ran against the
		// snapshot taken at tick start, and the stamp landed inside the tick.
		// What was done: collectedAt is RE-READ from the manifest immediately
		// before the batch is sent; report-kind events for a worker that became
		// collected are dropped (other kinds are unaffected — collect only ever
		// means "the report was delivered"). Residual (documented): a stamp
		// landing between this re-read and the actual send still races — the
		// window is now a single atomic-rename scale, and the durable store
		// records the wake for cross-restart dedup.
		events = events.filter((e) => {
			if (e.kind !== "report-ready" && e.kind !== "report-invalid") return true;
			return !becameCollectedOnDisk(e.dir, e.worker);
		});
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
 *   file under pi's agent dir); pi's getAgentDir() (honors
 *   PI_CODING_AGENT_DIR) resolves it — os.homedir() is cached by bun —
 *   tests must set $HOME at child-process spawn time or redirect before
 *   the first call.
 */
export function makeWatcherLogSink(): (m: string) => void {
	return (m: string): void => {
		void appendFile(
			join(getAgentDir(), "delegate-watch.log"),
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
			// Headless guard (pi docs Mode Behavior, same pattern as mountFleetUI):
			// the overlay is a TUI surface and the non-TUI early return in
			// openFleetOverlay would notify into a UI that is not there.
			if (!ctx.hasUI || !ctx.ui) return; // headless → no-op
			await openFleetOverlay(ctx, { transport });
		},
	});

	pi.registerCommand("delegate-teardown", {
		description: "Confirm + sequentially tear down all delegate workers (pre-logged, never automatic)",
		async handler(_args, ctx) {
			// Headless guard (pi docs Mode Behavior): the confirm/notify dialogs
			// below need a UI, and a headless session must NOT auto-confirm a
			// destructive teardown — refuse with a text-only note instead (console
			// is the headless channel, same as the watcher sink).
			if (!ctx.hasUI || !ctx.ui) {
				console.error(
					"[pi-delegate] /delegate-teardown needs a UI session (it confirms before tearing down) — run it in the interactive session that owns the workers.",
				);
				return;
			}
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
