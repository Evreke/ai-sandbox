/**
 * pi-delegate — src/host.ts (WorkerHost seam, extracted from src/transport.ts).
 *
 * MODULE_CONTRACT — the backend-neutral worker-host seam: Transport interface +
 * req/result types, the E_* error taxonomy (incl. DelegateErrorImpl/GUIDANCE),
 * the report/mailbox envelope contracts and their guards, the worker-name rule,
 * briefPrompt, the budget/context gauge constants, and sessionHasReply (the
 * aged-finish session-JSONL proof — backend-neutral, see research note in
 * design-host-interface.md §1a).
 *
 * Dependencies: node builtins only (fs). Depends on NO other src/ module —
 * bottom of the import graph (the old src/transport.ts SECTION 1 + the
 * backend-neutral sessionHasReply/Errors blocks, byte-verbatim).
 *
 * The herdr IMPLEMENTATION lives in src/herdr/host.ts (SECTION 2 verbatim);
 * it is bound ONCE in index.ts (workerhost migration steps 5–6 — the old
 * src/transport.ts re-export shim is deleted). Tool modules (spawn/observe/
 * fleet) import the seam from ./host.ts and must NEVER import
 * ./herdr/host.ts directly (pinned by static-check T1.1/T1.1c /
 * watcher-check W1.1).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// SECTION 1 — src/transport/types.ts (verbatim, incl. its review header)
// ============================================================================

/**
 * pi-delegate — transport seam and shared contracts.
 *
 * OWNERSHIP: this file is authored by the tech lead and is the review artifact
 * for the whole extension. Implementation workers must NOT edit it; they code
 * against it. If a contract here is wrong, escalate to the orchestrator —
 * do not patch around it locally.
 *
 * Dependency rule: spawn.ts (tools) and index.ts (commands, absorbed in W5)
 * may import transport.ts and exchange.ts only. They must NEVER import the
 * herdr IMPLEMENTATION directly — createHerdrTransport is bound once in
 * index.ts (pinned by static-check T1.1/T1.1b).
 *
 * MODULE_CONTRACT (ZCS, ported from the bundle's types.ts header): pure
 * types, constants and tiny pure helpers — no I/O of its own. Critical
 * invariants: DelegateErrorCode is the FIXED E_* list (the transport maps
 * every herdr failure into exactly one of them — never raw throws past the
 * tool boundary); WorkerReport is the schema BOTH the delegate tool
 * (validateReport) and the watcher validate reports against — changing it
 * breaks both sides at once; Transport implementations must serialize
 * mutating ops internally (DESIGN.md §9); REPORT_EXAMPLE is the canonical
 * report shape embedded into every worker prompt; CONTEXT_WINDOWS mirrors
 * pi's model catalog values and must be kept in sync with it manually.
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
	/** Opaque placement reference — adapter-defined, unique per live placement
	 *  (workerhost inversion, design §2/§4: the adapter decodes its own ref;
	 *  the seam only ever does opaque equality matching). The fake synthesizes
	 *  "fake:<n>"; the herdr adapter "herdr:pane:<paneId>" and always writes
	 *  the legacy id fields ALONGSIDE it (version-skew rule, design §4:
	 *  never delete legacy fields while any 1.15.x cohort reads). */
	placementRef?: string;
	/** Backend that created this placement ("herdr" | "fake" | …). Written into
	 *  manifest records ALONGSIDE the legacy id fields (version-skew rule,
	 *  design §4: never delete legacy fields while any 1.15.x cohort reads). */
	backend?: string;
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
	/** Opaque placement reference from the Placement that place() returned —
	 *  the adapter decodes its own ref (workerhost inversion, design §3:
	 *  herdr pane ids never cross the seam). Callers pass
	 *  `placement.placementRef ?? placement.paneId` so a legacy placement
	 *  record (no ref) still works. */
	placementRef: string;
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
	/** v1.8 (DESIGN.md §19.1b): true when the agent was ALREADY finished when the
	 *  watcher attached (herdr ages done→idle within minutes, so a late watcher
	 *  can never observe working/done — and current builds never report working
	 *  for pi workers at all, §19.1c). Proven by the caller's completion proof
	 *  (proofSettled: report file newer than spawn) or by an assistant reply in
	 *  the session JSONL — the opposite of neverStarted, not a failure. */
	finishedBeforeWatch?: boolean;
	/** v1.14 (watch.releaseOn=started): the worker was observed working and the
	 *  wait released EARLY — the orchestrator is handed to the background watcher
	 *  instead of blocking the rest of the settle gate. Not a timeout, not a
	 *  failure: the spawn is proven healthy. */
	startedConfirmed?: boolean;
}

