/**
 * pi-delegate — event-driven background watcher (DESIGN.md §21).
 *
 * Field motivation: §20.1 removed the long blocking wait but left NO sanctioned
 * way to wait after `E_TIMEOUT` — so the orchestrator improvised `sleep 1500`
 * in bash (parked session, invisible to the fleet UI, no gauges). The watcher
 * replaces that improvisation: it polls out-of-band and WAKES the orchestrator
 * with one `pi.sendUserMessage(text, { deliverAs: "followUp" })` per batch of
 * events, so the orchestrator's turn can simply END after a detach.
 *
 * Advisory by contract: a watcher failure must NEVER affect spawn or collect
 * outcomes. Every read is tolerant, every delivery is guarded — a build without
 * `sendUserMessage` (headless/old) stays inert, never throws.
 *
 * Independent of the fleet UI: no `ctx.hasUI` guard, works headless.
 *
 * Dependency rule (DESIGN.md §4.1): imports transport/types.ts, exchange.ts and
 * usage.ts only — NEVER transport/herdr.ts. The Transport instance is injected
 * from index.ts, exactly like the tools get it.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	questionPathFor,
	readQuestion,
	scanAllManifests,
	validateReport,
	type ExchangeManifest,
} from "./exchange.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "./usage.ts";
import { CONTEXT_CRITICAL_PCT, type AgentStatus, type Transport } from "./transport/types.ts";

// ---------------------------------------------------------------------------
// Config — {"watch": {"intervalMs": 10000, "settleGateMs": 15000}} from
// ~/.pi/agent/pi-delegate.config.json. Same tolerant style as
// resolveSpawnDefaults(): missing/corrupt/partial → defaults, never throws.
// NOTE: bun caches os.homedir() — tests must set $HOME at child-process spawn
// time (the caveat documented in usage.ts).
// ---------------------------------------------------------------------------

export const WATCH_DEFAULT_INTERVAL_MS = 10_000;
/** §20.1's 120 s blocking window shrinks to this (explicit waitMs still wins). */
export const WATCH_DEFAULT_SETTLE_GATE_MS = 15_000;
/** Floor for intervalMs — a typo like 1 must not hammer herdr every ms. */
export const WATCH_MIN_INTERVAL_MS = 1_000;

export interface WatchConfig {
	intervalMs: number;
	settleGateMs: number;
}

