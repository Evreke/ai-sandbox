/**
 * pi-delegate — src/exchange.ts (Wave 3a: exchange-root conventions module
 * + the transition facade).
 *
 * MODULE_CONTRACT — the exchange dir conventions and the F1 fleet
 * accounting; facade for the extracted exchange-layer modules.
 *
 * Purpose: /tmp/exchange/<task>/ conventions — the exchange root rule
 * (exchangeRoot, incl. the $PI_DELEGATE_EXCHANGE_ROOT test override and the
 * win32 default), brief validation + dir opening (ensureExchangeDir,
 * ExchangeDir), the conventional report path (reportPathFor), the shared
 * dir/file classifiers (isProbeDir, teardownLogLine), the F1 fleet
 * accounting section (describeFleet, applyFleetTaskFields,
 * aggregateTaskUsage, persistTaskUsageSnapshot + TaskUsageSnapshot types)
 * and the progress-ping reads (progressPathFor, readLastProgress).
 *
 * Wave 3a decomposition (bodies byte-verbatim, one module per
 * responsibility; ARCHITECTURE.md Law 5):
 *   - src/archive.ts — the durable report archive + TTL prune
 *     (archiveRoot, archiveReport, ARCHIVE_TTL_MS, pruneArchive,
 *     listArchivedTasks).
 *   - src/manifest-store.ts — manifest types + read/update protocol + the
 *     ManifestStore port and its two implementations + scanAllManifests.
 *   - src/report-schema.ts — strict report validation + the brief-declared
 *     schema library ($extends resolution).
 *   - src/mailbox-store.ts — the q-/a-/release-/nudge-failed- envelope
 *     lifecycle (wire format FROZEN).
 *   - src/watch-store.ts — the watcher satellite persistence (retire-stamp
 *     layers + the durable delivered-facts store).
 *
 * TEMPORARY TRANSITION FACADE: every symbol moved by Wave 3a is re-exported
 * from here (see the facade block below the imports), so existing import
 * sites keep resolving unchanged. All src/ sites are already flipped to the
 * new modules; the facade remains for the test suite and any external
 * consumers and goes away one release after the flip (the plan's
 * no-big-bang rule). New code must import from the owning module.
 *
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue via
 * updateManifest — through the manifest-store module), node builtins,
 * ./host.ts (types + guards ONLY — never the herdr implementation),
 * ./usage.ts (parseSessionUsage for the F1 roll-up), ./expaths.ts (the ONE
 * path builder), and the extracted modules.
 *
 * Manifest format (migration stage 2): ManifestWorker carries the ONE
 * optional extension field `embodiment` (run ordinal + placementRef — the
 * embodiment identity; semantics live in src/lifecycle.ts, the single
 * lifecycle owner). Legacy entries without it are read by the backward
 * adapter; external consumers of the manifest are unchanged.
 *
 * Critical invariants (report-ref-map.json hiddenInvariants; ownership with
 * the module that implements each):
 *   - append-before-start (manifest side, src/manifest-store.ts): worker
 *     entries are appended by the spawn flow THROUGH updateManifest (after
 *     place(), before startAgent()); on a refused start the caller rolls
 *     back exactly the entry its own call appended (name + this paneId + no
 *     sessionPath) — updateManifest's withFileMutationQueue serialization
 *     is what makes that claim/rollback protocol safe against parallel
 *     spawns.
 *   - collectedAt-dedup (write side): only COLLECT stamps collectedAt, on
 *     successful report delivery; the watcher is a reader, never a writer
 *     (its `seen` dedup lives only in session memory — the stamp is what
 *     keeps a fresh session's watcher from re-waking on old reports).
 *   - answer-consumed-mtime: no worker-side ack exists — an answer counts
 *     as consumed iff the worker's report mtime POSTDATES the a-<name>.json
 *     answer file written by writeAnswer (src/mailbox-store.ts).
 *   - mailbox path conventions: q-/a-/release-/p- files live NEXT TO THE
 *     BRIEF in /tmp/exchange/<task>/, named by canonical worker name
 *     (src/mailbox-store.ts; wire format frozen).
 *   - manifest writes are atomic (tmp+rename via the ONE shared
 *     atomicWriteFileSync in src/manifest-store.ts) and serialized via
 *     withFileMutationQueue on the target path.
 *   - F1 fleet-accounting set-once (OWNED here): `description` and
 *     `masterSessionPath` are written ONLY when absent
 *     (applyFleetTaskFields) — the first delegate call of a task fixes
 *     them, later spawns never overwrite.
 *   - F1 usage cache is a CACHE, not authority (OWNED here): the worker
 *     session JSONL files are the source of truth; aggregateTaskUsage
 *     recomputes from them on every read; only WRITERS (collect, via
 *     persistTaskUsageSnapshot) stamp the snapshot into the manifest —
 *     read paths (delegate_status) never write, so the read-only tool
 *     contract holds.
 *   - archive is best-effort by contract (src/archive.ts): any failure →
 *     null/0/[] — never throws past its callers.
 *
 * Error modes: ensureExchangeDir throws a typed E_BRIEF DelegateError;
 * every validator (src/report-schema.ts) returns {ok:false, error} instead
 * of throwing.
 */

