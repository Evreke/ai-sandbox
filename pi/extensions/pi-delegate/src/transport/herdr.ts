/**
 * pi-delegate — herdr transport (DESIGN.md §4.2, §4.3).
 *
 * Thin implementation of the `Transport` seam on top of the herdr CLI.
 * Every call shells out via `node:child_process.execFile` with array args —
 * never shell strings. All *mutating* herdr ops (place / start / prompt /
 * teardown) are serialized through one internal promise queue so two
 * concurrent delegate calls can never run a mutating herdr op in parallel
 * (DESIGN.md §9: parallel mutating ops hang the pane process group).
 *
 * herdr CLI convention (verified 2026-09-05): commands print a JSON line
 * `{"id":"...","result":{...}}` on stdout; we parse the last line and use
 * `.result`. Non-zero exit → typed DelegateError with the error-code mapping
 * from DESIGN.md §7.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type {
	AgentStatus,
	AgentStatusName,
	DelegateError,
	DelegateErrorCode,
	Placement,
	PlacementReq,
	PromptReq,
	SettleResult,
	StartReq,
	StartResult,
	TeardownReq,
	Transport,
	TransportCapabilities,
} from "./types.ts";

const execFileP = promisify(execFile);

/** Worktree checkout dir — sessions cwd'd under (or exactly at) it are sub-orchestrators. */
const WORKTREE_DIR = "/root/.herdr/worktrees";

/** Env var carrying the herdr workspace id of the current session's pane. */
const WORKSPACE_ID_ENV = "HERDR_WORKSPACE_ID";

/** Per-CLI-call timeout for mutating/fast commands (ms). */
const CLI_TIMEOUT_MS = 30_000;

/** Single `agent wait` iteration window (ms) — short, per clock-churn mitigation. */
const WAIT_SLICE_MS = 3_000;

/** Extra budget around a wait slice before we declare the CLI call itself hung. */
const WAIT_EXEC_BUDGET_MS = WAIT_SLICE_MS + 7_000;

/** Sleep between wait iterations (ms). */
const WAIT_SLEEP_MS = 1_000;

/** Statuses that count as "settled" for waitSettle(). */
const SETTLED: readonly AgentStatusName[] = ["idle", "done", "blocked"];

/** Statuses that count as "the agent actually started" for the start-up phase
 *  of waitSettle() (DESIGN.md §19.1): working/blocked/done. `done` also proves
 *  the prompt was consumed — a worker that starts AND finishes within one wait
 *  slice must NOT be misclassified neverStarted (R6 finding, live-reproduced
 *  by transport-contract T2.2e); done additionally means finished, so the
 *  settled phase is entered immediately. */
const STARTED: readonly AgentStatusName[] = ["working", "blocked", "done"];

/** v1.8 (DESIGN.md §19.1b): true when the session JSONL contains at least one
 *  assistant message — proof the prompt was consumed and the agent replied.
 *  Used to distinguish "idle because never started" from "idle because already
 *  finished" when a watcher attaches after herdr aged done→idle (observed
 *  aging: minutes). Tolerant: missing/unreadable/corrupt file → false, never
 *  throws. Exported for tests. */
