/**
 * pi-delegate — src/mailbox-store.ts (Wave 3a: extracted from src/exchange.ts).
 *
 * MODULE_CONTRACT — the mailbox file lifecycle (DESIGN.md §11–§12, §23).
 *
 * Purpose: the q-/a-/release-/nudge-failed- envelope files next to the
 * brief — path builders, tolerant readers (readQuestion/readQuestionState
 * with the read-with-reason result plane), atomic writers (writeAnswer,
 * writeRelease) and the envelope types (NudgeFailedEnvelope,
 * ReleaseEnvelope, QuestionRead).
 *
 * Since fix-report-heal (2026-09-12) this module ALSO owns the ONE
 * steer-posting core (postSteerAndNudge): envelope build + post + pane nudge
 * with retries + the nudge-failed marker machinery — shared verbatim by the
 * delegate_mailbox tool (mailbox-tool.ts) and the watcher's automatic
 * report-invalid fix nudge (watcher.ts). Law 9: no duplicated posting logic.
 *
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue),
 * node builtins, ./host.ts (envelope types + guards + the Transport SEAM
 * type ONLY — never the herdr implementation), ./expaths.ts (the ONE path
 * builder), ./manifest-store.ts (the ONE atomic writer), ./tool-result.ts
 * (errText/sleep helpers).
 *
 * Critical invariants OWNED here:
 *   - mailbox path conventions: q-/a-/release-/nudge-failed- files live
 *     NEXT TO THE BRIEF in /tmp/exchange/<task>/, named by canonical worker
 *     name (wire format FROZEN — file names and envelope shapes are
 *     byte-identical to the pre-extraction module, with ONE additive
 *     exception since Wave 4 item 3 (Law 7): writers stamp an optional
 *     `schemaVersion: 1`; readers tolerate absent and reject wrong).
 *   - every write is atomic (tmp+rename via atomicWriteFileSync) and
 *     serialized via withFileMutationQueue on the target path; the ONE
 *     exception is the nudge-failed marker, whose best-effort plain write
 *     predates this module and whose tolerant reader makes a torn read
 *     degrade to "no marker" (documented at the write site).
 *
 * All bodies are byte-verbatim moves from src/exchange.ts (Wave 3a).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	answerPathFor as buildAnswerPath,
	nudgeFailedPathFor as buildNudgeFailedPath,
	questionPathFor as buildQuestionPath,
	releasePathFor as buildReleasePath,
} from "./expaths.ts";
import {
	isQuestionEnvelope,
	type AnswerEnvelope,
	type QuestionEnvelope,
	type Transport,
} from "./host.ts";
import { atomicWriteFileSync, EXCHANGE_SCHEMA_VERSION, isSupportedSchemaVersion } from "./manifest-store.ts";
import { errText, sleep } from "./tool-result.ts";


/** Mailbox paths, next to the brief (built by src/expaths.ts). */
export function questionPathFor(dir: string, name: string): string {
	return buildQuestionPath(dir, name);
}

export function answerPathFor(dir: string, name: string): string {
	return buildAnswerPath(dir, name);
}

// ---------------------------------------------------------------------------
// F6 — nudge-failed marker (mailbox answer posted, pane nudge failed)
// ---------------------------------------------------------------------------

/** Conventional nudge-failed marker path — next to the brief, worker-scoped
 *  (built by src/expaths.ts). */
export function nudgeFailedPathFor(dir: string, name: string): string {
	return buildNudgeFailedPath(dir, name);
}

/** Mailbox tool → watcher fallback marker (nudge-failed-<name>.json): written
 *  by the delegate_mailbox answer/steer handler when the pane nudge fails after
 *  retries; the watcher delivers the wake-up on the next tick instead of the
 *  socket. Consumed (deleted) by a SUBSEQUENT successful nudge AND by a fresh
 *  same-name spawn (both in spawn.ts) — so a stale marker can only ever fire
 *  once for a new watcher session, and only as an advisory wake. */
