/**
 * pi-delegate — src/host/fake.ts (PoC, workerhost inversion design §7).
 *
 * MODULE_CONTRACT — minimal in-memory WorkerHost: implements the Transport
 * seam from src/host.ts against pure in-memory state. Lets the watcher /
 * mailbox / retire tests and this PoC drive the FULL spawn flow herdr-free
 * and proves the seam works end-to-end with an OPAQUE placementRef
 * (place → manifest → teardown) while the legacy-shaped id fields
 * (workspaceId/paneId) stay populated alongside (version-skew rule, design §4).
 *
 * Dependencies: src/host.ts (seam) + src/exchange.ts (manifest write) ONLY —
 * deliberately NO herdr imports (that confinement is what the static pins
 * protect). Not bound in index.ts yet — binding/config swap is migration
 * step 6 (impl, out of PoC scope).
 *
 * Critical invariants (seam-level, mirrored here so parity tests mean the
 * same thing on every backend):
 *   - serialized-mutations: state mutations are synchronous in-memory —
 *     trivially serialized (the requirement stays in the seam docs).
 *   - teardown not-found → idempotent no-op success (pinned seam semantics).
 *   - name-taken → E_NAME with candidate guidance (D4, seam contract).
 *   - worktree placement rejected when capabilities().worktrees is false
 *     (authority model — the fake runs root authority but fakes no
 *     filesystem isolation, so it only serves tab placement).
 *
 * Scripted behavior: statuses come from a FIFO statusScript consumed by
 * waitSettle (one status per poll slice) and peeked by getStatus/listStatuses.
 */

import {
	type AgentStatus,
	type AgentStatusName,
	delegateErrorWithDetail,
	DelegateErrorImpl,
	type Placement,
	type PlacementMode,
	type PlacementReq,
	type PromptReq,
	type SettleResult,
	type StartReq,
	type StartResult,
	type TeardownReq,
	type TeardownResult,
	type Transport,
	type TransportCapabilities,
} from "../host.ts";
import { manifestStore, type ManifestWorker } from "../exchange.ts";

const SETTLED: readonly AgentStatusName[] = ["idle", "done", "blocked"];
const STARTED: readonly AgentStatusName[] = ["working", "blocked", "done"];

export interface FakeHostOptions {
	/** Repo the fake "places" into — checkoutPath points at it (tab mode: no
	 *  real checkout is created; this is an in-memory fake). */
	repoPath: string;
	/** When set, startAgent appends a ManifestWorker entry here — with
	 *  backend:"fake" + placementRef ALONGSIDE the legacy id fields. */
	manifestDir?: string;
	/** Manifest entry fields when manifestDir is set (spawn.ts owns the real
	 *  write; the fake only needs them for the standalone round-trip PoC). */
	briefPath?: string;
	reportPath?: string;
	/** FIFO of statuses consumed by waitSettle slices (default ["idle"]). */
	statusScript?: AgentStatusName[];
}

interface FakeAgent {
	name: string;
	placement: Placement;
}

export class FakeWorkerHost implements Transport {
	readonly opts: FakeHostOptions;
	private seq = 0;
	private script: AgentStatusName[];
	/** Keyed by placementRef (opaque — the seam's StartReq key since migration
	 *  step 3; legacy pane ids accepted as fallback keys). */
	private placements = new Map<string, Placement>();
	private agents = new Map<string, FakeAgent>();
	/** Last status consumed from the script — getStatus falls back to it once
	 *  the script is exhausted (an agent keeps its final state). */
	private lastObserved: AgentStatusName = "unknown";
	/** Teardown call counter — idempotency proof reads this. */
	teardownCalls = 0;
	/** Prompts accepted by submitPrompt (the seam returns after acceptance). */
	prompts: string[] = [];

	constructor(opts: FakeHostOptions) {
		this.opts = opts;
		this.script = [...(opts.statusScript ?? ["idle"])];
	}

	capabilities(): TransportCapabilities {
		return { worktrees: false, authority: "root" };
	}

	/** Migration stage 3 (audit step 9): must match the `backend: "fake"`
	 *  spelling place() writes into fake placements. */
	backendName(): string {
		return "fake";
	}

	async place(req: PlacementReq): Promise<Placement> {
		if (req.mode === "worktree") {
			// Authority model (seam contract): worktrees:false → place() rejects.
			throw new DelegateErrorImpl(
				"E_PLACE",
				`fake host: worktree placement not supported (requested for ${req.repoPath})`,
				"Use tab placement on the fake host.",
			);
		}
		const n = ++this.seq;
		// Opaque, adapter-defined, unique per live placement — the seam never
		// decodes it (design §2 verdict: only equality matching outside adapters).
		const placementRef = `fake:${n}`;
		const placement: Placement = {
			kind: "tab" satisfies PlacementMode,
			workspaceId: `fake-ws-${n}`,
			paneId: `fake:p${n}`,
			checkoutPath: this.opts.repoPath,
			backend: "fake",
			placementRef,
		};
		this.placements.set(placementRef, placement);
		return placement;
	}

