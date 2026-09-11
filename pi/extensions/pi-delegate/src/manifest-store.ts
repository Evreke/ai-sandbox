/**
 * pi-delegate — src/manifest-store.ts (Wave 3a: extracted from src/exchange.ts).
 *
 * MODULE_CONTRACT — manifest types, the read/update protocol and the
 * manifest STORAGE PORT.
 *
 * Purpose: /tmp/exchange/<task>/manifest.json conventions — the manifest
 * types (ManifestWorker, ExchangeManifest, TaskUsageSnapshot), the tolerant
 * read (readManifest), the mutate-and-persist protocol (updateManifest,
 * serialized per path + atomic tmp+rename), the ManifestStore port (read/
 * update/append/scan) with its file-backed and in-memory implementations
 * and the process-default `manifestStore` singleton, plus the global
 * manifest scan (scanAllManifests + the foreign-backend filter).
 *
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue),
 * node builtins, ./host.ts (Placement type ONLY — never the herdr
 * implementation), ./exchange.ts (exchangeRoot for the scan — a deliberate
 * module cycle: ESM live bindings resolve it, nothing reads the imported
 * binding at module-eval time) and ./archive.ts → the ONE atomic writer.
 *
 * Critical invariants OWNED here:
 *   - append-before-start (manifest side): worker entries are appended by
 *     the spawn flow THROUGH updateManifest; its withFileMutationQueue
 *     serialization is what makes the claim/rollback protocol safe against
 *     parallel spawns.
 *   - manifest writes are atomic (tmp+rename via the ONE shared
 *     atomicWriteFileSync, which now FSYNCS the tmp file before the rename —
 *     Wave 4 item 4, crash consistency: a crash after rename can no longer
 *     leave a renamed-but-never-flushed empty/short file) and serialized via
 *     withFileMutationQueue on the target path.
 *   - F1 usage cache is a CACHE, not authority (readers never write).
 *
 * All bodies are byte-verbatim moves from src/exchange.ts (Wave 3a).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Placement } from "./host.ts";
import { exchangeRoot } from "./exchange.ts";

// ---------------------------------------------------------------------------
// Law 7 — on-disk formats are versioned contracts (shared version gate)
// ---------------------------------------------------------------------------

/** Schema version stamped by the WRITERS of the exchange-layer on-disk
 *  contracts (manifest, mailbox answer/release/nudge-failed envelopes, the
 *  watcher retire-stamp layers). Convention (the delivered-store pattern):
 *  absent means version 1 (pre-versioning files read as v1); a reader
 *  accepts absent/1 and treats any OTHER value — a future version it cannot
 *  parse — as tolerant-empty (never a crash, never a misparse). */
export const EXCHANGE_SCHEMA_VERSION = 1;

/** The shared version gate for the exchange-layer contracts (Law 7).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: v — the raw `schemaVersion` value read from a file (may be absent)
 * Output: true when the reader may parse the file (absent = legacy v1, or
 *   exactly the current version); false when the version is wrong/future
 * Guarantees: pure; never throws
 * Raises: never
 */
export function isSupportedSchemaVersion(v: unknown): boolean {
	return v === undefined || v === EXCHANGE_SCHEMA_VERSION;
}

/**
 * Atomic file write (tmp + rename) — the ONE shared writer protocol of the
 * exchange layer (moved here from src/archive.ts, which now imports it from
 * this module; audit step 5: exactly one implementation must exist).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — the target file path; content — the full file content
 * Output: none (the file at `path` holds `content`)
 * Guarantees:
 *   - atomic: content lands via tmp file + rename (atomic on the same
 *     filesystem); a concurrent reader never sees a half-written file
 *   - crash-consistent (Wave 4 item 4): the tmp file's bytes are fsync'd
 *     BEFORE the rename — open → write → fsync → close → rename, one
 *     protocol at this one call site. Directory fsync is deliberately
 *     OMITTED: the durability target is "a renamed file holds the full
 *     content", not "the directory entry survives a power loss" — the
 *     exchange dir itself is long-lived (created once, far earlier than any
 *     write), and a POSIX-optional directory fsync would add a
 *     platform-dependent failure mode (EINVAL on some filesystems) to every
 *     write for no gain on that target.
 * Raises:
 *   - propagates filesystem errors (callers decide tolerance)
 */
