/**
 * pi-delegate — src/watch-store.ts (Wave 3a: extracted from src/exchange.ts).
 *
 * MODULE_CONTRACT — the watcher's satellite persistence.
 *
 * Purpose: the per-watcher satellite files in the task dir, both families:
 *   - the retire-stamp layers (watch-<watcherKey>.json — retirableSince /
 *     retiredAt; readers MERGE manifest layer + satellite layers, earliest
 *     stamp wins; writer: updateWatchStamps, owner-exclusive file);
 *   - the durable delivered-facts store (delivered-<watcherKey>.json,
 *     watcher stage B — committed after a successful wake-up send; records
 *     are only ADDED, removal is GC-only when a worker really disappears).
 * Both share the same watcherKey convention (FNV-1a of the session JSONL
 * path, "anon" for a degraded self-id) and the same single-writer
 * discipline (one writer session per file BY FILE NAME; in-process
 * serialization via withFileMutationQueue) — that shared identity is why
 * they live in ONE module.
 *
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue),
 * node builtins, ./manifest-store.ts (the ONE atomic writer).
 *
 * Critical invariants OWNED here:
 *   - single-writer per satellite file by construction (file name carries
 *     the watcher key); writes atomic + idempotent (no-change → no write);
 *   - reads are tolerant: missing/corrupt/torn files read as empty — a torn
 *     read costs at most one repeated wake-up, never a throw;
 *   - the manifest FORMAT for external consumers is unchanged — the
 *     satellite files are the agreed exception (migration stage 3).
 *
 * All bodies are byte-verbatim moves from src/exchange.ts (Wave 3a).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./manifest-store.ts";

// ---------------------------------------------------------------------------
// Observer stamps — the watcher's satellite file (migration stage 3, audit
// steps 6/10). The stamps the WATCHER writes (retirableSince — the persisted
// retire-TTL clock; retiredAt — the successful close marker) leave the
// manifest: the manifest stays the SPAWNING session's artifact (single writer
// per file — the lost-update hazard between a watcher stamp and a concurrent
// owner-side manifest write becomes impossible BY CONSTRUCTION). Each watcher
// session owns exactly one satellite file per task dir (watch-<watcherKey>.json,
// watcherKey = FNV-1a of the watcher's session JSONL path; "anon" for a
// degraded self-id — shared, but strictly no worse than the old shared
// manifest). Readers MERGE the layers: manifest fields first, then every
// satellite file in the dir; the earliest stamp per field wins (the earliest
// clock start / the first close is the truth). The manifest FORMAT for
// external consumers is unchanged — the satellite is the agreed exception.
// ---------------------------------------------------------------------------

/** The retire stamps as they live in a layer (manifest fields or satellite
 *  entries). Shape mirrors the manifest worker fields. */
export interface RetireStamps {
	retirableSince?: string;
	retiredAt?: string;
}

/** One satellite layer: which watcher wrote it and its per-worker stamps. */
export interface WatchStampLayer {
	watcherKey: string;
	stamps: Record<string, RetireStamps>;
}

/** FNV-1a 32-bit over a UTF-8 string, hex-encoded (8 chars) — the watcher
 *  satellite key: stable per session, unique across sessions, readable in a
 *  dir listing without leaking the session path. */
export function watcherKeyFor(sessionFile: string | undefined): string {
	if (!sessionFile) return "anon";
	let hash = 0x811c9dc5;
	for (let i = 0; i < sessionFile.length; i++) {
		hash ^= sessionFile.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Conventional satellite path for one watcher session's stamps in a task
 *  dir. */
export function watchStampsPathFor(dir: string, watcherKey: string): string {
	return join(dir, `watch-${watcherKey}.json`);
}

/**
 * Read ALL satellite stamp layers in a task dir, tolerantly and
 * deterministically ordered (sorted by file name).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the task's exchange dir
 * Output: every watch-*.json layer as {watcherKey, stamps}; worker names map
 *   to {retirableSince?, retiredAt?} with only non-empty string stamps kept
 * Guarantees:
 *   - tolerant: no dir, unreadable/corrupt/partial layer files are skipped
 *     (a torn read costs at most a re-fire, never a throw)
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — watch-*.json files in the task dir.
 */
export function readWatchStampLayers(dir: string): WatchStampLayer[] {
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((f) => /^watch-([0-9a-f]{8}|anon)\.json$/.test(f)).sort();
	} catch {
		return []; // no dir / unreadable → no satellite layers
	}
	const layers: WatchStampLayer[] = [];
	for (const f of entries) {
		const watcherKey = f.slice("watch-".length, -".json".length);
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const stamps: Record<string, RetireStamps> = {};
			for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v !== "object" || v === null) continue;
				const o = v as Record<string, unknown>;
				const s: RetireStamps = {};
				if (typeof o.retirableSince === "string" && o.retirableSince.length > 0) s.retirableSince = o.retirableSince;
				if (typeof o.retiredAt === "string" && o.retiredAt.length > 0) s.retiredAt = o.retiredAt;
				if (s.retirableSince !== undefined || s.retiredAt !== undefined) stamps[name] = s;
			}
			layers.push({ watcherKey, stamps });
		} catch {
			// corrupt/partial layer → skip (advisory read, never throw)
		}
	}
	return layers;
}

