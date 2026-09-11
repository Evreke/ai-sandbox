/**
 * pi-delegate — src/exchange.ts (W3 refactor: merged module).
 *
 * MODULE_CONTRACT — the exchange dir: report/schema/mailbox-file lifecycle
 * + the durable report archive.
 *
 * Purpose: /tmp/exchange/<task>/ conventions — brief/manifest/report path
 * rules, the manifest read/update protocol, strict report validation (v1
 * base schema + brief-declared reportSchema fragments incl. $extends
 * resolution), the mailbox file lifecycle (q-/a- envelopes, §23 release
 * marker) and progress-ping reads — plus the report archive under
 * ~/.pi/agent/delegate-archive (§19.3).
 *
 * Dependencies: @earendil-works/pi-coding-agent (parseFrontmatter,
 * withFileMutationQueue), typebox/value entry (deep specifiers are BLOCKED
 * by typebox 1.3.7's exports map — see the note in the import block),
 * node builtins, and ./host.ts (types + envelope guards ONLY — never
 * the herdr implementation). Also owns the shared exchange-dir conventions
 * as single-source constants (probe dir suffix, teardown audit trail name
 * + line format) — migration stage 1.
 *
 * Exported surface (union of the two merged sources, verbatim, plus the F1
 * fleet-accounting section, plus the migration-stage-2 manifest storage
 * port):
 *   - manifest/fs: ensureExchangeDir, ExchangeDir, ExchangeManifest,
 *     ManifestWorker, readManifest, updateManifest, scanAllManifests,
 *     reportPathFor
 *   - manifest storage port (migration stage 2, audit step 5): ManifestStore
 *     (read/update/append/scan), createFileManifestStore,
 *     createMemoryManifestStore, manifestStore (the process default, file-
 *     backed). ALL manifest consumers (spawn, observe, fleet, index, the
 *     fake host adapter) go through the port — the raw functions remain
 *     exported as the file implementation's building blocks and for tests.
 *
 * Manifest format (migration stage 2, audit step 6): ManifestWorker gained
 * the ONE optional extension field `embodiment` (run ordinal + placementRef
 * — the embodiment identity; semantics live in src/lifecycle.ts, the single
 * lifecycle owner). Legacy entries without it are read by the backward
 * adapter; external consumers of the manifest are unchanged.
 *   - F1 fleet accounting: TaskUsageSnapshot, describeFleet,
 *     applyFleetTaskFields, aggregateTaskUsage
 *   - reports/schemas: validateReport, validateReportAgainstSchema,
 *     parseBriefSchema, resolveReportSchema, resolveReportSchemaInDir,
 *     loadLibrarySchema
 *   - mailbox: questionPathFor, answerPathFor, releasePathFor,
 *     ReleaseEnvelope, readQuestion, readQuestionState (watcher stage C:
 *     read-with-reason for the corrupt-q audit, guideline §6.2.5),
 *     writeAnswer, writeRelease, progressPathFor, readLastProgress
 *   - archive: ARCHIVE_TTL_MS, archiveRoot, archiveReport,
 *     pruneArchive, listArchivedTasks
 *
 * Critical invariants OWNED here (report-ref-map.json hiddenInvariants):
 *   - append-before-start (manifest side): worker entries are appended by
 *     the spawn flow THROUGH updateManifest (after place(), before
 *     startAgent()); on a refused start the caller rolls back exactly the
 *     entry its own call appended (name + this paneId + no sessionPath) —
 *     updateManifest's withFileMutationQueue serialization is what makes
 *     that claim/rollback protocol safe against parallel spawns.
 *   - collectedAt-dedup (write side): only COLLECT stamps collectedAt, on
 *     successful report delivery; the watcher is a reader, never a writer
 *     (its `seen` dedup lives only in session memory — the stamp is what
 *     keeps a fresh session's watcher from re-waking on old reports).
 *   - answer-consumed-mtime: no worker-side ack exists — an answer counts
 *     as consumed iff the worker's report mtime POSTDATES the a-<name>.json
 *     answer file written by writeAnswer.
 *   - mailbox path conventions: q-/a-/release-/p- files live NEXT TO THE
 *     BRIEF in /tmp/exchange/<task>/, named by canonical worker name.
 *   - manifest writes are atomic (tmp+rename) and serialized via
 *     withFileMutationQueue on the target path.
 *   - F1 fleet-accounting set-once: `description` and `masterSessionPath`
 *     are written ONLY when absent (applyFleetTaskFields) — the first
 *     delegate call of a task fixes them, later spawns never overwrite.
 *   - F1 usage cache is a CACHE, not authority: the worker session JSONL
 *     files are the source of truth; aggregateTaskUsage recomputes from
 *     them on every read; only WRITERS (collect, via
 *     persistTaskUsageSnapshot) stamp the snapshot into the manifest —
 *     read paths (delegate_status) never write, so the read-only tool
 *     contract holds.
 *   - archive is best-effort by contract: any failure → null/0/[] — never
 *     throws past its callers.
 *
 * Error modes: ensureExchangeDir throws a typed E_BRIEF DelegateError;
 * every validator returns {ok:false, error} instead of throwing.
 *
 * Sections (banner-delimited, bodies byte-verbatim from the pre-merge
 * files; exchange's three ./transport/types.ts import blocks were hoisted
 * into the single top block below, retargeted at ./transport.ts):
 *   1. src/exchange.ts — conventions, manifest, reports, schemas, mailbox
 *      (versioned banner headers preserved verbatim).
 *   2. src/archive.ts — durable report archive + TTL prune (header
 *      preserved verbatim, incl. its namespace-style imports).
 */