	async startAgent(req: StartReq): Promise<StartResult> {
		// Keyed by the opaque placementRef (migration step 3); a legacy raw id
		// (req.paneId-style fallback key) still resolves.
		const placement = this.placements.get(req.placementRef);
		if (!placement) {
			throw new DelegateErrorImpl(
				"E_START",
				`fake host: unknown placement ${req.placementRef}`,
				"Place first, then start.",
			);
		}
		if (this.agents.has(req.name)) {
			// D4 seam contract: collision → E_NAME. Migration stage 1 (errors-defect
			// 2): the guidance BASE TEXT comes from the seam dictionary via
			// delegateErrorWithDetail — the fake appends only its own fact (which
			// agent holds the name); it does not phrase hints itself.
			throw delegateErrorWithDetail(
				"E_NAME",
				`fake host: agent name ${req.name} already taken`,
				`existing agent: ${req.name}`,
			);
		}
		this.agents.set(req.name, { name: req.name, placement });
		if (this.opts.manifestDir) {
			// Mirrors the spawn.ts write path (entry appended right after start):
			// new fields backend+placementRef ride ALONGSIDE the legacy-shaped
			// workspaceId/paneId/checkoutPath — never instead of them (design §4.4).
			const entry: ManifestWorker = {
				name: req.name,
				placement,
				briefPath: this.opts.briefPath ?? "",
				reportPath: this.opts.reportPath ?? "",
				provider: req.provider,
				model: req.model,
				thinking: req.thinking,
				startedAt: new Date().toISOString(),
			};
			await manifestStore.append(this.opts.manifestDir, entry);
		}
		return { name: req.name }; // canonical name read-back (seam contract)
	}

	async submitPrompt(req: PromptReq): Promise<void> {
		this.prompts.push(req.text);
	}

	async waitSettle(req: Parameters<Transport["waitSettle"]>[0]): Promise<SettleResult> {
		// Scripted settle: one status per poll slice, until a settled one. A
		// slice that exhausts the script classifies as never-started unless a
		// started-status was observed (two-phase D3 shape, seam-level).
		// Migration stage 3 (audit step 8): the fake now honors the FULL seam
		// settle contract — the caller-owned completion proof (proofSettled),
		// the early release (releaseOnStarted) and the abort-detaches-never-
		// kills discipline — and returns the seam's DISCRIMINATED settle union.
		// Before this the fake only produced legacy flag-sets, so the
		// "backend never reports working" / "done aged into idle" scenarios
		// (§19.1b/§19.1c) were reproducible only against live herdr.
		const agent = this.agents.get(req.name);
		if (!agent) {
			throw new DelegateErrorImpl("E_TIMEOUT", `fake host: no agent ${req.name}`, "Poll delegate_status.");
		}
		let started = false;
		let last: AgentStatusName = "unknown";
		const t0 = Date.now();
		for (;;) {
			if (req.signal?.aborted) {
				// Abort detaches the wait, never the worker (seam contract).
				return { kind: "detached", status: last };
			}
			const status = this.script.shift() ?? "unknown";
			this.lastObserved = status;
			if (status !== "unknown") last = status;
			if (!started && STARTED.includes(status)) started = true;
			req.onPoll?.({ status, started, elapsedMs: Date.now() - t0 });
			if (started && SETTLED.includes(status)) return { kind: "settled", status };
			// Caller-owned completion proof (§19.1c), consulted only while life is
			// unproven — same discipline as the herdr adapter: a throwing proof
			// counts as "not proven", never blocks the wait.
			if (!started && !STARTED.includes(status) && req.proofSettled) {
				let proven = false;
				try {
					proven = await req.proofSettled();
				} catch {
					proven = false;
				}
				if (proven) return { kind: "finished-before-watch", status: "idle" };
			}
			// v1.14 early release (watch.releaseOn=started), seam-level parity.
			if (req.releaseOnStarted && started && status === "working") {
				return { kind: "started-confirmed", status };
			}
			if (this.script.length === 0) {
				return started
					? { kind: "timeout", status: last }
					: { kind: "never-started", status: "unknown" };
			}
		}
	}

	async getStatus(name: string): Promise<AgentStatus | null> {
		const agent = this.agents.get(name);
		if (!agent) return null; // "not found → null" is a seam contract
		return {
			name,
			status: this.script[0] ?? this.lastObserved,
			placementRef: agent.placement.placementRef,
		};
	}

	async listStatuses(): Promise<AgentStatus[]> {
		const out: AgentStatus[] = [];
		for (const agent of this.agents.values()) {
			const s = await this.getStatus(agent.name);
			if (s) out.push(s);
		}
		return out;
	}

	async teardown(req: TeardownReq): Promise<TeardownResult> {
		this.teardownCalls++;
		// Idempotent by seam semantics: an unknown/already-torn-down placement is
		// a no-op success — and since migration stage 1 it is reported
		// STRUCTURED: alreadyGone=true when nothing matched (the placement was
		// already gone), false when this call deleted a live placement.
		const ref = req.placement.placementRef ?? req.placement.paneId;
		let matched = false;
		for (const [paneId, p] of this.placements) {
			if ((p.placementRef ?? paneId) === ref) {
				this.placements.delete(paneId);
				matched = true;
			}
		}
		for (const [name, a] of this.agents) {
			const aRef = a.placement.placementRef ?? a.placement.paneId;
			if (aRef === ref || name === req.name) {
				this.agents.delete(name);
				matched = true;
			}
		}
		return { alreadyGone: !matched };
	}
}