/**
 * Merge the manifest layer with satellite layers into one effective stamp
 * pair (pure — the readers' side of the layer merge).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - base: the manifest worker entry's own stamps (may be absent)
 *   - layers: satellite layers read by readWatchStampLayers
 *   - workerName: the worker to merge for
 * Output: the effective {retirableSince?, retiredAt?}
 * Guarantees:
 *   - earliest non-empty stamp per field wins across ALL layers (the earliest
 *     clock start / the first close is the truth; deterministic regardless of
 *     file order)
 *   - pure; never throws
 * Raises: never
 */
export function mergeRetireStamps(
	base: RetireStamps | undefined,
	layers: WatchStampLayer[],
	workerName: string,
): RetireStamps {
	const out: RetireStamps = {};
	for (const cand of [base, ...layers.map((l) => l.stamps[workerName])]) {
		if (!cand) continue;
		if (cand.retirableSince !== undefined && (out.retirableSince === undefined || cand.retirableSince < out.retirableSince)) {
			out.retirableSince = cand.retirableSince;
		}
		if (cand.retiredAt !== undefined && (out.retiredAt === undefined || cand.retiredAt < out.retiredAt)) {
			out.retiredAt = cand.retiredAt;
		}
	}
	return out;
}

/**
 * Update THIS watcher's satellite layer for one worker (the writer's side).
 * The file is owned exclusively by this watcher session — no cross-process
 * lost update is possible; the write is atomic (tmp+rename) and skipped
 * entirely when it would not change anything.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's satellite key (watcherKeyFor(selfSessionFile))
 *   - workerName: the worker whose stamps change
 *   - stamps: the FULL new stamp pair for the worker (undefined field = no
 *     such stamp in this layer — a clear is expressed by omitting the field)
 * Output: resolves when the (possibly skipped) write settled
 * Guarantees:
 *   - idempotent: identical layer content → no write at all (a repeated
 *     clear/refresh costs no IO)
 *   - creates the dir on demand; atomic write
 * Raises:
 *   - propagates filesystem errors (the retire pass treats them as advisory
 *     tick failures and retries next tick)
 */
export async function updateWatchStamps(
	dir: string,
	watcherKey: string,
	workerName: string,
	stamps: RetireStamps,
): Promise<void> {
	const path = watchStampsPathFor(dir, watcherKey);
	await withFileMutationQueue(path, async () => {
		mkdirSync(dir, { recursive: true });
		const current = readWatchStampLayers(dir).find((l) => l.watcherKey === watcherKey)?.stamps ?? {};
		const next: Record<string, RetireStamps> = { ...current };
		if (stamps.retirableSince === undefined && stamps.retiredAt === undefined) delete next[workerName];
		else next[workerName] = stamps;
		if (JSON.stringify(current) === JSON.stringify(next)) return; // idempotent — no write
		atomicWriteFileSync(path, JSON.stringify(next, null, "\t") + "\n");
	});
}

