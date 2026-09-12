/**
 * pi-delegate — watcher: the event-driven background watcher LOOP + delivery
 * + the mount lifecycle registry — extracted verbatim from
 * observe.ts (Wave 3, audit Law 5: modules are responsibilities).
 * <p>
 * MODULE_CONTRACT: builds and runs the poller (createWatcher — one tick =
 * snapshot → §23 retire pass → detection → dedup → ONE wake-up send →
 * durable delivered-facts commit), the delivery text formatters, the
 * guarded delivery sink builders (makeSender, makeWatcherLogSink) and the
 * session-keyed mount lifecycle (startWatcher/stopWatcher over the
 * globalThis registry — Wave 2, Law 3).
 * Advisory by contract: a watcher failure must NEVER affect spawn or collect
 * outcomes. Every read is tolerant, every delivery is guarded — a build
 * without `sendUserMessage` (headless/old) stays inert, never throws.
 * Independent of the fleet UI: no `ctx.hasUI` guard, works headless.
 * Dependencies: watch-detect.ts (snapshot/detection/event model),
 * watch-retire.ts (§23 pass inside the tick), watch-store.ts (the durable
 * delivered-facts store + watcher key), watch-config.ts (resolved config),
 * mailbox-store.ts (the ONE steer-posting core — the report-invalid auto
 * fix nudge shares it with the delegate_mailbox tool, Law 9), host.ts (the
 * Transport seam). Never imports the transport implementation (dependency
 * rule, ARCHITECTURE.md Law 4 — the Transport instance is injected from
 * index.ts).
 * Never imports observe.ts (Law 6 pin — observe remains only a facade over
 * this module for one release).
 */

import { statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	becameCollectedOnDisk,
	collectSnapshot,
	type DeliveryKey,
	detectEvents,
	type DetectOptions,
	eventKey,
	type SelfIdentity,
	type WatchEvent,
	type WatchSnapshot,
} from "./watch-detect.ts";
import { retirePass } from "./watch-retire.ts";
import {
	appendDeliveredRecords,
	deleteWorkerDeliveryRecords,
	deliveryRecordKey,
	deliveredStorePathFor,
	readDeliveredStore,
	type DeliveryRecord,
	watcherKeyFor,
	type StampLayerCacheEntry,
} from "./watch-store.ts";
import { WATCH_DEFAULT_INTERVAL_MS, resolveWatchConfig } from "./watch-config.ts";
import { sameSessionPath } from "./watch-role.ts";
// Wave 4 item 5 (reliability finding 10): per-mount caches for the tick's
// satellite reads — the caller-held closures Law 3 wants (no module globals).
import { type SessionToolCallCacheEntry } from "./usage.ts";
import { postSteerAndNudge } from "./mailbox-store.ts";
import type { Transport } from "./host.ts";

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
 * Audit line for a REAL send (watcher delivery).
 * <p>
 * The durable delivery store answers "what did this audience already hear";
 * this line answers the incident question the store cannot: WHAT EXACTLY was
 * considered delivered at what moment — the recovery trail after a send pi
 * may have swallowed asynchronously. One line per BATCH (not per event — the
 * watcher log already carries a lot of service noise — it is an audit trail,
 * never spammed). The line states the send FACT and the batch CONTENT: for every event
 * its task dir, worker name, event kind and fingerprint — the same four
 * components the dedup key is built from, so a post-incident reader can
 * re-derive exactly which key was committed.
 * <p>
 * The word "sent" (never "fail"/"error") is deliberate: the production sink
 * (makeWatcherLogSink) surfaces only error-shaped lines to the pane, so a
 * routine success lands in the audit FILE only (routine deliver must not
 * spam the TUI; the audit file — yes).
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

// Wave 3 decomposition (step 4): errText moved to src/tool-result.ts (the
// structural kill of the byte-identical copies — audit finding 7).
import { errText } from "./tool-result.ts";

