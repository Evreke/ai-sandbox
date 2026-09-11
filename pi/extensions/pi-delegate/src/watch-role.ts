/**
 * pi-delegate — canonical ownership verdict for the watcher (stage A).
 * <p>
 * MODULE_CONTRACT: the ONE source of truth for wake-ownership semantics
 * (WATCHER-ARCHITECTURE-GUIDELINE.md §3.4–§3.6). Three consumers fold the
 * same verdict into their own vocabulary: delivery (observe.ts
 * detectWorkerEvents — deliver only on a proven owner), the mount gate
 * (observe.ts isWorkerSession/ownsChildManifests via sessionRole) and the UI
 * display (fleet.ts classifyOwnership). This module is a LEAF: it imports
 * NOTHING from production code — manifest and session shapes are declared
 * structurally here — because observe.ts already imports fleet.ts, so
 * fleet.ts cannot import observe.ts (a module cycle breaks the extension
 * loader; field lesson, commit 83ccaab). No herdr-adapter imports
 * (dependency rule, guideline §7.2). No filesystem, no transport, no clock:
 * pure functions over plain data, tolerant of garbage fields by design (a
 * manifest is untyped JSON at the edge).
 * Critical invariants:
 *   - delivery is fail-closed: only the verdict "mine" delivers; the
 *     "no-owner" edge may be rolled back ONLY by the explicit
 *     watch.legacyFailOpen flag; the "no-self-id" edge has NO configuration
 *     escape (guideline §3.6) — the flag never reaches it;
 *   - worker-level orchestratorSessionPath is the canon owner field
 *     (guideline §3.2); masterSessionPath is fleet accounting and only a
 *     fallback (the B1 narrowing lives inside the "foreign" verdict);
 *   - this module never WRITES owner fields — ownership is recorded by the
 *     spawn path only (guideline §3.3).
 * Exported surface: AudienceVerdict, OwnerFields, SessionIdentity,
 * AudienceOptions, workerAudienceMatch, SessionRole, sessionRole.
 * Error modes: none — every read degrades (non-string/garbage owner fields
 * read as absent), never throws.
 */

/** The four wake-ownership verdicts (guideline §3.5/§3.6 vocabulary). */
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
	 *  NEVER delivers — the flag does not control this edge (§3.6). */
	| "no-self-id";

/** The owner-recording fields a manifest may carry (all optional, all
 *  untyped JSON at the edge — non-string garbage reads as absent). */
export interface OwnerFields {
	/** Worker-level owner (the canon, guideline §3.2): the spawning
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
	/** This session's cwd (ctx.cwd) — consumed by the mount-side role table
	 *  (sessionRole) only, never by the delivery verdict. */
	cwd?: string;
}

/** Caller options for the delivery-side verdict. */
export interface AudienceOptions {
	/** Explicit rollback for the "no-owner" edge ONLY (watch.legacyFailOpen,
	 *  default false): legacy manifests without any owner field deliver to
	 *  every mounted watcher when true — unsafe on a machine with several
	 *  sessions. NEVER extends to the "no-self-id" edge. */
	legacyFailOpen: boolean;
}

function nonEmptyString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The canonical wake-ownership verdict for ONE worker entry as seen from ONE
 * session (guideline §3.5/§3.6). Pure, tolerant, no I/O.
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
 *     neither prove nor disprove ownership, and §3.6 gives it no
 *     configuration escape — the flag is deliberately NOT consulted when the
 *     self-id is missing (a legacyFailOpen:true session with a degraded id
 *     still delivers nothing);
 *   - worker-level owner wins over master-level (guideline §3.2: the canon
 *     is the worker entry's orchestratorSessionPath; masterSessionPath only
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
	return (workerOwner ?? masterOwner) === selfId ? "mine" : "foreign";
}

/** The two mount-side roles of the guideline §3.4 table. */
export interface SessionRole {
	/** True when this session IS one of the manifest's workers (a fleet row,
	 *  not an audience): exact session JSONL path, or — for worktree
	 *  placements only — the unique per-worker checkout path equal to this
	 *  session's cwd. That cwd/checkoutPath branch is an IDENTITY EQUIVALENT
	 *  FOR MOUNTING ONLY: the delivery verdict never accepts it (guideline
	 *  §3.6 — delivery needs a proven session id). */
	isWorker: boolean;
	/** True only when some worker entry names this session's PROVEN
	 *  sessionFile as its orchestrator — the tier-1 worker-orchestrator
	 *  exception (guideline §3.4): such a session stays an audience for its
	 *  own children. Always false for a degraded self-id. */
	ownsChildren: boolean;
}

/** Structural manifest slice this module reads (untyped JSON at the edge —
 *  declared locally to keep the module a leaf with zero production imports). */
export interface ManifestLike {
	workers?: unknown;
}

/**
 * The single role-table check (guideline §3.4) both mount gates derive from:
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
 *   - the cwd/checkoutPath isWorker branch covers the spawn race (the
 *     manifest record predates the worker's sessionPath) and tab workers are
 *     NEVER matched by cwd (shared checkout is ambiguous);
 *   - pure: no I/O, no lookback window (asks about a SESSION, which may
 *     outlive the 24 h fleet), never throws
 * Raises: never
 */
export function sessionRole(self: SessionIdentity, manifests: ReadonlyArray<ManifestLike | null | undefined>): SessionRole {
	const selfId = nonEmptyString(self.sessionFile);
	let isWorker = false;
	let ownsChildren = false;
	for (const m of manifests ?? []) {
		const workers = (m as ManifestLike | null | undefined)?.workers;
		if (!Array.isArray(workers)) continue;
		for (const w of workers) {
			if (w === null || typeof w !== "object") continue;
			const e = w as Record<string, unknown>;
			if (!isWorker && selfId !== undefined && e.sessionPath === selfId) {
				isWorker = true;
			}
			if (!isWorker && self.cwd !== undefined) {
				const placement = e.placement;
				if (
					placement !== null &&
					typeof placement === "object" &&
					(placement as Record<string, unknown>).kind === "worktree"
				) {
					const checkoutPath = (placement as Record<string, unknown>).checkoutPath;
					if (typeof checkoutPath === "string" && checkoutPath === self.cwd) isWorker = true;
				}
			}
			if (
				!ownsChildren &&
				selfId !== undefined &&
				e.orchestratorSessionPath === selfId &&
				nonEmptyString(e.orchestratorSessionPath) !== undefined
			) {
				ownsChildren = true;
			}
			if (isWorker && ownsChildren) return { isWorker, ownsChildren };
		}
	}
	return { isWorker, ownsChildren };
}
