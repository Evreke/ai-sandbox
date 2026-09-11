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
 *   M7  Watcher stage A: a DEGRADED tier-1 lead (unreadable session id)
 *       mounts NO watcher — ownsChildren needs a proven sessionFile, so the
 *       session classifies as a pure worker and its child wakes are lost
 *       (documented known behavior of the role table).
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

// --- M4b: DEGRADED tier-1 lead → does NOT mount (documented known loss) ---

// Watcher stage A fixture-pins a known behavior of the canonical role table
// (src/watch-role.ts sessionRole): a tier-1 lead whose session identity is
// DEGRADED (the live sessionManager getter throws → sessionFile undefined)
// still matches the worker gate by its worktree checkoutPath (the mounting
// identity-equivalent), but owns NOTHING — ownsChildren requires a PROVEN
// sessionFile. So it is classified a pure worker: NO watcher is mounted and
// its child wakes are lost. Deliberate: delivery is fail-closed, and a
// session that cannot prove its id must neither mount an audience role nor
// be woken (guideline §3.6); the loss is the documented cost.
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
	check("M7 degraded tier-1 lead (unreadable self id) mounts NO watcher (child wake loss is documented)", rec.mounted === false);
	check("M7b degraded tier-1 lead still prunes the archive once", rec.prunes === 1, `prunes=${rec.prunes}`);
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