export interface NudgeFailedEnvelope {
	name: string;
	ts: string;
	error: string;
}

/**
 * Tolerantly read a nudge-failed marker; null when absent/invalid.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path to nudge-failed-<name>.json
 * Output: the parsed envelope, or null when the file is absent, unreadable,
 *   corrupt JSON, or has no non-empty string `ts` (the fingerprint source)
 * Guarantees: never throws; a torn mid-write read degrades to null and the
 *   detection simply re-fires on a later tick (the marker stays on disk)
 * Raises: never
 */
export function readNudgeFailedMarker(path: string): NudgeFailedEnvelope | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent/unreadable → no marker
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const o = parsed as Record<string, unknown>;
		// Law 7 (Wave 4 item 3): a wrong/future schemaVersion reads as no marker
		// (tolerant-empty), never a misparse; absent = legacy v1.
		if (!isSupportedSchemaVersion(o.schemaVersion)) return null;
		if (typeof o.ts !== "string" || o.ts.length === 0) return null;
		return {
			name: typeof o.name === "string" ? o.name : "",
			ts: o.ts,
			error: typeof o.error === "string" ? o.error : "",
		};
	} catch {
		return null; // corrupt JSON → no marker, never throw
	}
}

// ---------------------------------------------------------------------------
// §23 retire — release marker (orchestrator ACK, watcher-consumed)
// ---------------------------------------------------------------------------

/** Conventional release path (retire ACK) — next to the brief (built by
 *  src/expaths.ts). */
export function releasePathFor(dir: string, name: string): string {
	return buildReleasePath(dir, name);
}

/** Orchestrator → watcher release marker (release-<name>.json). The watcher
 *  closes the pane when the worker is retirable. Law 7: writers stamp
 *  schemaVersion 1; the ONLY consumer (watch-retire) gates on file EXISTENCE
 *  (mtime), never on content — so there is no content reader to version-gate;
 *  an unknown future version degrades to "marker present" which is the safe
 *  ACK direction (a close is the expected outcome for a retirable worker). */
export interface ReleaseEnvelope {
	/** Law 7 (Wave 4 item 3): format version, stamped by the writer. */
	schemaVersion?: number;
	from: "orchestrator";
	ts: string;
}

