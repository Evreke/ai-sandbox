/**
 * pi-delegate — src/herdr/host.ts (herdr implementation of the Transport seam).
 *
 * MODULE_CONTRACT — the single herdr backend adapter: HerdrTransport (CLI +
 * NDJSON socket), runHerdr/SIGKILL escalation, HerdrSocketClient (W3 read-only
 * path), result mappers, createHerdrTransport binding helper. Extracted from
 * src/transport.ts SECTION 2 byte-verbatim (workerhost seam split, PoC).
 *
 * Dependencies: node builtins (child_process, os, path, net) + the seam module
 * ../host.ts ONLY (no other src/ imports). Bound ONCE in index.ts (the
 * composition root — the sole sanctioned importer of this file; static-check
 * T1.1/T1.1c, watcher-check W1.1).
 *
 * Critical invariants carried over verbatim: serialized-mutations (one mutating
 * op in flight), settle-before-start-race-d3, aged-finish-blind-spot (via
 * sessionHasReply from ../host.ts), abort-detaches-never-kills,
 * worktree-authority (~/.herdr/worktrees root).
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect, type Socket } from "node:net";
import { isDirUnder } from "../expaths.ts";
import {
	type AgentStatus,
	type AgentStatusName,
	type AuthorityMode,
	delegateError,
	delegateErrorWithDetail,
	DelegateErrorImpl,
	type DelegateError,
	type DelegateErrorCode,
	type Placement,
	type PlacementMode,
	type PlacementReq,
	type PromptReq,
	sessionHasReply,
	type SettleResult,
	type StartReq,
	type StartResult,
	type TeardownReq,
	type TeardownResult,
	type Transport,
	type TransportCapabilities,
} from "../host.ts";

// ============================================================================
// SECTION 2 — src/transport/herdr.ts (verbatim, incl. its review header)
// ============================================================================

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


/** Worktree checkout dir — sessions cwd'd under (or exactly at) it are sub-orchestrators.
 *  Resolved at RUNTIME via os.homedir(): a hardcoded /root path breaks every
 *  non-root user (boundary checks below would never recognize their
 *  sub-orchestrator sessions). Matches DESIGN.md's documented `~/.herdr/worktrees/`. */
const WORKTREE_DIR = join(homedir(), ".herdr", "worktrees");

/** Env var carrying the herdr workspace id of the current session's pane. */
const WORKSPACE_ID_ENV = "HERDR_WORKSPACE_ID";

/** Per-CLI-call timeout for mutating/fast commands (ms). */
const CLI_TIMEOUT_MS = 30_000;

/** Single `agent wait` iteration window (ms) — short, per clock-churn mitigation. */
const WAIT_SLICE_MS = 3_000;

/** Extra budget around a wait slice before we declare the CLI call itself hung. */
const WAIT_EXEC_BUDGET_MS = WAIT_SLICE_MS + 7_000;

/** Grace between the timeout SIGTERM and the SIGKILL escalation (ms). A herdr
 *  build with a graceful-shutdown SIGTERM handler must not be able to turn the
 *  exec timeout into a permanently hung child + permanently hung promise. */
export const SIGKILL_GRACE_MS = 5_000;

/** Per-stream output cap mirroring node's execFile default maxBuffer. */
const EXEC_MAX_BUFFER = 1024 * 1024;

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

// ---------------------------------------------------------------------------
// placementRef codec (workerhost inversion, design §3/§4) — adapter-private.
// The ref format is herdr-internal; the seam only ever compares refs opaquely.
// ---------------------------------------------------------------------------

/** Synthesize the opaque placementRef for a herdr pane. Written into manifest
 *  records ALONGSIDE the legacy id fields (design §4: never delete legacy). */
function herdrRefFromPane(paneId: string): string {
	return `herdr:pane:${paneId}`;
}

/** herdrRefFromPane for possibly-absent ids: no pane id → undefined (no ref). */
function herdrRefOrNull(paneId: string | undefined): string | undefined {
	return paneId ? herdrRefFromPane(paneId) : undefined;
}

/** Decode a placementRef back to the herdr pane id. Accepts the current
 *  `herdr:pane:<paneId>` shape AND a raw pane id (legacy callers/tests that
 *  pass a bare id where a ref is expected) — anything else → undefined.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: ref — opaque placement reference (or legacy raw pane id)
 * Output: the herdr pane id, or undefined when the ref is not decodable
 * Guarantees: pure; never throws
 */
function paneFromHerdrRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const m = /^herdr:pane:(.+)$/.exec(ref);
	return m?.[1] || ref;
}



// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface HerdrRunResult {
	stdout: string;
	stderr: string;
}

/**
 * Run one `herdr <args>` CLI call with a hard time bound and SIGKILL escalation.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - args: herdr CLI argv (array — never shell strings)
 *   - timeoutMs: hard bound on the call (default CLI_TIMEOUT_MS = 30_000)
 * Output: { stdout, stderr } of a zero-exit run
 * Guarantees:
 *   - the promise ALWAYS settles: at timeoutMs the child gets SIGTERM (execFile
 *     parity), its stdio is destroyed (parity with node's exec timeout), and
 *     after a further SIGKILL_GRACE_MS it gets SIGKILL — so a herdr build with
 *     a graceful-shutdown SIGTERM handler cannot hang this promise forever
 *     (BUG_FIX_CONTEXT below). The promise rejects AT timeoutMs, not when the
 *     escalated kill lands.
 *   - failure shape preserved from the promisified-execFile implementation:
 *     the thrown error carries .killed/.signal/.code/.stdout/.stderr and its
 *     message carries stderr text — callers match error text (isNotFound,
 *     agent_name_taken, agent_prompt_stalled regexes) against it unchanged
 *   - the child is reaped even when it dies AFTER the rejection (external or
 *     escalated SIGKILL): the parent's loop reaps it via the still-open libuv
 *     process handle — no zombie while the loop is healthy
 * Raises:
 *   - Error (wrapped by callers) for non-zero exit, spawn failure (ENOENT),
 *     maxBuffer overrun, or timeout
 * EXTERNAL_DEPENDENCY: `herdr` CLI binary on PATH (resolved at spawn time).
 * <p>
 * BUG_FIX_CONTEXT (SIGKILL escalation, 2026-09-09 herdr incident follow-up):
 * symptom — the promisified execFile timeout sends SIGTERM only; a herdr build
 * with a graceful-shutdown SIGTERM handler survives it forever, the promise
 * NEVER settles (leak-probe sig.log; re-reproduced with a silent-trap stub:
 * pending past the 30s timeout mark), and via the serialized-mutations queue
 * in HerdrTransport every later mutating op (place/start/prompt/teardown)
 * stalls behind it while read-only ops and the event loop stay healthy
 * (h3-queue-stall repro). Why SIGTERM-only did not work: node's exec timeout
 * cannot recover a child that ignores SIGTERM, and D-state children would
 * ignore it too. What was done: kept the SIGTERM-at-timeout contract, then
 * escalated to SIGKILL after SIGKILL_GRACE_MS (armed at spawn, cleared on
 * close); the promise rejects at the timeout mark. Side-effect fix: the old
 * implementation RESOLVED ok-with-empty-stdout when the direct child had
 * already exited but a descendant kept the stdio pipes open (the timeout
 * "kill" hit a dead pid and node's close-on-timeout surfaced as success) —
 * the spawn-based escalation destroys stdio at timeout and rejects properly.
 * Exported for tests (transport-sigkill.ts drives it with stub CLIs).
 */
