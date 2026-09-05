/**
 * pi-delegate — `delegate_status` tool (DESIGN.md §5.2).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * READ-ONLY by contract: observes workers from manifests + live herdr statuses.
 * Contains no mutating calls (verified in review — DESIGN.md §8).
 */

import { stat } from "node:fs/promises";
import { Type } from "typebox";
import {
	answerPathFor,
	progressPathFor,
	questionPathFor,
	readLastProgress,
	scanAllManifests,
} from "../exchange.ts";
import { CONTEXT_TURNS_WARN } from "../transport/types.ts";
import { buildWorkerView, type WorkerView } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "../usage.ts";
import { archiveRoot, listArchivedTasks } from "../archive.ts";
import { renderDelegateLines } from "../ui/fleet-ui.ts";
import { clampLines, fmtK } from "../ui/text.ts";

/** Budget governor display data (DESIGN.md §14), read-only: name → session
 *  JSONL path and recorded effective budget from every manifest, plus the
 *  resolved default budget for workers without a recorded one. */
function usageSource(): {
	sessionPathByName: Map<string, string>;
	modelByName: Map<string, string>;
} {
	const sessionPathByName = new Map<string, string>();
	const modelByName = new Map<string, string>();
	for (const manifest of scanAllManifests()) {
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
	let qMtime = -1;
	let aMtime = -1;
	try {
		qMtime = (await stat(questionPathFor(dir, name))).mtimeMs;
	} catch {
		// no question file
	}
	try {
		aMtime = (await stat(answerPathFor(dir, name))).mtimeMs;
	} catch {
		// no answer file
	}
	return [qMtime >= 0 ? "Q?" : "", aMtime >= 0 && aMtime > qMtime ? "A→" : ""]
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
	return v.dir.endsWith("/_probe");
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

export function registerStatusTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate_status",
		label: "Delegate Status",
		description:
			"Read-only status of delegate workers: name, herdr status, placement kind, branch, report presence, elapsed. " +
			"Pass name for one worker; omit to see all known workers (from manifests + live herdr). Never mutates anything.",
		promptSnippet: "Read-only status of delegate workers (never mutates)",
		promptGuidelines: [
			"Use delegate_status to poll workers after a timed-out or detached delegate call instead of repeating delegate.",
			"When delegate_status shows a worker as blocked, read the pane via herdr and either answer the worker's question or send a re-brief.",
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
			const { sessionPathByName, modelByName } = usageSource();
			const selected = params.name
				? views.filter((v) => v.name === params.name)
				: views;

			if (selected.length === 0) {
				const hint = params.name
					? `No delegate worker named "${params.name}" (known workers: ${views.map((v) => v.name).join(", ") || "none"}).`
					: "No delegate workers known (no manifests under /tmp/exchange).";
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
						const u = parseSessionUsage(sessionPath);
						const window = resolveContextWindow(modelByName.get(v.name));
						const pct = contextPct(u, window);
						usagePart = ` ctx ${pct === null ? "?" : pct + "%"} ↑${fmtK(u.input)} ↓${fmtK(u.output)}` +
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
					`Blocked: ${blocked.map((v) => v.name).join(", ")} — read the pane via herdr, then answer or re-brief.`,
				);
			}
			// Resume hint (§19.3/§19.4): live fleet empty + non-empty archive.
			const liveCount = selected.filter((v) => v.status === "working" || v.status === "blocked").length;
			if (liveCount === 0) {
				const archiveHint = await resumeHint();
				if (archiveHint) lines.push(archiveHint);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { workers: selected },
			};
		},
	});
}
