/**
 * pi-delegate — `/delegate-fleet` mission-control overlay (DESIGN.md §15).
 *
 * OWNERSHIP: worker F2 (impl-fleet).
 *
 * Full-screen read-only overlay: one row per known worker, refreshed every
 * 2s. Strictly read-only — the only side effects are fs READS (manifests,
 * report/q/a existence checks, session JSONL usage parsing) and the
 * read-only transport.listStatuses() inside buildWorkerView(). No mutating
 * herdr calls, no mailbox writes, no timers left behind (interval is
 * cleared on close AND on dispose).
 */

import { readFile, stat } from "node:fs/promises";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { buildWorkerView, type WorkerView } from "../state.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "../usage.ts";
import { CONTEXT_WARN_PCT, type Transport } from "../transport/types.ts";
import { fmtK, trunc, visibleWidth } from "./text.ts";

/** How often the overlay re-renders (poll buildWorkerView + fs state). */
const REFRESH_MS = 2000;

/** Minimal structural slice of the TUI we need — avoids importing pi-tui. */
interface RenderPoke {
	requestRender(force?: boolean): void;
}

export interface FleetDeps {
	/** Injected transport (same seam the rest of the extension uses). */
	transport: Transport;
}

// ---------------------------------------------------------------------------
// Local key helper (pi-tui's matchesKey is not reachable from this repo's
// node_modules layout); width/trunc/fmtK live in ui/text.ts.
// ---------------------------------------------------------------------------

function isEscape(data: string): boolean {
	return data === "\x1b"; // bare ESC byte (escape sequences start with ESC[)
}

// ---------------------------------------------------------------------------
// Manifest extras: sessionPath + per-call budgetTokens live in the on-disk
// manifest but are not projected onto WorkerView — read them tolerantly.
// ---------------------------------------------------------------------------

interface ManifestExtras {
	sessionPath?: string;
	budgetTokens?: number;
	briefPath?: string;
	model?: string;
}

async function readManifestExtras(dir: string, name: string): Promise<ManifestExtras> {
	try {
		const raw: unknown = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
		const workers = (raw as { workers?: unknown })?.workers;
		if (!Array.isArray(workers)) return {};
		const w = workers.find(
			(x): x is { name?: unknown; sessionPath?: unknown; budgetTokens?: unknown; briefPath?: unknown; model?: unknown } =>
				typeof x === "object" && x !== null && (x as { name?: unknown }).name === name,
		);
		if (!w) return {};
		const extras: ManifestExtras = {};
		if (typeof w.sessionPath === "string" && w.sessionPath.length > 0) {
			extras.sessionPath = w.sessionPath;
		}
		if (typeof w.budgetTokens === "number" && Number.isFinite(w.budgetTokens) && w.budgetTokens > 0) {
			extras.budgetTokens = w.budgetTokens;
		}
		if (typeof w.briefPath === "string") {
			extras.briefPath = w.briefPath;
		}
		if (typeof w.model === "string" && w.model.length > 0) {
			extras.model = w.model;
		}
		return extras;
	} catch {
		return {}; // missing/corrupt manifest → zero-usage row, never throw
	}
}

/** File mtime in ms, or 0 when missing/unreadable. Read-only. */
async function mtimeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

/** Mailbox state: "Q?" worker question awaiting answer, "A→" answer posted. */
async function mailState(dir: string, name: string): Promise<"Q?" | "A→" | "--"> {
	const q = await mtimeOf(`${dir}/q-${name}.json`);
	if (q === 0) return "--";
	const a = await mtimeOf(`${dir}/a-${name}.json`);
	return a > q ? "A→" : "Q?";
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<WorkerView["status"], number> = {
	blocked: 0,
	working: 1,
	idle: 2,
	done: 3,
	unknown: 4,
};

function sortViews(views: WorkerView[]): WorkerView[] {
	return [...views].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
	);
}

interface FleetRow {
	view: WorkerView;
	budget: number;
	input: number;
	output: number;
	percent: number;
	mail: "Q?" | "A→" | "--";
	/** Probe worker (spawned with mode:"probe", manifest briefPath ""). */
	isProbe: boolean;
}

