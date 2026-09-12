/**
 * pi-delegate — canonical ownership verdict for the watcher (stage A).
 * <p>
 * MODULE_CONTRACT: the ONE source of truth for wake-ownership semantics —
 * the role table and the ownership verdicts live HERE (this module is the
 * canon; test/ownership-check.ts and test/composer-check.ts pin it). Three
 * consumers fold the
 * same verdict into their own vocabulary: delivery (observe.ts
 * detectWorkerEvents — deliver only on a proven owner), the mount gate
 * (observe.ts isWorkerSession/ownsChildManifests via sessionRole) and the UI
 * display (fleet.ts classifyOwnership). This module is a LEAF: it imports
 * NOTHING from production code — manifest and session shapes are declared
 * structurally here — because observe.ts already imports fleet.ts, so
 * fleet.ts cannot import observe.ts (a module cycle breaks the extension
 * loader; field lesson, commit 83ccaab). No herdr-adapter imports
 * (dependency rule, ARCHITECTURE.md Law 6). No filesystem, no transport, no clock:
 * pure functions over plain data, tolerant of garbage fields by design (a
 * manifest is untyped JSON at the edge).
 * Critical invariants:
 *   - delivery is fail-closed: only the verdict "mine" delivers; the
 *     "no-owner" edge may be rolled back ONLY by the explicit
 *     watch.legacyFailOpen flag; the "no-self-id" edge has NO configuration
 *     escape (fail-closed, ARCHITECTURE.md Law 8) — the flag never reaches it;
 *   - worker-level orchestratorSessionPath is the canon owner field;
 *     masterSessionPath is fleet accounting and only a
 *     fallback (the B1 narrowing lives inside the "foreign" verdict);
 *   - this module never WRITES owner fields — ownership is recorded by the
 *     spawn path only.
 * Windows session-path policy (TZ 1.17.0 §3.4): every session-path identity
 * compare in this module goes through the ONE helper sameSessionPath —
 * byte-identical `===` on POSIX (Linux FS is case-sensitive; casefolding
 * "just in case" would be a POSIX regression), and on win32 a casefold +
 * separator fold (`/` and `\` to one shape) so drive-letter/component casing
 * drift between the owner writer and the live reader cannot make an
 * orchestrator foreign to its own workers. No ad-hoc toLowerCase at a
 * single call site, ever.
 * Exported surface: AudienceVerdict, OwnerFields, SessionIdentity,
 * AudienceOptions, workerAudienceMatch, SessionRole, sessionRole,
 * sameSessionPath.
 * Error modes: none — every read degrades (non-string/garbage owner fields
 * read as absent), never throws.
 */

/** The four wake-ownership verdicts (the delivery vocabulary of this
 *  module). */
export type AudienceVerdict =
	/** Proven owner — this session recorded itself as the worker's owner. */
	| "mine"
	/** Proven owner — a DIFFERENT session (worker-level or, as the B1
	 *  fallback, manifest-level masterSessionPath). Never delivers. */
	| "foreign"
	/** No owner field anywhere on the manifest (true legacy). Delivers only
	 *  when the caller's legacyFailOpen flag is true. */
	| "no-owner"
	/** This session's identity is unreadable (no session file path).
	 *  NEVER delivers — the flag does not control this edge (fail-closed,
	 *  ARCHITECTURE.md Law 8). */
	| "no-self-id";

/** The owner-recording fields a manifest may carry (all optional, all
 *  untyped JSON at the edge — non-string garbage reads as absent). */
export interface OwnerFields {
	/** Worker-level owner (the canon): the spawning
	 *  orchestrator's session JSONL path, written by spawn at record time. */
	orchestratorSessionPath?: string;
	/** Manifest-level fleet owner (F1, written since 1.15.0 by the FIRST
	 *  delegate call of a task). Fleet accounting; only a wake-routing
	 *  FALLBACK when the worker-level field is absent. */
	masterSessionPath?: string;
}

