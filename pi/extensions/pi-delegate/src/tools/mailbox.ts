/**
 * pi-delegate — `delegate_mailbox` tool (DESIGN.md §12).
 *
 * OWNERSHIP: worker B2 (impl-tools2).
 *
 * Orchestrator-facing two-way file mailbox:
 *   read   → pending q-<name>.json question(s) across known task dirs (no mutation)
 *   answer → write a-<name>.json, then nudge idle/blocked workers to continue
 *   steer  → same as answer, for mid-run guidance
 *
 * The mailbox is files, never panes: the worker is briefed (briefPrompt) to
 * write q-<name>.json when blocked and poll a-<name>.json for answers.
 *
 * Dependency rule: imports transport/types.ts and exchange.ts only — never
 * transport/herdr.ts directly.
 */

import { rename } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	answerPathFor,
	questionPathFor,
	readQuestion,
	scanAllManifests,
	writeAnswer,
} from "../exchange.ts";
import { WORKER_NAME_RE, type QuestionEnvelope, type Transport } from "../transport/types.ts";
import { renderDelegateLines } from "../ui/fleet-ui.ts";
import { clampLines } from "../ui/text.ts";

/** Max wait for a nudge prompt *submission* to be accepted (not for settle). */
const NUDGE_TIMEOUT_MS = 30_000;
/** Nudge text — points the worker at the answer file, per DESIGN.md §12. */
const NUDGE_TEXT = (name: string) =>
	`Mailbox update posted: read a-${name}.json next to your brief and continue accordingly.`;

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
};

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function fail(code: string, text: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: false, code, ...extra } };
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

/** Exchange dirs of all known task manifests (read: q-file scan surface). */
function knownTaskDirs(): string[] {
	const dirs = new Set<string>();
	for (const manifest of scanAllManifests()) dirs.add(manifest.dir);
	return [...dirs];
}

/** Exchange dir that owns a worker, from the manifests (answer/steer target). */
function findWorkerDir(name: string): string | null {
	for (const manifest of scanAllManifests()) {
		if (manifest.workers.some((w) => w.name === name)) return manifest.dir;
	}
	return null;
}

