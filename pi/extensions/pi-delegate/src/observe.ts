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
// Wave 3 decomposition (step 4): the `delegate_status` tool moved verbatim to
// src/status-tool.ts — re-exported so existing import sites keep resolving.
export { formatFleetUsageLine, registerStatusTool } from "./status-tool.ts";
// Wave 3 decomposition (step 5): the /delegate-fleet + /delegate-teardown
// commands moved verbatim to src/commands.ts — re-exported so existing
// import sites (index.ts, static-check) keep resolving.
export { registerCommands } from "./commands.ts";