export interface AgentStatus {
	name: string;
	status: AgentStatusName;
	/** Opaque placement reference (workerhost inversion, design §3) — the
	 *  adapter's own ref for the agent's placement; the watcher/retire gate
	 *  proxies on this (with a legacy paneId fallback from the manifest
	 *  record, which stays outside the read model). Backend ids (paneId/
	 *  tabId/workspaceId) live ONLY in the adapter's own types. */
	placementRef?: string;
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
	waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		/** v1.8 heartbeat: called once per poll slice with the last observed state,
		 *  so a long blocking wait can stream liveness via onUpdate instead of
		 *  looking frozen. Throttling is the caller's job; never throws. */
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
		/** v1.9 (DESIGN.md §19.1c): caller-owned completion proof, polled in the
		 *  start-up phase on every slice whose observation cannot prove life
		 *  (idle/unknown/unresolved — herdr builds that never report working for
		 *  pi workers would otherwise spin the full budget against a finished
		 *  worker). True → settle {status:"idle", finishedBeforeWatch:true}.
		 *  Must be cheap, side-effect-free, and answer from evidence written
		 *  AFTER this spawn (report mtime ≥ spawn time / session reply), so a
		 *  stale artifact can never false-settle a fresh worker. Throws are
		 *  treated as false. */
		proofSettled?: () => Promise<boolean>;
		/** v1.14 (watch.releaseOn=started): release the wait as soon as the agent
		 *  is observed working — the orchestrator hands off to the background
		 *  watcher instead of blocking the rest of the settle gate. Never set for
		 *  probes (their full window IS the verdict). */
		releaseOnStarted?: boolean;
	}): Promise<SettleResult>;
	getStatus(name: string): Promise<AgentStatus | null>;
	/** Recent pane output for a worker (terminal snapshot, few hundred lines tail).
	 *  Optional: probe-verdict from streaming; implementations without pane
	 *  readback may reject — callers must fall back to status-based verdicts. */
	readPane?(name: string, opts?: { maxChars?: number }): Promise<string>;
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
	| "E_TIER"
	| "E_PLACE"
	| "E_START"
	| "E_PROMPT_STALLED"
	| "E_TIMEOUT"
	| "E_TEARDOWN"
	| "E_STATUS"
	| "E_REPORT_MISSING"
	| "E_REPORT_INVALID"
	| "E_BUDGET"
	| "E_CONTEXT";

/** Named worker tier from the config's `tiers` table (v1.9.2): a
 *  provider/model/thinking combination. Any key may be absent — unresolved
 *  keys fall through to the config's `defaults` section. There is NO built-in
 *  tier: environments without config fail fast with E_TIER. */
export interface SpawnTier {
	provider?: string;
	model?: string;
	thinking?: string;
}

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
 *  shape {"contextWindow": number, "defaults": {"tier": string,
 *  "budgetTokens": number, "provider": string, "model": string,
 *  "thinking": string}, "tiers": {"<name>": SpawnTier}}.
 *  Missing/corrupt → fallbacks (per key); an unconfigured environment has NO
 *  built-in worker tier — delegate refuses with E_TIER.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none (resolved once at module load from os.homedir())
 * Output: the ABSOLUTE config path — the single source every config reader
 *   takes the path from (usage.ts resolvers, observe.ts watch config,
 *   index.ts host binding). Was a dead relative suffix before — the six
 *   live readers each rebuilt the path by hand.
 * Guarantees:
 *   - homedir() is cached per process by bun (documented in test/usage-check.ts),
 *     so module-load resolution is equivalent to per-call resolution there;
 *     in node (production pi) the home cannot change mid-session either.
 * Raises: never */
export const BUDGET_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-delegate.config.json");

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

/** Canonical example report (DESIGN.md §6) — the single source of truth for the
 *  base report shape. Embedded into every worker prompt via briefPrompt. Since
 *  v1.2 a brief MAY carry a reportSchema fragment (DESIGN.md §16–§17); when
 *  present, briefPrompt echoes it on top of this base canon. "worker" is a
 *  placeholder; callers substitute the canonical name. Canon = minimum, not a
 *  whitelist: extra fields stay allowed. */
export const REPORT_EXAMPLE: WorkerReport = {
	worker: "<your assigned worker name>",
	status: "pass",
	summary: "one-paragraph outcome",
	artifacts: ["path/to/artifact"],
	evidence: [{ claim: "what was verified", file: "path/to/file.ts:42" }],
};

/**
 * Fixed prompt template — the one line sent to the worker pane.
 *  Explicit tool-use instruction: flash-class models may otherwise treat
	 *  "reply with the file path" as the whole task and never read the brief.
	 *  Carries the canonical worker name so briefs can stay name-agnostic
	 *  (demo run 2: brief/manifest name mismatch caused a false collect miss).
	 *  v1.2: standing mailbox line — questions/answers are files, never panes.
	 *  Report contract: required fields + canonical example (REPORT_EXAMPLE,
	 *  worker name substituted). Since v1.2 a brief MAY declare a reportSchema
	 *  fragment (DESIGN.md §16–§17); when the caller passes one, it is echoed
	 *  verbatim after the base contract so the worker sees the exact schema its
	 *  report will be validated against at settle. */
