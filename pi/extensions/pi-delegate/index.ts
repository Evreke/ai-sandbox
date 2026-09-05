/**
 * pi-delegate — extension entry point.
 *
 * Installs the transport once and registers the delegate tool layer on it.
 * Also mounts the ambient fleet UI (DESIGN.md §19.4) on session_start —
 * guarded by ctx.hasUI so headless runs stay inert.
 *
 * Install (local-only repo, symlinked into pi's auto-discovery dir):
 *   ln -s /root/projects/pi-delegate ~/.pi/agent/extensions/pi-delegate
 *
 * See DESIGN.md for the architecture and the dependency rule: tools/ and
 * commands.ts never import transport/herdr.ts — the transport is injected here.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { progressPathFor, readLastProgress } from "./src/exchange.ts";
import { buildWorkerView } from "./src/state.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "./src/usage.ts";
import { mountFleetUI, disposeFleetUI, type FleetRow, type FleetUIDeps } from "./src/ui/fleet-ui.ts";
import { registerCommands } from "./src/commands.ts";
import { createHerdrTransport } from "./src/transport/herdr.ts";
import { registerDelegateTool } from "./src/tools/delegate.ts";
import { registerMailboxTool } from "./src/tools/mailbox.ts";
import { registerStatusTool } from "./src/tools/status.ts";

/** Per-worker manifest extras not projected onto WorkerView (session JSONL
 *  path + recorded effective budget) — read tolerantly, same shape ui/fleet.ts
 *  uses for its overlay rows. */
interface ManifestExtras {
	sessionPath?: string;
	budgetTokens?: number;
	model?: string;
}

async function readManifestExtras(dir: string, name: string): Promise<ManifestExtras> {
	interface RawManifestWorker {
		name?: unknown;
		sessionPath?: unknown;
		budgetTokens?: unknown;
		model?: unknown;
	}
	try {
		const raw: unknown = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
		const workers = (raw as { workers?: unknown })?.workers;
		if (!Array.isArray(workers)) return {};
		const w = workers.find(
			(x): x is RawManifestWorker =>
				typeof x === "object" && x !== null && (x as RawManifestWorker).name === name,
		);
		if (!w) return {};
		const extras: ManifestExtras = {};
		if (typeof w.sessionPath === "string" && w.sessionPath.length > 0) extras.sessionPath = w.sessionPath;
		if (typeof w.budgetTokens === "number" && Number.isFinite(w.budgetTokens) && w.budgetTokens > 0) {
			extras.budgetTokens = w.budgetTokens;
		}
		return extras;
	} catch {
		return {}; // missing/corrupt manifest → zero-usage row, never throw
	}
}

export default function (pi: ExtensionAPI) {
	const transport = createHerdrTransport();
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

		let placedCount = 0;
		const deps: FleetUIDeps = {
			async getRows(): Promise<FleetRow[]> {
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
						isProbe: v.dir.endsWith("/_probe"),
						inputTokens: usage.input,
						outputTokens: usage.output,
						budgetPct: contextPct(usage, window),
						lastPing,
					};
					}),
				);
			},
		};
		mountFleetUI(ctx, deps);
	});

	// Session-end cleanup (quality fix A7): mountFleetUI's 2 s poll (herdr
	// `agent list` + manifest reads) must not outlive the session. disposeFleetUI
	// is the module-level registry in ui/fleet-ui.ts — idempotent, safe when
	// nothing is mounted. Event name verified in pi docs (extensions.md):
	// "session_shutdown" fires before teardown for quit/reload/new/resume/fork.
	pi.on("session_shutdown", async (_event, _ctx) => {
		disposeFleetUI();
	});
}