// ---------------------------------------------------------------------------
// Durable delivery store (watcher stage B, guideline §5): the delivered-facts
// file the watcher commits AFTER a successful wake-up send. One satellite
// file per task dir per audience session (delivered-<watcherKey>.json,
// watcherKey = FNV-1a of the audience session's JSONL path — the same
// convention as the retire-stamp satellites): the file name carries the
// audience key, so exactly ONE writer session exists per file by
// construction — no cross-process lost update is possible (the in-process
// file-mutation queue serializes same-process writers; inter-process safety
// comes from the file NAME, not from a lock). Memory `seen` in observe.ts is
// only a CACHE of this store; the store is the source of truth across
// session restarts. Reads are tolerant: a missing, corrupt or torn file
// reads as an EMPTY store (worst case one repeated wake-up, never a throw).
// Records are only ever ADDED; removal happens exclusively as garbage
// collection when a worker really disappears from the manifests — never on
// a skipped observation or a transient read error (guideline §5.6).
// ---------------------------------------------------------------------------

/** Schema version of the delivered-facts file (bump on a breaking change). */
export const DELIVERED_STORE_SCHEMA_VERSION = 1;

/** One committed delivery fact (guideline §5.2 DeliveryRecord). The task dir
 *  and the audience are given by the FILE's location (per-task dir, audience
 *  key in the file name) and are not part of the record key. */
export interface DeliveryRecord {
	worker: string;
	kind: string;
	/** Canonical fingerprint (episode identifier for gauge/absence kinds —
	 *  never an empty constant; see the fingerprint table in DESIGN.md). */
	fingerprint: string;
	/** ISO 8601 — when the successful send was committed. */
	deliveredAt: string;
	/** How the wake-up was delivered — currently only "sent" (a real
	 *  sendUserMessage call); the field exists so future modes stay
	 *  distinguishable in the audit trail. */
	deliveryMode: string;
}

/** The on-disk shape of delivered-<watcherKey>.json. */
export interface DeliveredStoreFile {
	schemaVersion: number;
	/** Full session JSONL path of the audience this file belongs to. */
	audienceSessionPath: string;
	/** Record key = JSON.stringify([worker, kind, fingerprint]) — a canonical
	 *  JSON-array string: unambiguous without any delimiter parsing (worker
	 *  names, kinds and fingerprints are safe, but the task-dir path and the
	 *  audience path are NOT validated and could contain any separator —
	 *  they deliberately stay OUT of the key). */
	records: Record<string, DeliveryRecord>;
}

/** Canonical delivery-record key: JSON array of the THREE in-file components
 *  (worker, kind, fingerprint). Never parsed back — the store's readers use
 *  the parsed record values. */
export function deliveryRecordKey(worker: string, kind: string, fingerprint: string): string {
	return JSON.stringify([worker, kind, fingerprint]);
}

/** Conventional path of one audience's delivered-facts file in a task dir. */
export function deliveredStorePathFor(dir: string, watcherKey: string): string {
	return join(dir, `delivered-${watcherKey}.json`);
}

/**
 * Tolerant read of THIS audience's delivered-facts file in a task dir.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's satellite key (watcherKeyFor(selfSessionFile))
 * Output: the parsed DeliveredStoreFile; a missing/unreadable/corrupt/torn
 *   file or a wrong schemaVersion reads as an EMPTY store
 * Guarantees:
 *   - never throws; a corrupt store costs at most one repeated wake-up
 *     (the memory cache in observe.ts still suppresses within the session)
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — delivered-<key>.json in the task dir.
 */
export function readDeliveredStore(dir: string, watcherKey: string): DeliveredStoreFile {
	const empty: DeliveredStoreFile = {
		schemaVersion: DELIVERED_STORE_SCHEMA_VERSION,
		audienceSessionPath: "",
		records: {},
	};
	let raw: string;
	try {
		raw = readFileSync(deliveredStorePathFor(dir, watcherKey), "utf8");
	} catch {
		return empty; // absent/unreadable → empty store
	}
	try {
		const parsed = JSON.parse(raw) as Partial<DeliveredStoreFile> | null;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			parsed.schemaVersion !== DELIVERED_STORE_SCHEMA_VERSION ||
			typeof parsed.records !== "object" ||
			parsed.records === null
		) {
			return empty; // unknown schema version / torn shape → empty store
		}
		const records: Record<string, DeliveryRecord> = {};
		for (const [key, v] of Object.entries(parsed.records)) {
			if (typeof v !== "object" || v === null) continue;
			const o = v as unknown as Record<string, unknown>;
			if (
				typeof o.worker !== "string" || o.worker.length === 0 ||
				typeof o.kind !== "string" || o.kind.length === 0 ||
				typeof o.fingerprint !== "string" ||
				typeof o.deliveredAt !== "string" || o.deliveredAt.length === 0 ||
				typeof o.deliveryMode !== "string" || o.deliveryMode.length === 0
			) {
				continue; // a torn record is skipped, the rest of the file stays usable
			}
			records[key] = {
				worker: o.worker,
				kind: o.kind,
				fingerprint: o.fingerprint,
				deliveredAt: o.deliveredAt,
				deliveryMode: o.deliveryMode,
			};
		}
		return {
			schemaVersion: DELIVERED_STORE_SCHEMA_VERSION,
			audienceSessionPath:
				typeof parsed.audienceSessionPath === "string" ? parsed.audienceSessionPath : "",
			records,
		};
	} catch {
		return empty; // corrupt JSON → empty store, never a throw
	}
}

