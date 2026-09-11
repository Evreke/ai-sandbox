/**
 * TS — W3 herdr socket read-only transport (HerdrSocketClient + integration).
 *
 * Run with: bun test/transport-socket.ts   (from repo root; the live check
 * TS.8 runs against the REAL herdr server — READ-ONLY `agent.list` only).
 *
 * Checks:
 *   TS.1 listStatuses maps a stub agent.list response (NDJSON over a scratch
 *        unix socket; the stub one-shots the connection like the real server).
 *   TS.2 getStatus found → mapped AgentStatus; TS.3 unknown → null (structured
 *        not_found error code, no message regex).
 *   TS.4 Unreachable server: listStatuses rejects fast with E_STATUS DelegateError
 *        and spawns ZERO herdr processes (canary stub on PATH stays silent).
 *   TS.5 Black-hole server (accepts, never answers): request rejects at ~
 *        requestTimeoutMs with request_timeout — bounded, no hang, no spawn.
 *   TS.6 Transparent reconnect: two sequential requests against the one-shot
 *        stub both succeed (server closed the connection after answer #1).
 *   TS.7 events.subscribe: ack received, pushed event line routed to the handler.
 *   TS.8 LIVE read-only validation: listStatuses against the real server returns
 *        the same agent names as the CLI `herdr agent list`.
 */

import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	HerdrTransport,
	HerdrSocketClient,
	parseHerdrResult,
} from "../src/herdr/host.ts";

const execFileP = promisify(execFile);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ART = mkdtempSync(`${tmpdir()}/pi-delegate-socket-`);
const SOCK = join(ART, "stub.sock");

// Canary stub on PATH: counts any herdr spawn (the socket path must spawn ZERO).
const CANARY_LOG = join(ART, "canary.log");
const CANARY_BIN = join(ART, "canary-bin");
mkdirSync(CANARY_BIN, { recursive: true });
writeFileSync(
	join(CANARY_BIN, "herdr"),
	[
		"#!/usr/bin/env node",
		"const fs = require(\"node:fs\");",
		"try { fs.appendFileSync(process.env.CANARY_LOG, \"1\\n\"); } catch {}",
		`const { spawn } = require("node:child_process");`,
		`const child = spawn(process.env.STUB_REAL_HERDR || "${process.env.HOME}/.local/bin/herdr", process.argv.slice(2), { stdio: "inherit" });`,
		"child.on(\"close\", (code) => process.exit(code ?? 1));",
	].join("\n"),
	{ mode: 0o755 },
);

function canaryCount(): number {
	try {
		return readFileSync(CANARY_LOG, "utf8").split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

const savedPath = process.env.PATH;
process.env.CANARY_LOG = CANARY_LOG;
process.env.PATH = `${CANARY_BIN}:${process.env.PATH}`;

/** One-request-per-connection stub server (real-server shape): answers each
 *  NDJSON request, then ENDS the connection. Handlers map method → result. */
function stubServer(handlers: Record<string, (params: Record<string, unknown>) => unknown>): Promise<{ server: Server; sockPath: string; connections: () => number }> {
	const sockPath = join(ART, `stub-${Math.random().toString(36).slice(2)}.sock`);
	const server = createServer((conn: NetSocket) => {
		conn.setEncoding("utf8");
		let buf = "";
		conn.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
				const h = handlers[req.method];
				const resp = h
					? { id: req.id, result: h(req.params ?? {}) }
					: { id: req.id, error: { code: "no_such_method", message: req.method } };
				conn.write(JSON.stringify(resp) + "\n");
				conn.end(); // ONE-REQUEST-PER-CONNECTION (real-server lifecycle)
			}
		});
	});
	let conns = 0;
	server.on("connection", () => conns++);
	return new Promise((resolve) => {
		server.listen(sockPath, () => resolve({ server, sockPath, connections: () => conns }));
	});
}

