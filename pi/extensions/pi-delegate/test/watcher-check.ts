/**
 * T-watch — event-driven background watcher checks (DESIGN.md §21).
 *
 * Run with: bun test/watcher-check.ts   (from the extension dir)
 *
 * Checks:
 *   W1  Package boundary (migration stage 3, audit step 9): the herdr adapter
 *       is published ONLY as the separate export subpath "./herdr" — module
 *       resolution enforces the import rule (the old W1.1/W1.1c text pins are
 *       gone; the boundary itself is pinned by static-check T1.1e);
 *       delegate resolves the settle gate from watch config and its E_TIMEOUT
 *       text carries the new-model discipline. Migration stage 3 (audit step
 *       10): the old W1.1b/W1.2/W1.2b index/observe TEXT pins are gone — the
 *       mount decision is behaviorally tested in test/composer-check.ts.
 *   W2  Config — watch.intervalMs / watch.settleGateMs defaults and overrides,
 *       in a child bun process with $HOME set at spawn time (bun caches
 *       os.homedir(), same seam as usage-check §2/§7).
 *   W3  report-ready + its distinct report-invalid message.
 *   W4  mailbox-question.
 *   W5  grill-deck (session JSONL scan, corrupt lines, tail window).
 *   W6  context-critical.
 *       W7  worker-dead + every suppression (live, herdr unreachable, report on
 *           disk, placement grace, probe run); since watcher stage C the branch
 *           is ALSO the explicit missing-report state for a SETTLED worker
 *           (done/idle, still live) — guideline §6.2.1.
 *   W8  Dedup: fires once per worker+kind+fingerprint; a condition that stops
 *       being true resets its key; a rewritten report / re-asked question is a
 *       NEW fact and re-fires; a worker that leaves the manifests is forgotten.
 *   W9  Batch delivery through the loop: one send per batch, quiet ticks send
 *       nothing, a throwing sink/transport never breaks the loop, a FAILED
 *       delivery rolls its keys back and re-fires next tick.
 *   W10 Headless/old build: sender inert without pi.sendUserMessage; registry
 *       start/stop idempotent.
 *   W11 Self-filter: a worker session is not woken for its own events.
 *   W12 Stale manifests (older than the lookback) are ignored.
 *   W13 collectedAt (field fix): a worker the manifest marks collected
 *       produces NO report-ready/report-invalid (fresh-session dedup); the
 *       field threads through workersFromManifests; other kinds still fire;
 *       without the field report events fire as before (regression).
 *   W14 Ownership + worker gate (v1.11.x): isWorkerSession (sessionPath /
 *       checkoutPath / foreign / garbage); a worker owned by ANOTHER session
 *       is silent across every kind, own owner and legacy manifests fire as
 *       before; orchestratorSessionPath threads onto WatchWorker and the loop
 *       wakes only the owning session (WatcherDeps.self threading).
 *   W15 worker-stale (v1.12.1, §22): collectedAt older than watch.staleAfterMs
 *       + still live → fires once with a /delegate-teardown action; silent
 *       below the threshold, without collectedAt, when not live, and for
 *       foreign-owned workers; fingerprint = collectedAt (re-collect re-arms);
 *       config default/override/floor.
 *   W16 F6 two-tier wake-up: ownsChildManifests (lead / pure worker / peer
 *       orchestrator / garbage); a worker-orchestrator's own children fire
 *       while its parent's manifest stays silent (F1 intact); the loop keeps
 *       the watcher alive for a worktree worker-orchestrator (leafWorker
 *       exemption); the worker-orchestrator mount decision is behaviorally
 *       tested in test/composer-check.ts (the old index.ts static pin is
 *       gone).
 * Exit 0 only if all checks pass.
 *
 *   W18 Result-plane states (watcher stage C, guideline §6.2): the
 *       missing-report wake is delivered and durably committed; the branch is
 *       not gated on collectedAt; a corrupt q-file is audited with its cause
 *       (zero wake-ups, zero records) and never masked as report-ready.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
	GRILL_DECK_TOOL,
	WATCH_DEAD_GRACE_MS,
	WATCH_DEFAULT_INTERVAL_MS,
	WATCH_DEFAULT_SETTLE_GATE_MS,
	WATCH_DEFAULT_STALE_AFTER_MS,
	WATCH_MIN_STALE_AFTER_MS,
	WATCH_LOOKBACK_MS,
	collectSnapshot,
	createWatcher,
	detectEvents,
	detectWorkerEvents,
	eventKey,
	formatEventBatch,
	isWorkerSession,
	makeSender,
	ownsChildManifests,
	resolveWatchConfig,
	startWatcher,
	stopWatcher,
	type DeliveryKey,
	workersFromManifests,
	type DetectOptions,
	type WatchEvent,
	type WatchSnapshot,
	type WatchWorker,
} from "../src/observe.ts";
import {
	appendDeliveredRecords,
	deliveredStorePathFor,
	deliveryRecordKey,
	questionPathFor,
	readDeliveredStore,
	reportPathFor,
	watcherKeyFor,
	type ExchangeManifest,
	type ManifestWorker,
} from "../src/exchange.ts";
import { countSessionToolCall, sessionToolCallNames } from "../src/usage.ts";
import type { AgentStatus, Transport } from "../src/host.ts";

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

// Migration stage 3 (audit step 9): the old W1.1/W1.1c TEXT pins (regex scans
// for herdr imports) are GONE — the import rule is enforced by module
// resolution now (package.json exports map: "." → index.ts, the adapter at
// the separate "./herdr" subpath); the boundary itself is pinned by
// static-check T1.1e.
// Migration stage 3 (audit step 10): the old W1.1b/W1.2/W1.2b TEXT pins
// (regex scans over index.ts/observe.ts source) are GONE — the mount
// decision is now behaviorally tested in test/composer-check.ts (M1–M5)
// against the composer module src/compose.ts (mountSessionWatcher), and the
// observe→seam import is compile-time enforced (Transport is a type from
// ./host.ts — a wrong import fails tsc, not a regex).

const delegateSrc = readFileSync(resolve(ROOT, "src/spawn.ts"), "utf8");
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
const observeSrcFull = readFileSync(resolve(ROOT, "src/observe.ts"), "utf8");
const statusSrc = observeSrcFull.slice(
	observeSrcFull.indexOf("SECTION 1/3"),
	observeSrcFull.indexOf("SECTION 2/3"),
);
check(
	"W1.6 delegate_status guideline: no polling loop, the watcher wakes you",
	/promptGuidelines[\s\S]*do NOT poll it in a loop[\s\S]*\]/.test(statusSrc),
);

// ---------------------------------------------------------------------------
// W2. Config — child bun process with $HOME at spawn time
// ---------------------------------------------------------------------------

const WATCH_MOD = new URL("../src/observe.ts", import.meta.url).pathname;

function watchConfigInHome(configJson: string): { intervalMs: number; settleGateMs: number; staleAfterMs: number; legacyFailOpen?: boolean; durableDelivery?: boolean; raw: string; stderr: string } {
	const home = mkdtempSync(join(tmpdir(), "watcher-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveWatchConfig} from ${JSON.stringify(WATCH_MOD)}; console.log(JSON.stringify(resolveWatchConfig()))`;
	// Fail-fast: a hung bun -e child (seen in shared-VM environments) must
	// surface as SPAWN FAILED, not freeze the whole check run forever.
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	rmSync(home, { recursive: true, force: true });
	const raw = res.stdout.toString().trim();
	const stderr = res.stderr.toString();
	try {
		return { ...JSON.parse(raw), raw, stderr };
	} catch {
		return { intervalMs: -1, settleGateMs: -1, staleAfterMs: -1, raw: `SPAWN FAILED: ${stderr.slice(0, 200)}`, stderr };
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
	check(
		`W2.8 staleAfterMs defaults to 30 min (${WATCH_DEFAULT_STALE_AFTER_MS})`,
		d.staleAfterMs === WATCH_DEFAULT_STALE_AFTER_MS && WATCH_MIN_STALE_AFTER_MS === 60_000,
		d.raw,
	);
	const staleCfg = watchConfigInHome(JSON.stringify({ watch: { staleAfterMs: 120_000 } }));
	check("W2.9 watch.staleAfterMs override", staleCfg.staleAfterMs === 120_000, staleCfg.raw);
	const staleFloor = watchConfigInHome(JSON.stringify({ watch: { staleAfterMs: 500, intervalMs: 5 } }));
	check(
		"W2.10 below-floor staleAfterMs falls back (floor 60 s), other keys still default",
		staleFloor.staleAfterMs === WATCH_DEFAULT_STALE_AFTER_MS && staleFloor.intervalMs === WATCH_DEFAULT_INTERVAL_MS,
		staleFloor.raw,
	);
	// Watcher stage A: watch.legacyFailOpen — absent → false (fail-closed
	// default); true → true (the explicit rollback); a non-boolean warns ONCE
	// on stderr and STAYS false (a typo must never silently enable the unsafe
	// legacy delivery).
	check("W2.11 no config → legacyFailOpen defaults false", d.legacyFailOpen === false, d.raw);
	const lf = watchConfigInHome(JSON.stringify({ watch: { legacyFailOpen: true } }));
	check("W2.12 watch.legacyFailOpen:true resolves true (explicit rollback)", lf.legacyFailOpen === true, lf.raw);
	const badLf = watchConfigInHome(JSON.stringify({ watch: { legacyFailOpen: "yes" } }));
	check(
		"W2.13 non-boolean legacyFailOpen → stays false + warn-once on stderr",
		badLf.legacyFailOpen === false && /legacyFailOpen/.test(badLf.stderr),
		`${badLf.raw} | stderr: ${badLf.stderr.slice(0, 200)}`,
	);
	// Watcher stage B: watch.durableDelivery — absent → TRUE (the safe value:
	// the durable dedup only ever SUPPRESSES a repeated wake-up); a present
	// boolean is used as-is (false = the emergency memory-only rollback); a
	// non-boolean warns ONCE and STAYS true (a typo must never silently
	// switch the durable dedup off).
	check("W2.14 no config → durableDelivery defaults true", d.durableDelivery === true, d.raw);
	const dd = watchConfigInHome(JSON.stringify({ watch: { durableDelivery: false } }));
	check("W2.15 watch.durableDelivery:false resolves false (emergency rollback)", dd.durableDelivery === false, dd.raw);
	const badDd = watchConfigInHome(JSON.stringify({ watch: { durableDelivery: "no" } }));
	check(
		"W2.16 non-boolean durableDelivery → stays true + warn-once on stderr",
		badDd.durableDelivery === true && /durableDelivery/.test(badDd.stderr),
		`${badDd.raw} | stderr: ${badDd.stderr.slice(0, 200)}`,
	);
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
 *  worker-dead detector stays out of unrelated scenarios).
 *  Watcher stage A defaults: a readable self id + the legacy fail-open
 *  rollback ON — tests that are not ABOUT ownership keep firing on legacy
 *  (no-owner) fixtures exactly as before the flip. Ownership tests pass
 *  explicit selfSessionFile/legacyFailOpen overrides (a spread key set to
 *  undefined overrides the default). */