import { parseFrontmatter, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	delegateError,
	type DelegateError,
	type Placement,
	type ProgressEvent,
	type WorkerReport,
} from "./host.ts";
import {
	isProgressEvent,
	isQuestionEnvelope,
	type AnswerEnvelope,
	type QuestionEnvelope,
} from "./host.ts";
// typebox Value.Check/Errors — NOTE: the contract's deep specifiers
// ("typebox/build/value/check/check.mjs") are blocked by typebox 1.3.7's
// exports map (ERR_PACKAGE_PATH_NOT_EXPORTED, verified via node + jiti);
// "typebox/value" is the exported entry for the same build/value modules.
import { Check, Errors } from "typebox/value";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseSessionUsage } from "./usage.ts";
import {
	answerPathFor as buildAnswerPath,
	manifestPathFor as buildManifestPath,
	reportPathFor as buildReportPath,
	questionArchivePathFor as buildQuestionArchivePath,
	questionPathFor as buildQuestionPath,
	nudgeFailedPathFor as buildNudgeFailedPath,
	releasePathFor as buildReleasePath,
	progressPathFor as buildProgressPath,
	probeDirPathFor as buildProbeDirPath,
	isProbeDir as expathsIsProbeDir,
	sameDir,
	type PathPlatform,
} from "./expaths.ts";
import * as nodePath from "node:path";
import * as nodePathWin32 from "node:path/win32";

// Shared exchange-dir name conventions (migration stage 1): the constants
// moved to src/expaths.ts (the path-builder module owns their ONE spelling
// so builders and classifiers cannot drift); re-exported here — the
// exchange.ts export surface is unchanged for every consumer.
export {
	PROBE_DIR_SUFFIX,
	TEARDOWN_LOG_NAME,
} from "./expaths.ts";

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
 *     non-ASCII usernames) — design-windows-mailbox.md §3.1
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
		return parsed as ExchangeManifest;
	} catch {
		return null;
	}
}

function atomicWriteFileSync(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path); // rename is atomic on the same filesystem
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
		const next = mutate(base);
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
			const next = mutate(base);
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

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/**
 * Strict collect (DESIGN.md §6): file must exist, parse as JSON, and satisfy
 * the WorkerReport schema — worker === canonical name, status ∈ {pass, fail},
 * non-empty summary, artifacts/evidence arrays present.
 */
