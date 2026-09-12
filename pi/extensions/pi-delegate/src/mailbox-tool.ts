/**
 * pi-delegate — mailbox-tool: the `delegate_mailbox` tool (two-way mailbox
 * + retire-ack lifecycle) — extracted verbatim from spawn.ts (Wave 3, step 4).
 *
 * OWNERSHIP: worker B2 (impl-tools2).
 *
 * Orchestrator-facing two-way file mailbox:
 *   read   → pending q-<name>.json question(s) across known task dirs (no mutation)
 *   answer → write a-<name>.json, then nudge idle/blocked/done workers to continue
 *   steer  → same as answer, for mid-run guidance
 *   release → post release-<name>.json (the §23 retire ACK — the watcher
 *     closes the drained worker's pane)
 *
 * The mailbox is files, never panes: the worker is briefed (briefPrompt) to
 * write q-<name>.json when blocked and poll a-<name>.json for answers.
 * <p>
 * MODULE_CONTRACT: registers the `delegate_mailbox` tool (exact name, exact
 * parameter shape — frozen surface). Answer/steer post the a-file BEFORE
 * nudging THROUGH THE ONE posting core (postSteerAndNudge in mailbox-store.ts
 * — Law 9, shared with the watcher's automatic fix nudge); the
 * stale question is archived so it can never re-fire AWAITING_ANSWER; nudge
 * failures do not fail the action (the answer file is already posted) — on
 * repeated failure a watcher-visible nudge-failed-<name>.json marker is
 * written so the orchestrator's watcher delivers the wake-up instead, and a
 * SUBSEQUENT successful nudge deletes any stale marker (retire-ack consume
 * discipline).
 * Dependencies: tool-result.ts (ToolResult/fail/textResult/errText/typedCode
 * — one shared spelling, no second copy), exchange.ts + expaths.ts
 * (question archive paths), mailbox-store.ts (envelope I/O),
 * manifest-store.ts (task-dir scan), host.ts (WORKER_NAME_RE, briefPrompt,
 * DelegateErrorImpl, the Transport seam).
 * Never imports the transport implementation (dependency rule, ARCHITECTURE.md
 * Law 4 — the Transport instance is injected from index.ts).
 */

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { exchangeRoot } from "./exchange.ts";
import { questionArchivePathFor } from "./expaths.ts";
import { manifestStore } from "./manifest-store.ts";
import {
	answerPathFor,
	postSteerAndNudge,
	questionPathFor,
	readQuestion,
	releasePathFor,
	writeRelease,
} from "./mailbox-store.ts";
import type { SteerPostResult } from "./mailbox-store.ts";
import { errText, fail, textResult, type ToolResult } from "./tool-result.ts";
// Wave 4 item 2 (Law 1 truncation duty): worker-written question text is
// capped in the rendered result via pi's own truncation helpers.
import { capWorkerText } from "./text-cap.ts";
import { resolveWatchConfig } from "./watch-config.ts";
import { clampLines, renderDelegateLines } from "./fleet.ts";
import { WORKER_NAME_RE, type QuestionEnvelope, type Transport } from "./host.ts";

// SECTION 1/2 — delegate_mailbox tool (mailbox + retire ACK)
// (verbatim move of the old src/tools/mailbox.ts; its review-verified header
// comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `delegate_mailbox` tool (two-way file mailbox).
 *
 * OWNERSHIP: worker B2 (impl-tools2).
 *
 * Orchestrator-facing two-way file mailbox:
 *   read   → pending q-<name>.json question(s) across known task dirs (no mutation)
 *   answer → write a-<name>.json, then nudge idle/blocked/done workers to continue
 *   steer  → same as answer, for mid-run guidance
 *
 * The mailbox is files, never panes: the worker is briefed (briefPrompt) to
 * write q-<name>.json when blocked and poll a-<name>.json for answers.
 *
 * Dependency rule: imports transport.ts and exchange.ts only — never the
 * transport IMPLEMENTATION directly (herdr CLI lives behind
 * createHerdrTransport, bound once in index.ts).
 */

// Wave 3 decomposition (step 4): the tool-result vocabulary moved verbatim
// to src/tool-result.ts — the structural kill of the byte-identical
// errText/asDelegateError copies (audit finding 7).

/** Exchange dirs of all known task manifests (read: q-file scan surface).
 *  Migration stage 3 (audit step 9): the scan takes the active backend name
 *  from the bound transport (composition root) — no implicit global. */
function knownTaskDirs(backendName: string): string[] {
	const dirs = new Set<string>();
	for (const manifest of manifestStore.scan(backendName)) dirs.add(manifest.dir);
	return [...dirs];
}

/** Exchange dir that owns a worker, from the manifests (answer/steer target). */
function findWorkerDir(backendName: string, name: string): string | null {
	for (const manifest of manifestStore.scan(backendName)) {
		if (manifest.workers.some((w) => w.name === name)) return manifest.dir;
	}
	return null;
}