import {
	delegateError,
	type DelegateError,
	type ProgressEvent,
} from "./host.ts";
import { isProgressEvent } from "./host.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionUsage } from "./usage.ts";
import {
	manifestPathFor as buildManifestPath,
	reportPathFor as buildReportPath,
	progressPathFor as buildProgressPath,
	probeDirPathFor as buildProbeDirPath,
	isProbeDir as expathsIsProbeDir,
	sameDir,
	type PathPlatform,
} from "./expaths.ts";
import * as nodePath from "node:path";
import * as nodePathWin32 from "node:path/win32";
import {
	readManifest,
	updateManifest,
	type ExchangeManifest,
	type TaskUsageSnapshot,
} from "./manifest-store.ts";

// Shared exchange-dir name conventions (migration stage 1): the constants
// moved to src/expaths.ts (the path-builder module owns their ONE spelling
// so builders and classifiers cannot drift); re-exported here — the
// exchange.ts export surface is unchanged for every consumer.
export {
	PROBE_DIR_SUFFIX,
	TEARDOWN_LOG_NAME,
} from "./expaths.ts";

// Wave 3a transition facade (temporary, one release per the plan): the
// archive module moved verbatim to src/archive.ts — re-exported here so
// every existing import site keeps resolving unchanged; sites flip to the
// new module in the follow-up commit.
export {
	ARCHIVE_TTL_MS,
	archiveReport,
	archiveRoot,
	listArchivedTasks,
	pruneArchive,
} from "./archive.ts";

// Wave 3a transition facade (temporary, one release per the plan): the
// manifest store moved verbatim to src/manifest-store.ts — re-exported here
// so every existing import site keeps resolving unchanged; sites flip to
// the new module in the follow-up commit.
export type {
	ExchangeManifest,
	ManifestStore,
	ManifestWorker,
	TaskUsageSnapshot,
} from "./manifest-store.ts";
export {
	createFileManifestStore,
	createMemoryManifestStore,
	manifestStore,
	readManifest,
	scanAllManifests,
	updateManifest,
} from "./manifest-store.ts";

// Wave 3a transition facade (temporary, one release per the plan): report
// validation + the schema library moved verbatim to src/report-schema.ts —
// re-exported here so every existing import site keeps resolving unchanged;
// sites flip to the new module in the follow-up commit.
export {
	loadLibrarySchema,
	parseBriefSchema,
	resolveReportSchema,
	resolveReportSchemaInDir,
	validateReport,
	validateReportAgainstSchema,
} from "./report-schema.ts";