const TEST_SELF = "/tmp/sessions/check-self.jsonl";
function eventsFor(
	w: ManifestWorker,
	opts: DetectOptions & { statuses?: AgentStatus[] | null; self?: { sessionFile?: string; cwd?: string } } = {},
): WatchEvent[] {
	const snap = snapshotFor([w], opts.statuses === undefined ? [LIVE(w.name)] : opts.statuses, opts.self ?? {}, opts.nowMs ?? NOW);
	return detectEvents(snap, newSeen(), { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true, ...opts });
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

/** Fresh memory cache for detectEvents (watcher stage B): the dedup state is a
 *  map from the canonical key to the PARSED DeliveryKey — never re-split from
 *  a string. */
const newSeen = (): Map<string, DeliveryKey> => new Map<string, DeliveryKey>();

/** THIS test audience's durable store for a task dir. */
const ownStore = (dir: string, sessionFile: string = TEST_SELF) =>
	readDeliveredStore(dir, watcherKeyFor(sessionFile));

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
	// Watcher stage C (guideline §6.2.5): the corrupt q-file is a result-plane
	// fact — audited with the cause, never masked as a report event.
	{
		const skips: Array<{ worker: string; reason: string; detail?: string }> = [];
		const corruptEvents = eventsFor(w, {
			onSkip: (worker, reason, detail) => skips.push({ worker, reason, detail }),
		});
		check(
			"W4.3b corrupt q-file → audited with the cause (onSkip 'corrupt-question'), no question/report event",
			!kindsOf(corruptEvents).includes("mailbox-question") &&
				!kindsOf(corruptEvents).includes("report-ready") &&
				skips.some((s) => s.worker === "w-question" && s.reason === "corrupt-question" && /JSON/i.test(s.detail ?? "")),
			`${kindsOf(corruptEvents)} ${JSON.stringify(skips)}`,
		);
		// A q-file that is valid JSON but not an envelope is invalid too (the
		// cause names the shape, not just the parse failure).
		writeFileSync(questionPathFor(dir, "w-question"), JSON.stringify({ hello: 1 }));
		const shapeSkips: string[] = [];
		eventsFor(w, { onSkip: (_w, reason, detail) => shapeSkips.push(`${reason}: ${detail}`) });
		check(
			"W4.3c a non-envelope q-file is invalid with a shape reason",
			shapeSkips.some((s) => s.startsWith("corrupt-question:") && /envelope/i.test(s)),
			JSON.stringify(shapeSkips),
		);
		// Cleanup so later blocks scanning this dir stay clean.
		rmSync(questionPathFor(dir, "w-question"), { force: true });
	}
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
	// Watcher stage C (guideline §6.2.1): a SETTLED worker (done/idle, still
	// known to herdr) without a report is the explicit missing-report state —
	// the same worker-dead branch, not silence.
	const settled = eventsFor(w, { statuses: [{ name: "w-dead", status: "idle" }] }).find((e) => e.kind === "worker-dead");
	check(
		"W7.3 settled (idle) worker WITHOUT a report → worker-dead names the missing report",
		!!settled && settled.message.includes(w.reportPath ?? "") && /no report/.test(settled.message),
		settled?.message ?? kindsOf(eventsFor(w, { statuses: [{ name: "w-dead", status: "idle" }] })),
	);
	const wSettledReport = mkWorker(dir, "w-settled-report");
	writeValidReport(dir, "w-settled-report");
	check(
		"W7.3b settled worker WITH a valid report → report-ready, never worker-dead",
		kindsOf(eventsFor(wSettledReport, { statuses: [{ name: "w-settled-report", status: "done" }] })) === "report-ready",
		kindsOf(eventsFor(wSettledReport, { statuses: [{ name: "w-settled-report", status: "done" }] })),
	);
	check(
		"W7.3c settled worker + herdr unreachable → silent (statuses unknown ≠ settled-dead)",
		!kindsOf(eventsFor(w, { statuses: null })).includes("worker-dead"),
		kindsOf(eventsFor(w, { statuses: null })),
	);
	const freshSettled = mkWorker(dir, "w-settled-fresh", { startedAt: new Date(NOW - 1000).toISOString() });
	check(
		"W7.3d the placement grace window suppresses the settled shape too",
		!kindsOf(eventsFor(freshSettled, { statuses: [{ name: "w-settled-fresh", status: "done" }] })).includes("worker-dead"),
		kindsOf(eventsFor(freshSettled, { statuses: [{ name: "w-settled-fresh", status: "done" }] })),
	);
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
// W18. Result-plane states (watcher stage C, guideline §6.2): a missing
// report, an invalid report and a corrupt q-file are VALID worker outcomes
// from the sensor's point of view — explicit, observable, and distinct from
// a router/delivery failure. The missing-report state lives in the
// worker-dead branch for BOTH episode shapes (gone from the host, settled
// without a report) and reaches the durable store like every kind; a
// corrupt q-file is audited with its cause and never masked as report-ready.
// ---------------------------------------------------------------------------

{
	// (1) The missing-report wake is delivered AND committed durably.
	{
		const dir = taskDir("stagec-missing");
		const w = mkWorker(dir, "w-missing");
		const status = { name: "w-missing", status: "done" } as AgentStatus;
		const snap = snapshotFor([w], [status]);
		const sent: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [status] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const b = await h.tick();
		check(
			"W18.1 settled-without-report → a delivered worker-dead wake naming the missing report",
			b.length === 1 && sent.length === 1 && b[0]?.kind === "worker-dead" && /no report/.test(b[0]?.message ?? ""),
			`${kindsOf(b)} ${JSON.stringify(sent)}`,
		);
		const store = ownStore(dir);
		const recs = Object.values(store.records);
		check(
			"W18.2 the missing-report wake is committed to the durable store with the launch-stamp episode fingerprint",
			recs.length === 1 && recs[0]?.kind === "worker-dead" && recs[0]?.fingerprint === w.startedAt,
			JSON.stringify(store.records),
		);
		h.stop();
	}

	// (2) The missing-report branch is NOT gated on collectedAt (guideline
	// §6.2.1): the branch is about an ABSENT report; the collect stamp
	// silences only the report branches.
	{
		const dir = taskDir("stagec-collected-missing");
		const w = mkWorker(dir, "w-collected-missing", { collectedAt: new Date(NOW - 60_000).toISOString() });
		check(
			"W18.3 collectedAt + report file gone + settled → worker-dead still fires (not collectedAt-gated)",
			kindsOf(eventsFor(w, { statuses: [{ name: "w-collected-missing", status: "done" }] })).includes("worker-dead"),
			kindsOf(eventsFor(w, { statuses: [{ name: "w-collected-missing", status: "done" }] })),
		);
		const wCollectedReport = mkWorker(dir, "w-collected-report", { collectedAt: new Date(NOW - 60_000).toISOString() });
		writeValidReport(dir, "w-collected-report");
		check(
			"W18.4 collected worker with the report still on disk + settled → silent (no dead wake, no report re-wake)",
			kindsOf(eventsFor(wCollectedReport, { statuses: [{ name: "w-collected-report", status: "done" }] })) === "",
			kindsOf(eventsFor(wCollectedReport, { statuses: [{ name: "w-collected-report", status: "done" }] })),
		);
	}

	// (3) Corrupt q-file through the LOOP: the default sink writes an audit
	// line with the cause; nothing is delivered or committed.
	{
		const dir = taskDir("stagec-corrupt-q");
		const w = mkWorker(dir, "w-corrupt-q");
		writeFileSync(questionPathFor(dir, "w-corrupt-q"), "{not json");
		const snap = snapshotFor([w], [LIVE("w-corrupt-q")]);
		const sent: string[] = [];
		const logs: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-corrupt-q")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: (m: string) => {
				logs.push(m);
			},
		});
		const b = await h.tick();
		check(
			"W18.5 corrupt q-file → zero wake-ups, zero durable records",
			b.length === 0 && sent.length === 0 && Object.keys(ownStore(dir).records).length === 0,
			`${kindsOf(b)} ${JSON.stringify(sent)}`,
		);
		check(
			"W18.6 corrupt q-file → an audit line with the cause (never masked as report-ready)",
			logs.some((m) => /corrupt q-file/.test(m) && /JSON/.test(m)),
			JSON.stringify(logs),
		);
		h.stop();
	}
}

// ---------------------------------------------------------------------------
// W8. Dedup and state reset
// ---------------------------------------------------------------------------