export function resolveWatchConfig(): WatchConfig {
	const fallback: WatchConfig = {
		intervalMs: WATCH_DEFAULT_INTERVAL_MS,
		settleGateMs: WATCH_DEFAULT_SETTLE_GATE_MS,
	};
	try {
		const raw = readFileSync(join(homedir(), ".pi", "agent", "pi-delegate.config.json"), "utf8");
		const cfg = JSON.parse(raw) as { watch?: unknown };
		const w = cfg.watch;
		if (w === null || typeof w !== "object") return fallback;
		const e = w as Record<string, unknown>;
		const num = (v: unknown, dflt: number, min: number): number =>
			typeof v === "number" && Number.isFinite(v) && v >= min ? v : dflt;
		return {
			intervalMs: num(e.intervalMs, fallback.intervalMs, WATCH_MIN_INTERVAL_MS),
			settleGateMs: num(e.settleGateMs, fallback.settleGateMs, 1),
		};
	} catch {
		return fallback; // no config / corrupt config → defaults, never throw
	}
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What the watcher can notice. `report-invalid` is the distinct MESSAGE of the
 * report-ready detection (§21 event 1): the file is readable but fails
 * validateReport — the orchestrator's move differs (diagnose, not verify).
 */
export type WatchEventKind =
	| "report-ready"
	| "report-invalid"
	| "mailbox-question"
	| "grill-deck"
	| "context-critical"
	| "worker-dead";

export interface WatchEvent {
	worker: string;
	dir: string;
	kind: WatchEventKind;
	/** Concrete next action for the orchestrator — the whole point of the wake-up. */
	message: string;
	/** Payload identity. Dedup is per worker+kind, but a worker that asks a
	 *  SECOND question, rewrites its report or opens a SECOND deck states a NEW
	 *  fact, so those kinds carry the payload identity here (report mtime /
	 *  question ts / deck invocation count). Gauge- and absence-shaped kinds
	 *  (context-critical, worker-dead) omit it — they must fire exactly once. */
	fingerprint?: string;
}

/** Dedup key: dir#worker#kind[#fingerprint]. */
export function eventKey(e: Pick<WatchEvent, "worker" | "dir" | "kind" | "fingerprint">): string {
	return `${e.dir}#${e.worker}#${e.kind}${e.fingerprint ? `#${e.fingerprint}` : ""}`;
}

// ---------------------------------------------------------------------------
// Snapshot — manifests + live statuses + self-identification, no judgement
// ---------------------------------------------------------------------------

export interface WatchWorker {
	name: string;
	dir: string;
	reportPath: string;
	sessionPath?: string;
	model?: string;
	/** Parsed manifest startedAt (undefined when absent/unparseable). */
	startedAtMs?: number;
	/** True when herdr currently knows this agent (status ≠ unknown). */
	live: boolean;
	/** Placement kind (probe dirs are tabs by construction). */
	kind: "worktree" | "tab";
	/** This very session IS that worker (self-event filter, §21). */
	self: boolean;
	/** Probe run (dir /tmp/exchange/_probe) — no report is ever expected. */
	probe: boolean;
}

export interface WatchSnapshot {
	workers: WatchWorker[];
	/** False when listStatuses() failed: herdr unreachable means NOBODY is
	 *  known-live, which must NOT be read as "everyone died". */
	statusesKnown: boolean;
}

/** Noise guard: workers older than this are history, not a fleet — manifests
 *  outlive sessions, and a fresh orchestrator must not be woken for last
 *  week's teardown. */
export const WATCH_LOOKBACK_MS = 24 * 60 * 60_000;
/** A worker placed seconds ago is not dead: herdr may not have registered it
 *  yet (and startAgent itself takes time). */
export const WATCH_DEAD_GRACE_MS = 60_000;
/** Session JSONL scan cap: only the tail can hold a NEW tool call, and a
 *  10 s poll must not re-parse 50 MB per worker. */
export const SESSION_TAIL_BYTES = 1_000_000;

/** The grill-deck tool name — a worker that invoked it is blocked on a HUMAN
 *  at its own pane, not on the mailbox. */
export const GRILL_DECK_TOOL = "grill_deck";

export interface SelfIdentity {
	/** This session's JSONL path (ctx.sessionManager.getSessionFile()). */
	sessionFile?: string;
	/** This session's cwd (ctx.cwd). */
	cwd?: string;
}

/**
 * Merge manifests + live statuses into the watcher's view. `statuses === null`
 * means herdr is unreachable (statusesKnown:false). Self-identification is
 * exact by session path, or — for worktree placements only — by the unique
 * per-worker checkout path (tab workers share the repo cwd, so they are never
 * muted on cwd alone).
 */
export function workersFromManifests(
	manifests: ExchangeManifest[],
	statuses: AgentStatus[] | null,
	self: SelfIdentity = {},
	nowMs: number = Date.now(),
): WatchSnapshot {
	const liveNames = new Set(
		(statuses ?? []).filter((s) => s && s.status !== "unknown").map((s) => s.name),
	);
	const workers: WatchWorker[] = [];
	for (const manifest of manifests) {
		for (const w of manifest.workers) {
			if (typeof w?.name !== "string" || w.name.length === 0) continue;
			const startedAtMs = Date.parse(w.startedAt ?? "");
			if (Number.isFinite(startedAtMs) && nowMs - startedAtMs > WATCH_LOOKBACK_MS) continue;
			const checkoutPath = w.placement?.checkoutPath;
			const isSelf =
				(self.sessionFile !== undefined &&
					typeof w.sessionPath === "string" &&
					w.sessionPath === self.sessionFile) ||
				(w.placement?.kind === "worktree" &&
					self.cwd !== undefined &&
					typeof checkoutPath === "string" &&
					checkoutPath === self.cwd);
			workers.push({
				name: w.name,
				dir: manifest.dir,
				reportPath: w.reportPath,
				...(typeof w.sessionPath === "string" && w.sessionPath.length > 0
					? { sessionPath: w.sessionPath }
					: {}),
				...(typeof w.model === "string" && w.model.length > 0 ? { model: w.model } : {}),
				...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
				live: liveNames.has(w.name),
				kind: w.placement?.kind === "tab" ? "tab" : "worktree",
				self: isSelf,
				probe: manifest.dir.endsWith("/_probe"),
			});
		}
	}
	return { workers, statusesKnown: statuses !== null };
}

/** Read live statuses tolerantly: herdr unreachable → null (statuses unknown). */
export async function readStatusesTolerant(transport: Transport): Promise<AgentStatus[] | null> {
	try {
		return await transport.listStatuses();
	} catch {
		return null;
	}
}

export async function collectSnapshot(
	transport: Transport,
	self: SelfIdentity = {},
	nowMs: number = Date.now(),
): Promise<WatchSnapshot> {
	return workersFromManifests(scanAllManifests(), await readStatusesTolerant(transport), self, nowMs);
}

// ---------------------------------------------------------------------------
// Session JSONL scan — tool-call names (accompanies parseSessionUsage, which
// deliberately knows nothing about tools). Tolerant: unreadable/corrupt/partial
// → [] (a half-written last line is skipped, never thrown).
// ---------------------------------------------------------------------------

function readSessionTail(path: string, maxBytes: number = SESSION_TAIL_BYTES): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		if (size <= maxBytes) return readFileSync(path, "utf8");
		// Tail read (the first, partial line fails to parse and is skipped) —
		// explicit fd read: @types/node types position/length only on the Buffer
		// overload of readFileSync, and no new dependencies are allowed.
		fd = openSync(path, "r");
		const start = size - maxBytes;
		const len = size - start;
		const buf = Buffer.allocUnsafe(len);
		readSync(fd, buf, 0, len, start);
		return buf.toString("utf8");
	} catch {
		return ""; // unreadable → no tool calls known, never throw
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed — advisory scan, nothing to recover
			}
		}
	}
}

