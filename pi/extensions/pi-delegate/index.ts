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
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProbeDir, manifestStore, progressPathFor, readLastProgress } from "./src/exchange.ts";
import { buildWorkerView, classifyOwnership, type SelfIdentity } from "./src/fleet.ts";
import { registerCommands, registerStatusTool, stopWatcher } from "./src/observe.ts";
import { mountSessionWatcher } from "./src/compose.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "./src/usage.ts";
import { disposeFleetUI, mountFleetUI, type FleetWidgetRow as FleetRow, type FleetUIDeps } from "./src/fleet.ts";
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

/** Per-worker manifest extras not projected onto WorkerView (session JSONL
 *  path + recorded effective budget) — read tolerantly, same shape fleet.ts
 *  uses for its overlay rows. */
interface ManifestExtras {
	sessionPath?: string;
	budgetTokens?: number;
	model?: string;
	orchestratorSessionPath?: string;
	/** Watcher stage A: the manifest-level fleet owner (F1) — feeds the
	 *  canonical display mapping so a known-foreign master renders foreign. */
	masterSessionPath?: string;
}

async function readManifestExtras(dir: string, name: string): Promise<ManifestExtras> {
	try {
		// Migration stage 2 (audit step 5): the raw manifest.json re-parse is
		// GONE — the read goes through the manifest storage port (manifestStore,
		// file-backed, tolerant; one reader of the manifest protocol fewer).
		// EXTERNAL_DEPENDENCY: exchange manifest at <dir>/manifest.json
		// (dir under /tmp/exchange/<task>/) — read tolerantly per refresh tick.
		const manifest = manifestStore.read(dir);
		if (!manifest) return {};
		const w = manifest.workers.find((x) => x.name === name);
		if (!w) return {};
		const extras: ManifestExtras = {};
		if (typeof w.sessionPath === "string" && w.sessionPath.length > 0) extras.sessionPath = w.sessionPath;
		if (typeof w.budgetTokens === "number" && Number.isFinite(w.budgetTokens) && w.budgetTokens > 0) {
			extras.budgetTokens = w.budgetTokens;
		}
		if (typeof w.orchestratorSessionPath === "string" && w.orchestratorSessionPath.length > 0) {
			extras.orchestratorSessionPath = w.orchestratorSessionPath;
		}
		// Watcher stage A: the manifest-level fleet owner feeds the canonical
		// display mapping (classifyOwnership → workerAudienceMatch).
		if (typeof manifest.masterSessionPath === "string" && manifest.masterSessionPath.length > 0) {
			extras.masterSessionPath = manifest.masterSessionPath;
		}
		return extras;
	} catch {
		return {}; // missing/corrupt manifest → zero-usage row, never throw
	}
}

// ===========================================================================
// /delegate-fleet + /delegate-teardown commands: moved to src/observe.ts
// (registerCommands) in W6 — index.ts is back to a wiring-only composition
// root (its interface per SPEC).
// ===========================================================================

