/**
 * pi-delegate — watch-detect: the watcher's EVENT MODEL + SNAPSHOT + DETECTION
 * (DESIGN.md §21, §22) — extracted verbatim from observe.ts (Wave 3, audit
 * Law 5: modules are responsibilities). This module answers "what is the
 * fleet doing and what events fire"; the tick loop, delivery and §23 retire
 * live in watcher.ts / watch-retire.ts / status-tool.ts.
 * <p>
 * MODULE_CONTRACT: pure detection layer — event kinds/keys (the canonical
 * dedup key shape), the manifest+status snapshot merge (workersFromManifests),
 * the tolerant status read, and the detection priority ladder
 * (detectWorkerEvents) with its dedup/reset cache loop (detectEvents).
 * Dependencies: manifest-store.ts + watch-store.ts (manifest + satellite
 * stamp reads), watch-role.ts (the CANONICAL ownership verdict — the module
 * is a leaf with zero production imports), usage.ts (the ONLY session-JSONL
 * parser — one-parser law), mailbox-store.ts (q-file / nudge-marker reads),
 * report-schema.ts (report validation), watch-config.ts (detection
 * constants), host.ts (the Transport seam + shared types).
 * Critical invariants (owned here, moved verbatim from observe.ts):
 *   - collectedAt-dedup (reader side): report-ready/report-invalid are SILENT
 *     once the manifest records collectedAt — the watcher `seen` dedup is
 *     session memory only, so a fresh session would re-wake on old reports
 *     without the stamp. Detection only READS the stamp; collect writes it.
 *   - ownership fail-closed (watcher stage A): detection answers the ONE
 *     canonical verdict (src/watch-role.ts) — only a proven owner ("mine")
 *     produces events; a legacy no-owner manifest produces events only under
 *     an explicit watch.legacyFailOpen:true; a degraded self-id produces
 *     NOTHING unconditionally (no configuration escape); skipped detections
 *     are auditable (onSkip).
 *   - every read tolerant: garbage manifests/statuses degrade to fewer
 *     events, never a throw (advisory by contract).
 * Never imports the transport implementation (dependency rule, DESIGN.md
 * §4.1 — the Transport instance is injected from index.ts).
 */

import { statSync } from "node:fs";
import {
	answerPathFor,
	nudgeFailedPathFor,
	questionPathFor,
	readNudgeFailedMarker,
	readQuestionState,
} from "./mailbox-store.ts";
import { isProbeDir } from "./exchange.ts";
import { manifestStore, type ExchangeManifest } from "./manifest-store.ts";
import {
	mergeRetireStamps,
	readWatchStampLayers,
	type RetireStamps,
} from "./watch-store.ts";
import { validateReport } from "./report-schema.ts";
import {
	contextPct,
	countSessionToolCall,
	parseSessionUsage,
	resolveContextWindow,
	WATCH_DEFAULT_STALE_AFTER_MS,
} from "./usage.ts";
import { WATCH_DEAD_GRACE_MS, WATCH_LOOKBACK_MS } from "./watch-config.ts";
import { sessionRole, workerAudienceMatch } from "./watch-role.ts";
import {
	CONTEXT_CRITICAL_PCT,
	type AgentStatus,
	type AgentStatusName,
	type Placement,
	type Transport,
} from "./host.ts";

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

/**
 * Re-read the manifest's collectedAt for one worker straight from disk
 * (Wave 2 — the watcher-vs-collect race).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the exchange task dir (manifest.json is read from it)
 *   - worker: the canonical worker name
 * Output: true when the manifest NOW records a collectedAt for the worker
 * Guarantees:
 *   - tolerant: absent/corrupt manifest or entry → false (an unreadable
 *     manifest never blocks a wake — advisory by contract)
 *   - read-only; called immediately before a report-kind batch is sent, so a
 *     collect that stamped BETWEEN the tick's snapshot and the send still
 *     suppresses the wake (the collect already delivered the report)
 * Raises: never
 * EXTERNAL_DEPENDENCY: exchange manifest on disk at <dir>/manifest.json
 *   (via the manifestStore port).
 */
export function becameCollectedOnDisk(dir: string, worker: string): boolean {
	try {
		const m = manifestStore.read(dir);
		const w = m?.workers.find((x) => x.name === worker);
		return typeof w?.collectedAt === "string" && w.collectedAt.length > 0;
	} catch {
		return false;
	}
}

export function fileMtimeMs(path: string): number | null {
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
