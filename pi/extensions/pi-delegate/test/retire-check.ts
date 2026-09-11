/**
 * R-check — §23 retire: extension-side auto-teardown of drained worker panes.
 *
 * Run with: bun test/retire-check.ts   (from the extension dir)
 *
 * The approved state machine (DESIGN.md §23):
 *   RETIRABLE (evaluated by the watcher) = valid report (base + brief
 *   fragment) AND drained mailbox AND herdr status done/idle.
 *   CLOSE on ACK (release-<name>.json) or TTL (watch.retireTtlMs since the
 *   worker became retirable). EXCEPTIONS: invalid/missing report, pending
 *   worker question — never close; probes close IMMEDIATELY once settled.
 *   The clock (retirableSince) and the close stamp (retiredAt) live in the
 *   manifest — watcher restarts must not lose them; entries are never deleted.
 *
 * Checks:
 *   R0  MASTER SWITCH watch.retire (default FALSE): disabled → the pass is a
 *       no-op (no close, no stamp, marker untouched); enabled mode is R1-R6
 *       with retireEnabled:true passed explicitly (hermetic).
 *   R1  Config — watch.retire master switch (default false, warn-once on a
 *       non-boolean) and watch.retireTtlMs default 900000, override, 0 legal,
 *       bad value → warn ONCE + default (child bun process, $HOME at spawn).
 *   R2  evaluateRetire — every condition, every exception, ACK vs TTL, probe
 *       immediacy.
 *   R3  Manifest threading through workersFromManifests (tolerant on garbage).
 *   R4  A retired worker (retiredAt) is silent across every event kind.
 *   R5  retirePass — stamping/clearing the persisted clock, close exactly
 *       once + retiredAt, teardown-throw retry, ACK, probe, ownership
 *       (fail-closed for declared owners), unusable placements.
 *   R6  Static pins: the tick runs the pass; delegate_mailbox has the release
 *       action; the release marker roundtrip (writeRelease → releasePathFor).
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import {
	RETIRE_DEFAULT_TTL_MS,
	RETIRE_DEFAULT_ENABLED,
	evaluateRetire,
	workersFromManifests,
	retirePass,
	type WatchSnapshot,
} from "../src/observe.ts";
import {
	answerPathFor,
	mergeRetireStamps,
	questionPathFor,
	readWatchStampLayers,
	releasePathFor,
	updateWatchStamps,
	watcherKeyFor,
	writeRelease,
	type ExchangeManifest,
	type ManifestWorker,
} from "../src/exchange.ts";
import { archiveRoot } from "../src/exchange.ts";
import type { AgentStatus, Placement, TeardownReq, Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const FIX = mkdtempSync(join(tmpdir(), "retire-check-fix-"));

// Archive sandbox: archive-at-retire (R7) — and any collect-path archive —
// writes under archiveRoot() = $HOME/.pi/agent/delegate-archive. Redirect
// $HOME for the WHOLE run so the real archive is never touched (same
// convention as settle-archive.ts; R1's child spawns override HOME explicitly).
const SAVED_HOME = process.env.HOME;
const ARCHIVE_HOME = mkdtempSync(join(tmpdir(), "retire-check-archive-home-"));
process.env.HOME = ARCHIVE_HOME;

// ---------------------------------------------------------------------------
// R1. Config — watch.retireTtlMs (child bun process, $HOME at spawn time)
// ---------------------------------------------------------------------------

const WATCH_MOD = new URL("../src/observe.ts", import.meta.url).pathname;

function retireConfigInHome(
	configJson: string,
): { retireTtlMs: number; retire: boolean; warnings: number; raw: string } {
	const home = mkdtempSync(join(tmpdir(), "retire-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	// Resolve TWICE: the warn-once contract is per process.
	const src =
		`import {resolveWatchConfig} from ${JSON.stringify(WATCH_MOD)};` +
		"resolveWatchConfig(); console.log(JSON.stringify(resolveWatchConfig()))";
	// Fail-fast: a hung bun -e child must surface as SPAWN FAILED (20 s cap).
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	rmSync(home, { recursive: true, force: true });
	const raw = res.stdout.toString().trim();
	const warnings = (res.stderr.toString().match(/bad watch\.retire/g) ?? []).length;
	try {
		return { ...JSON.parse(raw), warnings, raw };
	} catch {
		return { retireTtlMs: -1, retire: false, warnings, raw: `SPAWN FAILED: ${res.stderr.toString().slice(0, 200)}` };
	}
}

{
	check("R1.0 default is the approved 900000", RETIRE_DEFAULT_TTL_MS === 900_000);
	const d = retireConfigInHome("");
	check("R1.1 no config → default 900000, no warning", d.retireTtlMs === 900_000 && d.warnings === 0, d.raw);
	const o = retireConfigInHome(JSON.stringify({ watch: { retireTtlMs: 60_000 } }));
	check("R1.2 explicit override honored", o.retireTtlMs === 60_000 && o.warnings === 0, o.raw);
	const z = retireConfigInHome(JSON.stringify({ watch: { retireTtlMs: 0 } }));
	check("R1.3 zero is legal (close on the first retirable tick)", z.retireTtlMs === 0 && z.warnings === 0, z.raw);
	const bad = retireConfigInHome(JSON.stringify({ watch: { retireTtlMs: "soon" } }));
	check("R1.4 bad value (string) → default, warned ONCE for two calls", bad.retireTtlMs === 900_000 && bad.warnings === 1, `ttl=${bad.retireTtlMs} warn=${bad.warnings}`);
	const neg = retireConfigInHome(JSON.stringify({ watch: { retireTtlMs: -5 } }));
	check("R1.5 negative → default, warned", neg.retireTtlMs === 900_000 && neg.warnings === 1, `ttl=${neg.retireTtlMs} warn=${neg.warnings}`);
	const co = retireConfigInHome(JSON.stringify({ watch: { intervalMs: 7000, retireTtlMs: 5_000 } }));
	check("R1.6 coexists with the other watch keys", co.retireTtlMs === 5_000, co.raw);
	// Master switch watch.retire — OPT-IN (default FALSE, user decision).
	check("R1.7 default master switch is FALSE", RETIRE_DEFAULT_ENABLED === false);
	const off = retireConfigInHome("");
	check("R1.8 absent watch.retire → false (auto-teardown opt-in)", (off as { retire?: boolean } as { retire: boolean }).retire === false, off.raw);
	const on = retireConfigInHome(JSON.stringify({ watch: { retire: true } })) as { retire: boolean; warnings: number; raw: string };
	check("R1.9 explicit watch.retire:true honored", on.retire === true && on.warnings === 0, on.raw);
	const off2 = retireConfigInHome(JSON.stringify({ watch: { retire: false } })) as { retire: boolean };
	check("R1.9b explicit watch.retire:false honored", off2.retire === false);
	const badSwitch = retireConfigInHome(JSON.stringify({ watch: { retire: "yes" } })) as { retire: boolean; warnings: number; raw: string };
	check("R1.10 non-boolean watch.retire → false, warned ONCE for two calls", badSwitch.retire === false && badSwitch.warnings === 1, `retire=${badSwitch.retire} warn=${badSwitch.warnings}`);
}

// ---------------------------------------------------------------------------
// Fixtures — temp task dirs with manifest.json ON DISK (retirePass stamps it)
// ---------------------------------------------------------------------------

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
			kind: kind ?? "tab",
			workspaceId: "w1",
			paneId: `w1:${name}`,
			checkoutPath: `/tmp/wt/${name}`,
		},
		briefPath: `${dir}/brief-${name}.md`,
		reportPath: `${dir}/report-${name}.json`,
		provider: "p",
		model: "unknown-model",
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(),
		...rest,
	};
}

function writeManifestOnDisk(dir: string, workers: ManifestWorker[]): ExchangeManifest {
	const m: ExchangeManifest = { task: dir.split("/").pop() ?? "task", dir, workers };
	writeFileSync(`${dir}/manifest.json`, JSON.stringify(m, null, "\t") + "\n");
	return m;
}

function writeValidReport(dir: string, name: string, body?: Record<string, unknown>): string {
	const p = `${dir}/report-${name}.json`;
	writeFileSync(
		p,
		JSON.stringify(
			body ?? {
				worker: name,
				status: "pass",
				summary: "done",
				artifacts: [],
				evidence: [{ claim: "c", file: "f.ts:1" }],
			},
		),
	);
	return p;
}

const DONE = (name: string): AgentStatus => ({ name, status: "done" });
const WORKING = (name: string): AgentStatus => ({ name, status: "working" });

/** Snapshot over on-disk-style manifests (statuses threaded per name). */
function snapshotFor(workers: ManifestWorker[], statuses: AgentStatus[] | null): WatchSnapshot {
	const manifests = workers.map((w) => ({ task: "t", dir: dirname(w.briefPath), workers: [w] }) as ExchangeManifest);
	return workersFromManifests(manifests, statuses, {}, NOW);
}