export function atomicWriteFileSync(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	// open → write → fsync → close (Wave 4 item 4: flush the tmp file's bytes
	// to stable storage BEFORE the rename makes it visible at `path`).
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, content, null, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path); // rename is atomic on the same filesystem
}

export interface ManifestWorker {
	/** Canonical (herdr-confirmed) name. */
	name: string;
	placement: Placement;
	briefPath: string;
	reportPath: string;
	provider: string;
	model: string;
	thinking: string;
	startedAt: string; // ISO 8601
	/** Worker session JSONL path (budget accounting, DESIGN.md §14) — captured
	 *  from the herdr `agent start` result when the transport exposes it. */
	sessionPath?: string;
	/** Resolved effective budget for the spawn (per-call > config > default),
	 *  recorded so delegate_status can display usage against the real budget. */
	budgetTokens?: number;
	/** v1.5 (DESIGN.md §17): resolved report-schema provenance chain
	 *  ("inline" / library type names, in resolution order). */
	schemaProvenance?: string[];
	/** v1.5 (DESIGN.md §17): MERGED report-schema fragment the report was held
	 *  to — quoted when collect rejects a report, so failures are auditable. */
	reportSchemaFragment?: Record<string, unknown>;
	/** ISO 8601 — set by COLLECT only, on successful report delivery. The
	 *  watcher reads it to stay silent about an already-collected report (its
	 *  `seen` dedup lives only inside a session, so a fresh session would
	 *  otherwise re-wake on old reports). The watcher never writes it. */
	collectedAt?: string;
	/** Session JSONL path of the ORCHESTRATOR that spawned this worker, captured
	 *  through the live sessionManager getter at spawn time. The watcher wakes
	 *  only this session (ownership by session path — the `isSelf` idiom);
	 *  absent on legacy manifests → legacy behavior (every session sees the
	 *  events). Deliberately NOT refreshed on /new or /resume: a new session
	 *  inherits no wake-ups. Written only by spawn; the watcher is a reader. */
	orchestratorSessionPath?: string;
	/** §23 retire: ISO 8601 — set by the WATCHER the first tick all three
	 *  retirable conditions hold. Migration stage 3 (audit steps 6/10): the
	 *  watcher stamps live in ITS satellite file (watch-<key>.json in the task
	 *  dir) — this manifest field is the LEGACY layer, still read (readers
	 *  merge layers; earliest stamp wins) and still written only in the
	 *  degraded-self-id "anon" corner. Persisted (never memory-only) so a
	 *  watcher restart cannot lose the TTL clock; cleared again when the
	 *  worker leaves the retirable state (the clock restarts on the next
	 *  transition). */
	retirableSince?: string;
	/** §23 retire: ISO 8601 — set by the WATCHER after a successful close
	 *  (ACK or TTL, or immediate for probes). Same satellite relocation as
	 *  retirableSince: the watcher's close stamp lives in its satellite file;
	 *  this field is the legacy layer, merged by readers. The entry itself is
	 *  NEVER deleted — history stays — and a retired entry silences every
	 *  watcher event kind (the close is the expected cause of any herdr
	 *  absence). */
	retiredAt?: string;
	/** Migration stage 2 (audit step 6) — the ONLY manifest format extension:
	 *  identity of THIS embodiment of the worker name (run ordinal + opaque
	 *  placementRef; the name lives in the entry's own `name` field). Written
	 *  by spawn at append time; a same-name retry in the same task dir gets
	 *  the next run ordinal, so two embodiments of one name are
	 *  distinguishable (the "invisible live worker" bug class). Absent on
	 *  legacy entries — the lifecycle backward adapter (src/lifecycle.ts,
	 *  stateFromManifestWorker) reads their state from the stamps:
	 *  collectedAt → collected, retire stamps → closed/report-delivered,
	 *  no stamps → placed-or-started. External consumers of the manifest
	 *  (the merge result) are unchanged — the field is optional and additive. */
	embodiment?: { run: number; placementRef: string };
}

