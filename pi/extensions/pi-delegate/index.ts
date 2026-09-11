/**
 * pi-delegate — extension entry point.
 *
 * Installs the transport once and registers the delegate tool layer on it.
 * Also mounts the ambient fleet UI (DESIGN.md §19.4) on session_start —
 * guarded by ctx.hasUI so headless runs stay inert. Command wiring
 * (/delegate-fleet, /delegate-teardown) lives in src/observe.ts
 * (registerCommands, moved there in W6) — index only calls it.
 *
 * Install (local-only repo, symlinked into pi's auto-discovery dir):
 *   ln -s /root/projects/pi-delegate ~/.pi/agent/extensions/pi-delegate
 *
 * See DESIGN.md for the architecture and the dependency rule: no src/ module
 * imports the transport implementation — the transport is injected here.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildWorkerView, type SelfIdentity } from "./src/fleet.ts";
import { registerCommands } from "./src/commands.ts";
import { registerStatusTool } from "./src/status-tool.ts";
import { mountSessionWatcher } from "./src/compose.ts";
import { buildWidgetRows, disposeFleetUI, mountFleetUI, type FleetWidgetRow as FleetRow, type FleetUIDeps } from "./src/fleet.ts";
import { createHerdrTransport } from "./src/herdr/host.ts";
import { BUDGET_CONFIG_PATH, DelegateErrorImpl, type Transport } from "./src/host.ts";
import { registerDelegateTool, registerMailboxTool } from "./src/spawn.ts";

// ===========================================================================
// Host binding (workerhost inversion, design §5/§6 migration steps 5–6):
// index.ts is the ONLY module allowed to import a backend adapter — it
// chooses one from the config's `"host"` key and injects it everywhere.
// ===========================================================================

/**
 * Read the `"host"` key from ~/.pi/agent/pi-delegate.config.json (same file
 * as the tiers/defaults tables). Missing key / missing file → "herdr" (the
 * default backend). A non-string or unknown value is a CONFIG ERROR, not a
 * silent fallback — the operator asked for a backend this build cannot serve.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none (reads the config file — EXTERNAL_DEPENDENCY below)
 * Output: the active host name ("herdr" unless configured otherwise)
 * Guarantees:
 *   - missing/corrupt config → "herdr" (default, never throws)
 *   - unknown value → structured DelegateErrorImpl (E_START — the extension
 *     cannot start on an unserveable backend), message names the value + the
 *     supported set
 * Raises:
 *   - DelegateErrorImpl E_START for an unknown/non-string host value
 * EXTERNAL_DEPENDENCY: ~/.pi/agent/pi-delegate.config.json (same file +
 *   tolerant-read convention as resolveSpawnDefaults in src/usage.ts).
 */
function resolveConfiguredHost(): "herdr" {
	let raw: string;
	try {
		raw = readFileSync(BUDGET_CONFIG_PATH, "utf8");
	} catch {
		return "herdr"; // no config → default host
	}
	let host: unknown;
	try {
		host = (JSON.parse(raw) as { host?: unknown }).host;
	} catch {
		return "herdr"; // corrupt config → default host (same tolerance as tiers)
	}
	if (host === undefined) return "herdr";
	if (host !== "herdr" || typeof host !== "string") {
		throw new DelegateErrorImpl(
			"E_START",
			`pi-delegate config: unknown host ${JSON.stringify(host)} — this build ships only the "herdr" backend`,
			`Set "host": "herdr" in ~/.pi/agent/pi-delegate.config.json (the only supported value) or remove the key.`,
		);
	}
	return host;
}

/**
 * Bind the ONE WorkerHost adapter for this session (composition root).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: the adapter implementing the Transport seam
 * Guarantees: the adapter choice is config-driven; unknown host → structured error (see resolveConfiguredHost)
 * Raises: propagates resolveConfiguredHost's E_START on unknown host
 */
