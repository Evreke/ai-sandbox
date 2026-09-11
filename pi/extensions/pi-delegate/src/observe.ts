/**
 * pi-delegate — observe FACADE (Wave 3 decomposition, steps 1–5 done): this
 * module no longer owns code — it re-exports the public surface of the
 * extracted observation modules so existing import sites keep resolving
 * unchanged for ONE release, per the plan (STABILIZATION.md Wave 3 item 3;
 * ARCHITECTURE.md Law 5). After the release window the remaining import
 * sites (index.ts, compose.ts today; the check suite pins) flip to the new
 * modules directly and this file retires.
 *
 * Where everything lives now:
 *   - watch-config.ts  — the tolerant watch/collect config resolution
 *     (Wave 3a; kills the spawn→observe dependency edge, Law 6 pin).
 *   - watch-detect.ts  — the event model + snapshot building + detection
 *     (WatchEventKind/WatchEvent/DeliveryKey/eventKey, WatchWorker/
 *     WatchSnapshot, SelfIdentity, isWorkerSession, ownsChildManifests,
 *     workersFromManifests, readStatusesTolerant, collectSnapshot,
 *     DetectOptions, detectWorkerEvents, detectEvents).
 *   - watch-retire.ts  — the §23 retire engine (RetireReason/RetireDecision/
 *     RetireEval, mailboxDrained, evaluateRetire, stampWorkerViaSatellite,
 *     retirePass, RetirePassOptions).
 *   - watcher.ts       — the watcher loop + delivery + mount lifecycle
 *     (WatcherDeps/WatcherHandle, createWatcher, SendOutcome, makeSender,
 *     markDeliveredBeforeThrow, makeWatcherLogSink, formatEventBatch,
 *     formatWakeUpAuditLine, startWatcher, stopWatcher + the session-keyed
 *     mount registry on globalThis — Wave 2, Law 3).
 *   - status-tool.ts   — the `delegate_status` tool (registerStatusTool +
 *     formatFleetUsageLine and its read-only helpers).
 *   - commands.ts      — /delegate-fleet + /delegate-teardown
 *     (registerCommands).
 *
 * The invariants and contracts of every piece moved verbatim with the code —
 * each extracted module's header documents its own MODULE_CONTRACT. The
 * summary of the observation layer's guarantees (kept here because the
 * facade is the entry point existing docs still name): the watcher is
 * advisory by contract (a watcher failure must NEVER affect a spawn or a
 * collect); delivery is ownership fail-closed (the ONE canonical verdict in
 * watch-role.ts); dedup memory is a cache of the durable delivered-facts
 * store; mounts are keyed by session file in a globalThis registry (a second
 * mount for an already-mounted session is refused — audit D2); retire stamps
 * persist in the per-watcher satellite file, the manifest is never written
 * by the watcher; delegate_status is read-only by contract; /delegate-*
 * command names, tool names and parameter shapes are frozen surface.
 *
 * Law 6 (layering): no src/ module may import observe.ts except the
 * composition root's slices (pin T1.8 in test/static-check.ts). New code
 * imports the extracted modules directly.
 */

// Watch/collect config resolution (Wave 3a extraction — canonical owner:
// src/watch-config.ts; the re-exports predate the facade and stay).
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
// Transition surface: WATCH_DEFAULT_STALE_AFTER_MS was re-exported by
// observe.ts before the extraction (canonically owned by src/usage.ts) —
// keep the re-export so existing import sites keep resolving.
export { WATCH_DEFAULT_STALE_AFTER_MS } from "./watch-config.ts";

// Event model + snapshot + detection (extracted from this module, Wave 3).
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

// §23 retire engine (extracted from this module, Wave 3).
export {
	evaluateRetire,
	mailboxDrained,
	retirePass,
	type RetireDecision,
	type RetireEval,
	type RetirePassOptions,
	type RetireReason,
} from "./watch-retire.ts";

// Watcher loop + delivery + mount lifecycle (extracted, Wave 3).
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

// The `delegate_status` tool (extracted, Wave 3).
export { formatFleetUsageLine, registerStatusTool } from "./status-tool.ts";

// The /delegate-fleet + /delegate-teardown commands (extracted, Wave 3).
export { registerCommands } from "./commands.ts";