export function validateReport(
	path: string,
	canonicalName: string,
): { ok: true; report: WorkerReport } | { ok: false; error: string } {
	const base = baseValidate(path, canonicalName);
	if (!base.ok) return base;
	return { ok: true, report: reportOf(base.r) };
}

function reportOf(r: Record<string, unknown>): WorkerReport {
	return {
		worker: r.worker as string,
		status: r.status as WorkerReport["status"],
		summary: r.summary as string,
		artifacts: r.artifacts as string[],
		evidence: r.evidence as WorkerReport["evidence"],
	};
}

/**
 * Read + parse + v1 base-schema checks. Returns the parsed object on success.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - path: report file path
 *   - canonicalName: expected value of the report's "worker" field
 * Output: {ok:true, r} with the parsed JSON object, or {ok:false, error}
 * Guarantees:
 *   - enforces, in order: readable, non-empty, valid JSON, plain object,
 *     worker non-empty string === canonicalName, status ∈ {pass, fail},
 *     summary non-empty string, artifacts string[], evidence array of
 *     {claim, file} non-empty-string objects
 * Raises: never
 */
function baseValidate(
	path: string,
	canonicalName: string,
): { ok: true; r: Record<string, unknown> } | { ok: false; error: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, error: `Report file not readable at ${path}: ${(err as Error).message}` };
	}
	if (raw.trim().length === 0) {
		return { ok: false, error: `Report file is empty: ${path}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `Report is not valid JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "Report must be a JSON object" };
	}
	const r = parsed as Record<string, unknown>;

	if (!isNonEmptyString(r.worker)) {
		return { ok: false, error: 'Report field "worker" must be a non-empty string' };
	}
	if (r.worker !== canonicalName) {
		return { ok: false, error: `Report "worker" is "${r.worker}" but canonical name is "${canonicalName}"` };
	}
	if (r.status !== "pass" && r.status !== "fail") {
		return { ok: false, error: `Report "status" must be "pass" or "fail", got: ${JSON.stringify(r.status)}` };
	}
	if (!isNonEmptyString(r.summary)) {
		return { ok: false, error: 'Report field "summary" must be a non-empty string' };
	}
	if (!Array.isArray(r.artifacts) || r.artifacts.some((a) => typeof a !== "string")) {
		return { ok: false, error: 'Report field "artifacts" must be an array of strings' };
	}
	if (!Array.isArray(r.evidence)) {
		return { ok: false, error: 'Report field "evidence" must be an array' };
	}
	for (const [i, item] of r.evidence.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, error: `Evidence item ${i} must be an object` };
		}
		const e = item as Record<string, unknown>;
		if (!isNonEmptyString(e.claim) || !isNonEmptyString(e.file)) {
			return { ok: false, error: `Evidence item ${i} must have non-empty string "claim" and "file"` };
		}
	}

	return { ok: true, r };
}

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

// ---------------------------------------------------------------------------
// v1.2 contracts — brief-declared schemas + mailbox (DESIGN.md §11–§12).
// Contract authored by the tech lead; implementation owned by worker A2
// (impl-mailbox). Worker B2 imports but never edits this file.
// ---------------------------------------------------------------------------


/**
 * Extract the brief's `reportSchema` frontmatter key (JSON-Schema fragment).
 * Returns null when absent (v1 backward compat) — missing/unparseable
 * frontmatter or a non-object reportSchema is NOT an error.
 * Implementation note: use parseFrontmatter from @earendil-works/pi-coding-agent.
 */
export function parseBriefSchema(briefPath: string): Record<string, unknown> | null {
	let content: string;
	try {
		content = readFileSync(briefPath, "utf8");
	} catch {
		return null; // unreadable brief → no schema, never throw
	}
	let frontmatter: unknown;
	try {
		frontmatter = parseFrontmatter(content).frontmatter;
	} catch {
		return null; // corrupt frontmatter → no schema, never throw
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		return null;
	}
	const schema = (frontmatter as Record<string, unknown>).reportSchema;
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return null; // absent or non-object reportSchema → v1 backward compat
	}
	return schema as Record<string, unknown>;
}