/** Names of every toolCall in a worker session (duplicates preserved — the
 *  count is a useful fingerprint). Empty when the session is unknown/corrupt. */
export function sessionToolCallNames(sessionPath?: string): string[] {
	if (!sessionPath) return [];
	const names: string[] = [];
	for (const line of readSessionTail(sessionPath).split("\n")) {
		if (!line.trim()) continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // corrupt/partial line — skip
		}
		const content = (e as { message?: { content?: unknown } })?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				block !== null &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "toolCall" &&
				typeof (block as { name?: unknown }).name === "string"
			) {
				names.push((block as { name: string }).name);
			}
		}
	}
	return names;
}

/** How many times a worker invoked a tool (0 when unreadable). */
export function countSessionToolCall(sessionPath: string | undefined, toolName: string): number {
	return sessionToolCallNames(sessionPath).filter((n) => n === toolName).length;
}

// ---------------------------------------------------------------------------
// Detection — pure functions over a WatchWorker; every read tolerant
// ---------------------------------------------------------------------------

export interface DetectOptions {
	/** Default CONTEXT_CRITICAL_PCT (90) — the operator restart line. */
	contextCriticalPct?: number;
	/** Grace before worker-dead fires (default WATCH_DEAD_GRACE_MS). */
	deadGraceMs?: number;
	/** Injectable clock (tests). */
	nowMs?: number;
	/** False when herdr was unreachable this tick → worker-dead is suppressed
	 *  (statuses unknown ≠ dead). detectEvents sets it from the snapshot; a
	 *  standalone detectWorkerEvents call defaults to "statuses are known". */
	statusesKnown?: boolean;
}

function truncate(s: string, max = 220): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function fileMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * All conditions currently true for one worker (already-deduped by the caller).
 * Detection order = orchestrator priority: a landed report outranks a question,
 * which outranks a deck, which outranks the gauges, which outrank death.
 */
