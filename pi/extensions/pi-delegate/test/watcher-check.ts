/**
 * T-watch — event-driven background watcher checks (DESIGN.md §21).
 *
 * Run with: bun test/watcher-check.ts   (from the extension dir)
 *
 * Checks:
 *   W1  Dependency rule: src/watch.ts must NOT import transport/herdr.ts;
 *       index.ts mounts the watcher (session_start) and stops it
 *       (session_shutdown) WITHOUT a ctx.hasUI guard; delegate resolves the
 *       settle gate from watch config and its E_TIMEOUT text carries the
 *       new-model discipline.
 *   W2  Config — watch.intervalMs / watch.settleGateMs defaults and overrides,
 *       in a child bun process with $HOME set at spawn time (bun caches
 *       os.homedir(), same seam as usage-check §2/§7).
 *   W3  report-ready + its distinct report-invalid message.
 *   W4  mailbox-question.
 *   W5  grill-deck (session JSONL scan, corrupt lines, tail window).
 *   W6  context-critical.
 *   W7  worker-dead + every suppression (live, herdr unreachable, report on
 *       disk, placement grace, probe run).
 *   W8  Dedup: fires once per worker+kind+fingerprint; a condition that stops
 *       being true resets its key; a rewritten report / re-asked question is a
 *       NEW fact and re-fires.
 *   W9  Batch delivery through the loop: one send per batch, quiet ticks send
 *       nothing, a throwing sink/transport never breaks the loop.
 *   W10 Headless/old build: sender inert without pi.sendUserMessage; registry
 *       start/stop idempotent.
 *   W11 Self-filter: a worker session is not woken for its own events.
 *   W12 Stale manifests (older than the lookback) are ignored.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
	GRILL_DECK_TOOL,
	WATCH_DEAD_GRACE_MS,
	WATCH_DEFAULT_INTERVAL_MS,
	WATCH_DEFAULT_SETTLE_GATE_MS,
	WATCH_LOOKBACK_MS,
	collectSnapshot,
	countSessionToolCall,
	createWatcher,
	detectEvents,
	formatEventBatch,
	makeSender,
	resolveWatchConfig,
	sessionToolCallNames,
	startWatcher,
	stopWatcher,
	workersFromManifests,
	type DetectOptions,
	type WatchEvent,
	type WatchSnapshot,
} from "../src/watch.ts";
import { questionPathFor, reportPathFor, type ExchangeManifest, type ManifestWorker } from "../src/exchange.ts";
import type { AgentStatus, Transport } from "../src/transport/types.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

// ---------------------------------------------------------------------------
// W1. Dependency rule + lifecycle wiring + delegate texts (static)
// ---------------------------------------------------------------------------

// Same matcher as static-check T1.1: real import statements, not doc comments.
const IMPORT_HERDR_RE = /(import[\s\S]*?from\s*["']|\bimport\s*["'])([^"']*transport\/herdr)["']/;
const watchSrc = readFileSync(resolve(ROOT, "src/watch.ts"), "utf8");
check("W1.1 watch.ts does not import transport/herdr.ts (dependency rule)", !IMPORT_HERDR_RE.test(watchSrc));
check(
	"W1.1b watch.ts takes the Transport seam from transport/types.ts",
	/from\s+["']\.\/transport\/types\.ts["']/.test(watchSrc),
);
const toolOffenders = readdirSync(resolve(ROOT, "src/tools"), { withFileTypes: true })
	.filter((e) => e.isFile() && e.name.endsWith(".ts"))
	.map((e) => resolve(ROOT, "src/tools", e.name))
	.filter((f) => IMPORT_HERDR_RE.test(readFileSync(f, "utf8")));
check("W1.1c tools/ still import no transport/herdr.ts", toolOffenders.length === 0, toolOffenders.join(", "));

const indexSrc = readFileSync(resolve(ROOT, "index.ts"), "utf8");
check(
	"W1.2 index.ts mounts (session_start) and stops (session_shutdown) the watcher",
	/pi\.on\("session_start"[\s\S]*startWatcher\(/.test(indexSrc) &&
		/pi\.on\("session_shutdown"[\s\S]*stopWatcher\(/.test(indexSrc),
);
check(
	"W1.2b watcher mount is NOT behind ctx.hasUI (headless-safe, §21)",
	/async \(_event, ctx\) => \{\s*\n\s*startWatcher\(/.test(indexSrc),
);

const delegateSrc = readFileSync(resolve(ROOT, "src/tools/delegate.ts"), "utf8");
check("W1.3 delegate takes its default gate from watch.settleGateMs", /resolveWatchConfig\(\)\.settleGateMs/.test(delegateSrc));
check(
	"W1.3b explicit waitMs still wins over the gate; legacy timeoutMs still capped",
	/params\.waitMs \?\?\s*\n?\s*\(params\.timeoutMs !== undefined\s*\n?\s*\? Math\.min\(params\.timeoutMs, WAIT_CAP_MS\)/.test(delegateSrc),
);
check(
	"W1.4 E_TIMEOUT text: END YOUR TURN, watcher owns the wait, no bash sleep",
	/END YOUR TURN/.test(delegateSrc) && /No bash sleep/.test(delegateSrc) && /fallback ONLY when the watcher is/.test(delegateSrc),
);
check(
	"W1.5 delegate guideline teaches the end-turn discipline",
	/promptGuidelines[\s\S]*END YOUR TURN[\s\S]*\]/.test(delegateSrc),
);
const statusSrc = readFileSync(resolve(ROOT, "src/tools/status.ts"), "utf8");
check(
	"W1.6 delegate_status guideline: no polling loop, the watcher wakes you",
	/promptGuidelines[\s\S]*do NOT poll it in a loop[\s\S]*\]/.test(statusSrc),
);

// ---------------------------------------------------------------------------
// W2. Config — child bun process with $HOME at spawn time
// ---------------------------------------------------------------------------

const WATCH_MOD = new URL("../src/watch.ts", import.meta.url).pathname;

function watchConfigInHome(configJson: string): { intervalMs: number; settleGateMs: number; raw: string } {
	const home = mkdtempSync(join(tmpdir(), "watcher-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveWatchConfig} from ${JSON.stringify(WATCH_MOD)}; console.log(JSON.stringify(resolveWatchConfig()))`;
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	rmSync(home, { recursive: true, force: true });
	const raw = res.stdout.toString().trim();
	try {
		return { ...JSON.parse(raw), raw };
	} catch {
		return { intervalMs: -1, settleGateMs: -1, raw: `SPAWN FAILED: ${res.stderr.toString().slice(0, 200)}` };
	}
}

{
	const d = watchConfigInHome("");
	check(
		"W2.1 no config → defaults (interval 10000, gate 15000)",
		d.intervalMs === WATCH_DEFAULT_INTERVAL_MS && d.settleGateMs === WATCH_DEFAULT_SETTLE_GATE_MS,
		d.raw,
	);
	const o = watchConfigInHome(JSON.stringify({ watch: { intervalMs: 2500, settleGateMs: 45000 } }));
	check("W2.2 watch.intervalMs + watch.settleGateMs override", o.intervalMs === 2500 && o.settleGateMs === 45000, o.raw);
	const p = watchConfigInHome(JSON.stringify({ watch: { settleGateMs: 30000 } }));
	check("W2.3 partial watch section → per-key defaults", p.intervalMs === WATCH_DEFAULT_INTERVAL_MS && p.settleGateMs === 30000, p.raw);
	const c = watchConfigInHome("{ not json ]");
	check(
		"W2.4 corrupt config → defaults, never throws",
		c.intervalMs === WATCH_DEFAULT_INTERVAL_MS && c.settleGateMs === WATCH_DEFAULT_SETTLE_GATE_MS,
		c.raw,
	);
	const bad = watchConfigInHome(JSON.stringify({ watch: { intervalMs: 5, settleGateMs: "15000" } }));
	check(
		"W2.5 below-floor interval / non-numeric gate fall back",
		bad.intervalMs === WATCH_DEFAULT_INTERVAL_MS && bad.settleGateMs === WATCH_DEFAULT_SETTLE_GATE_MS,
		bad.raw,
	);
	const nested = watchConfigInHome(
		JSON.stringify({ contextWindow: 999, defaults: { tier: "flash" }, watch: { intervalMs: 7000 } }),
	);
	check("W2.6 watch coexists with the other config keys", nested.intervalMs === 7000 && nested.settleGateMs === WATCH_DEFAULT_SETTLE_GATE_MS, nested.raw);
	check("W2.7 resolveWatchConfig() is total in-process", resolveWatchConfig().intervalMs > 0);
}

// ---------------------------------------------------------------------------
// Fixtures — temp dirs with fake manifests / reports / session JSONL
// ---------------------------------------------------------------------------

const FIX = mkdtempSync(join(tmpdir(), "watcher-check-fix-"));

function taskDir(name: string): string {
	const dir = join(FIX, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mkWorker(
	dir: string,
	name: string,
	over: Partial<ManifestWorker> & { kind?: "worktree" | "tab" } = {},
): ManifestWorker {
	const { kind, ...rest } = over;
	return {
		name,
		placement: {
			kind: kind ?? "worktree",
			workspaceId: "w1",
			paneId: "w1:p1",
			branch: `delegate/${name}`,
			checkoutPath: `/tmp/wt/${name}`,
		},
		briefPath: `${dir}/brief-${name}.md`,
		reportPath: reportPathFor(dir, name),
		provider: "p",
		model: "unknown-model", // → DEFAULT_CONTEXT_WINDOW (250 100)
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(), // past the dead grace
		...rest,
	};
}

function manifestOf(dir: string, workers: ManifestWorker[]): ExchangeManifest {
	return { task: dirname(dir) === dir ? "task" : (dir.split("/").pop() ?? "task"), dir, workers };
}

const LIVE = (name: string): AgentStatus => ({ name, status: "working" });
const NO_STATUS: AgentStatus[] = [];

function snapshotFor(workers: ManifestWorker[], statuses: AgentStatus[] | null, self: { sessionFile?: string; cwd?: string } = {}, nowMs = NOW): WatchSnapshot {
	const byDir = new Map<string, ManifestWorker[]>();
	for (const w of workers) {
		const dir = dirname(w.briefPath);
		byDir.set(dir, [...(byDir.get(dir) ?? []), w]);
	}
	const manifests = [...byDir].map(([dir, ws]) => manifestOf(dir, ws));
	return workersFromManifests(manifests, statuses, self, nowMs);
}

/** Fresh dedup-free detection for one worker (live by default, so the
 *  worker-dead detector stays out of unrelated scenarios). */
