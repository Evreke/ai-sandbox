/**
 * pi-delegate — status-tool: the `delegate_status` tool (DESIGN.md §5.2) —
 * extracted verbatim from observe.ts (Wave 3, audit Law 5: modules are
 * responsibilities).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * READ-ONLY by contract: observes workers from manifests + live herdr statuses.
 * Contains no mutating calls (verified in review — DESIGN.md §8).
 * <p>
 * MODULE_CONTRACT: registers the `delegate_status` tool (exact name, exact
 * parameter shape) plus its read-only render helpers — the fleet-usage line
 * (F1, from aggregateTaskUsage WITHOUT persist), the mailbox/progress
 * markers, the resume hint, the dual usage gauge.
 * Dependencies: fleet.ts (buildWorkerView + render helpers), exchange.ts
 * (aggregateTaskUsage, exchangeRoot, progress reads), archive.ts (resume
 * hint), manifest-store.ts, mailbox-store.ts (marker mtimes), usage.ts (the
 * ONLY session-JSONL parser — one-parser law), host.ts (the Transport seam),
 * typebox. Never imports the transport implementation (dependency rule,
 * DESIGN.md §4.1 — the Transport instance is injected from index.ts).
 * Critical invariants (moved verbatim from observe.ts):
 *   - F1 fleet usage: the aggregate line comes from aggregateTaskUsage
 *     WITHOUT persist — delegate_status stays read-only by contract; missing/
 *     corrupt session files degrade to a partial marker on the line, never an
 *     error.
 *   - probe honesty (§19.4): a probe run renders `report —`, never `report✗`.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "typebox";
import { aggregateTaskUsage, exchangeRoot, isProbeDir, progressPathFor, readLastProgress } from "./exchange.ts";
import { archiveRoot, listArchivedTasks } from "./archive.ts";
import { type TaskUsageSnapshot, manifestStore } from "./manifest-store.ts";
import { mailboxAnswerState } from "./mailbox-store.ts";
import { clampLines, renderDelegateLines, type WorkerView } from "./fleet.ts";
import {
	contextPct,
	formatTokens,
	parseSessionUsage,
	resolveContextWindow,
} from "./usage.ts";
import { buildWorkerView } from "./fleet.ts";
import { CONTEXT_TURNS_WARN, type Transport } from "./host.ts";

// ===========================================================================
// SECTION 1/3 — `delegate_status` tool
// (verbatim move of the old src/tools/status.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `delegate_status` tool (DESIGN.md §5.2).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * READ-ONLY by contract: observes workers from manifests + live herdr statuses.
 * Contains no mutating calls (verified in review — DESIGN.md §8).
 */

/** Budget governor display data (DESIGN.md §14), read-only: name → session
 *  JSONL path and recorded effective budget from every manifest, plus the
 *  resolved default budget for workers without a recorded one. Migration
 *  stage 3 (audit step 9): the scan takes the active backend name from the
 *  bound transport (composition root) — no implicit global. */
function usageSource(transport: Transport): {
	sessionPathByName: Map<string, string>;
	modelByName: Map<string, string>;
} {
	const sessionPathByName = new Map<string, string>();
	const modelByName = new Map<string, string>();
	for (const manifest of manifestStore.scan(transport.backendName())) {
		for (const w of manifest.workers) {
			if (w.sessionPath) sessionPathByName.set(w.name, w.sessionPath);
			if (typeof w.model === "string") modelByName.set(w.name, w.model);
		}
	}
	return { sessionPathByName, modelByName };
}

