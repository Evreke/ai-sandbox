/**
 * Mailbox wake matrix (W0 pin, rng-sum bug 4) — the delegate_mailbox
 * answer/steer nudge gate by worker status.
 *
 * Run with: bun test/mailbox-check.ts   (from repo root)
 *
 * Drives the REAL registerMailboxTool().execute() against a mock transport
 * over a real /tmp/exchange/<task>/ manifest dir (findWorkerDir resolves the
 * worker through scanAllManifests), one fresh dir per scenario, removed after.
 *
 *   M1  done → NUDGED: submitPrompt fires exactly once with the §12 mailbox
 *       pointer, verbatim, honest "Nudge prompt sent — will read a-<name>"
 *       note; NO "no nudge sent" / fabricated "polls per its brief" note
 *       (the bug-4 fix — a done worker must be woken, not silently dropped).
 *   M2  idle / blocked → nudged the same way, no "re-prompted" note.
 *   M3  working → NO nudge (never interrupt a running turn), honest note.
 *   M4  unknown → NO nudge, honest "may never be read" warning.
 *   M5  steer wakes a done worker too; the answer file a-<name>.json is
 *       written BEFORE the nudge fires (the new turn must find it).
 *   M6  F6 nudge resilience: submitPrompt throws once (transient
 *       connection_closed) then succeeds → the retry lands, no marker.
 *   M7  F6: submitPrompt always throws → 3 bounded attempts, then a
 *       nudge-failed-<name>.json marker ({name, ts, error}) is written and
 *       the note says the answer IS posted; the action still succeeds.
 *   M8  F6: detectWorkerEvents picks the marker up (kind nudge-failed,
 *       fingerprint = ts, message names a-<name>.json); garbage/corrupt
 *       markers are ignored, never throw.
 *   M9  F6: a SUBSEQUENT successful nudge deletes a stale marker (the §23
 *       retire-ack consume discipline).
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	updateManifest,
	nudgeFailedPathFor,
	type ManifestWorker,
} from "../src/exchange.ts";
import {
	detectWorkerEvents,
	type WatchWorker,
} from "../src/observe.ts";
import { registerMailboxTool } from "../src/spawn.ts";
import type { AgentStatusName, Placement, PromptReq, Transport } from "../src/host.ts";

// Fixture hygiene (field lesson 2026-09-10): the exchange root is SANDBOXED
// via $PI_DELEGATE_EXCHANGE_ROOT → a mkdtemp dir — test manifests never land
// in the live /tmp/exchange root (a bystander orchestrator's fail-open legacy
// scan used to wake on them).
const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "mailbox-check-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NAME = `mb-wake-${process.pid}`;
const ANSWER = "continue with phase 2";
/** NUDGE_TEXT is module-private; pin its exact §12 wording here (behavioral). */
const NUDGE = `Mailbox update posted: read a-${NAME}.json next to your brief and continue accordingly.`;

interface Capture {
	prompts: Array<{ name: string; text: string }>;
	/** Was a-<name>.json already on disk at the moment the nudge fired? */
	answerAtNudge?: boolean;
	/** Total submitPrompt invocations, failures included (F6 retry pin). */
	attempts: number;
}

