/**
 * pi-delegate — watcher composition module (migration stage 3, audit step 10).
 * <p>
 * MODULE_CONTRACT: mounts the event-driven background watcher (DESIGN.md §21)
 * for one session start. The "worker or orchestrator" decision — which
 * sessions get a watcher — lives HERE and nowhere else: a PURE manifest
 * worker mounts NO watcher (it is someone's fleet row, not an audience), a
 * worker-orchestrator that OWNS child manifests mounts one (F6 two-tier
 * wake-up, scoped to its own children by detectWorkerEvents), and every
 * other session mounts one as before. index.ts calls this composer and does
 * nothing else — the composition root stays wiring-only.
 * <p>
 * Dependencies: observe.ts (the gates isWorkerSession / ownsChildManifests +
 * startWatcher), exchange.ts (manifestStore + pruneArchive), ./host.ts (the
 * Transport seam). Every collaborator is injectable so the mount DECISION is
 * unit-testable without pi, herdr, or the filesystem.
 * Exported surface: SessionWatcherDeps, SessionWatcherResult, mountSessionWatcher.
 * Critical invariants:
 *   - the mount rule: mount everything EXCEPT a proven pure worker — unknown
 *     or garbage manifests degrade to "not a worker" and the watcher mounts.
 *     Watcher stage A: mounting at an UNKNOWN role remains deliberate ONLY
 *     because delivery is now FAIL-CLOSED (src/watch-role.ts): a mounted
 *     watcher without a proven owner/identity delivers nothing, so a
 *     spuriously mounted watcher is harmless noise, never a wrong wake (the
 *     old justification "fail-open toward MOUNTING: a lost wake-up is worse
 *     than a spurious one" described the pre-stage-A delivery, which could
 *     wake bystanders);
 *   - the mount and the archive prune are advisory by contract: a failure in
 *     either must never affect spawn/collect outcomes (§21) — the composer
 *     swallows nothing itself, the collaborators are tolerant by their own
 *     contracts;
 *   - degraded self-id (sessionManager throws) is passed through as-is —
 *     the gates decide with what is known (v1.11.x ownership contract).
 *     Stage C fix: worker identity is the entry's OWN sessionPath only, so
 *     a DEGRADED tier-1 lead (getSessionFile() throws) is no longer
 *     classified a pure worker — it proves nothing, reads as "not a
 *     worker" and MOUNTS a watcher (fail-open toward MOUNTING). Its child
 *     wakes are still lost, but now on the DELIVERY side, where guideline
 *     §3.6 requires the fail-closed edge: a session without a proven
 *     session id delivers nothing (documented known behavior).
 * Error modes: none of its own — rethrows only what injected collaborators
 * throw (production collaborators never do).
 */

import { manifestStore, pruneArchive } from "./exchange.ts";
import { isWorkerSession, ownsChildManifests, startWatcher } from "./observe.ts";
import type { SelfIdentity } from "./observe.ts";
import type { Transport } from "./host.ts";

/** The slice of the pi extension API the watcher needs (delivery + registry). */
type PiLike = Parameters<typeof startWatcher>[0];

export interface SessionWatcherDeps {
	/** The pi extension API (makeSender delivery sink + watcher registry). */
	pi: PiLike;
	/** The injected Transport seam (never the adapter implementation). */
	transport: Transport;
	/** This session's identity (sessionFile + cwd) — see SelfIdentity. */
	self: SelfIdentity;
	/** The LIVE sessionManager getter, threaded to startWatcher verbatim. */
	sessionManager?: { getSessionFile?: () => string | undefined };
	/** Manifest read (injectable; default manifestStore.scan(backendName())). */
	scanManifests?: (backend: string) => Parameters<typeof isWorkerSession>[1];
	/** Worker gate (injectable; default the real isWorkerSession). */
	workerGate?: (self: SelfIdentity, manifests: Parameters<typeof isWorkerSession>[1]) => boolean;
	/** Child-ownership gate (injectable; default the real ownsChildManifests). */
	childOwnerGate?: (self: SelfIdentity, manifests: Parameters<typeof ownsChildManifests>[1]) => boolean;
	/** Watcher mount (injectable; default the real startWatcher). */
	mount?: typeof startWatcher;
	/** Archive retention (injectable; default the real pruneArchive). */
	prune?: () => void;
}

export interface SessionWatcherResult {
	/** True when the watcher was mounted for this session. */
	mounted: boolean;
}

/**
 * Decide "worker or orchestrator" for one session start and mount the
 * watcher accordingly, then prune the archive (§19.3, once per session
 * start, best-effort).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - deps.pi / deps.transport: the composition root's binding (index.ts)
 *   - deps.self: this session's identity; a degraded sessionFile (undefined)
 *     proves nothing — the role table reads "not a worker" and the session
 *     MOUNTS (stage C: worker identity is the entry's own sessionPath only;
 *     a degraded tier-1 lead therefore mounts a watcher, but delivery is
 *     fail-closed so it still wakes for nothing — the child-wake loss moved
 *     from the mount side to the delivery side, where §3.6 requires it)
 *   - injected collaborators default to the production ones (scan via
 *     manifestStore + the Transport's backend name)
 * Output: { mounted } — whether startWatcher ran
 * Guarantees:
 *   - PURE worker (isWorkerSession true, ownsChildManifests false) → NOT
 *     mounted; worker-orchestrator or peer orchestrator or bystander →
 *     mounted (the F6 two-tier contract, in ONE place). Both gates are thin
 *     wrappers over the canonical role table (src/watch-role.ts sessionRole)
 *     — mount and delivery cannot disagree (guideline §3.4: a "UI says
 *     foreign but the wake left" mismatch is a defect)
 *   - the prune runs exactly once per call, mounted or not
 * Raises:
 *   - only what the injected collaborators throw (production: none —
 *     scan/lock gates and startWatcher are tolerant by contract)
 */
export function mountSessionWatcher(deps: SessionWatcherDeps): SessionWatcherResult {
	const manifests = (deps.scanManifests ?? ((backend: string) => manifestStore.scan(backend)))(
		deps.transport.backendName(),
	);
	const isWorker = (deps.workerGate ?? isWorkerSession)(deps.self, manifests);
	const ownsChildren = (deps.childOwnerGate ?? ownsChildManifests)(deps.self, manifests);
	const mounted = !isWorker || ownsChildren;
	if (mounted) {
		(deps.mount ?? startWatcher)(deps.pi, deps.transport, {
			cwd: deps.self.cwd,
			sessionManager: deps.sessionManager,
		});
	}
	(deps.prune ?? pruneArchive)(); // §19.3 retention: once per session start
	return { mounted };
}