/**
 * Validate a report against the v1 base schema AND the brief-declared fragment
 * (when non-null). Verified entry on this host is the exported 'typebox/value'
 * (see import note at top of file) — the deep specifiers
 *   "typebox/build/value/check/check.mjs" / "typebox/build/value/errors/index.mjs"
 * are BLOCKED by typebox 1.3.7's exports map (ERR_PACKAGE_PATH_NOT_EXPORTED,
 * reproduced under node ESM and jiti). No new deps.
 * Check(schema, value) accepts plain JSON-Schema objects (type/properties/
 * required/items/enum/minimum…); Errors(schema, value) yields
 * {instancePath, message}. Error messages must name the failing path
 * (e.g. "reportSchema: result.count must be integer").
 */
export function validateReportAgainstSchema(
	path: string,
	canonicalName: string,
	briefSchema: Record<string, unknown> | null,
): { ok: true; report: WorkerReport } | { ok: false; error: string } {
	const base = baseValidate(path, canonicalName);
	if (!base.ok) return base;
	if (briefSchema !== null && !Check(briefSchema, base.r)) {
		// First error is enough; Errors() yields {instancePath, message} with the
		// failing location as a JSON pointer in instancePath.
		const first = Errors(briefSchema, base.r)[0];
		const where =
			first?.instancePath && first.instancePath.length > 0
				? `${first.instancePath.replace(/^\//, "").split("/").join(".")} `
				: "";
		const detail = first ? `${where}${first.message}` : "failed schema validation";
		return { ok: false, error: `reportSchema: ${path} ${detail}` };
	}
	return { ok: true, report: reportOf(base.r) };
}

/** Mailbox paths, next to the brief (built by src/expaths.ts). */
export function questionPathFor(dir: string, name: string): string {
	return buildQuestionPath(dir, name);
}

export function answerPathFor(dir: string, name: string): string {
	return buildAnswerPath(dir, name);
}

// ---------------------------------------------------------------------------
// F6 — nudge-failed marker (mailbox answer posted, pane nudge failed)
// ---------------------------------------------------------------------------

/** Conventional nudge-failed marker path — next to the brief, worker-scoped
 *  (built by src/expaths.ts). */
export function nudgeFailedPathFor(dir: string, name: string): string {
	return buildNudgeFailedPath(dir, name);
}

/** Mailbox tool → watcher fallback marker (nudge-failed-<name>.json): written
 *  by the delegate_mailbox answer/steer handler when the pane nudge fails after
 *  retries; the watcher delivers the wake-up on the next tick instead of the
 *  socket. Consumed (deleted) by a SUBSEQUENT successful nudge AND by a fresh
 *  same-name spawn (both in spawn.ts) — so a stale marker can only ever fire
 *  once for a new watcher session, and only as an advisory wake. */
export interface NudgeFailedEnvelope {
	name: string;
	ts: string;
	error: string;
}

/**
 * Tolerantly read a nudge-failed marker; null when absent/invalid.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path to nudge-failed-<name>.json
 * Output: the parsed envelope, or null when the file is absent, unreadable,
 *   corrupt JSON, or has no non-empty string `ts` (the fingerprint source)
 * Guarantees: never throws; a torn mid-write read degrades to null and the
 *   detection simply re-fires on a later tick (the marker stays on disk)
 * Raises: never
 */
export function readNudgeFailedMarker(path: string): NudgeFailedEnvelope | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent/unreadable → no marker
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const o = parsed as Record<string, unknown>;
		if (typeof o.ts !== "string" || o.ts.length === 0) return null;
		return {
			name: typeof o.name === "string" ? o.name : "",
			ts: o.ts,
			error: typeof o.error === "string" ? o.error : "",
		};
	} catch {
		return null; // corrupt JSON → no marker, never throw
	}
}

