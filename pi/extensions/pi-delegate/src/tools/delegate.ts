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
 * Dependency rule: imports transport/types.ts and exchange.ts only — never
 * transport/herdr.ts directly.
 */

import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	ensureExchangeDir,
	progressPathFor,
	questionPathFor,
	readLastProgress,
	readManifest,
	readQuestion,
	reportPathFor,
	resolveReportSchema,
	updateManifest,
	validateReport,
	validateReportAgainstSchema,
	type ManifestWorker,
} from "../exchange.ts";
import {
	contextPct,
	formatGaugeLine,
	overContext,
	overOutputBudget,
	parseSessionUsage,
	resolveContextWindow,
} from "../usage.ts";
import { archiveReport } from "../archive.ts";
import { notifyFleetIdle, renderDelegateLines } from "../ui/fleet-ui.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_TURNS_WARN,
	CONTEXT_WARN_PCT,
	WORKER_NAME_RE,
	briefPrompt,
	type AgentStatusName,
	type DelegateError,
	type Placement,
	type PlacementMode,
	type Transport,
	type SessionUsage,
	type WorkerReport,
} from "../transport/types.ts";

/** Interactive-readiness timeout for `agent start` (DESIGN.md §5.1 step 5). */
const START_TIMEOUT_MS = 120_000;
/** Max wait for prompt *submission* to be accepted (not for settle). */
const SUBMIT_TIMEOUT_MS = 30_000;
/** Default settle timeout for probe mode (short smoke gate). */
const PROBE_TIMEOUT_MS = 120_000;
/** Exchange dir for probe runs — no brief/task, but placements must stay
 *  teardown- and status-visible (scanAllManifests covers every manifest under
 *  /tmp/exchange). */
const PROBE_EXCHANGE_DIR = "/tmp/exchange/_probe";
/** Fixed probe prompt (DESIGN.md §5.1 step 4). */
const PROBE_PROMPT = "Reply with exactly: OUTPUT: OK";
/** Settle-vs-report race grace window: settle can fire before the report file
 *  hits the disk (or mid-turn idle blip), so a missing/unparseable report is
 *  re-checked up to GRACE_RECHECKS times, GRACE_DELAY_MS apart (~10 s worst
 *  case). A schema rejection over a readable file is stable — never retried. */
const GRACE_RECHECKS = 5;
const GRACE_DELAY_MS = 2_000;

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
};

const delegateParams = Type.Object({
	name: Type.String({ description: "Worker name; must match [a-z][a-z0-9_-]{0,31}" }),
	briefPath: Type.String({
		description:
			"Absolute or cwd-relative path to the brief file under /tmp/exchange/<task>/; a leading @ is stripped (ignored for probe)",
	}),
	mode: Type.Optional(StringEnum(["worktree", "tab", "probe"] as const, {
		description:
			"worktree = isolated checkout+branch (default); tab = shared checkout; probe = explicit smoke gate — run one probe before any ≥3 fan-out",
	})),
	repoPath: Type.Optional(Type.String({ description: "Repo to place the worker in (default session cwd)" })),
	branch: Type.Optional(Type.String({ description: "Worktree branch (default delegate/<name>)" })),
	base: Type.Optional(Type.String({ description: "Base ref for worktree placement (default HEAD)" })),
	provider: Type.Optional(Type.String({ description: "Agent provider (default llm-platform-alpha)" })),
	model: Type.Optional(Type.String({ description: "Agent model (default glm-5.3-flash)" })),
	thinking: Type.Optional(Type.String({ description: "Thinking level (default high)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Settle timeout in ms (default 900000; probe 120000)" })),
	budgetTokens: Type.Optional(Type.Number({ minimum: 1, description: "Optional OUTPUT-token cap (sum of assistant output); over-budget workers are refused on retry with E_BUDGET." })),
	maxContextPct: Type.Optional(Type.Number({ minimum: 10, maximum: 99, description: "Context-window %% refusal line (default 80 — the operator restart habit). Re-spawning a worker at/over this context %% is refused with E_CONTEXT." })),
	extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra args appended after --" })),
});

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asDelegateError(err: unknown): DelegateError | null {
	if (err instanceof Error && typeof (err as DelegateError).code === "string") {
		return err as DelegateError;
	}
	return null;
}

function fail(code: string, text: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: false, code, ...extra } };
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

async function reportExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** True when the file exists but JSON.parse still fails — a mid-write symptom
 *  worth re-checking. A missing file is not a parse failure (handled as
 *  E_REPORT_MISSING retry logic instead); a readable file is stable. */