/** WatchWorker for one fixture worker (evaluateRetire input). */
function workerView(w: ManifestWorker, statuses: AgentStatus[] | null = [DONE(w.name)]) {
	return snapshotFor([w], statuses).workers[0]!;
}

// ---------------------------------------------------------------------------
// R2. evaluateRetire — conditions, exceptions, ACK vs TTL, probes
// ---------------------------------------------------------------------------

{
	const dir = taskDir("eval");
	const w = mkWorker(dir, "r-eval");

	check("R2.1 missing report → NOT retirable (exception: diagnosis window)", !evaluateRetire(workerView(w)).retirable);

	writeValidReport(dir, "r-eval");
	const ok = evaluateRetire(workerView(w));
	check("R2.2 valid report + drained mailbox + done → retirable", ok.retirable, JSON.stringify(ok));
	check("R2.3 not yet stamped + within TTL → retirable, NO close decision", ok.decision === undefined, JSON.stringify(ok));

	check("R2.4 status working → not retirable", !evaluateRetire(workerView(w, [WORKING("r-eval")])).retirable);
	check(
		"R2.5 status unknown (herdr unreachable / agent gone) → not retirable",
		!evaluateRetire(workerView(w, null)).retirable,
	);

	writeFileSync(`${dir}/report-r-eval.json`, "{half");
	check("R2.6 invalid report (mid-write) → never retirable", !evaluateRetire(workerView(w)).retirable);

	// Condition 1 is base + BRIEF fragment: a fragment-violating report blocks.
	const wFrag = mkWorker(dir, "r-frag", {
		reportSchemaFragment: { type: "object", required: ["result"], properties: { result: { type: "integer" } } },
	});
	writeValidReport(dir, "r-frag", { worker: "r-frag", status: "pass", summary: "s", artifacts: [], evidence: [] });
	check("R2.7 base-valid but fragment-violating report → NOT retirable", !evaluateRetire(workerView(wFrag)).retirable);
	writeValidReport(dir, "r-frag", { worker: "r-frag", status: "fail", summary: "honest fail", artifacts: [], evidence: [], result: 3 });
	const fragOk = evaluateRetire(workerView(wFrag));
	check("R2.7b fragment-satisfying report → retirable (status fail still counts)", fragOk.retirable, JSON.stringify(fragOk));

	// Exceptions: mailbox state.
	const wQ = mkWorker(dir, "r-q");
	writeValidReport(dir, "r-q");
	writeFileSync(questionPathFor(dir, "r-q"), JSON.stringify({ worker: "r-q", ts: "T", question: "which?" }));
	check("R2.8 pending worker question → never retirable", !evaluateRetire(workerView(wQ)).retirable);

	const wA = mkWorker(dir, "r-a");
	const reportA = writeValidReport(dir, "r-a");
	writeFileSync(answerPathFor(dir, "r-a"), JSON.stringify({ from: "orchestrator", ts: "T", answer: "go on" }));
	utimesSync(answerPathFor(dir, "r-a"), new Date(NOW + 5000), new Date(NOW + 5000)); // NEWER than the report
	utimesSync(reportA, new Date(NOW), new Date(NOW));
	check("R2.9 answer NEWER than the report → unanswered → not retirable", !evaluateRetire(workerView(wA)).retirable);
	utimesSync(answerPathFor(dir, "r-a"), new Date(NOW - 5000), new Date(NOW - 5000)); // OLDER → consumed
	check("R2.9b answer OLDER than the report → consumed → mailbox drained", evaluateRetire(workerView(wA)).retirable);

	// TTL vs ACK.
	const wTtl = mkWorker(dir, "r-ttl", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeValidReport(dir, "r-ttl");
	const ttl = evaluateRetire(workerView(wTtl), { nowMs: NOW, ttlMs: 900_000 });
	check("R2.10 TTL elapsed since retirableSince → decision ttl", ttl.decision?.reason === "ttl", JSON.stringify(ttl));
	const notYet = evaluateRetire(workerView({ ...wTtl, retirableSince: new Date(NOW - 1000).toISOString() }), { nowMs: NOW, ttlMs: 900_000 });
	check("R2.11 within TTL → retirable but no decision", notYet.retirable && notYet.decision === undefined, JSON.stringify(notYet));
	check(
		"R2.12 ttlMs injectable (huge → silent, small → fires)",
		evaluateRetire(workerView(wTtl), { nowMs: NOW, ttlMs: 24 * 60 * 60_000 }).decision === undefined &&
			evaluateRetire(workerView(wTtl), { nowMs: NOW, ttlMs: 1000 }).decision?.reason === "ttl",
	);

	const wAck = mkWorker(dir, "r-ack");
	writeValidReport(dir, "r-ack");
	writeFileSync(releasePathFor(dir, "r-ack"), JSON.stringify({ from: "orchestrator", ts: "T" }));
	const ack = evaluateRetire(workerView(wAck)); // NO retirableSince stamp
	check("R2.13 release marker → decision ack IMMEDIATELY (no stamp needed)", ack.decision?.reason === "ack", JSON.stringify(ack));

	// Probes: no report is ever expected — the settled verdict closes IMMEDIATELY.
	const pdir = join(FIX, "eval_probe_dir"); // NOT the _probe dir — use the flag via dir name below
	void pdir;
	const probeDir = taskDir("_probe");
	const pw = mkWorker(probeDir, "r-probe");
	const pv = workerView(pw, [DONE("r-probe")]);
	check("R2.14 fixture lands in a _probe dir", pv.probe === true, JSON.stringify({ dir: probeDir }));
	const probeDone = evaluateRetire(pv);
	check("R2.15 settled probe → decision probe (immediate, no report)", probeDone.decision?.reason === "probe", JSON.stringify(probeDone));
	check("R2.16 working probe → nothing", !evaluateRetire(workerView(pw, [WORKING("r-probe")])).retirable);
	writeFileSync(questionPathFor(probeDir, "r-probe"), JSON.stringify({ worker: "r-probe", ts: "T", question: "hold?" }));
	check("R2.17 probe with a pending question → hold (exception still applies)", !evaluateRetire(workerView(pw, [DONE("r-probe")])).retirable);
	rmSync(questionPathFor(probeDir, "r-probe"));
}

// ---------------------------------------------------------------------------
// R3. Manifest threading through workersFromManifests (tolerant)
// ---------------------------------------------------------------------------

{
	const dir = taskDir("thread");
	const w = mkWorker(dir, "r-thread", {
		briefPath: `${dir}/brief-r-thread.md`,
		reportSchemaFragment: { type: "object" },
		retirableSince: new Date(NOW - 60_000).toISOString(),
		retiredAt: new Date(NOW - 30_000).toISOString(),
	});
	const v = snapshotFor([w], [DONE("r-thread")]).workers[0]!;
	check("R3.1 briefPath threads", v.briefPath === w.briefPath);
	check("R3.2 reportSchemaFragment threads", v.reportSchemaFragment !== undefined);
	check("R3.3 placement threads (the close needs it)", v.placement?.paneId === w.placement.paneId);
	check("R3.4 observed herdr status threads (done — condition 3's input)", v.status === "done");
	check("R3.5 retirableSince threads", v.retirableSince === w.retirableSince);
	check("R3.6 retiredAt threads", v.retiredAt === w.retiredAt);
	check("R3.7 working status threads too", snapshotFor([w], [WORKING("r-thread")]).workers[0]?.status === "working");
	check(
		"R3.8 herdr unreachable → status absent (never retirable on unknown)",
		snapshotFor([w], null).workers[0]?.status === undefined,
	);
	const junk = mkWorker(dir, "r-junk");
	(junk as unknown as Record<string, unknown>).reportSchemaFragment = "not-an-object";
	(junk as unknown as Record<string, unknown>).retirableSince = 42;
	(junk as unknown as Record<string, unknown>).retiredAt = true;
	(junk as unknown as Record<string, unknown>).placement = "nope";
	const jv = snapshotFor([junk], [DONE("r-junk")]).workers[0]!;
	check(
		"R3.9 garbage manifest values read as absent (legacy behavior)",
		jv.reportSchemaFragment === undefined && jv.retirableSince === undefined && jv.retiredAt === undefined && jv.placement === undefined,
		JSON.stringify(jv),
	);

	// Migration stage 3 (audit steps 6/10): the watcher's stamps live in its
	// satellite file — the merge layers onto the threaded view (manifest legacy
	// layer + satellite; earliest stamp wins) and a satellite-only retiredAt
	// silences/threads exactly like a manifest-layer one.
	const satDir = taskDir("thread-sat");
	const ws = mkWorker(satDir, "r-sat");
	writeManifestOnDisk(satDir, [ws]);
	const since = new Date(NOW - 120_000).toISOString();
	const closed = new Date(NOW - 60_000).toISOString();
	const anonKey = watcherKeyFor(undefined);
	await updateWatchStamps(satDir, anonKey, "r-sat", { retirableSince: since, retiredAt: closed });
	const satLayer = readWatchStampLayers(satDir);
	check(
		"R3.10 satellite layer written by updateWatchStamps, read back by readWatchStampLayers",
		satLayer.length === 1 && satLayer[0]?.stamps["r-sat"]?.retirableSince === since && satLayer[0]?.stamps["r-sat"]?.retiredAt === closed,
		JSON.stringify(satLayer),
	);
	const sv = snapshotFor([ws], [DONE("r-sat")]).workers[0]!;
	check("R3.11 satellite-only stamps merge onto the worker view (earliest wins)", sv.retirableSince === since && sv.retiredAt === closed, JSON.stringify(sv));
	// Manifest layer + satellite: the earliest stamp per field wins.
	const legacySince = new Date(NOW - 300_000).toISOString();
	writeManifestOnDisk(satDir, [{ ...ws, retirableSince: legacySince }]);
	const mv = snapshotFor([{ ...ws, retirableSince: legacySince }], [DONE("r-sat")]).workers[0]!;
	check("R3.12 manifest legacy layer + satellite merged: earliest retirableSince wins", mv.retirableSince === legacySince && mv.retiredAt === closed, JSON.stringify(mv));
	check(
		"R3.13 fleet's retired flag reads the MERGED layer (satellite-only retiredAt counts)",
		mergeRetireStamps(undefined, satLayer, "r-sat").retiredAt === closed,
	);
}

// ---------------------------------------------------------------------------
// R4. A retired worker is silent across every event kind
// ---------------------------------------------------------------------------

{
	const dir = taskDir("silent");
	const w = mkWorker(dir, "r-silent", { retiredAt: new Date(NOW - 60_000).toISOString() });
	writeValidReport(dir, "r-silent");
	// Herdr no longer knows the agent (the pane WAS closed) — without the
	// retiredAt guard this would fire a bogus worker-dead.
	const snap = snapshotFor([w], null);
	const seen = new Set<string>();
	const events = (() => {
		const mod = require("../src/observe.ts") as typeof import("../src/observe.ts");
		return mod.detectEvents(snapshotFor([w], null), seen, { nowMs: NOW });
	})();
	check("R4.1 retired worker emits ZERO events (no bogus worker-dead)", events.length === 0, JSON.stringify(events));
}

// ---------------------------------------------------------------------------
// R0. MASTER SWITCH watch.retire (default FALSE) — disabled mode is a NO-OP
// ---------------------------------------------------------------------------

{
	const dir = taskDir("gate-off");
	const w = mkWorker(dir, "r-off", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeManifestOnDisk(dir, [w]);
	writeValidReport(dir, "r-off");
	writeFileSync(releasePathFor(dir, "r-off"), JSON.stringify({ from: "orchestrator", ts: "T" })); // even an ACK
	const tOff = fakeTransport();
	const dOff = await retirePass(tOff, snapshotFor([w], [DONE("r-off")]), { nowMs: NOW, retireEnabled: false, retireTtlMs: 900_000 });
	check("R0.1 disabled → the pass is a no-op (no decisions)", dOff.length === 0);
	check("R0.2 disabled → panes NEVER close, even on ACK/TTL", tOff.teardownCalls.length === 0);
	check("R0.3 disabled → the manifest never gains stamps (no satellite layer either)", manifestFromDisk(dir).workers[0]?.retiredAt === undefined && stampsFromDisk(dir, "r-off").retiredAt === undefined, JSON.stringify(manifestFromDisk(dir).workers[0]));
	check("R0.4 disabled → an existing release marker is left unconsumed (mailbox deletes it)", existsSync(releasePathFor(dir, "r-off")));

	// An unstamped retirable worker under a DISABLED pass: no retirableSince either.
	const dir2 = taskDir("gate-off2");
	const w2 = mkWorker(dir2, "r-off2");
	writeManifestOnDisk(dir2, [w2]);
	writeValidReport(dir2, "r-off2");
	await retirePass(tOff, snapshotFor([w2], [DONE("r-off2")]), { nowMs: NOW, retireEnabled: false, retireTtlMs: 900_000 });
	check("R0.5 disabled → no retirableSince stamped (byte-identical to pre-§23)", manifestFromDisk(dir2).workers[0]?.retirableSince === undefined && stampsFromDisk(dir2, "r-off2").retirableSince === undefined && tOff.teardownCalls.length === 0);

	// The default resolution flows from the config resolver (hermetic: explicit).
	const tDefault = fakeTransport();
	await retirePass(tDefault, snapshotFor([w], [DONE("r-off")]), { nowMs: NOW, retireTtlMs: 900_000 });
	void tDefault; // host-config dependent — covered hermetically by R1.8 + R0.1/R0.2
}

// ---------------------------------------------------------------------------
// R5. retirePass — persisted clock, close exactly once, ownership
// ---------------------------------------------------------------------------

interface FakeTransport extends Transport {
	teardownCalls: Array<{ name: string; placement: Placement }>;
	failTeardown?: boolean;
	/** When set, teardown resolves with { alreadyGone: true } — the structured
	 *  idempotent-close signal (migration stage 1: the pane was ALREADY gone;
	 *  before this step the mock THREW a herdr "not found" message and the
	 *  retire pass re-parsed the text — the contract this migration removes). */
	alreadyGoneTeardown?: boolean;
}

function fakeTransport(): FakeTransport {
	const t: FakeTransport = {
		teardownCalls: [],
		failTeardown: false,
		teardown: async (req: TeardownReq) => {
			if (t.alreadyGoneTeardown) return { alreadyGone: true };
			if (t.failTeardown) throw new Error("herdr down");
			t.teardownCalls.push({ name: req.name, placement: req.placement });
			return { alreadyGone: false };
		},
	} as unknown as FakeTransport;
	return t;
}

function manifestFromDisk(dir: string): ExchangeManifest {
	return JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as ExchangeManifest;
}

/**
 * Effective retire stamps for a worker across ALL layers (manifest legacy
 * fields + the watcher's satellite files) — migration stage 3 (audit steps
 * 6/10): the watcher's stamps live in the satellite layer, readers merge.
 */
function stampsFromDisk(dir: string, name: string): { retirableSince?: string; retiredAt?: string } {
	const w = manifestFromDisk(dir).workers.find((x) => x.name === name);
	return mergeRetireStamps(
		{
			retirableSince: typeof w?.retirableSince === "string" && w.retirableSince.length > 0 ? w.retirableSince : undefined,
			retiredAt: typeof w?.retiredAt === "string" && w.retiredAt.length > 0 ? w.retiredAt : undefined,
		},
		readWatchStampLayers(dir),
		name,
	);
}

function dOwnCheckLegacy(t: FakeTransport): boolean {
	return t.teardownCalls[0]?.name === "r-legacy";
}

{
	const dir = taskDir("pass");
	const w = mkWorker(dir, "r-pass");
	writeManifestOnDisk(dir, [w]);
	writeValidReport(dir, "r-pass");
	const t = fakeTransport();

	// Tick 1: retirable, no stamp yet → stamp the clock, NO close.
	let decisions = await retirePass(t, snapshotFor([w], [DONE("r-pass")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	const stamped = stampsFromDisk(dir, "r-pass");
	check("R5.1 first retirable tick → retirableSince stamped (satellite layer, merged read)", typeof stamped?.retirableSince === "string", JSON.stringify(stamped));
	check("R5.1c the manifest layer itself stays untouched (watcher never writes it)", manifestFromDisk(dir).workers.find((x) => x.name === "r-pass")?.retirableSince === undefined);
	check("R5.1b no teardown on the stamping tick", t.teardownCalls.length === 0 && decisions.length === 0);

	// Tick 2 (TTL not elapsed): still waiting, stamp unchanged.
	await retirePass(t, snapshotFor([{ ...w, retirableSince: stamped!.retirableSince }], [DONE("r-pass")]), { nowMs: NOW + 1000, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.2 within TTL → no close", t.teardownCalls.length === 0);

	// Tick 3 (TTL elapsed): close + retiredAt, entry NEVER deleted.
	decisions = await retirePass(t, snapshotFor([{ ...w, retirableSince: stamped!.retirableSince }], [DONE("r-pass")]), { nowMs: NOW + 900_001, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.3 TTL elapsed → exactly one teardown with the recorded placement", t.teardownCalls.length === 1 && t.teardownCalls[0]?.name === "r-pass" && t.teardownCalls[0]?.placement.paneId === w.placement.paneId, JSON.stringify(t.teardownCalls));
	check("R5.3b the decision reason is ttl", decisions[0]?.reason === "ttl");
	const retired = stampsFromDisk(dir, "r-pass");
	check("R5.4 retiredAt stamped (satellite layer, merged read)", typeof retired?.retiredAt === "string", JSON.stringify(retired));
	check("R5.4b the manifest entry is NEVER deleted (history stays)", manifestFromDisk(dir).workers.length === 1 && manifestFromDisk(dir).workers[0]?.name === "r-pass");

	// Tick 4: already retired → never re-closed.
	await retirePass(t, snapshotFor([{ ...w, retiredAt: retired!.retiredAt }], [DONE("r-pass")]), { nowMs: NOW + 2_000_000, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.5 retired worker is never re-closed (exactly once)", t.teardownCalls.length === 1);

	// State broke after stamping → the clock clears (drained → re-asked).
	// Migration stage 3: the stamp is seeded by the PASS ITSELF (satellite
	// layer) — a manifest-layer legacy stamp cannot be cleared by the satellite
	// writer (the watcher never writes the manifest), so the scenario stamps
	// through the new path first.
	const dirB = taskDir("pass-reset");
	const wB = mkWorker(dirB, "r-reset");
	writeManifestOnDisk(dirB, [wB]);
	writeValidReport(dirB, "r-reset");
	await retirePass(t, snapshotFor([wB], [DONE("r-reset")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	const clock1 = stampsFromDisk(dirB, "r-reset").retirableSince;
	check("R5.6a first retirable tick → clock stamped in the satellite (merged read)", typeof clock1 === "string", JSON.stringify(stampsFromDisk(dirB, "r-reset")));
	await retirePass(t, snapshotFor([{ ...wB, retirableSince: clock1 }], [WORKING("r-reset")]), { nowMs: NOW + 1000, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.6 conditions broke → the persisted clock clears (TTL restarts)", stampsFromDisk(dirB, "r-reset").retirableSince === undefined, JSON.stringify(stampsFromDisk(dirB, "r-reset")));
	writeFileSync(questionPathFor(dirB, "r-reset"), JSON.stringify({ worker: "r-reset", ts: "T", question: "again?" }));
	await retirePass(t, snapshotFor([{ ...wB, retirableSince: clock1 }], [DONE("r-reset")]), { nowMs: NOW + 2000, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.6b a pending question also clears the stamp (never retirable)", stampsFromDisk(dirB, "r-reset").retirableSince === undefined, JSON.stringify(stampsFromDisk(dirB, "r-reset")));

	// Teardown throws → advisory: no retiredAt, retried next tick.
	const dirC = taskDir("pass-throw");
	const wC = mkWorker(dirC, "r-throw", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeManifestOnDisk(dirC, [wC]);
	writeValidReport(dirC, "r-throw");
	const tFail = fakeTransport();
	tFail.failTeardown = true;
	const logs: string[] = [];
	const dFail = await retirePass(tFail, snapshotFor([wC], [DONE("r-throw")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 }, (m) => logs.push(m));
	check("R5.7 teardown throw → no decision, no retiredAt, advisory log", dFail.length === 0 && stampsFromDisk(dirC, "r-throw").retiredAt === undefined && logs.some((l) => /retire pass error/.test(l)), JSON.stringify(logs));
	tFail.failTeardown = false;
	await retirePass(tFail, snapshotFor([wC], [DONE("r-throw")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.7b next tick retries and succeeds", stampsFromDisk(dirC, "r-throw").retiredAt !== undefined);

	// Teardown reports the structured ALREADY-GONE signal → the pane is ALREADY
	// gone (closed by herdr, the user, or another session): IDEMPOTENT close —
	// retiredAt stamped THIS tick, no error log, and every later tick is silent
	// (no spam). Migration stage 1: the signal is the teardown RESULT's
	// alreadyGone field — a thrown "not found" error is no longer a thing the
	// retire pass parses.
	const dirGone = taskDir("pass-gone");
	const wGone = mkWorker(dirGone, "r-gone", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeManifestOnDisk(dirGone, [wGone]);
	writeValidReport(dirGone, "r-gone");
	const tGone = fakeTransport();
	tGone.alreadyGoneTeardown = true;
	const logsGone: string[] = [];
	const dGone = await retirePass(tGone, snapshotFor([wGone], [DONE("r-gone")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 }, (m) => logsGone.push(m));
	check(
		"R5.8 teardown result alreadyGone:true → idempotent retire: decision + retiredAt + no error log",
		dGone.length === 1 &&
			stampsFromDisk(dirGone, "r-gone").retiredAt !== undefined &&
			!logsGone.some((l) => /retire pass error/.test(l)),
		JSON.stringify(logsGone),
	);
	const goneAfter = await retirePass(
		tGone,
		snapshotFor([{ ...wGone, retiredAt: stampsFromDisk(dirGone, "r-gone").retiredAt }], [DONE("r-gone")]),
		{ nowMs: NOW + 10_000, retireEnabled: true, retireTtlMs: 900_000 },
	);
	check("R5.8b already-retired → silent on every later tick (no spam)", goneAfter.length === 0 && tGone.teardownCalls.length === 0);

	// ACK: the release marker closes IMMEDIATELY (no stamp, no TTL wait).
	const dirD = taskDir("pass-ack");
	const wD = mkWorker(dirD, "r-ack");
	writeManifestOnDisk(dirD, [wD]);
	writeValidReport(dirD, "r-ack");
	writeFileSync(releasePathFor(dirD, "r-ack"), JSON.stringify({ from: "orchestrator", ts: "T" }));
	const tAck = fakeTransport();
	const dAck = await retirePass(tAck, snapshotFor([wD], [DONE("r-ack")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.8 ACK → immediate close + retiredAt", tAck.teardownCalls.length === 1 && dAck[0]?.reason === "ack" && stampsFromDisk(dirD, "r-ack").retiredAt !== undefined, JSON.stringify(dAck));
	check(
		"R5.8b the ACK marker is CONSUMED on close (a same-name retry must not inherit it)",
		!existsSync(releasePathFor(dirD, "r-ack")),
	);

	// TTL close also consumes a marker present at close time (e.g. posted in the
	// evaluate→close gap): a leftover release must never ACK-close a fresh
	// same-name retry on its first retirable tick.
	const dirD2 = taskDir("pass-ttl-marker");
	const wD2 = mkWorker(dirD2, "r-ttl2", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeManifestOnDisk(dirD2, [wD2]);
	writeValidReport(dirD2, "r-ttl2");
	writeFileSync(releasePathFor(dirD2, "r-ttl2"), JSON.stringify({ from: "orchestrator", ts: "T" }));
	const tTtl2 = fakeTransport();
	await retirePass(tTtl2, snapshotFor([wD2], [DONE("r-ttl2")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.8c TTL close also consumes a leftover marker", tTtl2.teardownCalls.length === 1 && !existsSync(releasePathFor(dirD2, "r-ttl2")));

	// Probes close immediately (no report, no stamp). NOTE: the probe flag is
	// manifest.dir.endsWith("/_probe") — the fixture dir must end EXACTLY so.
	const probeDir = taskDir("_probe");
	const pw = mkWorker(probeDir, "r-probe-pass");
	writeManifestOnDisk(probeDir, [pw]);
	const tProbe = fakeTransport();
	const dProbe = await retirePass(tProbe, snapshotFor([pw], [DONE("r-probe-pass")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.9 settled probe → immediate close, no stamp", tProbe.teardownCalls.length === 1 && dProbe[0]?.reason === "probe" && stampsFromDisk(probeDir, "r-probe-pass").retiredAt !== undefined, JSON.stringify(dProbe));

	// Ownership: a declared owner other than THIS watcher never mutates.
	const dirE = taskDir("pass-own");
	const ORCH_A = "/tmp/sessions/orch-a.jsonl";
	const wForeign = mkWorker(dirE, "r-foreign", {
		orchestratorSessionPath: ORCH_A,
		retirableSince: new Date(NOW - 900_000).toISOString(),
	});
	writeManifestOnDisk(dirE, [wForeign]);
	writeValidReport(dirE, "r-foreign");
	const tOwn = fakeTransport();
	await retirePass(tOwn, snapshotFor([wForeign], [DONE("r-foreign")]), { nowMs: NOW + 900_000, retireEnabled: true, retireTtlMs: 900_000, selfSessionFile: "/tmp/sessions/orch-b.jsonl" });
	check("R5.10 foreign-owned worker: NO stamp, NO close", tOwn.teardownCalls.length === 0 && manifestFromDisk(dirGone).workers[0]?.retirableSince !== undefined);
	const dOwn = await retirePass(tOwn, snapshotFor([wForeign], [DONE("r-foreign")]), { nowMs: NOW + 900_000, retireEnabled: true, retireTtlMs: 900_000, selfSessionFile: ORCH_A });
	check("R5.10b the OWNING session retires it", tOwn.teardownCalls.length === 1 && dOwn[0]?.reason === "ttl");
	// Degraded self-id (no sessionFile) fails CLOSED for a declared owner.
	const tDeg = fakeTransport();
	await retirePass(tDeg, snapshotFor([{ ...wForeign, retirableSince: new Date(NOW - 900_000).toISOString(), retiredAt: undefined }], [DONE("r-foreign")]), { nowMs: NOW + 900_000, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.10c degraded self-id + declared owner → fail-closed (no mutation)", tDeg.teardownCalls.length === 0);
	// Legacy manifest (no field) stays fail-open; self is never retired.
	const wLegacy = mkWorker(dirE, "r-legacy", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeManifestOnDisk(dirE, [wLegacy, wForeign]);
	writeValidReport(dirE, "r-legacy");
	const tLeg = fakeTransport();
	await retirePass(tLeg, snapshotFor([wLegacy], [DONE("r-legacy")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 0 });
	check("R5.11 legacy manifest → fail-open (any watcher may retire)", tLeg.teardownCalls.length === 1 && dOwnCheckLegacy(tLeg));
	const wSelf = mkWorker(dirE, "r-self");
	// Force self via the identity: same session file as the worker's own session.
	const selfSnap = workersFromManifests([{ task: "t", dir: dirE, workers: [wLegacy] }], [DONE("r-self")], { sessionFile: "/tmp/sessions/w-self.jsonl", cwd: "/tmp/wt/r-self" }, NOW);
	void wSelf;
	const tSelf = fakeTransport();
	await retirePass(tSelf, { ...selfSnap, workers: selfSnap.workers.map((x) => ({ ...x, self: true, retirableSince: new Date(NOW - 900_000).toISOString() })) }, { nowMs: NOW, retireEnabled: true, retireTtlMs: 0 });
	check("R5.12 a worker never retires ITSELF", tSelf.teardownCalls.length === 0);

	// Corrupt manifest on disk → the pass survives (advisory).
	const dirG = taskDir("pass-corrupt");
	const wG = mkWorker(dirG, "r-corrupt", { retirableSince: new Date(NOW - 900_000).toISOString() });
	writeFileSync(`${dirG}/manifest.json`, "{corrupt");
	const tCorrupt = fakeTransport();
	const dCorrupt = await retirePass(tCorrupt, snapshotFor([wG], [DONE("r-corrupt")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	check("R5.13 corrupt manifest → advisory failure, never a throw", dCorrupt.length === 0 && tCorrupt.teardownCalls.length === 0);
}

// ---------------------------------------------------------------------------
// R6. Static pins + release marker roundtrip
// ---------------------------------------------------------------------------

{
	const watchSrc = readFileSync(resolve(ROOT, "src/observe.ts"), "utf8");
	check("R6.1 the watcher tick runs the retire pass", /await retirePass\(/.test(watchSrc));
	const mailboxSrc = readFileSync(resolve(ROOT, "src/spawn.ts"), "utf8");
	check("R6.2 delegate_mailbox exposes the release action", /"read", "answer", "steer", "release"/.test(mailboxSrc) && /writeRelease\(/.test(mailboxSrc));
	check("R6.3 the mailbox release branch writes releasePathFor(dir, name)", /releasePathFor\(dir, params\.name\)/.test(mailboxSrc));
	check(
		"R6.5 the mailbox release branch gates on the watch.retire master switch",
		/resolveWatchConfig\(\)\.retire/.test(mailboxSrc) && /auto-teardown is disabled via watch\.retire/.test(mailboxSrc),
	);
	check(
		"R6.6 the disabled release branch deletes a stale marker (never fires after enabling)",
		/rm\(releasePath, \{ force: true \}\)/.test(mailboxSrc),
	);
	check(
		"R6.7 retirePass gates on the master switch (no-op when disabled)",
		/opts\.retireEnabled \?\? resolveWatchConfig\(\)\.retire/.test(watchSrc) && /if \(!enabled\) return \[\];/.test(watchSrc),
	);

	// writeRelease → releasePathFor roundtrip (the ACK surface end to end).
	const dir = taskDir("release-roundtrip");
	const p = releasePathFor(dir, "r-round");
	await writeRelease(p);
	check("R6.4 writeRelease lands an envelope at releasePathFor(dir, name)", existsSync(p) && /"orchestrator"/.test(readFileSync(p, "utf8")));
}

rmSync(FIX, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// R7. Archive-at-retire (diag-retire-msg Q3 item 1): a TTL retire of an
// UNCOLLECTED worker must not orphan the report — retirePass calls the
// archive helper after stamping retiredAt, so the report + manifest snapshot
// survive the worktree teardown. Idempotent: a second retire pass (history,
// skipped) or a re-archive must not duplicate the copy.
// ---------------------------------------------------------------------------

{
	const dir = taskDir("archive");
	const w = mkWorker(dir, "r-archive");
	writeManifestOnDisk(dir, [w]);
	writeValidReport(dir, "r-archive");
	const t = fakeTransport();

	// Tick 1: stamp the TTL clock. Tick 2: TTL elapsed → close + archive.
	await retirePass(t, snapshotFor([w], [DONE("r-archive")]), { nowMs: NOW, retireEnabled: true, retireTtlMs: 900_000 });
	const stamped = manifestFromDisk(dir).workers.find((x) => x.name === "r-archive");
	const decisions = await retirePass(
		t,
		snapshotFor([{ ...w, retirableSince: stamped!.retirableSince }], [DONE("r-archive")]),
		{ nowMs: NOW + 900_001, retireEnabled: true, retireTtlMs: 900_000 },
	);
	const archiveTaskDir = join(archiveRoot(), basename(dir));
	const archivedReport = join(archiveTaskDir, `report-r-archive.json`);
	check(
		"R7.1 TTL retire of an uncollected worker archives the report",
		decisions.length === 1 && existsSync(archivedReport),
		archivedReport,
	);
	check(
		"R7.2 the archive copy is byte-identical to the exchange report",
		existsSync(archivedReport) && readFileSync(archivedReport, "utf8") === readFileSync(`${dir}/report-r-archive.json`, "utf8"),
	);
	check(
		"R7.3 the archive carries a manifest snapshot (evidence outlives the worktree)",
		existsSync(join(archiveTaskDir, "manifest.json")),
	);

	// Second retire pass: the worker is history (retiredAt) → skipped; the
	// archive must NOT grow a duplicate.
	const retiredEntry = manifestFromDisk(dir).workers.find((x) => x.name === "r-archive");
	await retirePass(
		t,
		snapshotFor([{ ...w, retirableSince: stamped!.retirableSince, retiredAt: retiredEntry!.retiredAt }], [DONE("r-archive")]),
		{ nowMs: NOW + 900_002, retireEnabled: true, retireTtlMs: 900_000 },
	);
	check(
		"R7.4 second retire pass does not duplicate the archive (one report copy)",
		existsSync(archivedReport) && readdirSync(archiveTaskDir).filter((f) => f.startsWith("report-")).length === 1,
		JSON.stringify(readdirSync(archiveTaskDir)),
	);

	// Direct idempotency: re-archiving the SAME report rewrites in place —
	// the naming mirrors collect (basename preserved, no prefix).
	await retirePass(
		t,
		snapshotFor([{ ...w, retirableSince: stamped!.retirableSince, retiredAt: retiredEntry!.retiredAt }], [DONE("r-archive")]),
		{ nowMs: NOW + 900_003, retireEnabled: true, retireTtlMs: 900_000 },
	);
	check(
		"R7.5 re-archive keeps exactly one copy (idempotent naming)",
		readdirSync(archiveTaskDir).filter((f) => f.startsWith("report-")).length === 1,
	);
}

rmSync(FIX, { recursive: true, force: true });
rmSync(ARCHIVE_HOME, { recursive: true, force: true });
if (SAVED_HOME === undefined) delete process.env.HOME;
else process.env.HOME = SAVED_HOME;
console.log(failures === 0 ? "\nALL RETIRE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
