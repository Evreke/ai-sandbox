/**
 * A6 (impl-settle) — unit-ish checks for DESIGN.md §19.1 (D3 two-phase
 * waitSettle), §19.2 (D4 second name-taken shape) and §19.3 (archive).
 *
 * Run with: bun test/settle-archive.ts   (from repo root)
 *
 * herdr is stubbed via a PATH shim (fix2 pattern, cf. test/reverify-fixes.ts):
 * a bash script whose `agent wait` pops scripted statuses from a text file.
 * Archive checks run against a temp HOME so the real archive is never touched.
 * No real herdr ops, no network, no mutation outside /tmp.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegateErrorImpl, createHerdrTransport } from "../src/transport/herdr.ts";
import { archiveReport, archiveRoot, listArchivedTasks } from "../src/archive.ts";
import type { StartReq } from "../src/transport/types.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// herdr PATH stub
// ---------------------------------------------------------------------------

const STUB_DIR = mkdtempSync(join(tmpdir(), "qa-settle-stub-"));

/** `agent wait` shim: pops one status line per call from wait-script.txt. */
const SHIM = `#!/usr/bin/env bash
STUB="${STUB_DIR}"
case "$1 $2" in
  "agent wait")
    SCRIPT="\${STUB}/wait-script.txt"
    s=$(head -n1 "$SCRIPT" 2>/dev/null)
    if [ "$(wc -l < "$SCRIPT")" -gt 1 ]; then
      tail -n +2 "$SCRIPT" > "\${SCRIPT}.tmp" && mv "\${SCRIPT}.tmp" "$SCRIPT"
    fi
    [ -z "$s" ] && s=idle
    echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$s\\"}}}"
    exit 0 ;;
  "agent get")
    s=$(cat "\${STUB}/get-status" 2>/dev/null || echo unknown)
    # v1.8: optional session path — waitSettle resolves it to check for an
    # assistant reply when it sees an unexplained idle.
    if [ -f "\${STUB}/get-session" ]; then
      sess=$(cat "\${STUB}/get-session")
      echo "{\\"result\\":{\\"agent\\":{\\"name\\":\\"stub\\",\\"agent_status\\":\\"$s\\",\\"agent_session\\":{\\"value\\":\\"$sess\\"}}}}"
    else
      echo "{\\"result\\":{\\"agent\\":{\\"name\\":\\"stub\\",\\"agent_status\\":\\"$s\\"}}}"
    fi
    exit 0 ;;
  "agent start")
    cat "\${STUB}/start-stderr" >&2
    exit 1 ;;
  *)
    echo "{\\"error\\":{\\"code\\":\\"stub_unhandled\\",\\"message\\":\\"$*\\"}}" >&2
    exit 1 ;;
esac
`;
writeFileSync(join(STUB_DIR, "herdr"), SHIM, { mode: 0o755 });

const savedPath = process.env.PATH;
const savedHome = process.env.HOME;
process.env.PATH = `${STUB_DIR}:${savedPath}`;

function scriptWait(statuses: string[]) {
	writeFileSync(join(STUB_DIR, "wait-script.txt"), `${statuses.join("\n")}\n`);
}
function scriptStartFailure(stderr: string) {
	writeFileSync(join(STUB_DIR, "start-stderr"), stderr);
}