export function detectWorkerEvents(w: WatchWorker, opts: DetectOptions = {}): WatchEvent[] {
	const nowMs = opts.nowMs ?? Date.now();
	const events: WatchEvent[] = [];
	const mk = (kind: WatchEventKind, message: string, fingerprint?: string): WatchEvent => ({
		worker: w.name,
		dir: w.dir,
		kind,
		message,
		...(fingerprint !== undefined ? { fingerprint } : {}),
	});

	// 1. report-ready / report-invalid (§21)
	const reportMtime = fileMtimeMs(w.reportPath);
	if (reportMtime !== null) {
		const verdict = validateReport(w.reportPath, w.name);
		if (verdict.ok) {
			events.push(
				mk(
					"report-ready",
					`report landed at ${w.reportPath} (status=${verdict.report.status}) — read it and verify ` +
						`against the brief: ${truncate(verdict.report.summary, 160)}`,
					`${reportMtime}`,
				),
			);
		} else if (!verdict.error.includes("not readable")) {
			// readable-but-invalid is a DISTINCT message: the move is diagnose, not verify
			events.push(
				mk(
					"report-invalid",
					`report at ${w.reportPath} exists but fails validation: ${truncate(verdict.error, 160)} — ` +
						"read the pane, find the root cause, then a diagnosed retry (never verbatim)",
					`${reportMtime}`,
				),
			);
		}
	}

	// 2. mailbox-question (§12) — fingerprinted by the envelope ts, so a worker
	//    that asks AGAIN after an answer wakes the orchestrator again.
	const q = readQuestion(questionPathFor(w.dir, w.name));
	if (q) {
		const options = q.options?.length ? ` Options: ${q.options.join(" | ")}.` : "";
		events.push(
			mk(
				"mailbox-question",
				`asks: "${truncate(q.question, 200)}"${options} Answer via delegate_mailbox ` +
					`(action 'answer', worker ${w.name}) — it is waiting for you.`,
				q.ts,
			),
		);
	}

	// 3. grill-deck — the worker blocked itself on an INTERACTIVE deck; only a
	//    human at that pane can answer, so say exactly that.
	const decks = countSessionToolCall(w.sessionPath, GRILL_DECK_TOOL);
	if (decks > 0) {
		events.push(
			mk(
				"grill-deck",
				`invoked grill_deck (${decks}×) — it is blocked on an interactive question deck in its OWN ` +
					`pane and only a human can answer there: open the pane (herdr), or steer it to use the ` +
					`mailbox (q-${w.name}.json) instead.`,
				`${decks}`,
			),
		);
	}

	// 4. context-critical — pi's own gauge (last assistant totalTokens ÷ window).
	if (w.sessionPath) {
		const pct = contextPct(parseSessionUsage(w.sessionPath), resolveContextWindow(w.model));
		const threshold = opts.contextCriticalPct ?? CONTEXT_CRITICAL_PCT;
		if (pct !== null && pct >= threshold) {
			events.push(
				mk(
					"context-critical",
					`context at ${pct}% ≥ ${threshold}% (session ${w.sessionPath}) — its next turns compact: ` +
						"steer it to wrap up NOW (delegate_mailbox action 'steer') or plan a fresh-name retry",
				),
			);
		}
	}

	// 5. worker-dead — herdr no longer knows the agent AND nothing landed. Skipped
	//    when herdr is unreachable (statuses unknown ≠ dead), for probes (no report
	//    expected) and inside the placement grace window (herdr may not have
	//    registered the agent yet).
	if (
		!w.live &&
		opts.statusesKnown !== false &&
		reportMtime === null &&
		!w.probe &&
		(w.startedAtMs === undefined || nowMs - w.startedAtMs >= (opts.deadGraceMs ?? WATCH_DEAD_GRACE_MS))
	) {
		events.push(
			mk(
				"worker-dead",
				`has no live herdr status and no report at ${w.reportPath} — it exited without producing ` +
					"anything. Treat as a failed spawn: read the pane (herdr agent read), then a diagnosed retry.",
			),
		);
	}

	return events;
}

/**
 * Deduped detection over a whole snapshot. `seen` is the watcher's memory
 * (worker+kind[+fingerprint] fired since the last reset): an event fires at
 * most once per key; when the condition STOPS being true the key is forgotten,
 * so a re-armed condition fires again. Mutates `seen`, returns the new events.
 */
export function detectEvents(
	snap: WatchSnapshot,
	seen: Set<string>,
	opts: DetectOptions = {},
): WatchEvent[] {
	const tickOpts: DetectOptions = { ...opts, statusesKnown: snap.statusesKnown };
	const fresh: WatchEvent[] = [];
	const current = new Set<string>();
	const prefixes = new Set<string>();
	for (const w of snap.workers) {
		prefixes.add(`${w.dir}#${w.name}#`);
		for (const e of detectWorkerEvents(w, tickOpts)) {
			const key = eventKey(e);
			current.add(key);
			if (!seen.has(key)) {
				seen.add(key);
				fresh.push(e);
			}
		}
	}
	// State reset: forget keys of workers in THIS snapshot whose condition is gone
	// (keys of workers no longer in manifests are dropped too — nothing observes
	// them any more).
	for (const key of [...seen]) {
		if (!current.has(key) && [...prefixes].some((p) => key.startsWith(p))) seen.delete(key);
	}
	return fresh;
}

// ---------------------------------------------------------------------------
// Delivery text
// ---------------------------------------------------------------------------