/** Write a release marker atomically (tmp+rename; withFileMutationQueue on the path). */
export function writeRelease(path: string): Promise<void> {
	const envelope: ReleaseEnvelope = {
		schemaVersion: EXCHANGE_SCHEMA_VERSION,
		from: "orchestrator",
		ts: new Date().toISOString(),
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

/** Outcome of reading a q-<name>.json mailbox file (watcher stage C
 *  result-plane rule): ABSENT is the normal no-question state; INVALID is a
 *  file that EXISTS but is corrupt JSON or not a valid question envelope —
 *  a result-plane fact that must be auditable with its cause, never silently
 *  equated with "no question"; VALID carries the parsed envelope. */
export type QuestionRead =
	| { state: "absent" }
	| { state: "invalid"; error: string }
	| { state: "valid"; question: QuestionEnvelope };

/**
 * Read a pending question WITH the failure reason.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path to q-<name>.json (next to the brief)
 * Output: absent (no/unreadable file), invalid (file exists but fails — with
 *   the human-readable cause), or valid (parsed envelope)
 * Guarantees:
 *   - never throws; a torn mid-write read reads as invalid (with the parse
 *     error as the cause) and self-heals on a later tick
 * Raises: never
 */
export function readQuestionState(path: string): QuestionRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { state: "absent" }; // absent/unreadable → no pending question
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { state: "invalid", error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
	}
	// Law 7 (Wave 4 item 3): a wrong/future schemaVersion is an INVALID read
	// (tolerant-empty — the question is never misparsed); absent = legacy v1.
	if (
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
		!isSupportedSchemaVersion((parsed as Record<string, unknown>).schemaVersion)
	) {
		return {
			state: "invalid",
			error: `unsupported question envelope schemaVersion (${String((parsed as Record<string, unknown>).schemaVersion)} — this build reads version ${EXCHANGE_SCHEMA_VERSION})`,
		};
	}
	if (!isQuestionEnvelope(parsed)) {
		return {
			state: "invalid",
			error: "JSON is not a question envelope (non-empty string fields worker, ts and question are expected)",
		};
	}
	return { state: "valid", question: parsed };
}

/** Read + validate a pending question; null when absent/invalid. */
export function readQuestion(path: string): QuestionEnvelope | null {
	const r = readQuestionState(path);
	return r.state === "valid" ? r.question : null;
}

/**
 * Write an answer envelope atomically (tmp+rename; withFileMutationQueue on the path).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - path: a-<name>.json mailbox path (next to the brief)
 *   - answer: the answer/steering text
 * Output: resolves when the envelope is durably on disk
 * Guarantees:
 *   - atomic write (tmp+rename) under the per-path mutation queue
 *   - envelope shape: {from:"orchestrator", ts: ISO-8601, answer}
 *   - creates the parent dir on demand
 * Raises:
 *   - propagates filesystem errors (the mailbox caller surfaces them)
 * EXTERNAL_DEPENDENCY: withFileMutationQueue from
 *   @earendil-works/pi-coding-agent; filesystem at <exchange dir>/a-<name>.json.
 */
export function writeAnswer(path: string, answer: string): Promise<void> {
	const envelope: AnswerEnvelope = {
		schemaVersion: EXCHANGE_SCHEMA_VERSION,
		from: "orchestrator",
		ts: new Date().toISOString(),
		answer,
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

// ---------------------------------------------------------------------------
// The ONE steer-posting core (fix-report-heal, 2026-09-12): envelope build +
// post + pane nudge with retries — shared by the delegate_mailbox tool
// (orchestrator-driven answer/steer) and the watcher's automatic fix nudge
// (report-invalid self-heal). Law 9: ONE artifact, ONE implementation — both
// callers go through this function; neither re-implements posting.
// ---------------------------------------------------------------------------

/** Max wait for a nudge prompt *submission* to be accepted (not for settle). */
export const MAILBOX_NUDGE_TIMEOUT_MS = 30_000;
/** F6 nudge resilience: total submitPrompt attempts (1 initial + 2 retries) and
 *  the backoff between them. Bounded by design — worst case
 *  ~3×MAILBOX_NUDGE_TIMEOUT_MS + 2 delays, and each attempt stays under the
 *  MAILBOX_NUDGE_TIMEOUT_MS cap. A transient `herdr socket: connection_closed`
 *  must not leave the worker asleep on the first failure (2026-09-10 field
 *  report). */
export const MAILBOX_NUDGE_ATTEMPTS = 3;
export const MAILBOX_NUDGE_RETRY_DELAY_MS = 500;

/** Nudge text — points the worker at the answer file, per DESIGN.md §12. */
export const mailboxNudgeText = (name: string): string =>
	`Mailbox update posted: read a-${name}.json next to your brief and continue accordingly.`;

/** Outcome of postSteerAndNudge — everything the callers render or log. */
export interface SteerPostResult {
	/** The a-<name>.json path the steer envelope was posted to. */
	answerPath: string;
	/** True when the pane nudge prompt was accepted (after retries). */
	nudged: boolean;
	/** Human-readable nudge-outcome note ("" when the plain "Nudge prompt
	 *  sent" note applies — the caller appends its own wake sentence). */
	note: string;
}

/**
 * Post a steer envelope to a worker's mailbox and nudge its pane — THE one
 * posting core shared by the delegate_mailbox answer/steer actions and the
 * watcher's automatic report-invalid fix nudge.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - transport: the injected Transport seam (getStatus + submitPrompt only;
 *     never the herdr implementation)
 *   - name: canonical worker name; dir: the worker's task dir; text: the
 *     steer/answer body written into the envelope
 *   - opts.afterPost: optional hook run AFTER the envelope is durably posted
 *     and BEFORE the pane nudge (the mailbox tool consumes the pending
 *     question there — the archive must not race the nudged turn). Failures
 *     of the hook are the hook's own problem: they propagate to the caller.
 * Output: the posted path, whether the pane nudge was accepted, and the
 *   human-readable nudge-outcome note
 * Guarantees:
 *   - the a-<name>.json envelope is posted atomically (writeAnswer — the ONE
 *     atomic fsync+rename writer) BEFORE any nudge attempt
 *   - the pane nudge fires only for idle/blocked/done workers — never
 *     interrupts a working turn; unknown status → honest note, no nudge
 *   - F6 nudge resilience: submitPrompt is retried (MAILBOX_NUDGE_ATTEMPTS
 *     total); on repeated failure a nudge-failed-<name>.json marker is
 *     written best-effort (the watcher's EXISTING failure channel — no new
 *     one), and a SUBSEQUENT successful nudge deletes any stale marker
 *   - never throws for nudge/marker outcomes (they land in `note`); throws
 *     ONLY for the envelope write failure (the caller decides: the tool
 *     answers E_BRIEF, the watcher logs advisory)
 * Raises:
 *   - filesystem errors from writeAnswer (propagated to the caller)
 * EXTERNAL_DEPENDENCY: exchange dir on disk (/tmp/exchange/<task>/a-<name>.json
 *   and nudge-failed-<name>.json); herdr pane IPC via the injected transport.
 */
export async function postSteerAndNudge(
	transport: Transport,
	name: string,
	dir: string,
	text: string,
	opts: { afterPost?: () => Promise<void> } = {},
): Promise<SteerPostResult> {
	const answerPath = answerPathFor(dir, name);
	// EXTERNAL_DEPENDENCY: exchange dir on disk — answer file at
	// /tmp/exchange/<task>/a-<name>.json (atomic write inside mailbox-store).
	await writeAnswer(answerPath, text);
	if (opts.afterPost) await opts.afterPost();

	// Nudge idle/blocked/done workers — a working agent must not be
	// interrupted mid-turn. A done agent IS woken: submitPrompt starts a new
	// turn on the existing pane and that turn reads the answer file (§12
	// promises a nudge for answer/steer with no status restriction). Unknown
	// status → honest warning instead of a silent success.
	//
	// F6 nudge resilience: submitPrompt is retried with a short backoff
	// (MAILBOX_NUDGE_ATTEMPTS total, each attempt under MAILBOX_NUDGE_TIMEOUT_MS)
	// — a transient `connection_closed` from the herdr socket must not leave
	// the worker asleep on the first failure. On REPEATED failure a watcher-
	// visible marker (nudge-failed-<name>.json) is written into the worker's
	// exchange dir, so the orchestrator's watcher delivers the wake-up on the
	// next tick instead of the socket; on a SUBSEQUENT successful nudge any
	// stale marker is deleted (the §23 retire-ack consume discipline — a
	// leftover marker must not fire for a fresh same-name retry).
	let nudged = false;
	let note = "";
	try {
		const status = (await transport.getStatus(name))?.status ?? "unknown";
		if (status === "idle" || status === "blocked" || status === "done") {
			// EXTERNAL_DEPENDENCY: herdr pane IPC via the injected transport
			// (submitPrompt types into the worker's live pane; 30 s accept cap).
			let lastErr: unknown = null;
			for (let attempt = 1; attempt <= MAILBOX_NUDGE_ATTEMPTS; attempt++) {
				try {
					await transport.submitPrompt({
						name,
						text: mailboxNudgeText(name),
						timeoutMs: MAILBOX_NUDGE_TIMEOUT_MS,
					});
					nudged = true;
					break;
				} catch (err) {
					lastErr = err;
					if (attempt < MAILBOX_NUDGE_ATTEMPTS) await sleep(MAILBOX_NUDGE_RETRY_DELAY_MS);
				}
			}
			if (nudged) {
				// Consume any stale nudge-failed marker (advisory, best-effort —
				// mirrors the release-ACK consume in observe.ts retirePass).
				try {
					await rm(nudgeFailedPathFor(dir, name), { force: true });
				} catch {
					// marker cleanup is advisory — the next successful nudge retries
					// and the marker's own ts fingerprint keeps old events deduped
				}
				if (status === "done") {
					note = " Worker had finished (status done) — re-prompted; the new turn reads a-" + name + ".json.";
				}
			} else {
				const markerPath = nudgeFailedPathFor(dir, name);
				const ts = new Date().toISOString();
				try {
					// Best-effort plain write (not atomic): the watcher's marker
					// reader is tolerant — a torn read degrades to "no marker" and
					// the next failed answer/steer re-writes it.
					await writeFile(
						markerPath,
						`${JSON.stringify({ schemaVersion: EXCHANGE_SCHEMA_VERSION, name, ts, error: errText(lastErr) }, null, "\t")}\n`,
					);
					note =
						` Nudge prompt failed after ${MAILBOX_NUDGE_ATTEMPTS} attempts (${errText(lastErr)}) — the answer IS posted at a-${name}.json ` +
						`and a nudge-failed marker was written (${markerPath}): the watcher delivers the wake-up on its next tick. ` +
						"If it does not, re-prompt the pane manually or retry the steer.";
				} catch (markerErr) {
					note =
						` Nudge prompt failed after ${MAILBOX_NUDGE_ATTEMPTS} attempts (${errText(lastErr)}) — the answer file IS posted ` +
						`(marker write also failed: ${errText(markerErr)}); check the pane via delegate_status and nudge manually if needed.`;
				}
			}
		} else if (status === "unknown") {
			note =
				` Worker status is unknown — the answer IS posted but may never be read; verify the pane via delegate_status and nudge or re-spawn the worker manually if it does not pick the mail up.`;
		} else {
			note =
				` Worker status is ${status} — no nudge sent to avoid interrupting the running turn; the worker reads a-${name}.json between steps when its brief says steering is expected.`;
		}
	} catch (err) {
		note =
			` Nudge prompt failed (${errText(err)}) — the answer file IS posted; check the pane via delegate_status and nudge manually if needed.`;
	}
	// The getStatus/submitPrompt block above never throws on its own paths —
	// this outer catch covers unexpected shape changes; retry/marker logic
	// lives INSIDE the idle/blocked/done branch (F6).
	return { answerPath, nudged, note };
}

// ---------------------------------------------------------------------------
// Mailbox mtime state (Wave 3 step 5 — audit finding 7: ONE implementation
// of the "which side is newer" read shared by the status tool's markers and
// the fleet overlay's mail-state cell)
// ---------------------------------------------------------------------------

/** The mailbox's mtime-layer state, read-only and tolerant.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the exchange task dir; name — the canonical worker name
 * Output: questionPosted (a q-<name>.json exists) and answerNewerThanQuestion
 *   (an a-<name>.json exists AND postdates the question — or exists while no
 *   question does)
 * Guarantees:
 *   - read-only: existence + mtime ordering only, contents never read
 *   - tolerant: absent/unreadable files degrade to the "not posted" sentinel,
 *     never a throw
 * Raises: never
 * EXTERNAL_DEPENDENCY: mailbox files at /tmp/exchange/<task>/q-<name>.json
 *   and a-<name>.json.
 */
export async function mailboxAnswerState(
	dir: string,
	name: string,
): Promise<{ questionPosted: boolean; answerNewerThanQuestion: boolean }> {
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
	return {
		questionPosted: qMtime >= 0,
		answerNewerThanQuestion: aMtime >= 0 && aMtime > qMtime,
	};
}