/**
 * Commit delivery records for one batch (already sent successfully) into
 * THIS audience's delivered-facts file — one atomic merge per task dir
 * (a batch may span several task dirs; atomicity holds WITHIN one dir's
 * file, between dirs a partial commit is possible and documented).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's satellite key
 *   - audienceSessionPath: the full session path of this watcher's audience
 *   - entries: {worker, kind, fingerprint} per delivered event
 *   - deliveredAt: ISO stamp for the whole batch
 *   - deliveryMode: e.g. "sent"
 * Output: resolves when the (merged, atomic) write settled
 * Guarantees:
 *   - merge semantics: existing records are kept, new ones added; the write
 *     is skipped entirely when nothing would change (idempotent)
 *   - serialized per path via withFileMutationQueue; atomic write (tmp+rename);
 *     creates the dir on demand
 * Raises:
 *   - propagates filesystem errors (the watcher treats a failed commit as
 *     "durable fact not written — a repeat is possible after a restart",
 *     never as a failed delivery)
 */
export async function appendDeliveredRecords(
	dir: string,
	watcherKey: string,
	audienceSessionPath: string,
	entries: ReadonlyArray<{ worker: string; kind: string; fingerprint: string }>,
	deliveredAt: string,
	deliveryMode: string,
): Promise<void> {
	const path = deliveredStorePathFor(dir, watcherKey);
	await withFileMutationQueue(path, async () => {
		const current = readDeliveredStore(dir, watcherKey);
		const next: DeliveredStoreFile = {
			schemaVersion: DELIVERED_STORE_SCHEMA_VERSION,
			audienceSessionPath,
			records: { ...current.records },
		};
		for (const e of entries) {
			next.records[deliveryRecordKey(e.worker, e.kind, e.fingerprint)] = {
				worker: e.worker,
				kind: e.kind,
				fingerprint: e.fingerprint,
				deliveredAt,
				deliveryMode,
			};
		}
		if (JSON.stringify(current.records) === JSON.stringify(next.records)) return; // idempotent
		mkdirSync(dir, { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(next, null, "\t") + "\n");
	});
}

/**
 * Garbage collection: remove ALL delivery records of ONE worker from THIS
 * audience's delivered-facts file. Called ONLY when the worker really
 * disappeared from the manifests (an atomic manifest write removed it) —
 * never on a skipped observation or a transient read error (guideline §5.6).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's satellite key
 *   - workerName: the worker whose records are collected
 * Output: resolves when the (possibly skipped) write settled
 * Guarantees:
 *   - idempotent: no matching records → no write at all
 *   - atomic write; creates the dir on demand
 * Raises:
 *   - propagates filesystem errors (advisory — the watcher retries next tick)
 */
export async function deleteWorkerDeliveryRecords(
	dir: string,
	watcherKey: string,
	workerName: string,
): Promise<void> {
	const path = deliveredStorePathFor(dir, watcherKey);
	await withFileMutationQueue(path, async () => {
		const current = readDeliveredStore(dir, watcherKey);
		const next: Record<string, DeliveryRecord> = {};
		let changed = false;
		for (const [key, rec] of Object.entries(current.records)) {
			if (rec.worker === workerName) {
				changed = true;
				continue;
			}
			next[key] = rec;
		}
		if (!changed) return; // idempotent — no write
		mkdirSync(dir, { recursive: true });
		atomicWriteFileSync(path, JSON.stringify({
			schemaVersion: DELIVERED_STORE_SCHEMA_VERSION,
			audienceSessionPath: current.audienceSessionPath,
			records: next,
		}, null, "\t") + "\n");
	});
}
