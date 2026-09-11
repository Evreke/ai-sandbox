/**
 * pi-delegate — spawn module: everything the orchestrator DOES (DESIGN.md §5.1
 * `delegate` tool, §12 `delegate_mailbox` tool, §16–§18 schema/budget/prompt
 * pipeline, §19 settle/collect, §22 collect-time teardown, §23 release ACK).
 * <p>
 * MODULE_CONTRACT: orchestrator-side pipeline — worker-name validation, tier/
 * provider/model resolution, dual-gauge budget governor (E_CONTEXT/E_BUDGET),
 * brief reportSchema resolution, the spawn flow (place → manifest append →
 * startAgent → brief/probe prompt → waitSettle → grace rechecks → strict
 * collect + archive + collectedAt stamp + advisory auto-teardown), the
 * mailbox tool actions (read/answer/steer/release) and the LLM-facing
 * promptGuidelines contract text. Migration stage 2 (audit step 7): the
 * execute pipeline's settle→collect seam is an explicit state machine
 * (runGraceLoop/graceTransition — each transition takes the state and
 * returns the next) driven by the INJECTABLE clock/delay port (ClockPort,
 * systemClock, createVirtualClock) — the grace recheck loop is testable on
 * virtual clocks (test/grace-loop-check.ts); the execute closure keeps its
 * shape and delegates the seam to the machine. Migration stage 3 (audit step
 * 8): the settle completion criterion is the canonical report file observed
 * against THIS embodiment's witness (lifecycle.ts ReportWitness — content-
 * addressed, never file-mtime/wall-clock), and the settle outcome is the
 * seam's discriminated union (host.ts SettleResult "kind" variants) — the
 * backend status is an advisory sensor, never the criterion. W4 refactor:
 * verbatim concatenation of the
 * old src/tools/mailbox.ts (leaf, first) and src/tools/delegate.ts. The
 * ~1140-line execute() closure is kept AS-IS by design (user decision): its
 * closure-scoped mutables (sessionPath, manifestWarning, reportPath,
 * tierWarning, questionDetected, lastBeat, settleAbort) ARE the shared phase
 * state — no splitting into phase files, no ctx object; only zero-closure-
 * state pure helpers may ever be extracted.
 * Dependencies: ./host.ts (the Transport seam + E_* taxonomy + briefPrompt),
 * exchange.ts (manifest/report/mailbox lifecycle + archive), usage.ts
 * (session-JSONL gauges), observe.ts (watch/collect config resolution),
 * fleet.ts (render helpers + idle nudge). Never imports the transport
 * implementation (dependency rule, DESIGN.md §4.1 — the Transport instance is
 * injected from index.ts). Import graph: spawn is the root consumer —
 * transport/exchange/fleet/observe are all imported BY this module and none
 * of them import it (DAG holds, no module-eval cycles).
 * Exported surface: registerDelegateTool | registerMailboxTool (exact union
 * of the two source files' exports).
 * Critical invariants (owned here, per report-ref-map.json hiddenInvariants):
 *   - append-before-start (EXECUTION side; exchange.ts owns the file
 *     conventions via the manifest store): the ManifestWorker entry is appended
 *     after place() and BEFORE startAgent; a refused start rolls back ONLY
 *     the entry THIS call appended (match name + this paneId + no
 *     sessionPath) — never a pre-existing same-name worker.
 *   - answer-consumed-mtime (producer side): the mailbox tool writes
 *     a-<name>.json and archives the question file immediately after a
 *     successful answer (a stale q-<name>.json would re-fire
 *     AWAITING_ANSWER on a later same-name run); an answer counts as consumed
 *     iff the worker's report mtime postdates the answer file — consumer
 *     side: observe.ts mailboxDrained.
 *   - abort-detaches-never-kills (flow side): the abort signal cancels the
 *     WAIT, never the worker; from the moment the manifest entry exists,
 *     abort means DETACH — salvaging an already-valid report or probe
 *     verdict first. The wait-side contract lives in transport.waitSettle.
 *   - collectedAt-dedup (write side): after a VALID strict collect,
 *     collectedAt is stamped in the manifest — the watcher `seen` dedup is
 *     session memory only (observe.ts), so a fresh session would re-wake on
 *     old reports without the stamp. Migration stage 2: the stamp is a
 *     lifecycle REDUCER transition (lifecycle.stampCollected), scoped by
 *     embodiment placement ref — a same-name retry never re-stamps its
 *     predecessor's entry.
 *   - no-direct-herdr-for-reportless-verdicts (probe flow): probes NEVER
 *     write a report file — pane readback "OUTPUT: OK" is the final smoke
 *     verdict; probe salvage recovers it across aborts.
 *   - fleet-accounting-set-once (F1, EXECUTION side; exchange.ts owns the
 *     merge rule): the FIRST delegate call of a task fixes the task-level
 *     `description` (describeFleet over this call's brief) and
 *     `masterSessionPath` (this call's orchestratorSessionPath) via
 *     applyFleetTaskFields — later spawns never overwrite them. Collect is
 *     also the usage-cache WRITER (persistTaskUsageSnapshot); read paths
 *     never write.
 *   - advisory-by-contract (spawn side): manifest warnings, fleet journal,
 *     archive, fleet-idle nudges, progress pings and collect-time teardown
 *     never alter a collect verdict or a spawn outcome.
 * External runtime dependencies (ZCS, ported from the bundle's delegate-tool
 * contract): the injected Transport (herdr subprocess layer — never imported
 * directly); ~/.pi/agent/pi-delegate.config.json (tier table, defaults,
 * watch settle gate/releaseOn — via usage.ts/observe.ts resolvers);
 * <cwd>/.pi/delegate-schemas/ + ~/.pi/agent/pi-delegate-schemas/ (report-
 * schema library); the exchange dir on disk (manifest.json, briefs,
 * report-<name>.json, q-/a-<name>.json, p-<name>.jsonl, teardown.log); the
 * worker's pi session JSONL (gauges, budget, probe/aged-finish proof);
 * ctx.sessionManager.getSessionFile() (orchestrator session identity).
 * Error modes: never throws past the tool boundary — every failure is a
 * structured result with an E_* code from transport.ts's taxonomy
 * (E_NAME/E_BRIEF/E_TIER/E_PLACE/E_START/E_PROMPT_STALLED/E_TIMEOUT/
 * E_REPORT_MISSING/E_REPORT_INVALID/E_CONTEXT/E_BUDGET).
 * Shared file-local helpers defined identically by both source files
 * (ToolResult, errText, fail, textResult) are kept once — in section 1
 * (mailbox); the delegate section's byte-identical duplicates were dropped
 * (declared mechanical dedupe, see report-w4-spawn.json).
 */

// Consolidated import block (W4 merge): the two source files' per-file
// imports hoisted, deduped and retargeted at the W1–W3 real modules —
// archiveReport now lives in ./exchange.ts, watch/collect config in
// ./observe.ts, ui render helpers in ./fleet.ts, the transport surface in
// ./transport.ts (facades remain at the old paths until W5).
import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import {
	aggregateTaskUsage,
	answerPathFor,
	applyFleetTaskFields,
	archiveReport,
	describeFleet,
	ensureExchangeDir,
	exchangeRoot,
	isProbeDir,
	persistTaskUsageSnapshot,
	progressPathFor,
	questionPathFor,
	readLastProgress,
	manifestStore,
	readQuestion,
	releasePathFor,
	reportPathFor,
	resolveReportSchema,
	TEARDOWN_LOG_NAME,
	teardownLogLine,
	validateReport,
	validateReportAgainstSchema,
	writeAnswer,
	writeRelease,
	type ManifestWorker,
} from "./exchange.ts";
import {
	contextPct,
	formatBudgetLine,
	formatGaugeLine,
	overContext,
	overOutputBudget,
	parseSessionUsage,
	resolveContextWindow,
	resolvePiSessionCandidates,
	resolveSpawnDefaults,
	resolveTierTable,
} from "./usage.ts";
import { resolveCollectConfig, resolveWatchConfig } from "./observe.ts";
import {
	type ReportWitness,
	witnessEmbodimentReport,
	nextEmbodiment,
	reportWitnessProvesRun,
	stampCollected,
} from "./lifecycle.ts";
import { nudgeFailedPathFor } from "./exchange.ts";
import { probeDirPathFor, questionArchivePathFor } from "./expaths.ts";
import { clampLines, notifyFleetIdle, renderDelegateLines } from "./fleet.ts";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_TURNS_WARN,
	CONTEXT_WARN_PCT,
	DEFAULT_BUDGET_TOKENS,
	WORKER_NAME_RE,
	briefPrompt,
	DelegateErrorImpl,
	type AgentStatusName,
	type DelegateError,
	type DelegateErrorCode,
	type Placement,
	type PlacementMode,
	type ProgressEvent,
	type QuestionEnvelope,
	type SessionUsage,
	type SpawnTier,
	type Transport,
	type WorkerReport,
} from "./host.ts";

// ===========================================================================
// SECTION 1/2 — delegate_mailbox tool (DESIGN.md §12, §23)
// (verbatim move of the old src/tools/mailbox.ts; its review-verified header
// comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `delegate_mailbox` tool (DESIGN.md §12).
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

/** Max wait for a nudge prompt *submission* to be accepted (not for settle). */
const NUDGE_TIMEOUT_MS = 30_000;
/** F6 nudge resilience: total submitPrompt attempts (1 initial + 2 retries) and
 *  the backoff between them. Bounded by design — worst case ~3×NUDGE_TIMEOUT_MS
 *  + 2 delays, and each attempt stays under the NUDGE_TIMEOUT_MS cap. A
 *  transient `herdr socket: connection_closed` must not leave the worker asleep
 *  on the first failure (2026-09-10 field report). */
const NUDGE_ATTEMPTS = 3;
const NUDGE_RETRY_DELAY_MS = 500;
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

function fail(code: DelegateErrorCode, text: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: false, code, ...extra } };
}

/**
 * Migration stage 1 (audit, errors-defect 1): the ERROR CODE is the error's
 * OWN property — an intercept reads the typed code off a DelegateErrorImpl
 * the adapter raised and substitutes the positional (call-site) code ONLY
 * when the failure carried none (plain Error). Before this, the start catch
 * re-flattened the adapter's distinct E_NAME back into E_START, so the
 * adapter's differentiation never reached the tool result.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: err — anything caught around a transport call; fallback — the
 *   call-site positional code
 * Output: err.code when err is a typed DelegateErrorImpl, else fallback
 * Guarantees: pure; never throws; no message-text parsing (the code is read
 *   from the typed field, never matched out of the message)
 * Raises: never
 */
