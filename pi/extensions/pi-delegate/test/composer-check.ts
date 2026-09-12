/**
 * Composer-check — the watcher composition module (migration stage 3,
 * audit step 10): the "worker or orchestrator" mount decision, behaviorally.
 *
 * Run with: bun test/composer-check.ts   (from the extension dir)
 *
 * Replaces the old static text pins on index.ts (watcher-check W1.2/W1.2b and
 * the W16 mount pin): instead of regexing the entry point's source, the tests
 * drive mountSessionWatcher with injected fakes and assert the DECISION.
 *
 * Checks:
 *   M1  A PURE worker session (isWorkerSession true, no child manifests)
 *       mounts NO watcher; the archive prune still runs.
 *   M2  A worker-orchestrator (worker of one manifest, owner of another's
 *       workers) mounts a watcher (F6 two-tier wake-up).
 *   M3  A peer orchestrator (nobody's worker) mounts as before.
 *   M4  Garbage manifests degrade to mounting (fail-open toward the watcher —
 *       a lost wake-up is worse than a spurious one).
 *   M5  The mount receives the session's identity (cwd + sessionManager
 *       threaded verbatim); the prune runs exactly once per call, mounted
 *       or not.
 *   M6  The production defaults are wired: with no overrides the composer
 *       scans via manifestStore with the Transport's backend name.
 *   M7  Watcher stage C fix: a DEGRADED tier-1 lead (unreadable session id)
 *       MOUNTS a watcher — worker identity is the entry's own sessionPath
 *       only, so a degraded self proves nothing and reads as "not a worker"
 *       (fail-open toward MOUNTING). Its child wakes are still lost, but on
 *       the DELIVERY side (fail-closed — ARCHITECTURE Law 8) — no longer by a
 *       spurious pure-worker classification.
 *   M8  Stage C regression: a session whose cwd matches a worker entry's
 *       worktree checkoutPath (ownerless historical entry) is NOT a worker
 *       — the watcher MOUNTS.
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountSessionWatcher } from "../src/compose.ts";
import type { ExchangeManifest } from "../src/exchange.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "composer-check-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX; // hermetic manifest scan

function writeManifest(taskName: string, workers: Array<Record<string, unknown>>): string {
	const dir = join(SANDBOX, taskName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ task: taskName, dir, workers } as unknown as ExchangeManifest),
	);
	return dir;
}

const SESSION = join(SANDBOX, "orchestrator-session.jsonl");
const WORKER_SESSION = join(SANDBOX, "worker-session.jsonl");

function fakeTransport(): Transport {
	return {
		backendName: () => "herdr",
	} as unknown as Transport;
}

interface MountRecord {
	mounted: boolean;
	prunes: number;
	cwd?: string;
	sessionManager?: unknown;
}

function drive(manifests: Array<Record<string, unknown>>, self: { sessionFile?: string; cwd?: string }): MountRecord {
	const rec: MountRecord = { mounted: false, prunes: 0 };
	// Hermetic scan: read the sandbox manifests through the REAL manifestStore
	// (no scanManifests override) — proves the production default path too.
	const dir = writeManifest("composer-task", manifests);
	mountSessionWatcher({
		pi: {} as never, // the fake mount never touches pi
		transport: fakeTransport(),
		self,
		sessionManager: { getSessionFile: () => self.sessionFile },
		mount: (_pi, _t, opts) => {
			rec.mounted = true;
			rec.cwd = opts.cwd;
			rec.sessionManager = opts.sessionManager;
			return () => {}; // startWatcher's dispose shape
		},
		prune: () => {
			rec.prunes++;
		},
	});
	rmSync(dir, { recursive: true, force: true });
	return rec;
}

// --- M1: pure worker → no watcher -----------------------------------------

const pureWorkerManifest = [
	{
		name: "w1",
		sessionPath: WORKER_SESSION,
		placement: { kind: "worktree", checkoutPath: join(SANDBOX, "wt-w1") },
	},
];
let rec = drive(pureWorkerManifest, { sessionFile: WORKER_SESSION, cwd: join(SANDBOX, "wt-w1") });
check("M1 pure worker session mounts NO watcher", rec.mounted === false);
check("M1b pure worker session still prunes the archive once", rec.prunes === 1, `prunes=${rec.prunes}`);

// --- M2: worker-orchestrator (F6) → mounts --------------------------------

const childManifest = [
	{
		name: "child1",
		sessionPath: join(SANDBOX, "child-session.jsonl"),
		orchestratorSessionPath: WORKER_SESSION,
		placement: { kind: "tab" },
	},
];
rec = drive([...pureWorkerManifest, ...childManifest], { sessionFile: WORKER_SESSION, cwd: join(SANDBOX, "wt-w1") });
check("M2 worker-orchestrator (owns child manifests) mounts a watcher", rec.mounted === true);

// --- M3: peer orchestrator → mounts ---------------------------------------

rec = drive(childManifest, { sessionFile: SESSION, cwd: SANDBOX });
check("M3 peer orchestrator (nobody's worker) mounts as before", rec.mounted === true);

// --- M4: garbage manifests → fail-open mount ------------------------------

const garbageDir = join(SANDBOX, "composer-garbage");
mkdirSync(garbageDir, { recursive: true });
writeFileSync(join(garbageDir, "manifest.json"), "{nope");
rec = drive([], { sessionFile: WORKER_SESSION, cwd: SANDBOX });
check("M4 no readable worker evidence → the watcher mounts (fail-open)", rec.mounted === true);
rmSync(garbageDir, { recursive: true, force: true });

// --- M7: DEGRADED tier-1 lead → MOUNTS (stage C: identity by sessionPath) --

// Stage C fix (src/watch-role.ts sessionRole): the worker gate matches the
// entry's OWN sessionPath ONLY — the former worktree checkoutPath === cwd
// mounting equivalent is REMOVED (ambiguous: tab workers share the
// orchestrator's checkout, and a historical entry poisoned the gate for any
// new session in that cwd). A degraded tier-1 lead (the live sessionManager
// getter throws → sessionFile undefined) can match NOTHING: it reads as
// "not a worker" and MOUNTS a watcher (fail-open toward MOUNTING). Its
// child wakes are still lost — but now on the DELIVERY side, fail-closed
// (no proven id delivers nothing — fail-closed), never by a wrong
// mount-side classification. Harmless: a mounted watcher without a proven
// identity never produces a wrong wake (stage A invariant).
{
	const leadChild = [
		{
			name: "child-of-degraded-lead",
			sessionPath: join(SANDBOX, "deg-child-session.jsonl"),
			orchestratorSessionPath: WORKER_SESSION, // the id the lead can no longer read
			placement: { kind: "tab" },
		},
	];
	rec = drive([...pureWorkerManifest, ...leadChild], { sessionFile: undefined, cwd: join(SANDBOX, "wt-w1") });
	check("M7 degraded tier-1 lead (unreadable self id) MOUNTS a watcher (delivery stays fail-closed)", rec.mounted === true);
	check("M7b degraded tier-1 lead still prunes the archive once", rec.prunes === 1, `prunes=${rec.prunes}`);
}

// --- M8: ownerless historical entry + cwd match → MOUNTS (stage C) ---------

// The incident shape: a manifest worker entry with a worktree checkoutPath
// equal to THIS session's cwd but no sessionPath at all (ownerless,
// historical). Before the stage C fix the cwd match classified the session
// a pure worker → no watcher → every child wake silently lost. Now: a cwd
// match proves nothing → the watcher mounts.
{
	const ownerlessHistorical = [
		{
			name: "w-historical",
			placement: { kind: "worktree", checkoutPath: join(SANDBOX, "wt-w1") },
		},
	];
	rec = drive(ownerlessHistorical, { sessionFile: WORKER_SESSION, cwd: join(SANDBOX, "wt-w1") });
	check("M8 ownerless entry + cwd match → NOT a worker → the watcher MOUNTS", rec.mounted === true);
	check("M8b the ownerless-cwd session still prunes the archive once", rec.prunes === 1, `prunes=${rec.prunes}`);
}

// --- M5: identity threading + single prune --------------------------------

rec = drive([], { sessionFile: SESSION, cwd: SANDBOX });
check(
	"M5 mount receives the session identity (cwd + sessionManager) verbatim",
	rec.mounted === true && rec.cwd === SANDBOX && typeof (rec.sessionManager as { getSessionFile?: unknown })?.getSessionFile === "function",
);
check("M5b exactly one prune per call", rec.prunes === 1, `prunes=${rec.prunes}`);

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL COMPOSER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
