/**
 * schema-version-check — Law 7 regression (Wave 4 item 3): the on-disk
 * contracts carry a schemaVersion; readers tolerate absent (legacy = v1),
 * accept 1, and treat a wrong/future version as tolerant-empty — never a
 * crash, never a misparse.
 *
 * Run with: bun test/schema-version-check.ts   (from repo root)
 *
 * Covers:
 *   1. manifest: write → stamped v1 → read ok; absent-version file → read ok;
 *      future-version file → tolerant-empty (null), no throw.
 *   2. question envelope: v1 → valid; absent → valid; future → invalid with
 *      a reason (never thrown).
 *   3. nudge-failed marker: v1 → read; future → null.
 *   4. answer envelope: writer stamps schemaVersion 1 (worker-side reader is
 *      out of this repo — the written bytes are pinned instead).
 *   5. release marker: writer stamps schemaVersion 1 (the watcher consumer
 *      gates on file EXISTENCE only — documented at ReleaseEnvelope).
 *   6. retire-stamp layer: write → stamped v1 → layer read; a future-version
 *      layer file is skipped, no throw.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateManifest, readManifest } from "../src/manifest-store.ts";
import { isSupportedSchemaVersion, EXCHANGE_SCHEMA_VERSION } from "../src/manifest-store.ts";
import {
	readNudgeFailedMarker,
	readQuestionState,
	writeAnswer,
	writeRelease,
	answerPathFor,
	nudgeFailedPathFor,
	questionPathFor,
	releasePathFor,
} from "../src/mailbox-store.ts";
import { readWatchStampLayers, updateWatchStamps, watchStampsPathFor } from "../src/watch-store.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = mkdtempSync(join(tmpdir(), `schema-version-`));
process.env.PI_DELEGATE_EXCHANGE_ROOT = ROOT;

// --- shared gate ------------------------------------------------------------
check("SV0 gate: undefined passes (absent = legacy v1)", isSupportedSchemaVersion(undefined));
check("SV0 gate: 1 passes", isSupportedSchemaVersion(1));
check("SV0 gate: 2 (future) rejected", !isSupportedSchemaVersion(2));
check("SV0 gate: garbage rejected", !isSupportedSchemaVersion("1"));

// --- 1. manifest ------------------------------------------------------------
{
	const dir = join(ROOT, "sv-manifest");
	await updateManifest(dir, (m) => ({ ...m, workers: [] }));
	const m = readManifest(dir);
	check("SV1 manifest write stamps schemaVersion 1", m?.schemaVersion === EXCHANGE_SCHEMA_VERSION, JSON.stringify(m?.schemaVersion));

	// Absent-version file (the pre-Wave-4 shape) → read ok.
	const path = join(dir, "manifest.json");
	const legacy = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	delete legacy.schemaVersion;
	writeFileSync(path, JSON.stringify(legacy, null, "\t") + "\n");
	check("SV2 manifest reader tolerates ABSENT version (legacy v1)", readManifest(dir)?.task === m?.task);

	// Hand-crafted future version → tolerant-empty (null), no throw.
	writeFileSync(path, JSON.stringify({ ...legacy, schemaVersion: 999 }, null, "\t") + "\n");
	let threw = false;
	let future: unknown;
	try {
		future = readManifest(dir);
	} catch {
		threw = true;
	}
	check("SV3 manifest future version → tolerant-empty (null), no throw", !threw && future === null, `threw=${threw} read=${JSON.stringify(future)}`);
}

// --- 2. question envelope ---------------------------------------------------
{
	const dir = join(ROOT, "sv-question");
	mkdirSync(dir, { recursive: true });
	const qPath = questionPathFor(dir, "w1");
	const base = { worker: "w1", ts: "2026-09-11T00:00:00.000Z", question: "Which shape?" };

	writeFileSync(qPath, JSON.stringify({ ...base, schemaVersion: EXCHANGE_SCHEMA_VERSION }));
	check("SV4 question v1 → valid", readQuestionState(qPath).state === "valid");

	writeFileSync(qPath, JSON.stringify(base));
	check("SV5 question ABSENT version → valid (legacy tolerated)", readQuestionState(qPath).state === "valid");

	writeFileSync(qPath, JSON.stringify({ ...base, schemaVersion: 42 }));
	const future = readQuestionState(qPath);
	check(
		"SV6 question future version → invalid WITH a reason, never a throw",
		future.state === "invalid" && /schemaVersion/.test(future.state === "invalid" ? future.error : ""),
		JSON.stringify(future),
	);
}

// --- 3. nudge-failed marker -------------------------------------------------
{
	const dir = join(ROOT, "sv-nudge");
	mkdirSync(dir, { recursive: true });
	const nPath = nudgeFailedPathFor(dir, "w1");
	writeFileSync(nPath, JSON.stringify({ schemaVersion: 1, name: "w1", ts: "2026-09-11T00:00:00.000Z", error: "boom" }));
	check("SV7 nudge-failed v1 → read ok", readNudgeFailedMarker(nPath)?.ts === "2026-09-11T00:00:00.000Z");
	writeFileSync(nPath, JSON.stringify({ schemaVersion: 3, name: "w1", ts: "2026-09-11T00:00:00.000Z", error: "boom" }));
	check("SV8 nudge-failed future version → tolerant-empty (null)", readNudgeFailedMarker(nPath) === null);
}

// --- 4./5. answer + release envelopes (writer stamps; bytes pinned) ---------
{
	const dir = join(ROOT, "sv-envelopes");
	mkdirSync(dir, { recursive: true });
	await writeAnswer(answerPathFor(dir, "w1"), "do X instead");
	const aRaw = readFileSync(answerPathFor(dir, "w1"), "utf8");
	check("SV9 answer envelope writer stamps schemaVersion 1", JSON.parse(aRaw).schemaVersion === EXCHANGE_SCHEMA_VERSION, aRaw);

	await writeRelease(releasePathFor(dir, "w1"));
	const rRaw = readFileSync(releasePathFor(dir, "w1"), "utf8");
	check("SV10 release marker writer stamps schemaVersion 1", JSON.parse(rRaw).schemaVersion === EXCHANGE_SCHEMA_VERSION, rRaw);
}

// --- 6. retire-stamp layer --------------------------------------------------
{
	const dir = join(ROOT, "sv-stamps");
	await updateWatchStamps(dir, "cafebabe", "w1", { retirableSince: "2026-09-11T00:00:00.000Z" });
	const raw = JSON.parse(readFileSync(watchStampsPathFor(dir, "cafebabe"), "utf8")) as Record<string, unknown>;
	check("SV11 stamp-layer writer stamps schemaVersion 1", raw.schemaVersion === EXCHANGE_SCHEMA_VERSION, JSON.stringify(raw));
	const layers = readWatchStampLayers(dir);
	check("SV12 stamp layer v1 reads back (stamps intact)", layers.length === 1 && layers[0]?.stamps.w1?.retirableSince === "2026-09-11T00:00:00.000Z", JSON.stringify(layers));

	// Hand-crafted future-version layer → the whole layer is skipped, no throw.
	writeFileSync(
		watchStampsPathFor(dir, "deadbeef"),
		JSON.stringify({ schemaVersion: 7, w1: { retiredAt: "2026-09-11T00:00:00.000Z" } }),
	);
	const after = readWatchStampLayers(dir);
	check(
		"SV13 future-version stamp layer skipped (tolerant-empty), no throw",
		after.length === 1 && after[0]?.watcherKey === "cafebabe",
		JSON.stringify(after),
	);
}

// --- self cleanup -----------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} SCHEMA-VERSION CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL SCHEMA-VERSION CHECKS PASSED");