function eventsFor(
	w: ManifestWorker,
	opts: DetectOptions & { statuses?: AgentStatus[] | null; self?: { sessionFile?: string; cwd?: string } } = {},
): WatchEvent[] {
	const snap = snapshotFor([w], opts.statuses === undefined ? [LIVE(w.name)] : opts.statuses, opts.self ?? {}, opts.nowMs ?? NOW);
	return detectEvents(snap, new Set<string>(), { nowMs: NOW, ...opts });
}

function writeSession(dir: string, name: string, lines: unknown[]): string {
	const p = join(dir, `session-${name}.jsonl`);
	writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return p;
}

const assistantUsage = (totalTokens: number) => ({
	message: { role: "assistant", usage: { input: 1000, output: 500, totalTokens } },
});
const assistantToolCall = (name: string) => ({
	message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: {} }] },
});

function writeValidReport(dir: string, name: string): string {
	const p = reportPathFor(dir, name);
	writeFileSync(
		p,
		JSON.stringify({
			worker: name,
			status: "pass",
			summary: "done",
			artifacts: [],
			evidence: [{ claim: "c", file: "f.ts:1" }],
		}),
	);
	return p;
}

const kindsOf = (events: WatchEvent[]): string => events.map((e) => e.kind).sort().join(",");