export function briefPrompt(briefPath: string, workerName: string, briefSchema?: Record<string, unknown> | null): string {
	const schemaEcho =
		briefSchema !== null && briefSchema !== undefined
			? ` Task-specific report schema (this brief declares reportSchema): on top of the base contract above, the report MUST also satisfy this JSON schema: ${JSON.stringify(briefSchema)}. Extra fields still allowed unless the fragment says otherwise.`
			: "";
	return `Use your read tool to read ${briefPath}, then carry out the task it describes exactly, including its OUTPUT section. Your assigned worker name is "${workerName}": wherever the brief names the worker or its report file, use "${workerName}" (and report-${workerName}.json) instead of any name written in the brief. If blocked on a decision the brief does not resolve, write your question to q-${workerName}.json next to the brief and go idle — an answer will appear at a-${workerName}.json; when the brief says steering is expected, poll that file between steps. When the task is complete, reply with only the file path. Report contract — this contract ALWAYS overrides the brief on report format/shape: if the brief's OUTPUT section specifies a different report shape, keep ALL required contract fields anyway and put the brief-specific data in extra fields. Required fields: "worker" must be exactly "${workerName}"; "status" strictly "pass" or "fail"; "summary" a non-empty string; "artifacts" an array of strings; "evidence" an array of objects, each with non-empty string "claim" and "file". Extra fields allowed. Canonical example (write the report as JSON in exactly this shape): ${JSON.stringify({ ...REPORT_EXAMPLE, worker: workerName })}.${schemaEcho}`;
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

/** v1.8 (DESIGN.md §19.1b): true when the session JSONL contains at least one
 *  assistant message — proof the prompt was consumed and the agent replied.
 *  Used to distinguish "idle because never started" from "idle because already
 *  finished" when a watcher attaches after herdr aged done→idle (observed
 *  aging: minutes). Tolerant: missing/unreadable/corrupt file → false, never
 *  throws. Exported for tests.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: sessionPath — the worker's pi session JSONL path
 * Output: true iff at least one line carries an assistant message
 * Guarantees:
 *   - scans line-by-line with a cheap `"assistant"` prefilter, so a large
 *     session costs one pass without JSON-parsing most lines
 *   - partial/corrupt lines are skipped; missing file → false
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the worker's session JSONL file written
 *   by pi (path supplied by the caller from herdr/pi session storage).
 */
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

/** Maps a failure into the E_* taxonomy with the §7 guidance attached.
 *  Exported for the backend adapters (src/herdr/host.ts) — was module-private
 *  in the merged src/transport.ts. */
export function delegateError(code: DelegateErrorCode, message: string, cause?: unknown): DelegateErrorImpl {
	return new DelegateErrorImpl(code, message, GUIDANCE[code], cause);
}

/** Guidance text per DESIGN.md §7 — embedded in every typed error. */
const GUIDANCE: Record<DelegateErrorCode, string> = {
	E_BRIEF: "Write the brief file first, then retry the delegate call.",
	E_NAME: "Use the returned canonical name.",
	E_TIER:
		"Add tiers/defaults to ~/.pi/agent/pi-delegate.config.json or pass provider/model/thinking explicitly on the delegate call.",
	E_PLACE:
		"Placement failed; backend stderr is attached. Reconcile via /delegate-teardown (or the host workspace listing) before retrying.",
	E_START: "Check pane readiness (pane must sit at an interactive shell prompt); retry is a new delegate call.",
	E_PROMPT_STALLED: "Worker pane not at prompt; inspect via delegate_status.",
	E_TIMEOUT: "Worker still running; poll delegate_status.",
	E_TEARDOWN:
		"Teardown (worktree remove / tab close / workspace reconcile) failed; backend stderr is attached — reconcile manually via /delegate-teardown or the host workspace listing, then retry the close.",
	E_STATUS:
		"Status read from the backend failed (worker may have exited or the backend is unreachable) — reconcile via the host's status listing before trusting any lifecycle decision.",
	E_REPORT_MISSING: "Settled but no report file — treat as failed spawn; diagnosed retry is the orchestrator's move.",
	E_REPORT_INVALID: "Report exists but fails the JSON schema; attach validator output; treated identically to missing.",
	E_BUDGET:
		"Worker over output budget — pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
	E_CONTEXT:
		"Worker session near context-window compaction — start a NEW worker name; this session's next prompt would compact and lose the brief.",
};
