/**
 * pi-delegate — src/lifecycle.ts (migration stage 2, audit step 6).
 *
 * MODULE_CONTRACT — the SINGLE OWNER of the worker lifecycle: worker state
 * as a discriminated union, the TOTAL transition-legality function (the
 * reducer), the embodiment identity (name + run ordinal + placementRef),
 * the backward adapter that reads lifecycle state out of legacy manifest
 * entries, and the validate-then-patch stamp adapters that route every
 * manifest lifecycle stamp (collectedAt, retirableSince, retiredAt)
 * through the reducer.
 *
 * Purpose: before this module the worker's lifecycle state had no owner —
 * it was scattered across ad-hoc manifest stamps written by spawn (collect)
 * and the watcher (retire), with no legality rules: a closed worker could
 * be re-stamped, a stamped-collected entry re-collected, and two
 * embodiments of the same worker name in one task dir were
 * indistinguishable (the "invisible live worker" / foreign-budget-spend
 * bug class). This module makes the state machine explicit and total: every
 * stamp write is a reducer transition; an illegal one is a structured
 * refusal, never a silent corrupt.
 *
 * State model (audit §3.2 "Конечный автомат жизненного цикла"): placed →
 * started → working → settled → (report-received | report-invalid |
 * awaiting-answer) → report-delivered → collected → closed; any non-closed
 * state → closed through the ONE close operation (explicit force +
 * violations required unless the report is already received/delivered/
 * collected); start refusal and pre-settle death land in closed-early-
 * failed. The legacy "placed-or-started" phase exists ONLY for backward-
 * adapted manifest entries (no stamps to distinguish placed from started).
 *
 * Dependencies: ./exchange.ts (the ManifestWorker record shape + the
 * EmbodimentRef field — the ONE manifest format extension) and ./host.ts
 * (types only). Depends on the seam and the exchange storage; src/host.ts
 * stays at the bottom of the graph (nothing here is imported by it).
 *
 * Critical invariants:
 *   - the reducer is TOTAL: it never throws; every input yields
 *     {ok:true,next} or {ok:false,error}
 *   - closed / closed-early-failed are TERMINAL — no event leaves them
 *   - manifest writes keep their physical stamp fields (collectedAt,
 *     retirableSince, retiredAt) — external consumers (the watcher's
 *     collectedAt dedup, retire history) are unchanged; the reducer
 *     adjudicates the writes, it does not add a second representation
 *   - the embodiment identity is the ONLY new manifest field
 *     (embodiment?: { run, placementRef }); legacy entries without it are
 *     handled by the backward adapter, never rejected
 *
 * Migration stage 3 (audit step 8) adds the REPORT-OWNERSHIP WITNESS to this
 * module: ReportWitness + witnessEmbodimentReport + reportWitnessProvesRun —
 * the completion-criterion witness of ONE embodiment. The spawn flow
 * snapshots the canonical report file's pre-run state (existed + content
 * digest) and the settle wait proves completion by observing the file
 * against that witness (appeared / rewritten since THIS run started).
 * Ownership is decided by the embodiment's content-addressed witness, NEVER
 * by comparing file mtimes against the wall clock (clock skew and sub-
 * millisecond ordering made both false-settle and false-miss possible).
 *
 * Error modes: never throws — refusals are {ok:false, error} results.
 */

import type { ManifestWorker } from "./manifest-store.ts";

// ---------------------------------------------------------------------------
// Report-ownership witness (migration stage 3, audit step 8)
// ---------------------------------------------------------------------------

/**
 * The completion-criterion witness of ONE embodiment: the state of the
 * canonical report file at the moment this embodiment launched. The spawn
 * flow snapshots the report path BEFORE the agent starts; the settle wait
 * then proves completion by OBSERVING THE FILE against this witness —
 * ownership of the report by THIS run is decided by the embodiment's
 * witness, never by comparing file timestamps against the wall clock.
 * (Before this the proof was `(mtime ≥ spawn time)` — a timestamp race:
 * a report written a millisecond BEFORE the recorded spawn time was
 * invisible to its own run, and clock skew between writer and reader could
 * both false-settle and false-miss. The witness answers "did the file
 * CHANGE since THIS run started" — content-addressed, clock-free.)
 */