// ---------------------------------------------------------------------------
// W3. report-ready (+ report-invalid distinct message)
// ---------------------------------------------------------------------------

{
	const dir = taskDir("report");
	const w = mkWorker(dir, "w-report");
	check("W3.1 no report → no report event", !kindsOf(eventsFor(w)).includes("report-ready"), kindsOf(eventsFor(w)));

	const p = writeValidReport(dir, "w-report");
	const after = eventsFor(w);
	const ready = after.find((e) => e.kind === "report-ready");
	check("W3.2 valid report → report-ready", ready !== undefined, kindsOf(after));
	check(
		"W3.2b report-ready names the path and the verify action",
		!!ready && ready.message.includes(p) && /verify/i.test(ready.message),
		ready?.message ?? "",
	);

	writeFileSync(p, JSON.stringify({ worker: "w-report", status: "PASS", summary: "s", artifacts: [], evidence: [] }));
	utimesSync(p, new Date(NOW + 5000), new Date(NOW + 5000));
	const invalidEvents = eventsFor(w);
	const invalid = invalidEvents.find((e) => e.kind === "report-invalid");
	check("W3.3 readable-but-invalid report → report-invalid (distinct kind+message)", invalid !== undefined, kindsOf(invalidEvents));
	check(
		"W3.3b report-invalid quotes the validation error and says diagnose",
		!!invalid && /status/.test(invalid.message) && /diagnos/i.test(invalid.message),
		invalid?.message ?? "",
	);
	check("W3.3c invalid never claims ready", !kindsOf(invalidEvents).includes("report-ready"));

	writeFileSync(p, "{half"); // mid-write
	check("W3.4 mid-write JSON → report-invalid, never a throw", eventsFor(w).some((e) => e.kind === "report-invalid"));
}

