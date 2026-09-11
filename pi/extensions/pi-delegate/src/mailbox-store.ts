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
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue),
 * node builtins, ./host.ts (envelope types + guards ONLY — never the herdr
 * implementation), ./expaths.ts (the ONE path builder), ./manifest-store.ts
 * (the ONE atomic writer).
 *
 * Critical invariants OWNED here:
 *   - mailbox path conventions: q-/a-/release-/nudge-failed- files live
 *     NEXT TO THE BRIEF in /tmp/exchange/<task>/, named by canonical worker
 *     name (wire format FROZEN — file names and envelope shapes are
 *     byte-identical to the pre-extraction module).
 *   - every write is atomic (tmp+rename via atomicWriteFileSync) and
 *     serialized via withFileMutationQueue on the target path.
 *
 * All bodies are byte-verbatim moves from src/exchange.ts (Wave 3a).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "node:fs";
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
} from "./host.ts";
import { atomicWriteFileSync } from "./manifest-store.ts";


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
 *  closes the pane when the worker is retirable; probes retire immediately. */
export interface ReleaseEnvelope {
	from: "orchestrator";
	ts: string;
}

/** Write a release marker atomically (tmp+rename; withFileMutationQueue on the path). */
export function writeRelease(path: string): Promise<void> {
	const envelope: ReleaseEnvelope = {
		from: "orchestrator",
		ts: new Date().toISOString(),
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

/** Outcome of reading a q-<name>.json mailbox file (watcher stage C,
 *  guideline §6.2.5): ABSENT is the normal no-question state; INVALID is a
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
// Mailbox mtime state (Wave 3 step 5 — audit finding 7: ONE implementation
// of the "which side is newer" read shared by the status tool's markers and
// the fleet overlay's mail-state cell)
// ---------------------------------------------------------------------------

import { stat } from "node:fs/promises";

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