function typedCode(err: unknown, fallback: DelegateErrorCode): DelegateErrorCode {
	return err instanceof DelegateErrorImpl ? err.code : fallback;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

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
			"Two-way file mailbox with a delegate worker (DESIGN.md §12). action 'read' shows pending worker " +
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
				const questions: QuestionEnvelope[] = [];
				for (const dir of knownTaskDirs(transport.backendName())) {
					const q = readQuestion(questionPathFor(dir, params.name));
					if (q) questions.push(q);
				}
				if (questions.length === 0) {
					return textResult(
						`No pending question for worker ${params.name} in any known task dir ` +
							`(no readable q-${params.name}.json under ${exchangeRoot()}).`,
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
			try {
				// EXTERNAL_DEPENDENCY: exchange dir on disk — answer file at
				// /tmp/exchange/<task>/a-<name>.json (atomic write inside exchange.ts).
				await writeAnswer(answerPath, params.text);
			} catch (err) {
				return fail(
					"E_BRIEF",
					`E_BRIEF — failed to write mailbox answer at ${answerPath}: ${errText(err)}`,
					{ action: params.action, name: params.name, dir, answerPath, stderr: errText(err) },
				);
			}

			// EXTERNAL_DEPENDENCY: fs rename inside the exchange dir
			// (/tmp/exchange/<task>/q-<name>.json → q-<name>.answered-<ts>.json).
			// Archive the question right after the answer lands: q-<name>.json must not
			// survive a successful answer, or a later run for the same worker name would
			// re-fire AWAITING_ANSWER with the stale question (review fix). Best-effort:
			// a missing q-file is normal for 'steer'; any other rename failure is noted
			// but does not fail the action — the answer file is already posted.
			let archiveNote = "";
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

			// Nudge idle/blocked/done workers — a working agent must not be
			// interrupted mid-turn. A done agent IS woken: submitPrompt starts a new
			// turn on the existing pane and that turn reads the answer file (§12
			// promises a nudge for answer/steer with no status restriction). Unknown
			// status → honest warning instead of a silent success.
			//
			// F6 nudge resilience: submitPrompt is retried with a short backoff
			// (NUDGE_ATTEMPTS total, each attempt under NUDGE_TIMEOUT_MS) — a
			// transient `connection_closed` from the herdr socket must not leave the
			// worker asleep on the first failure. On REPEATED failure a watcher-
			// visible marker (nudge-failed-<name>.json) is written into the worker's
			// exchange dir, so the orchestrator's watcher delivers the wake-up on the
			// next tick instead of the socket; on a SUBSEQUENT successful nudge any
			// stale marker is deleted (the §23 retire-ack consume discipline — a
			// leftover marker must not fire for a fresh same-name retry).
			let nudged = false;
			let nudgeNote = "";
			try {
				const status = (await transport.getStatus(params.name))?.status ?? "unknown";
				if (status === "idle" || status === "blocked" || status === "done") {
					// EXTERNAL_DEPENDENCY: herdr pane IPC via the injected transport
					// (submitPrompt types into the worker's live pane; 30 s accept cap).
					let lastErr: unknown = null;
					for (let attempt = 1; attempt <= NUDGE_ATTEMPTS; attempt++) {
						try {
							await transport.submitPrompt({
								name: params.name,
								text: NUDGE_TEXT(params.name),
								timeoutMs: NUDGE_TIMEOUT_MS,
							});
							nudged = true;
							break;
						} catch (err) {
							lastErr = err;
							if (attempt < NUDGE_ATTEMPTS) await sleep(NUDGE_RETRY_DELAY_MS);
						}
					}
					if (nudged) {
						// Consume any stale nudge-failed marker (advisory, best-effort —
						// mirrors the release-ACK consume in observe.ts retirePass).
						try {
							await rm(nudgeFailedPathFor(dir, params.name), { force: true });
						} catch {
							// marker cleanup is advisory — the next successful nudge retries
							// and the marker's own ts fingerprint keeps old events deduped
						}
						if (status === "done") {
							nudgeNote = " Worker had finished (status done) — re-prompted; the new turn reads a-" + params.name + ".json.";
						}
					} else {
						const markerPath = nudgeFailedPathFor(dir, params.name);
						const ts = new Date().toISOString();
						try {
							// Best-effort plain write (not atomic): the watcher's marker
							// reader is tolerant — a torn read degrades to "no marker" and
							// this handler re-writes it on the next failed answer/steer.
							await writeFile(
								markerPath,
								`${JSON.stringify({ name: params.name, ts, error: errText(lastErr) }, null, "\t")}\n`,
							);
							nudgeNote =
								` Nudge prompt failed after ${NUDGE_ATTEMPTS} attempts (${errText(lastErr)}) — the answer IS posted at a-${params.name}.json ` +
								`and a nudge-failed marker was written (${markerPath}): the watcher delivers the wake-up on its next tick. ` +
								"If it does not, re-prompt the pane manually or retry the steer.";
						} catch (markerErr) {
							nudgeNote =
								` Nudge prompt failed after ${NUDGE_ATTEMPTS} attempts (${errText(lastErr)}) — the answer file IS posted ` +
								`(marker write also failed: ${errText(markerErr)}); check the pane via delegate_status and nudge manually if needed.`;
						}
					}
				} else if (status === "unknown") {
					nudgeNote =
						` Worker status is unknown — the answer IS posted but may never be read; verify the pane via delegate_status and nudge or re-spawn the worker manually if it does not pick the mail up.`;
				} else {
					nudgeNote =
						` Worker status is ${status} — no nudge sent to avoid interrupting the running turn; the worker reads a-${params.name}.json between steps when its brief says steering is expected.`;
				}
			} catch (err) {
				nudgeNote =
					` Nudge prompt failed (${errText(err)}) — the answer file IS posted; check the pane via delegate_status and nudge manually if needed.`;
			}
			// The getStatus/submitPrompt block above never throws on its own paths —
			// this outer catch covers unexpected shape changes; retry/marker logic
			// lives INSIDE the idle/blocked/done branch (F6).

			return textResult(
				`${params.action === "steer" ? "Steering" : "Answer"} posted to ${answerPath} for worker ${params.name}.` +
					(nudged ? ` Nudge prompt sent — the worker will read a-${params.name}.json and continue.` : nudgeNote) +
					archiveNote,
				{ action: params.action, name: params.name, dir, answerPath, nudged },
			);
		},
	});
}


// ===========================================================================
// SECTION 2/2 — delegate tool (DESIGN.md §5.1, §16–§22)
// (verbatim move of the old src/tools/delegate.ts; its review-verified header
// comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `delegate` tool (DESIGN.md §5.1).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * Spawns one herdr worker, briefs it, and blocks until it settles, then
 * validates the report file. BLOCKING by design; Esc (abort signal) detaches —
 * the worker keeps running and is recoverable via `delegate_status`. Errors are
 * surfaced as structured tool results (DESIGN.md §7), never thrown raw.
 *
 * Manifest discipline: the ManifestWorker record is written immediately after
 * place() succeeds and BEFORE startAgent — a failed start still leaves a real
 * placement that /delegate-teardown must be able to clean up.
 *
 * Dependency rule: imports transport.ts and exchange.ts only — never the
 * transport IMPLEMENTATION directly (herdr CLI lives behind
 * createHerdrTransport, bound once in index.ts).
 */

/** The diagnosed-retry mandate (W0, rng-sum bug 2): the policy text is ONE
 *  exported constant — it appears verbatim at BOTH model-facing guidance
 *  sites (the delegate promptGuidelines and the settle-fail error text).
 *  Before the migration the sentence was duplicated by hand and pinned
 *  byte-identical by test/static-check.ts T2.x; the pins now import this.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none
 * Output: the retry-mandate sentence (names the <name>-r2 suffixed shape)
 * Guarantees: any wording change passes through here — both sites stay in
 *   sync by construction (a T2-style pin still verifies both sites use it).
 * Raises: never */
export const RETRY_MANDATE =
	"The retry MUST use a NEW worker name (e.g. <name>-r2) — the original name stays taken by the settled agent.";

/** Interactive-readiness timeout for `agent start` (DESIGN.md §5.1 step 5). */
const START_TIMEOUT_MS = 120_000;
/** Max wait for prompt *submission* to be accepted (not for settle). */
const SUBMIT_TIMEOUT_MS = 30_000;
/** Default settle timeout for probe mode (short smoke gate). */
const PROBE_TIMEOUT_MS = 120_000;
/** Cap for the DEPRECATED timeoutMs alias (§20.1 hardened): a legacy stale
 *  timeoutMs must never hold the session hostage — folded into waitMs capped
 *  here AND clamped again in execute()'s wait computation. ONE spelling. */
const WAIT_CAP_MS = 120_000;
/** Exchange dir for probe runs — no brief/task, but placements must stay
 *  teardown- and status-visible (manifestStore.scan() covers every manifest under
 *  the exchange root). Derived from exchangeRoot() so sandboxed tests
 *  ($PI_DELEGATE_EXCHANGE_ROOT) never touch the live /tmp/exchange root. */
function probeExchangeDir(): string {
	return probeDirPathFor(exchangeRoot());
}
/** Fixed probe prompt (DESIGN.md §5.1 step 4). */
const PROBE_PROMPT = "Reply with exactly: OUTPUT: OK";
/** Settle-vs-report race grace window: settle can fire before the report file
 *  hits the disk (or mid-turn idle blip), so a missing/unparseable report is
 *  re-checked up to GRACE_RECHECKS times, GRACE_DELAY_MS apart (~10 s worst
 *  case). A schema rejection over a readable file is stable — never retried. */
const GRACE_RECHECKS = 5;
const GRACE_DELAY_MS = 2_000;