try {
	// -------------------------------------------------------------------------
	// D3 — two-phase waitSettle (DESIGN.md §19.1)
	// -------------------------------------------------------------------------
	const t = createHerdrTransport();

	// 3.1 idle-before-start does NOT settle → full timeout, neverStarted.
	scriptWait(["idle"]); // never consumed → every slice reports idle
	{
		const t0 = Date.now();
		const r = await t.waitSettle({ name: "w-idle", timeoutMs: 2500 });
		check(
			"D3.1 idle-before-start never settles (neverStarted+timedOut, status unknown)",
			r.status === "unknown" && r.timedOut === true && r.neverStarted === true,
			JSON.stringify(r),
		);
		check("D3.1b ran the full timeoutMs budget", Date.now() - t0 >= 2400, `${Date.now() - t0}ms`);
	}

	// 3.2 unknown-before-start also never settles.
	scriptWait(["unknown"]);
	{
		const r = await t.waitSettle({ name: "w-unknown", timeoutMs: 2300 });
		check(
			"D3.2 unknown-before-start keeps polling → neverStarted",
			r.status === "unknown" && r.timedOut === true && r.neverStarted === true,
			JSON.stringify(r),
		);
	}

	// 3.3 working→idle settles normally, no neverStarted flag.
	scriptWait(["working", "idle"]);
	{
		const r = await t.waitSettle({ name: "w-work", timeoutMs: 20_000 });
		check(
			"D3.3 working→idle settles (status idle, no neverStarted)",
			r.status === "idle" && r.timedOut === false && r.neverStarted === undefined,
			JSON.stringify(r),
		);
	}

	// 3.4 blocked counts as a start observation AND a settled status → settles
	// on the first slice.
	scriptWait(["blocked"]);
	{
		const r = await t.waitSettle({ name: "w-block", timeoutMs: 20_000 });
		check(
			"D3.4 blocked settles immediately (started + settled)",
			r.status === "blocked" && r.timedOut === false && r.neverStarted === undefined,
			JSON.stringify(r),
		);
	}

	// 3.5 done as the FIRST observation settles immediately: done proves the
	// prompt was consumed (a worker that starts AND finishes within one slice is
	// NOT neverStarted — R6 fix) and means finished → settled phase at once.
	scriptWait(["done"]);
	{
		const r = await t.waitSettle({ name: "w-done-first", timeoutMs: 20_000 });
		check(
			"D3.5 first-observation done settles immediately (proves life)",
			r.status === "done" && r.timedOut === false && r.neverStarted === undefined,
			JSON.stringify(r),
		);
	}

	// 3.6 done BEFORE any working observation still proves life; since done is
	// also a settled status the first slice settles immediately.
	scriptWait(["done", "idle"]);
	{
		const r = await t.waitSettle({ name: "w-done-then-idle", timeoutMs: 20_000 });
		check(
			"D3.6 first-slice done settles (started + settled)",
			r.status === "done" && r.timedOut === false && r.neverStarted === undefined,
			JSON.stringify(r),
		);
	}

	// -------------------------------------------------------------------------
	// D3.7+ — v1.8 aged-finish fix (DESIGN.md §19.1b): herdr ages done→idle
	// within minutes (live-reproduced 2026-09-05: probe, probe-retry,
	// fresh-probe-x all flipped), so a late watcher sees only idle and can never
	// observe working/done — it spun the FULL timeout, then false-reported
	// neverStarted while the pane showed a passed smoke gate. Disambiguation:
	// session JSONL assistant reply = already finished.
	// -------------------------------------------------------------------------
	const sessDir = mkdtempSync(join(tmpdir(), "qa-sess-"));
	const repliedSession = join(sessDir, "replied.jsonl");
	writeFileSync(
		repliedSession,
		'{"type":"message","message":{"role":"user","content":[]}}\n' +
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"OUTPUT: OK"}]}}\n',
	);
	const emptySession = join(sessDir, "empty.jsonl");
	writeFileSync(emptySession, '{"type":"message","message":{"role":"user","content":[]}}\n');
	const corruptSession = join(sessDir, "corrupt.jsonl");
	writeFileSync(corruptSession, "{ half-written line\n");

	// 3.7 aged finish: idle forever + session shows an assistant reply → settles
	// immediately as finishedBeforeWatch (was: full timeout + false neverStarted).
	scriptWait(["idle"]);
	writeFileSync(join(STUB_DIR, "get-status"), "idle");
	writeFileSync(join(STUB_DIR, "get-session"), repliedSession);
	{
		const t0 = Date.now();
		const r = await t.waitSettle({ name: "w-aged", timeoutMs: 10_000 });
		check(
			"D3.7 aged done→idle settles via session reply proof (finishedBeforeWatch)",
			r.status === "idle" && r.timedOut === false && r.finishedBeforeWatch === true && r.neverStarted === undefined,
			JSON.stringify(r),
		);
		check("D3.7b settles immediately, no timeout spin", Date.now() - t0 < 5_000, `${Date.now() - t0}ms`);
	}

	// 3.8 idle + session WITHOUT an assistant reply → genuinely never started →
	// keeps polling to the full timeout and reports neverStarted (the D3 fix's
	// original protection must not regress).
	writeFileSync(join(STUB_DIR, "get-session"), emptySession);
	{
		const r = await t.waitSettle({ name: "w-empty", timeoutMs: 2500 });
		check(
			"D3.8 idle + reply-less session stays neverStarted (no false salvage)",
			r.status === "unknown" && r.timedOut === true && r.neverStarted === true,
			JSON.stringify(r),
		);
	}

	// 3.9 corrupt session → no proof → neverStarted (tolerant, never throws).
	writeFileSync(join(STUB_DIR, "get-session"), corruptSession);
	{
		const r = await t.waitSettle({ name: "w-corrupt", timeoutMs: 2500 });
		check(
			"D3.9 corrupt session file → no proof, neverStarted (never throws)",
			r.neverStarted === true,
			JSON.stringify(r),
		);
	}

	// 3.10 missing session file → no proof → neverStarted.
	writeFileSync(join(STUB_DIR, "get-session"), join(sessDir, "absent.jsonl"));
	{
		const r = await t.waitSettle({ name: "w-absent", timeoutMs: 2500 });
		check("D3.10 missing session file → no proof, neverStarted", r.neverStarted === true, JSON.stringify(r));
	}

	// 3.11 heartbeat: onPoll fires per slice with the observed state.
	scriptWait(["working", "working", "idle"]);
	{
		const polls: Array<{ status: string; started: boolean }> = [];
		const r = await t.waitSettle({
			name: "w-beat",
			timeoutMs: 20_000,
			onPoll: (info) => polls.push({ status: info.status, started: info.started }),
		});
		check(
			"D3.11 onPoll heartbeat fires per slice with observed state",
			polls.length >= 2 && polls[0].status === "working" && polls.some((p) => p.started),
			JSON.stringify(polls),
		);
		check(
			"D3.11b heartbeat did not change the settle outcome",
			r.status === "idle" && r.timedOut === false,
			JSON.stringify(r),
		);
	}

	// 3.12 aged finish on the reconcile path too (slice unknown → getStatus
	// reconcile returns idle + session reply → settles).
	scriptWait(["unknown", "idle"]);
	writeFileSync(join(STUB_DIR, "get-session"), repliedSession);
	{
		const r = await t.waitSettle({ name: "w-reconcile", timeoutMs: 10_000 });
		check(
			"D3.12 reconcile-path aged finish settles (finishedBeforeWatch)",
			r.status === "idle" && r.finishedBeforeWatch === true,
			JSON.stringify(r),
		);
	}

	rmSync(sessDir, { recursive: true, force: true });

	// -------------------------------------------------------------------------
	// D4 — second name-taken shape (DESIGN.md §19.2)
	// -------------------------------------------------------------------------
	const startReq: StartReq = {
		name: "routing-rev",
		paneId: "pane-stub",
		provider: "llm-platform",
		model: "tensorzero::function_name::flash",
		thinking: "high",
		timeoutMs: 1000,
	};

	// 4.1 plain-text variant: "…routing-rev: name taken by a live agent (candidates: …)"
	scriptStartFailure(
		"herdr: agent start failed\nrouting-rev: name taken by a live agent (candidates: routing-rev-2, routing-rev-3)",
	);
	try {
		await t.startAgent(startReq);
		check("D4.1 plain-text name-taken maps to E_NAME", false, "no throw");
	} catch (e) {
		const de = e as DelegateErrorImpl;
		check(
			"D4.1 plain-text name-taken maps to E_NAME",
			de instanceof DelegateErrorImpl && de.code === "E_NAME",
			`code=${(e as Error).name}`,
		);
		check(
			"D4.1b candidate-list guidance present",
			/routing-rev-2/.test(de.guidance ?? "") && /routing-rev-2/.test(de.message ?? ""),
			`guidance=${de.guidance}`,
		);
	}

	// 4.2 legacy agent_name_taken code path still maps to E_NAME.
	scriptStartFailure("agent_name_taken: routing-rev (candidates: routing-rev-2)");
	try {
		await t.startAgent(startReq);
		check("D4.2 legacy agent_name_taken still maps to E_NAME", false, "no throw");
	} catch (e) {
		const de = e as DelegateErrorImpl;
		check(
			"D4.2 legacy agent_name_taken still maps to E_NAME",
			de instanceof DelegateErrorImpl && de.code === "E_NAME" && /routing-rev-2/.test(de.guidance ?? ""),
			`code=${de.code} guidance=${de.guidance}`,
		);
	}

	// 4.3 unrelated start failure still maps to E_START (no over-matching).
	scriptStartFailure("pane not ready: shell prompt never appeared");
	try {
		await t.startAgent(startReq);
		check("D4.3 unrelated failure stays E_START", false, "no throw");
	} catch (e) {
		const de = e as DelegateErrorImpl;
		check(
			"D4.3 unrelated failure stays E_START",
			de instanceof DelegateErrorImpl && de.code === "E_START",
			`code=${de.code}`,
		);
	}

	// -------------------------------------------------------------------------
	// §19.3 — archive round-trip + failure tolerance
	// -------------------------------------------------------------------------
	const fakeHome = mkdtempSync(join(tmpdir(), "qa-archive-home-"));
	process.env.HOME = fakeHome;

	// 5.1 missing archive root → [].
	check("A.1 missing archiveRoot → []", JSON.stringify(listArchivedTasks()) === "[]");

	// 5.2 round-trip: report copied, manifest written, dest path returned.
	const taskDir = join(fakeHome, "tasks", "v16-demo"); // basename is the task id
	const reportPath = join(taskDir, "report-demo-worker.json");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(reportPath, JSON.stringify({ worker: "demo-worker", status: "pass" }));
	const manifest = { task: "v16-demo", collected: 1, verdicts: { "demo-worker": "pass" } };
	// Brief/R6 contract: dest = <archiveRoot>/<basename(taskDir)>/<basename(reportPath)>
	// — basename preserved AS-IS (R6 fix: no "report-" prefix; collected reports
	// already carry it).
	const dest = archiveReport(taskDir, reportPath, manifest);
	check(
		"A.2 archiveReport returns <root>/<task>/<basename(reportPath)> unprefixed",
		dest === join(archiveRoot(), "v16-demo", "report-demo-worker.json"),
		`dest=${dest}`,
	);
	let copied = "";
	try {
		copied = readFileSync(join(archiveRoot(), "v16-demo", "report-demo-worker.json"), "utf8");
	} catch {
		/* leave empty → check fails */
	}
	check("A.2b report content copied verbatim", copied.includes("demo-worker"));
	let manifestBack: unknown = null;
	try {
		manifestBack = JSON.parse(readFileSync(join(archiveRoot(), "v16-demo", "manifest.json"), "utf8"));
	} catch {
		/* stays null */
	}
	check(
		"A.2c manifest.json written atomically alongside",
		JSON.stringify(manifestBack) === JSON.stringify(manifest),
	);
	check(
		"A.2d listArchivedTasks sees the task",
		JSON.stringify(listArchivedTasks()) === JSON.stringify(["v16-demo"]),
	);

	// 5.3 second collect into the same task: manifest updated, both reports kept.
	writeFileSync(reportPath, JSON.stringify({ worker: "demo-worker", status: "pass", v: 2 }));
	archiveReport(taskDir, reportPath, { ...manifest, collected: 2 });
	const updated = JSON.parse(readFileSync(join(archiveRoot(), "v16-demo", "manifest.json"), "utf8")) as {
		collected: number;
	};
	check("A.3 manifest re-written on second collect", updated.collected === 2);

	// 5.3b basename WITHOUT a report- prefix is preserved as-is too (no mangling
	// in either direction).
	const plainPath = join(taskDir, "collected.json");
	writeFileSync(plainPath, "{}");
	check(
		"A.3b non-prefixed basename preserved as-is",
		archiveReport(taskDir, plainPath, manifest) === join(archiveRoot(), "v16-demo", "collected.json"),
	);

	// 5.4 failure tolerance: unreadable source report → null, never throw.
	check(
		"A.4 missing source report → null (never throws)",
		archiveReport(taskDir, join(taskDir, "nope.json"), manifest) === null,
	);
	// 5.5 failure tolerance: empty taskDir basename → null.
	check("A.5 empty taskDir basename → null", archiveReport("/", reportPath, manifest) === null);

	// 5.6 task dirs WITHOUT manifest.json are not listed.
	mkdirSync(join(archiveRoot(), "half-written"), { recursive: true });
	check(
		"A.6 dirs without manifest.json excluded",
		JSON.stringify(listArchivedTasks()) === JSON.stringify(["v16-demo"]),
		JSON.stringify(listArchivedTasks()),
	);

	rmSync(fakeHome, { recursive: true, force: true });
} finally {
	process.env.PATH = savedPath;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(STUB_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