function buildRow(view: WorkerView, extras: ManifestExtras, mail: "Q?" | "A→" | "--"): FleetRow {
	const usage = parseSessionUsage(extras.sessionPath ?? "");
	const window = resolveContextWindow(extras.model);
	const percent = contextPct(usage, window) ?? 0;
	// Probe workers never produce a report (§19.4 probe honesty): manifest
	// briefPath is "" exactly for probes.
	const isProbe = extras.briefPath === "";
	return { view, budget: window, input: usage.input, output: usage.output, percent, mail, isProbe };
}

function statusColor(status: WorkerView["status"]): ThemeColor {
	switch (status) {
		case "blocked":
			return "error";
		case "working":
			return "accent";
		case "done":
			return "success";
		default:
			return "dim";
	}
}

// ---------------------------------------------------------------------------
// Pure layout fitting (extracted for unit testing — quality fix A7): no theme,
// no I/O. FleetOverlay.render is a thin themed skin over these results.
// ---------------------------------------------------------------------------

/** Theme-free input row: exactly what the fitting needs. */
export interface FleetLayoutRow {
	name: string;
	branch: string;
	input: number;
	output: number;
	percent: number;
	budget: number;
}

/** Fitted layout: final column widths + per-row cells, every cell already
 *  truncated and padded to its column width (ellipsis included). */
export interface FleetLayout {
	nameW: number;
	branchW: number;
	usageW: number;
	cells: Array<{ name: string; branch: string; usage: string }>;
}

/** Column floors — shrink loops never go below these. */
export const FLEET_FLOORS = { name: 8, branch: 6, usage: 12 } as const;

/** Usage column string: `↑52.8k ↓34.9k (999% of 150k)` (compact fmtK form). */
export function fleetUsageOf(r: Pick<FleetLayoutRow, "input" | "output" | "percent" | "budget">): string {
	return `↑${fmtK(r.input)} ↓${fmtK(r.output)} (${r.percent}% of ${fmtK(r.budget)})`;
}

function pad(s: string, len: number): string {
	return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
}

/**
 * Fit the fleet table (name status branch report mail usage) to `innerW`.
 * Shrink priority: branch → name → usage; floors {branch:6, name:8, usage:12}
 * keep columns readable. Cells are trunc'd then padded — a cell can never
 * push past its (fitted) column, so a row can never push past the border.
 */
export function layoutFleetRows(rows: FleetLayoutRow[], innerW: number): FleetLayout {
	const nameNat = Math.max(4, ...rows.map((r) => visibleWidth(r.name)));
	const branchNat = Math.max(6, ...rows.map((r) => visibleWidth(r.branch)));
	const usageNat = Math.max(12, ...rows.map((r) => visibleWidth(fleetUsageOf(r))));

	let nameW = Math.min(nameNat, 18);
	let branchW = Math.min(branchNat, 18);
	let usageW = Math.min(usageNat, 34);
	// total = 1(lead)+nameW+1+status(7)+1+branchW+1+report(1)+1+mail(2)+2+usageW
	const total = () => 1 + nameW + 1 + 7 + 1 + branchW + 1 + 1 + 1 + 2 + usageW;
	// Shrink priority: branch → name → usage (floors keep columns readable).
	while (total() > innerW && branchW > FLEET_FLOORS.branch) {
		branchW = Math.max(FLEET_FLOORS.branch, branchW - (total() - innerW));
	}
	while (total() > innerW && nameW > FLEET_FLOORS.name) {
		nameW = Math.max(FLEET_FLOORS.name, nameW - (total() - innerW));
	}
	while (total() > innerW && usageW > FLEET_FLOORS.usage) {
		usageW = Math.max(FLEET_FLOORS.usage, usageW - (total() - innerW));
	}

	return {
		nameW,
		branchW,
		usageW,
		cells: rows.map((r) => ({
			name: trunc(pad(r.name, nameW), nameW),
			branch: trunc(pad(r.branch, branchW), branchW),
			usage: trunc(fleetUsageOf(r), usageW),
		})),
	};
}

/** Offset safety (§19 alignment fix), pure and unit-testable: clip row
 *  content to `innerW - 1` BEFORE padding to `innerW`, so nothing (header,
 *  legend, themed rows) can ever push past the right border. */