/**
 * Register the `delegate_mailbox` tool on the orchestrator's extension API.
 * <p>
 * FUNCTION_CONTRACT (tool `execute`):
 * Input:
 *   - action: "read" | "answer" | "steer"
 *   - name: worker name matching WORKER_NAME_RE ([a-z][a-z0-9_-]{0,31})
 *   - text: reply/steering text (required for answer/steer, ignored for read)
 * Output: ToolResult — human-readable text + details{ok, code, …}; E_* codes
 *   are RETURNED as failed results (never thrown)
 * Guarantees:
 *   - "read" is side-effect-free (manifest + q-file reads only)
 *   - answer/steer post a-<name>.json BEFORE nudging; the stale question is
 *     archived (renamed to q-<name>.answered-<ts>.json) so it can never
 *     re-fire AWAITING_ANSWER on a later run; nudge failures do not fail the
 *     action (the answer file is already posted)
 *   - F6 nudge resilience: the pane nudge is retried with backoff
 *     (NUDGE_ATTEMPTS total); on repeated failure a watcher-visible
 *     nudge-failed-<name>.json marker is written so the orchestrator's
 *     watcher delivers the wake-up instead, and a SUBSEQUENT successful
 *     nudge deletes any stale marker (retire-ack consume discipline)
 *   - nudge only fires for idle/blocked workers — never interrupts a
 *     working/done/unknown agent mid-turn
 * Raises (returned, not thrown):
 *   - E_NAME — invalid worker name, or name unknown to any manifest
 *   - E_BRIEF — missing/empty text for answer/steer, or answer write failed
 */