/** This session's identity, as far as the session could read it. */
export interface SessionIdentity {
	/** This session's JSONL path (ctx.sessionManager.getSessionFile()).
	 *  Undefined = degraded self-id (headless, getter threw). */
	sessionFile?: string;
	/** This session's cwd (ctx.cwd) — NOT consumed by the role table since
	 *  the stage C mount-gate fix (worker identity is the entry's own
	 *  sessionPath only); kept for shape compatibility with SelfIdentity
	 *  and the display-side fallback in fleet.ts. Never by the delivery
	 *  verdict. */
	cwd?: string;
}

/** Caller options for the delivery-side verdict. */
export interface AudienceOptions {
	/** Explicit rollback for the "no-owner" edge ONLY (watch.legacyFailOpen,
	 *  default false): legacy manifests without any owner field deliver to
	 *  every mounted watcher when true — unsafe on a machine with several
	 *  sessions. NEVER extends to the "no-self-id" edge. */
	legacyFailOpen: boolean;
	/** Optional path-comparison platform for the owner compare (TZ §3.4):
	 *  "win32" enables the casefold + separator-fold session-path policy,
	 *  anything else keeps the POSIX-exact `===`. Default process.platform.
	 *  Additive, optional — existing callers are unchanged. */
	platform?: NodeJS.Platform;
}

/**
 * Session-path identity compare (TZ 1.17.0 §3.4): THE one helper for every
 * "is this manifest session path the same file as this session's path?"
 * question. On POSIX it is a byte-identical `===` — exactly what the raw
 * compares did before, so nothing changes on Linux/macOS (a case-sensitive
 * FS may legitimately host two paths differing only by case; folding them
 * would be a POSIX regression). On win32 it casefolds and folds BOTH
 * separators (`/` and `\`) to `\` before comparing, because a Windows
 * session file path may drift in drive-letter/component casing between the
 * writer (spawn recording orchestratorSessionPath) and the reader (the
 * live session identity) without being a different file.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - a, b: session JSONL file paths as recorded/read (may be any strings;
 *     callers gate on non-empty before calling)
 *   - platform: NodeJS.Platform, default process.platform — injected in
 *     tests; production call sites pass the ambient platform
 * Output: true iff the two paths denote the same session file under the
 *   platform's comparison policy
 * Guarantees:
 *   - POSIX (platform !== "win32"): byte-identical to the former raw `===`
 *     compare — no casefolding, no separator folding, no normalization
 *     (TZ §4.2 regression barrier, acceptance criterion 8)
 *   - win32: ASCII/lowercase casefold via toLowerCase plus folding of `/`
 *     and `\` runs to a single `\`; NOTHING else folds — no
 *     trailing-separator stripping (these are FILE paths, not dirs), no
 *     drive-relative or UNC or short-name (8.3) normalization, no `..`
 *     resolution
 *   - leaf-safe: plain string ops only — no node:path, no src/ imports
 *   - pure: no I/O, never throws
 * Raises: never
 */
export function sameSessionPath(
	a: string,
	b: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return a === b;
	return a.toLowerCase().replace(/[\\/]+/g, "\\") === b.toLowerCase().replace(/[\\/]+/g, "\\");
}