export function fitRow(content: string, innerW: number): string {
	return pad(trunc(content, innerW - 1), innerW);
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class FleetOverlay {
	private tui: RenderPoke | undefined;
	private transport: Transport;
	private theme: Theme;
	private done: () => void;
	private rows: FleetRow[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private refreshing = false;

	constructor(tui: RenderPoke, transport: Transport, theme: Theme, done: () => void) {
		this.tui = tui;
		this.transport = transport;
		this.theme = theme;
		this.done = done;
		void this.refresh();
		this.timer = setInterval(() => {
			void this.refresh().then(() => {
				if (!this.closed) this.tui?.requestRender();
			});
		}, REFRESH_MS);
	}

	/** Read-only data refresh; never throws, never overlaps. */
	private async refresh(): Promise<void> {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		try {
			const views = sortViews(await buildWorkerView(this.transport));
			const rows: FleetRow[] = [];
			for (const view of views) {
				const [extras, mail] = await Promise.all([
					readManifestExtras(view.dir, view.name),
					mailState(view.dir, view.name),
				]);
				rows.push(buildRow(view, extras, mail));
			}
			this.rows = rows;
		} catch {
			// keep last snapshot on any unexpected read failure
		} finally {
			this.refreshing = false;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.done();
	}

	handleInput(data: string): void {
		if (isEscape(data) || data === "q") {
			this.close();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(40, Math.min(width, 100));
		const innerW = w - 2;
		const lines: string[] = [];

		// Offset safety (§19 alignment fix) now lives in fitRow() — pure,
		// unit-tested in test/fleet-render-check.ts.
		const row = (content: string) =>
			th.fg("border", "│") + fitRow(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(
			row(` ${th.fg("accent", `pi-delegate fleet — ${this.rows.length} worker(s) — q to close`)}`),
		);
		lines.push(row(""));

		if (this.rows.length === 0) {
			lines.push(row(` ${th.fg("dim", "no delegate workers known (no manifests under /tmp/exchange)")}`));
		}

		// Column layout: name status branch report mail usage — fitted to innerW
		// by the pure layoutFleetRows() (shrink priority + floors live there).
		const layout = layoutFleetRows(
			this.rows.map((r) => ({
				name: r.view.name,
				branch: r.view.branch ?? "-",
				input: r.input,
				output: r.output,
				percent: r.percent,
				budget: r.budget,
			})),
			innerW,
		);

		for (let i = 0; i < this.rows.length; i++) {
			const r = this.rows[i];
			const cell = layout.cells[i];
			const name = th.fg("text", cell.name);
			const status = th.fg(statusColor(r.view.status), pad7(r.view.status));
			const branch = th.fg("dim", cell.branch);
			const report = r.isProbe
				? th.fg("dim", "—") // probe: no report expected — never ✓/✗ (§19.4)
				: r.view.reportExists
					? th.fg("success", "✓")
					: th.fg("error", "✗");
			const mail =
				r.mail === "Q?"
					? th.fg("warning", "Q?")
					: r.mail === "A→"
						? th.fg("success", "A→")
						: th.fg("dim", "--");
			const warn = r.percent >= CONTEXT_WARN_PCT;
			const usage = th.fg(warn ? "warning" : "dim", cell.usage);
			lines.push(row(` ${name} ${status} ${branch} ${report} ${mail}  ${usage}`));
		}

		lines.push(row(""));
		lines.push(
			row(
				` ${th.fg("dim", "blocked→working→idle→done→unknown · ✓/✗ report on disk · Q?/A→ mailbox · 2s refresh")}`,
			),
		);
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

/** Pad the fixed 7-column status cell (theme-free helper). */
function pad7(s: string): string {
	return s + " ".repeat(Math.max(0, 7 - visibleWidth(s)));
}

/**
 * Open the fleet overlay and block until the user closes it (q/escape).
 * Read-only; resolves with void.
 */
export async function openFleetOverlay(ctx: ExtensionCommandContext, deps: FleetDeps): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/delegate-fleet is only available in interactive (TUI) mode.", "warning");
		return;
	}
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new FleetOverlay(tui, deps.transport, theme, () => done(undefined)),
		{ overlay: true },
	);
}
