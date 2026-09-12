/**
 * fake-settle-check — migration stage 3 (audit step 8): the settle outcome is
 * the seam's DISCRIMINATED UNION, and the two field bug classes that used to
 * be reproducible only against live herdr are now deterministic on the fake
 * adapter (src/host/fake.ts):
 *
 *   F1  "сборка никогда не сообщает working" (§19.1c) — the backend never
 *       reports a start observation; the caller-owned completion proof
 *       (proofSettled — the canonical report file observed against the
 *       embodiment witness) settles the wait as "finished-before-watch"
 *       instead of burning the whole budget and false-reporting never-started.
 *   F2  "done состарился в idle" (§19.1b) — herdr ages done→idle within
 *       minutes, so a late watcher sees only idle; the proof distinguishes
 *       "finished before the watch attached" from "never started".
 *
 * Plus the full union coverage on the fake: settled / timeout /
 * never-started / started-confirmed / detached, a throwing proof tolerated,
 * and a proof that is never consulted when observations prove life.
 *
 * Run with: bun test/fake-settle-check.ts   (from repo root)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorkerHost } from "../src/host/fake.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const REPO = mkdtempSync(join(tmpdir(), "fake-settle-"));
async function settle(script: string[], req: Partial<Parameters<FakeWorkerHost["waitSettle"]>[0]> = {}) {
	const fake = new FakeWorkerHost({ repoPath: REPO, statusScript: script as never });
	const placement = await fake.place({ mode: "tab", repoPath: REPO, branch: "b", label: "l" });
	await fake.startAgent({ name: "w", placementRef: placement.placementRef!, provider: "p", model: "m", thinking: "t", timeoutMs: 1000 });
	return fake.waitSettle({ name: "w", timeoutMs: 5_000, ...req });
}

try {
	// --- F1: the backend NEVER reports working — the report proof completes ---
	{
		const r = await settle(["unknown", "unknown", "unknown"], { proofSettled: async () => true });
		check(
			"F1 backend never reports working → the report proof settles finished-before-watch",
			r.kind === "finished-before-watch" && r.status === "idle",
			JSON.stringify(r),
		);
	}
	{
		// Same shape with a proof that turns true only on a later slice — the
		// fake must keep polling while life is unproven, then settle on proof.
		let calls = 0;
		const r = await settle(["unknown", "unknown", "unknown"], {
			proofSettled: async () => ++calls >= 2,
		});
		check(
			"F1b the proof is polled per unproven slice (settles on slice 2, not at exhaustion)",
			r.kind === "finished-before-watch" && calls === 2,
			`kind=${r.kind} calls=${calls}`,
		);
	}

	// --- F2: done AGED into idle — the late-watcher shape ---
	{
		const r = await settle(["idle", "idle", "idle"], { proofSettled: async () => true });
		check(
			"F2 done aged into idle + report proof → finished-before-watch (no budget burn)",
			r.kind === "finished-before-watch" && r.status === "idle",
			JSON.stringify(r),
		);
	}
	{
		const r = await settle(["idle", "idle"], { proofSettled: async () => false });
		check(
			"F2b no proof (report absent) → honest never-started (D3 protection intact)",
			r.kind === "never-started" && r.status === "unknown",
			JSON.stringify(r),
		);
	}

	// --- Union coverage on the fake adapter ---
	{
		const r = await settle(["working", "idle"]);
		check("U1 working→idle settles (kind settled)", r.kind === "settled" && r.status === "idle", JSON.stringify(r));
	}
	{
		const r = await settle(["working", "working"]);
		check(
			"U2 proven start but budget exhausted → timeout with the last observed status",
			r.kind === "timeout" && r.status === "working",
			JSON.stringify(r),
		);
	}
	{
		const r = await settle(["unknown", "unknown"]);
		check("U3 no start observation, no proof → never-started", r.kind === "never-started", JSON.stringify(r));
	}
	{
		const r = await settle(["working", "working", "idle"], { releaseOnStarted: true });
		check(
			"U4 releaseOnStarted → started-confirmed on the first working observation",
			r.kind === "started-confirmed" && r.status === "working",
			JSON.stringify(r),
		);
	}
	{
		const ac = new AbortController();
		ac.abort();
		const r = await settle(["working", "idle"], { signal: ac.signal });
		check("U5 aborted wait detaches (kind detached, worker untouched)", r.kind === "detached", JSON.stringify(r));
	}
	{
		const r = await settle(["unknown", "unknown"], {
			proofSettled: async () => {
				throw new Error("boom");
			},
		});
		check("U6 throwing proof counts as not-proven (never blocks the wait)", r.kind === "never-started", JSON.stringify(r));
	}
	{
		let calls = 0;
		const r = await settle(["working", "idle"], {
			proofSettled: async () => {
				calls++;
				return true;
			},
		});
		check(
			"U7 the proof is never consulted when observations prove life",
			r.kind === "settled" && calls === 0,
			`kind=${r.kind} calls=${calls}`,
		);
	}
} finally {
	rmSync(REPO, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL FAKE SETTLE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
