/**
 * Grace-loop state machine (migration stage 2, audit step 7) — the
 * settle→collect seam of the delegate execute pipeline, on VIRTUAL clocks.
 *
 * Run with: bun run test/grace-loop-check.ts   (from the extension dir)
 *
 * The loop (spawn.ts runGraceLoop/graceTransition) re-checks, in priority
 * order (report → question → retryable report state), for up to
 * maxRechecks × delayMs after a settle — the settle-vs-report and
 * settle-vs-question races. On the injected virtual clock the whole
 * sequence space is deterministic and instant.
 *
 * Checks:
 *   G1  Sequence table — the canonical pipelines land in the expected
 *       terminal state with the expected recheck count and virtual time:
 *       valid report immediately; report appears after N rechecks; a
 *       pending question interrupts; a stable schema rejection is final
 *       (never retried); the recheck budget exhausts.
 *   G2  Priority order — a valid collect outranks a pending question; a
 *       question outranks the retry ladder.
 *   G3  Virtual clock — delays go through the injected clock (no real
 *       waiting: the whole table runs in ~0 ms); each recheck advances
 *       exactly delayMs of virtual time.
 *   G4  Abort during the injected delay → "aborted" terminal.
 *   G5  Wiring pin — execute() feeds the machine with systemClock and the
 *       recheck budget (GRACE_RECHECKS/GRACE_DELAY_MS unchanged).
 * Exit 0 only if all checks pass.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	graceTransition,
	runGraceLoop,
	type CollectAttempt,
	type GraceLoopDeps,
	type GraceState,
} from "../src/spawn.ts";
// Wave 3 decomposition: the clock port lives in src/clock.ts now.
import { createVirtualClock } from "../src/clock.ts";
import type { ProgressEvent, QuestionEnvelope, WorkerReport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");

const REPORT: WorkerReport = {
	worker: "w",
	status: "pass",
	summary: "one-paragraph outcome",
	artifacts: ["a.ts"],
	evidence: [{ claim: "c", file: "f.ts:1" }],
};

const okAttempt = (path = "/r.json"): CollectAttempt => ({
	verdict: { ok: true, report: REPORT },
	usedPath: path,
	fallbackUsed: false,
});
const badAttempt = (error: string, path = "/r.json"): CollectAttempt => ({
	verdict: { ok: false, error },
	usedPath: path,
	fallbackUsed: false,
});

interface Fixture {
	/** Collect attempt produced by call #0, #1, #2, … (last repeats). */
	attempts: CollectAttempt[];
	/** Question file seen by poll #0, #1, … (null = none; last repeats). */
	questions?: Array<QuestionEnvelope | null>;
	/** Report file readability by probe #0, #1, … (last repeats). NOTE: the
	 *  probe runs on the CURRENT attempt's path BEFORE the re-collect — a
	 *  report that "appears later" is expressed by the attempts table, not
	 *  by flipping exists mid-run (missing → retryable without a parse
	 *  probe, the machine short-circuits like the pre-extraction code). */
	exists?: boolean[];
	/** Parse-failure flag by probe #0, #1, … (last repeats). */
	parseFailure?: boolean[];
}

function makeDeps(fx: Fixture, clock: ReturnType<typeof createVirtualClock>, log: string[]): GraceLoopDeps {
	const at = (arr: Array<unknown> | undefined, i: number) =>
		arr && arr.length > 0 ? arr[Math.min(i, arr.length - 1)] : undefined;
	return {
		collect: () => {
			const i = log.filter((l) => l === "collect").length;
			log.push("collect");
			return (at(fx.attempts, i) as CollectAttempt) ?? badAttempt("unreadable");
		},
		pendingQuestion: () => {
			const i = log.filter((l) => l === "q").length;
			log.push("q");
			return (at(fx.questions, i) as QuestionEnvelope | null) ?? null;
		},
		readProgressPing: () => null,
		reportExists: async (path: string) => {
			const i = log.filter((l) => l.startsWith("exists")).length;
			log.push(`exists:${path}`);
			return (at(fx.exists, i) as boolean | undefined) ?? false;
		},
		isParseFailure: async (path: string) => {
			const i = log.filter((l) => l.startsWith("parse")).length;
			log.push(`parse:${path}`);
			return (at(fx.parseFailure, i) as boolean | undefined) ?? false;
		},
		clock,
		maxRechecks: 5,
		delayMs: 2000,
	};
}

async function run(fx: Fixture): Promise<{ out: GraceState; clock: ReturnType<typeof createVirtualClock>; log: string[] }> {
	const clock = createVirtualClock(0);
	const log: string[] = [];
	const abortController = new AbortController();
	const deps = makeDeps(fx, clock, log);
	deps.signal = abortController.signal;
	// Drive advance() while the machine is evaluating (the virtual clock's
	// delays need explicit advances to resolve).
	let out: GraceState = { kind: "evaluate", attempt: deps.collect(), graceAttempt: 0 };
	let guard = 0;
	while (out.kind === "evaluate" && guard++ < 100) {
		// Start the transition, then unstick it: a transition parked inside a
		// virtual delay only resolves when virtual time advances. A terminal
		// transition settles in microtasks — before the setTimeout(0) probe.
		const pending = graceTransition(out, deps);
		const stuck = await Promise.race([
			pending.then(() => false),
			new Promise<true>((r) => setTimeout(() => r(true), 0)),
		]);
		if (stuck) await clock.advance(2000);
		out = await pending;
	}
	return { out, clock, log };
}