// ---------------------------------------------------------------------------
// W4. mailbox-question
// ---------------------------------------------------------------------------

{
	const dir = taskDir("question");
	const w = mkWorker(dir, "w-question");
	check("W4.1 no q-file → no question event", !kindsOf(eventsFor(w)).includes("mailbox-question"));
	writeFileSync(
		questionPathFor(dir, "w-question"),
		JSON.stringify({ worker: "w-question", ts: "2026-09-06T12:00:00.000Z", question: "Which branch?", options: ["main", "dev"] }),
	);
	const q = eventsFor(w).find((e) => e.kind === "mailbox-question");
	check("W4.2 q-file → mailbox-question", q !== undefined, kindsOf(eventsFor(w)));
	check(
		"W4.2b question text, options and the delegate_mailbox action reach the text",
		!!q && q.message.includes("Which branch?") && q.message.includes("main | dev") && /delegate_mailbox/.test(q.message),
		q?.message ?? "",
	);
	writeFileSync(questionPathFor(dir, "w-question"), "{not json");
	check("W4.3 corrupt q-file → no question event, never a throw", !kindsOf(eventsFor(w)).includes("mailbox-question"));
}

// ---------------------------------------------------------------------------
// W5. grill-deck (session JSONL scan)
// ---------------------------------------------------------------------------

{
	const dir = taskDir("grill");
	const w = mkWorker(dir, "w-grill");
	w.sessionPath = writeSession(dir, "w-grill", [assistantUsage(1000), assistantToolCall("bash")]);
	check("W5.1 session without grill_deck → no event", !kindsOf(eventsFor(w)).includes("grill-deck"));

	w.sessionPath = writeSession(dir, "w-grill-deck", [assistantUsage(1000), assistantToolCall(GRILL_DECK_TOOL)]);
	const g = eventsFor(w).find((e) => e.kind === "grill-deck");
	check("W5.2 grill_deck toolCall → grill-deck event", g !== undefined, kindsOf(eventsFor(w)));
	check("W5.2b grill-deck says a human must answer at the worker's pane", !!g && /pane/.test(g.message) && /human/i.test(g.message), g?.message ?? "");
	check("W5.3 countSessionToolCall counts decks", countSessionToolCall(w.sessionPath, GRILL_DECK_TOOL) === 1);
	check("W5.3b missing session → no tool calls, never a throw", sessionToolCallNames(join(dir, "nope.jsonl")).length === 0);

	const corrupt = join(dir, "corrupt.jsonl");
	writeFileSync(corrupt, `{"message":{broken\n${JSON.stringify(assistantToolCall(GRILL_DECK_TOOL))}\n`);
	check("W5.4 corrupt/partial line skipped, deck still found", countSessionToolCall(corrupt, GRILL_DECK_TOOL) === 1);

	// Tail-window contract (§21): a 10 s poll must not re-parse whole sessions.
	const padLine = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] } });
	const beyond = join(dir, "beyond.jsonl");
	writeFileSync(beyond, `${JSON.stringify(assistantToolCall(GRILL_DECK_TOOL))}\n${`${padLine}\n`.repeat(700)}`);
	check("W5.5 deck beyond the tail window is not reported", countSessionToolCall(beyond, GRILL_DECK_TOOL) === 0);
	const inside = join(dir, "inside.jsonl");
	writeFileSync(inside, `${`${padLine}\n`.repeat(700)}${JSON.stringify(assistantToolCall(GRILL_DECK_TOOL))}\n`);
	check("W5.6 deck inside the tail window is reported", countSessionToolCall(inside, GRILL_DECK_TOOL) === 1);
}