/** F1: cached fleet usage roll-up (aggregateTaskUsage {persist:true}). The
 *  worker session JSONLs are the source of truth — this snapshot exists so
 *  the last-known totals survive session-file pruning/restarts; every read
 *  path recomputes and treats this field as advisory history. */
export interface TaskUsageSnapshot {
	/** Fleet size (manifest worker entries; entries are never deleted). */
	workers: number;
	/** Σ output tokens across workers (the honest-effort measure). */
	outputTokens: number;
	/** Σ cache-read tokens (prompt-cache hits) across workers. */
	cacheReadTokens: number;
	/** Σ input tokens across workers — the sent-data volume proxy (prompt
	 *  bytes are not recorded in session JSONL; input tokens are). */
	sentTokens: number;
	/** Σ assistant messages across workers (loop/thrash detector). */
	turns: number;
	/** Worker names whose usage could NOT be counted: no sessionPath in the
	 *  manifest, or the session file missing/unreadable. Totals are partial
	 *  whenever this is non-empty — never an error. */
	partial: string[];
	/** ISO 8601 — when this snapshot was computed/persisted. */
	computedAt: string;
}

export interface ExchangeManifest {
	/** Law 7 (Wave 4 item 3): format version. Written as 1 by every writer;
	 *  the reader accepts absent (legacy = v1) or 1 and returns null for any
	 *  other value (a future version must never misparse). */
	schemaVersion?: number;
	task: string;
	dir: string;
	/** F1: human fleet description (3–10 words), derived ONCE by the FIRST
	 *  delegate call of the task via describeFleet(brief); never overwritten
	 *  by later spawns. Absent on legacy manifests / when no meaningful brief
	 *  line was found. */
	description?: string;
	/** F1: session JSONL of the MASTER orchestrator that spawned the fleet —
	 *  hoisted from the first spawn's orchestratorSessionPath; set once, never
	 *  refreshed (a later spawn is a fleet member, not the master). */
	masterSessionPath?: string;
	/** F1: cached usage snapshot — see TaskUsageSnapshot. */
	usage?: TaskUsageSnapshot;
	workers: ManifestWorker[];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function manifestPath(dir: string): string {
	return resolve(dir, "manifest.json");
}

/**
 * Read the manifest; null when absent (first worker of a task) or corrupt.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the task's exchange dir
 * Output: parsed ExchangeManifest, or null
 * Guarantees:
 *   - tolerant read: missing file, unreadable file, corrupt JSON or a shape
 *     missing task/dir/workers all return null — never throws
 * Raises: never
 */
export function readManifest(dir: string): ExchangeManifest | null {
	const path = manifestPath(dir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent (or unreadable) → treat as no manifest yet
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ExchangeManifest>;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.task !== "string" ||
			typeof parsed.dir !== "string" ||
			!Array.isArray(parsed.workers)
		) {
			return null; // corrupt → tolerant read, no throw
		}
		// Law 7 (Wave 4 item 3): a wrong/future schemaVersion is a tolerant-empty
		// read (null — same plane as corrupt), never a misparse.
		if (!isSupportedSchemaVersion(parsed.schemaVersion)) return null;
		return parsed as ExchangeManifest;
	} catch {
		return null;
	}
}

/**
 * Mutate-and-persist the manifest. Must serialize concurrent mutations
 * (use withFileMutationQueue from @earendil-works/pi-coding-agent on the
 * manifest path) so parallel delegate calls cannot clobber each other.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - mutate: pure fold over the current manifest (may receive a fresh empty
 *     base when no manifest exists yet)
 * Output: resolves with the persisted manifest
 * Guarantees:
 *   - serialized per path via withFileMutationQueue; atomic write (tmp+rename)
 *   - creates the dir on demand
 * Raises:
 *   - propagates filesystem errors (callers treat manifest writes as
 *     best-effort bookkeeping and degrade with a warning)
 */
export function updateManifest(
	dir: string,
	mutate: (m: ExchangeManifest) => ExchangeManifest,
): Promise<ExchangeManifest> {
	const path = manifestPath(dir);
	return withFileMutationQueue(path, async () => {
		mkdirSync(dir, { recursive: true });
		const current = readManifest(dir);
		const base: ExchangeManifest = current ?? { task: basename(dir), dir: resolve(dir), workers: [] };
		// Law 7: every writer stamps the current schema version (additive field).
		const next: ExchangeManifest = { ...mutate(base), schemaVersion: EXCHANGE_SCHEMA_VERSION };
		atomicWriteFileSync(path, JSON.stringify(next, null, "\t") + "\n");
		return next;
	});
}