/**
 * Extension entry point for pi-delegate.
 * <p>
 * FUNCTION_CONTRACT (default export):
 * Input:
 *   - pi: the extension API pi passes on load
 * Output: none — wires the whole tool layer:
 *   - creates ONE herdr transport and registers delegate/status/mailbox tools
 *     and the /delegate-* commands on it
 *   - session_start #1: mounts the ambient fleet UI (hasUI-guarded)
 *   - session_start #2: calls the watcher composer (src/compose.ts) — the
 *     "worker or orchestrator" mount decision lives there; prunes the archive
 *   - session_shutdown: disposes the fleet UI + stops the watcher (no timer
 *     outlives the session)
 * Guarantees:
 *   - idempotent mounts (double mount/start replaces via module registries)
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

	// Ambient fleet UI (DESIGN.md §19.4): mount on session_start (fires on
	// startup AND on new/resume/fork). mountFleetUI is idempotent (double-mount
	// replaces via its module-level registry) and inert headless — the hasUI
	// guard here is belt-and-braces so deps are not even built headless.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Self identity for ownership classification (v1.12.0): the LIVE
		// sessionManager getter, tolerantly degraded — same wiring as the
		// watcher (observe.ts startWatcher). Absent self-id → classifyOwnership
		// degrades to UNKNOWN, never "mine" (display is fail-closed).
		const self: SelfIdentity = (() => {
			let sessionFile: string | undefined;
			try {
				sessionFile = ctx.sessionManager?.getSessionFile?.();
			} catch {
				sessionFile = undefined;
			}
			return { sessionFile, cwd: ctx.cwd };
		})();

		let placedCount = 0;
		const deps: FleetUIDeps = {
			async getRows(): Promise<FleetRow[]> {
				// Called every 2 s by the fleet UI; each call is a full read sweep:
				// EXTERNAL_DEPENDENCY: herdr statuses (transport), manifest files,
				// worker session JSONLs (usage gauges) and p-<name>.jsonl pings.
				const views = await buildWorkerView(transport);
				placedCount = views.length;
				return Promise.all(
					views.map(async (v) => {
					const extras = await readManifestExtras(v.dir, v.name);
					const usage = parseSessionUsage(extras.sessionPath ?? "");
					const window = resolveContextWindow(extras.model);
					let lastPing: FleetRow["lastPing"];
					try {
						lastPing = readLastProgress(progressPathFor(v.dir, v.name)) ?? undefined;
					} catch {
						lastPing = undefined; // advisory — absent ping → no marker
					}
					return {
						name: v.name,
						status: v.status,
						kind: v.kind,
						branch: v.branch,
						reportExists: v.reportExists,
						isProbe: isProbeDir(v.dir),
						inputTokens: usage.input,
						outputTokens: usage.output,
						budgetPct: contextPct(usage, window),
						lastPing,
						ownership: classifyOwnership(
							extras.orchestratorSessionPath,
							self,
							v.placement,
							extras.masterSessionPath,
						),
						task: basename(v.dir),
					};
					}),
				);
			},
		};
		mountFleetUI(ctx, deps);
	});

	// Event-driven watcher (DESIGN.md §21): the replacement for the improvised
	// bash sleep after E_TIMEOUT. Mounted for EVERY session — deliberately NOT
	// behind ctx.hasUI: the wake-up matters headless too (rpc/print). Start is
	// idempotent (module registry, double-start replaces) and every failure is
	// advisory, so a broken watcher can never affect spawn/collect outcomes.
	// Migration stage 3 (audit step 10): the "worker or orchestrator" decision
	// and the mount live in the composer (src/compose.ts, mountSessionWatcher)
	// — index.ts only derives the (degradable) self-id and calls it. The F6
	// two-tier contract (a worker-orchestrator that owns child manifests still
	// mounts; a PURE worker stays watcher-less) is documented and tested there.
	pi.on("session_start", async (_event, ctx) => {
		let sessionFile: string | undefined;
		try {
			sessionFile = ctx.sessionManager?.getSessionFile?.();
		} catch {
			sessionFile = undefined; // degraded self-id — the gate decides with what is known
		}
		mountSessionWatcher({
			pi,
			transport,
			self: { sessionFile, cwd: ctx.cwd },
			sessionManager: ctx.sessionManager,
		});
	});

	// Session-end cleanup (quality fix A7): mountFleetUI's 2 s poll (herdr
	// `agent list` + manifest reads) must not outlive the session. disposeFleetUI
	// is the module-level registry in fleet.ts — idempotent, safe when
	// nothing is mounted. Event name verified in pi docs (extensions.md):
	// "session_shutdown" fires before teardown for quit/reload/new/resume/fork.
	pi.on("session_shutdown", async (_event, _ctx) => {
		disposeFleetUI();
		stopWatcher(); // §21: the poll timer must not outlive the session
	});
}