function createConfiguredHost(): Transport {
	const host = resolveConfiguredHost();
	if (host === "herdr") return createHerdrTransport();
	throw new DelegateErrorImpl(
		"E_START",
		`pi-delegate: unhandled host "${host}" — no adapter bound`,
		"This build ships only the \"herdr\" backend; fix the config's host key.",
	);
}

// ===========================================================================
// /delegate-fleet + /delegate-teardown commands: moved to src/observe.ts
// (registerCommands) in W6 — index.ts is back to a wiring-only composition
// root (its interface per SPEC).
// ===========================================================================

/**
 * Per-session lifecycle context (Wave 2, ARCHITECTURE.md Law 3 — session
 * lifetime owns everything mounted in it): created by the session_start
 * handler below, stored as the process's current session, and torn down —
 * and ONLY its own handles — by the paired session_shutdown.
 * <p>
 * MODULE_CONTRACT (session lifecycle):
 *   - one pi process runs ONE active session runtime at a time, so the
 *     process holds ONE current context (the last session_start's); pi fires
 *     session_shutdown before session_start on new/resume/fork, so the
 *     pairing holds on every session replacement.
 *   - the WATCHER mounts are additionally arbitrated per session file inside
 *     observe.ts (globalThis registry): a second mount for an already-mounted
 *     session file is refused there — this covers a double module load, where
 *     two copies of THIS module each register handlers (each copy's shutdown
 *     tears down its own context's handles; the refused second watcher mount
 *     returns the first instance's handle, so both copies converge on the
 *     same idempotent stop).
 *   - RESIDUAL (deliberate, documented in observe.ts's header): two separate
 *     pi PROCESSES over the same session file are not arbitrated — no
 *     cross-process lockfile in this wave.
 */
interface SessionLifecycle {
	/** This session's file identity (degradable: undefined when the session
	 *  manager cannot prove it — the gates decide with what is known). */
	sessionFile?: string;
	/** Ambient fleet widget dispose (no-op when headless or not mounted). */
	fleetDispose: () => void;
	/** Watcher stop handle — undefined when the composer did not mount (a
	 *  pure worker session mounts no watcher, F6 two-tier contract). */
	watcherStop?: () => void;
}

/** The current session's lifecycle context (see the contract above). */
let currentSession: SessionLifecycle | null = null;

/**
 * Extension entry point for pi-delegate.
 * <p>
 * FUNCTION_CONTRACT (default export):
 * Input:
 *   - pi: the extension API pi passes on load
 * Output: none — wires the whole tool layer:
 *   - creates ONE herdr transport and registers delegate/status/mailbox tools
 *     and the /delegate-* commands on it
 *   - session_start (ONE handler): builds the per-session lifecycle context
 *     (Law 3) — session file identity, the fleet dispose handle, the watcher
 *     stop handle — and mounts:
 *     · the ambient fleet UI (hasUI-guarded; its module registry replace-on-
 *       reload contract is kept and now disposes the old handle),
 *     · the watcher via the composer (src/compose.ts) — the "worker or
 *       orchestrator" mount decision lives there; the composer returns the
 *       stop handle; a second mount for the same session file is refused in
 *       observe.ts (double module-load guard); the archive is pruned
 *   - session_shutdown: tears down EXACTLY this session's context handles
 *     (fleet dispose + watcher stop). The module-global clears
 *     (disposeFleetUI/stopWatcher) are NOT called here anymore — one
 *     session's shutdown must never touch another session's mounts (Law 3,
 *     audit: the D2 double-delivery mechanism).
 *   - degraded self-id (sessionManager throws) degrades ownership
 *     classification to UNKNOWN — never mislabels a worker "mine"
 *   - watcher/fleet failures are advisory and can never affect
 *     spawn/collect outcomes
 * Raises: none expected from the wiring itself
 */