// ---------------------------------------------------------------------------
// §23 retire — release marker (orchestrator ACK, watcher-consumed)
// ---------------------------------------------------------------------------

/** Conventional release path (retire ACK) — next to the brief (built by
 *  src/expaths.ts). */
export function releasePathFor(dir: string, name: string): string {
	return buildReleasePath(dir, name);
}

/** Orchestrator → watcher release marker (release-<name>.json). The watcher
 *  closes the pane when the worker is retirable; probes retire immediately. */
export interface ReleaseEnvelope {
	from: "orchestrator";
	ts: string;
}

/** Write a release marker atomically (tmp+rename; withFileMutationQueue on the path). */
export function writeRelease(path: string): Promise<void> {
	const envelope: ReleaseEnvelope = {
		from: "orchestrator",
		ts: new Date().toISOString(),
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

/** Outcome of reading a q-<name>.json mailbox file (watcher stage C,
 *  guideline §6.2.5): ABSENT is the normal no-question state; INVALID is a
 *  file that EXISTS but is corrupt JSON or not a valid question envelope —
 *  a result-plane fact that must be auditable with its cause, never silently
 *  equated with "no question"; VALID carries the parsed envelope. */
export type QuestionRead =
	| { state: "absent" }
	| { state: "invalid"; error: string }
	| { state: "valid"; question: QuestionEnvelope };

/**
 * Read a pending question WITH the failure reason.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path to q-<name>.json (next to the brief)
 * Output: absent (no/unreadable file), invalid (file exists but fails — with
 *   the human-readable cause), or valid (parsed envelope)
 * Guarantees:
 *   - never throws; a torn mid-write read reads as invalid (with the parse
 *     error as the cause) and self-heals on a later tick
 * Raises: never
 */
export function readQuestionState(path: string): QuestionRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { state: "absent" }; // absent/unreadable → no pending question
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { state: "invalid", error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
	}
	if (!isQuestionEnvelope(parsed)) {
		return {
			state: "invalid",
			error: "JSON is not a question envelope (non-empty string fields worker, ts and question are expected)",
		};
	}
	return { state: "valid", question: parsed };
}

/** Read + validate a pending question; null when absent/invalid. */
export function readQuestion(path: string): QuestionEnvelope | null {
	const r = readQuestionState(path);
	return r.state === "valid" ? r.question : null;
}

/**
 * Write an answer envelope atomically (tmp+rename; withFileMutationQueue on the path).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - path: a-<name>.json mailbox path (next to the brief)
 *   - answer: the answer/steering text
 * Output: resolves when the envelope is durably on disk
 * Guarantees:
 *   - atomic write (tmp+rename) under the per-path mutation queue
 *   - envelope shape: {from:"orchestrator", ts: ISO-8601, answer}
 *   - creates the parent dir on demand
 * Raises:
 *   - propagates filesystem errors (the mailbox caller surfaces them)
 * EXTERNAL_DEPENDENCY: withFileMutationQueue from
 *   @earendil-works/pi-coding-agent; filesystem at <exchange dir>/a-<name>.json.
 */
export function writeAnswer(path: string, answer: string): Promise<void> {
	const envelope: AnswerEnvelope = {
		from: "orchestrator",
		ts: new Date().toISOString(),
		answer,
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

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

// ---------------------------------------------------------------------------
// v1.5 contracts — schema library/inheritance + progress pings
// (DESIGN.md §16–§18). Contract authored by the tech lead; implementation
// owned by worker A5 (impl-schemas). Worker B5 imports, never edits.
// ---------------------------------------------------------------------------


/**
 * Resolve the report schema for a brief. Returns the resolved JSON-Schema
 * fragment plus its provenance chain, or a rejection reason.
 * Semantics (DESIGN.md §16 + §11 backward compat): reportSchema ABSENT →
 * {ok:true, schema:null, provenance:[]} — base-only validation; schema-less
 * briefs remain valid. Inline object wins (provenance ["inline"]); a string
 * value names a library type; "$extends" chains merge parent-under-child
 * (properties union, required union, other keywords child-wins). Unknown
 * name / cycle / depth overflow / invalid JSON / non-object → {ok:false}.
 *
 * Contract (DESIGN.md §16, two-tier): when projectSchemaDir is provided it is
 * searched FIRST, before the user-level library ~/.pi/agent/pi-delegate-schemas/
 * — project overrides user (first match wins). The CALLER supplies the project
 * root (the orchestrator's cwd + ".pi/delegate-schemas"), because the brief path
 * itself (/tmp/exchange/<task>/) belongs to no project. Tests use
 * resolveReportSchemaInDir to inject a library dir.
 */
export function resolveReportSchema(
	briefPath: string,
	projectSchemaDir?: string,
): { ok: true; schema: Record<string, unknown> | null; provenance: string[] } | { ok: false; error: string } {
	return resolveReportSchemaInDir(briefPath, undefined, projectSchemaDir);
}

/** User-level schema library dir (DESIGN.md §16): under pi's agent dir
 *  (getAgentDir() — honors PI_CODING_AGENT_DIR, default ~/.pi/agent).
 *  Module-level constant computed from the pi export at module load. */
const USER_SCHEMA_DIR = join(getAgentDir(), "pi-delegate-schemas");

/** Max number of "$extends" hops in a chain (cycle-safe backstop). */
const MAX_SCHEMA_DEPTH = 8;

type SchemaResult =
	| { ok: true; schema: Record<string, unknown> | null; provenance: string[] }
	| { ok: false; error: string };

/**
 * resolveReportSchema with an injectable library dir (test seam — bun caches
 * os.homedir(), so $HOME overrides do NOT affect it at call time).
 * schemaDir omitted → real user-level library under pi's agent dir
 * (getAgentDir() — honors PI_CODING_AGENT_DIR).
 * projectSchemaDir (two-tier, §16): when provided, searched FIRST for every
 * library lookup (the root name and every "$extends" parent); user-level
 * (or the schemaDir test seam) is the fallback tier.
 */
export function resolveReportSchemaInDir(briefPath: string, schemaDir?: string, projectSchemaDir?: string): SchemaResult {
	let content: string;
	try {
		content = readFileSync(briefPath, "utf8");
	} catch (err) {
		return { ok: false, error: `Brief not readable at ${briefPath}: ${(err as Error).message}` };
	}
	let frontmatter: unknown;
	try {
		frontmatter = parseFrontmatter(content).frontmatter;
	} catch {
		// Backward compat (DESIGN.md §11): no frontmatter at all → base-only.
		return { ok: true, schema: null, provenance: [] };
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		return { ok: true, schema: null, provenance: [] };
	}
	const declared = (frontmatter as Record<string, unknown>).reportSchema;

	// Two-tier library search (DESIGN.md §16): project-local dir first, then
	// user-level (or the schemaDir test seam). First match wins.
	const load = (name: string) => {
		if (projectSchemaDir !== undefined) {
			const project = loadLibrarySchema(name, projectSchemaDir);
			if (project.ok) return project;
		}
		return loadLibrarySchema(name, schemaDir);
	};

	if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
		// Inline fragment wins (v1.2 behavior, unchanged) — provenance root "inline".
		return resolveExtendsChain("inline", declared as Record<string, unknown>, load);
	}

	if (typeof declared === "string" && declared.length > 0) {
		const loaded = load(declared);
		if (!loaded.ok) return loaded;
		return resolveExtendsChain(declared, loaded.schema, load);
	}

	// reportSchema absent (or not object/string) → base-only (DESIGN.md §11).
	return { ok: true, schema: null, provenance: [] };
}

/**
 * Load one named schema from a single library dir. The two-tier search order
 * (project-local before user-level, §16) lives in the resolver
 * (resolveReportSchema/resolveReportSchemaInDir), which calls this per tier;
 * dirOverride selects the dir to load from (test seam).
 * Unreadable file / invalid JSON / non-object → {ok:false}, never throws.
 */
export function loadLibrarySchema(
	name: string,
	dirOverride?: string,
): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
	const dir = dirOverride ?? USER_SCHEMA_DIR;
	const path = join(dir, `${name}.json`);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, error: `schema library file not readable at ${path}: ${(err as Error).message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `schema library file ${path} is not valid JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: `schema library file ${path} must contain a JSON-Schema object` };
	}
	return { ok: true, schema: parsed as Record<string, unknown> };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge parent-under-child: properties = union (child wins per key),
 * required = union (dedup), every other keyword = child's value when the
 * child declares it, else the parent's. The child's "$extends" (which named
 * the parent being consumed) is replaced by the parent's own "$extends"
 * (grandparent link) so the chain walk can continue.
 */