function nonEmptyString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The canonical wake-ownership verdict for ONE worker entry as seen from ONE
 * session (workerAudienceMatch's four verdicts). Pure, tolerant, no I/O.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - ownerFields: the manifest's owner fields for this worker (worker-level
 *     orchestratorSessionPath and/or manifest-level masterSessionPath);
 *     non-string or empty values read as absent
 *   - self: this session's identity (sessionFile is the only field the
 *     verdict consults; cwd is accepted for shape compatibility and ignored)
 *   - opts: the legacyFailOpen flag (see AudienceOptions)
 * Output: one of four verdicts — "mine" (proven owner is this session),
 *   "foreign" (proven owner is another session), "no-owner" (no owner field
 *   anywhere on the manifest), "no-self-id" (this session's identity is
 *   unreadable)
 * Guarantees:
 *   - the DELIVERY rule built on this verdict (observe.ts) is: deliver only
 *     on "mine"; on "no-owner" deliver only when legacyFailOpen is true; on
 *     "foreign" and "no-self-id" NEVER deliver;
 *   - the "no-self-id" edge wins over everything: an unreadable identity can
 *     neither prove nor disprove ownership, and the fail-closed law
 *     (ARCHITECTURE.md Law 8) gives it no escape — the flag is deliberately NOT consulted when the
 *     self-id is missing (a legacyFailOpen:true session with a degraded id
 *     still delivers nothing);
 *   - worker-level owner wins over master-level (the canon is the worker
 *     entry's orchestratorSessionPath; masterSessionPath only
 *     narrows when the worker-level field is absent — the B1 fallback);
 *   - pure: no I/O, no globals, tolerant of garbage fields, never throws
 * Raises: never
 */
export function workerAudienceMatch(
	ownerFields: OwnerFields,
	self: SessionIdentity,
	opts: AudienceOptions,
): AudienceVerdict {
	// EXTERNAL (identity source): self.sessionFile comes from the live
	// sessionManager getter at the call site; undefined = degraded self-id.
	const selfId = nonEmptyString(self.sessionFile);
	if (selfId === undefined) return "no-self-id";
	const workerOwner = nonEmptyString(ownerFields.orchestratorSessionPath);
	const masterOwner = nonEmptyString(ownerFields.masterSessionPath);
	if (workerOwner === undefined && masterOwner === undefined) return "no-owner";
	const owner = workerOwner ?? masterOwner;
	if (owner === undefined) return "no-owner";
	// BUG_FIX_CONTEXT (TZ 1.17.0 §3.4, acceptance criterion 7): symptom — on
	// Windows the owner path could drift in drive-letter/component casing
	// (`C:\Users\…` recorded by spawn vs `c:\users\…` read live), and the raw
	// `===` classified the orchestrator as "foreign" for its OWN workers, so
	// wakes silently never delivered (delivery is fail-closed on "foreign").
	// Why the raw `===` was wrong: it is correct on POSIX (case-sensitive FS,
	// byte-identical intent) but wrong on win32 where casing drift does not
	// make a different file. What was done: ONE helper, sameSessionPath,
	// with an explicit platform policy (posix: exact `===`; win32: casefold
	// + separator fold) — the platform is injectable via AudienceOptions
	// for tests, defaulting to process.platform. No ad-hoc toLowerCase at
	// a single call site.
	return sameSessionPath(owner, selfId, opts.platform) ? "mine" : "foreign";
}

/** The two mount-side roles of the wake-ownership role table (this module's
 *  sessionRole). */
export interface SessionRole {
	/** True when this session IS one of the manifest's workers (a fleet row,
	 *  not an audience): EXACT match between the entry's own `sessionPath`
	 *  (the worker session's JSONL path) and this session's proven
	 *  sessionFile. The former checkoutPath === cwd mounting equivalent was
	 *  REMOVED (stage C fix): it is ambiguous by construction — tab workers
	 *  share the orchestrator's checkout, and a HISTORICAL worker entry
	 *  poisoned the gate for every future session started in that cwd (an
	 *  orchestrator silently lost its watcher). A cwd match alone proves
	 *  nothing; unproven reads as "not a worker" and the session mounts
	 *  (harmless: delivery stays fail-closed — ARCHITECTURE.md Law 8). */
	isWorker: boolean;
	/** True only when some worker entry names this session's PROVEN
	 *  sessionFile as its orchestrator — the tier-1 worker-orchestrator
	 *  exception (the role table's tier-1 case): such a session stays an audience for its
	 *  own children. Always false for a degraded self-id. */
	ownsChildren: boolean;
}

/** Structural manifest slice this module reads (untyped JSON at the edge —
 *  declared locally to keep the module a leaf with zero production imports). */