interface MailboxTool {
	execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

async function drive(
	action: "answer" | "steer",
	status: AgentStatusName,
	opts: { failTimes?: number; label?: string; seedMarker?: boolean } = {},
): Promise<{
	text: string;
	details: Record<string, unknown>;
	capture: Capture;
	dir: string;
}> {
	const dir = join(EXCHANGE_SANDBOX, `mb-${process.pid}-${opts.label ?? `${action}-${status}`}`);
	const placement: Placement = {
		kind: "worktree",
		workspaceId: "ws-1",
		paneId: "pane-1",
		checkoutPath: "/tmp/mb-nowhere",
	};
	const entry: ManifestWorker = {
		name: NAME,
		placement,
		briefPath: join(dir, `brief-${NAME}.md`),
		reportPath: join(dir, `report-${NAME}.json`),
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: new Date(0).toISOString(),
	};
	// Minimal manifest on disk so findWorkerDir (scanAllManifests) resolves us.
	await updateManifest(dir, (m) => ({ ...m, workers: [...m.workers, entry] }));
	if (opts.seedMarker) {
		writeFileSync(
			nudgeFailedPathFor(dir, NAME),
			JSON.stringify({ name: NAME, ts: "2026-09-10T00:00:00.000Z", error: "stale marker from an earlier failed answer" }),
		);
	}

	const capture: Capture = { prompts: [], attempts: 0 };
	const transport = {
		place: async () => placement,
		startAgent: async () => ({ name: NAME }),
		submitPrompt: async (req: PromptReq) => {
			capture.attempts++;
			if (opts.failTimes !== undefined && capture.attempts <= opts.failTimes) {
				throw new Error("herdr socket: connection_closed: server closed the connection");
			}
			capture.prompts.push({ name: req.name, text: req.text });
			capture.answerAtNudge = existsSync(join(dir, `a-${NAME}.json`));
		},
		waitSettle: async () => ({ kind: "settled", status: "idle" }),
		getStatus: async () => ({ name: NAME, status }),
		listStatuses: async () => [],
		teardown: async () => ({ alreadyGone: false }),
		capabilities: () => ({ worktrees: true, authority: "root" }),
		backendName: () => "herdr",
	} as unknown as Transport;

	let captured: MailboxTool | undefined;
	const fakePi = {
		registerTool: (t: never) => {
			captured = t as never;
		},
	};
	registerMailboxTool(fakePi as never, transport);
	const result = await captured!.execute("t1", { action, name: NAME, text: ANSWER }, undefined, () => {}, {});
	return {
		text: result.content.map((c) => c.text).join("\n"),
		details: result.details,
		capture,
		dir,
	};
}

function cleanup(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// M1. done → nudged (the bug-4 fix)
// ---------------------------------------------------------------------------

{
	const r = await drive("answer", "done");
	try {
		check(
			"M1.1 done worker → submitPrompt nudge fired exactly once",
			r.capture.prompts.length === 1,
			JSON.stringify(r.capture.prompts),
		);
		check("M1.2 nudge text is the §12 mailbox pointer, verbatim", r.capture.prompts[0]?.text === NUDGE, r.capture.prompts[0]?.text);
		check("M1.3 nudge targets the worker by canonical name", r.capture.prompts[0]?.name === NAME);
		check(
			"M1.4 honest wake note: nudge sent + the worker will read the a-file",
			/Nudge prompt sent/.test(r.text) && r.text.includes(`the worker will read a-${NAME}.json and continue`),
			r.text,
		);
		check(
			"M1.5 NO fabricated 'polls per its brief' note (the regression this pin kills)",
			!/polls per its brief/.test(r.text) && !/no nudge sent/.test(r.text),
			r.text,
		);
		const answerPath = join(r.dir, `a-${NAME}.json`);
		const envelope = JSON.parse(readFileSync(answerPath, "utf8")) as { from?: string; answer?: string };
		check(
			"M1.6 answer envelope on disk (orchestrator + text), nudged:true in details",
			envelope.from === "orchestrator" && envelope.answer === ANSWER && r.details.nudged === true,
			JSON.stringify({ envelope, nudged: r.details.nudged }),
		);
		check("M1.7 the answer file exists BEFORE the nudge fires (the new turn must find it)", r.capture.answerAtNudge === true);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M2. idle / blocked → nudged, same pointer, no re-prompted note
// ---------------------------------------------------------------------------

for (const status of ["idle", "blocked"] as const) {
	const r = await drive("answer", status);
	try {
		check(
			`M2.${status === "idle" ? 1 : 4} ${status} worker → nudged once with the same §12 pointer`,
			r.capture.prompts.length === 1 && r.capture.prompts[0]?.text === NUDGE,
			JSON.stringify(r.capture.prompts),
		);
		check(
			`M2.${status === "idle" ? 2 : 5} ${status} → nudged:true, no re-prompted note (worker never finished)`,
			r.details.nudged === true && !/re-prompted/.test(r.text),
			r.text,
		);
		check(
			`M2.${status === "idle" ? 3 : 6} ${status} → no fabricated done-note, no unknown warning`,
			!/status done/.test(r.text) && !/may never be read/.test(r.text),
			r.text,
		);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M3. working → NO nudge (never interrupt a running turn)
// ---------------------------------------------------------------------------

{
	const r = await drive("answer", "working");
	try {
		check("M3.1 working worker → submitPrompt NOT called", r.capture.prompts.length === 0, JSON.stringify(r.capture.prompts));
		check(
			"M3.2 honest no-nudge note naming the status + the between-steps read path",
			r.details.nudged === false && /status is working/.test(r.text) && /no nudge sent/.test(r.text) && r.text.includes(`a-${NAME}.json`),
			r.text,
		);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M4. unknown → NO nudge, honest warning
// ---------------------------------------------------------------------------

{
	const r = await drive("answer", "unknown");
	try {
		check("M4.1 unknown status → submitPrompt NOT called", r.capture.prompts.length === 0, JSON.stringify(r.capture.prompts));
		check(
			"M4.2 honest warning: answer IS posted but may never be read",
			/may never be read/.test(r.text) && /answer IS posted/.test(r.text),
			r.text,
		);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M5. steer wakes a done worker too (same gate, both actions)
// ---------------------------------------------------------------------------

{
	const r = await drive("steer", "done");
	try {
		check(
			"M5.1 steer → done worker nudged once, same §12 pointer",
			r.capture.prompts.length === 1 && r.capture.prompts[0]?.text === NUDGE,
			JSON.stringify(r.capture.prompts),
		);
		check(
			"M5.2 steer → wake note + Steering posted (not a silent no-op)",
			/Nudge prompt sent/.test(r.text) && /Steering posted/.test(r.text),
			r.text,
		);
		check("M5.3 steer → nudge fires only after the answer file is on disk", r.capture.answerAtNudge === true);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M6. F6 nudge resilience — transient failure retried, no marker
// ---------------------------------------------------------------------------

{
	const r = await drive("answer", "done", { failTimes: 1, label: "f6-retry" });
	try {
		check(
			"M6.1 transient submitPrompt failure → retried and delivered (2 attempts, 1 success)",
			r.capture.attempts === 2 && r.capture.prompts.length === 1,
			JSON.stringify({ attempts: r.capture.attempts, prompts: r.capture.prompts }),
		);
		check(
			"M6.2 retry success → honest wake note (no failure scare)",
			r.details.nudged === true && /Nudge prompt sent/.test(r.text) && !/failed after/.test(r.text),
			r.text,
		);
		check(
			"M6.3 retry success → NO nudge-failed marker written",
			!existsSync(nudgeFailedPathFor(r.dir, NAME)),
		);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M7. F6 nudge resilience — repeated failure → bounded attempts + marker
// ---------------------------------------------------------------------------

{
	const r = await drive("answer", "idle", { failTimes: 999, label: "f6-always-fail" });
	const markerPath = nudgeFailedPathFor(r.dir, NAME);
	try {
		check(
			"M7.1 repeated failure → exactly 3 bounded attempts, none delivered",
			r.capture.attempts === 3 && r.capture.prompts.length === 0 && r.details.nudged === false,
			JSON.stringify({ attempts: r.capture.attempts, nudged: r.details.nudged }),
		);
		check("M7.2 repeated failure → nudge-failed marker written", existsSync(markerPath), markerPath);
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { name?: string; ts?: string; error?: string };
		check(
			"M7.3 marker envelope: {name, ts, error} with the socket error",
			marker.name === NAME && typeof marker.ts === "string" && marker.ts.length > 0 &&
				/connection_closed/.test(marker.error ?? ""),
			JSON.stringify(marker),
		);
		check(
			"M7.4 the note says the answer IS posted, names the marker, and offers pane re-prompt / retry steer",
			/answer IS posted/.test(r.text) && r.text.includes(`a-${NAME}.json`) &&
				/failed after 3 attempts/.test(r.text) && /retry the steer/.test(r.text),
			r.text,
		);
		check("M7.5 the action itself still SUCCEEDS (answer file is already posted)", r.details.ok === true);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------
// M8. F6 — detectWorkerEvents picks the nudge-failed marker up
// ---------------------------------------------------------------------------

{
	const dir = join(EXCHANGE_SANDBOX, `mb-${process.pid}-f6-detect`);
	const ts = "2026-09-10T12:00:00.000Z";
	mkdirSync(dir, { recursive: true });
	writeFileSync(nudgeFailedPathFor(dir, NAME), JSON.stringify({ name: NAME, ts, error: "herdr socket: connection_closed: server closed the connection" }));
	try {
		const w: WatchWorker = {
			name: NAME,
			dir,
			reportPath: join(dir, `report-${NAME}.json`),
			live: true,
			kind: "tab",
			self: false,
			probe: false,
		};
		const ev = detectWorkerEvents(w);
		const marker = ev.find((e) => e.kind === "nudge-failed");
		check("M8.1 marker on disk → nudge-failed event", marker !== undefined, JSON.stringify(ev.map((e) => e.kind)));
		check(
			"M8.2 the message states the answer IS posted at a-<name>.json and the pane nudge failed",
			!!marker && marker.message.includes(`a-${NAME}.json`) && /answer IS posted/.test(marker.message) &&
				/nudge failed/.test(marker.message),
			marker?.message ?? "",
		);
		check("M8.3 fingerprint = the marker ts", marker?.fingerprint === ts, marker?.fingerprint ?? "none");

		// Tolerance: garbage/corrupt markers are ignored, never throw.
		writeFileSync(nudgeFailedPathFor(dir, NAME), "{ not json ]");
		check("M8.4 corrupt marker → no event, never throws", detectWorkerEvents(w).length === 0);
		writeFileSync(nudgeFailedPathFor(dir, NAME), JSON.stringify({ name: NAME, error: "no ts" }));
		check("M8.5 ts-less marker → no event (fingerprint source missing)", detectWorkerEvents(w).length === 0);
	} finally {
		cleanup(dir);
	}
}

// ---------------------------------------------------------------------------
// M9. F6 — a subsequent successful nudge deletes a stale marker
// ---------------------------------------------------------------------------

{
	const r = await drive("steer", "idle", { label: "f6-consume", seedMarker: true });
	try {
		check(
			"M9.1 successful nudge → stale marker deleted (consume discipline)",
			r.details.nudged === true && !existsSync(nudgeFailedPathFor(r.dir, NAME)),
		);
	} finally {
		cleanup(r.dir);
	}
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL MAILBOX CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
