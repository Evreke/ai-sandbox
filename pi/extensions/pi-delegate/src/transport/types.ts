/**
 * pi-delegate — transport seam and shared contracts.
 *
 * OWNERSHIP: this file is authored by the tech lead and is the review artifact
 * for the whole extension. Implementation workers must NOT edit it; they code
 * against it. If a contract here is wrong, escalate to the orchestrator —
 * do not patch around it locally.
 *
 * Dependency rule: tools/ and commands.ts may import transport/types.ts and
 * exchange.ts only. They must NEVER import transport/herdr.ts directly.
 */

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** How a worker is isolated. `worktree` = own checkout+branch; `tab` = shared checkout. */
export type PlacementMode = "worktree" | "tab";

/** Root orchestrators may create/remove worktrees; sub-orchestrators (cwd under
 *  ~/.herdr/worktrees/) may only open tabs in their own workspace. */
export type AuthorityMode = "root" | "sub";

export interface PlacementReq {
	mode: PlacementMode;
	/** Repo the worktree/tab is based on. Absolute path. */
	repoPath: string;
	/** Branch name for worktree placement. Ignored for tab. */
	branch: string;
	/** Human label for the tab/workspace. */
	label: string;
	/** Base ref for worktree placement (default HEAD). */
	base?: string;
}

export interface Placement {
	kind: PlacementMode;
	/** herdr workspace id (always present for worktree; present for tab). */
	workspaceId: string;
	/** Pane the agent will be started in. */
	paneId: string;
	/** Branch created (worktree mode only). */
	branch?: string;
	/** Absolute checkout path the agent will run in. */
	checkoutPath: string;
	/** True when herdr reported a linked worktree workspace. */
	isLinkedWorktree?: boolean;
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

export type AgentStatusName = "idle" | "working" | "blocked" | "done" | "unknown";

export interface StartReq {
	/** Requested worker name. herdr (observed 0.8.x) REJECTS collisions with
	 *  error `agent_name_taken` — implementations must map that to E_NAME with
	 *  candidate guidance; no auto-uniquification exists. Implementations MUST
	 *  still read back the effective name from the response. */
	name: string;
	paneId: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra args appended after `--` (e.g. ["--session", path]). */
	extraArgs?: string[];
	/** Interactive-readiness timeout in ms (skill: 60_000–180_000). */
	timeoutMs: number;
}

export interface StartResult {
	/** Canonical name as reported by herdr — use this, never the requested name. */
	name: string;
	/** Worker session JSONL path, when the transport can capture it (herdr:
	 *  result.agent.agent_session.value). Budget accounting uses this. */
	sessionPath?: string;
}

export interface PromptReq {
	name: string;
	text: string;
	/** Max ms to wait for the submission itself to be accepted (not for settle). */
	timeoutMs: number;
}

/** Outcome of a settle observation. NOT a completion criterion — report files are. */
export interface SettleResult {
	status: AgentStatusName;
	/** True when timeoutMs elapsed without the agent settling. */
	timedOut: boolean;
	/** D3 (DESIGN.md §19.1): true when timeoutMs elapsed WITHOUT the agent ever
	 *  being observed working/blocked since submission — the prompt was likely
	 *  never consumed. Never set when the agent settled normally. */
	neverStarted?: boolean;
}

export interface AgentStatus {
	name: string;
	status: AgentStatusName;
	paneId?: string;
	workspaceId?: string;
}

export interface TeardownReq {
	name: string;
	placement: Placement;
	/** Force worktree removal. */
	force?: boolean;
}

export interface TransportCapabilities {
	/** False in sub-orchestrator mode: place() must reject worktree requests. */
	worktrees: boolean;
	authority: AuthorityMode;
}

/**
 * The seam. Every herdr verb the tools need is reachable through these calls.
 * Implementations must serialize mutating operations internally (one mutating
 * herdr op in flight at a time) — see DESIGN.md §9.
 */
export interface Transport {
	place(req: PlacementReq): Promise<Placement>;
	startAgent(req: StartReq): Promise<StartResult>;
	/** Submit a prompt. Returns after submission is accepted, without waiting
	 *  for settle — settle observation is prompt()/waitSettle()'s job. */
	submitPrompt(req: PromptReq): Promise<void>;
	/** Poll/observe until the agent settles (idle|done|blocked) or timeout. */
	waitSettle(req: { name: string; timeoutMs: number; signal?: AbortSignal }): Promise<SettleResult>;
	getStatus(name: string): Promise<AgentStatus | null>;
	listStatuses(): Promise<AgentStatus[]>;
	teardown(req: TeardownReq): Promise<void>;
	capabilities(): TransportCapabilities;
}

// ---------------------------------------------------------------------------
// Error taxonomy (DESIGN.md §7) — tool results, never raw throws past the tool
// ---------------------------------------------------------------------------

export type DelegateErrorCode =
	| "E_BRIEF"
	| "E_NAME"
	| "E_PLACE"
	| "E_START"
	| "E_PROMPT_STALLED"
	| "E_TIMEOUT"
	| "E_REPORT_MISSING"
	| "E_REPORT_INVALID"
	| "E_BUDGET"
	| "E_CONTEXT";

export interface DelegateError extends Error {
	code: DelegateErrorCode;
	/** Guidance embedded for the orchestrator model (DESIGN.md §7 table). */
	guidance: string;
	cause?: unknown;
}

// ---------------------------------------------------------------------------
// Budget governor (DESIGN.md §14) — enforced, config defaults, per-session
// ---------------------------------------------------------------------------

export interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	/** Context size AS THE MODEL SAW IT at the last assistant response
	 *  (usage.totalTokens of the final assistant message) — pi's own
	 *  getContextUsage() basis. Null right after compaction / in old sessions. */
	lastTotalTokens: number | null;
}