export interface ManifestLike {
	workers?: unknown;
}

/**
 * The single role-table check both mount gates derive from:
 * isWorker (pure worker / worker-orchestrator row) and ownsChildren (the
 * tier-1 exception). The table's four roles map onto it as:
 * pure orchestrator = not isWorker; pure worker = isWorker && !ownsChildren;
 * worker-orchestrator (tier-1) = isWorker && ownsChildren (only with a
 * PROVEN sessionFile); foreign = whatever delivery answers "foreign" or
 * "no-self-id" to. Pure, tolerant, no I/O.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - self: this session's identity (sessionFile + cwd)
 *   - manifests: manifests from the manifest scan (untyped JSON — may be
 *     garbage; null/foreign-shaped entries degrade, never throw)
 * Output: { isWorker, ownsChildren } — see SessionRole
 * Guarantees:
 *   - the mount rule built on this verdict (compose.ts) is: mount everything
 *     EXCEPT a proven pure worker (isWorker && !ownsChildren); mounting at an
 *     unknown role is deliberate and safe ONLY because delivery is
 *     fail-closed (a mounted watcher without a proven identity delivers
 *     nothing);
 *   - ownsChildren requires a proven sessionFile — a degraded tier-1 lead
 *     (getter threw) owns nothing and its child wakes are lost (documented,
 *     known behavior);
 *   - isWorker is matched by the entry's OWN sessionPath only — the
 *     former cwd/checkoutPath branch was removed as ambiguous (stage C
 *     fix): tab workers share the orchestrator's checkout, and a
 *     historical worker entry used to poison the gate for ANY new session
 *     started in that cwd. Consequence: during the spawn race (the
 *     manifest record predates the worker's sessionPath) a worker session
 *     may briefly MOUNT a watcher — harmless, because delivery is
 *     fail-closed and the entry's owner is another session;
 *   - pure: no I/O, no lookback window (asks about a SESSION, which may
 *     outlive the 24 h fleet), never throws
 * Raises: never
 */
export function sessionRole(
	self: SessionIdentity,
	manifests: ReadonlyArray<ManifestLike | null | undefined>,
	opts: { platform?: NodeJS.Platform } = {},
): SessionRole {
	// TZ §3.4: the platform is injectable for tests; default = ambient
	// process.platform via sameSessionPath's own default. Optional and
	// additive — existing callers are unchanged.
	const platform = opts.platform;
	const selfId = nonEmptyString(self.sessionFile);
	let isWorker = false;
	let ownsChildren = false;
	for (const m of manifests ?? []) {
		const workers = (m as ManifestLike | null | undefined)?.workers;
		if (!Array.isArray(workers)) continue;
		for (const w of workers) {
			if (w === null || typeof w !== "object") continue;
			const e = w as Record<string, unknown>;
			// Worker identity: the entry's OWN sessionPath only. A cwd match
			// (even against a worktree entry's unique checkoutPath) is NOT
			// identity — a historical entry would poison the gate for every
			// future session in that cwd (stage C fix, BUG_FIX_CONTEXT in the
			// commit message). A degraded self-id (selfId undefined) can match
			// nothing → "not a worker" → the session mounts (fail-open toward
			// MOUNTING; delivery stays fail-closed — ARCHITECTURE.md Law 8).
			if (
				!isWorker &&
				selfId !== undefined &&
				typeof e.sessionPath === "string" &&
				sameSessionPath(e.sessionPath, selfId, platform)
			) {
				isWorker = true;
			}
			if (
				!ownsChildren &&
				selfId !== undefined &&
				typeof e.orchestratorSessionPath === "string" &&
				nonEmptyString(e.orchestratorSessionPath) !== undefined &&
				sameSessionPath(e.orchestratorSessionPath, selfId, platform)
			) {
				ownsChildren = true;
			}
			if (isWorker && ownsChildren) return { isWorker, ownsChildren };
		}
	}
	return { isWorker, ownsChildren };
}