// ---------------------------------------------------------------------------
// Manifest storage port (migration stage 2, audit step 5)
// ---------------------------------------------------------------------------

/**
 * The manifest STORAGE PORT: every manifest consumer programs against this
 * interface, never against the file protocol directly. Four operations (the
 * audit's 4–5-method seam): read, update, append, scan.
 * <p>
 * MODULE_CONTRACT (port):
 *   - read(dir) — tolerant read; null when absent/corrupt (never throws)
 *   - update(dir, mutate) — read-modify-write; implementations MUST serialize
 *     concurrent updates so no mutation is lost (file impl: per-path mutation
 *     queue; memory impl: synchronous apply inside the async step)
 *   - append(dir, entry) — add one worker entry (the append-before-start
 *     write); implemented as an update fold on both implementations
 *   - scan() — every readable manifest under the store's root, with foreign-
 *     backend worker entries filtered (the foreign-backend rule — behavior
 *     unchanged from scanAllManifests; migration stage 3, audit step 9: the
 *     active backend comes in as a scan PARAMETER — callers read it from the
 *     bound transport's backendName(); the old ACTIVE_HOST constant is gone)
 * Two implementations ship: createFileManifestStore (the production
 * behavior, byte-identical to the pre-port read/update/scan functions) and
 * createMemoryManifestStore (in-memory Map — makes the previously
 * untestable competing-writers class of bugs deterministically testable).
 * Parity between the two is pinned by test/manifest-store-check.ts.
 */
export interface ManifestStore {
	read(dir: string): ExchangeManifest | null;
	update(
		dir: string,
		mutate: (m: ExchangeManifest) => ExchangeManifest,
	): Promise<ExchangeManifest>;
	append(dir: string, entry: ManifestWorker): Promise<ExchangeManifest>;
	scan(backendName: string): ExchangeManifest[];
}

/**
 * File-backed ManifestStore — the production implementation. Thin delegation
 * to readManifest/updateManifest/scanAllManifests (the pre-port functions,
 * kept verbatim so behavior cannot drift).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: a ManifestStore backed by the on-disk manifests under exchangeRoot()
 * Guarantees:
 *   - behavior identical to the pre-port readManifest/updateManifest/
 *     scanAllManifests (parity-pinned by test/manifest-store-check.ts)
 *   - scan() honors $PI_DELEGATE_EXCHANGE_ROOT at CALL time (test sandboxing)
 * Raises: per-operation semantics inherit from the wrapped functions (read/
 *   scan tolerant; update propagates fs errors)
 */
export function createFileManifestStore(): ManifestStore {
	return {
		read: (dir) => readManifest(dir),
		update: (dir, mutate) => updateManifest(dir, mutate),
		append: (dir, entry) =>
			updateManifest(dir, (m) => ({ ...m, workers: [...m.workers, entry] })),
		scan: (backendName) => scanAllManifests(backendName),
	};
}

/**
 * In-memory ManifestStore — manifests live in a Map keyed by the resolved
 * task dir. The test double that turns the manifest's competing-writers bug
 * class (previously reproducible only across processes) into a
 * deterministic unit test: update() reads and writes within ONE synchronous
 * step (no await between read and set), so concurrent updates compose
 * instead of clobbering.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: a ManifestStore keeping all state in process memory
 * Guarantees:
 *   - read/update/append/scan parity with the file store for well-formed
 *     inputs (parity-pinned by test/manifest-store-check.ts)
 *   - returned manifests are structured clones — callers cannot mutate the
 *     store's internal state through a read result
 *   - a fresh dir gets the same base the file impl would write
 *     ({ task: basename, dir: resolved, workers: [] })
 *   - scan() applies the same foreign-backend filter as the file impl (the
 *     active backend comes in as the scan parameter — audit step 9)
 * Raises: never (no fs access)
 */