/** Context-gauge thresholds (DESIGN.md §20) — the operator's restart line. */
export const CONTEXT_WARN_PCT = 80;
export const CONTEXT_CRITICAL_PCT = 90;
/** Turns tripwire: assistant-message count above which a session is warned. */
export const CONTEXT_TURNS_WARN = 40;

/** Model context windows (tokens) — pi model catalog values. */
export const CONTEXT_WINDOWS: Record<string, number> = {
	"glm-5.3-flash": 524_300,
};
export const DEFAULT_CONTEXT_WINDOW = 250_100;

/** Default when no config file and no per-call budgetTokens (skill: execution
 *  tier ≤ ~150k output... conservative total-token default; operators override). */
export const DEFAULT_BUDGET_TOKENS = 150_000;

/** Config file location: ~/.pi/agent/pi-delegate.config.json,
 *  shape {"defaults": {"budgetTokens": number}}. Missing/corrupt → fallback. */
export const BUDGET_CONFIG_PATH = ".pi/agent/pi-delegate.config.json";

/** Fraction of budget above which terminal results carry a burn warning. */
export const BUDGET_WARN_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Report contract (DESIGN.md §6) — strict, fixed schema
// ---------------------------------------------------------------------------

export interface ReportEvidence {
	claim: string;
	/** "path:line" reference. */
	file: string;
	note?: string;
}

export interface WorkerReport {
	worker: string;
	status: "pass" | "fail";
	summary: string;
	artifacts: string[];
	evidence: ReportEvidence[];
}

/** Name rules from the delegate skill: [a-z][a-z0-9_-]{0,31}, unique among live agents. */
export const WORKER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Fixed prompt template — the one line sent to the worker pane.
 *  Explicit tool-use instruction: flash-class models may otherwise treat
	 *  "reply with the file path" as the whole task and never read the brief.
	 *  Carries the canonical worker name so briefs can stay name-agnostic
	 *  (demo run 2: brief/manifest name mismatch caused a false collect miss).
	 *  v1.2: standing mailbox line — questions/answers are files, never panes. */
export function briefPrompt(briefPath: string, workerName: string): string {
	return `Use your read tool to read ${briefPath}, then carry out the task it describes exactly, including its OUTPUT section. Your assigned worker name is "${workerName}": wherever the brief names the worker or its report file, use "${workerName}" (and report-${workerName}.json) instead of any name written in the brief. If blocked on a decision the brief does not resolve, write your question to q-${workerName}.json next to the brief and go idle — an answer will appear at a-${workerName}.json; when the brief says steering is expected, poll that file between steps. When the task is complete, reply with only the file path.`;
}

// ---------------------------------------------------------------------------
// Mailbox envelopes (DESIGN.md §12) — file-based two-way channel
// ---------------------------------------------------------------------------

/** Worker → orchestrator question (q-<name>.json). */
export interface QuestionEnvelope {
	worker: string;
	/** ISO 8601 timestamp. */
	ts: string;
	question: string;
	context?: string;
	/** Optional concrete options the orchestrator can pick from. */
	options?: string[];
}

/** Orchestrator → worker answer/steering (a-<name>.json). */
export interface AnswerEnvelope {
	from: "orchestrator";
	ts: string;
	/** The answer text, or mid-run steering instruction. */
	answer: string;
}

/** Validate a question envelope read from the mailbox (lenient on context/options). */
export function isQuestionEnvelope(v: unknown): v is QuestionEnvelope {
	if (typeof v !== "object" || v === null) return false;
	const q = v as Record<string, unknown>;
	return typeof q.worker === "string" && typeof q.ts === "string" && typeof q.question === "string";
}

// ---------------------------------------------------------------------------
// Progress pings (DESIGN.md §18) — worker → orchestrator liveness events
// ---------------------------------------------------------------------------

/** One progress ping line in p-<name>.jsonl (append-only). */
export interface ProgressEvent {
	worker: string;
	/** ISO 8601 timestamp. */
	ts: string;
	/** Free-form phase label ("researching", "implementing", "verifying"…). */
	phase: string;
	/** Optional 0–100 completion estimate. */
	pct?: number;
	note?: string;
}

export function isProgressEvent(v: unknown): v is ProgressEvent {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p.worker === "string" &&
		typeof p.ts === "string" &&
		typeof p.phase === "string" &&
		(p.pct === undefined || typeof p.pct === "number") &&
		(p.note === undefined || typeof p.note === "string")
	);
}