// ---------------------------------------------------------------------------
// W6. context-critical
// ---------------------------------------------------------------------------

{
	const dir = taskDir("context");
	const w = mkWorker(dir, "w-ctx");
	w.sessionPath = writeSession(dir, "w-ctx-cold", [assistantUsage(100_000)]); // 40 % of 250 100
	check("W6.1 ctx 40 % → no context-critical", !kindsOf(eventsFor(w)).includes("context-critical"), kindsOf(eventsFor(w)));

	w.sessionPath = writeSession(dir, "w-ctx-hot", [assistantUsage(100_000), assistantUsage(240_000)]); // 96 %
	const c = eventsFor(w).find((e) => e.kind === "context-critical");
	check("W6.2 ctx ≥ 90 % → context-critical", c !== undefined, kindsOf(eventsFor(w)));
	check("W6.2b context-critical names the pct and the wrap-up action", !!c && /96%/.test(c.message) && /steer/i.test(c.message), c?.message ?? "");
	check("W6.3 threshold is injectable (99 % → silent)", !kindsOf(eventsFor(w, { contextCriticalPct: 99 })).includes("context-critical"));
	w.sessionPath = undefined;
	check("W6.4 no session path → gauge unknown, never trips", !kindsOf(eventsFor(w)).includes("context-critical"));
}

// ---------------------------------------------------------------------------
// W7. worker-dead + suppressions
// ---------------------------------------------------------------------------

{
	const dir = taskDir("dead");
	const w = mkWorker(dir, "w-dead");
	const deadEvents = eventsFor(w, { statuses: NO_STATUS });
	const dead = deadEvents.find((e) => e.kind === "worker-dead");
	check("W7.1 no live status + no report → worker-dead", dead !== undefined, kindsOf(deadEvents));
	check(
		"W7.1b worker-dead names the failed-spawn move (pane read + diagnosed retry)",
		!!dead && /pane/.test(dead.message) && /retry/i.test(dead.message),
		dead?.message ?? "",
	);
	check("W7.2 live worker → no worker-dead", !kindsOf(eventsFor(w, { statuses: [LIVE("w-dead")] })).includes("worker-dead"));
	check("W7.3 idle-but-known worker (finished, not gone) → no worker-dead", !kindsOf(eventsFor(w, { statuses: [{ name: "w-dead", status: "idle" }] })).includes("worker-dead"));
	check("W7.4 herdr unreachable (statuses unknown) → NOBODY is declared dead", !kindsOf(eventsFor(w, { statuses: null })).includes("worker-dead"), kindsOf(eventsFor(w, { statuses: null })));

	const withReport = mkWorker(dir, "w-dead-report");
	writeValidReport(dir, "w-dead-report");
	check("W7.5 report on disk → not dead", !kindsOf(eventsFor(withReport, { statuses: NO_STATUS })).includes("worker-dead"));

	const fresh = mkWorker(dir, "w-fresh", { startedAt: new Date(NOW - 1000).toISOString() });
	check("W7.6 placement grace window suppresses worker-dead", !kindsOf(eventsFor(fresh, { statuses: NO_STATUS })).includes("worker-dead"), kindsOf(eventsFor(fresh, { statuses: NO_STATUS })));
	check("W7.6b grace is the documented 60 s", WATCH_DEAD_GRACE_MS === 60_000);

	const probe = mkWorker(taskDir("_probe"), "w-probe");
	check("W7.7 probe runs expect no report → never worker-dead", !kindsOf(eventsFor(probe, { statuses: NO_STATUS })).includes("worker-dead"), kindsOf(eventsFor(probe, { statuses: NO_STATUS })));
}

// ---------------------------------------------------------------------------
// W8. Dedup and state reset
// ---------------------------------------------------------------------------

