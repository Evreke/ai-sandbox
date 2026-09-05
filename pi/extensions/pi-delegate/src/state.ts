/**
 * pi-delegate — worker view aggregation (DESIGN.md §5.2).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * Read-only module: merges durable on-disk manifests (exchange.ts) with live
 * herdr agent statuses (via the Transport seam). Contains NO mutating calls —
 * this is the data source for `delegate_status` and `/delegate-teardown`.
 */

import { stat } from "node:fs/promises";
import { scanAllManifests } from "./exchange.ts";
import type { AgentStatusName, Placement, Transport } from "./transport/types.ts";

/** One known worker, as seen by the orchestrator. */
export interface WorkerView {
	/** Canonical (herdr-confirmed) worker name. */
	name: string;
	/** Exchange dir (manifest source) this worker belongs to. */
	dir: string;
	/** Live status when herdr knows the agent, otherwise "unknown". */
	status: AgentStatusName;
	/** Full placement record from the manifest (teardown source of truth). */
	placement: Placement;
	/** Convenience projections of `placement`. */
	kind: Placement["kind"];
	branch?: string;
	workspaceId?: string;
	paneId?: string;
	/** Conventional report path for this worker. */
	reportPath: string;
	/** True when the report file currently exists on disk. */
	reportExists: boolean;
	/** ISO 8601 start time from the manifest. */
	startedAt: string;
	/** Ms since startedAt (0 when unparseable). */
	elapsedMs: number;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Aggregate all known workers: every manifest under /tmp/exchange merged with
 * a live `listStatuses()` snapshot. Never throws for herdr being unreachable —
 * statuses degrade to "unknown" instead.
 */
export async function buildWorkerView(transport: Transport): Promise<WorkerView[]> {
	const manifests = scanAllManifests();

	let statuses: Awaited<ReturnType<Transport["listStatuses"]>> = [];
	try {
		statuses = await transport.listStatuses();
	} catch {
		statuses = []; // herdr unreachable — fall back to manifest data only
	}
	const liveByName = new Map(statuses.map((s) => [s.name, s]));

	const views: WorkerView[] = [];
	const seen = new Set<string>();
	for (const manifest of manifests) {
		for (const worker of manifest.workers) {
			const key = `${manifest.dir}#${worker.name}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const live = liveByName.get(worker.name);
			const startedMs = Date.parse(worker.startedAt);
			views.push({
				name: worker.name,
				dir: manifest.dir,
				status: live?.status ?? "unknown",
				placement: worker.placement,
				kind: worker.placement.kind,
				branch: worker.placement.branch,
				workspaceId: worker.placement.workspaceId,
				paneId: worker.placement.paneId,
				reportPath: worker.reportPath,
				reportExists: await fileExists(worker.reportPath),
				startedAt: worker.startedAt,
				elapsedMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
			});
		}
	}
	return views;
}