export function registerMailboxTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate_mailbox",
		label: "Delegate Mailbox",
		description:
			"Two-way file mailbox with a delegate worker (DESIGN.md §12). action 'read' shows pending worker " +
			"questions (q-<name>.json) without mutating anything; 'answer' posts a-<name>.json with your reply and " +
			"nudges an idle/blocked worker to continue; 'steer' posts mid-run guidance the same way. " +
			"Use this when delegate returns an AWAITING_ANSWER result.",
		promptSnippet: "Read/answer a delegate worker's file mailbox (never touches the pane directly)",
		promptGuidelines: [
			"When delegate returns AWAITING_ANSWER, answer the worker's question here (action 'answer'); the worker will be nudged to continue.",
			"action 'read' is side-effect-free — use it to check for pending questions before/after a delegate run.",
		],
		parameters: Type.Object({
			action: StringEnum(["read", "answer", "steer"] as const, {
				description: "read = show pending question(s); answer = reply to a question; steer = mid-run guidance",
			}),
			name: Type.String({ description: "Worker name; must match [a-z][a-z0-9_-]{0,31}" }),
			text: Type.Optional(
				Type.String({ description: "Answer/steering text (required for 'answer' and 'steer')" }),
			),
		}),
		renderCall(args, theme) {
			const action = typeof args?.action === "string" ? args.action : "?";
			const name = typeof args?.name === "string" ? args.name : "?";
			const head = theme.fg("toolTitle", theme.bold("delegate_mailbox "));
			return {
				render: (width?: number) => clampLines([`${head} ${theme.fg("muted", action)} ${theme.fg("accent", name)}`], width),
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate_mailbox", resultText, theme);
			return { render: (width?: number) => clampLines(lines, width), invalidate: () => {} };
		},
		async execute(_toolCallId, params) {
			if (!WORKER_NAME_RE.test(params.name)) {
				return fail(
					"E_NAME",
					`E_NAME — invalid worker name "${params.name}". ` +
						"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name from the manifest/delegate_status.",
					{ name: params.name },
				);
			}

			// --- read: side-effect-free scan of every known task dir -----------------
			if (params.action === "read") {
				const questions: QuestionEnvelope[] = [];
				for (const dir of knownTaskDirs()) {
					const q = readQuestion(questionPathFor(dir, params.name));
					if (q) questions.push(q);
				}
				if (questions.length === 0) {
					return textResult(
						`No pending question for worker ${params.name} in any known task dir ` +
							`(no readable q-${params.name}.json under /tmp/exchange).`,
						{ action: "read", name: params.name, questions: [] },
					);
				}
				const lines = questions.flatMap((q) => [
					`Pending question from ${q.worker} (${q.ts}):`,
					q.question,
					q.context ? `Context: ${q.context}` : "",
					q.options?.length ? `Options: ${q.options.join(" | ")}` : "",
					`Answer via delegate_mailbox (action 'answer', name '${params.name}').`,
					"",
				]);
				return textResult(lines.join("\n").trim(), {
					action: "read",
					name: params.name,
					questions,
				});
			}

			// --- answer | steer: locate the worker's task dir from the manifests -----
			const dir = findWorkerDir(params.name);
			if (!dir) {
				return fail(
					"E_NAME",
					`E_NAME — no delegate worker named "${params.name}" is known (no manifest under /tmp/exchange references it). ` +
						"Check delegate_status for known workers; a worker must have been spawned via delegate first.",
					{ action: params.action, name: params.name },
				);
			}

			// Answering requires text — E_BRIEF per contract (E_NAME is for bad names).
			if (!params.text || params.text.trim().length === 0) {
				return fail(
					"E_BRIEF",
					`E_BRIEF — mailbox answer text required: pass the reply/steering text for worker ${params.name} ` +
						"in the 'text' parameter.",
					{ action: params.action, name: params.name, dir },
				);
			}

			const answerPath = answerPathFor(dir, params.name);
			try {
				await writeAnswer(answerPath, params.text);
			} catch (err) {
				return fail(
					"E_BRIEF",
					`E_BRIEF — failed to write mailbox answer at ${answerPath}: ${errText(err)}`,
					{ action: params.action, name: params.name, dir, answerPath, stderr: errText(err) },
				);
			}

			// Archive the question right after the answer lands: q-<name>.json must not
			// survive a successful answer, or a later run for the same worker name would
			// re-fire AWAITING_ANSWER with the stale question (review fix). Best-effort:
			// a missing q-file is normal for 'steer'; any other rename failure is noted
			// but does not fail the action — the answer file is already posted.
			let archiveNote = "";
			try {
				await rename(
					questionPathFor(dir, params.name),
					`${dir}/q-${params.name}.answered-${Date.now()}.json`,
				);
				archiveNote = " Pending question archived.";
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
					archiveNote =
						` Question archive failed (${errText(err)}) — delete q-${params.name}.json manually, otherwise a later run may re-fire AWAITING_ANSWER with the stale question.`;
				}
			}

			// Nudge only idle/blocked workers — a working/done/unknown agent must not
			// be interrupted mid-turn (or re-prompted after finishing).
			let nudged = false;
			let nudgeNote = "";
			try {
				const status = (await transport.getStatus(params.name))?.status ?? "unknown";
				if (status === "idle" || status === "blocked") {
					await transport.submitPrompt({
						name: params.name,
						text: NUDGE_TEXT(params.name),
						timeoutMs: NUDGE_TIMEOUT_MS,
					});
					nudged = true;
				} else {
					nudgeNote =
						` Worker status is ${status} — no nudge sent; the worker polls a-${params.name}.json per its brief.`;
				}
			} catch (err) {
				nudgeNote =
					` Nudge prompt failed (${errText(err)}) — the answer file IS posted; check the pane via delegate_status and nudge manually if needed.`;
			}

			return textResult(
				`${params.action === "steer" ? "Steering" : "Answer"} posted to ${answerPath} for worker ${params.name}.` +
					(nudged ? ` Nudge prompt sent — the worker will read a-${params.name}.json and continue.` : nudgeNote) +
					archiveNote,
				{ action: params.action, name: params.name, dir, answerPath, nudged },
			);
		},
	});
}