{
	const dir = taskDir("dedup");
	const w = mkWorker(dir, "w-dedup");
	writeValidReport(dir, "w-dedup");
	const snap = snapshotFor([w], [LIVE("w-dedup")]);
	const seen = new Set<string>();
	const first = detectEvents(snap, seen, { nowMs: NOW });
	const second = detectEvents(snap, seen, { nowMs: NOW });
	check("W8.1 first tick fires report-ready", first.some((e) => e.kind === "report-ready"), kindsOf(first));
	check("W8.2 identical second tick fires nothing (dedup)", second.length === 0, kindsOf(second));

	rmSync(reportPathFor(dir, "w-dedup"));
	check("W8.3 removed report produces no new event", detectEvents(snap, seen, { nowMs: NOW }).length === 0);
	writeValidReport(dir, "w-dedup");
	check("W8.4 report re-appearing re-fires (state reset)", detectEvents(snap, seen, { nowMs: NOW }).some((e) => e.kind === "report-ready"));

	const p = reportPathFor(dir, "w-dedup");
	utimesSync(p, new Date(NOW + 60_000), new Date(NOW + 60_000));
	check("W8.5 rewritten report (new mtime) is a new fact → re-fires", detectEvents(snap, seen, { nowMs: NOW }).some((e) => e.kind === "report-ready"));

	const qdir = taskDir("dedup-q");
	const qw = mkWorker(qdir, "w-ask");
	const qsnap = snapshotFor([qw], [LIVE("w-ask")]);
	const qseen = new Set<string>();
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T1", question: "first?" }));
	check("W8.6 question fires once", detectEvents(qsnap, qseen, { nowMs: NOW }).filter((e) => e.kind === "mailbox-question").length === 1);
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T1", question: "first?" }));
	check("W8.7 the SAME question is not re-fired", detectEvents(qsnap, qseen, { nowMs: NOW }).length === 0);
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T2", question: "second?" }));
	check("W8.8 a NEW question (new envelope ts) re-fires", detectEvents(qsnap, qseen, { nowMs: NOW }).some((e) => e.kind === "mailbox-question"));

	// A SECOND deck is a new question set → re-fires (fingerprint = deck count).
	const gdir = taskDir("dedup-deck");
	const gw = mkWorker(gdir, "w-deck");
	gw.sessionPath = writeSession(gdir, "w-deck", [assistantToolCall(GRILL_DECK_TOOL)]);
	const gsnap = snapshotFor([gw], [LIVE("w-deck")]);
	const gseen = new Set<string>();
	check("W8.8b first deck fires", detectEvents(gsnap, gseen, { nowMs: NOW }).some((e) => e.kind === "grill-deck"));
	check("W8.8c same deck count does not re-fire", detectEvents(gsnap, gseen, { nowMs: NOW }).length === 0);
	writeFileSync(gw.sessionPath, readFileSync(gw.sessionPath, "utf8") + JSON.stringify(assistantToolCall(GRILL_DECK_TOOL)) + "\n");
	check("W8.8d a SECOND deck re-fires", detectEvents(gsnap, gseen, { nowMs: NOW }).some((e) => e.kind === "grill-deck"));

	// Worker removed from manifests entirely → its memory is pruned, not leaked.
	const empty = workersFromManifests([], [LIVE("w-dedup")], {}, NOW);
	check("W8.9 empty snapshot forgets nothing it never saw", detectEvents(empty, seen, { nowMs: NOW }).length === 0);
}

// ---------------------------------------------------------------------------
// W9. Batch delivery through the loop
// ---------------------------------------------------------------------------