/** One batch = one wake-up message (§21). */
export function formatEventBatch(events: WatchEvent[]): string {
	const head =
		`DELEGATE WATCHER — ${events.length} event(s) need attention (you do not need to poll ` +
		`delegate_status for these):`;
	return [head, ...events.map((e) => `- [${e.kind}] ${e.worker}: ${e.message}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Watcher loop
// ---------------------------------------------------------------------------

export interface WatcherDeps {
	transport: Transport;
	/** Delivery sink — pi.sendUserMessage(..., {deliverAs:"followUp"}) in
	 *  production, injectable in tests. Throws are swallowed by the loop. */
	send: (text: string) => void | Promise<void>;
	intervalMs?: number;
	self?: SelfIdentity;
	detect?: DetectOptions;
	/** Snapshot source override (tests drive fixtures; production uses
	 *  collectSnapshot over scanAllManifests + the injected transport). */
	snapshot?: () => Promise<WatchSnapshot>;
	/** Advisory log sink (console.error by default). */
	log?: (msg: string) => void;
}

export interface WatcherHandle {
	/** One poll+deliver cycle — exposed so tests drive it without timers. */
	tick: () => Promise<WatchEvent[]>;
	stop: () => void;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Build the poller. Never throws; every cycle is wrapped so a bad manifest, an
 * unreachable herdr or a throwing sink only costs that cycle.
 */
export function createWatcher(deps: WatcherDeps): WatcherHandle {
	const seen = new Set<string>();
	const log = deps.log ?? ((m: string) => console.error(`[pi-delegate watch] ${m}`));
	let stopped = false;

	const tick = async (): Promise<WatchEvent[]> => {
		if (stopped) return [];
		let events: WatchEvent[];
		let leafWorker = false;
		try {
			const snap = deps.snapshot ? await deps.snapshot() : await collectSnapshot(deps.transport, deps.self ?? {});
			events = detectEvents(snap, seen, deps.detect ?? {});
			// A worker never needs to be woken for its own events…
			events = events.filter((e) => !snap.workers.some((w) => w.self && w.dir === e.dir && w.name === e.worker));
			// …and a leaf (worktree) worker session is not an orchestrator: its
			// fleet is someone else's. Sub-orchestrators run as tabs (skill) and
			// keep their watcher.
			leafWorker = snap.workers.some((w) => w.self && w.kind === "worktree");
		} catch (err) {
			log(`tick skipped (${errText(err)}) — advisory, no outcome affected`);
			return [];
		}
		if (leafWorker || events.length === 0) return [];
		try {
			await deps.send(formatEventBatch(events));
		} catch (err) {
			// Delivery failure is logged and skipped — the next tick re-tries only
			// events that have not been marked seen… which they have, so the batch
			// is dropped by design: the watcher is advisory, never a queue.
			log(`delivery failed (${errText(err)}) — batch dropped (advisory)`);
		}
		return events;
	};

	const intervalMs = deps.intervalMs ?? WATCH_DEFAULT_INTERVAL_MS;
	const timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Never keep a dying process alive for an advisory poller (bun/node differ on
	// the timer shape — unref is optional on both).
	(timer as unknown as { unref?: () => void }).unref?.();

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};

	return { tick, stop };
}

// ---------------------------------------------------------------------------
// Lifecycle registry (mirrors ui/fleet-ui.ts mount/dispose: module-level, so
// session_shutdown can stop what session_start started; double-start replaces)
// ---------------------------------------------------------------------------

let activeStop: (() => void) | null = null;

/** Stop the running watcher (idempotent, safe when nothing is running). */
export function stopWatcher(): void {
	const s = activeStop;
	activeStop = null;
	try {
		s?.();
	} catch {
		// stop is advisory — never throw past session_shutdown
	}
}

/**
 * Delivery sink builder (§21). Guarded by design: a build without
 * `sendUserMessage` (headless/old pi) returns a NO-OP — the watcher stays inert
 * instead of throwing on every tick. `deliverAs: "followUp"` is what makes it a
 * wake-up that never interrupts a turn in flight.
 */
export function makeSender(
	pi: { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown },
): (text: string) => void {
	return (text: string): void => {
		if (typeof pi.sendUserMessage !== "function") return;
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	};
}

/**
 * Start the watcher for this session (DESIGN.md §21: headless-safe — NO
 * ctx.hasUI guard). Returns the dispose fn; also reachable via stopWatcher().
 */
export function startWatcher(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	transport: Transport,
	ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } },
): () => void {
	stopWatcher(); // idempotent double-start replaces the previous mount
	const cfg = resolveWatchConfig();
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.();
	} catch {
		sessionFile = undefined; // self-identification degrades, watcher lives
	}
	const handle = createWatcher({
		transport,
		intervalMs: cfg.intervalMs,
		self: { sessionFile, cwd: ctx.cwd },
		send: makeSender(pi),
	});
	const stop = (): void => {
		handle.stop();
		if (activeStop === stop) activeStop = null;
	};
	activeStop = stop;
	return stop;
}