export function sessionHasReply(sessionPath: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return false;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes('"assistant"')) continue; // cheap prefilter
		try {
			const e = JSON.parse(line) as { message?: { role?: unknown } };
			if (e.message?.role === "assistant") return true;
		} catch {
			// partial/corrupt line — skip
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DelegateErrorImpl extends Error implements DelegateError {
	readonly code: DelegateErrorCode;
	readonly guidance: string;
	override cause?: unknown;

	constructor(code: DelegateErrorCode, message: string, guidance: string, cause?: unknown) {
		super(message);
		this.name = "DelegateError";
		this.code = code;
		this.guidance = guidance;
		if (cause !== undefined) this.cause = cause;
	}
}

function delegateError(code: DelegateErrorCode, message: string, cause?: unknown): DelegateErrorImpl {
	return new DelegateErrorImpl(code, message, GUIDANCE[code], cause);
}

/** Guidance text per DESIGN.md §7 — embedded in every typed error. */
const GUIDANCE: Record<DelegateErrorCode, string> = {
	E_BRIEF: "Write the brief file first, then retry the delegate call.",
	E_NAME: "Use the returned canonical name.",
	E_PLACE:
		"Placement failed; herdr stderr is attached. Reconcile via `herdr workspace list` before retrying.",
	E_START: "Check pane readiness (pane must sit at an interactive shell prompt); retry is a new delegate call.",
	E_PROMPT_STALLED: "Worker pane not at prompt; inspect via delegate_status.",
	E_TIMEOUT: "Worker still running; poll delegate_status.",
	E_REPORT_MISSING: "Settled but no report file — treat as failed spawn; diagnosed retry is the orchestrator's move.",
	E_REPORT_INVALID: "Report exists but fails the JSON schema; attach validator output; treated identically to missing.",
	E_BUDGET:
		"Worker over output budget — pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
	E_CONTEXT:
		"Worker session near context-window compaction — start a NEW worker name; this session's next prompt would compact and lose the brief.",
};

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface HerdrRunResult {
	stdout: string;
	stderr: string;
}

async function runHerdr(args: string[], timeoutMs: number = CLI_TIMEOUT_MS): Promise<HerdrRunResult> {
	try {
		const { stdout, stderr } = await execFileP("herdr", args, {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
		});
		return { stdout, stderr };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
		const details = [e.stderr?.trim(), e.stdout?.trim(), e.message].filter(Boolean).join("\n");
		throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed\n${details}`.trim(), { cause: err });
	}
}

/**
 * Parse herdr stdout: take the last non-empty line, JSON.parse it, return
 * `.result`. Tolerant: non-JSON output resolves to `null` with the raw text
 * carried alongside so callers can attach it to errors.
 */
export function parseHerdrResult(stdout: string): { result: unknown; raw: string } {
	const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const last = lines[lines.length - 1] ?? "";
	try {
		const parsed = JSON.parse(last) as { result?: unknown };
		return { result: parsed.result !== undefined ? parsed.result : parsed, raw: stdout };
	} catch {
		return { result: null, raw: stdout };
	}
}

// ---------------------------------------------------------------------------
// Internal mutation queue — one mutating herdr op in flight at a time
// ---------------------------------------------------------------------------

function isSubOrchestratorCwd(): boolean {
	const cwd = process.cwd();
	// Directory-boundary compare: /root/.herdr/worktrees and anything under it is sub.
	return cwd === WORKTREE_DIR || cwd.startsWith(`${WORKTREE_DIR}/`);
}

export class HerdrTransport implements Transport {
	/** Tail of the serialized mutating-op chain. */
	private queueTail: Promise<unknown> = Promise.resolve();

	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.queueTail.then(op, op);
		// Keep the chain alive regardless of op outcome.
		this.queueTail = run.catch(() => undefined);
		return run;
	}

	capabilities(): TransportCapabilities {
		const authority = isSubOrchestratorCwd() ? "sub" : "root";
		return { worktrees: authority === "root", authority };
	}

	place(req: PlacementReq): Promise<Placement> {
		return this.enqueue(() => this.placeInner(req));
	}

	startAgent(req: StartReq): Promise<StartResult> {
		return this.enqueue(() => this.startAgentInner(req));
	}

	submitPrompt(req: PromptReq): Promise<void> {
		return this.enqueue(() => this.submitPromptInner(req));
	}

	teardown(req: TeardownReq): Promise<void> {
		return this.enqueue(() => this.teardownInner(req));
	}

	// -- Read-only ops: not queued -------------------------------------------------

	async getStatus(name: string): Promise<AgentStatus | null> {
		try {
			const { stdout } = await runHerdr(["agent", "get", name]);
			return agentStatusFromResult(parseHerdrResult(stdout).result, name);
		} catch (err) {
			if (isNotFound(err)) return null;
			throw new DelegateErrorImpl(
				"E_START",
				`herdr status query failed for ${name}: ${(err as Error).message}; worker may have exited`,
				"herdr status query failed for worker; worker may have exited — reconcile via `herdr agent list` before retrying.",
				err,
			);
		}
	}

	async listStatuses(): Promise<AgentStatus[]> {
		try {
			const { stdout } = await runHerdr(["agent", "list"]);
			const { result } = parseHerdrResult(stdout);
			const list = Array.isArray(result)
				? result
				: isRecord(result) && Array.isArray(result.agents)
					? result.agents
					: [];
			return list.filter(isRecord).map((a) => agentStatusFromResult(a, String(a.name ?? "")));
		} catch (err) {
			throw new DelegateErrorImpl(
				"E_START",
				`herdr status query failed for agent list: ${(err as Error).message}; worker statuses unavailable`,
				"herdr status query failed; worker statuses unavailable — reconcile via `herdr agent list`.",
				err,
			);
		}
	}

	async waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
	}): Promise<SettleResult> {
		// D3 (DESIGN.md §19.1) — two-phase state machine against the
		// settle-before-start race: the first `agent wait --until idle…` slice can
		// match BEFORE the prompt is consumed (agent still idle) → instant false
		// settle (supervip_epic: six fan-out workers all "settled idle" at the same
		// second, then worked for hours).
		//
		// Phase START-UP (before the first working/blocked/done observation): only
		// those prove the prompt was consumed; idle/unknown slices keep polling. If
		// the whole timeoutMs elapses without ever observing one of them →
		// {status:"unknown", timedOut:true, neverStarted:true}.
		// Phase SETTLED (after the first such observation): current behavior —
		// idle/done/blocked settle; slices + reconcile; abort → detach.
		//
		// v1.8 (DESIGN.md §19.1b) — the aged-finish blind spot (live-reproduced):
		// herdr ages done→idle within minutes, so a watcher that attaches late —
		// fast flash probes, abort/detach recovery, slow start — can NEVER observe
		// working/done and spins the FULL timeout against a visibly finished
		// worker, then false-reports neverStarted. Disambiguation: an unexplained
		// idle is checked against the session JSONL — an assistant reply proves the
		// prompt was consumed → settle as finishedBeforeWatch (success, not
		// failure). No reply → genuinely never started → keep polling.
		const startedAt = Date.now();
		const deadline = startedAt + req.timeoutMs;
		let last: AgentStatusName = "unknown";
		let started = false;
		let sessionPath: string | undefined;
		while (Date.now() < deadline) {
			if (req.signal?.aborted) {
				// Abort detaches the wait, never the worker (DESIGN.md §5.1).
				const s = await this.getStatus(req.name).catch(() => null);
				return { status: s?.status ?? last, timedOut: false };
			}
			let status: AgentStatusName | undefined;
			try {
				const { stdout } = await runHerdr(
					["agent", "wait", req.name, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(WAIT_SLICE_MS)],
					WAIT_EXEC_BUDGET_MS,
				);
				const { result } = parseHerdrResult(stdout);
				status = statusFromResult(result);
			} catch {
				// Slice timed out or CLI hiccup — reconcile via a direct status read.
			}
			if (!status) {
				const s = await this.getStatus(req.name).catch(() => null);
				status = s?.status;
			}
			if (status) last = status;
			if (status && STARTED.includes(status)) started = true;
			// v1.8: unexplained idle — prove life from the session before declaring
			// the wait unstartable. Only reached while started is still false, so the
			// normal flow never pays for the extra `agent get` + file read.
			if (!started && status === "idle") {
				if (sessionPath === undefined) {
					sessionPath = await this.resolveSessionPath(req.name).catch(() => undefined);
				}
				if (sessionPath && sessionHasReply(sessionPath)) {
					req.onPoll?.({ status: "idle", started: true, elapsedMs: Date.now() - startedAt });
					return { status: "idle", timedOut: false, finishedBeforeWatch: true };
				}
			}
			req.onPoll?.({ status: status ?? "unknown", started, elapsedMs: Date.now() - startedAt });
			if (started && status && SETTLED.includes(status)) return { status, timedOut: false };
			await sleep(WAIT_SLEEP_MS);
		}
		if (!started) {
			// Never observed working/blocked/done since submission — the prompt was
			// likely never consumed; a settle here would be the false-settle bug.
			// (v1.8: an already-finished worker was ruled out above by the session
			// reply proof, so neverStarted here is honest.)
			return { status: "unknown", timedOut: true, neverStarted: true };
		}
		return { status: last, timedOut: true };
	}

	/** v1.8: resolve the agent's session JSONL path from `herdr agent get`
	 *  (result.agent.agent_session.value). Undefined when herdr doesn't expose
	 *  it — callers then fall back to the pre-v1.8 behavior. */
	private async resolveSessionPath(name: string): Promise<string | undefined> {
		const { stdout } = await runHerdr(["agent", "get", name]);
		const { result } = parseHerdrResult(stdout);
		return isRecord(result) ? asString(pick(result, "agent.agent_session.value", "agent_session.value")) : undefined;
	}

	// -- Mutating op bodies (run serialized via enqueue) ----------------------------

	private async placeInner(req: PlacementReq): Promise<Placement> {
		const { authority } = this.capabilities();

		if (req.mode === "worktree") {
			if (authority !== "root") {
				throw delegateError(
					"E_PLACE",
					"Worktree placement rejected: this session is a sub-orchestrator (cwd under /root/.herdr/worktrees/).",
				);
			}
			const args = [
				"worktree", "create",
				"--cwd", req.repoPath,
				"--branch", req.branch,
				"--label", req.label,
				"--no-focus",
			];
			if (req.base) args.push("--base", req.base);
			try {
				const { stdout } = await runHerdr(args);
				return placementFromWorktreeResult(parseHerdrResult(stdout).result, req, stdout);
			} catch (err) {
				throw delegateError(
					"E_PLACE",
					`herdr worktree create failed: ${(err as Error).message}`,
					err,
				);
			}
		}

		// mode === "tab": open a tab in the CURRENT session workspace.
		const workspaceId = process.env[WORKSPACE_ID_ENV];
		if (!workspaceId) {
			throw delegateError(
				"E_PLACE",
				`Tab placement requires a current herdr workspace: set ${WORKSPACE_ID_ENV} in the session environment (tabs are opened on the session's own workspace).`,
			);
		}
		try {
			const { stdout } = await runHerdr(["tab", "create", "--workspace", workspaceId, "--label", req.label]);
			return placementFromTabResult(parseHerdrResult(stdout).result, workspaceId, stdout);
		} catch (err) {
			throw delegateError(
				"E_PLACE",
				`herdr tab create failed: ${(err as Error).message}`,
				err,
			);
		}
	}

	private async startAgentInner(req: StartReq): Promise<StartResult> {
		const args = [
			"agent", "start", req.name,
			"--kind", "pi",
			"--pane", req.paneId,
			"--timeout", String(req.timeoutMs),
			"--",
			"--provider", req.provider,
			"--model", req.model,
			"--thinking", req.thinking,
			...(req.extraArgs ?? []),
		];
		try {
			const { stdout } = await runHerdr(args);
			const { result } = parseHerdrResult(stdout);
			return {
				name: extractAgentName(result, req.name),
				sessionPath: isRecord(result) ? asString(pick(result, "agent.agent_session.value")) : undefined,
			};
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// This herdr build does NOT auto-uniquify: a live colliding name is a
			// rejection (agent_name_taken) listing candidate names. D4 (DESIGN.md
			// §19.2): a second failure shape surfaces the same fact as plain text —
			// "…<name>: name taken by a live agent (candidates: …)" — map BOTH to
			// E_NAME with the same candidate-list guidance (case-insensitive).
			if (/agent_name_taken/i.test(msg) || /name taken by a live agent/i.test(msg)) {
				const candidates = /candidat\w*\s*[:=]?\s*([^\n]+)/i.exec(msg)?.[1]?.trim() ?? "unknown";
				throw new DelegateErrorImpl(
					"E_NAME",
					`herdr agent start ${req.name}: name taken by a live agent (candidates: ${candidates})`,
					`requested worker name is taken by a live agent — choose a different name (candidates: ${candidates})`,
					err,
				);
			}
			throw delegateError(
				"E_START",
				`herdr agent start ${req.name} failed: ${msg}`,
				err,
			);
		}
	}

	private async submitPromptInner(req: PromptReq): Promise<void> {
		try {
			// No --wait: submit and return fast; settle observation is waitSettle()'s job.
			await runHerdr(["agent", "prompt", req.name, req.text], req.timeoutMs);
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// herdr reports agent_prompt_stalled when no state change is observed
			// within 5s of submission from a non-working state — map explicitly.
			if (/agent_prompt_stalled/i.test(msg)) {
				throw delegateError(
					"E_PROMPT_STALLED",
					`herdr agent prompt ${req.name}: prompt stalled (no state change within 5s)`,
					err,
				);
			}
			if (/agent_blocked|blocked/i.test(msg)) {
				throw delegateError("E_PROMPT_STALLED", `herdr agent prompt ${req.name}: agent blocked`, err);
			}
			// Fallback: the 30s submit timeout itself → same stall code.
			throw delegateError("E_PROMPT_STALLED", `herdr agent prompt ${req.name} failed: ${msg}`, err);
		}
	}

	private async teardownInner(req: TeardownReq): Promise<void> {
		const p = req.placement as Placement & { tabId?: string };

		// Authority guard (mirrors placeInner): worktree teardown is root-only.
		// A sub-orchestrator enumerating globally-scanned manifests must never be
		// able to remove a root orchestrator's worktrees.
		if (req.placement.kind === "worktree" && this.capabilities().authority === "sub") {
			throw new DelegateErrorImpl(
				"E_PLACE",
				"Worktree teardown rejected: this session is a sub-orchestrator (cwd under /root/.herdr/worktrees/).",
				"sub-orchestrators cannot remove worktrees — worktree teardown is root-only; close your own tabs instead",
			);
		}

		if (req.placement.kind === "worktree") {
			const workspaceId = req.placement.workspaceId;
			try {
				const args = ["worktree", "remove", "--workspace", workspaceId];
				if (req.force !== false) args.push("--force");
				await runHerdr(args);
			} catch (err) {
				if (!/not_linked_worktree/i.test((err as Error).message)) {
					throw delegateError(
						"E_PLACE",
						`herdr worktree remove failed for workspace ${workspaceId}: ${(err as Error).message}`,
						err,
					);
				}
				// Orphaned/not-linked workspace — handled by the reconcile below.
			}
			// Reconcile (O2): removing the worktree while the worker agent is live
			// can leave a non-linked workspace shell that only `workspace close`
			// removes — verify against `workspace list`, close if still present,
			// and re-verify before reporting success.
			await this.closeWorkspaceIfPresent(workspaceId);
			return;
		}

		// kind === "tab"
		const tabId = p.tabId ?? req.placement.paneId;
		try {
			await runHerdr(["tab", "close", tabId]);
		} catch (err) {
			throw delegateError(
				"E_PLACE",
				`herdr tab close ${tabId} failed: ${(err as Error).message}`,
				err,
			);
		}
	}

	/** Reconcile a workspace that survived removal (any shape, incl. not_linked shells). */
	private async closeWorkspaceIfPresent(workspaceId: string): Promise<void> {
		if (!(await this.workspaceExists(workspaceId))) return;
		try {
			await runHerdr(["workspace", "close", workspaceId]);
		} catch (err) {
			throw delegateError(
				"E_PLACE",
				`herdr workspace close ${workspaceId} failed after worktree remove: ${(err as Error).message}`,
				err,
			);
		}
		if (await this.workspaceExists(workspaceId)) {
			throw delegateError(
				"E_PLACE",
				`workspace ${workspaceId} still present after herdr workspace close — reconcile via herdr workspace list`,
			);
		}
	}

	private async workspaceExists(workspaceId: string): Promise<boolean> {
		const { stdout } = await runHerdr(["workspace", "list"]);
		const { result } = parseHerdrResult(stdout);
		const list = Array.isArray(result)
			? result
			: isRecord(result) && Array.isArray(result.workspaces)
				? result.workspaces
				: [];
		return list.some(
			(w) => isRecord(w) && (w.workspace_id === workspaceId || w.id === workspaceId),
		);
	}
}