function formatElapsed(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	if (m === 0) return `${s}s`;
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** v1.2 mailbox markers (DESIGN.md §12), read-only: q-file exists → "Q?";
 *  a-file exists and is newer than the question → "A→" (answered/steered). */
async function mailboxMarkers(dir: string, name: string): Promise<string> {
	// EXTERNAL_DEPENDENCY: mailbox files at /tmp/exchange/<task>/q-<name>.json
	// and a-<name>.json — existence + mtime ordering only, contents never read
	// (via the ONE shared reader, mailbox-store.mailboxAnswerState).
	const { questionPosted, answerNewerThanQuestion } = await mailboxAnswerState(dir, name);
	return [questionPosted ? "Q?" : "", answerNewerThanQuestion ? "A→" : ""]
		.filter(Boolean)
		.join(" ");
}

/** v1.5 progress ping display (DESIGN.md §18), read-only: last valid ping in
 *  p-<name>.jsonl → " p:<phase>[ <pct>%] (<age>s)"; absent/unreadable → "".
 *  Advisory: never throws past the tool (read failures swallowed). */
async function pingMarker(dir: string, name: string): Promise<string> {
	try {
		const ping = readLastProgress(progressPathFor(dir, name));
		if (!ping) return "";
		const pctPart = typeof ping.pct === "number" ? ` ${ping.pct}%` : "";
		const tsMs = Date.parse(ping.ts);
		const ageS = Number.isNaN(tsMs) ? "?" : String(Math.max(0, Math.round((Date.now() - tsMs) / 1000)));
		return ` p:${ping.phase}${pctPart} (${ageS}s)`;
	} catch {
		return ""; // advisory only — absent → nothing (backward compatible)
	}
}

/** Probe runs place under /tmp/exchange/_probe — no report is expected there,
 *  so a missing report must render `report —`, never `report✗` (DESIGN.md
 *  §19.4 probe honesty). */
function isProbeView(v: WorkerView): boolean {
	return isProbeDir(v.dir);
}

/**
 * F1 fleet-usage line for delegate_status (the chosen surface — smallest one
 * that makes the aggregate visible; the fleet overlay already shows per-
 * worker gauges). One line per task, e.g.
 *   fleet my-task "fix the login race": ↓12.4k out · cache 890k · sent 1.2m · 3 workers
 * with a partial marker appended when some workers could not be counted.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - task: task slug (exchange dir basename) — the fleet label
 *   - snap: aggregateTaskUsage's snapshot (recomputed from session files)
 *   - description: optional manifest task description (quoted when present)
 * Output: one-line human string; token counts via usage.ts formatTokens
 * Guarantees: pure formatting, no I/O; partial list appended when non-empty
 * Raises: none
 */
export function formatFleetUsageLine(task: string, snap: TaskUsageSnapshot, description?: string): string {
	const desc = description ? ` "${description}"` : "";
	const partial = snap.partial.length > 0 ? ` · partial: ${snap.partial.join(", ")}` : "";
	return (
		`fleet ${task}${desc}: ↓${formatTokens(snap.outputTokens)} out` +
		` · cache ${formatTokens(snap.cacheReadTokens)}` +
		` · sent ${formatTokens(snap.sentTokens)}` +
		` · ${snap.workers} workers${partial}`
	);
}

/** Resume hint (DESIGN.md §19.3/§19.4): live fleet empty + non-empty archive
 *  → point at the last archived tasks. Advisory: read failures swallowed. */
async function resumeHint(): Promise<string> {
	try {
		const tasks = listArchivedTasks();
		if (tasks.length === 0) return "";
		return `last archived task(s): ${tasks.slice(-3).join(", ")} — archive at ${archiveRoot()}`;
	} catch {
		return "";
	}
}

/**
 * Register the `delegate_status` tool on the orchestrator's extension API.
 * <p>
 * FUNCTION_CONTRACT (tool `execute`):
 * Input:
 *   - name (optional): worker name; omitted → every worker in every manifest
 * Output: ToolResult — one formatted status line per worker (+ blocked list,
 *   resume hint when the live fleet is empty) and details.workers = WorkerView[]
 * Guarantees:
 *   - READ-ONLY: manifest reads, fs existence/mtime stats, progress/session
 *     JSONL parses — no mutating herdr or fs call anywhere
 *   - unknown worker name → "No delegate worker named …" + known-worker list,
 *     never a throw
 *   - probe honesty (§19.4): a probe run renders `report —`, never `report✗`
 * Raises: none (read failures are swallowed by the tolerant helpers)
 */
export function registerStatusTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate_status",
		label: "Delegate Status",
		description:
			"Read-only status of delegate workers: name, live status, placement kind, branch, report presence, elapsed. " +
			"Pass name for one worker; omit to see all known workers (from manifests + the live host). Never mutates anything.",
		promptSnippet: "Read-only status of delegate workers (never mutates)",
		promptGuidelines: [
			"Use delegate_status to check a specific worker after a timed-out or detached delegate call instead of repeating delegate — but do NOT poll it in a loop: the background watcher (DESIGN.md §21) wakes you on report-ready / mailbox-question / grill-deck / context-critical / worker-dead.",
			"When delegate_status shows a worker as blocked, read the worker's pane and either answer the worker's question or send a re-brief.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Worker name; omit for all known workers" })),
		}),
		renderCall(args, theme) {
			const name = typeof args?.name === "string" ? args.name : "(all)";
			const head = theme.fg("toolTitle", theme.bold("delegate_status "));
			return {
				render: (width?: number) => clampLines([`${head} ${theme.fg("accent", name)}`], width),
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate_status", resultText, theme);
			return { render: (width?: number) => clampLines(lines, width), invalidate: () => {} };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const views = await buildWorkerView(transport);
			const { sessionPathByName, modelByName } = usageSource(transport);
			const selected = params.name
				? views.filter((v) => v.name === params.name)
				: views;

			if (selected.length === 0) {
				const hint = params.name
					? `No delegate worker named "${params.name}" (known workers: ${views.map((v) => v.name).join(", ") || "none"}).`
					: `No delegate workers known (no manifests under ${exchangeRoot()}).`;
				const archiveHint = await resumeHint();
				return {
					content: [{ type: "text", text: archiveHint ? `${hint}\n${archiveHint}` : hint }],
					details: { workers: [] },
				};
			}

			const lines = await Promise.all(
				selected.map(async (v: WorkerView) => {
					const mailbox = await mailboxMarkers(v.dir, v.name);
					const mailboxPart = mailbox ? ` ${mailbox}` : "";
					// v1.5 (DESIGN.md §18): last progress ping when present, e.g.
					// " p:implementing 40% (12s)"; absent → nothing (backward compatible).
					const pingPart = await pingMarker(v.dir, v.name);
					// Dual gauge (DESIGN.md §20): parse the recorded session JSONL when the
					// manifest holds a session path → "ctx P% ↑Xk ↓Yk" — context % primary
					// (pi's own formula), tokens display-only. Tolerant; no path → no column.
					const sessionPath = sessionPathByName.get(v.name);
					let usagePart = "";
					if (sessionPath) {
						// EXTERNAL_DEPENDENCY (via usage.ts): the worker's session JSONL on
						// disk (manifest `sessionPath`) is read synchronously for the gauge.
						const u = parseSessionUsage(sessionPath);
						const window = resolveContextWindow(modelByName.get(v.name));
						const pct = contextPct(u, window);
						usagePart = ` ctx ${pct === null ? "?" : pct + "%"} ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}` +
							(u.turns > CONTEXT_TURNS_WARN ? ` (${u.turns} turns!)` : "");
					}
					// Probe honesty (§19.4): probes never render report✗.
					const reportPart = v.reportExists
						? "report✓"
						: isProbeView(v)
							? "report —"
							: "report✗";
					return `${v.name} ${v.status} ${v.kind} ${v.branch ?? "-"} ${reportPart}${mailboxPart}${pingPart}${usagePart} ${formatElapsed(v.elapsedMs)}`;
				}),
			);
			const blocked = selected.filter((v) => v.status === "blocked");
			if (blocked.length > 0) {
				lines.push(
					`Blocked: ${blocked.map((v) => v.name).join(", ")} — read the pane, then answer or re-brief.`,
				);
			}
			// Resume hint (§19.3/§19.4): live fleet empty + non-empty archive.
			const liveCount = selected.filter((v) => v.status === "working" || v.status === "blocked").length;
			if (liveCount === 0) {
				const archiveHint = await resumeHint();
				if (archiveHint) lines.push(archiveHint);
			}
			// F1 fleet usage accounting: one aggregate line per task dir of the
			// selected workers — description, master-orchestrator link and the
			// recomputed token/cache/sent roll-up. aggregateTaskUsage is called
			// WITHOUT persist (read-only tool contract); missing/corrupt session
			// files degrade to a partial marker on the line, never an error.
			const fleetDirs = [...new Set(selected.map((v) => v.dir))];
			for (const dir of fleetDirs) {
				const snap = aggregateTaskUsage(dir);
				if (!snap) continue; // no readable manifest → no fleet line
				lines.push(formatFleetUsageLine(basename(dir), snap, manifestStore.read(dir)?.description));
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { workers: selected },
			};
		},
	});
}