{
	const dir = taskDir("loop");
	const w = mkWorker(dir, "w-loop");
	const sent: string[] = [];
	const transport = { listStatuses: async () => [LIVE("w-loop")] } as unknown as Transport;
	let snap = snapshotFor([w], [LIVE("w-loop")]);

	const handle = createWatcher({
		transport,
		intervalMs: 3_600_000, // driven by hand — the test never waits on a timer
		send: (text: string) => {
			sent.push(text);
		},
		snapshot: async () => snap,
		log: () => {},
	});

	check("W9.1 quiet tick returns nothing and sends nothing", (await handle.tick()).length === 0 && sent.length === 0);

	writeValidReport(dir, "w-loop");
	snap = snapshotFor([w], [LIVE("w-loop")]);
	const batch = await handle.tick();
	check("W9.2 report landing → exactly one batch event", batch.length === 1 && batch[0].kind === "report-ready", kindsOf(batch));
	check("W9.3 ONE send per batch (not one per event)", sent.length === 1, String(sent.length));
	check(
		"W9.3b the batch text names worker, kind and the concrete next action",
		sent[0].includes("w-loop") && sent[0].includes("report-ready") && sent[0].includes(reportPathFor(dir, "w-loop")),
		sent[0],
	);
	check("W9.4 second identical tick is silent", (await handle.tick()).length === 0 && sent.length === 1);

	// A second worker in the same batch → still ONE message.
	const w2 = mkWorker(dir, "w-loop2");
	writeValidReport(dir, "w-loop2");
	writeFileSync(questionPathFor(dir, "w-loop"), JSON.stringify({ worker: "w-loop", ts: "T9", question: "still ok?" }));
	snap = snapshotFor([w, w2], [LIVE("w-loop"), LIVE("w-loop2")]);
	const batch2 = await handle.tick();
	check("W9.5 multi-event tick → one send carrying all events", batch2.length === 2 && sent.length === 2 && (sent[1].match(/- \[/g) ?? []).length === 2, kindsOf(batch2));
	handle.stop();
	handle.stop();
	check("W9.6 stop() is idempotent", true);

	// Throwing sink: logged and skipped, the loop survives (advisory by contract).
	const sinkSnap = snapshotFor([mkWorker(dir, "w-boom")], [LIVE("w-boom")]);
	writeValidReport(dir, "w-boom");
	let logs = 0;
	const boom = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => {
			throw new Error("sink exploded");
		},
		snapshot: async () => sinkSnap,
		log: () => {
			logs++;
		},
	});
	await boom.tick();
	check("W9.7 throwing send never propagates and is logged", logs === 1);
	boom.stop();

	// Unreachable herdr: no throw, no dead-worker invention.
	const blindTransport = {
		listStatuses: async () => {
			throw new Error("herdr unreachable");
		},
	} as unknown as Transport;
	const blind = createWatcher({ transport: blindTransport, intervalMs: 3_600_000, send: () => {}, log: () => {} });
	const blindEvents = await blind.tick();
	check("W9.8 unreachable herdr → tick survives, no worker-dead invented", blindEvents.every((e) => e.kind !== "worker-dead"), kindsOf(blindEvents));
	blind.stop();

	check(
		"W9.9 formatEventBatch names worker, kind and action",
		(() => {
			const text = formatEventBatch([{ worker: "w1", dir: "/tmp/exchange/t", kind: "report-ready", message: "read /x/y" }]);
			return text.includes("w1") && text.includes("report-ready") && text.includes("read /x/y");
		})(),
	);

	// The timer path (not just hand-driven ticks): a 40 ms poller must deliver on
	// its own — this is what "end your turn" buys, so it is pinned here.
	{
		const tdir = taskDir("timer");
		const tw = mkWorker(tdir, "w-timer");
		const got: string[] = [];
		const th = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-timer")] } as unknown as Transport,
			intervalMs: 40,
			send: (t: string) => {
				got.push(t);
			},
			snapshot: async () => snapshotFor([tw], [LIVE("w-timer")]),
			log: () => {},
		});
		await new Promise<void>((res) => setTimeout(res, 60));
		check("W9.10 idle poll sends nothing", got.length === 0);
		writeValidReport(tdir, "w-timer");
		const deadline = Date.now() + 3_000;
		while (got.length === 0 && Date.now() < deadline) await new Promise<void>((res) => setTimeout(res, 40));
		check("W9.11 the interval delivers without a hand-driven tick", got.length === 1 && got[0].includes("w-timer"), JSON.stringify(got));
		th.stop();
		const after = got.length;
		await new Promise<void>((res) => setTimeout(res, 120));
		check("W9.12 stop() really clears the timer", got.length === after, String(got.length));
	}
}

// ---------------------------------------------------------------------------
// W10. Headless/old build + lifecycle registry
// ---------------------------------------------------------------------------