/**
 * Build the poller. Never throws; every cycle is wrapped so a bad manifest, an
 * unreachable herdr or a throwing sink only costs that cycle.
 * <p>
 * FUNCTION_CONTRACT (the tick — exact order):
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
	// Wave 4 item 5 (reliability finding 10): mtime-keyed caches that keep the
	// tick cheap on large fleets — satellite stamp layers re-read only when a
	// watch-*.json (name, mtime) snapshot moved; the grill-deck session-tail
	// parse runs only when the session file's fingerprint (mtime + size)
	// moved. Same (path, mtime) pattern as storeCache above; per-mount closure
	// state (Law 3 — no module-global registries).
	const stampLayerCache = new Map<string, StampLayerCacheEntry>();
	const sessionToolCallCache = new Map<string, SessionToolCallCacheEntry>();
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
		sessionToolCallCache,
		selfSessionFile: deps.self?.sessionFile ?? deps.detect?.selfSessionFile,
		onSkip:
			deps.detect?.onSkip ??
			((worker, reason, detail) =>
				log(
					reason === "no-owner"
						? `skipped delivery worker=${worker} — no owner (legacy manifest; watch.legacyFailOpen is false)`
						: reason === "corrupt-question"
							? `result-plane worker=${worker} — corrupt q-file: ${detail ?? "unreadable"} (audited, not masked as a report event)`
							: `skipped delivery worker=${worker} — no self id (E_WATCH_NO_SELF_ID)`,
				)),
	};

	/**
 * Automatic self-heal nudge (fix-report-heal, 2026-09-12): for every
 * report-invalid event ACCEPTED for delivery whose worker is still live, post
 * a mailbox steer telling the worker to rewrite its report IN PLACE — the
 * cheap fix the guidance names, performed automatically instead of spending a
 * full re-spawn on one wrong field.
 * <p>
 * Exactly-once is inherited for free from the delivery dedup: the event's
 * fingerprint is the report's mtime, so this runs once per report VERSION —
 * a worker that rewrites and is STILL invalid gets a fresh mtime → a fresh
 * nudge; a fixed report → report-ready, no nudge. The wake itself stays
 * fail-closed: the orchestrator STILL receives the report-invalid event (the
 * nudge is a CONCURRENT self-heal, never a replacement); its message gains
 * the suffix "— an automatic fix nudge was posted to the live worker" once
 * the steer envelope is durably posted.
 * <p>
 * Placement note: this runs BEFORE the batch send so the suffix can reach the
 * wake text. If the send then fails, the batch's dedup keys roll back and the
 * next tick re-fires the event → the steer is posted AGAIN (an extra a-file
 * rewrite with identical text, one extra pane prompt). Accepted residual: the
 * alternative (nudge after send) cannot carry the suffix in the delivered
 * message, and a duplicate steer is advisory noise, not a lost or wrong fix.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - events — the accepted batch of one tick (post-dedup, post-collected)
 *   - workers — the tick snapshot's worker entries (live/reportPath source)
 *   - transport — the injected Transport seam held by this watcher mount
 *   - log — the advisory log sink
 * Output: none (mutates `events` messages in place when the nudge posted)
 * Guarantees:
 *   - only report-invalid events for LIVE workers (w.live — herdr still knows
 *     the pane; a vanished agent cannot be nudged) trigger a steer
 *   - the steer goes through postSteerAndNudge — the ONE posting core shared
 *     with the delegate_mailbox tool (Law 9); its failure path is the
 *     EXISTING nudge-failed marker machinery, never a new channel
 *   - fully advisory: any throw is logged and never affects the tick's
 *     delivery or its durable commit
 * Residual (accepted): the pane-nudge phase (bounded retries) is awaited
 *   before the batch send, so a broken herdr socket delays this tick's wake
 *   by up to the nudge budget (~3 × MAILBOX_NUDGE_TIMEOUT_MS). The alternative
 *   — detaching the nudge — cannot put the suffix into the delivered wake
 *   text deterministically; a delayed advisory wake beats a lying one.
 * Raises: never (per-event failures are caught and logged)
 */
async function autoHealNudge(
	events: WatchEvent[],
	workers: WatchSnapshot["workers"],
	transport: Transport,
	log: (m: string) => void,
): Promise<void> {
	for (const e of events) {
		if (e.kind !== "report-invalid") continue;
		const w = workers.find((x) => x.dir === e.dir && x.name === e.worker);
		if (!w?.live) continue;
		try {
			// The suffix is appended inside afterPost — synchronously with the
			// envelope post, deterministically BEFORE the batch send below.
			const res = await postSteerAndNudge(transport, e.worker, e.dir, steerText(w, e), {
				afterPost: async () => {
					e.message += " — an automatic fix nudge was posted to the live worker";
					log(`auto fix nudge posted for ${e.worker} (${e.dir}): steer envelope on disk`);
				},
			});
			log(
				`auto fix nudge for ${e.worker} (${e.dir}): steer at ${res.answerPath}` +
					(res.nudged ? ", pane nudged" : res.note),
			);
		} catch (err) {
			log(`auto fix nudge FAILED for ${e.worker} (${e.dir}) (${errText(err)}) — guidance-only delivery`);
		}
	}
}

/**
 * The self-heal steer text (fix-report-heal): names the report path, the full
 * untruncated validator error (carried on the event as `detail`) and the
 * in-place fix mandate — change only what the error names, never redo the
 * work, stay idle afterwards (the watcher re-detects the rewritten report by
 * its new mtime and fires report-ready on its own).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: the snapshot worker entry (reportPath) + the report-invalid event
 * Output: the steer body for the a-<name>.json envelope
 * Guarantees: pure formatting; a missing `detail` degrades to a generic
 *   mandate (never throws, never names a wrong path)
 * Raises: never
 */