export function createMemoryManifestStore(): ManifestStore {
	const manifests = new Map<string, ExchangeManifest>();
	const store: ManifestStore = {
		read(dir) {
			const m = manifests.get(resolve(dir));
			return m ? (structuredClone(m) as ExchangeManifest) : null;
		},
		async update(dir, mutate) {
			const key = resolve(dir);
			const current = manifests.get(key);
			const base: ExchangeManifest = current ?? { task: basename(key), dir: key, workers: [] };
			// Law 7: stamp parity with the file writer (every writer stamps v1).
			const next: ExchangeManifest = { ...mutate(base), schemaVersion: EXCHANGE_SCHEMA_VERSION };
			manifests.set(key, next);
			return structuredClone(next) as ExchangeManifest;
		},
		append(dir, entry) {
			return store.update(dir, (m) => ({ ...m, workers: [...m.workers, entry] }));
		},
		scan(backendName) {
			return [...manifests.values()].map((m) => filterForeignBackendWorkers(m, backendName));
		},
	};
	return store;
}

/** The process-default manifest store: file-backed, production behavior.
 *  Consumers import THIS, never the raw functions. */
export const manifestStore: ManifestStore = createFileManifestStore();

// ---------------------------------------------------------------------------
// Global scan
// ---------------------------------------------------------------------------

/**
 * Scan all /tmp/exchange/<task>/manifest.json — the delegate_status data source.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: activeBackend — the caller's backend name (the transport seam's
 *   backendName(), bound at the composition root — migration stage 3, audit
 *   step 9; the old module-local ACTIVE_HOST constant is gone)
 * Output: every readable manifest found under /tmp/exchange (one per task
 *   dir), with foreign-backend worker entries filtered out
 * Guarantees:
 *   - tolerant: a missing exchange root or unreadable dir → empty array;
 *     corrupt manifests are skipped individually
 *   - legacy entries (no/blank placement.backend) fail open (kept); a
 *     non-empty backend different from activeBackend is dropped
 *   - order follows directory listing order (not sorted)
 * Raises: never
 * EXTERNAL_DEPENDENCY: the exchange root (exchangeRoot() — /tmp/exchange by
 *   default, $PI_DELEGATE_EXCHANGE_ROOT override for sandboxed tests;
 *   must exist or the scan returns nothing).
 */
export function scanAllManifests(activeBackend: string): ExchangeManifest[] {
	const root = exchangeRoot();
	let entries: string[];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return []; // no exchange dir yet
	}
	const manifests: ExchangeManifest[] = [];
	for (const task of entries) {
		const m = readManifest(resolve(root, task));
		if (!m) continue;
		manifests.push(filterForeignBackendWorkers(m, activeBackend));
	}
	return manifests;
}

/**
 * Drop manifest worker entries whose placement declares a backend the caller's
 * host cannot see (field lesson 2026-09-10, workerhost migration step 4: a
 * test fixture with backend:"fake" in the LIVE exchange root woke a bystander
 * orchestrator — the legacy scan was fail-open on ANY entry). Migration stage
 * 3 (audit step 9): the active backend comes in as a PARAMETER — the caller
 * reads it from the bound transport's backendName() (composition root,
 * index.ts); the old module-local ACTIVE_HOST constant is gone, so no module
 * can scan with an implicit backend. Legacy entries (no/blank backend) are
 * kept unchanged. Tolerant: a garbage placement reads as legacy (no backend)
 * → kept, never throws.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: m — a parsed manifest; activeBackend — the caller's backend name
 *   (the transport seam's backendName() spelling)
 * Output: the same manifest with foreign-backend worker entries removed
 * Guarantees:
 *   - backend === activeBackend or absent → entry kept (legacy fail-open)
 *   - a different non-empty backend → entry skipped (never wakes this host)
 *   - the manifest object is not mutated in place when nothing is dropped
 * Raises: never
 */
function filterForeignBackendWorkers(m: ExchangeManifest, activeBackend: string): ExchangeManifest {
	const kept = m.workers.filter((w) => {
		const backend = (w as { placement?: { backend?: unknown } } | null)?.placement?.backend;
		return !(typeof backend === "string" && backend.length > 0 && backend !== activeBackend);
	});
	return kept.length === m.workers.length ? m : { ...m, workers: kept };
}
