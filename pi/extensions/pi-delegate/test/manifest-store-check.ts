/**
 * Manifest storage port (migration stage 2, audit step 5).
 *
 * Run with: bun run test/manifest-store-check.ts   (from the extension dir)
 *
 * Checks:
 *   M1  Adapter parity — ONE scenario script runs against BOTH
 *       implementations (file-backed on a mkdtemp dir, in-memory Map) and
 *       the resulting manifests must be JSON-identical after every step
 *       (read / update / append / scan, including the fresh-dir base and
 *       the foreign-backend scan filter).
 *   M2  Competing writers on the IN-MEMORY store — the bug class that was
 *       previously reproducible only across processes (two writers read the
 *       same base, both write, one update is lost) is now a deterministic
 *       unit test: N concurrent update() folds all land, no lost update.
 *   M3  Tolerant reads — absent dir → null on both stores; corrupt file on
 *       the file store → null (never throws).
 *   M4  Single write protocol — the archive path no longer carries a second
 *       hand-rolled atomic-write implementation (audit step 5): the archive
 *       section of src/exchange.ts reuses the shared atomicWriteFileSync.
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	createFileManifestStore,
	createMemoryManifestStore,
	type ExchangeManifest,
	type ManifestWorker,
} from "../src/exchange.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function makeWorker(name: string, paneId: string, backend?: string): ManifestWorker {
	return {
		name,
		placement: {
			kind: "worktree",
			workspaceId: `ws-${name}`,
			paneId,
			branch: `delegate/${name}`,
			checkoutPath: `/tmp/nowhere/${name}`,
			...(backend ? { backend } : {}),
		} as ManifestWorker["placement"],
		briefPath: `/tmp/exchange/t/brief-${name}.md`,
		reportPath: `/tmp/exchange/t/report-${name}.json`,
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: "2026-09-11T00:00:00.000Z",
	};
}

function workerNames(m: ExchangeManifest | null): string[] {
	return m ? m.workers.map((w) => w.name) : [];
}

// Fixture hygiene (field lesson 2026-09-10): the file store's scan() is
// rooted at exchangeRoot() — sandbox the WHOLE run via
// $PI_DELEGATE_EXCHANGE_ROOT (read at call time) so the parity test never
// sees (or feeds) the live /tmp/exchange manifests.
const SANDBOX = mkdtempSync(join(tmpdir(), "manifest-store-root-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;
const FILE_DIR = join(SANDBOX, "task-file");
const MEMORY_DIR = join(SANDBOX, "task-mem");
const fileStore = createFileManifestStore();
const memStore = createMemoryManifestStore();

try {
	// ---------------------------------------------------------------------------
	// M1. Adapter parity — the same scenario over both stores, stepwise equal.
	// ---------------------------------------------------------------------------
	const dirs = { file: FILE_DIR, mem: MEMORY_DIR };
	const runScenario = async (store: typeof fileStore, dir: string): Promise<Array<unknown>> => {
		const trace: unknown[] = [];
		// 1. read on a fresh dir → null; scan is empty for this dir.
		trace.push(store.read(dir));
		// 2. append two workers (append-before-start shape).
		await store.append(dir, makeWorker("alpha", "pane-1"));
		await store.append(dir, makeWorker("beta", "pane-2"));
		// 3. update fold — rename alpha's report path.
		const after = await store.update(dir, (m) => ({
			...m,
			workers: m.workers.map((w) => (w.name === "alpha" ? { ...w, sessionPath: "/s/alpha.jsonl" } : w)),
		}));
		trace.push(after);
		// 4. read back.
		trace.push(store.read(dir));
		// 5. foreign-backend scan filter: a fake-backend entry is dropped, a
		//    legacy entry without backend is kept (fail-open), herdr kept.
		await store.append(dir, makeWorker("gamma", "pane-3", "fake"));
		await store.append(dir, makeWorker("delta", "pane-4", "herdr"));
		await store.append(dir, makeWorker("omega", "pane-5"));
		trace.push(store.scan().find((m) => m.workers.some((w) => w.name === "alpha")) ?? null);
		return trace;
	};

	const fileTrace = await runScenario(fileStore, dirs.file);
	const memTrace = await runScenario(memStore, dirs.mem);
	// The two stores live under different sandbox dirs — normalize the dir
	// path (and the task slug derived from it) before comparing traces.
	const norm = (v: unknown): unknown =>
		JSON.parse(
			JSON.stringify(v)
				.split(dirs.file)
				.join("<DIR>")
				.split(dirs.mem)
				.join("<DIR>")
				.split(basename(dirs.file))
				.join("<TASK>")
				.split(basename(dirs.mem))
				.join("<TASK>"),
		) as unknown;
	const firstDivergence = fileTrace.findIndex(
		(x, i) => JSON.stringify(norm(x)) !== JSON.stringify(norm(memTrace[i])),
	);
	check(
		"M1.1 file and memory stores produce identical scenario traces",
		firstDivergence === -1,
		`first divergence at trace index ${firstDivergence}`,
	);
	check(
		"M1.2 fresh-dir read is null on both stores",
		fileTrace[0] === null && memTrace[0] === null,
	);
	const scanned = fileTrace[3] as ExchangeManifest | null;
	check(
		"M1.3 scan filter: fake-backend dropped, legacy (no backend) + herdr kept — both stores",
		!!scanned &&
			JSON.stringify(workerNames(scanned)) === JSON.stringify(["alpha", "beta", "delta", "omega"]) &&
			JSON.stringify(workerNames(memTrace[3] as ExchangeManifest | null)) === JSON.stringify(workerNames(scanned)),
		JSON.stringify(scanned && workerNames(scanned)),
	);
	check(
		"M1.4 stored manifest on disk is JSON-identical to the memory store's",
		(() => {
			const onDisk = JSON.parse(readFileSync(join(FILE_DIR, "manifest.json"), "utf8")) as ExchangeManifest;
			return JSON.stringify(norm(onDisk)) === JSON.stringify(norm(memStore.read(MEMORY_DIR)));
		})(),
	);
	check(
		"M1.5 memory-store read returns a clone — mutating the result cannot corrupt the store",
		(() => {
			const m = memStore.read(MEMORY_DIR);
			if (!m) return false;
			m.workers.length = 0;
			return memStore.read(MEMORY_DIR)!.workers.length === 5;
		})(),
	);

	// ---------------------------------------------------------------------------
	// M2. Competing writers on the IN-MEMORY store — the previously
	//     untestable "multi-writer manifest" bug class, now deterministic.
	// ---------------------------------------------------------------------------
	{
		const dir = join(MEMORY_DIR, "competing");
		const N = 25;
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				memStore.append(dir, makeWorker(`w${String(i).padStart(2, "0")}`, `pane-w${i}`)),
			),
		);
		const m = memStore.read(dir);
		check(
			"M2.1 concurrent appends all land (no lost update)",
			!!m && m.workers.length === N,
			`expected ${N}, got ${m?.workers.length}`,
		);
		check(
			"M2.2 every competing writer's entry is intact (no torn fold)",
			!!m && m.workers.every((w, i) => w.name === `w${String(i).padStart(2, "0")}`),
		);
		// Concurrent read-modify-write folds (the update shape the collectors
		// and the retire pass use) — also must not lose updates.
		await Promise.all(
			m!.workers.map((w) =>
				memStore.update(dir, (mm) => ({
					...mm,
					workers: mm.workers.map((x) => (x.name === w.name ? { ...x, collectedAt: `2026-09-11T00:0${w.name.slice(1)}.000Z` } : x)),
				})),
			),
		);
		const m2 = memStore.read(dir);
		check(
			"M2.3 concurrent collectedAt folds all land",
			!!m2 && m2.workers.every((w) => typeof w.collectedAt === "string" && w.collectedAt.length > 0),
		);
	}

	// ---------------------------------------------------------------------------
	// M3. Tolerant reads.
	// ---------------------------------------------------------------------------
	{
		check("M3.1 absent dir → null on both stores", fileStore.read(join(FILE_DIR, "nope")) === null && memStore.read(join(MEMORY_DIR, "nope")) === null);
		const corruptDir = join(FILE_DIR, "corrupt");
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(join(corruptDir, "manifest.json"), "{ not json");
		check("M3.2 corrupt file → null, never throws (file store)", fileStore.read(corruptDir) === null);
		const badShape = join(FILE_DIR, "badshape");
		mkdirSync(badShape, { recursive: true });
		writeFileSync(join(badShape, "manifest.json"), JSON.stringify({ task: 42 }));
		check("M3.3 wrong-shape manifest → null (file store)", fileStore.read(badShape) === null);
	}

	// ---------------------------------------------------------------------------
	// M4. One atomic-write protocol (audit step 5: the archive's duplicate
	//     implementation is deleted).
	// ---------------------------------------------------------------------------
	{
		const src = readFileSync(resolve(import.meta.dir, "..", "src", "exchange.ts"), "utf8");
		const archiveIdx = src.indexOf("SECTION 2 — src/archive.ts");
		const section = archiveIdx >= 0 ? src.slice(archiveIdx) : "";
		check(
			"M4.1 the archive section carries no second tmp+rename implementation (uses the shared atomicWriteFileSync)",
			/atomicWriteFileSync\(manifestPath/.test(section) &&
				!/renameSync\(tmp, manifestPath\)/.test(section) &&
				!/\.tmp-\$\{process\.pid\}-\$\{Date\.now\(\)\}/.test(section),
		);
	}
} finally {
	rmSync(FILE_DIR, { recursive: true, force: true });
	rmSync(MEMORY_DIR, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nmanifest-store-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nmanifest-store-check: all checks passed");