function mergeParentUnderChild(
	parent: Record<string, unknown>,
	child: Record<string, unknown>,
): Record<string, unknown> {
	const parentExtends = parent.$extends;
	const merged: Record<string, unknown> = { ...parent };
	for (const [key, value] of Object.entries(child)) merged[key] = value;

	if (parent.properties !== undefined || child.properties !== undefined) {
		merged.properties = {
			...(isPlainObject(parent.properties) ? parent.properties : {}),
			...(isPlainObject(child.properties) ? child.properties : {}),
		};
	}
	if (parent.required !== undefined || child.required !== undefined) {
		const req = [
			...(Array.isArray(parent.required) ? parent.required : []),
			...(Array.isArray(child.required) ? child.required : []),
		].filter((v): v is string => typeof v === "string");
		merged.required = [...new Set(req)];
	}
	delete merged.$extends;
	if (parentExtends !== undefined) merged.$extends = parentExtends;
	return merged;
}

/**
 * Resolve "$extends" chains iteratively: walk parent links, merging
 * parent-under-child at each hop. Cycle detection via a visited name set;
 * hard depth cap MAX_SCHEMA_DEPTH. Provenance = resolution order (child
 * first, e.g. ["impl-report", "qa-report"] / ["inline", ...parents]).
 */
function resolveExtendsChain(
	rootName: string,
	rootSchema: Record<string, unknown>,
	load: (name: string) => { ok: true; schema: Record<string, unknown> } | { ok: false; error: string },
): SchemaResult {
	const provenance: string[] = [rootName];
	const visited = new Set([rootName]);
	let current = rootSchema;
	let depth = 0;

	for (;;) {
		const extendsRaw = current.$extends;
		if (extendsRaw === undefined) return { ok: true, schema: current, provenance };
		if (typeof extendsRaw !== "string" || extendsRaw.length === 0) {
			return { ok: false, error: `schema "${provenance[provenance.length - 1]}" has a non-string "$extends"` };
		}
		if (visited.has(extendsRaw)) {
			return {
				ok: false,
				error: `schema "$extends" cycle detected: ${[...provenance, extendsRaw].join(" -> ")}`,
			};
		}
		if (++depth > MAX_SCHEMA_DEPTH) {
			return { ok: false, error: `schema "$extends" chain deeper than ${MAX_SCHEMA_DEPTH} starting at "${rootName}"` };
		}
		const parent = load(extendsRaw);
		if (!parent.ok) {
			return { ok: false, error: `resolving "$extends" of "${provenance[provenance.length - 1]}": ${parent.error}` };
		}
		visited.add(extendsRaw);
		current = mergeParentUnderChild(parent.schema, current);
		provenance.push(extendsRaw);
	}
}

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