// ---------------------------------------------------------------------------
// Result mapping helpers
// ---------------------------------------------------------------------------

/** Placement enriched with the herdr tab id for teardown (transport-local extension). */
export type HerdrPlacement = Placement & { tabId?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isNotFound(err: unknown): boolean {
	return /not found|no such|unknown agent/i.test((err as Error).message ?? "");
}

function pick(root: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		const parts = key.split(".");
		let cur: unknown = root;
		let ok = true;
		for (const part of parts) {
			if (isRecord(cur) && part in cur) cur = cur[part];
			else { ok = false; break; }
		}
		if (ok && cur !== undefined && cur !== null) return cur;
	}
	return undefined;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function extractAgentName(result: unknown, fallback: string): string {
	if (isRecord(result)) {
		const name = asString(pick(result, "name", "agent.name", "agent_name"));
		if (name) return name;
	}
	return fallback;
}

function statusFromResult(result: unknown): AgentStatusName | undefined {
	return normalizeStatus(result);
}

/**
 * Single status normalizer for every herdr shape: `agent get`/`agent wait`
 * nest it at `agent.agent_status`, `agent list` entries carry top-level
 * `agent_status`, older shapes may use `status`.
 */
function normalizeStatus(node: unknown): AgentStatusName | undefined {
	if (!isRecord(node)) return undefined;
	const raw = asString(pick(node, "agent_status", "agent.agent_status", "status"));
	if (raw && ["idle", "working", "blocked", "done", "unknown"].includes(raw)) {
		return raw as AgentStatusName;
	}
	return undefined;
}

function agentStatusFromResult(result: unknown, fallbackName: string): AgentStatus {
	if (!isRecord(result)) return { name: fallbackName, status: "unknown" };
	return {
		status: statusFromResult(result) ?? "unknown",
		// `agent list` entries: agent_name when present; `agent get`: name under result.agent.
		name: asString(pick(result, "name", "agent.name", "agent_name")) ?? fallbackName,
		paneId: asString(pick(result, "pane_id", "paneId", "agent.pane_id", "pane.pane_id")),
		workspaceId: asString(pick(result, "workspace_id", "workspaceId", "agent.workspace_id", "workspace.workspace_id")),
	};
}

function placementFromWorktreeResult(
	result: unknown,
	req: PlacementReq,
	raw: string,
): Placement {
	if (!isRecord(result)) {
		throw delegateError("E_PLACE", `herdr worktree create returned unparseable output: ${truncate(raw)}`);
	}
	const workspaceId = asString(pick(result, "workspace.workspace_id", "workspace_id", "workspace.id"));
	const paneId = asString(pick(result, "root_pane.pane_id", "pane_id", "root_pane.id"));
	if (!workspaceId || !paneId) {
		throw delegateError(
			"E_PLACE",
			`herdr worktree create output missing workspace_id/pane_id: ${truncate(JSON.stringify(result))}`,
		);
	}
	const checkoutPath = asString(pick(result, "workspace.worktree.checkout_path", "checkout_path"))
		?? req.repoPath;
	return {
		kind: "worktree",
		workspaceId,
		paneId,
		branch: asString(pick(result, "workspace.worktree.branch", "branch")) ?? req.branch,
		checkoutPath,
		isLinkedWorktree: pick(result, "workspace.worktree.is_linked_worktree") === true,
	};
}

function placementFromTabResult(
	result: unknown,
	workspaceId: string,
	raw: string,
): HerdrPlacement {
	if (!isRecord(result)) {
		throw delegateError("E_PLACE", `herdr tab create returned unparseable output: ${truncate(raw)}`);
	}
	const paneId = asString(pick(result, "root_pane.pane_id", "pane_id", "root_pane.id"));
	const tabId = asString(pick(result, "tab.id", "tab_id", "tabId")) ?? paneId;
	if (!paneId) {
		throw delegateError(
			"E_PLACE",
			`herdr tab create output missing root pane id: ${truncate(JSON.stringify(result))}`,
		);
	}
	return {
		kind: "tab",
		workspaceId,
		paneId,
		checkoutPath: process.cwd(),
		tabId,
	};
}

function truncate(s: string, max = 400): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default transport instance for the extension entry point. */
export function createHerdrTransport(): Transport {
	return new HerdrTransport();
}