const delegateParams = Type.Object({
	name: Type.String({ description: "Worker name; must match [a-z][a-z0-9_-]{0,31}" }),
	briefPath: Type.String({
		description:
			`Absolute or cwd-relative path to the brief file under ${exchangeRoot()}/<task>/; a leading @ is stripped (ignored for probe)`,
	}),
	mode: Type.Optional(StringEnum(["worktree", "tab", "probe"] as const, {
		description:
			"worktree = isolated checkout+branch (default); tab = shared checkout; probe = explicit smoke gate — run one probe before any ≥3 fan-out",
	})),
	repoPath: Type.Optional(Type.String({ description: "Repo to place the worker in (default session cwd)" })),
	branch: Type.Optional(Type.String({ description: "Worktree branch (default delegate/<name>)" })),
	base: Type.Optional(Type.String({ description: "Base ref for worktree placement (default HEAD)" })),
	tier: Type.Optional(Type.String({ description: "Named worker tier from the pi-delegate.config.json tiers table (e.g. flash, frontier); beats defaults, loses to explicit provider/model/thinking" })),
	provider: Type.Optional(Type.String({ description: "Agent provider override; otherwise the configured tier/defaults decide (see ~/.pi/agent/pi-delegate.config.json) — no built-in default" })),
	model: Type.Optional(Type.String({ description: "Agent model override; otherwise the configured tier/defaults decide (see ~/.pi/agent/pi-delegate.config.json) — no built-in default" })),
	thinking: Type.Optional(Type.String({ description: "Thinking level override; otherwise the configured tier/defaults decide (see ~/.pi/agent/pi-delegate.config.json) — no built-in default" })),
	waitMs: Type.Optional(Type.Number({ description: "How long this call BLOCKS waiting for the worker (default: watch.settleGateMs from ~/.pi/agent/pi-delegate.config.json, 15000 ms — just enough to prove the worker started). At the cap the call auto-detaches: END YOUR TURN, the background watcher wakes you when the report lands or the worker needs attention. Long waits are explicit opt-in via this param." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Deprecated alias for waitMs — CAPPED at 120000 ms unless waitMs is set explicitly." })),
	releaseOn: Type.Optional(StringEnum(["started", "settle"] as const, {
		description:
			"When to release this call: 'settle' (default) blocks the full window unless the worker settles inline; 'started' releases as soon as the worker is proven started and working — the background watcher wakes you on report-ready/question/death. Default from watch.releaseOn in ~/.pi/agent/pi-delegate.config.json. Never applies to probes.",
	})),

	budgetTokens: Type.Optional(Type.Number({ minimum: 1, description: "Optional OUTPUT-token cap (sum of assistant output); over-budget workers are refused on retry with E_BUDGET." })),
	maxContextPct: Type.Optional(Type.Number({ minimum: 10, maximum: 99, description: "Context-window %% refusal line (default 80 — the operator restart habit). Re-spawning a worker at/over this context %% is refused with E_CONTEXT." })),
	extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra args appended after --" })),
});

function asDelegateError(err: unknown): DelegateError | null {
	if (err instanceof Error && typeof (err as DelegateError).code === "string") {
		return err as DelegateError;
	}
	return null;
}

async function reportExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort teardown audit line — MIRROR of the /delegate-teardown
 *  command's logTo format (index.ts, absorbed from commands.ts in W5):
 *  `[ISO] line` appended to
 *  `<exchange dir>/teardown.log`. Never lets a logging failure propagate;
 *  the collect-time auto-teardown shares the same trail with an explicit
 *  "(auto-after-collect)" marker.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — exchange dir; line — the audit text
 * Output: resolves after the append attempt
 * Guarantees:
 *   - append-only, timestamped; a logging failure is swallowed (best-effort
 *     audit — never blocks teardown or the collect result)
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — <exchange dir>/teardown.log (shared with
 *   the /delegate-teardown command's trail).
 */
async function logTeardownAudit(dir: string, line: string): Promise<void> {
	try {
		await appendFile(join(dir, TEARDOWN_LOG_NAME), teardownLogLine(line));
	} catch {
		// best-effort audit log — never block teardown on logging failure
	}
}

/** True when the file is unreadable or JSON.parse still fails — a mid-write
 *  (or unreadable) symptom worth re-checking. Only a missing file (ENOENT) is
 *  not a parse failure (handled as E_REPORT_MISSING retry logic instead).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — candidate report file
 * Output: true iff the file is unreadable OR readable but not valid JSON
 *   (i.e. any error except ENOENT)
 * Guarantees:
 *   - distinguishes mid-write (retryable) from missing (different code) and
 *     from stable-but-invalid (not retried)
 * Raises: never
 */
async function isParseFailure(path: string): Promise<boolean> {
	try {
		JSON.parse(await readFile(path, "utf8"));
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
	}
}

/** Fleet journal (DESIGN.md §19.4): best-effort session entry, headless-safe.
 *  Guarded: only when appendEntry is available on the api object.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: pi — extension API; event spawn|collect; worker name; status;
 *   optional archivePath
 * Output: none
 * Guarantees:
 *   - no-op on headless/old builds (no appendEntry); a journal failure is
 *     swallowed — advisory, never affects outcomes
 * Raises: never
 * EXTERNAL_DEPENDENCY: pi's ExtensionAPI.appendEntry (host session journal).
 */
function journal(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	event: "spawn" | "collect",
	worker: string,
	status: string,
	archivePath?: string,
): void {
	if (typeof pi.appendEntry !== "function") return;
	try {
		pi.appendEntry("delegate-fleet", {
			ts: new Date().toISOString(),
			event,
			worker,
			status,
			...(archivePath ? { archivePath } : {}),
		});
	} catch {
		// journal is advisory — never affects outcomes
	}
}

/**
 * v1.11.x ownership: the spawning session's JSONL path, read through the LIVE
 * sessionManager getter at the moment of the manifest write — /new and /resume
 * change the path, so a captured constant would pin a dead session (and a new
 * session inheriting no wake-ups is the DESIRED behavior). Undefined when
 * unavailable (headless/degraded) → the field is simply not recorded.
 * Watcher stage A: an unrecorded owner is no longer silently harmless — the
 * delivery default is fail-closed, so the CALLER (the spawn flow) must signal
 * the orchestrator and the audit file (see the manifest-write site).
 */
function liveSessionFile(ctx: {
	sessionManager?: { getSessionFile?: () => string | undefined };
}): string | undefined {
	try {
		const f = ctx.sessionManager?.getSessionFile?.();
		return typeof f === "string" && f.length > 0 ? f : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Watcher stage A (guideline §9): best-effort line into the watcher's audit
 * file — the same append-only sink the watcher log uses. Advisory by
 * contract: a write failure is swallowed, never affects the spawn outcome.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: line — the audit text (ISO timestamp is prepended here)
 * Output: none
 * Guarantees:
 *   - appends one line to ~/.pi/agent/delegate-watch.log, best-effort
 *   - never throws past the caller (append failures are swallowed)
 * Raises: never
 * EXTERNAL_DEPENDENCY: ~/.pi/agent/delegate-watch.log (append-only audit
 *   file under pi's agent dir; pi's getAgentDir() (honors
 *   PI_CODING_AGENT_DIR) resolves it — see the
 *   makeWatcherLogSink contract in observe.ts for the test seam).
 */
function watchAudit(line: string): void {
	void appendFile(join(getAgentDir(), "delegate-watch.log"), `${new Date().toISOString()} ${line}\n`).catch(
		() => undefined,
	);
}

/** Abort-aware sleep: resolves early when the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((res) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				res();
			},
			{ once: true },
		);
	});
}

// ===========================================================================
// Migration stage 2 (audit step 7) — injectable clock/delay port + the
// settle→collect seam as an explicit state machine
// ===========================================================================

/**
 * Clock/delay port (audit step 7): the pipeline's ONLY access to wall-clock
 * time and sleeping. Injecting it makes time-dependent pipeline sections
 * (the grace recheck loop first) testable on virtual clocks — no real
 * waiting in tests, deterministic sequences.
 * <p>
 * MODULE_CONTRACT (port): delay() MUST resolve early when the signal fires
 * (the abort-detaches-never-kills discipline — the wait is cancellable,
 * never the worker); now() is a monotonic-enough millisecond read.
 */
export interface ClockPort {
	now(): number;
	delay(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The production clock: real timers. */
export const systemClock: ClockPort = {
	now: () => Date.now(),
	delay: (ms, signal) => sleep(ms, signal),
};

export interface VirtualClock extends ClockPort {
	/** Resolve every pending delay whose due time falls within the next `ms`
	 *  of virtual time, advancing now() past them. Awaits until the resolvers
	 *  have run (microtask flush). */
	advance(ms: number): Promise<void>;
}

/**
 * Virtual clock for tests: delays never use real time — they resolve when
 * advance() moves virtual time past their due point.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: startNow — the initial virtual time (ms)
 * Output: a VirtualClock (ClockPort + advance)
 * Guarantees:
 *   - delay() never resolves before an advance() covers its due time
 *   - delay() honors the abort signal (the port contract): an aborted wait
 *     resolves early — the abort-detaches-never-kills discipline holds on
 *     virtual time too
 *   - advance() resolves ALL due waiters in scheduling order and flushes a
 *     microtask tick so chained delays observe the new time
 * Raises: never
 */
export function createVirtualClock(startNow = 0): VirtualClock {
	let now = startNow;
	const waiters: Array<{ due: number; resolve: () => void }> = [];
	return {
		now: () => now,
		delay(ms, signal) {
			return new Promise<void>((res) => {
				const waiter = { due: now + ms, resolve: res };
				waiters.push(waiter);
				if (signal) {
					if (signal.aborted) {
						const i = waiters.indexOf(waiter);
						if (i >= 0) waiters.splice(i, 1);
						res();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							const i = waiters.indexOf(waiter);
							if (i >= 0) waiters.splice(i, 1);
							res();
						},
						{ once: true },
					);
				}
			});
		},
		async advance(ms) {
			now += ms;
			const due = waiters.filter((w) => w.due <= now);
			for (const w of waiters) {
				if (w.due > now) continue;
				w.resolve();
			}
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (due.includes(waiters[i])) waiters.splice(i, 1);
			}
			await new Promise<void>((r) => setTimeout(r, 0));
		},
	};
}

/** One collect attempt (the collectReport() shape — verdict + the path it
 *  actually read + whether the requested-name fallback was used). */
export interface CollectAttempt {
	verdict: { ok: true; report: WorkerReport } | { ok: false; error: string };
	usedPath: string;
	fallbackUsed: boolean;
}

/** The grace-loop state machine's states (the settle→collect seam). */
export type GraceState =
	| { kind: "evaluate"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "collected"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "awaiting-answer"; question: QuestionEnvelope }
	| { kind: "exhausted"; attempt: CollectAttempt; graceAttempt: number }
	| { kind: "aborted"; graceAttempt: number };

/**
 * Dependencies of the grace transition — everything is injected, nothing is
 * read from module state (the seam is fully explicit and testable).
 */
export interface GraceLoopDeps {
	/** Re-read + re-validate the report (the collectReport closure). */
	collect: () => CollectAttempt;
	/** Tolerant pending-question read (q-<name>.json). */
	pendingQuestion: () => QuestionEnvelope | null;
	/** Advisory progress-ping read (p-<name>.jsonl tail). */
	readProgressPing: () => ProgressEvent | null;
	reportExists: (path: string) => Promise<boolean>;
	isParseFailure: (path: string) => Promise<boolean>;
	/** The injected clock — the loop's ONLY time source. */
	clock: ClockPort;
	/** Abort signal of the tool call (abort = detach, never kill). */
	signal?: AbortSignal;
	maxRechecks: number;
	delayMs: number;
	onRecheck?: (attempt: number, missing: boolean, usedPath: string) => void;
	onPing?: (ping: ProgressEvent) => void;
}

/**
 * ONE transition of the settle→collect grace state machine: takes a state,
 * returns the next. From "evaluate" it applies the priority ladder of the
 * unified grace loop (report → question → retryable report state) — the
 * exact pre-extraction semantics (v1.9b review fix 2); every other state is
 * terminal and returned unchanged.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — the current grace state; deps — the injected seam
 * Output: the next state ("evaluate" again after a delay+recollect, or a
 *   terminal kind: collected / awaiting-answer / exhausted / aborted)
 * Guarantees:
 *   - priority order preserved: a valid verdict wins BEFORE the question
 *     check; the question wins BEFORE the retryable check
 *   - a schema rejection over a readable file is stable (never retried →
 *     "exhausted" with graceAttempt untouched)
 *   - abort during the injected delay → "aborted" (the CALLER salvages:
 *     re-collect + probe salvage + detach — the loop never kills a worker)
 *   - the delay goes through deps.clock (virtual in tests)
 * Raises: never (advisory reads are guarded by the caller's closures)
 */
export async function graceTransition(state: GraceState, deps: GraceLoopDeps): Promise<GraceState> {
	if (state.kind !== "evaluate") return state;
	const { attempt, graceAttempt } = state;
	// 1. A valid collect outranks everything (the loop condition of the
	// pre-extraction code checked the verdict first).
	if (attempt.verdict.ok) return { kind: "collected", attempt, graceAttempt };
	// 2. A pending question outranks the retry ladder — the orchestrator's
	// next action is answering, not waiting for a report.
	const question = deps.pendingQuestion();
	if (question) return { kind: "awaiting-answer", question };
	// 3. Advisory progress ping (v1.5, §18) — streamed, never decisive.
	const ping = deps.readProgressPing();
	if (ping) deps.onPing?.(ping);
	// 4. Retryable report state (missing / mid-write JSON) → wait + recheck;
	// a stable rejection (readable, schema-invalid) is final.
	const missing = !(await deps.reportExists(attempt.usedPath));
	const retryable = missing || (await deps.isParseFailure(attempt.usedPath));
	if (!retryable) return { kind: "exhausted", attempt, graceAttempt };
	const next = graceAttempt + 1;
	if (next > deps.maxRechecks) return { kind: "exhausted", attempt, graceAttempt };
	deps.onRecheck?.(next, missing, attempt.usedPath);
	await deps.clock.delay(deps.delayMs, deps.signal);
	if (deps.signal?.aborted) return { kind: "aborted", graceAttempt };
	return { kind: "evaluate", attempt: deps.collect(), graceAttempt: next };
}

/**
 * Run the grace state machine to a terminal state (the extracted post-settle
 * grace loop — the settle→collect seam).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — the injected seam (collect, question/ping readers, fs
 *   probes, clock, signal, recheck budget)
 * Output: the terminal GraceState — never "evaluate"
 * Guarantees:
 *   - behavior-identical to the pre-extraction inline loop (the three
 *     execute drivers pin it end to end)
 *   - termination: each delay+recheck increments graceAttempt; the recheck
 *     budget caps the loop
 * Raises: never (reportExists/isParseFailure/pendingQuestion are tolerant)
 */
export async function runGraceLoop(deps: GraceLoopDeps): Promise<Exclude<GraceState, { kind: "evaluate" }>> {
	let state: GraceState = { kind: "evaluate", attempt: deps.collect(), graceAttempt: 0 };
	while (state.kind === "evaluate") {
		state = await graceTransition(state, deps);
	}
	return state;
}

/**
 * Register the `delegate` tool on the extension API.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - pi: the extension API (tool registration, UI, journal, notifications)
 *   - transport: the injected Transport seam (herdr subprocess layer)
 * Output: none (registers the tool as a side effect)
 * Guarantees:
 *   - execute() NEVER throws past the tool boundary: every failure shape
 *     returns a structured tool result with an E_* code (DESIGN.md §7)
 *   - blocking by design up to the settle gate (or explicit waitMs); Esc/abort
 *     detaches — after the agent exists the worker is NEVER killed
 *   - the report file is the completion criterion; probes are the exception
 *     (pane/status verdict, no report file ever expected)
 *   - manifest written between place() and startAgent (teardown visibility);
 *     canonical-name reconcile + sessionPath recorded when known
 *   - dual-gauge governor (E_CONTEXT / E_BUDGET) refuses re-spawns of workers
 *     near compaction or over budget
 * Raises:
 *   - structured fail results: E_TIER, E_NAME, E_BRIEF, E_PLACE, E_START,
 *     E_PROMPT_STALLED, E_TIMEOUT, E_REPORT_MISSING, E_REPORT_INVALID,
 *     E_BUDGET, E_CONTEXT (see inline sites)
 * EXTERNAL_DEPENDENCY: config file (~/.pi/agent/pi-delegate.config.json via
 *   resolveSpawnDefaults/resolveWatchConfig), schema dirs
 *   (<cwd>/.pi/delegate-schemas then ~/.pi/agent/pi-delegate-schemas),
 *   exchange dir on disk, worker session JSONL, herdr via transport.
 */
export function registerDelegateTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Spawn one worker (worktree or tab), brief it, block until it settles, and validate its JSON report. " +
			"mode 'probe' is the explicit smoke gate — run one probe before any ≥3 fan-out. " +
			"Esc detaches without killing the worker. Report status 'fail' still means the worker ran and reported honestly.",
		promptSnippet: "Spawn a worker with a brief file and block until its report lands",
		prepareArguments(args): Static<typeof delegateParams> {
			// Legacy-session shim (pi docs Argument preparation): old sessions may
			// carry the deprecated timeoutMs alias. Fold it into waitMs ONLY when
			// waitMs is not already present, applying the same WAIT_CAP_MS clamp
			// execute() applies to the alias — the resulting call behaves exactly
			// like the pre-refactor runtime for old calls. The public schema stays
			// strict: everything without a string/number timeoutMs passes through
			// untouched and is validated as-is.
			if (!args || typeof args !== "object") return args as Static<typeof delegateParams>;
			const input = args as Record<string, unknown>;
			if (typeof input.waitMs === "number") return args as Static<typeof delegateParams>;
			const legacy =
				typeof input.timeoutMs === "number" ? input.timeoutMs
				: typeof input.timeoutMs === "string" && input.timeoutMs.trim() !== "" && Number.isFinite(Number(input.timeoutMs))
					? Number(input.timeoutMs)
					: undefined;
			if (legacy === undefined) return args as Static<typeof delegateParams>;
			return { ...input, waitMs: Math.min(legacy, WAIT_CAP_MS) } as Static<typeof delegateParams>;
		},
		promptGuidelines: [
			"Use delegate only after the brief file exists under ${exchangeRoot()}/<task>/ — pass its path as briefPath; the brief is the worker's instructions and its OUTPUT section must point at report-<name>.json.",
			"delegate blocks until the worker settles; the worker's report file is the completion criterion, not the agent status — status fail in the report is still an honest completion.",
			"If delegate returns E_REPORT_MISSING or E_REPORT_INVALID, do a diagnosed retry with root cause + fix shape (at most 2 repeats, then escalate); never repeat verbatim. " +
			RETRY_MANDATE,
			"delegate mode 'probe' is OPTIONAL (enterprise cost): only for untrusted environments — the first real worker's structured failures (E_PLACE/E_START/E_NAME) are just as cheap a smoke signal. Probes verify the pane reply \"OUTPUT: OK\" by streaming readback.",
			"delegate probe workers NEVER write a report file — a 'probe OK/FAIL' result is final by itself; never wait for or read a probe's report-<name>.json (only real workers produce reports).",
			"After delegate returns E_TIMEOUT or a detach, END YOUR TURN: the background watcher (DESIGN.md §21) wakes you when the report lands, a question arrives, grill_deck is invoked, context goes critical, or the worker dies. Never sleep in bash to wait for a worker and never re-call delegate to wait; delegate_status polling is the only in-turn alternative (bash sleep only when the watcher is absent — old extension build).",
		],
		parameters: delegateParams,
		renderCall(args, theme: Theme) {
			const name = typeof args?.name === "string" ? args.name : "?";
			const mode = typeof args?.mode === "string" ? args.mode : "worktree";
			const head = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("muted", mode);
			return {
				// v1.8b: clamp to the width pi-tui passes — over-wide lines crash the TUI.
				render: (width?: number) => clampLines([`${head} ${theme.fg("accent", name)}`], width),
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme: Theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate", resultText, theme);
			// v1.8b — BUG_FIX_CONTEXT: over-wide rendered lines crashed the whole TUI
			// (uncaughtException "Rendered line N exceeds terminal width"); every
			// rendered line is now clamped to the width pi-tui passes.
			// v1.8b: clamp to the width pi-tui passes — the heartbeat headline can
			// exceed narrow terminals and an over-wide line crashes the whole TUI
			// (uncaughtException "Rendered line N exceeds terminal width").
			return { render: (width?: number) => clampLines(lines, width), invalidate: () => {} };
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const step = (text: string, details: Record<string, unknown>) => {
				onUpdate?.({ content: [{ type: "text", text }], details });
			};
			const startedAtDate = new Date();
			const isProbe = params.mode === "probe";
			// BUG_FIX_CONTEXT (v1.8b §20.1 hardened + v1.11 §21): the DEFAULT blocking
			// window is the watcher's settle gate (watch.settleGateMs, 15 s) — a spawn
			// proves "the worker started" and hands over to the background watcher,
			// which wakes the orchestrator on settle/question/grill-deck/context/death.
			// Symptom of the old behavior: a legacy/stale timeoutMs (1800000) held the
			// session hostage for 30 min with no heartbeat escape hatch. What was
			// done: WAIT_CAP_MS clamps the deprecated timeoutMs; an explicit waitMs is
			// uncapped opt-in long blocking. (prepareArguments also folds the legacy
			// alias into waitMs for resumed old sessions — the clamp here is the
			// backstop for raw timeoutMs that still reaches execute.)
			const settleGateMs = resolveWatchConfig().settleGateMs;
			const timeoutMs =
				params.waitMs ??
				(params.timeoutMs !== undefined
					? Math.min(params.timeoutMs, WAIT_CAP_MS)
					: isProbe
						? PROBE_TIMEOUT_MS
						: settleGateMs);
		// v1.14 early release — watch.releaseOn=started (or per-call override):
		// once the worker is proven started and working, hand off to the watcher
		// instead of blocking the rest of the settle gate. Probes are exempt:
		// their full window IS the smoke verdict.
		const releaseOn = params.releaseOn ?? resolveWatchConfig().releaseOn;
		const releaseOnStarted = !isProbe && releaseOn === "started";
			// EXTERNAL_DEPENDENCY: ~/.pi/agent/pi-delegate.config.json — "tiers" and
			// "defaults" sections (via resolveSpawnDefaults/resolveTierTable in
			// usage.ts); missing/unconfigured → E_TIER, never a guessed provider.
			// v1.9.2 tier resolution — explicit params > tiers[<tier>] > defaults,
			// per key. There is NO built-in worker tier: an unconfigured environment
			// fails fast with E_TIER here (before touching herdr) instead of
			// silently spawning a provider the operator never chose.
			const spawnDefaults = resolveSpawnDefaults();
			const tierTable = resolveTierTable();
			const requestedTier = params.tier ?? spawnDefaults.tier;
			let tierEntry: SpawnTier | undefined;
			if (requestedTier !== undefined) {
				tierEntry = tierTable[requestedTier];
				if (tierEntry === undefined) {
					const available = Object.keys(tierTable).sort();
					return fail(
						"E_TIER",
						`E_TIER — unknown worker tier "${requestedTier}"` +
							` (configured tiers: ${available.length > 0 ? available.join(", ") : "none"}). ` +
							"Add it to ~/.pi/agent/pi-delegate.config.json under \"tiers\", drop the tier param, " +
							"or pass provider/model/thinking explicitly.",
						{ tier: requestedTier, availableTiers: available, name: params.name },
					);
				}
			}
			const pickTier = (
				explicit: string | undefined,
				fromTier: string | undefined,
				fromDefaults: string | undefined,
			): string | undefined => explicit ?? fromTier ?? fromDefaults;
			const provider = pickTier(params.provider, tierEntry?.provider, spawnDefaults.provider);
			const model = pickTier(params.model, tierEntry?.model, spawnDefaults.model);
			const thinking = pickTier(params.thinking, tierEntry?.thinking, spawnDefaults.thinking);
			const missingTierKeys = [
				provider === undefined ? "provider" : undefined,
				model === undefined ? "model" : undefined,
				thinking === undefined ? "thinking" : undefined,
			].filter((k): k is string => typeof k === "string");
			if (missingTierKeys.length > 0) {
				return fail(
					"E_TIER",
					`E_TIER — no worker ${missingTierKeys.join("/")} configured (no built-in tier exists). ` +
						"Set \"tiers\" / \"defaults\" in ~/.pi/agent/pi-delegate.config.json, e.g. " +
						'{"tiers": {"flash": {"provider": "zai", "model": "glm-5.3-flash", "thinking": "high"}}, ' +
						"\"defaults\": {\"tier\": \"flash\"}} — or pass provider/model/thinking explicitly.",
					{ missing: missingTierKeys, name: params.name },
				);
			}
			const mode = params.mode ?? "worktree";
			// Probe is not a placement mode: it uses the cheapest real placement (tab).
			const placementMode: PlacementMode = mode === "probe" ? "tab" : mode;
			const repoPath = resolve(ctx.cwd, params.repoPath ?? ctx.cwd);
			const branch = params.branch ?? `delegate/${params.name}`;
			const briefPath = isProbe ? "" : resolve(ctx.cwd, params.briefPath.replace(/^@/, ""));

			// 1. Validate name + brief (fail fast, before touching herdr).
			if (!WORKER_NAME_RE.test(params.name)) {
				return fail(
					"E_NAME",
					`E_NAME — invalid worker name "${params.name}". ` +
						"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name (read back at start) when retrying.",
				);
			}

			let exchangeDir: string | null = null;
			if (!isProbe) {
				try {
					exchangeDir = ensureExchangeDir(briefPath).dir;
				} catch (err) {
					const de = asDelegateError(err);
					const guidance =
						de?.guidance ?? `Write the brief file under ${exchangeRoot()}/<task>/ first, then call delegate again.`;
					return fail("E_BRIEF", `E_BRIEF — ${errText(err)}\n${guidance}`, {
						briefPath,
						name: params.name,
					});
				}
			}
			const manifestDir = exchangeDir ?? probeExchangeDir();

			// Dual-gauge governor (DESIGN.md §20): refuse to re-spawn a worker whose
			// recorded session tripped EITHER gauge — context % (primary, pi's own
			// formula) or output budget (secondary, when set).
			const maxPct = params.maxContextPct ?? CONTEXT_WARN_PCT;
			const contextWindow = resolveContextWindow(model);
			const priorWorker = manifestStore.read(manifestDir)?.workers.find(
				(w) => w.name === params.name && typeof w.sessionPath === "string" && w.sessionPath.length > 0,
			);
			if (priorWorker?.sessionPath) {
				const priorUsage = parseSessionUsage(priorWorker.sessionPath);
				if (overContext(priorUsage, contextWindow, maxPct)) {
					const pct = contextPct(priorUsage, contextWindow);
					return fail(
						"E_CONTEXT",
						`E_CONTEXT — worker session near compaction (ctx ${pct}% ≥ ${maxPct}%): its next prompt would compact and lose the brief. ` +
							"Start a NEW worker name (diagnosed retry = new brief + fresh context).",
						{ usage: priorUsage, contextWindow, maxPct, sessionPath: priorWorker.sessionPath, name: params.name },
					);
				}
				if (overOutputBudget(priorUsage, params.budgetTokens)) {
					return fail(
						"E_BUDGET",
						`E_BUDGET — worker over OUTPUT budget (${priorUsage.output} > ${params.budgetTokens} tokens). ` +
							"Pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
						{ usage: priorUsage, budget: params.budgetTokens, sessionPath: priorWorker.sessionPath, name: params.name },
					);
				}
			}

			// v1.5 (DESIGN.md §16–§17): resolve the brief's report schema — inline
			// fragment or named library type — once, BEFORE place(): a bad schema must
			// never waste a worker. On {ok:false} the spawn is rejected with E_BRIEF.
			// The resolved provenance chain is recorded in the manifest (§17) and
			// quoted in terminal results when the fragment rejects a report.
			// Unexpected throws (contract bugs) degrade to base-schema-only validation
			// rather than blocking the run — the {ok:false} path is the real rejection.
			let briefSchema: Record<string, unknown> | null = null;
			let schemaProvenance: string[] = [];
			// Merged fragment (§17) — recorded in the manifest as reportSchemaFragment
			// during the post-start reconcile, and quoted in fragment-rejection errors.
			let resolvedSchema: Record<string, unknown> | null = null;
			if (!isProbe) {
				let resolved: ReturnType<typeof resolveReportSchema>;
				try {
					// EXTERNAL_DEPENDENCY: filesystem — <cwd>/.pi/delegate-schemas/
					// (via pi's CONFIG_DIR_NAME — the literal ".pi" honoring pi's
					// project-config convention) and ~/.pi/agent/pi-delegate-schemas/
					// (library type files <name>.json).
					// Two-tier schema library (DESIGN.md §16): project-local
					// <cwd>/.pi/delegate-schemas/ searched FIRST, user-level second.
					resolved = resolveReportSchema(briefPath, resolve(ctx.cwd, CONFIG_DIR_NAME, "delegate-schemas"));
				} catch (err) {
					// A throw is not a resolution failure per the contract ({ok:false} is) —
					// degrade to base-schema-only validation instead of rejecting the spawn.
					resolved = { ok: true, schema: null, provenance: [] };
					step(
						`warning: schema resolver threw unexpectedly (${errText(err)}) — falling back to base-schema-only validation`,
						{ phase: "schema-degraded", error: errText(err) },
					);
				}
				if (!resolved.ok) {
					return fail(
						"E_BRIEF",
						`E_BRIEF — report schema resolution failed for ${params.name}: ${resolved.error}\n` +
							"Fix the brief's reportSchema reference or inline fragment before spawning.",
						{ briefPath, name: params.name, resolutionError: resolved.error },
					);
				}
				// Corrected contract (merge gate): schema is null when the brief has no
				// reportSchema key — ok-with-null → base-only validation, never a rejection.
				briefSchema = resolved.schema;
				schemaProvenance = resolved.provenance;
				resolvedSchema = resolved.schema;
			}

			// 2. Place (worktree create / tab create — transport serializes mutations).
			step(`Placing worker ${params.name} (mode: ${mode})…`, {
				phase: "place",
				name: params.name,
				mode,
				repoPath,
				branch,
			});
			let placement: Placement;
			try {
				placement = await transport.place({
					mode: placementMode,
					repoPath,
					branch,
					label: params.name,
					base: params.base,
				});
			} catch (err) {
				// Migration stage 1: read the typed code the adapter raised (e.g. the
				// name-taken refusal is E_NAME and STAYS E_NAME — no text parsing, no
				// re-flattening); only a plain Error falls back to the positional code.
				const code = typedCode(err, "E_PLACE");
				return fail(
					code,
					`${code} — ${mode} placement failed for ${params.name}: ${errText(err)}\n` +
						"Reconcile via /delegate-teardown or the host workspace listing, then retry with a fresh delegate call.",
					{ name: params.name, mode, stderr: errText(err) },
				);
			}

			//    BUG_FIX_CONTEXT: symptom — a failed start left an orphaned pane/
			//    worktree invisible to teardown because the manifest entry was only
			//    written after a successful start. Why the old order did not work:
			//    start failure skipped the manifest write entirely. What was done:
			//    the write moved between place() and startAgent, and the failure path
			//    reports whether the placement is manifest-tracked.
			// 3. Record the worker in the manifest IMMEDIATELY after place() and
			//    BEFORE startAgent: if the start fails, the placement is still real
			//    and /delegate-teardown must be able to clean it up.
			let reportPath = reportPathFor(manifestDir, params.name);
			// Migration stage 3 (audit step 8): snapshot the report paths' PRE-RUN
			// state as THIS embodiment's witness (lifecycle.ts) — the settle wait
			// proves completion by observing the canonical report file against the
			// witness (file appeared / was rewritten since THIS run started), never
			// by comparing file mtimes against the wall clock.
			const readReportOrNull = async (p: string): Promise<string | null> => {
				try {
					return await readFile(p, "utf8");
				} catch {
					return null; // absent/unreadable — the witness records "did not exist"
				}
			};
			const reportWitnesses = new Map<string, ReportWitness>();
			// BUG_FIX_CONTEXT (migration stage 3, audit step 8): symptom — a stale
			// report of an earlier same-name run could false-settle THIS run (the old
			// proof compared file mtime against the spawn wall-clock time; clock skew
			// and sub-millisecond ordering made both false-settle and false-miss
			// possible). Why the WIP snapshot alone did not work: the witness map is
			// built HERE, before startAgent, when only the REQUESTED-name path is
			// known — a uniquified canonical name gets its report path later, and
			// settleProof would find no witness for it and silently skip the file
			// proof. What was done: witnesses are keyed by path; the canonical path
			// gets its own snapshot right after the manifest rename (still BEFORE
			// submitPrompt — the prompt is not yet delivered, so the snapshot is a
			// true pre-run state of THIS embodiment).
			reportWitnesses.set(reportPath, witnessEmbodimentReport(await readReportOrNull(reportPath)));
			let manifestWarning = "";
			// Watcher stage A: set when the manifest entry went out WITHOUT an
			// owner session path (degraded session id) — surfaced to the
			// orchestrator in the result payload (declared here, outside the
			// manifest-update try, so every result path can carry it).
			let ownerWarning = "";
			try {
				// v1.5 (DESIGN.md §17): record the resolved-schema provenance as a plain
				// JSON manifest key — ManifestWorker now declares the field (quality fix
				// A7), so the entry type-checks without a cast.
				// The E_TIER guard above guarantees provider/model/thinking are defined
				// here (missing keys fail fast before spawn) — TS can't narrow through
				// the filter, so assert with a comment instead of falsifying data.
				// v1.11.x ownership: record the spawning session's path (live getter,
				// see liveSessionFile) so the watcher wakes ONLY this session.
				// Migration stage 2 (audit step 6): the entry carries its EMBODIMENT
				// identity — run ordinal (prior same-name entries + 1) + this
				// placement's ref — so two embodiments of one name in one task dir
				// are distinguishable by construction.
				const embodiment = nextEmbodiment(
					params.name,
					placement.placementRef ?? placement.paneId,
					manifestStore.read(manifestDir)?.workers ?? [],
				);
				const orchestratorSessionPath = liveSessionFile(ctx);
				// Watcher stage A (guideline §3.3): a spawn that could NOT read its
				// session id must not go out silently — the delivery default is now
				// fail-closed, so this worker's orchestrator would never be woken.
				// Full fail-spawn is a separate decision (not this PR); per §3.3's
				// "допустимо временно" shape the worker is registered (spawn stays
				// successful) but the orchestrator gets an explicit warning in the
				// result payload and the watcher's audit file gets a line.
				// BUG_FIX_CONTEXT: symptom — after the fail-closed delivery flip, a
				// degraded spawn (headless/throwing sessionManager) silently wrote a
				// manifest entry with NO orchestratorSessionPath, and the worker's
				// wake-ups were lost with zero signal to anyone. Why the old solution
				// did not work: pre-stage-A the watcher failed OPEN on owner-less
				// manifests, so the missing field cost nothing and went unreported.
				// What was done: the unrecorded-owner case now returns an explicit
				// warning to the orchestrator (ownerWarning in the result payload)
				// and appends a line to the watcher audit file; the spawn itself
				// still succeeds (full fail-spawn is a separate, larger decision).
				if (!orchestratorSessionPath) {
					ownerWarning =
						"could not read this session's id — the worker is registered WITHOUT an owner session path; " +
						"the watcher will NOT wake this session for its events (fail-closed default). " +
						"watch.legacyFailOpen:true would restore legacy delivery but is unsafe on a multi-session machine.";
					watchAudit(
						`spawn worker=${params.name} — no owner session id recorded (sessionManager unavailable); ` +
							"the watcher will not deliver wake-ups for this worker (fail-closed default)",
					);
				}
				const manifestEntry: ManifestWorker = {
					name: params.name,
					placement,
					briefPath,
					reportPath,
					provider: provider as string,
					model: model as string,
					thinking: thinking as string,
					startedAt: startedAtDate.toISOString(),
					schemaProvenance,
					embodiment: { run: embodiment.run, placementRef: embodiment.placementRef },
					...(orchestratorSessionPath ? { orchestratorSessionPath } : {}),
				};
				// F1 fleet accounting: the FIRST delegate call of a task fixes the
				// task-level description (derived from THIS call's brief via
				// describeFleet — rule documented there) and the master session link
				// (this call's orchestratorSessionPath). applyFleetTaskFields is
				// set-once: later spawns of the same fleet never overwrite them.
				let fleetDescription: string | undefined;
				try {
					fleetDescription = describeFleet(await readFile(briefPath, "utf8")) || undefined;
				} catch {
					fleetDescription = undefined; // unreadable brief → next spawn retries
				}
				await manifestStore.update(manifestDir, (m) =>
					applyFleetTaskFields(
						{ ...m, workers: [...m.workers, manifestEntry] },
						{ description: fleetDescription, masterSessionPath: orchestratorSessionPath },
					),
				);
				// F6 review fix: a same-name retry is a NEW worker lifecycle — any
				// stale nudge-failed-<name>.json from the previous worker of the same
				// name is history. Without this cleanup a fresh watcher session would
				// re-fire the old marker once (its seen-dedup is per-lifetime).
				try {
					await rm(nudgeFailedPathFor(manifestDir, params.name), { force: true });
				} catch {
					// advisory cleanup — the marker's own ts fingerprint keeps old
					// events deduped within an existing watcher
				}
			} catch (err) {
				manifestWarning = `Manifest update failed (${errText(err)}) — teardown/audit for this placement is degraded; record it manually.`;
			}

			// 4. Start the agent; read back the canonical name.
			step(`Starting agent in placement ${placement.placementRef ?? placement.paneId} (provider=${provider}, model=${model}, thinking=${thinking})…`, {
				phase: "start",
				name: params.name,
				placementRef: placement.placementRef ?? placement.paneId,
			});
			let start;
			try {
				start = await transport.startAgent({
					name: params.name,
					// Workerhost inversion (design §3): StartReq keyed by the opaque ref;
					// legacy pane id as fallback so pre-ref placement records still start.
					placementRef: placement.placementRef ?? placement.paneId,
					provider: provider as string,
					model: model as string,
					thinking: thinking as string,
					extraArgs: params.extraArgs,
					timeoutMs: START_TIMEOUT_MS,
				});
			} catch (err) {
				// Migration stage 1: the adapter's typed code passes through intact —
				// E_NAME (name taken) is no longer re-flattened into E_START. A plain
				// Error (no code) still falls back to the positional E_START.
				// The manifest entry was appended BEFORE startAgent (step 3, deliberate
				// teardown-safety invariant — do not move the append). A refused start
				// would leave a phantom entry with no sessionPath, so roll back ONLY the
				// entry THIS call appended: match by requested name + this call's
				// placement ref (legacy pane id fallback) and only if it never gained a
				// sessionPath — a pre-existing same-name
				// worker (its own placement / a real sessionPath) is preserved.
				try {
					await manifestStore.update(manifestDir, (m) => ({
						...m,
						workers: m.workers.filter(
							(w) =>
								!(
									w.name === params.name &&
									(w.placement.placementRef ?? w.placement.paneId) ===
										(placement.placementRef ?? placement.paneId) &&
									!w.sessionPath
								),
						),
					}));
				} catch {
					// Best-effort rollback — the failure text below already points at
					// manual reconciliation via /delegate-teardown.
				}
				const code = typedCode(err, "E_START");
				return fail(
					code,
					`${code} — agent start failed for ${params.name}: ${errText(err)}\n` +
						"Check pane readiness; a retry is a new delegate call. " +
						(manifestWarning
							? `Placement NOT tracked in manifest (${manifestWarning}) — clean it up manually via /delegate-teardown or the host workspace listing.`
							: "Placement tracked in manifest — run /delegate-teardown to clean up."),
					{ name: params.name, placement, stderr: errText(err) },
				);
			}
			const canonical = start.name;
			// Budget accounting source (DESIGN.md §14): the worker's session JSONL
			// path, captured by the transport from the herdr agent start result
			// (result.agent.agent_session.value) and recorded in the manifest below.
			// v1.9: mutable — when herdr exposes no session path (current builds:
			// no agent_session in agent get/start results), the pi-storage fallback
			// below resolves it so gauges, budget accounting and probe salvage
			// keep working.
			let sessionPath: string | undefined = start.sessionPath;
			const uniquified = canonical !== params.name
				? `Note: the host uniquified the requested name "${params.name}" → "${canonical}".`
				: "";

			// Fleet journal (§19.4): record the spawn as soon as the placement is
			// live and the canonical name is known.
			journal(pi, "spawn", canonical, "started");

			// Tier-mismatch guard (DESIGN.md §19.4): when the brief text declares a
			// tier ("frontier tier"/"flash tier"/"execution tier") and the spawned
			// model contradicts it, surface a warning on every terminal result.
			let tierWarning = "";
			if (!isProbe) {
				try {
					const briefText = await readFile(briefPath, "utf8");
					const tierMatch = briefText.match(/frontier tier|flash tier|execution tier/i);
					if (tierMatch) {
						const declared = /frontier/i.test(tierMatch[0]) ? "frontier" : "flash";
						const modelStr = model as string; // guaranteed by the E_TIER guard above
						const ok = declared === "frontier" ? /frontier/i.test(modelStr) : /flash|glm/i.test(modelStr);
						if (!ok) tierWarning = `brief declares ${declared} tier but worker runs ${modelStr} — tier mismatch`;
					}
				} catch {
					// unreadable brief → guard is advisory, never blocks the run
				}
			}

			// Canonical differs: reconcile the manifest record so audit/teardown and
			// report collection use the canonical name + report path. Also records the
			// session JSONL path (when the transport exposed one) and the resolved
			// effective budget — the manifest entry is the budget governor's accounting
			// source (DESIGN.md §14).
			{
				const canonicalReportPath = reportPathFor(manifestDir, canonical);
				try {
					await manifestStore.update(manifestDir, (m) => ({
						...m,
					workers: m.workers.map((w) =>
						w.name === params.name &&
						(w.placement.placementRef ?? w.placement.paneId) === (placement.placementRef ?? placement.paneId)
							? ({
									...w,
									name: canonical,
									reportPath: canonicalReportPath,
									...(sessionPath ? { sessionPath } : {}),
									budgetTokens: params.budgetTokens,
									maxContextPct: maxPct,
									// v1.5 (DESIGN.md §17): record the MERGED FRAGMENT (not just the
									// name chain) so collect failures can quote what the report was
									// held to. ManifestWorker declares the field (quality fix A7).
									...(resolvedSchema ? { reportSchemaFragment: resolvedSchema } : {}),
								})
								: w,
						),
					}));
					reportPath = canonicalReportPath;
					if (canonical !== params.name && !reportWitnesses.has(reportPath)) {
						// Canonical path was unknown at the pre-start snapshot (above);
						// take the embodiment witness now — the agent has started but the
						// brief prompt is not yet delivered, so this is still a pre-run
						// state (a stale report from an earlier run is captured as
						// existed+digest and can never false-settle THIS run).
						reportWitnesses.set(reportPath, witnessEmbodimentReport(await readReportOrNull(reportPath)));
					}
				} catch (err) {
					manifestWarning =
						`Manifest rename to canonical name failed (${errText(err)}) — audit/teardown still references "${params.name}".`;
				}
			}

			// From here on the worker exists: abort means DETACH, never kill.

			//
			// FUNCTION_CONTRACT:
			// Input: none (reads sessionPath + params from the closure)
			// Output: {line, details} — the gauge text suffix + machine details
			// Guarantees:
			//   - empty line when no session path is known (degraded, never fails)
			//   - warnings escalate at CONTEXT_CRITICAL_PCT / CONTEXT_WARN_PCT /
			//     CONTEXT_TURNS_WARN; UI notifications fire only when ctx.hasUI
			// Raises: never
			// EXTERNAL_DEPENDENCY: filesystem — the worker's pi session JSONL (via
			//   parseSessionUsage) for tokens/turns.
			// Terminal-result gauge accounting (DESIGN.md §20): the DUAL gauge line is
			// appended to every terminal result text — ctx% primary (pi's formula),
			// output-budget secondary (when set), turns tripwire — with escalation
			// warnings at the 80/90 context lines and over-output-budget notice.
			const gaugeSummary = (): { line: string; details: Record<string, unknown> } => {
				if (!sessionPath) return { line: "", details: {} };
				const usage: SessionUsage = parseSessionUsage(sessionPath);
				const pct = contextPct(usage, contextWindow);
				let line = `\n${formatGaugeLine(usage, contextWindow)}`;
				const details: Record<string, unknown> = {
					usage, contextWindow, maxPct, sessionPath,
					...(params.budgetTokens !== undefined ? { budget: params.budgetTokens } : {}),
				};
				if (pct !== null && pct >= CONTEXT_CRITICAL_PCT) {
					line += `\nCONTEXT CRITICAL ${pct}% — at ${maxPct}% this worker is refused on re-spawn; ` +
						"steer it to finish NOW or expect compaction-driven quality loss.";
					if (ctx.hasUI && ctx.ui) {
						ctx.ui.notify(`worker ${canonical} at ctx ${pct}% — compaction risk`, "warning");
					}
				} else if (pct !== null && pct >= CONTEXT_WARN_PCT) {
					line += `\nCONTEXT HIGH ${pct}% — the operator restart line; finish the worker or plan a fresh-name retry.`;
				}
				if (overOutputBudget(usage, params.budgetTokens)) {
					line += `\nOUTPUT BUDGET EXCEEDED (${usage.output} > ${params.budgetTokens}) — re-spawn will be refused (E_BUDGET).`;
					if (ctx.hasUI && ctx.ui) {
						ctx.ui.notify(`worker ${canonical} exceeded output budget (${usage.output})`, "warning");
					}
				}
				if (usage.turns > CONTEXT_TURNS_WARN) {
					line += `\nTURNS ${usage.turns} — above the ${CONTEXT_TURNS_WARN}-turn tripwire; check for research-loop thrash.`;
				}
				return { line, details };
			};

			const detach = (): ToolResult => {
				const b = gaugeSummary();
				return textResult(
					`Detached — worker ${canonical} keeps running; the watcher wakes you on its events (§21), ` +
					`delegate_status recovers it on demand. End your turn instead of sleeping.` +
						`${uniquified ? ` ${uniquified}` : ""}` +
						`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}` +
						`${ownerWarning ? ` Warning: ${ownerWarning}` : ""}` +
						b.line,
					{
						detached: true,
						canonical,
						requestedName: params.name,
						placement,
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...(ownerWarning ? { ownerWarning } : {}),
						...b.details,
					},
				);
			};

			//
			// FUNCTION_CONTRACT:
			// Input: none (closure: transport, manifestDir, ctx)
			// Output: resolves when the (skippable) nudge attempt is done
			// Guarantees:
			//   - fires only when zero workers are working/blocked; any failure
			//     (herdr unreachable) is swallowed — advisory only
			// Raises: never
			// Last-live-worker nudge (DESIGN.md §19.4): when no worker is live
			// (working/blocked) anymore after this collect, fire notifyFleetIdle with
			// the task manifest's worker count. Advisory — never affects outcomes.
			const maybeNotifyFleetIdle = async (): Promise<void> => {
				try {
					const statuses = await transport.listStatuses();
					const live = statuses.filter((s) => s.status === "working" || s.status === "blocked");
					if (live.length === 0) {
						notifyFleetIdle(ctx, manifestStore.read(manifestDir)?.workers.length ?? 1);
					}
				} catch {
					// advisory only — herdr unreachable → skip the nudge
				}
			};

			//
			// FUNCTION_CONTRACT:
			// Input: none (closure state)
			// Output: an advisory note line ("" when no teardown happened)
			// Guarantees:
			//   - skips probes and pending-question workers; audit lines to
			//     teardown.log before and after the attempt
			//   - failure returns a warning note — the collect result is untouched
			// Raises: never
			//
			// FUNCTION_CONTRACT:
			// Input: validated report; usedReportPath; settleStatus; extraNote prefix
			// Output: the terminal ok ToolResult (verdict line, artifacts, archive
			//   note, collectedAt stamp, auto-teardown note, gauge line, details)
			// Guarantees:
			//   - archives on EVERY valid collect (pass or fail verdict, best-effort)
			//   - stamps collectedAt into the manifest (best-effort; failure → warning)
			//   - fires the fleet-idle nudge and the advisory auto-teardown
			// Raises: never (all sub-steps are guarded)
			// Success result builder — shared by the normal path, the fallback-path
			// collect (fix: requested-name report) and the detached-after-settle path.
			// v1.12.1 lifecycle hygiene (DESIGN.md §22): after a VALID strict collect
			// (report delivered, collectedAt stamped) the worker is torn down
			// automatically — the pane/worktree has served its purpose. USER DECISIONS
			// locked: default ON (collect.teardownAfterCollect), grace 0, only on VALID
			// collect. Guards: SKIP for probes (no report expected; panes stay this
			// wave), SKIP when a mailbox question file exists (the worker is still in
			// a conversation). ADVISORY by contract (§21): every skip/failure is a
			// note line + audit entry — a teardown failure NEVER alters the collect
			// result (ok stays true, verdict/report untouched) and never throws past
			// the tool boundary.
			const teardownAfterCollect = async (): Promise<string> => {
				if (isProbe) return ""; // probes keep their panes this wave
				if (!resolveCollectConfig().teardownAfterCollect) return ""; // config off
				try {
					// A pending question means the worker is still in a conversation.
					if (readQuestion(questionPathFor(manifestDir, canonical))) return "";
				} catch {
					// unreadable mailbox state → treat as no question (advisory either way)
				}
				await logTeardownAudit(
					manifestDir,
					`plan: teardown worker=${canonical} kind=${placement.kind} workspace=${placement.workspaceId} pane=${placement.paneId} (auto-after-collect)`,
				);
				try {
					// Migration stage 1 (extensibility-defect 1): the close result says
					// whether the pane was ALREADY gone (structured field, no message
					// parsing) — the audit trail keeps the distinction without the
					// tool layer ever regexing "not found".
					const res = await transport.teardown({ name: canonical, placement, force: true });
					await logTeardownAudit(
						manifestDir,
						res?.alreadyGone
							? `done: teardown worker=${canonical} no-op (already gone) (auto-after-collect)`
							: `done: teardown worker=${canonical} ok (auto-after-collect)`,
					);
					return `Auto-teardown: worker ${canonical} torn down after collect (advisory — /delegate-teardown stays available).`;
				} catch (err) {
					await logTeardownAudit(
						manifestDir,
						`error: teardown worker=${canonical} failed: ${errText(err)} (auto-after-collect)`,
					);
					return `Warning: auto-teardown after collect failed (${errText(err)}) — collect unaffected; /delegate-teardown cleans it up.`;
				}
			};

			const successResult = async (
				report: WorkerReport,
				usedReportPath: string,
				settleStatus: AgentStatusName,
				extraNote: string,
			): Promise<ToolResult> => {
				const elapsedMs = Date.now() - startedAtDate.getTime();
				const placementDesc =
					placement.kind === "worktree"
						? `worktree, branch ${placement.branch ?? branch}`
						: "tab (shared checkout)";
				const verdictLine =
					report.status === "pass"
						? `Report OK: status=pass — ${report.summary}`
						: `Report OK: status=fail (honest failure — the worker ran and reported) — ${report.summary}`;
				const b = gaugeSummary();
				// Archive on successful collect — pass OR fail verdict (DESIGN.md §19.3).
				// Best-effort by contract: null/throw → warning line, never an error.
				let archivePath: string | null = null;
				try {
					const manifest = manifestStore.read(manifestDir);
					if (manifest) {
						archivePath = archiveReport(manifestDir, usedReportPath, manifest as unknown as Record<string, unknown>);
					}
				} catch {
					archivePath = null;
				}
				const archiveNote = archivePath ? `\nArchived: ${archivePath}` : "\n(archive unavailable)";
				// BUG_FIX_CONTEXT: symptom — every fresh orchestrator session re-waked
				// on an already-collected report. Why the old state did not work: the
				// watcher's `seen` dedup is session-scoped memory only. What was done:
				// collect stamps collectedAt (ISO) into the manifest worker; the watcher
				// silences report events for stamped workers (cross-session marker).
				// Field fix: leave the "report delivered" trace in the manifest — the
				// watcher reads collectedAt to stay silent about an already-collected
				// report (its `seen` dedup lives only inside a session, so a fresh
				// session would otherwise re-wake on old reports). Matched by canonical
				// name, with the pre-rename name as fallback (rename is best-effort
				// too). Best-effort by contract: a failure warns like the archive note,
				// never fails the collect.
				let collectedNote = "";
				try {
					// Migration stage 2 (audit step 6): the collectedAt stamp is now a
					// REDUCER TRANSITION (lifecycle.stampCollected) — an illegal stamp
					// (a closed entry) is refused instead of silently rewriting closed
					// history. Scope: entries with an embodiment identity only stamp for
					// THIS run's placement (a same-name retry must not re-stamp its
					// predecessor — BUG_FIX_CONTEXT: symptom — a same-name retry's
					// collect re-stamped the predecessor entry by name-only matching,
					// silencing watcher events for an embodiment whose report was never
					// delivered); legacy entries (no identity) keep the old name-only
					// behavior (fail-open, unchanged — NOT wake-ownership: this stamp
					// addresses which manifest entry the COLLECT write touches, not
					// which session the watcher wakes; the wake-side owner rules live
					// in src/watch-role.ts and are fail-closed since watcher stage A).
					const collectedAt = new Date().toISOString();
					await manifestStore.update(manifestDir, (m) => ({
						...m,
						workers: m.workers.map((w) => {
							if (w.name !== canonical && w.name !== params.name) return w;
							if (w.embodiment && w.embodiment.placementRef !== (placement.placementRef ?? placement.paneId)) {
								return w; // a different embodiment of the same name — not ours to stamp
							}
							const stamped = stampCollected(w, collectedAt);
							return stamped.ok ? stamped.entry : w;
						}),
					}));
					// F1: a collect is a manifest WRITER — stamp the recomputed usage
					// snapshot into the task section (durability copy; the session
					// files stay the source of truth). Best-effort, never throws.
					const snap = aggregateTaskUsage(manifestDir);
					if (snap) await persistTaskUsageSnapshot(manifestDir, snap);
				} catch (err) {
					collectedNote =
						`manifest collectedAt stamp failed (${errText(err)}) — a fresh session's watcher may re-wake on this report`;
				}
				const collectedStampNote = collectedNote ? `\nWarning: ${collectedNote}` : "";
				journal(pi, "collect", canonical, report.status, archivePath ?? undefined);
				// Last live worker settled → teardown nudge (DESIGN.md §19.4).
				void maybeNotifyFleetIdle();
				// v1.12.1: the collect is DONE here (report valid, collectedAt
				// stamped) — the auto-teardown below can only append an advisory
				// note, never change this result's verdict.
				const teardownNote = await teardownAfterCollect();
				const teardownNoteLine = teardownNote ? `\n${teardownNote}` : "";
				return textResult(
					`${extraNote}Worker ${canonical} finished in ${elapsedMs} ms (${placementDesc}).\n` +
						`${verdictLine}\n` +
						`Artifacts: ${report.artifacts.length > 0 ? report.artifacts.join(", ") : "(none)"}` +
						archiveNote +
						collectedStampNote +
						teardownNoteLine +
						`${uniquified ? `\n${uniquified}` : ""}` +
						`${manifestWarning ? `\nWarning: ${manifestWarning}` : ""}` +
						`${ownerWarning ? `\nWarning: ${ownerWarning}` : ""}` +
						`${tierWarning ? `\nWarning: ${tierWarning}` : ""}` +
						b.line,
					{
						canonical,
						requestedName: params.name,
						nameUniquified: canonical !== params.name,
						placement,
						branch: placement.branch,
						status: settleStatus,
						reportPath: usedReportPath,
						report,
						elapsedMs,
						startedAt: startedAtDate.toISOString(),
						...(archivePath ? { archivePath } : { archiveWarning: "archive unavailable" }),
						...(collectedNote ? { collectedAtWarning: collectedNote } : {}),
						...(teardownNote ? { teardownAfterCollect: teardownNote } : {}),
						...(tierWarning ? { tierWarning } : {}),
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...(ownerWarning ? { ownerWarning } : {}),
						...b.details,
					},
				);
			};

			//
			// FUNCTION_CONTRACT:
			// Input: none (closure: reportPath, canonical name, requested name, briefSchema)
			// Output: {verdict, usedPath, fallbackUsed} — verdict from
			//   validateReportAgainstSchema (base ∩ brief fragment, DESIGN.md §11)
			// Guarantees:
			//   - canonical-name report first; when names differ and the canonical
			//     path does not validate, the requested-name path is tried as fallback
			//   - the fragment applies on the first pass and every grace recheck alike
			// Raises: never (all failures come back as {ok:false})
			// Strict collect with the requested-name fallback: on collision herdr may
			// have renamed the agent AFTER the brief was written, so the worker may
			// have written report-<requested>.json instead of report-<canonical>.json.
			const collectReport = (): {
				verdict: { ok: true; report: WorkerReport } | { ok: false; error: string };
				usedPath: string;
				fallbackUsed: boolean;
			} => {
				// v1.2: base ∩ brief-fragment validation (DESIGN.md §11) — the declared
				// schema applies on the first pass and on every grace recheck alike.
				const verdict = validateReportAgainstSchema(reportPath, canonical, briefSchema);
				if (verdict.ok || canonical === params.name) {
					return { verdict, usedPath: reportPath, fallbackUsed: false };
				}
				const requestedReportPath = reportPathFor(manifestDir, params.name);
				const alt = validateReportAgainstSchema(requestedReportPath, canonical, briefSchema);
				if (alt.ok) {
					return { verdict: alt, usedPath: requestedReportPath, fallbackUsed: true };
				}
				return { verdict, usedPath: reportPath, fallbackUsed: false };
			};

			// BUG_FIX_CONTEXT: symptom — a passed smoke gate was lost to a generic
			// "Detached" when the orchestrator aborted after settle. Why the old
			// path did not work: it only looked for report files, which probes never
			// write. What was done: when the session JSONL shows ≥1 assistant turn,
			// return a final "probe OK (detached after settle)" result instead of
			// detaching silently.
			//
			// FUNCTION_CONTRACT:
			// Input: none (closure)
			// Output: a terminal "probe OK" ToolResult, or null (caller detaches)
			// Guarantees:
			//   - non-null only when isProbe AND the session has ≥1 assistant turn
			//   - states explicitly that probes write NO report file (final verdict)
			// Raises: never
			// EXTERNAL_DEPENDENCY: filesystem — the worker's pi session JSONL (turn
			//   count via parseSessionUsage).
			// v1.8 probe salvage: a probe has no report file, so the generic salvage
			// (collectReport) can never recover it. The smoke gate's verdict is the
			// worker's settled state — recoverable from the session JSONL: an
			// assistant message proves the smoke prompt was consumed and answered.
			// Null when not a probe or the reply can't be proven → caller detaches.
			const probeSalvage = (): ToolResult | null => {
				if (!isProbe) return null;
				if (!sessionPath || parseSessionUsage(sessionPath).turns === 0) return null;
				void maybeNotifyFleetIdle();
				return textResult(
					`probe OK (detached after settle) — smoke gate passed before the abort (agent ${canonical}, smoke reply in session). ` +
						"Probes write NO report file — this verdict is final; do not wait for or read report-<name>.json. " +
						"Run one probe before any ≥3 fan-out." +
						`${uniquified ? ` ${uniquified}` : ""}`,
					{
						probe: "pass",
						canonical,
						requestedName: params.name,
						placement,
						detached: true,
					},
				);
			};

			if (signal?.aborted) return detach();

			// 5. Brief (or probe smoke prompt): submit, no blind --wait.
			step(
				isProbe ? `Probing ${canonical} (smoke gate)…` : `Briefing ${canonical} (brief: ${briefPath})…`,
				{ phase: "prompt", canonical, briefPath, probe: isProbe },
			);
			try {
				await transport.submitPrompt({
					name: canonical,
					// v1.5: echo the resolved brief reportSchema fragment (§16–§17) so the
					// worker sees the exact schema its report is validated against at
					// settle. Null for probes / briefs without reportSchema → base-only.
					text: isProbe ? PROBE_PROMPT : briefPrompt(briefPath, canonical, briefSchema),
					timeoutMs: SUBMIT_TIMEOUT_MS,
				});
			} catch (err) {
				// Migration stage 1: typed code from the adapter passes through; the
				// positional E_PROMPT_STALLED is only the fallback.
				const code = typedCode(err, "E_PROMPT_STALLED");
				return fail(
					code,
					`${code} — prompt for ${canonical} was not accepted: ${errText(err)}\n` +
						"The worker pane may not be at a prompt; inspect via delegate_status, then answer or re-brief." +
						`${uniquified ? ` ${uniquified}` : ""}`,
					{ canonical, placement, stderr: errText(err) },
				);
			}
			// v1.9 (DESIGN.md §19.1c): current herdr builds do not expose the
			// worker's session path (agent get/start carry no agent_session) —
			// resolve it from pi's session storage so the aged-finish proof, the
			// dual gauges and probe salvage keep working. Best-effort: no candidate
			// → features degrade exactly as before, never fail.
			if (!sessionPath) {
				const guessed = resolvePiSessionCandidates(placement.checkoutPath, startedAtDate.getTime())[0];
				if (guessed) {
					sessionPath = guessed;
					try {
						await manifestStore.update(manifestDir, (m) => ({
							...m,
							workers: m.workers.map((w) => (w.name === canonical ? { ...w, sessionPath: guessed } : w)),
						}));
					} catch {
						// manifest is best-effort bookkeeping — proof/gauges already have the path
					}
				}
			}

			//
			// FUNCTION_CONTRACT:
			// Input: none (closure: reportWitnesses, reportPath, canonical/requested
			//   names, placement, sessionPath)
			// Output: true when THIS run provably finished — the canonical report
			//   file (or the requested-name fallback) OBSERVED against THIS
			//   embodiment's witness (appeared / rewritten since launch; lifecycle.
			//   reportWitnessProvesRun), else ≥1 assistant turn in the worker's
			//   session JSONL
			// Guarantees:
			//   - ownership of the report belongs to THIS embodiment via its
			//     witness (content-addressed), never via file-mtime/wall-clock
			//     comparison — a stale report of an earlier same-name run can
			//     never false-settle, and this run's own report cannot be missed
			//     by a timestamp race
			//   - may lazily resolve sessionPath as a side effect (pi-storage fallback)
			// Raises: never
			// EXTERNAL_DEPENDENCY: filesystem — report files under the exchange dir;
			//   the worker's pi session JSONL (via parseSessionUsage /
			//   resolvePiSessionCandidates — pi's own session storage layout).
			// Completion proof for the settle watch (§19.1c): the report file for
			// THIS run is the completion criterion per the tool contract; the
			// session reply is the backup proof for probes and report-less
			// finishes. herdr builds that never report working for pi workers
			// otherwise spin the whole budget against a finished worker.
			const settleProof = async (): Promise<boolean> => {
				if (!isProbe) {
					// canonical-name path first, requested-name fallback (same order as
					// collectReport): the file proves THIS run when it differs from the
					// witness snapshot taken at launch.
					const paths = canonical !== params.name
						? [reportPath, reportPathFor(manifestDir, params.name)]
						: [reportPath];
					for (const p of paths) {
						const w = reportWitnesses.get(p);
						if (w && reportWitnessProvesRun(w, await readReportOrNull(p))) return true;
					}
				}
				// Session-reply proof (probes have no report file). Assumes a fresh
				// session per worker (the default): pre-existing turns would prove an
				// earlier session, not this prompt.
				const sp = sessionPath
					?? resolvePiSessionCandidates(placement.checkoutPath, startedAtDate.getTime())[0];
				if (sp) sessionPath = sp;
				return sp ? parseSessionUsage(sp).turns > 0 : false;
			};

			if (signal?.aborted) {
				// Abort between prompt submission and settle — the smoke/task reply may
				// already be in the session: salvage it before falling back to detach.
				const salvaged = probeSalvage();
				if (salvaged) return salvaged;
				return detach();
			}

			// 6. Settle observation: abort cancels the wait, never the worker.
			// v1.8 heartbeat: onPoll fires per slice; throttle to one step per ~10s
			// so a long blocking wait visibly shows worker liveness instead of
			// silence (the #1 trigger for operators killing a healthy wait).
			// v1.9b: each beat carries the live dual gauge (ctx% ↑in ↓out) and
			// budget progress parsed from the worker's session JSONL — the wait is
			// an observable burn-down, not a black box. The misleading
			// "(prompt not yet observed consumed)" prose was dropped: on herdr
			// builds that never report working for pi workers (§19.1c) it rendered
			// on every beat and read as an error.
			// Budget shown against the call's cap, else the §14 default — DISPLAY
			// only; enforcement (overOutputBudget) still requires explicit budgetTokens.
			const beatBudget = params.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
			step(`Waiting for ${canonical} to settle (timeout ${timeoutMs} ms)…`, {
				phase: "wait",
				canonical,
				timeoutMs,
			});
			let lastBeat = 0;
			// v1.9b (§20.2): a mailbox question must interrupt the wait IMMEDIATELY —
			// a worker that asks and then keeps "working" (poll loop / sleep while
			// waiting for the answer) never settles, and the question check used to
			// run only post-settle, burning the whole wait budget (field: 1500 s).
			// BUG_FIX_CONTEXT: symptom — a blocked-on-question worker burned the full
			// settle window before its question surfaced. Why the old flow did not
			// work: the question check ran only post-settle, and a polling worker
			// never settles. What was done: an internal AbortController aborts the
			// WAIT (never the worker) the moment a question file appears; the flow
			// then routes to AWAITING_ANSWER.
			const settleAbort = new AbortController();
			const onExternalAbort = () => settleAbort.abort();
			if (signal) {
				if (signal.aborted) settleAbort.abort();
				else signal.addEventListener("abort", onExternalAbort, { once: true });
			}
			let questionDetected = false;
			const checkMailboxQuestion = (): boolean => {
				if (questionDetected) return true;
				try {
					const q = readQuestion(questionPathFor(manifestDir, canonical));
					if (q) {
						questionDetected = true;
						settleAbort.abort();
						return true;
					}
				} catch {
					/* advisory — a failed read never interrupts the wait */
				}
				return false;
			};
			const onPoll = (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => {
				if (checkMailboxQuestion()) return;
				const now = Date.now();
				if (now - lastBeat < 10_000) return;
				lastBeat = now;
				// Lazy session-path resolution: on herdr builds without agent_session
				// the pi-storage fallback may only succeed once the file exists.
				if (!sessionPath) {
					sessionPath = resolvePiSessionCandidates(placement.checkoutPath, startedAtDate.getTime())[0];
				}
				let gaugeSegment = "";
				let gaugeDetails: Record<string, unknown> = {};
				if (sessionPath) {
					const usage = parseSessionUsage(sessionPath);
					gaugeSegment = ` · ${formatGaugeLine(usage, contextWindow)}`;
					const budgetLine = formatBudgetLine(usage, beatBudget);
					if (budgetLine) gaugeSegment += ` · ${budgetLine}`;
					gaugeDetails = {
						usage,
						contextWindow,
						budget: beatBudget,
						budgetSource: params.budgetTokens !== undefined ? "call" : "default",
					};
				}
				step(
					`waiting for ${canonical}: status=${info.status}${gaugeSegment}` +
						` (${Math.round(info.elapsedMs / 1000)}s / ${Math.round(timeoutMs / 1000)}s)` +
						" — Esc detaches safely, the worker survives",
					{ phase: "wait-heartbeat", canonical, ...info, ...gaugeDetails },
				);
			};
			let settle;
			try {
				settle = await transport.waitSettle({ name: canonical, timeoutMs, signal: settleAbort.signal, onPoll, proofSettled: settleProof, releaseOnStarted });
			} catch (err) {
				if (signal?.aborted) return detach();
				const b = gaugeSummary();
				// Migration stage 1: typed code from the adapter passes through; the
				// positional E_TIMEOUT is only the fallback.
				const code = typedCode(err, "E_TIMEOUT");
				return fail(
					code,
					`${code} — settle observation for ${canonical} failed: ${errText(err)}\n` +
						"Status unknown (worker may have exited or the host is unreachable) — the watcher reports " +
						"worker-dead if it truly died; check delegate_status, never repeat delegate." +
						b.line,
					{
						canonical,
						placement,
						...b.details,
					},
				);
			}

			const elapsedMs = Date.now() - startedAtDate.getTime();

			if (signal?.aborted) {
				// Detached after settle — do not discard a valid result if one exists.
				const collected = collectReport();
				if (collected.verdict.ok) {
					return successResult(
						collected.verdict.report,
						collected.usedPath,
						settle.status,
						"(detached after settle) ",
					);
				}
				// v1.8 probe salvage: probes write no report file, so before v1.8 a
				// passed smoke gate was lost to a generic Detached. If the smoke reply
				// already happened (assistant message in the session JSONL), the probe
				// verdict survives the abort.
				const salvaged = probeSalvage();
				if (salvaged) return salvaged;
				return detach();
			}

			// v1.14 early release (watch.releaseOn=started): the worker is proven
			// started and actively working — the §21 discipline applies now, not
			// at timeout: end the turn, the watcher wakes you on its events.
			if (settle.kind === "started-confirmed") {
				const b = gaugeSummary();
				return textResult(
					`Worker ${canonical} started and running — orchestrator released early (releaseOn=started, ${Math.round(elapsedMs / 1000)}s). ` +
						"END YOUR TURN — the watcher wakes you on report-ready / mailbox-question / grill-deck / " +
						"context-critical / worker-dead. No bash sleep, no repeat delegate call; " +
						"delegate_status polling stays valid." +
						`${uniquified ? ` ${uniquified}` : ""}` +
						`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}` +
						b.line,
					{
						released: true,
						startedConfirmed: true,
						canonical,
						requestedName: params.name,
						placement,
						reportPath,
						elapsedMs,
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...b.details,
					},
				);
			}

			// --- Probe flow: no report validation; pane status is the verdict.
			if (isProbe) {
				// Honest-settle v1.6 (DESIGN.md §19.1, R6 blocker fix): a never-started
				// probe is probe FAIL — never let the pane status produce a spurious
				// 'probe OK' (the original spurious-pass bug half-survived here).
				if (settle.kind === "never-started") {
					void maybeNotifyFleetIdle();
					return fail(
						"E_START",
						`probe FAIL — worker never started (prompt never consumed) for ${canonical}; ` +
							"inspect the pane via a pane read (readPane); do NOT fan out. Probes write no report file." +
							`${uniquified ? ` ${uniquified}` : ""}` +
							`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
						{ probe: "fail", canonical, placement, settleKind: settle.kind, elapsedMs },
					);
				}
				let live: AgentStatusName = "unknown";
				try {
					live = (await transport.getStatus(canonical))?.status ?? "unknown";
				} catch {
					live = "unknown";
				}
				// v1.8.x: verdict from STREAMING (pane readback) — did the worker actually
				// reply "OUTPUT: OK"? Status alone (idle/done) is necessary, not sufficient.
				const reminder =
					"Probe is optional — a real worker's first structured failure (E_PLACE/E_START/E_NAME) is just as cheap a smoke signal.";
				let paneText: string | undefined;
				const readPane = (transport as { readPane?: (name: string, opts?: { maxChars?: number }) => Promise<string> })
					.readPane;
				if (typeof readPane === "function") {
					try {
						paneText = await readPane(canonical, { maxChars: 4000 });
					} catch {
						paneText = undefined; // pane readback unavailable → status-based fallback
					}
				}
				const markerSeen = typeof paneText === "string" && /OUTPUT:\s*OK/i.test(paneText);
				if (markerSeen) {
					void maybeNotifyFleetIdle();
					return textResult(
						`probe OK — smoke reply verified in worker output ("OUTPUT: OK", agent ${canonical}, status ${live}). ` +
							"Probes write NO report file — this verdict is final; do not wait for or read report-<name>.json. " +
							"Probe is optional: skip it when the environment is already trusted. " +
							`${uniquified ? ` ${uniquified}` : ""}` +
							`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
						{
							probe: "pass",
							canonical,
							requestedName: params.name,
							placement,
							status: live,
							verified: "pane-marker",
							elapsedMs,
							...(manifestWarning ? { warning: manifestWarning } : {}),
						},
					);
				}
				const paneEvidence =
					typeof paneText === "string" && paneText.trim().length > 0
						? ` Pane tail: …${paneText.trim().slice(-300)}`
						: " Pane readback unavailable — verdict from status only.";
				void maybeNotifyFleetIdle();
				if (live === "idle" || live === "done") {
					return fail(
						"E_START",
						`probe FAIL — agent ${canonical} ${live} but the smoke reply "OUTPUT: OK" was not found in its output.${paneEvidence} ` +
							"Fix before fanning out. Probes write no report file. " +
							`${reminder}${uniquified ? ` ${uniquified}` : ""}` +
							`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
						{ probe: "fail", canonical, placement, status: live, verified: "pane-marker-missing", timedOut: settle.kind === "timeout", elapsedMs },
					);
				}
				return fail(
					"E_START",
					`probe FAIL — agent ${canonical} status ${live}` +
						`${settle.kind === "timeout" ? " (settle timed out)" : ""}: pane/agent did not reach a healthy state.${paneEvidence} ` +
						"Check pane readiness and model flags (provider/model/thinking); fix before fanning out. Probes write no report file. " +
						`${reminder}${uniquified ? ` ${uniquified}` : ""}` +
						`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
					{ probe: "fail", canonical, placement, status: live, timedOut: settle.kind === "timeout", elapsedMs },
				);
			}

			if (settle.kind === "timeout") {
				// v1.9b: a question pending even at timeout outranks E_TIMEOUT — the
				// orchestrator's next action is answering, not retrying.
				const timedOutQuestion = readQuestion(questionPathFor(manifestDir, canonical));
				if (timedOutQuestion) {
					questionDetected = true;
				} else {
				// E_TIMEOUT: not a spawn failure — the worker is simply still running
				// (or its state is unknown: it may have exited / herdr is unreachable).
				// v1.11 (§21): this text IS the discipline — end the turn, the watcher
				// owns the wait. Polling stays valid, bash sleep does not.
				const statusLine =
					settle.status === "unknown"
						? "status unknown — worker may have exited or the host is unreachable"
						: `status ${settle.status} — still running`;
				const b = gaugeSummary();
				return fail(
					"E_TIMEOUT",
					`E_TIMEOUT — worker ${canonical} did not settle within ${timeoutMs} ms (${statusLine}). Detached; it keeps running.\n` +
						"END YOUR TURN — the watcher wakes you on this worker's report-ready / mailbox-question / " +
						"grill-deck / context-critical / worker-dead event. No bash sleep, no repeat delegate call; " +
						"delegate_status polling stays valid. Bash sleep is a fallback ONLY when the watcher is " +
						"unavailable (old extension build)." +
						`${uniquified ? ` ${uniquified}` : ""}` +
						b.line,
					{
						timedOut: true,
						canonical,
						placement,
						reportPath,
						elapsedMs,
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...b.details,
					},
				);
				}
			}

			// Migration stage 2 (audit step 7): the loop below is the settle→collect
			// seam as an EXPLICIT state machine (runGraceLoop / graceTransition —
			// each transition takes the state and returns the next); the clock and
			// the recheck delay are the INJECTED port (systemClock here, virtual
			// clocks in test/grace-loop-check.ts). The priority ladder and every
			// note/abort semantics are preserved verbatim from the pre-extraction
			// inline loop (v1.9b review fix 2); behavior is pinned identical by the
			// three execute drivers (collect-teardown-driver, host-fake-check,
			// mailbox-check).
			const graceOutcome = await runGraceLoop({
				collect: collectReport,
				pendingQuestion: () => readQuestion(questionPathFor(manifestDir, canonical)),
				readProgressPing: () => readLastProgress(progressPathFor(manifestDir, canonical)),
				reportExists,
				isParseFailure,
				clock: systemClock,
				signal,
				maxRechecks: GRACE_RECHECKS,
				delayMs: GRACE_DELAY_MS,
				onRecheck: (attempt, missing, usedPath) => {
					step(
						`Report not readable yet (${missing ? "missing" : "mid-write"}) — recheck ${attempt}/${GRACE_RECHECKS} in ${GRACE_DELAY_MS / 1000}s…`,
						{ phase: "grace", canonical, attempt, reportPath: usedPath },
					);
				},
				onPing: (ping) => {
					try {
						const pctPart = typeof ping.pct === "number" ? ` ${ping.pct}%` : "";
						const notePart = ping.note ? ` — ${ping.note}` : "";
						step(`ping: ${ping.phase}${pctPart}${notePart}`, { phase: "ping", ping });
					} catch {
						// advisory only — never affects outcomes
					}
				},
			});

			if (graceOutcome.kind === "awaiting-answer") {
				const pendingQuestion = graceOutcome.question;
				const contextLine = pendingQuestion.context ? `\n(context: ${pendingQuestion.context})` : "";
				const optionsLine = `\nOptions: ${pendingQuestion.options?.length ? pendingQuestion.options.join(" | ") : "none"}`;
				return textResult(
					`AWAITING_ANSWER — worker ${canonical} is blocked on a question:\n` +
						`${pendingQuestion.question}${contextLine}${optionsLine}\n` +
						"Answer via the delegate_mailbox tool (action 'answer'); the worker will be nudged to continue." +
						`${uniquified ? ` ${uniquified}` : ""}`,
					{
						phase: "awaiting_answer",
						canonical,
						requestedName: params.name,
						question: pendingQuestion,
						placement,
						...(manifestWarning ? { warning: manifestWarning } : {}),
					},
				);
			}
			if (graceOutcome.kind === "aborted") {
				// Abort between grace iterations → existing detach semantics,
				// but do not discard a valid result if one landed.
				const abortedCollect = collectReport();
				if (abortedCollect.verdict.ok) {
					return successResult(
						abortedCollect.verdict.report,
						abortedCollect.usedPath,
						settle.status,
						"(detached after settle) ",
					);
				}
				// v1.8 probe salvage: probes write no report file, so before v1.8 a
				// passed smoke gate was lost to a generic Detached. If the smoke reply
				// already happened (assistant message in the session JSONL), the probe
				// verdict survives the abort.
				const salvaged = probeSalvage();
				if (salvaged) return salvaged;
				return detach();
			}
			const collected = graceOutcome.attempt;
			const graceAttempt = graceOutcome.graceAttempt;
			if (collected.verdict.ok) {
				const note =
					(collected.fallbackUsed
						? `Note: report collected from ${collected.usedPath} — the brief pointed the worker at the requested name while the host recorded the canonical one. `
						: "") +
					(graceAttempt > 0
						? `(report landed after settle — collected on grace recheck ${graceAttempt}/${GRACE_RECHECKS}) `
						: "");
				return successResult(collected.verdict.report, collected.usedPath, settle.status, note);
			}

			const missing = !(await reportExists(collected.usedPath));
			// Honest-settle v1.6 (DESIGN.md §19.1): never-started → the prompt was
			// never consumed and the worker never started — a distinct terminal code
			// instead of E_REPORT_MISSING. Migration stage 3 (audit step 8): the
			// outcome is the union KIND from the seam (the flag set is gone).
			const neverStarted = settle.kind === "never-started";
			const code = missing
				? neverStarted
					? "E_PROMPT_STALLED"
					: "E_REPORT_MISSING"
				: "E_REPORT_INVALID";
			const what = neverStarted && missing
				? "prompt never consumed — worker never started"
				: missing
					? `no report file at ${collected.usedPath} after settle (status: ${settle.status})`
					: `report at ${collected.usedPath} failed schema validation: ${collected.verdict.error}`;
			// v1.2 (DESIGN.md §11): distinguish a brief-reportSchema violation — base
			// schema passes but the declared fragment rejects. The fragment error is
			// already quoted verbatim in `what`; add dedicated guidance.
			let schemaNote = "";
			if (!missing) {
				const base = validateReport(collected.usedPath, canonical);
				if (base.ok) {
					schemaNote =
						"\nThis is a brief-reportSchema violation: the report violates the brief's reportSchema — " +
						"either the worker or the schema fragment is wrong; compare evidence, then fix the brief or re-brief.";
					// v1.5 (DESIGN.md §17): the audit trail answers "what schema was this
					// report held to" — quote the merged fragment (truncated) + provenance.
					if (resolvedSchema) {
						const fragmentJson = JSON.stringify(resolvedSchema);
						schemaNote +=
							`\nschema held: ${fragmentJson.length > 300 ? `${fragmentJson.slice(0, 300)}…` : fragmentJson}`;
					}
					if (schemaProvenance.length > 0) {
						schemaNote += `\nschema provenance: ${schemaProvenance.join(" → ")}`;
					}
				}
			}
			const b = gaugeSummary();
			// A settle (even a failed one) that empties the fleet still fires the
			// teardown nudge (DESIGN.md §19.4).
			void maybeNotifyFleetIdle();
			return fail(
				code,
				`${code} — worker ${canonical} settled but ${what}.\n` +
					"Treat as a failed spawn: do a diagnosed retry with root cause + fix shape (at most 2 repeats, then escalate). " +
					RETRY_MANDATE +
					" " +
					"Read the worker's pane before retrying to find the actual root cause." +
					schemaNote +
					`${uniquified ? ` ${uniquified}` : ""}` +
					b.line,
				{
					canonical,
					placement,
					reportPath: collected.usedPath,
					requestedReportPath: reportPathFor(manifestDir, params.name),
					reportError: collected.verdict.error,
					status: settle.status,
					...(neverStarted ? { neverStarted } : {}),
					elapsedMs,
					...(manifestWarning ? { warning: manifestWarning } : {}),
					...b.details,
				},
			);
		},
	});
}
