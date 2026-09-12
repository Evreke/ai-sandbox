/**
 * pi-delegate — grace: the settle→collect seam as an explicit state machine
 * (migration stage 2, audit step 7) — extracted verbatim from spawn.ts
 * (Wave 3, step 4).
 * <p>
 * MODULE_CONTRACT: the post-settle grace loop — after the agent settles, a
 * missing/mid-write report is re-checked up to a bounded budget before the
 * spawn is declared report-missing; a pending worker question short-circuits
 * the wait (awaiting-answer). One transition function (graceTransition, the
 * priority ladder: report → question → retryable report state) + the driver
 * (runGraceLoop). SEAM-CLEAN by construction: every dependency is injected
 * (collect, question/ping readers, fs probes, the ClockPort from clock.ts,
 * the abort signal) — nothing is read from module state, fully testable on
 * virtual clocks (test/grace-loop-check.ts).
 * Dependencies: clock.ts (ClockPort — the loop's ONLY time source),
 * host.ts (QuestionEnvelope/ProgressEvent/WorkerReport types). A leaf
 * module otherwise.
 * Critical invariants (moved verbatim from spawn.ts):
 *   - priority order: a valid collect verdict wins BEFORE the question
 *     check; the question wins BEFORE the retry ladder;
 *   - abort during the injected delay → "aborted" — the CALLER salvages
 *     (re-collect + probe salvage + detach); the loop NEVER kills a worker;
 *   - a schema rejection over a readable file is stable (never retried).
 */

import type { ClockPort } from "./clock.ts";
import type { ProgressEvent, QuestionEnvelope, WorkerReport } from "./host.ts";

// ===========================================================================
/** One collect attempt (the collectReport() shape — verdict + the path it
 *  actually read + whether the requested-name fallback was used). */
export interface CollectAttempt {
	verdict: { ok: true; report: WorkerReport } | { ok: false; error: string };
	usedPath: string;
	fallbackUsed: boolean;
}

/** The grace-loop state machine's states (the settle→collect seam). */
export type GraceState =
	| { kind: "evaluate"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "collected"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "awaiting-answer"; question: QuestionEnvelope }
	| { kind: "exhausted"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "aborted"; graceAttempt: number };

/**
 * Dependencies of the grace transition — everything is injected, nothing is
 * read from module state (the seam is fully explicit and testable).
 */
export interface GraceLoopDeps {
	/** Re-read + re-validate the report (the collectReport closure). */
	collect: () => CollectAttempt;
	/** Tolerant pending-question read (q-<name>.json). */
	pendingQuestion: () => QuestionEnvelope | null;
	/** Advisory progress-ping read (p-<name>.jsonl tail). */
	readProgressPing: () => ProgressEvent | null;
	reportExists: (path: string) => Promise<boolean>;
	isParseFailure: (path: string) => Promise<boolean>;
	/** The injected clock — the loop's ONLY time source. */
	clock: ClockPort;
	/** Abort signal of the tool call (abort = detach, never kill). */
	signal?: AbortSignal;
	maxRechecks: number;
	delayMs: number;
	onRecheck?: (attempt: number, missing: boolean, usedPath: string) => void;
	onPing?: (ping: ProgressEvent) => void;
}

/**
 * ONE transition of the settle→collect grace state machine: takes a state,
 * returns the next. From "evaluate" it applies the priority ladder of the
 * unified grace loop (report → question → retryable report state) — the
 * exact pre-extraction semantics (v1.9b review fix 2); every other state is
 * terminal and returned unchanged.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — the current grace state; deps — the injected seam
 * Output: the next state ("evaluate" again after a delay+recollect, or a
 *   terminal kind: collected / awaiting-answer / exhausted / aborted)
 * Guarantees:
 *   - priority order preserved: a valid verdict wins BEFORE the question
 *     check; the question wins BEFORE the retryable check
 *   - a schema rejection over a readable file is stable (never retried →
 *     "exhausted" with graceAttempt untouched)
 *   - abort during the injected delay → "aborted" (the CALLER salvages:
 *     re-collect + probe salvage + detach — the loop never kills a worker)
 *   - the delay goes through deps.clock (virtual in tests)
 * Raises: never (advisory reads are guarded by the caller's closures)
 */
export async function graceTransition(state: GraceState, deps: GraceLoopDeps): Promise<GraceState> {
	if (state.kind !== "evaluate") return state;
	const { attempt, graceAttempt } = state;
	// 1. A valid collect outranks everything (the loop condition of the
	// pre-extraction code checked the verdict first).
	if (attempt.verdict.ok) return { kind: "collected", attempt, graceAttempt };
	// 2. A pending question outranks the retry ladder — the orchestrator's
	// next action is answering, not waiting for a report.
	const question = deps.pendingQuestion();
	if (question) return { kind: "awaiting-answer", question };
	// 3. Advisory progress ping (v1.5, §18) — streamed, never decisive.
	const ping = deps.readProgressPing();
	if (ping) deps.onPing?.(ping);
	// 4. Retryable report state (missing / mid-write JSON) → wait + recheck;
	// a stable rejection (readable, schema-invalid) is final.
	const missing = !(await deps.reportExists(attempt.usedPath));
	const retryable = missing || (await deps.isParseFailure(attempt.usedPath));
	if (!retryable) return { kind: "exhausted", attempt, graceAttempt };
	const next = graceAttempt + 1;
	if (next > deps.maxRechecks) return { kind: "exhausted", attempt, graceAttempt };
	deps.onRecheck?.(next, missing, attempt.usedPath);
	await deps.clock.delay(deps.delayMs, deps.signal);
	if (deps.signal?.aborted) return { kind: "aborted", graceAttempt };
	return { kind: "evaluate", attempt: deps.collect(), graceAttempt: next };
}

/**
 * Run the grace state machine to a terminal state (the extracted post-settle
 * grace loop — the settle→collect seam).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — the injected seam (collect, question/ping readers, fs
 *   probes, clock, signal, recheck budget)
 * Output: the terminal GraceState — never "evaluate"
 * Guarantees:
 *   - behavior-identical to the pre-extraction inline loop (the three
 *     execute drivers pin it end to end)
 *   - termination: each delay+recheck increments graceAttempt; the recheck
 *     budget caps the loop
 * Raises: never (reportExists/isParseFailure/pendingQuestion are tolerant)
 */
export async function runGraceLoop(deps: GraceLoopDeps): Promise<Exclude<GraceState, { kind: "evaluate" }>> {
	let state: GraceState = { kind: "evaluate", attempt: deps.collect(), graceAttempt: 0 };
	while (state.kind === "evaluate") {
		state = await graceTransition(state, deps);
	}
	return state;
}

