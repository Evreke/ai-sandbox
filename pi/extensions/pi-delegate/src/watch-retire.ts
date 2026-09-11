/**
 * pi-delegate — watch-retire: the §23 retire engine (extension-side
 * auto-teardown of drained worker panes) — extracted verbatim from
 * observe.ts (Wave 3, audit Law 5: modules are responsibilities).
 * <p>
 * RETIRABLE = valid report (base + brief fragment) AND drained mailbox AND
 * herdr status done/idle. CLOSE on ACK (release-<name>.json) or TTL
 * (watch.retireTtlMs since retirable). EXCEPTIONS: invalid/missing report,
 * pending worker question — never close; probes close IMMEDIATELY once
 * settled (they never write reports). The clock (retirableSince) and the
 * close stamp (retiredAt) persist in the watcher's satellite file (watch-
 * <key>.json in the task dir — single writer per file; readers merge the
 * manifest's legacy layer with all satellite layers), never in memory only.
 * <p>
 * MODULE_CONTRACT: one retire pass over a snapshot — evaluate (pure, fs
 * reads only), stamp via the lifecycle reducer into the per-watcher
 * satellite file, close through the INJECTED Transport (the same teardown
 * path the collect hook and /delegate-teardown use). Advisory by contract:
 * any failure is logged and retried next tick — it can never affect a spawn
 * or a collect. The manifest entry is NEVER deleted (history stays) and the
 * manifest is NEVER written by the watcher.
 * Dependencies: watch-detect.ts (WatchWorker/WatchSnapshot + the tolerant
 * fs probes), watch-store.ts (satellite stamps + watcher key),
 * lifecycle.ts (reducer stamp adapters), mailbox-store.ts (drained check),
 * report-schema.ts (report/schema validation), manifest-store.ts,
 * archive.ts (archive-at-retire), watch-config.ts (master switch + TTL
 * default), host.ts (the Transport seam).
 */

import { rmSync } from "node:fs";
import { archiveReport } from "./archive.ts";
import { resolveWatchConfig } from "./watch-config.ts";
import { type WatchSnapshot, type WatchWorker } from "./watch-detect.ts";
import { fileMtimeMs } from "./fs-probe.ts";
import { manifestStore, type ExchangeManifest } from "./manifest-store.ts";
import { answerPathFor, questionPathFor, readQuestion, releasePathFor } from "./mailbox-store.ts";
import { parseBriefSchema, validateReportAgainstSchema } from "./report-schema.ts";
import { stampRetireClockClear, stampRetireClockStart, stampRetired } from "./lifecycle.ts";
import { updateWatchStamps, watcherKeyFor } from "./watch-store.ts";
import type { Transport } from "./host.ts";

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