async function isParseFailure(path: string): Promise<boolean> {
	try {
		JSON.parse(await readFile(path, "utf8"));
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
	}
}

/** Fleet journal (DESIGN.md §19.4): best-effort session entry, headless-safe.
 *  Guarded: only when appendEntry is available on the api object. */
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

export function registerDelegateTool(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Spawn one herdr worker (worktree or tab), brief it, block until it settles, and validate its JSON report. " +
			"mode 'probe' is the explicit smoke gate — run one probe before any ≥3 fan-out. " +
			"Esc detaches without killing the worker. Report status 'fail' still means the worker ran and reported honestly.",
		promptSnippet: "Spawn a herdr worker with a brief file and block until its report lands",
		promptGuidelines: [
			"Use delegate only after the brief file exists under /tmp/exchange/<task>/ — pass its path as briefPath; the brief is the worker's instructions and its OUTPUT section must point at report-<name>.json.",
			"delegate blocks until the worker settles; the worker's report file is the completion criterion, not the agent status — status fail in the report is still an honest completion.",
			"If delegate returns E_REPORT_MISSING or E_REPORT_INVALID, do a diagnosed retry with root cause + fix shape (at most 2 repeats, then escalate); never repeat verbatim.",
			"Run delegate once with mode 'probe' before any ≥3 fan-out — the probe is the smoke gate that catches dead panes and wrong model flags cheaply.",
		],
		parameters: delegateParams,
		renderCall(args, theme: Theme) {
			const name = typeof args?.name === "string" ? args.name : "?";
			const mode = typeof args?.mode === "string" ? args.mode : "worktree";
			const head = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("muted", mode);
			return {
				render: () => [`${head} ${theme.fg("accent", name)}`],
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme: Theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate", resultText, theme);
			return { render: () => lines, invalidate: () => {} };
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const step = (text: string, details: Record<string, unknown>) => {
				onUpdate?.({ content: [{ type: "text", text }], details });
			};
			const startedAtDate = new Date();
			const isProbe = params.mode === "probe";
			const timeoutMs = params.timeoutMs ?? (isProbe ? PROBE_TIMEOUT_MS : 900_000);
			const provider = params.provider ?? "llm-platform-alpha";
			const model = params.model ?? "glm-5.3-flash";
			const thinking = params.thinking ?? "high";
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
						"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name herdr returns when retrying.",
				);
			}

			let exchangeDir: string | null = null;
			if (!isProbe) {
				try {
					exchangeDir = ensureExchangeDir(briefPath).dir;
				} catch (err) {
					const de = asDelegateError(err);
					const guidance =
						de?.guidance ?? "Write the brief file under /tmp/exchange/<task>/ first, then call delegate again.";
					return fail("E_BRIEF", `E_BRIEF — ${errText(err)}\n${guidance}`, {
						briefPath,
						name: params.name,
					});
				}
			}
			const manifestDir = exchangeDir ?? PROBE_EXCHANGE_DIR;

			// Dual-gauge governor (DESIGN.md §20): refuse to re-spawn a worker whose
			// recorded session tripped EITHER gauge — context % (primary, pi's own
			// formula) or output budget (secondary, when set).
			const maxPct = params.maxContextPct ?? CONTEXT_WARN_PCT;
			const contextWindow = resolveContextWindow(params.model);
			const priorWorker = readManifest(manifestDir)?.workers.find(
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
					// Two-tier schema library (DESIGN.md §16): project-local
					// <cwd>/.pi/delegate-schemas/ searched FIRST, user-level second.
					resolved = resolveReportSchema(briefPath, resolve(ctx.cwd, ".pi", "delegate-schemas"));
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
				return fail(
					"E_PLACE",
					`E_PLACE — ${mode} placement failed for ${params.name}: ${errText(err)}\n` +
						"Reconcile via `herdr workspace list`, then retry with a fresh delegate call.",
					{ name: params.name, mode, stderr: errText(err) },
				);
			}

			// 3. Record the worker in the manifest IMMEDIATELY after place() and
			//    BEFORE startAgent: if the start fails, the placement is still real
			//    and /delegate-teardown must be able to clean it up.
			let reportPath = reportPathFor(manifestDir, params.name);
			let manifestWarning = "";
			try {
				// v1.5 (DESIGN.md §17): record the resolved-schema provenance as a plain
				// JSON manifest key — ManifestWorker now declares the field (quality fix
				// A7), so the entry type-checks without a cast.
				const manifestEntry: ManifestWorker = {
					name: params.name,
					placement,
					briefPath,
					reportPath,
					provider,
					model,
					thinking,
					startedAt: startedAtDate.toISOString(),
					schemaProvenance,
				};
				await updateManifest(manifestDir, (m) => ({
					...m,
					workers: [...m.workers, manifestEntry],
				}));
			} catch (err) {
				manifestWarning = `Manifest update failed (${errText(err)}) — teardown/audit for this placement is degraded; record it manually.`;
			}

			// 4. Start the agent; read back the canonical name.
			step(`Starting agent in pane ${placement.paneId} (provider=${provider}, model=${model}, thinking=${thinking})…`, {
				phase: "start",
				name: params.name,
				paneId: placement.paneId,
			});
			let start;
			try {
				start = await transport.startAgent({
					name: params.name,
					paneId: placement.paneId,
					provider,
					model,
					thinking,
					extraArgs: params.extraArgs,
					timeoutMs: START_TIMEOUT_MS,
				});
			} catch (err) {
				return fail(
					"E_START",
					`E_START — agent start failed for ${params.name}: ${errText(err)}\n` +
						"Check pane readiness; a retry is a new delegate call. " +
						(manifestWarning
							? `Placement NOT tracked in manifest (${manifestWarning}) — clean it up manually via \`herdr workspace list\`.`
							: "Placement tracked in manifest — run /delegate-teardown to clean up."),
					{ name: params.name, placement, stderr: errText(err) },
				);
			}
			const canonical = start.name;
			// Budget accounting source (DESIGN.md §14): the worker's session JSONL
			// path, captured by the transport from the herdr agent start result
			// (result.agent.agent_session.value) and recorded in the manifest below.
			const sessionPath = start.sessionPath;
			const uniquified = canonical !== params.name
				? `Note: herdr uniquified the requested name "${params.name}" → "${canonical}".`
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
						const ok = declared === "frontier" ? /frontier/i.test(model) : /flash|glm/i.test(model);
						if (!ok) tierWarning = `brief declares ${declared} tier but worker runs ${model} — tier mismatch`;
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
					await updateManifest(manifestDir, (m) => ({
						...m,
						workers: m.workers.map((w) =>
							w.name === params.name && w.placement.paneId === placement.paneId
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
				} catch (err) {
					manifestWarning =
						`Manifest rename to canonical name failed (${errText(err)}) — audit/teardown still references "${params.name}".`;
				}
			}

			// From here on the worker exists: abort means DETACH, never kill.

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
					`Detached — worker ${canonical} keeps running; recover via delegate_status.` +
						`${uniquified ? ` ${uniquified}` : ""}` +
						`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}` +
						b.line,
					{
						detached: true,
						canonical,
						requestedName: params.name,
						placement,
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...b.details,
					},
				);
			};

			// Last-live-worker nudge (DESIGN.md §19.4): when no worker is live
			// (working/blocked) anymore after this collect, fire notifyFleetIdle with
			// the task manifest's worker count. Advisory — never affects outcomes.
			const maybeNotifyFleetIdle = async (): Promise<void> => {
				try {
					const statuses = await transport.listStatuses();
					const live = statuses.filter((s) => s.status === "working" || s.status === "blocked");
					if (live.length === 0) {
						notifyFleetIdle(ctx, readManifest(manifestDir)?.workers.length ?? 1);
					}
				} catch {
					// advisory only — herdr unreachable → skip the nudge
				}
			};

			// Success result builder — shared by the normal path, the fallback-path
			// collect (fix: requested-name report) and the detached-after-settle path.
			const successResult = (
				report: WorkerReport,
				usedReportPath: string,
				settleStatus: AgentStatusName,
				extraNote: string,
			): ToolResult => {
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
					const manifest = readManifest(manifestDir);
					if (manifest) {
						archivePath = archiveReport(manifestDir, usedReportPath, manifest as unknown as Record<string, unknown>);
					}
				} catch {
					archivePath = null;
				}
				const archiveNote = archivePath ? `\nArchived: ${archivePath}` : "\n(archive unavailable)";
				journal(pi, "collect", canonical, report.status, archivePath ?? undefined);
				// Last live worker settled → teardown nudge (DESIGN.md §19.4).
				void maybeNotifyFleetIdle();
				return textResult(
					`${extraNote}Worker ${canonical} finished in ${elapsedMs} ms (${placementDesc}).\n` +
						`${verdictLine}\n` +
						`Artifacts: ${report.artifacts.length > 0 ? report.artifacts.join(", ") : "(none)"}` +
						archiveNote +
						`${uniquified ? `\n${uniquified}` : ""}` +
						`${manifestWarning ? `\nWarning: ${manifestWarning}` : ""}` +
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
						...(tierWarning ? { tierWarning } : {}),
						...(manifestWarning ? { warning: manifestWarning } : {}),
						...b.details,
					},
				);
			};

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

			if (signal?.aborted) return detach();

			// 5. Brief (or probe smoke prompt): submit, no blind --wait.
			step(
				isProbe ? `Probing ${canonical} (smoke gate)…` : `Briefing ${canonical} (brief: ${briefPath})…`,
				{ phase: "prompt", canonical, briefPath, probe: isProbe },
			);
			try {
				await transport.submitPrompt({
					name: canonical,
					text: isProbe ? PROBE_PROMPT : briefPrompt(briefPath, canonical),
					timeoutMs: SUBMIT_TIMEOUT_MS,
				});
			} catch (err) {
				return fail(
					"E_PROMPT_STALLED",
					`E_PROMPT_STALLED — prompt for ${canonical} was not accepted: ${errText(err)}\n` +
						"The worker pane may not be at a prompt; inspect via delegate_status, then answer or re-brief." +
						`${uniquified ? ` ${uniquified}` : ""}`,
					{ canonical, placement, stderr: errText(err) },
				);
			}
			if (signal?.aborted) return detach();

			// 6. Settle observation: abort cancels the wait, never the worker.
			step(`Waiting for ${canonical} to settle (timeout ${timeoutMs} ms)…`, {
				phase: "wait",
				canonical,
				timeoutMs,
			});
			let settle;
			try {
				settle = await transport.waitSettle({ name: canonical, timeoutMs, signal });
			} catch (err) {
				if (signal?.aborted) return detach();
				const b = gaugeSummary();
				return fail(
					"E_TIMEOUT",
					`E_TIMEOUT — settle observation for ${canonical} failed: ${errText(err)}\n` +
						"Status unknown (worker may have exited or herdr is unreachable) — poll delegate_status " +
						"instead of repeating delegate." +
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
				// Detached after settle — do not discard a valid report if one exists.
				const collected = collectReport();
				if (collected.verdict.ok) {
					return successResult(
						collected.verdict.report,
						collected.usedPath,
						settle.status,
						"(detached after settle) ",
					);
				}
				return detach();
			}

			// --- Probe flow: no report validation; pane status is the verdict.
			if (isProbe) {
				// Honest-settle v1.6 (DESIGN.md §19.1, R6 blocker fix): a never-started
				// probe is probe FAIL — never let the pane status produce a spurious
				// 'probe OK' (the original spurious-pass bug half-survived here).
				if ((settle as { neverStarted?: boolean }).neverStarted === true) {
					void maybeNotifyFleetIdle();
					return fail(
						"E_START",
						`probe FAIL — worker never started (prompt never consumed) for ${canonical}; ` +
							"inspect via herdr agent read; do NOT fan out." +
							`${uniquified ? ` ${uniquified}` : ""}` +
							`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
						{ probe: "fail", canonical, placement, neverStarted: true, elapsedMs },
					);
				}
				let live: AgentStatusName = "unknown";
				try {
					live = (await transport.getStatus(canonical))?.status ?? "unknown";
				} catch {
					live = "unknown";
				}
				const reminder = "Run one probe before any ≥3 fan-out.";
				if (live === "idle" || live === "done") {
					void maybeNotifyFleetIdle();
					return textResult(
						`probe OK — safe to fan out (agent ${canonical}, status ${live}). ${reminder}` +
							`${uniquified ? ` ${uniquified}` : ""}` +
							`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
						{
							probe: "pass",
							canonical,
							requestedName: params.name,
							placement,
							status: live,
							elapsedMs,
							...(manifestWarning ? { warning: manifestWarning } : {}),
						},
					);
				}
				void maybeNotifyFleetIdle();
				return fail(
					"E_START",
					`probe FAIL — agent ${canonical} status ${live}` +
						`${settle.timedOut ? " (settle timed out)" : ""}: pane/agent did not reach a healthy state. ` +
						"Check pane readiness and model flags (provider/model/thinking); fix before fanning out. " +
						`${reminder}${uniquified ? ` ${uniquified}` : ""}` +
						`${manifestWarning ? ` Warning: ${manifestWarning}` : ""}`,
					{ probe: "fail", canonical, placement, status: live, timedOut: settle.timedOut, elapsedMs },
				);
			}

			if (settle.timedOut) {
				// E_TIMEOUT: not a spawn failure — the worker is simply still running
				// (or its state is unknown: it may have exited / herdr is unreachable).
				const statusLine =
					settle.status === "unknown"
						? `status unknown (worker may have exited or herdr is unreachable) — poll delegate_status`
						: `status ${settle.status} — the worker is still running — poll delegate_status`;
				const b = gaugeSummary();
				return fail(
					"E_TIMEOUT",
					`E_TIMEOUT — worker ${canonical} did not settle within ${timeoutMs} ms (${statusLine}).\n` +
						`Poll delegate_status instead of repeating delegate; Esc already detached cleanly.${uniquified ? ` ${uniquified}` : ""}` +
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

			// 7. Post-settle completion — ONE unified grace loop covering both the
			// settle-vs-report race and the settle-vs-question race (review fix 2,
			// demo run 1: a q-file written just before idle used to lose the race and
			// surface as E_REPORT_MISSING). Each pass, in order:
			//   1. collectReport() valid → success result (existing notes);
			//   2. pending question (q-<name>.json) → structured AWAITING_ANSWER
			//      result, NOT a failure (DESIGN.md §12) — the orchestrator answers
			//      via delegate_mailbox and the worker gets nudged to continue;
			//   3. retryable report state (missing/mid-write JSON) → wait and loop;
			// after the window expires, fall through to terminal handling below.
			// A schema rejection over a readable file is stable and is NOT retried;
			// the question check never fires after a timed-out settle (the timedOut
			// branch above already returned).
			let collected = collectReport();
			let graceAttempt = 0;
			while (graceAttempt < GRACE_RECHECKS && !collected.verdict.ok) {
				const pendingQuestion = readQuestion(questionPathFor(manifestDir, canonical));
				if (pendingQuestion) {
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
				// v1.5 (DESIGN.md §18): advisory progress ping — when the worker has
				// appended to p-<name>.jsonl, stream the latest ping via onUpdate so long
				// workers become observable without opening panes. Advisory only: read
				// failures are swallowed and never affect outcomes.
				try {
					const ping = readLastProgress(progressPathFor(manifestDir, canonical));
					if (ping) {
						const pctPart = typeof ping.pct === "number" ? ` ${ping.pct}%` : "";
						const notePart = ping.note ? ` — ${ping.note}` : "";
						step(`ping: ${ping.phase}${pctPart}${notePart}`, { phase: "ping", ping });
					}
				} catch {
					// advisory only — never affects outcomes
				}
				const missing = !(await reportExists(collected.usedPath));
				const retryable = missing || (await isParseFailure(collected.usedPath));
				if (!retryable) break;
				graceAttempt++;
				step(
					`Report not readable yet (${missing ? "missing" : "mid-write"}) — recheck ${graceAttempt}/${GRACE_RECHECKS} in ${GRACE_DELAY_MS / 1000}s…`,
					{ phase: "grace", canonical, attempt: graceAttempt, reportPath: collected.usedPath },
				);
				await sleep(GRACE_DELAY_MS, signal);
				if (signal?.aborted) {
					// Abort between grace iterations → existing detach semantics,
					// but do not discard a valid report if one landed.
					const abortedCollect = collectReport();
					if (abortedCollect.verdict.ok) {
						return successResult(
							abortedCollect.verdict.report,
							abortedCollect.usedPath,
							settle.status,
							"(detached after settle) ",
						);
					}
					return detach();
				}
				collected = collectReport();
			}
			if (collected.verdict.ok) {
				const note =
					(collected.fallbackUsed
						? `Note: report collected from ${collected.usedPath} — the brief pointed the worker at the requested name while herdr recorded the canonical one. `
						: "") +
					(graceAttempt > 0
						? `(report landed after settle — collected on grace recheck ${graceAttempt}/${GRACE_RECHECKS}) `
						: "");
				return successResult(collected.verdict.report, collected.usedPath, settle.status, note);
			}

			const missing = !(await reportExists(collected.usedPath));
			// Honest-settle v1.6 (DESIGN.md §19.1): neverStarted → the prompt was
			// never consumed and the worker never started — a distinct terminal code
			// instead of E_REPORT_MISSING. Field is pre-approved on SettleResult;
			// read defensively until A6's transport change lands in this tree.
			const neverStarted = (settle as { neverStarted?: boolean }).neverStarted === true;
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
					"Read the worker's pane via herdr before retrying to find the actual root cause." +
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