try {
	// -- TS.1: listStatuses over the stub socket -----------------------------------
	{
		const { server, sockPath } = await stubServer({
			"agent.list": () => ({
				agents: [
					{ name: "alpha", agent_status: "idle", pane_id: "w:p1", workspace_id: "w" },
					{ name: "beta", agent_status: "working", pane_id: "w:p2", workspace_id: "w" },
				],
			}),
		});
		const t = new HerdrTransport({ socketPath: sockPath });
		const statuses = await t.listStatuses();
		check(
			"TS.1 listStatuses maps the stub agent.list response",
			statuses.length === 2 && statuses[0].name === "alpha" && statuses[0].status === "idle" && statuses[0].placementRef === "herdr:pane:w:p1" && statuses[1].status === "working",
			JSON.stringify(statuses),
		);
		server.close();
	}

	// -- TS.2 / TS.3: getStatus found + structured not_found → null -----------------
	{
		const { server: srv2, sockPath: sock2 } = await new Promise<{ server: Server; sockPath: string }>((resolve) => {
			const s = createServer((conn: NetSocket) => {
				conn.setEncoding("utf8");
				let buf = "";
				conn.on("data", (chunk: string) => {
					buf += chunk;
					let nl: number;
					while ((nl = buf.indexOf("\n")) !== -1) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!line) continue;
						const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
						const target = String((req.params ?? {}).target ?? "");
						const resp =
							target === "ghost"
								? { id: req.id, error: { code: "agent_not_found", message: `agent target ${target} not found` } }
								: { id: req.id, result: { agent: { name: target, agent_status: "working", pane_id: "w:p9", workspace_id: "w" } } };
						conn.write(JSON.stringify(resp) + "\n");
						conn.end();
					}
				});
			});
			const p = join(ART, "get.sock");
			s.listen(p, () => resolve({ server: s, sockPath: p }));
		});
		const t = new HerdrTransport({ socketPath: sock2 });
		const found = await t.getStatus("alpha");
		check("TS.2 getStatus found → mapped AgentStatus", found !== null && found.name === "alpha" && found.status === "working", JSON.stringify(found));
		const ghost = await t.getStatus("ghost");
		check("TS.3 getStatus unknown → null via structured not_found", ghost === null);
		srv2.close();
	}

	// -- TS.4: unreachable server → fast per-call error, ZERO spawns ----------------
	{
		const t = new HerdrTransport({ socketPath: join(ART, "does-not-exist.sock") });
		const t0 = Date.now();
		let errMsg = "";
		let errCode = "";
		try {
			await t.listStatuses();
		} catch (err) {
			errMsg = (err as Error).message;
			errCode = String((err as { code?: string }).code ?? "");
		}
		const dt = Date.now() - t0;
		check("TS.4 unreachable server → E_STATUS DelegateError (per-call error, watcher degrades; migration stage 1: was a borrowed E_START)", errCode === "E_STATUS", `${errCode} ${errMsg}`);
		check("TS.4 unreachable server → fast (<1000ms, no hang)", dt < 1000, `${dt}ms`);
		check("TS.4 unreachable server → ZERO herdr processes spawned", canaryCount() === 0, `canary=${canaryCount()}`);
	}

	// -- TS.5: black-hole server → bounded request_timeout --------------------------
	// BUG_FIX_CONTEXT (CI, 2026-09-10): the black-hole server script lived as an
	// OUT-OF-REPO artifact (/tmp/exchange/herdr-resilience/... — a leftover
	// diagnosis file on the author's machine); on a runner the spawn failed
	// instantly, no server existed, and the client got connect_error at ~0ms
	// instead of the bounded request_timeout. The server is now INLINE (python3
	// -c) and readiness is awaited by polling for the socket file (no fixed
	// sleep race). Fixture hygiene: no /tmp/exchange dependency.
	{
		const bhSock = join(ART, "blackhole.sock");
		const bhScript = [
			"import os, socket, sys, time",
			"SOCK = sys.argv[1]",
			"if os.path.exists(SOCK): os.unlink(SOCK)",
			"srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
			"srv.bind(SOCK); srv.listen(256)",
			"sys.stdout.write('ready\\n'); sys.stdout.flush()",
			"held = []",
			"while True:",
			"    conn, _ = srv.accept()",
			"    held.append(conn)",
		].join("\n");
		const bh = spawn("python3", ["-c", bhScript, bhSock], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		// Deterministic readiness: wait for the server's 'ready' line (bounded).
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("black-hole server never became ready")), 5000);
			bh.stdout?.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("ready")) {
					clearTimeout(timer);
					resolve();
				}
			});
			bh.on("exit", () => {
				clearTimeout(timer);
				reject(new Error("black-hole server exited before ready"));
			});
		}).catch(() => undefined); // if readiness never came, the checks below fail with the real code
		const client = new HerdrSocketClient({ socketPath: bhSock, requestTimeoutMs: 500, connectTimeoutMs: 500 });
		const t0 = Date.now();
		let code = "";
		try {
			await client.request("agent.list");
		} catch (err) {
			code = (err as { code?: string }).code ?? "";
		}
		const dt = Date.now() - t0;
		check("TS.5 black-hole server → request_timeout (bounded, never hangs)", code === "request_timeout", `code=${code}`);
		check("TS.5 black-hole rejection lands at ~requestTimeoutMs", dt >= 450 && dt < 2000, `${dt}ms`);
		check("TS.5 black-hole scenario spawned ZERO processes", canaryCount() === 0, `canary=${canaryCount()}`);
		client.close();
		bh.kill();
	}

	// -- TS.6: transparent reconnect across one-shot connections --------------------
	{
		let hits = 0;
		const { server, sockPath, connections } = await stubServer({
			"agent.list": () => {
				hits++;
				return { agents: [{ name: "alpha", agent_status: "idle", pane_id: "w:p1", workspace_id: "w" }] };
			},
		});
		const t = new HerdrTransport({ socketPath: sockPath });
		const a = await t.listStatuses();
		const b = await t.listStatuses();
		check("TS.6 two sequential listStatuses both succeed across one-shot connections", a.length === 1 && b.length === 1);
		check("TS.6 stub saw a fresh connection per request (one-request-per-connection honored)", connections() >= 2, `connections=${connections()}`);
		check("TS.6 ZERO spawns", canaryCount() === 0, `canary=${canaryCount()}`);
		void hits;
		server.close();
	}

	// -- TS.7: events.subscribe — ack + pushed event routing ------------------------
	{
		const sockPath = join(ART, "sub.sock");
		const pushed: Array<{ event: string; data: unknown }> = [];
		await new Promise<void>((resolveSub) => {
			const server = createServer((conn: NetSocket) => {
				conn.setEncoding("utf8");
				let buf = "";
				conn.on("data", (chunk: string) => {
					buf += chunk;
					let nl: number;
					while ((nl = buf.indexOf("\n")) !== -1) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!line) continue;
						const req = JSON.parse(line) as { id: string; method: string };
						// ack the subscribe, then push one event over the SAME (kept-open) connection
						conn.write(JSON.stringify({ id: req.id, result: { subscription: "sub-1" } }) + "\n");
						setTimeout(() => {
							conn.write(JSON.stringify({ event: "pane_updated", data: { pane_id: "w:p1" } }) + "\n");
							resolveSub();
						}, 50);
						// no conn.end() — subscriptions keep the connection open
					}
				});
			});
			server.listen(sockPath, async () => {
				const client = new HerdrSocketClient({ socketPath: sockPath });
				await client.subscribe([{ type: "pane.updated" }], (event, data) => pushed.push({ event, data }));
			});
		});
		// The event is written by the stub but routed via the client's data handler
		// a tick later — poll briefly instead of checking synchronously.
		let routed = false;
		for (let i = 0; i < 40 && !routed; i++) {
			routed = pushed.length === 1;
			if (!routed) await new Promise((r) => setTimeout(r, 25));
		}
		check("TS.7 events.subscribe: pushed event routed to the handler (envelope key `event`, payload under `data`)", routed && pushed[0]?.event === "pane_updated" && (pushed[0]?.data as { pane_id?: string }).pane_id === "w:p1", JSON.stringify(pushed));
	}

	// -- TS.8: LIVE read-only validation against the real server --------------------
	// herdr-absence gate (CI lesson 2026-09-10): on a runner there is no herdr
	// server/socket — the LIVE leg must SKIP, not crash the whole file with an
	// unhandled connect ENOENT (offline legs TS.1–TS.7 already passed above).
	{
		const herdrLive = await (async () => {
			try {
				await execFileP("herdr", ["--version"], { encoding: "utf8", timeout: 10_000 });
				return true;
			} catch {
				return false;
			}
		})();
		if (!herdrLive) {
			console.log("SKIP TS.8 LIVE leg — herdr not available on this host (offline legs TS.1–TS.7 all ran)");
		} else {
		const t = new HerdrTransport(); // default socket resolution (env/default path)
		const socketStatuses = await t.listStatuses();
		check("TS.8 LIVE socket listStatuses resolves with ≥1 agent", socketStatuses.length >= 1, `n=${socketStatuses.length}`);
		const spawnsAfterSocketCall = canaryCount();
		check("TS.8 LIVE socket path spawned ZERO herdr processes", spawnsAfterSocketCall === 0, `canary=${spawnsAfterSocketCall}`);
		// CLI cross-check — NOTE: this intentionally spawns via the canary (it IS a
		// CLI call); the ZERO-spawn assertion above was captured BEFORE it.
		const { stdout } = await execFileP("herdr", ["agent", "list"], { encoding: "utf8", timeout: 10_000 });
		const cliResult = parseHerdrResult(stdout).result as { agents?: Array<{ name?: string }> } | Array<{ name?: string }>;
		const cliList = Array.isArray(cliResult) ? cliResult : (cliResult?.agents ?? []);
		const cliNames = new Set(cliList.map((a) => a.name).filter(Boolean));
		const socketNames = new Set(socketStatuses.map((s) => s.name));
		// Live shared fleet: agents can start/exit between the two snapshots —
		// tolerate a small symmetric difference, require substantial overlap.
		const symDiff = [...cliNames].filter((n) => !socketNames.has(n)).length + [...socketNames].filter((n) => !cliNames.has(n)).length;
		check(
			"TS.8 LIVE socket listStatuses matches CLI `herdr agent list` (fleet drift-tolerant: symDiff ≤ 2)",
			symDiff <= 2 && socketNames.size >= 1,
			`cli=${cliNames.size} socket=${socketNames.size} symDiff=${symDiff}`,
		);
		}
	}
} finally {
	process.env.PATH = savedPath;
	rmSync(ART, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