// Wave 3a transition facade (temporary, one release per the plan): the
// mailbox file lifecycle moved verbatim to src/mailbox-store.ts —
// re-exported here so every existing import site keeps resolving unchanged;
// sites flip to the new module in the follow-up commit. The wire format
// (file names, envelope shapes) is FROZEN — byte-identical move.
export type { NudgeFailedEnvelope, QuestionRead, ReleaseEnvelope } from "./mailbox-store.ts";
export {
	answerPathFor,
	readNudgeFailedMarker,
	readQuestion,
	readQuestionState,
	writeAnswer,
	writeRelease,
} from "./mailbox-store.ts";
export {
	nudgeFailedPathFor,
	questionPathFor,
	releasePathFor,
} from "./mailbox-store.ts";

// Wave 3a transition facade (temporary, one release per the plan): the
// watcher satellite persistence (retire-stamp layers + the durable
// delivered-facts store) moved verbatim to src/watch-store.ts — re-exported
// here so every existing import site keeps resolving unchanged; sites flip
// to the new module in the follow-up commit. Same watcherKey convention,
// same single-writer discipline.
export type { DeliveredStoreFile, DeliveryRecord, RetireStamps, WatchStampLayer } from "./watch-store.ts";
export {
	DELIVERED_STORE_SCHEMA_VERSION,
	appendDeliveredRecords,
	deleteWorkerDeliveryRecords,
	deliveredStorePathFor,
	deliveryRecordKey,
	mergeRetireStamps,
	readDeliveredStore,
	readWatchStampLayers,
	updateWatchStamps,
	watchStampsPathFor,
	watcherKeyFor,
} from "./watch-store.ts";

// ============================================================================
// SECTION 1 — src/exchange.ts (verbatim, incl. its review-verified headers)
// ============================================================================

/**
 * pi-delegate — exchange dir conventions and manifest (DESIGN.md §6).
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A (impl-transport). Worker B imports but never edits this file.
 *
 * Conventions:
 *   /tmp/exchange/{TASK}/manifest.json    — extension-written source of truth
 *   /tmp/exchange/{TASK}/brief-<name>.md  — orchestrator-written, tool-validated
 *   /tmp/exchange/{TASK}/report-<name>.json — worker-written, schema-validated
 */


/**
 * Exchange root — all task dirs live directly under it.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: platform — the OS shape the default root is derived for (default:
 *   the running process's platform; tests may pass "win32" to assert the
 *   Windows default without a Windows host)
 * Output: the absolute exchange root path
 * Guarantees:
 *   - POSIX default /tmp/exchange — byte-for-byte unchanged
 *   - win32 default %LOCALAPPDATA%\pi\exchange (per-user, durable — Windows
 *     has no reboot-cleans-/tmp convention; %TEMP% can carry spaces and
 *     non-ASCII usernames)
 *   - $PI_DELEGATE_EXCHANGE_ROOT overrides any default — test-fixture
 *     sandboxing: test manifests are written under mkdtemp dirs, NEVER into
 *     the live root (field lesson 2026-09-10: a PoC test manifest in the
 *     live /tmp/exchange root woke a bystander orchestrator through the
 *     then-fail-open legacy manifest scan; since watcher stage A the
 *     default delivery is fail-closed, so such fixtures would now be
 *     SILENT instead of noisy — the hermetic override stays mandatory,
 *     otherwise fixture hygiene bugs become invisible rather than fixed)
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem path + $PI_DELEGATE_EXCHANGE_ROOT (test
 *   override; unset in production) + %LOCALAPPDATA% / os.homedir() on win32.
 */
export function exchangeRoot(platform: NodeJS.Platform = process.platform): string {
	if (process.env.PI_DELEGATE_EXCHANGE_ROOT) return process.env.PI_DELEGATE_EXCHANGE_ROOT;
	// EXTERNAL_DEPENDENCY: %LOCALAPPDATA% (win32 default root derivation).
	if (platform === "win32") {
		const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		// Joined with the win32 path shape: node:path on a posix host would
		// assemble mixed separators (C:\Users\x/…/exchange) — the default must
		// be separator-native for the platform it is derived FOR (a real Windows
		// host already gets the win32 shape from node:path; this makes the
		// injected-platform tests honest too).
		return nodePathWin32.join(base, "pi", "exchange");
	}
	return "/tmp/exchange";
}