async function main() {
	// --- G1. Sequence table -------------------------------------------------
	{
		const { out, clock } = await run({ attempts: [okAttempt()] });
		check(
			"G1.1 valid report immediately → collected at recheck 0",
			out.kind === "collected" && out.graceAttempt === 0 && clock.now() === 0,
			JSON.stringify(out.kind),
		);
	}
	{
		// missing report at every probe; the collect flips to valid on call #3
		// (after 3 rechecks — the machine re-collects after each delay)
		const { out, clock } = await run({
			attempts: [badAttempt("not readable"), badAttempt("not readable"), badAttempt("not readable"), okAttempt()],
			exists: [false],
		});
		check(
			"G1.2 report appears after 3 rechecks → collected, 3×delay virtual time",
			out.kind === "collected" && out.graceAttempt === 3 && clock.now() === 6000,
			`${out.kind}, grace=${out.kind === "collected" ? out.graceAttempt : "?"}, t=${clock.now()}`,
		);
	}
	{
		const q: QuestionEnvelope = { worker: "w", ts: "T0", question: "blocked?" };
		const { out } = await run({
			attempts: [badAttempt("not readable")],
			questions: [null, q],
			exists: [false], // missing → retryable → the ladder continues to the question poll
		});
		check(
			"G1.3 pending question on recheck → awaiting-answer with the question",
			out.kind === "awaiting-answer" && out.question.question === "blocked?",
			JSON.stringify(out.kind),
		);
	}
	{
		const { out, clock } = await run({
			attempts: [badAttempt("reportSchema: result.count must be integer")],
			exists: [true],
			parseFailure: [false],
		});
		check(
			"G1.4 stable schema rejection → exhausted at recheck 0 (never retried)",
			out.kind === "exhausted" && out.graceAttempt === 0 && clock.now() === 0,
			JSON.stringify(out.kind),
		);
	}
	{
		const { out, clock } = await run({
			attempts: [badAttempt("not readable")],
			exists: [false],
		});
		check(
			"G1.5 recheck budget exhausts → exhausted at graceAttempt 5",
			out.kind === "exhausted" && out.graceAttempt === 5 && clock.now() === 10000,
			`${out.kind}, grace=${out.kind === "exhausted" ? out.graceAttempt : "?"}, t=${clock.now()}`,
		);
	}

	// --- G2. Priority order -------------------------------------------------
	{
		const q: QuestionEnvelope = { worker: "w", ts: "T0", question: "blocked?" };
		// Valid collect + pending question on the SAME first poll → collected.
		const { out } = await run({ attempts: [okAttempt()], questions: [q] });
		check("G2.1 a valid collect outranks a pending question", out.kind === "collected");
	}

	// --- G3. Virtual clock (already asserted via t=… above; pin the total) --
	{
		const t0 = Date.now();
		await run({ attempts: [badAttempt("x")], exists: [false] });
		const elapsed = Date.now() - t0;
		check(
			"G3.1 the full recheck table runs without real waiting (< 2 s wall)",
			elapsed < 2000,
			`${elapsed} ms wall`,
		);
	}

	// --- G4. Abort during the injected delay --------------------------------
	{
		const clock = createVirtualClock(0);
		const log: string[] = [];
		const deps = makeDeps(
			{ attempts: [badAttempt("not readable")], exists: [false] },
			clock,
			log,
		);
		deps.signal = undefined;
		const state: GraceState = { kind: "evaluate", attempt: deps.collect(), graceAttempt: 0 };
		log.push("collect");
		// Abort BEFORE the delay resolves: transition → aborted.
		const abortController = new AbortController();
		deps.signal = abortController.signal;
		abortController.abort();
		const out = await graceTransition(state, deps);
		check(
			"G4.1 abort during the injected delay → aborted terminal (worker never killed)",
			out.kind === "aborted" && out.graceAttempt === 0,
			JSON.stringify(out.kind),
		);
	}

	// --- G5. Wiring pin -----------------------------------------------------
	{
		const src = readFileSync(join(ROOT, "src", "spawn.ts"), "utf8");
		const clockSrc = readFileSync(join(ROOT, "src", "clock.ts"), "utf8");
		check(
			"G5.1 execute feeds the machine with the system clock + the stage budget",
			src.includes("clock: systemClock") &&
				src.includes("maxRechecks: GRACE_RECHECKS") &&
				src.includes("delayMs: GRACE_DELAY_MS") &&
				src.includes("await runGraceLoop({"),
		);
		check(
			"G5.2 the virtual clock is exported for tests (the port seam)",
			// Wave 3 decomposition: the port lives in src/clock.ts now — the pin
			// follows the code.
			clockSrc.includes("export function createVirtualClock") && clockSrc.includes("export const systemClock"),
		);
	}

	if (failures > 0) {
		console.error(`\ngrace-loop-check: ${failures} FAILURE(S)`);
		process.exit(1);
	}
	console.log("\ngrace-loop-check: all checks passed");
}

await main();