function steerText(w: { reportPath?: string }, e: WatchEvent): string {
	const error = e.detail ?? "the report does not satisfy the report contract";
	return (
		`Your report at ${w.reportPath ?? "<unknown path>"} failed schema validation: ${error}. ` +
		"Fix the report file IN PLACE (same path, same schema — change only what the error names; " +
		"do not redo the work) and stay idle."
	);
}

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
			snapOrNull = deps.snapshot ? await deps.snapshot() : await collectSnapshot(deps.transport, deps.self ?? {}, Date.now(), stampLayerCache);
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
			// TZ 1.17.0 §3.4: this is the fifth session-path identity compare —
			// routed through the ONE helper (win32: casefold + separator fold),
			// not a raw `===` (a casing drift would mute a worker-orchestrator's
			// own children). Platform injectable via DetectOptions for tests.
			const selfId = detectOpts.selfSessionFile;
			const selfOwnsChildren =
				selfId !== undefined &&
				snap.workers.some(
					(w) =>
						typeof w.orchestratorSessionPath === "string" &&
						w.orchestratorSessionPath.length > 0 &&
						sameSessionPath(w.orchestratorSessionPath, selfId, detectOpts.platform),
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
		// Watcher stage B, tick step 6: drop events whose delivery key is
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
		// Automatic self-heal (fix-report-heal): the batch is now FULLY accepted
		// for delivery (memory dedup + durable store + collectedAt suppression
		// all passed) — nudge live workers whose report failed validation to fix
		// it in place, and mark the nudged events' messages. Runs (and is
		// awaited) before the send so the suffix reaches the wake text;
		// advisory — see autoHealNudge's contract.
		await autoHealNudge(events, snapOrNull?.workers ?? [], deps.transport, log);
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
		// Watcher delivery: every REAL send is recorded as
		// ONE audit line per batch with the batch content (dir :: worker/kind#fp
		// per event) — the recovery trail after an incident. Written at the send
		// SUCCESS, before the durable commit: the line describes the FACT OF
		// SENDING, so a later commit failure must not hide it (the commit-failure
		// line below then names the same batch). Silent mode and a failed send
		// returned above with their own lines — never a third line here.
		log(formatWakeUpAuditLine(events));
		// tick step 9 — commit AFTER the successful send, one atomic merge per
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

/** Structured send outcome (watcher stage B; the durable store canon is
 *  src/watch-store.ts): the INTERNAL
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
/**
 * The ONE ISO-stamped audit append into the watcher audit file (Wave 3 step
 * 5 — audit finding 7: spawn's watchAudit was a second private
 * implementation of the append makeWatcherLogSink owns; both now call this).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: line — the audit text (the ISO timestamp is prepended here)
 * Output: none
 * Guarantees:
 *   - appends one line to ~/.pi/agent/delegate-watch.log, best-effort
 *   - never throws past the caller (append failures are counted; the FIRST
 *     failure emits ONE warn-once incident line — Wave 4 item 6, not silence)
 * Raises: never
 * EXTERNAL_DEPENDENCY: ~/.pi/agent/delegate-watch.log (append-only audit
 *   file under pi's agent dir; pi's getAgentDir() honors PI_CODING_AGENT_DIR
 *   — tests must set $HOME at child-process spawn time).
 */
export function appendWatcherAudit(line: string): void {
	void appendFile(
		join(getAgentDir(), "delegate-watch.log"),
		`${new Date().toISOString()} ${line}\n`,
	).catch(() => {
		// Audit is advisory — never throw past the tick. But Wave 4 item 6
		// (reliability finding 7): the failure is not SILENT — it is counted,
		// and the FIRST failure emits ONE warn-once incident line (never a
		// per-tick spam; the count is readable via
		// watcherAuditAppendFailureCount()). Module-global on purpose: a
		// diagnostic counter, not ownership state (Law 3 targets ownership
		// registries, not diagnostics).
		watcherAuditAppendFailures++;
		if (!watcherAuditAppendFailureWarned) {
			watcherAuditAppendFailureWarned = true;
			console.error(
				"[pi-delegate watch] audit-log append FAILED — delegate-watch.log is unwritable; audit lines are being dropped (this warning is emitted once)",
			);
		}
	});
}

/** Diagnostics for the warn-once audit-append failure surfacing (Wave 4
 *  item 6): how many appends have failed in this process so far. */
export function watcherAuditAppendFailureCount(): number {
	return watcherAuditAppendFailures;
}

let watcherAuditAppendFailures = 0;
let watcherAuditAppendFailureWarned = false;

export function makeWatcherLogSink(): (m: string) => void {
	return (m: string): void => {
		appendWatcherAudit(m);
		if (/\berror\b|\bfail|already gone|unavailable/i.test(m)) {
			console.error(`[pi-delegate watch] ${m}`);
		}
	};
}

/**
 * Start the watcher for this session (headless-safe — NO
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