// ============================================================================
// SECTION 2 — src/archive.ts (verbatim, incl. its header and imports)
// ============================================================================

/**
 * pi-delegate — report archive (DESIGN.md §19.3).
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A6 (impl-settle). Worker B6 imports, never edits this file.
 *
 * Durability: collected reports are mirrored OUT of /tmp (which dies on
 * reboot — a field task lost every artifact of three phases) into
 * ~/.pi/agent/delegate-archive/<task>/.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Absolute archive root.
 * <p>
 * EXTERNAL_DEPENDENCY: pi's getAgentDir() (honors PI_CODING_AGENT_DIR) — the
 * archive lives at <agentDir>/delegate-archive/, OUTSIDE /tmp (which dies on
 * reboot; see the module header's durability note).
 * BUG_FIX_CONTEXT (Windows HOME misdirection): symptom — on Windows a
 * POSIX-style $HOME (some environments set it) silently redirected the
 * archive outside the real profile. Why the old code failed: HOME-first
 * lookup is a Unix convention, os.homedir() (USERPROFILE) is the Windows
 * truth. Fix: pi's getAgentDir() resolves from os.homedir() on every
 * platform (the Windows truth) — the HOME-misdirection class is gone by
 * construction; in the default environment the resolved path is identical
 * to the old $HOME/.pi/agent/delegate-archive.
 */