export interface ReportWitness {
	/** True when the report file already existed when this embodiment launched
	 *  (a stale report of an earlier same-name run in the same task dir). */
	existed: boolean;
	/** Digest of the pre-existing content (null when the file was absent). */
	digest: string | null;
}

/** FNV-1a 32-bit content digest — deterministic, dependency-free, enough to
 *  distinguish "the file was rewritten" from "the same stale bytes". */
function contentDigest(raw: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		h ^= raw.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * Snapshot the pre-run state of a report file for the embodiment witness.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: raw — the file's current content, or null when absent/unreadable
 * Output: the ReportWitness for this embodiment
 * Guarantees: pure; never throws
 * Raises: never
 */
export function witnessEmbodimentReport(raw: string | null): ReportWitness {
	return raw === null ? { existed: false, digest: null } : { existed: true, digest: contentDigest(raw) };
}

/**
 * Does the CURRENT content of the canonical report file prove THIS run's
 * completion? The file proves the run when it APPEARED since the witness
 * (no file at launch → any file is this run's) or was REWRITTEN since it
 * (a stale report existed → only different content counts). This is the
 * audit's "принадлежность запуска определяется идентичностью воплощения, а
 * не сравнением временных меток файлов": the witness IS the embodiment's
 * claim on the path, checked by content, not by clocks.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - witness — the embodiment's launch-time snapshot (witnessEmbodimentReport)
 *   - raw — the file's current content, or null when absent/unreadable
 * Output: true when the file's current state is evidence of THIS run
 * Guarantees:
 *   - pure; never throws; absent file → false (never a false settle)
 * Raises: never
 */
export function reportWitnessProvesRun(w: ReportWitness, raw: string | null): boolean {
	if (raw === null) return false;
	if (!w.existed) return true;
	return contentDigest(raw) !== w.digest;
}

// ---------------------------------------------------------------------------
// Embodiment identity (audit step 6)
// ---------------------------------------------------------------------------

/**
 * The manifest field shape: identity of the embodiment of a worker NAME —
 * the run ordinal and the opaque placement ref (the name itself lives in
 * the entry's own `name` field and is not duplicated). Declared in
 * exchange.ts (the manifest record owner); re-declared here as the
 * FULL identity including the name.
 */
export interface EmbodimentIdentity {
	/** Canonical worker name (the manifest entry's `name`). */
	name: string;
	/** 1-based ordinal of this launch of the name within one task dir:
	 *  first spawn of "alpha" → run 1, a same-name retry → run 2. */
	run: number;
	/** Opaque placement ref of THIS launch (adapter-defined; equality-
	 *  matched, never decoded outside the owning adapter). */
	placementRef: string;
}

/**
 * The embodiment key: the canonical equality token for "the same physical
 * worker run". Two entries with equal keys are the SAME embodiment;
 * different keys (same name, different run or ref) are different
 * embodiments and must never be conflated by stamp writes.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: e — the embodiment identity
 * Output: a stable string key "name#run@placementRef"
 * Guarantees: pure; deterministic; never throws
 * Raises: never
 */
export function embodimentKey(e: EmbodimentIdentity): string {
	return `${e.name}#${e.run}@${e.placementRef}`;
}

/**
 * Read the embodiment identity off a manifest entry. Entries WITH the
 * embodiment field decode directly; legacy entries (no field) get the
 * inferred identity: run 0 (unknown ordinal) + the placement's ref —
 * enough for opaque equality against a live placement, honest about the
 * unknown run.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: w — a manifest worker entry (with or without the embodiment field)
 * Output: the EmbodimentIdentity (run 0 = legacy, ordinal unknown)
 * Guarantees: total; never throws on any entry shape
 * Raises: never
 */
export function embodimentOf(w: ManifestWorker): EmbodimentIdentity {
	const ref =
		(typeof w.placement?.placementRef === "string" && w.placement.placementRef) ||
		(typeof w.placement?.paneId === "string" && w.placement.paneId) ||
		"";
	// Reducer invariant: the embodiment field is optional on the manifest type,
	// so presence is narrowed here directly (the `legacy` boolean cannot narrow
	// for TypeScript — same branch structure, identical semantics).
	if (!w.embodiment) {
		return { name: w.name, run: 0, placementRef: ref };
	}
	return {
		name: w.name,
		run: w.embodiment.run,
		placementRef: w.embodiment.placementRef,
	};
}

/**
 * Compute the identity for a NEW spawn of `name` into a task dir whose
 * manifest already holds `existingWorkers`: the run ordinal is the count of
 * prior entries carrying this name + 1 (every embodiment of the name is
 * appended, entries are never deleted — the count IS the ordinal).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - name: the canonical worker name of the new spawn
 *   - placementRef: the opaque ref of the new placement
 *   - existingWorkers: the manifest's current worker entries (may be empty)
 * Output: the EmbodimentIdentity for the new entry (run ≥ 1)
 * Guarantees: pure; two spawns with the same inputs in the same manifest
 *   state yield the same identity (the caller must persist the entry before
 *   the next spawn reads the manifest again)
 * Raises: never
 */
export function nextEmbodiment(
	name: string,
	placementRef: string,
	existingWorkers: ManifestWorker[],
): EmbodimentIdentity {
	const run = existingWorkers.filter((w) => w.name === name).length + 1;
	return { name, run, placementRef };
}

// ---------------------------------------------------------------------------
// Worker lifecycle state — discriminated union (audit §3.2 state machine)
// ---------------------------------------------------------------------------

export type WorkerPhase =
	| "placed"
	| "placed-or-started" // legacy backward-adapted only — placed vs started unprovable
	| "started"
	| "working"
	| "settled"
	| "report-received"
	| "report-invalid"
	| "awaiting-answer"
	| "report-delivered"
	| "collected"
	| "closed"
	| "closed-early-failed";

export interface WorkerLifecycleState {
	phase: WorkerPhase;
	/** ISO 8601 — when this state was entered (the stamp that proves it, or
	 *  the entry's startedAt for backward-adapted states). */
	at: string;
}

export type LifecycleEvent =
	| { type: "start-proven"; at?: string }
	| { type: "start-refused"; at?: string; reason?: string }
	| { type: "life-proof"; at?: string }
	| { type: "settled"; at?: string; status?: string }
	| { type: "report-received"; at?: string }
	| { type: "report-invalid"; at?: string }
	| { type: "question-pending"; at?: string }
	| { type: "worker-resumed"; at?: string }
	| { type: "report-delivered"; at?: string }
	| { type: "retire-clock-start"; at?: string }
	| { type: "collected"; at?: string }
	| { type: "closed"; at?: string; forced?: boolean; violations?: string[] };

/** Phases from which the close operation needs NO explicit force: the
 *  report is already received/delivered/collected (audit: "без состояния
 *  «собран» или «отчёт получен» операция требует явного принуждения"). */
const CLOSE_WITHOUT_FORCE: ReadonlySet<WorkerPhase> = new Set([
	"report-received",
	"report-delivered",
	"collected",
]);

/** Phases from which the collect stamp may collapse the (today untracked)
 *  report-delivery pipeline into "collected". Every non-closed phase
 *  qualifies — herdr builds never report "working" for pi workers, so the
 *  intermediate pipeline phases are simply not observed in production. */
const COLLECTABLE: ReadonlySet<WorkerPhase> = new Set([
	"placed-or-started",
	"working",
	"settled",
	"report-received",
	"report-invalid",
	"awaiting-answer",
	"report-delivered",
	"collected",
]);

/** Phases from which the WATCHER's retire-clock start may collapse the
 *  (untracked) report-delivery pipeline — the same live set as COLLECTABLE:
 *  a retirable worker has a valid delivered report; collected entries are
 *  prime retire candidates (collect-time auto-teardown may be disabled). */
const RETIRE_CLOCKABLE = COLLECTABLE;

/**
 * The TOTAL transition-legality function (the reducer). Takes the current
 * state and a lifecycle event, returns the next state or a structured
 * refusal. Never throws; unknown event types are refusals, not errors.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - state: the current lifecycle state
 *   - event: the lifecycle event to apply
 * Output: {ok:true, next} or {ok:false, error} — the error names the phase,
 *   the event and the rule violated
 * Guarantees:
 *   - total: every (state, event) pair yields a result, never throws
 *   - closed / closed-early-failed are terminal: every event is refused
 *   - close from a non-report phase requires forced=true AND a non-empty
 *     violations list (the audit's explicit-force discipline)
 * Raises: never
 */
export function transitionLifecycle(
	state: WorkerLifecycleState,
	event: LifecycleEvent,
): { ok: true; next: WorkerLifecycleState } | { ok: false; error: string } {
	const at = event.at ?? new Date().toISOString();
	const refuse = (rule: string): { ok: false; error: string } => ({
		ok: false,
		error: `illegal lifecycle transition: phase "${state.phase}" rejects event "${event.type}" — ${rule}`,
	});

	// Terminal phases: nothing leaves them (history is never rewritten).
	if (state.phase === "closed" || state.phase === "closed-early-failed") {
		return refuse("a closed worker is terminal (history is never rewritten)");
	}

	// The ONE close operation — legal from every non-closed phase, with the
	// explicit-force discipline.
	if (event.type === "closed") {
		if (!CLOSE_WITHOUT_FORCE.has(state.phase)) {
			const forced = event.forced === true;
			const hasViolations = Array.isArray(event.violations) && event.violations.length > 0;
			if (!forced || !hasViolations) {
				return refuse(
					`closing a worker without a received report requires forced=true and a non-empty violations list`,
				);
			}
		}
		return { ok: true, next: { phase: "closed", at } };
	}

	// The collect stamp collapses the report-delivery pipeline into
	// "collected" (the collectedAt write): the intermediate phases are
	// untracked in production today (herdr never reports "working" for pi
	// workers), so the reducer admits the collapse from any non-closed,
	// non-terminal phase listed in COLLECTABLE.
	if (event.type === "collected") {
		if (!COLLECTABLE.has(state.phase)) {
			return refuse("the collect stamp needs a live, not-yet-closed worker");
		}
		return { ok: true, next: { phase: "collected", at } };
	}

	// The watcher's retire-clock start (retirableSince): the worker became
	// retirable this tick — admitted from the same live set as the collect
	// stamp (the report-delivery pipeline is untracked in production).
	if (event.type === "retire-clock-start") {
		if (!RETIRE_CLOCKABLE.has(state.phase)) {
			return refuse("the retire clock starts only for a live worker with a delivered report");
		}
		return { ok: true, next: { phase: state.phase, at: state.at } };
	}

	switch (state.phase) {
		case "placed":
			if (event.type === "start-proven") return { ok: true, next: { phase: "started", at } };
			if (event.type === "start-refused")
				return { ok: true, next: { phase: "closed-early-failed", at } };
			return refuse("a placed worker proves start or is refused at start");
		case "placed-or-started":
		case "started":
			// Legacy backward-adapted entries sit here: the placed/started split
			// is unprovable from stamps, so every started-transition is admitted
			// (and placed's start-proven collapses into staying started-like).
			if (event.type === "life-proof") return { ok: true, next: { phase: "working", at } };
			if (event.type === "settled") return { ok: true, next: { phase: "settled", at } };
			if (event.type === "start-refused")
				return { ok: true, next: { phase: "closed-early-failed", at } };
			return refuse("a started worker proves life, settles, or fails early");
		case "working":
			if (event.type === "settled") return { ok: true, next: { phase: "settled", at } };
			return refuse("a working worker settles (or is closed)");
		case "settled":
			if (event.type === "report-received") return { ok: true, next: { phase: "report-received", at } };
			if (event.type === "report-invalid") return { ok: true, next: { phase: "report-invalid", at } };
			if (event.type === "question-pending") return { ok: true, next: { phase: "awaiting-answer", at } };
			if (event.type === "start-refused")
				return { ok: true, next: { phase: "closed-early-failed", at } };
			return refuse("a settled worker yields a report, a question, or an early failure");
		case "report-invalid":
			if (event.type === "report-received") return { ok: true, next: { phase: "report-received", at } };
			if (event.type === "start-refused")
				return { ok: true, next: { phase: "closed-early-failed", at } };
			return refuse("an invalid report is overwritten by a valid one or the worker fails early");
		case "awaiting-answer":
			if (event.type === "worker-resumed") return { ok: true, next: { phase: "working", at } };
			if (event.type === "start-refused")
				return { ok: true, next: { phase: "closed-early-failed", at } };
			return refuse("an answered worker resumes work (or fails early)");
		case "report-received":
			if (event.type === "report-delivered") return { ok: true, next: { phase: "report-delivered", at } };
			// Reducer invariant: the `collected` event is totally handled by the
			// pre-switch block above (COLLECTABLE ⊇ every non-closed phase), so it
			// can never reach the phase switch — the comparison here was DEAD CODE
			// (deleted; the collect stamp path lives in the pre-switch block).
			return refuse("a received report is delivered or collected");
		case "report-delivered":
			// Dead-code deletion, same reducer invariant as above: a `collected`
			// event never reaches the switch (handled totally pre-switch).
			return refuse("a delivered report is collected");
		case "collected":
			// Re-collect (a later same-name stamp refreshing the timestamp) is an
			// idempotent re-entry — the collected phase persists. That guarantee is
			// delivered by the pre-switch `collected` block ("collected" ∈
			// COLLECTABLE → ok, phase stays "collected"); the comparison here was
			// dead code (reducer invariant: `collected` events never reach the
			// switch) and is deleted.
			return refuse("a collected worker is only closed");
	}
}

// ---------------------------------------------------------------------------
// Backward adapter — legacy manifest entries → lifecycle state
// ---------------------------------------------------------------------------

/**
 * Derive the lifecycle state from a manifest entry's stamps (the backward
 * adapter): retiredAt → closed; collectedAt → collected; retirableSince
 * (the watcher's running TTL clock — the report was valid and delivered) →
 * report-delivered; no stamps → placed-or-started (the legacy live state —
 * the audit's «размещён или запущен»). New entries carrying a state-bearing
 * stamp set are read by the same rule — the stamps ARE the physical state.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: w — a manifest worker entry (any vintage)
 * Output: the derived WorkerLifecycleState
 * Guarantees:
 *   - total; precedence retiredAt > collectedAt > retirableSince > none
 *   - stamps win over the embodiment field (the stamps stay the physical
 *     representation in stage 2 — the embodiment field is identity only)
 * Raises: never
 */
export function stateFromManifestWorker(w: ManifestWorker): WorkerLifecycleState {
	if (typeof w.retiredAt === "string" && w.retiredAt.length > 0) {
		return { phase: "closed", at: w.retiredAt };
	}
	if (typeof w.collectedAt === "string" && w.collectedAt.length > 0) {
		return { phase: "collected", at: w.collectedAt };
	}
	if (typeof w.retirableSince === "string" && w.retirableSince.length > 0) {
		return { phase: "report-delivered", at: w.retirableSince };
	}
	return { phase: "placed-or-started", at: w.startedAt };
}

// ---------------------------------------------------------------------------
// Stamp adapters — validate-then-patch (every manifest lifecycle stamp is a
// reducer transition; the physical stamp fields are unchanged)
// ---------------------------------------------------------------------------

export type StampResult =
	| { ok: true; entry: ManifestWorker }
	| { ok: false; error: string };

/**
 * Stamp collectedAt through the reducer (the "collected" transition). The
 * collect stamp is the physical representation of the collected phase —
 * the watcher's cross-session dedup reads the field (behavior unchanged);
 * the reducer now adjudicates the write.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - w: the manifest entry to stamp
 *   - at: the ISO stamp (the collect moment)
 * Output: {ok, entry with collectedAt} or {ok:false, error}
 * Guarantees:
 *   - refuses on closed/closed-early-failed entries (terminal)
 *   - pure — returns a new entry, never mutates
 * Raises: never
 */
export function stampCollected(w: ManifestWorker, at: string): StampResult {
	const verdict = transitionLifecycle(stateFromManifestWorker(w), { type: "collected", at });
	if (!verdict.ok) return verdict;
	return { ok: true, entry: { ...w, collectedAt: at } };
}

/**
 * Stamp retirableSince through the reducer (the watcher's persisted TTL
 * clock start — the worker became retirable this tick). Legal from every
 * non-closed phase; a closed worker's clock must never restart.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - w: the manifest entry to stamp
 *   - at: the ISO stamp (the clock-start moment)
 * Output: {ok, entry with retirableSince} or {ok:false, error}
 * Guarantees: pure; refuses terminal phases; never mutates
 * Raises: never
 */
export function stampRetireClockStart(w: ManifestWorker, at: string): StampResult {
	const verdict = transitionLifecycle(stateFromManifestWorker(w), {
		type: "retire-clock-start",
		at,
	});
	if (!verdict.ok) return verdict;
	return { ok: true, entry: { ...w, retirableSince: at } };
}

/**
 * Clear retirableSince through the reducer (the retirable state broke —
 * the TTL clock restarts on the next retirable transition). Legal only
 * while the clock is actually running.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: w — the manifest entry whose clock must clear
 * Output: {ok, entry without retirableSince} or {ok:false, error}
 * Guarantees: pure; refuses when no clock is running; never mutates
 * Raises: never
 */
export function stampRetireClockClear(w: ManifestWorker): StampResult {
	if (typeof w.retirableSince !== "string" || w.retirableSince.length === 0) {
		return { ok: false, error: "illegal lifecycle transition: no retire clock is running for this worker" };
	}
	const { retirableSince: _dropped, ...rest } = w;
	return { ok: true, entry: rest as ManifestWorker };
}

/**
 * Stamp retiredAt through the reducer (the watcher's successful close —
 * the "closed" transition with explicit force: the watcher closes on ACK or
 * TTL, which IS the sanctioned close of a possibly-untracked report state).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - w: the manifest entry to stamp
 *   - at: the ISO stamp (the close moment)
 * Output: {ok, entry with retiredAt} or {ok:false, error}
 * Guarantees:
 *   - refuses already-closed entries (retirePass skips them upstream; a
 *     double stamp would rewrite closed history)
 *   - pure; never mutates
 * Raises: never
 */
export function stampRetired(w: ManifestWorker, at: string): StampResult {
	const verdict = transitionLifecycle(stateFromManifestWorker(w), {
		type: "closed",
		at,
		forced: true,
		violations: ["watcher retire close (ACK or TTL)"],
	});
	if (!verdict.ok) return verdict;
	return { ok: true, entry: { ...w, retiredAt: at } };
}

/**
 * Close an entry through the reducer with the audit's explicit-force
 * discipline: the shared close operation for every closer (collect-time
 * auto-teardown, /delegate-teardown, the watcher's retire pass). Without a
 * received/delivered/collected report the close must declare itself forced
 * with a violations list; otherwise it is refused.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - w: the manifest entry to close
 *   - opts: { at, forced?, violations? } — the close declaration
 * Output: {ok, entry (retiredAt = at)} or {ok:false, error}
 * Guarantees:
 *   - the reducer decides; a refusal never corrupts the entry
 *   - pure; never mutates
 * Raises: never
 */
export function closeWorker(
	w: ManifestWorker,
	opts: { at: string; forced?: boolean; violations?: string[] },
): StampResult {
	const verdict = transitionLifecycle(stateFromManifestWorker(w), {
		type: "closed",
		at: opts.at,
		forced: opts.forced,
		violations: opts.violations,
	});
	if (!verdict.ok) return verdict;
	return { ok: true, entry: { ...w, retiredAt: opts.at } };
}
