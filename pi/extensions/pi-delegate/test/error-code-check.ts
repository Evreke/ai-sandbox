/**
 * Migration stage 1, step 2 (audit, errors critic defect 1) — the error CODE
 * is the error's own property: it is raised by the adapter as a typed
 * DelegateErrorImpl.code and READ by the tool layer from that field — never
 * matched out of the message text, never re-flattened at the intercept.
 *
 * Run with: bun test/error-code-check.ts   (from the extension dir)
 *
 * Checks:
 *   E1  adapter (herdr, PATH-stubbed): plain-text name-taken start failure →
 *       DelegateErrorImpl with code "E_NAME" (the typed field, no parsing).
 *   E2  adapter: status-read failure (`agent get` down) → code "E_STATUS"
 *       (was a borrowed E_START — DESIGN.md §7 backlog item closed).
 *   E3  adapter: tab-close failure → code "E_TEARDOWN" (was E_PLACE).
 *   E4  adapter: worktree-remove failure → code "E_TEARDOWN".
 *   E5  tool level: the SAME typed E_NAME from the herdr adapter travels
 *       through the REAL delegate tool execute() into the result's
 *       details.code — no intercept rewrites it, no text is parsed.
 *   E6  the new codes exist in the seam taxonomy with guidance attached.
 *
 * herdr is stubbed via a PATH shim (settle-archive pattern): no real herdr
 * ops, no network, no mutation outside mkdtemp dirs.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DelegateErrorImpl,
	type DelegateErrorCode,
	type Placement,
	type StartReq,
	type Transport,
} from "../src/host.ts";
import { createHerdrTransport } from "../src/herdr/host.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import { delegateErrorWithDetail, GUIDANCE } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// herdr PATH stub (settle-archive pattern): every verb we exercise fails on
// demand with a scripted stderr; anything else answers with a stub error.
// ---------------------------------------------------------------------------

const STUB_DIR = mkdtempSync(join(tmpdir(), "err-code-stub-"));

const SHIM = `#!/usr/bin/env bash
STUB="${STUB_DIR}"
case "$1 $2" in
  "agent start")
    cat "\${STUB}/start-stderr" >&2
    exit 1 ;;
  "agent get")
    cat "\${STUB}/get-stderr" >&2
    exit 1 ;;
  "tab close")
    cat "\${STUB}/tab-stderr" >&2
    exit 1 ;;
  "worktree remove")
    cat "\${STUB}/wt-stderr" >&2
    exit 1 ;;
  *)
    echo "{\\"error\\":{\\"code\\":\\"stub_unhandled\\",\\"message\\":\\"$*\\"}}" >&2
    exit 1 ;;
esac
`;
writeFileSync(join(STUB_DIR, "herdr"), SHIM, { mode: 0o755 });

const savedPath = process.env.PATH;
process.env.PATH = `${STUB_DIR}:${savedPath}`;
// Force the CLI paths — the socket read path must never see a real herdr here.
const savedSockEnv = process.env.HERDR_SOCKET_TRANSPORT;
process.env.HERDR_SOCKET_TRANSPORT = "cli";

function scriptFile(name: string, text: string) {
	writeFileSync(join(STUB_DIR, name), text);
}

// The adapter resolves authority from cwd; root authority (needed for the
// worktree-remove leg) requires a cwd OUTSIDE ~/.herdr/worktrees.
const savedCwd = process.cwd();
const rootCwd = mkdtempSync(join(tmpdir(), "err-code-cwd-"));
process.chdir(rootCwd);

try {
	// -------------------------------------------------------------------------
	// E1/E2/E3/E4 — adapter-level: the typed code comes off the error object
	// -------------------------------------------------------------------------
	const t = createHerdrTransport();

	// E1 — plain-text name-taken (herdr's second failure shape, §19.2 D4).
	scriptFile(
		"start-stderr",
		"herdr: agent start failed\nrouting-rev: name taken by a live agent (candidates: routing-rev-2, routing-rev-3)",
	);
	const startReq: StartReq = {
		name: "routing-rev",
		placementRef: "herdr:pane:p1",
		provider: "p",
		model: "m",
		thinking: "low",
		timeoutMs: 1000,
	};
	try {
		await t.startAgent(startReq);
		check("E1 plain-text name-taken → typed E_NAME", false, "no throw");
	} catch (e) {
		check(
			"E1 plain-text name-taken → typed E_NAME (read off DelegateErrorImpl.code, not parsed from text)",
			e instanceof DelegateErrorImpl && e.code === "E_NAME" && e.name === "DelegateError",
			`${(e as Error).name}: code=${(e as DelegateErrorImpl).code}`,
		);
	}

	// E2 — status read failure (non-not-found) → E_STATUS.
	scriptFile("get-stderr", "herdr stub: status store down");
	try {
		await t.getStatus("w");
		check("E2 status-read failure → typed E_STATUS", false, "no throw");
	} catch (e) {
		check(
			"E2 status-read failure → typed E_STATUS (was a borrowed E_START)",
			e instanceof DelegateErrorImpl && e.code === "E_STATUS",
			`code=${(e as DelegateErrorImpl).code}`,
		);
	}

	// E3 — tab close failure → E_TEARDOWN.
	const tabPlacement: Placement = {
		kind: "tab",
		workspaceId: "ws-x",
		paneId: "pane-x",
		checkoutPath: rootCwd,
		tabId: "tab-x",
	} as Placement;
	scriptFile("tab-stderr", "herdr stub: tab close exploded");
	try {
		await t.teardown({ name: "w", placement: tabPlacement, force: true });
		check("E3 tab-close failure → typed E_TEARDOWN", false, "no throw");
	} catch (e) {
		check(
			"E3 tab-close failure → typed E_TEARDOWN (was a borrowed E_PLACE)",
			e instanceof DelegateErrorImpl && e.code === "E_TEARDOWN",
			`code=${(e as DelegateErrorImpl).code}`,
		);
	}

	// E4 — worktree remove failure → E_TEARDOWN (root authority: cwd above).
	const wtPlacement: Placement = {
		kind: "worktree",
		workspaceId: "ws-y",
		paneId: "pane-y",
		branch: "delegate/err-code",
		checkoutPath: rootCwd,
	} as Placement;
	scriptFile("wt-stderr", "herdr stub: worktree remove exploded");
	try {
		await t.teardown({ name: "w", placement: wtPlacement, force: true });
		check("E4 worktree-remove failure → typed E_TEARDOWN", false, "no throw");
	} catch (e) {
		check(
			"E4 worktree-remove failure → typed E_TEARDOWN (was a borrowed E_PLACE)",
			e instanceof DelegateErrorImpl && e.code === "E_TEARDOWN",
			`code=${(e as DelegateErrorImpl).code}`,
		);
	}

	// -------------------------------------------------------------------------
	// E5 — tool level: the adapter's typed E_NAME reaches the delegate tool
	// result UNCHANGED. The hybrid transport mocks every verb EXCEPT
	// startAgent, which is the REAL herdr adapter against the stub — so the
	// full chain adapter → intercept → tool result is exercised, and the
	// intercept demonstrably reads the code from the typed error (the stub's
	// stderr text never enters any regex outside the adapter's own mapping).
	// -------------------------------------------------------------------------
	const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "err-code-exchange-"));
	process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
	const taskDir = join(EXCHANGE_SANDBOX, "err-code-task");
	mkdirSync(taskDir, { recursive: true });
	const NAME = "err-code-w";
	const briefPath = join(taskDir, `brief-${NAME}.md`);
	writeFileSync(briefPath, `# brief ${NAME}\n\nDo the thing. OUTPUT: report-${NAME}.json\n`);
	const repoDir = mkdtempSync(join(tmpdir(), "err-code-repo-"));

	const herdrAdapter = createHerdrTransport();
	const hybrid: Transport = {
		place: async (req) => ({
			kind: req.mode,
			workspaceId: "ws-mock",
			paneId: "pane-mock",
			branch: req.branch,
			checkoutPath: repoDir,
		}),
		startAgent: (req) => herdrAdapter.startAgent(req), // REAL adapter → stub → E_NAME
		submitPrompt: async () => {},
		waitSettle: async () => ({ status: "idle", timedOut: false }),
		getStatus: async () => null,
		listStatuses: async () => [],
		teardown: async () => {},
		capabilities: () => ({ worktrees: true, authority: "root" }),
	};

	let captured: { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> };
	const fakePi = { registerTool: (tl: never) => (captured = tl as never) };
	registerDelegateTool(fakePi as never, hybrid);

	const result = await captured.execute(
		"t1",
		{ name: NAME, briefPath, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir },
		undefined,
		() => {},
		{ cwd: repoDir, hasUI: false },
	);
	check(
		"E5 the adapter's typed E_NAME reaches the tool result code intact (no intercept re-flattening, no text parsing)",
		result.details.ok === false && result.details.code === "E_NAME",
		`details.code=${JSON.stringify(result.details.code)}`,
	);

	// -------------------------------------------------------------------------
	// E6 — the new codes are first-class taxonomy entries in the seam.
	// -------------------------------------------------------------------------
	const codes: DelegateErrorCode[] = ["E_TEARDOWN", "E_STATUS"];
	for (const code of codes) {
		const de = new DelegateErrorImpl(code, `${code} probe`, "");
		check(
			`E6 ${code} is a valid DelegateErrorCode with guidance attached`,
			de.code === code && typeof de.guidance === "string",
			`guidance=${de.guidance.slice(0, 60)}`,
		);
	}

	// -------------------------------------------------------------------------
	// E7 — step 3: the "name taken" hint has ONE source. Both adapters append
	// only a detail clause to the seam dictionary's base text.
	// -------------------------------------------------------------------------
	const { FakeWorkerHost } = await import("../src/host/fake.ts");
	const fake = new FakeWorkerHost({ repoPath: rootCwd });
	const p = await fake.place({ mode: "tab", repoPath: rootCwd, branch: "b", label: "l" });
	await fake.startAgent({ name: "dup", placementRef: p.placementRef ?? p.paneId, provider: "p", model: "m", thinking: "low", timeoutMs: 1000 });
	try {
		await fake.startAgent({ name: "dup", placementRef: p.placementRef ?? p.paneId, provider: "p", model: "m", thinking: "low", timeoutMs: 1000 });
		check("E7 fake collision guidance = dictionary base + detail", false, "no throw");
	} catch (e) {
		const g = (e as DelegateErrorImpl).guidance ?? "";
		check(
			"E7 fake collision: guidance STARTS with the dictionary base text (the adapter only appends its fact)",
			e instanceof DelegateErrorImpl &&
				g.startsWith(GUIDANCE.E_NAME) &&
				g.includes("existing agent: dup"),
			`guidance=${g}`,
		);
	}

	// The herdr adapter (E1 above) — same property on the real adapter.
	// Re-derive its error and assert the same base-text prefix.
	try {
		await t.startAgent(startReq);
	} catch (e) {
		const g = (e as DelegateErrorImpl).guidance ?? "";
		check(
			"E7b herdr collision: guidance STARTS with the dictionary base text + candidates fact",
			g.startsWith(GUIDANCE.E_NAME) && /candidates: routing-rev-2/.test(g),
			`guidance=${g}`,
		);
	}

	// E8 — source-level single-source pin: the base "choose a different name"
	// phrasing exists EXACTLY once across src/ (in the seam dictionary).
	const { readdirSync, readFileSync: rf, statSync: st } = await import("node:fs");
	const { dirname: dn, resolve: rs } = await import("node:path");
	const listSrc = (dir: string): string[] => {
		const out: string[] = [];
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const fp = rs(dir, e.name);
			if (e.isDirectory()) out.push(...listSrc(fp));
			else if (e.name.endsWith(".ts")) out.push(fp);
		}
		return out;
	};
	const srcDir = rs(dn(process.argv[1] ?? "."), "..", "src");
	const PHRASE = /choose a different name/i;
	const hits = listSrc(srcDir)
		.map((f) => ({ f, n: rf(f, "utf8").split(PHRASE).length - 1 }))
		.filter((x) => x.n > 0);
	check(
		"E8 the 'choose a different name' hint phrasing exists EXACTLY once across src/ (the seam dictionary)",
		hits.length === 1 && hits[0].f.endsWith(join("src", "host.ts")) && hits[0].n === 1,
		JSON.stringify(hits),
	);
	// And the dictionary entry is non-trivial (a real hint, not a stub).
	check("E8b GUIDANCE.E_NAME is the collision hint", PHRASE.test(GUIDANCE.E_NAME), GUIDANCE.E_NAME);

	// E9 — the exchange module's second error class is gone: ensureExchangeDir
	// raises through the ONE seam factory (typed DelegateErrorImpl + E_BRIEF).
	const { ensureExchangeDir } = await import("../src/exchange.ts");
	try {
		ensureExchangeDir("relative/brief.md");
		check("E9 ensureExchangeDir → seam-typed E_BRIEF", false, "no throw");
	} catch (e) {
		check(
			"E9 ensureExchangeDir raises through the ONE seam error factory (typed code + dictionary guidance, no second class)",
			e instanceof DelegateErrorImpl && (e as DelegateErrorImpl).code === "E_BRIEF" && (e as DelegateErrorImpl).guidance === GUIDANCE.E_BRIEF,
			`${(e as Error).name}`,
		);
	}

	rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
} finally {
	process.chdir(savedCwd);
	process.env.PATH = savedPath;
	if (savedSockEnv === undefined) delete process.env.HERDR_SOCKET_TRANSPORT;
	else process.env.HERDR_SOCKET_TRANSPORT = savedSockEnv;
	rmSync(STUB_DIR, { recursive: true, force: true });
	rmSync(rootCwd, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL ERROR-CODE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