export function archiveRoot(): string {
	return path.join(getAgentDir(), "delegate-archive");
}

/**
 * Archive one collected report: copy source →
 * <archiveRoot>/<task>/<basename of reportPath> (basename preserved AS-IS —
 * no "report-" prefix; R6 fix: collected reports are already named
 * report-<worker>.json, a prefix here double-prefixed them), and (re)write
 * <archiveRoot>/<task>/manifest.json from the given manifest object.
 * Best-effort by contract: return the archive report path on success,
 * null on ANY failure (caller shows a warning, never an error).
 */
export function archiveReport(
	taskDir: string,
	reportPath: string,
	manifest: Record<string, unknown>,
): string | null {
	try {
		const task = path.basename(taskDir);
		if (task.length === 0) return null;
		const dir = path.join(archiveRoot(), task);
		fs.mkdirSync(dir, { recursive: true });

		const reportName = path.basename(reportPath);
		if (reportName.length === 0) return null;
		const dest = path.join(dir, reportName);
		fs.copyFileSync(reportPath, dest);

		// Manifest snapshot: atomic tmp+rename so a concurrent reader never
		// observes a half-written manifest.json. Migration stage 2 (audit step 5):
		// the archive path's SECOND hand-rolled atomic-write implementation is
		// deleted — the shared atomicWriteFileSync (same file, ONE protocol) is
		// used instead, so the write protocol has exactly one implementation.
		const manifestPath = path.join(dir, "manifest.json");
		atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return dest;
	} catch {
		// Best-effort by contract: ANY failure → null, never throw.
		return null;
	}
}

/** Retention TTL: archived task dirs older than this are pruned (30 days). */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Retention: delete archived task dirs whose mtime is older than the TTL
 * (ARCHIVE_TTL_MS = 30 days by default; the folder mtime is the age source).
 * Best-effort by contract: ANY failure — missing/unreadable archive root,
 * undeletable task dir — is skipped, never thrown. A broken ttl input
 * (NaN/negative/Infinity) falls back to the default instead of wiping the
 * archive. Returns the number of task dirs removed.
 */
export function pruneArchive(maxAgeMs: number = ARCHIVE_TTL_MS): number {
	const ttl = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : ARCHIVE_TTL_MS;
	try {
		const root = archiveRoot();
		const cutoffMs = Date.now() - ttl;
		let pruned = 0;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue; // stray files are not task dirs
			const dir = path.join(root, entry.name);
			try {
				if (fs.statSync(dir).mtimeMs >= cutoffMs) continue; // fresh — keep
				fs.rmSync(dir, { recursive: true, force: true });
				pruned++;
			} catch {
				// unreadable/undeletable task dir → skip it, keep pruning the rest
			}
		}
		return pruned;
	} catch {
		return 0; // archiveRoot missing/unreadable → nothing to prune, never throw
	}
}

/** List archived tasks (dir names under archiveRoot with a manifest.json). */
export function listArchivedTasks(): string[] {
	try {
		const root = archiveRoot();
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.filter((name) => {
				try {
					return fs.statSync(path.join(root, name, "manifest.json")).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		// archiveRoot missing or unreadable → no archived tasks.
		return [];
	}
}