{
	const dir = taskDir("dedup");
	const w = mkWorker(dir, "w-dedup");
	writeValidReport(dir, "w-dedup");
	const snap = snapshotFor([w], [LIVE("w-dedup")]);
	const seen = newSeen();
	const first = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	const second = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check("W8.1 first tick fires report-ready", first.some((e) => e.kind === "report-ready"), kindsOf(first));
	check("W8.2 identical second tick fires nothing (dedup)", second.length === 0, kindsOf(second));

	rmSync(reportPathFor(dir, "w-dedup"));
	check("W8.3 removed report produces no new event", detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0);
	writeValidReport(dir, "w-dedup");
	// D1: the fingerprinted key now survives a no-observation tick, so the
	// re-appearance re-fires only when the fingerprint CHANGES. Force a distinct
	// mtime — two writes can land in the same millisecond, and an identical
	// fingerprint is deliberately NOT a new fact (the W16.16 contract).
	utimesSync(reportPathFor(dir, "w-dedup"), new Date(NOW + 30_000), new Date(NOW + 30_000));
	check("W8.4 report re-appearing with a NEW fingerprint re-fires", detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "report-ready"));

	const p = reportPathFor(dir, "w-dedup");
	utimesSync(p, new Date(NOW + 60_000), new Date(NOW + 60_000));
	check("W8.5 rewritten report (new mtime) is a new fact → re-fires", detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "report-ready"));

	const qdir = taskDir("dedup-q");
	const qw = mkWorker(qdir, "w-ask");
	const qsnap = snapshotFor([qw], [LIVE("w-ask")]);
	const qseen = newSeen();
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T1", question: "first?" }));
	check("W8.6 question fires once", detectEvents(qsnap, qseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).filter((e) => e.kind === "mailbox-question").length === 1);
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T1", question: "first?" }));
	check("W8.7 the SAME question is not re-fired", detectEvents(qsnap, qseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0);
	writeFileSync(questionPathFor(qdir, "w-ask"), JSON.stringify({ worker: "w-ask", ts: "T2", question: "second?" }));
	check("W8.8 a NEW question (new envelope ts) re-fires", detectEvents(qsnap, qseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "mailbox-question"));

	// A SECOND deck is a new question set → re-fires (fingerprint = deck count).
	const gdir = taskDir("dedup-deck");
	const gw = mkWorker(gdir, "w-deck");
	gw.sessionPath = writeSession(gdir, "w-deck", [assistantToolCall(GRILL_DECK_TOOL)]);
	const gsnap = snapshotFor([gw], [LIVE("w-deck")]);
	const gseen = newSeen();
	check("W8.8b first deck fires", detectEvents(gsnap, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "grill-deck"));
	check("W8.8c same deck count does not re-fire", detectEvents(gsnap, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0);
	writeFileSync(gw.sessionPath, readFileSync(gw.sessionPath, "utf8") + JSON.stringify(assistantToolCall(GRILL_DECK_TOOL)) + "\n");
	check("W8.8d a SECOND deck re-fires", detectEvents(gsnap, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "grill-deck"));

	// Worker removed from manifests entirely → its memory is pruned, not leaked.
	const empty = workersFromManifests([], [LIVE("w-dedup")], {}, NOW);
	check("W8.9 empty snapshot forgets nothing it never saw", detectEvents(empty, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0);

	// A worker that VANISHES from the manifests is forgotten too (QA F4): its keys
	// must not leak in a long-lived orchestrator, and if it comes back it must be
	// able to wake the orchestrator again (the old prefix-scoped reset did neither).
	const vdir = taskDir("dedup-vanish");
	const vw = mkWorker(vdir, "w-vanish");
	const vsnap = snapshotFor([vw], NO_STATUS); // not live, no report → worker-dead
	const vseen = newSeen();
	check("W8.10 dead worker fires once", detectEvents(vsnap, vseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "worker-dead"));
	check("W8.10b the key is held while the worker is in the snapshot", vseen.size === 1, JSON.stringify([...vseen]));
	detectEvents(workersFromManifests([], NO_STATUS, {}, NOW), vseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check("W8.11 worker gone from the manifests → its key is dropped (no leak, QA F4)", vseen.size === 0, JSON.stringify([...vseen]));
	check("W8.11b the same worker reappearing dead re-fires (no lost wake-up)", detectEvents(vsnap, vseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "worker-dead"));
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
		// Watcher stage A defaults for this non-ownership loop: a readable self
		// id + the legacy rollback ON (the fixture workers carry no owner
			// field — fail-closed would silence them all).
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
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
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: () => {
			logs++;
		},
	});
	await boom.tick();
	check("W9.7 throwing send never propagates and is logged", logs === 1);
	boom.stop();

	// Unreachable herdr: no throw, no dead-worker invention.
	const blindTransport = {
		backendName: () => "herdr",
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
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
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

	// A TRANSIENT send error must never permanently swallow a wake-up (the review's
	// most valuable minor): the batch's keys roll back out of `seen`, so the next
	// tick re-fires whatever is still true.
	{
		const rdir = taskDir("loop-retry");
		const rw = mkWorker(rdir, "w-retry");
		writeValidReport(rdir, "w-retry");
		const rsnap = snapshotFor([rw], [LIVE("w-retry")]);
		const rsent: string[] = [];
		let broken = true;
		const retry = createWatcher({
			transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				if (broken) {
					broken = false;
					throw new Error("transient send error");
				}
				rsent.push(t);
			},
			snapshot: async () => rsnap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const lost = await retry.tick();
		check("W9.13 failed send delivers nothing but returns the batch (nothing buffered)", lost.length === 1 && rsent.length === 0, kindsOf(lost));
		check("W9.13b the next tick re-fires what the failed send swallowed", (await retry.tick()).length === 1 && rsent.length === 1, JSON.stringify(rsent));
		check("W9.13c once delivery succeeds, dedup is back in charge", (await retry.tick()).length === 0 && rsent.length === 1, JSON.stringify(rsent));
		retry.stop();
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

	const transportFor = (statuses: AgentStatus[]): Transport => ({ backendName: () => "herdr", listStatuses: async () => statuses }) as unknown as Transport;
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
	const s = await collectSnapshot({ backendName: () => "herdr", listStatuses: async () => [] } as unknown as Transport, { cwd: FIX });
	check("W12.4 collectSnapshot returns a usable snapshot", Array.isArray(s.workers) && typeof s.statusesKnown === "boolean");
}

// ---------------------------------------------------------------------------
// W13. collectedAt — collect's delivered-trace silences the report kinds
// ---------------------------------------------------------------------------

{
	const dir = taskDir("collected");

	// (б) Regression: without collectedAt the report events fire as before.
	const wFresh = mkWorker(dir, "w-fresh-report");
	writeValidReport(dir, "w-fresh-report");
	check("W13.1 no collectedAt + valid report → report-ready (regression)", eventsFor(wFresh).some((e) => e.kind === "report-ready"), kindsOf(eventsFor(wFresh)));
	writeFileSync(reportPathFor(dir, "w-fresh-report"), "{half");
	check("W13.2 no collectedAt + invalid report → report-invalid (regression)", eventsFor(wFresh).some((e) => e.kind === "report-invalid"), kindsOf(eventsFor(wFresh)));

	// (а) The field threads through workersFromManifests…
	const wDone = mkWorker(dir, "w-done", { collectedAt: new Date(NOW - 60_000).toISOString() });
	writeValidReport(dir, "w-done");
	const doneSnap = snapshotFor([wDone], [LIVE("w-done")]);
	check("W13.3 collectedAt is threaded onto the WatchWorker", doneSnap.workers[0]?.collectedAt === wDone.collectedAt, JSON.stringify(doneSnap.workers[0]));
	// …and a COLLECTED report — valid or invalid — never wakes anyone again
	// (the field fix: the watcher's `seen` dedup cannot outlive the session).
	const doneEvents = eventsFor(wDone);
	check("W13.4 collectedAt + valid report → no report-ready", !doneEvents.some((e) => e.kind === "report-ready"), kindsOf(doneEvents));
	writeFileSync(reportPathFor(dir, "w-done"), "{half");
	check("W13.5 collectedAt + invalid report → no report-invalid", !eventsFor(wDone).some((e) => e.kind === "report-invalid"), kindsOf(eventsFor(wDone)));

	// Only the report kinds are suppressed: a collected worker asking a question
	// still wakes the orchestrator.
	writeFileSync(
		questionPathFor(dir, "w-done"),
		JSON.stringify({ worker: "w-done", ts: "T13", question: "still there?" }),
	);
	check("W13.6 collectedAt suppresses ONLY the report kinds", eventsFor(wDone).some((e) => e.kind === "mailbox-question"), kindsOf(eventsFor(wDone)));

	// Runtime-garbage collectedAt (a manifest is untyped JSON) is ignored —
	// the worker keeps firing.
	const wGarbage = mkWorker(dir, "w-garbage");
	(wGarbage as unknown as Record<string, unknown>).collectedAt = 42;
	writeValidReport(dir, "w-garbage");
	check("W13.7 non-string collectedAt is ignored (still fires)", eventsFor(wGarbage).some((e) => e.kind === "report-ready"), kindsOf(eventsFor(wGarbage)));
}

// ---------------------------------------------------------------------------
// W14. Ownership + worker gate (v1.11.x) — one orchestrator per wake-up
// ---------------------------------------------------------------------------

{
	const ORCH_A = "/tmp/sessions/orch-a.jsonl";
	const ORCH_B = "/tmp/sessions/orch-b.jsonl";

	// (а) isWorkerSession — the isSelf strictness over ALL manifests, no lookback:
	// it asks about a SESSION (which may outlive the 24 h fleet), not a live fleet.
	const gateDir = taskDir("gate");
	const gateWorker = mkWorker(gateDir, "w-gated");
	gateWorker.sessionPath = "/tmp/sessions/w-gated.jsonl";
	const gateManifest = manifestOf(gateDir, [gateWorker]);
	check("W14.1 gate matches by worker sessionPath", isWorkerSession({ sessionFile: gateWorker.sessionPath }, [gateManifest]));
	check(
		"W14.2 gate matches by worktree checkoutPath (spawn race: record predates the worker sessionPath)",
		isWorkerSession({ cwd: "/tmp/wt/w-gated" }, [gateManifest]),
	);
	const tabGate = manifestOf(gateDir, [mkWorker(gateDir, "w-gated-tab", { kind: "tab" })]);
	check(
		"W14.3 tab worker is NOT gated on cwd (shared checkout is ambiguous — same strictness as isSelf)",
		!isWorkerSession({ cwd: "/tmp/wt/w-gated-tab" }, [tabGate]),
	);
	check(
		"W14.4 an unrelated session (an orchestrator) is not gated",
		!isWorkerSession({ sessionFile: ORCH_A, cwd: "/repo" }, [gateManifest, tabGate]),
	);
	check("W14.5 no identity at all → not gated", !isWorkerSession({}, [gateManifest]));
	check(
		"W14.6 garbage manifests → false, never throws",
		(() => {
			try {
				const garbage = [
					{ task: "t", dir: "/tmp/exchange/t", workers: [{ name: "x", sessionPath: 42, placement: { kind: "weird" } }] },
					{ task: "u", dir: "/tmp/exchange/u", workers: "not-an-array" },
					null,
					{},
				] as unknown as ExchangeManifest[];
				const junkWorkers = { task: "v", dir: "d", workers: [null, undefined, 5, { placement: null }] } as unknown as ExchangeManifest;
				return (
					isWorkerSession({}, garbage) === false &&
					isWorkerSession({ sessionFile: "/tmp/x.jsonl", cwd: "/" }, [...garbage, junkWorkers]) === false
				);
			} catch {
				return false;
			}
		})(),
	);

	// (б) Ownership in detectWorkerEvents: a worker whose orchestratorSessionPath
	// is set and differs from the watcher's own session is silent — across EVERY
	// kind; own owner and legacy (no field) manifests behave exactly as before.
	const odir = taskDir("owned");
	const wReport = mkWorker(odir, "w-own-report", { orchestratorSessionPath: ORCH_A });
	writeValidReport(odir, "w-own-report");
	const wQuestion = mkWorker(odir, "w-own-question", { orchestratorSessionPath: ORCH_A });
	writeFileSync(questionPathFor(odir, "w-own-question"), JSON.stringify({ worker: "w-own-question", ts: "T14", question: "own?" }));
	const wDeck = mkWorker(odir, "w-own-deck", { orchestratorSessionPath: ORCH_A });
	wDeck.sessionPath = writeSession(odir, "w-own-deck", [assistantUsage(240_000), assistantToolCall(GRILL_DECK_TOOL)]); // context-critical + grill-deck
	const wDead = mkWorker(odir, "w-own-dead", { orchestratorSessionPath: ORCH_A });
	const silenced = (w: ManifestWorker, statuses: AgentStatus[] | null): boolean =>
		eventsFor(w, { statuses, selfSessionFile: ORCH_B }).length === 0;
	check("W14.7 foreign owner silences report-ready", silenced(wReport, [LIVE("w-own-report")]));
	check("W14.8 foreign owner silences mailbox-question", silenced(wQuestion, [LIVE("w-own-question")]));
	check(
		"W14.9 foreign owner silences grill-deck AND context-critical",
		silenced(wDeck, [LIVE("w-own-deck")]),
		kindsOf(eventsFor(wDeck, { statuses: [LIVE("w-own-deck")], selfSessionFile: ORCH_A })),
	);
	check("W14.10 foreign owner silences worker-dead", silenced(wDead, NO_STATUS));

	// Own owner → fires (the spawning session still hears its own fleet).
	check(
		"W14.11 OWN owner: every kind still fires",
		eventsFor(wReport, { statuses: [LIVE("w-own-report")], selfSessionFile: ORCH_A }).some((e) => e.kind === "report-ready") &&
			eventsFor(wDeck, { statuses: [LIVE("w-own-deck")], selfSessionFile: ORCH_A }).some((e) => e.kind === "grill-deck"),
	);

	// Legacy manifest (no field) → FAIL-CLOSED by default (watcher stage A):
	// a bystander session is no longer woken for an owner-less manifest, and
	// the skip is auditable via the onSkip hook. The explicit
	// watch.legacyFailOpen:true rollback restores the old delivery — which is
	// unsafe on a machine with several sessions. A degraded self-id is a
	// DIFFERENT edge: it delivers NOTHING with or without the flag (guideline
	// §3.6 — no configuration escape).
	const wLegacy = mkWorker(odir, "w-legacy");
	writeValidReport(odir, "w-legacy");
	{
		const legacySkips: Array<{ worker: string; reason: string }> = [];
		const legacyOff = eventsFor(wLegacy, {
			statuses: [LIVE("w-legacy")],
			selfSessionFile: ORCH_B,
			legacyFailOpen: false,
			onSkip: (worker, reason) => legacySkips.push({ worker, reason }),
		});
		check(
			"W14.12 legacy manifest (no orchestratorSessionPath) delivers NOTHING by default (fail-closed) with an audit skip reason",
			legacyOff.length === 0 &&
				legacySkips.some((s) => s.worker === "w-legacy" && s.reason === "no-owner"),
			`${kindsOf(legacyOff)} ${JSON.stringify(legacySkips)}`,
		);
		check(
			"W14.12b legacyFailOpen:true restores legacy delivery for the no-owner edge (explicit rollback)",
			eventsFor(wLegacy, { statuses: [LIVE("w-legacy")], selfSessionFile: ORCH_B, legacyFailOpen: true }).some(
				(e) => e.kind === "report-ready",
			),
		);
	}
	check(
		"W14.13 degraded self (no sessionFile) delivers NOTHING — fail-closed with AND without the flag (guideline §3.6)",
		eventsFor(wReport, { statuses: [LIVE("w-own-report")], selfSessionFile: undefined }).length === 0 &&
			eventsFor(wReport, { statuses: [LIVE("w-own-report")], selfSessionFile: undefined, legacyFailOpen: true }).length === 0,
	);

	// (в) The field threads through workersFromManifests onto WatchWorker…
	const ownedSnap = snapshotFor([wReport], [LIVE("w-own-report")]);
	check(
		"W14.14 orchestratorSessionPath threads onto the WatchWorker",
		ownedSnap.workers[0]?.orchestratorSessionPath === ORCH_A,
		JSON.stringify(ownedSnap.workers[0]),
	);
	// …runtime garbage (a manifest is untyped JSON) reads as absent → legacy.
	const wOwnGarbage = mkWorker(odir, "w-own-garbage");
	(wOwnGarbage as unknown as Record<string, unknown>).orchestratorSessionPath = 7;
	check(
		"W14.15 non-string orchestratorSessionPath is ignored (legacy behavior)",
		snapshotFor([wOwnGarbage], [LIVE("w-own-garbage")]).workers[0]?.orchestratorSessionPath === undefined,
	);

	// Loop level: WatcherDeps.self.sessionFile is threaded into detection — the
	// wake-up reaches ONLY the owning session's sink.
	{
		const ldir = taskDir("owned-loop");
		const wForeign = mkWorker(ldir, "w-foreign", { orchestratorSessionPath: ORCH_B });
		writeValidReport(ldir, "w-foreign");
		const wMine = mkWorker(ldir, "w-mine", { orchestratorSessionPath: ORCH_A });
		writeValidReport(ldir, "w-mine");
		const sent: string[] = [];
		const handle = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-foreign"), LIVE("w-mine")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snapshotFor([wForeign, wMine], [LIVE("w-foreign"), LIVE("w-mine")]),
			self: { sessionFile: ORCH_A },
			log: () => {},
		});
		const batch = await handle.tick();
		check(
			"W14.16 the loop wakes ONLY the owning session (WatcherDeps.self threading)",
			batch.length === 1 && batch[0].worker === "w-mine" && sent.length === 1 && sent[0].includes("w-mine"),
			`${kindsOf(batch)} ${JSON.stringify(sent)}`,
		);
		handle.stop();
	}

	// Spawn seam: no test drives registerDelegateTool.execute (no runtime seam to
	// assert the manifest write), so the spawn-side write is pinned statically —
	// same convention as W1.3–W1.5.
	check(
		"W14.17 delegate spawn records orchestratorSessionPath via the LIVE sessionManager getter",
		/getSessionFile/.test(delegateSrc) && /\.\.\.\(orchestratorSessionPath \? \{ orchestratorSessionPath \}/.test(delegateSrc),
	);

	// (г) B1 masterSessionPath fallback (diag-watch-crossfleet C1): a manifest
	// with NO worker-level orchestratorSessionPath but a manifest-level
	// masterSessionPath (the fleet's KNOWN owner, written since 1.15.0) must
	// stay SILENT for any other session — a foreign test fixture or a legacy
	// foreign manifest in the shared /tmp/exchange root must not wake a
	// bystander orchestrator. Fail-open only when NEITHER owner field exists
	// anywhere on the manifest (true legacy, W14.12/W16.14 semantics intact).
	const mdir = taskDir("master-owned");
	const wMasterForeign = mkWorker(mdir, "w-master-foreign");
	writeValidReport(mdir, "w-master-foreign");
	const masterManifest = (dir: string, worker: ManifestWorker, master?: string): ExchangeManifest => ({
		...manifestOf(dir, [worker]),
		...(master !== undefined ? { masterSessionPath: master } : {}),
	});
	const masterSnap = (worker: ManifestWorker, master?: string): WatchSnapshot =>
		workersFromManifests([masterManifest(dirname(worker.briefPath), worker, master)], [LIVE(worker.name)], {}, NOW);
	check(
		"W14.18 masterSessionPath threads onto the WatchWorker",
		masterSnap(wMasterForeign, ORCH_A).workers[0]?.masterSessionPath === ORCH_A,
	);
	check(
		"W14.19 masterSessionPath ≠ self → SILENT (known foreign owner; bystander not woken)",
		detectWorkerEvents(masterSnap(wMasterForeign, ORCH_A).workers[0]!, { selfSessionFile: ORCH_B, nowMs: NOW }).length === 0,
	);
	check(
		"W14.20 masterSessionPath === self → fires (the fleet's declared owner hears its worker)",
		detectWorkerEvents(masterSnap(wMasterForeign, ORCH_A).workers[0]!, { selfSessionFile: ORCH_A, nowMs: NOW }).some((e) => e.kind === "report-ready"),
	);
	check(
		"W14.21 masterSessionPath absent + no orchestratorSessionPath → fail-closed by default (audit skip), the flag restores legacy delivery",
		(() => {
			const skips: string[] = [];
			const off = detectWorkerEvents(masterSnap(wMasterForeign, undefined).workers[0]!, {
				selfSessionFile: ORCH_B,
				nowMs: NOW,
				onSkip: (worker, reason) => skips.push(`${worker}:${reason}`),
			});
			const on = detectWorkerEvents(masterSnap(wMasterForeign, undefined).workers[0]!, {
				selfSessionFile: ORCH_B,
				nowMs: NOW,
				legacyFailOpen: true,
			});
			return off.length === 0 && skips.includes("w-master-foreign:no-owner") && on.some((e) => e.kind === "report-ready");
		})(),
	);
	check(
		"W14.22 degraded self (no sessionFile) + foreign masterSessionPath → delivers NOTHING, flag or not (§3.6: no configuration escape)",
		detectWorkerEvents(masterSnap(wMasterForeign, ORCH_A).workers[0]!, { nowMs: NOW }).length === 0 &&
			detectWorkerEvents(masterSnap(wMasterForeign, ORCH_A).workers[0]!, { nowMs: NOW, legacyFailOpen: true }).length === 0,
	);
	const wMasterGarbage = mkWorker(mdir, "w-master-garbage");
	writeValidReport(mdir, "w-master-garbage");
	const garbageMasterManifest = {
		...manifestOf(mdir, [wMasterGarbage]),
		masterSessionPath: 42, // runtime garbage — a manifest is untyped JSON
	} as unknown as ExchangeManifest;
	const garbageMasterView = workersFromManifests([garbageMasterManifest], [LIVE("w-master-garbage")], {}, NOW).workers[0]!;
	check(
		"W14.23 non-string masterSessionPath is ignored (reads as no-owner: fail-closed by default, the flag restores legacy)",
		garbageMasterView.masterSessionPath === undefined &&
			detectWorkerEvents(garbageMasterView, { selfSessionFile: ORCH_B, nowMs: NOW }).length === 0 &&
			detectWorkerEvents(garbageMasterView, { selfSessionFile: ORCH_B, nowMs: NOW, legacyFailOpen: true }).some(
				(e) => e.kind === "report-ready",
			),
	);
}

// ---------------------------------------------------------------------------
// W15. worker-stale (v1.12.1, §22) — collected-and-still-mounted nudge
// ---------------------------------------------------------------------------

{
	const ORCH_A = "/tmp/sessions/orch-a.jsonl";
	const dir = taskDir("stale");
	const old = new Date(NOW - 31 * 60_000).toISOString();
	const fresh = new Date(NOW - 10 * 60_000).toISOString();
	const w = mkWorker(dir, "w-stale", { collectedAt: old });

	const staleEvents = eventsFor(w);
	const stale = staleEvents.find((e) => e.kind === "worker-stale");
	check("W15.1 old collectedAt + live → worker-stale", stale !== undefined, kindsOf(staleEvents));
	check(
		"W15.2 the message names the age, the mount and BOTH moves (/delegate-teardown or keep)",
		!!stale && /collected 31 min ago and still mounted/.test(stale.message) &&
			/delegate-teardown/.test(stale.message) && /or keep/.test(stale.message),
		stale?.message ?? "",
	);
	check("W15.3 below the 30-min threshold → silent", !eventsFor(mkWorker(dir, "w-stale", { collectedAt: fresh })).some((e) => e.kind === "worker-stale"));
	check("W15.4 no collectedAt → silent (never-collected workers never stale)", !eventsFor(mkWorker(dir, "w-stale")).some((e) => e.kind === "worker-stale"));
	check(
		"W15.5 not live (torn down / herdr gone) → silent",
		!eventsFor(mkWorker(dir, "w-stale", { collectedAt: old }), { statuses: NO_STATUS }).some((e) => e.kind === "worker-stale"),
	);
	check(
		"W15.6 herdr unreachable (statuses unknown) → silent, never a throw",
		!eventsFor(mkWorker(dir, "w-stale", { collectedAt: old }), { statuses: null }).some((e) => e.kind === "worker-stale"),
	);
	check(
		"W15.7 unparseable collectedAt → silent (tolerant)",
		!eventsFor(mkWorker(dir, "w-stale", { collectedAt: "garbage" })).some((e) => e.kind === "worker-stale"),
	);

	// Threshold is injectable (tests / per-mount overrides via startWatcher).
	check(
		"W15.8 custom staleAfterMs honored (huge → silent, 5 min → fires)",
		!eventsFor(w, { staleAfterMs: 24 * 60 * 60_000 }).some((e) => e.kind === "worker-stale") &&
			eventsFor(mkWorker(dir, "w-stale", { collectedAt: fresh }), { staleAfterMs: 5 * 60_000 }).some((e) => e.kind === "worker-stale"),
	);

	// Key hygiene: fires ONCE (dedup), re-arms on a NEW collectedAt (a re-collect
	// is a new fact), and the fingerprint IS the collectedAt stamp.
	{
		const snap = snapshotFor([w], [LIVE("w-stale")]);
		const seen = newSeen();
		check("W15.9 first tick fires once", detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).filter((e) => e.kind === "worker-stale").length === 1);
		check("W15.10 identical second tick is silent (dedup)", detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0);
		check(
			"W15.11 the dedup key carries the collectedAt fingerprint",
			seen.has(eventKey({ worker: "w-stale", dir, kind: "worker-stale", fingerprint: old })),
			JSON.stringify([...seen]),
		);
		const w2 = mkWorker(dir, "w-stale", { collectedAt: new Date(NOW - 40 * 60_000).toISOString() });
		const snap2 = snapshotFor([w2], [LIVE("w-stale")]);
		check(
			"W15.12 a re-collect (new collectedAt) re-arms the wake-up",
			detectEvents(snap2, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "worker-stale"),
		);
	}

	// Ownership: the foreign-fleet filter upstream already silences OTHER
	// sessions' stale workers — pinned here so it can never be bypassed.
	const wForeign = mkWorker(dir, "w-stale-foreign", { collectedAt: old, orchestratorSessionPath: ORCH_A });
	check(
		"W15.13 foreign-owned stale worker is silent (ownership, not bypassed)",
		eventsFor(wForeign, { selfSessionFile: "/tmp/sessions/orch-b.jsonl" }).length === 0,
		kindsOf(eventsFor(wForeign, { selfSessionFile: "/tmp/sessions/orch-b.jsonl" })),
	);
	check(
		"W15.14 OWN stale worker still fires (owner hears its own fleet)",
		eventsFor(wForeign, { selfSessionFile: ORCH_A }).some((e) => e.kind === "worker-stale"),
	);

	// startWatcher threads the config threshold into detection (static pin, same
	// convention as W14.17 — startWatcher needs a live pi to runtime-test).
	const watchSrcStale = readFileSync(resolve(ROOT, "src/observe.ts"), "utf8");
	check(
		"W15.15 startWatcher threads watch.staleAfterMs (§23 retireTtlMs and the stage-A legacyFailOpen) into detect opts",
		/staleAfterMs: cfg\.staleAfterMs/.test(watchSrcStale) &&
			/staleAfterMs: cfg\.staleAfterMs,[\s\S]*?retireTtlMs: cfg\.retireTtlMs,[\s\S]*?legacyFailOpen: cfg\.legacyFailOpen,/.test(watchSrcStale),
	);
}

// ---------------------------------------------------------------------------
// W16. F6 — two-tier wake-up: a worker-orchestrator keeps a watcher scoped to
// its OWN children (meta manifest: lead as worktree worker; child manifest:
// dev owned by the lead's session file)
// ---------------------------------------------------------------------------

{
	const META = "/tmp/sessions/f6-meta.jsonl";
	const LEAD = "/tmp/sessions/f6-lead.jsonl";
	const LEAD_CWD = "/tmp/wt/f6-lead";

	// (а) ownsChildManifests — the two-tier fixture.
	const metaDir = taskDir("f6-meta");
	const lead = mkWorker(metaDir, "lead-impl");
	lead.sessionPath = LEAD;
	lead.orchestratorSessionPath = META;
	const sibling = mkWorker(metaDir, "lead-sibling");
	sibling.sessionPath = "/tmp/sessions/f6-sibling.jsonl";
	sibling.orchestratorSessionPath = META;
	const pureWorker = mkWorker(metaDir, "lead-pure"); // nobody's orchestrator
	pureWorker.sessionPath = "/tmp/sessions/f6-pure.jsonl";
	pureWorker.orchestratorSessionPath = META;
	const metaManifest = manifestOf(metaDir, [lead, sibling, pureWorker]);

	const childDir = taskDir("f6-child");
	const dev = mkWorker(childDir, "dev-impl", { orchestratorSessionPath: LEAD });
	dev.sessionPath = "/tmp/sessions/f6-dev.jsonl";
	writeValidReport(childDir, "dev-impl");
	const childManifest = manifestOf(childDir, [dev]);
	const all = [metaManifest, childManifest];

	check(
		"W16.1 the lead IS a worker session (worktree worker of the meta manifest)",
		isWorkerSession({ sessionFile: LEAD, cwd: LEAD_CWD }, all),
	);
	check("W16.2 ownsChildManifests(lead) — the lead owns its dev's manifest", ownsChildManifests({ sessionFile: LEAD }, all));
	check(
		"W16.3 ownsChildManifests(pure worker) — a worker that spawned nothing is false",
		!ownsChildManifests({ sessionFile: "/tmp/sessions/f6-pure.jsonl" }, all),
	);
	check(
		"W16.4 ownsChildManifests(peer orchestrator) — the meta session owns the lead's entry",
		ownsChildManifests({ sessionFile: META }, all),
	);
	check(
		"W16.5 degraded self-id (no sessionFile) → false, never throws",
		!ownsChildManifests({}, all),
	);
	check(
		"W16.6 garbage manifests → false, never throws",
		(() => {
			try {
				const garbage = [
					{ task: "t", dir: "/tmp/exchange/t", workers: [{ name: "x", orchestratorSessionPath: 42 }, null, 5] },
					{ task: "u", dir: "/tmp/exchange/u", workers: "not-an-array" },
					null,
					{},
				] as unknown as ExchangeManifest[];
				return (
					ownsChildManifests({ sessionFile: LEAD }, garbage) === false &&
					ownsChildManifests({ sessionFile: LEAD }, [...garbage, childManifest]) === true
				);
			} catch {
				return false;
			}
		})(),
	);

	// (б) Detection scoping: with selfSessionFile = LEAD, the lead's OWN child
	// fires while the META fleet (foreign owner) stays silent — F1 intact.
	const snap = snapshotFor(
		[lead, sibling, pureWorker, dev],
		[LIVE("lead-impl"), LIVE("lead-sibling"), LIVE("lead-pure"), LIVE("dev-impl")],
		{ sessionFile: LEAD, cwd: LEAD_CWD },
	);
	const batch = detectEvents(snap, newSeen(), { nowMs: NOW, selfSessionFile: LEAD });
	check(
		"W16.7 the lead's watcher hears ITS OWN child's report-ready",
		batch.some((e) => e.kind === "report-ready" && e.worker === "dev-impl"),
		`${kindsOf(batch)} ${JSON.stringify(batch.map((e) => e.worker))}`,
	);
	check(
		"W16.8 the lead's watcher is SILENT about the meta manifest's workers (F1 ownership intact)",
		!batch.some((e) => e.worker === "lead-sibling" || e.worker === "lead-pure"),
		JSON.stringify(batch.map((e) => `${e.kind}/${e.worker}`)),
	);
	check(
		"W16.9 the lead is never woken for its own events (self-filter intact)",
		!batch.some((e) => e.worker === "lead-impl"),
	);

	// (в) Loop level: a worktree worker-orchestrator KEEPS its watcher — the
	// leafWorker mute must not swallow the child's report-ready (F6). Contrast
	// W11.5: a leaf worktree worker (nobody's orchestrator) still sends nothing.
	{
		const sent: string[] = [];
		const handle = createWatcher({
			transport: { listStatuses: async () => [] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: LEAD, cwd: LEAD_CWD },
			log: () => {},
		});
		const ev = await handle.tick();
		check(
			"W16.10 the loop delivers the child's report-ready to a worktree worker-orchestrator",
			ev.some((e) => e.kind === "report-ready" && e.worker === "dev-impl") && sent.length === 1,
			`${kindsOf(ev)} ${JSON.stringify(sent)}`,
		);
		check(
			"W16.11 the delivered batch carries no meta-manifest events (scoped)",
			sent.length === 1 && !sent[0].includes("lead-sibling") && !sent[0].includes("lead-pure"),
			sent[0] ?? "",
		);
		handle.stop();
	}

	// (г) Migration stage 3 (audit step 10): the old index.ts STATIC pins
	// (W16.12/W16.13 — regex scans over index.ts source for the F6 gate) are
	// GONE — the mount decision is behaviorally tested in test/composer-check.ts
	// (M1 pure worker silent, M2 worker-orchestrator mounts) against the
	// composer module src/compose.ts.

	// (д) Legacy fail-closed pin (watcher stage A): a worker-orchestrator's
	// watcher over a LEGACY parent manifest (workers without
	// orchestratorSessionPath) hears NOTHING from that fleet by default — the
	// canonical no-owner verdict is fail-closed, and the flag is what an
	// operator must set explicitly to restore the old delivery. Pinned here
	// so the fail-closed default is a conscious invariant, not an accident.
	{
		const legacyDir = taskDir("f6-meta-legacy");
		const legacyLead = mkWorker(legacyDir, "lead-impl");
		legacyLead.sessionPath = LEAD; // matched as a worker, but by sessionPath only
		delete (legacyLead as Partial<ManifestWorker>).orchestratorSessionPath; // legacy field absent
		const legacyWorker = mkWorker(legacyDir, "lead-sibling");
		legacyWorker.sessionPath = "/tmp/sessions/f6-legacy-sibling.jsonl";
		delete (legacyWorker as Partial<ManifestWorker>).orchestratorSessionPath;
		writeValidReport(legacyDir, "lead-sibling");
		const legacyManifest = manifestOf(legacyDir, [legacyLead, legacyWorker]);
		const legacyWorkerView = { ...legacyWorker, dir: legacyDir, collectedAt: undefined } as unknown as WatchWorker;
		const legacyOff = detectWorkerEvents(legacyWorkerView, { selfSessionFile: LEAD, nowMs: NOW });
		const legacyOn = detectWorkerEvents(legacyWorkerView, { selfSessionFile: LEAD, nowMs: NOW, legacyFailOpen: true });
		check(
			"W16.14 legacy manifest (no orchestratorSessionPath) delivers NOTHING to a worker-orchestrator's watcher by default (fail-closed)",
			legacyOff.length === 0,
			`${kindsOf(legacyOff)}`,
		);
		check(
			"W16.14b legacyFailOpen:true restores the legacy delivery to a worker-orchestrator's watcher (explicit rollback)",
			legacyOn.some((e) => e.kind === "report-ready" && e.worker === "lead-sibling"),
			`${kindsOf(legacyOn)}`,
		);
		check(
			"W16.15 the legacy lead still counts as a worker session (gate still matches it)",
			isWorkerSession({ sessionFile: LEAD, cwd: LEAD_CWD }, [legacyManifest]),
		);
	}
}

// ---------------------------------------------------------------------------
// W16.16 duplicate-wake guard (D1, diag-watch-crossfleet C5): the `seen` dedup
// state reset must NOT treat "no observation this tick" (e.g. a transient
// ENOENT on the report) as "condition stopped being true" for FINGERPRINTED
// kinds — the same fingerprint (mtime unchanged) must never fire twice.
// Fingerprinted kinds re-arm only on a NEW fingerprint or on the worker
// VANISHING from the snapshot; gauge/absence kinds (worker-dead etc.) keep the
// old reset semantics (they must fire exactly once).
// ---------------------------------------------------------------------------

{
	const dir = taskDir("dup-wake");
	const w = mkWorker(dir, "w-dup-wake");
	writeValidReport(dir, "w-dup-wake");
	const snap = snapshotFor([w], [LIVE("w-dup-wake")]);
	const seen = newSeen();

	// Tick 1: report readable → delivered exactly once.
	const t1 = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check(
		"W16.16 tick 1: readable report → report-ready delivered once",
		t1.filter((e) => e.kind === "report-ready").length === 1,
		kindsOf(t1),
	);

	// Tick 2: report transiently unreadable (rename-away → ENOENT) → no event,
	// and the fingerprinted seen-key must SURVIVE the missed observation.
	const p = reportPathFor(dir, "w-dup-wake");
	const parked = `${p}.parked`;
	renameSync(p, parked);
	const t2 = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check("W16.16b tick 2: renamed-away report → no event", t2.length === 0, kindsOf(t2));
	check(
		"W16.16c tick 2: the fingerprinted seen-key survives the missed observation",
		[...seen.keys()].some((k) => k.includes('"report-ready"')),
		JSON.stringify([...seen]),
	);

	// Tick 3: report back with the SAME mtime (rename-back) → NO second delivery.
	renameSync(parked, p);
	const t3 = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check(
		"W16.16d tick 3: same fingerprint restored → NO duplicate report-ready",
		t3.length === 0,
		kindsOf(t3),
	);

	// Contrast: the fingerprint CHANGES (mtime moves) → the event re-fires
	// (a rewritten report is a NEW fact — the W8.5 contract stays intact).
	utimesSync(p, new Date(NOW + 60_000), new Date(NOW + 60_000));
	const t4 = detectEvents(snap, seen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check(
		"W16.16e contrast: a CHANGED fingerprint (new mtime) re-fires",
		t4.some((e) => e.kind === "report-ready"),
		kindsOf(t4),
	);

	// Gauge/absence kinds now carry EPISODE fingerprints (watcher stage B,
	// guideline §5.4): worker-dead fingerprints by the manifest launch stamp.
	// The reset rule is therefore the uniform fingerprinted one — a herdr
	// status flap WITHIN one launch (dead → alive → dead again, same
	// startedAt) is the SAME death episode and does not re-fire; a NEW run of
	// the worker (new startedAt) is a NEW episode and wakes again. The durable
	// store removes records only when the worker really vanishes — never on a
	// skipped observation or a status flap.
	const gdir = taskDir("dup-wake-gauge");
	const gw = mkWorker(gdir, "w-dup-gauge");
	const gsnap = snapshotFor([gw], NO_STATUS); // not live, no report → worker-dead
	const gseen = newSeen();
	check(
		"W16.16f gauge kind (worker-dead) fires once",
		detectEvents(gsnap, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "worker-dead"),
	);
	check(
		"W16.16f2 the worker-dead key carries the launch-stamp episode fingerprint",
		[...gseen.values()].some((k) => k.kind === "worker-dead" && k.fingerprint === gw.startedAt),
		JSON.stringify([...gseen.values()]),
	);
	const gAlive = snapshotFor([gw], [LIVE("w-dup-gauge")]); // condition stops being true
	detectEvents(gAlive, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true });
	check(
		"W16.16g gauge kind: the key SURVIVES a status flap (the same launch = the same death episode; the durable record is not erased)",
		gseen.size === 1,
		JSON.stringify([...gseen.values()]),
	);
	check(
		"W16.16h gauge kind: dead again within the SAME launch → no second wake (one wake per episode)",
		detectEvents(gsnap, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).length === 0,
	);
	const gw2 = mkWorker(gdir, "w-dup-gauge", { startedAt: new Date(NOW - 5 * 60_000).toISOString() }); // a NEW run
	const gsnap2 = snapshotFor([gw2], NO_STATUS);
	check(
		"W16.16h2 gauge kind: a NEW launch (new startedAt) is a NEW death episode → re-fires",
		detectEvents(gsnap2, gseen, { nowMs: NOW, selfSessionFile: TEST_SELF, legacyFailOpen: true }).some((e) => e.kind === "worker-dead"),
	);
}


// ---------------------------------------------------------------------------
// W17. Durable delivery store (watcher stage B, guideline §5): the memory
// dedup is a CACHE of the per-task delivered-facts file — a commit happens
// ONLY after a successful send, a failed send never touches the disk, a
// failed commit is not a failed delivery, records are garbage-collected
// only when the worker really vanishes, and collectedAt never produces
// report records.
// ---------------------------------------------------------------------------

{
	// (1) Restart: deliver → a SECOND watcher instance (fresh memory, same
	// session path, same files) delivers NOTHING; a DIFFERENT audience still
	// delivers (the store is per-audience, not global).
	{
		const dir = taskDir("durable-restart");
		const w = mkWorker(dir, "w-restart");
		writeValidReport(dir, "w-restart");
		const snap = snapshotFor([w], [LIVE("w-restart")]);
		const sent1: string[] = [];
		const h1 = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-restart")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent1.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const b1 = await h1.tick();
		check("W17.1 the first watcher delivers the report-ready", b1.length === 1 && sent1.length === 1, kindsOf(b1));
		const store1 = ownStore(dir);
		const recKeys1 = Object.keys(store1.records);
		check(
			"W17.2 the delivered fact is committed to the durable store after the send (schema, audience path, one record)",
			recKeys1.length === 1 &&
				store1.schemaVersion === 1 &&
				store1.audienceSessionPath === TEST_SELF &&
				store1.records[recKeys1[0]!]?.worker === "w-restart" &&
				store1.records[recKeys1[0]!]?.kind === "report-ready" &&
				store1.records[recKeys1[0]!]?.deliveryMode === "sent",
			JSON.stringify(store1),
		);
		check(
			"W17.2b the record key is the canonical three-component JSON array",
			recKeys1[0] === deliveryRecordKey("w-restart", "report-ready", store1.records[recKeys1[0]!]?.fingerprint ?? ""),
			recKeys1[0] ?? "",
		);
		h1.stop();

		// Restart: a fresh watcher instance over the same files and the SAME
		// session path (same audience key → same store file).
		const sent2: string[] = [];
		const h2 = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-restart")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent2.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const b2 = await h2.tick();
		check(
			"W17.3 the restarted watcher delivers NOTHING on the same facts (durable dedup survives the restart)",
			b2.length === 0 && sent2.length === 0,
			`${kindsOf(b2)} ${JSON.stringify(sent2)}`,
		);
		h2.stop();

		// Pair check: a DIFFERENT audience (different session path → a
		// different store file) still delivers — guards against an accidentally
		// global store.
		const OTHER = "/tmp/sessions/other-audience.jsonl";
		const sent3: string[] = [];
		const h3 = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-restart")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent3.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: OTHER },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const b3 = await h3.tick();
		check(
			"W17.4 a DIFFERENT audience still delivers (the store is per-audience, never global)",
			b3.length === 1 && sent3.length === 1,
			`${kindsOf(b3)} ${JSON.stringify(sent3)}`,
		);
		check("W17.4b the other audience's store file is separate", Object.keys(ownStore(dir, OTHER).records).length === 1);
		h3.stop();
	}

	// (2) Send failure: a throwing sender (and a rejected-promise variant)
	// leaves the store untouched; the retry delivers exactly once and writes
	// exactly one record per event. Silent mode: no record, memory suppresses.
	{
		const dir = taskDir("durable-sendfail");
		const w = mkWorker(dir, "w-sendfail");
		writeValidReport(dir, "w-sendfail");
		const snap = snapshotFor([w], [LIVE("w-sendfail")]);
		const mk = (send: (t: string) => unknown) =>
			createWatcher({
				transport: { listStatuses: async () => [LIVE("w-sendfail")] } as unknown as Transport,
				intervalMs: 3_600_000,
				send: send as (text: string) => never,
				snapshot: async () => snap,
				self: { sessionFile: TEST_SELF },
				detect: { legacyFailOpen: true },
				log: () => {},
			});

		// (a) synchronously throwing sender → nothing on disk…
		const hThrow = mk(() => {
			throw new Error("send exploded");
		});
		const bThrow = await hThrow.tick();
		check("W17.5 a throwing send delivers nothing", bThrow.length === 1, kindsOf(bThrow));
		check("W17.5b a failed send writes NOTHING to the durable store", Object.keys(ownStore(dir).records).length === 0);
		// …and the retry delivers exactly once, committing exactly one record.
		let deliveredOnce = false;
		const hRetry = mk((t: string) => {
			if (!deliveredOnce) {
				deliveredOnce = true;
				return;
			}
			throw new Error("should not be called twice");
		});
		const bRetry = await hRetry.tick();
		check("W17.6 the retry delivers exactly once after the failed send", bRetry.length === 1 && deliveredOnce, kindsOf(bRetry));
		check(
			"W17.6b the retry commits exactly one record for the event",
			Object.keys(ownStore(dir).records).length === 1,
			JSON.stringify(ownStore(dir)),
		);
		check("W17.6c the event never fires a third time", (await hRetry.tick()).length === 0);
		hThrow.stop();
		hRetry.stop();

		// (b) rejected-promise variant: an async send failure is the same —
		// nothing on disk (the tick awaits the send inside the error guard).
		{
			const dirP = taskDir("durable-sendfail-async");
			const wP = mkWorker(dirP, "w-sendfail-async");
			writeValidReport(dirP, "w-sendfail-async");
			const snapP = snapshotFor([wP], [LIVE("w-sendfail-async")]);
			const hP = createWatcher({
				transport: { listStatuses: async () => [LIVE("w-sendfail-async")] } as unknown as Transport,
				intervalMs: 3_600_000,
				send: async () => {
					throw new Error("async send failure");
				},
				snapshot: async () => snapP,
				self: { sessionFile: TEST_SELF },
				detect: { legacyFailOpen: true },
				log: () => {},
			});
			const bP = await hP.tick();
			check("W17.7 a REJECTED send promise delivers nothing and writes nothing", bP.length === 1 && Object.keys(ownStore(dirP).records).length === 0, kindsOf(bP));
			hP.stop();
		}

		// (c) silent mode: the sink reports "not a delivery" → no store write,
		// and the memory keys are NOT rolled back (no every-tick noise).
		{
			const dirS = taskDir("durable-silent");
			const wS = mkWorker(dirS, "w-silent");
			writeValidReport(dirS, "w-silent");
			const snapS = snapshotFor([wS], [LIVE("w-silent")]);
			const logsS: string[] = [];
			const hS = createWatcher({
				transport: { listStatuses: async () => [LIVE("w-silent")] } as unknown as Transport,
				intervalMs: 3_600_000,
				send: () => ({ delivered: false, mode: "silent" as const }),
				snapshot: async () => snapS,
				self: { sessionFile: TEST_SELF },
				detect: { legacyFailOpen: true },
				log: (m) => logsS.push(m),
			});
			const bS1 = await hS.tick();
			check("W17.8 silent mode delivers nothing and writes NOTHING to the store", bS1.length === 1 && Object.keys(ownStore(dirS).records).length === 0);
			const bS2 = await hS.tick();
			check(
				"W17.8b silent mode does NOT roll the memory keys back (no every-tick retry noise)",
				bS2.length === 0,
				kindsOf(bS2),
			);
			check("W17.8c silent mode leaves an audit line", logsS.some((m) => /silent/i.test(m)), JSON.stringify(logsS));
			hS.stop();
		}
	}

	// (3) New mtime: a rewritten report (only the mtime moves) is a NEW
	// fingerprint — exactly one new delivery, the store append-only holds
	// BOTH records.
	{
		const dir = taskDir("durable-mtime");
		const w = mkWorker(dir, "w-mtime");
		const p = writeValidReport(dir, "w-mtime");
		const snap = snapshotFor([w], [LIVE("w-mtime")]);
		const sent: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-mtime")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		await h.tick();
		utimesSync(p, new Date(NOW + 60_000), new Date(NOW + 60_000)); // only the mtime moves
		const b2 = await h.tick();
		check("W17.9 a rewritten report (new mtime) delivers exactly one NEW wake", b2.length === 1 && sent.length === 2, `${kindsOf(b2)} ${JSON.stringify(sent)}`);
		const store = ownStore(dir);
		const fps = new Set(Object.values(store.records).map((r) => r.fingerprint));
		check(
			"W17.9b the store is append-only: two records with DIFFERENT fingerprints (no deletion of the old fact)",
			Object.keys(store.records).length === 2 && fps.size === 2,
			JSON.stringify(store),
		);
		h.stop();
	}

	// (4) collectedAt: a collected report produces NO durable record for any
	// report kind — the collect stamp is a product fact in the manifest, the
	// store holds only really-sent wakes; src/spawn.ts is untouched.
	{
		const dir = taskDir("durable-collected");
		const w = mkWorker(dir, "w-collected", { collectedAt: new Date(NOW - 60_000).toISOString() });
		writeValidReport(dir, "w-collected");
		const snap = snapshotFor([w], [LIVE("w-collected")]);
		const sent: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-collected")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true, nowMs: NOW },
			log: () => {},
		});
		const b = await h.tick();
		check(
			"W17.10 collectedAt → no report event, no delivery, NO durable records at all",
			b.length === 0 && sent.length === 0 && Object.keys(ownStore(dir).records).length === 0,
			`${kindsOf(b)} ${JSON.stringify(sent)}`,
		);
		h.stop();
	}

	// (5) Batch: two workers in ONE task dir → one message → after the success
	// BOTH records sit in the SAME file (atomicity per dir by construction).
	// Negative part: an injectable store-write failure once → the memory keys
	// STAY (no re-delivery every tick) and the audit line is present.
	{
		const dir = taskDir("durable-batch");
		const w1 = mkWorker(dir, "w-batch1");
		const w2 = mkWorker(dir, "w-batch2");
		writeValidReport(dir, "w-batch1");
		writeValidReport(dir, "w-batch2");
		const snap = snapshotFor([w1, w2], [LIVE("w-batch1"), LIVE("w-batch2")]);
		const sent: string[] = [];
		const logs: string[] = [];
		let commitCalls = 0;
		let breakCommit = true;
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-batch1"), LIVE("w-batch2")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			commitDelivery: async (cdir, entries) => {
				commitCalls++;
				if (breakCommit) throw new Error("store write broken");
				// otherwise behave exactly like the real writer
				await appendDeliveredRecords(cdir, watcherKeyFor(TEST_SELF), TEST_SELF, entries, new Date().toISOString(), "sent");
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: (m) => logs.push(m),
		});
		const b1 = await h.tick();
		check(
			"W17.11 a two-worker batch in one dir sends ONE message carrying both events",
			b1.length === 2 && sent.length === 1 && (sent[0]?.match(/- \[/g) ?? []).length === 2,
			`${kindsOf(b1)}`,
		);
		check("W17.11b the failed commit wrote nothing", Object.keys(ownStore(dir).records).length === 0 && commitCalls === 1);
		check(
			"W17.11c a failed commit is NOT a failed delivery: memory keys stay, NO re-delivery on the next ticks",
			(await h.tick()).length === 0 && sent.length === 1 && commitCalls === 1,
		);
		check(
			"W17.11d the failed commit leaves the audit line (a repeat is possible after a restart)",
			logs.some((m) => /durable delivery record not written/.test(m) && /restart/.test(m)),
			JSON.stringify(logs),
		);
		breakCommit = false;
		// The commit succeeds only when a NEW fact fires (the memory keys of the
		// first batch were kept): rewrite one report with a new mtime.
		utimesSync(reportPathFor(dir, "w-batch1"), new Date(NOW + 60_000), new Date(NOW + 60_000));
		const b2 = await h.tick();
		check("W17.11e a working commit persists the new fact", b2.length === 1 && Object.keys(ownStore(dir).records).length === 1);
		h.stop();
	}

	// (6) Batch across two dirs is committed as two files (atomicity holds
	// WITHIN each dir — documented partial-commit surface).
	{
		const dirA = taskDir("durable-batch-a");
		const dirB = taskDir("durable-batch-b");
		const wA = mkWorker(dirA, "w-ba");
		const wB = mkWorker(dirB, "w-bb");
		writeValidReport(dirA, "w-ba");
		writeValidReport(dirB, "w-bb");
		const snap = snapshotFor([wA, wB], [LIVE("w-ba"), LIVE("w-bb")]);
		const sent: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-ba"), LIVE("w-bb")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		const b = await h.tick();
		check(
			"W17.12 a batch spanning two task dirs is ONE message and TWO store files (one per dir)",
			b.length === 2 && sent.length === 1 &&
				Object.keys(ownStore(dirA).records).length === 1 &&
				Object.keys(ownStore(dirB).records).length === 1,
			`${kindsOf(b)}`,
		);
		h.stop();
	}

	// (7) Garbage collection: a worker that vanishes from the manifests has its
	// records removed; a transient unreadable store NEVER erases durable keys.
	{
		const dir = taskDir("durable-gc");
		const w = mkWorker(dir, "w-gc");
		writeValidReport(dir, "w-gc");
		let snap = snapshotFor([w], [LIVE("w-gc")]);
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-gc")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: () => {},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		await h.tick();
		check("W17.13 the record exists before the GC", Object.keys(ownStore(dir).records).length === 1);
		snap = snapshotFor([], []); // the worker really vanished from the manifests
		await h.tick();
		check(
			"W17.14 the vanished worker's records are garbage-collected from the store",
			Object.keys(ownStore(dir).records).length === 0,
			JSON.stringify(ownStore(dir)),
		);
		h.stop();

		// Transient read error: a corrupt store file is read as EMPTY (never a
		// throw) — the memory cache still suppresses within the session, and
		// the durable keys are not erased by the failed read.
		const dirT = taskDir("durable-torn");
		const wT = mkWorker(dirT, "w-torn");
		writeValidReport(dirT, "w-torn");
		const snapT = snapshotFor([wT], [LIVE("w-torn")]);
		const sentT: string[] = [];
		const hT = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-torn")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sentT.push(t);
			},
			snapshot: async () => snapT,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			log: () => {},
		});
		await hT.tick();
		const before = readFileSync(deliveredStorePathFor(dirT, watcherKeyFor(TEST_SELF)), "utf8");
		writeFileSync(deliveredStorePathFor(dirT, watcherKeyFor(TEST_SELF)), "{corrupt"); // transient torn file
		check("W17.15 a torn store read suppresses nothing extra in memory (no re-delivery)", (await hT.tick()).length === 0 && sentT.length === 1);
		writeFileSync(deliveredStorePathFor(dirT, watcherKeyFor(TEST_SELF)), before); // the transient error is over
		check(
			"W17.16 the transient read error did NOT erase the durable keys",
			Object.keys(ownStore(dirT).records).length === 1,
			JSON.stringify(ownStore(dirT)),
		);
		check("W17.16b after the recovery the event stays suppressed", (await hT.tick()).length === 0);
		hT.stop();
	}

	// (8) Emergency rollback: durableDelivery:false → byte-identical memory-only
	// behavior (no store file is ever created).
	{
		const dir = taskDir("durable-off");
		const w = mkWorker(dir, "w-off");
		writeValidReport(dir, "w-off");
		const snap = snapshotFor([w], [LIVE("w-off")]);
		const sent: string[] = [];
		const h = createWatcher({
			transport: { listStatuses: async () => [LIVE("w-off")] } as unknown as Transport,
			intervalMs: 3_600_000,
			send: (t: string) => {
				sent.push(t);
			},
			snapshot: async () => snap,
			self: { sessionFile: TEST_SELF },
			detect: { legacyFailOpen: true },
			durableDelivery: false,
			log: () => {},
		});
		const b = await h.tick();
		check(
			"W17.17 durableDelivery:false → the memory-only dedup, no store file ever created",
			b.length === 1 && sent.length === 1,
		);
		let storeFileExists = false;
		try {
			readFileSync(deliveredStorePathFor(dir, watcherKeyFor(TEST_SELF)));
			storeFileExists = true;
		} catch {
			storeFileExists = false;
		}
		check("W17.17b the rollback creates no store file", !storeFileExists);
		h.stop();
	}

	// (9) Audit line for a REAL send (guideline §9.1, DESIGN.md §21 delivery): a
	// successful send writes exactly ONE watcher-log line per batch naming the
	// send fact and the batch content (dir :: worker/kind#fingerprint per event)
	// — the recovery trail after an incident. Negative parts: silent mode and a
	// failed send do NOT write it (each already has its own line).
	{
		const dir = taskDir("audit-line");
		const w1 = mkWorker(dir, "w-audit1");
		const w2 = mkWorker(dir, "w-audit2");
		writeValidReport(dir, "w-audit1");
		writeValidReport(dir, "w-audit2");
		const snap = snapshotFor([w1, w2], [LIVE("w-audit1"), LIVE("w-audit2")]);
		const mkA = (send: (t: string) => unknown) => {
			const logs: string[] = [];
			const h = createWatcher({
				transport: { listStatuses: async () => [LIVE("w-audit1"), LIVE("w-audit2")] } as unknown as Transport,
				intervalMs: 3_600_000,
				send: send as (text: string) => never,
				snapshot: async () => snap,
				self: { sessionFile: TEST_SELF },
				detect: { legacyFailOpen: true },
				log: (m) => logs.push(m),
			});
			return { h, logs };
		};

		// (a) real send → ONE audit line carrying the send fact + both events.
		{
			const { h, logs } = mkA(() => ({ delivered: true, mode: "sent" as const }));
			const b = await h.tick();
			const audit = logs.filter((m) => /wake-up sent/.test(m));
			check(
				"W17.18 a successful send writes exactly ONE audit line for the batch (not one per event)",
				b.length === 2 && audit.length === 1,
				JSON.stringify(logs),
			);
			const line = audit[0] ?? "";
			check(
				"W17.18b the audit line names the send fact and BOTH events' full composition (dir :: worker/kind#fingerprint)",
				line.includes(`${dir} :: w-audit1/report-ready#`) && line.includes(`${dir} :: w-audit2/report-ready#`),
				line,
			);
			check(
				"W17.18c the audit line carries the non-empty fingerprints (the recovery trail re-derives the exact dedup keys)",
				/report-ready#[^,\s]/.test(line),
				line,
			);
			h.stop();
		}

		// (b) silent mode → no "wake-up sent" line (the silent line is its own).
		{
			const { h, logs } = mkA(() => ({ delivered: false, mode: "silent" as const }));
			await h.tick();
			check(
				"W17.19 silent mode does NOT write the 'wake-up sent' audit line",
				!logs.some((m) => /wake-up sent/.test(m)),
				JSON.stringify(logs),
			);
			h.stop();
		}

		// (c) failed send → no "wake-up sent" line (the failure line is its own).
		{
			const { h, logs } = mkA(() => {
				throw new Error("send exploded");
			});
			await h.tick();
			check(
				"W17.20 a failed send does NOT write the 'wake-up sent' audit line",
				!logs.some((m) => /wake-up sent/.test(m)),
				JSON.stringify(logs),
			);
			h.stop();
		}
	}
}

rmSync(FIX, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL WATCHER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
