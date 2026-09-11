/**
 * Lifecycle module (migration stage 2, audit step 6) — the worker state
 * machine, the embodiment identity, and the stamp adapters.
 *
 * Run with: bun run test/lifecycle-check.ts   (from the extension dir)
 *
 * Checks:
 *   L1  Reducer table — every ALLOWED transition lands in the expected
 *       phase; every FORBIDDEN transition is a structured refusal; the
 *       reducer is TOTAL (garbage events never throw).
 *   L2  Terminality — closed / closed-early-failed refuse every event.
 *   L3  Explicit-force discipline — closing without a received report
 *       requires forced=true AND a non-empty violations list; with the
 *       report received/delivered/collected a plain close is legal.
 *   L4  Backward adapter — legacy entries (no embodiment field) read by
 *       stamps: retiredAt → closed, collectedAt → collected,
 *       retirableSince → report-delivered, none → placed-or-started.
 *   L5  Stamp adapters — stampCollected / stampRetireClockStart /
 *       stampRetireClockClear / stampRetired validate-then-patch; refusals
 *       never corrupt the entry; the physical stamp fields are unchanged.
 *   L6  Two embodiments of one name in one task dir — nextEmbodiment gives
 *       run 2 for the retry; the two entries derive independent states; a
 *       collect stamp for THIS placement never touches the predecessor
 *       (the invisible-live-worker / foreign-budget bug class).
 *   L7  Wiring pins — spawn.ts stamps collect through the reducer
 *       (stampCollected) and observe.ts routes all three retire stamps
 *       through the lifecycle helpers (replaces the stage-1 source-text
 *       pin C4.2 with an ownership pin + the behavioral L1–L6 checks).
 * Exit 0 only if all checks pass.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	closeWorker,
	embodimentKey,
	embodimentOf,
	nextEmbodiment,
	stateFromManifestWorker,
	stampCollected,
	stampRetireClockClear,
	stampRetireClockStart,
	stampRetired,
	transitionLifecycle,
	type LifecycleEvent,
	
	type WorkerLifecycleState,
} from "../src/lifecycle.ts";
import type { ManifestWorker } from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const T = "2026-09-11T00:00:00.000Z";

function worker(partial: Partial<ManifestWorker>): ManifestWorker {
	return {
		name: "alpha",
		placement: {
			kind: "worktree",
			workspaceId: "ws",
			paneId: "pane-1",
			branch: "delegate/alpha",
			checkoutPath: "/tmp/nowhere",
		},
		briefPath: "/b.md",
		reportPath: "/r.json",
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: T,
		...partial,
	};
}

const st = (phase: WorkerLifecycleState["phase"]): WorkerLifecycleState => ({ phase, at: T });

// ---------------------------------------------------------------------------
// L1. Reducer table
// ---------------------------------------------------------------------------

const ALLOWED: Array<[WorkerLifecycleState["phase"], LifecycleEvent, WorkerLifecycleState["phase"]]> = [
	["placed", { type: "start-proven", at: T }, "started"],
	["placed", { type: "start-refused", at: T }, "closed-early-failed"],
	["placed", { type: "closed", at: T, forced: true, violations: ["rollback"] }, "closed"],
	["placed-or-started", { type: "life-proof", at: T }, "working"],
	["placed-or-started", { type: "settled", at: T }, "settled"],
	["started", { type: "life-proof", at: T }, "working"],
	["started", { type: "settled", at: T }, "settled"],
	["started", { type: "start-refused", at: T }, "closed-early-failed"],
	["working", { type: "settled", at: T }, "settled"],
	["settled", { type: "report-received", at: T }, "report-received"],
	["settled", { type: "report-invalid", at: T }, "report-invalid"],
	["settled", { type: "question-pending", at: T }, "awaiting-answer"],
	["settled", { type: "start-refused", at: T }, "closed-early-failed"],
	["report-invalid", { type: "report-received", at: T }, "report-received"],
	["report-invalid", { type: "start-refused", at: T }, "closed-early-failed"],
	["awaiting-answer", { type: "worker-resumed", at: T }, "working"],
	["awaiting-answer", { type: "start-refused", at: T }, "closed-early-failed"],
	["report-received", { type: "report-delivered", at: T }, "report-delivered"],
	["report-received", { type: "collected", at: T }, "collected"],
	["report-delivered", { type: "collected", at: T }, "collected"],
	["collected", { type: "collected", at: T }, "collected"], // idempotent re-stamp
	["settled", { type: "collected", at: T }, "collected"], // pipeline collapse (untracked intermediates)
	["placed-or-started", { type: "collected", at: T }, "collected"],
	["working", { type: "collected", at: T }, "collected"],
	["awaiting-answer", { type: "collected", at: T }, "collected"],
	["report-invalid", { type: "collected", at: T }, "collected"],
];

const FORBIDDEN: Array<[WorkerLifecycleState["phase"], LifecycleEvent]> = [
	["placed", { type: "life-proof", at: T }],
	["placed", { type: "settled", at: T }],
	["placed", { type: "collected", at: T }],
	["placed", { type: "report-received", at: T }],
	["started", { type: "report-received", at: T }],
	["started", { type: "collected", at: T }],
	["working", { type: "life-proof", at: T }],
	["working", { type: "report-received", at: T }],
	["settled", { type: "life-proof", at: T }],
	["settled", { type: "worker-resumed", at: T }],
	["report-invalid", { type: "worker-resumed", at: T }],
	["awaiting-answer", { type: "settled", at: T }],
	["report-received", { type: "settled", at: T }],
	["report-received", { type: "report-invalid", at: T }],
	["report-delivered", { type: "settled", at: T }],
	["report-delivered", { type: "report-received", at: T }],
	["collected", { type: "settled", at: T }],
	["collected", { type: "report-received", at: T }],
];

for (const [from, event, to] of ALLOWED) {
	const r = transitionLifecycle(st(from), event);
	check(
		`L1 allowed: ${from} --${event.type}--> ${to}`,
		r.ok && r.next.phase === to,
		r.ok ? `got ${r.next.phase}` : r.error,
	);
}
for (const [from, event] of FORBIDDEN) {
	const r = transitionLifecycle(st(from), event);
	check(`L1 forbidden: ${from} rejects ${event.type}`, !r.ok, r.ok ? `landed in ${r.next.phase}` : "");
}

// Totality: garbage event shapes must yield a refusal, never a throw.
{
	let threw = false;
	try {
		const garbage = { type: "nonexistent-event" } as unknown as LifecycleEvent;
		const r = transitionLifecycle(st("working"), garbage);
		check("L1 totality: unknown event → refusal", !r.ok);
	} catch (err) {
		threw = true;
		check("L1 totality: unknown event → refusal", false, `threw: ${err}`);
	}
	if (!threw) check("L1 totality: reducer never throws", true);
}

// ---------------------------------------------------------------------------
// L2. Terminality
// ---------------------------------------------------------------------------

for (const terminal of ["closed", "closed-early-failed"] as const) {
	for (const event of [
		{ type: "start-proven", at: T },
		{ type: "settled", at: T },
		{ type: "collected", at: T },
		{ type: "closed", at: T, forced: true, violations: ["again"] },
	] as LifecycleEvent[]) {
		const r = transitionLifecycle(st(terminal), event);
		check(`L2 terminal: ${terminal} rejects ${event.type}`, !r.ok, r.ok ? r.next.phase : "");
	}
}

// ---------------------------------------------------------------------------
// L3. Explicit-force discipline on close
// ---------------------------------------------------------------------------

{
	check(
		"L3.1 close without report + no force → refused",
		!transitionLifecycle(st("working"), { type: "closed", at: T }).ok,
	);
	check(
		"L3.2 close without report, forced but no violations → refused",
		!transitionLifecycle(st("working"), { type: "closed", at: T, forced: true }).ok,
	);
	check(
		"L3.3 close without report, forced + violations → legal",
		transitionLifecycle(st("working"), { type: "closed", at: T, forced: true, violations: ["orphan pane"] }).ok,
	);
	check(
		"L3.4 close WITH collected report, no force → legal",
		transitionLifecycle(st("collected"), { type: "closed", at: T }).ok,
	);
	check(
		"L3.5 close WITH received report, no force → legal",
		transitionLifecycle(st("report-received"), { type: "closed", at: T }).ok,
	);
	check(
		"L3.6 closeWorker helper mirrors the discipline",
		!closeWorker(worker({}), { at: T }).ok &&
			!!closeWorker(worker({}), { at: T, forced: true, violations: ["manual teardown"] }).ok &&
			!!closeWorker(worker({ collectedAt: T }), { at: T }).ok,
	);
}

// ---------------------------------------------------------------------------
// L4. Backward adapter
// ---------------------------------------------------------------------------

{
	check(
		"L4.1 retiredAt → closed",
		stateFromManifestWorker(worker({ retiredAt: T })).phase === "closed",
	);
	check(
		"L4.2 collectedAt → collected",
		stateFromManifestWorker(worker({ collectedAt: T })).phase === "collected",
	);
	check(
		"L4.3 retirableSince (no retiredAt) → report-delivered",
		stateFromManifestWorker(worker({ retirableSince: T })).phase === "report-delivered",
	);
	check(
		"L4.4 no stamps → placed-or-started",
		stateFromManifestWorker(worker({})).phase === "placed-or-started",
	);
	check(
		"L4.5 precedence: retiredAt beats collectedAt",
		stateFromManifestWorker(worker({ collectedAt: T, retiredAt: T })).phase === "closed",
	);
}

// ---------------------------------------------------------------------------
// L5. Stamp adapters
// ---------------------------------------------------------------------------

{
	const live = worker({});
	const collected = stampCollected(live, T);
	check("L5.1 stampCollected on a live entry stamps collectedAt", collected.ok && collected.entry.collectedAt === T);
	const refail = stampCollected(worker({ retiredAt: T }), T);
	check("L5.2 stampCollected refuses a closed entry (entry untouched)", !refail.ok);
	const clock = stampRetireClockStart(live, T);
	check("L5.3 retire clock start stamps retirableSince", clock.ok && clock.entry.retirableSince === T);
	const clear = stampRetireClockClear(clock.ok ? clock.entry : live);
	check(
		"L5.4 retire clock clear removes retirableSince (and only it)",
		clear.ok && clear.entry.retirableSince === undefined && clear.entry.collectedAt === undefined,
	);
	const clearNoClock = stampRetireClockClear(live);
	check("L5.5 clock clear refused when no clock runs", !clearNoClock.ok);
	const retired = stampRetired(live, T);
	check("L5.6 stampRetired stamps retiredAt", retired.ok && retired.entry.retiredAt === T);
	const restamp = stampRetired(worker({ retiredAt: T }), T);
	check("L5.7 stampRetired refuses an already-closed entry (history never rewritten)", !restamp.ok);
}

// ---------------------------------------------------------------------------
// L6. Two embodiments of one name in one task dir
// ---------------------------------------------------------------------------

{
	const first = worker({
		name: "alpha",
		collectedAt: "2026-09-11T00:01:00.000Z",
		embodiment: { run: 1, placementRef: "herdr:pane:1" },
		sessionPath: "/s/run1.jsonl",
	});
	const second = worker({
		name: "alpha",
		embodiment: { run: 2, placementRef: "herdr:pane:2" },
		sessionPath: "/s/run2.jsonl",
	});

	check("L6.1 nextEmbodiment: first spawn → run 1", nextEmbodiment("alpha", "herdr:pane:1", []).run === 1);
	check(
		"L6.2 nextEmbodiment: same-name retry → run 2 (prior entries counted, never deleted)",
		nextEmbodiment("alpha", "herdr:pane:2", [first]).run === 2,
	);
	check(
		"L6.3 the two embodiments have different identity keys",
		embodimentKey(embodimentOf(first)) !== embodimentKey(embodimentOf(second)),
	);
	check(
		"L6.4 legacy entry (no embodiment field) → run 0 + placement ref inferred",
		(() => {
			const legacy = worker({ name: "alpha" });
			const e = embodimentOf(legacy);
			return e.run === 0 && e.placementRef === "pane-1";
		})(),
	);
	check(
		"L6.5 the two embodiments derive INDEPENDENT states (collected vs live)",
		stateFromManifestWorker(first).phase === "collected" &&
			stateFromManifestWorker(second).phase === "placed-or-started",
	);
	// The collect stamp for THIS placement (pane:2) must not touch the
	// predecessor embodiment (pane:1) — the invisible-live-worker fix.
	check(
		"L6.6 a collect stamp scoped by placementRef never re-stamps the predecessor",
		(() => {
			// This mirrors the spawn-side guard: entries with an identity stamp
			// only for the matching placementRef.
			const matchesThisRun = (w: ManifestWorker, ref: string) =>
				!w.embodiment || w.embodiment.placementRef === ref;
			const stamped = stampCollected(second, T);
			if (!stamped.ok) return false;
			const touched = matchesThisRun(first, "herdr:pane:2");
			return !touched && first.collectedAt === "2026-09-11T00:01:00.000Z" && stamped.entry.collectedAt === T;
		})(),
	);
	check(
		"L6.7 a closed predecessor never inherits the retry's stamps (reducer refusal)",
		(() => {
			const closedFirst = worker({ name: "alpha", retiredAt: T, embodiment: { run: 1, placementRef: "herdr:pane:1" } });
			return !stampCollected(closedFirst, T).ok;
		})(),
	);
}

// ---------------------------------------------------------------------------
// L7. Wiring pins (replaces the stage-1 C4.2 source-text pin: the collect
//     stamp and the retire stamps are reducer transitions, not raw writes)
// ---------------------------------------------------------------------------

{
	const spawnSrc = readFileSync(join(ROOT, "src", "spawn.ts"), "utf8");
	const observeSrc = readFileSync(join(ROOT, "src", "observe.ts"), "utf8");
	check(
		"L7.1 spawn stamps collect through the lifecycle reducer (stampCollected)",
		spawnSrc.includes("stampCollected(w, collectedAt)") &&
			spawnSrc.includes('from "./lifecycle.ts"'),
	);
	check(
		"L7.2 spawn writes the embodiment identity into the appended entry",
		spawnSrc.includes("nextEmbodiment(") && spawnSrc.includes("embodiment: { run: embodiment.run, placementRef: embodiment.placementRef }"),
	);
	check(
		"L7.3 observe routes all three retire stamps through the lifecycle helpers",
		observeSrc.includes("stampRetireClockStart(x,") &&
			observeSrc.includes("stampRetireClockClear(x)") &&
			observeSrc.includes("stampRetired(x,"),
	);
	check(
		"L7.4 no raw retire-stamp writes remain in observe (the raw patch shape is gone)",
		!/retirableSince: new Date\(nowMs\)\.toISOString\(\)/.test(observeSrc) &&
			!/retiredAt: new Date\(nowMs\)\.toISOString\(\)/.test(observeSrc),
	);
}

if (failures > 0) {
	console.error(`\nlifecycle-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nlifecycle-check: all checks passed");