export default function (pi: ExtensionAPI) {
	const transport = createConfiguredHost();
	registerDelegateTool(pi, transport);
	registerStatusTool(pi, transport);
	registerMailboxTool(pi, transport);
	registerCommands(pi, transport);

	// Wave 2 (Law 3): ONE session_start handler builds the per-session
	// lifecycle context and mounts everything under it. Previously two
	// separate handlers mounted the fleet UI and the watcher and shutdown
	// cleared GLOBAL registries — one session's shutdown could dispose
	// another session's mounts and a double module load ran two watchers
	// (the audit's D2 double-delivery mechanism, closed here + in observe.ts).
	pi.on("session_start", async (_event, ctx) => {
		// Self identity for ownership classification (v1.12.0) + the watcher
		// mount gate: the LIVE sessionManager getter, tolerantly degraded —
		// same wiring as before. Absent self-id → classifyOwnership degrades
		// to UNKNOWN (display is fail-closed) and the mount gates decide with
		// what is known (v1.11.x contract).
		let sessionFile: string | undefined;
		try {
			sessionFile = ctx.sessionManager?.getSessionFile?.();
		} catch {
			sessionFile = undefined;
		}
		const self: SelfIdentity = { sessionFile, cwd: ctx.cwd };

		// Ambient fleet UI (DESIGN.md §19.4): mount on session_start (fires on
		// startup AND on new/resume/fork). Replace-on-reload stays the
		// documented contract for the widget — mountFleetUI disposes the old
		// handle when replacing (never leaks); inert headless — the hasUI guard
		// here is belt-and-braces so deps are not even built headless.
		let fleetDispose: () => void = () => {};
		if (ctx.hasUI) {
			let placedCount = 0;
			const deps: FleetUIDeps = {
				async getRows(): Promise<FleetRow[]> {
					// Called every 2 s by the fleet UI; each call is a full read sweep:
					// EXTERNAL_DEPENDENCY: herdr statuses (transport), manifest files,
					// worker session JSONLs (usage gauges) and p-<name>.jsonl pings.
					// Wave 2 (Law 9): the row assembly itself lives in fleet.ts
					// (buildWidgetRows) — one implementation for widget and overlay.
					const views = await buildWorkerView(transport);
					placedCount = views.length;
					return buildWidgetRows(views, self);
				},
			};
			fleetDispose = mountFleetUI(ctx, deps);
		}

		// Event-driven watcher (DESIGN.md §21): the replacement for the
		// improvised bash sleep after E_TIMEOUT. Mounted for EVERY session —
		// deliberately NOT behind ctx.hasUI: the wake-up matters headless too
		// (rpc/print). The composer returns the stop handle (Law 3: mounts
		// return handles); a second mount for an already-mounted session file
		// is refused inside observe.ts (double module-load guard). Every
		// failure is advisory, so a broken watcher can never affect
		// spawn/collect outcomes.
		const watcher = mountSessionWatcher({
			pi,
			transport,
			self,
			sessionManager: ctx.sessionManager,
		});

		currentSession = { sessionFile, fleetDispose, watcherStop: watcher.stop };
	});

	// Session-end cleanup (quality fix A7 + Wave 2 Law 3): the fleet UI's 2 s
	// poll (herdr `agent list` + manifest reads) and the watcher's interval
	// must not outlive the session — but teardown touches ONLY this session's
	// handles (the context object above), never the global registries: one
	// session's shutdown must not stop another session's watcher. Event name
	// verified in pi docs (extensions.md): "session_shutdown" fires before
	// teardown for quit/reload/new/resume/fork.
	pi.on("session_shutdown", async (_event, _ctx) => {
		const session = currentSession;
		currentSession = null;
		if (!session) return;
		try {
			session.fleetDispose();
		} catch {
			// advisory — never throw past session_shutdown
		}
		try {
			session.watcherStop?.();
		} catch {
			// advisory — never throw past session_shutdown
		}
	});
}