export async function runHerdr(args: string[], timeoutMs: number = CLI_TIMEOUT_MS): Promise<HerdrRunResult> {
	try {
		return await spawnHerdr(args, timeoutMs);
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
		const details = [e.stderr?.trim(), e.stdout?.trim(), e.message].filter(Boolean).join("\n");
		throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed\n${details}`.trim(), { cause: err });
	}
}

/** Exec-like error: parity with what promisified execFile used to throw so the
 *  runHerdr wrapper's detail-shaping (and callers' message regexes) keep working. */
function herdrSpawnError(args: string[], fields: { message: string; code?: unknown; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string }): Error {
	const err = new Error(fields.message) as Error & {
		code?: unknown; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string;
	};
	err.code = fields.code;
	err.killed = fields.killed ?? false;
	err.signal = fields.signal ?? null;
	err.stdout = fields.stdout ?? "";
	err.stderr = fields.stderr ?? "";
	return err;
}

function spawnHerdr(args: string[], timeoutMs: number): Promise<HerdrRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overBuffer: string | null = null;
		let settled = false;
		let sigkillTimer: NodeJS.Timeout | undefined;

		const clearEscalation = () => {
			if (sigkillTimer !== undefined) {
				clearTimeout(sigkillTimer);
				sigkillTimer = undefined;
			}
		};
		// SIGKILL escalation: armed whenever we demand shutdown (timeout or
		// maxBuffer); cleared on close. Fire-and-forget — the promise has already
		// rejected by the time it lands; this only makes sure the child dies.
		const armSigkill = () => {
			clearEscalation();
			sigkillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, SIGKILL_GRACE_MS);
			(sigkillTimer as unknown as { unref?: () => void }).unref?.();
		};

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (err) {
				reject(err);
			} else {
				resolve({ stdout, stderr });
			}
		};

		const failLike = (fields: Parameters<typeof herdrSpawnError>[1]) => {
			finish(herdrSpawnError(args, { ...fields, stdout, stderr }));
		};

		// Hard bound: SIGTERM (execFile parity) + stdio destruction (exec parity:
		// a trap handler writing to a destroyed pipe dies EPIPE instead of hanging)
		// + reject NOW (do not wait for the escalated kill to land), then arm SIGKILL.
		// The SIGKILL timer is NOT cleared here — it must survive the rejection;
		// it is cleared when the child actually closes (or fires on a dead pid,
		// which is a harmless no-op).
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			child.stdout?.destroy();
			child.stderr?.destroy();
			armSigkill();
			failLike({ message: `Command timed out after ${timeoutMs}ms: herdr ${args.join(" ")}`, killed: true, signal: "SIGTERM" });
		}, timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > EXEC_MAX_BUFFER && !overBuffer) {
				overBuffer = "stdout";
				child.kill("SIGTERM");
				child.stdout?.destroy();
				child.stderr?.destroy();
				armSigkill();
			}
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > EXEC_MAX_BUFFER && !overBuffer) {
				overBuffer = "stderr";
				child.kill("SIGTERM");
				child.stdout?.destroy();
				child.stderr?.destroy();
				armSigkill();
			}
		});

		// spawn failure (ENOENT: no herdr on PATH) — err carries .code
		child.on("error", (err) => {
			clearTimeout(timer);
			clearEscalation();
			finish(err as Error);
		});

		// 'close' = exited AND stdio settled — the execFile settlement point.
		child.on("close", (code, signal) => {
			// Runs even after a timeout/maxBuffer rejection: reap bookkeeping ends here.
			clearTimeout(timer);
			clearEscalation();
			if (overBuffer) {
				failLike({ message: `${overBuffer} maxBuffer length exceeded`, code: null, killed: true, signal });
				return;
			}
			if (code === 0) {
				finish();
				return;
			}
			failLike({ message: `Command failed: herdr ${args.join(" ")}\n${stderr}`, code, killed: false, signal });
		});
	});
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
	// EXTERNAL_DEPENDENCY: process.cwd() compared against the fixed herdr
	// worktree placement root (~/.herdr/worktrees, homedir-resolved). A
	// session cwd'd there (or under it) is a sub-orchestrator (root/sub authority).
	const cwd = process.cwd();
	// Directory-boundary compare (Windows-path fix): was a raw
	// startsWith(`${WORKTREE_DIR}/`) — a backslash-shaped cwd on Windows never
	// matched. expaths.isDirUnder compares segment-wise on normalized keys
	// (case/separator-folded on win32; byte-identical on posix).
	return isDirUnder(cwd, WORKTREE_DIR);
}

// ============================================================================
// SECTION — herdr socket client (W3 read-only transport path)
// ============================================================================

/** NDJSON-over-unix-socket client for the herdr server's raw API.
 *
 * MODULE_CONTRACT (productionized from the leak-probe prototype, live-validated
 * against herdr 0.8.2):
 * Dependencies: node:net, node:os, node:path only.
 * Protocol (per /tmp/herdr-socket-api.mdx + live validation): newline-delimited
 *   JSON over ~/.config/herdr/herdr.sock; request {"id","method","params"};
 *   response {"id","result"} or {"id","error":{code,message}}; pushed events
 *   arrive as lines carrying an "event" key with the payload under "data".
 * Critical invariants:
 *   - every request has a hard timeout (default SOCKET_REQUEST_TIMEOUT_MS) — a
 *     hung server rejects the request, it can never hang a caller forever
 *   - connection establishment is bounded by SOCKET_CONNECT_TIMEOUT_MS
 *   - ZERO subprocesses: a frozen/dead server costs a bounded per-call error —
 *     never a spawned CLI child (the 2026-09-09 pile-up ammunition)
 *   - the server is ONE-REQUEST-PER-CONNECTION for plain requests (answers,
 *     then closes; only subscriptions keep a connection open — verified: a
 *     pipelined request #2 is never answered, the client sees ECONNRESET), so
 *     a plain-request close is the NORMAL lifecycle: the client transparently
 *     reconnects and retries exactly once; subscriptions live on their own
 *     connection state and a close there is a genuine failure (surfaced via
 *     onClose, never silently retried)
 * Error modes: HerdrSocketError with a stable `code` (connect_timeout,
 *   connect_error, request_timeout, connection_closed, or the server's own
 *   code, e.g. not_found) — mapped by callers into the E_* taxonomy.
 * EXTERNAL_DEPENDENCY: the herdr server's unix socket — $HERDR_SOCKET_PATH
 *   (herdr's documented low-level override) or ~/.config/herdr/herdr.sock.
 */

/** Default socket location (herdr docs; named sessions live under sessions/<name>/). */
export const DEFAULT_HERDR_SOCK = join(homedir(), ".config", "herdr", "herdr.sock");

/** Kill-switch for the W3 socket read-only path: HERDR_SOCKET_TRANSPORT=cli
 *  restores the all-CLI legacy behavior; unset/"auto"/"socket" → read-only ops
 *  (agent list/get) go over the unix socket with zero subprocesses. */
export const HERDR_SOCKET_TRANSPORT_ENV = "HERDR_SOCKET_TRANSPORT";

/** Per-request hard timeout (ms). A hung server rejects; it can never hang a caller. */
export const SOCKET_REQUEST_TIMEOUT_MS = 5_000;

/** Connection-establishment timeout (ms). */
export const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

/** Error shape mirroring the E_* taxonomy style: typed, stable `code`, never a
 *  raw throw past the mapping layer (HerdrTransport maps these into E_*). */
export class HerdrSocketError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`herdr socket: ${code}: ${message}`);
		this.name = "HerdrSocketError";
		this.code = code;
	}
}

export interface HerdrSocketClientOptions {
	/** Unix socket path. Default: $HERDR_SOCKET_PATH or DEFAULT_HERDR_SOCK. */
	socketPath?: string;
	/** Per-request timeout in ms. Default SOCKET_REQUEST_TIMEOUT_MS. */
	requestTimeoutMs?: number;
	/** Connection-establishment timeout in ms. Default SOCKET_CONNECT_TIMEOUT_MS. */
	connectTimeoutMs?: number;
}

type SocketPendingEntry = {
	resolve: (value: unknown) => void;
	reject: (err: HerdrSocketError) => void;
	timer: NodeJS.Timeout;
};

type SocketEventHandler = (eventName: string, data: unknown) => void;

export class HerdrSocketClient {
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;
	private readonly connectTimeoutMs: number;
	private socket: Socket | null = null;
	private nextId = 1;
	private readonly pending = new Map<string, SocketPendingEntry>();
	private readonly eventHandlers = new Set<SocketEventHandler>();
	private buffer = "";
	private connecting: Promise<void> | null = null;
	private closedByUs = false;

	/** Liveness callback: fired once when a connection carrying subscriptions is
	 *  ended by the server (subscriptions are connection state — they die with
	 *  the connection; the owner must re-subscribe). */
	onSubscriptionLost: (() => void) | null = null;

	constructor(opts: HerdrSocketClientOptions = {}) {
		this.socketPath = opts.socketPath ?? process.env.HERDR_SOCKET_PATH ?? DEFAULT_HERDR_SOCK;
		this.requestTimeoutMs = opts.requestTimeoutMs ?? SOCKET_REQUEST_TIMEOUT_MS;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? SOCKET_CONNECT_TIMEOUT_MS;
	}

	/** Establish (or reuse) the connection. Concurrent callers share one
	 *  in-flight connect (idempotent); bounded by connectTimeoutMs.
	 * Raises: HerdrSocketError "connect_timeout" / "connect_error". */
	connect(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.closedByUs = false;
		this.connecting = new Promise<void>((resolve, reject) => {
			const sock = netConnect(this.socketPath);
			const connectTimer = setTimeout(() => {
				sock.destroy();
				this.connecting = null;
				reject(new HerdrSocketError("connect_timeout", `no connection to ${this.socketPath} within ${this.connectTimeoutMs}ms`));
			}, this.connectTimeoutMs);
			(connectTimer as unknown as { unref?: () => void }).unref?.();
			sock.once("connect", () => {
				clearTimeout(connectTimer);
				this.socket = sock;
				this.buffer = "";
				sock.setEncoding("utf8");
				sock.on("data", (chunk: string) => this.onData(chunk));
				sock.on("error", (err: Error) => this.onSocketError(err));
				sock.on("close", () => this.onSocketClose());
				this.connecting = null;
				resolve();
			});
			sock.once("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(connectTimer);
				this.connecting = null;
				reject(new HerdrSocketError("connect_error", `${err.code ?? "error"} on ${this.socketPath}`));
			});
		});
		return this.connecting;
	}

	/** Send one request and await its response (multiplexed by id).
	 *
	 * FUNCTION_CONTRACT:
	 * Input: method — dot-notation herdr method ("agent.list", "agent.get"…);
	 *   params — request params; timeoutMs — hard per-request cap
	 * Output: the parsed `result` payload of the matching response
	 * Guarantees:
	 *   - NEVER hangs: settles on response / timeout / error response /
	 *     connection loss; the pending entry is always cleaned up
	 *   - one transparent reconnect+retry when the server ends the one-shot
	 *     plain-request lifecycle (connection_closed without an acked
		*     subscription) — including the write-races-close window
	 * Raises:
	 *   - HerdrSocketError "request_timeout" — no response within timeoutMs
	 *   - HerdrSocketError "<server code>" — server error body (e.g. not_found)
	 *   - HerdrSocketError "connection_closed" — socket dropped
	 */
	async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			await this.connect();
			const sock = this.socket;
			if (!sock || sock.destroyed) throw new HerdrSocketError("connection_closed", "socket not open");
			const id = `rq-${this.nextId++}`;
			const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
			try {
				return await new Promise<T>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.pending.delete(id);
						reject(new HerdrSocketError("request_timeout", `${method} got no response within ${effectiveTimeout}ms`));
					}, effectiveTimeout);
					(timer as unknown as { unref?: () => void }).unref?.();
					this.pending.set(id, {
						resolve: (v) => {
							clearTimeout(timer);
							resolve(v as T);
						},
						reject: (e) => {
							clearTimeout(timer);
							reject(e);
						},
						timer,
					});
					sock.write(JSON.stringify({ id, method, params }) + "\n");
				});
			} catch (err) {
				// One-shot plain-request lifecycle (see section invariant): a
				// connection_closed on a subscription-less connection is NORMAL —
				// transparently reconnect and retry exactly once. With an active
				// subscription the connection is supposed to persist, so a close there
				// is a genuine failure and is NOT retried. Covers subscribe() too: its
				// handler is registered before the send, but no ack arrived → the
				// subscription does not exist server-side and the resend is safe.
				const closed = err instanceof HerdrSocketError && err.code === "connection_closed";
				if (closed && attempt === 0 && this.eventHandlers.size === 0) {
					this.socket = null;
					continue;
				}
				throw err;
			}
		}
	}

	/** events.subscribe: open a subscription; pushed events go to onEvent. The
	 *  subscription lives on the connection (server-side state) — if the server
	 *  ends it, onSubscriptionLost fires once and handlers are cleared.
	 * Raises: same as request() (subscribe IS a request; its ack is bounded by
	 *  the per-request timeout). NOTE (live-validated): the server REJECTS a
	 *  subscription entry missing fields the type requires — e.g.
	 *  pane.agent_status_changed needs pane_id even though the bundled schema
	 *  marks it optional; broad types (pane.updated, …) need only {type}. */
	async subscribe(subscriptions: Array<{ type: string; pane_id?: string }>, onEvent: SocketEventHandler): Promise<unknown> {
		// Connect FIRST: plain-request connections are one-shot, so the subscribe
		// must go out on a connection that is alive NOW — otherwise the send races
		// the already-closed socket.
		await this.connect();
		this.eventHandlers.add(onEvent);
		try {
			return await this.request("events.subscribe", { subscriptions });
		} catch (err) {
			this.eventHandlers.delete(onEvent);
			throw err;
		}
	}

	/** Close the connection; in-flight requests reject with "connection_closed". */
	close(): void {
		this.closedByUs = true;
		this.socket?.destroy();
		this.socket = null;
	}

	// -- internals ---------------------------------------------------------------

	private onData(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (line.length === 0) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // tolerate non-JSON noise
			}
			// Pushed event envelope (live-validated): key `event` (underscore form),
			// payload under `data`.
			if (typeof msg.event === "string") {
				for (const h of this.eventHandlers) {
					try {
						h(msg.event, msg.data);
					} catch {
						// a throwing handler must not kill the connection
					}
				}
				continue;
			}
			const entry = this.pending.get(String(msg.id));
			if (!entry) continue;
			this.pending.delete(String(msg.id));
			if (msg.error !== undefined && msg.error !== null) {
				const e = msg.error as { code?: string; message?: string };
				entry.reject(new HerdrSocketError(e.code ?? "unknown", e.message ?? JSON.stringify(msg.error)));
			} else {
				entry.resolve(msg.result);
			}
			// BUG_FIX_CONTEXT (one-shot lifecycle race, caught by transport-socket.ts):
			// the server answers ONE request per connection and closes it. A request
			// issued before the client processes that close used to be written onto a
			// connection the server had already end()ed — the response was lost and
			// only the retry round-trip saved it (and the stub server logged
			// ERR_STREAM_WRITE_AFTER_END). Fix: once a plain (subscription-less)
			// response lands, the connection is SPENT — the client destroys it
			// immediately so every following request reconnects deterministically.
			// Subscription connections are exempt: they legitimately stay open.
			if (this.eventHandlers.size === 0 && this.socket && !this.socket.destroyed) {
				const spent = this.socket;
				this.socket = null;
				spent.destroy();
			}
		}
	}

	private onSocketError(err: Error): void {
		// EPIPE/ECONNRESET on an ESTABLISHED socket is the server ending the
		// one-shot request lifecycle — map to connection_closed so request()'s
		// retry path engages. No pending requests → swallow (an unhandled 'error'
		// event would crash the process; a post-response close is normal).
		const e = new HerdrSocketError("connection_closed", err.message);
		for (const [, entry] of this.pending) entry.reject(e);
		this.pending.clear();
	}

	private onSocketClose(): void {
		this.socket = null;
		const hadSubscriptions = this.eventHandlers.size > 0;
		const e = new HerdrSocketError(
			"connection_closed",
			this.closedByUs ? "closed by client" : "server closed the connection",
		);
		for (const [, entry] of this.pending) entry.reject(e);
		this.pending.clear();
		if (hadSubscriptions && !this.closedByUs) {
			this.eventHandlers.clear();
			try {
				this.onSubscriptionLost?.();
			} catch {
				// a throwing owner callback must not break the close path
			}
		}
	}
}

// ============================================================================
// SECTION — herdr CLI implementation of the seam
// ============================================================================

export class HerdrTransport implements Transport {
	/** Tail of the serialized mutating-op chain. */
	private queueTail: Promise<unknown> = Promise.resolve();

	/** In-flight listStatuses de-dup guard (see listStatuses). */
	private listStatusesInFlight: Promise<AgentStatus[]> | null = null;

	/** Per-op deadline on the mutation queue (see enqueue). Generous headroom
	 *  over the CLI bound (CLI_TIMEOUT_MS 30s + SIGKILL_GRACE_MS 5s): it only
	 *  fires for a never-settling op shape, which the CLI transport can no
	 *  longer produce (W0 SIGKILL escalation) — this is defense-in-depth for
	 *  any future op source that can hang. */
	private static readonly QUEUE_OP_DEADLINE_MS = 45_000;

	/** Lazily-created herdr socket client (W3 read-only path); null when the
	 *  socket transport is disabled via env. */
	private socket: HerdrSocketClient | null | undefined;

	/** Injectable socket path for tests/stubs; undefined → env/default resolution. */
	private readonly socketPath: string | undefined;

	/** Per-op queue deadline (ms) — injectable for tests. */
	private readonly queueOpDeadlineMs: number;

	constructor(opts: { socketPath?: string; queueOpDeadlineMs?: number } = {}) {
		this.socketPath = opts.socketPath;
		this.queueOpDeadlineMs = opts.queueOpDeadlineMs ?? HerdrTransport.QUEUE_OP_DEADLINE_MS;
	}

	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		// BUG_FIX_CONTEXT (W2 pile-up guard, 2026-09-09 herdr incident follow-up):
		// symptom — the serialized-mutations chain is a plain promise chain, so a
		// NEVER-SETTLING op stalls every later mutating op forever (loop-freeze h3:
		// place()/startAgent() still pending at t+35s behind a hung op). Why the
		// plain chain did not work: `queueTail = run.catch(...)` keeps the chain
		// ALIVE after a rejection, but nothing bounds how long an op may run.
		// What was done: every enqueued op races against a one-shot deadline timer
		// (QUEUE_OP_DEADLINE_MS); on deadline the CALLER's promise rejects with a
		// structured E_TIMEOUT DelegateError while `queueTail` moves on — a hung op
		// can delay the queue by at most the deadline, never stall it forever.
		// The raced-away op itself may still settle later (its own caller has
		// already been released); with the W0 SIGKILL escalation the CLI transport
		// always settles, so a late settle cannot reorder real herdr mutations.
		let deadlineFired = false;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(() => {
				deadlineFired = true;
				reject(
					new DelegateErrorImpl(
						"E_TIMEOUT",
						`herdr mutating op stalled past the ${this.queueOpDeadlineMs}ms queue deadline`,
						"a herdr mutating op never settled and was raced off the mutation queue — retry the op; if this repeats, the transport op source is hung and needs investigation",
						undefined,
					),
				);
			}, this.queueOpDeadlineMs);
			(deadlineTimer as unknown as { unref?: () => void }).unref?.();
		});
		const run = this.queueTail.then(op, op);
		// Keep the chain alive regardless of op outcome — and let it PROCEED at the
		// deadline even when the op itself never settles (race settles first).
		const raced = Promise.race([run, deadline]) as Promise<T>;
		this.queueTail = raced.catch(() => undefined);
		// One-shot timer: cleared as soon as the op settles (normal path); a fired
		// deadline is a no-op to clear. Promise.race keeps BOTH inputs handled, so
		// neither a late op rejection nor a late deadline rejection is unhandled.
		run.then(
			() => clearTimeout(deadlineTimer),
			() => clearTimeout(deadlineTimer),
		);
		void deadlineFired; // reserved for future op-cancellation plumbing
		return raced;
	}

	capabilities(): TransportCapabilities {
		// Root/sub authority from the session cwd (see isSubOrchestratorCwd).
		// EXTERNAL_DEPENDENCY: process.cwd() vs the herdr worktree root
		// (~/.herdr/worktrees, homedir-resolved).
		const authority = isSubOrchestratorCwd() ? "sub" : "root";
		return { worktrees: authority === "root", authority };
	}

	/** Migration stage 3 (audit step 9): the adapter is the single source of
	 *  the active-backend name — must match the `backend:` spelling place()
	 *  writes into placements (lines below, both placement builders). */
	backendName(): string {
		return "herdr";
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

	teardown(req: TeardownReq): Promise<TeardownResult> {
		return this.enqueue(() => this.teardownInner(req));
	}

	// -- Read-only ops: not queued -------------------------------------------------

	/** W3: lazily-create the socket client for read-only ops. Returns null when
	 *  the socket transport is disabled via HERDR_SOCKET_TRANSPORT=cli. The
	 *  client is created ONCE per transport and reconnects transparently (the
	 *  server one-shots plain-request connections). */
	private socketForReadOnly(): HerdrSocketClient | null {
		if (this.socket === undefined) {
			const mode = process.env[HERDR_SOCKET_TRANSPORT_ENV] ?? "auto";
			this.socket = mode === "cli" ? null : new HerdrSocketClient({ socketPath: this.socketPath });
		}
		return this.socket;
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name
	 * Output: AgentStatus, or null when herdr reports the agent unknown/not found
	 * Guarantees:
	 *   - read-only (not queued with mutations); safe to call any time
	 *   - "not found"-shaped failures → null (caller decides what that means):
		 *     socket path maps the structured not_found error code, CLI path the
		 *     legacy message regex — same null contract either way
	 * Raises:
	 *   - DelegateErrorImpl (E_STATUS) for any non-not-found herdr failure
	 * EXTERNAL_DEPENDENCY: herdr socket API `agent.get` (W3 read-only path;
	 *   zero subprocesses), falling back to the `herdr agent get <name>`
	 *   subprocess only when the socket transport is disabled via env.
	 */
	async getStatus(name: string): Promise<AgentStatus | null> {
		const sock = this.socketForReadOnly();
		if (sock) {
			try {
				const result = await sock.request("agent.get", { target: name });
				return agentStatusFromResult(result, name);
			} catch (err) {
				// Live-validated (herdr 0.8.2): the server's agent-not-found error code is
				// agent_not_found; not_found is the generic resource code — map both.
				const code = err instanceof HerdrSocketError ? err.code : "";
				if (code === "agent_not_found" || code === "not_found") return null;
				// Migration stage 1 (audit, errors-defect 1): a status-read failure is
				// its OWN taxonomy entry (E_STATUS), not a borrowed E_START — the code
				// names what failed, not where the throw site happens to sit.
				throw new DelegateErrorImpl(
					"E_STATUS",
					`herdr socket agent.get failed for ${name}: ${(err as Error).message}; worker may have exited`,
					"herdr socket status query failed for worker; worker may have exited — reconcile via `herdr agent list` before retrying.",
					err,
				);
			}
		}
		try {
			const { stdout } = await runHerdr(["agent", "get", name]);
			return agentStatusFromResult(parseHerdrResult(stdout).result, name);
		} catch (err) {
			if (isNotFound(err)) return null;
			// Migration stage 1: E_STATUS — same rationale as the socket path above.
			throw new DelegateErrorImpl(
				"E_STATUS",
				`herdr status query failed for ${name}: ${(err as Error).message}; worker may have exited`,
				"herdr status query failed for worker; worker may have exited — reconcile via `herdr agent list` before retrying.",
				err,
			);
		}
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input: none
	 * Output: every agent herdr currently knows (name, status, pane/workspace ids)
	 * Guarantees:
	 *   - read-only (not queued); tolerates both list shapes (bare array or
	 *     {agents:[...]}) and entries with missing fields (status "unknown")
	 *   - pile-up guard (W2, 2026-09-09 incident follow-up): while one call is
	 *     in flight, concurrent callers share its result instead of stacking a
	 *     second herdr call — the fleet UI tick (2 s) and the watcher tick (10 s)
	 *     overlap by design, and in a dead-herdr window every overlapping call
		 *     used to spawn one more hung CLI child (the incident's pile-up).
	 *     Calls in DISTINCT time windows each hit herdr (no memoization) and a
	 *     failure is shared as-is (caller degrades — buildWorkerView catches).
	 * Raises:
	 *   - DelegateErrorImpl (E_STATUS) when the herdr call fails
	 * EXTERNAL_DEPENDENCY: herdr socket API `agent.list` (W3 read-only path;
	 *   zero subprocesses) with no CLI fallback — an unreachable server is a
	 *   per-call error, never a spawn and never a hang.
	 */
	async listStatuses(): Promise<AgentStatus[]> {
		if (this.listStatusesInFlight) return this.listStatusesInFlight;
		const flight = this.listStatusesOnce().then(stripToSeamStatuses);
		this.listStatusesInFlight = flight;
		try {
			return await flight;
		} finally {
			if (this.listStatusesInFlight === flight) this.listStatusesInFlight = null;
		}
	}

	private async listStatusesOnce(): Promise<HerdrAgentStatus[]> {
		// W3 read-only path: NDJSON over the herdr unix socket — no subprocess, so
		// a frozen server costs a bounded per-call error instead of hung children.
		// Adapter-INTERNAL shape (HerdrAgentStatus carries the herdr ids the
		// drift guard needs); the public listStatuses() strips to the seam model.
		const sock = this.socketForReadOnly();
		if (sock) {
			try {
				const result = await sock.request("agent.list");
				const list = Array.isArray(result)
					? result
					: isRecord(result) && Array.isArray(result.agents)
						? result.agents
						: [];
				return list.filter(isRecord).map((a) => herdrStatusFromResult(a, String(a.name ?? "")));
			} catch (err) {
				// Migration stage 1: E_STATUS (was a borrowed E_START).
				throw new DelegateErrorImpl(
					"E_STATUS",
					`herdr socket agent.list failed: ${(err as Error).message}; worker statuses unavailable`,
					"herdr unreachable over the socket; worker statuses unavailable — reconcile via `herdr agent list`.",
					err,
				);
			}
		}
		// Socket transport disabled via env — legacy CLI path.
		try {
			const { stdout } = await runHerdr(["agent", "list"]);
			const { result } = parseHerdrResult(stdout);
			const list = Array.isArray(result)
				? result
				: isRecord(result) && Array.isArray(result.agents)
					? result.agents
					: [];
			return list.filter(isRecord).map((a) => herdrStatusFromResult(a, String(a.name ?? "")));
		} catch (err) {
			// Migration stage 1: E_STATUS (was a borrowed E_START).
			throw new DelegateErrorImpl(
				"E_STATUS",
				`herdr status query failed for agent list: ${(err as Error).message}; worker statuses unavailable`,
				"herdr status query failed; worker statuses unavailable — reconcile via `herdr agent list`.",
				err,
			);
		}
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input:
	 *   - name: canonical agent name; timeoutMs: total wait budget
	 *   - signal: abort detaches the WAIT (never the worker)
	 *   - onPoll: per-slice liveness callback (caller throttles; never throws)
	 *   - proofSettled: caller-owned out-of-band completion proof (the canonical
	 *     report file observed against THIS embodiment's witness — lifecycle.ts,
	 *     content not mtime / session reply) polled in the START-UP phase
	 *   - releaseOnStarted: v1.14 early release once the agent is observed working
	 * Output: SettleResult — the discriminated settle union (migration stage 3,
	 *   audit step 8 — the settle semantics live in the SEAM, the adapter only
	 *   classifies observations):
	 *   normal settle              → {kind:"settled", status};
	 *   never-started timeout      → {kind:"never-started", status:"unknown"};
	 *   aged finish / proof settle → {kind:"finished-before-watch", status:"idle"};
	 *   early release (v1.14)      → {kind:"started-confirmed", status:"working"};
	 *   abort                      → {kind:"detached", status:<last known>};
	 *   budget elapsed after start → {kind:"timeout", status:<last observed>}.
	 * Guarantees:
	 *   - two-phase state machine (START-UP → SETTLED) against the
	 *     settle-before-start race (BUG_FIX_CONTEXT below)
	 *   - abort → immediate return with the last known status, worker untouched
	 *   - a throwing proofSettled counts as "not proven", never blocks the wait
	 * Raises:
	 *   - never for herdr slice hiccups (reconciled via getStatus inside the loop)
	 * EXTERNAL_DEPENDENCY: `herdr agent wait/get` subprocesses (via runHerdr);
	 *   the worker's session JSONL (aged-finish proof, via sessionHasReply).
	 */
	async waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
		/** v1.9: out-of-band settled-proof (the report file observed against the
		 *  caller's embodiment witness — content, not mtime / session reply). */
		proofSettled?: () => Promise<boolean>;
		/** v1.14 (watch.releaseOn=started): release as soon as the agent is
		 *  observed working — the orchestrator hands off to the watcher (§21)
		 *  instead of blocking the rest of the settle gate. Never set for probes. */
		releaseOnStarted?: boolean;
	}): Promise<SettleResult> {
		// BUG_FIX_CONTEXT (D3, DESIGN.md §19.1) — two-phase state machine against
		// the settle-before-start race: the first `agent wait --until idle…` slice
		// can match BEFORE the prompt is consumed (agent still idle) → instant
		// false settle (field report: six fan-out workers all "settled idle" at
		// the same second, then worked for hours). Symptom: workers reported
		// settled the moment they were still idle pre-prompt. Why the old single
		// phase did not work: it treated any idle/wait match as a settle. What was
		// done: a START-UP phase that only accepts working/blocked/done as proof
		// of life before the SETTLED phase may accept idle/done/blocked.
		//
		// Phase START-UP (before the first working/blocked/done observation): only
		// those prove the prompt was consumed; idle/unknown slices keep polling. If
		// the whole timeoutMs elapses without ever observing one of them →
		// {status:"unknown", timedOut:true, neverStarted:true}.
		// Phase SETTLED (after the first such observation): current behavior —
		// idle/done/blocked settle; slices + reconcile; abort → detach.
		//
		// BUG_FIX_CONTEXT (v1.8, DESIGN.md §19.1b) — the aged-finish blind spot
		// (live-reproduced): herdr ages done→idle within minutes, so a watcher that
		// attaches late — fast flash probes, abort/detach recovery, slow start — can
		// NEVER observe working/done and spins the FULL timeout against a visibly
		// finished worker, then false-reports neverStarted. Why the two-phase fix
		// alone did not work: it still required observing working/blocked/done.
		// What was done: an unexplained idle is checked against the session JSONL —
		// an assistant reply proves the prompt was consumed → settle as
		// finishedBeforeWatch (success, not failure). No reply → never started.
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
		let sessionLookupDone = false;
		while (Date.now() < deadline) {
			if (req.signal?.aborted) {
				// Abort detaches the wait, never the worker (DESIGN.md §5.1).
				const s = await this.getStatus(req.name).catch(() => null);
				return { kind: "detached", status: s?.status ?? last };
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
			// v1.8/v1.9: the start-up gate can never open when herdr never reports
			// working/blocked/done for the worker. Two live shapes: herdr ages
			// done→idle within minutes (§19.1b), and current builds never report
			// working for pi workers at all — field 2026-09-05 (m03-search-
			// investigation): three finished fan-out workers (reports on disk) kept
			// their watchers spinning the FULL budget at status=idle/unknown, then
			// false-reported neverStarted. Prove life out-of-band instead:
			//   1. caller-owned completion proof (v1.9, §19.1c) — the report file for
			//      THIS run observed against the embodiment witness (content, not
			//      mtime; migration stage 3, audit step 8) is the completion criterion
			//      (tool contract); the proof is authoritative and exact per worker.
			//   2. session-reply proof (v1.8, §19.1b) — an assistant message in the
			//      worker's session JSONL proves the prompt was consumed.
			// Only reached while started is still false, so a healthy wait never
			// pays for the extra checks.
			if (!started && (status === undefined || !STARTED.includes(status))) {
				if (req.proofSettled) {
					let proven = false;
					try {
						proven = await req.proofSettled();
					} catch {
						proven = false; // a throwing proof never blocks the wait
					}
					if (proven) {
						req.onPoll?.({ status: status ?? "idle", started: true, elapsedMs: Date.now() - startedAt });
						return { kind: "finished-before-watch", status: "idle" };
					}
				}
				if (sessionLookupDone === false) {
					// Resolve once per wait: negative results are stable per herdr build
					// (no agent_session in the result shape), positives are immutable.
					sessionLookupDone = true;
					sessionPath = await this.resolveSessionPath(req.name).catch(() => undefined);
				}
				if (sessionPath && sessionHasReply(sessionPath)) {
					req.onPoll?.({ status: status ?? "idle", started: true, elapsedMs: Date.now() - startedAt });
					return { kind: "finished-before-watch", status: "idle" };
				}
			}
			req.onPoll?.({ status: status ?? "unknown", started, elapsedMs: Date.now() - startedAt });
			if (started && status && SETTLED.includes(status)) return { kind: "settled", status };
			// v1.14 (watch.releaseOn=started): the worker is proven started and
			// actively working — a spawn failure (E_PLACE/E_START/E_NAME) is ruled
			// out, so blocking the rest of the settle gate buys nothing (§21: the
			// watcher owns the wait). Release the orchestrator immediately. Fast
			// finishes are still caught synchronously by the settled check above:
			// a worker that settles before the first working observation (within
			// one wait slice) returns its report inline as before.
			if (req.releaseOnStarted && started && status === "working") {
				return { kind: "started-confirmed", status };
			}
			await sleep(WAIT_SLEEP_MS);
		}
		if (!started) {
			// Never observed working/blocked/done since submission — the prompt was
			// likely never consumed; a settle here would be the false-settle bug.
			// (v1.8: an already-finished worker was ruled out above by the session
			// reply proof, so never-started here is honest.)
			return { kind: "never-started", status: "unknown" };
		}
		return { kind: "timeout", status: last };
	}

	/** v1.8: resolve the agent's session JSONL path from `herdr agent get`
	 *  (result.agent.agent_session.value). Undefined when herdr doesn't expose
	 *  it — callers then fall back to the pre-v1.8 behavior.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name
	 * Output: the session JSONL path, or undefined when herdr exposes none
	 * Guarantees:
	 *   - tolerant path extraction (multiple result shapes via pick())
	 * Raises:
	 *   - propagates runHerdr errors (caller catches)
	 * EXTERNAL_DEPENDENCY: `herdr agent get <name>` subprocess — the
	 *   agent.agent_session.value field this herdr build may or may not carry.
	 */
	private async resolveSessionPath(name: string): Promise<string | undefined> {
		const { stdout } = await runHerdr(["agent", "get", name]);
		const { result } = parseHerdrResult(stdout);
		return isRecord(result) ? asString(pick(result, "agent.agent_session.value", "agent_session.value")) : undefined;
	}

	/** Recent pane output for a worker (terminal snapshot, few hundred lines tail).
	 *  Optional: probe-verdict from streaming; implementations without pane
	 *  readback may reject — callers must fall back to status-based verdicts.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name; opts.maxChars — tail size (default 4000)
	 * Output: the LAST maxChars characters of the pane's recent output
	 * Guarantees:
	 *   - read-only (not queued with mutations)
	 * Raises:
	 *   - raw subprocess errors propagate (callers treat as readback-unavailable)
	 * EXTERNAL_DEPENDENCY: `herdr agent read <name> --source recent` subprocess.
	 */
	async readPane(name: string, opts?: { maxChars?: number }): Promise<string> {
		// Read-only: terminal snapshot (recent), NOT queued with mutations.
		const { stdout } = await runHerdr(["agent", "read", name, "--source", "recent"]);
		const out = String(stdout ?? "");
		const max = opts?.maxChars ?? 4000;
		return out.length > max ? out.slice(out.length - max) : out;
	}

	// -- Mutating op bodies (run serialized via enqueue) ----------------------------


	/**
	 * FUNCTION_CONTRACT:
	 * Input: PlacementReq — mode worktree|tab, repoPath, branch (worktree),
	 *   label, optional base ref
	 * Output: Placement (kind, workspaceId, paneId, checkoutPath, branch,
	 *   isLinkedWorktree) extracted from the herdr result
	 * Guarantees:
	 *   - worktree placement is ROOT-only (sub-orchestrator → E_PLACE)
	 *   - tab placement requires a current herdr workspace (env var below)
	 *   - runs serialized on the mutation queue (enqueue)
	 * Raises:
	 *   - DelegateErrorImpl E_PLACE for every failure shape (CLI error,
	 *     sub-orchestrator rejection, missing env var, unparseable output,
	 *     missing workspace/pane ids)
	 * EXTERNAL_DEPENDENCY: `herdr worktree create` / `herdr tab create`
	 *   subprocesses; process.env.HERDR_WORKSPACE_ID — the session's own herdr
	 *   workspace id, REQUIRED for tab placement (tabs open on the session's
	 *   workspace; absent → E_PLACE).
	 */
	private async placeInner(req: PlacementReq): Promise<Placement> {
		const { authority } = this.capabilities();

		if (req.mode === "worktree") {
			if (authority !== "root") {
				throw delegateError(
					"E_PLACE",
					`Worktree placement rejected: this session is a sub-orchestrator (cwd under ${WORKTREE_DIR}/).`,
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

		// EXTERNAL_DEPENDENCY: HERDR_WORKSPACE_ID env var (herdr sets it in every
		// pane session) — identifies the workspace the tab is opened on.
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

	/**
	 * Starts one pi worker agent in the requested pane via the herdr CLI.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: req — StartReq (worker name, paneId, timeoutMs, provider/model/
	 *   thinking flags, optional extraArgs passed through after "--")
	 * Output: StartResult — the canonical agent name (extractAgentName) plus
	 *   sessionPath when herdr reports agent.agent_session.value
	 * Guarantees:
	 *   - CLI args are built in herdr's `agent start` shape (--kind pi --pane
	 *     --timeout -- <provider/model/thinking + extraArgs>)
	 *   - BOTH name-taken failure shapes (structured `agent_name_taken` and
	 *     plain text "name taken by a live agent (candidates: …)", matched
	 *     case-insensitively) map to E_NAME with the candidate list carried
	 *     into the message
	 * Raises:
	 *   - DelegateErrorImpl E_NAME when the requested name is taken by a live
	 *     agent (either failure shape)
	 *   - DelegateError E_START for any other herdr failure (CLI error,
	 *     unparseable output)
	 */
	private async startAgentInner(req: StartReq): Promise<StartResult> {
		// Workerhost inversion (design §3): StartReq is keyed by the opaque
		// placementRef — the adapter decodes its own ref to the herdr pane id.
		// Legacy raw pane ids (no `herdr:pane:` prefix) decode via the fallback
		// in paneFromHerdrRef, so pre-ref records keep starting.
		const paneId = paneFromHerdrRef(req.placementRef);
		if (!paneId) {
			throw delegateError(
				"E_START",
				`herdr agent start ${req.name}: undecodable placementRef ${JSON.stringify(req.placementRef)}`,
			);
		}
		const args = [
			"agent", "start", req.name,
			"--kind", "pi",
			"--pane", paneId,
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
			// BUG_FIX_CONTEXT (D4, DESIGN.md §19.2): this herdr build does NOT
			// auto-uniquify. Two failure shapes say the same fact — structured
			// `agent_name_taken` and plain text "…<name>: name taken by a live agent
			// (candidates: …)". Symptom: the plain-text shape surfaced as a generic
			// E_START, sending the orchestrator down a wrong retry path. Why the old
			// mapping did not work: it matched only the structured token. What was
			// done: match BOTH (case-insensitive) and map to E_NAME with the same
			// candidate-list guidance.
			if (/agent_name_taken/i.test(msg) || /name taken by a live agent/i.test(msg)) {
				const candidates = /candidat\w*\s*[:=]?\s*([^\n]+)/i.exec(msg)?.[1]?.trim() ?? "unknown";
				// Migration stage 1 (errors-defect 2): the guidance BASE TEXT is the
				// seam dictionary's (GUIDANCE.E_NAME via delegateErrorWithDetail) —
				// the adapter appends only the backend FACT (the candidate list).
				throw delegateErrorWithDetail(
					"E_NAME",
					`herdr agent start ${req.name}: name taken by a live agent (candidates: ${candidates})`,
					`candidates: ${candidates}`,
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

	/**
	 * Submits one prompt to a running agent via the herdr CLI. No --wait:
	 * submit-and-return fast; settle observation is waitSettle()'s job.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: req — PromptReq (agent name, prompt text); req.timeoutMs bounds
	 *   the submit call itself
	 * Output: resolves when herdr accepts the prompt (fire-and-forget
	 *   submission, no settle proof)
	 * Guarantees:
	 *   - every failure shape on this path (agent_prompt_stalled, blocked,
	 *     submit timeout, other herdr errors) maps to the SAME E_PROMPT_STALLED
	 *     code, each with its own message
	 * Raises:
	 *   - DelegateError E_PROMPT_STALLED for a stalled agent, a blocked agent,
	 *     or the submit timeout / any other herdr failure
	 */
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

	/**
	 * FUNCTION_CONTRACT:
	 * Input: TeardownReq — name, placement, force (worktree removal flag)
	 * Output: TeardownResult — alreadyGone: true when the placement was ALREADY
	 *   gone (idempotent no-op), false when this call closed something
	 * Guarantees:
	 *   - worktree teardown is ROOT-only (sub-orchestrator → E_PLACE): a
	 *     sub-orchestrator enumerating globally-scanned manifests must never be
	 *     able to remove a root orchestrator's worktrees
	 *   - not_linked_worktree removal errors are tolerated and reconciled via
	 *     closeWorkspaceIfPresent
	 *   - migration stage 1 (extensibility-defect 1): not-found-shaped failures
	 *     (worktree removal OR tab close) resolve with { alreadyGone: true } —
	 *     the structured "already gone" signal; callers read the FIELD, never
	 *     the message text (the old unsynchronized isAlreadyGone regexes at
	 *     every call site are gone)
	 * Raises:
	 *   - DelegateErrorImpl E_TEARDOWN for CLI failures / surviving workspaces /
	 *     failed tab close that is NOT not-found-shaped
	 *   - DelegateErrorImpl E_PLACE for the authority rejection (policy guard,
	 *     mirrors placeInner)
	 * EXTERNAL_DEPENDENCY: `herdr worktree remove`, `herdr workspace list/close`,
	 *   `herdr tab close` subprocesses.
	 */
	private async teardownInner(req: TeardownReq): Promise<TeardownResult> {
		const p = req.placement as Placement & { tabId?: string };

		// Authority guard (mirrors placeInner): worktree teardown is root-only.
		// A sub-orchestrator enumerating globally-scanned manifests must never be
		// able to remove a root orchestrator's worktrees.
		if (req.placement.kind === "worktree" && this.capabilities().authority === "sub") {
			throw new DelegateErrorImpl(
				"E_PLACE",
				`Worktree teardown rejected: this session is a sub-orchestrator (cwd under ${WORKTREE_DIR}/).`,
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
				const msg = (err as Error).message ?? "";
				if (/not_linked_worktree/i.test(msg)) {
					// Orphaned/not-linked workspace — handled by the reconcile below.
				} else if (/not[\s_-]?found/i.test(msg)) {
					// BUG_FIX_CONTEXT (parity pin, workerhost impl 2026-09-10): the seam
					// contract is "teardown of an already-gone placement → idempotent
					// no-op success" (pinned by the fake and the host-parity-check P3).
					// Symptom: the SECOND worktree teardown failed E_PLACE with herdr's
					// `workspace_not_found` — only the tab path was idempotent. Why the
					// old guard did not work: it tolerated only not_linked_worktree.
					// What was done: not-found-shaped removal errors are a no-op success
					// too; migration stage 1 additionally reports it STRUCTURED
					// (alreadyGone: true) so callers no longer regex the message text.
					return { alreadyGone: true };
				} else {
					// Migration stage 1 (audit, errors-defect 1): teardown-operation
					// failures are E_TEARDOWN, not a borrowed E_PLACE. The authority
					// guard ABOVE stays E_PLACE — a policy rejection, symmetric with
					// place()'s guard, not a failed close operation.
					throw delegateError(
						"E_TEARDOWN",
						`herdr worktree remove failed for workspace ${workspaceId}: ${msg}`,
						err,
					);
				}
			}
			// Reconcile (O2): removing the worktree while the worker agent is live
			// can leave a non-linked workspace shell that only `workspace close`
			// removes — verify against `workspace list`, close if still present,
			// and re-verify before reporting success.
			await this.closeWorkspaceIfPresent(workspaceId);
			return { alreadyGone: false };
		}

		// kind === "tab"
		// herdr drift guard: manifests written while placementFromTabResult fell
		// back to the pane id carry tabId === paneId — closing that id always
		// fails tab_not_found while the agent (and its REAL tab) stays alive. The
		// fallback masked this as an idempotent retire (F6 follow-up, 2026-09-10
		// implement-osb field report). Resolve the live tab id from the herdr
		// agent registry when the recorded one carries the broken signature.
		const recordedTabId = p.tabId ?? req.placement.paneId;
		let tabId = recordedTabId;
		if (recordedTabId === req.placement.paneId) {
			const live = await this.resolveLiveTabId(req.name);
			const reconciled = reconcileTabClose(recordedTabId, live);
			if (reconciled !== recordedTabId) {
				tabId = reconciled; // manifest recorded a pane id — close the REAL tab
			}
		}
		try {
			await runHerdr(["tab", "close", tabId]);
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// Migration stage 1 (extensibility-defect 1): the tab branch used to
			// THROW on not-found (only the worktree branch was idempotent) and the
			// tool layer re-parsed the message text at every call site. Now: a
			// not-found-shaped close is the structured alreadyGone signal — the
			// placement is verifiably absent, an idempotent no-op, not an error.
			if (/not[\s_-]?found/i.test(msg)) return { alreadyGone: true };
			// Genuine close failure → E_TEARDOWN (was a borrowed E_PLACE; DESIGN.md
			// §7 backlog item closed in step 2).
			throw delegateError(
				"E_TEARDOWN",
				`herdr tab close ${tabId} failed: ${msg}`,
				err,
			);
		}
		return { alreadyGone: false };
	}

	/** Resolve the LIVE herdr tab id for a named agent (herdr drift guard):
	 *  the `agent list` registry entry carries the real tab_id even when the
	 *  manifest's recorded placement fell back to a pane id. Read-only socket
	 *  path first (non-queued by contract), CLI fallback; null when the agent
	 *  is gone (the caller then closes the recorded id and lets the not-found
	 *  → idempotent semantics handle it).
	 * <p>
	 * EXTERNAL_DEPENDENCY: herdr socket (HERDR_SOCK env) / `herdr agent list`
	 * subprocess.
	 */
	private async resolveLiveTabId(name: string): Promise<string | null> {
		if (this.socketForReadOnly()) {
			try {
				const statuses = await this.listStatusesOnce(); // adapter-internal shape (tab id needed)
				return statuses.find((s) => s.name === name)?.tabId ?? null;
			} catch {
				return null; // statuses unavailable — fall through to the recorded id
			}
		}
		try {
			const { stdout } = await runHerdr(["agent", "list"]);
			const { result } = parseHerdrResult(stdout);
			const list = Array.isArray(result)
				? result
				: isRecord(result) && Array.isArray(result.agents)
					? result.agents
					: [];
			const entry = list.find(
				(a) => isRecord(a) && String((a as Record<string, unknown>).name ?? (a as Record<string, unknown>).agent_name ?? "") === name,
			);
			return entry ? asString(pick(entry, "tab_id", "tabId")) : null;
		} catch {
			return null; // registry unreachable — fall through to the recorded id
		}
	}

	/** Reconcile a workspace that survived removal (any shape, incl. not_linked shells).
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: workspaceId — the herdr workspace that should be gone
	 * Output: resolves when the workspace is verifiably absent
	 * Guarantees:
	 *   - no-op when the workspace does not exist
	 * Raises:
	 *   - DelegateErrorImpl E_TEARDOWN when the close fails or the workspace
	 *     survives a successful close (caller must reconcile manually)
	 * EXTERNAL_DEPENDENCY: `herdr workspace list` / `herdr workspace close`
	 *   subprocesses.
	 */
	private async closeWorkspaceIfPresent(workspaceId: string): Promise<void> {
		if (!(await this.workspaceExists(workspaceId))) return;
		try {
			await runHerdr(["workspace", "close", workspaceId]);
		} catch (err) {
			// Migration stage 1: E_TEARDOWN (was a borrowed E_PLACE).
			throw delegateError(
				"E_TEARDOWN",
				`herdr workspace close ${workspaceId} failed after worktree remove: ${(err as Error).message}`,
				err,
			);
		}
		if (await this.workspaceExists(workspaceId)) {
			// Migration stage 1: E_TEARDOWN (was a borrowed E_PLACE).
			throw delegateError(
				"E_TEARDOWN",
				`workspace ${workspaceId} still present after herdr workspace close — reconcile via herdr workspace list`,
			);
		}
	}

	private async workspaceExists(workspaceId: string): Promise<boolean> {
		// EXTERNAL_DEPENDENCY: `herdr workspace list` subprocess.
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
		// Seam read model carries ONLY the opaque ref (workerhost inversion,
		// design §3): herdr ids stay in the adapter (see herdrStatusFromResult).
		placementRef: herdrRefOrNull(
			asString(pick(result, "pane_id", "paneId", "agent.pane_id", "pane.pane_id")),
		),
	};
}

/**
 * Migration stage 3 (audit step 10): the drift-guard reconcile decision is a
 * pure exported function (behaviorally tested in static-check T3.3b — the
 * old T3.3 was a source-text regex over this file). The teardown call site
 * feeds it the recorded id and the live resolution; the decision stays here,
 * next to the adapter-internal id model.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - recordedTabId: the id the manifest placement carries (possibly the
 *     paneId fallback — the broken signature)
 *   - liveTabId: the real tab id from the herdr agent registry, or null when
 *     the agent is gone / statuses unavailable
 * Output: the tab id to close
 * Guarantees:
 *   - the broken signature (recorded === paneId) + a DIFFERENT live id → the
 *     live id (close the REAL tab, not the pane)
 *   - every other input → the recorded id unchanged (a missing live id must
 *     not turn a working close into a wrong-target close)
 * Raises: never
 */
export function reconcileTabClose(recordedTabId: string, liveTabId: string | null): string {
	return liveTabId !== null && liveTabId !== recordedTabId ? liveTabId : recordedTabId;
}

/** Adapter-internal read model: the seam AgentStatus PLUS the herdr ids the
 *  adapter itself needs (resolveLiveTabId drift guard, teardown reconcile).
 *  NEVER crosses the seam — herdr ids stop at src/herdr/host.ts. */
interface HerdrAgentStatus extends AgentStatus {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

function herdrStatusFromResult(result: unknown, fallbackName: string): HerdrAgentStatus {
	const base = agentStatusFromResult(result, fallbackName);
	if (!isRecord(result)) return base;
	return {
		...base,
		paneId: asString(pick(result, "pane_id", "paneId", "agent.pane_id", "pane.pane_id")),
		tabId: asString(pick(result, "tab_id", "tabId", "agent.tab_id", "tab.tab_id")),
		workspaceId: asString(pick(result, "workspace_id", "workspaceId", "agent.workspace_id", "workspace.workspace_id")),
	};
}

/** Strip the adapter-internal HerdrAgentStatus down to the seam read model
 *  (workerhost inversion, design §3: herdr ids never leave the adapter). */
function stripToSeamStatuses(list: HerdrAgentStatus[]): AgentStatus[] {
	return list.map(({ paneId: _p, tabId: _t, workspaceId: _w, ...seam }) => seam);
}

/**
 * Extracts a worktree Placement (workspace/pane/branch/checkout) from a
 * parsed `herdr worktree create` result.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: result — parsed `herdr worktree create` result; req — the original
 *   placement request (branch fallback); raw — raw stdout for error text
 * Output: a worktree Placement (workspaceId, paneId, branch, checkoutPath,
 *   isLinkedWorktree)
 * Guarantees:
 *   - checkoutPath/branch fall back to the request values when herdr omits them
 * Raises:
 *   - DelegateErrorImpl E_PLACE for unparseable output or missing
 *     workspace_id/pane_id
 * EXTERNAL_DEPENDENCY: `herdr worktree create` result shape (frozen fields:
 *   workspace.worktree.*, root_pane.pane_id).
 */
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
		// Workerhost inversion (design §4): the opaque ref + backend tag ride
		// ALONGSIDE the legacy id fields (version-skew both ways — legacy fields
		// stay until a full 1.15.x cohort rotation).
		backend: "herdr",
		placementRef: herdrRefFromPane(paneId),
	};
}

/**
 * FUNCTION_CONTRACT:
 * Input: result — parsed `herdr tab create` result; workspaceId — the env-
 *   supplied current workspace; raw — raw stdout for error text
 * Output: a tab HerdrPlacement (paneId, tabId, checkoutPath = process.cwd())
 * Guarantees:
 *   - tabId falls back to paneId when herdr omits it
 *   - checkoutPath is the CURRENT session cwd (a tab shares the checkout)
 * Raises:
 *   - DelegateErrorImpl E_PLACE for unparseable output or missing root pane id
 * EXTERNAL_DEPENDENCY: `herdr tab create` result shape (frozen fields:
 *   tab.tab_id, root_pane.pane_id; legacy spellings tab.id/tab_id accepted);
 *   process.cwd() as the shared checkout.
 */
export function placementFromTabResult(
	result: unknown,
	workspaceId: string,
	raw: string,
): HerdrPlacement {
	if (!isRecord(result)) {
		throw delegateError("E_PLACE", `herdr tab create returned unparseable output: ${truncate(raw)}`);
	}
	const paneId = asString(pick(result, "root_pane.pane_id", "pane_id", "root_pane.id"));
	// BUG_FIX_CONTEXT (herdr drift, 2026-09-10): herdr renamed the tab-create
	// result key tab.id → tab.tab_id; the old probe list missed the new spelling
	// so the fallback recorded the PANE id as tabId — every later `tab close`
	// failed with tab_not_found (the pane id is not a tab id), which the retire
	// pass masked as an idempotent close while the agent stayed alive. The
	// current spelling is probed first; the legacy spellings stay for older herdr.
	const tabId = asString(pick(result, "tab.tab_id", "tab.id", "tab_id", "tabId")) ?? paneId;
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
		// Workerhost inversion (design §4): ref + backend tag ALONGSIDE legacy
		// fields (see placementFromWorktreeResult).
		backend: "herdr",
		placementRef: herdrRefFromPane(paneId),
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