export function registerMailboxTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate_mailbox",
		label: "Delegate Mailbox",
		description:
			"Two-way file mailbox with a delegate worker. action 'read' shows pending worker " +
			"questions (q-<name>.json) without mutating anything; 'answer' posts a-<name>.json with your reply and " +
			"nudges an idle/blocked worker to continue; 'steer' posts mid-run guidance the same way; " +
			"'release' (§23) posts release-<name>.json — the retire ACK: the watcher closes the worker's pane " +
			"once it is retirable (valid report + drained mailbox + done/idle; probes immediately). " +
			"Use this when delegate returns an AWAITING_ANSWER result.",
		promptSnippet: "Read/answer a delegate worker's file mailbox (never touches the pane directly)",
		promptGuidelines: [
			"When delegate returns AWAITING_ANSWER, answer the worker's question here (action 'answer'); the worker will be nudged to continue.",
			"delegate_mailbox action 'read' is side-effect-free — use it to check for pending questions before/after a delegate run.",
		],
		parameters: Type.Object({
			action: StringEnum(["read", "answer", "steer", "release"] as const, {
				description:
					"read = show pending question(s); answer = reply to a question; steer = mid-run guidance; " +
					"release = post the §23 retire ACK (watcher closes the pane when the worker is retirable)",
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
				const questions: Array<{ q: QuestionEnvelope; dir: string }> = [];
				for (const dir of knownTaskDirs(transport.backendName())) {
					const q = readQuestion(questionPathFor(dir, params.name));
					if (q) questions.push({ q, dir });
				}
				if (questions.length === 0) {
					return textResult(
						`No pending question for worker ${params.name} in any known task dir ` +
							`(no readable q-${params.name}.json under ${exchangeRoot()}).`,
						{ action: "read", name: params.name, questions: [] },
					);
				}
				// Law 1 truncation duty (Wave 4 item 2): question body/context are
				// worker-written — cap the RENDERED text; the full envelopes stay in
				// details.questions and on disk (the notice names the q-file path).
				const lines = questions.flatMap(({ q, dir }) => {
					const fullCopyNote = `Full question: ${questionPathFor(dir, params.name)}.`;
					const bodyCap = capWorkerText(q.question, fullCopyNote);
					const contextCap = q.context ? capWorkerText(q.context, fullCopyNote) : null;
					return [
						`Pending question from ${q.worker} (${q.ts}):`,
						bodyCap.text,
						contextCap ? `Context: ${contextCap.text}` : "",
						q.options?.length ? `Options: ${q.options.join(" | ")}` : "",
						`Answer via delegate_mailbox (action 'answer', name '${params.name}').`,
						"",
					];
				});
				return textResult(lines.join("\n").trim(), {
					action: "read",
					name: params.name,
					questions: questions.map((e) => e.q),
				});
			}

			// --- answer | steer: locate the worker's task dir from the manifests -----
			const dir = findWorkerDir(transport.backendName(), params.name);
			if (!dir) {
				return fail(
					"E_NAME",
					`E_NAME — no delegate worker named "${params.name}" is known (no manifest under ${exchangeRoot()} references it). ` +
						"Check delegate_status for known workers; a worker must have been spawned via delegate first.",
					{ action: params.action, name: params.name },
				);
			}

			// --- release (§23 retire ACK): post the marker; the WATCHER consumes it.
			// No nudge is sent: release is a retirement signal, not worker mail — a
			// nudged worker would start a NEW turn on a pane that is about to close.
			// Needs no text, so it is handled BEFORE the answer/steer text guard.
			if (params.action === "release") {
				const releasePath = releasePathFor(dir, params.name);
				// §23 MASTER SWITCH: auto-teardown is opt-in (watch.retire, default
				// FALSE). While disabled a release is an HONEST NO-OP: nothing is
				// posted, and any existing marker is DELETED (best-effort) so a stale
				// release can never fire a close after the feature is enabled later.
				if (!resolveWatchConfig().retire) {
					let removedNote = "";
					try {
						await rm(releasePath, { force: true });
						removedNote = " Any existing release marker was deleted — a stale marker must not fire a close once watch.retire is enabled.";
					} catch (err) {
						removedNote = ` Stale-marker cleanup failed (${errText(err)}) — delete ${releasePath} manually or it may fire a close once watch.retire is enabled.`;
					}
					return textResult(
						`No-op: auto-teardown is disabled via watch.retire=false — no release posted for worker ${params.name}.${removedNote}`,
						{ action: "release", name: params.name, dir, releasePath, retireEnabled: false, noOp: true },
					);
				}
				try {
					await writeRelease(releasePath);
				} catch (err) {
					return fail(
						"E_BRIEF",
						`E_BRIEF — failed to write release marker at ${releasePath}: ${errText(err)}`,
						{ action: "release", name: params.name, dir, releasePath, stderr: errText(err) },
					);
				}
				return textResult(
					`Release posted for worker ${params.name} (${releasePath}) — the watcher retires it when ` +
						"retirable (valid report + drained mailbox + done/idle; probes immediately on their settled " +
						"verdict). No nudge sent: release is a retirement signal, not worker mail.",
					{ action: "release", name: params.name, dir, releasePath },
				);
			}

			// Answering/steering requires text — E_BRIEF per contract (E_NAME is for
			// bad names).
			if (!params.text || params.text.trim().length === 0) {
				return fail(
					"E_BRIEF",
					`E_BRIEF — mailbox answer text required: pass the reply/steering text for worker ${params.name} ` +
						"in the 'text' parameter.",
					{ action: params.action, name: params.name, dir },
				);
			}

			const answerPath = answerPathFor(dir, params.name);
			// EXTERNAL_DEPENDENCY: exchange dir on disk — answer file at
			// /tmp/exchange/<task>/a-<name>.json (atomic write inside mailbox-store.ts).
			// The ONE posting core (postSteerAndNudge) writes the envelope, then runs
			// the afterPost hook, then nudges the pane — posting and nudging are no
			// longer duplicated here (Law 9; shared with the watcher auto-nudge).
			let steer: SteerPostResult;
			let archiveNote = "";
			try {
				steer = await postSteerAndNudge(transport, params.name, dir, params.text, {
					// afterPost — runs AFTER the envelope is durably posted and BEFORE
					// the pane nudge.
					//
					// EXTERNAL_DEPENDENCY: fs rename inside the exchange dir
					// (/tmp/exchange/<task>/q-<name>.json → q-<name>.answered-<ts>.json).
					// Archive the question right after the answer lands: q-<name>.json
					// must not survive a successful answer, or a later run for the same
					// worker name would re-fire AWAITING_ANSWER with the stale question
					// (review fix). Best-effort: a missing q-file is normal for 'steer';
					// any other rename failure is noted but does not fail the action —
					// the answer file is already posted.
					afterPost: async () => {
						try {
							await rename(
								questionPathFor(dir, params.name),
								questionArchivePathFor(dir, params.name, Date.now()),
							);
							archiveNote = " Pending question archived.";
						} catch (err) {
							if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
								archiveNote =
									` Question archive failed (${errText(err)}) — delete q-${params.name}.json manually, otherwise a later run may re-fire AWAITING_ANSWER with the stale question.`;
							}
						}
					},
				});
			} catch (err) {
				return fail(
					"E_BRIEF",
					`E_BRIEF — failed to write mailbox answer at ${answerPath}: ${errText(err)}`,
					{ action: params.action, name: params.name, dir, answerPath, stderr: errText(err) },
				);
			}

			return textResult(
				`${params.action === "steer" ? "Steering" : "Answer"} posted to ${steer.answerPath} for worker ${params.name}.` +
					(steer.nudged ? ` Nudge prompt sent — the worker will read a-${params.name}.json and continue.` : steer.note) +
					archiveNote,
				{ action: params.action, name: params.name, dir, answerPath: steer.answerPath, nudged: steer.nudged },
			);
		},
	});
}