export interface ExchangeDir {
	dir: string;
	/** Short task slug (directory basename under /tmp/exchange). */
	task: string;
	briefPath: string;
	reportPath: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Migration stage 1 (audit, errors-defect 2): the exchange module's SECOND
// error class (ExchangeDelegateError, with its own hardcoded E_BRIEF guidance
// duplicating the seam dictionary) is DELETED. Every error this module raises
// goes through the ONE seam factory (delegateError from src/host.ts), so the
// guidance text has exactly one writer.

// ---------------------------------------------------------------------------
// Path validation + ensureExchangeDir
// ---------------------------------------------------------------------------

/**
 * Validate and open the exchange dir for a brief.
 * Rules: briefPath absolute (per the injected platform), directly inside
 * <exchangeRoot>/<task>/ (case/separator-stable compare — see the
 * BUG_FIX_CONTEXT note in the body), file exists and is non-empty. Throws a
 * DelegateError (typed, seam taxonomy) with code E_BRIEF otherwise.
 * The optional `p` platform parameter defaults to node's own path — tests
 * inject node.path.win32 to drive the Windows shape from a POSIX host.
 */
export function ensureExchangeDir(briefPathRaw: string, p: PathPlatform = nodePath): ExchangeDir {
	// Normalize a leading @ (models sometimes prefix tool path args with it).
	const briefPath = briefPathRaw.startsWith("@") ? briefPathRaw.slice(1) : briefPathRaw;

	if (!briefPath || !p.isAbsolute(briefPath)) {
		throw delegateError(
			"E_BRIEF",
			`Brief path must be absolute, got: "${briefPathRaw}"`,
		);
	}
	const brief = p.resolve(briefPath);
	const dir = p.dirname(brief);
	const task = p.basename(dir);
	const parent = p.dirname(dir);

	// BUG_FIX_CONTEXT (Windows case/separator stability): symptom — on Windows
	// a brief at `c:\…` against a root env var `C:\…` failed E_BRIEF spuriously:
	// resolve() does NOT fold drive-letter or component case, and the old code
	// compared raw strings. Fix — compare through expaths.sameDir (case-folded,
	// both-separator-folding on win32; byte-identical strict equality on posix).
	if (!sameDir(parent, exchangeRoot(), p)) {
		throw delegateError(
			"E_BRIEF",
			`Brief must live directly inside ${exchangeRoot()}/<task>/ — parent dir of "${dir}" is "${parent}"`,
		);
	}
	if (!task || task === p.basename(exchangeRoot())) {
		throw delegateError("E_BRIEF", `Missing task slug in brief path: "${brief}"`);
	}

	let content: string;
	try {
		content = readFileSync(brief, "utf8");
	} catch (err) {
		throw delegateError(
			"E_BRIEF",
			`Brief file not readable at ${brief}: ${(err as Error).message}`,
			err,
		);
	}
	if (content.trim().length === 0) {
		throw delegateError("E_BRIEF", `Brief file is empty: ${brief}`);
	}

	// Conventional report path: brief-<name>.md → report-<name>.json (sibling).
	const briefName = p.basename(brief);
	const nameMatch = /^brief-(.+)\.md$/.exec(briefName);
	const reportPath = nameMatch ? buildReportPath(dir, nameMatch[1], p) : "";

	return { dir, task, briefPath: brief, reportPath };
}



// ---------------------------------------------------------------------------
// F1 — fleet usage accounting (task-level description, master link, roll-up)
// ---------------------------------------------------------------------------

/**
 * F1 fleet description rule (naive linear derivation, documented exactly):
 * take the brief text's FIRST MEANINGFUL line — the first line that is
 * non-empty after trimming, NOT inside a code fence, and NOT one of: a
 * markdown heading (`#`…), a fence delimiter (```…), an HTML comment
 * (`<!--`…), or a bare list marker; strip markdown decoration (leading
 * `#`/`-`/`*`/`>` chars, backticks, `*`/`_` emphasis), collapse whitespace,
 * keep the first 10 words. Fewer than 10 words in the line → shorter
 * description; no meaningful line at all → "" (caller leaves the manifest
 * field unset and the next spawn retries).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: brief — the full text of the task brief (or task input)
 * Output: 1–10 word description string ("" when nothing meaningful found)
 * Guarantees: pure — no I/O, no throws (any input yields a string)
 * Raises: never
 */
export function describeFleet(brief: string): string {
	let inFence = false;
	for (const rawLine of brief.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("```")) {
			inFence = !inFence; // fenced blocks never describe the fleet
			continue;
		}
		if (inFence || !line) continue;
		if (
			line.startsWith("#") ||
			line.startsWith("<!--") ||
			/^(?:[-*+]>?)\s*$/.test(line)
		) {
			continue;
		}
		const words = line
			.replace(/^[#>*\-+]+\s*/, "") // leading decoration
			.replace(/[`*_]/g, "") // emphasis/backticks
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 10);
		return words.join(" ");
	}
	return "";
}

/**
 * F1 set-once merge: fold THIS spawn's derived task fields into the manifest
 * WITHOUT overwriting fields a previous spawn already fixed. The first
 * delegate call of a task writes description + masterSessionPath; every
 * later call is a no-op for them (fleet identity is fixed at spawn #1).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - m: the manifest being mutated
 *   - fields: THIS call's candidates (description from describeFleet; master
 *     session path = this call's orchestratorSessionPath)
 * Output: the manifest to persist — fields set only when previously absent
 *   (empty-string candidates never overwrite or set anything)
 * Guarantees: pure — returns a new object, never mutates `m`
 * Raises: never
 */
export function applyFleetTaskFields(
	m: ExchangeManifest,
	fields: { description?: string; masterSessionPath?: string },
): ExchangeManifest {
	return {
		...m,
		description:
			m.description ?? (fields.description && fields.description.trim() ? fields.description : undefined),
		masterSessionPath: m.masterSessionPath ?? (fields.masterSessionPath || undefined),
	};
}

/**
 * F1 roll-up: aggregate the fleet's per-worker usage for one task dir.
 * Reuses the usage.ts parser (parseSessionUsage — the ONE session-JSONL
 * parser; this module only sums its per-worker results) over the session
 * files recorded in the manifest. Totals are ALWAYS recomputed from the
 * session files (source of truth). Persisting the cache is a separate
 * WRITER step (persistTaskUsageSnapshot) so read paths (delegate_status)
 * stay read-only by contract.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the task's exchange dir (manifest.json lives there)
 * Output: TaskUsageSnapshot, or null when there is no readable manifest (no
 *   fleet yet)
 * Guarantees:
 *   - tolerant: missing manifest → null; missing/unreadable/corrupt worker
 *     session files contribute zeros and land in `partial` — NEVER throws
 *   - entries are never deleted: workers = manifest.workers.length always
 * Raises: never
 */
export function aggregateTaskUsage(dir: string): TaskUsageSnapshot | null {
	const manifest = readManifest(dir);
	if (!manifest) return null;
	const snapshot: TaskUsageSnapshot = {
		workers: manifest.workers.length,
		outputTokens: 0,
		cacheReadTokens: 0,
		sentTokens: 0,
		turns: 0,
		partial: [],
		computedAt: new Date().toISOString(),
	};
	for (const w of manifest.workers) {
		if (!w.sessionPath) {
			snapshot.partial.push(w.name); // herdr exposed no session file — uncountable
			continue;
		}
		// Missing/unreadable file → parseSessionUsage returns zeros; distinguish
		// "file absent" (a real partial) from a legitimately empty session by a
		// readability probe.
		try {
			readFileSync(w.sessionPath, "utf8");
		} catch {
			snapshot.partial.push(w.name); // pruned/never-created session file
			continue;
		}
		const u = parseSessionUsage(w.sessionPath);
		snapshot.sentTokens += u.input;
		snapshot.outputTokens += u.output;
		snapshot.cacheReadTokens += u.cacheRead;
		snapshot.turns += u.turns;
	}
	return snapshot;
}

/**
 * F1 cache write (WRITER side): stamp the recomputed snapshot into the
 * manifest (m.usage, with computedAt) so the last-known totals survive
 * session-file pruning and process restarts. Called by writers (collect);
 * never by read paths. Best-effort: any failure resolves silently — the
 * aggregate answer was already computed from the session files.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - snapshot: the snapshot from aggregateTaskUsage (persisted verbatim)
 * Output: resolves when the cache write settled (or was swallowed)
 * Guarantees: atomic + serialized via updateManifest (mutation queue)
 * Raises: never (swallowed — durability copy only)
 */
export async function persistTaskUsageSnapshot(dir: string, snapshot: TaskUsageSnapshot): Promise<void> {
	try {
		await updateManifest(dir, (m) => ({ ...m, usage: snapshot }));
	} catch {
		/* cache write failed — the recomputed totals remain the answer */
	}
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Conventional report path for a worker (built by src/expaths.ts — the ONE
 *  path builder; separator-native per the platform, POSIX byte-identical). */
export function reportPathFor(dir: string, name: string): string {
	return buildReportPath(dir, name);
}

// ---------------------------------------------------------------------------
// Shared dir/file conventions (single-source constants — migration stage 1)
// ---------------------------------------------------------------------------

/**
 * True when an exchange dir is the probe dir (or a fixture shaped like one).
 * Delegates to src/expaths.ts (the ONE classifier) — basename compare, so a
 * Windows probe dir `<root>\_probe` is detected too (the old
 * endsWith("/_probe") missed it).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — absolute exchange dir path
 * Output: true iff the dir's basename equals PROBE_DIR_SUFFIX
 * Guarantees:
 *   - pure string test, no fs access
 *   - single classifier for probe dirs (observe view building, index tool
 *     result field, watcher skip logic all read this — before the migration
 *     each site carried its own endsWith("/_probe") copy)
 * Raises: never
 */
export function isProbeDir(dir: string, p: PathPlatform = nodePath): boolean {
	return expathsIsProbeDir(dir, p);
}

/**
 * Format ONE teardown-audit line: `[ISO] line\n` — the format both close
 * paths append with (byte-identical by construction now, not by convention).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: line — the audit text (plan/done/error + details)
 * Output: the full file line, timestamped at CALL time
 * Guarantees:
 *   - pure formatting; append + swallow-failures stay at the call sites
 *     (spawn.ts logTeardownAudit / observe.ts logTo)
 * Raises: never
 */
export function teardownLogLine(line: string): string {
	return `[${new Date().toISOString()}] ${line}\n`;
}



// ---------------------------------------------------------------------------
// v1.2 contracts — brief-declared schemas + mailbox (DESIGN.md §11–§12).
// Contract authored by the tech lead; implementation owned by worker A2
// (impl-mailbox). Worker B2 imports but never edits this file.
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// v1.5 contracts — schema library/inheritance + progress pings
// (DESIGN.md §16–§18). Contract authored by the tech lead; implementation
// owned by worker A5 (impl-schemas). Worker B5 imports, never edits.
// ---------------------------------------------------------------------------



/** Conventional progress-ping path for a worker (built by src/expaths.ts). */
export function progressPathFor(dir: string, name: string): string {
	return buildProgressPath(dir, name);
}

/**
 * Read the LAST valid ping from p-<name>.jsonl (file may not exist, may be
 * mid-append — tolerate partial last line). Scan lines from the END, skipping
 * corrupt/partial/non-progress lines; the first line passing isProgressEvent
 * wins. Returns null when absent/empty/none-valid. Never throws.
 */
export function readLastProgress(path: string): ProgressEvent | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent/unreadable → no ping yet
	}
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // corrupt or partial tail line → keep scanning backwards
		}
		if (isProgressEvent(parsed)) return parsed;
	}
	return null;
}


