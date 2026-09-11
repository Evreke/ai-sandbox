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

// Wave 3 decomposition (steps 1–3): the event model + snapshot + detection
// moved verbatim to src/watch-detect.ts, the §23 retire engine to
// src/watch-retire.ts, the watcher loop/delivery/mount lifecycle to
// src/watcher.ts — re-exported here so existing import sites (compose.ts, the
// check suite) keep resolving unchanged. New code imports from the new
// modules directly.
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
export {
	createWatcher,
	formatEventBatch,
	formatWakeUpAuditLine,
	makeSender,
	makeWatcherLogSink,
	markDeliveredBeforeThrow,
	startWatcher,
	stopWatcher,
	type SendOutcome,
	type WatcherDeps,
	type WatcherHandle,
} from "./watcher.ts";
// Interim (until step 4 kills the duplicates): the /delegate-teardown command
// handler below formats errors through the same errText the watcher loop
// owns — one spelling, no third copy.
import { errText } from "./watcher.ts";



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