{
	// Old/headless build: the method is absent (or present-but-undefined) → the
	// sender must be a no-op, never a throw on every tick.
	let threw = false;
	try {
		makeSender({} as never)("wake");
		makeSender({ sendUserMessage: undefined } as never)("wake");
	} catch {
		threw = true;
	}
	check("W10.1 no usable pi.sendUserMessage → inert, never throws", !threw);

	const delivered: Array<{ content: string; deliverAs?: string }> = [];
	const active = makeSender({
		sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => {
			delivered.push({ content, deliverAs: options?.deliverAs });
		},
	});
	active("wake up");
	check(
		"W10.2 sender uses deliverAs:'followUp' (wakes idle, never interrupts a turn)",
		delivered.length === 1 && delivered[0].content === "wake up" && delivered[0].deliverAs === "followUp",
		JSON.stringify(delivered),
	);

	const transportFor = (statuses: AgentStatus[]): Transport => ({ listStatuses: async () => statuses }) as unknown as Transport;
	const fakePi = { sendUserMessage: () => {} } as never;
	const stop1 = startWatcher(fakePi, transportFor([]), { cwd: FIX });
	const stop2 = startWatcher(fakePi, transportFor([]), { cwd: FIX }); // double start replaces
	stop1();
	stop2();
	stopWatcher();
	stopWatcher();
	check("W10.3 startWatcher/stopWatcher registry is idempotent", typeof stop1 === "function" && typeof stop2 === "function");

	// A session whose manager throws must still mount (self-id degrades).
	const stop3 = startWatcher(fakePi, transportFor([]), {
		cwd: FIX,
		sessionManager: {
			getSessionFile: () => {
				throw new Error("no session file");
			},
		},
	});
	check("W10.4 throwing sessionManager does not stop the mount", typeof stop3 === "function");
	stopWatcher();
}

// ---------------------------------------------------------------------------
// W11. Self-filter — a worker session is not an audience
// ---------------------------------------------------------------------------

{
	const dir = taskDir("self");
	const w = mkWorker(dir, "w-self");
	writeValidReport(dir, "w-self");
	w.sessionPath = join(dir, "session-self.jsonl");
	writeFileSync(w.sessionPath, "");

	const bySession = snapshotFor([w], [LIVE("w-self")], { sessionFile: w.sessionPath });
	check("W11.1 self identified by session path", bySession.workers[0]?.self === true);
	const byCwd = snapshotFor([w], [LIVE("w-self")], { cwd: "/tmp/wt/w-self" });
	check("W11.2 self identified by worktree checkout path", byCwd.workers[0]?.self === true);
	const tab = snapshotFor([mkWorker(dir, "w-tab", { kind: "tab" })], [LIVE("w-tab")], { cwd: "/tmp/wt/w-tab" });
	check("W11.3 tab worker is NOT muted on cwd (shared checkout is ambiguous)", tab.workers[0]?.self === false);
	check("W11.4 another session is not self", snapshotFor([w], [LIVE("w-self")], { cwd: "/elsewhere", sessionFile: "/elsewhere.jsonl" }).workers[0]?.self === false);

	// Delivery-level mute lives in the loop: a leaf (worktree) worker session that
	// sees its own report land must stay silent.
	const sent: string[] = [];
	const handle = createWatcher({
		transport: { listStatuses: async () => [LIVE("w-self")] } as unknown as Transport,
		intervalMs: 3_600_000,
		send: (t: string) => {
			sent.push(t);
		},
		snapshot: async () => bySession,
		self: { sessionFile: w.sessionPath },
		log: () => {},
	});
	const ev = await handle.tick();
	check("W11.5 leaf worker session sends NOTHING for its own events", ev.length === 0 && sent.length === 0, JSON.stringify(sent));
	handle.stop();
}

// ---------------------------------------------------------------------------
// W12. Stale manifests are history, not a fleet
// ---------------------------------------------------------------------------

{
	const dir = taskDir("stale");
	const stale = mkWorker(dir, "w-stale", { startedAt: new Date(NOW - WATCH_LOOKBACK_MS - 60_000).toISOString() });
	const snap = snapshotFor([stale], NO_STATUS);
	check("W12.1 worker older than the lookback is dropped (no dead-worker spam)", snap.workers.length === 0, JSON.stringify(snap.workers.map((x) => x.name)));
	const mixed = snapshotFor([stale, mkWorker(dir, "w-fresh2")], NO_STATUS);
	check("W12.2 fresh workers in the same manifest survive", mixed.workers.some((x) => x.name === "w-fresh2"));
	const noStart = mkWorker(dir, "w-nostart", { startedAt: "not-a-date" });
	check("W12.3 unparseable startedAt is kept (tolerant, never dropped silently)", snapshotFor([noStart], NO_STATUS).workers.length === 1);

	// Real entry point smoke: whatever herdr state this host has, it must not throw.
	const s = await collectSnapshot({ listStatuses: async () => [] } as unknown as Transport, { cwd: FIX });
	check("W12.4 collectSnapshot returns a usable snapshot", Array.isArray(s.workers) && typeof s.statusesKnown === "boolean");
}

rmSync(FIX, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL WATCHER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
