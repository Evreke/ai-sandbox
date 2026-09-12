/**
 * watch-tick-cost-check — Wave 4 item 5 regression (reliability finding 10):
 * the watcher tick's synchronous fleet-proportional I/O is cut by
 * fingerprint-keyed caches — satellite stamp layers re-read only when a
 * watch-*.json file moved; the grill-deck session-tail parse runs only when
 * the session file's fingerprint (mtime + size) moved.
 *
 * Run with: bun test/watch-tick-cost-check.ts   (from repo root; no live
 * herdr — the checks exercise the real cached paths with temp files).
 *
 * Covers:
 *   1. Two detectWorkerEvents ticks over an UNCHANGED session file → the
 *      1 MB tail parse happens ONCE (cache entry parseCount === 1); a
 *      changed file costs exactly one more parse.
 *   2. Two collectSnapshot ticks over UNCHANGED stamp layers → the layer
 *      read happens ONCE (readCount === 1); a rewritten layer costs one
 *      more read — and stamps stay correct (no semantics change).
 *   3. No cache passed → uncached behavior (parseCount/readCount untouched).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWorkerEvents, collectSnapshot, type DetectOptions, type WatchWorker } from "../src/watch-detect.ts";
import { type SessionToolCallCacheEntry } from "../src/usage.ts";
import { readWatchStampLayersCached, type StampLayerCacheEntry, updateWatchStamps, watchStampsPathFor } from "../src/watch-store.ts";
import { updateManifest } from "../src/manifest-store.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = mkdtempSync(join(tmpdir(), `tick-cost-`));

// --- 1. grill-deck tail parse gated by the session fingerprint --------------
{
	const sessionPath = join(ROOT, "session.jsonl");
	// A session tail with TWO grill_deck invocations (trailing newline — the
	// appended line in TC3 must not concatenate with the last one).
	writeFileSync(
		sessionPath,
		[
			JSON.stringify({ message: { content: [{ type: "toolCall", name: "grill_deck" }] } }),
			JSON.stringify({ message: { content: [{ type: "toolCall", name: "read" }] } }),
			JSON.stringify({ message: { content: [{ type: "toolCall", name: "grill_deck" }] } }),
		].join("\n") + "\n",
	);
	const cache = new Map<string, SessionToolCallCacheEntry>();
	const w: WatchWorker = {
		name: "w1",
		dir: ROOT,
		reportPath: join(ROOT, "report-w1.json"),
		sessionPath,
		// Proven owner: the entry's orchestratorSessionPath matches the watcher's
		// self session file — otherwise the fail-closed ownership gate (watcher
		// stage A) delivers zero events for this worker.
		orchestratorSessionPath: "orch.jsonl",
		live: true,
		kind: "tab",
		self: false,
		probe: false,
	};
	const opts: DetectOptions = { sessionToolCallCache: cache, selfSessionFile: "orch.jsonl" };
	const r1 = detectWorkerEvents(w, opts);
	const afterTick1 = cache.get(sessionPath)?.parseCount ?? 0;
	const r2 = detectWorkerEvents(w, opts);
	const afterTick2 = cache.get(sessionPath)?.parseCount ?? 0;
	check(
		"TC1 grill-deck event detected (2 decks) with the cached scan",
		r1.some((e) => e.kind === "grill-deck") && r2.some((e) => e.kind === "grill-deck"),
		JSON.stringify(r1.map((e) => e.kind)),
	);
	check(
		"TC2 two ticks over an UNCHANGED fingerprint → the tail parse happened ONCE",
		afterTick1 === 1 && afterTick2 === 1,
		`parseCount tick1=${afterTick1} tick2=${afterTick2}`,
	);
	// The file MOVES (append + fresh mtime) → exactly one more parse, and a
	// third deck is detected (semantics unchanged — every event detectable).
	writeFileSync(
		sessionPath,
		readFileSync(sessionPath, "utf8") +
			JSON.stringify({ message: { content: [{ type: "toolCall", name: "grill_deck" }] } }) +
			"\n",
	);
	utimesSync(sessionPath, new Date(), new Date());
	const r3 = detectWorkerEvents(w, opts);
	const afterTick3 = cache.get(sessionPath)?.parseCount ?? 0;
	check(
		"TC3 changed fingerprint → exactly one more parse, new count detected",
		afterTick3 === 2 && r3.some((e) => e.kind === "grill-deck") && r3.find((e) => e.kind === "grill-deck")?.fingerprint === "3",
		`parseCount=${afterTick3} fp=${r3.find((e) => e.kind === "grill-deck")?.fingerprint}`,
	);
	// No cache → uncached path untouched (the cache map is not consulted).
	const r4 = detectWorkerEvents(w, { selfSessionFile: "orch.jsonl" });
	check("TC4 uncached call still detects the event", r4.some((e) => e.kind === "grill-deck"));
}

// --- 2. stamp layers gated by the (name, mtime) snapshot --------------------
{
	const dir = join(ROOT, "stamps");
	await updateWatchStamps(dir, "cafebabe", "w1", { retirableSince: "2026-09-11T00:00:00.000Z" });
	const cache = new Map<string, StampLayerCacheEntry>();
	const l1 = readLayers(dir, cache);
	const afterRead1 = cache.get(dir)?.readCount ?? 0;
	const l2 = readLayers(dir, cache);
	const afterRead2 = cache.get(dir)?.readCount ?? 0;
	check(
		"TC5 two snapshot ticks over UNCHANGED layers → ONE layer read, stamps identical",
		afterRead1 === 1 &&
			afterRead2 === 1 &&
			JSON.stringify(l1) === JSON.stringify(l2) &&
			l1[0]?.stamps.w1?.retirableSince === "2026-09-11T00:00:00.000Z",
		`readCount=${afterRead1}/${afterRead2}`,
	);
	// The layer file is rewritten (watcher stamps retiredAt) → one more read,
	// and the new stamp is visible (no semantics change).
	await updateWatchStamps(dir, "cafebabe", "w1", { retirableSince: "2026-09-11T00:00:00.000Z", retiredAt: "2026-09-11T01:00:00.000Z" });
	// BUG_FIX_CONTEXT (TC6 flake, two independent sightings on this host):
	// symptom — the rewritten layer sometimes read as UNCHANGED (readCount
	// stayed 1, the new stamp invisible): the cache compares per-file mtimeMs,
	// and on this host the mtime quantization is coarse — a rewrite landing in
	// the same quant as the initial write produces the SAME statSync mtimeMs,
	// so the change is invisible. Why the rewrite alone did not work: natural
	// write timestamps are not guaranteed to cross a quant boundary. What was
	// done: force the rewritten layer's mtime to a fixed timestamp far above
	// the natural one (same deterministic-utimes trick the session-file block
	// above already uses) — the changed-cache-detected path becomes clock-
	// controlled, the test measures the cache logic, not the host clock.
	utimesSync(watchStampsPathFor(dir, "cafebabe"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
	const l3 = readLayers(dir, cache);
	const afterRead3 = cache.get(dir)?.readCount ?? 0;
	check(
		"TC6 rewritten layer → exactly one more read, new stamps visible",
		afterRead3 === 2 && l3[0]?.stamps.w1?.retiredAt === "2026-09-11T01:00:00.000Z",
		`readCount=${afterRead3}`,
	);
}

// --- 3. the REAL snapshot path: collectSnapshot with the cache --------------
{
	const dir = join(ROOT, "snap");
	await updateWatchStamps(dir, "cafebabe", "w1", { retirableSince: "2026-09-11T00:00:00.000Z" });
	// A minimal manifest via the real store writer.
	process.env.PI_DELEGATE_EXCHANGE_ROOT = ROOT;
	await updateManifest(dir, (m) => ({
		...m,
		workers: [
			{
				name: "w1",
				placement: { kind: "tab", checkoutPath: ROOT } as never,
				briefPath: "",
				reportPath: join(dir, "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: new Date().toISOString(),
			},
		],
	}));
	const stubTransport = {
		listStatuses: async () => [],
		backendName: () => "herdr",
	} as never;
	const cache = new Map<string, StampLayerCacheEntry>();
	await collectSnapshot(stubTransport, {}, Date.now(), cache);
	const c1 = cache.get(dir)?.readCount ?? 0;
	await collectSnapshot(stubTransport, {}, Date.now(), cache);
	const c2 = cache.get(dir)?.readCount ?? 0;
	check(
		"TC7 two REAL collectSnapshot ticks over unchanged layers → ONE layer read",
		c1 === 1 && c2 === 1,
		`readCount=${c1}/${c2}`,
	);
}

// --- helpers ----------------------------------------------------------------
function readLayers(dir: string, cache: Map<string, StampLayerCacheEntry>) {
	// Direct use of the exported cached reader (the same call
	// workersFromManifests makes).
	return readWatchStampLayersCached(dir, cache);
}

// --- self cleanup -----------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} WATCH-TICK-COST CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL WATCH-TICK-COST CHECKS PASSED");
